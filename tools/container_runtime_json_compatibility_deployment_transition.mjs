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
  "cinatoken-container-runtime-json-compatibility-deployment-transition-request-v2";
export const JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-authorized-deployment-transition-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-subject-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-envelope-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_AUTHORITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-execution-authority-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-leaf-service-identity-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-request-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-evidence-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTH_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-request-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-intent-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_OUTCOME_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-outcome-v2";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-operation-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-receipt-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-approval-v2\n";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-deployment-transition-executor-staging";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABLE_READ_COUNT = 2;
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS = 5;
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EMPTY_ROUTE_SET_SHA256 =
  sha256Canonical([]);

const SCHEMA_VERSION = 1;
const AUTHORIZATION_SCHEMA_VERSION = 2;
const SOURCE_AUTHENTICATION_REQUEST_SCHEMA_VERSION = 2;
const SOURCE_AUTHENTICATION_SCHEMA_VERSION = 2;
const SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS = 60;
const CAMPAIGN_PLAN_SCHEMA_VERSION = 4;
const STATE_PLAN_SCHEMA_VERSION = 2;
const SOURCE_ARTIFACT_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
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
  artifactInventoryReadback: artifactInventoryReadbackInput,
  executionAuthority: executionAuthorityInput,
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
  const artifactInventoryReadback = validateTransitionArtifactInventory(
    campaignPlan,
    statePlan,
    sourceEvidence,
    artifactInventoryReadbackInput,
  );
  const executionAuthority = validateJsonCompatibilityDeploymentTransitionExecutionAuthority(
    executionAuthorityInput,
    sourceEvidence.accountIdSha256,
  );
  const request = {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
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
    artifactInventoryReadback,
    executionAuthority,
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
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
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
    executionAuthoritySha256: executionAuthority.authorityDigestSha256,
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
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: sha256Canonical(subject),
    signerSpkiBase64url: spki.toString("base64url"),
    signatureBase64url: signature.toString("base64url"),
  };
  const authorized = {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
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
  equal(
    authorized.schemaVersion,
    AUTHORIZATION_SCHEMA_VERSION,
    "authorized transition schema",
  );
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
  equal(
    approval.schemaVersion,
    AUTHORIZATION_SCHEMA_VERSION,
    "transition approval schema",
  );
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
    "executionAuthoritySha256",
    "transitionOrdinal", "fromState", "toState", "issuedAt", "notBefore",
    "expiresAt",
  ], "transition approval subject");
  equal(
    subject.schemaVersion,
    AUTHORIZATION_SCHEMA_VERSION,
    "transition approval subject schema",
  );
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
    ["execution authority", subject.executionAuthoritySha256,
      request.executionAuthority.authorityDigestSha256],
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

export function buildJsonCompatibilityDeploymentTransitionOperation({
  campaignPlan,
  statePlan,
  authorizedTransition,
}) {
  const plans = validateCurrentPlanPair(campaignPlan, statePlan);
  const authorized = validateJsonCompatibilityDeploymentTransitionAuthorization(
    plans.campaignPlan,
    plans.statePlan,
    authorizedTransition,
  );
  return operationForAuthorized(plans, authorized);
}

export function validateJsonCompatibilityDeploymentTransitionOperation(input) {
  const operation = record(input, "deployment transition operation");
  exactKeys(operation, [
    "schemaVersion", "contract", "operationIdSha256",
    "authorizedRequestSha256", "campaignPlanDigestSha256",
    "statePlanDigestSha256", "transitionId", "operationDigestSha256",
  ], "deployment transition operation");
  equal(operation.schemaVersion, SCHEMA_VERSION, "transition operation schema");
  equal(
    operation.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
    "transition operation contract",
  );
  sha256(operation.operationIdSha256, "transition operation ID");
  sha256(operation.authorizedRequestSha256, "transition authorized request");
  sha256(operation.campaignPlanDigestSha256, "transition campaign plan");
  sha256(operation.statePlanDigestSha256, "transition state plan");
  safeToken(operation.transitionId, "transition operation transition ID");
  const { operationDigestSha256, ...subject } = operation;
  equal(
    operationDigestSha256,
    sha256Canonical(subject),
    "transition operation canonical digest",
  );
  return operation;
}

export function buildJsonCompatibilityDeploymentTransitionReadbackRequest({
  operation,
  sourceAuthenticationDigestSha256,
  transition,
  step,
  phase,
  observationOrdinal,
  expected,
}) {
  const normalizedOperation =
    validateJsonCompatibilityDeploymentTransitionOperation(operation);
  const normalizedTransition = transitionReference(transition);
  equal(
    normalizedTransition.id,
    normalizedOperation.transitionId,
    "readback transition ID",
  );
  const normalizedStep = transitionStep(step, "readback step");
  oneOf(phase, ["source", "target"], "readback phase");
  if (![1, 2].includes(observationOrdinal)) {
    throw new Error("readback observation ordinal is invalid");
  }
  sha256(
    sourceAuthenticationDigestSha256,
    "readback source authentication digest",
  );
  const normalizedExpected = expectedReadback(expected);
  const subject = {
    schemaVersion: 2,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_REQUEST_CONTRACT,
    environment: "staging",
    operation: cloneJson(normalizedOperation),
    sourceAuthenticationDigestSha256,
    transition: cloneJson(normalizedTransition),
    step: cloneJson(normalizedStep),
    phase,
    observationOrdinal,
    expected: cloneJson(normalizedExpected),
  };
  return {
    ...subject,
    readbackRequestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentTransitionReadbackRequest(
  input,
) {
  const request = record(input, "deployment transition readback request");
  exactKeys(request, [
    "schemaVersion", "contract", "environment", "operation",
    "sourceAuthenticationDigestSha256", "transition", "step", "phase",
    "observationOrdinal", "expected", "readbackRequestSha256",
  ], "deployment transition readback request");
  const rebuilt = buildJsonCompatibilityDeploymentTransitionReadbackRequest({
    ...request,
  });
  canonicalEqual(rebuilt, request, "deployment transition readback request");
  return request;
}

export function buildJsonCompatibilityDeploymentTransitionReadback({
  readbackRequestSha256,
  readbackServiceIdentitySha256,
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
  sha256(readbackRequestSha256, "readback request digest");
  sha256(readbackServiceIdentitySha256, "readback service identity");
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
      readbackServiceIdentitySha256,
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
    schemaVersion: 2,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_READBACK_CONTRACT,
    classification,
    readbackRequestSha256,
    readbackServiceIdentitySha256,
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
  mutationRpcRequestSha256,
  mutationServiceIdentitySha256,
  authenticationIdentitySha256,
  mutationRequestSha256,
  mutationAnnotationSha256,
  endpointSha256,
  sentAt,
  classification,
  httpStatus,
  responseBodySha256,
  responseRequestIdSha256,
  responseBytes,
}) {
  const intent = validateMutationIntent(mutationIntent);
  sha256(mutationRpcRequestSha256, "mutation RPC request digest");
  sha256(mutationServiceIdentitySha256, "mutation service identity");
  equal(
    mutationServiceIdentitySha256,
    intent.mutationServiceIdentitySha256,
    "mutation outcome service identity",
  );
  sha256(authenticationIdentitySha256, "mutation authentication identity");
  equal(
    authenticationIdentitySha256,
    intent.mutationCredentialIdSha256,
    "mutation outcome credential identity",
  );
  sha256(mutationRequestSha256, "mutation request digest");
  sha256(mutationAnnotationSha256, "mutation annotation digest");
  sha256(endpointSha256, "mutation endpoint digest");
  integer(sentAt, "mutation send time");
  oneOf(classification, ["accepted", "rejected", "ambiguous"], "mutation outcome");
  nullableHttpStatus(httpStatus, "mutation HTTP status");
  nullableSha256(responseBodySha256, "mutation response body digest");
  nullableSha256(responseRequestIdSha256, "mutation request ID digest");
  nullableNonnegativeInteger(responseBytes, "mutation response bytes");
  const subject = {
    schemaVersion: 2,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_OUTCOME_CONTRACT,
    mutationIntentSha256: intent.mutationIntentSha256,
    mutationRpcRequestSha256,
    mutationServiceIdentitySha256,
    authenticationIdentitySha256,
    mutationRequestSha256,
    mutationAnnotationSha256,
    endpointSha256,
    sentAt,
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
  const operation = operationForAuthorized(validatedPlans, authorized);
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
    const expectedSource = expectedArtifact(
      validatedPlans.statePlan,
      authorized.request.artifactInventoryReadback,
      authorized.request.executionAuthority,
      step,
      "from",
    );
    const expectedTarget = expectedArtifact(
      validatedPlans.statePlan,
      authorized.request.artifactInventoryReadback,
      authorized.request.executionAuthority,
      step,
      "to",
    );
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
      validatedPlans,
      authorized,
      operation,
      sourceAuthentication,
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
      operation,
      sourceAuthentication,
      step,
      expectedTarget,
      sourceRead.observations,
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
      await dependencies.mutateOnce({
        mutationIntent: cloneJson(mutationIntent),
        sourceReadbacks: cloneJson(sourceRead.observations),
      }),
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
      validatedPlans,
      authorized,
      operation,
      sourceAuthentication,
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
  const operation = operationForAuthorized({ campaignPlan, statePlan }, authorized);
  for (let index = 0; index < receipt.steps.length; index += 1) {
    const expectedStep = authorized.request.transition.steps[index];
    const expectedSource = expectedArtifact(
      statePlan,
      authorized.request.artifactInventoryReadback,
      authorized.request.executionAuthority,
      expectedStep,
      "from",
    );
    const expectedTarget = expectedArtifact(
      statePlan,
      authorized.request.artifactInventoryReadback,
      authorized.request.executionAuthority,
      expectedStep,
      "to",
    );
    expectedSource.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    expectedTarget.accountIdSha256 = authorized.request.sourceEvidence.accountIdSha256;
    const step = validateStepReceipt(
      receipt.steps[index],
      {
        expectedStep,
        expectedSource,
        expectedTarget,
        operationIdSha256: authorized.request.operationIdSha256,
        operation,
        authorizedRequestSha256: sha256Canonical(authorized),
        campaignPlanDigestSha256: campaignPlan.planDigestSha256,
        statePlanDigestSha256: statePlan.planDigestSha256,
        artifactInventoryReadbackSha256:
          authorized.request.artifactInventoryReadback
            .artifactInventoryReadbackSha256,
        sourceAuthentication,
        executionAuthority: authorized.request.executionAuthority,
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

function operationForAuthorized(plans, authorized) {
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
    operationIdSha256: authorized.request.operationIdSha256,
    authorizedRequestSha256: sha256Canonical(authorized),
    campaignPlanDigestSha256: plans.campaignPlan.planDigestSha256,
    statePlanDigestSha256: plans.statePlan.planDigestSha256,
    transitionId: authorized.request.transition.id,
  };
  return {
    ...subject,
    operationDigestSha256: sha256Canonical(subject),
  };
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
    "sourceEvidence", "artifactInventoryReadback", "executionAuthority",
  ], "deployment transition request");
  equal(
    request.schemaVersion,
    AUTHORIZATION_SCHEMA_VERSION,
    "transition request schema",
  );
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
  const sourceEvidence = validateSourceEvidence(
    request.sourceEvidence,
    transition,
  );
  validateTransitionArtifactInventory(
    campaignPlan,
    statePlan,
    sourceEvidence,
    request.artifactInventoryReadback,
  );
  const authority = validateJsonCompatibilityDeploymentTransitionExecutionAuthority(
    request.executionAuthority,
    sourceEvidence.accountIdSha256,
  );
  equal(
    authority.sourceVerifier.identitySha256,
    sourceEvidence.sourceVerifierIdentitySha256,
    "execution authority source verifier identity",
  );
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

function validateTransitionArtifactInventory(
  campaignPlan,
  statePlan,
  sourceEvidence,
  input,
) {
  const inventory = record(input, "transition artifact inventory readback");
  exactKeys(inventory, [
    "schemaVersion", "contract", "kind", "environment",
    "accountIdSha256", "campaignPlanDigestSha256", "statePlanDigestSha256",
    "artifacts", "artifactCount", "observedAt",
    "artifactInventoryReadbackSha256",
  ], "transition artifact inventory readback");
  equal(inventory.schemaVersion, SCHEMA_VERSION, "artifact inventory schema");
  equal(
    inventory.contract,
    SOURCE_ARTIFACT_INVENTORY_CONTRACT,
    "artifact inventory contract",
  );
  equal(
    inventory.kind,
    "container-runtime-json-compatibility-source-artifact-inventory",
    "artifact inventory kind",
  );
  equal(inventory.environment, "staging", "artifact inventory environment");
  equal(
    inventory.accountIdSha256,
    sourceEvidence.accountIdSha256,
    "artifact inventory account ID",
  );
  equal(
    inventory.campaignPlanDigestSha256,
    campaignPlan.planDigestSha256,
    "artifact inventory campaign plan",
  );
  equal(
    inventory.statePlanDigestSha256,
    statePlan.planDigestSha256,
    "artifact inventory state plan",
  );
  if (!Array.isArray(inventory.artifacts)) {
    throw new Error("transition artifact inventory is not an array");
  }
  const expected = [];
  for (const [role, service] of Object.entries(statePlan.services)) {
    for (const [artifact, frozen] of Object.entries(service.artifacts)) {
      expected.push({ role, artifact, service, frozen });
    }
  }
  expected.sort((left, right) =>
    `${left.role}:${left.artifact}`.localeCompare(
      `${right.role}:${right.artifact}`,
    ));
  equal(
    inventory.artifacts.length,
    expected.length,
    "artifact inventory artifact count",
  );
  const artifacts = expected.map((entry, index) => {
    const artifact = record(
      inventory.artifacts[index],
      "transition artifact inventory observation",
    );
    exactKeys(artifact, [
      "role", "artifact", "serviceName", "entrypoint", "deploymentState",
      "versionId", "configSha256", "gates", "privateRpcOnly", "workersDev",
      "previewUrls", "bindingSetSha256", "routeSetSha256",
      "secretNameSetSha256", "durableObjectMigrationSetSha256",
    ], "transition artifact inventory observation");
    for (const [label, actual, frozen] of [
      ["role", artifact.role, entry.role],
      ["artifact", artifact.artifact, entry.artifact],
      ["service name", artifact.serviceName, entry.service.serviceName],
      ["entrypoint", artifact.entrypoint, entry.service.entrypoint],
      ["deployment state", artifact.deploymentState,
        entry.frozen.deploymentState],
      ["version ID", artifact.versionId, entry.frozen.versionId],
      ["config digest", artifact.configSha256, entry.frozen.configSha256],
      ["private RPC", artifact.privateRpcOnly, entry.service.privateRpcOnly],
      ["workers.dev", artifact.workersDev, entry.service.workersDev],
      ["preview URLs", artifact.previewUrls, entry.service.previewUrls],
    ]) equal(actual, frozen, `artifact inventory ${label}`);
    canonicalEqual(
      artifact.gates,
      entry.frozen.gates,
      "artifact inventory gates",
    );
    for (const [label, digest] of [
      ["binding set", artifact.bindingSetSha256],
      ["route set", artifact.routeSetSha256],
      ["secret-name set", artifact.secretNameSetSha256],
      ["Durable Object migration set",
        artifact.durableObjectMigrationSetSha256],
    ]) sha256(digest, `artifact inventory ${label}`);
    equal(
      artifact.routeSetSha256,
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EMPTY_ROUTE_SET_SHA256,
      "artifact inventory empty route set",
    );
    return cloneJson(artifact);
  });
  equal(inventory.artifactCount, artifacts.length, "artifact inventory count");
  integer(inventory.observedAt, "artifact inventory observation time");
  const { artifactInventoryReadbackSha256, ...subject } = inventory;
  equal(
    artifactInventoryReadbackSha256,
    sha256Canonical(subject),
    "artifact inventory canonical digest",
  );
  equal(
    artifactInventoryReadbackSha256,
    sourceEvidence.artifactInventoryReadbackSha256,
    "signed artifact inventory digest",
  );
  return cloneJson({ ...subject, artifacts, artifactInventoryReadbackSha256 });
}

export function buildJsonCompatibilityDeploymentLeafServiceIdentity({
  accountIdSha256,
  serviceName,
  entrypoint,
  versionId,
  profileVersion,
  privateRpcOnly,
  capability,
  credentialIdSha256,
}) {
  sha256(accountIdSha256, "deployment leaf identity account ID");
  safeToken(serviceName, "deployment leaf identity service name");
  safeToken(entrypoint, "deployment leaf identity entrypoint");
  safeToken(versionId, "deployment leaf identity version ID");
  equal(profileVersion, 1, "deployment leaf identity profile version");
  equal(privateRpcOnly, true, "deployment leaf identity private RPC");
  oneOf(
    capability,
    ["read-only", "mutation-only"],
    "deployment leaf identity capability",
  );
  sha256(credentialIdSha256, "deployment leaf identity credential ID");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_IDENTITY_CONTRACT,
    environment: "staging",
    accountIdSha256,
    serviceName,
    entrypoint,
    versionId,
    profileVersion,
    privateRpcOnly,
    capability,
    credentialIdSha256,
  };
  return {
    ...subject,
    identitySha256: sha256Canonical(subject),
  };
}

export function buildJsonCompatibilityDeploymentTransitionExecutionAuthority({
  accountIdSha256,
  coordinator,
  sourceVerifier,
  readback,
  mutation,
}) {
  sha256(accountIdSha256, "execution authority account ID");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_AUTHORITY_CONTRACT,
    environment: "staging",
    accountIdSha256,
    coordinator: executionServiceAuthority(
      coordinator,
      "coordinate-only",
      false,
      "execution authority coordinator",
    ),
    sourceVerifier: executionServiceAuthority(
      sourceVerifier,
      "source-verify-only",
      false,
      "execution authority source verifier",
    ),
    readback: executionServiceAuthority(
      readback,
      "read-only",
      true,
      "execution authority readback",
    ),
    mutation: executionServiceAuthority(
      mutation,
      "mutation-only",
      true,
      "execution authority mutation",
    ),
  };
  const serviceNames = Object.values(subject)
    .filter((value) => value !== null && typeof value === "object")
    .map((value) => value.serviceName)
    .filter((value) => typeof value === "string");
  const identities = [
    subject.coordinator.identitySha256,
    subject.sourceVerifier.identitySha256,
    subject.readback.identitySha256,
    subject.mutation.identitySha256,
  ];
  if (
    new Set(serviceNames).size !== serviceNames.length
    || new Set(identities).size !== identities.length
    || subject.readback.credentialIdSha256
      === subject.mutation.credentialIdSha256
  ) {
    throw new Error("execution authority separation is invalid");
  }
  for (const [label, leaf] of [
    ["readback", subject.readback],
    ["mutation", subject.mutation],
  ]) {
    const identity = buildJsonCompatibilityDeploymentLeafServiceIdentity({
      accountIdSha256,
      ...leaf,
    });
    equal(
      leaf.identitySha256,
      identity.identitySha256,
      `execution authority ${label} derived identity`,
    );
  }
  return {
    ...subject,
    authorityDigestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentTransitionExecutionAuthority(
  input,
  expectedAccountIdSha256 = null,
) {
  const authority = record(input, "deployment transition execution authority");
  exactKeys(authority, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "coordinator", "sourceVerifier", "readback", "mutation",
    "authorityDigestSha256",
  ], "deployment transition execution authority");
  const rebuilt = buildJsonCompatibilityDeploymentTransitionExecutionAuthority({
    ...authority,
  });
  canonicalEqual(
    rebuilt,
    authority,
    "deployment transition execution authority",
  );
  if (expectedAccountIdSha256 !== null) {
    equal(
      authority.accountIdSha256,
      expectedAccountIdSha256,
      "execution authority account ID",
    );
  }
  return authority;
}

function executionServiceAuthority(
  input,
  expectedCapability,
  requiresCredential,
  label,
) {
  const value = record(input, label);
  exactKeys(value, [
    "serviceName", "entrypoint", "versionId", "profileVersion",
    "privateRpcOnly", "capability", "credentialIdSha256",
    "identitySha256",
  ], label);
  safeToken(value.serviceName, `${label} service name`);
  safeToken(value.entrypoint, `${label} entrypoint`);
  safeToken(value.versionId, `${label} version ID`);
  equal(value.profileVersion, 1, `${label} profile version`);
  equal(value.privateRpcOnly, true, `${label} private RPC`);
  equal(value.capability, expectedCapability, `${label} capability`);
  if (requiresCredential) {
    sha256(value.credentialIdSha256, `${label} credential ID`);
  } else {
    equal(value.credentialIdSha256, null, `${label} credential ID`);
  }
  sha256(value.identitySha256, `${label} identity`);
  return cloneJson(value);
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
  plans,
  authorized,
  operation,
  sourceAuthentication,
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
    const readbackRequest =
      buildJsonCompatibilityDeploymentTransitionReadbackRequest({
        operation,
        sourceAuthenticationDigestSha256:
          sourceAuthentication.sourceAuthenticationDigestSha256,
        transition: {
          id: authorized.request.transition.id,
          ordinal: authorized.request.transition.ordinal,
        },
        step,
        phase,
        observationOrdinal: ordinal,
        expected,
      });
    equal(
      readbackRequest.operation.campaignPlanDigestSha256,
      plans.campaignPlan.planDigestSha256,
      "readback campaign plan digest",
    );
    equal(
      readbackRequest.operation.statePlanDigestSha256,
      plans.statePlan.planDigestSha256,
      "readback state plan digest",
    );
    const observation = validateReadback(
      await dependencies.readback(cloneJson(readbackRequest)),
    );
    equal(
      observation.readbackRequestSha256,
      readbackRequest.readbackRequestSha256,
      "readback observation request digest",
    );
    equal(
      observation.readbackServiceIdentitySha256,
      authorized.request.executionAuthority.readback.identitySha256,
      "readback observation service identity",
    );
    equal(
      observation.authenticationIdentitySha256,
      authorized.request.executionAuthority.readback.credentialIdSha256,
      "readback observation credential identity",
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

function transitionReference(input) {
  const value = record(input, "deployment transition reference");
  exactKeys(value, ["id", "ordinal"], "deployment transition reference");
  safeToken(value.id, "deployment transition reference ID");
  integer(value.ordinal, "deployment transition reference ordinal");
  return cloneJson(value);
}

function transitionStep(input, label) {
  const value = record(input, label);
  exactKeys(value, [
    "ordinal", "role", "fromArtifact", "toArtifact", "targetVersionId",
    "targetConfigSha256",
  ], label);
  integer(value.ordinal, `${label} ordinal`);
  safeToken(value.role, `${label} role`);
  oneOf(value.fromArtifact, [...DEPLOYMENT_STATES], `${label} source artifact`);
  oneOf(value.toArtifact, [...DEPLOYMENT_STATES], `${label} target artifact`);
  safeToken(value.targetVersionId, `${label} target version`);
  sha256(value.targetConfigSha256, `${label} target config`);
  return cloneJson(value);
}

function expectedReadback(input) {
  const value = record(input, "deployment transition expected readback");
  exactKeys(value, [
    "environment", "accountIdSha256", "serviceName", "entrypoint",
    "versionId", "configSha256", "deploymentState", "gates",
    "privateRpcOnly", "workersDev", "previewUrls", "bindingSetSha256",
    "routeSetSha256", "secretNameSetSha256",
    "durableObjectMigrationSetSha256", "authenticationIdentitySha256",
  ], "deployment transition expected readback");
  equal(value.environment, "staging", "expected readback environment");
  sha256(value.accountIdSha256, "expected readback account ID");
  safeToken(value.serviceName, "expected readback service name");
  safeToken(value.entrypoint, "expected readback entrypoint");
  safeToken(value.versionId, "expected readback version ID");
  sha256(value.configSha256, "expected readback config digest");
  oneOf(
    value.deploymentState,
    [...DEPLOYMENT_STATES],
    "expected readback deployment state",
  );
  booleanRecord(value.gates, "expected readback gates");
  boolean(value.privateRpcOnly, "expected readback private RPC");
  boolean(value.workersDev, "expected readback workers_dev");
  boolean(value.previewUrls, "expected readback preview URLs");
  sha256(value.bindingSetSha256, "expected readback binding set");
  sha256(value.routeSetSha256, "expected readback route set");
  sha256(value.secretNameSetSha256, "expected readback secret-name set");
  sha256(
    value.durableObjectMigrationSetSha256,
    "expected readback Durable Object migration set",
  );
  sha256(
    value.authenticationIdentitySha256,
    "expected readback authentication identity",
  );
  return cloneJson(value);
}

function expectedArtifact(
  statePlan,
  artifactInventoryReadback,
  executionAuthority,
  step,
  side,
) {
  const state = side === "from" ? step.fromArtifact : step.toArtifact;
  const key = state === "status-only" ? "statusOnly" : state;
  const service = statePlan.services[step.role];
  const artifact = service.artifacts[key];
  const observation = artifactInventoryReadback.artifacts.find((value) =>
    value.role === step.role && value.artifact === key);
  if (observation === undefined) {
    throw new Error("transition artifact inventory observation is absent");
  }
  return {
    environment: "staging",
    accountIdSha256: artifactInventoryReadback.accountIdSha256,
    serviceName: observation.serviceName,
    entrypoint: observation.entrypoint,
    versionId: observation.versionId,
    configSha256: observation.configSha256,
    deploymentState: observation.deploymentState,
    gates: cloneJson(observation.gates),
    privateRpcOnly: observation.privateRpcOnly,
    workersDev: observation.workersDev,
    previewUrls: observation.previewUrls,
    bindingSetSha256: observation.bindingSetSha256,
    routeSetSha256: observation.routeSetSha256,
    secretNameSetSha256: observation.secretNameSetSha256,
    durableObjectMigrationSetSha256:
      observation.durableObjectMigrationSetSha256,
    authenticationIdentitySha256:
      executionAuthority.readback.credentialIdSha256,
  };
}

function classifyReadback(observation, expected) {
  if (observation.classification === "ambiguous") return "ambiguous";
  for (const key of [
    "environment", "accountIdSha256", "serviceName", "entrypoint", "versionId", "configSha256",
    "deploymentState", "privateRpcOnly", "workersDev", "previewUrls",
    "bindingSetSha256", "routeSetSha256", "secretNameSetSha256",
    "durableObjectMigrationSetSha256", "authenticationIdentitySha256",
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

export function buildJsonCompatibilityDeploymentTransitionMutationIntent(
  authorized,
  operation,
  sourceAuthentication,
  step,
  expected,
  sourceReadbacks,
) {
  const normalizedOperation =
    validateJsonCompatibilityDeploymentTransitionOperation(operation);
  const normalizedSourceAuthentication = record(
    sourceAuthentication,
    "mutation source authentication",
  );
  sha256(
    normalizedSourceAuthentication.sourceAuthenticationDigestSha256,
    "mutation source authentication digest",
  );
  if (!Array.isArray(sourceReadbacks) || sourceReadbacks.length !== 2) {
    throw new Error("mutation source readback set is invalid");
  }
  const observations = sourceReadbacks.map((value) => validateReadback(value));
  const sourceStateSha256 = observations[1].remoteStateSha256;
  sha256(sourceStateSha256, "mutation source state digest");
  equal(
    observations[0].readbackServiceIdentitySha256,
    observations[1].readbackServiceIdentitySha256,
    "mutation readback service identity",
  );
  for (const observation of observations) {
    equal(
      observation.readbackServiceIdentitySha256,
      authorized.request.executionAuthority.readback.identitySha256,
      "mutation approved readback service identity",
    );
    equal(
      observation.authenticationIdentitySha256,
      authorized.request.executionAuthority.readback.credentialIdSha256,
      "mutation approved readback credential identity",
    );
  }
  const subject = {
    schemaVersion: 2,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT,
    environment: "staging",
    operationIdSha256: authorized.request.operationIdSha256,
    operationDigestSha256: normalizedOperation.operationDigestSha256,
    authorizedRequestSha256: normalizedOperation.authorizedRequestSha256,
    campaignPlanDigestSha256: normalizedOperation.campaignPlanDigestSha256,
    statePlanDigestSha256: normalizedOperation.statePlanDigestSha256,
    executionAuthoritySha256:
      authorized.request.executionAuthority.authorityDigestSha256,
    artifactInventoryReadbackSha256:
      authorized.request.artifactInventoryReadback
        .artifactInventoryReadbackSha256,
    sourceAuthenticationDigestSha256:
      normalizedSourceAuthentication.sourceAuthenticationDigestSha256,
    transitionId: authorized.request.transition.id,
    transitionOrdinal: authorized.request.transition.ordinal,
    stepOrdinal: step.ordinal,
    role: step.role,
    serviceName: expected.serviceName,
    entrypoint: expected.entrypoint,
    fromArtifact: step.fromArtifact,
    toArtifact: step.toArtifact,
    targetVersionId: expected.versionId,
    targetConfigSha256: expected.configSha256,
    sourceStateSha256,
    sourceReadbackSetSha256: sha256Canonical(observations),
    readbackServiceIdentitySha256:
      observations[0].readbackServiceIdentitySha256,
    readbackCredentialIdSha256:
      authorized.request.executionAuthority.readback.credentialIdSha256,
    mutationServiceIdentitySha256:
      authorized.request.executionAuthority.mutation.identitySha256,
    mutationCredentialIdSha256:
      authorized.request.executionAuthority.mutation.credentialIdSha256,
  };
  return {
    ...subject,
    mutationIntentSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentTransitionMutationIntent(
  input,
) {
  const intent = record(input, "deployment transition mutation intent");
  exactKeys(intent, [
    "schemaVersion", "contract", "environment", "operationIdSha256",
    "operationDigestSha256", "authorizedRequestSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256",
    "executionAuthoritySha256", "artifactInventoryReadbackSha256",
    "sourceAuthenticationDigestSha256",
    "transitionId", "transitionOrdinal", "stepOrdinal", "role", "serviceName",
    "entrypoint",
    "fromArtifact", "toArtifact", "targetVersionId", "targetConfigSha256",
    "sourceStateSha256", "sourceReadbackSetSha256",
    "readbackServiceIdentitySha256", "readbackCredentialIdSha256",
    "mutationServiceIdentitySha256", "mutationCredentialIdSha256",
    "mutationIntentSha256",
  ], "deployment transition mutation intent");
  equal(intent.schemaVersion, 2, "mutation intent schema");
  equal(
    intent.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MUTATION_INTENT_CONTRACT,
    "mutation intent contract",
  );
  equal(intent.environment, "staging", "mutation intent environment");
  sha256(intent.operationIdSha256, "mutation operation ID");
  sha256(intent.operationDigestSha256, "mutation operation digest");
  sha256(intent.authorizedRequestSha256, "mutation authorized request digest");
  sha256(intent.campaignPlanDigestSha256, "mutation campaign plan digest");
  sha256(intent.statePlanDigestSha256, "mutation state plan digest");
  sha256(intent.executionAuthoritySha256, "mutation execution authority");
  sha256(
    intent.artifactInventoryReadbackSha256,
    "mutation artifact inventory readback",
  );
  sha256(
    intent.sourceAuthenticationDigestSha256,
    "mutation source authentication",
  );
  safeToken(intent.transitionId, "mutation transition ID");
  integer(intent.transitionOrdinal, "mutation transition ordinal");
  integer(intent.stepOrdinal, "mutation step ordinal");
  safeToken(intent.role, "mutation role");
  safeToken(intent.serviceName, "mutation service name");
  safeToken(intent.entrypoint, "mutation entrypoint");
  oneOf(intent.fromArtifact, [...DEPLOYMENT_STATES], "mutation source artifact");
  oneOf(intent.toArtifact, [...DEPLOYMENT_STATES], "mutation target artifact");
  safeToken(intent.targetVersionId, "mutation target version ID");
  sha256(intent.targetConfigSha256, "mutation target config digest");
  sha256(intent.sourceStateSha256, "mutation source state digest");
  sha256(intent.sourceReadbackSetSha256, "mutation source readback set");
  sha256(
    intent.readbackServiceIdentitySha256,
    "mutation readback service identity",
  );
  sha256(intent.readbackCredentialIdSha256, "mutation readback credential ID");
  sha256(
    intent.mutationServiceIdentitySha256,
    "mutation service identity",
  );
  sha256(intent.mutationCredentialIdSha256, "mutation credential ID");
  const { mutationIntentSha256, ...subject } = intent;
  equal(
    mutationIntentSha256,
    sha256Canonical(subject),
    "mutation intent canonical digest",
  );
  return intent;
}

const buildMutationIntent =
  buildJsonCompatibilityDeploymentTransitionMutationIntent;
const validateMutationIntent =
  validateJsonCompatibilityDeploymentTransitionMutationIntent;

function validateMutationOutcome(input, expectedIntent) {
  const outcome = record(input, "deployment transition mutation outcome");
  exactKeys(outcome, [
    "schemaVersion", "contract", "mutationIntentSha256",
    "mutationRpcRequestSha256", "mutationServiceIdentitySha256",
    "authenticationIdentitySha256", "mutationRequestSha256",
    "mutationAnnotationSha256", "endpointSha256", "sentAt", "classification",
    "httpStatus", "responseBodySha256", "responseRequestIdSha256",
    "responseBytes", "outcomeDigestSha256",
  ], "deployment transition mutation outcome");
  equal(outcome.schemaVersion, 2, "mutation outcome schema");
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
  for (const [label, value] of [
    ["RPC request", outcome.mutationRpcRequestSha256],
    ["service identity", outcome.mutationServiceIdentitySha256],
    ["authentication identity", outcome.authenticationIdentitySha256],
    ["request", outcome.mutationRequestSha256],
    ["annotation", outcome.mutationAnnotationSha256],
    ["endpoint", outcome.endpointSha256],
  ]) sha256(value, `mutation outcome ${label}`);
  equal(
    outcome.mutationServiceIdentitySha256,
    expectedIntent.mutationServiceIdentitySha256,
    "mutation outcome service identity",
  );
  equal(
    outcome.authenticationIdentitySha256,
    expectedIntent.mutationCredentialIdSha256,
    "mutation outcome credential identity",
  );
  integer(outcome.sentAt, "mutation outcome send time");
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

export function validateJsonCompatibilityDeploymentTransitionExecutionContext(
  {
    campaignPlan: campaignPlanInput,
    statePlan: statePlanInput,
    authorizedTransition: authorizedTransitionInput,
    sourceAuthentication: sourceAuthenticationInput,
  },
  { now = new Date() } = {},
) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  const authorizedTransition =
    validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      authorizedTransitionInput,
      { now, requireUsableWindow: true },
    );
  const sourceAuthentication = validateSourceAuthentication(
    sourceAuthenticationInput,
    sourceAuthenticationRequestForAuthorized(
      campaignPlan,
      statePlan,
      authorizedTransition,
    ),
  );
  equal(
    sourceAuthentication.classification,
    "authenticated",
    "deployment leaf source authentication classification",
  );
  const observedAt = epochSeconds(now, "deployment leaf validation time");
  if (
    sourceAuthentication.verifiedAt < observedAt -
      SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS
    || sourceAuthentication.verifiedAt > observedAt + CLOCK_SKEW_SECONDS
  ) {
    throw new Error("deployment leaf source authentication proof is stale");
  }
  return {
    campaignPlan: cloneJson(campaignPlan),
    statePlan: cloneJson(statePlan),
    authorizedTransition: cloneJson(authorizedTransition),
    sourceAuthentication: cloneJson(sourceAuthentication),
    artifactInventoryReadback: cloneJson(
      authorizedTransition.request.artifactInventoryReadback,
    ),
    operation: operationForAuthorized(
      { campaignPlan, statePlan },
      authorizedTransition,
    ),
  };
}

export function validateJsonCompatibilityDeploymentTransitionReadbackExecution(
  input,
  options = {},
) {
  const value = record(input, "deployment readback execution envelope");
  exactKeys(value, [
    "campaignPlan", "statePlan", "authorizedTransition",
    "sourceAuthentication", "readbackRequest",
  ], "deployment readback execution envelope");
  const context =
    validateJsonCompatibilityDeploymentTransitionExecutionContext(value, options);
  const request =
    validateJsonCompatibilityDeploymentTransitionReadbackRequest(
      value.readbackRequest,
    );
  const transition = context.authorizedTransition.request.transition;
  const step = transition.steps.find((candidate) =>
    candidate.ordinal === request.step.ordinal);
  if (step === undefined) {
    throw new Error("deployment readback step is not owner authorized");
  }
  canonicalEqual(request.step, step, "deployment readback authorized step");
  const expected = expectedArtifact(
    context.statePlan,
    context.artifactInventoryReadback,
    context.authorizedTransition.request.executionAuthority,
    step,
    request.phase === "source" ? "from" : "to",
  );
  const rebuilt = buildJsonCompatibilityDeploymentTransitionReadbackRequest({
    operation: context.operation,
    sourceAuthenticationDigestSha256:
      context.sourceAuthentication.sourceAuthenticationDigestSha256,
    transition: { id: transition.id, ordinal: transition.ordinal },
    step,
    phase: request.phase,
    observationOrdinal: request.observationOrdinal,
    expected,
  });
  canonicalEqual(rebuilt, request, "deployment readback owner authorization");
  return { ...context, readbackRequest: cloneJson(request), expected };
}

export function validateJsonCompatibilityDeploymentTransitionMutationExecution(
  input,
  options = {},
) {
  const value = record(input, "deployment mutation execution envelope");
  exactKeys(value, [
    "campaignPlan", "statePlan", "authorizedTransition",
    "sourceAuthentication", "mutationIntent", "sourceReadbacks",
  ], "deployment mutation execution envelope");
  const context =
    validateJsonCompatibilityDeploymentTransitionExecutionContext(value, options);
  const intent = validateMutationIntent(value.mutationIntent);
  const transition = context.authorizedTransition.request.transition;
  const step = transition.steps.find((candidate) =>
    candidate.ordinal === intent.stepOrdinal);
  if (step === undefined) {
    throw new Error("deployment mutation step is not owner authorized");
  }
  if (!Array.isArray(value.sourceReadbacks) || value.sourceReadbacks.length !== 2) {
    throw new Error("deployment mutation source readback set is invalid");
  }
  const sourceReadbacks = value.sourceReadbacks.map((observation, index) => {
    const readback = validateReadback(observation);
    const readbackRequest =
      buildJsonCompatibilityDeploymentTransitionReadbackRequest({
        operation: context.operation,
        sourceAuthenticationDigestSha256:
          context.sourceAuthentication.sourceAuthenticationDigestSha256,
        transition: { id: transition.id, ordinal: transition.ordinal },
        step,
        phase: "source",
        observationOrdinal: index + 1,
        expected: expectedArtifact(
          context.statePlan,
          context.artifactInventoryReadback,
          context.authorizedTransition.request.executionAuthority,
          step,
          "from",
        ),
      });
    equal(
      readback.readbackRequestSha256,
      readbackRequest.readbackRequestSha256,
      "deployment mutation source readback request",
    );
    return readback;
  });
  const expectedSource = expectedArtifact(
    context.statePlan,
    context.artifactInventoryReadback,
    context.authorizedTransition.request.executionAuthority,
    step,
    "from",
  );
  equal(
    classifyReadbackPair(sourceReadbacks, expectedSource),
    "stable",
    "deployment mutation stable source readback",
  );
  const expectedTarget = expectedArtifact(
    context.statePlan,
    context.artifactInventoryReadback,
    context.authorizedTransition.request.executionAuthority,
    step,
    "to",
  );
  const rebuiltIntent = buildMutationIntent(
    context.authorizedTransition,
    context.operation,
    context.sourceAuthentication,
    step,
    expectedTarget,
    sourceReadbacks,
  );
  canonicalEqual(rebuiltIntent, intent, "deployment mutation owner authorization");
  return {
    ...context,
    mutationIntent: cloneJson(intent),
    sourceReadbacks: cloneJson(sourceReadbacks),
    expectedSource,
    expectedTarget,
  };
}

export function validateJsonCompatibilityDeploymentTransitionReadback(input) {
  const observation = record(input, "deployment transition readback");
  exactKeys(observation, [
    "schemaVersion", "contract", "classification", "readbackRequestSha256",
    "readbackServiceIdentitySha256", "environment", "serviceName",
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

const validateReadback =
  validateJsonCompatibilityDeploymentTransitionReadback;

function validateStepReceipt(input, context) {
  const {
    expectedStep,
    expectedSource,
    expectedTarget,
    operationIdSha256,
    operation,
    authorizedRequestSha256,
    campaignPlanDigestSha256,
    statePlanDigestSha256,
    artifactInventoryReadbackSha256,
    sourceAuthentication,
    executionAuthority,
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
  for (const [phase, observations, expected] of [
    ["source", step.sourceReadbacks, expectedSource],
    ["target", step.targetReadbacks, expectedTarget],
  ]) {
    for (let index = 0; index < observations.length; index += 1) {
      const request =
        buildJsonCompatibilityDeploymentTransitionReadbackRequest({
          operation,
          sourceAuthenticationDigestSha256:
            sourceAuthentication.sourceAuthenticationDigestSha256,
          transition: { id: transitionId, ordinal: transitionOrdinal },
          step: expectedStep,
          phase,
          observationOrdinal: index + 1,
          expected,
        });
      equal(
        observations[index].readbackRequestSha256,
        request.readbackRequestSha256,
        `transition ${phase} readback request digest`,
      );
      equal(
        observations[index].readbackServiceIdentitySha256,
        executionAuthority.readback.identitySha256,
        `transition ${phase} readback service identity`,
      );
    }
  }
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
      ["operation digest", intent.operationDigestSha256,
        operation.operationDigestSha256],
      ["authorized request digest", intent.authorizedRequestSha256, authorizedRequestSha256],
      ["campaign plan digest", intent.campaignPlanDigestSha256,
        campaignPlanDigestSha256],
      ["state plan digest", intent.statePlanDigestSha256,
        statePlanDigestSha256],
      ["execution authority", intent.executionAuthoritySha256,
        executionAuthority.authorityDigestSha256],
      ["artifact inventory readback", intent.artifactInventoryReadbackSha256,
        artifactInventoryReadbackSha256],
      ["source authentication", intent.sourceAuthenticationDigestSha256,
        sourceAuthentication.sourceAuthenticationDigestSha256],
      ["transition ID", intent.transitionId, transitionId],
      ["transition ordinal", intent.transitionOrdinal, transitionOrdinal],
      ["step ordinal", intent.stepOrdinal, expectedStep.ordinal],
      ["role", intent.role, expectedStep.role],
      ["service name", intent.serviceName, expectedTarget.serviceName],
      ["entrypoint", intent.entrypoint, expectedTarget.entrypoint],
      ["source artifact", intent.fromArtifact, expectedStep.fromArtifact],
      ["target artifact", intent.toArtifact, expectedStep.toArtifact],
      ["target version", intent.targetVersionId, expectedStep.targetVersionId],
      ["target config", intent.targetConfigSha256, expectedStep.targetConfigSha256],
      ["source state", intent.sourceStateSha256, step.sourceReadbacks[1].remoteStateSha256],
      ["source readback set", intent.sourceReadbackSetSha256,
        sha256Canonical(step.sourceReadbacks)],
      ["readback service identity", intent.readbackServiceIdentitySha256,
        executionAuthority.readback.identitySha256],
      ["readback credential ID", intent.readbackCredentialIdSha256,
        executionAuthority.readback.credentialIdSha256],
      ["mutation service identity", intent.mutationServiceIdentitySha256,
        executionAuthority.mutation.identitySha256],
      ["mutation credential ID", intent.mutationCredentialIdSha256,
        executionAuthority.mutation.credentialIdSha256],
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
