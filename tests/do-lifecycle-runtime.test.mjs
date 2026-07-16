import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  evictDurableObject,
  getQueueResult,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  queue as runQueue,
  scheduled as runScheduled,
} from "./fixtures/do-runtime-worker.mjs";

const authoritySecret = "0123456789abcdef0123456789abcdef";
const workerName = "tenant-runtime-test";
const taskRunnerRecordKey = "task_runner_record_v1";
const quotaCoordinatorStateKey = "quota_coordinator_state_v1";
const quotaTokenIdHeader = "x-cinatoken-quota-token-id";
const wfpRouteHeader = "x-cinatoken-wfp-route";
const wfpWorkerHeader = "x-cinatoken-wfp-worker";
const realtimeModel = "gpt-4o-realtime-preview";
const realtimeToken = "sk-runtime-authenticated-realtime";
const relayStreamModel = "gpt-runtime-stream";
const relayStreamToken = "sk-runtime-stream-billing";
const relayStreamErrorModel = "gpt-runtime-stream-error";
const relayStreamErrorToken = "sk-runtime-stream-error-billing";
const relayStreamUsageErrorModel = "gpt-runtime-stream-usage-error";
const relayStreamUsageErrorToken = "sk-runtime-stream-usage-error-billing";
const relayNonStreamAuditLimitModel = "gpt-runtime-non-stream-audit-limit";
const relayNonStreamAuditLimitToken = "sk-runtime-non-stream-audit-limit";
const relayZeroReserveModel = "gpt-runtime-zero-reserve";
const relayZeroReserveToken = "sk-runtime-zero-reserve";
const relayFlatAuditLimitModel = "gpt-runtime-flat-audit-limit";
const relayFlatAuditLimitToken = "sk-runtime-flat-audit-limit";
const relayFixedAudioModel = "tts-runtime-fixed-price";
const relayFixedAudioToken = "sk-runtime-fixed-audio";
const relayPcmAudioModel = "gpt-runtime-tts-pcm";
const relayPcmAudioToken = "sk-runtime-pcm-audio";
const relayOversizedAudioModel = "gpt-runtime-tts-oversized";
const relayOversizedAudioToken = "sk-runtime-oversized-audio";
const relayOpenRouterCostModel = "gpt-4.1";
const relayOpenRouterCostToken = "sk-runtime-openrouter-cost";
const relayUnsetModel = "gpt-runtime-unset-model";
const relayUnsetToken = "sk-runtime-unset-model";
const relayCohereConsumedLimitModel = "rerank-runtime-cohere-consumed-limit";
const relayCohereConsumedLimitToken = "sk-runtime-cohere-consumed-limit";

afterEach(async () => {
  await reset();
});

afterAll(async () => {
  // Controlled Queue/DO failures can finish logging after their assertions.
  // Keep Vitest's RPC channel alive until those runtime tasks have quiesced.
  await delay(1_000);
});

describe("Rust Durable Object lifecycle contracts", () => {
  it("applies quota reserve replay and settle atomically across eviction", async () => {
    const tokenId = 701;
    const reservationFingerprint = quotaHex("b");
    const stub = quotaCoordinatorStub(tokenId);
    const reserve = {
      contract_version: 1,
      kind: "reserve",
      operation_id: quotaHex("a"),
      reservation_fingerprint: reservationFingerprint,
      generation: 1,
      reserved_quota: 120,
      final_quota: 0,
      request_count: 0,
    };

    expect((await observeQuota(stub, tokenId, reserve)).status).toBe(204);
    const afterReserve = await quotaCoordinatorStatus(stub, tokenId);
    expect(afterReserve.response.status).toBe(200);
    expect(afterReserve.status).toMatchObject({
      contract_version: 1,
      observation_count: 1,
      applied_count: 1,
      replay_count: 0,
      conflict_count: 0,
      reserve_count: 1,
      settle_count: 0,
      active_reservations: 1,
      terminal_reservations: 0,
      outstanding_quota: 120,
      reserved_quota: 120,
      final_quota: 0,
    });
    expect(afterReserve.status.reservations).toBeUndefined();
    expect(JSON.stringify(afterReserve.status)).not.toContain(
      reservationFingerprint,
    );

    expect((await observeQuota(stub, tokenId, reserve)).status).toBe(204);
    const afterReplay = await quotaCoordinatorStatus(stub, tokenId);
    expect(afterReplay.status).toMatchObject({
      observation_count: 2,
      applied_count: 1,
      replay_count: 1,
      conflict_count: 0,
      active_reservations: 1,
      outstanding_quota: 120,
    });
    expect(
      (
        await observeQuota(stub, tokenId, {
          ...reserve,
          reserved_quota: 121,
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await observeQuota(stub, tokenId, {
          contract_version: 1,
          kind: "settle",
          operation_id: quotaHex("c"),
          reservation_fingerprint: reservationFingerprint,
          generation: 2,
          reserved_quota: 120,
          final_quota: 75,
          request_count: 1,
        })
      ).status,
    ).toBe(204);
    const afterSettle = await quotaCoordinatorStatus(stub, tokenId);
    expect(afterSettle.status).toMatchObject({
      contract_version: 1,
      observation_count: 4,
      applied_count: 2,
      replay_count: 1,
      conflict_count: 1,
      reserve_count: 1,
      settle_count: 1,
      refund_count: 0,
      active_reservations: 0,
      terminal_reservations: 1,
      outstanding_quota: 0,
      reserved_quota: 120,
      final_quota: 75,
      user_net_delta: -75,
      token_net_delta: -75,
      channel_used_quota: 75,
      request_count: 1,
    });
    expect(JSON.stringify(afterSettle.status)).not.toContain(
      reservationFingerprint,
    );

    await evictDurableObject(stub);
    const afterEviction = await quotaCoordinatorStatus(stub, tokenId);
    expect(afterEviction.response.status).toBe(200);
    expect(afterEviction.status).toEqual(afterSettle.status);
  });

  it("compacts quota terminal history and rejects expired replays", async () => {
    const tokenId = 704;
    const stub = quotaCoordinatorStub(tokenId);
    const firstReserve = {
      contract_version: 1,
      kind: "reserve",
      operation_id: quotaHex("1"),
      reservation_fingerprint: quotaHex("a"),
      generation: 1,
      reserved_quota: 10,
      final_quota: 0,
      request_count: 0,
      source_committed_at: 100,
    };
    const firstSettle = {
      ...firstReserve,
      kind: "settle",
      operation_id: quotaHex("2"),
      generation: 2,
      final_quota: 8,
      request_count: 1,
      source_committed_at: 200,
    };
    expect((await observeQuota(stub, tokenId, firstReserve)).status).toBe(204);
    expect((await observeQuota(stub, tokenId, firstSettle)).status).toBe(204);

    await runInDurableObject(stub, async (_instance, state) => {
      const persisted = await state.storage.get(quotaCoordinatorStateKey);
      persisted.max_active_reservations = 1;
      persisted.max_terminal_reservations = 1;
      await state.storage.put(quotaCoordinatorStateKey, persisted);
      return new Response(null);
    });

    const secondReserve = {
      ...firstReserve,
      operation_id: quotaHex("3"),
      reservation_fingerprint: quotaHex("b"),
      reserved_quota: 20,
      source_committed_at: 300,
    };
    const secondRefund = {
      ...secondReserve,
      kind: "refund",
      operation_id: quotaHex("4"),
      generation: 2,
      request_count: 0,
      source_committed_at: 400,
    };
    expect((await observeQuota(stub, tokenId, secondReserve)).status).toBe(204);
    expect((await observeQuota(stub, tokenId, secondRefund)).status).toBe(204);

    let result = await quotaCoordinatorStatus(stub, tokenId);
    expect(result.status).toMatchObject({
      observation_count: 4,
      applied_count: 4,
      terminal_reservations: 2,
      retained_terminal_reservations: 1,
      compacted_terminal_reservations: 1,
      legacy_terminal_reservations: 0,
      retention_watermark_committed_at: 200,
      persisted_state_json_limit_bytes: 1_500_000,
    });
    expect(result.status.persisted_state_json_bytes).toBeLessThan(1_500_000);

    expect((await observeQuota(stub, tokenId, firstReserve)).status).toBe(409);
    expect((await observeQuota(stub, tokenId, secondRefund)).status).toBe(204);
    result = await quotaCoordinatorStatus(stub, tokenId);
    expect(result.status).toMatchObject({
      observation_count: 6,
      applied_count: 4,
      replay_count: 1,
      conflict_count: 1,
      reserved_quota: 30,
      final_quota: 8,
      refunded_quota: 22,
    });

    await evictDurableObject(stub);
    expect((await quotaCoordinatorStatus(stub, tokenId)).status).toEqual(
      result.status,
    );
  });

  it("serializes concurrent quota observations for one token", async () => {
    const tokenId = 703;
    const stub = quotaCoordinatorStub(tokenId);
    const reservationIds = [..."12345678"];
    const fingerprintIds = [..."abcdef01"];
    const reserves = reservationIds.map((id, index) => ({
      contract_version: 1,
      kind: "reserve",
      operation_id: quotaHex(id),
      reservation_fingerprint: quotaHex(fingerprintIds[index]),
      generation: 1,
      reserved_quota: 10 + index,
      final_quota: 0,
      request_count: 0,
    }));

    const reserveResponses = await Promise.all(
      reserves.map((observation) => observeQuota(stub, tokenId, observation)),
    );
    expect(reserveResponses.map(({ status }) => status)).toEqual(
      Array(8).fill(204),
    );

    const terminal = {
      ...reserves[0],
      kind: "settle",
      operation_id: quotaHex("9"),
      generation: 2,
      final_quota: 7,
      request_count: 1,
    };
    const terminalResponses = await Promise.all(
      Array.from({ length: 8 }, () => observeQuota(stub, tokenId, terminal)),
    );
    expect(terminalResponses.map(({ status }) => status)).toEqual(
      Array(8).fill(204),
    );

    const { status } = await quotaCoordinatorStatus(stub, tokenId);
    expect(status).toMatchObject({
      observation_count: 16,
      applied_count: 9,
      replay_count: 7,
      conflict_count: 0,
      reserve_count: 8,
      settle_count: 1,
      active_reservations: 7,
      terminal_reservations: 1,
      final_quota: 7,
      request_count: 1,
    });
  });

  it("enforces the quota observer protocol and propagates corrupt state", async () => {
    const tokenId = 702;
    const stub = quotaCoordinatorStub(tokenId);
    const headers = { [quotaTokenIdHeader]: `${tokenId}` };

    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/observe", {
          method: "GET",
          headers,
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/observe", {
          method: "POST",
          headers: { ...headers, "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/observe", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{not-json}",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/observe", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: `"${"x".repeat(16 * 1024)}"`,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/status", {
          headers,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await stub.fetch("https://quota-coordinator.internal/status", {
          headers: { [quotaTokenIdHeader]: `${tokenId + 1}` },
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await observeQuota(stub, tokenId, {
          contract_version: 1,
          kind: "settle",
          operation_id: quotaHex("d"),
          reservation_fingerprint: quotaHex("e"),
          generation: 2,
          reserved_quota: 1,
          final_quota: 1,
          request_count: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await observeQuota(stub, tokenId, {
          contract_version: 1,
          kind: "reserve",
          operation_id: quotaHex("f"),
          reservation_fingerprint: quotaHex("1"),
          generation: 1,
          reserved_quota: -1,
          final_quota: 0,
          request_count: 0,
        })
      ).status,
    ).toBe(422);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(quotaCoordinatorStateKey, {
        contract_version: "corrupt",
      });
      return new Response(null);
    });
    await expect(
      stub.fetch("https://quota-coordinator.internal/status", { headers }),
    ).rejects.toThrow(/failed to decode QuotaCoordinator storage/u);
  });

  it("allows exactly one concurrent authority replay winner", async () => {
    const authority = await signedAuthority({
      requestId: "runtime-concurrent",
    });
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

    const beforeMessage = nextJsonWebSocketMessage(
      socket,
      "pre-eviction status",
    );
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

    const afterMessage = nextJsonWebSocketMessage(
      socket,
      "post-eviction status",
    );
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
    const account = await seedAuthenticatedRealtimeGateway();
    const first = await openAuthenticatedRealtimeSession();
    const initialStatusMessage = nextJsonWebSocketMessage(
      first,
      "authenticated Realtime attachment status",
    );
    first.send("status");
    const initialStatus = await initialStatusMessage;
    const session = initialStatus.context.session;
    const firstSegment = initialStatus.context.bridge_segment;
    const stub = env.REALTIME_SESSIONS.getByName(session);
    expect(initialStatus.context).toMatchObject({
      entrypoint: "openai_realtime_v1",
      auth_state: "gateway_checked",
      upstream_connect_handoff: true,
    });
    expect(session).toMatch(/^rt-[a-f0-9]{16}$/u);

    first.send(
      JSON.stringify({
        type: "response.create",
        event_id: "runtime-authenticated-reservation",
        response: { instructions: "runtime reservation proof" },
      }),
    );
    const reserved = await waitForRealtimeReservation(session);
    const reservationKey = reserved.reservation.reservation_key;
    expect(reserved).toMatchObject({
      reservation: {
        status: "reserved",
        bridge_segment: firstSegment,
        reservation_sequence: 1,
      },
      user: {
        quota: account.userQuota - reserved.reservation.pre_consumed_quota,
      },
      token: {
        remain_quota:
          account.tokenRemainQuota - reserved.reservation.pre_consumed_quota,
        used_quota: reserved.reservation.pre_consumed_quota,
      },
    });
    expect(reserved.reservation.pre_consumed_quota).toBeGreaterThan(0);
    await waitForDetachedBridge(first, 1);

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
    const terminalClose = nextWebSocketClose(
      first,
      "reconstructed upstream close",
    );
    first.send(
      JSON.stringify({
        type: "session.update",
        session: { modalities: ["text"] },
      }),
    );

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
      user: { quota: account.userQuota },
      token: { remain_quota: account.tokenRemainQuota, used_quota: 0 },
    });
    expect(await providerState()).toMatchObject({
      count: 1,
      path: "/v1/realtime",
    });

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
    const secondStatusMessage = nextJsonWebSocketMessage(
      second,
      "new bridge segment status",
    );
    second.send("status");
    const secondStatus = await secondStatusMessage;
    expect(secondStatus.context.bridge_segment).not.toBe(firstSegment);
    expect(await providerState()).toMatchObject({
      count: 1,
      path: "/v1/realtime",
    });
    await expect(realtimeBillingState(reservationKey)).resolves.toMatchObject({
      reservation: { status: "refunded", bridge_segment: firstSegment },
      user: { quota: account.userQuota },
      token: { remain_quota: account.tokenRemainQuota, used_quota: 0 },
    });
    second.close(1000, "test complete");
  }, 30_000);

  it("quarantines Realtime response.done with null usage without refunding the reservation", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );
    const account = await seedAuthenticatedRealtimeGateway({
      mockFault: null,
      upstreamModel: "gpt-runtime-realtime-usage-null",
    });
    const socket = await openAuthenticatedRealtimeSession();
    const statusMessage = nextJsonWebSocketMessage(
      socket,
      "usage reconciliation session status",
    );
    socket.send("status");
    const status = await statusMessage;
    const session = status.context.session;
    const received = [];
    const collectMessage = (event) => {
      try {
        received.push(JSON.parse(event.data));
      } catch {
        // This scenario only asserts JSON server events.
      }
    };
    socket.addEventListener("message", collectMessage);
    const reconciliationError = nextJsonWebSocketMessageMatching(
      socket,
      (message) =>
        message?.error?.code === "billing_usage_reconciliation_required",
      "usage reconciliation error",
    );
    const terminalClose = nextWebSocketClose(
      socket,
      "usage reconciliation close",
    );

    socket.send(
      JSON.stringify({
        type: "response.create",
        event_id: "runtime-null-usage-reservation",
        response: { instructions: "runtime null usage proof" },
      }),
    );
    const reserved = await waitForRealtimeReservation(session);
    const reservationKey = reserved.reservation.reservation_key;
    expect(reserved.reservation.pre_consumed_quota).toBeGreaterThan(0);
    await expect(reconciliationError).resolves.toMatchObject({
      type: "error",
      error: {
        type: "server_error",
        code: "billing_usage_reconciliation_required",
      },
    });
    await expect(terminalClose).resolves.toMatchObject({
      code: 1011,
      reason: "upstream_bridge_event_stream_failed",
    });
    socket.removeEventListener("message", collectMessage);
    expect(received.some((message) => message.type === "response.done")).toBe(
      false,
    );

    const quarantined = await realtimeBillingState(reservationKey);
    expect(quarantined).toMatchObject({
      reservation: {
        status: "reserved",
        finalization_owner: "usage_reconciliation",
        finalization_reason: "response_usage_null",
        refunded_at: 0,
      },
      user: {
        quota: account.userQuota - reserved.reservation.pre_consumed_quota,
      },
      token: {
        remain_quota:
          account.tokenRemainQuota - reserved.reservation.pre_consumed_quota,
        used_quota: reserved.reservation.pre_consumed_quota,
      },
    });
    expect(quarantined.reservation.finalization_required_at).toBeGreaterThan(0);
    const mutationsBeforeRecovery = await realtimeBillingMutationCounts();
    expect(mutationsBeforeRecovery).toEqual({ replayCount: 0, auditCount: 0 });

    await env.DB.prepare(
      "UPDATE realtime_billing_reservations SET lease_expires_at = ?1 WHERE reservation_key = ?2",
    )
      .bind(Math.floor(Date.now() / 1000) - 3_600, reservationKey)
      .run();
    await runScheduledRecovery();
    await expect(realtimeBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "reserved",
        finalization_owner: "usage_reconciliation",
        finalization_reason: "response_usage_null",
        refunded_at: 0,
      },
      user: quarantined.user,
      token: quarantined.token,
    });
    await expect(realtimeBillingMutationCounts()).resolves.toEqual({
      replayCount: 0,
      auditCount: 0,
    });

    const { cookie, password } = await setupAndLoginBillingRoot();
    const queueResponse = await SELF.fetch(
      "https://cinatoken.test/api/platform/realtime-billing/reconciliations?limit=50",
      { headers: { cookie } },
    );
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.headers.get("cache-control")).toBe("no-store");
    const queueText = await queueResponse.text();
    expect(queueText).not.toContain(reservationKey);
    const queue = JSON.parse(queueText);
    expect(queue).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        count: 1,
        next_cursor: null,
        records: [
          {
            reconciliation_revision: 1,
            quarantine_reason: "response_usage_null",
            pre_consumed_quota: reserved.reservation.pre_consumed_quota,
          },
        ],
      },
    });
    const reconciliationId = queue.data.records[0].reconciliation_id;
    expect(reconciliationId).toMatch(/^[a-f0-9]{64}$/u);
    const decision = {
      action: "refund",
      reason: "provider_confirms_no_billable_usage",
      evidence_reference: "provider:usage/runtime-null-1",
      usage: null,
    };
    const previewUrl =
      `https://cinatoken.test/api/platform/realtime-billing/reconciliations/` +
      `${reconciliationId}/preview`;
    const previewResponse = await SELF.fetch(previewUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("no-store");
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      success: true,
      data: {
        reconciliation_id: reconciliationId,
        reconciliation_revision: 1,
        action: "refund",
        quarantine_reason: "response_usage_null",
        pricing_source: "reserved_quota_refund",
        pre_consumed_quota: reserved.reservation.pre_consumed_quota,
        final_quota: 0,
        refund_quota: reserved.reservation.pre_consumed_quota,
        additional_quota: 0,
        settlement: null,
      },
    });
    expect(preview.data.preview_token).toMatch(/^[a-f0-9]{64}$/u);
    const applyUrl =
      `https://cinatoken.test/api/platform/realtime-billing/reconciliations/` +
      `${reconciliationId}/apply`;
    const applyBody = {
      ...decision,
      preview_token: preview.data.preview_token,
      idempotency_key: "runtime-null-refund-1",
      confirm_resolution: true,
    };
    const unverified = await SELF.fetch(applyUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    expect(unverified.status).toBe(403);

    const verified = await SELF.fetch("https://cinatoken.test/api/verify", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ method: "password", password }),
    });
    expect(verified.status).toBe(200);

    const applied = await SELF.fetch(applyUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      success: true,
      data: {
        reconciliation_id: reconciliationId,
        action: "refund",
        status: "applied",
        reconciliation_revision: 2,
      },
    });
    await expect(realtimeBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "refunded",
        finalization_owner: "",
        finalization_reason: "response_usage_null",
        reconciliation_resolution: "refunded",
        reconciliation_revision: 2,
      },
      user: { quota: account.userQuota },
      token: { remain_quota: account.tokenRemainQuota, used_quota: 0 },
    });
    const adminAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM logs
       WHERE type = 3 AND other LIKE '%realtime_billing.reconciliation_resolved%'`,
    ).first();
    expect(Number(adminAudit?.count ?? 0)).toBe(1);

    const duplicate = await SELF.fetch(applyUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: "duplicate",
        reconciliation_revision: 2,
      },
    });
    const queueAfter = await SELF.fetch(
      "https://cinatoken.test/api/platform/realtime-billing/reconciliations?limit=50",
      { headers: { cookie } },
    );
    await expect(queueAfter.json()).resolves.toMatchObject({
      success: true,
      data: { count: 0, records: [] },
    });
  }, 30_000);

  it("settles quarantined Realtime usage from the frozen billing expression", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );
    const account = await seedAuthenticatedRealtimeGateway({
      mockFault: null,
      upstreamModel: "gpt-runtime-realtime-usage-null",
    });
    const socket = await openAuthenticatedRealtimeSession();
    const statusMessage = nextJsonWebSocketMessage(
      socket,
      "usage settlement session status",
    );
    socket.send("status");
    const session = (await statusMessage).context.session;
    const reconciliationError = nextJsonWebSocketMessageMatching(
      socket,
      (message) =>
        message?.error?.code === "billing_usage_reconciliation_required",
      "usage settlement reconciliation error",
    );
    const terminalClose = nextWebSocketClose(
      socket,
      "usage settlement reconciliation close",
    );

    socket.send(
      JSON.stringify({
        type: "response.create",
        event_id: "runtime-null-usage-settlement",
        response: { instructions: "runtime operator settlement proof" },
      }),
    );
    const reserved = await waitForRealtimeReservation(session);
    const reservationKey = reserved.reservation.reservation_key;
    await expect(reconciliationError).resolves.toMatchObject({
      error: { code: "billing_usage_reconciliation_required" },
    });
    await expect(terminalClose).resolves.toMatchObject({ code: 1011 });

    const { cookie, password } = await setupAndLoginBillingRoot();
    const queueResponse = await SELF.fetch(
      "https://cinatoken.test/api/platform/realtime-billing/reconciliations?limit=50",
      { headers: { cookie } },
    );
    const queue = await queueResponse.json();
    const reconciliationId = queue.data.records[0].reconciliation_id;
    const decision = {
      action: "settle",
      reason: "provider_usage_verified",
      evidence_reference: "provider:usage/runtime-settle-1",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cached_tokens: 2,
        cache_creation_tokens: 0,
        image_input_tokens: 0,
        image_output_tokens: 0,
        audio_input_tokens: 0,
        audio_output_tokens: 0,
      },
    };
    const previewUrl =
      `https://cinatoken.test/api/platform/realtime-billing/reconciliations/` +
      `${reconciliationId}/preview`;
    const previewResponse = await SELF.fetch(previewUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      success: true,
      data: {
        reconciliation_id: reconciliationId,
        action: "settle",
        pricing_source: "frozen_tiered_snapshot",
        settlement: {
          expr_version: 1,
          matched_tier: "runtime_realtime",
          actual_prompt_tokens: 10,
          actual_completion_tokens: 5,
          actual_total_tokens: 15,
        },
      },
    });
    const expectedFinalQuota = preview.data.final_quota;
    expect(expectedFinalQuota).toBeGreaterThan(0);

    const verified = await SELF.fetch("https://cinatoken.test/api/verify", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ method: "password", password }),
    });
    expect(verified.status).toBe(200);
    const applyUrl =
      `https://cinatoken.test/api/platform/realtime-billing/reconciliations/` +
      `${reconciliationId}/apply`;
    const applied = await SELF.fetch(applyUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ...decision,
        preview_token: preview.data.preview_token,
        idempotency_key: "runtime-null-settlement-1",
        confirm_resolution: true,
      }),
    });
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      success: true,
      data: {
        reconciliation_id: reconciliationId,
        action: "settle",
        status: "applied",
        reconciliation_revision: 2,
      },
    });
    await expect(realtimeBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "settled",
        final_quota: expectedFinalQuota,
        finalization_owner: "",
        finalization_reason: "response_usage_null",
        reconciliation_resolution: "settled",
        reconciliation_revision: 2,
      },
      user: { quota: account.userQuota - expectedFinalQuota },
      token: {
        remain_quota: account.tokenRemainQuota - expectedFinalQuota,
        used_quota: expectedFinalQuota,
      },
    });
    const accounting = await env.DB.prepare(
      `SELECT
         (SELECT used_quota FROM channels WHERE id = 42) AS channel_used_quota,
         (SELECT COUNT(*) FROM realtime_settlement_replays
          WHERE replay_key = (
            SELECT reconciliation_resolution_key
            FROM realtime_billing_reservations
            WHERE reservation_key = ?1
          ) AND status = 'applied') AS replay_count,
         (SELECT COUNT(*) FROM logs WHERE type = 2 AND model_name = ?2) AS billing_audit_count,
         (SELECT COUNT(*) FROM logs WHERE type = 3
          AND other LIKE '%realtime_billing.reconciliation_resolved%') AS admin_audit_count`,
    )
      .bind(reservationKey, realtimeModel)
      .first();
    expect(accounting).toMatchObject({
      channel_used_quota: expectedFinalQuota,
      replay_count: 1,
      billing_audit_count: 1,
      admin_audit_count: 1,
    });
  }, 30_000);

  it("rejects an unbillable Realtime upgrade before provider or ledger mutation", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );
    const account = await seedAuthenticatedRealtimeGateway();
    await env.DB.prepare(
      `UPDATE options SET value = '{}' WHERE "key" = 'billing_setting.billing_expr'`,
    ).run();

    const response = await SELF.fetch(
      `https://worker.test/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
      {
        headers: {
          Authorization: `Bearer ${realtimeToken}`,
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "cnVudGltZS1yZWFsdGltZQ==",
        },
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "realtime_billing_mode_unsupported",
      },
    });
    expect(await providerState()).toMatchObject({ count: 0 });

    const [user, token, channel, reservations] = await Promise.all([
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = 1",
      ).first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = 42").first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM realtime_billing_reservations",
      ).first(),
    ]);
    expect(user).toMatchObject({
      quota: account.userQuota,
      used_quota: 0,
      request_count: 0,
    });
    expect(token).toMatchObject({
      remain_quota: account.tokenRemainQuota,
      used_quota: 0,
    });
    expect(channel).toMatchObject({ used_quota: 0 });
    expect(reservations).toMatchObject({ count: 0 });
  });

  it("globally refunds an expired Realtime reservation once through scheduled recovery", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount();
    const now = Math.floor(Date.now() / 1000);
    const expiredKey = "rtreserve-runtime-global-expired";
    await seedRealtimeReservation({
      reservationKey: expiredKey,
      session: "runtime-global-expired",
      bridgeSegment: "rtsegment-runtime-global-expired",
      leaseExpiresAt: now - 1,
    });

    await runScheduledRecovery();
    await expect(realtimeBillingState(expiredKey)).resolves.toMatchObject({
      reservation: { status: "reserved" },
      user: { quota: 900 },
      token: { remain_quota: 400, used_quota: 100 },
    });
    await env.DB.prepare(
      "UPDATE realtime_billing_reservations SET lease_expires_at = ?1 WHERE reservation_key = ?2",
    )
      .bind(now - 301, expiredKey)
      .run();

    await Promise.all([runScheduledRecovery(), runScheduledRecovery()]);
    await expect(waitForRealtimeRefund(expiredKey)).resolves.toMatchObject({
      reservation: { status: "refunded" },
      user: { quota: 1_000 },
      token: { remain_quota: 500, used_quota: 0 },
    });
    await runScheduledRecovery();
    await expect(realtimeBillingState(expiredKey)).resolves.toMatchObject({
      reservation: { status: "refunded" },
      user: { quota: 1_000 },
      token: { remain_quota: 500, used_quota: 0 },
    });
  }, 30_000);

  it("defers a failed orphan so a newer valid reservation can recover", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount({
      userQuota: 800,
      tokenRemainQuota: 300,
      tokenUsedQuota: 200,
    });
    const now = Math.floor(Date.now() / 1000);
    const blockedKey = "rtreserve-runtime-blocked";
    const recoverableKey = "rtreserve-runtime-recoverable";
    await seedRealtimeReservation({
      reservationKey: blockedKey,
      session: "runtime-blocked",
      bridgeSegment: "rtsegment-runtime-blocked",
      leaseExpiresAt: now - 302,
    });
    await env.DB.prepare(
      "UPDATE realtime_billing_reservations SET user_id = 999 WHERE reservation_key = ?1",
    )
      .bind(blockedKey)
      .run();
    await seedRealtimeReservation({
      reservationKey: recoverableKey,
      session: "runtime-recoverable",
      bridgeSegment: "rtsegment-runtime-recoverable",
      leaseExpiresAt: now - 301,
    });

    await runScheduledRecovery();
    await expect(realtimeBillingState(blockedKey)).resolves.toMatchObject({
      reservation: { status: "reserved", recovery_attempt_count: 1 },
      user: { quota: 800 },
      token: { remain_quota: 300, used_quota: 200 },
    });
    await runScheduledRecovery();
    await expect(waitForRealtimeRefund(recoverableKey)).resolves.toMatchObject({
      reservation: { status: "refunded" },
      user: { quota: 900 },
      token: { remain_quota: 400, used_quota: 100 },
    });
    await expect(realtimeBillingState(blockedKey)).resolves.toMatchObject({
      reservation: { status: "reserved", recovery_attempt_count: 1 },
    });
  }, 30_000);

  it("keeps an expired unbound HTTP reservation untouched until reconciliation is ready", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount();
    const reservationKey = "relayreserve-runtime-unbound-expired";
    const now = Math.floor(Date.now() / 1000);
    await seedRelayBillingReservation({
      reservationKey,
      leaseExpiresAt: now - 301,
    });

    await Promise.all([runScheduledRecovery(), runScheduledRecovery()]);
    await expect(relayBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "reserved",
        finalization_reason: "",
        request_accounted: 0,
      },
      user: { quota: 900, request_count: 0 },
      token: { remain_quota: 400, used_quota: 100 },
    });

    await runScheduledRecovery();
    await expect(relayBillingState(reservationKey)).resolves.toMatchObject({
      reservation: { status: "reserved", request_accounted: 0 },
      user: { quota: 900, request_count: 0 },
      token: { remain_quota: 400, used_quota: 100 },
    });
  }, 30_000);

  it("keeps an expired bound HTTP reservation untouched until reconciliation is ready", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount();
    const reservationKey = "relayreserve-runtime-bound-expired";
    const now = Math.floor(Date.now() / 1000);
    await seedRelayBillingReservation({
      reservationKey,
      leaseExpiresAt: now - 301,
      bound: true,
    });

    await Promise.all([runScheduledRecovery(), runScheduledRecovery()]);
    await expect(relayBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "reserved",
        finalization_reason: "",
        request_accounted: 0,
      },
      user: { quota: 900, request_count: 0 },
      token: { remain_quota: 400, used_quota: 100 },
    });
  }, 30_000);

  it("reports HTTP pre-bind owner fencing without claiming staging cutover", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const { cookie } = await setupAndLoginBillingRoot();

    const response = await SELF.fetch(
      "https://cinatoken.test/api/platform/capabilities",
      { headers: { cookie } },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: {
        d1_migration_applied_count: 43,
        d1_expected_migration:
          "0043_relay_container_reconciliation_observer.sql",
        d1_migration_ready: true,
        task_v2_contract_version: 5,
        task_submit_operation_contract_version: 1,
        task_submit_operation_compiled: true,
        task_submit_operation_schema_ready: true,
        task_submit_timeout_configured: true,
        task_submit_timeout_valid: true,
        task_submit_timeout_seconds: 90,
        task_submit_client_idempotency_compiled: true,
        task_submit_client_idempotency_required: true,
        task_submit_status_query_compiled: true,
        task_submit_local_operation_unique: true,
        task_submit_provider_native_idempotency_verified: false,
        task_submit_provider_lookup_verified: false,
        task_submit_operation_cutover_ready: false,
        task_poll_scheduler_contract_version: 1,
        task_poll_scheduler_compiled: true,
        task_poll_scheduler_schema_ready: true,
        task_poll_scheduler_enabled: true,
        task_poll_scheduler_runtime_ready: false,
        task_poll_scheduler_staging_verified: false,
        task_poll_scheduler_cutover_ready: false,
        task_poll_recovery_contract_version: 2,
        task_poll_recovery_compiled: true,
        task_poll_recovery_schema_ready: true,
        task_poll_recovery_enabled: true,
        task_poll_recovery_runtime_ready: false,
        task_poll_recovery_staging_verified: false,
        task_poll_recovery_cutover_ready: false,
        task_poller_retry_base_seconds: 15,
        task_poller_retry_max_seconds: 900,
        task_poller_max_consecutive_failures: 8,
        relay_billing_prebind_owner_generation_contract_version: 1,
        relay_billing_prebind_owner_generation_compiled: true,
        relay_billing_prebind_owner_generation_schema_ready: true,
        relay_billing_prebind_owner_deadline_configured: true,
        relay_billing_prebind_owner_deadline_valid: true,
        relay_billing_prebind_owner_deadline_seconds: 300,
        relay_billing_prebind_owner_generation_configured: true,
        relay_billing_prebind_owner_generation_staging_verified: false,
        relay_billing_prebind_owner_generation_cutover_ready: false,
        relay_billing_orphan_recovery_ready: false,
        relay_billing_orphan_recovery_cutover_ready: false,
        quota_coordinator_contract_version: 1,
        quota_coordinator_do_available: true,
        quota_coordinator_shadow_enabled: true,
        quota_coordinator_foundation_compiled: true,
        quota_coordinator_observer_contract_compiled: true,
        quota_coordinator_reserve_observation_compiled: true,
        quota_coordinator_finalization_observation_compiled: true,
        quota_coordinator_recovery_observation_compiled: true,
        quota_coordinator_relay_observation_compiled: true,
        quota_coordinator_retention_compaction_compiled: true,
        quota_coordinator_reconciliation_compiled: true,
        quota_coordinator_reconciliation_runtime_ready: true,
        quota_coordinator_storage_retention_ready: true,
        quota_coordinator_shadow_token_allowlist_configured: true,
        quota_coordinator_shadow_token_allowlist_valid: true,
        quota_coordinator_shadow_token_count: 1,
        quota_coordinator_tiered_only: false,
        quota_coordinator_reservation_ledger_only: true,
        quota_coordinator_write_authority_enabled: false,
        quota_coordinator_staging_verified: false,
        quota_coordinator_shadow_runtime_ready: true,
        quota_coordinator_cutover_ready: false,
      },
    });
    expect(payload.data.quota_coordinator_cutover_guards).toEqual([
      "quota_coord_binding",
      "shadow_gate",
      "reservation_ledger_only",
      "observer_contract",
      "relay_observation",
      "bounded_retention",
      "shadow_reconciliation",
      "staging_shadow_bake",
      "write_authority",
    ]);
    expect(
      payload.data.relay_billing_prebind_owner_generation_cutover_guards,
    ).toEqual([
      "migration_0026_applied",
      "legacy_workers_drained",
      "active_reservations_drained_before_migration",
      "prebind_heartbeat",
      "late_bind_deadline",
      "owner_generation_cas",
      "queue_v2_generation",
      "staging_race_replay",
    ]);
  }, 30_000);

  it("returns task submission state only to the creating API token", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const now = Math.floor(Date.now() / 1000);
    const submissionId = "task-submit-status-runtime";
    const billingContract = JSON.stringify({ funding_source: "wallet" });
    const attachContract = JSON.stringify({
      contract_version: "task-attach-v1",
      task_kind: "task",
      platform: "suno",
    });
    const bytes = (value) => new TextEncoder().encode(value);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
          (id, username, password, status, role, quota, "group", aff_code, created_at)
         VALUES (91, 'task-status-owner', 'x', 1, 1, 1000, 'default',
                 'task-status-owner', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO tokens
          (id, user_id, "key", status, name, expired_time, remain_quota,
           unlimited_quota, model_limits_enabled, model_limits, allow_ips,
           used_quota, "group", cross_group_retry)
         VALUES (91, 91, 'sk-task-status-owner', 1, 'owner', -1, 1000,
                 0, 0, '', '', 0, 'default', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO tokens
          (id, user_id, "key", status, name, expired_time, remain_quota,
           unlimited_quota, model_limits_enabled, model_limits, allow_ips,
           used_quota, "group", cross_group_retry)
         VALUES (92, 91, 'sk-task-status-other-token', 1, 'other', -1, 1000,
                 0, 0, '', '', 0, 'default', 0)`,
      ),
      env.DB.prepare(
        "INSERT INTO channels (id, key, name, status) VALUES (91, 'task-status-channel', 'task-status-channel', 1)",
      ),
      env.DB.prepare(
        `INSERT INTO task_billing_intents (
          reservation_key, task_kind, public_task_id, user_id, token_id,
          channel_id, quota, billing_contract_json, billing_contract_sha256,
          attach_contract_json, attach_contract_sha256,
          provider_kind, provider_idempotency_key,
          client_operation_key_sha256, client_request_sha256,
          submit_deadline_at, lease_expires_at, created_at, updated_at
        ) VALUES (?1, 'task', ?1, 91, 91, 91, 0, ?2, ?3, ?4, ?5,
                  'suno', ?1, ?6, ?7, ?8, ?9, ?10, ?10)`,
      ).bind(
        submissionId,
        billingContract,
        await sha256Hex(bytes(billingContract)),
        attachContract,
        await sha256Hex(bytes(attachContract)),
        await sha256Hex(bytes("client-operation:task-status-runtime")),
        await sha256Hex(bytes("client-request:task-status-runtime")),
        now + 90,
        now + 900,
        now,
      ),
    ]);

    const ownerResponse = await SELF.fetch(
      `https://cinatoken.test/api/task/submissions/${submissionId}`,
      { headers: { authorization: "Bearer sk-task-status-owner" } },
    );
    const ownerPayload = await ownerResponse.json();
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.headers.get("cache-control")).toContain("no-store");
    expect(ownerPayload).toMatchObject({
      submission_id: submissionId,
      task_id: submissionId,
      task_kind: "task",
      lifecycle_status: "reserved",
      submit_state: "prepared",
      task_available: false,
      terminal: false,
      submit_deadline_at: now + 90,
    });
    expect(ownerPayload.provider_task_id).toBeUndefined();
    expect(ownerPayload.client_operation_key_sha256).toBeUndefined();

    const otherTokenResponse = await SELF.fetch(
      `https://cinatoken.test/api/task/submissions/${submissionId}`,
      { headers: { authorization: "Bearer sk-task-status-other-token" } },
    );
    expect(otherTokenResponse.status).toBe(404);
    expect(otherTokenResponse.headers.get("cache-control")).toContain("no-store");

    const invalidTokenResponse = await SELF.fetch(
      `https://cinatoken.test/api/task/submissions/${submissionId}`,
      { headers: { authorization: "Bearer sk-task-status-invalid" } },
    );
    expect(invalidTokenResponse.status).toBe(401);
    expect(invalidTokenResponse.headers.get("cache-control")).toContain(
      "no-store",
    );
  }, 30_000);

  it("requeues a quarantined task with step-up, stale-preview fencing, and idempotent audit", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const { cookie, password } = await setupAndLoginBillingRoot();
    const recoveryNow = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO tasks (
         id, task_id, upstream_task_id, platform, status, progress, submit_time,
         channel_id, poll_generation, poll_write_revision, poll_attempt_count,
         poll_consecutive_failures, poll_last_error_code, poll_quarantined_at,
         poll_quarantine_reason
       ) VALUES (
         370101, 'task_runtime_recovery', 'provider-runtime-recovery', 'sora',
         'IN_PROGRESS', '25%', ?1, 17, 3, 5, 9, 8,
         'provider_poll_failed', ?2, 'provider_poll_failed'
       )`,
    )
      .bind(recoveryNow, recoveryNow - 60)
      .run();
    await env.DB.prepare(
      `UPDATE task_poll_lease_control
       SET authority_enabled = 1, enforcement_enabled = 1, updated_at = 1800000001
       WHERE id = 1`,
    ).run();

    const queueResponse = await SELF.fetch(
      "https://cinatoken.test/api/platform/task-poll/quarantines?limit=20",
      { headers: { cookie } },
    );
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.headers.get("cache-control")).toBe("no-store");
    const queue = await queueResponse.json();
    expect(queue).toMatchObject({
      success: true,
      data: {
        contract_version: 2,
        count: 1,
        records: [
          {
            entity_kind: "task",
            entity_id: 370101,
            task_reference: "task_runtime_recovery",
            platform: "sora",
            channel_id: 17,
            poll_generation: 3,
            poll_write_revision: 5,
            poll_attempt_count: 9,
            poll_consecutive_failures: 8,
            poll_quarantine_reason: "provider_poll_failed",
            hard_timeout_at: recoveryNow + 86_400,
            timeout_eligible: true,
            timeout_recovery_margin_seconds: 120,
          },
        ],
      },
    });
    expect(queue.data.records[0].public_task_id_sha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(queue)).not.toContain("provider-runtime-recovery");

    const decision = {
      reason: "provider_incident_resolved",
      evidence_reference: "incident:INC-370101",
    };
    const baseUrl =
      "https://cinatoken.test/api/platform/task-poll/quarantines/task/370101";
    const previewResponse = await SELF.fetch(`${baseUrl}/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      success: true,
      data: {
        entity_kind: "task",
        entity_id: 370101,
        poll_generation: 3,
        poll_write_revision: 5,
        poll_quarantined_at: recoveryNow - 60,
        poll_quarantine_reason: "provider_poll_failed",
        hard_timeout_at: recoveryNow + 86_400,
        timeout_eligible: true,
        timeout_recovery_margin_seconds: 120,
        reason: "provider_incident_resolved",
      },
    });
    expect(preview.data.preview_token).toMatch(/^[a-f0-9]{64}$/u);
    const applyBody = {
      ...decision,
      preview_token: preview.data.preview_token,
      idempotency_key: "runtime-requeue-370101",
      confirm_requeue: true,
    };
    const unverified = await SELF.fetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    expect(unverified.status).toBe(403);

    const verified = await SELF.fetch("https://cinatoken.test/api/verify", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ method: "password", password }),
    });
    expect(verified.status).toBe(200);

    const applied = await SELF.fetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    const appliedPayload = await applied.json();
    expect(applied.status, JSON.stringify(appliedPayload)).toBe(200);
    expect(appliedPayload).toMatchObject({
      success: true,
      data: {
        entity_kind: "task",
        entity_id: 370101,
        action: "requeue",
        status: "applied",
      },
    });
    expect(appliedPayload.data.scheduled_at).toBeGreaterThan(0);

    const duplicate = await SELF.fetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(applyBody),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: "duplicate",
        scheduled_at: appliedPayload.data.scheduled_at,
      },
    });

    const recovered = await env.DB.prepare(
      `SELECT status, progress, next_poll_at, poll_write_revision,
              poll_consecutive_failures, poll_last_error_code,
              poll_quarantined_at, poll_quarantine_reason
       FROM tasks WHERE id = 370101`,
    ).first();
    expect(recovered).toMatchObject({
      status: "IN_PROGRESS",
      progress: "25%",
      next_poll_at: appliedPayload.data.scheduled_at,
      poll_write_revision: 6,
      poll_consecutive_failures: 0,
      poll_last_error_code: "",
      poll_quarantined_at: 0,
      poll_quarantine_reason: "",
    });
    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM task_poll_recovery_events",
    ).first();
    expect(Number(eventCount?.count ?? 0)).toBe(1);
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM logs
       WHERE type = 3 AND other LIKE '%task_poll.quarantine_requeued%'`,
    ).first();
    expect(Number(auditCount?.count ?? 0)).toBe(1);

    await env.DB.prepare(
      `INSERT INTO tasks (
         id, task_id, upstream_task_id, platform, status, progress, submit_time,
         poll_generation, poll_write_revision, poll_quarantined_at,
         poll_quarantine_reason
       ) VALUES (
         370102, 'task_runtime_stale', 'provider-runtime-stale', 'sora',
         'IN_PROGRESS', '10%', ?1, 4, 7, ?2, 'provider_poll_failed'
       )`,
    )
      .bind(recoveryNow, recoveryNow - 30)
      .run();
    const staleBaseUrl =
      "https://cinatoken.test/api/platform/task-poll/quarantines/task/370102";
    const stalePreview = await SELF.fetch(`${staleBaseUrl}/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    const stalePreviewPayload = await stalePreview.json();
    await env.DB.prepare(
      "UPDATE tasks SET poll_write_revision = 8 WHERE id = 370102",
    ).run();
    const staleApply = await SELF.fetch(`${staleBaseUrl}/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ...decision,
        preview_token: stalePreviewPayload.data.preview_token,
        idempotency_key: "runtime-requeue-370102",
        confirm_requeue: true,
      }),
    });
    expect(staleApply.status).toBe(409);
    const staleState = await env.DB.prepare(
      `SELECT poll_write_revision, poll_quarantined_at
       FROM tasks WHERE id = 370102`,
    ).first();
    expect(staleState).toMatchObject({
      poll_write_revision: 8,
      poll_quarantined_at: recoveryNow - 30,
    });

    await env.DB.prepare(
      `INSERT INTO tasks (
         id, task_id, upstream_task_id, platform, status, progress, submit_time,
         poll_generation, poll_write_revision, poll_quarantined_at,
         poll_quarantine_reason
       ) VALUES (
         370103, 'task_runtime_expiring', 'provider-runtime-expiring', 'sora',
         'IN_PROGRESS', '10%', ?1, 1, 1, ?2, 'provider_poll_failed'
       )`,
    )
      .bind(recoveryNow - 86_350, recoveryNow - 20)
      .run();
    const expiringBaseUrl =
      "https://cinatoken.test/api/platform/task-poll/quarantines/task/370103";
    const expiringPreview = await SELF.fetch(`${expiringBaseUrl}/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    expect(expiringPreview.status).toBe(200);
    const expiringPreviewPayload = await expiringPreview.json();
    expect(expiringPreviewPayload.data.timeout_eligible).toBe(false);
    const expiringApply = await SELF.fetch(`${expiringBaseUrl}/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ...decision,
        preview_token: expiringPreviewPayload.data.preview_token,
        idempotency_key: "runtime-requeue-370103",
        confirm_requeue: true,
      }),
    });
    expect(expiringApply.status).toBe(409);
  }, 30_000);

  it("reconciles a stable D1 quota projection without exposing token identity", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const { cookie } = await setupAndLoginBillingRoot();
    const now = Math.floor(Date.now() / 1000);
    await seedRelayBillingReservation({
      reservationKey: "relayreserve-runtime-quota-reconcile-a",
      leaseExpiresAt: now + 300,
    });
    const observation = {
      contract_version: 1,
      kind: "reserve",
      operation_id: quotaHex("a"),
      reservation_fingerprint: quotaHex("b"),
      generation: 1,
      reserved_quota: 100,
      final_quota: 0,
      request_count: 0,
    };
    expect(
      (await observeQuota(quotaCoordinatorStub(1), 1, observation)).status,
    ).toBe(204);

    const url =
      "https://cinatoken.test/api/platform/quota-coordinator/reconciliation";
    const reconciliationRequest = {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ token_id: "1" }),
    };
    expect(
      (
        await SELF.fetch(url, {
          ...reconciliationRequest,
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(401);
    const matched = await SELF.fetch(url, reconciliationRequest);
    expect(matched.status).toBe(200);
    expect(matched.headers.get("cache-control")).toBe("no-store");
    const matchedPayload = await matched.json();
    expect(matchedPayload).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        status: "matched",
        source_stable: true,
        observer_healthy: true,
        d1: {
          reserve_count: 1,
          active_reservations: 1,
          outstanding_quota: 100,
          reserved_quota: 100,
          user_net_delta: -100,
          token_net_delta: -100,
        },
        observer: {
          reserve_count: 1,
          active_reservations: 1,
          outstanding_quota: 100,
          reserved_quota: 100,
        },
        difference: {
          reserve_count: 0,
          active_reservations: 0,
          reserved_quota: 0,
        },
        observer_diagnostics: {
          conflict_count: 0,
          legacy_terminal_reservations: 0,
        },
      },
    });
    expect(matchedPayload.data.token_scope_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(matchedPayload.data).not.toHaveProperty("token_id");

    await seedRelayBillingReservation({
      reservationKey: "relayreserve-runtime-quota-reconcile-b",
      leaseExpiresAt: now + 300,
    });
    const mismatch = await SELF.fetch(url, reconciliationRequest);
    expect(mismatch.status).toBe(200);
    await expect(mismatch.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: "mismatch",
        source_stable: true,
        observer_healthy: true,
        difference: {
          reserve_count: 1,
          active_reservations: 1,
          outstanding_quota: 100,
          reserved_quota: 100,
          user_net_delta: -100,
          token_net_delta: -100,
        },
      },
    });
  }, 30_000);

  it("refunds a bound HTTP reservation exactly once through the billing Queue", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount();
    const now = Math.floor(Date.now() / 1000);
    const reservationKey = "relayreserve-runtime-queue-refund";
    await seedRelayBillingReservation({
      reservationKey,
      leaseExpiresAt: now + 300,
      bound: true,
    });
    const event = relayBillingRefundEvent(reservationKey, now);

    const first = await deliverQueueMessages(
      "cinatoken-rust-billing-finalization-runtime",
      [{ id: "refund-finalization", body: event }],
    );
    expect(first.explicitAcks).toEqual(["refund-finalization"]);
    expect(first.retryMessages).toEqual([]);
    await expect(relayBillingState(reservationKey)).resolves.toMatchObject({
      reservation: {
        status: "refunded",
        finalization_reason: "upstream_failure",
        request_accounted: 1,
      },
      user: { quota: 1_000, request_count: 1 },
      token: { remain_quota: 500, used_quota: 0 },
    });
    await expect(
      relayBillingFinalizationState(event.event_id),
    ).resolves.toMatchObject({
      auditCount: 1,
      requestCount: 1,
      userQuota: 1_000,
      tokenRemainQuota: 500,
    });

    const replay = await deliverQueueMessages(
      "cinatoken-rust-billing-finalization-runtime",
      [{ id: "refund-finalization-replay", body: event }],
    );
    expect(replay.explicitAcks).toEqual(["refund-finalization-replay"]);
    expect(replay.retryMessages).toEqual([]);
    await expect(
      relayBillingFinalizationState(event.event_id),
    ).resolves.toMatchObject({
      auditCount: 1,
      requestCount: 1,
      userQuota: 1_000,
      tokenRemainQuota: 500,
    });
  });

  it("exposes only authenticated redacted Container reconciliation observations", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const { cookie } = await setupAndLoginBillingRoot();
    const seeded = [
      await seedContainerReconciliationObservation("1"),
      await seedContainerReconciliationObservation("2"),
    ];
    const statusUrl =
      "https://cinatoken.test/api/platform/container/reconciliation/status";
    const listUrl =
      "https://cinatoken.test/api/platform/container/reconciliations" +
      "?status=retry&class=store_unavailable&limit=1";

    const anonymousStatus = await SELF.fetch(statusUrl);
    expect(anonymousStatus.status).toBe(401);
    expect(anonymousStatus.headers.get("cache-control")).toBe("no-store");
    const statusResponse = await SELF.fetch(statusUrl, {
      headers: { cookie },
    });
    const statusText = await statusResponse.text();
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    for (const identity of seeded) {
      expect(statusText).not.toContain(identity.operationId);
      expect(statusText).not.toContain(identity.reconciliationId);
      expect(statusText).not.toContain(identity.claimOwner);
    }
    expect(JSON.parse(statusText)).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        observer_compiled: true,
        schema_ready: true,
        runtime_enabled: false,
        retry_preview_compiled: true,
        retry_apply_compiled: false,
        scan_limit: 4,
        run: {
          owner_present: false,
          active: false,
        },
        observations: {
          total: 2,
          pending: 0,
          leased: 0,
          retry: 2,
          converged: 0,
          dead_letter: 0,
          due: 1,
          expired_leases: 0,
        },
        classes: [{ class: "store_unavailable", count: 2 }],
      },
    });

    const anonymousList = await SELF.fetch(listUrl);
    expect(anonymousList.status).toBe(401);
    expect(anonymousList.headers.get("cache-control")).toBe("no-store");
    for (const invalidQuery of [
      "?status=unknown",
      "?limit=1&limit=2",
    ]) {
      const invalidList = await SELF.fetch(
        `https://cinatoken.test/api/platform/container/reconciliations${invalidQuery}`,
        { headers: { cookie } },
      );
      expect(invalidList.status).toBe(400);
      expect(invalidList.headers.get("cache-control")).toBe("no-store");
    }
    const listResponse = await SELF.fetch(listUrl, { headers: { cookie } });
    const listText = await listResponse.text();
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("cache-control")).toBe("no-store");
    for (const identity of seeded) {
      expect(listText).not.toContain(identity.operationId);
      expect(listText).not.toContain(identity.reconciliationId);
      expect(listText).not.toContain(identity.claimOwner);
    }
    const list = JSON.parse(listText);
    expect(list).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        count: 1,
        status_filter: "retry",
        class_filter: "store_unavailable",
        records: [
          {
            owner_generation: 2,
            status: "retry",
            class: "store_unavailable",
            last_error_code: "controller_status_unavailable",
            claim_generation: 1,
            attempt_count: 1,
            consecutive_failures: 1,
            due: false,
            lease_active: false,
            lease_expired: false,
          },
        ],
      },
    });
    expect(list.data.records[0].operation_reference).toMatch(/^[a-f0-9]{64}$/u);
    expect(list.data.records[0].reconciliation_reference).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(list.data.next_cursor).toMatch(/^[1-9][0-9]*$/u);
    const previewBody = JSON.stringify({
      reason: "operator_reinspection_approved",
      evidence_reference: "incident:CT-runtime-1",
    });
    const managedPreview = await SELF.fetch(
      "https://cinatoken.test/api/platform/container/reconciliations/" +
        `${list.data.records[0].target}/retry/preview`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: previewBody,
      },
    );
    expect(managedPreview.status).toBe(409);
    expect(managedPreview.headers.get("cache-control")).toBe("no-store");

    const secondPageResponse = await SELF.fetch(
      `${listUrl}&cursor=${list.data.next_cursor}`,
      { headers: { cookie } },
    );
    const secondPageText = await secondPageResponse.text();
    expect(secondPageResponse.status).toBe(200);
    expect(secondPageResponse.headers.get("cache-control")).toBe("no-store");
    for (const identity of seeded) {
      expect(secondPageText).not.toContain(identity.operationId);
      expect(secondPageText).not.toContain(identity.reconciliationId);
      expect(secondPageText).not.toContain(identity.claimOwner);
    }
    const secondPage = JSON.parse(secondPageText);
    expect(secondPage).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        count: 1,
        next_cursor: null,
        status_filter: "retry",
        class_filter: "store_unavailable",
      },
    });
    expect(secondPage.data.records[0].operation_reference).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(secondPage.data.records[0].operation_reference).not.toBe(
      list.data.records[0].operation_reference,
    );

    await deadLetterContainerReconciliationObservation(seeded[0].operationId);
    const deadLetterListResponse = await SELF.fetch(
      "https://cinatoken.test/api/platform/container/reconciliations" +
        "?status=dead_letter&limit=1",
      { headers: { cookie } },
    );
    const deadLetterList = await deadLetterListResponse.json();
    expect(deadLetterListResponse.status).toBe(200);
    expect(deadLetterList.data.records).toHaveLength(1);
    const previewTarget = deadLetterList.data.records[0].target;
    expect(previewTarget).toMatch(/^ctrec1-[1-9][0-9]*-[a-f0-9]{64}$/u);
    const previewUrl =
      "https://cinatoken.test/api/platform/container/reconciliations/" +
      `${previewTarget}/retry/preview`;

    const anonymousPreview = await SELF.fetch(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: previewBody,
    });
    expect(anonymousPreview.status).toBe(401);
    expect(anonymousPreview.headers.get("cache-control")).toBe("no-store");
    const previewResponse = await SELF.fetch(previewUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: previewBody,
    });
    const previewText = await previewResponse.text();
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("no-store");
    expect(previewText).not.toContain(seeded[0].operationId);
    expect(previewText).not.toContain(seeded[0].reconciliationId);
    expect(previewText).not.toContain(seeded[0].claimOwner);
    expect(previewText).not.toContain("incident:CT-runtime-1");
    const preview = JSON.parse(previewText);
    expect(preview).toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        target: previewTarget,
        owner_generation: 2,
        status: "dead_letter",
        class: "terminal_conflict",
        last_error_code: "controller_contract_violation",
        claim_generation: 2,
        attempt_count: 2,
        consecutive_failures: 1,
        dead_letter_reason: "terminal_conflict",
        action: "reobserve_container_state",
        reason: "operator_reinspection_approved",
        candidate_retryable: true,
        apply_compiled: false,
        apply_enabled: false,
        apply_blocker: "retry_apply_not_compiled",
        step_up_required_for_apply: true,
        observer_state_mutation_only: true,
        provider_retry_allowed: false,
        operation_mutation_allowed: false,
        financial_mutation_allowed: false,
        durable_object_mutation_allowed: false,
        r2_mutation_allowed: false,
      },
    });
    expect(preview.data.operation_reference).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.data.reconciliation_reference).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.data.evidence_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.data.preview_token).toMatch(/^[a-f0-9]{64}$/u);

    const tamperedTarget = `${previewTarget.slice(0, -1)}${
      previewTarget.endsWith("0") ? "1" : "0"
    }`;
    const tamperedPreview = await SELF.fetch(
      "https://cinatoken.test/api/platform/container/reconciliations/" +
        `${tamperedTarget}/retry/preview`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: previewBody,
      },
    );
    expect(tamperedPreview.status).toBe(404);
    expect(tamperedPreview.headers.get("cache-control")).toBe("no-store");
    const deadLetterState = await env.DB.prepare(
      `SELECT status, claim_generation, attempt_count, dead_letter_reason
       FROM relay_container_reconciliation_observations
       WHERE operation_id = ?1`,
    )
      .bind(seeded[0].operationId)
      .first();
    expect(deadLetterState).toEqual({
      status: "dead_letter",
      claim_generation: 2,
      attempt_count: 2,
      dead_letter_reason: "terminal_conflict",
    });
  });

  it("quarantines and queue-replays one billing DLQ incident under root step-up", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedRealtimeBillingAccount();
    const now = Math.floor(Date.now() / 1000);
    const reservationKey = "relayreserve-runtime-dlq-reconcile";
    const poisonMarker = "poison-payload-must-not-be-persisted";
    await seedRelayBillingReservation({
      reservationKey,
      leaseExpiresAt: now + 300,
      bound: true,
    });
    const event = relayBillingRefundEvent(reservationKey, now);

    const deadLetters = await deliverQueueMessages(
      "cinatoken-rust-billing-finalization-runtime-dlq",
      [
        { id: "replayable-dead-letter", body: event },
        {
          id: "invalid-dead-letter",
          body: { event_type: "unsupported", marker: poisonMarker },
        },
      ],
    );
    expect(deadLetters.explicitAcks).toEqual([
      "replayable-dead-letter",
      "invalid-dead-letter",
    ]);
    expect(deadLetters.retryMessages).toEqual([]);

    const replayable = await env.DB.prepare(
      `SELECT incident_id, event_id, payload_sha256, payload_json,
              classification, status, delivery_count
       FROM relay_billing_finalization_incidents
       WHERE classification = 'replayable'`,
    ).first();
    const invalid = await env.DB.prepare(
      `SELECT event_id, payload_sha256, payload_json, classification, status
       FROM relay_billing_finalization_incidents
       WHERE classification = 'invalid'`,
    ).first();
    expect(replayable).toMatchObject({
      event_id: event.event_id,
      classification: "replayable",
      status: "open",
      delivery_count: 1,
    });
    expect(replayable.incident_id).toMatch(/^[0-9a-f]{64}$/);
    expect(replayable.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(replayable.payload_json)).toEqual(event);
    expect(invalid).toMatchObject({
      event_id: "",
      payload_json: "",
      classification: "invalid",
      status: "invalid",
    });
    expect(invalid.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(invalid)).not.toContain(poisonMarker);
    await expect(relayBillingState(reservationKey)).resolves.toMatchObject({
      reservation: { status: "reserved", request_accounted: 0 },
      user: { quota: 900, request_count: 0 },
      token: { remain_quota: 400, used_quota: 100 },
    });

    const { cookie, password } = await setupAndLoginBillingRoot();
    const listResponse = await SELF.fetch(
      "https://cinatoken.test/api/platform/relay/billing-finalization/incidents?status=open&limit=20",
      { headers: { cookie } },
    );
    expect(listResponse.status).toBe(200);
    const listText = await listResponse.text();
    expect(listText).toContain(replayable.incident_id);
    expect(listText).not.toContain(reservationKey);
    expect(listText).not.toContain("payload_json");
    expect(listText).not.toContain(event.event_id);

    const replayUrl =
      `https://cinatoken.test/api/platform/relay/billing-finalization/incidents/` +
      `${replayable.incident_id}/replay`;
    const unverified = await SELF.fetch(replayUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm_replay: true }),
    });
    expect(unverified.status).toBe(403);

    const verified = await SELF.fetch("https://cinatoken.test/api/verify", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ method: "password", password }),
    });
    expect(verified.status).toBe(200);

    const replay = await SELF.fetch(replayUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm_replay: true }),
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      data: {
        contract_version: 1,
        incident_id: replayable.incident_id,
        status: "queued",
        replay_generation: 1,
      },
    });

    await expect(
      waitForBillingIncidentResolution(reservationKey, replayable.incident_id),
    ).resolves.toMatchObject({
      reservation: { status: "refunded", request_accounted: 1 },
      incident: {
        status: "resolved",
        replay_generation: 1,
        replay_attempt_count: 1,
        resolution: "applied",
      },
      billingAuditCount: 1,
      adminAuditCount: 1,
    });

    const duplicateReplay = await SELF.fetch(replayUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm_replay: true }),
    });
    expect(duplicateReplay.status).toBe(409);
  }, 30_000);

  it("settles a delivered non-stream response at the reserve when usage inspection is unavailable", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayNonStreamAuditLimitModel,
      token: relayNonStreamAuditLimitToken,
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayNonStreamAuditLimitToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayNonStreamAuditLimitModel,
          stream: false,
          messages: [{ role: "user", content: "runtime bounded response" }],
          max_completion_tokens: 20,
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { role: "assistant", content: "bounded result" } }],
    });

    const settled = await waitForRelayTerminalByModel(
      relayNonStreamAuditLimitModel,
      "settled",
    );
    expect(settled.reservation.pre_consumed_quota).toBeGreaterThan(0);
    expect(settled.reservation).toMatchObject({
      status: "settled",
      final_quota: settled.reservation.pre_consumed_quota,
      finalization_reason: "non_stream_parse_fallback_settlement",
      request_accounted: 1,
    });
    expect(settled.user).toMatchObject({
      quota: account.userQuota - settled.reservation.pre_consumed_quota,
      used_quota: settled.reservation.pre_consumed_quota,
      request_count: 1,
    });
    expect(settled.token).toMatchObject({
      remain_quota:
        account.tokenRemainQuota - settled.reservation.pre_consumed_quota,
      used_quota: settled.reservation.pre_consumed_quota,
    });
    expect(settled.channel.used_quota).toBe(
      settled.reservation.pre_consumed_quota,
    );
    expect(settled.log).toMatchObject({
      usageSource: "unavailable_parse_failure",
      nonStreamUsageParseFailed: true,
      parseFallbackReason: "non_stream_parse_fallback_settlement",
      finalizationTransport: "billing_queue",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/chat/completions",
      nonStreamAuditLimit: true,
    });
    const observedSettlement = await waitForQuotaCoordinatorTerminal(
      1,
      "settle",
    );
    expect(observedSettlement).toMatchObject({
      reserve_count: 1,
      settle_count: 1,
      active_reservations: 0,
      terminal_reservations: 1,
    });
    await delay(2_000);
  }, 30_000);

  it("settles zero-reserve tiered usage through the durable finalization ledger", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayZeroReserveModel,
      token: relayZeroReserveToken,
      billingExpression: 'tier("runtime_zero_reserve", c * 8)',
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const modelsResponse = await SELF.fetch(
      "https://cinatoken.test/v1/models",
      { headers: { authorization: `Bearer ${relayZeroReserveToken}` } },
    );
    expect(modelsResponse.status).toBe(200);
    const models = await modelsResponse.json();
    expect(models.data.map((item) => item.id)).toContain(relayZeroReserveModel);

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayZeroReserveToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayZeroReserveModel,
          stream: false,
          messages: [{ role: "user", content: "runtime zero reserve" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { role: "assistant", content: "bounded result" } }],
    });

    const settled = await waitForRelayTerminalByModel(
      relayZeroReserveModel,
      "settled",
    );
    expect(settled.reservation.pre_consumed_quota).toBe(0);
    expect(settled.reservation.final_quota).toBeGreaterThan(0);
    expect(settled.reservation).toMatchObject({
      status: "settled",
      finalization_reason: "usage_settlement",
      request_accounted: 1,
    });
    expect(settled.user).toMatchObject({
      quota: account.userQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
      request_count: 1,
    });
    expect(settled.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
    });
    expect(settled.channel.used_quota).toBe(settled.reservation.final_quota);
    expect(settled.log).toMatchObject({
      usageSource: "upstream",
      finalizationTransport: "billing_queue",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/chat/completions",
      zeroReserve: true,
    });
    const observedSettlement = await waitForQuotaCoordinatorTerminal(
      1,
      "settle",
    );
    expect(observedSettlement).toMatchObject({
      reserve_count: 1,
      settle_count: 1,
      active_reservations: 0,
      terminal_reservations: 1,
    });
    await delay(2_000);
  }, 30_000);

  it("blocks an uninspectable flat-billed response before client delivery", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayFlatAuditLimitModel,
      token: relayFlatAuditLimitToken,
      billingExpression: null,
      pricingOptions: {
        ModelRatio: { [relayFlatAuditLimitModel]: 1 },
        CompletionRatio: { [relayFlatAuditLimitModel]: 1 },
      },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayFlatAuditLimitToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayFlatAuditLimitModel,
          stream: false,
          messages: [{ role: "user", content: "runtime flat limit" }],
        }),
      },
    );
    expect(response.status).toBe(502);

    const state = await waitForNonTieredRelayLog(relayFlatAuditLimitModel);
    expect(state.user).toMatchObject({
      quota: account.userQuota,
      used_quota: 0,
      request_count: 0,
    });
    expect(state.token).toMatchObject({
      remain_quota: account.tokenRemainQuota,
      used_quota: 0,
    });
    expect(state.channel.used_quota).toBe(0);
    expect(state.reservationCount).toBe(1);
    expect(state.reservation).toMatchObject({
      billing_kind: "flat",
      status: "refunded",
      final_quota: 0,
      request_accounted: 0,
    });
    expect(state.reservation.expr_hash).toMatch(/^flat-v4:[a-f0-9]{64}$/);
    expect(state.reservation.snapshot_bytes).toBeGreaterThan(0);
    expect(state.log).toMatchObject({
      quota: 0,
      billingPending: false,
      billingLedgerOutcome: "refunded",
      usageSource: "unavailable_parse_failure",
      reservationClass: "positive_flat_reservation",
      clientDisposition: "blocked_before_delivery",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/chat/completions",
      flatAuditLimit: true,
    });
  }, 30_000);

  it("rejects an unconfigured flat model before provider or ledger mutation", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayUnsetModel,
      token: relayUnsetToken,
      billingExpression: null,
      pricingOptions: { ModelRatio: {}, ModelPrice: {} },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const modelsResponse = await SELF.fetch(
      "https://cinatoken.test/v1/models",
      {
        headers: { authorization: `Bearer ${relayUnsetToken}` },
      },
    );
    expect(modelsResponse.status).toBe(200);
    await expect(modelsResponse.json()).resolves.toMatchObject({ data: [] });

    const response = await requestUnsetFlatModel();
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("price not configured");
    await expect(providerState()).resolves.toMatchObject({ count: 0 });

    const [user, token, channel, reservation, log] = await Promise.all([
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = 1",
      ).first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = 43").first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM relay_billing_reservations",
      ).first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM logs WHERE type = 2",
      ).first(),
    ]);
    expect(user).toMatchObject({
      quota: account.userQuota,
      used_quota: 0,
      request_count: 0,
    });
    expect(token).toMatchObject({
      remain_quota: account.tokenRemainQuota,
      used_quota: 0,
    });
    expect(channel.used_quota).toBe(0);
    expect(reservation.count).toBe(0);
    expect(log.count).toBe(0);
  }, 30_000);

  it.each([
    {
      policy: "site self-use",
      acceptUnsetRatioModel: false,
      selfUseModeEnabled: true,
    },
    {
      policy: "user AcceptUnsetRatioModel",
      acceptUnsetRatioModel: true,
      selfUseModeEnabled: false,
    },
  ])(
    "admits an unconfigured flat model through $policy at ratio 37.5",
    async ({ acceptUnsetRatioModel, selfUseModeEnabled }) => {
      await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
      const account = await seedStreamingRelayBillingGateway({
        model: relayUnsetModel,
        token: relayUnsetToken,
        billingExpression: null,
        acceptUnsetRatioModel,
        pricingOptions: {
          ModelRatio: {},
          ModelPrice: {},
          SelfUseModeEnabled: selfUseModeEnabled,
        },
      });
      await env.REALTIME_PROVIDER_MOCK.fetch(
        "https://realtime-provider-mock/__mock/reset",
        { method: "POST" },
      );

      const modelsResponse = await SELF.fetch(
        "https://cinatoken.test/v1/models",
        { headers: { authorization: `Bearer ${relayUnsetToken}` } },
      );
      expect(modelsResponse.status).toBe(200);
      const models = await modelsResponse.json();
      expect(models.data.map((item) => item.id)).toContain(relayUnsetModel);

      const response = await requestUnsetFlatModel();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        choices: [
          { message: { role: "assistant", content: "bounded result" } },
        ],
      });

      const state = await waitForNonTieredRelayLog(relayUnsetModel);
      expect(state.reservation).toMatchObject({
        billing_kind: "flat",
        status: "settled",
        request_accounted: 1,
      });
      expect(state.reservation.pre_consumed_quota).toBeGreaterThan(0);
      expect(state.reservation.final_quota).toBeGreaterThan(0);
      expect(state.log).toMatchObject({
        billingPending: false,
        usageSource: "upstream",
        flatBillingMode: "per_token",
      });
      expect(state.user).toMatchObject({
        quota: account.userQuota - state.reservation.final_quota,
        used_quota: state.reservation.final_quota,
        request_count: 1,
      });
      const frozen = JSON.parse(state.reservation.billing_snapshot_json)
        .default["1"];
      expect(frozen).toMatchObject({ model_ratio: 37.5 });
      await expect(
        env.DB.prepare(
          `UPDATE relay_billing_reservations
           SET billing_snapshot_json = '{}'
           WHERE model_name = ?1`,
        )
          .bind(relayUnsetModel)
          .run(),
      ).rejects.toThrow();
      const immutable = await env.DB.prepare(
        `SELECT billing_snapshot_json
         FROM relay_billing_reservations WHERE model_name = ?1`,
      )
        .bind(relayUnsetModel)
        .first();
      expect(immutable.billing_snapshot_json).toBe(
        state.reservation.billing_snapshot_json,
      );
      await expect(providerState()).resolves.toMatchObject({
        count: 1,
        unsetModel: true,
      });
    },
    30_000,
  );

  it("reserves usage-less fixed-price audio before returning and settles it durably", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayFixedAudioModel,
      token: relayFixedAudioToken,
      billingExpression: null,
      pricingOptions: {
        ModelPrice: { [relayFixedAudioModel]: 0.01 },
      },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/audio/speech",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayFixedAudioToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayFixedAudioModel,
          input: "runtime fixed price audio",
          voice: "alloy",
        }),
      },
    );
    expect(response.status).toBe(200);
    const audio = new TextDecoder().decode(await response.arrayBuffer());
    expect(audio).toBe("runtime-audio");

    const [immediateUser, immediateToken] = await Promise.all([
      env.DB.prepare(
        "SELECT quota, used_quota FROM users WHERE id = 1",
      ).first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
    ]);
    expect(immediateUser.quota).toBeLessThan(account.userQuota);
    expect(immediateToken.remain_quota).toBeLessThan(account.tokenRemainQuota);

    const state = await waitForNonTieredRelayLog(relayFixedAudioModel);
    expect(state.log.quota).toBeGreaterThan(0);
    expect(state.user).toMatchObject({
      quota: account.userQuota - state.log.quota,
      used_quota: state.log.quota,
      request_count: 1,
    });
    expect(state.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - state.log.quota,
      used_quota: state.log.quota,
    });
    expect(state.channel.used_quota).toBe(state.log.quota);
    expect(state.reservationCount).toBe(1);
    expect(state.reservation).toMatchObject({
      billing_kind: "flat",
      status: "settled",
      final_quota: state.log.quota,
      request_accounted: 1,
    });
    expect(state.reservation.expr_hash).toMatch(/^flat-v4:[a-f0-9]{64}$/);
    expect(state.reservation.snapshot_bytes).toBeGreaterThan(0);
    expect(state.log).toMatchObject({
      billingPending: false,
      usageSource: "tts_response_bytes",
      flatBillingMode: "fixed_price",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/audio/speech",
      fixedAudio: true,
    });
  }, 30_000);

  it("settles PCM speech from bounded response duration with frozen audio ratios", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayPcmAudioModel,
      token: relayPcmAudioToken,
      billingExpression: null,
      pricingOptions: {
        ModelRatio: { [relayPcmAudioModel]: 2 },
        CompletionRatio: { [relayPcmAudioModel]: 4 },
        AudioRatio: { [relayPcmAudioModel]: 3 },
        AudioCompletionRatio: { [relayPcmAudioModel]: 4 },
      },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/audio/speech",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayPcmAudioToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayPcmAudioModel,
          input: "",
          voice: "alloy",
          response_format: "pcm",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(48);

    const state = await waitForNonTieredRelayLog(relayPcmAudioModel);
    expect(state.log.quota).toBe(410);
    expect(state.user).toMatchObject({
      quota: account.userQuota - 410,
      used_quota: 410,
      request_count: 1,
    });
    expect(state.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - 410,
      used_quota: 410,
    });
    expect(state.channel.used_quota).toBe(410);
    expect(state.reservation).toMatchObject({
      billing_kind: "flat",
      status: "settled",
      final_quota: 410,
      request_accounted: 1,
    });
    expect(state.reservation.expr_hash).toMatch(/^flat-v4:[a-f0-9]{64}$/);
    expect(state.log).toMatchObject({
      billingPending: false,
      usageSource: "tts_response_duration",
      flatBillingMode: "per_token",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/audio/speech",
      pcmAudio: true,
    });
  }, 30_000);

  it("bounds oversized speech responses and refunds the reservation", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayOversizedAudioModel,
      token: relayOversizedAudioToken,
      billingExpression: null,
      pricingOptions: {
        ModelRatio: { [relayOversizedAudioModel]: 2 },
      },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/audio/speech",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayOversizedAudioToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayOversizedAudioModel,
          input: "oversized runtime audio",
          voice: "alloy",
          response_format: "mp3",
        }),
      },
    );
    expect(response.status).toBe(502);

    const refunded = await waitForRelayTerminalByModel(
      relayOversizedAudioModel,
      "refunded",
    );
    expect(refunded.reservation.pre_consumed_quota).toBeGreaterThan(0);
    expect(refunded.reservation).toMatchObject({
      status: "refunded",
      final_quota: 0,
      finalization_reason: "upstream_error",
      request_accounted: 0,
    });
    expect(refunded.user).toMatchObject({
      quota: account.userQuota,
      used_quota: 0,
      request_count: 0,
    });
    expect(refunded.token).toMatchObject({
      remain_quota: account.tokenRemainQuota,
      used_quota: 0,
    });
    expect(refunded.channel.used_quota).toBe(0);
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/audio/speech",
      oversizedAudio: true,
    });
  }, 30_000);

  it("reconstructs OpenRouter Anthropic cache write from provider cost", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayOpenRouterCostModel,
      token: relayOpenRouterCostToken,
      channelType: 20,
      billingExpression: null,
      pricingOptions: {
        CompletionRatio: { [relayOpenRouterCostModel]: 1 },
        CacheRatio: { [relayOpenRouterCostModel]: 0.1 },
        CreateCacheRatio: { [relayOpenRouterCostModel]: 1.25 },
      },
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayOpenRouterCostToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayOpenRouterCostModel,
          messages: [{ role: "user", content: "runtime OpenRouter cost" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe(
      "cost reconstructed",
    );

    const state = await waitForNonTieredRelayLog(relayOpenRouterCostModel);
    expect(state.log.quota).toBe(823);
    expect(state.user).toMatchObject({
      quota: account.userQuota - 823,
      used_quota: 823,
      request_count: 1,
    });
    expect(state.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - 823,
      used_quota: 823,
    });
    expect(state.channel.used_quota).toBe(823);
    expect(state.reservation).toMatchObject({
      billing_kind: "flat",
      status: "settled",
      final_quota: 823,
      request_accounted: 1,
    });
    expect(state.reservation.expr_hash).toMatch(/^flat-v4:[a-f0-9]{64}$/);
    expect(state.log).toMatchObject({
      usageSource: "upstream",
      usageSemantic: "anthropic",
      usageSemanticSource: "upstream_explicit",
      providerCostUsd: "0.0016464",
      cacheCreationSource: "openrouter_cost_inference",
      openRouterCacheWriteApplied: true,
      openRouterCacheWriteTokens: 100,
      flatBillingMode: "per_token",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/chat/completions",
      openRouterCost: true,
    });
  }, 30_000);

  it("refunds a consumed Cohere rerank parse failure before returning 502", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayCohereConsumedLimitModel,
      token: relayCohereConsumedLimitToken,
      channelType: 34,
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const response = await SELF.fetch("https://cinatoken.test/v1/rerank", {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayCohereConsumedLimitToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: relayCohereConsumedLimitModel,
        query: "runtime query",
        documents: ["first", "second"],
        top_n: 1,
      }),
    });
    expect(response.status).toBe(502);

    const refunded = await waitForRelayTerminalByModel(
      relayCohereConsumedLimitModel,
      "refunded",
    );
    expect(refunded.reservation.pre_consumed_quota).toBeGreaterThan(0);
    expect(refunded.reservation).toMatchObject({
      status: "refunded",
      final_quota: 0,
      finalization_reason: "upstream_error",
      request_accounted: 0,
    });
    expect(refunded.user).toMatchObject({
      quota: account.userQuota,
      used_quota: 0,
      request_count: 0,
    });
    expect(refunded.token).toMatchObject({
      remain_quota: account.tokenRemainQuota,
      used_quota: 0,
    });
    expect(refunded.channel.used_quota).toBe(0);
    expect(refunded.log).toMatchObject({
      usageSource: "upstream",
      finalizationTransport: "billing_queue",
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/rerank",
      cohereConsumedLimit: true,
    });
    const observedRefund = await waitForQuotaCoordinatorTerminal(1, "refund");
    expect(observedRefund).toMatchObject({
      reserve_count: 1,
      refund_count: 1,
      active_reservations: 0,
      terminal_reservations: 1,
    });
    await delay(2_000);
  }, 30_000);

  it("rejects an in-flight relay billing idempotency replay before a second provider call", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    await seedStreamingRelayBillingGateway();
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      { method: "POST" },
    );

    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayStreamToken}`,
        "content-type": "application/json",
        "x-request-id": "runtime-idempotency-replay",
      },
      body: JSON.stringify({
        model: relayStreamModel,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "runtime idempotency" }],
        max_completion_tokens: 20,
      }),
    };
    const first = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      request,
    );
    expect(first.status).toBe(200);
    const firstBody = first.text();
    const reserved = await waitForRelayBillingReservation(relayStreamModel);
    expect(reserved.reservation.reservation_key).toMatch(
      /^relayreserve-v2-[a-f0-9]{64}$/,
    );
    expect(reserved.reservation.request_id_hash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(reserved.reservation.request_id_hash).not.toContain(
      "runtime-idempotency-replay",
    );

    const replay = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      request,
    );
    expect(replay.status).toBe(409);
    await expect(replay.text()).resolves.toContain("idempotency");
    await expect(providerState()).resolves.toMatchObject({ count: 1 });
    const reservationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM relay_billing_reservations WHERE model_name = ?1",
    )
      .bind(relayStreamModel)
      .first();
    expect(reservationCount.count).toBe(1);

    const release = await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/release-relay-stream",
      { method: "POST" },
    );
    expect(release.status).toBe(204);
    await expect(firstBody).resolves.toContain("[DONE]");
    const settled = await waitForRelaySettlement(
      reserved.reservation.reservation_key,
    );
    expect(settled.reservation).toMatchObject({
      status: "settled",
      request_accounted: 1,
    });
    expect(settled.user.request_count).toBe(1);
  }, 30_000);

  it("renews a selected HTTP SSE billing lease without changing quota ownership", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway();
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      {
        method: "POST",
      },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayStreamToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayStreamModel,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "runtime streaming heartbeat" }],
          max_completion_tokens: 20,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const bodyPromise = response.text();

    const reserved = await waitForRelayBillingReservation(relayStreamModel);
    expect(reserved.reservation).toMatchObject({
      status: "reserved",
      channel_id: 43,
      selected_group: "default",
      owner_generation: 2,
    });
    expect(reserved.reservation.pre_consumed_quota).toBeGreaterThan(0);
    expect(reserved.user).toMatchObject({ request_count: 0 });
    const initialLease = reserved.reservation.lease_expires_at;

    const renewed = await waitForRelayLeaseRenewal(
      reserved.reservation.reservation_key,
      initialLease,
    );
    expect(renewed.reservation.lease_expires_at).toBeGreaterThan(initialLease);
    expect(renewed.reservation.owner_generation).toBe(2);
    expect(renewed.user).toMatchObject({ request_count: 0 });

    const release = await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/release-relay-stream",
      { method: "POST" },
    );
    expect(release.status).toBe(204);
    await expect(bodyPromise).resolves.toContain("[DONE]");
    const settled = await waitForRelaySettlement(
      reserved.reservation.reservation_key,
    );
    expect(settled.reservation).toMatchObject({
      status: "settled",
      request_accounted: 1,
      owner_generation: 3,
    });
    expect(settled.user.request_count).toBe(1);
    expect(settled.reservation.final_quota).toBeGreaterThan(0);
    expect(settled.user).toMatchObject({
      quota: account.userQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
    });
    expect(settled.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
    });
    expect(settled.channel).toMatchObject({
      used_quota: settled.reservation.final_quota,
    });
    expect(settled.log.adminHeartbeat).toMatchObject({
      failure_count: 0,
      stopped_reason: null,
      completion_reason: "stream_completed",
      usage_recovered_after_error: false,
    });
    expect(settled.log.usageSource).toBe("upstream");
    expect(settled.log.finalizationTransport).toBe("billing_queue");
    expect(settled.log.finalizationEventId).toMatch(
      /^relay-finalization-v1:relayreserve-/,
    );
    expect(settled.log.adminHeartbeat.interval_seconds).toBeGreaterThanOrEqual(
      5,
    );
    expect(settled.log.adminHeartbeat.interval_seconds).toBeLessThanOrEqual(6);
    expect(settled.log.adminHeartbeat.final_lease_expires_at).toBeGreaterThan(
      settled.log.adminHeartbeat.initial_lease_expires_at,
    );
    expect(settled.log.adminHeartbeat.last_renewed_at).toBeGreaterThan(0);
    expect(settled.log.adminHeartbeat.attempt_count).toBeGreaterThanOrEqual(1);
    expect(settled.log.adminHeartbeat.renewed_count).toBeGreaterThanOrEqual(1);
    const observedSettlement = await waitForQuotaCoordinatorSummary(1, 3);
    expect(observedSettlement).toMatchObject({
      observation_count: 3,
      applied_count: 2,
      replay_count: 1,
      conflict_count: 0,
      reserve_count: 1,
      settle_count: 1,
      refund_count: 0,
      active_reservations: 0,
      terminal_reservations: 1,
      request_count: 1,
      final_quota: settled.reservation.final_quota,
    });
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      path: "/v1/chat/completions",
      authorizationPresent: true,
      relayStreamHeld: true,
    });

    const event = await relayBillingFinalizationEvent(
      reserved.reservation.reservation_key,
    );
    const duplicate = await deliverQueueMessages(
      "cinatoken-rust-billing-finalization-runtime",
      [{ id: "duplicate-finalization", body: event }],
    );
    expect(duplicate.explicitAcks).toEqual(["duplicate-finalization"]);
    expect(duplicate.retryMessages).toEqual([]);
    await expect(
      relayBillingFinalizationState(event.event_id),
    ).resolves.toMatchObject({
      auditCount: 1,
      requestCount: 1,
      userQuota: account.userQuota - settled.reservation.final_quota,
      tokenRemainQuota:
        account.tokenRemainQuota - settled.reservation.final_quota,
    });
    const observedReplay = await waitForQuotaCoordinatorSummary(1, 5);
    expect(observedReplay).toMatchObject({
      observation_count: 5,
      applied_count: 2,
      replay_count: 3,
      conflict_count: 0,
      terminal_reservations: 1,
      request_count: 1,
      final_quota: settled.reservation.final_quota,
    });

    const wrongQueue = await deliverQueueMessages("cinatoken-rust-log-events", [
      { id: "cross-queue-finalization", body: event },
    ]);
    expect(wrongQueue.explicitAcks).toEqual([]);
    expect(wrongQueue.retryMessages).toEqual([
      { msgId: "cross-queue-finalization" },
    ]);

    const mixed = await deliverQueueMessages(
      "cinatoken-rust-billing-finalization-runtime",
      [
        { id: "poison-finalization", body: { event_type: "unsupported" } },
        { id: "valid-finalization-replay", body: event },
      ],
    );
    expect(mixed.explicitAcks).toEqual(["valid-finalization-replay"]);
    expect(mixed.retryMessages).toEqual([{ msgId: "poison-finalization" }]);
    await expect(
      relayBillingFinalizationState(event.event_id),
    ).resolves.toMatchObject({
      auditCount: 1,
      requestCount: 1,
      userQuota: account.userQuota - settled.reservation.final_quota,
      tokenRemainQuota:
        account.tokenRemainQuota - settled.reservation.final_quota,
    });
  }, 30_000);

  it("settles partial HTTP SSE usage exactly once after a stream read error", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayStreamErrorModel,
      token: relayStreamErrorToken,
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      {
        method: "POST",
      },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayStreamErrorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayStreamErrorModel,
          stream: true,
          messages: [{ role: "user", content: "runtime partial usage" }],
          max_completion_tokens: 20,
        }),
      },
    );
    expect(response.status).toBe(200);
    const bodyFailure = expect(response.text()).rejects.toThrow();
    const reserved = await waitForRelayBillingReservation(
      relayStreamErrorModel,
    );

    const release = await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/release-relay-stream",
      { method: "POST" },
    );
    expect(release.status).toBe(204);
    await bodyFailure;

    const settled = await waitForRelaySettlement(
      reserved.reservation.reservation_key,
    );
    expect(settled.reservation).toMatchObject({
      status: "settled",
      request_accounted: 1,
    });
    expect(settled.reservation.final_quota).toBeGreaterThan(0);
    expect(settled.user).toMatchObject({
      quota: account.userQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
      request_count: 1,
    });
    expect(settled.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - settled.reservation.final_quota,
      used_quota: settled.reservation.final_quota,
    });
    expect(settled.channel.used_quota).toBe(settled.reservation.final_quota);
    expect(settled.log).toMatchObject({
      usageSource: "local_estimate",
      finalizationTransport: "billing_queue",
      adminHeartbeat: {
        completion_reason: "stream_error",
        usage_recovered_after_error: true,
      },
    });
    expect(settled.log.finalizationEventId).toMatch(
      /^relay-finalization-v1:relayreserve-/,
    );
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      relayStreamFailurePlanned: true,
    });
  }, 30_000);

  it("preserves reported HTTP SSE usage when a later stream read fails", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const account = await seedStreamingRelayBillingGateway({
      model: relayStreamUsageErrorModel,
      token: relayStreamUsageErrorToken,
    });
    await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/reset",
      {
        method: "POST",
      },
    );

    const response = await SELF.fetch(
      "https://cinatoken.test/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayStreamUsageErrorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: relayStreamUsageErrorModel,
          stream: true,
          messages: [{ role: "user", content: "runtime reported usage" }],
          max_completion_tokens: 20,
        }),
      },
    );
    expect(response.status).toBe(200);
    const bodyFailure = expect(response.text()).rejects.toThrow();
    const reserved = await waitForRelayBillingReservation(
      relayStreamUsageErrorModel,
    );

    const release = await env.REALTIME_PROVIDER_MOCK.fetch(
      "https://realtime-provider-mock/__mock/release-relay-stream",
      { method: "POST" },
    );
    expect(release.status).toBe(204);
    await bodyFailure;

    const settled = await waitForRelaySettlement(
      reserved.reservation.reservation_key,
    );
    const expectedFinalQuota = 30;
    expect(settled.reservation).toMatchObject({
      status: "settled",
      request_accounted: 1,
      final_quota: expectedFinalQuota,
    });
    expect(settled.user).toMatchObject({
      quota: account.userQuota - expectedFinalQuota,
      used_quota: expectedFinalQuota,
      request_count: 1,
    });
    expect(settled.token).toMatchObject({
      remain_quota: account.tokenRemainQuota - expectedFinalQuota,
      used_quota: expectedFinalQuota,
    });
    expect(settled.channel.used_quota).toBe(expectedFinalQuota);
    expect(settled.log).toMatchObject({
      usageSource: "upstream",
      finalizationTransport: "billing_queue",
      adminHeartbeat: {
        completion_reason: "stream_error",
        usage_recovered_after_error: true,
      },
    });
    expect(settled.log.finalizationEventId).toMatch(
      /^relay-finalization-v1:relayreserve-/,
    );
    await expect(providerState()).resolves.toMatchObject({
      count: 1,
      relayStreamFailurePlanned: true,
      relayStreamUsageBeforeFailure: true,
    });
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
    expect(status.tenant_authority_replay_binding_bound).toBe(false);
    expect(status.outbound_auth_mode).toBe("platform-outbound-v1");
    expect(status.tenant_cloudflare_token_bound).toBe(false);
  });

  it("rejects missing, forged, and exact-request-mismatched outbound authority", async () => {
    await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/reset",
      {
        method: "POST",
      },
    );
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "openai/gpt-4.1-mini",
        input: "authority negative",
      }),
    );
    const authority = await signedAuthority({
      requestId: "runtime-outbound-negative",
      path: "/v1/responses",
      body,
    });

    const missing = await tenantRequest(null, body);
    expect(missing.status).toBe(403);

    const changedBody = new TextEncoder().encode(
      JSON.stringify({ model: "openai/gpt-4.1-mini", input: "changed" }),
    );
    const bodyMismatch = await tenantRequest(authority.token, changedBody);
    expect(bodyMismatch.status).toBe(403);

    const pathMismatch = await tenantRequest(
      authority.token,
      body,
      "/v1/chat/completions",
    );
    expect(pathMismatch.status).toBe(403);

    const missingContext = await outboundRequest(
      env.WFP_OUTBOUND_MISSING_CONTEXT,
      authority.token,
      body,
    );
    expect(missingContext.status).toBe(503);

    const wrongContext = await outboundRequest(
      env.WFP_OUTBOUND_WRONG_CONTEXT,
      authority.token,
      body,
    );
    expect(wrongContext.status).toBe(403);

    const wrongPolicyAuthority = await signedAuthority({
      requestId: "runtime-outbound-wrong-policy",
      path: "/v1/responses",
      body,
      policyProfile: "tenant-controlled-v1",
    });
    const wrongPolicy = await outboundRequest(
      env.WFP_OUTBOUND_RUNTIME,
      wrongPolicyAuthority.token,
      body,
    );
    expect(wrongPolicy.status).toBe(403);

    const [forgedPayload, originalSignature] = authority.token.split(".");
    const forgedSignature = `${
      originalSignature.startsWith("A") ? "B" : "A"
    }${originalSignature.slice(1)}`;
    const forged = `${forgedPayload}.${forgedSignature}`;
    const forgedResponse = await tenantRequest(forged, body);
    expect(forgedResponse.status).toBe(403);

    const stateResponse = await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/state",
    );
    expect(await stateResponse.json()).toEqual({ count: 0 });
  });

  it("discards tenant Gateway policy and rebuilds platform-owned headers", async () => {
    await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/reset",
      { method: "POST" },
    );
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "openai/gpt-4.1-mini",
        input: "policy boundary",
      }),
    );
    const authority = await signedAuthority({
      requestId: "runtime-outbound-policy",
      path: "/v1/responses",
      body,
    });
    const response = await outboundRequest(
      env.WFP_OUTBOUND_RUNTIME,
      authority.token,
      body,
      {
        "cf-aig-gateway-id": "tenant-spoofed-gateway",
        "cf-aig-max-attempts": "9",
        "cf-aig-collect-log": "false",
        "cf-aig-metadata": '{"tenant":"spoofed"}',
        "x-cinatoken-tenant": "spoofed-tenant",
      },
    );
    expect(response.status).toBe(200);

    const stateResponse = await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/state",
    );
    const state = await stateResponse.json();
    expect(state).toMatchObject({
      count: 1,
      gatewayId: "runtime-outbound-gateway",
      maxAttempts: "1",
      collectLog: "true",
    });
    expect(state.metadata).not.toContain("spoofed");
    expect(JSON.parse(state.metadata).cinatoken).toMatchObject({
      request_id: "runtime-outbound-policy",
      policy_profile: "platform-ai-gateway-v1",
    });
  });

  it("allows one concurrent provider egress for one signed authority", async () => {
    await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/reset",
      {
        method: "POST",
      },
    );
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
      authorityPresent: false,
      workerMarkerPresent: false,
      cookiePresent: false,
      contentType: "application/json",
      gatewayId: "runtime-outbound-gateway",
      maxAttempts: "1",
      collectLog: "true",
    });
    const metadata = JSON.parse(state.metadata);
    expect(metadata.cinatoken).toMatchObject({
      authority_version: 3,
      channel_id: 42,
      dispatch_worker: workerName,
      policy_profile: "platform-ai-gateway-v1",
      request_id: "runtime-cross-worker",
      worker: workerName,
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

function quotaCoordinatorStub(tokenId) {
  return env.QUOTA_COORD.getByName(`token:${tokenId}`);
}

function quotaHex(character) {
  return character.repeat(64);
}

async function observeQuota(stub, tokenId, observation) {
  const retainedObservation = {
    source_committed_at: 100,
    ...observation,
  };
  const response = await stub.fetch(
    "https://quota-coordinator.internal/observe",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [quotaTokenIdHeader]: `${tokenId}`,
      },
      body: JSON.stringify(retainedObservation),
    },
  );
  await response.arrayBuffer();
  return response;
}

async function quotaCoordinatorStatus(stub, tokenId) {
  const response = await stub.fetch(
    "https://quota-coordinator.internal/status",
    {
      headers: { [quotaTokenIdHeader]: `${tokenId}` },
    },
  );
  return { response, status: await response.json() };
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

function tenantRequest(token, body, path = "/v1/responses") {
  const headers = {
    "content-type": "application/json",
    [wfpRouteHeader]: "relay-authority",
    [wfpWorkerHeader]: workerName,
  };
  if (token !== null) headers["x-cinatoken-wfp-authority"] = token;
  return env.WFP_TENANT_RUNTIME.fetch(`https://tenant-runtime${path}`, {
    method: "POST",
    headers,
    body,
  });
}

function outboundRequest(binding, token, body, extraHeaders = {}) {
  return binding.fetch(
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/responses",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-wfp-authority": token,
        ...extraHeaders,
      },
      body,
    },
  );
}

async function signedAuthority({
  requestId,
  path = "/v1/responses",
  body = new Uint8Array(),
  dispatchWorker = workerName,
  policyProfile = "platform-ai-gateway-v1",
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    version: 3,
    worker: workerName,
    dispatch_worker: dispatchWorker,
    policy_profile: policyProfile,
    method: "POST",
    path,
    body_sha256: await sha256Hex(body),
    request_id: requestId,
    channel_id: 42,
    issued_at: issuedAt,
    expires_at: issuedAt + 30,
  };
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const signature = await hmac(
    new TextEncoder().encode(authoritySecret),
    concatBytes(
      new TextEncoder().encode("cinatoken-wfp-central-authority:v3\0"),
      new TextEncoder().encode(workerName),
      new Uint8Array([0]),
      payload,
    ),
  );
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
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function concatBytes(...parts) {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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

function nextJsonWebSocketMessageMatching(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for ${label}`));
    }, 5_000);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openAuthenticatedRealtimeSession() {
  const response = await SELF.fetch(
    `https://worker.test/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
    {
      headers: {
        Authorization: `Bearer ${realtimeToken}`,
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "cnVudGltZS1yZWFsdGltZQ==",
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
  throw new Error(
    `runtime bridge did not detach: ${JSON.stringify(lastStatus)}`,
  );
}

function realtimeSessionStatus(stub, session) {
  return stub
    .fetch(
      `https://realtime-session.internal/api/platform/realtime/${session}/status`,
    )
    .then((response) => response.json());
}

function providerState() {
  return env.REALTIME_PROVIDER_MOCK.fetch(
    "https://realtime-provider-mock/__mock/state",
  ).then((response) => response.json());
}

function requestUnsetFlatModel() {
  return SELF.fetch("https://cinatoken.test/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${relayUnsetToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: relayUnsetModel,
      stream: false,
      messages: [{ role: "user", content: "runtime unset admission" }],
    }),
  });
}

async function seedAuthenticatedRealtimeGateway({
  mockFault = "runtime_detached",
  upstreamModel = realtimeModel,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const userQuota = 1_000_000;
  const tokenRemainQuota = 500_000;
  const otherInfo = JSON.stringify({
    realtime_mock_upstream: {
      queue_probe_delay_ms: 100,
      ...(mockFault ? { fault: mockFault } : {}),
    },
  });
  const modelMapping =
    upstreamModel === realtimeModel
      ? null
      : JSON.stringify({ [realtimeModel]: upstreamModel });
  const billingExpression = 'tier("runtime_realtime", p * 2 + c * 8)';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
        (id, username, password, display_name, role, status, email, quota,
         used_quota, request_count, "group", aff_code, created_at, deleted_at)
       VALUES (1, 'runtime-user', 'disabled-runtime-user', 'Runtime Realtime',
         1, 1, '', ?1, 0, 0, 'default', 'runtime1', ?2, NULL)`,
    ).bind(userQuota, now),
    env.DB.prepare(
      `INSERT INTO tokens
        (id, user_id, "key", status, name, created_time, accessed_time,
         expired_time, remain_quota, unlimited_quota, model_limits_enabled,
         model_limits, allow_ips, used_quota, "group", cross_group_retry, deleted_at)
       VALUES (1, 1, ?1, 1, 'runtime realtime token', ?2, 0, -1, ?3, 0,
         1, ?4, '', 0, 'default', 0, NULL)`,
    ).bind(realtimeToken, now, tokenRemainQuota, realtimeModel),
    env.DB.prepare(
      `INSERT INTO channels
        (id, type, "key", status, name, weight, created_time, base_url, other,
         balance, models, "group", used_quota, model_mapping,
         status_code_mapping, priority, auto_ban, other_info, channel_info, settings)
       VALUES (42, 1, 'runtime-upstream-secret', 1, 'runtime realtime upstream',
         1000, ?1, 'https://realtime-provider.invalid', '', 0, ?2, 'default',
         0, ?3, '', 1000, 0, ?4, '{}', '')`,
    ).bind(now, realtimeModel, modelMapping, otherInfo),
    env.DB.prepare(
      `INSERT INTO abilities
        (group_name, model, channel_id, enabled, priority, weight)
       VALUES ('default', ?1, 42, 1, 1000, 1000)`,
    ).bind(realtimeModel),
    env.DB.prepare(
      `INSERT INTO options ("key", value)
       VALUES ('billing_setting.billing_mode', ?1)`,
    ).bind(JSON.stringify({ [realtimeModel]: "tiered_expr" })),
    env.DB.prepare(
      `INSERT INTO options ("key", value)
       VALUES ('billing_setting.billing_expr', ?1)`,
    ).bind(JSON.stringify({ [realtimeModel]: billingExpression })),
  ]);
  return { userQuota, tokenRemainQuota };
}

async function seedStreamingRelayBillingGateway({
  model = relayStreamModel,
  token = relayStreamToken,
  channelType = 1,
  billingExpression = 'tier("runtime_stream", p * 2 + c * 8)',
  pricingOptions = {},
  acceptUnsetRatioModel = false,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const userQuota = 1_000_000;
  const tokenRemainQuota = 500_000;
  const statements = [
    env.DB.prepare(
      `INSERT INTO users
        (id, username, password, display_name, role, status, email, quota,
         used_quota, request_count, "group", aff_code, setting, created_at, deleted_at)
       VALUES (1, 'runtime-stream-user', 'disabled-runtime-user', 'Runtime Stream',
         1, 1, '', ?1, 0, 0, 'default', 'stream01', ?3, ?2, NULL)`,
    ).bind(
      userQuota,
      now,
      JSON.stringify({
        accept_unset_model_ratio_model: acceptUnsetRatioModel,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO tokens
        (id, user_id, "key", status, name, created_time, accessed_time,
         expired_time, remain_quota, unlimited_quota, model_limits_enabled,
         model_limits, allow_ips, used_quota, "group", cross_group_retry, deleted_at)
       VALUES (1, 1, ?1, 1, 'runtime stream token', ?2, 0, -1, ?3, 0,
         1, ?4, '', 0, 'default', 0, NULL)`,
    ).bind(token, now, tokenRemainQuota, model),
    env.DB.prepare(
      `INSERT INTO channels
        (id, type, "key", status, name, weight, created_time, base_url, other,
         balance, models, "group", used_quota, model_mapping,
         status_code_mapping, priority, auto_ban, other_info, channel_info, settings)
       VALUES (43, ?3, 'runtime-stream-upstream-secret', 1, 'runtime stream upstream',
         1000, ?1, 'https://realtime-provider.invalid', '', 0, ?2, 'default',
         0, NULL, '', 1000, 0, '{}', '{}', '')`,
    ).bind(now, model, channelType),
    env.DB.prepare(
      `INSERT INTO abilities
        (group_name, model, channel_id, enabled, priority, weight)
       VALUES ('default', ?1, 43, 1, 1000, 1000)`,
    ).bind(model),
  ];
  if (billingExpression !== null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO options ("key", value)
         VALUES ('billing_setting.billing_mode', ?1)`,
      ).bind(JSON.stringify({ [model]: "tiered_expr" })),
      env.DB.prepare(
        `INSERT INTO options ("key", value)
         VALUES ('billing_setting.billing_expr', ?1)`,
      ).bind(JSON.stringify({ [model]: billingExpression })),
    );
  }
  for (const [key, value] of Object.entries(pricingOptions)) {
    statements.push(
      env.DB.prepare(`INSERT INTO options ("key", value) VALUES (?1, ?2)`).bind(
        key,
        JSON.stringify(value),
      ),
    );
  }
  await env.DB.batch(statements);
  return { userQuota, tokenRemainQuota };
}

async function seedRealtimeBillingAccount({
  userQuota = 900,
  tokenRemainQuota = 400,
  tokenUsedQuota = 100,
} = {}) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, username, password, quota) VALUES (1, 'runtime-user', 'x', ?1)",
    ).bind(userQuota),
    env.DB.prepare(
      "INSERT INTO tokens (id, user_id, key, remain_quota, used_quota) VALUES (1, 1, 'runtime-token', ?1, ?2)",
    ).bind(tokenRemainQuota, tokenUsedQuota),
  ]);
}

async function setupAndLoginBillingRoot() {
  const password = "RuntimeRootPassword123!";
  await env.DB.prepare(
    "UPDATE users SET aff_code = 'runtime-billing-user' WHERE id = 1",
  ).run();
  const setup = await SELF.fetch("https://cinatoken.test/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "runtime-root",
      password,
      display_name: "Runtime Root",
    }),
  });
  expect(setup.status).toBe(200);

  const login = await SELF.fetch("https://cinatoken.test/api/user/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "runtime-root", password }),
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie");
  expect(setCookie).toContain("session=");
  return { cookie: setCookie.split(";", 1)[0], password };
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

async function seedContainerReconciliationObservation(suffix) {
  const now = Math.floor(Date.now() / 1000);
  const operationId = `relaycontainer-runtime-observer-${suffix}`;
  const identity =
    suffix === "1"
      ? { client: "c", request: "d", reconciliation: "e" }
      : { client: "1", request: "2", reconciliation: "3" };
  const reconciliationId = identity.reconciliation.repeat(64);
  const claimOwner = "c".repeat(32);
  const inputSha256 = "b".repeat(64);
  const operationCreatedAt = now - 200;
  const executionDeadlineAt = now - 100;
  const ownerLeaseExpiresAt = now + 600;
  const observationCreatedAt = now - 10;

  await env.DB.prepare(
    `INSERT INTO relay_container_operations (
       reservation_key, operation_id, owner_generation,
       owner_lease_expires_at, channel_id, selected_group, operation_kind,
       provider_operation_id, admission_sha256, protocol_version,
       shard_contract_version, ring_generation, shard_count, shard_index,
       instance_name, execution_deadline_at, input_mode, input_object_key,
       input_object_version, input_sha256, input_size, input_content_type,
       trace_id, client_idempotency_hmac_sha256, client_request_sha256,
       reconciliation_id, status, created_at, updated_at
     ) VALUES (
       ?1, ?1, 2, ?2, 42, 'default', 'health_probe',
       ?11, ?3, 1, 1, 1, 8, 3,
       'cinatoken-relay-shard-v1-0003', ?4, 'r2', ?5,
       ?12, ?6, 0, 'application/json',
       ?13, ?7, ?8, ?9, 'prepared', ?10, ?10
     )`,
  )
    .bind(
      operationId,
      ownerLeaseExpiresAt,
      "a".repeat(64),
      executionDeadlineAt,
      `container-inputs/v1/${operationId}/2/${inputSha256}`,
      inputSha256,
      identity.client.repeat(64),
      identity.request.repeat(64),
      reconciliationId,
      operationCreatedAt,
      `provider-runtime-observer-${suffix}`,
      `input-version-runtime-${suffix}`,
      `trace-runtime-observer-${suffix}`,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO relay_container_reconciliation_observations (
       operation_id, reservation_key, operation_created_at,
       owner_generation, reconciliation_id, status, available_at,
       recovery_deadline_at, created_at, updated_at
     ) VALUES (?1, ?1, ?2, 2, ?3, 'pending', ?4, ?5, ?4, ?4)`,
  )
    .bind(
      operationId,
      operationCreatedAt,
      reconciliationId,
      observationCreatedAt,
      observationCreatedAt + 86_400,
    )
    .run();
  await env.DB.prepare(
    `UPDATE relay_container_reconciliation_observations
     SET status = 'leased', claim_generation = 1, claim_owner = ?2,
         claim_lease_expires_at = ?4, available_at = 0, attempt_count = 1,
         first_observed_at = ?3, last_attempt_at = ?3, updated_at = ?3
     WHERE operation_id = ?1`,
  )
    .bind(
      operationId,
      claimOwner,
      observationCreatedAt + 1,
      observationCreatedAt + 31,
    )
    .run();
  await env.DB.prepare(
    `UPDATE relay_container_reconciliation_observations
     SET status = 'retry', claim_owner = '', claim_lease_expires_at = 0,
         available_at = ?3, consecutive_failures = 1,
         last_observed_at = ?2, last_class = 'store_unavailable',
         last_error_code = 'controller_status_unavailable', updated_at = ?2
     WHERE operation_id = ?1`,
  )
    .bind(
      operationId,
      observationCreatedAt + 2,
      suffix === "1" ? now - 1 : now + 300,
    )
    .run();

  return { operationId, reconciliationId, claimOwner };
}

async function deadLetterContainerReconciliationObservation(operationId) {
  const now = Math.floor(Date.now() / 1000);
  const claimAt = now - 1;
  const deadLetterAt = now;
  await env.DB.prepare(
    `UPDATE relay_container_reconciliation_observations
     SET status = 'leased', claim_generation = claim_generation + 1,
         claim_owner = ?2, claim_lease_expires_at = ?4, available_at = 0,
         attempt_count = attempt_count + 1, last_attempt_at = ?3,
         updated_at = ?3
     WHERE operation_id = ?1 AND status = 'retry'`,
  )
    .bind(operationId, "d".repeat(32), claimAt, claimAt + 60)
    .run();
  await env.DB.prepare(
    `UPDATE relay_container_reconciliation_observations
     SET status = 'dead_letter', claim_owner = '', claim_lease_expires_at = 0,
         available_at = 0, last_observed_at = ?2,
         last_class = 'terminal_conflict',
         last_error_code = 'controller_contract_violation',
         dead_lettered_at = ?2, dead_letter_reason = 'terminal_conflict',
         updated_at = ?2
     WHERE operation_id = ?1 AND status = 'leased'`,
  )
    .bind(operationId, deadLetterAt)
    .run();
}

async function seedRelayBillingReservation({
  reservationKey,
  leaseExpiresAt,
  bound = false,
}) {
  const channelId = bound ? 42 : 0;
  const selectedGroup = bound ? "default" : "";
  const selectedAt = bound ? 1 : 0;
  const ownerGeneration = bound ? 2 : 1;
  await env.DB.prepare(
    `INSERT INTO relay_billing_reservations (
      reservation_key, user_id, token_id, model_name, endpoint_path, expr_hash,
      candidate_group_count, reservation_strategy, pre_consumed_quota,
      status, channel_id, selected_group, selected_at, owner_generation,
      owner_deadline_at,
      created_at, updated_at, lease_expires_at
    ) VALUES (?1, 1, 1, 'gpt-runtime', 'chat/completions', 'sha256:runtime',
      1, 'selected_group', 100, 'reserved', ?2, ?3, ?4, ?5, ?6, 1, 1, ?6)`,
  )
    .bind(
      reservationKey,
      channelId,
      selectedGroup,
      selectedAt,
      ownerGeneration,
      leaseExpiresAt,
    )
    .run();
}

async function relayBillingState(reservationKey) {
  const [reservation, user, token] = await Promise.all([
    env.DB.prepare(
      `SELECT status, finalization_reason, request_accounted, refunded_at,
              recovery_required_at, owner_generation
       FROM relay_billing_reservations
       WHERE reservation_key = ?1`,
    )
      .bind(reservationKey)
      .first(),
    env.DB.prepare(
      "SELECT quota, request_count FROM users WHERE id = 1",
    ).first(),
    env.DB.prepare(
      "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
    ).first(),
  ]);
  return { reservation, user, token };
}

async function waitForBillingIncidentResolution(reservationKey, incidentId) {
  const deadline = Date.now() + 5_000;
  let result;
  while (Date.now() < deadline) {
    const [state, incident, billingAudit, adminAudit] = await Promise.all([
      relayBillingState(reservationKey),
      env.DB.prepare(
        `SELECT status, replay_generation, replay_attempt_count, resolution
         FROM relay_billing_finalization_incidents
         WHERE incident_id = ?1`,
      )
        .bind(incidentId)
        .first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM logs
         WHERE billing_finalization_event_id = ?1`,
      )
        .bind(`relay-finalization-v1:${reservationKey}`)
        .first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM logs
         WHERE type = 3 AND instr(other, ?1) > 0`,
      )
        .bind(incidentId)
        .first(),
    ]);
    result = {
      ...state,
      incident,
      billingAuditCount: Number(billingAudit?.count ?? 0),
      adminAuditCount: Number(adminAudit?.count ?? 0),
    };
    if (
      state.reservation?.status === "refunded" &&
      incident?.status === "resolved" &&
      result.billingAuditCount === 1 &&
      result.adminAuditCount === 1
    ) {
      return result;
    }
    await delay(10);
  }
  throw new Error(
    `billing incident was not resolved: ${JSON.stringify(result)}`,
  );
}

async function waitForRelayBillingReservation(modelName) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    const [reservation, user] = await Promise.all([
      env.DB.prepare(
        `SELECT reservation_key, status, channel_id, selected_group,
                request_id_hash, pre_consumed_quota, lease_expires_at, request_accounted,
                owner_generation
         FROM relay_billing_reservations
         WHERE model_name = ?1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
        .bind(modelName)
        .first(),
      env.DB.prepare(
        "SELECT quota, request_count FROM users WHERE id = 1",
      ).first(),
    ]);
    state = { reservation, user };
    if (reservation?.status === "reserved" && reservation.channel_id > 0)
      return state;
    await delay(10);
  }
  throw new Error(`relay reservation was not bound: ${JSON.stringify(state)}`);
}

async function waitForRelayTerminalByModel(modelName, expectedStatus) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    const reservation = await env.DB.prepare(
      `SELECT reservation_key, status, pre_consumed_quota, final_quota,
              finalization_reason, request_accounted
       FROM relay_billing_reservations
       WHERE model_name = ?1
       ORDER BY created_at DESC
       LIMIT 1`,
    )
      .bind(modelName)
      .first();
    const reservationKey = reservation?.reservation_key;
    const [user, token, channel, log] = await Promise.all([
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = 1",
      ).first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = 43").first(),
      reservationKey
        ? env.DB.prepare(
            `SELECT other, billing_finalization_event_id
             FROM logs WHERE billing_finalization_event_id = ?1
             ORDER BY id DESC LIMIT 1`,
          )
            .bind(`relay-finalization-v1:${reservationKey}`)
            .first()
        : Promise.resolve(null),
    ]);
    let usageSource = null;
    let nonStreamUsageParseFailed = false;
    let parseFallbackReason = null;
    let finalizationTransport = null;
    if (typeof log?.other === "string" && log.other.length > 0) {
      const other = JSON.parse(log.other);
      usageSource = other?.usage_source ?? null;
      nonStreamUsageParseFailed = other?.non_stream_usage_parse_failed === true;
      parseFallbackReason =
        other?.tiered_billing_parse_fallback?.reason ?? null;
      finalizationTransport = other?.billing_finalization_transport ?? null;
    }
    state = {
      reservation,
      user,
      token,
      channel,
      log: {
        usageSource,
        nonStreamUsageParseFailed,
        parseFallbackReason,
        finalizationTransport,
        finalizationEventId: log?.billing_finalization_event_id ?? null,
      },
    };
    if (reservation?.status === expectedStatus && log) return state;
    await delay(10);
  }
  throw new Error(
    `relay reservation did not reach ${expectedStatus}: ${JSON.stringify(state)}`,
  );
}

async function waitForNonTieredRelayLog(modelName) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    const [user, token, channel, reservationCount, reservation, log] =
      await Promise.all([
        env.DB.prepare(
          "SELECT quota, used_quota, request_count FROM users WHERE id = 1",
        ).first(),
        env.DB.prepare(
          "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
        ).first(),
        env.DB.prepare("SELECT used_quota FROM channels WHERE id = 43").first(),
        env.DB.prepare(
          "SELECT COUNT(*) AS count FROM relay_billing_reservations WHERE model_name = ?1",
        )
          .bind(modelName)
          .first(),
        env.DB.prepare(
          `SELECT billing_kind, expr_hash, billing_snapshot_json,
                length(billing_snapshot_json) AS snapshot_bytes,
                status, pre_consumed_quota, final_quota, request_accounted
         FROM relay_billing_reservations
         WHERE model_name = ?1
         ORDER BY created_at DESC LIMIT 1`,
        )
          .bind(modelName)
          .first(),
        env.DB.prepare(
          `SELECT quota, other FROM logs
         WHERE model_name = ?1 AND type = 2
         ORDER BY id DESC LIMIT 1`,
        )
          .bind(modelName)
          .first(),
      ]);
    let parsedLog = null;
    if (typeof log?.other === "string" && log.other.length > 0) {
      const other = JSON.parse(log.other);
      parsedLog = {
        quota: log.quota,
        billingPending: other?.billing_pending,
        billingLedgerOutcome: other?.billing_ledger_outcome,
        usageSource: other?.usage_source,
        usageSemantic: other?.usage_semantic,
        usageSemanticSource: other?.usage_semantic_source,
        providerCostUsd: other?.provider_cost_usd,
        cacheCreationSource: other?.cache_creation_source,
        openRouterCacheWriteApplied:
          other?.openrouter_cache_write_inference?.applied,
        openRouterCacheWriteTokens:
          other?.openrouter_cache_write_inference?.candidate_tokens,
        flatBillingMode: other?.flat_billing?.mode,
        reservationClass:
          other?.non_stream_billing_observation?.reservation_class,
        clientDisposition:
          other?.non_stream_billing_observation?.client_disposition,
      };
    }
    state = {
      user,
      token,
      channel,
      reservation,
      reservationCount: reservationCount?.count ?? -1,
      log: parsedLog,
    };
    if (
      parsedLog &&
      reservation &&
      ["settled", "refunded", "recovery_required"].includes(reservation.status)
    ) {
      return state;
    }
    await delay(10);
  }
  throw new Error(
    `non-tiered relay audit was not recorded: ${JSON.stringify(state)}`,
  );
}

async function waitForRelayLeaseRenewal(reservationKey, previousLease) {
  const deadline = Date.now() + 10_000;
  let state;
  while (Date.now() < deadline) {
    const [reservation, user] = await Promise.all([
      env.DB.prepare(
        `SELECT status, lease_expires_at, owner_generation
         FROM relay_billing_reservations
         WHERE reservation_key = ?1`,
      )
        .bind(reservationKey)
        .first(),
      env.DB.prepare(
        "SELECT quota, request_count FROM users WHERE id = 1",
      ).first(),
    ]);
    state = { reservation, user };
    if (reservation?.lease_expires_at > previousLease) return state;
    await delay(25);
  }
  throw new Error(`relay lease was not renewed: ${JSON.stringify(state)}`);
}

async function waitForRelaySettlement(reservationKey) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    const [reservation, user, token, channel, log] = await Promise.all([
      env.DB.prepare(
        `SELECT status, request_accounted, final_quota, lease_expires_at,
                owner_generation
         FROM relay_billing_reservations
         WHERE reservation_key = ?1`,
      )
        .bind(reservationKey)
        .first(),
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = 1",
      ).first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = 43").first(),
      env.DB.prepare(
        `SELECT other, billing_finalization_event_id
         FROM logs WHERE billing_finalization_event_id = ?1
         ORDER BY id DESC LIMIT 1`,
      )
        .bind(`relay-finalization-v1:${reservationKey}`)
        .first(),
    ]);
    let adminHeartbeat = null;
    let usageSource = null;
    let finalizationTransport = null;
    let finalizationEventId = log?.billing_finalization_event_id ?? null;
    if (typeof log?.other === "string" && log.other.length > 0) {
      const other = JSON.parse(log.other);
      adminHeartbeat = other?.admin_info?.relay_billing_stream_lease_heartbeat;
      usageSource = other?.usage_source ?? null;
      finalizationTransport = other?.billing_finalization_transport ?? null;
    }
    state = {
      reservation,
      user,
      token,
      channel,
      log: {
        adminHeartbeat,
        usageSource,
        finalizationTransport,
        finalizationEventId,
      },
    };
    if (reservation?.status === "settled" && adminHeartbeat) return state;
    await delay(10);
  }
  throw new Error(
    `relay reservation was not settled: ${JSON.stringify(state)}`,
  );
}

async function waitForQuotaCoordinatorSummary(tokenId, observationCount) {
  const deadline = Date.now() + 5_000;
  let summary;
  while (Date.now() < deadline) {
    const result = await quotaCoordinatorStatus(
      quotaCoordinatorStub(tokenId),
      tokenId,
    );
    summary = result.status;
    if (summary.observation_count >= observationCount) return summary;
    await delay(10);
  }
  throw new Error(
    `QuotaCoordinator did not reach ${observationCount} observations: ${JSON.stringify(summary)}`,
  );
}

async function waitForQuotaCoordinatorTerminal(tokenId, terminalKind) {
  const countField = `${terminalKind}_count`;
  const deadline = Date.now() + 5_000;
  let summary;
  while (Date.now() < deadline) {
    const result = await quotaCoordinatorStatus(
      quotaCoordinatorStub(tokenId),
      tokenId,
    );
    summary = result.status;
    if (
      Number(summary[countField] ?? 0) >= 1 &&
      summary.active_reservations === 0
    ) {
      return summary;
    }
    await delay(10);
  }
  throw new Error(
    `QuotaCoordinator did not observe ${terminalKind}: ${JSON.stringify(summary)}`,
  );
}

async function relayBillingFinalizationEvent(reservationKey) {
  const [reservation, log] = await Promise.all([
    env.DB.prepare(
      `SELECT expr_hash, channel_id, selected_group, final_quota,
              finalization_reason, settled_at, owner_generation
       FROM relay_billing_reservations
       WHERE reservation_key = ?1`,
    )
      .bind(reservationKey)
      .first(),
    env.DB.prepare(
      `SELECT billing_finalization_event_id, user_id, created_at,
              type AS log_type, content, model_name, quota, prompt_tokens,
              completion_tokens, use_time, is_stream, channel_id, token_id,
              "group" AS selected_group, other
       FROM logs
       WHERE billing_finalization_event_id <> ''
         AND other LIKE ?1
       ORDER BY id DESC
       LIMIT 1`,
    )
      .bind(`%${reservationKey}%`)
      .first(),
  ]);
  if (!reservation || !log) {
    throw new Error(`missing finalization event state for ${reservationKey}`);
  }
  return {
    event_type: "cinatoken.relay_billing_finalization",
    schema_version: 2,
    event_id: log.billing_finalization_event_id,
    reservation_key: reservationKey,
    owner_generation: reservation.owner_generation - 1,
    expr_hash: reservation.expr_hash,
    channel_id: reservation.channel_id,
    selected_group: reservation.selected_group,
    finalized_at: reservation.settled_at,
    finalization: {
      action: "settle",
      final_quota: reservation.final_quota,
      finalization_reason: reservation.finalization_reason,
    },
    audit_log: {
      user_id: log.user_id,
      created_at: log.created_at,
      log_type: log.log_type,
      content: log.content,
      model_name: log.model_name,
      quota: log.quota,
      prompt_tokens: log.prompt_tokens,
      completion_tokens: log.completion_tokens,
      use_time: log.use_time,
      is_stream: log.is_stream,
      channel_id: log.channel_id,
      token_id: log.token_id,
      group: log.selected_group,
      other: log.other,
    },
  };
}

function relayBillingRefundEvent(reservationKey, finalizedAt) {
  const eventId = `relay-finalization-v1:${reservationKey}`;
  return {
    event_type: "cinatoken.relay_billing_finalization",
    schema_version: 2,
    event_id: eventId,
    reservation_key: reservationKey,
    owner_generation: 2,
    expr_hash: "sha256:runtime",
    channel_id: 42,
    selected_group: "default",
    finalized_at: finalizedAt,
    finalization: {
      action: "refund",
      finalization_reason: "upstream_failure",
      account_request: true,
    },
    audit_log: {
      user_id: 1,
      created_at: finalizedAt,
      log_type: 2,
      content: "Rust relay refunded by billing Queue",
      model_name: "gpt-runtime",
      quota: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      use_time: 1,
      is_stream: 1,
      channel_id: 42,
      token_id: 1,
      group: "default",
      other: JSON.stringify({
        billing_finalization_event_id: eventId,
        billing_finalization_transport: "billing_queue",
        billing_reservation_key: reservationKey,
      }),
    },
  };
}

async function deliverQueueMessages(queueName, messages) {
  const batch = createMessageBatch(
    queueName,
    messages.map((message) => ({
      id: message.id,
      timestamp: new Date(),
      attempts: 1,
      body: message.body,
    })),
  );
  const ctx = createExecutionContext();
  await runQueue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

async function relayBillingFinalizationState(eventId) {
  const [audit, user, token] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM logs
       WHERE billing_finalization_event_id = ?1`,
    )
      .bind(eventId)
      .first(),
    env.DB.prepare(
      "SELECT quota, request_count FROM users WHERE id = 1",
    ).first(),
    env.DB.prepare("SELECT remain_quota FROM tokens WHERE id = 1").first(),
  ]);
  return {
    auditCount: Number(audit?.count ?? 0),
    requestCount: user?.request_count,
    userQuota: user?.quota,
    tokenRemainQuota: token?.remain_quota,
  };
}

async function realtimeBillingState(reservationKey) {
  const [reservation, user, token] = await Promise.all([
    env.DB.prepare(
      `SELECT status, bridge_segment, final_quota, refunded_at, recovery_attempt_count,
              recovery_next_attempt_at, finalization_owner,
              finalization_reason, finalization_required_at,
              reconciliation_resolution, reconciliation_revision,
              reconciliation_resolved_at
       FROM realtime_billing_reservations
       WHERE reservation_key = ?1`,
    )
      .bind(reservationKey)
      .first(),
    env.DB.prepare(
      "SELECT quota, request_count FROM users WHERE id = 1",
    ).first(),
    env.DB.prepare(
      "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
    ).first(),
  ]);
  return { reservation, user, token };
}

async function realtimeBillingMutationCounts() {
  const [replay, audit] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM realtime_settlement_replays",
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE channel_id = 42 AND type = 2",
    ).first(),
  ]);
  return {
    replayCount: Number(replay?.count ?? 0),
    auditCount: Number(audit?.count ?? 0),
  };
}

async function waitForRealtimeReservation(session) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    const [reservation, user, token] = await Promise.all([
      env.DB.prepare(
        `SELECT reservation_key, status, bridge_segment, reservation_sequence,
                pre_consumed_quota
         FROM realtime_billing_reservations
         WHERE session = ?1
         ORDER BY reservation_sequence DESC
         LIMIT 1`,
      )
        .bind(session)
        .first(),
      env.DB.prepare("SELECT quota FROM users WHERE id = 1").first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = 1",
      ).first(),
    ]);
    state = { reservation, user, token };
    if (reservation?.status === "reserved") return state;
    await delay(10);
  }
  throw new Error(
    `authenticated Realtime reservation was not created: ${JSON.stringify(state)}`,
  );
}

async function waitForRealtimeRefund(reservationKey) {
  const deadline = Date.now() + 5_000;
  let state;
  while (Date.now() < deadline) {
    state = await realtimeBillingState(reservationKey);
    if (state.reservation?.status === "refunded") return state;
    await delay(10);
  }
  throw new Error(
    `realtime reservation was not refunded: ${JSON.stringify(state)}`,
  );
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
      resolve({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
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

async function runScheduledRecovery() {
  const ctx = createExecutionContext();
  const controller = createScheduledController({
    cron: "* * * * *",
    scheduledTime: Date.now(),
  });
  await runScheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}
