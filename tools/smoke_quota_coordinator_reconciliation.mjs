#!/usr/bin/env bun

const defaultUrl = "http://127.0.0.1:8787";
const defaultTimeoutMs = 15_000;
const capabilitiesPath = "/api/platform/capabilities";
const reconciliationPath = "/api/platform/quota-coordinator/reconciliation";
const differenceFields = [
  "reserve_count",
  "settle_count",
  "refund_count",
  "active_reservations",
  "terminal_reservations",
  "outstanding_quota",
  "reserved_quota",
  "final_quota",
  "refunded_quota",
  "user_net_delta",
  "token_net_delta",
  "channel_used_quota",
  "request_count",
];

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.flags.has("self-test")
    ? await runSelfTest()
    : args.flags.has("dry-run")
      ? buildPlan(normalizeOptions(args, true))
      : await runLive(normalizeOptions(args, false));
  printResult(result, args.flags.has("json"));
  if (result.status !== "PASS") process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set(["self-test", "dry-run", "confirm-live", "json"]);
  const valueNames = new Set(["url", "cookie", "token-id", "timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (flagNames.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueNames.has(name)) throw new Error(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    values.set(name, value);
    index += 1;
  }
  if (flags.has("self-test") && (flags.has("dry-run") || values.size > 0)) {
    throw new Error("--self-test does not accept network options or --dry-run");
  }
  if (
    flags.has("confirm-live") &&
    (flags.has("self-test") || flags.has("dry-run"))
  ) {
    throw new Error("--confirm-live is only valid in live mode");
  }
  return { values, flags };
}

function normalizeOptions(args, dryRun) {
  const value = (name, envName) =>
    args.values.get(name) ?? process.env[envName];
  const tokenId = String(
    value("token-id", "QUOTA_COORD_RECONCILIATION_TOKEN_ID") || "",
  ).trim();
  if (
    !/^[1-9][0-9]*$/.test(tokenId) ||
    BigInt(tokenId) > 9_223_372_036_854_775_807n
  ) {
    throw new Error("token-id must be a canonical positive i64");
  }
  const timeoutMs = Number(
    value("timeout-ms", "QUOTA_COORD_RECONCILIATION_TIMEOUT_MS") ||
      defaultTimeoutMs,
  );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  ) {
    throw new Error("timeout-ms must be an integer between 1 and 120000");
  }
  const cookie = optionalHeaderValue(
    value("cookie", "QUOTA_COORD_RECONCILIATION_COOKIE"),
    "cookie",
  );
  if (!dryRun && !args.flags.has("confirm-live")) {
    throw new Error("live quota reconciliation requires --confirm-live");
  }
  if (!dryRun && !cookie) {
    throw new Error(
      "live quota reconciliation requires --cookie or QUOTA_COORD_RECONCILIATION_COOKIE",
    );
  }
  return {
    baseUrl: normalizeBaseUrl(
      value("url", "QUOTA_COORD_RECONCILIATION_URL") || defaultUrl,
    ),
    cookie,
    tokenId,
    timeoutMs,
    dryRun,
  };
}

function buildPlan(options) {
  return {
    tool: "smoke_quota_coordinator_reconciliation",
    mode: "dry-run",
    status: "PASS",
    dryRun: true,
    endpoint: `${options.baseUrl}${reconciliationPath}`,
    adminCookieConfigured: Boolean(options.cookie),
    tokenIdConfigured: true,
    requests: [
      { method: "GET", path: capabilitiesPath },
      {
        method: "POST",
        path: reconciliationPath,
        body: { token_id: ":allowlisted_token_id" },
      },
    ],
    passContract: {
      status: "matched",
      sourceStable: true,
      observerHealthy: true,
      allAccountingDifferencesZero: true,
      observerConflictCount: 0,
      legacyTerminalReservations: 0,
    },
    safety: {
      readOnly: true,
      confirmLiveRequired: true,
      allowlistedTokenRequired: true,
      secretOutput: "Cookie and raw token identity are never printed.",
    },
  };
}

async function runLive(options) {
  const headers = {
    accept: "application/json",
    cookie: options.cookie,
    "x-cinatoken-smoke": "quota-coordinator-reconciliation",
  };
  const capabilities = await requestEnvelope(
    `${options.baseUrl}${capabilitiesPath}`,
    { method: "GET", headers },
    options.timeoutMs,
    "platform capabilities",
  );
  validateCapabilities(capabilities);
  const report = await requestEnvelope(
    `${options.baseUrl}${reconciliationPath}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ token_id: options.tokenId }),
    },
    options.timeoutMs,
    "quota coordinator reconciliation",
    true,
  );
  const evidence = validateReport(report);
  return {
    tool: "smoke_quota_coordinator_reconciliation",
    mode: "live",
    status: "PASS",
    dryRun: false,
    adminCookieConfigured: true,
    tokenScopeHash: evidence.tokenScopeHash,
    summary: evidence.summary,
    diagnostics: evidence.diagnostics,
  };
}

function validateCapabilities(value) {
  assertObject(value, "capabilities");
  for (const field of [
    "quota_coordinator_reconciliation_compiled",
    "quota_coordinator_reconciliation_runtime_ready",
    "quota_coordinator_shadow_runtime_ready",
  ]) {
    if (value[field] !== true) throw new Error(`${field} must be true`);
  }
  if (value.quota_coordinator_write_authority_enabled !== false) {
    throw new Error(
      "quota_coordinator_write_authority_enabled must remain false",
    );
  }
}

function validateReport(report) {
  assertObject(report, "reconciliation report");
  if (report.contract_version !== 1)
    throw new Error("contract_version must be 1");
  if (report.status !== "matched") throw new Error("status must be matched");
  if (report.source_stable !== true)
    throw new Error("source_stable must be true");
  if (report.observer_healthy !== true)
    throw new Error("observer_healthy must be true");
  if (
    typeof report.token_scope_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.token_scope_hash)
  ) {
    throw new Error("token_scope_hash must be a lowercase SHA-256 digest");
  }
  if (Object.hasOwn(report, "token_id"))
    throw new Error("report exposed token_id");
  assertObject(report.d1, "D1 projection");
  assertObject(report.observer, "observer projection");
  assertObject(report.difference, "projection difference");
  for (const field of differenceFields) {
    if (
      !Number.isSafeInteger(report.difference[field]) ||
      report.difference[field] !== 0
    ) {
      throw new Error(`difference.${field} must be zero`);
    }
    if (
      !Number.isSafeInteger(report.d1[field]) ||
      !Number.isSafeInteger(report.observer[field])
    ) {
      throw new Error(`${field} must be a safe integer in both projections`);
    }
  }
  assertObject(report.observer_diagnostics, "observer diagnostics");
  const diagnostics = report.observer_diagnostics;
  if (diagnostics.conflict_count !== 0)
    throw new Error("observer conflict_count must be zero");
  if (diagnostics.legacy_terminal_reservations !== 0) {
    throw new Error("observer legacy_terminal_reservations must be zero");
  }
  if (
    !Number.isSafeInteger(diagnostics.persisted_state_json_bytes) ||
    !Number.isSafeInteger(diagnostics.persisted_state_json_limit_bytes) ||
    diagnostics.persisted_state_json_bytes >
      diagnostics.persisted_state_json_limit_bytes
  ) {
    throw new Error(
      "observer persisted state must remain within its JSON limit",
    );
  }
  return {
    tokenScopeHash: report.token_scope_hash,
    summary: {
      reserveCount: report.d1.reserve_count,
      activeReservations: report.d1.active_reservations,
      terminalReservations: report.d1.terminal_reservations,
      reservedQuota: report.d1.reserved_quota,
      finalQuota: report.d1.final_quota,
      refundedQuota: report.d1.refunded_quota,
      requestCount: report.d1.request_count,
    },
    diagnostics: {
      observationCount: diagnostics.observation_count,
      replayCount: diagnostics.replay_count,
      conflictCount: diagnostics.conflict_count,
      retainedTerminalReservations: diagnostics.retained_terminal_reservations,
      compactedTerminalReservations:
        diagnostics.compacted_terminal_reservations,
      persistedStateJsonBytes: diagnostics.persisted_state_json_bytes,
      persistedStateJsonLimitBytes:
        diagnostics.persisted_state_json_limit_bytes,
    },
  };
}

async function runSelfTest() {
  const checks = [
    runCheck("dry-run-redacts-cookie-and-token-id", () => {
      const plan = buildPlan({
        baseUrl: defaultUrl,
        cookie: "session=self-test-secret",
        tokenId: "987654321",
        timeoutMs: defaultTimeoutMs,
        dryRun: true,
      });
      const encoded = JSON.stringify(plan);
      if (
        encoded.includes("self-test-secret") ||
        encoded.includes("987654321")
      ) {
        throw new Error("dry-run leaked cookie or raw token identity");
      }
    }),
    runCheck("requires-explicit-live-confirmation", () => {
      expectFailure(
        () =>
          normalizeOptions(
            argsFixture({ cookie: "session=x", "token-id": "1" }),
            false,
          ),
        "--confirm-live",
      );
    }),
    runCheck("rejects-non-matching-evidence", () => {
      const report = validReport();
      report.difference.reserved_quota = 1;
      expectFailure(() => validateReport(report), "difference.reserved_quota");
    }),
    runCheck("rejects-unhealthy-observer", () => {
      const report = validReport();
      report.observer_diagnostics.conflict_count = 1;
      expectFailure(() => validateReport(report), "conflict_count");
    }),
  ];
  checks.push(
    await runAsyncCheck(
      "live-client-validates-redacted-mock-evidence",
      liveClientMockCheck,
    ),
  );
  const failed = checks.filter((check) => check.status !== "PASS");
  return {
    tool: "smoke_quota_coordinator_reconciliation",
    mode: "self-test",
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
  };
}

async function liveClientMockCheck() {
  const cookie = "session=self-test-live-secret";
  const tokenId = "4242";
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({
        method: request.method,
        path: url.pathname,
        cookie: request.headers.get("cookie"),
        body,
      });
      if (request.headers.get("cookie") !== cookie) {
        return Response.json({ success: false }, { status: 401 });
      }
      if (url.pathname === capabilitiesPath) {
        return Response.json({
          success: true,
          data: {
            quota_coordinator_reconciliation_compiled: true,
            quota_coordinator_reconciliation_runtime_ready: true,
            quota_coordinator_shadow_runtime_ready: true,
            quota_coordinator_write_authority_enabled: false,
          },
        });
      }
      if (
        url.pathname === reconciliationPath &&
        request.method === "POST" &&
        body?.token_id === tokenId &&
        Object.keys(body).length === 1
      ) {
        return Response.json(
          { success: true, data: validReport() },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      return Response.json({ success: false }, { status: 404 });
    },
  });
  try {
    const result = await runLive({
      baseUrl: `http://127.0.0.1:${server.port}`,
      cookie,
      tokenId,
      timeoutMs: defaultTimeoutMs,
      dryRun: false,
    });
    if (
      calls.length !== 2 ||
      calls.some((call) => call.cookie !== cookie) ||
      calls[0].method !== "GET" ||
      calls[1].method !== "POST" ||
      calls[1].path !== reconciliationPath ||
      calls[1].body?.token_id !== tokenId
    ) {
      throw new Error(
        "live client did not issue the exact authenticated request sequence",
      );
    }
    const encoded = JSON.stringify(result);
    if (encoded.includes(cookie) || encoded.includes(tokenId)) {
      throw new Error("live output leaked cookie or raw token identity");
    }
  } finally {
    server.stop(true);
  }
}

function validReport() {
  const projection = Object.fromEntries(
    differenceFields.map((field) => [field, 0]),
  );
  projection.reserve_count = 1;
  projection.active_reservations = 1;
  projection.outstanding_quota = 100;
  projection.reserved_quota = 100;
  projection.user_net_delta = -100;
  projection.token_net_delta = -100;
  return {
    contract_version: 1,
    status: "matched",
    token_scope_hash: "a".repeat(64),
    source_stable: true,
    observer_healthy: true,
    d1: { ...projection, max_updated_at: 1, owner_generation_sum: 1 },
    observer: { ...projection },
    difference: Object.fromEntries(differenceFields.map((field) => [field, 0])),
    observer_diagnostics: {
      contract_version: 1,
      observation_count: 1,
      applied_count: 1,
      replay_count: 0,
      conflict_count: 0,
      retained_terminal_reservations: 0,
      compacted_terminal_reservations: 0,
      legacy_terminal_reservations: 0,
      retention_watermark_committed_at: 0,
      persisted_state_json_bytes: 512,
      persisted_state_json_limit_bytes: 1_500_000,
    },
  };
}

async function requestEnvelope(
  url,
  init,
  timeoutMs,
  label,
  requireNoStore = false,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body?.success === false) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
  if (
    requireNoStore &&
    !cacheControlHasNoStore(response.headers.get("cache-control"))
  ) {
    throw new Error(`${label} must return Cache-Control: no-store`);
  }
  assertObject(body?.data, `${label} data`);
  return body.data;
}

function cacheControlHasNoStore(value) {
  return String(value || "")
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store");
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid HTTP(S) origin");
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "url must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

function optionalHeaderValue(value, name) {
  if (value == null || String(value).trim() === "") return "";
  const normalized = String(value).trim();
  if (/\r|\n/.test(normalized))
    throw new Error(`${name} must not contain CR/LF`);
  return normalized;
}

function argsFixture(values = {}, flags = []) {
  return {
    values: new Map(Object.entries({ url: defaultUrl, ...values })),
    flags: new Set(flags),
  };
}

function assertObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function runCheck(name, fn) {
  try {
    fn();
    return { name, status: "PASS" };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAsyncCheck(name, fn) {
  try {
    await fn();
    return { name, status: "PASS" };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function expectFailure(fn, expected) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) throw error;
    return;
  }
  throw new Error(`expected failure containing ${expected}`);
}

function printResult(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(
    `QuotaCoordinator reconciliation ${result.mode}: ${result.status}`,
  );
  if (result.mode === "self-test") {
    for (const check of result.checks)
      console.log(`- ${check.name}: ${check.status}`);
  }
}

function usage(exitCode) {
  console.error(
    [
      "Usage: bun tools/smoke_quota_coordinator_reconciliation.mjs --self-test [--json]",
      "       bun tools/smoke_quota_coordinator_reconciliation.mjs --dry-run --token-id <id> [--url <origin>] [--json]",
      "       bun tools/smoke_quota_coordinator_reconciliation.mjs --confirm-live --token-id <id> --cookie <admin-cookie> [--url <origin>] [--json]",
    ].join("\n"),
  );
  process.exit(exitCode);
}
