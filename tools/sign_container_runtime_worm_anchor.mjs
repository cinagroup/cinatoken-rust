#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  WORM_APPROVAL_RECEIPT_CONTRACT,
  WORM_CEREMONY_APPROVAL_DOMAIN,
  WormBundleError,
  signWormAnchor,
  writeApprovalReceiptExclusive,
} from "./lib/container_runtime_worm_bundle.mjs";
import { canonicalJson } from "./lib/container_runtime_worm_staging.mjs";

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  let privateKeyBytes = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.describe) {
      process.stdout.write(`${canonicalJson(describe())}\n`);
      return;
    }
    if (process.stdin.isTTY) {
      throw new WormBundleError(
        "[signing] private key stdin must be a non-TTY stream",
      );
    }
    privateKeyBytes = await readBoundedStdin();
    const approval = await signWormAnchor({
      assemblyDirectory: args.values.get("assembly"),
      trustPolicyPath: args.values.get("trust-policy"),
      role: args.values.get("role"),
      keyId: args.values.get("key-id"),
      privateKeyBytes,
    });
    await writeApprovalReceiptExclusive(
      args.values.get("approval-output"),
      approval,
    );
    process.stdout.write(
      `${canonicalJson({
        schemaVersion: 1,
        status: "signed",
        reportKind: "container-runtime-worm-anchor-signing",
        role: approval.role,
        keyId: approval.keyId,
        policyId: approval.policyId,
        ceremonyId: approval.ceremonyId,
        subjectDigestSha256: approval.subjectDigestSha256,
        signingRequestSha256: approval.signingRequestSha256,
        approvalOutputCreated: true,
        privateKeySource: "stdin",
        privateKeyPersisted: false,
        networkRequests: false,
        wormRetentionVerified: false,
        s3Complete: false,
        productionCutoverAuthorized: false,
      })}\n`,
    );
  } catch (error) {
    const message =
      error instanceof WormBundleError
        ? error.message
        : "[signing] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    privateKeyBytes?.fill(0);
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") {
    return { describe: true, values: new Map() };
  }
  const required = new Set([
    "assembly",
    "trust-policy",
    "role",
    "key-id",
    "approval-output",
  ]);
  const values = new Map();
  let privateKeyStdin = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--private-key-stdin") {
      if (privateKeyStdin) {
        usage(2, "[input] --private-key-stdin must not repeat");
      }
      privateKeyStdin = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      usage(2, "[input] unexpected positional argument");
    }
    const key = argument.slice(2);
    if (!required.has(key)) {
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
  if (!privateKeyStdin) {
    usage(2, "[input] --private-key-stdin is required");
  }
  if (!["operations", "security"].includes(values.get("role"))) {
    usage(2, "[input] --role must be operations or security");
  }
  return { describe: false, values };
}

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PRIVATE_KEY_BYTES) {
      for (const value of chunks) value.fill(0);
      bytes.fill(0);
      throw new WormBundleError(
        "[signing] private key stdin exceeds its byte bound",
      );
    }
    chunks.push(bytes);
  }
  if (total === 0) {
    throw new WormBundleError("[signing] private key stdin is empty");
  }
  const combined = Buffer.concat(chunks, total);
  for (const value of chunks) value.fill(0);
  return combined;
}

function describe() {
  return {
    schemaVersion: 1,
    contract: WORM_APPROVAL_RECEIPT_CONTRACT,
    ceremonyApprovalDomain: WORM_CEREMONY_APPROVAL_DOMAIN,
    mode: "single-role-ed25519-signing",
    supportedRoles: ["operations", "security"],
    privateKeyInput: "stdin-only",
    privateKeyInArgv: false,
    privateKeyInEnvironment: false,
    outputMustNotExist: true,
    networkRequests: false,
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
      "  node tools/sign_container_runtime_worm_anchor.mjs --describe",
      "  <secret-manager-command> | node tools/sign_container_runtime_worm_anchor.mjs",
      "    --assembly <dir> --trust-policy <file>",
      "    --role <operations|security> --key-id <id>",
      "    --private-key-stdin --approval-output <new-file>",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}
