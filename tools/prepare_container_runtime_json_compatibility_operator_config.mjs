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
  "container-runtime-json-compatibility-operator",
  "wrangler.staging.jsonc",
);
const OPERATOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
const OPERATOR_APPROVAL_ISSUER =
  "cinatoken-json-compatibility-campaign-approval-authority-staging";
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateJsonCompatibilityOperatorConfig(input, campaign = null) {
  const config = record(input, "operator config");
  exactKeys(config, [
    "$schema", "name", "main", "compatibility_date", "workers_dev",
    "preview_urls", "observability", "version_metadata", "services", "vars",
  ], "operator config");
  equal(config.$schema, "../../node_modules/wrangler/config-schema.json", "operator schema");
  equal(config.name, OPERATOR_SERVICE, "operator service name");
  equal(config.main, "src/index.ts", "operator main module");
  equal(config.compatibility_date, "2026-08-04", "operator compatibility date");
  equal(config.workers_dev, false, "operator workers_dev");
  equal(config.preview_urls, false, "operator preview URLs");
  canonicalEqual(
    config.observability,
    { enabled: true, head_sampling_rate: 1 },
    "operator observability",
  );
  canonicalEqual(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "operator version metadata",
  );
  canonicalEqual(config.services, [{
    binding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
    service: INVOKER_SERVICE,
    entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
  }], "operator Service Binding");

  const enabled = campaign !== null;
  if (enabled) {
    keyId(campaign.currentKid, "operator current KID");
    sha256(campaign.currentCredentialIdSha256, "operator credential digest");
    keyId(campaign.approvalCurrentKid, "operator approval current KID");
    sha256(
      campaign.approvalCurrentSpkiSha256,
      "operator approval current SPKI digest",
    );
    validatePreviousApproval(campaign);
    safeToken(campaign.invokerVersionId, "invoker version ID");
  }
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_OPERATOR_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_OPERATOR_ISSUER: OPERATOR_ISSUER,
    JSON_COMPATIBILITY_OPERATOR_AUDIENCE: INVOKER_SERVICE,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER: OPERATOR_APPROVAL_ISSUER,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE: OPERATOR_SERVICE,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID:
      enabled ? campaign.approvalCurrentKid : "",
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256:
      enabled ? campaign.approvalCurrentSpkiSha256 : "",
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID:
      enabled ? (campaign.approvalPreviousKid ?? "") : "",
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256:
      enabled ? (campaign.approvalPreviousSpkiSha256 ?? "") : "",
    JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: enabled ? campaign.currentKid : "",
    JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      enabled ? campaign.currentCredentialIdSha256 : "",
    JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID:
      enabled ? campaign.invokerVersionId : "",
  }, "operator vars");
  return { serviceName: config.name, enabled, privateServiceBinding: true };
}

export async function prepareJsonCompatibilityOperatorConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging operator config",
    ),
    "base staging operator config",
  );
  validateJsonCompatibilityOperatorConfig(base);
  const values = {
    currentKid: options.currentKid,
    currentCredentialIdSha256: options.currentCredentialIdSha256,
    approvalCurrentKid: options.approvalCurrentKid,
    approvalCurrentSpkiSha256: options.approvalCurrentSpkiSha256,
    approvalPreviousKid: options.approvalPreviousKid ?? "",
    approvalPreviousSpkiSha256: options.approvalPreviousSpkiSha256 ?? "",
    invokerVersionId: options.invokerVersionId,
  };
  const campaign = structuredClone(base);
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_ENABLED = "true";
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_KID = values.currentKid;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256 =
    values.currentCredentialIdSha256;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID =
    values.approvalCurrentKid;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256 =
    values.approvalCurrentSpkiSha256;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID =
    values.approvalPreviousKid;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256 =
    values.approvalPreviousSpkiSha256;
  campaign.vars.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID =
    values.invokerVersionId;
  const validation = validateJsonCompatibilityOperatorConfig(campaign, values);
  await writeFile(outPath, canonicalJson(campaign), {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-private-operator-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    configSha256: sha256Canonical(campaign),
    changedVars: [
      "JSON_COMPATIBILITY_OPERATOR_ENABLED",
      "JSON_COMPATIBILITY_OPERATOR_CURRENT_KID",
      "JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
      "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID",
      "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256",
      "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID",
      "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256",
      "JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID",
    ],
    secretsRequired: ["JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET"],
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityOperatorConfigArgs(argv) {
  const names = [
    "--base", "--out", "--hmac-kid", "--hmac-credential-id-sha256",
    "--approval-current-kid", "--approval-current-spki-sha256",
    "--approval-previous-kid", "--approval-previous-spki-sha256",
    "--invoker-version-id",
  ];
  const values = parseArgs(argv, names);
  if (values.help) return values;
  for (const name of [
    "--out",
    "--hmac-kid",
    "--hmac-credential-id-sha256",
    "--approval-current-kid",
    "--approval-current-spki-sha256",
    "--invoker-version-id",
  ]) requiredValue(values.map, name);
  keyId(values.map.get("--hmac-kid"), "--hmac-kid");
  sha256(
    values.map.get("--hmac-credential-id-sha256"),
    "--hmac-credential-id-sha256",
  );
  keyId(values.map.get("--approval-current-kid"), "--approval-current-kid");
  sha256(
    values.map.get("--approval-current-spki-sha256"),
    "--approval-current-spki-sha256",
  );
  const previousKid = values.map.get("--approval-previous-kid") ?? "";
  const previousSpki =
    values.map.get("--approval-previous-spki-sha256") ?? "";
  validatePreviousApproval({
    approvalCurrentKid: values.map.get("--approval-current-kid"),
    approvalCurrentSpkiSha256:
      values.map.get("--approval-current-spki-sha256"),
    approvalPreviousKid: previousKid,
    approvalPreviousSpkiSha256: previousSpki,
  });
  safeToken(values.map.get("--invoker-version-id"), "--invoker-version-id");
  return {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    currentKid: values.map.get("--hmac-kid"),
    currentCredentialIdSha256:
      values.map.get("--hmac-credential-id-sha256"),
    approvalCurrentKid: values.map.get("--approval-current-kid"),
    approvalCurrentSpkiSha256:
      values.map.get("--approval-current-spki-sha256"),
    approvalPreviousKid: previousKid,
    approvalPreviousSpkiSha256: previousSpki,
    invokerVersionId: values.map.get("--invoker-version-id"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_operator_config.mjs --out <campaign-wrangler.jsonc> --hmac-kid <kid> --hmac-credential-id-sha256 <sha256> --approval-current-kid <kid> --approval-current-spki-sha256 <sha256> [--approval-previous-kid <kid> --approval-previous-spki-sha256 <sha256>] --invoker-version-id <id> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The output is create-only and contains no secret material. Provision JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET separately as a Worker secret.",
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

function keyId(value, label) {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new Error(`${label} must be a key ID`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be SHA-256`);
  }
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} must be a safe token`);
  }
}

function validatePreviousApproval(values) {
  const previousKid = values.approvalPreviousKid ?? "";
  const previousSpki = values.approvalPreviousSpkiSha256 ?? "";
  if ((previousKid === "") !== (previousSpki === "")) {
    throw new Error("operator approval previous KID and SPKI digest must be paired");
  }
  if (previousKid === "") return;
  keyId(previousKid, "operator approval previous KID");
  sha256(previousSpki, "operator approval previous SPKI digest");
  if (
    previousKid === values.approvalCurrentKid
    || previousSpki === values.approvalCurrentSpkiSha256
  ) {
    throw new Error("operator approval current and previous keys must differ");
  }
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityOperatorConfigArgs(argv);
    if (options.help) return console.log(usage());
    const result = await prepareJsonCompatibilityOperatorConfig(options);
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Private operator campaign config created: ${result.configSha256}`,
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "unexpected operator config preparation failure";
    console.error(
      options?.json || argv.includes("--json")
        ? JSON.stringify({ ok: false, error: message }, null, 2)
        : `Private operator config preparation failed: ${message}`,
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
