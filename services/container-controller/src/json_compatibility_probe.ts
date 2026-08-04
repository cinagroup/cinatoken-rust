export const JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-probe-request-v1";
export const JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT =
  "cinatoken-container-runtime-json-probe-result-v1";

export const JSON_COMPATIBILITY_PROBE_PHASE_IDS = Object.freeze([
  "baseline-n-minus-one",
  "mixed-n-n-minus-one",
  "candidate-n",
  "rollback-n-minus-one",
] as const);

export const JSON_COMPATIBILITY_PROBE_RUNTIME_GENERATIONS = Object.freeze([
  "n",
  "n-minus-one",
] as const);

export const JSON_COMPATIBILITY_PROBE_SHARD_COUNT = 8 as const;
export const JSON_COMPATIBILITY_PROBE_CONTENT_TYPE = "application/json" as const;
export const JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const MAX_JSON_COMPATIBILITY_PROBE_REQUEST_BYTES = 16 * 1024;
export const MAX_JSON_COMPATIBILITY_PROBE_RESULT_BYTES = 64 * 1024;
export const MAX_JSON_COMPATIBILITY_READINESS_BYTES = 4 * 1024;
export const MAX_JSON_COMPATIBILITY_WIRE_REQUEST_BYTES = 8 * 1024;
export const MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES = 4 * 1024;
export const MAX_JSON_COMPATIBILITY_EXECUTION_WINDOW_SECONDS = 300;
export const MAX_JSON_COMPATIBILITY_OWNER_LEASE_WINDOW_SECONDS = 600;

const CONTROLLER_SERVICE_NAME = "cinatoken-container-controller-staging";
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_BOUNDED_JSON_BYTES = 1024 * 1024;

export type JsonCompatibilityProbePhaseId =
  (typeof JSON_COMPATIBILITY_PROBE_PHASE_IDS)[number];
export type JsonCompatibilityProbePhaseOrdinal = 1 | 2 | 3 | 4;
export type JsonCompatibilityProbeRuntimeGeneration =
  (typeof JSON_COMPATIBILITY_PROBE_RUNTIME_GENERATIONS)[number];

export interface JsonCompatibilityProbeShardV1 {
  readonly contractVersion: 1;
  readonly ringGeneration: number;
  readonly shardCount: 8;
  readonly shardIndex: number;
  readonly instanceName: string;
}

export interface JsonCompatibilityProbeOperationV1 {
  readonly operationId: string;
  readonly ownerGeneration: number;
  readonly ownerLeaseExpiresAt: number;
  readonly executionDeadlineAt: number;
  readonly providerOperationId: string;
  readonly admissionSha256: string;
  readonly traceId: string;
}

export interface JsonCompatibilityProbeRequestV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT;
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseId: JsonCompatibilityProbePhaseId;
  readonly phaseOrdinal: JsonCompatibilityProbePhaseOrdinal;
  readonly candidateShardIndex: number;
  readonly controllerServiceName: typeof CONTROLLER_SERVICE_NAME;
  readonly controllerVersionId: string;
  readonly runtimeGeneration: JsonCompatibilityProbeRuntimeGeneration;
  readonly expectedRuntimeBuildIdSha256: string;
  readonly requestedAt: string;
  readonly shard: JsonCompatibilityProbeShardV1;
  readonly operation: JsonCompatibilityProbeOperationV1;
}

export interface JsonHealthProbeWireRequestV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly operation_kind: "health_probe";
  readonly owner_generation: number;
  readonly owner_lease_expires_at: number;
  readonly execution_deadline_at: number;
  readonly provider_operation_id: string;
  readonly admission_sha256: string;
  readonly input: {
    readonly mode: "inline";
    readonly sha256: typeof JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256;
    readonly size: 0;
    readonly content_type: typeof JSON_COMPATIBILITY_PROBE_CONTENT_TYPE;
  };
  readonly shard: {
    readonly contract_version: 1;
    readonly ring_generation: number;
    readonly shard_count: 8;
    readonly shard_index: number;
    readonly instance_name: string;
  };
  readonly trace_id: string;
}

export interface JsonHealthProbeWireResponseV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
  readonly status: "completed";
  readonly trace_id: string;
}

export interface JsonCompatibilityProbeReadinessV1 {
  readonly statusCode: 200;
  readonly contentType: typeof JSON_COMPATIBILITY_PROBE_CONTENT_TYPE;
  readonly rawJson: string;
  readonly rawByteLength: number;
  readonly rawSha256: string;
  readonly runtimeBuildIdSha256: string;
  readonly protocolVersion: 1;
  readonly shardContractVersion: 1;
  readonly executionEnabled: false;
}

export interface JsonCompatibilityProbeHealthObservationV1 {
  readonly operationKind: "health_probe";
  readonly statusCode: 200;
  readonly requestContentType: typeof JSON_COMPATIBILITY_PROBE_CONTENT_TYPE;
  readonly responseContentType: typeof JSON_COMPATIBILITY_PROBE_CONTENT_TYPE;
  readonly requestRawJson: string;
  readonly responseRawJson: string;
  readonly requestByteLength: number;
  readonly responseByteLength: number;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly requestCompatibilitySha256: string;
  readonly responseCompatibilitySha256: string;
  readonly selectedTransport: "json";
  readonly effectiveTransport: "json";
  readonly attemptCount: 1;
  readonly legacyJsonFallbackCount: 0;
  readonly outcome: "completed";
  readonly recoveryRequired: false;
}

export interface JsonCompatibilityProbeSideEffectsV1 {
  readonly providerRequestCount: 0;
  readonly billingMutationCount: 0;
  readonly storageGatewayMutationCount: 0;
  readonly productionTrafficRequestCount: 0;
  readonly publicProbeRequestCount: 0;
}

export interface JsonCompatibilityProbeResultV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT;
  readonly request: JsonCompatibilityProbeRequestV1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly readiness: JsonCompatibilityProbeReadinessV1;
  readonly healthProbe: JsonCompatibilityProbeHealthObservationV1;
  readonly sideEffects: JsonCompatibilityProbeSideEffectsV1;
}

export interface BoundedRawJsonObject {
  readonly rawJson: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly value: Record<string, unknown>;
}

export interface BoundedRawJsonDigest {
  readonly rawJson: string;
  readonly byteLength: number;
  readonly rawSha256: string;
  readonly canonicalSha256: string;
}

export interface JsonHealthProbeDigestRecord {
  readonly requestByteLength: number;
  readonly responseByteLength: number;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly requestCompatibilitySha256: string;
  readonly responseCompatibilitySha256: string;
}

export class JsonCompatibilityProbeProtocolError extends Error {
  constructor(
    readonly code: "invalid_probe_request" | "invalid_probe_result" | "invalid_raw_json",
    message: string,
  ) {
    super(message);
    this.name = "JsonCompatibilityProbeProtocolError";
  }
}

export function parseJsonCompatibilityProbeRequestV1(
  input: unknown,
): JsonCompatibilityProbeRequestV1 {
  const code = "invalid_probe_request";
  const value = requireRecord(input, "probe request", code);
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseId",
    "phaseOrdinal",
    "candidateShardIndex",
    "controllerServiceName",
    "controllerVersionId",
    "runtimeGeneration",
    "expectedRuntimeBuildIdSha256",
    "requestedAt",
    "shard",
    "operation",
  ], "probe request", code);

  requireEqual(value.schemaVersion, 1, "probe request schema version", code);
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
    "probe request contract",
    code,
  );
  requireEqual(value.environment, "staging", "probe request environment", code);
  const campaignIdSha256 = requireSha256(
    value.campaignIdSha256,
    "probe request campaign ID",
    code,
  );
  const planDigestSha256 = requireSha256(
    value.planDigestSha256,
    "probe request plan digest",
    code,
  );
  const phaseId = requirePhaseId(value.phaseId, "probe request phase ID", code);
  const phaseOrdinal = requireInteger(
    value.phaseOrdinal,
    1,
    4,
    "probe request phase ordinal",
    code,
  ) as JsonCompatibilityProbePhaseOrdinal;
  const expectedOrdinal = JSON_COMPATIBILITY_PROBE_PHASE_IDS.indexOf(phaseId) + 1;
  if (phaseOrdinal !== expectedOrdinal) {
    throw protocolError(code, "probe request phase ordinal does not match phase ID");
  }

  const candidateShardIndex = requireInteger(
    value.candidateShardIndex,
    0,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT - 1,
    "probe request candidate shard index",
    code,
  );
  requireEqual(
    value.controllerServiceName,
    CONTROLLER_SERVICE_NAME,
    "probe request Controller service name",
    code,
  );
  const controllerVersionId = requireSafeToken(
    value.controllerVersionId,
    "probe request Controller version ID",
    code,
  );
  const runtimeGeneration = requireRuntimeGeneration(
    value.runtimeGeneration,
    "probe request runtime generation",
    code,
  );
  const expectedRuntimeBuildIdSha256 = requireSha256(
    value.expectedRuntimeBuildIdSha256,
    "probe request expected runtime build ID",
    code,
  );
  const requestedAt = requireWholeSecondUtc(
    value.requestedAt,
    "probe request requested time",
    code,
  );
  const requestedAtSeconds = Math.floor(Date.parse(requestedAt) / 1000);
  const shard = parseProbeShard(value.shard, "probe request shard", code);
  const operation = parseProbeOperation(
    value.operation,
    requestedAtSeconds,
    "probe request operation",
    code,
  );

  const expectedRuntime = expectedRuntimeGenerationForProbe(
    phaseId,
    candidateShardIndex,
    shard.shardIndex,
  );
  if (runtimeGeneration !== expectedRuntime) {
    throw protocolError(
      code,
      `probe request runtime generation must be ${expectedRuntime} for phase ${phaseId} shard ${shard.shardIndex}`,
    );
  }

  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
    environment: "staging",
    campaignIdSha256,
    planDigestSha256,
    phaseId,
    phaseOrdinal,
    candidateShardIndex,
    controllerServiceName: CONTROLLER_SERVICE_NAME,
    controllerVersionId,
    runtimeGeneration,
    expectedRuntimeBuildIdSha256,
    requestedAt,
    shard,
    operation,
  };
}

export function parseJsonCompatibilityProbeRequestJson(
  source: string | Uint8Array,
): JsonCompatibilityProbeRequestV1 {
  return parseJsonCompatibilityProbeRequestV1(
    parseBoundedRawJsonObject(
      source,
      MAX_JSON_COMPATIBILITY_PROBE_REQUEST_BYTES,
      "probe request JSON",
    ).value,
  );
}

export function expectedRuntimeGenerationForProbe(
  phaseId: JsonCompatibilityProbePhaseId,
  candidateShardIndex: number,
  shardIndex: number,
): JsonCompatibilityProbeRuntimeGeneration {
  const code = "invalid_probe_request";
  requirePhaseId(phaseId, "probe phase ID", code);
  requireInteger(
    candidateShardIndex,
    0,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT - 1,
    "probe candidate shard index",
    code,
  );
  requireInteger(
    shardIndex,
    0,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT - 1,
    "probe shard index",
    code,
  );
  switch (phaseId) {
    case "baseline-n-minus-one":
    case "rollback-n-minus-one":
      return "n-minus-one";
    case "mixed-n-n-minus-one":
      return shardIndex === candidateShardIndex ? "n" : "n-minus-one";
    case "candidate-n":
      return "n";
  }
}

export function buildJsonHealthProbeWireRequest(
  input: unknown,
): JsonHealthProbeWireRequestV1 {
  const request = parseJsonCompatibilityProbeRequestV1(input);
  return {
    protocol_version: 1,
    operation_id: request.operation.operationId,
    operation_kind: "health_probe",
    owner_generation: request.operation.ownerGeneration,
    owner_lease_expires_at: request.operation.ownerLeaseExpiresAt,
    execution_deadline_at: request.operation.executionDeadlineAt,
    provider_operation_id: request.operation.providerOperationId,
    admission_sha256: request.operation.admissionSha256,
    input: {
      mode: "inline",
      sha256: JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256,
      size: 0,
      content_type: JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    },
    shard: {
      contract_version: 1,
      ring_generation: request.shard.ringGeneration,
      shard_count: JSON_COMPATIBILITY_PROBE_SHARD_COUNT,
      shard_index: request.shard.shardIndex,
      instance_name: request.shard.instanceName,
    },
    trace_id: request.operation.traceId,
  };
}

export function serializeJsonHealthProbeWireRequest(input: unknown): string {
  const rawJson = JSON.stringify(buildJsonHealthProbeWireRequest(input));
  parseBoundedRawJsonObject(
    rawJson,
    MAX_JSON_COMPATIBILITY_WIRE_REQUEST_BYTES,
    "health probe wire request",
  );
  return rawJson;
}

export function parseJsonCompatibilityProbeResultV1(
  input: unknown,
): JsonCompatibilityProbeResultV1 {
  const code = "invalid_probe_result";
  const value = requireRecord(input, "probe result", code);
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "request",
    "startedAt",
    "completedAt",
    "readiness",
    "healthProbe",
    "sideEffects",
  ], "probe result", code);
  requireEqual(value.schemaVersion, 1, "probe result schema version", code);
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT,
    "probe result contract",
    code,
  );

  let request: JsonCompatibilityProbeRequestV1;
  try {
    request = parseJsonCompatibilityProbeRequestV1(value.request);
  } catch (error) {
    if (error instanceof JsonCompatibilityProbeProtocolError) {
      throw protocolError(code, `probe result request is invalid: ${error.message}`);
    }
    throw error;
  }
  const startedAt = requireWholeSecondUtc(
    value.startedAt,
    "probe result start time",
    code,
  );
  const completedAt = requireWholeSecondUtc(
    value.completedAt,
    "probe result completion time",
    code,
  );
  const requestedAtMs = Date.parse(request.requestedAt);
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (
    startedAtMs < requestedAtMs ||
    completedAtMs < startedAtMs ||
    completedAtMs > request.operation.executionDeadlineAt * 1000
  ) {
    throw protocolError(
      code,
      "probe result timestamps must satisfy requestedAt <= startedAt <= completedAt <= executionDeadlineAt",
    );
  }

  const readiness = parseReadinessObservation(value.readiness, request, code);
  const healthProbe = parseHealthObservation(value.healthProbe, request, code);
  const sideEffects = parseSideEffects(value.sideEffects, code);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PROBE_RESULT_CONTRACT,
    request,
    startedAt,
    completedAt,
    readiness,
    healthProbe,
    sideEffects,
  };
}

export function parseJsonCompatibilityProbeResultJson(
  source: string | Uint8Array,
): JsonCompatibilityProbeResultV1 {
  return parseJsonCompatibilityProbeResultV1(
    parseBoundedRawJsonObject(
      source,
      MAX_JSON_COMPATIBILITY_PROBE_RESULT_BYTES,
      "probe result JSON",
    ).value,
  );
}

export async function verifyJsonCompatibilityProbeResultDigests(
  input: unknown,
): Promise<JsonCompatibilityProbeResultV1> {
  const result = parseJsonCompatibilityProbeResultV1(input);
  const readinessDigest = await digestBoundedRawJsonObject(
    result.readiness.rawJson,
    MAX_JSON_COMPATIBILITY_READINESS_BYTES,
    "probe readiness JSON",
  );
  if (readinessDigest.rawSha256 !== result.readiness.rawSha256) {
    throw protocolError(
      "invalid_probe_result",
      "probe readiness raw SHA-256 does not match retained JSON",
    );
  }

  const probeDigest = await createJsonHealthProbeDigestRecord(
    result.healthProbe.requestRawJson,
    result.healthProbe.responseRawJson,
  );
  for (const field of [
    "requestSha256",
    "responseSha256",
    "requestCompatibilitySha256",
    "responseCompatibilitySha256",
  ] as const) {
    if (probeDigest[field] !== result.healthProbe[field]) {
      throw protocolError(
        "invalid_probe_result",
        `probe health ${field} does not match retained JSON`,
      );
    }
  }
  return result;
}

export function parseBoundedRawJsonObject(
  source: string | Uint8Array,
  maxBytes: number,
  label = "raw JSON",
): BoundedRawJsonObject {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BOUNDED_JSON_BYTES
  ) {
    throw protocolError(
      "invalid_raw_json",
      `${label} byte limit must be an integer from 1 through ${MAX_BOUNDED_JSON_BYTES}`,
    );
  }
  const bytes = normalizeUtf8Bytes(source, label);
  if (bytes.byteLength === 0) {
    throw protocolError("invalid_raw_json", `${label} must not be empty`);
  }
  if (bytes.byteLength > maxBytes) {
    throw protocolError(
      "invalid_raw_json",
      `${label} exceeds the ${maxBytes}-byte limit`,
    );
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw protocolError("invalid_raw_json", `${label} must not contain a UTF-8 BOM`);
  }

  let rawJson: string;
  try {
    rawJson = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw protocolError("invalid_raw_json", `${label} must be valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    throw protocolError("invalid_raw_json", `${label} must be valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw protocolError("invalid_raw_json", `${label} must contain a JSON object`);
  }
  return {
    rawJson,
    bytes,
    byteLength: bytes.byteLength,
    value: parsed,
  };
}

export async function digestBoundedRawJsonObject(
  source: string | Uint8Array,
  maxBytes: number,
  label = "raw JSON",
): Promise<BoundedRawJsonDigest> {
  const parsed = parseBoundedRawJsonObject(source, maxBytes, label);
  const [rawSha256, canonicalSha256] = await Promise.all([
    sha256Hex(parsed.bytes),
    sha256Hex(canonicalJson(parsed.value)),
  ]);
  return {
    rawJson: parsed.rawJson,
    byteLength: parsed.byteLength,
    rawSha256,
    canonicalSha256,
  };
}

export async function createJsonHealthProbeDigestRecord(
  requestSource: string | Uint8Array,
  responseSource: string | Uint8Array,
): Promise<JsonHealthProbeDigestRecord> {
  const requestDocument = parseBoundedRawJsonObject(
    requestSource,
    MAX_JSON_COMPATIBILITY_WIRE_REQUEST_BYTES,
    "health probe wire request",
  );
  const responseDocument = parseBoundedRawJsonObject(
    responseSource,
    MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES,
    "health probe wire response",
  );
  const request = parseHealthProbeWireRequest(requestDocument.value);
  const response = parseHealthProbeWireResponse(responseDocument.value, request);
  const requestProjection = {
    ...request,
    operation_id: "<operation-id>",
    owner_generation: 0,
    owner_lease_expires_at: 0,
    execution_deadline_at: 0,
    provider_operation_id: "<provider-operation-id>",
    admission_sha256: "<admission-sha256>",
    trace_id: "<trace-id>",
  };
  const responseProjection = {
    ...response,
    operation_id: "<operation-id>",
    trace_id: "<trace-id>",
  };
  const [
    requestSha256,
    responseSha256,
    requestCompatibilitySha256,
    responseCompatibilitySha256,
  ] = await Promise.all([
    sha256Hex(requestDocument.bytes),
    sha256Hex(responseDocument.bytes),
    sha256Hex(canonicalJson(requestProjection)),
    sha256Hex(canonicalJson(responseProjection)),
  ]);
  return {
    requestByteLength: requestDocument.byteLength,
    responseByteLength: responseDocument.byteLength,
    requestSha256,
    responseSha256,
    requestCompatibilitySha256,
    responseCompatibilitySha256,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>()));
}

export async function sha256Hex(source: string | Uint8Array): Promise<string> {
  const bytes = typeof source === "string"
    ? new TextEncoder().encode(source)
    : copyBytes(source);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const parseJsonCompatibilityProbeRequest =
  parseJsonCompatibilityProbeRequestV1;
export const parseJsonCompatibilityProbeResult =
  parseJsonCompatibilityProbeResultV1;

function parseProbeShard(
  input: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeShardV1 {
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "contractVersion",
    "ringGeneration",
    "shardCount",
    "shardIndex",
    "instanceName",
  ], label, code);
  requireEqual(value.contractVersion, 1, `${label} contract version`, code);
  const ringGeneration = requireInteger(
    value.ringGeneration,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} ring generation`,
    code,
  );
  requireEqual(
    value.shardCount,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT,
    `${label} shard count`,
    code,
  );
  const shardIndex = requireInteger(
    value.shardIndex,
    0,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT - 1,
    `${label} shard index`,
    code,
  );
  const instanceName = requireSafeToken(value.instanceName, `${label} instance name`, code);
  const expectedInstanceName = shardInstanceName(shardIndex);
  if (instanceName !== expectedInstanceName) {
    throw protocolError(
      code,
      `${label} instance name must equal ${expectedInstanceName}`,
    );
  }
  return {
    contractVersion: 1,
    ringGeneration,
    shardCount: JSON_COMPATIBILITY_PROBE_SHARD_COUNT,
    shardIndex,
    instanceName,
  };
}

function parseProbeOperation(
  input: unknown,
  requestedAtSeconds: number,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeOperationV1 {
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "operationId",
    "ownerGeneration",
    "ownerLeaseExpiresAt",
    "executionDeadlineAt",
    "providerOperationId",
    "admissionSha256",
    "traceId",
  ], label, code);
  const operationId = requireSafeToken(value.operationId, `${label} ID`, code);
  const ownerGeneration = requireInteger(
    value.ownerGeneration,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} owner generation`,
    code,
  );
  const ownerLeaseExpiresAt = requireInteger(
    value.ownerLeaseExpiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} owner lease expiry`,
    code,
  );
  const executionDeadlineAt = requireInteger(
    value.executionDeadlineAt,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} execution deadline`,
    code,
  );
  if (
    executionDeadlineAt <= requestedAtSeconds ||
    executionDeadlineAt > ownerLeaseExpiresAt
  ) {
    throw protocolError(
      code,
      `${label} deadlines must satisfy requestedAt < executionDeadlineAt <= ownerLeaseExpiresAt`,
    );
  }
  if (
    executionDeadlineAt - requestedAtSeconds >
    MAX_JSON_COMPATIBILITY_EXECUTION_WINDOW_SECONDS
  ) {
    throw protocolError(
      code,
      `${label} execution deadline exceeds the bounded probe window`,
    );
  }
  if (
    ownerLeaseExpiresAt - requestedAtSeconds >
    MAX_JSON_COMPATIBILITY_OWNER_LEASE_WINDOW_SECONDS
  ) {
    throw protocolError(
      code,
      `${label} owner lease exceeds the bounded probe window`,
    );
  }
  return {
    operationId,
    ownerGeneration,
    ownerLeaseExpiresAt,
    executionDeadlineAt,
    providerOperationId: requireSafeToken(
      value.providerOperationId,
      `${label} provider operation ID`,
      code,
    ),
    admissionSha256: requireSha256(
      value.admissionSha256,
      `${label} admission digest`,
      code,
    ),
    traceId: requireSafeToken(value.traceId, `${label} trace ID`, code),
  };
}

function parseReadinessObservation(
  input: unknown,
  request: JsonCompatibilityProbeRequestV1,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeReadinessV1 {
  const label = "probe result readiness";
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "statusCode",
    "contentType",
    "rawJson",
    "rawByteLength",
    "rawSha256",
    "runtimeBuildIdSha256",
    "protocolVersion",
    "shardContractVersion",
    "executionEnabled",
  ], label, code);
  requireEqual(value.statusCode, 200, `${label} status`, code);
  requireEqual(
    value.contentType,
    JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    `${label} content type`,
    code,
  );
  const rawJson = requireString(value.rawJson, 1, MAX_JSON_COMPATIBILITY_READINESS_BYTES, `${label} raw JSON`, code);
  const document = parseBoundedRawJsonForResult(
    rawJson,
    MAX_JSON_COMPATIBILITY_READINESS_BYTES,
    `${label} raw JSON`,
  );
  requireEqual(value.rawByteLength, document.byteLength, `${label} byte length`, code);
  const rawSha256 = requireSha256(value.rawSha256, `${label} raw digest`, code);
  const runtimeBuildIdSha256 = requireSha256(
    value.runtimeBuildIdSha256,
    `${label} runtime build ID`,
    code,
  );
  requireEqual(
    runtimeBuildIdSha256,
    request.expectedRuntimeBuildIdSha256,
    `${label} expected runtime build ID`,
    code,
  );
  requireEqual(value.protocolVersion, 1, `${label} protocol version`, code);
  requireEqual(value.shardContractVersion, 1, `${label} shard contract version`, code);
  requireEqual(value.executionEnabled, false, `${label} execution gate`, code);

  const wire = document.value;
  requireExactKeys(wire, [
    "status",
    "protocol_version",
    "runtime_build_id",
    "shard_contract_version",
    "execution_enabled",
  ], `${label} wire body`, code);
  requireEqual(wire.status, "ready", `${label} wire status`, code);
  requireEqual(wire.protocol_version, 1, `${label} wire protocol version`, code);
  requireEqual(
    wire.runtime_build_id,
    runtimeBuildIdSha256,
    `${label} wire runtime build ID`,
    code,
  );
  requireEqual(
    wire.shard_contract_version,
    1,
    `${label} wire shard contract version`,
    code,
  );
  requireEqual(wire.execution_enabled, false, `${label} wire execution gate`, code);
  return {
    statusCode: 200,
    contentType: JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    rawJson,
    rawByteLength: document.byteLength,
    rawSha256,
    runtimeBuildIdSha256,
    protocolVersion: 1,
    shardContractVersion: 1,
    executionEnabled: false,
  };
}

function parseHealthObservation(
  input: unknown,
  request: JsonCompatibilityProbeRequestV1,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeHealthObservationV1 {
  const label = "probe result health probe";
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "operationKind",
    "statusCode",
    "requestContentType",
    "responseContentType",
    "requestRawJson",
    "responseRawJson",
    "requestByteLength",
    "responseByteLength",
    "requestSha256",
    "responseSha256",
    "requestCompatibilitySha256",
    "responseCompatibilitySha256",
    "selectedTransport",
    "effectiveTransport",
    "attemptCount",
    "legacyJsonFallbackCount",
    "outcome",
    "recoveryRequired",
  ], label, code);
  requireEqual(value.operationKind, "health_probe", `${label} operation kind`, code);
  requireEqual(value.statusCode, 200, `${label} status`, code);
  requireEqual(
    value.requestContentType,
    JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    `${label} request content type`,
    code,
  );
  requireEqual(
    value.responseContentType,
    JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    `${label} response content type`,
    code,
  );
  const requestRawJson = requireString(
    value.requestRawJson,
    1,
    MAX_JSON_COMPATIBILITY_WIRE_REQUEST_BYTES,
    `${label} request raw JSON`,
    code,
  );
  const responseRawJson = requireString(
    value.responseRawJson,
    1,
    MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES,
    `${label} response raw JSON`,
    code,
  );
  const requestDocument = parseBoundedRawJsonForResult(
    requestRawJson,
    MAX_JSON_COMPATIBILITY_WIRE_REQUEST_BYTES,
    `${label} request raw JSON`,
  );
  const responseDocument = parseBoundedRawJsonForResult(
    responseRawJson,
    MAX_JSON_COMPATIBILITY_WIRE_RESPONSE_BYTES,
    `${label} response raw JSON`,
  );
  const wireRequest = parseHealthProbeWireRequest(requestDocument.value, code);
  const expectedRequest = buildJsonHealthProbeWireRequest(request);
  if (canonicalJson(wireRequest) !== canonicalJson(expectedRequest)) {
    throw protocolError(code, `${label} request does not match probe request identity`);
  }
  parseHealthProbeWireResponse(responseDocument.value, wireRequest, code);
  requireEqual(
    value.requestByteLength,
    requestDocument.byteLength,
    `${label} request byte length`,
    code,
  );
  requireEqual(
    value.responseByteLength,
    responseDocument.byteLength,
    `${label} response byte length`,
    code,
  );
  const requestSha256 = requireSha256(value.requestSha256, `${label} request digest`, code);
  const responseSha256 = requireSha256(value.responseSha256, `${label} response digest`, code);
  const requestCompatibilitySha256 = requireSha256(
    value.requestCompatibilitySha256,
    `${label} request compatibility digest`,
    code,
  );
  const responseCompatibilitySha256 = requireSha256(
    value.responseCompatibilitySha256,
    `${label} response compatibility digest`,
    code,
  );
  requireEqual(value.selectedTransport, "json", `${label} selected transport`, code);
  requireEqual(value.effectiveTransport, "json", `${label} effective transport`, code);
  requireEqual(value.attemptCount, 1, `${label} attempt count`, code);
  requireEqual(value.legacyJsonFallbackCount, 0, `${label} fallback count`, code);
  requireEqual(value.outcome, "completed", `${label} outcome`, code);
  requireEqual(value.recoveryRequired, false, `${label} recovery flag`, code);
  return {
    operationKind: "health_probe",
    statusCode: 200,
    requestContentType: JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    responseContentType: JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    requestRawJson,
    responseRawJson,
    requestByteLength: requestDocument.byteLength,
    responseByteLength: responseDocument.byteLength,
    requestSha256,
    responseSha256,
    requestCompatibilitySha256,
    responseCompatibilitySha256,
    selectedTransport: "json",
    effectiveTransport: "json",
    attemptCount: 1,
    legacyJsonFallbackCount: 0,
    outcome: "completed",
    recoveryRequired: false,
  };
}

function parseSideEffects(
  input: unknown,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeSideEffectsV1 {
  const label = "probe result side effects";
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ], label, code);
  for (const field of [
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ] as const) {
    requireEqual(value[field], 0, `${label} ${field}`, code);
  }
  return {
    providerRequestCount: 0,
    billingMutationCount: 0,
    storageGatewayMutationCount: 0,
    productionTrafficRequestCount: 0,
    publicProbeRequestCount: 0,
  };
}

function parseHealthProbeWireRequest(
  input: unknown,
  code: JsonCompatibilityProbeProtocolError["code"] = "invalid_raw_json",
): JsonHealthProbeWireRequestV1 {
  const label = "health probe wire request";
  const value = requireRecord(input, label, code);
  requireExactKeys(value, [
    "protocol_version",
    "operation_id",
    "operation_kind",
    "owner_generation",
    "owner_lease_expires_at",
    "execution_deadline_at",
    "provider_operation_id",
    "admission_sha256",
    "input",
    "shard",
    "trace_id",
  ], label, code);
  requireEqual(value.protocol_version, 1, `${label} protocol version`, code);
  const operationId = requireSafeToken(value.operation_id, `${label} operation ID`, code);
  requireEqual(value.operation_kind, "health_probe", `${label} operation kind`, code);
  const ownerGeneration = requireInteger(
    value.owner_generation,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} owner generation`,
    code,
  );
  const ownerLeaseExpiresAt = requireInteger(
    value.owner_lease_expires_at,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} owner lease expiry`,
    code,
  );
  const executionDeadlineAt = requireInteger(
    value.execution_deadline_at,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} execution deadline`,
    code,
  );
  if (executionDeadlineAt > ownerLeaseExpiresAt) {
    throw protocolError(code, `${label} execution deadline exceeds owner lease`);
  }
  const providerOperationId = requireSafeToken(
    value.provider_operation_id,
    `${label} provider operation ID`,
    code,
  );
  const admissionSha256 = requireSha256(
    value.admission_sha256,
    `${label} admission digest`,
    code,
  );
  const inputValue = requireRecord(value.input, `${label} input`, code);
  requireExactKeys(
    inputValue,
    ["mode", "sha256", "size", "content_type"],
    `${label} input`,
    code,
  );
  requireEqual(inputValue.mode, "inline", `${label} input mode`, code);
  requireEqual(
    inputValue.sha256,
    JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256,
    `${label} empty input digest`,
    code,
  );
  requireEqual(inputValue.size, 0, `${label} input size`, code);
  requireEqual(
    inputValue.content_type,
    JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    `${label} input content type`,
    code,
  );

  const shardValue = requireRecord(value.shard, `${label} shard`, code);
  requireExactKeys(shardValue, [
    "contract_version",
    "ring_generation",
    "shard_count",
    "shard_index",
    "instance_name",
  ], `${label} shard`, code);
  requireEqual(shardValue.contract_version, 1, `${label} shard contract version`, code);
  const ringGeneration = requireInteger(
    shardValue.ring_generation,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} ring generation`,
    code,
  );
  requireEqual(
    shardValue.shard_count,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT,
    `${label} shard count`,
    code,
  );
  const shardIndex = requireInteger(
    shardValue.shard_index,
    0,
    JSON_COMPATIBILITY_PROBE_SHARD_COUNT - 1,
    `${label} shard index`,
    code,
  );
  const instanceName = requireSafeToken(
    shardValue.instance_name,
    `${label} instance name`,
    code,
  );
  requireEqual(
    instanceName,
    shardInstanceName(shardIndex),
    `${label} instance name`,
    code,
  );
  const traceId = requireSafeToken(value.trace_id, `${label} trace ID`, code);
  return {
    protocol_version: 1,
    operation_id: operationId,
    operation_kind: "health_probe",
    owner_generation: ownerGeneration,
    owner_lease_expires_at: ownerLeaseExpiresAt,
    execution_deadline_at: executionDeadlineAt,
    provider_operation_id: providerOperationId,
    admission_sha256: admissionSha256,
    input: {
      mode: "inline",
      sha256: JSON_COMPATIBILITY_PROBE_EMPTY_INPUT_SHA256,
      size: 0,
      content_type: JSON_COMPATIBILITY_PROBE_CONTENT_TYPE,
    },
    shard: {
      contract_version: 1,
      ring_generation: ringGeneration,
      shard_count: JSON_COMPATIBILITY_PROBE_SHARD_COUNT,
      shard_index: shardIndex,
      instance_name: instanceName,
    },
    trace_id: traceId,
  };
}

function parseHealthProbeWireResponse(
  input: unknown,
  request: JsonHealthProbeWireRequestV1,
  code: JsonCompatibilityProbeProtocolError["code"] = "invalid_raw_json",
): JsonHealthProbeWireResponseV1 {
  const label = "health probe wire response";
  const value = requireRecord(input, label, code);
  requireExactKeys(
    value,
    ["protocol_version", "operation_id", "status", "trace_id"],
    label,
    code,
  );
  requireEqual(value.protocol_version, 1, `${label} protocol version`, code);
  requireEqual(value.operation_id, request.operation_id, `${label} operation ID`, code);
  requireEqual(value.status, "completed", `${label} status`, code);
  requireEqual(value.trace_id, request.trace_id, `${label} trace ID`, code);
  return {
    protocol_version: 1,
    operation_id: request.operation_id,
    status: "completed",
    trace_id: request.trace_id,
  };
}

function parseBoundedRawJsonForResult(
  source: string | Uint8Array,
  maxBytes: number,
  label: string,
): BoundedRawJsonObject {
  try {
    return parseBoundedRawJsonObject(source, maxBytes, label);
  } catch (error) {
    if (error instanceof JsonCompatibilityProbeProtocolError) {
      throw protocolError("invalid_probe_result", error.message);
    }
    throw error;
  }
}

function shardInstanceName(shardIndex: number): string {
  return `cinatoken-relay-shard-v1-${shardIndex.toString().padStart(4, "0")}`;
}

function requirePhaseId(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbePhaseId {
  if (
    typeof value !== "string" ||
    !JSON_COMPATIBILITY_PROBE_PHASE_IDS.includes(
      value as JsonCompatibilityProbePhaseId,
    )
  ) {
    throw protocolError(code, `${label} is not an approved compatibility phase`);
  }
  return value as JsonCompatibilityProbePhaseId;
}

function requireRuntimeGeneration(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): JsonCompatibilityProbeRuntimeGeneration {
  if (
    typeof value !== "string" ||
    !JSON_COMPATIBILITY_PROBE_RUNTIME_GENERATIONS.includes(
      value as JsonCompatibilityProbeRuntimeGeneration,
    )
  ) {
    throw protocolError(code, `${label} must be n or n-minus-one`);
  }
  return value as JsonCompatibilityProbeRuntimeGeneration;
}

function requireWholeSecondUtc(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): string {
  if (typeof value !== "string" || !WHOLE_SECOND_UTC.test(value)) {
    throw protocolError(code, `${label} must be whole-second UTC ISO-8601`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw protocolError(code, `${label} must be a valid UTC timestamp`);
  }
  return value;
}

function requireSha256(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): string {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    throw protocolError(code, `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireSafeToken(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw protocolError(code, `${label} must be a safe opaque token`);
  }
  return value;
}

function requireString(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw protocolError(
      code,
      `${label} must contain from ${minimum} through ${maximum} characters`,
    );
  }
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw protocolError(
      code,
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function requireEqual(
  actual: unknown,
  expected: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): void {
  if (actual !== expected) {
    throw protocolError(code, `${label} must equal ${String(expected)}`);
  }
}

function requireRecord(
  value: unknown,
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw protocolError(code, `${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  code: JsonCompatibilityProbeProtocolError["code"],
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key)) ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw protocolError(
      code,
      `${label} fields must be exactly ${[...expected].sort().join(", ")}`,
    );
  }
}

function normalizeUtf8Bytes(source: string | Uint8Array, label: string): Uint8Array {
  if (typeof source === "string") return new TextEncoder().encode(source);
  if (source instanceof Uint8Array) return copyBytes(source);
  throw protocolError(
    "invalid_raw_json",
    `${label} must be UTF-8 text or Uint8Array`,
  );
}

function copyBytes(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function copyArrayBuffer(source: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return buffer;
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw protocolError(
        "invalid_raw_json",
        "canonical JSON cannot contain non-finite numbers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw protocolError("invalid_raw_json", "canonical JSON cannot contain cycles");
    }
    ancestors.add(value);
    const result = value.map((entry) => canonicalize(entry, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw protocolError("invalid_raw_json", "canonical JSON cannot contain cycles");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw protocolError(
        "invalid_raw_json",
        "canonical JSON cannot contain symbol properties",
      );
    }
    ancestors.add(value);
    const result: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw protocolError(
          "invalid_raw_json",
          "canonical JSON cannot contain undefined",
        );
      }
      result[key] = canonicalize(child, ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw protocolError(
    "invalid_raw_json",
    "canonical JSON contains an unsupported value",
  );
}

function protocolError(
  code: JsonCompatibilityProbeProtocolError["code"],
  message: string,
): JsonCompatibilityProbeProtocolError {
  return new JsonCompatibilityProbeProtocolError(code, message);
}
