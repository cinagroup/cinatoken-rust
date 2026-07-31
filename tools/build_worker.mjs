#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerBuildVersion = "0.1.14";
const supportedCrates = [
  "worker",
  "wfp-tenant",
  "wfp-outbound",
  "container-egress",
  "drain-source-registration-coordinator",
];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cargoLockPath = join(root, "Cargo.lock");

const args = new Set(process.argv.slice(2));

try {
  if (args.has("--self-test")) {
    runSelfTest();
  } else if (args.has("--install-tools")) {
    await installTools();
  } else {
    await buildWorker(process.argv.slice(2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function buildWorker(buildArgs) {
  const target = parseBuildTarget(buildArgs);
  const wasmBindgenVersion = await lockedWasmBindgenVersion();
  const workerBuild = requiredBinary("worker-build", installHint(wasmBindgenVersion));
  const wasmBindgen = requiredBinary("wasm-bindgen", installHint(wasmBindgenVersion));
  const installedWasmBindgenVersion = commandVersion(wasmBindgen, ["--version"], parseWasmBindgenVersion);
  const esbuild = localEsbuildBinary();
  const installedEsbuildVersion = esbuild
    ? commandVersion(esbuild, ["--version"], parseEsbuildVersion)
    : null;

  if (installedWasmBindgenVersion !== wasmBindgenVersion) {
    throw new Error(
      `wasm-bindgen CLI ${installedWasmBindgenVersion} does not match Cargo.lock ${wasmBindgenVersion}.\n${installHint(wasmBindgenVersion)}`,
    );
  }
  const effectiveArgs = target.args.length === 0 ? ["--release"] : target.args;
  console.log(
    `Building ${target.crate} with worker-build ${workerBuildVersion}, wasm-bindgen ${wasmBindgenVersion}${installedEsbuildVersion ? `, and Bun-locked esbuild ${installedEsbuildVersion}` : ""}`,
  );
  await run(workerBuild, effectiveArgs, {
    cwd: join(root, "crates", target.crate),
    env: {
      ...process.env,
      WASM_BINDGEN_BIN: wasmBindgen,
      ...(esbuild ? { ESBUILD_BIN: esbuild } : {}),
    },
  });
}

function parseBuildTarget(args) {
  const remaining = [];
  let crate = "worker";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--crate") {
      const value = args[++index];
      if (!value) throw new Error(`--crate requires one of: ${supportedCrates.join(", ")}`);
      crate = value;
    } else {
      remaining.push(args[index]);
    }
  }
  if (!supportedCrates.includes(crate)) {
    throw new Error(`--crate requires one of: ${supportedCrates.join(", ")}`);
  }
  return { crate, args: remaining };
}

async function installTools() {
  const wasmBindgenVersion = await lockedWasmBindgenVersion();
  const binstall = Bun.which("cargo-binstall");
  if (binstall) {
    const common = [
      "--no-confirm",
      "--force",
      "--strategies",
      "crate-meta-data,quick-install",
      "--disable-telemetry",
    ];
    await run(binstall, [`worker-build@${workerBuildVersion}`, ...common]);
    await run(binstall, [`wasm-bindgen-cli@${wasmBindgenVersion}`, ...common]);
  } else {
    await run("cargo", [
      "install",
      "worker-build",
      "--version",
      workerBuildVersion,
      "--locked",
      "--force",
    ]);
    await run("cargo", [
      "install",
      "wasm-bindgen-cli",
      "--version",
      wasmBindgenVersion,
      "--locked",
      "--force",
    ]);
  }
  console.log(`Installed Worker build tools for wasm-bindgen ${wasmBindgenVersion}`);
}

async function lockedWasmBindgenVersion() {
  return parseLockedWasmBindgenVersion(await readFile(cargoLockPath, "utf8"));
}

function parseLockedWasmBindgenVersion(lockfile) {
  const match = lockfile.match(
    /\[\[package\]\]\r?\nname = "wasm-bindgen"\r?\nversion = "([^"]+)"/,
  );
  if (!match) {
    throw new Error("Cargo.lock does not contain an exact wasm-bindgen package version");
  }
  return match[1];
}

function parseWasmBindgenVersion(output) {
  const match = output.trim().match(/^wasm-bindgen\s+([0-9]+\.[0-9]+\.[0-9]+)$/);
  if (!match) {
    throw new Error(`unexpected wasm-bindgen --version output: ${JSON.stringify(output.trim())}`);
  }
  return match[1];
}

function parseEsbuildVersion(output) {
  const version = output.trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`unexpected esbuild --version output: ${JSON.stringify(version)}`);
  }
  return version;
}

function localEsbuildBinary() {
  if (process.platform !== "win32") return null;
  const target = process.arch === "arm64" ? "win32-arm64" : "win32-x64";
  const binary = join(root, "node_modules", "@esbuild", target, "esbuild.exe");
  if (!Bun.file(binary).size) {
    throw new Error("local Bun-locked esbuild binary is missing. Run: bun install --frozen-lockfile");
  }
  return binary;
}

function requiredBinary(name, hint) {
  const binary = Bun.which(name);
  if (!binary) {
    throw new Error(`${name} is not installed or is not on PATH.\n${hint}`);
  }
  return binary;
}

function commandVersion(command, commandArgs, parser) {
  const result = Bun.spawnSync([command, ...commandArgs], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return parser(result.stdout.toString());
}

async function run(command, commandArgs, options = {}) {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${exitCode}`);
  }
}

function installHint(wasmBindgenVersion) {
  return `Run: bun run install:worker-build (requires cargo-binstall or a native Rust linker; installs worker-build ${workerBuildVersion} and wasm-bindgen-cli ${wasmBindgenVersion})`;
}

function runSelfTest() {
  const fixture = [
    "[[package]]",
    'name = "other"',
    'version = "1.0.0"',
    "",
    "[[package]]",
    'name = "wasm-bindgen"',
    'version = "0.2.125"',
  ].join("\n");
  if (parseLockedWasmBindgenVersion(fixture) !== "0.2.125") {
    throw new Error("worker build self-test failed to parse Cargo.lock");
  }
  if (parseWasmBindgenVersion("wasm-bindgen 0.2.125\n") !== "0.2.125") {
    throw new Error("worker build self-test failed to parse wasm-bindgen CLI output");
  }
  if (parseEsbuildVersion("0.28.1\n") !== "0.28.1") {
    throw new Error("worker build self-test failed to parse esbuild CLI output");
  }
  const target = parseBuildTarget(["--crate", "wfp-tenant", "--release"]);
  if (target.crate !== "wfp-tenant" || target.args.join(" ") !== "--release") {
    throw new Error("worker build self-test failed to parse crate target");
  }
  const outboundTarget = parseBuildTarget(["--crate", "wfp-outbound", "--release"]);
  if (outboundTarget.crate !== "wfp-outbound" || outboundTarget.args.join(" ") !== "--release") {
    throw new Error("worker build self-test failed to parse outbound crate target");
  }
  const containerEgressTarget = parseBuildTarget([
    "--crate",
    "container-egress",
    "--release",
  ]);
  if (
    containerEgressTarget.crate !== "container-egress" ||
    containerEgressTarget.args.join(" ") !== "--release"
  ) {
    throw new Error("worker build self-test failed to parse container egress crate target");
  }
  const registrationCoordinatorTarget = parseBuildTarget([
    "--crate",
    "drain-source-registration-coordinator",
    "--release",
  ]);
  if (
    registrationCoordinatorTarget.crate !==
      "drain-source-registration-coordinator" ||
    registrationCoordinatorTarget.args.join(" ") !== "--release"
  ) {
    throw new Error(
      "worker build self-test failed to parse drain-source registration coordinator target",
    );
  }
  for (const invalid of ["", "wasm-bindgen 0.2", "wasm-bindgen-cli 0.2.125"]) {
    try {
      parseWasmBindgenVersion(invalid);
      throw new Error(`worker build self-test accepted invalid version output: ${invalid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("worker build self-test accepted")) {
        throw error;
      }
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      workerBuildVersion,
      bunLockedEsbuildOverride: process.platform === "win32",
      lockedWasmBindgenVersion: "0.2.125",
      exactCliMatchRequired: true,
    }),
  );
}
