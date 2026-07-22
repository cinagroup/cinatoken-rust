import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [wrangler, runtime, repositories, relay, worker, migration] =
  await Promise.all([
  readFile(path.join(repoRoot, "wrangler.toml"), "utf8"),
  readFile(
    path.join(
      repoRoot,
      "crates",
      "worker",
      "src",
      "relay_http_stream_handoff.rs",
    ),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "crates", "worker", "src", "d1_repositories.rs"),
    "utf8",
  ),
  readFile(path.join(repoRoot, "crates", "worker", "src", "relay.rs"), "utf8"),
  readFile(path.join(repoRoot, "crates", "worker", "src", "lib.rs"), "utf8"),
  readFile(
    path.join(
      repoRoot,
      "migrations",
      "d1",
      "0056_relay_http_stream_handoffs.sql",
    ),
    "utf8",
  ),
  ]);

const flags = [
  "RELAY_HTTP_STREAM_DURABLE_HANDOFF_ENABLED",
  "RELAY_HTTP_STREAM_DURABLE_HANDOFF_STAGING_VERIFIED",
  "RELAY_HTTP_STREAM_OUTBOX_ENABLED",
  "RELAY_HTTP_STREAM_RECOVERY_ENABLED",
];
const scopes = parseVariableScopes(wrangler);
for (const scopeName of ["vars", "env.staging.vars", "env.production.vars"]) {
  const scope = scopes.get(scopeName);
  assert(scope, `wrangler.toml is missing [${scopeName}]`);
  for (const flag of flags) {
    assert(scope.get(flag) === "false", `${scopeName}.${flag} must default false`);
  }
}

for (const flag of flags) {
  assert(runtime.includes(`"${flag}"`), `runtime is missing ${flag}`);
}
assert(
  runtime.includes("valid && staging_verified && outbox_requested") &&
    runtime.includes("valid && staging_verified && recovery_requested") &&
    runtime.includes("let drain_only ="),
  "outbox/recovery drain authority must remain independent from the producer gate",
);
assert(
  runtime.includes("relay_http_stream_handoff_schema_ready(db).await?") &&
    runtime.includes("claim_relay_http_stream_outbox") &&
    runtime.includes("mark_relay_http_stream_outbox_delivered") &&
    runtime.includes("observe_applied_finalization"),
  "runtime must wire schema, lease, enqueue acknowledgement, and apply acknowledgement",
);
assert(
  repositories.includes("UPDATE relay_http_stream_handoffs") &&
    repositories.includes("RETURNING reservation_key, owner_generation, attempt_generation") &&
    repositories.includes("relay_http_stream_finalization_receipts") &&
    repositories.includes("db.batch(vec![insert_receipt, apply_receipt])") &&
    repositories.includes("status = 'terminal'") &&
    repositories.includes("finalization_applied_at"),
  "repository must atomically claim outbox leases and bind apply receipts to terminal state",
);
assert(
  relay.includes("complete_durable_streaming_relay_response") &&
    relay.includes("create_relay_http_stream_handoff") &&
    relay.includes("futures_util::stream::try_unfold") &&
    relay.includes("CreateOutcome::Applied => {}") &&
    !relay.includes("CreateOutcome::Applied | CreateOutcome::MatchingReplay"),
  "relay request path must use one instrumented stream and reject ambiguous replay",
);
assert(
  worker.includes("run_relay_http_stream_handoff_scheduled") &&
    worker.includes("observe_applied_finalization"),
  "Worker cron and Queue consumer must both participate in handoff convergence",
);
for (const fragment of [
  "CREATE TABLE relay_http_stream_handoffs",
  "CREATE TABLE relay_http_stream_finalization_receipts",
  "idx_relay_http_stream_handoffs_stale_forwarding",
  "idx_relay_http_stream_handoffs_pending_outbox",
  "relay_http_stream_handoff_checkpoint_guard",
  "relay_http_stream_handoff_finalization_evidence_guard",
  "relay_http_stream_handoff_financial_terminal_guard",
  "relay_http_stream_handoff_terminal_guard",
  "relay_http_stream_finalization_receipt_insert_guard",
  "finalization_enqueued",
]) {
  assert(migration.includes(fragment), `0056 migration is missing ${fragment}`);
}
const finalizationBound = /length\(CAST\(finalization_event_json AS BLOB\)\)\s*<=\s*(\d+)/.exec(
  migration,
);
const errorBound = /length\(CAST\(last_error AS BLOB\)\)\s*<=\s*(\d+)/.exec(
  migration,
);
assert(finalizationBound?.[1] === "65536", "0056 finalization event bound must be 65536 bytes");
assert(errorBound?.[1] === "4096", "0056 last-error bound must be 4096 bytes");
for (const forbidden of [
  "request_body",
  "response_body",
  "sse_frame",
  "response_text",
  "authorization",
]) {
  assert(
    !migration.toLowerCase().includes(forbidden),
    `0056 migration must not persist ${forbidden}`,
  );
}

const report = {
  ok: true,
  migration: "0056_relay_http_stream_handoffs.sql",
  scopes: [...scopes.keys()].filter((scope) =>
    ["vars", "env.staging.vars", "env.production.vars"].includes(scope),
  ),
  flags,
  allAuthoritiesFalse: true,
  boundedFinalizationEventBytes: Number(finalizationBound[1]),
  boundedLastErrorBytes: Number(errorBound[1]),
  durableBodiesStored: false,
  enqueueAndApplyTerminalsSeparated: true,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    "relay HTTP stream handoff config ok: 4 authorities false in 3 scopes, 0056 bounded outbox wired",
  );
}

function parseVariableScopes(source) {
  const scopes = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].endsWith("vars") ? header[1] : null;
      if (current && !scopes.has(current)) scopes.set(current, new Map());
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const assignment = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"(?:\s*#.*)?$/.exec(line);
    if (assignment) scopes.get(current).set(assignment[1], assignment[2]);
  }
  return scopes;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
