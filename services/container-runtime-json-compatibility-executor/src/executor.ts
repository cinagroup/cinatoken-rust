import {
  JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
  canonicalJson,
  sha256Hex,
  verifyJsonCompatibilityProbeResultDigests,
  type JsonCompatibilityProbeRequestV1,
  type JsonCompatibilityProbeResultV1,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT,
  JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  JSON_COMPATIBILITY_MAX_CONCURRENCY,
  JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_SHARD_COUNT,
  JsonCompatibilityExecutorProtocolError,
  expectedRuntimeGeneration,
  jsonCompatibilityShardInstanceName,
  parseJsonCompatibilityExecutePhaseRequestV1,
  type JsonCompatibilityExecutePhaseRequestV1,
  type JsonCompatibilityRuntimeGeneration,
} from "./protocol";

const PROBE_EXECUTION_WINDOW_SECONDS = 60;
const PROBE_OWNER_LEASE_WINDOW_SECONDS = 120;
const MAX_PHASE_PROBE_RECEIPT_BYTES = 1024 * 1024;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const SAFE_RUNTIME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityProbeBinding {
  probeShard(request: JsonCompatibilityProbeRequestV1): Promise<unknown>;
}

export type JsonCompatibilityExecutorEnv = Omit<
  JsonCompatibilityExecutorGeneratedEnv,
  | "ENVIRONMENT"
  | "JSON_COMPATIBILITY_EXECUTOR_ENABLED"
  | "CF_VERSION_METADATA"
  | "CONTAINER_CONTROLLER_JSON_PROBE"
> & {
  readonly ENVIRONMENT: string;
  readonly JSON_COMPATIBILITY_EXECUTOR_ENABLED: string;
  readonly CF_VERSION_METADATA: {
    readonly id: string;
  };
  readonly CONTAINER_CONTROLLER_JSON_PROBE: JsonCompatibilityProbeBinding;
};

export interface JsonCompatibilityExecutorRuntime {
  now(): number;
  randomUUID(): string;
}

export interface JsonCompatibilityPhaseProbeObservationV1 {
  readonly shardIndex: number;
  readonly instanceName: string;
  readonly runtimeGeneration: JsonCompatibilityRuntimeGeneration;
  readonly runtimeBuildIdSha256: string;
  readonly probeRequestCanonicalSha256: string;
  readonly probeResultCanonicalSha256: string;
  readonly probeResult: JsonCompatibilityProbeResultV1;
}

export interface JsonCompatibilityPhaseProbeReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT;
  readonly kind: "container-runtime-json-compatibility-phase-probe-receipt";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly controller: JsonCompatibilityExecutePhaseRequestV1["controller"];
  readonly runtimes: JsonCompatibilityExecutePhaseRequestV1["runtimes"];
  readonly ring: JsonCompatibilityExecutePhaseRequestV1["ring"];
  readonly phase: JsonCompatibilityExecutePhaseRequestV1["phase"];
  readonly executor: {
    readonly serviceName: typeof JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME;
    readonly versionId: string;
    readonly gateName: "JSON_COMPATIBILITY_EXECUTOR_ENABLED";
    readonly maxConcurrency: 4;
  };
  readonly transport: {
    readonly kind: "service-binding-rpc";
    readonly binding: "CONTAINER_CONTROLLER_JSON_PROBE";
    readonly targetService: typeof JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME;
    readonly targetEntrypoint: typeof JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT;
    readonly rpcMethod: "probeShard";
    readonly publicUrlUsed: false;
    readonly cloudflareRestUsed: false;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observations: readonly JsonCompatibilityPhaseProbeObservationV1[];
  readonly transportTotals: {
    readonly privateServiceBindingRpcCount: 8;
    readonly completedProbeCount: 8;
    readonly selectedJsonCount: 8;
    readonly effectiveJsonCount: 8;
    readonly protobufAttemptCount: 0;
    readonly legacyJsonFallbackCount: 0;
    readonly recoveryRequiredCount: 0;
  };
  readonly executionBoundary: {
    readonly credentialsRead: false;
    readonly filesWritten: false;
    readonly deploymentMutationAuthorized: false;
    readonly deploymentMutationPerformed: false;
    readonly cloudflareRestRequestCount: 0;
    readonly providerRequestCount: 0;
    readonly billingMutationCount: 0;
    readonly storageGatewayMutationCount: 0;
    readonly productionTrafficRequestCount: 0;
    readonly publicProbeRequestCount: 0;
  };
  readonly receiptSha256: string;
}

export async function executeJsonCompatibilityPhase(
  env: JsonCompatibilityExecutorEnv,
  input: unknown,
  runtime: JsonCompatibilityExecutorRuntime = {
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
  },
): Promise<JsonCompatibilityPhaseProbeReceiptV1> {
  assertExecutorEnvironment(env);
  const request = parseJsonCompatibilityExecutePhaseRequestV1(input);
  const executorVersionId = requireConfigurationSafeToken(
    env.CF_VERSION_METADATA?.id,
    "executor Worker version ID",
  );
  if (
    env.CONTAINER_CONTROLLER_JSON_PROBE === null ||
    typeof env.CONTAINER_CONTROLLER_JSON_PROBE !== "object" ||
    typeof env.CONTAINER_CONTROLLER_JSON_PROBE.probeShard !== "function"
  ) {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_configuration_error",
      "CONTAINER_CONTROLLER_JSON_PROBE must expose probeShard RPC",
    );
  }

  const startedAtMs = requireRuntimeNow(runtime.now(), "phase start time");
  const observations = await mapInBoundedBatches(
    Array.from({ length: JSON_COMPATIBILITY_SHARD_COUNT }, (_, index) => index),
    JSON_COMPATIBILITY_MAX_CONCURRENCY,
    async (shardIndex) =>
      await probeOneShard(env, request, shardIndex, runtime),
  );
  const completedAtMs = requireRuntimeNow(runtime.now(), "phase completion time");
  if (completedAtMs < startedAtMs) {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_configuration_error",
      "phase completion time must not precede phase start time",
    );
  }

  const executionBoundary = aggregateExecutionBoundary(observations);
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
    kind: "container-runtime-json-compatibility-phase-probe-receipt" as const,
    environment: "staging" as const,
    campaignIdSha256: request.campaignIdSha256,
    planDigestSha256: request.planDigestSha256,
    phaseExecutionId: request.phaseExecutionId,
    controller: request.controller,
    runtimes: request.runtimes,
    ring: request.ring,
    phase: request.phase,
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: executorVersionId,
      gateName: "JSON_COMPATIBILITY_EXECUTOR_ENABLED" as const,
      maxConcurrency: JSON_COMPATIBILITY_MAX_CONCURRENCY,
    },
    transport: {
      kind: "service-binding-rpc" as const,
      binding: "CONTAINER_CONTROLLER_JSON_PROBE" as const,
      targetService: JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
      targetEntrypoint: JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT,
      rpcMethod: "probeShard" as const,
      publicUrlUsed: false as const,
      cloudflareRestUsed: false as const,
    },
    startedAt: wholeSecondUtc(startedAtMs),
    completedAt: wholeSecondUtc(completedAtMs),
    observations,
    transportTotals: {
      privateServiceBindingRpcCount: JSON_COMPATIBILITY_SHARD_COUNT,
      completedProbeCount: JSON_COMPATIBILITY_SHARD_COUNT,
      selectedJsonCount: JSON_COMPATIBILITY_SHARD_COUNT,
      effectiveJsonCount: JSON_COMPATIBILITY_SHARD_COUNT,
      protobufAttemptCount: 0 as const,
      legacyJsonFallbackCount: 0 as const,
      recoveryRequiredCount: 0 as const,
    },
    executionBoundary,
  };
  const canonicalSubject = canonicalJson(subject);
  if (new TextEncoder().encode(canonicalSubject).byteLength > MAX_PHASE_PROBE_RECEIPT_BYTES) {
    throw new JsonCompatibilityExecutorProtocolError(
      "invalid_probe_result",
      `phase probe receipt exceeds ${MAX_PHASE_PROBE_RECEIPT_BYTES} bytes`,
    );
  }
  const receiptSha256 = await sha256Hex(canonicalSubject);
  return { ...subject, receiptSha256 };
}

async function probeOneShard(
  env: JsonCompatibilityExecutorEnv,
  execution: JsonCompatibilityExecutePhaseRequestV1,
  shardIndex: number,
  runtime: JsonCompatibilityExecutorRuntime,
): Promise<JsonCompatibilityPhaseProbeObservationV1> {
  const requestedAtMs = requireRuntimeNow(runtime.now(), `shard ${shardIndex} request time`);
  const requestedAtSeconds = Math.floor(requestedAtMs / 1000);
  const runtimeGeneration = expectedRuntimeGeneration(
    execution.phase.id,
    execution.ring.candidateShardIndex,
    shardIndex,
  );
  const runtimeIdentity = runtimeGeneration === "n"
    ? execution.runtimes.n
    : execution.runtimes.nMinusOne;
  const operationUuid = requireRuntimeUuid(
    runtime.randomUUID(),
    `shard ${shardIndex} operation UUID`,
  );
  const providerUuid = requireRuntimeUuid(
    runtime.randomUUID(),
    `shard ${shardIndex} provider-operation UUID`,
  );
  const traceUuid = requireRuntimeUuid(
    runtime.randomUUID(),
    `shard ${shardIndex} trace UUID`,
  );
  const operationId = `jcmp-${execution.phase.ordinal}-${shardIndex}-${operationUuid}`;
  const providerOperationId = `jcmp-provider-${shardIndex}-${providerUuid}`;
  const traceId = `jcmp-trace-${shardIndex}-${traceUuid}`;
  const admissionSha256 = await sha256Hex(canonicalJson({
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseExecutionId: execution.phaseExecutionId,
    phaseId: execution.phase.id,
    shardIndex,
    operationId,
    providerOperationId,
    traceId,
  }));
  const probeRequest: JsonCompatibilityProbeRequestV1 = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
    environment: "staging",
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseId: execution.phase.id,
    phaseOrdinal: execution.phase.ordinal,
    candidateShardIndex: execution.ring.candidateShardIndex,
    controllerServiceName: JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
    controllerVersionId: execution.controller.versionId,
    runtimeGeneration,
    expectedRuntimeBuildIdSha256: runtimeIdentity.buildIdSha256,
    requestedAt: wholeSecondUtc(requestedAtMs),
    shard: {
      contractVersion: 1,
      ringGeneration: execution.ring.generation,
      shardCount: JSON_COMPATIBILITY_SHARD_COUNT,
      shardIndex,
      instanceName: jsonCompatibilityShardInstanceName(shardIndex),
    },
    operation: {
      operationId,
      ownerGeneration: Math.max(1, requestedAtSeconds),
      ownerLeaseExpiresAt:
        requestedAtSeconds + PROBE_OWNER_LEASE_WINDOW_SECONDS,
      executionDeadlineAt:
        requestedAtSeconds + PROBE_EXECUTION_WINDOW_SECONDS,
      providerOperationId,
      admissionSha256,
      traceId,
    },
  };
  const rawResult = await env.CONTAINER_CONTROLLER_JSON_PROBE.probeShard(
    probeRequest,
  );
  let probeResult: JsonCompatibilityProbeResultV1;
  try {
    probeResult = await verifyJsonCompatibilityProbeResultDigests(rawResult);
  } catch (error) {
    throw new JsonCompatibilityExecutorProtocolError(
      "invalid_probe_result",
      `shard ${shardIndex} probe result failed validation: ${errorMessage(error)}`,
    );
  }
  if (canonicalJson(probeResult.request) !== canonicalJson(probeRequest)) {
    throw new JsonCompatibilityExecutorProtocolError(
      "invalid_probe_result",
      `shard ${shardIndex} probe result did not echo the exact request`,
    );
  }
  const [probeRequestCanonicalSha256, probeResultCanonicalSha256] =
    await Promise.all([
      sha256Hex(canonicalJson(probeRequest)),
      sha256Hex(canonicalJson(probeResult)),
    ]);
  return {
    shardIndex,
    instanceName: probeRequest.shard.instanceName,
    runtimeGeneration,
    runtimeBuildIdSha256: runtimeIdentity.buildIdSha256,
    probeRequestCanonicalSha256,
    probeResultCanonicalSha256,
    probeResult,
  };
}

async function mapInBoundedBatches<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const batch = values.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (value) => await mapper(value)),
    );
    let hasFailure = false;
    let firstFailure: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else if (!hasFailure) {
        hasFailure = true;
        firstFailure = result.reason;
      }
    }
    if (hasFailure) {
      throw firstFailure;
    }
  }
  return results;
}

function aggregateExecutionBoundary(
  observations: readonly JsonCompatibilityPhaseProbeObservationV1[],
): JsonCompatibilityPhaseProbeReceiptV1["executionBoundary"] {
  let providerRequestCount = 0;
  let billingMutationCount = 0;
  let storageGatewayMutationCount = 0;
  let productionTrafficRequestCount = 0;
  let publicProbeRequestCount = 0;
  for (const observation of observations) {
    providerRequestCount += observation.probeResult.sideEffects.providerRequestCount;
    billingMutationCount += observation.probeResult.sideEffects.billingMutationCount;
    storageGatewayMutationCount +=
      observation.probeResult.sideEffects.storageGatewayMutationCount;
    productionTrafficRequestCount +=
      observation.probeResult.sideEffects.productionTrafficRequestCount;
    publicProbeRequestCount +=
      observation.probeResult.sideEffects.publicProbeRequestCount;
  }
  if (
    providerRequestCount !== 0 ||
    billingMutationCount !== 0 ||
    storageGatewayMutationCount !== 0 ||
    productionTrafficRequestCount !== 0 ||
    publicProbeRequestCount !== 0
  ) {
    throw new JsonCompatibilityExecutorProtocolError(
      "invalid_probe_result",
      "phase probe results reported a forbidden side effect",
    );
  }
  return {
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
  };
}

function assertExecutorEnvironment(env: JsonCompatibilityExecutorEnv): void {
  if (env.ENVIRONMENT !== "staging") {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_staging_only",
      "JSON compatibility executor is staging-only",
    );
  }
  if (env.JSON_COMPATIBILITY_EXECUTOR_ENABLED !== "true") {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_disabled",
      "JSON compatibility executor is disabled",
    );
  }
}

function requireRuntimeNow(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > MAX_DATE_MILLISECONDS
  ) {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_configuration_error",
      `${label} must be a positive safe Unix millisecond timestamp`,
    );
  }
  return value;
}

function requireRuntimeUuid(value: string, label: string): string {
  const token = requireConfigurationSafeToken(value, label);
  if (token.length > 64) {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_configuration_error",
      `${label} exceeds 64 characters`,
    );
  }
  return token;
}

function requireConfigurationSafeToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_RUNTIME_TOKEN.test(value)) {
    throw new JsonCompatibilityExecutorProtocolError(
      "executor_configuration_error",
      `${label} must be a safe opaque token`,
    );
  }
  return value;
}

function wholeSecondUtc(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown probe validation error";
}
