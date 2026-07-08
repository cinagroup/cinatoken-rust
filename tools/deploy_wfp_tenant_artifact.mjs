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
const defaultCompatibilityDate = "2026-06-17";
const cloudflareApiBase = "https://api.cloudflare.com/client/v4";
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
    key: "openaiEmbeddings",
    binding: "AI_GATEWAY_ID_OPENAI_EMBEDDINGS",
    flag: "ai-gateway-id-openai-embeddings",
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

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test-artifact-manifest")) {
    const result = runArtifactManifestSelfTest();
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
  const aiGatewayId = options.aiGatewayId
    ? validatePlainValue(options.aiGatewayId, "ai-gateway-id")
    : null;
  const routeAiGatewayIds = validateRouteGatewayIds(options.routeAiGatewayIds);
  const aiGatewayPolicy = validateAiGatewayPolicy(options.aiGatewayPolicy);
  const apiToken = required(options.apiToken, "api-token");
  const tenantApiToken =
    options.attachGatewayToken && options.tenantApiToken
      ? validatePlainValue(options.tenantApiToken, "tenant-api-token")
      : options.attachGatewayToken
        ? validatePlainValue(apiToken, "api-token")
        : null;

  const metadata = uploadMetadata({
    mainModule: options.mainModule,
    compatibilityDate,
    tenantId,
    accountId,
    aiGatewayId,
    routeAiGatewayIds,
    aiGatewayPolicy,
    tenantApiToken,
  });
  const uploadUrl = dispatchUploadUrl(accountId, namespace, scriptName);
  const modules = options.manifestOnly
    ? []
    : await collectArtifactModules(options.artifactDir, options.mainModule);

  if (options.dryRun || options.manifestOnly) {
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
      routeAiGatewayIdsConfigured: configuredRouteGatewayIds(routeAiGatewayIds),
      aiGatewayPolicyConfigured: configuredAiGatewayPolicy(aiGatewayPolicy),
      modules: modules.map((module) => ({
        name: module.name,
        bytes: module.bytes.length,
        sha256: module.sha256,
        contentType: module.contentType,
      })),
      metadata: redactMetadata(metadata),
      warnings: artifactWarnings(options, modules, apiToken, tenantApiToken),
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
    routeAiGatewayIdsConfigured: configuredRouteGatewayIds(routeAiGatewayIds),
    aiGatewayPolicyConfigured: configuredAiGatewayPolicy(aiGatewayPolicy),
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
    warnings: artifactWarnings(options, modules, apiToken, tenantApiToken),
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
      arg === "--manifest-only" ||
      arg === "--self-test-artifact-manifest"
    ) {
      flags.add(arg.slice(2));
      continue;
    }
    if (arg === "--no-attach-gateway-token") {
      flags.add("no-attach-gateway-token");
      continue;
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
    tenantApiToken:
      value("tenant-api-token", "WFP_TENANT_CF_API_TOKEN") ||
      value("tenant-api-token", "CLOUDFLARE_AI_GATEWAY_TOKEN"),
    aiGatewayId: value("ai-gateway-id", "AI_GATEWAY_ID"),
    routeAiGatewayIds: Object.fromEntries(
      routeGatewayBindings.map((binding) => [
        binding.key,
        value(binding.flag, binding.binding),
      ]),
    ),
    aiGatewayPolicy: Object.fromEntries(
      aiGatewayPolicyBindings.map((binding) => [
        binding.key,
        value(binding.flag, binding.binding),
      ]),
    ),
    compatibilityDate:
      value("compatibility-date", "WFP_TENANT_COMPATIBILITY_DATE") ||
      defaultCompatibilityDate,
    workerPrefix: value("worker-prefix", "WFP_DISPATCH_WORKER_PREFIX") || "",
    artifactDir,
    mainModule: args.values.get("main-module") || defaultMainModule,
    attachGatewayToken: !args.flags.has("no-attach-gateway-token"),
    dryRun: args.flags.has("dry-run"),
    json: args.flags.has("json"),
    manifestOnly: args.flags.has("manifest-only"),
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
      "  --tenant-api-token <token>  or WFP_TENANT_CF_API_TOKEN / CLOUDFLARE_AI_GATEWAY_TOKEN",
      "  --ai-gateway-id <id>        or AI_GATEWAY_ID",
      "  --ai-gateway-id-openai-chat <id>        or AI_GATEWAY_ID_OPENAI_CHAT",
      "  --ai-gateway-id-openai-responses <id>   or AI_GATEWAY_ID_OPENAI_RESPONSES",
      "  --ai-gateway-id-anthropic-messages <id> or AI_GATEWAY_ID_ANTHROPIC_MESSAGES",
      "  --ai-gateway-id-openai-embeddings <id>  or AI_GATEWAY_ID_OPENAI_EMBEDDINGS",
      "  --ai-gateway-id-ai-run <id>             or AI_GATEWAY_ID_AI_RUN",
      "  --ai-gateway-request-timeout-ms <ms>    or AI_GATEWAY_REQUEST_TIMEOUT_MS",
      "  --ai-gateway-max-attempts <1-5>         or AI_GATEWAY_MAX_ATTEMPTS",
      "  --ai-gateway-retry-delay-ms <1-5000>    or AI_GATEWAY_RETRY_DELAY_MS",
      "  --ai-gateway-backoff <constant|linear|exponential> or AI_GATEWAY_BACKOFF",
      "  --ai-gateway-cache-ttl-seconds <s>      or AI_GATEWAY_CACHE_TTL_SECONDS",
      "  --ai-gateway-skip-cache <true|false>    or AI_GATEWAY_SKIP_CACHE",
      "  --ai-gateway-collect-log <true|false>   or AI_GATEWAY_COLLECT_LOG",
      "  --worker-prefix <prefix>    or WFP_DISPATCH_WORKER_PREFIX",
      "  --compatibility-date <YYYY-MM-DD>",
      "  --artifact-dir <path>       default crates/wfp-tenant/build/worker",
      "  --main-module <path>        default shim.mjs",
      "  --dry-run                   print redacted upload plan without PUT",
      "  --manifest-only             skip artifact directory scan; dry-run style only",
      "  --self-test-artifact-manifest  validate local artifact manifest hashing without network",
      "  --json",
      "  --no-attach-gateway-token   omit CF_API_TOKEN binding from tenant metadata",
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
  if (!modules.some((module) => module.name === mainModule)) {
    throw new Error(
      `main module ${mainModule} was not found in ${relativePath(artifactDir)}`,
    );
  }
  return modules;
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
  accountId,
  aiGatewayId,
  routeAiGatewayIds,
  aiGatewayPolicy,
  tenantApiToken,
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
  ];
  if (aiGatewayId) {
    bindings.push({
      name: "AI_GATEWAY_ID",
      type: "plain_text",
      text: aiGatewayId,
    });
  }
  for (const binding of routeGatewayBindings) {
    const aiGatewayId = routeAiGatewayIds?.[binding.key];
    if (aiGatewayId) {
      bindings.push({
        name: binding.binding,
        type: "plain_text",
        text: aiGatewayId,
      });
    }
  }
  for (const binding of aiGatewayPolicyBindings) {
    const value = aiGatewayPolicy?.[binding.key];
    if (value) {
      bindings.push({
        name: binding.binding,
        type: "plain_text",
        text: value,
      });
    }
  }
  if (tenantApiToken) {
    bindings.push({
      name: "CF_API_TOKEN",
      type: "secret_text",
      text: tenantApiToken,
    });
  }
  return {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
}

function validateAiGatewayPolicy(values) {
  return Object.fromEntries(
    aiGatewayPolicyBindings.map((binding) => [
      binding.key,
      values?.[binding.key] ? validateAiGatewayPolicyValue(values[binding.key], binding) : null,
    ]),
  );
}

function validateAiGatewayPolicyValue(value, binding) {
  const trimmed = required(value, binding.flag).trim();
  if (binding.kind === "positive-integer") {
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`${binding.flag} must be a positive integer`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < binding.min) {
      throw new Error(`${binding.flag} must be at least ${binding.min}`);
    }
    if (binding.max && parsed > binding.max) {
      throw new Error(`${binding.flag} must be at most ${binding.max}`);
    }
    return String(parsed);
  }
  if (binding.kind === "boolean") {
    const lowered = trimmed.toLowerCase();
    if (lowered !== "true" && lowered !== "false") {
      throw new Error(`${binding.flag} must be true or false`);
    }
    return lowered;
  }
  if (binding.kind === "backoff") {
    const lowered = trimmed.toLowerCase();
    if (!["constant", "linear", "exponential"].includes(lowered)) {
      throw new Error(`${binding.flag} must be constant, linear, or exponential`);
    }
    return lowered;
  }
  return validatePlainValue(trimmed, binding.flag);
}

function validateRouteGatewayIds(values) {
  return Object.fromEntries(
    routeGatewayBindings.map((binding) => [
      binding.key,
      values?.[binding.key]
        ? validatePlainValue(values[binding.key], binding.flag)
        : null,
    ]),
  );
}

function configuredRouteGatewayIds(values) {
  return Object.fromEntries(
    routeGatewayBindings.map((binding) => [binding.key, Boolean(values?.[binding.key])]),
  );
}

function configuredAiGatewayPolicy(values) {
  return Object.fromEntries(
    aiGatewayPolicyBindings.map((binding) => [binding.key, Boolean(values?.[binding.key])]),
  );
}

function redactMetadata(metadata) {
  return {
    ...metadata,
    bindings: metadata.bindings.map((binding) =>
      binding.type === "secret_text" ? { ...binding, text: "<redacted>" } : binding,
    ),
  };
}

function artifactWarnings(options, modules, apiToken, tenantApiToken) {
  const warnings = [];
  if (options.manifestOnly) {
    warnings.push("manifest-only mode skipped artifact directory scanning");
  }
  if (options.attachGatewayToken && !options.tenantApiToken) {
    warnings.push(
      "tenant CF_API_TOKEN binding uses the deployment token; prefer WFP_TENANT_CF_API_TOKEN or CLOUDFLARE_AI_GATEWAY_TOKEN for staging/prod",
    );
  }
  if (!options.attachGatewayToken) {
    warnings.push("tenant CF_API_TOKEN binding omitted; runtime will fail closed until attached");
  }
  if (!options.manifestOnly && modules.length === 0) {
    warnings.push("no artifact modules were attached");
  }
  if (options.tenantApiToken && tenantApiToken && apiToken === tenantApiToken) {
    warnings.push("deployment token and tenant runtime token are the same value");
  }
  return warnings;
}

function artifactManifest(options, modules) {
  const totalBytes = modules.reduce((sum, module) => sum + module.bytes.length, 0);
  return {
    runtime: "rust-wasm",
    buildCommand: "bun run build:wfp-tenant",
    artifactDir: relativePath(options.artifactDir),
    mainModule: options.mainModule,
    scanned: !options.manifestOnly,
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
  const options = {
    artifactDir: defaultArtifactDir,
    mainModule: defaultMainModule,
    manifestOnly: false,
  };
  const modules = [
    {
      name: "index_bg.wasm",
      bytes: encode("wasm-bytes"),
      sha256: sha256Hex(encode("wasm-bytes")),
      contentType: "application/wasm",
    },
    {
      name: defaultMainModule,
      bytes: encode("export default {};"),
      sha256: sha256Hex(encode("export default {};")),
      contentType: "application/javascript+module",
    },
  ];
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
    artifactManifest: manifest,
  };
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
  console.log(
    [
      "WFP tenant artifact manifest self-test",
      `ok: ${result.ok}`,
      `runtime: ${result.artifactManifest.runtime}`,
      `modules: ${result.artifactManifest.moduleCount}`,
      `total_bytes: ${result.artifactManifest.totalBytes}`,
      `main_module_present: ${result.artifactManifest.mainModulePresent}`,
      `wasm_module_present: ${result.artifactManifest.wasmModulePresent}`,
    ].join("\n"),
  );
}
