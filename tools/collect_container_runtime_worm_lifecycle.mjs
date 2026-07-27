#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIFECYCLE_OPERATOR_TOKEN_ENV,
  LIFECYCLE_TARGET_TOKEN_ID_ENV,
  LIFECYCLE_VERIFIER_TOKEN_ENV,
  WORM_LIFECYCLE_RECEIPT_CONTRACT,
  WORM_LIFECYCLE_SCHEMA_VERSION,
  WormLifecycleCollectorError,
  buildLifecycleDryRunReceipt,
  describeLifecycleCollector,
  normalizeLockPredecessor,
  normalizeRevokePredecessor,
  readLifecycleCredentials,
  revokeLockOperator,
  verifyLockOperatorRevocation,
} from "./lib/container_runtime_worm_lifecycle.mjs";
import {
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  canonicalJson,
} from "./lib/container_runtime_worm_staging.mjs";

const MAX_PREDECESSOR_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_STRING_BYTES = 1024 * 1024;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === "describe") {
      process.stdout.write(
        `${canonicalJson(describeLifecycleCollector())}\n`,
      );
      return;
    }
    if (args.mode === "self-test") {
      process.stdout.write(`${canonicalJson(await runSelfTest())}\n`);
      return;
    }
    const predecessor = await loadPredecessor(args);
    const target =
      args.phase === "revoke"
        ? normalizeLockPredecessor({
            accountId: args.values.get("account-id"),
            receipt: predecessor.value,
            receiptText: predecessor.text,
          })
        : normalizeRevokePredecessor({
            accountId: args.values.get("account-id"),
            receipt: predecessor.value,
            receiptText: predecessor.text,
          });
    if (!args.live) {
      process.stdout.write(
        `${canonicalJson(buildLifecycleDryRunReceipt(args.phase, target))}\n`,
      );
      return;
    }
    requireLiveConfirmation(args);
    const credentials = readLifecycleCredentials(
      args.phase,
      process.env,
    );
    const receipt =
      args.phase === "revoke"
        ? await revokeLockOperator({ target, credentials })
        : await verifyLockOperatorRevocation({ target, credentials });
    process.stdout.write(`${canonicalJson(receipt)}\n`);
  } catch (error) {
    const message =
      error instanceof WormLifecycleCollectorError
        ? error.message
        : process.argv.includes("--self-test") && error instanceof Error
          ? `[self-test] ${error.message}`
          : "[lifecycle-collector] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return {
      mode: "describe",
      live: false,
      phase: null,
      values: new Map(),
      flags: new Set(),
    };
  }
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "account-id",
    "lock-receipt",
    "phase",
    "revoke-receipt",
  ]);
  const knownFlags = new Set([
    "confirm-independent-revocation-readback",
    "confirm-lock-operator-revocation",
    "confirm-staging-target",
    "describe",
    "dry-run",
    "live",
    "self-test",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (!argument.startsWith("--")) {
      usage(2, "[input] unexpected positional argument");
    }
    const key = argument.slice(2);
    if (knownFlags.has(key)) {
      if (flags.has(key)) usage(2, `[input] ${argument} must not repeat`);
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, "[input] unknown option");
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${argument} requires a value`);
    }
    if (values.has(key)) usage(2, `[input] ${argument} must not repeat`);
    values.set(key, value);
  }
  const standalone = ["describe", "self-test"].filter((flag) =>
    flags.has(flag),
  );
  if (standalone.length > 0) {
    if (standalone.length !== 1 || flags.size !== 1 || values.size !== 0) {
      usage(2, "[input] --describe and --self-test must be standalone");
    }
    return {
      mode: standalone[0],
      live: false,
      phase: null,
      values,
      flags,
    };
  }
  if (flags.has("live") && flags.has("dry-run")) {
    usage(2, "[input] --live and --dry-run are mutually exclusive");
  }
  if (
    !flags.has("live") &&
    [
      "confirm-independent-revocation-readback",
      "confirm-lock-operator-revocation",
      "confirm-staging-target",
    ].some((flag) => flags.has(flag))
  ) {
    usage(2, "[input] live confirmation flags require --live");
  }
  for (const key of ["account-id", "phase"]) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  const phase = values.get("phase");
  if (phase !== "revoke" && phase !== "verify") {
    usage(2, "[input] --phase must be revoke or verify");
  }
  if (
    phase === "revoke" &&
    (!values.has("lock-receipt") || values.has("revoke-receipt"))
  ) {
    usage(
      2,
      "[input] revoke requires only --lock-receipt as predecessor",
    );
  }
  if (
    phase === "verify" &&
    (!values.has("revoke-receipt") || values.has("lock-receipt"))
  ) {
    usage(
      2,
      "[input] verify requires only --revoke-receipt as predecessor",
    );
  }
  return {
    mode: "phase",
    live: flags.has("live"),
    phase,
    values,
    flags,
  };
}

function requireLiveConfirmation(args) {
  if (!args.flags.has("confirm-staging-target")) {
    throw new WormLifecycleCollectorError(
      "[confirmation] live lifecycle collection requires --confirm-staging-target",
    );
  }
  if (
    args.phase === "revoke" &&
    !args.flags.has("confirm-lock-operator-revocation")
  ) {
    throw new WormLifecycleCollectorError(
      "[confirmation] revoke requires --confirm-lock-operator-revocation",
    );
  }
  if (
    args.phase === "verify" &&
    !args.flags.has("confirm-independent-revocation-readback")
  ) {
    throw new WormLifecycleCollectorError(
      "[confirmation] verify requires --confirm-independent-revocation-readback",
    );
  }
  if (
    args.phase === "revoke" &&
    args.flags.has("confirm-independent-revocation-readback")
  ) {
    throw new WormLifecycleCollectorError(
      "[confirmation] independent readback confirmation is invalid for revoke",
    );
  }
  if (
    args.phase === "verify" &&
    args.flags.has("confirm-lock-operator-revocation")
  ) {
    throw new WormLifecycleCollectorError(
      "[confirmation] revocation confirmation is invalid for verify",
    );
  }
}

async function loadPredecessor(args) {
  const file =
    args.phase === "revoke"
      ? args.values.get("lock-receipt")
      : args.values.get("revoke-receipt");
  const text = await readCanonicalFile(file);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt must be JSON",
    );
  }
  auditJsonShape(value, "[predecessor] receipt");
  if (text !== `${canonicalJson(value)}\n`) {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt must be canonical JSON plus one newline",
    );
  }
  return { text, value };
}

async function readCanonicalFile(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt path is required",
    );
  }
  const resolved = path.resolve(file);
  const initial = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size <= 0n ||
    initial.size > BigInt(MAX_PREDECESSOR_BYTES)
  ) {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt is outside its file bound",
    );
  }
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt could not be opened",
    );
  }
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    const actualPath = await realpath(resolved);
    if (!sameSnapshot(initial, opened) || !samePath(resolved, actualPath)) {
      throw new WormLifecycleCollectorError(
        "[predecessor] receipt changed before read",
      );
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new WormLifecycleCollectorError(
          "[predecessor] receipt changed while read",
        );
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(resolved, { bigint: true }).catch(() => null);
    const finalPath = await realpath(resolved).catch(() => null);
    if (
      !final ||
      final.isSymbolicLink() ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(opened, final) ||
      finalPath === null ||
      !samePath(resolved, finalPath)
    ) {
      throw new WormLifecycleCollectorError(
        "[predecessor] receipt changed while read",
      );
    }
  } finally {
    await handle.close();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WormLifecycleCollectorError(
      "[predecessor] receipt must be UTF-8",
    );
  }
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    right.nlink === 1n
  );
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  };
  return normalize(left) === normalize(right);
}

function auditJsonShape(value, label) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) {
      throw new WormLifecycleCollectorError(
        `${label} exceeds JSON complexity bounds`,
      );
    }
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > MAX_STRING_BYTES) {
        throw new WormLifecycleCollectorError(
          `${label} contains an oversized string`,
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        if (Buffer.byteLength(key, "utf8") > 256) {
          throw new WormLifecycleCollectorError(
            `${label} contains an oversized key`,
          );
        }
        visit(item, depth + 1);
      }
      return;
    }
    if (
      entry !== null &&
      typeof entry !== "boolean" &&
      typeof entry !== "number"
    ) {
      throw new WormLifecycleCollectorError(
        `${label} contains an unsupported JSON value`,
      );
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new WormLifecycleCollectorError(
        `${label} contains an unsupported JSON value`,
      );
    }
  };
  visit(value, 0);
}

async function runSelfTest() {
  const accountId = "0123456789abcdef0123456789abcdef";
  const targetTokenId = "d".repeat(32);
  const lifecycleOperatorId = "e".repeat(32);
  const lifecycleVerifierId = "f".repeat(32);
  const operatorToken = "self-test-lifecycle-operator-token";
  const verifierToken = "self-test-lifecycle-verifier-token";
  const lock = lockReceiptFixture(accountId, targetTokenId);
  const lockText = `${canonicalJson(lock)}\n`;
  const revokeTarget = normalizeLockPredecessor({
    accountId,
    receipt: lock,
    receiptText: lockText,
  });
  const revoke = await revokeLockOperator({
    target: revokeTarget,
    credentials: {
      apiToken: operatorToken,
      targetTokenId,
    },
    fetchImpl: sequenceFetch([
      tokenVerificationResponse(
        lifecycleOperatorId,
        "self-test-operator",
      ),
      deletionResponse(targetTokenId, "self-test-delete"),
      absenceResponse("self-test-operator-readback"),
    ]),
    now: sequenceNow([
      "2026-07-27T00:02:00.000Z",
      "2026-07-27T00:02:01.000Z",
      "2026-07-27T00:02:02.000Z",
    ]),
  });
  const revokeText = `${canonicalJson(revoke)}\n`;
  const verifyTarget = normalizeRevokePredecessor({
    accountId,
    receipt: revoke,
    receiptText: revokeText,
  });
  const verification = await verifyLockOperatorRevocation({
    target: verifyTarget,
    credentials: {
      apiToken: verifierToken,
      targetTokenId,
    },
    fetchImpl: sequenceFetch([
      tokenVerificationResponse(
        lifecycleVerifierId,
        "self-test-verifier",
      ),
      absenceResponse("self-test-independent-readback"),
    ]),
    now: sequenceNow([
      "2026-07-27T00:03:00.000Z",
      "2026-07-27T00:03:01.000Z",
    ]),
  });
  const dryRun = buildLifecycleDryRunReceipt("verify", verifyTarget);
  const serialized = canonicalJson([revoke, verification, dryRun]);
  if (
    revoke.facts.targetAbsentAfterDelete !== true ||
    verification.facts.targetAbsenceIndependentlyObserved !== true ||
    verification.facts.operatorAndVerifierCredentialIdsDistinct !== true ||
    verification.downstreamAuthority.lockOperatorRevocationVerified !==
      false ||
    dryRun.networkRequests !== false ||
    serialized.includes(accountId) ||
    serialized.includes(targetTokenId) ||
    serialized.includes(operatorToken) ||
    serialized.includes(verifierToken) ||
    serialized.includes(lifecycleOperatorId) ||
    serialized.includes(lifecycleVerifierId)
  ) {
    throw new WormLifecycleCollectorError(
      "[self-test] lifecycle invariant failed",
    );
  }
  return {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    cases: 4,
    expectations: 12,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    ok: true,
    downstreamAuthority: verification.downstreamAuthority,
  };
}

function lockReceiptFixture(accountId, targetTokenId) {
  const capturedAt = "2026-07-27T00:01:01.000Z";
  const statementSha256 = "a".repeat(64);
  const prefix = `container-runtime/s3/v1/${statementSha256}/`;
  const selectedRuleId = `cinatoken-s3-${statementSha256.slice(0, 24)}`;
  return {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "lock",
    mode: "live",
    ok: true,
    capturedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target: {
      accountIdSha256: sha256(accountId),
      bucketName: "cinatoken-worm-staging",
      jurisdiction: "default",
      prefix,
      statementSha256,
    },
    credential: {
      role: "lock-operator",
      credentialType: "cloudflare-r2-admin-read-write-api-token",
      credentialIdSha256: sha256(targetTokenId),
      selfVerifiedAt: "2026-07-27T00:00:30.000Z",
      expiresAt: "2026-07-27T00:30:00.000Z",
      remainingLifetimeSeconds: 1_770,
    },
    facts: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      awsS3ObjectLockHeadersUsed: false,
      configuredAt: "2026-07-27T00:01:00.000Z",
      configurationRequestId: "self-test-configure",
      observedAt: capturedAt,
      readbackRequestId: "self-test-lock-after",
      httpStatus: 200,
      selectedRuleId,
      rules: [
        {
          id: selectedRuleId,
          condition: {
            type: "Age",
            maxAgeSeconds: 31_536_000,
          },
          enabled: true,
          prefix,
        },
      ],
      preconfigurationRequestId: "self-test-lock-before",
      preexistingRuleCount: 0,
      unrelatedRulesPreserved: true,
    },
    providerOperations: [
      {
        method: "GET",
        operation: "credential-preflight",
        httpStatus: 200,
        providerRequestId: "self-test-lock-credential",
      },
      {
        method: "GET",
        operation: "lock-before",
        httpStatus: 200,
        providerRequestId: "self-test-lock-before",
      },
      {
        method: "PUT",
        operation: "lock-configure",
        httpStatus: 200,
        providerRequestId: "self-test-configure",
      },
      {
        method: "GET",
        operation: "lock-after",
        httpStatus: 200,
        providerRequestId: "self-test-lock-after",
      },
    ],
    limits: {
      requestTimeoutMs: 30_000,
      responseBytes: 1024 * 1024,
      mutableCredentialRemainingSeconds: 3_600,
      listPages: 1_000,
      listItems: 10_000,
      lockRules: 1_000,
    },
    downstreamAuthority: downstreamAuthority(),
  };
}

function tokenVerificationResponse(id, ray) {
  return jsonResponse(
    200,
    {
      success: true,
      errors: [],
      messages: [],
      result: {
        id,
        status: "active",
        expires_on: "2026-07-27T00:30:00.000Z",
        not_before: "2026-07-27T00:00:00.000Z",
      },
    },
    ray,
  );
}

function deletionResponse(id, ray) {
  return jsonResponse(
    200,
    {
      success: true,
      errors: [],
      messages: [],
      result: { id },
    },
    ray,
  );
}

function absenceResponse(ray) {
  return jsonResponse(
    404,
    {
      success: false,
      errors: [{ code: 1000, message: "Token not found" }],
      messages: [],
      result: null,
    },
    ray,
  );
}

function jsonResponse(status, value, ray) {
  return new Response(canonicalJson(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cf-ray": ray,
    },
  });
}

function sequenceFetch(responses) {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected self-test request");
    return response;
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function downstreamAuthority() {
  return {
    lockOperatorRevocationVerified: false,
    publisherRevocationVerified: false,
    wormRetentionVerified: false,
    s3Complete: false,
    formalP5Evidence: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function usage(exitCode, message) {
  if (message) process.stderr.write(`${message}\n`);
  const output = [
    "Usage:",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --describe",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --self-test",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --phase revoke --account-id <32-hex> --lock-receipt <canonical-lock-v2.json> [--dry-run]",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --phase revoke ... --live --confirm-staging-target --confirm-lock-operator-revocation",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --phase verify --account-id <32-hex> --revoke-receipt <canonical-revoke-v1.json> [--dry-run]",
    "  node tools/collect_container_runtime_worm_lifecycle.mjs --phase verify ... --live --confirm-staging-target --confirm-independent-revocation-readback",
    "",
    `Live revoke reads ${LIFECYCLE_OPERATOR_TOKEN_ENV} and ${LIFECYCLE_TARGET_TOKEN_ID_ENV}.`,
    `Live verify reads ${LIFECYCLE_VERIFIER_TOKEN_ENV} and ${LIFECYCLE_TARGET_TOKEN_ID_ENV}.`,
    "No phase is live unless --live is present. Output is one canonical, redacted JSON receipt and no files are written.",
  ].join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
  process.exit(exitCode);
}
