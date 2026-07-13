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
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(async () => {
  await reset();
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
        d1_migration_applied_count: 26,
        d1_expected_migration: "0026_relay_billing_owner_generation.sql",
        d1_migration_ready: true,
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
        quota_coordinator_shadow_enabled: false,
        quota_coordinator_foundation_compiled: true,
        quota_coordinator_observer_contract_compiled: true,
        quota_coordinator_relay_observation_compiled: false,
        quota_coordinator_tiered_only: true,
        quota_coordinator_write_authority_enabled: false,
        quota_coordinator_staging_verified: false,
        quota_coordinator_shadow_runtime_ready: false,
        quota_coordinator_cutover_ready: false,
      },
    });
    expect(payload.data.quota_coordinator_cutover_guards).toEqual([
      "quota_coord_binding",
      "shadow_gate",
      "tiered_only",
      "observer_contract",
      "relay_observation",
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
  const response = await stub.fetch("https://quota-coordinator.internal/observe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [quotaTokenIdHeader]: `${tokenId}`,
    },
    body: JSON.stringify(observation),
  });
  await response.arrayBuffer();
  return response;
}

async function quotaCoordinatorStatus(stub, tokenId) {
  const response = await stub.fetch("https://quota-coordinator.internal/status", {
    headers: { [quotaTokenIdHeader]: `${tokenId}` },
  });
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

function outboundRequest(binding, token, body) {
  return binding.fetch(
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/responses",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-wfp-authority": token,
      },
      body,
    },
  );
}

async function signedAuthority({
  requestId,
  path = "/v1/responses",
  body = new Uint8Array(),
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    version: 2,
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
  const signature = await hmac(
    new TextEncoder().encode(authoritySecret),
    concatBytes(
      new TextEncoder().encode("cinatoken-wfp-central-authority:v2\0"),
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

async function seedAuthenticatedRealtimeGateway() {
  const now = Math.floor(Date.now() / 1000);
  const userQuota = 1_000_000;
  const tokenRemainQuota = 500_000;
  const otherInfo = JSON.stringify({
    realtime_mock_upstream: {
      queue_probe_delay_ms: 100,
      fault: "runtime_detached",
    },
  });
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
         0, NULL, '', 1000, 0, ?3, '{}', '')`,
    ).bind(now, realtimeModel, otherInfo),
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
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const userQuota = 1_000_000;
  const tokenRemainQuota = 500_000;
  const billingExpression = 'tier("runtime_stream", p * 2 + c * 8)';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
        (id, username, password, display_name, role, status, email, quota,
         used_quota, request_count, "group", aff_code, created_at, deleted_at)
       VALUES (1, 'runtime-stream-user', 'disabled-runtime-user', 'Runtime Stream',
         1, 1, '', ?1, 0, 0, 'default', 'stream01', ?2, NULL)`,
    ).bind(userQuota, now),
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
       VALUES (43, 1, 'runtime-stream-upstream-secret', 1, 'runtime stream upstream',
         1000, ?1, 'https://realtime-provider.invalid', '', 0, ?2, 'default',
         0, NULL, '', 1000, 0, '{}', '{}', '')`,
    ).bind(now, model),
    env.DB.prepare(
      `INSERT INTO abilities
        (group_name, model, channel_id, enabled, priority, weight)
       VALUES ('default', ?1, 43, 1, 1000, 1000)`,
    ).bind(model),
    env.DB.prepare(
      `INSERT INTO options ("key", value)
       VALUES ('billing_setting.billing_mode', ?1)`,
    ).bind(JSON.stringify({ [model]: "tiered_expr" })),
    env.DB.prepare(
      `INSERT INTO options ("key", value)
       VALUES ('billing_setting.billing_expr', ?1)`,
    ).bind(JSON.stringify({ [model]: billingExpression })),
  ]);
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
                pre_consumed_quota, lease_expires_at, request_accounted,
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
         FROM logs WHERE other LIKE ?1 ORDER BY id DESC LIMIT 1`,
      )
        .bind(`%${reservationKey}%`)
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
      "SELECT status, bridge_segment, refunded_at, recovery_attempt_count, recovery_next_attempt_at FROM realtime_billing_reservations WHERE reservation_key = ?1",
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
