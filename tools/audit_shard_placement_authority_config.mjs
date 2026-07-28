#!/usr/bin/env bun

import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const SERVICE_DIR = path.join(
  repoRoot,
  "services",
  "shard-placement-authority",
);
export const CONFIG_FILES = Object.freeze({
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
});
export const DATABASES = Object.freeze({
  local: "cinatoken-shard-placement-control-local",
  staging: "cinatoken-shard-placement-control-staging",
});
export const REQUIRED_DISABLED_GATES = Object.freeze([
  "SHARD_PLACEMENT_AUTHORITY_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_READ_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED",
  "SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED",
]);
export const REQUIRED_REMOTE_BINDINGS = Object.freeze([
  "SHARD_PLACEMENT_PERMIT_SPKI_BASE64URL",
  "SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL",
  "SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL",
  "SHARD_PLACEMENT_RELEASE_SPKI_BASE64URL",
  "SHARD_PLACEMENT_ROLLBACK_SPKI_BASE64URL",
  "SHARD_PLACEMENT_READ_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_READ_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_ACTIVATE_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_ACTIVATE_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_ENABLE_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_ENABLE_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_SECRET",
  "SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_SECRET",
  "SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET",
]);

const WORKER_NAMES = Object.freeze({
  local: "cinatoken-shard-placement-authority-local",
  staging: "cinatoken-shard-placement-authority-staging",
});
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "workers_dev",
  "preview_urls",
  "observability",
  "version_metadata",
  "services",
  "vars",
  "d1_databases",
]);
const PROHIBITED_BINDING_KEYS = Object.freeze([
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
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "send_email",
  "unsafe",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
]);
const EMPTY_TRUST_PATTERNS = Object.freeze([
  /^SHARD_PLACEMENT_AUTHORITY_POLICY_(?:ID|SHA256)$/,
  /^SHARD_PLACEMENT_(?:APPLICATION|AUTHORITY)_DATABASE_IDENTITY_SHA256$/,
  /^SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256$/,
  /^SHARD_PLACEMENT_(?:PERMIT|SECURITY|OPERATIONS|RELEASE|ROLLBACK)_(?:KEY_ID|SPKI_SHA256)$/,
  /^SHARD_PLACEMENT_(?:READ|ISSUE|REVOKE|CLAIM|ACTIVATE|ENABLE|RECEIPT|RECOVERY)_HMAC_(?:CURRENT|PREVIOUS)_(?:KID|CREDENTIAL_ID_SHA256)$/,
  /^SHARD_PLACEMENT_APPLICATION_(?:ACTIVATION|ACK)_READ_HMAC_CURRENT_(?:KID|CREDENTIAL_ID_SHA256)$/,
]);
const DATABASE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|REPLACE_WITH_[A-Z0-9_]+)$/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bcfut_[A-Za-z0-9_-]{12,}/,
]);

export class ShardPlacementAuthorityConfigAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShardPlacementAuthorityConfigAuditError";
  }
}

export function parseWranglerJsonc(
  source,
  label = "shard placement Authority config",
) {
  if (typeof source !== "string") {
    throw new ShardPlacementAuthorityConfigAuditError(
      `${label} must be text`,
    );
  }
  try {
    const value = JSON.parse(stripJsonc(source));
    if (!isRecord(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new ShardPlacementAuthorityConfigAuditError(
      `${label} must contain valid JSONC`,
    );
  }
}

export function auditConfig(config, environment) {
  if (environment !== "local" && environment !== "staging") {
    throw new ShardPlacementAuthorityConfigAuditError(
      "environment must be local or staging",
    );
  }
  if (!isRecord(config)) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "config must be an object",
    );
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new ShardPlacementAuthorityConfigAuditError(
        `unexpected top-level capability: ${key}`,
      );
    }
  }
  for (const key of PROHIBITED_BINDING_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new ShardPlacementAuthorityConfigAuditError(
        `prohibited binding: ${key}`,
      );
    }
  }
  requireEqual(config.name, WORKER_NAMES[environment], "Worker name");
  requireEqual(config.main, "src/index.ts", "main");
  requireEqual(config.workers_dev, false, "workers_dev");
  requireEqual(config.preview_urls, false, "preview_urls");
  requireExactObject(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    "version_metadata",
  );
  if (!Array.isArray(config.services) || config.services.length !== 1) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "exactly one application Service Binding is required",
    );
  }
  requireExactObject(
    config.services[0],
    {
      binding: "SHARD_PLACEMENT_APPLICATION",
      service: `cinatoken-rust-api-${environment}`,
    },
    "application Service Binding",
  );
  if (
    !isRecord(config.observability)
    || config.observability.enabled !== true
    || config.observability.head_sampling_rate !== 1
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "observability must be explicitly enabled",
    );
  }
  if (!isRecord(config.vars)) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "vars must be an object",
    );
  }
  requireEqual(config.vars.ENVIRONMENT, environment, "ENVIRONMENT");
  for (const gate of REQUIRED_DISABLED_GATES) {
    requireEqual(config.vars[gate], "false", gate);
  }
  for (const name of REQUIRED_REMOTE_BINDINGS) {
    if (Object.hasOwn(config.vars, name)) {
      throw new ShardPlacementAuthorityConfigAuditError(
        `${name} must not be stored in tracked vars`,
      );
    }
  }
  for (const [name, value] of Object.entries(config.vars)) {
    if (
      EMPTY_TRUST_PATTERNS.some((pattern) => pattern.test(name))
      && value !== ""
    ) {
      throw new ShardPlacementAuthorityConfigAuditError(
        `${name} must remain an empty deployment placeholder`,
      );
    }
  }
  rejectSecretLiterals(config);

  if (
    !Array.isArray(config.d1_databases)
    || config.d1_databases.length !== 1
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "exactly one D1 binding is required",
    );
  }
  const database = config.d1_databases[0];
  if (!isRecord(database)) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "D1 binding must be an object",
    );
  }
  requireExactKeys(
    database,
    ["binding", "database_name", "database_id", "migrations_dir"],
    "D1 binding",
  );
  requireEqual(database.binding, "DB", "D1 binding name");
  requireEqual(
    database.database_name,
    DATABASES[environment],
    "D1 database name",
  );
  if (
    database.database_name.includes("cinatoken-rust-db")
    || database.database_name.includes("ring-control")
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "Authority must use its isolated placement control D1",
    );
  }
  if (
    typeof database.database_id !== "string"
    || !DATABASE_ID.test(database.database_id)
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "D1 database ID must be a UUID or explicit placeholder",
    );
  }
  requireEqual(database.migrations_dir, "migrations", "migrations_dir");
  if (Object.hasOwn(config, "routes")) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "Authority must not expose a public route",
    );
  }

  return Object.freeze({
    ok: true,
    environment,
    workerName: WORKER_NAMES[environment],
    bindings: Object.freeze([
      "d1_databases.DB",
      "version_metadata.CF_VERSION_METADATA",
      "services.SHARD_PLACEMENT_APPLICATION",
    ]),
    databaseName: DATABASES[environment],
    ingress: "service_binding_only",
    route: null,
    gatesDefaultOff: true,
    remoteBindingsTracked: false,
    productionConfigPresent: false,
  });
}

export async function auditTrackedConfigs({
  serviceDir = SERVICE_DIR,
} = {}) {
  const entries = await readdir(serviceDir, { withFileTypes: true });
  const production = entries.filter(
    (entry) =>
      entry.isFile()
      && entry.name.toLowerCase().startsWith("wrangler")
      && /(?:prod|production)/i.test(entry.name),
  );
  if (production.length > 0) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "production Authority config is prohibited",
    );
  }
  const reports = {};
  for (const [environment, file] of Object.entries(CONFIG_FILES)) {
    reports[environment] = auditConfig(
      parseWranglerJsonc(
        await readFile(path.join(serviceDir, file), "utf8"),
        file,
      ),
      environment,
    );
  }
  const migrations = entries
    .find((entry) => entry.isDirectory() && entry.name === "migrations");
  if (migrations === undefined) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "migrations directory is required",
    );
  }
  const migrationFiles = (
    await readdir(path.join(serviceDir, "migrations"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (
    migrationFiles.length !== 2
    || migrationFiles[0]
      !== "0001_shard_placement_authorizations.sql"
    || migrationFiles[1]
      !== "0002_shard_placement_execution_claims.sql"
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      "Authority migration inventory is invalid",
    );
  }
  return Object.freeze({
    ok: true,
    service: "shard-placement-authority",
    environments: reports,
    migrationFiles,
    productionConfigPresent: false,
    remoteMutationPerformed: false,
    credentialRead: false,
  });
}

function rejectSecretLiterals(value) {
  const serialized = JSON.stringify(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new ShardPlacementAuthorityConfigAuditError(
        "tracked config contains a secret-like value",
      );
    }
  }
}

function stripJsonc(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new ShardPlacementAuthorityConfigAuditError(
      `${label} must equal ${JSON.stringify(expected)}`,
    );
  }
}

function requireExactObject(actual, expected, label) {
  if (!isRecord(actual)) {
    throw new ShardPlacementAuthorityConfigAuditError(
      `${label} must be an object`,
    );
  }
  requireExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    requireEqual(actual[key], value, `${label}.${key}`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ShardPlacementAuthorityConfigAuditError(
      `${label} has unexpected keys`,
    );
  }
}

function isRecord(value) {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  );
}

async function main() {
  const json = process.argv.includes("--json");
  const unknown = process.argv.slice(2).filter((value) => value !== "--json");
  if (unknown.length > 0) {
    throw new ShardPlacementAuthorityConfigAuditError(
      `unknown arguments: ${unknown.join(", ")}`,
    );
  }
  const report = await auditTrackedConfigs();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("shard placement Authority config audit passed\n");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
