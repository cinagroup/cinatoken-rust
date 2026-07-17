import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM_DRAIN_FLOOR_SECONDS = 86_400;
const MIGRATION_0045 = "0045_relay_container_reconciliation_retry_apply.sql";
const MIGRATION_0046 = "0046_relay_container_financial_terminal_enforce.sql";
const ENFORCEMENT_TRIGGER_NAMES = [
  "relay_container_operation_v1_identity_insert_guard",
  "relay_container_operation_v1_initial_state_insert_guard",
  "relay_container_operation_terminal_event_guard",
  "relay_container_terminal_event_revision_predecessor_guard",
];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localMigrationNames = readdirSync(path.join(repoRoot, "migrations", "d1"))
  .filter((name) => /^[0-9]{4}_[A-Za-z0-9_]+\.sql$/.test(name))
  .sort();
const enforcementMigrationIndex = localMigrationNames.indexOf(MIGRATION_0046);
if (enforcementMigrationIndex < 0) {
  throw new Error(`local D1 migration set must contain ${MIGRATION_0046}`);
}
// This audit proves the historical 0046 rollout set even when later migrations
// are present in the checkout.
const expectedMigrationNames = localMigrationNames.slice(
  0,
  enforcementMigrationIndex + 1,
);
if (expectedMigrationNames.at(-2) !== MIGRATION_0045) {
  throw new Error(`${MIGRATION_0045} must immediately precede ${MIGRATION_0046}`);
}
const enforcementMigrationSql = readFileSync(
  path.join(repoRoot, "migrations", "d1", MIGRATION_0046),
  "utf8",
);
const expectedEnforcementTriggerSql = new Map(
  ENFORCEMENT_TRIGGER_NAMES.map((name) => [
    name,
    normalizeTriggerSql(extractTriggerSql(enforcementMigrationSql, name)),
  ]),
);

const options = parseArguments(process.argv.slice(2));

if (options.selfTest) {
  const report = await selfTest();
  printReport(report, options.json);
} else {
  const drainStartedAt = positiveInteger(
    options.drainStartedAt,
    "--drain-started-at",
  );
  const minimumDrainSeconds = positiveInteger(
    options.minimumDrainSeconds,
    "--minimum-drain-seconds",
  );
  if (minimumDrainSeconds < MINIMUM_DRAIN_FLOOR_SECONDS) {
    throw new Error(
      `--minimum-drain-seconds must be at least ${MINIMUM_DRAIN_FLOOR_SECONDS}`,
    );
  }
  const phase = parsePhase(options.phase ?? "pre");
  const sql = buildReadinessSql(drainStartedAt, phase);
  assertReadOnlySql(sql);

  if (options.printSql) {
    process.stdout.write(`${sql}\n`);
  } else {
    const database = boundedToken(options.database, "--database", 1, 128);
    const candidateVersion = boundedToken(
      options.candidateVersion,
      "--candidate-version",
      1,
      128,
    );
    const deploymentInventorySha256 = sha256Token(
      options.deploymentInventorySha256,
      "--deployment-inventory-sha256",
    );
    const wranglerEnv = options.wranglerEnv
      ? boundedToken(options.wranglerEnv, "--wrangler-env", 1, 64)
      : undefined;
    const accountId = cloudflareAccountId(options.accountId, "--account-id");
    const expectedDatabaseId = d1DatabaseId(
      options.databaseId,
      "--database-id",
    );
    const { target, raw } = await withWranglerAuditConfig(
      accountId,
      wranglerEnv,
      async (configPath) => {
        const target = await resolveRemoteDatabaseTarget(
          database,
          wranglerEnv,
          accountId,
          expectedDatabaseId,
          configPath,
        );
        const raw = await executeRemoteRead(
          target.databaseId,
          wranglerEnv,
          accountId,
          sql,
          configPath,
        );
        return { target, raw };
      },
    );
    const row = extractResultRow(raw);
    const report = evaluateReadiness(
      row,
      drainStartedAt,
      minimumDrainSeconds,
      phase,
      candidateVersion,
      deploymentInventorySha256,
      target,
    );
    printReport(report, options.json);
    if (!report.snapshotReady) process.exitCode = 2;
  }
}

function buildReadinessSql(drainStartedAt, phase) {
  const phaseMigrationNames =
    phase === "post"
      ? expectedMigrationNames
      : expectedMigrationNames.filter((name) => name !== MIGRATION_0046);
  const expectedMigrationSql = phaseMigrationNames
    .map((name) => `'${name}'`)
    .join(", ");
  return `WITH operation_contract AS (
  SELECT
    operation.reservation_key,
    operation.operation_id,
    operation.owner_generation,
    operation.protocol_version,
    operation.status,
    operation.created_at,
    operation.updated_at,
    operation.owner_lease_expires_at,
    CASE WHEN
      length(operation.client_idempotency_hmac_sha256) = 64
      AND operation.client_idempotency_hmac_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(operation.client_request_sha256) = 64
      AND operation.client_request_sha256 NOT GLOB '*[^0-9a-f]*'
      AND length(operation.reconciliation_id) = 64
      AND operation.reconciliation_id NOT GLOB '*[^0-9a-f]*'
    THEN 1 ELSE 0 END AS identity_valid,
    CASE WHEN EXISTS (
      SELECT 1
      FROM relay_container_terminal_events AS event
      JOIN relay_container_terminal_outbox_state AS outbox
        ON outbox.billing_event_id = event.billing_event_id
      WHERE event.reservation_key = operation.reservation_key
        AND event.operation_id = operation.operation_id
        AND event.owner_generation = operation.owner_generation
        AND event.operation_status = operation.status
        AND event.reconciliation_id = operation.reconciliation_id
        AND (
          (
            event.operation_from_status IN ('prepared', 'dispatched')
            AND event.reconciliation_revision = 1
          )
          OR (
            event.operation_from_status = 'recovery_required'
            AND event.reconciliation_revision = 2
          )
        )
        AND event.created_at <= operation.updated_at
        AND outbox.created_at = event.created_at
    ) THEN 1 ELSE 0 END AS terminal_event_present
  FROM relay_container_operations AS operation
),
operation_facts AS (
  SELECT
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND created_at >= ${drainStartedAt}
        AND identity_valid = 0
      THEN 1 ELSE 0 END), 0) AS new_legacy_identity_rows,
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND created_at >= ${drainStartedAt}
        AND status <> 'prepared'
        AND updated_at = created_at
      THEN 1 ELSE 0 END), 0) AS suspected_direct_non_prepared_rows,
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND status IN ('prepared', 'dispatched', 'recovery_required')
        AND identity_valid = 0
      THEN 1 ELSE 0 END), 0) AS active_legacy_identity_rows,
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND status IN ('prepared', 'dispatched', 'recovery_required')
      THEN 1 ELSE 0 END), 0) AS open_operation_rows,
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND created_at < ${drainStartedAt}
        AND status IN ('prepared', 'dispatched', 'recovery_required')
      THEN 1 ELSE 0 END), 0) AS pre_drain_open_operation_rows,
    COALESCE(SUM(CASE
      WHEN protocol_version = 1
        AND updated_at >= ${drainStartedAt}
        AND status IN ('completed', 'failed', 'recovery_required')
        AND terminal_event_present = 0
      THEN 1 ELSE 0 END), 0) AS recent_eventless_terminal_rows,
    COALESCE(MAX(CASE
      WHEN protocol_version = 1 AND identity_valid = 0 THEN created_at
      ELSE 0 END), 0) AS latest_legacy_identity_created_at,
    COALESCE(MAX(CASE
      WHEN protocol_version = 1
        AND status IN ('completed', 'failed', 'recovery_required')
        AND terminal_event_present = 0
      THEN updated_at ELSE 0 END), 0) AS latest_eventless_terminal_updated_at,
    COALESCE(MAX(CASE
      WHEN status IN ('prepared', 'dispatched', 'recovery_required')
      THEN owner_lease_expires_at ELSE 0 END), 0)
      AS latest_open_operation_lease_expires_at,
    COALESCE(MAX(CASE
      WHEN protocol_version = 1
        AND created_at < ${drainStartedAt}
        AND status IN ('prepared', 'dispatched', 'recovery_required')
      THEN owner_lease_expires_at ELSE 0 END), 0)
      AS latest_pre_drain_open_operation_lease_expires_at
  FROM operation_contract
),
event_facts AS (
  SELECT
    COALESCE(SUM(CASE
    WHEN successor.reconciliation_revision = 2
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_terminal_events AS predecessor
        WHERE predecessor.reservation_key = successor.reservation_key
          AND predecessor.operation_id = successor.operation_id
          AND predecessor.owner_generation = successor.owner_generation
          AND predecessor.operation_from_status IN ('prepared', 'dispatched')
          AND predecessor.operation_status = 'recovery_required'
          AND predecessor.billing_action = 'recovery_required'
          AND predecessor.billing_owner_generation = predecessor.owner_generation
          AND predecessor.billing_from_status = 'reserved'
          AND predecessor.reconciliation_id = successor.reconciliation_id
          AND predecessor.reconciliation_revision = 1
          AND predecessor.billing_owner_generation + 1 =
            successor.billing_owner_generation
          AND predecessor.created_at <= successor.created_at
      )
    THEN 1 ELSE 0 END), 0) AS revision_2_without_predecessor_rows,
    COALESCE(SUM(CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM relay_container_terminal_outbox_state AS outbox
        WHERE outbox.billing_event_id = successor.billing_event_id
          AND outbox.created_at = successor.created_at
      )
      THEN 1 ELSE 0 END), 0) AS terminal_events_without_outbox_rows
  FROM relay_container_terminal_events AS successor
)
SELECT
  1 AS contract_version,
  ${drainStartedAt} AS drain_started_at,
  unixepoch() AS observed_at,
  (SELECT COUNT(1) FROM d1_migrations WHERE name = '${MIGRATION_0045}')
    AS migration_0045_applied,
  (SELECT COUNT(1) FROM d1_migrations WHERE name = '${MIGRATION_0046}')
    AS migration_0046_applied,
  (SELECT COUNT(1) FROM d1_migrations) AS migration_row_count,
  (SELECT COUNT(DISTINCT name) FROM d1_migrations WHERE name IN (${expectedMigrationSql}))
    AS expected_migration_row_count,
  (SELECT COUNT(1) FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN (
        'relay_container_operation_v1_identity_insert_guard',
        'relay_container_operation_v1_initial_state_insert_guard',
        'relay_container_operation_terminal_event_guard',
        'relay_container_terminal_event_revision_predecessor_guard'
      )) AS enforcement_trigger_count,
  (SELECT COALESCE(
      json_group_array(json_object('name', trigger.name, 'sql', trigger.sql)),
      '[]'
    )
    FROM (
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'relay_container_operation_v1_identity_insert_guard',
          'relay_container_operation_v1_initial_state_insert_guard',
          'relay_container_operation_terminal_event_guard',
          'relay_container_terminal_event_revision_predecessor_guard'
        )
      ORDER BY name
    ) AS trigger) AS enforcement_trigger_sql_json,
  operation_facts.new_legacy_identity_rows,
  operation_facts.suspected_direct_non_prepared_rows,
  operation_facts.active_legacy_identity_rows,
  operation_facts.open_operation_rows,
  operation_facts.pre_drain_open_operation_rows,
  operation_facts.recent_eventless_terminal_rows,
  event_facts.revision_2_without_predecessor_rows,
  event_facts.terminal_events_without_outbox_rows,
  operation_facts.latest_legacy_identity_created_at,
  operation_facts.latest_eventless_terminal_updated_at,
  operation_facts.latest_open_operation_lease_expires_at,
  operation_facts.latest_pre_drain_open_operation_lease_expires_at
FROM operation_facts
CROSS JOIN event_facts;`;
}

function evaluateReadiness(
  row,
  drainStartedAt,
  minimumDrainSeconds,
  phase,
  candidateVersion,
  deploymentInventorySha256,
  target,
) {
  const normalizedTarget = readinessTarget(target);
  const numericFields = [
    "contract_version",
    "drain_started_at",
    "observed_at",
    "migration_0045_applied",
    "migration_0046_applied",
    "migration_row_count",
    "expected_migration_row_count",
    "enforcement_trigger_count",
    "new_legacy_identity_rows",
    "suspected_direct_non_prepared_rows",
    "active_legacy_identity_rows",
    "open_operation_rows",
    "pre_drain_open_operation_rows",
    "recent_eventless_terminal_rows",
    "revision_2_without_predecessor_rows",
    "terminal_events_without_outbox_rows",
    "latest_legacy_identity_created_at",
    "latest_eventless_terminal_updated_at",
    "latest_open_operation_lease_expires_at",
    "latest_pre_drain_open_operation_lease_expires_at",
  ];
  const normalized = {};
  for (const field of numericFields) {
    normalized[field] = strictNonNegativeInteger(row[field], field);
  }

  const drainWindowSeconds = normalized.observed_at - drainStartedAt;
  const expectedMigrationCount =
    phase === "post"
      ? expectedMigrationNames.length
      : expectedMigrationNames.length - 1;
  const expectedTriggerCount =
    phase === "post" ? ENFORCEMENT_TRIGGER_NAMES.length : 0;
  const triggerBodiesExact = enforcementTriggerBodiesMatch(
    row.enforcement_trigger_sql_json,
    phase,
  );
  const checks = {
    contract_version: normalized.contract_version === 1,
    drain_boundary: normalized.drain_started_at === drainStartedAt,
    drain_window:
      drainWindowSeconds >= minimumDrainSeconds && drainWindowSeconds >= 0,
    expand_head_applied: normalized.migration_0045_applied === 1,
    enforcement_marker:
      normalized.migration_0046_applied === (phase === "post" ? 1 : 0),
    exact_migration_set:
      normalized.migration_row_count === expectedMigrationCount &&
      normalized.expected_migration_row_count === expectedMigrationCount,
    enforcement_trigger_set:
      normalized.enforcement_trigger_count === expectedTriggerCount,
    enforcement_trigger_bodies: triggerBodiesExact,
    no_new_legacy_identity: normalized.new_legacy_identity_rows === 0,
    no_suspected_direct_non_prepared:
      normalized.suspected_direct_non_prepared_rows === 0,
    no_active_legacy_identity: normalized.active_legacy_identity_rows === 0,
    no_open_operations: normalized.open_operation_rows === 0,
    no_pre_drain_open_operations:
      normalized.pre_drain_open_operation_rows === 0,
    no_recent_eventless_terminal:
      normalized.recent_eventless_terminal_rows === 0,
    revision_2_chain_complete:
      normalized.revision_2_without_predecessor_rows === 0,
    every_terminal_event_has_outbox:
      normalized.terminal_events_without_outbox_rows === 0,
  };

  return {
    ok: true,
    snapshotReady: Object.values(checks).every(Boolean),
    authorizesEnforcement: false,
    scope: "single_d1_snapshot_only",
    continuousDrainEvidenceVerified: false,
    phase,
    candidateVersion,
    candidateVersionEvidence:
      "unverified_operator_claim_bound_by_inventory_digest_only",
    deploymentInventorySha256,
    target: normalizedTarget,
    drainStartedAt,
    observedAt: normalized.observed_at,
    minimumDrainSeconds,
    drainWindowSeconds,
    checks,
    counts: {
      newLegacyIdentityRows: normalized.new_legacy_identity_rows,
      suspectedDirectNonPreparedRows:
        normalized.suspected_direct_non_prepared_rows,
      activeLegacyIdentityRows: normalized.active_legacy_identity_rows,
      openOperationRows: normalized.open_operation_rows,
      preDrainOpenOperationRows: normalized.pre_drain_open_operation_rows,
      recentEventlessTerminalRows: normalized.recent_eventless_terminal_rows,
      revision2WithoutPredecessorRows:
        normalized.revision_2_without_predecessor_rows,
      terminalEventsWithoutOutboxRows:
        normalized.terminal_events_without_outbox_rows,
    },
    evidenceTimestamps: {
      latestLegacyIdentityCreatedAt:
        normalized.latest_legacy_identity_created_at,
      latestEventlessTerminalUpdatedAt:
        normalized.latest_eventless_terminal_updated_at,
      latestOpenOperationLeaseExpiresAt:
        normalized.latest_open_operation_lease_expires_at,
      latestPreDrainOpenOperationLeaseExpiresAt:
        normalized.latest_pre_drain_open_operation_lease_expires_at,
    },
    migrations: {
      expand: normalized.migration_0045_applied,
      enforcement: normalized.migration_0046_applied,
      rows: normalized.migration_row_count,
      expectedRows: expectedMigrationCount,
      matchingExpectedRows: normalized.expected_migration_row_count,
      enforcementTriggers: normalized.enforcement_trigger_count,
      enforcementTriggerBodiesExact: triggerBodiesExact,
    },
    externalEvidenceRequired: [
      "signed_deployment_and_worker_version_inventory",
      "continuous_old_writer_absence_observation_from_drain_start",
      "computed_old_writer_lifecycle_upper_bound",
      "exact_trigger_sql_readback",
      "pre_apply_disaster_recovery_time_travel_bookmark",
      "all_d1_writer_freeze_and_full_application_data_fingerprint",
    ],
  };
}

async function resolveRemoteDatabaseTarget(
  database,
  wranglerEnv,
  accountId,
  expectedDatabaseId,
  configPath,
) {
  const args = d1InfoArgs(database, wranglerEnv, configPath);
  const info = await executeWranglerJson(args, accountId, "D1 target readback");
  return resolvedDatabaseTarget(
    info,
    database,
    wranglerEnv,
    accountId,
    expectedDatabaseId,
  );
}

function resolvedDatabaseTarget(
  info,
  database,
  wranglerEnv,
  accountId,
  expectedDatabaseId,
) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new Error("wrangler D1 target readback must return one JSON object");
  }
  const databaseId = d1DatabaseId(info.uuid, "wrangler D1 UUID");
  if (databaseId !== expectedDatabaseId) {
    throw new Error(
      `wrangler D1 UUID mismatch: expected ${expectedDatabaseId}, received ${databaseId}`,
    );
  }
  return readinessTarget({
    accountId,
    databaseArgument: database,
    databaseId,
    databaseName: boundedEvidenceText(info.name, "wrangler D1 name", 1, 128),
    wranglerEnv: wranglerEnv ?? null,
  });
}

async function executeRemoteRead(
  databaseId,
  wranglerEnv,
  accountId,
  sql,
  configPath,
) {
  const args = d1ReadArgs(databaseId, wranglerEnv, configPath, sql);
  return executeWranglerJson(args, accountId, "D1 readiness read");
}

function d1InfoArgs(database, wranglerEnv, configPath) {
  const args = ["d1", "info", database];
  if (wranglerEnv) args.push("--env", wranglerEnv);
  args.push("--config", configPath, "--json");
  return args;
}

function d1ReadArgs(databaseId, wranglerEnv, configPath, sql) {
  const args = ["d1", "execute", databaseId, "--remote"];
  if (wranglerEnv) args.push("--env", wranglerEnv);
  args.push("--config", configPath, "--command", sql, "--json");
  return args;
}

async function withWranglerAuditConfig(accountId, wranglerEnv, callback) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-d1-readiness-audit-"),
  );
  const configPath = path.join(directory, "wrangler.toml");
  const config = wranglerAuditConfigText(accountId, wranglerEnv);
  await writeFile(configPath, config, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    return await callback(configPath);
  } finally {
    await unlink(configPath).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

function wranglerAuditConfigText(accountId, wranglerEnv) {
  const environmentConfig = wranglerEnv
    ? `\n[env."${wranglerEnv}"]\naccount_id = "${accountId}"\n`
    : "";
  return (
    `name = "cinatoken-rust-d1-readiness-audit"\n` +
    `compatibility_date = "2026-07-17"\n` +
    `account_id = "${accountId}"\n` +
    environmentConfig
  );
}

async function executeWranglerJson(
  args,
  accountId,
  label,
  wranglerEntry = path.join(
    repoRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  ),
) {
  const command = [process.execPath, wranglerEntry, ...args];

  const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
  if (exitCode !== 0) {
    throw new Error(
      `wrangler ${label} failed (${exitCode}): ${stderr.trim().slice(0, 2000)}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`wrangler ${label} returned invalid JSON: ${error.message}`);
  }
}

function extractResultRow(payload) {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const envelope = envelopes.find(
    (value) => value && typeof value === "object" && Array.isArray(value.results),
  );
  if (!envelope || envelope.success !== true || envelope.results.length !== 1) {
    throw new Error("wrangler D1 readiness read must return exactly one successful row");
  }
  return envelope.results[0];
}

function assertReadOnlySql(sql) {
  if (!/^WITH\s/i.test(sql) || !/\bSELECT\b/i.test(sql)) {
    throw new Error("readiness audit must be a SELECT query");
  }
  const forbidden = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|PRAGMA|ATTACH|DETACH)\b/i;
  if (forbidden.test(sql)) {
    throw new Error("readiness audit SQL contains a mutating statement");
  }
}

async function openSqliteSelfTestDatabase() {
  if (process.versions?.bun) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(":memory:", { create: true });
    return {
      exec: (sql) => database.exec(sql),
      get: (sql, ...values) => database.query(sql).get(...values),
      run: (sql, ...values) => database.query(sql).run(...values),
      close: () => database.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  return {
    exec: (sql) => database.exec(sql),
    get: (sql, ...values) => database.prepare(sql).get(...values),
    run: (sql, ...values) => database.prepare(sql).run(...values),
    close: () => database.close(),
  };
}

async function readinessSqlIntegrationRows(drainStartedAt) {
  const database = await openSqliteSelfTestDatabase();
  try {
    database.exec(`
      CREATE TABLE d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const applyMigration = (name) => {
      database.exec(
        readFileSync(path.join(repoRoot, "migrations", "d1", name), "utf8"),
      );
      database.run("INSERT INTO d1_migrations (name) VALUES (?)", name);
    };
    for (const name of expectedMigrationNames) {
      if (name === MIGRATION_0046) continue;
      applyMigration(name);
    }
    const pre = database.get(buildReadinessSql(drainStartedAt, "pre"));
    applyMigration(MIGRATION_0046);
    const post = database.get(buildReadinessSql(drainStartedAt, "post"));
    return { pre, post };
  } finally {
    database.close();
  }
}

async function selfTest() {
  const drainStartedAt = 1_000_000;
  const selfTestTarget = {
    accountId: "b".repeat(32),
    databaseArgument: "self-test-db",
    databaseId: "11111111-1111-4111-8111-111111111111",
    databaseName: "self-test-db",
    wranglerEnv: "self-test",
  };
  const resolvedTarget = resolvedDatabaseTarget(
    { uuid: selfTestTarget.databaseId, name: selfTestTarget.databaseName },
    selfTestTarget.databaseArgument,
    selfTestTarget.wranglerEnv,
    selfTestTarget.accountId,
    selfTestTarget.databaseId,
  );
  let targetMismatchRejected = false;
  try {
    resolvedDatabaseTarget(
      { uuid: "22222222-2222-4222-8222-222222222222", name: "other-db" },
      selfTestTarget.databaseArgument,
      selfTestTarget.wranglerEnv,
      selfTestTarget.accountId,
      selfTestTarget.databaseId,
    );
  } catch {
    targetMismatchRejected = true;
  }
  if (
    resolvedTarget.databaseId !== selfTestTarget.databaseId ||
    !targetMismatchRejected
  ) {
    throw new Error("D1 target UUID binding self-test failed");
  }
  const expectedAccountBinding = `account_id = "${selfTestTarget.accountId}"`;
  const environmentBinding = `[env."${selfTestTarget.wranglerEnv}"]`;
  const auditConfig = wranglerAuditConfigText(
    selfTestTarget.accountId,
    selfTestTarget.wranglerEnv,
  );
  const rootOnlyAuditConfig = wranglerAuditConfigText(
    selfTestTarget.accountId,
    undefined,
  );
  if (
    auditConfig.split(expectedAccountBinding).length !== 3 ||
    !auditConfig.includes(environmentBinding) ||
    rootOnlyAuditConfig.split(expectedAccountBinding).length !== 2 ||
    rootOnlyAuditConfig.includes("[env.")
  ) {
    throw new Error("temporary Wrangler account binding self-test failed");
  }
  let temporaryConfigPath;
  await withWranglerAuditConfig(
    selfTestTarget.accountId,
    selfTestTarget.wranglerEnv,
    async (configPath) => {
      temporaryConfigPath = configPath;
      if ((await readFile(configPath, "utf8")) !== auditConfig) {
        throw new Error("temporary Wrangler config on disk is not account-bound");
      }
    },
  );
  let temporaryConfigRemoved = false;
  try {
    await access(temporaryConfigPath);
  } catch {
    temporaryConfigRemoved = true;
  }
  if (!temporaryConfigRemoved) {
    throw new Error("temporary Wrangler config was not removed");
  }
  const selfTestConfigPath = path.join("self-test", "wrangler.toml");
  const infoArgs = d1InfoArgs(
    selfTestTarget.databaseArgument,
    selfTestTarget.wranglerEnv,
    selfTestConfigPath,
  );
  const readArgs = d1ReadArgs(
    selfTestTarget.databaseId,
    selfTestTarget.wranglerEnv,
    selfTestConfigPath,
    "SELECT 1",
  );
  if (
    infoArgs[2] !== selfTestTarget.databaseArgument ||
    !infoArgs.includes(selfTestConfigPath) ||
    readArgs[2] !== selfTestTarget.databaseId ||
    !readArgs.includes("--remote") ||
    !readArgs.includes(selfTestConfigPath) ||
    readArgs.includes(selfTestTarget.databaseArgument)
  ) {
    throw new Error("Wrangler target argument binding self-test failed");
  }
  const spawnFixtureDirectory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-wrangler-spawn-self-test-"),
  );
  const spawnFixturePath = path.join(spawnFixtureDirectory, "fixture.mjs");
  let wranglerSpawnEnvelopeVerified = false;
  try {
    await writeFile(
      spawnFixturePath,
      "process.stdout.write(JSON.stringify({ accountId: " +
        "process.env.CLOUDFLARE_ACCOUNT_ID, args: process.argv.slice(2) }));\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const fixtureArgs = ["d1", "execute", selfTestTarget.databaseId, "--remote"];
    const fixtureResult = await executeWranglerJson(
      fixtureArgs,
      selfTestTarget.accountId,
      "spawn self-test",
      spawnFixturePath,
    );
    wranglerSpawnEnvelopeVerified =
      fixtureResult.accountId === selfTestTarget.accountId &&
      JSON.stringify(fixtureResult.args) === JSON.stringify(fixtureArgs);
  } finally {
    await unlink(spawnFixturePath).catch(() => {});
    await rmdir(spawnFixtureDirectory).catch(() => {});
  }
  if (!wranglerSpawnEnvelopeVerified) {
    throw new Error("Wrangler spawn/JSON envelope self-test failed");
  }
  const evaluateFixture = (row, phase = "pre") =>
    evaluateReadiness(
      row,
      drainStartedAt,
      MINIMUM_DRAIN_FLOOR_SECONDS,
      phase,
      "self-test-version",
      "a".repeat(64),
      selfTestTarget,
    );
  assertReadOnlySql(buildReadinessSql(drainStartedAt, "pre"));
  assertReadOnlySql(buildReadinessSql(drainStartedAt, "post"));
  const clean = {
    contract_version: 1,
    drain_started_at: drainStartedAt,
    observed_at: drainStartedAt + MINIMUM_DRAIN_FLOOR_SECONDS,
    migration_0045_applied: 1,
    migration_0046_applied: 0,
    migration_row_count: expectedMigrationNames.length - 1,
    expected_migration_row_count: expectedMigrationNames.length - 1,
    enforcement_trigger_count: 0,
    enforcement_trigger_sql_json: "[]",
    new_legacy_identity_rows: 0,
    suspected_direct_non_prepared_rows: 0,
    active_legacy_identity_rows: 0,
    open_operation_rows: 0,
    pre_drain_open_operation_rows: 0,
    recent_eventless_terminal_rows: 0,
    revision_2_without_predecessor_rows: 0,
    terminal_events_without_outbox_rows: 0,
    latest_legacy_identity_created_at: 0,
    latest_eventless_terminal_updated_at: 0,
    latest_open_operation_lease_expires_at: 0,
    latest_pre_drain_open_operation_lease_expires_at: 0,
  };
  const pre = evaluateFixture(clean);
  if (!pre.snapshotReady) {
    throw new Error("clean pre-enforcement fixture was not snapshot-ready");
  }

  const post = evaluateFixture(
    {
      ...clean,
      migration_0046_applied: 1,
      migration_row_count: expectedMigrationNames.length,
      expected_migration_row_count: expectedMigrationNames.length,
      enforcement_trigger_count: 4,
      enforcement_trigger_sql_json: expectedTriggerRowsJson(),
    },
    "post",
  );
  if (!post.snapshotReady) {
    throw new Error("clean post-enforcement fixture was not snapshot-ready");
  }
  const integrationRows = await readinessSqlIntegrationRows(drainStartedAt);
  const integrationPre = evaluateFixture(integrationRows.pre, "pre");
  const integrationPost = evaluateFixture(integrationRows.post, "post");
  if (!integrationPre.snapshotReady || !integrationPost.snapshotReady) {
    throw new Error("real migration/readiness SQL integration self-test failed");
  }

  const blocked = evaluateFixture(
    { ...clean, active_legacy_identity_rows: 1 },
  );
  if (blocked.snapshotReady || blocked.checks.no_active_legacy_identity) {
    throw new Error("legacy-identity fixture did not block enforcement readiness");
  }

  const oldOpen = evaluateFixture(
    {
      ...clean,
      open_operation_rows: 1,
      pre_drain_open_operation_rows: 1,
      latest_pre_drain_open_operation_lease_expires_at:
        drainStartedAt + MINIMUM_DRAIN_FLOOR_SECONDS,
    },
  );
  if (
    oldOpen.snapshotReady ||
    oldOpen.checks.no_pre_drain_open_operations
  ) {
    throw new Error("pre-candidate open operation did not block readiness");
  }

  const candidateOpen = evaluateFixture(
    { ...clean, open_operation_rows: 1 },
  );
  if (candidateOpen.snapshotReady || candidateOpen.checks.no_open_operations) {
    throw new Error("post-candidate open operation did not block readiness");
  }

  const directInsert = evaluateFixture(
    { ...clean, suspected_direct_non_prepared_rows: 1 },
  );
  if (
    directInsert.snapshotReady ||
    directInsert.checks.no_suspected_direct_non_prepared
  ) {
    throw new Error("suspected direct non-prepared insert did not block readiness");
  }

  const newLegacy = evaluateFixture({ ...clean, new_legacy_identity_rows: 1 });
  if (newLegacy.snapshotReady || newLegacy.checks.no_new_legacy_identity) {
    throw new Error("new legacy-identity fixture did not block readiness");
  }

  const eventless = evaluateFixture({ ...clean, recent_eventless_terminal_rows: 1 });
  if (eventless.snapshotReady || eventless.checks.no_recent_eventless_terminal) {
    throw new Error("eventless terminal fixture did not block readiness");
  }

  const predecessorGap = evaluateFixture({
    ...clean,
    revision_2_without_predecessor_rows: 1,
  });
  if (
    predecessorGap.snapshotReady ||
    predecessorGap.checks.revision_2_chain_complete
  ) {
    throw new Error("revision-2 predecessor gap did not block readiness");
  }

  const outboxGap = evaluateFixture({
    ...clean,
    terminal_events_without_outbox_rows: 1,
  });
  if (
    outboxGap.snapshotReady ||
    outboxGap.checks.every_terminal_event_has_outbox
  ) {
    throw new Error("terminal event without outbox did not block readiness");
  }

  const shortDrain = evaluateFixture({
    ...clean,
    observed_at: drainStartedAt + MINIMUM_DRAIN_FLOOR_SECONDS - 1,
  });
  if (shortDrain.snapshotReady || shortDrain.checks.drain_window) {
    throw new Error("short drain window did not block readiness");
  }

  const migrationDrift = evaluateFixture(
    { ...clean, expected_migration_row_count: expectedMigrationNames.length - 2 },
  );
  if (
    migrationDrift.snapshotReady ||
    migrationDrift.checks.exact_migration_set
  ) {
    throw new Error("migration-set drift did not block readiness");
  }

  const triggerDrift = evaluateFixture(
    { ...clean, enforcement_trigger_count: 1 },
  );
  if (triggerDrift.snapshotReady || triggerDrift.checks.enforcement_trigger_set) {
    throw new Error("trigger-set drift did not block readiness");
  }

  const bodyDriftRows = JSON.parse(expectedTriggerRowsJson());
  bodyDriftRows[0].sql += " SELECT 1";
  const bodyDrift = evaluateFixture(
    {
      ...clean,
      migration_0046_applied: 1,
      migration_row_count: expectedMigrationNames.length,
      expected_migration_row_count: expectedMigrationNames.length,
      enforcement_trigger_count: 4,
      enforcement_trigger_sql_json: JSON.stringify(bodyDriftRows),
    },
    "post",
  );
  if (bodyDrift.snapshotReady || bodyDrift.checks.enforcement_trigger_bodies) {
    throw new Error("trigger-body drift did not block readiness");
  }

  let nonCanonicalNumericRejected = false;
  try {
    evaluateFixture({ ...clean, open_operation_rows: null });
  } catch {
    nonCanonicalNumericRejected = true;
  }
  if (!nonCanonicalNumericRejected) {
    throw new Error("non-canonical numeric D1 field was accepted");
  }

  const literalDoubleSpace =
    "CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT RAISE(ABORT, 'a  b'); END;";
  const literalSingleSpace =
    "CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT RAISE(ABORT, 'a b'); END;";
  if (normalizeTriggerSql(literalDoubleSpace) === normalizeTriggerSql(literalSingleSpace)) {
    throw new Error("trigger normalization changed quoted string whitespace");
  }

  const parsed = extractResultRow([{ success: true, results: [clean] }]);
  if (parsed !== clean) throw new Error("wrangler result extraction changed the row");
  let missingSuccessRejected = false;
  try {
    extractResultRow([{ results: [clean] }]);
  } catch {
    missingSuccessRejected = true;
  }
  if (!missingSuccessRejected) {
    throw new Error("wrangler envelope without success=true was accepted");
  }
  return {
    ok: true,
    selfTest: true,
    contractVersion: 1,
    minimumDrainSeconds: MINIMUM_DRAIN_FLOOR_SECONDS,
    readOnlySql: true,
    preSnapshotReady: pre.snapshotReady,
    postSnapshotReady: post.snapshotReady,
    neverAuthorizesEnforcement:
      pre.authorizesEnforcement === false &&
      post.authorizesEnforcement === false,
    legacyFixtureBlocked: !blocked.snapshotReady,
    oldOpenFixtureBlocked: !oldOpen.snapshotReady,
    candidateOpenFixtureBlocked: !candidateOpen.snapshotReady,
    directInsertFixtureBlocked: !directInsert.snapshotReady,
    newLegacyFixtureBlocked: !newLegacy.snapshotReady,
    eventlessFixtureBlocked: !eventless.snapshotReady,
    predecessorGapFixtureBlocked: !predecessorGap.snapshotReady,
    outboxGapFixtureBlocked: !outboxGap.snapshotReady,
    shortDrainFixtureBlocked: !shortDrain.snapshotReady,
    migrationDriftFixtureBlocked: !migrationDrift.snapshotReady,
    triggerDriftFixtureBlocked: !triggerDrift.snapshotReady,
    triggerBodyDriftFixtureBlocked: !bodyDrift.snapshotReady,
    targetBound:
      pre.target.accountId === selfTestTarget.accountId &&
      pre.target.databaseId === selfTestTarget.databaseId,
    auditConfigAccountBound: true,
    temporaryConfigLifecycleVerified: temporaryConfigRemoved,
    wranglerArgumentBindingVerified: true,
    wranglerSpawnEnvelopeVerified,
    preSqlIntegrationSnapshotReady: integrationPre.snapshotReady,
    postSqlIntegrationSnapshotReady: integrationPost.snapshotReady,
    targetMismatchRejected,
    nonCanonicalNumericRejected,
    missingSuccessRejected,
    literalWhitespacePreserved: true,
  };
}

function extractTriggerSql(source, name) {
  const start = source.indexOf(`CREATE TRIGGER ${name}`);
  const nextTrigger = source.indexOf("CREATE TRIGGER ", start + 1);
  const boundary = nextTrigger < 0 ? source.length : nextTrigger;
  const statement = start < 0 ? "" : source.slice(start, boundary);
  const relativeEnd = statement.lastIndexOf("\nEND;");
  if (start < 0 || relativeEnd < 0) {
    throw new Error(`0046 migration does not contain exact trigger ${name}`);
  }
  return statement.slice(0, relativeEnd + "\nEND;".length);
}

function normalizeTriggerSql(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new Error("enforcement trigger SQL is missing");
  }
  let input = sql.trim();
  if (input.endsWith(";")) input = input.slice(0, -1).trimEnd();
  let normalized = "";
  let quoteEnd = null;
  let pendingSpace = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoteEnd !== null) {
      normalized += character;
      if (character === quoteEnd) {
        if (quoteEnd !== "]" && input[index + 1] === quoteEnd) {
          normalized += input[++index];
        } else {
          quoteEnd = null;
        }
      }
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    pendingSpace = false;
    normalized += character;
    if (character === "'" || character === '"' || character === "`") {
      quoteEnd = character;
    } else if (character === "[") {
      quoteEnd = "]";
    }
  }
  if (quoteEnd !== null) throw new Error("enforcement trigger SQL has an open quote");
  return normalized;
}

function expectedTriggerRowsJson() {
  return JSON.stringify(
    [...expectedEnforcementTriggerSql.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, sql]) => ({ name, sql })),
  );
}

function enforcementTriggerBodiesMatch(value, phase) {
  if (typeof value !== "string") {
    throw new Error("D1 enforcement trigger SQL readback is not JSON text");
  }
  let rows;
  try {
    rows = JSON.parse(value);
  } catch (error) {
    throw new Error(`D1 enforcement trigger SQL readback is invalid: ${error.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error("D1 enforcement trigger SQL readback is not an array");
  }
  if (phase === "pre") return rows.length === 0;
  if (rows.length !== ENFORCEMENT_TRIGGER_NAMES.length) return false;

  const actual = new Map();
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string" ||
      actual.has(row.name)
    ) {
      return false;
    }
    actual.set(row.name, normalizeTriggerSql(row.sql));
  }
  return ENFORCEMENT_TRIGGER_NAMES.every(
    (name) => actual.get(name) === expectedEnforcementTriggerSql.get(name),
  );
}

function parseArguments(argv) {
  const result = {
    json: false,
    printSql: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--print-sql") result.printSql = true;
    else if (argument === "--self-test") result.selfTest = true;
    else if (argument === "--database") {
      result.database = requiredValue(argv, ++index, argument);
    } else if (argument === "--candidate-version") {
      result.candidateVersion = requiredValue(argv, ++index, argument);
    } else if (argument === "--deployment-inventory-sha256") {
      result.deploymentInventorySha256 = requiredValue(argv, ++index, argument);
    } else if (argument === "--account-id") {
      result.accountId = requiredValue(argv, ++index, argument);
    } else if (argument === "--database-id") {
      result.databaseId = requiredValue(argv, ++index, argument);
    } else if (argument === "--wrangler-env") {
      result.wranglerEnv = requiredValue(argv, ++index, argument);
    } else if (argument === "--drain-started-at") {
      result.drainStartedAt = requiredValue(argv, ++index, argument);
    } else if (argument === "--minimum-drain-seconds") {
      result.minimumDrainSeconds = requiredValue(argv, ++index, argument);
    } else if (argument === "--phase") {
      result.phase = requiredValue(argv, ++index, argument);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function requiredValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function positiveInteger(value, argument) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`${argument} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${argument} is too large`);
  return parsed;
}

function strictNonNegativeInteger(value, field) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`D1 readiness field ${field} is not a canonical non-negative integer`);
}

function boundedToken(value, argument, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(`${argument} is invalid`);
  }
  return value;
}

function sha256Token(value, argument) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${argument} must be an exact lowercase SHA-256 digest`);
  }
  return value;
}

function cloudflareAccountId(value, argument) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error(`${argument} must be an exact lowercase Cloudflare account ID`);
  }
  return value;
}

function d1DatabaseId(value, argument) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${argument} must be an exact lowercase D1 database UUID`);
  }
  return value;
}

function boundedEvidenceText(value, field, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function readinessTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("D1 readiness target is missing");
  }
  return {
    verification: "wrangler_d1_info_uuid_match_with_forced_account",
    accountId: cloudflareAccountId(value.accountId, "D1 readiness account ID"),
    databaseArgument: boundedToken(
      value.databaseArgument,
      "D1 readiness database argument",
      1,
      128,
    ),
    databaseId: d1DatabaseId(value.databaseId, "D1 readiness database UUID"),
    databaseName: boundedEvidenceText(
      value.databaseName,
      "D1 readiness database name",
      1,
      128,
    ),
    wranglerEnv:
      value.wranglerEnv === null
        ? null
        : boundedToken(value.wranglerEnv, "D1 readiness Wrangler env", 1, 64),
  };
}

function parsePhase(value) {
  if (value !== "pre" && value !== "post") {
    throw new Error("--phase must be pre or post");
  }
  return value;
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.selfTest) {
    console.log("relay Container 0046 readiness audit self-test ok");
    return;
  }
  console.log(
    `relay Container 0046 ${report.phase} readiness for ${report.target.databaseId}` +
      ` (${report.target.wranglerEnv ?? "default"}): ` +
      `${report.snapshotReady ? "SNAPSHOT_READY" : "BLOCKED"}; ` +
      "authorization=EXTERNAL_EVIDENCE_REQUIRED",
  );
}
