import { createHash } from "node:crypto";

export const SHARD_REGISTRY_CAPTURE_CONTRACT =
  "cinatoken-relay-container-shard-registry-capture-v1";
export const SHARD_ACTIVATION_LEDGER_CONTRACT =
  "cinatoken-relay-container-shard-activation-v1";
export const SHARD_REGISTRY_COLLECTOR_VERSION = 1;

export const MAX_SHARD_COUNT = 1_024;
export const MAX_LEDGER_RECORDS = 4_096;
export const ACTIVATION_PAGE_SIZE = 64;

const MIN_OBSERVATION_SECONDS = 5 * 60;
const MAX_OBSERVATION_SECONDS = 2 * 60 * 60;
const ACTIVATION_FRESHNESS_SECONDS = 2 * 60 * 60;
const ACTIVATION_CLOCK_SKEW_SECONDS = 60;

const activationDigestDomain = Buffer.from(
  "cinatoken:relay-container-shard-activation:v1\0",
  "utf8",
);
const lowerSha256Pattern = /^[0-9a-f]{64}$/;
const versionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;

const activationRecordKeys = Object.freeze([
  "registry_event_sequence",
  "shard_count",
  "shard_index",
  "instance_name",
  "shard_contract_version",
  "runtime_protocol_version",
  "runtime_contract_version",
  "runtime_build_id",
  "activation_generation",
  "activation_probe_generation",
  "environment",
  "container_status",
  "readiness_result_code",
  "process_ready",
  "runtime_execution_enabled",
  "controller_execution_enabled",
  "activation_digest_sha256",
  "activated_at",
]);

export class ShardRegistryError extends Error {}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function activationDigestSha256({ controllerVersionId, ringGeneration, record }) {
  requireToken(controllerVersionId, versionIdPattern, "Controller version ID");
  requireInteger(ringGeneration, 1, 1_000_000, "ring generation");
  validateActivationRecordShape(record);
  const values = [
    controllerVersionId,
    ringGeneration,
    record.shard_count,
    record.shard_index,
    record.instance_name,
    record.shard_contract_version,
    record.runtime_protocol_version,
    record.runtime_contract_version,
    record.runtime_build_id,
    record.activation_generation,
    record.activation_probe_generation,
    record.environment,
    record.container_status,
    record.readiness_result_code,
    Number(record.process_ready),
    Number(record.runtime_execution_enabled),
    Number(record.controller_execution_enabled),
    record.activated_at,
  ];
  const hash = createHash("sha256");
  hash.update(activationDigestDomain);
  for (const value of values) {
    const bytes = Buffer.from(String(value), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function validateActivationPage(value, expected = {}) {
  const page = requireObject(value, "activation page");
  exactKeys(
    page,
    [
      "contract_version",
      "ledger_contract",
      "controller_version_id",
      "ring_generation",
      "high_watermark",
      "total_records",
      "count",
      "next_cursor",
      "pagination_complete",
      "records",
    ],
    "activation page",
  );
  requireExact(page.contract_version, 1, "activation page contract version");
  requireExact(page.ledger_contract, SHARD_ACTIVATION_LEDGER_CONTRACT, "activation ledger");
  requireToken(page.controller_version_id, versionIdPattern, "activation Controller version ID");
  requireInteger(page.ring_generation, 1, 1_000_000, "activation ring generation");
  requireInteger(page.high_watermark, 0, Number.MAX_SAFE_INTEGER, "activation high watermark");
  requireInteger(page.total_records, 0, MAX_LEDGER_RECORDS, "activation total records");
  requireInteger(page.count, 0, ACTIVATION_PAGE_SIZE, "activation page count");
  requireBoolean(page.pagination_complete, "activation pagination status");
  if (page.next_cursor !== null) {
    requireToken(page.next_cursor, /^[1-9][0-9]{0,15}$/, "activation next cursor");
  }
  if (!Array.isArray(page.records) || page.records.length !== page.count) {
    throw new ShardRegistryError("activation page count does not match records");
  }
  if (page.pagination_complete !== (page.next_cursor === null)) {
    throw new ShardRegistryError("activation page terminal cursor is inconsistent");
  }
  if (expected.controllerVersionId !== undefined) {
    requireExact(
      page.controller_version_id,
      expected.controllerVersionId,
      "activation Controller version ID",
    );
  }
  if (expected.ringGeneration !== undefined) {
    requireExact(page.ring_generation, expected.ringGeneration, "activation ring generation");
  }
  if (expected.highWatermark !== undefined) {
    requireExact(page.high_watermark, expected.highWatermark, "activation high watermark");
  }
  if (expected.totalRecords !== undefined) {
    requireExact(page.total_records, expected.totalRecords, "activation total records");
  }

  let previousSequence = expected.afterSequence ?? 0;
  const records = page.records.map((record) => {
    validateActivationRecord(record, {
      controllerVersionId: page.controller_version_id,
      ringGeneration: page.ring_generation,
      highWatermark: page.high_watermark,
    });
    if (record.registry_event_sequence <= previousSequence) {
      throw new ShardRegistryError("activation records are not strictly ordered");
    }
    previousSequence = record.registry_event_sequence;
    return record;
  });
  if (page.next_cursor !== null) {
    if (records.length === 0 || page.next_cursor !== String(previousSequence)) {
      throw new ShardRegistryError("activation next cursor does not match the last record");
    }
  }
  return { ...page, records };
}

export function buildActivationSnapshot({ capturedAt, pages }) {
  requireTimestamp(capturedAt, "activation snapshot capturedAt");
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 65) {
    throw new ShardRegistryError("activation snapshot page inventory is invalid");
  }
  const normalizedPages = [];
  const seenCursors = new Set();
  let controllerVersionId;
  let ringGeneration;
  let highWatermark;
  let totalRecords;
  let afterSequence = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = validateActivationPage(pages[index], {
      ...(index === 0
        ? {}
        : { controllerVersionId, ringGeneration, highWatermark, totalRecords }),
      afterSequence,
    });
    if (index === 0) {
      controllerVersionId = page.controller_version_id;
      ringGeneration = page.ring_generation;
      highWatermark = page.high_watermark;
      totalRecords = page.total_records;
    }
    if (index + 1 < pages.length && page.pagination_complete) {
      throw new ShardRegistryError("activation pagination ended before the final page");
    }
    if (index + 1 === pages.length && !page.pagination_complete) {
      throw new ShardRegistryError("activation pagination did not reach a terminal page");
    }
    if (page.next_cursor !== null && !seenCursors.add(page.next_cursor)) {
      throw new ShardRegistryError("activation pagination repeated a cursor");
    }
    if (page.records.length > 0) {
      afterSequence = page.records.at(-1).registry_event_sequence;
    }
    normalizedPages.push(page);
  }
  const records = normalizedPages.flatMap((page) => page.records);
  if (records.length !== totalRecords) {
    throw new ShardRegistryError("activation snapshot did not enumerate every record");
  }
  if ((records.at(-1)?.registry_event_sequence ?? 0) !== highWatermark) {
    throw new ShardRegistryError("activation snapshot did not reach the frozen high watermark");
  }
  return {
    capturedAt,
    controllerVersionId,
    ringGeneration,
    highWatermark,
    totalRecords,
    pageCount: normalizedPages.length,
    paginationComplete: true,
    entriesSha256: sha256Canonical(records),
    records,
  };
}

export function buildShardRegistryCapture({ candidate, observationStartedAt, observationEndedAt, before, after }) {
  candidate = validateRegistryCandidate(candidate);
  requireTimestamp(observationStartedAt, "registry observation start");
  requireTimestamp(observationEndedAt, "registry observation end");
  const observationSeconds =
    (Date.parse(observationEndedAt) - Date.parse(observationStartedAt)) / 1_000;
  if (
    observationSeconds < MIN_OBSERVATION_SECONDS ||
    observationSeconds > MAX_OBSERVATION_SECONDS
  ) {
    throw new ShardRegistryError("registry observation window is invalid");
  }
  before = validateSnapshot(before, candidate, "before");
  after = validateSnapshot(after, candidate, "after");
  requireExact(
    before.capturedAt,
    observationStartedAt,
    "before activation observation boundary",
  );
  requireExact(
    after.capturedAt,
    observationEndedAt,
    "after activation observation boundary",
  );

  const blockers = [];
  if (before.highWatermark !== after.highWatermark) blockers.push("activation-high-watermark-drift");
  if (before.totalRecords !== after.totalRecords) blockers.push("activation-record-count-drift");
  if (before.entriesSha256 !== after.entriesSha256) blockers.push("activation-entry-drift");
  if (canonicalJson(before.records) !== canonicalJson(after.records)) {
    blockers.push("activation-record-drift");
  }

  const assessment = assessCandidateRows(
    after.records,
    candidate,
    observationStartedAt,
  );
  blockers.push(...assessment.blockers);
  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    schemaVersion: 1,
    contract: SHARD_REGISTRY_CAPTURE_CONTRACT,
    environment: "staging",
    collectorVersion: SHARD_REGISTRY_COLLECTOR_VERSION,
    candidate,
    observationStartedAt,
    observationEndedAt,
    before,
    after,
    stableEntriesSha256: before.entriesSha256,
    verifiedShardCount: assessment.verifiedShardCount,
    missingShardCount: assessment.missingShardCount,
    duplicateShardCount: assessment.duplicateShardCount,
    unknownShardCount: assessment.unknownShardCount,
    paginationComplete: true,
    evidenceReady: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    safetyBoundary: {
      customerTrafficEligible: false,
      deployOrRollbackExecuted: false,
      providerRequestPerformed: false,
      remoteMutationPerformed: false,
      shardDoOrContainerWakePerformed: false,
    },
  };
}

export function validateShardRegistryCapture(value, expectedCandidate = undefined) {
  const capture = requireObject(value, "shard registry capture");
  exactKeys(
    capture,
    [
      "schemaVersion",
      "contract",
      "environment",
      "collectorVersion",
      "candidate",
      "observationStartedAt",
      "observationEndedAt",
      "before",
      "after",
      "stableEntriesSha256",
      "verifiedShardCount",
      "missingShardCount",
      "duplicateShardCount",
      "unknownShardCount",
      "paginationComplete",
      "evidenceReady",
      "blockers",
      "safetyBoundary",
    ],
    "shard registry capture",
  );
  const rebuilt = buildShardRegistryCapture({
    candidate: capture.candidate,
    observationStartedAt: capture.observationStartedAt,
    observationEndedAt: capture.observationEndedAt,
    before: capture.before,
    after: capture.after,
  });
  if (canonicalJson(capture) !== canonicalJson(rebuilt)) {
    throw new ShardRegistryError("shard registry capture contains derived-field drift");
  }
  if (expectedCandidate !== undefined) {
    const expected = validateRegistryCandidate(expectedCandidate);
    if (canonicalJson(rebuilt.candidate) !== canonicalJson(expected)) {
      throw new ShardRegistryError("shard registry candidate does not match P5 candidate");
    }
  }
  return rebuilt;
}

export function validateRegistryCandidate(value) {
  const candidate = requireObject(value, "shard registry candidate");
  exactKeys(
    candidate,
    [
      "controllerVersionId",
      "runtimeBuildId",
      "containerImageDigest",
      "imageProvenanceSha256",
      "ringGeneration",
      "shardCount",
    ],
    "shard registry candidate",
  );
  requireToken(candidate.controllerVersionId, versionIdPattern, "candidate Controller version ID");
  requireToken(candidate.runtimeBuildId, lowerSha256Pattern, "candidate runtime build ID");
  requireToken(candidate.containerImageDigest, imageDigestPattern, "candidate Container image digest");
  requireToken(candidate.imageProvenanceSha256, lowerSha256Pattern, "candidate image provenance digest");
  requireInteger(candidate.ringGeneration, 1, 1_000_000, "candidate ring generation");
  requireInteger(candidate.shardCount, 1, MAX_SHARD_COUNT, "candidate shard count");
  return { ...candidate };
}

function validateSnapshot(snapshot, candidate, label) {
  snapshot = requireObject(snapshot, `${label} activation snapshot`);
  exactKeys(
    snapshot,
    [
      "capturedAt",
      "controllerVersionId",
      "ringGeneration",
      "highWatermark",
      "totalRecords",
      "pageCount",
      "paginationComplete",
      "entriesSha256",
      "records",
    ],
    `${label} activation snapshot`,
  );
  requireTimestamp(snapshot.capturedAt, `${label} activation capturedAt`);
  requireExact(snapshot.controllerVersionId, candidate.controllerVersionId, `${label} Controller version`);
  requireExact(snapshot.ringGeneration, candidate.ringGeneration, `${label} ring generation`);
  requireInteger(snapshot.highWatermark, 0, Number.MAX_SAFE_INTEGER, `${label} high watermark`);
  requireInteger(snapshot.totalRecords, 0, MAX_LEDGER_RECORDS, `${label} total records`);
  requireInteger(snapshot.pageCount, 1, 65, `${label} page count`);
  requireExact(snapshot.paginationComplete, true, `${label} pagination complete`);
  requireToken(snapshot.entriesSha256, lowerSha256Pattern, `${label} entries digest`);
  if (!Array.isArray(snapshot.records) || snapshot.records.length !== snapshot.totalRecords) {
    throw new ShardRegistryError(`${label} activation record count is invalid`);
  }
  let previous = 0;
  for (const record of snapshot.records) {
    validateActivationRecord(record, {
      controllerVersionId: candidate.controllerVersionId,
      ringGeneration: candidate.ringGeneration,
      highWatermark: snapshot.highWatermark,
    });
    if (record.registry_event_sequence <= previous) {
      throw new ShardRegistryError(`${label} activation records are not strictly ordered`);
    }
    previous = record.registry_event_sequence;
  }
  requireExact(previous, snapshot.highWatermark, `${label} frozen high watermark`);
  requireExact(snapshot.entriesSha256, sha256Canonical(snapshot.records), `${label} entries digest`);
  return snapshot;
}

function assessCandidateRows(records, candidate, observationStartedAt) {
  const candidateByShard = new Map();
  let unknownShardCount = 0;
  let staleActivationCount = 0;
  const observationStartedSeconds = Date.parse(observationStartedAt) / 1_000;
  const minimumActivatedAt =
    observationStartedSeconds - ACTIVATION_FRESHNESS_SECONDS;
  const maximumActivatedAt =
    observationStartedSeconds + ACTIVATION_CLOCK_SKEW_SECONDS;
  for (const record of records) {
    const matches =
      record.runtime_build_id === candidate.runtimeBuildId &&
      record.shard_count === candidate.shardCount &&
      record.shard_contract_version === 1 &&
      record.runtime_protocol_version === 1 &&
      record.runtime_contract_version === 1 &&
      record.activation_generation === 1 &&
      record.environment === "staging" &&
      record.container_status === "healthy" &&
      record.readiness_result_code === "process_ready_execution_disabled" &&
      record.process_ready === true &&
      record.runtime_execution_enabled === false &&
      record.controller_execution_enabled === false;
    if (!matches) {
      unknownShardCount += 1;
      continue;
    }
    if (
      record.activated_at < minimumActivatedAt ||
      record.activated_at > maximumActivatedAt
    ) {
      staleActivationCount += 1;
      continue;
    }
    const rows = candidateByShard.get(record.shard_index) ?? [];
    rows.push(record);
    candidateByShard.set(record.shard_index, rows);
  }
  let verifiedShardCount = 0;
  let missingShardCount = 0;
  let duplicateShardCount = 0;
  for (let shardIndex = 0; shardIndex < candidate.shardCount; shardIndex += 1) {
    const rows = candidateByShard.get(shardIndex) ?? [];
    if (rows.length === 0) missingShardCount += 1;
    else if (rows.length === 1) verifiedShardCount += 1;
    else duplicateShardCount += rows.length - 1;
  }
  for (const shardIndex of candidateByShard.keys()) {
    if (shardIndex < 0 || shardIndex >= candidate.shardCount) unknownShardCount += 1;
  }
  const blockers = [];
  if (verifiedShardCount !== candidate.shardCount) blockers.push("candidate-shards-incomplete");
  if (missingShardCount !== 0) blockers.push("candidate-shards-missing");
  if (duplicateShardCount !== 0) blockers.push("candidate-shards-duplicated");
  if (unknownShardCount !== 0) blockers.push("unknown-shard-activations-present");
  if (staleActivationCount !== 0) blockers.push("candidate-shard-activations-stale");
  return { verifiedShardCount, missingShardCount, duplicateShardCount, unknownShardCount, blockers };
}

function validateActivationRecord(record, { controllerVersionId, ringGeneration, highWatermark }) {
  validateActivationRecordShape(record);
  requireInteger(record.registry_event_sequence, 1, highWatermark, "activation event sequence");
  requireInteger(record.shard_count, 1, MAX_SHARD_COUNT, "activation shard count");
  requireInteger(record.shard_index, 0, record.shard_count - 1, "activation shard index");
  requireExact(
    record.instance_name,
    `cinatoken-relay-shard-v1-${String(record.shard_index).padStart(4, "0")}`,
    "activation instance name",
  );
  for (const [field, label] of [
    ["shard_contract_version", "activation shard contract"],
    ["runtime_protocol_version", "activation runtime protocol"],
    ["runtime_contract_version", "activation runtime contract"],
    ["activation_generation", "activation generation"],
    ["activation_probe_generation", "activation probe generation"],
  ]) {
    requireInteger(record[field], 1, 1_000_000, label);
  }
  requireToken(record.runtime_build_id, lowerSha256Pattern, "activation runtime build ID");
  requireExact(record.environment, "staging", "activation environment");
  requireExact(record.container_status, "healthy", "activation Container status");
  if (![
    "process_ready_execution_disabled",
    "execution_ready",
  ].includes(record.readiness_result_code)) {
    throw new ShardRegistryError("activation readiness result is invalid");
  }
  requireBoolean(record.process_ready, "activation process readiness");
  requireBoolean(record.runtime_execution_enabled, "activation runtime execution gate");
  requireBoolean(record.controller_execution_enabled, "activation Controller execution gate");
  requireExact(record.process_ready, true, "activation process readiness");
  if (
    record.readiness_result_code === "execution_ready" &&
    (!record.runtime_execution_enabled || !record.controller_execution_enabled)
  ) {
    throw new ShardRegistryError("execution-ready activation has a disabled gate");
  }
  if (
    record.readiness_result_code === "process_ready_execution_disabled" &&
    record.runtime_execution_enabled &&
    record.controller_execution_enabled
  ) {
    throw new ShardRegistryError("disabled activation has no disabled gate");
  }
  requireToken(record.activation_digest_sha256, lowerSha256Pattern, "activation digest");
  requireInteger(record.activated_at, 1, Number.MAX_SAFE_INTEGER, "activation timestamp");
  requireExact(
    record.activation_digest_sha256,
    activationDigestSha256({ controllerVersionId, ringGeneration, record }),
    "activation digest",
  );
}

function validateActivationRecordShape(record) {
  record = requireObject(record, "activation record");
  exactKeys(record, activationRecordKeys, "activation record");
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ShardRegistryError("canonical numbers must be safe integers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const object = requireObject(value, "canonical object");
  const result = Object.create(null);
  for (const key of Object.keys(object).sort()) result[key] = canonicalValue(object[key]);
  return result;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShardRegistryError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ShardRegistryError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ShardRegistryError(`${label} fields are invalid`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new ShardRegistryError(`${label} is invalid`);
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new ShardRegistryError(`${label} is invalid`);
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}
