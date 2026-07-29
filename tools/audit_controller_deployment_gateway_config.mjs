#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATEWAY_SERVICE_DIR = path.join(
  repoRoot,
  "services",
  "controller-deployment-gateway",
);
export const GATEWAY_CONFIG_FILES = Object.freeze({
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
});
export const GATEWAY_D1_DATABASES = Object.freeze({
  local: "cinatoken-controller-deployment-gateway-local",
  staging: "cinatoken-controller-deployment-gateway-staging",
});
export const GATEWAY_REQUIRED_DISABLED_GATES = Object.freeze([
  "CONTROLLER_DEPLOYMENT_GATEWAY_ENABLED",
  "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_ENABLED",
  "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_READ_ENABLED",
  "CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_MUTATION_ENABLED",
  "CONTROLLER_DEPLOYMENT_GATEWAY_REMOTE_READ_ENABLED",
]);
export const GATEWAY_REQUIRED_SECRET_BINDINGS = Object.freeze([
  "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET",
  "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET",
  "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET",
  "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET",
  "CLOUDFLARE_DEPLOY_API_TOKEN",
  "CLOUDFLARE_READ_API_TOKEN",
]);

const EXPECTED_NAMES = Object.freeze({
  local: "cinatoken-controller-deployment-gateway-local",
  staging: "cinatoken-controller-deployment-gateway-staging",
});
const EXPECTED_SERVICE_NAMES = Object.freeze({
  local: "cinatoken-container-controller-local",
  staging: "cinatoken-container-controller-staging",
});
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "observability",
  "version_metadata",
  "vars",
  "d1_databases",
]);
const PROHIBITED_BINDINGS = [
  "routes",
  "services",
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "containers",
  "queues",
  "assets",
  "ai",
  "vectorize",
  "browser",
  "hyperdrive",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "send_email",
  "unsafe",
];
const SHA256 = /^[0-9a-f]{64}$/;
const D1_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|REPLACE_WITH_[A-Z0-9_]+)$/i;
const SECRET_KEY =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|API_KEY)(?:_|$)/i;

export class GatewayConfigAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayConfigAuditError";
  }
}

export function parseGatewayWranglerJsonc(source, label = "Gateway config") {
  if (typeof source !== "string") {
    throw new GatewayConfigAuditError(`${label} must be text`);
  }
  try {
    const value = JSON.parse(stripJsonc(source));
    if (!isRecord(value)) {
      throw new GatewayConfigAuditError(`${label} must contain an object`);
    }
    return value;
  } catch (error) {
    if (error instanceof GatewayConfigAuditError) throw error;
    throw new GatewayConfigAuditError(`${label} must contain valid JSONC`);
  }
}

export function auditGatewayConfig(config, environment) {
  if (!Object.hasOwn(EXPECTED_NAMES, environment) || !isRecord(config)) {
    throw new GatewayConfigAuditError("unsupported Gateway environment");
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new GatewayConfigAuditError(`prohibited capability: ${key}`);
    }
  }
  for (const key of PROHIBITED_BINDINGS) {
    if (Object.hasOwn(config, key)) {
      throw new GatewayConfigAuditError(`prohibited capability: ${key}`);
    }
  }
  requireEqual(config.name, EXPECTED_NAMES[environment], "Worker name");
  requireEqual(config.main, "src/index.ts", "main");
  requireEqual(config.compatibility_date, "2026-07-29", "compatibility_date");
  if (
    !Array.isArray(config.compatibility_flags)
    || config.compatibility_flags.length !== 1
    || config.compatibility_flags[0] !== "nodejs_compat"
  ) {
    throw new GatewayConfigAuditError(
      "compatibility_flags must contain only nodejs_compat",
    );
  }
  requireEqual(config.workers_dev, false, "workers_dev");
  requireEqual(config.preview_urls, false, "preview_urls");
  requireExactObject(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "version_metadata",
  );
  if (!isRecord(config.vars)) {
    throw new GatewayConfigAuditError("vars must be an object");
  }
  requireEqual(config.vars.ENVIRONMENT, environment, "ENVIRONMENT");
  for (const gate of GATEWAY_REQUIRED_DISABLED_GATES) {
    requireEqual(config.vars[gate], "false", gate);
  }
  requireEqual(
    config.vars.CONTROLLER_DEPLOYMENT_GATEWAY_PROFILE_VERSION,
    "1",
    "Gateway profile version",
  );
  requireEqual(
    config.vars.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_STABILITY_MIN_SECONDS,
    "5",
    "status stability minimum",
  );
  requireEqual(
    config.vars.CONTROLLER_DEPLOYMENT_GATEWAY_CONTROLLER_SERVICE_NAME,
    EXPECTED_SERVICE_NAMES[environment],
    "Controller service name",
  );
  for (const binding of GATEWAY_REQUIRED_SECRET_BINDINGS) {
    if (Object.hasOwn(config.vars, binding)) {
      throw new GatewayConfigAuditError(
        `${binding} must be an untracked Worker secret`,
      );
    }
  }
  for (const [name, value] of Object.entries(config.vars)) {
    if (SECRET_KEY.test(name)) {
      throw new GatewayConfigAuditError(
        `tracked secret-like var is forbidden: ${name}`,
      );
    }
    if (typeof value !== "string") {
      throw new GatewayConfigAuditError(`var ${name} must be a string`);
    }
  }
  const accountId = config.vars.CLOUDFLARE_ACCOUNT_ID;
  const accountDigest = config.vars.CLOUDFLARE_ACCOUNT_ID_SHA256;
  if (
    typeof accountId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    || typeof accountDigest !== "string"
    || !SHA256.test(accountDigest)
    || sha256(accountId) !== accountDigest
  ) {
    throw new GatewayConfigAuditError(
      "Cloudflare account identity and digest must match",
    );
  }
  rejectCredentialCollisions(config.vars);

  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new GatewayConfigAuditError("exactly one D1 binding is required");
  }
  const database = config.d1_databases[0];
  if (!isRecord(database)) {
    throw new GatewayConfigAuditError("D1 binding must be an object");
  }
  requireExactKeys(
    database,
    ["binding", "database_name", "database_id", "migrations_dir"],
    "D1 binding",
  );
  requireEqual(database.binding, "DB", "D1 binding");
  requireEqual(
    database.database_name,
    GATEWAY_D1_DATABASES[environment],
    "D1 database_name",
  );
  requireEqual(database.migrations_dir, "migrations", "D1 migrations_dir");
  if (typeof database.database_id !== "string" || !D1_ID.test(database.database_id)) {
    throw new GatewayConfigAuditError(
      "D1 database_id must be a UUID or explicit placeholder",
    );
  }

  return Object.freeze({
    ok: true,
    environment,
    workerName: EXPECTED_NAMES[environment],
    publicIngressAbsent: true,
    gatesDefaultOff: true,
    productionConfigAbsent: true,
    remoteBindingValuesRead: false,
    requiredSecretBindings: GATEWAY_REQUIRED_SECRET_BINDINGS,
    database: Object.freeze({
      binding: "DB",
      databaseName: GATEWAY_D1_DATABASES[environment],
      id: "redacted",
    }),
  });
}

export async function auditTrackedGatewayConfigs({
  serviceDir = GATEWAY_SERVICE_DIR,
} = {}) {
  const entries = await readdir(serviceDir, { withFileTypes: true });
  const forbidden = entries
    .filter(
      (entry) =>
        entry.isFile()
        && /^wrangler.*(?:prod|production).*\.jsonc$/i.test(entry.name),
    )
    .map((entry) => entry.name);
  if (forbidden.length > 0) {
    throw new GatewayConfigAuditError(
      `production Gateway config is forbidden: ${forbidden.join(", ")}`,
    );
  }
  const reports = {};
  for (const [environment, filename] of Object.entries(GATEWAY_CONFIG_FILES)) {
    reports[environment] = auditGatewayConfig(
      parseGatewayWranglerJsonc(
        await readFile(path.join(serviceDir, filename), "utf8"),
        filename,
      ),
      environment,
    );
  }
  const migrationNames =
    (await readdir(path.join(serviceDir, "migrations"))).sort();
  if (
    migrationNames.length !== 1
    || migrationNames[0] !== "0001_controller_deployment_gateway.sql"
  ) {
    throw new GatewayConfigAuditError(
      "Gateway migration inventory must contain only 0001_controller_deployment_gateway.sql",
    );
  }
  return Object.freeze({
    ok: true,
    productionConfigAbsent: true,
    environments: Object.freeze(reports),
    migrations: Object.freeze(migrationNames),
  });
}

function rejectCredentialCollisions(vars) {
  const createKids = configuredValues(vars, [
    "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID",
    "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID",
  ]);
  const statusKids = configuredValues(vars, [
    "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID",
    "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID",
  ]);
  const createCredentials = configuredValues(vars, [
    "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
    "CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
  ]);
  const statusCredentials = configuredValues(vars, [
    "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
    "CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
  ]);
  if (
    intersects(createKids, statusKids)
    || intersects(createCredentials, statusCredentials)
  ) {
    throw new GatewayConfigAuditError(
      "create and status HMAC identities must be isolated",
    );
  }
  for (const value of [...createCredentials, ...statusCredentials]) {
    if (!SHA256.test(value)) {
      throw new GatewayConfigAuditError(
        "configured HMAC credential identity must be lowercase SHA-256",
      );
    }
  }
}

function configuredValues(vars, names) {
  return names.map((name) => vars[name]).filter((value) => value !== "");
}

function intersects(left, right) {
  return left.some((value) => right.includes(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new GatewayConfigAuditError(`${label} must be ${String(expected)}`);
  }
}

function requireExactObject(actual, expected, label) {
  if (!isRecord(actual)) {
    throw new GatewayConfigAuditError(`${label} must be an object`);
  }
  requireExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    requireEqual(actual[key], value, `${label}.${key}`);
  }
}

function requireExactKeys(actual, expected, label) {
  const keys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new GatewayConfigAuditError(`${label} has unexpected fields`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonc(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < source.length - 1
        && !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

async function main() {
  const report = await auditTrackedGatewayConfigs();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
