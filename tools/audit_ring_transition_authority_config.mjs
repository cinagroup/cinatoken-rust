#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AUTHORITY_SERVICE_DIR = path.join(
  repoRoot,
  "services",
  "ring-transition-authority",
);
export const AUTHORITY_CONFIG_FILES = Object.freeze({
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
});
export const AUTHORITY_STAGING_ROUTE =
  "ring-transition-authority-staging.cinatoken.com/internal/v1/ring-transition/*";
export const AUTHORITY_STAGING_ZONE = "cinatoken.com";
export const AUTHORITY_MIGRATIONS_DIR = "migrations";
export const AUTHORITY_D1_DATABASES = Object.freeze({
  local: "cinatoken-ring-control-local",
  staging: "cinatoken-ring-control-staging",
});
export const AUTHORITY_REQUIRED_DISABLED_GATES = Object.freeze([
  "RING_TRANSITION_AUTHORITY_ENABLED",
  "RING_TRANSITION_CLAIM_WRITE_ENABLED",
  "RING_TRANSITION_STEP_WRITE_ENABLED",
  "RING_TRANSITION_EXPIRY_WRITE_ENABLED",
]);
export const AUTHORITY_REQUIRED_SECRET_BINDINGS = Object.freeze([
  "RING_TRANSITION_HMAC_CURRENT_SECRET",
  "RING_TRANSITION_HMAC_PREVIOUS_SECRET",
]);
export const AUTHORITY_PERMIT_PUBLIC_KEY_BINDING =
  "RING_TRANSITION_PERMIT_SPKI_BASE64URL";
export const AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR =
  "RING_TRANSITION_PERMIT_SPKI_SHA256";
export const AUTHORITY_SERVICE_MIGRATION_SOURCES = Object.freeze({
  "0001_ring_transition_claims.sql":
    "0059_relay_container_ring_transition_claims.sql",
  "0002_ring_transition_authority.sql":
    "0060_relay_container_ring_transition_authority.sql",
});

const AUTHORITY_NAMES = Object.freeze({
  local: "cinatoken-ring-transition-authority-local",
  staging: "cinatoken-ring-transition-authority-staging",
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
  "vars",
  "d1_databases",
  "routes",
]);
const PROHIBITED_BINDING_KEYS = Object.freeze([
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "containers",
  "queues",
  "services",
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
const D1_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|REPLACE_WITH_[A-Z0-9_]+)$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|API_KEY)(?:_|$)/i;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
]);

export class AuthorityConfigAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorityConfigAuditError";
  }
}

export function parseAuthorityWranglerJsonc(
  source,
  sourceLabel = "Authority Wrangler config",
) {
  if (typeof source !== "string") {
    throw new AuthorityConfigAuditError(`${sourceLabel} must be text`);
  }

  try {
    const parsed = JSON.parse(stripJsonc(source));
    if (!isRecord(parsed)) {
      throw new AuthorityConfigAuditError(
        `${sourceLabel} must contain a JSON object`,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof AuthorityConfigAuditError) throw error;
    throw new AuthorityConfigAuditError(
      `${sourceLabel} must contain valid JSONC`,
    );
  }
}

export function auditAuthorityConfig(config, environment) {
  const expectedName = requireEnvironment(environment);
  if (!isRecord(config)) {
    throw new AuthorityConfigAuditError("Authority config must be an object");
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      const bindingLabel = PROHIBITED_BINDING_KEYS.includes(key)
        ? "prohibited binding"
        : "unexpected top-level capability";
      throw new AuthorityConfigAuditError(`${bindingLabel}: ${key}`);
    }
  }
  for (const key of PROHIBITED_BINDING_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new AuthorityConfigAuditError(`prohibited binding: ${key}`);
    }
  }

  requireEqual(config.name, expectedName, `${environment} Worker name`);
  requireEqual(config.main, "src/index.ts", `${environment} main`);
  requireEqual(config.workers_dev, false, `${environment} workers_dev`);
  requireEqual(config.preview_urls, false, `${environment} preview_urls`);
  requireExactObject(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    `${environment} version_metadata`,
  );

  if (!isRecord(config.vars)) {
    throw new AuthorityConfigAuditError(`${environment} vars must be an object`);
  }
  requireEqual(
    config.vars.ENVIRONMENT,
    environment,
    `${environment} ENVIRONMENT`,
  );
  for (const gate of AUTHORITY_REQUIRED_DISABLED_GATES) {
    requireEqual(config.vars[gate], "false", `${environment} ${gate}`);
  }
  for (const [name, value] of Object.entries(config.vars)) {
    if (
      /(?:AUTHORITY|CLAIM|STEP|EXPIRY).*_(?:ENABLED|WRITE_ENABLED)$/i.test(name) &&
      value !== "false"
    ) {
      throw new AuthorityConfigAuditError(
        `${environment} action gate ${name} must remain false`,
      );
    }
  }

  for (const remoteBinding of [
    ...AUTHORITY_REQUIRED_SECRET_BINDINGS,
    AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
  ]) {
    if (Object.hasOwn(config.vars, remoteBinding)) {
      throw new AuthorityConfigAuditError(
        `${remoteBinding} is a remote binding name and must not be stored in tracked vars`,
      );
    }
  }
  if (
    !Object.hasOwn(
      config.vars,
      AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
    )
  ) {
    throw new AuthorityConfigAuditError(
      `${environment} must declare ${AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR}`,
    );
  }
  const permitFingerprint =
    config.vars[AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR];
  if (
    permitFingerprint !== "" &&
    (typeof permitFingerprint !== "string" ||
      !SHA256_PATTERN.test(permitFingerprint))
  ) {
    throw new AuthorityConfigAuditError(
      `${environment} ${AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR} must be empty or a lowercase SHA-256 digest`,
    );
  }
  rejectSecretLiterals(config);

  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new AuthorityConfigAuditError(
      `${environment} must contain exactly one D1 binding`,
    );
  }
  const database = config.d1_databases[0];
  if (!isRecord(database)) {
    throw new AuthorityConfigAuditError(
      `${environment} D1 binding must be an object`,
    );
  }
  requireExactKeys(
    database,
    ["binding", "database_name", "database_id", "migrations_dir"],
    `${environment} D1 binding`,
  );
  requireEqual(database.binding, "DB", `${environment} D1 binding`);
  requireEqual(
    database.database_name,
    AUTHORITY_D1_DATABASES[environment],
    `${environment} DB database_name`,
  );
  if (database.database_name === "cinatoken-rust-db-staging") {
    throw new AuthorityConfigAuditError(
      "staging Authority must not bind the shared cinatoken-rust-db-staging database",
    );
  }
  if (
    typeof database.database_id !== "string" ||
    !D1_ID_PATTERN.test(database.database_id)
  ) {
    throw new AuthorityConfigAuditError(
      `${environment} DB database_id must be a UUID or explicit REPLACE_WITH_* placeholder`,
    );
  }
  requireEqual(
    database.migrations_dir,
    AUTHORITY_MIGRATIONS_DIR,
    `${environment} DB migrations_dir`,
  );

  validateRoutes(config, environment);

  return Object.freeze({
    ok: true,
    environment,
    workerName: expectedName,
    workersDev: false,
    previewUrls: false,
    bindings: Object.freeze([
      "d1_databases.DB",
      "version_metadata.CF_VERSION_METADATA",
    ]),
    database: Object.freeze({
      binding: "DB",
      databaseName: AUTHORITY_D1_DATABASES[environment],
      migrationsDir: AUTHORITY_MIGRATIONS_DIR,
      id: "redacted",
    }),
    route:
      environment === "staging"
          ? Object.freeze({
              pattern: AUTHORITY_STAGING_ROUTE,
              zoneName: AUTHORITY_STAGING_ZONE,
              customDomain: false,
            })
        : null,
    gatesDefaultOff: true,
    requiredSecretBindings: AUTHORITY_REQUIRED_SECRET_BINDINGS,
    permitPublicKeyBinding: AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
    permitPublicKeyFingerprintVar:
      AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
    remoteBindingValuesRead: false,
  });
}

export async function auditTrackedAuthorityConfigs({
  serviceDir = AUTHORITY_SERVICE_DIR,
  globalMigrationsDir = path.join(repoRoot, "migrations", "d1"),
} = {}) {
  const entries = await readdir(serviceDir, { withFileTypes: true });
  const productionConfigs = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().startsWith("wrangler") &&
        /(?:prod|production)/i.test(entry.name),
    )
    .map((entry) => entry.name);
  if (productionConfigs.length > 0) {
    throw new AuthorityConfigAuditError(
      `production Authority config is forbidden: ${productionConfigs.join(", ")}`,
    );
  }

  const reports = {};
  for (const [environment, filename] of Object.entries(AUTHORITY_CONFIG_FILES)) {
    const configPath = path.join(serviceDir, filename);
    const source = await readFile(configPath, "utf8");
    reports[environment] = auditAuthorityConfig(
      parseAuthorityWranglerJsonc(source, filename),
      environment,
    );
  }

  const migrations = await auditAuthorityServiceMigrations({
    serviceMigrationsDir: path.join(serviceDir, AUTHORITY_MIGRATIONS_DIR),
    globalMigrationsDir,
  });

  return Object.freeze({
    ok: true,
    productionConfigAbsent: true,
    environments: Object.freeze(reports),
    migrations,
  });
}

export async function auditAuthorityServiceMigrations({
  serviceMigrationsDir,
  globalMigrationsDir = path.join(repoRoot, "migrations", "d1"),
}) {
  if (
    typeof serviceMigrationsDir !== "string" ||
    serviceMigrationsDir.trim() === ""
  ) {
    throw new AuthorityConfigAuditError(
      "service migrations directory is required",
    );
  }

  let entries;
  try {
    entries = await readdir(serviceMigrationsDir, { withFileTypes: true });
  } catch {
    throw new AuthorityConfigAuditError(
      `Authority service migrations are missing at ${serviceMigrationsDir}`,
    );
  }
  const actualNames = entries.map((entry) => entry.name).sort();
  const expectedNames = Object.keys(AUTHORITY_SERVICE_MIGRATION_SOURCES).sort();
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new AuthorityConfigAuditError(
      `Authority service migrations must contain exactly ${expectedNames.join(", ")}`,
    );
  }

  const byteLengths = {};
  for (const serviceName of expectedNames) {
    const globalName = AUTHORITY_SERVICE_MIGRATION_SOURCES[serviceName];
    let serviceBytes;
    let globalBytes;
    try {
      [serviceBytes, globalBytes] = await Promise.all([
        readFile(path.join(serviceMigrationsDir, serviceName)),
        readFile(path.join(globalMigrationsDir, globalName)),
      ]);
    } catch {
      throw new AuthorityConfigAuditError(
        `migration source pair is missing for ${serviceName} -> ${globalName}`,
      );
    }
    if (!serviceBytes.equals(globalBytes)) {
      throw new AuthorityConfigAuditError(
        `Authority migration byte drift: ${serviceName} must exactly match migrations/d1/${globalName}`,
      );
    }
    byteLengths[serviceName] = serviceBytes.byteLength;
  }

  return Object.freeze({
    exact: true,
    files: Object.freeze(
      expectedNames.map((serviceName) =>
        Object.freeze({
          serviceName,
          sourceName: AUTHORITY_SERVICE_MIGRATION_SOURCES[serviceName],
          byteLength: byteLengths[serviceName],
        }),
      ),
    ),
  });
}

function validateRoutes(config, environment) {
  if (environment === "local") {
    if (Object.hasOwn(config, "routes")) {
      throw new AuthorityConfigAuditError("local config must not declare routes");
    }
    return;
  }

  if (!Array.isArray(config.routes) || config.routes.length !== 1) {
    throw new AuthorityConfigAuditError(
      "staging config must declare exactly one fixed route",
    );
  }
  const route = config.routes[0];
  if (!isRecord(route)) {
    throw new AuthorityConfigAuditError("staging route must be an object");
  }
  requireExactKeys(
    route,
    ["pattern", "zone_name", "custom_domain"],
    "staging route",
  );
  requireEqual(route.pattern, AUTHORITY_STAGING_ROUTE, "staging route pattern");
  requireEqual(route.zone_name, AUTHORITY_STAGING_ZONE, "staging route zone_name");
  requireEqual(route.custom_domain, false, "staging route custom_domain");
}

function rejectSecretLiterals(config) {
  visit(config, "$", undefined);

  function visit(value, jsonPath, key) {
    if (typeof value === "string") {
      if (value !== "" && SECRET_KEY_PATTERN.test(key ?? "")) {
        throw new AuthorityConfigAuditError(
          `secret or token literal is forbidden at ${jsonPath}`,
        );
      }
      if (
        value !== "" &&
        (key === AUTHORITY_PERMIT_PUBLIC_KEY_BINDING ||
          SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)))
      ) {
        throw new AuthorityConfigAuditError(
          `key, secret, or token material is forbidden at ${jsonPath}`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, `${jsonPath}[${index}]`, undefined),
      );
      return;
    }
    if (!isRecord(value)) return;
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, `${jsonPath}.${childKey}`, childKey);
    }
  }
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
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          index += 1;
          closed = true;
          break;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (!closed) {
        throw new AuthorityConfigAuditError("unterminated JSONC block comment");
      }
      continue;
    }
    output += character;
  }

  return stripTrailingCommas(output);
}

function stripTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}

function requireEnvironment(environment) {
  if (!Object.hasOwn(AUTHORITY_NAMES, environment)) {
    throw new AuthorityConfigAuditError(
      "environment must be exactly local or staging",
    );
  }
  return AUTHORITY_NAMES[environment];
}

function requireExactObject(actual, expected, label) {
  if (!isRecord(actual)) {
    throw new AuthorityConfigAuditError(`${label} must be an object`);
  }
  requireExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    requireEqual(actual[key], value, `${label}.${key}`);
  }
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AuthorityConfigAuditError(
      `${label} must contain only ${expectedKeys.join(", ")}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AuthorityConfigAuditError(`${label} must be ${String(expected)}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

async function cliMain(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  try {
    const report = await auditTrackedAuthorityConfigs();
    console.log(
      json
        ? JSON.stringify(report, null, 2)
        : "Ring transition Authority config audit passed; production config is absent.",
    );
  } catch (error) {
    const message =
      error instanceof AuthorityConfigAuditError
        ? error.message
        : "unexpected Authority config audit failure";
    if (json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Ring transition Authority config audit failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await cliMain();
}
