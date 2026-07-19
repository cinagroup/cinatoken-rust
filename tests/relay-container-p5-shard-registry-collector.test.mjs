import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  SHARD_REGISTRY_REQUEST_CONTRACT,
  collectCampaignSnapshot,
  validateCollectorRequest,
} from "../tools/collect_relay_container_p5_shard_registry.mjs";
import {
  SHARD_ACTIVATION_CAMPAIGN_CONTRACT,
  activationDigestSha256,
  campaignConsumptionDigestSha256,
} from "../tools/lib/relay_container_shard_registry.mjs";

describe("P5 sealed campaign collector", () => {
  test("reads the exact root campaign without reflecting the cookie", async () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const cookie = "session=self-test-secret-cookie-value";
    const calls = [];
    const snapshot = await collectCampaignSnapshot(
      {
        origin: "https://staging.cinatoken.com",
        candidate,
        campaignId: campaign.campaign_id,
        foundationManifestSha256: campaign.foundation_manifest_sha256,
        capturedAt: "2026-07-19T10:00:00.000Z",
      },
      {
        cookie,
        fetchImpl: async (url, options) => {
          calls.push({ url: String(url), options });
          return jsonResponse({ success: true, message: "", data: campaign });
        },
      },
    );

    expect(snapshot.state).toBe("sealed_complete");
    expect(snapshot.receiptCount).toBe(1);
    expect(snapshot.receipts[0].readiness_result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`campaign_id=${campaign.campaign_id}`);
    expect(calls[0].url).not.toContain("session=");
    expect(calls[0].options.headers.cookie).toBe(cookie);
    expect(calls[0].options.method).toBe("GET");
    expect(calls[0].options.redirect).toBe("error");
  });

  test("fails closed when the API omits receipts or returns a non-complete seal", async () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const input = {
      origin: "https://staging.cinatoken.com",
      candidate,
      campaignId: campaign.campaign_id,
      foundationManifestSha256: campaign.foundation_manifest_sha256,
      capturedAt: "2026-07-19T10:00:00.000Z",
    };
    const options = {
      cookie: "session=self-test-secret-cookie-value",
      fetchImpl: async () =>
        jsonResponse({
          success: true,
          message: "",
          data: { ...campaign, receipts: undefined },
        }),
    };
    await expect(collectCampaignSnapshot(input, options)).rejects.toThrow(
      /fields are invalid|cover every shard/,
    );

    await expect(
      collectCampaignSnapshot(input, {
        ...options,
        fetchImpl: async () =>
          jsonResponse({
            success: true,
            message: "",
            data: { ...campaign, state: "sealed_expired", seal_reason: "expired" },
          }),
      }),
    ).rejects.toThrow(/campaign state/);
  });

  test("requires the campaign and foundation identities in the canonical request", () => {
    const candidate = candidateFixture();
    const campaign = campaignFixture(candidate);
    const request = {
      schemaVersion: 1,
      contract: SHARD_REGISTRY_REQUEST_CONTRACT,
      environment: "staging",
      origin: "https://staging.cinatoken.com",
      observationSeconds: 300,
      candidate,
      campaignId: campaign.campaign_id,
      foundationManifestSha256: campaign.foundation_manifest_sha256,
    };
    expect(validateCollectorRequest(request)).toEqual(request);
    const missingCampaign = { ...request };
    delete missingCampaign.campaignId;
    expect(() => validateCollectorRequest(missingCampaign)).toThrow(/fields are invalid/);
    expect(() =>
      validateCollectorRequest({
        ...request,
        foundationManifestSha256: "A".repeat(64),
      }),
    ).toThrow(/foundation manifest digest/);
  });
});

function candidateFixture() {
  return {
    controllerVersionId: "controller-version-001",
    runtimeBuildId: "a".repeat(64),
    containerImageDigest: `sha256:${"4".repeat(64)}`,
    imageProvenanceSha256: "5".repeat(64),
    ringGeneration: 1,
    shardCount: 1,
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
    shard_count: 1,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    activation_generation: 1,
    environment: "staging",
    campaign_digest_sha256: "d".repeat(64),
    created_at: epoch("2026-07-19T09:55:00.000Z"),
    expires_at: epoch("2026-07-19T10:55:00.000Z"),
    claimed_shard_count: 1,
    consumed_shard_count: 1,
    seal_reason: "complete",
    seal_detail_code: "all_shards_consumed",
    last_consumption_digest_sha256: "",
    sealed_at: epoch("2026-07-19T09:59:30.000Z"),
    receipts: [],
  };
  const receipt = {
    campaign_id: campaign.campaign_id,
    shard_index: 0,
    claim_digest_sha256: hash("claim:0"),
    probe_id: hash("probe:0"),
    campaign_digest_sha256: campaign.campaign_digest_sha256,
    controller_version_id: campaign.controller_version_id,
    action_gate_inventory_sha256: campaign.action_gate_inventory_sha256,
    action_gate_count: 22,
    all_action_gates_false: true,
    foundation_manifest_sha256: campaign.foundation_manifest_sha256,
    ring_generation: 1,
    shard_count: 1,
    instance_name: "cinatoken-relay-shard-v1-0000",
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    runtime_build_id: candidate.runtimeBuildId,
    activation_generation: 1,
    activation_probe_generation: 1,
    environment: "staging",
    container_status: "healthy",
    readiness_result_code: "process_ready_execution_disabled",
    readiness_result_sha256: hash("readiness:0"),
    process_ready: true,
    runtime_execution_enabled: false,
    controller_execution_enabled: false,
    activation_digest_sha256: "",
    consumption_digest_sha256: "",
    readiness_checked_at: campaign.sealed_at - 1,
    consumed_at: campaign.sealed_at,
  };
  const record = {
    registry_event_sequence: 1,
    shard_count: 1,
    shard_index: 0,
    instance_name: receipt.instance_name,
    shard_contract_version: 1,
    runtime_protocol_version: 1,
    runtime_contract_version: 1,
    runtime_build_id: receipt.runtime_build_id,
    activation_generation: 1,
    activation_probe_generation: 1,
    environment: "staging",
    container_status: "healthy",
    readiness_result_code: "process_ready_execution_disabled",
    process_ready: true,
    runtime_execution_enabled: false,
    controller_execution_enabled: false,
    activation_digest_sha256: "",
    activated_at: receipt.readiness_checked_at,
  };
  receipt.activation_digest_sha256 = activationDigestSha256({
    controllerVersionId: candidate.controllerVersionId,
    ringGeneration: 1,
    record,
  });
  receipt.consumption_digest_sha256 = campaignConsumptionDigestSha256(receipt);
  campaign.receipts = [receipt];
  campaign.last_consumption_digest_sha256 = receipt.consumption_digest_sha256;
  return campaign;
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
