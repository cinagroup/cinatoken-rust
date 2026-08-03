#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  buildJsonCompatibilityCampaignPlan,
  parseStrictJsonObject,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(
  repoRoot,
  "services",
  "container-controller",
  "wrangler.staging.jsonc",
);

export async function runJsonCompatibilityCampaignPlanner(options) {
  const configPath = path.resolve(options.configPath ?? defaultConfigPath);
  const config = parseStrictJsonObject(
    await readFile(configPath, "utf8"),
    "staging Controller config",
  );
  const inputs = options.selfTest
    ? {
        campaignIdSha256: "11".repeat(32),
        controllerVersionId: "controller-version-self-test",
        runtimeNBuildIdSha256: "22".repeat(32),
        runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
        runtimeNMinusOneBuildIdSha256: "44".repeat(32),
        runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
        candidateShardIndex: 3,
      }
    : options;
  const plan = buildJsonCompatibilityCampaignPlan({ config, ...inputs });
  validateJsonCompatibilityCampaignPlan(plan);
  if (!options.selfTest) return plan;
  return {
    ok: true,
    schemaVersion: 1,
    mode: "self-test",
    fixtureOnly: true,
    environment: "staging",
    planDigestSha256: plan.planDigestSha256,
    phaseCount: plan.phases.length,
    shardCount: plan.ring.shardCount,
    candidateShardIndex: plan.ring.candidateShardIndex,
    privateProbeTransport: plan.controller.privateProbeTransport,
    protobufTransportEnabled: false,
    protobufTransportStagingVerified: false,
    credentialsRead: false,
    networkRequestsPerformed: false,
    filesWritten: false,
    deploymentMutationAuthorized: false,
    deploymentMutationPerformed: false,
    remoteEvidenceCollected: false,
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--config",
    "--campaign-id-sha256",
    "--controller-version-id",
    "--runtime-n-build-id",
    "--runtime-n-image-digest",
    "--runtime-n-minus-one-build-id",
    "--runtime-n-minus-one-image-digest",
    "--candidate-shard-index",
  ]);
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
  const liveInputOptions = [
    "--campaign-id-sha256",
    "--controller-version-id",
    "--runtime-n-build-id",
    "--runtime-n-image-digest",
    "--runtime-n-minus-one-build-id",
    "--runtime-n-minus-one-image-digest",
    "--candidate-shard-index",
  ];
  if (selfTest && liveInputOptions.some((name) => values.has(name))) {
    throw new Error("--self-test does not accept campaign identity options");
  }
  if (!selfTest) {
    for (const name of liveInputOptions.slice(0, 6)) {
      if (!values.has(name)) throw new Error(`${name} is required`);
    }
  }
  const candidateShardIndex = values.has("--candidate-shard-index")
    ? Number(values.get("--candidate-shard-index"))
    : undefined;
  return {
    selfTest,
    json: flags.has("--json"),
    configPath: values.get("--config"),
    campaignIdSha256: values.get("--campaign-id-sha256"),
    controllerVersionId: values.get("--controller-version-id"),
    runtimeNBuildIdSha256: values.get("--runtime-n-build-id"),
    runtimeNImageDigest: values.get("--runtime-n-image-digest"),
    runtimeNMinusOneBuildIdSha256: values.get("--runtime-n-minus-one-build-id"),
    runtimeNMinusOneImageDigest: values.get("--runtime-n-minus-one-image-digest"),
    candidateShardIndex,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/plan_container_runtime_json_compatibility_campaign.mjs --campaign-id-sha256 <sha256> --controller-version-id <id> --runtime-n-build-id <sha256> --runtime-n-image-digest <sha256:...> --runtime-n-minus-one-build-id <sha256> --runtime-n-minus-one-image-digest <sha256:...> [--candidate-shard-index <index>] [--config <path>] [--json]",
    "  bun tools/plan_container_runtime_json_compatibility_campaign.mjs --self-test [--config <path>] [--json]",
    "",
    "This planner reads only the tracked staging config. It performs no network request, credential read, file write, deployment, gate change, provider call, or traffic mutation.",
    "The resulting plan requires a future private Service Binding probe executor; public Controller URLs are forbidden.",
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
    const result = await runJsonCompatibilityCampaignPlanner(options);
    if (options.json || !options.selfTest) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `JSON compatibility campaign planner self-test passed for ${result.shardCount} staging shards; fixture evidence only, no remote action performed.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility planner failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility campaign planner failed: ${message}`);
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
