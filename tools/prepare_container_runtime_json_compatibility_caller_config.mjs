#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  parseStrictJsonObject,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBasePath = path.join(
  repoRoot,
  "services",
  "container-runtime-json-compatibility-caller",
  "wrangler.staging.toml",
);
const CALLER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-caller-staging";
const RUNNER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-runner-staging";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEPLOYMENT_PROFILES = Object.freeze({
  dark: Object.freeze({
    executionGateEnabled: false,
    statusGateEnabled: false,
    runnerIdentityRequired: false,
  }),
  "status-only": Object.freeze({
    executionGateEnabled: false,
    statusGateEnabled: true,
    runnerIdentityRequired: true,
  }),
  execution: Object.freeze({
    executionGateEnabled: true,
    statusGateEnabled: true,
    runnerIdentityRequired: true,
  }),
});

export function validateJsonCompatibilityCallerConfig(input, campaign = null) {
  const config = record(input, "caller config");
  exactKeys(config, [
    "name", "main", "compatibility_date", "compatibility_flags",
    "workers_dev", "preview_urls", "observability", "version_metadata",
    "services", "vars",
  ], "caller config");
  equal(config.name, CALLER_SERVICE, "caller service name");
  equal(config.main, "src/index.ts", "caller main module");
  equal(config.compatibility_date, "2026-08-05", "caller compatibility date");
  canonicalEqual(
    config.compatibility_flags,
    ["nodejs_compat"],
    "caller compatibility flags",
  );
  equal(config.workers_dev, false, "caller workers_dev");
  equal(config.preview_urls, false, "caller preview URLs");
  canonicalEqual(
    config.observability,
    { enabled: true, head_sampling_rate: 1 },
    "caller observability",
  );
  canonicalEqual(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "caller version metadata",
  );
  canonicalEqual(config.services, [{
    binding: "JSON_COMPATIBILITY_RUNNER_SERVICE",
    service: RUNNER_SERVICE,
    entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
  }], "caller Runner binding");

  const deploymentState = campaign === null
    ? "dark"
    : deploymentStateValue(campaign.deploymentState, "deploymentState");
  const profile = DEPLOYMENT_PROFILES[deploymentState];
  const runnerVersionId = campaign?.runnerVersionId;
  const runnerConfigSha256 = campaign?.runnerConfigSha256;
  validateRunnerIdentityInputs(
    profile,
    deploymentState,
    runnerVersionId,
    runnerConfigSha256,
  );
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_CALLER_ENABLED:
      profile.executionGateEnabled ? "true" : "false",
    JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED:
      profile.statusGateEnabled ? "true" : "false",
    JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID:
      profile.runnerIdentityRequired ? runnerVersionId : "",
    JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256:
      profile.runnerIdentityRequired ? runnerConfigSha256 : "",
  }, "caller vars");
  return {
    serviceName: config.name,
    enabled: profile.executionGateEnabled,
    deploymentState,
    executionEnabled: profile.executionGateEnabled,
    statusReadEnabled: profile.statusGateEnabled,
    privateServiceBinding: true,
    runnerIdentityPinned: profile.runnerIdentityRequired,
  };
}

export async function prepareJsonCompatibilityCallerConfig(options) {
  const deploymentState = deploymentStateValue(
    options?.deploymentState,
    "deploymentState",
  );
  const profile = DEPLOYMENT_PROFILES[deploymentState];
  const runnerVersionId = options?.runnerVersionId;
  const runnerConfigSha256 = options?.runnerConfigSha256;
  validateRunnerIdentityInputs(
    profile,
    deploymentState,
    runnerVersionId,
    runnerConfigSha256,
  );
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const baseSource = await readBoundedUtf8File(
    basePath,
    JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
    "base staging caller config",
  );
  const base = parseCallerBaseConfig(baseSource, basePath);
  validateJsonCompatibilityCallerConfig(base);
  const values = profile.runnerIdentityRequired
    ? { deploymentState, runnerVersionId, runnerConfigSha256 }
    : { deploymentState };
  const campaign = structuredClone(base);
  campaign.vars.JSON_COMPATIBILITY_CALLER_ENABLED =
    profile.executionGateEnabled ? "true" : "false";
  campaign.vars.JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED =
    profile.statusGateEnabled ? "true" : "false";
  campaign.vars.JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID =
    profile.runnerIdentityRequired ? runnerVersionId : "";
  campaign.vars.JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256 =
    profile.runnerIdentityRequired ? runnerConfigSha256 : "";
  const validation = validateJsonCompatibilityCallerConfig(campaign, values);
  await writeFile(outPath, canonicalJson(campaign), {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-private-caller-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    deploymentState: validation.deploymentState,
    executionEnabled: validation.executionEnabled,
    statusReadEnabled: validation.statusReadEnabled,
    runnerIdentityPinned: validation.runnerIdentityPinned,
    configSha256: sha256Canonical(campaign),
    changedVars: changedVarsForDeploymentState(deploymentState),
    secretsRequired: [],
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityCallerConfigArgs(argv) {
  const values = parseArgs(argv, [
    "--base", "--out", "--deployment-state", "--runner-version-id",
    "--runner-config-sha256",
  ]);
  if (values.help) return values;
  requiredValue(values.map, "--out");
  const deploymentState = deploymentStateValue(
    values.map.get("--deployment-state"),
    "--deployment-state",
  );
  const runnerVersionId = values.map.get("--runner-version-id");
  const runnerConfigSha256 = values.map.get("--runner-config-sha256");
  validateRunnerIdentityArgs(
    DEPLOYMENT_PROFILES[deploymentState],
    deploymentState,
    runnerVersionId,
    runnerConfigSha256,
  );
  const options = {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    deploymentState,
  };
  if (runnerVersionId !== undefined) options.runnerVersionId = runnerVersionId;
  if (runnerConfigSha256 !== undefined) {
    options.runnerConfigSha256 = runnerConfigSha256;
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_caller_config.mjs --out <campaign-wrangler.jsonc> [--deployment-state <dark|status-only|execution>] [--runner-version-id <id>] [--runner-config-sha256 <sha256>] [--base <tracked-staging.jsonc>] [--json]",
    "",
    "Deployment states:",
    "  dark         Disable execution and status reads; forbids Runner identity flags.",
    "  status-only  Enable status reads only; requires exact Runner version and config digest.",
    "  execution    Enable execution and status reads; requires exact Runner version and config digest (default).",
    "",
    "The create-only output contains no secret material and configures only private named-entrypoint RPC.",
  ].join("\n");
}

function parseArgs(argv, options) {
  const map = new Map();
  let help = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "--json") json = true;
    else if (options.includes(argument)) {
      if (map.has(argument)) throw new Error(`${argument} must not be repeated`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      map.set(argument, value);
    } else throw new Error(`unknown option: ${argument}`);
  }
  if (help && (map.size > 0 || json)) {
    throw new Error("--help does not accept preparation options");
  }
  return { help, json, map };
}

function requiredValue(values, name) {
  if (!values.has(name)) throw new Error(`${name} is required`);
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseCallerBaseConfig(source, basePath) {
  if (path.extname(basePath).toLowerCase() !== ".toml") {
    return parseStrictJsonObject(source, "base staging caller config");
  }
  try {
    return record(Bun.TOML.parse(source), "base staging caller config");
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid TOML";
    throw new Error(`base staging caller config is invalid TOML: ${message}`);
  }
}

function exactKeys(value, expected, label) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} fields do not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match`);
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match`);
  }
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} must be a safe token`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function deploymentStateValue(value, label) {
  const state = value === undefined ? "execution" : value;
  if (typeof state !== "string" || !Object.hasOwn(DEPLOYMENT_PROFILES, state)) {
    throw new Error(`${label} must be one of: dark, status-only, execution`);
  }
  return state;
}

function validateRunnerIdentityInputs(
  profile,
  deploymentState,
  runnerVersionId,
  runnerConfigSha256,
) {
  if (profile.runnerIdentityRequired) {
    if (runnerVersionId === undefined) {
      throw new Error(
        `runnerVersionId is required when deploymentState is ${deploymentState}`,
      );
    }
    if (runnerConfigSha256 === undefined) {
      throw new Error(
        `runnerConfigSha256 is required when deploymentState is ${deploymentState}`,
      );
    }
    safeToken(runnerVersionId, "runner version ID");
    sha256(runnerConfigSha256, "runner config digest");
    return;
  }
  if (runnerVersionId !== undefined || runnerConfigSha256 !== undefined) {
    throw new Error(
      "runnerVersionId and runnerConfigSha256 are not allowed when deploymentState is dark",
    );
  }
}

function validateRunnerIdentityArgs(
  profile,
  deploymentState,
  runnerVersionId,
  runnerConfigSha256,
) {
  if (profile.runnerIdentityRequired) {
    if (runnerVersionId === undefined) {
      throw new Error(
        `--runner-version-id is required when --deployment-state is ${deploymentState}`,
      );
    }
    if (runnerConfigSha256 === undefined) {
      throw new Error(
        `--runner-config-sha256 is required when --deployment-state is ${deploymentState}`,
      );
    }
    safeToken(runnerVersionId, "--runner-version-id");
    sha256(runnerConfigSha256, "--runner-config-sha256");
    return;
  }
  if (runnerVersionId !== undefined || runnerConfigSha256 !== undefined) {
    throw new Error(
      "Runner identity flags are not allowed when --deployment-state is dark",
    );
  }
}

function changedVarsForDeploymentState(deploymentState) {
  if (deploymentState === "dark") return [];
  const changed = [
    "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
    "JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID",
    "JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256",
  ];
  if (deploymentState === "execution") {
    changed.unshift("JSON_COMPATIBILITY_CALLER_ENABLED");
  }
  return changed;
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityCallerConfigArgs(argv);
    if (options.help) return console.log(usage());
    const result = await prepareJsonCompatibilityCallerConfig(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Private caller campaign config created: ${result.configSha256}`,
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "unexpected caller config preparation failure";
    console.error(
      options?.json || argv.includes("--json")
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : `Private caller config preparation failed: ${message}`,
    );
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
