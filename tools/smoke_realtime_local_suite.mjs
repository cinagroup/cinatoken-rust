#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const replayTool = join(root, "tools", "smoke_realtime_upstream_replay.mjs");
const localWranglerConfig = join(root, "wrangler.realtime-local.toml");
const localWranglerCli = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const nodeBinary = Bun.which("node") || process.execPath;
const defaultDatabase = "cinatoken-rust-db";
const defaultUrl = "http://127.0.0.1:8787";
const defaultBaseId = 920_000;
const optionKeys = ["billing_setting.billing_mode", "billing_setting.billing_expr"];
const scenarioNames = [
  "upstream-normal-close",
  "upstream-frame-limit",
  "startup-queue-drain",
  "response-done-usage",
  "upstream-event-stream-failed",
  "upstream-accept-failed",
];

try {
  const options = parseArgs(process.argv.slice(2));
  const result = options.selfTest ? runSelfTest() : await runSuite(options);
  console.log(options.json ? JSON.stringify(result, null, 2) : formatResult(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--confirm-local", "--json", "--self-test", "--start-worker"].includes(arg)) {
      flags.add(arg.slice(2));
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg.slice(2), value);
  }
  const selected = values.get("scenario") || "all";
  const scenarios =
    selected === "all"
      ? scenarioNames
      : selected.split(",").map((value) => value.trim()).filter(Boolean);
  for (const scenario of scenarios) {
    if (!scenarioNames.includes(scenario)) {
      throw new Error(`scenario must be all or a comma-separated subset of: ${scenarioNames.join(", ")}`);
    }
  }
  const baseId = Number.parseInt(values.get("base-id") || String(defaultBaseId), 10);
  if (!Number.isSafeInteger(baseId) || baseId < 1 || baseId > 2_000_000_000 - scenarios.length) {
    throw new Error("base-id must be a positive safe D1 integer range");
  }
  const database = values.get("database") || defaultDatabase;
  if (!/^[A-Za-z0-9_-]+$/.test(database)) throw new Error("database contains unsupported characters");
  const url = validateLoopbackUrl(values.get("url") || defaultUrl);
  const selfTest = flags.has("self-test");
  if (!selfTest && !flags.has("confirm-local")) {
    throw new Error("local Realtime suite requires --confirm-local");
  }
  return {
    url,
    database,
    baseId,
    scenarios,
    json: flags.has("json"),
    selfTest,
    startWorker: flags.has("start-worker"),
  };
}

async function runSuite(options) {
  const tempDir = await mkdtemp(join(tmpdir(), "cinatoken-realtime-suite-"));
  let worker = null;
  const results = [];
  try {
    worker = options.startWorker ? await startLocalWorker(options.url) : null;
    const optionSnapshot = await readOptionSnapshot(options.database, tempDir);
    for (let index = 0; index < options.scenarios.length; index += 1) {
      const scenario = options.scenarios[index];
      const fixtureId = options.baseId + index;
      const tokenKey = `sk-cinatoken-realtime-local-${fixtureId}`;
      const plan = await replayPlan(options.url, scenario, fixtureId, tokenKey);
      await assertFixtureIdsUnused(options.database, tempDir, fixtureId, tokenKey);
      const seedFile = join(tempDir, `seed-${fixtureId}.sql`);
      const cleanupFile = join(tempDir, `cleanup-${fixtureId}.sql`);
      await Bun.write(seedFile, transactionalSql(plan.localD1Seed.statements));
      await Bun.write(cleanupFile, cleanupSql(fixtureId, optionSnapshot));
      try {
        await executeD1File(options.database, seedFile);
        results.push(await runReplay(options.url, scenario, fixtureId, tokenKey));
      } finally {
        await executeD1File(options.database, cleanupFile);
      }
    }
  } finally {
    if (worker) {
      worker.kill();
      await worker.exited;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: results.length === options.scenarios.length && results.every((result) => result.ok),
    localRuntimeReplay: true,
    workerUrl: options.url,
    database: options.database,
    scenarios: results,
    fixtureCleanup: true,
    billingOptionsRestored: true,
    managedWorker: Boolean(worker),
  };
}

async function startLocalWorker(url) {
  const parsed = new URL(url);
  const port = parsed.port || "80";
  const child = Bun.spawn(
    [
      nodeBinary,
      localWranglerCli,
      "dev",
      "--config",
      localWranglerConfig,
      "--port",
      port,
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("local Wrangler Worker exited before becoming ready");
    }
    try {
      const response = await fetch(`${url}/api/status`, { redirect: "error" });
      if (response.ok) return child;
    } catch {
      // Workerd is still starting.
    }
    await Bun.sleep(250);
  }
  child.kill();
  throw new Error(`local Wrangler Worker did not become ready at ${url}`);
}

async function replayPlan(url, scenario, fixtureId, tokenKey) {
  return runJson(process.execPath, [
    replayTool,
    "--dry-run",
    "--json",
    "--url",
    url,
    "--api-key",
    tokenKey,
    "--scenario",
    scenario,
    "--seed-user-id",
    String(fixtureId),
    "--seed-token-id",
    String(fixtureId),
    "--seed-channel-id",
    String(fixtureId),
    "--seed-username",
    `realtime-local-${fixtureId}`,
    "--seed-token-key",
    tokenKey,
  ]);
}

async function runReplay(url, scenario, fixtureId, tokenKey) {
  return runJson(process.execPath, [
    replayTool,
    "--confirm-live",
    "--json",
    "--url",
    url,
    "--api-key",
    tokenKey,
    "--scenario",
    scenario,
    "--seed-user-id",
    String(fixtureId),
    "--seed-token-id",
    String(fixtureId),
    "--seed-channel-id",
    String(fixtureId),
    "--seed-username",
    `realtime-local-${fixtureId}`,
    "--seed-token-key",
    tokenKey,
  ]);
}

async function readOptionSnapshot(database, tempDir) {
  const queryFile = join(tempDir, "option-snapshot.sql");
  await Bun.write(
    queryFile,
    `SELECT [key] AS option_key, value FROM options WHERE [key] IN (${optionKeys.map(sqlString).join(", ")});\n`,
  );
  const rows = await executeD1JsonFile(database, queryFile);
  return new Map(rows.map((row) => [row.option_key, row.value]));
}

async function assertFixtureIdsUnused(database, tempDir, fixtureId, tokenKey) {
  const queryFile = join(tempDir, `collision-${fixtureId}.sql`);
  await Bun.write(
    queryFile,
    [
      `SELECT 'users' AS entity FROM users WHERE id = ${fixtureId}`,
      `UNION ALL SELECT 'tokens' FROM tokens WHERE id = ${fixtureId} OR [key] = ${sqlString(tokenKey)}`,
      `UNION ALL SELECT 'channels' FROM channels WHERE id = ${fixtureId};`,
    ].join("\n"),
  );
  const rows = await executeD1JsonFile(database, queryFile);
  if (rows.length > 0) {
    throw new Error(`local fixture ${fixtureId} collides with existing ${rows.map((row) => row.entity).join(", ")} rows`);
  }
}

function cleanupSql(fixtureId, optionSnapshot) {
  const statements = [
    `DELETE FROM realtime_settlement_replays WHERE user_id = ${fixtureId} OR token_id = ${fixtureId} OR channel_id = ${fixtureId};`,
    `DELETE FROM realtime_billing_reservations WHERE user_id = ${fixtureId} OR token_id = ${fixtureId} OR channel_id = ${fixtureId};`,
    `DELETE FROM logs WHERE user_id = ${fixtureId} OR token_id = ${fixtureId} OR channel_id = ${fixtureId};`,
    `DELETE FROM abilities WHERE channel_id = ${fixtureId};`,
    `DELETE FROM channels WHERE id = ${fixtureId};`,
    `DELETE FROM tokens WHERE id = ${fixtureId};`,
    `DELETE FROM users WHERE id = ${fixtureId};`,
  ];
  for (const key of optionKeys) {
    if (optionSnapshot.has(key)) {
      statements.push(
        `INSERT INTO options ([key], value) VALUES (${sqlString(key)}, ${sqlString(optionSnapshot.get(key))}) ON CONFLICT([key]) DO UPDATE SET value = excluded.value;`,
      );
    } else {
      statements.push(`DELETE FROM options WHERE [key] = ${sqlString(key)};`);
    }
  }
  return transactionalSql(statements);
}

function transactionalSql(statements) {
  return `BEGIN TRANSACTION;\n${statements.join("\n")}\nCOMMIT;\n`;
}

async function executeD1File(database, file) {
  await run(nodeBinary, [
    localWranglerCli,
    "d1",
    "execute",
    database,
    "--local",
    "--file",
    file,
  ]);
}

async function executeD1JsonFile(database, file) {
  const result = await runJson(nodeBinary, [
    localWranglerCli,
    "d1",
    "execute",
    database,
    "--local",
    "--json",
    "--file",
    file,
  ]);
  const entries = Array.isArray(result) ? result : [result];
  return entries.flatMap((entry) => (Array.isArray(entry.results) ? entry.results : []));
}

async function run(command, args) {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
}

async function runJson(command, args) {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`expected JSON from ${command} ${args.join(" ")}: ${stdout.trim()}`);
  }
}

function validateLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("local Realtime suite only accepts an http loopback Worker URL");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSelfTest() {
  const existing = new Map([[optionKeys[0], '{"model":"tiered_expr"}']]);
  const cleanup = cleanupSql(920001, existing);
  for (const expected of [
    "BEGIN TRANSACTION",
    "DELETE FROM abilities",
    "DELETE FROM realtime_settlement_replays",
    "DELETE FROM realtime_billing_reservations",
    "DELETE FROM logs",
    "DELETE FROM channels",
    "DELETE FROM tokens",
    "DELETE FROM users",
    "ON CONFLICT([key]) DO UPDATE",
    `DELETE FROM options WHERE [key] = ${sqlString(optionKeys[1])}`,
    "COMMIT",
  ]) {
    if (!cleanup.includes(expected)) throw new Error(`local suite self-test missing ${expected}`);
  }
  for (const rejected of ["https://127.0.0.1:8787", "http://example.com", "https://example.com"]) {
    try {
      validateLoopbackUrl(rejected);
      throw new Error(`local suite self-test accepted ${rejected}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("local suite self-test accepted")) throw error;
    }
  }
  return {
    ok: true,
    realtimeLocalSuiteSelfTest: true,
    scenarios: scenarioNames,
    loopbackOnly: true,
    transactionalSeedAndCleanup: true,
    billingOptionRestore: true,
    managedWorkerStart: true,
  };
}

function formatResult(result) {
  if (result.realtimeLocalSuiteSelfTest) {
    return `Realtime local suite self-test: ${result.ok ? "ok" : "failed"} (${result.scenarios.length} scenarios)`;
  }
  return [
    `Realtime local runtime suite: ${result.ok ? "ok" : "failed"}`,
    `worker: ${result.workerUrl}`,
    `database: ${result.database}`,
    ...result.scenarios.map((scenario) => `scenario ${scenario.scenario}: ${scenario.ok ? "ok" : "failed"}`),
    `fixture cleanup: ${result.fixtureCleanup}`,
    `billing options restored: ${result.billingOptionsRestored}`,
    `managed worker: ${result.managedWorker}`,
  ].join("\n");
}
