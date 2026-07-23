import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  REQUIRED_APPROVAL_ROLES,
  canonicalJson,
  p5CandidateDigestSha256,
  sha256Hex,
  validateP5Candidate,
} from "./relay_container_p5_evidence_contract.mjs";

export const RING_TRANSITION_MANIFEST_CONTRACT =
  "cinatoken-relay-container-ring-transition-manifest-v1";
export const RING_TRANSITION_TRUST_POLICY_CONTRACT =
  "cinatoken-relay-container-ring-transition-trust-policy-v1";
export const RING_TRANSITION_APPROVAL_DOMAIN =
  "cinatoken-relay-container-ring-transition-approval-v1";
export const RING_TRANSITION_EVIDENCE_CONTRACT =
  "cinatoken-relay-container-ring-transition-evidence-v1";
export const RING_TRANSITION_DECISION =
  "isolated-staging-adjacent-ring-transition";
export const MAX_RING_TRANSITION_WINDOW_SECONDS = 900;
export const MIN_RING_TRANSITION_PREFLIGHT_LEAD_SECONDS = 300;
export const RING_TRANSITION_EVIDENCE_KINDS = Object.freeze([
  "candidate-foundation",
  "previous-ring-readback",
  "capacity-readback",
  "observability-plan",
  "rollback-packet",
  "credential-revocation",
  "go-vps-fallback-readiness",
]);

export const ROUTING_CONTRACT_IDENTITY = Object.freeze({
  schemaVersion: 1,
  contract: "cinatoken-container-shard-routing-v1",
  algorithm: "hmac-sha256+jump-consistent-hash-v1",
  domainHex: Buffer.from(
    "cinatoken-container-shard-routing:v1\0",
    "utf8",
  ).toString("hex"),
  instancePrefix: "cinatoken-relay-shard-v1",
  minimumSecretBytes: 32,
  maximumShards: 1024,
});

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_DECISION_LIFETIME_SECONDS = 24 * 60 * 60;
const MIN_RING_TRANSITION_WINDOW_SECONDS = 30;
const MAX_CUTOFF_SAFETY_MARGIN_SECONDS = 60;

const sha256Pattern = /^[0-9a-f]{64}$/;
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const relativeEvidencePathPattern =
  /^evidence\/[a-z0-9][a-z0-9-]{0,63}\.json$/;

export async function verifyRingTransitionBundle({
  manifestPath,
  trustPolicyPath,
  now = new Date(),
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("[time] verifier now must be a valid Date");
  }
  return verifyRingTransitionManifest({
    manifestPath,
    trustPolicyPath,
    now,
  });
}

async function verifyRingTransitionManifest({
  manifestPath,
  trustPolicyPath,
  now,
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("[time] verifier now must be a valid Date");
  }

  const manifestFile = await readCanonicalJson(
    manifestPath,
    "ring transition manifest",
    MAX_MANIFEST_BYTES,
  );
  const policyFile = await readCanonicalJson(
    trustPolicyPath,
    "ring transition trust policy",
    MAX_POLICY_BYTES,
  );
  const manifestRoot = path.dirname(manifestFile.realPath);
  if (
    policyFile.realPath === manifestRoot ||
    isWithin(manifestRoot, policyFile.realPath)
  ) {
    throw new Error(
      "[policy] ring transition trust policy must be external to the manifest bundle",
    );
  }

  const policy = validateTrustPolicy(policyFile.value, now);
  const manifest = validateManifestEnvelope(manifestFile.value);
  const decisionTime = validateDecisionTime(manifest.subject, policy, now);
  validatePolicyBinding(manifest.subject, policy);

  const candidate = validateP5Candidate(manifest.subject.candidate);
  const candidateDigestSha256 = p5CandidateDigestSha256(candidate);
  requireExact(
    manifest.subject.candidateDigestSha256,
    candidateDigestSha256,
    "[candidate] candidate digest",
  );

  const transition = validateTransition(
    manifest.subject.transition,
    candidate,
    decisionTime,
    now,
  );
  const cohort = validateCohort(manifest.subject.cohort);
  const artifactRecords = validateArtifactRecords(
    manifest.subject.artifacts,
    decisionTime,
  );
  const artifactEvidence = await readAndValidateArtifacts({
    records: artifactRecords,
    manifestRoot,
    candidateDigestSha256,
  });
  const previousRingBaseline = validatePreviousRingBaseline(
    artifactEvidence.byKind.get("previous-ring-readback"),
    candidate,
    transition,
  );
  const goVpsFallback = validateGoVpsFallback(
    artifactEvidence.byKind.get("go-vps-fallback-readiness"),
    candidate,
  );
  const candidateFoundation = validateCandidateFoundation(
    artifactEvidence.byKind.get("candidate-foundation"),
    candidate,
    candidateDigestSha256,
  );
  validateCapacityReadback(
    artifactEvidence.byKind.get("capacity-readback"),
    candidate,
    transition,
  );
  validateObservabilityPlan(artifactEvidence.byKind.get("observability-plan"));
  validateRollbackPacket(artifactEvidence.byKind.get("rollback-packet"));
  validateCredentialRevocation(
    artifactEvidence.byKind.get("credential-revocation"),
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
  const approvalRoles = approvalKeys.map((approval) => approval.role);
  const plan = buildReviewOnlyPlan(candidate, transition, previousRingBaseline);
  const planDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(plan), "utf8"),
  );

  return {
    ok: true,
    structurallyValid: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_MANIFEST_CONTRACT,
    decision: "eligible-for-isolated-staging-adjacent-ring-transition-review",
    isolatedStagingTransitionReviewEligible: true,
    deployAuthorized: false,
    controllerDeployAuthorized: false,
    edgeDeployAuthorized: false,
    remoteMutationAuthorized: false,
    remoteMutationPerformedByVerifier: false,
    credentialsReadByVerifier: false,
    customerTrafficAuthorized: false,
    customerTrafficEligible: false,
    productionCutoverAuthorized: false,
    productionEligible: false,
    providerCallsAuthorized: false,
    environment: "staging",
    repository: candidate.repository,
    commitSha: candidate.commitSha,
    candidateDigestSha256,
    subjectDigestSha256,
    policyId: policy.policyId,
    policyDigestSha256: sha256Hex(policyFile.bytes),
    approvalRoles,
    approvalKeys,
    prerequisiteEvidence: {
      candidateFoundationSha256:
        artifactEvidence.byKind.get("candidate-foundation").sha256,
      foundationCaptureSha256:
        candidateFoundation.foundationCaptureSha256,
      previousRingReadbackSha256:
        artifactEvidence.byKind.get("previous-ring-readback").sha256,
      goVpsFallbackAuthority: goVpsFallback.authority,
      goVpsFallbackReadinessSha256:
        artifactEvidence.byKind.get("go-vps-fallback-readiness").sha256,
      latestEvidenceAt: artifactEvidence.latestCapturedAt.toISOString(),
    },
    artifacts: artifactEvidence.items.map(({ kind, sha256, capturedAt, expiresAt }) => ({
      kind,
      sha256,
      capturedAt,
      expiresAt,
    })),
    transition: {
      previousRingGeneration: transition.previousRingGeneration,
      previousShardCount: transition.previousShardCount,
      currentRingGeneration: transition.currentRingGeneration,
      currentShardCount: transition.currentShardCount,
      admissionStartedAt: transition.admissionStartedAt,
      admissionUntil: transition.admissionUntil,
      admissionWindowSeconds: transition.admissionWindowSeconds,
      cutoffSafetyMarginSeconds: transition.cutoffSafetyMarginSeconds,
      maxInstances: transition.maxInstances,
      routingKeyId: transition.routingKeyId,
      routingKeyFingerprintSha256:
        transition.routingKeyFingerprintSha256,
      authorityKeyId: transition.authorityKeyId,
      authorityKeyFingerprintSha256:
        transition.authorityKeyFingerprintSha256,
    },
    cohort,
    plan,
    planDigestSha256,
    expiresAt: manifest.subject.expiresAt,
    safetyBoundary: {
      credentialsReadByVerifier: false,
      networkRequestsPerformedByVerifier: false,
      filesWrittenByVerifier: false,
      shellCommandsExecutedByVerifier: false,
      executableDeployCommandEmittedByVerifier: false,
      remoteMutationPerformedByVerifier: false,
      remoteMutationAuthorized: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
      providerCallsAuthorized: false,
    },
  };
}

export function ringTransitionApprovalMessage({
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
      RING_TRANSITION_APPROVAL_DOMAIN,
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

export function routingContractDigestSha256() {
  return sha256Hex(Buffer.from(canonicalJson(ROUTING_CONTRACT_IDENTITY), "utf8"));
}

function validateManifestEnvelope(value) {
  const manifest = requireObject(value, "[manifest] manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "contract", "subject", "subjectDigestSha256", "approvals"],
    "[manifest] manifest",
  );
  requireExact(manifest.schemaVersion, 1, "[manifest] schemaVersion");
  requireExact(
    manifest.contract,
    RING_TRANSITION_MANIFEST_CONTRACT,
    "[manifest] contract",
  );
  requireSha256(manifest.subjectDigestSha256, "[manifest] subjectDigestSha256");
  const subject = requireObject(manifest.subject, "[manifest] subject");
  exactKeys(
    subject,
    [
      "policyId",
      "environment",
      "decision",
      "generatedAt",
      "expiresAt",
      "candidate",
      "candidateDigestSha256",
      "transition",
      "cohort",
      "artifacts",
      "safetyBoundary",
    ],
    "[manifest] subject",
  );
  return { ...manifest, subject };
}

function validateDecisionTime(subject, policy, now) {
  requireExact(subject.environment, "staging", "[manifest] environment");
  requireExact(subject.decision, RING_TRANSITION_DECISION, "[manifest] decision");
  const generatedAt = requireTimestamp(subject.generatedAt, "[manifest] generatedAt");
  const expiresAt = requireTimestamp(subject.expiresAt, "[manifest] expiresAt");
  const skewMs = policy.maxClockSkewSeconds * 1000;
  if (generatedAt.getTime() > now.getTime() + skewMs) {
    throw new Error("[manifest] generatedAt is in the future");
  }
  if (expiresAt.getTime() <= now.getTime() - skewMs) {
    throw new Error("[manifest] decision has expired");
  }
  const lifetimeSeconds = (expiresAt.getTime() - generatedAt.getTime()) / 1000;
  if (lifetimeSeconds <= 0 || lifetimeSeconds > MAX_DECISION_LIFETIME_SECONDS) {
    throw new Error("[manifest] decision lifetime is invalid");
  }
  if (
    generatedAt.getTime() < policy.validFrom.getTime() ||
    expiresAt.getTime() > policy.validUntil.getTime()
  ) {
    throw new Error("[manifest] decision must fit the trust policy window");
  }
  return { generatedAt, expiresAt };
}

function validatePolicyBinding(subject, policy) {
  requireExact(subject.policyId, policy.policyId, "[manifest] policyId");
  requireExact(subject.environment, policy.environment, "[manifest] policy environment");
}

function validateTransition(value, candidate, decisionTime, now) {
  const transition = requireObject(value, "[transition] transition");
  exactKeys(
    transition,
    [
      "previousRingGeneration",
      "previousShardCount",
      "currentRingGeneration",
      "currentShardCount",
      "admissionStartedAt",
      "admissionUntil",
      "cutoffSafetyMarginSeconds",
      "maxInstances",
      "routingContractDigestSha256",
      "routingKeyId",
      "routingKeyFingerprintSha256",
      "authorityKeyId",
      "authorityKeyFingerprintSha256",
    ],
    "[transition] transition",
  );
  const previousRingGeneration = requireInteger(
    transition.previousRingGeneration,
    1,
    999_999,
    "[transition] previous ring generation",
  );
  const previousShardCount = requireInteger(
    transition.previousShardCount,
    1,
    1023,
    "[transition] previous shard count",
  );
  const currentRingGeneration = requireInteger(
    transition.currentRingGeneration,
    2,
    1_000_000,
    "[transition] current ring generation",
  );
  const currentShardCount = requireInteger(
    transition.currentShardCount,
    2,
    1024,
    "[transition] current shard count",
  );
  requireExact(
    currentRingGeneration,
    previousRingGeneration + 1,
    "[transition] adjacent ring generation",
  );
  if (currentShardCount <= previousShardCount) {
    throw new Error("[transition] shard ring must expand");
  }
  requireExact(
    currentRingGeneration,
    candidate.ringGeneration,
    "[transition] candidate ring generation",
  );
  requireExact(
    currentShardCount,
    candidate.shardCount,
    "[transition] candidate shard count",
  );

  const admissionStartedAt = requireWholeSecondTimestamp(
    transition.admissionStartedAt,
    "[transition] admissionStartedAt",
  );
  const admissionUntil = requireWholeSecondTimestamp(
    transition.admissionUntil,
    "[transition] admissionUntil",
  );
  const admissionWindowSeconds =
    (admissionUntil.getTime() - admissionStartedAt.getTime()) / 1000;
  if (
    admissionWindowSeconds < MIN_RING_TRANSITION_WINDOW_SECONDS ||
    admissionWindowSeconds > MAX_RING_TRANSITION_WINDOW_SECONDS
  ) {
    throw new Error("[transition] admission window is out of range");
  }
  if (
    admissionStartedAt.getTime() < decisionTime.generatedAt.getTime() ||
    admissionUntil.getTime() > decisionTime.expiresAt.getTime()
  ) {
    throw new Error("[transition] admission window must fit the signed decision window");
  }
  if (
    admissionStartedAt.getTime() <
    now.getTime() + MIN_RING_TRANSITION_PREFLIGHT_LEAD_SECONDS * 1000
  ) {
    throw new Error("[transition] preflight lead time is insufficient");
  }

  const cutoffSafetyMarginSeconds = requireInteger(
    transition.cutoffSafetyMarginSeconds,
    5,
    MAX_CUTOFF_SAFETY_MARGIN_SECONDS,
    "[transition] cutoff safety margin",
  );
  if (cutoffSafetyMarginSeconds >= admissionWindowSeconds) {
    throw new Error("[transition] cutoff safety margin consumes the admission window");
  }
  const maxInstances = requireInteger(
    transition.maxInstances,
    currentShardCount,
    1024,
    "[transition] maxInstances",
  );
  requireExact(
    transition.routingContractDigestSha256,
    routingContractDigestSha256(),
    "[transition] routing contract digest",
  );
  const routingKeyId = requireToken(
    transition.routingKeyId,
    keyIdPattern,
    "[transition] routing key ID",
  );
  const routingKeyFingerprintSha256 = requireSha256(
    transition.routingKeyFingerprintSha256,
    "[transition] routing key fingerprint",
  );
  const authorityKeyId = requireToken(
    transition.authorityKeyId,
    keyIdPattern,
    "[transition] authority key ID",
  );
  const authorityKeyFingerprintSha256 = requireSha256(
    transition.authorityKeyFingerprintSha256,
    "[transition] authority key fingerprint",
  );

  return {
    previousRingGeneration,
    previousShardCount,
    currentRingGeneration,
    currentShardCount,
    admissionStartedAt: transition.admissionStartedAt,
    admissionUntil: transition.admissionUntil,
    admissionStartedAtUnixSeconds: admissionStartedAt.getTime() / 1000,
    admissionUntilUnixSeconds: admissionUntil.getTime() / 1000,
    admissionWindowSeconds,
    cutoffSafetyMarginSeconds,
    maxInstances,
    routingKeyId,
    routingKeyFingerprintSha256,
    authorityKeyId,
    authorityKeyFingerprintSha256,
  };
}

function validateCohort(value) {
  const cohort = requireObject(value, "[cohort] cohort");
  exactKeys(
    cohort,
    [
      "kind",
      "route",
      "streaming",
      "customerTraffic",
      "paidProviderCalls",
      "maxOperations",
      "tenantScopeSha256",
      "tokenScopeSha256",
    ],
    "[cohort] cohort",
  );
  requireExact(cohort.kind, "synthetic", "[cohort] kind");
  requireExact(cohort.route, "/v1/chat/completions", "[cohort] route");
  requireExact(cohort.streaming, false, "[cohort] streaming");
  requireExact(cohort.customerTraffic, false, "[cohort] customer traffic");
  requireExact(cohort.paidProviderCalls, false, "[cohort] paid provider calls");
  requireInteger(cohort.maxOperations, 1, 100, "[cohort] maxOperations");
  requireSha256(cohort.tenantScopeSha256, "[cohort] tenant scope");
  requireSha256(cohort.tokenScopeSha256, "[cohort] token scope");
  return cohort;
}

function validateArtifactRecords(value, decisionTime) {
  if (!Array.isArray(value) || value.length !== RING_TRANSITION_EVIDENCE_KINDS.length) {
    throw new Error("[artifact] exactly seven evidence records are required");
  }
  const seenPaths = new Set();
  let totalBytes = 0;
  return value.map((raw, index) => {
    const record = requireObject(raw, "[artifact] record");
    exactKeys(
      record,
      ["kind", "path", "sha256", "bytes", "capturedAt", "expiresAt"],
      "[artifact] record",
    );
    requireExact(
      record.kind,
      RING_TRANSITION_EVIDENCE_KINDS[index],
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
    if (seenPaths.has(artifactPath)) throw new Error("[artifact] duplicate path");
    seenPaths.add(artifactPath);
    requireSha256(record.sha256, "[artifact] sha256");
    const bytes = requireInteger(record.bytes, 2, MAX_EVIDENCE_BYTES, "[artifact] bytes");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new Error("[artifact] total evidence exceeds its byte bound");
    }
    const capturedAt = requireTimestamp(record.capturedAt, "[artifact] capturedAt");
    const expiresAt = requireTimestamp(record.expiresAt, "[artifact] expiresAt");
    if (capturedAt.getTime() > decisionTime.generatedAt.getTime()) {
      throw new Error("[artifact] evidence postdates the manifest");
    }
    if (
      decisionTime.generatedAt.getTime() - capturedAt.getTime() >
      6 * 60 * 60 * 1000
    ) {
      throw new Error("[artifact] evidence is stale");
    }
    if (expiresAt.getTime() < decisionTime.expiresAt.getTime()) {
      throw new Error("[artifact] evidence expires before the decision");
    }
    return { ...record, capturedDate: capturedAt, expiresDate: expiresAt };
  });
}

function validateCandidateFoundation(item, candidate, candidateDigestSha256) {
  const facts = requireObject(item?.facts, "[foundation] candidate");
  exactKeys(
    facts,
    [
      "candidateDigestSha256",
      "foundationCaptureSha256",
      "candidateFreezeEvidenceSha256",
      "sourceAuditSha256",
      "buildProvenanceSha256",
      "remotePromotionEvidenceClaimed",
      "transitionEvidenceClaimed",
    ],
    "[foundation] candidate",
  );
  requireExact(
    facts.candidateDigestSha256,
    candidateDigestSha256,
    "[foundation] candidate digest",
  );
  requireSha256(facts.foundationCaptureSha256, "[foundation] capture digest");
  requireSha256(
    facts.candidateFreezeEvidenceSha256,
    "[foundation] candidate-freeze digest",
  );
  requireSha256(facts.sourceAuditSha256, "[foundation] source-audit digest");
  requireExact(
    facts.buildProvenanceSha256,
    candidate.containerImageProvenanceSha256,
    "[foundation] build provenance",
  );
  requireExact(
    facts.remotePromotionEvidenceClaimed,
    false,
    "[foundation] remote promotion claim",
  );
  requireExact(
    facts.transitionEvidenceClaimed,
    false,
    "[foundation] transition evidence claim",
  );
  return facts;
}

async function readAndValidateArtifacts({
  records,
  manifestRoot,
  candidateDigestSha256,
}) {
  const items = [];
  const byKind = new Map();
  for (const record of records) {
    const requested = path.resolve(manifestRoot, ...record.path.split("/"));
    const requestedRealPath = await realpath(requested).catch(() => null);
    if (!requestedRealPath || !isWithin(manifestRoot, requestedRealPath)) {
      throw new Error(`[artifact] ${record.kind} path escaped the manifest bundle`);
    }
    const file = await readCanonicalJson(
      requested,
      `${record.kind} evidence`,
      MAX_EVIDENCE_BYTES,
    );
    if (file.realPath !== requestedRealPath) {
      throw new Error(`[artifact] ${record.kind} path is not stable`);
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
        "candidateDigestSha256",
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
      RING_TRANSITION_EVIDENCE_CONTRACT,
      `[artifact] ${record.kind} contract`,
    );
    requireExact(artifact.kind, record.kind, `[artifact] ${record.kind} kind`);
    requireExact(artifact.environment, "staging", `[artifact] ${record.kind} environment`);
    requireExact(
      artifact.candidateDigestSha256,
      candidateDigestSha256,
      `[artifact] ${record.kind} candidate digest`,
    );
    requireExact(artifact.capturedAt, record.capturedAt, `[artifact] ${record.kind} capturedAt`);
    requireExact(artifact.expiresAt, record.expiresAt, `[artifact] ${record.kind} expiresAt`);
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
  return {
    items,
    byKind,
    latestCapturedAt: items
      .map((item) => item.capturedDate)
      .sort((left, right) => right.getTime() - left.getTime())[0],
  };
}

function validatePreviousRingBaseline(item, candidate, transition) {
  const baseline = requireObject(item?.facts, "[baseline] previous ring");
  exactKeys(
    baseline,
    [
      "ringGeneration",
      "shardCount",
      "rustCommitSha",
      "edgeWorkerVersionId",
      "controllerWorkerVersionId",
      "edgeDeploymentSetSha256",
      "controllerDeploymentSetSha256",
      "containerImageDigest",
      "containerRuntimeBuildId",
      "containerImageProvenanceSha256",
      "containerSbomSha256",
      "providerEgressWorkerVersionId",
      "d1DatabaseName",
      "d1DatabaseId",
      "r2BucketName",
      "configKvNamespaceIdSha256",
      "controllerServiceName",
      "providerEgressServiceName",
      "doNamespaceIdSha256",
      "doBinding",
      "doClass",
      "containerClass",
      "migrationHead",
      "migrationCount",
      "responseProtocolVersion",
      "statusContractVersion",
      "financialTerminalContractVersion",
      "terminalAckContractVersion",
      "routingKeyId",
      "routingKeyFingerprintSha256",
      "authorityKeyId",
      "authorityKeyFingerprintSha256",
    ],
    "[baseline] previous ring",
  );
  requireExact(
    baseline.ringGeneration,
    transition.previousRingGeneration,
    "[baseline] ring generation",
  );
  requireExact(
    baseline.shardCount,
    transition.previousShardCount,
    "[baseline] shard count",
  );
  for (const [baselineField, candidateField] of [
    ["rustCommitSha", "commitSha"],
    ["containerImageDigest", "containerImageDigest"],
    ["containerRuntimeBuildId", "containerRuntimeBuildId"],
    ["containerImageProvenanceSha256", "containerImageProvenanceSha256"],
    ["containerSbomSha256", "containerSbomSha256"],
    ["providerEgressWorkerVersionId", "providerEgressWorkerVersionId"],
    ["d1DatabaseName", "d1DatabaseName"],
    ["d1DatabaseId", "d1DatabaseId"],
    ["r2BucketName", "r2BucketName"],
    ["configKvNamespaceIdSha256", "configKvNamespaceIdSha256"],
    ["controllerServiceName", "controllerServiceName"],
    ["providerEgressServiceName", "providerEgressServiceName"],
    ["doNamespaceIdSha256", "doNamespaceIdSha256"],
    ["doBinding", "doBinding"],
    ["doClass", "doClass"],
    ["containerClass", "containerClass"],
    ["migrationHead", "migrationHead"],
    ["migrationCount", "migrationCount"],
    ["responseProtocolVersion", "responseProtocolVersion"],
    ["statusContractVersion", "statusContractVersion"],
    ["financialTerminalContractVersion", "financialTerminalContractVersion"],
    ["terminalAckContractVersion", "terminalAckContractVersion"],
  ]) {
    requireExact(
      baseline[baselineField],
      candidate[candidateField],
      `[baseline] ${baselineField}`,
    );
  }
  requireToken(baseline.edgeWorkerVersionId, opaqueIdPattern, "[baseline] edge Worker version");
  requireToken(
    baseline.controllerWorkerVersionId,
    opaqueIdPattern,
    "[baseline] Controller Worker version",
  );
  requireSha256(baseline.edgeDeploymentSetSha256, "[baseline] edge deployment set");
  requireSha256(
    baseline.controllerDeploymentSetSha256,
    "[baseline] Controller deployment set",
  );
  requireExact(
    baseline.routingKeyId,
    transition.routingKeyId,
    "[baseline] routing key ID",
  );
  requireExact(
    baseline.routingKeyFingerprintSha256,
    transition.routingKeyFingerprintSha256,
    "[baseline] routing key fingerprint",
  );
  requireExact(
    baseline.authorityKeyId,
    transition.authorityKeyId,
    "[baseline] authority key ID",
  );
  requireExact(
    baseline.authorityKeyFingerprintSha256,
    transition.authorityKeyFingerprintSha256,
    "[baseline] authority key fingerprint",
  );
  return { ...baseline, capturedAt: item.capturedDate, expiresAt: item.expiresDate };
}

function validateGoVpsFallback(item, candidate) {
  const fallback = requireObject(item?.facts, "[go-vps] fallback readiness");
  exactKeys(
    fallback,
    [
      "authority",
      "goSourceCommit",
      "rustCommitSha",
      "trafficRollbackReady",
      "schedulerAuthorityRetained",
      "ingressDrainAuthorized",
      "processShutdownAuthorized",
      "protocolScopeSha256",
    ],
    "[go-vps] fallback readiness",
  );
  requireExact(fallback.authority, "go-vps", "[go-vps] authority");
  requireExact(
    fallback.goSourceCommit,
    candidate.goSourceCommit,
    "[go-vps] source commit",
  );
  requireExact(
    fallback.rustCommitSha,
    candidate.commitSha,
    "[go-vps] Rust commit",
  );
  requireSha256(fallback.protocolScopeSha256, "[go-vps] protocol scope");
  requireExact(
    fallback.trafficRollbackReady,
    true,
    "[go-vps] traffic rollback readiness",
  );
  requireExact(
    fallback.schedulerAuthorityRetained,
    true,
    "[go-vps] scheduler authority",
  );
  requireExact(
    fallback.ingressDrainAuthorized,
    false,
    "[go-vps] ingress drain authorization",
  );
  requireExact(
    fallback.processShutdownAuthorized,
    false,
    "[go-vps] process shutdown authorization",
  );
  return { ...fallback, capturedAt: item.capturedDate, expiresAt: item.expiresDate };
}

function validateCapacityReadback(item, candidate, transition) {
  const facts = requireObject(item?.facts, "[capacity] readback");
  exactKeys(
    facts,
    [
      "currentRingGeneration",
      "currentShardCount",
      "maxInstances",
      "readyShardCount",
      "controllerWorkerVersionId",
      "containerRuntimeBuildId",
      "capacityAllocationSha256",
    ],
    "[capacity] readback",
  );
  requireExact(facts.currentRingGeneration, transition.currentRingGeneration, "[capacity] ring generation");
  requireExact(facts.currentShardCount, transition.currentShardCount, "[capacity] shard count");
  requireExact(facts.maxInstances, transition.maxInstances, "[capacity] maxInstances");
  requireExact(facts.readyShardCount, transition.currentShardCount, "[capacity] ready shard count");
  requireExact(
    facts.controllerWorkerVersionId,
    candidate.controllerWorkerVersionId,
    "[capacity] Controller version",
  );
  requireExact(
    facts.containerRuntimeBuildId,
    candidate.containerRuntimeBuildId,
    "[capacity] runtime build",
  );
  requireSha256(facts.capacityAllocationSha256, "[capacity] allocation digest");
}

function validateObservabilityPlan(item) {
  const facts = requireObject(item?.facts, "[observability] plan");
  exactKeys(
    facts,
    [
      "dashboardConfigSha256",
      "alertPolicySha256",
      "evidenceSinkSha256",
      "abortOwner",
      "syntheticOnly",
    ],
    "[observability] plan",
  );
  requireSha256(facts.dashboardConfigSha256, "[observability] dashboard digest");
  requireSha256(facts.alertPolicySha256, "[observability] alert digest");
  requireSha256(facts.evidenceSinkSha256, "[observability] evidence sink digest");
  requireToken(facts.abortOwner, opaqueIdPattern, "[observability] abort owner");
  requireExact(facts.syntheticOnly, true, "[observability] synthetic-only scope");
}

function validateRollbackPacket(item) {
  const facts = requireObject(item?.facts, "[rollback] packet");
  exactKeys(
    facts,
    [
      "goVpsTrafficAuthority",
      "goVpsSchedulerAuthority",
      "controllerDrainRetained",
      "generationRollbackAuthorized",
      "disableRustAdmissionPlanSha256",
      "forwardRepairPlanSha256",
    ],
    "[rollback] packet",
  );
  requireExact(facts.goVpsTrafficAuthority, true, "[rollback] Go/VPS traffic authority");
  requireExact(facts.goVpsSchedulerAuthority, true, "[rollback] Go/VPS scheduler authority");
  requireExact(facts.controllerDrainRetained, true, "[rollback] Controller drain retention");
  requireExact(facts.generationRollbackAuthorized, false, "[rollback] generation rollback authority");
  requireSha256(facts.disableRustAdmissionPlanSha256, "[rollback] admission-disable plan");
  requireSha256(facts.forwardRepairPlanSha256, "[rollback] forward-repair plan");
}

function validateCredentialRevocation(item) {
  const facts = requireObject(item?.facts, "[credential] revocation");
  exactKeys(
    facts,
    [
      "revoked",
      "revokedAt",
      "revocationReadbackSha256",
      "replacementCredentialIdentitySha256",
      "scopeAuditSha256",
      "secretValueIncluded",
    ],
    "[credential] revocation",
  );
  requireExact(facts.revoked, true, "[credential] revoked");
  const revokedAt = requireTimestamp(facts.revokedAt, "[credential] revokedAt");
  if (revokedAt.getTime() > item.capturedDate.getTime()) {
    throw new Error("[credential] revocation postdates its evidence capture");
  }
  requireSha256(facts.revocationReadbackSha256, "[credential] revocation readback");
  requireSha256(
    facts.replacementCredentialIdentitySha256,
    "[credential] replacement identity",
  );
  requireSha256(facts.scopeAuditSha256, "[credential] scope audit");
  requireExact(facts.secretValueIncluded, false, "[credential] secret value inclusion");
}

function validateSafetyBoundary(value) {
  const boundary = requireObject(value, "[safety] boundary");
  exactKeys(
    boundary,
    [
      "isolatedStagingOnly",
      "customerTrafficAuthorized",
      "productionCutoverAuthorized",
      "remoteMutationAuthorized",
      "providerCallsAuthorized",
      "credentialMaterialIncluded",
      "secretRotationAuthorized",
      "generationRollbackAuthorized",
      "goVpsShutdownAuthorized",
    ],
    "[safety] boundary",
  );
  requireExact(boundary.isolatedStagingOnly, true, "[safety] isolated staging only");
  for (const name of [
    "customerTrafficAuthorized",
    "productionCutoverAuthorized",
    "remoteMutationAuthorized",
    "providerCallsAuthorized",
    "credentialMaterialIncluded",
    "secretRotationAuthorized",
    "generationRollbackAuthorized",
    "goVpsShutdownAuthorized",
  ]) {
    requireExact(boundary[name], false, `[safety] ${name}`);
  }
}

function validateTrustPolicy(value, now) {
  const policy = requireObject(value, "[policy] trust policy");
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
    "[policy] trust policy",
  );
  requireExact(policy.schemaVersion, 1, "[policy] schemaVersion");
  requireExact(
    policy.contract,
    RING_TRANSITION_TRUST_POLICY_CONTRACT,
    "[policy] contract",
  );
  const policyId = requireToken(policy.policyId, keyIdPattern, "[policy] policyId");
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
    throw new Error("[policy] trust policy is not currently valid");
  }
  if (!Array.isArray(policy.keys) || policy.keys.length < REQUIRED_APPROVAL_ROLES.length) {
    throw new Error("[policy] trust policy lacks role keys");
  }

  const keys = new Map();
  const publicKeyFingerprints = new Set();
  const roleCounts = new Map(REQUIRED_APPROVAL_ROLES.map((role) => [role, 0]));
  for (const rawKey of policy.keys) {
    const key = requireObject(rawKey, "[policy] key");
    exactKeys(
      key,
      ["keyId", "role", "publicKeySpkiBase64url", "notBefore", "notAfter"],
      "[policy] key",
    );
    const keyId = requireToken(key.keyId, keyIdPattern, "[policy] keyId");
    const role = requireEnum(key.role, REQUIRED_APPROVAL_ROLES, "[policy] key role");
    if (keys.has(keyId)) throw new Error("[policy] duplicate keyId");
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
      throw new Error("[policy] approval keys must be Ed25519");
    }
    const fingerprint = sha256Hex(der);
    if (publicKeyFingerprints.has(fingerprint)) {
      throw new Error("[policy] approval public keys must be cryptographically distinct");
    }
    publicKeyFingerprints.add(fingerprint);
    keys.set(keyId, {
      keyId,
      role,
      notBefore,
      notAfter,
      publicKey,
      publicKeySha256: fingerprint,
    });
    roleCounts.set(role, roleCounts.get(role) + 1);
  }
  for (const [role, count] of roleCounts) {
    if (count < 1) throw new Error(`[policy] missing ${role} key`);
  }
  return {
    policyId,
    environment: "staging",
    validFrom,
    validUntil,
    maxClockSkewSeconds,
    keys,
  };
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
    approvals.length !== REQUIRED_APPROVAL_ROLES.length
  ) {
    throw new Error("[approval] exactly five approvals are required");
  }
  const seenRoles = new Set();
  const seenKeys = new Set();
  const validatedApprovals = [];
  const skewMs = policy.maxClockSkewSeconds * 1000;
  for (let index = 0; index < approvals.length; index += 1) {
    const approval = requireObject(approvals[index], "[approval] approval");
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
      "[approval] approval",
    );
    const role = requireExact(
      approval.role,
      REQUIRED_APPROVAL_ROLES[index],
      "[approval] role order",
    );
    if (seenRoles.has(role)) throw new Error("[approval] duplicate role");
    seenRoles.add(role);
    const keyId = requireToken(approval.keyId, keyIdPattern, "[approval] keyId");
    if (seenKeys.has(keyId)) throw new Error("[approval] approval keys must be distinct");
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
    const signedAt = requireTimestamp(approval.signedAt, `[approval] ${role} signedAt`);
    const expiresAt = requireTimestamp(approval.expiresAt, `[approval] ${role} expiresAt`);
    if (signedAt.getTime() < new Date(subject.generatedAt).getTime()) {
      throw new Error(`[approval] ${role} predates the transition manifest`);
    }
    if (
      signedAt.getTime() >=
      new Date(transition.admissionStartedAt).getTime()
    ) {
      throw new Error(`[approval] ${role} must precede admission start`);
    }
    if (signedAt.getTime() > now.getTime() + skewMs) {
      throw new Error(`[approval] ${role} signature is from the future`);
    }
    if (expiresAt.getTime() < new Date(subject.expiresAt).getTime()) {
      throw new Error(`[approval] ${role} expires before the transition decision`);
    }
    if (
      signedAt.getTime() < key.notBefore.getTime() ||
      expiresAt.getTime() > key.notAfter.getTime()
    ) {
      throw new Error(`[approval] ${role} signature is outside key validity`);
    }
    const signature = decodeBase64Url(
      approval.signatureBase64url,
      `[approval] ${role} signature`,
      64,
      64,
    );
    const message = ringTransitionApprovalMessage({
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
    validatedApprovals.push({
      role,
      keyId,
      publicKeySha256: key.publicKeySha256,
    });
  }
  return validatedApprovals;
}

function buildReviewOnlyPlan(candidate, transition, previousRingBaseline) {
  return {
    mode: "review-only",
    executionOrder: ["controller-first", "edge-second", "cutoff", "drain", "zero-value-cleanup"],
    controllerFirst: {
      configPath: "services/container-controller/wrangler.staging.jsonc",
      expectedVersionId: candidate.controllerWorkerVersionId,
      expectedPreviousVersionId:
        previousRingBaseline.controllerWorkerVersionId,
      previousDeploymentSetSha256:
        previousRingBaseline.controllerDeploymentSetSha256,
      expectedRuntimeBuildId: candidate.containerRuntimeBuildId,
      maxInstances: transition.maxInstances,
      authorityKeyId: transition.authorityKeyId,
      vars: {
        CONTAINER_RING_GENERATION: String(transition.currentRingGeneration),
        CONTAINER_SHARD_COUNT: String(transition.currentShardCount),
        CONTAINER_PREVIOUS_RING_GENERATION: String(transition.previousRingGeneration),
        CONTAINER_PREVIOUS_SHARD_COUNT: String(transition.previousShardCount),
        CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: String(
          transition.admissionStartedAtUnixSeconds,
        ),
        CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: String(
          transition.admissionUntilUnixSeconds,
        ),
      },
    },
    edgeSecond: {
      expectedVersionId: candidate.edgeWorkerVersionId,
      expectedPreviousVersionId: previousRingBaseline.edgeWorkerVersionId,
      previousDeploymentSetSha256:
        previousRingBaseline.edgeDeploymentSetSha256,
      ringGeneration: transition.currentRingGeneration,
      shardCount: transition.currentShardCount,
      routingKeyId: transition.routingKeyId,
      routingSecretMustRemainUnchanged: true,
      vars: {
        CONTAINER_SCHEDULER_RING_GENERATION: String(
          transition.currentRingGeneration,
        ),
        CONTAINER_SCHEDULER_SHARD_COUNT: String(
          transition.currentShardCount,
        ),
      },
    },
    cutoff: {
      admissionUntil: transition.admissionUntil,
      safetyMarginSeconds: transition.cutoffSafetyMarginSeconds,
      newPreviousRingClaimsMustFail: "previous_ring_admission_closed",
      exactReplayMustRemainReadable: true,
    },
    cleanup: {
      previousRingValuesMustReturnToZero: true,
      generationRollbackForbiddenAfterAdvance: true,
      goVpsRemainsTrafficRollbackAuthority: true,
    },
    executableDeployCommand: null,
  };
}

async function readCanonicalJson(file, label, maxBytes) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`[input] ${label} path is required`);
  }
  const resolved = path.resolve(file);
  const stats = await lstat(resolved, { bigint: true }).catch(() => null);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`[input] ${label} must be a regular non-symlink file`);
  }
  if (stats.nlink !== 1n) {
    throw new Error(`[input] ${label} must not be hard-linked`);
  }
  if (stats.size <= 0n || stats.size > BigInt(maxBytes)) {
    throw new Error(`[input] ${label} exceeds its byte bound`);
  }
  let handle;
  try {
    handle = await open(resolved, "r");
  } catch {
    throw new Error(`[input] ${label} could not be opened`);
  }
  let bytes;
  let openedRealPath;
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || !sameFileSnapshot(stats, openedStats)) {
      throw new Error(`[input] ${label} changed before it was opened`);
    }
    openedRealPath = await realpath(resolved);
    const realStats = await lstat(openedRealPath, { bigint: true });
    if (!sameFileIdentity(openedStats, realStats)) {
      throw new Error(`[input] ${label} real path changed before it was read`);
    }
    bytes = await handle.readFile();
    const afterStats = await handle.stat({ bigint: true });
    const finalStats = await lstat(resolved, { bigint: true }).catch(() => null);
    const finalRealPath = await realpath(resolved).catch(() => null);
    if (
      !finalStats ||
      !finalStats.isFile() ||
      finalStats.isSymbolicLink() ||
      finalStats.nlink !== 1n ||
      !sameFileSnapshot(openedStats, afterStats) ||
      !sameFileSnapshot(openedStats, finalStats) ||
      bytes.length !== Number(openedStats.size) ||
      finalRealPath !== openedRealPath
    ) {
      throw new Error(`[input] ${label} changed while it was read`);
    }
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`[input] ${label} must be valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`[input] ${label} must be valid JSON`);
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw new Error(`[input] ${label} must use canonical JSON plus one newline`);
  }
  return { resolved, realPath: openedRealPath, bytes, value };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
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

function decodeBase64Url(value, label, minimumBytes, maximumBytes) {
  if (typeof value !== "string" || !base64UrlPattern.test(value) || value.includes("=")) {
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
