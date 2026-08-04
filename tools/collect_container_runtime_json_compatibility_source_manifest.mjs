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
  buildJsonCompatibilitySourceManifest,
  validateJsonCompatibilitySourceManifest,
} from "./container_runtime_json_compatibility_source_manifest.mjs";
import {
  JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

export async function runJsonCompatibilitySourceManifestCollector(options) {
  const planPath = requirePath(options?.planPath, "--plan");
  const outPath = requirePath(options?.outPath, "--out");
  if (!Array.isArray(options?.phasePaths) || options.phasePaths.length !== 4) {
    throw new Error("exactly four --phase values are required");
  }
  const phasePaths = options.phasePaths.map((value) => requirePath(value, "--phase"));
  const inputPaths = [planPath, ...phasePaths].map((value) => path.resolve(value));
  const resolvedOutPath = path.resolve(outPath);
  if (inputPaths.includes(resolvedOutPath)) {
    throw new Error("--out must not replace an input file");
  }

  const [planText, ...phaseTexts] = await Promise.all([
    readBoundedUtf8File(
      inputPaths[0],
      JSON_COMPATIBILITY_PLAN_MAX_BYTES,
      "JSON compatibility plan",
    ),
    ...inputPaths.slice(1).map((inputPath, index) =>
      readBoundedUtf8File(
        inputPath,
        JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
        `phase source packet ${index + 1}`,
      ),
    ),
  ]);
  const plan = parseStrictJsonObject(planText, "JSON compatibility plan");
  const phasePackets = phaseTexts.map((source, index) =>
    parseStrictJsonObject(source, `phase source packet ${index + 1}`),
  );
  const manifest = buildJsonCompatibilitySourceManifest(plan, phasePackets);
  const canonicalOutput = canonicalJson(manifest);

  // Reparse the exact bytes destined for disk before performing the only write.
  const outputDocument = parseStrictJsonObject(
    canonicalOutput,
    "canonical source manifest",
  );
  validateJsonCompatibilitySourceManifest(plan, outputDocument);
  await writeFile(resolvedOutPath, canonicalOutput, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-collection",
    environment: "staging",
    sourceManifestSha256: manifest.sourceManifestSha256,
    phaseCount: manifest.aggregate.phaseCount,
    shardCount: manifest.aggregate.shardCount,
    observationCount: manifest.aggregate.observationCount,
    credentialsRead: false,
    networkRequestsPerformed: false,
    sensitiveValuesPrinted: false,
  };
}

export function parseJsonCompatibilitySourceManifestArgs(argv) {
  const values = new Map();
  const phasePaths = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      if (help) throw new Error("--help must not be repeated");
      help = true;
      continue;
    }
    if (argument !== "--plan" && argument !== "--phase" && argument !== "--out") {
      throw new Error("unknown option");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--phase") {
      phasePaths.push(value);
    } else {
      if (values.has(argument)) throw new Error(`${argument} must not be repeated`);
      values.set(argument, value);
    }
  }
  if (help) {
    if (values.size > 0 || phasePaths.length > 0) {
      throw new Error("--help does not accept collection options");
    }
    return { help: true };
  }
  for (const name of ["--plan", "--out"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  if (phasePaths.length !== 4) {
    throw new Error("--phase must be repeated exactly four times in plan order");
  }
  return {
    planPath: values.get("--plan"),
    phasePaths,
    outPath: values.get("--out"),
  };
}

function requirePath(value, option) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  bun tools/collect_container_runtime_json_compatibility_source_manifest.mjs --plan <plan.json> --phase <baseline.json> --phase <mixed.json> --phase <candidate.json> --phase <rollback.json> --out <manifest.json>",
    "",
    "The collector is offline, accepts no credential or key options, validates every input before writing, and creates the output file without replacing an existing file.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  try {
    const options = parseJsonCompatibilitySourceManifestArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runJsonCompatibilitySourceManifestCollector(options);
    console.log(
      `JSON compatibility source manifest created: ${result.sourceManifestSha256}; ${result.phaseCount} phases and ${result.observationCount} shard records validated offline.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility source-manifest failure";
    console.error(`JSON compatibility source-manifest collection failed: ${message}`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
