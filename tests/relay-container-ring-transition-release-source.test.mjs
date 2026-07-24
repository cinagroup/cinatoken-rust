import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT,
  collectRingTransitionRunnerReleaseSource,
  describeRingTransitionRunnerReleaseSourceCollector,
} from "../tools/collect_ring_transition_runner_release_source.mjs";
import {
  sha256Hex,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(
  ROOT,
  "tools",
  "collect_ring_transition_runner_release_source.mjs",
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ring-transition runner release source collector", () => {
  test("describes a clean commit-object-only and non-authorizing collector", async () => {
    expect(describeRingTransitionRunnerReleaseSourceCollector()).toMatchObject({
      contract: RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT,
      sourceMode: "clean-commit-objects-only",
      constraints: {
        cleanWorktreeRequired: true,
        untrackedFilesForbidden: true,
        submodulesForbidden: true,
        completeSha256Required: true,
        networkRequestsPerformed: false,
        credentialsRead: false,
        filesWritten: false,
        releaseSigned: false,
        releaseInstallAuthorized: false,
      },
    });
    const source = await Bun.file(CLI).text();
    expect(source).not.toContain("gitRunner");
    expect(source).toContain("GIT_CONFIG_NOSYSTEM");
    expect(source).toContain("GIT_TERMINAL_PROMPT");
  });

  test("collects deterministic archive and module identities from committed objects", async () => {
    const repository = await fixtureRepository();
    const first = await collectRingTransitionRunnerReleaseSource({
      repositoryRoot: repository,
    });
    const second = await collectRingTransitionRunnerReleaseSource({
      repositoryRoot: repository,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      contract: RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT,
      worktreeClean: true,
      commitObjectsOnly: true,
      releaseSigned: false,
      releaseInstallAuthorized: false,
      remoteMutationAuthorized: false,
    });
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.gitTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.sourceArchiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.moduleInventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.moduleInventory.files.map((record) => record.path)).toEqual(
      [...first.moduleInventory.files.map((record) => record.path)].sort(),
    );
    expect(first.moduleCount).toBe(31);
    expect(first.moduleInventory.files).toContainEqual({
      path: "crates/ring-transition-runner/src/execution_activation.rs",
      byteLength: Buffer.byteLength(
        "pub fn execution_activation_fixture() {}\n",
      ),
      sha256: sha256Hex(
        Buffer.from(
          "pub fn execution_activation_fixture() {}\n",
          "utf8",
        ),
      ),
    });
    expect(first.moduleInventory.files).toContainEqual({
      path: "crates/ring-transition-runner/src/readback.rs",
      byteLength: Buffer.byteLength("pub fn readback_fixture() {}\n"),
      sha256: sha256Hex(
        Buffer.from("pub fn readback_fixture() {}\n", "utf8"),
      ),
    });
    expect(first.moduleInventory.files).toContainEqual({
      path: "crates/ring-transition-runner/src/receipt.rs",
      byteLength: Buffer.byteLength("pub fn receipt_fixture() {}\n"),
      sha256: sha256Hex(
        Buffer.from("pub fn receipt_fixture() {}\n", "utf8"),
      ),
    });
    expect(first.moduleInventory.files).toContainEqual({
      path: "crates/ring-transition-runner/src/transport.rs",
      byteLength: Buffer.byteLength("pub fn transport_fixture() {}\n"),
      sha256: sha256Hex(
        Buffer.from("pub fn transport_fixture() {}\n", "utf8"),
      ),
    });
  });

  test("rejects tracked changes and untracked files before reading a candidate", async () => {
    const tracked = await fixtureRepository();
    await writeFile(
      path.join(tracked, "Cargo.toml"),
      "[workspace]\n# dirty\n",
      "utf8",
    );
    await expect(
      collectRingTransitionRunnerReleaseSource({ repositoryRoot: tracked }),
    ).rejects.toThrow(/worktree must be completely clean/);

    const untracked = await fixtureRepository();
    await writeFile(path.join(untracked, "untracked.txt"), "dirty", "utf8");
    await expect(
      collectRingTransitionRunnerReleaseSource({ repositoryRoot: untracked }),
    ).rejects.toThrow(/worktree must be completely clean/);
  });

  test("rejects a missing required transport module", async () => {
    const repository = await fixtureRepository({
      omit: "crates/ring-transition-runner/src/transport.rs",
    });
    await expect(
      collectRingTransitionRunnerReleaseSource({ repositoryRoot: repository }),
    ).rejects.toThrow(/required module missing/);
  });

  test("rejects a missing required stable-readback module", async () => {
    const repository = await fixtureRepository({
      omit: "crates/ring-transition-runner/src/readback.rs",
    });
    await expect(
      collectRingTransitionRunnerReleaseSource({ repositoryRoot: repository }),
    ).rejects.toThrow(/required module missing/);
  });

  test("rejects a missing receipt writer, verifier, or verifier test", async () => {
    for (const omit of [
      "crates/ring-transition-runner/src/receipt.rs",
      "tools/relay_container_ring_transition_receipt_contract.mjs",
      "tests/relay-container-ring-transition-receipt.test.mjs",
    ]) {
      const repository = await fixtureRepository({ omit });
      await expect(
        collectRingTransitionRunnerReleaseSource({
          repositoryRoot: repository,
        }),
      ).rejects.toThrow(/required module missing/);
    }
  });

  test("rejects a missing execution activation module, verifier, or verifier test", async () => {
    for (const omit of [
      "crates/ring-transition-runner/src/execution_activation.rs",
      "tools/relay_container_ring_transition_execution_activation_contract.mjs",
      "tests/relay-container-ring-transition-execution-activation.test.mjs",
    ]) {
      const repository = await fixtureRepository({ omit });
      await expect(
        collectRingTransitionRunnerReleaseSource({
          repositoryRoot: repository,
        }),
      ).rejects.toThrow(/required module missing/);
    }
  });

  test("rejects a missing operation anchor contract, verifier, or verifier test", async () => {
    for (const omit of [
      "tools/relay_container_ring_transition_operation_anchor_contract.mjs",
      "tools/verify_relay_container_ring_transition_operation_anchor.mjs",
      "tests/relay-container-ring-transition-operation-anchor.test.mjs",
    ]) {
      const repository = await fixtureRepository({ omit });
      await expect(
        collectRingTransitionRunnerReleaseSource({
          repositoryRoot: repository,
        }),
      ).rejects.toThrow(/required module missing/);
    }
  });

  test("CLI describes without Git and collects one clean fixture", async () => {
    const described = await runCli(["--describe", "--json"], {
      PATH: "",
    });
    expect(described.exitCode).toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({
      sourceMode: "clean-commit-objects-only",
      constraints: {
        releaseInstallAuthorized: false,
        remoteMutationAuthorized: false,
      },
    });

    const repository = await fixtureRepository();
    const collected = await runCli(["--repo", repository, "--json"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_DIR: path.join(repository, "poison-git-dir"),
      GIT_WORK_TREE: path.join(repository, "poison-worktree"),
    });
    expect(collected.exitCode).toBe(0);
    expect(JSON.parse(collected.stdout)).toMatchObject({
      ok: true,
      worktreeClean: true,
      releaseSigned: false,
      releaseInstallAuthorized: false,
    });
  });

  test("CLI rejects caller-selected Git binaries and output paths", async () => {
    for (const args of [
      [],
      ["--describe", "--repo", "."],
      ["--repo", ".", "--git", "other-git"],
      ["--repo", ".", "--output", "candidate.json"],
      ["--repo", ".", "--repo", "."],
    ]) {
      const result = await runCli(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

async function fixtureRepository({ omit = null } = {}) {
  const repository = await mkdtemp(
    path.join(tmpdir(), "cinatoken-ring-source-"),
  );
  temporaryDirectories.push(repository);
  const files = new Map([
    [".gitattributes", "* text=auto\n"],
    ["Cargo.lock", "fixture Cargo.lock\n"],
    ["Cargo.toml", "[workspace]\n"],
    ["bun.lock", "fixture bun.lock\n"],
    ["package.json", "{\"private\":true}\n"],
    [
      "apps/web/source/default/src/routes/(auth)/$provider.tsx",
      "export const routeFixture = true;\n",
    ],
    [
      "crates/ring-transition-runner/Cargo.toml",
      "[package]\nname=\"fixture\"\n",
    ],
    [
      "crates/ring-transition-runner/src/credentials.rs",
      "pub fn credentials_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/execution_activation.rs",
      "pub fn execution_activation_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/lib.rs",
      "pub fn fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/main.rs",
      "fn main() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/orchestrator.rs",
      "pub fn orchestrator_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/publication.rs",
      "pub fn publication_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/readback.rs",
      "pub fn readback_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/receipt.rs",
      "pub fn receipt_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/release.rs",
      "pub fn release_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/src/transport.rs",
      "pub fn transport_fixture() {}\n",
    ],
    [
      "crates/ring-transition-runner/tests/cli.rs",
      "#[test] fn fixture() {}\n",
    ],
    [
      "tests/relay-container-ring-transition-execution-activation.test.mjs",
      "export const executionActivationFixture = true;\n",
    ],
    [
      "tests/relay-container-ring-transition-operation-anchor.test.mjs",
      "export const operationAnchorFixture = true;\n",
    ],
    [
      "tests/relay-container-ring-transition-receipt.test.mjs",
      "export const receiptFixture = true;\n",
    ],
    [
      "tests/relay-container-ring-transition-release-source.test.mjs",
      "export const sourceFixture = true;\n",
    ],
    [
      "tests/relay-container-ring-transition-release.test.mjs",
      "export const fixture = true;\n",
    ],
    [
      "tools/collect_ring_transition_runner_release_source.mjs",
      "export const collector = true;\n",
    ],
    [
      "tools/relay_container_p5_evidence_contract.mjs",
      "export const p5 = true;\n",
    ],
    [
      "tools/relay_container_ring_transition_contract.mjs",
      "export const ring = true;\n",
    ],
    [
      "tools/relay_container_ring_transition_execution_activation_contract.mjs",
      "export const executionActivationContract = true;\n",
    ],
    [
      "tools/relay_container_ring_transition_operation_anchor_contract.mjs",
      "export const operationAnchorContract = true;\n",
    ],
    [
      "tools/relay_container_ring_transition_receipt_contract.mjs",
      "export const receiptContract = true;\n",
    ],
    [
      "tools/relay_container_ring_transition_release_contract.mjs",
      "export const contract = true;\n",
    ],
    [
      "tools/verify_relay_container_ring_transition_operation_anchor.mjs",
      "export const operationAnchorVerifier = true;\n",
    ],
    [
      "tools/verify_relay_container_ring_transition_release.mjs",
      "export const verifier = true;\n",
    ],
  ]);
  if (omit !== null) files.delete(omit);
  for (const [relativePath, contents] of files) {
    const destination = path.join(repository, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.name", "Cinatoken Test"]);
  await git(repository, ["config", "user.email", "test@invalid.example"]);
  await git(repository, ["add", "--all"]);
  await git(repository, ["commit", "--quiet", "-m", "fixture"], {
    GIT_AUTHOR_DATE: "2026-07-23T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-07-23T00:00:00Z",
  });
  return repository;
}

async function git(repository, args, extraEnv = {}) {
  const child = Bun.spawn(["git", ...args], {
    cwd: repository,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`fixture Git failed: ${stdout}${stderr}`);
  }
}

async function runCli(args, envOverrides = {}) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...envOverrides,
      CINATOKEN_RING_TRANSITION_RELEASE_TOKEN: "poison-release-token",
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
