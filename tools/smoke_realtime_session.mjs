#!/usr/bin/env bun

const defaultSession = "session-smoke";
const defaultModel = "gpt-4o-realtime-preview";
const defaultTimeoutMs = 10_000;
const defaultProbe = "cinatoken realtime smoke probe";
const maxRealtimeBridgeTextFrameBytes = 1_048_576;
const defaultFrameLimitProbeBytes = maxRealtimeBridgeTextFrameBytes + 1;
const frameLimitProbePrefix = "cinatoken-frame-limit-smoke:";
const bridgeReplayLeakProbe = "cinatoken-bridge-replay-secret";

const args = parseArgs(process.argv.slice(2));

try {
  if (args.flags.has("self-test-bridge-replay")) {
    printBridgeReplaySelfTestResult(runBridgeReplayContractSelfTest(), args.flags.has("json"));
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
  const ws = await openWebSocket(plan.wsUrl, plan.protocols, options.timeoutMs);
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
      controlFrame: controlFrame ? summarizeControlFrame(controlFrame) : null,
      frameLimitControlFrame: frameLimitControlFrame
        ? summarizeFrameLimitControlFrame(frameLimitControlFrame)
        : null,
      frameLimitClose,
      bridgeTerminalEvent: httpStatus?.metrics?.last_bridge_terminal_event
        ? summarizeBridgeTerminalEvent(httpStatus.metrics.last_bridge_terminal_event)
        : null,
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
    timeoutMs: options.timeoutMs,
    probeConfigured: Boolean(options.probe),
    probeBytes: byteLength(options.probe),
    frameLimitProbeBytes: options.expectFrameLimitEvent ? options.frameLimitBytes : null,
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
    "self-test-bridge-replay",
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
      "  --frame-limit-bytes <bytes>      or REALTIME_SMOKE_FRAME_LIMIT_BYTES, default 1048577",
      "  --self-test-bridge-replay        Run local synthetic close/error/send-failure replay contract tests without network",
      "  --dry-run             resolve URLs/protocols without network",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_realtime_session.mjs --dry-run --url http://127.0.0.1:8787 --json",
      "  bun tools/smoke_realtime_session.mjs --url https://staging.example.com --session session-smoke --cookie \"$REALTIME_SMOKE_COOKIE\" --expect-platform-ready",
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
      options.expectV1CutoverReady)
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

function openWebSocket(url, protocols, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
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
      ...(typeof result.probeConfigured === "boolean"
        ? [`probe_configured: ${result.probeConfigured}`]
        : []),
      ...(typeof result.probeBytes === "number" ? [`probe_bytes: ${result.probeBytes}`] : []),
      ...(typeof result.frameLimitProbeBytes === "number"
        ? [`frame_limit_probe_bytes: ${result.frameLimitProbeBytes}`]
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
