import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runBoundedSubprocess } from "./lib/bounded_subprocess.mjs";

export const LINUX_GATE_CONTRACT_VERSION = 1;
export const RUST_BUILDER_IMAGE =
  "rust:1.78.0-bookworm@sha256:5907e96b0293eb53bcc8f09b4883d71449808af289862950ede9a0e3cca44ff5";
export const DISTROLESS_RUNTIME_IMAGE =
  "gcr.io/distroless/cc-debian12:nonroot@sha256:66aa873a4a14fb164aa01296058efd8253744606d72715e45acface073359faa";
export const NODE_MOCK_IMAGE =
  "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
export const CHECKOUT_ACTION =
  "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCKERFILE = resolve(ROOT, "crates/container-runtime/Dockerfile");
const WORKFLOW = resolve(ROOT, ".github/workflows/container-runtime-linux.yml");
const MOCK_FIXTURE = resolve(ROOT, "tests/fixtures/container-runtime-linux-mock.mjs");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const VERIFIER = fileURLToPath(import.meta.url);
const INPUT = Buffer.from(
  JSON.stringify({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: "linux gate" }],
    stream: false,
  }),
);
const INPUT_SHA256 = createHash("sha256").update(INPUT).digest("hex");

export function parseArgs(argv) {
  const options = { selfTest: false, image: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--image") {
      options.image = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.selfTest === (options.image !== null)) {
    throw new Error("select exactly one of --self-test or --image <reference>");
  }
  if (options.image !== null && !validImageReference(options.image)) {
    throw new Error("image reference must be bounded visible ASCII and must not start with '-'");
  }
  return options;
}

export async function auditRepositoryContract() {
  const [dockerfile, workflow, mockFixture, packageJsonText, verifier] = await Promise.all([
    readFile(DOCKERFILE, "utf8"),
    readFile(WORKFLOW, "utf8"),
    readFile(MOCK_FIXTURE, "utf8"),
    readFile(PACKAGE_JSON, "utf8"),
    readFile(VERIFIER, "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
  requireCondition(
    fromLines.length === 2 &&
      fromLines[0] === `FROM ${RUST_BUILDER_IMAGE} AS builder` &&
      fromLines[1] === `FROM ${DISTROLESS_RUNTIME_IMAGE}`,
    "Dockerfile must use the two exact digest-pinned base images",
  );
  requireCondition(
    dockerfile.includes("USER nonroot:nonroot") &&
      dockerfile.includes("ENTRYPOINT [\"/usr/local/bin/cinatoken-container-runtime\"]"),
    "Dockerfile must retain the non-root fixed entrypoint",
  );
  requireCondition(
    workflow.includes(`uses: ${CHECKOUT_ACTION}`) &&
      workflow.includes("persist-credentials: false") &&
      workflow.includes("docker build --platform linux/amd64") &&
      workflow.includes(
        "node tools/verify_container_runtime_linux.mjs --image cinatoken-container-runtime:linux-gate --json",
      ),
    "workflow must use the pinned checkout action and execute the real linux/amd64 gate",
  );
  requireCondition(
    workflow.includes("permissions:\n  contents: read") &&
      !/\$\{\{\s*secrets\./i.test(workflow) &&
      !/wrangler|cloudflare api|customer traffic/i.test(workflow),
    "workflow must remain read-only and credential-free",
  );
  requireCondition(
    mockFixture.includes("/v1/input") &&
      mockFixture.includes("/v1/provider-attempts/execute") &&
      mockFixture.includes("input_hash_mismatch"),
    "mock must expose the fixed internal HTTP contracts and fault mode",
  );
  requireCondition(
    verifier.includes('"network", "create", "--internal"') &&
      verifier.includes('"r2-input.cinatoken.internal"') &&
      verifier.includes('"provider-egress.cinatoken.internal"') &&
      ![
        ["--", "privileged"].join(""),
        ["docker", ".sock"].join(""),
        ['"', ["ho", "st"].join(""), '"'].join(""),
      ].some((fragment) => verifier.includes(fragment)),
    "real gate must use an internal network without privileged container access",
  );
  requireCondition(
    packageJson.scripts["check:container-runtime:linux-contract"]?.includes("--self-test") &&
      packageJson.scripts["check:container-runtime:linux"]?.includes("--image") &&
      packageJson.scripts.check?.includes("check:container-runtime:linux-contract") &&
      !packageJson.scripts.check?.includes("check:container-runtime:linux &&"),
    "package scripts must keep the offline contract in the aggregate and real Docker in CI",
  );

  return {
    contractVersion: LINUX_GATE_CONTRACT_VERSION,
    status: "passed",
    dockerfileBaseImagesPinned: true,
    checkoutActionPinned: true,
    workflowCredentialFree: true,
    aggregateGateOffline: true,
    remoteMutationAuthorized: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function buildOperationEnvelope({ operationId, kind, now = currentEpochSeconds() }) {
  const healthProbe = kind === "health_probe";
  return {
    protocol_version: 1,
    operation_id: operationId,
    operation_kind: kind,
    owner_generation: 1,
    owner_lease_expires_at: now + 120,
    execution_deadline_at: now + 60,
    provider_operation_id: `provider-${operationId}`,
    admission_sha256: "a".repeat(64),
    input: healthProbe
      ? {
          mode: "inline",
          sha256: createHash("sha256").update("").digest("hex"),
          size: 0,
          content_type: "application/json",
          request_object_key: null,
          object_version: null,
        }
      : {
          mode: "r2",
          sha256: INPUT_SHA256,
          size: INPUT.length,
          content_type: "application/json",
          request_object_key: `container-inputs/v1/${operationId}/input.json`,
          object_version: "version-linux-gate",
        },
    shard: {
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: operationId,
  };
}

export async function runLinuxGate(image) {
  await auditRepositoryContract();
  requireCondition(
    process.platform === "linux" && process.arch === "x64",
    "real container gate requires a Linux x64 host",
  );

  const inspection = await inspectImage(image);
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const network = `cinatoken-linux-gate-${suffix}`;
  const mock = `${network}-mock`;
  const runtime = `${network}-runtime`;
  const restartedRuntime = `${network}-runtime-restarted`;
  const cleanupContainers = new Set([mock, runtime, restartedRuntime]);
  let networkCreated = false;

  try {
    await docker(["network", "create", "--internal", network]);
    networkCreated = true;
    await startMock({ name: mock, network });
    const mockBaseUrl = await publishedBaseUrl(mock, "9090/tcp");
    await waitForJson(`${mockBaseUrl}/control/state`, (value) => value.mode === "success");

    await startRuntime({ name: runtime, network, image });
    const runtimeBaseUrl = await publishedBaseUrl(runtime, "8080/tcp");
    const health = await waitForJson(
      `${runtimeBaseUrl}/healthz`,
      (value) => value.status === "ok",
    );
    const readiness = await waitForJson(
      `${runtimeBaseUrl}/readyz`,
      (value) =>
        value.status === "ready" &&
        value.execution_enabled === true &&
        /^[a-f0-9]{64}$/.test(value.runtime_build_id),
    );
    requireCondition(health.status === "ok", "runtime health probe failed");

    const probe = await postOperation(runtimeBaseUrl, "linux-health", "health_probe");
    requireResponse(probe, 200, "completed");

    await setMockMode(mockBaseUrl, "success");
    const completed = await postOperation(
      runtimeBaseUrl,
      "linux-provider-success",
      "chat_completions_canary",
    );
    requireResponse(completed, 200, "completed");
    requireCondition(completed.body.result?.object_version === "version-linux-gate", "result missing");
    let mockState = await getJson(`${mockBaseUrl}/control/state`);
    requireCondition(
      mockState.body.r2Calls === 1 && mockState.body.providerCalls === 1,
      "success must perform exactly one R2 read and one provider attempt",
    );

    await setMockMode(mockBaseUrl, "ambiguous");
    const ambiguous = await postOperation(
      runtimeBaseUrl,
      "linux-provider-ambiguous",
      "chat_completions_canary",
    );
    requireResponse(ambiguous, 202, "recovery_required", "ambiguous_execution");
    mockState = await getJson(`${mockBaseUrl}/control/state`);
    requireCondition(
      mockState.body.r2Calls === 2 && mockState.body.providerCalls === 2,
      "ambiguous execution must not retry the provider",
    );

    await setMockMode(mockBaseUrl, "input_hash_mismatch");
    const inputMismatch = await postOperation(
      runtimeBaseUrl,
      "linux-input-mismatch",
      "chat_completions_canary",
    );
    requireResponse(inputMismatch, 503, "rejected", "provider_input_unavailable");
    mockState = await getJson(`${mockBaseUrl}/control/state`);
    requireCondition(
      mockState.body.r2Calls === 3 && mockState.body.providerCalls === 2,
      "input mismatch must fail before provider dispatch",
    );

    await docker(["stop", "--time", "10", runtime], { timeoutMs: 30_000 });
    const stopped = await inspectContainer(runtime);
    requireCondition(stopped.State.ExitCode === 0, "SIGTERM shutdown must exit zero");
    await docker(["rm", runtime]);
    cleanupContainers.delete(runtime);

    await startRuntime({ name: restartedRuntime, network, image });
    const restartedBaseUrl = await publishedBaseUrl(restartedRuntime, "8080/tcp");
    const restartedReadiness = await waitForJson(
      `${restartedBaseUrl}/readyz`,
      (value) => value.status === "ready" && /^[a-f0-9]{64}$/.test(value.runtime_build_id),
    );
    requireCondition(
      restartedReadiness.runtime_build_id === readiness.runtime_build_id,
      "same image restart must retain runtime build identity",
    );

    return {
      contractVersion: LINUX_GATE_CONTRACT_VERSION,
      status: "passed",
      image,
      imageArchitecture: inspection.Architecture,
      imageUser: inspection.Config.User,
      runtimeBuildId: readiness.runtime_build_id,
      healthProbe: "passed",
      providerSuccessSingleAttempt: true,
      ambiguousExecutionNoRetry: true,
      inputHashMismatchFailClosed: true,
      gracefulSigtermExitZero: true,
      sameImageRestartIdentityStable: true,
      remoteMutationAuthorized: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    };
  } finally {
    for (const name of cleanupContainers) await dockerBestEffort(["rm", "--force", name]);
    if (networkCreated) await dockerBestEffort(["network", "rm", network]);
  }
}

async function inspectImage(image) {
  const value = await dockerJson(["image", "inspect", image]);
  requireCondition(Array.isArray(value) && value.length === 1, "image inspect must return one image");
  const inspection = value[0];
  requireCondition(
    inspection.Os === "linux" && inspection.Architecture === "amd64",
    "image must be linux/amd64",
  );
  requireCondition(inspection.Config?.User === "nonroot:nonroot", "image user must be nonroot");
  requireCondition(
    JSON.stringify(inspection.Config?.Entrypoint) ===
      JSON.stringify(["/usr/local/bin/cinatoken-container-runtime"]),
    "image entrypoint must be fixed",
  );
  requireCondition(
    Object.hasOwn(inspection.Config?.ExposedPorts ?? {}, "8080/tcp"),
    "image must expose 8080/tcp",
  );
  return inspection;
}

async function inspectContainer(name) {
  const value = await dockerJson(["container", "inspect", name]);
  requireCondition(Array.isArray(value) && value.length === 1, "container inspect failed");
  return value[0];
}

async function startMock({ name, network }) {
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--network-alias",
    "r2-input.cinatoken.internal",
    "--network-alias",
    "provider-egress.cinatoken.internal",
    "--user",
    "node",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "128m",
    "--pids-limit",
    "64",
    "--publish",
    "127.0.0.1::9090",
    "--env",
    `MOCK_INPUT_BASE64=${INPUT.toString("base64")}`,
    "--env",
    `MOCK_INPUT_SHA256=${INPUT_SHA256}`,
    "--mount",
    `type=bind,src=${MOCK_FIXTURE},dst=/app/mock.mjs,readonly`,
    NODE_MOCK_IMAGE,
    "node",
    "/app/mock.mjs",
  ]);
}

async function startRuntime({ name, network, image }) {
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "256m",
    "--pids-limit",
    "128",
    "--stop-timeout",
    "10",
    "--publish",
    "127.0.0.1::8080",
    "--env",
    "CINATOKEN_CONTAINER_PROVIDER_CLIENT_ENABLED=true",
    image,
  ]);
}

async function publishedBaseUrl(name, port) {
  const result = await docker(["port", name, port]);
  const match = result.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/m);
  requireCondition(match !== null, `container ${name} has no loopback published port`);
  return `http://127.0.0.1:${match[1]}`;
}

async function setMockMode(baseUrl, mode) {
  const result = await getJson(`${baseUrl}/control/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  requireCondition(result.status === 200 && result.body.mode === mode, "mock mode update failed");
}

async function postOperation(baseUrl, operationId, kind) {
  return await getJson(`${baseUrl}/v1/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-container-protocol": "1",
    },
    body: JSON.stringify(buildOperationEnvelope({ operationId, kind })),
  });
}

function requireResponse(response, expectedStatus, expectedOutcome, expectedCode = null) {
  requireCondition(response.status === expectedStatus, `unexpected HTTP status ${response.status}`);
  requireCondition(response.body.status === expectedOutcome, "unexpected operation outcome");
  if (expectedCode !== null) requireCondition(response.body.code === expectedCode, "unexpected code");
}

async function waitForJson(url, predicate) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await getJson(url);
      if (response.status === 200 && predicate(response.body)) return response.body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? "not ready"}`);
}

async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3_000) });
  const text = await response.text();
  requireCondition(text.length <= 64 * 1024, "HTTP response exceeds gate limit");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("HTTP response is not JSON");
  }
  return { status: response.status, body };
}

async function dockerJson(args) {
  const result = await docker(args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("docker returned invalid JSON");
  }
}

async function docker(args, { timeoutMs = 60_000 } = {}) {
  const result = await runBoundedSubprocess("docker", args, {
    cwd: ROOT,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
    killGraceMs: 2_000,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.outputLimitExceeded ||
    result.invalidUtf8
  ) {
    throw new Error(`docker ${args[0] ?? "command"} failed closed`);
  }
  return result;
}

async function dockerBestEffort(args) {
  await runBoundedSubprocess("docker", args, {
    cwd: ROOT,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    killGraceMs: 2_000,
  });
}

function validImageReference(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("-") &&
    /^[!-~]+$/.test(value)
  );
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.selfTest
    ? await auditRepositoryContract()
    : await runLinuxGate(options.image);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`container runtime linux gate: ${report.status}\n`);
  }
}

const directInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directInvocation) {
  main().catch((error) => {
    process.stderr.write(
      `container runtime linux gate failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
