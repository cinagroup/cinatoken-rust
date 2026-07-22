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
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCKERFILE = resolve(ROOT, "crates/container-runtime/Dockerfile");
const WORKFLOW = resolve(ROOT, ".github/workflows/container-runtime-linux.yml");
const MOCK_FIXTURE = resolve(ROOT, "tests/fixtures/container-runtime-linux-mock.mjs");
const PROBE_FIXTURE = resolve(ROOT, "tests/fixtures/container-runtime-linux-probe.mjs");
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
  const [dockerfile, workflow, mockFixture, probeFixture, packageJsonText, verifier] =
    await Promise.all([
      readFile(DOCKERFILE, "utf8"),
      readFile(WORKFLOW, "utf8"),
      readFile(MOCK_FIXTURE, "utf8"),
      readFile(PROBE_FIXTURE, "utf8"),
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
    probeFixture.includes("http://runtime.cinatoken.internal:8080") &&
      probeFixture.includes("http://127.0.0.1:9090") &&
      probeFixture.includes('probeMode === "restart"'),
    "probe must exercise the runtime entirely inside the isolated network",
  );
  requireCondition(
    verifier.includes('"network", "create", "--internal"') &&
      verifier.includes('"r2-input.cinatoken.internal"') &&
      verifier.includes('"provider-egress.cinatoken.internal"') &&
      verifier.includes('"runtime.cinatoken.internal"') &&
      verifier.includes('"exec"') &&
      ![
        ["--", "privileged"].join(""),
        ["docker", ".sock"].join(""),
        ["--", "publish"].join(""),
        ['"', ["ho", "st"].join(""), '"'].join(""),
      ].some((fragment) => verifier.includes(fragment)),
    "real gate must use an in-network probe without host ports or privileged access",
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
    inNetworkProbe: true,
    hostPortsPublished: false,
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
    await startRuntime({ name: runtime, network, image });
    const primaryProbe = await runProbe(mock, "primary");

    await docker(["stop", "--time", "10", runtime], { timeoutMs: 30_000 });
    const stopped = await inspectContainer(runtime);
    requireCondition(stopped.State.ExitCode === 0, "SIGTERM shutdown must exit zero");
    await docker(["rm", runtime]);
    cleanupContainers.delete(runtime);

    await startRuntime({ name: restartedRuntime, network, image });
    const restartedProbe = await runProbe(
      mock,
      "restart",
      primaryProbe.runtimeBuildId,
    );
    requireCondition(
      restartedProbe.runtimeBuildId === primaryProbe.runtimeBuildId,
      "same image restart must retain runtime build identity",
    );

    return {
      contractVersion: LINUX_GATE_CONTRACT_VERSION,
      status: "passed",
      image,
      imageArchitecture: inspection.Architecture,
      imageUser: inspection.Config.User,
      runtimeBuildId: primaryProbe.runtimeBuildId,
      healthProbe: "passed",
      providerSuccessSingleAttempt: true,
      ambiguousExecutionNoRetry: true,
      inputHashMismatchFailClosed: true,
      gracefulSigtermExitZero: true,
      sameImageRestartIdentityStable: true,
      inNetworkProbe: true,
      hostPortsPublished: false,
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
    "--env",
    `MOCK_INPUT_BASE64=${INPUT.toString("base64")}`,
    "--env",
    `MOCK_INPUT_SHA256=${INPUT_SHA256}`,
    "--mount",
    `type=bind,src=${MOCK_FIXTURE},dst=/app/mock.mjs,readonly`,
    "--mount",
    `type=bind,src=${PROBE_FIXTURE},dst=/app/probe.mjs,readonly`,
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
    "--network-alias",
    "runtime.cinatoken.internal",
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
    "--env",
    "CINATOKEN_CONTAINER_PROVIDER_CLIENT_ENABLED=true",
    image,
  ]);
}

async function runProbe(mockContainer, mode, expectedRuntimeBuildId = null) {
  const args = ["exec", "--env", `PROBE_MODE=${mode}`];
  if (expectedRuntimeBuildId !== null) {
    args.push("--env", `EXPECTED_RUNTIME_BUILD_ID=${expectedRuntimeBuildId}`);
  }
  args.push(mockContainer, "node", "/app/probe.mjs");
  const result = await docker(args, { timeoutMs: 30_000 });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("in-network probe returned invalid JSON");
  }
  requireCondition(
    report?.status === "passed" && /^[a-f0-9]{64}$/.test(report.runtimeBuildId),
    "in-network probe report is incomplete",
  );
  return report;
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
