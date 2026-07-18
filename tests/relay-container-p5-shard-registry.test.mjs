import { describe, expect, test } from "bun:test";
import {
  SHARD_ACTIVATION_LEDGER_CONTRACT,
  activationDigestSha256,
  buildActivationSnapshot,
  buildShardRegistryCapture,
  validateRegistryCandidate,
  validateShardRegistryCapture,
} from "../tools/lib/relay_container_shard_registry.mjs";
import {
  SHARD_REGISTRY_REQUEST_CONTRACT,
  collectActivationSnapshot,
  collectShardRegistry,
  validateCollectorRequest,
} from "../tools/collect_relay_container_p5_shard_registry.mjs";

describe("P5 relay Container shard registry evidence", () => {
  test("derives N/N readiness from immutable per-shard rows", () => {
    const candidate = candidateFixture();
    const before = snapshotFixture(candidate, recordsFixture(candidate));
    const after = { ...before, capturedAt: "2026-07-19T10:05:00.000Z" };
    const capture = buildShardRegistryCapture({
      candidate,
      observationStartedAt: before.capturedAt,
      observationEndedAt: after.capturedAt,
      before,
      after,
    });
    expect(capture.evidenceReady).toBe(true);
    expect(capture.verifiedShardCount).toBe(candidate.shardCount);
    expect(capture.missingShardCount).toBe(0);
    expect(capture.duplicateShardCount).toBe(0);
    expect(capture.unknownShardCount).toBe(0);
    expect(validateShardRegistryCapture(capture, candidate)).toEqual(capture);

    const forged = structuredClone(capture);
    forged.verifiedShardCount = 999;
    expect(() => validateShardRegistryCapture(forged, candidate)).toThrow(
      "derived-field drift",
    );
  });

  test("shares the Controller and Rust activation digest vector", () => {
    const candidate = candidateFixture();
    const record = {
      ...recordFixture(candidate, 3, 9),
      activated_at: 1_900_000_000,
    };
    record.activation_digest_sha256 = activationDigestSha256({
      controllerVersionId: "controller-version-1",
      ringGeneration: 7,
      record: { ...record, shard_count: 8 },
    });
    expect(record.activation_digest_sha256).toBe(
      "dd807252bf5c7f04456c28f6daff983c63a5bc9557ce57cc872b91abb9293bdb",
    );
  });

  test("fails closed on old runtime rows, missing candidates, and observation drift", () => {
    const candidate = candidateFixture();
    const rows = recordsFixture(candidate).slice(1);
    const oldRuntime = recordFixture(candidate, 0, 99, "b".repeat(64));
    rows.push(oldRuntime);
    rows.sort((left, right) => left.registry_event_sequence - right.registry_event_sequence);
    const before = snapshotFixture(candidate, rows);
    const afterRows = [...rows, recordFixture(candidate, 0, 100)];
    const after = snapshotFixture(candidate, afterRows, "2026-07-19T10:05:00.000Z");
    const capture = buildShardRegistryCapture({
      candidate,
      observationStartedAt: before.capturedAt,
      observationEndedAt: after.capturedAt,
      before,
      after,
    });
    expect(capture.evidenceReady).toBe(false);
    expect(capture.blockers).toContain("activation-high-watermark-drift");
    expect(capture.blockers).toContain("activation-entry-drift");
    expect(capture.blockers).toContain("unknown-shard-activations-present");

    const wrongGenerationRows = recordsFixture(candidate);
    wrongGenerationRows[0] = {
      ...wrongGenerationRows[0],
      activation_generation: 2,
    };
    wrongGenerationRows[0].activation_digest_sha256 = activationDigestSha256({
      controllerVersionId: candidate.controllerVersionId,
      ringGeneration: candidate.ringGeneration,
      record: wrongGenerationRows[0],
    });
    const wrongGeneration = snapshotFixture(candidate, wrongGenerationRows);
    const wrongGenerationAfter = {
      ...wrongGeneration,
      capturedAt: "2026-07-19T10:05:00.000Z",
    };
    expect(
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: wrongGeneration.capturedAt,
        observationEndedAt: wrongGenerationAfter.capturedAt,
        before: wrongGeneration,
        after: wrongGenerationAfter,
      }).blockers,
    ).toContain("unknown-shard-activations-present");

    const staleRows = recordsFixture(candidate).map((record) => ({
      ...record,
      activated_at: 1,
      activation_digest_sha256: "",
    }));
    for (const record of staleRows) {
      record.activation_digest_sha256 = activationDigestSha256({
        controllerVersionId: candidate.controllerVersionId,
        ringGeneration: candidate.ringGeneration,
        record,
      });
    }
    const staleBefore = snapshotFixture(candidate, staleRows);
    const staleAfter = {
      ...staleBefore,
      capturedAt: "2026-07-19T10:05:00.000Z",
    };
    expect(
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: staleBefore.capturedAt,
        observationEndedAt: staleAfter.capturedAt,
        before: staleBefore,
        after: staleAfter,
      }).blockers,
    ).toContain("candidate-shard-activations-stale");
  });

  test("binds snapshots to a bounded observation window", () => {
    const candidate = candidateFixture();
    const before = snapshotFixture(candidate, recordsFixture(candidate));
    const after = { ...before, capturedAt: "2026-07-19T10:05:00.000Z" };
    expect(() =>
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: "2026-07-19T09:55:00.000Z",
        observationEndedAt: after.capturedAt,
        before,
        after,
      }),
    ).toThrow("before activation observation boundary");
    expect(() =>
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: before.capturedAt,
        observationEndedAt: "2026-07-19T10:00:01.000Z",
        before,
        after: { ...after, capturedAt: "2026-07-19T10:00:01.000Z" },
      }),
    ).toThrow("observation window");
  });

  test("walks a frozen keyset cursor and never sends the root cookie elsewhere", async () => {
    const candidate = candidateFixture();
    const rows = recordsFixture(candidate);
    const calls = [];
    const cookie = "session=self-test-secret-cookie-value";
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      const cursor = url.searchParams.get("cursor");
      const records = cursor === null ? rows.slice(0, 4) : rows.slice(4);
      const page = pageFixture(candidate, records, {
        totalRecords: rows.length,
        highWatermark: rows.at(-1).registry_event_sequence,
        nextCursor: cursor === null ? String(records.at(-1).registry_event_sequence) : null,
      });
      return jsonResponse({ success: true, message: "", data: page });
    };
    const snapshot = await collectActivationSnapshot(
      {
        origin: "https://staging.cinatoken.com",
        candidate,
        capturedAt: "2026-07-19T10:00:00.000Z",
      },
      { cookie, fetchImpl },
    );
    expect(snapshot.totalRecords).toBe(8);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).not.toContain("high_watermark=");
    expect(calls[1].url).toContain("high_watermark=8");
    expect(calls[1].url).toContain("cursor=4");
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe("https://staging.cinatoken.com");
      expect(call.url).not.toContain("session=");
      expect(call.options.method).toBe("GET");
      expect(call.options.redirect).toBe("error");
      expect(call.options.headers.cookie).toBe(cookie);
    }
  });

  test("collects stable before and after snapshots without a wake request", async () => {
    const candidate = candidateFixture();
    const rows = recordsFixture(candidate);
    const page = pageFixture(candidate, rows);
    const times = [
      new Date("2026-07-19T10:00:00.000Z"),
      new Date("2026-07-19T10:05:00.000Z"),
    ];
    let slept = 0;
    const capture = await collectShardRegistry(
      requestFixture(candidate),
      {
        cookie: "session=self-test-secret-cookie-value",
        fetchImpl: async () =>
          jsonResponse({ success: true, message: "", data: page }),
        now: () => times.shift(),
        sleep: async (milliseconds) => {
          slept = milliseconds;
        },
      },
    );
    expect(slept).toBe(300_000);
    expect(capture.evidenceReady).toBe(true);
    expect(capture.safetyBoundary.shardDoOrContainerWakePerformed).toBe(false);
  });

  test("uses the real 1024-shard ceiling", () => {
    expect(validateRegistryCandidate({ ...candidateFixture(), shardCount: 1_024 }).shardCount).toBe(
      1_024,
    );
    expect(() => validateRegistryCandidate({ ...candidateFixture(), shardCount: 1_025 })).toThrow(
      "candidate shard count",
    );
    expect(() =>
      validateCollectorRequest({
        ...requestFixture(candidateFixture()),
        origin: "http://127.0.0.1:8787",
      }),
    ).toThrow("HTTPS staging origin");
    expect(() =>
      validateCollectorRequest({
        ...requestFixture(candidateFixture()),
        origin: "https://attacker.workers.dev",
      }),
    ).toThrow("HTTPS staging origin");
  });

  test("bounds the activation response while streaming", async () => {
    const candidate = candidateFixture();
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    await expect(
      collectActivationSnapshot(
        {
          origin: "https://staging.cinatoken.com",
          candidate,
          capturedAt: "2026-07-19T10:00:00.000Z",
        },
        {
          cookie: "session=self-test-secret-cookie-value",
          fetchImpl: async () =>
            new Response(oversized, {
              status: 200,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
              },
            }),
        },
      ),
    ).rejects.toThrow("outside its bound");
  });
});

function candidateFixture() {
  return {
    controllerVersionId: "controller-version-001",
    runtimeBuildId: "a".repeat(64),
    containerImageDigest: `sha256:${"4".repeat(64)}`,
    imageProvenanceSha256: "5".repeat(64),
    ringGeneration: 1,
    shardCount: 8,
  };
}

function requestFixture(candidate) {
  return {
    schemaVersion: 1,
    contract: SHARD_REGISTRY_REQUEST_CONTRACT,
    environment: "staging",
    origin: "https://staging.cinatoken.com",
    observationSeconds: 300,
    candidate,
  };
}

function recordsFixture(candidate) {
  return Array.from({ length: candidate.shardCount }, (_, shardIndex) =>
    recordFixture(candidate, shardIndex, shardIndex + 1),
  );
}

function recordFixture(candidate, shardIndex, sequence, runtimeBuildId = candidate.runtimeBuildId) {
  const record = {
    registry_event_sequence: sequence,
    shard_count: candidate.shardCount,
    shard_index: shardIndex,
    instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    runtime_build_id: runtimeBuildId,
    activation_generation: 1,
    activation_probe_generation: sequence,
    environment: "staging",
    container_status: "healthy",
    readiness_result_code: "process_ready_execution_disabled",
    process_ready: true,
    runtime_execution_enabled: false,
    controller_execution_enabled: false,
    activation_digest_sha256: "",
    activated_at:
      Math.floor(Date.parse("2026-07-19T09:59:00.000Z") / 1_000) + sequence,
  };
  record.activation_digest_sha256 = activationDigestSha256({
    controllerVersionId: candidate.controllerVersionId,
    ringGeneration: candidate.ringGeneration,
    record,
  });
  return record;
}

function pageFixture(
  candidate,
  records,
  {
    totalRecords = records.length,
    highWatermark = records.at(-1)?.registry_event_sequence ?? 0,
    nextCursor = null,
  } = {},
) {
  return {
    contract_version: 1,
    ledger_contract: SHARD_ACTIVATION_LEDGER_CONTRACT,
    controller_version_id: candidate.controllerVersionId,
    ring_generation: candidate.ringGeneration,
    high_watermark: highWatermark,
    total_records: totalRecords,
    count: records.length,
    next_cursor: nextCursor,
    pagination_complete: nextCursor === null,
    records,
  };
}

function snapshotFixture(
  candidate,
  records,
  capturedAt = "2026-07-19T10:00:00.000Z",
) {
  return buildActivationSnapshot({
    capturedAt,
    pages: [pageFixture(candidate, records)],
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}
