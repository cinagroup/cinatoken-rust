#!/usr/bin/env bun

const defaultUrl = "http://127.0.0.1:8787";
const defaultTimeoutMs = 15_000;
const incidentLimit = 50;
const incidentsPath = "/api/platform/relay/billing-finalization/incidents";
const replayPathPrefix = "/api/platform/relay/billing-finalization/incidents";

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
  const valueNames = new Set(["url", "cookie", "timeout-ms", "incident-id"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (flagNames.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueNames.has(name)) throw new Error(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }

  if (flags.has("self-test") && flags.has("dry-run")) {
    throw new Error("choose only one of --self-test or --dry-run");
  }
  if (
    flags.has("confirm-live") &&
    (flags.has("self-test") || flags.has("dry-run"))
  ) {
    throw new Error("--confirm-live is only valid in live mode");
  }
  if (flags.has("self-test") && values.size > 0) {
    throw new Error("--self-test does not accept network options");
  }
  return { values, flags };
}

function normalizeOptions(args, dryRun) {
  const value = (name, envName) =>
    args.values.get(name) ?? process.env[envName];
  const timeoutMs = Number(
    value("timeout-ms", "BILLING_FINALIZATION_RECONCILE_SMOKE_TIMEOUT_MS") ||
      defaultTimeoutMs,
  );
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  ) {
    throw new Error("timeout-ms must be an integer between 1 and 120000");
  }
  const cookie = optionalHeaderValue(
    value("cookie", "BILLING_FINALIZATION_RECONCILE_SMOKE_COOKIE"),
    "cookie",
  );
  const incidentId = optionalHeaderValue(
    value("incident-id", "BILLING_FINALIZATION_RECONCILE_INCIDENT_ID"),
    "incident-id",
  );
  if (!dryRun && !args.flags.has("confirm-live")) {
    throw new Error(
      "live billing-finalization reconcile smoke requires --confirm-live",
    );
  }
  if (!dryRun && !cookie) {
    throw new Error(
      "live billing-finalization reconcile smoke requires --cookie or BILLING_FINALIZATION_RECONCILE_SMOKE_COOKIE",
    );
  }
  if (!dryRun && !incidentId) {
    throw new Error(
      "live billing-finalization reconcile smoke requires --incident-id or BILLING_FINALIZATION_RECONCILE_INCIDENT_ID",
    );
  }
  if (incidentId && !/^[0-9a-f]{64}$/.test(incidentId)) {
    throw new Error("incident-id must be a 64-character lowercase hex digest");
  }
  return {
    baseUrl: normalizeBaseUrl(
      value("url", "BILLING_FINALIZATION_RECONCILE_SMOKE_URL") || defaultUrl,
    ),
    cookie,
    incidentId,
    timeoutMs,
    dryRun,
  };
}

function buildPlan(options) {
  const listUrl = buildIncidentListUrl(options.baseUrl);
  const incidentId = options.incidentId || ":incident_id";
  return {
    tool: "smoke_billing_finalization_reconcile",
    mode: "dry-run",
    status: "PASS",
    dryRun: true,
    adminCookieConfigured: Boolean(options.cookie),
    selection: { status: "open", limit: incidentLimit, incidentId },
    requests: [
      {
        method: "GET",
        url: listUrl,
      },
      {
        method: "POST",
        url: `${options.baseUrl}${replayPathPrefix}/${incidentId}/replay`,
        body: { confirm_replay: true },
        expectedStatus: 202,
      },
    ],
    safety: {
      confirmLiveRequired: true,
      verifiedRootSessionRequired: true,
      maximumIncidentsPerRun: 1,
      acceptsEventPayload: false,
      acceptsPricingParameters: false,
      secretOutput: "Cookie values are never printed.",
    },
  };
}

async function runLive(options) {
  const listUrl = buildIncidentListUrl(options.baseUrl);
  const listResponse = await fetchWithTimeout(
    listUrl,
    {
      method: "GET",
      headers: requestHeaders(options.cookie, false),
      redirect: "error",
    },
    options.timeoutMs,
  );
  const listData = await readJsonResponse(
    listResponse,
    "billing-finalization incident list",
  );
  const incident = selectOpenIncident(listData, options.incidentId);
  const replayUrl = buildReplayUrl(options.baseUrl, incident.incidentId);
  const response = await fetchWithTimeout(
    replayUrl,
    {
      method: "POST",
      headers: requestHeaders(options.cookie, true),
      body: JSON.stringify({ confirm_replay: true }),
      redirect: "error",
    },
    options.timeoutMs,
  );
  const replayData = await readJsonResponse(
    response,
    `billing-finalization replay for ${incident.incidentId}`,
  );
  const replay = validateReplayResponse(
    replayData,
    incident.incidentId,
    response.status,
  );

  return {
    tool: "smoke_billing_finalization_reconcile",
    mode: "live",
    status: "PASS",
    dryRun: false,
    adminCookieConfigured: true,
    query: {
      status: "open",
      limit: incidentLimit,
      incidentId: incident.incidentId,
    },
    summary: {
      replayRequests: 1,
      accepted: 1,
    },
    replay: {
      incidentId: incident.incidentId,
      httpStatus: response.status,
      replayAccepted: true,
      status: replay.status,
      replayGeneration: replay.replayGeneration,
    },
  };
}

function selectOpenIncident(data, expectedIncidentId) {
  assertObject(data, "incident list data");
  if (data.contract_version !== 1) {
    throw new Error("incident list contract_version must be 1");
  }
  if (!Array.isArray(data.records)) {
    throw new Error("incident list data must contain records[]");
  }
  const rows = data.records;
  if (data.count !== rows.length) {
    throw new Error("incident list count does not match records length");
  }
  if (rows.length > incidentLimit) {
    throw new Error(
      `incident list exceeded the requested limit of ${incidentLimit}`,
    );
  }

  const seen = new Set();
  const incidents = rows.map((row, index) => {
    assertObject(row, `incident list item ${index}`);
    const incidentId = validateIncidentId(row.incident_id, index);
    if (row.status !== "open") {
      throw new Error(`incident ${incidentId} did not report status=open`);
    }
    if (row.classification !== "replayable" || row.replayable !== true) {
      throw new Error(`incident ${incidentId} did not report replayable=true`);
    }
    if (seen.has(incidentId)) {
      throw new Error(
        `incident list returned duplicate incident_id ${incidentId}`,
      );
    }
    seen.add(incidentId);
    return { incidentId };
  });
  const incident = incidents.find(
    (candidate) => candidate.incidentId === expectedIncidentId,
  );
  if (!incident) {
    throw new Error(
      "requested incident_id was not returned as open and replayable",
    );
  }
  return incident;
}

function validateIncidentId(value, index) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `incident list item ${index} must contain a valid incident_id`,
    );
  }
  return value;
}

function validateReplayResponse(data, expectedIncidentId, httpStatus) {
  assertObject(data, "incident replay data");
  if (httpStatus !== 202) {
    throw new Error("incident replay HTTP status must be 202");
  }
  if (data.contract_version !== 1) {
    throw new Error("incident replay contract_version must be 1");
  }
  if (data.incident_id !== expectedIncidentId) {
    throw new Error(
      "incident replay response incident_id did not match the request",
    );
  }
  if (data.status !== "queued") {
    throw new Error("incident replay response status must be queued");
  }
  if (
    !Number.isSafeInteger(data.replay_generation) ||
    data.replay_generation < 1
  ) {
    throw new Error(
      "incident replay response replay_generation must be positive",
    );
  }
  return {
    status: data.status,
    replayGeneration: data.replay_generation,
  };
}

function buildIncidentListUrl(baseUrl) {
  const url = new URL(incidentsPath, `${baseUrl}/`);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", String(incidentLimit));
  return url.toString();
}

function buildReplayUrl(baseUrl, incidentId) {
  return new URL(
    `${replayPathPrefix}/${encodeURIComponent(incidentId)}/replay`,
    `${baseUrl}/`,
  ).toString();
}

async function runSelfTest() {
  const checks = [
    runCheck("dry-run-contract-and-cookie-redaction", () => {
      const secret = "session=self-test-secret";
      const plan = buildPlan({
        baseUrl: defaultUrl,
        cookie: secret,
        incidentId: "a".repeat(64),
        timeoutMs: defaultTimeoutMs,
        dryRun: true,
      });
      if (
        plan.requests[0].url !==
        `${defaultUrl}${incidentsPath}?status=open&limit=${incidentLimit}`
      ) {
        throw new Error("dry-run incident query does not match the contract");
      }
      if (!deepEqual(plan.requests[1].body, { confirm_replay: true })) {
        throw new Error("dry-run replay body does not match the contract");
      }
      if (plan.safety.maximumIncidentsPerRun !== 1) {
        throw new Error("dry-run must cap the replay scope at one incident");
      }
      if (JSON.stringify(plan).includes(secret)) {
        throw new Error("dry-run leaked the admin cookie");
      }
    }),
    runCheck("live-mode-requires-confirmation", () => {
      expectFailure(
        () =>
          normalizeOptions(argsFixture({ cookie: "session=secret" }), false),
        "--confirm-live",
      );
    }),
    runCheck("live-mode-requires-admin-cookie", () => {
      expectFailure(
        () => normalizeOptions(argsFixture({}, ["confirm-live"]), false),
        "requires --cookie",
      );
    }),
    runCheck("live-mode-requires-an-explicit-incident", () => {
      expectFailure(
        () =>
          normalizeOptions(
            argsFixture({ cookie: "session=secret" }, ["confirm-live"]),
            false,
          ),
        "requires --incident-id",
      );
    }),
    runCheck("rejects-event-payload-and-pricing-options", () => {
      for (const option of [
        "--event-payload",
        "--payload",
        "--price",
        "--quota",
        "--usage",
      ]) {
        expectFailure(
          () => parseArgs(["--dry-run", option, "self-test-value"]),
          "unknown option",
        );
      }
    }),
    runCheck("rejects-unsafe-incident-lists", () => {
      expectFailure(
        () =>
          selectOpenIncident(
            incidentList([
              incidentRecord("c", { status: "resolved", replayable: false }),
            ]),
            "c".repeat(64),
          ),
        "status=open",
      );
      expectFailure(
        () =>
          selectOpenIncident(
            incidentList([incidentRecord("d"), incidentRecord("d")]),
            "d".repeat(64),
          ),
        "duplicate",
      );
      expectFailure(
        () =>
          selectOpenIncident(
            incidentList(
              Array.from({ length: incidentLimit + 1 }, (_, index) =>
                incidentRecord((index % 10).toString()),
              ),
            ),
            "0".repeat(64),
          ),
        "exceeded",
      );
      expectFailure(
        () =>
          selectOpenIncident(
            incidentList([incidentRecord("not-hex")]),
            "a".repeat(64),
          ),
        "valid incident_id",
      );
      expectFailure(
        () =>
          selectOpenIncident(
            incidentList([incidentRecord("e")]),
            "f".repeat(64),
          ),
        "requested incident_id",
      );
    }),
  ];
  checks.push(
    await runAsyncCheck(
      "live-client-exact-request-contract",
      liveClientMockCheck,
    ),
  );
  const failed = checks.filter((check) => check.status !== "PASS");
  return {
    tool: "smoke_billing_finalization_reconcile",
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
  const responseSecret = "must-not-appear-in-output";
  const incidentIds = ["a".repeat(64), "b".repeat(64)];
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const call = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        cookieMatches: request.headers.get("cookie") === cookie,
        body: null,
      };
      if (request.method === "POST") call.body = await request.json();
      calls.push(call);

      if (!call.cookieMatches) {
        return Response.json({ success: false }, { status: 401 });
      }
      if (url.pathname === incidentsPath && request.method === "GET") {
        return Response.json({
          success: true,
          data: {
            contract_version: 1,
            count: 2,
            records: [
              {
                incident_id: incidentIds[0],
                classification: "replayable",
                status: "open",
                replayable: true,
                event_payload: responseSecret,
                final_quota: 123,
              },
              {
                incident_id: incidentIds[1],
                classification: "replayable",
                status: "open",
                replayable: true,
              },
            ],
          },
        });
      }
      if (
        request.method === "POST" &&
        incidentIds.some(
          (incidentId) =>
            url.pathname === `${replayPathPrefix}/${incidentId}/replay`,
        )
      ) {
        return Response.json(
          {
            success: true,
            data: {
              contract_version: 1,
              incident_id: url.pathname.split("/").at(-2),
              status: "queued",
              replay_generation: 1,
              event_payload: responseSecret,
            },
          },
          { status: 202 },
        );
      }
      return Response.json({ success: false }, { status: 404 });
    },
  });

  try {
    const result = await runLive({
      baseUrl: `http://127.0.0.1:${server.port}`,
      cookie,
      incidentId: incidentIds[0],
      timeoutMs: defaultTimeoutMs,
      dryRun: false,
    });
    if (result.status !== "PASS" || result.summary.replayRequests !== 1) {
      throw new Error("mock live client did not replay exactly one incident");
    }
    if (
      calls.length !== 2 ||
      calls.some((call) => !call.cookieMatches) ||
      calls[0].method !== "GET" ||
      calls[0].path !== incidentsPath ||
      calls[0].search !== `?status=open&limit=${incidentLimit}`
    ) {
      throw new Error("mock live client did not make the exact list request");
    }
    for (const call of calls.slice(1)) {
      if (
        call.method !== "POST" ||
        !deepEqual(call.body, { confirm_replay: true }) ||
        Object.keys(call.body).length !== 1
      ) {
        throw new Error("mock live client sent an invalid replay request");
      }
      if (call.path !== `${replayPathPrefix}/${incidentIds[0]}/replay`) {
        throw new Error("mock live client replayed a non-selected incident");
      }
    }
    const serialized = JSON.stringify(result);
    if (serialized.includes(cookie) || serialized.includes(responseSecret)) {
      throw new Error("mock live result leaked a secret or event payload");
    }
  } finally {
    server.stop(true);
  }
}

function incidentList(records) {
  return { contract_version: 1, count: records.length, records };
}

function incidentRecord(hexDigit, overrides = {}) {
  return {
    incident_id: hexDigit.repeat(64),
    classification: "replayable",
    status: "open",
    replayable: true,
    ...overrides,
  };
}

function argsFixture(values = {}, flags = []) {
  return {
    values: new Map(
      Object.entries({
        url: defaultUrl,
        "timeout-ms": String(defaultTimeoutMs),
        ...values,
      }),
    ),
    flags: new Set(flags),
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

async function readJsonResponse(response, label) {
  let body;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body?.success === false) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
  assertObject(body, `${label} response`);
  const data = body.data ?? body;
  if (data == null || typeof data !== "object") {
    throw new Error(`${label} response data must be an object or array`);
  }
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

function requestHeaders(cookie, json) {
  const headers = {
    accept: "application/json",
    cookie,
    "x-cinatoken-smoke": "billing-finalization-reconcile",
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

function optionalHeaderValue(value, name) {
  if (value == null || String(value).trim() === "") return "";
  const normalized = String(value).trim();
  if (/\r|\n/.test(normalized)) {
    throw new Error(`${name} must not contain CR/LF`);
  }
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

function assertObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usage(exitCode) {
  console.error(
    [
      "Usage: bun tools/smoke_billing_finalization_reconcile.mjs --self-test [--json]",
      "       bun tools/smoke_billing_finalization_reconcile.mjs --dry-run --json [--url <worker-origin>]",
      "       bun tools/smoke_billing_finalization_reconcile.mjs --url <worker-origin> --cookie <verified-root-cookie> --incident-id <sha256> --confirm-live [--json]",
      "",
      "Confirms one explicitly selected open incident and queues exactly one replay.",
      "The root session must already have a fresh /api/verify step-up marker.",
      "The tool accepts no event payload, usage, quota, price, or other billing input.",
      "",
      "Options:",
      "  --url <origin>       or BILLING_FINALIZATION_RECONCILE_SMOKE_URL",
      "  --cookie <cookie>    or BILLING_FINALIZATION_RECONCILE_SMOKE_COOKIE, never printed",
      "  --incident-id <id>   or BILLING_FINALIZATION_RECONCILE_INCIDENT_ID",
      "  --timeout-ms <ms>    or BILLING_FINALIZATION_RECONCILE_SMOKE_TIMEOUT_MS, default 15000",
      "  --confirm-live       required for network access and incident replay",
      "  --dry-run            print the redacted GET/POST plan without network access",
      "  --self-test          validate request, safety, redaction, and mock-live contracts",
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
    console.log(`Billing-finalization reconcile self-test: ${result.status}`);
    for (const check of result.checks) {
      console.log(`- ${check.name}: ${check.status}`);
    }
    return;
  }
  if (result.mode === "dry-run") {
    console.log("Billing-finalization reconcile plan (dry-run)");
    console.log(`list: GET ${result.requests[0].url}`);
    console.log(`replay: POST ${result.requests[1].url}`);
    console.log(`admin_cookie_configured: ${result.adminCookieConfigured}`);
    return;
  }
  console.log(`Billing-finalization reconcile smoke: ${result.status}`);
  console.log(`replay_requests: ${result.summary.replayRequests}`);
  console.log("admin_cookie_configured: true");
  console.log(
    `- ${result.replay.incidentId}: queued (http ${result.replay.httpStatus})`,
  );
}
