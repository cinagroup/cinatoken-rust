import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = path.join(repoRoot, "wrangler.toml");
const coordinatorPath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "quota_coordinator.rs",
);
const coordinatorCorePath = path.join(
  repoRoot,
  "crates",
  "coordinator",
  "src",
  "lib.rs",
);
const platformGatewayPath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "platform_gateway.rs",
);
const relayPath = path.join(repoRoot, "crates", "worker", "src", "relay.rs");
const queuePath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "relay_billing_queue.rs",
);
const repositoryPath = path.join(
  repoRoot,
  "crates",
  "worker",
  "src",
  "d1_repositories.rs",
);
const workerPath = path.join(repoRoot, "crates", "worker", "src", "lib.rs");

const [
  wranglerSource,
  coordinatorSource,
  coordinatorCoreSource,
  platformGatewaySource,
  relaySource,
  queueSource,
  repositorySource,
  workerSource,
] = await Promise.all([
  readFile(wranglerPath, "utf8"),
  readFile(coordinatorPath, "utf8"),
  readFile(coordinatorCorePath, "utf8"),
  readFile(platformGatewayPath, "utf8"),
  readFile(relayPath, "utf8"),
  readFile(queuePath, "utf8"),
  readFile(repositoryPath, "utf8"),
  readFile(workerPath, "utf8"),
]);
const config = parseTomlSections(wranglerSource);
const environments = [
  {
    name: "default",
    vars: "vars",
    bindings: "durable_objects.bindings",
    migrations: "migrations",
  },
  {
    name: "staging",
    vars: "env.staging.vars",
    bindings: "env.staging.durable_objects.bindings",
    migrations: "env.staging.migrations",
  },
  {
    name: "production",
    vars: "env.production.vars",
    bindings: "env.production.durable_objects.bindings",
    migrations: "env.production.migrations",
  },
];

for (const environment of environments) {
  const vars = singleSection(config, environment.vars);
  assert(
    vars.QUOTA_COORD_SHADOW_ENABLED === "false",
    `${environment.vars} must keep QuotaCoordinator shadow observation default-off`,
  );
  assert(
    vars.QUOTA_COORD_SHADOW_TOKEN_IDS === "",
    `${environment.vars} must keep the QuotaCoordinator token allowlist empty by default`,
  );
  assert(
    vars.QUOTA_COORD_RETENTION_VERIFIED === "false",
    `${environment.vars} must keep QuotaCoordinator retention unverified by default`,
  );
  assert(
    vars.QUOTA_COORD_STAGING_VERIFIED === "false",
    `${environment.vars} must not claim a staging shadow bake`,
  );

  const bindings = sections(config, environment.bindings).filter(
    (section) => section.name === "QUOTA_COORD",
  );
  assert(
    bindings.length === 1,
    `${environment.bindings} must contain exactly one QUOTA_COORD binding`,
  );
  assert(
    bindings[0].class_name === "QuotaCoordinator",
    `${environment.name} QUOTA_COORD must bind QuotaCoordinator`,
  );

  const migrations = sections(config, environment.migrations).filter(
    (section) => section.tag === "v6-quota-coordinator",
  );
  assert(
    migrations.length === 1,
    `${environment.migrations} must contain exactly one v6-quota-coordinator migration`,
  );
  assert(
    migrations[0].new_sqlite_classes === '["QuotaCoordinator"]',
    `${environment.name} v6 migration must add only QuotaCoordinator`,
  );
}

for (const expected of [
  'pub const QUOTA_COORD_BINDING: &str = "QUOTA_COORD";',
  'pub const QUOTA_COORD_SHADOW_ENABLED_ENV: &str = "QUOTA_COORD_SHADOW_ENABLED";',
  'pub const QUOTA_COORD_SHADOW_TOKEN_IDS_ENV: &str = "QUOTA_COORD_SHADOW_TOKEN_IDS";',
  'pub const QUOTA_COORD_RETENTION_VERIFIED_ENV: &str = "QUOTA_COORD_RETENTION_VERIFIED";',
  'pub const QUOTA_COORD_STAGING_VERIFIED_ENV: &str = "QUOTA_COORD_STAGING_VERIFIED";',
]) {
  assert(coordinatorSource.includes(expected), `QuotaCoordinator source is missing: ${expected}`);
}
for (const expected of [
  "quota_coordinator_relay_observation_compiled",
  "quota_coordinator_retention_compaction_compiled",
  "quota_coordinator_write_authority_enabled",
  "quota_coordinator_cutover_ready",
  "quota_coordinator_cutover_guards",
]) {
  assert(
    platformGatewaySource.includes(expected),
    `platform capability is missing ${expected}`,
  );
}
for (const expected of [
  "MAX_PERSISTED_STATE_JSON_BYTES",
  "compact_terminal_history",
  "RetentionWindowExpired",
  "retention_watermark_committed_at",
]) {
  assert(
    coordinatorCoreSource.includes(expected),
    `quota coordinator retention contract is missing ${expected}`,
  );
}

const producerCoverage = {
  reserve: relaySource.includes("async fn reserve_tiered_billing_group_plan(")
    && relaySource.includes("plan.reserve_applied = true;")
    && relaySource.includes("observe_committed_relay_billing_reservation("),
  directFinalization: relaySource.includes(
    "async fn require_observed_relay_billing_finalization(",
  ),
  queueFinalization: queueSource.includes("observe_committed_relay_billing_reservation("),
  orphanRecovery: repositorySource.includes("observation_reservation_keys")
    && workerSource.includes("for reservation_key in &summary.observation_reservation_keys")
    && workerSource.includes("observe_committed_relay_billing_reservation("),
};
for (const [producer, covered] of Object.entries(producerCoverage)) {
  assert(covered, `QuotaCoordinator ${producer} producer coverage is missing`);
}
assert(
  coordinatorSource.includes("if !quota_coordinator_observation_runtime_enabled(env)"),
  "QuotaCoordinator producer must enforce the combined shadow and retention runtime gate",
);
assert(
  coordinatorSource.includes("context.wait_until(async move"),
  "QuotaCoordinator fetch-path observation must be deferred with waitUntil",
);

const report = {
  ok: true,
  config: "wrangler.toml",
  binding: "QUOTA_COORD",
  className: "QuotaCoordinator",
  migrationTag: "v6-quota-coordinator",
  shadowDefaultOff: true,
  shadowTokenAllowlistDefaultEmpty: true,
  retentionVerifiedDefaultOff: true,
  retentionCompactionCompiled: true,
  fetchObservationDeferred: true,
  stagingProofDefaultOff: true,
  producerCoverage: Object.keys(producerCoverage),
  environments: environments.map(({ name }) => name),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `QuotaCoordinator config ok: ${environments.length} environments, SQLite DO binding present, shadow/proof default-off`,
  );
}

function parseTomlSections(source) {
  const parsed = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const arrayTable = /^\[\[([^\]]+)\]\]$/.exec(line);
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (arrayTable || table) {
      const name = (arrayTable ?? table)[1];
      current = {};
      const values = parsed.get(name) ?? [];
      values.push(current);
      parsed.set(name, values);
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const assignment = /^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|(\[[^#]*\])|([^#\s]+))(?:\s*#.*)?$/.exec(
      line,
    );
    if (assignment) {
      current[assignment[1]] = assignment[2] ?? assignment[3]?.replaceAll(" ", "") ?? assignment[4];
    }
  }
  return parsed;
}

function sections(config, name) {
  return config.get(name) ?? [];
}

function singleSection(config, name) {
  const matches = sections(config, name);
  assert(matches.length === 1, `${name} must exist exactly once`);
  return matches[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
