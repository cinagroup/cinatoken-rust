import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";

export const RING_TRANSITION_EXECUTION_CLAIM_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-claim-v1";
export const RING_TRANSITION_EXECUTION_STEP_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-step-v1";
export const RING_TRANSITION_RUNNER_TRUST_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-trust-v1";
export const RING_TRANSITION_CLAIM_AUTHORITY_PATH =
  "/internal/v1/ring-transition/claims";
export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";

const sha256Pattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const serviceNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const versionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;

export const DEPLOYMENT_PINNED_RING_TRANSITION_TRUST = deepFreeze({
  schemaVersion: 1,
  contract: RING_TRANSITION_RUNNER_TRUST_CONTRACT,
  enabled: false,
  environment: "staging",
  cloudflareApiOrigin: CLOUDFLARE_API_ORIGIN,
  claimAuthorityOrigin: null,
  accountIdSha256: null,
  ledgerIdentitySha256: null,
  transitionPolicySha256: null,
  authorizationPolicySha256: null,
  transitionApprovalKeyFingerprintsSha256: [],
  authorizationApprovalKeyFingerprintsSha256: [],
  controllerServiceName: "cinatoken-container-controller-staging",
  edgeServiceName: "cinatoken-rust-api-staging",
  runnerSourceCommit: null,
  runnerBuildSha256: null,
  runnerTrustConfigSha256: null,
  releaseEvidenceSha256: null,
});

export function describeRingTransitionMutationRunner() {
  return {
    ok: true,
    schemaVersion: 1,
    describe: true,
    trustContract: RING_TRANSITION_RUNNER_TRUST_CONTRACT,
    claimContract: RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
    stepContract: RING_TRANSITION_EXECUTION_STEP_CONTRACT,
    environment: "staging",
    trustRootsPublished: DEPLOYMENT_PINNED_RING_TRANSITION_TRUST.enabled,
    executionMode: "deployment-pinned-artifact-only",
    credentialClasses: ["read", "claim", "deploy"],
    executionOrder: [
      "verify-pinned-trust-roots",
      "verify-signed-transition-and-authorization",
      "verify-three-distinct-credential-identities",
      "atomic-single-use-claim",
      "authenticated-t1-readback",
      "persist-controller-mutation-intent",
      "controller-deployment",
      "authenticated-controller-post-readback",
      "authenticated-edge-pre-readback",
      "persist-edge-mutation-intent",
      "edge-deployment",
      "authenticated-edge-post-readback",
      "seal-redacted-receipt",
    ],
    mutationTransport: "native-bounded-fetch-zero-retry",
    ambiguousMutationResponsePolicy:
      "never-retry-classify-by-authenticated-stable-readback",
    remoteMutationAuthorized: false,
    credentialsRead: false,
    networkRequestsPerformed: false,
    mutationPerformed: false,
    productionCutoverAuthorized: false,
    customerTrafficAuthorized: false,
  };
}

export function validatePublishedRingTransitionTrust(
  anchors = DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
) {
  const trust = requireObject(anchors, "[trust] anchors");
  exactKeys(
    trust,
    Object.keys(DEPLOYMENT_PINNED_RING_TRANSITION_TRUST),
    "[trust] anchors",
  );
  requireExact(trust.schemaVersion, 1, "[trust] schema version");
  requireExact(
    trust.contract,
    RING_TRANSITION_RUNNER_TRUST_CONTRACT,
    "[trust] contract",
  );
  requireExact(trust.enabled, true, "[trust] published execution enablement");
  requireExact(trust.environment, "staging", "[trust] environment");
  requireExact(
    trust.cloudflareApiOrigin,
    CLOUDFLARE_API_ORIGIN,
    "[trust] Cloudflare API origin",
  );
  requireHttpsOrigin(trust.claimAuthorityOrigin, "[trust] claim authority origin");
  for (const field of [
    "accountIdSha256",
    "ledgerIdentitySha256",
    "transitionPolicySha256",
    "authorizationPolicySha256",
    "runnerBuildSha256",
    "runnerTrustConfigSha256",
    "releaseEvidenceSha256",
  ]) {
    requireSha256(trust[field], `[trust] ${field}`);
  }
  requireToken(
    trust.runnerSourceCommit,
    commitPattern,
    "[trust] runner source commit",
  );
  requireToken(
    trust.controllerServiceName,
    serviceNamePattern,
    "[trust] controller service",
  );
  requireToken(
    trust.edgeServiceName,
    serviceNamePattern,
    "[trust] edge service",
  );
  validateFingerprintSet(
    trust.transitionApprovalKeyFingerprintsSha256,
    "[trust] transition approval keys",
  );
  validateFingerprintSet(
    trust.authorizationApprovalKeyFingerprintsSha256,
    "[trust] authorization approval keys",
  );
  if (
    trust.transitionPolicySha256 === trust.authorizationPolicySha256
  ) {
    throw new Error("[trust] transition and authorization policies must differ");
  }
  requireExact(
    trust.runnerTrustConfigSha256,
    ringTransitionTrustConfigDigestSha256(trust),
    "[trust] configuration digest",
  );
  return trust;
}

export function ringTransitionTrustConfigDigestSha256(anchors) {
  const trust = { ...requireObject(anchors, "[trust] anchors") };
  delete trust.runnerTrustConfigSha256;
  return digestCanonical(trust);
}

export function buildRingTransitionExecutionClaim({
  authorization,
  anchors,
  actorExecutionIdSha256,
  ledgerIdentitySha256,
}) {
  const trust = validatePublishedRingTransitionTrust(anchors);
  const verified = requireObject(authorization, "[authorization] result");
  requireExact(verified.ok, true, "[authorization] verification result");
  requireExact(verified.environment, "staging", "[authorization] environment");
  requireExact(
    verified.offlineSignedAuthorizationVerified,
    true,
    "[authorization] offline signature verification",
  );
  requireExact(
    verified.atomicRemoteClaimRequired,
    true,
    "[authorization] atomic claim requirement",
  );
  requireExact(
    verified.mutationPerformedByVerifier,
    false,
    "[authorization] verifier mutation boundary",
  );
  requireSha256(actorExecutionIdSha256, "[claim] actor execution ID");
  requireExact(
    ledgerIdentitySha256,
    trust.ledgerIdentitySha256,
    "[claim] ledger identity",
  );
  requireExact(
    verified.authorizationPolicyDigestSha256,
    trust.authorizationPolicySha256,
    "[claim] authorization policy anchor",
  );
  requireExact(
    verified.transitionPolicyDigestSha256,
    trust.transitionPolicySha256,
    "[claim] transition policy anchor",
  );
  requireExact(
    canonicalJson(approvalFingerprints(verified.transitionApprovalKeys)),
    canonicalJson(trust.transitionApprovalKeyFingerprintsSha256),
    "[claim] transition approval key anchors",
  );
  requireExact(
    canonicalJson(approvalFingerprints(verified.approvalKeys)),
    canonicalJson(trust.authorizationApprovalKeyFingerprintsSha256),
    "[claim] authorization approval key anchors",
  );
  requireExact(
    verified.deploymentSetReadback.accountIdSha256,
    trust.accountIdSha256,
    "[claim] account anchor",
  );
  requireExact(
    verified.executionPlan.controller.serviceName,
    trust.controllerServiceName,
    "[claim] controller service anchor",
  );
  requireExact(
    verified.executionPlan.edge.serviceName,
    trust.edgeServiceName,
    "[claim] edge service anchor",
  );
  const credentialScope = requireObject(
    verified.credentialScope,
    "[claim] credential scope",
  );
  const credentialIds = [
    credentialScope.replacementReadCredentialIdSha256,
    credentialScope.replacementClaimCredentialIdSha256,
    credentialScope.replacementDeployCredentialIdSha256,
  ];
  credentialIds.forEach((value, index) =>
    requireSha256(value, `[claim] credential identity ${index + 1}`),
  );
  if (new Set(credentialIds).size !== 3) {
    throw new Error("[claim] read, claim, and deploy credentials must be distinct");
  }
  const generatedAt = parseWholeSecond(verified.executionPlan.generatedAt ?? verified.generatedAt);
  const expiresAt = parseWholeSecond(verified.expiresAt);
  if (expiresAt <= generatedAt || expiresAt - generatedAt > 600) {
    throw new Error("[claim] authorization validity window is invalid");
  }

  const claim = {
    schemaVersion: 1,
    contract: RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
    claimAuthority: "d1-unique-claim-v1",
    claimScope: "staging-worker-ring-transition",
    environment: "staging",
    authorizationIdSha256: requireSha256(
      verified.authorizationIdSha256,
      "[claim] authorization ID",
    ),
    executionNonceSha256: requireSha256(
      verified.executionNonceSha256,
      "[claim] execution nonce",
    ),
    authorizationManifestSha256: requireSha256(
      verified.authorizationManifestDigestSha256,
      "[claim] authorization manifest",
    ),
    authorizationSubjectSha256: requireSha256(
      verified.authorizationSubjectDigestSha256,
      "[claim] authorization subject",
    ),
    authorizationPolicySha256: verified.authorizationPolicyDigestSha256,
    transitionManifestSha256: requireSha256(
      verified.transitionManifestDigestSha256,
      "[claim] transition manifest",
    ),
    transitionSubjectSha256: requireSha256(
      verified.transitionSubjectDigestSha256,
      "[claim] transition subject",
    ),
    transitionPolicySha256: verified.transitionPolicyDigestSha256,
    transitionPlanSha256: requireSha256(
      verified.transitionPlanDigestSha256,
      "[claim] transition plan",
    ),
    candidateSha256: requireSha256(
      verified.candidateDigestSha256,
      "[claim] candidate",
    ),
    executionPlanSha256: requireSha256(
      verified.executionPlanDigestSha256,
      "[claim] execution plan",
    ),
    accountIdSha256: trust.accountIdSha256,
    ledgerIdentitySha256,
    readCredentialIdSha256: credentialIds[0],
    claimCredentialIdSha256: credentialIds[1],
    deployCredentialIdSha256: credentialIds[2],
    controller: normalizeServiceClaim(
      verified.executionPlan.controller,
      "controller",
    ),
    edge: normalizeServiceClaim(verified.executionPlan.edge, "edge"),
    runnerBuildSha256: trust.runnerBuildSha256,
    runnerTrustConfigSha256: trust.runnerTrustConfigSha256,
    claimOwnerSha256: actorExecutionIdSha256,
    generatedAt,
    expiresAt,
  };
  if (claim.authorizationIdSha256 === claim.executionNonceSha256) {
    throw new Error("[claim] authorization ID and execution nonce must differ");
  }
  return {
    ...claim,
    claimDigestSha256: digestCanonical(claim),
  };
}

export function buildClaimAuthorityRequest({ anchors, claim }) {
  const trust = validatePublishedRingTransitionTrust(anchors);
  requireExact(
    claim.contract,
    RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
    "[claim] contract",
  );
  return {
    method: "POST",
    url: `${trust.claimAuthorityOrigin}${RING_TRANSITION_CLAIM_AUTHORITY_PATH}`,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: canonicalJson(claim),
    retry: false,
    timeoutMilliseconds: 10_000,
    maximumResponseBytes: 256 * 1024,
  };
}

export function buildCloudflareDeploymentMutationRequest({
  anchors,
  accountId,
  serviceName,
  targetVersionId,
  authorizationIdSha256,
}) {
  const trust = validatePublishedRingTransitionTrust(anchors);
  requireToken(accountId, accountIdPattern, "[mutation] account ID");
  requireExact(
    sha256Hex(Buffer.from(accountId, "utf8")),
    trust.accountIdSha256,
    "[mutation] account anchor",
  );
  requireToken(serviceName, serviceNamePattern, "[mutation] service name");
  if (
    serviceName !== trust.controllerServiceName &&
    serviceName !== trust.edgeServiceName
  ) {
    throw new Error("[mutation] service is outside the pinned staging ring");
  }
  requireToken(targetVersionId, versionIdPattern, "[mutation] target version");
  requireSha256(authorizationIdSha256, "[mutation] authorization ID");
  const body = {
    strategy: "percentage",
    versions: [{ version_id: targetVersionId, percentage: 100 }],
    annotations: {
      "workers/message":
        `cinatoken staging ring transition ${authorizationIdSha256.slice(0, 16)}`,
    },
  };
  return {
    method: "POST",
    url:
      `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${accountId}` +
      `/workers/scripts/${encodeURIComponent(serviceName)}/deployments`,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: canonicalJson(body),
    requestDigestSha256: digestCanonical(body),
    retry: false,
    force: false,
    timeoutMilliseconds: 10_000,
    maximumResponseBytes: 2 * 1024 * 1024,
  };
}

export function classifyDeploymentMutationAttempt({
  transportOutcome,
  targetVersionId,
  authorizationIdSha256,
  readbacks,
}) {
  if (!["success", "ambiguous", "rejected"].includes(transportOutcome)) {
    throw new Error("[mutation] transport outcome is invalid");
  }
  requireToken(targetVersionId, versionIdPattern, "[mutation] target version");
  requireSha256(authorizationIdSha256, "[mutation] authorization ID");
  const expectedAnnotation =
    `cinatoken staging ring transition ${authorizationIdSha256.slice(0, 16)}`;
  if (!Array.isArray(readbacks) || readbacks.length !== 2) {
    throw new Error("[mutation] exactly two authenticated readbacks are required");
  }
  const normalized = readbacks.map((item, index) =>
    normalizeTargetReadback(item, targetVersionId, expectedAnnotation, index),
  );
  const stable =
    canonicalJson(normalized[0]) === canonicalJson(normalized[1]);
  const targetConfirmed =
    stable &&
    normalized[0].activeVersions.length === 1 &&
    normalized[0].activeVersions[0].versionId === targetVersionId &&
    normalized[0].activeVersions[0].percentage === 100;
  if (targetConfirmed && transportOutcome === "success") {
    return {
      classification: "confirmed-applied",
      terminalState: "verified",
      retryMutation: false,
      forwardRepairRequired: false,
    };
  }
  if (targetConfirmed && transportOutcome === "ambiguous") {
    return {
      classification: "confirmed-applied-after-response-loss",
      terminalState: "verified",
      retryMutation: false,
      forwardRepairRequired: false,
    };
  }
  return {
    classification: stable
      ? "recovery-required-target-not-confirmed"
      : "recovery-required-readback-drift",
    terminalState: "recovery_required",
    retryMutation: false,
    forwardRepairRequired: true,
  };
}

export function nextRingTransitionRunnerAction(status) {
  const actions = {
    claimed: "authenticated-t1-readback",
    t1_verified: "persist-controller-mutation-intent",
    controller_inflight: "authenticated-controller-post-readback",
    controller_verified: "authenticated-edge-pre-readback",
    edge_prechecked: "persist-edge-mutation-intent",
    edge_inflight: "authenticated-edge-post-readback",
    completed: null,
    recovery_required: null,
    aborted: null,
    expired: null,
  };
  if (!Object.hasOwn(actions, status)) {
    throw new Error("[runner] claim status is invalid");
  }
  return actions[status];
}

function normalizeServiceClaim(value, label) {
  const service = requireObject(value, `[claim] ${label}`);
  return {
    serviceName: requireToken(
      service.serviceName,
      serviceNamePattern,
      `[claim] ${label} service`,
    ),
    previousVersionId: requireToken(
      service.expectedVersionId,
      versionIdPattern,
      `[claim] ${label} previous version`,
    ),
    previousDeploymentSetSha256: requireSha256(
      service.expectedDeploymentSetSha256,
      `[claim] ${label} previous deployment set`,
    ),
    targetVersionId: requireToken(
      service.targetVersionId,
      versionIdPattern,
      `[claim] ${label} target version`,
    ),
  };
}

function normalizeTargetReadback(
  value,
  targetVersionId,
  expectedAnnotation,
  index,
) {
  const readback = requireObject(value, `[mutation] readback ${index + 1}`);
  requireSha256(
    readback.deploymentSetSha256,
    `[mutation] readback ${index + 1} deployment set`,
  );
  if (!Array.isArray(readback.activeVersions)) {
    throw new Error(`[mutation] readback ${index + 1} active versions are invalid`);
  }
  const activeVersions = readback.activeVersions.map((version) => ({
    versionId: requireToken(
      version.versionId,
      versionIdPattern,
      `[mutation] readback ${index + 1} version`,
    ),
    percentage: version.percentage,
  }));
  requireExact(
    readback.mutationAnnotation,
    expectedAnnotation,
    `[mutation] readback ${index + 1} annotation`,
  );
  for (const version of activeVersions) {
    if (
      !Number.isInteger(version.percentage) ||
      version.percentage < 0 ||
      version.percentage > 100
    ) {
      throw new Error(`[mutation] readback ${index + 1} percentage is invalid`);
    }
  }
  if (
    activeVersions.some((version) => version.versionId === targetVersionId) &&
    activeVersions.length !== 1
  ) {
    return {
      deploymentSetSha256: readback.deploymentSetSha256,
      activeVersions,
      mutationAnnotation: readback.mutationAnnotation,
    };
  }
  return {
    deploymentSetSha256: readback.deploymentSetSha256,
    activeVersions,
    mutationAnnotation: readback.mutationAnnotation,
  };
}

function validateFingerprintSet(value, label) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
    throw new Error(`${label} must contain between two and sixteen keys`);
  }
  value.forEach((item) => requireSha256(item, label));
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} contains duplicate keys`);
  }
  const sorted = [...value].sort();
  if (canonicalJson(sorted) !== canonicalJson(value)) {
    throw new Error(`${label} must be sorted`);
  }
}

function approvalFingerprints(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
    throw new Error("[claim] approval key set is invalid");
  }
  const fingerprints = value
    .map((approval) =>
      requireSha256(
        approval?.publicKeySha256,
        "[claim] approval key fingerprint",
      ),
    )
    .sort();
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("[claim] approval key set contains duplicates");
  }
  return fingerprints;
}

function parseWholeSecond(value) {
  const parsed = new Date(value);
  if (
    typeof value !== "string" ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value ||
    parsed.getUTCMilliseconds() !== 0
  ) {
    throw new Error("[claim] timestamp must be canonical whole-second UTC");
  }
  return parsed.getTime() / 1000;
}

function requireHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  return parsed.origin;
}

function digestCanonical(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
  return actual;
}

function requireSha256(value, label) {
  return requireToken(value, sha256Pattern, label);
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}
