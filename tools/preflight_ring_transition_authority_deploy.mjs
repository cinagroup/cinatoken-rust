#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
  AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
  AUTHORITY_REQUIRED_SECRET_BINDINGS,
  AUTHORITY_SERVICE_DIR,
  AUTHORITY_STAGING_ROUTE,
  AUTHORITY_STAGING_ZONE,
  AuthorityConfigAuditError,
  auditAuthorityConfig,
  parseAuthorityWranglerJsonc,
} from "./audit_ring_transition_authority_config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(
  repoRoot,
  "services",
  "ring-transition-authority",
  "wrangler.staging.jsonc",
);
const DEFAULT_PRODUCTION_CONFIG_PATH = path.join(
  AUTHORITY_SERVICE_DIR,
  "wrangler.production.jsonc",
);

export const AUTHORITY_DEPLOY_EVIDENCE_CONTRACT =
  "cinatoken-ring-transition-authority-deploy-preflight-v1";
export const AUTHORITY_REQUIRED_CONFIRMATIONS = Object.freeze([
  "credentialRevocationConfirmed",
  "accessServiceAuthConfirmed",
  "accessPolicyReadbackConfirmed",
  "routeInventoryConfirmed",
  "routeReadbackConfirmed",
  "noBypassRouteConfirmed",
  "d1IdentityReadbackConfirmed",
  "d1CatalogReadbackConfirmed",
  "workerConfigReadbackConfirmed",
  "hmacSecretBindingConfirmed",
  "permitPublicKeyBindingConfirmed",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuthorityDeployPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorityDeployPreflightError";
  }
}

export function buildAuthorityDeployNoGoReport(reason = "evidence-not-supplied") {
  return Object.freeze({
    ok: false,
    decision: "NO-GO",
    readyForDeploy: false,
    environment: "staging",
    reason,
    staticOnly: true,
    networkUsed: false,
    credentialsRead: false,
    deployed: false,
  });
}

export function digestAuthorityConfig(config) {
  if (!isRecord(config)) {
    throw new AuthorityDeployPreflightError(
      "Authority config digest input must be an object",
    );
  }
  return sha256(stableJson(config));
}

export function databaseIdEvidenceSha256(databaseId) {
  if (typeof databaseId !== "string" || databaseId.length === 0) {
    throw new AuthorityDeployPreflightError("database_id is required");
  }
  return sha256(`cinatoken-ring-control-d1-id-v1\n${databaseId}`);
}

export function validateAuthorityDeployEvidence(config, evidence) {
  let audit;
  try {
    audit = auditAuthorityConfig(config, "staging");
  } catch (error) {
    if (error instanceof AuthorityConfigAuditError) {
      throw new AuthorityDeployPreflightError(error.message);
    }
    throw error;
  }

  if (!isRecord(evidence)) {
    throw new AuthorityDeployPreflightError(
      "deployment evidence is required; default decision is NO-GO",
    );
  }
  requireExactKeys(
    evidence,
    [
      "contract",
      "environment",
      "candidateConfigSha256",
      "databaseIdSha256",
      "routePattern",
      "routeZoneName",
      "routeCustomDomain",
      "hmacSecretBindings",
      "permitPublicKeyBinding",
      "confirmations",
      "evidenceDigests",
    ],
    "deployment evidence",
  );
  requireEqual(
    evidence.contract,
    AUTHORITY_DEPLOY_EVIDENCE_CONTRACT,
    "evidence contract",
  );
  requireEqual(evidence.environment, "staging", "evidence environment");
  requireSha256(evidence.candidateConfigSha256, "candidateConfigSha256");
  requireEqual(
    evidence.candidateConfigSha256,
    digestAuthorityConfig(config),
    "candidateConfigSha256",
  );
  requireSha256(evidence.databaseIdSha256, "databaseIdSha256");

  const database = config.d1_databases[0];
  rejectPlaceholderDatabaseId(database.database_id);
  validateProvisionedIdentityVars(config.vars);
  requireEqual(
    evidence.databaseIdSha256,
    databaseIdEvidenceSha256(database.database_id),
    "databaseIdSha256",
  );
  requireEqual(evidence.routePattern, AUTHORITY_STAGING_ROUTE, "routePattern");
  requireEqual(evidence.routeZoneName, AUTHORITY_STAGING_ZONE, "routeZoneName");
  requireEqual(evidence.routeCustomDomain, false, "routeCustomDomain");
  requireExactStringArray(
    evidence.hmacSecretBindings,
    AUTHORITY_REQUIRED_SECRET_BINDINGS,
    "hmacSecretBindings",
  );
  requireEqual(
    evidence.permitPublicKeyBinding,
    AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
    "permitPublicKeyBinding",
  );

  if (!isRecord(evidence.confirmations)) {
    throw new AuthorityDeployPreflightError(
      "evidence confirmations must be an object",
    );
  }
  if (!isRecord(evidence.evidenceDigests)) {
    throw new AuthorityDeployPreflightError(
      "evidence digests must be an object",
    );
  }
  requireExactKeys(
    evidence.confirmations,
    AUTHORITY_REQUIRED_CONFIRMATIONS,
    "evidence confirmations",
  );
  requireExactKeys(
    evidence.evidenceDigests,
    AUTHORITY_REQUIRED_CONFIRMATIONS,
    "evidence digests",
  );
  for (const confirmation of AUTHORITY_REQUIRED_CONFIRMATIONS) {
    requireEqual(
      evidence.confirmations[confirmation],
      true,
      `confirmation ${confirmation}`,
    );
    requireSha256(
      evidence.evidenceDigests[confirmation],
      `evidence digest ${confirmation}`,
    );
  }

  return Object.freeze({
    ok: true,
    decision: "GO",
    readyForDeploy: true,
    environment: "staging",
    mode: "static-local-evidence-gate",
    candidateConfigSha256: evidence.candidateConfigSha256,
    bindings: audit.bindings,
    database: Object.freeze({
      binding: "DB",
      databaseName: audit.database.databaseName,
      id: "redacted",
      identityEvidence: "sha256-verified",
    }),
    route: audit.route,
    confirmations: Object.freeze([...AUTHORITY_REQUIRED_CONFIRMATIONS]),
    staticOnly: true,
    networkUsed: false,
    credentialsRead: false,
    deployed: false,
  });
}

export async function runAuthorityDeployPreflight({
  configPath = DEFAULT_CONFIG_PATH,
  evidencePath,
  productionConfigPath = DEFAULT_PRODUCTION_CONFIG_PATH,
} = {}) {
  const productionConfigs = await findProductionAuthorityConfigs(
    path.dirname(configPath),
  );
  if (
    (await pathExists(productionConfigPath)) ||
    productionConfigs.length > 0
  ) {
    throw new AuthorityDeployPreflightError(
      `production Authority config is forbidden${
        productionConfigs.length > 0
          ? `: ${productionConfigs.join(", ")}`
          : ""
      }`,
    );
  }
  if (typeof evidencePath !== "string" || evidencePath.trim() === "") {
    throw new AuthorityDeployPreflightError(
      "local --evidence file is required; default decision is NO-GO",
    );
  }

  const [configSource, evidenceSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]);
  const config = parseAuthorityWranglerJsonc(configSource, configPath);
  const evidence = parseLocalEvidence(evidenceSource, evidencePath);
  return validateAuthorityDeployEvidence(config, evidence);
}

export function parseLocalEvidence(
  source,
  sourceLabel = "Authority deployment evidence",
) {
  if (typeof source !== "string") {
    throw new AuthorityDeployPreflightError(`${sourceLabel} must be text`);
  }
  try {
    const parsed = JSON.parse(source);
    if (!isRecord(parsed)) {
      throw new AuthorityDeployPreflightError(
        `${sourceLabel} must contain a JSON object`,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof AuthorityDeployPreflightError) throw error;
    throw new AuthorityDeployPreflightError(
      `${sourceLabel} must contain strict JSON`,
    );
  }
}

function rejectPlaceholderDatabaseId(databaseId) {
  if (
    typeof databaseId !== "string" ||
    databaseId.trim() === "" ||
    /^REPLACE_WITH_/i.test(databaseId) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)
  ) {
    throw new AuthorityDeployPreflightError(
      "staging DB database_id must not be a placeholder",
    );
  }
  if (!D1_ID_PATTERN.test(databaseId)) {
    throw new AuthorityDeployPreflightError(
      "staging DB database_id has an invalid UUID format",
    );
  }
}

function validateProvisionedIdentityVars(vars) {
  requireKeyId(
    vars.RING_TRANSITION_HMAC_CURRENT_KID,
    "RING_TRANSITION_HMAC_CURRENT_KID",
  );
  requireSha256(
    vars.RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    "RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
  );
  requireKeyId(
    vars.RING_TRANSITION_PERMIT_KEY_ID,
    "RING_TRANSITION_PERMIT_KEY_ID",
  );
  requireSha256(
    vars.RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256,
    "RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256",
  );
  requireSha256(
    vars[AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR],
    AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
  );

  const previousKid = vars.RING_TRANSITION_HMAC_PREVIOUS_KID;
  const previousCredential =
    vars.RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256;
  const previousKidEmpty = previousKid === "";
  const previousCredentialEmpty = previousCredential === "";
  if (previousKidEmpty !== previousCredentialEmpty) {
    throw new AuthorityDeployPreflightError(
      "previous HMAC kid and credential id must be both empty or both valid",
    );
  }
  if (!previousKidEmpty) {
    requireKeyId(previousKid, "RING_TRANSITION_HMAC_PREVIOUS_KID");
    requireSha256(
      previousCredential,
      "RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256",
    );
  }
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new AuthorityDeployPreflightError(
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
}

function requireKeyId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new AuthorityDeployPreflightError(
      `${label} must be a non-empty key identifier`,
    );
  }
}

function requireExactStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.some((entry) => typeof entry !== "string") ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new AuthorityDeployPreflightError(
      `${label} must contain only ${expected.join(", ")}`,
    );
  }
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AuthorityDeployPreflightError(
      `${label} must contain exactly ${expectedKeys.join(", ")}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AuthorityDeployPreflightError(
      `${label} must be ${String(expected)}`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findProductionAuthorityConfigs(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().startsWith("wrangler") &&
        /(?:prod|production)/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

export function parseAuthorityDeployCliArguments(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    evidencePath: undefined,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--config":
        options.configPath = requireOptionValue(argv, ++index, flag);
        break;
      case "--evidence":
        options.evidencePath = requireOptionValue(argv, ++index, flag);
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new AuthorityDeployPreflightError(`unknown option: ${flag}`);
    }
  }
  return options;
}

function requireOptionValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new AuthorityDeployPreflightError(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  bun tools/preflight_ring_transition_authority_deploy.mjs --evidence <local-evidence.json> [--config <wrangler.staging.jsonc>] [--json]",
    "",
    "This command reads local files only. It does not read credentials, use the network, invoke Wrangler, or deploy.",
    "Without a complete evidence file the decision is NO-GO.",
  ].join("\n");
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseAuthorityDeployCliArguments(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const report = await runAuthorityDeployPreflight(options);
    console.log(
      options.json
        ? JSON.stringify(report, null, 2)
        : "Ring transition Authority static deploy preflight passed.",
    );
  } catch (error) {
    const message =
      error instanceof AuthorityDeployPreflightError ||
      error instanceof AuthorityConfigAuditError
        ? error.message
        : "unexpected Authority deploy preflight failure";
    const report = buildAuthorityDeployNoGoReport(message);
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify(report, null, 2));
    } else {
      console.error(`Ring transition Authority deploy preflight NO-GO: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await cliMain();
}
