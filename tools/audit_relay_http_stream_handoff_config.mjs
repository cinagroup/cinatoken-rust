import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ORDINARY_STREAM_START = "async fn complete_streaming_relay_response(";
const ORDINARY_STREAM_END =
  "async fn complete_durable_streaming_relay_response(";
const ORDINARY_STREAM_COMPONENT_CHECKS = [
  {
    name: "complete_instrumented_streaming_relay_response",
    definition:
      /\basync\s+fn\s+complete_instrumented_streaming_relay_response\s*\(/,
    wiring:
      /\bcomplete_instrumented_streaming_relay_response\s*\(\s*upstream\s*,/,
  },
  {
    name: "instrumented_relay_stream_next",
    definition: /\basync\s+fn\s+instrumented_relay_stream_next\s*\(/,
    wiring:
      /futures_util\s*::\s*stream\s*::\s*try_unfold\s*\(\s*state\s*,\s*instrumented_relay_stream_next\s*\)/,
  },
  {
    name: "dispatch_instrumented_provider_finalization",
    definition: /\bfn\s+dispatch_instrumented_provider_finalization\s*\(/,
    wiring:
      /\bdispatch_instrumented_provider_finalization\s*\(\s*&mut\s+state\s*,/,
  },
  {
    name: "instrumented_stream_client_abort_listener",
    definition: /\bfn\s+instrumented_stream_client_abort_listener\s*\(/,
    wiring:
      /let\s+client_abort_listener\s*=\s*match\s+instrumented_stream_client_abort_listener\s*\(/,
  },
  {
    name: "dispatch_instrumented_client_finalization",
    definition: /\bfn\s+dispatch_instrumented_client_finalization\s*\(/,
    wiring:
      /\bdispatch_instrumented_client_finalization\s*\(\s*&self\.finalization_owner\s*,/,
  },
  {
    name: "arm_instrumented_stream_lease_heartbeat",
    definition: /\bfn\s+arm_instrumented_stream_lease_heartbeat\s*\(/,
    wiring:
      /if\s+let\s+Err\s*\(\s*error\s*\)\s*=\s*arm_instrumented_stream_lease_heartbeat\s*\(/,
  },
  {
    name: "record_instrumented_stream_finalization_with_retry",
    definition:
      /\basync\s+fn\s+record_instrumented_stream_finalization_with_retry\s*\(/,
    wiring:
      /\brecord_instrumented_stream_finalization_with_retry\s*\(\s*&(?:env|finalization\.env)\s*,/,
  },
];
const ORDINARY_STREAM_COMPONENTS = ORDINARY_STREAM_COMPONENT_CHECKS.map(
  ({ name }) => name,
);
const [
  wrangler,
  runtime,
  repositories,
  relay,
  worker,
  migration,
  dispatchMigration,
  abortMigration,
] = await Promise.all([
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
  readFile(
    path.join(
      repoRoot,
      "migrations",
      "d1",
      "0057_relay_http_stream_dispatch_intents.sql",
    ),
    "utf8",
  ),
  readFile(
    path.join(
      repoRoot,
      "migrations",
      "d1",
      "0058_relay_http_stream_client_abort_watchdogs.sql",
    ),
    "utf8",
  ),
]);

const ordinaryStreamAudit = auditOrdinaryHttpSseSingleForwarding(relay);
assert(
  ordinaryStreamAudit.ready,
  `ordinary HTTP SSE single-forwarding audit failed: ${ordinaryStreamAudit.failures.join(
    "; ",
  )}`,
);

assert(
  /compatibility_flags\s*=\s*\[[^\]]*"enable_request_signal"[^\]]*\]/.test(
    wrangler,
  ),
  "wrangler.toml must enable the incoming Request.signal compatibility flag",
);

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
    assert(
      scope.get(flag) === "false",
      `${scopeName}.${flag} must default false`,
    );
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
    repositories.includes(
      "RETURNING reservation_key, owner_generation, attempt_generation",
    ) &&
    repositories.includes("relay_http_stream_finalization_receipts") &&
    repositories.includes("db.batch(vec![insert_receipt, apply_receipt])") &&
    repositories.includes("status = 'terminal'") &&
    repositories.includes("finalization_applied_at"),
  "repository must atomically claim outbox leases and bind apply receipts to terminal state",
);
assert(
  relay.includes("complete_durable_streaming_relay_response") &&
    relay.includes("prepare_relay_http_stream_dispatch_scope") &&
    relay.includes("dispatch_relay_with_optional_http_stream_intent") &&
    relay.includes("durable_stream_single_dispatch") &&
    relay.includes(
      "durable dispatch migrations 0056/0057/0058 are unavailable",
    ) &&
    relay.includes("!durable_dispatch_enabled") &&
    relay.includes("create_relay_http_stream_handoff") &&
    relay.includes("futures_util::stream::try_unfold") &&
    relay.includes("CreateOutcome::Applied | CreateOutcome::MatchingReplay"),
  "relay request path must persist before provider I/O, use one instrumented stream, and reject replay",
);
assert(
  relay.includes("request_abort_signal = req.inner().signal()") &&
    relay.includes("arm_relay_http_stream_client_abort_watchdog") &&
    relay.includes("AbortSignalWaiter::new(request_signal)") &&
    relay.includes(") -> Result<(), JsValue>") &&
    relay.includes("client_abort_watchdog_disarm") &&
    relay.includes("recovery readback failed before watchdog disarm") &&
    repositories.includes("record_relay_http_stream_client_abort") &&
    repositories.includes("relay_http_stream_client_abort_schema_ready") &&
    repositories.includes("NOT EXISTS (") &&
    repositories.includes("relay_http_stream_client_abort_events AS abort"),
  "relay request path must synchronously arm, durably persist, fence terminal staging, and disarm the client-abort watchdog",
);
assert(
  repositories.includes("admit_relay_http_stream_dispatch") &&
    repositories.includes("db.batch(vec![bind, insert])") &&
    repositories.includes("authorize_relay_http_stream_dispatch") &&
    repositories.includes(
      "mark_relay_http_stream_dispatch_response_received",
    ) &&
    repositories.includes(
      "mark_relay_http_stream_dispatch_recovery_required",
    ) &&
    repositories.includes("sweep_expired_relay_http_stream_dispatch_intents"),
  "repository must atomically bind dispatch admission and expose monotonic transitions",
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
for (const fragment of [
  "CREATE TABLE relay_http_stream_dispatch_intents",
  "idx_relay_http_stream_dispatch_intents_recovery",
  "idx_relay_http_stream_dispatch_intents_active_lease",
  "relay_http_stream_dispatch_intent_insert_guard",
  "relay_http_stream_dispatch_intent_identity_guard",
  "relay_http_stream_dispatch_intent_lifecycle_guard",
  "relay_http_stream_dispatch_intent_stream_bound_guard",
  "relay_http_stream_dispatch_intent_recovery_guard",
  "relay_http_stream_dispatch_intent_recovery_apply",
  "relay_http_stream_dispatch_intent_delete_guard",
  "relay_http_stream_handoff_dispatch_deadline_guard",
  "relay_http_stream_handoff_dispatch_intent_guard",
  "relay_http_stream_handoff_dispatch_intent_bind",
]) {
  assert(
    dispatchMigration.includes(fragment),
    `0057 migration is missing ${fragment}`,
  );
}
for (const fragment of [
  "CREATE TABLE relay_http_stream_client_abort_events",
  "idx_relay_http_stream_client_abort_events_observed",
  "relay_http_stream_client_abort_event_insert_guard",
  "relay_http_stream_client_abort_event_apply",
  "relay_http_stream_client_abort_terminal_guard",
  "relay_http_stream_client_abort_event_update_guard",
  "relay_http_stream_client_abort_event_delete_guard",
  "terminal_reason = 'client_disconnected'",
  "handoff.status IN (",
]) {
  assert(
    abortMigration.includes(fragment),
    `0058 migration is missing ${fragment}`,
  );
}
const finalizationBound =
  /length\(CAST\(finalization_event_json AS BLOB\)\)\s*<=\s*(\d+)/.exec(
    migration,
  );
const errorBound = /length\(CAST\(last_error AS BLOB\)\)\s*<=\s*(\d+)/.exec(
  migration,
);
assert(
  finalizationBound?.[1] === "65536",
  "0056 finalization event bound must be 65536 bytes",
);
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
for (const forbidden of [
  "request_body",
  "response_body",
  "authorization",
  "credential",
  "raw_header",
  "sse_frame",
  "abort_reason",
]) {
  assert(
    !abortMigration.toLowerCase().includes(forbidden),
    `0058 migration must not persist ${forbidden}`,
  );
}
for (const forbidden of [
  "request_body",
  "response_body",
  "authorization",
  "credential",
  "raw_header",
  "sse_frame",
]) {
  assert(
    !dispatchMigration.toLowerCase().includes(forbidden),
    `0057 migration must not persist ${forbidden}`,
  );
}

const ordinaryStreamSelfTest = process.argv.includes("--self-test")
  ? runOrdinaryHttpSseSingleForwardingSelfTest(relay, ordinaryStreamAudit)
  : {};

const report = {
  ok: true,
  migration: "0056_relay_http_stream_handoffs.sql",
  dispatchMigration: "0057_relay_http_stream_dispatch_intents.sql",
  abortMigration: "0058_relay_http_stream_client_abort_watchdogs.sql",
  scopes: [...scopes.keys()].filter((scope) =>
    ["vars", "env.staging.vars", "env.production.vars"].includes(scope),
  ),
  flags,
  allAuthoritiesFalse: true,
  boundedFinalizationEventBytes: Number(finalizationBound[1]),
  boundedLastErrorBytes: Number(errorBound[1]),
  durableBodiesStored: false,
  enqueueAndApplyTerminalsSeparated: true,
  providerDispatchPersistedBeforeIo: true,
  maximumDurableProviderDispatches: 1,
  requestSignalEnabled: true,
  clientAbortEvidenceAppendPreserved: true,
  firstDurableDecisionWinsAbortRace: true,
  ordinaryHttpSseSingleForwardingReady: ordinaryStreamAudit.ready,
  ordinaryHttpSseScopeBounded: ordinaryStreamAudit.scopeFound,
  ordinaryHttpSseRequiredComponents: ORDINARY_STREAM_COMPONENTS,
  ordinaryHttpSseCloneFree: ordinaryStreamAudit.forbiddenCloneUses.length === 0,
  ordinaryHttpSseIndependentFinalizationReady:
    ordinaryStreamAudit.independentFinalizationWired,
  ...ordinaryStreamSelfTest,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `relay HTTP stream handoff config ok: 4 authorities false in 3 scopes, 0057 persist-before-provider dispatch, 0058 client-abort watchdog, and ordinary SSE single-forwarding stream wired${ordinaryStreamSelfTest.selfTest ? "; fail-closed self-test passed" : ""}`,
  );
}

function auditOrdinaryHttpSseSingleForwarding(source) {
  const start = source.indexOf(ORDINARY_STREAM_START);
  const end = source.indexOf(
    ORDINARY_STREAM_END,
    start + ORDINARY_STREAM_START.length,
  );
  const scopeFound = start >= 0 && end > start;
  const ordinaryStreamSource = scopeFound ? source.slice(start, end) : "";
  const missingComponents = ORDINARY_STREAM_COMPONENT_CHECKS.filter(
    ({ definition, wiring }) =>
      !definition.test(ordinaryStreamSource) ||
      !wiring.test(ordinaryStreamSource),
  ).map(({ name }) => name);
  const topologyWired =
    ordinaryStreamSource.includes(
      "futures_util::stream::try_unfold(state, instrumented_relay_stream_next)",
    ) && ordinaryStreamSource.includes("Response::from_stream(body)");
  const heartbeatStart = ordinaryStreamSource.indexOf(
    "struct InstrumentedStreamHeartbeatScheduler",
  );
  const heartbeatEnd = ordinaryStreamSource.indexOf(
    "fn instrumented_stream_client_abort_listener(",
    heartbeatStart,
  );
  const heartbeatSource =
    heartbeatStart >= 0 && heartbeatEnd > heartbeatStart
      ? ordinaryStreamSource.slice(heartbeatStart, heartbeatEnd)
      : "";
  const independentFinalizationWired =
    /fn\s+instrumented_stream_client_abort_listener[\s\S]*?add_event_listener_with_callback\s*\(\s*"abort"/.test(
      ordinaryStreamSource,
    ) &&
    /fn\s+dispatch_instrumented_client_finalization[\s\S]*?finalization_wait_until_context\s*\.\s*wait_until\s*\(\s*async\s+move/.test(
      ordinaryStreamSource,
    ) &&
    /fn\s+dispatch_instrumented_provider_finalization[\s\S]*?finalization_wait_until_context\s*\.\s*wait_until\s*\(\s*async\s+move/.test(
      ordinaryStreamSource,
    ) &&
    /struct\s+InstrumentedStreamHeartbeatScheduler[\s\S]*?set_timeout_with_callback_and_timeout_and_arguments_0/.test(
      heartbeatSource,
    ) &&
    /fn\s+tick[\s\S]*?context\s*\.\s*wait_until\s*\(\s*async\s+move/.test(
      heartbeatSource,
    ) &&
    !/wasm_bindgen_futures\s*::\s*spawn_local/.test(heartbeatSource) &&
    !/\bloop\s*\{/.test(heartbeatSource) &&
    !/fn\s+arm_instrumented_stream_client_abort_watchdog\s*\(/.test(
      ordinaryStreamSource,
    ) &&
    !/struct\s+InstrumentedRelayFinalizationContext\s*\{[^}]*\bcontext\s*:\s*Context\b/.test(
      ordinaryStreamSource,
    ) &&
    !/async\s+fn\s+finalize_instrumented_relay_stream\s*\(/.test(
      ordinaryStreamSource,
    );
  const forbiddenCloneUses = [];
  if (/\bupstream\s*\.\s*cloned\s*\(/.test(ordinaryStreamSource)) {
    forbiddenCloneUses.push("upstream.cloned()");
  }
  if (/\bResponse\s*::\s*cloned\b/.test(ordinaryStreamSource)) {
    forbiddenCloneUses.push("Response::cloned");
  }
  if (/\.\s*tee\s*\(/.test(ordinaryStreamSource)) {
    forbiddenCloneUses.push("ReadableStream.tee()");
  }
  const failures = [];
  if (!scopeFound)
    failures.push("ordinary stream source boundaries are missing or reordered");
  if (missingComponents.length > 0) {
    failures.push(
      `missing or unwired components: ${missingComponents.join(", ")}`,
    );
  }
  if (!topologyWired)
    failures.push("try_unfold -> Response::from_stream topology is missing");
  if (!independentFinalizationWired) {
    failures.push(
      "provider/client finalization is not isolated in bounded waitUntil tasks",
    );
  }
  if (forbiddenCloneUses.length > 0) {
    failures.push(
      `forbidden response clone use: ${forbiddenCloneUses.join(", ")}`,
    );
  }
  return {
    ready:
      scopeFound &&
      missingComponents.length === 0 &&
      topologyWired &&
      independentFinalizationWired &&
      forbiddenCloneUses.length === 0,
    scopeFound,
    missingComponents,
    topologyWired,
    independentFinalizationWired,
    forbiddenCloneUses,
    failures,
  };
}

function runOrdinaryHttpSseSingleForwardingSelfTest(source, baseline) {
  assert(
    baseline.ready,
    "ordinary HTTP SSE baseline must pass before self-test mutation",
  );
  for (const component of ORDINARY_STREAM_COMPONENTS) {
    const mutation = source.replaceAll(component, `removed_${component}`);
    const result = auditOrdinaryHttpSseSingleForwarding(mutation);
    assert(
      !result.ready && result.missingComponents.includes(component),
      `ordinary HTTP SSE audit accepted missing ${component}`,
    );
  }
  const upstreamClone = injectBeforeOrdinaryStreamEnd(
    source,
    "fn forbidden_upstream_clone() { let _ = upstream.cloned(); }",
  );
  const upstreamCloneResult =
    auditOrdinaryHttpSseSingleForwarding(upstreamClone);
  assert(
    !upstreamCloneResult.ready &&
      upstreamCloneResult.forbiddenCloneUses.includes("upstream.cloned()"),
    "ordinary HTTP SSE audit accepted upstream.cloned()",
  );
  const responseClone = injectBeforeOrdinaryStreamEnd(
    source,
    "fn forbidden_response_clone() { let _ = Response::cloned(&upstream); }",
  );
  const responseCloneResult =
    auditOrdinaryHttpSseSingleForwarding(responseClone);
  assert(
    !responseCloneResult.ready &&
      responseCloneResult.forbiddenCloneUses.includes("Response::cloned"),
    "ordinary HTTP SSE audit accepted Response::cloned",
  );
  const streamTee = injectBeforeOrdinaryStreamEnd(
    source,
    "fn forbidden_stream_tee() { let _ = body.tee(); }",
  );
  const streamTeeResult = auditOrdinaryHttpSseSingleForwarding(streamTee);
  assert(
    !streamTeeResult.ready &&
      streamTeeResult.forbiddenCloneUses.includes("ReadableStream.tee()"),
    "ordinary HTTP SSE audit accepted ReadableStream.tee()",
  );
  const pullOwnedFinalization = injectBeforeOrdinaryStreamEnd(
    source,
    "async fn finalize_instrumented_relay_stream() {}",
  );
  const pullOwnedFinalizationResult = auditOrdinaryHttpSseSingleForwarding(
    pullOwnedFinalization,
  );
  assert(
    !pullOwnedFinalizationResult.ready &&
      !pullOwnedFinalizationResult.independentFinalizationWired,
    "ordinary HTTP SSE audit accepted pull-owned async finalization",
  );
  const missingBoundaryResult = auditOrdinaryHttpSseSingleForwarding(
    source.replace(
      ORDINARY_STREAM_START,
      "async fn removed_stream_completion(",
    ),
  );
  assert(
    !missingBoundaryResult.ready && !missingBoundaryResult.scopeFound,
    "ordinary HTTP SSE audit accepted a missing scope boundary",
  );
  return {
    selfTest: true,
    ordinaryHttpSseMissingComponentsRejected: true,
    ordinaryHttpSseUpstreamCloneRejected: true,
    ordinaryHttpSseResponseCloneRejected: true,
    ordinaryHttpSseStreamTeeRejected: true,
    ordinaryHttpSsePullOwnedFinalizationRejected: true,
    ordinaryHttpSseMissingBoundaryRejected: true,
  };
}

function injectBeforeOrdinaryStreamEnd(source, fragment) {
  const end = source.indexOf(ORDINARY_STREAM_END);
  assert(
    end >= 0,
    "ordinary HTTP SSE end boundary is missing from self-test fixture",
  );
  return `${source.slice(0, end)}${fragment}\n\n${source.slice(end)}`;
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
