import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  SHARD_ACTIVATION_CAMPAIGN_CONTRACT,
  SHARD_ACTIVATION_LEDGER_CONTRACT,
  activationDigestSha256,
  buildActivationSnapshot,
  buildCampaignSnapshot,
  buildShardRegistryCapture,
  campaignConsumptionDigestSha256,
  validateRegistryCandidate,
  validateShardRegistryCapture,
} from "../tools/lib/relay_container_shard_registry.mjs";
import {
  SHARD_REGISTRY_REQUEST_CONTRACT,
  collectActivationSnapshot,
  collectShardRegistry,
  validateCollectorRequest,
} from "../tools/collect_relay_container_p5_shard_registry.mjs";

describe("P5 relay Container sealed campaign evidence", () => {
  test("accepts one sealed_complete N/N campaign linked to every 0054 row", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const before = snapshotFixture(candidate, activationRecords(campaign.receipts));
    const after = { ...before, capturedAt: "2026-07-19T10:05:00.000Z" };
    const capture = buildCapture(candidate, campaign, before, after);

    expect(capture.schemaVersion).toBe(2);
    expect(capture.evidenceReady).toBe(true);
    expect(capture.verifiedShardCount).toBe(candidate.shardCount);
    expect(capture.verifiedReceiptCount).toBe(candidate.shardCount);
    expect(capture.campaign.state).toBe("sealed_complete");
    expect(capture.campaign.receiptCount).toBe(candidate.shardCount);
    expect(validateShardRegistryCapture(capture, candidate)).toEqual(capture);

    const forged = structuredClone(capture);
    forged.verifiedReceiptCount = 999;
    expect(() => validateShardRegistryCapture(forged, candidate)).toThrow(
      "derived-field drift",
    );
  });

  test("shares activation and consumption digest vectors", () => {
    const candidate = candidateFixture();
    const record = {
      ...recordFixture(candidate, 3, 9),
      shard_count: 8,
      activated_at: 1_900_000_000,
      activation_digest_sha256: "",
    };
    record.activation_digest_sha256 = activationDigestSha256({
      controllerVersionId: "controller-version-1",
      ringGeneration: 7,
      record,
    });
    expect(record.activation_digest_sha256).toBe(
      "dd807252bf5c7f04456c28f6daff983c63a5bc9557ce57cc872b91abb9293bdb",
    );

    const campaign = campaignFixture(candidate);
    const receipt = campaign.receipts[3];
    expect(receipt.readiness_result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.consumption_digest_sha256).toBe(
      campaignConsumptionDigestSha256(receipt),
    );
  });

  test("rejects non-complete, cross-campaign, malformed, and incomplete receipts", () => {
    const candidate = candidateFixture();
    const base = campaignFixture(candidate);
    for (const [state, reason] of [
      ["open", null],
      ["sealed_failed", "failed"],
      ["sealed_expired", "expired"],
      ["sealed_aborted", "aborted"],
    ]) {
      expect(() =>
        buildCampaignSnapshot({
          capturedAt: "2026-07-19T10:00:00.000Z",
          campaign: { ...base, state, seal_reason: reason },
          expected: candidate,
        }),
      ).toThrow(/campaign state/);
    }

    const crossCampaign = structuredClone(base);
    crossCampaign.receipts[2].campaign_id = "f".repeat(64);
    expect(() => campaignSnapshot(candidate, crossCampaign)).toThrow(
      /receipt campaign ID/,
    );

    const invalidReadinessDigest = structuredClone(base);
    invalidReadinessDigest.receipts[2].readiness_result_sha256 = "A".repeat(64);
    expect(() => campaignSnapshot(candidate, invalidReadinessDigest)).toThrow(
      /readiness result digest/,
    );

    const tamperedConsumption = structuredClone(base);
    tamperedConsumption.receipts[2].consumption_digest_sha256 = "0".repeat(64);
    expect(() => campaignSnapshot(candidate, tamperedConsumption)).toThrow(
      /consumption digest/,
    );

    const missing = structuredClone(base);
    missing.receipts.pop();
    expect(() => campaignSnapshot(candidate, missing)).toThrow(
      /cover every shard/,
    );

    const duplicate = structuredClone(base);
    duplicate.receipts[3] = structuredClone(duplicate.receipts[2]);
    expect(() => campaignSnapshot(candidate, duplicate)).toThrow(
      /receipt shard coverage/,
    );

    const unknown = structuredClone(base);
    unknown.receipts[3].shard_index = candidate.shardCount;
    expect(() => campaignSnapshot(candidate, unknown)).toThrow(
      /receipt shard coverage/,
    );
  });

  test("does not accept 0054 rows without their exact 0055 receipt association", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const rows = activationRecords(campaign.receipts).slice(1);
    const unrelated = recordFixture(candidate, 0, 99, "b".repeat(64));
    rows.push(unrelated);
    rows.sort((left, right) => left.registry_event_sequence - right.registry_event_sequence);
    const before = snapshotFixture(candidate, rows);
    const after = { ...before, capturedAt: "2026-07-19T10:05:00.000Z" };
    const capture = buildCapture(candidate, campaign, before, after);
    expect(capture.evidenceReady).toBe(false);
    expect(capture.blockers).toContain("campaign-receipt-activations-missing");
    expect(capture.blockers).toContain("unknown-shard-activations-present");

    const duplicateRows = activationRecords(campaign.receipts);
    duplicateRows.push({
      ...duplicateRows[0],
      registry_event_sequence: 99,
    });
    const duplicateBefore = snapshotFixture(candidate, duplicateRows);
    const duplicateAfter = {
      ...duplicateBefore,
      capturedAt: "2026-07-19T10:05:00.000Z",
    };
    expect(
      buildCapture(candidate, campaign, duplicateBefore, duplicateAfter).blockers,
    ).toContain("campaign-receipt-activations-duplicated");
  });

  test("fails closed on campaign or activation observation drift", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const before = snapshotFixture(candidate, activationRecords(campaign.receipts));
    const afterRows = [
      ...activationRecords(campaign.receipts),
      recordFixture(candidate, 0, 100, "b".repeat(64)),
    ];
    const after = snapshotFixture(candidate, afterRows, "2026-07-19T10:05:00.000Z");
    const capture = buildCapture(candidate, campaign, before, after);
    expect(capture.blockers).toContain("activation-high-watermark-drift");
    expect(capture.blockers).toContain("activation-entry-drift");

    const campaignBefore = campaignSnapshot(candidate, campaign);
    const changed = structuredClone(campaign);
    changed.action_gate_inventory_sha256 = "8".repeat(64);
    for (const receipt of changed.receipts) {
      receipt.action_gate_inventory_sha256 = changed.action_gate_inventory_sha256;
    }
    expect(() =>
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: before.capturedAt,
        observationEndedAt: "2026-07-19T10:05:00.000Z",
        campaignBefore,
        campaignAfter: buildCampaignSnapshot({
          capturedAt: "2026-07-19T10:05:00.000Z",
          campaign: changed,
          expected: candidate,
        }),
        before,
        after: { ...before, capturedAt: "2026-07-19T10:05:00.000Z" },
      }),
    ).toThrow(/campaign readback drifted/);
  });

  test("binds every snapshot to the exact observation boundary", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const before = snapshotFixture(candidate, activationRecords(campaign.receipts));
    const after = { ...before, capturedAt: "2026-07-19T10:05:00.000Z" };
    expect(() =>
      buildShardRegistryCapture({
        candidate,
        observationStartedAt: "2026-07-19T09:55:00.000Z",
        observationEndedAt: after.capturedAt,
        campaignBefore: campaignSnapshot(candidate, campaign),
        campaignAfter: campaignSnapshot(candidate, campaign, after.capturedAt),
        before,
        after,
      }),
    ).toThrow(/before campaign observation boundary/);
  });

  test("walks a frozen 0054 keyset cursor without leaking the root cookie", async () => {
    const candidate = candidateFixture();
    const rows = activationRecords(campaignFixture(candidate).receipts);
    const calls = [];
    const cookie = "session=self-test-secret-cookie-value";
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      const cursor = url.searchParams.get("cursor");
      const records = cursor === null ? rows.slice(0, 4) : rows.slice(4);
      return jsonResponse({
        success: true,
        message: "",
        data: pageFixture(candidate, records, {
          totalRecords: rows.length,
          highWatermark: rows.at(-1).registry_event_sequence,
          nextCursor: cursor === null ? String(records.at(-1).registry_event_sequence) : null,
        }),
      });
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
    expect(calls[1].url).toContain("high_watermark=8");
    expect(calls[1].url).toContain("cursor=4");
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe("https://staging.cinatoken.com");
      expect(call.url).not.toContain("session=");
      expect(call.options.headers.cookie).toBe(cookie);
    }
  });

  test("collects sealed campaign and 0054 snapshots without a wake request", async () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const page = pageFixture(candidate, activationRecords(campaign.receipts));
    const times = [
      new Date("2026-07-19T10:00:00.000Z"),
      new Date("2026-07-19T10:05:00.000Z"),
    ];
    const calls = [];
    const capture = await collectShardRegistry(requestFixture(candidate, campaign), {
      cookie: "session=self-test-secret-cookie-value",
      fetchImpl: async (url) => {
        calls.push(String(url));
        const data = url.pathname.endsWith("activation-campaigns") ? campaign : page;
        return jsonResponse({ success: true, message: "", data });
      },
      now: () => times.shift(),
      sleep: async () => {},
    });
    expect(calls.filter((url) => url.includes("activation-campaigns"))).toHaveLength(2);
    expect(capture.evidenceReady).toBe(true);
    expect(capture.safetyBoundary.shardDoOrContainerWakePerformed).toBe(false);
  });

  test("enforces request identity, staging origin, and the 1024-shard ceiling", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    expect(validateRegistryCandidate({ ...candidate, shardCount: 1_024 }).shardCount).toBe(1_024);
    expect(() => validateRegistryCandidate({ ...candidate, shardCount: 1_025 })).toThrow(
      /candidate shard count/,
    );
    expect(() =>
      validateCollectorRequest({
        ...requestFixture(candidate, campaign),
        campaignId: "A".repeat(64),
      }),
    ).toThrow(/campaign ID/);
    expect(() =>
      validateCollectorRequest({
        ...requestFixture(candidate, campaign),
        origin: "https://attacker.workers.dev",
      }),
    ).toThrow(/HTTPS staging origin/);
  });

  test("bounds activation responses while streaming", async () => {
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
    ).rejects.toThrow(/outside its bound/);
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

function requestFixture(candidate, campaign) {
  return {
    schemaVersion: 1,
    contract: SHARD_REGISTRY_REQUEST_CONTRACT,
    environment: "staging",
    origin: "https://staging.cinatoken.com",
    observationSeconds: 300,
    candidate,
    campaignId: campaign.campaign_id,
    foundationManifestSha256: campaign.foundation_manifest_sha256,
  };
}

function campaignFixture(candidate) {
  const campaign = {
    contract_version: 1,
    campaign_contract: SHARD_ACTIVATION_CAMPAIGN_CONTRACT,
    state: "sealed_complete",
    campaign_id: "c".repeat(64),
    controller_version_id: candidate.controllerVersionId,
    action_gate_inventory_sha256: "9".repeat(64),
    action_gate_count: 22,
    all_action_gates_false: true,
    foundation_manifest_sha256: "6".repeat(64),
    runtime_build_id: candidate.runtimeBuildId,
    ring_generation: candidate.ringGeneration,
    shard_count: candidate.shardCount,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    activation_generation: 1,
    environment: "staging",
    campaign_digest_sha256: "d".repeat(64),
    created_at: epoch("2026-07-19T09:55:00.000Z"),
    expires_at: epoch("2026-07-19T10:55:00.000Z"),
    claimed_shard_count: candidate.shardCount,
    consumed_shard_count: candidate.shardCount,
    seal_reason: "complete",
    seal_detail_code: "all_shards_consumed",
    last_consumption_digest_sha256: "",
    sealed_at: epoch("2026-07-19T09:59:30.000Z"),
    receipts: [],
  };
  campaign.receipts = Array.from({ length: candidate.shardCount }, (_, shardIndex) =>
    receiptFixture(campaign, shardIndex),
  );
  campaign.last_consumption_digest_sha256 = campaign.receipts.at(-1).consumption_digest_sha256;
  return campaign;
}

function receiptFixture(campaign, shardIndex) {
  const receipt = {
    campaign_id: campaign.campaign_id,
    shard_index: shardIndex,
    claim_digest_sha256: hash(`claim:${shardIndex}`),
    probe_id: hash(`probe:${shardIndex}`),
    campaign_digest_sha256: campaign.campaign_digest_sha256,
    controller_version_id: campaign.controller_version_id,
    action_gate_inventory_sha256: campaign.action_gate_inventory_sha256,
    action_gate_count: campaign.action_gate_count,
    all_action_gates_false: true,
    foundation_manifest_sha256: campaign.foundation_manifest_sha256,
    ring_generation: campaign.ring_generation,
    shard_count: campaign.shard_count,
    instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
    shard_contract_version: campaign.shard_contract_version,
    runtime_protocol_version: campaign.runtime_protocol_version,
    runtime_contract_version: campaign.runtime_contract_version,
    runtime_build_id: campaign.runtime_build_id,
    activation_generation: campaign.activation_generation,
    activation_probe_generation: shardIndex + 1,
    environment: campaign.environment,
    container_status: "healthy",
    readiness_result_code: "process_ready_execution_disabled",
    readiness_result_sha256: hash(`readiness:${shardIndex}`),
    process_ready: true,
    runtime_execution_enabled: false,
    controller_execution_enabled: false,
    activation_digest_sha256: "",
    consumption_digest_sha256: "",
    readiness_checked_at: campaign.sealed_at - 1,
    consumed_at: shardIndex + 1 === campaign.shard_count ? campaign.sealed_at : campaign.sealed_at - 1,
  };
  const record = activationRecordFromReceipt(receipt, shardIndex + 1);
  receipt.activation_digest_sha256 = activationDigestSha256({
    controllerVersionId: receipt.controller_version_id,
    ringGeneration: receipt.ring_generation,
    record,
  });
  receipt.consumption_digest_sha256 = campaignConsumptionDigestSha256(receipt);
  return receipt;
}

function activationRecords(receipts) {
  return receipts.map((receipt, index) => activationRecordFromReceipt(receipt, index + 1));
}

function activationRecordFromReceipt(receipt, sequence) {
  return {
    registry_event_sequence: sequence,
    shard_count: receipt.shard_count,
    shard_index: receipt.shard_index,
    instance_name: receipt.instance_name,
    shard_contract_version: receipt.shard_contract_version,
    runtime_protocol_version: receipt.runtime_protocol_version,
    runtime_contract_version: receipt.runtime_contract_version,
    runtime_build_id: receipt.runtime_build_id,
    activation_generation: receipt.activation_generation,
    activation_probe_generation: receipt.activation_probe_generation,
    environment: receipt.environment,
    container_status: receipt.container_status,
    readiness_result_code: receipt.readiness_result_code,
    process_ready: receipt.process_ready,
    runtime_execution_enabled: receipt.runtime_execution_enabled,
    controller_execution_enabled: receipt.controller_execution_enabled,
    activation_digest_sha256: receipt.activation_digest_sha256,
    activated_at: receipt.readiness_checked_at,
  };
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
    activated_at: epoch("2026-07-19T09:59:29.000Z"),
  };
  record.activation_digest_sha256 = activationDigestSha256({
    controllerVersionId: candidate.controllerVersionId,
    ringGeneration: candidate.ringGeneration,
    record,
  });
  return record;
}

function campaignSnapshot(candidate, campaign, capturedAt = "2026-07-19T10:00:00.000Z") {
  return buildCampaignSnapshot({ capturedAt, campaign, expected: candidate });
}

function buildCapture(candidate, campaign, before, after) {
  return buildShardRegistryCapture({
    candidate,
    observationStartedAt: before.capturedAt,
    observationEndedAt: after.capturedAt,
    campaignBefore: campaignSnapshot(candidate, campaign, before.capturedAt),
    campaignAfter: campaignSnapshot(candidate, campaign, after.capturedAt),
    before,
    after,
  });
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

function snapshotFixture(candidate, records, capturedAt = "2026-07-19T10:00:00.000Z") {
  return buildActivationSnapshot({ capturedAt, pages: [pageFixture(candidate, records)] });
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function epoch(value) {
  return Math.floor(Date.parse(value) / 1_000);
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
