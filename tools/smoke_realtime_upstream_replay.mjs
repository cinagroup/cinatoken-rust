#!/usr/bin/env bun

const defaultModel = "gpt-4o-realtime-preview";
const defaultProbe = "cinatoken realtime upstream replay probe";
const defaultTimeoutMs = 10_000;
const defaultMockHost = "127.0.0.1";
const defaultMockPort = 8799;
const defaultMockPath = "/v1/realtime";
const defaultSeedId = 910_001;
const defaultSeedUsername = "realtime-mock-smoke";
const defaultSeedGroup = "default";
const defaultSeedTokenKey = "sk-cinatoken-realtime-mock-local";
const openaiCompatibleChannelType = 1;
const maxRealtimeBridgeTextFrameBytes = 1_048_576;
const upstreamReplayProbePrefix = "cinatoken-upstream-live-frame-limit:";
const usageReplayCloseProbe = "cinatoken realtime usage replay close";
const expectedResponseDoneUsage = {
  source_event: "response.done",
  prompt_tokens: 1200,
  completion_tokens: 350,
  total_tokens: 1550,
  cached_tokens: 400,
  audio_input_tokens: 180,
  audio_output_tokens: 90,
};
const responseDoneUsageFrame = JSON.stringify({
  type: "response.done",
  response: {
    usage: {
      input_tokens: expectedResponseDoneUsage.prompt_tokens,
      output_tokens: expectedResponseDoneUsage.completion_tokens,
      total_tokens: expectedResponseDoneUsage.total_tokens,
      input_token_details: {
        cached_tokens: expectedResponseDoneUsage.cached_tokens,
        audio_tokens: expectedResponseDoneUsage.audio_input_tokens,
      },
      output_token_details: {
        audio_tokens: expectedResponseDoneUsage.audio_output_tokens,
      },
    },
  },
});

const scenarios = new Map(
  [
    {
      name: "upstream-normal-close",
      mockAction: "close_after_first_client_frame",
      closeCode: 1000,
      closeReason: "mock_upstream_normal_close",
      expectedEvent: {
        event: "upstream_closed",
        direction: "upstream_to_client",
        clientCode: 1000,
        clientReason: "upstream_bridge_closed",
        upstreamCloseCode: 1000,
      },
    },
    {
      name: "upstream-frame-limit",
      mockAction: "send_oversized_text_after_first_client_frame",
      upstreamFrameBytes: maxRealtimeBridgeTextFrameBytes + 1,
      expectedEvent: {
        event: "frame_too_large",
        direction: "bridge",
        clientCode: 1009,
        clientReason: "upstream_bridge_frame_too_large",
        upstreamCode: 1009,
        upstreamReason: "upstream_bridge_frame_too_large",
        frameKind: "text",
        frameBytes: maxRealtimeBridgeTextFrameBytes + 1,
        frameMaxBytes: maxRealtimeBridgeTextFrameBytes,
      },
    },
    {
      name: "startup-queue-drain",
      mockAction: "close_after_first_client_frame",
      closeCode: 1000,
      closeReason: "mock_upstream_startup_queue_drain",
      queueProbe: true,
      queueProbeDelayMs: 500,
      expectedEvent: {
        event: "upstream_closed",
        direction: "upstream_to_client",
        clientCode: 1000,
        clientReason: "upstream_bridge_closed",
        upstreamCloseCode: 1000,
      },
    },
    {
      name: "response-done-usage",
      mockAction: "send_response_done_usage_after_first_client_frame",
      closeCode: 1000,
      closeReason: "mock_upstream_response_done_usage",
      closeAfterSecondClientFrame: true,
      expectUsageCapture: true,
      expectedUsage: expectedResponseDoneUsage,
      expectedEvent: {
        event: "upstream_closed",
        direction: "upstream_to_client",
        clientCode: 1000,
        clientReason: "upstream_bridge_closed",
        upstreamCloseCode: 1000,
      },
    },
    {
      name: "upstream-event-stream-failed",
      mockFault: "event_stream_failed",
      skipRuntimeStatus: true,
      skipProbe: true,
      expectForwardedClientFrame: false,
      expectedEvent: {
        event: "upstream_event_stream_failed",
        direction: "upstream_to_client",
        clientCode: 1011,
        clientReason: "upstream_bridge_event_stream_failed",
      },
    },
    {
      name: "upstream-accept-failed",
      mockFault: "accept_failed",
      skipRuntimeStatus: true,
      skipProbe: true,
      expectForwardedClientFrame: false,
      expectedEvent: {
        event: "upstream_accept_failed",
        direction: "upstream_to_client",
        clientCode: 1011,
        clientReason: "upstream_bridge_accept_failed",
      },
    },
  ].map((scenario) => [scenario.name, scenario]),
);

const plannedFaultScenarios = [
  {
    name: "upstream-error",
    reason: "requires an upstream socket abort/error injection that does not become a normal close",
  },
  {
    name: "upstream-to-client-send-failure",
    reason: "requires forcing client send failure while preserving terminal evidence",
  },
];

const args = parseArgs(process.argv.slice(2));

try {
  if (args.flags.has("self-test")) {
    printResult(runSelfTest(), args.flags.has("json"));
  } else {
    const options = normalizeOptions(args);
    const plan = buildPlan(options);
    const result = options.dryRun ? redactedPlan(plan) : await runLiveReplay(options, plan);
    printResult(result, options.json);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set(["dry-run", "json", "self-test", "external-mock", "confirm-live"]);
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

function normalizeOptions(parsed) {
  const value = (name, envName) => parsed.values.get(name) || process.env[envName];
  const scenarioName = value("scenario", "REALTIME_UPSTREAM_REPLAY_SCENARIO") || "upstream-normal-close";
  const scenario = scenarios.get(scenarioName);
  if (!scenario) {
    throw new Error(`scenario must be one of: ${Array.from(scenarios.keys()).join(", ")}`);
  }
  const timeoutMs = Number.parseInt(
    value("timeout-ms", "REALTIME_UPSTREAM_REPLAY_TIMEOUT_MS") || "",
    10,
  );
  const mockPort = Number.parseInt(value("mock-port", "REALTIME_UPSTREAM_REPLAY_MOCK_PORT") || "", 10);
  const mockHost = value("mock-host", "REALTIME_UPSTREAM_REPLAY_MOCK_HOST") || defaultMockHost;
  const mockPath = value("mock-path", "REALTIME_UPSTREAM_REPLAY_MOCK_PATH") || defaultMockPath;
  const mockBaseUrl =
    value("mock-base-url", "REALTIME_UPSTREAM_REPLAY_MOCK_BASE_URL") ||
    `http://${mockHost}:${Number.isInteger(mockPort) && mockPort > 0 ? mockPort : defaultMockPort}`;
  const dryRun = parsed.flags.has("dry-run");
  const externalMock = parsed.flags.has("external-mock");
  if (!dryRun && !parsed.flags.has("confirm-live")) {
    throw new Error("live upstream replay requires --confirm-live");
  }
  return {
    url: value("url", "REALTIME_UPSTREAM_REPLAY_URL"),
    apiKey: value("api-key", "REALTIME_UPSTREAM_REPLAY_API_KEY") || "",
    model: validatePlainValue(value("model", "REALTIME_UPSTREAM_REPLAY_MODEL") || defaultModel, "model"),
    probe: validatePlainValue(value("probe", "REALTIME_UPSTREAM_REPLAY_PROBE") || defaultProbe, "probe"),
    scenario,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs,
    mockHost,
    mockPort: Number.isInteger(mockPort) && mockPort > 0 ? mockPort : defaultMockPort,
    mockPath: validatePath(mockPath, "mock-path"),
    mockBaseUrl: normalizeHttpBaseUrl(mockBaseUrl, "mock-base-url"),
    expectedChannelBaseUrl: value(
      "expected-channel-base-url",
      "REALTIME_UPSTREAM_REPLAY_EXPECTED_CHANNEL_BASE_URL",
    ),
    seedUserId: validatePositiveInteger(
      value("seed-user-id", "REALTIME_UPSTREAM_REPLAY_SEED_USER_ID") || String(defaultSeedId),
      "seed-user-id",
    ),
    seedTokenId: validatePositiveInteger(
      value("seed-token-id", "REALTIME_UPSTREAM_REPLAY_SEED_TOKEN_ID") || String(defaultSeedId),
      "seed-token-id",
    ),
    seedChannelId: validatePositiveInteger(
      value("seed-channel-id", "REALTIME_UPSTREAM_REPLAY_SEED_CHANNEL_ID") || String(defaultSeedId),
      "seed-channel-id",
    ),
    seedUsername: validateSeedIdentifier(
      value("seed-username", "REALTIME_UPSTREAM_REPLAY_SEED_USERNAME") || defaultSeedUsername,
      "seed-username",
    ),
    seedGroup: validateSeedIdentifier(
      value("seed-group", "REALTIME_UPSTREAM_REPLAY_SEED_GROUP") || defaultSeedGroup,
      "seed-group",
    ),
    seedTokenKey: validatePlainValue(
      value("seed-token-key", "REALTIME_UPSTREAM_REPLAY_SEED_TOKEN_KEY") || defaultSeedTokenKey,
      "seed-token-key",
    ),
    externalMock,
    dryRun,
    json: parsed.flags.has("json"),
  };
}

function usage(exitCode, error) {
  if (error) console.error(error);
  console.error(
    [
      "Usage: bun tools/smoke_realtime_upstream_replay.mjs --url <worker-origin> --api-key <staging-token> [options]",
      "",
      "Options:",
      "  --scenario <name>       upstream-normal-close, upstream-frame-limit, startup-queue-drain, response-done-usage, upstream-event-stream-failed, or upstream-accept-failed",
      "  --model <model>         or REALTIME_UPSTREAM_REPLAY_MODEL",
      "  --api-key <token>       or REALTIME_UPSTREAM_REPLAY_API_KEY",
      "  --probe <text>          or REALTIME_UPSTREAM_REPLAY_PROBE",
      "  --timeout-ms <ms>       or REALTIME_UPSTREAM_REPLAY_TIMEOUT_MS",
      "  --mock-host <host>      local mock host, default 127.0.0.1",
      "  --mock-port <port>      local mock port, default 8799",
      "  --mock-base-url <url>   channel base_url expected to reach the mock",
      "  --expected-channel-base-url <url>  optional operator assertion for the D1 channel",
      "  --seed-user-id <id>     default 910001, for generated local D1 seed SQL",
      "  --seed-token-id <id>    default 910001, for generated local D1 seed SQL",
      "  --seed-channel-id <id>  default 910001, for generated local D1 seed SQL",
      "  --seed-username <name>  default realtime-mock-smoke, for generated seed SQL",
      "  --seed-group <group>    default default, for generated seed SQL",
      "  --seed-token-key <key>  default sk-cinatoken-realtime-mock-local",
      "  --external-mock         do not start a local Bun mock server",
      "  --confirm-live          required for network replay",
      "  --dry-run               print the redacted replay plan without network",
      "  --self-test             validate local scenario expectations without network",
      "  --json",
      "",
      "Examples:",
      "  bun tools/smoke_realtime_upstream_replay.mjs --dry-run --json --url http://127.0.0.1:8787 --api-key dry-run-token",
      "  bun tools/smoke_realtime_upstream_replay.mjs --url http://127.0.0.1:8787 --api-key $env:REALTIME_SMOKE_API_KEY --confirm-live --json",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function buildPlan(options) {
  const base = normalizeWorkerBaseUrl(required(options.url, "url"));
  const wsUrl = buildRealtimeWebSocketUrl(base, options.model);
  const protocols = realtimeProtocols(required(options.apiKey, "api-key"));
  const mockBase = new URL(options.mockBaseUrl);
  const mockUpstreamUrl = buildMockUpstreamUrl(mockBase, options.mockPath, options.model);
  const expectedChannelBaseUrl = options.expectedChannelBaseUrl
    ? normalizeHttpBaseUrl(options.expectedChannelBaseUrl, "expected-channel-base-url")
    : options.mockBaseUrl;
  return {
    ok: true,
    dryRun: options.dryRun,
    scenario: options.scenario.name,
    workerRealtimeUrl: wsUrl,
    protocols,
    mock: {
      startLocalServer: !options.externalMock,
      host: options.mockHost,
      port: options.mockPort,
      path: options.mockPath,
      baseUrl: options.mockBaseUrl,
      upstreamUrl: mockUpstreamUrl,
    },
    expectedChannel: {
      model: options.model,
      baseUrl: expectedChannelBaseUrl,
      notes: [
        "Configure a dedicated enabled OpenAI-compatible staging/local channel for this model and group.",
        "The channel base_url must point at the mock base URL; the Worker appends /v1/realtime?model=...",
        "Use a non-production channel key; the mock does not require a real provider key.",
      ],
    },
    localD1Seed: buildLocalD1SeedPlan(options, expectedChannelBaseUrl),
    runtimeStatusProbePhase: runtimeStatusProbePhaseForScenario(options.scenario),
    expectedRuntimeStatus: expectedRuntimeStatusForScenario(options.scenario, options.probe),
    expectedUsageCapture: expectedUsageCaptureForScenario(options.scenario),
    expectedBridgeEvent: options.scenario.expectedEvent,
    probeBytes: byteLength(options.probe),
    timeoutMs: options.timeoutMs,
    plannedButNotLiveScenarios: plannedFaultScenarios,
    notes: [
      "Local mock replay is intended for wrangler dev or another Worker runtime that can reach the mock URL.",
      "Cloudflare staging cannot reach 127.0.0.1 directly; use a public mock endpoint or tunnel for remote staging.",
      scenarioReplayNote(options.scenario),
      options.scenario.expectForwardedClientFrame === false
        ? "The live smoke fails unless the mock receives the upstream WebSocket connection and the Worker emits a metadata-only realtime_session_bridge_event."
        : "The live smoke fails unless the mock receives the forwarded client frame and the Worker emits a metadata-only realtime_session_bridge_event.",
    ],
  };
}

async function runLiveReplay(options, plan) {
  const stats = {
    requests: [],
    connections: 0,
    receivedFrames: [],
    sentFrames: [],
    closeEvents: [],
    errors: [],
  };
  const server = options.externalMock ? null : startMockServer(options, stats);
  try {
    const ws = await openWebSocket(plan.workerRealtimeUrl, plan.protocols, options.timeoutMs);
    const outcomePromise = waitForBridgeEventAndClose(ws, options.timeoutMs);
    let statusFrame = null;
    let usageFrame = null;
    if (options.scenario.skipRuntimeStatus) {
      // The Worker-side mock fault happens immediately after upstream connect.
    } else if (options.scenario.queueProbe) {
      ws.send(options.probe);
      statusFrame = await requestRuntimeStatus(ws, options);
    } else if (options.scenario.expectUsageCapture) {
      ws.send(options.probe);
      usageFrame = await waitForJsonMessage(
        ws,
        (message) => message.type === "response.done",
        options.timeoutMs,
        "response.done usage frame",
      );
      validateUsageFrame(usageFrame, options.scenario.expectedUsage, "forwarded upstream usage frame");
      statusFrame = await requestRuntimeStatus(ws, options);
      ws.send(usageReplayCloseProbe);
    } else {
      statusFrame = await requestRuntimeStatus(ws, options);
    }
    if (!options.scenario.skipProbe && !options.scenario.queueProbe && !options.scenario.expectUsageCapture) {
      ws.send(options.probe);
    }
    const outcome = await outcomePromise;
    validateLiveReplayOutcome(outcome, stats, options, statusFrame, usageFrame);
    return {
      ok: true,
      dryRun: false,
      scenario: options.scenario.name,
      workerRealtimeUrl: redactUrl(plan.workerRealtimeUrl),
      mock: sanitizeMockSummary(plan.mock, stats),
      expectedBridgeEvent: options.scenario.expectedEvent,
      observedRuntimeStatus: summarizeRuntimeStatus(statusFrame),
      observedUsageCapture: summarizeUsageCapture(statusFrame?.metrics, usageFrame),
      observedBridgeEvent: summarizeBridgeEvent(outcome.bridgeEvent),
      clientClose: outcome.close,
      forwardedClientFrames: stats.receivedFrames,
      upstreamFramesSent: stats.sentFrames,
      rawProbeEchoed: false,
      rawApiKeyEchoed: false,
    };
  } finally {
    if (server) {
      server.stop(true);
    }
  }
}

async function requestRuntimeStatus(ws, options) {
  const statusPromise = waitForJsonMessage(
    ws,
    (message) => message.type === "realtime_session_status",
    options.timeoutMs,
    "realtime_session_status",
  );
  ws.send("status");
  const statusFrame = await statusPromise;
  validateRuntimeStatusFrame(statusFrame, options);
  return statusFrame;
}

function startMockServer(options, stats) {
  if (typeof Bun === "undefined" || !Bun.serve) {
    throw new Error("local mock upstream server requires Bun. Use --external-mock for an already reachable mock.");
  }
  return Bun.serve({
    hostname: options.mockHost,
    port: options.mockPort,
    fetch(req, server) {
      const url = new URL(req.url);
      stats.requests.push({
        path: url.pathname,
        hasUpgrade: req.headers.get("upgrade")?.toLowerCase() === "websocket",
      });
      if (url.pathname !== options.mockPath) {
        return new Response("not found", { status: 404 });
      }
      if (server.upgrade(req, { data: { actionTaken: false, clientFrameCount: 0 } })) {
        return;
      }
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      open() {
        stats.connections += 1;
      },
      message(ws, message) {
        ws.data.clientFrameCount = (ws.data.clientFrameCount || 0) + 1;
        const clientFrameCount = ws.data.clientFrameCount;
        stats.receivedFrames.push(summarizeFrame(message));
        if (
          options.scenario.mockAction !== "send_response_done_usage_after_first_client_frame" &&
          ws.data.actionTaken
        ) {
          return;
        }
        if (options.scenario.mockAction !== "send_response_done_usage_after_first_client_frame") {
          ws.data.actionTaken = true;
        }
        runMockAction(ws, options.scenario, stats, clientFrameCount);
      },
      close(_ws, code, reason) {
        stats.closeEvents.push({
          code,
          reason: truncate(reason || ""),
        });
      },
      error(_ws, error) {
        stats.errors.push(error instanceof Error ? error.message : String(error));
      },
    },
  });
}

function runMockAction(ws, scenario, stats, clientFrameCount) {
  if (scenario.mockAction === "close_after_first_client_frame") {
    queueMicrotask(() => {
      ws.close(scenario.closeCode, scenario.closeReason);
    });
    return;
  }
  if (scenario.mockAction === "send_oversized_text_after_first_client_frame") {
    const text = makeSizedText(scenario.upstreamFrameBytes);
    stats.sentFrames.push({ kind: "text", bytes: byteLength(text) });
    ws.send(text);
    return;
  }
  if (scenario.mockAction === "send_response_done_usage_after_first_client_frame") {
    if (clientFrameCount === 1) {
      stats.sentFrames.push(summarizeFrame(responseDoneUsageFrame));
      ws.send(responseDoneUsageFrame);
    } else if (scenario.closeAfterSecondClientFrame && clientFrameCount === 2) {
      queueMicrotask(() => {
        ws.close(scenario.closeCode, scenario.closeReason);
      });
    }
    return;
  }
  throw new Error(`unsupported mock action: ${scenario.mockAction}`);
}

function openWebSocket(url, protocols, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const timeout = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        // Keep the timeout error as the useful failure.
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
      const text = await messageText(event.data);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (predicate(parsed)) {
        cleanup();
        resolve(parsed);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for ${label}`));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`WebSocket closed before ${label}: ${event.code} ${event.reason}`.trim()));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

function waitForBridgeEventAndClose(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bridgeEvent = null;
    let close = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for bridge event and close after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const maybeResolve = () => {
      if (bridgeEvent && close) {
        cleanup();
        resolve({ bridgeEvent, close });
      }
    };
    const onMessage = async (event) => {
      const text = await messageText(event.data);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (parsed?.type === "realtime_session_bridge_event") {
        bridgeEvent = parsed;
        maybeResolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket error while waiting for bridge replay event"));
    };
    const onClose = (event) => {
      close = {
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

function validateLiveReplayOutcome(outcome, stats, options, statusFrame = null, usageFrame = null) {
  if (statusFrame) {
    validateRuntimeStatusFrame(statusFrame, options);
  }
  if (options.scenario.expectUsageCapture) {
    validateUsageFrame(usageFrame, options.scenario.expectedUsage, "forwarded upstream usage frame");
    validateUsageMetrics(statusFrame?.metrics, options.scenario.expectedUsage, "runtime status metrics");
  }
  validateBridgeEvent(outcome.bridgeEvent, options.scenario.expectedEvent, options.scenario.name);
  if (outcome.close.code !== options.scenario.expectedEvent.clientCode) {
    throw new Error(
      `client close code=${outcome.close.code}, expected ${options.scenario.expectedEvent.clientCode}`,
    );
  }
  if (outcome.close.reason !== options.scenario.expectedEvent.clientReason) {
    throw new Error(
      `client close reason=${outcome.close.reason}, expected ${options.scenario.expectedEvent.clientReason}`,
    );
  }
  if (!options.externalMock && stats.connections < 1) {
    throw new Error("mock upstream did not receive a WebSocket connection");
  }
  if (
    !options.externalMock &&
    options.scenario.expectForwardedClientFrame !== false &&
    stats.receivedFrames.length < 1
  ) {
    throw new Error("mock upstream did not receive the forwarded client frame");
  }
  const firstFrame = stats.receivedFrames[0];
  if (
    !options.externalMock &&
    options.scenario.expectForwardedClientFrame !== false &&
    firstFrame.bytes !== byteLength(options.probe)
  ) {
    throw new Error(`forwarded client frame bytes=${firstFrame.bytes}, expected ${byteLength(options.probe)}`);
  }
  if (!options.externalMock && options.scenario.expectUsageCapture) {
    if (stats.sentFrames.length < 1) {
      throw new Error("mock upstream did not send the response.done usage frame");
    }
    if (stats.receivedFrames.length < 2) {
      throw new Error("mock upstream did not receive the usage replay close marker");
    }
  }
  if (outcome.bridgeEvent.context?.upstream_connect_handoff !== true) {
    throw new Error("bridge event context did not prove upstream_connect_handoff=true");
  }
  validateNoRawLeaks({ outcome, statusFrame, usageFrame }, options);
}

function runtimeStatusProbePhaseForScenario(scenario) {
  if (scenario.skipRuntimeStatus) return "skipped_early_mock_fault";
  if (scenario.queueProbe) return "after_probe_before_drain";
  if (scenario.expectUsageCapture) return "after_response_done_usage_before_close";
  return "before_probe";
}

function expectedUsageCaptureForScenario(scenario) {
  if (!scenario.expectUsageCapture) return null;
  return {
    upstreamFrame: {
      type: "response.done",
      responseUsage: {
        inputTokens: scenario.expectedUsage.prompt_tokens,
        outputTokens: scenario.expectedUsage.completion_tokens,
        totalTokens: scenario.expectedUsage.total_tokens,
        cachedTokens: scenario.expectedUsage.cached_tokens,
        audioInputTokens: scenario.expectedUsage.audio_input_tokens,
        audioOutputTokens: scenario.expectedUsage.audio_output_tokens,
      },
    },
    runtimeMetrics: summarizeUsageMetadata(scenario.expectedUsage),
  };
}

function scenarioReplayNote(scenario) {
  if (scenario.queueProbe) {
    return "Live replay sends the probe before the status control frame and expects one queued upstream frame before the delayed upstream accept drains it.";
  }
  if (scenario.expectUsageCapture) {
    return "Live replay forwards a mock response.done usage frame, then requires status metrics to show one metadata-only usage capture before normal mock close.";
  }
  if (scenario.skipRuntimeStatus) {
    return "Live replay expects the Worker-side mock fault to close before any client probe is forwarded.";
  }
  return "Live replay sends a WebSocket status control frame before the probe and requires one active upstream bridge with an empty pending queue.";
}

function expectedRuntimeStatusForScenario(scenario, probe) {
  if (scenario.skipRuntimeStatus) return null;
  return scenario.queueProbe
    ? {
        active_upstream_bridges: 1,
        queued_upstream_frames: 1,
        queued_upstream_bytes: byteLength(probe),
      }
    : {
        active_upstream_bridges: 1,
        queued_upstream_frames: 0,
        queued_upstream_bytes: 0,
      };
}

function validateRuntimeStatusFrame(frame, options) {
  const scenarioName = options.scenario.name;
  const expected = expectedRuntimeStatusForScenario(options.scenario, options.probe);
  if (!expected) return;
  if (!frame || typeof frame !== "object") {
    throw new Error(`missing runtime status frame for ${scenarioName}`);
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (frame[field] !== expectedValue) {
      throw new Error(`runtime status ${field}=${frame[field]}, expected ${expectedValue}`);
    }
  }
  if (options.scenario.expectUsageCapture) {
    validateUsageMetrics(frame.metrics, options.scenario.expectedUsage, "runtime status metrics");
  }
}

function validateUsageFrame(frame, expected, label) {
  if (!expected) return;
  if (!frame || typeof frame !== "object") {
    throw new Error(`${label} missing usage frame`);
  }
  if (frame.type !== expected.source_event) {
    throw new Error(`${label} type=${frame.type}, expected ${expected.source_event}`);
  }
  const usage = frame.response?.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error(`${label} missing response.usage`);
  }
  const checks = [
    ["input_tokens", expected.prompt_tokens],
    ["output_tokens", expected.completion_tokens],
    ["total_tokens", expected.total_tokens],
    ["input_token_details.cached_tokens", expected.cached_tokens],
    ["input_token_details.audio_tokens", expected.audio_input_tokens],
    ["output_token_details.audio_tokens", expected.audio_output_tokens],
  ];
  for (const [field, expectedValue] of checks) {
    const actual = dottedValue(usage, field);
    if (actual !== expectedValue) {
      throw new Error(`${label} ${field}=${actual}, expected ${expectedValue}`);
    }
  }
}

function validateUsageMetrics(metrics, expected, label) {
  if (!expected) return;
  if (!metrics || typeof metrics !== "object") {
    throw new Error(`${label} missing metrics object`);
  }
  if (!Number.isInteger(metrics.usage_event_count) || metrics.usage_event_count < 1) {
    throw new Error(`${label} usage_event_count=${metrics.usage_event_count}, expected >= 1`);
  }
  if (typeof metrics.last_usage_at_ms !== "number") {
    throw new Error(`${label} missing numeric last_usage_at_ms`);
  }
  const usage = metrics.last_usage;
  if (!usage || typeof usage !== "object") {
    throw new Error(`${label} missing last_usage`);
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (usage[field] !== expectedValue) {
      throw new Error(`${label} last_usage.${field}=${usage[field]}, expected ${expectedValue}`);
    }
  }
}

function dottedValue(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value);
}

function validateBridgeEvent(frame, expected, scenarioName) {
  if (!frame || typeof frame !== "object") {
    throw new Error(`missing bridge event frame for ${scenarioName}`);
  }
  if (frame.status !== expected.event) {
    throw new Error(`bridge frame status=${frame.status}, expected ${expected.event}`);
  }
  const event = frame.event || {};
  const checks = [
    ["event", expected.event],
    ["direction", expected.direction],
    ["client_code", expected.clientCode],
    ["client_reason", expected.clientReason],
    ["upstream_code", expected.upstreamCode ?? null],
    ["upstream_reason", expected.upstreamReason ?? null],
    ["upstream_close_code", expected.upstreamCloseCode ?? null],
    ["frame_kind", expected.frameKind ?? null],
    ["frame_bytes", expected.frameBytes ?? null],
    ["frame_max_bytes", expected.frameMaxBytes ?? null],
  ];
  for (const [field, expectedValue] of checks) {
    const actual = event[field] ?? null;
    if (actual !== expectedValue) {
      throw new Error(`bridge event ${field}=${actual}, expected ${expectedValue}`);
    }
  }
}

function validateNoRawLeaks(value, options) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    options.apiKey,
    options.probe,
    upstreamReplayProbePrefix,
    "openai-insecure-api-key.",
  ]) {
    if (secret && serialized.includes(secret)) {
      throw new Error("live replay result leaked raw probe or API-key material");
    }
  }
}

function runSelfTest() {
  const cases = [];
  const baseOptions = {
    url: "http://127.0.0.1:8787",
    apiKey: "self-test-secret",
    model: defaultModel,
    probe: defaultProbe,
    timeoutMs: defaultTimeoutMs,
    mockHost: defaultMockHost,
    mockPort: defaultMockPort,
    mockPath: defaultMockPath,
    mockBaseUrl: `http://${defaultMockHost}:${defaultMockPort}`,
    expectedChannelBaseUrl: "",
    externalMock: false,
    dryRun: true,
    json: true,
    seedUserId: defaultSeedId,
    seedTokenId: defaultSeedId,
    seedChannelId: defaultSeedId,
    seedUsername: defaultSeedUsername,
    seedGroup: defaultSeedGroup,
    seedTokenKey: defaultSeedTokenKey,
  };
  for (const scenario of scenarios.values()) {
    const options = { ...baseOptions, scenario };
    const plan = redactedPlan(buildPlan(options));
    if (JSON.stringify(plan).includes(baseOptions.apiKey)) {
      throw new Error(`self-test ${scenario.name} leaked API key in redacted plan`);
    }
    validateSeedPlan(plan.localD1Seed, scenario);
    const outcome = syntheticOutcome(scenario);
    const statusFrame = syntheticRuntimeStatusFrame(scenario, options.probe);
    const usageFrame = syntheticUsageFrame(scenario);
    validateLiveReplayOutcome(outcome, syntheticStats(options.probe, scenario), options, statusFrame, usageFrame);
    cases.push({
      name: scenario.name,
      ok: true,
      event: scenario.expectedEvent.event,
      clientClose: scenario.expectedEvent.clientCode,
      runtimeStatus: summarizeRuntimeStatus(statusFrame),
      usageCapture: summarizeUsageCapture(statusFrame?.metrics, usageFrame),
    });
  }
  expectFailure(
    () => validateBridgeEvent(syntheticOutcome(scenarios.get("upstream-normal-close")).bridgeEvent, {
      ...scenarios.get("upstream-normal-close").expectedEvent,
      clientReason: "wrong_reason",
    }, "wrong-reason"),
    "client_reason",
  );
  expectFailure(
    () => validateNoRawLeaks({ leaked: defaultProbe }, { apiKey: "secret", probe: defaultProbe }),
    "leaked raw probe",
  );
  expectFailure(
    () =>
      validateUsageMetrics(
        { usage_event_count: 0, last_usage_at_ms: 1, last_usage: expectedResponseDoneUsage },
        expectedResponseDoneUsage,
        "missing usage count",
      ),
    "usage_event_count",
  );
  return {
    ok: true,
    realtimeUpstreamMockReplaySelfTest: true,
    liveScenarios: cases,
    plannedButNotLiveScenarios: plannedFaultScenarios,
  };
}

function syntheticOutcome(scenario) {
  return {
    bridgeEvent: {
      type: "realtime_session_bridge_event",
      status: scenario.expectedEvent.event,
      context: {
        session: "session-smoke",
        entrypoint: "v1_realtime_gateway",
        upstream_connect_handoff: true,
        upstream: {
          channel_id: 1,
          provider: "openai_compatible",
          upstream_url: "wss://mock.example/v1/realtime?model=gpt-4o-realtime-preview",
        },
      },
      event: {
        event: scenario.expectedEvent.event,
        direction: scenario.expectedEvent.direction,
        occurred_at_ms: 1_788_192_000_000,
        client_code: scenario.expectedEvent.clientCode,
        client_reason: scenario.expectedEvent.clientReason,
        upstream_code: scenario.expectedEvent.upstreamCode ?? null,
        upstream_reason: scenario.expectedEvent.upstreamReason ?? null,
        upstream_close_code: scenario.expectedEvent.upstreamCloseCode ?? null,
        frame_kind: scenario.expectedEvent.frameKind ?? null,
        frame_bytes: scenario.expectedEvent.frameBytes ?? null,
        frame_max_bytes: scenario.expectedEvent.frameMaxBytes ?? null,
      },
    },
    close: {
      code: scenario.expectedEvent.clientCode,
      reason: scenario.expectedEvent.clientReason,
      wasClean: true,
    },
  };
}

function syntheticStats(probe, scenario) {
  const receivedFrames = [{ kind: "text", bytes: byteLength(probe) }];
  const sentFrames = [];
  if (scenario.expectUsageCapture) {
    receivedFrames.push({ kind: "text", bytes: byteLength(usageReplayCloseProbe) });
    sentFrames.push(summarizeFrame(responseDoneUsageFrame));
  }
  return {
    connections: 1,
    receivedFrames,
    sentFrames,
    closeEvents: [],
    errors: [],
  };
}

function syntheticRuntimeStatusFrame(scenario, probe) {
  const expected = expectedRuntimeStatusForScenario(scenario, probe);
  if (!expected) return null;
  const usageMetrics = scenario.expectUsageCapture
    ? {
        usage_event_count: 1,
        last_usage_at_ms: 1_788_192_000_001,
        last_usage: scenario.expectedUsage,
      }
    : {
        usage_event_count: 0,
        last_usage_at_ms: null,
        last_usage: null,
      };
  return {
    type: "realtime_session_status",
    ...expected,
    metrics: {
      connected_count: 1,
      text_message_count: 1,
      updated_at_ms: 1_788_192_000_000,
      ...usageMetrics,
    },
  };
}

function syntheticUsageFrame(scenario) {
  return scenario.expectUsageCapture ? JSON.parse(responseDoneUsageFrame) : null;
}

function buildLocalD1SeedPlan(options, expectedChannelBaseUrl) {
  const now = Math.floor(Date.now() / 1000);
  const userId = options.seedUserId;
  const tokenId = options.seedTokenId;
  const channelId = options.seedChannelId;
  const username = options.seedUsername;
  const group = options.seedGroup;
  const model = options.model;
  const tokenKey = options.seedTokenKey;
  const channelName = `realtime-mock-upstream-${channelId}`;
  const mockChannelKey = `mock-upstream-key-${channelId}`;
  const affCode = `rtmock${userId}`;
  const otherInfo =
    options.scenario.queueProbe || options.scenario.mockFault
      ? {
          realtime_mock_upstream: {
            ...(options.scenario.queueProbe
              ? { queue_probe_delay_ms: options.scenario.queueProbeDelayMs }
              : {}),
            ...(options.scenario.mockFault ? { fault: options.scenario.mockFault } : {}),
          },
        }
      : { realtime_mock_upstream: true };
  const statements = [
    `INSERT INTO users (id, username, password, display_name, role, status, email, quota, used_quota, request_count, "group", aff_code, created_at, deleted_at)
VALUES (${userId}, ${sqlString(username)}, 'disabled-local-smoke-user', 'Realtime Mock Smoke', 1, 1, '', 100000000, 0, 0, ${sqlString(group)}, ${sqlString(affCode)}, ${now}, NULL)
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username,
  display_name = excluded.display_name,
  status = 1,
  quota = 100000000,
  "group" = excluded."group",
  deleted_at = NULL;`,
    `INSERT INTO tokens (id, user_id, "key", status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, allow_ips, used_quota, "group", cross_group_retry, deleted_at)
VALUES (${tokenId}, ${userId}, ${sqlString(tokenKey)}, 1, 'realtime mock smoke token', ${now}, 0, -1, 0, 1, 1, ${sqlString(model)}, '', 0, ${sqlString(group)}, 0, NULL)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  "key" = excluded."key",
  status = 1,
  expired_time = -1,
  remain_quota = 0,
  unlimited_quota = 1,
  model_limits_enabled = 1,
  model_limits = excluded.model_limits,
  "group" = excluded."group",
  deleted_at = NULL;`,
    `INSERT INTO channels (id, type, "key", status, name, weight, created_time, base_url, other, balance, models, "group", used_quota, model_mapping, status_code_mapping, priority, auto_ban, other_info, channel_info, settings)
VALUES (${channelId}, ${openaiCompatibleChannelType}, ${sqlString(mockChannelKey)}, 1, ${sqlString(channelName)}, 1000, ${now}, ${sqlString(expectedChannelBaseUrl)}, '', 0, ${sqlString(model)}, ${sqlString(group)}, 0, NULL, '', 1000, 0, ${sqlString(JSON.stringify(otherInfo))}, '{}', '')
ON CONFLICT(id) DO UPDATE SET
  type = excluded.type,
  "key" = excluded."key",
  status = 1,
  name = excluded.name,
  weight = excluded.weight,
  base_url = excluded.base_url,
  models = excluded.models,
  "group" = excluded."group",
  priority = excluded.priority,
  auto_ban = 0,
  other_info = excluded.other_info;`,
    `DELETE FROM abilities WHERE channel_id = ${channelId};`,
    `INSERT INTO abilities (group_name, model, channel_id, enabled, priority, weight)
VALUES (${sqlString(group)}, ${sqlString(model)}, ${channelId}, 1, 1000, 1000);`,
  ];
  return {
    reviewOnly: true,
    appliesTo: "local wrangler dev or isolated staging D1 only",
    commandExample:
      "wrangler d1 execute <DB_NAME> --local --file <reviewed-realtime-mock-seed.sql>",
    smokeApiKey: tokenKey,
    userId,
    tokenId,
    channelId,
    channelType: openaiCompatibleChannelType,
    channelGroup: group,
    channelModel: model,
    channelBaseUrl: expectedChannelBaseUrl,
    channelOtherInfo: otherInfo,
    warnings: [
      "Review this SQL before execution; the smoke tool never writes D1 by itself.",
      "Use only a dedicated non-production D1 database or an isolated staging test channel.",
      "Do not pass production token keys; the seed token key is intentionally printed for live smoke use.",
      "If a row id or unique username/key is already used, change the seed ids/token key before applying.",
      "For live replay, pass the seed smokeApiKey as --api-key after applying the SQL.",
      ...(options.scenario.queueProbe
        ? [
            `This scenario intentionally delays upstream accept/drain by ${options.scenario.queueProbeDelayMs}ms and must stay isolated from production traffic.`,
          ]
        : []),
      ...(options.scenario.mockFault
        ? [
            `This scenario injects Worker-side mock fault ${options.scenario.mockFault} and must stay isolated from production traffic.`,
          ]
        : []),
    ],
    statements,
  };
}

function validateSeedPlan(plan, scenario) {
  const scenarioName = scenario.name;
  if (!plan || !Array.isArray(plan.statements) || plan.statements.length !== 5) {
    throw new Error(`self-test ${scenarioName} generated an invalid D1 seed plan`);
  }
  const sql = plan.statements.join("\n");
  for (const expected of ["INSERT INTO users", "INSERT INTO tokens", "INSERT INTO channels", "INSERT INTO abilities"]) {
    if (!sql.includes(expected)) {
      throw new Error(`self-test ${scenarioName} seed plan missing ${expected}`);
    }
  }
  if (!sql.includes(plan.channelBaseUrl) || !sql.includes(plan.channelModel)) {
    throw new Error(`self-test ${scenarioName} seed plan missing channel base URL or model`);
  }
  if (scenario.queueProbe) {
    if (!sql.includes("queue_probe_delay_ms") || !sql.includes(String(scenario.queueProbeDelayMs))) {
      throw new Error(`self-test ${scenarioName} seed plan missing queue probe delay metadata`);
    }
  } else if (sql.includes("queue_probe_delay_ms")) {
    throw new Error(`self-test ${scenarioName} seed plan unexpectedly includes queue probe delay metadata`);
  }
  if (scenario.mockFault) {
    if (!sql.includes(`"fault":"${scenario.mockFault}"`)) {
      throw new Error(`self-test ${scenarioName} seed plan missing mock fault metadata`);
    }
  } else if (sql.includes('"fault":')) {
    throw new Error(`self-test ${scenarioName} seed plan unexpectedly includes mock fault metadata`);
  }
}

function expectFailure(fn, messagePart) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(messagePart)) {
      throw new Error(`unexpected self-test failure: ${message}`);
    }
    return;
  }
  throw new Error(`expected self-test failure containing ${messagePart}`);
}

function summarizeBridgeEvent(frame) {
  const event = frame.event || {};
  return {
    status: frame.status,
    context: {
      entrypoint: frame.context?.entrypoint,
      upstreamConnectHandoff: frame.context?.upstream_connect_handoff === true,
      upstreamPresent: Boolean(frame.context?.upstream),
    },
    event: {
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
    },
  };
}

function summarizeRuntimeStatus(frame) {
  if (!frame) return null;
  return {
    activeUpstreamBridges: frame.active_upstream_bridges,
    queuedUpstreamFrames: frame.queued_upstream_frames,
    queuedUpstreamBytes: frame.queued_upstream_bytes,
    usageEventCount: frame.metrics?.usage_event_count ?? null,
    lastUsage: summarizeUsageMetadata(frame.metrics?.last_usage),
  };
}

function summarizeUsageCapture(metrics, usageFrame) {
  if (!metrics?.last_usage && !usageFrame) return null;
  return {
    forwardedFrameType: usageFrame?.type ?? null,
    usageEventCount: metrics?.usage_event_count ?? null,
    lastUsage: summarizeUsageMetadata(metrics?.last_usage),
  };
}

function summarizeUsageMetadata(usage) {
  if (!usage) return null;
  return {
    sourceEvent: usage.source_event,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.cached_tokens,
    audioInputTokens: usage.audio_input_tokens,
    audioOutputTokens: usage.audio_output_tokens,
  };
}

function sanitizeMockSummary(mock, stats) {
  return {
    ...mock,
    requests: stats.requests,
    connections: stats.connections,
    closeEvents: stats.closeEvents,
    errors: stats.errors,
  };
}

function redactedPlan(plan) {
  return {
    ...plan,
    workerRealtimeUrl: redactUrl(plan.workerRealtimeUrl),
    protocols: plan.protocols.map(redactProtocol),
  };
}

function realtimeProtocols(apiKey) {
  return ["realtime", `openai-insecure-api-key.${apiKey}`, "openai-beta.realtime-v1"];
}

function buildRealtimeWebSocketUrl(base, model) {
  const url = new URL(base.toString());
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = "/v1/realtime";
  url.search = "";
  url.searchParams.set("model", model);
  return url.toString();
}

function buildMockUpstreamUrl(base, path, model) {
  const url = new URL(base.toString());
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = path;
  url.search = "";
  url.searchParams.set("model", model);
  return url.toString();
}

function normalizeWorkerBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error("url must use http, https, ws, or wss");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeHttpBaseUrl(value, name) {
  const url = new URL(required(value, name));
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`${name} must use http, https, ws, or wss`);
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validatePositiveInteger(value, name) {
  const text = required(value, name);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer between 1 and 2147483647`);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647`);
  }
  return parsed;
}

function validateSeedIdentifier(value, name) {
  const trimmed = validatePlainValue(value, name);
  if (trimmed.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`${name} must be 1-64 chars of letters, digits, underscore, or dash`);
  }
  return trimmed;
}

function validatePath(value, name) {
  const path = required(value, name);
  if (!path.startsWith("/") || /[\r\n]/.test(path)) {
    throw new Error(`${name} must be an absolute path without newlines`);
  }
  return path;
}

function validatePlainValue(value, name) {
  const trimmed = required(value, name);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return trimmed;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function required(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function summarizeFrame(message) {
  if (typeof message === "string") {
    return { kind: "text", bytes: byteLength(message) };
  }
  if (message instanceof ArrayBuffer) {
    return { kind: "binary", bytes: message.byteLength };
  }
  if (ArrayBuffer.isView(message)) {
    return { kind: "binary", bytes: message.byteLength };
  }
  if (message && typeof message.byteLength === "number") {
    return { kind: "binary", bytes: message.byteLength };
  }
  return { kind: "unknown", bytes: byteLength(String(message)) };
}

function makeSizedText(bytes) {
  if (bytes <= byteLength(upstreamReplayProbePrefix)) {
    throw new Error("oversized frame bytes must be larger than the fixed prefix");
  }
  return `${upstreamReplayProbePrefix}${"x".repeat(bytes - byteLength(upstreamReplayProbePrefix))}`;
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function truncate(value) {
  return value.length > 96 ? `${value.slice(0, 96)}...` : value;
}

function redactProtocol(value) {
  return value.startsWith("openai-insecure-api-key.")
    ? "openai-insecure-api-key.<redacted>"
    : value;
}

function redactUrl(value) {
  const url = new URL(value);
  for (const key of ["key", "api_key"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
  }
  return url.toString();
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.dryRun) {
    console.log(
      [
        "Realtime upstream mock replay plan",
        `scenario: ${result.scenario}`,
        `worker_realtime_url: ${result.workerRealtimeUrl}`,
        `mock_upstream_url: ${result.mock.upstreamUrl}`,
        `expected_channel_base_url: ${result.expectedChannel.baseUrl}`,
        `local_d1_seed_channel_id: ${result.localD1Seed.channelId}`,
        `local_d1_seed_smoke_api_key: ${result.localD1Seed.smokeApiKey}`,
        `probe_bytes: ${result.probeBytes}`,
        "local_d1_seed_sql:",
        ...result.localD1Seed.statements.map((statement) => indentMultiline(statement, "  ")),
        "notes:",
        ...result.notes.map((note) => `  - ${note}`),
      ].join("\n"),
    );
    return;
  }
  if (result.realtimeUpstreamMockReplaySelfTest) {
    console.log(
      [
        "Realtime upstream mock replay self-test",
        `ok: ${result.ok}`,
        ...result.liveScenarios.map(
          (item) => `case ${item.name}: ${item.event} close=${item.clientClose}`,
        ),
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "Realtime upstream mock replay result",
      `ok: ${result.ok}`,
      `scenario: ${result.scenario}`,
      `worker_realtime_url: ${result.workerRealtimeUrl}`,
      `observed_bridge_event: ${JSON.stringify(result.observedBridgeEvent)}`,
      ...(result.observedUsageCapture
        ? [`observed_usage_capture: ${JSON.stringify(result.observedUsageCapture)}`]
        : []),
      `client_close: ${JSON.stringify(result.clientClose)}`,
      `forwarded_client_frames: ${JSON.stringify(result.forwardedClientFrames)}`,
    ].join("\n"),
  );
}

function indentMultiline(value, prefix) {
  return String(value)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
