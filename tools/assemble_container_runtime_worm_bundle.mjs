#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  WORM_ASSEMBLY_CONTRACT,
  WORM_AUTHORITY_REVIEW_CONTRACT,
  WORM_RECEIPT_KEYS,
  WormBundleError,
  assembleWormBundle,
} from "./lib/container_runtime_worm_bundle.mjs";
import { canonicalJson } from "./lib/container_runtime_worm_staging.mjs";

const RECEIPT_OPTIONS = Object.freeze({
  baseline: "baseline-receipt",
  lock: "lock-receipt",
  lockRevoke: "lock-revoke-receipt",
  lockVerify: "lock-verify-receipt",
  publish: "publish-receipt",
  objectReadback: "object-readback-receipt",
  probe: "probe-receipt",
  publisherRevoke: "publisher-revoke-receipt",
  publisherVerify: "publisher-verify-receipt",
  postReadback: "post-readback-receipt",
  finalLock: "final-lock-receipt",
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.describe) {
      process.stdout.write(`${canonicalJson(describe())}\n`);
      return;
    }
    const receipts = Object.fromEntries(
      WORM_RECEIPT_KEYS.map((key) => [
        key,
        args.values.get(RECEIPT_OPTIONS[key]),
      ]),
    );
    const report = await assembleWormBundle({
      accountIdFile: args.values.get("account-id-file"),
      trustPolicyPath: args.values.get("trust-policy"),
      authorityReviewPath: args.values.get("authority-review"),
      objectsDirectory: args.values.get("objects-dir"),
      outputDirectory: args.values.get("output"),
      expiresAt: args.values.get("expires-at") ?? null,
      receipts,
    });
    process.stdout.write(`${canonicalJson(report)}\n`);
  } catch (error) {
    const message =
      error instanceof WormBundleError
        ? error.message
        : "[assembly] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") {
    return { describe: true, values: new Map() };
  }
  const required = new Set([
    "account-id-file",
    "trust-policy",
    "authority-review",
    "objects-dir",
    "output",
    ...Object.values(RECEIPT_OPTIONS),
  ]);
  const optional = new Set(["expires-at"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (!argument.startsWith("--")) {
      usage(2, "[input] unexpected positional argument");
    }
    const key = argument.slice(2);
    if (!required.has(key) && !optional.has(key)) {
      usage(2, `[input] unknown option --${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] --${key} requires a value`);
    }
    if (values.has(key)) {
      usage(2, `[input] --${key} must not repeat`);
    }
    values.set(key, value);
  }
  for (const key of required) {
    if (!values.has(key)) usage(2, `[input] --${key} is required`);
  }
  return { describe: false, values };
}

function describe() {
  return {
    schemaVersion: 1,
    contract: WORM_ASSEMBLY_CONTRACT,
    authorityReviewContract: WORM_AUTHORITY_REVIEW_CONTRACT,
    mode: "credential-free-offline-assembly",
    receiptCount: WORM_RECEIPT_KEYS.length,
    readsEnvironmentCredentials: false,
    networkRequests: false,
    outputMustNotExist: true,
    emitsFinalBundle: false,
    approvalsComplete: false,
    cleanHostReplayRequired: true,
    wormRetentionVerified: false,
    s3Complete: false,
    productionCutoverAuthorized: false,
  };
}

function usage(exitCode, message = null) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node tools/assemble_container_runtime_worm_bundle.mjs --describe",
      "  node tools/assemble_container_runtime_worm_bundle.mjs",
      "    --account-id-file <single-line-file>",
      "    --trust-policy <file> --authority-review <file>",
      "    --objects-dir <B4-readback-dir> --output <new-dir>",
      "    --baseline-receipt <file> --lock-receipt <file>",
      "    --lock-revoke-receipt <file> --lock-verify-receipt <file>",
      "    --publish-receipt <file> --object-readback-receipt <file>",
      "    --probe-receipt <file> --publisher-revoke-receipt <file>",
      "    --publisher-verify-receipt <file>",
      "    --post-readback-receipt <file> --final-lock-receipt <file>",
      "    [--expires-at <RFC3339-UTC>]",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}
