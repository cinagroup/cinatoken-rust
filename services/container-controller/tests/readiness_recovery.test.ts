import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  READINESS_PROBE_JOURNAL_RETENTION_MS,
  RelayShardLedger,
  type ReadinessProbeJournalCompletion,
  type ReadinessProbeWakePermit,
} from "../src/ledger";
import type { OperationShard } from "../src/protocol";

const shard: OperationShard = {
  contract_version: 1,
  ring_generation: 7,
  shard_count: 8,
  shard_index: 3,
  instance_name: "cinatoken-relay-shard-v1-0003",
};

const STARTED_AT_MS = 1_900_000_000_000;
const CLAIM_DIGEST = "b".repeat(64);

describe("Durable Object readiness at-most-once journal v6", () => {
  test("grants exactly one wake permit across concurrent duplicate begins", async () => {
    const fixture = initializedLedger();
    try {
      const probeId = "a".repeat(64);
      const deadlineAtMs = STARTED_AT_MS + 10_000;
      const attempts = await Promise.allSettled([
        fixture.ledger.beginOrReplayReadinessProbe(
          shard,
          probeId,
          CLAIM_DIGEST,
          STARTED_AT_MS,
          deadlineAtMs,
          true,
        ),
        fixture.ledger.beginOrReplayReadinessProbe(
          shard,
          probeId,
          CLAIM_DIGEST,
          STARTED_AT_MS,
          deadlineAtMs,
          true,
        ),
      ]);

      const fulfilled = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<RelayShardLedger["beginOrReplayReadinessProbe"]>>> =>
          attempt.status === "fulfilled",
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.value).toMatchObject({
        kind: "wake",
        probeId,
        claimDigestSha256: CLAIM_DIGEST,
        generation: 1,
        startedAtMs: STARTED_AT_MS,
        deadlineAtMs,
        retentionUntilMs: deadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS,
      });
      expect(rejected).toHaveLength(1);
      expect(protocolCode(rejected[0]?.reason)).toBe("readiness_probe_in_progress");
      expect(
        fixture.sqlite
          .query(
            `SELECT state, COUNT(*) AS count
               FROM cinatoken_shard_readiness_probe_journal
              GROUP BY state`,
          )
          .get(),
      ).toEqual({ state: "started", count: 1 });
      expect(
        fixture.sqlite
          .query(
            `SELECT migration_name FROM cinatoken_shard_schema_migrations
              WHERE schema_version = 6`,
          )
          .get(),
      ).toEqual({
        migration_name: "0006_readiness_probe_at_most_once_journal_v1",
      });
    } finally {
      fixture.sqlite.close();
    }
  });

  test("returns the exact canonical JSON and digest on completed replay-only", async () => {
    const fixture = initializedLedger();
    try {
      const probeId = "c".repeat(64);
      const permit = await beginProbe(fixture.ledger, probeId, CLAIM_DIGEST);
      const completedAtMs = STARTED_AT_MS + 250;
      const completion = await readinessCompletion(completedAtMs);
      const completed = await fixture.ledger.completeReadinessProbeJournal(
        shard,
        permit,
        completedAtMs,
        completion,
      );
      expect(completed).toMatchObject({
        kind: "completed",
        probeId,
        claimDigestSha256: CLAIM_DIGEST,
        generation: 1,
        resultJson: completion.resultJson,
        resultSha256: completion.resultSha256,
      });

      const replay = await fixture.ledger.replayReadinessProbeJournal(
        shard,
        probeId,
        CLAIM_DIGEST,
        STARTED_AT_MS + 500,
      );
      expect(replay).toEqual(completed);
      expect(
        await fixture.ledger.completeReadinessProbeJournal(
          shard,
          permit,
          completedAtMs,
          completion,
        ),
      ).toEqual(completed);
    } finally {
      fixture.sqlite.close();
    }
  });

  test("rejects a different claim fingerprint before replay or completion", async () => {
    const fixture = initializedLedger();
    try {
      const probeId = "d".repeat(64);
      const permit = await beginProbe(fixture.ledger, probeId, CLAIM_DIGEST);
      expect(
        await rejectedCode(
          fixture.ledger.replayReadinessProbeJournal(
            shard,
            probeId,
            "e".repeat(64),
            STARTED_AT_MS + 1,
          ),
        ),
      ).toBe("readiness_probe_claim_mismatch");

      const forgedPermit = {
        ...permit,
        claimDigestSha256: "e".repeat(64),
      };
      expect(
        await rejectedCode(
          fixture.ledger.completeReadinessProbeJournal(
            shard,
            forgedPermit,
            STARTED_AT_MS + 2,
            await readinessCompletion(STARTED_AT_MS + 2),
          ),
        ),
      ).toBe("readiness_probe_claim_mismatch");
      expect(
        fixture.sqlite
          .query(
            `SELECT state, claim_digest_sha256
               FROM cinatoken_shard_readiness_probe_journal
              WHERE probe_id = ?`,
          )
          .get(probeId),
      ).toEqual({ state: "started", claim_digest_sha256: CLAIM_DIGEST });
    } finally {
      fixture.sqlite.close();
    }
  });

  test("turns an expired started probe ambiguous and blocks early deletion", async () => {
    const fixture = initializedLedger();
    try {
      const probeId = "f".repeat(64);
      const deadlineAtMs = STARTED_AT_MS + 10_000;
      await beginProbe(fixture.ledger, probeId, CLAIM_DIGEST, deadlineAtMs);

      expect(
        await rejectedCode(
          fixture.ledger.replayReadinessProbeJournal(
            shard,
            probeId,
            CLAIM_DIGEST,
            deadlineAtMs,
          ),
        ),
      ).toBe("readiness_probe_ambiguous");
      expect(
        fixture.sqlite
          .query(
            `SELECT state, ambiguous_at_ms
               FROM cinatoken_shard_readiness_probe_journal
              WHERE probe_id = ?`,
          )
          .get(probeId),
      ).toEqual({ state: "ambiguous", ambiguous_at_ms: deadlineAtMs });
      expect(
        fixture.sqlite
          .query(
            `SELECT phase, result_code, completed_at_ms
               FROM cinatoken_shard_readiness`,
          )
          .get(),
      ).toEqual({
        phase: "complete",
        result_code: "container_readiness_ambiguous",
        completed_at_ms: deadlineAtMs,
      });
      expect(
        await rejectedCode(
          fixture.ledger.beginOrReplayReadinessProbe(
            shard,
            probeId,
            CLAIM_DIGEST,
            deadlineAtMs + 1,
            deadlineAtMs + 5_001,
            true,
          ),
        ),
      ).toBe("readiness_probe_ambiguous");
      expect(() =>
        fixture.sqlite
          .query(
            "DELETE FROM cinatoken_shard_readiness_probe_journal WHERE probe_id = ?",
          )
          .run(probeId),
      ).toThrow("readiness probe journal retention is active");
    } finally {
      fixture.sqlite.close();
    }
  });

  test("cleans only one bounded expired batch and keeps old D1 replay fail closed", async () => {
    const fixture = initializedLedger();
    try {
      const wallNowMs = Date.now();
      const expiredStartedAtMs = wallNowMs - 3 * 60 * 60 * 1_000;
      const expiredDeadlineAtMs = expiredStartedAtMs + 1_000;
      const expiredRetentionUntilMs =
        expiredDeadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS;
      const resultJson = "{}";
      const resultSha256 = await sha256Hex(resultJson);
      const insert = fixture.sqlite.query(
        `INSERT INTO cinatoken_shard_readiness_probe_journal
           (probe_id, claim_digest_sha256, generation, state, started_at_ms,
            deadline_at_ms, retention_until_ms, completed_at_ms, ambiguous_at_ms,
            result_json, result_sha256, result_size_bytes)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, NULL, ?, ?, 2)`,
      );
      for (let index = 0; index < 65; index += 1) {
        insert.run(
          index.toString(16).padStart(64, "0"),
          CLAIM_DIGEST,
          index + 1,
          expiredStartedAtMs,
          expiredDeadlineAtMs,
          expiredRetentionUntilMs,
          expiredStartedAtMs + 500,
          resultJson,
          resultSha256,
        );
      }

      const freshProbeId = "9".repeat(64);
      const fresh = await fixture.ledger.beginOrReplayReadinessProbe(
        shard,
        freshProbeId,
        "8".repeat(64),
        wallNowMs,
        wallNowMs + 10_000,
        true,
      );
      expect(fresh).toMatchObject({ kind: "wake", generation: 66 });
      expect(
        fixture.sqlite
          .query(
            `SELECT state, COUNT(*) AS count
               FROM cinatoken_shard_readiness_probe_journal
              GROUP BY state
              ORDER BY state ASC`,
          )
          .all(),
      ).toEqual([
        { state: "completed", count: 1 },
        { state: "started", count: 1 },
      ]);

      const deletedCompletedProbeId = "0".repeat(64);
      expect(
        await protocolFailure(
          fixture.ledger.replayReadinessProbeJournal(
            shard,
            deletedCompletedProbeId,
            CLAIM_DIGEST,
            wallNowMs + 1,
          ),
        ),
      ).toEqual({ code: "readiness_probe_missing", status: 503 });
      expect(
        fixture.sqlite
          .query(
            `SELECT COUNT(*) AS count
               FROM cinatoken_shard_readiness_probe_journal
              WHERE probe_id = ?`,
          )
          .get(deletedCompletedProbeId),
      ).toEqual({ count: 0 });
    } finally {
      fixture.sqlite.close();
    }
  });

  test("fails closed for replay-only missing probes and corrupt stored JSON", async () => {
    const fixture = initializedLedger();
    try {
      expect(
        await protocolFailure(
          fixture.ledger.replayReadinessProbeJournal(
            shard,
            "1".repeat(64),
            CLAIM_DIGEST,
            STARTED_AT_MS,
          ),
        ),
      ).toEqual({ code: "readiness_probe_missing", status: 503 });
      expect(
        fixture.sqlite
          .query("SELECT COUNT(*) AS count FROM cinatoken_shard_readiness_probe_journal")
          .get(),
      ).toEqual({ count: 0 });

      const corruptProbeId = "2".repeat(64);
      const deadlineAtMs = STARTED_AT_MS + 10_000;
      fixture.sqlite
        .query(
          `INSERT INTO cinatoken_shard_readiness_probe_journal
             (probe_id, claim_digest_sha256, generation, state, started_at_ms,
              deadline_at_ms, retention_until_ms, completed_at_ms, ambiguous_at_ms,
              result_json, result_sha256, result_size_bytes)
           VALUES (?, ?, 99, 'completed', ?, ?, ?, ?, NULL, 'xx', ?, 2)`,
        )
        .run(
          corruptProbeId,
          CLAIM_DIGEST,
          STARTED_AT_MS,
          deadlineAtMs,
          deadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS,
          STARTED_AT_MS + 1,
          "3".repeat(64),
        );
      expect(
        await rejectedCode(
          fixture.ledger.replayReadinessProbeJournal(
            shard,
            corruptProbeId,
            CLAIM_DIGEST,
            STARTED_AT_MS + 2,
          ),
        ),
      ).toBe("readiness_probe_result_corrupt");
    } finally {
      fixture.sqlite.close();
    }
  });

  test("keeps an older completed probe immutable after a later probe completes", async () => {
    const fixture = initializedLedger();
    try {
      const firstProbeId = "4".repeat(64);
      const firstPermit = await beginProbe(
        fixture.ledger,
        firstProbeId,
        CLAIM_DIGEST,
      );
      const firstCompletedAtMs = STARTED_AT_MS + 100;
      const firstCompletion = await readinessCompletion(
        firstCompletedAtMs,
        "process_ready_execution_disabled",
      );
      const firstCompleted = await fixture.ledger.completeReadinessProbeJournal(
        shard,
        firstPermit,
        firstCompletedAtMs,
        firstCompletion,
      );

      const secondProbeId = "5".repeat(64);
      const secondStartedAtMs = STARTED_AT_MS + 1_000;
      const secondPermit = await beginProbe(
        fixture.ledger,
        secondProbeId,
        "6".repeat(64),
        secondStartedAtMs + 10_000,
        secondStartedAtMs,
      );
      const secondCompletedAtMs = secondStartedAtMs + 100;
      const secondCompletion = await readinessCompletion(
        secondCompletedAtMs,
        "execution_ready",
        true,
      );
      await fixture.ledger.completeReadinessProbeJournal(
        shard,
        secondPermit,
        secondCompletedAtMs,
        secondCompletion,
      );

      expect(
        await fixture.ledger.replayReadinessProbeJournal(
          shard,
          firstProbeId,
          CLAIM_DIGEST,
          secondCompletedAtMs + 1,
        ),
      ).toEqual(firstCompleted);
      expect(
        fixture.sqlite
          .query(
            `SELECT probe_id, generation, result_sha256
               FROM cinatoken_shard_readiness_probe_journal
              ORDER BY generation ASC`,
          )
          .all(),
      ).toEqual([
        {
          probe_id: firstProbeId,
          generation: 1,
          result_sha256: firstCompletion.resultSha256,
        },
        {
          probe_id: secondProbeId,
          generation: 2,
          result_sha256: secondCompletion.resultSha256,
        },
      ]);
    } finally {
      fixture.sqlite.close();
    }
  });
});

async function beginProbe(
  ledger: RelayShardLedger,
  probeId: string,
  claimDigestSha256: string,
  deadlineAtMs = STARTED_AT_MS + 10_000,
  startedAtMs = STARTED_AT_MS,
): Promise<ReadinessProbeWakePermit> {
  const outcome = await ledger.beginOrReplayReadinessProbe(
    shard,
    probeId,
    claimDigestSha256,
    startedAtMs,
    deadlineAtMs,
    true,
  );
  if (outcome.kind !== "wake") throw new Error("expected wake permit");
  return outcome;
}

async function readinessCompletion(
  completedAtMs: number,
  resultCode = "process_ready_execution_disabled",
  executionReady = false,
): Promise<ReadinessProbeJournalCompletion> {
  const resultJson = JSON.stringify({
    checked_at: Math.floor(completedAtMs / 1_000),
    mode: "live",
    ready: executionReady,
    verdict: executionReady ? "ready" : "not_ready",
    result_code: resultCode,
  });
  return {
    resultJson,
    resultSha256: await sha256Hex(resultJson),
    resultCode,
    containerStatus: "healthy",
    containerLastChangeMs: completedAtMs - 50,
    containerExitCode: null,
    runtimeProtocolVersion: 1,
    runtimeContractVersion: 1,
    runtimeBuildId: "7".repeat(64),
    runtimeExecutionEnabled: executionReady,
    processReady: true,
    executionReady,
  };
}

function initializedLedger() {
  const fixture = ledgerFixture();
  fixture.ledger.initializeShardForReadiness(
    shard,
    Math.floor(STARTED_AT_MS / 1_000),
  );
  return fixture;
}

function ledgerFixture() {
  const sqlite = new Database(":memory:");
  const storage = {
    sql: {
      exec<T>(sql: string, ...bindings: unknown[]) {
        if (bindings.length === 0 && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ""))) {
          sqlite.exec(sql);
          return cursor<T>([]);
        }
        const statement = sqlite.query(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
          return cursor<T>(statement.all(...bindings) as T[]);
        }
        statement.run(...bindings);
        return cursor<T>([]);
      },
    },
    transactionSync<T>(callback: () => T): T {
      return sqlite.transaction(callback)();
    },
  };
  const ledger = new RelayShardLedger(storage as never);
  ledger.ensureSchema();
  return { sqlite, ledger };
}

async function rejectedCode(promise: Promise<unknown>): Promise<string | null> {
  return (await protocolFailure(promise))?.code ?? null;
}

async function protocolFailure(
  promise: Promise<unknown>,
): Promise<{ code: string; status: number } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "status" in error &&
      typeof error.status === "number"
      ? { code: error.code, status: error.status }
      : null;
  }
}

function protocolCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function cursor<T>(rows: T[]) {
  return {
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    toArray: () => rows,
  };
}
