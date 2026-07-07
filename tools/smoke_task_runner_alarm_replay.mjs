#!/usr/bin/env bun

const defaultTimeoutMs = 10000;
const defaultTaskId = "task-smoke";
const statusValues = new Set([
  "none",
  "armed",
  "alarm_fired",
  "poll_skipped",
  "poll_noop",
  "poll_applied",
  "poll_failed",
]);
const pollStatusValues = new Set(["none", "skipped", "noop", "applied", "failed"]);
const replayEvidenceValues = new Set([
  "no_record",
  "armed_pending",
  "alarm_fired_pending_poll",
  "first_apply",
  "second_replay_noop",
  "gate_disabled_fallback",
  "cron_already_settled",
  "poll_skipped",
  "poll_failed",
  "unknown",
]);

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("self-test")) {
    printResult(runSelfTest(), args.flags.has("json"));
  } else {
    const options = normalizeOptions(args);
    if (options.dryRun) {
      printResult(buildPlan(options), options.json);
    } else {
      const result = await smoke(options);
      printResult(result, options.json);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function smoke(options) {
  const plan = buildPlan(options);
  const capabilities = options.skipCapabilities
    ? null
    : await fetchAndValidateCapabilities(plan.capabilitiesUrl, options);
  const status = await fetchAndValidateStatus(plan.statusUrl, options);
  return {
    ok: true,
    dryRun: false,
    taskId: options.taskId,
    capabilitiesUrl: redactUrl(plan.capabilitiesUrl),
    statusUrl: redactUrl(plan.statusUrl),
    adminCookieConfigured: Boolean(options.adminCookie),
    skipCapabilities: options.skipCapabilities,
    capabilities,
    status,
    expectations: statusExpectations(options),
    evidenceReminder: evidenceReminder(),
  };
}

function buildPlan(options) {
  const base = normalizeBaseUrl(required(options.url, "url"));
  const taskId = sanitizeTaskId(required(options.taskId, "task-id"));
  if (!taskId) {
    throw new Error("task-id must contain at least one ASCII letter, number, underscore, or dash");
  }
  const capabilitiesUrl = buildHttpUrl(base, "/api/platform/capabilities");
  const statusUrl = buildHttpUrl(base, `/api/platform/task-runner/${encodeURIComponent(taskId)}/status`);
  return {
    ok: true,
    dryRun: options.dryRun,
    method: options.skipCapabilities ? "GET TaskRunner status" : "GET capabilities, then GET TaskRunner status",
    taskId,
    capabilitiesUrl: redactUrl(capabilitiesUrl),
    statusUrl: redactUrl(statusUrl),
    adminCookieConfigured: Boolean(options.adminCookie),
    skipCapabilities: options.skipCapabilities,
    expectedCapabilities: {
      requiredTrue: requiredCapabilityTrueFields(),
      requiredGuards: requiredCutoverGuards(),
      cutoverReadyMustRemainFalse: !options.allowCutoverReady,
      stagingReplayVerifiedMustRemainFalse: !options.allowStagingReplayVerified,
      gateExpectation: options.expectGateEnabled
        ? "enabled"
        : options.expectGateDisabled
          ? "disabled"
          : "not checked",
    },
    expectations: statusExpectations(options),
    stagingReplaySteps: [
      "Use an isolated staging Worker/D1 database and a low-risk task row or submit flow.",
      "Enable TASK_RUNNER_DO_ENABLED only in staging and keep cron enabled as the fallback authority.",
      "Submit or seed one shared task with an upstream task id, then let the submit path arm the per-task Durable Object.",
      "Wait at least the configured alarm delay, then run this probe against /api/platform/task-runner/:task_id/status.",
      "Archive capabilities, DO status, task row, quota/refund row, and cron replay snapshots.",
      "Disable TASK_RUNNER_DO_ENABLED again and prove the same task family still settles through cron.",
    ],
    notes: [
      "This smoke tool is read-only; it never calls the internal /arm or /delete Durable Object endpoints.",
      "Live mode requires --confirm-live and admin authentication because the status probe is admin-only.",
      "The probe validates only metadata fields: alarm timing, poll outcome, reason label, and CAS ownership.",
      "Do not mark TASK_RUNNER_STAGING_REPLAY_VERIFIED=true until the archived staging replay proves no double settlement.",
    ],
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set([
    "dry-run",
    "json",
    "self-test",
    "confirm-live",
    "skip-capabilities",
    "allow-cutover-ready",
    "allow-staging-replay-verified",
    "expect-gate-enabled",
    "expect-gate-disabled",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (flagNames.has(key)) {
      flags.add(key);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    values.set(key, next);
    i += 1;
  }
  return { values, flags };
}

function normalizeOptions(args) {
  const value = (name, envName) => args.values.get(name) ?? process.env[envName];
  const timeoutMs = Number(value("timeout-ms", "TASK_RUNNER_SMOKE_TIMEOUT_MS") || defaultTimeoutMs);
  const expectStatus = normalizeExpectation(
    value("expect-status", "TASK_RUNNER_SMOKE_EXPECT_STATUS"),
    statusValues,
    "expect-status",
  );
  const expectPollStatus = normalizeExpectation(
    value("expect-poll-status", "TASK_RUNNER_SMOKE_EXPECT_POLL_STATUS"),
    pollStatusValues,
    "expect-poll-status",
  );
  const expectCasWon = normalizeOptionalBoolean(
    value("expect-cas-won", "TASK_RUNNER_SMOKE_EXPECT_CAS_WON"),
    "expect-cas-won",
  );
  const expectReplayEvidence = normalizeExpectation(
    value("expect-replay-evidence", "TASK_RUNNER_SMOKE_EXPECT_REPLAY_EVIDENCE"),
    replayEvidenceValues,
    "expect-replay-evidence",
  );
  const dryRun = args.flags.has("dry-run");
  if (!dryRun && !args.flags.has("confirm-live")) {
    throw new Error("live TaskRunner status smoke requires --confirm-live");
  }
  if (args.flags.has("expect-gate-enabled") && args.flags.has("expect-gate-disabled")) {
    throw new Error("choose at most one of --expect-gate-enabled or --expect-gate-disabled");
  }
  return {
    url: value("url", "TASK_RUNNER_SMOKE_URL"),
    taskId: value("task-id", "TASK_RUNNER_SMOKE_TASK_ID") || defaultTaskId,
    adminCookie: value("cookie", "TASK_RUNNER_SMOKE_COOKIE") || "",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    expectStatus,
    expectPollStatus,
    expectCasWon,
    expectReplayEvidence,
    expectGateEnabled: args.flags.has("expect-gate-enabled"),
    expectGateDisabled: args.flags.has("expect-gate-disabled"),
    allowCutoverReady: args.flags.has("allow-cutover-ready"),
    allowStagingReplayVerified: args.flags.has("allow-staging-replay-verified"),
    skipCapabilities: args.flags.has("skip-capabilities"),
    dryRun,
    json: args.flags.has("json"),
  };
}

function usage(exitCode) {
  console.error(
    [
      "Usage: bun tools/smoke_task_runner_alarm_replay.mjs --dry-run --url <base> --task-id <id> [--json]",
      "       bun tools/smoke_task_runner_alarm_replay.mjs --url <base> --task-id <id> --cookie <admin-cookie> --confirm-live [--json]",
      "",
      "Read-only TaskRunner alarm replay probe. Live mode GETs admin-only /api/platform/capabilities",
      "and /api/platform/task-runner/:task_id/status; it never arms or deletes alarms.",
      "",
      "Options:",
      "  --url <base>          or TASK_RUNNER_SMOKE_URL",
      "  --task-id <id>       or TASK_RUNNER_SMOKE_TASK_ID, default task-smoke",
      "  --cookie <cookie>    or TASK_RUNNER_SMOKE_COOKIE, never printed",
      "  --timeout-ms <ms>    or TASK_RUNNER_SMOKE_TIMEOUT_MS, default 10000",
      "  --expect-status <none|armed|alarm_fired|poll_skipped|poll_noop|poll_applied|poll_failed>",
      "  --expect-poll-status <none|skipped|noop|applied|failed>",
      "  --expect-cas-won <true|false>",
      "  --expect-replay-evidence <no_record|armed_pending|alarm_fired_pending_poll|first_apply|second_replay_noop|gate_disabled_fallback|cron_already_settled|poll_skipped|poll_failed|unknown>",
      "  --expect-gate-enabled / --expect-gate-disabled",
      "  --allow-cutover-ready",
      "  --allow-staging-replay-verified",
      "  --skip-capabilities",
      "  --confirm-live       required for network probes",
      "  --dry-run            print a redacted replay plan without network",
      "  --self-test          validate local contract checks without network",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_task_runner_alarm_replay.mjs --dry-run --json --url http://127.0.0.1:8787 --task-id task-smoke",
      "  bun tools/smoke_task_runner_alarm_replay.mjs --url https://staging.example.com --task-id task_abc --cookie \"$TASK_RUNNER_SMOKE_COOKIE\" --confirm-live --expect-poll-status applied --json",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function fetchAndValidateCapabilities(capabilitiesUrl, options) {
  const response = await fetchWithTimeout(
    capabilitiesUrl,
    {
      method: "GET",
      headers: smokeHeaders(options),
      redirect: "error",
    },
    options.timeoutMs,
  );
  const data = await readEnvelope(response, "platform capabilities");
  const capabilities = summarizeCapabilities(data);
  validateCapabilities(capabilities, options);
  return capabilities;
}

async function fetchAndValidateStatus(statusUrl, options) {
  const response = await fetchWithTimeout(
    statusUrl,
    {
      method: "GET",
      headers: smokeHeaders(options),
      redirect: "error",
    },
    options.timeoutMs,
  );
  const data = await readEnvelope(response, "TaskRunner status");
  const status = summarizeStatus(data);
  validateStatus(status, options);
  return status;
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
  return body.data;
}

function summarizeCapabilities(data) {
  return {
    task_runner_do_available: data.task_runner_do_available === true,
    task_runner_do_enabled: data.task_runner_do_enabled === true,
    task_runner_do_foundation_compiled: data.task_runner_do_foundation_compiled === true,
    task_runner_alarm_contract_compiled: data.task_runner_alarm_contract_compiled === true,
    task_runner_submit_path_compiled: data.task_runner_submit_path_compiled === true,
    task_runner_poll_path_compiled: data.task_runner_poll_path_compiled === true,
    task_runner_status_probe_compiled: data.task_runner_status_probe_compiled === true,
    task_runner_staging_replay_verified: data.task_runner_staging_replay_verified === true,
    task_runner_cutover_ready: data.task_runner_cutover_ready === true,
    task_runner_cutover_guards: arrayOfStrings(data.task_runner_cutover_guards),
  };
}

function validateCapabilities(capabilities, options) {
  for (const field of requiredCapabilityTrueFields()) {
    if (capabilities[field] !== true) {
      throw new Error(`platform capabilities ${field}=${capabilities[field]} did not report true`);
    }
  }
  for (const guard of requiredCutoverGuards()) {
    if (!capabilities.task_runner_cutover_guards.includes(guard)) {
      throw new Error(`platform capabilities missing TaskRunner cutover guard ${guard}`);
    }
  }
  if (!options.allowCutoverReady && capabilities.task_runner_cutover_ready !== false) {
    throw new Error("TaskRunner cutover readiness must remain false until staging replay is archived");
  }
  if (!options.allowStagingReplayVerified && capabilities.task_runner_staging_replay_verified !== false) {
    throw new Error("TASK_RUNNER_STAGING_REPLAY_VERIFIED must remain false for pre-cutover probes");
  }
  if (options.expectGateEnabled && capabilities.task_runner_do_enabled !== true) {
    throw new Error("TASK_RUNNER_DO_ENABLED was expected to be true");
  }
  if (options.expectGateDisabled && capabilities.task_runner_do_enabled !== false) {
    throw new Error("TASK_RUNNER_DO_ENABLED was expected to be false");
  }
}

function summarizeStatus(data) {
  const durable = data.durable_object_status || {};
  return {
    task_id: stringOrNull(data.task_id),
    instance: stringOrNull(data.instance),
    compiled: durable.compiled === true,
    durable_task_id: stringOrNull(durable.task_id),
    status: stringOrNull(durable.status),
    replay_evidence: stringOrNull(durable.replay_evidence),
    alarm_scheduled_at_ms: numberOrNull(durable.alarm_scheduled_at_ms),
    alarm_delay_ms: numberOrNull(durable.alarm_delay_ms),
    alarm_fired_at_ms: numberOrNull(durable.alarm_fired_at_ms),
    alarm_fired_count: Number.isFinite(durable.alarm_fired_count) ? durable.alarm_fired_count : 0,
    poll_attempted_at_ms: numberOrNull(durable.poll_attempted_at_ms),
    poll_completed_at_ms: numberOrNull(durable.poll_completed_at_ms),
    poll_status: stringOrNull(durable.poll_status),
    poll_reason: stringOrNull(durable.poll_reason),
    poll_cas_won: typeof durable.poll_cas_won === "boolean" ? durable.poll_cas_won : null,
  };
}

function validateStatus(status, options) {
  const expectedTaskId = sanitizeTaskId(options.taskId);
  if (status.task_id !== expectedTaskId) {
    throw new Error(`TaskRunner status route returned task_id=${status.task_id}, expected ${expectedTaskId}`);
  }
  if (status.instance !== `task:${expectedTaskId}`) {
    throw new Error(`TaskRunner status route returned instance=${status.instance}, expected task:${expectedTaskId}`);
  }
  if (status.compiled !== true) {
    throw new Error("TaskRunner Durable Object status did not report compiled=true");
  }
  if (options.expectStatus) {
    const actual = status.status || "none";
    if (actual !== options.expectStatus) {
      throw new Error(`TaskRunner status ${actual} did not match expected ${options.expectStatus}`);
    }
  }
  if (options.expectPollStatus) {
    const actual = status.poll_status || "none";
    if (actual !== options.expectPollStatus) {
      throw new Error(`TaskRunner poll_status ${actual} did not match expected ${options.expectPollStatus}`);
    }
  }
  if (options.expectCasWon !== null && status.poll_cas_won !== options.expectCasWon) {
    throw new Error(`TaskRunner poll_cas_won ${status.poll_cas_won} did not match expected ${options.expectCasWon}`);
  }
  if (options.expectReplayEvidence && status.replay_evidence !== options.expectReplayEvidence) {
    throw new Error(
      `TaskRunner replay_evidence ${status.replay_evidence} did not match expected ${options.expectReplayEvidence}`,
    );
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function smokeHeaders(options) {
  const headers = {
    accept: "application/json",
    "x-cinatoken-smoke": "task-runner-alarm-replay",
  };
  if (options.adminCookie) {
    headers.cookie = options.adminCookie;
  }
  return headers;
}

function requiredCapabilityTrueFields() {
  return [
    "task_runner_do_available",
    "task_runner_do_foundation_compiled",
    "task_runner_alarm_contract_compiled",
    "task_runner_submit_path_compiled",
    "task_runner_poll_path_compiled",
    "task_runner_status_probe_compiled",
  ];
}

function requiredCutoverGuards() {
  return [
    "task_runner_binding",
    "task_runner_gate",
    "deterministic_task_instance",
    "alarm_contract",
    "submit_path_armed",
    "cron_sweeper_fallback",
    "no_double_poll_cas",
    "status_probe",
    "staging_alarm_replay",
  ];
}

function statusExpectations(options) {
  return {
    status: options.expectStatus || "not checked",
    pollStatus: options.expectPollStatus || "not checked",
    pollCasWon: options.expectCasWon === null ? "not checked" : options.expectCasWon,
    replayEvidence: options.expectReplayEvidence || "not checked",
  };
}

function runSelfTest() {
  const options = {
    url: "http://127.0.0.1:8787",
    taskId: "task_smoke",
    adminCookie: "session=self-test-secret",
    timeoutMs: defaultTimeoutMs,
    expectStatus: "poll_applied",
    expectPollStatus: "applied",
    expectCasWon: true,
    expectReplayEvidence: "first_apply",
    expectGateEnabled: false,
    expectGateDisabled: true,
    allowCutoverReady: false,
    allowStagingReplayVerified: false,
    skipCapabilities: false,
    dryRun: true,
    json: true,
  };
  const plan = buildPlan(options);
  if (JSON.stringify(plan).includes(options.adminCookie)) {
    throw new Error("self-test leaked admin cookie in dry-run plan");
  }
  validateCapabilities(
    summarizeCapabilities({
      task_runner_do_available: true,
      task_runner_do_enabled: false,
      task_runner_do_foundation_compiled: true,
      task_runner_alarm_contract_compiled: true,
      task_runner_submit_path_compiled: true,
      task_runner_poll_path_compiled: true,
      task_runner_status_probe_compiled: true,
      task_runner_staging_replay_verified: false,
      task_runner_cutover_ready: false,
      task_runner_cutover_guards: requiredCutoverGuards(),
    }),
    options,
  );
  validateStatus(
    summarizeStatus({
      task_id: "task_smoke",
      instance: "task:task_smoke",
      durable_object_status: {
        compiled: true,
        task_id: "task_smoke",
        status: "poll_applied",
        replay_evidence: "first_apply",
        alarm_fired_count: 1,
        poll_status: "applied",
        poll_reason: "cas_applied",
        poll_cas_won: true,
      },
    }),
    options,
  );
  const failures = [
    expectFailure(
      () =>
        validateCapabilities(
          summarizeCapabilities({
            task_runner_do_available: true,
            task_runner_do_enabled: false,
            task_runner_do_foundation_compiled: true,
            task_runner_alarm_contract_compiled: true,
            task_runner_submit_path_compiled: true,
            task_runner_poll_path_compiled: true,
            task_runner_status_probe_compiled: false,
            task_runner_staging_replay_verified: false,
            task_runner_cutover_ready: false,
            task_runner_cutover_guards: requiredCutoverGuards(),
          }),
          options,
        ),
      "task_runner_status_probe_compiled",
    ),
    expectFailure(
      () =>
        validateStatus(
          summarizeStatus({
            task_id: "task_smoke",
            instance: "task:task_smoke",
            durable_object_status: {
              compiled: true,
              status: "poll_failed",
              replay_evidence: "poll_failed",
              poll_status: "failed",
            },
          }),
          options,
        ),
      "did not match expected",
    ),
    expectFailure(
      () =>
        validateStatus(
          summarizeStatus({
            task_id: "task_smoke",
            instance: "task:task_smoke",
            durable_object_status: {
              compiled: true,
              status: "poll_applied",
              replay_evidence: "second_replay_noop",
              poll_status: "applied",
              poll_cas_won: true,
            },
          }),
          options,
        ),
      "replay_evidence",
    ),
  ];
  return {
    tool: "smoke_task_runner_alarm_replay",
    mode: "self-test",
    ok: true,
    cases: [
      { name: "dry-run-redacts-cookie", ok: true },
      { name: "capability-contract", ok: true },
      { name: "status-contract", ok: true },
      ...failures,
    ],
  };
}

function expectFailure(fn, expected) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) {
      throw new Error(`unexpected self-test failure: ${message}`);
    }
    return { name: `rejects-${expected}`, ok: true };
  }
  throw new Error(`expected self-test failure containing ${expected}`);
}

function evidenceReminder() {
  return [
    "Archive the JSON output from this probe with the matching task row and quota/refund snapshots.",
    "Capture a second replay that proves the CAS no-ops after the first settlement.",
    "Capture rollback evidence with TASK_RUNNER_DO_ENABLED=false and cron still settling the task family.",
  ];
}

function normalizeExpectation(value, allowed, name) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${name} must be one of ${Array.from(allowed).join(", ")}`);
  }
  return normalized;
}

function normalizeOptionalBoolean(value, name) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeBaseUrl(value) {
  const url = new URL(required(value, "url"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("url must use http or https");
  }
  return url;
}

function buildHttpUrl(base, path) {
  const url = new URL(base.toString());
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function sanitizeTaskId(value) {
  const sanitized = String(value || "")
    .slice(0, 128)
    .replace(/[^A-Za-z0-9_-]/g, "");
  return sanitized || null;
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

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "self-test") {
    console.log(
      [
        "TaskRunner alarm replay self-test",
        `ok: ${result.ok}`,
        ...result.cases.map((item) => `case ${item.name}: ${item.ok ? "ok" : "failed"}`),
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      result.dryRun ? "TaskRunner alarm replay plan (dry-run)" : "TaskRunner alarm replay probe",
      `task_id: ${result.taskId}`,
      `capabilities_url: ${result.capabilitiesUrl}`,
      `status_url: ${result.statusUrl}`,
      `admin_cookie_configured: ${result.adminCookieConfigured}`,
      `skip_capabilities: ${result.skipCapabilities}`,
      ...(result.capabilities ? [`capabilities: ${JSON.stringify(result.capabilities)}`] : []),
      ...(result.status ? [`status: ${JSON.stringify(result.status)}`] : []),
      ...(result.expectedCapabilities
        ? [`expected_capabilities: ${JSON.stringify(result.expectedCapabilities)}`]
        : []),
      ...(result.expectations ? [`expectations: ${JSON.stringify(result.expectations)}`] : []),
      ...(result.stagingReplaySteps ? ["staging_replay_steps:", ...result.stagingReplaySteps.map((step) => `- ${step}`)] : []),
      ...(result.notes ? ["notes:", ...result.notes.map((note) => `- ${note}`)] : []),
      ...(result.evidenceReminder
        ? ["evidence_reminder:", ...result.evidenceReminder.map((note) => `- ${note}`)]
        : []),
    ].join("\n"),
  );
}
