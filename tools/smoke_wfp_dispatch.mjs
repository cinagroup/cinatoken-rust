#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

const defaultWorker = "tenant-smoke";
const defaultTimeoutMs = 10_000;
const defaultExpectedRuntime = "rust-wasm";
const statusTenantPath = "/__cinatoken/tenant/status";
const supportedRuntimes = new Set(["rust-wasm", "js-fallback"]);
const runtimeExpectations = new Set(["rust-wasm", "js-fallback", "any"]);
const supportedRoutes = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/embeddings",
  "/ai/run",
]);
const tenantPublicResponseHeaders = new Set([
  "content-type",
  "cache-control",
  "content-language",
  "expires",
  "last-modified",
  "etag",
  "vary",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-request-id",
  "anthropic-request-id",
]);
const wfpEvidenceResponseHeaders = new Set([
  "x-cinatoken-wfp-route",
  "x-cinatoken-wfp-worker",
  "x-cinatoken-wfp-tenant",
  "x-cinatoken-wfp-runtime",
]);
const corsResponseHeaders = new Set([
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
]);
const edgeEnvelopeResponseHeaders = new Set([
  "age",
  "alt-svc",
  "cf-cache-status",
  "cf-ray",
  "connection",
  "content-encoding",
  "content-length",
  "date",
  "expect-ct",
  "keep-alive",
  "nel",
  "report-to",
  "server",
  "strict-transport-security",
  "transfer-encoding",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
  "x-xss-protection",
]);
const forbiddenResponseHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-aig-log-id",
  "cf-aig-step",
  "cf-aig-cache-status",
  "cf-aig-metadata",
  "cf-aig-gateway-id",
  "x-cinatoken-tenant",
  "x-cinatoken-smoke",
]);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test-response-header-guard")) {
    const result = runResponseHeaderGuardSelfTest();
    printSelfTestResult(result, args.flags.has("json"));
  } else {
    const options = await normalizeOptions(args);
    const result = options.dryRun ? buildPlan(options) : await smoke(options);
    printResult(result, options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function smoke(options) {
  const plan = buildPlan(options);
  const statusResponse = await fetchWithTimeout(plan.statusUrl, {
    method: "GET",
    headers: smokeHeaders(options),
    redirect: "error",
  }, options.timeoutMs);

  if (!statusResponse.ok) {
    throw new Error(
      `WFP dispatch status smoke failed: ${statusResponse.status} ${statusResponse.statusText}`,
    );
  }
  const statusBody = await readJsonResponse(statusResponse, "WFP dispatch status");
  validateStatusBody(statusBody, options.expectRuntime, options.worker);
  validateDispatchHeaders(statusResponse.headers, options.worker, options.expectRuntime);
  const statusHeaderGuard = options.responseHeaderGuard
    ? validateResponseHeaderGuard(
        statusResponse.headers,
        "WFP dispatch status",
        options.strictResponseHeaderAllowlist,
      )
    : null;

  let routeResult = null;
  if (plan.routeUrl) {
    const routeResponse = await fetchWithTimeout(plan.routeUrl, {
      method: "POST",
      headers: smokeHeaders(options, {
        "content-type": "application/json",
        "x-cinatoken-smoke": "wfp-dispatch",
      }),
      body: options.bodyText,
      redirect: "error",
    }, options.timeoutMs);

    const preview = await boundedText(routeResponse, 4096);
    if (!options.allowNon2xx && !routeResponse.ok) {
      throw new Error(
        `WFP dispatch route smoke failed: ${routeResponse.status} ${routeResponse.statusText}: ${preview}`,
      );
    }
    validateDispatchHeaders(routeResponse.headers, options.worker, options.expectRuntime);
    const routeHeaderGuard = options.responseHeaderGuard
      ? validateResponseHeaderGuard(
          routeResponse.headers,
          "WFP dispatch route",
          options.strictResponseHeaderAllowlist,
        )
      : null;
    routeResult = {
      route: options.route,
      url: redactUrl(plan.routeUrl),
      status: routeResponse.status,
      ok: routeResponse.ok,
      dispatchHeaders: dispatchHeaders(routeResponse.headers),
      responseHeaderGuard: routeHeaderGuard,
      responseContentType: routeResponse.headers.get("content-type"),
      responsePreview: preview,
    };
  }

  return {
    ok: true,
    dryRun: false,
    worker: options.worker,
    statusUrl: redactUrl(plan.statusUrl),
    adminCookieConfigured: Boolean(options.adminCookie),
    expectRuntime: options.expectRuntime,
    status: summarizeTenantStatus(statusBody),
    dispatchHeaders: dispatchHeaders(statusResponse.headers),
    responseHeaderGuard: statusHeaderGuard,
    route: routeResult,
  };
}

function buildPlan(options) {
  const base = normalizeBaseUrl(required(options.url, "url"));
  const statusUrl = dispatchUrl(base, options.worker, statusTenantPath);
  const routeUrl = options.route ? dispatchUrl(base, options.worker, options.route) : null;
  return {
    ok: true,
    dryRun: options.dryRun,
    worker: options.worker,
    statusUrl: redactUrl(statusUrl),
    routeUrl: routeUrl ? redactUrl(routeUrl) : null,
    route: options.route,
    method: options.route ? "GET status, then POST route" : "GET status only",
    bodyBytes: options.route ? new TextEncoder().encode(options.bodyText).byteLength : 0,
    adminCookieConfigured: Boolean(options.adminCookie),
    expectRuntime: options.expectRuntime,
    allowNon2xx: options.allowNon2xx,
    responseHeaderGuard: options.responseHeaderGuard,
    strictResponseHeaderAllowlist: options.strictResponseHeaderAllowlist,
    allowedTenantResponseHeaders: Array.from(tenantPublicResponseHeaders).sort(),
    allowedWfpEvidenceResponseHeaders: Array.from(wfpEvidenceResponseHeaders).sort(),
    forbiddenResponseHeaderNames: Array.from(forbiddenResponseHeaderNames).sort(),
    forbiddenResponseHeaderPrefixes: ["cf-aig-", "x-cinatoken-* except x-cinatoken-wfp-*"],
    timeoutMs: options.timeoutMs,
    notes: [
      "worker is the public tenant name in /api/platform/dispatch/:worker; WFP_DISPATCH_WORKER_PREFIX is applied by the main Worker.",
      "internal dispatch smoke is admin-authenticated; dry-run output reports whether a Cookie header is configured without printing its value.",
      "the dispatch Worker strips platform/admin credentials before invoking the tenant Worker; live status smoke fails if tenant status reports sensitive inbound headers.",
      "status smoke validates the dispatch binding, internal path rewrite, controlled internal dispatch markers, expected tenant runtime, AI Gateway policy contract, tenant status contract, and x-cinatoken WFP headers.",
      "response-header guard fails live smoke if auth/cookie, cf-aig-*, or non-WFP x-cinatoken-* headers leak; strict mode additionally rejects non-allowlisted headers when the edge envelope is controlled.",
      "route smoke is opt-in and may call the tenant AI Gateway route; use staging credentials and a low-risk payload.",
    ],
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
    if ([
      "--dry-run",
      "--json",
      "--allow-non-2xx",
      "--no-response-header-guard",
      "--strict-response-header-allowlist",
      "--self-test-response-header-guard",
    ].includes(arg)) {
      flags.add(arg.slice(2));
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

async function normalizeOptions(args) {
  const value = (name, envName) => args.values.get(name) || process.env[envName];
  const timeoutMs = Number.parseInt(value("timeout-ms", "WFP_SMOKE_TIMEOUT_MS") || "", 10);
  const route = value("route", "WFP_SMOKE_ROUTE");
  const normalizedRoute = route ? validateRoute(route) : null;
  const bodyText = normalizedRoute ? await resolveBodyText(args, normalizedRoute) : "";
  return {
    url: value("url", "WFP_SMOKE_URL") || process.env.STAGING_BASE_URL,
    worker: validateWorkerName(value("worker", "WFP_SMOKE_WORKER") || defaultWorker),
    route: normalizedRoute,
    bodyText,
    adminCookie: optionalHeaderValue(value("cookie", "WFP_SMOKE_COOKIE"), "cookie"),
    expectRuntime: validateRuntimeExpectation(
      value("expect-runtime", "WFP_SMOKE_EXPECT_RUNTIME") || defaultExpectedRuntime,
    ),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    allowNon2xx: args.flags.has("allow-non-2xx"),
    responseHeaderGuard: !args.flags.has("no-response-header-guard"),
    strictResponseHeaderAllowlist: args.flags.has("strict-response-header-allowlist"),
    dryRun: args.flags.has("dry-run"),
    json: args.flags.has("json"),
  };
}

async function resolveBodyText(args, route) {
  const body = args.values.get("body") || process.env.WFP_SMOKE_BODY;
  const bodyFile = args.values.get("body-file") || process.env.WFP_SMOKE_BODY_FILE;
  if (body && bodyFile) {
    throw new Error("use either --body or --body-file, not both");
  }
  const raw = bodyFile ? await readFile(bodyFile, "utf8") : body || defaultBody(route);
  try {
    JSON.parse(raw);
  } catch (error) {
    throw new Error(`route smoke body must be valid JSON: ${error.message}`);
  }
  return raw;
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/smoke_wfp_dispatch.mjs --url <worker-origin> [options]",
      "",
      "Default mode:",
      "  Runs GET /api/platform/dispatch/:worker/__cinatoken/tenant/status.",
      "",
      "Options:",
      "  --worker <name>       or WFP_SMOKE_WORKER, default tenant-smoke",
      "  --route <path>        Optional POST route: /v1/chat/completions, /v1/responses, /v1/messages, /v1/embeddings, or /ai/run",
      "  --body <json>         Optional JSON body for --route; otherwise a low-token default body is used",
      "  --body-file <path>    Optional JSON body file for --route",
      "  --cookie <header>     or WFP_SMOKE_COOKIE, admin session Cookie header required for live internal dispatch smoke",
      "  --expect-runtime <runtime>  rust-wasm, js-fallback, or any; default rust-wasm",
      "  --timeout-ms <ms>     or WFP_SMOKE_TIMEOUT_MS, default 10000",
      "  --allow-non-2xx       Record POST route responses even if the AI Gateway/provider rejects the payload",
      "  --no-response-header-guard  Disable response header leakage checks",
      "  --strict-response-header-allowlist  Also reject headers outside the public tenant/WFP/CORS/edge allowlist",
      "  --self-test-response-header-guard  Run local synthetic guard tests without network",
      "  --dry-run             Resolve URLs without network",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_wfp_dispatch.mjs --dry-run --json --url http://127.0.0.1:8787 --worker tenant-smoke",
      "  bun tools/smoke_wfp_dispatch.mjs --url https://staging.example.com --worker tenant-smoke --cookie \"$WFP_SMOKE_COOKIE\" --json",
      "  bun tools/smoke_wfp_dispatch.mjs --url https://staging.example.com --worker tenant-smoke --route /v1/responses --body '{\"model\":\"gpt-4o-mini\",\"input\":\"wfp smoke\"}' --cookie \"$WFP_SMOKE_COOKIE\" --json",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function smokeHeaders(options, extras = {}) {
  const headers = {
    accept: "application/json",
    ...extras,
  };
  if (options.adminCookie) {
    headers.cookie = options.adminCookie;
  }
  return headers;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("url must use http or https");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url;
}

function dispatchUrl(base, worker, tenantPath) {
  const url = new URL(base.toString());
  const path = tenantPath.replace(/^\/+/, "");
  url.pathname = `/api/platform/dispatch/${encodeURIComponent(worker)}/${path}`;
  return url.toString();
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms: ${redactUrl(url)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned non-JSON response: ${error.message}: ${text.slice(0, 1024)}`);
  }
}

async function boundedText(response, maxBytes) {
  const text = await response.text();
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}...<truncated>`;
}

function validateStatusBody(body, expectRuntime, worker) {
  if (!body || typeof body !== "object") {
    throw new Error("tenant status response must be a JSON object");
  }
  if (body.forwarding !== "cloudflare-ai-gateway-rest") {
    throw new Error("tenant status did not report Cloudflare AI Gateway forwarding");
  }
  if (!supportedRuntimes.has(body.runtime)) {
    throw new Error(`tenant status reported unexpected runtime: ${body.runtime}`);
  }
  if (expectRuntime !== "any" && body.runtime !== expectRuntime) {
    throw new Error(`tenant status runtime ${body.runtime} did not match expected ${expectRuntime}`);
  }
  if (!Array.isArray(body.routes) || !body.routes.includes(statusTenantPath)) {
    throw new Error("tenant status route manifest is missing the status path");
  }
  for (const route of supportedRoutes) {
    if (!body.routes.includes(route)) {
      throw new Error(`tenant status route manifest is missing ${route}`);
    }
  }
  if (body.inbound_sensitive_headers_present !== false) {
    throw new Error(
      `tenant status reported sensitive inbound headers: ${JSON.stringify(body.inbound_sensitive_headers)}`,
    );
  }
  if (!Array.isArray(body.inbound_sensitive_headers) || body.inbound_sensitive_headers.length !== 0) {
    throw new Error("tenant status must expose an empty inbound_sensitive_headers array");
  }
  validateAiGatewayRequestPolicy(body.ai_gateway_request_policy);
  if (body.inbound_dispatch_route !== "internal-path") {
    throw new Error(`tenant status did not prove internal WFP dispatch: ${body.inbound_dispatch_route}`);
  }
  if (body.inbound_dispatch_worker !== worker) {
    throw new Error(`tenant status worker marker ${body.inbound_dispatch_worker} did not match ${worker}`);
  }
}

function validateAiGatewayRequestPolicy(policy) {
  if (!Array.isArray(policy)) {
    throw new Error("tenant status must expose ai_gateway_request_policy array");
  }
  for (const item of policy) {
    if (!item || typeof item !== "object") {
      throw new Error("ai_gateway_request_policy entries must be objects");
    }
    if (typeof item.env !== "string" || typeof item.header !== "string") {
      throw new Error("ai_gateway_request_policy entries must expose env and header names");
    }
    if (typeof item.configured !== "boolean" || typeof item.valid !== "boolean") {
      throw new Error("ai_gateway_request_policy entries must expose configured and valid booleans");
    }
    if (item.configured && !item.valid) {
      throw new Error(`tenant AI Gateway policy ${item.env} is configured but invalid`);
    }
  }
}

function validateDispatchHeaders(headers, worker, expectRuntime) {
  const route = headers.get("x-cinatoken-wfp-route");
  const headerWorker = headers.get("x-cinatoken-wfp-worker");
  const runtime = headers.get("x-cinatoken-wfp-runtime");
  const tenant = headers.get("x-cinatoken-wfp-tenant");
  if (route !== "internal-path") {
    throw new Error(`unexpected x-cinatoken-wfp-route: ${route}`);
  }
  if (headerWorker !== worker) {
    throw new Error(`unexpected x-cinatoken-wfp-worker: ${headerWorker}`);
  }
  if (!tenant) {
    throw new Error("missing x-cinatoken-wfp-tenant response header");
  }
  if (!supportedRuntimes.has(runtime)) {
    throw new Error(`unexpected x-cinatoken-wfp-runtime: ${runtime}`);
  }
  if (expectRuntime !== "any" && runtime !== expectRuntime) {
    throw new Error(`x-cinatoken-wfp-runtime ${runtime} did not match expected ${expectRuntime}`);
  }
}

function validateResponseHeaderGuard(headers, label, strictAllowlist) {
  const observed = headerNames(headers);
  const forbidden = [];
  const publicHeaders = [];
  const wfpHeaders = [];
  const corsHeaders = [];
  const edgeEnvelopeHeaders = [];
  const unclassifiedHeaders = [];

  for (const name of observed) {
    const forbiddenReason = forbiddenResponseHeaderReason(name);
    if (forbiddenReason) {
      forbidden.push({ name, reason: forbiddenReason });
      continue;
    }
    if (tenantPublicResponseHeaders.has(name)) {
      publicHeaders.push(name);
    } else if (wfpEvidenceResponseHeaders.has(name)) {
      wfpHeaders.push(name);
    } else if (corsResponseHeaders.has(name)) {
      corsHeaders.push(name);
    } else if (edgeEnvelopeResponseHeaders.has(name) || name.startsWith("cf-")) {
      edgeEnvelopeHeaders.push(name);
    } else {
      unclassifiedHeaders.push(name);
    }
  }

  if (forbidden.length > 0) {
    throw new Error(
      `${label} leaked forbidden response headers: ${forbidden
        .map((item) => `${item.name} (${item.reason})`)
        .join(", ")}`,
    );
  }
  if (strictAllowlist && unclassifiedHeaders.length > 0) {
    throw new Error(
      `${label} exposed response headers outside the strict allowlist: ${unclassifiedHeaders.join(", ")}`,
    );
  }

  return {
    ok: true,
    strictAllowlist,
    observedHeaders: observed,
    publicHeaders,
    wfpEvidenceHeaders: wfpHeaders,
    corsHeaders,
    edgeEnvelopeHeaders,
    unclassifiedHeaders,
    forbiddenHeaders: [],
  };
}

function headerNames(headers) {
  return Array.from(headers.keys(), (name) => name.toLowerCase()).sort();
}

function forbiddenResponseHeaderReason(name) {
  if (forbiddenResponseHeaderNames.has(name)) {
    return "sensitive or upstream-only header";
  }
  if (name.startsWith("cf-aig-")) {
    return "Cloudflare AI Gateway request/log metadata must not be exposed";
  }
  if (name.startsWith("x-cinatoken-wfp-") && !wfpEvidenceResponseHeaders.has(name)) {
    return "unexpected WFP platform marker";
  }
  if (name.startsWith("x-cinatoken-") && !name.startsWith("x-cinatoken-wfp-")) {
    return "tenant/upstream cinatoken marker must not be exposed";
  }
  if (name.startsWith("openai-") && name !== "openai-request-id") {
    return "OpenAI upstream metadata is outside the tenant response allowlist";
  }
  if (name.startsWith("anthropic-") && name !== "anthropic-request-id") {
    return "Anthropic upstream metadata is outside the tenant response allowlist";
  }
  return null;
}

function runResponseHeaderGuardSelfTest() {
  const cases = [];
  const safe = validateResponseHeaderGuard(
    new Headers([
      ["content-type", "application/json"],
      ["cache-control", "no-store"],
      ["x-request-id", "req-safe"],
      ["x-cinatoken-wfp-route", "internal-path"],
      ["x-cinatoken-wfp-worker", "tenant-smoke"],
      ["x-cinatoken-wfp-tenant", "tenant-smoke"],
      ["x-cinatoken-wfp-runtime", "rust-wasm"],
      ["access-control-allow-origin", "*"],
      ["date", "Mon, 06 Jul 2026 00:00:00 GMT"],
      ["cf-ray", "synthetic"],
    ]),
    "self-test safe response",
    true,
  );
  cases.push({ name: "safe-response", ok: safe.ok, strictAllowlist: safe.strictAllowlist });

  for (const name of [
    "authorization",
    "set-cookie",
    "cookie",
    "cf-aig-log-id",
    "cf-aig-extra",
    "x-cinatoken-tenant",
    "x-cinatoken-wfp-debug",
    "openai-processing-ms",
    "anthropic-ratelimit-requests-limit",
  ]) {
    cases.push(expectHeaderGuardFailure(name, name));
  }

  validateResponseHeaderGuard(
    new Headers([["x-debug-unclassified", "ok in non-strict smoke"]]),
    "self-test non-strict unclassified response",
    false,
  );
  cases.push(expectHeaderGuardFailure("x-debug-unclassified", "strict allowlist"));

  return {
    ok: true,
    responseHeaderGuardSelfTest: true,
    cases,
  };
}

function expectHeaderGuardFailure(name, expected) {
  try {
    validateResponseHeaderGuard(new Headers([[name, "synthetic"]]), `self-test forbidden ${name}`, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes(expected.toLowerCase())) {
      throw new Error(`response header self-test for ${name} failed with unexpected message: ${message}`);
    }
    return { name, ok: true };
  }
  throw new Error(`response header self-test expected ${name} to fail`);
}

function summarizeTenantStatus(body) {
  return {
    service: body.service,
    runtime: body.runtime,
    tenantId: body.tenant_id,
    forwarding: body.forwarding,
    bodyMode: body.body_mode,
    aiGatewayIdConfigured: body.ai_gateway_id_configured,
    defaultAiGatewayIdConfigured: body.default_ai_gateway_id_configured,
    routeGateways: body.route_gateways,
    aiGatewayRequestPolicy: body.ai_gateway_request_policy,
    inboundSensitiveHeadersPresent: body.inbound_sensitive_headers_present,
    inboundSensitiveHeaders: body.inbound_sensitive_headers,
    inboundDispatchRoute: body.inbound_dispatch_route,
    inboundDispatchWorker: body.inbound_dispatch_worker,
    routes: body.routes,
  };
}

function dispatchHeaders(headers) {
  return {
    route: headers.get("x-cinatoken-wfp-route"),
    worker: headers.get("x-cinatoken-wfp-worker"),
    tenant: headers.get("x-cinatoken-wfp-tenant"),
    runtime: headers.get("x-cinatoken-wfp-runtime"),
    requestId:
      headers.get("x-request-id") ||
      headers.get("request-id") ||
      headers.get("openai-request-id") ||
      headers.get("anthropic-request-id"),
  };
}

function defaultBody(route) {
  switch (route) {
    case "/v1/chat/completions":
      return JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "wfp dispatch smoke" }],
        max_tokens: 1,
      });
    case "/v1/responses":
      return JSON.stringify({
        model: "gpt-4o-mini",
        input: "wfp dispatch smoke",
        max_output_tokens: 1,
      });
    case "/v1/messages":
      return JSON.stringify({
        model: "claude-3-5-haiku-latest",
        max_tokens: 1,
        messages: [{ role: "user", content: "wfp dispatch smoke" }],
      });
    case "/v1/embeddings":
      return JSON.stringify({
        model: "text-embedding-3-small",
        input: "wfp dispatch smoke",
      });
    case "/ai/run":
      return JSON.stringify({
        model: "@cf/meta/llama-3.1-8b-instruct",
        prompt: "wfp dispatch smoke",
      });
    default:
      throw new Error(`unsupported route: ${route}`);
  }
}

function validateWorkerName(value) {
  const worker = validatePlainValue(value, "worker").toLowerCase();
  if (worker.length > 63 || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(worker)) {
    throw new Error("worker must be 1-63 chars of letters, digits, underscore, or dash, and cannot start/end with underscore or dash");
  }
  return worker;
}

function validateRoute(value) {
  const route = validatePlainValue(value, "route");
  const normalized = route.startsWith("/") ? route : `/${route}`;
  if (!supportedRoutes.has(normalized)) {
    throw new Error(`route must be one of ${Array.from(supportedRoutes).join(", ")}`);
  }
  return normalized;
}

function validateRuntimeExpectation(value) {
  const runtime = validatePlainValue(value, "expect-runtime").toLowerCase();
  if (!runtimeExpectations.has(runtime)) {
    throw new Error("expect-runtime must be rust-wasm, js-fallback, or any");
  }
  return runtime;
}

function validatePlainValue(value, name) {
  const trimmed = required(value, name);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

function optionalHeaderValue(value, name) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function redactUrl(value) {
  const url = new URL(value);
  for (const key of ["key", "api_key", "token", "access_token"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "<redacted>");
    }
  }
  return url.toString();
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      result.dryRun ? "WFP dispatch smoke plan (dry-run)" : "WFP dispatch smoke result",
      `worker: ${result.worker}`,
      `status_url: ${result.statusUrl}`,
      ...(result.routeUrl ? [`route_url: ${result.routeUrl}`] : []),
      ...(result.route ? [`route: ${typeof result.route === "string" ? result.route : result.route.route}`] : []),
      ...(result.bodyBytes ? [`body_bytes: ${result.bodyBytes}`] : []),
      ...(Object.hasOwn(result, "adminCookieConfigured") ? [`admin_cookie_configured: ${result.adminCookieConfigured}`] : []),
      ...(result.expectRuntime ? [`expect_runtime: ${result.expectRuntime}`] : []),
      ...(result.status ? [`tenant_status: ${JSON.stringify(result.status)}`] : []),
      ...(result.dispatchHeaders ? [`dispatch_headers: ${JSON.stringify(result.dispatchHeaders)}`] : []),
      ...(result.responseHeaderGuard
        ? [`response_header_guard: ${JSON.stringify(result.responseHeaderGuard)}`]
        : []),
      ...(result.route && typeof result.route === "object"
        ? [`route_result: ${JSON.stringify(result.route)}`]
        : []),
      ...(result.notes?.length ? ["notes:", ...result.notes.map((note) => `  - ${note}`)] : []),
    ].join("\n"),
  );
}

function printSelfTestResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "WFP dispatch response-header guard self-test",
      `ok: ${result.ok}`,
      ...result.cases.map((item) => `case ${item.name}: ${item.ok ? "ok" : "failed"}`),
    ].join("\n"),
  );
}
