#!/usr/bin/env bun

import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ADMISSION_FENCE_CAPTURE_CONTRACT,
  ADMISSION_FENCE_RAW_ARTIFACT_CONTRACT,
  EVIDENCE_CONTRACT,
  REQUIRED_ADMISSION_FENCE_ARTIFACT_PURPOSES,
  buildAdmissionFenceEvidence,
  canonicalJson,
  p5CandidateDigestSha256,
  validateP5Candidate,
} from "./relay_container_p5_evidence_contract.mjs";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class AdmissionFenceCollectorError extends Error {}

if (import.meta.main) {
  try {
    const options = parseAdmissionFenceCollectorArgs(process.argv.slice(2));
    const result =
      options.mode === "describe"
        ? describeAdmissionFenceCollector()
        : options.mode === "self-test"
          ? runAdmissionFenceCollectorSelfTest()
          : await collectAdmissionFenceEvidence(options);
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "[admission-fence] collection failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export function parseAdmissionFenceCollectorArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new AdmissionFenceCollectorError("[input] arguments must be an array");
  }
  if (argv.length === 1 && argv[0] === "--describe") {
    return { mode: "describe" };
  }
  if (argv.length === 1 && argv[0] === "--self-test") {
    return { mode: "self-test" };
  }
  let capturePath = null;
  let bundleRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      throw new AdmissionFenceCollectorError(
        "usage: --describe | --self-test | --capture <capture.json> --bundle-root <directory>",
      );
    }
    if (argument !== "--capture" && argument !== "--bundle-root") {
      throw new AdmissionFenceCollectorError(
        `[input] unknown option: ${argument}`,
      );
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new AdmissionFenceCollectorError(
        `[input] ${argument} requires a path`,
      );
    }
    if (argument === "--capture") {
      if (capturePath !== null) {
        throw new AdmissionFenceCollectorError(
          "[input] --capture must not repeat",
        );
      }
      capturePath = value;
    } else {
      if (bundleRoot !== null) {
        throw new AdmissionFenceCollectorError(
          "[input] --bundle-root must not repeat",
        );
      }
      bundleRoot = value;
    }
  }
  if (capturePath === null || bundleRoot === null) {
    throw new AdmissionFenceCollectorError(
      "[input] --capture and --bundle-root are required",
    );
  }
  return {
    mode: "collect",
    capturePath,
    bundleRoot,
  };
}

export function describeAdmissionFenceCollector() {
  return {
    schemaVersion: 1,
    contract: ADMISSION_FENCE_CAPTURE_CONTRACT,
    ok: true,
    mode: "offline-read-only",
    outputContract: EVIDENCE_CONTRACT,
    rawArtifactContract: ADMISSION_FENCE_RAW_ARTIFACT_CONTRACT,
    requiredSupportingArtifactPurposes:
      REQUIRED_ADMISSION_FENCE_ARTIFACT_PURPOSES,
    safetyBoundary: {
      credentialsRead: false,
      networkRequests: false,
      remoteMutationPerformed: false,
      filesWritten: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    },
  };
}

export function validateAdmissionFenceCaptureEnvelope(value) {
  const capture = requireObject(value, "[admission-fence] capture");
  exactKeys(
    capture,
    [
      "schemaVersion",
      "contract",
      "environment",
      "candidate",
      "candidateDigestSha256",
      "foundationCaptureSha256",
      "capturedAt",
      "expiresAt",
      "facts",
    ],
    "[admission-fence] capture",
  );
  requireExact(
    capture.schemaVersion,
    1,
    "[admission-fence] capture schemaVersion",
  );
  requireExact(
    capture.contract,
    ADMISSION_FENCE_CAPTURE_CONTRACT,
    "[admission-fence] capture contract",
  );
  requireExact(
    capture.environment,
    "staging",
    "[admission-fence] capture environment",
  );
  requireSha256(
    capture.candidateDigestSha256,
    "[admission-fence] candidate digest",
  );
  requireSha256(
    capture.foundationCaptureSha256,
    "[admission-fence] foundation capture digest",
  );
  const capturedAt = requireTimestamp(
    capture.capturedAt,
    "[admission-fence] capturedAt",
  );
  const expiresAt = requireTimestamp(
    capture.expiresAt,
    "[admission-fence] expiresAt",
  );
  if (capturedAt.getTime() >= expiresAt.getTime()) {
    throw new AdmissionFenceCollectorError(
      "[admission-fence] capture validity window is empty",
    );
  }
  const candidate = validateP5Candidate(capture.candidate);
  requireExact(
    capture.candidateDigestSha256,
    p5CandidateDigestSha256(candidate),
    "[admission-fence] candidate digest",
  );
  requireObject(capture.facts, "[admission-fence] facts");
  return { ...capture, candidate };
}

export async function collectAdmissionFenceEvidence({
  capturePath,
  bundleRoot,
}) {
  const captureFile = await readCanonicalJsonFile(
    capturePath,
    "admission-fence capture",
  );
  const capture = validateAdmissionFenceCaptureEnvelope(captureFile);
  return buildAdmissionFenceEvidence({
    bundleRoot,
    candidate: capture.candidate,
    candidateDigestSha256: capture.candidateDigestSha256,
    foundationCaptureSha256: capture.foundationCaptureSha256,
    capturedAt: capture.capturedAt,
    expiresAt: capture.expiresAt,
    facts: capture.facts,
  });
}

export function runAdmissionFenceCollectorSelfTest() {
  const described = describeAdmissionFenceCollector();
  if (
    described.safetyBoundary.credentialsRead !== false ||
    described.safetyBoundary.networkRequests !== false ||
    described.safetyBoundary.remoteMutationPerformed !== false ||
    described.requiredSupportingArtifactPurposes.length !== 11
  ) {
    throw new AdmissionFenceCollectorError(
      "[self-test] collector safety boundary mismatch",
    );
  }
  let rejected = false;
  try {
    parseAdmissionFenceCollectorArgs([
      "--capture",
      "capture.json",
      "--bundle-root",
      ".",
      "--live",
    ]);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new AdmissionFenceCollectorError(
      "[self-test] live mode must be rejected",
    );
  }
  return {
    ...described,
    selfTest: "pass",
    liveModeSupported: false,
  };
}

async function readCanonicalJsonFile(file, label) {
  if (typeof file !== "string" || file.length === 0) {
    throw new AdmissionFenceCollectorError(`[input] ${label} path is required`);
  }
  const resolved = path.resolve(file);
  const stats = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !stats ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0n ||
    stats.size > BigInt(MAX_CAPTURE_BYTES)
  ) {
    throw new AdmissionFenceCollectorError(
      `[input] ${label} must be a bounded regular non-symlink file`,
    );
  }
  let handle;
  try {
    handle = await open(resolved, "r");
  } catch {
    throw new AdmissionFenceCollectorError(
      `[input] ${label} could not be opened`,
    );
  }
  let bytes;
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || !sameFileSnapshot(stats, openedStats)) {
      throw new AdmissionFenceCollectorError(
        `[input] ${label} changed before it was opened`,
      );
    }
    const openedRealPath = await realpath(resolved);
    const realStats = await lstat(openedRealPath, { bigint: true });
    if (!sameFileIdentity(openedStats, realStats)) {
      throw new AdmissionFenceCollectorError(
        `[input] ${label} real path changed before it was read`,
      );
    }
    bytes = await handle.readFile();
    const afterStats = await handle.stat({ bigint: true });
    const finalStats = await lstat(resolved, { bigint: true }).catch(
      () => null,
    );
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
      throw new AdmissionFenceCollectorError(
        `[input] ${label} changed while it was read`,
      );
    }
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AdmissionFenceCollectorError(
      `[input] ${label} must be valid UTF-8`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdmissionFenceCollectorError(
      `[input] ${label} must be valid JSON`,
    );
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw new AdmissionFenceCollectorError(
      `[input] ${label} must use canonical JSON plus one newline`,
    );
  }
  return value;
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
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new AdmissionFenceCollectorError(
      `${label} has unknown or missing fields`,
    );
  }
}

function requireObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new AdmissionFenceCollectorError(`${label} must be an object`);
  }
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new AdmissionFenceCollectorError(`${label} mismatch`);
  }
  return actual;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new AdmissionFenceCollectorError(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new AdmissionFenceCollectorError(
      `${label} must be a canonical ISO timestamp`,
    );
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new AdmissionFenceCollectorError(
      `${label} must be a canonical ISO timestamp`,
    );
  }
  return timestamp;
}
