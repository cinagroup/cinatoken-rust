import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const MANIFEST_CONTRACT =
  "cinatoken-go-vps-production-cutover-manifest-v1";
export const EVIDENCE_CONTRACT =
  "cinatoken-go-vps-production-cutover-evidence-v1";
export const PINNED_GO_HEAD =
  "73652508abc5cb09214dde02d51d69d1d1ccc703";

export const EVIDENCE_STATUSES = Object.freeze([
  "pass",
  "fail",
  "unknown",
  "not-applicable",
]);

export const REQUIRED_EVIDENCE_KINDS = Object.freeze([
  "candidate-topology",
  "ingress-drain",
  "process-state-drain",
  "persistence-stability",
  "scheduler-ownership",
  "bidirectional-sync",
  "pending-work",
  "rollback-bundle",
]);

export const REQUIRED_PROTOCOLS = Object.freeze([
  "http",
  "sse",
  "websocket",
  "task-submit",
]);

export const REQUIRED_BATCH_MAPS = Object.freeze([
  "user",
  "token",
  "channel",
  "usage",
  "request",
]);

export const REQUIRED_SYNC_DIRECTIONS = Object.freeze([
  "goToCloudflare",
  "cloudflareToGo",
]);

export const REQUIRED_RECONCILIATION_DOMAINS = Object.freeze([
  "quota",
  "request",
  "channel",
  "subscription",
  "task",
  "order",
  "provider",
  "audit",
]);

export const REQUIRED_PENDING_WORK_KINDS = Object.freeze(["tasks", "orders"]);

export const REQUIRED_ROLLBACK_COMPONENTS = Object.freeze([
  "cloudflare-disable-plan",
  "go-runtime",
  "go-redacted-config",
  "sql-snapshot",
  "log-db-snapshot",
  "redis-snapshot",
  "routing-plan",
  "scheduler-owner-plan",
  "reverse-sync-checkpoint",
  "runbook",
  "evidence-index",
]);

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 100_000;
const MAX_STRING_BYTES = 1024;
const MAX_CLOCK_SKEW_SECONDS = 60;
const MAX_MANIFEST_LIFETIME_SECONDS = 30 * 60;
const MAX_EVIDENCE_AGE_SECONDS = 6 * 60 * 60;
const MIN_INGRESS_OBSERVATION_SECONDS = 60;
const MAX_PROCESSES = 256;
const MAX_SCHEDULERS = 128;
const MAX_FLUSHES = 16;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

const sha256Pattern = /^[0-9a-f]{64}$/;
const gitCommitPattern = /^[0-9a-f]{40}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cutoverIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const collectorVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const prohibitedFieldFragments = Object.freeze([
  "secret",
  "credential",
  "password",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "apikey",
  "authorization",
  "payload",
]);

const prohibitedFieldNames = new Set([
  "body",
  "rawbody",
  "requestbody",
  "responsebody",
  "headers",
  "requestheaders",
  "responseheaders",
  "cookie",
  "setcookie",
  "environmentvariables",
  "envvalues",
  "sqltext",
  "querytext",
  "statementtext",
  "logline",
  "loglines",
]);

export async function verifyGoVpsCutoverEvidence({
  manifestPath,
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
  const manifest = validateManifest(manifestFile.value);
  const decisionTime = validateDecisionTime(manifest.subject, now);
  const candidate = validateCandidate(manifest.subject.candidate);
  const candidateDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(candidate), "utf8"),
  );
  requireExact(
    manifest.subject.candidateDigestSha256,
    candidateDigestSha256,
    "[candidate] candidate digest",
  );

  const cohort = validateCohort(
    manifest.subject.cohort,
    decisionTime.generatedAt,
    now,
  );
  const cohortDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(cohort), "utf8"),
  );
  requireExact(
    manifest.subject.cohortDigestSha256,
    cohortDigestSha256,
    "[cohort] cohort digest",
  );

  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(manifest.subject), "utf8"),
  );
  requireExact(
    manifest.subjectDigestSha256,
    subjectDigestSha256,
    "[manifest] subject digest",
  );

  const records = validateEvidenceRecords({
    records: manifest.subject.evidence,
    cohort,
    generatedAt: decisionTime.generatedAt,
    subjectExpiresAt: decisionTime.expiresAt,
    now,
  });
  const evidence = await readAndValidateEvidence({
    records,
    manifestRoot: path.dirname(manifestFile.realPath),
    candidate,
    candidateDigestSha256,
    cohort,
    cohortDigestSha256,
  });

  validateCrossEvidence(evidence.byKind);

  const blockers = [];
  const evidenceStatuses = [];
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    const item = evidence.byKind.get(kind);
    evidenceStatuses.push({ kind, status: item.status });
    if (item.status !== "pass") {
      blockers.push(`${kind}:declared-${item.status}`);
    }
    for (const issue of item.issues) blockers.push(`${kind}:${issue}`);
  }

  const decision =
    blockers.length === 0
      ? "eligible-for-production-cutover-review"
      : "not-proven";

  return {
    schemaVersion: 1,
    contract: MANIFEST_CONTRACT,
    ok: decision === "eligible-for-production-cutover-review",
    decision,
    eligibleForProductionCutoverReview:
      decision === "eligible-for-production-cutover-review",
    productionCutoverAuthorized: false,
    environment: "production",
    goHead: candidate.goHead,
    candidateDigestSha256,
    cohortDigestSha256,
    subjectDigestSha256,
    evidenceCount: evidenceStatuses.length,
    evidenceStatuses,
    blockers,
    latestEvidenceAt: evidence.latestCapturedAt,
    expiresAt: manifest.subject.expiresAt,
    safetyBoundary: {
      credentialsReadByVerifier: false,
      linePayloadsEmittedByVerifier: false,
      networkRequestsPerformedByVerifier: false,
      productionCutoverAuthorized: false,
      remoteMutationPerformedByVerifier: false,
      shellOrSqlExecutedByVerifier: false,
    },
  };
}

export const verifyGoVpsCutoverBundle = verifyGoVpsCutoverEvidence;

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function readAndValidateEvidence({
  records,
  manifestRoot,
  candidate,
  candidateDigestSha256,
  cohort,
  cohortDigestSha256,
}) {
  const evidenceDirectory = path.join(manifestRoot, "evidence");
  const directoryStats = await lstat(evidenceDirectory, { bigint: true }).catch(
    () => null,
  );
  if (
    !directoryStats ||
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink()
  ) {
    throw new Error("[path] evidence directory must be a regular non-symlink directory");
  }
  const evidenceDirectoryRealPath = await realpath(evidenceDirectory).catch(
    () => null,
  );
  if (
    !evidenceDirectoryRealPath ||
    !samePath(evidenceDirectory, evidenceDirectoryRealPath)
  ) {
    throw new Error("[path] evidence directory must not traverse a symbolic link");
  }

  const byKind = new Map();
  let totalBytes = 0;
  let latestCapturedAt = null;
  for (const record of records) {
    const resolved = path.resolve(manifestRoot, ...record.path.split("/"));
    if (!isWithin(manifestRoot, resolved)) {
      throw new Error("[path] evidence path escapes the bundle");
    }
    await assertNoSymlinkComponents(manifestRoot, resolved);
    const file = await readCanonicalJson(
      resolved,
      `${record.kind} evidence`,
      MAX_EVIDENCE_BYTES,
    );
    if (!isWithin(manifestRoot, file.realPath)) {
      throw new Error("[path] evidence real path escapes the bundle");
    }
    totalBytes += file.bytes.length;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new Error("[input] total evidence exceeds its byte bound");
    }
    requireExact(file.bytes.length, record.bytes, `[${record.kind}] byte count`);
    requireExact(
      sha256Hex(file.bytes),
      record.sha256,
      `[${record.kind}] digest`,
    );

    const validated = validateEvidenceEnvelope({
      value: file.value,
      record,
      candidate,
      candidateDigestSha256,
      cohort,
      cohortDigestSha256,
    });
    byKind.set(record.kind, validated);
    if (latestCapturedAt === null || record.capturedAt > latestCapturedAt) {
      latestCapturedAt = record.capturedAt;
    }
  }
  return { byKind, latestCapturedAt };
}

function validateManifest(value) {
  const manifest = requireObject(value, "[manifest] manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "contract", "subject", "subjectDigestSha256"],
    "[manifest] manifest",
  );
  requireExact(manifest.schemaVersion, 1, "[manifest] schemaVersion");
  requireExact(manifest.contract, MANIFEST_CONTRACT, "[manifest] contract");
  requireSha256(manifest.subjectDigestSha256, "[manifest] subject digest");
  const subject = requireObject(manifest.subject, "[manifest] subject");
  exactKeys(
    subject,
    [
      "candidate",
      "candidateDigestSha256",
      "cohort",
      "cohortDigestSha256",
      "decisionRequested",
      "evidence",
      "expiresAt",
      "generatedAt",
    ],
    "[manifest] subject",
  );
  requireExact(
    subject.decisionRequested,
    "production-cutover-review",
    "[manifest] decisionRequested",
  );
  requireSha256(subject.candidateDigestSha256, "[manifest] candidate digest");
  requireSha256(subject.cohortDigestSha256, "[manifest] cohort digest");
  return { ...manifest, subject };
}

function validateDecisionTime(subject, now) {
  const generatedAt = requireTimestamp(subject.generatedAt, "[manifest] generatedAt");
  const expiresAt = requireTimestamp(subject.expiresAt, "[manifest] expiresAt");
  const skewMs = MAX_CLOCK_SKEW_SECONDS * 1000;
  if (generatedAt.getTime() > now.getTime() + skewMs) {
    throw new Error("[manifest] generatedAt is in the future");
  }
  if (expiresAt.getTime() <= now.getTime() - skewMs) {
    throw new Error("[manifest] decision has expired");
  }
  const lifetimeSeconds = (expiresAt.getTime() - generatedAt.getTime()) / 1000;
  if (lifetimeSeconds <= 0 || lifetimeSeconds > MAX_MANIFEST_LIFETIME_SECONDS) {
    throw new Error("[manifest] decision lifetime is invalid");
  }
  return { generatedAt, expiresAt };
}

function validateCandidate(value) {
  const candidate = requireObject(value, "[candidate] candidate");
  exactKeys(
    candidate,
    [
      "cloudflareDeploymentDigestSha256",
      "goArtifactDigestSha256",
      "goDeploymentDigestSha256",
      "goHead",
      "goRepository",
      "loadBalancerIdentitySha256",
      "logDatabaseIdentitySha256",
      "redisIdentitySha256",
      "repository",
      "rustCommitSha",
      "sqlDatabaseIdentitySha256",
    ],
    "[candidate] candidate",
  );
  requireExact(
    candidate.repository,
    "cinagroup/cinatoken-rust",
    "[candidate] repository",
  );
  requireToken(candidate.rustCommitSha, gitCommitPattern, "[candidate] Rust commit");
  requireExact(
    candidate.goRepository,
    "cinagroup/cinatoken",
    "[candidate] Go repository",
  );
  requireExact(candidate.goHead, PINNED_GO_HEAD, "[candidate] Go HEAD");
  for (const field of [
    "cloudflareDeploymentDigestSha256",
    "goArtifactDigestSha256",
    "goDeploymentDigestSha256",
    "loadBalancerIdentitySha256",
    "logDatabaseIdentitySha256",
    "redisIdentitySha256",
    "sqlDatabaseIdentitySha256",
  ]) {
    requireSha256(candidate[field], `[candidate] ${field}`);
  }
  return candidate;
}

function validateCohort(value, generatedAt, now) {
  const cohort = requireObject(value, "[cohort] cohort");
  exactKeys(
    cohort,
    [
      "cutoverId",
      "dataScopeSha256",
      "environment",
      "freezeAt",
      "goProcessIds",
      "kind",
      "schedulerIds",
      "sourceAuthority",
      "targetAuthority",
      "trafficScopeSha256",
    ],
    "[cohort] cohort",
  );
  requireToken(cohort.cutoverId, cutoverIdPattern, "[cohort] cutoverId");
  requireExact(cohort.kind, "full-production", "[cohort] kind");
  requireExact(cohort.environment, "production", "[cohort] environment");
  requireExact(cohort.sourceAuthority, "go-vps", "[cohort] source authority");
  requireExact(cohort.targetAuthority, "cloudflare", "[cohort] target authority");
  requireSha256(cohort.trafficScopeSha256, "[cohort] traffic scope");
  requireSha256(cohort.dataScopeSha256, "[cohort] data scope");
  requireSortedUniqueIds(
    cohort.goProcessIds,
    1,
    MAX_PROCESSES,
    "[cohort] Go process IDs",
  );
  requireSortedUniqueIds(
    cohort.schedulerIds,
    1,
    MAX_SCHEDULERS,
    "[cohort] scheduler IDs",
  );
  const freezeAt = requireTimestamp(cohort.freezeAt, "[cohort] freezeAt");
  if (freezeAt.getTime() > generatedAt.getTime()) {
    throw new Error("[cohort] freezeAt follows manifest generation");
  }
  if (freezeAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_SECONDS * 1000) {
    throw new Error("[cohort] freezeAt is in the future");
  }
  if (now.getTime() - freezeAt.getTime() > MAX_EVIDENCE_AGE_SECONDS * 1000) {
    throw new Error("[cohort] freeze is stale");
  }
  return cohort;
}

function validateEvidenceRecords({
  records,
  cohort,
  generatedAt,
  subjectExpiresAt,
  now,
}) {
  if (!Array.isArray(records) || records.length !== REQUIRED_EVIDENCE_KINDS.length) {
    throw new Error("[manifest] every required evidence reference is mandatory");
  }
  let totalBytes = 0;
  const validated = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = requireObject(records[index], "[manifest] evidence reference");
    exactKeys(
      record,
      ["bytes", "capturedAt", "expiresAt", "kind", "path", "sha256"],
      "[manifest] evidence reference",
    );
    requireExact(
      record.kind,
      REQUIRED_EVIDENCE_KINDS[index],
      "[manifest] evidence kind order",
    );
    requireExact(
      record.path,
      `evidence/${record.kind}.json`,
      "[manifest] evidence path",
    );
    requireInteger(record.bytes, 1, MAX_EVIDENCE_BYTES, "[manifest] evidence bytes");
    requireSha256(record.sha256, "[manifest] evidence digest");
    const capturedAt = requireTimestamp(
      record.capturedAt,
      "[manifest] evidence capturedAt",
    );
    const expiresAt = requireTimestamp(
      record.expiresAt,
      "[manifest] evidence expiresAt",
    );
    validateEvidenceTime({
      capturedAt,
      expiresAt,
      freezeAt: new Date(cohort.freezeAt),
      generatedAt,
      subjectExpiresAt,
      now,
    });
    totalBytes += record.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
      throw new Error("[manifest] total evidence exceeds its byte bound");
    }
    validated.push({ ...record, capturedDate: capturedAt, expiresDate: expiresAt });
  }
  return validated;
}

function validateEvidenceTime({
  capturedAt,
  expiresAt,
  freezeAt,
  generatedAt,
  subjectExpiresAt,
  now,
}) {
  const skewMs = MAX_CLOCK_SKEW_SECONDS * 1000;
  if (capturedAt.getTime() < freezeAt.getTime()) {
    throw new Error("[time] evidence predates the frozen cohort");
  }
  if (capturedAt.getTime() > generatedAt.getTime()) {
    throw new Error("[time] evidence was captured after manifest generation");
  }
  if (capturedAt.getTime() > now.getTime() + skewMs) {
    throw new Error("[time] evidence is from the future");
  }
  if (now.getTime() - capturedAt.getTime() > MAX_EVIDENCE_AGE_SECONDS * 1000) {
    throw new Error("[time] evidence is stale");
  }
  if (expiresAt.getTime() <= capturedAt.getTime()) {
    throw new Error("[time] evidence validity window is empty");
  }
  if (expiresAt.getTime() < subjectExpiresAt.getTime()) {
    throw new Error("[time] evidence expires before the review decision");
  }
  if (expiresAt.getTime() <= now.getTime() - skewMs) {
    throw new Error("[time] evidence has expired");
  }
}

function validateEvidenceEnvelope({
  value,
  record,
  candidate,
  candidateDigestSha256,
  cohort,
  cohortDigestSha256,
}) {
  const evidence = requireObject(value, `[${record.kind}] evidence`);
  exactKeys(
    evidence,
    [
      "candidateDigestSha256",
      "capturedAt",
      "cohortDigestSha256",
      "collector",
      "contract",
      "expiresAt",
      "facts",
      "kind",
      "schemaVersion",
      "status",
    ],
    `[${record.kind}] evidence`,
  );
  requireExact(evidence.schemaVersion, 1, `[${record.kind}] schemaVersion`);
  requireExact(evidence.contract, EVIDENCE_CONTRACT, `[${record.kind}] contract`);
  requireExact(evidence.kind, record.kind, `[${record.kind}] kind`);
  const status = requireStatus(evidence.status, `[${record.kind}] status`);
  requireExact(
    evidence.candidateDigestSha256,
    candidateDigestSha256,
    `[${record.kind}] candidate digest`,
  );
  requireExact(
    evidence.cohortDigestSha256,
    cohortDigestSha256,
    `[${record.kind}] cohort digest`,
  );
  requireExact(evidence.capturedAt, record.capturedAt, `[${record.kind}] capturedAt`);
  requireExact(evidence.expiresAt, record.expiresAt, `[${record.kind}] expiresAt`);

  const collector = requireObject(evidence.collector, `[${record.kind}] collector`);
  exactKeys(
    collector,
    ["collectorId", "collectorVersion", "sourceArtifactSha256"],
    `[${record.kind}] collector`,
  );
  requireToken(
    collector.collectorId,
    opaqueIdPattern,
    `[${record.kind}] collectorId`,
  );
  requireToken(
    collector.collectorVersion,
    collectorVersionPattern,
    `[${record.kind}] collectorVersion`,
  );
  requireSha256(
    collector.sourceArtifactSha256,
    `[${record.kind}] collector source digest`,
  );

  const context = {
    candidate,
    cohort,
    capturedAt: record.capturedDate,
    freezeAt: new Date(cohort.freezeAt),
  };
  const result = validateFacts(record.kind, evidence.facts, context);
  return {
    status,
    issues: result.issues,
    meta: result.meta,
    capturedAt: record.capturedDate,
  };
}

function validateFacts(kind, facts, context) {
  switch (kind) {
    case "candidate-topology":
      return validateCandidateTopology(facts, context);
    case "ingress-drain":
      return validateIngressDrain(facts, context);
    case "process-state-drain":
      return validateProcessStateDrain(facts, context);
    case "persistence-stability":
      return validatePersistenceStability(facts, context);
    case "scheduler-ownership":
      return validateSchedulerOwnership(facts, context);
    case "bidirectional-sync":
      return validateBidirectionalSync(facts, context);
    case "pending-work":
      return validatePendingWork(facts, context);
    case "rollback-bundle":
      return validateRollbackBundle(facts, context);
    default:
      throw new Error("[evidence] unsupported evidence kind");
  }
}

function validateCandidateTopology(value, context) {
  const facts = requireObject(value, "[candidate-topology] facts");
  exactKeys(
    facts,
    [
      "authorityOwnerCount",
      "cloudflareDeploymentDigestSha256",
      "goArtifactDigestSha256",
      "goDeploymentDigestSha256",
      "goHead",
      "goProcesses",
      "inventoryStatus",
      "loadBalancerIdentitySha256",
      "logDatabaseIdentitySha256",
      "redisIdentitySha256",
      "schedulerIds",
      "sqlDatabaseIdentitySha256",
      "unknownProcessCount",
    ],
    "[candidate-topology] facts",
  );
  const issues = new Set();
  checkPassStatus(
    facts.inventoryStatus,
    "inventory-status-not-pass",
    issues,
    "[candidate-topology] inventoryStatus",
  );
  requireExact(facts.goHead, PINNED_GO_HEAD, "[candidate-topology] Go HEAD");
  for (const field of [
    "cloudflareDeploymentDigestSha256",
    "goArtifactDigestSha256",
    "goDeploymentDigestSha256",
    "loadBalancerIdentitySha256",
    "logDatabaseIdentitySha256",
    "redisIdentitySha256",
    "sqlDatabaseIdentitySha256",
  ]) {
    requireSha256(facts[field], `[candidate-topology] ${field}`);
    if (facts[field] !== context.candidate[field]) {
      issues.add("candidate-identity-mismatch");
    }
  }
  const authorityOwnerCount = requireInteger(
    facts.authorityOwnerCount,
    0,
    MAX_PROCESSES,
    "[candidate-topology] authorityOwnerCount",
  );
  const unknownProcessCount = requireInteger(
    facts.unknownProcessCount,
    0,
    MAX_PROCESSES,
    "[candidate-topology] unknownProcessCount",
  );
  if (authorityOwnerCount !== 1) issues.add("authority-owner-count-not-one");
  if (unknownProcessCount !== 0) issues.add("unknown-processes-present");

  requireExactStringArray(
    facts.schedulerIds,
    context.cohort.schedulerIds,
    "[candidate-topology] scheduler inventory",
  );
  if (!Array.isArray(facts.goProcesses)) {
    throw new Error("[candidate-topology] goProcesses must be an array");
  }
  if (facts.goProcesses.length !== context.cohort.goProcessIds.length) {
    issues.add("process-inventory-incomplete");
  }
  const seen = new Set();
  let masterCount = 0;
  for (let index = 0; index < facts.goProcesses.length; index += 1) {
    const process = requireObject(
      facts.goProcesses[index],
      "[candidate-topology] process",
    );
    exactKeys(
      process,
      ["artifactDigestSha256", "observedAt", "processId", "role", "status"],
      "[candidate-topology] process",
    );
    requireToken(process.processId, opaqueIdPattern, "[candidate-topology] processId");
    if (seen.has(process.processId)) issues.add("duplicate-process-inventory");
    seen.add(process.processId);
    if (process.processId !== context.cohort.goProcessIds[index]) {
      issues.add("process-inventory-mismatch");
    }
    requireEnum(process.role, ["master", "replica"], "[candidate-topology] role");
    if (process.role === "master") masterCount += 1;
    checkPassStatus(
      process.status,
      "process-inventory-status-not-pass",
      issues,
      "[candidate-topology] process status",
    );
    requireSha256(
      process.artifactDigestSha256,
      "[candidate-topology] process artifact digest",
    );
    if (process.artifactDigestSha256 !== context.candidate.goArtifactDigestSha256) {
      issues.add("process-artifact-mismatch");
    }
    requireEventTimestamp(
      process.observedAt,
      "[candidate-topology] process observedAt",
      context,
    );
  }
  if (masterCount !== 1 || authorityOwnerCount !== masterCount) {
    issues.add("master-role-count-not-one");
  }
  return { issues, meta: {} };
}

function validateIngressDrain(value, context) {
  const facts = requireObject(value, "[ingress-drain] facts");
  exactKeys(
    facts,
    [
      "drainStartedAt",
      "hostOpenConnections",
      "lastAcceptedAt",
      "loadBalancerOpenConnections",
      "observationEndedAt",
      "protocols",
    ],
    "[ingress-drain] facts",
  );
  const issues = new Set();
  const lastAcceptedAt = requireEventTimestamp(
    facts.lastAcceptedAt,
    "[ingress-drain] lastAcceptedAt",
    context,
  );
  const drainStartedAt = requireEventTimestamp(
    facts.drainStartedAt,
    "[ingress-drain] drainStartedAt",
    context,
  );
  const observationEndedAt = requireEventTimestamp(
    facts.observationEndedAt,
    "[ingress-drain] observationEndedAt",
    context,
  );
  if (lastAcceptedAt.getTime() > drainStartedAt.getTime()) {
    issues.add("acceptance-after-drain-start");
  }
  const observationSeconds =
    (observationEndedAt.getTime() - drainStartedAt.getTime()) / 1000;
  if (observationSeconds < MIN_INGRESS_OBSERVATION_SECONDS) {
    issues.add("ingress-observation-too-short");
  }
  for (const field of ["hostOpenConnections", "loadBalancerOpenConnections"]) {
    const count = requireInteger(
      facts[field],
      0,
      MAX_COUNT,
      `[ingress-drain] ${field}`,
    );
    if (count !== 0) issues.add("infrastructure-connections-not-zero");
  }

  const protocols = requireObject(facts.protocols, "[ingress-drain] protocols");
  exactKeys(protocols, REQUIRED_PROTOCOLS, "[ingress-drain] protocols");
  for (const protocolName of REQUIRED_PROTOCOLS) {
    const protocol = requireObject(
      protocols[protocolName],
      `[ingress-drain] ${protocolName}`,
    );
    exactKeys(
      protocol,
      ["acceptedAfterDrainCount", "activeCount", "inFlightCount", "status"],
      `[ingress-drain] ${protocolName}`,
    );
    checkPassStatus(
      protocol.status,
      "protocol-status-not-pass",
      issues,
      `[ingress-drain] ${protocolName} status`,
    );
    for (const field of [
      "acceptedAfterDrainCount",
      "activeCount",
      "inFlightCount",
    ]) {
      const count = requireInteger(
        protocol[field],
        0,
        MAX_COUNT,
        `[ingress-drain] ${protocolName} ${field}`,
      );
      if (count !== 0) issues.add("protocol-not-drained");
    }
  }
  return {
    issues,
    meta: { lastAcceptedAt, drainStartedAt, observationEndedAt },
  };
}

function validateProcessStateDrain(value, context) {
  const facts = requireObject(value, "[process-state-drain] facts");
  exactKeys(facts, ["processes"], "[process-state-drain] facts");
  if (!Array.isArray(facts.processes)) {
    throw new Error("[process-state-drain] processes must be an array");
  }
  const issues = new Set();
  if (facts.processes.length !== context.cohort.goProcessIds.length) {
    issues.add("process-drain-inventory-incomplete");
  }
  const observedAt = [];
  const seen = new Set();
  for (let index = 0; index < facts.processes.length; index += 1) {
    const process = requireObject(
      facts.processes[index],
      "[process-state-drain] process",
    );
    exactKeys(
      process,
      [
        "batchMaps",
        "billingSessions",
        "observedAt",
        "processId",
        "refundJobs",
        "status",
      ],
      "[process-state-drain] process",
    );
    requireToken(process.processId, opaqueIdPattern, "[process-state-drain] processId");
    if (seen.has(process.processId)) issues.add("duplicate-process-drain-row");
    seen.add(process.processId);
    if (process.processId !== context.cohort.goProcessIds[index]) {
      issues.add("process-drain-inventory-mismatch");
    }
    checkPassStatus(
      process.status,
      "process-drain-status-not-pass",
      issues,
      "[process-state-drain] process status",
    );
    observedAt.push(
      requireEventTimestamp(
        process.observedAt,
        "[process-state-drain] observedAt",
        context,
      ),
    );
    validateZeroObservation(
      process.billingSessions,
      "billing-sessions",
      issues,
      "[process-state-drain] billingSessions",
    );
    validateZeroObservation(
      process.refundJobs,
      "refund-jobs",
      issues,
      "[process-state-drain] refundJobs",
    );
    const batchMaps = requireObject(
      process.batchMaps,
      "[process-state-drain] batchMaps",
    );
    exactKeys(batchMaps, REQUIRED_BATCH_MAPS, "[process-state-drain] batchMaps");
    for (const mapKind of REQUIRED_BATCH_MAPS) {
      validateZeroObservation(
        batchMaps[mapKind],
        "batch-map",
        issues,
        `[process-state-drain] ${mapKind} batch map`,
      );
    }
  }
  return { issues, meta: { observedAt } };
}

function validateZeroObservation(value, issuePrefix, issues, label) {
  const observation = requireObject(value, label);
  exactKeys(observation, ["count", "status"], label);
  checkPassStatus(
    observation.status,
    `${issuePrefix}-status-not-pass`,
    issues,
    `${label} status`,
  );
  const count = requireInteger(observation.count, 0, MAX_COUNT, `${label} count`);
  if (count !== 0) issues.add(`${issuePrefix}-not-zero`);
}

function validatePersistenceStability(value, context) {
  const facts = requireObject(value, "[persistence-stability] facts");
  exactKeys(
    facts,
    [
      "batchIntervalSeconds",
      "errorCounts",
      "export",
      "exportIntervalSeconds",
      "flushes",
      "logDatabaseIdentitySha256",
      "logDbSnapshots",
      "snapshotIntervalSeconds",
      "sqlDatabaseIdentitySha256",
      "sqlSnapshots",
    ],
    "[persistence-stability] facts",
  );
  const issues = new Set();
  const batchIntervalSeconds = requireInteger(
    facts.batchIntervalSeconds,
    1,
    24 * 60 * 60,
    "[persistence-stability] batchIntervalSeconds",
  );
  const exportIntervalSeconds = requireInteger(
    facts.exportIntervalSeconds,
    1,
    24 * 60 * 60,
    "[persistence-stability] exportIntervalSeconds",
  );
  const snapshotIntervalSeconds = requireInteger(
    facts.snapshotIntervalSeconds,
    1,
    24 * 60 * 60,
    "[persistence-stability] snapshotIntervalSeconds",
  );
  if (snapshotIntervalSeconds < Math.max(batchIntervalSeconds, exportIntervalSeconds)) {
    issues.add("snapshot-interval-too-short");
  }
  for (const field of ["sqlDatabaseIdentitySha256", "logDatabaseIdentitySha256"]) {
    requireSha256(facts[field], `[persistence-stability] ${field}`);
    if (facts[field] !== context.candidate[field]) {
      issues.add("database-identity-mismatch");
    }
  }

  if (!Array.isArray(facts.flushes) || facts.flushes.length > MAX_FLUSHES) {
    throw new Error("[persistence-stability] flushes must be a bounded array");
  }
  if (facts.flushes.length < 2) issues.add("insufficient-flushes");
  const flushes = [];
  let priorCompletedAt = null;
  for (let index = 0; index < facts.flushes.length; index += 1) {
    const flush = requireObject(facts.flushes[index], "[persistence-stability] flush");
    exactKeys(
      flush,
      ["completedAt", "sequence", "startedAt", "status"],
      "[persistence-stability] flush",
    );
    requireExact(flush.sequence, index + 1, "[persistence-stability] flush sequence");
    checkPassStatus(
      flush.status,
      "flush-status-not-pass",
      issues,
      "[persistence-stability] flush status",
    );
    const startedAt = requireEventTimestamp(
      flush.startedAt,
      "[persistence-stability] flush startedAt",
      context,
    );
    const completedAt = requireEventTimestamp(
      flush.completedAt,
      "[persistence-stability] flush completedAt",
      context,
    );
    if (startedAt.getTime() >= completedAt.getTime()) {
      issues.add("flush-window-invalid");
    }
    if (priorCompletedAt && startedAt.getTime() < priorCompletedAt.getTime()) {
      issues.add("flushes-overlap");
    }
    priorCompletedAt = completedAt;
    flushes.push({ startedAt, completedAt });
  }

  const exportCycle = requireObject(facts.export, "[persistence-stability] export");
  exactKeys(
    exportCycle,
    ["completedAt", "startedAt", "status"],
    "[persistence-stability] export",
  );
  checkPassStatus(
    exportCycle.status,
    "export-status-not-pass",
    issues,
    "[persistence-stability] export status",
  );
  const exportStartedAt = requireEventTimestamp(
    exportCycle.startedAt,
    "[persistence-stability] export startedAt",
    context,
  );
  const exportCompletedAt = requireEventTimestamp(
    exportCycle.completedAt,
    "[persistence-stability] export completedAt",
    context,
  );
  if (exportStartedAt.getTime() >= exportCompletedAt.getTime()) {
    issues.add("export-window-invalid");
  }

  const errorCounts = requireObject(
    facts.errorCounts,
    "[persistence-stability] errorCounts",
  );
  exactKeys(
    errorCounts,
    ["batch", "export", "logWrite", "refund", "settlement", "tokenAdjustment"],
    "[persistence-stability] errorCounts",
  );
  for (const field of [
    "batch",
    "export",
    "logWrite",
    "refund",
    "settlement",
    "tokenAdjustment",
  ]) {
    const count = requireInteger(
      errorCounts[field],
      0,
      MAX_COUNT,
      `[persistence-stability] ${field} errors`,
    );
    if (count !== 0) issues.add("persistence-errors-present");
  }

  const latestCycleAt = laterDate(
    flushes.at(-1)?.completedAt ?? null,
    exportCompletedAt,
  );
  const sqlSnapshots = validateStableSnapshots(
    facts.sqlSnapshots,
    "sql",
    snapshotIntervalSeconds,
    latestCycleAt,
    context,
    issues,
  );
  const logDbSnapshots = validateStableSnapshots(
    facts.logDbSnapshots,
    "log-db",
    snapshotIntervalSeconds,
    latestCycleAt,
    context,
    issues,
  );
  const stableAt = laterDate(
    sqlSnapshots.at(-1)?.capturedAt ?? null,
    logDbSnapshots.at(-1)?.capturedAt ?? null,
  );
  return {
    issues,
    meta: {
      batchIntervalSeconds,
      exportIntervalSeconds,
      flushes,
      exportStartedAt,
      exportCompletedAt,
      stableAt,
    },
  };
}

function validateStableSnapshots(
  value,
  store,
  snapshotIntervalSeconds,
  latestCycleAt,
  context,
  issues,
) {
  if (!Array.isArray(value)) {
    throw new Error(`[persistence-stability] ${store} snapshots must be an array`);
  }
  if (value.length !== 2) issues.add(`${store}-snapshot-count-not-two`);
  const snapshots = [];
  for (const rawSnapshot of value) {
    const snapshot = requireObject(
      rawSnapshot,
      `[persistence-stability] ${store} snapshot`,
    );
    exactKeys(
      snapshot,
      [
        "capturedAt",
        "chunkSetDigestSha256",
        "digestSha256",
        "highWatermarkSha256",
        "rowCount",
        "status",
      ],
      `[persistence-stability] ${store} snapshot`,
    );
    checkPassStatus(
      snapshot.status,
      `${store}-snapshot-status-not-pass`,
      issues,
      `[persistence-stability] ${store} snapshot status`,
    );
    const capturedAt = requireEventTimestamp(
      snapshot.capturedAt,
      `[persistence-stability] ${store} snapshot capturedAt`,
      context,
    );
    for (const field of [
      "chunkSetDigestSha256",
      "digestSha256",
      "highWatermarkSha256",
    ]) {
      requireSha256(
        snapshot[field],
        `[persistence-stability] ${store} snapshot ${field}`,
      );
    }
    requireInteger(
      snapshot.rowCount,
      0,
      MAX_COUNT,
      `[persistence-stability] ${store} snapshot rowCount`,
    );
    if (latestCycleAt && capturedAt.getTime() < latestCycleAt.getTime()) {
      issues.add(`${store}-snapshot-precedes-final-cycle`);
    }
    snapshots.push({ ...snapshot, capturedAt });
  }
  if (snapshots.length === 2) {
    const elapsedSeconds =
      (snapshots[1].capturedAt.getTime() - snapshots[0].capturedAt.getTime()) / 1000;
    if (elapsedSeconds < snapshotIntervalSeconds) {
      issues.add(`${store}-snapshot-window-too-short`);
    }
    for (const field of [
      "chunkSetDigestSha256",
      "digestSha256",
      "highWatermarkSha256",
      "rowCount",
    ]) {
      if (snapshots[0][field] !== snapshots[1][field]) {
        issues.add(`${store}-snapshot-drift`);
      }
    }
  }
  return snapshots;
}

function validateSchedulerOwnership(value, context) {
  const facts = requireObject(value, "[scheduler-ownership] facts");
  exactKeys(
    facts,
    [
      "discoveredSchedulerCount",
      "expectedSchedulerCount",
      "inventoryStatus",
      "owners",
      "unknownSchedulerCount",
    ],
    "[scheduler-ownership] facts",
  );
  const issues = new Set();
  checkPassStatus(
    facts.inventoryStatus,
    "scheduler-inventory-status-not-pass",
    issues,
    "[scheduler-ownership] inventoryStatus",
  );
  const expectedSchedulerCount = requireInteger(
    facts.expectedSchedulerCount,
    0,
    MAX_SCHEDULERS,
    "[scheduler-ownership] expectedSchedulerCount",
  );
  const discoveredSchedulerCount = requireInteger(
    facts.discoveredSchedulerCount,
    0,
    MAX_SCHEDULERS,
    "[scheduler-ownership] discoveredSchedulerCount",
  );
  const unknownSchedulerCount = requireInteger(
    facts.unknownSchedulerCount,
    0,
    MAX_SCHEDULERS,
    "[scheduler-ownership] unknownSchedulerCount",
  );
  if (
    expectedSchedulerCount !== context.cohort.schedulerIds.length ||
    discoveredSchedulerCount !== context.cohort.schedulerIds.length
  ) {
    issues.add("scheduler-inventory-count-mismatch");
  }
  if (unknownSchedulerCount !== 0) issues.add("unknown-schedulers-present");
  if (!Array.isArray(facts.owners)) {
    throw new Error("[scheduler-ownership] owners must be an array");
  }
  if (facts.owners.length !== context.cohort.schedulerIds.length) {
    issues.add("scheduler-owner-inventory-incomplete");
  }
  const observedAt = [];
  const seen = new Set();
  for (let index = 0; index < facts.owners.length; index += 1) {
    const owner = requireObject(facts.owners[index], "[scheduler-ownership] owner");
    exactKeys(
      owner,
      ["observedAt", "ownerCount", "ownerSetDigestSha256", "schedulerId", "status"],
      "[scheduler-ownership] owner",
    );
    requireToken(owner.schedulerId, opaqueIdPattern, "[scheduler-ownership] schedulerId");
    if (seen.has(owner.schedulerId)) issues.add("duplicate-scheduler-row");
    seen.add(owner.schedulerId);
    if (owner.schedulerId !== context.cohort.schedulerIds[index]) {
      issues.add("scheduler-owner-inventory-mismatch");
    }
    checkPassStatus(
      owner.status,
      "scheduler-owner-status-not-pass",
      issues,
      "[scheduler-ownership] owner status",
    );
    const ownerCount = requireInteger(
      owner.ownerCount,
      0,
      MAX_PROCESSES,
      "[scheduler-ownership] ownerCount",
    );
    if (ownerCount !== 1) issues.add("scheduler-owner-count-not-one");
    requireSha256(
      owner.ownerSetDigestSha256,
      "[scheduler-ownership] owner set digest",
    );
    observedAt.push(
      requireEventTimestamp(
        owner.observedAt,
        "[scheduler-ownership] observedAt",
        context,
      ),
    );
  }
  return { issues, meta: { observedAt } };
}

function validateBidirectionalSync(value, context) {
  const facts = requireObject(value, "[bidirectional-sync] facts");
  exactKeys(
    facts,
    ["directions", "reconciliation"],
    "[bidirectional-sync] facts",
  );
  const issues = new Set();
  const directions = requireObject(
    facts.directions,
    "[bidirectional-sync] directions",
  );
  exactKeys(
    directions,
    REQUIRED_SYNC_DIRECTIONS,
    "[bidirectional-sync] directions",
  );
  const observedAt = [];
  for (const directionName of REQUIRED_SYNC_DIRECTIONS) {
    const direction = requireObject(
      directions[directionName],
      `[bidirectional-sync] ${directionName}`,
    );
    exactKeys(
      direction,
      [
        "acceptedWriteCount",
        "appliedWriteCount",
        "conflictCount",
        "lagRecordCount",
        "lagSeconds",
        "observedAt",
        "sourceHighWatermarkSha256",
        "sourceWriteSetSha256",
        "status",
        "targetHighWatermarkSha256",
        "targetWriteSetSha256",
        "unresolvedWriteCount",
      ],
      `[bidirectional-sync] ${directionName}`,
    );
    checkPassStatus(
      direction.status,
      "sync-direction-status-not-pass",
      issues,
      `[bidirectional-sync] ${directionName} status`,
    );
    observedAt.push(
      requireEventTimestamp(
        direction.observedAt,
        `[bidirectional-sync] ${directionName} observedAt`,
        context,
      ),
    );
    for (const field of [
      "acceptedWriteCount",
      "appliedWriteCount",
      "conflictCount",
      "lagRecordCount",
      "lagSeconds",
      "unresolvedWriteCount",
    ]) {
      requireInteger(
        direction[field],
        0,
        MAX_COUNT,
        `[bidirectional-sync] ${directionName} ${field}`,
      );
    }
    for (const field of [
      "sourceHighWatermarkSha256",
      "sourceWriteSetSha256",
      "targetHighWatermarkSha256",
      "targetWriteSetSha256",
    ]) {
      requireSha256(
        direction[field],
        `[bidirectional-sync] ${directionName} ${field}`,
      );
    }
    if (direction.lagRecordCount !== 0 || direction.lagSeconds !== 0) {
      issues.add("sync-lag-not-zero");
    }
    if (direction.conflictCount !== 0) issues.add("sync-conflicts-not-zero");
    if (direction.unresolvedWriteCount !== 0) {
      issues.add("sync-unresolved-writes-not-zero");
    }
    if (direction.acceptedWriteCount !== direction.appliedWriteCount) {
      issues.add("sync-write-count-mismatch");
    }
    if (
      direction.sourceHighWatermarkSha256 !== direction.targetHighWatermarkSha256 ||
      direction.sourceWriteSetSha256 !== direction.targetWriteSetSha256
    ) {
      issues.add("sync-digest-mismatch");
    }
  }

  const reconciliation = requireObject(
    facts.reconciliation,
    "[bidirectional-sync] reconciliation",
  );
  exactKeys(
    reconciliation,
    REQUIRED_RECONCILIATION_DOMAINS,
    "[bidirectional-sync] reconciliation",
  );
  for (const domainName of REQUIRED_RECONCILIATION_DOMAINS) {
    const domain = requireObject(
      reconciliation[domainName],
      `[bidirectional-sync] ${domainName} reconciliation`,
    );
    exactKeys(
      domain,
      ["differenceCount", "sourceDigestSha256", "status", "targetDigestSha256"],
      `[bidirectional-sync] ${domainName} reconciliation`,
    );
    checkPassStatus(
      domain.status,
      "reconciliation-status-not-pass",
      issues,
      `[bidirectional-sync] ${domainName} status`,
    );
    const differenceCount = requireInteger(
      domain.differenceCount,
      0,
      MAX_COUNT,
      `[bidirectional-sync] ${domainName} differenceCount`,
    );
    if (differenceCount !== 0) issues.add("reconciliation-difference-not-zero");
    requireSha256(
      domain.sourceDigestSha256,
      `[bidirectional-sync] ${domainName} source digest`,
    );
    requireSha256(
      domain.targetDigestSha256,
      `[bidirectional-sync] ${domainName} target digest`,
    );
    if (domain.sourceDigestSha256 !== domain.targetDigestSha256) {
      issues.add("reconciliation-digest-mismatch");
    }
  }
  return { issues, meta: { observedAt } };
}

function validatePendingWork(value, context) {
  const facts = requireObject(value, "[pending-work] facts");
  exactKeys(facts, REQUIRED_PENDING_WORK_KINDS, "[pending-work] facts");
  const issues = new Set();
  const capturedAt = [];
  for (const workKind of REQUIRED_PENDING_WORK_KINDS) {
    const work = requireObject(facts[workKind], `[pending-work] ${workKind}`);
    exactKeys(
      work,
      [
        "capturedAt",
        "disposition",
        "durableHandoffCount",
        "handoffDigestSha256",
        "sourcePendingCount",
        "status",
        "targetReadbackCount",
        "unaccountedCount",
      ],
      `[pending-work] ${workKind}`,
    );
    checkPassStatus(
      work.status,
      "pending-work-status-not-pass",
      issues,
      `[pending-work] ${workKind} status`,
    );
    requireEnum(
      work.disposition,
      ["empty", "durable-handoff"],
      `[pending-work] ${workKind} disposition`,
    );
    const sourcePendingCount = requireInteger(
      work.sourcePendingCount,
      0,
      MAX_COUNT,
      `[pending-work] ${workKind} sourcePendingCount`,
    );
    const durableHandoffCount = requireInteger(
      work.durableHandoffCount,
      0,
      MAX_COUNT,
      `[pending-work] ${workKind} durableHandoffCount`,
    );
    const targetReadbackCount = requireInteger(
      work.targetReadbackCount,
      0,
      MAX_COUNT,
      `[pending-work] ${workKind} targetReadbackCount`,
    );
    const unaccountedCount = requireInteger(
      work.unaccountedCount,
      0,
      MAX_COUNT,
      `[pending-work] ${workKind} unaccountedCount`,
    );
    if (work.disposition === "empty") {
      requireExact(
        work.handoffDigestSha256,
        null,
        `[pending-work] ${workKind} empty handoff digest`,
      );
      if (
        sourcePendingCount !== 0 ||
        durableHandoffCount !== 0 ||
        targetReadbackCount !== 0 ||
        unaccountedCount !== 0
      ) {
        issues.add("pending-work-empty-disposition-inconsistent");
      }
    } else {
      requireSha256(
        work.handoffDigestSha256,
        `[pending-work] ${workKind} handoff digest`,
      );
      if (
        sourcePendingCount < 1 ||
        durableHandoffCount !== sourcePendingCount ||
        targetReadbackCount !== sourcePendingCount ||
        unaccountedCount !== 0
      ) {
        issues.add("pending-work-handoff-incomplete");
      }
    }
    capturedAt.push(
      requireEventTimestamp(
        work.capturedAt,
        `[pending-work] ${workKind} capturedAt`,
        context,
      ),
    );
  }
  return { issues, meta: { capturedAt } };
}

function validateRollbackBundle(value, context) {
  const facts = requireObject(value, "[rollback-bundle] facts");
  exactKeys(
    facts,
    [
      "acceptedWritesIncludedStatus",
      "bundleId",
      "components",
      "goReadinessStatus",
      "measuredRpoSeconds",
      "measuredRtoSeconds",
      "rehearsalCompletedAt",
      "restoreStatus",
      "rpoTargetSeconds",
      "rtoTargetSeconds",
      "sessionContinuityStatus",
    ],
    "[rollback-bundle] facts",
  );
  const issues = new Set();
  requireToken(facts.bundleId, opaqueIdPattern, "[rollback-bundle] bundleId");
  for (const [field, issue] of [
    ["acceptedWritesIncludedStatus", "rollback-write-coverage-not-pass"],
    ["goReadinessStatus", "rollback-go-readiness-not-pass"],
    ["restoreStatus", "rollback-restore-not-pass"],
    ["sessionContinuityStatus", "rollback-session-continuity-not-pass"],
  ]) {
    checkPassStatus(facts[field], issue, issues, `[rollback-bundle] ${field}`);
  }
  const rtoTargetSeconds = requireInteger(
    facts.rtoTargetSeconds,
    1,
    24 * 60 * 60,
    "[rollback-bundle] rtoTargetSeconds",
  );
  const measuredRtoSeconds = requireInteger(
    facts.measuredRtoSeconds,
    0,
    24 * 60 * 60,
    "[rollback-bundle] measuredRtoSeconds",
  );
  const rpoTargetSeconds = requireInteger(
    facts.rpoTargetSeconds,
    0,
    24 * 60 * 60,
    "[rollback-bundle] rpoTargetSeconds",
  );
  const measuredRpoSeconds = requireInteger(
    facts.measuredRpoSeconds,
    0,
    24 * 60 * 60,
    "[rollback-bundle] measuredRpoSeconds",
  );
  if (measuredRtoSeconds > rtoTargetSeconds) issues.add("rollback-rto-exceeded");
  if (measuredRpoSeconds > rpoTargetSeconds) issues.add("rollback-rpo-exceeded");
  const rehearsalCompletedAt = requireEventTimestamp(
    facts.rehearsalCompletedAt,
    "[rollback-bundle] rehearsalCompletedAt",
    context,
  );

  if (!Array.isArray(facts.components)) {
    throw new Error("[rollback-bundle] components must be an array");
  }
  if (facts.components.length !== REQUIRED_ROLLBACK_COMPONENTS.length) {
    issues.add("rollback-component-inventory-incomplete");
  }
  const digests = new Set();
  for (let index = 0; index < facts.components.length; index += 1) {
    const component = requireObject(
      facts.components[index],
      "[rollback-bundle] component",
    );
    exactKeys(
      component,
      ["bytes", "digestSha256", "kind", "status", "verifiedAt"],
      "[rollback-bundle] component",
    );
    if (component.kind !== REQUIRED_ROLLBACK_COMPONENTS[index]) {
      issues.add("rollback-component-order-or-kind-mismatch");
    }
    checkPassStatus(
      component.status,
      "rollback-component-status-not-pass",
      issues,
      "[rollback-bundle] component status",
    );
    requireInteger(
      component.bytes,
      1,
      MAX_COUNT,
      "[rollback-bundle] component bytes",
    );
    requireSha256(component.digestSha256, "[rollback-bundle] component digest");
    if (digests.has(component.digestSha256)) {
      issues.add("rollback-component-digest-reused");
    }
    digests.add(component.digestSha256);
    requireEventTimestamp(
      component.verifiedAt,
      "[rollback-bundle] component verifiedAt",
      context,
    );
    if (
      component.kind === "go-runtime" &&
      component.digestSha256 !== context.candidate.goArtifactDigestSha256
    ) {
      issues.add("rollback-go-runtime-mismatch");
    }
  }
  return { issues, meta: { rehearsalCompletedAt } };
}

function validateCrossEvidence(byKind) {
  const ingress = byKind.get("ingress-drain");
  const persistence = byKind.get("persistence-stability");
  const processState = byKind.get("process-state-drain");
  const scheduler = byKind.get("scheduler-ownership");
  const sync = byKind.get("bidirectional-sync");
  const pending = byKind.get("pending-work");

  const lastAcceptedAt = ingress.meta.lastAcceptedAt;
  const drainStartedAt = ingress.meta.drainStartedAt;
  const observationEndedAt = ingress.meta.observationEndedAt;
  const flushes = persistence.meta.flushes;
  if (flushes.length > 0 && flushes[0].startedAt.getTime() < lastAcceptedAt.getTime()) {
    persistence.issues.add("flush-starts-before-last-acceptance");
  }
  if (flushes.length >= 2) {
    const requiredCompleteAt =
      lastAcceptedAt.getTime() + persistence.meta.batchIntervalSeconds * 2 * 1000;
    if (flushes.at(-1).completedAt.getTime() < requiredCompleteAt) {
      persistence.issues.add("two-batch-intervals-not-observed");
    }
  }
  const requiredExportAt =
    lastAcceptedAt.getTime() + persistence.meta.exportIntervalSeconds * 1000;
  if (
    persistence.meta.exportStartedAt.getTime() < lastAcceptedAt.getTime() ||
    persistence.meta.exportCompletedAt.getTime() < requiredExportAt
  ) {
    persistence.issues.add("full-export-interval-not-observed");
  }
  if (
    persistence.meta.stableAt &&
    persistence.meta.stableAt.getTime() < observationEndedAt.getTime()
  ) {
    persistence.issues.add("database-stability-precedes-ingress-drain");
  }
  if (persistence.meta.stableAt) {
    for (const observedAt of processState.meta.observedAt) {
      if (observedAt.getTime() < persistence.meta.stableAt.getTime()) {
        processState.issues.add("process-state-observed-before-persistence-stable");
      }
    }
    for (const observedAt of sync.meta.observedAt) {
      if (observedAt.getTime() < persistence.meta.stableAt.getTime()) {
        sync.issues.add("sync-observed-before-persistence-stable");
      }
    }
  }
  for (const observedAt of scheduler.meta.observedAt) {
    if (observedAt.getTime() < drainStartedAt.getTime()) {
      scheduler.issues.add("scheduler-ownership-predates-drain");
    }
  }
  for (const capturedAt of pending.meta.capturedAt) {
    if (capturedAt.getTime() < observationEndedAt.getTime()) {
      pending.issues.add("pending-work-observed-before-ingress-drain");
    }
  }
}

async function readCanonicalJson(file, label, maxBytes) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`[input] ${label} path is required`);
  }
  const resolved = path.resolve(file);
  const initialStats = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !initialStats ||
    !initialStats.isFile() ||
    initialStats.isSymbolicLink() ||
    initialStats.nlink !== 1n
  ) {
    throw new Error(`[input] ${label} must be a regular non-symlink single-link file`);
  }
  if (initialStats.size <= 0n || initialStats.size > BigInt(maxBytes)) {
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
    if (
      !openedStats.isFile() ||
      openedStats.nlink !== 1n ||
      !sameFileSnapshot(initialStats, openedStats)
    ) {
      throw new Error(`[input] ${label} changed before it was opened`);
    }
    openedRealPath = await realpath(resolved);
    if (!samePath(resolved, openedRealPath)) {
      throw new Error(`[input] ${label} must not traverse a symbolic link`);
    }
    const realStats = await lstat(openedRealPath, { bigint: true });
    if (!sameFileIdentity(openedStats, realStats)) {
      throw new Error(`[input] ${label} real path changed before it was read`);
    }
    bytes = await readExactBoundedBytes(
      handle,
      Number(openedStats.size),
      label,
    );
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
      !finalRealPath ||
      !samePath(finalRealPath, openedRealPath)
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
  assertRedactedJson(value, label);
  const expected = `${canonicalJson(value)}\n`;
  if (text !== expected) {
    throw new Error(`[input] ${label} must use canonical JSON plus one newline`);
  }
  return { resolved, realPath: openedRealPath, bytes, value };
}

async function readExactBoundedBytes(handle, byteLength, label) {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      byteLength - offset,
      offset,
    );
    if (bytesRead === 0) {
      throw new Error(`[input] ${label} changed while it was read`);
    }
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: trailingBytes } = await handle.read(
    probe,
    0,
    1,
    byteLength,
  );
  if (trailingBytes !== 0) {
    throw new Error(`[input] ${label} changed while it was read`);
  }
  return bytes;
}

function assertRedactedJson(root, label) {
  const stack = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error(`[redaction] ${label} exceeds JSON shape bounds`);
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("[canonical] numbers must be safe integers");
      }
      continue;
    }
    if (typeof value === "string") {
      if (
        Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES ||
        value.includes("\n") ||
        value.includes("\r") ||
        value.includes("\0")
      ) {
        throw new Error(`[redaction] ${label} contains an unsafe string`);
      }
      if (looksLikeCredentialValue(value)) {
        throw new Error(`[redaction] ${label} contains a credential-shaped value`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isPlainObject(value)) {
      throw new Error(`[redaction] ${label} contains a non-JSON value`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
        throw new Error(`[redaction] ${label} contains an invalid field name`);
      }
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        prohibitedFieldNames.has(normalized) ||
        prohibitedFieldFragments.some((fragment) => normalized.includes(fragment))
      ) {
        throw new Error(`[redaction] ${label} contains a prohibited field`);
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function looksLikeCredentialValue(value) {
  return (
    /^Bearer\s+/i.test(value) ||
    /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----$/.test(value) ||
    /^(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}$/.test(value) ||
    /^(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}$/.test(value) ||
    /^AKIA[0-9A-Z]{16}$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
  );
}

async function assertNoSymlinkComponents(root, file) {
  const relative = path.relative(root, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("[path] evidence path escapes the bundle");
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stats = await lstat(current, { bigint: true }).catch(() => null);
    if (!stats) throw new Error("[path] evidence path is missing");
    if (stats.isSymbolicLink()) {
      throw new Error("[path] evidence path must not contain symbolic links");
    }
  }
}

function requireEventTimestamp(value, label, context) {
  const timestamp = requireTimestamp(value, label);
  if (timestamp.getTime() < context.freezeAt.getTime()) {
    throw new Error(`${label} predates the frozen cohort`);
  }
  if (timestamp.getTime() > context.capturedAt.getTime()) {
    throw new Error(`${label} follows evidence capture`);
  }
  return timestamp;
}

function checkPassStatus(value, issue, issues, label) {
  const status = requireStatus(value, label);
  if (status !== "pass") issues.add(issue);
  return status;
}

function requireStatus(value, label) {
  return requireEnum(value, EVIDENCE_STATUSES, label);
}

function requireSortedUniqueIds(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    requireToken(value[index], opaqueIdPattern, label);
    if (index > 0 && value[index - 1] >= value[index]) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
  return value;
}

function laterDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
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

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
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
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO timestamp`);
  }
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
