#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  parseStrictJsonObject,
  verifyJsonCompatibilityCampaignEvidence,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityEvidenceFromSourceManifest,
  validateJsonCompatibilitySourceManifest,
  verifyJsonCompatibilityEvidenceSourceManifestBinding,
} from "./container_runtime_json_compatibility_source_manifest.mjs";
import {
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  JSON_COMPATIBILITY_SOURCE_MANIFEST_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

export async function runJsonCompatibilityEvidenceProjector(options) {
  const planPath = requiredPath(options?.planPath, "--plan");
  const sourceManifestPath = requiredPath(
    options?.sourceManifestPath,
    "--source-manifest",
  );
  const outPath = requiredPath(options?.outPath, "--out");
  const capturedAt = requiredValue(options?.capturedAt, "--captured-at");
  const inputs = [planPath, sourceManifestPath].map((value) => path.resolve(value));
  const output = path.resolve(outPath);
  if (inputs.includes(output)) throw new Error("--out must not replace an input file");

  const [planSource, manifestSource] = await Promise.all([
    readBoundedUtf8File(
      inputs[0],
      JSON_COMPATIBILITY_PLAN_MAX_BYTES,
      "JSON compatibility plan",
    ),
    readBoundedUtf8File(
      inputs[1],
      JSON_COMPATIBILITY_SOURCE_MANIFEST_MAX_BYTES,
      "JSON compatibility source manifest",
    ),
  ]);
  const plan = parseStrictJsonObject(planSource, "JSON compatibility plan");
  const manifest = parseStrictJsonObject(
    manifestSource,
    "JSON compatibility source manifest",
  );
  validateJsonCompatibilitySourceManifest(plan, manifest);
  const evidence = buildJsonCompatibilityEvidenceFromSourceManifest(
    plan,
    manifest,
    { capturedAt, evidenceSource: "remote-staging" },
  );
  verifyJsonCompatibilityEvidenceSourceManifestBinding(plan, manifest, evidence);
  const verification = verifyJsonCompatibilityCampaignEvidence(plan, evidence);
  const canonicalOutput = canonicalJson(evidence);
  await writeFile(output, canonicalOutput, { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-evidence-projection",
    environment: "staging",
    evidenceSource: "remote-staging",
    planDigestSha256: evidence.planDigestSha256,
    sourceManifestSha256: evidence.sourceManifestSha256,
    capturedAt: evidence.capturedAt,
    phaseCount: verification.phaseCount,
    observationCount: verification.observationCount,
    filesWritten: true,
    credentialsRead: false,
    networkRequestsPerformed: false,
    sensitiveValuesPrinted: false,
  };
}

export function parseJsonCompatibilityEvidenceProjectorArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--plan",
    "--source-manifest",
    "--captured-at",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") flags.add("--help");
    else if (argument === "--help" || argument === "--json") {
      if (flags.has(argument)) throw new Error(`${argument} must not be repeated`);
      flags.add(argument);
    } else if (valueOptions.has(argument)) {
      if (values.has(argument)) throw new Error(`${argument} must not be repeated`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (flags.has("--help")) {
    if (values.size > 0) throw new Error("--help does not accept projection options");
    return { help: true };
  }
  for (const name of valueOptions) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return {
    json: flags.has("--json"),
    planPath: values.get("--plan"),
    sourceManifestPath: values.get("--source-manifest"),
    capturedAt: values.get("--captured-at"),
    outPath: values.get("--out"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/project_container_runtime_json_compatibility_evidence.mjs --plan <plan.json> --source-manifest <manifest.json> --captured-at <whole-second-UTC> --out <evidence.json> [--json]",
    "",
    "Projection is offline, bounded, and create-only. It builds the only accepted remote-staging evidence shape from the complete validated source manifest.",
  ].join("\n");
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

function requiredValue(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityEvidenceProjectorArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runJsonCompatibilityEvidenceProjector(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `JSON compatibility evidence created: ${result.sourceManifestSha256}; ${result.phaseCount} phases and ${result.observationCount} shard observations projected offline.`,
      );
    }
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility evidence projection failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility evidence projection failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
