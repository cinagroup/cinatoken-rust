import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  type OperationEnvelope,
  type OperationStatusQuery,
} from "../services/container-controller/src/protocol";
import {
  RelayShardLedger,
  type OperationStatus,
  type RelayShardLedgerPolicy,
} from "../services/container-controller/src/ledger";
import type { ContainerControllerLedgerTestObject } from "./fixtures/container-controller-ledger-worker";

declare global {
  namespace Cloudflare {
    interface Env {
      CONTAINER_CONTROLLER_LEDGER: DurableObjectNamespace<ContainerControllerLedgerTestObject>;
    }
  }
}

interface OperationSqlRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  status: OperationStatus;
  response_status: number | null;
  response_code: string | null;
  updated_at: number;
}

interface LifecycleSqlRow {
  [key: string]: SqlStorageValue;
  lifecycle_state: string;
  lifecycle_detail: string | null;
  updated_at: number;
}

const BASE_NOW = 1_800_000_000;

function sha256(character: string): string {
  return character.repeat(64);
}

function operationEnvelope(
  operationId: string,
  overrides: Partial<OperationEnvelope> = {},
): OperationEnvelope {
  return {
    protocol_version: 1,
    operation_id: operationId,
    operation_kind: "relay",
    owner_generation: 1,
    owner_lease_expires_at: BASE_NOW + 600,
    execution_deadline_at: BASE_NOW + 300,
    provider_operation_id: `provider-${operationId}`,
    admission_sha256: sha256("a"),
    input: {
      mode: "inline",
      sha256: sha256("b"),
      size: 2,
      content_type: "application/json",
    },
    shard: {
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: `trace-${operationId}`,
    ...overrides,
  };
}

function operationStatusQuery(
  operation: OperationEnvelope,
  overrides: Partial<OperationStatusQuery> = {},
): OperationStatusQuery {
  return {
    protocol_version: operation.protocol_version,
    operation_id: operation.operation_id,
    owner_generation: operation.owner_generation,
    shard: operation.shard,
    trace_id: operation.trace_id,
    ...overrides,
  };
}

function ledgerPolicy(
  overrides: Partial<RelayShardLedgerPolicy> = {},
): RelayShardLedgerPolicy {
  return {
    maxInFlight: 4,
    dispatchRetentionSeconds: 60,
    terminalRetentionSeconds: 300,
    maxTerminalOperations: 100,
    ...overrides,
  };
}

function ledgerStub(name: string): DurableObjectStub<ContainerControllerLedgerTestObject> {
  return env.CONTAINER_CONTROLLER_LEDGER.getByName(name);
}

function readinessCompletion(resultCode: string, processReady = false) {
  return {
    resultCode,
    containerStatus: processReady ? "healthy" : "stopped",
    containerLastChangeMs: BASE_NOW * 1_000,
    containerExitCode: null,
    runtimeProtocolVersion: processReady ? 1 : null,
    runtimeContractVersion: processReady ? 1 : null,
    runtimeExecutionEnabled: processReady ? false : null,
    processReady,
  };
}

describe("RelayShardLedger in Workerd", () => {
  it("serializes max + 1 concurrent claims without exceeding capacity", async () => {
    const stub = ledgerStub("concurrent-capacity");
    const maxInFlight = 3;
    const policy = ledgerPolicy({ maxInFlight });

    const results = await Promise.all(
      Array.from({ length: maxInFlight + 1 }, (_, index) =>
        stub.claim(
          operationEnvelope(`capacity-${index}`),
          sha256(index.toString(16)),
          `dispatch-capacity-${index}`,
          policy,
          BASE_NOW,
        ),
      ),
    );

    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "capacity",
      "new",
      "new",
      "new",
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations ORDER BY operation_id`,
        )
        .toArray();
      expect(rows).toHaveLength(maxInFlight);
      expect(rows.every(({ status }) => status === "claimed")).toBe(true);
    });

    await stub.transition("capacity-0", 1, "claimed", "completed", 200, BASE_NOW + 1);
    await expect(
      stub.claim(
        operationEnvelope("capacity-retry"),
        sha256("9"),
        "dispatch-capacity-retry",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({ kind: "new" });
  });

  it("returns an existing claim for the same operation and rejects owner or envelope conflicts", async () => {
    const stub = ledgerStub("operation-idempotency");
    const envelope = operationEnvelope("operation-idempotent");
    const envelopeSha256 = sha256("c");
    const policy = ledgerPolicy();

    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW + 1),
    ).resolves.toMatchObject({
      kind: "existing",
      row: {
        operation_id: envelope.operation_id,
        owner_generation: 1,
        envelope_sha256: envelopeSha256,
        status: "claimed",
        response_status: null,
      },
    });
    await expect(
      stub.claim(envelope, envelopeSha256, "dispatch-retry", policy, BASE_NOW + 2),
    ).resolves.toMatchObject({ kind: "existing" });

    await expect(
      stub.claimOutcome(
        operationEnvelope(envelope.operation_id, { owner_generation: 2 }),
        envelopeSha256,
        "dispatch-owner-conflict",
        policy,
        BASE_NOW + 3,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_owner_conflict", status: 409 },
    });
    await expect(
      stub.claimOutcome(
        envelope,
        sha256("d"),
        "dispatch-envelope-conflict",
        policy,
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_owner_conflict", status: 409 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const operationCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cinatoken_shard_operations")
        .one().count;
      const dispatchCount = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cinatoken_shard_dispatches")
        .one().count;
      expect({ operationCount, dispatchCount }).toEqual({ operationCount: 1, dispatchCount: 2 });
    });
  });

  it("reads claimed, running, and post-deadline terminal outcomes without ledger writes", async () => {
    const stub = ledgerStub("operation-status-read-only");
    const operation = operationEnvelope("operation-status", {
      operation_kind: "health_probe",
      execution_deadline_at: BASE_NOW + 10,
    });
    const query = operationStatusQuery(operation);
    await stub.claim(operation, sha256("f"), "dispatch-operation-status", ledgerPolicy(), BASE_NOW);

    const claimed = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      return ledger.readOperationStatus(query);
    });
    expect(claimed.status).toBe("claimed");

    await stub.transition(
      operation.operation_id,
      operation.owner_generation,
      "claimed",
      "running",
      null,
      BASE_NOW + 1,
      true,
    );
    const running = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      return ledger.readOperationStatus(query);
    });
    expect(running.status).toBe("running");

    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        operation.owner_generation,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 5,
        true,
      ),
    ).resolves.toMatchObject({ ok: true, result: { status: "completed" } });
    const observedAt = BASE_NOW + 11;
    expect(observedAt).toBeGreaterThan(operation.execution_deadline_at);

    const terminalRead = await runInDurableObject(stub, (_instance, state) => {
      const totalChanges = () =>
        state.storage.sql
          .exec<{ count: number }>("SELECT total_changes() AS count")
          .toArray()[0]?.count ?? -1;
      const before = totalChanges();
      const ledger = new RelayShardLedger(state.storage);
      const first = ledger.readOperationStatus(query);
      const replay = ledger.readOperationStatus(query);
      const after = totalChanges();
      return { before, after, first, replay };
    });
    expect(terminalRead.first).toEqual(terminalRead.replay);
    expect(terminalRead.first).toMatchObject({
      operation_id: operation.operation_id,
      owner_generation: operation.owner_generation,
      status: "completed",
      response_status: 200,
      trace_id: operation.trace_id,
    });
    expect(terminalRead.after).toBe(terminalRead.before);
  });

  it("fails closed when an operation status owner, shard fence, or trace does not match", async () => {
    const stub = ledgerStub("operation-status-authority");
    const operation = operationEnvelope("operation-status-authority");
    const query = operationStatusQuery(operation);
    await stub.claim(operation, sha256("e"), "dispatch-status-authority", ledgerPolicy(), BASE_NOW);

    const denied = await runInDurableObject(stub, (_instance, state) => {
      const ledger = new RelayShardLedger(state.storage);
      const attempt = (candidate: OperationStatusQuery) => {
        try {
          ledger.readOperationStatus(candidate);
          return { code: "unexpected_success", status: 200 };
        } catch (error) {
          return error instanceof ProtocolError
            ? { code: error.code, status: error.status }
            : { code: "unexpected_error", status: 500 };
        }
      };
      return [
        attempt({ ...query, owner_generation: query.owner_generation + 1 }),
        attempt({
          ...query,
          shard: {
            ...query.shard,
            shard_index: 4,
            instance_name: "cinatoken-relay-shard-v1-0004",
          },
        }),
        attempt({ ...query, trace_id: "trace-other-operation" }),
      ];
    });
    expect(denied).toEqual([
      { code: "operation_status_not_found", status: 404 },
      { code: "operation_status_not_found", status: 404 },
      { code: "operation_status_not_found", status: 404 },
    ]);
  });

  it("rejects a dispatch replay that targets a different operation", async () => {
    const stub = ledgerStub("dispatch-replay-conflict");
    const policy = ledgerPolicy();

    await expect(
      stub.claim(
        operationEnvelope("dispatch-first"),
        sha256("e"),
        "dispatch-shared",
        policy,
        BASE_NOW,
      ),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claimOutcome(
        operationEnvelope("dispatch-second"),
        sha256("f"),
        "dispatch-shared",
        policy,
        BASE_NOW + 1,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "dispatch_replay_conflict", status: 409 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const operations = state.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM cinatoken_shard_operations ORDER BY operation_id",
        )
        .toArray();
      const dispatches = state.storage.sql
        .exec<{ dispatch_id: string; operation_id: string }>(
          "SELECT dispatch_id, operation_id FROM cinatoken_shard_dispatches",
        )
        .toArray();
      expect(operations).toEqual([{ operation_id: "dispatch-first" }]);
      expect(dispatches).toEqual([
        { dispatch_id: "dispatch-shared", operation_id: "dispatch-first" },
      ]);
    });
  });

  it("expires in-flight work as 504 and releases its capacity", async () => {
    const stub = ledgerStub("expired-in-flight");
    const policy = ledgerPolicy({ maxInFlight: 1 });

    await expect(
      stub.claim(
        operationEnvelope("expired-operation", {
          execution_deadline_at: BASE_NOW + 10,
        }),
        sha256("1"),
        "dispatch-expired",
        policy,
        BASE_NOW,
      ),
    ).resolves.toEqual({ kind: "new" });
    await expect(
      stub.claim(
        operationEnvelope("replacement-operation"),
        sha256("2"),
        "dispatch-replacement",
        policy,
        BASE_NOW + 11,
      ),
    ).resolves.toEqual({ kind: "new" });

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations ORDER BY operation_id`,
        )
        .toArray();
      expect(rows).toEqual([
        {
          operation_id: "expired-operation",
          status: "failed",
          response_status: 504,
          response_code: "container_execution_deadline_expired",
          updated_at: BASE_NOW + 11,
        },
        {
          operation_id: "replacement-operation",
          status: "claimed",
          response_status: null,
          response_code: null,
          updated_at: BASE_NOW + 11,
        },
      ]);
    });
  });

  it("compacts terminal operations by age and maximum row count", async () => {
    const stub = ledgerStub("terminal-compaction");
    const seedPolicy = ledgerPolicy({
      maxInFlight: 8,
      dispatchRetentionSeconds: 1_000,
      terminalRetentionSeconds: 1_000,
      maxTerminalOperations: 100,
    });
    const terminalOperations = [
      { id: "expired-by-time", hash: "3", updatedAt: BASE_NOW + 69 },
      { id: "removed-by-cap", hash: "4", updatedAt: BASE_NOW + 70 },
      { id: "newest-a", hash: "5", updatedAt: BASE_NOW + 80 },
      { id: "newest-b", hash: "6", updatedAt: BASE_NOW + 90 },
    ];

    for (const operation of terminalOperations) {
      await stub.claim(
        operationEnvelope(operation.id),
        sha256(operation.hash),
        `dispatch-${operation.id}`,
        seedPolicy,
        BASE_NOW,
      );
      await stub.transition(
        operation.id,
        1,
        "claimed",
        "completed",
        200,
        operation.updatedAt,
      );
    }

    await expect(
      stub.claim(
        operationEnvelope("maintenance-trigger"),
        sha256("7"),
        "dispatch-maintenance-trigger",
        ledgerPolicy({
          maxInFlight: 8,
          dispatchRetentionSeconds: 10,
          terminalRetentionSeconds: 30,
          maxTerminalOperations: 2,
        }),
        BASE_NOW + 100,
      ),
    ).resolves.toEqual({ kind: "new" });

    await runInDurableObject(stub, (_instance, state) => {
      const terminalRows = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations
            WHERE status IN ('completed', 'failed')
            ORDER BY updated_at`,
        )
        .toArray();
      expect(terminalRows).toEqual([
        {
          operation_id: "newest-a",
          status: "completed",
          response_status: 200,
          updated_at: BASE_NOW + 80,
        },
        {
          operation_id: "newest-b",
          status: "completed",
          response_status: 200,
          updated_at: BASE_NOW + 90,
        },
      ]);
    });
  });

  it("preserves replay-protected terminal rows and backpressures until compaction is safe", async () => {
    const stub = ledgerStub("replay-protected-capacity");
    const policy = ledgerPolicy({
      maxInFlight: 1,
      dispatchRetentionSeconds: 60,
      terminalRetentionSeconds: 300,
      maxTerminalOperations: 2,
    });

    for (let index = 0; index < 3; index += 1) {
      const operationId = `protected-${index}`;
      await expect(
        stub.claim(
          operationEnvelope(operationId),
          sha256((index + 10).toString(16)),
          `dispatch-${operationId}`,
          policy,
          BASE_NOW + index * 2,
        ),
      ).resolves.toEqual({ kind: "new" });
      await stub.transition(
        operationId,
        1,
        "claimed",
        "completed",
        200,
        BASE_NOW + index * 2 + 1,
      );
    }

    await expect(
      stub.claim(
        operationEnvelope("protected-overflow"),
        sha256("d"),
        "dispatch-protected-overflow",
        policy,
        BASE_NOW + 6,
      ),
    ).resolves.toEqual({ kind: "capacity" });
    await expect(
      stub.claim(
        operationEnvelope("protected-0"),
        sha256("a"),
        "dispatch-protected-0",
        policy,
        BASE_NOW + 7,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });

    await expect(
      stub.claim(
        operationEnvelope("protected-after-window"),
        sha256("e"),
        "dispatch-protected-after-window",
        policy,
        BASE_NOW + 70,
      ),
    ).resolves.toEqual({ kind: "new" });
    await runInDurableObject(stub, (_instance, state) => {
      const operationIds = state.storage.sql
        .exec<{ operation_id: string }>(
          "SELECT operation_id FROM cinatoken_shard_operations ORDER BY operation_id",
        )
        .toArray()
        .map(({ operation_id }) => operation_id);
      expect(operationIds).toEqual([
        "protected-1",
        "protected-2",
        "protected-after-window",
      ]);
    });
  });

  it("keeps an old terminal operation while a refreshed dispatch is replay-protected", async () => {
    const stub = ledgerStub("refreshed-dispatch-protection");
    const policy = ledgerPolicy({
      dispatchRetentionSeconds: 60,
      terminalRetentionSeconds: 60,
    });
    const envelope = operationEnvelope("refreshed-operation");
    const envelopeSha256 = sha256("f");

    await stub.claim(envelope, envelopeSha256, "dispatch-original", policy, BASE_NOW);
    await stub.transition(
      envelope.operation_id,
      1,
      "claimed",
      "completed",
      200,
      BASE_NOW + 1,
    );
    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-refreshed",
        policy,
        BASE_NOW + 50,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });

    await stub.claim(
      operationEnvelope("refreshed-maintenance-trigger"),
      sha256("1"),
      "dispatch-refreshed-maintenance",
      policy,
      BASE_NOW + 70,
    );
    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-refreshed",
        policy,
        BASE_NOW + 71,
      ),
    ).resolves.toMatchObject({ kind: "existing", row: { status: "completed" } });
  });

  it("moves an expired running operation to recovery instead of definite failure", async () => {
    const stub = ledgerStub("late-completion-cas");
    const policy = ledgerPolicy({ maxInFlight: 1 });
    const envelope = operationEnvelope("late-completion", {
      execution_deadline_at: BASE_NOW + 10,
    });

    await stub.claim(envelope, sha256("2"), "dispatch-late", policy, BASE_NOW);
    await expect(
      stub.transition("late-completion", 1, "claimed", "running", null, BASE_NOW, true),
    ).resolves.toBe(true);
    await stub.claim(
      operationEnvelope("late-completion-trigger"),
      sha256("3"),
      "dispatch-late-trigger",
      policy,
      BASE_NOW + 11,
    );
    await expect(
      stub.transition(
        "late-completion",
        1,
        "running",
        "completed",
        200,
        BASE_NOW + 12,
        true,
      ),
    ).resolves.toBe(false);

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, response_code, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = 'late-completion'`,
        )
        .one();
      expect(row).toEqual({
        operation_id: "late-completion",
        status: "recovery_required",
        response_status: 202,
        response_code: "container_execution_ambiguous",
        updated_at: BASE_NOW + 11,
      });
    });
  });

  it("migrates legacy capacity rejections into bounded failed terminal rows", async () => {
    const stub = ledgerStub("legacy-capacity-migration");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_operations
           (operation_id, owner_generation, provider_operation_id, envelope_sha256, dispatch_id,
            status, response_status, deadline_at, created_at, updated_at)
         VALUES ('legacy-capacity', 1, 'provider-legacy', ?1, 'dispatch-legacy',
                 'capacity_rejected', 503, ?2, ?3, ?3)`,
        sha256("4"),
        BASE_NOW + 300,
        BASE_NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO cinatoken_shard_dispatches
           (dispatch_id, operation_id, envelope_sha256, created_at)
         VALUES ('dispatch-legacy', 'legacy-capacity', ?1, ?2)`,
        sha256("4"),
        BASE_NOW,
      );
    });
    await evictDurableObject(stub);
    await stub.claim(
      operationEnvelope("legacy-migration-trigger"),
      sha256("5"),
      "dispatch-legacy-trigger",
      ledgerPolicy(),
      BASE_NOW + 1,
    );

    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = 'legacy-capacity'`,
        )
        .one();
      expect(row).toEqual({
        operation_id: "legacy-capacity",
        status: "failed",
        response_status: 503,
        updated_at: BASE_NOW,
      });
    });
  });

  it("preserves operation and lifecycle state after Durable Object eviction", async () => {
    const stub = ledgerStub("eviction-persistence");
    const envelope = operationEnvelope("persistent-operation");
    const envelopeSha256 = sha256("8");
    const policy = ledgerPolicy();

    await stub.claim(envelope, envelopeSha256, "dispatch-persistent", policy, BASE_NOW);
    await stub.transition(
      envelope.operation_id,
      1,
      "claimed",
      "completed",
      201,
      BASE_NOW + 1,
    );
    await stub.lifecycle("running", "container-123", BASE_NOW + 2);
    await evictDurableObject(stub);

    await expect(
      stub.claim(
        envelope,
        envelopeSha256,
        "dispatch-persistent",
        policy,
        BASE_NOW + 3,
      ),
    ).resolves.toMatchObject({
      kind: "existing",
      row: {
        operation_id: envelope.operation_id,
        status: "completed",
        response_status: 201,
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      const operation = state.storage.sql
        .exec<OperationSqlRow>(
          `SELECT operation_id, status, response_status, updated_at
             FROM cinatoken_shard_operations WHERE operation_id = ?1`,
          envelope.operation_id,
        )
        .one();
      const lifecycle = state.storage.sql
        .exec<LifecycleSqlRow>(
          `SELECT lifecycle_state, lifecycle_detail, updated_at
             FROM cinatoken_shard_state WHERE singleton = 1`,
        )
        .one();
      expect(operation).toEqual({
        operation_id: envelope.operation_id,
        status: "completed",
        response_status: 201,
        updated_at: BASE_NOW + 1,
      });
      expect(lifecycle).toEqual({
        lifecycle_state: "running",
        lifecycle_detail: "container-123",
        updated_at: BASE_NOW + 2,
      });
    });
  });

  it("keeps ledger-only readiness inspection side-effect free", async () => {
    const stub = ledgerStub("readiness-ledger-only");
    await expect(
      stub.readinessSnapshot(operationEnvelope("readiness-ledger").shard, BASE_NOW),
    ).resolves.toEqual({
      initialized: false,
      lifecycle_state: null,
      lifecycle_detail: null,
      lifecycle_updated_at: null,
      active_in_flight_operations: 0,
      expired_in_flight_operations: 0,
      terminal_operations: 0,
      readiness: {
        generation: 0,
        phase: "idle",
        last_probe_id: null,
        started_at_ms: null,
        deadline_at_ms: null,
        completed_at_ms: null,
        result_code: null,
        container_status: null,
        container_last_change_ms: null,
        container_exit_code: null,
        runtime_protocol_version: null,
        runtime_contract_version: null,
        runtime_execution_enabled: null,
        last_ready_at_ms: null,
      },
    });
  });

  it("serializes live readiness generations, rejects replay, and CAS-protects completion", async () => {
    const stub = ledgerStub("readiness-generation-cas");
    const shard = operationEnvelope("readiness-generation").shard;
    const nowMs = BASE_NOW * 1_000;
    await stub.initializeReadiness(shard, BASE_NOW);
    await expect(
      stub.beginReadinessOutcome(shard, "probe-1", nowMs, nowMs + 10_000, 5_000),
    ).resolves.toEqual({ ok: true, generation: 1 });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-2", nowMs + 1, nowMs + 10_001, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_in_progress", status: 409 },
    });
    await expect(
      stub.completeReadiness(1, nowMs + 100, readinessCompletion("process_ready", true)),
    ).resolves.toBe(true);
    await expect(
      stub.completeReadiness(1, nowMs + 101, readinessCompletion("stale")),
    ).resolves.toBe(false);
    await expect(
      stub.beginReadinessOutcome(shard, "probe-1", nowMs + 5_100, nowMs + 15_100, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_replay", status: 409 },
    });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-3", nowMs + 4_999, nowMs + 14_999, 5_000),
    ).resolves.toEqual({
      ok: false,
      error: { code: "readiness_probe_cooldown", status: 429 },
    });
    await expect(
      stub.beginReadinessOutcome(shard, "probe-4", nowMs + 5_100, nowMs + 15_100, 5_000),
    ).resolves.toEqual({ ok: true, generation: 2 });
  });

  it("rejects new claims while draining and advances readiness fences only when drained", async () => {
    const stub = ledgerStub("readiness-fence-and-drain");
    const policy = ledgerPolicy();
    const oldShard = operationEnvelope("old-ring").shard;
    await stub.claim(operationEnvelope("old-ring"), sha256("a"), "dispatch-old", policy, BASE_NOW);
    await stub.lifecycle("draining", null, BASE_NOW + 1);
    await expect(
      stub.beginReadinessOutcome(
        oldShard,
        "probe-during-drain",
        (BASE_NOW + 1) * 1_000,
        (BASE_NOW + 11) * 1_000,
        5_000,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "shard_draining", status: 503 },
    });
    await expect(
      stub.claimOutcome(
        operationEnvelope("old-ring"),
        sha256("a"),
        "dispatch-old",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toMatchObject({ ok: true, result: { kind: "existing" } });
    await expect(
      stub.claimOutcome(
        operationEnvelope("blocked-during-drain"),
        sha256("b"),
        "dispatch-blocked",
        policy,
        BASE_NOW + 2,
      ),
    ).resolves.toEqual({ ok: false, error: { code: "shard_draining", status: 503 } });
    const newShard = { ...oldShard, ring_generation: 2, shard_count: 16 };
    await expect(stub.initializeReadinessOutcome(newShard, BASE_NOW + 3)).resolves.toEqual({
      ok: false,
      error: { code: "ring_generation_in_flight", status: 409 },
    });
    await stub.transition("old-ring", 1, "claimed", "completed", 200, BASE_NOW + 4);
    await expect(stub.initializeReadinessOutcome(newShard, BASE_NOW + 5)).resolves.toEqual({
      ok: true,
    });
    await expect(stub.readinessSnapshot(newShard, BASE_NOW + 5)).resolves.toMatchObject({
      initialized: true,
      lifecycle_state: "draining",
    });
  });

  it("fences shared-storage access by running owner generation and persists result identity", async () => {
    const stub = ledgerStub("storage-owner-fence");
    const operation = operationEnvelope("storage-operation", {
      operation_kind: "chat_completion",
      input: {
        mode: "r2",
        sha256: sha256("c"),
        size: 4096,
        content_type: "application/json",
        request_object_key: `container-inputs/v1/${sha256("c")}`,
        object_version: "input-version-1",
      },
    });
    const result = {
      object_key: `container-results/v1/${operation.operation_id}/1/${sha256("d")}`,
      object_version: "result-version-1",
      sha256: sha256("d"),
      size: 8192,
      content_type: "application/json",
    };

    await stub.claim(operation, sha256("e"), "dispatch-storage", ledgerPolicy(), BASE_NOW);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
    await stub.transition(operation.operation_id, 1, "claimed", "running", null, BASE_NOW, true);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 2, BASE_NOW + 1),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 1),
    ).resolves.toMatchObject({
      ok: true,
      grant: {
        protocol_version: operation.protocol_version,
        operation_id: operation.operation_id,
        owner_generation: 1,
        owner_lease_expires_at: operation.owner_lease_expires_at,
        operation_kind: "chat_completion",
        provider_operation_id: operation.provider_operation_id,
        admission_sha256: operation.admission_sha256,
        deadline_at: operation.execution_deadline_at,
        input: operation.input,
        shard: operation.shard,
        trace_id: operation.trace_id,
        result: null,
      },
    });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 2),
    ).resolves.toEqual({ ok: true, result: "recorded" });
    await expect(
      stub.recordStorageResultOutcome(operation.operation_id, 1, result, BASE_NOW + 3),
    ).resolves.toEqual({ ok: true, result: "duplicate" });
    await expect(
      stub.recordStorageResultOutcome(
        operation.operation_id,
        1,
        { ...result, content_type: "application/octet-stream" },
        BASE_NOW + 4,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_result_conflict", status: 409 },
    });

    await evictDurableObject(stub);
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 5),
    ).resolves.toMatchObject({ ok: true, grant: { result } });
    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        1,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 6,
        true,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        operation_id: operation.operation_id,
        operation_kind: "chat_completion",
        trace_id: operation.trace_id,
        status: "completed",
        response_status: 200,
        response_code: null,
        result_object_key: result.object_key,
        result_object_version: result.object_version,
        result_sha256: result.sha256,
        result_size: result.size,
        result_content_type: result.content_type,
      },
    });
    await evictDurableObject(stub);
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      trace_id: operation.trace_id,
      status: "completed",
      result_object_version: result.object_version,
    });
    await expect(
      stub.authorizeStorageOutcome(operation.operation_id, 1, BASE_NOW + 7),
    ).resolves.toEqual({
      ok: false,
      error: { code: "storage_access_denied", status: 403 },
    });
  });

  it("refuses to complete a relay operation before its durable result is attached", async () => {
    const stub = ledgerStub("result-required-before-completion");
    const operation = operationEnvelope("result-required", {
      operation_kind: "chat_completion",
    });
    await stub.claim(operation, sha256("f"), "dispatch-result-required", ledgerPolicy(), BASE_NOW);
    await stub.transition(operation.operation_id, 1, "claimed", "running", null, BASE_NOW, true);
    await expect(
      stub.finalizeOutcome(
        operation.operation_id,
        1,
        "running",
        "completed",
        200,
        null,
        BASE_NOW + 1,
        true,
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "operation_result_required", status: 409 },
    });
    await expect(stub.readOutcome(operation.operation_id)).resolves.toMatchObject({
      status: "running",
      response_status: null,
      result_object_key: null,
    });
  });
});
