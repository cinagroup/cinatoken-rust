import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const userId = 501;
const tokenId = 502;
const channelId = 503;
const initialUserQuota = 1_000;
const initialTokenQuota = 500;
const reservedQuota = 125;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

describe("migration 0050 atomic relay Container admission", () => {
  it("pins the cross-runtime idempotency alias-set digest", async () => {
    await expect(idempotencyAliasesSha256([hex("a"), hex("b")])).resolves.toBe(
      "2abe3436ba079ee481e8992885fa43931306e177fce6ce8eefd51a3f360c6393",
    );
    await expect(idempotencyAliasesSha256([hex("b"), hex("a")])).resolves.toBe(
      "2abe3436ba079ee481e8992885fa43931306e177fce6ce8eefd51a3f360c6393",
    );
  });

  it("commits the selected reservation, both debits, operation, and receipt once", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("success");

    const results = await runAtomicAdmissionBatch(intent);

    expect(results).toHaveLength(15);
    expect(results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);
    expect(await atomicAdmissionState(intent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: intent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: { reservations: 1, operations: 1, admissions: 1, aliases: 1 },
    });
    expect(await classifyAtomicAdmission(intent)).toBe("matching_resumable");
  });

  it("classifies concurrent equivalents and exact replay through either alias without another debit", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("concurrent", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });

    const concurrent = await Promise.all([
      admitOrClassifyExactReplay(intent),
      admitOrClassifyExactReplay(intent),
    ]);
    expect(
      concurrent.map(({ classification }) => classification).sort(),
    ).toEqual(["matching_resumable", "newly_applied"]);
    const applied = concurrent.find(
      ({ classification }) => classification === "newly_applied",
    );
    expect(applied.results).toHaveLength(17);
    expect(applied.results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);

    const replay = {
      ...intent,
      clientIdempotencyHmacAliases: [
        ...intent.clientIdempotencyHmacAliases,
      ].reverse(),
    };
    await expect(admitOrClassifyExactReplay(replay)).resolves.toMatchObject({
      classification: "matching_resumable",
      winner: {
        reservationKey: intent.reservationKey,
        operationId: intent.operationId,
      },
    });
    expect(await atomicAdmissionState(intent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: intent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: { reservations: 1, operations: 1, admissions: 1, aliases: 2 },
    });
  });

  it("serializes reversed current-key versions onto one persisted winner", async () => {
    await seedAuthorityState();
    const oldAlias = hex("1");
    const newAlias = hex("2");
    const requestSha256 = hex("d");
    const versionA = await atomicAdmissionIntent("reversed-old", {
      atomicAdmissionSha256: hex("4"),
      operationAdmissionSha256: hex("6"),
      clientIdempotencyHmacSha256: oldAlias,
      clientIdempotencyHmacAliases: [oldAlias, newAlias],
      clientRequestSha256: requestSha256,
      reconciliationId: hex("8"),
    });
    const versionB = await atomicAdmissionIntent("reversed-new", {
      atomicAdmissionSha256: hex("5"),
      operationAdmissionSha256: hex("7"),
      clientIdempotencyHmacSha256: newAlias,
      clientIdempotencyHmacAliases: [newAlias, oldAlias],
      clientRequestSha256: requestSha256,
      reconciliationId: hex("9"),
    });

    const outcomes = await Promise.all([
      admitOrClassifyExactReplay(versionA),
      admitOrClassifyExactReplay(versionB),
    ]);
    expect(outcomes.map(({ classification }) => classification).sort()).toEqual([
      "matching_resumable",
      "newly_applied",
    ]);
    const applied = outcomes.find(
      ({ classification }) => classification === "newly_applied",
    );
    const loser = outcomes.find(
      ({ classification }) => classification === "matching_resumable",
    );
    expect(applied.results).toHaveLength(17);
    expect(applied.results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);
    expect(loser.winner).toEqual(applied.winner);

    const persistedIntent =
      applied.winner.reservationKey === versionA.reservationKey
        ? versionA
        : versionB;
    expect(await atomicAdmissionState(persistedIntent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: persistedIntent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: { reservations: 1, operations: 1, admissions: 1, aliases: 2 },
    });
    const aliases = await env.DB.prepare(
      `SELECT client_idempotency_hmac_sha256,
              reservation_key, operation_id,
              canonical_client_idempotency_hmac_sha256,
              client_request_sha256
       FROM relay_container_idempotency_aliases
       ORDER BY client_idempotency_hmac_sha256`,
    ).all();
    expect(aliases.results).toEqual(
      [oldAlias, newAlias].sort().map((alias) => ({
        client_idempotency_hmac_sha256: alias,
        reservation_key: applied.winner.reservationKey,
        operation_id: applied.winner.operationId,
        canonical_client_idempotency_hmac_sha256:
          applied.winner.canonicalClientIdempotencyHmacSha256,
        client_request_sha256: requestSha256,
      })),
    );
  });

  it("fails closed on an alias reused for a different request or conflicting reservation identity", async () => {
    await seedAuthorityState();
    const winner = await atomicAdmissionIntent("conflict-winner", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });
    await expect(admitOrClassifyExactReplay(winner)).resolves.toMatchObject({
      classification: "newly_applied",
    });
    const before = await atomicAdmissionState(winner);

    const differentRequest = await atomicAdmissionIntent("conflict-request", {
      atomicAdmissionSha256: hex("4"),
      clientIdempotencyHmacSha256: hex("1"),
      clientIdempotencyHmacAliases: [hex("1"), hex("c")],
      clientRequestSha256: hex("3"),
    });
    await expect(
      admitOrClassifyExactReplay(differentRequest),
    ).resolves.toMatchObject({ classification: "request_conflict" });

    const conflictingIdentity = await atomicAdmissionIntent(
      "conflict-identity",
      {
        reservationKey: winner.reservationKey,
        operationId: winner.operationId,
        atomicAdmissionSha256: hex("5"),
        clientIdempotencyHmacSha256: hex("2"),
        clientIdempotencyHmacAliases: [hex("2")],
        clientRequestSha256: winner.clientRequestSha256,
      },
    );
    await expect(
      admitOrClassifyExactReplay(conflictingIdentity),
    ).resolves.toMatchObject({ classification: "immutable_conflict" });
    expect(await atomicAdmissionState(winner)).toEqual(before);
  });

  it("rejects every update and delete of a persisted idempotency alias", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("immutable-alias", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });
    await runAtomicAdmissionBatch(intent);
    const alias = intent.clientIdempotencyHmacAliases[1];

    await expect(
      env.DB.prepare(
        `UPDATE relay_container_idempotency_aliases
         SET created_at = created_at
         WHERE client_idempotency_hmac_sha256 = ?1`,
      )
        .bind(alias)
        .run(),
    ).rejects.toThrow(/relay container idempotency alias is immutable/);
    await expect(
      env.DB.prepare(
        `DELETE FROM relay_container_idempotency_aliases
         WHERE client_idempotency_hmac_sha256 = ?1`,
      )
        .bind(alias)
        .run(),
    ).rejects.toThrow(/relay container idempotency alias cannot be deleted/);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_idempotency_aliases
         WHERE reservation_key = ?1`,
      )
        .bind(intent.reservationKey)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("resumes the persisted winner when loser-only time and R2 metadata differ", async () => {
    await seedAuthorityState();
    const winner = await atomicAdmissionIntent("ephemeral-winner");
    await expect(admitOrClassifyExactReplay(winner)).resolves.toMatchObject({
      classification: "newly_applied",
    });
    const loser = {
      ...winner,
      operationAdmissionSha256: hex("6"),
      ownerLeaseExpiresAt: winner.ownerLeaseExpiresAt + 30,
      selectedAt: winner.selectedAt + 5,
      createdAt: winner.createdAt + 5,
      executionDeadlineAt: winner.executionDeadlineAt + 5,
      inputObjectVersion: "atomic-runtime-input-loser",
      traceId: "trace-ephemeral-loser",
    };

    await expect(admitOrClassifyExactReplay(loser)).resolves.toMatchObject({
      classification: "matching_resumable",
    });
    expect(await atomicAdmissionState(winner)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: winner.createdAt,
      },
      channel: { used_quota: 0 },
      counts: { reservations: 1, operations: 1, admissions: 1, aliases: 1 },
    });
  });

  it("allows a marked winner to enter the existing dispatched lifecycle", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("dispatch-compatible");
    await runAtomicAdmissionBatch(intent);

    const result = await env.DB.prepare(
      `UPDATE relay_container_operations
       SET status = 'dispatched', updated_at = ?2
       WHERE operation_id = ?1 AND status = 'prepared'`,
    )
      .bind(intent.operationId, intent.createdAt + 1)
      .run();

    expect(result.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT status FROM relay_container_operations WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
    ).resolves.toEqual({ status: "dispatched" });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM relay_container_atomic_admissions
         WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it.each([
    { aliasCount: 1, aliases: [hex("c")] },
    { aliasCount: 2, aliases: [hex("c"), hex("1")] },
  ])(
    "rolls back the receipt, $aliasCount alias row(s), reservation, operation, and both debits on final mismatch",
    async ({ aliasCount, aliases }) => {
      await seedAuthorityState();
      const intent = await atomicAdmissionIntent(`marker-mismatch-${aliasCount}`, {
        clientIdempotencyHmacAliases: aliases,
      });
      const before = await atomicAdmissionState(intent);

      await expect(
        runAtomicAdmissionBatch(intent, {
          markerOperationAdmissionSha256: hex("0"),
        }),
      ).rejects.toThrow(/relay container atomic admission authority mismatch/);

      expect(await atomicAdmissionState(intent)).toEqual(before);
      expect(before.counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
      });
    },
  );

  it.each([
    {
      failure: "user quota",
      userQuota: reservedQuota - 1,
      tokenQuota: initialTokenQuota,
    },
    {
      failure: "token quota",
      userQuota: initialUserQuota,
      tokenQuota: reservedQuota - 1,
    },
  ])(
    "rolls back every financial and admission write on $failure failure",
    async ({ failure: _failure, userQuota, tokenQuota }) => {
      await seedAuthorityState({ userQuota, tokenQuota });
      const intent = await atomicAdmissionIntent("quota-failure");
      const before = await atomicAdmissionState(intent);

      await expect(runAtomicAdmissionBatch(intent)).rejects.toThrow();

      expect(await atomicAdmissionState(intent)).toEqual(before);
      expect(before.counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
      });
    },
  );

  it("rejects an old writer before it can create an unmarked canary operation", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("old-writer");
    await expect(
      env.DB.batch([
        selectedReservationStatement(intent),
        preparedOperationStatement(intent),
      ]),
    ).rejects.toThrow(/relay container atomic admission authority mismatch/);

    expect(await atomicAdmissionState(intent)).toMatchObject({
      counts: { reservations: 0, operations: 0, admissions: 0, aliases: 0 },
      user: { quota: initialUserQuota },
      token: { remain_quota: initialTokenQuota, used_quota: 0 },
    });
  });

  it("rechecks user, token, and channel authority inside the atomic batch", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("authority-change");

    for (const mutation of [
      "UPDATE users SET status = 2 WHERE id = 501",
      "UPDATE tokens SET status = 2 WHERE id = 502",
      "UPDATE channels SET status = 2 WHERE id = 503",
    ]) {
      await env.DB.prepare(mutation).run();
      await expect(runAtomicAdmissionBatch(intent)).rejects.toThrow();
      expect((await atomicAdmissionState(intent)).counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
      });
      await env.DB.prepare("UPDATE users SET status = 1 WHERE id = 501").run();
      await env.DB.prepare("UPDATE tokens SET status = 1 WHERE id = 502").run();
      await env.DB.prepare(
        "UPDATE channels SET status = 1 WHERE id = 503",
      ).run();
    }
  });
});

describe("migration 0051 scheduled relay Container terminalization", () => {
  it("rolls back the full financial terminal batch on a stale observer and commits once with the active lease", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("scheduled-terminalization");
    await runAtomicAdmissionBatch(intent);
    const terminal = await prepareScheduledTerminalization(intent);

    await expect(
      runScheduledTerminalizationBatch(intent, terminal, {
        claimOwner: "b".repeat(32),
      }),
    ).rejects.toThrow(
      /relay container scheduled terminalization fence is invalid/,
    );
    await expect(
      runScheduledTerminalizationBatch(intent, terminal, {
        claimLeaseExpiresAt: terminal.claimLeaseExpiresAt + 1,
      }),
    ).rejects.toThrow(
      /relay container scheduled terminalization fence is invalid/,
    );
    await expect(scheduledTerminalizationState(intent, terminal)).resolves.toEqual({
      operation: { status: "dispatched", response_status: null },
      reservation: {
        status: "reserved",
        owner_generation: 2,
        final_quota: 0,
        request_accounted: 0,
      },
      user: { quota: 875, used_quota: 0, request_count: 0 },
      token: { remain_quota: 375, used_quota: 125 },
      channel: { used_quota: 0 },
      counts: { events: 0, outbox: 0, terminalizations: 0 },
    });

    const results = await runScheduledTerminalizationBatch(intent, terminal);
    expect(results).toHaveLength(9);
    expect(results.map((result) => result.meta.changes)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    await expect(scheduledTerminalizationState(intent, terminal)).resolves.toEqual({
      operation: { status: "completed", response_status: 200 },
      reservation: {
        status: "settled",
        owner_generation: 3,
        final_quota: 80,
        request_accounted: 1,
      },
      user: { quota: 920, used_quota: 80, request_count: 1 },
      token: { remain_quota: 420, used_quota: 80 },
      channel: { used_quota: 80 },
      counts: { events: 1, outbox: 1, terminalizations: 1 },
    });

    await expect(
      runScheduledTerminalizationBatch(intent, terminal),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE relay_container_scheduled_terminalizations
         SET committed_at = committed_at + 1
         WHERE billing_event_id = ?1`,
      )
        .bind(terminal.billingEventId)
        .run(),
    ).rejects.toThrow(/scheduled terminalization is immutable/);
    await expect(
      env.DB.prepare(
        `DELETE FROM relay_container_scheduled_terminalizations
         WHERE billing_event_id = ?1`,
      )
        .bind(terminal.billingEventId)
        .run(),
    ).rejects.toThrow(/scheduled terminalization cannot be deleted/);
  });
});

async function prepareScheduledTerminalization(intent) {
  const observationCreatedAt = intent.createdAt + 301;
  const claimAt = observationCreatedAt + 1;
  const terminalAt = claimAt + 1;
  const claimLeaseExpiresAt = claimAt + 60;
  const claimOwner = "a".repeat(32);
  const resultSha256 = hex("7");
  const usageReceiptSha256 = hex("8");
  const clientResponseSha256 = hex("9");
  const headersJson = '{"content-type":"application/json"}';
  const outboxPayloadJson = "{}";

  await env.DB.prepare(
    `UPDATE relay_container_operations
     SET status = 'dispatched', updated_at = ?2
     WHERE operation_id = ?1 AND status = 'prepared'`,
  )
    .bind(intent.operationId, intent.createdAt + 1)
    .run();
  await env.DB.prepare(
    `INSERT INTO relay_container_reconciliation_observations (
       operation_id, reservation_key, operation_created_at,
       owner_generation, reconciliation_id, status, available_at,
       recovery_deadline_at, created_at, updated_at
     ) VALUES (?1, ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?5, ?5)`,
  )
    .bind(
      intent.operationId,
      intent.createdAt,
      intent.ownerGeneration,
      intent.reconciliationId,
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
    .bind(intent.operationId, claimOwner, claimAt, claimLeaseExpiresAt)
    .run();

  // This suite exercises the 0051 financial batch fence. Provider receipt
  // authority has its own Workerd coverage and would require the full egress
  // grant/receipt fixture before the terminal event can be staged here.
  await env.DB.prepare(
    "DROP TRIGGER relay_container_terminal_event_provider_usage_guard",
  ).run();

  return {
    billingEventId: hex("5"),
    claimGeneration: 1,
    claimLeaseExpiresAt,
    claimOwner,
    clientResponseObjectKey:
      `container-client-responses/v1/${intent.operationId}/2/${clientResponseSha256}`,
    clientResponseSha256,
    clientResponseVersion: "scheduled-client-response-v1",
    finalQuota: 80,
    headersJson,
    headersSha256: await sha256Text(headersJson),
    outboxPayloadJson,
    outboxPayloadSha256: await sha256Text(outboxPayloadJson),
    resultObjectKey:
      `container-results/v1/${intent.operationId}/2/${resultSha256}`,
    resultObjectVersion: "scheduled-provider-result-v1",
    resultSha256,
    terminalAt,
    terminalContractSha256: hex("4"),
    usageReceiptSha256,
  };
}

async function runScheduledTerminalizationBatch(
  intent,
  terminal,
  {
    claimOwner = terminal.claimOwner,
    claimLeaseExpiresAt = terminal.claimLeaseExpiresAt,
  } = {},
) {
  const quotaCredit = intent.preConsumedQuota - terminal.finalQuota;
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO relay_container_terminal_events (
         billing_event_id, reservation_key, operation_id, owner_generation,
         operation_from_status, operation_status, terminal_contract_sha256,
         billing_action, billing_owner_generation, billing_from_status,
         billing_final_quota, billing_request_accounted, billing_reason,
         pre_consumed_quota, user_quota_delta, token_quota_delta,
         user_used_quota_delta, channel_used_quota_delta, request_count_delta,
         reconciliation_id, reconciliation_revision, client_response_status,
         client_response_headers_json, client_response_headers_sha256,
         client_response_object_key, client_response_object_version,
         client_response_sha256, client_response_size,
         client_response_content_type, outbox_schema_version,
         outbox_payload_json, outbox_payload_sha256, created_at,
         provider_usage_receipt_sha256, provider_result_sha256,
         provider_attempt_generation
       ) VALUES (
         ?1, ?2, ?2, ?3, 'dispatched', 'completed', ?4, 'settle', ?3,
         'reserved', ?5, 1, 'container_provider_usage_settlement', ?6,
         ?7, ?7, ?5, ?5, 1, ?8, 1, 200, ?9, ?10, ?11, ?12, ?13, 2,
         'application/json', 1, ?14, ?15, ?16, ?17, ?18, 1
       )`,
    ).bind(
      terminal.billingEventId,
      intent.operationId,
      intent.ownerGeneration,
      terminal.terminalContractSha256,
      terminal.finalQuota,
      intent.preConsumedQuota,
      quotaCredit,
      intent.reconciliationId,
      terminal.headersJson,
      terminal.headersSha256,
      terminal.clientResponseObjectKey,
      terminal.clientResponseVersion,
      terminal.clientResponseSha256,
      terminal.outboxPayloadJson,
      terminal.outboxPayloadSha256,
      terminal.terminalAt,
      terminal.usageReceiptSha256,
      terminal.resultSha256,
    ),
    env.DB.prepare(
      `INSERT INTO relay_container_terminal_outbox_state (
         billing_event_id, status, delivery_generation, delivery_attempt_count,
         lease_expires_at, available_at, delivered_at, last_error,
         created_at, updated_at
       ) VALUES (?1, 'pending', 0, 0, 0, ?2, 0, '', ?2, ?2)`,
    ).bind(terminal.billingEventId, terminal.terminalAt),
    env.DB.prepare(
      `UPDATE relay_container_operations
       SET status = 'completed', response_status = 200, response_code = NULL,
           result_object_key = ?2, result_object_version = ?3,
           result_sha256 = ?4, result_size = 2,
           result_content_type = 'application/json', updated_at = ?5
       WHERE operation_id = ?1 AND reservation_key = ?1
         AND owner_generation = ?6 AND status = 'dispatched'`,
    ).bind(
      intent.operationId,
      terminal.resultObjectKey,
      terminal.resultObjectVersion,
      terminal.resultSha256,
      terminal.terminalAt,
      intent.ownerGeneration,
    ),
    env.DB.prepare(
      `UPDATE relay_billing_reservations
       SET status = 'settled', owner_generation = owner_generation + 1,
           final_quota = ?2,
           finalization_reason = 'container_provider_usage_settlement',
           request_accounted = 1, settled_at = ?3, updated_at = ?3
       WHERE reservation_key = ?1 AND owner_generation = ?4
         AND status = 'reserved'`,
    ).bind(
      intent.reservationKey,
      terminal.finalQuota,
      terminal.terminalAt,
      intent.ownerGeneration,
    ),
    env.DB.prepare("UPDATE users SET quota = quota + ?1 WHERE id = ?2").bind(
      quotaCredit,
      userId,
    ),
    env.DB.prepare(
      `UPDATE tokens
       SET remain_quota = remain_quota + ?1,
           used_quota = MAX(used_quota - ?1, 0), accessed_time = ?2
       WHERE id = ?3`,
    ).bind(quotaCredit, terminal.terminalAt, tokenId),
    env.DB.prepare(
      `UPDATE users
       SET used_quota = used_quota + ?1, request_count = request_count + 1
       WHERE id = ?2`,
    ).bind(terminal.finalQuota, userId),
    env.DB.prepare(
      "UPDATE channels SET used_quota = used_quota + ?1 WHERE id = ?2",
    ).bind(terminal.finalQuota, channelId),
    env.DB.prepare(
      `INSERT INTO relay_container_scheduled_terminalizations (
         billing_event_id, reservation_key, operation_id, owner_generation,
         operation_from_status, billing_owner_generation, reconciliation_id,
         reconciliation_revision, observation_claim_generation,
         observation_claim_owner, observation_claim_lease_expires_at,
         decision, provider_usage_receipt_sha256, provider_result_sha256,
         terminal_contract_sha256, committed_at, created_at
       ) VALUES (
         ?1, ?2, ?2, ?3, 'dispatched', ?3, ?4, 1, ?5, ?6, ?7, 'settle',
         ?8, ?9, ?10, ?11, ?11
       )`,
    ).bind(
      terminal.billingEventId,
      intent.operationId,
      intent.ownerGeneration,
      intent.reconciliationId,
      terminal.claimGeneration,
      claimOwner,
      claimLeaseExpiresAt,
      terminal.usageReceiptSha256,
      terminal.resultSha256,
      terminal.terminalContractSha256,
      terminal.terminalAt,
    ),
  ]);
}

async function scheduledTerminalizationState(intent, terminal) {
  const [operation, reservation, user, token, channel, counts] =
    await Promise.all([
      env.DB.prepare(
        `SELECT status, response_status
         FROM relay_container_operations WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
      env.DB.prepare(
        `SELECT status, owner_generation, final_quota, request_accounted
         FROM relay_billing_reservations WHERE reservation_key = ?1`,
      )
        .bind(intent.reservationKey)
        .first(),
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = ?1",
      )
        .bind(userId)
        .first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = ?1",
      )
        .bind(tokenId)
        .first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = ?1")
        .bind(channelId)
        .first(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_terminal_events
            WHERE operation_id = ?1) AS events,
           (SELECT COUNT(*) FROM relay_container_terminal_outbox_state
            WHERE billing_event_id = ?2) AS outbox,
           (SELECT COUNT(*) FROM relay_container_scheduled_terminalizations
            WHERE billing_event_id = ?2) AS terminalizations`,
      )
        .bind(intent.operationId, terminal.billingEventId)
        .first(),
    ]);
  return { operation, reservation, user, token, channel, counts };
}

async function seedAuthorityState({
  userQuota = initialUserQuota,
  tokenQuota = initialTokenQuota,
} = {}) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
        (id, username, password, quota, used_quota, request_count)
       VALUES (?1, 'atomic-runtime-user', 'disabled', ?2, 0, 0)`,
    ).bind(userId, userQuota),
    env.DB.prepare(
      `INSERT INTO tokens
        (id, user_id, "key", status, name, created_time, accessed_time,
         expired_time, remain_quota, unlimited_quota, used_quota, "group")
       VALUES (?1, ?2, ?3, 1, 'atomic runtime token', 1, 0, -1, ?4, 0, 0,
         'default')`,
    ).bind(tokenId, userId, hex("8"), tokenQuota),
    env.DB.prepare(
      `INSERT INTO channels
        (id, type, "key", name, status, "group", models, used_quota)
       VALUES (?1, 1, ?2, 'atomic runtime channel', 1, 'default',
         'gpt-atomic-runtime', 0)`,
    ).bind(channelId, hex("9")),
    env.DB.prepare(
      `INSERT INTO abilities
        (id, group_name, model, channel_id, enabled, priority, weight)
       VALUES (504, 'default', 'gpt-atomic-runtime', ?1, 1, 0, 0)`,
    ).bind(channelId),
  ]);
}

async function atomicAdmissionIntent(suffix, overrides = {}) {
  const operationId =
    overrides.operationId ?? `relaycontainer-atomic-runtime-${suffix}`;
  const reservationKey = overrides.reservationKey ?? operationId;
  const createdAt = overrides.createdAt ?? 2_000_000_000;
  const ownerLeaseExpiresAt =
    overrides.ownerLeaseExpiresAt ?? createdAt + 600;
  const operationAdmissionSha256 =
    overrides.operationAdmissionSha256 ?? hex("a");
  const inputSha256 = overrides.inputSha256 ?? hex("f");
  const clientIdempotencyHmacSha256 =
    overrides.clientIdempotencyHmacSha256 ?? hex("c");
  const clientIdempotencyHmacAliases = [
    ...(overrides.clientIdempotencyHmacAliases ?? [
      clientIdempotencyHmacSha256,
    ]),
  ];
  const billingSnapshotJson =
    overrides.billingSnapshotJson ??
    JSON.stringify({
      billing_mode: "flat",
      model_name: "gpt-atomic-runtime",
      model_price: reservedQuota,
    });
  return {
    reservationKey,
    operationId,
    contractVersion: 1,
    atomicAdmissionSha256: hex("b"),
    operationAdmissionSha256,
    clientIdempotencyHmacSha256,
    clientIdempotencyHmacAliases,
    clientRequestSha256: hex("d"),
    idempotencyAliasCount: clientIdempotencyHmacAliases.length,
    idempotencyAliasesSha256: await idempotencyAliasesSha256(
      clientIdempotencyHmacAliases,
    ),
    billingSnapshotSha256: await sha256Text(billingSnapshotJson),
    reconciliationId: hex("e"),
    ownerGeneration: 2,
    ownerLeaseExpiresAt,
    channelId,
    selectedChannelType: 1,
    selectedGroup: "default",
    selectedSnapshotKey: "1",
    selectedAt: createdAt,
    createdAt,
    executionDeadlineAt: createdAt + 300,
    modelName: "gpt-atomic-runtime",
    preConsumedQuota: reservedQuota,
    billingSnapshotJson,
    providerOperationId: `provider-${operationId}`,
    inputSha256,
    inputObjectKey: `container-inputs/v1/${operationId}/2/${inputSha256}`,
    inputObjectVersion: "atomic-runtime-input-v1",
    traceId: `trace-${suffix}`,
    ...overrides,
    clientIdempotencyHmacAliases,
    idempotencyAliasCount: clientIdempotencyHmacAliases.length,
    idempotencyAliasesSha256: await idempotencyAliasesSha256(
      clientIdempotencyHmacAliases,
    ),
  };
}

async function runAtomicAdmissionBatch(
  intent,
  { markerOperationAdmissionSha256 = intent.operationAdmissionSha256 } = {},
) {
  return env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    atomicAdmissionStatement(intent, markerOperationAdmissionSha256),
    previousChangeAssertion(intent),
    ...intent.clientIdempotencyHmacAliases.flatMap((alias) => [
      idempotencyAliasStatement(intent, alias),
      previousChangeAssertion(intent),
    ]),
    selectedReservationStatement(intent),
    previousChangeAssertion(intent),
    userDebitStatement(intent),
    previousChangeAssertion(intent),
    tokenDebitStatement(intent),
    previousChangeAssertion(intent),
    channelAuthorityStatement(intent),
    previousChangeAssertion(intent),
    preparedOperationStatement(intent),
    previousChangeAssertion(intent),
  ]);
}

function idempotencyAliasStatement(intent, alias) {
  return env.DB.prepare(
    `INSERT INTO relay_container_idempotency_aliases (
       client_idempotency_hmac_sha256, reservation_key, operation_id,
       canonical_client_idempotency_hmac_sha256, client_request_sha256,
       created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT DO NOTHING`,
  ).bind(
    alias,
    intent.reservationKey,
    intent.operationId,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.createdAt,
  );
}

function selectedReservationStatement(intent) {
  return env.DB.prepare(
    `INSERT INTO relay_billing_reservations (
       reservation_key, user_id, token_id, model_name, endpoint_path,
       request_id_hash, expr_hash, billing_kind, billing_snapshot_json,
       candidate_group_count, reservation_strategy, pre_consumed_quota,
       status, channel_id, selected_group, selected_at, owner_generation,
       owner_deadline_at, created_at, updated_at, lease_expires_at
     ) VALUES (
       ?1, ?2, ?3, ?4, 'chat/completions', ?5, ?6, 'flat', ?7,
       1, 'selected_group', ?8, 'reserved', ?9, ?10, ?11, ?12,
       ?13, ?11, ?11, ?13
     )`,
  ).bind(
    intent.reservationKey,
    userId,
    tokenId,
    intent.modelName,
    intent.clientRequestSha256,
    `sha256:${intent.operationAdmissionSha256}`,
    intent.billingSnapshotJson,
    intent.preConsumedQuota,
    intent.channelId,
    intent.selectedGroup,
    intent.selectedAt,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
  );
}

function userDebitStatement(intent) {
  return env.DB.prepare(
    `UPDATE users
     SET quota = quota - ?1
     WHERE id = ?2
       AND status = 1
       AND deleted_at IS NULL
       AND quota >= ?1`,
  ).bind(intent.preConsumedQuota, userId);
}

function tokenDebitStatement(intent) {
  return env.DB.prepare(
    `UPDATE tokens
     SET remain_quota = remain_quota - ?1,
         used_quota = used_quota + ?1,
         accessed_time = ?2
     WHERE id = ?3
       AND user_id = ?4
       AND status = 1
       AND deleted_at IS NULL
       AND (expired_time = -1 OR expired_time >= ?2)
       AND (unlimited_quota != 0 OR remain_quota >= ?1)`,
  ).bind(intent.preConsumedQuota, intent.createdAt, tokenId, userId);
}

function channelAuthorityStatement(intent) {
  return env.DB.prepare(
    `UPDATE channels AS channel
     SET status = status
     WHERE id = ?1
       AND status = 1
       AND type = ?2
       AND instr(',' || replace(channel."group", ' ', '') || ',',
                 ',' || replace(?3, ' ', '') || ',') > 0
       AND EXISTS (
         SELECT 1 FROM abilities AS ability
         WHERE ability.channel_id = channel.id
           AND ability.group_name = ?3
           AND ability.model = ?4
           AND ability.enabled = 1
       )`,
  ).bind(
    intent.channelId,
    intent.selectedChannelType,
    intent.selectedGroup,
    intent.modelName,
  );
}

function previousChangeAssertion(intent) {
  return env.DB.prepare(
    `INSERT INTO relay_billing_reservations (
       reservation_key, user_id, model_name, pre_consumed_quota,
       lease_expires_at, created_at, updated_at
     )
     SELECT ?1, 0, '', 0, 0, 0, 0
     WHERE changes() != 1`,
  ).bind(intent.reservationKey);
}

function preparedOperationStatement(intent) {
  return env.DB.prepare(
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
       ?1, ?1, ?2, ?3, ?4, ?5, 'chat_completions_canary', ?6, ?7, 1,
       1, 1, 8, 3, 'cinatoken-relay-shard-v1-0003', ?8, 'r2', ?9,
       ?10, ?11, 0, 'application/json', ?12, ?13, ?14, ?15,
       'prepared', ?16, ?16
     )`,
  ).bind(
    intent.operationId,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
    intent.channelId,
    intent.selectedGroup,
    intent.providerOperationId,
    intent.operationAdmissionSha256,
    intent.executionDeadlineAt,
    intent.inputObjectKey,
    intent.inputObjectVersion,
    intent.inputSha256,
    intent.traceId,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.reconciliationId,
    intent.createdAt,
  );
}

function atomicAdmissionStatement(intent, markerOperationAdmissionSha256) {
  return env.DB.prepare(
    `INSERT INTO relay_container_atomic_admissions (
       reservation_key, operation_id, contract_version,
       atomic_admission_sha256, operation_admission_sha256,
       client_idempotency_hmac_sha256, client_request_sha256,
       idempotency_alias_count, idempotency_aliases_sha256,
       billing_snapshot_sha256, user_id, token_id, pre_consumed_quota,
       owner_generation, owner_lease_expires_at, channel_id,
       selected_channel_type, selected_group, selected_snapshot_key,
       owner_deadline_at, selected_at, created_at,
       attempt_count, provider_attempt_generation
     ) VALUES (
       ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 1, 1
     )`,
  ).bind(
    intent.reservationKey,
    intent.contractVersion,
    intent.atomicAdmissionSha256,
    markerOperationAdmissionSha256,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.idempotencyAliasCount,
    intent.idempotencyAliasesSha256,
    intent.billingSnapshotSha256,
    userId,
    tokenId,
    intent.preConsumedQuota,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
    intent.channelId,
    intent.selectedChannelType,
    intent.selectedGroup,
    intent.selectedSnapshotKey,
    intent.ownerLeaseExpiresAt,
    intent.selectedAt,
  );
}

async function admitOrClassifyExactReplay(intent) {
  const existing = await classifyAtomicAdmissionReadback(intent);
  if (existing.classification !== "no_state") {
    return existing;
  }

  try {
    const results = await runAtomicAdmissionBatch(intent);
    const persisted = await classifyAtomicAdmissionReadback(intent);
    if (persisted.classification !== "matching_resumable") {
      throw new Error(
        `atomic admission readback after commit was ${persisted.classification}`,
      );
    }
    return { ...persisted, classification: "newly_applied", results };
  } catch (error) {
    const persisted = await classifyAtomicAdmissionReadback(intent);
    if (persisted.classification === "no_state") {
      throw error;
    }
    return { ...persisted, error };
  }
}

async function classifyAtomicAdmission(intent) {
  return (await classifyAtomicAdmissionReadback(intent)).classification;
}

async function classifyAtomicAdmissionReadback(intent) {
  let winner = null;
  for (const alias of intent.clientIdempotencyHmacAliases) {
    const row = await persistedAtomicAdmissionByAlias(alias);
    if (row === null) {
      continue;
    }
    if (
      row.admission_reservation_key !== null &&
      row.operation_reservation_key !== null &&
      (row.alias_client_request_sha256 !== intent.clientRequestSha256 ||
        row.admission_client_request_sha256 !== intent.clientRequestSha256 ||
        row.operation_client_request_sha256 !== intent.clientRequestSha256)
    ) {
      return { classification: "request_conflict" };
    }
    if (!(await persistedAtomicAdmissionIsValid(row))) {
      return { classification: "immutable_conflict" };
    }
    if (winner !== null && winner.operation_id !== row.operation_id) {
      return { classification: "immutable_conflict" };
    }
    winner = row;
  }

  if (winner === null) {
    const residue = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM relay_billing_reservations
          WHERE reservation_key = ?1) AS reservations,
         (SELECT COUNT(*) FROM relay_container_operations
          WHERE reservation_key = ?1) AS operations,
         (SELECT COUNT(*) FROM relay_container_atomic_admissions
          WHERE reservation_key = ?1) AS admissions,
         (SELECT COUNT(*) FROM relay_container_idempotency_aliases
          WHERE reservation_key = ?1) AS aliases`,
    )
      .bind(intent.reservationKey)
      .first();
    return {
      classification: Object.values(residue).every((count) => count === 0)
        ? "no_state"
        : "immutable_conflict",
    };
  }

  const persistedWinner = {
    reservationKey: winner.reservation_key,
    operationId: winner.operation_id,
    canonicalClientIdempotencyHmacSha256:
      winner.admission_client_idempotency_hmac_sha256,
    clientRequestSha256: winner.admission_client_request_sha256,
  };
  if (
    winner.operation_status === "prepared" ||
    winner.operation_status === "dispatched"
  ) {
    return {
      classification:
        winner.reservation_status === "reserved" &&
        winner.reservation_owner_generation === winner.owner_generation &&
        winner.reservation_owner_deadline_at ===
          winner.owner_lease_expires_at
          ? "matching_resumable"
          : "immutable_conflict",
      winner: persistedWinner,
    };
  }
  if (
    winner.operation_status === "completed" ||
    winner.operation_status === "failed"
  ) {
    return { classification: "terminal_replay", winner: persistedWinner };
  }
  if (winner.operation_status === "recovery_required") {
    return { classification: "matching_resumable", winner: persistedWinner };
  }
  return { classification: "immutable_conflict", winner: persistedWinner };
}

async function persistedAtomicAdmissionByAlias(alias) {
  return env.DB.prepare(
    `SELECT
       alias.client_idempotency_hmac_sha256 AS alias_sha256,
       alias.reservation_key AS alias_reservation_key,
       alias.operation_id AS alias_operation_id,
       alias.canonical_client_idempotency_hmac_sha256 AS alias_canonical_sha256,
       alias.client_request_sha256 AS alias_client_request_sha256,
       alias.created_at AS alias_created_at,
       admission.reservation_key AS admission_reservation_key,
       admission.operation_id AS operation_id,
       admission.contract_version,
       admission.operation_admission_sha256,
       admission.client_idempotency_hmac_sha256 AS admission_client_idempotency_hmac_sha256,
       admission.client_request_sha256 AS admission_client_request_sha256,
       admission.idempotency_alias_count,
       admission.idempotency_aliases_sha256,
       admission.billing_snapshot_sha256,
       admission.user_id,
       admission.token_id,
       admission.pre_consumed_quota AS admission_pre_consumed_quota,
       admission.owner_generation,
       admission.owner_lease_expires_at,
       admission.channel_id,
       admission.selected_channel_type,
       admission.selected_group,
       admission.selected_snapshot_key,
       admission.owner_deadline_at,
       admission.selected_at,
       admission.created_at,
       admission.attempt_count,
       admission.provider_attempt_generation,
       reservation.reservation_key,
       reservation.billing_snapshot_json,
       reservation.user_id AS reservation_user_id,
       reservation.token_id AS reservation_token_id,
       reservation.pre_consumed_quota,
       reservation.owner_generation AS reservation_owner_generation,
       reservation.lease_expires_at AS reservation_owner_lease_expires_at,
       reservation.owner_deadline_at AS reservation_owner_deadline_at,
       reservation.channel_id AS reservation_channel_id,
       reservation.selected_group AS reservation_selected_group,
       reservation.selected_at AS reservation_selected_at,
       reservation.created_at AS reservation_created_at,
       reservation.status AS reservation_status,
       operation.reservation_key AS operation_reservation_key,
       operation.status AS operation_status,
       operation.operation_kind,
       operation.protocol_version,
       operation.admission_sha256 AS stored_operation_admission_sha256,
       operation.client_idempotency_hmac_sha256 AS operation_client_idempotency_hmac_sha256,
       operation.client_request_sha256 AS operation_client_request_sha256,
       operation.owner_generation AS operation_owner_generation,
       operation.owner_lease_expires_at AS operation_owner_lease_expires_at,
       operation.channel_id AS operation_channel_id,
       operation.selected_group AS operation_selected_group,
       operation.created_at AS operation_created_at
     FROM relay_container_idempotency_aliases AS alias
     LEFT JOIN relay_container_atomic_admissions AS admission
       ON admission.reservation_key = alias.reservation_key
     LEFT JOIN relay_billing_reservations AS reservation
       ON reservation.reservation_key = alias.reservation_key
     LEFT JOIN relay_container_operations AS operation
       ON operation.operation_id = alias.operation_id
      AND operation.reservation_key = alias.reservation_key
     WHERE alias.client_idempotency_hmac_sha256 = ?1
     LIMIT 1`,
  )
    .bind(alias)
    .first();
}

async function persistedAtomicAdmissionIsValid(row) {
  const aliases = await env.DB.prepare(
    `SELECT client_idempotency_hmac_sha256,
            reservation_key, operation_id,
            canonical_client_idempotency_hmac_sha256,
            client_request_sha256, created_at
     FROM relay_container_idempotency_aliases
     WHERE reservation_key = ?1
     ORDER BY client_idempotency_hmac_sha256
     LIMIT 3`,
  )
    .bind(row.admission_reservation_key)
    .all();
  const aliasRows = aliases.results;
  const aliasValues = aliasRows.map(
    ({ client_idempotency_hmac_sha256 }) =>
      client_idempotency_hmac_sha256,
  );
  return (
    row.alias_reservation_key === row.admission_reservation_key &&
    row.alias_operation_id === row.operation_id &&
    row.alias_canonical_sha256 ===
      row.admission_client_idempotency_hmac_sha256 &&
    row.alias_client_request_sha256 ===
      row.admission_client_request_sha256 &&
    row.alias_created_at === row.created_at &&
    row.admission_reservation_key === row.reservation_key &&
    row.admission_reservation_key === row.operation_reservation_key &&
    row.operation_id === row.operation_reservation_key &&
    row.contract_version === 1 &&
    row.operation_admission_sha256 === row.stored_operation_admission_sha256 &&
    row.admission_client_idempotency_hmac_sha256 ===
      row.operation_client_idempotency_hmac_sha256 &&
    row.admission_client_request_sha256 ===
      row.operation_client_request_sha256 &&
    aliasRows.length === row.idempotency_alias_count &&
    aliasRows.length >= 1 &&
    aliasRows.length <= 2 &&
    aliasValues.includes(row.admission_client_idempotency_hmac_sha256) &&
    row.idempotency_aliases_sha256 ===
      (await idempotencyAliasesSha256(aliasValues)) &&
    aliasRows.every(
      (aliasRow) =>
        aliasRow.reservation_key === row.admission_reservation_key &&
        aliasRow.operation_id === row.operation_id &&
        aliasRow.canonical_client_idempotency_hmac_sha256 ===
          row.admission_client_idempotency_hmac_sha256 &&
        aliasRow.client_request_sha256 ===
          row.admission_client_request_sha256 &&
        aliasRow.created_at === row.created_at,
    ) &&
    row.billing_snapshot_sha256 ===
      (await sha256Text(row.billing_snapshot_json)) &&
    row.user_id === userId &&
    row.token_id === tokenId &&
    row.admission_pre_consumed_quota === row.pre_consumed_quota &&
    row.owner_generation === 2 &&
    row.owner_lease_expires_at === row.reservation_owner_lease_expires_at &&
    row.owner_deadline_at === row.reservation_owner_deadline_at &&
    row.channel_id === row.reservation_channel_id &&
    row.selected_group === row.reservation_selected_group &&
    row.selected_snapshot_key === String(row.selected_channel_type) &&
    row.selected_at === row.reservation_selected_at &&
    row.created_at === row.reservation_created_at &&
    row.attempt_count === 1 &&
    row.provider_attempt_generation === 1 &&
    row.reservation_user_id === userId &&
    row.reservation_token_id === tokenId &&
    row.operation_owner_generation === row.owner_generation &&
    row.operation_owner_lease_expires_at === row.owner_lease_expires_at &&
    row.operation_channel_id === row.channel_id &&
    row.operation_selected_group === row.selected_group &&
    row.operation_created_at === row.created_at &&
    row.protocol_version === 1 &&
    row.operation_kind === "chat_completions_canary"
  );
}

async function atomicAdmissionState(intent) {
  const [user, token, channel, counts] = await Promise.all([
    env.DB.prepare(
      "SELECT quota, used_quota, request_count FROM users WHERE id = ?1",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT remain_quota, used_quota, accessed_time
       FROM tokens WHERE id = ?1`,
    )
      .bind(tokenId)
      .first(),
    env.DB.prepare("SELECT used_quota FROM channels WHERE id = ?1")
      .bind(channelId)
      .first(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM relay_billing_reservations) AS reservations,
         (SELECT COUNT(*) FROM relay_container_operations) AS operations,
         (SELECT COUNT(*) FROM relay_container_atomic_admissions) AS admissions,
         (SELECT COUNT(*) FROM relay_container_idempotency_aliases) AS aliases`,
    )
      .first(),
  ]);
  return { user, token, channel, counts };
}

async function idempotencyAliasesSha256(aliases) {
  const encoder = new TextEncoder();
  const values = [
    "cinatoken:relay-container-idempotency-alias-set:v1",
    ...[...aliases].sort(),
  ].map((value) => encoder.encode(value));
  const encoded = new Uint8Array(
    values.reduce((length, value) => length + 8 + value.byteLength, 0),
  );
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const value of values) {
    view.setBigUint64(offset, BigInt(value.byteLength), false);
    offset += 8;
    encoded.set(value, offset);
    offset += value.byteLength;
  }
  return sha256Bytes(encoded);
}

async function sha256Text(value) {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hex(character) {
  return character.repeat(64);
}
