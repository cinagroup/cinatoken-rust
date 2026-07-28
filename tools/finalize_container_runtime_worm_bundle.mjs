#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  WORM_ASSEMBLY_CONTRACT,
  WormBundleError,
  finalizeWormBundle,
} from "./lib/container_runtime_worm_bundle.mjs";
import { canonicalJson } from "./lib/container_runtime_worm_staging.mjs";

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
    const report = await finalizeWormBundle({
      assemblyDirectory: args.values.get("assembly"),
      trustPolicyPath: args.values.get("trust-policy"),
      approvalPaths: {
        operations: args.values.get("operations-approval"),
        security: args.values.get("security-approval"),
      },
      outputDirectory: args.values.get("output"),
      decisionOutputPath: args.values.get("decision-output"),
    });
    process.stdout.write(`${canonicalJson(report)}\n`);
  } catch (error) {
    const message =
      error instanceof WormBundleError || error instanceof Error
        ? error.message
        : "[finalize] operation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--describe") {
    return { describe: true, values: new Map() };
  }
  const required = new Set([
    "assembly",
    "trust-policy",
    "operations-approval",
    "security-approval",
    "output",
    "decision-output",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
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
  return { describe: false, values };
}

function describe() {
  return {
    schemaVersion: 1,
    contract: WORM_ASSEMBLY_CONTRACT,
    mode: "two-role-finalization-and-local-replay",
    requiredApprovalRoles: ["operations", "security"],
    readsPrivateKeys: false,
    acceptsHistoricalTimeOverride: false,
    networkRequests: false,
    outputMustNotExist: true,
    externalDecisionOutput: "required-new-file",
    cleanHostReplayRequired: true,
    productionCutoverAuthorized: false,
  };
}

function usage(exitCode, message = null) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    [
      "Usage:",
      "  node tools/finalize_container_runtime_worm_bundle.mjs --describe",
      "  node tools/finalize_container_runtime_worm_bundle.mjs",
      "    --assembly <dir> --trust-policy <file>",
      "    --operations-approval <file> --security-approval <file>",
      "    --output <new-dir> --decision-output <new-report.json>",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}
