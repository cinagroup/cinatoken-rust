import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runBoundedSubprocess } from "./lib/bounded_subprocess.mjs";

export const LINUX_GATE_CONTRACT_VERSION = 2;
export const RUNTIME_ATTESTATION_CONTRACT_VERSION = 1;
export const RUNTIME_UID = 65_532;
export const RUNTIME_GID = 65_532;
export const RUST_BUILDER_IMAGE =
  "rust:1.78.0-bookworm@sha256:5907e96b0293eb53bcc8f09b4883d71449808af289862950ede9a0e3cca44ff5";
export const DISTROLESS_RUNTIME_IMAGE =
  "gcr.io/distroless/cc-debian12:nonroot@sha256:66aa873a4a14fb164aa01296058efd8253744606d72715e45acface073359faa";
export const NODE_MOCK_IMAGE =
  "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
export const CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
export const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCKERFILE = resolve(ROOT, "crates/container-runtime/Dockerfile");
const RUNTIME_MAIN = resolve(ROOT, "crates/container-runtime/src/main.rs");
const RUNTIME_ATTESTATION = resolve(
  ROOT,
  "crates/container-runtime/src/attestation.rs",
);
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
const RUNTIME_TMPFS_OPTIONS = new Set([
  "rw",
  "noexec",
  "nosuid",
  "nodev",
  "size=16m",
  "mode=0700",
  `uid=${RUNTIME_UID}`,
  `gid=${RUNTIME_GID}`,
]);
const WRITABLE_MOUNT_ALLOWLIST = new Set([
  "/dev",
  "/dev/mqueue",
  "/dev/pts",
  "/dev/shm",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/proc",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/tmp",
]);

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
  const [
    dockerfile,
    runtimeMain,
    runtimeAttestation,
    workflow,
    mockFixture,
    probeFixture,
    packageJsonText,
    verifier,
  ] = await Promise.all([
      readFile(DOCKERFILE, "utf8"),
      readFile(RUNTIME_MAIN, "utf8"),
      readFile(RUNTIME_ATTESTATION, "utf8"),
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
      dockerfile.includes("\nWORKDIR /\n") &&
      dockerfile.includes(
        "COPY --from=builder --chown=0:0 --chmod=0755 /build/target/release/cinatoken-container-runtime /usr/local/bin/cinatoken-container-runtime",
      ) &&
      dockerfile.includes("ENTRYPOINT [\"/usr/local/bin/cinatoken-container-runtime\"]"),
    "Dockerfile must retain the root-owned binary, fixed working directory, and non-root entrypoint",
  );
  requireCondition(
    runtimeMain.includes('"--runtime-attestation-v1"') &&
      runtimeMain.includes('"unsupported container runtime argument"') &&
      runtimeAttestation.includes('format!("/proc/{TARGET_PID}")') &&
      runtimeAttestation.includes("libc::listxattr") &&
      !runtimeAttestation.includes("TcpListener") &&
      !runtimeAttestation.includes("axum"),
    "runtime attestation must remain a fixed read-only non-HTTP subcommand",
  );
  requireCondition(
    workflow.includes(`uses: ${CHECKOUT_ACTION}`) &&
      workflow.includes(`uses: ${UPLOAD_ARTIFACT_ACTION}`) &&
      workflow.includes("persist-credentials: false") &&
      workflow.includes("docker build --platform linux/amd64") &&
      workflow.includes("node tools/verify_container_runtime_linux.mjs") &&
      workflow.includes("--image cinatoken-container-runtime:linux-gate") &&
      workflow.includes("container-runtime-linux-attestation.json") &&
      workflow.includes("retention-days: 30"),
    "workflow must use pinned actions, execute the real linux/amd64 gate, and retain attestation",
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
      mockFixture.includes("input_hash_mismatch") &&
      mockFixture.includes('server.listen(80, "0.0.0.0")'),
    "mock must expose the fixed internal HTTP contracts on port 80",
  );
  requireCondition(
    probeFixture.includes("http://runtime.cinatoken.internal:8080") &&
      probeFixture.includes('MOCK_BASE_URL = "http://127.0.0.1"') &&
      probeFixture.includes('probeMode === "restart"'),
    "probe must exercise the runtime entirely inside the isolated network",
  );
  requireCondition(
    verifier.includes('"network", "create", "--internal"') &&
      verifier.includes('"r2-input.cinatoken.internal"') &&
      verifier.includes('"provider-egress.cinatoken.internal"') &&
      verifier.includes('"runtime.cinatoken.internal"') &&
      verifier.includes('"net.ipv4.ip_unprivileged_port_start=0"') &&
      verifier.includes('"exec"') &&
      verifier.includes('"--runtime-attestation-v1"') &&
      verifier.includes("/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532") &&
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
    runtimeAttestationCompiled: true,
    runtimeAttestationHttpExposed: false,
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
    const primaryAttestation = await attestRuntime({
      name: runtime,
      network,
    });

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
    const restartedAttestation = await attestRuntime({
      name: restartedRuntime,
      network,
    });
    requireCondition(
      restartedAttestation.policySha256 === primaryAttestation.policySha256,
      "same image restart must retain the runtime policy identity",
    );

    return {
      contractVersion: LINUX_GATE_CONTRACT_VERSION,
      status: "passed",
      image,
      imageId: inspection.Id,
      imageArchitecture: inspection.Architecture,
      imageUser: inspection.Config.User,
      imageRootfsLayers: inspection.RootFS.Layers,
      runtimeBuildId: primaryProbe.runtimeBuildId,
      runtimePolicySha256: primaryAttestation.policySha256,
      runtimeAttestation: primaryAttestation.report,
      restartRuntimeAttestation: {
        targetPid: restartedAttestation.report.process.targetPid,
        fileDescriptorCount:
          restartedAttestation.report.fileDescriptors.observedCount,
        policySha256: restartedAttestation.policySha256,
      },
      healthProbe: "passed",
      providerSuccessSingleAttempt: true,
      ambiguousExecutionNoRetry: true,
      inputHashMismatchFailClosed: true,
      gracefulSigtermExitZero: true,
      sameImageRestartIdentityStable: true,
      sameImageRestartPolicyStable: true,
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
  requireCondition(
    /^sha256:[a-f0-9]{64}$/.test(inspection.Id) &&
      Array.isArray(inspection.RootFS?.Layers) &&
      inspection.RootFS.Layers.length > 0 &&
      inspection.RootFS.Layers.every((layer) => /^sha256:[a-f0-9]{64}$/.test(layer)),
    "image identity and rootfs layer identities must be complete",
  );
  requireCondition(inspection.Config?.User === "nonroot:nonroot", "image user must be nonroot");
  requireCondition(inspection.Config?.WorkingDir === "/", "image working directory must be fixed");
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

async function attestRuntime({ name, network }) {
  const inspection = await inspectContainer(name);
  const container = validateContainerPolicy(inspection, network);
  const result = await docker([
    "exec",
    name,
    "/usr/local/bin/cinatoken-container-runtime",
    "--runtime-attestation-v1",
  ]);
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new Error("runtime process attestation returned invalid JSON");
  }
  const observed = validateRuntimeProcessAttestation(raw);
  const policy = {
    contract: "cinatoken-container-runtime-policy-v1",
    container,
    processSecurity: observed.processSecurity,
    filesystem: observed.filesystem,
    fileDescriptorPolicy: observed.fileDescriptors.policy,
  };
  const policySha256 = createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex");

  return {
    policySha256,
    report: {
      contractVersion: RUNTIME_ATTESTATION_CONTRACT_VERSION,
      contract: "cinatoken-container-runtime-linux-attestation-v1",
      container,
      process: observed.process,
      processSecurity: observed.processSecurity,
      filesystem: observed.filesystem,
      fileDescriptors: observed.fileDescriptors,
      policySha256,
    },
  };
}

export function validateContainerPolicy(inspection, network) {
  const host = requireObject(inspection.HostConfig, "container HostConfig");
  const state = requireObject(inspection.State, "container State");
  requireCondition(state.Running === true, "attested runtime must be running");
  requireCondition(
    Number.isSafeInteger(state.Pid) && state.Pid > 0,
    "attested runtime must have one positive host PID",
  );
  requireCondition(host.Privileged === false, "runtime must not be privileged");
  requireCondition(host.ReadonlyRootfs === true, "runtime rootfs must be read-only");
  requireCondition(
    JSON.stringify(host.CapDrop) === JSON.stringify(["ALL"]),
    "runtime must drop every Linux capability",
  );
  requireCondition(
    Array.isArray(host.SecurityOpt) &&
      host.SecurityOpt.some((option) =>
        /^no-new-privileges(?::true)?$/.test(option),
      ),
    "runtime must enable no-new-privileges",
  );
  requireCondition(host.Memory === 256 * 1024 * 1024, "runtime memory limit drifted");
  requireCondition(host.PidsLimit === 128, "runtime PID limit drifted");
  requireCondition(
    host.NetworkMode === network &&
      host.PublishAllPorts === false &&
      Object.keys(host.PortBindings ?? {}).length === 0,
    "runtime network must remain internal without published host ports",
  );
  requireCondition(
    emptyArray(host.Binds) &&
      emptyArray(host.Devices) &&
      emptyArray(host.DeviceRequests) &&
      emptyArray(host.Mounts),
    "runtime must not receive bind, volume, device, or caller-selected mounts",
  );

  const tmpfs = requireObject(host.Tmpfs, "runtime tmpfs policy");
  requireCondition(
    Object.keys(tmpfs).length === 1 && typeof tmpfs["/tmp"] === "string",
    "runtime must expose only the private /tmp tmpfs",
  );
  const tmpfsOptions = new Set(tmpfs["/tmp"].split(","));
  requireCondition(
    equalStringSets(tmpfsOptions, RUNTIME_TMPFS_OPTIONS),
    "runtime /tmp options drifted",
  );

  requireCondition(
    Array.isArray(inspection.Mounts),
    "runtime inspect mount inventory must be present",
  );
  const mounts = inspection.Mounts;
  requireCondition(
    mounts.length <= 1 &&
      mounts.every(
        (mount) =>
          mount?.Type === "tmpfs" &&
          mount?.Destination === "/tmp" &&
          mount?.RW === true,
      ),
    "runtime inspect must not expose a mount beyond the private /tmp tmpfs",
  );

  return {
    privileged: false,
    readOnlyRootfs: true,
    capabilityDrop: ["ALL"],
    noNewPrivilegesRequested: true,
    memoryBytes: host.Memory,
    pidsLimit: host.PidsLimit,
    internalNetworkOnly: true,
    hostPortsPublished: false,
    bindMountsPresent: false,
    devicesPresent: false,
    tmpfs: {
      path: "/tmp",
      options: [...tmpfsOptions].sort(),
    },
  };
}

export function validateRuntimeProcessAttestation(value) {
  const raw = requireObject(value, "runtime process attestation");
  requireCondition(
    raw.schemaVersion === RUNTIME_ATTESTATION_CONTRACT_VERSION &&
      raw.contract === "cinatoken-container-runtime-process-attestation-v1" &&
      raw.targetPid === 1,
    "runtime process attestation identity drifted",
  );
  const status = requireObject(raw.status, "runtime process status");
  const uid = parseStatusIntegerList(status.Uid, 4, "Uid");
  const gid = parseStatusIntegerList(status.Gid, 4, "Gid");
  const groups = parseStatusIntegerList(status.Groups, null, "Groups");
  requireCondition(
    uid.every((value) => value === RUNTIME_UID) &&
      gid.every((value) => value === RUNTIME_GID) &&
      (groups.length === 0 ||
        (groups.length === 1 && groups[0] === RUNTIME_GID)),
    "runtime numeric user or group identity drifted",
  );
  requireCondition(
    typeof status.Name === "string" &&
      status.Name.length > 0 &&
      typeof status.State === "string" &&
      status.State.length > 0 &&
      status.Pid === "1" &&
      status.Tgid === "1" &&
      status.PPid === "0" &&
      status.TracerPid === "0",
    "runtime PID or tracer identity drifted",
  );

  const capabilities = {};
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    requireCondition(
      typeof status[field] === "string" &&
        /^[0-9a-fA-F]{16}$/.test(status[field]) &&
        BigInt(`0x${status[field]}`) === 0n,
      `${field} must be zero`,
    );
    capabilities[field] = status[field].toLowerCase();
  }
  const noNewPrivileges = parseSingleStatusInteger(status.NoNewPrivs, "NoNewPrivs");
  const seccompMode = parseSingleStatusInteger(status.Seccomp, "Seccomp");
  const seccompFilters = parseSingleStatusInteger(
    status.Seccomp_filters,
    "Seccomp_filters",
  );
  requireCondition(noNewPrivileges === 1, "NoNewPrivs must be enabled");
  requireCondition(seccompMode === 2, "runtime must use seccomp filter mode");
  requireCondition(seccompFilters >= 1, "runtime must install a seccomp filter");

  const links = requireObject(raw.links, "runtime process links");
  requireCondition(
    links.cwd === "/" &&
      links.root === "/" &&
      links.executable === "/usr/local/bin/cinatoken-container-runtime",
    "runtime cwd, root, or executable identity drifted",
  );

  const filesystem = validateFilesystemAttestation(raw);
  const fileDescriptors = validateFileDescriptorAttestation(raw.fileDescriptors);

  return {
    process: {
      targetPid: raw.targetPid,
      name: status.Name,
      state: status.State,
      uid,
      gid,
      supplementaryGroups: groups,
      cwd: links.cwd,
      executable: links.executable,
    },
    processSecurity: {
      tracerPid: 0,
      noNewPrivileges,
      seccompMode,
      seccompFilters,
      capabilities,
    },
    filesystem,
    fileDescriptors,
  };
}

function validateFilesystemAttestation(raw) {
  const mounts = parseLinuxMountInfo(raw.mountInfo);
  const root = mounts.find((entry) => entry.mountPoint === "/");
  const tmp = mounts.find((entry) => entry.mountPoint === "/tmp");
  requireCondition(root !== undefined, "runtime root mount was not reported");
  requireCondition(
    root.fileSystemType === "overlay" && root.mountOptions.includes("ro"),
    "runtime application root must be a read-only overlay mount",
  );
  requireCondition(tmp !== undefined, "runtime /tmp mount was not reported");
  const tmpOptions = new Set([...tmp.mountOptions, ...tmp.superOptions]);
  for (const option of [
    "rw",
    "noexec",
    "nosuid",
    "nodev",
    "mode=700",
    `uid=${RUNTIME_UID}`,
    `gid=${RUNTIME_GID}`,
  ]) {
    requireCondition(tmpOptions.has(option), `runtime /tmp omitted ${option}`);
  }
  const sizeOption = [...tmpOptions].find((option) => option.startsWith("size="));
  requireCondition(
    parseLinuxSizeOption(sizeOption) === 16 * 1024 * 1024,
    "runtime /tmp size drifted",
  );

  const writableMountPoints = mounts
    .filter((entry) => entry.mountOptions.includes("rw"))
    .map((entry) => entry.mountPoint)
    .sort();
  requireCondition(
    writableMountPoints.every((path) => WRITABLE_MOUNT_ALLOWLIST.has(path)),
    "runtime exposed an unexpected writable mount",
  );
  requireCondition(
    !writableMountPoints.some(
      (path) =>
        path === "/usr" ||
        path.startsWith("/usr/") ||
        path === "/opt" ||
        path.startsWith("/opt/") ||
        path === "/app" ||
        path.startsWith("/app/"),
    ),
    "runtime application layout must not contain writable mounts",
  );

  const paths = validatePathAttestations(raw.paths);
  return {
    rootMount: normalizedMount(root),
    tmpMount: normalizedMount(tmp),
    writableMountPoints,
    writableMountAllowlist: [...WRITABLE_MOUNT_ALLOWLIST].sort(),
    unexpectedWritableMounts: [],
    paths,
  };
}

function validatePathAttestations(value) {
  requireCondition(Array.isArray(value), "runtime path attestations must be an array");
  const paths = new Map();
  for (const entry of value) {
    const path = requireObject(entry, "runtime path attestation");
    requireCondition(
      typeof path.path === "string" && !paths.has(path.path),
      "runtime path attestations must have unique paths",
    );
    requireCondition(
      path.posixAclAccess === false && path.posixAclDefault === false,
      "runtime path must not have POSIX ACL overrides",
    );
    paths.set(path.path, path);
  }
  const expected = new Map([
    ["/", ["directory", 0, 0, "0755"]],
    ["/usr", ["directory", 0, 0, "0755"]],
    ["/usr/local", ["directory", 0, 0, "0755"]],
    ["/usr/local/bin", ["directory", 0, 0, "0755"]],
    ["/tmp", ["directory", RUNTIME_UID, RUNTIME_GID, "0700"]],
    [
      "/usr/local/bin/cinatoken-container-runtime",
      ["file", 0, 0, "0755"],
    ],
  ]);
  requireCondition(paths.size === expected.size, "runtime path inventory drifted");
  const report = [];
  for (const [path, [fileType, uid, gid, mode]] of expected) {
    const observed = paths.get(path);
    requireCondition(observed !== undefined, `runtime path inventory omitted ${path}`);
    requireCondition(
      observed.fileType === fileType &&
        observed.uid === uid &&
        observed.gid === gid &&
        observed.mode === mode &&
        Number.isSafeInteger(observed.linkCount) &&
        observed.linkCount > 0 &&
        Number.isSafeInteger(observed.size) &&
        observed.size >= 0,
      `runtime path metadata drifted for ${path}`,
    );
    if (fileType === "file") {
      requireCondition(observed.size > 0, "runtime executable must not be empty");
    }
    report.push({
      path,
      fileType,
      uid,
      gid,
      mode,
      linkCount: observed.linkCount,
      size: observed.size,
      posixAclAccess: false,
      posixAclDefault: false,
    });
  }
  return report;
}

function validateFileDescriptorAttestation(value) {
  requireCondition(
    Array.isArray(value) && value.length >= 4 && value.length <= 64,
    "runtime file descriptor inventory is outside its bound",
  );
  const descriptors = [...value].sort((left, right) => left.fd - right.fd);
  const seen = new Set();
  const classCounts = {};
  for (const descriptor of descriptors) {
    const entry = requireObject(descriptor, "runtime file descriptor");
    requireCondition(
      Number.isSafeInteger(entry.fd) &&
        entry.fd >= 0 &&
        !seen.has(entry.fd) &&
        typeof entry.target === "string",
      "runtime file descriptor identity drifted",
    );
    seen.add(entry.fd);
    const targetClass = classifyRuntimeFileDescriptorTarget(entry.target);
    requireCondition(
      targetClass !== "unexpected",
      "runtime inherited an unexpected path-backed file descriptor",
    );
    classCounts[targetClass] = (classCounts[targetClass] ?? 0) + 1;
  }
  const byFd = new Map(descriptors.map((entry) => [entry.fd, entry.target]));
  requireCondition(byFd.get(0) === "/dev/null", "runtime stdin must be /dev/null");
  requireCondition(
    /^pipe:\[[0-9]+\]$/.test(byFd.get(1) ?? "") &&
      /^pipe:\[[0-9]+\]$/.test(byFd.get(2) ?? ""),
    "runtime stdout and stderr must be isolated pipes",
  );
  requireCondition(
    (classCounts.socket ?? 0) >= 1 && (classCounts.eventpoll ?? 0) >= 1,
    "runtime descriptor inventory must include its listener and event loop",
  );

  return {
    observedCount: descriptors.length,
    classCounts: Object.fromEntries(
      Object.entries(classCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    standardDescriptors: {
      stdin: "dev-null",
      stdout: "pipe",
      stderr: "pipe",
    },
    unexpectedPathBackedTargets: [],
    policy: {
      maximumDescriptors: 64,
      allowedTargetClasses: [
        "dev-null",
        "eventfd",
        "eventpoll",
        "pipe",
        "socket",
        "timerfd",
      ],
      unexpectedPathBackedTargetsAllowed: false,
    },
  };
}

export function classifyRuntimeFileDescriptorTarget(target) {
  if (target === "/dev/null") return "dev-null";
  if (/^pipe:\[[0-9]+\]$/.test(target)) return "pipe";
  if (/^socket:\[[0-9]+\]$/.test(target)) return "socket";
  if (target === "anon_inode:[eventpoll]") return "eventpoll";
  if (target === "anon_inode:[eventfd]") return "eventfd";
  if (target === "anon_inode:[timerfd]") return "timerfd";
  return "unexpected";
}

export function parseLinuxMountInfo(value) {
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= 1024 * 1024,
    "runtime mountinfo is invalid",
  );
  const entries = value
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.trim().split(" ");
      const separator = fields.indexOf("-");
      requireCondition(
        separator >= 6 && fields.length >= separator + 4,
        "runtime mountinfo line is malformed",
      );
      return {
        mountPoint: decodeMountInfoPath(fields[4]),
        mountOptions: fields[5].split(",").sort(),
        optionalFields: fields.slice(6, separator).sort(),
        fileSystemType: fields[separator + 1],
        mountSource: decodeMountInfoPath(fields[separator + 2]),
        superOptions: fields[separator + 3].split(",").sort(),
      };
    });
  requireCondition(entries.length > 0, "runtime mountinfo was empty");
  return entries;
}

function normalizedMount(value) {
  return {
    mountPoint: value.mountPoint,
    fileSystemType: value.fileSystemType,
    mountSource: value.mountSource,
    mountOptions: value.mountOptions,
    superOptions: value.superOptions.filter(
      (option) => !/^(?:lowerdir|upperdir|workdir)=/.test(option),
    ),
  };
}

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseLinuxSizeOption(value) {
  if (typeof value !== "string") return null;
  const match = /^size=([1-9][0-9]*)([kKmMgG]?)$/.exec(value);
  if (match === null) return null;
  const multiplier = {
    "": 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  }[match[2].toLowerCase()];
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

function parseStatusIntegerList(value, expectedLength, label) {
  if (expectedLength === null && value === "") return [];
  requireCondition(
    typeof value === "string" && /^[0-9]+(?:\s+[0-9]+)*$/.test(value),
    `runtime ${label} is malformed`,
  );
  const values = value.split(/\s+/).map(Number);
  requireCondition(
    values.every(Number.isSafeInteger) &&
      (expectedLength === null || values.length === expectedLength),
    `runtime ${label} has an invalid shape`,
  );
  return values;
}

function parseSingleStatusInteger(value, label) {
  const values = parseStatusIntegerList(value, 1, label);
  return values[0];
}

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function emptyArray(value) {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function equalStringSets(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
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
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
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
    "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532",
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
    throw new Error(
      `docker ${args[0] ?? "command"} failed closed: ${formatSubprocessFailure(result)}`,
    );
  }
  return result;
}

function formatSubprocessFailure(result) {
  if (result.timedOut) return "timeout";
  if (result.outputLimitExceeded) return "output limit exceeded";
  if (result.invalidUtf8) return "invalid UTF-8 output";
  if (result.terminationReason === "spawn-error") return "spawn error";
  const output = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .replace(/[^\x20-\x7e\n]/g, "?")
    .trim()
    .slice(0, 4_096);
  return output.length > 0
    ? `exit ${result.exitCode}: ${output}`
    : `exit ${result.exitCode}`;
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
