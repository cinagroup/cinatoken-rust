#!/usr/bin/env bun

import {
  lstat,
  realpath,
} from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";

import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";

export const RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT =
  "cinatoken-relay-container-ring-transition-runner-release-source-v1";

const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_MODULE_COUNT = 2048;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const WHOLE_SECONDS_PATTERN = /^[1-9][0-9]{0,15}$/;
const MODULE_PATH_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/;
const REQUIRED_MODULE_PATHS = Object.freeze([
  ".gitattributes",
  "Cargo.lock",
  "Cargo.toml",
  "bun.lock",
  "crates/ring-transition-runner/Cargo.toml",
  "crates/ring-transition-runner/src/credentials.rs",
  "crates/ring-transition-runner/src/lib.rs",
  "crates/ring-transition-runner/src/main.rs",
  "crates/ring-transition-runner/src/orchestrator.rs",
  "crates/ring-transition-runner/src/publication.rs",
  "crates/ring-transition-runner/src/release.rs",
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

export function describeRingTransitionRunnerReleaseSourceCollector() {
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT,
    environment: "staging",
    sourceMode: "clean-commit-objects-only",
    requiredModulePaths: REQUIRED_MODULE_PATHS,
    constraints: {
      cleanWorktreeRequired: true,
      untrackedFilesForbidden: true,
      submodulesForbidden: true,
      symlinkModulesForbidden: true,
      completeSha256Required: true,
      canonicalSortedInventoryRequired: true,
      fixedGitReadCommandsOnly: true,
      networkRequestsPerformed: false,
      credentialsRead: false,
      filesWritten: false,
      releaseSigned: false,
      releaseInstallAuthorized: false,
      remoteMutationAuthorized: false,
      productionCutoverAuthorized: false,
    },
  };
}

export async function collectRingTransitionRunnerReleaseSource({
  repositoryRoot,
}) {
  const root = await validateRepositoryRoot(repositoryRoot);
  const topLevel = decodeSingleLine(
    await runGit(root, ["rev-parse", "--show-toplevel"], 4096),
    "[source] repository root",
  );
  if (normalizePathForComparison(topLevel) !== normalizePathForComparison(root)) {
    throw new Error("[source] repository root mismatch");
  }
  const status = await runGit(
    root,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    MAX_STATUS_BYTES,
  );
  if (status.length !== 0) {
    throw new Error("[source] worktree must be completely clean");
  }
  const commitSha = decodeGitSha(
    await runGit(root, ["rev-parse", "HEAD"], 4096),
    "[source] commit",
  );
  const gitTreeSha = decodeGitSha(
    await runGit(root, ["rev-parse", "HEAD^{tree}"], 4096),
    "[source] Git tree",
  );
  const sourceDateEpochText = decodeSingleLine(
    await runGit(root, ["show", "-s", "--format=%ct", "HEAD"], 4096),
    "[source] commit timestamp",
  );
  if (!WHOLE_SECONDS_PATTERN.test(sourceDateEpochText)) {
    throw new Error("[source] commit timestamp is invalid");
  }
  const sourceDateEpoch = Number(sourceDateEpochText);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 1) {
    throw new Error("[source] commit timestamp is out of range");
  }
  const treeBytes = await runGit(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    MAX_TREE_BYTES,
  );
  const tree = parseGitTree(treeBytes);
  if (tree.some((entry) => entry.type === "commit")) {
    throw new Error("[source] Git submodules are forbidden");
  }
  const selectedPaths = tree
    .filter((entry) => isReleaseModule(entry.path))
    .map((entry) => entry.path)
    .sort(compareAscii);
  if (
    selectedPaths.length < 1 ||
    selectedPaths.length > MAX_MODULE_COUNT
  ) {
    throw new Error("[source] selected module count is invalid");
  }
  const selectedSet = new Set(selectedPaths);
  for (const requiredPath of REQUIRED_MODULE_PATHS) {
    if (!selectedSet.has(requiredPath)) {
      throw new Error(`[source] required module missing: ${requiredPath}`);
    }
  }
  const treeByPath = new Map(tree.map((entry) => [entry.path, entry]));
  const files = [];
  let totalBytes = 0;
  for (const modulePath of selectedPaths) {
    const entry = treeByPath.get(modulePath);
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      throw new Error(`[source] module mode is forbidden: ${modulePath}`);
    }
    const bytes = await runGit(
      root,
      ["show", `HEAD:${modulePath}`],
      MAX_MODULE_BYTES,
    );
    if (bytes.length < 1) {
      throw new Error(`[source] module is empty: ${modulePath}`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_MODULE_BYTES) {
      throw new Error("[source] module bytes exceed the bound");
    }
    files.push({
      path: modulePath,
      byteLength: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }
  const sourceArchive = await runGit(
    root,
    ["archive", "--format=tar", "HEAD"],
    MAX_ARCHIVE_BYTES,
  );
  if (sourceArchive.length < 1024) {
    throw new Error("[source] Git archive is unexpectedly small");
  }
  const inventory = {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-container-ring-transition-runner-module-inventory-v1",
    files,
  };
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_RUNNER_RELEASE_SOURCE_CONTRACT,
    environment: "staging",
    commitSha,
    gitTreeSha,
    sourceDateEpoch,
    sourceArchiveSha256: sha256Hex(sourceArchive),
    sourceArchiveByteLength: sourceArchive.length,
    cargoLockSha256: fileDigest(files, "Cargo.lock"),
    bunLockSha256: fileDigest(files, "bun.lock"),
    packageJsonSha256: fileDigest(files, "package.json"),
    moduleInventory: inventory,
    moduleInventorySha256: sha256Hex(
      Buffer.from(canonicalJson(inventory), "utf8"),
    ),
    moduleCount: files.length,
    moduleBytes: totalBytes,
    worktreeClean: true,
    commitObjectsOnly: true,
    networkRequestsPerformed: false,
    credentialsRead: false,
    filesWritten: false,
    releaseSigned: false,
    releaseInstallAuthorized: false,
    remoteMutationAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

async function runGit(repositoryRoot, argumentsList, maximumStdoutBytes) {
  const hooksDirectory = path.join(
    repositoryRoot,
    ".git",
    "cinatoken-disabled-hooks",
  );
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${hooksDirectory}`,
      ...argumentsList,
    ],
    {
      cwd: repositoryRoot,
      env: fixedGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(
        child.stdout,
        maximumStdoutBytes,
        "[source] Git stdout",
      ),
      readBoundedStream(child.stderr, 64 * 1024, "[source] Git stderr"),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `[source] fixed Git read failed (${sha256Hex(stderr).slice(0, 16)})`,
      );
    }
    return stdout;
  } catch (error) {
    child.kill();
    await child.exited.catch(() => null);
    throw error;
  }
}

function fixedGitEnvironment() {
  const source = process.env;
  const emptyConfigPath = process.platform === "win32" ? "NUL" : devNull;
  const environment = {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: emptyConfigPath,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of [
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ]) {
    if (typeof source[name] === "string" && source[name] !== "") {
      environment[name] = source[name];
    }
  }
  return environment;
}

async function readBoundedStream(stream, maximumBytes, label) {
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${label} emitted an invalid chunk`);
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new Error(`${label} exceeds its byte bound`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseGitTree(bytes) {
  const entries = [];
  for (const rawEntry of Buffer.from(bytes).toString("utf8").split("\0")) {
    if (rawEntry === "") continue;
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(
      rawEntry,
    );
    if (!match) throw new Error("[source] Git tree entry is invalid");
    const modulePath = validateModulePath(match[4]);
    entries.push({
      mode: match[1],
      type: match[2],
      objectSha: match[3],
      path: modulePath,
    });
  }
  if (entries.length === 0) {
    throw new Error("[source] Git tree is empty");
  }
  return entries;
}

function isReleaseModule(modulePath) {
  return (
    [
      ".gitattributes",
      "Cargo.lock",
      "Cargo.toml",
      "bun.lock",
      "package.json",
    ].includes(modulePath) ||
    modulePath.startsWith("crates/ring-transition-runner/") ||
    [
      "tests/relay-container-ring-transition-release-source.test.mjs",
      "tests/relay-container-ring-transition-release.test.mjs",
    ].includes(modulePath) ||
    [
      "tools/collect_ring_transition_runner_release_source.mjs",
      "tools/relay_container_p5_evidence_contract.mjs",
      "tools/relay_container_ring_transition_contract.mjs",
      "tools/relay_container_ring_transition_release_contract.mjs",
      "tools/verify_relay_container_ring_transition_release.mjs",
    ].includes(modulePath)
  );
}

function validateModulePath(value) {
  if (
    typeof value !== "string" ||
    !MODULE_PATH_PATTERN.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    throw new Error("[source] Git tree path is invalid");
  }
  if (value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("[source] Git tree path escapes the source root");
  }
  return value;
}

async function validateRepositoryRoot(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("[source] repository root is required");
  }
  const resolved = path.resolve(value);
  const stats = await lstat(resolved).catch(() => null);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("[source] repository root must be a non-symlink directory");
  }
  return realpath(resolved);
}

function decodeSingleLine(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  const value = text.replace(/\r?\n$/, "");
  if (
    value.length === 0 ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} must be one bounded line`);
  }
  return value;
}

function decodeGitSha(bytes, label) {
  const value = decodeSingleLine(bytes, label);
  if (!GIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full lowercase Git SHA`);
  }
  return value;
}

function fileDigest(files, modulePath) {
  const record = files.find((candidate) => candidate.path === modulePath);
  if (!record) throw new Error(`[source] module missing: ${modulePath}`);
  return record.sha256;
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(argv) {
  const values = new Map();
  const seen = new Set();
  let describe = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--describe" || argument === "--json") {
      if (seen.has(argument)) {
        usage(2, `[input] ${argument} must not be repeated`);
      }
      seen.add(argument);
      if (argument === "--describe") describe = true;
      if (argument === "--json") json = true;
      continue;
    }
    if (argument !== "--repo") {
      usage(2, `[input] unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      usage(2, `[input] ${argument} must not be repeated`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, "[input] --repo requires a path");
    }
    values.set(argument, value);
  }
  if (describe) {
    if (values.size !== 0) {
      usage(2, "[input] --describe does not accept a repository path");
    }
    return { describe: true, json };
  }
  if (!values.has("--repo")) {
    usage(2, "[input] --repo is required");
  }
  return { describe: false, json, repositoryRoot: values.get("--repo") };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.sourceMode) {
    console.log(
      [
        "Ring-transition runner release source collector",
        `contract: ${result.contract}`,
        `source_mode: ${result.sourceMode}`,
        "release_signed: false",
        "release_install_authorized: false",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Ring-transition runner release source candidate",
      `commit: ${result.commitSha}`,
      `tree: ${result.gitTreeSha}`,
      `source_archive_sha256: ${result.sourceArchiveSha256}`,
      `module_inventory_sha256: ${result.moduleInventorySha256}`,
      `module_count: ${result.moduleCount}`,
      "release_signed: false",
      "release_install_authorized: false",
    ].join("\n"),
  );
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/collect_ring_transition_runner_release_source.mjs --describe [--json]",
      "  bun tools/collect_ring_transition_runner_release_source.mjs --repo <clean-repository> [--json]",
      "",
      "Collection executes fixed local Git read commands only. It performs no network request, reads no credential variables, and writes no file.",
      "The output is an unsigned source candidate. It cannot install a release, enable the runner, mutate Cloudflare, or authorize production cutover.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.describe
      ? describeRingTransitionRunnerReleaseSourceCollector()
      : await collectRingTransitionRunnerReleaseSource({
          repositoryRoot: options.repositoryRoot,
        });
    printResult(result, options.json);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "release source collection failed closed",
    );
    process.exit(1);
  }
}
