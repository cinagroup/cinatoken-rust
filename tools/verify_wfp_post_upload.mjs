#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const schemaVersion = 2;
const expectedRuntime = "rust-wasm";
const expectedOutboundAuthMode = "platform-outbound-v1";
const expectedAuthorityVerifier = "platform-outbound-central-hmac-v3";
const expectedReplayGuard = "platform-outbound-durable-object-once-v3";
const expectedRoutes = [
  "/__cinatoken/tenant/status",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/ai/run",
];
const requiredBindings = new Map([
  ["CINATOKEN_TENANT_ID", "plain_text"],
  ["CF_ACCOUNT_ID", "plain_text"],
  ["CINATOKEN_WFP_WORKER_NAME", "plain_text"],
  ["CINATOKEN_WFP_OUTBOUND_AUTH_MODE", "plain_text"],
]);
const forbiddenTenantBindings = new Set([
  "AI_GATEWAY_ID",
  "AI_GATEWAY_ID_OPENAI_CHAT",
  "AI_GATEWAY_ID_OPENAI_RESPONSES",
  "AI_GATEWAY_ID_ANTHROPIC_MESSAGES",
  "AI_GATEWAY_ID_AI_RUN",
  "AI_GATEWAY_REQUEST_TIMEOUT_MS",
  "AI_GATEWAY_MAX_ATTEMPTS",
  "AI_GATEWAY_RETRY_DELAY_MS",
  "AI_GATEWAY_BACKOFF",
  "AI_GATEWAY_CACHE_TTL_SECONDS",
  "AI_GATEWAY_SKIP_CACHE",
  "AI_GATEWAY_COLLECT_LOG",
  "CF_API_TOKEN",
  "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "CINATOKEN_WFP_OUTBOUND_AI_TOKEN",
  "WFP_RELAY_AUTHORITY_KEY",
  "WFP_RELAY_AUTHORITY_SECRET",
  "WFP_AUTHORITY_REPLAY",
]);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test")) {
    printResult(await runSelfTest(), args.flags.has("json"));
  } else {
    const result = await verifyFromFiles(args);
    printResult(result, args.flags.has("json"));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "deploy-evidence",
    "readback-evidence",
    "dispatch-evidence",
  ]);
  const knownFlags = new Set(["dry-run", "json", "self-test"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) usage(2, `Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (knownFlags.has(key)) {
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, `Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage(2, `${arg} requires a value`);
    values.set(key, value);
  }

  if (flags.has("self-test") && values.size > 0) {
    usage(2, "--self-test does not accept evidence files");
  }
  return { values, flags };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/verify_wfp_post_upload.mjs --deploy-evidence <json> --readback-evidence <json> --dispatch-evidence <json> [--json]",
      "  bun tools/verify_wfp_post_upload.mjs --deploy-evidence <json> --dry-run [--json]",
      "  bun tools/verify_wfp_post_upload.mjs --self-test [--json]",
      "",
      "The verifier is evidence-only: it never accepts, reads, or prints Cloudflare tokens.",
      "An artifact/status pass requires a successful uploader result, Cloudflare details/settings/content readback, and a live status dispatch result.",
      "It does not verify paid egress, provider calls, billing, replay races, or production cutover.",
      "Content readback modules must include base64 bytes or a file path relative to the readback evidence file so hashes are recomputed.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function verifyFromFiles(args) {
  const deployPath = requiredOption(args, "deploy-evidence");
  const deploy = await readJsonEvidence(deployPath, "deploy evidence");
  const dryRun = args.flags.has("dry-run");
  const expected = validateDeployEvidence(deploy, { allowDryRun: dryRun });

  if (dryRun) {
    if (args.values.has("readback-evidence") || args.values.has("dispatch-evidence")) {
      throw new Error("[dry-run] readback and dispatch evidence are not consumed in dry-run mode");
    }
    return buildDryRunPlan(expected);
  }

  const readbackPath = requiredOption(args, "readback-evidence");
  const dispatchPath = requiredOption(args, "dispatch-evidence");
  const readback = await readJsonEvidence(readbackPath, "readback evidence");
  const dispatch = await readJsonEvidence(dispatchPath, "dispatch evidence");
  const readbackResult = await validateReadbackEvidence(
    readback,
    expected,
    path.dirname(path.resolve(readbackPath)),
  );
  const dispatchResult = validateDispatchEvidence(dispatch, expected);

  return {
    ok: true,
    schemaVersion,
    dryRun: false,
    verified: true,
    verificationScope: "wfp-tenant-artifact-and-status",
    paidEgressVerified: false,
    productionVerified: false,
    scriptName: expected.scriptName,
    publicScriptName: expected.publicScriptName,
    namespace: expected.namespace,
    tenantId: expected.tenantId,
    runtime: expectedRuntime,
    artifactDigestSha256: expected.artifactDigestSha256,
    moduleCount: expected.modules.length,
    bindingCount: expected.bindings.length,
    evidence: {
      uploadAccepted: true,
      scriptDetailsReadback: readbackResult.scriptDetails,
      settingsReadback: readbackResult.settings,
      contentReadback: readbackResult.content,
      dispatch: dispatchResult,
    },
  };
}

function requiredOption(args, key) {
  const value = args.values.get(key);
  if (!value) throw new Error(`[input] --${key} is required`);
  return value;
}

async function readJsonEvidence(file, label) {
  let text;
  try {
    text = await readFile(path.resolve(file), "utf8");
  } catch (error) {
    throw new Error(`[input] could not read ${label}: ${safeError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`[input] ${label} is not valid JSON: ${safeError(error)}`);
  }
}

function validateDeployEvidence(value, { allowDryRun }) {
  const deploy = requireObject(value, "[upload] deploy evidence");
  if (deploy.dryRun === true && !allowDryRun) {
    throw new Error("[upload] dry-run uploader evidence cannot prove a deployment");
  }
  if (deploy.dryRun !== true) {
    if (deploy.ok !== true || !isSuccessStatus(deploy.status)) {
      throw new Error("[upload] uploader result must report a successful 2xx upload");
    }
    const uploadEnvelope = requireCloudflareEnvelope(
      deploy.cloudflareResponseJson,
      "[upload] Cloudflare upload response",
    );
    if (uploadEnvelope.id !== deploy.scriptName) {
      throw new Error("[script] upload response script id did not match uploader scriptName");
    }
  }

  const scriptName = requireWorkerName(deploy.scriptName, "[script] scriptName");
  const publicScriptName = requireWorkerName(
    deploy.publicScriptName,
    "[script] publicScriptName",
  );
  const namespace = requireNamespace(deploy.namespace);
  const tenantId = requirePlainString(deploy.tenantId, "[upload] tenantId");
  const mainModule = requireModuleName(deploy.mainModule, "[module] mainModule");
  const manifest = requireObject(deploy.artifactManifest, "[module] artifactManifest");

  if (
    manifest.runtime !== expectedRuntime ||
    manifest.scanned !== true ||
    manifest.mainModule !== mainModule ||
    manifest.mainModulePresent !== true ||
    manifest.wasmModulePresent !== true
  ) {
    throw new Error("[module] artifact manifest did not prove a scanned Rust/Wasm artifact");
  }
  const modules = validateModuleManifest(manifest.modules, "[module] artifact manifest");
  const topLevelModules = validateModuleManifest(deploy.modules, "[module] uploader modules");
  compareModuleClaims(modules, topLevelModules, "[module] uploader manifest");
  if (
    manifest.moduleCount !== modules.length ||
    deploy.moduleCount !== modules.length ||
    manifest.totalBytes !== modules.reduce((sum, item) => sum + item.bytes, 0)
  ) {
    throw new Error("[module] artifact module counts or total bytes did not reconcile");
  }
  if (!modules.some((item) => item.name === mainModule)) {
    throw new Error("[module] main module was absent from the artifact manifest");
  }
  if (!modules.some((item) => item.name.endsWith(".wasm"))) {
    throw new Error("[module] artifact manifest did not include a Wasm module");
  }

  const metadata = requireObject(deploy.metadata, "[binding] upload metadata");
  if (metadata.main_module !== mainModule) {
    throw new Error("[script] upload metadata main_module did not match the artifact");
  }
  const compatibilityDate = requireDate(
    metadata.compatibility_date,
    "[script] compatibility_date",
  );
  const compatibilityFlags = sortedUniqueStrings(
    metadata.compatibility_flags,
    "[script] compatibility_flags",
  );
  const bindings = validateBindings(metadata.bindings, {
    label: "[binding] upload metadata",
    expected: true,
  });
  for (const binding of bindings) {
    if (forbiddenTenantBindings.has(binding.name)) {
      throw new Error(
        `[binding] tenant-visible ${binding.name} binding is forbidden`,
      );
    }
  }
  for (const [name, type] of requiredBindings) {
    const binding = bindings.find((item) => item.name === name);
    if (!binding || binding.type !== type) {
      throw new Error(`[binding] required ${name}:${type} binding was not uploaded`);
    }
  }
  assertPlainBinding(bindings, "CINATOKEN_TENANT_ID", tenantId);
  assertPlainBinding(bindings, "CINATOKEN_WFP_WORKER_NAME", publicScriptName);
  assertPlainBinding(
    bindings,
    "CINATOKEN_WFP_OUTBOUND_AUTH_MODE",
    expectedOutboundAuthMode,
  );
  if (Array.isArray(deploy.warnings) && deploy.warnings.length > 0 && !allowDryRun) {
    throw new Error("[upload] production upload evidence contains warnings");
  }

  return {
    scriptName,
    publicScriptName,
    namespace,
    tenantId,
    mainModule,
    compatibilityDate,
    compatibilityFlags,
    modules,
    bindings,
    artifactDigestSha256: artifactDigest(modules),
  };
}

function validateModuleManifest(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain modules`);
  }
  const names = new Set();
  return value
    .map((raw) => {
      const item = requireObject(raw, `${label} module`);
      const name = requireModuleName(item.name, `${label} module name`);
      if (names.has(name)) throw new Error(`[module] duplicate module name ${name}`);
      names.add(name);
      if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0) {
        throw new Error(`[module] ${name} must report positive bytes`);
      }
      if (!/^[a-f0-9]{64}$/.test(item.sha256 || "")) {
        throw new Error(`[hash] ${name} must report a lowercase SHA-256 digest`);
      }
      const contentType = normalizeContentType(item.contentType);
      return { name, bytes: item.bytes, sha256: item.sha256, contentType };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function compareModuleClaims(expected, actual, label) {
  if (expected.length !== actual.length) {
    throw new Error(`${label} module count mismatch`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      left.name !== right.name ||
      left.bytes !== right.bytes ||
      left.sha256 !== right.sha256 ||
      left.contentType !== right.contentType
    ) {
      throw new Error(`${label} mismatch for ${left.name}`);
    }
  }
}

async function validateReadbackEvidence(value, expected, evidenceDirectory) {
  const readback = requireObject(value, "[readback] evidence");
  if (readback.schemaVersion !== schemaVersion) {
    throw new Error(`[readback] schemaVersion must equal ${schemaVersion}`);
  }
  if (readback.source !== "cloudflare-wfp-readback") {
    throw new Error("[readback] source must equal cloudflare-wfp-readback");
  }
  requireTimestamp(readback.capturedAt, "[readback] capturedAt");

  const details = requireCloudflareEnvelope(
    readback.details,
    "[readback] script details",
  );
  const script = requireObject(details.script, "[readback] script details result.script");
  if (details.dispatch_namespace !== expected.namespace) {
    throw new Error("[script] details dispatch namespace mismatch");
  }
  validateScriptIdentity(script, expected, "[script] details");
  validateCompatibility(script, expected, "[script] details");

  const settings = requireCloudflareEnvelope(
    readback.settings,
    "[readback] script settings",
  );
  validateCompatibility(settings, expected, "[readback] settings");
  const readbackBindings = validateBindings(settings.bindings, {
    label: "[readback] settings bindings",
    expected: false,
  });
  compareBindings(expected.bindings, readbackBindings);

  const content = requireObject(readback.content, "[readback] content");
  if (content.ok !== true || !isSuccessStatus(content.status)) {
    throw new Error("[readback] content request must report a successful 2xx response");
  }
  if (!normalizeContentType(content.contentType).startsWith("multipart/form-data")) {
    throw new Error("[readback] content must be captured from the multipart script content API");
  }
  const contentMetadata = requireObject(content.metadata, "[readback] content metadata");
  if (contentMetadata.main_module !== expected.mainModule) {
    throw new Error("[module] content readback main_module mismatch");
  }
  validateCompatibility(contentMetadata, expected, "[readback] content metadata");
  const contentModules = await materializeContentModules(
    content.modules,
    evidenceDirectory,
  );
  compareModuleClaims(expected.modules, contentModules, "[hash] content readback");

  return {
    scriptDetails: true,
    settings: true,
    content: true,
  };
}

function validateScriptIdentity(value, expected, label) {
  if (value.id !== expected.scriptName) {
    throw new Error(`${label} script id mismatch`);
  }
}

function validateCompatibility(value, expected, label) {
  if (value.compatibility_date !== expected.compatibilityDate) {
    throw new Error(`${label} compatibility_date mismatch`);
  }
  const flags = sortedUniqueStrings(value.compatibility_flags, `${label} compatibility_flags`);
  if (JSON.stringify(flags) !== JSON.stringify(expected.compatibilityFlags)) {
    throw new Error(`${label} compatibility_flags mismatch`);
  }
}

async function materializeContentModules(value, evidenceDirectory) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("[readback] content modules must be a nonempty array");
  }
  const claims = [];
  const names = new Set();
  for (const raw of value) {
    const item = requireObject(raw, "[readback] content module");
    const name = requireModuleName(item.name, "[readback] content module name");
    if (names.has(name)) throw new Error(`[module] duplicate readback module ${name}`);
    names.add(name);
    const bytes = await readModuleBytes(item, evidenceDirectory, name);
    if (bytes.length === 0) throw new Error(`[readback] content module ${name} is empty`);
    claims.push({
      name,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      contentType: normalizeContentType(item.contentType),
    });
  }
  return claims.sort((left, right) => left.name.localeCompare(right.name));
}

async function readModuleBytes(item, evidenceDirectory, name) {
  const hasBase64 = typeof item.base64 === "string";
  const hasPath = typeof item.path === "string";
  if (hasBase64 === hasPath) {
    throw new Error(`[readback] module ${name} must provide exactly one of base64 or path`);
  }
  if (hasBase64) {
    if (!isCanonicalBase64(item.base64)) {
      throw new Error(`[readback] module ${name} has invalid base64 content`);
    }
    return Buffer.from(item.base64, "base64");
  }
  const relative = item.path.replaceAll("\\", "/");
  try {
    const root = await realpath(evidenceDirectory);
    const candidate = await realpath(path.resolve(evidenceDirectory, relative));
    const containment = path.relative(root, candidate);
    if (
      containment === "" ||
      containment === ".." ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment)
    ) {
      throw new Error("outside-evidence-directory");
    }
    return await readFile(candidate);
  } catch (error) {
    if (error instanceof Error && error.message === "outside-evidence-directory") {
      throw new Error(`[readback] module ${name} path must stay within the evidence directory`);
    }
    throw new Error(`[readback] could not read module ${name}: ${safeError(error)}`);
  }
}

function isCanonicalBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validateBindings(value, { label, expected }) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain bindings`);
  }
  const names = new Set();
  return value
    .map((raw) => {
      const binding = requireObject(raw, `${label} binding`);
      const name = requireBindingName(binding.name, `${label} name`);
      const type = requirePlainString(binding.type, `${label} ${name} type`);
      if (names.has(name)) throw new Error(`[binding] duplicate binding ${name}`);
      names.add(name);
      const normalized = { name, type };
      if (type === "plain_text") {
        normalized.text = requirePlainString(binding.text, `${label} ${name} text`);
      } else if (type === "secret_text") {
        if (expected && binding.text !== "<redacted>") {
          throw new Error(`[binding] expected secret ${name} must be redacted in evidence`);
        }
        if (!expected && binding.text != null && binding.text !== "<redacted>") {
          throw new Error(`[binding] readback secret ${name} must not expose a value`);
        }
      } else if (type === "durable_object_namespace") {
        normalized.className = requirePlainString(
          binding.class_name,
          `${label} ${name} class_name`,
        );
        const target = binding.script_name ?? binding.service;
        normalized.targetScript = requireWorkerName(
          target,
          `${label} ${name} target script`,
        );
      }
      return normalized;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function compareBindings(expected, actual) {
  if (expected.length !== actual.length) {
    throw new Error("[binding] settings binding count mismatch");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.name !== right.name || left.type !== right.type) {
      throw new Error(`[binding] settings binding mismatch near ${left.name}`);
    }
    if (left.type === "plain_text" && left.text !== right.text) {
      throw new Error(`[binding] plain-text binding ${left.name} mismatch`);
    }
    if (
      left.type === "durable_object_namespace" &&
      (left.className !== right.className || left.targetScript !== right.targetScript)
    ) {
      throw new Error(`[binding] Durable Object binding ${left.name} mismatch`);
    }
  }
}

function assertPlainBinding(bindings, name, expected) {
  const binding = bindings.find((item) => item.name === name);
  if (binding?.type !== "plain_text" || binding.text !== expected) {
    throw new Error(`[binding] ${name} did not match deployment identity`);
  }
}

function validateDispatchEvidence(value, expected) {
  const dispatch = requireObject(value, "[dispatch] evidence");
  if (
    dispatch.ok !== true ||
    dispatch.dryRun !== false ||
    dispatch.negative === true ||
    dispatch.skipCapabilities === true
  ) {
    throw new Error("[dispatch] evidence must be a successful live positive smoke with capabilities");
  }
  if (dispatch.worker !== expected.publicScriptName || dispatch.expectRuntime !== expectedRuntime) {
    throw new Error("[dispatch] worker or expected runtime mismatch");
  }
  const capabilities = requireObject(dispatch.capabilities, "[dispatch] capabilities");
  for (const key of [
    "wfp_dispatch_binding_available",
    "wfp_dispatch_enabled",
    "wfp_internal_dispatch_enabled",
    "wfp_dispatch_failure_contract_compiled",
    "wfp_tenant_script_plan_compiled",
    "wfp_tenant_route_manifest_compiled",
    "wfp_tenant_internal_dispatch_required_compiled",
    "wfp_tenant_response_header_guard_compiled",
  ]) {
    if (capabilities[key] !== true) {
      throw new Error(`[dispatch] capability ${key} was not true`);
    }
  }
  const status = requireObject(dispatch.status, "[dispatch] tenant status");
  if (
    status.runtime !== expectedRuntime ||
    status.tenantId !== expected.tenantId ||
    status.inboundDispatchRoute !== "internal-path" ||
    status.inboundDispatchWorker !== expected.publicScriptName ||
    status.paidAiCapable !== true ||
    status.paidAiAuthorityVerifier !== expectedAuthorityVerifier ||
    status.paidAiReplayGuard !== expectedReplayGuard ||
    status.tenantAuthorityReplayBindingBound !== false
  ) {
    throw new Error("[dispatch] tenant status identity or runtime mismatch");
  }
  assertExactRoutes(status.routes, "[dispatch] tenant route manifest");
  const headers = requireObject(dispatch.dispatchHeaders, "[dispatch] response headers");
  if (
    headers.route !== "internal-path" ||
    headers.worker !== expected.publicScriptName ||
    headers.tenant !== expected.tenantId ||
    headers.runtime !== expectedRuntime
  ) {
    throw new Error("[dispatch] response evidence headers mismatch");
  }
  const guard = requireObject(dispatch.responseHeaderGuard, "[dispatch] response header guard");
  if (guard.ok !== true || !Array.isArray(guard.forbiddenHeaders) || guard.forbiddenHeaders.length > 0) {
    throw new Error("[dispatch] response header guard did not pass cleanly");
  }
  return {
    live: true,
    runtime: expectedRuntime,
    internalPath: true,
    responseHeaderGuard: true,
  };
}

function assertExactRoutes(value, label) {
  const routes = sortedUniqueStrings(value, label);
  const expected = [...expectedRoutes].sort();
  if (JSON.stringify(routes) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function requireCloudflareEnvelope(value, label) {
  const envelope = requireObject(value, label);
  if (envelope.success !== true) throw new Error(`${label} did not report success=true`);
  if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) {
    throw new Error(`${label} must contain an empty errors array`);
  }
  return requireObject(envelope.result, `${label} result`);
}

function buildDryRunPlan(expected) {
  return {
    ok: true,
    schemaVersion,
    dryRun: true,
    verified: false,
    verificationScope: "wfp-tenant-artifact-and-status-plan",
    paidEgressVerified: false,
    productionVerified: false,
    credentialsRequired: false,
    scriptName: expected.scriptName,
    publicScriptName: expected.publicScriptName,
    namespace: expected.namespace,
    tenantId: expected.tenantId,
    artifactDigestSha256: expected.artifactDigestSha256,
    expected: {
      runtime: expectedRuntime,
      mainModule: expected.mainModule,
      moduleCount: expected.modules.length,
      bindingCount: expected.bindings.length,
      routes: expectedRoutes,
    },
    requiredEvidence: [
      "successful non-dry-run uploader JSON with Cloudflare upload envelope",
      "Cloudflare Worker Details GET envelope",
      "Cloudflare script Settings GET envelope with exact bindings",
      "Cloudflare multipart Content GET metadata and raw module bytes",
      "successful live WFP tenant status dispatch JSON",
    ],
  };
}

function artifactDigest(modules) {
  const canonical = modules.map((item) => ({
    name: item.name,
    bytes: item.bytes,
    sha256: item.sha256,
    contentType: item.contentType,
  }));
  return sha256Hex(Buffer.from(JSON.stringify(canonical), "utf8"));
}

function normalizeContentType(value) {
  return requirePlainString(value, "content type").trim().toLowerCase();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requirePlainString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a nonempty single-line string`);
  }
  return value;
}

function requireWorkerName(value, label) {
  const name = requirePlainString(value, label);
  if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name)) {
    throw new Error(`${label} must be a valid WFP worker name`);
  }
  return name;
}

function requireNamespace(value) {
  const namespace = requirePlainString(value, "[script] namespace");
  if (namespace.length > 64 || !/^[a-z0-9_-]+$/.test(namespace)) {
    throw new Error("[script] namespace must be a valid dispatch namespace");
  }
  return namespace;
}

function requireModuleName(value, label) {
  const name = requirePlainString(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(name) || name.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative module path`);
  }
  return name;
}

function requireBindingName(value, label) {
  const name = requirePlainString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} must be a valid binding name`);
  }
  return name;
}

function requireDate(value, label) {
  const date = requirePlainString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return date;
}

function requireTimestamp(value, label) {
  const timestamp = requirePlainString(value, label);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} must not contain duplicates`);
  return sorted;
}

function isSuccessStatus(value) {
  return Number.isInteger(value) && value >= 200 && value < 300;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeError(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof SyntaxError ? "invalid syntax" : "operation failed";
}

async function runSelfTest() {
  const fixture = selfTestFixture();
  const expected = validateDeployEvidence(fixture.deploy, { allowDryRun: false });
  await validateReadbackEvidence(fixture.readback, expected, process.cwd());
  validateDispatchEvidence(fixture.dispatch, expected);

  const cases = [{ name: "valid-artifact-status-evidence", passed: true }];
  await expectFailure(
    "script-mismatch",
    fixture,
    (copy) => {
      copy.readback.details.result.script.id = "wrong-script";
    },
    /\[script\].*id mismatch/,
    cases,
  );
  await expectFailure(
    "module-mismatch",
    fixture,
    (copy) => {
      copy.readback.content.modules.pop();
    },
    /\[hash\].*module count mismatch/,
    cases,
  );
  await expectFailure(
    "binding-mismatch",
    fixture,
    (copy) => {
      copy.readback.settings.result.bindings.find(
        (item) => item.name === "CINATOKEN_TENANT_ID",
      ).text = "wrong-tenant";
    },
    /\[binding\].*mismatch/,
    cases,
  );
  await expectFailure(
    "outbound-auth-mode-mismatch",
    fixture,
    (copy) => {
      copy.deploy.metadata.bindings.find(
        (item) => item.name === "CINATOKEN_WFP_OUTBOUND_AUTH_MODE",
      ).text = "tenant-token";
    },
    /\[binding\].*CINATOKEN_WFP_OUTBOUND_AUTH_MODE.*deployment identity/,
    cases,
  );
  for (const name of forbiddenTenantBindings) {
    await expectFailure(
      `tenant-visible-${name.toLowerCase()}-rejected`,
      fixture,
      (copy) => {
        copy.deploy.metadata.bindings.push({
          name,
          type: "secret_text",
          text: "<redacted>",
        });
      },
      new RegExp(`\\[binding\\].*${name}.*forbidden`),
      cases,
    );
  }
  await expectFailure(
    "hash-mismatch",
    fixture,
    (copy) => {
      copy.readback.content.modules.find((item) => item.name === "shim.mjs").base64 =
        Buffer.from("changed", "utf8").toString("base64");
    },
    /\[hash\].*mismatch/,
    cases,
  );
  await expectFailure(
    "readback-failure",
    fixture,
    (copy) => {
      copy.readback.settings.success = false;
    },
    /\[readback\].*success=true/,
    cases,
  );
  await expectFailure(
    "dispatch-mismatch",
    fixture,
    (copy) => {
      copy.dispatch.dispatchHeaders.worker = "wrong-worker";
    },
    /\[dispatch\].*headers mismatch/,
    cases,
  );

  const dryRunDeploy = structuredClone(fixture.deploy);
  dryRunDeploy.dryRun = true;
  delete dryRunDeploy.status;
  delete dryRunDeploy.ok;
  delete dryRunDeploy.cloudflareResponseJson;
  const dryExpected = validateDeployEvidence(dryRunDeploy, { allowDryRun: true });
  const plan = buildDryRunPlan(dryExpected);
  if (plan.verified !== false || plan.credentialsRequired !== false) {
    throw new Error("[self-test] dry-run plan claimed verification or credentials");
  }
  cases.push({ name: "credential-free-dry-run", passed: true });

  return {
    ok: true,
    schemaVersion,
    selfTest: true,
    cases,
    rejectedMismatchClasses: [
      "script",
      "module",
      "binding",
      "forbidden-binding",
      "hash",
      "readback",
      "dispatch",
    ],
  };
}

async function expectFailure(name, fixture, mutate, expectedError, cases) {
  const copy = structuredClone(fixture);
  mutate(copy);
  try {
    const expected = validateDeployEvidence(copy.deploy, { allowDryRun: false });
    await validateReadbackEvidence(copy.readback, expected, process.cwd());
    validateDispatchEvidence(copy.dispatch, expected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expectedError.test(message)) {
      throw new Error(`[self-test] ${name} failed with unexpected error: ${message}`);
    }
    cases.push({ name, passed: true });
    return;
  }
  throw new Error(`[self-test] ${name} unexpectedly passed`);
}

function selfTestFixture() {
  const shim = Buffer.from('import wasm from "./index_bg.wasm"; export default wasm;', "utf8");
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const modules = [
    moduleClaim("index_bg.wasm", wasm, "application/wasm"),
    moduleClaim("shim.mjs", shim, "application/javascript+module"),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const bindings = [
    { name: "CINATOKEN_TENANT_ID", type: "plain_text", text: "tenant-smoke" },
    { name: "CF_ACCOUNT_ID", type: "plain_text", text: "00000000000000000000000000000000" },
    { name: "CINATOKEN_WFP_WORKER_NAME", type: "plain_text", text: "tenant-smoke" },
    {
      name: "CINATOKEN_WFP_OUTBOUND_AUTH_MODE",
      type: "plain_text",
      text: expectedOutboundAuthMode,
    },
  ];
  const metadata = {
    main_module: "shim.mjs",
    compatibility_date: "2026-07-11",
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
  const cloudflareEnvelope = (result) => ({
    success: true,
    errors: [],
    messages: [],
    result,
  });
  const settingsBindings = bindings.map((binding) => {
    const copy = { ...binding };
    if (copy.type === "secret_text") delete copy.text;
    return copy;
  });
  const scriptDetails = {
    id: "tenant-smoke",
    compatibility_date: "2026-07-11",
    compatibility_flags: ["nodejs_compat"],
  };
  return {
    deploy: {
      dryRun: false,
      ok: true,
      status: 200,
      publicScriptName: "tenant-smoke",
      scriptName: "tenant-smoke",
      tenantId: "tenant-smoke",
      namespace: "cinatoken-rust-tenants-staging",
      mainModule: "shim.mjs",
      moduleCount: modules.length,
      modules,
      artifactManifest: {
        runtime: expectedRuntime,
        scanned: true,
        mainModule: "shim.mjs",
        moduleCount: modules.length,
        totalBytes: modules.reduce((sum, item) => sum + item.bytes, 0),
        mainModulePresent: true,
        wasmModulePresent: true,
        modules,
      },
      metadata,
      warnings: [],
      cloudflareResponseJson: cloudflareEnvelope({ id: "tenant-smoke" }),
    },
    readback: {
      schemaVersion,
      source: "cloudflare-wfp-readback",
      capturedAt: "2026-07-12T00:00:00.000Z",
      details: cloudflareEnvelope({
        dispatch_namespace: "cinatoken-rust-tenants-staging",
        script: scriptDetails,
      }),
      settings: cloudflareEnvelope({
        compatibility_date: "2026-07-11",
        compatibility_flags: ["nodejs_compat"],
        bindings: settingsBindings,
      }),
      content: {
        ok: true,
        status: 200,
        contentType: "multipart/form-data; boundary=self-test",
        metadata,
        modules: [
          { name: "index_bg.wasm", contentType: "application/wasm", base64: wasm.toString("base64") },
          { name: "shim.mjs", contentType: "application/javascript+module", base64: shim.toString("base64") },
        ],
      },
    },
    dispatch: {
      ok: true,
      dryRun: false,
      worker: "tenant-smoke",
      expectRuntime: expectedRuntime,
      skipCapabilities: false,
      capabilities: {
        wfp_dispatch_binding_available: true,
        wfp_dispatch_enabled: true,
        wfp_internal_dispatch_enabled: true,
        wfp_dispatch_failure_contract_compiled: true,
        wfp_tenant_script_plan_compiled: true,
        wfp_tenant_route_manifest_compiled: true,
        wfp_tenant_internal_dispatch_required_compiled: true,
        wfp_tenant_response_header_guard_compiled: true,
      },
      status: {
        runtime: expectedRuntime,
        tenantId: "tenant-smoke",
        inboundDispatchRoute: "internal-path",
        inboundDispatchWorker: "tenant-smoke",
        paidAiCapable: true,
        paidAiAuthorityVerifier: expectedAuthorityVerifier,
        paidAiReplayGuard: expectedReplayGuard,
        tenantAuthorityReplayBindingBound: false,
        routes: expectedRoutes,
      },
      dispatchHeaders: {
        route: "internal-path",
        worker: "tenant-smoke",
        tenant: "tenant-smoke",
        runtime: expectedRuntime,
      },
      responseHeaderGuard: { ok: true, forbiddenHeaders: [] },
    },
  };
}

function moduleClaim(name, bytes, contentType) {
  return { name, bytes: bytes.length, sha256: sha256Hex(bytes), contentType };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      result.selfTest ? "WFP post-upload verifier self-test" : "WFP post-upload verification",
      `ok: ${result.ok}`,
      ...(Object.hasOwn(result, "verified") ? [`verified: ${result.verified}`] : []),
      ...(Object.hasOwn(result, "dryRun") ? [`dry_run: ${result.dryRun}`] : []),
      ...(result.scriptName ? [`script: ${result.scriptName}`] : []),
      ...(result.namespace ? [`namespace: ${result.namespace}`] : []),
      ...(result.artifactDigestSha256
        ? [`artifact_digest_sha256: ${result.artifactDigestSha256}`]
        : []),
      ...(result.cases
        ? result.cases.map((item) => `${item.name}: ${item.passed}`)
        : []),
    ].join("\n"),
  );
}
