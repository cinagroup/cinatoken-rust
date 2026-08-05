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
  "container-runtime-json-compatibility-invoker",
  "wrangler.staging.jsonc",
);
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const ISSUER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
const STATUS_OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-status-staging";
const PERMIT_ISSUER = "cinatoken-json-compatibility-permit-issuer-staging";
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateJsonCompatibilityInvokerConfig(input, campaign = null) {
  const config = record(input, "invoker config");
  exactKeys(config, [
    "$schema", "name", "main", "compatibility_date", "workers_dev",
    "preview_urls", "observability", "version_metadata", "services",
    "durable_objects", "migrations", "vars",
  ], "invoker config");
  equal(config.$schema, "../../node_modules/wrangler/config-schema.json", "invoker schema");
  equal(config.name, INVOKER_SERVICE, "invoker service name");
  equal(config.main, "src/index.ts", "invoker main module");
  equal(config.compatibility_date, "2026-08-04", "invoker compatibility date");
  equal(config.workers_dev, false, "invoker workers_dev");
  equal(config.preview_urls, false, "invoker preview URLs");
  canonicalEqual(config.observability, { enabled: true, head_sampling_rate: 1 }, "invoker observability");
  canonicalEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" }, "invoker version metadata");
  canonicalEqual(config.services, [
    {
      binding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      service: ISSUER_SERVICE,
      entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
    },
    {
      binding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
      service: EXECUTOR_SERVICE,
      entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
    },
  ], "invoker Service Bindings");
  canonicalEqual(config.durable_objects, {
    bindings: [{
      name: "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
      class_name: "JsonCompatibilityInvocationAuthority",
    }],
  }, "invoker Durable Object");
  canonicalEqual(config.migrations, [{
    tag: "v1",
    new_sqlite_classes: ["JsonCompatibilityInvocationAuthority"],
  }], "invoker migration");
  const enabled = campaign !== null;
  if (enabled) {
    keyId(campaign.operatorCurrentKid, "operator current KID");
    sha256(campaign.operatorCurrentCredentialIdSha256, "operator credential digest");
    keyId(campaign.statusOperatorCurrentKid, "status operator current KID");
    sha256(
      campaign.statusOperatorCurrentCredentialIdSha256,
      "status operator credential digest",
    );
    keyId(campaign.issuerHmacKid, "issuer HMAC KID");
    sha256(campaign.issuerHmacCredentialIdSha256, "issuer HMAC credential digest");
    keyId(campaign.permitKeyId, "permit key ID");
    sha256(campaign.permitSpkiSha256, "permit SPKI digest");
  }
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_INVOKER_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID:
      enabled ? campaign.operatorCurrentKid : "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      enabled ? campaign.operatorCurrentCredentialIdSha256 : "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER: STATUS_OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID:
      enabled ? campaign.statusOperatorCurrentKid : "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      enabled ? campaign.statusOperatorCurrentCredentialIdSha256 : "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE: ISSUER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID:
      enabled ? campaign.issuerHmacKid : "",
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256:
      enabled ? campaign.issuerHmacCredentialIdSha256 : "",
    JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
    JSON_COMPATIBILITY_PERMIT_AUDIENCE: EXECUTOR_SERVICE,
    JSON_COMPATIBILITY_PERMIT_KEY_ID: enabled ? campaign.permitKeyId : "",
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256:
      enabled ? campaign.permitSpkiSha256 : "",
  }, "invoker vars");
  return { serviceName: config.name, enabled, privateServiceBindings: true };
}

export async function prepareJsonCompatibilityInvokerConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging invoker config",
    ),
    "base staging invoker config",
  );
  validateJsonCompatibilityInvokerConfig(base);
  const campaign = structuredClone(base);
  const values = {
    operatorCurrentKid: options.operatorCurrentKid,
    operatorCurrentCredentialIdSha256:
      options.operatorCurrentCredentialIdSha256,
    statusOperatorCurrentKid: options.statusOperatorCurrentKid,
    statusOperatorCurrentCredentialIdSha256:
      options.statusOperatorCurrentCredentialIdSha256,
    issuerHmacKid: options.issuerHmacKid,
    issuerHmacCredentialIdSha256: options.issuerHmacCredentialIdSha256,
    permitKeyId: options.permitKeyId,
    permitSpkiSha256: options.permitSpkiSha256,
  };
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID =
    values.operatorCurrentKid;
  campaign.vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256 =
    values.operatorCurrentCredentialIdSha256;
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID =
    values.statusOperatorCurrentKid;
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256 =
    values.statusOperatorCurrentCredentialIdSha256;
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID =
    values.issuerHmacKid;
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256 =
    values.issuerHmacCredentialIdSha256;
  campaign.vars.JSON_COMPATIBILITY_PERMIT_KEY_ID = values.permitKeyId;
  campaign.vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256 = values.permitSpkiSha256;
  const validation = validateJsonCompatibilityInvokerConfig(campaign, values);
  await writeFile(outPath, canonicalJson(campaign), { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-private-invoker-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    configSha256: sha256Canonical(campaign),
    changedVars: [
      "JSON_COMPATIBILITY_INVOKER_ENABLED",
      "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
      "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID",
      "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
      "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID",
      "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
      "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID",
      "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256",
      "JSON_COMPATIBILITY_PERMIT_KEY_ID",
      "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
    ],
    secretsRequired: [
      "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
      "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET",
      "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
      "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
    ],
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityInvokerConfigArgs(argv) {
  const names = [
    "--base", "--out", "--operator-current-kid",
    "--operator-current-credential-id-sha256", "--issuer-hmac-kid",
    "--status-operator-current-kid",
    "--status-operator-current-credential-id-sha256",
    "--issuer-hmac-credential-id-sha256", "--permit-key-id",
    "--permit-spki-sha256",
  ];
  const values = parseArgs(argv, names);
  if (values.help) return values;
  for (const name of names.slice(1)) requiredValue(values.map, name);
  for (const name of [
    "--operator-current-kid",
    "--status-operator-current-kid",
    "--issuer-hmac-kid",
    "--permit-key-id",
  ]) {
    keyId(values.map.get(name), name);
  }
  for (const name of [
    "--operator-current-credential-id-sha256",
    "--status-operator-current-credential-id-sha256",
    "--issuer-hmac-credential-id-sha256",
    "--permit-spki-sha256",
  ]) sha256(values.map.get(name), name);
  return {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    operatorCurrentKid: values.map.get("--operator-current-kid"),
    operatorCurrentCredentialIdSha256:
      values.map.get("--operator-current-credential-id-sha256"),
    statusOperatorCurrentKid:
      values.map.get("--status-operator-current-kid"),
    statusOperatorCurrentCredentialIdSha256:
      values.map.get("--status-operator-current-credential-id-sha256"),
    issuerHmacKid: values.map.get("--issuer-hmac-kid"),
    issuerHmacCredentialIdSha256:
      values.map.get("--issuer-hmac-credential-id-sha256"),
    permitKeyId: values.map.get("--permit-key-id"),
    permitSpkiSha256: values.map.get("--permit-spki-sha256"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_invoker_config.mjs --out <campaign-wrangler.jsonc> --operator-current-kid <kid> --operator-current-credential-id-sha256 <sha256> --status-operator-current-kid <kid> --status-operator-current-credential-id-sha256 <sha256> --issuer-hmac-kid <kid> --issuer-hmac-credential-id-sha256 <sha256> --permit-key-id <kid> --permit-spki-sha256 <sha256> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The output is create-only and contains no secret material. Provision the execution, status, and issuer HMAC secrets plus the Ed25519 public SPKI separately as Worker secrets.",
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
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      map.set(argument, value);
    } else throw new Error(`unknown option: ${argument}`);
  }
  if (help && (map.size > 0 || json)) throw new Error("--help does not accept preparation options");
  return { help, json, map };
}

function requiredValue(values, name) {
  if (!values.has(name)) throw new Error(`${name} is required`);
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${name} requires a path`);
  return value;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(`${label} fields do not match`);
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match`);
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} does not match`);
}

function keyId(value, label) {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new Error(`${label} must be a key ID`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be SHA-256`);
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityInvokerConfigArgs(argv);
    if (options.help) return console.log(usage());
    const result = await prepareJsonCompatibilityInvokerConfig(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : `Private invoker campaign config created: ${result.configSha256}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected invoker config preparation failure";
    console.error(options?.json || argv.includes("--json") ? JSON.stringify({ ok: false, error: message }, null, 2) : `Private invoker config preparation failed: ${message}`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
