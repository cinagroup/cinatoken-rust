#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBoundedSubprocess } from "./lib/bounded_subprocess.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONTROLLER_DEPLOY_ENVIRONMENTS = Object.freeze({
  staging: Object.freeze({
    controllerName: "cinatoken-container-controller-staging",
    databaseName: "cinatoken-rust-db-staging",
    r2BucketName: "cinatoken-rust-files-staging",
    providerEgressService: "cinatoken-container-egress-staging",
  }),
  production: Object.freeze({
    controllerName: "cinatoken-container-controller-production",
    databaseName: "cinatoken-rust-db",
    r2BucketName: "cinatoken-rust-files",
    providerEgressService: "cinatoken-container-egress-production",
  }),
});

export const REQUIRED_CONTROLLER_SECRET =
  "CONTAINER_AUTHORITY_CURRENT_SECRET";
export const REQUIRED_PROVIDER_EGRESS_SECRET =
  "CINATOKEN_CONTAINER_PROVIDER_API_KEY";
export const REQUIRED_DISABLED_CONTROLLER_VARS = Object.freeze([
  "CONTAINER_CONTROLLER_ENABLED",
  "CONTAINER_EXECUTION_ENABLED",
  "CONTAINER_READINESS_PROBE_ENABLED",
  "CONTAINER_READINESS_WAKE_ENABLED",
  "CONTAINER_STORAGE_R2_READ_ENABLED",
  "CONTAINER_STORAGE_R2_WRITE_ENABLED",
  "CONTAINER_STORAGE_KV_READ_ENABLED",
  "CONTAINER_STORAGE_D1_READ_ENABLED",
  "CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED",
  "CONTAINER_PROVIDER_CLIENT_ENABLED",
  "CONTAINER_PROVIDER_EGRESS_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED",
  "CONTAINER_PROVIDER_RETRY_ENABLED",
  "CONTAINER_PROVIDER_ATTEMPT_STAGING_VERIFIED",
  "CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED",
  "CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED",
  "CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED",
  "CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED",
  "CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED",
  "CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED",
  "CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED",
]);
export const REQUIRED_DISABLED_RING_TRANSITION_VARS = Object.freeze([
  "CONTAINER_PREVIOUS_RING_GENERATION",
  "CONTAINER_PREVIOUS_SHARD_COUNT",
  "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT",
  "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL",
]);

const D1_DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DEFAULT_PROVIDER_EGRESS_CONFIG = path.join(
  repoRoot,
  "crates",
  "container-egress",
  "wrangler.toml",
);
const DEFAULT_WRANGLER_CLI = path.join(
  repoRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

export class DeployPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeployPreflightError";
  }
}

export function parseControllerWranglerJsonc(
  source,
  sourceLabel = "Controller Wrangler config",
) {
  if (typeof source !== "string") {
    throw new DeployPreflightError(`${sourceLabel} must be text`);
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new DeployPreflightError(
      `${sourceLabel} must contain valid strict JSON`,
    );
  }

  if (!isRecord(config)) {
    throw new DeployPreflightError(`${sourceLabel} must contain a JSON object`);
  }
  return config;
}

export const parseControllerConfig = parseControllerWranglerJsonc;

export function findUnsafePlaceholders(value) {
  const findings = [];
  visitValue(value, "$", undefined, findings);
  return findings;
}

export function validateControllerConfig(config, environment) {
  const contract = requireEnvironmentContract(environment);
  if (!isRecord(config)) {
    throw new DeployPreflightError("Controller config must be an object");
  }

  const placeholders = findUnsafePlaceholders(config);
  if (placeholders.length > 0) {
    const finding = placeholders[0];
    throw new DeployPreflightError(
      `unsafe ${finding.kind} at ${finding.path}`,
    );
  }

  requireEqual(
    config.name,
    contract.controllerName,
    `Controller name for ${environment}`,
  );
  requireEqual(config.workers_dev, false, `${environment} workers_dev`);
  requireEqual(config.preview_urls, false, `${environment} preview_urls`);
  if (!isRecord(config.observability) || config.observability.enabled !== true) {
    throw new DeployPreflightError(`${environment} observability must be enabled`);
  }
  if (
    !isRecord(config.version_metadata) ||
    config.version_metadata.binding !== "CF_VERSION_METADATA" ||
    Object.keys(config.version_metadata).length !== 1
  ) {
    throw new DeployPreflightError(
      `${environment} version_metadata must expose only CF_VERSION_METADATA`,
    );
  }
  if (!isRecord(config.vars)) {
    throw new DeployPreflightError(`${environment} vars must be an object`);
  }
  requireEqual(config.vars.ENVIRONMENT, environment, `${environment} ENVIRONMENT`);
  requireEqual(
    config.vars.CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID,
    "",
    `${environment} CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID`,
  );
  requireEqual(
    config.vars.CONTAINER_DURABLE_OBJECT_JURISDICTION,
    "default",
    `${environment} CONTAINER_DURABLE_OBJECT_JURISDICTION`,
  );
  for (const name of REQUIRED_DISABLED_CONTROLLER_VARS) {
    requireEqual(config.vars[name], "false", `${environment} ${name}`);
  }
  for (const name of REQUIRED_DISABLED_RING_TRANSITION_VARS) {
    requireEqual(config.vars[name], "0", `${environment} ${name}`);
  }
  for (const [name, value] of Object.entries(config.vars)) {
    if (/(?:_ENABLED|_VERIFIED)$/.test(name) && value !== "false") {
      throw new DeployPreflightError(
        `${environment} action gate ${name} must remain false`,
      );
    }
  }

  const database = requireUniqueBinding(
    config.d1_databases,
    "binding",
    "DB",
    "D1 databases",
  );
  requireEqual(
    database.database_name,
    contract.databaseName,
    `${environment} DB database_name`,
  );
  requireIdentifier(
    database.database_id,
    D1_DATABASE_ID_PATTERN,
    `${environment} DB database_id`,
  );

  const namespace = requireUniqueBinding(
    config.kv_namespaces,
    "binding",
    "CONFIG_KV",
    "KV namespaces",
  );
  requireIdentifier(
    namespace.id,
    KV_NAMESPACE_ID_PATTERN,
    `${environment} CONFIG_KV id`,
  );

  const bucket = requireUniqueBinding(
    config.r2_buckets,
    "binding",
    "FILE_BUCKET",
    "R2 buckets",
  );
  requireEqual(
    bucket.bucket_name,
    contract.r2BucketName,
    `${environment} FILE_BUCKET bucket_name`,
  );

  const providerEgress = requireUniqueBinding(
    config.services,
    "binding",
    "PROVIDER_EGRESS",
    "service bindings",
  );
  requireEqual(
    providerEgress.service,
    contract.providerEgressService,
    `${environment} PROVIDER_EGRESS service`,
  );

  return {
    environment,
    controllerName: contract.controllerName,
    providerEgressWorker: contract.providerEgressService,
    identities: {
      durableObject: {
        binding: "RELAY_SHARDS",
        jurisdiction: "default",
      },
      database: {
        binding: "DB",
        databaseName: contract.databaseName,
        id: "validated",
      },
      kvNamespace: {
        binding: "CONFIG_KV",
        id: "validated",
      },
      r2Bucket: {
        binding: "FILE_BUCKET",
        bucketName: contract.r2BucketName,
      },
      providerEgress: {
        binding: "PROVIDER_EGRESS",
        service: contract.providerEgressService,
      },
    },
  };
}

export const validateControllerDeployConfig = validateControllerConfig;

export function parseWranglerSecretInventory(
  stdout,
  workerLabel = "Worker",
) {
  const text = outputToString(stdout);
  let inventory;
  try {
    inventory = JSON.parse(text);
  } catch {
    throw new DeployPreflightError(
      `${workerLabel} secret inventory was not valid JSON`,
    );
  }

  if (!Array.isArray(inventory)) {
    throw new DeployPreflightError(
      `${workerLabel} secret inventory must be a JSON array`,
    );
  }

  const names = [];
  for (let index = 0; index < inventory.length; index += 1) {
    const entry = inventory[index];
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") {
      throw new DeployPreflightError(
        `${workerLabel} secret inventory entry ${index} is missing a name`,
      );
    }
    names.push(entry.name);
  }

  return [...new Set(names)].sort();
}

export function requireSecretNames(
  inventoryNames,
  requiredNames,
  workerLabel = "Worker",
) {
  if (!Array.isArray(inventoryNames) || !Array.isArray(requiredNames)) {
    throw new DeployPreflightError("secret names must be arrays");
  }
  const available = new Set(inventoryNames);
  const missing = requiredNames.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new DeployPreflightError(
      `${workerLabel} is missing required secret name(s): ${missing.join(", ")}`,
    );
  }
  const expected = new Set(requiredNames);
  const unexpected = inventoryNames.filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new DeployPreflightError(
      `${workerLabel} has unexpected secret name(s): ${unexpected.join(", ")}`,
    );
  }
  return [...requiredNames].sort();
}

export function validateSecretInventoryResult(
  result,
  { workerLabel, requiredNames },
) {
  if (
    !isRecord(result) ||
    result.outputLimitExceeded === true ||
    result.timedOut === true ||
    result.invalidUtf8 === true
  ) {
    throw new DeployPreflightError(
      `${workerLabel} secret inventory command did not complete safely`,
    );
  }

  const exitCode = result.exitCode ?? result.code ?? result.status;
  if (exitCode !== 0) {
    throw new DeployPreflightError(
      `${workerLabel} secret inventory command failed`,
    );
  }

  const inventoryNames = parseWranglerSecretInventory(
    result.stdout,
    workerLabel,
  );
  requireSecretNames(inventoryNames, requiredNames, workerLabel);
  return {
    status: "verified",
    requiredNames: [...requiredNames],
  };
}

export function buildWranglerSecretInventoryCommands({
  environment,
  controllerConfigPath,
  providerEgressConfigPath = DEFAULT_PROVIDER_EGRESS_CONFIG,
  runtimeExecutable = process.execPath,
  wranglerCliPath = DEFAULT_WRANGLER_CLI,
  cwd = repoRoot,
}) {
  const contract = requireEnvironmentContract(environment);
  requireNonEmptyString(controllerConfigPath, "Controller config path");
  requireNonEmptyString(providerEgressConfigPath, "provider-egress config path");
  requireNonEmptyString(runtimeExecutable, "runtime executable");
  requireNonEmptyString(wranglerCliPath, "Wrangler CLI path");

  const resolvedCwd = path.resolve(cwd);
  const controllerPath = path.resolve(resolvedCwd, controllerConfigPath);
  const providerPath = path.resolve(resolvedCwd, providerEgressConfigPath);
  const wranglerPath = path.resolve(resolvedCwd, wranglerCliPath);

  return [
    {
      key: "controller",
      workerLabel: `Controller worker ${contract.controllerName}`,
      command: runtimeExecutable,
      args: [
        wranglerPath,
        "secret",
        "list",
        "--config",
        controllerPath,
        "--format",
        "json",
      ],
      requiredNames: [REQUIRED_CONTROLLER_SECRET],
    },
    {
      key: "providerEgress",
      workerLabel: `provider-egress worker ${contract.providerEgressService}`,
      command: runtimeExecutable,
      args: [
        wranglerPath,
        "secret",
        "list",
        "--config",
        providerPath,
        "--env",
        environment,
        "--format",
        "json",
      ],
      requiredNames: [REQUIRED_PROVIDER_EGRESS_SECRET],
    },
  ];
}

export async function runArgumentArrayCommand(
  command,
  args,
  {
    cwd = repoRoot,
    maxOutputBytes = 1024 * 1024,
    timeoutMs = 30_000,
  } = {},
) {
  requireNonEmptyString(command, "subprocess command");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new DeployPreflightError("subprocess arguments must be a string array");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new DeployPreflightError("subprocess timeout must be between 1000 and 300000 ms");
  }
  return await runBoundedSubprocess(command, args, {
    cwd,
    maxOutputBytes,
    timeoutMs,
  });
}

export async function runContainerControllerDeployPreflight(
  options,
  dependencies = {},
) {
  const {
    environment,
    controllerConfigSource,
    offline = false,
    selfTest = false,
  } = options ?? {};
  requireEnvironmentContract(environment);

  const cwd = path.resolve(options?.cwd ?? repoRoot);
  const controllerConfigPath = options?.controllerConfigPath
    ? path.resolve(cwd, options.controllerConfigPath)
    : undefined;
  const mode = selfTest ? "self-test" : offline ? "offline" : "live";
  const skipInventories = offline || selfTest;

  if (!controllerConfigPath && controllerConfigSource === undefined) {
    throw new DeployPreflightError("Controller config path is required");
  }
  if (!controllerConfigPath && !skipInventories) {
    throw new DeployPreflightError(
      "Controller config path is required for live secret inventory",
    );
  }

  let source = controllerConfigSource;
  if (source === undefined) {
    const readText = dependencies.readFile ?? readFile;
    try {
      source = await readText(controllerConfigPath, "utf8");
    } catch {
      throw new DeployPreflightError("Controller config could not be read");
    }
  }

  const config = parseControllerWranglerJsonc(
    source,
    controllerConfigPath ?? "injected Controller config",
  );
  const validation = validateControllerConfig(config, environment);
  const report = {
    ok: true,
    readyForDeploy: false,
    mode,
    environment,
    controller: validation,
    secretInventories: {
      status: "skipped",
      reason: `${mode} mode`,
    },
  };

  if (skipInventories) return report;

  const commands = buildWranglerSecretInventoryCommands({
    environment,
    controllerConfigPath,
    providerEgressConfigPath:
      options.providerEgressConfigPath ?? DEFAULT_PROVIDER_EGRESS_CONFIG,
    runtimeExecutable: options.runtimeExecutable ?? process.execPath,
    wranglerCliPath: options.wranglerCliPath ?? DEFAULT_WRANGLER_CLI,
    cwd,
  });
  const runCommand = dependencies.runCommand ?? runArgumentArrayCommand;
  const verifiedInventories = {};

  for (const inventory of commands) {
    let result;
    try {
      result = await runCommand(inventory.command, inventory.args, { cwd });
    } catch {
      throw new DeployPreflightError(
        `${inventory.workerLabel} secret inventory command failed`,
      );
    }
    verifiedInventories[inventory.key] = validateSecretInventoryResult(result, {
      workerLabel: inventory.workerLabel,
      requiredNames: inventory.requiredNames,
    });
  }

  report.readyForDeploy = true;
  report.secretInventories = {
    status: "verified",
    workers: verifiedInventories,
  };
  return report;
}

export const runDeployPreflight = runContainerControllerDeployPreflight;

export function parseCliArguments(argv) {
  const options = {
    offline: false,
    selfTest: false,
    json: false,
    help: false,
  };
  const valueOptions = new Map([
    ["--env", "environment"],
    ["--environment", "environment"],
    ["--config", "controllerConfigPath"],
    ["--provider-config", "providerEgressConfigPath"],
    ["--provider-egress-config", "providerEgressConfigPath"],
    ["--wrangler-cli", "wranglerCliPath"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equalsAt = raw.indexOf("=");
    const flag = equalsAt === -1 ? raw : raw.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : raw.slice(equalsAt + 1);

    if (valueOptions.has(flag)) {
      const value = inlineValue ?? argv[++index];
      requireNonEmptyString(value, `${flag} value`);
      options[valueOptions.get(flag)] = value;
      continue;
    }
    if (inlineValue !== undefined) {
      throw new DeployPreflightError(`unknown option: ${flag}`);
    }

    switch (flag) {
      case "--offline":
        options.offline = true;
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new DeployPreflightError(`unknown option: ${flag}`);
    }
  }

  if (!options.help) {
    requireNonEmptyString(options.environment, "--environment");
    options.environment = options.environment.toLowerCase();
    requireEnvironmentContract(options.environment);
    requireNonEmptyString(options.controllerConfigPath, "--config");
  }
  return options;
}

function requireEnvironmentContract(environment) {
  if (
    typeof environment !== "string" ||
    !Object.hasOwn(CONTROLLER_DEPLOY_ENVIRONMENTS, environment)
  ) {
    throw new DeployPreflightError(
      "environment must be exactly staging or production",
    );
  }
  return CONTROLLER_DEPLOY_ENVIRONMENTS[environment];
}

function visitValue(value, jsonPath, key, findings) {
  if (typeof value === "string") {
    if (/^REPLACE_WITH_/i.test(value.trim())) {
      findings.push({ path: jsonPath, kind: "REPLACE_WITH_* placeholder" });
    }
    if (isIdentifierKey(key) && isZeroIdentifier(value)) {
      findings.push({ path: jsonPath, kind: "zero identifier placeholder" });
    }
    return;
  }
  if (typeof value === "number" && value === 0 && isIdentifierKey(key)) {
    findings.push({ path: jsonPath, kind: "zero identifier placeholder" });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitValue(entry, `${jsonPath}[${index}]`, undefined, findings),
    );
    return;
  }
  if (!isRecord(value)) return;

  for (const [childKey, childValue] of Object.entries(value)) {
    visitValue(childValue, `${jsonPath}.${childKey}`, childKey, findings);
  }
}

function isIdentifierKey(key) {
  return typeof key === "string" && /(?:^|_)id$/i.test(key);
}

function isZeroIdentifier(value) {
  const normalized = String(value).trim().replaceAll("-", "");
  return normalized.length > 0 && /^0+$/.test(normalized);
}

function requireUniqueBinding(collection, key, expected, label) {
  if (!Array.isArray(collection)) {
    throw new DeployPreflightError(`${label} must be an array`);
  }
  if (collection.some((entry) => !isRecord(entry))) {
    throw new DeployPreflightError(`${label} must contain only objects`);
  }
  if (collection.length !== 1) {
    throw new DeployPreflightError(
      `${label} must contain only the required ${key} ${expected}`,
    );
  }
  const matches = collection.filter((entry) => entry[key] === expected);
  if (matches.length !== 1) {
    throw new DeployPreflightError(
      `${label} must contain exactly one ${key} ${expected}`,
    );
  }
  return matches[0];
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new DeployPreflightError(`${label} must be ${expected}`);
  }
}

function requireIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DeployPreflightError(`${label} has an invalid format`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeployPreflightError(`${label} is required`);
  }
}

function outputToString(output) {
  if (typeof output === "string") return output;
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8");
  throw new DeployPreflightError("secret inventory output must be text");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage() {
  return [
    "Usage:",
    "  bun tools/preflight_container_controller_deploy.mjs --environment <staging|production> --config <controller-wrangler.jsonc> [options]",
    "",
    "Options:",
    "  --offline                    Validate config only; skip secret inventories",
    "  --self-test                  Alias for an offline, non-deploy-ready check",
    "  --provider-egress-config P   Override crates/container-egress/wrangler.toml",
    "  --wrangler-cli P             Override the local Wrangler JavaScript entrypoint",
    "  --json                       Print a machine-readable report",
    "  --help                       Show this help",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArguments(argv);
    if (options.help) {
      console.log(usage());
      return;
    }

    const report = await runContainerControllerDeployPreflight(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.readyForDeploy) {
      console.log(
        `Container Controller deploy preflight passed for ${report.environment}; both secret inventories are verified.`,
      );
    } else {
      console.log(
        `Container Controller ${report.mode} config check passed for ${report.environment}; secret inventories were skipped, so this result is not deploy-ready.`,
      );
    }
  } catch (error) {
    const message =
      error instanceof DeployPreflightError
        ? error.message
        : "unexpected preflight failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Container Controller deploy preflight failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  await cliMain();
}
