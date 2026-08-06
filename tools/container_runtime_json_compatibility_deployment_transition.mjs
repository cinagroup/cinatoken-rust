import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";

import {
  JSON_COMPATIBILITY_PLAN_CONTRACT,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
  validateJsonCompatibilityDeploymentStatePlan,
} from "./container_runtime_json_compatibility_deployment_states.mjs";

export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-request-v1";
export const JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-authorized-deployment-transition-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-subject-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-envelope-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-request-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-evidence-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-intent-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_OUTCOME_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-outcome-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-operation-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-receipt-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-v1\n";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-executor-staging";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABLE_READ_COUNT = 2;
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS = 5;
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EMPTY_ROUTE_SET_SHA256 =
  sha256Canonical([]);

const SCHEMA_VERSION = 1;
const SOURCE_AUTHENTICATION_REQUEST_SCHEMA_VERSION = 2;
const SOURCE_AUTHENTICATION_SCHEMA_VERSION = 2;
const SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS = 60;
const CAMPAIGN_PLAN_SCHEMA_VERSION = 4;
const STATE_PLAN_SCHEMA_VERSION = 2;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 5;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEPLOYMENT_STATES = new Set(["dark", "status-only", "execution"]);
const STOP_REASONS = new Set([
  "source_authentication_rejected",
  "source_authentication_ambiguous",
  "approval_expired",
  "source_state_ambiguous",
  "source_state_drift",
  "source_state_unstable",
  "mutation_rejected",
  "target_state_ambiguous",
  "target_state_drift",
  "target_state_unstable",
]);

export class JsonCompatibilityDeploymentTransitionUncertainError extends Error {
  constructor(code) {
    super(`deployment transition is uncertain: ${code}`);
    this.name = "JsonCompatibilityDeploymentTransitionUncertainError";
    this.code = code;
  }
}

export function signJsonCompatibilityDeploymentTransition({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  transitionId,
  operationIdSha256,
  priorStateEvidence: priorStateEvidenceInput,
  sourceEvidence: sourceEvidenceInput,
  privateKeyBytes: privateKeyInput,
  now = new Date(),
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  const transition = selectTransition(statePlan, transitionId);
  sha256(operationIdSha256, "transition operation ID");
  const issuedAt = epochSeconds(now, "transition approval time");
  const priorStateEvidence = validatePriorStateEvidence(
    priorStateEvidenceInput,
    transition,
    issuedAt,
  );
  const sourceEvidence = validateSourceEvidence(sourceEvidenceInput, transition);
  const request = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_REQUEST_CONTRACT,
    mode: "remote-create-once",
    environment: "staging",
    operationIdSha256,
    campaignPlan: {
      schemaVersion: CAMPAIGN_PLAN_SCHEMA_VERSION,
      contract: JSON_COMPATIBILITY_PLAN_CONTRACT,
      planDigestSha256: campaignPlan.planDigestSha256,
    },
    statePlan: {
      schemaVersion: STATE_PLAN_SCHEMA_VERSION,
      contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
      planDigestSha256: statePlan.planDigestSha256,
    },
    transition: cloneJson(transition),
    priorStateEvidence,
    sourceEvidence,
  };
  const requestSha256 = sha256Canonical(request);
  const approvalPolicy = transitionApprovalPolicy(campaignPlan);
  const privateKeyBytes = Buffer.from(privateKeyInput ?? []);
  if (
    privateKeyBytes.length === 0
    || privateKeyBytes.length > MAX_PRIVATE_KEY_BYTES
  ) {
    throw new Error("transition approval private key is empty or oversized");
  }
  let privateKey;
  try {
    privateKey = parsePrivateKey(privateKeyBytes);
  } finally {
    privateKeyBytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("transition approval private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  equal(
    createHash("sha256").update(spki).digest("hex"),
    approvalPolicy.signerSpkiSha256,
    "transition approval private key SPKI digest",
  );
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT,
    environment: "staging",
    issuer: approvalPolicy.issuer,
    audience: approvalPolicy.audience,
    keyId: approvalPolicy.keyId,
    operationIdSha256,
    requestSha256,
    campaignPlanContract: JSON_COMPATIBILITY_PLAN_CONTRACT,
    campaignPlanSchemaVersion: CAMPAIGN_PLAN_SCHEMA_VERSION,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanContract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    statePlanSchemaVersion: STATE_PLAN_SCHEMA_VERSION,
    statePlanDigestSha256: statePlan.planDigestSha256,
    transitionId: transition.id,
    transitionOrdinal: transition.ordinal,
    fromState: transition.fromState,
    toState: transition.toState,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + approvalPolicy.maxLifetimeSeconds,
  };
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  const signature = signSignature(null, payload, privateKey);
  if (
    signature.length !== 64
    || !verifySignature(null, payload, publicKey, signature)
  ) {
    throw new Error("transition approval signature self-verification failed");
  }
  const approval = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: sha256Canonical(subject),
    signerSpkiBase64url: spki.toString("base64url"),
    signatureBase64url: signature.toString("base64url"),
  };
  const authorized = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT,
    request,
    approval,
  };
  validateJsonCompatibilityDeploymentTransitionAuthorization(
    campaignPlan,
    statePlan,
    authorized,
  );
  return authorized;
}

export function validateJsonCompatibilityDeploymentTransitionAuthorization(
  campaignPlanInput,
  statePlanInput,
  input,
  { now = null, requireUsableWindow = false } = {},
) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  const authorized = record(input, "authorized deployment transition");
  exactKeys(
    authorized,
    ["schemaVersion", "contract", "request", "approval"],
    "authorized deployment transition",
  );
  equal(authorized.schemaVersion, SCHEMA_VERSION, "authorized transition schema");
  equal(
    authorized.contract,
    JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT,
    "authorized transition contract",
  );
  const request = validateTransitionRequest(
    authorized.request,
    campaignPlan,
    statePlan,
  );
  const policy = transitionApprovalPolicy(campaignPlan);
  const approval = record(authorized.approval, "transition approval envelope");
  exactKeys(approval, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signerSpkiBase64url",
    "signatureBase64url",
  ], "transition approval envelope");
  equal(approval.schemaVersion, SCHEMA_VERSION, "transition approval schema");
  equal(
    approval.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT,
    "transition approval envelope contract",
  );
  equal(approval.algorithm, "Ed25519", "transition approval algorithm");
  const subject = record(approval.subject, "transition approval subject");
  exactKeys(subject, [
    "schemaVersion", "contract", "environment", "issuer", "audience", "keyId",
    "operationIdSha256", "requestSha256", "campaignPlanContract",
    "campaignPlanSchemaVersion", "campaignPlanDigestSha256", "statePlanContract",
    "statePlanSchemaVersion", "statePlanDigestSha256", "transitionId",
    "transitionOrdinal", "fromState", "toState", "issuedAt", "notBefore",
    "expiresAt",
  ], "transition approval subject");
  equal(subject.schemaVersion, SCHEMA_VERSION, "transition approval subject schema");
  equal(
    subject.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT,
    "transition approval subject contract",
  );
  for (const [label, actual, expected] of [
    ["environment", subject.environment, "staging"],
    ["issuer", subject.issuer, policy.issuer],
    ["audience", subject.audience, policy.audience],
    ["key ID", subject.keyId, policy.keyId],
    ["operation ID", subject.operationIdSha256, request.operationIdSha256],
    ["request digest", subject.requestSha256, sha256Canonical(request)],
    ["campaign plan contract", subject.campaignPlanContract, JSON_COMPATIBILITY_PLAN_CONTRACT],
    ["campaign plan schema", subject.campaignPlanSchemaVersion, CAMPAIGN_PLAN_SCHEMA_VERSION],
    ["campaign plan digest", subject.campaignPlanDigestSha256, campaignPlan.planDigestSha256],
    ["state plan contract", subject.statePlanContract, JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT],
    ["state plan schema", subject.statePlanSchemaVersion, STATE_PLAN_SCHEMA_VERSION],
    ["state plan digest", subject.statePlanDigestSha256, statePlan.planDigestSha256],
    ["transition ID", subject.transitionId, request.transition.id],
    ["transition ordinal", subject.transitionOrdinal, request.transition.ordinal],
    ["from state", subject.fromState, request.transition.fromState],
    ["to state", subject.toState, request.transition.toState],
  ]) equal(actual, expected, `transition approval ${label}`);
  integer(subject.issuedAt, "transition approval issuedAt");
  integer(subject.notBefore, "transition approval notBefore");
  integer(subject.expiresAt, "transition approval expiresAt");
  if (
    subject.notBefore < subject.issuedAt
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt > policy.maxLifetimeSeconds
  ) {
    throw new Error("transition approval time window is invalid");
  }
  if (
    subject.issuedAt
      < request.priorStateEvidence.enteredAt
        + request.transition.minimumHoldSeconds
  ) {
    throw new Error("transition approval violates the minimum state hold");
  }
  equal(
    approval.subjectSha256,
    sha256Canonical(subject),
    "transition approval subject digest",
  );
  const spki = canonicalBase64urlBytes(
    approval.signerSpkiBase64url,
    512,
    "transition approval SPKI",
  );
  const signature = canonicalBase64urlBytes(
    approval.signatureBase64url,
    64,
    "transition approval signature",
    64,
  );
  equal(
    createHash("sha256").update(spki).digest("hex"),
    policy.signerSpkiSha256,
    "transition approval SPKI digest",
  );
  let publicKey;
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new Error("transition approval SPKI is malformed");
  }
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !verifySignature(null, payload, publicKey, signature)
  ) {
    throw new Error("transition approval signature is invalid");
  }
  if (now !== null || requireUsableWindow) {
    const current = epochSeconds(now ?? new Date(), "transition execution time");
    if (current + CLOCK_SKEW_SECONDS < subject.notBefore) {
      throw new Error("transition approval is not active");
    }
    if (
      subject.expiresAt - current
        < policy.minimumRemainingLifetimeSeconds
    ) {
      throw new Error("transition approval has insufficient remaining lifetime");
    }
  }
  return authorized;
}

export function buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
  operationIdSha256,
  operationDigestSha256,
  authorizedTransitionSha256,
  campaignPlanDigestSha256,
  statePlanDigestSha256,
  transition: transitionInput,
  sourceEvidence: sourceEvidenceInput,
}) {
  sha256(operationIdSha256, "source authentication operation ID");
  sha256(operationDigestSha256, "source authentication operation digest");
  sha256(
    authorizedTransitionSha256,
    "source authentication authorized transition",
  );
  sha256(campaignPlanDigestSha256, "source authentication campaign plan");
  sha256(statePlanDigestSha256, "source authentication state plan");
  const transition = validateSourceAuthenticationTransition(transitionInput);
  const profile = sourceAuthenticationProfile(transition);
  const sourceEvidence = validateSourceEvidence(sourceEvidenceInput, transition);
  const subject = {
    schemaVersion: SOURCE_AUTHENTICATION_REQUEST_SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_REQUEST_CONTRACT,
    environment: "staging",
    profile,
    operationIdSha256,
    operationDigestSha256,
    authorizedTransitionSha256,
    campaignPlanDigestSha256,
    statePlanDigestSha256,
    transition: cloneJson(transition),
    sourceEvidence: cloneJson(sourceEvidence),
  };
  return {
    ...subject,
    sourceAuthenticationRequestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
  input,
) {
  const request = record(input, "transition source authentication request");
  exactKeys(request, [
    "schemaVersion", "contract", "environment", "profile",
    "operationIdSha256", "operationDigestSha256",
    "authorizedTransitionSha256", "campaignPlanDigestSha256",
    "statePlanDigestSha256", "transition",
    "sourceEvidence", "sourceAuthenticationRequestSha256",
  ], "transition source authentication request");
  const rebuilt = buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
    operationIdSha256: request.operationIdSha256,
    operationDigestSha256: request.operationDigestSha256,
    authorizedTransitionSha256: request.authorizedTransitionSha256,
    campaignPlanDigestSha256: request.campaignPlanDigestSha256,
    statePlanDigestSha256: request.statePlanDigestSha256,
    transition: request.transition,
    sourceEvidence: request.sourceEvidence,
  });
  canonicalEqual(
    rebuilt,
    request,
    "transition source authentication request",
  );
  return cloneJson(request);
}

export function buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
  sourceAuthenticationRequest: sourceAuthenticationRequestInput,
  classification,
  reasonCode = null,
  verifierIdentitySha256,
  evidenceSha256,
  verifiedAt,
}) {
  const sourceAuthenticationRequest =
    validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      sourceAuthenticationRequestInput,
    );
  oneOf(
    classification,
    ["authenticated", "rejected", "ambiguous"],
    "source authentication classification",
  );
  if (classification === "authenticated") {
    equal(reasonCode, null, "authenticated source reason code");
  } else {
    safeToken(reasonCode, "source authentication reason code");
  }
  sha256(verifierIdentitySha256, "source verifier identity");
  sha256(evidenceSha256, "source authentication evidence");
  integer(verifiedAt, "source authentication time");
  const subject = {
    schemaVersion: SOURCE_AUTHENTICATION_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_CONTRACT,
    classification,
    reasonCode,
    request: cloneJson(sourceAuthenticationRequest),
    verifierIdentitySha256,
    evidenceSha256,
    verifiedAt,
  };
  return {
    ...subject,
    sourceAuthenticationDigestSha256: sha256Canonical(subject),
  };
}

export function buildJsonCompatibilityDeploymentTransitionReadback({
  classification,
  environment = "staging",
  accountIdSha256,
  serviceName,
  entrypoint,
  versionId = null,
  configSha256 = null,
  deploymentState = null,
  gates = null,
  privateRpcOnly = null,
  workersDev = null,
  previewUrls = null,
  bindingSetSha256 = null,
  routeSetSha256 = null,
  secretNameSetSha256 = null,
  durableObjectMigrationSetSha256 = null,
  authenticationIdentitySha256,
  readbackRequestIdSha256,
  remoteEvidenceSha256,
  authenticationEvidenceSha256,
  observedAt,
}) {
  oneOf(classification, ["observed", "ambiguous"], "readback classification");
  equal(environment, "staging", "readback environment");
  sha256(accountIdSha256, "readback account ID");
  safeToken(serviceName, "readback service name");
  safeToken(entrypoint, "readback entrypoint");
  sha256(remoteEvidenceSha256, "readback remote evidence");
  sha256(authenticationIdentitySha256, "readback authentication identity");
  sha256(readbackRequestIdSha256, "readback request ID");
  sha256(authenticationEvidenceSha256, "readback authentication evidence");
  integer(observedAt, "readback observation time");
  let remoteStateSha256 = null;
  if (classification === "observed") {
    safeToken(versionId, "readback version ID");
    sha256(configSha256, "readback config digest");
    oneOf(deploymentState, [...DEPLOYMENT_STATES], "readback deployment state");
    const normalizedGates = booleanRecord(gates, "readback gates");
    boolean(privateRpcOnly, "readback private RPC flag");
    boolean(workersDev, "readback workers_dev flag");
    boolean(previewUrls, "readback preview URLs flag");
    sha256(bindingSetSha256, "readback binding set");
    sha256(routeSetSha256, "readback route set");
    sha256(secretNameSetSha256, "readback secret-name set");
    sha256(
      durableObjectMigrationSetSha256,
      "readback Durable Object migration set",
    );
    remoteStateSha256 = sha256Canonical({
      environment,
      accountIdSha256,
      serviceName,
      entrypoint,
      versionId,
      configSha256,
      deploymentState,
      gates: normalizedGates,
      privateRpcOnly,
      workersDev,
      previewUrls,
      bindingSetSha256,
      routeSetSha256,
      secretNameSetSha256,
      durableObjectMigrationSetSha256,
      authenticationIdentitySha256,
    });
  } else {
    for (const [label, value] of [
      ["version ID", versionId],
      ["config digest", configSha256],
      ["deployment state", deploymentState],
      ["gates", gates],
      ["private RPC flag", privateRpcOnly],
      ["workers_dev flag", workersDev],
      ["preview URLs flag", previewUrls],
      ["binding set", bindingSetSha256],
      ["route set", routeSetSha256],
      ["secret-name set", secretNameSetSha256],
      ["Durable Object migration set", durableObjectMigrationSetSha256],
    ]) equal(value, null, `ambiguous readback ${label}`);
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_CONTRACT,
    classification,
    environment,
    accountIdSha256,
    serviceName,
    entrypoint,
    versionId,
    configSha256,
    deploymentState,
    gates: gates === null ? null : cloneJson(gates),
    privateRpcOnly,
    workersDev,
    previewUrls,
    bindingSetSha256,
    routeSetSha256,
    secretNameSetSha256,
    durableObjectMigrationSetSha256,
    authenticationIdentitySha256,
    readbackRequestIdSha256,
    remoteStateSha256,
    remoteEvidenceSha256,
    authenticationEvidenceSha256,
    observedAt,
  };
  return {
    ...subject,
    observationDigestSha256: sha256Canonical(subject),
  };
}

export function buildJsonCompatibilityDeploymentTransitionMutationOutcome({
  mutationIntent,
  classification,
  httpStatus,
  responseBodySha256,
  responseRequestIdSha256,
  responseBytes,
}) {
  const intent = validateMutationIntent(mutationIntent);
  oneOf(classification, ["accepted", "rejected", "ambiguous"], "mutation outcome");
  nullableHttpStatus(httpStatus, "mutation HTTP status");
  nullableSha256(responseBodySha256, "mutation response body digest");
  nullableSha256(responseRequestIdSha256, "mutation request ID digest");
  nullableNonnegativeInteger(responseBytes, "mutation response bytes");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_OUTCOME_CONTRACT,
    mutationIntentSha256: intent.mutationIntentSha256,
    classification,
    httpStatus,
    responseBodySha256,
    responseRequestIdSha256,
    responseBytes,
  };
  return {
    ...subject,
    outcomeDigestSha256: sha256Canonical(subject),
  };
}

export async function executeJsonCompatibilityDeploymentTransition({
  campaignPlan,
  statePlan,
  authorizedTransition,
  dependencies,
}) {
  const nowAtStart = dependencyNow(dependencies);
  const authorized = validateJsonCompatibilityDeploymentTransitionAuthorization(
    campaignPlan,
    statePlan,
    authorizedTransition,
    { now: new Date(nowAtStart * 1000), requireUsableWindow: true },
  );
  const validatedPlans = validateCurrentPlanPair(campaignPlan, statePlan);
  validateDependencies(dependencies);
  const authorizedRequestSha256 = sha256Canonical(authorized);
  const operationSubject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256,
    campaignPlanDigestSha256: validatedPlans.campaignPlan.planDigestSha256,
    statePlanDigestSha256: validatedPlans.statePlan.planDigestSha256,
    transitionId: authorized.request.transition.id,
  };
  const operation = {
    ...operationSubject,
    operationDigestSha256: sha256Canonical(operationSubject),
  };
  const reservation = validateReservation(
    await dependencies.journal.reserve(cloneJson(operation)),
  );
  if (reservation.classification === "exact_replay") {
    const receipt = validateJsonCompatibilityDeploymentTransitionReceipt(
      validatedPlans.campaignPlan,
      validatedPlans.statePlan,
      authorized,
      reservation.receipt,
    );
    return cloneJson(receipt);
  }
  if (reservation.classification !== "reserved") {
    throw new JsonCompatibilityDeploymentTransitionUncertainError(
      `operation_${reservation.classification}`,
    );
  }

  const execution = {
    startedAt: nowAtStart,
    sourceAuthentication: null,
    steps: [],
    mutationAttempts: 0,
    readbackAttempts: 0,
  };
  const sourceAuthenticationRequest = sourceAuthenticationRequestForAuthorized(
    validatedPlans.campaignPlan,
    validatedPlans.statePlan,
    authorized,
  );
  const sourceAuthentication = validateSourceAuthentication(
    await dependencies.authenticateSource(
      cloneJson(sourceAuthenticationRequest),
    ),
    sourceAuthenticationRequest,
  );
  const sourceAuthenticationObservedAt = dependencyNow(dependencies);
  if (
    sourceAuthentication.verifiedAt < nowAtStart - 5
    || sourceAuthentication.verifiedAt > sourceAuthenticationObservedAt + 5
    || sourceAuthenticationObservedAt - sourceAuthentication.verifiedAt
      > SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS
  ) throw new Error("source authentication proof time is outside execution");
  execution.sourceAuthentication = sourceAuthentication;
  await appendJournalEvidence(dependencies, {
    kind: "source_authentication",
    digestSha256: sourceAuthentication.sourceAuthenticationDigestSha256,
    payload: sourceAuthentication,
  });
  if (sourceAuthentication.classification !== "authenticated") {
    return finalizeReceipt(
      dependencies,
      validatedPlans,
      authorized,
      operation,
      execution,
      "stopped",
      sourceAuthentication.classification === "rejected"
        ? "source_authentication_rejected"
        : "source_authentication_ambiguous",
    );
  }

  for (const step of authorized.request.transition.steps) {
    if (!approvalStillActive(authorized, dependencies)) {
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        "approval_expired",
      );
    }
    const expectedSource = expectedArtifact(validatedPlans.statePlan, step, "from");
    const expectedTarget = expectedArtifact(validatedPlans.statePlan, step, "to");
    expectedSource.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    expectedTarget.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    const stepReceipt = {
      ordinal: step.ordinal,
      role: step.role,
      fromArtifact: step.fromArtifact,
      toArtifact: step.toArtifact,
      targetVersionId: step.targetVersionId,
      targetConfigSha256: step.targetConfigSha256,
      previousStepReceiptSha256: null,
      sourceReadbacks: [],
      mutationIntent: null,
      mutationOutcome: null,
      targetReadbacks: [],
      result: null,
      stepReceiptDigestSha256: null,
    };
    execution.steps.push(stepReceipt);
    const sourceRead = await collectStableReadback(
      dependencies,
      authorized,
      step,
      "source",
      expectedSource,
      execution,
    );
    stepReceipt.sourceReadbacks = sourceRead.observations;
    if (sourceRead.classification !== "stable") {
      stepReceipt.result = "stopped";
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        `source_state_${sourceRead.classification}`,
      );
    }

    if (!approvalStillActive(authorized, dependencies)) {
      stepReceipt.result = "stopped";
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        "approval_expired",
      );
    }
    const mutationIntent = buildMutationIntent(
      authorized,
      authorizedRequestSha256,
      step,
      expectedTarget,
      sourceRead.observations[1].remoteStateSha256,
    );
    stepReceipt.mutationIntent = mutationIntent;
    await appendJournalEvidence(dependencies, {
      kind: "mutation_intent",
      digestSha256: mutationIntent.mutationIntentSha256,
      payload: mutationIntent,
    });
    if (!approvalStillActive(authorized, dependencies)) {
      stepReceipt.result = "stopped";
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        "approval_expired",
      );
    }
    execution.mutationAttempts += 1;
    const mutationOutcome = validateMutationOutcome(
      await dependencies.mutateOnce(cloneJson(mutationIntent)),
      mutationIntent,
    );
    stepReceipt.mutationOutcome = mutationOutcome;
    await appendJournalEvidence(dependencies, {
      kind: "mutation_outcome",
      digestSha256: mutationOutcome.outcomeDigestSha256,
      payload: mutationOutcome,
    });
    if (mutationOutcome.classification === "rejected") {
      stepReceipt.result = "stopped";
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        "mutation_rejected",
      );
    }

    const targetRead = await collectStableReadback(
      dependencies,
      authorized,
      step,
      "target",
      expectedTarget,
      execution,
    );
    stepReceipt.targetReadbacks = targetRead.observations;
    if (targetRead.classification !== "stable") {
      stepReceipt.result = "stopped";
      return finalizeReceipt(
        dependencies,
        validatedPlans,
        authorized,
        operation,
        execution,
        "stopped",
        `target_state_${targetRead.classification}`,
      );
    }
    stepReceipt.result = mutationOutcome.classification === "ambiguous"
      ? "completed_after_ambiguous_mutation"
      : "completed";
  }
  return finalizeReceipt(
    dependencies,
    validatedPlans,
    authorized,
    operation,
    execution,
    "completed",
    null,
  );
}

export function validateJsonCompatibilityDeploymentTransitionReceipt(
  campaignPlanInput,
  statePlanInput,
  authorizedInput,
  input,
) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  const authorized = validateJsonCompatibilityDeploymentTransitionAuthorization(
    campaignPlan,
    statePlan,
    authorizedInput,
  );
  const receipt = record(input, "deployment transition receipt");
  exactKeys(receipt, [
    "schemaVersion", "contract", "operationIdSha256", "authorizedRequestSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256", "transitionId",
    "startedAt", "finishedAt", "sourceAuthentication", "steps", "result",
    "stopReason", "nextTransitionAllowed", "mutationAttempts",
    "automaticRetries", "readbackAttempts", "stepChainHeadSha256",
    "receiptDigestSha256",
  ], "deployment transition receipt");
  equal(receipt.schemaVersion, SCHEMA_VERSION, "transition receipt schema");
  equal(
    receipt.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT,
    "transition receipt contract",
  );
  for (const [label, actual, expected] of [
    ["operation ID", receipt.operationIdSha256, authorized.request.operationIdSha256],
    ["authorized request digest", receipt.authorizedRequestSha256, sha256Canonical(authorized)],
    ["campaign plan digest", receipt.campaignPlanDigestSha256, campaignPlan.planDigestSha256],
    ["state plan digest", receipt.statePlanDigestSha256, statePlan.planDigestSha256],
    ["transition ID", receipt.transitionId, authorized.request.transition.id],
  ]) equal(actual, expected, `transition receipt ${label}`);
  integer(receipt.startedAt, "transition receipt start time");
  integer(receipt.finishedAt, "transition receipt finish time");
  if (receipt.finishedAt < receipt.startedAt) {
    throw new Error("transition receipt time is non-monotonic");
  }
  const sourceAuthentication = validateSourceAuthentication(
    receipt.sourceAuthentication,
    sourceAuthenticationRequestForAuthorized(
      campaignPlan,
      statePlan,
      authorized,
    ),
  );
  if (
    sourceAuthentication.verifiedAt < receipt.startedAt - 5
    || sourceAuthentication.verifiedAt > receipt.finishedAt + 5
  ) throw new Error("transition receipt source proof time is invalid");
  if (!Array.isArray(receipt.steps)) {
    throw new Error("transition receipt steps must be an array");
  }
  if (receipt.steps.length > authorized.request.transition.steps.length) {
    throw new Error("transition receipt has excessive steps");
  }
  let mutationAttempts = 0;
  let readbackAttempts = 0;
  let previousStepReceiptSha256 = null;
  for (let index = 0; index < receipt.steps.length; index += 1) {
    const expectedStep = authorized.request.transition.steps[index];
    const expectedSource = expectedArtifact(statePlan, expectedStep, "from");
    const expectedTarget = expectedArtifact(statePlan, expectedStep, "to");
    expectedSource.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    expectedTarget.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    const step = validateStepReceipt(
      receipt.steps[index],
      {
        expectedStep,
        expectedSource,
        expectedTarget,
        operationIdSha256: authorized.request.operationIdSha256,
        authorizedRequestSha256: sha256Canonical(authorized),
        transitionId: authorized.request.transition.id,
        transitionOrdinal: authorized.request.transition.ordinal,
        terminalStopReason:
          receipt.result === "stopped" && index === receipt.steps.length - 1
            ? receipt.stopReason
            : null,
      },
    );
    equal(
      step.previousStepReceiptSha256,
      previousStepReceiptSha256,
      "transition step predecessor digest",
    );
    previousStepReceiptSha256 = step.stepReceiptDigestSha256;
    mutationAttempts += step.mutationOutcome === null ? 0 : 1;
    readbackAttempts += step.sourceReadbacks.length + step.targetReadbacks.length;
  }
  oneOf(receipt.result, ["completed", "stopped"], "transition receipt result");
  if (receipt.result === "completed") {
    equal(receipt.stopReason, null, "completed transition stop reason");
    equal(
      receipt.steps.length,
      authorized.request.transition.steps.length,
      "completed transition step count",
    );
    for (const step of receipt.steps) {
      oneOf(
        step.result,
        ["completed", "completed_after_ambiguous_mutation"],
        "completed transition step result",
      );
    }
    equal(receipt.nextTransitionAllowed, true, "completed next transition flag");
  } else {
    oneOf(receipt.stopReason, [...STOP_REASONS], "transition stop reason");
    equal(receipt.nextTransitionAllowed, false, "stopped next transition flag");
  }
  equal(receipt.mutationAttempts, mutationAttempts, "transition mutation count");
  equal(receipt.readbackAttempts, readbackAttempts, "transition readback count");
  equal(receipt.automaticRetries, 0, "transition automatic retry count");
  equal(
    receipt.stepChainHeadSha256,
    previousStepReceiptSha256,
    "transition step chain head",
  );
  const { receiptDigestSha256, ...subject } = receipt;
  equal(
    receiptDigestSha256,
    sha256Canonical(subject),
    "transition receipt canonical digest",
  );
  return receipt;
}

function validateCurrentPlanPair(campaignPlanInput, statePlanInput) {
  const campaignPlan = validateJsonCompatibilityCampaignPlan(campaignPlanInput);
  const statePlan = validateJsonCompatibilityDeploymentStatePlan(statePlanInput);
  if (
    campaignPlan.schemaVersion !== CAMPAIGN_PLAN_SCHEMA_VERSION
    || campaignPlan.contract !== JSON_COMPATIBILITY_PLAN_CONTRACT
  ) {
    throw new Error("deployment transition requires current Plan v5/schema 4");
  }
  if (
    statePlan.schemaVersion !== STATE_PLAN_SCHEMA_VERSION
    || statePlan.contract !== JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT
  ) {
    throw new Error("deployment transition requires current state-plan v2/schema 2");
  }
  const binding = record(
    campaignPlan.deploymentStateBinding,
    "campaign deployment state binding",
  );
  equal(
    binding.planDigestSha256,
    statePlan.planDigestSha256,
    "campaign deployment state plan digest",
  );
  for (const [role, artifact] of Object.entries(binding.executionArtifacts)) {
    canonicalEqual(
      artifact,
      {
        versionId: statePlan.services[role].artifacts.execution.versionId,
        configSha256:
          statePlan.services[role].artifacts.execution.configSha256,
      },
      `campaign ${role} execution artifact`,
    );
  }
  return { campaignPlan, statePlan };
}

function transitionApprovalPolicy(campaignPlan) {
  const policy = record(campaignPlan.operatorApproval, "operator approval policy");
  return {
    issuer: policy.issuer,
    audience: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_AUDIENCE,
    keyId: policy.keyId,
    signerSpkiSha256: policy.signerSpkiSha256,
    maxLifetimeSeconds: policy.maxLifetimeSeconds,
    minimumRemainingLifetimeSeconds: policy.minimumRemainingLifetimeSeconds,
  };
}

function validateTransitionRequest(input, campaignPlan, statePlan) {
  const request = record(input, "deployment transition request");
  exactKeys(request, [
    "schemaVersion", "contract", "mode", "environment", "operationIdSha256",
    "campaignPlan", "statePlan", "transition", "priorStateEvidence",
    "sourceEvidence",
  ], "deployment transition request");
  equal(request.schemaVersion, SCHEMA_VERSION, "transition request schema");
  equal(
    request.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_REQUEST_CONTRACT,
    "transition request contract",
  );
  equal(request.mode, "remote-create-once", "transition request mode");
  equal(request.environment, "staging", "transition request environment");
  sha256(request.operationIdSha256, "transition operation ID");
  canonicalEqual(request.campaignPlan, {
    schemaVersion: CAMPAIGN_PLAN_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_PLAN_CONTRACT,
    planDigestSha256: campaignPlan.planDigestSha256,
  }, "transition campaign plan binding");
  canonicalEqual(request.statePlan, {
    schemaVersion: STATE_PLAN_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    planDigestSha256: statePlan.planDigestSha256,
  }, "transition state plan binding");
  const transitionInput = record(request.transition, "transition request transition");
  safeToken(transitionInput.id, "transition request transition ID");
  const transition = selectTransition(statePlan, transitionInput.id);
  canonicalEqual(transitionInput, transition, "transition request transition");
  validatePriorStateEvidence(request.priorStateEvidence, transition, null);
  validateSourceEvidence(request.sourceEvidence, transition);
  return request;
}

function validatePriorStateEvidence(input, transition, approvalTime) {
  const evidence = record(input, "prior state evidence");
  exactKeys(
    evidence,
    ["state", "enteredAt", "evidenceSha256"],
    "prior state evidence",
  );
  equal(evidence.state, transition.fromState, "prior state evidence state");
  integer(evidence.enteredAt, "prior state enteredAt");
  sha256(evidence.evidenceSha256, "prior state evidence digest");
  if (
    approvalTime !== null
    && approvalTime < evidence.enteredAt + transition.minimumHoldSeconds
  ) {
    throw new Error("transition minimum state hold has not elapsed");
  }
  return cloneJson(evidence);
}

function validateSourceEvidence(input, transition) {
  const evidence = record(input, "transition source evidence");
  exactKeys(evidence, [
    "schemaVersion",
    "contract",
    "profile",
    "accountIdSha256",
    "transitionSourceManifestSha256",
    "phaseSourceManifestSha256",
    "sourceSignatureEnvelopeSha256",
    "sourceVerifierPolicySha256",
    "sourceVerifierIdentitySha256",
    "immutableSourceArchiveReceiptSha256",
    "artifactInventoryReadbackSha256",
    "accountBindingInventorySha256",
  ], "transition source evidence");
  equal(evidence.schemaVersion, 2, "transition source evidence schema");
  equal(
    evidence.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_EVIDENCE_CONTRACT,
    "transition source evidence contract",
  );
  const profile = sourceAuthenticationProfile(transition);
  equal(evidence.profile, profile, "transition source evidence profile");
  for (const [label, value] of Object.entries(evidence)) {
    if (
      label !== "schemaVersion"
      && label !== "contract"
      && label !== "profile"
      && label !== "phaseSourceManifestSha256"
    ) sha256(value, `transition source ${label}`);
  }
  if (profile === "release-v1") {
    equal(
      evidence.phaseSourceManifestSha256,
      null,
      "release source phase manifest",
    );
  } else {
    sha256(
      evidence.phaseSourceManifestSha256,
      "closure source phase manifest",
    );
  }
  return cloneJson(evidence);
}

function validateSourceAuthenticationTransition(input) {
  const transition = record(input, "source authentication transition");
  exactKeys(transition, [
    "id", "ordinal", "fromState", "toState", "transitionSha256",
  ], "source authentication transition");
  safeToken(transition.id, "source authentication transition ID");
  integer(transition.ordinal, "source authentication transition ordinal");
  if (transition.ordinal < 1) {
    throw new Error("source authentication transition ordinal is invalid");
  }
  oneOf(
    transition.fromState,
    ["dark", "statusOnly", "execution"],
    "source authentication from-state",
  );
  oneOf(
    transition.toState,
    ["dark", "statusOnly", "execution"],
    "source authentication to-state",
  );
  sha256(transition.transitionSha256, "source authentication transition");
  sourceAuthenticationProfile(transition);
  return cloneJson(transition);
}

function sourceAuthenticationTransition(transition) {
  return {
    id: transition.id,
    ordinal: transition.ordinal,
    fromState: transition.fromState,
    toState: transition.toState,
    transitionSha256: sha256Canonical(transition),
  };
}

function sourceAuthenticationProfile(transition) {
  const pair = `${transition.fromState}->${transition.toState}`;
  if (pair === "dark->statusOnly" || pair === "statusOnly->execution") {
    return "release-v1";
  }
  if (pair === "execution->statusOnly" || pair === "statusOnly->dark") {
    return "campaign-closure-v1";
  }
  throw new Error("source authentication transition profile is invalid");
}

function sourceAuthenticationRequestForAuthorized(
  campaignPlan,
  statePlan,
  authorized,
) {
  const authorizedTransitionSha256 = sha256Canonical(authorized);
  const operationSubject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256: authorizedTransitionSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    transitionId: authorized.request.transition.id,
  };
  return buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
    operationIdSha256: authorized.request.operationIdSha256,
    operationDigestSha256: sha256Canonical(operationSubject),
    authorizedTransitionSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    transition: sourceAuthenticationTransition(authorized.request.transition),
    sourceEvidence: authorized.request.sourceEvidence,
  });
}

function selectTransition(statePlan, transitionId) {
  safeToken(transitionId, "deployment transition ID");
  const transition = statePlan.transitions.find((value) => value.id === transitionId);
  if (transition === undefined) {
    throw new Error("deployment transition is not frozen in the state plan");
  }
  return transition;
}

async function collectStableReadback(
  dependencies,
  authorized,
  step,
  phase,
  expected,
  execution,
) {
  const observations = [];
  for (
    let ordinal = 1;
    ordinal <= JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABLE_READ_COUNT;
    ordinal += 1
  ) {
    const observation = validateReadback(
      await dependencies.readback({
        operationIdSha256: authorized.request.operationIdSha256,
        transitionId: authorized.request.transition.id,
        step: cloneJson(step),
        phase,
        observationOrdinal: ordinal,
        expected: cloneJson(expected),
      }),
    );
    observations.push(observation);
    execution.readbackAttempts += 1;
    await appendJournalEvidence(dependencies, {
      kind: `${phase}_readback`,
      digestSha256: observation.observationDigestSha256,
      payload: observation,
    });
  }
  return {
    classification: classifyReadbackPair(observations, expected),
    observations,
  };
}

function expectedArtifact(statePlan, step, side) {
  const state = side === "from" ? step.fromArtifact : step.toArtifact;
  const key = state === "status-only" ? "statusOnly" : state;
  const service = statePlan.services[step.role];
  const artifact = service.artifacts[key];
  return {
    environment: "staging",
    serviceName: service.serviceName,
    entrypoint: service.entrypoint,
    versionId: artifact.versionId,
    configSha256: artifact.configSha256,
    deploymentState: artifact.deploymentState,
    gates: cloneJson(artifact.gates),
    privateRpcOnly: service.privateRpcOnly,
    workersDev: service.workersDev,
    previewUrls: service.previewUrls,
    routeSetSha256:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EMPTY_ROUTE_SET_SHA256,
  };
}

function classifyReadback(observation, expected) {
  if (observation.classification === "ambiguous") return "ambiguous";
  for (const key of [
    "environment", "accountIdSha256", "serviceName", "entrypoint", "versionId", "configSha256",
    "deploymentState", "privateRpcOnly", "workersDev", "previewUrls",
    "routeSetSha256",
  ]) {
    if (observation[key] !== expected[key]) return "drift";
  }
  if (canonicalJson(observation.gates) !== canonicalJson(expected.gates)) {
    return "drift";
  }
  return "exact";
}

function classifyReadbackPair(observations, expected) {
  const classifications = observations.map((observation) =>
    classifyReadback(observation, expected));
  if (classifications.includes("ambiguous")) return "ambiguous";
  if (classifications.includes("drift")) return "drift";
  if (
    observations[0].readbackRequestIdSha256
      === observations[1].readbackRequestIdSha256
    || observations[1].observedAt - observations[0].observedAt
      < JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS
    || observations[0].remoteStateSha256
      !== observations[1].remoteStateSha256
  ) return "unstable";
  return "stable";
}

function buildMutationIntent(
  authorized,
  authorizedRequestSha256,
  step,
  expected,
  sourceStateSha256,
) {
  sha256(sourceStateSha256, "mutation source state digest");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256,
    transitionId: authorized.request.transition.id,
    transitionOrdinal: authorized.request.transition.ordinal,
    stepOrdinal: step.ordinal,
    role: step.role,
    serviceName: expected.serviceName,
    fromArtifact: step.fromArtifact,
    toArtifact: step.toArtifact,
    targetVersionId: expected.versionId,
    targetConfigSha256: expected.configSha256,
    sourceStateSha256,
  };
  return {
    ...subject,
    mutationIntentSha256: sha256Canonical(subject),
  };
}

function validateMutationIntent(input) {
  const intent = record(input, "deployment transition mutation intent");
  exactKeys(intent, [
    "schemaVersion", "contract", "operationIdSha256", "authorizedRequestSha256",
    "transitionId", "transitionOrdinal", "stepOrdinal", "role", "serviceName",
    "fromArtifact", "toArtifact", "targetVersionId", "targetConfigSha256",
    "sourceStateSha256", "mutationIntentSha256",
  ], "deployment transition mutation intent");
  equal(intent.schemaVersion, SCHEMA_VERSION, "mutation intent schema");
  equal(
    intent.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT,
    "mutation intent contract",
  );
  sha256(intent.operationIdSha256, "mutation operation ID");
  sha256(intent.authorizedRequestSha256, "mutation authorized request digest");
  safeToken(intent.transitionId, "mutation transition ID");
  integer(intent.transitionOrdinal, "mutation transition ordinal");
  integer(intent.stepOrdinal, "mutation step ordinal");
  safeToken(intent.role, "mutation role");
  safeToken(intent.serviceName, "mutation service name");
  oneOf(intent.fromArtifact, [...DEPLOYMENT_STATES], "mutation source artifact");
  oneOf(intent.toArtifact, [...DEPLOYMENT_STATES], "mutation target artifact");
  safeToken(intent.targetVersionId, "mutation target version ID");
  sha256(intent.targetConfigSha256, "mutation target config digest");
  sha256(intent.sourceStateSha256, "mutation source state digest");
  const { mutationIntentSha256, ...subject } = intent;
  equal(
    mutationIntentSha256,
    sha256Canonical(subject),
    "mutation intent canonical digest",
  );
  return intent;
}

function validateMutationOutcome(input, expectedIntent) {
  const outcome = record(input, "deployment transition mutation outcome");
  exactKeys(outcome, [
    "schemaVersion", "contract", "mutationIntentSha256", "classification",
    "httpStatus", "responseBodySha256", "responseRequestIdSha256",
    "responseBytes", "outcomeDigestSha256",
  ], "deployment transition mutation outcome");
  equal(outcome.schemaVersion, SCHEMA_VERSION, "mutation outcome schema");
  equal(
    outcome.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_OUTCOME_CONTRACT,
    "mutation outcome contract",
  );
  equal(
    outcome.mutationIntentSha256,
    expectedIntent.mutationIntentSha256,
    "mutation outcome intent digest",
  );
  oneOf(outcome.classification, ["accepted", "rejected", "ambiguous"], "mutation outcome");
  nullableHttpStatus(outcome.httpStatus, "mutation HTTP status");
  nullableSha256(outcome.responseBodySha256, "mutation response body digest");
  nullableSha256(outcome.responseRequestIdSha256, "mutation request ID digest");
  nullableNonnegativeInteger(outcome.responseBytes, "mutation response bytes");
  const { outcomeDigestSha256, ...subject } = outcome;
  equal(
    outcomeDigestSha256,
    sha256Canonical(subject),
    "mutation outcome canonical digest",
  );
  return outcome;
}

function validateSourceAuthentication(input, expectedRequest) {
  const proof = record(input, "transition source authentication");
  exactKeys(proof, [
    "schemaVersion", "contract", "classification", "reasonCode", "request",
    "verifierIdentitySha256", "evidenceSha256", "verifiedAt",
    "sourceAuthenticationDigestSha256",
  ], "transition source authentication");
  equal(
    proof.schemaVersion,
    SOURCE_AUTHENTICATION_SCHEMA_VERSION,
    "source authentication schema",
  );
  equal(
    proof.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_CONTRACT,
    "source authentication contract",
  );
  oneOf(
    proof.classification,
    ["authenticated", "rejected", "ambiguous"],
    "source authentication classification",
  );
  if (proof.classification === "authenticated") {
    equal(proof.reasonCode, null, "authenticated source reason code");
  } else {
    safeToken(proof.reasonCode, "source authentication reason code");
  }
  canonicalEqual(
    proof.request,
    expectedRequest,
    "authenticated source request",
  );
  sha256(proof.verifierIdentitySha256, "source verifier identity");
  equal(
    proof.verifierIdentitySha256,
    expectedRequest.sourceEvidence.sourceVerifierIdentitySha256,
    "source verifier identity",
  );
  sha256(proof.evidenceSha256, "source authentication evidence");
  integer(proof.verifiedAt, "source authentication time");
  const { sourceAuthenticationDigestSha256, ...subject } = proof;
  equal(
    sourceAuthenticationDigestSha256,
    sha256Canonical(subject),
    "source authentication canonical digest",
  );
  return proof;
}

function validateReadback(input) {
  const observation = record(input, "deployment transition readback");
  exactKeys(observation, [
    "schemaVersion", "contract", "classification", "environment", "serviceName",
    "accountIdSha256", "entrypoint", "versionId", "configSha256", "deploymentState", "gates",
    "privateRpcOnly", "workersDev", "previewUrls", "bindingSetSha256",
    "routeSetSha256", "secretNameSetSha256", "durableObjectMigrationSetSha256",
    "remoteStateSha256", "authenticationIdentitySha256", "remoteEvidenceSha256", "authenticationEvidenceSha256",
    "readbackRequestIdSha256", "observedAt", "observationDigestSha256",
  ], "deployment transition readback");
  const rebuilt = buildJsonCompatibilityDeploymentTransitionReadback({
    ...observation,
  });
  canonicalEqual(rebuilt, observation, "deployment transition readback");
  return observation;
}

function validateStepReceipt(input, context) {
  const {
    expectedStep,
    expectedSource,
    expectedTarget,
    operationIdSha256,
    authorizedRequestSha256,
    transitionId,
    transitionOrdinal,
    terminalStopReason,
  } = context;
  const step = record(input, "transition step receipt");
  exactKeys(step, [
    "ordinal", "role", "fromArtifact", "toArtifact", "targetVersionId",
    "targetConfigSha256", "previousStepReceiptSha256", "sourceReadbacks",
    "mutationIntent", "mutationOutcome", "targetReadbacks", "result",
    "stepReceiptDigestSha256",
  ], "transition step receipt");
  for (const key of [
    "ordinal", "role", "fromArtifact", "toArtifact", "targetVersionId",
    "targetConfigSha256",
  ]) equal(step[key], expectedStep[key], `transition step ${key}`);
  if (!Array.isArray(step.sourceReadbacks) || !Array.isArray(step.targetReadbacks)) {
    throw new Error("transition step readbacks must be arrays");
  }
  if (
    step.sourceReadbacks.length !== JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABLE_READ_COUNT
    || ![0, JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABLE_READ_COUNT]
      .includes(step.targetReadbacks.length)
  ) {
    throw new Error("transition step readback count is invalid");
  }
  for (const observation of [
    ...step.sourceReadbacks,
    ...step.targetReadbacks,
  ]) validateReadback(observation);
  const sourceClassification = classifyReadbackPair(
    step.sourceReadbacks,
    expectedSource,
  );
  if (terminalStopReason?.startsWith("source_state_")) {
    equal(
      sourceClassification,
      terminalStopReason.slice("source_state_".length),
      "transition source stop classification",
    );
  } else {
    equal(sourceClassification, "stable", "transition source readback state");
  }
  if (step.targetReadbacks.length > 0) {
    const targetClassification = classifyReadbackPair(
      step.targetReadbacks,
      expectedTarget,
    );
    if (terminalStopReason?.startsWith("target_state_")) {
      equal(
        targetClassification,
        terminalStopReason.slice("target_state_".length),
        "transition target stop classification",
      );
    } else {
      equal(targetClassification, "stable", "transition target readback state");
    }
  }
  if (step.mutationIntent === null) {
    equal(step.mutationOutcome, null, "missing intent mutation outcome");
    equal(step.targetReadbacks.length, 0, "missing intent target readback count");
  } else {
    const intent = validateMutationIntent(step.mutationIntent);
    for (const [label, actual, expected] of [
      ["operation ID", intent.operationIdSha256, operationIdSha256],
      ["authorized request digest", intent.authorizedRequestSha256, authorizedRequestSha256],
      ["transition ID", intent.transitionId, transitionId],
      ["transition ordinal", intent.transitionOrdinal, transitionOrdinal],
      ["step ordinal", intent.stepOrdinal, expectedStep.ordinal],
      ["role", intent.role, expectedStep.role],
      ["service name", intent.serviceName, expectedTarget.serviceName],
      ["source artifact", intent.fromArtifact, expectedStep.fromArtifact],
      ["target artifact", intent.toArtifact, expectedStep.toArtifact],
      ["target version", intent.targetVersionId, expectedStep.targetVersionId],
      ["target config", intent.targetConfigSha256, expectedStep.targetConfigSha256],
      ["source state", intent.sourceStateSha256, step.sourceReadbacks[1].remoteStateSha256],
    ]) equal(actual, expected, `transition mutation intent ${label}`);
    if (step.mutationOutcome !== null) {
      validateMutationOutcome(step.mutationOutcome, intent);
    } else if (step.result !== "stopped") {
      throw new Error("transition step mutation outcome is missing");
    }
  }
  oneOf(
    step.result,
    ["completed", "completed_after_ambiguous_mutation", "stopped"],
    "transition step result",
  );
  const { stepReceiptDigestSha256, ...subject } = step;
  sha256(stepReceiptDigestSha256, "transition step receipt digest");
  equal(
    stepReceiptDigestSha256,
    sha256Canonical(subject),
    "transition step receipt canonical digest",
  );
  return step;
}

async function finalizeReceipt(
  dependencies,
  plans,
  authorized,
  operation,
  execution,
  result,
  stopReason,
) {
  const finishedAt = dependencyNow(dependencies);
  let previousStepReceiptSha256 = null;
  for (const step of execution.steps) {
    step.previousStepReceiptSha256 = previousStepReceiptSha256;
    const { stepReceiptDigestSha256: _ignored, ...stepSubject } = step;
    step.stepReceiptDigestSha256 = sha256Canonical(stepSubject);
    previousStepReceiptSha256 = step.stepReceiptDigestSha256;
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256: operation.authorizedRequestSha256,
    campaignPlanDigestSha256: plans.campaignPlan.planDigestSha256,
    statePlanDigestSha256: plans.statePlan.planDigestSha256,
    transitionId: authorized.request.transition.id,
    startedAt: execution.startedAt,
    finishedAt,
    sourceAuthentication: cloneJson(execution.sourceAuthentication),
    steps: cloneJson(execution.steps),
    result,
    stopReason,
    nextTransitionAllowed: result === "completed",
    mutationAttempts: execution.mutationAttempts,
    automaticRetries: 0,
    readbackAttempts: execution.readbackAttempts,
    stepChainHeadSha256: previousStepReceiptSha256,
  };
  const receipt = {
    ...subject,
    receiptDigestSha256: sha256Canonical(subject),
  };
  validateJsonCompatibilityDeploymentTransitionReceipt(
    plans.campaignPlan,
    plans.statePlan,
    authorized,
    receipt,
  );
  const archived = record(
    await dependencies.journal.finalize(cloneJson(receipt)),
    "transition receipt archive result",
  );
  exactKeys(
    archived,
    ["classification", "receipt"],
    "transition receipt archive result",
  );
  oneOf(
    archived.classification,
    ["created", "exact_replay", "conflict", "ambiguous"],
    "transition receipt archive classification",
  );
  if (["created", "exact_replay"].includes(archived.classification)) {
    canonicalEqual(archived.receipt, receipt, "archived transition receipt");
    return receipt;
  }
  throw new JsonCompatibilityDeploymentTransitionUncertainError(
    `receipt_${archived.classification}`,
  );
}

async function appendJournalEvidence(dependencies, event) {
  const result = record(
    await dependencies.journal.append(cloneJson(event)),
    "transition journal append result",
  );
  exactKeys(result, ["classification"], "transition journal append result");
  if (result.classification !== "appended") {
    throw new JsonCompatibilityDeploymentTransitionUncertainError(
      `journal_${String(result.classification)}`,
    );
  }
}

function validateReservation(input) {
  const reservation = record(input, "transition operation reservation");
  exactKeys(
    reservation,
    ["classification", "receipt"],
    "transition operation reservation",
  );
  oneOf(
    reservation.classification,
    ["reserved", "exact_replay", "inflight", "conflict"],
    "transition operation reservation",
  );
  if (reservation.classification === "exact_replay") {
    record(reservation.receipt, "replayed transition receipt");
  } else {
    equal(reservation.receipt, null, "non-replay reservation receipt");
  }
  return reservation;
}

function approvalStillActive(authorized, dependencies) {
  const now = dependencyNow(dependencies);
  return authorized.approval.subject.expiresAt - now >= CLOCK_SKEW_SECONDS;
}

function dependencyNow(dependencies) {
  if (typeof dependencies?.now !== "function") {
    throw new Error("transition executor dependency now is required");
  }
  const value = dependencies.now();
  integer(value, "transition executor time");
  return value;
}

function validateDependencies(dependencies) {
  record(dependencies, "transition executor dependencies");
  for (const name of ["now", "authenticateSource", "readback", "mutateOnce"]) {
    if (typeof dependencies[name] !== "function") {
      throw new Error(`transition executor dependency ${name} is required`);
    }
  }
  const journal = record(dependencies.journal, "transition executor journal");
  for (const name of ["reserve", "append", "finalize"]) {
    if (typeof journal[name] !== "function") {
      throw new Error(`transition executor journal ${name} is required`);
    }
  }
}

function parsePrivateKey(bytes) {
  try {
    return createPrivateKey(bytes);
  } catch {
    try {
      return createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    } catch {
      throw new Error("transition approval private key is malformed");
    }
  }
}

function canonicalBase64urlBytes(value, maxBytes, label, exactBytes = null) {
  if (
    typeof value !== "string"
    || value.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64url`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new Error(`${label} must be canonical base64url`);
  }
  if (
    bytes.length === 0
    || bytes.length > maxBytes
    || (exactBytes !== null && bytes.length !== exactBytes)
    || bytes.toString("base64url") !== value
  ) {
    throw new Error(`${label} has an invalid length or encoding`);
  }
  return bytes;
}

function epochSeconds(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return Math.floor(date.getTime() / 1000);
}

function booleanRecord(value, label) {
  const source = record(value, label);
  const normalized = {};
  for (const key of Object.keys(source).sort()) {
    safeToken(key, `${label} key`);
    boolean(source[key], `${label} ${key}`);
    normalized[key] = source[key];
  }
  return normalized;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match`);
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} must be a safe token`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
}

function nullableSha256(value, label) {
  if (value !== null) sha256(value, label);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function nullableNonnegativeInteger(value, label) {
  if (value !== null) integer(value, label);
}

function nullableHttpStatus(value, label) {
  if (
    value !== null
    && (!Number.isSafeInteger(value) || value < 100 || value > 599)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}
