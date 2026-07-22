import { describe, expect, test } from "bun:test";

import { runBoundedSubprocess } from "../tools/lib/bounded_subprocess.mjs";
import {
  CHECKOUT_ACTION,
  DISTROLESS_RUNTIME_IMAGE,
  LINUX_GATE_CONTRACT_VERSION,
  NODE_MOCK_IMAGE,
  RUST_BUILDER_IMAGE,
  auditRepositoryContract,
  buildOperationEnvelope,
  parseArgs,
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
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("docker build --platform linux/amd64");
    expect(workflow).toContain("tests/fixtures/container-runtime-linux-probe.mjs");
    expect(workflow).toContain(
      "node tools/verify_container_runtime_linux.mjs --image cinatoken-container-runtime:linux-gate --json",
    );
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\.|wrangler|cloudflare api/i);
    expect(verifierSource).toContain(NODE_MOCK_IMAGE);
    expect(verifierSource).toContain('"network", "create", "--internal"');
    expect(verifierSource).toContain('"r2-input.cinatoken.internal"');
    expect(verifierSource).toContain('"provider-egress.cinatoken.internal"');
    expect(verifierSource).toContain('"runtime.cinatoken.internal"');
    expect(verifierSource).toContain('"exec"');
    expect(probeSource).toContain("http://runtime.cinatoken.internal:8080");
    expect(probeSource).toContain("http://127.0.0.1:9090");
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
    expect(packageJson.scripts["check:container-runtime:linux-contract"]).toContain("--self-test");
    expect(packageJson.scripts["check:container-runtime:linux"]).toContain("--image");
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
      json: true,
    });
    expect(parseArgs(["--image", "runtime:test"])).toEqual({
      selfTest: false,
      image: "runtime:test",
      json: false,
    });
    expect(() => parseArgs([])).toThrow("select exactly one");
    expect(() => parseArgs(["--self-test", "--image", "runtime:test"])).toThrow(
      "select exactly one",
    );
    expect(() => parseArgs(["--image", "--bad"])).toThrow("must not start");
    expect(() => parseArgs(["--unknown"])).toThrow("unknown argument");
  });

  test("self-test proves only the offline contract", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
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
});
