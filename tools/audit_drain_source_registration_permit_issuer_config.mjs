#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

export const ISSUER_SERVICE_DIR = path.join(
  repoRoot,
  "services",
  "drain-source-registration-permit-issuer",
);
export const ROOT_WRANGLER_PATH = path.join(repoRoot, "wrangler.toml");
export const ISSUER_CONFIG_FILES = Object.freeze({
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
});
export const ISSUER_SECRET_BINDINGS = Object.freeze([
  "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET",
  "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL",
]);
export const ISSUER_VAR_ALLOWLIST = Object.freeze([
  "ENVIRONMENT",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED",
  "DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER",
  "DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE",
  "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID",
  "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
  "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID",
  "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256",
  "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256",
]);

const ISSUER_ENVIRONMENTS = Object.freeze({
  local: Object.freeze({
    workerName: "cinatoken-drain-source-registration-permit-issuer-local",
    authorityIssuer: "cinatoken-relay-application-local",
    authorityAudience:
      "cinatoken-drain-source-registration-permit-issuer-local",
    permitIssuer: "cinatoken-drain-source-registration-permit-issuer-local",
    permitAudience:
      "cinatoken-relay-application:local:drain-source-registration:v1",
  }),
  staging: Object.freeze({
    workerName: "cinatoken-drain-source-registration-permit-issuer-staging",
    authorityIssuer: "cinatoken-relay-application-staging",
    authorityAudience:
      "cinatoken-drain-source-registration-permit-issuer-staging",
    permitIssuer: "cinatoken-drain-source-registration-permit-issuer-staging",
    permitAudience:
      "cinatoken-relay-application:staging:drain-source-registration:v1",
  }),
});

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "workers_dev",
  "preview_urls",
  "observability",
  "version_metadata",
  "vars",
]);
const ALLOWED_TOP_LEVEL_KEYS = new Set(REQUIRED_TOP_LEVEL_KEYS);
const PROHIBITED_BINDING_KEYS = Object.freeze([
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "queues",
  "services",
  "assets",
  "containers",
  "ai",
  "vectorize",
  "browser",
  "dispatch_namespaces",
  "unsafe",
  "ratelimits",
  "hyperdrive",
  "analytics_engine_datasets",
  "mtls_certificates",
  "pipelines",
  "send_email",
  "email",
  "workflows",
  "images",
  "logfwdr",
  "tail_consumers",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
]);
const PROHIBITED_PUBLIC_KEYS = new Set(["route", "routes"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONFIG_FILENAME_PATTERN =
  /^wrangler(?:\.[A-Za-z0-9_-]+)*\.(?:jsonc?|toml)$/i;
const PRODUCTION_CONFIG_PATTERN =
  /(?:^|[._-])prod(?:uction)?(?:[._-]|$)/i;
const TRACKED_SECRET_NAME_PATTERN =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|PKCS8|API_KEY)(?:_|$)/i;
const SECRET_LITERAL_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
]);
const SECRET_FILE_PATTERN =
  /(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|id_(?:rsa|ed25519)|secrets?\.(?:json|jsonc|toml|ya?ml)|credentials?\.(?:json|jsonc|toml|ya?ml)|[^/]+\.(?:pem|key|p8|p12|pfx|pkcs8|jwk))$/i;
const IGNORED_SCAN_DIRECTORIES = new Set([
  ".git",
  ".wrangler",
  "node_modules",
  "target",
]);

export class DrainSourceRegistrationPermitIssuerConfigAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "DrainSourceRegistrationPermitIssuerConfigAuditError";
  }
}

export function parseIssuerWranglerJsonc(
  source,
  sourceLabel = "drain-source registration permit issuer Wrangler config",
) {
  if (typeof source !== "string") {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${sourceLabel} must be text`,
    );
  }

  try {
    const parsed = parseJsonValue(stripJsoncComments(source), sourceLabel);
    if (!isRecord(parsed)) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `${sourceLabel} must contain a JSON object`,
      );
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof DrainSourceRegistrationPermitIssuerConfigAuditError
    ) {
      throw error;
    }
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${sourceLabel} must contain valid JSONC`,
    );
  }
}

export function auditIssuerConfig(config, environment) {
  const expected = requireEnvironment(environment);
  if (!isRecord(config)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "issuer config must be an object",
    );
  }

  for (const key of Object.keys(config)) {
    if (PROHIBITED_PUBLIC_KEYS.has(key)) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `public routes are forbidden: ${key}`,
      );
    }
    if (PROHIBITED_BINDING_KEYS.includes(key)) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `prohibited runtime binding: ${key}`,
      );
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `unexpected top-level capability: ${key}`,
      );
    }
  }
  requireExactKeys(config, REQUIRED_TOP_LEVEL_KEYS, `${environment} config`);

  requireEqual(
    config.$schema,
    "../../node_modules/wrangler/config-schema.json",
    `${environment} schema`,
  );
  requireEqual(config.name, expected.workerName, `${environment} Worker name`);
  requireEqual(config.main, "src/index.ts", `${environment} main`);
  if (
    typeof config.compatibility_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} compatibility_date must be YYYY-MM-DD`,
    );
  }
  requireEqual(config.workers_dev, false, `${environment} workers_dev`);
  requireEqual(config.preview_urls, false, `${environment} preview_urls`);
  requireExactObject(
    config.version_metadata,
    { binding: "CF_VERSION_METADATA" },
    `${environment} version_metadata`,
  );
  auditObservability(config.observability, environment);

  if (!isRecord(config.vars)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} vars must be an object`,
    );
  }
  for (const secretBinding of ISSUER_SECRET_BINDINGS) {
    if (Object.hasOwn(config.vars, secretBinding)) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `${secretBinding} is a secret binding name and must not be stored in tracked vars`,
      );
    }
  }
  rejectSecretLiterals(config);
  requireExactKeys(config.vars, ISSUER_VAR_ALLOWLIST, `${environment} vars`);

  const vars = config.vars;
  requireEqual(vars.ENVIRONMENT, environment, `${environment} ENVIRONMENT`);
  requireEqual(
    vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED,
    "false",
    `${environment} issuance gate`,
  );

  if (
    vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER ===
      vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER ||
    vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE ===
      vars.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} authority and permit issuer/audience identities must not be reused`,
    );
  }

  requireEqual(
    vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER,
    expected.authorityIssuer,
    `${environment} authority issuer`,
  );
  requireEqual(
    vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE,
    expected.authorityAudience,
    `${environment} authority audience`,
  );
  requireEqual(
    vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER,
    expected.permitIssuer,
    `${environment} permit issuer`,
  );
  requireEqual(
    vars.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE,
    expected.permitAudience,
    `${environment} permit audience`,
  );

  for (const name of [
    "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID",
    "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID",
    "DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID",
  ]) {
    requireEmptyOrPattern(
      vars[name],
      KEY_ID_PATTERN,
      `${environment} ${name}`,
      "a lowercase key ID",
    );
  }
  for (const name of [
    "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
    "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
    "DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256",
    "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256",
  ]) {
    requireEmptyOrPattern(
      vars[name],
      SHA256_PATTERN,
      `${environment} ${name}`,
      "a lowercase SHA-256 digest",
    );
  }
  requireCredentialMetadataPair(
    vars,
    "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID",
    "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
    environment,
  );
  requireCredentialMetadataPair(
    vars,
    "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID",
    "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
    environment,
  );
  if (
    vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID !== "" &&
    vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID ===
      vars.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} current and previous HMAC key IDs must differ`,
    );
  }
  if (
    vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256 !== "" &&
    vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256 ===
      vars.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} current and previous HMAC credential digests must differ`,
    );
  }
  if (
    vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256 !== "" &&
    vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256 ===
      vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} permit signer identity and SPKI digests must differ`,
    );
  }

  return Object.freeze({
    ok: true,
    environment,
    workerName: expected.workerName,
    compatibilityDate: config.compatibility_date,
    workersDev: false,
    previewUrls: false,
    publicRoutesAbsent: true,
    runtimeBindings: Object.freeze(["version_metadata.CF_VERSION_METADATA"]),
    gatesDefaultOff: true,
    varsExact: true,
    requiredSecretBindings: ISSUER_SECRET_BINDINGS,
    trackedSecretMaterialAbsent: true,
    authorityPermitIdentitiesSeparated: true,
  });
}

export function auditRootProductionOmission(source) {
  if (typeof source !== "string") {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "root wrangler.toml must be text",
    );
  }
  const productionSlice = extractProductionEnvironmentSlice(
    stripTomlComments(source),
  );
  const capability = productionSlice.match(
    /\bDRAIN_SOURCE_REGISTRATION_[A-Z0-9_]*\b/i,
  );
  if (capability) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `root [env.production] must omit drain-source registration capability ${capability[0]}`,
    );
  }
  if (/drain[-_]source[-_]registration/i.test(productionSlice)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "root [env.production] must omit the drain-source registration issuer service",
    );
  }

  return Object.freeze({
    ok: true,
    environment: "production",
    capabilityPrefix: "DRAIN_SOURCE_REGISTRATION_",
    issuanceGateAbsent: true,
    issuerServiceBindingAbsent: true,
    rateLimiterAbsent: true,
    hmacBindingsAbsent: true,
    permitTrustAndPrivateKeyBindingsAbsent: true,
  });
}

export async function auditTrackedIssuerConfigs({
  serviceDir = ISSUER_SERVICE_DIR,
  rootWranglerPath = ROOT_WRANGLER_PATH,
} = {}) {
  const candidatePaths = await findIssuerCandidateFiles(serviceDir);
  await auditIssuerCandidateFiles(serviceDir, candidatePaths);
  const configPaths = candidatePaths.filter((relativePath) => {
    const filename = path.basename(relativePath);
    const extension = path.extname(filename).toLowerCase();
    return (
      CONFIG_FILENAME_PATTERN.test(filename) ||
      ([".json", ".jsonc", ".toml"].includes(extension) &&
        PRODUCTION_CONFIG_PATTERN.test(filename))
    );
  });
  const productionConfigs = configPaths.filter((relativePath) =>
    PRODUCTION_CONFIG_PATTERN.test(relativePath),
  );
  if (productionConfigs.length > 0) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `production issuer config is forbidden: ${productionConfigs.join(", ")}`,
    );
  }

  const expectedConfigPaths = Object.values(ISSUER_CONFIG_FILES).sort();
  const wranglerConfigPaths = configPaths
    .filter((relativePath) =>
      CONFIG_FILENAME_PATTERN.test(path.basename(relativePath)),
    )
    .sort();
  if (
    JSON.stringify(wranglerConfigPaths) !==
    JSON.stringify(expectedConfigPaths)
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `issuer service must contain exactly ${expectedConfigPaths.join(", ")}`,
    );
  }

  const environments = {};
  for (const [environment, filename] of Object.entries(ISSUER_CONFIG_FILES)) {
    const source = await readRequiredText(path.join(serviceDir, filename));
    environments[environment] = auditIssuerConfig(
      parseIssuerWranglerJsonc(source, filename),
      environment,
    );
  }
  if (
    environments.local.workerName === environments.staging.workerName
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "local and staging issuer Worker names must differ",
    );
  }
  if (
    environments.local.compatibilityDate !==
    environments.staging.compatibilityDate
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "local and staging issuer compatibility dates must match",
    );
  }

  const rootSource = await readRequiredText(rootWranglerPath);
  const applicationProduction = auditRootProductionOmission(rootSource);

  return Object.freeze({
    ok: true,
    productionIssuerConfigAbsent: true,
    onlyLocalAndStagingConfigs: true,
    candidateFileCount: candidatePaths.length,
    secretFilesAndCommonLiteralsAbsent: true,
    environments: Object.freeze(environments),
    applicationProduction,
  });
}

async function findIssuerCandidateFiles(root) {
  const relativeRoot = path.relative(repoRoot, path.resolve(root));
  const insideRepository =
    relativeRoot !== "" &&
    relativeRoot !== ".." &&
    !relativeRoot.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeRoot);
  if (insideRepository) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        "git",
        [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          relativeRoot.replaceAll("\\", "/"),
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
      ));
    } catch {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        "git candidate inventory for the issuer service failed",
      );
    }
    const prefix = `${relativeRoot.replaceAll("\\", "/")}/`;
    return stdout
      .split("\0")
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .sort();
  }

  const matches = [];
  await walk(root, "");
  return matches.sort();

  async function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `issuer service directory is missing at ${root}`,
      );
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRECTORIES.has(entry.name)) {
          await walk(path.join(directory, entry.name), relativePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      matches.push(relativePath.replaceAll("\\", "/"));
    }
  }
}

async function auditIssuerCandidateFiles(root, candidatePaths) {
  const secretFiles = candidatePaths.filter((relativePath) =>
    SECRET_FILE_PATTERN.test(relativePath),
  );
  if (secretFiles.length > 0) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `secret-bearing issuer filenames are forbidden: ${secretFiles.join(", ")}`,
    );
  }

  for (const relativePath of candidatePaths) {
    const source = await readRequiredText(path.join(root, relativePath));
    if (SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(source))) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `common secret literal is forbidden in issuer file ${relativePath}`,
      );
    }
  }
}

async function readRequiredText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `required config is missing at ${filePath}`,
    );
  }
}

function auditObservability(observability, environment) {
  if (!isRecord(observability)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} observability must be an object`,
    );
  }
  requireExactKeys(
    observability,
    ["enabled", "head_sampling_rate"],
    `${environment} observability`,
  );
  requireEqual(observability.enabled, true, `${environment} observability.enabled`);
  if (
    typeof observability.head_sampling_rate !== "number" ||
    !Number.isFinite(observability.head_sampling_rate) ||
    observability.head_sampling_rate < 0 ||
    observability.head_sampling_rate > 1
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} observability.head_sampling_rate must be between 0 and 1`,
    );
  }
}

function requireCredentialMetadataPair(vars, keyIdName, digestName, environment) {
  if ((vars[keyIdName] === "") !== (vars[digestName] === "")) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${environment} ${keyIdName} and ${digestName} must both be empty or both be set`,
    );
  }
}

function rejectSecretLiterals(config) {
  visit(config, "$", undefined);

  function visit(value, jsonPath, key) {
    if (typeof value === "string") {
      if (value !== "" && TRACKED_SECRET_NAME_PATTERN.test(key ?? "")) {
        throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
          `secret or private-key literal is forbidden at ${jsonPath}`,
        );
      }
      if (
        value !== "" &&
        SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(value))
      ) {
        throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
          `common secret literal is forbidden at ${jsonPath}`,
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

function stripJsoncComments(source) {
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
        throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
          "unterminated JSONC block comment",
        );
      }
      continue;
    }
    output += character;
  }
  if (inString) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "unterminated JSONC string",
    );
  }
  return output;
}

function parseJsonValue(source, sourceLabel) {
  let index = 0;
  const value = parseValue();
  skipWhitespace();
  if (index !== source.length) fail();
  return value;

  function parseValue() {
    skipWhitespace();
    const character = source[index];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    if (source.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (source.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (source.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = source
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) fail();
      return parsed;
    }
    fail();
  }

  function parseObject() {
    index += 1;
    const value = {};
    const keys = new Set();
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return value;
    }
    while (index < source.length) {
      if (source[index] !== '"') fail();
      const key = parseString();
      if (keys.has(key)) {
        throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
          `${sourceLabel} contains duplicate object key ${JSON.stringify(key)}`,
        );
      }
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") fail();
      index += 1;
      const child = parseValue();
      Object.defineProperty(value, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return value;
      }
      if (source[index] !== ",") fail();
      index += 1;
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return value;
      }
    }
    fail();
  }

  function parseArray() {
    index += 1;
    const value = [];
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return value;
    }
    while (index < source.length) {
      value.push(parseValue());
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return value;
      }
      if (source[index] !== ",") fail();
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return value;
      }
    }
    fail();
  }

  function parseString() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          fail();
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail();
      }
      index += 1;
    }
    fail();
  }

  function skipWhitespace() {
    while (/\s/.test(source[index] ?? "")) index += 1;
  }

  function fail() {
    throw new SyntaxError("invalid JSONC");
  }
}

function stripTomlComments(source) {
  let output = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      output += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    output += character;
  }
  if (quote !== null) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "root wrangler.toml contains an unterminated string",
    );
  }
  return output;
}

function extractProductionEnvironmentSlice(source) {
  const lines = source.split(/\r?\n/);
  const selected = [];
  let found = false;
  let active = false;

  for (const line of lines) {
    const header = line.match(
      /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*$/,
    );
    if (header) {
      const table = header[1];
      if (table === "env.production") {
        found = true;
      }
      active =
        table === "env.production" ||
        table.startsWith("env.production.");
    }
    if (active) selected.push(line);
  }
  if (!found) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "root wrangler.toml must contain [env.production]",
    );
  }
  return selected.join("\n");
}

function requireEnvironment(environment) {
  if (!Object.hasOwn(ISSUER_ENVIRONMENTS, environment)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      "environment must be exactly local or staging",
    );
  }
  return ISSUER_ENVIRONMENTS[environment];
}

function requireExactObject(actual, expected, label) {
  if (!isRecord(actual)) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${label} must be an object`,
    );
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
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${label} must contain exactly ${expectedKeys.join(", ")}`,
    );
  }
}

function requireEmptyOrPattern(value, pattern, label, description) {
  if (
    value !== "" &&
    (typeof value !== "string" || !pattern.test(value))
  ) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${label} must be empty or ${description}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
      `${label} must be ${String(expected)}`,
    );
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
  const unknown = argv.filter((argument) => argument !== "--json");
  const json = argv.includes("--json");
  try {
    if (unknown.length > 0) {
      throw new DrainSourceRegistrationPermitIssuerConfigAuditError(
        `unknown argument: ${unknown[0]}`,
      );
    }
    const report = await auditTrackedIssuerConfigs();
    console.log(
      json
        ? JSON.stringify(report, null, 2)
        : "Drain-source registration permit issuer config isolation audit passed.",
    );
  } catch (error) {
    const message =
      error instanceof DrainSourceRegistrationPermitIssuerConfigAuditError
        ? error.message
        : "unexpected drain-source registration permit issuer config audit failure";
    if (json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(
        `Drain-source registration permit issuer config isolation audit failed: ${message}`,
      );
    }
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await cliMain();
}
