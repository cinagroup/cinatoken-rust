#!/usr/bin/env bun

const defaultUrl = "http://127.0.0.1:8787";
const defaultTimeoutMs = 15_000;
const capabilitiesPath = "/api/platform/capabilities";
const smokePath = "/api/platform/relay/actual-group-billing/smoke";
const scenarioNames = [
  "actual-group-refund",
  "fallback-plan-replacement",
  "retry-exhaustion-refund",
];
const requiredCapabilities = [
  "relay_ai_gateway_actual_group_billing_staging_smoke_compiled",
  "relay_ai_gateway_actual_group_billing_staging_smoke_enabled",
  "relay_ai_gateway_actual_group_billing_staging_smoke_ready",
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
  const valueNames = new Set(["url", "scenario", "cookie", "timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) usage(2, `Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (flagNames.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueNames.has(name)) usage(2, `Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(2, `${arg} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const modeCount = ["self-test", "dry-run"].filter((name) =>
    flags.has(name),
  ).length;
  if (modeCount > 1) usage(2, "Choose only one of --self-test or --dry-run");
  return { values, flags };
}

function normalizeOptions(args, dryRun) {
  const value = (name, envName) =>
    args.values.get(name) ?? process.env[envName];
  const timeoutMs = Number(
    value("timeout-ms", "RELAY_ACTUAL_GROUP_BILLING_SMOKE_TIMEOUT_MS") ||
      defaultTimeoutMs,
  );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  ) {
    throw new Error("timeout-ms must be an integer between 1 and 120000");
  }
  const selectedScenario =
    value("scenario", "RELAY_ACTUAL_GROUP_BILLING_SMOKE_SCENARIO") || "all";
  const scenarios = selectScenarios(selectedScenario);
  const cookie = optionalHeaderValue(
    value("cookie", "RELAY_ACTUAL_GROUP_BILLING_SMOKE_COOKIE"),
    "cookie",
  );
  if (!dryRun && !args.flags.has("confirm-live")) {
    throw new Error("live actual-group billing smoke requires --confirm-live");
  }
  if (!dryRun && !cookie) {
    throw new Error(
      "live actual-group billing smoke requires --cookie or RELAY_ACTUAL_GROUP_BILLING_SMOKE_COOKIE",
    );
  }
  return {
    baseUrl: normalizeBaseUrl(
      value("url", "RELAY_ACTUAL_GROUP_BILLING_SMOKE_URL") || defaultUrl,
    ),
    scenario: selectedScenario,
    scenarios,
    cookie,
    timeoutMs,
    dryRun,
  };
}

function selectScenarios(value) {
  const normalized = String(value).trim();
  if (normalized === "all") return [...scenarioNames];
  if (!scenarioNames.includes(normalized)) {
    throw new Error(`unknown scenario: ${normalized}`);
  }
  return [normalized];
}

function buildPlan(options) {
  const capabilitiesUrl = buildUrl(options.baseUrl, capabilitiesPath);
  const endpointUrl = buildUrl(options.baseUrl, smokePath);
  return {
    tool: "smoke_relay_actual_group_billing",
    mode: "dry-run",
    status: "PASS",
    dryRun: true,
    capabilitiesUrl,
    endpoint: endpointUrl,
    scenario: options.scenario,
    adminCookieConfigured: Boolean(options.cookie),
    requiredCapabilities: Object.fromEntries(
      requiredCapabilities.map((name) => [name, true]),
    ),
    requests: options.scenarios.map((scenario) => ({
      scenario,
      method: "POST",
      url: endpointUrl,
      body: { scenario, confirm_live: true, cleanup: true },
      expected: expectedEvidence(scenario),
    })),
    safety: {
      confirmLiveRequired: true,
      adminCookieRequired: true,
      cleanupRequired: true,
      productionAllowed: false,
      acceptsApiToken: false,
      secretOutput: "Cookie values are never printed.",
    },
    requiredBeforeRun: [
      "Use an isolated staging Worker and staging D1 database; the route rejects production.",
      "Enable RELAY_ACTUAL_GROUP_BILLING_STAGING_SMOKE_ENABLED only for the smoke window.",
      "Require all three actual-group billing staging-smoke capabilities to be true.",
      "Archive the capabilities response, each PASS report, cleanup proof, git SHA, and rollback timestamp.",
      "Disable the staging-smoke gate after evidence capture; this smoke does not enable model fallback cutover.",
    ],
  };
}

async function runLive(options) {
  const plan = buildPlan(options);
  const capabilities = await fetchCapabilities(plan.capabilitiesUrl, options);
  const results = [];
  for (const scenario of options.scenarios) {
    const response = await fetchWithTimeout(
      plan.endpoint,
      {
        method: "POST",
        headers: requestHeaders(options.cookie),
        body: JSON.stringify({ scenario, confirm_live: true, cleanup: true }),
        redirect: "error",
      },
      options.timeoutMs,
    );
    const report = await readEnvelope(
      response,
      `actual-group billing scenario ${scenario}`,
    );
    const validatedReport = validateReport(report, scenario);
    results.push({
      scenario,
      httpStatus: response.status,
      status: "PASS",
      report: validatedReport,
    });
  }
  return {
    tool: "smoke_relay_actual_group_billing",
    mode: "live",
    status: "PASS",
    dryRun: false,
    capabilitiesUrl: plan.capabilitiesUrl,
    endpoint: plan.endpoint,
    scenario: options.scenario,
    adminCookieConfigured: true,
    capabilities,
    results,
    summary: { scenarios: results.length, passed: results.length, failed: 0 },
  };
}

async function fetchCapabilities(url, options) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: requestHeaders(options.cookie, false),
      redirect: "error",
    },
    options.timeoutMs,
  );
  const capabilities = await readEnvelope(response, "platform capabilities");
  validateCapabilities(capabilities);
  return Object.fromEntries(
    requiredCapabilities.map((name) => [name, capabilities[name]]),
  );
}

function validateCapabilities(capabilities) {
  assertObject(capabilities, "capabilities");
  for (const name of requiredCapabilities) {
    if (capabilities[name] !== true) {
      throw new Error(`platform capability ${name} must be true`);
    }
  }
}

function validateReport(report, expectedScenario) {
  assertObject(report, "smoke report");
  if (report.scenario !== expectedScenario) {
    throw new Error(
      `smoke report scenario mismatch: expected ${expectedScenario}`,
    );
  }
  if (report.status !== "PASS")
    throw new Error(`${expectedScenario} did not report PASS`);
  if (report.bindingPath !== "worker_binding") {
    throw new Error(
      `${expectedScenario} did not prove the Worker binding path`,
    );
  }
  if (
    report.confirmation !==
    "relay tiered group plan plus D1 reserve/settle/refund"
  ) {
    throw new Error(
      `${expectedScenario} did not report the expected plan confirmation`,
    );
  }
  if (report.cleanupRequested !== true || report.cleanupPerformed !== true) {
    throw new Error(`${expectedScenario} did not perform mandatory cleanup`);
  }
  if (report.cleanupVerified !== true) {
    throw new Error(`${expectedScenario} cleanupVerified must be true`);
  }
  assertSnapshot(report.setupSnapshot, `${expectedScenario} setupSnapshot`);
  assertSnapshot(report.finalSnapshot, `${expectedScenario} finalSnapshot`);
  assertSnapshot(
    report.expectedSnapshot,
    `${expectedScenario} expectedSnapshot`,
  );
  if (!deepEqual(report.finalSnapshot, report.expectedSnapshot)) {
    throw new Error(
      `${expectedScenario} finalSnapshot does not match expectedSnapshot`,
    );
  }
  validateInitialSnapshot(
    report.setupSnapshot,
    `${expectedScenario} setupSnapshot`,
  );

  if (expectedScenario === "actual-group-refund") {
    validateSettledPlan(
      report.primaryPlan,
      `${expectedScenario} primaryPlan`,
      "ct_smoke_primary_low",
      350,
    );
    if (report.fallbackPlan != null)
      throw new Error(`${expectedScenario} must not include fallbackPlan`);
    validateSettledSnapshot(
      report.setupSnapshot,
      report.finalSnapshot,
      350,
      expectedScenario,
    );
    return summarizeReport(report);
  }
  if (expectedScenario === "fallback-plan-replacement") {
    validateRefundedPlan(report.primaryPlan, `${expectedScenario} primaryPlan`);
    validateSettledPlan(
      report.fallbackPlan,
      `${expectedScenario} fallbackPlan`,
      "ct_smoke_fallback_low",
      450,
    );
    if (
      report.primaryPlan.reservedQuota === report.fallbackPlan.reservedQuota
    ) {
      throw new Error(
        `${expectedScenario} did not prove a distinct fallback billing plan`,
      );
    }
    validateSettledSnapshot(
      report.setupSnapshot,
      report.finalSnapshot,
      450,
      expectedScenario,
    );
    return summarizeReport(report);
  }
  validateRefundedPlan(report.primaryPlan, `${expectedScenario} primaryPlan`);
  if (report.fallbackPlan != null)
    throw new Error(`${expectedScenario} must not include fallbackPlan`);
  if (!deepEqual(report.setupSnapshot, report.finalSnapshot)) {
    throw new Error(
      `${expectedScenario} did not restore the setup quota snapshot`,
    );
  }
  return summarizeReport(report);
}

function validatePlanBase(plan, label) {
  assertObject(plan, label);
  if (plan.candidateGroupCount !== 2)
    throw new Error(`${label} candidateGroupCount must be 2`);
  if (plan.reservationStrategy !== "max_candidate_group") {
    throw new Error(`${label} reservationStrategy must be max_candidate_group`);
  }
  for (const field of [
    "reservedQuota",
    "finalQuota",
    "refundQuota",
    "additionalQuota",
  ]) {
    if (!Number.isSafeInteger(plan[field]) || plan[field] < 0) {
      throw new Error(`${label} ${field} must be a non-negative safe integer`);
    }
  }
  if (plan.reservedQuota <= 0)
    throw new Error(`${label} reservedQuota must be positive`);
  if (plan.additionalQuota !== 0)
    throw new Error(`${label} additionalQuota must be zero`);
}

function validateSettledPlan(plan, label, expectedGroup, expectedFinalQuota) {
  validatePlanBase(plan, label);
  if (plan.selectedGroup !== expectedGroup) {
    throw new Error(`${label} selectedGroup must be ${expectedGroup}`);
  }
  if (plan.selectedGroupRatio !== 1) {
    throw new Error(`${label} selectedGroupRatio must be 1`);
  }
  if (!Number.isSafeInteger(plan.selectedGroupEstimatedQuota)) {
    throw new Error(
      `${label} selectedGroupEstimatedQuota must be a safe integer`,
    );
  }
  if (!(plan.reservedQuota > plan.selectedGroupEstimatedQuota)) {
    throw new Error(
      `${label} must reserve more than the selected-group estimate`,
    );
  }
  if (plan.finalQuota !== expectedFinalQuota) {
    throw new Error(`${label} finalQuota must be ${expectedFinalQuota}`);
  }
  if (plan.refundQuota !== plan.reservedQuota - plan.finalQuota) {
    throw new Error(
      `${label} refundQuota does not reconcile with reservedQuota and finalQuota`,
    );
  }
}

function validateRefundedPlan(plan, label) {
  validatePlanBase(plan, label);
  if (plan.selectedGroup != null || plan.selectedGroupRatio != null) {
    throw new Error(`${label} must not select a serving group`);
  }
  if (plan.selectedGroupEstimatedQuota != null) {
    throw new Error(`${label} must not include selectedGroupEstimatedQuota`);
  }
  if (plan.finalQuota !== 0 || plan.refundQuota !== plan.reservedQuota) {
    throw new Error(`${label} must refund the entire reservation`);
  }
}

function assertSnapshot(snapshot, label) {
  assertObject(snapshot, label);
  for (const field of [
    "userQuota",
    "userUsedQuota",
    "userRequestCount",
    "tokenRemainQuota",
    "tokenUsedQuota",
    "tokenAccessedTime",
    "channelUsedQuota",
  ]) {
    if (!Number.isSafeInteger(snapshot[field]) || snapshot[field] < 0) {
      throw new Error(`${label} ${field} must be a non-negative safe integer`);
    }
  }
}

function validateInitialSnapshot(snapshot, label) {
  if (!deepEqual(snapshot, snapshotFixture(1_000_000, 0, 0))) {
    throw new Error(`${label} is not the fixed initial fixture`);
  }
}

function validateSettledSnapshot(setup, final, finalQuota, scenario) {
  if (!(final.tokenAccessedTime > 0)) {
    throw new Error(`${scenario} tokenAccessedTime must prove settlement`);
  }
  const expectedSetup = snapshotFixture(1_000_000, 0, 0);
  const expectedFinal = snapshotFixture(
    1_000_000 - finalQuota,
    finalQuota,
    final.tokenAccessedTime,
  );
  if (!deepEqual(setup, expectedSetup) || !deepEqual(final, expectedFinal)) {
    throw new Error(
      `${scenario} snapshot quota deltas do not match finalQuota`,
    );
  }
}

function summarizeReport(report) {
  return {
    scenario: report.scenario,
    status: report.status,
    bindingPath: report.bindingPath,
    confirmation: report.confirmation,
    cleanupRequested: report.cleanupRequested,
    cleanupPerformed: report.cleanupPerformed,
    cleanupVerified: report.cleanupVerified,
    primaryPlan: report.primaryPlan,
    fallbackPlan: report.fallbackPlan,
    setupSnapshot: report.setupSnapshot,
    finalSnapshot: report.finalSnapshot,
    expectedSnapshot: report.expectedSnapshot,
  };
}

function expectedEvidence(scenario) {
  const common = {
    status: "PASS",
    bindingPath: "worker_binding",
    cleanupRequested: true,
    cleanupPerformed: true,
    cleanupVerified: true,
    finalSnapshotEqualsExpectedSnapshot: true,
  };
  if (scenario === "actual-group-refund") {
    return {
      ...common,
      primaryPlan: "settled selected group with exact excess refund",
      fallbackPlan: null,
    };
  }
  if (scenario === "fallback-plan-replacement") {
    return {
      ...common,
      primaryPlan: "fully refunded",
      fallbackPlan:
        "distinct plan settled selected group with exact excess refund",
    };
  }
  return {
    ...common,
    primaryPlan: "fully refunded after retry exhaustion",
    fallbackPlan: null,
    finalSnapshotEqualsSetupSnapshot: true,
  };
}

async function runSelfTest() {
  const checks = [
    runCheck("dry-run-redacts-cookie", () => {
      const plan = buildPlan({
        baseUrl: defaultUrl,
        scenario: "all",
        scenarios: [...scenarioNames],
        cookie: "session=self-test-secret",
        timeoutMs: defaultTimeoutMs,
        dryRun: true,
      });
      if (JSON.stringify(plan).includes("self-test-secret"))
        throw new Error("dry-run leaked cookie");
      if (plan.requests.length !== 3)
        throw new Error("dry-run did not include all scenarios");
    }),
    runCheck("capabilities-require-all-three-gates", () => {
      validateCapabilities(
        Object.fromEntries(requiredCapabilities.map((name) => [name, true])),
      );
      expectFailure(
        () =>
          validateCapabilities({
            ...Object.fromEntries(
              requiredCapabilities.map((name) => [name, true]),
            ),
            [requiredCapabilities[2]]: false,
          }),
        requiredCapabilities[2],
      );
    }),
    runCheck("live-mode-requires-confirmation", () => {
      expectFailure(
        () =>
          normalizeOptions(
            {
              values: new Map([
                ["url", defaultUrl],
                ["scenario", "all"],
                ["cookie", "session=self-test-secret"],
                ["timeout-ms", String(defaultTimeoutMs)],
              ]),
              flags: new Set(),
            },
            false,
          ),
        "--confirm-live",
      );
    }),
    runCheck("live-mode-requires-admin-cookie", () => {
      expectFailure(
        () =>
          normalizeOptions(
            {
              values: new Map([
                ["url", defaultUrl],
                ["scenario", "all"],
                ["cookie", ""],
                ["timeout-ms", String(defaultTimeoutMs)],
              ]),
              flags: new Set(["confirm-live"]),
            },
            false,
          ),
        "requires --cookie",
      );
    }),
    ...scenarioNames.map((scenario) =>
      runCheck(`accepts-${scenario}-evidence`, () =>
        validateReport(validReport(scenario), scenario),
      ),
    ),
    runCheck("rejects-non-pass", () => {
      const report = validReport("actual-group-refund");
      report.status = "FAIL";
      expectFailure(
        () => validateReport(report, "actual-group-refund"),
        "PASS",
      );
    }),
    runCheck("rejects-unverified-cleanup", () => {
      const report = validReport("retry-exhaustion-refund");
      report.cleanupVerified = false;
      expectFailure(
        () => validateReport(report, "retry-exhaustion-refund"),
        "cleanupVerified",
      );
    }),
    runCheck("rejects-bad-plan-reconciliation", () => {
      const report = validReport("fallback-plan-replacement");
      report.fallbackPlan.refundQuota += 1;
      expectFailure(
        () => validateReport(report, "fallback-plan-replacement"),
        "refundQuota",
      );
    }),
  ];
  checks.push(
    await runAsyncCheck(
      "live-client-validates-mock-worker",
      liveClientMockCheck,
    ),
  );
  const failed = checks.filter((check) => check.status !== "PASS");
  return {
    tool: "smoke_relay_actual_group_billing",
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
  const secret = "session=self-test-live-secret";
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        cookieMatches: request.headers.get("cookie") === secret,
      });
      if (request.headers.get("cookie") !== secret) {
        return Response.json(
          { success: false, message: "missing admin cookie" },
          { status: 401 },
        );
      }
      if (url.pathname === capabilitiesPath && request.method === "GET") {
        return Response.json({
          success: true,
          data: Object.fromEntries(
            requiredCapabilities.map((name) => [name, true]),
          ),
        });
      }
      if (url.pathname === smokePath && request.method === "POST") {
        const body = await request.json();
        if (body?.confirm_live !== true || body?.cleanup !== true) {
          return Response.json(
            { success: false, message: "invalid smoke request" },
            { status: 400 },
          );
        }
        return Response.json({
          success: true,
          data: validReport(body.scenario),
        });
      }
      return Response.json(
        { success: false, message: "not found" },
        { status: 404 },
      );
    },
  });
  try {
    const result = await runLive({
      baseUrl: `http://127.0.0.1:${server.port}`,
      scenario: "all",
      scenarios: [...scenarioNames],
      cookie: secret,
      timeoutMs: defaultTimeoutMs,
      dryRun: false,
    });
    if (
      result.status !== "PASS" ||
      result.results.length !== scenarioNames.length
    ) {
      throw new Error("mock live client did not validate all scenarios");
    }
    if (
      calls.length !== scenarioNames.length + 1 ||
      calls.some((call) => !call.cookieMatches)
    ) {
      throw new Error(
        "mock live client did not send the admin cookie on every request",
      );
    }
    if (JSON.stringify(result).includes(secret)) {
      throw new Error("mock live result leaked the admin cookie");
    }
  } finally {
    server.stop(true);
  }
}

function validReport(scenario) {
  const setupSnapshot = snapshot(1_000_000, 0);
  const primarySettled = settledPlan(7_000, 3_500, 350, "ct_smoke_primary_low");
  const primaryRefunded = refundedPlan(7_000);
  const fallbackSettled = settledPlan(
    8_750,
    4_500,
    450,
    "ct_smoke_fallback_low",
  );
  const finalQuota =
    scenario === "actual-group-refund"
      ? 350
      : scenario === "fallback-plan-replacement"
        ? 450
        : 0;
  const finalSnapshot = snapshot(1_000_000 - finalQuota, finalQuota);
  return {
    scenario,
    status: "PASS",
    bindingPath: "worker_binding",
    confirmation: "relay tiered group plan plus D1 reserve/settle/refund",
    cleanupRequested: true,
    cleanupPerformed: true,
    cleanupVerified: true,
    primaryPlan:
      scenario === "actual-group-refund" ? primarySettled : primaryRefunded,
    fallbackPlan:
      scenario === "fallback-plan-replacement" ? fallbackSettled : null,
    setupSnapshot,
    finalSnapshot,
    expectedSnapshot: structuredClone(finalSnapshot),
  };
}

function settledPlan(
  reservedQuota,
  selectedGroupEstimatedQuota,
  finalQuota,
  selectedGroup,
) {
  return {
    candidateGroupCount: 2,
    reservationStrategy: "max_candidate_group",
    reservedQuota,
    selectedGroup,
    selectedGroupRatio: 1,
    selectedGroupEstimatedQuota,
    finalQuota,
    refundQuota: reservedQuota - finalQuota,
    additionalQuota: 0,
  };
}

function refundedPlan(reservedQuota) {
  return {
    candidateGroupCount: 2,
    reservationStrategy: "max_candidate_group",
    reservedQuota,
    selectedGroup: null,
    selectedGroupRatio: null,
    selectedGroupEstimatedQuota: null,
    finalQuota: 0,
    refundQuota: reservedQuota,
    additionalQuota: 0,
  };
}

function snapshot(remaining, used) {
  return snapshotFixture(remaining, used, used > 0 ? 1_800_100_000 : 0);
}

function snapshotFixture(remaining, used, accessedTime) {
  return {
    userQuota: remaining,
    userUsedQuota: used,
    userRequestCount: used > 0 ? 1 : 0,
    tokenRemainQuota: remaining,
    tokenUsedQuota: used,
    tokenAccessedTime: accessedTime,
    channelUsedQuota: used,
  };
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

async function readEnvelope(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body?.success === false) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
  const data = body?.data ?? body;
  assertObject(data, `${label} data`);
  return data;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requestHeaders(cookie, json = true) {
  const headers = { accept: "application/json", cookie };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

function optionalHeaderValue(value, name) {
  if (value == null || String(value).trim() === "") return "";
  const normalized = String(value).trim();
  if (/\r|\n/.test(normalized))
    throw new Error(`${name} must not contain CR/LF`);
  return normalized;
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
    url.password
  ) {
    throw new Error("url must be an HTTP(S) origin without credentials");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function buildUrl(base, path) {
  return new URL(path, `${base}/`).toString();
}

function assertObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usage(exitCode, message = "") {
  if (message) console.error(message);
  console.error(
    [
      "Usage: bun tools/smoke_relay_actual_group_billing.mjs --self-test [--json]",
      "       bun tools/smoke_relay_actual_group_billing.mjs --dry-run [--url <worker-origin>] [--scenario <name|all>] [--json]",
      "       bun tools/smoke_relay_actual_group_billing.mjs --url <worker-origin> --cookie <admin-cookie> --confirm-live [--scenario <name|all>] [--json]",
      "",
      "Scenarios: actual-group-refund, fallback-plan-replacement, retry-exhaustion-refund, all",
      "",
      "Options:",
      "  --url <origin>       or RELAY_ACTUAL_GROUP_BILLING_SMOKE_URL",
      "  --scenario <name>    or RELAY_ACTUAL_GROUP_BILLING_SMOKE_SCENARIO, default all",
      "  --cookie <cookie>    or RELAY_ACTUAL_GROUP_BILLING_SMOKE_COOKIE, never printed",
      "  --timeout-ms <ms>    or RELAY_ACTUAL_GROUP_BILLING_SMOKE_TIMEOUT_MS, default 15000",
      "  --confirm-live       required for network and D1 mutation",
      "  --dry-run            print a redacted request/evidence plan without network",
      "  --self-test          validate capability, cleanup, evidence, and redaction checks",
      "  --json",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "self-test") {
    console.log(`Actual-group billing smoke self-test: ${result.status}`);
    for (const check of result.checks)
      console.log(`- ${check.name}: ${check.status}`);
    return;
  }
  if (result.mode === "dry-run") {
    console.log("Actual-group billing Worker-binding smoke plan (dry-run)");
    console.log(`endpoint: ${result.endpoint}`);
    console.log(`scenario: ${result.scenario}`);
    console.log(`admin_cookie_configured: ${result.adminCookieConfigured}`);
    for (const request of result.requests)
      console.log(`- ${request.scenario}: POST ${request.url}`);
    return;
  }
  console.log(`Actual-group billing Worker-binding smoke: ${result.status}`);
  console.log(`endpoint: ${result.endpoint}`);
  console.log(`scenario: ${result.scenario}`);
  console.log("admin_cookie_configured: true");
  for (const item of result.results) {
    console.log(`- ${item.scenario}: ${item.status} (http ${item.httpStatus})`);
  }
}
