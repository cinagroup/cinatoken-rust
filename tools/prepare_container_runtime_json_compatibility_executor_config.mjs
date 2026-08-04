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
  "container-runtime-json-compatibility-executor",
  "wrangler.staging.jsonc",
);

export function validateJsonCompatibilityExecutorConfig(
  input,
  {
    campaign = false,
    permitKeyId = "",
    permitSpkiSha256 = "",
  } = {},
) {
  const config = record(input, "executor config");
  exactKeys(config, [
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "workers_dev",
    "preview_urls",
    "observability",
    "version_metadata",
    "services",
    "durable_objects",
    "migrations",
    "vars",
  ], "executor config");
  equal(
    config.$schema,
    "../../node_modules/wrangler/config-schema.json",
    "executor schema",
  );
  equal(
    config.name,
    "cinatoken-container-runtime-json-compatibility-executor-staging",
    "executor service name",
  );
  equal(config.main, "src/index.ts", "executor main module");
  equal(config.compatibility_date, "2026-08-04", "executor compatibility date");
  equal(config.workers_dev, false, "executor workers_dev");
  equal(config.preview_urls, false, "executor preview URLs");
  canonicalEqual(
    config.observability,
    { enabled: true, head_sampling_rate: 1 },
    "executor observability",
  );
  canonicalEqual(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "executor version metadata",
  );
  canonicalEqual(
    config.services,
    [{
      binding: "CONTAINER_CONTROLLER_JSON_PROBE",
      service: "cinatoken-container-controller-staging",
      entrypoint: "JsonCompatibilityProbeEntrypoint",
    }],
    "executor Service Binding",
  );
  canonicalEqual(
    config.durable_objects,
    {
      bindings: [{
        name: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        class_name: "JsonCompatibilityCampaignAuthority",
      }],
    },
    "executor campaign authority Durable Object",
  );
  canonicalEqual(
    config.migrations,
    [{
      tag: "v1",
      new_sqlite_classes: ["JsonCompatibilityCampaignAuthority"],
    }],
    "executor Durable Object migration",
  );
  if (campaign) {
    keyId(permitKeyId, "campaign permit key ID");
    sha256(permitSpkiSha256, "campaign permit SPKI digest");
  } else if (permitKeyId !== "" || permitSpkiSha256 !== "") {
    throw new Error("tracked executor config must not pin campaign permit trust");
  }
  canonicalEqual(
    config.vars,
    {
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_EXECUTOR_ENABLED: campaign ? "true" : "false",
      JSON_COMPATIBILITY_PERMIT_ISSUER:
        "cinatoken-json-compatibility-permit-issuer-staging",
      JSON_COMPATIBILITY_PERMIT_AUDIENCE:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      JSON_COMPATIBILITY_PERMIT_KEY_ID: campaign ? permitKeyId : "",
      JSON_COMPATIBILITY_PERMIT_SPKI_SHA256:
        campaign ? permitSpkiSha256 : "",
    },
    "executor vars",
  );
  return {
    environment: "staging",
    serviceName: config.name,
    executorEnabled: campaign,
    privateServiceBinding: true,
    campaignScopedDurableObject: true,
    permitTrustPinned: campaign,
  };
}

export async function prepareJsonCompatibilityExecutorConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging executor config",
    ),
    "base staging executor config",
  );
  validateJsonCompatibilityExecutorConfig(base);
  const campaign = structuredClone(base);
  campaign.vars.JSON_COMPATIBILITY_EXECUTOR_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_PERMIT_KEY_ID = options.permitKeyId;
  campaign.vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256 =
    options.permitSpkiSha256;
  const validation = validateJsonCompatibilityExecutorConfig(campaign, {
    campaign: true,
    permitKeyId: options.permitKeyId,
    permitSpkiSha256: options.permitSpkiSha256,
  });
  await writeFile(outPath, canonicalJson(campaign), {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-executor-campaign-config-preparation",
    environment: validation.environment,
    serviceName: validation.serviceName,
    configSha256: sha256Canonical(campaign),
    changedVars: [
      "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
      "JSON_COMPATIBILITY_PERMIT_KEY_ID",
      "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
    ],
    executorEnabled: true,
    campaignScopedDurableObject: validation.campaignScopedDurableObject,
    permitTrustPinned: validation.permitTrustPinned,
    permitPublicKeySecretRequired:
      "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityExecutorConfigArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") flags.add("--help");
    else if (argument === "--help" || argument === "--json") {
      if (flags.has(argument)) throw new Error(`${argument} must not be repeated`);
      flags.add(argument);
    } else if (
      argument === "--base"
      || argument === "--out"
      || argument === "--permit-key-id"
      || argument === "--permit-spki-sha256"
    ) {
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
    if (values.size > 0) throw new Error("--help does not accept preparation options");
    return { help: true };
  }
  if (!values.has("--out")) throw new Error("--out is required");
  if (!values.has("--permit-key-id")) {
    throw new Error("--permit-key-id is required");
  }
  if (!values.has("--permit-spki-sha256")) {
    throw new Error("--permit-spki-sha256 is required");
  }
  keyId(values.get("--permit-key-id"), "--permit-key-id");
  sha256(values.get("--permit-spki-sha256"), "--permit-spki-sha256");
  return {
    json: flags.has("--json"),
    basePath: values.get("--base"),
    outPath: values.get("--out"),
    permitKeyId: values.get("--permit-key-id"),
    permitSpkiSha256: values.get("--permit-spki-sha256"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_executor_config.mjs --out <campaign-wrangler.jsonc> --permit-key-id <kid> --permit-spki-sha256 <sha256> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The create-only output enables the executor and pins the campaign Ed25519 key ID and SPKI digest. Provision JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL separately as a Worker secret.",
  ].join("\n");
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
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} fields must be exactly ${wanted.join(", ")}`);
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

function keyId(value, label) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} must be a safe key ID`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityExecutorConfigArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await prepareJsonCompatibilityExecutorConfig(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `JSON compatibility executor campaign config created: ${result.configSha256}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "unexpected executor config preparation failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Executor campaign config preparation failed: ${message}`);
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
