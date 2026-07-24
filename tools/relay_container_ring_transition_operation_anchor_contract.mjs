import {
  canonicalReceiptBytes,
  sha256ReceiptBytes,
} from "./relay_container_ring_transition_receipt_contract.mjs";

export const RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT =
  "cinatoken-ring-transition-runner-operation-head-set-v1";
export const RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT =
  "cinatoken-ring-transition-runner-operation-head-local-seal-v1";
export const MAX_RING_TRANSITION_OPERATION_HEAD_BYTES = 64 * 1024;
export const MAX_RING_TRANSITION_OPERATION_CAPACITY = 128;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES = 320 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CHAIN_STATES = new Set(["marker_only", "terminal"]);
const OPERATION_OUTCOMES = new Set([
  "accepted",
  "rejected",
  "ambiguous",
]);
const TERMINAL_STATE_VERSIONS = new Map([
  ["completed", new Set([6])],
  ["recovery_required", new Set([3, 4, 5, 6])],
  ["aborted", new Set([1, 2])],
  ["expired", new Set([1, 2])],
]);
const HEAD_SET_KEYS = [
  "schemaVersion",
  "contract",
  "environment",
  "activationSha256",
  "authorizationIdSha256",
  "claimDigestSha256",
  "operationContextSha256",
  "capacityLimit",
  "operationCount",
  "capacityReservationCount",
  "markerOnlyCount",
  "entries",
];
const HEAD_SET_ENTRY_KEYS = [
  "slot",
  "operationIdSha256",
  "chainState",
  "startReceiptSha256",
  "receiptCount",
  "headSha256",
  "outcome",
];
const LOCAL_SEAL_KEYS = [
  "schemaVersion",
  "contract",
  "environment",
  "activationSha256",
  "authorizationIdSha256",
  "claimDigestSha256",
  "operationContextSha256",
  "executionReceiptHeadSha256",
  "executionReceiptCount",
  "terminalStatus",
  "terminalStateVersion",
  "operationHeadSetSha256",
  "operationHeadSetBytes",
  "operationCount",
  "capacityReservationCount",
  "markerOnlyCount",
  "terminalSnapshotCandidateSha256",
  "terminalSnapshotCandidateBytes",
  "terminalCandidateOperationIdSha256",
  "terminalCandidateStartReceiptSha256",
];
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function describeRingTransitionOperationAnchorContract() {
  return {
    ok: true,
    schemaVersion: 1,
    headSetContract: RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
    localSealContract:
      RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
    environment: "staging",
    verificationScope: "supplied_operation_anchor_documents",
    maximumBytesPerDocument:
      MAX_RING_TRANSITION_OPERATION_HEAD_BYTES,
    maximumCapacityReservations:
      MAX_RING_TRANSITION_OPERATION_CAPACITY,
    constraints: {
      canonicalJsonRequired: true,
      duplicateAndUnknownFieldsAllowed: false,
      suppliedEntriesMustBeSlotSortedAndUnique: true,
      suppliedTerminalEntriesMustBeStructurallyComplete: true,
      suppliedMarkerOnlyEntriesMustRemainVisible: true,
      suppliedHeadSetStructureVerified: true,
      suppliedLocalSealBindingVerified: true,
      suppliedTerminalCandidateOperationBindingEnforced: true,
      executionChainVerified: false,
      operationContextPreimageVerified: false,
      operationReceiptHeadsVerified: false,
      capacityMarkerFilesystemCompletenessVerified: false,
      terminalSnapshotCandidateContentVerified: false,
      localFilesystemCompletenessVerified: false,
      absoluteHttpsTargetVerified: false,
      detachedSignatureVerified: false,
      wormStorageVerified: false,
      externalAnchored: false,
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      remoteMutationAuthorized: false,
    },
  };
}

export function verifyRingTransitionOperationHeadSet(canonicalBytes) {
  const parsed = parseCanonicalDocument(
    canonicalBytes,
    "operation head set",
  );
  const headSet = validateHeadSet(parsed.value);
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
    environment: "staging",
    verificationScope: "supplied_operation_head_set_document",
    suppliedHeadSetStructureVerified: true,
    suppliedLocalSealBindingVerified: false,
    suppliedTerminalCandidateOperationBindingVerified: false,
    executionChainVerified: false,
    operationContextPreimageVerified: false,
    operationReceiptHeadsVerified: false,
    capacityMarkerFilesystemCompletenessVerified: false,
    terminalSnapshotCandidateContentVerified: false,
    localFilesystemCompletenessVerified: false,
    absoluteHttpsTargetVerified: false,
    detachedSignatureVerified: false,
    wormStorageVerified: false,
    externalAnchored: false,
    activationSha256: headSet.activationSha256,
    authorizationIdSha256: headSet.authorizationIdSha256,
    claimDigestSha256: headSet.claimDigestSha256,
    operationContextSha256: headSet.operationContextSha256,
    capacityLimit: headSet.capacityLimit,
    operationCount: headSet.operationCount,
    capacityReservationCount: headSet.capacityReservationCount,
    markerOnlyCount: headSet.markerOnlyCount,
    headSetSha256: parsed.sha256,
    headSetBytes: parsed.bytes.byteLength,
  });
}

export function verifyRingTransitionOperationHeadLocalSeal({
  headSetBytes,
  localSealBytes,
}) {
  const parsedHeadSet = parseCanonicalDocument(
    headSetBytes,
    "operation head set",
  );
  const headSet = validateHeadSet(parsedHeadSet.value);
  const parsedSeal = parseCanonicalDocument(
    localSealBytes,
    "operation head local seal",
  );
  const seal = validateLocalSeal(parsedSeal.value);

  for (const field of [
    "activationSha256",
    "authorizationIdSha256",
    "claimDigestSha256",
    "operationContextSha256",
    "operationCount",
    "capacityReservationCount",
    "markerOnlyCount",
  ]) {
    if (seal[field] !== headSet[field]) {
      throw new Error(`[local seal] ${field} does not match head set`);
    }
  }
  if (seal.operationHeadSetSha256 !== parsedHeadSet.sha256) {
    throw new Error("[local seal] operation head set SHA-256 mismatch");
  }
  if (seal.operationHeadSetBytes !== parsedHeadSet.bytes.byteLength) {
    throw new Error("[local seal] operation head set byte length mismatch");
  }
  const suppliedTerminalCandidateOperationBindingVerified =
    verifyTerminalCandidateOperationBinding(seal, headSet);

  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
    environment: "staging",
    verificationScope: "supplied_operation_anchor_documents",
    suppliedHeadSetStructureVerified: true,
    suppliedLocalSealBindingVerified: true,
    suppliedTerminalCandidateOperationBindingVerified,
    executionChainVerified: false,
    operationContextPreimageVerified: false,
    operationReceiptHeadsVerified: false,
    capacityMarkerFilesystemCompletenessVerified: false,
    terminalSnapshotCandidateContentVerified: false,
    localFilesystemCompletenessVerified: false,
    absoluteHttpsTargetVerified: false,
    detachedSignatureVerified: false,
    wormStorageVerified: false,
    externalAnchored: false,
    activationSha256: seal.activationSha256,
    authorizationIdSha256: seal.authorizationIdSha256,
    claimDigestSha256: seal.claimDigestSha256,
    operationContextSha256: seal.operationContextSha256,
    executionReceiptHeadSha256: seal.executionReceiptHeadSha256,
    executionReceiptCount: seal.executionReceiptCount,
    terminalStatus: seal.terminalStatus,
    terminalStateVersion: seal.terminalStateVersion,
    operationCount: seal.operationCount,
    capacityReservationCount: seal.capacityReservationCount,
    markerOnlyCount: seal.markerOnlyCount,
    terminalSnapshotCandidateSha256:
      seal.terminalSnapshotCandidateSha256,
    terminalSnapshotCandidateBytes:
      seal.terminalSnapshotCandidateBytes,
    terminalCandidateOperationIdSha256:
      seal.terminalCandidateOperationIdSha256,
    terminalCandidateStartReceiptSha256:
      seal.terminalCandidateStartReceiptSha256,
    headSetSha256: parsedHeadSet.sha256,
    headSetBytes: parsedHeadSet.bytes.byteLength,
    localSealSha256: parsedSeal.sha256,
    localSealBytes: parsedSeal.bytes.byteLength,
  });
}

function verifyTerminalCandidateOperationBinding(seal, headSet) {
  if (seal.terminalCandidateOperationIdSha256 === null) {
    return false;
  }
  const entry = headSet.entries.find(
    (candidate) =>
      candidate.operationIdSha256 ===
      seal.terminalCandidateOperationIdSha256,
  );
  if (!entry) {
    throw new Error(
      "[local seal] terminal candidate operation is missing from supplied head set",
    );
  }
  if (entry.chainState !== "terminal") {
    throw new Error(
      "[local seal] terminal candidate operation must reference a terminal supplied entry",
    );
  }
  if (entry.outcome !== "accepted") {
    throw new Error(
      "[local seal] terminal candidate operation must reference an accepted supplied entry",
    );
  }
  if (
    entry.startReceiptSha256 !==
    seal.terminalCandidateStartReceiptSha256
  ) {
    throw new Error(
      "[local seal] terminal candidate start receipt does not match supplied entry",
    );
  }
  return true;
}

function validateHeadSet(value) {
  const headSet = requireObject(value, "[head set]");
  exactKeys(headSet, HEAD_SET_KEYS, "[head set]");
  requireExact(headSet.schemaVersion, 1, "[head set] schemaVersion");
  requireExact(
    headSet.contract,
    RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
    "[head set] contract",
  );
  requireExact(headSet.environment, "staging", "[head set] environment");
  for (const field of [
    "activationSha256",
    "authorizationIdSha256",
    "claimDigestSha256",
    "operationContextSha256",
  ]) {
    requireSha256(headSet[field], `[head set] ${field}`);
  }
  requireExact(
    headSet.capacityLimit,
    MAX_RING_TRANSITION_OPERATION_CAPACITY,
    "[head set] capacityLimit",
  );
  for (const field of [
    "operationCount",
    "capacityReservationCount",
    "markerOnlyCount",
  ]) {
    requireInteger(
      headSet[field],
      0,
      MAX_RING_TRANSITION_OPERATION_CAPACITY,
      `[head set] ${field}`,
    );
  }
  if (!Array.isArray(headSet.entries)) {
    throw new TypeError("[head set] entries must be an array");
  }
  if (
    headSet.entries.length !== headSet.capacityReservationCount ||
    headSet.operationCount + headSet.markerOnlyCount !==
      headSet.capacityReservationCount
  ) {
    throw new Error("[head set] aggregate counts are inconsistent");
  }

  let previousSlot = -1;
  let terminalCount = 0;
  let markerOnlyCount = 0;
  const operationIds = new Set();
  for (const [index, rawEntry] of headSet.entries.entries()) {
    const entry = validateHeadSetEntry(rawEntry, index);
    if (entry.slot <= previousSlot) {
      throw new Error("[head set] entries must be strictly slot-sorted");
    }
    previousSlot = entry.slot;
    if (operationIds.has(entry.operationIdSha256)) {
      throw new Error("[head set] operation IDs must be unique");
    }
    operationIds.add(entry.operationIdSha256);
    if (entry.chainState === "terminal") {
      terminalCount += 1;
    } else {
      markerOnlyCount += 1;
    }
  }
  if (
    terminalCount !== headSet.operationCount ||
    markerOnlyCount !== headSet.markerOnlyCount
  ) {
    throw new Error("[head set] entry state counts are inconsistent");
  }
  return headSet;
}

function validateHeadSetEntry(value, index) {
  const label = `[head set] entry ${index}`;
  const entry = requireObject(value, label);
  exactKeys(entry, HEAD_SET_ENTRY_KEYS, label);
  requireInteger(
    entry.slot,
    0,
    MAX_RING_TRANSITION_OPERATION_CAPACITY - 1,
    `${label} slot`,
  );
  requireSha256(entry.operationIdSha256, `${label} operationIdSha256`);
  requireEnum(entry.chainState, CHAIN_STATES, `${label} chainState`);
  if (entry.chainState === "marker_only") {
    requireExact(entry.startReceiptSha256, null, `${label} startReceiptSha256`);
    requireExact(entry.receiptCount, 0, `${label} receiptCount`);
    requireExact(entry.headSha256, null, `${label} headSha256`);
    requireExact(entry.outcome, null, `${label} outcome`);
  } else {
    requireSha256(entry.startReceiptSha256, `${label} startReceiptSha256`);
    requireExact(entry.receiptCount, 2, `${label} receiptCount`);
    requireSha256(entry.headSha256, `${label} headSha256`);
    requireEnum(entry.outcome, OPERATION_OUTCOMES, `${label} outcome`);
  }
  return entry;
}

function validateLocalSeal(value) {
  const seal = requireObject(value, "[local seal]");
  exactKeys(seal, LOCAL_SEAL_KEYS, "[local seal]");
  requireExact(seal.schemaVersion, 1, "[local seal] schemaVersion");
  requireExact(
    seal.contract,
    RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
    "[local seal] contract",
  );
  requireExact(seal.environment, "staging", "[local seal] environment");
  for (const field of [
    "activationSha256",
    "authorizationIdSha256",
    "claimDigestSha256",
    "operationContextSha256",
    "executionReceiptHeadSha256",
    "operationHeadSetSha256",
  ]) {
    requireSha256(seal[field], `[local seal] ${field}`);
  }
  requireInteger(
    seal.terminalStateVersion,
    1,
    6,
    "[local seal] terminalStateVersion",
  );
  if (
    !TERMINAL_STATE_VERSIONS.get(seal.terminalStatus)?.has(
      seal.terminalStateVersion,
    )
  ) {
    throw new Error("[local seal] terminal status and state version are inconsistent");
  }
  requireInteger(
    seal.executionReceiptCount,
    3,
    8,
    "[local seal] executionReceiptCount",
  );
  if (seal.executionReceiptCount !== seal.terminalStateVersion + 2) {
    throw new Error("[local seal] execution receipt count is inconsistent");
  }
  requireInteger(
    seal.operationHeadSetBytes,
    1,
    MAX_RING_TRANSITION_OPERATION_HEAD_BYTES,
    "[local seal] operationHeadSetBytes",
  );
  for (const field of [
    "operationCount",
    "capacityReservationCount",
    "markerOnlyCount",
  ]) {
    requireInteger(
      seal[field],
      0,
      MAX_RING_TRANSITION_OPERATION_CAPACITY,
      `[local seal] ${field}`,
    );
  }
  if (
    seal.operationCount + seal.markerOnlyCount !==
    seal.capacityReservationCount
  ) {
    throw new Error("[local seal] aggregate counts are inconsistent");
  }
  const terminalCandidateFields = [
    seal.terminalSnapshotCandidateSha256,
    seal.terminalSnapshotCandidateBytes,
    seal.terminalCandidateOperationIdSha256,
    seal.terminalCandidateStartReceiptSha256,
  ];
  const terminalCandidateIsNull = terminalCandidateFields.every(
    (value) => value === null,
  );
  const terminalCandidateIsPresent = terminalCandidateFields.every(
    (value) => value !== null,
  );
  if (!terminalCandidateIsNull && !terminalCandidateIsPresent) {
    throw new Error(
      "[local seal] terminal snapshot candidate fields must be all null or all non-null",
    );
  }
  if (terminalCandidateIsPresent) {
    requireInteger(
      seal.terminalSnapshotCandidateBytes,
      1,
      MAX_TERMINAL_SNAPSHOT_CANDIDATE_BYTES,
      "[local seal] terminalSnapshotCandidateBytes",
    );
    for (const field of [
      "terminalSnapshotCandidateSha256",
      "terminalCandidateOperationIdSha256",
      "terminalCandidateStartReceiptSha256",
    ]) {
      requireSha256(seal[field], `[local seal] ${field}`);
    }
  }
  return seal;
}

function parseCanonicalDocument(value, label) {
  const bytes = requireByteArray(value, `[${label}] bytes`);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RING_TRANSITION_OPERATION_HEAD_BYTES
  ) {
    throw new Error(
      `[${label}] byte length must be between 1 and ${MAX_RING_TRANSITION_OPERATION_HEAD_BYTES}`,
    );
  }
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new Error(`[${label}] must be valid UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`[${label}] must be valid JSON`);
  }
  const canonical = canonicalReceiptBytes(parsed);
  if (!equalBytes(bytes, canonical)) {
    throw new Error(`[${label}] JSON is not canonical`);
  }
  return {
    value: parsed,
    bytes,
    sha256: sha256ReceiptBytes(bytes),
  };
}

function requireObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    const unexpected = actual.find((key) => !sortedExpected.includes(key));
    const missing = sortedExpected.find((key) => !actual.includes(key));
    throw new Error(
      `${label} has ${unexpected ? `unknown field ${unexpected}` : `missing field ${missing}`}`,
    );
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    value > MAX_SAFE_INTEGER
  ) {
    throw new Error(`${label} must be a bounded safe integer`);
  }
}

function requireEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireByteArray(value, label) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`${label} must be a byte array`);
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
