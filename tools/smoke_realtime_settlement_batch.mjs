#!/usr/bin/env bun

import { Database } from "bun:sqlite";

const defaultNow = 1_800_100_000;
const defaultStagingDatabase = "<STAGING_D1_DATABASE_NAME>";
const defaultArtifactDir = "artifacts/realtime-settlement-batch";
const defaultBindingSmokeUrl = "http://127.0.0.1:8787";
const bindingSmokePath = "/api/platform/realtime/settlement-batch/smoke";

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const flagNames = new Set([
    "self-test",
    "json",
    "staging-plan",
    "binding-smoke-plan",
    "binding-smoke",
    "confirm-live",
    "retain",
  ]);
  const valueNames = new Set(["database", "wrangler-env", "artifact-dir", "url", "scenario", "cookie"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (!arg.startsWith("--")) {
      usage(2, `Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!flagNames.has(key)) {
      if (!valueNames.has(key)) {
        usage(2, `Unknown option: ${arg}`);
      }
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        usage(2, `${arg} requires a value`);
      }
      values.set(key, value);
      i += 1;
      continue;
    }
    flags.add(key);
  }
  return { values, flags };
}

function usage(exitCode, message = "") {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: bun tools/smoke_realtime_settlement_batch.mjs [--self-test] [--json]",
      "       bun tools/smoke_realtime_settlement_batch.mjs --staging-plan [--database <d1-name>] [--wrangler-env <env>] [--artifact-dir <dir>] [--json]",
      "       bun tools/smoke_realtime_settlement_batch.mjs --binding-smoke-plan [--url <worker-origin>] [--scenario <name|all>] [--json]",
      "       bun tools/smoke_realtime_settlement_batch.mjs --binding-smoke --url <worker-origin> --cookie <admin-cookie> --confirm-live [--scenario <name|all>] [--retain] [--json]",
      "",
      "Runs a local SQLite replay of the Realtime settlement D1 batch guard.",
      "It never writes Cloudflare D1 by itself; use the JSON output as pre-staging evidence.",
      "The staging plan prints reviewed SQL artifacts and Wrangler commands, but never accepts or prints an API token.",
      "The binding smoke plan is dry-run only; live binding smoke requires an admin Cookie and confirm-live.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function runSelfTest() {
  const checks = [
    runCheck("additional_quota_batch_applies_once", additionalQuotaBatchAppliesOnce),
    runCheck("duplicate_replay_is_noop", duplicateReplayIsNoop),
    runCheck("guarded_update_failure_rolls_back", guardedUpdateFailureRollsBack),
    runCheck("audit_failure_rolls_back", auditFailureRollsBack),
    runCheck("refund_delta_batch_applies_once", refundDeltaBatchAppliesOnce),
    runCheck("tokenless_batch_applies_once", tokenlessBatchAppliesOnce),
    runCheck("response_reservation_settles_once", responseReservationSettlesOnce),
    runCheck("response_reservation_guard_rolls_back", responseReservationGuardRollsBack),
    runCheck("response_reservation_refund_is_idempotent", responseReservationRefundIsIdempotent),
    runCheck("parallel_responses_settle_by_response_identity", parallelResponsesSettleByResponseIdentity),
    runCheck("staging_plan_sql_artifacts_replay_locally", stagingPlanSqlArtifactsReplayLocally),
  ];
  const failed = checks.filter((check) => check.status !== "PASS");
  return {
    tool: "smoke_realtime_settlement_batch",
    mode: "self-test",
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
  };
}

function runCheck(name, fn) {
  try {
    return {
      name,
      status: "PASS",
      detail: fn(),
    };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function withDatabase(fn) {
  const db = new Database(":memory:");
  try {
    createSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      quota INTEGER NOT NULL DEFAULT 0,
      used_quota INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tokens (
      id INTEGER PRIMARY KEY,
      remain_quota INTEGER NOT NULL DEFAULT 0,
      used_quota INTEGER NOT NULL DEFAULT 0,
      accessed_time INTEGER NOT NULL DEFAULT 0,
      unlimited_quota INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY,
      used_quota INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      type INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      token_name TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      quota INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      use_time INTEGER NOT NULL DEFAULT 0,
      is_stream INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL DEFAULT 0,
      token_id INTEGER NOT NULL DEFAULT 0,
      "group" TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      upstream_request_id TEXT NOT NULL DEFAULT '',
      other TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE realtime_settlement_replays (
      replay_key TEXT PRIMARY KEY,
      session TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL DEFAULT 0,
      token_id INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL DEFAULT 0,
      model_name TEXT NOT NULL DEFAULT '',
      pre_consumed_quota INTEGER NOT NULL DEFAULT 0,
      final_quota INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'applied',
      created_at INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE realtime_billing_reservations (
      reservation_key TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      client_event_id_hash TEXT NOT NULL DEFAULT '',
      reservation_sequence INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL,
      token_id INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL,
      selected_group TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL,
      pre_consumed_quota INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      token_name TEXT NOT NULL DEFAULT '',
      client_ip TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL DEFAULT 0,
      endpoint_path TEXT NOT NULL DEFAULT 'realtime',
      status TEXT NOT NULL DEFAULT 'reserved',
      upstream_response_id_hash TEXT NOT NULL DEFAULT '',
      replay_key TEXT NOT NULL DEFAULT '',
      final_quota INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      settled_at INTEGER NOT NULL DEFAULT 0,
      refunded_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_realtime_billing_reservations_replay_key
      ON realtime_billing_reservations(replay_key)
      WHERE replay_key <> '';
    CREATE UNIQUE INDEX idx_realtime_billing_reservations_response
      ON realtime_billing_reservations(session, upstream_response_id_hash)
      WHERE upstream_response_id_hash <> '';
  `);
}

function additionalQuotaBatchAppliesOnce() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 900,
      userUsedQuota: 0,
      tokenRemainQuota: 400,
      tokenUsedQuota: 100,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-additional",
      preConsumedQuota: 100,
      finalQuota: 150,
    });

    const result = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);

    assert(result.outcome === "Applied", `additional quota settlement should apply: ${result.error ?? result.outcome}`);
    assert(snapshot.userQuota === 850, "user quota should debit only the additional delta");
    assert(snapshot.userUsedQuota === 150, "user used quota should record final quota");
    assert(snapshot.userRequestCount === 1, "request count should increment once");
    assert(snapshot.tokenRemainQuota === 350, "token remain quota should debit delta");
    assert(snapshot.tokenUsedQuota === 150, "token used quota should settle to final quota");
    assert(snapshot.tokenAccessedTime === record.appliedAt, "token access time should update");
    assert(snapshot.channelUsedQuota === 150, "channel used quota should record final quota");
    assert(snapshot.replayRows === 1, "replay marker should be durable");
    assert(snapshot.logRows === 1, "audit log should be written once");

    return {
      outcome: result.outcome,
      userQuota: snapshot.userQuota,
      userUsedQuota: snapshot.userUsedQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      tokenUsedQuota: snapshot.tokenUsedQuota,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
      guardedStatements: result.guardedStatements,
    };
  });
}

function duplicateReplayIsNoop() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 900,
      userUsedQuota: 0,
      tokenRemainQuota: 400,
      tokenUsedQuota: 100,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-duplicate",
      preConsumedQuota: 100,
      finalQuota: 150,
    });

    const first = runRealtimeSettlementBatch(db, record, auditLog(record));
    const second = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);

    assert(first.outcome === "Applied", `first settlement should apply: ${first.error ?? first.outcome}`);
    assert(second.outcome === "DuplicateReplay", "second settlement should be a replay no-op");
    assert(snapshot.userQuota === 850, "duplicate replay should not debit user again");
    assert(snapshot.tokenRemainQuota === 350, "duplicate replay should not debit token again");
    assert(snapshot.channelUsedQuota === 150, "duplicate replay should not add channel quota again");
    assert(snapshot.replayRows === 1, "duplicate replay should not add marker rows");
    assert(snapshot.logRows === 1, "duplicate replay should not add audit rows");

    return {
      first: first.outcome,
      second: second.outcome,
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
    };
  });
}

function guardedUpdateFailureRollsBack() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 105,
      userUsedQuota: 0,
      tokenRemainQuota: 400,
      tokenUsedQuota: 100,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-guard-failure",
      preConsumedQuota: 100,
      finalQuota: 250,
    });

    const result = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);

    assert(result.outcome === "Error", "insufficient user quota should fail the batch");
    assert(snapshot.userQuota === 105, "failed batch should not change user quota");
    assert(snapshot.tokenRemainQuota === 400, "failed batch should not change token quota");
    assert(snapshot.channelUsedQuota === 0, "failed batch should not change channel usage");
    assert(snapshot.replayRows === 0, "failed batch should roll back replay marker");
    assert(snapshot.logRows === 0, "failed batch should not write audit log");

    return {
      outcome: result.outcome,
      errorContainsConstraint: /UNIQUE|constraint/i.test(result.error),
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
    };
  });
}

function auditFailureRollsBack() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 900,
      userUsedQuota: 0,
      tokenRemainQuota: 400,
      tokenUsedQuota: 100,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-audit-failure",
      preConsumedQuota: 100,
      finalQuota: 150,
    });

    const result = runRealtimeSettlementBatch(db, record, auditLog(record), {
      forceAuditFailure: true,
    });
    const snapshot = settlementSnapshot(db, record);

    assert(result.outcome === "Error", "audit insert failure should fail the batch");
    assert(snapshot.userQuota === 900, "audit failure should roll back user quota");
    assert(snapshot.tokenRemainQuota === 400, "audit failure should roll back token quota");
    assert(snapshot.channelUsedQuota === 0, "audit failure should roll back channel quota");
    assert(snapshot.replayRows === 0, "audit failure should roll back replay marker");
    assert(snapshot.logRows === 0, "audit failure should not leave audit rows");

    return {
      outcome: result.outcome,
      errorContainsMissingTable: /no such table/i.test(result.error),
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
    };
  });
}

function refundDeltaBatchAppliesOnce() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 800,
      userUsedQuota: 0,
      tokenRemainQuota: 300,
      tokenUsedQuota: 200,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-refund",
      preConsumedQuota: 200,
      finalQuota: 120,
    });

    const result = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);

    assert(result.outcome === "Applied", `refund settlement should apply: ${result.error ?? result.outcome}`);
    assert(snapshot.userQuota === 880, "user quota should receive refund delta");
    assert(snapshot.tokenRemainQuota === 380, "token remain quota should receive refund delta");
    assert(snapshot.tokenUsedQuota === 120, "token used quota should settle to final quota");
    assert(snapshot.userUsedQuota === 120, "user used quota should record final quota");
    assert(snapshot.channelUsedQuota === 120, "channel used quota should record final quota");
    assert(snapshot.replayRows === 1, "refund batch should write one replay marker");
    assert(snapshot.logRows === 1, "refund batch should write one audit row");

    return {
      outcome: result.outcome,
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      tokenUsedQuota: snapshot.tokenUsedQuota,
      userUsedQuota: snapshot.userUsedQuota,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
    };
  });
}

function tokenlessBatchAppliesOnce() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 900,
      userUsedQuota: 0,
      tokenRemainQuota: 0,
      tokenUsedQuota: 0,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      replayKey: "rtsettle-tokenless",
      tokenId: 0,
      preConsumedQuota: 100,
      finalQuota: 130,
    });

    const result = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);

    assert(result.outcome === "Applied", `tokenless settlement should apply: ${result.error ?? result.outcome}`);
    assert(snapshot.userQuota === 870, "tokenless settlement should debit user delta");
    assert(snapshot.userUsedQuota === 130, "tokenless user used quota should record final quota");
    assert(snapshot.userRequestCount === 1, "tokenless settlement should increment request count");
    assert(snapshot.channelUsedQuota === 130, "tokenless channel used quota should record final quota");
    assert(snapshot.replayRows === 1, "tokenless batch should write one replay marker");
    assert(snapshot.logRows === 1, "tokenless batch should write one audit row");

    return {
      outcome: result.outcome,
      userQuota: snapshot.userQuota,
      userUsedQuota: snapshot.userUsedQuota,
      userRequestCount: snapshot.userRequestCount,
      channelUsedQuota: snapshot.channelUsedQuota,
      replayRows: snapshot.replayRows,
      logRows: snapshot.logRows,
    };
  });
}

function responseReservationSettlesOnce() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 1_000,
      userUsedQuota: 0,
      tokenRemainQuota: 500,
      tokenUsedQuota: 0,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      reservationKey: "rtreserve-response-1",
      replayKey: "rtsettle-response-1",
      preConsumedQuota: 100,
      finalQuota: 150,
    });
    const reserve = reserveRealtimeResponse(db, record);
    const first = runRealtimeSettlementBatch(db, record, auditLog(record));
    const second = runRealtimeSettlementBatch(db, record, auditLog(record));
    const snapshot = settlementSnapshot(db, record);
    const reservation = db
      .prepare("SELECT status, final_quota, replay_key, request_json FROM realtime_billing_reservations WHERE reservation_key = ?1")
      .get(record.reservationKey);

    assert(reserve.outcome === "Applied", "response reservation should apply");
    assert(first.outcome === "Applied", "reserved response settlement should apply");
    assert(second.outcome === "DuplicateReplay", "reserved response replay should be a no-op");
    assert(snapshot.userQuota === 850, "reservation plus settlement delta should debit final user quota");
    assert(snapshot.tokenRemainQuota === 350, "reservation plus settlement delta should debit final token quota");
    assert(snapshot.userUsedQuota === 150, "settlement should record final used quota once");
    assert(snapshot.channelUsedQuota === 150, "settlement should record final channel quota once");
    assert(reservation.status === "settled", "reservation should transition to settled");
    assert(Number(reservation.final_quota) === 150, "reservation should persist final quota");
    assert(reservation.replay_key === record.replayKey, "reservation should persist replay identity");
    assert(reservation.request_json === "{}", "terminal settlement should clear private request input");
    return { reserve: reserve.outcome, first: first.outcome, second: second.outcome, status: reservation.status };
  });
}

function responseReservationGuardRollsBack() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 1_000,
      userUsedQuota: 0,
      tokenRemainQuota: 50,
      tokenUsedQuota: 0,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({
      reservationKey: "rtreserve-insufficient-token",
      preConsumedQuota: 100,
    });
    const result = reserveRealtimeResponse(db, record);
    const snapshot = settlementSnapshot(db, record);
    const reservationRows = db.prepare("SELECT COUNT(1) AS count FROM realtime_billing_reservations").get();
    assert(result.outcome === "Error", "insufficient token quota should reject reservation");
    assert(snapshot.userQuota === 1_000, "failed token guard must roll back user debit");
    assert(snapshot.tokenRemainQuota === 50, "failed token guard must leave token quota unchanged");
    assert(Number(reservationRows.count) === 0, "failed reservation must roll back its marker");
    return { outcome: result.outcome, userQuota: snapshot.userQuota, reservationRows: Number(reservationRows.count) };
  });
}

function responseReservationRefundIsIdempotent() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 1_000,
      userUsedQuota: 0,
      tokenRemainQuota: 500,
      tokenUsedQuota: 0,
      channelUsedQuota: 0,
    });
    const record = settlementRecord({ reservationKey: "rtreserve-refund", preConsumedQuota: 100 });
    const reserve = reserveRealtimeResponse(db, record);
    const first = refundRealtimeResponse(db, record);
    const second = refundRealtimeResponse(db, record);
    const snapshot = settlementSnapshot(db, record);
    const reservation = db
      .prepare("SELECT request_json FROM realtime_billing_reservations WHERE reservation_key = ?1")
      .get(record.reservationKey);
    assert(reserve.outcome === "Applied", "refund fixture reservation should apply");
    assert(first.outcome === "Applied", "first reservation refund should apply");
    assert(second.outcome === "AlreadyFinalized", "second reservation refund should not credit twice");
    assert(snapshot.userQuota === 1_000, "refund should restore user quota exactly once");
    assert(snapshot.tokenRemainQuota === 500, "refund should restore token quota exactly once");
    assert(reservation.request_json === "{}", "terminal refund should clear private request input");
    return { reserve: reserve.outcome, first: first.outcome, second: second.outcome };
  });
}

function parallelResponsesSettleByResponseIdentity() {
  return withDatabase((db) => {
    seedSettlementFixture(db, {
      userQuota: 2_000,
      userUsedQuota: 0,
      tokenRemainQuota: 1_000,
      tokenUsedQuota: 0,
      channelUsedQuota: 0,
    });
    const first = settlementRecord({
      reservationKey: "rtreserve-parallel-1",
      replayKey: "rtsettle-parallel-1",
      responseIdHash: "response-hash-1",
      reservationSequence: 1,
      preConsumedQuota: 100,
      finalQuota: 120,
    });
    const second = settlementRecord({
      reservationKey: "rtreserve-parallel-2",
      replayKey: "rtsettle-parallel-2",
      responseIdHash: "response-hash-2",
      reservationSequence: 2,
      preConsumedQuota: 100,
      finalQuota: 130,
    });
    assert(reserveRealtimeResponse(db, first).outcome === "Applied", "first parallel reserve");
    assert(reserveRealtimeResponse(db, second).outcome === "Applied", "second parallel reserve");
    assert(bindRealtimeResponse(db, first.session, first.responseIdHash).outcome === "Applied", "bind first response");
    assert(bindRealtimeResponse(db, first.session, first.responseIdHash).outcome === "Duplicate", "duplicate first response binding");
    assert(bindRealtimeResponse(db, second.session, second.responseIdHash).outcome === "Applied", "bind second response");

    const secondResult = runRealtimeSettlementBatch(db, second, auditLog(second, { requestId: "req-parallel-2" }));
    const firstResult = runRealtimeSettlementBatch(db, first, auditLog(first, { requestId: "req-parallel-1" }));
    const rows = db
      .query("SELECT reservation_key, upstream_response_id_hash, final_quota, status FROM realtime_billing_reservations ORDER BY reservation_sequence")
      .all();
    const snapshot = settlementSnapshot(db, first);
    assert(secondResult.outcome === "Applied" && firstResult.outcome === "Applied", "out-of-order done events should settle");
    assert(rows[0].reservation_key === first.reservationKey && Number(rows[0].final_quota) === 120, "first response identity should keep first quota");
    assert(rows[1].reservation_key === second.reservationKey && Number(rows[1].final_quota) === 130, "second response identity should keep second quota");
    assert(rows[0].upstream_response_id_hash === first.responseIdHash, "first response hash should remain bound to first reservation");
    assert(rows[1].upstream_response_id_hash === second.responseIdHash, "duplicate binding must not consume the second reservation");
    assert(snapshot.userUsedQuota === 250, "parallel responses should record both final quotas");
    assert(snapshot.channelUsedQuota === 250, "parallel responses should charge channel by both finals");
    return { secondDone: secondResult.outcome, firstDone: firstResult.outcome, finalQuotas: rows.map((row) => Number(row.final_quota)) };
  });
}

function normalizeStagingPlanOptions(args) {
  const value = (name, envName) => args.values.get(name) || process.env[envName];
  const database = validatePlanValue(
    value("database", "REALTIME_SETTLEMENT_STAGING_D1_DATABASE") || defaultStagingDatabase,
    "database",
  );
  const wranglerEnv = validateOptionalPlanValue(
    value("wrangler-env", "REALTIME_SETTLEMENT_STAGING_WRANGLER_ENV") || "",
    "wrangler-env",
  );
  const artifactDir = validateArtifactDir(
    value("artifact-dir", "REALTIME_SETTLEMENT_STAGING_ARTIFACT_DIR") || defaultArtifactDir,
  );
  return {
    database,
    wranglerEnv,
    artifactDir,
  };
}

function buildStagingPlan(options) {
  const scenarios = stagingScenarioDefinitions().map((scenario) =>
    buildStagingScenarioPlan(scenario, options),
  );
  return {
    tool: "smoke_realtime_settlement_batch",
    mode: "staging-plan",
    status: "PASS",
    dryRun: true,
    database: options.database,
    wranglerEnvironment: options.wranglerEnv || null,
    artifactDir: options.artifactDir,
    safety: {
      writesD1: false,
      requiresOperatorReview: true,
      requiresIsolatedStagingD1: true,
      apiTokenHandling:
        "Use a rotated CLOUDFLARE_API_TOKEN from the shell environment or Wrangler login; never paste tokens into this plan, source, or command history.",
      sourceContract:
        "Mirrors the Worker D1 state machine: response reservation, reserved-to-settled/refunded CAS, replay marker, guarded quota statements, changes()!=1 duplicate-key assertions, and audit row insert.",
      cloudflareReference:
        "Cloudflare D1 batch statements are executed sequentially as a transaction and roll back the sequence when a statement fails.",
    },
    requiredBeforeRun: [
      "Confirm the target database is an isolated staging D1, not production.",
      "Apply migrations through migrations/d1/0019_realtime_billing_reservations.sql.",
      "Write each sqlArtifacts[].sql body to its sqlArtifacts[].path exactly, then review it before running.",
      "Use Wrangler SQL artifacts only for setup, verification, and cleanup; do not treat multi-statement SQL files as D1Database.batch evidence.",
      "Apply the settlement through the deployed Worker binding path, then archive Wrangler stdout/stderr, Worker smoke output, D1 row snapshots, capabilities output, and the matching git commit SHA.",
    ],
    scenarios,
    liveWorkerEvidenceAfterSqlRehearsal: {
      purpose:
        "After setup SQL is reviewed/applied, run the actual Worker Realtime path with a mock upstream usage frame while REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED is enabled only in staging.",
      commands: [
        "bun tools/smoke_realtime_upstream_replay.mjs --scenario response-done-usage --url <STAGING_WORKER_ORIGIN> --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --confirm-live --json",
        "bun tools/smoke_realtime_session.mjs --mode v1 --url <STAGING_WORKER_ORIGIN> --model gpt-4o-realtime-preview --api-key $env:REALTIME_UPSTREAM_REPLAY_API_KEY --confirm-live --json",
      ],
      archive: [
        "capabilities JSON with realtime_session_billing_settlement_batch_compiled=true and realtime_session_billing_settlement_compiled=false before final proof",
        "Realtime runtime status showing metadata-only billing settlement write state",
        "D1 snapshots for realtime_settlement_replays, users, tokens, channels, and logs after the live usage path",
        "A second replay/no-op probe proving no double settlement",
      ],
    },
    archiveChecklist: [
      "For success cases, verify exactly one replay row and one audit log row.",
      "For duplicate replay, verify the Worker binding path reports replay_duplicate and no second audit row is added.",
      "For guarded-update failure, archive Worker binding error metadata plus unchanged user/token/channel rows and zero replay/log rows.",
      "For audit failure, archive Worker binding error metadata plus unchanged quota rows and zero replay/log rows.",
      "For cleanup, archive that all smoke user/token/channel/replay/log rows are removed from staging.",
    ],
  };
}

function normalizeBindingSmokeOptions(args) {
  const value = (name, envName) => args.values.get(name) || process.env[envName];
  const url = validatePlanValue(
    value("url", "REALTIME_SETTLEMENT_SMOKE_URL") || process.env.STAGING_BASE_URL || defaultBindingSmokeUrl,
    "url",
  ).replace(/\/+$/, "");
  const scenario = validatePlanValue(value("scenario", "REALTIME_SETTLEMENT_SMOKE_SCENARIO") || "all", "scenario");
  const cookie = optionalHeaderValue(value("cookie", "REALTIME_SETTLEMENT_SMOKE_COOKIE"), "cookie");
  const scenarios = selectedBindingSmokeScenarios(scenario);
  return {
    url,
    scenario,
    scenarios,
    cookie,
    confirmLive: args.flags.has("confirm-live"),
    cleanup: !args.flags.has("retain"),
  };
}

function selectedBindingSmokeScenarios(value) {
  const scenarios = stagingScenarioDefinitions();
  if (value === "all") {
    return scenarios;
  }
  const selected = scenarios.find((scenario) => scenario.name === value);
  if (!selected) {
    throw new Error(`unknown binding smoke scenario: ${value}`);
  }
  return [selected];
}

function buildBindingSmokePlan(options) {
  return {
    tool: "smoke_realtime_settlement_batch",
    mode: "binding-smoke-plan",
    status: "PASS",
    dryRun: true,
    url: options.url,
    endpoint: bindingSmokePath,
    scenario: options.scenario,
    cleanup: options.cleanup,
    adminCookieConfigured: Boolean(options.cookie),
    requiredBeforeRun: [
      "Deploy a staging Worker with REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED=true.",
      "Keep ENVIRONMENT=staging; the Worker route rejects production.",
      "Authenticate with an admin session Cookie; the tool reports only whether the Cookie is configured.",
      "Run against an isolated staging D1 database with migrations through 0019 applied.",
      "Archive /api/platform/capabilities before and after the smoke run.",
    ],
    requests: options.scenarios.map((scenario) => ({
      scenario: scenario.name,
      method: "POST",
      url: `${options.url}${bindingSmokePath}`,
      body: {
        scenario: scenario.name,
        confirm_live: true,
        cleanup: options.cleanup,
      },
      expectedStatus: "PASS",
      expectedOutcomes: scenario.name === "duplicate-replay-noop"
        ? ["Applied", "DuplicateReplay"]
        : scenario.expectedApplyFailure
          ? ["Error"]
          : ["Applied"],
      expectedSnapshot: scenario.expectedSnapshot,
      bindingPath: "worker_binding",
    })),
    safety: {
      writesD1: true,
      acceptsArbitrarySql: false,
      acceptsApiToken: false,
      secretOutput: "Cookie values are never printed; use environment variables or a local shell variable.",
    },
  };
}

async function runBindingSmoke(options) {
  if (!options.confirmLive) {
    throw new Error("live binding smoke requires --confirm-live");
  }
  if (!options.cookie) {
    throw new Error("live binding smoke requires --cookie or REALTIME_SETTLEMENT_SMOKE_COOKIE");
  }

  const results = [];
  for (const scenario of options.scenarios) {
    const response = await fetch(`${options.url}${bindingSmokePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: options.cookie,
      },
      body: JSON.stringify({
        scenario: scenario.name,
        confirm_live: true,
        cleanup: options.cleanup,
      }),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { parse_error: "response body was not JSON", preview: text.slice(0, 500) };
    }
    const data = body?.data ?? body;
    const status = response.ok && body?.success !== false && data?.status === "PASS" ? "PASS" : "FAIL";
    results.push({
      scenario: scenario.name,
      httpStatus: response.status,
      status,
      report: data,
    });
  }
  const failed = results.filter((result) => result.status !== "PASS");
  return {
    tool: "smoke_realtime_settlement_batch",
    mode: "binding-smoke",
    status: failed.length === 0 ? "PASS" : "FAIL",
    dryRun: false,
    url: options.url,
    endpoint: bindingSmokePath,
    cleanup: options.cleanup,
    adminCookieConfigured: true,
    results,
    summary: {
      scenarios: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
    },
  };
}

function stagingScenarioDefinitions() {
  return [
    stagingScenario({
      name: "additional-quota-applied",
      purpose: "Additional final quota debits user/token quota and records final usage once.",
      baseId: 920101,
      fixture: {
        userQuota: 900,
        userUsedQuota: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 100,
      finalQuota: 150,
      expectedSnapshot: {
        userQuota: 850,
        userUsedQuota: 150,
        userRequestCount: 1,
        tokenRemainQuota: 350,
        tokenUsedQuota: 150,
        tokenAccessedTime: defaultNow,
        channelUsedQuota: 150,
        replayRows: 1,
        logRows: 1,
      },
    }),
    stagingScenario({
      name: "duplicate-replay-noop",
      purpose: "An already-applied replay marker is detected before a second settlement batch.",
      baseId: 920102,
      fixture: {
        userQuota: 900,
        userUsedQuota: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 100,
      finalQuota: 150,
      duplicatePrecheck: true,
      expectedSnapshot: {
        userQuota: 850,
        userUsedQuota: 150,
        userRequestCount: 1,
        tokenRemainQuota: 350,
        tokenUsedQuota: 150,
        tokenAccessedTime: defaultNow,
        channelUsedQuota: 150,
        replayRows: 1,
        logRows: 1,
      },
    }),
    stagingScenario({
      name: "guarded-update-rollback",
      purpose: "A guarded quota update that changes zero rows aborts the batch and rolls back the replay marker.",
      baseId: 920103,
      fixture: {
        userQuota: 105,
        userUsedQuota: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 100,
      finalQuota: 250,
      expectedApplyFailure: true,
      expectedSnapshot: {
        userQuota: 105,
        userUsedQuota: 0,
        userRequestCount: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        tokenAccessedTime: 0,
        channelUsedQuota: 0,
        replayRows: 0,
        logRows: 0,
      },
    }),
    stagingScenario({
      name: "audit-failure-rollback",
      purpose: "A late audit-row failure aborts the batch and rolls back quota mutations plus the replay marker.",
      baseId: 920104,
      fixture: {
        userQuota: 900,
        userUsedQuota: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 100,
      finalQuota: 150,
      expectedApplyFailure: true,
      forceAuditFailure: true,
      expectedSnapshot: {
        userQuota: 900,
        userUsedQuota: 0,
        userRequestCount: 0,
        tokenRemainQuota: 400,
        tokenUsedQuota: 100,
        tokenAccessedTime: 0,
        channelUsedQuota: 0,
        replayRows: 0,
        logRows: 0,
      },
    }),
    stagingScenario({
      name: "refund-delta-applied",
      purpose: "A final quota lower than pre-consumed quota refunds user/token quota and records final usage once.",
      baseId: 920105,
      fixture: {
        userQuota: 800,
        userUsedQuota: 0,
        tokenRemainQuota: 300,
        tokenUsedQuota: 200,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 200,
      finalQuota: 120,
      expectedSnapshot: {
        userQuota: 880,
        userUsedQuota: 120,
        userRequestCount: 1,
        tokenRemainQuota: 380,
        tokenUsedQuota: 120,
        tokenAccessedTime: defaultNow,
        channelUsedQuota: 120,
        replayRows: 1,
        logRows: 1,
      },
    }),
    stagingScenario({
      name: "tokenless-applied",
      purpose: "A tokenless settlement updates user/channel quota and audit log without touching tokens.",
      baseId: 920106,
      tokenId: 0,
      fixture: {
        userQuota: 900,
        userUsedQuota: 0,
        tokenRemainQuota: 0,
        tokenUsedQuota: 0,
        channelUsedQuota: 0,
      },
      preConsumedQuota: 100,
      finalQuota: 130,
      expectedSnapshot: {
        userQuota: 870,
        userUsedQuota: 130,
        userRequestCount: 1,
        tokenRemainQuota: null,
        tokenUsedQuota: null,
        tokenAccessedTime: null,
        channelUsedQuota: 130,
        replayRows: 1,
        logRows: 1,
      },
    }),
  ];
}

function stagingScenario(input) {
  const userId = input.baseId;
  const tokenId = input.tokenId ?? input.baseId + 10_000;
  const channelId = input.baseId + 20_000;
  const replayKey = `rtsettle-${input.name}`;
  const session = `rtsettle-${input.name}`;
  const requestId = `req-rtsettle-${input.name}`;
  const record = settlementRecord({
    replayKey,
    session,
    userId,
    tokenId,
    channelId,
    preConsumedQuota: input.preConsumedQuota,
    finalQuota: input.finalQuota,
  });
  const username = `rtsettle_${input.name.replaceAll("-", "_")}`;
  return {
    ...input,
    ids: { userId, tokenId, channelId },
    username,
    affCode: `rt${input.baseId}`,
    tokenKey: tokenId > 0 ? `rtsettle-smoke-key-${input.name}` : "",
    channelName: `rtsettle smoke ${input.name}`,
    requestId,
    record,
    audit: auditLog(record, {
      username,
      tokenName: tokenId > 0 ? `rtsettle smoke token ${input.name}` : "",
      requestId,
      ip: "198.51.100.42",
    }),
  };
}

function buildStagingScenarioPlan(scenario, options) {
  const prefix = `${options.artifactDir}/${scenario.name}`;
  const sqlArtifacts = [
    sqlArtifact("setup", `${prefix}.setup.sql`, "success", buildStagingSetupSql(scenario), options),
  ];
  if (scenario.duplicatePrecheck) {
    sqlArtifacts.push(
      sqlArtifact(
        "duplicate-precheck",
        `${prefix}.duplicate-precheck.sql`,
        "success",
        buildStagingDuplicatePrecheckSql(scenario),
        options,
      ),
    );
  }
  sqlArtifacts.push(
    sqlArtifact("verify", `${prefix}.verify.sql`, "success", buildStagingVerifySql(scenario), options),
    sqlArtifact("cleanup", `${prefix}.cleanup.sql`, "success", buildStagingCleanupSql(scenario), options),
  );
  return {
    name: scenario.name,
    purpose: scenario.purpose,
    expectedApplyFailure: scenario.expectedApplyFailure === true,
    duplicatePrecheck: scenario.duplicatePrecheck === true,
    applyEvidence: {
      requiredPath: "worker_binding",
      notes: [
        "The reference SQL below mirrors the statement order for review, but staging proof must come from Worker D1Database.batch semantics.",
        "Do not run the reference SQL as a substitute for Worker binding evidence; wrangler d1 execute does not provide the same prepared-statement changes() boundary.",
      ],
      referenceBatchSql: buildStagingApplySql(scenario),
    },
    ids: scenario.ids,
    replayKey: scenario.record.replayKey,
    session: scenario.record.session,
    requestId: scenario.requestId,
    modelName: scenario.record.modelName,
    preConsumedQuota: scenario.record.preConsumedQuota,
    finalQuota: scenario.record.finalQuota,
    expectedSnapshot: scenario.expectedSnapshot,
    sqlArtifacts,
  };
}

function sqlArtifact(role, path, expectExit, sql, options) {
  return {
    role,
    path,
    expectExit,
    command: wranglerD1ExecuteCommand(options, path),
    sql,
  };
}

function wranglerD1ExecuteCommand(options, path) {
  const parts = ["bunx", "wrangler", "d1", "execute", psQuote(options.database)];
  if (options.wranglerEnv) {
    parts.push("--env", psQuote(options.wranglerEnv));
  }
  parts.push("--remote", "--file", psQuote(path));
  return parts.join(" ");
}

function buildStagingSetupSql(scenario) {
  const { userId, tokenId, channelId } = scenario.ids;
  const statements = [
    `-- Realtime settlement staging setup: ${scenario.name}`,
    buildStagingCleanupSql(scenario),
    `INSERT INTO users (id, username, password, display_name, role, status, email, quota, used_quota, request_count, "group", aff_code, created_at, deleted_at)
VALUES (${userId}, ${sqlString(scenario.username)}, 'disabled-staging-smoke-user', 'Realtime Settlement Smoke', 1, 1, '', ${scenario.fixture.userQuota}, ${scenario.fixture.userUsedQuota}, 0, 'default', ${sqlString(scenario.affCode)}, ${defaultNow}, NULL);`,
  ];
  if (tokenId > 0) {
    statements.push(
      `INSERT INTO tokens (id, user_id, "key", status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, allow_ips, used_quota, "group", cross_group_retry, deleted_at)
VALUES (${tokenId}, ${userId}, ${sqlString(scenario.tokenKey)}, 1, ${sqlString(scenario.audit.tokenName)}, ${defaultNow}, 0, -1, ${scenario.fixture.tokenRemainQuota}, 0, 0, '', '', ${scenario.fixture.tokenUsedQuota}, 'default', 0, NULL);`,
    );
  }
  statements.push(
    `INSERT INTO channels (id, type, "key", status, name, weight, created_time, base_url, other, balance, models, "group", used_quota, model_mapping, status_code_mapping, priority, auto_ban, other_info, channel_info, settings)
VALUES (${channelId}, 1, ${sqlString(`rtsettle-channel-key-${scenario.name}`)}, 1, ${sqlString(scenario.channelName)}, 1000, ${defaultNow}, 'https://example.invalid', '', 0, ${sqlString(scenario.record.modelName)}, 'default', ${scenario.fixture.channelUsedQuota}, NULL, '', 1000, 0, '{}', '{}', '');`,
  );
  return statements.join("\n\n");
}

function buildStagingApplySql(scenario) {
  const statements = [
    `-- Realtime settlement staging apply: ${scenario.name}`,
    "-- Expected result: " + (scenario.expectedApplyFailure ? "non-zero exit with full rollback" : "success"),
    "BEGIN TRANSACTION;",
    insertReplaySql(scenario.record),
  ];
  for (const sql of guardedSettlementStatements(scenario)) {
    statements.push(sql);
    statements.push(assertPreviousStatementSql(scenario.record.replayKey));
  }
  if (scenario.forceAuditFailure) {
    statements.push("INSERT INTO missing_realtime_audit_table (id) VALUES (1);");
  } else {
    statements.push(insertAuditSqlForScenario(scenario));
    statements.push(assertPreviousStatementSql(scenario.record.replayKey));
  }
  statements.push("COMMIT;");
  return statements.join("\n\n");
}

function guardedSettlementStatements(scenario) {
  const record = scenario.record;
  const delta = record.finalQuota - record.preConsumedQuota;
  const statements = [];
  if (record.tokenId <= 0) {
    if (delta > 0) {
      statements.push(`UPDATE users SET quota = quota - ${delta} WHERE id = ${record.userId} AND quota >= ${delta};`);
    } else if (delta < 0) {
      const refund = Math.abs(delta);
      statements.push(`UPDATE users SET quota = quota + ${refund} WHERE id = ${record.userId};`);
    }
    statements.push(
      `UPDATE users SET used_quota = used_quota + ${record.finalQuota}, request_count = request_count + 1 WHERE id = ${record.userId};`,
      `UPDATE channels SET used_quota = used_quota + ${record.finalQuota} WHERE id = ${record.channelId};`,
    );
    return statements;
  }
  if (delta > 0) {
    statements.push(
      `UPDATE users SET quota = quota - ${delta} WHERE id = ${record.userId} AND quota >= ${delta};`,
      `UPDATE tokens SET remain_quota = remain_quota - ${delta}, used_quota = used_quota + ${delta}, accessed_time = ${record.appliedAt} WHERE id = ${record.tokenId} AND (unlimited_quota != 0 OR remain_quota >= ${delta});`,
    );
  } else if (delta < 0) {
    const refund = Math.abs(delta);
    statements.push(
      `UPDATE users SET quota = quota + ${refund} WHERE id = ${record.userId};`,
      `UPDATE tokens SET remain_quota = remain_quota + ${refund}, used_quota = MAX(used_quota - ${refund}, 0), accessed_time = ${record.appliedAt} WHERE id = ${record.tokenId};`,
    );
  } else {
    statements.push(`UPDATE tokens SET accessed_time = ${record.appliedAt} WHERE id = ${record.tokenId};`);
  }
  statements.push(
    `UPDATE users SET used_quota = used_quota + ${record.finalQuota}, request_count = request_count + 1 WHERE id = ${record.userId};`,
    `UPDATE channels SET used_quota = used_quota + ${record.finalQuota} WHERE id = ${record.channelId};`,
  );
  return statements;
}

function buildStagingDuplicatePrecheckSql(scenario) {
  return [
    `-- Realtime settlement duplicate replay pre-check: ${scenario.name}`,
    "-- Expected: applied_replay_count = 1, so the Worker must skip a second settlement batch.",
    `SELECT COUNT(1) AS applied_replay_count
FROM realtime_settlement_replays
WHERE replay_key = ${sqlString(scenario.record.replayKey)}
  AND status = 'applied';`,
  ].join("\n\n");
}

function buildStagingVerifySql(scenario) {
  const { userId, tokenId, channelId } = scenario.ids;
  const lines = [
    `-- Realtime settlement staging verification: ${scenario.name}`,
    `-- Expected snapshot: ${JSON.stringify(scenario.expectedSnapshot)}`,
    `SELECT 'users' AS source, id, quota, used_quota, request_count FROM users WHERE id = ${userId};`,
  ];
  if (tokenId > 0) {
    lines.push(
      `SELECT 'tokens' AS source, id, remain_quota, used_quota, accessed_time FROM tokens WHERE id = ${tokenId};`,
    );
  } else {
    lines.push("SELECT 'tokens' AS source, 0 AS id, NULL AS remain_quota, NULL AS used_quota, NULL AS accessed_time;");
  }
  lines.push(
    `SELECT 'channels' AS source, id, used_quota FROM channels WHERE id = ${channelId};`,
    `SELECT 'replays' AS source, COUNT(1) AS count FROM realtime_settlement_replays WHERE replay_key = ${sqlString(scenario.record.replayKey)};`,
    `SELECT 'logs' AS source, COUNT(1) AS count FROM logs WHERE request_id = ${sqlString(scenario.requestId)};`,
  );
  return lines.join("\n\n");
}

function buildStagingCleanupSql(scenario) {
  const { userId, tokenId, channelId } = scenario.ids;
  const statements = [
    `DELETE FROM logs WHERE request_id = ${sqlString(scenario.requestId)} OR user_id = ${userId};`,
    `DELETE FROM realtime_settlement_replays WHERE replay_key = ${sqlString(scenario.record.replayKey)};`,
  ];
  if (tokenId > 0) {
    statements.push(`DELETE FROM tokens WHERE id = ${tokenId} OR "key" = ${sqlString(scenario.tokenKey)};`);
  }
  statements.push(
    `DELETE FROM channels WHERE id = ${channelId};`,
    `DELETE FROM users WHERE id = ${userId} OR username = ${sqlString(scenario.username)} OR aff_code = ${sqlString(scenario.affCode)};`,
  );
  return statements.join("\n");
}

function insertReplaySql(record) {
  return `INSERT INTO realtime_settlement_replays (
  replay_key, session, user_id, token_id, channel_id, model_name,
  pre_consumed_quota, final_quota, status, created_at, applied_at, error
) VALUES (${sqlString(record.replayKey)}, ${sqlString(record.session)}, ${record.userId}, ${record.tokenId}, ${record.channelId}, ${sqlString(record.modelName)}, ${record.preConsumedQuota}, ${record.finalQuota}, 'applied', ${record.createdAt}, ${record.appliedAt}, '');`;
}

function assertPreviousStatementSql(replayKey) {
  return `INSERT INTO realtime_settlement_replays (replay_key)
SELECT ${sqlString(replayKey)}
WHERE changes() != 1;`;
}

function insertAuditSqlForScenario(scenario) {
  const audit = scenario.audit;
  const record = scenario.record;
  return `INSERT INTO logs (
  user_id, created_at, type, content, username, token_name, model_name,
  quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id,
  token_id, "group", ip, request_id, upstream_request_id, other
) VALUES (${audit.userId}, ${record.appliedAt}, 2, ${sqlString(`Rust realtime settled /v1/realtime; tiered quota ${record.finalQuota}`)}, ${sqlString(audit.username)}, ${sqlString(audit.tokenName)}, ${sqlString(audit.model)}, ${audit.quota}, ${audit.promptTokens}, ${audit.completionTokens}, ${audit.useTimeSeconds}, ${audit.isStream ? 1 : 0}, ${audit.channelId}, ${audit.tokenId}, ${sqlString(audit.group)}, ${sqlString(audit.ip)}, ${sqlString(audit.requestId)}, ${sqlString(audit.upstreamRequestId)}, ${sqlString(audit.other)});`;
}

function stagingPlanSqlArtifactsReplayLocally() {
  const options = {
    database: "cinatoken-rust-staging",
    wranglerEnv: "staging",
    artifactDir: defaultArtifactDir,
  };
  const plan = buildStagingPlan(options);
  assert(plan.scenarios.length === 6, "staging plan should cover all six settlement scenarios");
  const serialized = JSON.stringify(plan);
  assert(!serialized.includes("cfut_"), "staging plan must not contain Cloudflare API tokens");
  assert(!serialized.includes("CLOUDFLARE_API_TOKEN="), "staging plan must not print API token assignments");
  const summaries = [];
  for (const scenario of plan.scenarios) {
    summaries.push(runStagingScenarioPlanLocally(scenario));
  }
  return {
    scenarios: summaries.length,
    expectedFailures: summaries.filter((item) => item.expectedApplyFailure).length,
    commandsRedacted: true,
    summaries,
  };
}

function runStagingScenarioPlanLocally(scenario) {
  return withStagingPlanDatabase((db) => {
    for (const artifact of scenario.sqlArtifacts) {
      if (artifact.role === "cleanup") {
        continue;
      }
      db.exec(artifact.sql);
    }
    assertStagingSetupRows(db, scenario);
    assert(
      scenario.applyEvidence.referenceBatchSql.includes("BEGIN TRANSACTION;") &&
        scenario.applyEvidence.referenceBatchSql.includes("changes() != 1"),
      `${scenario.name} reference batch SQL should expose transaction and changes() guard shape`,
    );
    const cleanup = scenario.sqlArtifacts.find((artifact) => artifact.role === "cleanup");
    db.exec(cleanup.sql);
    assertStagingCleanup(db, scenario);
    return {
      name: scenario.name,
      expectedApplyFailure: scenario.expectedApplyFailure,
      setupArtifacts: scenario.sqlArtifacts.filter((artifact) => artifact.role !== "cleanup").length,
      hasReferenceBatchSql: true,
    };
  });
}

function withStagingPlanDatabase(fn) {
  const db = new Database(":memory:");
  try {
    createStagingPlanSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function createStagingPlanSchema(db) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role INTEGER NOT NULL DEFAULT 1,
      status INTEGER NOT NULL DEFAULT 1,
      email TEXT NOT NULL DEFAULT '',
      quota INTEGER NOT NULL DEFAULT 0,
      used_quota INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      "group" TEXT NOT NULL DEFAULT 'default',
      aff_code TEXT NOT NULL DEFAULT '' UNIQUE,
      created_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE tokens (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      "key" TEXT NOT NULL UNIQUE,
      status INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL DEFAULT '',
      created_time INTEGER NOT NULL DEFAULT 0,
      accessed_time INTEGER NOT NULL DEFAULT 0,
      expired_time INTEGER NOT NULL DEFAULT -1,
      remain_quota INTEGER NOT NULL DEFAULT 0,
      unlimited_quota INTEGER NOT NULL DEFAULT 0,
      model_limits_enabled INTEGER NOT NULL DEFAULT 0,
      model_limits TEXT NOT NULL DEFAULT '',
      allow_ips TEXT NOT NULL DEFAULT '',
      used_quota INTEGER NOT NULL DEFAULT 0,
      "group" TEXT NOT NULL DEFAULT '',
      cross_group_retry INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY,
      type INTEGER NOT NULL DEFAULT 0,
      "key" TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL DEFAULT '',
      weight INTEGER NOT NULL DEFAULT 0,
      created_time INTEGER NOT NULL DEFAULT 0,
      base_url TEXT NOT NULL DEFAULT '',
      other TEXT NOT NULL DEFAULT '',
      balance REAL NOT NULL DEFAULT 0,
      models TEXT NOT NULL DEFAULT '',
      "group" TEXT NOT NULL DEFAULT 'default',
      used_quota INTEGER NOT NULL DEFAULT 0,
      model_mapping TEXT,
      status_code_mapping TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      auto_ban INTEGER NOT NULL DEFAULT 1,
      other_info TEXT NOT NULL DEFAULT '',
      channel_info TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      type INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      token_name TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      quota INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      use_time INTEGER NOT NULL DEFAULT 0,
      is_stream INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL DEFAULT 0,
      token_id INTEGER NOT NULL DEFAULT 0,
      "group" TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      upstream_request_id TEXT NOT NULL DEFAULT '',
      other TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE realtime_settlement_replays (
      replay_key TEXT PRIMARY KEY,
      session TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL DEFAULT 0,
      token_id INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL DEFAULT 0,
      model_name TEXT NOT NULL DEFAULT '',
      pre_consumed_quota INTEGER NOT NULL DEFAULT 0,
      final_quota INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'applied',
      created_at INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
  `);
}

function assertStagingSetupRows(db, scenario) {
  const users = db.prepare("SELECT COUNT(1) AS count FROM users WHERE id = ?1").get(scenario.ids.userId);
  const channels = db.prepare("SELECT COUNT(1) AS count FROM channels WHERE id = ?1").get(scenario.ids.channelId);
  const replays = db.prepare("SELECT COUNT(1) AS count FROM realtime_settlement_replays WHERE replay_key = ?1").get(scenario.replayKey);
  const logs = db.prepare("SELECT COUNT(1) AS count FROM logs WHERE request_id = ?1").get(scenario.requestId);
  assert(Number(users.count) === 1, `${scenario.name} setup should insert one user`);
  assert(Number(channels.count) === 1, `${scenario.name} setup should insert one channel`);
  assert(Number(replays.count) === 0, `${scenario.name} setup should not insert replay rows`);
  assert(Number(logs.count) === 0, `${scenario.name} setup should not insert log rows`);
  if (scenario.ids.tokenId > 0) {
    const tokens = db.prepare("SELECT COUNT(1) AS count FROM tokens WHERE id = ?1").get(scenario.ids.tokenId);
    assert(Number(tokens.count) === 1, `${scenario.name} setup should insert one token`);
  }
}

function assertStagingCleanup(db, scenario) {
  const counts = [
    db.prepare("SELECT COUNT(1) AS count FROM users WHERE id = ?1").get(scenario.ids.userId),
    db.prepare("SELECT COUNT(1) AS count FROM channels WHERE id = ?1").get(scenario.ids.channelId),
    db.prepare("SELECT COUNT(1) AS count FROM logs WHERE request_id = ?1").get(scenario.requestId),
    db.prepare("SELECT COUNT(1) AS count FROM realtime_settlement_replays WHERE replay_key = ?1").get(scenario.replayKey),
  ];
  if (scenario.ids.tokenId > 0) {
    counts.push(db.prepare("SELECT COUNT(1) AS count FROM tokens WHERE id = ?1").get(scenario.ids.tokenId));
  }
  const remaining = counts.reduce((sum, row) => sum + Number(row.count), 0);
  assert(remaining === 0, `${scenario.name} cleanup should remove all smoke rows`);
}

function reserveRealtimeResponse(db, record) {
  const guardedChanges = [];
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO realtime_billing_reservations (
          reservation_key, session, client_event_id_hash, reservation_sequence,
          user_id, token_id, channel_id, selected_group, model_name,
          pre_consumed_quota, snapshot_json, request_json, status, created_at, updated_at
        ) VALUES (?1, ?2, 'client-event-hash', ?3, ?4, ?5, ?6, 'default', ?7, ?8, '{"expr":"private"}', '{"prompt":"private"}', 'reserved', ?9, ?9)`,
      ).run(
        record.reservationKey,
        record.session,
        record.reservationSequence,
        record.userId,
        record.tokenId,
        record.channelId,
        record.modelName,
        record.preConsumedQuota,
        record.createdAt,
      );
      if (record.preConsumedQuota > 0) {
        guardedChanges.push(
          runReservationGuarded(
            db,
            reserveUserSql,
            [record.preConsumedQuota, record.userId],
            record.reservationKey,
          ),
        );
        if (record.tokenId > 0) {
          guardedChanges.push(
            runReservationGuarded(
              db,
              debitTokenSql,
              [record.preConsumedQuota, record.createdAt, record.tokenId],
              record.reservationKey,
            ),
          );
        }
      }
    })();
  } catch (error) {
    const duplicate = db
      .prepare("SELECT COUNT(1) AS count FROM realtime_billing_reservations WHERE reservation_key = ?1")
      .get(record.reservationKey);
    return {
      outcome: Number(duplicate.count) > 0 ? "Duplicate" : "Error",
      error: error instanceof Error ? error.message : String(error),
      guardedStatements: guardedChanges.length,
    };
  }
  return { outcome: "Applied", guardedStatements: guardedChanges.length };
}

function bindRealtimeResponse(db, session, responseIdHash) {
  const existing = db
    .prepare(
      `SELECT reservation_key
       FROM realtime_billing_reservations
       WHERE session = ?1 AND upstream_response_id_hash = ?2`,
    )
    .get(session, responseIdHash);
  if (existing) {
    return { outcome: "Duplicate", reservationKey: existing.reservation_key };
  }
  const result = db
    .prepare(
      `UPDATE realtime_billing_reservations
       SET upstream_response_id_hash = ?2, updated_at = ?3
       WHERE reservation_key = (
         SELECT reservation_key
         FROM realtime_billing_reservations
         WHERE session = ?1
           AND status = 'reserved'
           AND upstream_response_id_hash = ''
         ORDER BY reservation_sequence ASC, reservation_key ASC
         LIMIT 1
       )
         AND status = 'reserved'
         AND upstream_response_id_hash = ''`,
    )
    .run(session, responseIdHash, defaultNow);
  return {
    outcome: result.changes === 1 ? "Applied" : "NotFound",
    reservationKey: result.changes === 1
      ? db
          .prepare(
            `SELECT reservation_key
             FROM realtime_billing_reservations
             WHERE session = ?1 AND upstream_response_id_hash = ?2`,
          )
          .get(session, responseIdHash).reservation_key
      : null,
  };
}

function refundRealtimeResponse(db, record) {
  const reservation = db
    .prepare("SELECT status, pre_consumed_quota, user_id, token_id FROM realtime_billing_reservations WHERE reservation_key = ?1")
    .get(record.reservationKey);
  if (!reservation) {
    return { outcome: "NotFound" };
  }
  if (reservation.status !== "reserved") {
    return { outcome: "AlreadyFinalized" };
  }
  try {
    db.transaction(() => {
      runReservationGuarded(
        db,
        `UPDATE realtime_billing_reservations
         SET status = 'refunded', snapshot_json = '{}', request_json = '{}',
             updated_at = ?2, refunded_at = ?2
         WHERE reservation_key = ?1 AND status = 'reserved'`,
        [record.reservationKey, record.appliedAt],
        record.reservationKey,
      );
      const quota = Number(reservation.pre_consumed_quota);
      if (quota > 0) {
        runReservationGuarded(db, creditUserSql, [quota, Number(reservation.user_id)], record.reservationKey);
        if (Number(reservation.token_id) > 0) {
          runReservationGuarded(
            db,
            creditTokenSql,
            [quota, record.appliedAt, Number(reservation.token_id)],
            record.reservationKey,
          );
        }
      }
    })();
  } catch (error) {
    return { outcome: "Error", error: error instanceof Error ? error.message : String(error) };
  }
  return { outcome: "Applied" };
}

function runRealtimeSettlementBatch(db, record, audit, options = {}) {
  validateAuditMatches(record, audit);
  if (replayApplied(db, record.replayKey)) {
    return { outcome: "DuplicateReplay", guardedStatements: 0 };
  }
  const guardedChanges = [];
  try {
    db.transaction(() => {
      insertReplay(db, record);
      if (record.reservationKey) {
        guardedChanges.push(
          runReservationGuarded(
            db,
            `UPDATE realtime_billing_reservations
             SET status = 'settled', upstream_response_id_hash = ?2,
                 replay_key = ?3, final_quota = ?4, snapshot_json = '{}', request_json = '{}',
                 updated_at = ?5, settled_at = ?5
             WHERE reservation_key = ?1
               AND status = 'reserved'
               AND (upstream_response_id_hash = '' OR upstream_response_id_hash = ?2)`,
            [
              record.reservationKey,
              record.responseIdHash,
              record.replayKey,
              record.finalQuota,
              record.appliedAt,
            ],
            record.reservationKey,
          ),
        );
      }
      const delta = record.finalQuota - record.preConsumedQuota;
      if (record.tokenId <= 0) {
        if (delta > 0) {
          guardedChanges.push(runGuarded(db, reserveUserSql, [delta, record.userId], record.replayKey));
        } else if (delta < 0) {
          guardedChanges.push(runGuarded(db, creditUserSql, [Math.abs(delta), record.userId], record.replayKey));
        }
        guardedChanges.push(
          runGuarded(db, incrementUserUsedSql, [record.finalQuota, record.userId], record.replayKey),
        );
        guardedChanges.push(
          runGuarded(db, incrementChannelUsedSql, [record.finalQuota, record.channelId], record.replayKey),
        );
      } else {
        if (delta > 0) {
          guardedChanges.push(runGuarded(db, reserveUserSql, [delta, record.userId], record.replayKey));
          guardedChanges.push(
            runGuarded(db, debitTokenSql, [delta, record.appliedAt, record.tokenId], record.replayKey),
          );
        } else if (delta < 0) {
          const refund = Math.abs(delta);
          guardedChanges.push(runGuarded(db, creditUserSql, [refund, record.userId], record.replayKey));
          guardedChanges.push(
            runGuarded(db, creditTokenSql, [refund, record.appliedAt, record.tokenId], record.replayKey),
          );
        } else {
          guardedChanges.push(
            runGuarded(db, touchTokenSql, [record.appliedAt, record.tokenId], record.replayKey),
          );
        }
        guardedChanges.push(
          runGuarded(db, incrementUserUsedSql, [record.finalQuota, record.userId], record.replayKey),
        );
        guardedChanges.push(
          runGuarded(db, incrementChannelUsedSql, [record.finalQuota, record.channelId], record.replayKey),
        );
      }
      if (options.forceAuditFailure) {
        db.prepare("INSERT INTO missing_realtime_audit_table (id) VALUES (1)").run();
      } else {
        guardedChanges.push(runGuarded(db, insertAuditSql, auditArgs(record, audit), record.replayKey));
      }
    })();
  } catch (error) {
    return {
      outcome: "Error",
      error: error instanceof Error ? error.message : String(error),
      replayAppliedAfterError: replayApplied(db, record.replayKey),
      guardedStatements: guardedChanges.length,
    };
  }
  return {
    outcome: "Applied",
    guardedStatements: guardedChanges.length,
    changes: guardedChanges,
  };
}

const reserveUserSql = `
  UPDATE users
  SET quota = quota - ?1
  WHERE id = ?2
    AND quota >= ?1
`;

const creditUserSql = "UPDATE users SET quota = quota + ?1 WHERE id = ?2";

const incrementUserUsedSql = `
  UPDATE users
  SET used_quota = used_quota + ?1,
      request_count = request_count + 1
  WHERE id = ?2
`;

const debitTokenSql = `
  UPDATE tokens
  SET remain_quota = remain_quota - ?1,
      used_quota = used_quota + ?1,
      accessed_time = ?2
  WHERE id = ?3
    AND (unlimited_quota != 0 OR remain_quota >= ?1)
`;

const creditTokenSql = `
  UPDATE tokens
  SET remain_quota = remain_quota + ?1,
      used_quota = MAX(used_quota - ?1, 0),
      accessed_time = ?2
  WHERE id = ?3
`;

const touchTokenSql = "UPDATE tokens SET accessed_time = ?1 WHERE id = ?2";

const incrementChannelUsedSql = "UPDATE channels SET used_quota = used_quota + ?1 WHERE id = ?2";

const insertAuditSql = `
  INSERT INTO logs (
    user_id, created_at, type, content, username, token_name, model_name,
    quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id,
    token_id, "group", ip, request_id, upstream_request_id, other
  ) VALUES (?1, ?2, 2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
`;

function runGuarded(db, sql, params, replayKey) {
  const changes = db.prepare(sql).run(...params).changes;
  db.prepare(
    `
    INSERT INTO realtime_settlement_replays (replay_key)
    SELECT ?1
    WHERE changes() != 1
    `,
  ).run(replayKey);
  return changes;
}

function runReservationGuarded(db, sql, params, reservationKey) {
  const changes = db.prepare(sql).run(...params).changes;
  db.prepare(
    `INSERT INTO realtime_billing_reservations (
       reservation_key, session, user_id, channel_id, model_name, snapshot_json, request_json
     )
     SELECT ?1, '', 0, 0, '', '{}', '{}'
     WHERE changes() != 1`,
  ).run(reservationKey);
  return changes;
}

function insertReplay(db, record) {
  db.prepare(
    `
    INSERT INTO realtime_settlement_replays (
      replay_key, session, user_id, token_id, channel_id, model_name,
      pre_consumed_quota, final_quota, status, created_at, applied_at, error
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'applied', ?9, ?10, '')
    `,
  ).run(
    record.replayKey,
    record.session,
    record.userId,
    record.tokenId,
    record.channelId,
    record.modelName,
    record.preConsumedQuota,
    record.finalQuota,
    record.createdAt,
    record.appliedAt,
  );
}

function replayApplied(db, replayKey) {
  const row = db.prepare(
    "SELECT COUNT(1) AS count FROM realtime_settlement_replays WHERE replay_key = ?1 AND status = 'applied'",
  ).get(replayKey);
  return Number(row.count) > 0;
}

function seedSettlementFixture(db, fixture) {
  db.prepare("INSERT INTO users (id, quota, used_quota, request_count) VALUES (1, ?1, ?2, 0)")
    .run(fixture.userQuota, fixture.userUsedQuota);
  db.prepare(
    "INSERT INTO tokens (id, remain_quota, used_quota, accessed_time, unlimited_quota) VALUES (10, ?1, ?2, 0, 0)",
  ).run(fixture.tokenRemainQuota, fixture.tokenUsedQuota);
  db.prepare("INSERT INTO channels (id, used_quota) VALUES (100, ?1)").run(fixture.channelUsedQuota);
}

function settlementRecord(overrides = {}) {
  return {
    reservationKey: overrides.reservationKey ?? null,
    replayKey: overrides.replayKey ?? "rtsettle-smoke",
    responseIdHash: overrides.responseIdHash ?? "response-hash",
    reservationSequence: overrides.reservationSequence ?? 1,
    session: overrides.session ?? "session-smoke",
    userId: overrides.userId ?? 1,
    tokenId: overrides.tokenId ?? 10,
    channelId: overrides.channelId ?? 100,
    modelName: overrides.modelName ?? "gpt-4o-realtime-preview",
    preConsumedQuota: overrides.preConsumedQuota ?? 100,
    finalQuota: overrides.finalQuota ?? 150,
    createdAt: overrides.createdAt ?? defaultNow,
    appliedAt: overrides.appliedAt ?? defaultNow,
  };
}

function auditLog(record, overrides = {}) {
  return {
    userId: overrides.userId ?? record.userId,
    username: overrides.username ?? "realtime-smoke-user",
    tokenId: overrides.tokenId ?? record.tokenId,
    tokenName: overrides.tokenName ?? "realtime smoke token",
    channelId: overrides.channelId ?? record.channelId,
    model: overrides.model ?? record.modelName,
    group: overrides.group ?? "default",
    promptTokens: overrides.promptTokens ?? 1000,
    completionTokens: overrides.completionTokens ?? 600,
    quota: overrides.quota ?? record.finalQuota,
    useTimeSeconds: overrides.useTimeSeconds ?? 3,
    isStream: overrides.isStream ?? true,
    ip: overrides.ip ?? "203.0.113.10",
    requestId: overrides.requestId ?? "req-realtime-smoke",
    upstreamRequestId: overrides.upstreamRequestId ?? "",
    other: overrides.other ?? JSON.stringify({
      tiered_billing: {
        final_quota: record.finalQuota,
        pre_consumed_quota: record.preConsumedQuota,
      },
      realtime_billing: {
        replay_recorded: true,
      },
    }),
  };
}

function validateAuditMatches(record, audit) {
  if (
    audit.userId !== record.userId ||
    audit.tokenId !== record.tokenId ||
    audit.channelId !== record.channelId ||
    audit.quota !== record.finalQuota ||
    audit.model !== record.modelName
  ) {
    throw new Error("realtime settlement audit log does not match replay record");
  }
}

function auditArgs(record, audit) {
  return [
    audit.userId,
    record.appliedAt,
    `Rust realtime settled /v1/realtime; tiered quota ${record.finalQuota}`,
    audit.username,
    audit.tokenName,
    audit.model,
    audit.quota,
    audit.promptTokens,
    audit.completionTokens,
    audit.useTimeSeconds,
    audit.isStream ? 1 : 0,
    audit.channelId,
    audit.tokenId,
    audit.group,
    audit.ip,
    audit.requestId,
    audit.upstreamRequestId,
    audit.other,
  ];
}

function settlementSnapshot(db, record) {
  const user = db.prepare("SELECT quota, used_quota, request_count FROM users WHERE id = ?1").get(record.userId);
  const token = record.tokenId > 0
    ? db.prepare("SELECT remain_quota, used_quota, accessed_time FROM tokens WHERE id = ?1").get(record.tokenId)
    : null;
  const channel = db.prepare("SELECT used_quota FROM channels WHERE id = ?1").get(record.channelId);
  const replayRows = db.prepare("SELECT COUNT(1) AS count FROM realtime_settlement_replays").get();
  const logRows = db.prepare("SELECT COUNT(1) AS count FROM logs").get();
  return {
    userQuota: Number(user.quota),
    userUsedQuota: Number(user.used_quota),
    userRequestCount: Number(user.request_count),
    tokenRemainQuota: token ? Number(token.remain_quota) : null,
    tokenUsedQuota: token ? Number(token.used_quota) : null,
    tokenAccessedTime: token ? Number(token.accessed_time) : null,
    channelUsedQuota: Number(channel.used_quota),
    replayRows: Number(replayRows.count),
    logRows: Number(logRows.count),
  };
}

function validatePlanValue(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${name} must not contain control characters`);
  }
  if (text.includes("cfut_")) {
    throw new Error(`${name} must not contain Cloudflare API tokens`);
  }
  return text;
}

function validateOptionalPlanValue(value, name) {
  const text = String(value || "").trim();
  return text ? validatePlanValue(text, name) : "";
}

function optionalHeaderValue(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${name} must not contain control characters`);
  }
  if (text.includes("cfut_")) {
    throw new Error(`${name} must not contain Cloudflare API tokens`);
  }
  return text;
}

function validateArtifactDir(value) {
  const text = validatePlanValue(value, "artifact-dir").replaceAll("\\", "/").replace(/\/+$/, "");
  if (text.includes("..")) {
    throw new Error("artifact-dir must not contain parent-directory segments");
  }
  return text;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "staging-plan") {
    console.log(
      [
        "Realtime settlement staging plan",
        `database: ${result.database}`,
        `wrangler_environment: ${result.wranglerEnvironment ?? "(default)"}`,
        `artifact_dir: ${result.artifactDir}`,
        "required_before_run:",
        ...result.requiredBeforeRun.map((item) => `- ${item}`),
        "scenarios:",
        ...result.scenarios.flatMap((scenario) => [
          `- ${scenario.name}: ${scenario.purpose}`,
          ...scenario.sqlArtifacts.map(
            (artifact) =>
              `  ${artifact.role} (${artifact.expectExit}): ${artifact.path}\n    ${artifact.command}`,
          ),
        ]),
        "archive_checklist:",
        ...result.archiveChecklist.map((item) => `- ${item}`),
      ].join("\n"),
    );
    return;
  }
  if (result.mode === "binding-smoke-plan") {
    console.log(
      [
        "Realtime settlement Worker-binding smoke plan",
        `url: ${result.url}`,
        `endpoint: ${result.endpoint}`,
        `scenario: ${result.scenario}`,
        `cleanup: ${result.cleanup}`,
        `admin_cookie_configured: ${result.adminCookieConfigured}`,
        "required_before_run:",
        ...result.requiredBeforeRun.map((item) => `- ${item}`),
        "requests:",
        ...result.requests.map(
          (request) =>
            `- ${request.scenario}: ${request.method} ${request.url} expected ${request.expectedStatus}`,
        ),
      ].join("\n"),
    );
    return;
  }
  if (result.mode === "binding-smoke") {
    console.log(`Realtime settlement Worker-binding smoke: ${result.status}`);
    console.log(`url: ${result.url}`);
    console.log(`cleanup: ${result.cleanup}`);
    console.log(`admin_cookie_configured: ${result.adminCookieConfigured}`);
    for (const item of result.results) {
      console.log(`- ${item.scenario}: ${item.status} (http ${item.httpStatus})`);
    }
    return;
  }
  console.log(`${result.tool}: ${result.status}`);
  for (const check of result.checks) {
    console.log(`- ${check.name}: ${check.status}`);
    if (check.message) {
      console.log(`  ${check.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.flags.has("binding-smoke")
    ? await runBindingSmoke(normalizeBindingSmokeOptions(args))
    : args.flags.has("binding-smoke-plan")
      ? buildBindingSmokePlan(normalizeBindingSmokeOptions(args))
      : args.flags.has("staging-plan")
        ? buildStagingPlan(normalizeStagingPlanOptions(args))
        : runSelfTest();
  printResult(result, args.flags.has("json"));
  if (result.status !== "PASS") {
    process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
