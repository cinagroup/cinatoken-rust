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
  executeJsonCompatibilityPhase,
  type JsonCompatibilityExecutorEnv,
  type JsonCompatibilityExecutorRuntime,
} from "../src/executor";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PHASE_IDS,
  JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
  JsonCompatibilityExecutorProtocolError,
  parseJsonCompatibilityExecutePhaseRequestV1,
  type JsonCompatibilityExecutePhaseRequestV1,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityTopologyV1,
} from "../src/protocol";

const NOW_MS = Date.parse("2026-08-04T01:02:03Z");

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

function validExecuteRequest(
  phaseId: JsonCompatibilityPhaseId = "mixed-n-n-minus-one",
): JsonCompatibilityExecutePhaseRequestV1 {
  const ordinal = (JSON_COMPATIBILITY_PHASE_IDS.indexOf(phaseId) + 1) as 1 | 2 | 3 | 4;
  return {
    schemaVersion: 1,
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

function validEnv(
  binding: RecordingProbeBinding,
  enabled = true,
): JsonCompatibilityExecutorEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_EXECUTOR_ENABLED: enabled ? "true" : "false",
    CF_VERSION_METADATA: { id: "executor-version-001" },
    CONTAINER_CONTROLLER_JSON_PROBE: binding,
  };
}

describe("executePhase request contract", () => {
  test("accepts only the exact four approved phase topologies", () => {
    for (const phaseId of JSON_COMPATIBILITY_PHASE_IDS) {
      const request = validExecuteRequest(phaseId);
      expect(parseJsonCompatibilityExecutePhaseRequestV1(request)).toEqual(request);
    }
  });

  test("rejects field, environment, controller, runtime, ring, and topology drift", () => {
    const valid = validExecuteRequest();
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({ ...valid, extra: true }),
    ).toThrow(/fields must be exactly/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({
        ...valid,
        environment: "production",
      }),
    ).toThrow(/environment must equal staging/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({
        ...valid,
        controller: { ...valid.controller, serviceName: "wrong-controller" },
      }),
    ).toThrow(/service name must equal/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({
        ...valid,
        runtimes: { n: valid.runtimes.n, nMinusOne: valid.runtimes.n },
      }),
    ).toThrow(/build IDs must differ/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({
        ...valid,
        ring: { ...valid.ring, shardCount: 7 },
      }),
    ).toThrow(/shard count must equal 8/);
    expect(() =>
      parseJsonCompatibilityExecutePhaseRequestV1({
        ...valid,
        phase: {
          ...valid.phase,
          topology: { defaultRuntime: "n", overrides: [] },
        },
      }),
    ).toThrow(/topology does not match/);
  });
});

describe("private JSON compatibility phase execution", () => {
  test("probes exactly eight shards with at most four concurrent RPCs", async () => {
    const binding = new RecordingProbeBinding();
    const packet = await executeJsonCompatibilityPhase(
      validEnv(binding),
      validExecuteRequest(),
      deterministicRuntime(),
    );

    expect(binding.calls).toHaveLength(8);
    expect(binding.maxActive).toBe(4);
    expect(binding.active).toBe(0);
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
      validExecuteRequest("candidate-n"),
      deterministicRuntime(),
    );
    const { receiptSha256, ...subject } = packet;
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson(subject)));
    expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
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
        validExecuteRequest(),
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
        validExecuteRequest(),
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
    await expect(
      executeJsonCompatibilityPhase(
        validEnv(binding),
        validExecuteRequest(),
        deterministicRuntime(),
      ),
    ).rejects.toMatchObject<JsonCompatibilityExecutorProtocolError>({
      code: "invalid_probe_result",
    });
    expect(binding.calls).toHaveLength(4);
    expect(binding.active).toBe(0);
    expect(binding.maxActive).toBe(4);
  });
});
