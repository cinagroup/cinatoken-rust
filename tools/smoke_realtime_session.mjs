#!/usr/bin/env bun

const defaultSession = "session-smoke";
const defaultModel = "gpt-4o-realtime-preview";
const defaultTimeoutMs = 10_000;
const defaultProbe = "cinatoken realtime smoke probe";
const maxRealtimeBridgeTextFrameBytes = 1_048_576;
const defaultFrameLimitProbeBytes = maxRealtimeBridgeTextFrameBytes + 1;
const frameLimitProbePrefix = "cinatoken-frame-limit-smoke:";
const bridgeReplayLeakProbe = "cinatoken-bridge-replay-secret";
const upstreamReplayLeakProbe = "cinatoken-upstream-replay-secret";
const realtimeUpstreamPlanHeader = "x-cinatoken-realtime-upstream-plan";
const realtimeUpstreamConnectHeader = "x-cinatoken-realtime-upstream-connect";

const args = parseArgs(process.argv.slice(2));

try {
  if (args.flags.has("self-test-bridge-replay")) {
    printBridgeReplaySelfTestResult(runBridgeReplayContractSelfTest(), args.flags.has("json"));
  } else if (args.flags.has("self-test-upstream-replay")) {
    printUpstreamReplaySelfTestResult(runUpstreamReplayContractSelfTest(), args.flags.has("json"));
  } else if (args.flags.has("self-test-platform-header-boundary")) {
    printPlatformHeaderBoundarySelfTestResult(
      runPlatformHeaderBoundarySelfTest(),
      args.flags.has("json"),
    );
  } else {
    const options = normalizeOptions(args);
    const result = options.dryRun ? redactedPlan(buildPlan(options)) : await smoke(options);
    printResult(result, options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function smoke(options) {
  const plan = buildPlan(options);
  const capabilities = await maybeCheckCapabilities(options, plan);
  const forgedHeaders = options.expectPlatformHeaderBoundary ? forgedRealtimeUpstreamHeaders() : null;
  const ws = await openWebSocket(plan.wsUrl, plan.protocols, options.timeoutMs, {
    headers: forgedHeaders,
  });
  try {
    ws.send("ping");
    const pong = await waitForJsonMessage(
      ws,
      (message) => message.type === "pong",
      options.timeoutMs,
      "pong",
    );

    ws.send("status");
    const statusFrame = await waitForJsonMessage(
      ws,
      (message) => message.type === "realtime_session_status",
      options.timeoutMs,
      "realtime_session_status",
    );
    validateMetrics(statusFrame.metrics, "websocket status metrics");
    validateRuntimeStatusCounters(statusFrame, "websocket status");

    let controlFrame = null;
    let frameLimitControlFrame = null;
    let frameLimitClose = null;
    if (options.expectFrameLimitEvent) {
      const probe = makeFrameLimitProbe(options.frameLimitBytes);
      const outcomePromise = waitForJsonMessageThenClose(
        ws,
        (message) => message.type === "realtime_session_control",
        options.timeoutMs,
        "frame-limit realtime_session_control",
      );
      ws.send(probe);
      const outcome = await outcomePromise;
      frameLimitControlFrame = outcome.message;
      frameLimitClose = outcome.close;
      validateFrameLimitControlFrame(frameLimitControlFrame, options.frameLimitBytes);
      validateFrameLimitClose(frameLimitClose);
    } else {
      ws.send(options.probe);
      controlFrame = await waitForJsonMessage(
        ws,
        (message) => message.type === "realtime_session_control",
        options.timeoutMs,
        "realtime_session_control",
      );
      validateControlFrame(controlFrame, options.probe);
    }

    let httpStatus = null;
    if (plan.statusUrl) {
      const response = await fetch(plan.statusUrl, { redirect: "error" });
      if (!response.ok) {
        throw new Error(`HTTP status smoke failed: ${response.status} ${response.statusText}`);
      }
      httpStatus = await response.json();
      validateMetrics(httpStatus.metrics, "HTTP status metrics", {
        minTextMessageCount: 3,
        expectedBridgeEvent: options.expectFrameLimitEvent ? "frame_too_large" : null,
        expectedBridgeFrameBytes: options.expectFrameLimitEvent ? options.frameLimitBytes : null,
      });
    }

    let platformHeaderBoundary = null;
    if (options.expectPlatformHeaderBoundary) {
      validatePlatformHeaderBoundaryFrames({
        pong,
        statusFrame,
        controlFrame,
        httpStatus,
      });
      platformHeaderBoundary = summarizePlatformHeaderBoundary({
        headers: forgedHeaders,
        pong,
        statusFrame,
        controlFrame,
        httpStatus,
      });
    }

    return {
      ok: true,
      dryRun: false,
      mode: plan.mode,
      wsUrl: redactUrl(plan.wsUrl),
      statusUrl: plan.statusUrl ? redactUrl(plan.statusUrl) : null,
      capabilities,
      pongContext: pong.context ?? null,
      websocketMetrics: summarizeMetrics(statusFrame.metrics),
      httpMetrics: httpStatus?.metrics ? summarizeMetrics(httpStatus.metrics) : null,
      websocketRuntimeStatus: summarizeRuntimeStatus(statusFrame),
      httpRuntimeStatus: httpStatus ? summarizeRuntimeStatus(httpStatus) : null,
      controlFrame: controlFrame ? summarizeControlFrame(controlFrame) : null,
      frameLimitControlFrame: frameLimitControlFrame
        ? summarizeFrameLimitControlFrame(frameLimitControlFrame)
        : null,
      frameLimitClose,
      bridgeTerminalEvent: httpStatus?.metrics?.last_bridge_terminal_event
        ? summarizeBridgeTerminalEvent(httpStatus.metrics.last_bridge_terminal_event)
        : null,
      platformHeaderBoundary,
    };
  } finally {
    try {
      ws.close(1000, "cinatoken realtime smoke complete");
    } catch {
      // Frame-limit smoke expects the server to close the socket first.
    }
  }
}

function buildPlan(options) {
  const baseUrl = required(options.url, "url");
  const mode = options.mode;
  const base = normalizeBaseUrl(baseUrl);
  const protocols = realtimeProtocols(options);
  const wsUrl =
    mode === "v1"
      ? buildWebSocketUrl(base, "/v1/realtime", { model: options.model })
      : buildWebSocketUrl(base, `/api/platform/realtime/${encodeURIComponent(options.session)}`);
  const capabilitiesUrl = buildHttpUrl(base, "/api/platform/capabilities");
  const statusUrl =
    mode === "platform"
      ? buildHttpUrl(base, `/api/platform/realtime/${encodeURIComponent(options.session)}/status`)
      : null;
  return {
    ok: true,
    dryRun: options.dryRun,
    mode,
    capabilitiesUrl,
    wsUrl,
    statusUrl,
    protocols,
    capabilitiesPreflight: shouldCheckCapabilities(options),
    adminCookieConfigured: Boolean(options.adminCookie),
    expectPlatformGateEnabled: options.expectPlatformGateEnabled,
    expectPlatformGateDisabled: options.expectPlatformGateDisabled,
    expectV1GateEnabled: options.expectV1GateEnabled,
    expectV1GateDisabled: options.expectV1GateDisabled,
    expectPlatformReady: options.expectPlatformReady,
    expectV1CutoverReady: options.expectV1CutoverReady,
    expectFrameLimitEvent: options.expectFrameLimitEvent,
    expectPlatformHeaderBoundary: options.expectPlatformHeaderBoundary,
    timeoutMs: options.timeoutMs,
    probeConfigured: Boolean(options.probe),
    probeBytes: byteLength(options.probe),
    frameLimitProbeBytes: options.expectFrameLimitEvent ? options.frameLimitBytes : null,
    forgedUpstreamHeaderNames: options.expectPlatformHeaderBoundary
      ? [realtimeUpstreamPlanHeader, realtimeUpstreamConnectHeader]
      : [],
    notes:
      mode === "v1"
        ? [
            options.expectFrameLimitEvent
              ? "v1 mode validates WebSocket status plus metadata-only frame-limit close behavior; persisted terminal metrics require platform status smoke."
              : "v1 mode validates WebSocket status and metadata-only unsupported-control frames; the DO session name is derived from gateway auth context.",
          ]
        : [
            options.expectFrameLimitEvent
              ? "platform mode validates WebSocket status, metadata-only frame-limit close behavior, and persisted terminal bridge event metrics through HTTP status."
              : options.expectPlatformHeaderBoundary
                ? "platform mode forges internal upstream handoff headers and validates the Durable Object still reports no upstream handoff or bridge."
                : "platform mode validates WebSocket status, metadata-only unsupported-control frames, and HTTP status for the named DO session.",
          ],
  };
}

function redactedPlan(plan) {
  return {
    ...plan,
    capabilitiesUrl: redactUrl(plan.capabilitiesUrl),
    wsUrl: redactUrl(plan.wsUrl),
    statusUrl: plan.statusUrl ? redactUrl(plan.statusUrl) : null,
    protocols: plan.protocols.map(redactProtocol),
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set([
    "dry-run",
    "json",
    "skip-capabilities",
    "expect-platform-gate-enabled",
    "expect-platform-gate-disabled",
    "expect-v1-gate-enabled",
    "expect-v1-gate-disabled",
    "expect-platform-ready",
    "expect-v1-cutover-ready",
    "expect-frame-limit-event",
    "expect-platform-header-boundary",
    "self-test-bridge-replay",
    "self-test-upstream-replay",
    "self-test-platform-header-boundary",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    const key = arg.slice(2);
    if (flagNames.has(key)) {
      flags.add(key);
      continue;
    }
    if (!arg.startsWith("--")) {
      usage(2, `Unexpected argument: ${arg}`);
    }
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
  const mode = value("mode", "REALTIME_SMOKE_MODE") || "platform";
  if (!["platform", "v1"].includes(mode)) {
    throw new Error("mode must be platform or v1");
  }
  const timeoutMs = Number.parseInt(value("timeout-ms", "REALTIME_SMOKE_TIMEOUT_MS") || "", 10);
  const adminCookie = optionalHeaderValue(value("cookie", "REALTIME_SMOKE_COOKIE"), "cookie");
  if (args.flags.has("expect-platform-gate-enabled") && args.flags.has("expect-platform-gate-disabled")) {
    throw new Error("use only one of --expect-platform-gate-enabled or --expect-platform-gate-disabled");
  }
  if (args.flags.has("expect-v1-gate-enabled") && args.flags.has("expect-v1-gate-disabled")) {
    throw new Error("use only one of --expect-v1-gate-enabled or --expect-v1-gate-disabled");
  }
  if (args.flags.has("expect-platform-header-boundary") && mode !== "platform") {
    throw new Error("--expect-platform-header-boundary is only valid in platform mode");
  }
  if (args.flags.has("expect-platform-header-boundary") && args.flags.has("expect-frame-limit-event")) {
    throw new Error("use --expect-platform-header-boundary separately from --expect-frame-limit-event");
  }
  return {
    url: value("url", "REALTIME_SMOKE_URL"),
    mode,
    session: validateSessionName(value("session", "REALTIME_SMOKE_SESSION") || defaultSession),
    model: validatePlainValue(value("model", "REALTIME_SMOKE_MODEL") || defaultModel, "model"),
    apiKey: value("api-key", "REALTIME_SMOKE_API_KEY") || "",
    adminCookie,
    probe: validatePlainValue(value("probe", "REALTIME_SMOKE_PROBE") || defaultProbe, "probe"),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    skipCapabilities: args.flags.has("skip-capabilities"),
    expectPlatformGateEnabled: args.flags.has("expect-platform-gate-enabled"),
    expectPlatformGateDisabled: args.flags.has("expect-platform-gate-disabled"),
    expectV1GateEnabled: args.flags.has("expect-v1-gate-enabled"),
    expectV1GateDisabled: args.flags.has("expect-v1-gate-disabled"),
    expectPlatformReady: args.flags.has("expect-platform-ready"),
    expectV1CutoverReady: args.flags.has("expect-v1-cutover-ready"),
    expectFrameLimitEvent: args.flags.has("expect-frame-limit-event"),
    expectPlatformHeaderBoundary: args.flags.has("expect-platform-header-boundary"),
    frameLimitBytes: validateFrameLimitBytes(
      Number.parseInt(value("frame-limit-bytes", "REALTIME_SMOKE_FRAME_LIMIT_BYTES") || "", 10),
    ),
    dryRun: args.flags.has("dry-run"),
    json: args.flags.has("json"),
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/smoke_realtime_session.mjs --url <worker-origin> [options]",
      "",
      "Modes:",
      "  --mode platform  Connects /api/platform/realtime/:session and checks HTTP status too (default)",
      "  --mode v1        Connects /v1/realtime?model=... using Realtime subprotocol token",
      "",
      "Options:",
      "  --session <name>      or REALTIME_SMOKE_SESSION (platform mode)",
      "  --model <model>       or REALTIME_SMOKE_MODEL (v1 mode)",
      "  --api-key <token>     or REALTIME_SMOKE_API_KEY (v1 mode)",
      "  --cookie <header>     or REALTIME_SMOKE_COOKIE, admin Cookie for capabilities preflight",
      "  --probe <text>        or REALTIME_SMOKE_PROBE, default is a safe fixed probe",
      "  --timeout-ms <ms>     or REALTIME_SMOKE_TIMEOUT_MS, default 10000",
      "  --skip-capabilities   Do not preflight /api/platform/capabilities",
      "  --expect-platform-gate-enabled   Require REALTIME_SESSION_GATEWAY_ENABLED=true",
      "  --expect-platform-gate-disabled  Require REALTIME_SESSION_GATEWAY_ENABLED=false",
      "  --expect-v1-gate-enabled         Require REALTIME_SESSION_V1_ENABLED=true",
      "  --expect-v1-gate-disabled        Require REALTIME_SESSION_V1_ENABLED=false",
      "  --expect-platform-ready          Require platform smoke readiness=true",
      "  --expect-v1-cutover-ready        Require production v1 cutover readiness=true",
      "  --expect-frame-limit-event       Send an oversized text frame and validate 1009 close plus terminal event metrics",
      "  --expect-platform-header-boundary  Forge internal upstream handoff headers and require the platform route to strip them",
      "  --frame-limit-bytes <bytes>      or REALTIME_SMOKE_FRAME_LIMIT_BYTES, default 1048577",
      "  --self-test-bridge-replay        Run local synthetic close/error/send-failure replay contract tests without network",
      "  --self-test-upstream-replay      Run ordered mock upstream replay scenario contract tests without network",
      "  --self-test-platform-header-boundary  Run local synthetic platform header-boundary validator tests without network",
      "  --dry-run             resolve URLs/protocols without network",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_realtime_session.mjs --dry-run --url http://127.0.0.1:8787 --json",
      "  bun tools/smoke_realtime_session.mjs --url https://staging.example.com --session session-smoke --cookie \"$REALTIME_SMOKE_COOKIE\" --expect-platform-ready",
      "  bun tools/smoke_realtime_session.mjs --url https://staging.example.com --session session-smoke --cookie \"$REALTIME_SMOKE_COOKIE\" --expect-platform-ready --expect-platform-header-boundary",
      "  bun tools/smoke_realtime_session.mjs --url https://staging.example.com --session session-smoke --cookie \"$REALTIME_SMOKE_COOKIE\" --expect-platform-ready --expect-frame-limit-event",
      "  bun tools/smoke_realtime_session.mjs --mode v1 --url https://staging.example.com --model gpt-4o-realtime-preview --api-key sk-... --cookie \"$REALTIME_SMOKE_COOKIE\" --expect-v1-gate-enabled",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function maybeCheckCapabilities(options, plan) {
  if (!shouldCheckCapabilities(options)) return null;
  if (!options.adminCookie) {
    throw new Error("capabilities preflight requires --cookie or REALTIME_SMOKE_COOKIE");
  }
  const response = await fetch(plan.capabilitiesUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: options.adminCookie,
    },
    redirect: "error",
  });
  const capabilities = await readCapabilitiesEnvelope(response);
  validateCapabilities(capabilities, options);
  if (options.mode === "platform" && !capabilities.realtime_session_platform_smoke_ready) {
    throw new Error("platform capabilities reported realtime_session_platform_smoke_ready=false");
  }
  if (options.mode === "v1" && !capabilities.realtime_session_v1_enabled) {
    throw new Error("platform capabilities reported realtime_session_v1_enabled=false");
  }
  return capabilities;
}

function shouldCheckCapabilities(options) {
  return (
    !options.skipCapabilities &&
    (Boolean(options.adminCookie) ||
      options.expectPlatformGateEnabled ||
      options.expectPlatformGateDisabled ||
      options.expectV1GateEnabled ||
      options.expectV1GateDisabled ||
      options.expectPlatformReady ||
      options.expectV1CutoverReady ||
      options.expectPlatformHeaderBoundary)
  );
}

async function readCapabilitiesEnvelope(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`platform capabilities failed: ${response.status} ${response.statusText}: ${text.slice(0, 1024)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`platform capabilities returned non-JSON response: ${error.message}: ${text.slice(0, 1024)}`);
  }
  if (!body || typeof body !== "object" || body.success !== true || !body.data) {
    throw new Error("platform capabilities did not return a successful {success,data} envelope");
  }
  return summarizeCapabilities(body.data);
}

function summarizeCapabilities(data) {
  return {
    realtime_sessions_do_available: data.realtime_sessions_do_available === true,
    realtime_session_gateway_enabled: data.realtime_session_gateway_enabled === true,
    realtime_session_v1_enabled: data.realtime_session_v1_enabled === true,
    do_websocket_hibernation_compiled: data.do_websocket_hibernation_compiled === true,
    realtime_session_cutover_guards: arrayOfStrings(data.realtime_session_cutover_guards),
    realtime_session_auth_boundary_compiled:
      data.realtime_session_auth_boundary_compiled === true,
    realtime_session_metrics_persisted_compiled:
      data.realtime_session_metrics_persisted_compiled === true,
    realtime_session_control_no_echo_compiled:
      data.realtime_session_control_no_echo_compiled === true,
    realtime_session_upstream_bridge_planner_compiled:
      data.realtime_session_upstream_bridge_planner_compiled === true,
    realtime_session_upstream_channel_planner_compiled:
      data.realtime_session_upstream_channel_planner_compiled === true,
    realtime_session_upstream_bridge_connect_contract_compiled:
      data.realtime_session_upstream_bridge_connect_contract_compiled === true,
    realtime_session_upstream_connect_handoff_compiled:
      data.realtime_session_upstream_connect_handoff_compiled === true,
    realtime_session_upstream_fetch_upgrade_adapter_compiled:
      data.realtime_session_upstream_fetch_upgrade_adapter_compiled === true,
    realtime_session_upstream_bridge_lifecycle_compiled:
      data.realtime_session_upstream_bridge_lifecycle_compiled === true,
    realtime_session_upstream_bridge_frame_guard_compiled:
      data.realtime_session_upstream_bridge_frame_guard_compiled === true,
    realtime_session_upstream_bridge_close_mapping_compiled:
      data.realtime_session_upstream_bridge_close_mapping_compiled === true,
    realtime_session_upstream_bridge_send_failure_guard_compiled:
      data.realtime_session_upstream_bridge_send_failure_guard_compiled === true,
    realtime_session_upstream_bridge_event_trace_compiled:
      data.realtime_session_upstream_bridge_event_trace_compiled === true,
    realtime_session_upstream_bridge_replay_contract_compiled:
      data.realtime_session_upstream_bridge_replay_contract_compiled === true,
    realtime_session_upstream_bridge_backpressure_policy_compiled:
      data.realtime_session_upstream_bridge_backpressure_policy_compiled === true,
    realtime_session_upstream_bridge_backpressure_runtime_compiled:
      data.realtime_session_upstream_bridge_backpressure_runtime_compiled === true,
    realtime_session_upstream_usage_capture_compiled:
      data.realtime_session_upstream_usage_capture_compiled === true,
    realtime_session_billing_presettlement_snapshot_compiled:
      data.realtime_session_billing_presettlement_snapshot_compiled === true,
    realtime_session_billing_settlement_preview_compiled:
      data.realtime_session_billing_settlement_preview_compiled === true,
    realtime_session_billing_settlement_handoff_compiled:
      data.realtime_session_billing_settlement_handoff_compiled === true,
    realtime_session_billing_settlement_mutation_plan_compiled:
      data.realtime_session_billing_settlement_mutation_plan_compiled === true,
    realtime_session_billing_settlement_writer_compiled:
      data.realtime_session_billing_settlement_writer_compiled === true,
    realtime_session_billing_settlement_replay_marker_compiled:
      data.realtime_session_billing_settlement_replay_marker_compiled === true,
    realtime_session_platform_header_boundary_compiled:
      data.realtime_session_platform_header_boundary_compiled === true,
    realtime_session_upstream_bridge_compiled:
      data.realtime_session_upstream_bridge_compiled === true,
    realtime_session_billing_settlement_compiled:
      data.realtime_session_billing_settlement_compiled === true,
    realtime_session_platform_smoke_ready:
      data.realtime_session_platform_smoke_ready === true,
    realtime_session_v1_cutover_ready: data.realtime_session_v1_cutover_ready === true,
  };
}

function validateCapabilities(capabilities, options) {
  for (const [field, expected] of [
    ["do_websocket_hibernation_compiled", true],
    ["realtime_session_auth_boundary_compiled", true],
    ["realtime_session_metrics_persisted_compiled", true],
    ["realtime_session_control_no_echo_compiled", true],
    ["realtime_session_upstream_bridge_planner_compiled", true],
    ["realtime_session_upstream_channel_planner_compiled", true],
    ["realtime_session_upstream_bridge_connect_contract_compiled", true],
    ["realtime_session_upstream_connect_handoff_compiled", true],
    ["realtime_session_upstream_fetch_upgrade_adapter_compiled", true],
    ["realtime_session_upstream_bridge_lifecycle_compiled", true],
    ["realtime_session_upstream_bridge_frame_guard_compiled", true],
    ["realtime_session_upstream_bridge_close_mapping_compiled", true],
    ["realtime_session_upstream_bridge_send_failure_guard_compiled", true],
    ["realtime_session_upstream_bridge_event_trace_compiled", true],
    ["realtime_session_upstream_bridge_replay_contract_compiled", true],
    ["realtime_session_upstream_bridge_backpressure_policy_compiled", true],
    ["realtime_session_upstream_bridge_backpressure_runtime_compiled", true],
    ["realtime_session_upstream_usage_capture_compiled", true],
    ["realtime_session_billing_presettlement_snapshot_compiled", true],
    ["realtime_session_billing_settlement_preview_compiled", true],
    ["realtime_session_billing_settlement_handoff_compiled", true],
    ["realtime_session_billing_settlement_mutation_plan_compiled", true],
    ["realtime_session_billing_settlement_writer_compiled", true],
    ["realtime_session_billing_settlement_replay_marker_compiled", true],
    ["realtime_session_platform_header_boundary_compiled", true],
  ]) {
    if (capabilities[field] !== expected) {
      throw new Error(`platform capabilities ${field}=${capabilities[field]} did not match ${expected}`);
    }
  }
  for (const guard of [
    "platform_gateway_gate",
    "v1_gateway_gate",
    "relay_token_auth",
    "relay_rate_limits",
    "upstream_fetch_upgrade_adapter",
    "upstream_bridge_lifecycle",
    "upstream_bridge_frame_guard",
    "upstream_bridge_close_mapping",
    "upstream_bridge_send_failure_guard",
    "upstream_bridge_event_trace",
    "upstream_bridge_replay_contract",
    "upstream_bridge_backpressure_policy",
    "upstream_bridge_backpressure_runtime",
    "upstream_usage_capture",
    "billing_presettlement_snapshot",
    "billing_settlement_preview",
    "billing_settlement_handoff",
    "billing_settlement_mutation_plan",
    "billing_settlement_writer",
    "billing_settlement_replay_marker",
    "platform_upstream_header_boundary",
    "hibernation_attachment_restore",
    "metadata_only_control_frames",
    "upstream_bridge",
    "billing_settlement",
  ]) {
    if (!capabilities.realtime_session_cutover_guards.includes(guard)) {
      throw new Error(`platform capabilities missing realtime guard ${guard}`);
    }
  }
  if (options.expectPlatformGateEnabled && !capabilities.realtime_session_gateway_enabled) {
    throw new Error("expected realtime_session_gateway_enabled=true");
  }
  if (options.expectPlatformGateDisabled && capabilities.realtime_session_gateway_enabled) {
    throw new Error("expected realtime_session_gateway_enabled=false");
  }
  if (options.expectV1GateEnabled && !capabilities.realtime_session_v1_enabled) {
    throw new Error("expected realtime_session_v1_enabled=true");
  }
  if (options.expectV1GateDisabled && capabilities.realtime_session_v1_enabled) {
    throw new Error("expected realtime_session_v1_enabled=false");
  }
  if (options.expectPlatformReady && !capabilities.realtime_session_platform_smoke_ready) {
    throw new Error("expected realtime_session_platform_smoke_ready=true");
  }
  if (options.expectV1CutoverReady && !capabilities.realtime_session_v1_cutover_ready) {
    throw new Error("expected realtime_session_v1_cutover_ready=true");
  }
}

function normalizeBaseUrl(value) {
  const raw = required(value, "url");
  const url = new URL(raw);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("url must use http, https, ws, or wss");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url;
}

function buildWebSocketUrl(base, pathname, params = {}) {
  const url = new URL(base.toString());
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = pathname;
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildHttpUrl(base, pathname) {
  const url = new URL(base.toString());
  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  url.pathname = pathname;
  return url.toString();
}

function realtimeProtocols(options) {
  if (options.mode !== "v1") return [];
  const apiKey = required(options.apiKey, "api-key");
  return ["realtime", `openai-insecure-api-key.${apiKey}`, "openai-beta.realtime-v1"];
}

function openWebSocket(url, protocols, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = options.headers
      ? new WebSocket(url, protocols, { headers: options.headers })
      : new WebSocket(url, protocols);
    const timeout = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        // Ignore close failures while reporting the original timeout.
      }
      reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket open failed"));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`WebSocket closed before open: ${event.code} ${event.reason}`.trim()));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function waitForJsonMessage(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onMessage = async (event) => {
      try {
        const text = await messageText(event.data);
        const parsed = JSON.parse(text);
        if (predicate(parsed)) {
          cleanup();
          resolve(parsed);
        }
      } catch {
        // Ignore non-JSON frames until the expected control frame arrives.
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for ${label}`));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for ${label}: ${event.code} ${event.reason}`.trim()));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function waitForJsonMessageThenClose(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let matchedMessage = null;
    let closeEvent = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label} and close after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const maybeResolve = () => {
      if (matchedMessage && closeEvent) {
        cleanup();
        resolve({ message: matchedMessage, close: closeEvent });
      }
    };
    const onMessage = async (event) => {
      try {
        const text = await messageText(event.data);
        const parsed = JSON.parse(text);
        if (predicate(parsed)) {
          matchedMessage = parsed;
          maybeResolve();
        }
      } catch {
        // Ignore non-JSON frames until the expected control frame arrives.
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for ${label} and close`));
    };
    const onClose = (event) => {
      closeEvent = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };
      maybeResolve();
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

function validateMetrics(metrics, label, options = {}) {
  const minTextMessageCount = options.minTextMessageCount ?? 2;
  if (!metrics || typeof metrics !== "object") {
    throw new Error(`${label} missing metrics object`);
  }
  for (const key of ["connected_count", "text_message_count", "updated_at_ms"]) {
    if (typeof metrics[key] !== "number") {
      throw new Error(`${label} missing numeric ${key}`);
    }
  }
  if (metrics.connected_count < 1) {
    throw new Error(`${label} did not record a WebSocket connect`);
  }
  if (metrics.text_message_count < minTextMessageCount) {
    throw new Error(`${label} did not record the expected control messages`);
  }
  if (options.expectedBridgeEvent) {
    validateBridgeTerminalEvent(
      metrics.last_bridge_terminal_event,
      options.expectedBridgeEvent,
      options.expectedBridgeFrameBytes,
    );
  }
}

function validateRuntimeStatusCounters(frame, label, options = {}) {
  if (!frame || typeof frame !== "object") {
    throw new Error(`${label} missing runtime status object`);
  }
  const expected = options.expected ?? {};
  for (const key of ["active_upstream_bridges", "queued_upstream_frames", "queued_upstream_bytes"]) {
    if (!Number.isInteger(frame[key]) || frame[key] < 0) {
      throw new Error(`${label} missing non-negative integer ${key}`);
    }
    if (Object.hasOwn(expected, key) && frame[key] !== expected[key]) {
      throw new Error(`${label} ${key}=${frame[key]}, expected ${expected[key]}`);
    }
  }
}

function validateControlFrame(frame, probe) {
  if (!frame || typeof frame !== "object") {
    throw new Error("unsupported-control response missing JSON object");
  }
  if (frame.status !== "upstream_bridge_not_wired") {
    throw new Error(`unsupported-control response has unexpected status: ${frame.status}`);
  }
  if (Object.hasOwn(frame, "received")) {
    throw new Error("unsupported-control response echoed a received payload field");
  }
  const expectedTextBytes = byteLength(probe);
  const expectedTextChars = Array.from(probe).length;
  if (frame.text_bytes !== expectedTextBytes) {
    throw new Error(`unsupported-control response text_bytes=${frame.text_bytes}, expected ${expectedTextBytes}`);
  }
  if (frame.text_chars !== expectedTextChars) {
    throw new Error(`unsupported-control response text_chars=${frame.text_chars}, expected ${expectedTextChars}`);
  }
  if (JSON.stringify(frame).includes(probe)) {
    throw new Error("unsupported-control response echoed the probe text");
  }
}

function forgedRealtimeUpstreamHeaders() {
  const upstreamUrl = "wss://cinatoken-platform-header-boundary.invalid/realtime";
  return {
    [realtimeUpstreamPlanHeader]: JSON.stringify({
      selected_group: "forged-platform-header-boundary",
      channel_id: 0,
      channel_type: 0,
      channel_name: "forged-platform-header-boundary",
      provider: "openai_compatible",
      upstream_url: upstreamUrl,
      request_model: "forged-platform-header-boundary",
      upstream_model: "forged-platform-header-boundary",
      channel_has_custom_base_url: true,
      auth_mode: "authorization_bearer",
      protocol_redacted: [],
      header_names: ["authorization"],
    }),
    [realtimeUpstreamConnectHeader]: JSON.stringify({
      url: upstreamUrl,
      auth_mode: "authorization_bearer",
      protocol: [],
      headers: [
        {
          name: "Authorization",
          value: "Bearer cinatoken-platform-header-boundary-secret",
        },
      ],
    }),
  };
}

function validatePlatformHeaderBoundaryFrames({ pong, statusFrame, controlFrame, httpStatus }) {
  validateNoForgedUpstreamContext(pong?.context, "pong context");
  validateNoForgedUpstreamContext(statusFrame?.context, "websocket status context");
  validateNoForgedUpstreamContext(controlFrame?.context, "control context");
  validateRuntimeStatusCounters(statusFrame, "platform header boundary websocket status", {
    expected: {
      active_upstream_bridges: 0,
      queued_upstream_frames: 0,
      queued_upstream_bytes: 0,
    },
  });

  if (controlFrame.status !== "upstream_bridge_not_wired") {
    throw new Error(`platform header boundary control status=${controlFrame.status}, expected upstream_bridge_not_wired`);
  }

  if (!httpStatus) return;
  if (httpStatus.active_upstream_bridges !== 0) {
    throw new Error(
      `platform header boundary HTTP status active_upstream_bridges=${httpStatus.active_upstream_bridges}, expected 0`,
    );
  }
  if (httpStatus.queued_upstream_frames !== 0) {
    throw new Error(
      `platform header boundary HTTP status queued_upstream_frames=${httpStatus.queued_upstream_frames}, expected 0`,
    );
  }
  if (httpStatus.queued_upstream_bytes !== 0) {
    throw new Error(
      `platform header boundary HTTP status queued_upstream_bytes=${httpStatus.queued_upstream_bytes}, expected 0`,
    );
  }
  if (!Array.isArray(httpStatus.attachments)) {
    throw new Error("platform header boundary HTTP status missing attachments array");
  }
  for (const [index, attachment] of httpStatus.attachments.entries()) {
    validateNoForgedUpstreamContext(attachment, `HTTP attachment[${index}]`);
  }
}

function validateNoForgedUpstreamContext(context, label) {
  if (!context || typeof context !== "object") {
    throw new Error(`${label} missing object`);
  }
  if (context.upstream_connect_handoff !== false) {
    throw new Error(`${label} upstream_connect_handoff=${context.upstream_connect_handoff}, expected false`);
  }
  if (context.upstream !== null && context.upstream !== undefined) {
    throw new Error(`${label} includes caller-supplied upstream plan`);
  }
}

function validateFrameLimitControlFrame(frame, expectedBytes) {
  if (!frame || typeof frame !== "object") {
    throw new Error("frame-limit control response missing JSON object");
  }
  if (frame.status !== "upstream_bridge_frame_too_large") {
    throw new Error(`frame-limit control response has unexpected status: ${frame.status}`);
  }
  if (frame.frame_kind !== "text") {
    throw new Error(`frame-limit control response frame_kind=${frame.frame_kind}, expected text`);
  }
  if (frame.text_bytes !== expectedBytes) {
    throw new Error(`frame-limit control response text_bytes=${frame.text_bytes}, expected ${expectedBytes}`);
  }
  if (frame.text_chars !== expectedBytes) {
    throw new Error(`frame-limit control response text_chars=${frame.text_chars}, expected ${expectedBytes}`);
  }
  if (frame.max_bytes !== maxRealtimeBridgeTextFrameBytes) {
    throw new Error(
      `frame-limit control response max_bytes=${frame.max_bytes}, expected ${maxRealtimeBridgeTextFrameBytes}`,
    );
  }
  if (Object.hasOwn(frame, "received")) {
    throw new Error("frame-limit control response echoed a received payload field");
  }
  if (JSON.stringify(frame).includes(frameLimitProbePrefix)) {
    throw new Error("frame-limit control response echoed the oversized probe text");
  }
}

function validateFrameLimitClose(close) {
  if (!close || typeof close !== "object") {
    throw new Error("frame-limit close event missing object");
  }
  if (close.code !== 1009) {
    throw new Error(`frame-limit close code=${close.code}, expected 1009`);
  }
  if (close.reason !== "upstream_bridge_frame_too_large") {
    throw new Error(`frame-limit close reason=${close.reason}, expected upstream_bridge_frame_too_large`);
  }
}

function validateBridgeTerminalEvent(event, expectedEvent, expectedFrameBytes) {
  validateBridgeTerminalEventExpectation(
    event,
    bridgeReplayExpectationForEvent(expectedEvent, expectedFrameBytes),
  );
}

function bridgeReplayExpectationForEvent(expectedEvent, expectedFrameBytes) {
  if (expectedEvent === "frame_too_large") {
    return {
      name: "frame_too_large_text",
      event: "frame_too_large",
      direction: "bridge",
      clientCode: 1009,
      clientReason: "upstream_bridge_frame_too_large",
      upstreamCode: 1009,
      upstreamReason: "upstream_bridge_frame_too_large",
      upstreamCloseCode: null,
      frameKind: "text",
      frameBytes: expectedFrameBytes,
      frameMaxBytes: maxRealtimeBridgeTextFrameBytes,
    };
  }
  throw new Error(`unsupported bridge terminal event expectation: ${expectedEvent}`);
}

function validateBridgeTerminalEventExpectation(event, expectation) {
  if (!event || typeof event !== "object") {
    throw new Error(`missing bridge terminal event for ${expectation.name}`);
  }
  for (const [field, expected] of [
    ["event", expectation.event],
    ["direction", expectation.direction],
    ["client_code", expectation.clientCode],
    ["client_reason", expectation.clientReason],
    ["upstream_code", expectation.upstreamCode ?? null],
    ["upstream_reason", expectation.upstreamReason ?? null],
    ["upstream_close_code", expectation.upstreamCloseCode ?? null],
    ["frame_kind", expectation.frameKind ?? null],
    ["frame_bytes", expectation.frameBytes ?? null],
    ["frame_max_bytes", expectation.frameMaxBytes ?? null],
  ]) {
    const actual = event[field] ?? null;
    if (actual !== expected) {
      throw new Error(
        `bridge terminal event ${expectation.name} ${field}=${actual}, expected ${expected}`,
      );
    }
  }
  if (typeof event.occurred_at_ms !== "number") {
    throw new Error(`bridge terminal event ${expectation.name} missing occurred_at_ms`);
  }
  const raw = JSON.stringify(event);
  for (const leaked of [frameLimitProbePrefix, bridgeReplayLeakProbe, "openai-insecure-api-key."]) {
    if (raw.includes(leaked)) {
      throw new Error(`bridge terminal event ${expectation.name} leaked raw probe or protocol secret`);
    }
  }
}

function runBridgeReplayContractSelfTest() {
  const cases = bridgeReplayContractExpectations();
  for (const expectation of cases) {
    validateBridgeTerminalEventExpectation(syntheticBridgeTerminalEvent(expectation), expectation);
  }

  expectBridgeReplayFailure(
    {
      ...syntheticBridgeTerminalEvent(cases[0]),
      leaked_probe: bridgeReplayLeakProbe,
    },
    cases[0],
    "leaked raw probe",
  );
  expectBridgeReplayFailure(
    {
      ...syntheticBridgeTerminalEvent(cases[1]),
      leaked_protocol: "openai-insecure-api-key.synthetic",
    },
    cases[1],
    "leaked raw probe",
  );

  return {
    ok: true,
    bridgeReplayContractSelfTest: true,
    cases: cases.map((item) => ({
      name: item.name,
      event: item.event,
      direction: item.direction,
      clientCode: item.clientCode,
      clientReason: item.clientReason,
      upstreamCode: item.upstreamCode ?? null,
      upstreamReason: item.upstreamReason ?? null,
      upstreamCloseCode: item.upstreamCloseCode ?? null,
      frameKind: item.frameKind ?? null,
      frameBytes: item.frameBytes ?? null,
      frameMaxBytes: item.frameMaxBytes ?? null,
    })),
  };
}

function bridgeReplayContractExpectations() {
  return [
    {
      name: "upstream_closed_normal",
      event: "upstream_closed",
      direction: "upstream_to_client",
      clientCode: 1000,
      clientReason: "upstream_bridge_closed",
      upstreamCloseCode: 1000,
    },
    {
      name: "upstream_closed_reserved_code",
      event: "upstream_closed",
      direction: "upstream_to_client",
      clientCode: 1011,
      clientReason: "upstream_bridge_closed",
      upstreamCloseCode: 1006,
    },
    {
      name: "upstream_closed_application_code",
      event: "upstream_closed",
      direction: "upstream_to_client",
      clientCode: 4000,
      clientReason: "upstream_bridge_closed",
      upstreamCloseCode: 4000,
    },
    {
      name: "upstream_error",
      event: "upstream_error",
      direction: "upstream_to_client",
      clientCode: 1011,
      clientReason: "upstream_bridge_error",
    },
    {
      name: "upstream_event_stream_failed",
      event: "upstream_event_stream_failed",
      direction: "upstream_to_client",
      clientCode: 1011,
      clientReason: "upstream_bridge_event_stream_failed",
    },
    {
      name: "upstream_accept_failed",
      event: "upstream_accept_failed",
      direction: "upstream_to_client",
      clientCode: 1011,
      clientReason: "upstream_bridge_accept_failed",
    },
    {
      name: "client_to_upstream_send_failed_text",
      event: "client_to_upstream_send_failed",
      direction: "client_to_upstream",
      clientCode: 1011,
      clientReason: "upstream_bridge_forward_failed",
      upstreamCode: 1011,
      upstreamReason: "upstream_bridge_forward_failed",
      frameKind: "text",
      frameBytes: 32,
    },
    {
      name: "upstream_to_client_send_failed_binary",
      event: "upstream_to_client_send_failed",
      direction: "upstream_to_client",
      clientCode: 1011,
      clientReason: "client_bridge_forward_failed",
      upstreamCode: 1011,
      upstreamReason: "client_bridge_forward_failed",
      frameKind: "binary",
      frameBytes: 32,
    },
    {
      name: "backpressure_overflow_text",
      event: "backpressure_overflow",
      direction: "bridge",
      clientCode: 1011,
      clientReason: "upstream_bridge_backpressure_overflow",
      upstreamCode: 1011,
      upstreamReason: "upstream_bridge_backpressure_overflow",
      frameKind: "text",
      frameBytes: 1024,
    },
    bridgeReplayExpectationForEvent("frame_too_large", defaultFrameLimitProbeBytes),
  ];
}

function syntheticBridgeTerminalEvent(expectation) {
  return {
    event: expectation.event,
    direction: expectation.direction,
    occurred_at_ms: 1_788_192_000_000,
    client_code: expectation.clientCode,
    client_reason: expectation.clientReason,
    upstream_code: expectation.upstreamCode ?? null,
    upstream_reason: expectation.upstreamReason ?? null,
    upstream_close_code: expectation.upstreamCloseCode ?? null,
    frame_kind: expectation.frameKind ?? null,
    frame_bytes: expectation.frameBytes ?? null,
    frame_max_bytes: expectation.frameMaxBytes ?? null,
  };
}

function expectBridgeReplayFailure(event, expectation, messagePart) {
  try {
    validateBridgeTerminalEventExpectation(event, expectation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(messagePart)) {
      throw new Error(`unexpected bridge replay self-test failure: ${message}`);
    }
    return;
  }
  throw new Error(`expected bridge replay self-test to fail for ${expectation.name}`);
}

function runUpstreamReplayContractSelfTest() {
  const scenarios = upstreamReplayContractScenarios();
  const cases = [];
  for (const scenario of scenarios) {
    const replay = syntheticUpstreamReplay(scenario);
    validateUpstreamReplayScenario(replay, scenario);
    cases.push({
      name: scenario.name,
      ok: true,
      terminalEvent: scenario.terminal.name,
      clientClose: {
        code: scenario.terminal.clientCode,
        reason: scenario.terminal.clientReason,
      },
      forwardedFrames: scenario.forwardedFrames.length,
    });
  }

  const clean = syntheticUpstreamReplay(scenarios[0]);
  expectUpstreamReplayFailure(
    {
      ...clean,
      bridgeStatusBeforeTerminal: "upstream_bridge_not_active",
    },
    scenarios[0],
    "before terminal status",
    "rejects inactive bridge before terminal event",
  );
  expectUpstreamReplayFailure(
    {
      ...clean,
      persistedTerminalEvent: null,
    },
    scenarios[0],
    "missing persisted terminal event",
    "requires persisted terminal event",
  );
  expectUpstreamReplayFailure(
    {
      ...clean,
      clientClose: {
        code: 1000,
        reason: "wrong_close_reason",
      },
    },
    scenarios[0],
    "client close reason",
    "rejects wrong client close",
  );
  expectUpstreamReplayFailure(
    {
      ...clean,
      forwardedFrames: [
        {
          ...clean.forwardedFrames[0],
          rawPayload: upstreamReplayLeakProbe,
        },
      ],
    },
    scenarios[0],
    "leaked raw probe",
    "rejects raw payload leakage",
  );

  return {
    ok: true,
    upstreamReplayContractSelfTest: true,
    cases,
  };
}

function upstreamReplayContractScenarios() {
  const expectations = new Map(
    bridgeReplayContractExpectations().map((expectation) => [expectation.name, expectation]),
  );
  const expectation = (name) => {
    const item = expectations.get(name);
    if (!item) throw new Error(`missing upstream replay expectation: ${name}`);
    return item;
  };
  return [
    {
      name: "client_text_then_upstream_normal_close",
      forwardedFrames: [{ direction: "client_to_upstream", kind: "text", bytes: 32 }],
      terminal: expectation("upstream_closed_normal"),
    },
    {
      name: "client_binary_then_upstream_reserved_close",
      forwardedFrames: [{ direction: "client_to_upstream", kind: "binary", bytes: 16 }],
      terminal: expectation("upstream_closed_reserved_code"),
    },
    {
      name: "client_text_then_upstream_error",
      forwardedFrames: [{ direction: "client_to_upstream", kind: "text", bytes: 48 }],
      terminal: expectation("upstream_error"),
    },
    {
      name: "upstream_oversized_text_frame",
      forwardedFrames: [{ direction: "upstream_to_client", kind: "text", bytes: defaultFrameLimitProbeBytes }],
      terminal: bridgeReplayExpectationForEvent("frame_too_large", defaultFrameLimitProbeBytes),
    },
    {
      name: "upstream_binary_send_failure",
      forwardedFrames: [{ direction: "upstream_to_client", kind: "binary", bytes: 32 }],
      terminal: expectation("upstream_to_client_send_failed_binary"),
    },
  ];
}

function syntheticUpstreamReplay(scenario) {
  const terminalEvent = syntheticBridgeTerminalEvent(scenario.terminal);
  return {
    scenario: scenario.name,
    bridgeStatusBeforeTerminal: "upstream_bridge_active",
    forwardedFrames: scenario.forwardedFrames.map((frame) => ({ ...frame })),
    terminalEvent,
    clientClose: {
      code: scenario.terminal.clientCode,
      reason: scenario.terminal.clientReason,
    },
    bridgeStatusAfterTerminal: "upstream_bridge_not_active",
    persistedTerminalEvent: { ...terminalEvent },
  };
}

function validateUpstreamReplayScenario(replay, scenario) {
  if (!replay || typeof replay !== "object") {
    throw new Error(`missing upstream replay scenario ${scenario.name}`);
  }
  if (replay.bridgeStatusBeforeTerminal !== "upstream_bridge_active") {
    throw new Error(
      `upstream replay ${scenario.name} before terminal status=${replay.bridgeStatusBeforeTerminal}, expected upstream_bridge_active`,
    );
  }
  if (replay.bridgeStatusAfterTerminal !== "upstream_bridge_not_active") {
    throw new Error(
      `upstream replay ${scenario.name} after terminal status=${replay.bridgeStatusAfterTerminal}, expected upstream_bridge_not_active`,
    );
  }
  validateUpstreamReplayForwardedFrames(replay.forwardedFrames, scenario);
  validateBridgeTerminalEventExpectation(replay.terminalEvent, scenario.terminal);
  if (!replay.persistedTerminalEvent) {
    throw new Error(`upstream replay ${scenario.name} missing persisted terminal event`);
  }
  validateBridgeTerminalEventExpectation(replay.persistedTerminalEvent, scenario.terminal);
  if (replay.clientClose?.code !== scenario.terminal.clientCode) {
    throw new Error(
      `upstream replay ${scenario.name} client close code=${replay.clientClose?.code}, expected ${scenario.terminal.clientCode}`,
    );
  }
  if (replay.clientClose?.reason !== scenario.terminal.clientReason) {
    throw new Error(
      `upstream replay ${scenario.name} client close reason=${replay.clientClose?.reason}, expected ${scenario.terminal.clientReason}`,
    );
  }
  const raw = JSON.stringify(replay);
  for (const leaked of [
    upstreamReplayLeakProbe,
    bridgeReplayLeakProbe,
    frameLimitProbePrefix,
    "openai-insecure-api-key.",
  ]) {
    if (raw.includes(leaked)) {
      throw new Error(`upstream replay ${scenario.name} leaked raw probe or protocol secret`);
    }
  }
}

function validateUpstreamReplayForwardedFrames(frames, scenario) {
  if (!Array.isArray(frames)) {
    throw new Error(`upstream replay ${scenario.name} missing forwarded frame array`);
  }
  if (frames.length !== scenario.forwardedFrames.length) {
    throw new Error(
      `upstream replay ${scenario.name} forwarded frame count=${frames.length}, expected ${scenario.forwardedFrames.length}`,
    );
  }
  for (const [index, expected] of scenario.forwardedFrames.entries()) {
    const frame = frames[index] || {};
    for (const field of ["direction", "kind", "bytes"]) {
      if (frame[field] !== expected[field]) {
        throw new Error(
          `upstream replay ${scenario.name} forwarded frame[${index}] ${field}=${frame[field]}, expected ${expected[field]}`,
        );
      }
    }
    if ("rawPayload" in frame || "payload" in frame) {
      throw new Error(`upstream replay ${scenario.name} forwarded frame[${index}] leaked raw probe`);
    }
  }
}

function expectUpstreamReplayFailure(replay, scenario, messagePart, name) {
  try {
    validateUpstreamReplayScenario(replay, scenario);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(messagePart)) {
      throw new Error(`unexpected upstream replay self-test failure for ${name}: ${message}`);
    }
    return;
  }
  throw new Error(`expected upstream replay self-test to fail for ${name}`);
}

function runPlatformHeaderBoundarySelfTest() {
  const cleanContext = {
    session: "session-smoke",
    entrypoint: "platform_realtime_gateway",
    auth_state: "platform_gateway",
    upstream: null,
    upstream_connect_handoff: false,
  };
  const cleanFrames = {
    pong: { context: cleanContext },
    statusFrame: {
      context: cleanContext,
      active_upstream_bridges: 0,
      queued_upstream_frames: 0,
      queued_upstream_bytes: 0,
    },
    controlFrame: {
      status: "upstream_bridge_not_wired",
      context: cleanContext,
    },
    httpStatus: {
      active_upstream_bridges: 0,
      queued_upstream_frames: 0,
      queued_upstream_bytes: 0,
      attachments: [cleanContext],
    },
  };
  validatePlatformHeaderBoundaryFrames(cleanFrames);

  const cases = [
    {
      name: "clean_boundary",
      ok: true,
    },
    expectPlatformHeaderBoundaryFailure(
      {
        ...cleanFrames,
        pong: {
          context: {
            ...cleanContext,
            upstream_connect_handoff: true,
          },
        },
      },
      "upstream_connect_handoff=true",
      "forged handoff marker",
    ),
    expectPlatformHeaderBoundaryFailure(
      {
        ...cleanFrames,
        statusFrame: {
          context: {
            ...cleanContext,
            upstream: { channel_id: 1 },
          },
          active_upstream_bridges: 0,
          queued_upstream_frames: 0,
          queued_upstream_bytes: 0,
        },
      },
      "includes caller-supplied upstream plan",
      "forged upstream plan",
    ),
    expectPlatformHeaderBoundaryFailure(
      {
        ...cleanFrames,
        controlFrame: {
          status: "upstream_bridge_active",
          context: cleanContext,
        },
      },
      "expected upstream_bridge_not_wired",
      "active bridge status",
    ),
    expectPlatformHeaderBoundaryFailure(
      {
        ...cleanFrames,
        httpStatus: {
          active_upstream_bridges: 1,
          queued_upstream_frames: 0,
          queued_upstream_bytes: 0,
          attachments: [cleanContext],
        },
      },
      "expected 0",
      "active upstream bridge count",
    ),
  ];

  return {
    ok: true,
    platformHeaderBoundarySelfTest: true,
    cases,
  };
}

function expectPlatformHeaderBoundaryFailure(frames, messagePart, name) {
  try {
    validatePlatformHeaderBoundaryFrames(frames);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(messagePart)) {
      throw new Error(`unexpected platform header-boundary self-test failure: ${message}`);
    }
    return { name, ok: true };
  }
  throw new Error(`expected platform header-boundary self-test to fail for ${name}`);
}

function summarizeMetrics(metrics) {
  return {
    session: metrics.session,
    connectedCount: metrics.connected_count,
    textMessageCount: metrics.text_message_count,
    binaryMessageCount: metrics.binary_message_count,
    closedCount: metrics.closed_count,
    errorCount: metrics.error_count,
    lastEntrypoint: metrics.last_entrypoint,
    lastModel: metrics.last_model,
    lastTokenSource: metrics.last_token_source,
    lastAuthState: metrics.last_auth_state,
    lastBridgeTerminalEvent: metrics.last_bridge_terminal_event
      ? summarizeBridgeTerminalEvent(metrics.last_bridge_terminal_event)
      : null,
  };
}

function summarizeControlFrame(frame) {
  return {
    status: frame.status,
    textBytes: frame.text_bytes,
    textChars: frame.text_chars,
    rawProbeEchoed: false,
  };
}

function summarizePlatformHeaderBoundary({ headers, pong, statusFrame, controlFrame, httpStatus }) {
  return {
    forgedHeaderNames: Object.keys(headers || {}),
    pong: summarizeBoundaryContext(pong.context),
    websocketStatus: summarizeBoundaryContext(statusFrame.context),
    control: {
      status: controlFrame.status,
      ...summarizeBoundaryContext(controlFrame.context),
    },
    httpStatus: httpStatus
      ? {
          activeUpstreamBridges: httpStatus.active_upstream_bridges,
          queuedUpstreamFrames: httpStatus.queued_upstream_frames,
          queuedUpstreamBytes: httpStatus.queued_upstream_bytes,
          attachments: httpStatus.attachments.map(summarizeBoundaryContext),
        }
      : null,
  };
}

function summarizeBoundaryContext(context) {
  return {
    session: context.session,
    entrypoint: context.entrypoint,
    authState: context.auth_state,
    upstreamConnectHandoff: context.upstream_connect_handoff,
    upstreamPresent: context.upstream !== null && context.upstream !== undefined,
  };
}

function summarizeFrameLimitControlFrame(frame) {
  return {
    status: frame.status,
    frameKind: frame.frame_kind,
    textBytes: frame.text_bytes,
    textChars: frame.text_chars,
    maxBytes: frame.max_bytes,
    rawProbeEchoed: false,
  };
}

function summarizeRuntimeStatus(frame) {
  return {
    activeUpstreamBridges: frame.active_upstream_bridges,
    queuedUpstreamFrames: frame.queued_upstream_frames,
    queuedUpstreamBytes: frame.queued_upstream_bytes,
  };
}

function summarizeBridgeTerminalEvent(event) {
  return {
    event: event.event,
    direction: event.direction,
    clientCode: event.client_code,
    clientReason: event.client_reason,
    upstreamCode: event.upstream_code ?? null,
    upstreamReason: event.upstream_reason ?? null,
    upstreamCloseCode: event.upstream_close_code ?? null,
    frameKind: event.frame_kind ?? null,
    frameBytes: event.frame_bytes ?? null,
    frameMaxBytes: event.frame_max_bytes ?? null,
  };
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "")).filter(Boolean)
    : [];
}

function optionalHeaderValue(value, name) {
  if (!value) return "";
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain newlines`);
  }
  return value;
}

function validateSessionName(value) {
  const session = validatePlainValue(value, "session").toLowerCase();
  if (session.length > 96 || !/^[a-z0-9_-]+$/.test(session)) {
    throw new Error("session must be 1-96 chars of letters, digits, underscore, or dash");
  }
  return session;
}

function validateFrameLimitBytes(value) {
  if (!Number.isFinite(value)) return defaultFrameLimitProbeBytes;
  if (!Number.isInteger(value)) {
    throw new Error("frame-limit-bytes must be an integer");
  }
  if (value <= maxRealtimeBridgeTextFrameBytes) {
    throw new Error(`frame-limit-bytes must be greater than ${maxRealtimeBridgeTextFrameBytes}`);
  }
  if (value > maxRealtimeBridgeTextFrameBytes * 2) {
    throw new Error(`frame-limit-bytes must be at most ${maxRealtimeBridgeTextFrameBytes * 2}`);
  }
  if (value <= byteLength(frameLimitProbePrefix)) {
    throw new Error("frame-limit-bytes must be larger than the fixed smoke probe prefix");
  }
  return value;
}

function makeFrameLimitProbe(bytes) {
  return `${frameLimitProbePrefix}${"x".repeat(bytes - byteLength(frameLimitProbePrefix))}`;
}

function validatePlainValue(value, name) {
  const trimmed = required(value, name);
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

function redactProtocol(value) {
  return value.startsWith("openai-insecure-api-key.")
    ? "openai-insecure-api-key.<redacted>"
    : value;
}

function redactUrl(value) {
  const url = new URL(value);
  if (url.searchParams.has("key")) {
    url.searchParams.set("key", "<redacted>");
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
      result.dryRun ? "Realtime session smoke plan (dry-run)" : "Realtime session smoke result",
      `mode: ${result.mode}`,
      `ws_url: ${redactUrl(result.wsUrl)}`,
      ...(result.statusUrl ? [`status_url: ${redactUrl(result.statusUrl)}`] : []),
      ...(result.protocols?.length ? [`protocols: ${result.protocols.join(", ")}`] : []),
      ...(result.websocketMetrics
        ? [`websocket_metrics: ${JSON.stringify(result.websocketMetrics)}`]
        : []),
      ...(result.httpMetrics ? [`http_metrics: ${JSON.stringify(result.httpMetrics)}`] : []),
      ...(result.controlFrame ? [`control_frame: ${JSON.stringify(result.controlFrame)}`] : []),
      ...(result.frameLimitControlFrame
        ? [`frame_limit_control_frame: ${JSON.stringify(result.frameLimitControlFrame)}`]
        : []),
      ...(result.frameLimitClose ? [`frame_limit_close: ${JSON.stringify(result.frameLimitClose)}`] : []),
      ...(result.bridgeTerminalEvent
        ? [`bridge_terminal_event: ${JSON.stringify(result.bridgeTerminalEvent)}`]
        : []),
      ...(result.platformHeaderBoundary
        ? [`platform_header_boundary: ${JSON.stringify(result.platformHeaderBoundary)}`]
        : []),
      ...(typeof result.probeConfigured === "boolean"
        ? [`probe_configured: ${result.probeConfigured}`]
        : []),
      ...(typeof result.probeBytes === "number" ? [`probe_bytes: ${result.probeBytes}`] : []),
      ...(typeof result.frameLimitProbeBytes === "number"
        ? [`frame_limit_probe_bytes: ${result.frameLimitProbeBytes}`]
        : []),
      ...(typeof result.expectPlatformHeaderBoundary === "boolean"
        ? [`expect_platform_header_boundary: ${result.expectPlatformHeaderBoundary}`]
        : []),
      ...(result.forgedUpstreamHeaderNames?.length
        ? [`forged_upstream_header_names: ${result.forgedUpstreamHeaderNames.join(", ")}`]
        : []),
      ...(result.notes?.length ? ["notes:", ...result.notes.map((note) => `  - ${note}`)] : []),
    ].join("\n"),
  );
}

function printBridgeReplaySelfTestResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "Realtime bridge replay contract self-test",
      `ok: ${result.ok}`,
      ...result.cases.map(
        (item) =>
          `case ${item.name}: ${item.event} ${item.direction} ${item.clientCode}/${item.clientReason}`,
      ),
    ].join("\n"),
  );
}

function printUpstreamReplaySelfTestResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "Realtime upstream replay contract self-test",
      `ok: ${result.ok}`,
      ...result.cases.map(
        (item) =>
          `case ${item.name}: ${item.terminalEvent} ${item.clientClose.code}/${item.clientClose.reason}`,
      ),
    ].join("\n"),
  );
}

function printPlatformHeaderBoundarySelfTestResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      "Realtime platform header-boundary self-test",
      `ok: ${result.ok}`,
      ...result.cases.map((item) => `case ${item.name}: ${item.ok ? "ok" : "failed"}`),
    ].join("\n"),
  );
}
