import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import path from "node:path";

import {
  readCanonicalJsonEvidence,
  verifyRingTransitionBundle,
} from "./relay_container_ring_transition_contract.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";

export const RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT =
  "cinatoken-relay-container-ring-transition-authorization-manifest-v1";
export const RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT =
  "cinatoken-relay-container-ring-transition-authorization-trust-policy-v1";
export const RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT =
  "cinatoken-relay-container-ring-transition-authorization-evidence-v1";
export const RING_TRANSITION_AUTHORIZATION_APPROVAL_DOMAIN =
  "cinatoken-relay-container-ring-transition-authorization-approval-v1";
export const RING_TRANSITION_AUTHORIZATION_DECISION =
  "authorize-isolated-staging-adjacent-ring-transition-open-v1";
export const RING_TRANSITION_AUTHORIZATION_RESULT =
  "signed-authorization-verified-for-isolated-staging-adjacent-ring-transition-open";
export const RING_TRANSITION_AUTHORIZATION_ROLES = Object.freeze([
  "security",
  "operations",
  "release",
  "rollback",
]);
export const RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS = Object.freeze([
  "deployment-set-readback",
  "credential-scope-readback",
  "operator-ceremony",
  "single-use-claim-readiness",
  "rollback-readiness",
]);
export const MAX_RING_TRANSITION_AUTHORIZATION_SECONDS = 600;
export const MIN_RING_TRANSITION_AUTHORIZATION_LEAD_SECONDS = 60;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 120;
const MAX_EVIDENCE_AGE_SECONDS = 15 * 60;
const MIN_DEPLOYMENT_READBACK_WINDOW_SECONDS = 5;
const MAX_DEPLOYMENT_READBACK_WINDOW_SECONDS = 120;
const MAX_DEPLOYMENT_READBACK_CAPTURE_LAG_SECONDS = 30;
const STAGING_EDGE_SERVICE_NAME = "cinatoken-rust-api-staging";

const sha256Pattern = /^[0-9a-f]{64}$/;
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const serviceNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const relativeEvidencePathPattern =
  /^evidence\/[a-z0-9][a-z0-9-]{0,63}\.json$/;

export async function verifyRingTransitionMutationAuthorization({
  transitionManifestPath,
  transitionTrustPolicyPath,
  authorizationManifestPath,
  authorizationTrustPolicyPath,
  now = new Date(),
}) {
  requireDate(now, "[time] verifier now");

  const transition = await verifyRingTransitionBundle({
    manifestPath: transitionManifestPath,
    trustPolicyPath: transitionTrustPolicyPath,
    now,
  });
  const manifestFile = await readCanonicalJsonEvidence(
    authorizationManifestPath,
    "ring transition authorization manifest",
    MAX_MANIFEST_BYTES,
  );
  const policyFile = await readCanonicalJsonEvidence(
    authorizationTrustPolicyPath,
    "ring transition authorization trust policy",
    MAX_POLICY_BYTES,
  );
  const manifestRoot = path.dirname(manifestFile.realPath);
  if (
    policyFile.realPath === manifestRoot ||
    isWithin(manifestRoot, policyFile.realPath)
  ) {
    throw new Error(
      "[policy] authorization trust policy must be external to the authorization bundle",
    );
  }
  if (
    sha256Hex(policyFile.bytes) === transition.policyDigestSha256 ||
    policyFile.realPath === path.resolve(transitionTrustPolicyPath)
  ) {
    throw new Error(
      "[policy] authorization and transition review must use distinct trust policies",
    );
  }

  const policy = validateTrustPolicy(policyFile.value, now);
  validateApprovalKeyIsolation(policy, transition.approvalKeys);
  const manifest = validateManifestEnvelope(manifestFile.value);
  const decisionTime = validateDecisionTime(
    manifest.subject,
    policy,
    transition,
    now,
  );
  validatePolicyBinding(manifest.subject, policy);
  validateTransitionBinding(manifest.subject.transitionBinding, transition);
  const intent = validateDeploymentIntent(
    manifest.subject.deploymentIntent,
    transition,
  );
  const records = validateArtifactRecords(
    manifest.subject.artifacts,
    decisionTime,
  );
  const evidence = await readAndValidateArtifacts({
    records,
    manifestRoot,
    authorizationIdSha256: manifest.subject.authorizationIdSha256,
    transitionSubjectDigestSha256: transition.subjectDigestSha256,
  });
  const deploymentReadback = validateDeploymentSetReadback(
    evidence.byKind.get("deployment-set-readback"),
    manifest.subject,
    transition,
    intent,
  );
  const credentialScope = validateCredentialScope(
    evidence.byKind.get("credential-scope-readback"),
    deploymentReadback.accountIdSha256,
  );
  requireExact(
    deploymentReadback.readCredentialIdSha256,
    credentialScope.replacementReadCredentialIdSha256,
    "[credential] deployment readback credential identity",
  );
  validateOperatorCeremony(
    evidence.byKind.get("operator-ceremony"),
    manifest.subject,
  );
  const claimReadiness = validateClaimReadiness(
    evidence.byKind.get("single-use-claim-readiness"),
    manifest.subject,
  );
  requireExact(
    claimReadiness.claimCredentialIdSha256,
    credentialScope.replacementClaimCredentialIdSha256,
    "[claim] replacement claim credential identity",
  );
  validateRollbackReadiness(
    evidence.byKind.get("rollback-readiness"),
    transition,
  );
  validateSafetyBoundary(manifest.subject.safetyBoundary);

  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(manifest.subject), "utf8"),
  );
  requireExact(
    manifest.subjectDigestSha256,
    subjectDigestSha256,
    "[manifest] subject digest",
  );
  const approvalKeys = validateApprovals({
    approvals: manifest.approvals,
    subject: manifest.subject,
    subjectDigestSha256,
    policy,
    transition,
    now,
  });

  const executionPlan = {
    schemaVersion: 1,
    mode: "offline-signed-authorization-only",
    phase: intent.phase,
    authorizationIdSha256: manifest.subject.authorizationIdSha256,
    executionNonceSha256: manifest.subject.executionNonceSha256,
    generatedAt: manifest.subject.generatedAt,
    expiresAt: manifest.subject.expiresAt,
    executionOrder: [
      "atomic-single-use-claim",
      "authenticated-t1-readback",
      "controller-deployment",
      "authenticated-controller-post-readback",
      "authenticated-edge-pre-readback",
      "edge-deployment",
      "authenticated-edge-post-readback",
    ],
    controller: intent.controller,
    edge: intent.edge,
    optimisticConcurrency: {
      mode: intent.optimisticConcurrencyMode,
      cloudflareNativeAtomicCasClaimed: false,
      abortOnAnyDeploymentSetDrift: true,
      retryMutationAfterAmbiguousResponse: false,
      classifyAmbiguousResponseByAuthenticatedReadback: true,
    },
    partialSuccessBoundary: {
      controllerSuccessEdgeFailure: "retain-dual-ring-controller",
      newTrafficAuthority: "go-vps",
      controllerGenerationRollbackAuthorized: false,
      forwardRepairRequired: true,
    },
    trustedPolicyAnchors: {
      verifiedByOfflineVerifier: false,
      requiredByMutationRunner: true,
    },
    executableCommand: null,
  };
  const executionPlanDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(executionPlan), "utf8"),
  );

  return {
    ok: true,
    structurallyValid: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
    decision: RING_TRANSITION_AUTHORIZATION_RESULT,
    environment: "staging",
    authorizationIdSha256: manifest.subject.authorizationIdSha256,
    executionNonceSha256: manifest.subject.executionNonceSha256,
    authorizationManifestDigestSha256: sha256Hex(manifestFile.bytes),
    authorizationSubjectDigestSha256: subjectDigestSha256,
    authorizationPolicyId: policy.policyId,
    authorizationPolicyDigestSha256: sha256Hex(policyFile.bytes),
    transitionManifestDigestSha256: transition.manifestDigestSha256,
    transitionSubjectDigestSha256: transition.subjectDigestSha256,
    transitionPolicyDigestSha256: transition.policyDigestSha256,
    transitionPlanDigestSha256: transition.planDigestSha256,
    candidateDigestSha256: transition.candidateDigestSha256,
    approvalRoles: approvalKeys.map((approval) => approval.role),
    approvalKeys,
    transitionApprovalKeys: transition.approvalKeys,
    artifacts: evidence.items.map(
      ({ kind, sha256, capturedAt, expiresAt }) => ({
        kind,
        sha256,
        capturedAt,
        expiresAt,
      }),
    ),
    deploymentSetReadback: {
      accountIdSha256: deploymentReadback.accountIdSha256,
      readCredentialIdSha256: deploymentReadback.readCredentialIdSha256,
      observedBeforeAt: deploymentReadback.observedBeforeAt,
      observedAfterAt: deploymentReadback.observedAfterAt,
      stableBeforeAfter: true,
    },
    credentialScope: {
      replacementReadCredentialIdSha256:
        credentialScope.replacementReadCredentialIdSha256,
      replacementClaimCredentialIdSha256:
        credentialScope.replacementClaimCredentialIdSha256,
      replacementDeployCredentialIdSha256:
        credentialScope.replacementDeployCredentialIdSha256,
      credentialsDistinct: true,
      leastPrivilege: true,
      secretValueIncluded: false,
    },
    claimAuthority: {
      authority: claimReadiness.authority,
      ledgerIdentitySha256: claimReadiness.ledgerIdentitySha256,
      claimAuthorityOriginSha256:
        claimReadiness.claimAuthorityOriginSha256,
      migrationHead: claimReadiness.migrationHead,
      claimTable: claimReadiness.claimTable,
      stepTable: claimReadiness.stepTable,
      expiryTable: claimReadiness.expiryTable,
      claimCredentialIdSha256:
        claimReadiness.claimCredentialIdSha256,
      remoteClaimPerformed: false,
    },
    generatedAt: manifest.subject.generatedAt,
    offlineSignedAuthorizationVerified: true,
    signedWorkerDeploymentScopeApproved: true,
    trustedPolicyAnchorVerified: false,
    runnerTrustedPolicyAnchorRequired: true,
    remoteMutationAuthorized: false,
    workerDeploymentMutationAuthorized: false,
    singleExecutionAuthorized: false,
    atomicRemoteClaimRequired: true,
    authenticatedT1ReadbackRequired: true,
    authenticatedPostMutationReadbackRequired: true,
    cloudflareNativeAtomicCasClaimed: false,
    mutationPerformedByVerifier: false,
    credentialsReadByVerifier: false,
    networkRequestsPerformedByVerifier: false,
    filesWrittenByVerifier: false,
    shellCommandsExecutedByVerifier: false,
    customerTrafficAuthorized: false,
    paidProviderCallsAuthorized: false,
    productionCutoverAuthorized: false,
    versionUploadAuthorized: false,
    resourceMutationAuthorized: false,
    secretMutationAuthorized: false,
    cleanupMutationAuthorized: false,
    deploymentDeletionAuthorized: false,
    generationRollbackAuthorized: false,
    goVpsShutdownAuthorized: false,
    executionPlan,
    executionPlanDigestSha256,
    expiresAt: manifest.subject.expiresAt,
  };
}

export function ringTransitionAuthorizationApprovalMessage({
  policyId,
  environment,
  role,
  keyId,
  subjectDigestSha256,
  signedAt,
  expiresAt,
}) {
  return Buffer.from(
    [
      RING_TRANSITION_AUTHORIZATION_APPROVAL_DOMAIN,
      policyId,
      environment,
      role,
      keyId,
      subjectDigestSha256,
      signedAt,
      expiresAt,
      "",
    ].join("\n"),
    "utf8",
  );
}

function validateManifestEnvelope(value) {
  const manifest = requireObject(value, "[manifest] authorization manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "contract", "subject", "subjectDigestSha256", "approvals"],
    "[manifest] authorization manifest",
  );
  requireExact(manifest.schemaVersion, 1, "[manifest] schemaVersion");
  requireExact(
    manifest.contract,
    RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
    "[manifest] contract",
  );
  requireSha256(manifest.subjectDigestSha256, "[manifest] subject digest");
  const subject = requireObject(manifest.subject, "[manifest] subject");
  exactKeys(
    subject,
    [
      "policyId",
      "environment",
      "decision",
      "generatedAt",
      "expiresAt",
      "authorizationIdSha256",
      "executionNonceSha256",
      "transitionBinding",
      "deploymentIntent",
      "artifacts",
      "safetyBoundary",
    ],
    "[manifest] subject",
  );
  requireExact(subject.environment, "staging", "[manifest] environment");
  requireExact(
    subject.decision,
    RING_TRANSITION_AUTHORIZATION_DECISION,
    "[manifest] decision",
  );
  requireSha256(
    subject.authorizationIdSha256,
    "[manifest] authorization ID",
  );
  requireSha256(subject.executionNonceSha256, "[manifest] execution nonce");
  if (subject.authorizationIdSha256 === subject.executionNonceSha256) {
    throw new Error("[manifest] authorization ID and execution nonce must differ");
  }
  return { ...manifest, subject };
}

function validateDecisionTime(subject, policy, transition, now) {
  const generatedAt = requireWholeSecondTimestamp(
    subject.generatedAt,
    "[manifest] generatedAt",
  );
  const expiresAt = requireWholeSecondTimestamp(
    subject.expiresAt,
    "[manifest] expiresAt",
  );
  const skewMs = policy.maxClockSkewSeconds * 1000;
  if (generatedAt.getTime() > now.getTime() + skewMs) {
    throw new Error("[manifest] authorization was generated in the future");
  }
  const lifetimeSeconds =
    (expiresAt.getTime() - generatedAt.getTime()) / 1000;
  if (
    lifetimeSeconds < MIN_RING_TRANSITION_AUTHORIZATION_LEAD_SECONDS ||
    lifetimeSeconds > MAX_RING_TRANSITION_AUTHORIZATION_SECONDS
  ) {
    throw new Error("[manifest] authorization lifetime is invalid");
  }
  if (
    expiresAt.getTime() - now.getTime() <
    MIN_RING_TRANSITION_AUTHORIZATION_LEAD_SECONDS * 1000
  ) {
    throw new Error("[manifest] authorization has insufficient execution lead");
  }
  if (
    generatedAt.getTime() < policy.validFrom.getTime() ||
    expiresAt.getTime() > policy.validUntil.getTime()
  ) {
    throw new Error("[manifest] authorization must fit the policy window");
  }
  const transitionExpiry = requireTimestamp(
    transition.expiresAt,
    "[transition] review expiry",
  );
  const admissionStartedAt = requireTimestamp(
    transition.transition.admissionStartedAt,
    "[transition] admission start",
  );
  if (
    expiresAt.getTime() > transitionExpiry.getTime() ||
    expiresAt.getTime() > admissionStartedAt.getTime()
  ) {
    throw new Error(
      "[manifest] authorization must expire before transition review or admission start",
    );
  }
  return { generatedAt, expiresAt };
}

function validatePolicyBinding(subject, policy) {
  requireExact(subject.policyId, policy.policyId, "[manifest] policy ID");
  requireExact(subject.environment, policy.environment, "[manifest] policy environment");
}

function validateTransitionBinding(value, transition) {
  const binding = requireObject(value, "[transition] binding");
  exactKeys(
    binding,
    [
      "manifestDigestSha256",
      "subjectDigestSha256",
      "policyDigestSha256",
      "planDigestSha256",
      "candidateDigestSha256",
      "reviewDecision",
    ],
    "[transition] binding",
  );
  for (const [field, expected] of [
    ["manifestDigestSha256", transition.manifestDigestSha256],
    ["subjectDigestSha256", transition.subjectDigestSha256],
    ["policyDigestSha256", transition.policyDigestSha256],
    ["planDigestSha256", transition.planDigestSha256],
    ["candidateDigestSha256", transition.candidateDigestSha256],
    ["reviewDecision", transition.decision],
  ]) {
    requireExact(binding[field], expected, `[transition] ${field}`);
  }
}

function validateDeploymentIntent(value, transition) {
  const intent = requireObject(value, "[intent] deployment intent");
  exactKeys(
    intent,
    [
      "phase",
      "controllerFirst",
      "edgeRequiresControllerReadback",
      "optimisticConcurrencyMode",
      "nativeAtomicCasClaimed",
      "maxExecutions",
      "controller",
      "edge",
    ],
    "[intent] deployment intent",
  );
  requireExact(intent.phase, "open-adjacent-ring-transition", "[intent] phase");
  requireExact(intent.controllerFirst, true, "[intent] Controller order");
  requireExact(
    intent.edgeRequiresControllerReadback,
    true,
    "[intent] Edge readback dependency",
  );
  requireExact(
    intent.optimisticConcurrencyMode,
    "read-verify-write-read",
    "[intent] concurrency mode",
  );
  requireExact(
    intent.nativeAtomicCasClaimed,
    false,
    "[intent] native atomic CAS claim",
  );
  requireExact(intent.maxExecutions, 1, "[intent] maximum executions");
  const controller = validateServiceMutation(
    intent.controller,
    {
      serviceName: transition.serviceIdentities.controllerWorker,
      expectedVersionId:
        transition.plan.controllerFirst.expectedPreviousVersionId,
      expectedDeploymentSetSha256:
        transition.plan.controllerFirst.previousDeploymentSetSha256,
      targetVersionId: transition.plan.controllerFirst.expectedVersionId,
      overlay: transition.plan.controllerFirst.vars,
    },
    "controller",
  );
  const edge = validateServiceMutation(
    intent.edge,
    {
      serviceName: transition.serviceIdentities.edgeWorker,
      expectedVersionId: transition.plan.edgeSecond.expectedPreviousVersionId,
      expectedDeploymentSetSha256:
        transition.plan.edgeSecond.previousDeploymentSetSha256,
      targetVersionId: transition.plan.edgeSecond.expectedVersionId,
      overlay: transition.plan.edgeSecond.vars,
    },
    "edge",
  );
  return { ...intent, controller, edge };
}

function validateServiceMutation(value, expected, label) {
  const mutation = requireObject(value, `[intent] ${label}`);
  exactKeys(
    mutation,
    [
      "serviceName",
      "expectedVersionId",
      "expectedDeploymentSetSha256",
      "targetVersionId",
      "targetPercentage",
      "overlaySha256",
    ],
    `[intent] ${label}`,
  );
  requireExact(
    mutation.serviceName,
    expected.serviceName,
    `[intent] ${label} service`,
  );
  requireExact(
    mutation.expectedVersionId,
    expected.expectedVersionId,
    `[intent] ${label} expected version`,
  );
  requireExact(
    mutation.expectedDeploymentSetSha256,
    expected.expectedDeploymentSetSha256,
    `[intent] ${label} deployment set`,
  );
  requireExact(
    mutation.targetVersionId,
    expected.targetVersionId,
    `[intent] ${label} target version`,
  );
  if (mutation.expectedVersionId === mutation.targetVersionId) {
    throw new Error(`[intent] ${label} target must be a new version`);
  }
  requireExact(
    mutation.targetPercentage,
    100,
    `[intent] ${label} target percentage`,
  );
  requireExact(
    mutation.overlaySha256,
    sha256Hex(Buffer.from(canonicalJson(expected.overlay), "utf8")),
    `[intent] ${label} overlay`,
  );
  return mutation;
}

function validateArtifactRecords(value, decisionTime) {
  if (
    !Array.isArray(value) ||
    value.length !== RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS.length
  ) {
    throw new Error("[artifact] exactly five authorization evidence records are required");
  }
  let totalBytes = 0;
  const seenPaths = new Set();
  return value.map((raw, index) => {
    const record = requireObject(raw, "[artifact] record");
    exactKeys(
      record,
      ["kind", "path", "sha256", "bytes", "capturedAt", "expiresAt"],
      "[artifact] record",
    );
    requireExact(
      record.kind,
      RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS[index],
      "[artifact] kind order",
    );
    const artifactPath = requireToken(
      record.path,
      relativeEvidencePathPattern,
      "[artifact] path",
    );
    requireExact(
      artifactPath,
      `evidence/${record.kind}.json`,
      "[artifact] canonical path",
    );
    if (seenPaths.has(artifactPath)) {
      throw new Error("[artifact] duplicate path");
    }
    seenPaths.add(artifactPath);
    requireSha256(record.sha256, "[artifact] digest");
    const bytes = requireInteger(
      record.bytes,
      2,
      MAX_EVIDENCE_BYTES,
      "[artifact] bytes",
    );
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new Error("[artifact] total evidence exceeds its byte bound");
    }
    const capturedAt = requireTimestamp(
      record.capturedAt,
      "[artifact] capturedAt",
    );
    const expiresAt = requireTimestamp(
      record.expiresAt,
      "[artifact] expiresAt",
    );
    if (capturedAt.getTime() > decisionTime.generatedAt.getTime()) {
      throw new Error("[artifact] evidence postdates the authorization");
    }
    if (
      decisionTime.generatedAt.getTime() - capturedAt.getTime() >
      MAX_EVIDENCE_AGE_SECONDS * 1000
    ) {
      throw new Error("[artifact] authorization evidence is stale");
    }
    if (expiresAt.getTime() < decisionTime.expiresAt.getTime()) {
      throw new Error("[artifact] evidence expires before the authorization");
    }
    return { ...record, capturedDate: capturedAt, expiresDate: expiresAt };
  });
}

async function readAndValidateArtifacts({
  records,
  manifestRoot,
  authorizationIdSha256,
  transitionSubjectDigestSha256,
}) {
  const items = [];
  const byKind = new Map();
  for (const record of records) {
    const requested = path.resolve(manifestRoot, ...record.path.split("/"));
    const file = await readCanonicalJsonEvidence(
      requested,
      `${record.kind} authorization evidence`,
      MAX_EVIDENCE_BYTES,
    );
    if (!isWithin(manifestRoot, file.realPath)) {
      throw new Error(`[artifact] ${record.kind} path escaped the authorization bundle`);
    }
    if (file.bytes.length !== record.bytes) {
      throw new Error(`[artifact] ${record.kind} byte count mismatch`);
    }
    if (sha256Hex(file.bytes) !== record.sha256) {
      throw new Error(`[artifact] ${record.kind} digest mismatch`);
    }
    const artifact = requireObject(file.value, `[artifact] ${record.kind}`);
    exactKeys(
      artifact,
      [
        "schemaVersion",
        "contract",
        "kind",
        "environment",
        "authorizationIdSha256",
        "transitionSubjectDigestSha256",
        "capturedAt",
        "expiresAt",
        "status",
        "facts",
      ],
      `[artifact] ${record.kind}`,
    );
    requireExact(artifact.schemaVersion, 1, `[artifact] ${record.kind} schemaVersion`);
    requireExact(
      artifact.contract,
      RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
      `[artifact] ${record.kind} contract`,
    );
    requireExact(artifact.kind, record.kind, `[artifact] ${record.kind} kind`);
    requireExact(
      artifact.environment,
      "staging",
      `[artifact] ${record.kind} environment`,
    );
    requireExact(
      artifact.authorizationIdSha256,
      authorizationIdSha256,
      `[artifact] ${record.kind} authorization ID`,
    );
    requireExact(
      artifact.transitionSubjectDigestSha256,
      transitionSubjectDigestSha256,
      `[artifact] ${record.kind} transition subject`,
    );
    requireExact(
      artifact.capturedAt,
      record.capturedAt,
      `[artifact] ${record.kind} capturedAt`,
    );
    requireExact(
      artifact.expiresAt,
      record.expiresAt,
      `[artifact] ${record.kind} expiresAt`,
    );
    requireExact(artifact.status, "pass", `[artifact] ${record.kind} status`);
    const item = {
      kind: record.kind,
      sha256: record.sha256,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
      capturedDate: record.capturedDate,
      expiresDate: record.expiresDate,
      facts: requireObject(artifact.facts, `[artifact] ${record.kind} facts`),
    };
    items.push(item);
    byKind.set(item.kind, item);
  }
  return { items, byKind };
}

function validateDeploymentSetReadback(
  item,
  subject,
  transition,
  intent,
) {
  const facts = requireObject(item?.facts, "[deployment] readback");
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "transport",
      "paginationComplete",
      "observedBeforeAt",
      "observedAfterAt",
      "stableBeforeAfter",
      "mutationObserved",
      "executionNonceSha256",
      "readCredentialIdSha256",
      "transitionPlanDigestSha256",
      "controller",
      "edge",
    ],
    "[deployment] readback",
  );
  requireSha256(facts.accountIdSha256, "[deployment] account ID");
  requireExact(facts.transport, "cloudflare-api", "[deployment] transport");
  requireExact(
    facts.paginationComplete,
    true,
    "[deployment] pagination completeness",
  );
  const observedBeforeAt = requireWholeSecondTimestamp(
    facts.observedBeforeAt,
    "[deployment] observedBeforeAt",
  );
  const observedAfterAt = requireWholeSecondTimestamp(
    facts.observedAfterAt,
    "[deployment] observedAfterAt",
  );
  if (
    observedAfterAt.getTime() - observedBeforeAt.getTime() <
      MIN_DEPLOYMENT_READBACK_WINDOW_SECONDS * 1000 ||
    observedAfterAt.getTime() > item.capturedDate.getTime() ||
    observedAfterAt.getTime() - observedBeforeAt.getTime() >
      MAX_DEPLOYMENT_READBACK_WINDOW_SECONDS * 1000 ||
    item.capturedDate.getTime() - observedAfterAt.getTime() >
      MAX_DEPLOYMENT_READBACK_CAPTURE_LAG_SECONDS * 1000
  ) {
    throw new Error("[deployment] observation window is invalid");
  }
  requireExact(
    facts.stableBeforeAfter,
    true,
    "[deployment] before/after stability",
  );
  requireExact(facts.mutationObserved, false, "[deployment] mutation observation");
  requireExact(
    facts.executionNonceSha256,
    subject.executionNonceSha256,
    "[deployment] execution nonce",
  );
  requireSha256(
    facts.readCredentialIdSha256,
    "[deployment] read credential ID",
  );
  requireExact(
    facts.transitionPlanDigestSha256,
    transition.planDigestSha256,
    "[deployment] transition plan",
  );
  validateDeploymentServiceReadback(
    facts.controller,
    intent.controller,
    "controller",
  );
  validateDeploymentServiceReadback(facts.edge, intent.edge, "edge");
  return facts;
}

function validateDeploymentServiceReadback(value, intent, label) {
  const readback = requireObject(value, `[deployment] ${label}`);
  exactKeys(
    readback,
    [
      "serviceName",
      "deploymentSetSha256",
      "activeVersions",
      "versionDetailSha256",
    ],
    `[deployment] ${label}`,
  );
  requireExact(
    readback.serviceName,
    intent.serviceName,
    `[deployment] ${label} service`,
  );
  requireExact(
    readback.deploymentSetSha256,
    intent.expectedDeploymentSetSha256,
    `[deployment] ${label} deployment set`,
  );
  requireSha256(
    readback.versionDetailSha256,
    `[deployment] ${label} version detail`,
  );
  if (!Array.isArray(readback.activeVersions) || readback.activeVersions.length !== 1) {
    throw new Error(`[deployment] ${label} must have one active version`);
  }
  const active = requireObject(
    readback.activeVersions[0],
    `[deployment] ${label} active version`,
  );
  exactKeys(
    active,
    ["versionId", "percentage"],
    `[deployment] ${label} active version`,
  );
  requireExact(
    active.versionId,
    intent.expectedVersionId,
    `[deployment] ${label} active version`,
  );
  requireExact(
    active.percentage,
    100,
    `[deployment] ${label} active percentage`,
  );
}

function validateCredentialScope(item, accountIdSha256) {
  const facts = requireObject(item?.facts, "[credential] scope");
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "exposedCredentialRevoked",
      "revokedAt",
      "revocationReadbackSha256",
      "replacementReadCredentialIdSha256",
      "replacementClaimCredentialIdSha256",
      "replacementDeployCredentialIdSha256",
      "credentialsDistinct",
      "readCredentialLeastPrivilege",
      "claimCredentialLeastPrivilege",
      "deployCredentialLeastPrivilege",
      "scopeAuditSha256",
      "secretValueIncluded",
    ],
    "[credential] scope",
  );
  requireExact(facts.accountIdSha256, accountIdSha256, "[credential] account");
  requireExact(
    facts.exposedCredentialRevoked,
    true,
    "[credential] exposed credential revocation",
  );
  const revokedAt = requireTimestamp(facts.revokedAt, "[credential] revokedAt");
  if (revokedAt.getTime() > item.capturedDate.getTime()) {
    throw new Error("[credential] revocation postdates its readback");
  }
  for (const field of [
    "revocationReadbackSha256",
    "replacementReadCredentialIdSha256",
    "replacementClaimCredentialIdSha256",
    "replacementDeployCredentialIdSha256",
    "scopeAuditSha256",
  ]) {
    requireSha256(facts[field], `[credential] ${field}`);
  }
  if (
    new Set([
      facts.replacementReadCredentialIdSha256,
      facts.replacementClaimCredentialIdSha256,
      facts.replacementDeployCredentialIdSha256,
    ]).size !== 3
  ) {
    throw new Error(
      "[credential] read, claim, and deploy credentials must be distinct",
    );
  }
  requireExact(facts.credentialsDistinct, true, "[credential] credential separation");
  requireExact(
    facts.readCredentialLeastPrivilege,
    true,
    "[credential] read least privilege",
  );
  requireExact(
    facts.claimCredentialLeastPrivilege,
    true,
    "[credential] claim least privilege",
  );
  requireExact(
    facts.deployCredentialLeastPrivilege,
    true,
    "[credential] deploy least privilege",
  );
  requireExact(facts.secretValueIncluded, false, "[credential] secret inclusion");
  return facts;
}

function validateOperatorCeremony(item, subject) {
  const facts = requireObject(item?.facts, "[operator] ceremony");
  exactKeys(
    facts,
    [
      "authorizationIdSha256",
      "executionNonceSha256",
      "operatorCount",
      "operatorsDistinct",
      "livePresence",
      "breakGlass",
      "sessionDigestSha256",
      "recordingDigestSha256",
      "abortOwner",
    ],
    "[operator] ceremony",
  );
  requireExact(
    facts.authorizationIdSha256,
    subject.authorizationIdSha256,
    "[operator] authorization ID",
  );
  requireExact(
    facts.executionNonceSha256,
    subject.executionNonceSha256,
    "[operator] execution nonce",
  );
  requireInteger(facts.operatorCount, 2, 8, "[operator] count");
  requireExact(facts.operatorsDistinct, true, "[operator] separation");
  requireExact(facts.livePresence, true, "[operator] live presence");
  requireExact(facts.breakGlass, false, "[operator] break-glass");
  requireSha256(facts.sessionDigestSha256, "[operator] session digest");
  requireSha256(facts.recordingDigestSha256, "[operator] recording digest");
  requireToken(facts.abortOwner, opaqueIdPattern, "[operator] abort owner");
}

function validateClaimReadiness(item, subject) {
  const facts = requireObject(item?.facts, "[claim] readiness");
  exactKeys(
    facts,
    [
      "authorizationIdSha256",
      "executionNonceSha256",
      "authority",
      "ledgerIdentitySha256",
      "claimAuthorityOriginSha256",
      "migrationHead",
      "claimTable",
      "stepTable",
      "expiryTable",
      "claimCredentialIdSha256",
      "state",
      "atomicUniqueInsertRequired",
      "ttlBound",
      "remoteClaimPerformed",
    ],
    "[claim] readiness",
  );
  requireExact(
    facts.authorizationIdSha256,
    subject.authorizationIdSha256,
    "[claim] authorization ID",
  );
  requireExact(
    facts.executionNonceSha256,
    subject.executionNonceSha256,
    "[claim] execution nonce",
  );
  requireExact(facts.authority, "d1-unique-claim-v1", "[claim] authority");
  requireSha256(facts.ledgerIdentitySha256, "[claim] ledger identity");
  requireSha256(
    facts.claimAuthorityOriginSha256,
    "[claim] authority origin",
  );
  requireExact(
    facts.migrationHead,
    "0060_relay_container_ring_transition_authority.sql",
    "[claim] migration head",
  );
  requireExact(
    facts.claimTable,
    "relay_container_ring_transition_claims",
    "[claim] claim table",
  );
  requireExact(
    facts.stepTable,
    "relay_container_ring_transition_steps",
    "[claim] step table",
  );
  requireExact(
    facts.expiryTable,
    "relay_container_ring_transition_expiry_events",
    "[claim] expiry table",
  );
  requireSha256(
    facts.claimCredentialIdSha256,
    "[claim] credential identity",
  );
  requireExact(facts.state, "unclaimed", "[claim] state");
  requireExact(
    facts.atomicUniqueInsertRequired,
    true,
    "[claim] atomic unique insert",
  );
  requireExact(facts.ttlBound, true, "[claim] TTL bound");
  requireExact(
    facts.remoteClaimPerformed,
    false,
    "[claim] pre-authorization remote claim",
  );
  return facts;
}

function validateRollbackReadiness(item, transition) {
  const facts = requireObject(item?.facts, "[rollback] readiness");
  exactKeys(
    facts,
    [
      "goVpsTrafficAuthority",
      "goVpsSchedulerAuthority",
      "controllerDrainRetained",
      "edgeMayRemainPreviousAfterControllerSuccess",
      "controllerGenerationRollbackAuthorized",
      "disableRustAdmissionPlanSha256",
      "forwardRepairPlanSha256",
      "transitionPlanDigestSha256",
    ],
    "[rollback] readiness",
  );
  for (const field of [
    "goVpsTrafficAuthority",
    "goVpsSchedulerAuthority",
    "controllerDrainRetained",
    "edgeMayRemainPreviousAfterControllerSuccess",
  ]) {
    requireExact(facts[field], true, `[rollback] ${field}`);
  }
  requireExact(
    facts.controllerGenerationRollbackAuthorized,
    false,
    "[rollback] Controller generation rollback",
  );
  requireSha256(
    facts.disableRustAdmissionPlanSha256,
    "[rollback] disable admission plan",
  );
  requireSha256(
    facts.forwardRepairPlanSha256,
    "[rollback] forward repair plan",
  );
  requireExact(
    facts.transitionPlanDigestSha256,
    transition.planDigestSha256,
    "[rollback] transition plan",
  );
}

function validateSafetyBoundary(value) {
  const boundary = requireObject(value, "[safety] boundary");
  exactKeys(
    boundary,
    [
      "isolatedStagingOnly",
      "remoteMutationScope",
      "workerDeploymentMutationAuthorized",
      "customerTrafficAuthorized",
      "paidProviderCallsAuthorized",
      "productionCutoverAuthorized",
      "versionUploadAuthorized",
      "resourceMutationAuthorized",
      "secretMutationAuthorized",
      "cleanupMutationAuthorized",
      "deploymentDeletionAuthorized",
      "generationRollbackAuthorized",
      "goVpsShutdownAuthorized",
    ],
    "[safety] boundary",
  );
  requireExact(boundary.isolatedStagingOnly, true, "[safety] staging scope");
  requireExact(
    boundary.remoteMutationScope,
    "worker-deployments-only",
    "[safety] mutation scope",
  );
  requireExact(
    boundary.workerDeploymentMutationAuthorized,
    true,
    "[safety] Worker deployment authorization",
  );
  for (const field of [
    "customerTrafficAuthorized",
    "paidProviderCallsAuthorized",
    "productionCutoverAuthorized",
    "versionUploadAuthorized",
    "resourceMutationAuthorized",
    "secretMutationAuthorized",
    "cleanupMutationAuthorized",
    "deploymentDeletionAuthorized",
    "generationRollbackAuthorized",
    "goVpsShutdownAuthorized",
  ]) {
    requireExact(boundary[field], false, `[safety] ${field}`);
  }
}

function validateTrustPolicy(value, now) {
  const policy = requireObject(value, "[policy] authorization trust policy");
  exactKeys(
    policy,
    [
      "schemaVersion",
      "contract",
      "policyId",
      "environment",
      "validFrom",
      "validUntil",
      "maxClockSkewSeconds",
      "keys",
    ],
    "[policy] authorization trust policy",
  );
  requireExact(policy.schemaVersion, 1, "[policy] schemaVersion");
  requireExact(
    policy.contract,
    RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT,
    "[policy] contract",
  );
  const policyId = requireToken(policy.policyId, keyIdPattern, "[policy] policy ID");
  requireExact(policy.environment, "staging", "[policy] environment");
  const validFrom = requireTimestamp(policy.validFrom, "[policy] validFrom");
  const validUntil = requireTimestamp(policy.validUntil, "[policy] validUntil");
  const maxClockSkewSeconds = requireInteger(
    policy.maxClockSkewSeconds,
    0,
    MAX_CLOCK_SKEW_SECONDS,
    "[policy] maxClockSkewSeconds",
  );
  if (validFrom.getTime() >= validUntil.getTime()) {
    throw new Error("[policy] validity window is empty");
  }
  if (
    now.getTime() + maxClockSkewSeconds * 1000 < validFrom.getTime() ||
    now.getTime() - maxClockSkewSeconds * 1000 >= validUntil.getTime()
  ) {
    throw new Error("[policy] authorization trust policy is not currently valid");
  }
  if (
    !Array.isArray(policy.keys) ||
    policy.keys.length !== RING_TRANSITION_AUTHORIZATION_ROLES.length
  ) {
    throw new Error("[policy] exactly four authorization keys are required");
  }
  const keys = new Map();
  const fingerprints = new Set();
  policy.keys.forEach((raw, index) => {
    const key = requireObject(raw, "[policy] key");
    exactKeys(
      key,
      ["keyId", "role", "publicKeySpkiBase64url", "notBefore", "notAfter"],
      "[policy] key",
    );
    const role = requireExact(
      key.role,
      RING_TRANSITION_AUTHORIZATION_ROLES[index],
      "[policy] key role order",
    );
    const keyId = requireToken(key.keyId, keyIdPattern, "[policy] key ID");
    if (keys.has(keyId)) throw new Error("[policy] duplicate key ID");
    const notBefore = requireTimestamp(key.notBefore, "[policy] key notBefore");
    const notAfter = requireTimestamp(key.notAfter, "[policy] key notAfter");
    if (
      notBefore.getTime() < validFrom.getTime() ||
      notAfter.getTime() > validUntil.getTime() ||
      notBefore.getTime() >= notAfter.getTime()
    ) {
      throw new Error("[policy] key validity must fit the policy window");
    }
    const der = decodeBase64Url(
      key.publicKeySpkiBase64url,
      "[policy] public key",
      32,
      256,
    );
    let publicKey;
    try {
      publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      throw new Error("[policy] public key is not valid SPKI");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("[policy] authorization keys must be Ed25519");
    }
    const publicKeySha256 = sha256Hex(der);
    if (fingerprints.has(publicKeySha256)) {
      throw new Error("[policy] authorization public keys must be distinct");
    }
    fingerprints.add(publicKeySha256);
    keys.set(keyId, {
      role,
      keyId,
      notBefore,
      notAfter,
      publicKey,
      publicKeySha256,
    });
  });
  return {
    policyId,
    environment: "staging",
    validFrom,
    validUntil,
    maxClockSkewSeconds,
    keys,
  };
}

function validateApprovalKeyIsolation(policy, transitionApprovalKeys) {
  if (!Array.isArray(transitionApprovalKeys)) {
    throw new Error("[policy] transition approval keys are unavailable");
  }
  const transitionFingerprints = new Set(
    transitionApprovalKeys.map((approval) =>
      requireSha256(
        approval?.publicKeySha256,
        "[policy] transition approval key fingerprint",
      ),
    ),
  );
  for (const key of policy.keys.values()) {
    if (transitionFingerprints.has(key.publicKeySha256)) {
      throw new Error(
        "[policy] authorization and transition approval keys must be disjoint",
      );
    }
  }
}

function validateApprovals({
  approvals,
  subject,
  subjectDigestSha256,
  policy,
  transition,
  now,
}) {
  if (
    !Array.isArray(approvals) ||
    approvals.length !== RING_TRANSITION_AUTHORIZATION_ROLES.length
  ) {
    throw new Error("[approval] exactly four authorization approvals are required");
  }
  const seenKeys = new Set();
  const skewMs = policy.maxClockSkewSeconds * 1000;
  return approvals.map((raw, index) => {
    const approval = requireObject(raw, "[approval] authorization approval");
    exactKeys(
      approval,
      [
        "role",
        "keyId",
        "signedAt",
        "expiresAt",
        "subjectDigestSha256",
        "signatureBase64url",
      ],
      "[approval] authorization approval",
    );
    const role = requireExact(
      approval.role,
      RING_TRANSITION_AUTHORIZATION_ROLES[index],
      "[approval] role order",
    );
    const keyId = requireToken(approval.keyId, keyIdPattern, "[approval] key ID");
    if (seenKeys.has(keyId)) {
      throw new Error("[approval] authorization approval keys must be distinct");
    }
    seenKeys.add(keyId);
    const key = policy.keys.get(keyId);
    if (!key || key.role !== role) {
      throw new Error(`[approval] ${role} key is not trusted for the role`);
    }
    requireExact(
      approval.subjectDigestSha256,
      subjectDigestSha256,
      `[approval] ${role} subject digest`,
    );
    const signedAt = requireTimestamp(
      approval.signedAt,
      `[approval] ${role} signedAt`,
    );
    const expiresAt = requireTimestamp(
      approval.expiresAt,
      `[approval] ${role} expiresAt`,
    );
    const admissionStartedAt = requireTimestamp(
      transition.transition.admissionStartedAt,
      "[transition] admission start",
    );
    if (signedAt.getTime() < new Date(subject.generatedAt).getTime()) {
      throw new Error(`[approval] ${role} predates the authorization`);
    }
    if (
      signedAt.getTime() >= new Date(subject.expiresAt).getTime() ||
      signedAt.getTime() >= admissionStartedAt.getTime()
    ) {
      throw new Error(`[approval] ${role} is too late`);
    }
    if (signedAt.getTime() > now.getTime() + skewMs) {
      throw new Error(`[approval] ${role} signature is from the future`);
    }
    if (expiresAt.getTime() < new Date(subject.expiresAt).getTime()) {
      throw new Error(`[approval] ${role} expires before the authorization`);
    }
    if (
      signedAt.getTime() < key.notBefore.getTime() ||
      expiresAt.getTime() > key.notAfter.getTime()
    ) {
      throw new Error(`[approval] ${role} is outside key validity`);
    }
    const signature = decodeBase64Url(
      approval.signatureBase64url,
      `[approval] ${role} signature`,
      64,
      64,
    );
    const message = ringTransitionAuthorizationApprovalMessage({
      policyId: subject.policyId,
      environment: subject.environment,
      role,
      keyId,
      subjectDigestSha256,
      signedAt: approval.signedAt,
      expiresAt: approval.expiresAt,
    });
    if (!verifySignature(null, message, key.publicKey, signature)) {
      throw new Error(`[approval] ${role} signature verification failed`);
    }
    return { role, keyId, publicKeySha256: key.publicKeySha256 };
  });
}

function isWithin(root, child) {
  const relative = path.relative(root, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
  return actual;
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  return requireToken(value, sha256Pattern, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function requireWholeSecondTimestamp(value, label) {
  const timestamp = requireTimestamp(value, label);
  if (timestamp.getUTCMilliseconds() !== 0) {
    throw new Error(`${label} must be aligned to a whole second`);
  }
  return timestamp;
}

function requireDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

function decodeBase64Url(value, label, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string" ||
    !base64UrlPattern.test(value) ||
    value.includes("=")
  ) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new Error(`${label} is not valid base64url`);
  }
  if (
    bytes.length < minimumBytes ||
    bytes.length > maximumBytes ||
    bytes.toString("base64url") !== value
  ) {
    throw new Error(`${label} has invalid canonical bytes`);
  }
  return bytes;
}
