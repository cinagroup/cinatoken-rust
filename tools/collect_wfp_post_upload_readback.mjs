#!/usr/bin/env bun

import { TextDecoder } from "node:util";

const schemaVersion = 1;
const cloudflareApiBase = "https://api.cloudflare.com/client/v4";
const replacementTokenEnv = "CINATOKEN_WFP_READBACK_TOKEN";
const requestTimeoutMs = 30_000;
const maxJsonBytes = 1024 * 1024;
const maxContentBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const maxModuleBytes = 16 * 1024 * 1024;
const maxPartCount = 128;
const maxHeaderBytes = 32 * 1024;

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.flags.has("self-test")) {
    result = await runSelfTest();
  } else {
    const identity = normalizeIdentity(args);
    if (args.flags.has("dry-run")) {
      result = buildDryRun(identity);
    } else {
      requireLiveConfirmation(args);
      const apiToken = requireReplacementToken(
        process.env[replacementTokenEnv],
      );
      result = await collectReadback({ ...identity, apiToken });
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "[collector] operation failed",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set(["account-id", "namespace", "script-name"]);
  const knownFlags = new Set([
    "confirm-readback",
    "confirm-replacement-token",
    "dry-run",
    "self-test",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) usage(2, `[input] unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (knownFlags.has(key)) {
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, `[input] unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      usage(2, `[input] ${arg} requires a value`);
    if (values.has(key)) usage(2, `[input] ${arg} must not be repeated`);
    values.set(key, value);
  }

  if (flags.has("self-test") && (values.size > 0 || flags.size > 1)) {
    usage(2, "[input] --self-test does not accept any other options");
  }
  if (flags.has("dry-run") && flags.has("self-test")) {
    usage(2, "[input] --dry-run and --self-test are mutually exclusive");
  }
  return { values, flags };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/collect_wfp_post_upload_readback.mjs --account-id <id> --namespace <name> --script-name <name> --confirm-readback --confirm-replacement-token",
      "  bun tools/collect_wfp_post_upload_readback.mjs --account-id <id> --namespace <name> --script-name <name> --dry-run",
      "  bun tools/collect_wfp_post_upload_readback.mjs --self-test",
      "",
      "Live collection reads only CINATOKEN_WFP_READBACK_TOKEN. The token must be a rotated replacement credential.",
      "CLOUDFLARE_ACCOUNT_ID, WFP_DISPATCH_NAMESPACE, and WFP_TENANT_SCRIPT_NAME may replace identity flags.",
      "The collector writes no files and emits one verifier-compatible, redacted JSON object to stdout.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function normalizeIdentity(args) {
  const accountId =
    args.values.get("account-id") || process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespace =
    args.values.get("namespace") || process.env.WFP_DISPATCH_NAMESPACE;
  const scriptName =
    args.values.get("script-name") || process.env.WFP_TENANT_SCRIPT_NAME;
  return {
    accountId: requireAccountId(accountId),
    namespace: requireNamespace(namespace),
    scriptName: requireWorkerName(scriptName),
  };
}

function requireLiveConfirmation(args) {
  if (!args.flags.has("confirm-readback")) {
    throw new Error(
      "[confirmation] live collection requires --confirm-readback",
    );
  }
  if (!args.flags.has("confirm-replacement-token")) {
    throw new Error(
      "[confirmation] live collection requires --confirm-replacement-token after credential rotation",
    );
  }
}

function requireReplacementToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096) {
    throw new Error(
      `[credentials] ${replacementTokenEnv} must contain a replacement token`,
    );
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(
      `[credentials] ${replacementTokenEnv} contains invalid characters`,
    );
  }
  return value;
}

function buildDryRun(identity) {
  return {
    ok: true,
    schemaVersion,
    dryRun: true,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    source: "cloudflare-wfp-readback",
    identity: {
      accountId: redactAccountId(identity.accountId),
      namespace: identity.namespace,
      scriptName: identity.scriptName,
    },
    requests: ["details-before", "settings", "content", "details-after"],
    limits: {
      jsonBytes: maxJsonBytes,
      contentBytes: maxContentBytes,
      metadataBytes: maxMetadataBytes,
      moduleBytes: maxModuleBytes,
      partCount: maxPartCount,
    },
  };
}

async function collectReadback(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || (() => new Date());
  if (typeof fetchImpl !== "function")
    throw new Error("[collector] fetch is unavailable");

  const baseUrl = scriptUrl(options);
  const detailsBefore = await fetchJson(
    `${baseUrl}`,
    "details-before",
    options.apiToken,
    fetchImpl,
  );
  const beforeIdentity = validateDetails(
    detailsBefore,
    options,
    "details-before",
  );
  const settings = await fetchJson(
    `${baseUrl}/settings`,
    "settings",
    options.apiToken,
    fetchImpl,
  );
  validateSettings(settings, beforeIdentity);
  const contentResponse = await fetchBounded(
    `${baseUrl}/content`,
    "content",
    options.apiToken,
    maxContentBytes,
    fetchImpl,
  );
  const content = await normalizeContent(
    contentResponse,
    beforeIdentity,
    options.apiToken,
  );
  const detailsAfter = await fetchJson(
    `${baseUrl}`,
    "details-after",
    options.apiToken,
    fetchImpl,
  );
  const afterIdentity = validateDetails(detailsAfter, options, "details-after");
  if (stableJson(beforeIdentity) !== stableJson(afterIdentity)) {
    throw new Error(
      "[identity] script changed while readback was being collected",
    );
  }

  const evidence = {
    schemaVersion,
    source: "cloudflare-wfp-readback",
    capturedAt: requireTimestamp(now()),
    details: normalizeDetailsEnvelope(detailsAfter, afterIdentity),
    settings: normalizeSettingsEnvelope(settings, beforeIdentity),
    content,
  };
  assertCredentialAbsent(evidence, options.apiToken);
  return evidence;
}

function scriptUrl(options) {
  return `${cloudflareApiBase}/accounts/${encodeURIComponent(options.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(options.namespace)}/scripts/${encodeURIComponent(options.scriptName)}`;
}

async function fetchJson(url, label, apiToken, fetchImpl) {
  const response = await fetchBounded(
    url,
    label,
    apiToken,
    maxJsonBytes,
    fetchImpl,
  );
  if (!isJsonContentType(response.contentType)) {
    throw new Error(`[${label}] expected an application/json response`);
  }
  let value;
  try {
    value = JSON.parse(response.bytes.toString("utf8"));
  } catch {
    throw new Error(`[${label}] response was not valid JSON`);
  }
  return requireCloudflareEnvelope(value, label);
}

async function fetchBounded(url, label, apiToken, limit, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept:
          label === "content" ? "multipart/form-data" : "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new Error(`[${label}] request failed`);
  }

  try {
    if (
      response.redirected ||
      response.url !== url ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new Error(`[${label}] redirects are forbidden`);
    }
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(`[${label}] Cloudflare returned a non-2xx status`);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength != null) {
      if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit) {
        throw new Error(`[${label}] response exceeded the byte limit`);
      }
    }
    const bytes = await readBoundedBody(response.body, limit, label);
    if (bytes.length === 0)
      throw new Error(`[${label}] response body was empty`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(body, limit, label) {
  if (!body || typeof body.getReader !== "function") {
    throw new Error(`[${label}] response body was unavailable`);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new Error(`[${label}] malformed body stream`);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`[${label}] response exceeded the byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function requireCloudflareEnvelope(value, label) {
  const envelope = requireObject(value, `[${label}] envelope`);
  if (envelope.success !== true)
    throw new Error(`[${label}] envelope did not report success=true`);
  if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) {
    throw new Error(`[${label}] envelope contained errors`);
  }
  if (!Array.isArray(envelope.messages)) {
    throw new Error(`[${label}] envelope messages must be an array`);
  }
  requireObject(envelope.result, `[${label}] result`);
  return envelope;
}

function validateDetails(envelope, expected, label) {
  const result = requireObject(envelope.result, `[${label}] result`);
  const script = requireObject(result.script, `[${label}] result.script`);
  if (
    result.dispatch_namespace !== expected.namespace ||
    script.id !== expected.scriptName
  ) {
    throw new Error(
      `[identity] ${label} did not match the requested namespace and script`,
    );
  }
  const etag = optionalSingleLine(script.etag, `[${label}] etag`);
  const modifiedOn = optionalTimestamp(
    script.modified_on || result.modified_on,
    `[${label}] modified_on`,
  );
  if (etag == null && modifiedOn == null) {
    throw new Error(
      `[identity] ${label} lacked an etag or modified_on stability marker`,
    );
  }
  return {
    namespace: result.dispatch_namespace,
    scriptName: script.id,
    compatibilityDate: requireDate(
      script.compatibility_date,
      `[${label}] compatibility_date`,
    ),
    compatibilityFlags: requireStringArray(
      script.compatibility_flags ?? [],
      `[${label}] compatibility_flags`,
    ),
    etag,
    modifiedOn,
  };
}

function validateSettings(envelope, identity) {
  const result = requireObject(envelope.result, "[settings] result");
  validateCompatibility(result, identity, "settings");
  if (!Array.isArray(result.bindings))
    throw new Error("[settings] bindings must be an array");
  const names = new Set();
  for (const raw of result.bindings) {
    const binding = requireObject(raw, "[settings] binding");
    const name = requireBindingName(binding.name, "[settings] binding name");
    if (names.has(name))
      throw new Error(`[settings] duplicate binding ${name}`);
    names.add(name);
    requireSingleLine(binding.type, `[settings] ${name} type`);
  }
}

async function normalizeContent(response, identity, apiToken) {
  const boundary = requireMultipartBoundary(response.contentType);
  const parts = parseMultipart(response.bytes, boundary);
  const metadataParts = parts.filter((part) => part.name === "metadata");
  if (metadataParts.length !== 1)
    throw new Error("[content] multipart must contain one metadata part");
  const metadataPart = metadataParts[0];
  if (metadataPart.bytes.length > maxMetadataBytes) {
    throw new Error("[content] metadata exceeded the byte limit");
  }
  if (!isJsonContentType(metadataPart.contentType)) {
    throw new Error("[content] metadata part must be application/json");
  }
  let metadata;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      metadataPart.bytes,
    );
    metadata = JSON.parse(text);
  } catch {
    throw new Error("[content] metadata part was not valid UTF-8 JSON");
  }
  requireObject(metadata, "[content] metadata");
  validateCompatibility(metadata, identity, "content metadata");
  const mainModule = requireModuleName(
    metadata.main_module,
    "[content] main_module",
  );

  const modules = [];
  const names = new Set();
  for (const part of parts) {
    if (part.name === "metadata") continue;
    const name = requireModuleName(part.name, "[content] module name");
    if (names.has(name)) throw new Error(`[content] duplicate module ${name}`);
    names.add(name);
    if (
      part.filename != null &&
      requireModuleName(part.filename, "[content] filename") !== name
    ) {
      throw new Error(
        `[identity] module part name and filename drifted for ${name}`,
      );
    }
    if (part.bytes.length === 0 || part.bytes.length > maxModuleBytes) {
      throw new Error(`[content] module ${name} violated the byte limit`);
    }
    if (part.bytes.includes(Buffer.from(apiToken, "utf8"))) {
      throw new Error(
        `[content] module ${name} contained the collector credential`,
      );
    }
    modules.push({
      name,
      contentType: requireSingleLine(
        part.contentType,
        `[content] ${name} content type`,
      ).toLowerCase(),
      base64: part.bytes.toString("base64"),
    });
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  if (modules.length === 0 || !names.has(mainModule)) {
    throw new Error(
      "[identity] content did not include its declared main module",
    );
  }

  return {
    ok: true,
    status: response.status,
    contentType: response.contentType,
    metadata: redactSecrets({
      ...metadata,
      compatibility_flags: identity.compatibilityFlags,
    }),
    modules,
  };
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, "ascii");
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`, "ascii");
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw new Error("[content] multipart body did not start with its boundary");
  }
  const parts = [];
  let cursor = delimiter.length;
  while (true) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      cursor += 2;
      if (body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n")))
        cursor += 2;
      if (cursor !== body.length)
        throw new Error("[content] bytes followed the closing boundary");
      break;
    }
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("[content] malformed multipart boundary framing");
    }
    cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor, "ascii");
    if (headerEnd < 0 || headerEnd - cursor > maxHeaderBytes) {
      throw new Error("[content] malformed or oversized multipart headers");
    }
    const headers = parsePartHeaders(body.subarray(cursor, headerEnd));
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0)
      throw new Error("[content] multipart part was not terminated");
    parts.push({ ...headers, bytes: body.subarray(contentStart, contentEnd) });
    if (parts.length > maxPartCount)
      throw new Error("[content] multipart part count exceeded the limit");
    cursor = contentEnd + 2 + delimiter.length;
  }
  if (parts.length === 0)
    throw new Error("[content] multipart body contained no parts");
  return parts;
}

function parsePartHeaders(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("[content] multipart headers were not valid UTF-8");
  }
  const headers = new Map();
  for (const line of text.split("\r\n")) {
    if (/^[ \t]/.test(line))
      throw new Error("[content] folded multipart headers are forbidden");
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("[content] malformed multipart header");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (
      !/^[a-z0-9-]+$/.test(name) ||
      !value ||
      /[\r\n\0]/.test(value) ||
      headers.has(name)
    ) {
      throw new Error("[content] malformed or duplicate multipart header");
    }
    headers.set(name, value);
  }
  const disposition = parseContentDisposition(
    headers.get("content-disposition"),
  );
  const contentType = headers.get("content-type");
  if (!contentType)
    throw new Error("[content] multipart part omitted Content-Type");
  return { ...disposition, contentType };
}

function parseContentDisposition(value) {
  if (typeof value !== "string")
    throw new Error("[content] multipart part omitted Content-Disposition");
  const segments = splitHeaderParameters(value);
  if (segments.shift()?.toLowerCase() !== "form-data") {
    throw new Error(
      "[content] multipart Content-Disposition must be form-data",
    );
  }
  const parameters = new Map();
  for (const segment of segments) {
    const match = /^([A-Za-z0-9_-]+)="([ !#-\[\]-~]*)"$/.exec(segment.trim());
    if (
      !match ||
      parameters.has(match[1].toLowerCase()) ||
      match[2].includes("\\")
    ) {
      throw new Error("[content] malformed Content-Disposition parameter");
    }
    parameters.set(match[1].toLowerCase(), match[2]);
  }
  const name = parameters.get("name");
  if (!name) throw new Error("[content] multipart part omitted its name");
  return { name, filename: parameters.get("filename") ?? null };
}

function splitHeaderParameters(value) {
  const segments = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (value[index] === ";" && !quoted) {
      segments.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) throw new Error("[content] unterminated quoted header parameter");
  segments.push(value.slice(start).trim());
  return segments;
}

function requireMultipartBoundary(contentType) {
  const match =
    /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s\r\n]{1,70}))\s*$/i.exec(
      contentType,
    );
  const boundary = match?.[1] || match?.[2];
  if (
    !boundary ||
    !/^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)
  ) {
    throw new Error("[content] response lacked a valid multipart boundary");
  }
  return boundary;
}

function validateCompatibility(value, identity, label) {
  const date = requireDate(
    value.compatibility_date,
    `[${label}] compatibility_date`,
  );
  const flags = requireStringArray(
    value.compatibility_flags ?? [],
    `[${label}] compatibility_flags`,
  );
  if (
    date !== identity.compatibilityDate ||
    stableJson(flags) !== stableJson(identity.compatibilityFlags)
  ) {
    throw new Error(`[identity] ${label} compatibility settings drifted`);
  }
}

function normalizeDetailsEnvelope(envelope, identity) {
  const result = envelope.result;
  return sanitizeEnvelope({
    ...envelope,
    result: {
      ...result,
      script: {
        ...result.script,
        compatibility_flags: identity.compatibilityFlags,
      },
    },
  });
}

function normalizeSettingsEnvelope(envelope, identity) {
  return sanitizeEnvelope({
    ...envelope,
    result: {
      ...envelope.result,
      compatibility_flags: identity.compatibilityFlags,
    },
  });
}

function sanitizeEnvelope(envelope) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: redactSecrets(envelope.result),
  };
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const result = {};
  const secretBinding = value.type === "secret_text";
  for (const [key, child] of Object.entries(value)) {
    if (secretBinding && key === "text") {
      result[key] = "<redacted>";
    } else if (isSensitiveKey(key)) {
      result[key] = "<redacted>";
    } else {
      result[key] = redactSecrets(child);
    }
  }
  return result;
}

function isSensitiveKey(key) {
  return (
    /^(authorization|password|jwt)$/i.test(key) ||
    /(?:^|[_-])(?:api[_-]?key|token|secret|password|credential|jwt)(?:$|[_-])/i.test(
      key,
    )
  );
}

function assertCredentialAbsent(value, apiToken) {
  const serialized = JSON.stringify(value);
  const encoded = Buffer.from(apiToken, "utf8").toString("base64");
  if (serialized.includes(apiToken) || serialized.includes(encoded)) {
    throw new Error(
      "[redaction] collector credential appeared in output evidence",
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAccountId(value) {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{32}$/.test(value)) {
    throw new Error(
      "[input] account-id must be a 32-character account identifier",
    );
  }
  return value;
}

function requireNamespace(value) {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^[a-z0-9_-]+$/.test(value)
  ) {
    throw new Error("[input] namespace must be a valid dispatch namespace");
  }
  return value;
}

function requireWorkerName(value) {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error("[input] script-name must be a valid WFP worker name");
  }
  return value;
}

function requireModuleName(value, label) {
  const name = requireSingleLine(value, label).replaceAll("\\", "/");
  if (
    name.length > 512 ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative module path`);
  }
  return name;
}

function requireBindingName(value, label) {
  const name = requireSingleLine(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`${label} was invalid`);
  return name;
}

function requireSingleLine(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${label} must be a nonempty single-line string`);
  }
  return value;
}

function requireDate(value, label) {
  const date = requireSingleLine(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`))
  ) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return date;
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || /[\r\n\0]/.test(item))
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length)
    throw new Error(`${label} contained duplicates`);
  return sorted;
}

function optionalSingleLine(value, label) {
  return value == null ? null : requireSingleLine(value, label);
}

function optionalTimestamp(value, label) {
  if (value == null) return null;
  const text = requireSingleLine(value, label);
  if (Number.isNaN(Date.parse(text)))
    throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function requireTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("[collector] clock returned an invalid timestamp");
  }
  return value.toISOString();
}

function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function redactAccountId(value) {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function runSelfTest() {
  const cases = [];
  const fixture = selfTestFixture();
  const valid = await collectReadback(fixture.options, {
    fetchImpl: queueFetch(fixture.responses),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
  });
  if (
    valid.source !== "cloudflare-wfp-readback" ||
    valid.content.modules.length !== 2 ||
    valid.settings.result.bindings[0].text !== "<redacted>" ||
    JSON.stringify(valid).includes(fixture.secretValue) ||
    JSON.stringify(valid).includes(fixture.options.apiToken)
  ) {
    throw new Error(
      "[self-test] valid evidence was not verifier-compatible and redacted",
    );
  }
  cases.push({ name: "valid-redacted-evidence", passed: true });
  assertVerifierReadbackShape(valid, fixture.options);
  cases.push({ name: "verifier-readback-contract", passed: true });

  await expectCollectionFailure(
    "redirect",
    fixture,
    (responses) => {
      responses[0] = fakeResponse("", {
        status: 302,
        contentType: "text/plain",
      });
    },
    /redirects are forbidden/,
    cases,
  );
  await expectCollectionFailure(
    "non-2xx",
    fixture,
    (responses) => {
      responses[1] = fakeResponse("denied", {
        status: 403,
        contentType: "text/plain",
      });
    },
    /non-2xx/,
    cases,
  );
  await expectCollectionFailure(
    "malformed-envelope",
    fixture,
    (responses) => {
      responses[1] = jsonResponse({ success: true, errors: [], messages: [] });
    },
    /result.*object/,
    cases,
  );
  await expectCollectionFailure(
    "malformed-multipart",
    fixture,
    (responses) => {
      responses[2] = fakeResponse("not multipart", {
        status: 200,
        contentType: "multipart/form-data; boundary=broken",
      });
    },
    /did not start with its boundary/,
    cases,
  );
  await expectCollectionFailure(
    "declared-size-limit",
    fixture,
    (responses) => {
      responses[1] = jsonResponse(fixture.settingsEnvelope, {
        contentLength: maxJsonBytes + 1,
      });
    },
    /byte limit/,
    cases,
  );
  await expectCollectionFailure(
    "streamed-size-limit",
    fixture,
    (responses) => {
      responses[1] = fakeResponse(Buffer.alloc(maxJsonBytes + 1, 1), {
        status: 200,
        contentType: "application/json",
      });
    },
    /byte limit/,
    cases,
  );
  await expectCollectionFailure(
    "part-count-limit",
    fixture,
    (responses) => {
      const parts = [
        {
          name: "metadata",
          contentType: "application/json",
          bytes: fixture.metadata,
        },
      ];
      for (let index = 0; index < maxPartCount; index += 1) {
        parts.push({
          name: `module-${index}.mjs`,
          contentType: "application/javascript+module",
          bytes: "x",
        });
      }
      responses[2] = multipartResponse(parts);
    },
    /part count/,
    cases,
  );
  await expectCollectionFailure(
    "module-size-limit",
    fixture,
    (responses) => {
      responses[2] = multipartResponse([
        {
          name: "metadata",
          contentType: "application/json",
          bytes: fixture.metadata,
        },
        {
          name: "shim.mjs",
          contentType: "application/javascript+module",
          bytes: Buffer.alloc(maxModuleBytes + 1, 1),
        },
      ]);
    },
    /module.*byte limit/,
    cases,
  );
  await expectCollectionFailure(
    "identity-drift",
    fixture,
    (responses) => {
      const changed = structuredClone(fixture.detailsEnvelope);
      changed.result.script.etag = "etag-two";
      responses[3] = jsonResponse(changed);
    },
    /script changed/,
    cases,
  );
  await expectCollectionFailure(
    "compatibility-drift",
    fixture,
    (responses) => {
      const changed = structuredClone(fixture.settingsEnvelope);
      changed.result.compatibility_date = "2026-07-11";
      responses[1] = jsonResponse(changed);
    },
    /compatibility settings drifted/,
    cases,
  );
  await expectCollectionFailure(
    "credential-echo-rejected",
    fixture,
    (responses) => {
      const changed = structuredClone(fixture.settingsEnvelope);
      changed.result.debug = fixture.options.apiToken;
      responses[1] = jsonResponse(changed);
    },
    /collector credential appeared in output evidence/,
    cases,
  );
  await expectCollectionFailure(
    "module-credential-rejected",
    fixture,
    (responses) => {
      responses[2] = multipartResponse([
        {
          name: "metadata",
          contentType: "application/json",
          bytes: fixture.metadata,
        },
        {
          name: "shim.mjs",
          contentType: "application/javascript+module",
          bytes: fixture.options.apiToken,
        },
      ]);
    },
    /module shim\.mjs contained the collector credential/,
    cases,
  );

  const dryRun = buildDryRun(fixture.options);
  if (
    dryRun.networkRequests ||
    dryRun.credentialsRead ||
    JSON.stringify(dryRun).includes(fixture.options.apiToken)
  ) {
    throw new Error("[self-test] dry-run accessed credentials or network");
  }
  cases.push({ name: "credential-free-dry-run", passed: true });

  return { ok: true, schemaVersion, selfTest: true, cases };
}

function assertVerifierReadbackShape(value, expected) {
  if (
    value.schemaVersion !== schemaVersion ||
    value.source !== "cloudflare-wfp-readback" ||
    Number.isNaN(Date.parse(value.capturedAt))
  ) {
    throw new Error("[self-test] verifier evidence header was invalid");
  }
  const details = requireCloudflareEnvelope(value.details, "self-test-details");
  const identity = validateDetails(details, expected, "self-test-details");
  const settings = requireCloudflareEnvelope(
    value.settings,
    "self-test-settings",
  );
  validateSettings(settings, identity);
  for (const binding of settings.result.bindings) {
    if (
      binding.type === "secret_text" &&
      binding.text != null &&
      binding.text !== "<redacted>"
    ) {
      throw new Error("[self-test] verifier evidence exposed a secret binding");
    }
  }
  const content = requireObject(value.content, "[self-test] content");
  if (
    content.ok !== true ||
    !Number.isInteger(content.status) ||
    content.status < 200 ||
    content.status >= 300
  ) {
    throw new Error("[self-test] verifier content status was invalid");
  }
  requireMultipartBoundary(content.contentType);
  const metadata = requireObject(
    content.metadata,
    "[self-test] content metadata",
  );
  validateCompatibility(metadata, identity, "self-test-content");
  const mainModule = requireModuleName(
    metadata.main_module,
    "[self-test] main module",
  );
  if (!Array.isArray(content.modules) || content.modules.length === 0) {
    throw new Error("[self-test] verifier content modules were absent");
  }
  const names = new Set();
  for (const module of content.modules) {
    const name = requireModuleName(module.name, "[self-test] module name");
    if (names.has(name))
      throw new Error("[self-test] verifier modules were duplicated");
    names.add(name);
    requireSingleLine(module.contentType, `[self-test] ${name} content type`);
    if (
      typeof module.base64 !== "string" ||
      module.base64.length === 0 ||
      module.base64.length % 4 !== 0 ||
      Buffer.from(module.base64, "base64").toString("base64") !== module.base64
    ) {
      throw new Error(`[self-test] ${name} did not use canonical base64`);
    }
  }
  if (!names.has(mainModule)) {
    throw new Error("[self-test] verifier evidence omitted the main module");
  }
}

async function expectCollectionFailure(name, fixture, mutate, expected, cases) {
  const responses = fixture.responses.map(cloneResponse);
  mutate(responses);
  try {
    await collectReadback(fixture.options, {
      fetchImpl: queueFetch(responses),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expected.test(message))
      throw new Error(`[self-test] ${name} failed unexpectedly: ${message}`);
    cases.push({ name, passed: true });
    return;
  }
  throw new Error(`[self-test] ${name} unexpectedly passed`);
}

function selfTestFixture() {
  const options = {
    accountId: "0123456789abcdef0123456789abcdef",
    namespace: "cinatoken-rust-tenants-staging",
    scriptName: "tenant-smoke",
    apiToken: "self-test-replacement-token-value",
  };
  const secretValue = "self-test-binding-secret-value";
  const compatibility = {
    compatibility_date: "2026-07-12",
    compatibility_flags: ["nodejs_compat"],
  };
  const detailsEnvelope = envelope({
    dispatch_namespace: options.namespace,
    modified_on: "2026-07-12T00:00:00.000Z",
    script: {
      id: options.scriptName,
      ...compatibility,
      etag: "etag-one",
      modified_on: "2026-07-12T00:00:00.000Z",
    },
  });
  const settingsEnvelope = envelope({
    ...compatibility,
    bindings: [
      { name: "CF_API_TOKEN", type: "secret_text", text: secretValue },
    ],
  });
  const metadataObject = {
    main_module: "shim.mjs",
    ...compatibility,
    bindings: [
      { name: "CF_API_TOKEN", type: "secret_text", text: secretValue },
    ],
  };
  const metadata = JSON.stringify(metadataObject);
  const content = multipartResponse([
    { name: "metadata", contentType: "application/json", bytes: metadata },
    {
      name: "shim.mjs",
      filename: "shim.mjs",
      contentType: "application/javascript+module",
      bytes: 'import wasm from "./index_bg.wasm";',
    },
    {
      name: "index_bg.wasm",
      filename: "index_bg.wasm",
      contentType: "application/wasm",
      bytes: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    },
  ]);
  return {
    options,
    secretValue,
    detailsEnvelope,
    settingsEnvelope,
    metadata,
    responses: [
      jsonResponse(detailsEnvelope),
      jsonResponse(settingsEnvelope),
      content,
      jsonResponse(detailsEnvelope),
    ],
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function multipartResponse(parts) {
  const boundary = "cinatoken_wfp_readback_self_test";
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "ascii"));
    const filename = part.filename ? `; filename="${part.filename}"` : "";
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(
      Buffer.isBuffer(part.bytes)
        ? part.bytes
        : Buffer.from(part.bytes, "utf8"),
    );
    chunks.push(Buffer.from("\r\n", "ascii"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return fakeResponse(Buffer.concat(chunks), {
    status: 200,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

function jsonResponse(value, options = {}) {
  return fakeResponse(JSON.stringify(value), {
    status: 200,
    contentType: "application/json",
    ...options,
  });
}

function fakeResponse(body, options) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    status: options.status,
    contentType: options.contentType,
    contentLength: options.contentLength,
    bytes,
  };
}

function cloneResponse(response) {
  return { ...response, bytes: Buffer.from(response.bytes) };
}

function queueFetch(rawResponses) {
  const responses = rawResponses.map(cloneResponse);
  return async (url) => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    const headers = new Headers({ "content-type": response.contentType });
    if (response.contentLength != null)
      headers.set("content-length", String(response.contentLength));
    return {
      status: response.status,
      redirected: false,
      url:
        response.status >= 300 && response.status < 400
          ? `${url}/redirected`
          : url,
      headers,
      body: new Response(response.bytes).body,
    };
  };
}
