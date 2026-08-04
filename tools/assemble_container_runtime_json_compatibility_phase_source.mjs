#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  parseStrictJsonObject,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityPhaseSourcePacket,
} from "./container_runtime_json_compatibility_phase_source.mjs";
import {
  JSON_COMPATIBILITY_CONTEXT_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

export async function runJsonCompatibilityPhaseSourceAssembler(options) {
  const planPath = requiredPath(options?.planPath, "--plan");
  const receiptPath = requiredPath(options?.receiptPath, "--receipt");
  const contextPath = requiredPath(options?.contextPath, "--context");
  const outPath = requiredPath(options?.outPath, "--out");
  const inputs = [planPath, receiptPath, contextPath].map((value) =>
    path.resolve(value),
  );
  const output = path.resolve(outPath);
  if (inputs.includes(output)) throw new Error("--out must not replace an input file");

  const [planSource, receiptSource, contextSource] = await Promise.all([
    readBoundedUtf8File(
      inputs[0],
      JSON_COMPATIBILITY_PLAN_MAX_BYTES,
      "JSON compatibility plan",
    ),
    readBoundedUtf8File(
      inputs[1],
      JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES,
      "JSON compatibility operator invocation receipt",
    ),
    readBoundedUtf8File(
      inputs[2],
      JSON_COMPATIBILITY_CONTEXT_MAX_BYTES,
      "JSON compatibility phase source context",
    ),
  ]);
  const plan = parseStrictJsonObject(planSource, "JSON compatibility plan");
  const receipt = parseStrictJsonObject(
    receiptSource,
    "JSON compatibility operator invocation receipt",
  );
  const context = parseStrictJsonObject(
    contextSource,
    "JSON compatibility phase source context",
  );
  const packet = await buildJsonCompatibilityPhaseSourcePacket(
    plan,
    receipt,
    context,
  );
  const canonicalOutput = canonicalJson(packet);
  if (
    new TextEncoder().encode(canonicalOutput).byteLength
    > JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES
  ) {
    throw new Error("JSON compatibility phase source exceeds its byte limit");
  }
  await writeFile(output, canonicalOutput, { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-phase-source-assembly",
    environment: "staging",
    phaseId: packet.activity.id,
    phaseOrdinal: packet.activity.ordinal,
    packetSha256: packet.packetSha256,
    receiptSha256: packet.operatorInvocation.receiptSha256,
    privateInvocationReceiptSha256:
      packet.privateInvocation.rawReceiptSha256,
    privateInvocationCanonicalSha256:
      packet.privateInvocation.receiptSha256,
    executorReceiptSha256: packet.executorReceipt.receiptSha256,
    shardCount: packet.shards.length,
    credentialsRead: false,
    networkRequestsPerformed: false,
    sensitiveValuesPrinted: false,
  };
}

export function parseJsonCompatibilityPhaseSourceArgs(argv) {
  const values = new Map();
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      if (help) throw new Error("--help must not be repeated");
      help = true;
      continue;
    }
    if (!["--plan", "--receipt", "--context", "--out"].includes(argument)) {
      throw new Error("unknown option");
    }
    if (values.has(argument)) throw new Error(`${argument} must not be repeated`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument, value);
  }
  if (help) {
    if (values.size !== 0) throw new Error("--help does not accept assembly options");
    return { help: true };
  }
  for (const name of ["--plan", "--receipt", "--context", "--out"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return {
    planPath: values.get("--plan"),
    receiptPath: values.get("--receipt"),
    contextPath: values.get("--context"),
    outPath: values.get("--out"),
  };
}

function requiredPath(value, option) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  bun tools/assemble_container_runtime_json_compatibility_phase_source.mjs --plan <plan.json> --receipt <operator-invocation-receipt.json> --context <readback-context.json> --out <phase-source.json>",
    "",
    "Assembly is offline and create-only. The receipt retains the private operator caller and its nested invocation/probe chain; the independent context supplies deployment, ledger, and zero-mutation readback. Source authenticity still requires an external signature.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  try {
    const options = parseJsonCompatibilityPhaseSourceArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runJsonCompatibilityPhaseSourceAssembler(options);
    console.log(
      `JSON compatibility ${result.phaseId} source packet created: ${result.packetSha256}; ${result.shardCount} private probe receipts validated.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility phase assembly failure";
    console.error(`JSON compatibility phase assembly failed: ${message}`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
