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
  "container-runtime-json-compatibility-permit-issuer",
  "wrangler.staging.jsonc",
);
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const ISSUER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const PERMIT_ISSUER = "cinatoken-json-compatibility-permit-issuer-staging";
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateJsonCompatibilityPermitIssuerConfig(
  input,
  campaign = null,
) {
  const config = record(input, "permit issuer config");
  exactKeys(config, [
    "$schema", "name", "main", "compatibility_date", "workers_dev",
    "preview_urls", "observability", "version_metadata", "durable_objects",
    "migrations", "vars",
  ], "permit issuer config");
  equal(config.$schema, "../../node_modules/wrangler/config-schema.json", "issuer schema");
  equal(config.name, ISSUER_SERVICE, "issuer service name");
  equal(config.main, "src/index.ts", "issuer main module");
  equal(config.compatibility_date, "2026-08-04", "issuer compatibility date");
  equal(config.workers_dev, false, "issuer workers_dev");
  equal(config.preview_urls, false, "issuer preview URLs");
  canonicalEqual(config.observability, { enabled: true, head_sampling_rate: 1 }, "issuer observability");
  canonicalEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" }, "issuer version metadata");
  canonicalEqual(config.durable_objects, {
    bindings: [{
      name: "JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY",
      class_name: "JsonCompatibilityPermitIssuanceAuthority",
    }],
  }, "issuer Durable Object");
  canonicalEqual(config.migrations, [{
    tag: "v1",
    new_sqlite_classes: ["JsonCompatibilityPermitIssuanceAuthority"],
  }], "issuer migration");
  const enabled = campaign !== null;
  if (enabled) {
    keyId(campaign.authorityCurrentKid, "issuer authority current KID");
    sha256(campaign.authorityCurrentCredentialIdSha256, "issuer authority credential digest");
    keyId(campaign.permitKeyId, "permit key ID");
    sha256(campaign.permitSpkiSha256, "permit SPKI digest");
  }
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_ISSUER: INVOKER_SERVICE,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_AUDIENCE: ISSUER_SERVICE,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID:
      enabled ? campaign.authorityCurrentKid : "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256:
      enabled ? campaign.authorityCurrentCredentialIdSha256 : "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
    JSON_COMPATIBILITY_PERMIT_AUDIENCE: EXECUTOR_SERVICE,
    JSON_COMPATIBILITY_PERMIT_KEY_ID: enabled ? campaign.permitKeyId : "",
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256:
      enabled ? campaign.permitSpkiSha256 : "",
  }, "issuer vars");
  return { serviceName: config.name, enabled, campaignScopedDurableObject: true };
}

export async function prepareJsonCompatibilityPermitIssuerConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging permit issuer config",
    ),
    "base staging permit issuer config",
  );
  validateJsonCompatibilityPermitIssuerConfig(base);
  const campaign = structuredClone(base);
  const values = {
    authorityCurrentKid: options.authorityCurrentKid,
    authorityCurrentCredentialIdSha256:
      options.authorityCurrentCredentialIdSha256,
    permitKeyId: options.permitKeyId,
    permitSpkiSha256: options.permitSpkiSha256,
  };
  campaign.vars.JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID =
    values.authorityCurrentKid;
  campaign.vars.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256 =
    values.authorityCurrentCredentialIdSha256;
  campaign.vars.JSON_COMPATIBILITY_PERMIT_KEY_ID = values.permitKeyId;
  campaign.vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256 = values.permitSpkiSha256;
  const validation = validateJsonCompatibilityPermitIssuerConfig(campaign, values);
  await writeFile(outPath, canonicalJson(campaign), { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-permit-issuer-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    configSha256: sha256Canonical(campaign),
    changedVars: [
      "JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED",
      "JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID",
      "JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256",
      "JSON_COMPATIBILITY_PERMIT_KEY_ID",
      "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
    ],
    secretsRequired: [
      "JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET",
      "JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL",
      "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
    ],
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityPermitIssuerConfigArgs(argv) {
  const values = parseArgs(argv, [
    "--base", "--out", "--authority-current-kid",
    "--authority-current-credential-id-sha256", "--permit-key-id",
    "--permit-spki-sha256",
  ]);
  if (values.help) return values;
  for (const name of [
    "--out", "--authority-current-kid",
    "--authority-current-credential-id-sha256", "--permit-key-id",
    "--permit-spki-sha256",
  ]) requiredValue(values.map, name);
  keyId(values.map.get("--authority-current-kid"), "--authority-current-kid");
  sha256(values.map.get("--authority-current-credential-id-sha256"), "--authority-current-credential-id-sha256");
  keyId(values.map.get("--permit-key-id"), "--permit-key-id");
  sha256(values.map.get("--permit-spki-sha256"), "--permit-spki-sha256");
  return {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    authorityCurrentKid: values.map.get("--authority-current-kid"),
    authorityCurrentCredentialIdSha256:
      values.map.get("--authority-current-credential-id-sha256"),
    permitKeyId: values.map.get("--permit-key-id"),
    permitSpkiSha256: values.map.get("--permit-spki-sha256"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_permit_issuer_config.mjs --out <campaign-wrangler.jsonc> --authority-current-kid <kid> --authority-current-credential-id-sha256 <sha256> --permit-key-id <kid> --permit-spki-sha256 <sha256> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The output is create-only and contains no secret material. Provision the authority HMAC secret and Ed25519 PKCS8/SPKI bytes separately as Worker secrets.",
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
    options = parseJsonCompatibilityPermitIssuerConfigArgs(argv);
    if (options.help) return console.log(usage());
    const result = await prepareJsonCompatibilityPermitIssuerConfig(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : `Permit issuer campaign config created: ${result.configSha256}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected permit issuer config preparation failure";
    console.error(options?.json || argv.includes("--json") ? JSON.stringify({ ok: false, error: message }, null, 2) : `Permit issuer config preparation failed: ${message}`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
