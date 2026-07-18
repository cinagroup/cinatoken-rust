import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedSubprocess } from "./bounded_subprocess.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultWranglerCliPath = path.join(
  repoRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const maxCommandOutputBytes = 4 * 1024 * 1024;
const commandTimeoutMs = 60_000;
const containerPageSize = 100;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/;

export const CLOUDFLARE_READBACK_COMMAND_KEYS = Object.freeze([
  "edge-version",
  "edge-deployments",
  "controller-version",
  "controller-deployments",
  "provider-egress-version",
  "provider-egress-deployments",
  "d1-info",
  "r2-info",
  "kv-namespaces",
  "container-applications",
  "container-info",
  "container-instances",
  "container-images",
]);

export class CloudflareReadbackError extends Error {}

export function buildCloudflareReadbackPlan(
  request,
  {
    runtimeExecutable = process.execPath,
    wranglerCliPath = defaultWranglerCliPath,
  } = {},
) {
  requireAbsolutePath(runtimeExecutable, "runtime executable");
  requireAbsolutePath(wranglerCliPath, "Wrangler CLI");
  requireSamePath(runtimeExecutable, process.execPath, "runtime executable");
  requireSamePath(wranglerCliPath, defaultWranglerCliPath, "Wrangler CLI");
  const candidate = requireObject(request?.candidate, "candidate");
  const accountId = requireSafeToken(request?.accountId, "account ID");
  const configKvNamespaceId = requireSafeToken(
    request?.configKvNamespaceId,
    "CONFIG_KV namespace ID",
  );
  const containerApplicationId = requireSafeToken(
    request?.containerApplicationId,
    "Container application ID",
  );

  const worker = (keyPrefix, name, versionId) => [
    command({
      key: `${keyPrefix}-version`,
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: [
        "versions",
        "view",
        requireSafeToken(versionId, `${keyPrefix} version ID`),
        "--name",
        requireSafeToken(name, `${keyPrefix} Worker name`),
        "--json",
      ],
      expectedValues: [versionId, name],
    }),
    command({
      key: `${keyPrefix}-deployments`,
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: [
        "deployments",
        "list",
        "--name",
        name,
        "--json",
      ],
      expectedValues: [versionId],
    }),
  ];

  const plan = [
    ...worker(
      "edge",
      "cinatoken-rust-api-staging",
      candidate.edgeWorkerVersionId,
    ),
    ...worker(
      "controller",
      candidate.controllerServiceName,
      candidate.controllerWorkerVersionId,
    ),
    ...worker(
      "provider-egress",
      candidate.providerEgressServiceName,
      candidate.providerEgressWorkerVersionId,
    ),
    command({
      key: "d1-info",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: ["d1", "info", candidate.d1DatabaseName, "--json"],
      expectedValues: [candidate.d1DatabaseName, candidate.d1DatabaseId],
    }),
    command({
      key: "r2-info",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: ["r2", "bucket", "info", candidate.r2BucketName, "--json"],
      expectedValues: [candidate.r2BucketName],
    }),
    command({
      key: "kv-namespaces",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: ["kv", "namespace", "list"],
      expectedValues: [configKvNamespaceId],
    }),
    command({
      key: "container-applications",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: [
        "containers",
        "list",
        "--per-page",
        String(containerPageSize),
        "--json",
      ],
      expectedValues: [containerApplicationId],
      boundedPageSize: containerPageSize,
    }),
    command({
      key: "container-info",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: ["containers", "info", containerApplicationId],
      expectedValues: [containerApplicationId],
      expectedContainerImageDigest: candidate.containerImageDigest,
    }),
    command({
      key: "container-instances",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: [
        "containers",
        "instances",
        containerApplicationId,
        "--per-page",
        String(containerPageSize),
        "--json",
      ],
      expectedValues: [],
      boundedPageSize: containerPageSize,
    }),
    command({
      key: "container-images",
      runtimeExecutable,
      wranglerCliPath,
      wranglerArgs: ["containers", "images", "list", "--json"],
      expectedValues: [],
    }),
  ];

  if (
    plan.length !== CLOUDFLARE_READBACK_COMMAND_KEYS.length ||
    plan.some((item, index) => item.key !== CLOUDFLARE_READBACK_COMMAND_KEYS[index])
  ) {
    throw new CloudflareReadbackError("readback command inventory drifted");
  }
  for (const item of plan) assertReadOnlyWranglerCommand(item);
  return { accountId, plan };
}

export function assertReadOnlyWranglerCommand(item) {
  requireObject(item, "readback command");
  requireAbsolutePath(item.command, "readback runtime executable");
  requireAbsolutePath(item.wranglerCliPath, "readback Wrangler CLI");
  requireSamePath(item.command, process.execPath, "readback runtime executable");
  requireSamePath(item.wranglerCliPath, defaultWranglerCliPath, "readback Wrangler CLI");
  if (!Array.isArray(item.args) || item.args[0] !== item.wranglerCliPath) {
    throw new CloudflareReadbackError("readback must invoke the pinned Wrangler CLI");
  }
  const args = item.args.slice(1);
  if (!isAllowedWranglerArgs(args)) {
    throw new CloudflareReadbackError("Wrangler command is outside the read-only allowlist");
  }
  const forbidden = new Set([
    "build",
    "create",
    "delete",
    "deploy",
    "execute",
    "get",
    "put",
    "push",
    "rollback",
    "secret",
    "ssh",
    "tail",
    "update",
    "upload",
    "wake",
  ]);
  if (args.some((value) => forbidden.has(value.toLowerCase()))) {
    throw new CloudflareReadbackError("Wrangler command contains a mutating operation");
  }
  return item;
}

export function buildDedicatedReadbackEnvironment({ apiToken, accountId }) {
  if (
    typeof apiToken !== "string" ||
    apiToken.length < 20 ||
    apiToken.length > 4096 ||
    /[^\x21-\x7e]/.test(apiToken)
  ) {
    throw new CloudflareReadbackError("replacement readback token is invalid");
  }
  requireSafeToken(accountId, "account ID");
  const env = {
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (typeof process.env[name] === "string" && process.env[name].length > 0) {
      env[name] = process.env[name];
    }
  }
  return env;
}

export async function executeCloudflareReadback(
  { accountId, plan },
  { apiToken, runCommand = runBoundedSubprocess } = {},
) {
  const env = buildDedicatedReadbackEnvironment({ apiToken, accountId });
  const commands = [];
  for (const item of plan) {
    assertReadOnlyWranglerCommand(item);
    commands.push(await executeOne(item, { env, apiToken, runCommand }));
  }
  const digestSha256 = sha256(stableJson(commands));
  return {
    commands,
    digestSha256,
    complete: commands.every((item) => item.status === "pass"),
    paginationComplete: commands.every((item) => item.paginationComplete),
    stderrEmpty: commands.every((item) => item.stderrEmpty),
  };
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function executeOne(item, { env, apiToken, runCommand }) {
  let result;
  try {
    result = await runCommand(item.command, item.args, {
      cwd: path.dirname(item.wranglerCliPath),
      env,
      maxOutputBytes: maxCommandOutputBytes,
      timeoutMs: commandTimeoutMs,
    });
  } catch {
    return failedSummary(item, "runner-error");
  }
  if (!result || typeof result !== "object") {
    return failedSummary(item, "invalid-runner-result");
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout.includes(apiToken) || stderr.includes(apiToken)) {
    throw new CloudflareReadbackError("Wrangler output contained the readback credential");
  }
  if (
    result.exitCode !== 0 ||
    result.outputLimitExceeded === true ||
    result.timedOut === true ||
    result.invalidUtf8 === true
  ) {
    return failedSummary(item, classifyFailure(result));
  }
  if (!isSafeOutput(stdout) || !isSafeOutput(stderr)) {
    return failedSummary(item, "unsafe-output");
  }

  let normalized;
  let parsed = null;
  let itemCount = null;
  try {
    if (item.format === "text") {
      normalized = normalizeText(stdout);
    } else {
      parsed = JSON.parse(stdout);
      assertBoundedJson(parsed);
      normalized = stableJson(parsed);
      itemCount = inferItemCount(parsed);
    }
  } catch {
    return failedSummary(item, "invalid-output");
  }
  const expectedValuesPresent = item.expectedValues.every((expected) =>
    outputContainsExactValue(normalized, expected, item.format),
  );
  const expectedContainerImageDigestPresent =
    item.expectedContainerImageDigest === null
      ? null
      : applicationImageMatchesDigest(
        parsed,
        item.expectedContainerImageDigest,
      );
  const paginationComplete =
    item.boundedPageSize == null ||
    (Number.isSafeInteger(itemCount) && itemCount < item.boundedPageSize);
  return {
    key: item.key,
    status:
      expectedValuesPresent &&
      expectedContainerImageDigestPresent !== false &&
      paginationComplete &&
      stderr.length === 0
        ? "pass"
        : "not-proven",
    outputSha256: sha256(normalized),
    outputBytes: Buffer.byteLength(normalized, "utf8"),
    stderrSha256: stderr.length === 0 ? null : sha256(normalizeText(stderr)),
    stderrEmpty: stderr.length === 0,
    expectedValuesPresent,
    expectedContainerImageDigestPresent,
    itemCount,
    paginationComplete,
  };
}

function command({
  key,
  runtimeExecutable,
  wranglerCliPath,
  wranglerArgs,
  expectedValues,
  expectedContainerImageDigest = null,
  boundedPageSize = null,
  format = "json",
}) {
  if (
    expectedContainerImageDigest !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(expectedContainerImageDigest)
  ) {
    throw new CloudflareReadbackError("expected Container image digest is invalid");
  }
  return {
    key,
    command: path.resolve(runtimeExecutable),
    wranglerCliPath: path.resolve(wranglerCliPath),
    args: [path.resolve(wranglerCliPath), ...wranglerArgs],
    expectedValues: expectedValues.map((value) => String(value)),
    expectedContainerImageDigest,
    boundedPageSize,
    format,
  };
}

function isAllowedWranglerArgs(args) {
  const token = (value) => typeof value === "string" && safeTokenPattern.test(value);
  const exact = (...values) =>
    args.length === values.length &&
    values.every((value, index) => value === "*" ? token(args[index]) : args[index] === value);
  return (
    exact("versions", "view", "*", "--name", "*", "--json") ||
    exact("deployments", "list", "--name", "*", "--json") ||
    exact("d1", "info", "*", "--json") ||
    exact("r2", "bucket", "info", "*", "--json") ||
    exact("kv", "namespace", "list") ||
    exact("containers", "list", "--per-page", String(containerPageSize), "--json") ||
    exact("containers", "info", "*") ||
    exact(
      "containers",
      "instances",
      "*",
      "--per-page",
      String(containerPageSize),
      "--json",
    ) ||
    exact("containers", "images", "list", "--json")
  );
}

function classifyFailure(result) {
  if (result.outputLimitExceeded === true) return "output-limit";
  if (result.timedOut === true) return "timeout";
  if (result.invalidUtf8 === true) return "invalid-utf8";
  return "command-failed";
}

function failedSummary(item, reason) {
  return {
    key: item.key,
    status: "not-proven",
    outputSha256: null,
    outputBytes: 0,
    stderrSha256: null,
    stderrEmpty: false,
    expectedValuesPresent: false,
    expectedContainerImageDigestPresent:
      item.expectedContainerImageDigest === null ? null : false,
    itemCount: null,
    paginationComplete: false,
    reason,
  };
}

function normalizeText(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CloudflareReadbackError("Wrangler output was empty");
  }
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function isSafeOutput(value) {
  if (typeof value !== "string" || value.includes("\0")) return false;
  return !(
    /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----$/m.test(value) ||
    /(?:^|\s)Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(value) ||
    /(?:sk|rk)-[A-Za-z0-9_-]{20,}/.test(value) ||
    /(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}/.test(value)
  );
}

function assertBoundedJson(root) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 100_000 || depth > 24) {
      throw new CloudflareReadbackError("Wrangler JSON exceeded shape bounds");
    }
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > 64 * 1024 || value.includes("\0")) {
        throw new CloudflareReadbackError("Wrangler JSON contained an unsafe string");
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new CloudflareReadbackError("Wrangler JSON number is invalid");
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.length === 0 || key.length > 256) {
          throw new CloudflareReadbackError("Wrangler JSON field name is invalid");
        }
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CloudflareReadbackError("non-finite number cannot be canonicalized");
  }
  return value;
}

function inferItemCount(value) {
  if (Array.isArray(value)) return value.length;
  for (const key of ["items", "result", "applications", "instances", "images"]) {
    if (Array.isArray(value?.[key])) return value[key].length;
  }
  return null;
}

function outputContainsExactValue(normalized, expected, format) {
  if (format === "text") return normalized.split(/\s+/).includes(expected);
  let value;
  try {
    value = JSON.parse(normalized);
  } catch {
    return false;
  }
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (String(current) === expected) return true;
    if (Array.isArray(current)) stack.push(...current);
    else if (current && typeof current === "object") stack.push(...Object.values(current));
  }
  return false;
}

function applicationImageMatchesDigest(value, expectedDigest) {
  const images = [value?.configuration?.image, value?.image];
  return images.some(
    (image) =>
      typeof image === "string" &&
      (image === expectedDigest || image.endsWith(`@${expectedDigest}`)),
  );
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudflareReadbackError(`${label} must be an object`);
  }
  return value;
}

function requireSafeToken(value, label) {
  if (typeof value !== "string" || !safeTokenPattern.test(value)) {
    throw new CloudflareReadbackError(`${label} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new CloudflareReadbackError(`${label} must be an absolute path`);
  }
  return value;
}

function requireSamePath(actual, expected, label) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (normalize(actual) !== normalize(expected)) {
    throw new CloudflareReadbackError(`${label} is not the repository-pinned path`);
  }
}
