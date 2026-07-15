import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const GENERATOR_SCRIPT = resolve(
  ROOT,
  "tools",
  "generate_go_flat_billing_manifest.mjs",
);
const DEFAULT_SOURCE = resolve(ROOT, "..", "cinatoken");
const DEFAULT_OUTPUT = resolve(
  ROOT,
  "crates",
  "billing",
  "tests",
  "fixtures",
  "flat_billing_go_manifest.json",
);
const MARKER = "CINATOKEN_FLAT_MANIFEST_JSON=";
const GENERATED_FILES = [
  {
    template: resolve(
      ROOT,
      "tools",
      "go_flat_billing_terminal_manifest_test.go",
    ),
    target: ["service", "zz_cinatoken_flat_billing_manifest_test.go"],
    package: "./service",
    test: "TestGenerateCinaTokenFlatBillingTerminalManifest",
    key: "terminal_cases",
  },
  {
    template: resolve(
      ROOT,
      "tools",
      "go_flat_billing_admission_manifest_test.go",
    ),
    target: ["relay", "helper", "zz_cinatoken_flat_billing_manifest_test.go"],
    package: "./relay/helper",
    test: "TestGenerateCinaTokenFlatBillingAdmissionManifest",
    key: "admission_cases",
  },
];
const SOURCE_FILES = [
  "relay/helper/price.go",
  "service/quota.go",
  "service/text_quota.go",
  "setting/operation_setting/quota_setting.go",
  "setting/operation_setting/tools.go",
  "setting/ratio_setting/cache_ratio.go",
  "setting/ratio_setting/group_ratio.go",
  "setting/ratio_setting/model_ratio.go",
];
const EXPECTED_CASE_COUNTS = {
  terminal_cases: 10,
  admission_cases: 8,
};

function parseArgs(argv) {
  const options = {
    source: process.env.CINATOKEN_GO_SOURCE
      ? resolve(process.env.CINATOKEN_GO_SOURCE)
      : DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    check: false,
    verifyArtifact: false,
    json: false,
    goProxy: process.env.CINATOKEN_GO_PROXY ?? "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = resolve(argv[++index] ?? "");
    else if (arg === "--output") options.output = resolve(argv[++index] ?? "");
    else if (arg === "--check") options.check = true;
    else if (arg === "--verify-artifact") options.verifyArtifact = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--go-proxy") options.goProxy = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function run(command, args, cwd, env = process.env) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.exitCode}\n${stdout}${stderr}`,
    );
  }
  return stdout;
}

function parseGeneratedCases(output, testName) {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(MARKER));
  if (!line) throw new Error(`${testName} did not emit ${MARKER}`);
  const parsed = JSON.parse(line.slice(MARKER.length));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${testName} emitted an empty case list`);
  }
  return parsed;
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function buildManifest(source, goProxy) {
  if (!existsSync(resolve(source, "go.mod"))) {
    throw new Error(`Go source checkout is missing go.mod: ${source}`);
  }
  const commit = run("git", ["rev-parse", "HEAD"], source).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Go source commit is not a full SHA-1: ${commit}`);
  }
  const trackedChanges = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    source,
  ).trim();
  if (trackedChanges) {
    throw new Error(
      `Go source has tracked changes and cannot produce a commit-bound manifest:\n${trackedChanges}`,
    );
  }

  const generated = {};
  const copied = [];
  const goPath = process.env.USERPROFILE
    ? resolve(process.env.USERPROFILE, "go")
    : resolve(tmpdir(), "cinatoken-go-manifest-gopath");
  const goEnv = {
    ...process.env,
    CINATOKEN_FLAT_MANIFEST: "1",
    GOPATH: goPath,
    GOMODCACHE: resolve(goPath, "pkg", "mod"),
  };
  if (goProxy) {
    goEnv.GOPROXY = goProxy;
  }
  await mkdir(goEnv.GOMODCACHE, { recursive: true });
  try {
    for (const entry of GENERATED_FILES) {
      const target = resolve(source, ...entry.target);
      if (existsSync(target)) {
        throw new Error(
          `refusing to overwrite existing generator target: ${target}`,
        );
      }
      await copyFile(entry.template, target);
      copied.push(target);
      const output = run(
        "go",
        ["test", entry.package, "-run", `^${entry.test}$`, "-count=1", "-v"],
        source,
        goEnv,
      );
      generated[entry.key] = parseGeneratedCases(output, entry.test);
    }
  } finally {
    await Promise.all(copied.map((path) => rm(path, { force: true })));
  }

  const sourceFiles = {};
  for (const path of SOURCE_FILES) {
    sourceFiles[path] = await fileSha256(resolve(source, path));
  }
  const templates = {};
  for (const entry of GENERATED_FILES) {
    templates[basename(entry.template)] = await fileSha256(entry.template);
  }

  const payload = {
    schema_version: 1,
    source: {
      repository: "github.com/cinagroup/cinatoken",
      commit,
      files_sha256: sourceFiles,
    },
    generator: {
      runtime: "go test against source packages",
      script_sha256: await fileSha256(GENERATOR_SCRIPT),
      templates_sha256: templates,
    },
    ...generated,
  };
  return {
    ...payload,
    manifest_sha256: sha256(canonicalJson(payload)),
  };
}

async function verifyArtifact(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const { manifest_sha256: expected, ...payload } = manifest;
  const actual = sha256(canonicalJson(payload));
  if (!/^[0-9a-f]{64}$/.test(expected ?? "") || actual !== expected) {
    throw new Error(
      `manifest digest mismatch: expected ${expected}, computed ${actual}`,
    );
  }
  if (manifest.schema_version !== 1) {
    throw new Error("manifest is missing required schema-1 case families");
  }
  if (
    manifest.source?.repository !== "github.com/cinagroup/cinatoken" ||
    !/^[0-9a-f]{40}$/.test(manifest.source?.commit ?? "")
  ) {
    throw new Error("manifest source identity is invalid");
  }

  const sourceHashes = manifest.source?.files_sha256;
  const sourceKeys =
    sourceHashes && typeof sourceHashes === "object"
      ? Object.keys(sourceHashes).sort()
      : [];
  if (
    JSON.stringify(sourceKeys) !== JSON.stringify([...SOURCE_FILES].sort()) ||
    sourceKeys.some((key) => !/^[0-9a-f]{64}$/.test(sourceHashes[key]))
  ) {
    throw new Error("manifest source-file hash inventory is invalid");
  }

  const expectedTemplates = GENERATED_FILES.map((entry) =>
    basename(entry.template),
  ).sort();
  const templateHashes = manifest.generator?.templates_sha256;
  const templateKeys =
    templateHashes && typeof templateHashes === "object"
      ? Object.keys(templateHashes).sort()
      : [];
  if (
    manifest.generator?.runtime !== "go test against source packages" ||
    manifest.generator?.script_sha256 !==
      (await fileSha256(GENERATOR_SCRIPT)) ||
    JSON.stringify(templateKeys) !== JSON.stringify(expectedTemplates) ||
    templateKeys.some((key) => !/^[0-9a-f]{64}$/.test(templateHashes[key]))
  ) {
    throw new Error("manifest generator identity is invalid");
  }
  for (const entry of GENERATED_FILES) {
    const name = basename(entry.template);
    if (templateHashes[name] !== (await fileSha256(entry.template))) {
      throw new Error(`manifest template hash is stale: ${name}`);
    }
  }

  const caseNames = new Set();
  for (const [key, count] of Object.entries(EXPECTED_CASE_COUNTS)) {
    const cases = manifest[key];
    if (!Array.isArray(cases) || cases.length !== count) {
      throw new Error(`manifest ${key} must contain exactly ${count} cases`);
    }
    for (const entry of cases) {
      if (
        typeof entry?.name !== "string" ||
        entry.name.length === 0 ||
        caseNames.has(entry.name)
      ) {
        throw new Error(`manifest contains an invalid or duplicate case name`);
      }
      caseNames.add(entry.name);
    }
  }
  return {
    manifest_sha256: actual,
    terminal_cases: manifest.terminal_cases.length,
    admission_cases: manifest.admission_cases.length,
    source_commit: manifest.source?.commit,
  };
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.verifyArtifact) {
    const summary = await verifyArtifact(options.output);
    console.log(options.json ? JSON.stringify(summary) : summary);
    return;
  }

  const manifest = await buildManifest(options.source, options.goProxy);
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.check) {
    const current = await readFile(options.output, "utf8");
    if (current !== encoded) {
      throw new Error(
        `Go flat billing manifest is stale; regenerate ${options.output}`,
      );
    }
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, encoded);
  }
  const summary = await verifyArtifact(options.output);
  console.log(options.json ? JSON.stringify(summary) : summary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
