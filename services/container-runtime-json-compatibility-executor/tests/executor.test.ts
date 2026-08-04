import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createJsonHealthProbeDigestRecord,
  serializeJsonHealthProbeWireRequest,
  sha256Hex,
  type JsonCompatibilityProbeRequestV1,
  type JsonCompatibilityProbeResultV1,
} from "../../container-controller/src/json_compatibility_probe";
import {
  jsonCompatibilityPermitSigningPayload,
} from "../src/authorization";
import type {
  JsonCompatibilityCampaignLeaseBeginV1,
  JsonCompatibilityCampaignLeaseCompleteV1,
  JsonCompatibilityCampaignLeaseFailV1,
  JsonCompatibilityCampaignLeaseBeginResult,
  JsonCompatibilityCampaignLeaseTerminalResult,
} from "../src/campaign_authority";
import {
  executeJsonCompatibilityPhase,
  type JsonCompatibilityExecutorEnv,
  type JsonCompatibilityExecutorRuntime,
} from "../src/executor";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PHASE_IDS,
  JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
  JsonCompatibilityExecutorProtocolError,
  parseJsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityTopologyV1,
} from "../src/protocol";

const NOW_MS = Date.parse("2026-08-04T01:02:03Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const PERMIT_ISSUER = "cinatoken-json-compatibility-permit-issuer-staging";
const PERMIT_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const PERMIT_KEY_ID = "json-compatibility-test-2026-08";

const PERMIT_KEY_PAIR = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);
const PERMIT_SPKI = new Uint8Array(
  await crypto.subtle.exportKey("spki", PERMIT_KEY_PAIR.publicKey),
);
const PERMIT_SPKI_BASE64URL = encodeBase64url(PERMIT_SPKI);
const PERMIT_SPKI_SHA256 = await sha256Hex(PERMIT_SPKI);

function topologyFor(
  phaseId: JsonCompatibilityPhaseId,
  candidateShardIndex = 3,
): JsonCompatibilityTopologyV1 {
  switch (phaseId) {
    case "baseline-n-minus-one":
    case "rollback-n-minus-one":
      return { defaultRuntime: "n-minus-one", overrides: [] };
    case "mixed-n-n-minus-one":
      return {
        defaultRuntime: "n-minus-one",
        overrides: [{ shardIndex: candidateShardIndex, runtime: "n" }],
      };
    case "candidate-n":
      return { defaultRuntime: "n", overrides: [] };
  }
}

async function validExecuteRequest(
  phaseId: JsonCompatibilityPhaseId = "mixed-n-n-minus-one",
): Promise<JsonCompatibilityExecutePhaseRequestV2> {
  const ordinal = (JSON_COMPATIBILITY_PHASE_IDS.indexOf(phaseId) + 1) as 1 | 2 | 3 | 4;
  const request = {
    schemaVersion: 2 as const,
    contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
    kind: "container-runtime-json-compatibility-phase-execution",
    environment: "staging",
    campaignIdSha256: "11".repeat(32),
    planDigestSha256: "22".repeat(32),
    phaseExecutionId: `json-compat-${phaseId}-001`,
    controller: {
      serviceName: "cinatoken-container-controller-staging",
      versionId: "controller-version-001",
      configSha256: "33".repeat(32),
    },
    runtimes: {
      n: {
        buildIdSha256: "44".repeat(32),
        imageDigest: `sha256:${"55".repeat(32)}`,
      },
      nMinusOne: {
        buildIdSha256: "66".repeat(32),
        imageDigest: `sha256:${"77".repeat(32)}`,
      },
    },
    ring: {
      generation: 9,
      shardCount: 8,
      candidateShardIndex: 3,
    },
    phase: {
      ordinal,
      id: phaseId,
      topology: topologyFor(phaseId),
    },
  };
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    issuer: PERMIT_ISSUER,
    audience: PERMIT_AUDIENCE,
    keyId: PERMIT_KEY_ID,
    permitIdSha256: await sha256Hex(`permit:${phaseId}`),
    campaignIdSha256: request.campaignIdSha256,
    planDigestSha256: request.planDigestSha256,
    phaseExecutionId: request.phaseExecutionId,
    controller: request.controller,
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging" as const,
      versionId: "executor-version-001",
    },
    runtimes: request.runtimes,
    ring: request.ring,
    phase: request.phase,
    issuedAt: NOW_SECONDS - 10,
    notBefore: NOW_SECONDS - 5,
    expiresAt: NOW_SECONDS + 300,
  };
  const authorization = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519" as const,
    subject,
    subjectSha256: await sha256Hex(canonicalJson(subject)),
    signatureBase64url: "",
  };
  authorization.signatureBase64url = encodeBase64url(new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      PERMIT_KEY_PAIR.privateKey,
      jsonCompatibilityPermitSigningPayload(authorization),
    ),
  ));
  return { ...request, authorization };
}

function deterministicRuntime(): JsonCompatibilityExecutorRuntime {
  let sequence = 0;
  return {
    now: () => NOW_MS,
    randomUUID: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
    },
  };
}

async function successfulProbeResult(
  request: JsonCompatibilityProbeRequestV1,
): Promise<JsonCompatibilityProbeResultV1> {
  const requestRawJson = serializeJsonHealthProbeWireRequest(request);
  const responseRawJson = JSON.stringify({
    protocol_version: 1,
    operation_id: request.operation.operationId,
    status: "completed",
    trace_id: request.operation.traceId,
  });
  const readinessRawJson = JSON.stringify({
    status: "ready",
    protocol_version: 1,
    runtime_build_id: request.expectedRuntimeBuildIdSha256,
    shard_contract_version: 1,
    execution_enabled: false,
  });
  const probeDigests = await createJsonHealthProbeDigestRecord(
    requestRawJson,
    responseRawJson,
  );
  return {
    schemaVersion: 1,
    contract: "cinatoken-container-runtime-json-probe-result-v1",
    request,
    startedAt: request.requestedAt,
    completedAt: request.requestedAt,
    readiness: {
      statusCode: 200,
      contentType: "application/json",
      rawJson: readinessRawJson,
      rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
      rawSha256: await sha256Hex(readinessRawJson),
      runtimeBuildIdSha256: request.expectedRuntimeBuildIdSha256,
      protocolVersion: 1,
      shardContractVersion: 1,
      executionEnabled: false,
    },
    healthProbe: {
      operationKind: "health_probe",
      statusCode: 200,
      requestContentType: "application/json",
      responseContentType: "application/json",
      requestRawJson,
      responseRawJson,
      ...probeDigests,
      selectedTransport: "json",
      effectiveTransport: "json",
      attemptCount: 1,
      legacyJsonFallbackCount: 0,
      outcome: "completed",
      recoveryRequired: false,
    },
    sideEffects: {
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
    },
  };
}

class RecordingProbeBinding {
  readonly calls: JsonCompatibilityProbeRequestV1[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly mutate?: (
      result: JsonCompatibilityProbeResultV1,
      request: JsonCompatibilityProbeRequestV1,
    ) => unknown,
  ) {}

  async probeShard(request: JsonCompatibilityProbeRequestV1): Promise<unknown> {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await successfulProbeResult(request);
      return this.mutate === undefined ? result : this.mutate(result, request);
    } finally {
      this.active -= 1;
    }
  }
}

class RecordingCampaignAuthority {
  readonly beginCalls: JsonCompatibilityCampaignLeaseBeginV1[] = [];
  readonly completeCalls: JsonCompatibilityCampaignLeaseCompleteV1[] = [];
  readonly failCalls: JsonCompatibilityCampaignLeaseFailV1[] = [];

  constructor(
    private readonly beginError?:
      "campaign_permit_replayed"
      | "campaign_phase_order_conflict"
      | "campaign_lease_active",
  ) {}

  async beginPhase(
    input: JsonCompatibilityCampaignLeaseBeginV1,
  ): Promise<JsonCompatibilityCampaignLeaseBeginResult> {
    this.beginCalls.push(input);
    if (this.beginError !== undefined) {
      return { ok: false, error: { code: this.beginError } };
    }
    const receiptSubject = {
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-campaign-lease-receipt-v1",
        status: "phase_lease_acquired",
        campaignIdSha256: input.campaignIdSha256,
        campaignBindingSha256: input.campaignBindingSha256,
        planDigestSha256: input.planDigestSha256,
        permitIdSha256: input.permitIdSha256,
        permitSubjectSha256: input.permitSubjectSha256,
        permitEnvelopeSha256: input.permitEnvelopeSha256,
        phaseOrdinal: input.phaseOrdinal,
        phaseId: input.phaseId,
        phaseExecutionId: input.phaseExecutionId,
        leaseIdSha256: input.leaseIdSha256,
        executorVersionId: input.executorVersionId,
        acquiredAt: input.acquiredAt,
        permitExpiresAt: input.permitExpiresAt,
        singleUsePermitPersisted: true,
        phaseOrderEnforced: true,
        concurrentPhaseRejected: true,
    } as const;
    return {
      ok: true,
      receipt: {
        ...receiptSubject,
        leaseReceiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
      },
    };
  }

  async completePhase(
    input: JsonCompatibilityCampaignLeaseCompleteV1,
  ): Promise<JsonCompatibilityCampaignLeaseTerminalResult> {
    this.completeCalls.push(input);
    return { ok: true, status: "phase_completed" };
  }

  async failPhase(
    input: JsonCompatibilityCampaignLeaseFailV1,
  ): Promise<JsonCompatibilityCampaignLeaseTerminalResult> {
    this.failCalls.push(input);
    return { ok: true, status: "campaign_failed" };
  }
}

function validEnv(
  binding: RecordingProbeBinding,
  enabled = true,
  authority = new RecordingCampaignAuthority(),
): JsonCompatibilityExecutorEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_EXECUTOR_ENABLED: enabled ? "true" : "false",
    CF_VERSION_METADATA: { id: "executor-version-001" },
    CONTAINER_CONTROLLER_JSON_PROBE: binding,
    JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY: {
      getByName: () => authority,
    },
    JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
    JSON_COMPATIBILITY_PERMIT_AUDIENCE: PERMIT_AUDIENCE,
    JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
    JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: PERMIT_SPKI_BASE64URL,
  } as unknown as JsonCompatibilityExecutorEnv;
}

function encodeBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("executePhase request contract", () => {
  test("accepts only the exact four approved phase topologies", async () => {
    for (const phaseId of JSON_COMPATIBILITY_PHASE_IDS) {
      const request = await validExecuteRequest(phaseId);
      expect(parseJsonCompatibilityExecutePhaseRequestV2(request)).toEqual(request);
    }
  });

  test("rejects field, environment, controller, runtime, ring, topology, and permit binding drift", async () => {
    const valid = await validExecuteRequest();
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({ ...valid, extra: true }),
    ).toThrow(/fields must be exactly/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        environment: "production",
      }),
    ).toThrow(/environment must equal staging/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        controller: { ...valid.controller, serviceName: "wrong-controller" },
      }),
    ).toThrow(/service name must equal/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        runtimes: { n: valid.runtimes.n, nMinusOne: valid.runtimes.n },
      }),
    ).toThrow(/build IDs must differ/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        ring: { ...valid.ring, shardCount: 7 },
      }),
    ).toThrow(/shard count must equal 8/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        phase: {
          ...valid.phase,
          topology: { defaultRuntime: "n", overrides: [] },
        },
      }),
    ).toThrow(/topology does not match/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV2({
        ...valid,
        phaseExecutionId: "drifted-phase-execution",
      }),
    ).toThrow(/authorization subject must bind/);
  });
});

describe("private JSON compatibility phase execution", () => {
  test("probes exactly eight shards with at most four concurrent RPCs", async () => {
    const binding = new RecordingProbeBinding();
    const authority = new RecordingCampaignAuthority();
    const packet = await executeJsonCompatibilityPhase(
      validEnv(binding, true, authority),
      await validExecuteRequest(),
      deterministicRuntime(),
    );

    expect(binding.calls).toHaveLength(8);
    expect(binding.maxActive).toBe(4);
    expect(binding.active).toBe(0);
    expect(authority.beginCalls).toHaveLength(1);
    expect(authority.completeCalls).toHaveLength(1);
    expect(authority.failCalls).toHaveLength(0);
    expect(packet.contract).toBe(JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT);
    expect(packet.observations.map((entry) => entry.shardIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(packet.observations.map((entry) => entry.runtimeGeneration)).toEqual([
      "n-minus-one",
      "n-minus-one",
      "n-minus-one",
      "n",
      "n-minus-one",
      "n-minus-one",
      "n-minus-one",
      "n-minus-one",
    ]);
    expect(new Set(binding.calls.map((entry) => entry.operation.operationId)).size).toBe(8);
    expect(new Set(binding.calls.map((entry) => entry.operation.traceId)).size).toBe(8);
    for (const request of binding.calls) {
      const requestedAtSeconds = Date.parse(request.requestedAt) / 1000;
      expect(request.controllerServiceName).toBe(
        "cinatoken-container-controller-staging",
      );
      expect(request.controllerVersionId).toBe("controller-version-001");
      expect(request.shard.shardCount).toBe(8);
      expect(request.operation.executionDeadlineAt - requestedAtSeconds).toBe(60);
      expect(request.operation.ownerLeaseExpiresAt - requestedAtSeconds).toBe(120);
    }
  });

  test("returns a serializable digest-bound source packet and explicit zero-mutation facts", async () => {
    const packet = await executeJsonCompatibilityPhase(
      validEnv(new RecordingProbeBinding()),
      await validExecuteRequest("candidate-n"),
      deterministicRuntime(),
    );
    const { receiptSha256, ...subject } = packet;
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson(subject)));
    expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
    expect(packet.schemaVersion).toBe(2);
    expect(packet.authorization).toMatchObject({
      kind: "ed25519-signed-single-use-phase-permit",
      algorithm: "Ed25519",
      issuer: PERMIT_ISSUER,
      audience: PERMIT_AUDIENCE,
      keyId: PERMIT_KEY_ID,
      signerSpkiSha256: PERMIT_SPKI_SHA256,
      campaignAuthority: {
        kind: "campaign-scoped-sqlite-durable-object",
        binding: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        objectNameSha256: "11".repeat(32),
        singleUsePermitPersisted: true,
        phaseOrderEnforced: true,
        concurrentPhaseRejected: true,
      },
    });
    expect(packet.transport).toEqual({
      kind: "service-binding-rpc",
      binding: "CONTAINER_CONTROLLER_JSON_PROBE",
      targetService: "cinatoken-container-controller-staging",
      targetEntrypoint: "JsonCompatibilityProbeEntrypoint",
      rpcMethod: "probeShard",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
    });
    expect(packet.executionBoundary).toEqual({
      credentialsRead: false,
      filesWritten: false,
      deploymentMutationAuthorized: false,
      deploymentMutationPerformed: false,
      cloudflareRestRequestCount: 0,
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
    });
    expect(packet.transportTotals).toEqual({
      privateServiceBindingRpcCount: 8,
      completedProbeCount: 8,
      selectedJsonCount: 8,
      effectiveJsonCount: 8,
      protobufAttemptCount: 0,
      legacyJsonFallbackCount: 0,
      recoveryRequiredCount: 0,
    });
  });

  test("fails closed while disabled or outside staging without calling the binding", async () => {
    const disabledBinding = new RecordingProbeBinding();
    await expect(
      executeJsonCompatibilityPhase(
        validEnv(disabledBinding, false),
        await validExecuteRequest(),
        deterministicRuntime(),
      ),
    ).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "executor_disabled",
    });
    expect(disabledBinding.calls).toHaveLength(0);

    const productionBinding = new RecordingProbeBinding();
    await expect(
      executeJsonCompatibilityPhase(
        { ...validEnv(productionBinding), ENVIRONMENT: "production" },
        await validExecuteRequest(),
        deterministicRuntime(),
      ),
    ).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "executor_staging_only",
    });
    expect(productionBinding.calls).toHaveLength(0);
  });

  test("awaits every in-flight RPC and rejects a side-effecting probe result", async () => {
    const binding = new RecordingProbeBinding((result, request) => {
      if (request.shard.shardIndex !== 0) return result;
      return {
        ...result,
        sideEffects: { ...result.sideEffects, providerRequestCount: 1 },
      };
    });
    const authority = new RecordingCampaignAuthority();
    await expect(
      executeJsonCompatibilityPhase(
        validEnv(binding, true, authority),
        await validExecuteRequest(),
        deterministicRuntime(),
      ),
    ).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "invalid_probe_result",
    });
    expect(binding.calls).toHaveLength(4);
    expect(binding.active).toBe(0);
    expect(binding.maxActive).toBe(4);
    expect(authority.beginCalls).toHaveLength(1);
    expect(authority.completeCalls).toHaveLength(0);
    expect(authority.failCalls).toHaveLength(1);
    expect(authority.failCalls[0]?.failureCode).toBe("invalid_probe_result");
  });

  test("rejects an invalid signature before acquiring a lease or probing", async () => {
    const request = await validExecuteRequest();
    const binding = new RecordingProbeBinding();
    const authority = new RecordingCampaignAuthority();
    await expect(executeJsonCompatibilityPhase(
      validEnv(binding, true, authority),
      {
        ...request,
        authorization: {
          ...request.authorization,
          signatureBase64url:
            `${request.authorization.signatureBase64url.startsWith("A") ? "B" : "A"}${
              request.authorization.signatureBase64url.slice(1)
            }`,
        },
      },
      deterministicRuntime(),
    )).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "invalid_phase_permit",
    });
    expect(binding.calls).toHaveLength(0);
    expect(authority.beginCalls).toHaveLength(0);
  });

  test("rejects a consumed permit before issuing any probe RPC", async () => {
    const binding = new RecordingProbeBinding();
    const authority = new RecordingCampaignAuthority("campaign_permit_replayed");
    await expect(executeJsonCompatibilityPhase(
      validEnv(binding, true, authority),
      await validExecuteRequest(),
      deterministicRuntime(),
    )).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "campaign_permit_replayed",
    });
    expect(binding.calls).toHaveLength(0);
    expect(authority.beginCalls).toHaveLength(1);
    expect(authority.completeCalls).toHaveLength(0);
    expect(authority.failCalls).toHaveLength(0);
  });

  test("fails closed when pinned verifier material is absent", async () => {
    const binding = new RecordingProbeBinding();
    const authority = new RecordingCampaignAuthority();
    const env = validEnv(binding, true, authority);
    delete (env as { JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL?: string })
      .JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL;
    await expect(executeJsonCompatibilityPhase(
      env,
      await validExecuteRequest(),
      deterministicRuntime(),
    )).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "phase_permit_verifier_unavailable",
    });
    expect(binding.calls).toHaveLength(0);
    expect(authority.beginCalls).toHaveLength(0);
  });
});
