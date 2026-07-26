import { describe, expect, test } from "bun:test";

import { runBoundedSubprocess } from "../tools/lib/bounded_subprocess.mjs";
import {
  CHECKOUT_ACTION,
  DISTROLESS_RUNTIME_IMAGE,
  LINUX_GATE_CONTRACT_VERSION,
  NODE_MOCK_IMAGE,
  RUST_BUILDER_IMAGE,
  RUNTIME_ATTESTATION_CONTRACT_VERSION,
  RUNTIME_GID,
  RUNTIME_UID,
  SOURCE_DATE_EPOCH,
  UPLOAD_ARTIFACT_ACTION,
  auditRepositoryContract,
  buildOperationEnvelope,
  classifyRuntimeFileDescriptorTarget,
  parseLinuxMountInfo,
  parseArgs,
  validateContainerPolicy,
  validateReproducibleImages,
  validateRuntimeProcessAttestation,
} from "../tools/verify_container_runtime_linux.mjs";

const dockerfile = await Bun.file(
  new URL("../crates/container-runtime/Dockerfile", import.meta.url),
).text();
const workflow = await Bun.file(
  new URL("../.github/workflows/container-runtime-linux.yml", import.meta.url),
).text();
const probeSource = await Bun.file(
  new URL("./fixtures/container-runtime-linux-probe.mjs", import.meta.url),
).text();
const verifierSource = await Bun.file(
  new URL("../tools/verify_container_runtime_linux.mjs", import.meta.url),
).text();
const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

describe("linux container release gate", () => {
  test("pins the complete image and workflow supply chain", async () => {
    expect(dockerfile.match(/^FROM .+$/gm)).toEqual([
      `FROM ${RUST_BUILDER_IMAGE} AS builder`,
      `FROM ${DISTROLESS_RUNTIME_IMAGE}`,
    ]);
    expect(workflow).toContain(`uses: ${CHECKOUT_ACTION}`);
    expect(workflow).toContain(`uses: ${UPLOAD_ARTIFACT_ACTION}`);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(
      workflow.match(/docker buildx build --no-cache --platform linux\/amd64/g),
    ).toHaveLength(2);
    expect(workflow.match(/--build-arg SOURCE_DATE_EPOCH=0/g)).toHaveLength(2);
    expect(
      workflow.match(/--output type=image,rewrite-timestamp=true/g),
    ).toHaveLength(2);
    expect(workflow).toContain("tests/fixtures/container-runtime-linux-probe.mjs");
    expect(workflow).toContain("node tools/verify_container_runtime_linux.mjs");
    expect(workflow).toContain("--image cinatoken-container-runtime:linux-gate-a");
    expect(workflow).toContain(
      "--reproducible-image cinatoken-container-runtime:linux-gate-b",
    );
    expect(workflow).toContain("container-runtime-linux-image-a.json");
    expect(workflow).toContain("container-runtime-linux-image-b.json");
    expect(workflow).toContain("container-runtime-linux-binary-sha256.log");
    expect(workflow).toContain(
      '"${container_id}:/usr/local/bin/cinatoken-container-runtime"',
    );
    expect(workflow).toContain("container-runtime-linux-attestation.json");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\.|wrangler|cloudflare api/i);
    expect(dockerfile).toContain("\nWORKDIR /\n");
    expect(dockerfile).toStartWith(`ARG SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}\n`);
    expect(dockerfile).toContain("CARGO_BUILD_TARGET=x86_64-unknown-linux-musl");
    expect(dockerfile).toContain(
      "readelf -l /build/target/x86_64-unknown-linux-musl/release/cinatoken-container-runtime",
    );
    expect(dockerfile).toContain(
      "! grep -q INTERP /tmp/cinatoken-container-runtime-program-headers",
    );
    expect(dockerfile).not.toContain("RUSTFLAGS=");
    expect(dockerfile).toContain(
      "install -D -m 0755 /build/target/x86_64-unknown-linux-musl/release/cinatoken-container-runtime",
    );
    expect(dockerfile).toContain(
      'find /runtime-root -exec touch -d "@${SOURCE_DATE_EPOCH}" {} +',
    );
    expect(dockerfile).toContain(
      "COPY --from=builder --chown=0:0 /runtime-root/ /",
    );
    expect(verifierSource).toContain(NODE_MOCK_IMAGE);
    expect(verifierSource).toContain('"network", "create", "--internal"');
    expect(verifierSource).toContain('"r2-input.cinatoken.internal"');
    expect(verifierSource).toContain('"provider-egress.cinatoken.internal"');
    expect(verifierSource).toContain('"runtime.cinatoken.internal"');
    expect(verifierSource).toContain('"exec"');
    expect(verifierSource).toContain('"--runtime-attestation-v1"');
    expect(verifierSource).toContain(
      "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532",
    );
    expect(probeSource).toContain("http://runtime.cinatoken.internal:8080");
    expect(probeSource).toContain('MOCK_BASE_URL = "http://127.0.0.1"');
    for (const fragment of [
      ["--", "privileged"].join(""),
      ["docker", ".sock"].join(""),
      ["--", "publish"].join(""),
      ['"', ["ho", "st"].join(""), '"'].join(""),
    ]) {
      expect(verifierSource).not.toContain(fragment);
    }
  });

  test("keeps the local aggregate credential-free and Docker-independent", () => {
    expect(packageJson.scripts.check).toContain("check:container-runtime:linux-contract");
    expect(packageJson.scripts["check:container-runtime:linux-contract"]).toContain(
      '--path-ignore-patterns="target/**"',
    );
    expect(packageJson.scripts["check:container-runtime:linux-contract"]).toContain("--self-test");
    expect(packageJson.scripts["check:container-runtime:linux"]).toContain("--image");
    expect(packageJson.scripts["check:container-runtime:linux"]).toContain(
      "--reproducible-image",
    );
    expect(packageJson.scripts.check).not.toContain("check:container-runtime:linux &&");
  });

  test("builds owner-fenced operation envelopes without remote authority", () => {
    const operation = buildOperationEnvelope({
      operationId: "linux-contract-test",
      kind: "chat_completions_canary",
      now: 1_000,
    });
    expect(operation.owner_generation).toBe(1);
    expect(operation.execution_deadline_at).toBe(1_060);
    expect(operation.owner_lease_expires_at).toBe(1_120);
    expect(operation.input.mode).toBe("r2");
    expect(operation.input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.shard).toEqual({
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    });
    expect(operation.trace_id).toBe(operation.operation_id);
  });

  test("rejects ambiguous command-line modes", () => {
    expect(parseArgs(["--self-test", "--json"])).toEqual({
      selfTest: true,
      image: null,
      reproducibleImage: null,
      json: true,
    });
    expect(
      parseArgs([
        "--image",
        "runtime:test-a",
        "--reproducible-image",
        "runtime:test-b",
      ]),
    ).toEqual({
      selfTest: false,
      image: "runtime:test-a",
      reproducibleImage: "runtime:test-b",
      json: false,
    });
    expect(() => parseArgs([])).toThrow("select --self-test");
    expect(() => parseArgs(["--image", "runtime:test"])).toThrow(
      "both --image",
    );
    expect(() =>
      parseArgs([
        "--self-test",
        "--image",
        "runtime:test-a",
        "--reproducible-image",
        "runtime:test-b",
      ]),
    ).toThrow(
      "select --self-test",
    );
    expect(() =>
      parseArgs([
        "--image",
        "--bad",
        "--reproducible-image",
        "runtime:test-b",
      ]),
    ).toThrow("must not start");
    expect(() => parseArgs(["--unknown"])).toThrow("unknown argument");
  });

  test("self-test proves only the offline contract", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
      contractVersion: LINUX_GATE_CONTRACT_VERSION,
      status: "passed",
      dockerfileBaseImagesPinned: true,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      independentImageBuildsRequired: 2,
      imageLayerTimestampsRewritten: true,
      runtimeRootMetadataNormalized: true,
      independentImageInspectionsRetained: true,
      independentBinaryHashesRetained: true,
      reproducibleImageGate: true,
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
    });

    const command = await runBoundedSubprocess(
      "node",
      ["tools/verify_container_runtime_linux.mjs", "--self-test", "--json"],
      { timeoutMs: 10_000 },
    );
    expect(command.exitCode).toBe(0);
    expect(command.timedOut).toBe(false);
    expect(command.outputLimitExceeded).toBe(false);
    expect(JSON.parse(command.stdout)).toEqual(report);
  });

  test("requires exact identity across independent image builds", () => {
    const primary = imageInspection("a");
    const secondary = imageInspection("a");
    expect(validateReproducibleImages(primary, secondary)).toEqual({
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      independentBuilds: 2,
      imageId: `sha256:${"a".repeat(64)}`,
      rootfsLayerCount: 2,
      exactImageIdMatch: true,
      exactConfigMatch: true,
      exactRootfsLayerMatch: true,
    });

    const layerDrift = imageInspection("a");
    layerDrift.RootFS.Layers[1] = `sha256:${"c".repeat(64)}`;
    expect(() => validateReproducibleImages(primary, layerDrift)).toThrow(
      '"exactRootfsLayerMatch":false',
    );

    const imageDrift = imageInspection("b");
    expect(() => validateReproducibleImages(primary, imageDrift)).toThrow(
      '"exactImageIdMatch":false',
    );

    const malformed = imageInspection("a");
    delete malformed.RootFS.Layers;
    expect(() => validateReproducibleImages(primary, malformed)).toThrow(
      '"exactRootfsLayerMatch":false',
    );
  });

  test("validates numeric runtime identity, mounts, ACLs, and descriptors", () => {
    const report = validateRuntimeProcessAttestation(runtimeAttestation());
    expect(report.process.uid).toEqual(Array(4).fill(RUNTIME_UID));
    expect(report.process.gid).toEqual(Array(4).fill(RUNTIME_GID));
    expect(report.processSecurity.noNewPrivileges).toBe(1);
    expect(report.processSecurity.seccompMode).toBe(2);
    expect(report.filesystem.rootMount.mountOptions).toContain("ro");
    expect(report.filesystem.tmpMount.superOptions).toContain("size=16384k");
    expect(report.filesystem.unexpectedWritableMounts).toEqual([]);
    expect(report.fileDescriptors.classCounts).toEqual({
      "dev-null": 1,
      eventpoll: 1,
      pipe: 2,
      socket: 1,
    });

    const capabilityDrift = runtimeAttestation();
    capabilityDrift.status.CapEff = "0000000000000001";
    expect(() => validateRuntimeProcessAttestation(capabilityDrift)).toThrow(
      "CapEff must be zero",
    );

    const descriptorDrift = runtimeAttestation();
    descriptorDrift.fileDescriptors.push({
      fd: 5,
      target: "/run/containerd/containerd.sock",
    });
    expect(() => validateRuntimeProcessAttestation(descriptorDrift)).toThrow(
      "unexpected path-backed",
    );

    const writableDrift = runtimeAttestation();
    writableDrift.mountInfo +=
      "43 36 0:44 / /usr/local/share rw,relatime - tmpfs tmpfs rw,size=4k\n";
    expect(() => validateRuntimeProcessAttestation(writableDrift)).toThrow(
      "unexpected writable mount",
    );
  });

  test("accepts Docker tmpfs inventory variants without accepting another mount", () => {
    const network = "cinatoken-linux-gate-test";
    const inspection = containerInspection(network);
    expect(validateContainerPolicy(inspection, network).tmpfs.path).toBe("/tmp");

    inspection.Mounts = [{ Type: "tmpfs", Destination: "/tmp", RW: true }];
    expect(validateContainerPolicy(inspection, network).tmpfs.path).toBe("/tmp");

    inspection.Mounts = [{ Type: "volume", Destination: "/data", RW: true }];
    expect(() => validateContainerPolicy(inspection, network)).toThrow(
      "must not expose a mount beyond",
    );
  });

  test("parses escaped mount paths and classifies only bounded FD targets", () => {
    const mounts = parseLinuxMountInfo(
      "41 36 0:42 /path\\040with\\040spaces /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=16m\n",
    );
    expect(mounts[0].mountSource).toBe("tmpfs");
    expect(classifyRuntimeFileDescriptorTarget("/dev/null")).toBe("dev-null");
    expect(classifyRuntimeFileDescriptorTarget("socket:[123]")).toBe("socket");
    expect(classifyRuntimeFileDescriptorTarget("anon_inode:[eventpoll]")).toBe(
      "eventpoll",
    );
    expect(classifyRuntimeFileDescriptorTarget("/host/secret")).toBe("unexpected");
  });
});

function imageInspection(identity) {
  return {
    Id: `sha256:${identity.repeat(64)}`,
    RootFS: {
      Layers: [
        `sha256:${"0".repeat(64)}`,
        `sha256:${"1".repeat(64)}`,
      ],
    },
    Config: {
      User: "nonroot:nonroot",
      WorkingDir: "/",
      Entrypoint: ["/usr/local/bin/cinatoken-container-runtime"],
    },
  };
}

function containerInspection(network) {
  return {
    State: { Running: true, Pid: 100 },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: 256 * 1024 * 1024,
      PidsLimit: 128,
      NetworkMode: network,
      PublishAllPorts: false,
      PortBindings: {},
      Binds: null,
      Devices: [],
      DeviceRequests: null,
      Mounts: [],
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65532,gid=65532",
      },
    },
    Mounts: [],
  };
}

function runtimeAttestation() {
  return {
    schemaVersion: RUNTIME_ATTESTATION_CONTRACT_VERSION,
    contract: "cinatoken-container-runtime-process-attestation-v1",
    targetPid: 1,
    status: {
      Name: "cinatoken-conta",
      State: "S (sleeping)",
      Tgid: "1",
      Pid: "1",
      PPid: "0",
      TracerPid: "0",
      Uid: `${RUNTIME_UID} ${RUNTIME_UID} ${RUNTIME_UID} ${RUNTIME_UID}`,
      Gid: `${RUNTIME_GID} ${RUNTIME_GID} ${RUNTIME_GID} ${RUNTIME_GID}`,
      Groups: String(RUNTIME_GID),
      CapInh: "0000000000000000",
      CapPrm: "0000000000000000",
      CapEff: "0000000000000000",
      CapBnd: "0000000000000000",
      CapAmb: "0000000000000000",
      NoNewPrivs: "1",
      Seccomp: "2",
      Seccomp_filters: "1",
    },
    links: {
      cwd: "/",
      executable: "/usr/local/bin/cinatoken-container-runtime",
      root: "/",
    },
    mountInfo: [
      "36 25 0:31 / / ro,relatime - overlay overlay rw,lowerdir=/layers",
      "37 36 0:32 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
      `42 36 0:43 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=16384k,mode=700,uid=${RUNTIME_UID},gid=${RUNTIME_GID}`,
      "",
    ].join("\n"),
    fileDescriptors: [
      { fd: 0, target: "/dev/null" },
      { fd: 1, target: "pipe:[101]" },
      { fd: 2, target: "pipe:[102]" },
      { fd: 3, target: "anon_inode:[eventpoll]" },
      { fd: 4, target: "socket:[103]" },
    ],
    paths: [
      pathAttestation("/", "directory", 0, 0, "0755", 4_096),
      pathAttestation("/usr", "directory", 0, 0, "0755", 4_096),
      pathAttestation("/usr/local", "directory", 0, 0, "0755", 4_096),
      pathAttestation("/usr/local/bin", "directory", 0, 0, "0755", 4_096),
      pathAttestation("/tmp", "directory", RUNTIME_UID, RUNTIME_GID, "0700", 0),
      pathAttestation(
        "/usr/local/bin/cinatoken-container-runtime",
        "file",
        0,
        0,
        "0755",
        1024,
      ),
    ],
  };
}

function pathAttestation(path, fileType, uid, gid, mode, size) {
  return {
    path,
    fileType,
    uid,
    gid,
    mode,
    linkCount: 1,
    size,
    posixAclAccess: false,
    posixAclDefault: false,
  };
}
