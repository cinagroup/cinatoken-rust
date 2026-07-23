import { afterEach, describe, expect, test } from "bun:test";
import {
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
  RING_TRANSITION_RUNNER_MODULE_INVENTORY_CONTRACT,
  RING_TRANSITION_RUNNER_RELEASE_MANIFEST_CONTRACT,
  RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT,
  RING_TRANSITION_RUNNER_RELEASE_POLICY_CONTRACT,
  describeRingTransitionRunnerReleaseContract,
  dssePreAuthenticationEncoding,
  verifyRingTransitionRunnerRelease,
} from "../tools/relay_container_ring_transition_release_contract.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(
  ROOT,
  "tools",
  "verify_relay_container_ring_transition_release.mjs",
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Relay Container ring-transition runner release contract", () => {
  test("describes a detached, credential-free, non-authorizing release boundary", async () => {
    const result = describeRingTransitionRunnerReleaseContract();
    expect(result).toMatchObject({
      environment: "staging",
      releaseForm: "detached-signed-packet",
      selfHashCycleAvoided: true,
      constraints: {
        exactlyOneEd25519SignatureRequired: true,
        compiledPolicyAndKeyPinsRequiredForExecution: true,
        credentialsRead: false,
        networkRequestsPerformed: false,
        shellCommandsExecuted: false,
        filesWritten: false,
        releaseInstallAuthorized: false,
        remoteMutationAuthorized: false,
      },
    });
    expect(result.requiredModulePaths).toEqual([
      ".gitattributes",
      "Cargo.lock",
      "Cargo.toml",
      "bun.lock",
      "crates/ring-transition-runner/Cargo.toml",
      "crates/ring-transition-runner/src/lib.rs",
      "crates/ring-transition-runner/src/main.rs",
      "crates/ring-transition-runner/src/orchestrator.rs",
      "crates/ring-transition-runner/tests/cli.rs",
      "package.json",
      "tests/relay-container-ring-transition-release-source.test.mjs",
      "tests/relay-container-ring-transition-release.test.mjs",
      "tools/collect_ring_transition_runner_release_source.mjs",
      "tools/relay_container_p5_evidence_contract.mjs",
      "tools/relay_container_ring_transition_contract.mjs",
      "tools/relay_container_ring_transition_release_contract.mjs",
      "tools/verify_relay_container_ring_transition_release.mjs",
    ]);

    const source = await readFile(
      path.join(
        ROOT,
        "tools",
        "relay_container_ring_transition_release_contract.mjs",
      ),
      "utf8",
    );
    for (const forbidden of [
      "process.env",
      "fetch(",
      "Bun.spawn",
      "child_process",
      "execFile",
      "wrangler",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("verifies canonical DSSE, external pins, inventory, and sibling artifact", async () => {
    const fixture = await releaseFixture();
    const result = await verifyRingTransitionRunnerRelease({
      packetPath: fixture.packetPath,
      trustPolicyPath: fixture.policyPath,
      now: NOW,
      pinnedPolicySha256: fixture.policySha256,
      pinnedReleaseKeySpkiSha256: fixture.releaseKeySpkiSha256,
    });
    expect(result).toMatchObject({
      ok: true,
      sourceCommit: "1".repeat(40),
      gitTreeSha: "2".repeat(40),
      artifactSha256: fixture.artifactSha256,
      signatureVerified: true,
      artifactVerified: true,
      twoBuildsIdentical: true,
      externalPinsVerified: true,
      compiledLauncherTrustVerified: false,
      releaseInstallAuthorized: false,
      remoteMutationAuthorized: false,
    });
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.moduleCount).toBe(17);
  });

  test("CLI verifies consistency without claiming compiled trust or installation", async () => {
    const fixture = await releaseFixture();
    const verified = await runCli([
      "--packet",
      fixture.packetPath,
      "--trust-policy",
      fixture.policyPath,
      "--json",
    ]);
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      signatureVerified: true,
      artifactVerified: true,
      externalPinsVerified: false,
      compiledLauncherTrustVerified: false,
      releaseInstallAuthorized: false,
      credentialsRead: false,
      networkRequestsPerformed: false,
      remoteMutationAuthorized: false,
    });
    expect(verified.stdout).not.toContain("poison-release-secret");

    const described = await runCli(["--describe", "--json"]);
    expect(described.exitCode).toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({
      releaseForm: "detached-signed-packet",
      constraints: {
        releaseInstallAuthorized: false,
        remoteMutationAuthorized: false,
      },
    });
  });

  test("rejects manifest tampering, unknown fields, and non-canonical packet bytes", async () => {
    const tampered = await releaseFixture();
    const packet = JSON.parse(await readFile(tampered.packetPath, "utf8"));
    const manifest = JSON.parse(
      Buffer.from(packet.envelope.payload, "base64").toString("utf8"),
    );
    manifest.source.commitSha = "f".repeat(40);
    packet.envelope.payload = Buffer.from(
      canonicalJson(manifest),
      "utf8",
    ).toString("base64");
    await writeCanonical(tampered.packetPath, packet);
    await expectReleaseFailure(tampered, /DSSE signature verification failed/);

    const unknown = await releaseFixture({
      manifestMutator: (value) => {
        value.unreviewed = true;
      },
    });
    await expectReleaseFailure(unknown, /unknown or missing fields/);

    const nonCanonical = await releaseFixture();
    const canonicalPacket = JSON.parse(
      await readFile(nonCanonical.packetPath, "utf8"),
    );
    await writeFile(
      nonCanonical.packetPath,
      `${JSON.stringify(canonicalPacket, null, 2)}\n`,
      "utf8",
    );
    await expectReleaseFailure(nonCanonical, /canonical JSON/);
  });

  test("rejects unpinned, reused, inactive, or mismatched release keys", async () => {
    const fixture = await releaseFixture();
    await expect(
      verifyRingTransitionRunnerRelease({
        packetPath: fixture.packetPath,
        trustPolicyPath: fixture.policyPath,
        now: NOW,
        pinnedPolicySha256: "f".repeat(64),
        pinnedReleaseKeySpkiSha256: fixture.releaseKeySpkiSha256,
      }),
    ).rejects.toThrow(/policy digest mismatch/);
    await expect(
      verifyRingTransitionRunnerRelease({
        packetPath: fixture.packetPath,
        trustPolicyPath: fixture.policyPath,
        now: NOW,
        pinnedPolicySha256: fixture.policySha256,
        pinnedReleaseKeySpkiSha256: "e".repeat(64),
      }),
    ).rejects.toThrow(/key SPKI fingerprint mismatch/);

    const reused = await releaseFixture({
      policyMutator: (policy) => {
        policy.forbiddenKeySpkiSha256 = [
          "1".repeat(64),
          "2".repeat(64),
          policy.releaseKeySpkiSha256,
        ].sort();
      },
    });
    await expectReleaseFailure(reused, /release key must be distinct/);

    const expired = await releaseFixture({
      policyMutator: (policy) => {
        policy.validUntil = "2026-07-23T01:00:00.000Z";
      },
    });
    await expectReleaseFailure(expired, /validity window is inactive/);
  });

  test("rejects path escape, unsorted inventory, and required-module omission", async () => {
    const escaped = await releaseFixture({
      inventoryMutator: (inventory) => {
        inventory.files[0].path = "../Cargo.lock";
      },
    });
    await expectReleaseFailure(escaped, /path.*invalid|escapes the source root/);

    const unsorted = await releaseFixture({
      inventoryMutator: (inventory) => {
        [inventory.files[0], inventory.files[1]] = [
          inventory.files[1],
          inventory.files[0],
        ];
      },
    });
    await expectReleaseFailure(unsorted, /sorted and unique/);

    const missing = await releaseFixture({
      inventoryMutator: (inventory) => {
        inventory.files = inventory.files.filter(
          (record) => record.path !== "Cargo.lock",
        );
      },
    });
    await expectReleaseFailure(missing, /file count is invalid|required path missing/);
  });

  test("rejects build drift, policy drift, and Authority trust drift", async () => {
    const buildDrift = await releaseFixture({
      manifestMutator: (manifest) => {
        manifest.build.secondBuildSha256 = "f".repeat(64);
      },
    });
    await expectReleaseFailure(buildDrift, /repeated build digests differ/);

    const policyDrift = await releaseFixture({
      manifestMutator: (manifest) => {
        manifest.trust.releasePolicySha256 = "f".repeat(64);
      },
    });
    await expectReleaseFailure(policyDrift, /release policy digest mismatch/);

    const authorityDrift = await releaseFixture({
      manifestMutator: (manifest) => {
        manifest.trust.authorityOrigin =
          "https://unreviewed-authority.example.com";
      },
    });
    await expectReleaseFailure(authorityDrift, /Authority origin mismatch/);
  });

  test("rejects artifact replacement and hard-linked installation candidates", async () => {
    const replaced = await releaseFixture();
    await writeFile(replaced.artifactPath, "replacement-artifact", "utf8");
    await expectReleaseFailure(replaced, /artifact.*identity mismatch/);

    const linked = await releaseFixture();
    await link(
      linked.artifactPath,
      path.join(linked.directory, "runner-hardlink"),
    );
    await expectReleaseFailure(linked, /bounded regular non-linked file/);
  });

  test("uses standard DSSE PAE and rejects malformed envelopes", async () => {
    const payload = Buffer.from("{}", "utf8");
    expect(
      dssePreAuthenticationEncoding(
        RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
        payload,
      ),
    ).toEqual(
      Buffer.concat([
        Buffer.from(
          `DSSEv1 ${Buffer.byteLength(RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE)} ${RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE} 2 `,
          "utf8",
        ),
        payload,
      ]),
    );

    const multiple = await releaseFixture({
      packetMutator: (packet) => {
        packet.envelope.signatures.push({
          ...packet.envelope.signatures[0],
        });
      },
    });
    await expectReleaseFailure(multiple, /exactly one signature/);

    const malformed = await releaseFixture({
      packetMutator: (packet) => {
        packet.envelope.payload = "abc";
      },
    });
    await expectReleaseFailure(malformed, /canonical padded base64/);
  });

  test("CLI rejects overrides, repeated paths, and ambiguous invocation", async () => {
    for (const args of [
      [],
      ["--describe", "--packet", "candidate.json"],
      ["--packet", "a", "--packet", "b", "--trust-policy", "c"],
      ["--packet", "a", "--trust-policy", "b", "--key", "replacement"],
      ["--execute"],
    ]) {
      const result = await runCli(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

async function releaseFixture({
  policyMutator,
  inventoryMutator,
  manifestMutator,
  packetMutator,
} = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-ring-release-"),
  );
  temporaryDirectories.push(directory);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const releaseKeySpkiSha256 = sha256Hex(spki);
  const policy = {
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_POLICY_CONTRACT,
    environment: "staging",
    payloadType: RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
    keyId: "release-test-v1",
    releaseKeySpkiBase64url: spki.toString("base64url"),
    releaseKeySpkiSha256,
    validFrom: "2026-07-22T00:00:00.000Z",
    validUntil: "2026-07-25T00:00:00.000Z",
    maximumReleaseLifetimeSeconds: 86_400,
    forbiddenKeySpkiSha256: [
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ],
  };
  policyMutator?.(policy);
  const policyPath = path.join(directory, "release-policy.json");
  await writeCanonical(policyPath, policy);
  const policyBytes = await readFile(policyPath);
  const policySha256 = sha256Hex(policyBytes);

  const moduleContents = new Map([
    [".gitattributes", "* text=auto\n"],
    ["Cargo.lock", "cargo-lock-fixture"],
    ["Cargo.toml", "workspace-cargo-fixture"],
    ["bun.lock", "bun-lock-fixture"],
    [
      "crates/ring-transition-runner/Cargo.toml",
      "runner-cargo-fixture",
    ],
    [
      "crates/ring-transition-runner/src/lib.rs",
      "runner-lib-fixture",
    ],
    [
      "crates/ring-transition-runner/src/main.rs",
      "runner-main-fixture",
    ],
    [
      "crates/ring-transition-runner/src/orchestrator.rs",
      "runner-orchestrator-fixture",
    ],
    [
      "crates/ring-transition-runner/tests/cli.rs",
      "runner-cli-test-fixture",
    ],
    ["package.json", "package-fixture"],
    [
      "tests/relay-container-ring-transition-release-source.test.mjs",
      "release-source-test-fixture",
    ],
    [
      "tests/relay-container-ring-transition-release.test.mjs",
      "release-test-fixture",
    ],
    [
      "tools/collect_ring_transition_runner_release_source.mjs",
      "release-source-collector-fixture",
    ],
    [
      "tools/relay_container_p5_evidence_contract.mjs",
      "p5-contract-fixture",
    ],
    [
      "tools/relay_container_ring_transition_contract.mjs",
      "ring-contract-fixture",
    ],
    [
      "tools/relay_container_ring_transition_release_contract.mjs",
      "release-contract-fixture",
    ],
    [
      "tools/verify_relay_container_ring_transition_release.mjs",
      "release-verifier-fixture",
    ],
  ]);
  const moduleInventory = {
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_MODULE_INVENTORY_CONTRACT,
    files: [...moduleContents.entries()]
      .map(([modulePath, contents]) => ({
        path: modulePath,
        byteLength: Buffer.byteLength(contents),
        sha256: sha256Hex(Buffer.from(contents, "utf8")),
      }))
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
  };
  inventoryMutator?.(moduleInventory);
  const inventoryBytes = Buffer.from(
    canonicalJson(moduleInventory),
    "utf8",
  );
  const artifactBytes = Buffer.from(
    "cinatoken-ring-transition-runner-test-artifact",
    "utf8",
  );
  const artifactSha256 = sha256Hex(artifactBytes);
  const artifactPath = path.join(
    directory,
    "cinatoken-ring-transition-runner.exe",
  );
  await writeFile(artifactPath, artifactBytes);
  const inventoryFileByPath = new Map(
    moduleInventory.files.map((record) => [record.path, record]),
  );
  const manifest = {
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_MANIFEST_CONTRACT,
    environment: "staging",
    issuedAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-24T00:00:00.000Z",
    sourceDateEpoch: 1_753_270_000,
    source: {
      commitSha: "1".repeat(40),
      gitTreeSha: "2".repeat(40),
      sourceArchiveSha256: "3".repeat(64),
      cargoLockSha256:
        inventoryFileByPath.get("Cargo.lock")?.sha256 ?? "0".repeat(64),
      bunLockSha256:
        inventoryFileByPath.get("bun.lock")?.sha256 ?? "0".repeat(64),
      packageJsonSha256:
        inventoryFileByPath.get("package.json")?.sha256 ?? "0".repeat(64),
      moduleInventorySha256: sha256Hex(inventoryBytes),
      moduleCount: moduleInventory.files.length,
      moduleBytes: moduleInventory.files.reduce(
        (total, record) => total + record.byteLength,
        0,
      ),
    },
    build: {
      targetTriple: "x86_64-pc-windows-msvc",
      profile: "release",
      rustcVersion: "rustc test-only",
      cargoVersion: "cargo test-only",
      bunVersion: "bun test-only",
      buildArgumentsSha256: "4".repeat(64),
      buildEnvironmentAllowlistSha256: "5".repeat(64),
      runnerBuildSha256: artifactSha256,
      firstBuildSha256: artifactSha256,
      secondBuildSha256: artifactSha256,
      reproducibleBuildSha256: artifactSha256,
      twoBuildsIdentical: true,
    },
    trust: {
      trustConfigSha256: "6".repeat(64),
      releasePolicySha256: policySha256,
      releaseKeySpkiSha256,
      authorityOrigin:
        "https://ring-transition-authority-staging.cinatoken.com",
      authorityVersionId: "authority-version-test-001",
      permitSpkiSha256: "7".repeat(64),
    },
    evidence: {
      testEvidenceSha256: "8".repeat(64),
      faultEvidenceSha256: "9".repeat(64),
      securityEvidenceSha256: "a".repeat(64),
      noSecretEvidenceSha256: "b".repeat(64),
    },
    artifact: {
      fileName: "cinatoken-ring-transition-runner.exe",
      byteLength: artifactBytes.length,
      sha256: artifactSha256,
    },
  };
  manifestMutator?.(manifest);
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const signature = signBytes(
    null,
    dssePreAuthenticationEncoding(
      RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
      manifestBytes,
    ),
    privateKey,
  );
  const packet = {
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_PACKET_CONTRACT,
    envelope: {
      payloadType: RING_TRANSITION_RUNNER_DSSE_PAYLOAD_TYPE,
      payload: manifestBytes.toString("base64"),
      signatures: [
        {
          keyid: policy.keyId,
          sig: signature.toString("base64"),
        },
      ],
    },
    moduleInventory,
  };
  packetMutator?.(packet);
  const packetPath = path.join(directory, "runner-release.json");
  await writeCanonical(packetPath, packet);
  return {
    directory,
    packetPath,
    policyPath,
    artifactPath,
    artifactSha256,
    releaseKeySpkiSha256,
    policySha256,
  };
}

async function expectReleaseFailure(fixture, pattern) {
  await expect(
    verifyRingTransitionRunnerRelease({
      packetPath: fixture.packetPath,
      trustPolicyPath: fixture.policyPath,
      now: NOW,
    }),
  ).rejects.toThrow(pattern);
}

async function writeCanonical(file, value) {
  await writeFile(file, `${canonicalJson(value)}\n`, "utf8");
}

async function runCli(args) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      CINATOKEN_RING_TRANSITION_RELEASE_SECRET: "poison-release-secret",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
