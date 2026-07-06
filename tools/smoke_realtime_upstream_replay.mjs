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
  ].map((scenario) => [scenario.name, scenario]),
);

const plannedFaultScenarios = [
  {
    name: "upstream-error",
    reason: "requires an upstream socket abort/error injection that does not become a normal close",
  },
  {
    name: "upstream-event-stream-failed",
    reason: "requires Worker-side upstream event stream fault injection",
  },
  {
    name: "upstream-accept-failed",
    reason: "requires Worker-side upstream accept fault injection",
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
      "  --scenario <name>       upstream-normal-close or upstream-frame-limit",
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
    expectedBridgeEvent: options.scenario.expectedEvent,
    probeBytes: byteLength(options.probe),
    timeoutMs: options.timeoutMs,
    plannedButNotLiveScenarios: plannedFaultScenarios,
    notes: [
      "Local mock replay is intended for wrangler dev or another Worker runtime that can reach the mock URL.",
      "Cloudflare staging cannot reach 127.0.0.1 directly; use a public mock endpoint or tunnel for remote staging.",
      "The live smoke fails unless the mock receives the forwarded client frame and the Worker emits a metadata-only realtime_session_bridge_event.",
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
    ws.send(options.probe);
    const outcome = await outcomePromise;
    validateLiveReplayOutcome(outcome, stats, options);
    return {
      ok: true,
      dryRun: false,
      scenario: options.scenario.name,
      workerRealtimeUrl: redactUrl(plan.workerRealtimeUrl),
      mock: sanitizeMockSummary(plan.mock, stats),
      expectedBridgeEvent: options.scenario.expectedEvent,
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
      if (server.upgrade(req, { data: { actionTaken: false } })) {
        return;
      }
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      open() {
        stats.connections += 1;
      },
      message(ws, message) {
        stats.receivedFrames.push(summarizeFrame(message));
        if (ws.data.actionTaken) return;
        ws.data.actionTaken = true;
        runMockAction(ws, options.scenario, stats);
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

function runMockAction(ws, scenario, stats) {
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

function validateLiveReplayOutcome(outcome, stats, options) {
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
  if (!options.externalMock && stats.receivedFrames.length < 1) {
    throw new Error("mock upstream did not receive the forwarded client frame");
  }
  const firstFrame = stats.receivedFrames[0];
  if (!options.externalMock && firstFrame.bytes !== byteLength(options.probe)) {
    throw new Error(`forwarded client frame bytes=${firstFrame.bytes}, expected ${byteLength(options.probe)}`);
  }
  if (outcome.bridgeEvent.context?.upstream_connect_handoff !== true) {
    throw new Error("bridge event context did not prove upstream_connect_handoff=true");
  }
  validateNoRawLeaks(outcome, options);
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
    validateSeedPlan(plan.localD1Seed, scenario.name);
    const outcome = syntheticOutcome(scenario);
    validateLiveReplayOutcome(outcome, syntheticStats(options.probe), options);
    cases.push({
      name: scenario.name,
      ok: true,
      event: scenario.expectedEvent.event,
      clientClose: scenario.expectedEvent.clientCode,
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

function syntheticStats(probe) {
  return {
    connections: 1,
    receivedFrames: [{ kind: "text", bytes: byteLength(probe) }],
    sentFrames: [],
    closeEvents: [],
    errors: [],
  };
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
VALUES (${channelId}, ${openaiCompatibleChannelType}, ${sqlString(mockChannelKey)}, 1, ${sqlString(channelName)}, 1000, ${now}, ${sqlString(expectedChannelBaseUrl)}, '', 0, ${sqlString(model)}, ${sqlString(group)}, 0, NULL, '', 1000, 0, ${sqlString(JSON.stringify({ realtime_mock_upstream: true }))}, '{}', '')
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
    warnings: [
      "Review this SQL before execution; the smoke tool never writes D1 by itself.",
      "Use only a dedicated non-production D1 database or an isolated staging test channel.",
      "Do not pass production token keys; the seed token key is intentionally printed for live smoke use.",
      "If a row id or unique username/key is already used, change the seed ids/token key before applying.",
      "For live replay, pass the seed smokeApiKey as --api-key after applying the SQL.",
    ],
    statements,
  };
}

function validateSeedPlan(plan, scenarioName) {
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
