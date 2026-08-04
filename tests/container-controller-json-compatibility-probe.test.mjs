import { describe, expect, test } from "bun:test";
import {
  JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256,
  JSON_COMPATIBILITY_PROBE_PHASE_IDS,
  JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT,
  MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES,
  buildJsonHealthProbeWireRequest,
  canonicalJson,
  createJsonHealthProbeDigestRecord,
  digestBoundedRawJsonObject,
  expectedRuntimeGenerationForProbe,
  parseBoundedRawJsonObject,
  parseJsonCompatibilityProbeRequestJson,
  parseJsonCompatibilityProbeRequestV1,
  parseJsonCompatibilityProbeResultV1,
  serializeJsonHealthProbeWireRequest,
  sha256Hex,
  verifyJsonCompatibilityProbeResultDigests,
} from "../services/container-controller/src/json_compatibility_probe.ts";
import {
  createJsonHealthProbeDigestRecord as createOfflineJsonHealthProbeDigestRecord,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";

const REQUESTED_AT = "2026-08-04T00:00:00Z";
const REQUESTED_AT_SECONDS = Date.parse(REQUESTED_AT) / 1000;

function validRequest(overrides = {}) {
  const request = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
    environment: "staging",
    campaignIdSha256: "11".repeat(32),
    planDigestSha256: "22".repeat(32),
    phaseId: "mixed-n-n-minus-one",
    phaseOrdinal: 2,
    candidateShardIndex: 3,
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerVersionId: "controller-version-001",
    runtimeGeneration: "n",
    expectedRuntimeBuildIdSha256: "33".repeat(32),
    requestedAt: REQUESTED_AT,
    shard: {
      contractVersion: 1,
      ringGeneration: 7,
      shardCount: 8,
      shardIndex: 3,
      instanceName: "cinatoken-relay-shard-v1-0003",
    },
    operation: {
      operationId: "json-compat-operation-001",
      ownerGeneration: 9,
      ownerLeaseExpiresAt: REQUESTED_AT_SECONDS + 120,
      executionDeadlineAt: REQUESTED_AT_SECONDS + 60,
      providerOperationId: "json-compat-provider-operation-001",
      admissionSha256: "44".repeat(32),
      traceId: "json-compat-trace-001",
    },
  };
  return { ...request, ...overrides };
}

async function validResult(request = validRequest()) {
  const parsedRequest = parseJsonCompatibilityProbeRequestV1(request);
  const requestRawJson = serializeJsonHealthProbeWireRequest(parsedRequest);
  const responseRawJson = JSON.stringify({
    protocol_version: 1,
    operation_id: parsedRequest.operation.operationId,
    status: "completed",
    trace_id: parsedRequest.operation.traceId,
  });
  const readinessRawJson = JSON.stringify({
    status: "ready",
    protocol_version: 1,
    runtime_build_id: parsedRequest.expectedRuntimeBuildIdSha256,
    shard_contract_version: 1,
    execution_enabled: false,
  });
  const probeDigest = await createJsonHealthProbeDigestRecord(
    requestRawJson,
    responseRawJson,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT,
    request: parsedRequest,
    startedAt: "2026-08-04T00:00:01Z",
    completedAt: "2026-08-04T00:00:02Z",
    readiness: {
      statusCode: 200,
      contentType: "application/json",
      rawJson: readinessRawJson,
      rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
      rawSha256: await sha256Hex(readinessRawJson),
      runtimeBuildIdSha256: parsedRequest.expectedRuntimeBuildIdSha256,
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
      ...probeDigest,
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

describe("Controller JSON compatibility probe request", () => {
  test("accepts the exact staging v1 contract and derives all four topologies", () => {
    const request = validRequest();
    expect(parseJsonCompatibilityProbeRequestV1(request)).toEqual(request);
    expect(
      parseJsonCompatibilityProbeRequestJson(JSON.stringify(request)),
    ).toEqual(request);
    expect(JSON_COMPATIBILITY_PROBE_PHASE_IDS).toEqual([
      "baseline-n-minus-one",
      "mixed-n-n-minus-one",
      "candidate-n",
      "rollback-n-minus-one",
    ]);
    expect(expectedRuntimeGenerationForProbe("baseline-n-minus-one", 3, 3)).toBe(
      "n-minus-one",
    );
    expect(expectedRuntimeGenerationForProbe("mixed-n-n-minus-one", 3, 3)).toBe("n");
    expect(expectedRuntimeGenerationForProbe("mixed-n-n-minus-one", 3, 4)).toBe(
      "n-minus-one",
    );
    expect(expectedRuntimeGenerationForProbe("candidate-n", 3, 4)).toBe("n");
    expect(expectedRuntimeGenerationForProbe("rollback-n-minus-one", 3, 3)).toBe(
      "n-minus-one",
    );
  });

  test("rejects unknown fields, non-staging input, bad phase order, and runtime drift", () => {
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({ ...validRequest(), unexpected: true }),
    ).toThrow(/fields must be exactly/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        environment: "production",
      }),
    ).toThrow(/environment must equal staging/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        phaseOrdinal: 3,
      }),
    ).toThrow(/ordinal does not match/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        runtimeGeneration: "n-minus-one",
      }),
    ).toThrow(/runtime generation must be n/);
  });

  test("rejects malformed hashes, unsafe tokens, and invalid whole-second UTC", () => {
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        campaignIdSha256: "AA".repeat(32),
      }),
    ).toThrow(/lowercase SHA-256/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        controllerVersionId: "unsafe/version",
      }),
    ).toThrow(/safe opaque token/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        requestedAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toThrow(/whole-second UTC/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        requestedAt: "2026-02-30T00:00:00Z",
      }),
    ).toThrow(/valid UTC timestamp/);
  });

  test("enforces the fixed eight-shard ring fence and instance name", () => {
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        shard: { ...validRequest().shard, shardCount: 7 },
      }),
    ).toThrow(/shard count must equal 8/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        shard: { ...validRequest().shard, shardIndex: 8 },
      }),
    ).toThrow(/shard index/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        shard: {
          ...validRequest().shard,
          instanceName: "cinatoken-relay-shard-v1-0004",
        },
      }),
    ).toThrow(/instance name must equal/);
  });

  test("enforces requested, execution deadline, and owner lease ordering and bounds", () => {
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        operation: {
          ...validRequest().operation,
          executionDeadlineAt: REQUESTED_AT_SECONDS,
        },
      }),
    ).toThrow(/requestedAt < executionDeadlineAt/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        operation: {
          ...validRequest().operation,
          executionDeadlineAt: REQUESTED_AT_SECONDS + 121,
        },
      }),
    ).toThrow(/executionDeadlineAt <= ownerLeaseExpiresAt/);
    expect(() =>
      parseJsonCompatibilityProbeRequestV1({
        ...validRequest(),
        operation: {
          ...validRequest().operation,
          executionDeadlineAt: REQUESTED_AT_SECONDS + 301,
          ownerLeaseExpiresAt: REQUESTED_AT_SECONDS + 301,
        },
      }),
    ).toThrow(/execution deadline exceeds the bounded probe window/);
  });
});

describe("no-side-effect health probe wire contract", () => {
  test("builds only the exact empty inline JSON health_probe envelope", () => {
    const wire = buildJsonHealthProbeWireRequest(validRequest());
    expect(wire).toEqual({
      protocol_version: 1,
      operation_id: "json-compat-operation-001",
      operation_kind: "health_probe",
      owner_generation: 9,
      owner_lease_expires_at: REQUESTED_AT_SECONDS + 120,
      execution_deadline_at: REQUESTED_AT_SECONDS + 60,
      provider_operation_id: "json-compat-provider-operation-001",
      admission_sha256: "44".repeat(32),
      input: {
        mode: "inline",
        sha256: JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256,
        size: 0,
        content_type: "application/json",
      },
      shard: {
        contract_version: 1,
        ring_generation: 7,
        shard_count: 8,
        shard_index: 3,
        instance_name: "cinatoken-relay-shard-v1-0003",
      },
      trace_id: "json-compat-trace-001",
    });
    const raw = serializeJsonHealthProbeWireRequest(validRequest());
    expect(JSON.parse(raw)).toEqual(wire);
    expect(raw).not.toContain("billing");
    expect(raw).not.toContain("storage");
    expect(raw).not.toContain("request_object_key");
    expect(raw).not.toContain("object_version");
  });

  test("validates bounded UTF-8 object JSON and produces Worker Web Crypto digests", async () => {
    const first = await digestBoundedRawJsonObject(
      '{"b":2,"a":1}',
      128,
      "fixture",
    );
    const second = await digestBoundedRawJsonObject(
      '{ "a": 1, "b": 2 }',
      128,
      "fixture",
    );
    expect(first.rawSha256).not.toBe(second.rawSha256);
    expect(first.canonicalSha256).toBe(second.canonicalSha256);
    expect(first.canonicalSha256).toBe(await sha256Hex('{"a":1,"b":2}'));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');

    expect(() => parseBoundedRawJsonObject("[]", 16)).toThrow(/JSON object/);
    expect(() => parseBoundedRawJsonObject("{", 16)).toThrow(/valid JSON/);
    expect(() => parseBoundedRawJsonObject('{"value":1}', 4)).toThrow(/byte limit/);
    expect(() =>
      parseBoundedRawJsonObject(
        new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
        16,
      ),
    ).toThrow(/must not contain a UTF-8 BOM/);
  });

  test("normalizes only volatile health probe identity for compatibility digests", async () => {
    const firstRequest = validRequest();
    const secondRequest = validRequest({
      operation: {
        ...validRequest().operation,
        operationId: "json-compat-operation-002",
        ownerGeneration: 10,
        providerOperationId: "json-compat-provider-operation-002",
        admissionSha256: "55".repeat(32),
        traceId: "json-compat-trace-002",
      },
    });
    const firstWire = serializeJsonHealthProbeWireRequest(firstRequest);
    const secondWire = serializeJsonHealthProbeWireRequest(secondRequest);
    const first = await createJsonHealthProbeDigestRecord(
      firstWire,
      JSON.stringify({
        protocol_version: 1,
        operation_id: firstRequest.operation.operationId,
        status: "completed",
        trace_id: firstRequest.operation.traceId,
      }),
    );
    const second = await createJsonHealthProbeDigestRecord(
      secondWire,
      JSON.stringify({
        protocol_version: 1,
        operation_id: secondRequest.operation.operationId,
        status: "completed",
        trace_id: secondRequest.operation.traceId,
      }),
    );
    expect(first.requestSha256).not.toBe(second.requestSha256);
    expect(first.responseSha256).not.toBe(second.responseSha256);
    expect(first.requestCompatibilitySha256).toBe(
      second.requestCompatibilitySha256,
    );
    expect(first.responseCompatibilitySha256).toBe(
      second.responseCompatibilitySha256,
    );
  });

  test("matches the offline campaign projection for the same raw wire vector", async () => {
    const request = validRequest();
    const requestRawJson = serializeJsonHealthProbeWireRequest(request);
    const responseRawJson = JSON.stringify({
      protocol_version: 1,
      operation_id: request.operation.operationId,
      status: "completed",
      trace_id: request.operation.traceId,
    });

    const workerRecord = await createJsonHealthProbeDigestRecord(
      requestRawJson,
      responseRawJson,
    );
    const offlineRecord = createOfflineJsonHealthProbeDigestRecord(
      requestRawJson,
      responseRawJson,
    );
    expect({
      requestSha256: workerRecord.requestSha256,
      responseSha256: workerRecord.responseSha256,
      requestCompatibilitySha256: workerRecord.requestCompatibilitySha256,
      responseCompatibilitySha256: workerRecord.responseCompatibilitySha256,
    }).toEqual(offlineRecord);
    expect(workerRecord.requestByteLength).toBe(
      new TextEncoder().encode(requestRawJson).byteLength,
    );
    expect(workerRecord.responseByteLength).toBe(
      new TextEncoder().encode(responseRawJson).byteLength,
    );
  });
});

describe("Controller JSON compatibility probe result", () => {
  test("accepts a completed JSON-only result and verifies every retained digest", async () => {
    const result = await validResult();
    expect(parseJsonCompatibilityProbeResultV1(result)).toEqual(result);
    await expect(verifyJsonCompatibilityProbeResultDigests(result)).resolves.toEqual(
      result,
    );
  });

  test("rejects readiness identity/gate drift and any side effect", async () => {
    const wrongBuild = await validResult();
    wrongBuild.readiness.runtimeBuildIdSha256 = "66".repeat(32);
    expect(() => parseJsonCompatibilityProbeResultV1(wrongBuild)).toThrow(
      /expected runtime build ID/,
    );

    const executionEnabled = await validResult();
    executionEnabled.readiness.executionEnabled = true;
    expect(() => parseJsonCompatibilityProbeResultV1(executionEnabled)).toThrow(
      /execution gate must equal false/,
    );

    const providerMutation = await validResult();
    providerMutation.sideEffects.providerRequestCount = 1;
    expect(() => parseJsonCompatibilityProbeResultV1(providerMutation)).toThrow(
      /providerRequestCount must equal 0/,
    );
  });

  test("rejects response fields, identity mismatch, timestamp disorder, and digest tampering", async () => {
    const extraResponseField = await validResult();
    extraResponseField.healthProbe.responseRawJson = JSON.stringify({
      ...JSON.parse(extraResponseField.healthProbe.responseRawJson),
      result: null,
    });
    extraResponseField.healthProbe.responseByteLength = new TextEncoder().encode(
      extraResponseField.healthProbe.responseRawJson,
    ).byteLength;
    expect(() => parseJsonCompatibilityProbeResultV1(extraResponseField)).toThrow(
      /fields must be exactly/,
    );

    const wrongIdentity = await validResult();
    const response = JSON.parse(wrongIdentity.healthProbe.responseRawJson);
    response.operation_id = "different-operation";
    wrongIdentity.healthProbe.responseRawJson = JSON.stringify(response);
    wrongIdentity.healthProbe.responseByteLength = new TextEncoder().encode(
      wrongIdentity.healthProbe.responseRawJson,
    ).byteLength;
    expect(() => parseJsonCompatibilityProbeResultV1(wrongIdentity)).toThrow(
      /operation ID must equal/,
    );

    const timeTravel = await validResult();
    timeTravel.completedAt = "2026-08-03T23:59:59Z";
    expect(() => parseJsonCompatibilityProbeResultV1(timeTravel)).toThrow(
      /requestedAt <= startedAt <= completedAt/,
    );

    const digestTampering = await validResult();
    digestTampering.healthProbe.responseSha256 = "77".repeat(32);
    await expect(
      verifyJsonCompatibilityProbeResultDigests(digestTampering),
    ).rejects.toThrow(/responseSha256 does not match/);
  });

  test("rejects oversized retained response JSON before digesting", async () => {
    const result = await validResult();
    result.healthProbe.responseRawJson = JSON.stringify({
      protocol_version: 1,
      operation_id: result.request.operation.operationId,
      status: "completed",
      trace_id: result.request.operation.traceId,
      padding: "x".repeat(MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES),
    });
    result.healthProbe.responseByteLength = new TextEncoder().encode(
      result.healthProbe.responseRawJson,
    ).byteLength;
    expect(() => parseJsonCompatibilityProbeResultV1(result)).toThrow(
      /4096 characters|byte limit/,
    );
  });
});
