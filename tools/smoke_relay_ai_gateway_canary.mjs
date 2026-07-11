#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

const defaultTimeoutMs = 20_000;
const defaultEndpoint = "chat";
const defaultModel = "openai/gpt-4.1";
const endpointPaths = new Map([
  ["chat", "/v1/chat/completions"],
  ["responses", "/v1/responses"],
  ["messages", "/v1/messages"],
]);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test")) {
    const result = runSelfTest();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const options = await normalizeOptions(args);
  const result = options.dryRun ? buildPlan(options) : await smoke(options);
  printResult(result, options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function smoke(options) {
  const plan = buildPlan(options);
  let capabilities = null;
  if (!options.skipCapabilities) {
    const response = await fetchWithTimeout(
      plan.capabilitiesUrl,
      {
        method: "GET",
        headers: adminHeaders(options),
        redirect: "error",
      },
      options.timeoutMs,
    );
    capabilities = await readEnvelope(response, "platform capabilities");
    validateCapabilities(capabilities, options);
    if (!options.skipRelay && !capabilities.relay_ai_gateway_router_ready) {
      throw new Error(
        "platform capabilities reported relay_ai_gateway_router_ready=false; refusing to run relay canary",
      );
    }
  }

  let relay = null;
  if (!options.skipRelay) {
    const response = await fetchWithTimeout(
      plan.relayUrl,
      {
        method: "POST",
        headers: relayHeaders(options),
        body: options.bodyText,
        redirect: "error",
      },
      options.timeoutMs,
    );
    const preview = await boundedText(response, 4096);
    if (!options.allowNon2xx && !response.ok) {
      throw new Error(
        `relay AI Gateway canary failed: ${response.status} ${response.statusText}: ${preview}`,
      );
    }
    relay = {
      endpoint: options.endpoint,
      url: redactUrl(plan.relayUrl),
      status: response.status,
      ok: response.ok,
      responseContentType: response.headers.get("content-type"),
      requestIds: requestIds(response.headers),
      responsePreview: preview,
    };
    if (options.expectServedModel) {
      const servedModel = responseModel(preview);
      if (servedModel !== options.expectServedModel) {
        throw new Error(
          `relay served model ${servedModel || "<missing>"} did not match expected ${options.expectServedModel}`,
        );
      }
      relay.servedModel = servedModel;
    }
  }

  return {
    ok: true,
    dryRun: false,
    capabilitiesUrl: redactUrl(plan.capabilitiesUrl),
    relayUrl: redactUrl(plan.relayUrl),
    endpoint: options.endpoint,
    model: options.model,
    bodyBytes: plan.bodyBytes,
    capabilities,
    relay,
    evidenceReminder: evidenceReminder(),
  };
}

function buildPlan(options) {
  const base = normalizeBaseUrl(required(options.url, "url"));
  const capabilitiesUrl = buildHttpUrl(base, "/api/platform/capabilities");
  const relayUrl = buildHttpUrl(base, endpointPaths.get(options.endpoint));
  return {
    ok: true,
    dryRun: options.dryRun,
    capabilitiesUrl: redactUrl(capabilitiesUrl),
    relayUrl: redactUrl(relayUrl),
    endpoint: options.endpoint,
    method: options.skipRelay
      ? "GET capabilities only"
      : options.skipCapabilities
        ? "POST relay only"
        : "GET capabilities, then POST relay",
    model: options.model,
    bodyBytes: new TextEncoder().encode(options.bodyText).byteLength,
    adminCookieConfigured: Boolean(options.adminCookie),
    relayApiKeyConfigured: Boolean(options.apiKey),
    confirmLive: options.confirmLive,
    expectRouterEnabled: options.expectRouterEnabled,
    expectRouterReady: options.expectRouterReady,
    expectRouterDisabled: options.expectRouterDisabled,
    expectFallbackEnabled: options.expectFallbackEnabled,
    expectFallbackDisabled: options.expectFallbackDisabled,
    expectFallbackReady: options.expectFallbackReady,
    expectFallbackStagingVerified: options.expectFallbackStagingVerified,
    expectFallbackCutoverReady: options.expectFallbackCutoverReady,
    expectServedModel: options.expectServedModel || null,
    allowNon2xx: options.allowNon2xx,
    timeoutMs: options.timeoutMs,
    notes: [
      "dry-run resolves the canary plan without network access.",
      "live mode requires --confirm-live because the relay POST may call a paid upstream provider.",
      "before live mode, enable the target channel in the editor so it writes channels.other_info.ai_gateway.enabled.",
      "capabilities smoke is admin-authenticated and validates the compiled AI Gateway forwarder, opt-in support, and fallback signals.",
      "relay smoke uses a low-token non-stream request; collect Cloudflare AI Gateway logs plus relay audit/billing evidence after the run.",
    ],
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set([
    "dry-run",
    "json",
    "allow-non-2xx",
    "skip-capabilities",
    "skip-relay",
    "confirm-live",
    "expect-router-enabled",
    "expect-router-ready",
    "expect-router-disabled",
    "expect-fallback-enabled",
    "expect-fallback-disabled",
    "expect-fallback-ready",
    "expect-fallback-staging-verified",
    "expect-fallback-cutover-ready",
    "self-test",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (!arg.startsWith("--")) {
      usage(2, `Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (flagNames.has(key)) {
      flags.add(key);
      continue;
    }
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
  const endpoint = validateEndpoint(
    value("endpoint", "RELAY_AI_GATEWAY_SMOKE_ENDPOINT") || defaultEndpoint,
  );
  const timeoutMs = Number.parseInt(
    value("timeout-ms", "RELAY_AI_GATEWAY_SMOKE_TIMEOUT_MS") || "",
    10,
  );
  const body = await resolveBody(endpoint, value, args);
  const model = validateModelForEndpoint(body.model, endpoint);
  body.payload.model = model;
  const dryRun = args.flags.has("dry-run");
  const skipCapabilities = args.flags.has("skip-capabilities");
  const skipRelay = args.flags.has("skip-relay");
  const confirmLive = args.flags.has("confirm-live");
  const adminCookie = optionalHeaderValue(
    value("cookie", "RELAY_AI_GATEWAY_SMOKE_COOKIE"),
    "cookie",
  );
  const apiKey = optionalHeaderValue(
    value("api-key", "RELAY_AI_GATEWAY_SMOKE_API_KEY"),
    "api-key",
  );

  if (!dryRun && !confirmLive) {
    throw new Error("live smoke requires --confirm-live");
  }
  if (!dryRun && !skipCapabilities && !adminCookie) {
    throw new Error("live capabilities smoke requires --cookie or RELAY_AI_GATEWAY_SMOKE_COOKIE");
  }
  if (!dryRun && !skipRelay && !apiKey) {
    throw new Error("live relay smoke requires --api-key or RELAY_AI_GATEWAY_SMOKE_API_KEY");
  }
  if (args.flags.has("expect-router-enabled") && args.flags.has("expect-router-disabled")) {
    throw new Error("use only one of --expect-router-enabled or --expect-router-disabled");
  }
  if (args.flags.has("expect-fallback-enabled") && args.flags.has("expect-fallback-disabled")) {
    throw new Error("use only one of --expect-fallback-enabled or --expect-fallback-disabled");
  }

  return {
    url: value("url", "RELAY_AI_GATEWAY_SMOKE_URL") || process.env.STAGING_BASE_URL,
    endpoint,
    model,
    bodyText: JSON.stringify(body.payload),
    adminCookie,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    allowNon2xx: args.flags.has("allow-non-2xx"),
    skipCapabilities,
    skipRelay,
    confirmLive,
    expectRouterEnabled: args.flags.has("expect-router-enabled"),
    expectRouterReady: args.flags.has("expect-router-ready"),
    expectRouterDisabled: args.flags.has("expect-router-disabled"),
    expectFallbackEnabled: args.flags.has("expect-fallback-enabled"),
    expectFallbackDisabled: args.flags.has("expect-fallback-disabled"),
    expectFallbackReady: args.flags.has("expect-fallback-ready"),
    expectFallbackStagingVerified: args.flags.has("expect-fallback-staging-verified"),
    expectFallbackCutoverReady: args.flags.has("expect-fallback-cutover-ready"),
    expectServedModel: value(
      "expect-served-model",
      "RELAY_AI_GATEWAY_SMOKE_EXPECT_SERVED_MODEL",
    ),
    dryRun,
    json: args.flags.has("json"),
  };
}

async function resolveBody(endpoint, value, args) {
  const model = value("model", "RELAY_AI_GATEWAY_SMOKE_MODEL") || defaultModel;
  const rawBody = value("body", "RELAY_AI_GATEWAY_SMOKE_BODY");
  const bodyFile = value("body-file", "RELAY_AI_GATEWAY_SMOKE_BODY_FILE");
  if (rawBody && bodyFile) {
    throw new Error("use either --body or --body-file, not both");
  }
  const raw = bodyFile ? await readFile(bodyFile, "utf8") : rawBody;
  const payload = raw ? parseJsonObject(raw, "body") : defaultPayload(endpoint, model);
  if (!Object.hasOwn(payload, "model")) {
    payload.model = model;
  }
  return { model: payload.model, payload };
}

function defaultPayload(endpoint, model) {
  const prompt = "cinatoken AI Gateway canary smoke: reply with OK";
  if (endpoint === "responses") {
    return {
      model,
      input: prompt,
      max_output_tokens: 8,
      stream: false,
    };
  }
  if (endpoint === "messages") {
    return {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt }],
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8,
    stream: false,
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/smoke_relay_ai_gateway_canary.mjs --url <worker-origin> [options]",
      "",
      "Default dry-run target:",
      "  GET /api/platform/capabilities, then POST /v1/chat/completions with a low-token provider-prefixed model.",
      "",
      "Options:",
      "  --endpoint <name>       chat, responses, or messages; default chat",
      "  --model <model>         Provider-prefixed model, default openai/gpt-4.1",
      "  --body <json>           Optional JSON request body; model is added when missing",
      "  --body-file <path>      Optional JSON request body file",
      "  --cookie <header>       Admin session Cookie header for capabilities smoke",
      "  --api-key <token>       Relay API key for the /v1 request",
      "  --timeout-ms <ms>       default 20000",
      "  --skip-capabilities     Do not GET /api/platform/capabilities",
      "  --skip-relay            Do not POST the relay route",
      "  --expect-router-enabled Require capabilities relay_ai_gateway_router_enabled=true",
      "  --expect-router-disabled Require capabilities relay_ai_gateway_router_enabled=false",
      "  --expect-router-ready   Require capabilities relay_ai_gateway_router_ready=true",
      "  --expect-fallback-enabled Require cross-model fallback gate enabled",
      "  --expect-fallback-disabled Require cross-model fallback gate disabled",
      "  --expect-fallback-ready Require configured runtime fallback readiness",
      "  --expect-fallback-staging-verified Require archived staging replay flag",
      "  --expect-fallback-cutover-ready Require all fallback production gates",
      "  --expect-served-model <model> Require non-stream response.model to match",
      "  --allow-non-2xx         Record relay responses even when they are not 2xx",
      "  --confirm-live          Required for non-dry-run mode",
      "  --dry-run               Resolve URLs and payload size without network",
      "  --self-test             Validate capability and route contracts locally",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_relay_ai_gateway_canary.mjs --dry-run --json --url http://127.0.0.1:8787",
      "  bun tools/smoke_relay_ai_gateway_canary.mjs --url https://staging.example.com --cookie \"$RELAY_AI_GATEWAY_SMOKE_COOKIE\" --api-key \"$RELAY_AI_GATEWAY_SMOKE_API_KEY\" --model openai/gpt-4.1 --expect-router-ready --confirm-live --json",
      "  bun tools/smoke_relay_ai_gateway_canary.mjs --url https://staging.example.com --endpoint messages --model anthropic/claude-sonnet-4-5 --cookie \"$RELAY_AI_GATEWAY_SMOKE_COOKIE\" --api-key \"$RELAY_AI_GATEWAY_SMOKE_API_KEY\" --expect-router-ready --confirm-live --json",
    ].join("\n"),
  );
  process.exit(exitCode);
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

async function readEnvelope(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}: ${text.slice(0, 1024)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned non-JSON response: ${error.message}: ${text.slice(0, 1024)}`);
  }
  if (!body || typeof body !== "object" || body.success !== true || !body.data) {
    throw new Error(`${label} did not return a successful {success,data} envelope`);
  }
  return summarizeCapabilities(body.data);
}

function summarizeCapabilities(data) {
  return {
    cloudflare_account_id_configured: data.cloudflare_account_id_configured === true,
    ai_gateway_id_configured: data.ai_gateway_id_configured === true,
    cloudflare_ai_gateway_token_configured:
      data.cloudflare_ai_gateway_token_configured === true,
    relay_ai_gateway_router_enabled: data.relay_ai_gateway_router_enabled === true,
    relay_ai_gateway_router_ready: data.relay_ai_gateway_router_ready === true,
    relay_ai_gateway_rest_routes: arrayOfStrings(data.relay_ai_gateway_rest_routes),
    relay_ai_gateway_cutover_guards: arrayOfStrings(data.relay_ai_gateway_cutover_guards),
    relay_ai_gateway_channel_opt_in_supported:
      data.relay_ai_gateway_channel_opt_in_supported === true,
    relay_ai_gateway_rest_forwarder_compiled:
      data.relay_ai_gateway_rest_forwarder_compiled === true,
    relay_ai_gateway_same_channel_fallback_compiled:
      data.relay_ai_gateway_same_channel_fallback_compiled === true,
    relay_ai_gateway_cross_model_fallback_compiled:
      data.relay_ai_gateway_cross_model_fallback_compiled === true,
    relay_ai_gateway_cross_model_fallback_enabled:
      data.relay_ai_gateway_cross_model_fallback_enabled === true,
    relay_ai_gateway_cross_model_fallback_configured:
      data.relay_ai_gateway_cross_model_fallback_configured === true,
    relay_ai_gateway_cross_model_fallback_config_valid:
      data.relay_ai_gateway_cross_model_fallback_config_valid === true,
    relay_ai_gateway_cross_model_fallback_mapping_count: Number.isFinite(
      data.relay_ai_gateway_cross_model_fallback_mapping_count,
    )
      ? data.relay_ai_gateway_cross_model_fallback_mapping_count
      : 0,
    relay_ai_gateway_cross_model_fallback_ready:
      data.relay_ai_gateway_cross_model_fallback_ready === true,
    relay_ai_gateway_cross_model_fallback_staging_verified:
      data.relay_ai_gateway_cross_model_fallback_staging_verified === true,
    relay_ai_gateway_cross_model_fallback_cutover_ready:
      data.relay_ai_gateway_cross_model_fallback_cutover_ready === true,
    relay_ai_gateway_cross_model_fallback_cutover_guards: arrayOfStrings(
      data.relay_ai_gateway_cross_model_fallback_cutover_guards,
    ),
  };
}

function validateCapabilities(capabilities, options) {
  for (const [field, expected] of [
    ["relay_ai_gateway_channel_opt_in_supported", true],
    ["relay_ai_gateway_rest_forwarder_compiled", true],
    ["relay_ai_gateway_same_channel_fallback_compiled", true],
    ["relay_ai_gateway_cross_model_fallback_compiled", true],
  ]) {
    if (capabilities[field] !== expected) {
      throw new Error(`platform capabilities ${field}=${capabilities[field]} did not match ${expected}`);
    }
  }
  for (const route of ["chat/completions", "responses", "messages"]) {
    if (!capabilities.relay_ai_gateway_rest_routes.includes(route)) {
      throw new Error(`platform capabilities missing AI Gateway REST route ${route}`);
    }
  }
  for (const guard of [
    "router_ready",
    "fallback_gate",
    "validated_mapping",
    "token_model_limit_recheck",
    "fallback_channel_reselection",
    "fallback_billing_rereservation",
    "single_group_billing_scope",
    "server_failure_only",
    "provider_native_direct_body",
    "model_route_audit",
    "staging_replay",
  ]) {
    if (!capabilities.relay_ai_gateway_cross_model_fallback_cutover_guards.includes(guard)) {
      throw new Error(`platform capabilities missing model fallback guard ${guard}`);
    }
  }
  for (const guard of [
    "router_ready",
    "channel_opted_in",
    "direct_provider_fallback",
    "billing_settlement_invariant",
  ]) {
    if (!capabilities.relay_ai_gateway_cutover_guards.includes(guard)) {
      throw new Error(`platform capabilities missing cutover guard ${guard}`);
    }
  }
  if (options.expectRouterEnabled && !capabilities.relay_ai_gateway_router_enabled) {
    throw new Error("expected relay_ai_gateway_router_enabled=true");
  }
  if (options.expectRouterDisabled && capabilities.relay_ai_gateway_router_enabled) {
    throw new Error("expected relay_ai_gateway_router_enabled=false");
  }
  if (options.expectRouterReady && !capabilities.relay_ai_gateway_router_ready) {
    throw new Error("expected relay_ai_gateway_router_ready=true");
  }
  if (options.expectFallbackEnabled && !capabilities.relay_ai_gateway_cross_model_fallback_enabled) {
    throw new Error("expected relay_ai_gateway_cross_model_fallback_enabled=true");
  }
  if (options.expectFallbackDisabled && capabilities.relay_ai_gateway_cross_model_fallback_enabled) {
    throw new Error("expected relay_ai_gateway_cross_model_fallback_enabled=false");
  }
  if (options.expectFallbackReady && !capabilities.relay_ai_gateway_cross_model_fallback_ready) {
    throw new Error("expected relay_ai_gateway_cross_model_fallback_ready=true");
  }
  if (
    options.expectFallbackStagingVerified &&
    !capabilities.relay_ai_gateway_cross_model_fallback_staging_verified
  ) {
    throw new Error("expected relay_ai_gateway_cross_model_fallback_staging_verified=true");
  }
  if (
    options.expectFallbackCutoverReady &&
    !capabilities.relay_ai_gateway_cross_model_fallback_cutover_ready
  ) {
    throw new Error("expected relay_ai_gateway_cross_model_fallback_cutover_ready=true");
  }
}

async function boundedText(response, maxBytes) {
  const text = await response.text();
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}...<truncated>`;
}

function adminHeaders(options) {
  const headers = { accept: "application/json" };
  if (options.adminCookie) headers.cookie = options.adminCookie;
  return headers;
}

function relayHeaders(options) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${required(options.apiKey, "api-key")}`,
    "x-cinatoken-smoke": "relay-ai-gateway-canary",
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(required(value, "url"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("url must use http or https");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url;
}

function buildHttpUrl(base, pathname) {
  const url = new URL(base.toString());
  url.pathname = pathname;
  return url.toString();
}

function validateEndpoint(value) {
  if (!endpointPaths.has(value)) {
    throw new Error(`endpoint must be one of: ${Array.from(endpointPaths.keys()).join(", ")}`);
  }
  return value;
}

function validateModelForEndpoint(value, endpoint) {
  const model = String(value || "").trim();
  if (!model) {
    throw new Error("request body model must be non-empty");
  }
  const providerPrefixed =
    model.startsWith("@cf/") || /^[a-z][a-z0-9_-]*\/[^/].+/i.test(model);
  if (!providerPrefixed) {
    throw new Error(
      `model must use Cloudflare AI Gateway provider prefix syntax, received: ${model}`,
    );
  }
  if (endpoint === "messages" && model.startsWith("@cf/")) {
    throw new Error("/v1/messages is Anthropic-schema traffic and must not use @cf Workers AI models");
  }
  return model;
}

function parseJsonObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} must be a valid JSON object: ${error.message}`);
  }
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "")).filter(Boolean)
    : [];
}

function requestIds(headers) {
  return {
    requestId:
      headers.get("x-request-id") ||
      headers.get("request-id") ||
      headers.get("openai-request-id") ||
      headers.get("anthropic-request-id"),
    cfRay: headers.get("cf-ray"),
  };
}

function evidenceReminder() {
  return [
    "Save this smoke output without raw Cookie or API key values.",
    "Capture Cloudflare AI Gateway logs for the same timestamp/model/gateway.",
    "Capture relay audit and billing rows proving usage parsing and settlement.",
    "If a retryable Gateway failure was induced, capture the direct-provider fallback audit branch.",
  ];
}

function responseModel(preview) {
  try {
    const value = JSON.parse(preview);
    return typeof value?.model === "string" ? value.model : null;
  } catch {
    return null;
  }
}

function runSelfTest() {
  const raw = {
    cloudflare_account_id_configured: true,
    ai_gateway_id_configured: true,
    cloudflare_ai_gateway_token_configured: true,
    relay_ai_gateway_router_enabled: false,
    relay_ai_gateway_router_ready: false,
    relay_ai_gateway_rest_routes: ["chat/completions", "responses", "messages"],
    relay_ai_gateway_cutover_guards: [
      "router_ready",
      "channel_opted_in",
      "direct_provider_fallback",
      "billing_settlement_invariant",
    ],
    relay_ai_gateway_channel_opt_in_supported: true,
    relay_ai_gateway_rest_forwarder_compiled: true,
    relay_ai_gateway_same_channel_fallback_compiled: true,
    relay_ai_gateway_cross_model_fallback_compiled: true,
    relay_ai_gateway_cross_model_fallback_enabled: false,
    relay_ai_gateway_cross_model_fallback_configured: false,
    relay_ai_gateway_cross_model_fallback_config_valid: true,
    relay_ai_gateway_cross_model_fallback_mapping_count: 0,
    relay_ai_gateway_cross_model_fallback_ready: false,
    relay_ai_gateway_cross_model_fallback_staging_verified: false,
    relay_ai_gateway_cross_model_fallback_cutover_ready: false,
    relay_ai_gateway_cross_model_fallback_cutover_guards: [
      "router_ready",
      "fallback_gate",
      "validated_mapping",
      "token_model_limit_recheck",
      "fallback_channel_reselection",
      "fallback_billing_rereservation",
      "single_group_billing_scope",
      "server_failure_only",
      "provider_native_direct_body",
      "model_route_audit",
      "staging_replay",
    ],
  };
  const options = {
    expectRouterEnabled: false,
    expectRouterDisabled: true,
    expectRouterReady: false,
    expectFallbackEnabled: false,
    expectFallbackDisabled: true,
    expectFallbackReady: false,
    expectFallbackStagingVerified: false,
    expectFallbackCutoverReady: false,
  };
  const capabilities = summarizeCapabilities(raw);
  validateCapabilities(capabilities, options);
  const routeDriftRejected = expectFailure(() =>
    validateCapabilities(
      summarizeCapabilities({
        ...raw,
        relay_ai_gateway_rest_routes: [
          "/ai/v1/chat/completions",
          "/ai/v1/responses",
          "/ai/v1/messages",
        ],
      }),
      options,
    ),
  );
  const unsafeCutoverRejected = expectFailure(() =>
    validateCapabilities(
      summarizeCapabilities({
        ...raw,
        relay_ai_gateway_cross_model_fallback_enabled: true,
        relay_ai_gateway_cross_model_fallback_ready: false,
      }),
      { ...options, expectFallbackDisabled: false, expectFallbackReady: true },
    ),
  );
  const servedModelParserOk =
    responseModel('{"model":"fallback/model"}') === "fallback/model";
  return {
    ok: routeDriftRejected && unsafeCutoverRejected && servedModelParserOk,
    selfTest: true,
    cases: [
      { name: "canonical-capability-contract", ok: true },
      { name: "route-drift-rejected", ok: routeDriftRejected },
      { name: "unsafe-cutover-rejected", ok: unsafeCutoverRejected },
      {
        name: "served-model-parser",
        ok: servedModelParserOk,
      },
    ],
  };
}

function expectFailure(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function optionalHeaderValue(value, name) {
  if (!value) return "";
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain newlines`);
  }
  return value;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function redactUrl(value) {
  const url = new URL(value);
  for (const key of ["key", "api_key", "access_token", "token"]) {
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
  console.log(JSON.stringify(result, null, 2));
}
