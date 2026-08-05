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
  "container-runtime-json-compatibility-runner",
  "wrangler.staging.jsonc",
);
const RUNNER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-runner-staging";
const OPERATOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateJsonCompatibilityRunnerConfig(input, campaign = null) {
  const config = record(input, "runner config");
  exactKeys(config, [
    "$schema", "name", "main", "compatibility_date", "workers_dev",
    "preview_urls", "observability", "version_metadata", "services", "vars",
  ], "runner config");
  equal(config.$schema, "../../node_modules/wrangler/config-schema.json", "runner schema");
  equal(config.name, RUNNER_SERVICE, "runner service name");
  equal(config.main, "src/index.ts", "runner main module");
  equal(config.compatibility_date, "2026-08-04", "runner compatibility date");
  equal(config.workers_dev, false, "runner workers_dev");
  equal(config.preview_urls, false, "runner preview URLs");
  canonicalEqual(
    config.observability,
    { enabled: true, head_sampling_rate: 1 },
    "runner observability",
  );
  canonicalEqual(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "runner version metadata",
  );
  canonicalEqual(config.services, [{
    binding: "JSON_COMPATIBILITY_OPERATOR_SERVICE",
    service: OPERATOR_SERVICE,
    entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
  }], "runner Operator binding");
  const enabled = campaign !== null;
  if (enabled) safeToken(campaign.operatorVersionId, "operator version ID");
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_RUNNER_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID:
      enabled ? campaign.operatorVersionId : "",
  }, "runner vars");
  return { serviceName: config.name, enabled, privateServiceBinding: true };
}

export async function prepareJsonCompatibilityRunnerConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging runner config",
    ),
    "base staging runner config",
  );
  validateJsonCompatibilityRunnerConfig(base);
  const values = { operatorVersionId: options.operatorVersionId };
  safeToken(values.operatorVersionId, "operator version ID");
  const campaign = structuredClone(base);
  campaign.vars.JSON_COMPATIBILITY_RUNNER_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID =
    values.operatorVersionId;
  const validation = validateJsonCompatibilityRunnerConfig(campaign, values);
  await writeFile(outPath, canonicalJson(campaign), {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-private-runner-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    configSha256: sha256Canonical(campaign),
    changedVars: [
      "JSON_COMPATIBILITY_RUNNER_ENABLED",
      "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
      "JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID",
    ],
    secretsRequired: [],
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityRunnerConfigArgs(argv) {
  const values = parseArgs(argv, ["--base", "--out", "--operator-version-id"]);
  if (values.help) return values;
  requiredValue(values.map, "--out");
  requiredValue(values.map, "--operator-version-id");
  safeToken(values.map.get("--operator-version-id"), "--operator-version-id");
  return {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    operatorVersionId: values.map.get("--operator-version-id"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_runner_config.mjs --out <campaign-wrangler.jsonc> --operator-version-id <id> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The create-only output contains no secret material and enables only private named-entrypoint RPC.",
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

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityRunnerConfigArgs(argv);
    if (options.help) return console.log(usage());
    const result = await prepareJsonCompatibilityRunnerConfig(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Private runner campaign config created: ${result.configSha256}`,
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "unexpected runner config preparation failure";
    console.error(
      options?.json || argv.includes("--json")
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : `Private runner config preparation failed: ${message}`,
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
