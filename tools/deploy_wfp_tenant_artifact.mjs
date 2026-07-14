#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactDir = path.join(
  repoRoot,
  "crates",
  "wfp-tenant",
  "build",
  "worker",
);
const defaultMainModule = "shim.mjs";
const defaultCompatibilityDate = "2026-07-11";
const cloudflareApiBase = "https://api.cloudflare.com/client/v4";
const wasmMagic = Uint8Array.from([0x00, 0x61, 0x73, 0x6d]);
const outboundAuthMode = "platform-outbound-v1";
const routeGatewayBindings = [
  {
    key: "openaiChat",
    binding: "AI_GATEWAY_ID_OPENAI_CHAT",
    flag: "ai-gateway-id-openai-chat",
  },
  {
    key: "openaiResponses",
    binding: "AI_GATEWAY_ID_OPENAI_RESPONSES",
    flag: "ai-gateway-id-openai-responses",
  },
  {
    key: "anthropicMessages",
    binding: "AI_GATEWAY_ID_ANTHROPIC_MESSAGES",
    flag: "ai-gateway-id-anthropic-messages",
  },
  {
    key: "aiRun",
    binding: "AI_GATEWAY_ID_AI_RUN",
    flag: "ai-gateway-id-ai-run",
  },
];
const aiGatewayPolicyBindings = [
  {
    key: "requestTimeoutMs",
    binding: "AI_GATEWAY_REQUEST_TIMEOUT_MS",
    flag: "ai-gateway-request-timeout-ms",
    kind: "positive-integer",
    min: 1,
    max: 600000,
  },
  {
    key: "maxAttempts",
    binding: "AI_GATEWAY_MAX_ATTEMPTS",
    flag: "ai-gateway-max-attempts",
    kind: "positive-integer",
    min: 1,
    max: 5,
  },
  {
    key: "retryDelayMs",
    binding: "AI_GATEWAY_RETRY_DELAY_MS",
    flag: "ai-gateway-retry-delay-ms",
    kind: "positive-integer",
    min: 1,
    max: 5000,
  },
  {
    key: "backoff",
    binding: "AI_GATEWAY_BACKOFF",
    flag: "ai-gateway-backoff",
    kind: "backoff",
  },
  {
    key: "cacheTtlSeconds",
    binding: "AI_GATEWAY_CACHE_TTL_SECONDS",
    flag: "ai-gateway-cache-ttl-seconds",
    kind: "positive-integer",
    min: 1,
  },
  {
    key: "skipCache",
    binding: "AI_GATEWAY_SKIP_CACHE",
    flag: "ai-gateway-skip-cache",
    kind: "boolean",
  },
  {
    key: "collectLog",
    binding: "AI_GATEWAY_COLLECT_LOG",
    flag: "ai-gateway-collect-log",
    kind: "boolean",
  },
];
const retiredTenantGatewayFlags = new Set([
  "ai-gateway-id",
  ...routeGatewayBindings.map((binding) => binding.flag),
  ...aiGatewayPolicyBindings.map((binding) => binding.flag),
]);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test-artifact-manifest")) {
    const result = runArtifactManifestSelfTest();
    printSelfTestResult(result, args.flags.has("json"));
  } else if (args.flags.has("self-test-deploy-plan")) {
    const result = runDeployPlanSelfTest();
    printSelfTestResult(result, args.flags.has("json"));
  } else {
    const options = normalizeOptions(args);
    const result = await main(options);
    printResult(result, options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main(options) {
  const publicScriptName = normalizeWorkerName(required(options.scriptName, "script-name"));
  if (!publicScriptName) {
    throw new Error("script-name must be a valid WFP worker name");
  }
  const scriptName = prefixedWorkerName(publicScriptName, options.workerPrefix);
  if (!scriptName) {
    throw new Error("worker prefix must contain only WFP worker-name characters");
  }
  const tenantId = validatePlainValue(options.tenantId || publicScriptName, "tenant-id");
  const namespace = normalizeDispatchNamespace(required(options.namespace, "namespace"));
  if (!namespace) {
    throw new Error("namespace must be a valid dispatch namespace");
  }
  const accountId = validateAccountId(required(options.accountId, "account-id"));
  const compatibilityDate = validateCompatibilityDate(
    options.compatibilityDate || defaultCompatibilityDate,
  );
  const apiToken = required(options.apiToken, "api-token");
  const metadata = uploadMetadata({
    mainModule: options.mainModule,
    compatibilityDate,
    tenantId,
    workerName: publicScriptName,
    accountId,
  });
  const uploadUrl = dispatchUploadUrl(accountId, namespace, scriptName);
  const modules = await collectArtifactModules(
    options.artifactDir,
    options.mainModule,
  );

  if (options.dryRun) {
    return {
      dryRun: true,
      publicScriptName,
      scriptName,
      tenantId,
      namespace,
      uploadUrl,
      artifactDir: relativePath(options.artifactDir),
      mainModule: options.mainModule,
      moduleCount: modules.length,
      artifactManifest: artifactManifest(options, modules),
      tenantGatewayBindingsAttached: false,
      modules: modules.map((module) => ({
        name: module.name,
        bytes: module.bytes.length,
        sha256: module.sha256,
        contentType: module.contentType,
      })),
      metadata: redactMetadata(metadata),
      warnings: artifactWarnings(),
    };
  }

  const boundary = `cinatoken_wfp_tenant_${randomUUID().replaceAll("-", "")}`;
  const body = buildMultipartBody(boundary, metadata, modules);

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    redirect: "error",
  });
  const preview = await response.text();
  let parsed = null;
  try {
    parsed = preview ? JSON.parse(preview) : null;
  } catch {
    // Keep the bounded preview for diagnostics when Cloudflare returns text.
  }

  return {
    dryRun: false,
    publicScriptName,
    scriptName,
    tenantId,
    namespace,
    uploadUrl,
    artifactDir: relativePath(options.artifactDir),
    mainModule: options.mainModule,
    moduleCount: modules.length,
    artifactManifest: artifactManifest(options, modules),
    tenantGatewayBindingsAttached: false,
    modules: modules.map((module) => ({
      name: module.name,
      bytes: module.bytes.length,
      sha256: module.sha256,
      contentType: module.contentType,
    })),
    metadata: redactMetadata(metadata),
    status: response.status,
    ok: response.ok,
    cloudflareResponsePreview: preview.slice(0, 32768),
    cloudflareResponseJson: parsed,
    warnings: artifactWarnings(),
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (
      arg === "--dry-run" ||
      arg === "--json" ||
      arg === "--self-test-artifact-manifest" ||
      arg === "--self-test-deploy-plan"
    ) {
      flags.add(arg.slice(2));
      continue;
    }
    if (arg === "--no-attach-gateway-token" || arg === "--tenant-api-token") {
      usage(
        2,
        `${arg} is retired; Cloudflare AI authentication belongs to the WFP outbound Worker`,
      );
    }
    if (retiredTenantGatewayFlags.has(arg.slice(2))) {
      usage(
        2,
        `${arg} is retired; configure AI Gateway only on cinatoken-wfp-outbound`,
      );
    }
    if (arg === "--manifest-only") {
      usage(
        2,
        "--manifest-only is no longer supported; deploy plans must validate a real Rust/Wasm artifact",
      );
    }
    if (!arg.startsWith("--")) {
      usage(2, `Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      usage(2, `${arg} requires a value`);
    }
    values.set(key, value);
  }
  return { values, flags };
}

function normalizeOptions(args) {
  const value = (name, envName) => args.values.get(name) || process.env[envName];
  const artifactDir = args.values.get("artifact-dir")
    ? path.resolve(repoRoot, args.values.get("artifact-dir"))
    : defaultArtifactDir;
  return {
    scriptName: value("script-name", "WFP_TENANT_SCRIPT_NAME"),
    tenantId: value("tenant-id", "WFP_TENANT_ID"),
    namespace: value("namespace", "WFP_DISPATCH_NAMESPACE"),
    accountId: value("account-id", "CLOUDFLARE_ACCOUNT_ID"),
    apiToken: value("api-token", "CLOUDFLARE_API_TOKEN"),
    compatibilityDate:
      value("compatibility-date", "WFP_TENANT_COMPATIBILITY_DATE") ||
      defaultCompatibilityDate,
    workerPrefix: value("worker-prefix", "WFP_DISPATCH_WORKER_PREFIX") || "",
    artifactDir,
    mainModule: args.values.get("main-module") || defaultMainModule,
    dryRun: args.flags.has("dry-run"),
    json: args.flags.has("json"),
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/deploy_wfp_tenant_artifact.mjs --script-name <name> --namespace <dispatch-namespace> [options]",
      "",
      "Build first with: bun run build:wfp-tenant",
      "",
      "Required for deploy:",
      "  --account-id <id>      or CLOUDFLARE_ACCOUNT_ID",
      "  --api-token <token>    or CLOUDFLARE_API_TOKEN",
      "",
      "Options:",
      "  --tenant-id <id>",
      "  AI Gateway IDs and request policy are outbound-only and cannot be attached to a tenant.",
      "  --worker-prefix <prefix>    or WFP_DISPATCH_WORKER_PREFIX",
      "  --compatibility-date <YYYY-MM-DD>",
      "  --artifact-dir <path>       default crates/wfp-tenant/build/worker",
      "  --main-module <path>        default shim.mjs",
      "  --dry-run                   print redacted upload plan without PUT",
      "  --self-test-artifact-manifest  validate strict Rust/Wasm artifacts without network",
      "  --self-test-deploy-plan        validate fail-closed token handling without network",
      "  --json",
      "  Cloudflare AI bearer injection is owned by cinatoken-wfp-outbound; tenant token flags are rejected.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function collectArtifactModules(artifactDir, mainModule) {
  const info = await stat(artifactDir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(
      `WFP tenant artifact directory not found: ${relativePath(artifactDir)}. Run bun run build:wfp-tenant first.`,
    );
  }
  const files = await listFiles(artifactDir);
  if (files.length === 0) {
    throw new Error(`WFP tenant artifact directory is empty: ${relativePath(artifactDir)}`);
  }
  const modules = await Promise.all(
    files.map(async (file) => {
      const rel = path.relative(artifactDir, file).replaceAll(path.sep, "/");
      const bytes = await readFile(file);
      return {
        name: rel,
        bytes,
        sha256: sha256Hex(bytes),
        contentType: contentTypeFor(file),
      };
    }),
  );
  modules.sort((left, right) => left.name.localeCompare(right.name));
  validateRustWasmArtifact(modules, mainModule);
  return modules;
}

function validateRustWasmArtifact(modules, mainModule) {
  const main = modules.find((module) => module.name === mainModule);
  if (!main) {
    throw new Error(`main module ${mainModule} was not found in the artifact`);
  }
  if (main.bytes.length === 0) {
    throw new Error(`main module ${mainModule} is empty`);
  }

  const wasmModules = modules.filter((module) => module.name.endsWith(".wasm"));
  if (wasmModules.length === 0) {
    throw new Error(
      "Rust/Wasm artifact must include at least one .wasm module",
    );
  }
  for (const module of wasmModules) {
    if (module.bytes.length < 8 || !hasWasmMagic(module.bytes)) {
      throw new Error(
        `Wasm module ${module.name} must be nonempty and start with magic bytes 00 61 73 6d`,
      );
    }
  }

  let shimText;
  try {
    shimText = new TextDecoder("utf-8", { fatal: true }).decode(main.bytes);
  } catch {
    throw new Error(
      `main module ${mainModule} must contain valid UTF-8 shim text`,
    );
  }
  if (!wasmModules.some((module) => shimText.includes(module.name))) {
    throw new Error(
      `main module ${mainModule} must reference at least one uploaded .wasm module by name`,
    );
  }
}

function hasWasmMagic(bytes) {
  return wasmMagic.every((byte, index) => bytes[index] === byte);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      return entry.isFile() ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

function uploadMetadata({
  mainModule,
  compatibilityDate,
  tenantId,
  workerName,
  accountId,
}) {
  const bindings = [
    {
      name: "CINATOKEN_TENANT_ID",
      type: "plain_text",
      text: tenantId,
    },
    {
      name: "CF_ACCOUNT_ID",
      type: "plain_text",
      text: accountId,
    },
    {
      name: "CINATOKEN_WFP_WORKER_NAME",
      type: "plain_text",
      text: workerName,
    },
    {
      name: "CINATOKEN_WFP_OUTBOUND_AUTH_MODE",
      type: "plain_text",
      text: outboundAuthMode,
    },
  ];
  return {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
}

function redactMetadata(metadata) {
  return {
    ...metadata,
    bindings: metadata.bindings.map((binding) =>
      binding.type === "secret_text" ? { ...binding, text: "<redacted>" } : binding,
    ),
  };
}

function artifactWarnings() {
  return [];
}

function artifactManifest(options, modules) {
  const totalBytes = modules.reduce((sum, module) => sum + module.bytes.length, 0);
  return {
    runtime: "rust-wasm",
    buildCommand: "bun run build:wfp-tenant",
    artifactDir: relativePath(options.artifactDir),
    mainModule: options.mainModule,
    scanned: true,
    moduleCount: modules.length,
    totalBytes,
    mainModulePresent: modules.some((module) => module.name === options.mainModule),
    wasmModulePresent: modules.some((module) => module.name.endsWith(".wasm")),
    modules: modules.map((module) => ({
      name: module.name,
      bytes: module.bytes.length,
      sha256: module.sha256,
      contentType: module.contentType,
    })),
  };
}

function runArtifactManifestSelfTest() {
  const encode = (value) => new TextEncoder().encode(value);
  const validWasm = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ]);
  const options = {
    artifactDir: defaultArtifactDir,
    mainModule: defaultMainModule,
  };
  const module = (name, bytes, contentType = contentTypeFor(name)) => ({
    name,
    bytes,
    sha256: sha256Hex(bytes),
    contentType,
  });
  const cases = [];
  expectArtifactValidationFailure(
    "missing-main-shim",
    [module("index_bg.wasm", validWasm)],
    /main module shim\.mjs was not found/,
    cases,
  );
  expectArtifactValidationFailure(
    "missing-wasm",
    [module(defaultMainModule, encode('import "./index_bg.wasm";'))],
    /at least one \.wasm module/,
    cases,
  );
  expectArtifactValidationFailure(
    "fake-wasm",
    [
      module("index_bg.wasm", encode("not-wasm")),
      module(defaultMainModule, encode('import "./index_bg.wasm";')),
    ],
    /magic bytes 00 61 73 6d/,
    cases,
  );
  expectArtifactValidationFailure(
    "unreferenced-wasm",
    [
      module("index_bg.wasm", validWasm),
      module(defaultMainModule, encode("export default {};")),
    ],
    /must reference at least one uploaded \.wasm module/,
    cases,
  );
  const modules = [
    module("index_bg.wasm", validWasm),
    module(
      defaultMainModule,
      encode('import wasm from "./index_bg.wasm"; export default wasm;'),
    ),
  ];
  validateRustWasmArtifact(modules, defaultMainModule);
  cases.push({ name: "valid-rust-wasm", passed: true });
  const manifest = artifactManifest(options, modules);
  if (manifest.runtime !== "rust-wasm") {
    throw new Error("artifact manifest did not report rust-wasm runtime");
  }
  if (!manifest.mainModulePresent || !manifest.wasmModulePresent) {
    throw new Error("artifact manifest did not detect main and Wasm modules");
  }
  if (manifest.moduleCount !== 2 || manifest.totalBytes <= 0) {
    throw new Error("artifact manifest module summary is not complete");
  }
  for (const module of manifest.modules) {
    if (!/^[a-f0-9]{64}$/.test(module.sha256)) {
      throw new Error(`artifact manifest module ${module.name} has invalid sha256`);
    }
  }
  return {
    ok: true,
    artifactManifestSelfTest: true,
    cases,
    artifactManifest: manifest,
  };
}

function expectArtifactValidationFailure(name, modules, expected, cases) {
  try {
    validateRustWasmArtifact(modules, defaultMainModule);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message)) {
      throw new Error(`${name} failed with unexpected error: ${message}`);
    }
    cases.push({ name, passed: true });
    return;
  }
  throw new Error(`${name} artifact unexpectedly passed validation`);
}

function runDeployPlanSelfTest() {
  const cases = [];
  const outboundMetadata = selfTestUploadMetadata();
  if (
    outboundMetadata.bindings.some(
      (binding) => binding.name === "CF_API_TOKEN",
    ) ||
    !outboundMetadata.bindings.some(
      (binding) =>
        binding.name === "CINATOKEN_WFP_OUTBOUND_AUTH_MODE" &&
        binding.type === "plain_text" &&
        binding.text === outboundAuthMode,
    )
  ) {
    throw new Error(
      "tenant metadata did not enforce platform outbound authentication",
    );
  }
  cases.push({ name: "outbound-auth-without-tenant-token", passed: true });
  const authorityMetadata = selfTestUploadMetadata();
  if (
    !authorityMetadata.bindings.some(
      (binding) =>
        binding.name === "CINATOKEN_WFP_WORKER_NAME" &&
        binding.text === "tenant-smoke",
    )
  ) {
    throw new Error("tenant worker identity binding is missing");
  }
  const forbidden = new Set([
    "AI_GATEWAY_ID",
    ...routeGatewayBindings.map((binding) => binding.binding),
    ...aiGatewayPolicyBindings.map((binding) => binding.binding),
    "WFP_RELAY_AUTHORITY_KEY",
    "WFP_RELAY_AUTHORITY_SECRET",
    "WFP_AUTHORITY_REPLAY",
  ]);
  if (authorityMetadata.bindings.some((binding) => forbidden.has(binding.name))) {
    throw new Error("tenant metadata contains platform authority material");
  }
  cases.push({ name: "tenant-authority-material-absent", passed: true });
  return { ok: true, deployPlanSelfTest: true, cases };
}

function selfTestUploadMetadata() {
  return uploadMetadata({
    mainModule: defaultMainModule,
    compatibilityDate: defaultCompatibilityDate,
    tenantId: "tenant-smoke",
    workerName: "tenant-smoke",
    accountId: "00000000000000000000000000000000",
  });
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentTypeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".wasm":
      return "application/wasm";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function buildMultipartBody(boundary, metadata, modules) {
  const chunks = [];
  const encode = (value) => new TextEncoder().encode(value);
  chunks.push(
    encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
        metadata,
      )}\r\n`,
    ),
  );
  for (const module of modules) {
    const safeName = safeDispositionValue(module.name);
    chunks.push(
      encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${safeName}"\r\nContent-Type: ${module.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(module.bytes);
    chunks.push(encode("\r\n"));
  }
  chunks.push(encode(`--${boundary}--\r\n`));
  return new Blob(chunks);
}

function safeDispositionValue(value) {
  if (/["\r\n]/.test(value)) {
    throw new Error(`artifact module name is not safe for multipart upload: ${value}`);
  }
  return value;
}

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function validatePlainValue(value, name) {
  const trimmed = required(value, name);
  if (trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must be non-empty and header-safe`);
  }
  return trimmed;
}

function validateAccountId(value) {
  const trimmed = required(value, "account-id");
  if (trimmed.length > 128 || /[\u0000-\u001f\u007f/?#]/.test(trimmed)) {
    throw new Error("account-id is not valid");
  }
  return trimmed;
}

function validateCompatibilityDate(value) {
  const trimmed = required(value, "compatibility-date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("compatibility-date must use YYYY-MM-DD");
  }
  return trimmed;
}

function normalizeWorkerName(value) {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed.length > 63) return null;
  if (/^[-_]|[-_]$/.test(trimmed)) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function prefixedWorkerName(publicName, prefix) {
  const cleanPrefix = prefix?.trim() || "";
  if (!cleanPrefix) return publicName;
  if (!/^[a-zA-Z0-9_-]+$/.test(cleanPrefix)) return null;
  return normalizeWorkerName(`${cleanPrefix}${publicName}`);
}

function normalizeDispatchNamespace(value) {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function dispatchUploadUrl(accountId, namespace, scriptName) {
  return `${cloudflareApiBase}/accounts/${encodeURIComponent(
    accountId,
  )}/workers/dispatch/namespaces/${encodeURIComponent(
    namespace,
  )}/scripts/${encodeURIComponent(scriptName)}`;
}

function relativePath(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/") || ".";
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      result.dryRun ? "WFP tenant artifact deploy plan (dry-run)" : "WFP tenant artifact deploy result",
      `script: ${result.scriptName}`,
      `namespace: ${result.namespace}`,
      `upload_url: ${result.uploadUrl}`,
      `artifact_dir: ${result.artifactDir}`,
      `main_module: ${result.mainModule}`,
      `modules: ${result.moduleCount}`,
      ...(result.artifactManifest
        ? [
            `artifact_manifest_total_bytes: ${result.artifactManifest.totalBytes}`,
            `artifact_manifest_main_module_present: ${result.artifactManifest.mainModulePresent}`,
            `artifact_manifest_wasm_module_present: ${result.artifactManifest.wasmModulePresent}`,
          ]
        : []),
      ...(result.status ? [`status: ${result.status}`, `ok: ${result.ok}`] : []),
      ...(result.warnings.length
        ? ["warnings:", ...result.warnings.map((warning) => `  - ${warning}`)]
        : []),
    ].join("\n"),
  );
  if (result.cloudflareResponsePreview) {
    console.log("cloudflare_response_preview:");
    console.log(result.cloudflareResponsePreview);
  }
}

function printSelfTestResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.deployPlanSelfTest) {
    console.log(
      [
        "WFP tenant deploy-plan self-test",
        `ok: ${result.ok}`,
        ...result.cases.map(
          (testCase) => `${testCase.name}: ${testCase.passed}`,
        ),
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "WFP tenant artifact manifest self-test",
      `ok: ${result.ok}`,
      `runtime: ${result.artifactManifest.runtime}`,
      `modules: ${result.artifactManifest.moduleCount}`,
      `total_bytes: ${result.artifactManifest.totalBytes}`,
      `main_module_present: ${result.artifactManifest.mainModulePresent}`,
      `wasm_module_present: ${result.artifactManifest.wasmModulePresent}`,
      ...result.cases.map((testCase) => `${testCase.name}: ${testCase.passed}`),
    ].join("\n"),
  );
}
