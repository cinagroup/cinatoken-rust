import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_CONTRACT =
  "cinatoken-relay-container-p5-promotion-manifest-v3";
export const TRUST_POLICY_CONTRACT =
  "cinatoken-relay-container-p5-trust-policy-v1";
export const EVIDENCE_CONTRACT =
  "cinatoken-relay-container-p5-evidence-v2";
export const APPROVAL_DOMAIN =
  "cinatoken-relay-container-p5-approval-v2";
export const ADMISSION_FENCE_RAW_ARTIFACT_CONTRACT =
  "cinatoken-relay-container-p5-admission-fence-readback-v1";
export const ADMISSION_FENCE_CAPTURE_CONTRACT =
  "cinatoken-relay-container-p5-admission-fence-capture-v1";
export const FOUNDATION_CAPTURE_CONTRACT =
  "cinatoken-relay-container-p5-foundation-capture-v1";
export const FOUNDATION_COLLECTOR_VERSION = 6;

const FOUNDATION_READBACK_KEYS = Object.freeze([
  "edge-version",
  "edge-deployments",
  "controller-version",
  "controller-deployments",
  "provider-egress-version",
  "provider-egress-deployments",
  "d1-info",
  "r2-info",
  "kv-namespaces",
  "container-applications",
  "container-info",
  "container-instances",
  "container-deployments",
]);

export const REQUIRED_APPROVAL_ROLES = Object.freeze([
  "security",
  "finance",
  "operations",
  "product",
  "rollback",
]);

export const REQUIRED_EVIDENCE_KINDS = Object.freeze([
  "candidate-freeze",
  "remote-inventory",
  "reader-first-rollout",
  "schema-readback",
  "admission-fence",
  "lifecycle-fault-campaign",
  "response-financial-fault-campaign",
  "cross-layer-provenance",
  "load-cost-slo",
  "rollback-rehearsal",
  "security-privacy-review",
]);

export const REQUIRED_LIFECYCLE_SCENARIOS = Object.freeze([
  "cold_start",
  "warm_start",
  "do_eviction",
  "container_sleep",
  "container_restart",
  "container_oom",
  "duplicate_alarm",
  "callback_failure",
  "malformed_payload",
  "future_payload",
  "n_minus_1",
  "response_loss",
]);

export const REQUIRED_PROVENANCE_SEGMENTS = Object.freeze([
  "audit",
  "broker",
  "client",
  "container",
  "controller",
  "d1",
  "do",
  "edge",
  "financial",
  "provider",
  "r2",
]);

export const REQUIRED_ADMISSION_FENCE_ARTIFACT_PURPOSES = Object.freeze([
  "environment-binding",
  "schema-catalog",
  "migration-receipt",
  "backfill-rows",
  "writer-inventory",
  "initial-open-batch",
  "successful-admission-batch",
  "close-campaign-batch",
  "fault-campaign",
  "gate-readback",
  "rollback-readback",
]);

export const REQUIRED_DRAIN_WRITE_GATES = Object.freeze([
  "CONTAINER_DRAIN_CAMPAIGN_WRITE_ENABLED",
  "CONTAINER_DRAIN_OBSERVATION_WRITE_ENABLED",
  "CONTAINER_AMBIGUITY_QUARANTINE_WRITE_ENABLED",
  "CONTAINER_REVERSE_SYNC_MANIFEST_WRITE_ENABLED",
  "CONTAINER_TRAFFIC_RETURN_RECEIPT_WRITE_ENABLED",
]);

const REQUIRED_ADMISSION_FENCE_TABLES = Object.freeze([
  "relay_container_admission_fences",
  "relay_container_admission_scope_heads",
  "relay_container_admission_commits",
]);
const REQUIRED_ADMISSION_FENCE_INDEXES = Object.freeze([
  "idx_relay_container_admission_open_scope",
  "idx_relay_container_admission_fence_generation",
  "idx_relay_container_admission_commits_scope",
]);
const REQUIRED_ADMISSION_FENCE_TRIGGERS = Object.freeze([
  "relay_container_admission_fence_insert_guard",
  "relay_container_admission_fence_update_guard",
  "relay_container_admission_fence_delete_guard",
  "relay_container_admission_scope_head_insert_guard",
  "relay_container_admission_scope_head_update_guard",
  "relay_container_admission_scope_head_delete_guard",
  "relay_container_admission_commit_insert_guard",
  "relay_container_admission_commit_update_guard",
  "relay_container_admission_commit_delete_guard",
  "relay_container_atomic_admission_fence_guard",
  "relay_container_operation_admission_fence_guard",
  "relay_container_drain_campaign_admission_fence_guard",
  "relay_container_drain_campaign_source_identity_update_guard",
]);
const REQUIRED_ADMISSION_REJECTION_CASES = Object.freeze([
  "old-writer",
  "stale-generation",
  "late-admission",
  "recovery-required-reopen",
  "aborted-reopen",
]);
const REQUIRED_ADMISSION_REPLAY_CASES = Object.freeze([
  "process-loss",
  "d1-response-loss",
]);

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_FOUNDATION_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_ADMISSION_FENCE_BACKFILL_DURATION_MS = 25_000;
const MAX_ADMISSION_FENCE_SUPPORTING_LAG_SECONDS = 2 * 60 * 60;
const D1_STATEMENT_LIMIT_MS = 30_000;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_DECISION_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_EVIDENCE_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_FOUNDATION_OBSERVATION_SECONDS = 5 * 60;
const MAX_FOUNDATION_OBSERVATION_SECONDS = 2 * 60 * 60;
const MAX_FOUNDATION_EVIDENCE_LAG_SECONDS = 15 * 60;
const MIN_LOAD_DURATION_SECONDS = 3600;
const MIN_LOAD_REQUESTS = 1000;
const MAX_ROLLBACK_DURATION_SECONDS = 900;
const PINNED_GO_SOURCE_COMMIT =
  "73652508abc5cb09214dde02d51d69d1d1ccc703";
const PINNED_VIBE_SOURCE_COMMIT =
  "918e97480ee44e357abe99bf33c27259d6ac7ebd";
const EXPECTED_SCHEMA_MIGRATION_HEAD =
  "0073_relay_container_drain_source_authorization_consumption.sql";
const EXPECTED_SCHEMA_MIGRATION_COUNT = 73;
const EXPECTED_SCHEMA_TABLE_COUNT = 103;
const EXPECTED_SCHEMA_INCREMENTAL_COLUMN_COUNT = 1701;
const EXPECTED_SCHEMA_KEY_INDEX_COUNT = 156;
const IMMUTABLE_ADMISSION_FENCE_MIGRATION =
  "0068_relay_container_drain_admission_enforce.sql";
const IMMUTABLE_ADMISSION_FENCE_MIGRATION_SQL_SHA256 =
  "fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50";
const EXPECTED_PLACEMENT_STORAGE_MIGRATION =
  "0063_relay_container_shard_placement_mutation_authorizations.sql";
const GLOBAL_ADMISSION_SCOPE_ID_SHA256 =
  "53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251";

const sha256Pattern = /^[0-9a-f]{64}$/;
const gitCommitPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const resourceNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const bindingNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const classNamePattern = /^[A-Z][A-Za-z0-9]{0,63}$/;
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const relativeEvidencePathPattern = /^evidence\/[a-z0-9][a-z0-9-]{0,63}\.json$/;
const relativeFoundationCapturePathPattern =
  /^evidence\/foundation-capture\.json$/;
const relativeAdmissionFenceArtifactPathPattern =
  /^evidence\/admission-fence\/[a-z0-9][a-z0-9-]{0,63}\.json$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export async function verifyP5Bundle({
  manifestPath,
  trustPolicyPath,
  now = new Date(),
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("[time] verifier now must be a valid Date");
  }

  const manifestFile = await readCanonicalJson(
    manifestPath,
    "manifest",
    MAX_MANIFEST_BYTES,
  );
  const policyFile = await readCanonicalJson(
    trustPolicyPath,
    "trust policy",
    MAX_POLICY_BYTES,
  );
  const policy = validateTrustPolicy(policyFile.value, now);
  const manifest = validateManifestEnvelope(manifestFile.value);
  validateDecisionTime(manifest.subject, policy, now);
  validatePolicyBinding(manifest.subject, policy);

  const manifestRoot = path.dirname(manifestFile.realPath);
  const policyResolved = policyFile.realPath;
  if (policyResolved === manifestRoot || isWithin(manifestRoot, policyResolved)) {
    throw new Error("[policy] trust policy must be supplied outside the evidence bundle");
  }

  const candidate = validateP5Candidate(manifest.subject.candidate);
  const candidateDigestSha256 = p5CandidateDigestSha256(candidate);
  if (manifest.subject.candidateDigestSha256 !== candidateDigestSha256) {
    throw new Error("[candidate] candidate digest mismatch");
  }

  const foundationRecord = validateFoundationCaptureRecord(
    manifest.subject.foundationCapture,
  );
  const foundation = await readAndValidateFoundationCapture({
    record: foundationRecord,
    manifestRoot,
    candidate,
    candidateDigestSha256,
  });
  const cohort = validateCohort(
    manifest.subject.cohort,
    manifest.subject,
    policy,
    now,
  );
  const artifactRecords = validateArtifactRecords(manifest.subject.artifacts);
  const evidence = await readAndValidateEvidence({
    artifactRecords,
    manifestRoot,
    candidate,
    candidateDigestSha256,
    foundationCaptureSha256: foundation.binding.foundationCaptureSha256,
    subject: manifest.subject,
    policy,
    now,
  });
  validateEvidenceFoundationBinding(evidence, foundation);

  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(manifest.subject), "utf8"),
  );
  if (manifest.subjectDigestSha256 !== subjectDigestSha256) {
    throw new Error("[manifest] subject digest mismatch");
  }
  const approvalRoles = validateApprovals({
    approvals: manifest.approvals,
    subjectDigestSha256,
    subject: manifest.subject,
    policy,
    latestEvidenceAt: evidence.latestEvidenceAt,
    now,
  });

  return {
    ok: true,
    schemaVersion: 3,
    contract: MANIFEST_CONTRACT,
    decision: "eligible-for-isolated-staging-synthetic-canary-review",
    isolatedStagingSyntheticCanaryEligible: true,
    customerTrafficEligible: false,
    productionEligible: false,
    environment: "staging",
    repository: candidate.repository,
    commitSha: candidate.commitSha,
    candidateDigestSha256,
    subjectDigestSha256,
    policyId: policy.policyId,
    evidenceKinds: REQUIRED_EVIDENCE_KINDS,
    evidenceCount: evidence.items.length,
    latestEvidenceAt: evidence.latestEvidenceAt,
    foundationCaptureSha256: evidence.foundationCaptureSha256,
    foundationArtifactSha256: foundationRecord.sha256,
    admissionFenceCaptureIdSha256: evidence.admissionFenceCaptureIdSha256,
    admissionFenceIdSha256: evidence.admissionFenceIdSha256,
    drainCampaignIdSha256: evidence.drainCampaignIdSha256,
    approvalRoles,
    cohort: {
      kind: cohort.kind,
      route: cohort.route,
      maxOperations: cohort.maxOperations,
      windowStartsAt: cohort.windowStartsAt,
      windowEndsAt: cohort.windowEndsAt,
    },
    expiresAt: manifest.subject.expiresAt,
    safetyBoundary: {
      customerTraffic: false,
      productionCutover: false,
      remoteMutationPerformedByVerifier: false,
      credentialsReadByVerifier: false,
    },
  };
}

export function approvalMessage({
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
      APPROVAL_DOMAIN,
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

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateP5Candidate(value) {
  return validateCandidate(value);
}

export function p5CandidateDigestSha256(value) {
  return sha256Hex(
    Buffer.from(canonicalJson(validateP5Candidate(value)), "utf8"),
  );
}

export async function buildAdmissionFenceEvidence({
  bundleRoot,
  candidate,
  candidateDigestSha256,
  foundationCaptureSha256,
  capturedAt,
  expiresAt,
  facts,
}) {
  if (typeof bundleRoot !== "string" || bundleRoot.length === 0) {
    throw new Error("[admission-fence] bundle root is required");
  }
  const requestedRoot = path.resolve(bundleRoot);
  const rootStats = await lstat(requestedRoot).catch(() => null);
  if (
    !rootStats ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink()
  ) {
    throw new Error(
      "[admission-fence] bundle root must be a regular non-symlink directory",
    );
  }
  const manifestRoot = await realpath(requestedRoot);
  const validatedCandidate = validateP5Candidate(candidate);
  requireExact(
    candidateDigestSha256,
    p5CandidateDigestSha256(validatedCandidate),
    "[admission-fence] candidate digest",
  );
  requireSha256(
    foundationCaptureSha256,
    "[admission-fence] foundation capture digest",
  );
  const captured = requireTimestamp(
    capturedAt,
    "[admission-fence] capturedAt",
  );
  const expires = requireTimestamp(
    expiresAt,
    "[admission-fence] expiresAt",
  );
  if (captured.getTime() >= expires.getTime()) {
    throw new Error("[admission-fence] evidence validity window is empty");
  }
  const evidence = {
    schemaVersion: 2,
    contract: EVIDENCE_CONTRACT,
    kind: "admission-fence",
    environment: "staging",
    candidateDigestSha256,
    foundationCaptureSha256,
    capturedAt,
    expiresAt,
    status: "pass",
    facts,
  };
  const validation = validateAdmissionFence(
    facts,
    validatedCandidate,
    evidence,
  );
  const totalBytes =
    await readAndValidateAdmissionFenceSupportingArtifacts({
      records: validation.supportingArtifacts,
      manifestRoot,
      evidence,
      candidateDigestSha256,
      captureIdSha256: validation.captureIdSha256,
    });
  if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
    throw new Error("[admission-fence] supporting evidence exceeds its byte bound");
  }
  return evidence;
}

export function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("[canonical] numbers must be safe integers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) {
    throw new Error("[canonical] value must be JSON-compatible");
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalValue(value[key]);
  }
  return result;
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
  const expected = `${canonicalJson(value)}\n`;
  if (text !== expected) {
    throw new Error(`[input] ${label} must use canonical JSON plus one newline`);
  }
  return { resolved, realPath: openedRealPath, bytes, value };
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
  requireExact(policy.contract, TRUST_POLICY_CONTRACT, "[policy] contract");
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
    const publicKeySha256 = sha256Hex(der);
    if (publicKeyFingerprints.has(publicKeySha256)) {
      throw new Error("[policy] approval public keys must be cryptographically distinct");
    }
    publicKeyFingerprints.add(publicKeySha256);
    keys.set(keyId, {
      keyId,
      role,
      notBefore,
      notAfter,
      publicKey,
      publicKeySha256,
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

function validateManifestEnvelope(value) {
  const manifest = requireObject(value, "[manifest] manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "contract", "subject", "subjectDigestSha256", "approvals"],
    "[manifest] manifest",
  );
  requireExact(manifest.schemaVersion, 3, "[manifest] schemaVersion");
  requireExact(manifest.contract, MANIFEST_CONTRACT, "[manifest] contract");
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
      "foundationCapture",
      "cohort",
      "artifacts",
    ],
    "[manifest] subject",
  );
  return { ...manifest, subject };
}

function validateDecisionTime(subject, policy, now) {
  requireExact(subject.environment, "staging", "[manifest] environment");
  requireExact(
    subject.decision,
    "isolated-staging-synthetic-canary",
    "[manifest] decision",
  );
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
    throw new Error("[manifest] decision must fit the policy window");
  }
}

function validatePolicyBinding(subject, policy) {
  requireExact(subject.policyId, policy.policyId, "[manifest] policyId");
  requireExact(subject.environment, policy.environment, "[manifest] policy environment");
}

function validateCandidate(value) {
  const candidate = requireObject(value, "[candidate] candidate");
  exactKeys(
    candidate,
    [
      "repository",
      "commitSha",
      "goSourceCommit",
      "vibeSourceCommit",
      "edgeWorkerVersionId",
      "controllerWorkerVersionId",
      "providerEgressWorkerVersionId",
      "containerImageDigest",
      "containerRuntimeBuildId",
      "containerImageProvenanceSha256",
      "containerSbomSha256",
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
      "ringGeneration",
      "shardCount",
      "migrationHead",
      "migrationCount",
      "responseProtocolVersion",
      "statusContractVersion",
      "financialTerminalContractVersion",
      "terminalAckContractVersion",
    ],
    "[candidate] candidate",
  );
  requireExact(candidate.repository, "cinagroup/cinatoken-rust", "[candidate] repository");
  requireToken(candidate.commitSha, gitCommitPattern, "[candidate] commitSha");
  requireExact(candidate.goSourceCommit, PINNED_GO_SOURCE_COMMIT, "[candidate] Go source");
  requireExact(candidate.vibeSourceCommit, PINNED_VIBE_SOURCE_COMMIT, "[candidate] cinaVibeSDK source");
  for (const field of [
    "edgeWorkerVersionId",
    "controllerWorkerVersionId",
    "providerEgressWorkerVersionId",
  ]) {
    requireToken(candidate[field], opaqueIdPattern, `[candidate] ${field}`);
  }
  requireToken(candidate.containerImageDigest, imageDigestPattern, "[candidate] image digest");
  requireSha256(candidate.containerRuntimeBuildId, "[candidate] runtime build ID");
  requireSha256(
    candidate.containerImageProvenanceSha256,
    "[candidate] image provenance digest",
  );
  requireSha256(candidate.containerSbomSha256, "[candidate] SBOM digest");
  requireToken(candidate.d1DatabaseName, resourceNamePattern, "[candidate] D1 name");
  requireToken(candidate.d1DatabaseId, uuidPattern, "[candidate] D1 id");
  requireToken(candidate.r2BucketName, resourceNamePattern, "[candidate] R2 bucket");
  requireSha256(candidate.configKvNamespaceIdSha256, "[candidate] KV namespace digest");
  requireToken(candidate.controllerServiceName, resourceNamePattern, "[candidate] Controller service");
  requireToken(candidate.providerEgressServiceName, resourceNamePattern, "[candidate] egress service");
  requireSha256(candidate.doNamespaceIdSha256, "[candidate] DO namespace digest");
  requireToken(candidate.doBinding, bindingNamePattern, "[candidate] DO binding");
  requireToken(candidate.doClass, classNamePattern, "[candidate] DO class");
  requireToken(candidate.containerClass, classNamePattern, "[candidate] Container class");
  requireExact(candidate.doBinding, "RELAY_SHARDS", "[candidate] DO binding");
  requireExact(candidate.doClass, "RelayShardContainer", "[candidate] DO class");
  requireExact(candidate.containerClass, candidate.doClass, "[candidate] class alignment");
  requireInteger(candidate.ringGeneration, 1, 1_000_000, "[candidate] ring generation");
  requireInteger(candidate.shardCount, 1, 1024, "[candidate] shard count");
  requireExact(
    candidate.migrationHead,
    EXPECTED_SCHEMA_MIGRATION_HEAD,
    "[candidate] migration head",
  );
  requireExact(
    candidate.migrationCount,
    EXPECTED_SCHEMA_MIGRATION_COUNT,
    "[candidate] migration count",
  );
  requireExact(candidate.responseProtocolVersion, 3, "[candidate] response protocol");
  requireExact(candidate.statusContractVersion, 4, "[candidate] status contract");
  requireExact(candidate.financialTerminalContractVersion, 2, "[candidate] terminal contract");
  requireExact(candidate.terminalAckContractVersion, 3, "[candidate] ACK contract");
  return candidate;
}

function validateCohort(value, subject, policy, now) {
  const cohort = requireObject(value, "[cohort] cohort");
  exactKeys(
    cohort,
    [
      "kind",
      "route",
      "streaming",
      "customerTraffic",
      "maxOperations",
      "tokenScopeSha256",
      "modelScopeSha256",
      "channelScopeSha256",
      "windowStartsAt",
      "windowEndsAt",
    ],
    "[cohort] cohort",
  );
  requireExact(cohort.kind, "synthetic", "[cohort] kind");
  requireExact(cohort.route, "/v1/chat/completions", "[cohort] route");
  requireExact(cohort.streaming, false, "[cohort] streaming");
  requireExact(cohort.customerTraffic, false, "[cohort] customer traffic");
  requireInteger(cohort.maxOperations, 1, 1000, "[cohort] maxOperations");
  requireSha256(cohort.tokenScopeSha256, "[cohort] token scope");
  requireSha256(cohort.modelScopeSha256, "[cohort] model scope");
  requireSha256(cohort.channelScopeSha256, "[cohort] channel scope");
  const startsAt = requireTimestamp(cohort.windowStartsAt, "[cohort] windowStartsAt");
  const endsAt = requireTimestamp(cohort.windowEndsAt, "[cohort] windowEndsAt");
  if (startsAt.getTime() >= endsAt.getTime()) {
    throw new Error("[cohort] canary window is empty");
  }
  if (
    startsAt.getTime() < new Date(subject.generatedAt).getTime() ||
    endsAt.getTime() > new Date(subject.expiresAt).getTime()
  ) {
    throw new Error("[cohort] canary window must fit the signed decision window");
  }
  if (endsAt.getTime() <= now.getTime() - policy.maxClockSkewSeconds * 1000) {
    throw new Error("[cohort] canary window has elapsed");
  }
  return cohort;
}

function validateArtifactRecords(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_EVIDENCE_KINDS.length) {
    throw new Error(
      `[artifact] exactly ${REQUIRED_EVIDENCE_KINDS.length} evidence records are required`,
    );
  }
  const seenPaths = new Set();
  const records = value.map((raw, index) => {
    const record = requireObject(raw, "[artifact] record");
    exactKeys(
      record,
      ["kind", "path", "sha256", "bytes", "capturedAt", "expiresAt"],
      "[artifact] record",
    );
    requireExact(record.kind, REQUIRED_EVIDENCE_KINDS[index], "[artifact] kind order");
    const evidencePath = requireToken(
      record.path,
      relativeEvidencePathPattern,
      "[artifact] path",
    );
    if (seenPaths.has(evidencePath)) throw new Error("[artifact] duplicate path");
    seenPaths.add(evidencePath);
    requireSha256(record.sha256, "[artifact] sha256");
    requireInteger(record.bytes, 2, MAX_EVIDENCE_BYTES, "[artifact] bytes");
    requireTimestamp(record.capturedAt, "[artifact] capturedAt");
    requireTimestamp(record.expiresAt, "[artifact] expiresAt");
    return record;
  });
  return records;
}

function validateFoundationCaptureRecord(value) {
  const record = requireObject(value, "[foundation] capture record");
  exactKeys(
    record,
    ["path", "sha256", "bytes"],
    "[foundation] capture record",
  );
  requireToken(
    record.path,
    relativeFoundationCapturePathPattern,
    "[foundation] capture path",
  );
  requireSha256(record.sha256, "[foundation] capture artifact digest");
  requireInteger(
    record.bytes,
    2,
    MAX_FOUNDATION_CAPTURE_BYTES,
    "[foundation] capture bytes",
  );
  return record;
}

async function readAndValidateFoundationCapture({
  record,
  manifestRoot,
  candidate,
  candidateDigestSha256,
}) {
  const requested = path.resolve(manifestRoot, ...record.path.split("/"));
  const requestedStats = await lstat(requested).catch(() => null);
  if (!requestedStats || !requestedStats.isFile() || requestedStats.isSymbolicLink()) {
    throw new Error("[foundation] capture must be a regular non-symlink file");
  }
  const resolved = await realpath(requested).catch(() => null);
  if (!resolved || !isWithin(manifestRoot, resolved)) {
    throw new Error("[foundation] capture path escaped the bundle root");
  }
  const file = await readCanonicalJson(
    resolved,
    "foundation capture",
    MAX_FOUNDATION_CAPTURE_BYTES,
  );
  if (file.realPath !== resolved) {
    throw new Error("[foundation] capture path is not stable");
  }
  if (file.bytes.length !== record.bytes) {
    throw new Error("[foundation] capture byte count mismatch");
  }
  if (sha256Hex(file.bytes) !== record.sha256) {
    throw new Error("[foundation] capture artifact digest mismatch");
  }
  return validateFoundationCaptureReport(
    file.value,
    candidate,
    candidateDigestSha256,
  );
}

function validateFoundationCaptureReport(value, candidate, candidateDigestSha256) {
  const report = requireObject(value, "[foundation] capture");
  exactKeys(
    report,
    [
      "schemaVersion",
      "contract",
      "foundationCollectorVersion",
      "foundationCollectorSha256",
      "foundationCaptureSha256",
      "binding",
      "subject",
    ],
    "[foundation] capture",
  );
  requireExact(report.schemaVersion, 1, "[foundation] schemaVersion");
  requireExact(report.contract, FOUNDATION_CAPTURE_CONTRACT, "[foundation] contract");
  requireExact(
    report.foundationCollectorVersion,
    FOUNDATION_COLLECTOR_VERSION,
    "[foundation] collector version",
  );
  requireSha256(report.foundationCollectorSha256, "[foundation] collector digest");
  requireSha256(report.foundationCaptureSha256, "[foundation] subject digest");

  const subject = requireObject(report.subject, "[foundation] subject");
  exactKeys(
    subject,
    [
      "mode",
      "environment",
      "decision",
      "p5Eligible",
      "productionEligible",
      "customerTrafficEligible",
      "foundationEvidenceReady",
      "requestDigestSha256",
      "candidateDigestSha256",
      "candidate",
      "observationStartedAt",
      "observationEndedAt",
      "observationSeconds",
      "paginationComplete",
      "readbackStable",
      "before",
      "after",
      "sourceBundleDigestSha256",
      "sources",
      "artifactInventorySha256",
      "blockers",
      "evidenceFacts",
      "safetyBoundary",
    ],
    "[foundation] subject",
  );
  requireExact(subject.mode, "live-readback", "[foundation] mode");
  requireExact(subject.environment, "staging", "[foundation] environment");
  requireExact(subject.decision, "not-proven", "[foundation] decision");
  requireExact(subject.p5Eligible, false, "[foundation] P5 eligibility");
  requireExact(subject.productionEligible, false, "[foundation] production eligibility");
  requireExact(subject.customerTrafficEligible, false, "[foundation] customer traffic");
  requireExact(subject.foundationEvidenceReady, true, "[foundation] evidence readiness");
  requireSha256(subject.requestDigestSha256, "[foundation] request digest");
  requireExact(
    subject.candidateDigestSha256,
    candidateDigestSha256,
    "[foundation] candidate digest",
  );
  if (canonicalJson(subject.candidate) !== canonicalJson(candidate)) {
    throw new Error("[foundation] candidate mismatch");
  }
  const startedAt = requireTimestamp(
    subject.observationStartedAt,
    "[foundation] observationStartedAt",
  );
  const endedAt = requireTimestamp(
    subject.observationEndedAt,
    "[foundation] observationEndedAt",
  );
  const durationSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (
    durationSeconds < MIN_FOUNDATION_OBSERVATION_SECONDS ||
    durationSeconds > MAX_FOUNDATION_OBSERVATION_SECONDS
  ) {
    throw new Error("[foundation] observation window is invalid");
  }
  requireExact(
    subject.observationSeconds,
    Math.floor(durationSeconds),
    "[foundation] observation seconds",
  );
  requireExact(subject.paginationComplete, true, "[foundation] pagination completeness");
  requireExact(subject.readbackStable, true, "[foundation] readback stability");
  const before = validateFoundationReadback(subject.before, "before");
  const after = validateFoundationReadback(subject.after, "after");
  requireExact(after.digestSha256, before.digestSha256, "[foundation] readback digest");
  requireSha256(subject.sourceBundleDigestSha256, "[foundation] source bundle digest");
  validateFoundationSourceSummary(subject.sources, startedAt, endedAt);
  requireSha256(subject.artifactInventorySha256, "[foundation] artifact inventory digest");
  if (!Array.isArray(subject.blockers) || subject.blockers.length !== 0) {
    throw new Error("[foundation] blockers must be empty");
  }
  const evidenceFacts = requireObject(
    subject.evidenceFacts,
    "[foundation] evidence facts",
  );
  exactKeys(
    evidenceFacts,
    ["candidateFreeze", "remoteInventory"],
    "[foundation] evidence facts",
  );
  requireObject(evidenceFacts.candidateFreeze, "[foundation] candidate-freeze facts");
  requireObject(evidenceFacts.remoteInventory, "[foundation] remote-inventory facts");
  const freezeCampaign = validateShardActivationCampaignEvidence(
    evidenceFacts.candidateFreeze.shardActivationCampaign,
    candidate,
    "foundation candidate-freeze",
  );
  const inventoryCampaign = validateShardActivationCampaignEvidence(
    evidenceFacts.remoteInventory.shardActivationCampaign,
    candidate,
    "foundation remote-inventory",
  );
  if (canonicalJson(freezeCampaign) !== canonicalJson(inventoryCampaign)) {
    throw new Error("[foundation] facts must bind the same sealed activation campaign");
  }
  requireExact(
    evidenceFacts.candidateFreeze.artifactInventorySha256,
    subject.artifactInventorySha256,
    "[foundation] evidence inventory digest",
  );
  validateFoundationSafetyBoundary(subject.safetyBoundary);

  const recomputedCaptureSha256 = sha256Hex(
    Buffer.from(canonicalJson(subject), "utf8"),
  );
  requireExact(
    report.foundationCaptureSha256,
    recomputedCaptureSha256,
    "[foundation] subject digest",
  );
  const binding = validateFoundationCaptureBinding(report.binding, report, subject);
  return { binding, evidenceFacts };
}

export function validateFoundationReadback(value, label) {
  const readback = requireObject(value, `[foundation] ${label} readback`);
  exactKeys(
    readback,
    ["digestSha256", "complete", "paginationComplete", "stderrEmpty", "commands"],
    `[foundation] ${label} readback`,
  );
  requireSha256(readback.digestSha256, `[foundation] ${label} readback digest`);
  requireExact(readback.complete, true, `[foundation] ${label} completeness`);
  requireExact(
    readback.paginationComplete,
    true,
    `[foundation] ${label} pagination completeness`,
  );
  requireExact(readback.stderrEmpty, true, `[foundation] ${label} stderr`);
  if (
    !Array.isArray(readback.commands) ||
    readback.commands.length !== FOUNDATION_READBACK_KEYS.length ||
    readback.commands.some((item) => !isPlainObject(item))
  ) {
    throw new Error(`[foundation] ${label} command inventory is invalid`);
  }
  readback.commands.forEach((item, index) =>
    validateFoundationReadbackCommand(item, label, index),
  );
  requireExact(
    readback.digestSha256,
    sha256Hex(Buffer.from(canonicalJson(readback.commands), "utf8")),
    `[foundation] ${label} readback digest binding`,
  );
  return readback;
}

function validateFoundationReadbackCommand(command, label, index) {
  exactKeys(
    command,
    [
      "key",
      "status",
      "transport",
      "requestSha256",
      "outputSha256",
      "outputBytes",
      "stderrSha256",
      "stderrEmpty",
      "expectedValuesPresent",
      "expectedContainerImageDigestPresent",
      "itemCount",
      "paginationMode",
      "pageCount",
      "paginationEvidenceSha256",
      "paginationComplete",
    ],
    `[foundation] ${label} readback command`,
  );
  const key = FOUNDATION_READBACK_KEYS[index];
  requireExact(command.key, key, `[foundation] ${label} readback command key`);
  requireExact(command.status, "pass", `[foundation] ${label} command status`);
  requireExact(
    command.transport,
    "cloudflare-api",
    `[foundation] ${label} command transport`,
  );
  requireSha256(command.requestSha256, `[foundation] ${label} request digest`);
  requireSha256(command.outputSha256, `[foundation] ${label} output digest`);
  requireInteger(
    command.outputBytes,
    1,
    16 * 1024 * 1024,
    `[foundation] ${label} output bytes`,
  );
  requireExact(command.stderrSha256, null, `[foundation] ${label} stderr digest`);
  requireExact(command.stderrEmpty, true, `[foundation] ${label} diagnostics`);
  requireExact(
    command.expectedValuesPresent,
    true,
    `[foundation] ${label} expected identity`,
  );
  requireExact(
    command.expectedContainerImageDigestPresent,
    key === "container-info" || key === "container-deployments" ? true : null,
    `[foundation] ${label} image identity`,
  );
  requireInteger(
    command.itemCount,
    key === "container-instances" ? 0 : 1,
    100_000,
    `[foundation] ${label} item count`,
  );
  const expectedMode =
    key === "kv-namespaces"
      ? "page-number"
      : key === "container-applications" || key === "container-instances"
        ? "page-token"
        : "single-response";
  requireExact(
    command.paginationMode,
    expectedMode,
    `[foundation] ${label} pagination mode`,
  );
  requireInteger(
    command.pageCount,
    1,
    1_024,
    `[foundation] ${label} page count`,
  );
  requireSha256(
    command.paginationEvidenceSha256,
    `[foundation] ${label} pagination digest`,
  );
  requireExact(
    command.paginationComplete,
    true,
    `[foundation] ${label} pagination completeness`,
  );
}

function validateFoundationSourceSummary(value, startedAt, endedAt) {
  const sources = requireObject(value, "[foundation] source summary");
  exactKeys(
    sources,
    [
      "status",
      "capturedAt",
      "paginationComplete",
      "actionGates",
      "r2Inventory",
      "sbom",
      "shardRegistry",
      "traffic",
    ],
    "[foundation] source summary",
  );
  requireExact(sources.status, "provided", "[foundation] source status");
  const capturedAt = requireTimestamp(sources.capturedAt, "[foundation] source capturedAt");
  if (
    capturedAt.getTime() < startedAt.getTime() - 60_000 ||
    capturedAt.getTime() > endedAt.getTime() + 60_000
  ) {
    throw new Error("[foundation] source capture is outside the observation window");
  }
  requireExact(sources.paginationComplete, true, "[foundation] source pagination");
  for (const name of ["actionGates", "r2Inventory", "sbom", "shardRegistry", "traffic"]) {
    requireExact(sources[name], "pass", `[foundation] ${name} source`);
  }
}

function validateFoundationSafetyBoundary(value) {
  const boundary = requireObject(value, "[foundation] safety boundary");
  exactKeys(
    boundary,
    [
      "credentialsRead",
      "credentialValuesEmitted",
      "customerTrafficEligible",
      "deployOrRollbackExecuted",
      "networkReadbackPerformed",
      "p5Eligible",
      "productionEligible",
      "providerRequestPerformed",
      "remoteMutationPerformed",
      "shellExecuted",
      "sshOrContainerWakeExecuted",
      "writesFiles",
    ],
    "[foundation] safety boundary",
  );
  requireExact(boundary.credentialsRead, true, "[foundation] credentials read");
  requireExact(boundary.networkReadbackPerformed, true, "[foundation] network readback");
  for (const name of [
    "credentialValuesEmitted",
    "customerTrafficEligible",
    "deployOrRollbackExecuted",
    "p5Eligible",
    "productionEligible",
    "providerRequestPerformed",
    "remoteMutationPerformed",
    "shellExecuted",
    "sshOrContainerWakeExecuted",
    "writesFiles",
  ]) {
    requireExact(boundary[name], false, `[foundation] ${name}`);
  }
}

function validateFoundationCaptureBinding(value, report, subject) {
  const binding = requireObject(value, "[foundation] binding");
  exactKeys(
    binding,
    [
      "foundationCaptureContract",
      "foundationCollectorVersion",
      "foundationCollectorSha256",
      "observationStartedAt",
      "observationEndedAt",
      "paginationComplete",
      "foundationCaptureSha256",
    ],
    "[foundation] binding",
  );
  requireExact(
    binding.foundationCaptureContract,
    report.contract,
    "[foundation] binding contract",
  );
  requireExact(
    binding.foundationCollectorVersion,
    report.foundationCollectorVersion,
    "[foundation] binding collector version",
  );
  requireExact(
    binding.foundationCollectorSha256,
    report.foundationCollectorSha256,
    "[foundation] binding collector digest",
  );
  requireExact(
    binding.foundationCaptureSha256,
    report.foundationCaptureSha256,
    "[foundation] binding subject digest",
  );
  requireExact(
    binding.observationStartedAt,
    subject.observationStartedAt,
    "[foundation] binding observation start",
  );
  requireExact(
    binding.observationEndedAt,
    subject.observationEndedAt,
    "[foundation] binding observation end",
  );
  requireExact(
    binding.paginationComplete,
    subject.paginationComplete,
    "[foundation] binding pagination",
  );
  return binding;
}

async function readAndValidateEvidence({
  artifactRecords,
  manifestRoot,
  candidate,
  candidateDigestSha256,
  foundationCaptureSha256,
  subject,
  policy,
  now,
}) {
  let totalBytes = 0;
  let latestEvidenceAt = 0;
  const items = [];
  const foundationBindings = new Map();
  const foundationFacts = new Map();
  const factsByKind = new Map();
  for (const record of artifactRecords) {
    const requested = path.resolve(manifestRoot, ...record.path.split("/"));
    const requestedStats = await lstat(requested).catch(() => null);
    if (!requestedStats || !requestedStats.isFile() || requestedStats.isSymbolicLink()) {
      throw new Error(`[artifact] ${record.kind} must be a regular non-symlink file`);
    }
    const resolved = await realpath(requested).catch(() => null);
    if (!resolved || !isWithin(manifestRoot, resolved)) {
      throw new Error(`[artifact] ${record.kind} path escaped the bundle root`);
    }
    const file = await readCanonicalJson(resolved, `${record.kind} evidence`, MAX_EVIDENCE_BYTES);
    if (file.realPath !== resolved) {
      throw new Error(`[artifact] ${record.kind} path is not stable`);
    }
    totalBytes += file.bytes.length;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new Error("[artifact] total evidence exceeds its byte bound");
    }
    if (file.bytes.length !== record.bytes) {
      throw new Error(`[artifact] ${record.kind} byte count mismatch`);
    }
    if (sha256Hex(file.bytes) !== record.sha256) {
      throw new Error(`[artifact] ${record.kind} digest mismatch`);
    }
    const evidence = validateEvidenceEnvelope(file.value, record.kind);
    requireExact(evidence.environment, subject.environment, `[${record.kind}] environment`);
    requireExact(
      evidence.candidateDigestSha256,
      candidateDigestSha256,
      `[${record.kind}] candidate digest`,
    );
    requireExact(
      evidence.foundationCaptureSha256,
      foundationCaptureSha256,
      `[${record.kind}] foundation capture digest`,
    );
    requireExact(evidence.capturedAt, record.capturedAt, `[${record.kind}] capturedAt`);
    requireExact(evidence.expiresAt, record.expiresAt, `[${record.kind}] expiresAt`);
    const capturedAt = requireTimestamp(evidence.capturedAt, `[${record.kind}] capturedAt`);
    const expiresAt = requireTimestamp(evidence.expiresAt, `[${record.kind}] expiresAt`);
    if (capturedAt.getTime() >= expiresAt.getTime()) {
      throw new Error(`[${record.kind}] evidence validity window is empty`);
    }
    if (capturedAt.getTime() > new Date(subject.generatedAt).getTime()) {
      throw new Error(`[${record.kind}] evidence was captured after manifest generation`);
    }
    const skewMs = policy.maxClockSkewSeconds * 1000;
    if (capturedAt.getTime() > now.getTime() + skewMs) {
      throw new Error(`[${record.kind}] evidence is from the future`);
    }
    if (now.getTime() - capturedAt.getTime() > MAX_EVIDENCE_AGE_SECONDS * 1000) {
      throw new Error(`[${record.kind}] evidence is stale`);
    }
    if (expiresAt.getTime() < new Date(subject.expiresAt).getTime()) {
      throw new Error(`[${record.kind}] evidence expires before the decision`);
    }
    const validation = validateEvidenceFacts(
      record.kind,
      evidence.facts,
      candidate,
      evidence,
    );
    if (validation?.supportingArtifacts) {
      totalBytes += await readAndValidateAdmissionFenceSupportingArtifacts({
        records: validation.supportingArtifacts,
        manifestRoot,
        evidence,
        candidateDigestSha256,
        captureIdSha256: validation.captureIdSha256,
      });
      if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
        throw new Error("[artifact] total evidence exceeds its byte bound");
      }
    }
    if (validation?.foundationBinding) {
      foundationBindings.set(record.kind, validation.foundationBinding);
      foundationFacts.set(record.kind, evidence.facts);
    }
    factsByKind.set(record.kind, evidence.facts);
    latestEvidenceAt = Math.max(latestEvidenceAt, capturedAt.getTime());
    items.push({ kind: record.kind, capturedAt: evidence.capturedAt });
  }
  const candidateFreezeFoundation = foundationBindings.get("candidate-freeze");
  const remoteInventoryFoundation = foundationBindings.get("remote-inventory");
  if (
    !candidateFreezeFoundation ||
    !remoteInventoryFoundation ||
    canonicalJson(candidateFreezeFoundation) !== canonicalJson(remoteInventoryFoundation)
  ) {
    throw new Error(
      "[foundation] candidate-freeze and remote-inventory must bind the same capture",
    );
  }
  const admissionBinding = validateAdmissionFenceCrossEvidence({
    admission: factsByKind.get("admission-fence"),
    rollback: factsByKind.get("rollback-rehearsal"),
    schema: factsByKind.get("schema-readback"),
    remoteInventory: factsByKind.get("remote-inventory"),
    candidate,
  });
  return {
    items,
    latestEvidenceAt: new Date(latestEvidenceAt).toISOString(),
    foundationCaptureSha256: candidateFreezeFoundation.foundationCaptureSha256,
    foundationBinding: candidateFreezeFoundation,
    candidateFreezeFacts: foundationFacts.get("candidate-freeze"),
    remoteInventoryFacts: foundationFacts.get("remote-inventory"),
    admissionFenceCaptureIdSha256: admissionBinding.captureIdSha256,
    admissionFenceIdSha256: admissionBinding.fenceIdSha256,
    drainCampaignIdSha256: admissionBinding.campaignIdSha256,
  };
}

function validateEvidenceFoundationBinding(evidence, foundation) {
  if (
    canonicalJson(evidence.foundationBinding) !== canonicalJson(foundation.binding)
  ) {
    throw new Error("[foundation] evidence does not bind the capture artifact");
  }
  for (const [label, actual, expected] of [
    [
      "candidate-freeze",
      evidence.candidateFreezeFacts,
      foundation.evidenceFacts.candidateFreeze,
    ],
    [
      "remote-inventory",
      evidence.remoteInventoryFacts,
      foundation.evidenceFacts.remoteInventory,
    ],
  ]) {
    const facts = { ...requireObject(actual, `[${label}] facts`) };
    for (const field of [
      "foundationCaptureContract",
      "foundationCaptureSha256",
      "foundationCollectorVersion",
      "foundationCollectorSha256",
      "observationStartedAt",
      "observationEndedAt",
      "paginationComplete",
    ]) {
      delete facts[field];
    }
    if (canonicalJson(facts) !== canonicalJson(expected)) {
      throw new Error(`[foundation] ${label} facts do not match the capture artifact`);
    }
  }
}

function validateEvidenceEnvelope(value, expectedKind) {
  const evidence = requireObject(value, `[${expectedKind}] evidence`);
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "contract",
      "kind",
      "environment",
      "candidateDigestSha256",
      "foundationCaptureSha256",
      "capturedAt",
      "expiresAt",
      "status",
      "facts",
    ],
    `[${expectedKind}] evidence`,
  );
  requireExact(evidence.schemaVersion, 2, `[${expectedKind}] schemaVersion`);
  requireExact(evidence.contract, EVIDENCE_CONTRACT, `[${expectedKind}] contract`);
  requireExact(evidence.kind, expectedKind, `[${expectedKind}] kind`);
  requireSha256(
    evidence.foundationCaptureSha256,
    `[${expectedKind}] foundation capture digest`,
  );
  requireExact(evidence.status, "pass", `[${expectedKind}] status`);
  requireObject(evidence.facts, `[${expectedKind}] facts`);
  return evidence;
}

function validateEvidenceFacts(kind, facts, candidate, evidence) {
  switch (kind) {
    case "candidate-freeze":
      return validateCandidateFreeze(facts, candidate, evidence);
    case "remote-inventory":
      return validateRemoteInventory(facts, candidate, evidence);
    case "reader-first-rollout":
      return validateReaderFirst(facts, candidate);
    case "schema-readback":
      return validateSchemaReadback(facts);
    case "admission-fence":
      return validateAdmissionFence(facts, candidate, evidence);
    case "lifecycle-fault-campaign":
      return validateLifecycleFaults(facts);
    case "response-financial-fault-campaign":
      return validateResponseFinancialFaults(facts);
    case "cross-layer-provenance":
      return validateCrossLayerProvenance(facts);
    case "load-cost-slo":
      return validateLoadCostSlo(facts);
    case "rollback-rehearsal":
      return validateRollbackRehearsal(facts);
    case "security-privacy-review":
      return validateSecurityPrivacy(facts);
    default:
      throw new Error(`[artifact] unsupported evidence kind: ${kind}`);
  }
}

function validateCandidateFreeze(facts, candidate, evidence) {
  exactKeys(
    facts,
    [
      "repositoryCommit",
      "goSourceCommit",
      "vibeSourceCommit",
      "edgeWorkerVersionId",
      "controllerWorkerVersionId",
      "providerEgressWorkerVersionId",
      "containerImageDigest",
      "containerRuntimeBuildId",
      "containerImageProvenanceSha256",
      "containerSbomSha256",
      "containerSignatureVerified",
      "runtimeImageProvenanceVerified",
      "unapprovedCriticalVulnerabilities",
      "unapprovedHighVulnerabilities",
      "allActionGatesFalse",
      "shardActivationCampaign",
      "artifactInventorySha256",
      "foundationCaptureContract",
      "foundationCaptureSha256",
      "foundationCollectorVersion",
      "foundationCollectorSha256",
      "observationStartedAt",
      "observationEndedAt",
      "paginationComplete",
    ],
    "[candidate-freeze] facts",
  );
  const matches = [
    ["repositoryCommit", "commitSha"],
    ["goSourceCommit", "goSourceCommit"],
    ["vibeSourceCommit", "vibeSourceCommit"],
    ["edgeWorkerVersionId", "edgeWorkerVersionId"],
    ["controllerWorkerVersionId", "controllerWorkerVersionId"],
    ["providerEgressWorkerVersionId", "providerEgressWorkerVersionId"],
    ["containerImageDigest", "containerImageDigest"],
    ["containerRuntimeBuildId", "containerRuntimeBuildId"],
    ["containerImageProvenanceSha256", "containerImageProvenanceSha256"],
    ["containerSbomSha256", "containerSbomSha256"],
  ];
  for (const [factField, candidateField] of matches) {
    requireExact(facts[factField], candidate[candidateField], `[candidate-freeze] ${factField}`);
  }
  requireExact(facts.containerSignatureVerified, true, "[candidate-freeze] signature");
  requireExact(
    facts.runtimeImageProvenanceVerified,
    true,
    "[candidate-freeze] runtime/image provenance",
  );
  requireExact(facts.unapprovedCriticalVulnerabilities, 0, "[candidate-freeze] critical vulnerabilities");
  requireExact(facts.unapprovedHighVulnerabilities, 0, "[candidate-freeze] high vulnerabilities");
  requireExact(facts.allActionGatesFalse, true, "[candidate-freeze] action gates");
  validateShardActivationCampaignEvidence(
    facts.shardActivationCampaign,
    candidate,
    "candidate-freeze",
  );
  requireSha256(facts.artifactInventorySha256, "[candidate-freeze] inventory digest");
  return {
    foundationBinding: validateFoundationBinding(
      facts,
      evidence,
      "candidate-freeze",
    ),
  };
}

function validateRemoteInventory(facts, candidate, evidence) {
  exactKeys(
    facts,
    [
      "accountIdSha256",
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
      "containerRuntimeBuildId",
      "containerImageProvenanceSha256",
      "ringGeneration",
      "shardCount",
      "verifiedShardCount",
      "shardActivationCampaign",
      "unknownWriterCount",
      "unknownObjectCount",
      "customerTrafficCount",
      "environmentIsolationVerified",
      "foundationCaptureContract",
      "foundationCaptureSha256",
      "foundationCollectorVersion",
      "foundationCollectorSha256",
      "observationStartedAt",
      "observationEndedAt",
      "paginationComplete",
    ],
    "[remote-inventory] facts",
  );
  requireSha256(facts.accountIdSha256, "[remote-inventory] account digest");
  for (const field of [
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
    "containerRuntimeBuildId",
    "containerImageProvenanceSha256",
    "ringGeneration",
    "shardCount",
  ]) {
    requireExact(facts[field], candidate[field], `[remote-inventory] ${field}`);
  }
  requireExact(facts.verifiedShardCount, candidate.shardCount, "[remote-inventory] verified shards");
  validateShardActivationCampaignEvidence(
    facts.shardActivationCampaign,
    candidate,
    "remote-inventory",
  );
  requireExact(facts.unknownWriterCount, 0, "[remote-inventory] unknown writers");
  requireExact(facts.unknownObjectCount, 0, "[remote-inventory] unknown objects");
  requireExact(facts.customerTrafficCount, 0, "[remote-inventory] customer traffic");
  requireExact(facts.environmentIsolationVerified, true, "[remote-inventory] environment isolation");
  return {
    foundationBinding: validateFoundationBinding(
      facts,
      evidence,
      "remote-inventory",
    ),
  };
}

function validateShardActivationCampaignEvidence(value, candidate, label) {
  const campaign = requireObject(value, `[${label}] shard activation campaign`);
  exactKeys(
    campaign,
    [
      "campaignContract",
      "state",
      "campaignId",
      "campaignDigestSha256",
      "controllerVersionId",
      "actionGateInventorySha256",
      "actionGateCount",
      "allActionGatesFalse",
      "foundationManifestSha256",
      "runtimeBuildId",
      "ringGeneration",
      "shardCount",
      "shardContractVersion",
      "runtimeProtocolVersion",
      "runtimeContractVersion",
      "activationGeneration",
      "environment",
      "claimedShardCount",
      "consumedShardCount",
      "sealReason",
      "sealDetailCode",
      "lastConsumptionDigestSha256",
      "sealedAt",
      "receiptCount",
      "receiptSetSha256",
      "placementMutationAuthorization",
    ],
    `[${label}] shard activation campaign`,
  );
  requireExact(
    campaign.campaignContract,
    "cinatoken-relay-container-shard-activation-campaign-v1",
    `[${label}] campaign contract`,
  );
  requireExact(campaign.state, "sealed_complete", `[${label}] campaign state`);
  requireSha256(campaign.campaignId, `[${label}] campaign ID`);
  requireSha256(campaign.campaignDigestSha256, `[${label}] campaign digest`);
  requireExact(
    campaign.controllerVersionId,
    candidate.controllerWorkerVersionId,
    `[${label}] campaign Controller version`,
  );
  requireSha256(
    campaign.actionGateInventorySha256,
    `[${label}] action gate inventory digest`,
  );
  requireExact(campaign.actionGateCount, 22, `[${label}] action gate count`);
  requireExact(campaign.allActionGatesFalse, true, `[${label}] action gate state`);
  requireSha256(
    campaign.foundationManifestSha256,
    `[${label}] foundation manifest digest`,
  );
  requireExact(
    campaign.runtimeBuildId,
    candidate.containerRuntimeBuildId,
    `[${label}] campaign runtime build`,
  );
  requireExact(
    campaign.ringGeneration,
    candidate.ringGeneration,
    `[${label}] campaign ring generation`,
  );
  requireExact(campaign.shardCount, candidate.shardCount, `[${label}] campaign shard count`);
  requireExact(campaign.shardContractVersion, 1, `[${label}] shard contract`);
  requireExact(campaign.runtimeProtocolVersion, 1, `[${label}] runtime protocol`);
  requireExact(campaign.runtimeContractVersion, 1, `[${label}] runtime contract`);
  requireExact(campaign.activationGeneration, 1, `[${label}] activation generation`);
  requireExact(campaign.environment, "staging", `[${label}] campaign environment`);
  requireExact(
    campaign.claimedShardCount,
    candidate.shardCount,
    `[${label}] claimed shard count`,
  );
  requireExact(
    campaign.consumedShardCount,
    candidate.shardCount,
    `[${label}] consumed shard count`,
  );
  requireExact(campaign.sealReason, "complete", `[${label}] campaign seal reason`);
  requireExact(
    campaign.sealDetailCode,
    "all_shards_consumed",
    `[${label}] campaign seal detail`,
  );
  requireSha256(
    campaign.lastConsumptionDigestSha256,
    `[${label}] last consumption digest`,
  );
  requireInteger(campaign.sealedAt, 1, Number.MAX_SAFE_INTEGER, `[${label}] sealed timestamp`);
  requireExact(campaign.receiptCount, candidate.shardCount, `[${label}] receipt count`);
  requireSha256(campaign.receiptSetSha256, `[${label}] receipt set digest`);
  validatePlacementMutationAuthorizationEvidence(
    campaign.placementMutationAuthorization,
    campaign,
    candidate,
    label,
  );
  return campaign;
}

function validatePlacementMutationAuthorizationEvidence(
  value,
  campaign,
  candidate,
  label,
) {
  const authorization = requireObject(
    value,
    `[${label}] placement mutation authorization`,
  );
  exactKeys(
    authorization,
    [
      "storageMigration",
      "contractVersion",
      "authorizationContract",
      "authorizationIdSha256",
      "executionNonceSha256",
      "campaignNonceSha256",
      "subjectDigestSha256",
      "issuer",
      "keyId",
      "signerSpkiSha256",
      "environment",
      "controllerServiceName",
      "controllerVersionId",
      "actionGateInventorySha256",
      "foundationManifestSha256",
      "runtimeBuildId",
      "ringGeneration",
      "shardCount",
      "campaignLifetimeSeconds",
      "permitIssuedAt",
      "permitExpiresAt",
      "campaignId",
      "campaignDigestSha256",
      "campaignExpiresAt",
      "consumedByAdminId",
      "consumedAt",
      "rowSha256",
    ],
    `[${label}] placement mutation authorization`,
  );
  requireExact(
    authorization.storageMigration,
    EXPECTED_PLACEMENT_STORAGE_MIGRATION,
    `[${label}] placement authorization storage migration`,
  );
  requireExact(
    authorization.contractVersion,
    1,
    `[${label}] placement authorization contract version`,
  );
  requireExact(
    authorization.authorizationContract,
    "cinatoken-relay-shard-placement-mutation-authorization-v1",
    `[${label}] placement authorization contract`,
  );
  for (const [field, fieldLabel] of [
    ["authorizationIdSha256", "authorization ID"],
    ["executionNonceSha256", "execution nonce digest"],
    ["campaignNonceSha256", "campaign nonce digest"],
    ["subjectDigestSha256", "subject digest"],
    ["signerSpkiSha256", "signer SPKI digest"],
    ["actionGateInventorySha256", "action gate inventory digest"],
    ["foundationManifestSha256", "foundation manifest digest"],
    ["runtimeBuildId", "runtime build ID"],
    ["campaignId", "campaign ID"],
    ["campaignDigestSha256", "campaign digest"],
    ["rowSha256", "row digest"],
  ]) {
    requireSha256(
      authorization[field],
      `[${label}] placement authorization ${fieldLabel}`,
    );
  }
  if (
    new Set([
      authorization.authorizationIdSha256,
      authorization.executionNonceSha256,
      authorization.campaignNonceSha256,
    ]).size !== 3
  ) {
    throw new Error(
      `[${label}] placement authorization identity digests are not distinct`,
    );
  }
  requireToken(
    authorization.issuer,
    opaqueIdPattern,
    `[${label}] placement authorization issuer`,
  );
  requireToken(
    authorization.keyId,
    keyIdPattern,
    `[${label}] placement authorization key ID`,
  );
  requireExact(
    authorization.environment,
    "staging",
    `[${label}] placement authorization environment`,
  );
  requireExact(
    authorization.controllerServiceName,
    candidate.controllerServiceName,
    `[${label}] placement authorization Controller service`,
  );
  requireExact(
    authorization.controllerVersionId,
    campaign.controllerVersionId,
    `[${label}] placement authorization Controller version`,
  );
  requireExact(
    authorization.actionGateInventorySha256,
    campaign.actionGateInventorySha256,
    `[${label}] placement authorization action gates`,
  );
  requireExact(
    authorization.foundationManifestSha256,
    campaign.foundationManifestSha256,
    `[${label}] placement authorization foundation manifest`,
  );
  requireExact(
    authorization.runtimeBuildId,
    campaign.runtimeBuildId,
    `[${label}] placement authorization runtime build`,
  );
  requireExact(
    authorization.ringGeneration,
    campaign.ringGeneration,
    `[${label}] placement authorization ring generation`,
  );
  requireExact(
    authorization.shardCount,
    campaign.shardCount,
    `[${label}] placement authorization shard count`,
  );
  requireExact(
    authorization.campaignId,
    campaign.campaignId,
    `[${label}] placement authorization campaign ID`,
  );
  requireExact(
    authorization.campaignDigestSha256,
    campaign.campaignDigestSha256,
    `[${label}] placement authorization campaign digest`,
  );
  requireInteger(
    authorization.campaignLifetimeSeconds,
    60,
    3_600,
    `[${label}] placement authorization campaign lifetime`,
  );
  for (const [field, fieldLabel] of [
    ["permitIssuedAt", "permit issued timestamp"],
    ["permitExpiresAt", "permit expiry timestamp"],
    ["campaignExpiresAt", "campaign expiry timestamp"],
    ["consumedAt", "consumption timestamp"],
  ]) {
    requireInteger(
      authorization[field],
      1,
      Number.MAX_SAFE_INTEGER,
      `[${label}] placement authorization ${fieldLabel}`,
    );
  }
  requireInteger(
    authorization.consumedByAdminId,
    1,
    Number.MAX_SAFE_INTEGER,
    `[${label}] placement authorization admin ID`,
  );
  if (
    authorization.permitExpiresAt < authorization.permitIssuedAt + 60 ||
    authorization.permitExpiresAt > authorization.permitIssuedAt + 600 ||
    authorization.permitIssuedAt > authorization.consumedAt + 120 ||
    authorization.permitExpiresAt < authorization.consumedAt + 60
  ) {
    throw new Error(`[${label}] placement authorization permit window is invalid`);
  }
  const campaignCreatedAt =
    authorization.campaignExpiresAt -
    authorization.campaignLifetimeSeconds;
  if (
    Math.abs(authorization.consumedAt - campaignCreatedAt) > 5 ||
    campaign.sealedAt < campaignCreatedAt ||
    campaign.sealedAt > authorization.campaignExpiresAt
  ) {
    throw new Error(
      `[${label}] placement authorization campaign timing is invalid`,
    );
  }
  const row = {
    authorization_id_sha256: authorization.authorizationIdSha256,
    execution_nonce_sha256: authorization.executionNonceSha256,
    campaign_nonce_sha256: authorization.campaignNonceSha256,
    subject_digest_sha256: authorization.subjectDigestSha256,
    contract_version: authorization.contractVersion,
    authorization_contract: authorization.authorizationContract,
    issuer: authorization.issuer,
    key_id: authorization.keyId,
    signer_spki_sha256: authorization.signerSpkiSha256,
    environment: authorization.environment,
    controller_service_name: authorization.controllerServiceName,
    controller_version_id: authorization.controllerVersionId,
    action_gate_inventory_sha256:
      authorization.actionGateInventorySha256,
    foundation_manifest_sha256: authorization.foundationManifestSha256,
    runtime_build_id: authorization.runtimeBuildId,
    ring_generation: authorization.ringGeneration,
    shard_count: authorization.shardCount,
    campaign_lifetime_seconds: authorization.campaignLifetimeSeconds,
    permit_issued_at: authorization.permitIssuedAt,
    permit_expires_at: authorization.permitExpiresAt,
    campaign_id: authorization.campaignId,
    campaign_digest_sha256: authorization.campaignDigestSha256,
    campaign_expires_at: authorization.campaignExpiresAt,
    consumed_by_admin_id: authorization.consumedByAdminId,
    consumed_at: authorization.consumedAt,
  };
  requireExact(
    authorization.rowSha256,
    sha256Hex(Buffer.from(canonicalJson(row), "utf8")),
    `[${label}] placement authorization row digest`,
  );
  return authorization;
}

function validateFoundationBinding(facts, evidence, label) {
  requireExact(
    facts.foundationCaptureContract,
    FOUNDATION_CAPTURE_CONTRACT,
    `[${label}] foundation capture contract`,
  );
  requireExact(
    facts.foundationCollectorVersion,
    FOUNDATION_COLLECTOR_VERSION,
    `[${label}] foundation collector version`,
  );
  requireSha256(
    facts.foundationCaptureSha256,
    `[${label}] foundation capture digest`,
  );
  requireSha256(
    facts.foundationCollectorSha256,
    `[${label}] foundation collector digest`,
  );
  requireExact(facts.paginationComplete, true, `[${label}] pagination completeness`);
  const startedAt = requireTimestamp(
    facts.observationStartedAt,
    `[${label}] observationStartedAt`,
  );
  const endedAt = requireTimestamp(
    facts.observationEndedAt,
    `[${label}] observationEndedAt`,
  );
  const durationSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (
    durationSeconds < MIN_FOUNDATION_OBSERVATION_SECONDS ||
    durationSeconds > MAX_FOUNDATION_OBSERVATION_SECONDS
  ) {
    throw new Error(`[${label}] foundation observation window is invalid`);
  }
  if (endedAt.getTime() > new Date(evidence.capturedAt).getTime()) {
    throw new Error(`[${label}] foundation observation ended after evidence capture`);
  }
  if (
    new Date(evidence.capturedAt).getTime() - endedAt.getTime() >
    MAX_FOUNDATION_EVIDENCE_LAG_SECONDS * 1000
  ) {
    throw new Error(`[${label}] foundation observation is stale for evidence capture`);
  }
  return {
    foundationCaptureContract: facts.foundationCaptureContract,
    foundationCaptureSha256: facts.foundationCaptureSha256,
    foundationCollectorVersion: facts.foundationCollectorVersion,
    foundationCollectorSha256: facts.foundationCollectorSha256,
    observationStartedAt: facts.observationStartedAt,
    observationEndedAt: facts.observationEndedAt,
    paginationComplete: facts.paginationComplete,
  };
}

function validateReaderFirst(facts, candidate) {
  exactKeys(
    facts,
    [
      "providerEgressDeployedBeforeController",
      "controllerDeployedBeforeEdge",
      "readersDeployedBeforeWriters",
      "activeShardCount",
      "verifiedShardCount",
      "legacyReaderShardCount",
      "unknownShardCount",
      "newResponseWriteCount",
      "allActionGatesFalse",
      "publicInternalRouteStatus",
      "mixedVersionMode",
      "versionSkewFaultsPassed",
      "serviceBindingVersionPinned",
    ],
    "[reader-first-rollout] facts",
  );
  for (const field of [
    "providerEgressDeployedBeforeController",
    "controllerDeployedBeforeEdge",
    "readersDeployedBeforeWriters",
    "allActionGatesFalse",
    "versionSkewFaultsPassed",
    "serviceBindingVersionPinned",
  ]) {
    requireExact(facts[field], true, `[reader-first-rollout] ${field}`);
  }
  requireExact(facts.activeShardCount, candidate.shardCount, "[reader-first-rollout] active shards");
  requireExact(facts.verifiedShardCount, candidate.shardCount, "[reader-first-rollout] verified shards");
  requireExact(facts.legacyReaderShardCount, 0, "[reader-first-rollout] legacy readers");
  requireExact(facts.unknownShardCount, 0, "[reader-first-rollout] unknown shards");
  requireExact(facts.newResponseWriteCount, 0, "[reader-first-rollout] new writes");
  requireExact(facts.publicInternalRouteStatus, 404, "[reader-first-rollout] public internal route");
  requireEnum(facts.mixedVersionMode, ["n-n-1", "blue-green"], "[reader-first-rollout] mixed version mode");
}

function validateSchemaReadback(facts) {
  exactKeys(
    facts,
    [
      "migrationHead",
      "migrationCount",
      "tableCount",
      "incrementalColumnCount",
      "keyIndexCount",
      "schemaFingerprintSha256",
      "businessFingerprintBeforeSha256",
      "businessFingerprintAfterSha256",
      "negativeProbeCount",
      "negativeProbeFailures",
      "oldWriterRejectedBeforeProvider",
      "providerCallDelta",
      "financialMutationDelta",
    ],
    "[schema-readback] facts",
  );
  requireExact(
    facts.migrationHead,
    EXPECTED_SCHEMA_MIGRATION_HEAD,
    "[schema-readback] migration head",
  );
  requireExact(
    facts.migrationCount,
    EXPECTED_SCHEMA_MIGRATION_COUNT,
    "[schema-readback] migration count",
  );
  requireExact(
    facts.tableCount,
    EXPECTED_SCHEMA_TABLE_COUNT,
    "[schema-readback] table count",
  );
  requireExact(
    facts.incrementalColumnCount,
    EXPECTED_SCHEMA_INCREMENTAL_COLUMN_COUNT,
    "[schema-readback] incremental columns",
  );
  requireExact(
    facts.keyIndexCount,
    EXPECTED_SCHEMA_KEY_INDEX_COUNT,
    "[schema-readback] key indexes",
  );
  requireSha256(facts.schemaFingerprintSha256, "[schema-readback] schema fingerprint");
  requireSha256(facts.businessFingerprintBeforeSha256, "[schema-readback] before fingerprint");
  requireExact(
    facts.businessFingerprintAfterSha256,
    facts.businessFingerprintBeforeSha256,
    "[schema-readback] unchanged business fingerprint",
  );
  requireInteger(facts.negativeProbeCount, 12, 10000, "[schema-readback] negative probes");
  requireExact(facts.negativeProbeFailures, 0, "[schema-readback] negative probe failures");
  requireExact(facts.oldWriterRejectedBeforeProvider, true, "[schema-readback] old writer rejection");
  requireExact(facts.providerCallDelta, 0, "[schema-readback] provider delta");
  requireExact(facts.financialMutationDelta, 0, "[schema-readback] financial delta");
}

export function validateAdmissionFence(facts, candidate, evidence) {
  exactKeys(
    facts,
    [
      "captureIdSha256",
      "accountIdSha256",
      "d1DatabaseName",
      "d1DatabaseId",
      "scopeKind",
      "scopeIdSha256",
      "migration",
      "environmentIsolation",
      "backfill",
      "writerDrain",
      "initialOpen",
      "successfulAdmission",
      "close",
      "closeRace",
      "rejectionCases",
      "replayCases",
      "supportingArtifacts",
    ],
    "[admission-fence] facts",
  );
  const captureIdSha256 = requireSha256(
    facts.captureIdSha256,
    "[admission-fence] capture id",
  );
  requireSha256(facts.accountIdSha256, "[admission-fence] account digest");
  requireExact(
    facts.d1DatabaseName,
    candidate.d1DatabaseName,
    "[admission-fence] D1 name",
  );
  requireExact(
    facts.d1DatabaseId,
    candidate.d1DatabaseId,
    "[admission-fence] D1 id",
  );
  requireExact(facts.scopeKind, "global", "[admission-fence] scope kind");
  requireExact(
    facts.scopeIdSha256,
    GLOBAL_ADMISSION_SCOPE_ID_SHA256,
    "[admission-fence] scope digest",
  );

  const migration = validateAdmissionFenceMigration(facts.migration);
  validateAdmissionFenceEnvironmentIsolation(facts.environmentIsolation);
  const backfill = validateAdmissionFenceBackfill(facts.backfill);
  const writerDrain = validateAdmissionFenceWriterDrain(
    facts.writerDrain,
    candidate,
    evidence,
  );
  const initialOpen = validateAdmissionFenceInitialOpen(facts.initialOpen);
  const successfulAdmission = validateAdmissionFenceSuccessfulAdmission(
    facts.successfulAdmission,
    backfill,
  );
  const close = validateAdmissionFenceClose(
    facts.close,
    migration,
    backfill,
    initialOpen,
    successfulAdmission,
  );
  validateAdmissionFenceCloseRace(facts.closeRace);
  validateAdmissionFenceRejectionCases(
    facts.rejectionCases,
    writerDrain,
  );
  validateAdmissionFenceReplayCases(facts.replayCases, writerDrain);
  const supportingArtifacts = validateAdmissionFenceSupportingArtifactRecords(
    facts.supportingArtifacts,
    evidence,
  );
  return {
    captureIdSha256,
    supportingArtifacts,
    fenceIdSha256: initialOpen.fenceIdSha256,
    campaignIdSha256: close.campaignIdSha256,
  };
}

function validateAdmissionFenceMigration(value) {
  const migration = requireObject(value, "[admission-fence] migration");
  exactKeys(
    migration,
    [
      "name",
      "sqlSha256",
      "markerCount",
      "tables",
      "indexes",
      "triggers",
      "schemaFingerprintSha256",
      "businessFingerprintBeforeSha256",
      "businessFingerprintAfterSha256",
    ],
    "[admission-fence] migration",
  );
  requireExact(
    migration.name,
    IMMUTABLE_ADMISSION_FENCE_MIGRATION,
    "[admission-fence] migration name",
  );
  requireExact(
    migration.sqlSha256,
    IMMUTABLE_ADMISSION_FENCE_MIGRATION_SQL_SHA256,
    "[admission-fence] migration SQL digest",
  );
  requireExact(migration.markerCount, 1, "[admission-fence] migration marker");
  requireExactStringArray(
    migration.tables,
    REQUIRED_ADMISSION_FENCE_TABLES,
    "[admission-fence] migration tables",
  );
  requireExactStringArray(
    migration.indexes,
    REQUIRED_ADMISSION_FENCE_INDEXES,
    "[admission-fence] migration indexes",
  );
  requireExactStringArray(
    migration.triggers,
    REQUIRED_ADMISSION_FENCE_TRIGGERS,
    "[admission-fence] migration triggers",
  );
  requireSha256(
    migration.schemaFingerprintSha256,
    "[admission-fence] schema fingerprint",
  );
  requireSha256(
    migration.businessFingerprintBeforeSha256,
    "[admission-fence] business fingerprint before",
  );
  requireExact(
    migration.businessFingerprintAfterSha256,
    migration.businessFingerprintBeforeSha256,
    "[admission-fence] unchanged business fingerprint",
  );
  return migration;
}

function validateAdmissionFenceEnvironmentIsolation(value) {
  const isolation = requireObject(
    value,
    "[admission-fence] environment isolation",
  );
  exactKeys(
    isolation,
    [
      "fenceEnvironment",
      "distinctFenceEnvironmentCount",
      "foreignEnvironmentFenceCount",
      "databaseBindingInventorySha256",
    ],
    "[admission-fence] environment isolation",
  );
  requireExact(
    isolation.fenceEnvironment,
    "staging",
    "[admission-fence] fence environment",
  );
  requireExact(
    isolation.distinctFenceEnvironmentCount,
    1,
    "[admission-fence] distinct fence environments",
  );
  requireExact(
    isolation.foreignEnvironmentFenceCount,
    0,
    "[admission-fence] foreign environment fences",
  );
  requireSha256(
    isolation.databaseBindingInventorySha256,
    "[admission-fence] database binding inventory",
  );
}

function validateAdmissionFenceBackfill(value) {
  const backfill = requireObject(value, "[admission-fence] backfill");
  exactKeys(
    backfill,
    [
      "preApplyAtomicAdmissionCount",
      "historicalCommitCount",
      "pre0068SourceContractCount",
      "firstAcceptedSequence",
      "lastAcceptedSequence",
      "firstOperationId",
      "lastOperationId",
      "pageCount",
      "paginationComplete",
      "rowManifestSha256",
      "sourceReadbackSha256",
      "rehearsalRowCount",
      "rehearsalRuns",
      "maximumDurationMs",
      "statementLimitMs",
      "safetyMarginMs",
    ],
    "[admission-fence] backfill",
  );
  const count = requireInteger(
    backfill.preApplyAtomicAdmissionCount,
    0,
    1_000_000_000,
    "[admission-fence] pre-apply admission count",
  );
  requireExact(
    backfill.historicalCommitCount,
    count,
    "[admission-fence] historical commit conservation",
  );
  requireExact(
    backfill.pre0068SourceContractCount,
    count,
    "[admission-fence] historical source contract conservation",
  );
  requireExact(
    backfill.firstAcceptedSequence,
    count === 0 ? 0 : 1,
    "[admission-fence] first historical sequence",
  );
  requireExact(
    backfill.lastAcceptedSequence,
    count,
    "[admission-fence] last historical sequence",
  );
  if (count === 0) {
    requireExact(
      backfill.firstOperationId,
      null,
      "[admission-fence] empty first operation",
    );
    requireExact(
      backfill.lastOperationId,
      null,
      "[admission-fence] empty last operation",
    );
    requireExact(backfill.pageCount, 0, "[admission-fence] empty page count");
  } else {
    requireToken(
      backfill.firstOperationId,
      opaqueIdPattern,
      "[admission-fence] first historical operation",
    );
    requireToken(
      backfill.lastOperationId,
      opaqueIdPattern,
      "[admission-fence] last historical operation",
    );
    requireInteger(
      backfill.pageCount,
      1,
      1_000_000,
      "[admission-fence] backfill pages",
    );
  }
  requireExact(
    backfill.paginationComplete,
    true,
    "[admission-fence] backfill pagination",
  );
  requireSha256(
    backfill.rowManifestSha256,
    "[admission-fence] backfill row manifest",
  );
  requireSha256(
    backfill.sourceReadbackSha256,
    "[admission-fence] backfill source readback",
  );
  requireExact(
    backfill.rehearsalRowCount,
    count,
    "[admission-fence] rehearsal row count",
  );
  requireInteger(
    backfill.rehearsalRuns,
    2,
    100,
    "[admission-fence] rehearsal runs",
  );
  const maximumDurationMs = requireInteger(
    backfill.maximumDurationMs,
    1,
    MAX_ADMISSION_FENCE_BACKFILL_DURATION_MS,
    "[admission-fence] backfill duration",
  );
  requireExact(
    backfill.statementLimitMs,
    D1_STATEMENT_LIMIT_MS,
    "[admission-fence] D1 statement limit",
  );
  const safetyMarginMs = requireInteger(
    backfill.safetyMarginMs,
    D1_STATEMENT_LIMIT_MS - MAX_ADMISSION_FENCE_BACKFILL_DURATION_MS,
    D1_STATEMENT_LIMIT_MS - 1,
    "[admission-fence] backfill safety margin",
  );
  if (maximumDurationMs + safetyMarginMs > D1_STATEMENT_LIMIT_MS) {
    throw new Error("[admission-fence] backfill exceeds the D1 duration budget");
  }
  return backfill;
}

function validateAdmissionFenceWriterDrain(value, candidate, evidence) {
  const writerDrain = requireObject(value, "[admission-fence] writer drain");
  exactKeys(
    writerDrain,
    [
      "inventorySha256",
      "currentWriterVersionId",
      "nMinusOneWriterVersionId",
      "overlapStartedAt",
      "overlapEndedAt",
      "writers",
      "unknownWriterCount",
      "drainGates",
      "configReadbackSha256",
      "capabilityReadbackSha256",
    ],
    "[admission-fence] writer drain",
  );
  requireSha256(
    writerDrain.inventorySha256,
    "[admission-fence] writer inventory",
  );
  requireExact(
    writerDrain.currentWriterVersionId,
    candidate.edgeWorkerVersionId,
    "[admission-fence] current writer version",
  );
  requireToken(
    writerDrain.nMinusOneWriterVersionId,
    opaqueIdPattern,
    "[admission-fence] N-1 writer version",
  );
  if (
    writerDrain.nMinusOneWriterVersionId ===
    writerDrain.currentWriterVersionId
  ) {
    throw new Error("[admission-fence] N and N-1 writer versions must differ");
  }
  const overlapStartedAt = requireTimestamp(
    writerDrain.overlapStartedAt,
    "[admission-fence] writer overlap start",
  );
  const overlapEndedAt = requireTimestamp(
    writerDrain.overlapEndedAt,
    "[admission-fence] writer overlap end",
  );
  if (
    overlapStartedAt.getTime() >= overlapEndedAt.getTime() ||
    overlapEndedAt.getTime() > new Date(evidence.capturedAt).getTime()
  ) {
    throw new Error("[admission-fence] writer overlap window is invalid");
  }
  if (!Array.isArray(writerDrain.writers) || writerDrain.writers.length !== 2) {
    throw new Error("[admission-fence] exactly two writer generations are required");
  }
  const expectedWriters = [
    {
      versionId: writerDrain.nMinusOneWriterVersionId,
      writerContract: "pre-0068-atomic-admission-v1",
      state: "drained",
    },
    {
      versionId: writerDrain.currentWriterVersionId,
      writerContract: "fenced-atomic-admission-v1",
      state: "current",
    },
  ];
  const writerIds = new Set();
  for (let index = 0; index < expectedWriters.length; index += 1) {
    const writer = requireObject(
      writerDrain.writers[index],
      "[admission-fence] writer",
    );
    exactKeys(
      writer,
      ["writerId", "versionId", "writerContract", "state"],
      "[admission-fence] writer",
    );
    const writerId = requireToken(
      writer.writerId,
      opaqueIdPattern,
      "[admission-fence] writer id",
    );
    if (writerIds.has(writerId)) {
      throw new Error("[admission-fence] writer ids must be distinct");
    }
    writerIds.add(writerId);
    for (const field of ["versionId", "writerContract", "state"]) {
      requireExact(
        writer[field],
        expectedWriters[index][field],
        `[admission-fence] writer ${field}`,
      );
    }
  }
  requireExact(
    writerDrain.unknownWriterCount,
    0,
    "[admission-fence] unknown writers",
  );
  const drainGates = requireObject(
    writerDrain.drainGates,
    "[admission-fence] drain gates",
  );
  exactKeys(
    drainGates,
    REQUIRED_DRAIN_WRITE_GATES,
    "[admission-fence] drain gates",
  );
  for (const gate of REQUIRED_DRAIN_WRITE_GATES) {
    requireExact(
      drainGates[gate],
      false,
      `[admission-fence] ${gate}`,
    );
  }
  requireSha256(
    writerDrain.configReadbackSha256,
    "[admission-fence] gate config readback",
  );
  requireSha256(
    writerDrain.capabilityReadbackSha256,
    "[admission-fence] gate capability readback",
  );
  return writerDrain;
}

function validateAdmissionFenceInitialOpen(value) {
  const initialOpen = requireObject(value, "[admission-fence] initial open");
  exactKeys(
    initialOpen,
    [
      "fenceIdSha256",
      "fenceGeneration",
      "headVersion",
      "adminIdentitySha256",
      "requestSha256",
      "batchSha256",
      "readbackSha256",
      "fenceInsertChanges",
      "headInsertChanges",
      "admissionOpen",
      "createdAt",
    ],
    "[admission-fence] initial open",
  );
  requireSha256(
    initialOpen.fenceIdSha256,
    "[admission-fence] initial fence id",
  );
  requireExact(
    initialOpen.fenceGeneration,
    1,
    "[admission-fence] initial fence generation",
  );
  requireExact(
    initialOpen.headVersion,
    1,
    "[admission-fence] initial head version",
  );
  for (const field of [
    "adminIdentitySha256",
    "requestSha256",
    "batchSha256",
    "readbackSha256",
  ]) {
    requireSha256(initialOpen[field], `[admission-fence] initial ${field}`);
  }
  requireExact(
    initialOpen.fenceInsertChanges,
    1,
    "[admission-fence] fence insert changes",
  );
  requireExact(
    initialOpen.headInsertChanges,
    1,
    "[admission-fence] head insert changes",
  );
  requireExact(
    initialOpen.admissionOpen,
    true,
    "[admission-fence] initial admission state",
  );
  requireInteger(
    initialOpen.createdAt,
    1,
    Number.MAX_SAFE_INTEGER,
    "[admission-fence] initial creation time",
  );
  return initialOpen;
}

function validateAdmissionFenceSuccessfulAdmission(value, backfill) {
  const admission = requireObject(
    value,
    "[admission-fence] successful admission",
  );
  exactKeys(
    admission,
    [
      "acceptedSequence",
      "operationId",
      "reservationKey",
      "atomicAdmissionSha256",
      "admissionCommitSha256",
      "receiptRowSha256",
      "reservationRowSha256",
      "financialBeforeSha256",
      "financialAfterSha256",
      "operationRowSha256",
      "batchSha256",
      "readbackSha256",
      "providerCallDelta",
      "queueDelta",
    ],
    "[admission-fence] successful admission",
  );
  requireExact(
    admission.acceptedSequence,
    backfill.historicalCommitCount + 1,
    "[admission-fence] current accepted sequence",
  );
  requireToken(
    admission.operationId,
    opaqueIdPattern,
    "[admission-fence] admitted operation",
  );
  requireToken(
    admission.reservationKey,
    opaqueIdPattern,
    "[admission-fence] admitted reservation",
  );
  requireExact(
    admission.reservationKey,
    admission.operationId,
    "[admission-fence] operation and reservation identity",
  );
  for (const field of [
    "atomicAdmissionSha256",
    "admissionCommitSha256",
    "receiptRowSha256",
    "reservationRowSha256",
    "financialBeforeSha256",
    "financialAfterSha256",
    "operationRowSha256",
    "batchSha256",
    "readbackSha256",
  ]) {
    requireSha256(admission[field], `[admission-fence] admission ${field}`);
  }
  if (admission.financialBeforeSha256 === admission.financialAfterSha256) {
    throw new Error("[admission-fence] successful admission did not change finance");
  }
  requireExact(
    admission.providerCallDelta,
    0,
    "[admission-fence] provider calls before dispatch",
  );
  requireExact(
    admission.queueDelta,
    0,
    "[admission-fence] queue writes before dispatch",
  );
  return admission;
}

function validateAdmissionFenceClose(
  value,
  migration,
  backfill,
  initialOpen,
  admission,
) {
  const close = requireObject(value, "[admission-fence] close");
  exactKeys(
    close,
    [
      "campaignIdSha256",
      "fenceIdSha256",
      "fenceGeneration",
      "headVersion",
      "headFenceIdSha256",
      "headGeneration",
      "admissionOpen",
      "cutoffAt",
      "closedAt",
      "campaignCreatedAt",
      "acceptedHighWatermark",
      "acceptedMemberCount",
      "acceptedFirstSequence",
      "acceptedFirstOperationId",
      "acceptedLastSequence",
      "acceptedLastOperationId",
      "acceptedBookmarkSha256",
      "acceptedSetManifestSha256",
      "acceptedSourceSchemaSha256",
      "acceptedSourceReadbackSha256",
      "openOperationWithoutCommitCount",
      "commitCountAtOrBelowHighWatermark",
      "fenceUpdateChanges",
      "campaignInsertChanges",
      "batchSha256",
      "readbackSha256",
    ],
    "[admission-fence] close",
  );
  requireSha256(close.campaignIdSha256, "[admission-fence] campaign id");
  for (const field of ["fenceIdSha256", "headFenceIdSha256"]) {
    requireExact(
      close[field],
      initialOpen.fenceIdSha256,
      `[admission-fence] close ${field}`,
    );
  }
  for (const field of ["fenceGeneration", "headGeneration"]) {
    requireExact(close[field], 1, `[admission-fence] close ${field}`);
  }
  requireExact(
    close.headVersion,
    initialOpen.headVersion,
    "[admission-fence] immutable head version",
  );
  requireExact(
    close.admissionOpen,
    false,
    "[admission-fence] closed admission state",
  );
  const closedAt = requireInteger(
    close.closedAt,
    initialOpen.createdAt,
    Number.MAX_SAFE_INTEGER,
    "[admission-fence] close time",
  );
  requireExact(close.cutoffAt, closedAt, "[admission-fence] cutoff time");
  const campaignCreatedAt = requireInteger(
    close.campaignCreatedAt,
    initialOpen.createdAt,
    Number.MAX_SAFE_INTEGER,
    "[admission-fence] campaign creation time",
  );
  requireExact(
    campaignCreatedAt,
    closedAt,
    "[admission-fence] one-step campaign time",
  );
  requireExact(
    close.acceptedHighWatermark,
    admission.acceptedSequence,
    "[admission-fence] accepted high watermark",
  );
  requireExact(
    close.acceptedMemberCount,
    close.acceptedHighWatermark,
    "[admission-fence] accepted member count",
  );
  requireExact(
    close.acceptedFirstSequence,
    1,
    "[admission-fence] accepted first sequence",
  );
  requireExact(
    close.acceptedLastSequence,
    close.acceptedHighWatermark,
    "[admission-fence] accepted last sequence",
  );
  const expectedFirstOperationId =
    backfill.historicalCommitCount === 0
      ? admission.operationId
      : backfill.firstOperationId;
  requireExact(
    close.acceptedFirstOperationId,
    expectedFirstOperationId,
    "[admission-fence] accepted first operation",
  );
  requireExact(
    close.acceptedLastOperationId,
    admission.operationId,
    "[admission-fence] accepted last operation",
  );
  for (const field of [
    "acceptedBookmarkSha256",
    "acceptedSetManifestSha256",
    "acceptedSourceSchemaSha256",
    "acceptedSourceReadbackSha256",
    "batchSha256",
    "readbackSha256",
  ]) {
    requireSha256(close[field], `[admission-fence] close ${field}`);
  }
  requireExact(
    close.acceptedSourceSchemaSha256,
    migration.schemaFingerprintSha256,
    "[admission-fence] accepted source schema",
  );
  requireExact(
    close.openOperationWithoutCommitCount,
    0,
    "[admission-fence] open operations outside commit ledger",
  );
  requireExact(
    close.commitCountAtOrBelowHighWatermark,
    close.acceptedMemberCount,
    "[admission-fence] accepted commit conservation",
  );
  requireExact(
    close.fenceUpdateChanges,
    1,
    "[admission-fence] fence close changes",
  );
  requireExact(
    close.campaignInsertChanges,
    1,
    "[admission-fence] campaign insert changes",
  );
  return close;
}

function validateAdmissionFenceCloseRace(value) {
  const races = requireObject(value, "[admission-fence] close race");
  exactKeys(
    races,
    ["admissionWins", "closeWins"],
    "[admission-fence] close race",
  );
  for (const [field, outcome, acceptedCommitDelta, rejectedAdmissionCount] of [
    ["admissionWins", "admission-wins", 1, 0],
    ["closeWins", "close-wins", 0, 1],
  ]) {
    const race = requireObject(
      races[field],
      `[admission-fence] ${field} race`,
    );
    exactKeys(
      race,
      [
        "outcome",
        "acceptedCommitDelta",
        "rejectedAdmissionCount",
        "batchSha256",
        "readbackSha256",
      ],
      `[admission-fence] ${field} race`,
    );
    requireExact(
      race.outcome,
      outcome,
      `[admission-fence] ${field} outcome`,
    );
    requireExact(
      race.acceptedCommitDelta,
      acceptedCommitDelta,
      `[admission-fence] ${field} accepted delta`,
    );
    requireExact(
      race.rejectedAdmissionCount,
      rejectedAdmissionCount,
      `[admission-fence] ${field} rejected count`,
    );
    requireSha256(
      race.batchSha256,
      `[admission-fence] ${field} batch`,
    );
    requireSha256(
      race.readbackSha256,
      `[admission-fence] ${field} readback`,
    );
  }
}

function validateAdmissionFenceRejectionCases(value, writerDrain) {
  const cases = requireObject(value, "[admission-fence] rejection cases");
  exactKeys(
    cases,
    REQUIRED_ADMISSION_REJECTION_CASES,
    "[admission-fence] rejection cases",
  );
  const expected = new Map([
    [
      "old-writer",
      [writerDrain.nMinusOneWriterVersionId, "missing-fenced-commit", false],
    ],
    [
      "stale-generation",
      [writerDrain.currentWriterVersionId, "stale-fence-generation", true],
    ],
    [
      "late-admission",
      [writerDrain.currentWriterVersionId, "closed-fence", true],
    ],
    [
      "recovery-required-reopen",
      [
        writerDrain.currentWriterVersionId,
        "admission-reopen-prohibited",
        false,
      ],
    ],
    [
      "aborted-reopen",
      [
        writerDrain.currentWriterVersionId,
        "admission-reopen-prohibited",
        false,
      ],
    ],
  ]);
  for (const name of REQUIRED_ADMISSION_REJECTION_CASES) {
    const rejection = requireObject(
      cases[name],
      `[admission-fence] ${name}`,
    );
    exactKeys(
      rejection,
      [
        "attemptSha256",
        "writerVersionId",
        "outcome",
        "errorClass",
        "businessBeforeSha256",
        "businessAfterSha256",
        "providerCallDelta",
        "queueDelta",
        "billingMutationDelta",
        "r2InputObjectDelta",
        "r2OrphanObservedCount",
        "r2OrphanMutationCount",
        "commitDelta",
        "atomicAdmissionDelta",
        "reservationDelta",
        "operationDelta",
        "fenceDelta",
        "headDelta",
      ],
      `[admission-fence] ${name}`,
    );
    const [writerVersionId, errorClass, permitsOrphanInput] =
      expected.get(name);
    requireSha256(
      rejection.attemptSha256,
      `[admission-fence] ${name} attempt`,
    );
    requireExact(
      rejection.writerVersionId,
      writerVersionId,
      `[admission-fence] ${name} writer version`,
    );
    requireExact(
      rejection.outcome,
      "rejected-before-provider",
      `[admission-fence] ${name} outcome`,
    );
    requireExact(
      rejection.errorClass,
      errorClass,
      `[admission-fence] ${name} error class`,
    );
    requireSha256(
      rejection.businessBeforeSha256,
      `[admission-fence] ${name} before snapshot`,
    );
    requireExact(
      rejection.businessAfterSha256,
      rejection.businessBeforeSha256,
      `[admission-fence] ${name} unchanged business snapshot`,
    );
    for (const field of [
      "providerCallDelta",
      "queueDelta",
      "billingMutationDelta",
      "commitDelta",
      "atomicAdmissionDelta",
      "reservationDelta",
      "operationDelta",
      "fenceDelta",
      "headDelta",
      "r2OrphanMutationCount",
    ]) {
      requireExact(
        rejection[field],
        0,
        `[admission-fence] ${name} ${field}`,
      );
    }
    const r2InputObjectDelta = requireInteger(
      rejection.r2InputObjectDelta,
      0,
      permitsOrphanInput ? 1 : 0,
      `[admission-fence] ${name} R2 input delta`,
    );
    requireExact(
      rejection.r2OrphanObservedCount,
      r2InputObjectDelta,
      `[admission-fence] ${name} orphan observation`,
    );
  }
}

function validateAdmissionFenceReplayCases(value, writerDrain) {
  const cases = requireObject(value, "[admission-fence] replay cases");
  exactKeys(
    cases,
    REQUIRED_ADMISSION_REPLAY_CASES,
    "[admission-fence] replay cases",
  );
  for (const name of REQUIRED_ADMISSION_REPLAY_CASES) {
    const replay = requireObject(cases[name], `[admission-fence] ${name}`);
    exactKeys(
      replay,
      [
        "attemptSha256",
        "writerVersionId",
        "outcome",
        "durableCommitCount",
        "durableReceiptCount",
        "durableReservationCount",
        "durableOperationCount",
        "duplicateFinancialMutations",
        "providerCallDelta",
        "readbackSha256",
      ],
      `[admission-fence] ${name}`,
    );
    requireSha256(
      replay.attemptSha256,
      `[admission-fence] ${name} attempt`,
    );
    requireExact(
      replay.writerVersionId,
      writerDrain.currentWriterVersionId,
      `[admission-fence] ${name} writer version`,
    );
    requireExact(
      replay.outcome,
      "matching-immutable-readback",
      `[admission-fence] ${name} outcome`,
    );
    for (const field of [
      "durableCommitCount",
      "durableReceiptCount",
      "durableReservationCount",
      "durableOperationCount",
    ]) {
      requireExact(
        replay[field],
        1,
        `[admission-fence] ${name} ${field}`,
      );
    }
    requireExact(
      replay.duplicateFinancialMutations,
      0,
      `[admission-fence] ${name} financial duplicates`,
    );
    requireExact(
      replay.providerCallDelta,
      0,
      `[admission-fence] ${name} provider calls`,
    );
    requireSha256(
      replay.readbackSha256,
      `[admission-fence] ${name} readback`,
    );
  }
}

function validateAdmissionFenceSupportingArtifactRecords(value, evidence) {
  if (
    !Array.isArray(value) ||
    value.length !== REQUIRED_ADMISSION_FENCE_ARTIFACT_PURPOSES.length
  ) {
    throw new Error(
      "[admission-fence] complete supporting artifact inventory is required",
    );
  }
  const outerCapturedAt = new Date(evidence.capturedAt).getTime();
  let previousCapturedAt = Number.NEGATIVE_INFINITY;
  return value.map((raw, index) => {
    const record = requireObject(
      raw,
      "[admission-fence] supporting artifact",
    );
    exactKeys(
      record,
      ["purpose", "path", "sha256", "bytes", "capturedAt"],
      "[admission-fence] supporting artifact",
    );
    const purpose = REQUIRED_ADMISSION_FENCE_ARTIFACT_PURPOSES[index];
    requireExact(
      record.purpose,
      purpose,
      "[admission-fence] supporting artifact purpose",
    );
    requireExact(
      requireToken(
        record.path,
        relativeAdmissionFenceArtifactPathPattern,
        "[admission-fence] supporting artifact path",
      ),
      `evidence/admission-fence/${purpose}.json`,
      "[admission-fence] supporting artifact canonical path",
    );
    requireSha256(
      record.sha256,
      "[admission-fence] supporting artifact digest",
    );
    requireInteger(
      record.bytes,
      2,
      MAX_EVIDENCE_BYTES,
      "[admission-fence] supporting artifact bytes",
    );
    const capturedAt = requireTimestamp(
      record.capturedAt,
      "[admission-fence] supporting artifact capturedAt",
    );
    if (capturedAt.getTime() > outerCapturedAt) {
      throw new Error(
        "[admission-fence] supporting artifact postdates its evidence",
      );
    }
    if (capturedAt.getTime() < previousCapturedAt) {
      throw new Error(
        "[admission-fence] supporting artifact chronology is not monotonic",
      );
    }
    if (
      outerCapturedAt - capturedAt.getTime() >
      MAX_ADMISSION_FENCE_SUPPORTING_LAG_SECONDS * 1000
    ) {
      throw new Error(
        "[admission-fence] supporting artifact is outside the capture window",
      );
    }
    previousCapturedAt = capturedAt.getTime();
    return record;
  });
}

async function readAndValidateAdmissionFenceSupportingArtifacts({
  records,
  manifestRoot,
  evidence,
  candidateDigestSha256,
  captureIdSha256,
}) {
  let totalBytes = 0;
  const outerCapturedAt = new Date(evidence.capturedAt).getTime();
  for (const record of records) {
    const requested = path.resolve(manifestRoot, ...record.path.split("/"));
    const requestedStats = await lstat(requested).catch(() => null);
    if (
      !requestedStats ||
      !requestedStats.isFile() ||
      requestedStats.isSymbolicLink()
    ) {
      throw new Error(
        `[admission-fence] ${record.purpose} must be a regular non-symlink file`,
      );
    }
    const resolved = await realpath(requested).catch(() => null);
    if (!resolved || !isWithin(manifestRoot, resolved)) {
      throw new Error(
        `[admission-fence] ${record.purpose} path escaped the bundle root`,
      );
    }
    const file = await readCanonicalJson(
      resolved,
      `admission-fence ${record.purpose} artifact`,
      MAX_EVIDENCE_BYTES,
    );
    if (file.realPath !== resolved) {
      throw new Error(
        `[admission-fence] ${record.purpose} artifact path is not stable`,
      );
    }
    if (file.bytes.length !== record.bytes) {
      throw new Error(
        `[admission-fence] ${record.purpose} artifact byte count mismatch`,
      );
    }
    if (sha256Hex(file.bytes) !== record.sha256) {
      throw new Error(
        `[admission-fence] ${record.purpose} artifact digest mismatch`,
      );
    }
    const artifact = requireObject(
      file.value,
      `[admission-fence] ${record.purpose} artifact`,
    );
    exactKeys(
      artifact,
      [
        "schemaVersion",
        "contract",
        "purpose",
        "environment",
        "candidateDigestSha256",
        "captureIdSha256",
        "capturedAt",
        "payload",
      ],
      `[admission-fence] ${record.purpose} artifact`,
    );
    requireExact(
      artifact.schemaVersion,
      1,
      `[admission-fence] ${record.purpose} artifact schemaVersion`,
    );
    requireExact(
      artifact.contract,
      ADMISSION_FENCE_RAW_ARTIFACT_CONTRACT,
      `[admission-fence] ${record.purpose} artifact contract`,
    );
    requireExact(
      artifact.purpose,
      record.purpose,
      `[admission-fence] ${record.purpose} artifact purpose`,
    );
    requireExact(
      artifact.environment,
      "staging",
      `[admission-fence] ${record.purpose} artifact environment`,
    );
    requireExact(
      artifact.candidateDigestSha256,
      candidateDigestSha256,
      `[admission-fence] ${record.purpose} artifact candidate digest`,
    );
    requireExact(
      artifact.captureIdSha256,
      captureIdSha256,
      `[admission-fence] ${record.purpose} artifact capture id`,
    );
    requireExact(
      artifact.capturedAt,
      record.capturedAt,
      `[admission-fence] ${record.purpose} artifact capturedAt`,
    );
    const capturedAt = requireTimestamp(
      artifact.capturedAt,
      `[admission-fence] ${record.purpose} artifact capturedAt`,
    );
    if (capturedAt.getTime() > outerCapturedAt) {
      throw new Error(
        `[admission-fence] ${record.purpose} artifact postdates its evidence`,
      );
    }
    const payload = requireObject(
      artifact.payload,
      `[admission-fence] ${record.purpose} artifact payload`,
    );
    exactKeys(
      payload,
      ["payloadSha256"],
      `[admission-fence] ${record.purpose} artifact payload`,
    );
    requireSha256(
      payload.payloadSha256,
      `[admission-fence] ${record.purpose} artifact payload digest`,
    );
    totalBytes += file.bytes.length;
  }
  return totalBytes;
}

function validateAdmissionFenceCrossEvidence({
  admission,
  rollback,
  schema,
  remoteInventory,
  candidate,
}) {
  const admissionFacts = requireObject(
    admission,
    "[admission-fence] cross-evidence facts",
  );
  const rollbackFacts = requireObject(
    rollback,
    "[rollback-rehearsal] cross-evidence facts",
  );
  const schemaFacts = requireObject(
    schema,
    "[schema-readback] cross-evidence facts",
  );
  const inventoryFacts = requireObject(
    remoteInventory,
    "[remote-inventory] cross-evidence facts",
  );
  requireExact(
    admissionFacts.accountIdSha256,
    inventoryFacts.accountIdSha256,
    "[admission-fence] remote account binding",
  );
  requireExact(
    admissionFacts.d1DatabaseName,
    candidate.d1DatabaseName,
    "[admission-fence] candidate D1 name binding",
  );
  requireExact(
    admissionFacts.d1DatabaseId,
    candidate.d1DatabaseId,
    "[admission-fence] candidate D1 id binding",
  );
  requireExact(
    admissionFacts.migration.schemaFingerprintSha256,
    schemaFacts.schemaFingerprintSha256,
    "[admission-fence] schema fingerprint binding",
  );
  requireExact(
    admissionFacts.migration.businessFingerprintBeforeSha256,
    schemaFacts.businessFingerprintBeforeSha256,
    "[admission-fence] pre-migration business fingerprint binding",
  );
  requireExact(
    admissionFacts.migration.businessFingerprintAfterSha256,
    schemaFacts.businessFingerprintAfterSha256,
    "[admission-fence] post-migration business fingerprint binding",
  );
  requireExact(
    rollbackFacts.admissionCaptureIdSha256,
    admissionFacts.captureIdSha256,
    "[rollback-rehearsal] admission capture binding",
  );
  requireExact(
    rollbackFacts.admissionFenceIdSha256,
    admissionFacts.initialOpen.fenceIdSha256,
    "[rollback-rehearsal] admission fence binding",
  );
  requireExact(
    rollbackFacts.admissionFenceGeneration,
    admissionFacts.initialOpen.fenceGeneration,
    "[rollback-rehearsal] admission generation binding",
  );
  requireExact(
    rollbackFacts.closedCampaignIdSha256,
    admissionFacts.close.campaignIdSha256,
    "[rollback-rehearsal] drain campaign binding",
  );
  requireExact(
    rollbackFacts.acceptedHighWatermark,
    admissionFacts.close.acceptedHighWatermark,
    "[rollback-rehearsal] accepted high-watermark binding",
  );
  requireExact(
    rollbackFacts.acceptedSetManifestSha256,
    admissionFacts.close.acceptedSetManifestSha256,
    "[rollback-rehearsal] accepted-set manifest binding",
  );
  requireExact(
    rollbackFacts.commitCountBefore,
    admissionFacts.close.acceptedMemberCount,
    "[rollback-rehearsal] accepted commit-count binding",
  );
  requireExact(
    rollbackFacts.gateReadbackSha256,
    admissionFacts.writerDrain.configReadbackSha256,
    "[rollback-rehearsal] gate readback binding",
  );
  return {
    captureIdSha256: admissionFacts.captureIdSha256,
    fenceIdSha256: admissionFacts.initialOpen.fenceIdSha256,
    campaignIdSha256: admissionFacts.close.campaignIdSha256,
  };
}

function validateLifecycleFaults(facts) {
  exactKeys(
    facts,
    [
      "scenarioResults",
      "providerCallDelta",
      "financialMutationDelta",
      "duplicateProviderCalls",
      "duplicateFinancialTerminals",
      "unresolvedOperations",
      "quarantinedOperations",
      "maxColdStartMs",
    ],
    "[lifecycle-fault-campaign] facts",
  );
  const scenarios = requireObject(facts.scenarioResults, "[lifecycle-fault-campaign] scenarios");
  exactKeys(scenarios, REQUIRED_LIFECYCLE_SCENARIOS, "[lifecycle-fault-campaign] scenarios");
  for (const scenario of REQUIRED_LIFECYCLE_SCENARIOS) {
    requireExact(scenarios[scenario], "pass", `[lifecycle-fault-campaign] ${scenario}`);
  }
  for (const field of [
    "providerCallDelta",
    "financialMutationDelta",
    "duplicateProviderCalls",
    "duplicateFinancialTerminals",
    "unresolvedOperations",
  ]) {
    requireExact(facts[field], 0, `[lifecycle-fault-campaign] ${field}`);
  }
  requireInteger(facts.quarantinedOperations, 0, 10000, "[lifecycle-fault-campaign] quarantined operations");
  requireInteger(facts.maxColdStartMs, 0, 30000, "[lifecycle-fault-campaign] cold start");
}

function validateResponseFinancialFaults(facts) {
  exactKeys(
    facts,
    [
      "successCases",
      "typedErrorCases",
      "httpErrorCases",
      "invalidBodyCases",
      "faultInjectionPointCount",
      "faultInjectionPassCount",
      "providerCalls",
      "providerOperations",
      "duplicateProviderCalls",
      "settledOperations",
      "refundedOperations",
      "recoveryOperations",
      "duplicateFinancialTerminals",
      "duplicateOutboxRows",
      "requestAccountingOnRefund",
      "unexplainedProviderDelta",
      "unexplainedFinancialDeltaMinorUnits",
      "r2OrphansUnclassified",
      "clientReplayMismatches",
    ],
    "[response-financial-fault-campaign] facts",
  );
  for (const field of ["successCases", "typedErrorCases", "httpErrorCases", "invalidBodyCases"]){
    requireInteger(facts[field], 1, 100000, `[response-financial-fault-campaign] ${field}`);
  }
  requireInteger(facts.faultInjectionPointCount, 8, 100000, "[response-financial-fault-campaign] fault points");
  requireExact(
    facts.faultInjectionPassCount,
    facts.faultInjectionPointCount,
    "[response-financial-fault-campaign] fault coverage",
  );
  requireInteger(facts.providerCalls, 1, 1000000, "[response-financial-fault-campaign] provider calls");
  requireExact(facts.providerOperations, facts.providerCalls, "[response-financial-fault-campaign] provider operations");
  requireExact(
    facts.successCases +
      facts.typedErrorCases +
      facts.httpErrorCases +
      facts.invalidBodyCases,
    facts.providerOperations,
    "[response-financial-fault-campaign] response case conservation",
  );
  requireInteger(facts.settledOperations, 1, 1000000, "[response-financial-fault-campaign] settled operations");
  requireInteger(facts.refundedOperations, 3, 1000000, "[response-financial-fault-campaign] refunded operations");
  requireInteger(facts.recoveryOperations, 1, 1000000, "[response-financial-fault-campaign] recovery operations");
  requireExact(
    facts.settledOperations + facts.refundedOperations,
    facts.providerOperations,
    "[response-financial-fault-campaign] financial terminal conservation",
  );
  if (facts.recoveryOperations > facts.providerOperations) {
    throw new Error("[response-financial-fault-campaign] recovery operations exceed provider operations");
  }
  for (const field of [
    "duplicateProviderCalls",
    "duplicateFinancialTerminals",
    "duplicateOutboxRows",
    "requestAccountingOnRefund",
    "unexplainedProviderDelta",
    "r2OrphansUnclassified",
    "clientReplayMismatches",
  ]) {
    requireExact(facts[field], 0, `[response-financial-fault-campaign] ${field}`);
  }
  requireExact(
    facts.unexplainedFinancialDeltaMinorUnits,
    "0",
    "[response-financial-fault-campaign] unexplained financial delta",
  );
}

function validateCrossLayerProvenance(facts) {
  exactKeys(
    facts,
    [
      "traceCount",
      "completeTraceCount",
      "missingSegmentCount",
      "identityMismatchCount",
      "segments",
      "redactionFindings",
    ],
    "[cross-layer-provenance] facts",
  );
  requireInteger(facts.traceCount, 4, 1000000, "[cross-layer-provenance] trace count");
  requireExact(facts.completeTraceCount, facts.traceCount, "[cross-layer-provenance] complete traces");
  requireExact(facts.missingSegmentCount, 0, "[cross-layer-provenance] missing segments");
  requireExact(facts.identityMismatchCount, 0, "[cross-layer-provenance] identity mismatch");
  requireExactStringArray(facts.segments, REQUIRED_PROVENANCE_SEGMENTS, "[cross-layer-provenance] segments");
  requireExact(facts.redactionFindings, 0, "[cross-layer-provenance] redaction findings");
}

function validateLoadCostSlo(facts) {
  exactKeys(
    facts,
    [
      "durationSeconds",
      "requestCount",
      "rust5xxDeltaBasisPoints",
      "nonStreamP95OverheadMs",
      "d1WriteFailures",
      "d1OverloadErrors",
      "resourceLimitErrors",
      "alertDrillsAttempted",
      "alertDrillsDelivered",
      "currentTrafficCostApproved",
      "doubleTrafficCostApproved",
      "fiveXTrafficCostApproved",
      "unboundedBacklogCount",
    ],
    "[load-cost-slo] facts",
  );
  requireInteger(facts.durationSeconds, MIN_LOAD_DURATION_SECONDS, 7 * 24 * 60 * 60, "[load-cost-slo] duration");
  requireInteger(facts.requestCount, MIN_LOAD_REQUESTS, 1_000_000_000, "[load-cost-slo] requests");
  requireInteger(facts.rust5xxDeltaBasisPoints, -10000, 50, "[load-cost-slo] 5xx delta");
  requireInteger(facts.nonStreamP95OverheadMs, 0, 300, "[load-cost-slo] p95 overhead");
  for (const field of ["d1WriteFailures", "d1OverloadErrors", "resourceLimitErrors", "unboundedBacklogCount"]) {
    requireExact(facts[field], 0, `[load-cost-slo] ${field}`);
  }
  requireInteger(facts.alertDrillsAttempted, 3, 1000, "[load-cost-slo] alert drills");
  requireExact(facts.alertDrillsDelivered, facts.alertDrillsAttempted, "[load-cost-slo] delivered alerts");
  for (const field of [
    "currentTrafficCostApproved",
    "doubleTrafficCostApproved",
    "fiveXTrafficCostApproved",
  ]) {
    requireExact(facts[field], true, `[load-cost-slo] ${field}`);
  }
}

function validateRollbackRehearsal(facts) {
  exactKeys(
    facts,
    [
      "admissionCaptureIdSha256",
      "admissionFenceIdSha256",
      "admissionFenceGeneration",
      "closedCampaignIdSha256",
      "acceptedHighWatermark",
      "acceptedSetManifestSha256",
      "disableFirst",
      "allActionGatesFalseReadback",
      "newRustAdmissionsAfterDisable",
      "inflightOperations",
      "classifiedInflightOperations",
      "providerResends",
      "duplicateFinancialMutations",
      "goVpsAuthorityRestored",
      "p3ReadersRetained",
      "migration0054Retained",
      "migration0068Retained",
      "scopeHeadUnchanged",
      "fenceRemainedClosed",
      "reopenRejected",
      "commitCountBefore",
      "commitCountAfter",
      "gateReadbackSha256",
      "evidenceRetained",
      "rollbackDurationSeconds",
    ],
    "[rollback-rehearsal] facts",
  );
  for (const field of [
    "disableFirst",
    "allActionGatesFalseReadback",
    "goVpsAuthorityRestored",
    "p3ReadersRetained",
    "migration0054Retained",
    "migration0068Retained",
    "scopeHeadUnchanged",
    "fenceRemainedClosed",
    "reopenRejected",
    "evidenceRetained",
  ]) {
    requireExact(facts[field], true, `[rollback-rehearsal] ${field}`);
  }
  for (const field of [
    "admissionCaptureIdSha256",
    "admissionFenceIdSha256",
    "closedCampaignIdSha256",
    "acceptedSetManifestSha256",
    "gateReadbackSha256",
  ]) {
    requireSha256(facts[field], `[rollback-rehearsal] ${field}`);
  }
  requireExact(
    facts.admissionFenceGeneration,
    1,
    "[rollback-rehearsal] admission fence generation",
  );
  requireInteger(
    facts.acceptedHighWatermark,
    1,
    1_000_000_000,
    "[rollback-rehearsal] accepted high watermark",
  );
  requireExact(facts.newRustAdmissionsAfterDisable, 0, "[rollback-rehearsal] new admissions");
  requireInteger(facts.inflightOperations, 0, 1_000_000, "[rollback-rehearsal] in-flight operations");
  requireExact(
    facts.classifiedInflightOperations,
    facts.inflightOperations,
    "[rollback-rehearsal] classified in-flight operations",
  );
  requireExact(facts.providerResends, 0, "[rollback-rehearsal] provider resends");
  requireExact(facts.duplicateFinancialMutations, 0, "[rollback-rehearsal] financial duplicates");
  requireInteger(
    facts.commitCountBefore,
    1,
    1_000_000_000,
    "[rollback-rehearsal] commit count before",
  );
  requireExact(
    facts.commitCountAfter,
    facts.commitCountBefore,
    "[rollback-rehearsal] immutable commit count",
  );
  requireInteger(facts.rollbackDurationSeconds, 1, MAX_ROLLBACK_DURATION_SECONDS, "[rollback-rehearsal] duration");
}

function validateSecurityPrivacy(facts) {
  exactKeys(
    facts,
    [
      "replacementCredentialVerified",
      "leastPrivilegeReadbackVerified",
      "secretValueFindings",
      "unredactedPayloadFindings",
      "criticalFindings",
      "unapprovedHighFindings",
      "retentionApproved",
      "privacyApproved",
      "incidentOwnerAssigned",
    ],
    "[security-privacy-review] facts",
  );
  for (const field of [
    "replacementCredentialVerified",
    "leastPrivilegeReadbackVerified",
    "retentionApproved",
    "privacyApproved",
    "incidentOwnerAssigned",
  ]) {
    requireExact(facts[field], true, `[security-privacy-review] ${field}`);
  }
  for (const field of [
    "secretValueFindings",
    "unredactedPayloadFindings",
    "criticalFindings",
    "unapprovedHighFindings",
  ]) {
    requireExact(facts[field], 0, `[security-privacy-review] ${field}`);
  }
}

function validateApprovals({
  approvals,
  subjectDigestSha256,
  subject,
  policy,
  latestEvidenceAt,
  now,
}) {
  if (!Array.isArray(approvals) || approvals.length !== REQUIRED_APPROVAL_ROLES.length) {
    throw new Error("[approval] exactly five approvals are required");
  }
  const seenRoles = new Set();
  const seenKeys = new Set();
  const latestEvidenceMs = new Date(latestEvidenceAt).getTime();
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
    const role = requireEnum(approval.role, REQUIRED_APPROVAL_ROLES, "[approval] role");
    requireExact(role, REQUIRED_APPROVAL_ROLES[index], "[approval] role order");
    const keyId = requireToken(approval.keyId, keyIdPattern, "[approval] keyId");
    if (seenRoles.has(role) || seenKeys.has(keyId)) {
      throw new Error("[approval] roles and keys must be distinct");
    }
    seenRoles.add(role);
    seenKeys.add(keyId);
    const key = policy.keys.get(keyId);
    if (!key || key.role !== role) {
      throw new Error(`[approval] ${role} used an untrusted role key`);
    }
    requireExact(
      approval.subjectDigestSha256,
      subjectDigestSha256,
      `[approval] ${role} subject digest`,
    );
    const signedAt = requireTimestamp(approval.signedAt, `[approval] ${role} signedAt`);
    const expiresAt = requireTimestamp(approval.expiresAt, `[approval] ${role} expiresAt`);
    if (signedAt.getTime() >= expiresAt.getTime()) {
      throw new Error(`[approval] ${role} validity window is empty`);
    }
    if (signedAt.getTime() >= new Date(subject.expiresAt).getTime()) {
      throw new Error(`[approval] ${role} was signed after the decision window`);
    }
    const skewMs = policy.maxClockSkewSeconds * 1000;
    if (
      signedAt.getTime() <= latestEvidenceMs ||
      signedAt.getTime() < new Date(subject.generatedAt).getTime()
    ) {
      throw new Error(`[approval] ${role} predates the complete evidence bundle`);
    }
    if (signedAt.getTime() > now.getTime() + skewMs) {
      throw new Error(`[approval] ${role} signature is from the future`);
    }
    if (expiresAt.getTime() < new Date(subject.expiresAt).getTime()) {
      throw new Error(`[approval] ${role} expires before the decision`);
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
    const message = approvalMessage({
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
  }
  return [...seenRoles];
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

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function requireExactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} mismatch`);
  }
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
