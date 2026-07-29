import { describe, expect, test } from "bun:test";

import {
  SHARD_PLACEMENT_READINESS_AUTHORITY_HEADER,
  SHARD_PLACEMENT_READINESS_PROBE_PATH,
  SHARD_PLACEMENT_READINESS_READBACK_PATH,
  SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT,
  assertShardPlacementReadinessControllerIdentity,
  createShardPlacementReadinessAuthorityTokenForTest,
  shardPlacementReadinessCredentialIdSha256,
  shardPlacementReadinessResponse,
  verifyShardPlacementReadinessRequest,
  type ShardPlacementReadinessAuthorityClaims,
  type ShardPlacementReadinessEnvironment,
  type ShardPlacementReadinessRequest,
  type ShardPlacementReadinessRole,
} from "../src/shard_placement_readiness";
import {
  SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES,
  activationCampaignProbeId,
  type CampaignActionGateInventory,
  type ShardActivationCampaignClaim,
} from "../src/shard_activation_campaign";

const NOW = 1_900_000_000;
const PROBE_SECRET = "probe-secret-0123456789abcdef0123456789abcdef";
const READBACK_SECRET =
  "readback-secret-0123456789abcdef0123456789abcdef";
const PROBE_KID = "probe-v1";
const READBACK_KID = "readback-v1";
const CAMPAIGN_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
const RUNTIME_BUILD_ID = "c".repeat(64);
const CLAIM_DIGEST = "d".repeat(64);
const ACTION_GATE_DIGEST = "e".repeat(64);
const CONTROLLER_VERSION = "controller-version-55";

const env: ShardPlacementReadinessEnvironment = {
  SHARD_PLACEMENT_READINESS_AUTHORITY_ISSUER:
    "cinatoken-shard-placement-authority-test",
  SHARD_PLACEMENT_READINESS_AUTHORITY_AUDIENCE:
    "cinatoken-container-controller-test",
  SHARD_PLACEMENT_READINESS_PROBE_CURRENT_KID: PROBE_KID,
  SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_KID: "",
  SHARD_PLACEMENT_READINESS_PROBE_CURRENT_SECRET: PROBE_SECRET,
  SHARD_PLACEMENT_READINESS_READBACK_CURRENT_KID: READBACK_KID,
  SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_KID: "",
  SHARD_PLACEMENT_READINESS_READBACK_CURRENT_SECRET: READBACK_SECRET,
  CONTAINER_CONTROLLER_SERVICE_NAME:
    "cinatoken-container-controller-test",
  CONTAINER_EXECUTION_ENABLED: "false",
  CF_VERSION_METADATA: { id: CONTROLLER_VERSION },
};

describe("shard-placement operation readiness private protocol", () => {
  test("uses path-bound role-specific HMAC credentials and a strict operation 6-13 body", async () => {
    const requestBody = await readinessRequest("readiness_probe");
    const verified = await verifyShardPlacementReadinessRequest(
      await signedRequest(requestBody, "readiness_probe"),
      env,
      "readiness_probe",
      NOW,
    );
    expect(verified.request).toMatchObject({
      contract: SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT,
      operation_ordinal: 6,
      probe_id_sha256: await activationCampaignProbeId(CAMPAIGN_ID, 0),
      mode: "wake_once",
      shard: { shard_count: 8, shard_index: 0 },
    });

    await expect(
      verifyShardPlacementReadinessRequest(
        await signedRequest(
          { ...requestBody, mode: "replay_only" },
          "readiness_probe",
          SHARD_PLACEMENT_READINESS_READBACK_PATH,
        ),
        env,
        "readiness_readback",
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      verifyShardPlacementReadinessRequest(
        await signedRequest(
          { ...requestBody, operation_ordinal: 7 },
          "readiness_probe",
        ),
        env,
        "readiness_probe",
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "invalid_shard_placement_readiness_request",
      status: 400,
    });
  });

  test("rejects compressed request semantics before authentication or D1 access", async () => {
    const requestBody = await readinessRequest("readiness_probe");
    const request = await signedRequest(requestBody, "readiness_probe");
    request.headers.set("content-encoding", "gzip");
    await expect(
      verifyShardPlacementReadinessRequest(
        request,
        env,
        "readiness_probe",
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "invalid_shard_placement_readiness_transport",
      status: 400,
    });
  });

  test("rejects a validly signed noncanonical request body", async () => {
    const requestBody = await readinessRequest("readiness_probe");
    await expect(
      verifyShardPlacementReadinessRequest(
        await signedRequest(
          requestBody,
          "readiness_probe",
          SHARD_PLACEMENT_READINESS_PROBE_PATH,
          false,
        ),
        env,
        "readiness_probe",
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "invalid_shard_placement_readiness_request",
      status: 400,
    });
  });

  test("rejects Controller service or version drift before campaign mutation", async () => {
    const request = await readinessRequest("readiness_probe");
    expect(() =>
      assertShardPlacementReadinessControllerIdentity(request, {
        ...env,
        CF_VERSION_METADATA: { id: "controller-version-other" },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "shard_placement_readiness_controller_drift",
        status: 409,
      }),
    );
    expect(() =>
      assertShardPlacementReadinessControllerIdentity(request, {
        ...env,
        CONTAINER_CONTROLLER_SERVICE_NAME:
          "cinatoken-container-controller-other",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "shard_placement_readiness_controller_drift",
        status: 409,
      }),
    );
  });

  test("accepts only process-ready and execution-disabled evidence", async () => {
    const fixture = await responseFixture("fresh");
    const response = shardPlacementReadinessResponse(
      fixture.verified,
      fixture.claim,
      fixture.actionGates,
      fixture.outcome,
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({
      replay: "fresh",
      controller: {
        service_name: env.CONTAINER_CONTROLLER_SERVICE_NAME,
        version_id: CONTROLLER_VERSION,
        execution_enabled: false,
      },
      journal: {
        state: "complete",
        replay: "fresh",
        wake_performed: true,
        result_sha256: "f".repeat(64),
      },
      readiness: {
        ready: false,
        verdict: "not_ready",
        result_code: "process_ready_execution_disabled",
        container_state: { status: "healthy" },
        runtime: {
          process_ready: true,
          execution_ready: false,
          execution_enabled: false,
          runtime_build_id: RUNTIME_BUILD_ID,
        },
      },
    });

    const unsafe = await responseFixture("fresh");
    unsafe.outcome.result.runtime.execution_enabled = true;
    unsafe.outcome.result.runtime.execution_ready = true;
    unsafe.outcome.result.ready = true;
    unsafe.outcome.result.verdict = "ready";
    unsafe.outcome.result.result_code = "execution_ready";
    expect(() =>
      shardPlacementReadinessResponse(
        unsafe.verified,
        unsafe.claim,
        unsafe.actionGates,
        unsafe.outcome,
        env,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "shard_placement_readiness_health_ineligible",
        status: 409,
      }),
    );
  });

  test("returns exact replay evidence without claiming another wake", async () => {
    const fixture = await responseFixture("exact_replay");
    const response = shardPlacementReadinessResponse(
      fixture.verified,
      fixture.claim,
      fixture.actionGates,
      fixture.outcome,
      env,
    );
    expect(await response.json()).toMatchObject({
      mode: "replay_only",
      replay: "exact_replay",
      journal: {
        state: "complete",
        replay: "exact_replay",
        wake_performed: false,
        generation: 1,
      },
    });
  });
});

async function readinessRequest(
  role: ShardPlacementReadinessRole,
): Promise<ShardPlacementReadinessRequest> {
  const shardIndex = 0;
  return {
    schema_version: 1,
    contract: SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT,
    authorization_id_sha256: "1".repeat(64),
    claim_digest_sha256: CLAIM_DIGEST,
    execution_plan_sha256: "2".repeat(64),
    operation_schedule_sha256: "3".repeat(64),
    authority_ledger_identity_sha256: "4".repeat(64),
    authority_ledger_head_sha256: "5".repeat(64),
    predecessor_receipt_sha256: "6".repeat(64),
    operation_ordinal: 6,
    operation_id_sha256: "7".repeat(64),
    probe_id_sha256: await activationCampaignProbeId(
      CAMPAIGN_ID,
      shardIndex,
    ),
    attempt_generation: 1,
    mode: role === "readiness_probe" ? "wake_once" : "replay_only",
    shard: {
      contract_version: 1,
      ring_generation: 7,
      shard_count: 8,
      shard_index: shardIndex,
      instance_name: "cinatoken-relay-shard-v1-0000",
    },
    activation_campaign: {
      contract_version: 1,
      campaign_id: CAMPAIGN_ID,
      nonce: NONCE,
      confirm_consume: true,
    },
    expected_controller_service_name:
      env.CONTAINER_CONTROLLER_SERVICE_NAME,
    expected_controller_version_id: CONTROLLER_VERSION,
    expected_runtime_build_id: RUNTIME_BUILD_ID,
    expected_action_gate_inventory_sha256: ACTION_GATE_DIGEST,
    authority_version_id: "authority-version-11",
    deadline_at_ms: NOW * 1_000 + 30_000,
  };
}

async function signedRequest(
  bodyValue: ShardPlacementReadinessRequest,
  role: ShardPlacementReadinessRole,
  path = role === "readiness_probe"
    ? SHARD_PLACEMENT_READINESS_PROBE_PATH
    : SHARD_PLACEMENT_READINESS_READBACK_PATH,
  canonical = true,
): Promise<Request> {
  const body = canonical
    ? canonicalJson(bodyValue)
    : JSON.stringify(bodyValue);
  const kid = role === "readiness_probe" ? PROBE_KID : READBACK_KID;
  const secret =
    role === "readiness_probe" ? PROBE_SECRET : READBACK_SECRET;
  const claims: ShardPlacementReadinessAuthorityClaims = {
    authority_version: 1,
    issuer: env.SHARD_PLACEMENT_READINESS_AUTHORITY_ISSUER,
    audience: env.SHARD_PLACEMENT_READINESS_AUTHORITY_AUDIENCE,
    role,
    credential_id_sha256:
      await shardPlacementReadinessCredentialIdSha256(role, kid),
    request_id_sha256: bodyValue.operation_id_sha256,
    method: "POST",
    path_and_query: path,
    body_sha256: await sha256Hex(body),
    issued_at: NOW,
    expires_at: NOW + 30,
  };
  const token = await createShardPlacementReadinessAuthorityTokenForTest(
    secret,
    kid,
    role,
    claims,
  );
  return new Request(`https://controller.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SHARD_PLACEMENT_READINESS_AUTHORITY_HEADER]: token,
    },
    body,
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("integer required");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) {
    throw new Error("JSON value required");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalValue(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
}

async function responseFixture(replay: "fresh" | "exact_replay") {
  const request = await readinessRequest(
    replay === "fresh" ? "readiness_probe" : "readiness_readback",
  );
  const role =
    replay === "fresh" ? "readiness_probe" : "readiness_readback";
  const verified = await verifyShardPlacementReadinessRequest(
    await signedRequest(request, role),
    env,
    role,
    NOW,
  );
  const claim: ShardActivationCampaignClaim = {
    campaignId: CAMPAIGN_ID,
    campaignDigestSha256: "8".repeat(64),
    claimDigestSha256: CLAIM_DIGEST,
    controllerVersionId: CONTROLLER_VERSION,
    actionGateInventorySha256: ACTION_GATE_DIGEST,
    actionGateCount: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
    foundationManifestSha256: "9".repeat(64),
    runtimeBuildId: RUNTIME_BUILD_ID,
    shard: request.shard,
    runtimeProtocolVersion: 1,
    runtimeContractVersion: 1,
    activationGeneration: 1,
    probeId: request.probe_id_sha256,
    environment: "staging",
    claimedAt: NOW,
    recovered: replay === "exact_replay",
  };
  const actionGates: CampaignActionGateInventory = {
    allActionGatesFalse: true,
    count: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
    digestSha256: ACTION_GATE_DIGEST,
    gates: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.map((name) => ({
      enabled: false,
      name,
    })),
  };
  const startedAtMs = NOW * 1_000;
  const deadlineAtMs = startedAtMs + 10_000;
  const completedAtMs = startedAtMs + 250;
  const result = {
    checked_at: Math.floor(completedAtMs / 1_000),
    mode: "live",
    ready: false,
    verdict: "not_ready",
    result_code: "process_ready_execution_disabled",
    shard: request.shard,
    wake_requested: true,
    container_state: {
      status: "healthy",
      last_change_ms: startedAtMs,
      exit_code: null,
    },
    ledger: {
      initialized: true,
      lifecycle_state: "running",
      lifecycle_detail: null,
      lifecycle_updated_at: NOW,
      active_in_flight_operations: 0,
      expired_in_flight_operations: 0,
      terminal_operations: 0,
      readiness: {
        generation: 1,
        phase: "complete",
        last_probe_id: request.probe_id_sha256,
        started_at_ms: startedAtMs,
        deadline_at_ms: deadlineAtMs,
        completed_at_ms: completedAtMs,
        result_code: "process_ready_execution_disabled",
        container_status: "healthy",
        container_last_change_ms: startedAtMs,
        container_exit_code: null,
        runtime_protocol_version: 1,
        runtime_contract_version: 1,
        runtime_execution_enabled: false,
        last_ready_at_ms: completedAtMs,
      },
    },
    runtime: {
      process_ready: true,
      execution_ready: false,
      protocol_version: 1,
      shard_contract_version: 1,
      runtime_build_id: RUNTIME_BUILD_ID,
      execution_enabled: false,
    },
  };
  return {
    verified,
    claim,
    actionGates,
    outcome: {
      ok: true as const,
      result,
      result_sha256: "f".repeat(64),
      journal: {
        replay,
        generation: 1,
        started_at_ms: startedAtMs,
        deadline_at_ms: deadlineAtMs,
        retention_until_ms: deadlineAtMs + 86_400_000,
        completed_at_ms: completedAtMs,
      },
    },
  };
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
