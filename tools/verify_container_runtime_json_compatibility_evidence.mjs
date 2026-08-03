#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  buildJsonCompatibilityCampaignPlan,
  createSyntheticJsonCompatibilityEvidence,
  parseStrictJsonObject,
  verifyJsonCompatibilityCampaignEvidence,
} from "./container_runtime_json_compatibility_campaign.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(
  repoRoot,
  "services",
  "container-controller",
  "wrangler.staging.jsonc",
);

export async function runJsonCompatibilityEvidenceVerifier(options) {
  if (options.selfTest) {
    const config = parseStrictJsonObject(
      await readFile(path.resolve(options.configPath ?? defaultConfigPath), "utf8"),
      "staging Controller config",
    );
    const plan = buildJsonCompatibilityCampaignPlan({
      config,
      campaignIdSha256: "11".repeat(32),
      controllerVersionId: "controller-version-self-test",
      runtimeNBuildIdSha256: "22".repeat(32),
      runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
      runtimeNMinusOneBuildIdSha256: "44".repeat(32),
      runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
      candidateShardIndex: 3,
    });
    const evidence = createSyntheticJsonCompatibilityEvidence(plan);
    return {
      ...verifyJsonCompatibilityCampaignEvidence(plan, evidence, {
        allowSynthetic: true,
      }),
      mode: "self-test",
      fixtureOnly: true,
    };
  }
  const plan = parseStrictJsonObject(
    await readFile(path.resolve(options.planPath), "utf8"),
    "JSON compatibility plan",
  );
  const evidence = parseStrictJsonObject(
    await readFile(path.resolve(options.evidencePath), "utf8"),
    "JSON compatibility evidence",
  );
  return verifyJsonCompatibilityCampaignEvidence(plan, evidence);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set(["--plan", "--evidence", "--config"]);
  const flagOptions = new Set(["--self-test", "--json", "--help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") flags.add("--help");
    else if (flagOptions.has(argument)) {
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
  if (flags.has("--help")) return { help: true };
  const selfTest = flags.has("--self-test");
  if (selfTest && (values.has("--plan") || values.has("--evidence"))) {
    throw new Error("--self-test does not accept --plan or --evidence");
  }
  if (!selfTest) {
    for (const name of ["--plan", "--evidence"]) {
      if (!values.has(name)) throw new Error(`${name} is required`);
    }
    if (values.has("--config")) {
      throw new Error("--config is accepted only with --self-test");
    }
  }
  return {
    selfTest,
    json: flags.has("--json"),
    configPath: values.get("--config"),
    planPath: values.get("--plan"),
    evidencePath: values.get("--evidence"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/verify_container_runtime_json_compatibility_evidence.mjs --plan <plan.json> --evidence <evidence.json> [--json]",
    "  bun tools/verify_container_runtime_json_compatibility_evidence.mjs --self-test [--config <path>] [--json]",
    "",
    "Verification is offline and read-only. Normal mode accepts only evidence marked remote-staging; synthetic-self-test evidence is rejected.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runJsonCompatibilityEvidenceVerifier(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `JSON compatibility evidence ${result.mode} passed: ${result.phaseCount} phases, ${result.observationCount} shard observations, zero Protobuf attempts and zero protected mutations.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility evidence failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility evidence verification failed: ${message}`);
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
