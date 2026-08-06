import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";

import {
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionOperation,
  classifyJsonCompatibilityDeploymentTransitionReadbackPair,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS,
  validateJsonCompatibilityDeploymentTransitionAuthorization,
  validateJsonCompatibilityDeploymentTransitionReadback,
  validateJsonCompatibilityDeploymentTransitionReadbackRequest,
  validateJsonCompatibilityDeploymentTransitionRecoveryContext,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";

export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLVER_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolver-identity-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-request-v1";
export const JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_RESOLUTION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-authorized-deployment-resolution-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-approval-subject-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-approval-envelope-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-receipt-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_EXECUTION_DISABLED_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-execution-disabled-evidence-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-approval-v1\n";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging";
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MINIMUM_QUIESCENCE_SECONDS =
  30;
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_CLAIM_LEASE_SECONDS = 45;
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_AUTHORIZATION_SECONDS =
  600;
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS =
  30;

const CLOCK_SKEW_SECONDS = 5;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOLUTION_CLASSIFICATIONS = new Set([
  "target_confirmed",
  "manual_review_required",
  "readback_inconclusive",
]);
const RESOLUTION_REASON_CODES = new Set([
  "target_state_confirmed",
  "target_state_drift",
  "target_state_unstable",
  "target_state_ambiguous",
  "no_mutation_intent",
  "journal_checkpoint_not_readable",
]);

export function buildJsonCompatibilityDeploymentResolverIdentity({
  accountIdSha256,
  serviceName,
  entrypoint,
  versionId,
  profileVersion = 1,
  privateRpcOnly = true,
  capability = "resolve-readback-only",
}) {
  sha256(accountIdSha256, "resolver identity account ID");
  safeToken(serviceName, "resolver identity service name");
  safeToken(entrypoint, "resolver identity entrypoint");
  safeToken(versionId, "resolver identity version ID");
  equal(profileVersion, 1, "resolver identity profile version");
  equal(privateRpcOnly, true, "resolver identity private RPC");
  equal(capability, "resolve-readback-only", "resolver identity capability");
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_RESOLVER_IDENTITY_CONTRACT,
    environment: "staging",
    accountIdSha256,
    serviceName,
    entrypoint,
    versionId,
    profileVersion,
    privateRpcOnly,
    capability,
    cloudflareApiCredentialPresent: false,
    mutationBindingPresent: false,
    sourceVerifierBindingPresent: false,
  };
  return {
    ...subject,
    identitySha256: sha256Canonical(subject),
  };
}

export function buildJsonCompatibilityDeploymentExecutionDisabledEvidence({
  accountIdSha256,
  coordinatorServiceName,
  coordinatorEntrypoint,
  coordinatorVersionId,
  coordinatorIdentitySha256,
  coordinatorConfigurationSha256,
  callerTopologySha256,
  executionDisabledAt,
  maximumAdmittedRequestLifetimeSeconds,
  propagationAllowanceSeconds,
  clockSkewAllowanceSeconds,
  requiredQuiescenceSeconds = maximumAdmittedRequestLifetimeSeconds
    + propagationAllowanceSeconds + clockSkewAllowanceSeconds,
  quiescenceSatisfiedAt = executionDisabledAt + requiredQuiescenceSeconds,
  observedAt,
}) {
  sha256(accountIdSha256, "execution-disabled evidence account ID");
  safeToken(
    coordinatorServiceName,
    "execution-disabled evidence coordinator service",
  );
  safeToken(
    coordinatorEntrypoint,
    "execution-disabled evidence coordinator entrypoint",
  );
  safeToken(
    coordinatorVersionId,
    "execution-disabled evidence coordinator version",
  );
  for (const [label, value] of [
    ["coordinator identity", coordinatorIdentitySha256],
    ["coordinator configuration", coordinatorConfigurationSha256],
    ["caller topology", callerTopologySha256],
  ]) sha256(value, `execution-disabled evidence ${label}`);
  integer(executionDisabledAt, "execution-disabled evidence disable time");
  for (const [label, value, minimum] of [
    ["maximum admitted request lifetime",
      maximumAdmittedRequestLifetimeSeconds, 1],
    ["propagation allowance", propagationAllowanceSeconds, 0],
    ["clock-skew allowance", clockSkewAllowanceSeconds, 0],
  ]) {
    integer(value, `execution-disabled evidence ${label}`);
    if (value < minimum || value > 3_600) {
      throw new Error(`execution-disabled evidence ${label} is invalid`);
    }
  }
  integer(
    requiredQuiescenceSeconds,
    "execution-disabled evidence required quiescence",
  );
  equal(
    requiredQuiescenceSeconds,
    maximumAdmittedRequestLifetimeSeconds
      + propagationAllowanceSeconds + clockSkewAllowanceSeconds,
    "execution-disabled evidence audited quiescence",
  );
  if (
    requiredQuiescenceSeconds
      < JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MINIMUM_QUIESCENCE_SECONDS
    || requiredQuiescenceSeconds > 7_200
  ) {
    throw new Error("execution-disabled evidence quiescence is invalid");
  }
  integer(
    quiescenceSatisfiedAt,
    "execution-disabled evidence satisfaction time",
  );
  equal(
    quiescenceSatisfiedAt,
    executionDisabledAt + requiredQuiescenceSeconds,
    "execution-disabled evidence satisfaction boundary",
  );
  integer(observedAt, "execution-disabled evidence observation time");
  if (
    observedAt < quiescenceSatisfiedAt
    || observedAt - quiescenceSatisfiedAt
      > JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS
  ) {
    throw new Error("execution-disabled evidence observation time is invalid");
  }
  const subject = {
    schemaVersion: 1,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_EXECUTION_DISABLED_EVIDENCE_CONTRACT,
    environment: "staging",
    accountIdSha256,
    coordinatorServiceName,
    coordinatorEntrypoint,
    coordinatorVersionId,
    coordinatorIdentitySha256,
    coordinatorConfigurationSha256,
    callerTopologySha256,
    executionEnabled: false,
    executionDisabledAt,
    maximumAdmittedRequestLifetimeSeconds,
    propagationAllowanceSeconds,
    clockSkewAllowanceSeconds,
    requiredQuiescenceSeconds,
    quiescenceSatisfiedAt,
    observedAt,
  };
  return { ...subject, evidenceSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilityDeploymentExecutionDisabledEvidence(
  input,
) {
  const evidence = record(input, "deployment execution-disabled evidence");
  exactKeys(evidence, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "coordinatorServiceName", "coordinatorEntrypoint", "coordinatorVersionId",
    "coordinatorIdentitySha256", "coordinatorConfigurationSha256",
    "callerTopologySha256", "executionEnabled", "executionDisabledAt",
    "maximumAdmittedRequestLifetimeSeconds", "propagationAllowanceSeconds",
    "clockSkewAllowanceSeconds", "requiredQuiescenceSeconds",
    "quiescenceSatisfiedAt", "observedAt", "evidenceSha256",
  ], "deployment execution-disabled evidence");
  const rebuilt = buildJsonCompatibilityDeploymentExecutionDisabledEvidence(
    evidence,
  );
  canonicalEqual(
    rebuilt,
    evidence,
    "deployment execution-disabled evidence",
  );
  return cloneJson(evidence);
}

export function buildJsonCompatibilityDeploymentResolutionRequest({
  campaignPlan,
  statePlan,
  authorizedTransition: authorizedTransitionInput,
  operationCreatedAt,
  journalHeadOrdinal,
  journalHeadDigestSha256,
  pendingMutationIntentSha256 = null,
  claimGeneration,
  resolver: resolverInput,
  sourceAuthenticationDigestSha256,
  sourceAuthenticationVerifiedAt,
  sourceAuthenticationExpiresAt,
  executionDisabledEvidenceSha256,
  quiescedAt,
  requiredQuiescenceSeconds =
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MINIMUM_QUIESCENCE_SECONDS,
  settleNotBefore = quiescedAt + requiredQuiescenceSeconds,
  claimLeaseSeconds =
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_CLAIM_LEASE_SECONDS,
}) {
  const authorizedTransition =
    validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      authorizedTransitionInput,
    );
  const operation = buildJsonCompatibilityDeploymentTransitionOperation({
    campaignPlan,
    statePlan,
    authorizedTransition,
  });
  integer(operationCreatedAt, "resolution operation creation time");
  integer(journalHeadOrdinal, "resolution journal head ordinal");
  if (journalHeadOrdinal < 0) {
    throw new Error("resolution journal head ordinal is invalid");
  }
  if (journalHeadOrdinal === 0) {
    equal(journalHeadDigestSha256, null, "empty resolution journal head");
  } else {
    sha256(journalHeadDigestSha256, "resolution journal head digest");
  }
  nullableSha256(
    pendingMutationIntentSha256,
    "resolution pending mutation intent",
  );
  integer(claimGeneration, "resolution claim generation");
  if (claimGeneration < 1) {
    throw new Error("resolution claim generation is invalid");
  }
  const resolver = validateResolverIdentity(resolverInput);
  const authority = authorizedTransition.request.executionAuthority;
  equal(
    resolver.accountIdSha256,
    authority.accountIdSha256,
    "resolution resolver account ID",
  );
  sha256(
    sourceAuthenticationDigestSha256,
    "resolution source authentication",
  );
  integer(
    sourceAuthenticationVerifiedAt,
    "resolution source authentication verification time",
  );
  integer(
    sourceAuthenticationExpiresAt,
    "resolution source authentication expiry time",
  );
  equal(
    sourceAuthenticationExpiresAt,
    sourceAuthenticationVerifiedAt
      + JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS,
    "resolution source authentication lifetime",
  );
  sha256(
    executionDisabledEvidenceSha256,
    "resolution execution-disabled evidence",
  );
  integer(quiescedAt, "resolution quiescence time");
  integer(requiredQuiescenceSeconds, "resolution required quiescence");
  if (
    requiredQuiescenceSeconds
      < JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MINIMUM_QUIESCENCE_SECONDS
    || requiredQuiescenceSeconds > 7_200
  ) {
    throw new Error("resolution required quiescence is invalid");
  }
  integer(settleNotBefore, "resolution settle time");
  equal(
    settleNotBefore,
    quiescedAt + requiredQuiescenceSeconds,
    "resolution audited quiescence",
  );
  equal(
    claimLeaseSeconds,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_CLAIM_LEASE_SECONDS,
    "resolution claim lease",
  );
  if (quiescedAt < operationCreatedAt) {
    throw new Error("resolution quiescence predates the operation");
  }
  const authorizedTransitionSha256 = sha256Canonical(authorizedTransition);
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_REQUEST_CONTRACT,
    environment: "staging",
    operation,
    authorizedTransitionSha256,
    executionAuthoritySha256: authority.authorityDigestSha256,
    operationCreatedAt,
    journalHead: {
      ordinal: journalHeadOrdinal,
      digestSha256: journalHeadDigestSha256,
    },
    pendingMutationIntentSha256,
    claimGeneration,
    resolver,
    readback: cloneJson(authority.readback),
    sourceAuthenticationDigestSha256,
    sourceAuthenticationVerifiedAt,
    sourceAuthenticationExpiresAt,
    executionDisabledEvidenceSha256,
    quiescedAt,
    requiredQuiescenceSeconds,
    settleNotBefore,
    claimLeaseSeconds,
    mutationPermitted: false,
    readbackLimit: 2,
    nextTransitionAllowed: false,
    executionRetryPermitted: false,
  };
  return {
    ...subject,
    resolutionRequestSha256: sha256Canonical(subject),
  };
}

export function signJsonCompatibilityDeploymentResolution({
  campaignPlan,
  statePlan,
  authorizedTransition,
  operationCreatedAt,
  journalHeadOrdinal,
  journalHeadDigestSha256,
  pendingMutationIntentSha256 = null,
  claimGeneration,
  resolver,
  sourceAuthentication,
  executionDisabledEvidence: executionDisabledEvidenceInput,
  privateKeyBytes: privateKeyInput,
  now = new Date(),
}) {
  const original = validateJsonCompatibilityDeploymentTransitionAuthorization(
    campaignPlan,
    statePlan,
    authorizedTransition,
  );
  const issuedAt = epochSeconds(now, "resolution approval time");
  const recovery = validateJsonCompatibilityDeploymentTransitionRecoveryContext(
    {
      campaignPlan,
      statePlan,
      authorizedTransition: original,
      sourceAuthentication,
    },
    { now },
  );
  const executionDisabledEvidence =
    validateJsonCompatibilityDeploymentExecutionDisabledEvidence(
      executionDisabledEvidenceInput,
    );
  const authority = original.request.executionAuthority;
  for (const [label, actual, expected] of [
    ["account ID", executionDisabledEvidence.accountIdSha256,
      authority.accountIdSha256],
    ["coordinator service", executionDisabledEvidence.coordinatorServiceName,
      authority.coordinator.serviceName],
    ["coordinator entrypoint", executionDisabledEvidence.coordinatorEntrypoint,
      authority.coordinator.entrypoint],
    ["coordinator version", executionDisabledEvidence.coordinatorVersionId,
      authority.coordinator.versionId],
    ["coordinator identity", executionDisabledEvidence.coordinatorIdentitySha256,
      authority.coordinator.identitySha256],
  ]) equal(actual, expected, `execution-disabled evidence ${label}`);
  if (
    executionDisabledEvidence.observedAt > issuedAt
    || issuedAt - executionDisabledEvidence.observedAt
      > JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS
  ) {
    throw new Error("execution-disabled evidence is stale or from the future");
  }
  const request = buildJsonCompatibilityDeploymentResolutionRequest({
    campaignPlan,
    statePlan,
    authorizedTransition: original,
    operationCreatedAt,
    journalHeadOrdinal,
    journalHeadDigestSha256,
    pendingMutationIntentSha256,
    claimGeneration,
    resolver,
    sourceAuthenticationDigestSha256:
      recovery.sourceAuthentication.sourceAuthenticationDigestSha256,
    sourceAuthenticationVerifiedAt: recovery.sourceAuthentication.verifiedAt,
    sourceAuthenticationExpiresAt:
      recovery.sourceAuthentication.verifiedAt
      + JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SOURCE_AUTHENTICATION_MAX_PROOF_AGE_SECONDS,
    executionDisabledEvidenceSha256:
      executionDisabledEvidence.evidenceSha256,
    quiescedAt: executionDisabledEvidence.executionDisabledAt,
    requiredQuiescenceSeconds:
      executionDisabledEvidence.requiredQuiescenceSeconds,
    settleNotBefore: executionDisabledEvidence.quiescenceSatisfiedAt,
  });
  if (issuedAt < request.settleNotBefore) {
    throw new Error("resolution quiescence interval is incomplete");
  }
  const recoveryWindowSeconds = statusRecoveryWindowSeconds(statePlan);
  const recoveryDeadline = operationCreatedAt + recoveryWindowSeconds;
  if (issuedAt >= recoveryDeadline) {
    throw new Error("resolution recovery window has expired");
  }
  const expiresAt = Math.min(
    issuedAt +
      JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_AUTHORIZATION_SECONDS,
    recoveryDeadline,
    request.sourceAuthenticationExpiresAt,
  );
  if (
    expiresAt - issuedAt
      < request.claimLeaseSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new Error(
      "resolution approval cannot cover the complete claim lease",
    );
  }
  const privateKeyBytes = Buffer.from(privateKeyInput ?? []);
  if (
    privateKeyBytes.length === 0
    || privateKeyBytes.length > MAX_PRIVATE_KEY_BYTES
  ) {
    throw new Error("resolution approval private key is empty or oversized");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: privateKeyBytes,
      format: "der",
      type: "pkcs8",
    });
  } finally {
    privateKeyBytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("resolution approval private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  equal(
    createHash("sha256").update(spki).digest("hex"),
    sha256Spki(original.approval.signerSpkiBase64url),
    "resolution approval private key SPKI digest",
  );
  const subject = {
    schemaVersion: 1,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_SUBJECT_CONTRACT,
    environment: "staging",
    issuer: original.approval.subject.issuer,
    audience: JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_AUDIENCE,
    keyId: original.approval.subject.keyId,
    operationIdSha256: request.operation.operationIdSha256,
    resolutionRequestSha256: request.resolutionRequestSha256,
    resolverIdentitySha256: request.resolver.identitySha256,
    claimGeneration: request.claimGeneration,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
  };
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  const signature = signSignature(null, payload, privateKey);
  if (
    signature.length !== 64
    || !verifySignature(null, payload, publicKey, signature)
  ) {
    throw new Error("resolution approval signature self-verification failed");
  }
  const approval = {
    schemaVersion: 1,
    contract:
      JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256: sha256Canonical(subject),
    signerSpkiBase64url: spki.toString("base64url"),
    signatureBase64url: signature.toString("base64url"),
  };
  const value = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_RESOLUTION_CONTRACT,
    request,
    approval,
  };
  validateJsonCompatibilityDeploymentResolutionAuthorization(
    campaignPlan,
    statePlan,
    original,
    value,
  );
  return value;
}

export function validateJsonCompatibilityDeploymentResolutionAuthorization(
  campaignPlan,
  statePlan,
  authorizedTransition,
  input,
  {
    now = null,
    requireUsableWindow = false,
    requireCompleteLeaseWindow = false,
  } = {},
) {
  const original = validateJsonCompatibilityDeploymentTransitionAuthorization(
    campaignPlan,
    statePlan,
    authorizedTransition,
  );
  const value = record(input, "authorized deployment resolution");
  exactKeys(value, [
    "schemaVersion", "contract", "request", "approval",
  ], "authorized deployment resolution");
  equal(value.schemaVersion, 1, "authorized resolution schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_RESOLUTION_CONTRACT,
    "authorized resolution contract",
  );
  const request = validateResolutionRequest(
    campaignPlan,
    statePlan,
    original,
    value.request,
  );
  const approval = record(value.approval, "deployment resolution approval");
  exactKeys(approval, [
    "schemaVersion", "contract", "algorithm", "subject", "subjectSha256",
    "signerSpkiBase64url", "signatureBase64url",
  ], "deployment resolution approval");
  equal(approval.schemaVersion, 1, "resolution approval schema");
  equal(
    approval.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_ENVELOPE_CONTRACT,
    "resolution approval contract",
  );
  equal(approval.algorithm, "Ed25519", "resolution approval algorithm");
  const subject = record(approval.subject, "resolution approval subject");
  exactKeys(subject, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "operationIdSha256", "resolutionRequestSha256",
    "resolverIdentitySha256", "claimGeneration", "issuedAt", "notBefore",
    "expiresAt",
  ], "resolution approval subject");
  equal(subject.schemaVersion, 1, "resolution approval subject schema");
  equal(
    subject.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_APPROVAL_SUBJECT_CONTRACT,
    "resolution approval subject contract",
  );
  for (const [label, actual, expected] of [
    ["environment", subject.environment, "staging"],
    ["issuer", subject.issuer, original.approval.subject.issuer],
    ["audience", subject.audience,
      JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_AUDIENCE],
    ["key ID", subject.keyId, original.approval.subject.keyId],
    ["operation ID", subject.operationIdSha256,
      request.operation.operationIdSha256],
    ["request", subject.resolutionRequestSha256,
      request.resolutionRequestSha256],
    ["resolver identity", subject.resolverIdentitySha256,
      request.resolver.identitySha256],
    ["claim generation", subject.claimGeneration, request.claimGeneration],
  ]) equal(actual, expected, `resolution approval ${label}`);
  integer(subject.issuedAt, "resolution approval issuedAt");
  integer(subject.notBefore, "resolution approval notBefore");
  integer(subject.expiresAt, "resolution approval expiresAt");
  if (
    subject.notBefore !== subject.issuedAt
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt >
      JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_AUTHORIZATION_SECONDS
    || subject.issuedAt < request.settleNotBefore
    || subject.expiresAt > request.operationCreatedAt +
      statusRecoveryWindowSeconds(statePlan)
    || subject.expiresAt > request.sourceAuthenticationExpiresAt
  ) {
    throw new Error("resolution approval time window is invalid");
  }
  sha256(approval.subjectSha256, "resolution approval subject digest");
  equal(
    approval.subjectSha256,
    sha256Canonical(subject),
    "resolution approval subject digest",
  );
  equal(
    approval.signerSpkiBase64url,
    original.approval.signerSpkiBase64url,
    "resolution approval signer SPKI",
  );
  const publicKeyBytes = canonicalBase64urlBytes(
    approval.signerSpkiBase64url,
    4096,
    "resolution approval signer SPKI",
  );
  const signature = canonicalBase64urlBytes(
    approval.signatureBase64url,
    128,
    "resolution approval signature",
    64,
  );
  const publicKey = createPublicKey({
    key: publicKeyBytes,
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("resolution approval public key must be Ed25519");
  }
  const payload = Buffer.from(
    `${JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
    "utf8",
  );
  if (!verifySignature(null, payload, publicKey, signature)) {
    throw new Error("resolution approval signature is invalid");
  }
  if (now !== null || requireUsableWindow || requireCompleteLeaseWindow) {
    const current = epochSeconds(now ?? new Date(), "resolution time");
    if (
      current + CLOCK_SKEW_SECONDS < subject.notBefore
      || current >= subject.expiresAt
      || current < request.settleNotBefore
    ) {
      throw new Error("resolution approval is not active");
    }
    if (
      requireCompleteLeaseWindow
      && current + request.claimLeaseSeconds + CLOCK_SKEW_SECONDS
        > subject.expiresAt
    ) {
      throw new Error("resolution approval lease window is incomplete");
    }
  }
  return cloneJson(value);
}

export function buildJsonCompatibilityDeploymentResolutionReceipt({
  campaignPlan,
  statePlan,
  authorizedTransition,
  authorizedResolution,
  sourceAuthentication = null,
  originalSourceAuthentication = null,
  sourceReadbacks = [],
  mutationIntent = null,
  mutationOutcome = null,
  targetReadbackRequests = [],
  targetReadbacks = [],
  startedAt,
  finishedAt,
  classification,
  reasonCode,
}) {
  const authorization =
    validateJsonCompatibilityDeploymentResolutionAuthorization(
      campaignPlan,
      statePlan,
      authorizedTransition,
      authorizedResolution,
    );
  const request = authorization.request;
  const freshSourceAuthentication = record(
    sourceAuthentication,
    "resolution source authentication",
  );
  sha256(
    freshSourceAuthentication.sourceAuthenticationDigestSha256,
    "resolution source authentication digest",
  );
  equal(
    freshSourceAuthentication.sourceAuthenticationDigestSha256,
    request.sourceAuthenticationDigestSha256,
    "resolution source authentication binding",
  );
  oneOf(
    classification,
    RESOLUTION_CLASSIFICATIONS,
    "resolution classification",
  );
  oneOf(reasonCode, RESOLUTION_REASON_CODES, "resolution reason code");
  integer(startedAt, "resolution start time");
  integer(finishedAt, "resolution finish time");
  if (finishedAt < startedAt) {
    throw new Error("resolution finish time predates start time");
  }
  const normalizedTargetReadbacks = targetReadbacks.map((value) =>
    validateJsonCompatibilityDeploymentTransitionReadback(value));
  const normalizedTargetReadbackRequests = targetReadbackRequests.map((value) =>
    validateJsonCompatibilityDeploymentTransitionReadbackRequest(value));
  if (
    normalizedTargetReadbacks.length !== 2
    || normalizedTargetReadbackRequests.length !== 2
  ) {
    throw new Error("resolution target readback set is incomplete");
  }
  const readbackIdentitySha256 = request.readback.identitySha256;
  for (const index of [0, 1]) {
    const readbackRequest = normalizedTargetReadbackRequests[index];
    const observation = normalizedTargetReadbacks[index];
    equal(
      readbackRequest.observationOrdinal,
      index + 1,
      "resolution target readback ordinal",
    );
    equal(
      observation.readbackRequestSha256,
      readbackRequest.readbackRequestSha256,
      "resolution target readback request",
    );
    equal(
      observation.readbackServiceIdentitySha256,
      readbackIdentitySha256,
      "resolution target Reader identity",
    );
  }
  canonicalEqual(
    normalizedTargetReadbackRequests[0].expected,
    normalizedTargetReadbackRequests[1].expected,
    "resolution target expected state",
  );
  const observedClassification =
    classifyJsonCompatibilityDeploymentTransitionReadbackPair(
      normalizedTargetReadbacks,
      normalizedTargetReadbackRequests[0].expected,
    );
  if (
    classification === "target_confirmed"
    && (observedClassification !== "stable"
      || reasonCode !== "target_state_confirmed")
  ) {
    throw new Error("resolution target confirmation is not proven");
  }
  if (
    classification === "manual_review_required"
    && (reasonCode !== "target_state_drift"
      || observedClassification !== "drift")
  ) {
    throw new Error("resolution target drift is not proven");
  }
  if (
    classification === "readback_inconclusive"
    && !(
      (reasonCode === "target_state_ambiguous"
        && observedClassification === "ambiguous")
      || (reasonCode === "target_state_unstable"
        && observedClassification === "unstable")
    )
  ) {
    throw new Error("resolution inconclusive reason is invalid");
  }
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_RECEIPT_CONTRACT,
    environment: "staging",
    operationIdSha256: request.operation.operationIdSha256,
    operationDigestSha256: request.operation.operationDigestSha256,
    authorizedTransitionSha256: request.authorizedTransitionSha256,
    resolutionRequestSha256: request.resolutionRequestSha256,
    claimGeneration: request.claimGeneration,
    resolverIdentitySha256: request.resolver.identitySha256,
    journalHead: cloneJson(request.journalHead),
    pendingMutationIntentSha256: request.pendingMutationIntentSha256,
    sourceAuthenticationDigestSha256:
      request.sourceAuthenticationDigestSha256,
    originalSourceAuthenticationDigestSha256:
      originalSourceAuthentication === null
        ? null
        : originalSourceAuthentication.sourceAuthenticationDigestSha256,
    sourceReadbackSetSha256: sourceReadbacks.length === 0
      ? null
      : sha256Canonical(sourceReadbacks),
    mutationIntent: cloneJson(mutationIntent),
    mutationOutcome: cloneJson(mutationOutcome),
    mutationOutcomeEvidence: mutationOutcome === null ? "missing" : "journaled",
    readbackIdentitySha256,
    targetReadbackRequests: cloneJson(normalizedTargetReadbackRequests),
    targetReadbacks: cloneJson(normalizedTargetReadbacks),
    classification,
    reasonCode,
    startedAt,
    finishedAt,
    nextTransitionAllowed: false,
    mutationAttempts: 0,
    automaticRetries: 0,
    readbackAttempts: normalizedTargetReadbacks.length,
    mutationCalled: false,
    executionRetryPermitted: false,
  };
  return {
    ...subject,
    resolutionReceiptSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentResolutionReceipt(input) {
  const receipt = record(input, "deployment resolution receipt");
  exactKeys(receipt, [
    "schemaVersion", "contract", "environment", "operationIdSha256",
    "operationDigestSha256", "authorizedTransitionSha256",
    "resolutionRequestSha256", "claimGeneration", "resolverIdentitySha256",
    "journalHead", "pendingMutationIntentSha256",
    "sourceAuthenticationDigestSha256",
    "originalSourceAuthenticationDigestSha256", "sourceReadbackSetSha256",
    "mutationIntent", "mutationOutcome", "mutationOutcomeEvidence",
    "readbackIdentitySha256", "targetReadbackRequests", "targetReadbacks",
    "classification", "reasonCode", "startedAt",
    "finishedAt", "nextTransitionAllowed", "mutationAttempts",
    "automaticRetries", "readbackAttempts", "mutationCalled",
    "executionRetryPermitted", "resolutionReceiptSha256",
  ], "deployment resolution receipt");
  equal(receipt.schemaVersion, 1, "resolution receipt schema");
  equal(
    receipt.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_RECEIPT_CONTRACT,
    "resolution receipt contract",
  );
  equal(receipt.environment, "staging", "resolution receipt environment");
  for (const [label, value] of [
    ["operation ID", receipt.operationIdSha256],
    ["operation digest", receipt.operationDigestSha256],
    ["authorized transition", receipt.authorizedTransitionSha256],
    ["resolution request", receipt.resolutionRequestSha256],
    ["resolver identity", receipt.resolverIdentitySha256],
    ["Reader identity", receipt.readbackIdentitySha256],
    ["receipt", receipt.resolutionReceiptSha256],
  ]) sha256(value, `resolution ${label}`);
  integer(receipt.claimGeneration, "resolution receipt generation");
  if (receipt.claimGeneration < 1) {
    throw new Error("resolution receipt generation is invalid");
  }
  const journalHead = record(receipt.journalHead, "resolution receipt journal head");
  exactKeys(
    journalHead,
    ["ordinal", "digestSha256"],
    "resolution receipt journal head",
  );
  integer(journalHead.ordinal, "resolution receipt journal head ordinal");
  if (journalHead.ordinal < 1) {
    throw new Error("resolution receipt journal head ordinal is invalid");
  }
  sha256(
    journalHead.digestSha256,
    "resolution receipt journal head digest",
  );
  nullableSha256(
    receipt.pendingMutationIntentSha256,
    "resolution receipt pending mutation intent",
  );
  sha256(
    receipt.sourceAuthenticationDigestSha256,
    "resolution receipt source authentication",
  );
  nullableSha256(
    receipt.originalSourceAuthenticationDigestSha256,
    "resolution receipt original source authentication",
  );
  nullableSha256(
    receipt.sourceReadbackSetSha256,
    "resolution receipt source readback set",
  );
  if (receipt.mutationIntent !== null) {
    record(receipt.mutationIntent, "resolution receipt mutation intent");
  }
  if (receipt.mutationOutcome !== null) {
    record(receipt.mutationOutcome, "resolution receipt mutation outcome");
  }
  equal(
    receipt.mutationOutcomeEvidence,
    receipt.mutationOutcome === null ? "missing" : "journaled",
    "resolution receipt mutation outcome evidence",
  );
  if (
    !Array.isArray(receipt.targetReadbackRequests)
    || receipt.targetReadbackRequests.length !== 2
    || !Array.isArray(receipt.targetReadbacks)
    || receipt.targetReadbacks.length !== 2
  ) {
    throw new Error("resolution receipt target readbacks are invalid");
  }
  const targetReadbackRequests = receipt.targetReadbackRequests.map((value) =>
    validateJsonCompatibilityDeploymentTransitionReadbackRequest(value));
  const targetReadbacks = receipt.targetReadbacks.map((value) =>
    validateJsonCompatibilityDeploymentTransitionReadback(value));
  for (const index of [0, 1]) {
    equal(
      targetReadbackRequests[index].observationOrdinal,
      index + 1,
      "resolution receipt target readback ordinal",
    );
    equal(
      targetReadbacks[index].readbackRequestSha256,
      targetReadbackRequests[index].readbackRequestSha256,
      "resolution receipt target request binding",
    );
    equal(
      targetReadbacks[index].readbackServiceIdentitySha256,
      receipt.readbackIdentitySha256,
      "resolution receipt Reader identity binding",
    );
  }
  canonicalEqual(
    targetReadbackRequests[0].expected,
    targetReadbackRequests[1].expected,
    "resolution receipt expected target state",
  );
  integer(receipt.startedAt, "resolution receipt start time");
  integer(receipt.finishedAt, "resolution receipt finish time");
  if (receipt.finishedAt < receipt.startedAt) {
    throw new Error("resolution receipt finish time predates start time");
  }
  oneOf(
    receipt.classification,
    RESOLUTION_CLASSIFICATIONS,
    "resolution receipt classification",
  );
  oneOf(receipt.reasonCode, RESOLUTION_REASON_CODES, "resolution receipt reason");
  const observedClassification =
    classifyJsonCompatibilityDeploymentTransitionReadbackPair(
      targetReadbacks,
      targetReadbackRequests[0].expected,
    );
  const validClassification =
    (receipt.classification === "target_confirmed"
      && receipt.reasonCode === "target_state_confirmed"
      && observedClassification === "stable")
    || (receipt.classification === "manual_review_required"
      && receipt.reasonCode === "target_state_drift"
      && observedClassification === "drift")
    || (receipt.classification === "readback_inconclusive"
      && (
        (receipt.reasonCode === "target_state_ambiguous"
          && observedClassification === "ambiguous")
        || (receipt.reasonCode === "target_state_unstable"
          && observedClassification === "unstable")
      ));
  if (!validClassification) {
    throw new Error("resolution receipt evidence contradicts classification");
  }
  equal(receipt.nextTransitionAllowed, false, "resolution next transition");
  equal(receipt.mutationAttempts, 0, "resolution mutation attempts");
  equal(receipt.automaticRetries, 0, "resolution automatic retries");
  equal(receipt.readbackAttempts, 2, "resolution readback attempts");
  equal(receipt.mutationCalled, false, "resolution mutation call");
  equal(receipt.executionRetryPermitted, false, "resolution execution retry");
  const { resolutionReceiptSha256, ...subject } = receipt;
  equal(
    resolutionReceiptSha256,
    sha256Canonical(subject),
    "resolution receipt digest",
  );
  return cloneJson(receipt);
}

function validateResolutionRequest(
  campaignPlan,
  statePlan,
  authorizedTransition,
  input,
) {
  const request = record(input, "deployment resolution request");
  exactKeys(request, [
    "schemaVersion", "contract", "environment", "operation",
    "authorizedTransitionSha256", "executionAuthoritySha256",
    "operationCreatedAt", "journalHead", "pendingMutationIntentSha256",
    "claimGeneration", "resolver", "readback",
    "sourceAuthenticationDigestSha256", "sourceAuthenticationVerifiedAt",
    "sourceAuthenticationExpiresAt",
    "executionDisabledEvidenceSha256", "quiescedAt",
    "requiredQuiescenceSeconds", "settleNotBefore",
    "claimLeaseSeconds", "mutationPermitted", "readbackLimit",
    "nextTransitionAllowed", "executionRetryPermitted",
    "resolutionRequestSha256",
  ], "deployment resolution request");
  const rebuilt = buildJsonCompatibilityDeploymentResolutionRequest({
    campaignPlan,
    statePlan,
    authorizedTransition,
    operationCreatedAt: request.operationCreatedAt,
    journalHeadOrdinal: request.journalHead?.ordinal,
    journalHeadDigestSha256: request.journalHead?.digestSha256,
    pendingMutationIntentSha256: request.pendingMutationIntentSha256,
    claimGeneration: request.claimGeneration,
    resolver: request.resolver,
    sourceAuthenticationDigestSha256:
      request.sourceAuthenticationDigestSha256,
    sourceAuthenticationVerifiedAt:
      request.sourceAuthenticationVerifiedAt,
    sourceAuthenticationExpiresAt:
      request.sourceAuthenticationExpiresAt,
    executionDisabledEvidenceSha256:
      request.executionDisabledEvidenceSha256,
    quiescedAt: request.quiescedAt,
    requiredQuiescenceSeconds: request.requiredQuiescenceSeconds,
    settleNotBefore: request.settleNotBefore,
    claimLeaseSeconds: request.claimLeaseSeconds,
  });
  canonicalEqual(rebuilt, request, "deployment resolution request");
  return request;
}

function validateResolverIdentity(input) {
  const value = record(input, "deployment resolver identity");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "serviceName", "entrypoint", "versionId", "profileVersion",
    "privateRpcOnly", "capability", "cloudflareApiCredentialPresent",
    "mutationBindingPresent", "sourceVerifierBindingPresent",
    "identitySha256",
  ], "deployment resolver identity");
  const rebuilt = buildJsonCompatibilityDeploymentResolverIdentity(value);
  canonicalEqual(rebuilt, value, "deployment resolver identity");
  return value;
}

function statusRecoveryWindowSeconds(statePlan) {
  const value = statePlan?.constraints?.statusRecoveryWindowSeconds;
  integer(value, "deployment status recovery window");
  if (value < 1 || value > 7 * 24 * 60 * 60) {
    throw new Error("deployment status recovery window is invalid");
  }
  return value;
}

function sha256Spki(value) {
  return createHash("sha256")
    .update(canonicalBase64urlBytes(value, 4096, "transition approval SPKI"))
    .digest("hex");
}

function canonicalBase64urlBytes(value, maximumBytes, label, exactBytes = null) {
  if (
    typeof value !== "string"
    || value.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error(`${label} is invalid`);
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0
    || bytes.length > maximumBytes
    || (exactBytes !== null && bytes.length !== exactBytes)
    || bytes.toString("base64url") !== value
  ) throw new Error(`${label} is invalid`);
  return bytes;
}

function epochSeconds(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return Math.floor(value.getTime() / 1000);
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} is invalid`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} is invalid`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function nullableSha256(value, label) {
  if (value !== null) sha256(value, label);
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
}

function oneOf(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is invalid`);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
