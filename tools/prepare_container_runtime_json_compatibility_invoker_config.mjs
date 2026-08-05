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
const DEPLOYMENT_STATES = ["dark", "status-only", "execution"];

const IDENTITY_OPTIONS = [
  {
    apiName: "operatorCurrentKid",
    cliName: "--operator-current-kid",
    label: "operator current KID",
    validate: keyId,
    requiredIn: ["execution"],
  },
  {
    apiName: "operatorCurrentCredentialIdSha256",
    cliName: "--operator-current-credential-id-sha256",
    label: "operator credential digest",
    validate: sha256,
    requiredIn: ["execution"],
  },
  {
    apiName: "statusOperatorCurrentKid",
    cliName: "--status-operator-current-kid",
    label: "status operator current KID",
    validate: keyId,
    requiredIn: ["status-only", "execution"],
  },
  {
    apiName: "statusOperatorCurrentCredentialIdSha256",
    cliName: "--status-operator-current-credential-id-sha256",
    label: "status operator credential digest",
    validate: sha256,
    requiredIn: ["status-only", "execution"],
  },
  {
    apiName: "issuerHmacKid",
    cliName: "--issuer-hmac-kid",
    label: "issuer HMAC KID",
    validate: keyId,
    requiredIn: ["execution"],
  },
  {
    apiName: "issuerHmacCredentialIdSha256",
    cliName: "--issuer-hmac-credential-id-sha256",
    label: "issuer HMAC credential digest",
    validate: sha256,
    requiredIn: ["execution"],
  },
  {
    apiName: "permitKeyId",
    cliName: "--permit-key-id",
    label: "permit key ID",
    validate: keyId,
    requiredIn: ["execution"],
  },
  {
    apiName: "permitSpkiSha256",
    cliName: "--permit-spki-sha256",
    label: "permit SPKI digest",
    validate: sha256,
    requiredIn: ["execution"],
  },
];

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
  const deploymentState = campaign === null
    ? "dark"
    : normalizeDeploymentState(campaign.deploymentState);
  const identities = campaign === null
    ? {}
    : validateDeploymentIdentities(campaign, deploymentState);
  const executionEnabled = deploymentState === "execution";
  const statusReadEnabled = deploymentState !== "dark";
  canonicalEqual(config.vars, {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_INVOKER_ENABLED:
      executionEnabled ? "true" : "false",
    JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED:
      statusReadEnabled ? "true" : "false",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID:
      executionEnabled ? identities.operatorCurrentKid : "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      executionEnabled ? identities.operatorCurrentCredentialIdSha256 : "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER: STATUS_OPERATOR_ISSUER,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID:
      statusReadEnabled ? identities.statusOperatorCurrentKid : "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      statusReadEnabled
        ? identities.statusOperatorCurrentCredentialIdSha256
        : "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER: INVOKER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE: ISSUER_SERVICE,
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID:
      executionEnabled ? identities.issuerHmacKid : "",
    JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256:
      executionEnabled ? identities.issuerHmacCredentialIdSha256 : "",
    JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
    JSON_COMPATIBILITY_PERMIT_AUDIENCE: EXECUTOR_SERVICE,
    JSON_COMPATIBILITY_PERMIT_KEY_ID:
      executionEnabled ? identities.permitKeyId : "",
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256:
      executionEnabled ? identities.permitSpkiSha256 : "",
  }, "invoker vars");
  return {
    serviceName: config.name,
    deploymentState,
    enabled: executionEnabled,
    executionEnabled,
    statusReadEnabled,
    privateServiceBindings: true,
  };
}

export async function prepareJsonCompatibilityInvokerConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const deploymentState = normalizeDeploymentState(options?.deploymentState);
  const values = validateDeploymentIdentities({
    deploymentState,
    operatorCurrentKid: options?.operatorCurrentKid,
    operatorCurrentCredentialIdSha256:
      options?.operatorCurrentCredentialIdSha256,
    statusOperatorCurrentKid: options?.statusOperatorCurrentKid,
    statusOperatorCurrentCredentialIdSha256:
      options?.statusOperatorCurrentCredentialIdSha256,
    issuerHmacKid: options?.issuerHmacKid,
    issuerHmacCredentialIdSha256: options?.issuerHmacCredentialIdSha256,
    permitKeyId: options?.permitKeyId,
    permitSpkiSha256: options?.permitSpkiSha256,
  }, deploymentState);
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
  const executionEnabled = deploymentState === "execution";
  const statusReadEnabled = deploymentState !== "dark";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ENABLED =
    executionEnabled ? "true" : "false";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID =
    executionEnabled ? values.operatorCurrentKid : "";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256 =
    executionEnabled ? values.operatorCurrentCredentialIdSha256 : "";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED =
    statusReadEnabled ? "true" : "false";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID =
    statusReadEnabled ? values.statusOperatorCurrentKid : "";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256 =
    statusReadEnabled
      ? values.statusOperatorCurrentCredentialIdSha256
      : "";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID =
    executionEnabled ? values.issuerHmacKid : "";
  campaign.vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256 =
    executionEnabled ? values.issuerHmacCredentialIdSha256 : "";
  campaign.vars.JSON_COMPATIBILITY_PERMIT_KEY_ID =
    executionEnabled ? values.permitKeyId : "";
  campaign.vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256 =
    executionEnabled ? values.permitSpkiSha256 : "";
  const validation = validateJsonCompatibilityInvokerConfig(campaign, {
    ...values,
    deploymentState,
  });
  await writeFile(outPath, canonicalJson(campaign), { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-private-invoker-campaign-config-preparation",
    environment: "staging",
    serviceName: validation.serviceName,
    deploymentState,
    executionEnabled,
    statusReadEnabled,
    configSha256: sha256Canonical(campaign),
    changedVars: changedVarsForDeploymentState(deploymentState),
    secretsRequired: secretsRequiredForDeploymentState(deploymentState),
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityInvokerConfigArgs(argv) {
  const names = [
    "--base", "--out", "--deployment-state", "--operator-current-kid",
    "--operator-current-credential-id-sha256", "--issuer-hmac-kid",
    "--status-operator-current-kid",
    "--status-operator-current-credential-id-sha256",
    "--issuer-hmac-credential-id-sha256", "--permit-key-id",
    "--permit-spki-sha256",
  ];
  const values = parseArgs(argv, names);
  if (values.help) return values;
  requiredValue(values.map, "--out");
  const deploymentState = normalizeDeploymentState(
    values.map.get("--deployment-state"),
    "--deployment-state",
  );
  for (const identity of IDENTITY_OPTIONS) {
    if (identity.requiredIn.includes(deploymentState)) {
      requiredValue(values.map, identity.cliName);
      identity.validate(values.map.get(identity.cliName), identity.cliName);
    } else if (values.map.has(identity.cliName)) {
      throw new Error(
        `${identity.cliName} is forbidden for deployment state ${deploymentState}`,
      );
    }
  }
  return {
    json: values.json,
    basePath: values.map.get("--base"),
    outPath: values.map.get("--out"),
    deploymentState,
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
    "  bun tools/prepare_container_runtime_json_compatibility_invoker_config.mjs --out <wrangler.jsonc> --deployment-state dark [--base <tracked-staging.jsonc>] [--json]",
    "  bun tools/prepare_container_runtime_json_compatibility_invoker_config.mjs --out <wrangler.jsonc> --deployment-state status-only --status-operator-current-kid <kid> --status-operator-current-credential-id-sha256 <sha256> [--base <tracked-staging.jsonc>] [--json]",
    "  bun tools/prepare_container_runtime_json_compatibility_invoker_config.mjs --out <wrangler.jsonc> [--deployment-state execution] --operator-current-kid <kid> --operator-current-credential-id-sha256 <sha256> --status-operator-current-kid <kid> --status-operator-current-credential-id-sha256 <sha256> --issuer-hmac-kid <kid> --issuer-hmac-credential-id-sha256 <sha256> --permit-key-id <kid> --permit-spki-sha256 <sha256> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "--deployment-state accepts exactly dark, status-only, or execution; omission defaults to execution.",
    "The output is create-only and contains no secret material. Provision only the secrets required by the selected deployment state separately as Worker secrets.",
  ].join("\n");
}

function normalizeDeploymentState(value, label = "deploymentState") {
  const state = value === undefined ? "execution" : value;
  if (!DEPLOYMENT_STATES.includes(state)) {
    throw new Error(
      `${label} must be one of: ${DEPLOYMENT_STATES.join(", ")}`,
    );
  }
  return state;
}

function validateDeploymentIdentities(input, deploymentState) {
  const identities = record(input, "invoker deployment identities");
  for (const identity of IDENTITY_OPTIONS) {
    const value = identities[identity.apiName];
    if (identity.requiredIn.includes(deploymentState)) {
      identity.validate(value, identity.label);
    } else if (value !== undefined) {
      throw new Error(
        `${identity.apiName} is forbidden for deployment state ${deploymentState}`,
      );
    }
  }
  return identities;
}

function changedVarsForDeploymentState(deploymentState) {
  if (deploymentState === "dark") return [];
  const statusVars = [
    "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
    "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID",
    "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
  ];
  if (deploymentState === "status-only") return statusVars;
  return [
    "JSON_COMPATIBILITY_INVOKER_ENABLED",
    ...statusVars,
    "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID",
    "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
    "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID",
    "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256",
    "JSON_COMPATIBILITY_PERMIT_KEY_ID",
    "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
  ];
}

function secretsRequiredForDeploymentState(deploymentState) {
  if (deploymentState === "dark") return [];
  const statusSecret =
    "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET";
  if (deploymentState === "status-only") return [statusSecret];
  return [
    "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
    statusSecret,
    "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
    "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
  ];
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
