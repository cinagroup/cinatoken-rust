#!/usr/bin/env bun

const schemaVersion = 1;
const defaultTimeoutMs = 30_000;
const maxRequestBytes = 2 * 1024;
const maxResponseBytes = 16 * 1024;
const maxAdminBytes = 256 * 1024;
const auditPollAttempts = 15;
const auditPollDelayMs = 1_000;
const apiKeyEnv = "CINATOKEN_WFP_EGRESS_SMOKE_TOKEN";
const adminCookieEnv = "CINATOKEN_WFP_EGRESS_SMOKE_ADMIN_COOKIE";
const reviewedStagingOrigin =
  "https://cinatoken-rust-api-staging.cinagroup.workers.dev";
const productionHosts = new Set([
  "cinatoken.com",
  "www.cinatoken.com",
  "api.cinatoken.com",
]);
const routeDefinitions = new Map([
  [
    "chat",
    {
      path: "/v1/chat/completions",
      defaultModel: "openai/gpt-4.1-mini",
    },
  ],
  [
    "responses",
    {
      path: "/v1/responses",
      defaultModel: "openai/gpt-4.1-mini",
    },
  ],
  [
    "messages",
    {
      path: "/v1/messages",
      defaultModel: "anthropic/claude-haiku-4-5",
    },
  ],
  [
    "ai-run",
    {
      path: "/ai/run",
      defaultModel: "@cf/meta/llama-3.1-8b-instruct",
    },
  ],
]);
const internalResponseHeaders = new Set([
  "x-cinatoken-wfp-route",
  "x-cinatoken-wfp-worker",
  "x-cinatoken-wfp-tenant",
  "x-cinatoken-wfp-runtime",
]);
const forbiddenResponseHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "cookie",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
]);

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.flags.has("self-test")) {
    result = await runSelfTest();
  } else {
    const plan = normalizePlan(args);
    if (plan.dryRun) {
      result = buildDryRun(plan);
    } else {
      requireLiveConfirmation(args, plan);
      const credentials = readLiveCredentials();
      result = await runLiveSmoke(plan, credentials);
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "WFP egress smoke failed");
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const knownValues = new Set([
    "url",
    "scenario",
    "worker",
    "channel-id",
    "group",
    "target",
    "chat-model",
    "responses-model",
    "messages-model",
    "ai-run-model",
  ]);
  const knownFlags = new Set([
    "confirm-live",
    "confirm-isolated-staging",
    "confirm-single-channel",
    "confirm-retry-disabled",
    "confirm-tenant-attempts-one",
    "dry-run",
    "self-test",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) usage(2, `[input] unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (knownFlags.has(key)) {
      if (flags.has(key)) usage(2, `[input] ${arg} must not be repeated`);
      flags.add(key);
      continue;
    }
    if (!knownValues.has(key)) usage(2, `[input] unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      usage(2, `[input] ${arg} requires a value`);
    }
    if (values.has(key)) usage(2, `[input] ${arg} must not be repeated`);
    values.set(key, value);
  }

  if (flags.has("self-test") && (values.size > 0 || flags.size > 1)) {
    usage(2, "[input] --self-test does not accept other options");
  }
  return { values, flags };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage:",
      "  bun tools/smoke_wfp_outbound_egress.mjs --target staging --scenario <route> --worker <tenant> --channel-id <id> --group <fixed-group> --confirm-live --confirm-isolated-staging --confirm-single-channel --confirm-retry-disabled --confirm-tenant-attempts-one",
      "  bun tools/smoke_wfp_outbound_egress.mjs --url http://127.0.0.1:8787 --scenario all --worker tenant-smoke --channel-id 7 --dry-run",
      "  bun tools/smoke_wfp_outbound_egress.mjs --self-test",
      "",
      "Routes: chat, responses, messages, ai-run, or all.",
      "Live credentials are accepted only from CINATOKEN_WFP_EGRESS_SMOKE_TOKEN and CINATOKEN_WFP_EGRESS_SMOKE_ADMIN_COOKIE.",
      "Live mode uses one fixed route, its code-reviewed model, and the reviewed staging origin.",
      "The tool performs paid relay requests and never enables or disables Cloudflare gates.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function normalizePlan(args) {
  const dryRun = args.flags.has("dry-run");
  const target = args.values.get("target") || "staging";
  if (target !== "staging") throw new Error("[input] target must be staging");
  if (!dryRun && args.values.has("url")) {
    throw new Error("[safety] live smoke does not accept a custom URL");
  }
  if (
    !dryRun &&
    ["chat-model", "responses-model", "messages-model", "ai-run-model"].some(
      (name) => args.values.has(name),
    )
  ) {
    throw new Error("[safety] live smoke does not accept model overrides");
  }
  const baseUrl = normalizeBaseUrl(
    dryRun
      ? args.values.get("url") || "http://127.0.0.1:8787"
      : reviewedStagingOrigin,
  );
  const scenario = requireScenario(args.values.get("scenario") || "all");
  const worker = requireWorkerName(
    args.values.get("worker") || process.env.WFP_EGRESS_SMOKE_WORKER || "tenant-smoke",
  );
  const channelId = requirePositiveInteger(
    args.values.get("channel-id") || process.env.WFP_EGRESS_SMOKE_CHANNEL_ID || "7",
    "channel-id",
  );
  const group = optionalSingleLine(
    args.values.get("group") || (dryRun ? "wfp-smoke" : null),
    "group",
  );
  const selectedRoutes =
    scenario === "all" ? [...routeDefinitions.keys()] : [scenario];
  const routes = selectedRoutes.map((name) => {
    const definition = routeDefinitions.get(name);
    const flagName = `${name}-model`;
    const model = requireModel(
      dryRun && args.values.get(flagName)
        ? args.values.get(flagName)
        : definition.defaultModel,
      name,
    );
    const payload = defaultPayload(name, model);
    const body = JSON.stringify(payload);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > maxRequestBytes) {
      throw new Error(`[input] ${name} request body exceeded ${maxRequestBytes} bytes`);
    }
    return {
      name,
      path: definition.path,
      model,
      body,
      bodyBytes,
      url: endpointUrl(baseUrl, definition.path),
    };
  });

  if (!dryRun && baseUrl.protocol !== "https:") {
    throw new Error("[safety] live smoke requires an HTTPS staging origin");
  }
  return {
    schemaVersion,
    dryRun,
    baseUrl,
    target,
    scenario,
    worker,
    channelId,
    group,
    timeoutMs: defaultTimeoutMs,
    routes,
  };
}

function requireLiveConfirmation(args, plan) {
  if (!args.flags.has("confirm-live")) {
    throw new Error("[confirmation] live smoke requires --confirm-live");
  }
  if (!args.flags.has("confirm-isolated-staging")) {
    throw new Error(
      "[confirmation] live smoke requires --confirm-isolated-staging",
    );
  }
  if (!args.flags.has("confirm-single-channel")) {
    throw new Error("[confirmation] live smoke requires --confirm-single-channel");
  }
  if (!args.flags.has("confirm-retry-disabled")) {
    throw new Error("[confirmation] live smoke requires --confirm-retry-disabled");
  }
  if (!args.flags.has("confirm-tenant-attempts-one")) {
    throw new Error(
      "[confirmation] live smoke requires --confirm-tenant-attempts-one",
    );
  }
  if (plan.scenario === "all") {
    throw new Error("[safety] live smoke permits exactly one route per invocation");
  }
  if (!plan.group || plan.group === "auto") {
    throw new Error("[safety] live smoke requires a fixed non-auto group");
  }
  if (
    plan.baseUrl.toString() !== `${reviewedStagingOrigin}/` ||
    productionHosts.has(plan.baseUrl.hostname)
  ) {
    throw new Error("[safety] live smoke origin is not the reviewed staging origin");
  }
}

function readLiveCredentials() {
  return {
    apiKey: requireCredential(process.env[apiKeyEnv], apiKeyEnv),
    adminCookie: requireCredential(process.env[adminCookieEnv], adminCookieEnv),
  };
}

function buildDryRun(plan) {
  return {
    ok: true,
    schemaVersion,
    source: "cinatoken-wfp-outbound-egress-smoke",
    dryRun: true,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    identity: planIdentity(plan),
    capabilitiesRequest: {
      method: "GET",
      path: "/api/platform/capabilities",
    },
    relayRequests: plan.routes.map((route) => ({
      scenario: route.name,
      method: "POST",
      path: route.path,
      model: route.model,
      bodyBytes: route.bodyBytes,
      stream: false,
      maxOutputTokens: 8,
    })),
    auditRequests: plan.routes.map((route) => ({
      scenario: route.name,
      method: "GET",
      path: "/api/log/",
      filter: "type=2 and exact generated request_id",
    })),
    limits: {
      requestBytes: maxRequestBytes,
      responseBytes: maxResponseBytes,
      adminBytes: maxAdminBytes,
      timeoutMs: plan.timeoutMs,
      auditPollAttempts,
    },
    requiredExternalEvidence: externalEvidenceChecklist(),
  };
}

async function runLiveSmoke(plan, credentials, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || (() => Date.now());
  const randomUuid = dependencies.randomUuid || (() => crypto.randomUUID());
  if (typeof fetchImpl !== "function") throw new Error("[smoke] fetch is unavailable");

  const capabilitiesUrl = endpointUrl(plan.baseUrl, "/api/platform/capabilities");
  const capabilitiesResponse = await fetchBounded(
    capabilitiesUrl,
    {
      method: "GET",
      headers: { accept: "application/json", cookie: credentials.adminCookie },
      redirect: "error",
    },
    plan.timeoutMs,
    maxAdminBytes,
    "platform-capabilities",
    fetchImpl,
  );
  const capabilities = validateCapabilities(
    readDataEnvelope(capabilitiesResponse, "platform-capabilities"),
  );

  const routeEvidence = [];
  for (const route of plan.routes) {
    const requestId = `wfp-egress-${route.name}-${now()}-${randomUuid()}`;
    const relayResponse = await fetchBounded(
      route.url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.apiKey}`,
          "content-type": "application/json",
          "x-cinatoken-smoke": "wfp-outbound-egress",
          "x-request-id": requestId,
        },
        body: route.body,
        redirect: "error",
      },
      plan.timeoutMs,
      maxResponseBytes,
      route.name,
      fetchImpl,
    );
    const response = validateRelayResponse(relayResponse, route, requestId);
    const audit = await pollSuccessAudit(
      plan,
      credentials.adminCookie,
      route,
      requestId,
      fetchImpl,
      dependencies.sleep || sleep,
    );
    routeEvidence.push({ ...response, audit });
  }

  const evidence = {
    ok: true,
    schemaVersion,
    source: "cinatoken-wfp-outbound-egress-smoke",
    dryRun: false,
    capturedAt: new Date(now()).toISOString(),
    identity: planIdentity(plan),
    capabilities,
    routes: routeEvidence,
    verified: routeEvidence.length === plan.routes.length,
    requiredExternalEvidence: externalEvidenceChecklist(),
  };
  assertCredentialsAbsent(evidence, credentials);
  return evidence;
}

async function pollSuccessAudit(
  plan,
  adminCookie,
  route,
  requestId,
  fetchImpl,
  sleepImpl,
) {
  const url = new URL(endpointUrl(plan.baseUrl, "/api/log/"));
  url.searchParams.set("type", "2");
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("page_size", "10");

  for (let attempt = 1; attempt <= auditPollAttempts; attempt += 1) {
    const response = await fetchBounded(
      url.toString(),
      {
        method: "GET",
        headers: { accept: "application/json", cookie: adminCookie },
        redirect: "error",
      },
      plan.timeoutMs,
      maxAdminBytes,
      `${route.name}-audit`,
      fetchImpl,
    );
    const data = readDataEnvelope(response, `${route.name}-audit`);
    const rows = Array.isArray(data?.items) ? data.items : [];
    if (rows.length > 0) {
      return validateSuccessAuditRows(rows, {
        route,
        requestId,
        worker: plan.worker,
        channelId: plan.channelId,
        group: plan.group,
        pollAttempt: attempt,
      });
    }
    if (attempt < auditPollAttempts) await sleepImpl(auditPollDelayMs);
  }
  throw new Error(`[audit] no success row appeared for ${route.name}`);
}

async function fetchBounded(url, init, timeoutMs, limit, label, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === "AbortError") {
      throw new Error(`[${label}] request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`[${label}] request failed`);
  }
  try {
    if (response.redirected) throw new Error(`[${label}] redirects are forbidden`);
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength != null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)
    ) {
      throw new Error(`[${label}] response exceeded ${limit} bytes`);
    }
    const bytes = await readBoundedBody(response.body, limit, label);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
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
      if (!(value instanceof Uint8Array)) {
        throw new Error(`[${label}] response stream was malformed`);
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`[${label}] response exceeded ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function readDataEnvelope(response, label) {
  const value = parseJsonResponse(response, label);
  if (!response.ok) {
    throw new Error(`[${label}] returned status ${response.status}`);
  }
  if (!value || typeof value !== "object" || value.success !== true || !value.data) {
    throw new Error(`[${label}] expected a successful {success,data} envelope`);
  }
  return value.data;
}

function parseJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`[${label}] response must be application/json`);
  }
  try {
    return JSON.parse(response.bytes.toString("utf8"));
  } catch {
    throw new Error(`[${label}] response was not valid JSON`);
  }
}

function validateCapabilities(data) {
  const requiredTrue = [
    "wfp_dispatch_binding_available",
    "wfp_dispatch_enabled",
    "wfp_relay_transport_enabled",
    "wfp_relay_authority_secret_configured",
    "wfp_authority_replay_do_available",
    "wfp_authority_replay_do_compiled",
    "wfp_relay_authority_transport_compiled",
    "wfp_relay_authority_transport_ready",
    "wfp_tenant_rust_wasm_runtime_compiled",
    "wfp_tenant_route_manifest_compiled",
    "wfp_tenant_relay_authority_verifier_compiled",
    "wfp_tenant_response_header_guard_compiled",
    "wfp_outbound_egress_policy_compiled",
  ];
  for (const field of requiredTrue) {
    if (data?.[field] !== true) {
      throw new Error(`[capabilities] ${field} must be true`);
    }
  }
  if (data.relay_ai_gateway_cross_model_fallback_enabled !== false) {
    throw new Error(
      "[capabilities] relay_ai_gateway_cross_model_fallback_enabled must be false",
    );
  }
  if (data.relay_retry_times !== 0) {
    throw new Error("[capabilities] relay_retry_times must be 0");
  }
  const routes = requireStringArray(
    data.wfp_tenant_supported_routes,
    "wfp_tenant_supported_routes",
  );
  for (const { path } of routeDefinitions.values()) {
    if (!routes.includes(path)) {
      throw new Error(`[capabilities] missing WFP route ${path}`);
    }
  }
  if (routes.includes("/v1/embeddings")) {
    throw new Error("[capabilities] embeddings must not be a WFP tenant route");
  }
  return {
    requiredTrue,
    supportedRoutes: routes,
    relayAuthorityTransportReady: true,
    modelFallbackDisabled: true,
    relayRetryTimes: 0,
  };
}

function validateRelayResponse(response, route, requestId) {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    throw new Error(`[${route.name}] relay returned non-2xx status ${response.status}`);
  }
  const violations = responseHeaderViolations(response.headers);
  if (violations.length > 0) {
    throw new Error(`[${route.name}] response leaked forbidden headers: ${violations.join(",")}`);
  }
  const value = parseJsonResponse(response, route.name);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[${route.name}] response must be a JSON object`);
  }
  if (value.error != null) {
    throw new Error(`[${route.name}] 2xx response contained an error object`);
  }
  return {
    scenario: route.name,
    path: route.path,
    model: route.model,
    requestId,
    status: response.status,
    responseBytes: response.bytes.length,
    responseIds: safeResponseIds(response.headers),
    responseSummary: summarizeProviderResponse(value),
    internalHeadersAbsent: true,
    sensitiveHeadersAbsent: true,
  };
}

function validateSuccessAuditRows(rows, expected) {
  if (rows.length !== 1) {
    throw new Error(`[audit] expected exactly one row, received ${rows.length}`);
  }
  const row = rows[0];
  if (row.type !== 2 || row.request_id !== expected.requestId) {
    throw new Error("[audit] type or request_id did not match");
  }
  if (row.channel_id !== expected.channelId) {
    throw new Error("[audit] selected channel did not match the isolated WFP fixture");
  }
  if (row.model !== expected.route.model) {
    throw new Error("[audit] requested model did not match");
  }
  if (expected.group && row.group !== expected.group) {
    throw new Error("[audit] serving group did not match");
  }
  if (!Number.isInteger(row.quota) || row.quota < 0) {
    throw new Error("[audit] quota must be a nonnegative integer");
  }
  const other = parseJsonObject(row.other || "{}", "audit other");
  if (other.relay_runtime !== "cloudflare_worker_rust") {
    throw new Error("[audit] relay runtime did not match Rust Worker");
  }
  if (other.model_route?.wfp_worker !== expected.worker) {
    throw new Error("[audit] WFP worker did not match");
  }
  if (other.billing_pending !== false) {
    throw new Error("[audit] billing remained pending");
  }
  for (const key of ["flat_billing_error", "tiered_billing_shadow_error"]) {
    if (other[key] != null) throw new Error(`[audit] ${key} was present`);
  }
  const billingMode = billingModeFromAudit(other);
  if (!billingMode) {
    throw new Error("[audit] no resolved billing or refund evidence was present");
  }
  assertAuditRedacted(other);
  return {
    pollAttempt: expected.pollAttempt,
    rowId: row.id,
    type: row.type,
    requestId: row.request_id,
    channelId: row.channel_id,
    group: row.group,
    model: row.model,
    quota: row.quota,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    billingPending: false,
    billingMode,
    wfpWorker: other.model_route.wfp_worker,
    upstreamRequestIdPresent:
      typeof row.upstream_request_id === "string" && row.upstream_request_id.length > 0,
  };
}

function billingModeFromAudit(other) {
  for (const key of [
    "tiered_billing",
    "tiered_billing_fallback",
    "tiered_billing_refund",
    "flat_billing",
  ]) {
    if (other[key] && typeof other[key] === "object") return key;
  }
  return null;
}

function assertAuditRedacted(other) {
  const serialized = JSON.stringify(other).toLowerCase();
  for (const marker of [
    "authorization",
    "x-cinatoken-wfp-authority",
    "bearer ",
    "api_key",
    "https://",
    "http://",
  ]) {
    if (serialized.includes(marker)) {
      throw new Error(`[audit] forbidden marker ${marker} was present`);
    }
  }
}

function responseHeaderViolations(headers) {
  const violations = [];
  for (const [rawName] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (
      internalResponseHeaders.has(name) ||
      forbiddenResponseHeaders.has(name) ||
      name.startsWith("cf-aig-") ||
      (name.startsWith("x-cinatoken-") && name !== "x-cinatoken-smoke")
    ) {
      violations.push(name);
    }
  }
  return [...new Set(violations)].sort();
}

function summarizeProviderResponse(value) {
  const usage = value.usage || value.usage_metadata || value.usageMetadata;
  return {
    idPresent: typeof value.id === "string" && value.id.length > 0,
    model: typeof value.model === "string" ? safeSingleLine(value.model) : null,
    object: typeof value.object === "string" ? safeSingleLine(value.object) : null,
    usagePresent: Boolean(usage && typeof usage === "object"),
  };
}

function safeResponseIds(headers) {
  return {
    requestIdPresent: [
      "x-request-id",
      "request-id",
      "openai-request-id",
      "anthropic-request-id",
    ].some((name) => Boolean(headers.get(name))),
    cfRayPresent: Boolean(headers.get("cf-ray")),
  };
}

function defaultPayload(route, model) {
  const prompt = "cinatoken WFP outbound staging smoke: reply with OK";
  if (route === "responses") {
    return { model, input: prompt, max_output_tokens: 8, stream: false };
  }
  if (route === "messages") {
    return {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt }],
    };
  }
  if (route === "ai-run") {
    return {
      model,
      input: { prompt, max_tokens: 8 },
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8,
    stream: false,
  };
}

function externalEvidenceChecklist() {
  return [
    "Archive the outbound attachment readback captured immediately before this smoke.",
    "Archive Cloudflare AI Gateway or Workers AI logs correlated by route, timestamp, model, and request identifiers.",
    "Archive before/after user, token, and channel quota snapshots without token or channel keys.",
    "Prove exactly one provider call and exactly one final type-2 audit row for each request.",
    "Disable WFP_RELAY_TRANSPORT_ENABLED after the isolated smoke window and archive rollback capability output.",
    "Run authority tamper/replay, embeddings, method, content-type, body-limit, URL, header, and redirect negatives separately.",
  ];
}

function planIdentity(plan) {
  return {
    origin: `${plan.baseUrl.protocol}//${plan.baseUrl.host}`,
    target: plan.target,
    scenario: plan.scenario,
    worker: plan.worker,
    channelId: plan.channelId,
    group: plan.group,
  };
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("[input] url is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("[input] url must be an absolute HTTP(S) URL");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("[input] url must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("[input] url must not contain credentials, query, or fragment");
  }
  url.pathname = "/";
  return url;
}

function endpointUrl(base, path) {
  const url = new URL(base.toString());
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requireScenario(value) {
  if (value !== "all" && !routeDefinitions.has(value)) {
    throw new Error("[input] scenario must be chat, responses, messages, ai-run, or all");
  }
  return value;
}

function requireWorkerName(value) {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error("[input] worker must be a valid WFP Worker name");
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`[input] ${label} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`[input] ${label} exceeded the safe integer range`);
  }
  return number;
}

function requireModel(value, route) {
  const model = optionalSingleLine(value, `${route} model`);
  if (!model || model.length > 200 || !/^(?:@cf\/[A-Za-z0-9._/-]+|[a-z][a-z0-9_-]*\/[^\s/][^\s]*)$/.test(model)) {
    throw new Error(`[input] ${route} model must use a provider prefix or @cf/ prefix`);
  }
  if (route === "messages" && model.startsWith("@cf/")) {
    throw new Error("[input] messages model must use an Anthropic-compatible provider prefix");
  }
  return model;
}

function optionalSingleLine(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.trim() === "") {
    throw new Error(`[input] ${label} must be a nonempty single-line string`);
  }
  return value.trim();
}

function requireCredential(value, envName) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`[credentials] ${envName} must contain a valid staging credential`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`[capabilities] ${label} must be an array of strings`);
  }
  return [...new Set(value)].sort();
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`[${label}] must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[${label}] must be a JSON object`);
  }
  return parsed;
}

function safeSingleLine(value) {
  return value.replace(/[\r\n\0]/g, "").slice(0, 200);
}

function assertCredentialsAbsent(value, credentials) {
  const serialized = JSON.stringify(value);
  for (const credential of [credentials.apiKey, credentials.adminCookie]) {
    const encoded = Buffer.from(credential, "utf8").toString("base64");
    const encodedUrl = Buffer.from(credential, "utf8").toString("base64url");
    const percentEncoded = encodeURIComponent(credential);
    if (
      serialized.includes(credential) ||
      serialized.includes(encoded) ||
      serialized.includes(encodedUrl) ||
      serialized.includes(percentEncoded)
    ) {
      throw new Error("[redaction] staging credential appeared in smoke evidence");
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSelfTest() {
  const cases = [];
  const capabilities = capabilityFixture();
  validateCapabilities(capabilities);
  cases.push(pass("canonical-capabilities"));

  expectFailure("missing-ready-gate", () =>
    validateCapabilities({ ...capabilities, wfp_relay_authority_transport_ready: false }),
  );
  cases.push(pass("missing-ready-gate"));
  expectFailure("embeddings-route", () =>
    validateCapabilities({
      ...capabilities,
      wfp_tenant_supported_routes: [
        ...capabilities.wfp_tenant_supported_routes,
        "/v1/embeddings",
      ],
    }),
  );
  cases.push(pass("embeddings-route"));

  const safeHeaders = new Headers({
    "content-type": "application/json",
    "x-request-id": "safe-id",
  });
  if (responseHeaderViolations(safeHeaders).length !== 0) {
    throw new Error("[self-test] safe response headers were rejected");
  }
  cases.push(pass("safe-response-headers"));
  for (const name of ["authorization", "set-cookie", "cf-aig-log-id", "x-cinatoken-wfp-runtime"]) {
    const headers = new Headers({ [name]: "fixture" });
    if (!responseHeaderViolations(headers).includes(name)) {
      throw new Error(`[self-test] ${name} response header was accepted`);
    }
  }
  cases.push(pass("sensitive-response-headers"));

  const route = {
    name: "chat",
    path: "/v1/chat/completions",
    model: "openai/gpt-4.1-mini",
  };
  const audit = auditFixture(route);
  const expected = {
    route,
    requestId: "req-wfp-self-test",
    worker: "tenant-smoke",
    channelId: 7,
    group: "default",
    pollAttempt: 1,
  };
  validateSuccessAuditRows([audit], expected);
  cases.push(pass("resolved-flat-audit"));
  expectFailure("pending-audit", () =>
    validateSuccessAuditRows(
      [{ ...audit, other: auditOther({ billing_pending: true }) }],
      expected,
    ),
  );
  cases.push(pass("pending-audit"));
  expectFailure("wrong-worker", () =>
    validateSuccessAuditRows(
      [{ ...audit, other: auditOther({ model_route: { wfp_worker: "other" } }) }],
      expected,
    ),
  );
  cases.push(pass("wrong-worker"));
  expectFailure("wrong-channel", () =>
    validateSuccessAuditRows([{ ...audit, channel_id: 8 }], expected),
  );
  cases.push(pass("wrong-channel"));
  expectFailure("billing-error", () =>
    validateSuccessAuditRows(
      [{ ...audit, other: auditOther({ flat_billing_error: "failed" }) }],
      expected,
    ),
  );
  cases.push(pass("billing-error"));
  expectFailure("audit-secret-marker", () =>
    validateSuccessAuditRows(
      [{ ...audit, other: auditOther({ debug: "Authorization: Bearer fixture" }) }],
      expected,
    ),
  );
  cases.push(pass("audit-secret-marker"));

  const plan = normalizePlan({
    values: new Map([
      ["url", "http://127.0.0.1:8787"],
      ["scenario", "all"],
      ["worker", "tenant-smoke"],
      ["channel-id", "7"],
    ]),
    flags: new Set(["dry-run"]),
  });
  const dryRun = buildDryRun(plan);
  if (
    dryRun.credentialsRead !== false ||
    dryRun.networkRequests !== false ||
    dryRun.relayRequests.length !== 4
  ) {
    throw new Error("[self-test] dry-run contract failed");
  }
  cases.push(pass("credential-free-four-route-plan"));
  expectFailure("multi-route-live", () =>
    requireLiveConfirmation(
      {
        flags: new Set([
          "confirm-live",
          "confirm-isolated-staging",
          "confirm-single-channel",
          "confirm-retry-disabled",
          "confirm-tenant-attempts-one",
        ]),
      },
      {
        ...plan,
        baseUrl: new URL(`${reviewedStagingOrigin}/`),
      },
    ),
  );
  cases.push(pass("multi-route-live"));
  expectFailure("invalid-messages-model", () => requireModel("@cf/model", "messages"));
  cases.push(pass("invalid-messages-model"));

  const credentials = {
    apiKey: "self-test-api-key-value",
    adminCookie: "session=self-test-cookie-value",
  };
  expectFailure("credential-echo", () =>
    assertCredentialsAbsent({ leaked: credentials.apiKey }, credentials),
  );
  cases.push(pass("credential-echo"));

  const livePlan = {
    ...plan,
    dryRun: false,
    baseUrl: new URL(`${reviewedStagingOrigin}/`),
    scenario: "chat",
    group: "default",
    routes: [plan.routes[0]],
  };
  const mockLive = await runLiveSmoke(livePlan, credentials, {
    fetchImpl: successfulMockFetch(livePlan, credentials),
    now: () => Date.parse("2026-07-12T00:00:00.000Z"),
    randomUuid: () => "11111111-2222-4333-8444-555555555555",
    sleep: async () => {},
  });
  if (
    mockLive.verified !== true ||
    mockLive.routes.length !== 1 ||
    mockLive.routes[0].audit.billingPending !== false ||
    JSON.stringify(mockLive).includes(credentials.apiKey) ||
    JSON.stringify(mockLive).includes(credentials.adminCookie)
  ) {
    throw new Error("[self-test] mock live evidence was invalid or unredacted");
  }
  cases.push(pass("mock-live-relay-audit-chain"));

  await expectAsyncFailure("bounded-live-response", () =>
    runLiveSmoke(livePlan, credentials, {
      fetchImpl: oversizedMockFetch(),
      now: () => Date.parse("2026-07-12T00:00:00.000Z"),
      randomUuid: () => "11111111-2222-4333-8444-555555555555",
      sleep: async () => {},
    }),
  );
  cases.push(pass("bounded-live-response"));

  return { ok: true, schemaVersion, cases, passed: cases.length };
}

function successfulMockFetch(plan, credentials) {
  let call = 0;
  let requestId = null;
  return async (_url, init) => {
    call += 1;
    if (call === 1) return jsonHttpResponse({ success: true, data: capabilityFixture() });
    if (call === 2) {
      if (init.headers.authorization !== `Bearer ${credentials.apiKey}`) {
        throw new Error("mock relay credential mismatch");
      }
      requestId = init.headers["x-request-id"];
      return jsonHttpResponse({
        id: "response-self-test",
        model: plan.routes[0].model,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (call === 3) {
      const row = {
        ...auditFixture(plan.routes[0]),
        request_id: requestId,
      };
      return jsonHttpResponse({ success: true, data: { items: [row] } });
    }
    throw new Error("unexpected mock request");
  };
}

function oversizedMockFetch() {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) return jsonHttpResponse({ success: true, data: capabilityFixture() });
    return new Response(Buffer.alloc(maxResponseBytes + 1, 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function jsonHttpResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capabilityFixture() {
  return {
    wfp_dispatch_binding_available: true,
    wfp_dispatch_enabled: true,
    wfp_relay_transport_enabled: true,
    wfp_relay_authority_secret_configured: true,
    wfp_authority_replay_do_available: true,
    wfp_authority_replay_do_compiled: true,
    wfp_relay_authority_transport_compiled: true,
    wfp_relay_authority_transport_ready: true,
    wfp_tenant_rust_wasm_runtime_compiled: true,
    wfp_tenant_route_manifest_compiled: true,
    wfp_tenant_relay_authority_verifier_compiled: true,
    wfp_tenant_response_header_guard_compiled: true,
    wfp_outbound_egress_policy_compiled: true,
    relay_ai_gateway_cross_model_fallback_enabled: false,
    relay_retry_times: 0,
    wfp_tenant_supported_routes: [
      "/__cinatoken/tenant/status",
      ...[...routeDefinitions.values()].map((route) => route.path),
    ],
  };
}

function auditFixture(route) {
  return {
    id: 101,
    type: 2,
    request_id: "req-wfp-self-test",
    upstream_request_id: "upstream-safe-id",
    channel_id: 7,
    group: "default",
    model: route.model,
    quota: 15,
    prompt_tokens: 10,
    completion_tokens: 5,
    other: auditOther(),
  };
}

function auditOther(overrides = {}) {
  const base = {
    billing_pending: false,
    relay_runtime: "cloudflare_worker_rust",
    endpoint: "chat/completions",
    model_route: { wfp_worker: "tenant-smoke" },
    flat_billing: { quota: 15, mode: "per_token" },
  };
  return JSON.stringify({
    ...base,
    ...overrides,
    model_route: overrides.model_route || base.model_route,
  });
}

function expectFailure(name, callback) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`[self-test] ${name} unexpectedly passed`);
}

async function expectAsyncFailure(name, callback) {
  try {
    await callback();
  } catch {
    return;
  }
  throw new Error(`[self-test] ${name} unexpectedly passed`);
}

function pass(name) {
  return { name, passed: true };
}
