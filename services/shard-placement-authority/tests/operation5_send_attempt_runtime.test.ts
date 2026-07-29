import {
  applyD1Migrations,
  env,
  reset,
} from "cloudflare:test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  executionRepositorySqlForTest,
  type OperationFiveSendAttempt,
  type OperationFiveSendStartedEvent,
} from "../src/execution_repository";

const digest = (value: string): string => value.repeat(64);
const now = (): number => Math.floor(Date.now() / 1_000);

function attempt(): OperationFiveSendAttempt {
  return {
    authorizationIdSha256: digest("1"),
    attemptContract:
      "cinatoken-shard-placement-authority-operation-five-send-attempt-v1",
    attemptGeneration: 1,
    retryCount: 0,
    retryLimit: 0,
    sendAttemptLimit: 1,
    sendAuthorityState: "granted",
    claimDigestSha256: digest("2"),
    authorityDispatchClaimDigestSha256: digest("3"),
    dispatchConsumptionReceiptDigestSha256: digest("4"),
    applicationDispatchConsumptionDigestSha256: digest("5"),
    applicationTicketIdSha256: digest("6"),
    campaignId: digest("7"),
    applicationDatabaseIdentitySha256: digest("8"),
    applicationVersionId: "application-version-1",
    authorityDatabaseIdentitySha256: digest("9"),
    authorityLedgerIdentitySha256: digest("a"),
    authorityLedgerHeadSha256: digest("b"),
    authorityVersionId: "authority-version-1",
    dispatchOwnerSha256: digest("c"),
    leaseTokenSha256: digest("d"),
    leaseGeneration: 1,
    controllerServiceName: "container-controller-staging",
    controllerEnableOperationIdSha256: digest("e"),
    controllerBaselineVersionId: "controller-baseline-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    controllerCommandContract:
      "cinatoken-controller-deployment-gateway-enable-command-v1",
    controllerCommandDigestSha256: digest("f"),
    gatewayIdempotencyContract:
      "cinatoken-controller-deployment-gateway-idempotency-v1",
    gatewayIdempotencyKeySha256: digest("0"),
    sendCredentialIdSha256: digest("1"),
    sendRequestIdSha256: digest("2"),
    commandSendAttemptRequestIdSha256: digest("3"),
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
    attemptDigestSha256: digest("4"),
  };
}

function event(
  source: OperationFiveSendAttempt,
): OperationFiveSendStartedEvent {
  return {
    authorizationIdSha256: source.authorizationIdSha256,
    attemptDigestSha256: source.attemptDigestSha256,
    eventSequence: 1,
    eventContract:
      "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1",
    eventKind: "send_started",
    fromState: "consumption_receipted",
    toState: "send_started",
    eventSemantics:
      "unique_send_authority_persisted_network_may_not_have_occurred",
    predecessorEventDigestSha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    dispatchConsumptionReceiptDigestSha256:
      source.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256:
      source.controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      source.gatewayIdempotencyKeySha256,
    controllerRequestSent: 0,
    gatewayRequestSent: 0,
    eventDigestSha256: digest("5"),
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
  await seedLiveConsumption();
});

afterEach(async () => {
  await reset();
});

describe("operation-5 send attempt Workerd runtime", () => {
  it("commits send authority and Gateway dispatch evidence atomically", async () => {
    const source = attempt();
    const started = event(source);
    const session = env.DB.withSession("first-primary");
    const results = await session.batch([
      attemptStatement(session, source),
      eventStatement(session, started),
      gatewayDispatchedStatement(session, source, started),
    ]);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.success)).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT event_sequence, event_kind, gateway_request_sent
         FROM shard_placement_authority_operation_five_send_attempt_events
         ORDER BY event_sequence`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          event_sequence: 1,
          event_kind: "send_started",
          gateway_request_sent: 0,
        },
        {
          event_sequence: 2,
          event_kind: "gateway_create_dispatched",
          gateway_request_sent: 0,
        },
      ],
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM shard_placement_authority_operation_five_gateway_events`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("applies 0005 and preserves both ledgers as immutable", async () => {
    const source = attempt();
    const started = event(source);
    const session = env.DB.withSession("first-primary");
    const results = await session.batch([
      attemptStatement(session, source),
      eventStatement(session, started),
    ]);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.meta.changes)).toEqual([1, 1]);
    expect(await counts()).toEqual({ attempts: 1, events: 1 });
    const persisted = await env.DB.prepare(
      `SELECT event_sequence, event_kind, event_semantics,
              predecessor_event_digest_sha256,
              controller_request_sent, gateway_request_sent
       FROM shard_placement_authority_operation_five_send_attempt_events`,
    ).first();
    expect(persisted).toEqual({
      event_sequence: 1,
      event_kind: "send_started",
      event_semantics:
        "unique_send_authority_persisted_network_may_not_have_occurred",
      predecessor_event_digest_sha256: digest("0"),
      controller_request_sent: 0,
      gateway_request_sent: 0,
    });
    await expect(
      env.DB.prepare(
        `UPDATE shard_placement_authority_operation_five_send_attempts
         SET retry_count = 0`,
      ).run(),
    ).rejects.toThrow("immutable_operation_five_send_attempt");
    await expect(
      env.DB.prepare(
        `DELETE FROM
           shard_placement_authority_operation_five_send_attempt_events`,
      ).run(),
    ).rejects.toThrow(
      "immutable_operation_five_send_attempt_event",
    );
  });

  it("rolls back the attempt when the event insert fails", async () => {
    const source = attempt();
    const started = {
      ...event(source),
      eventDigestSha256: "not-a-sha256",
    };
    const session = env.DB.withSession("first-primary");
    await expect(
      session.batch([
        attemptStatement(session, source),
        eventStatement(session, started),
      ]),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ attempts: 0, events: 0 });
  });

  it("rejects caller-specified D1 clock drift for either row", async () => {
    const source = attempt();
    const started = event(source);
    const attemptClockSession =
      env.DB.withSession("first-primary");
    await expect(
      attemptClockSession.batch([
        attemptStatementAt(
          attemptClockSession,
          source,
          now() - 300,
        ),
        eventStatement(attemptClockSession, started),
      ]),
    ).rejects.toThrow("operation_five_send_attempt_clock_mismatch");
    expect(await counts()).toEqual({ attempts: 0, events: 0 });

    const eventClockSession = env.DB.withSession("first-primary");
    await expect(
      eventClockSession.batch([
        attemptStatement(eventClockSession, source),
        eventStatementAt(eventClockSession, started, now() - 300),
      ]),
    ).rejects.toThrow(
      "operation_five_send_attempt_event_clock_mismatch",
    );
    expect(await counts()).toEqual({ attempts: 0, events: 0 });
  });

  it("allows only one immutable pair under concurrent and repeat writes", async () => {
    const source = attempt();
    const started = event(source);
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, () => {
        const session = env.DB.withSession("first-primary");
        return session.batch([
          attemptStatement(session, source),
          eventStatement(session, started),
        ]);
      }),
    );
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      writes.filter((result) => result.status === "rejected"),
    ).toHaveLength(7);
    expect(await counts()).toEqual({ attempts: 1, events: 1 });

    const replay = env.DB.withSession("first-primary");
    await expect(
      replay.batch([
        attemptStatement(replay, source),
        eventStatement(replay, started),
      ]),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ attempts: 1, events: 1 });
  });

  it("rejects a recovered consumption before granting send authority", async () => {
    await env.DB.prepare(
      `INSERT INTO
         shard_placement_authority_operation_five_dispatch_consumption_recoveries
         (authorization_id_sha256)
       VALUES (?1)`,
    ).bind(attempt().authorizationIdSha256).run();
    const source = attempt();
    const started = event(source);
    const session = env.DB.withSession("first-primary");
    await expect(
      session.batch([
        attemptStatement(session, source),
        eventStatement(session, started),
      ]),
    ).rejects.toThrow(
      "operation_five_send_attempt_recovered_consumption_forbidden",
    );
    expect(await counts()).toEqual({ attempts: 0, events: 0 });
  });

  it("keeps the event table future-safe behind a replaceable insert guard", async () => {
    const source = attempt();
    const started = event(source);
    const session = env.DB.withSession("first-primary");
    await session.batch([
      attemptStatement(session, source),
      eventStatement(session, started),
    ]);
    await env.DB.prepare(
      `DROP TRIGGER
         shard_placement_authority_operation_five_send_attempt_event_insert_guard`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO
         shard_placement_authority_operation_five_send_attempt_events (
           authorization_id_sha256, attempt_digest_sha256,
           event_sequence, contract_version, event_contract, event_kind,
           from_state, to_state, event_semantics,
           predecessor_event_digest_sha256,
           dispatch_consumption_receipt_digest_sha256,
           controller_command_digest_sha256,
           gateway_idempotency_key_sha256,
           controller_request_sent, gateway_request_sent,
           event_digest_sha256
         ) VALUES (
           ?1, ?2, 2, 1, ?3, 'gateway_accepted', 'send_started',
           'gateway_accepted', 'gateway_status_exact', ?4, ?5, ?6, ?7,
           0, 1, ?8
         )`,
    ).bind(
      source.authorizationIdSha256,
      source.attemptDigestSha256,
      started.eventContract,
      started.eventDigestSha256,
      source.dispatchConsumptionReceiptDigestSha256,
      source.controllerCommandDigestSha256,
      source.gatewayIdempotencyKeySha256,
      digest("6"),
    ).run();
    expect(await counts()).toEqual({ attempts: 1, events: 2 });
  });
});

function attemptStatement(
  session: D1DatabaseSession,
  value: OperationFiveSendAttempt,
): D1PreparedStatement {
  return session
    .prepare(executionRepositorySqlForTest.insertOperationFiveSendAttempt)
    .bind(
      value.authorizationIdSha256,
      value.attemptContract,
      value.claimDigestSha256,
      value.authorityDispatchClaimDigestSha256,
      value.dispatchConsumptionReceiptDigestSha256,
      value.applicationDispatchConsumptionDigestSha256,
      value.applicationTicketIdSha256,
      value.campaignId,
      value.applicationDatabaseIdentitySha256,
      value.applicationVersionId,
      value.authorityDatabaseIdentitySha256,
      value.authorityLedgerIdentitySha256,
      value.authorityLedgerHeadSha256,
      value.authorityVersionId,
      value.dispatchOwnerSha256,
      value.leaseTokenSha256,
      value.controllerServiceName,
      value.controllerEnableOperationIdSha256,
      value.controllerBaselineVersionId,
      value.controllerEnabledVersionId,
      value.controllerCommandContract,
      value.controllerCommandDigestSha256,
      value.gatewayIdempotencyContract,
      value.gatewayIdempotencyKeySha256,
      value.sendCredentialIdSha256,
      value.sendRequestIdSha256,
      value.commandSendAttemptRequestIdSha256,
      value.attemptDigestSha256,
    );
}

function eventStatement(
  session: D1DatabaseSession,
  value: OperationFiveSendStartedEvent,
): D1PreparedStatement {
  return session
    .prepare(
      executionRepositorySqlForTest.insertOperationFiveSendAttemptEvent,
    )
    .bind(
      value.authorizationIdSha256,
      value.attemptDigestSha256,
      value.eventContract,
      value.predecessorEventDigestSha256,
      value.dispatchConsumptionReceiptDigestSha256,
      value.controllerCommandDigestSha256,
      value.gatewayIdempotencyKeySha256,
      value.eventDigestSha256,
    );
}

function gatewayDispatchedStatement(
  session: D1DatabaseSession,
  source: OperationFiveSendAttempt,
  started: OperationFiveSendStartedEvent,
): D1PreparedStatement {
  return session
    .prepare(executionRepositorySqlForTest.insertOperationFiveGatewayEvent)
    .bind(
      source.authorizationIdSha256,
      source.attemptDigestSha256,
      started.eventDigestSha256,
      2,
      "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
      "gateway_create_dispatched",
      started.eventDigestSha256,
      source.gatewayIdempotencyKeySha256,
      source.controllerCommandDigestSha256,
      "create",
      digest("6"),
      digest("7"),
      null,
      null,
      null,
      digest("8"),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      digest("9"),
    );
}

function attemptStatementAt(
  session: D1DatabaseSession,
  value: OperationFiveSendAttempt,
  createdAt: number,
): D1PreparedStatement {
  const sql = executionRepositorySqlForTest.insertOperationFiveSendAttempt
    .replace(
      "controller_request_sent, gateway_request_sent, attempt_digest_sha256\n)",
      "controller_request_sent, gateway_request_sent, attempt_digest_sha256,\n  created_at\n)",
    )
    .replace(
      "?26, ?27, 0, 0, ?28\n)",
      "?26, ?27, 0, 0, ?28, ?29\n)",
    );
  return session.prepare(sql).bind(
    value.authorizationIdSha256,
    value.attemptContract,
    value.claimDigestSha256,
    value.authorityDispatchClaimDigestSha256,
    value.dispatchConsumptionReceiptDigestSha256,
    value.applicationDispatchConsumptionDigestSha256,
    value.applicationTicketIdSha256,
    value.campaignId,
    value.applicationDatabaseIdentitySha256,
    value.applicationVersionId,
    value.authorityDatabaseIdentitySha256,
    value.authorityLedgerIdentitySha256,
    value.authorityLedgerHeadSha256,
    value.authorityVersionId,
    value.dispatchOwnerSha256,
    value.leaseTokenSha256,
    value.controllerServiceName,
    value.controllerEnableOperationIdSha256,
    value.controllerBaselineVersionId,
    value.controllerEnabledVersionId,
    value.controllerCommandContract,
    value.controllerCommandDigestSha256,
    value.gatewayIdempotencyContract,
    value.gatewayIdempotencyKeySha256,
    value.sendCredentialIdSha256,
    value.sendRequestIdSha256,
    value.commandSendAttemptRequestIdSha256,
    value.attemptDigestSha256,
    createdAt,
  );
}

function eventStatementAt(
  session: D1DatabaseSession,
  value: OperationFiveSendStartedEvent,
  recordedAt: number,
): D1PreparedStatement {
  const sql =
    executionRepositorySqlForTest.insertOperationFiveSendAttemptEvent
      .replace(
        "controller_request_sent, gateway_request_sent, event_digest_sha256\n)",
        "controller_request_sent, gateway_request_sent, event_digest_sha256,\n  recorded_at\n)",
      )
      .replace(
        "?5, ?6, ?7, 0, 0, ?8\n)",
        "?5, ?6, ?7, 0, 0, ?8, ?9\n)",
      );
  return session.prepare(sql).bind(
    value.authorizationIdSha256,
    value.attemptDigestSha256,
    value.eventContract,
    value.predecessorEventDigestSha256,
    value.dispatchConsumptionReceiptDigestSha256,
    value.controllerCommandDigestSha256,
    value.gatewayIdempotencyKeySha256,
    value.eventDigestSha256,
    recordedAt,
  );
}

async function seedLiveConsumption(): Promise<void> {
  const source = attempt();
  const expires = now() + 600;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shard_placement_authority_execution_claims (
         authorization_id_sha256, claim_digest_sha256, status,
         ledger_version, ledger_head_sha256, last_completed_ordinal,
         inflight_operation_ordinal, inflight_operation_id_sha256,
         inflight_readback_only, enable_intent_seen, disable_confirmed,
         application_ticket_id_sha256,
         application_database_identity_sha256,
         authority_database_identity_sha256, ledger_identity_sha256,
         claim_owner_sha256, lease_owner_sha256, lease_token_sha256,
         lease_generation, lease_expires_at, normal_deadline_at,
         permit_expires_at, renewal_count, takeover_count
       ) VALUES (
         ?1, ?2, 'running', 4, ?3, 4, 5, ?4, 0, 1, 0, ?5, ?6,
         ?7, ?8, ?9, ?9, ?10, 1, ?11, ?11, ?11, 0, 0
       )`,
    ).bind(
      source.authorizationIdSha256,
      source.claimDigestSha256,
      source.authorityLedgerHeadSha256,
      source.controllerEnableOperationIdSha256,
      source.applicationTicketIdSha256,
      source.applicationDatabaseIdentitySha256,
      source.authorityDatabaseIdentitySha256,
      source.authorityLedgerIdentitySha256,
      source.dispatchOwnerSha256,
      source.leaseTokenSha256,
      expires,
    ),
    env.DB.prepare(
      `INSERT INTO
         shard_placement_authority_operation_five_dispatch_claims (
           authorization_id_sha256, dispatch_claim_digest_sha256,
           claim_digest_sha256, application_ticket_id_sha256
         ) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(
      source.authorizationIdSha256,
      source.authorityDispatchClaimDigestSha256,
      source.claimDigestSha256,
      source.applicationTicketIdSha256,
    ),
    env.DB.prepare(
      `INSERT INTO
         shard_placement_authority_operation_five_dispatch_consumptions (
           authorization_id_sha256, claim_digest_sha256,
           authority_dispatch_claim_digest_sha256,
           receipt_digest_sha256,
           application_dispatch_consumption_digest_sha256,
           application_ticket_id_sha256, campaign_id,
           application_database_identity_sha256, application_version_id,
           authority_database_identity_sha256,
           authority_ledger_identity_sha256,
           authority_ledger_head_sha256, authority_version_id,
           dispatch_owner_sha256, lease_token_sha256, lease_generation,
           lease_expires_at, normal_deadline_at, permit_expires_at,
           controller_service_name,
           controller_enable_operation_id_sha256,
           controller_baseline_version_id,
           controller_enabled_version_id, send_attempt_limit, retry_limit
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, 1, ?16, ?16, ?16, ?17, ?18, ?19, ?20, 1, 0
         )`,
    ).bind(
      source.authorizationIdSha256,
      source.claimDigestSha256,
      source.authorityDispatchClaimDigestSha256,
      source.dispatchConsumptionReceiptDigestSha256,
      source.applicationDispatchConsumptionDigestSha256,
      source.applicationTicketIdSha256,
      source.campaignId,
      source.applicationDatabaseIdentitySha256,
      source.applicationVersionId,
      source.authorityDatabaseIdentitySha256,
      source.authorityLedgerIdentitySha256,
      source.authorityLedgerHeadSha256,
      source.authorityVersionId,
      source.dispatchOwnerSha256,
      source.leaseTokenSha256,
      expires,
      source.controllerServiceName,
      source.controllerEnableOperationIdSha256,
      source.controllerBaselineVersionId,
      source.controllerEnabledVersionId,
    ),
  ]);
}

async function counts(): Promise<{
  attempts: number;
  events: number;
}> {
  const attempts = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM shard_placement_authority_operation_five_send_attempts`,
  ).first<{ count: number }>();
  const events = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM shard_placement_authority_operation_five_send_attempt_events`,
  ).first<{ count: number }>();
  return {
    attempts: attempts?.count ?? -1,
    events: events?.count ?? -1,
  };
}
