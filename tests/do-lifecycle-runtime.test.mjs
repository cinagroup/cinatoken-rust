import {
  applyD1Migrations,
  env,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const authoritySecret = "0123456789abcdef0123456789abcdef";
const authorityDomain = new Uint8Array([
  ...new TextEncoder().encode("cinatoken-wfp-authority-key:v1"),
  0,
]);
const workerName = "tenant-runtime-test";
const taskRunnerRecordKey = "task_runner_record_v1";
const wfpRouteHeader = "x-cinatoken-wfp-route";
const wfpWorkerHeader = "x-cinatoken-wfp-worker";

afterEach(async () => {
  await reset();
});

describe("Rust Durable Object lifecycle contracts", () => {
  it("allows exactly one concurrent authority replay winner", async () => {
    const authority = await signedAuthority({ requestId: "runtime-concurrent" });
    const stub = replayStub(authority.issuedAt);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => consumeAuthority(stub, authority.token)),
    );
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    await runInDurableObject(stub, async (_instance, state) => {
      const entries = await state.storage.list({ prefix: "used:" });
      expect(entries.size).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      return new Response(null);
    });
  });

  it("preserves consumed authority across Durable Object eviction", async () => {
    const authority = await signedAuthority({ requestId: "runtime-eviction" });
    const stub = replayStub(authority.issuedAt);

    expect((await consumeAuthority(stub, authority.token)).status).toBe(200);
    await evictDurableObject(stub);
    expect((await consumeAuthority(stub, authority.token)).status).toBe(409);
  });

  it("restores a hibernatable Rust RealtimeSession WebSocket after eviction", async () => {
    const session = "runtime-hibernation";
    const stub = env.REALTIME_SESSIONS.getByName(session);
    const response = await stub.fetch(
      `https://realtime-session.internal/api/platform/realtime/${session}`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket;

    expect(response.status).toBe(101);
    expect(socket).toBeDefined();
    socket.accept();

    const beforeMessage = nextJsonWebSocketMessage(socket, "pre-eviction status");
    socket.send("status");
    const before = await beforeMessage;

    expect(before).toMatchObject({
      type: "realtime_session_status",
      context: {
        session,
        entrypoint: "platform_realtime",
        auth_state: "not_required",
        upstream_connect_handoff: false,
      },
      metrics: {
        connected_count: 1,
        text_message_count: 1,
      },
      active_upstream_bridges: 0,
      queued_upstream_frames: 0,
      queued_upstream_bytes: 0,
    });
    const bridgeSegment = before.context.bridge_segment;
    expect(bridgeSegment).toMatch(/^rtsegment-[a-f0-9]{64}$/u);

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const afterMessage = nextJsonWebSocketMessage(socket, "post-eviction status");
    socket.send("status");
    const after = await afterMessage;

    expect(after).toMatchObject({
      type: "realtime_session_status",
      context: {
        session,
        bridge_segment: bridgeSegment,
        entrypoint: "platform_realtime",
        auth_state: "not_required",
        upstream_connect_handoff: false,
      },
      metrics: {
        connected_count: 1,
        text_message_count: 2,
      },
      active_upstream_bridges: 0,
      queued_upstream_frames: 0,
      queued_upstream_bytes: 0,
    });

    const statusResponse = await stub.fetch(
      `https://realtime-session.internal/api/platform/realtime/${session}/status`,
    );
    const status = await statusResponse.json();
    expect(statusResponse.status).toBe(200);
    expect(status).toMatchObject({
      session,
      active_websockets: 1,
      restored_attachments: 1,
      hibernation: true,
      observability: "durable_object_storage",
      active_upstream_bridges: 0,
      metrics: {
        connected_count: 1,
        text_message_count: 2,
      },
      attachments: [
        {
          session,
          bridge_segment: bridgeSegment,
          entrypoint: "platform_realtime",
          auth_state: "not_required",
          upstream_connect_handoff: false,
        },
      ],
    });

    socket.close(1000, "test complete");
  });

  it("reconstructs attachment state and refunds once without reconnecting the provider", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );
    await seedRealtimeBillingAccount();

    const providerProofSession = "runtime-upstream-provider-proof";
    const providerProofStub = env.REALTIME_SESSIONS.getByName(providerProofSession);
    const providerProofSocket = await openDetachedRealtimeBridge(
      providerProofStub,
      providerProofSession,
    );
    await waitForDetachedBridge(providerProofSocket, 1);
    providerProofSocket.close(1000, "provider proof complete");

    const session = "runtime-upstream-reconstruction";
    const stub = env.REALTIME_SESSIONS.getByName(session);
    const first = await openRealtimeSession(stub, session);
    const firstStatusMessage = nextJsonWebSocketMessage(first, "initial attachment status");
    first.send("status");
    const firstStatus = await firstStatusMessage;
    const firstSegment = firstStatus.context.bridge_segment;
    const reservationKey = "rtreserve-runtime-reconstruction";
    const leaseExpiresAt = Math.floor(Date.now() / 1000) + 300;

    await seedRealtimeReservation({
      reservationKey,
      session,
      bridgeSegment: firstSegment,
      leaseExpiresAt,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const [serverSocket] = state.getWebSockets();
      const attachment = serverSocket.deserializeAttachment();
      serverSocket.serializeAttachment({
        ...attachment,
        upstream_connect_handoff: true,
      });
      await state.storage.put("billing_reservation_leases_v1", {
        records: [
          {
            reservation_key: reservationKey,
            reservation_sequence: 1,
            lease_expires_at: leaseExpiresAt,
            expires_at_ms: leaseExpiresAt * 1_000,
            attempts: 0,
            last_error: null,
          },
        ],
      });
      return new Response(null);
    });

    const beforeEviction = await realtimeSessionStatus(stub, session);
    expect(beforeEviction).toMatchObject({
      active_websockets: 1,
      active_upstream_bridges: 0,
      billing_reservation_lease: { record_count: 1, due_count: 0 },
      attachments: [
        {
          session,
          bridge_segment: firstSegment,
          upstream_connect_handoff: true,
        },
      ],
    });

    await withTimeout(
      evictDurableObject(stub, { webSockets: "hibernate" }),
      10_000,
      "upstream-detached Durable Object eviction",
    );

    const terminalMessage = nextJsonWebSocketMessage(
      first,
      "reconstructed upstream-unavailable event",
    );
    const terminalClose = nextWebSocketClose(first, "reconstructed upstream close");
    first.send(JSON.stringify({ type: "session.update", session: { modalities: ["text"] } }));

    await expect(terminalMessage).resolves.toMatchObject({
      type: "realtime_session_bridge_event",
      status: "upstream_unavailable",
      event: {
        direction: "upstream_to_client",
        client_code: 1011,
        client_reason: "upstream_bridge_unavailable",
      },
      context: {
        session,
        bridge_segment: firstSegment,
        upstream_connect_handoff: true,
      },
    });
    await expect(terminalClose).resolves.toMatchObject({
      code: 1011,
      reason: "upstream_bridge_unavailable",
    });

    await expect(waitForRealtimeRefund(reservationKey)).resolves.toMatchObject({
      reservation: { status: "refunded", bridge_segment: firstSegment },
      user: { quota: 1_000 },
      token: { remain_quota: 500, used_quota: 0 },
    });
    expect(await providerState()).toMatchObject({ count: 1, path: "/v1/realtime" });

    const afterTerminal = await realtimeSessionStatus(stub, session);
    expect(afterTerminal).toMatchObject({
      active_upstream_bridges: 0,
      billing_reservation_lease: null,
      metrics: {
        last_bridge_terminal_event: {
          event: "upstream_unavailable",
          client_code: 1011,
        },
      },
    });

    const second = await openRealtimeSession(stub, session);
    const secondStatusMessage = nextJsonWebSocketMessage(second, "new bridge segment status");
    second.send("status");
    const secondStatus = await secondStatusMessage;
    expect(secondStatus.context.bridge_segment).not.toBe(firstSegment);
    expect(await providerState()).toMatchObject({ count: 1, path: "/v1/realtime" });
    await expect(realtimeBillingState(reservationKey)).resolves.toMatchObject({
      reservation: { status: "refunded", bridge_segment: firstSegment },
      user: { quota: 1_000 },
      token: { remain_quota: 500, used_quota: 0 },
    });
    second.close(1000, "test complete");
  }, 30_000);

  it("rejects tampered authority and a non-canonical replay shard", async () => {
    const authority = await signedAuthority({ requestId: "runtime-negative" });
    const canonical = replayStub(authority.issuedAt);
    const tampered = `${authority.token.slice(0, -1)}${
      authority.token.endsWith("A") ? "B" : "A"
    }`;

    expect((await consumeAuthority(canonical, tampered)).status).toBe(403);

    const wrong = env.WFP_AUTHORITY_REPLAY.getByName("wrong-runtime-shard");
    expect((await consumeAuthority(wrong, authority.token)).status).toBe(403);
  });

  it("reports a paid-capable Rust tenant without a tenant Cloudflare bearer", async () => {
    const response = await env.WFP_TENANT_RUNTIME.fetch(
      "https://tenant-runtime/__cinatoken/tenant/status",
      {
        headers: {
          [wfpRouteHeader]: "internal-path",
          [wfpWorkerHeader]: workerName,
        },
      },
    );
    const status = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-cinatoken-wfp-runtime")).toBe("rust-wasm");
    expect(status.runtime).toBe("rust-wasm");
    expect(status.paid_ai_capable).toBe(true);
    expect(status.authority_replay_binding_configured).toBe(true);
    expect(status.outbound_auth_mode).toBe("platform-outbound-v1");
    expect(status.tenant_cloudflare_token_bound).toBe(false);
  });

  it("allows one concurrent provider egress for one signed authority", async () => {
    await env.WFP_PROVIDER_MOCK.fetch("https://wfp-provider-mock/__mock/reset", {
      method: "POST",
    });
    const body = new TextEncoder().encode(
      JSON.stringify({ model: "openai/gpt-4.1-mini", input: "runtime probe" }),
    );
    const authority = await signedAuthority({
      requestId: "runtime-cross-worker",
      path: "/v1/responses",
      body,
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => tenantRequest(authority.token, body)),
    );
    const statuses = responses.map((response) => response.status).sort();
    const success = responses.find((response) => response.status === 200);
    const diagnostics = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.clone().text(),
      })),
    );
    const stateResponse = await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/state",
    );
    const state = await stateResponse.json();

    expect(statuses, JSON.stringify({ diagnostics, state })).toEqual([
      200, 409, 409, 409, 409, 409, 409, 409,
    ]);
    expect(success).toBeDefined();
    expect(success.headers.get("x-request-id")).toBe("mock-provider-request");
    expect(success.headers.get("authorization")).toBeNull();
    expect(success.headers.get("set-cookie")).toBeNull();
    expect(success.headers.get("cf-aig-log-id")).toBeNull();

    expect(state).toMatchObject({
      count: 1,
      method: "POST",
      path: "/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/responses",
      authorizationPresent: true,
      authorizationScheme: "Bearer",
      cookiePresent: false,
      contentType: "application/json",
    });
  });

  it("propagates malformed TaskRunner storage so the alarm remains retryable", async () => {
    const stub = env.TASK_RUNNER.getByName("task:runtime-malformed-record");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(taskRunnerRecordKey, {
        task_id: 42,
        status: "armed",
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      return new Response(null);
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      /failed to decode TaskRunner storage/,
    );
    await expect(stub.fetch("https://task-runner/status")).rejects.toThrow(
      /failed to decode TaskRunner storage/,
    );
  });

  it("keeps a genuinely missing TaskRunner record as a successful no-op", async () => {
    const stub = env.TASK_RUNNER.getByName("task:runtime-missing-record");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
      return new Response(null);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
  });
});

function replayStub(issuedAt) {
  const bucket = `${workerName}:${Math.floor(issuedAt / 60)}`;
  return env.WFP_AUTHORITY_REPLAY.getByName(bucket);
}

function consumeAuthority(stub, token) {
  return stub.fetch("https://wfp-authority-replay.internal/consume", {
    method: "POST",
    headers: {
      "x-cinatoken-wfp-authority": token,
      "x-cinatoken-wfp-worker": workerName,
    },
  });
}

function tenantRequest(token, body) {
  return env.WFP_TENANT_RUNTIME.fetch("https://tenant-runtime/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-wfp-authority": token,
      [wfpRouteHeader]: "relay-authority",
      [wfpWorkerHeader]: workerName,
    },
    body,
  });
}

async function signedAuthority({ requestId, path = "/v1/responses", body = new Uint8Array() }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    version: 1,
    worker: workerName,
    method: "POST",
    path,
    body_sha256: await sha256Hex(body),
    request_id: requestId,
    channel_id: 42,
    issued_at: issuedAt,
    expires_at: issuedAt + 30,
  };
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const workerKey = await hmac(
    new TextEncoder().encode(authoritySecret),
    concatBytes(authorityDomain, new TextEncoder().encode(workerName)),
  );
  const signature = await hmac(workerKey, payload);
  return {
    issuedAt,
    token: `${base64Url(payload)}.${base64Url(signature)}`,
  };
}

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function base64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function nextJsonWebSocketMessage(socket, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for ${label}`));
    }, 5_000);
    const onMessage = (event) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      try {
        resolve(JSON.parse(event.data));
      } catch (error) {
        reject(new Error(`${label} was not JSON: ${error.message}`));
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openDetachedRealtimeBridge(stub, session) {
  const handoff = JSON.stringify({
    url: "https://realtime-provider.invalid/v1/realtime",
    auth_mode: "authorization_bearer",
    protocol: [],
    headers: [{ name: "authorization", value: "Bearer runtime-test-secret" }],
    mock_upstream_fault: "runtime_detached",
  });
  const response = await stub.fetch(
    `https://realtime-session.internal/api/platform/realtime/${session}`,
    {
      headers: {
        Upgrade: "websocket",
        "x-cinatoken-realtime-upstream-connect": handoff,
      },
    },
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  response.webSocket.accept();
  return response.webSocket;
}

async function openRealtimeSession(stub, session) {
  const response = await stub.fetch(
    `https://realtime-session.internal/api/platform/realtime/${session}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  response.webSocket.accept();
  return response.webSocket;
}

async function waitForDetachedBridge(socket, expectedProviderCount) {
  const deadline = Date.now() + 5_000;
  let lastStatus;
  while (Date.now() < deadline) {
    const message = nextJsonWebSocketMessage(socket, "detached bridge status");
    socket.send("status");
    lastStatus = await message;
    const provider = await providerState();
    if (
      lastStatus.active_upstream_bridges === 0 &&
      provider.count === expectedProviderCount
    ) {
      return lastStatus;
    }
    await delay(10);
  }
  throw new Error(`runtime bridge did not detach: ${JSON.stringify(lastStatus)}`);
}

function realtimeSessionStatus(stub, session) {
  return stub
    .fetch(`https://realtime-session.internal/api/platform/realtime/${session}/status`)
    .then((response) => response.json());
}

function providerState() {
  return env.REALTIME_PROVIDER_MOCK.fetch(
    "https://realtime-provider-mock/__mock/state",
  ).then((response) => response.json());
}

async function seedRealtimeBillingAccount() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, username, password, quota) VALUES (1, 'runtime-user', 'x', 900)",
    ),
    env.DB.prepare(
      "INSERT INTO tokens (id, user_id, key, remain_quota, used_quota) VALUES (1, 1, 'runtime-token', 400, 100)",
    ),
  ]);
}

async function seedRealtimeReservation({
  reservationKey,
  session,
  bridgeSegment,
  leaseExpiresAt,
}) {
  await env.DB.prepare(
    `INSERT INTO realtime_billing_reservations (
      reservation_key, session, bridge_segment, client_event_id_hash,
      reservation_sequence, user_id, token_id, channel_id, selected_group,
      model_name, pre_consumed_quota, snapshot_json, request_json,
      status, created_at, updated_at, lease_expires_at
    ) VALUES (?1, ?2, ?3, 'runtime-event-hash', 1, 1, 1, 42, 'default',
      'gpt-4o-realtime-preview', 100, '{}', '{}', 'reserved', 1, 1, ?4)`,
  )
    .bind(reservationKey, session, bridgeSegment, leaseExpiresAt)
    .run();
}

async function realtimeBillingState(reservationKey) {
  const [reservation, user, token] = await Promise.all([
    env.DB.prepare(
      "SELECT status, bridge_segment, refunded_at FROM realtime_billing_reservations WHERE reservation_key = ?1",
    )
      .bind(reservationKey)
      .first(),
    env.DB.prepare("SELECT quota FROM users WHERE id = 1").first(),
    env.DB.prepare(
      "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
    ).first(),
  ]);
  return { reservation, user, token };
}

async function waitForRealtimeRefund(reservationKey) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    state = await realtimeBillingState(reservationKey);
    if (state.reservation?.status === "refunded") return state;
    await delay(10);
  }
  throw new Error(`realtime reservation was not refunded: ${JSON.stringify(state)}`);
}

function nextWebSocketClose(socket, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", onClose);
      reject(new Error(`timed out waiting for ${label}`));
    }, 15_000);
    const onClose = (event) => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
    socket.addEventListener("close", onClose);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`timed out waiting for ${label}`);
    }),
  ]);
}
