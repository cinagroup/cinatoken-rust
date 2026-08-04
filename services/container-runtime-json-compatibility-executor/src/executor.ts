import {
  JSON_COMPATIBILITY_PROBE_REQUEST_CONTRACT,
  canonicalJson,
  sha256Hex,
  verifyJsonCompatibilityProbeResultDigests,
  type JsonCompatibilityProbeRequestV1,
  type JsonCompatibilityProbeResultV1,
} from "../../container-controller/src/json_compatibility_probe";
import {
  verifyJsonCompatibilityPhasePermit,
  type JsonCompatibilityPermitVerifierEnv,
  type VerifiedJsonCompatibilityPhasePermitV1,
} from "./authorization";
import {
  JsonCompatibilityCampaignAuthority,
  type JsonCompatibilityCampaignAuthorityErrorCode,
  type JsonCompatibilityCampaignLeaseReceiptV1,
} from "./campaign_authority";
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
  parseJsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityPhasePermitEnvelopeV1,
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
  | "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY"
  | "JSON_COMPATIBILITY_PERMIT_ISSUER"
  | "JSON_COMPATIBILITY_PERMIT_AUDIENCE"
  | "JSON_COMPATIBILITY_PERMIT_KEY_ID"
  | "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256"
> & {
  readonly ENVIRONMENT: string;
  readonly JSON_COMPATIBILITY_EXECUTOR_ENABLED: string;
  readonly CF_VERSION_METADATA: {
    readonly id: string;
  };
  readonly CONTAINER_CONTROLLER_JSON_PROBE: JsonCompatibilityProbeBinding;
  readonly JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY:
    DurableObjectNamespace<JsonCompatibilityCampaignAuthority>;
} & JsonCompatibilityPermitVerifierEnv;

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

export interface JsonCompatibilityPhaseProbeReceiptV2 {
  readonly schemaVersion: 2;
  readonly contract: typeof JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT;
  readonly kind: "container-runtime-json-compatibility-phase-probe-receipt";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly controller: JsonCompatibilityExecutePhaseRequestV2["controller"];
  readonly runtimes: JsonCompatibilityExecutePhaseRequestV2["runtimes"];
  readonly ring: JsonCompatibilityExecutePhaseRequestV2["ring"];
  readonly phase: JsonCompatibilityExecutePhaseRequestV2["phase"];
  readonly authorization: {
    readonly kind: "ed25519-signed-single-use-phase-permit";
    readonly algorithm: "Ed25519";
    readonly permitIdSha256: string;
    readonly permitSubjectSha256: string;
    readonly permitEnvelopeSha256: string;
    readonly permitEnvelope: JsonCompatibilityPhasePermitEnvelopeV1;
    readonly issuer: string;
    readonly audience: string;
    readonly keyId: string;
    readonly signerSpkiSha256: string;
    readonly issuedAt: number;
    readonly notBefore: number;
    readonly expiresAt: number;
    readonly campaignAuthority: {
      readonly kind: "campaign-scoped-sqlite-durable-object";
      readonly binding: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY";
      readonly objectNameSha256: string;
      readonly campaignBindingSha256: string;
      readonly leaseIdSha256: string;
      readonly leaseReceiptSha256: string;
      readonly singleUsePermitPersisted: true;
      readonly phaseOrderEnforced: true;
      readonly concurrentPhaseRejected: true;
    };
  };
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
): Promise<JsonCompatibilityPhaseProbeReceiptV2> {
  assertExecutorEnvironment(env);
  const request = parseJsonCompatibilityExecutePhaseRequestV2(input);
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

  requireCampaignAuthorityBinding(env);
  const startedAtMs = requireRuntimeNow(runtime.now(), "phase start time");
  const permit = await verifyJsonCompatibilityPhasePermit(
    env,
    request,
    executorVersionId,
    startedAtMs,
  );
  const campaignBindingSha256 = await campaignBindingDigest(
    request,
    executorVersionId,
  );
  const leaseIdSha256 = await sha256Hex(canonicalJson({
    campaignIdSha256: request.campaignIdSha256,
    permitIdSha256: permit.permitIdSha256,
    phaseExecutionId: request.phaseExecutionId,
    executorVersionId,
    nonce: requireRuntimeUuid(runtime.randomUUID(), "campaign lease UUID"),
  }));
  const authority = env.JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY.getByName(
    request.campaignIdSha256,
  );
  const lease = await beginCampaignLease(
    authority,
    request,
    permit,
    campaignBindingSha256,
    leaseIdSha256,
    executorVersionId,
    Math.floor(startedAtMs / 1000),
  );

  try {
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
      schemaVersion: 2 as const,
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
      authorization: authorizationEvidence(
        permit,
        lease,
        request.campaignIdSha256,
        campaignBindingSha256,
        leaseIdSha256,
        request.authorization,
      ),
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
    if (
      new TextEncoder().encode(canonicalSubject).byteLength
      > MAX_PHASE_PROBE_RECEIPT_BYTES
    ) {
      throw new JsonCompatibilityExecutorProtocolError(
        "invalid_probe_result",
        `phase probe receipt exceeds ${MAX_PHASE_PROBE_RECEIPT_BYTES} bytes`,
      );
    }
    const receiptSha256 = await sha256Hex(canonicalSubject);
    const receipt = { ...subject, receiptSha256 };
    const completion = await authority.completePhase({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-campaign-lease-complete-v1",
      campaignIdSha256: request.campaignIdSha256,
      permitIdSha256: permit.permitIdSha256,
      phaseOrdinal: request.phase.ordinal,
      phaseExecutionId: request.phaseExecutionId,
      leaseIdSha256,
      receiptSha256,
      completedAt: Math.floor(completedAtMs / 1000),
    });
    if (!completion.ok) throw campaignAuthorityError(completion.error.code);
    const expectedCompletionStatus = request.phase.ordinal === 4
      ? "campaign_completed"
      : "phase_completed";
    if (completion.status !== expectedCompletionStatus) {
      throw campaignAuthorityUnavailable(
        "campaign authority returned an invalid completion status",
      );
    }
    return receipt;
  } catch (error) {
    let failedAtMs = startedAtMs;
    try {
      failedAtMs = requireRuntimeNow(runtime.now(), "phase failure time");
    } catch {
      // The acquired lease still has to be terminalized if the clock source fails.
    }
    let failure;
    try {
      failure = await authority.failPhase({
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-campaign-lease-fail-v1",
        campaignIdSha256: request.campaignIdSha256,
        permitIdSha256: permit.permitIdSha256,
        phaseOrdinal: request.phase.ordinal,
        phaseExecutionId: request.phaseExecutionId,
        leaseIdSha256,
        failureCode: failureCode(error),
        failedAt: Math.floor(Math.max(startedAtMs, failedAtMs) / 1000),
      });
    } catch {
      throw campaignAuthorityUnavailable(
        "campaign authority failure outcome is unknown",
      );
    }
    if (!failure.ok) {
      throw campaignAuthorityUnavailable(
        `campaign authority could not persist failure: ${failure.error.code}`,
      );
    }
    if (failure.status !== "campaign_failed") {
      throw campaignAuthorityUnavailable(
        "campaign authority returned an invalid failure status",
      );
    }
    throw error;
  }
}

async function beginCampaignLease(
  authority: DurableObjectStub<JsonCompatibilityCampaignAuthority>,
  request: JsonCompatibilityExecutePhaseRequestV2,
  permit: VerifiedJsonCompatibilityPhasePermitV1,
  campaignBindingSha256: string,
  leaseIdSha256: string,
  executorVersionId: string,
  acquiredAt: number,
): Promise<JsonCompatibilityCampaignLeaseReceiptV1> {
  let result;
  try {
    result = await authority.beginPhase({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-campaign-lease-begin-v1",
      campaignIdSha256: request.campaignIdSha256,
      campaignBindingSha256,
      planDigestSha256: request.planDigestSha256,
      permitIdSha256: permit.permitIdSha256,
      permitSubjectSha256: permit.subjectSha256,
      permitEnvelopeSha256: permit.envelopeSha256,
      permitExpiresAt: permit.expiresAt,
      phaseOrdinal: request.phase.ordinal,
      phaseId: request.phase.id,
      phaseExecutionId: request.phaseExecutionId,
      leaseIdSha256,
      executorVersionId,
      acquiredAt,
    });
  } catch {
    throw campaignAuthorityUnavailable(
      "campaign authority lease outcome is unknown",
    );
  }
  if (!result.ok) throw campaignAuthorityError(result.error.code);
  const receipt = result.receipt;
  const { leaseReceiptSha256, ...receiptSubject } = receipt;
  const expectedSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-receipt-v1",
    status: "phase_lease_acquired",
    campaignIdSha256: request.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: request.planDigestSha256,
    permitIdSha256: permit.permitIdSha256,
    permitSubjectSha256: permit.subjectSha256,
    permitEnvelopeSha256: permit.envelopeSha256,
    phaseOrdinal: request.phase.ordinal,
    phaseId: request.phase.id,
    phaseExecutionId: request.phaseExecutionId,
    leaseIdSha256,
    executorVersionId,
    acquiredAt,
    permitExpiresAt: permit.expiresAt,
    singleUsePermitPersisted: true,
    phaseOrderEnforced: true,
    concurrentPhaseRejected: true,
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(expectedSubject)
    || leaseReceiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw campaignAuthorityUnavailable(
      "campaign authority returned an invalid lease receipt",
    );
  }
  return receipt;
}

async function campaignBindingDigest(
  request: JsonCompatibilityExecutePhaseRequestV2,
  executorVersionId: string,
): Promise<string> {
  return await sha256Hex(canonicalJson({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-binding-v1",
    environment: request.environment,
    campaignIdSha256: request.campaignIdSha256,
    planDigestSha256: request.planDigestSha256,
    controller: request.controller,
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: executorVersionId,
    },
    runtimes: request.runtimes,
    ring: request.ring,
  }));
}

function authorizationEvidence(
  permit: VerifiedJsonCompatibilityPhasePermitV1,
  lease: JsonCompatibilityCampaignLeaseReceiptV1,
  campaignIdSha256: string,
  campaignBindingSha256: string,
  leaseIdSha256: string,
  permitEnvelope: JsonCompatibilityPhasePermitEnvelopeV1,
): JsonCompatibilityPhaseProbeReceiptV2["authorization"] {
  return {
    kind: "ed25519-signed-single-use-phase-permit",
    algorithm: "Ed25519",
    permitIdSha256: permit.permitIdSha256,
    permitSubjectSha256: permit.subjectSha256,
    permitEnvelopeSha256: permit.envelopeSha256,
    permitEnvelope,
    issuer: permit.issuer,
    audience: permit.audience,
    keyId: permit.keyId,
    signerSpkiSha256: permit.signerSpkiSha256,
    issuedAt: permit.issuedAt,
    notBefore: permit.notBefore,
    expiresAt: permit.expiresAt,
    campaignAuthority: {
      kind: "campaign-scoped-sqlite-durable-object",
      binding: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
      objectNameSha256: campaignIdSha256,
      campaignBindingSha256,
      leaseIdSha256,
      leaseReceiptSha256: lease.leaseReceiptSha256,
      singleUsePermitPersisted: lease.singleUsePermitPersisted,
      phaseOrderEnforced: lease.phaseOrderEnforced,
      concurrentPhaseRejected: lease.concurrentPhaseRejected,
    },
  };
}

function requireCampaignAuthorityBinding(
  env: JsonCompatibilityExecutorEnv,
): void {
  if (
    env.JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY === null
    || typeof env.JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY !== "object"
    || typeof env.JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY.getByName !== "function"
  ) {
    throw campaignAuthorityUnavailable(
      "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY must be a Durable Object namespace",
    );
  }
}

function campaignAuthorityError(
  code: JsonCompatibilityCampaignAuthorityErrorCode,
): JsonCompatibilityExecutorProtocolError {
  if (code === "campaign_permit_replayed") {
    return new JsonCompatibilityExecutorProtocolError(
      "campaign_permit_replayed",
      "phase permit was already consumed",
    );
  }
  if (code === "campaign_phase_order_conflict") {
    return new JsonCompatibilityExecutorProtocolError(
      "campaign_phase_order_conflict",
      "campaign phase is not the next approved phase",
    );
  }
  if (code === "campaign_terminal") {
    return new JsonCompatibilityExecutorProtocolError(
      "campaign_terminal",
      "campaign is already terminal",
    );
  }
  return new JsonCompatibilityExecutorProtocolError(
    "campaign_authority_conflict",
    `campaign authority rejected the lease: ${code}`,
  );
}

function campaignAuthorityUnavailable(
  message: string,
): JsonCompatibilityExecutorProtocolError {
  return new JsonCompatibilityExecutorProtocolError(
    "campaign_authority_unavailable",
    message,
  );
}

function failureCode(error: unknown): string {
  return error instanceof JsonCompatibilityExecutorProtocolError
    ? error.code
    : "phase_execution_failed";
}

async function probeOneShard(
  env: JsonCompatibilityExecutorEnv,
  execution: JsonCompatibilityExecutePhaseRequestV2,
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
): JsonCompatibilityPhaseProbeReceiptV2["executionBoundary"] {
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
