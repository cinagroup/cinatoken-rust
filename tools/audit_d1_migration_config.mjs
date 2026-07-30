import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = path.join(repoRoot, "wrangler.toml");
const localD1WranglerPath = path.join(repoRoot, "wrangler.d1-local.toml");
const migrationsDir = path.join(repoRoot, "migrations", "d1");
const expectedMigrationCount = 73;
const expectedMigrationHead =
  "0073_relay_container_drain_source_authorization_consumption.sql";
const platformGatewayPath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "platform_gateway.rs",
);
const expectedTables = [
  "d1_databases",
  "env.staging.d1_databases",
  "env.production.d1_databases",
];

const config = await readFile(wranglerPath, "utf8");
const bindings = parseD1Bindings(config);

for (const table of expectedTables) {
  const matches = bindings.filter((binding) => binding.table === table);
  assert(matches.length === 1, `${table} must contain exactly one D1 binding`);
  assert(matches[0].values.binding === "DB", `${table} must expose binding DB`);
  assert(
    matches[0].values.migrations_dir === "migrations/d1",
    `${table} must set migrations_dir to migrations/d1`,
  );
}

const unexpectedTables = bindings
  .map((binding) => binding.table)
  .filter((table) => !expectedTables.includes(table));
assert(
  unexpectedTables.length === 0,
  `unexpected D1 binding tables: ${unexpectedTables.join(", ")}`,
);

const localD1Config = await readFile(localD1WranglerPath, "utf8");
const localD1Bindings = parseD1Bindings(localD1Config);
assert(localD1Bindings.length === 1, "wrangler.d1-local.toml must contain exactly one D1 binding");
assert(localD1Bindings[0].table === "d1_databases", "local D1 binding must be top-level");
assert(localD1Bindings[0].values.binding === "DB", "local D1 config must expose binding DB");
assert(
  localD1Bindings[0].values.database_name === "cinatoken-rust-db",
  "local D1 config must share the runtime smoke database name",
);
assert(
  localD1Bindings[0].values.migrations_dir === "migrations/d1",
  "local D1 config must set migrations_dir to migrations/d1",
);

const migrationFiles = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
assert(migrationFiles.length > 0, "migrations/d1 must contain SQL migrations");
assert(
  migrationFiles.length === expectedMigrationCount,
  `migrations/d1 must contain exactly ${expectedMigrationCount} migrations`,
);
assert(
  migrationFiles.at(-1) === expectedMigrationHead,
  `D1 migration head must be ${expectedMigrationHead}`,
);

const versions = migrationFiles.map((name) => {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
  assert(match, `invalid D1 migration filename: ${name}`);
  return Number.parseInt(match[1], 10);
});
for (let index = 0; index < versions.length; index += 1) {
  const expected = index + 1;
  assert(
    versions[index] === expected,
    `D1 migration sequence must be contiguous: expected ${String(expected).padStart(4, "0")}, found ${migrationFiles[index]}`,
  );
}

const platformGateway = await readFile(platformGatewayPath, "utf8");
const latestMigration = migrationFiles.at(-1);
assert(
  new RegExp(
    `pub const EXPECTED_D1_MIGRATION: &str\\s*=\\s*"${latestMigration.replaceAll(".", "\\.")}";`,
  ).test(platformGateway),
  `platform capability expected migration must match ${latestMigration}`,
);
const runtimeSetMatch =
  /const EXPECTED_D1_MIGRATIONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(
    platformGateway,
  );
assert(runtimeSetMatch, "platform capability must declare EXPECTED_D1_MIGRATIONS");
const runtimeMigrations = [
  ...runtimeSetMatch[1].matchAll(/"([^"]+\.sql)"/g),
].map((match) => match[1]);
assert(
  JSON.stringify(runtimeMigrations) === JSON.stringify(migrationFiles),
  "platform runtime migration set must exactly match migrations/d1",
);

const report = {
  ok: true,
  wranglerConfig: path.relative(repoRoot, wranglerPath).replaceAll("\\", "/"),
  localD1WranglerConfig: path.relative(repoRoot, localD1WranglerPath).replaceAll("\\", "/"),
  migrationsDir: "migrations/d1",
  bindingTables: expectedTables,
  migrationCount: migrationFiles.length,
  firstMigration: migrationFiles[0],
  lastMigration: latestMigration,
  runtimeMigrationCount: runtimeMigrations.length,
  contiguous: true,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `D1 migration config ok: ${report.bindingTables.length} bindings, ${report.migrationCount} contiguous migrations (${report.firstMigration}..${report.lastMigration})`,
  );
}

function parseD1Bindings(source) {
  const bindings = [];
  let current = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const tableMatch = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (tableMatch) {
      current = tableMatch[1].endsWith("d1_databases")
        ? { table: tableMatch[1], values: {} }
        : null;
      if (current) bindings.push(current);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;

    const assignment = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"(?:\s*#.*)?$/.exec(line);
    if (assignment) current.values[assignment[1]] = assignment[2];
  }

  return bindings;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
