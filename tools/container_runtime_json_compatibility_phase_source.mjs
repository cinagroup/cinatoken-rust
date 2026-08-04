import {
  JsonCompatibilityCampaignError,
  JSON_COMPATIBILITY_SHARD_COUNT,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
  validateJsonCompatibilityPhaseSourcePacket,
} from "./container_runtime_json_compatibility_source_manifest.mjs";
import {
  verifyJsonCompatibilityProbeResultDigests,
} from "../services/container-controller/src/json_compatibility_probe.ts";
import {
  bindJsonCompatibilityPrivateInvocationToExecutor,
  validateJsonCompatibilityPrivateInvocationReceipt,
} from "./container_runtime_json_compatibility_private_invocation.mjs";

export const JSON_COMPATIBILITY_PHASE_SOURCE_CONTEXT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-source-context-v1";
export const JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2";

const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const CONTROLLER_SERVICE = "cinatoken-container-controller-staging";
const CONTROLLER_ENTRYPOINT = "JsonCompatibilityProbeEntrypoint";
const SHARD_COUNT = JSON_COMPATIBILITY_SHARD_COUNT;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export async function buildJsonCompatibilityPhaseSourcePacket(
  plan,
  receipt,
  context,
) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  if (validatedPlan.ring.shardCount !== SHARD_COUNT) {
    throw failure("[phase-assembly] plan shard count must equal 8");
  }
  const verifiedInvocation = validateJsonCompatibilityPrivateInvocationReceipt(
    validatedPlan,
    receipt,
  );
  const verifiedReceipt = await validateProbeReceipt(
    validatedPlan,
    verifiedInvocation.executorReceipt,
  );
  const privateInvocation = bindJsonCompatibilityPrivateInvocationToExecutor(
    validatedPlan,
    verifiedInvocation,
    verifiedReceipt,
  );
  const verifiedContext = validateSourceContext(
    validatedPlan,
    context,
    verifiedReceipt,
  );
  const phase = validatedPlan.phases[verifiedReceipt.phase.ordinal - 1];
  const shards = verifiedReceipt.observations.map((observation) => {
    const result = observation.probeResult;
    const readinessFacts = {
      statusCode: result.readiness.statusCode,
      contentType: result.readiness.contentType,
      rawJson: result.readiness.rawJson,
      rawByteLength: result.readiness.rawByteLength,
      rawSha256: result.readiness.rawSha256,
      runtimeBuildIdSha256: result.readiness.runtimeBuildIdSha256,
      protocolVersion: result.readiness.protocolVersion,
      shardContractVersion: result.readiness.shardContractVersion,
      executionEnabled: result.readiness.executionEnabled,
    };
    return {
      shardIndex: observation.shardIndex,
      runtimeGeneration: observation.runtimeGeneration,
      runtimeBuildIdSha256: observation.runtimeBuildIdSha256,
      readiness: {
        ...readinessFacts,
        evidenceSha256: sha256Canonical(readinessFacts),
      },
      rawRequest: result.healthProbe.requestRawJson,
      rawResponse: result.healthProbe.responseRawJson,
      rawRequestSha256: result.healthProbe.requestSha256,
      rawResponseSha256: result.healthProbe.responseSha256,
      normalizedDigests: {
        requestCompatibilitySha256:
          result.healthProbe.requestCompatibilitySha256,
        responseCompatibilitySha256:
          result.healthProbe.responseCompatibilitySha256,
      },
      transportFacts: {
        operationKind: result.healthProbe.operationKind,
        statusCode: result.healthProbe.statusCode,
        requestContentType: result.healthProbe.requestContentType,
        responseContentType: result.healthProbe.responseContentType,
        selectedTransport: result.healthProbe.selectedTransport,
        effectiveTransport: result.healthProbe.effectiveTransport,
        attemptCount: result.healthProbe.attemptCount,
        protobufAttemptCount: 0,
        legacyJsonFallbackCount: result.healthProbe.legacyJsonFallbackCount,
        outcome: result.healthProbe.outcome,
        recoveryRequired: result.healthProbe.recoveryRequired,
      },
    };
  });
  const transportFacts = {
    eventsObserved: verifiedReceipt.transportTotals.completedProbeCount,
    selectedJsonCount: verifiedReceipt.transportTotals.selectedJsonCount,
    effectiveJsonCount: verifiedReceipt.transportTotals.effectiveJsonCount,
    protobufAttemptCount: verifiedReceipt.transportTotals.protobufAttemptCount,
    legacyJsonFallbackCount:
      verifiedReceipt.transportTotals.legacyJsonFallbackCount,
    recoveryRequiredCount:
      verifiedReceipt.transportTotals.recoveryRequiredCount,
  };
  const packetSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
    kind: "container-runtime-json-compatibility-phase-source-packet",
    environment: "staging",
    campaignIdSha256: validatedPlan.campaignIdSha256,
    planDigestSha256: validatedPlan.planDigestSha256,
    activity: {
      ordinal: phase.ordinal,
      id: phase.id,
      status: "pass",
      startedAt: verifiedContext.activity.startedAt,
      completedAt: verifiedContext.activity.completedAt,
      deploymentReadbackStable:
        verifiedContext.activity.deploymentReadbackStable,
      ledgerConverged: verifiedContext.activity.ledgerConverged,
    },
    controller: clone(verifiedContext.controller),
    runtimes: clone(validatedPlan.runtimes),
    ring: clone(validatedPlan.ring),
    topology: clone(phase.topology),
    containerDeploymentSetSha256:
      verifiedContext.containerDeploymentSetSha256,
    privateInvocation,
    executorReceipt: {
      contract: verifiedReceipt.contract,
      receiptSha256: verifiedReceipt.receiptSha256,
      campaignIdSha256: verifiedReceipt.campaignIdSha256,
      planDigestSha256: verifiedReceipt.planDigestSha256,
      phaseOrdinal: verifiedReceipt.phase.ordinal,
      phaseId: verifiedReceipt.phase.id,
      phaseExecutionId: verifiedReceipt.phaseExecutionId,
      executorServiceName: verifiedReceipt.executor.serviceName,
      executorVersionId: verifiedReceipt.executor.versionId,
      startedAt: verifiedReceipt.startedAt,
      completedAt: verifiedReceipt.completedAt,
      targetService: verifiedReceipt.transport.targetService,
      targetEntrypoint: verifiedReceipt.transport.targetEntrypoint,
      privateServiceBindingRpcCount:
        verifiedReceipt.transportTotals.privateServiceBindingRpcCount,
      publicUrlUsed: verifiedReceipt.transport.publicUrlUsed,
      cloudflareRestUsed: verifiedReceipt.transport.cloudflareRestUsed,
      executionBoundarySha256: sha256Canonical(
        verifiedReceipt.executionBoundary,
      ),
      authorization: clone(verifiedReceipt.authorization),
    },
    sourceContext: {
      contract: verifiedContext.contract,
      contextSha256: verifiedContext.contextSha256,
      receiptSha256: verifiedContext.receiptSha256,
    },
    shards,
    transportTotals: {
      ...transportFacts,
      evidenceSha256: sha256Canonical(transportFacts),
    },
    noMutationFacts: clone(verifiedContext.noMutationFacts),
  };
  const packet = {
    ...packetSubject,
    packetSha256: sha256Canonical(packetSubject),
  };
  return validateJsonCompatibilityPhaseSourcePacket(
    validatedPlan,
    packet,
    phase.ordinal,
  );
}

async function validateProbeReceipt(plan, input) {
  const value = record(input, "[phase-assembly] probe receipt");
  exactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "runtimes",
    "ring",
    "phase",
    "authorization",
    "executor",
    "transport",
    "startedAt",
    "completedAt",
    "observations",
    "transportTotals",
    "executionBoundary",
    "receiptSha256",
  ], "[phase-assembly] probe receipt");
  equal(value.schemaVersion, 2, "[phase-assembly] receipt schema version");
  equal(
    value.contract,
    JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
    "[phase-assembly] receipt contract",
  );
  equal(
    value.kind,
    "container-runtime-json-compatibility-phase-probe-receipt",
    "[phase-assembly] receipt kind",
  );
  equal(value.environment, "staging", "[phase-assembly] receipt environment");
  equal(
    value.campaignIdSha256,
    plan.campaignIdSha256,
    "[phase-assembly] receipt campaign ID",
  );
  equal(
    value.planDigestSha256,
    plan.planDigestSha256,
    "[phase-assembly] receipt plan digest",
  );
  safeToken(value.phaseExecutionId, "[phase-assembly] phase execution ID");
  validateReceiptController(value.controller, plan.controller);
  canonicalEqual(value.runtimes, plan.runtimes, "[phase-assembly] runtimes");
  canonicalEqual(value.ring, plan.ring, "[phase-assembly] ring");
  const phase = validateReceiptPhase(value.phase, plan);
  validateReceiptAuthorization(value.authorization, value, phase);
  validateReceiptExecutor(value.executor);
  validateReceiptTransport(value.transport);
  const startedAtMs = wholeSecond(value.startedAt, "[phase-assembly] receipt start");
  const completedAtMs = wholeSecond(
    value.completedAt,
    "[phase-assembly] receipt completion",
  );
  if (completedAtMs < startedAtMs) {
    throw failure("[phase-assembly] receipt completion precedes start");
  }
  if (!Array.isArray(value.observations) || value.observations.length !== SHARD_COUNT) {
    throw failure("[phase-assembly] receipt must contain exactly 8 observations");
  }
  const operationIds = new Set();
  const traceIds = new Set();
  for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex += 1) {
    const observation = record(
      value.observations[shardIndex],
      `[phase-assembly] shard ${shardIndex}`,
    );
    exactKeys(observation, [
      "shardIndex",
      "instanceName",
      "runtimeGeneration",
      "runtimeBuildIdSha256",
      "probeRequestCanonicalSha256",
      "probeResultCanonicalSha256",
      "probeResult",
    ], `[phase-assembly] shard ${shardIndex}`);
    equal(
      observation.shardIndex,
      shardIndex,
      `[phase-assembly] shard ${shardIndex} index`,
    );
    equal(
      observation.instanceName,
      `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
      `[phase-assembly] shard ${shardIndex} instance`,
    );
    const expectedRuntime = expectedRuntimeGeneration(
      phase.topology,
      shardIndex,
    );
    equal(
      observation.runtimeGeneration,
      expectedRuntime,
      `[phase-assembly] shard ${shardIndex} runtime generation`,
    );
    const runtime = expectedRuntime === "n" ? plan.runtimes.n : plan.runtimes.nMinusOne;
    equal(
      observation.runtimeBuildIdSha256,
      runtime.buildIdSha256,
      `[phase-assembly] shard ${shardIndex} runtime build ID`,
    );
    sha256(
      observation.probeRequestCanonicalSha256,
      `[phase-assembly] shard ${shardIndex} request digest`,
    );
    sha256(
      observation.probeResultCanonicalSha256,
      `[phase-assembly] shard ${shardIndex} result digest`,
    );
    const result = await verifyJsonCompatibilityProbeResultDigests(
      observation.probeResult,
    );
    equal(
      observation.probeRequestCanonicalSha256,
      sha256Canonical(result.request),
      `[phase-assembly] shard ${shardIndex} request canonical digest`,
    );
    equal(
      observation.probeResultCanonicalSha256,
      sha256Canonical(result),
      `[phase-assembly] shard ${shardIndex} result canonical digest`,
    );
    validateResultIdentity(result, plan, phase, observation, shardIndex);
    const resultStartedAtMs = wholeSecond(
      result.startedAt,
      `[phase-assembly] shard ${shardIndex} result start`,
    );
    const resultCompletedAtMs = wholeSecond(
      result.completedAt,
      `[phase-assembly] shard ${shardIndex} result completion`,
    );
    if (resultStartedAtMs < startedAtMs || resultCompletedAtMs > completedAtMs) {
      throw failure(
        `[phase-assembly] shard ${shardIndex} result falls outside receipt time bounds`,
      );
    }
    if (
      operationIds.has(result.request.operation.operationId) ||
      traceIds.has(result.request.operation.traceId)
    ) {
      throw failure("[phase-assembly] operation and trace identities must be unique");
    }
    operationIds.add(result.request.operation.operationId);
    traceIds.add(result.request.operation.traceId);
    observation.probeResult = result;
  }
  validateReceiptTransportTotals(value.transportTotals);
  validateExecutionBoundary(value.executionBoundary);
  sha256(value.receiptSha256, "[phase-assembly] receipt digest");
  const { receiptSha256, ...subject } = value;
  equal(
    receiptSha256,
    sha256Canonical(subject),
    "[phase-assembly] receipt canonical digest",
  );
  return value;
}

function validateSourceContext(plan, input, receipt) {
  const value = record(input, "[phase-assembly] source context");
  exactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseOrdinal",
    "phaseId",
    "receiptSha256",
    "activity",
    "controller",
    "containerDeploymentSetSha256",
    "noMutationFacts",
    "contextSha256",
  ], "[phase-assembly] source context");
  equal(value.schemaVersion, 1, "[phase-assembly] context schema version");
  equal(
    value.contract,
    JSON_COMPATIBILITY_PHASE_SOURCE_CONTEXT_CONTRACT,
    "[phase-assembly] context contract",
  );
  equal(
    value.kind,
    "container-runtime-json-compatibility-phase-source-context",
    "[phase-assembly] context kind",
  );
  equal(value.environment, "staging", "[phase-assembly] context environment");
  equal(value.campaignIdSha256, plan.campaignIdSha256, "[phase-assembly] context campaign ID");
  equal(value.planDigestSha256, plan.planDigestSha256, "[phase-assembly] context plan digest");
  equal(value.phaseOrdinal, receipt.phase.ordinal, "[phase-assembly] context phase ordinal");
  equal(value.phaseId, receipt.phase.id, "[phase-assembly] context phase ID");
  equal(value.receiptSha256, receipt.receiptSha256, "[phase-assembly] context receipt digest");
  const activity = record(value.activity, "[phase-assembly] context activity");
  exactKeys(activity, [
    "startedAt",
    "completedAt",
    "deploymentReadbackStable",
    "ledgerConverged",
  ], "[phase-assembly] context activity");
  const startedAtMs = wholeSecond(activity.startedAt, "[phase-assembly] context start");
  const completedAtMs = wholeSecond(
    activity.completedAt,
    "[phase-assembly] context completion",
  );
  if (
    startedAtMs > Date.parse(receipt.startedAt) ||
    completedAtMs < Date.parse(receipt.completedAt)
  ) {
    throw failure("[phase-assembly] context activity must enclose the probe receipt");
  }
  equal(activity.deploymentReadbackStable, true, "[phase-assembly] deployment readback");
  equal(activity.ledgerConverged, true, "[phase-assembly] ledger convergence");
  const controller = record(value.controller, "[phase-assembly] context Controller");
  exactKeys(
    controller,
    [...Object.keys(plan.controller), "deploymentSetSha256"],
    "[phase-assembly] context Controller",
  );
  const { deploymentSetSha256, ...controllerIdentity } = controller;
  canonicalEqual(
    controllerIdentity,
    plan.controller,
    "[phase-assembly] context Controller identity",
  );
  sha256(deploymentSetSha256, "[phase-assembly] Controller deployment set");
  sha256(
    value.containerDeploymentSetSha256,
    "[phase-assembly] container deployment set",
  );
  validateNoMutationFacts(value.noMutationFacts);
  sha256(value.contextSha256, "[phase-assembly] context digest");
  const { contextSha256, ...subject } = value;
  equal(
    contextSha256,
    sha256Canonical(subject),
    "[phase-assembly] context canonical digest",
  );
  return value;
}

function validateReceiptController(value, expected) {
  const controller = record(value, "[phase-assembly] receipt Controller");
  exactKeys(
    controller,
    ["serviceName", "versionId", "configSha256"],
    "[phase-assembly] receipt Controller",
  );
  equal(controller.serviceName, expected.serviceName, "[phase-assembly] Controller service");
  equal(controller.versionId, expected.versionId, "[phase-assembly] Controller version");
  equal(controller.configSha256, expected.configSha256, "[phase-assembly] Controller config");
}

function validateReceiptPhase(value, plan) {
  const phase = record(value, "[phase-assembly] receipt phase");
  exactKeys(phase, ["ordinal", "id", "topology"], "[phase-assembly] receipt phase");
  if (!Number.isSafeInteger(phase.ordinal) || phase.ordinal < 1 || phase.ordinal > 4) {
    throw failure("[phase-assembly] receipt phase ordinal is invalid");
  }
  const expected = plan.phases[phase.ordinal - 1];
  equal(phase.id, expected.id, "[phase-assembly] receipt phase ID");
  canonicalEqual(phase.topology, expected.topology, "[phase-assembly] receipt topology");
  return phase;
}

function validateReceiptExecutor(value) {
  const executor = record(value, "[phase-assembly] receipt executor");
  exactKeys(
    executor,
    ["serviceName", "versionId", "gateName", "maxConcurrency"],
    "[phase-assembly] receipt executor",
  );
  equal(executor.serviceName, EXECUTOR_SERVICE, "[phase-assembly] executor service");
  safeToken(executor.versionId, "[phase-assembly] executor version");
  equal(
    executor.gateName,
    "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
    "[phase-assembly] executor gate",
  );
  equal(executor.maxConcurrency, 4, "[phase-assembly] executor concurrency");
}

function validateReceiptAuthorization(value, receipt, phase) {
  const authorization = record(
    value,
    "[phase-assembly] receipt authorization",
  );
  exactKeys(authorization, [
    "kind",
    "algorithm",
    "permitIdSha256",
    "permitSubjectSha256",
    "permitEnvelopeSha256",
    "permitEnvelope",
    "issuer",
    "audience",
    "keyId",
    "signerSpkiSha256",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "campaignAuthority",
  ], "[phase-assembly] receipt authorization");
  equal(
    authorization.kind,
    "ed25519-signed-single-use-phase-permit",
    "[phase-assembly] authorization kind",
  );
  equal(
    authorization.algorithm,
    "Ed25519",
    "[phase-assembly] authorization algorithm",
  );
  for (const name of [
    "permitIdSha256",
    "permitSubjectSha256",
    "permitEnvelopeSha256",
    "signerSpkiSha256",
  ]) {
    sha256(
      authorization[name],
      `[phase-assembly] authorization ${name}`,
    );
  }
  safeToken(authorization.issuer, "[phase-assembly] authorization issuer");
  safeToken(authorization.audience, "[phase-assembly] authorization audience");
  safeToken(authorization.keyId, "[phase-assembly] authorization key ID");
  for (const name of ["issuedAt", "notBefore", "expiresAt"]) {
    if (!Number.isSafeInteger(authorization[name]) || authorization[name] < 1) {
      throw failure(`[phase-assembly] authorization ${name} is invalid`);
    }
  }
  if (
    authorization.notBefore < authorization.issuedAt - 5
    || authorization.expiresAt <= authorization.notBefore
    || authorization.expiresAt - authorization.issuedAt > 600
  ) {
    throw failure("[phase-assembly] authorization time window is invalid");
  }
  const envelope = record(
    authorization.permitEnvelope,
    "[phase-assembly] permit envelope",
  );
  exactKeys(envelope, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signatureBase64url",
  ], "[phase-assembly] permit envelope");
  equal(envelope.schemaVersion, 1, "[phase-assembly] permit envelope schema");
  equal(
    envelope.contract,
    "cinatoken-container-runtime-json-compatibility-phase-permit-envelope-v1",
    "[phase-assembly] permit envelope contract",
  );
  equal(envelope.algorithm, "Ed25519", "[phase-assembly] permit envelope algorithm");
  equal(
    envelope.subjectSha256,
    authorization.permitSubjectSha256,
    "[phase-assembly] permit subject digest reference",
  );
  equal(
    sha256Canonical(envelope),
    authorization.permitEnvelopeSha256,
    "[phase-assembly] permit envelope digest",
  );
  if (
    typeof envelope.signatureBase64url !== "string"
    || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signatureBase64url)
  ) {
    throw failure("[phase-assembly] permit signature is invalid");
  }
  const subject = record(envelope.subject, "[phase-assembly] permit subject");
  exactKeys(subject, [
    "schemaVersion",
    "contract",
    "issuer",
    "audience",
    "keyId",
    "permitIdSha256",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "executor",
    "runtimes",
    "ring",
    "phase",
    "issuedAt",
    "notBefore",
    "expiresAt",
  ], "[phase-assembly] permit subject");
  equal(subject.schemaVersion, 1, "[phase-assembly] permit subject schema");
  equal(
    subject.contract,
    "cinatoken-container-runtime-json-compatibility-phase-permit-subject-v1",
    "[phase-assembly] permit subject contract",
  );
  equal(
    sha256Canonical(subject),
    authorization.permitSubjectSha256,
    "[phase-assembly] permit subject canonical digest",
  );
  equal(subject.issuer, authorization.issuer, "[phase-assembly] permit issuer");
  equal(subject.audience, authorization.audience, "[phase-assembly] permit audience");
  equal(subject.keyId, authorization.keyId, "[phase-assembly] permit key ID");
  equal(
    subject.permitIdSha256,
    authorization.permitIdSha256,
    "[phase-assembly] permit ID",
  );
  equal(subject.campaignIdSha256, receipt.campaignIdSha256, "[phase-assembly] permit campaign");
  equal(subject.planDigestSha256, receipt.planDigestSha256, "[phase-assembly] permit plan");
  equal(subject.phaseExecutionId, receipt.phaseExecutionId, "[phase-assembly] permit execution");
  canonicalEqual(subject.controller, receipt.controller, "[phase-assembly] permit Controller");
  canonicalEqual(subject.runtimes, receipt.runtimes, "[phase-assembly] permit runtimes");
  canonicalEqual(subject.ring, receipt.ring, "[phase-assembly] permit ring");
  canonicalEqual(subject.phase, phase, "[phase-assembly] permit phase");
  const permitExecutor = record(
    subject.executor,
    "[phase-assembly] permit executor",
  );
  exactKeys(
    permitExecutor,
    ["serviceName", "versionId"],
    "[phase-assembly] permit executor",
  );
  equal(
    permitExecutor.serviceName,
    receipt.executor.serviceName,
    "[phase-assembly] permit executor service",
  );
  equal(
    permitExecutor.versionId,
    receipt.executor.versionId,
    "[phase-assembly] permit executor version",
  );
  equal(subject.issuedAt, authorization.issuedAt, "[phase-assembly] permit issued time");
  equal(subject.notBefore, authorization.notBefore, "[phase-assembly] permit not-before time");
  equal(subject.expiresAt, authorization.expiresAt, "[phase-assembly] permit expiry time");

  const authority = record(
    authorization.campaignAuthority,
    "[phase-assembly] campaign authority",
  );
  exactKeys(authority, [
    "kind",
    "binding",
    "objectNameSha256",
    "campaignBindingSha256",
    "leaseIdSha256",
    "leaseReceiptSha256",
    "singleUsePermitPersisted",
    "phaseOrderEnforced",
    "concurrentPhaseRejected",
  ], "[phase-assembly] campaign authority");
  equal(
    authority.kind,
    "campaign-scoped-sqlite-durable-object",
    "[phase-assembly] campaign authority kind",
  );
  equal(
    authority.binding,
    "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
    "[phase-assembly] campaign authority binding",
  );
  equal(
    authority.objectNameSha256,
    receipt.campaignIdSha256,
    "[phase-assembly] campaign authority object name",
  );
  for (const name of [
    "campaignBindingSha256",
    "leaseIdSha256",
    "leaseReceiptSha256",
  ]) {
    sha256(authority[name], `[phase-assembly] campaign authority ${name}`);
  }
  for (const name of [
    "singleUsePermitPersisted",
    "phaseOrderEnforced",
    "concurrentPhaseRejected",
  ]) {
    equal(authority[name], true, `[phase-assembly] campaign authority ${name}`);
  }
}

function validateReceiptTransport(value) {
  const transport = record(value, "[phase-assembly] receipt transport");
  exactKeys(transport, [
    "kind",
    "binding",
    "targetService",
    "targetEntrypoint",
    "rpcMethod",
    "publicUrlUsed",
    "cloudflareRestUsed",
  ], "[phase-assembly] receipt transport");
  equal(transport.kind, "service-binding-rpc", "[phase-assembly] transport kind");
  equal(
    transport.binding,
    "CONTAINER_CONTROLLER_JSON_PROBE",
    "[phase-assembly] transport binding",
  );
  equal(transport.targetService, CONTROLLER_SERVICE, "[phase-assembly] target service");
  equal(
    transport.targetEntrypoint,
    CONTROLLER_ENTRYPOINT,
    "[phase-assembly] target entrypoint",
  );
  equal(transport.rpcMethod, "probeShard", "[phase-assembly] RPC method");
  equal(transport.publicUrlUsed, false, "[phase-assembly] public URL use");
  equal(transport.cloudflareRestUsed, false, "[phase-assembly] Cloudflare REST use");
}

function validateReceiptTransportTotals(value) {
  const totals = record(value, "[phase-assembly] receipt transport totals");
  exactKeys(totals, [
    "privateServiceBindingRpcCount",
    "completedProbeCount",
    "selectedJsonCount",
    "effectiveJsonCount",
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ], "[phase-assembly] receipt transport totals");
  for (const name of [
    "privateServiceBindingRpcCount",
    "completedProbeCount",
    "selectedJsonCount",
    "effectiveJsonCount",
  ]) {
    equal(totals[name], SHARD_COUNT, `[phase-assembly] receipt ${name}`);
  }
  for (const name of [
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ]) {
    equal(totals[name], 0, `[phase-assembly] receipt ${name}`);
  }
}

function validateExecutionBoundary(value) {
  const boundary = record(value, "[phase-assembly] execution boundary");
  exactKeys(boundary, [
    "credentialsRead",
    "filesWritten",
    "deploymentMutationAuthorized",
    "deploymentMutationPerformed",
    "cloudflareRestRequestCount",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ], "[phase-assembly] execution boundary");
  for (const name of [
    "credentialsRead",
    "filesWritten",
    "deploymentMutationAuthorized",
    "deploymentMutationPerformed",
  ]) {
    equal(boundary[name], false, `[phase-assembly] boundary ${name}`);
  }
  for (const name of [
    "cloudflareRestRequestCount",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ]) {
    equal(boundary[name], 0, `[phase-assembly] boundary ${name}`);
  }
}

function validateNoMutationFacts(value) {
  const facts = record(value, "[phase-assembly] no-mutation facts");
  exactKeys(facts, [
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
  ], "[phase-assembly] no-mutation facts");
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
    sha256(facts[name], `[phase-assembly] no-mutation ${name}`);
  }
  equal(facts.providerAfterSha256, facts.providerBeforeSha256, "[phase-assembly] provider snapshot");
  equal(facts.billingAfterSha256, facts.billingBeforeSha256, "[phase-assembly] billing snapshot");
  equal(
    facts.storageGatewayAfterSha256,
    facts.storageGatewayBeforeSha256,
    "[phase-assembly] storage gateway snapshot",
  );
  equal(
    facts.productionTrafficAfterSha256,
    facts.productionTrafficBeforeSha256,
    "[phase-assembly] production traffic snapshot",
  );
  for (const name of [
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ]) {
    equal(facts[name], 0, `[phase-assembly] no-mutation ${name}`);
  }
  const { evidenceSha256, ...proof } = facts;
  equal(
    evidenceSha256,
    sha256Canonical(proof),
    "[phase-assembly] no-mutation canonical digest",
  );
}

function validateResultIdentity(result, plan, phase, observation, shardIndex) {
  const request = result.request;
  equal(request.campaignIdSha256, plan.campaignIdSha256, `[phase-assembly] shard ${shardIndex} campaign ID`);
  equal(request.planDigestSha256, plan.planDigestSha256, `[phase-assembly] shard ${shardIndex} plan digest`);
  equal(request.phaseId, phase.id, `[phase-assembly] shard ${shardIndex} phase ID`);
  equal(request.phaseOrdinal, phase.ordinal, `[phase-assembly] shard ${shardIndex} phase ordinal`);
  equal(request.candidateShardIndex, plan.ring.candidateShardIndex, `[phase-assembly] shard ${shardIndex} candidate shard`);
  equal(request.controllerServiceName, plan.controller.serviceName, `[phase-assembly] shard ${shardIndex} Controller service`);
  equal(request.controllerVersionId, plan.controller.versionId, `[phase-assembly] shard ${shardIndex} Controller version`);
  equal(request.runtimeGeneration, observation.runtimeGeneration, `[phase-assembly] shard ${shardIndex} runtime generation`);
  equal(request.expectedRuntimeBuildIdSha256, observation.runtimeBuildIdSha256, `[phase-assembly] shard ${shardIndex} runtime build`);
  equal(request.shard.ringGeneration, plan.ring.generation, `[phase-assembly] shard ${shardIndex} ring generation`);
  equal(request.shard.shardIndex, shardIndex, `[phase-assembly] shard ${shardIndex} request index`);
  equal(request.shard.instanceName, observation.instanceName, `[phase-assembly] shard ${shardIndex} request instance`);
}

function expectedRuntimeGeneration(topology, shardIndex) {
  return topology.overrides.find((entry) => entry.shardIndex === shardIndex)?.runtime ??
    topology.defaultRuntime;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw failure(`${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) throw failure(`${label} must equal ${String(expected)}`);
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw failure(`${label} does not match the approved plan`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw failure(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw failure(`${label} must be a safe opaque token`);
  }
  return value;
}

function wholeSecond(value, label) {
  if (typeof value !== "string" || !WHOLE_SECOND_UTC.test(value)) {
    throw failure(`${label} must be whole-second UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value) {
    throw failure(`${label} must be canonical UTC`);
  }
  return milliseconds;
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function failure(message) {
  return new JsonCompatibilityCampaignError(message);
}
