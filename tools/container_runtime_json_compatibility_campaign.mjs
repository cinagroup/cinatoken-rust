import { createHash } from "node:crypto";
import {
  validateControllerConfig,
} from "./preflight_container_controller_deploy.mjs";

export const JSON_COMPATIBILITY_PLAN_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-plan-v5";
export const JSON_COMPATIBILITY_PLAN_V4_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-plan-v4";
export const JSON_COMPATIBILITY_PLAN_V3_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-plan-v3";
export const JSON_COMPATIBILITY_PLAN_V2_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-plan-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_STATE_BINDING_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-state-binding-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_V1_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v1";
export const JSON_COMPATIBILITY_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-evidence-v1";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_POLICY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-approval-policy-v1";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER =
  "cinatoken-json-compatibility-campaign-approval-authority-staging";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS = 600;
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_MIN_REMAINING_SECONDS = 180;
export const JSON_COMPATIBILITY_STATUS_RECOVERY_POLICY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-status-recovery-policy-v1";
export const JSON_COMPATIBILITY_STATUS_RECOVERY_WINDOW_SECONDS = 86_400;
export const JSON_COMPATIBILITY_STATUS_QUERY_LIFETIME_SECONDS = 30;
export const JSON_COMPATIBILITY_STATUS_CLOCK_SKEW_SECONDS = 5;
export const JSON_COMPATIBILITY_OPERATOR_HMAC_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
export const JSON_COMPATIBILITY_OPERATOR_STATUS_HMAC_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-status-staging";
export const JSON_COMPATIBILITY_INVOKER_HMAC_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
export const JSON_COMPATIBILITY_SHARD_COUNT = 8;
export const JSON_COMPATIBILITY_PHASE_IDS = Object.freeze([
  "baseline-n-minus-one",
  "mixed-n-n-minus-one",
  "candidate-n",
  "rollback-n-minus-one",
]);

const RUNTIME_N = "n";
const RUNTIME_N_MINUS_ONE = "n-minus-one";
const JSON_CONTENT_TYPE = "application/json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OCI_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WHOLE_SECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REQUIRED_CHECKS = Object.freeze([
  "controller-deployment-readback",
  "container-deployment-readback",
  "readiness-build-identity-every-shard",
  "canonical-json-health-probe-every-shard",
  "raw-json-request-response-digests",
  "normalized-json-compatibility-digests",
  "bounded-transport-telemetry",
  "zero-provider-billing-storage-production-public-mutation",
  "ledger-convergence",
]);
const PRIVATE_SERVICE_DEFINITIONS = Object.freeze({
  caller: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-caller-staging",
    entrypoint: "JsonCompatibilityCampaignCallerEntrypoint",
    gateName: "JSON_COMPATIBILITY_CALLER_ENABLED",
  }),
  runner: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-runner-staging",
    entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
    gateName: "JSON_COMPATIBILITY_RUNNER_ENABLED",
  }),
  operator: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-operator-staging",
    entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
    gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED",
  }),
  invoker: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
    gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED",
  }),
  permitIssuer: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
    gateName: "JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED",
  }),
  executor: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
    gateName: "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
  }),
});

export class JsonCompatibilityCampaignError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonCompatibilityCampaignError";
  }
}

export function parseStrictJsonObject(
  source,
  label = "JSON compatibility campaign input",
) {
  if (typeof source !== "string") {
    throw new JsonCompatibilityCampaignError(`${label} must be text`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new JsonCompatibilityCampaignError(`${label} must be valid JSON`);
  }
  return requireRecord(value, label);
}

export function createJsonHealthProbeDigestRecord(requestBytes, responseBytes) {
  const requestBuffer = normalizeBytes(requestBytes, "[projection] request bytes");
  const responseBuffer = normalizeBytes(responseBytes, "[projection] response bytes");
  const request = parseJsonBytes(requestBuffer, "[projection] request");
  const response = parseJsonBytes(responseBuffer, "[projection] response");
  requireExactKeys(request, [
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
  ], "[projection] request");
  requireEqual(request.protocol_version, 1, "[projection] request protocol version");
  requireToken(request.operation_id, "[projection] operation ID");
  requireEqual(request.operation_kind, "health_probe", "[projection] operation kind");
  requireInteger(
    request.owner_generation,
    1,
    Number.MAX_SAFE_INTEGER,
    "[projection] owner generation",
  );
  requireInteger(
    request.owner_lease_expires_at,
    1,
    Number.MAX_SAFE_INTEGER,
    "[projection] owner lease expiry",
  );
  requireInteger(
    request.execution_deadline_at,
    1,
    Number.MAX_SAFE_INTEGER,
    "[projection] execution deadline",
  );
  requireToken(request.provider_operation_id, "[projection] provider operation ID");
  requireSha256(request.admission_sha256, "[projection] admission digest");
  requireToken(request.trace_id, "[projection] trace ID");

  const input = requireRecord(request.input, "[projection] input");
  requireExactKeys(
    input,
    ["mode", "sha256", "size", "content_type"],
    "[projection] input",
  );
  requireEqual(input.mode, "inline", "[projection] input mode");
  requireSha256(input.sha256, "[projection] input digest");
  requireEqual(input.size, 0, "[projection] input size");
  requireEqual(input.content_type, JSON_CONTENT_TYPE, "[projection] input content type");

  const shard = requireRecord(request.shard, "[projection] shard");
  requireExactKeys(shard, [
    "contract_version",
    "ring_generation",
    "shard_count",
    "shard_index",
    "instance_name",
  ], "[projection] shard");
  requireEqual(shard.contract_version, 1, "[projection] shard contract version");
  requireInteger(
    shard.ring_generation,
    1,
    Number.MAX_SAFE_INTEGER,
    "[projection] ring generation",
  );
  requireInteger(shard.shard_count, 2, 1024, "[projection] shard count");
  requireInteger(
    shard.shard_index,
    0,
    shard.shard_count - 1,
    "[projection] shard index",
  );
  requireToken(shard.instance_name, "[projection] shard instance name");

  requireExactKeys(
    response,
    ["protocol_version", "operation_id", "status", "trace_id"],
    "[projection] response",
  );
  requireEqual(response.protocol_version, 1, "[projection] response protocol version");
  requireEqual(response.operation_id, request.operation_id, "[projection] response operation ID");
  requireEqual(response.status, "completed", "[projection] response status");
  requireEqual(response.trace_id, request.trace_id, "[projection] response trace ID");

  const requestProjection = cloneJson(request);
  requestProjection.operation_id = "<operation-id>";
  requestProjection.owner_generation = 0;
  requestProjection.owner_lease_expires_at = 0;
  requestProjection.execution_deadline_at = 0;
  requestProjection.provider_operation_id = "<provider-operation-id>";
  requestProjection.admission_sha256 = "<admission-sha256>";
  requestProjection.trace_id = "<trace-id>";
  const responseProjection = cloneJson(response);
  responseProjection.operation_id = "<operation-id>";
  responseProjection.trace_id = "<trace-id>";
  return {
    requestSha256: sha256Bytes(requestBuffer),
    responseSha256: sha256Bytes(responseBuffer),
    requestCompatibilitySha256: sha256Canonical(requestProjection),
    responseCompatibilitySha256: sha256Canonical(responseProjection),
  };
}

export function buildJsonCompatibilityCampaignPlan({
  config,
  campaignIdSha256,
  deploymentStatePlanDigestSha256,
  controllerVersionId,
  callerVersionId,
  callerConfigSha256,
  runnerVersionId,
  runnerConfigSha256,
  operatorVersionId,
  operatorConfigSha256,
  operatorHmacKeyId,
  operatorHmacCredentialIdSha256,
  operatorStatusHmacKeyId,
  operatorStatusHmacCredentialIdSha256,
  operatorApprovalKeyId,
  operatorApprovalSpkiSha256,
  invokerVersionId,
  invokerConfigSha256,
  permitIssuerVersionId,
  permitIssuerConfigSha256,
  executorVersionId,
  executorConfigSha256,
  runtimeNBuildIdSha256,
  runtimeNImageDigest,
  runtimeNMinusOneBuildIdSha256,
  runtimeNMinusOneImageDigest,
  candidateShardIndex,
}) {
  const validated = validateControllerConfig(config, "staging", {
    jsonCompatibilityCampaign: true,
  });
  const vars = requireRecord(config.vars, "[config] staging vars");
  const observability = requireRecord(
    config.observability,
    "[config] staging observability",
  );
  requireEqual(
    observability.head_sampling_rate,
    1,
    "[config] staging observability sampling rate",
  );
  requireSha256(campaignIdSha256, "[plan] campaign ID");
  requireSha256(
    deploymentStatePlanDigestSha256,
    "[plan] deployment state plan digest",
  );
  requireToken(controllerVersionId, "[plan] Controller version ID");
  const privateServices = {
    caller: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.caller,
      callerVersionId,
      callerConfigSha256,
      "[plan] caller",
    ),
    runner: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.runner,
      runnerVersionId,
      runnerConfigSha256,
      "[plan] runner",
    ),
    operator: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.operator,
      operatorVersionId,
      operatorConfigSha256,
      "[plan] operator",
    ),
    invoker: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.invoker,
      invokerVersionId,
      invokerConfigSha256,
      "[plan] invoker",
    ),
    permitIssuer: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.permitIssuer,
      permitIssuerVersionId,
      permitIssuerConfigSha256,
      "[plan] permit issuer",
    ),
    executor: normalizePrivateServiceIdentity(
      PRIVATE_SERVICE_DEFINITIONS.executor,
      executorVersionId,
      executorConfigSha256,
      "[plan] executor",
    ),
  };
  requireKeyId(operatorApprovalKeyId, "[plan] operator approval key ID");
  requireSha256(
    operatorApprovalSpkiSha256,
    "[plan] operator approval SPKI digest",
  );
  requireKeyId(operatorHmacKeyId, "[plan] operator HMAC key ID");
  requireSha256(
    operatorHmacCredentialIdSha256,
    "[plan] operator HMAC credential digest",
  );
  requireKeyId(
    operatorStatusHmacKeyId,
    "[plan] operator status HMAC key ID",
  );
  requireSha256(
    operatorStatusHmacCredentialIdSha256,
    "[plan] operator status HMAC credential digest",
  );
  if (operatorHmacKeyId === operatorStatusHmacKeyId) {
    throw new JsonCompatibilityCampaignError(
      "[plan] execution and status HMAC key IDs must differ",
    );
  }
  if (
    operatorHmacCredentialIdSha256
    === operatorStatusHmacCredentialIdSha256
  ) {
    throw new JsonCompatibilityCampaignError(
      "[plan] execution and status HMAC credential digests must differ",
    );
  }
  const operatorApproval = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_APPROVAL_POLICY_CONTRACT,
    algorithm: "Ed25519",
    issuer: JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    audience: JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE,
    keyId: operatorApprovalKeyId,
    signerSpkiSha256: operatorApprovalSpkiSha256,
    maxLifetimeSeconds:
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS,
    minimumRemainingLifetimeSeconds:
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_MIN_REMAINING_SECONDS,
  };
  const runtimeN = normalizeRuntimeIdentity(
    runtimeNBuildIdSha256,
    runtimeNImageDigest,
    "[plan] runtime N",
  );
  const runtimeNMinusOne = normalizeRuntimeIdentity(
    runtimeNMinusOneBuildIdSha256,
    runtimeNMinusOneImageDigest,
    "[plan] runtime N-1",
  );
  if (runtimeN.buildIdSha256 === runtimeNMinusOne.buildIdSha256) {
    throw new JsonCompatibilityCampaignError(
      "[plan] runtime N and N-1 build IDs must differ",
    );
  }
  if (runtimeN.imageDigest === runtimeNMinusOne.imageDigest) {
    throw new JsonCompatibilityCampaignError(
      "[plan] runtime N and N-1 image digests must differ",
    );
  }

  const ringGeneration = requireConfiguredInteger(
    vars.CONTAINER_RING_GENERATION,
    1,
    Number.MAX_SAFE_INTEGER,
    "[config] ring generation",
  );
  const shardCount = requireConfiguredInteger(
    vars.CONTAINER_SHARD_COUNT,
    2,
    1024,
    "[config] shard count",
  );
  requireEqual(
    shardCount,
    JSON_COMPATIBILITY_SHARD_COUNT,
    "[config] JSON compatibility shard count",
  );
  const selectedCandidateShard =
    candidateShardIndex === undefined
      ? Number.parseInt(campaignIdSha256.slice(0, 8), 16) % shardCount
      : requireInteger(
          candidateShardIndex,
          0,
          shardCount - 1,
          "[plan] candidate shard index",
        );

  const phases = JSON_COMPATIBILITY_PHASE_IDS.map((id, index) => ({
    ordinal: index + 1,
    id,
    topology: topologyForPhase(id, selectedCandidateShard),
    requiredChecks: [...REQUIRED_CHECKS],
  }));
  const statusRecovery = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_STATUS_RECOVERY_POLICY_CONTRACT,
    mode: "read-only-status-recovery",
    approvalRecoveryWindowSeconds:
      JSON_COMPATIBILITY_STATUS_RECOVERY_WINDOW_SECONDS,
    statusQueryLifetimeSeconds:
      JSON_COMPATIBILITY_STATUS_QUERY_LIFETIME_SECONDS,
    clockSkewSeconds: JSON_COMPATIBILITY_STATUS_CLOCK_SKEW_SECONDS,
    executionRetryPermitted: false,
    statusReadGates: {
      caller: "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
      runner: "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
      operator: "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
      invoker: "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
    },
    statusAuthority: {
      algorithm: "HMAC-SHA-256",
      execution: {
        issuer: JSON_COMPATIBILITY_OPERATOR_HMAC_ISSUER,
        audience: JSON_COMPATIBILITY_INVOKER_HMAC_AUDIENCE,
        keyId: operatorHmacKeyId,
        credentialIdSha256: operatorHmacCredentialIdSha256,
      },
      status: {
        issuer: JSON_COMPATIBILITY_OPERATOR_STATUS_HMAC_ISSUER,
        audience: JSON_COMPATIBILITY_INVOKER_HMAC_AUDIENCE,
        keyId: operatorStatusHmacKeyId,
        credentialIdSha256: operatorStatusHmacCredentialIdSha256,
      },
    },
  };
  const deploymentStateBinding = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_BINDING_CONTRACT,
    deploymentStatePlanContract:
      JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    planDigestSha256: deploymentStatePlanDigestSha256,
    initialState: "dark",
    executionState: "execution",
    recoveryState: "statusOnly",
    finalState: "dark",
    directDarkToExecutionAllowed: false,
    directExecutionToDarkAllowed: false,
    executionArtifacts: {
      controller: {
        versionId: controllerVersionId,
        configSha256: sha256Canonical(config),
      },
      caller: executionArtifact(privateServices.caller),
      runner: executionArtifact(privateServices.runner),
      operator: executionArtifact(privateServices.operator),
      invoker: executionArtifact(privateServices.invoker),
      permitIssuer: executionArtifact(privateServices.permitIssuer),
      executor: executionArtifact(privateServices.executor),
    },
  };
  const subject = {
    schemaVersion: 4,
    contract: JSON_COMPATIBILITY_PLAN_CONTRACT,
    kind: "container-runtime-json-compatibility-plan",
    mode: "offline-dry-run",
    environment: "staging",
    campaignIdSha256,
    controller: {
      serviceName: validated.controllerName,
      versionId: controllerVersionId,
      configSha256: sha256Canonical(config),
      privateProbeTransport: "service-binding",
      jsonCompatibilityProbeEnabled: true,
      workersDev: false,
      previewUrls: false,
      observabilitySamplingRate: 1,
      protobufTransportEnabled: false,
      protobufTransportStagingVerified: false,
      allActionGatesDisabled: true,
    },
    privateServices,
    operatorApproval,
    statusRecovery,
    deploymentStateBinding,
    runtimes: {
      n: runtimeN,
      nMinusOne: runtimeNMinusOne,
    },
    ring: {
      generation: ringGeneration,
      shardCount,
      candidateShardIndex: selectedCandidateShard,
    },
    constraints: {
      operationKind: "health_probe",
      requestContentType: JSON_CONTENT_TYPE,
      responseContentType: JSON_CONTENT_TYPE,
      exactProbeCountPerPhase: shardCount,
      protobufAttemptsAllowed: 0,
      legacyJsonFallbacksAllowed: 0,
      providerRequestsAllowed: 0,
      billingMutationsAllowed: 0,
      storageGatewayMutationsAllowed: 0,
      productionTrafficRequestsAllowed: 0,
      publicProbeRequestsAllowed: 0,
    },
    phases,
    executionBoundary: {
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      deploymentMutationAuthorized: false,
      deploymentMutationPerformed: false,
      activationGateChangeAuthorized: false,
      remoteEvidenceCollected: false,
      privateProbeExecutorRequired: true,
      publicUrlAllowed: false,
    },
  };
  return {
    ...subject,
    planDigestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityCampaignPlan(plan) {
  const value = requireRecord(plan, "[plan] document");
  const isCurrentPlan = value.schemaVersion === 4
    && value.contract === JSON_COMPATIBILITY_PLAN_CONTRACT;
  const isPlanV4 = value.schemaVersion === 3
    && value.contract === JSON_COMPATIBILITY_PLAN_V4_CONTRACT;
  const isPlanV3 = value.schemaVersion === 2
    && value.contract === JSON_COMPATIBILITY_PLAN_V3_CONTRACT;
  const isPlanV2 = value.schemaVersion === 1
    && value.contract === JSON_COMPATIBILITY_PLAN_V2_CONTRACT;
  if (!isCurrentPlan && !isPlanV4 && !isPlanV3 && !isPlanV2) {
    throw new JsonCompatibilityCampaignError(
      "[plan] schema version and contract are unsupported",
    );
  }
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "mode",
    "environment",
    "campaignIdSha256",
    "controller",
    "privateServices",
    "operatorApproval",
    ...(isCurrentPlan || isPlanV4 || isPlanV3 ? ["statusRecovery"] : []),
    ...(isCurrentPlan || isPlanV4 ? ["deploymentStateBinding"] : []),
    "runtimes",
    "ring",
    "constraints",
    "phases",
    "executionBoundary",
    "planDigestSha256",
  ], "[plan] document");
  requireEqual(
    value.kind,
    "container-runtime-json-compatibility-plan",
    "[plan] kind",
  );
  requireEqual(value.mode, "offline-dry-run", "[plan] mode");
  requireEqual(value.environment, "staging", "[plan] environment");
  requireSha256(value.campaignIdSha256, "[plan] campaign ID");
  requireSha256(value.planDigestSha256, "[plan] digest");
  const { planDigestSha256, ...subject } = value;
  requireEqual(
    sha256Canonical(subject),
    planDigestSha256,
    "[plan] canonical digest",
  );

  validateControllerIdentity(value.controller, "[plan] Controller");
  validatePrivateServices(
    value.privateServices,
    "[plan] private services",
    isCurrentPlan,
  );
  validateOperatorApprovalPolicy(value.operatorApproval);
  if (isCurrentPlan || isPlanV4 || isPlanV3) {
    validateStatusRecoveryPolicy(value.statusRecovery, isCurrentPlan);
  }
  if (isCurrentPlan || isPlanV4) {
    validateDeploymentStateBinding(
      value.deploymentStateBinding,
      value.controller,
      value.privateServices,
      isCurrentPlan,
    );
  }
  const runtimes = validateRuntimeSet(value.runtimes, "[plan] runtimes");
  if (runtimes.n.buildIdSha256 === runtimes.nMinusOne.buildIdSha256) {
    throw new JsonCompatibilityCampaignError(
      "[plan] runtime N and N-1 build IDs must differ",
    );
  }
  if (runtimes.n.imageDigest === runtimes.nMinusOne.imageDigest) {
    throw new JsonCompatibilityCampaignError(
      "[plan] runtime N and N-1 image digests must differ",
    );
  }

  const ring = requireRecord(value.ring, "[plan] ring");
  requireExactKeys(
    ring,
    ["generation", "shardCount", "candidateShardIndex"],
    "[plan] ring",
  );
  requireInteger(ring.generation, 1, Number.MAX_SAFE_INTEGER, "[plan] ring generation");
  requireEqual(
    ring.shardCount,
    JSON_COMPATIBILITY_SHARD_COUNT,
    "[plan] JSON compatibility shard count",
  );
  requireInteger(
    ring.candidateShardIndex,
    0,
    ring.shardCount - 1,
    "[plan] candidate shard index",
  );

  validateConstraints(value.constraints, ring.shardCount);
  validatePlanPhases(value.phases, ring.candidateShardIndex);
  validateExecutionBoundary(value.executionBoundary);
  return value;
}

export function verifyJsonCompatibilityCampaignEvidence(
  plan,
  evidence,
  { allowSynthetic = false } = {},
) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const value = requireRecord(evidence, "[evidence] document");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "evidenceSource",
    "campaignIdSha256",
    "planDigestSha256",
    "sourceManifestSha256",
    "status",
    "capturedAt",
    "controller",
    "runtimes",
    "phases",
    "aggregate",
  ], "[evidence] document");
  requireEqual(value.schemaVersion, 1, "[evidence] schema version");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_EVIDENCE_CONTRACT,
    "[evidence] contract",
  );
  requireEqual(
    value.kind,
    "container-runtime-json-compatibility-evidence",
    "[evidence] kind",
  );
  requireEqual(value.environment, "staging", "[evidence] environment");
  if (
    value.evidenceSource !== "remote-staging" &&
    !(allowSynthetic && value.evidenceSource === "synthetic-self-test")
  ) {
    throw new JsonCompatibilityCampaignError(
      "[evidence] source must be remote-staging",
    );
  }
  requireEqual(
    value.campaignIdSha256,
    validatedPlan.campaignIdSha256,
    "[evidence] campaign ID",
  );
  requireEqual(
    value.planDigestSha256,
    validatedPlan.planDigestSha256,
    "[evidence] plan digest",
  );
  requireSha256(value.sourceManifestSha256, "[evidence] source manifest digest");
  requireEqual(value.status, "pass", "[evidence] status");
  const capturedAtMs = parseWholeSecondUtc(value.capturedAt, "[evidence] captured at");

  requireCanonicalEqual(
    value.controller,
    validatedPlan.controller,
    "[evidence] Controller identity",
  );
  requireCanonicalEqual(
    value.runtimes,
    validatedPlan.runtimes,
    "[evidence] runtime identities",
  );

  if (!Array.isArray(value.phases) || value.phases.length !== JSON_COMPATIBILITY_PHASE_IDS.length) {
    throw new JsonCompatibilityCampaignError(
      `[evidence] phases must contain exactly ${JSON_COMPATIBILITY_PHASE_IDS.length} entries`,
    );
  }
  const baselineDigests = new Map();
  const seenRawDigests = new Map();
  let previousCompletedAtMs = null;
  let controllerDeploymentSetSha256 = null;
  let observationCount = 0;
  for (let index = 0; index < value.phases.length; index += 1) {
    const expectedPlanPhase = validatedPlan.phases[index];
    const result = validateEvidencePhase({
      phase: value.phases[index],
      expectedPlanPhase,
      plan: validatedPlan,
      previousCompletedAtMs,
      baselineDigests,
      seenRawDigests,
      controllerDeploymentSetSha256,
    });
    previousCompletedAtMs = result.completedAtMs;
    controllerDeploymentSetSha256 = result.controllerDeploymentSetSha256;
    observationCount += result.observationCount;
  }
  if (previousCompletedAtMs === null || capturedAtMs < previousCompletedAtMs) {
    throw new JsonCompatibilityCampaignError(
      "[evidence] captured time must not precede phase completion",
    );
  }
  validateAggregate(value.aggregate, validatedPlan, observationCount);

  return {
    ok: true,
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EVIDENCE_CONTRACT,
    mode: "offline-verification",
    evidenceSource: value.evidenceSource,
    environment: "staging",
    campaignIdSha256: value.campaignIdSha256,
    planDigestSha256: value.planDigestSha256,
    phaseCount: value.phases.length,
    shardCount: validatedPlan.ring.shardCount,
    privateServiceCount: Object.keys(validatedPlan.privateServices).length,
    privateServicesBound: true,
    observationCount,
    jsonByteCompatibilityPassed: true,
    rollbackLedgerConverged: true,
    protobufAttemptCount: 0,
    legacyJsonFallbackCount: 0,
    providerRequestCount: 0,
    billingMutationCount: 0,
    storageGatewayMutationCount: 0,
    productionTrafficRequestCount: 0,
    publicProbeRequestCount: 0,
    credentialsRead: false,
    networkRequestsPerformed: false,
    filesWritten: false,
    deploymentMutationPerformed: false,
  };
}

export function createSyntheticJsonCompatibilityEvidence(plan) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const controllerDeploymentSetSha256 = sha256Text(
    "synthetic-controller-deployment-set",
  );
  const phases = validatedPlan.phases.map((planPhase, index) => {
    const startedAt = new Date(Date.UTC(2026, 7, 3, 0, index * 2, 0));
    const completedAt = new Date(startedAt.getTime() + 60_000);
    const observations = Array.from(
      { length: validatedPlan.ring.shardCount },
      (_, shardIndex) => {
        const runtimeGeneration = expectedRuntimeForShard(
          planPhase.topology,
          shardIndex,
        );
        const runtime = runtimeIdentityForGeneration(
          validatedPlan.runtimes,
          runtimeGeneration,
        );
        const operationId = `json-compat-${index}-${shardIndex}`;
        const traceId = `json-compat-trace-${index}-${shardIndex}`;
        const digestRecord = createJsonHealthProbeDigestRecord(
          JSON.stringify({
            protocol_version: 1,
            operation_id: operationId,
            operation_kind: "health_probe",
            owner_generation: index + 1,
            owner_lease_expires_at: 1_800_000_120 + index,
            execution_deadline_at: 1_800_000_060 + index,
            provider_operation_id: `json-compat-provider-${index}-${shardIndex}`,
            admission_sha256: sha256Text(`admission-${index}-${shardIndex}`),
            input: {
              mode: "inline",
              sha256: sha256Text(""),
              size: 0,
              content_type: JSON_CONTENT_TYPE,
            },
            shard: {
              contract_version: 1,
              ring_generation: validatedPlan.ring.generation,
              shard_count: validatedPlan.ring.shardCount,
              shard_index: shardIndex,
              instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
            },
            trace_id: traceId,
          }),
          JSON.stringify({
            protocol_version: 1,
            operation_id: operationId,
            status: "completed",
            trace_id: traceId,
          }),
        );
        return {
          shardIndex,
          runtimeGeneration,
          runtimeBuildIdSha256: runtime.buildIdSha256,
          readiness: {
            statusCode: 200,
            contentType: JSON_CONTENT_TYPE,
            runtimeBuildIdSha256: runtime.buildIdSha256,
            protocolVersion: 1,
            shardContractVersion: 1,
            evidenceSha256: sha256Text(`readiness-${index}-${shardIndex}`),
          },
          healthProbe: {
            operationKind: "health_probe",
            statusCode: 200,
            requestContentType: JSON_CONTENT_TYPE,
            responseContentType: JSON_CONTENT_TYPE,
            ...digestRecord,
            selectedTransport: "json",
            effectiveTransport: "json",
            attemptCount: 1,
            legacyJsonFallbackCount: 0,
            outcome: "completed",
            recoveryRequired: false,
          },
        };
      },
    );
    const unchangedProviderDigest = sha256Text(`provider-${index}`);
    const unchangedBillingDigest = sha256Text(`billing-${index}`);
    const unchangedStorageGatewayDigest = sha256Text(`storage-gateway-${index}`);
    const unchangedTrafficDigest = sha256Text(`production-traffic-${index}`);
    return {
      ordinal: planPhase.ordinal,
      id: planPhase.id,
      status: "pass",
      startedAt: startedAt.toISOString().replace(".000Z", "Z"),
      completedAt: completedAt.toISOString().replace(".000Z", "Z"),
      controllerVersionId: validatedPlan.controller.versionId,
      controllerDeploymentSetSha256,
      containerDeploymentSetSha256: sha256Text(
        `synthetic-container-deployment-set-${index}`,
      ),
      topology: cloneJson(planPhase.topology),
      deploymentReadbackStable: true,
      ledgerConverged: true,
      observations,
      transportTotals: {
        evidenceSha256: sha256Text(`transport-${index}`),
        eventsObserved: validatedPlan.ring.shardCount,
        selectedJsonCount: validatedPlan.ring.shardCount,
        effectiveJsonCount: validatedPlan.ring.shardCount,
        protobufAttemptCount: 0,
        legacyJsonFallbackCount: 0,
        recoveryRequiredCount: 0,
      },
      zeroMutationProof: {
        evidenceSha256: sha256Text(`zero-mutation-${index}`),
        providerBeforeSha256: unchangedProviderDigest,
        providerAfterSha256: unchangedProviderDigest,
        billingBeforeSha256: unchangedBillingDigest,
        billingAfterSha256: unchangedBillingDigest,
        storageGatewayBeforeSha256: unchangedStorageGatewayDigest,
        storageGatewayAfterSha256: unchangedStorageGatewayDigest,
        productionTrafficBeforeSha256: unchangedTrafficDigest,
        productionTrafficAfterSha256: unchangedTrafficDigest,
        providerRequestCount: 0,
        billingMutationCount: 0,
        storageGatewayMutationCount: 0,
        productionTrafficRequestCount: 0,
        publicProbeRequestCount: 0,
      },
    };
  });
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EVIDENCE_CONTRACT,
    kind: "container-runtime-json-compatibility-evidence",
    environment: "staging",
    evidenceSource: "synthetic-self-test",
    campaignIdSha256: validatedPlan.campaignIdSha256,
    planDigestSha256: validatedPlan.planDigestSha256,
    sourceManifestSha256: sha256Text("synthetic-source-manifest"),
    status: "pass",
    capturedAt: "2026-08-03T00:08:00Z",
    controller: cloneJson(validatedPlan.controller),
    runtimes: cloneJson(validatedPlan.runtimes),
    phases,
    aggregate: {
      phaseCount: JSON_COMPATIBILITY_PHASE_IDS.length,
      observationCount:
        JSON_COMPATIBILITY_PHASE_IDS.length * validatedPlan.ring.shardCount,
      controllerVersionCount: 1,
      runtimeBuildCount: 2,
      protobufAttemptCount: 0,
      legacyJsonFallbackCount: 0,
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
      allShardsObserved: true,
      jsonByteCompatibilityPassed: true,
      rollbackLedgerConverged: true,
    },
  };
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value) {
  return sha256Text(canonicalJson(value));
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function validateEvidencePhase({
  phase,
  expectedPlanPhase,
  plan,
  previousCompletedAtMs,
  baselineDigests,
  seenRawDigests,
  controllerDeploymentSetSha256,
}) {
  const value = requireRecord(phase, `[evidence] phase ${expectedPlanPhase.id}`);
  requireExactKeys(value, [
    "ordinal",
    "id",
    "status",
    "startedAt",
    "completedAt",
    "controllerVersionId",
    "controllerDeploymentSetSha256",
    "containerDeploymentSetSha256",
    "topology",
    "deploymentReadbackStable",
    "ledgerConverged",
    "observations",
    "transportTotals",
    "zeroMutationProof",
  ], `[evidence] phase ${expectedPlanPhase.id}`);
  requireEqual(value.ordinal, expectedPlanPhase.ordinal, `[evidence] ${expectedPlanPhase.id} ordinal`);
  requireEqual(value.id, expectedPlanPhase.id, `[evidence] phase ID`);
  requireEqual(value.status, "pass", `[evidence] ${value.id} status`);
  const startedAtMs = parseWholeSecondUtc(value.startedAt, `[evidence] ${value.id} start`);
  const completedAtMs = parseWholeSecondUtc(value.completedAt, `[evidence] ${value.id} completion`);
  if (completedAtMs < startedAtMs) {
    throw new JsonCompatibilityCampaignError(
      `[evidence] ${value.id} completion precedes start`,
    );
  }
  if (previousCompletedAtMs !== null && startedAtMs < previousCompletedAtMs) {
    throw new JsonCompatibilityCampaignError(
      `[evidence] ${value.id} overlaps the previous phase`,
    );
  }
  requireEqual(
    value.controllerVersionId,
    plan.controller.versionId,
    `[evidence] ${value.id} Controller version`,
  );
  requireSha256(
    value.controllerDeploymentSetSha256,
    `[evidence] ${value.id} Controller deployment set`,
  );
  requireSha256(
    value.containerDeploymentSetSha256,
    `[evidence] ${value.id} container deployment set`,
  );
  if (
    controllerDeploymentSetSha256 !== null &&
    value.controllerDeploymentSetSha256 !== controllerDeploymentSetSha256
  ) {
    throw new JsonCompatibilityCampaignError(
      `[evidence] ${value.id} Controller deployment drifted`,
    );
  }
  requireCanonicalEqual(
    value.topology,
    expectedPlanPhase.topology,
    `[evidence] ${value.id} topology`,
  );
  requireEqual(
    value.deploymentReadbackStable,
    true,
    `[evidence] ${value.id} deployment readback`,
  );
  requireEqual(value.ledgerConverged, true, `[evidence] ${value.id} ledger convergence`);

  if (!Array.isArray(value.observations) || value.observations.length !== plan.ring.shardCount) {
    throw new JsonCompatibilityCampaignError(
      `[evidence] ${value.id} must contain exactly ${plan.ring.shardCount} shard observations`,
    );
  }
  for (let shardIndex = 0; shardIndex < plan.ring.shardCount; shardIndex += 1) {
    validateShardObservation({
      observation: value.observations[shardIndex],
      phaseId: value.id,
      topology: value.topology,
      runtimes: plan.runtimes,
      shardIndex,
      baselineDigests,
      seenRawDigests,
      isBaseline: expectedPlanPhase.ordinal === 1,
    });
  }
  validateTransportTotals(value.transportTotals, plan.ring.shardCount, value.id);
  validateZeroMutationProof(value.zeroMutationProof, value.id);
  return {
    completedAtMs,
    controllerDeploymentSetSha256: value.controllerDeploymentSetSha256,
    observationCount: value.observations.length,
  };
}

function validateShardObservation({
  observation,
  phaseId,
  topology,
  runtimes,
  shardIndex,
  baselineDigests,
  seenRawDigests,
  isBaseline,
}) {
  const label = `[evidence] ${phaseId} shard ${shardIndex}`;
  const value = requireRecord(observation, label);
  requireExactKeys(value, [
    "shardIndex",
    "runtimeGeneration",
    "runtimeBuildIdSha256",
    "readiness",
    "healthProbe",
  ], label);
  requireEqual(value.shardIndex, shardIndex, `${label} index`);
  const expectedGeneration = expectedRuntimeForShard(topology, shardIndex);
  requireEqual(value.runtimeGeneration, expectedGeneration, `${label} runtime generation`);
  const expectedRuntime = runtimeIdentityForGeneration(runtimes, expectedGeneration);
  requireEqual(
    value.runtimeBuildIdSha256,
    expectedRuntime.buildIdSha256,
    `${label} runtime build ID`,
  );

  const readiness = requireRecord(value.readiness, `${label} readiness`);
  requireExactKeys(readiness, [
    "statusCode",
    "contentType",
    "runtimeBuildIdSha256",
    "protocolVersion",
    "shardContractVersion",
    "evidenceSha256",
  ], `${label} readiness`);
  requireEqual(readiness.statusCode, 200, `${label} readiness status`);
  requireEqual(readiness.contentType, JSON_CONTENT_TYPE, `${label} readiness content type`);
  requireEqual(
    readiness.runtimeBuildIdSha256,
    expectedRuntime.buildIdSha256,
    `${label} readiness build ID`,
  );
  requireEqual(readiness.protocolVersion, 1, `${label} protocol version`);
  requireEqual(readiness.shardContractVersion, 1, `${label} shard contract version`);
  requireSha256(readiness.evidenceSha256, `${label} readiness evidence`);

  const probe = requireRecord(value.healthProbe, `${label} health probe`);
  requireExactKeys(probe, [
    "operationKind",
    "statusCode",
    "requestContentType",
    "responseContentType",
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
  ], `${label} health probe`);
  requireEqual(probe.operationKind, "health_probe", `${label} operation kind`);
  requireEqual(probe.statusCode, 200, `${label} health status`);
  requireEqual(probe.requestContentType, JSON_CONTENT_TYPE, `${label} request content type`);
  requireEqual(probe.responseContentType, JSON_CONTENT_TYPE, `${label} response content type`);
  requireSha256(probe.requestSha256, `${label} request digest`);
  requireSha256(probe.responseSha256, `${label} response digest`);
  const seen = seenRawDigests.get(shardIndex) ?? {
    request: new Set(),
    response: new Set(),
  };
  if (seen.request.has(probe.requestSha256)) {
    throw new JsonCompatibilityCampaignError(
      `${label} raw request digest was reused across phases`,
    );
  }
  if (seen.response.has(probe.responseSha256)) {
    throw new JsonCompatibilityCampaignError(
      `${label} raw response digest was reused across phases`,
    );
  }
  seen.request.add(probe.requestSha256);
  seen.response.add(probe.responseSha256);
  seenRawDigests.set(shardIndex, seen);
  requireSha256(
    probe.requestCompatibilitySha256,
    `${label} request compatibility digest`,
  );
  requireSha256(
    probe.responseCompatibilitySha256,
    `${label} response compatibility digest`,
  );
  requireEqual(probe.selectedTransport, "json", `${label} selected transport`);
  requireEqual(probe.effectiveTransport, "json", `${label} effective transport`);
  requireEqual(probe.attemptCount, 1, `${label} attempt count`);
  requireEqual(probe.legacyJsonFallbackCount, 0, `${label} legacy fallback count`);
  requireEqual(probe.outcome, "completed", `${label} outcome`);
  requireEqual(probe.recoveryRequired, false, `${label} recovery requirement`);

  if (isBaseline) {
    baselineDigests.set(shardIndex, {
      requestCompatibilitySha256: probe.requestCompatibilitySha256,
      responseCompatibilitySha256: probe.responseCompatibilitySha256,
    });
    return;
  }
  const baseline = baselineDigests.get(shardIndex);
  if (
    baseline?.requestCompatibilitySha256 !== probe.requestCompatibilitySha256 ||
    baseline?.responseCompatibilitySha256 !== probe.responseCompatibilitySha256
  ) {
    throw new JsonCompatibilityCampaignError(
      `${label} normalized JSON compatibility projection drifted from N-1 baseline`,
    );
  }
}

function validateTransportTotals(value, shardCount, phaseId) {
  const totals = requireRecord(value, `[evidence] ${phaseId} transport totals`);
  requireExactKeys(totals, [
    "evidenceSha256",
    "eventsObserved",
    "selectedJsonCount",
    "effectiveJsonCount",
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ], `[evidence] ${phaseId} transport totals`);
  requireSha256(totals.evidenceSha256, `[evidence] ${phaseId} telemetry digest`);
  for (const name of ["eventsObserved", "selectedJsonCount", "effectiveJsonCount"]) {
    requireEqual(totals[name], shardCount, `[evidence] ${phaseId} ${name}`);
  }
  for (const name of [
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ]) {
    requireEqual(totals[name], 0, `[evidence] ${phaseId} ${name}`);
  }
}

function validateZeroMutationProof(value, phaseId) {
  const proof = requireRecord(value, `[evidence] ${phaseId} zero-mutation proof`);
  requireExactKeys(proof, [
    "evidenceSha256",
    "providerBeforeSha256",
    "providerAfterSha256",
    "billingBeforeSha256",
    "billingAfterSha256",
    "storageGatewayBeforeSha256",
    "storageGatewayAfterSha256",
    "productionTrafficBeforeSha256",
    "productionTrafficAfterSha256",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ], `[evidence] ${phaseId} zero-mutation proof`);
  for (const name of [
    "evidenceSha256",
    "providerBeforeSha256",
    "providerAfterSha256",
    "billingBeforeSha256",
    "billingAfterSha256",
    "storageGatewayBeforeSha256",
    "storageGatewayAfterSha256",
    "productionTrafficBeforeSha256",
    "productionTrafficAfterSha256",
  ]) {
    requireSha256(proof[name], `[evidence] ${phaseId} ${name}`);
  }
  requireEqual(
    proof.providerAfterSha256,
    proof.providerBeforeSha256,
    `[evidence] ${phaseId} provider snapshot`,
  );
  requireEqual(
    proof.billingAfterSha256,
    proof.billingBeforeSha256,
    `[evidence] ${phaseId} billing snapshot`,
  );
  requireEqual(
    proof.storageGatewayAfterSha256,
    proof.storageGatewayBeforeSha256,
    `[evidence] ${phaseId} storage gateway snapshot`,
  );
  requireEqual(
    proof.productionTrafficAfterSha256,
    proof.productionTrafficBeforeSha256,
    `[evidence] ${phaseId} production traffic snapshot`,
  );
  for (const name of [
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ]) {
    requireEqual(proof[name], 0, `[evidence] ${phaseId} ${name}`);
  }
}

function validateAggregate(value, plan, observationCount) {
  const aggregate = requireRecord(value, "[evidence] aggregate");
  requireExactKeys(aggregate, [
    "phaseCount",
    "observationCount",
    "controllerVersionCount",
    "runtimeBuildCount",
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
    "allShardsObserved",
    "jsonByteCompatibilityPassed",
    "rollbackLedgerConverged",
  ], "[evidence] aggregate");
  requireEqual(aggregate.phaseCount, JSON_COMPATIBILITY_PHASE_IDS.length, "[evidence] phase count");
  requireEqual(aggregate.observationCount, observationCount, "[evidence] observation count");
  requireEqual(
    observationCount,
    JSON_COMPATIBILITY_PHASE_IDS.length * plan.ring.shardCount,
    "[evidence] expected observation count",
  );
  requireEqual(aggregate.controllerVersionCount, 1, "[evidence] Controller version count");
  requireEqual(aggregate.runtimeBuildCount, 2, "[evidence] runtime build count");
  for (const name of [
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ]) {
    requireEqual(aggregate[name], 0, `[evidence] aggregate ${name}`);
  }
  for (const name of [
    "allShardsObserved",
    "jsonByteCompatibilityPassed",
    "rollbackLedgerConverged",
  ]) {
    requireEqual(aggregate[name], true, `[evidence] aggregate ${name}`);
  }
}

function validateControllerIdentity(value, label) {
  const controller = requireRecord(value, label);
  requireExactKeys(controller, [
    "serviceName",
    "versionId",
    "configSha256",
    "privateProbeTransport",
    "jsonCompatibilityProbeEnabled",
    "workersDev",
    "previewUrls",
    "observabilitySamplingRate",
    "protobufTransportEnabled",
    "protobufTransportStagingVerified",
    "allActionGatesDisabled",
  ], label);
  requireEqual(
    controller.serviceName,
    "cinatoken-container-controller-staging",
    `${label} service name`,
  );
  requireToken(controller.versionId, `${label} version ID`);
  requireSha256(controller.configSha256, `${label} config digest`);
  requireEqual(controller.privateProbeTransport, "service-binding", `${label} probe transport`);
  requireEqual(
    controller.jsonCompatibilityProbeEnabled,
    true,
    `${label} isolated JSON probe gate`,
  );
  requireEqual(controller.workersDev, false, `${label} workers_dev`);
  requireEqual(controller.previewUrls, false, `${label} preview URLs`);
  requireEqual(controller.observabilitySamplingRate, 1, `${label} sampling rate`);
  requireEqual(controller.protobufTransportEnabled, false, `${label} Protobuf gate`);
  requireEqual(
    controller.protobufTransportStagingVerified,
    false,
    `${label} Protobuf staging gate`,
  );
  requireEqual(controller.allActionGatesDisabled, true, `${label} action gates`);
  return controller;
}

function validateRuntimeSet(value, label) {
  const runtimes = requireRecord(value, label);
  requireExactKeys(runtimes, ["n", "nMinusOne"], label);
  return {
    n: validateRuntimeIdentity(runtimes.n, `${label} N`),
    nMinusOne: validateRuntimeIdentity(runtimes.nMinusOne, `${label} N-1`),
  };
}

function validatePrivateServices(value, label, includeCaller) {
  const services = requireRecord(value, label);
  const roles = includeCaller
    ? ["caller", "runner", "operator", "invoker", "permitIssuer", "executor"]
    : ["runner", "operator", "invoker", "permitIssuer", "executor"];
  requireExactKeys(
    services,
    roles,
    label,
  );
  for (const role of roles) {
    const definition = PRIVATE_SERVICE_DEFINITIONS[role];
    validatePrivateServiceIdentity(
      services[role],
      definition,
      `${label} ${role}`,
    );
  }
  return services;
}

function validateOperatorApprovalPolicy(value) {
  const policy = requireRecord(value, "[plan] operator approval policy");
  requireExactKeys(policy, [
    "schemaVersion",
    "contract",
    "algorithm",
    "issuer",
    "audience",
    "keyId",
    "signerSpkiSha256",
    "maxLifetimeSeconds",
    "minimumRemainingLifetimeSeconds",
  ], "[plan] operator approval policy");
  requireEqual(policy.schemaVersion, 1, "[plan] operator approval schema");
  requireEqual(
    policy.contract,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_POLICY_CONTRACT,
    "[plan] operator approval contract",
  );
  requireEqual(policy.algorithm, "Ed25519", "[plan] operator approval algorithm");
  requireEqual(
    policy.issuer,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    "[plan] operator approval issuer",
  );
  requireEqual(
    policy.audience,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE,
    "[plan] operator approval audience",
  );
  requireKeyId(policy.keyId, "[plan] operator approval key ID");
  requireSha256(
    policy.signerSpkiSha256,
    "[plan] operator approval SPKI digest",
  );
  requireEqual(
    policy.maxLifetimeSeconds,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS,
    "[plan] operator approval maximum lifetime",
  );
  requireEqual(
    policy.minimumRemainingLifetimeSeconds,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_MIN_REMAINING_SECONDS,
    "[plan] operator approval minimum remaining lifetime",
  );
  return policy;
}

function validateStatusRecoveryPolicy(value, includeCaller) {
  const policy = requireRecord(value, "[plan] status recovery policy");
  requireExactKeys(policy, [
    "schemaVersion",
    "contract",
    "mode",
    "approvalRecoveryWindowSeconds",
    "statusQueryLifetimeSeconds",
    "clockSkewSeconds",
    "executionRetryPermitted",
    "statusReadGates",
    "statusAuthority",
  ], "[plan] status recovery policy");
  requireEqual(policy.schemaVersion, 1, "[plan] status recovery schema");
  requireEqual(
    policy.contract,
    JSON_COMPATIBILITY_STATUS_RECOVERY_POLICY_CONTRACT,
    "[plan] status recovery contract",
  );
  requireEqual(
    policy.mode,
    "read-only-status-recovery",
    "[plan] status recovery mode",
  );
  requireEqual(
    policy.approvalRecoveryWindowSeconds,
    JSON_COMPATIBILITY_STATUS_RECOVERY_WINDOW_SECONDS,
    "[plan] status recovery window",
  );
  requireEqual(
    policy.statusQueryLifetimeSeconds,
    JSON_COMPATIBILITY_STATUS_QUERY_LIFETIME_SECONDS,
    "[plan] status query lifetime",
  );
  requireEqual(
    policy.clockSkewSeconds,
    JSON_COMPATIBILITY_STATUS_CLOCK_SKEW_SECONDS,
    "[plan] status clock skew",
  );
  requireEqual(
    policy.executionRetryPermitted,
    false,
    "[plan] status execution retry permission",
  );
  const gates = requireRecord(
    policy.statusReadGates,
    "[plan] status read gates",
  );
  const expectedGates = [
    ...(includeCaller
      ? [["caller", "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED"]]
      : []),
    ["runner", "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED"],
    ["operator", "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED"],
    ["invoker", "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED"],
  ];
  requireExactKeys(
    gates,
    expectedGates.map(([role]) => role),
    "[plan] status read gates",
  );
  for (const [role, gateName] of expectedGates) {
    requireEqual(gates[role], gateName, `[plan] ${role} status read gate`);
  }
  const authority = requireRecord(
    policy.statusAuthority,
    "[plan] status authority",
  );
  requireExactKeys(authority, [
    "algorithm",
    "execution",
    "status",
  ], "[plan] status authority");
  requireEqual(authority.algorithm, "HMAC-SHA-256", "[plan] status HMAC");
  const execution = validatePlannedHmacIdentity(
    authority.execution,
    JSON_COMPATIBILITY_OPERATOR_HMAC_ISSUER,
    "[plan] execution HMAC authority",
  );
  const status = validatePlannedHmacIdentity(
    authority.status,
    JSON_COMPATIBILITY_OPERATOR_STATUS_HMAC_ISSUER,
    "[plan] status HMAC authority",
  );
  if (execution.keyId === status.keyId) {
    throw new JsonCompatibilityCampaignError(
      "[plan] execution and status HMAC key IDs must differ",
    );
  }
  if (execution.credentialIdSha256 === status.credentialIdSha256) {
    throw new JsonCompatibilityCampaignError(
      "[plan] execution and status HMAC credential digests must differ",
    );
  }
  return policy;
}

function validateDeploymentStateBinding(
  value,
  controller,
  privateServices,
  includeCaller,
) {
  const binding = requireRecord(value, "[plan] deployment state binding");
  requireExactKeys(binding, [
    "schemaVersion",
    "contract",
    "deploymentStatePlanContract",
    "planDigestSha256",
    "initialState",
    "executionState",
    "recoveryState",
    "finalState",
    "directDarkToExecutionAllowed",
    "directExecutionToDarkAllowed",
    "executionArtifacts",
  ], "[plan] deployment state binding");
  requireEqual(
    binding.schemaVersion,
    1,
    "[plan] deployment state binding schema",
  );
  requireEqual(
    binding.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_STATE_BINDING_CONTRACT,
    "[plan] deployment state binding contract",
  );
  requireEqual(
    binding.deploymentStatePlanContract,
    includeCaller
      ? JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT
      : JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_V1_CONTRACT,
    "[plan] deployment state plan contract",
  );
  requireSha256(
    binding.planDigestSha256,
    "[plan] deployment state plan digest",
  );
  requireEqual(binding.initialState, "dark", "[plan] deployment initial state");
  requireEqual(
    binding.executionState,
    "execution",
    "[plan] deployment execution state",
  );
  requireEqual(
    binding.recoveryState,
    "statusOnly",
    "[plan] deployment recovery state",
  );
  requireEqual(binding.finalState, "dark", "[plan] deployment final state");
  requireEqual(
    binding.directDarkToExecutionAllowed,
    false,
    "[plan] direct dark-to-execution transition",
  );
  requireEqual(
    binding.directExecutionToDarkAllowed,
    false,
    "[plan] direct execution-to-dark transition",
  );
  const artifacts = requireRecord(
    binding.executionArtifacts,
    "[plan] deployment execution artifacts",
  );
  const roles = [
    "controller",
    ...(includeCaller ? ["caller"] : []),
    "runner",
    "operator",
    "invoker",
    "permitIssuer",
    "executor",
  ];
  requireExactKeys(
    artifacts,
    roles,
    "[plan] deployment execution artifacts",
  );
  requireCanonicalEqual(
    artifacts.controller,
    {
      versionId: controller.versionId,
      configSha256: controller.configSha256,
    },
    "[plan] Controller deployment execution artifact",
  );
  for (const role of [
    ...(includeCaller ? ["caller"] : []),
    "runner",
    "operator",
    "invoker",
    "permitIssuer",
    "executor",
  ]) {
    requireCanonicalEqual(
      artifacts[role],
      executionArtifact(privateServices[role]),
      `[plan] ${role} deployment execution artifact`,
    );
  }
  return binding;
}

function validatePlannedHmacIdentity(value, expectedIssuer, label) {
  const identity = requireRecord(value, label);
  requireExactKeys(
    identity,
    ["issuer", "audience", "keyId", "credentialIdSha256"],
    label,
  );
  requireEqual(identity.issuer, expectedIssuer, `${label} issuer`);
  requireEqual(
    identity.audience,
    JSON_COMPATIBILITY_INVOKER_HMAC_AUDIENCE,
    `${label} audience`,
  );
  requireKeyId(identity.keyId, `${label} key ID`);
  requireSha256(identity.credentialIdSha256, `${label} credential digest`);
  return identity;
}

function validatePrivateServiceIdentity(value, definition, label) {
  const service = requireRecord(value, label);
  requireExactKeys(service, [
    "serviceName",
    "entrypoint",
    "versionId",
    "configSha256",
    "gateName",
    "privateRpcOnly",
  ], label);
  requireEqual(service.serviceName, definition.serviceName, `${label} service name`);
  requireEqual(service.entrypoint, definition.entrypoint, `${label} entrypoint`);
  requireToken(service.versionId, `${label} version ID`);
  requireSha256(service.configSha256, `${label} config digest`);
  requireEqual(service.gateName, definition.gateName, `${label} gate name`);
  requireEqual(service.privateRpcOnly, true, `${label} private RPC requirement`);
  return service;
}

function normalizePrivateServiceIdentity(
  definition,
  versionId,
  configSha256,
  label,
) {
  requireToken(versionId, `${label} version ID`);
  requireSha256(configSha256, `${label} config digest`);
  return {
    serviceName: definition.serviceName,
    entrypoint: definition.entrypoint,
    versionId,
    configSha256,
    gateName: definition.gateName,
    privateRpcOnly: true,
  };
}

function executionArtifact(service) {
  return {
    versionId: service.versionId,
    configSha256: service.configSha256,
  };
}

function validateRuntimeIdentity(value, label) {
  const runtime = requireRecord(value, label);
  requireExactKeys(runtime, ["buildIdSha256", "imageDigest"], label);
  requireSha256(runtime.buildIdSha256, `${label} build ID`);
  requireOciDigest(runtime.imageDigest, `${label} image digest`);
  return runtime;
}

function normalizeRuntimeIdentity(buildIdSha256, imageDigest, label) {
  requireSha256(buildIdSha256, `${label} build ID`);
  requireOciDigest(imageDigest, `${label} image digest`);
  return { buildIdSha256, imageDigest };
}

function validateConstraints(value, shardCount) {
  const constraints = requireRecord(value, "[plan] constraints");
  requireExactKeys(constraints, [
    "operationKind",
    "requestContentType",
    "responseContentType",
    "exactProbeCountPerPhase",
    "protobufAttemptsAllowed",
    "legacyJsonFallbacksAllowed",
    "providerRequestsAllowed",
    "billingMutationsAllowed",
    "storageGatewayMutationsAllowed",
    "productionTrafficRequestsAllowed",
    "publicProbeRequestsAllowed",
  ], "[plan] constraints");
  requireEqual(constraints.operationKind, "health_probe", "[plan] operation kind");
  requireEqual(constraints.requestContentType, JSON_CONTENT_TYPE, "[plan] request content type");
  requireEqual(constraints.responseContentType, JSON_CONTENT_TYPE, "[plan] response content type");
  requireEqual(constraints.exactProbeCountPerPhase, shardCount, "[plan] probes per phase");
  for (const name of [
    "protobufAttemptsAllowed",
    "legacyJsonFallbacksAllowed",
    "providerRequestsAllowed",
    "billingMutationsAllowed",
    "storageGatewayMutationsAllowed",
    "productionTrafficRequestsAllowed",
    "publicProbeRequestsAllowed",
  ]) {
    requireEqual(constraints[name], 0, `[plan] ${name}`);
  }
}

function validatePlanPhases(value, candidateShardIndex) {
  if (!Array.isArray(value) || value.length !== JSON_COMPATIBILITY_PHASE_IDS.length) {
    throw new JsonCompatibilityCampaignError(
      `[plan] phases must contain exactly ${JSON_COMPATIBILITY_PHASE_IDS.length} entries`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const phase = requireRecord(value[index], `[plan] phase ${index + 1}`);
    requireExactKeys(
      phase,
      ["ordinal", "id", "topology", "requiredChecks"],
      `[plan] phase ${index + 1}`,
    );
    const expectedId = JSON_COMPATIBILITY_PHASE_IDS[index];
    requireEqual(phase.ordinal, index + 1, `[plan] ${expectedId} ordinal`);
    requireEqual(phase.id, expectedId, `[plan] phase ${index + 1} ID`);
    requireCanonicalEqual(
      phase.topology,
      topologyForPhase(expectedId, candidateShardIndex),
      `[plan] ${expectedId} topology`,
    );
    requireCanonicalEqual(phase.requiredChecks, REQUIRED_CHECKS, `[plan] ${expectedId} checks`);
  }
}

function validateExecutionBoundary(value) {
  const boundary = requireRecord(value, "[plan] execution boundary");
  requireExactKeys(boundary, [
    "credentialsRead",
    "networkRequestsPerformed",
    "filesWritten",
    "deploymentMutationAuthorized",
    "deploymentMutationPerformed",
    "activationGateChangeAuthorized",
    "remoteEvidenceCollected",
    "privateProbeExecutorRequired",
    "publicUrlAllowed",
  ], "[plan] execution boundary");
  for (const name of [
    "credentialsRead",
    "networkRequestsPerformed",
    "filesWritten",
    "deploymentMutationAuthorized",
    "deploymentMutationPerformed",
    "activationGateChangeAuthorized",
    "remoteEvidenceCollected",
    "publicUrlAllowed",
  ]) {
    requireEqual(boundary[name], false, `[plan] ${name}`);
  }
  requireEqual(
    boundary.privateProbeExecutorRequired,
    true,
    "[plan] private probe executor requirement",
  );
}

function topologyForPhase(phaseId, candidateShardIndex) {
  switch (phaseId) {
    case "baseline-n-minus-one":
    case "rollback-n-minus-one":
      return { defaultRuntime: RUNTIME_N_MINUS_ONE, overrides: [] };
    case "mixed-n-n-minus-one":
      return {
        defaultRuntime: RUNTIME_N_MINUS_ONE,
        overrides: [{ shardIndex: candidateShardIndex, runtime: RUNTIME_N }],
      };
    case "candidate-n":
      return { defaultRuntime: RUNTIME_N, overrides: [] };
    default:
      throw new JsonCompatibilityCampaignError(`[plan] unsupported phase ${phaseId}`);
  }
}

function expectedRuntimeForShard(topology, shardIndex) {
  const override = topology.overrides.find((entry) => entry.shardIndex === shardIndex);
  return override?.runtime ?? topology.defaultRuntime;
}

function runtimeIdentityForGeneration(runtimes, generation) {
  if (generation === RUNTIME_N) return runtimes.n;
  if (generation === RUNTIME_N_MINUS_ONE) return runtimes.nMinusOne;
  throw new JsonCompatibilityCampaignError(
    `[evidence] unsupported runtime generation ${generation}`,
  );
}

function requireConfiguredInteger(value, minimum, maximum, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a decimal integer string`);
  }
  return requireInteger(Number(value), minimum, maximum, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JsonCompatibilityCampaignError(
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new JsonCompatibilityCampaignError(
      `${label} fields must be exactly ${wanted.join(", ")}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new JsonCompatibilityCampaignError(`${label} must equal ${String(expected)}`);
  }
  return actual;
}

function requireCanonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new JsonCompatibilityCampaignError(`${label} does not match the approved plan`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function requireKeyId(value, label) {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a key ID`);
  }
  return value;
}

function requireOciDigest(value, label) {
  if (typeof value !== "string" || !OCI_DIGEST_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a sha256 OCI digest`);
  }
  return value;
}

function requireToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a safe opaque token`);
  }
  return value;
}

function parseWholeSecondUtc(value, label) {
  if (typeof value !== "string" || !WHOLE_SECOND_UTC_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be whole-second UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a valid timestamp`);
  }
  return milliseconds;
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonCompatibilityCampaignError("canonical JSON cannot contain non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new JsonCompatibilityCampaignError("canonical JSON cannot contain undefined");
      }
      result[key] = canonicalize(child);
    }
    return result;
  }
  throw new JsonCompatibilityCampaignError("canonical JSON contains an unsupported value");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new JsonCompatibilityCampaignError(`${label} must be UTF-8 text bytes`);
}

function parseJsonBytes(value, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new JsonCompatibilityCampaignError(`${label} must be valid UTF-8`);
  }
  return parseStrictJsonObject(text, label);
}
