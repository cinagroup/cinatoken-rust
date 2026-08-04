#!/usr/bin/env bun

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  parseStrictJsonObject,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  signJsonCompatibilityOperatorApproval,
} from "./container_runtime_json_compatibility_operator_approval.mjs";
import {
  JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
} from "./container_runtime_json_compatibility_operator_invocation.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export async function runJsonCompatibilityOperatorApprovalSigner(options) {
  const planPath = requiredPath(options?.planPath, "--plan");
  const configPath = requiredPath(options?.operatorConfigPath, "--operator-config");
  const requestPath = requiredPath(options?.requestPath, "--request");
  const outPath = requiredPath(options?.outPath, "--out");
  for (const [left, right, label] of [
    [planPath, outPath, "--out must not replace --plan"],
    [configPath, outPath, "--out must not replace --operator-config"],
    [requestPath, outPath, "--out must not replace --request"],
  ]) {
    if (path.resolve(left) === path.resolve(right)) throw new Error(label);
  }
  const [planSource, configSource, requestSource] = await Promise.all([
    readBoundedUtf8File(
      planPath,
      JSON_COMPATIBILITY_PLAN_MAX_BYTES,
      "approved campaign plan",
    ),
    readBoundedUtf8File(
      configPath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "operator campaign config",
    ),
    readBoundedUtf8File(
      requestPath,
      MAX_REQUEST_BYTES,
      "operator phase request",
    ),
  ]);
  const authorized = signJsonCompatibilityOperatorApproval({
    plan: parseStrictJsonObject(planSource, "approved campaign plan"),
    operatorConfig: parseStrictJsonObject(configSource, "operator campaign config"),
    request: parseStrictJsonObject(requestSource, "operator phase request"),
    privateKeyBytes: options.privateKeyBytes,
    keySlot: options.keySlot ?? "current",
    now: options.now ?? new Date(),
  });
  await writeCanonicalJsonExclusive(outPath, authorized);
  return {
    ok: true,
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    mode: "offline-ed25519-phase-approval-signing",
    campaignIdSha256: authorized.request.execution.campaignIdSha256,
    planDigestSha256: authorized.request.execution.planDigestSha256,
    phaseExecutionId: authorized.request.execution.phaseExecutionId,
    phaseOrdinal: authorized.request.execution.phase.ordinal,
    keyId: authorized.approval.subject.keyId,
    approvalSubjectSha256: authorized.approval.subjectSha256,
    privateKeySource: "stdin",
    privateKeyPersisted: false,
    outputCreated: true,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityOperatorApprovalSignerArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") {
    return { describe: true };
  }
  const values = new Map();
  const names = new Set([
    "--plan",
    "--operator-config",
    "--request",
    "--key-slot",
    "--out",
  ]);
  let privateKeyStdin = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--json") {
      if (json) throw new Error("--json must not repeat");
      json = true;
      continue;
    }
    if (argument === "--private-key-stdin") {
      if (privateKeyStdin) throw new Error("--private-key-stdin must not repeat");
      privateKeyStdin = true;
      continue;
    }
    if (!names.has(argument)) throw new Error(`unknown option: ${argument}`);
    if (values.has(argument)) throw new Error(`${argument} must not repeat`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
  }
  for (const name of ["--plan", "--operator-config", "--request", "--out"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  if (!privateKeyStdin) throw new Error("--private-key-stdin is required");
  const keySlot = values.get("--key-slot") ?? "current";
  if (keySlot !== "current" && keySlot !== "previous") {
    throw new Error("--key-slot must be current or previous");
  }
  return {
    json,
    privateKeyStdin,
    keySlot,
    planPath: values.get("--plan"),
    operatorConfigPath: values.get("--operator-config"),
    requestPath: values.get("--request"),
    outPath: values.get("--out"),
  };
}

async function readBoundedPrivateKeyStdin() {
  if (process.stdin.isTTY) {
    throw new Error("private key stdin must be a non-TTY stream");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PRIVATE_KEY_BYTES) {
      for (const value of chunks) value.fill(0);
      bytes.fill(0);
      throw new Error("private key stdin exceeds its byte bound");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("private key stdin is empty");
  const combined = Buffer.concat(chunks, total);
  for (const value of chunks) value.fill(0);
  return combined;
}

async function writeCanonicalJsonExclusive(filePath, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    path.resolve(filePath),
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesWritten < 1) throw new Error("approval output write stalled");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} requires a path`);
  }
  return path.resolve(value);
}

function describe() {
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    mode: "offline-ed25519-phase-approval-signing",
    privateKeyInput: "stdin-only",
    privateKeyInArgv: false,
    privateKeyInEnvironment: false,
    outputMustNotExist: true,
    planAndConfigBindingRequired: true,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/sign_container_runtime_json_compatibility_operator_approval.mjs --describe",
    "  <secret-manager-command> | bun tools/sign_container_runtime_json_compatibility_operator_approval.mjs --plan <approved-plan.json> --operator-config <campaign-wrangler.jsonc> --request <phase-request.json> [--key-slot <current|previous>] --private-key-stdin --out <new-authorized-request.json> [--json]",
    "",
    "The signer performs no network request. The Ed25519 private key is accepted only from non-TTY stdin, is zeroed after use, and is never written or reported.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  let privateKeyBytes = null;
  let options;
  try {
    options = parseJsonCompatibilityOperatorApprovalSignerArgs(argv);
    if (options.help) return console.log(usage());
    if (options.describe) return console.log(canonicalJson(describe()));
    privateKeyBytes = await readBoundedPrivateKeyStdin();
    const result = await runJsonCompatibilityOperatorApprovalSigner({
      ...options,
      privateKeyBytes,
    });
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Authorized operator phase request created: ${result.approvalSubjectSha256}`,
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "unexpected operator approval signing failure";
    console.error(
      options?.json || argv.includes("--json")
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : `Operator approval signing failed: ${message}`,
    );
    process.exitCode = 1;
  } finally {
    privateKeyBytes?.fill(0);
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
