import { describe, expect, test } from "vitest";

import {
  CONTAINER_CONTROLLER_READINESS_RESULT_CONTRACT,
  probeContainerControllerReadinessOnce,
  readbackContainerControllerReadinessOnce,
  readinessCredentialIdSha256,
  validateContainerControllerReadinessClientConfig,
  type ContainerControllerReadinessClientEnv,
  type ContainerControllerReadinessInput,
} from "../src/container_controller_readiness_client";
import {
  verifyShardPlacementReadinessRequest,
  type ShardPlacementReadinessEnvironment,
  type ShardPlacementReadinessRole,
} from "../../container-controller/src/shard_placement_readiness";
import {
  activationCampaignProbeId,
} from "../../container-controller/src/shard_activation_campaign";

const NOW = 1_900_000_000;
const PROBE_SECRET =
  "authority-probe-secret-0123456789abcdef0123456789abcdef";
const READBACK_SECRET =
  "authority-readback-secret-0123456789abcdef0123456789abcdef";
const PROBE_KID = "probe-v1";
const READBACK_KID = "readback-v1";
const CONTROLLER_VERSION = "controller-version-55";
const CONTROLLER_SERVICE = "cinatoken-container-controller-test";
const ACTION_GATES = "a".repeat(64);
const RUNTIME_BUILD = "b".repeat(64);

describe("Container Controller readiness client", () => {
  test("sends one path-bound probe accepted by the Controller verifier", async () => {
    const fixture = await clientFixture("readiness_probe", "fresh");
    const result = await probeContainerControllerReadinessOnce(
      fixture.env,
      fixture.input,
      { now: NOW },
    );

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      mode: "wake_once",
      operation_ordinal: 6,
      operation_id_sha256: fixture.input.operationIdSha256,
      activation_campaign: {
        campaign_id: fixture.input.campaignId,
        nonce: fixture.input.campaignNonce,
        confirm_consume: true,
      },
      expected_action_gate_inventory_sha256: ACTION_GATES,
    });
    expect(result).toMatchObject({
      classification: "process_ready_execution_disabled",
      recoveryAction: "continue",
      readinessCredentialIdSha256:
        await readinessCredentialIdSha256(
          "readiness_probe",
          PROBE_KID,
        ),
      readinessRequestIdSha256: fixture.input.operationIdSha256,
      evidence: {
        mode: "wake_once",
        replay: "fresh",
        wakePerformed: true,
        controllerVersionId: CONTROLLER_VERSION,
        runtimeBuildId: RUNTIME_BUILD,
        resultCode: "process_ready_execution_disabled",
      },
    });
  });

  test("uses the isolated readback role and proves no second wake", async () => {
    const fixture =
      await clientFixture("readiness_readback", "exact_replay");
    const result = await readbackContainerControllerReadinessOnce(
      fixture.env,
      fixture.input,
      { now: NOW },
    );

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.mode).toBe("replay_only");
    expect(result).toMatchObject({
      classification: "process_ready_execution_disabled",
      evidence: {
        mode: "replay_only",
        replay: "exact_replay",
        wakePerformed: false,
      },
    });
  });

  test("never retries a transport-unknown probe", async () => {
    let calls = 0;
    const fixture = await clientFixture("readiness_probe", "fresh");
    fixture.env.CONTAINER_CONTROLLER = {
      async fetch(): Promise<Response> {
        calls += 1;
        throw new Error("binding unavailable");
      },
    };
    const result = await probeContainerControllerReadinessOnce(
      fixture.env,
      fixture.input,
      { now: NOW },
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      classification: "outcome_unknown",
      recoveryAction: "readback_only",
      code: "container_controller_readiness_outcome_unknown",
      mode: "wake_once",
      httpStatus: null,
      responseBodySha256: null,
      responseBytes: null,
    });
  });

  test("separates deterministic Controller rejection from unknown outcome", async () => {
    const fixture = await clientFixture("readiness_probe", "fresh");
    fixture.env.CONTAINER_CONTROLLER = {
      async fetch(request): Promise<Response> {
        await verifyShardPlacementReadinessRequest(
          request,
          controllerEnv(),
          "readiness_probe",
          NOW,
        );
        return jsonResponse(
          409,
          { error: "shard_placement_readiness_controller_drift" },
        );
      },
    };
    const result = await probeContainerControllerReadinessOnce(
      fixture.env,
      fixture.input,
      { now: NOW },
    );
    expect(result).toMatchObject({
      classification: "explicitly_unhealthy",
      recoveryAction: "disable_required",
      reasonCode: "shard_placement_readiness_controller_drift",
      httpStatus: 409,
    });
  });

  test("fails closed on response identity drift and credential reuse", async () => {
    const fixture = await clientFixture("readiness_probe", "fresh", {
      responseControllerVersion: "controller-version-other",
    });
    const result = await probeContainerControllerReadinessOnce(
      fixture.env,
      fixture.input,
      { now: NOW },
    );
    expect(result).toMatchObject({
      classification: "outcome_unknown",
      recoveryAction: "readback_only",
      code: "container_controller_readiness_invalid_response",
    });

    const invalidEnv = {
      ...fixture.env,
      CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_KID:
        PROBE_KID,
      CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        await readinessCredentialIdSha256(
          "readiness_readback",
          PROBE_KID,
        ),
      CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_SECRET:
        PROBE_SECRET,
    };
    expect(() =>
      validateContainerControllerReadinessClientConfig(invalidEnv)
    ).toThrow(
      expect.objectContaining({
        code: "container_controller_readiness_client_unavailable",
      }),
    );
  });
});

async function clientFixture(
  role: ShardPlacementReadinessRole,
  replay: "fresh" | "exact_replay",
  options: { responseControllerVersion?: string } = {},
): Promise<{
  env: ContainerControllerReadinessClientEnv;
  input: ContainerControllerReadinessInput;
  calls: Array<Record<string, unknown>>;
}> {
  const calls: Array<Record<string, unknown>> = [];
  const input = await readinessInput();
  const env: ContainerControllerReadinessClientEnv = {
    CONTAINER_CONTROLLER: {
      async fetch(request): Promise<Response> {
        const verified = await verifyShardPlacementReadinessRequest(
          request,
          controllerEnv(),
          role,
          NOW,
        );
        calls.push(verified.request as unknown as Record<string, unknown>);
        return successResponse(
          verified.request as unknown as Record<string, unknown>,
          replay,
          options.responseControllerVersion ?? CONTROLLER_VERSION,
        );
      },
    },
    CONTAINER_CONTROLLER_READINESS_ISSUER:
      "cinatoken-shard-placement-authority-test",
    CONTAINER_CONTROLLER_READINESS_AUDIENCE:
      "cinatoken-container-controller-test",
    CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_KID:
      PROBE_KID,
    CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      await readinessCredentialIdSha256(
        "readiness_probe",
        PROBE_KID,
      ),
    CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_SECRET:
      PROBE_SECRET,
    CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_KID: "",
    CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_KID:
      READBACK_KID,
    CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      await readinessCredentialIdSha256(
        "readiness_readback",
        READBACK_KID,
      ),
    CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_SECRET:
      READBACK_SECRET,
    CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_KID: "",
    CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
  };
  return { env, input, calls };
}

function controllerEnv(): ShardPlacementReadinessEnvironment {
  return {
    SHARD_PLACEMENT_READINESS_AUTHORITY_ISSUER:
      "cinatoken-shard-placement-authority-test",
    SHARD_PLACEMENT_READINESS_AUTHORITY_AUDIENCE:
      "cinatoken-container-controller-test",
    SHARD_PLACEMENT_READINESS_PROBE_CURRENT_KID: PROBE_KID,
    SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_KID: "",
    SHARD_PLACEMENT_READINESS_PROBE_CURRENT_SECRET: PROBE_SECRET,
    SHARD_PLACEMENT_READINESS_READBACK_CURRENT_KID: READBACK_KID,
    SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_KID: "",
    SHARD_PLACEMENT_READINESS_READBACK_CURRENT_SECRET:
      READBACK_SECRET,
    CONTAINER_CONTROLLER_SERVICE_NAME: CONTROLLER_SERVICE,
    CONTAINER_EXECUTION_ENABLED: "false",
    CF_VERSION_METADATA: { id: CONTROLLER_VERSION },
  };
}

async function readinessInput(): Promise<
  ContainerControllerReadinessInput
> {
  const campaignId = "9".repeat(64);
  return {
    authorizationIdSha256: "1".repeat(64),
    claimDigestSha256: "2".repeat(64),
    executionPlanSha256: "3".repeat(64),
    operationScheduleSha256: "4".repeat(64),
    authorityLedgerIdentitySha256: "5".repeat(64),
    authorityLedgerHeadSha256: "6".repeat(64),
    predecessorReceiptSha256: "6".repeat(64),
    operationOrdinal: 6,
    operationIdSha256: "7".repeat(64),
    probeIdSha256: await activationCampaignProbeId(campaignId, 0),
    shard: {
      contractVersion: 1,
      ringGeneration: 1,
      shardCount: 8,
      shardIndex: 0,
      instanceName: "cinatoken-relay-shard-v1-0000",
    },
    campaignId,
    campaignNonce: "a".repeat(64),
    expectedControllerServiceName: CONTROLLER_SERVICE,
    expectedControllerVersionId: CONTROLLER_VERSION,
    expectedRuntimeBuildId: RUNTIME_BUILD,
    expectedActionGateInventorySha256: ACTION_GATES,
    authorityVersionId: "authority-version-1",
    deadlineAtMs: (NOW + 30) * 1_000,
  };
}

function successResponse(
  request: Record<string, unknown>,
  replay: "fresh" | "exact_replay",
  controllerVersion: string,
): Response {
  const readiness = {
    mode: "live",
    wake_requested: true,
    ready: false,
    verdict: "not_ready",
    result_code: "process_ready_execution_disabled",
    shard: request.shard,
    container_state: {
      status: "healthy",
      last_change_at_ms: NOW * 1_000,
      exit_code: null,
    },
    runtime: {
      protocol_version: 1,
      shard_contract_version: 1,
      runtime_build_id: RUNTIME_BUILD,
      process_ready: true,
      execution_ready: false,
      execution_enabled: false,
    },
    ledger: {
      readiness: {
        phase: "complete",
        last_probe_id: request.probe_id_sha256,
        result_code: "process_ready_execution_disabled",
        generation: 1,
        started_at_ms: NOW * 1_000,
        deadline_at_ms: (NOW + 30) * 1_000,
        completed_at_ms: (NOW + 1) * 1_000,
      },
    },
  };
  return jsonResponse(200, {
    schema_version: 1,
    contract: CONTAINER_CONTROLLER_READINESS_RESULT_CONTRACT,
    mode: request.mode,
    replay,
    authorization_id_sha256: request.authorization_id_sha256,
    claim_digest_sha256: request.claim_digest_sha256,
    execution_plan_sha256: request.execution_plan_sha256,
    operation_schedule_sha256: request.operation_schedule_sha256,
    authority_ledger_identity_sha256:
      request.authority_ledger_identity_sha256,
    authority_ledger_head_sha256:
      request.authority_ledger_head_sha256,
    predecessor_receipt_sha256:
      request.predecessor_receipt_sha256,
    operation_ordinal: request.operation_ordinal,
    operation_id_sha256: request.operation_id_sha256,
    probe_id_sha256: request.probe_id_sha256,
    attempt_generation: 1,
    shard: request.shard,
    controller: {
      service_name: CONTROLLER_SERVICE,
      version_id: controllerVersion,
      action_gate_inventory_sha256: ACTION_GATES,
      execution_enabled: false,
    },
    authority: {
      version_id: request.authority_version_id,
    },
    journal: {
      state: "complete",
      replay,
      wake_performed: replay === "fresh",
      generation: 1,
      started_at_ms: NOW * 1_000,
      deadline_at_ms: (NOW + 30) * 1_000,
      retention_until_ms: (NOW + 300) * 1_000,
      completed_at_ms: (NOW + 1) * 1_000,
      result_sha256: "f".repeat(64),
    },
    readiness,
  });
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
