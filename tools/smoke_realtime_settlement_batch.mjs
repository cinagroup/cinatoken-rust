#!/usr/bin/env bun

import { Database } from "bun:sqlite";

const defaultNow = 1_800_100_000;

function parseArgs(argv) {
  const flags = new Set();
  const flagNames = new Set(["self-test", "json"]);
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (!arg.startsWith("--")) {
      usage(2, `Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!flagNames.has(key)) {
      usage(2, `Unknown option: ${arg}`);
    }
    flags.add(key);
  }
  return { flags };
}

function usage(exitCode, message = "") {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: bun tools/smoke_realtime_settlement_batch.mjs [--self-test] [--json]",
      "",
      "Runs a local SQLite replay of the Realtime settlement D1 batch guard.",
      "It never writes Cloudflare D1; use the JSON output as pre-staging evidence.",
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

function runRealtimeSettlementBatch(db, record, audit, options = {}) {
  validateAuditMatches(record, audit);
  if (replayApplied(db, record.replayKey)) {
    return { outcome: "DuplicateReplay", guardedStatements: 0 };
  }
  const guardedChanges = [];
  try {
    db.transaction(() => {
      insertReplay(db, record);
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
    replayKey: overrides.replayKey ?? "rtsettle-smoke",
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
  console.log(`${result.tool}: ${result.status}`);
  for (const check of result.checks) {
    console.log(`- ${check.name}: ${check.status}`);
    if (check.message) {
      console.log(`  ${check.message}`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = runSelfTest();
  printResult(result, args.flags.has("json"));
  if (result.status !== "PASS") {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
