#!/usr/bin/env bun

import { Database } from "bun:sqlite";

const legacyTaskTimeoutCutoffUnix = 1_740_182_400;
const defaultNow = 1_800_000_000;

const status = {
  inProgress: "IN_PROGRESS",
  queued: "QUEUED",
  failure: "FAILURE",
};

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
      "Usage: bun tools/smoke_task_refund_batch.mjs [--self-test] [--json]",
      "",
      "Runs a local SQLite replay of the Worker task refund batch guard.",
      "It never writes Cloudflare D1; use the JSON output as pre-staging evidence.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function runSelfTest() {
  const checks = [
    runCheck("timeout_refund_batch_once", timeoutRefundBatchOnce),
    runCheck("video_provider_failure_refund_once", () =>
      providerFailureRefundOnce("poll", status.queued, 55),
    ),
    runCheck("suno_provider_failure_refund_once", () =>
      providerFailureRefundOnce("suno", status.inProgress, 65),
    ),
    runCheck("legacy_timeout_cas_skips_refund", legacyTimeoutCasSkipsRefund),
    runCheck("timeout_sweep_unblocks_newer_poll_rows", timeoutSweepUnblocksNewerPollRows),
  ];
  const failed = checks.filter((check) => check.status !== "PASS");
  return {
    tool: "smoke_task_refund_batch",
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
      quota INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tokens (
      id INTEGER PRIMARY KEY,
      remain_quota INTEGER NOT NULL DEFAULT 0,
      used_quota INTEGER NOT NULL DEFAULT 0,
      accessed_time INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      upstream_task_id TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL DEFAULT 0,
      channel_id INTEGER NOT NULL DEFAULT 0,
      quota INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      fail_reason TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '',
      submit_time INTEGER NOT NULL DEFAULT 0,
      finish_time INTEGER NOT NULL DEFAULT 0,
      private_data TEXT NOT NULL DEFAULT '{}',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function timeoutRefundBatchOnce() {
  return withDatabase((db) => {
    seedRefundFixture(db, {
      taskId: 1,
      userId: 1,
      tokenId: 10,
      userQuota: 1_000,
      tokenRemainQuota: 200,
      tokenUsedQuota: 300,
      quota: 75,
      taskStatus: status.inProgress,
      submitTime: legacyTaskTimeoutCutoffUnix + 60,
    });

    const first = runRefundBatch(db, {
      taskId: 1,
      userId: 1,
      tokenId: 10,
      quota: 75,
      from: status.inProgress,
      to: status.failure,
      kind: "timeout",
      now: defaultNow + 1,
      failReason: "timeout",
    });
    const second = runRefundBatch(db, {
      taskId: 1,
      userId: 1,
      tokenId: 10,
      quota: 75,
      from: status.inProgress,
      to: status.failure,
      kind: "timeout",
      now: defaultNow + 2,
      failReason: "timeout",
    });
    const lateCredit = runRefundCreditOnly(db, {
      taskId: 1,
      userId: 1,
      tokenId: 10,
      quota: 75,
      marker: first.marker,
      now: defaultNow + 3,
    });
    const snapshot = refundSnapshot(db, 1, 10, 1);

    assert(first.won, "first timeout batch should win the status CAS");
    assert(!second.won, "second timeout batch should lose the status CAS");
    assert(lateCredit.userChanges === 0, "late user refund should be blocked by done marker");
    assert(lateCredit.tokenChanges === 0, "late token refund should be blocked by done marker");
    assert(snapshot.userQuota === 1_075, "user quota should be refunded exactly once");
    assert(snapshot.tokenRemainQuota === 275, "token remain_quota should be refunded exactly once");
    assert(snapshot.tokenUsedQuota === 225, "token used_quota should be decremented exactly once");
    assert(snapshot.taskStatus === status.failure, "task should end in FAILURE");
    assert(snapshot.taskRefundMarker === first.marker, "task should retain the winning marker");
    assert(snapshot.taskRefundDoneAt === defaultNow + 1, "task should record refund done time");

    return {
      casWinner: first.won,
      casReplayWinner: second.won,
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      tokenUsedQuota: snapshot.tokenUsedQuota,
      lateCreditUserChanges: lateCredit.userChanges,
      lateCreditTokenChanges: lateCredit.tokenChanges,
    };
  });
}

function providerFailureRefundOnce(kind, fromStatus, quota) {
  return withDatabase((db) => {
    const taskId = kind === "poll" ? 2 : 3;
    const userId = kind === "poll" ? 2 : 3;
    const tokenId = kind === "poll" ? 20 : 30;
    seedRefundFixture(db, {
      taskId,
      userId,
      tokenId,
      userQuota: 10,
      tokenRemainQuota: 20,
      tokenUsedQuota: 500,
      quota,
      taskStatus: fromStatus,
      submitTime: legacyTaskTimeoutCutoffUnix + 120,
    });

    const first = runRefundBatch(db, {
      taskId,
      userId,
      tokenId,
      quota,
      from: fromStatus,
      to: status.failure,
      kind,
      now: defaultNow + taskId,
      failReason: `${kind} provider failure`,
    });
    const second = runRefundBatch(db, {
      taskId,
      userId,
      tokenId,
      quota,
      from: fromStatus,
      to: status.failure,
      kind,
      now: defaultNow + taskId + 100,
      failReason: `${kind} provider failure`,
    });
    const snapshot = refundSnapshot(db, userId, tokenId, taskId);

    assert(first.won, `${kind} provider failure should win once`);
    assert(!second.won, `${kind} provider failure replay should be a no-op`);
    assert(snapshot.userQuota === 10 + quota, `${kind} user refund should apply once`);
    assert(snapshot.tokenRemainQuota === 20 + quota, `${kind} token refund should apply once`);
    assert(snapshot.tokenUsedQuota === 500 - quota, `${kind} token used quota should decrement once`);
    assert(snapshot.taskRefundDoneAt === defaultNow + taskId, `${kind} refund should be marked done`);

    return {
      kind,
      casWinner: first.won,
      casReplayWinner: second.won,
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      tokenUsedQuota: snapshot.tokenUsedQuota,
    };
  });
}

function legacyTimeoutCasSkipsRefund() {
  return withDatabase((db) => {
    seedRefundFixture(db, {
      taskId: 4,
      userId: 4,
      tokenId: 40,
      userQuota: 700,
      tokenRemainQuota: 80,
      tokenUsedQuota: 90,
      quota: 600,
      taskStatus: status.inProgress,
      submitTime: legacyTaskTimeoutCutoffUnix - 60,
    });

    const cas = runStatusCasWithoutRefund(db, {
      taskId: 4,
      from: status.inProgress,
      to: status.failure,
      now: defaultNow + 4,
      failReason: "legacy timeout",
    });
    const snapshot = refundSnapshot(db, 4, 40, 4);

    assert(cas.won, "legacy timeout status CAS should still fail the task");
    assert(snapshot.userQuota === 700, "legacy timeout should not refund user quota");
    assert(snapshot.tokenRemainQuota === 80, "legacy timeout should not refund token quota");
    assert(snapshot.tokenUsedQuota === 90, "legacy timeout should not decrement token used quota");
    assert(snapshot.taskRefundMarker === null, "legacy timeout should not write refund marker");
    assert(snapshot.taskRefundDoneAt === null, "legacy timeout should not write refund done marker");

    return {
      casWinner: cas.won,
      userQuota: snapshot.userQuota,
      tokenRemainQuota: snapshot.tokenRemainQuota,
      tokenUsedQuota: snapshot.tokenUsedQuota,
      marker: snapshot.taskRefundMarker,
    };
  });
}

function timeoutSweepUnblocksNewerPollRows() {
  return withDatabase((db) => {
    seedRefundFixture(db, {
      taskId: 5,
      userId: 5,
      tokenId: 50,
      userQuota: 0,
      tokenRemainQuota: 0,
      tokenUsedQuota: 30,
      quota: 10,
      taskStatus: status.inProgress,
      submitTime: 1_000,
      upstreamTaskId: "upstream-stale-old",
    });
    seedRefundFixture(db, {
      taskId: 6,
      userId: 6,
      tokenId: 60,
      userQuota: 0,
      tokenRemainQuota: 0,
      tokenUsedQuota: 30,
      quota: 10,
      taskStatus: status.queued,
      submitTime: 2_000,
      upstreamTaskId: "upstream-stale-new",
    });
    seedRefundFixture(db, {
      taskId: 7,
      userId: 7,
      tokenId: 70,
      userQuota: 0,
      tokenRemainQuota: 0,
      tokenUsedQuota: 30,
      quota: 10,
      taskStatus: status.inProgress,
      submitTime: legacyTaskTimeoutCutoffUnix + 1_000,
      upstreamTaskId: "upstream-fresh",
    });

    const staleBefore = findTimedOutUnfinishedTasks(db, legacyTaskTimeoutCutoffUnix, 2);
    assert(
      staleBefore.map((row) => row.task_id).join(",") === "task_5,task_6",
      "timeout sweep should select the oldest stale tasks first",
    );

    for (const row of staleBefore) {
      runRefundBatch(db, {
        taskId: row.id,
        userId: row.user_id,
        tokenId: row.token_id,
        quota: row.quota,
        from: row.status,
        to: status.failure,
        kind: "timeout",
        now: defaultNow + row.id,
        failReason: "timeout",
      });
    }

    const unfinishedAfterSweep = findUnfinishedTasks(db, 10);
    assert(
      unfinishedAfterSweep.length === 1 && unfinishedAfterSweep[0].task_id === "task_7",
      "newer unfinished task should be visible to normal provider polling after stale rows are cleared",
    );

    return {
      staleBefore: staleBefore.map((row) => row.task_id),
      unfinishedAfterSweep: unfinishedAfterSweep.map((row) => row.task_id),
    };
  });
}

function seedRefundFixture(db, fixture) {
  db.prepare("INSERT INTO users (id, quota) VALUES (?1, ?2)").run(
    fixture.userId,
    fixture.userQuota,
  );
  db.prepare(
    "INSERT INTO tokens (id, remain_quota, used_quota, accessed_time) VALUES (?1, ?2, ?3, 0)",
  ).run(fixture.tokenId, fixture.tokenRemainQuota, fixture.tokenUsedQuota);
  db.prepare(
    `
    INSERT INTO tasks
      (id, task_id, upstream_task_id, user_id, channel_id, quota, status,
       fail_reason, progress, submit_time, finish_time, private_data, data, updated_at)
    VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, '', '0%', ?7, 0, ?8, '{}', ?9)
    `,
  ).run(
    fixture.taskId,
    `task_${fixture.taskId}`,
    fixture.upstreamTaskId ?? `upstream_${fixture.taskId}`,
    fixture.userId,
    fixture.quota,
    fixture.taskStatus,
    fixture.submitTime,
    JSON.stringify({ token_id: fixture.tokenId, upstream_task_id: `upstream_${fixture.taskId}` }),
    fixture.submitTime,
  );
}

function runRefundBatch(db, options) {
  const marker = taskRefundMarker(
    options.taskId,
    options.from,
    options.to,
    options.kind,
    options.now,
  );
  const casChanges = db.prepare(
    `
    UPDATE tasks
    SET status = ?1, fail_reason = ?2, progress = ?3,
        private_data = json_set(
          CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
          '$.result_url',
          ?4,
          '$.task_refund_marker',
          ?11,
          '$.task_refund_done_at',
          NULL
        ),
        data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
        finish_time = ?7, updated_at = ?8
    WHERE id = ?9 AND status = ?10
    `,
  ).run(
    options.to,
    options.failReason,
    "100%",
    "",
    "",
    0,
    options.now,
    options.now,
    options.taskId,
    options.from,
    marker,
  ).changes;
  const refundChanges = runRefundCreditOnly(db, { ...options, marker });
  const doneChanges = db.prepare(
    `
    UPDATE tasks
    SET private_data = json_set(
      CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
      '$.task_refund_done_at',
      ?1
    )
    WHERE id = ?2
      AND json_extract(
        CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
        '$.task_refund_marker'
      ) = ?3
      AND json_extract(
        CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
        '$.task_refund_done_at'
      ) IS NULL
    `,
  ).run(options.now, options.taskId, marker).changes;

  if (casChanges === 1 && doneChanges !== 1) {
    throw new Error("task refund batch won CAS but did not mark refund done");
  }

  return {
    marker,
    won: casChanges === 1,
    casChanges,
    userChanges: refundChanges.userChanges,
    tokenChanges: refundChanges.tokenChanges,
    doneChanges,
  };
}

function runRefundCreditOnly(db, options) {
  const userChanges = db.prepare(
    `
    UPDATE users
    SET quota = quota + ?1
    WHERE id = ?2
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE id = ?3
          AND json_extract(
            CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
            '$.task_refund_marker'
          ) = ?4
          AND json_extract(
            CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
            '$.task_refund_done_at'
          ) IS NULL
      )
    `,
  ).run(options.quota, options.userId, options.taskId, options.marker).changes;
  const tokenChanges = options.tokenId > 0
    ? db.prepare(
      `
      UPDATE tokens
      SET remain_quota = remain_quota + ?1,
          used_quota = MAX(used_quota - ?1, 0),
          accessed_time = ?2
      WHERE id = ?3
        AND EXISTS (
          SELECT 1 FROM tasks
          WHERE id = ?4
            AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_marker'
            ) = ?5
            AND json_extract(
              CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
              '$.task_refund_done_at'
            ) IS NULL
        )
      `,
    ).run(options.quota, options.now, options.tokenId, options.taskId, options.marker).changes
    : 0;
  return { userChanges, tokenChanges };
}

function runStatusCasWithoutRefund(db, options) {
  const changes = db.prepare(
    `
    UPDATE tasks
    SET status = ?1, fail_reason = ?2, progress = ?3,
        private_data = json_set(
          CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END,
          '$.result_url',
          ?4
        ),
        data = CASE WHEN ?6 = 1 THEN ?5 ELSE data END,
        finish_time = ?7, updated_at = ?8
    WHERE id = ?9 AND status = ?10
    `,
  ).run(
    options.to,
    options.failReason,
    "100%",
    "",
    "",
    0,
    options.now,
    options.now,
    options.taskId,
    options.from,
  ).changes;
  return { won: changes === 1, changes };
}

function refundSnapshot(db, userId, tokenId, taskId) {
  const user = db.prepare("SELECT quota FROM users WHERE id = ?1").get(userId);
  const token = db.prepare(
    "SELECT remain_quota, used_quota, accessed_time FROM tokens WHERE id = ?1",
  ).get(tokenId);
  const task = db.prepare(
    `
    SELECT status, private_data,
           json_extract(CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END, '$.task_refund_marker') AS marker,
           json_extract(CASE WHEN json_valid(private_data) THEN private_data ELSE '{}' END, '$.task_refund_done_at') AS done_at
    FROM tasks
    WHERE id = ?1
    `,
  ).get(taskId);
  return {
    userQuota: Number(user.quota),
    tokenRemainQuota: Number(token.remain_quota),
    tokenUsedQuota: Number(token.used_quota),
    tokenAccessedTime: Number(token.accessed_time),
    taskStatus: task.status,
    taskPrivateData: task.private_data,
    taskRefundMarker: task.marker ?? null,
    taskRefundDoneAt: task.done_at ?? null,
  };
}

function findTimedOutUnfinishedTasks(db, cutoffUnix, limit) {
  return db.prepare(
    `
    SELECT id, task_id, upstream_task_id, user_id, channel_id,
           COALESCE(json_extract(private_data, '$.token_id'), 0) AS token_id,
           quota, status, submit_time
    FROM tasks
    WHERE progress != '100%'
      AND status NOT IN ('SUCCESS', 'FAILURE')
      AND submit_time < ?1
    ORDER BY submit_time ASC
    LIMIT ?2
    `,
  ).all(cutoffUnix, limit);
}

function findUnfinishedTasks(db, limit) {
  return db.prepare(
    `
    SELECT id, task_id, upstream_task_id, user_id, channel_id,
           COALESCE(json_extract(private_data, '$.token_id'), 0) AS token_id,
           quota, status, submit_time
    FROM tasks
    WHERE status NOT IN ('SUCCESS', 'FAILURE')
      AND upstream_task_id != ''
    ORDER BY id ASC
    LIMIT ?1
    `,
  ).all(limit);
}

function taskRefundMarker(taskId, from, to, kind, now) {
  return `task-refund:${kind}:${taskId}:${from}:${to}:${now}`;
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
