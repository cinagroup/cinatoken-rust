# Verification

Last checked: 2026-07-17

## Realtime Local Runtime Suite

- `bun tools/smoke_realtime_local_suite.mjs --start-worker --confirm-local
  --json` passed all six local runtime scenarios through the built Worker,
  local Wrangler D1, `RealtimeSession` Durable Object, and Bun mock upstream:
  normal upstream close, oversized upstream frame, startup queue/drain,
  `response.created` plus `response.done` usage/settlement, event-stream
  failure, and upstream accept failure.
- The usage scenario exercised the real explicit-response sequence:
  bootstrap `session.update`, client `response.create`, D1 reservation,
  upstream response identity binding, usage capture, tiered settlement preview,
  and normal close. It observed 1,200 prompt, 350 completion, 400 cached, 180
  input-audio, and 90 output-audio tokens; pre-consumed quota was 8 and the
  final/additional quota was 2,870/2,862 for the isolated expression. Runtime
  metrics reported write count 1, applied count 1, replay marker recorded,
  audit recorded, token/channel scoped mutation, and no retry scheduled.
- Every scenario used a unique 920000-920005 user/token/channel fixture. The
  suite snapshots and restores the two billing options and transactionally
  removes abilities, reservations, settlement replays, logs, channels, tokens,
  and users. Independent post-run D1 queries returned zero rows for all seven
  fixture families.
- Runtime replay found and fixed two evidence defects: Realtime plan/socket
  metadata retained the `openai-insecure-api-key.` protocol marker after
  redaction, and the usage fixture omitted the required response identity and
  reservation lifecycle. Credential subprotocol metadata now becomes the
  generic `<redacted-api-key-protocol>` placeholder; the mock now follows the
  production response-create/created/done sequence.
- Worker builds are now driven by `tools/build_worker.mjs`. It pins
  `worker-build` 0.1.14 for `worker` 0.5, requires a wasm-bindgen CLI exactly
  matching `Cargo.lock` (0.2.125 at this check), and reuses Bun-locked esbuild
  on Windows through the supported binary override. A real optimized Worker
  build and Wrangler dry-run passed; the upload shape was 8,363.79 KiB raw /
  2,927.12 KiB gzip.
- `wrangler.realtime-local.toml` is local-only and deliberately excludes AI,
  Assets, routes, remote environments, and a custom build. Wrangler 4.103.0's
  bundled workerd supports compatibility dates through 2026-06-24, so this
  local file uses that date while staging/production remain on 2026-07-11 and
  still require deployed runtime evidence.
- This is E3 local runtime evidence, not staging or production approval. Remote
  provider credentials, Cloudflare hibernation/eviction, reconnect, alarm
  recovery, concurrent multi-response no-double-charge, deployed traces,
  rollback, and the two remaining non-deterministic send/error faults are still
  required before Realtime cutover.
- Final repository gates passed after the runtime fixes: Worker library tests
  571/571; frontend readiness 8/8; route audit 217 frontend calls / 313 Worker
  routes / 0 missing; bundle redaction 0 findings; bundle budgets and zero-debt
  lint passed; all 20 D1 migrations and SQLite invariants passed; complete
  `bun run check`, Worker wasm32, WFP tenant wasm32, optimized main Worker
  build, and optimized WFP tenant build passed. Only the two existing unused
  topup repository warnings remain.

## WFP Authority And Outbound Boundary

- Current source inspection shows a default-off post-admission WFP transport:
  relay-token authentication, D1 channel selection, and quota reserve occur
  before `channels.other_info.wfp_worker` selects the tenant Worker. The response
  returns through central settlement/refund and audit.
- `WFP_RELAY_TRANSPORT_ENABLED` is explicitly false in tracked environments.
  The platform Worker alone retains `WFP_RELAY_AUTHORITY_SECRET` and signs the
  central-authority v3 envelope directly. No authority key or verifier secret
  is derived into or uploaded with a tenant. The 30-second envelope binds the
  public worker, physical dispatch Worker, fixed outbound policy profile,
  method, path, body hash, channel ID, and request ID.
- Admin dispatch is status-only, generated JavaScript fallback AI deploy is
  disabled, and the strict production artifact path is the Rust/Wasm uploader.
  The dispatch namespace must attach outbound service `cinatoken-wfp-outbound`.
  That service alone owns secret `CINATOKEN_WFP_OUTBOUND_AI_TOKEN`; the tenant
  receives `CINATOKEN_WFP_OUTBOUND_AUTH_MODE=platform-outbound-v1` for outbound
  authentication and must never receive `CF_API_TOKEN` or any other Cloudflare
  bearer. The deploy/readback token also remains outside the tenant.
- The retained WFP tenant routes are `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages`, and `/ai/run`. `/v1/embeddings` is removed from this tenant
  transport contract.
- The outbound Worker accepts only `POST` with `application/json` and a valid
  JSON body no larger than 4 MiB. It permits only the exact account-scoped URLs
  `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run`,
  `/ai/v1/chat/completions`, `/ai/v1/responses`, and `/ai/v1/messages`; it
  injects its own bearer, rebuilds request/response headers from allowlists, and
  rejects redirects. This follows Cloudflare's
  [Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/)
  architecture and the documented
  [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
  Under the outbound parameter contract, the dispatcher passes
  `CINATOKEN_WFP_OUTBOUND_CONTEXT`, and the outbound Worker requires the exact
  relay-authority route kind, public worker, and dispatched script identity.
  Before reading its bearer secret it rechecks authority signature/replay,
  method, final AI REST path, and exact body hash.
- This section supersedes historical 2026-07-05 WFP entries below that describe
  admin AI dispatch, generated fallback AI parity/deploy, embeddings support,
  or tenant-owned Cloudflare tokens. Those entries remain only as an
  implementation history.
- No remote outbound-service attachment, tenant binding readback, or live AI
  request is verified here. A real dispatch-namespace Rust/Wasm upload/readback,
  outbound service and secret attachment proof, staging signed-authority billing
  canary, and live replay evidence are still pending. The local tenant now
  consumes each envelope once through `WfpAuthorityReplay`, but sequential/
  concurrent races, external binding identity, eviction/redeploy persistence,
  cleanup, load, and one-provider-call behavior are not deployed evidence. Do
  not treat local compile/tests, dry-run manifests, or capability fields as
  production proof. WFP production remains **NO-GO**.

## Passed

- `cargo test -p cinatoken-worker --lib`: passed on 2026-07-10 with 512/512
  tests after adding the Realtime per-response reservation state machine,
  request-aware estimate, explicit-response VAD guard, response identity
  correlation, and multi-record settlement retry queue. The retry contract
  covers bounded/capped backoff and redacted public status; the v1 cutover
  predicate still treats the settlement-write gate as mandatory while final
  bridge/settlement release latches remain false.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:v1-smoke-plan`, `bun run check:web`,
  `git diff --check`, and full `bun run check`: passed on 2026-07-10. The full
  gate covered frontend build/bundle/redaction/budget/lint, 216 frontend calls
  against 310 literal Worker routes with zero static misses, all local D1 and
  smoke contracts, workspace tests, and both Worker and WFP tenant wasm32
  checks. Only the existing unused topup repository warnings remained.
- Capability/frontend/smoke contracts now expose
  `realtime_session_billing_settlement_retry_compiled`,
  `realtime_session_billing_reservation_lease_compiled`, and
  `realtime_session_billing_settlement_write_enabled`. The default, staging,
  and production Wrangler variable tables explicitly keep
  `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED="false"`; v1 smoke preflight
  requires it to be true before attempting a live WebSocket. All environments
  set `REALTIME_BILLING_RESERVATION_LEASE_SECONDS="900"` explicitly. The
  accepted `900..3600` range cannot undercut the 840-second upstream bridge
  lifetime; the extra 60 seconds is a mandatory close/clock-skew margin.
- Evidence boundary: a fresh localhost Worker request for the new structured
  503 interlock was not captured. `wrangler dev` could not run because
  `worker-build` was absent; installing it failed under the default GNU host
  toolchain because `dlltool.exe` is missing, and the installed MSVC Rust
  toolchain resolved an incompatible Unix `link.exe` ahead of Visual Studio's
  linker. No dev server was left running. The compiled route guard and cutover
  tests are local contract evidence only; live Worker alarm/interlock and DO
  eviction evidence remain staging requirements.
- `bunx vitest run --config vitest.do.config.mjs` passed 9/9 on 2026-07-13
  against the release Rust/Wasm artifact. The added reconstruction case proves
  one real mock-provider WebSocket handshake, a persisted handoff attachment
  restored with no in-memory upstream bridge, no implicit second provider
  request, metadata-only `upstream_unavailable`, actual client close
  `1011/upstream_bridge_unavailable`, one atomic D1 reservation refund, one
  user/token quota restoration, lease removal, and a distinct segment on the
  next client connection. This is deterministic Workerd evidence; outbound
  WebSockets are not hibernatable and are not claimed to survive eviction.
- The complete `bun run check` gate passed on 2026-07-13 after the lease and
  reconstruction changes. It rebuilt the release Worker/WFP artifacts, reran
  Workerd 9/9 and frontend readiness 22/22, found zero missing frontend routes
  across 217 calls and 319 Worker routes, replayed all 21 D1 migrations, passed
  workspace tests, and completed the main Worker, WFP tenant, and WFP outbound
  wasm32 checks. Only the two existing unused topup repository warnings remain.
- Production audit boundary: Realtime settlement remains NO-GO for paid
  traffic, but the audited local correctness defects are now closed by
  migrations 0019-0020: every `response.create` receives an idempotent D1 reserve,
  settlement/refund is per reservation, and replay identity includes the
  hashed upstream response. A bounded multi-record DO alarm queue prevents
  failed responses from replacing one another, while a persisted active-work
  lease refunds abandoned reservations after DO hibernation/crash recovery.
  Lease recovery is generation-bound by `reservation_sequence`, merges queue
  state after D1 awaits, keeps gate-off and refund-only deadlines scheduled,
  and treats DO storage read failures as retryable alarm failures rather than
  empty queues. Migration 0020 also rejects unreconciled active 0019 rows.
  Live staging multi-response,
  alarm/eviction, disconnect-refund, D1 rollback, and Go/Rust reconciliation
  evidence is still missing. WFP tenant AI forwarding also remains NO-GO for
  paid traffic until central auth/provider/billing authority, real Rust/Wasm
  artifact identity, outbound-service secret isolation and namespace
  attachment, bearer-free tenant readback, and strict 2xx canary evidence are
  proven.
- `bun tools/smoke_realtime_settlement_batch.mjs --self-test --json`: passed
  14/14 checks. The parallel-response case binds two sequence-ordered
  reservations to distinct hashed `response.created` identities, then settles
  their `response.done` events in reverse order without swapping final quota;
  the lease cases prove not-due, first-expiry refund, replay no-op, and
  stale-generation protection. The bridge-segment case proves that binding and
  refund for one bridge cannot mutate a replacement bridge under the same
  logical session.

### 2026-07-12 Realtime bridge-segment isolation increment

- `cargo test -p cinatoken-worker --lib`: passed 578/578 tests.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.
- Focused Cloudflare Platform frontend readiness tests: passed 10/10; Realtime
  implementation readiness now requires the compiled settlement-batch and
  bridge-segment contract in addition to remote D1 readiness.
- `bun tools/smoke_realtime_settlement_batch.mjs --self-test --json`: passed
  14/14, including same-session cross-segment response binding and refund
  isolation.
- `python tools/verify_sqlite.py`: passed with 21 migrations, 26 required
  tables, 57 incremental columns, 15 key indexes, and both the 0020 active-row
  and 0021 bridge-segment guards.
- `bun tools/audit_d1_migration_config.mjs --json`: passed with a contiguous
  21-file chain and latest migration
  `0021_realtime_billing_bridge_segments.sql` aligned to the Worker constant.
- The managed local Realtime runtime suite passed all six workerd/D1/DO/mock
  upstream scenarios with fixture cleanup and billing-option restoration.
  This is local implementation evidence only; authenticated remote migration,
  provider, eviction, reconnect, concurrency, and rollback evidence remain
  required.

#### Historical 2026-07-10 D1 evidence

- `bun run check:d1:migration-config`: passed on 2026-07-10. The audit found
  exactly the top-level, staging, and production D1 binding tables, each with
  binding `DB` and `migrations_dir = "migrations/d1"`; migrations are
  contiguous from `0001_core.sql` through
  `0020_realtime_billing_reservation_leases.sql` (20 total), and the Worker capability
  constant names the same latest migration.
- `bun run verify:sqlite`: passed on 2026-07-10 with
  `sqlite schema ok: 20 migrations, 26 tables, 56 incremental columns, 14 key
  indexes + 0020 active-reservation guard`. The default verifier now exercises
  the full migration chain, active-row rejection, and clean retry after
  reconciliation rather than only `0001_core.sql`.
- `wrangler d1 migrations apply cinatoken-rust-db --local`: applied all 20/20
  migrations through real local Wrangler D1 on Windows. Wrangler's local
  `workerd` required Microsoft Visual C++ 2015-2022 Redistributable (x64); with
  that runtime present, the prior local process-start failure was cleared.
- The compiled runtime gate now requires the complete 20-name set through
  `0020_realtime_billing_reservation_leases.sql`. The previous real localhost
  `/api/platform/capabilities` request proved count 19/latest 0019 and D1
  readiness before migration 0020 landed; it must be refreshed before serving
  as current runtime evidence. Direct local D1 readback confirms 0020, its
  `lease_expires_at` column, and lease index are present.
- After the fail-closed guard was added, Wrangler 4.103.0 replayed the final
  20-file chain into a fresh isolated `--persist-to` directory. All 20 displayed
  applied; direct readback confirmed latest 0020, the lease column/index, and
  no residual migration guard table. Wrangler printed completion but retained
  a Windows helper process, which was terminated only after readback.
- The same capability request initially exposed a wasm-only billing clock panic:
  `std::time::SystemTime::now()` is unavailable on
  `wasm32-unknown-unknown`. The billing engine now uses `js_sys::Date::now()`
  for its default clock on wasm while preserving `SystemTime` on native
  targets. After rebuilding, the capability request returned `200`, and the
  Realtime pre-settlement and settlement-preview probes both returned true.
- The live localhost Worker-binding Realtime settlement smoke passed all six
  fixed scenarios (6/6): additional quota, duplicate replay no-op, guarded
  update rollback, audit failure rollback, refund delta, and tokenless apply.
  The generic Realtime gateway matcher was first narrowed so it no longer
  intercepts `POST /api/platform/realtime/settlement-batch/smoke`. The smoke
  exercised the Worker `DB` binding and production settlement batch path, and
  default cleanup left zero fixture rows and removed the temporary
  audit-failure trigger.
- Evidence boundary for the entries above: these are local results. No
  remote staging command was run because Wrangler was not authenticated. No
  staging D1 migration state, deployed binding, Worker response, log, trace, or
  Realtime settlement result is verified. A token exposed during setup must not
  be used; it requires revocation/rotation before authenticated staging work.

- `node --check tools/smoke_realtime_settlement_batch.mjs` and
  `bun tools/smoke_realtime_settlement_batch.mjs --self-test --json`: passed
  after adding the local Realtime settlement batch replay contract. The tool
  mirrors the D1 batch SQL shape against Bun SQLite and proves
  additional-quota apply, duplicate replay no-op, guarded-update rollback,
  audit-failure rollback, refund-delta apply, and tokenless settlement apply.
  The same self-test now also validates the generated staging-plan
  setup/verify/cleanup SQL artifacts and redaction constraints. It is
  pre-staging evidence only; `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` remain false until the same cases are
  archived against isolated staging D1 through the Worker binding path plus
  live no-double-charge evidence.
- `bun tools/smoke_realtime_settlement_batch.mjs --staging-plan --database
  cinatoken-rust-db-staging --wrangler-env staging --json`: passed and emitted
  reviewed setup, verification, duplicate-marker pre-check, and cleanup
  artifacts plus explicit Worker-binding apply requirements. The plan
  intentionally warns that standalone `wrangler d1 execute` SQL is not
  equivalent to `D1Database.batch()` apply evidence.
- `bun tools/smoke_realtime_settlement_batch.mjs --binding-smoke-plan --json
  --url http://127.0.0.1:8787 --scenario all` and `bun run
  check:realtime-session:settlement-binding-smoke-plan`: passed after adding
  the default-off, admin-only Worker-binding smoke route plan. The dry-run
  covers all six fixed settlement scenarios and prints only request bodies and
  redacted readiness requirements; live mode still requires staging
  `REALTIME_SETTLEMENT_STAGING_SMOKE_ENABLED=true`, an admin cookie, and
  `--confirm-live`.
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed after adding
  `/api/platform/realtime/settlement-batch/smoke` and the
  `realtime_session_billing_settlement_staging_smoke_*` capability fields.
  The test locks the six fixed scenario names and keeps the staging smoke
  readiness separate from final Realtime v1 cutover readiness.
- `bun run check`: passed after wiring the settlement-batch contract into the
  default gate; the only warnings were the existing unused Worker repository
  helpers `complete_topup` and `list_user_topups`.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:v1-smoke-plan`, `bun run check:web`,
  `cargo fmt --all --check`, `git diff --check`, and `bun run check`:
  passed after adding the Realtime settlement D1 batch foundation. The
  default-off writer now applies the replay marker, guarded quota settlement,
  and Go-compatible audit row through one D1 batch with assertion guards for
  zero-row guarded updates. `/api/platform/capabilities`, the smoke preflight,
  and the Cloudflare Platform panel expose
  `realtime_session_billing_settlement_batch_compiled`, while
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` remain false until applied, duplicate,
  failure, rollback, redaction, and no-double-charge staging evidence is
  archived. The full check still emits only the existing topup dead-code
  warnings in `d1_repositories.rs`.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:v1-smoke-plan`, `bun run check:web`,
  `cargo fmt --all --check`, `git diff --check`, and `bun run check`:
  passed after adding the Realtime settlement audit-log foundation. The
  default-off Realtime writer can now carry a private audit plan into the DO,
  write Go-compatible `logs` rows through `LOG_QUEUE`/D1 fallback after an
  applied settlement, and expose only redacted
  `audit_plan_present`/`audit_attempted`/`audit_recorded`/`audit_error`
  metadata. `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` remain false until quota mutation,
  replay marker creation, and audit row creation are proven through a single
  D1 transaction or equivalent CAS flow with staging evidence. The full check
  still emits only the existing `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:v1-smoke-plan`, `bun run check:web`,
  `cargo fmt --all --check`, `git diff --check`, and `bun run check`:
  passed after adding the Realtime settlement replay-marker foundation. The
  Worker now has D1 migration `0018_realtime_settlement_replays.sql`,
  repository helpers for applied marker lookup/recording, a duplicate replay
  skip path, and redacted DO metrics exposing only `replay_key_hash` plus
  `replay_recorded` state. This remains pre-production-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until quota mutation, replay
  marker creation, and final audit rows are proven through a single D1
  transaction or equivalent CAS flow. The full check still emits only the
  existing `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:v1-smoke-plan`,
  `bun run check:web`, `cargo fmt --all --check`, `git diff --check`, and
  `bun run check`: passed after adding the default-off Realtime billing D1
  writer foundation. The Durable Object can now apply the private settlement
  mutation plan through the existing D1 reserve/refund/final helper only when
  `REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED=true`; persisted metrics expose
  only redacted write status, quota deltas, skip reasons, and truncated errors.
  This remains pre-production-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until audit rows,
  idempotent replay proof, and staging evidence are archived. The full check
  still emits only the existing `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:v1-smoke-plan`,
  `bun run check:web`, `cargo fmt --all --check`, `git diff --check`, and
  `bun run check`: passed after adding the Realtime billing settlement
  mutation-plan foundation. `/v1/realtime` now carries private user, token,
  channel, selected group, and pre-consumed quota identifiers inside the
  internal settlement handoff for the future D1 write, while persisted metrics,
  socket attachments, smoke summaries, `/api/platform/capabilities`, and the
  frontend Cloudflare Platform panel expose only redacted preview metadata and
  boolean readiness. This still remains pre-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until D1 reserve/refund/final
  audit settlement is implemented and proven. The full check still emits only
  the existing `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun run check:realtime-session:mock-upstream-replay-contract`,
  `bun run check:realtime-session:mock-upstream-usage-plan`,
  `git diff --check`, and `bun run check`: passed after strengthening the
  Realtime mock upstream `response-done-usage` scenario into a billing-preview
  evidence gate. The review-only D1 seed SQL now upserts an isolated
  `billing_setting.billing_mode`/`billing_setting.billing_expr` pair for the
  smoke model, and live/status validation requires redacted
  `last_billing_snapshot` plus `last_billing_settlement_preview` metrics whose
  actual usage fields and reserve/refund/additional quota relationship are
  self-consistent. The tool also fails if the raw expression body appears in
  live replay output. This remains pre-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until D1 reserve/refund/final
  audit settlement is implemented and proven. The full check still emits only
  the existing `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib relay::tests::realtime_billing_request_headers_strip_sensitive_values -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `node --check tools/smoke_realtime_session.mjs`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:upstream-replay-contract`,
  `bun run check:web`, `cargo fmt --all --check`, `git diff --check`, and
  `bun run check`: passed after wiring the Realtime billing settlement preview
  into the internal gateway-to-DO handoff and DO usage metrics. `/v1/realtime`
  now carries the full frozen tiered snapshot plus a bounded, sensitive-header
  filtered request probe only in the private connect handoff; captured
  `response.done` usage records redacted
  `billing_settlement_preview_count`,
  `last_billing_settlement_preview_at_ms`, and
  `last_billing_settlement_preview` metrics without applying quota yet.
  `/api/platform/capabilities`, the Cloudflare Platform panel, and the
  Realtime smoke preflight expose
  `realtime_session_billing_settlement_handoff_compiled`, and the v1 guard set
  includes `billing_settlement_handoff`. This remains pre-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until D1 reserve/refund/final
  audit settlement is implemented and proven. The full check still emits only
  the existing `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_session.mjs`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:upstream-replay-contract`,
  `bun run check:web`,
  `cargo fmt --all --check`,
  `git diff --check`, and `bun run check`: passed after adding the
  Realtime billing pre-settlement snapshot. `/v1/realtime` now freezes a
  redacted tiered billing snapshot before upstream handoff, captures it in
  DO connect metrics, exposes
  `realtime_session_billing_presettlement_snapshot_compiled` through
  `/api/platform/capabilities`, the Cloudflare Platform panel, and smoke
  preflight, and adds `billing_presettlement_snapshot` to the v1 cutover
  guard set. This is still pre-settlement evidence:
  `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` remain false until reserve/refund/final
  audit settlement is implemented and proven. The full check still emits only
  the existing `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun tools/smoke_realtime_upstream_replay.mjs --self-test --json`,
  `bun tools/smoke_realtime_upstream_replay.mjs --dry-run --json --url
  http://127.0.0.1:8787 --api-key dry-run-token --scenario
  response-done-usage`, `bun run
  check:realtime-session:mock-upstream-usage-plan`, `git diff --check`, and
  `bun run check`: passed after adding the Realtime mock upstream
  `response.done` usage replay plan. The harness now proves, in self-test,
  dry-run, and full-check form, that a non-production mock/live replay can
  forward a Realtime-shaped usage frame, then require status metrics to include
  `usage_event_count >= 1` and a metadata-only `last_usage` snapshot before
  normal mock close. This is still pre-settlement evidence:
  `realtime_session_billing_settlement_compiled` remains false until
  reserve/refund/final audit settlement is implemented and proven. The full
  check still emits only the existing `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_session.mjs`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:realtime-session:upstream-replay-contract`,
  `bun run check:web`,
  `cargo fmt --all --check`,
  `git diff --check`, and `bun run check`: passed after wiring
  metadata-only Realtime upstream `response.done` usage capture into
  `RealtimeSession` DO metrics, `/api/platform/capabilities`, the Cloudflare
  Platform frontend panel, and the Realtime smoke preflight. The new
  `realtime_session_upstream_usage_capture_compiled` signal remains a
  pre-settlement guard: `realtime_session_billing_settlement_compiled` and
  `realtime_session_v1_cutover_ready` stay false until reserve/refund/final
  audit settlement is implemented and proven.
- `node --check tools/smoke_task_runner_alarm_replay.mjs`,
  `bun tools/smoke_task_runner_alarm_replay.mjs --self-test --json`,
  `bun tools/smoke_task_runner_alarm_replay.mjs --dry-run --json --url http://127.0.0.1:8787 --task-id task-smoke --expect-replay-evidence first_apply`,
  `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_runner -- --nocapture`,
  and `bun run check:web`: passed after adding the derived TaskRunner
  `replay_evidence` label to the read-only DO status probe, smoke expectations,
  and Cloudflare Platform panel. This classifies first apply, second replay
  no-op, gate-disabled fallback, and cron-already-settled evidence but still
  does not replace live staging replay or rollback evidence.
- `bun run check:web:routes` and `bun run check:web`: passed after extending
  the Cloudflare Platform admin panel with a read-only TaskRunner status probe
  form for `/api/platform/task-runner/:task_id/status`. The route debt baseline
  was intentionally updated from 215 to 216 frontend calls; `missing_calls`
  remained `0`. This adds operator visibility only and does not replace live
  staging replay, rollback, cron fallback, or no-double-poll CAS evidence.
- `node --check tools/smoke_task_runner_alarm_replay.mjs`,
  `bun tools/smoke_task_runner_alarm_replay.mjs --self-test --json`,
  `bun tools/smoke_task_runner_alarm_replay.mjs --dry-run --json --url http://127.0.0.1:8787 --task-id task-smoke`,
  `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_runner -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web:routes`,
  `bun run check:web`,
  `cargo test -p cinatoken-worker --lib`,
  and `bun run check`: passed after adding an admin-only read probe for
  `/api/platform/task-runner/:task_id/status`, exposing
  `task_runner_status_probe_compiled` in `/api/platform/capabilities`, adding
  the Cloudflare Platform panel row, and wiring the read-only TaskRunner alarm
  replay smoke plan into `bun run check`. This is still pre-cutover evidence:
  live staging replay, rollback, cron fallback, and no-double-poll CAS proof
  remain required before `TASK_RUNNER_STAGING_REPLAY_VERIFIED=true`.
- `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_runner -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web`,
  `cargo test -p cinatoken-worker --lib`,
  and `bun run check`: passed after moving the default-off TaskRunner alarm
  from evidence-only to a gated one-shot handoff through the shared
  `poll_one_task` provider poll and D1 CAS settlement path. Cutover remains
  false because `TASK_RUNNER_STAGING_REPLAY_VERIFIED=false` and staging alarm
  replay, rollback, cron fallback, and no-double-poll evidence are still
  required.
- `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_runner -- --nocapture`,
  `cargo test -p cinatoken-worker --lib task_orchestration -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web`,
  `cargo test -p cinatoken-worker --lib`,
  and `bun run check`: passed after wiring default-off TaskRunner submit-path
  arming for successful shared video/remix/Suno task inserts. The new
  `TASK_RUNNER_STAGING_REPLAY_VERIFIED=false` guard keeps cutover false while
  `/api/platform/capabilities` and the Cloudflare Platform panel distinguish
  submit-path compiled from the still-pending alarm poll path and live staging
  replay evidence.
- `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_runner -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web`,
  `cargo test -p cinatoken-worker --lib`,
  `bun run check`,
  `git diff --check`,
  and a repository sensitive-token pattern scan: passed after adding the
  default-off TaskRunner Durable
  Object alarm foundation, `TASK_RUNNER` bindings/migrations, Worker capability
  signals, and frontend Cloudflare Platform rows. The foundation exposes
  deterministic per-task DO instance names, bounded alarm delays, persisted
  alarm-fired evidence, and cutover guards while keeping submit-path arming
  intentionally false.
- `bun tools/smoke_task_refund_batch.mjs --self-test --json`,
  `bun run check:task-refund-batch`,
  `cargo test -p cinatoken-worker --lib task_repository -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web`,
  `bun run check`, and `cargo test -p cinatoken-worker --lib`: passed after
  adding a local SQLite/D1-shape replay contract for async-task refund batches
  and surfacing `task_poller_refund_replay_contract_compiled` in the Worker
  capability probe plus default frontend Cloudflare Platform panel. The harness
  proves timeout, video-provider failure, and Suno failure refunds credit
  user/token quota once behind the CAS-winner marker, verifies legacy imported
  timeout rows fail without refund markers or quota mutation, and shows stale
  timed-out rows no longer hide a newer unfinished task after the sweep.
- `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib task_repository -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:web`,
  `bun run check`,
  and `cargo test -p cinatoken-worker --lib`: passed after moving timeout,
  video-provider, and Suno failure refunds behind a CAS-winner D1 batch marker.
  `/api/platform/capabilities` and the default Cloudflare Platform panel now
  expose `task_poller_refund_batch_compiled`; the Suno batch path also treats a
  non-empty fail reason as terminal `FAILURE` so replay cannot keep observing a
  refunded non-terminal row.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib task_repository -- --nocapture`,
  `cargo test -p cinatoken-worker --lib task_orchestration -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  and `bun run check`: passed after adding the async-task timeout sweep before
  normal Worker cron polling. The sweep uses per-task CAS, preserves the Go
  legacy no-refund cutoff, hardens malformed `private_data` updates, exposes
  task-poller config through `/api/platform/capabilities`, and shows the new
  signals in the default frontend Cloudflare Platform panel.
- `cargo fmt --all`,
  `node --check tools/smoke_wfp_dispatch.mjs`,
  `bun run check:wfp-dispatch:smoke-plan`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo test -p cinatoken-worker --lib wfp_tenant -- --nocapture`,
  and `bun run check:web`: passed after exposing WFP tenant route/guard
  readiness through `/api/platform/capabilities` and the default frontend
  Cloudflare Platform panel. The WFP smoke dry-run now prints the capabilities
  URL and expected tenant route/guard contract; live smoke preflights
  capabilities by default and requires WFP tenant smoke readiness unless
  explicitly run with `--skip-capabilities`.
- `cargo fmt --all`,
  `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun run check:realtime-session:mock-upstream-replay-contract`,
  `bun run check:realtime-session:mock-upstream-replay-plan`,
  `bun run check:realtime-session:mock-upstream-fault-plans`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  and `cargo test -p cinatoken-worker --lib relay -- --nocapture`: passed
  after adding Realtime mock upstream fault injection for
  `upstream-event-stream-failed` and `upstream-accept-failed`. These paths are
  triggered only by explicit
  `channels.other_info.realtime_mock_upstream.fault` metadata on a dedicated
  local/staging mock channel, emit metadata-only terminal bridge events, skip
  client probe forwarding by design, and remain separate from production
  cutover evidence until live artifacts are archived.
- `cargo fmt --all`,
  `cargo test -p cinatoken-session --lib -- --nocapture`,
  `cargo test -p cinatoken-worker --lib admin -- --nocapture`,
  `cargo test -p cinatoken-worker --lib admin_user -- --nocapture`,
  `cargo test -p cinatoken-worker --lib admin_oauth -- --nocapture`,
  `cargo test -p cinatoken-worker --lib relay -- --nocapture`,
  `cargo test -p cinatoken-worker --lib task_orchestration -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `git diff --check`, and `bun run check`: passed
  after adding browser-session revocation epochs. Rust session claims now carry
  `iat` while accepting legacy Rust cookies without that field, D1 migration
  `0017_user_session_epoch.sql` adds `users.session_epoch`, live session
  rechecks reject `iat < session_epoch`, password changes reissue the current
  browser session after bumping the epoch, and admin disable/delete/role or
  password-reset paths revoke target users' stale cookies. Playground relay and
  video content session paths now use live auth instead of direct cookie
  parsing, and video content API-token fallback rejects non-enabled token
  owners. The full Bun gate covered frontend build/redaction/budget/lint,
  route audit (215 frontend calls / 307 Worker routes / 0 missing calls), WFP
  dry-run checks, Realtime smoke contracts, workspace tests excluding the
  Worker, and Worker/WFP wasm32 checks. Existing Worker warnings were limited
  to the known `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib admin_oauth -- --nocapture`,
  `bun run check:web`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `git diff --check`, and `bun run check`: passed after adding
  browser-bound OAuth state for the fixed GitHub/OIDC/Discord callbacks.
  `/api/oauth/state` now returns a Go-compatible bare state string while
  setting a short-lived HttpOnly `/api/oauth` browser-binding cookie; callbacks
  require query `state` plus the same-browser cookie before consuming the KV
  state. OAuth bind branches now use live optional session auth. The full Bun
  gate covered frontend build/redaction/budget/lint, route audit
  (215 frontend calls / 307 Worker routes / 0 missing calls), WFP dry-run
  checks, Realtime smoke contracts, workspace tests excluding the Worker, and
  Worker/WFP wasm32 checks. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib admin -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `git diff --check`, and `bun run check`: passed after adding live D1
  session-authorization rechecks. `require_user_auth` now refreshes signed
  cookie claims from the current `users` row before admin/root privilege
  checks, rejects missing or soft-deleted session users, and fails closed unless
  `users.status == USER_STATUS_ENABLED`. Focused admin tests covered stale
  claim refresh plus disabled/soft-deleted live row rejection. The full Bun
  gate covered frontend build/redaction/budget/lint, route audit
  (215 frontend calls / 307 Worker routes / 0 missing calls), WFP dry-run
  checks, Realtime smoke contracts, workspace tests excluding the Worker, and
  Worker/WFP wasm32 checks. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib task_orchestration -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `git diff --check`, and `bun run check`: passed after hardening the OpenAI
  video content proxy against SSRF redirect bypass.
  `GET /v1/videos/:task_id/content` now builds its SSRF-validated outbound HTTP
  request with `RequestRedirect::Error`, so provider-supplied 3xx targets are
  not followed after first-hop validation. The focused
  `video_proxy_redirect_policy_is_fail_closed` test anchors the policy in the
  task-orchestration test filter. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun run check:realtime-session:mock-upstream-replay-contract`,
  `bun run check:realtime-session:mock-upstream-replay-plan`,
  `bun tools/smoke_realtime_upstream_replay.mjs --dry-run --json --url
  http://127.0.0.1:8787 --api-key dry-run-token --scenario
  startup-queue-drain`, `cargo test -p cinatoken-worker --lib
  realtime_session -- --nocapture`, `cargo test -p cinatoken-worker --lib
  relay -- --nocapture`, `cargo check -p cinatoken-worker --target
  wasm32-unknown-unknown`, and `bun run check`: passed after adding the
  Realtime startup queue/drain mock probe. The mock replay harness now has a
  `startup-queue-drain` scenario that uses explicit mock-channel
  `other_info.realtime_mock_upstream.queue_probe_delay_ms` metadata to pause
  upstream accept, observes one queued client frame through WebSocket runtime
  status, and requires the live run to drain that frame to the mock upstream
  without exposing raw payload or API-key material.
- `node --check tools/smoke_realtime_session.mjs`,
  `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun tools/smoke_realtime_session.mjs --self-test-platform-header-boundary --json`,
  `bun tools/smoke_realtime_upstream_replay.mjs --self-test --json`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`, and
  `bun run check`:
  passed after adding Realtime WebSocket runtime-status counters. WebSocket
  `status` frames now expose `active_upstream_bridges`,
  `queued_upstream_frames`, and `queued_upstream_bytes`; the platform
  header-boundary self-test requires zero bridge/queue counters, and the mock
  upstream replay self-test requires one active upstream bridge with an empty
  pending queue before sending its probe frame.
- `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:bridge-replay-contract`,
  `bun tools/smoke_realtime_session.mjs --self-test-platform-header-boundary`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`,
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`, and
  `bun run check`:
  passed after wiring the Realtime upstream backpressure runtime queue. The
  Durable Object bridge now queues bounded transient client frames until the
  upstream socket is accepted, drains them FIFO, exposes
  `queued_upstream_frames` / `queued_upstream_bytes` in status responses, and
  reports
  `realtime_session_upstream_bridge_backpressure_runtime_compiled` while full
  upstream bridge and billing settlement readiness remain false.
- `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:bridge-replay-contract`,
  `cargo fmt --all --check`,
  `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`, and
  `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after adding the Realtime upstream backpressure policy contract. The
  bridge replay self-test now includes a metadata-only
  `backpressure_overflow_text` terminal case, and platform capabilities expose
  `realtime_session_upstream_bridge_backpressure_policy_compiled` while keeping
  full upstream bridge and billing settlement readiness false.
- `bun run check`: passed after adding the Realtime upstream backpressure
  policy contract. The run covered frontend build and audits, WFP dry-run
  smoke, Realtime bridge replay/upstream replay/mock upstream replay/platform
  header-boundary/frame-limit/v1 dry-run smoke plans, relay AI Gateway canary
  dry-run, Rust workspace tests excluding the Worker, Worker wasm32 check, and
  WFP tenant wasm32 check; existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_upstream_replay.mjs`,
  `bun run check:realtime-session:mock-upstream-replay-contract`, and
  `bun run check:realtime-session:mock-upstream-replay-plan`: passed after
  adding the Realtime mock upstream replay harness and local D1 seed plan. The
  tool provides a `--confirm-live` local/mock WebSocket replay path for
  `upstream-normal-close` and `upstream-frame-limit`, while the default check
  chain validates the harness expectations and a redacted dry-run plan without
  opening a network socket. The dry-run now emits review-only SQL for a
  dedicated local/staging smoke user, relay token, OpenAI-compatible channel,
  and ability row.
- `bun run check`: passed after wiring the Realtime mock upstream replay
  contract and dry-run plan into the default chain. The run covered frontend
  build and audits, WFP dry-run smoke, Realtime bridge replay/upstream replay/
  mock upstream replay/platform-header-boundary/frame-limit/v1 dry-run smoke
  plans, relay AI Gateway canary dry-run, Rust workspace tests excluding the
  Worker, Worker wasm32 check, and WFP tenant wasm32 check; existing warnings
  were limited to the known `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:bridge-replay-contract`,
  `bun run check:realtime-session:upstream-replay-contract`,
  `bun run check:realtime-session:smoke-plan`, and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream replay contract gate. The new self-test validates ordered
  replay scenarios from active bridge status through forwarded frame metadata,
  terminal event, client close mapping, persisted terminal evidence, and
  negative redaction/status/close cases without opening a network socket.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Rust-side
  `realtime_session_upstream_bridge_replay_contract_compiled` contract
  (44 filtered Realtime/platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_replay_contract_compiled` in platform
  capabilities and requiring it in v1 cutover readiness while keeping full
  upstream bridge and billing settlement false (13 platform tests; existing
  `d1_repositories.rs` dead-code warnings only).
- `bun run check:web`: passed after adding the Cloudflare Platform UI type,
  readiness count, and row for the Realtime upstream replay contract.
- `bun run check`: passed after adding the Realtime upstream replay contract
  gate to the default check chain. The run covered frontend build and audits,
  WFP dry-run smoke, Realtime bridge replay, upstream replay, platform
  header-boundary, platform/frame-limit/v1 dry-run smoke plans, relay AI
  Gateway canary dry-run, Rust workspace tests excluding the Worker, Worker
  wasm32 check, and WFP tenant wasm32 check; existing warnings were limited to
  the known `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:platform-header-boundary-contract`, and
  `bun run check:realtime-session:platform-header-boundary-plan`: passed after
  adding a Realtime platform header-boundary smoke mode. The local contract
  self-test proves the verifier rejects forged upstream handoff markers,
  caller-supplied upstream plans, active bridge statuses, and active bridge
  counts; the dry-run plan now emits the forged internal upstream header names
  and sets `expectPlatformHeaderBoundary=true`.
- `bun run check`: passed after adding the Realtime platform header-boundary
  contract and dry-run plan to the default check chain. The run covered
  frontend build and audits, WFP dry-run smoke, Realtime bridge replay,
  platform smoke, platform header-boundary contract/plan, frame-limit and v1
  dry-run smoke plans, relay AI Gateway canary dry-run, Rust workspace tests
  excluding the Worker, Worker wasm32 check, and WFP tenant wasm32 check;
  existing warnings were limited to the known `d1_repositories.rs` dead-code
  warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime platform upstream-header boundary,
  filtering caller-supplied internal upstream handoff headers from the platform
  gateway path, and moving trusted `/v1/realtime` handoff injection onto a
  mutable cloned request (43 filtered Realtime/platform tests; existing
  `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_platform_header_boundary_compiled` in platform
  capabilities and requiring it in platform smoke readiness plus the v1 cutover
  readiness matrix while keeping full bridge and billing false (13 platform
  tests; existing `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs`,
  `bun run check:realtime-session:smoke-plan`, and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime platform header-boundary capability and cutover guard checks.
- `bun run check:web`: passed after adding
  `realtime_session_platform_header_boundary_compiled` to the Cloudflare
  Platform settings panel type, readiness count, and capability row.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Realtime platform upstream-header boundary (known
  `d1_repositories.rs` dead-code warnings only).
- `bun run check`: passed after adding the Realtime platform header-boundary
  capability to the default smoke/readiness chain. The run covered frontend
  build and audits, WFP dry-run smoke, Realtime bridge replay/platform/frame
  limit/v1 dry-run smoke plans, relay AI Gateway canary dry-run, Rust workspace
  tests excluding the Worker, Worker wasm32 check, and WFP tenant wasm32 check;
  existing warnings were limited to the known `d1_repositories.rs` dead-code
  warnings.
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:bridge-replay-contract`: passed after adding
  the Realtime bridge replay contract self-test. The self-test covers
  upstream normal/reserved/application close-code mapping, upstream error,
  upstream event-stream/accept failures, client-to-upstream send failure,
  upstream-to-client send failure, frame-too-large metadata, and raw
  probe/API-key leakage rejection without requiring a live upstream socket.
- `bun run check`: passed after adding the Realtime bridge replay contract
  self-test to the default check chain. Existing warnings were limited to the
  known `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:frame-limit-smoke-plan`: passed after adding
  `--expect-frame-limit-event`, `--frame-limit-bytes`, frame-limit close
  validation, and persisted `last_bridge_terminal_event` validation to the
  Realtime smoke harness.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream bridge terminal event trace,
  `last_bridge_terminal_event` metrics field, metadata-only live
  `realtime_session_bridge_event` frames, and event-trace compiled self-check
  (41 filtered Realtime/platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_event_trace_compiled` in platform
  capabilities and requiring it in the v1 cutover readiness matrix while
  keeping full bridge and billing false (13 platform tests; existing
  `d1_repositories.rs` dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Realtime upstream bridge event trace (known
  `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream bridge event-trace capability and cutover guard checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform event
  trace capability field and row.
- `bun run check`: passed after adding the Realtime frame-limit terminal event
  smoke plan to the default check chain. The run
  covered frontend type/build, bundle redaction audit, bundle budget audit,
  lint-debt baseline, frontend route audit, WFP tenant deploy-plan dry-run, WFP
  dispatch smoke dry-run, RealtimeSession platform, frame-limit, and v1 dry-run smoke plans,
  relay AI Gateway canary smoke dry-run, WFP tenant Worker-script tests,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, Worker
  wasm32 check, and WFP tenant wasm32 check. Existing warnings were limited to
  the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream bridge send-failure guard,
  fail-closed client-to-upstream and upstream-to-client close mappings,
  best-effort metadata-only failure control frames, and compiled self-check (38
  filtered Realtime/platform tests; existing `d1_repositories.rs` dead-code
  warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_send_failure_guard_compiled` in platform
  capabilities and requiring it in v1 cutover readiness while keeping full
  bridge and billing false (13 platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Realtime upstream bridge send-failure guard (known
  `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream bridge send-failure capability and cutover guard checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform
  send-failure guard capability field and row.
- `bun run check`: passed after adding the Realtime upstream bridge
  send-failure guard, fail-closed close actions, platform capability signal,
  frontend Cloudflare Platform row, smoke preflight guard, and migration docs.
  The run covered frontend type/build, bundle redaction audit, bundle budget
  audit, lint-debt baseline, frontend route audit, WFP tenant deploy-plan
  dry-run, WFP dispatch smoke dry-run, RealtimeSession platform and v1 dry-run
  smoke plans, relay AI Gateway canary smoke dry-run, WFP tenant Worker-script
  tests, `cargo fmt --all --check`, Rust workspace tests excluding the Worker,
  Worker wasm32 check, and WFP tenant wasm32 check. Existing warnings were
  limited to the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream bridge close/error mapping contract,
  deterministic client/upstream close actions, unsafe upstream close-code
  sanitization, and close-mapping compiled self-check (36 filtered
  Realtime/platform tests; existing `d1_repositories.rs` dead-code warnings
  only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_close_mapping_compiled` in platform
  capabilities and requiring it in v1 cutover readiness while keeping full
  bridge and billing false (13 platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Realtime upstream bridge close/error mapping contract (known
  `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream bridge close-mapping capability and cutover guard checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform close
  mapping capability field and row.
- `bun run check`: passed after adding the Realtime upstream bridge close/error
  mapping contract, deterministic client/upstream close actions, platform
  capability signal, frontend Cloudflare Platform row, smoke preflight guard,
  and migration docs. The run covered frontend type/build, bundle redaction
  audit (460 files, 37,301,380 bytes, 0 findings), bundle budget audit (245
  files, 18.97 MB raw / 4.50 MB gzip, all 10 budgets OK), lint-debt baseline
  (0 errors / 0 warnings / 0 regressions), frontend route audit (215
  Worker-facing calls / 307 Worker routes / 0 missing calls), WFP tenant
  deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession platform and
  v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run, WFP tenant
  Worker-script tests (8 passed), `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, Worker wasm32 check, and WFP tenant wasm32 check.
  Existing warnings were limited to the known `d1_repositories.rs` dead-code
  warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream bridge frame guard, byte-bounded
  text/binary forwarding checks, 1009 message-too-big close handling, UTF-8
  byte-count coverage, upstream bridge teardown for rejected client frames, and
  frame-guard compiled self-check (34 filtered Realtime/platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_frame_guard_compiled` in platform
  capabilities and requiring it in v1 cutover readiness while keeping full
  bridge and billing false (13 platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Realtime upstream bridge frame guard (known
  `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream bridge frame guard capability and cutover guard checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform frame
  guard capability field and row.
- `bun run check`: passed after adding the Realtime upstream bridge frame
  guard, 1 MiB text/binary forwarding checks, 1009 message-too-big close
  handling, upstream bridge teardown for rejected client frames, platform
  capability signal, frontend Cloudflare Platform row, smoke preflight guard,
  and migration docs. The run covered frontend type/build, bundle redaction
  audit (460 files, 37,301,016 bytes, 0 findings), bundle budget audit (245
  files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets OK), lint-debt baseline
  (0 errors / 0 warnings / 0 regressions), frontend route audit (215
  Worker-facing calls / 307 Worker routes / 0 missing calls), WFP tenant
  deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession platform and
  v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run, WFP tenant
  Worker-script tests (8 passed), `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, Worker wasm32 check, and WFP tenant wasm32 check.
  Existing warnings were limited to the known `d1_repositories.rs` dead-code
  warnings.
- `bun run check`: passed after adding the Realtime upstream bridge lifecycle,
  transient DO bridge registry, active client-to-upstream forwarding,
  upstream-to-client event pump, platform capability signal, frontend
  Cloudflare Platform row, smoke preflight guard, and migration docs. The run
  covered frontend type/build, bundle redaction audit (460 files, 37,300,658
  bytes, 0 findings), bundle budget audit (245 files, 18.96 MB raw / 4.50 MB
  gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings / 0
  regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession platform and v1 dry-run smoke plans, relay AI
  Gateway canary smoke dry-run, WFP tenant Worker-script tests (8 passed),
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, Worker
  wasm32 check, and WFP tenant wasm32 check. Existing warnings were limited to
  the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream bridge lifecycle registry, active
  client-to-upstream forwarding, upstream event pump, explicit
  `upstream_bridge_not_active` hibernation/restart behavior, close-code
  mapping, and lifecycle compiled self-check (31 filtered Realtime/platform
  tests; existing `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_lifecycle_compiled` in platform
  capabilities and requiring it in v1 cutover readiness while keeping full
  bridge and billing false (13 platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after wiring the transient Realtime upstream bridge lifecycle (known
  `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  Realtime upstream bridge lifecycle capability and cutover guard checks.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform
  lifecycle capability field and row.
- `bun run check`: passed after adding the Realtime upstream fetch-upgrade
  adapter, platform capability signal, frontend Cloudflare Platform row, smoke
  preflight assertion, and cinaVibeSDK production mapping docs. The run covered
  frontend type/build, bundle redaction audit (460 files, 37,300,273 bytes, 0
  findings), bundle budget audit (245 files, 18.96 MB raw / 4.50 MB gzip, all
  10 budgets OK), lint-debt baseline (0 errors / 0 warnings / 0 regressions),
  frontend route audit (215 Worker-facing calls / 307 Worker routes / 0
  missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke dry-run,
  RealtimeSession platform and v1 dry-run smoke plans, relay AI Gateway canary
  smoke dry-run, WFP tenant Worker-script tests (8 passed),
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, Worker
  wasm32 check, and WFP tenant wasm32 check. Existing warnings were limited to
  the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream fetch-upgrade adapter and Azure
  handoff request-plan assertions (27 filtered Realtime/platform tests; existing
  `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_fetch_upgrade_adapter_compiled` in platform
  capabilities and requiring it in v1 cutover readiness (13 platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the fetch-upgrade adapter (known `d1_repositories.rs` dead-code
  warnings only).
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform
  capability field and row.
- `node --check tools/smoke_realtime_session.mjs` and
  `bun run check:realtime-session:v1-smoke-plan`: passed after adding the
  upstream fetch-upgrade adapter capability and cutover guard checks.
- `bun run check`: passed after adding the Realtime upstream connect handoff,
  gateway-to-DO secret-bearing request header, frontend Cloudflare Platform
  row, smoke preflight assertion, and migration docs. The run covered frontend
  type/build, bundle redaction audit (460 files, 37,299,894 bytes, 0 findings),
  bundle budget audit (245 files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets
  OK), lint-debt baseline (0 errors / 0 warnings / 0 regressions), frontend
  route audit (215 Worker-facing calls / 307 Worker routes / 0 missing calls),
  WFP tenant deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession
  platform and v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run,
  WFP tenant Worker-script tests (8 passed), `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, Worker wasm32 check, and WFP tenant
  wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream connect handoff, gateway-to-DO
  secret-bearing request header, fetch-upgrade request plan checks, and
  attachment/metrics no-secret serialization assertions (25 filtered
  Realtime/platform tests; existing `d1_repositories.rs` dead-code warnings
  only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_connect_handoff_compiled` in platform
  capabilities and requiring it in v1 cutover readiness (13 platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs`: passed after adding the
  upstream connect-handoff capability to live capabilities preflight.
- `bun run check`: passed after adding the Realtime upstream connect-contract
  capability, frontend Cloudflare Platform row, smoke preflight assertion, and
  migration docs. The run covered frontend type/build, bundle redaction audit
  (460 files, 37,299,515 bytes, 0 findings), bundle budget audit (245 files,
  18.96 MB raw / 4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0
  errors / 0 warnings / 0 regressions), frontend route audit (215
  Worker-facing calls / 307 Worker routes / 0 missing calls), WFP tenant
  deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession platform and
  v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run, WFP tenant
  Worker-script tests (8 passed), `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, Worker wasm32 check, and WFP tenant wasm32 check.
  Existing warnings were limited to the known `d1_repositories.rs` dead-code
  warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream connect contract, request-scoped
  secret-bearing OpenAI/Azure connect spec, and redacted-plan serialization
  checks (21 filtered Realtime/platform tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_bridge_connect_contract_compiled` in platform
  capabilities and requiring it in v1 cutover readiness (13 platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs`, `bun run
  check:realtime-session:smoke-plan`, and `bun run
  check:realtime-session:v1-smoke-plan`: passed after requiring the upstream
  connect-contract capability in live capabilities preflight while preserving
  dry-run redaction of Realtime subprotocol credentials.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform
  connect-contract capability row and frontend platform capability type.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after the connect-contract changes; warnings were limited to the known
  `d1_repositories.rs` dead-code items.
- `bun run check`: passed after adding the Realtime upstream channel selection
  planner, redacted upstream-plan DO attachment/status context, platform
  capability signal, frontend Cloudflare Platform row, smoke preflight
  assertion, and migration docs. The run covered frontend type/build, bundle
  redaction audit (460 files, 37,299,107 bytes, 0 findings), bundle budget
  audit (245 files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets OK),
  lint-debt baseline (0 errors / 0 warnings / 0 regressions), frontend route
  audit (215 Worker-facing calls / 307 Worker routes / 0 missing calls), WFP
  tenant deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession
  platform and v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run,
  WFP tenant Worker-script tests (8 passed), `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, Worker wasm32 check, and WFP tenant
  wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the Realtime upstream channel planner and redacted
  upstream-plan header round-trip checks (17 filtered Realtime/platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing
  `realtime_session_upstream_channel_planner_compiled` in platform
  capabilities and requiring it for v1 cutover readiness (13 platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `node --check tools/smoke_realtime_session.mjs`, `bun run
  check:realtime-session:smoke-plan`, and `bun run
  check:realtime-session:v1-smoke-plan`: passed after requiring the upstream
  bridge and channel planner capabilities in live capabilities preflight while
  preserving redacted dry-run Realtime subprotocol output.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding and formatting the Cloudflare
  Platform row and frontend platform capability type.
- `bun run check`: passed after adding the Realtime Durable Object readiness
  contract, frontend Cloudflare Platform rows, capabilities preflight support
  in `tools/smoke_realtime_session.mjs`, and the
  `check:realtime-session:v1-smoke-plan` root check. The run covered frontend
  type/build, bundle redaction audit (460 files, 37,298,402 bytes, 0 findings),
  bundle budget audit (245 files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets
  OK), lint-debt baseline (0 errors / 0 warnings / 0 regressions), frontend
  route audit (215 Worker-facing calls / 307 Worker routes / 0 missing calls),
  WFP tenant deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession
  platform and v1 dry-run smoke plans, relay AI Gateway canary smoke dry-run,
  WFP tenant Worker-script tests (8 passed), `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, Worker wasm32 check, and WFP tenant
  wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture`:
  passed after exposing Realtime cutover guards and readiness helpers (13
  platform tests; existing `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib realtime_session -- --nocapture`:
  passed after adding the shared Realtime cutover guard list (11 filtered
  Realtime/platform tests; existing `d1_repositories.rs` dead-code warnings
  only).
- `node --check tools/smoke_realtime_session.mjs`, `bun run
  check:realtime-session:smoke-plan`, and `bun run
  check:realtime-session:v1-smoke-plan`: passed after adding capabilities
  preflight options and redacted OpenAI-compatible Realtime subprotocol
  dry-run output.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after extending the Cloudflare Platform
  Realtime readiness panel and platform capability types.
- `bun run check`: passed after adding the main relay AI Gateway canary smoke
  harness and wiring `check:relay-ai-gateway:smoke-plan` into the root check.
  The run covered frontend type/build, bundle redaction audit (460 files,
  37,295,970 bytes, 0 findings), bundle budget audit (245 files, 18.96 MB raw /
  4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings /
  0 regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession smoke dry-run, relay AI Gateway canary smoke
  dry-run, WFP tenant Worker-script tests (8 passed), `cargo fmt --all
  --check`, Rust workspace tests excluding the Worker, Worker wasm32 check, and
  WFP tenant wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `node --check tools/smoke_relay_ai_gateway_canary.mjs`, `bun run
  check:relay-ai-gateway:smoke-plan`, `bun tools/smoke_relay_ai_gateway_canary.mjs
  --help`, and targeted relay dry-runs for `/v1/chat/completions`,
  `/v1/responses`, and `/v1/messages`: passed after adding the staging
  canary harness. The `/v1/messages` guard rejected a Workers AI `@cf/...`
  model as expected.
- `bun run check`: passed after adding the channel editor **Cloudflare AI
  Gateway canary** toggle and documenting the M7 operator-control closure. The
  run covered frontend type/build, bundle redaction audit (460 files,
  37,295,970 bytes, 0 findings), bundle budget audit (245 files, 18.96 MB raw /
  4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings /
  0 regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession smoke dry-run, WFP tenant Worker-script tests (8
  passed), `cargo fmt --all --check`, Rust workspace tests excluding the
  Worker, Worker wasm32 check, and WFP tenant wasm32 check. Existing warnings
  were limited to the known `d1_repositories.rs` dead-code warnings.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the channel editor
  **Cloudflare AI Gateway canary** toggle, wiring create/update payloads to
  `other_info`, parsing compatible existing opt-in metadata, and normalizing
  writes to `{"ai_gateway":{"enabled":true}}`.
- `bun run check`: passed after adding the main relay AI Gateway same-channel
  direct fallback and exposing `relay_ai_gateway_same_channel_fallback_compiled`
  in the Cloudflare Platform panel. The run covered frontend type/build, bundle
  redaction audit (460 files, 37,293,618 bytes, 0 findings), bundle budget audit
  (245 files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets OK), lint-debt
  baseline (0 errors / 0 warnings / 0 regressions), frontend route audit (215
  Worker-facing calls / 307 Worker routes / 0 missing calls), WFP tenant
  deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession smoke
  dry-run, WFP tenant Worker-script tests (8 passed), `cargo fmt --all
  --check`, Rust workspace tests excluding the Worker, Worker wasm32 check, and
  WFP tenant wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-worker --lib relay_ai_gateway -- --nocapture`:
  passed after adding the main relay AI Gateway same-channel direct fallback
  capability signal and status-table coverage (8 AI Gateway/platform tests;
  existing `d1_repositories.rs` dead-code warnings only).
- `cargo test -p cinatoken-worker --lib relay -- --nocapture`: passed after
  routing retryable AI Gateway responses and Gateway fetch errors through the
  same selected provider channel before the existing cross-channel retry loop
  (114 tests; existing `d1_repositories.rs` dead-code warnings only).
- `cargo fmt --all --check`: passed after the AI Gateway same-channel fallback
  and Cloudflare Platform panel capability row.
- `bun run check`: passed after wiring the main relay JSON path to the
  default-off Cloudflare AI Gateway REST forwarder and exposing
  `relay_ai_gateway_rest_forwarder_compiled` in the Cloudflare Platform panel.
  The run covered frontend type/build, bundle redaction audit (460 files,
  37,293,347 bytes, 0 findings), bundle budget audit (245 files, 18.96 MB raw /
  4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings /
  0 regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession smoke dry-run, WFP tenant Worker-script tests (8
  passed), `cargo fmt --all --check`, Rust workspace tests excluding the
  Worker, Worker wasm32 check, and WFP tenant wasm32 check. Existing warnings
  were limited to the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-providers`: passed after reusing the provider-owned
  AI Gateway cutover planner for the main relay forwarder (17 tests).
- `cargo test -p cinatoken-worker --lib relay`: passed after adding the relay
  AI Gateway runtime gate, channel opt-in/default-direct planning, and REST
  request builder tests (113 tests; existing `d1_repositories.rs` dead-code
  warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed after
  exposing the compiled forwarder capability in `/api/platform/capabilities`
  (10 tests; existing `d1_repositories.rs` dead-code warnings only).
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform panel
  row for the compiled main relay AI Gateway REST forwarder.
- `cargo fmt --all --check`, `cargo check -p cinatoken-worker --target
  wasm32-unknown-unknown`, `bun run check:web:bundle`, `bun run
  check:web:bundle-budget`, and `bun run check:web:routes`: passed for the
  final documentation/forwarder verification pass.
- `bun run check`: passed after wiring relay channel `other_info` into the main
  relay AI Gateway opt-in metadata path and exposing
  `relay_ai_gateway_channel_opt_in_supported` in the Cloudflare Platform panel.
  The run covered frontend type/build, bundle redaction audit (460 files,
  37,293,096 bytes, 0 findings), bundle budget audit (245 files, 18.96 MB raw /
  4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings /
  0 regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession smoke dry-run, WFP tenant Worker-script tests (8
  passed), `cargo fmt --all --check`, Rust workspace tests excluding the
  Worker, Worker wasm32 check, and WFP tenant wasm32 check. Existing warnings
  were limited to the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-storage`: passed after adding relay channel
  `other_info` and AI Gateway opt-in metadata parsing (4 tests).
- `cargo test -p cinatoken-relay cache::tests`: passed after adding
  `other_info` to cached relay channels (5 tests).
- `cargo test -p cinatoken-worker --lib relay`: passed after selecting channel
  `other_info` from D1 relay queries (109 tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed after adding
  the channel opt-in metadata support signal to `/api/platform/capabilities`
  (10 tests; existing `d1_repositories.rs` dead-code warnings only).
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the Cloudflare Platform panel
  row for channel opt-in metadata support.
- `bun run check`: passed after adding the main relay AI Gateway cutover guard
  policy and exposing `relay_ai_gateway_cutover_guards` in the Cloudflare
  Platform panel. The run covered frontend type/build, bundle redaction audit
  (460 files, 37,292,857 bytes, 0 findings), bundle budget audit (245 files,
  18.96 MB raw / 4.50 MB gzip, all 10 budgets OK), lint-debt baseline (0
  errors / 0 warnings / 0 regressions), frontend route audit (215
  Worker-facing calls / 307 Worker routes / 0 missing calls), WFP tenant
  deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession smoke
  dry-run, WFP tenant Worker-script tests (8 passed), `cargo fmt --all
  --check`, Rust workspace tests excluding the Worker, Worker wasm32 check, and
  WFP tenant wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-providers`: passed after adding the main relay
  AI Gateway cutover guard policy (17 tests), including router/channel opt-in
  gates, provider-prefix enforcement, custom `base_url` direct fallback, and
  Workers AI Messages schema rejection.
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed after
  exposing compiled main relay AI Gateway cutover guards in
  `/api/platform/capabilities` (10 tests; existing `d1_repositories.rs`
  dead-code warnings only).
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the cutover guard policy row
  to the Cloudflare Platform settings panel.
- `bun run check`: passed after adding the main relay AI Gateway REST readiness
  planner, default-off `RELAY_AI_GATEWAY_ROUTER_ENABLED` config, and read-only
  frontend readiness panel. The run covered frontend type/build, bundle
  redaction audit (460 files, 37,292,545 bytes, 0 findings), bundle budget
  audit (245 files, 18.96 MB raw / 4.50 MB gzip, all 10 budgets OK),
  lint-debt baseline (0 errors / 0 warnings / 0 regressions), frontend route
  audit (215 Worker-facing calls / 307 Worker routes / 0 missing calls), WFP
  tenant deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession smoke
  dry-run, WFP tenant Worker-script tests (8 passed), `cargo fmt --all
  --check`, Rust workspace tests excluding the Worker, Worker wasm32 check, and
  WFP tenant wasm32 check. Existing warnings were limited to the known
  `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-providers`: passed after adding the main relay
  AI Gateway REST readiness planner, endpoint URL helper, and model author
  classifier (12 tests).
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed after
  exposing main relay AI Gateway readiness in `/api/platform/capabilities` (9
  tests; existing `d1_repositories.rs` dead-code warnings only).
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed after adding the read-only AI Gateway
  router readiness group to the Cloudflare Platform settings panel.
- `cargo fmt --all --check`: passed after the main relay AI Gateway readiness
  planner increment.
- `bun run check`: passed after adding the provider route registry, Cloudflare
  AI Gateway URL helpers, and layered gateway architecture document. The run
  covered frontend type/build, bundle redaction audit (460 files, 37,290,926
  bytes, 0 findings), bundle budget audit (245 files, 18.95 MB raw / 4.50 MB
  gzip, all 10 budgets OK), lint-debt baseline (0 errors / 0 warnings / 0
  regressions), frontend route audit (215 Worker-facing calls / 307 Worker
  routes / 0 missing calls), WFP tenant deploy-plan dry-run, WFP dispatch smoke
  dry-run, RealtimeSession smoke dry-run, WFP tenant Worker-script tests,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker,
  Worker wasm32 check, and WFP tenant wasm32 check. Existing warnings were
  limited to the known `d1_repositories.rs` dead-code warnings.
- `cargo test -p cinatoken-providers`: passed after adding the provider route
  registry and Cloudflare AI Gateway URL helpers (8 tests).
- `cargo test -p cinatoken-worker --lib relay`: passed after routing Worker
  upstream URL selection through `cinatoken-providers::ProviderRegistry`
  (106 relay-focused tests; existing `d1_repositories.rs` dead-code warnings
  only).
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Worker dependency on `cinatoken-providers`; existing warnings
  remained limited to known `d1_repositories.rs` dead-code items.
- `bun run check`: passed after adding the admin Operations -> Cloudflare
  Platform readiness panel and extending `/api/platform/capabilities` with
  Realtime gateway/v1 flag state. The run covered frontend type/build, bundle
  redaction audit (460 files, 37,290,926 bytes, 0 findings), bundle budget
  audit (245 files, 18.95 MB raw / 4.50 MB gzip, all 10 budgets OK),
  lint-debt baseline (0 errors / 0 warnings / 0 regressions), frontend route
  audit (215 Worker-facing calls / 307 Worker routes / 0 missing calls), WFP
  tenant deploy-plan dry-run, WFP dispatch smoke dry-run, RealtimeSession
  smoke dry-run, WFP tenant Worker-script tests (8 passed), `cargo fmt --all
  --check`, Rust workspace tests excluding the Worker, and Worker/WFP wasm32
  checks. Existing warnings were limited to the known `d1_repositories.rs`
  dead-code warnings.
- `cargo test -p cinatoken-worker --lib platform_gateway`: passed (7 tests)
  after extending the platform capability payload with Realtime gateway/v1 flag
  state.
- `bun run typecheck`, `bun run lint`, and `bun run format:check` in
  `apps/web/source/default`: passed for the Cloudflare Platform frontend
  section.
- `bun tools/audit_frontend_routes.mjs --summary --details
  --fail-on-unclassified`: passed after adding the frontend
  `/api/platform/capabilities` call; the intentional baseline update is 215
  frontend Worker-facing calls, detection kinds `call=244` /
  `jsx-attribute=1` / `navigation=1` / `stream=1`, 307 Worker routes, 0
  missing calls, categories `{}`, and unchanged missing-call SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check`: passed after adding the cinaVibeSDK-inspired Cloudflare
  platform foundation (default-off WFP dispatch gateway, AdminAuth platform
  capabilities endpoint, and `RealtimeSession` Durable Object hibernation
  skeleton). The run covered frontend type/build, bundle redaction audit,
  bundle budget audit, zero-debt lint baseline, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 305 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:quality`: passed after closing the imported React strict
  lint debt to zero without weakening the lint rules. The final cleanup moved
  model mutation drawer initialization out of synchronous effect state writes,
  initialized ratio settings saved baselines without render-time ref reads,
  derived tiered-pricing number-input display values during render, and derived
  upstream ratio-sync endpoint defaults without effect-driven state mirroring.
- `bun run check:web:lint-debt`: passed with 0 ESLint errors, 0 warnings,
  0 files with findings, and 0 regressions against
  `tools/frontend_lint_debt_baseline.json`.
- `bun run format:check` in `apps/web/source/default`: passed after removing
  one stale `react-hooks/set-state-in-effect` disable comment from the imported
  frontend source.
- `bun run check`: passed after wiring frontend lint-debt regression checking
  into the main verification chain, covering frontend type/build, bundle
  redaction audit, bundle budget audit, lint-debt baseline, route-debt
  baseline, `cargo fmt --all --check`, Rust workspace tests excluding the
  Worker, and Worker wasm check. The route audit reported 214 frontend
  Worker-facing routes, 304 Worker routes, 0 missing calls, categories `{}`,
  and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:bundle-budget`: passed after adding the executable
  frontend bundle-size budget. It scanned 245 built assets in
  `apps/web/source/default/dist`: 18.95 MB raw / 4.49 MB gzip total,
  18.25 MB raw / 4.14 MB gzip JavaScript, 4.29 MB raw / 1.23 MB gzip
  initial JavaScript, and 5.28 MB raw / 1.00 MB gzip for the largest
  JavaScript chunk; all 10 configured budgets passed.
- `bun run check`: passed after wiring the frontend bundle-size budget into
  the main verification chain, covering frontend type/build, bundle redaction
  audit, bundle budget audit, route-debt baseline, `cargo fmt --all --check`,
  Rust workspace tests excluding the Worker, and Worker wasm check. The route
  audit reported 214 frontend Worker-facing routes, 304 Worker routes, 0
  missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check:web:bundle`: passed after adding the frontend bundle
  redaction audit. It scanned 460 built frontend text assets
  (37,284,076 bytes) across `apps/web/source/default/dist` and
  `apps/web/dist`, with 0 findings.
- `bun run check`: passed after wiring the frontend bundle redaction audit
  into the main verification chain, covering frontend type/build, bundle
  redaction audit, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  reported 214 frontend Worker-facing routes, 304 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the legacy engines embeddings alias.
- `cargo test -p cinatoken-worker --lib json_model_fallback`: passed after
  adding the `/v1/engines/:model/embeddings` path-model fallback.
- `cargo test -p cinatoken-worker --lib static_asset_path_routes_api_paths_to_router`:
  passed after routing `/v1/engines/text-embedding-3-small/embeddings` to the
  Worker router.
- `cargo test -p cinatoken-worker --lib`: 378 passed after adding the legacy
  engines embeddings alias.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the legacy engines embeddings alias; the only warnings were the
  pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the legacy engines embeddings alias,
  covering frontend type/build, route-debt baseline, `cargo fmt --all --check`,
  Rust workspace tests excluding the Worker, and Worker wasm check. The route
  audit reported 214 frontend Worker-facing routes, 304 Worker routes, 0
  missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the Jimeng official video route
  aliases.
- `cargo test -p cinatoken-tasks jimeng --lib`: 9 passed after porting the
  Jimeng submit-response parser.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::jimeng_`:
  3 passed after adding official Jimeng body conversion, fetch-body
  validation, and image/action-selection coverage.
- `cargo test -p cinatoken-worker --lib tests::static_asset_path_routes_api_paths_to_router`:
  passed after routing `/jimeng` and `/jimeng/` to the Worker router.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 24
  passed after adding the Jimeng official video route aliases.
- `cargo test -p cinatoken-worker --lib`: 377 passed after adding the Jimeng
  official video route aliases.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Jimeng aliases; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the Jimeng aliases, covering frontend
  type/build, route-debt baseline, `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, and Worker wasm check. The route audit reported
  214 frontend Worker-facing routes, 304 Worker routes, 0 missing calls,
  categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the Kling official video route
  aliases.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::kling_`: 2
  passed after adding official Kling body conversion and action-selection
  coverage.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 21
  passed after adding the Kling official video route aliases.
- `cargo test -p cinatoken-worker --lib`: 374 passed after adding the Kling
  official video route aliases.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the Kling aliases; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the Kling aliases, covering frontend
  type/build, route-debt baseline, `cargo fmt --all --check`, Rust workspace
  tests excluding the Worker, and Worker wasm check. The route audit reported
  214 frontend Worker-facing routes, 302 Worker routes, 0 missing calls,
  categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the OpenAI video Sora remix submit
  slice.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::remix_`: 2
  passed after adding origin-model precedence and origin-data remix billing
  ratio coverage.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 19
  passed after adding the OpenAI video Sora remix submit slice.
- `cargo test -p cinatoken-worker --lib`: 372 passed after adding the OpenAI
  video Sora remix submit slice.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the remix submit slice; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the remix submit slice, covering
  frontend type/build, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  remained 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding session-auth parity to the OpenAI
  video content proxy.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 17
  passed after adding TokenOrUserAuth-style session fallback coverage for the
  OpenAI video content proxy.
- `cargo test -p cinatoken-worker --lib`: 370 passed after adding session-auth
  parity to the OpenAI video content proxy.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding session-auth parity to the content proxy; the only warnings were
  the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding session-auth parity to the content
  proxy, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit remained 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the first OpenAI video content proxy
  slice.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 16
  passed after adding content-source fallback, self-proxy skip, Vertex data URL
  extraction, and bounded data URL decode coverage.
- `cargo test -p cinatoken-worker --lib`: 369 passed after adding the first
  OpenAI video content proxy slice.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the content proxy slice; the only warnings were the pre-existing
  `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding the content proxy slice, covering
  frontend type/build, route-debt baseline, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  remained 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding provider-specific OpenAI video
  serializer overlays.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 10
  passed after adding Ali status/error mapping, Kling provider time/seconds/error
  mapping, and Gemini/Vertex Veo operation-name model extraction.
- `cargo test -p cinatoken-worker --lib`: 363 passed after adding
  provider-specific OpenAI video serializer overlays.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding provider-specific OpenAI video serializer overlays; the only
  warnings were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after adding provider-specific OpenAI video
  serializer overlays, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit remained 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check`: passed after task-data persistence and OpenAI video
  enrichment, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after task-data persistence and OpenAI video
  enrichment.
- `cargo test -p cinatoken-worker --lib`: 360 passed after persisting raw
  provider task data through submit/poll and enriching OpenAI video fetch from
  stored task data. New/updated tests cover Sora/OpenAI passthrough metadata,
  provider URL fallback, nested first-video URL extraction, and non-Sora
  `created_at` protection.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after task-data persistence and OpenAI video enrichment; the only warnings
  were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun run check`: passed after the OpenAI-compatible video create/fetch shell,
  covering frontend type/build, route-debt baseline, rustfmt check, Rust
  workspace tests excluding the Worker, and Worker wasm check. The route audit
  reported 214 frontend Worker-facing routes, 298 Worker routes, 0 missing
  calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `cargo fmt --all`: passed after adding the OpenAI-compatible video
  create/fetch shell.
- `cargo test -p cinatoken-worker --lib`: 356 passed after adding
  `POST /v1/videos`, `GET /v1/videos/:task_id`, and explicit
  `/v1/videos/:video_id/remix` 501 ownership. The new tests cover the OpenAI
  video submit shell, status/progress/model/result URL mapping, and failure
  error shape.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the OpenAI-compatible video create/fetch shell; the only
  warnings were the pre-existing `dead_code` warnings in `d1_repositories.rs`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  214 frontend Worker-facing routes, detection kinds
  `call=243` / `jsx-attribute=1` / `navigation=1` / `stream=1`,
  295 Worker routes, 0 missing calls, categories `{}`, SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run check`: passed after the broadened frontend route-audit slice,
  covering frontend build, route-debt baseline, rustfmt check, Rust workspace
  tests excluding the Worker, and Worker wasm check.
- `cargo test -p cinatoken-worker --lib`: 353 passed after adding the
  fail-closed video-content route boundary.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed
  after adding the fail-closed `/v1/videos/:task_id/content` Worker route;
  the only warnings were the pre-existing `dead_code` warnings in
  `d1_repositories.rs`.
- `cargo fmt --all --check`: passed after broadening the frontend route audit
  and adding the video-content route boundary.
- `cargo test -p cinatoken-worker --lib`: 350 passed after CSPRNG hardening for
  relay weighted channel selection; generated user access tokens, affiliation
  codes, and subscription balance-pay order suffixes remain covered.
- `cargo test -p cinatoken-worker --lib relay::tests::`: 102 passed for the
  relay planner, bounded random draw, and RNG error-propagation tests.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same relay CSPRNG hardening slice.
- `cargo fmt --all --check`: passed for the same relay CSPRNG hardening slice.
- `rg -n "Math::random|js_sys::Math" crates/worker/src`: no matches.
- Fetched the current Cloudflare Worker references and latest
  `@cloudflare/workers-types` with `npm pack`; observed version
  `5.20260704.1`.
- `bun run check`: passed after the relay CSPRNG hardening slice, covering the
  frontend build, route-debt baseline, Rust workspace tests excluding the
  Worker, rustfmt check, and Worker wasm check.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  212 frontend calls, 294 Worker routes, 0 missing calls, categories `{}`,
  SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Older entries below are historical evidence; their route-debt counts may be
superseded by the current 0 missing-call / 0 unclassified / 0 deferred-debt
baseline above.

- `cargo test -p cinatoken-worker --lib`: 303 passed after adding Creem wallet
  checkout and webhook settlement at `POST /api/user/creem/pay` and
  `POST /api/creem/webhook`, including Go-compatible `ref_` SHA1 order IDs,
  HMAC-SHA256 raw-body webhook signature checks, product-list parsing, amount
  replay checks, provider-aware credited-anchor settlement, and optional
  empty-email backfill from the verified Creem customer payload.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same Creem wallet/webhook slice.
- `bun run check`: passed after the Creem wallet/webhook slice, covering the
  frontend build, route-debt baseline, Rust workspace tests excluding the Worker,
  rustfmt check, and Worker wasm check.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 244 Worker routes, 36 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 1 payment-deferred,
  SHA-256 `5cdffd5d02a44c03b55467410820893a988a9303d18be2cb1f03b55acb1409fd`.

- `cargo test -p cinatoken-worker --lib`: 298 passed after adding Waffo
  Pancake wallet checkout and webhook settlement at
  `POST /api/user/waffo-pancake/pay` and
  `POST /api/waffo-pancake/webhook/:env`, including authenticated checkout
  session-token/session action helpers, Go-compatible buyer identity and order
  IDs, token-display quota normalization into the Rust D1 final-quota
  invariant, RSA-SHA256 webhook signature parsing, env/identity/amount replay
  checks, provider-aware credited-anchor settlement, and route-gated frontend
  subscription protection.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed for
  the same Waffo Pancake wallet/webhook slice.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 242 Worker routes, 37 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 2 payment-deferred,
  SHA-256 `15339560f12bfb286e08b72afe867ce802b72f7bd3fcd0d21ae741c089ba0af7`.

- `cargo test -p cinatoken-worker --lib`: 292 passed after adding the
  Epay-compatible wallet topup path at `POST /api/user/pay` plus
  `GET/POST /api/user/epay/notify`, including MD5 SDK-signature parity,
  signed purchase-form parameters, CSPRNG order ids, constant-time Epay
  signature comparison, Stripe order suffix CSPRNG hardening, provider-aware D1
  topup writes, bounded notify parsing with required POST `Content-Length`,
  replay-vs-mismatch callback handling, and atomic credited-anchor callback
  settlement that verifies complete/credit/mark batch changes.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 240 Worker routes, 38 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 3 payment-deferred,
  SHA-256 `8968b7ebbb9422657492c9a67dc1177b414ccdebf80873bdfdb55f6503175b9c`.
- `cargo test -p cinatoken-worker --lib`: 286 passed after adding root-only
  Waffo Pancake signed action helpers at
  `POST /api/option/waffo-pancake/pair` and
  `POST /api/option/waffo-pancake/subscription-product`, including
  deterministic SDK-style idempotency keys, short-ID/amount validation,
  SuccessURL serialization, orphan-store response handling, and Go-compatible
  Waffo admin frontend envelopes.
- `bun tools/audit_frontend_routes.mjs --summary --details --fail-on-unclassified`:
  212 frontend calls, 237 Worker routes, 39 missing calls, categories
  13 auth-deferred / 22 capability-hidden-product / 4 payment-deferred,
  SHA-256 `a3ffcf011d892afb7b2a2388b3321b66c64456564271cddccb22e29735b4021c`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`
  passes with the reviewed 38-call route-debt baseline.
- `cargo test -p cinatoken-worker --lib`: 283 passed after adding root-only
  Waffo Pancake catalog reads at `POST /api/option/waffo-pancake/catalog` and
  `POST /api/option/waffo-pancake/subscription-product-options`, including
  signed GraphQL request helpers, timeout/response-size guards, active-product
  filtering, optional-body/content-length parsing, and private-key
  normalization coverage.
- `cargo test -p cinatoken-worker --lib`: 276 passed after adding root-only
  Waffo Pancake config save at `POST /api/option/waffo-pancake/save`, including
  tests for required merchant/store/product fields and the Go-compatible
  "blank private key keeps current key" behavior.
- `cargo test -p cinatoken-worker --lib`: 273 passed after adding Waffo
  Pancake amount estimation at `POST /api/user/waffo-pancake/amount`, keeping
  checkout/callback hidden while covering Go-compatible token-display,
  unit-price, group-ratio, and discount formula parity.
- `cargo test -p cinatoken-worker --lib`: 268 passed after adding wallet/topup
  compatibility: Stripe amount estimation, frontend-compatible Stripe pay link,
  `topup/info`, self/admin topup history pagination, admin manual topup
  completion, and `/api/user/self` affiliation wallet fields.
- `cargo test -p cinatoken-migration`: 23 passed after adding the
  `redemptions.credited` import/default boundary, including automatic
  `status=used -> credited=1` mapping for imported Go redemption rows.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes
  after the Waffo Pancake action-helper batch.
- In-memory SQLite replay of `migrations/d1/0001_core.sql` plus
  `migrations/d1/0013_subscriptions.sql`, confirming
  `subscription_plans`, upgraded `subscription_orders`,
  `subscription_pre_consume_records`, and `user_subscriptions` exist.
- `migrations/d1/0014_redemptions_credited.sql` adds a D1-only redemption
  `credited` anchor and marks already-used imported Go rows as credited.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the Waffo Pancake action-helper batch.
- `cargo test -p cinatoken-worker --lib`: 262 passed after adding public
  rankings, `HeaderNavModules.rankings` access enforcement, live `logs`
  aggregation, status capability exposure, and rankings unit coverage.
- `cargo test -p cinatoken-migration`: 21 passed after adding `checkins` and
  `redemptions` to the D1 import table set.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes
  after the public rankings batch.
- `bun tools/audit_frontend_routes.mjs --summary --details`: 212 frontend
  calls, 213 Worker routes, 63 missing calls, categories 13 auth-deferred / 34
  capability-hidden-product / 16 payment-deferred, SHA-256
  `63b9b8f87ecdf6caa7cb15269c86be22c2cbeed1c27d3f6659258a37f146f6b1`.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`
  passes with the reviewed 63-call route-debt baseline.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the public rankings batch.
- D1 log analytics queries now match the Go/D1 schema: `logs` has no
  `deleted_at` column, so repository log filters and quota/ranking trend
  queries do not add soft-delete predicates to `logs`.
- `cargo test -p cinatoken-worker --lib`: 255 passed after adding admin
  redemption-code management routes, D1-backed redemptions, payment-compliance
  create guard, status-only updates, sidebar exposure, and redemption request
  validation coverage.
- In-memory SQLite replay of `migrations/d1/0001_core.sql` plus
  `migrations/d1/0011_checkins.sql` plus
  `migrations/d1/0012_redemptions.sql`, confirming the `checkins` and
  `redemptions` tables plus their key live-row indexes.
- `cargo fmt --all`
- `cargo test --workspace --exclude cinatoken-worker`
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
- `cargo fmt --all --check` after the async usage-log read batch.
- `cargo test -p cinatoken-worker --lib`: 248 passed after adding
  `/api/mj`, `/api/mj/self`, `/api/task`, and `/api/task/self` read-only
  usage-log lists plus the Midjourney millisecond `submit_time`/`finish_time`
  binding fixes.
- `cargo test -p cinatoken-migration`: 20 passed after adding
  `custom_oauth_providers` and `user_oauth_bindings` to the D1 import table set.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` after the
  async usage-log read batch.
- In-memory SQLite replay of migrations 0001-0010, confirming
  `custom_oauth_providers` and `user_oauth_bindings` exist.
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified`:
  212 frontend calls, 200 Worker routes, 71 missing calls, categories
  13 auth-deferred / 42 capability-hidden-product / 16 payment-deferred,
  SHA-256 `ec37c0cf67e953733ee7e43c291150f17f0d1f859073cc352e7d66b80865e677`.
- `bun run check`: frontend TypeScript/Rsbuild build, route baseline check,
  `cargo fmt --all --check`, workspace tests excluding `cinatoken-worker`, and
  worker wasm check all passed after the async usage-log read batch.
- `cargo test -p cinatoken-worker --lib`: 174 passed after the frontend status
  envelope and setup-status compatibility fixes.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passes after
  the same compatibility fixes.
- `bun install --frozen-lockfile` in `apps/web/source`: 2841 packages installed
  from the tracked workspace lockfile.
- `bun run build:web`: TypeScript and Rsbuild production build pass; the real
  bundle is copied to `apps/web/dist/`.
- `bun run check:web`: frontend type/build contract passes.
- `bunx eslint src/features/models/index.tsx` passes for the Rust capability
  gating added to the imported frontend.
- `bun run format:check` in `apps/web/source/default` passes.
- `/api/status` compatibility tests prove the Go-style envelope data retains
  Rust runtime diagnostics and clamps unsupported sidebar modules.
- `/api/setup` compatibility test proves `data.status=true` means setup is
  complete, matching Go and the React router.
- `cargo test -p cinatoken-relay` covering OpenAI-compatible relay helpers,
  generalized `/v1/...` upstream URL generation, Anthropic Messages URL
  generation, native Gemini path parsing and upstream URL generation, relay
  cache key normalization, token fingerprinting, JSON/SSE usage parsing,
  Responses `response.completed` usage parsing, GPT image generation usage
  parsing, nested usage token details, Anthropic cache usage details,
  Anthropic streaming `message_start`/`message_delta` usage merging, Gemini
  generate and embedding `usageMetadata` parsing, Gemini `countTokens`
  `totalTokens` parsing, Jina/Cohere rerank URL and usage parsing including
  Cohere `search_units`, split streaming byte chunks, and versioned
  token/channel cache wrappers.
- `cargo test -p cinatoken-migration` covering `dev-seed` SQL generation.
- `cargo test -p cinatoken-migration` covering source repository inspection
  argument parsing and local SQLite candidate discovery.
- `cargo test -p cinatoken-migration` covering SQLite export argument parsing,
  default core table selection, `--all`, and unknown-table rejection.
- `cargo test -p cinatoken-migration` covering D1 import SQL argument parsing,
  supported-table validation, SQL literal escaping, and `abilities.group` to
  `abilities.group_name` mapping.
- `cargo test -p cinatoken-migration` covering migration verification argument
  parsing, export-bundle validation, malformed-row rejection, and D1 SQL
  execution against SQLite.
- `bun run inspect:source -- --repo Z:\cinatoken` confirming the source
  checkout has the expected Go/backend/frontend markers.
- Smoke-tested `cinatoken-migrate export --sqlite ... --output ... --table users
  --table tokens` against a temporary SQLite database; JSON output included both
  tables and expected rows.
- Smoke-tested `bun run export:sqlite` followed by `bun run import:d1-sql`
  against a temporary SQLite source database, then executed the generated SQL
  with `python tools/verify_sqlite.py --seed <generated.sql>`.
- Smoke-tested `bun run verify:migration -- --input <export.json> --sql
  <generated.sql>` against a generated export and D1 SQL pair.
- `cargo test -p cinatoken-billing` covering quota conversion, settlement
  primitives, billing expression version/variable detection, expression
  execution helpers, request `param()`/`header()` probes, tiered
  pre-consume/post-consume settlement snapshots, and GPT/OpenAI versus Claude
  token normalization.
- `cargo test -p cinatoken-storage` covering shared storage record helpers.
- `cargo test -p cinatoken-cache` covering Upstash REST command encoding,
  response/error parsing, `/multi-exec` expiring counters, and rate limiter
  decisions.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` covering the
  Worker Upstash Redis REST fetch transport and status feature detection.
- `cargo test -p cinatoken-worker --lib` covering relay rate-limit and
  read-through cache TTL configuration parsing and invalid configuration
  rejection, chat/completions/responses/image generation/audio speech,
  Anthropic, and native Gemini streaming relay gating, D1 provider-family
  channel filters, native Gemini embedding/count non-stream action gating, D1
  billing option parsing, tiered settlement metadata, D1 quota mutation
  guardrails, and the Worker crate after D1 SQL was moved behind repository
  functions.
- `cargo test -p cinatoken-worker --lib` covering Worker request-body token
  estimation, max-token extraction, request-time tiered billing preflight
  snapshots, usage-detail token normalization, and settlement deltas against
  frozen snapshots.
- `cargo test -p cinatoken-worker --lib` covering `/v1/rerank` endpoint
  metadata, Jina channel type `38`, Cohere channel type `34`, local
  non-streaming rejection, Go-compatible `query`/`documents` and integer
  `top_n` validation, Cohere rerank request adaptation, Cohere rerank response
  transformation and request-estimate fallback, rerank request-token estimates, and
  endpoint-specific Jina/Cohere rerank usage parsing.
- `cargo test -p cinatoken-worker --lib` covering visible request-body media
  fallback counts for OpenAI-style and Gemini-style token preflight estimates,
  including request-time `img`/`ai` normalization when expressions reference
  those variables.
- `cargo test -p cinatoken-worker --lib` covering tiered reserve
  fallback/refund metadata and compiling the D1 repository pre-consume quota
  mutation paths.
- `cargo test -p cinatoken-worker --lib` covering tiered usage-log display
  metadata, Go-compatible base64 expression encoding, and matched-tier
  injection.
- `cargo test -p cinatoken-worker --lib` compiling the non-stream cloned
  upstream audit branch and buffered fallback path.
- `cargo test -p cinatoken-worker --lib` covering audio speech endpoint
  routing metadata and response-body usage parsing opt-out.
- `cargo test -p cinatoken-worker --lib` covering streaming missing-usage
  refund reason metadata and compiling the Worker streaming audit/reserve path
  for chat, completions, responses, image generation, Anthropic, and native
  Gemini.
- `cargo test -p cinatoken-worker --lib` covering relay JSON request-body
  limit configuration, invalid limit rejection, invalid JSON reporting, and
  payload-too-large errors before parsing.
- `cargo test -p cinatoken-worker --lib` covering relay JSON response-body
  limit configuration, fixed-body over-limit classification, and stream
  over-limit consumed-body classification for non-stream audit/transform
  guardrails.
- `cargo test -p cinatoken-worker --lib` covering endpoint-specific JSON
  response buffer defaults for embeddings, image generation, rerank, and
  native Gemini, plus the `RELAY_JSON_RESPONSE_LIMIT_BYTES` global override.
- `cargo test -p cinatoken-worker --lib` covering explicit JSON request-body
  mode metadata for current relay endpoints and the shared JSON preparation
  stage boundary.
- `cargo test -p cinatoken-worker --lib` covering the shared bounded relay
  request-byte reader error mapping used by the JSON body parser and future
  raw/multipart body modes.
- `cargo test -p cinatoken-worker --lib` covering JSON relay request
  `Content-Type` policy, including JSON media types and explicit multipart or
  octet-stream rejection before body reads.
- `cargo test -p cinatoken-worker --lib` covering the shared relay
  `Content-Type` policy layer for JSON, multipart, and raw passthrough modes.
- `cargo test -p cinatoken-worker --lib` covering relay request body mode
  metadata for JSON, multipart, raw-bytes, and pass-through stream modes plus
  pending-mode guard metadata.
- No live Jina `/v1/rerank` or `/v1/embeddings`, or Cohere `/v1/rerank`,
  upstream request has been executed yet.
- `bun run dev:seed:sql -- --model gpt-test --token-key ct-test --output .wrangler/dev-seed-test.sql`
  with a local Cargo target directory.
- Python `sqlite3` in-memory execution of `migrations/d1/0001_core.sql` plus
  generated dev seed SQL.
- `python tools/verify_sqlite.py`
- `cargo --version`: `cargo 1.96.0 (30a34c682 2026-05-25)`
- `rustc --version`: `rustc 1.96.0 (ac68faa20 2026-05-25)`
- `bun --version`: `1.3.14`
- `wrangler --version`: `4.101.0`
- Fetched latest `@cloudflare/workers-types` with `npm pack`; observed version
  `5.20260703.1`.
- Refreshed the production migration plan against current official Cloudflare
  Workers best-practices, Workers limits, Workers observability, and D1 limits
  docs; detailed execution gates now live in
  `docs/production-migration-execution-plan.md`.
- Added production readiness matrices and a staging smoke runbook, based on
  source router/model/channel inspection and current Cloudflare Workers
  best-practice, Wrangler config, compatibility date, observability, gradual
  deployment, and rollback references.
- Added Cloudflare production config and cutover/rollback runbooks, using
  current Cloudflare Workers best-practice, Wrangler config, environments,
  gradual deployment, rollback, observability, and D1 backup/restore references.
- Added `docs/data-migration-runbook.md` for production source inventory, export
  artifact policy, D1 import commands, row-count/sample-hash evidence,
  freeze/delta handling, rollback, and redacted import reports.
- Added `docs/billing-parity-runbook.md` after reading
  `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md`; it defines expression
  compatibility, golden fixtures, shadow settlement, billing gates, abort
  triggers, and redacted billing reports.
- Added `docs/route-provider-parity-runbook.md` for G3 route inventory,
  provider adapter contracts, body-mode policy, JSON/SSE smoke, failure-mode
  smoke, usage parser evidence, billing-shadow coupling, and redacted G3
  reports.
- Added `docs/observability-slo-security-runbook.md` for G6 structured logs,
  Workers Logs sampling and retention policy, SLO/abort thresholds, dashboard
  and alert matrices, security controls, staging alert drills, redaction checks,
  and incident templates.
- Added `docs/admin-frontend-parity-runbook.md` for G5 admin API, frontend
  deployment, auth/session strategy, operator CRUD smoke, cache invalidation,
  admin audit, secret redaction, and Scenario B go/no-go evidence.
- Added `docs/performance-capacity-cost-runbook.md` for performance load
  profiles, Worker/D1/Upstash/Queue/R2 capacity checks, cost forecasting,
  bottleneck ownership, and canary/full-cutover go/no-go evidence.
- Added local Cloudflare preflight scripts:
  `bun run check:cf:dry-run` for `wrangler deploy --dry-run --minify` and
  `bun run check:cf:startup` for `wrangler check startup` over a dry-run
  deploy.
- `wrangler.toml` now carries explicit `[env.staging]` and `[env.production]`
  blocks with `REPLACE_WITH_*` placeholder binding IDs, environment-scoped
  observability sampling (staging 1.0, production 0.1), and staging-suffixed
  resource names. The top-level block still describes the local development
  shape. See `docs/cloudflare-production-config-checklist.md` for the SOP.
- Historical note: this checkpoint temporarily widened
  `OPENAI_COMPATIBLE_CHANNEL_TYPES` to 12 OpenAI-shaped providers. The later Go
  dispatch audit superseded that classification: the canonical generic set is
  now `1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47`, and dedicated types require
  route-explicit adapters and fixtures. `default_base_url` still inventories
  provider roots, but URL inventory is not relay readiness.
- Relay now walks the full ordered channel candidate list and retries against
  the next candidate when an upstream returns a retryable status (Go-default
  `AutomaticRetryStatusCodeRanges` minus 504/524) or fetch fails. Reserve is
  applied once before the loop and refunded only when every attempt fails.
  Channels that return the auto-disable status set (default `{401}`) are
  marked disabled best-effort via `disable_channel_best_effort`, and a
  Redis-backed rolling error counter auto-disables channels that exceed
  `RELAY_CHANNEL_AUTOBAN_THRESHOLD` (default 5) within a 60s window.
  `RELAY_RETRY_TIMES` controls the retry budget (default 0 = single attempt).
- `crates/ssrf` ports the Go gateway's `common/ssrf_protection.go` validation
  surface (HTTP/HTTPS only, port allowlist, private/loopback/metadata IPv4
  and IPv6 CIDR table, domain allow/block lists, IP CIDR blocklist) behind a
  `SsrfPolicy`/`SsrfPolicyBuilder` API. 14 unit tests cover the Go parity
  cases. The module is standalone for now and is not wired into any Worker
  route; see `docs/ssrf.md` for the boundary and the DNS-resolution
  limitation.
- `migrations/d1/0002_admin_tables.sql` adds the `vendors` and `models`
  admin tables (mirroring Go `model/vendor_meta.go` and
  `model/model_meta.go`) plus the `logs` indexes (`type`,
  `(created_at, type)`, `token_name`, `channel_id`, `group`, `ip`,
  `username`, `(model_name, username)`) that back the upcoming admin log
  queries and the rpm/tpm stat. Verified via
  `python tools/verify_sqlite.py --seed migrations/d1/0001_core.sql --seed
  migrations/d1/0002_admin_tables.sql`.
- The migration CLI now imports `vendors` and `models` as first-class D1
  tables (`crates/migration/src/main.rs` `D1_IMPORT_TABLES`,
  `VENDORS_D1_COLUMNS`, `MODELS_D1_COLUMNS`, and the importer spec).
- `crates/session` implements the stateless HMAC-signed session cookie codec
  used by the Rust Worker. Format is `base64url(payload_json).base64url(hmac_sha256(payload))`;
  10 unit tests cover round-trip, tamper rejection, expiry, secret-length
  enforcement, and cookie header formatting. See `docs/admin-frontend-parity-runbook.md`
  for the "Forced re-auth on Rust" compatibility boundary (Go-issued cookies
  are not portable to Rust).
- `crates/auth` gained bcrypt password helpers (`hash_password` /
  `verify_password`, Go-compatible PHB format), role/status constants
  (`ROLE_COMMON_USER=1`, `ROLE_ADMIN_USER=10`, `ROLE_ROOT_USER=100`,
  `USER_STATUS_ENABLED=1`, `USER_STATUS_DISABLED=2`), and `is_admin` /
  `is_root` / `outranks` helpers.
- Worker admin auth surface landed: `POST /api/user/login`, `POST
  /api/user/logout`, `GET /api/user/self`, `GET /api/setup`, `POST
  /api/setup`, plus `require_user_auth` / `require_admin_auth` /
  `require_root_auth` middleware helpers in `crates/worker/src/admin.rs`.
  Login verifies bcrypt against `users.password`, issues a signed `session`
  cookie (`HttpOnly; SameSite=Strict; Secure`), and returns a Go-style
  `{success, message, data}` envelope. Setup bootstraps the initial root
  user when none exists.
- `GET /api/status` now reports `session_auth: true` when `SESSION_SECRET`
  is configured and at least 32 bytes long.
- Frontend deploy pipeline is in place: `wrangler.toml` carries an
  `[assets]` block (directory `apps/web/dist`, binding `ASSETS`,
  `not_found_handling = "single-page-application"`) in dev/staging/production;
  the Worker `fetch` handler routes non-API paths through
  `env.assets("ASSETS")` so SPA client-side routes survive hard refresh;
  `package.json` adds `build:web` and `build:all` scripts. The actual
  frontend bundle build and end-to-end smoke are G1 staging steps.
- Admin CRUD P0 routes landed (`crates/worker/src/admin_crud.rs`):
  - Logs: `GET /api/log/`, `GET /api/log/stat`, `DELETE /api/log/`,
    `GET /api/log/self`, `GET /api/log/self/stat` (admin + self paths, with
    self logs stripping `channel_id` and `other` for safety). Deprecated
    `/api/log/search` and `/api/log/self/search` return the Go-compatible
    "deprecated" envelope.
  - Options: `GET /api/option/` (root-only, sensitive keys filtered),
    `PUT /api/option/` (root-only upsert).
  - Tokens: `GET /api/token/`, `GET /api/token/search`, `GET /api/token/:id`,
    `POST /api/token/:id/key` (reveal), `POST /api/token/`, `PUT /api/token/`,
    `DELETE /api/token/:id`, `POST /api/token/batch` — all user-scoped
    (ownership enforced), list/get responses mask keys, create generates a
    `ct-<32 random>` key, and every mutation triggers
    `invalidate_token_cache`.
- Cache invalidation module (`crates/worker/src/cache_invalidation.rs`)
  implements Upstash Redis SCAN + bulk DEL for `relay:auth:*`,
  `relay:channel:*`, `relay:option:*`. Best-effort: failures fall back to TTL
  with a `console_warn!`. 5 unit tests cover SCAN response parsing.
- The migration CLI now accepts `midjourneys` as the unsupported-table
  example and vendors/models as first-class import tables (covered by
  `cargo test -p cinatoken-migration`).
- Channel admin Tier 1 CRUD landed (`crates/worker/src/admin_channel.rs`):
  `GET /api/channel/` (list with `type_counts` aggregation), `GET
  /api/channel/search`, `GET /api/channel/:id`, `POST /api/channel/`
  (create, single-mode only), `PUT /api/channel/`, `DELETE /api/channel/:id`,
  `POST /api/channel/batch` (batch delete), `POST /api/channel/fix` (rebuild
  the entire `abilities` table from `channels.models × channels.group`).
  Every write operation keeps the `abilities` table in sync so the relay's
  `select_channels_from_abilities` finds new/edited channels, and triggers
  `invalidate_channel_cache` so the relay drops stale channel cache entries.
  List/get responses never expose the upstream key (reveal is a separate
  RootAuth route, Tier 2).
- Channel + abilities D1 repository functions added in
  `crates/worker/src/d1_repositories.rs`: `list_channels`, `search_channels`,
  `count_channels`, `count_channels_by_type`, `find_channel_by_id`,
  `create_channel`, `update_channel`, `delete_channel`,
  `delete_channels_batch`, plus the load-bearing abilities sync helpers
  `add_abilities_for_channel`, `update_abilities_for_channel`,
  `delete_abilities_for_channel`, and `fix_abilities`.
- User admin CRUD landed (`crates/worker/src/admin_user.rs`): `GET
  /api/user/` (list), `GET /api/user/search`, `GET /api/user/:id`,
  `POST /api/user/` (create with role clamp `new_role < caller_role`),
  `PUT /api/user/` (edit username/display_name/group/remark/password),
  `DELETE /api/user/:id` (soft delete + token cache invalidation), and
  `POST /api/user/manage` (the 8-action switch: disable/enable/delete/
  promote/demote/add_quota×{add,subtract,override}). Permission rules match
  Go `canManageTargetRole`: promote is root-only; disable/delete/demote
  block if target is root; delete requires strict `caller_role >
  target_role`. Quota mutations use atomic SQL (`quota = quota + ?`).
  Responses omit `password` (SQL-level) and `access_token` (handler-level).
- User admin D1 repository functions: `list_users`, `search_users`,
  `count_users`, `count_search_users`, `find_user_by_id_full`,
  `find_user_role_status`, `create_user`, `edit_user`, `soft_delete_user`,
  `set_user_status`, `set_user_role`, `increase_user_quota`,
  `decrease_user_quota`, `override_user_quota`.
- Non-tiered ("flat") billing landed. When a model has no `tiered_expr`
  configured AND has a `ModelRatio` or `ModelPrice` option entry, the relay
  now computes and applies quota via `crates/billing/src/flat.rs`
  (`compute_flat_quota`), wired into `record_relay_audit` alongside the
  existing tiered path. The formula mirrors Go's
  `calculateTextQuotaSummary` core: `model_ratio × group_ratio` per-token,
  with `completion_ratio` premium, OpenAI-vs-Anthropic cache semantic
  branching, `model_price` fixed-price mode, zero-usage guard, and the
  `ratio != 0 && quota <= 0 → 1` floor. Audit metadata records
  `flat_billing: {quota, mode, model_ratio, completion_ratio, group_ratio,
  cache_ratio}`. 11 unit tests cover the core cases.
- Pricing config module (`crates/billing/src/pricing.rs`): loads
  `ModelRatio`, `CompletionRatio`, `ModelPrice`, `CacheRatio`,
  `group_ratio_setting.group_ratio`, `QuotaPerUnit` from D1 options as
  JSON maps. Defaults: ratio 1.0, quota_per_unit 500_000. 6 unit tests.
- Tokenizer crate (`crates/tokenizer`): char-class token estimator porting
  Go's `service/token_estimator.go`. Per-family weights (OpenAI / Claude /
  Gemini) with CJK / Latin / Number / Emoji / MathSymbol classification.
  Used by the tiered billing preflight (via `token_params_from_request`)
  for more accurate prompt-token estimates than the legacy char/4 heuristic.
  10 unit tests. tiktoken BPE is intentionally NOT embedded (Worker bundle
  size); settlement always prefers provider-reported usage.
- D1 `option_values(db, keys)` batch reader added for the pricing options
  round-trip.
- Multipart/raw body relay mode landed. Three upload endpoints are now
  wired and forward `multipart/form-data` bodies to the upstream verbatim:
  `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`,
  `POST /v1/images/edits`. The `model` form field is extracted via a
  lightweight boundary-split parser (`crates/relay/src/multipart.rs`,
  `extract_multipart_field`) so the relay can authenticate, route, and bill
  the request; the full multipart body is replayed to the upstream through
  `forward_raw_openai_compatible` (raw bytes via `Uint8Array`, original
  Content-Type with boundary preserved). Body limit for multipart
  endpoints is 25 MiB. 9 unit tests cover boundary extraction, text-field
  extraction, file-part skipping, and edge cases.
- `RelayRequestBody` enum (`Json(Value)` / `Raw { bytes, content_type }`)
  replaces the prior `Value`-only body shape, with `prepare_relay_request`
  dispatching to `prepare_json_relay_request` or
  `prepare_multipart_relay_request` based on the endpoint's
  `request_body_mode`.
- Three Chinese cloud AI providers added as OpenAI-compatible channel
  types: Baidu Qianfan v2 (type 15, `https://qianfan.baidubce.com/v2`),
  Ali DashScope compatible-mode (type 17,
  `https://dashscope.aliyuncs.com/compatible-mode/v1`), and Zhipu v4
  (type 26, `https://open.bigmodel.cn/api/paas/v4`). `OPENAI_COMPATIBLE_CHANNEL_TYPES`
  now covers 15 providers. Baidu's native ERNIE API (OAuth token exchange +
  per-model URL mapping) and Ali's native DashScope API
  (`/api/v1/services/...` rerank/image) are deferred to a later batch.
- Dashboard data endpoints landed (`crates/worker/src/admin_data.rs`):
  `GET /api/data/` (admin quota trend by model, with optional username
  filter), `GET /api/data/self` (user's own quota trend, 30-day cap),
  `GET /api/data/users` (admin quota trend by user), and
  `GET /api/usage/token/` (OpenAI-style token usage via Bearer token auth).
  All trends are computed live from the `logs` table with hour-floored
  `GROUP BY` (D1's `(created_at, type)` index makes this efficient). The
  Go gateway's `quota_data` pre-aggregation table + flush job is deferred
  (would require a Cloudflare Cron Trigger).
- Stripe topup MVP landed (`crates/worker/src/admin_payment.rs` +
  `crates/payments/src/lib.rs`): `POST /api/user/stripe/pay` creates a
  Stripe Checkout Session and records a pending topup;
  `POST /api/stripe/webhook` verifies the HMAC-SHA256 signature, completes
  the topup atomically (status 0→1), credits quota, and records a
  `payment_events` row for idempotency; `GET /api/user/topup` lists recent
  topups. D1 migration 0003 adds the `topups` table. 8 unit tests cover
  signature parsing, HMAC verification, and config defaults.
  `type=3` (LogTypeManage) row into the `logs` table via
  `insert_admin_audit_log` (`crates/worker/src/d1_repositories.rs`), with
  the operator identity in `other.admin_info` and the action+params in
  `other.op`. 12 explicit audit points cover: user create/update/delete/
  manage (disable/enable/promote/demote/quota add/subtract/override),
  channel create/update/delete/batch-delete, option update, log clear, and
  token key reveal. Secret values (option values, token keys) are NEVER
  recorded — only key names / token ids. Self-log queries strip `other` so
  target users see the action but not the operator identity. Audit rows are
  queryable via the existing `GET /api/log/?type=3` endpoint.
- LOG_QUEUE producer+consumer landed for relay audit logs. The relay path
  now sends `AuditLogEvent` messages to `LOG_QUEUE` (via
  `env.queue("LOG_QUEUE").send(...)`) instead of doing a synchronous D1
  INSERT inside `wait_until`. A new `#[event(queue)]` handler in
  `crates/worker/src/lib.rs` drains batches of up to 100 messages (or every
  5 seconds) and bulk-INSERTs them into D1 in a single `db.batch()` call.
  On D1 failure the batch is retried (up to 3 times, then dead-letter
  queue). Falls back to synchronous D1 INSERT when the queue binding is not
  configured (local dev / `cargo test`). Admin audit logs remain
  synchronous (low-frequency, not a bottleneck). `wrangler.toml` now
  declares `[[queues.consumers]]` with `max_batch_size=100`,
  `max_batch_timeout=5`, `max_retries=3`, and a DLQ in all three
  environments.
- **Staging deployment + operational verification (2026-07-01).** All D1
  migrations (0001-0007) applied to the live staging database
  (`cinatoken-rust-db-staging`). The current worker deployed to
  `cinatoken-rust-api-staging` via `wrangler deploy --env staging` (host has
  no linker for `worker-build`, so the build was replicated manually:
  `cargo build --target wasm32-unknown-unknown --release`, then
  `wasm-bindgen --target module` — not `bundler`, whose `__wbindgen_start`
  glue expects a bundler to instantiate the wasm and fails workerd startup —
  followed by worker-build's `import source ` → `import ` rewrite). Startup
  succeeded (Worker Startup Time ~5ms, no exceptions). `GET /api/status`
  returns `environment: staging` with `d1`/`session_auth`/`worker` features
  enabled. The task poller cron (`* * * * *`) is live; `wrangler tail`
  captured a real scheduled fire running all three drivers
  (`poll_unfinished_{tasks,suno_tasks,midjourney_tasks}`) against the live D1
  with `outcome: ok` and no exceptions.
- **End-to-end async-task lifecycle smoke against a protocol-faithful
  emulator (2026-07-01).** No real provider credentials are available in this
  environment, so the Sora wire protocol (`POST {base}/v1/videos` →
  `{"id":...}`, `GET {base}/v1/videos/{id}` → `{"status":...}`) was emulated
  by a separate Worker on a real (non-`workers.dev`) custom domain — same-zone
  `*.workers.dev` → `*.workers.dev` calls hit Cloudflare's same-zone
  worker-to-worker block (`error code: 1042`), and Sora's submit/poll wire
  shape is simple enough to emulate faithfully rather than mock. A throwaway
  user/token/channel/ability were seeded in staging D1. Two real
  `POST /v1/video/generations` submits (one designed to succeed, one to fail)
  went through the full stack — auth, channel selection, billing
  pre-charge/reserve, a genuine outbound HTTP call, response parsing, task
  insert — then the live cron poller picked them up, made a genuine outbound
  poll call, and settled both via the CAS: the success task reached `SUCCESS`
  keeping its charge, the failure task reached `FAILURE` with the upstream
  error message and refunded its reserve. Quota deltas were verified exactly
  against both the user and the token rows before and after.
  This smoke surfaced and fixed two real bugs (see the same-day source commit
  for detail): `find_channel_by_id` and the abilities-rebuild query filtered
  a non-existent `channels.deleted_at` column, silently breaking every poll
  channel lookup; and the poll-failure refund only credited the user, not the
  reserving token (Go's `RefundTaskQuota` credits both). Both fixed and
  re-verified live. Test fixtures and the emulator/custom-domain route were
  torn down after verification.
- **End-to-end RELAY smoke — chat/completions, non-stream + streaming, with
  exact billing (2026-07-01).** Closes the long-standing "no live relay
  upstream request" gap on the core product path. An OpenAI-compatible echo
  Worker (fixed usage `prompt=100, completion=50`) was deployed to a real
  custom domain (same 1042 same-zone bypass as the task smoke; the CF token
  lacks Workers-Routes permission so the custom domain was attached via the
  `accounts/workers/domains` API rather than wrangler's route path). A
  throwaway user/token + a type-1 (OpenAI-compatible) channel → the echo +
  an ability + `ModelRatio {"echo-chat-1":1}` were seeded. A real
  `POST /v1/chat/completions` through the live staging worker returned the
  upstream response verbatim (HTTP 200) with usage parsed, and the flat
  billing settled to the exact unit: quota `= (100 + 50×1)×1×1 = 150` charged
  to **both** user and token (user.quota 1000000→999850, token.remain→999850,
  both `used`→150), with a type-2 consume audit-log row (model, token counts,
  quota 150). The streaming variant (`stream:true`) passed the SSE through
  unbuffered (content chunk → final-usage chunk → `[DONE]`) and settled the
  final-chunk usage identically (another exact 150). No relay bugs found —
  the relay path (unlike the task poller) was already solid. Fixtures + echo
  worker + custom domain torn down after verification.
- **End-to-end RELAY smoke against a REAL provider — DeepSeek, three families,
  exact billing on real usage (2026-07-01).** The user supplied a real
  DeepSeek key + endpoints, so the relay was exercised against a genuine
  upstream (`api.deepseek.com`, no emulator, no 1042 — real provider, real
  zone). A throwaway user/token + `ModelRatio {"deepseek-v4-pro":1}` were
  seeded, with a channel per family holding the provider key. All three
  returned HTTP 200 with the real upstream body and settled billing to the
  exact unit on the provider-reported usage (charged to both user and token,
  each with a type-2 consume audit-log row):
  - `POST /v1/chat/completions` (type-1 channel, `base_url=https://api.deepseek.com`):
    real usage prompt 12 / completion 39 (incl. 36 reasoning tokens) →
    quota 51.
  - `POST /v1/chat/completions` `stream:true` with `stream_options.include_usage`:
    real SSE passed through unbuffered, final-chunk usage prompt 7 /
    completion 100 → quota 107.
  - `POST /v1/messages` (Anthropic Messages, type-14 channel,
    `base_url=https://api.deepseek.com/anthropic`): native Anthropic
    thinking+text response, usage input 7 / output 49 → quota 56.
  Cumulative settled 214, matching the sum exactly. No bugs found — the
  OpenAI-compatible and Anthropic relay adapters both work against a live
  third-party provider. All fixtures (including the channel rows holding the
  provider key) were deleted from staging D1 after verification; the key was
  never committed and lives only in the throwaway local scratchpad.

- **User self-registration (`POST /api/user/register`) — implemented +
  staging-verified (2026-07-01).** Ports Go `controller.Register`, the core
  auth flow that was missing (the worker had admin user-create + login but no
  self-signup). Live smoke on staging: a fresh register returned
  `{success:true}` (200); an 8–20 password-length violation returned 400 with
  the Go-matching message; a duplicate username returned 409; and the
  register→login round-trip succeeded, proving the bcrypt hash is loginable.
  The created row was role=common, group=default, 4-char aff_code,
  inviter_id=0, 60-char bcrypt password (`QuotaForNewUser`=0 default). 153
  worker lib tests pass (+3 new for validation/option-parsing). Deferred
  parity (all off by default, noted in-code): Turnstile, email-verified
  registration (email subsystem unported), default-token generation, the
  payment-compliance sub-gate, and informational system logs.

- **Self-service account endpoints + a critical cookie-auth bugfix —
  staging-verified (2026-07-01).** Added four Go `controller/user.go`
  self-routes (`GET /api/user/aff`, `GET /api/user/token`,
  `POST /api/user/aff_transfer`, `DELETE /api/user/self`). Smoking them with a
  real session cookie surfaced a **showstopper latent bug**: `session_cookie()`
  fetched the request header named `COOKIE_NAME` ("session") instead of the
  `Cookie` header, so *every* cookie-authenticated endpoint (get_self,
  require_user_auth, 2FA, secure-verify, admin-via-session, self-service)
  always saw "not logged in" — cookie login persistence was entirely broken and
  had never been integration-tested (only `extract_session_cookie` had unit
  coverage). Fixed (commit `079c045`); `GET /api/user/self` went 401→200 with a
  login cookie. Then all four self-service endpoints verified end-to-end: aff
  code lazily generated + returned; 32-char access token minted; transfer
  min-gate (400 "minimum transfer is 500000") and insufficient-affiliation-quota
  CAS (400) both fire; `DELETE /api/user/self` soft-deletes (subsequent self →
  401 "session user no longer exists", re-login → 401). 154 worker tests pass.
  Fixtures cleaned up.

- **Self-profile update + public-info endpoints — staging-verified
  (2026-07-01).** `PUT /api/user/self` (Go `UpdateSelf` profile branch) and
  `GET /api/notice` / `/api/about` / `/api/home_page_content` (Go misc). Live:
  a display_name update is reflected in `GET /api/user/self`; a password change
  rejects a wrong `original_password` (400) and accepts the correct one (200),
  after which the new password logs in (200) and the old one is rejected (401);
  the info endpoints return their option value (set→"staging notice OK",
  unset→""). 156 worker tests pass. Deferred: the `sidebar_modules`/`language`
  user-setting branches of `UpdateSelf` (display-only, `setting` JSON unmanaged).

- **Usable-groups endpoints (`GET /api/user/self/groups` + `/api/user/groups`)
  — staging-verified (2026-07-01).** Ports Go `GetUserGroups` for the
  default-config path (defaults baked in: GroupRatio {default,vip,svip}=1 merged
  with the option; UserUsableGroups {default,vip} replaced by the option). Live:
  public returns `{default:{ratio:1.0,desc:"默认分组"}, vip:{...}}` with `svip`
  correctly excluded (rated but not usable); `/self/groups` is 401 without a
  session, 200 with. 159 worker tests pass. Deferred: per-user-group ratio
  overrides + `GroupSpecialUsableGroup` `+:`/`-:` rules (Go defaults are
  placeholders; non-default configs only).

- **`GET /api/user/models` (user's available models) — staging-verified
  (2026-07-01).** Ports Go `GetUserModels`: distinct enabled models unioned
  across the caller's usable groups (`SELECT DISTINCT model FROM abilities
  WHERE group_name=? AND enabled=1` per usable group). Live: with abilities
  seeded default(alpha)+vip(beta) enabled and default(disabled) off, returned
  `[gpt-4o, smoke-model-alpha, smoke-model-beta]` — disabled excluded,
  pre-existing gpt-4o included; no-auth → 401. `GET /api/models`
  (DashboardListModels) intentionally not ported (returns per-adaptor static
  model lists baked into Go, not a DB query). 159 worker tests pass.

- **UpdateSelf setting branches (sidebar_modules / language) — staging-verified
  (2026-07-01).** Completes `PUT /api/user/self` to Go parity: preference fields
  merge into the user `setting` JSON (preserving others), separate from the
  profile branch. Live: sidebar_modules then language merged incrementally
  (`{sidebar_modules,language}`); a later display_name update changed the
  profile while the setting JSON survived. 160 worker tests pass. The full
  `PUT /api/user/setting` (UpdateUserSetting — notification prefs with
  webhook/bark/gotify validation) is a separate follow-up.

- **`PUT /api/user/setting` (notification prefs) — staging-verified
  (2026-07-01).** Ports Go `UpdateUserSetting`: notify-type + threshold +
  type-specific URL/email/token validation, persisted as a fresh notification
  `setting` JSON (Gotify priority clamped 0-10). Live: valid webhook→200; bad
  type→400; webhook w/o url→400; gotify priority 99 stored as 5. 162 tests
  pass. The notification *dispatch* subsystem is unported (config-only).

- **`GET /api/ratio_config` (exposed ratio tables) — staging-verified
  (2026-07-01).** Ports Go `GetRatioConfig`/`GetExposedData`: 5 merged ratio
  maps (default `cinatoken_core::default_ratios` tables + options override),
  gated by `ExposeRatioEnabled` (off→403). Live: off→403; on→200 with
  gpt-4o=0.5 default + a my-custom-model override merged. 163 tests pass.

- **Legal/midjourney public info + admin enabled-models — staging-verified
  (2026-07-01).** `GET /api/user-agreement`, `/api/privacy-policy`,
  `/api/midjourney` (option-backed strings, verified returning set values); and
  `GET /api/channel/models_enabled` (Go `EnabledListModels`, admin-only) —
  verified returning `[gpt-4o, smoke-enabled-model]` for an admin and 403 for a
  common user.

- **Admin ratio-reset + channel tag ops — staging-verified (2026-07-01/02).**
  `POST /api/option/rest_model_ratio` (root: rewrites ModelRatio from the
  default table — verified 6657-byte value with gpt-4o; common→403);
  `POST /api/channel/tag/{disabled,enabled}` (toggles channels + their
  abilities 2/2) and `DELETE /api/channel/disabled` (deleted exactly the 2
  disabled channels + abilities, data=2, leaving the enabled mocks intact;
  empty tag→400). `POST /api/option/payment_compliance` (admin: persists the 5
  `payment_setting.compliance_*` options incl. confirming user id + client IP;
  confirmed:false→400; common→403).
- **`GET /api/pricing` + 0008 models/vendors schema — staging-verified
  (2026-07-02).** Ports Go `GetPricing`/`updatePricing`; migration 0008 applied
  to staging D1. Anonymous smoke: priced model → quota_type 1/price 0.25; ratio
  model → ratio 3.5 with full metadata enrichment (desc/icon/tags/vendor_id via
  exact name-rule) and vip group; pre-existing gpt-4o → default-table ratio
  1.25, hardcoded completion 4.0, cache 0.5; a restricted-group model was
  filtered out; vendors/auto_groups/group_ratio (usable-only)/
  supported_endpoint/pricing_version all correct. 168 worker tests pass (+4:
  endpoint mapping, name-rule priority, price-vs-ratio + disabled-meta,
  usable-group filter).
- **Models/vendors admin CRUD (`/api/models/*`, `/api/vendors/*`) —
  staging-verified (2026-07-02).** Full lifecycle over the 0008 tables:
  missing=[gpt-4o] → vendor+meta created → duplicate name 409 → missing=[] →
  `/api/pricing` live-enriched (tags/desc/vendor on gpt-4o) →
  `?status_only=true` status=0 hid gpt-4o from pricing → soft deletes → gets
  404 and gpt-4o returned to pricing → search keyword total=1; no-auth 401.
- **Cloudflare Workers AI + AI Gateway integration — staging-verified with
  REAL inference (2026-07-02).** Type-39 (Cloudflare) channels join the
  OpenAI-compatible set with Go-parity REST/gateway URL routing
  (host-tested), plus a NEW native path: key=`internal` channels execute over
  the Workers AI `AI` binding in-platform (no egress, no API token). Live:
  `@cf/meta/llama-4-scout-17b-16e-instruct` through the full relay → "pong",
  real usage 86/2, billing settled exactly (88 = 86 + 2×1.0) with audit; a
  second call billed cumulatively (181); a deprecated model's `AiError`
  surfaced through the normal relay error path; stream on a binding channel →
  clean 400; `/api/status` shows `workers_ai=true` / `ai_gateway=false`.
  This is the first REAL-provider relay verification needing zero external
  credentials. AI Gateway routing (`AI_GATEWAY_ID` + 3-arg binding `run` via
  reflection) is code-complete but config-gated — verifying it needs a
  gateway created in the dashboard (the staging token lacks AI Gateway
  permissions).
- **Channel connectivity ops — staging-verified (2026-07-02).**
  `GET /api/channel/test/:id` (1-token chat probe with the channel's own key:
  success time=0.033s, `response_time`/`test_time` persisted; unreachable
  base_url → `success:false` "upstream status 530"; no-auth 401),
  `GET /api/channel/fetch_models/:id` → the echo upstream's two model ids, and
  `POST /api/channel/fetch_models` (pre-create probe: multi-line key trimmed
  to first line → ids; missing base_url → 400). Echo + fixtures torn down.
- **`PUT /api/channel/tag` (bulk edit by tag) — staging-verified (2026-07-02).**
  Ports Go `EditTagChannels`/`EditChannelByTag`. All three paths live-verified:
  priority/weight-only edit propagated to both channels and their abilities
  (2/2 each, no rebuild); invalid `param_override` → 400 ("must be valid
  JSON"); models change + retag rewrote both channels (new tag + models) and
  rebuilt abilities exactly (4 new rows = 2 channels × 2 models, 0 stale).
  164 worker tests pass.

- **Route-review batches 1+2 — staging-verified (2026-07-02).** A full diff of
  every Go route against the Rust router. Closed + live-smoked: task fetch
  (`GET /v1/video/generations/:task_id` → full TaskDto incl. `result_url`
  from private_data and parsed `data`; `GET/POST /suno/fetch` by-id + batch;
  unknown → `task_not_exist` 400; no-auth 401); mj client fetch
  (`/mj/task/:id/fetch` + `list-by-condition` → exact MidjourneyDto with
  parsed buttons/properties; unknown → `{code:4}`); billing views
  (subscription hard_limit 2.0 and usage 50.0 exactly matching a seeded
  750k/250k token); passthroughs routed (moderations/edits/responses-compact
  → 401 auth gate, not 404); `GET /v1/files` → Go-shaped 501. Also FOUND+FIXED
  the poll path never persisting the task result URL, and caught (via the
  canonical route inventory) that Go relays `/v1/engines/:model/embeddings`
  in GEMINI format — the initial OpenAI-shaped port was reverted to a
  structured 501 rather than ship a wrong-format relay. 174 worker tests pass.

- **Frontend contract audit + two P0 compatibility batches — locally verified
  (2026-07-03).** Added `tools/audit_frontend_routes.mjs` (TypeScript AST
  frontend-call inventory) and `tools/verify_frontend_contract.mjs`
  (non-mutating deployed contract smoke). TypeChecker-based resolution now
  covers 212 distinct default-frontend calls and reduced unmatched calls from
  122 to 72 after
  adding complete 2FA frontend payload/lifecycle parity, batch token-key
  reveal, channel batch-tag/tag-model routes, admin group lookup, and the
  frontend admin-2FA-reset path, followed by prefill-group CRUD, official model
  metadata preview/sync, provider balance refresh, and multi-key channel
  management, then single-channel upstream model detect/apply, Codex
  usage/credential refresh, Rust-native channel-affinity cache stats/clear,
  channel-affinity usage diagnostics, bounded upstream batch
  detect/apply slices, and Ollama version/delete/pull-stream/model-list
  management through HTTPS/443 base URLs, followed by Worker-native operations
  endpoints for Uptime Kuma, model performance metrics, explicit no-op
  `/api/performance/*` local-maintenance compatibility, upstream ratio
  sync for `/api/ratio_sync/channels` plus `/api/ratio_sync/fetch`, and
  root-admin custom OAuth provider CRUD/discovery with D1 schema/import and
  `/api/status` enabled-provider exposure, custom OAuth binding list/unbind
  for self/admin users plus admin built-in binding clear, async
  Midjourney/task usage-log read lists at `/api/mj`, `/api/mj/self`,
  `/api/task`, and `/api/task/self`, D1-backed daily check-in at
  `/api/user/checkin`, admin redemption-code management at `/api/redemption`,
  and public rankings at `/api/rankings`.
  The reviewed route-debt baseline is enforced by `bun run check:web:routes`:
  63 missing calls, no unclassified entries, and no remaining visible-admin or
  operations-debt gaps. `cargo test -p cinatoken-worker --lib` passes 262
  tests; migrations 0001-0012 replay including custom OAuth provider,
  binding, check-in, and redemption tables. The wasm32 and default frontend
  TypeScript/Rsbuild checks pass.
- **Channel settings persistence contract — locally verified (2026-07-03).**
  Channel create/update now carries the frontend `settings` JSON through the
  request and D1 repository instead of silently replacing it with an empty
  string or ignoring updates.
- **Single-channel upstream model updates — locally verified (2026-07-03).**
  `POST /api/channel/upstream_updates/detect` and `POST
  /api/channel/upstream_updates/apply` now persist pending add/remove models
  into `settings`, apply selected changes to `models`, rebuild abilities when
  models change, invalidate relay channel cache, and audit apply without
  storing upstream keys. Outbound model-list fetches are HTTPS-only, redirect
  disabled, timeout-bounded, response-size-bounded, and share the same helper
  with `/api/channel/fetch_models/:id`; Ollama direct local-daemon access and
  batch detect/apply remain deferred to protected management/asynchronous
  designs.
- **Codex channel usage and credential refresh — locally verified
  (2026-07-03).** `GET /api/channel/:id/codex/usage` and `POST
  /api/channel/:id/codex/refresh` now match the default frontend contract.
  Stored OAuth credentials are validated as JSON objects; 401/403 usage
  responses trigger at most one refresh/retry; refreshed keys use D1
  compare-and-swap so a concurrent admin edit is not overwritten. The flow
  attempts best-effort channel cache invalidation and writes an audit record
  without tokens.
  Outbound requests are HTTPS/443 only, redirect-disabled, timeout-bounded,
  and body-size-bounded. Go VPS `setting.proxy` semantics are rejected
  explicitly because Workers cannot attach a process-local proxy. Unit tests
  cover parsing, JWT account/email extraction, SSRF targets, proxy rejection,
  and identity preservation.
- **Bounded upstream model batch updates - locally verified (2026-07-03).**
  `POST /api/channel/upstream_updates/detect_all` and
  `POST /api/channel/upstream_updates/apply_all` now expose after-id bounded
  slices over enabled channels. The default frontend loops with a page limit of
  5 and aggregates the Go-compatible counts, while each Worker request keeps a
  fixed amount of D1 and outbound model-list work. A future Queue/Workflow can
  reuse the same cursor contract for background orchestration.
- **Ollama admin model management - locally verified (2026-07-03).**
  `GET /api/channel/ollama/version/:id`, `DELETE /api/channel/ollama/delete`,
  and `POST /api/channel/ollama/pull/stream` are implemented for Ollama
  channels with HTTPS/443 base URLs. Pull progress is streamed from Ollama
  NDJSON into the existing frontend SSE UI without buffering the full operation;
  `POST /api/channel/fetch_models` and `GET /api/channel/fetch_models/:id`
  also use Ollama `/api/tags` when channel type is 4.
- **Channel affinity cache stats/clear - locally verified (2026-07-03).**
  `GET /api/option/channel_affinity_cache` and
  `DELETE /api/option/channel_affinity_cache` now cover the Rust Worker
  affinity subset that is actually written by relay success paths. The per-key
  Durable Object remains the source of truth; `CACHE_KV` stores bounded
  admin-list metadata for stats and clear. The routes are AdminAuth-protected,
  clear operations are audited, scans are capped at 1000 indexed entries per
  request, and the response explicitly labels the scope as the Rust minimal
  user/model/group rule rather than synthesizing Go's rule-template or
  usage-stat caches.
- **Channel affinity usage diagnostics - locally verified (2026-07-03).**
  `GET /api/log/channel_affinity_usage_cache` now serves the default
  usage-log dialog for the Rust fixed-rule subset. Relay success audits attach
  `other.admin_info.channel_affinity` metadata with a frontend-visible key
  fingerprint, and successful upstream usage responses update TTL-bounded
  `CACHE_KV` hit/total/token counters without exposing the raw affinity key.
- **Staging static/public HTTP contract — verified (2026-07-02/03).**
  `bun run check:web:staging` passes all seven groups against
  `cinatoken-rust-api-staging.cinagroup.workers.dev`: capability-clamped
  status, setup shape, 11 SPA hard-refresh routes, eight static assets, exact
  deployed/local index identity, ten public envelopes, and API-before-SPA
  precedence. This does not verify authenticated DOM workflows. The new
  2026-07-03 backend compatibility routes still require redeployment.

## Local Notes

- **Admin Passkey reset - locally verified route surface (2026-07-04).**
  `DELETE /api/user/:id/reset_passkey` is now Worker-owned with AdminAuth,
  manage-target role checks, `user.reset_passkey` admin audit, and a D1
  `passkey_credentials` table for Go-compatible credential storage. The route
  audit now reports 212 frontend calls, 275 Worker routes, and 12 remaining
  auth-deferred gaps with SHA-256
  `d51581aed82f7f8a3024885b5fd075834c8dc96b983b74aec6e0144b579905fe`.

- **Email verification/reset/bind - locally verified route surface
  (2026-07-04).** `GET /api/verification`, `GET /api/reset_password`,
  `POST /api/user/reset`, and `POST /api/oauth/email/bind` are now
  Worker-owned. The implementation uses `flow_state` KV TTLs instead of Go's
  process-local map and Cloudflare `send_email` binding `EMAIL` instead of
  SMTP sockets. Local route audit reports 212 frontend calls, 279 Worker routes,
  and 8 remaining auth-deferred gaps with SHA-256
  `65f9ed7547e329d29cd3b7bfb6e9b1cccdf23290c112a87bf2cd5b5db5ca0f99`.

- **WeChat login/bind - locally verified route surface (2026-07-04).**
  `GET /api/oauth/wechat`, `GET /api/oauth/wechat/bind`, and the Go-compatible
  `POST /api/oauth/wechat/bind` are now Worker-owned. The Worker reads
  `WeChatAuthEnabled`, `WeChatServerAddress`, `WeChatServerToken`, and
  `WeChatAccountQRCodeImageURL` from D1 options, verifies codes through an
  operator-managed public HTTPS WeChat Server, and issues the same session
  response shape as password/OAuth login. Local route audit reports 212
  frontend calls, 282 Worker routes, and 6 remaining auth-deferred gaps with
  SHA-256 `8bcefa9b62aaa9473541032cc28e21d6e31e9711db66b6f5706b3976c736b457`.

- **Multipart upload binary parser and WAV estimate - locally verified
  (2026-07-05).** `cinatoken_relay::multipart` now scans bodies as bytes rather
  than requiring the entire upload to be valid UTF-8, so binary audio/image
  parts do not prevent `model` extraction. Worker multipart audio preflight
  derives Go-compatible prompt-token estimates from WAV duration for
  `/v1/audio/transcriptions` and `/v1/audio/translations`, while preserving
  byte-for-byte upstream multipart forwarding for audio uploads and
  `/v1/images/edits`. Local evidence so far:
  `cargo test -p cinatoken-relay multipart` (12 passed) and
  `cargo test -p cinatoken-worker --lib multipart_audio_wav_duration_feeds_prompt_estimate`
  (passed).

- **Common audio duration preflight parsers - locally verified (2026-07-05).**
  `cinatoken_core::audio_duration::audio_duration_seconds` now parses WAV, MP3,
  FLAC, M4A/MP4, OGG/Vorbis, Opus, AIFF/AIFC, AAC ADTS, and WebM EBML
  `Duration` metadata without external tools, and Worker multipart audio
  preflight uses the uploaded file name plus part `Content-Type` to feed STT
  prompt-token estimates. Local evidence:
  `cargo test -p cinatoken-core audio_duration` (14 passed) and
  `cargo test -p cinatoken-worker --lib multipart_audio_flac_duration_feeds_prompt_estimate`
  (passed), plus
  `cargo test -p cinatoken-worker --lib multipart_audio_webm_duration_feeds_prompt_estimate`
  (passed).

- **OpenAI video create/fetch shell - locally verified (2026-07-05).**
  `POST /v1/videos` now returns an OpenAI video `queued` shell after the
  existing Worker task submit path succeeds, and `GET /v1/videos/:task_id`
  returns an owner-scoped DB-backed OpenAI video status object. Remix
  (`POST /v1/videos/:video_id/remix`) and content streaming
  (`GET /v1/videos/:task_id/content`) remain structured 501 boundaries until
  origin-task/channel-lock resolution and Queue/R2 artifact proxying are
  ported. Local evidence: `cargo fmt --all`,
  `cargo test -p cinatoken-worker --lib` (356 passed), and
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed).

- **Cloudflare WFP dispatch and RealtimeSession DO foundation - locally
  verified (2026-07-05).** The Worker now has an AdminAuth
  `/api/platform/capabilities` probe, a default-off WFP dispatch pre-router
  using the `DISPATCHER` dynamic dispatcher binding, default-off preview-host
  and internal dispatch selectors, a `REALTIME_SESSIONS` Durable Object binding
  and migration, and a `RealtimeSession` DO that accepts hibernatable
  WebSockets with serialized socket attachments. `/v1/realtime` remains
  protocol-unwired and G7-gated. Local evidence:
  `cargo test -p cinatoken-worker --lib platform_gateway` (3 passed),
  `cargo test -p cinatoken-worker --lib realtime_session` (2 passed),
  `cargo test -p cinatoken-worker --lib` (383 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  `git diff --check` (passed), and `bun run check` (passed; route audit
  214 frontend calls / 305 Worker routes / 0 missing calls).

- **WFP tenant script control plane - locally verified (2026-07-05).** The
  Worker now exposes root-only
  `POST /api/platform/wfp/tenant-script/plan` and
  `POST /api/platform/wfp/tenant-script/deploy` endpoints. The generated tenant
  Worker forwards supported AI routes, including `/v1/messages`, to
  Cloudflare AI Gateway REST with a Worker-owned bearer token, optional
  `cf-aig-gateway-id`, Worker-owned `cf-aig-metadata`, and streamed request
  bodies; it does not forward the client's `Authorization` header. The fallback
  status reports `runtime: "js-fallback"` so smoke tests can distinguish it
  from the Rust/Wasm artifact path. The deploy call uploads multipart
  `metadata` plus `tenant.mjs` to the Workers for
  Platforms dispatch namespace API and caps Cloudflare API response reads at
  32 KiB. Local evidence:
  `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed),
  `cargo test -p cinatoken-worker --lib` (388 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  `git diff --check` (passed), and `bun run check` (passed; route audit
  214 frontend calls / 307 Worker routes / 0 missing calls).

- **WFP Rust/Wasm tenant runtime - locally verified (2026-07-05).** Added the
  standalone `cinatoken-wfp-tenant` Worker crate under `crates/wfp-tenant`.
  It exposes `GET /__cinatoken/tenant/status` with `runtime: "rust-wasm"` and
  forwards `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
  `/v1/embeddings`, and `/ai/run` to Cloudflare AI Gateway REST using
  tenant-owned `CF_ACCOUNT_ID`/`CF_API_TOKEN`/`AI_GATEWAY_ID` bindings. It
  leaves legacy `/v1/completions` on the main relay because Cloudflare's
  current REST API docs do not list `/ai/v1/completions`. It attaches flat
  `cf-aig-metadata` (`tenant_id`, `runtime`,
  `source`, `route`, `api`) for AI Gateway analytics without forwarding client
  authorization. The inbound request body is passed through as a
  `ReadableStream` via `RequestInit`; the Rust runtime does not call `bytes()`
  or `json()` on the AI request body. Local evidence:
  `bun run check:wfp-tenant` (passed; 5 tenant tests, 6 generated fallback
  tests, and wasm32 check), `cargo test -p cinatoken-wfp-tenant` (5 passed),
  `cargo check -p cinatoken-wfp-tenant --target wasm32-unknown-unknown`
  (passed), `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed),
  and `bun run check` (passed; frontend route audit 214 calls / 307 Worker
  routes / 0 missing calls; existing worker dead-code warnings only).

- **WFP tenant response-header hygiene - locally verified (2026-07-05).** The
  Rust/Wasm tenant runtime and generated JS fallback now rebuild AI Gateway
  responses with a safe public header allowlist while preserving streamed
  response bodies. Public interoperability headers such as `content-type`,
  cache validators, `retry-after`, and common provider request IDs may pass
  through; upstream `authorization`, `set-cookie`, `content-length`,
  transfer/platform headers, `cf-aig-*` observability headers, and upstream
  `x-cinatoken-*` headers are not exposed to tenant clients. Local evidence:
  `cargo test -p cinatoken-wfp-tenant` (5 passed) and
  `cargo test -p cinatoken-worker --lib wfp_tenant` (6 passed), plus
  `bun run check` (passed; frontend gates, WFP deploy-plan/generated fallback
  gates, workspace tests, and Worker/WFP wasm32 checks). Live WFP smoke still
  needs redacted response-header evidence for both the generated fallback and
  the Rust/Wasm artifact.

- **WFP internal dispatch path rewrite - locally verified (2026-07-05).** The
  main Worker now rewrites internal dispatch URLs before calling the
  `DISPATCHER` binding: `/api/platform/dispatch/:worker/<tenant-path>` is
  forwarded to the tenant Worker as `/<tenant-path>` while preserving method,
  query string, headers, and the original request body stream. Preview-host
  dispatch still forwards the original path. This makes the documented
  `/api/platform/dispatch/:worker/__cinatoken/tenant/status` smoke actually
  reach the tenant status route. Local evidence:
  `cargo test -p cinatoken-worker --lib platform_gateway` (4 passed),
  `cargo test -p cinatoken-worker --lib` (394 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed;
  existing worker dead-code warnings only), and `bun run check` (passed;
  frontend gates, WFP deploy-plan/generated fallback gates, workspace tests,
  and Worker/WFP wasm32 checks). Live staging still needs the real `DISPATCHER`
  binding plus uploaded tenant scripts.

- **WFP dispatch smoke harness - locally verified (2026-07-05).** Added
  `tools/smoke_wfp_dispatch.mjs` and `bun run smoke:wfp-dispatch` to make the
  cinaVibeSDK-style dispatch Worker -> WFP tenant Worker path executable in
  staging. Default status mode resolves
  `/api/platform/dispatch/:worker/__cinatoken/tenant/status` and validates the
  tenant status contract (`runtime`, `forwarding`, `body_mode`, route manifest,
  and route-gateway configuration) plus `x-cinatoken-wfp-*` dispatch headers.
  Optional `--route` mode posts a low-risk JSON payload to a supported tenant
  AI route and runs the response-header guard even when `--allow-non-2xx` is
  used. The guard fails on auth/cookie/API-key headers, `cf-aig-*`, non-WFP
  `x-cinatoken-*`, unexpected WFP markers, and provider-only metadata, while
  recording public tenant headers, WFP evidence headers, CORS headers, and
  Cloudflare edge envelope headers separately. Local evidence:
  `bun tools/smoke_wfp_dispatch.mjs --help` (passed),
  `bun run check:wfp-dispatch:smoke-plan` (passed), and a dry-run route smoke
  for `/v1/responses` (passed with the expected internal dispatch URL and body
  byte count). The package check now also includes
  `bun run check:wfp-dispatch:response-header-smoke-plan` to keep the route
  response-header contract visible in CI dry-run output. Live staging still
  needs the same tool run against a real `DISPATCHER` binding and uploaded
  tenant script. 2026-07-06 update: `node --check
  tools/smoke_wfp_dispatch.mjs`, `bun run
  check:wfp-dispatch:response-header-guard`, `bun run
  check:wfp-dispatch:smoke-plan`, and `bun run
  check:wfp-dispatch:response-header-smoke-plan` passed.

- **WFP Rust/Wasm runtime smoke expectation - locally verified
  (2026-07-05).** WFP dispatch smoke now defaults to
  `--expect-runtime rust-wasm` and validates both the tenant status body and
  `x-cinatoken-wfp-runtime` response header. The Rust/Wasm tenant status route
  and generated JS fallback status route both emit `x-cinatoken-wfp-tenant` and
  `x-cinatoken-wfp-runtime`, so live staging evidence can distinguish the
  preferred Rust artifact from the generated fallback. Fallback validation must
  now be explicit with `--expect-runtime js-fallback` or `any`. Local evidence:
  `bun tools/smoke_wfp_dispatch.mjs --help` (passed),
  `bun tools/smoke_wfp_dispatch.mjs --dry-run --json --url
  http://127.0.0.1:8787 --worker tenant-smoke` (passed with
  `expectRuntime: "rust-wasm"`), `cargo test -p cinatoken-wfp-tenant` (passed;
  8 tenant-runtime tests), and `cargo test -p cinatoken-worker --lib
  wfp_tenant` (passed; 7 generated fallback/control-plane tests). `bun run
  check` also passed, including frontend gates, WFP deploy-plan, WFP dispatch
  and Realtime smoke plans, workspace tests, and Worker/WFP wasm32 checks. Live
  staging still needs this smoke against a real Rust/Wasm artifact uploaded to
  the dispatch namespace.

- **WFP internal dispatch admin boundary - locally verified (2026-07-05).**
  The Rust dispatch Worker now requires existing admin session auth before
  forwarding `/api/platform/dispatch/:worker/...` internal-path traffic to the
  `DISPATCHER` binding, while preview-host dispatch remains public preview
  traffic. `tools/smoke_wfp_dispatch.mjs` now accepts `--cookie` or
  `WFP_SMOKE_COOKIE`, sends it as the admin `Cookie` header, and reports only
  `adminCookieConfigured` in dry-run/live output. Local evidence:
  `cargo test -p cinatoken-worker --lib platform_gateway` (passed; 5
  platform-gateway tests), `bun tools/smoke_wfp_dispatch.mjs --help` (passed),
  and `bun tools/smoke_wfp_dispatch.mjs --dry-run --json --url
  https://staging.example.test --worker tenant-smoke --route /v1/responses
  --cookie session=redacted` (passed; redacted cookie value was not printed).
  `bun run check` also passed, including frontend gates, WFP dispatch/realtime
  smoke plans, workspace tests, and Worker/WFP wasm32 checks.
  Live staging still needs authenticated status/route smoke plus an
  unauthenticated 401/403 negative check before `WFP_INTERNAL_DISPATCH_ENABLED`
  is considered production-ready.

- **WFP dispatch inbound header hygiene - locally verified (2026-07-05).**
  The main dispatch Worker now rebuilds the request before invoking
  `DISPATCHER`, preserving safe forwarded headers and the streamed body while
  stripping `Authorization`, `Cookie`, `Proxy-Authorization`, API-key headers,
  Cloudflare Access client credentials, and caller-provided `x-cinatoken-*`
  markers. The Rust/Wasm tenant runtime and generated JS fallback tenant script
  now expose `inbound_sensitive_headers_present` and
  `inbound_sensitive_headers` in tenant status responses, allowing staging
  smoke to prove that admin cookies and relay credentials did not reach the
  tenant Worker. Local evidence: `cargo test -p cinatoken-worker --lib
  platform_gateway` (passed; 6 platform-gateway tests), `cargo test -p
  cinatoken-wfp-tenant` (passed; 8 tenant-runtime tests), `cargo test -p
  cinatoken-worker --lib wfp_tenant` (passed; 7 generated fallback/control-plane
  tests), `bun tools/smoke_wfp_dispatch.mjs --dry-run --json --url
  https://staging.example.test --worker tenant-smoke --route /v1/responses
  --cookie session=redacted` (passed; no cookie value printed), and `bun run
  check` (passed; frontend gates, WFP deploy-plan/dispatch/realtime smoke plans,
  workspace tests, and Worker/WFP wasm32 checks). Live staging still needs the
  same smoke against a real `DISPATCHER` binding to verify the tenant status
  reports an empty `inbound_sensitive_headers` array.

- **WFP internal forwarding marker gate - locally verified (2026-07-05).**
  The main dispatch Worker now strips caller-supplied `x-cinatoken-*` request
  markers, then injects controlled `x-cinatoken-wfp-route` and
  `x-cinatoken-wfp-worker` headers when invoking `DISPATCHER`. The Rust/Wasm
  tenant runtime and generated JS fallback expose those as
  `inbound_dispatch_route` and `inbound_dispatch_worker` on the tenant status
  route, while tenant AI routes reject non-`internal-path` dispatch with
  `403 tenant_internal_dispatch_required`. `tools/smoke_wfp_dispatch.mjs`
  now requires the status body to prove `inbound_dispatch_route=internal-path`
  and a matching worker marker in addition to the existing response-header and
  sensitive-header checks. Local evidence: `cargo test -p cinatoken-worker
  --lib platform_gateway` (passed; 7 platform-gateway tests), `cargo test -p
  cinatoken-wfp-tenant` (passed; 9 tenant-runtime tests), `cargo test -p
  cinatoken-worker --lib wfp_tenant` (passed; 7 generated
  fallback/control-plane tests), `bun tools/smoke_wfp_dispatch.mjs --help`
  (passed), `bun tools/smoke_wfp_dispatch.mjs --dry-run --json --url
  http://127.0.0.1:8787 --worker tenant-smoke` (passed),
  `bun run check:wfp-dispatch:smoke-plan` (passed), `cargo fmt --all --check`
  (passed), `git diff --check` (passed), and `bun run check` (passed;
  frontend gates, WFP deploy-plan/dispatch/realtime smoke plans, workspace
  tests, and Worker/WFP wasm32 checks). Live staging still needs the same
  authenticated status/route smoke against a real `DISPATCHER` binding, plus
  preview-host/public AI 403 or disabled evidence.

- **WFP Rust/Wasm artifact deploy uploader - locally verified (2026-07-05).**
  Added `tools/deploy_wfp_tenant_artifact.mjs` and `bun run deploy:wfp-tenant`
  for local upload of `crates/wfp-tenant/build/worker` to the Cloudflare WFP
  dispatch namespace multipart API. Local evidence:
  `bun tools/deploy_wfp_tenant_artifact.mjs --help` (passed),
  `bun run check:wfp-tenant:deploy-plan` (passed), and a dry-run against an
  ignored synthetic artifact directory with `shim.mjs` plus `index_bg.wasm`
  (2 modules discovered; JavaScript module and Wasm content types assigned;
  `CF_API_TOKEN` redacted). `bun run check` also passed with the new
  deploy-plan gate included. Attempted `worker-build` installation on the
  current Windows workstation is blocked by local native toolchain setup:
  GNU lacks `dlltool.exe`, while MSVC resolves `link.exe` to
  `C:\Users\cina\.hermes\git\usr\bin\link.exe` instead of Visual Studio Build
  Tools. Live dispatch upload still requires a working `worker-build`
  environment plus staging Cloudflare credentials and namespace.
  2026-07-08 update: the deploy dry-run now emits `artifactManifest` with
  `runtime: "rust-wasm"`, build command, artifact directory, main module,
  scan status, module count, total bytes, main/Wasm module presence, content
  types, and per-module SHA-256 hashes. `bun run
  check:wfp-tenant:artifact-manifest` validates that manifest contract without
  network or Cloudflare credentials, and staging evidence must archive the
  redacted manifest before accepting WFP dispatch smoke. `git diff --check`
  and `bun run check` passed with the new manifest self-test wired into the
  default gate; the only warnings remain the existing
  `d1_repositories.rs` dead-code warnings.

- **Historical WFP tenant Gateway controls - superseded (2026-07-14).** The
  2026-07-05 increment attached validated `AI_GATEWAY_*` values to tenant
  metadata. That ownership model is retired. New Rust/Wasm uploads reject the
  old CLI flags, do not read those values from the uploader environment, and
  attach no Gateway ID or request-policy binding. Post-upload collection and
  verification treat every such tenant binding as forbidden. Gateway policy is
  configured only on `cinatoken-wfp-outbound`.

- **OpenAI Realtime DO auth boundary - locally verified (2026-07-05).**
  `/v1/realtime` is now an early-dispatch, default-off WebSocket route gated
  by `REALTIME_SESSION_V1_ENABLED`. When enabled, it requires GET,
  `Upgrade: websocket`, `Sec-WebSocket-Key`, a non-empty `model` query
  parameter, and a relay API key from the Go-compatible Realtime subprotocol
  (`openai-insecure-api-key.<token>`), `Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`, or query `key`. The entry reuses D1 relay-token auth,
  model/IP/quota checks, auth cache, and token/IP rate limits before forwarding
  the original WebSocket request to the hibernatable `RealtimeSession` Durable
  Object. Socket attachments now store sanitized context, including token
  source, non-plaintext token fingerprint, auth state, model, and redacted
  protocol summary; raw protocol tokens are not serialized. Local evidence:
  `cargo test -p cinatoken-worker --lib realtime_session` (6 passed),
  `cargo test -p cinatoken-worker --lib` (392 passed),
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` (passed),
  and `bun run check` (passed; route audit 214 frontend calls / 307 Worker
  routes / 0 missing calls; existing worker dead-code warnings only). Upstream
  Realtime bridge, preconsume/settlement/audit, and live hibernation/protocol
  replay remain G7-gated.

- **WFP outbound-owned AI Gateway selection - locally verified
  (2026-07-14).** The Rust/Wasm tenant forwards no Gateway ID, policy,
  attribution, or metadata headers. `cinatoken-wfp-outbound` owns the default
  and four retained route-specific IDs for `/v1/chat/completions`,
  `/v1/responses`, `/v1/messages`, and `/ai/run`, plus bounded timeout, retry,
  cache, and logging policy. It discards spoofed tenant `cf-aig-*` values and
  creates attribution metadata from signed authority claims. The tenant plan,
  artifact uploader, readback collector, and verifier require Gateway bindings
  to be absent. Live staging evidence still needs route-by-route Gateway log
  capture and a tenant-policy spoof matrix against deployed code.

- **RealtimeSession DO lifecycle observability - locally verified
  (2026-07-05).** The hibernatable `RealtimeSession` Durable Object now writes
  a bounded, non-secret lifecycle metrics record to Durable Object storage on
  WebSocket accept, text/binary message, close, and error events. The HTTP
  status response includes `observability: "durable_object_storage"` and the
  persisted metrics alongside restored socket attachments, while the WebSocket
  control message `status` returns the same metrics snapshot for smoke tests.
  The metrics deliberately store counts, timestamps, last auth/model context,
  token fingerprints, and truncated close/error text only; request payloads,
  raw protocol API keys, and raw bearer tokens are not serialized. Local
  evidence: `cargo test -p cinatoken-worker --lib realtime_session` (9 passed;
  389 filtered), `cargo test -p cinatoken-worker --lib` (398 passed), and
  `bun run check` (passed; frontend route audit 214 calls / 307 Worker routes /
  0 missing calls). Live staging still needs hibernation/resume smoke plus the
  upstream Realtime bridge, billing settlement, and audit trail.

- **RealtimeSession smoke harness - locally verified (2026-07-05).** Added
  `tools/smoke_realtime_session.mjs` and `bun run smoke:realtime-session` to
  make the Durable Object long-session path executable in staging. Platform
  mode connects `/api/platform/realtime/:session`, sends `ping` and `status`,
  validates the `realtime_session_status` metrics frame, then fetches the HTTP
  status path and validates persisted metrics. `/v1/realtime` mode resolves the
  OpenAI-compatible path and redacts the Realtime subprotocol API key in output.
  Local evidence: `bun tools/smoke_realtime_session.mjs --help` (passed),
  `bun run check:realtime-session:smoke-plan` (passed), and a v1 dry-run with
  a synthetic API key (passed with `openai-insecure-api-key.<redacted>` in
  output). Live staging still needs the same tool run against a real
  `REALTIME_SESSIONS` binding.

- **RealtimeSession control payload hygiene - locally verified
  (2026-07-05).** Unsupported text control messages now return only bounded
  metadata (`text_chars` and `text_bytes`) instead of echoing client message
  bodies. The Realtime smoke harness sends a probe after `ping` and `status`,
  fails if the response contains a legacy `received` field, and fails if the
  probe text appears anywhere in the control response. Local evidence:
  `cargo test -p cinatoken-worker --lib realtime_session` (passed; 10 tests,
  including a Unicode/secret summary test), `bun
  tools/smoke_realtime_session.mjs --dry-run --json --url
  http://127.0.0.1:8787 --session session-smoke --probe secret-do-not-echo`
  (passed without printing the probe text), and `bun run check` (passed;
  frontend gates, WFP plans, Realtime smoke plan, workspace tests, and Worker
  / WFP wasm32 checks). Live staging still needs the same no-echo proof against
  a real `REALTIME_SESSIONS` binding.

The preferred workspace is now `C:\cinagroup\cinatoken-rust`, which avoids the
VirtualBox/shared-drive file-lock issues seen under `Z:`. If the old `Z:`
checkout is used, move Cargo output to a local temp directory before running
checks:

```powershell
$env:CARGO_HTTP_TIMEOUT='120'
$env:CARGO_NET_RETRY='10'
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR="$env:LOCALAPPDATA\Temp\cinatoken-rust-target"
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check
```

### Deterministic P0 source-to-D1 reconciliation (2026-07-10)

- Added `cinatoken-migrate reconcile` and `bun run reconcile:migration` for
  source/target SQLite comparison of `users`, `tokens`, `channels`, `abilities`,
  and `options`.
- The v1 manifest contains counts, logical PK bounds, canonical SHA-256 values,
  deterministic logical-key/row-hash samples, and integrity/relationship
  results without raw rows or secrets. JSON normalization is restricted to
  declared configuration columns; token/channel credentials stay byte-exact.
- `cargo test -p cinatoken-migration` passed all 30 tests and the CLI help smoke
  passed. Real production-source execution and remote staging D1 reconciliation
  remain pending.

### Realtime hibernation bridge-loss fail-closed (2026-07-10)

- A restored client attachment with `upstream_connect_handoff=true` and no
  active in-memory provider bridge now fails closed on its first business text
  or binary frame. Control-only platform sockets and `ping`/`status` diagnostics
  keep their previous behavior.
- The terminal path runs before a new `response.create` reservation, sends only
  metadata (`upstream_unavailable`, direction, frame kind/bytes, close code),
  and closes the client with 1011 before any D1 await. It then best-effort
  refunds non-retry-owned reservations through the existing idempotent D1 path.
- Verified locally with the two focused Worker tests for the terminal event and
  compiled capability contract, plus
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`.
- Still pending: deployed DO eviction/restore, D1 outage plus lease recovery,
  duplicate close/refund, redaction, and fresh reconnect evidence.

### TaskRunner recurring alarm state machine (2026-07-11)

- `poll_one_task` now returns a typed `{cas_won, terminal}` outcome, so a
  non-terminal progress update is not mislabeled as terminal settlement and the
  cron settled counter increments only for terminal CAS wins.
- The per-task DO re-reads D1 after a lost CAS, re-arms non-terminal progress,
  retries transient D1/provider failures with bounded `15/30/60s` backoff, and
  stops after `TASK_RUNNER_MAX_ALARM_FIRES` (default `20`, clamped `1..240`) with
  an explicit `fast_path_horizon_exhausted` cron-fallback reason.
- `/api/platform/capabilities`, the admin TaskRunner probe, the Cloudflare panel,
  and `smoke_task_runner_alarm_replay.mjs` distinguish `progress_applied`,
  `nonterminal_cas_noop`, confirmed terminal replay, retry, and cron fallback.
- Focused Worker TaskRunner tests, frontend readiness tests, and TaskRunner smoke
  self-test/dry-run passed locally. Live alarm/cron race and no-double-settlement
  evidence are still required before the gate can be enabled.

### AI Gateway cross-model fallback foundation (2026-07-11)

- `RELAY_MODEL_FALLBACK_ENABLED=false` gates an exact bounded JSON map from a
  requested primary model to one AI-Gateway-prefixed fallback. Malformed, empty,
  self-referential, oversized, or provider-unprefixed fallback configuration
  fails validation.
- The Rust outer model-attempt path supports OpenAI-compatible chat/Responses
  and route-aware Anthropic Messages. It re-checks token model limits, resolves
  the fallback model's complete D1 candidate pool, filters to explicit AI
  Gateway opt-in, applies per-channel model mapping, validates an executable
  Gateway plan, rebuilds billing input, refunds the primary tiered reserve, and
  reserves the fallback snapshot before egress.
- Direct transport fallback now strips the Gateway prefix and is limited to
  fetch/server failures. `401`, `403`, and `429` remain Gateway responses and do
  not bypass policy. Internal transport evidence is carried through a fresh
  mutable response and removed before the client response.
- Capabilities and frontend readiness separate compiled, enabled, configured,
  valid, runtime-ready, staging-verified, and cutover-ready states. The smoke
  self-test validates canonical capability routes and rejects optimistic
  cutover.
- Focused Worker model-fallback/direct-fallback tests and frontend readiness
  tests pass locally. `cargo test -p cinatoken-worker --lib` passed all 520
  tests, `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
  passed, and the complete `bun run check` workspace/frontend/smoke/wasm gate
  passed at the end of the increment.
- Still pending: deployed replay, terminal audit Queue/D1 delivery evidence,
  and fault-injected D1 proof of the locally compiled actual-serving-group
  reservation plan. The gate and staging verification marker remain false.

### AI Gateway Messages cross-model fallback hardening (2026-07-14)

- `plan_relay_model_fallback` now treats the relay route as part of the contract.
  `/v1/messages` is admitted only when primary and fallback logical model
  prefixes both support the Anthropic Messages schema. Workers AI `@cf/` and
  unprefixed models fail closed before quota mutation.
- Every fallback candidate is loaded from the full fallback-model D1 pool. The
  standard single-entry Redis selection cache is intentionally bypassed for
  this rare path because AI Gateway opt-in and per-channel model mapping are
  part of eligibility. Each mapped effective model is schema-checked and must
  produce an AI Gateway plan before primary refund and fallback reservation.
- `401`, `403`, and `429` are sticky cross-model vetoes across the whole primary
  channel attempt chain. A later `5xx` or fetch failure cannot erase the policy
  decision; same-model channel retry remains unchanged.
- Added `RELAY_MODEL_FALLBACK_MESSAGES_STAGING_VERIFIED=false`. Platform JSON,
  the React readiness panel, and the smoke contract expose Messages compiled,
  staging, and cutover separately. Overall cutover requires both the existing
  replay marker and the Messages marker; smoke self-test rejects bypass.
- Focused local checks passed: provider AI Gateway 13/13; the root fallback
  contract now runs 18 Worker tests, the 14-case smoke self-test, and a
  Messages dry-run; frontend readiness passed 38/38. The Worker tests cover
  logical schema, sticky veto, fallback channel ownership, selection mode,
  mapped effective model, and readiness. This is not remote evidence. The
  route-specific marker remains false pending deployed
  non-stream/stream, billing, audit, mixed-status, and rollback replay.
- Final local gates passed: Worker lib 661/661, the complete `bun run check`
  chain, `bun run check:cf:dry-run`, and serial `bun run check:cf:startup` with
  Wrangler 4.110.0. The generated startup profile was removed and no remote
  deployment or provider request was made.

### Relay terminal attempt audit (2026-07-11)

- Requests that exhaust every channel without retaining an upstream response
  now refund any active tiered reserve before emitting one Go-compatible
  `logs.type=5` error event through the existing `LOG_QUEUE` producer and
  synchronous D1 fallback.
- The admin-only ledger records primary/fallback phase, logical model, selected
  group, channel id, sanitized failure class, status when available, and AI
  Gateway opt-in. It never serializes channel names, raw fetch/configuration
  errors, URLs, keys, request bodies, or response bodies.
- Ledger storage is capped at 32 entries while preserving the true attempt
  count and an `attempts_truncated` marker. A normal first-attempt success adds
  no attempt array; successful consume rows remain type 2.
- Terminal events carry a Worker-generated 128-bit audit id when randomness is
  available. The Queue consumer and synchronous D1 fallback then use the same
  conditional insert keyed by log type plus exact event payload. Random-source
  failure uses a normal insert so an audit is not dropped merely because it
  cannot be deduplicated.
- Primary and fallback URL/AI Gateway planning failures now enter the same
  refund/audit path instead of returning after pre-consume. Configuration
  failures do not trigger cross-model fallback.
- `/api/platform/capabilities`, the Cloudflare admin panel, frontend readiness,
  and the AI Gateway smoke contract require
  `relay_ai_gateway_cross_model_terminal_audit_compiled=true` and expose the
  `terminal_attempt_audit` cutover guard.
- `smoke_relay_ai_gateway_canary.mjs --expect-terminal-audit` injects a unique
  request id, polls the admin type-5 log query through Queue delay, and rejects
  missing/duplicate rows, unsettled refund metadata, oversized ledgers, missing
  random audit ids, or sensitive markers.
- Local pure-contract tests cover type 5, terminal-event recognition, zero
  quota/tokens, redaction, refund metadata, and bounded ledger behavior. Remote
  Queue/D1 delivery, conditional-insert replay, DLQ behavior, user/admin log
  rendering, and injected refund failure remain unverified.
- Final local verification passed: storage 5/5, Worker 522/522, frontend
  readiness 3/3, the Worker WASM target check, smoke self-test/dry-run plans,
  and the complete `bun run check` workspace/frontend/smoke/WASM gate.

### AI Gateway actual-serving-group billing contract (2026-07-11)

- Tiered billing now evaluates and freezes the billing expression once per
  logical model plan. Candidate group snapshots rebase only the effective group
  ratio, preserving the same request inputs, expression result, and evaluation
  time across channel retries.
- The plan reserves the maximum estimated quota across candidate groups once.
  The retained response selects the snapshot for the actual serving group;
  final settlement applies usage to that snapshot and refunds the difference
  from the maximum reserve.
- Cross-model fallback refunds the primary plan, rebuilds candidate groups and
  billing input for the fallback model, and reserves a separate maximum before
  fallback egress. Its response is settled against the fallback serving group.
- Flat billing is now gated on the absence of a tiered preflight. A tiered D1
  settlement failure remains pending/shadowed and cannot fall through to a
  second flat charge.
- The capability/smoke contract requires
  `relay_ai_gateway_cross_model_actual_group_billing_compiled=true` and the
  `actual_serving_group_billing` guard. The self-test rejects a missing or false
  capability instead of silently normalizing it into readiness.
- This is local contract evidence, not deployment evidence. Fixed-group and
  `auto` D1 replay must still prove reserve amount, actual-group selection,
  exact refund delta, retry exhaustion, fallback-plan replacement, and rollback
  before the fallback gate or staging verification marker can be enabled.

### Actual-group billing Worker-binding smoke CLI (2026-07-11)

- Added `tools/smoke_relay_actual_group_billing.mjs` for the default-off,
  admin-only `POST /api/platform/relay/actual-group-billing/smoke` route.
- `--self-test` validates all three fixed scenarios, capability fail-closed
  behavior, strict plan reconciliation, mandatory cleanup, and cookie redaction.
  `--dry-run` prints the three request bodies and expected evidence without
  network or D1 access. Live mode requires an admin cookie and
  `--confirm-live`.
- A live result is accepted only when the Worker reports `status=PASS`,
  `bindingPath=worker_binding`, matching final/expected snapshots, valid maximum-
  candidate-group reserve/refund evidence, and `cleanupVerified=true`.
- The smoke also requires
  `relay_ai_gateway_actual_group_billing_staging_smoke_compiled/enabled/ready`
  to all be true. The enabled flag remains `false` by default.
- The Worker rejects cleanup opt-out and verifies fixed fixture IDs plus their
  ownership markers before conditional deletion, so a staging collision fails
  closed.
- D1 auth now carries `tokens.cross_group_retry` through ordinary REST,
  cross-model fallback, and Realtime planning. This local CLI contract does not
  claim that any deployed staging Worker or remote D1 has executed the smoke.

### WFP authority replay Durable Object contract (2026-07-11)

- Added the platform-owned `WfpAuthorityReplay` SQLite Durable Object and
  `v4-wfp-authority-replay` configuration migration in all Worker environments.
- The Rust/Wasm tenant receives no authority verifier or replay binding. It
  enforces route/body bounds and forwards the opaque authority to the outbound
  boundary. The outbound Worker matches the Cloudflare-provided invocation
  context and exact final request before replay consumption or bearer access.
- The outbound Worker calls the platform-owned replay DO. The DO authenticates
  the central-authority v3 signature and consumes the signed request ID before
  paid egress. Duplicate, invalid, and unavailable outcomes map to explicit
  `409`, `403`, and `503` fail-closed responses.
- The DO re-verifies claims with the platform master and requires its own ID to
  equal the canonical worker/issuance-bucket ID. Storage keys hash request IDs;
  alarm cleanup is scheduled after the whole bucket's token lifetime.
- The outbound service, not the tenant uploader, binds the external
  `WFP_AUTHORITY_REPLAY` namespace by expected main script and class. The
  dispatch binding must expose exactly one outbound parameter named
  `CINATOKEN_WFP_OUTBOUND_CONTEXT` and the expected environment.
- Current local checks pass: authority 8/8, tenant 15/15, outbound 4/4,
  platform-gateway 26/26, Workerd lifecycle 12/12, frontend readiness 22/22,
  tenant readback 16 cases, outbound readback 30 cases, outbound egress 17
  cases, and the WFP dispatch contract checks.
- The local Workerd config supplies a static invocation object and therefore
  does not prove remote Dynamic Dispatch parameter propagation. Required
  staging evidence remains: schema-3 attachment/environment/parameter/replay
  readback, runtime context negatives, sequential and concurrent one-winner
  replay, eviction/redeploy persistence, alarm cleanup, load/latency, one
  provider call, one central billing outcome, and redacted traces. A newly
  signed request ID on a retry is outside this exact-envelope guarantee.

## Still Pending

### Rust scheduling gateway owner contract (2026-07-11)

- `cargo test -p cinatoken-gateway` covers owner precedence, exact WFP internal
  status dispatch, tenant preview normalization/no-fallback behavior, Realtime
  control-route ownership, and static/API boundaries.
- Worker unit and wasm checks cover the live planner integration plus existing
  Realtime/WFP/platform handler contracts.
- Cloudflare Platform frontend readiness tests cover the distinction between a
  compiled/active owner contract and staging/production verification.
- Final local verification passed: `cargo test -p cinatoken-gateway` (5/5),
  `cargo test -p cinatoken-worker --lib` (547/547),
  `bun run check:web:routes` (217 frontend calls, 313 Worker routes, 0 missing
  calls), `cargo fmt --all --check`, `git diff --check`, and the complete
  `bun run check` workspace/frontend/smoke/WASM gate. The only warnings remain
  the two existing `d1_repositories.rs` dead-code warnings.
- Deployment evidence remains pending: main and tenant host routing, disabled
  dispatch, missing binding, WFP 404/503 behavior, Realtime control precedence,
  and rollback must be archived from a replacement-credential staging deploy.

### WFP dispatched-fetch failure contract (2026-07-11)

- Cloudflare's current dynamic-dispatch example catches `Worker not found`
  around the actual user Worker `fetch`; the Rust path previously caught
  binding/lookup failures but allowed a dispatched-fetch error to escape via
  `?`.
- The Worker now catches lookup and fetch errors and maps a versioned,
  secret-free contract: direct missing worker 404, relay missing worker 502,
  CPU/subrequest limit 429, other tenant execution failure 502. Platform WFP
  errors include `Cache-Control: no-store`.
- `/api/platform/capabilities` and the frontend expose the contract version,
  classes, and compiled state. WFP implementation readiness requires this
  contract but remains separate from runtime and staging evidence.
- Final local evidence passed: Worker 548/548 (including failure
  classification, route mapping, and smoke-readiness guards), frontend
  readiness 8/8, route audit 217 frontend calls / 313 Worker routes / 0
  missing, Worker and WFP tenant wasm32, smoke failure-contract self-test (five
  code/status/no-store cases plus mismatch rejection), dry-run missing-worker
  plan, formatting/diff checks, and the complete `bun run check` chain. The only
  warnings remain the two existing `d1_repositories.rs` dead-code warnings.
- Live missing-script/binding/limit/exception fixtures, the normal-relay absent
  worker case, redacted logs, billing refund/audit reconciliation, and rollback
  remain pending. The exposed credential was not used.

### Provider relay capability authority and DeepSeek (2026-07-11)

- `cargo test -p cinatoken-providers`: 25 passed, including exact coverage of
  all 53 Go channel types, generic adapter parity, dedicated fail-closed route
  sets, route-scoped cache families, and DeepSeek URL/request transforms.
- `cargo test -p cinatoken-relay`: passed with the generic OpenAI channel set
  corrected to Go's actual `openai.Adaptor` dispatch.
- Focused Worker tests passed for DeepSeek route/provider selection, pre-reserve
  candidate filtering, and the admin readiness contract.
- Frontend readiness tests passed 2/2. `bun run check:web:routes` reports 217
  Worker-facing calls, 312 Worker routes, and 0 missing calls after the reviewed
  baseline update.
- `bun run check` passed, including frontend type/build/quality checks,
  workspace tests excluding Worker, Worker wasm32, and WFP tenant wasm32.
- This is local implementation evidence. The earlier real DeepSeek smoke used
  compatibility/native channel configurations; it does not replace a live
  type-43 adapter fixture archive, deployed staging billing reconciliation,
  provider error replay, or production canary/rollback evidence.

- The frontend artifact and public HTTP contract still need deployed
  verification. Rendered browser smoke, authenticated session/role/CRUD/2FA
  flows, console inspection, and the 2026-07-03 backend route batch deployment
  remain pending.
- The production bundle-size budget is now enforced locally, but the bundle
  still needs heavy route-specific chunk splitting and deployed browser
  performance evidence before G5 production approval.

- The former Windows local Wrangler/`workerd` startup blocker is closed for the
  2026-07-10 local evidence window after installing the Microsoft Visual C++
  2015-2022 Redistributable (x64): local D1 applied 20/20 and the localhost
  Worker `DB` binding settlement smoke passed 6/6 with cleanup at zero. Future
  Windows operators must keep this runtime prerequisite in the bootstrap
  checklist.
- Remote staging remains unverified. Wrangler was not authenticated, so
  staging D1 migrations, deploy/startup, `/api/status`, capabilities,
  logs/traces, and the six-scenario Worker-binding settlement smoke still need
  authenticated evidence. Do not use the leaked token observed during setup;
  revoke/rotate it and use a replacement scoped credential.
- The relay path now has a live smoke against a REAL provider (DeepSeek):
  `/v1/chat/completions` non-stream + streaming and `/v1/messages` (Anthropic
  Messages), all with exact billing on real usage (see the entry above). The
  async-task (video) path's live smoke still used a protocol-faithful emulator
  (no real video-provider credentials were supplied), so a real video-provider
  task submit is the one untested live path.
- Relay families beyond chat/completions and Anthropic Messages (embeddings,
  rerank, native Gemini, image generation, responses) still have compile/unit
  coverage only — not yet exercised against a live upstream (streaming and
  Anthropic Messages ARE now live-verified via the DeepSeek smoke above).
- No source SQLite file or SQL DSN is available in the current shell, so real
  source row counts have not been captured yet.

- **Passkey WebAuthn finish and atomic challenge state - locally verified
  (2026-07-12).** Registration, discoverable login, and authenticated step-up
  now use a pure Rust ES256/RS256 verifier and the `PasskeyCeremony` Durable
  Object instead of KV delete-on-read. D1 credential replacement is batched;
  assertion state uses sign-count CAS; secure verification and authenticated
  challenge keys are bound to the exact signed browser session. Local evidence:
  `cargo test -p cinatoken-worker --lib` passed 571/571,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passed, and
  route audit reports 217 frontend calls / 313 Worker routes / 0 missing. The
  complete `bun run check` repository/frontend/smoke/Wasm gate also passed. This
  does not claim real-authenticator or deployed Durable Object evidence; use
  the staging matrix in migration-plan section 22.155 before production.

### Native Rate Limit And Topup Migration Evidence (2026-07-12)

- `bun run check:cf:native-rate-limits` passed: six distinct namespace IDs
  across development/staging/production, two bindings per environment, native
  backend in every vars table, and matching isolated Realtime bindings.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passed after
  adding the runtime `Ratelimit.limit()` adapter. Only the two existing D1
  repository dead-code warnings remain.
- `bun run build:worker` passed with worker-build 0.1.14, wasm-bindgen 0.2.125,
  and Bun-locked esbuild 0.28.1.
- `bun tools/smoke_realtime_local_suite.mjs --start-worker --confirm-local
  --json --base-id 920300` passed all six scenarios through native token/IP
  admission. The managed suite cold-started workerd per scenario and restored
  billing options and fixture rows after each stop.
- The response usage scenario observed prompt/completion/total
  1,200/350/1,550, cached/audio input/audio output 400/180/90, one settlement
  write, one applied mutation, replay and audit recorded, final quota 2,870,
  delta 2,862, and no retry.
- `cargo test -p cinatoken-migration` passed 36/36 after the expired-status
  correction. The implementation covers pending, success, failed, and expired
  status, idempotent duplicate imports, invalid domains, canonical/credited
  drift, and topup-user relationships.
- `bun run check:cf:dry-run` passed against Wrangler 4.103.0. The reviewed
  manifest reported an 8,360.58 KiB raw / 2,928.06 KiB gzip upload, token and
  IP bindings at 120/60s and 600/60s, and the native backend. The wrapper
  accepted success only after Wrangler's completion marker and terminated the
  known post-completion residual process handles.

This remains local evidence. Required remote evidence is authenticated staging
binding readback, route-family 429 telemetry/load behavior, production-source
topup count/hash, remote D1 import, provider callback replay, no-double-credit,
paid reconciliation, and rollback. No exposed Cloudflare token was used.

### Auth Data, AI Provider Registry, WFP Readback, And Wallet State (2026-07-12)

- `cargo test -p cinatoken-migration` passed 40/40. The new auth fixtures prove
  byte-exact Passkey/TOTP/backup-code material, strict timestamp and field
  validation, skipped soft-deleted 2FA rows, idempotent no-overwrite imports,
  redacted drift reporting, and auth ownership relationships.
- `cargo test -p cinatoken-providers` passed 26/26. The AI Gateway registry
  recognizes the documented REST prefix set; invalid/empty/undocumented
  prefixes fail closed. At this 2026-07-12 snapshot, direct fallback was
  restricted to provider-matched OpenAI, Anthropic, and DeepSeek channels; the
  2026-07-13 Mistral/xAI verification below supersedes that provider set.
- `cargo test -p cinatoken-worker --lib relay_ai_gateway -- --nocapture`
  passed 11/11. Capabilities expose REST routes, model prefixes, and the smaller
  direct-fallback prefix set; mismatched channels do not receive a rewritten
  provider-direct request.
- The AI Gateway smoke self-test passed nine cases, including route drift,
  unsafe direct-prefix, unsafe cutover, missing terminal audit, and missing
  actual-serving-group billing rejection.
- `bun run check:wfp-tenant:post-upload-verifier` passed 8/8. Script, module,
  binding, hash, readback, and dispatch mismatches were rejected, and the dry
  run remained credential-free. This does not claim a Cloudflare upload.
- `bun run check:wfp-tenant:readback-collector` passed 15/15. Redirects,
  malformed envelopes/multipart, response/module/part limits, deployment and
  compatibility drift, credential echoes, and module credential leakage fail
  closed. The dry-run performs no network request and reads no credential.
- Frontend wallet and platform readiness tests passed 13/13. The wallet now
  renders failed topups as Failed/danger rather than Pending, while the platform
  panel distinguishes Gateway-routable prefixes from safe direct fallbacks.
- `cargo test -p cinatoken-worker --lib` passed 577/577. The complete
  `bun run check` also passed frontend type/build/quality, bundle redaction and
  budget, route audit (217 frontend calls / 313 Worker routes / 0 missing),
  WFP/Realtime/AI Gateway contracts, workspace tests, and Worker/WFP wasm32.

Remote staging and production remain unverified for this increment. Required
evidence is a real WFP details/settings/content capture plus positive dispatch,
provider-route AI Gateway logs/faults and billing reconciliation, production
auth source/import hashes, imported-credential browser authentication, and
rollback. No exposed Cloudflare token was used.

### Realtime Outbound Bridge Lifetime Boundary (2026-07-12)

- `cargo test -p cinatoken-worker --lib` covers the compiled lifecycle contract,
  including the 840-second deadline, exact expiry comparison, close code/reason,
  and metadata-only terminal event.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` verifies the
  DO-local delayed lifetime guard, upstream event-pump stop check, pre-reserve
  text/binary expiry checks, D1 refund helper reuse, lease cleanup, and
  persisted terminal metrics compile for Workers.
- Status attachments expose only `upstream_bridge_deadline_ms`; raw upstream
  credentials and bridge payloads remain absent.
- This local gate does not prove Cloudflare timing, eviction, reconnect, or
  exactly-once billing behavior. Staging evidence must hold a real bridge until
  the 14-minute boundary, verify both sockets close with
  `upstream_bridge_lifetime_exceeded`, reconnect into a fresh segment, and
  reconcile reservations, retries, audit rows, and user quota without duplicate
  charge or refund.

### Remaining Source Data Families (2026-07-12)

- `cargo test -p cinatoken-migration` passed 45/45 after adding full
  `midjourneys` and `prefill_groups` import/reconciliation coverage plus explicit
  `quota_data`, `setups`, and `perf_metrics` exclusion manifests.
- `cargo clippy -p cinatoken-migration --no-deps -- -D warnings` passed.
- `cinatoken-migrate data-families` emits the versioned import/exclusion
  registry; unknown options fail closed.
- Fixture reconciliation proves deterministic table hashes and samples,
  relationships, active prefill-name uniqueness, JSON/BLOB preservation,
  no-overwrite idempotency, canonical drift detection, excluded-family row
  counts, and audited schema hashes.
- No production SQLite source or remote D1 was used. Production verification
  must still archive source counts/hashes, import SQL application, target
  reconciliation, explicit exclusion manifests, workflow smoke, and rollback.

### WFP Outbound Attachment Readback Contract (updated 2026-07-13)

- `bun run check:wfp-outbound:readback-collector` passed 30/30 cases. The
  read-only collector uses the official dispatch namespace, Worker settings,
  Worker secrets, script subdomain, and service-filtered Worker Domains GET
  endpoints with bounded JSON, a 30-second timeout, manual redirect rejection,
  strict Cloudflare envelopes, and before/after namespace identity comparison.
- Positive evidence requires an untrusted namespace; one exact `DISPATCHER`
  binding to the requested namespace and `cinatoken-wfp-outbound`; the expected
  outbound environment; exactly one `CINATOKEN_WFP_OUTBOUND_CONTEXT` parameter;
  the exact plain-text account binding; the environment-correct external replay
  DO binding; and `CINATOKEN_WFP_OUTBOUND_AI_TOKEN` in outbound settings and
  secret inventory but not on the dispatcher. Known deploy, readback, and
  retired tenant bearer names fail closed.
- Schema 3 additionally requires deployed `workers.dev` and Preview URL flags
  to be false and zero Custom Domains for the outbound service. The tracked
  Wrangler config explicitly sets both flags false and declares no route; the
  platform capability and frontend panel report this only as compiled evidence.
- The collector accepts no token argument. Live mode reads only a rotated
  `CINATOKEN_WFP_READBACK_TOKEN` after both confirmation flags. Dry-run reads no
  credential and performs no network or file write. Output contains normalized
  binding metadata and secret names only, with the account identifier redacted;
  token-value and base64-token echoes fail closed.
- This is local contract evidence, not a remote Cloudflare capture. No exposed
  credential was used. Remote staging must still archive `verified=true`, then
  enumerate every account Zone Worker route and prove none targets the outbound
  script, then
  prove bearer/authority/replay-free tenant readback, live Dynamic Dispatch
  context propagation, four-route egress, final-boundary negatives, Gateway
  logs, authority replay, exactly-one provider call, central billing, audit,
  and rollback. WFP production remains **NO-GO**.
- The complete `bun run check` release gate passed after this update: Workerd
  11/11, frontend readiness 22/22, zero missing frontend-to-Worker routes, 22
  D1 migrations, workspace tests, and main/tenant/outbound wasm32 checks.

### WFP Paid Egress Smoke Contract (2026-07-12)

- `bun run check:wfp-outbound:egress-contract` passed 17/17 cases, including a
  complete mock capabilities -> public relay -> exact type-2 audit chain and a
  streamed response-limit rejection. The four-route dry-run is credential-free,
  performs no network or file writes, and uses fixed non-streaming payloads of
  130-154 bytes with an eight-token output cap.
- Live mode permits one route per process and pins the reviewed staging origin,
  route-specific model, body, 2 KiB request limit, 16 KiB relay response limit,
  and 30-second request timeout. It accepts no live URL/model/body/header or
  credential argument. Dedicated relay-token and admin-session credentials are
  read only from `CINATOKEN_WFP_EGRESS_SMOKE_TOKEN` and
  `CINATOKEN_WFP_EGRESS_SMOKE_ADMIN_COOKIE`; raw, base64, base64url, and
  percent-encoded echoes fail closed.
- Capabilities now expose parsed `relay_retry_times`; smoke refuses unless it is
  zero, all WFP authority/runtime/egress guards are true, the four-route manifest
  excludes embeddings, and cross-model fallback is disabled. The frontend WFP
  paid-smoke readiness signal applies the same central single-attempt rule.
- Each successful live route must return JSON 2xx with no auth/cookie,
  `cf-aig-*`, `x-cinatoken-wfp-*`, or other internal header. The admin audit poll
  then requires exactly one type-2 row with the generated request ID, expected
  channel/model/group and WFP worker, nonnegative quota, `billing_pending=false`,
  resolved tiered/flat/refund metadata, and no billing-error or secret markers.
- Fixed `AI_GATEWAY_MAX_ATTEMPTS=1` and a single candidate WFP channel remain
  deployment/readback prerequisites because they are tenant/channel state, not
  central capabilities. Gateway/provider logs and before/after quota snapshots
  remain external evidence. No live request or exposed credential was used;
  WFP production remains **NO-GO**.
- Flat billing audit correctness was tightened: a successful flat quota
  mutation now sets `billing_pending=false`, with a focused Rust test. This
  makes the new audit gate distinguish resolved flat billing from an actual
  pending mutation.
- The post-upload verifier now states its evidence scope explicitly as
  `wfp-tenant-artifact-and-status` and always emits
  `paidEgressVerified=false` and `productionVerified=false`. Its compatibility
  `verified=true` cannot be used as paid-path or cutover evidence.

### Durable Object lifecycle runtime gate and scoped WFP evidence (2026-07-13)

- Fixed a TaskRunner alarm retry defect: Durable Object storage read and decode
  failures are no longer converted to a missing record. `/status` and `alarm`
  now propagate malformed/storage failures, allowing Cloudflare's alarm retry
  semantics to apply, while an actually absent record remains a successful
  no-op.
- Added `task_runner_storage_error_retry_contract_compiled` and the
  `storage_error_retry` cutover guard across platform capabilities, the
  TaskRunner smoke contract, frontend readiness, and the operator panel.
- Added `bun run check:do-lifecycle-runtime` using Cloudflare's Vitest Workers
  pool against the release `worker-build` artifact. Five Workerd tests passed:
  one of eight concurrent authority consumes won; duplicates returned 409;
  consumption survived DO eviction; tampered and wrong-shard authorities were
  rejected; malformed TaskRunner state made alarm/status reject; and a missing
  record alarm completed as a no-op.
- The WFP paid-egress tool no longer emits an unqualified `verified` result.
  Dry-run and live output state `verificationScope`; only the positive relay,
  billing, and audit chain can set `positiveRelayBillingVerified=true`.
  `authorityNegativeMatrixVerified`, `replayVerified`,
  `exactlyOneProviderCallVerified`, and `productionVerified` remain false.
- Test dependencies were locked to Vite 7.3.5 or newer in the 7.x line; the
  `bun audit` report contains no known vulnerabilities for this dependency set.
- The complete `bun run check` release gate passed after these changes,
  including the production frontend build and audits, 21-migration SQLite
  verification, all local smoke contracts, workspace tests, and Worker/WFP
  wasm32 checks.
- Evidence boundary: this is local Workerd/runtime evidence, not authenticated
  Cloudflare staging evidence. No remote deployment, provider call, D1 quota
  mutation, alarm retry observation, or production action was performed. The
  exposed credential was not used; rotation remains required. Production is
  **NO-GO**.

## 2026-07-13 Cross-Worker And Platform Boundary Verification

- `check:do-lifecycle-runtime` builds the main Worker, WFP tenant, and WFP
  outbound release artifacts and runs them as separate Workerd services. The
  suite now includes tenant status plus concurrent signed-authority traffic
  through the real tenant and outbound Workers to a provider-counting mock.
- The concurrency assertion requires one success, seven replay conflicts, and
  exactly one provider call. It also proves outbound-only Bearer injection,
  Cookie isolation, and removal of authorization, Set-Cookie, and AI Gateway
  response metadata.
- `check:wfp-dispatch:response-header-guard` includes the three preview browser
  side-effect headers. Worker unit tests prove they are removed only from
  regular PreviewHost HTTP responses and that WebSocket/internal dispatch
  classification is preserved.
- `check:realtime-session:platform-admin-auth-contract` proves missing platform
  auth is rejected, the Cookie is attached only to platform requests, and the
  self-test report cannot contain the Cookie value. Live platform smoke requires
  `--cookie` for both WebSocket and status probes; dry-run emits only
  `adminCookieConfigured`.
- Before accepting this increment, run `cargo test -p cinatoken-worker --lib`,
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`,
  `bun run check:do-lifecycle-runtime`, `bun run check:web:readiness`, and the
  complete `bun run check` release gate. Remote evidence remains outstanding.
- Completed result: Worker 580/580, WFP tenant 16/16, WFP outbound 4/4,
  multi-service Workerd 7/7, frontend readiness 16/16, complete
  `bun run check`, and `bun audit --json` all passed locally.

## 2026-07-13 Full Import Reconciliation And Channel Compatibility

- `D1_RECONCILE_TABLES` now equals the complete 23-table import set. Rust tests
  require set and projection equality so adding an import target without a
  reconciliation specification fails the migration crate gate.
- Representative source/target fixtures now cover logs, tasks, check-ins,
  redemptions, all four subscription tables, vendors/models, custom OAuth,
  Passkey/2FA, Midjourney, and prefill groups. Canonical comparison includes
  source-name/column transformations, computed fields, SQLite affinity, JSON,
  status/domain checks, and cross-family relationships without emitting raw
  rows or credentials.
- Exact Worker routes now serve the frontend's channel model catalog, bounded
  test-all, bounded balance-refresh-all, and copy operations. Batch maintenance
  is capped at 12 eligible channels with concurrency 3 and fully awaited work;
  larger fleets fail closed pending Queue/Workflow orchestration. Channel copy
  retains the source key only inside D1, resets test metadata, optionally resets
  balance/quota, rebuilds abilities, invalidates caches, and writes redacted
  audit metadata.
- `GET /api/user/logout` now shares the existing cookie-clearing handler with
  `POST`. The frontend route auditor distinguishes literal and dynamic segments,
  self-tests the matcher, and reports 217 frontend calls with zero missing.
- Focused verification passed: migration 47/47, Worker 586/586, Worker wasm32,
  route matcher self-test, zero-missing route audit, formatting, and diff checks.
  The complete `bun run check` release gate also passed, including the three
  release Worker builds, multi-service Workerd 7/7, frontend readiness 16/16,
  21-file D1 replay, workspace tests, and main/tenant/outbound wasm32 checks.
- This remains local implementation evidence. No production SQLite snapshot,
  remote D1 import, authenticated browser operation, provider maintenance run,
  Cloudflare deployment, or cutover was performed. Credential rotation and all
  G2/G5/G7/G8 evidence remain blocking; production is **NO-GO**.

## 2026-07-13 Dedicated xAI Adapter Verification

- `cargo test -p cinatoken-providers`: 32/32 passed.
- `cargo clippy -p cinatoken-providers --no-deps -- -D warnings`: passed.
- The focused Worker xAI provider, transform, capability, and AI Gateway test
  passed.
- Type 48 fails closed outside chat completions, legacy completions, Responses,
  and image generations. Its AI Gateway plan is narrower and rejects legacy
  completions.
- `cargo test -p cinatoken-worker --lib`: 587/587 passed; Worker wasm32 check
  passed.
- Frontend type-48 readiness fixture: 2/2 passed.
- The complete `bun run check` release gate passed, including three release
  Worker builds, Workerd 7/7, frontend build/redaction/budget/lint/route audits,
  21-file D1 replay, workspace tests, and main/tenant/outbound wasm32 checks.
- No live provider or Cloudflare credential was used; production remains
  **NO-GO** pending the documented staging evidence.

## 2026-07-13 Dedicated Mistral And Gateway Fallback Verification

- Go source audit covered `relay/channel/mistral/adaptor.go` and `text.go`:
  only chat conversion is implemented; embeddings and Responses return errors.
- `cargo test -p cinatoken-providers`: 40/40 passed, including Mistral URL,
  whitelist, multimodal, max-token, tool-call ID, fail-closed entropy, routing,
  capability, Gateway route, Mistral/xAI direct-fallback contracts, audio/file/
  video normalization, and out-of-order tool-call ID consistency.
- `cargo clippy -p cinatoken-providers --no-deps -- -D warnings`: passed.
- `cargo test -p cinatoken-worker --lib`: 590/590 passed. The Worker integration
  proves CSPRNG tool-call IDs, request-local ID consistency, route filtering,
  Mistral Gateway planning/direct fallback, xAI model-sensitive fallback
  reapplication, planner-direct normalization, mismatched-prefix rejection, and
  pre-reserve Go-compatible chat request validation.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.
- Frontend platform readiness: 16/16; channel provider readiness: 2/2.
- The complete `bun run check` gate passed, including three release Worker
  builds, Workerd 7/7, frontend build/redaction/budget/lint/route audits,
  21-file D1 replay, workspace tests, and main/tenant/outbound wasm32 checks.
- Evidence anchor: the full gate completed at `2026-07-13T03:19:34Z` against
  the implementation worktree based on `220a4162da1a07f70ace068a4755d000d750b27b`;
  only this timestamp/base evidence line was added after that successful gate.
- The capability registry now reports 31 Deferred channel types. No live
  Mistral/xAI or Cloudflare credential was used; production remains **NO-GO**.

## 2026-07-13 Dedicated Perplexity And Submodel Verification

- `cargo fmt --all -- --check`: passed.
- `cargo test -p cinatoken-providers`: 46/46 passed, including Perplexity Sonar
  URL/whitelist/token normalization/Gateway contracts and Submodel route
  allowlist/direct-only routing contracts.
- `cargo clippy -p cinatoken-providers --no-deps -- -D warnings`: passed.
- `cargo test -p cinatoken-worker --lib`: 593/593 passed. The Worker tests prove
  Perplexity chat-only capability, pre-reserve FIM rejection, dedicated request
  shaping, Gateway planning/direct fallback, and unsupported Responses; they
  also prove Submodel chat/completions routing, stream-options support, opaque
  model preservation, and Gateway exclusion.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.
- Frontend channel provider readiness: 2/2 passed; platform readiness: 16/16.
- The complete `bun run check` gate passed, including three release Worker
  builds, Workerd 7/7, frontend build/redaction/budget/lint/route audits, 21-file
  D1 replay, workspace tests, and main/tenant/outbound wasm32 checks.
- Evidence anchor: the full gate completed at `2026-07-13T03:58:06Z` against the
  implementation worktree based on `1c3cb5ed3a21107b9a5d7715d627d95f03d8c89d`.
- The capability registry now reports 29 Deferred channel types. No live
  Perplexity/Submodel or Cloudflare credential was used; production remains
  **NO-GO** pending credential rotation and archived provider-specific staging,
  billing, Gateway/WFP where applicable, and rollback evidence.

## 2026-07-13 Dedicated SiliconFlow Multi-Route Verification

- The Go source and billing-expression contracts were audited before changing
  request shaping or fixed-price settlement. Type 40 now exposes only chat
  completions, legacy completions, embeddings, rerank, and image generations.
- `cargo test -p cinatoken-providers`: 52/52 passed; provider Clippy with
  `-D warnings` passed. Coverage includes the source-compatible URL, FIM body,
  image aliases, current and legacy rerank usage, malformed envelopes, and
  direct-only routing.
- `cargo test -p cinatoken-billing`: 80/80 unit tests plus 10/10 Go parity tests
  passed; billing Clippy with `-D warnings` passed. Fixed-price image billing
  now applies the effective request count before quota rounding while tiered
  billing expressions remain unchanged.
- `cargo test -p cinatoken-worker --lib`: 596/596 passed. Worker coverage proves
  pre-reserve request validation, direct-only Gateway/WFP rejection, opaque
  model preservation, bounded response transforms, usage/audit settlement,
  failure refunds, stream options, and effective image batch multipliers.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passed with
  only the two pre-existing D1 dead-code warnings. Frontend channel and platform
  readiness passed 18/18.
- The complete `bun run check` gate passed, including three release Worker
  builds, Workerd 7/7, frontend build/redaction/budget/lint/route audits,
  21-file D1 replay, workspace tests, and main/tenant/outbound wasm32 checks.
- Evidence anchor: the full gate completed at `2026-07-13T04:36:39Z` against the
  implementation worktree based on `632311891f7a78d8768ec23a210d7cd93dd903b5`.
- The capability registry now reports 28 Deferred channel types. No live
  SiliconFlow or Cloudflare credential was used; production remains **NO-GO**
pending credential rotation and archived provider-specific staging, billing,
authenticated frontend, and rollback evidence.

## 2026-07-13 Dedicated Moonshot Dual-Format Verification

- The Go Moonshot, Claude helper, cached-token post-processing, rerank usage,
  and coding-plan URL contracts were audited before finalizing type 25. Rust
  exposes only chat completions, legacy completions, embeddings, rerank, and
  Anthropic Messages; all other routes and existing AI Gateway/WFP transports
  fail before quota reserve.
- Provider 57/57 and relay 73/73 tests passed. Fixtures cover normal and
  coding-plan URLs, unsupported-route rejection, Kimi K2.6 temperature,
  Messages default max tokens and `-thinking`, exact cached-token precedence,
  cross-event SSE cache preservation, rerank prompt usage, and direct-only
  routing.
- `cargo test -p cinatoken-worker --lib`: 599/599 passed. Worker tests cover
  both provider kinds, Bearer forwarding selection, pre-reserve request shape,
  special-plan rejection, route capability authority, Gateway/WFP exclusion,
  stream options, non-stream usage, nested stream cache, and rerank usage.
- Frontend channel/platform readiness passed 18/18. Type 25 is Partial with
  exactly five routes; the registry reports 16 Ready, 10 Partial, and 27
  Deferred channel types.
- The complete `bun run check` gate passed, including three release Worker
  builds, multi-service Workerd 7/7, frontend build/redaction/budget/lint/route
  audits, 21-file D1 replay, workspace tests, and main/tenant/outbound wasm32
  checks. `bun audit --json` returned an empty finding set.
- Evidence anchor: full gate completed at `2026-07-13T05:14:43Z` against the
  implementation worktree based on `cbded1f239f21be25284159186a7f43d8f116199`.
  Only the two existing `d1_repositories.rs` dead-code warnings remained.
- No live Moonshot or Cloudflare credential was used. Production remains
  **NO-GO** pending credential rotation and archived dual-format staging,
  billing, error/refund, authenticated frontend, disable, and rollback evidence.

## 2026-07-13 Workerd Realtime Eviction And Channel Probe Verification

- The release main Worker, WFP tenant, and WFP outbound Rust/Wasm artifacts
  built successfully. The multi-service Cloudflare Vitest Workers pool passed
  8/8 cases, including explicit SQLite `RealtimeSession` eviction with a live
  hibernatable client socket. The post-eviction frame retained the same
  serialized attachment and bridge segment, advanced persisted text metrics,
  and reported one restored attachment through HTTP status.
- The eviction test has no outbound provider WebSocket. It is evidence for
  client hibernation and durable attachment/metric restoration only, not active
  upstream recovery, exactly-once refund/lease transfer, no-second-call, remote
  compatibility-date, provider, or production behavior.
- Worker tests passed 609/609. The new focused coverage proves strict endpoint
  names, Go-compatible model-sensitive auto selection, route capability
  rejection, non-stream-only compact/rerank/image/embedding probes, minimal
  request shapes, first-key/model mapping, direct/AI Gateway/WFP/Workers AI
  planning, route-specific JSON shapes, route-specific non-DONE SSE events,
  strict POST JSON fields, and exact GET/POST route registration.
- Worker wasm32 passed with only the two pre-existing D1 dead-code warnings.
  The complete `bun run check` gate also passed workspace tests, main/tenant/
  outbound wasm32 checks, 21 contiguous D1 migrations with 26-table SQLite
  verification, and all existing WFP, Realtime, task, and AI Gateway contract
  self-tests/dry-run plans.
- Frontend Channel Test and platform readiness tests passed 22/22. TypeScript
  and the production build passed. The route audit found 217 frontend calls,
  319 Worker routes, and zero missing calls. Bundle redaction scanned 460 files
  and found zero findings; the budget gate passed at 19.01 MB raw and 4.51 MB
  gzip, which remains close enough to its 20.50/4.90 MB limits to monitor.
- `bun audit --json` returned an empty finding object. `cargo fmt --all
  --check`, frontend lint/format, `git diff --check`, protected-reference, and
  credential/private-key scans passed; scan-only matches were existing
  defensive assertions and test fixtures, not embedded credentials.
- Evidence anchor: the full gate completed at `2026-07-13T06:28:54Z` against
  the implementation worktree based on
  `67786d46f22ab7343b79129b04038c6cc8d214da`.
- No exposed Cloudflare token was read or used and no remote request was made.
  Production remains **NO-GO** pending credential revocation/rotation,
  authenticated provider/transport staging probes, active-upstream eviction
  with billing idempotency, canary, rollback, and G1-G8 approval evidence.

## 2026-07-13 Global Realtime Orphan Recovery Evidence

- `python tools/verify_sqlite.py` passes the complete chain at 22 migrations,
  27 required tables, 69 incremental columns, and 17 key indexes. Migration
  0022 provides the global lease scan, retry-deferral fields, aggregate sweep
  state, and recent-outcome index.
- `bun run check:realtime-session:settlement-batch-contract` passes 15/15. The
  added race contract proves settlement may commit at `lease + 300s`, is
  rejected at `lease + 301s`, global refund then restores quota once, and a
  delayed replay cannot replace that terminal outcome.
- `bun run check:do-lifecycle-runtime` builds optimized main, WFP tenant, and
  WFP outbound Rust/Wasm artifacts and passes 11/11 Workerd tests. The scheduled
  cases call the generated default Rust `WorkerEntrypoint.scheduled()` with
  Cloudflare's scheduled controller and execution context.
- Managed-runtime assertions prove inside-grace no-op, exactly-once refund under
  overlapping cron delivery, terminal replay no-op, and failed-oldest-row
  deferral followed by recovery of a newer valid row with a one-item sweep.
- Focused Worker Realtime tests, gateway route-precedence coverage, the SQLite
  contract, JavaScript syntax checks, `cargo fmt`, and `git diff --check` pass.
  The only Rust warnings remain the two pre-existing unused topup repository
  functions. Workerd also prints the pre-existing corrupt TaskRunner fixture's
  expected decode exception while all 11 assertions pass.
- The recovery gate remains false in all tracked environments. These results
  are local E3 evidence only: migration 0022 has not been applied remotely, no
  provider or authenticated public reserve path was used, and no production
  credential was used. Production remains **NO-GO**.

## 2026-07-13 User-Specific Playground Runtime Evidence

- `GET /api/user/self/groups` now resolves the live user's own and special
  usable groups and applies per-user `GroupGroupRatio` overrides; the public
  groups endpoint remains the global/default view.
- `GET /api/user/models` uses one parameterized abilities/channels query and
  excludes disabled channels and channel types without Chat Completions
  capability according to the Rust provider registry.
- `SidebarModulesAdmin.chat.playground` defaults to true while preserving an
  operator's explicit false value. The frontend contract includes the
  authenticated `/playground` SPA route.
- `cargo test -p cinatoken-worker --lib` passes 612/612, including the new SQL
  parameterization/filter and capability-clamp tests.
- `bun run test:playground-runtime` passes 1/1 against the complete release
  Rust Worker in Workerd with the canonical D1 migrations and a controlled
  provider. It proves setup/login, status advertisement, user-specific group
  and ratio responses, chat-only model discovery, denied group override,
  non-stream and SSE forwarding, upstream `group` stripping, user quota debit,
  two request-count increments, and two consumption-audit rows.
- This is local evidence. Isolated staging still requires browser interaction,
  synthetic token-table non-mutation, channel quota reconciliation, native
  rate-limit scoping, logout/disabled/quota-exhausted negatives, deploy
  readback, credential-redaction checks, and rollback. Production remains
  **NO-GO**.

## 2026-07-13 Authenticated Realtime Reservation And Guard Cancellation

- The complete release Rust/Wasm Workerd lifecycle suite passed 11/11.
- Its reconstruction case now enters through authenticated
  `GET /v1/realtime`, not a platform-only DO request or a directly seeded
  reservation. The fixture applies the canonical 22-file D1 chain, seeds one
  enabled user/token/channel/ability and one tiered expression, then proves D1
  token auth, model-limited channel selection, one provider handshake, and a
  positive user/token quota debit from a real `response.create` reservation.
- The test then observes the controlled upstream runtime detach, evicts the
  hibernatable DO, sends the first restored business frame, and proves one
  metadata-only 1011 terminal event, one idempotent refund, exact user/token
  quota restoration, lease cleanup, a fresh bridge segment, and no second
  provider call.
- The first authenticated replay exposed a stale transient task: the bridge's
  840-second lifetime `Delay` survived after its upstream runtime had closed
  and prevented timely Workerd eviction. The runtime now owns an abort handle
  per bridge; both normal close marking and fail-closed shutdown cancel the
  guard immediately. The deadline behavior is unchanged while a bridge is
  active.
- Focused Rust Realtime tests passed 71/71 before the release build. No remote
  Cloudflare account or provider credential was used, all tracked production
  Realtime gates remain false, and production remains **NO-GO**.
- The complete `bun run check` gate also passed: three release Rust/Wasm
  artifacts, Workerd 11/11, Playground 1/1, frontend readiness 22/22, bundle
  redaction/budget/lint checks, 217 frontend calls against 320 Worker routes
  with zero missing calls, the exact 22-file D1 migration chain, all workspace
  tests, and main/tenant/outbound wasm32 checks.

## 2026-07-13 Jina Embeddings Adapter Parity Verification

- Source Go contract review confirmed Jina type 38 owns both `/v1/rerank` and
  `/v1/embeddings`; its embedding conversion clears `encoding_format` before
  JSON serialization. Current Jina primary documentation confirms the Bearer
  API at `https://api.jina.ai/v1/embeddings` and Jina-native embedding output
  fields.
- `cargo test -p cinatoken-providers` passed 59/59. New tests prove the exact
  two-route capability set, Cohere embeddings rejection, Jina-only removal of
  `encoding_format`, and preservation of model/input/dimensions plus native
  `task`, `normalized`, `truncate`, and `embedding_type` fields.
- `cargo test -p cinatoken-relay` passed 73/73 with explicit default Jina
  embeddings URL coverage. `cargo test -p cinatoken-worker --lib` passed
  614/614, including request-boundary isolation, admin auto-selection, and
  backend readiness serialization.
- Frontend provider-readiness projection passed 2/2 and the broad frontend
  readiness suite passed 22/22. The route audit classified 217 frontend calls
  against 320 Worker routes with zero missing calls.
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passed.
  The complete `bun run check` gate also passed release main/tenant/outbound
  Wasm builds, Workerd 12/12, Playground 1/1, bundle redaction and budget,
  22-migration/27-table D1 verification, workspace tests, and all three wasm32
  checks at `2026-07-13T11:17:51Z`, based on
  `35ba769bfc131722ed9e9483a601cede61504799`.
- No live Jina request or remote credential was used. Jina remains Partial
  until isolated staging proves both routes, usage and error handling,
  reservation/settlement/refund, audit/billing reconciliation, and rollback.
  Production remains **NO-GO**.

## 2026-07-13 Zhipu v4 Direct Adapter Verification

- The source type 16/type 26 adapters, billing-expression contract, and current
  Zhipu documentation were reviewed before implementation. Current official
  HTTP APIs use the v4 root. Type 26 is now Partial with the exact reviewed
  `chat/completions`, `embeddings`, `images/generations`, and Anthropic
  `messages` routes; legacy type 16 remains Deferred with an explicit migrate-
  to-type-26 decision instead of guessing an obsolete v3 contract.
- The type 26 request adapter ports the source chat normalization, keeps image
  payloads to the current documented fields, preserves image URLs instead of
  downloading arbitrary remote content inside the Worker, and rejects AI
  Gateway/WFP mode before reservation because Cloudflare has no native Zhipu
  provider route. Custom Provider staging remains a later, separately gated
  option.
- Billing expression changes were made only after reading the protected source
  expression specification. A successful usage-less image generation now
  settles by the explicit request contract: fixed-price expressions charge one
  request without fabricated tokens, while tiered expressions receive the
  actual zero-token vector and frozen request input. Failed image requests
  still refund.
- `cargo test -p cinatoken-providers --lib` passed 64/64 and
  `cargo test -p cinatoken-billing --lib` passed 80/80. Focused Worker tests
  cover the type 26 URLs, transforms, direct-only guard, type 16 deferral,
  Channel Test selection, and image request-contract settlement. Frontend
  readiness projection passed 2/2 and the broad readiness suite passed 22/22.
- The complete `bun run check` gate passed at `2026-07-13T11:51:42Z` against
  the implementation worktree based on
  `448209f639efb34e6c7532bbefb20a96f5012a22`: release main/tenant/outbound
  Rust/Wasm builds, Workerd 12/12, Playground 1/1, 217 frontend calls against
  320 Worker routes with zero missing calls, bundle redaction/budget/lint,
  22-migration/27-table D1 verification, all workspace tests, and all three
  wasm32 checks. Only the two pre-existing unused topup repository warnings
  remain.
- No provider credential, Cloudflare credential, remote account, or live Zhipu
  request was used. Type 26 remains Partial until isolated staging proves all
  four routes, error and streaming behavior, billing/audit reconciliation,
  rollback, and direct-vs-Custom-Provider deployment policy. Production remains
  **NO-GO**.

## 2026-07-13 Baidu V2 And VolcEngine Direct Adapter Verification

- Go source and current provider contracts were reviewed before implementation.
  VolcEngine(45) is Partial for the exact direct Ark v3 Chat Completions,
  Embeddings, Image Generations, and Responses routes; `doubao-coding-plan` is
  chat-only. Bot chat, TTS, rerank, image edits, ordinary Messages, AI Gateway,
  and WFP fail before quota reserve. BaiduV2(46) is Partial only for direct
  Qianfan v2 Chat Completions, with source-compatible `-search` normalization
  and `token|appid` header separation; its unimplemented source converter paths
  remain unavailable.
- `cargo test -p cinatoken-providers --lib` passed 71/71,
  `cargo test -p cinatoken-relay --lib` passed 73/73, and
  `cargo test -p cinatoken-worker --lib` passed 620/620. Focused provider and
  Worker fixtures cover URL allowlists, custom roots, credential parsing,
  request transforms, exact capabilities, model mapping, Bot/coding-plan
  rejection, direct-only transport, usage handling, Channel Test auto-selection,
  and frontend readiness projection.
- `cargo clippy -p cinatoken-providers --no-deps -- -D warnings` passed.
  `cargo check -p cinatoken-worker --target wasm32-unknown-unknown` passed with
  only the two pre-existing unused topup repository warnings. Frontend provider
  readiness passed 2/2 and the broad readiness suite passed 22/22.
- The complete `bun run check` gate passed at `2026-07-13T12:29:57Z` against
  the implementation worktree based on
  `0872615a3952a280239b46938247a414d19c4f4f`: release main/tenant/outbound
  Rust/Wasm builds, Workerd 12/12, Playground 1/1, frontend build/redaction/
  budget/lint, 217 frontend calls against 320 Worker routes with zero missing,
  22-migration/27-table D1 verification, all workspace tests, all WFP/Realtime/
  TaskRunner/AI Gateway contract checks and dry-run plans, and all three wasm32
  target checks.
- `docs/migration-progress-audit-2026-07-13.md` records the requirement-level
  E1-E5 evidence boundary and G1-G8 production gaps. No live provider or
  Cloudflare credential, remote account, or production data was used. The
  registry now reports 16 Ready, 13 Partial, and 24 Deferred channel types.
  Production remains **NO-GO** pending credential rotation, deployed staging,
  route-specific provider fixtures, billing/audit reconciliation, production
  data migration, canary, and rollback evidence.

## 2026-07-13 Ali DashScope Direct Adapter Verification

- Source type 17 and current DashScope contracts were reviewed before the
  implementation moved Ali from Deferred to Partial. Rust admits exactly Chat
  Completions, legacy Completions, current Responses, Embeddings, native
  Messages, and `gte-rerank-v2`, all direct-only. Images, audio, Gemini,
  non-native Messages conversion, qwen3 rerank, AI Gateway, and WFP fail closed
  before quota reservation.
- Providers tests prove current/default/custom URL ownership, source-compatible
  `top_p` clamping, bounded Messages model patterns plus
  `ALI_ANTHROPIC_MESSAGES_MODELS`, `gte-rerank-v2` request/response conversion,
  missing usage behavior, malformed success rejection, and the printable
  4-KiB server-owned plugin boundary. Worker tests prove pre-reserve filtering,
  model mapping without a second mapping pass, direct-only routing, main and
  fallback SSE usage-option policy, all six Admin probes including legacy
  Completions, and rerank validation before request conversion. Relay cache
  schema v4 carries `channels.other` and invalidates older channel entries.
- `cargo test -p cinatoken-providers --lib` passed 79/79,
  `cargo clippy -p cinatoken-providers --no-deps -- -D warnings` passed,
  `cargo test -p cinatoken-relay --lib` passed 74/74, and
  `cargo test -p cinatoken-worker --lib` passed 623/623. The Worker
  `wasm32-unknown-unknown` check passed with only the two pre-existing unused
  topup repository warnings.
- The complete `bun run check` gate passed at `2026-07-13T13:37:33Z` against
  the implementation worktree based on
  `cc03c98eec664a0480cd108c3a8d7b58f32e3b50`: release main/tenant/outbound
  Rust/Wasm builds, Workerd 12/12, Playground 1/1, frontend readiness 22/22,
  bundle redaction/budget/zero-lint-debt gates, 217 frontend calls against 320
  Worker routes with zero missing, the 22-migration/27-table D1 verifier,
  workspace tests, WFP/Realtime/TaskRunner/AI Gateway contract checks and
  dry-run plans, and all three wasm32 target checks.
- No provider credential, Cloudflare credential, remote account, or live Ali
  request was used. Ali remains Partial until isolated staging proves regional
  and workspace roots, each admitted route, JSON/SSE usage and errors, plugin
  channels, response bounds, reserve/settle/refund, D1 audit/provider invoice
  reconciliation, disable/recovery behavior, and Go rollback. Production
  remains **NO-GO**.

## 2026-07-13 Tencent Hunyuan TC3 Adapter Verification

- Source type 23 and the current Hunyuan ChatCompletions/TC3 contracts were
  reviewed before implementation. Rust admits exactly direct, non-streaming,
  text-only Chat Completions at the fixed official host. Unsupported fields,
  tools/multimodal input, streaming, custom base URLs, AI Gateway, and WFP are
  filtered before quota reservation.
- Provider tests cover strict three-part credential parsing, exact request
  conversion, UTC date boundaries, a fixed independently checked TC3 signature,
  direct/enveloped successes, optional `Note`, missing usage, and string/numeric
  provider errors. Worker tests cover pre-reserve filtering, direct-only
  transport, Admin probe constraints, provider-error status classes, and
  readiness projection. Normalized responses retain only bounded request-id
  and retry metadata rather than replaying arbitrary upstream headers.
- `cargo test -p cinatoken-providers` passed 90/90,
  `cargo clippy -p cinatoken-providers --no-deps -- -D warnings` passed,
  `cargo test -p cinatoken-relay` passed 74/74, and
  `cargo test -p cinatoken-worker --lib` passed 625/625. The Worker
  `wasm32-unknown-unknown` check passed with only the two pre-existing unused
  topup repository warnings. Frontend readiness passed 22/22.
- The complete `bun run check` gate passed at `2026-07-13T14:31:17Z` against
  the implementation worktree based on
  `0543128824220f16b9a8aa77ffac38eac346e234`: release main/tenant/outbound
  Rust/Wasm builds, Workerd 12/12, Playground 1/1, frontend build/redaction/
  budget/zero-lint-debt gates, 217 frontend calls against 320 Worker routes
  with zero missing, the 22-migration/27-table D1 verifier, workspace tests,
  WFP/Realtime/TaskRunner/AI Gateway contract checks and dry-run plans, and all
  three wasm32 target checks.
- No Tencent or Cloudflare credential, remote account, or live provider request
  was used. Type 23 remains Partial until rotated-credential staging proves TC3
  acceptance, UTC/skew behavior, direct/enveloped success, 400/401/403/429/503
  handling, retry winner, response bounds, usage, reserve/settle/refund, D1 and
  provider-invoice reconciliation, disable/recovery, and Go rollback. The
  registry reports 16 Ready, 15 Partial, and 22 Deferred channel types.
  Production remains **NO-GO**.

## 2026-07-13 Ordinary Relay Billing Reservation Verification

- Read the source billing-expression contract before changing settlement. The
  implementation preserves the frozen request-scoped expression snapshot and
  never reconstructs an orphan charge from live pricing.
- Migration 0023 adds `relay_billing_reservations` and
  `relay_billing_recovery_state`. `python tools/verify_sqlite.py` passes at 23
  migrations, 29 required tables, 105 incremental columns, and 20 key indexes;
  `bun run check:d1:migration-config` confirms all three bindings use the exact
  contiguous 23-file set.
- Repository tests cover the migration contract and matching settle/refund,
  conflict, and settle-vs-refund classifications. Reserve, selected binding,
  settlement, and refund use D1 row-count guards that roll back the full batch
  when an expected mutation does not affect exactly one row.
- Frontend readiness tests pass 22/22 and `bun run check:web` builds the updated
  Cloudflare operations panel.
- `cargo test -p cinatoken-worker --lib` passes 629/629. The final
  `bun run check` passes on this worktree, including release Rust/Wasm builds,
  Workerd 14/14 (with concurrent unbound refund and bound quarantine cases),
  Playground 1/1, frontend build/readiness/redaction/budget/zero-lint-debt and
  route audits, the 23-migration SQLite/config checks, all local smoke
  contracts, workspace tests, and Worker/WFP wasm32 checks.
- The admin-only `GET /api/platform/relay-billing/ledger/status` contract is
  compiled, `no-store`, and unit-tested to expose hashed reservation/account
  scope rather than raw keys or numeric identity pairs. The actual-group smoke
  cleanup now verifies that its ledger fixtures are removed.
- Recovery remains false in development, staging, and production config. No
  remote D1 migration, cron, provider request, Cloudflare credential, or live
  accounting mutation was used. Production remains **NO-GO**.

## 2026-07-13 HTTP SSE Billing Lease Heartbeat Verification

- Source Go streaming and billing ownership were re-audited after reading the
  protected billing-expression specification. The Rust change preserves the
  frozen request-scoped expression snapshot, adds no total stream-duration cap,
  and keeps one reserve/settlement owner per client request.
- D1 selected-reservation renewal is an exact generation CAS over reservation
  key, selected channel/group/timestamp, and prior lease expiry. It renews only
  before expiry, never during settlement grace, and classifies applied,
  matching, stale, finalized, expired, conflicting, and missing outcomes.
- The runtime heartbeat is bounded to 5 seconds through one third of the
  effective lease, uses deterministic +/-10% jitter, and retries D1 errors in at
  most 60 seconds without interrupting the client stream or mutating quota or
  request count. Audit metadata records only interval/timestamps/counters and
  bounded completion/stop reasons.
- Release Workerd passed 15/15. The new authenticated SSE fixture uses an
  explicit provider-release barrier, observes lease growth while request count
  remains zero, then proves one settlement, exact user/token/channel quota,
  one request count, one provider call, and the expected heartbeat audit row.
- `cargo test -p cinatoken-worker --lib` passed 631/631. Frontend readiness
  passed 23/23 and the production React/Bun build passed. The frontend and
  capability API distinguish implementation, valid runtime configuration,
  staging verification, and recovery cutover approval.
- `python tools/verify_sqlite.py` and `bun run check:d1:migration-config`
  passed at 23 migrations, 29 tables, 105 incremental columns, and 20 key
  indexes. `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`
  passed with only the two pre-existing unused topup repository warnings.
- The complete `bun run check` gate passed on this worktree: release main,
  tenant, and outbound Rust/Wasm builds; Workerd 15/15; Playground 1/1;
  frontend build/readiness/redaction/budget/zero-lint-debt and route audits;
  D1 config/SQLite checks; all local smoke contracts; workspace tests; and all
  three wasm32 targets.
- Local Workerd crosses a heartbeat interval, not the original 300-second test
  lease. No remote D1 migration, deployed long stream, disconnect/D1/restart
  fault matrix, provider request, credential, or recovery mutation was used.
  Staging proof and recovery remain false; production remains **NO-GO**.

## 2026-07-14 HTTP SSE Partial Usage Recovery Verification

- `cinatoken-relay` unit tests pass 75/75, including malformed-event recovery
  and `response.output_text.delta` accumulation.
- Focused Worker tests pass for endpoint-aware stream usage resolution and the
  six-gate recovery-cutover predicate. Empty Responses stays zero; output
  Responses estimates; valid upstream usage remains unchanged.
- Release Worker/WFP artifacts under Workerd pass 17/17. Two controlled stream
  failures prove partial local estimate and pre-error upstream usage settle once
  with exact ledger/user/token/channel/request/provider/audit evidence. The mock
  intentionally emits controlled stream-error diagnostics.
- `cinatoken-worker` library tests pass 634/634. The Worker wasm32 check passes
  with only the two pre-existing unused topup repository warnings.
- The focused platform readiness file passes 19/19 and the broad frontend
  readiness command passes 25/25. The panel and capability types expose
  estimate enablement, stream-error proof, billing Queue availability, replay
  implementation, replay proof, and final cutover separately.
- The complete `bun run check` release gate passes: release main/tenant/outbound
  Rust/Wasm builds; Workerd 17/17; Playground 1/1; frontend production build,
  readiness, redaction, budget, zero-lint-debt, and route audits (217 frontend
  calls / 320 Worker routes / 0 missing); 23-migration D1 config and SQLite
  verification (29 tables / 105 incremental columns / 20 indexes); all local
  smoke contracts; workspace tests; and all three wasm32 checks.
- No remote resource or credential was used. New staging flags remain false,
  `BILLING_QUEUE` is absent, replay reports unimplemented, HTTP orphan recovery
  remains disabled, and production remains **NO-GO**.

## 2026-07-14 Durable HTTP Billing Finalization Queue Verification

- The source billing-expression specification was read before changing the
  settlement path. Queue events freeze the already computed terminal decision;
  neither the consumer nor orphan recovery re-evaluates mutable pricing.
- `cargo test -p cinatoken-worker --lib` passes 640/640. Event tests cover schema
  identity, bounded size, zero-quota refund audit, strict redaction, and exact
  environment queue ownership. Runtime-gate tests prove that enablement,
  producer binding, consumer, DLQ, replay, reconcile, and D1 must all be true.
- Release Worker/WFP artifacts under Workerd pass 18/18. Billing fixtures
  traverse the actual Queue broker and Rust `queue` entrypoint for both settle
  and refund, then manually replay the same events. Matching duplicate delivery
  ACKs without a second quota/request/audit mutation; a billing event on
  `LOG_QUEUE` retries; and a poison event retries without preventing a valid
  event in the same batch from ACKing.
- `bun run check:cf:billing-queue` passes. It audits default/staging/production
  producer, consumer, batch bounds, retries, environment-specific DLQ, default-
  off gate, Rust-owned queue names, and the 64 KiB application event bound.
- `python tools/verify_sqlite.py` and `bun run check:d1:migration-config` pass for
  the exact 24-file chain through 0024, 29 required tables, 106 explicitly
  checked incremental columns, and 21 explicitly checked key indexes.
- `bun run check:web:readiness` passes 25/25. Capability types and the operations
  panel expose Queue gate/binding, consumer, DLQ, replay, reconcile, runtime,
  and proof separately. A regression test proves `verified=true` cannot bypass
  `ready=false`.
- The complete `bun run check` release gate passes, including release
  main/tenant/outbound Rust/Wasm builds, Workerd 18/18, Playground 1/1,
  frontend build and audits, D1 verification, local smoke contracts, workspace
  tests, and all three wasm32 checks.
- Queue transport remains false in every tracked Wrangler environment.
  Reconcile/DLQ replay reports unimplemented, so runtime readiness, scheduled
  HTTP orphan recovery, and cutover remain false. No remote migration, Queue,
  DLQ, credential, provider request, or deployment was used. Production remains
  **NO-GO**.

## 2026-07-14 Billing Finalization DLQ Reconcile Verification

Scope: local implementation evidence for migration 0025, DLQ quarantine, D1
incident claims, root step-up, single-event Queue replay, incident completion,
capability/frontend readiness, and configuration auditing. No remote Cloudflare
resource or credential was used.

Commands and results:

```powershell
cargo test -p cinatoken-worker --lib relay_billing --quiet
# 23 passed

bun run check:relay-billing-finalization:reconcile-contract
# 7 self-test checks passed

bun run check:cf:billing-queue
bun run check:d1:migration-config
python tools/verify_sqlite.py
# PASS; 25 migrations, 30 tables, 123 incremental columns, 23 key indexes

bunx vitest run --config vitest.do.config.mjs `
  -t "quarantines and queue-replays one billing DLQ incident under root step-up"
# 1 passed
```

Observed contracts:

- The runtime DLQ consumer ACKed one valid and one invalid message. The valid
  frozen event was canonicalized into a replayable incident; the invalid event
  retained no raw payload and only a SHA-256 fingerprint/classification.
- User/token/request accounting remained unchanged while the incident was only
  quarantined. The admin list returned bounded metadata without event ID,
  reservation key, or payload.
- Root replay without secure verification returned 403. Password step-up then
  permitted exactly one `{ "confirm_replay": true }` command and returned
  `202 queued` with replay generation 1.
- The main billing Queue consumer applied the frozen refund exactly once,
  inserted one billing audit, closed the incident as `resolved/applied`, and
  preserved one redacted manage audit. A second admin replay returned 409.
- The focused smoke client requires an explicit 64-hex incident ID, a pre-
  verified root Cookie, and `--confirm-live`; it caps the run at one incident,
  never prints the Cookie, and accepts no payload or pricing inputs.

Evidence classification: local E3/E4 only. Queue and reconcile gates are false
in every tracked environment. Authenticated remote migration 0025 application,
Queue/DLQ/parking readback, retry exhaustion, D1/Queue fault injection,
four-day-retention alert drill, provider/accounting reconciliation, credential
rotation, canary, and rollback remain required. Production remains **NO-GO**.

The complete `bun run check` release gate also passed after the integrity
hardening: release main/tenant/outbound Rust/Wasm builds; Workerd 19/19;
Playground 1/1; frontend build/readiness 26/26 plus redaction, budget, lint, and
route audits (217 frontend calls / 322 Worker routes / zero missing); Queue and
D1 checks; all local smoke contracts; workspace tests; and all three wasm32
targets. The Worker library contains 647 tests; the focused billing subset is
23/23. Only the two pre-existing unused topup repository warnings remain.

## 2026-07-14 HTTP Pre-Bind Owner Generation Verification

Scope: local migration-0026 owner fencing, immutable late-bind deadline,
pre-bind heartbeat, exact D1 ambiguity classification, Queue schema v2,
generation-fenced finalization/recovery, capability/frontend evidence stages,
and production rollout documentation. The source billing-expression contract
was read before modifying the settlement path; frozen expressions and request
context remain authoritative and are not re-read during Queue or recovery.

Commands and results:

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 651 passed

bun run check:web:readiness
# PASS; 27 passed

bun run check:d1:migration-config
python tools/verify_sqlite.py
# PASS; 26 migrations, 30 tables, 126 incremental columns, 23 indexes
# Includes 0026 active-reservation drain guard.

bun run check
# PASS; release Worker/WFP builds, Workerd 20/20, Playground 1/1,
# frontend build/audits, all local smoke contracts, workspace tests,
# and main/tenant/outbound wasm32 checks.

bun run check:cf:dry-run
bun run check:cf:startup
# PASS with Wrangler 4.110.0; tracked assets and bindings were accepted.
```

Observed contracts:

- Reserve creates generation 1 with an immutable `owner_deadline_at`. Pre-bind
  renewal changes only recovery lease metadata. A timely exact bind advances to
  generation 2; terminal settlement/refund/recovery advances once more.
- Bind and pre-bind renewal reject timestamps beyond the original deadline even
  after lease renewal. Heartbeat/deadline failure runs an idempotent cleanup
  refund instead of leaving pre-consumed quota without an owner.
- Ambiguous reserve/bind writes accept only exact frozen readback. Recovery CAS
  repeats generation and grace predicates; settlement allows L+300 and recovery
  starts at L+301.
- Queue schema v2 carries owner generation. Legacy v1 defaults to generation 1
  and migration 0026 normalizes drained legacy terminal rows to generation 2,
  preserving matching v1 replay while rejecting a forged later generation.
  Workerd exercises v2 settle, refund, duplicate, cross-queue, poison,
  DLQ/reconcile, and capability paths.
- `/api/platform/capabilities` reports migration count 26, compiled/schema/
  configured true, but staging proof and cutover false. The frontend presents
  those as four separate operational states.
- Tracked Wrangler environments keep Queue, reconcile, orphan recovery, and
  owner-generation proof false. `/api/*` and `/v1/*` run Worker-first before SPA
  asset fallback in default, staging, and production config.

The full gate also reports 217 frontend calls against 322 Worker routes with
zero missing, no bundle redaction findings, no lint regression, and no bundle
budget failure. Only the two pre-existing unused topup repository warnings are
present.

Evidence classification is local E3/E4. No Cloudflare credential was read, no
remote migration or resource was changed, and no provider request or deployment
was made. Credential rotation, migration-0026 drain/application, delayed-header
and ambiguity fault replay, Queue v2 drain, direct/Gateway/WFP accounting,
alerts, rollback, and G1-G8 approval remain mandatory. Production is **NO-GO**.

## 2026-07-14 QuotaCoordinator Shadow Foundation Verification

Scope: local M4 pure state machine, observation-only per-token Durable Object,
SQLite-backed class configuration, capability/frontend staging separation, and
production rollout/rollback documentation. The billing-expression source
contract was read before this work. Flat billing remains unchanged and D1
remains the sole financial writer.

Commands and results:

```powershell
cargo test -p cinatoken-coordinator
# PASS; 12 passed

cargo test -p cinatoken-worker --lib
# PASS; 653 passed

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; only two pre-existing unused topup repository warnings

bun run check:web:readiness
# PASS; 30 passed

bun run check:cf:quota-coordinator
# PASS; default/staging/production have one v6 SQLite class, retention/shadow/
# staging flags false, and an empty token allowlist

bun run check
# PASS; release Worker/WFP builds, Workerd 23/23, Playground 1/1,
# frontend production build and audits, 217 frontend calls / 322 Worker routes /
# zero missing, 26 D1 migrations / 30 tables / 126 checked columns / 23 indexes,
# workspace tests, and main/tenant/outbound wasm32 checks

bun run check:cf:dry-run
bun run check:cf:startup
# PASS with Wrangler 4.110.0; dry-run read QUOTA_COORD and both false gates,
# startup analysis completed locally. No deployment was performed.
```

Observed contracts:

- Pure observations reject unknown fields, invalid hashes, out-of-range quota,
  invalid generations, and invalid request counts. Checked arithmetic and state
  validation are transactional. Applied, replay, and conflict counts survive
  serialization; status contains no reservation or operation identifier.
- The DO requires a canonical positive token identity and matching deterministic
  object ID, accepts only bounded JSON on the internal observe route, and uses
  one storage transaction with no external I/O. Business conflicts are committed
  as evidence and return 409; malformed observations return 422; corrupt stored
  state propagates as a runtime error instead of being replaced.
- Workerd proves reserve, exact replay, payload conflict, settle, summary
  redaction, protocol rejection, corruption propagation, and identical state
  after Durable Object eviction. The first eviction run timed out because the
  test client retained an unread `/observe` response body; consuming that body
  made eviction deterministic and the complete 23-test lifecycle suite passed.
- Capabilities and the React/Bun panel separate foundation, binding, reserve,
  finalization, recovery, aggregate producer coverage, token scope, retention,
  shadow runtime, staging bake, write authority, and cutover. Producer coverage
  is true while retention and write authority remain false, so configuration
  metadata cannot manufacture runtime or cutover readiness.
- The observer currently persists one bounded JSON value. Cloudflare's
  SQLite-backed Durable Object key/value entry limit is 2 MiB, and the current
  long-lived-token retention/capacity policy has not been load- or size-proven.
  Shadow enablement therefore remains blocked pending compaction/retention
  design, serialized-size headroom, latency/cost evidence, alerts, rollback,
  and a signed 30-day zero-diff bake.

Relay reserve/direct-finalization, Queue replay, and orphan-recovery producers
are compiled but require both the retention and shadow gates plus an explicit
token allowlist. Every tracked environment keeps both gates false and scope
empty. No credential, remote namespace, migration, provider request, or
deployment was used; read authority, write authority, and production cutover
remain **NO-GO**.

## 2026-07-14 QuotaCoordinator Producer Coverage Verification

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 657 passed

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; only two pre-existing unused topup repository warnings

bun run check:web:readiness
# PASS; 30 passed

bun run check:cf:quota-coordinator
# PASS; four producer families present; retention/shadow/proof false and scope
# empty in default, staging, and production

bun run check:do-lifecycle-runtime
# PASS; 23 passed, including reserve/settle projection and duplicate Queue replay

bun run check
# PASS; release Worker/WFP builds, Workerd 23/23, Playground 1/1, frontend
# production build/audits, 217 frontend calls / 322 Worker routes / zero missing,
# 26 D1 migrations, workspace tests, and all three wasm32 checks

bun run check:cf:dry-run
bun run check:cf:startup
# PASS with Wrangler 4.110.0; default config exposes retention/shadow/proof false
# and empty token scope. Startup was analysed locally; no deployment occurred.
```

The projector reads committed D1 reservation state and emits reserve before any
terminal observation. Deterministic fingerprints and operation IDs make
at-least-once replay idempotent. Workerd confirms the observer can accumulate
replay evidence without repeating the D1 financial mutation. Fetch-path
observation is deferred with `Context::wait_until`; observer delivery errors are
post-commit diagnostics and cannot change the authoritative outcome.

This evidence is local E3/E4 only. Retention/load approval, off-path
reconciliation, authenticated namespace readback, alerts, disable-first
rollback, and the 30-day staging bake are still absent. Production is **NO-GO**.

## 2026-07-14 QuotaCoordinator Bounded Retention Verification

The billing-expression source contract was re-read before this increment. No
expression, normalization, price, quota, or request-count calculation changed;
the observer consumes only frozen D1 reservation facts and adds commit-time
retention metadata.

```powershell
cargo test -p cinatoken-coordinator -- --nocapture
# PASS; 15 passed; configured maximum serialized state = 1,234,821 bytes

cargo test -p cinatoken-worker --lib
# PASS; 657 passed; only two pre-existing unused topup repository warnings

bun run check:do-lifecycle-runtime
# PASS; 24 passed, including terminal compaction, expired replay rejection,
# status size reporting, and identical state after DO eviction

bun run check:web:readiness
# PASS; 31 passed; compiled compaction is distinct from operator retention proof

bun run check:cf:quota-coordinator
# PASS; compaction contract and all producer families present; retention/shadow/
# staging gates false and token scope empty in every tracked environment

bun run check
# PASS; release Worker/WFP builds, Workerd 24/24, Playground 1/1, frontend
# production build and audits, 217 frontend calls / 322 Worker routes / zero
# missing, 26 D1 migrations, workspace tests, and all three wasm32 checks

bun run check:cf:dry-run
bun run check:cf:startup
# PASS with Wrangler 4.110.0; dry-run reports QUOTA_COORD and all default-off
# gates, and serial startup analysis completes locally without deployment
```

Verified local contracts:

- New observations require a positive D1 commit timestamp. Reserve uses
  `created_at`; settle/refund use `updated_at`. Legacy persisted observations
  deserialize with zero only for migration compatibility and cannot be applied
  or automatically compacted.
- Default state limits are 512 active and 1,536 terminal records. Combined
  weighted capacity is validated, and the Worker sizes the complete state in
  the transaction before rejecting writes above 1,500,000 JSON bytes.
- Terminal overflow removes the minimum `(source_committed_at, fingerprint)`
  record, folds its complete reserve/terminal accounting into a validated
  cumulative rollup, and advances a monotonic watermark. Cumulative totals do
  not shrink when exact replay records rotate.
- An unknown reserve or terminal observation at or before the watermark is a
  persisted conflict, not a new application. Exact retained operation IDs
  remain replays. Workerd confirms both classifications survive eviction.
- Status exposes cumulative/retained/compacted/legacy counts, the timestamp
  watermark, current JSON bytes, and the internal limit, but no operation or
  reservation identifier.

This is local size and behavior evidence only. Cloudflare's SQLite-backed
key/value limit applies to the combined stored key/value representation, while
the 1,234,821-byte result is a JSON surrogate. No authenticated remote state,
hot-token window duration, structured-clone size, load latency, cost, alert, or
rollback evidence was collected. `QUOTA_COORD_RETENTION_VERIFIED` therefore
remains false; shadow/read/write authority and production cutover remain
**NO-GO**.

Operational note: the first startup-analysis attempt overlapped another
Wrangler custom build and failed while reading an in-progress worker-build
metadata file. Running the two build-writing checks serially passed. CI and
operator scripts must keep Wrangler custom builds for the same checkout
serialized.

## 2026-07-14 QuotaCoordinator Off-Path Reconciliation Verification

The billing-expression source contract was re-read before implementing the D1
projection. The probe compares frozen tiered reservation facts only; it does not
evaluate expressions, read mutable prices, or mutate user/token/channel state.

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 658 passed; includes D1-minus-observer projection/difference checks

bun run check:do-lifecycle-runtime
# PASS; 25 passed; AdminAuth/no-store/redaction, stable matched evidence, then
# a deliberately unobserved second D1 reservation producing a positive mismatch

bun run check:web:readiness
# PASS; 31 passed; reconciliation compile/runtime remains separate from bake

bun run check:cf:quota-coordinator
# PASS; all three environments remain shadow/retention/staging default-off

bun run check:quota-coordinator:reconciliation-contract
# PASS; 5/5 self-tests for redaction, confirmation, zero-diff and health gates

bun run check:quota-coordinator:reconciliation-plan
# PASS; redacted, read-only capability + fixed reconciliation POST plan

bun run check
# PASS; release Worker/WFP builds, Workerd 25/25, Playground 1/1, frontend
# production build and audits, 217 frontend calls / 323 Worker routes / zero
# missing, 26 D1 migrations, workspace tests, and all three wasm32 checks

bun run check:cf:dry-run
# PASS with Wrangler 4.110.0; QUOTA_COORD is bound, all quota gates remain
# default-off, token scope is empty, and no deployment occurred

bun run check:cf:startup
# PASS with Wrangler 4.110.0; local startup analysis completed serially after
# the dry-run build, and its generated diagnostic profile was not retained
```

Verified contracts:

- The admin route accepts token identity only in a strict JSON string body, not
  in the URL. The canonical positive ID must already be in the configured
  shadow allowlist, with shadow and retention gates open. The route does not
  provide an initialization, replay, repair, or write action.
- D1 is sampled before and after the DO status read. Any changed aggregate or
  revision marker produces `source_changed` with no difference decision.
- Stable projection compares reserve/settle/refund counts, active/terminal
  counts, four quota totals, user/token net deltas, channel used quota, and
  request count. Differences are D1 authoritative value minus observer value.
- A numerical zero diff is not sufficient: contract mismatch, persisted
  conflict, legacy terminal state, or size-limit breach makes the observer
  unhealthy and prevents `matched`.
- Responses are `no-store` and return only a domain-separated token scope hash;
  the staging harness omits both the admin cookie and raw token identity.

This is local E3/E4 evidence only. No authenticated remote namespace readback,
load/latency/cost measurement, alert delivery, rollback exercise, or 30-day bake
was performed. Reconciliation runtime remains false in tracked environments,
D1 remains the sole financial writer, and production is **NO-GO**.

## 2026-07-14 Realtime Terminal Ownership And Reconciliation UI Verification

The Realtime increment changes terminal ownership and recovery scheduling only;
it does not change billing-expression parsing, evaluation, frozen request input,
price lookup, group ratio, or settlement arithmetic.

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 658 passed, including strict Realtime settlement/recovery boundaries

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; only the two pre-existing unused topup repository warnings

bun run check:realtime-session:settlement-batch-contract
# PASS; 15/15, including NotDue at L, NotDue at L+300, one refund at L+301

bun run check:do-lifecycle-runtime
# PASS; release Worker/WFP builds and 25/25 Workerd tests

bun run check:web
bun run check:web:quality
# PASS; TypeScript/build, ESLint, and Prettier

bun run check:web:readiness
# PASS; 37/37, including six reconciliation workbench contract tests

bun run check:web:routes
# PASS; 218 frontend calls, 323 Worker routes, zero missing calls

bun run check
# PASS; release Worker/WFP builds, Workerd 25/25, Playground 1/1, frontend
# build/audits, 26 D1 migrations, workspace tests, and all three wasm32 targets

bun run check:cf:dry-run
bun run check:cf:startup
# PASS with Wrangler 4.110.0; bindings and default-off gates were inspected,
# startup was analysed locally, the generated profile was removed, no deploy ran
```

Verified local contracts:

- Expected-generation lease refund is rejected through `L+300` and may apply
  only from `L+301`. The DO alarm stores that first recovery instant, while D1
  repeats generation, lease, status, and strict grace predicates in the CAS.
- Client close/error and bridge/lifetime termination retain bound reservations
  and any segment with an in-flight `response.done`. Only unbound work with no
  active settlement is immediately refundable. Retry and lease queues retain
  exclusive ownership.
- The React workbench sends one strict body-only token scope, exposes all four
  reconciliation states and 13 comparison fields, and builds copied evidence
  from a redacted allowlist. It has no polling, URL/storage identity, replay,
  repair, or gate mutation.

This is local E3/E4 evidence. The Workerd suite exercises the existing runtime
matrix but does not yet inject a deterministic D1 delay to race a live
`response.done` against close/error and the DO alarm at all three boundaries.
Authenticated staging bake, provider traffic, alert delivery, and remote
rollback evidence remain absent. All Realtime writer/recovery and
QuotaCoordinator runtime/cutover gates remain default-off; production is
**NO-GO**.

## Realtime Ambiguous-Usage Quarantine Verification (2026-07-14)

Scope: local migration 0027, strict `response.done` classification,
single-owner D1 quarantine, scheduled-recovery exclusion, hash-only ledger v2,
and the read-only React/Bun operator panel. The required Go billing-expression
contract was reviewed before implementation.

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 661/661, including strict Realtime terminal classification, quarantine,
# settlement, and scheduled-recovery ownership tests

cargo test -p cinatoken-worker --lib platform_gateway -- --nocapture
# PASS; 30/30 selected platform tests, including hash-only Realtime ledger v2

bun run verify:sqlite
# PASS; 27 migrations, 30 tables, 130 incremental columns, 24 key indexes

bunx vitest run --config vitest.do.config.mjs `
  -t "quarantines Realtime response.done with null usage"
# PASS; release Workerd 1/1 selected, 27 skipped

bun run check:web:readiness
# PASS; 49/49, including Realtime ledger field-allowlist/redaction tests

bun run check:web
# PASS; TypeScript project build and production Rsbuild bundle

bun run check:web:routes
# PASS after intentional baseline update; 220 frontend calls, 323 Worker routes,
# zero missing calls

bun run check
# PASS; release Worker/WFP builds, Workerd 28/28, Playground 1/1, frontend
# build/audits, 27 D1 migrations, workspace tests, and all three wasm32 targets

bun run check:cf:dry-run
# PASS with Wrangler 4.110.0; release packaging resolved all bindings and kept
# Realtime, recovery, queue, QuotaCoordinator, and WFP rollout gates default-off
```

Verified behavior:

- `response.created` without identity and `response.done` with missing identity,
  missing/null/malformed/inconsistent usage, unknown status, completed zero
  usage, or ambiguous settlement fail closed. Explicit zero usage remains valid
  for cancelled, failed, and incomplete terminal responses.
- The null-usage Workerd scenario creates a positive authenticated reservation,
  claims `usage_reconciliation`, emits the safe billing error, closes 1011,
  suppresses the terminal provider frame, retains pre-consumption, and records
  no settlement replay or billing audit.
- After forcing that lease 3600 seconds overdue, the real scheduled handler
  leaves status/owner/quota unchanged. Automatic refund and settlement cannot
  cross the reconciliation owner.
- Ledger API/UI data contains only domain-separated fingerprints, controlled
  status/reason/timestamps, and sweep counters. The frontend normalizer drops
  unexpected raw session, bridge-segment, and provider-response fields.

This is local implementation evidence only. Remote migration 0027, live
provider usage/invoice reconciliation, D1/disconnect/eviction/redeploy races,
alerts, retention, operator resolution, rollback, and production approval are
absent. Go/VPS remains authoritative; production is **NO-GO**.

## Realtime Billing Reconciliation Verification (2026-07-14)

Scope: local migration 0028, stable open-queue pagination, frozen-expression
preview, root-only verified apply, atomic settlement/refund, terminal
provenance, and the controlled React/Bun operator workbench. The Go
billing-expression contract was reviewed before implementation; normalized
usage remains the only operator-supplied pricing input.

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 667/667, including reconciliation validation, preview digest,
# idempotency, owner/revision CAS, and terminal readback tests

bun run verify:sqlite
# PASS; 28 migrations, 30 tables, 137 incremental columns, 27 key indexes

bunx vitest run --config vitest.do.config.mjs `
  -t "quarantines Realtime response.done with null usage"
# PASS; selected Workerd refund path

bunx vitest run --config vitest.do.config.mjs `
  -t "settles quarantined Realtime usage through the operator workflow"
# PASS; selected Workerd settlement path

bun run check:do-lifecycle-runtime
# PASS; release Worker/WFP builds and 29/29 Workerd tests

bun run check:web:readiness
# PASS; 50/50, including reconciliation workbench and ledger v3 contracts

bun run check:web
# PASS; TypeScript project build and production Rsbuild bundle

bun run check:web:routes
# PASS after intentional baseline update; 223 frontend calls, 326 Worker routes,
# zero missing calls

bun run check
# PASS; release Worker/WFP builds, Workerd 29/29, Playground 1/1, frontend
# build/audits, 28 D1 migrations, workspace tests, and all three wasm32 targets

bun run check:cf:dry-run
# PASS; release packaging resolved the Worker and kept
# REALTIME_BILLING_RECONCILIATION_ENABLED=false
```

Verified behavior:

- The open queue is ordered by `(finalization_required_at, reconciliation_id)`
  and uses the same tuple as its cursor, so equal timestamps cannot skip rows.
- Preview uses the reservation's frozen expression and request snapshot. Apply
  requires a fresh root-admin verification, explicit confirmation, the exact
  preview digest, a bounded evidence reference, and an idempotency key.
- Settlement atomically updates user, token, channel, reservation, replay, and
  type-2/type-3 audit state. Refund atomically restores quota and records the
  terminal operator audit. Both paths use owner plus revision CAS and preserve
  quarantine provenance.
- The frontend exposes controlled action/reason values and every normalized
  usage dimension, resets state when the reservation revision changes, and
  keeps mutation controls unavailable unless the runtime capability is ready.

This remains local implementation evidence. Remote migration 0028, staging D1
application, authenticated operator drills, provider traffic, alert delivery,
rollback rehearsal, and production approval are absent. The production gate is
default-off, Go/VPS remains authoritative, and production is **NO-GO**.

## Non-Stream Billing Finalization And Reconciliation Cutover Verification (2026-07-14)

Scope: the positive-reserve non-stream parse/read boundary, consumed Cohere
rerank failures, independent 0028 staging proof, Realtime v1 cutover composition,
and the exact Cloudflare outbound-WebSocket hibernation boundary.

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 667/667

bunx vitest run --config vitest.do.config.mjs `
  -t "settles a delivered non-stream response|refunds a consumed Cohere"
# PASS; 2/2 selected, with Queue ACK and QuotaCoordinator terminal observation

bun run check:do-lifecycle-runtime
# PASS; release Worker/WFP builds and 31/31 Workerd tests

bunx vitest run --config vitest.do.config.mjs
# PASS; 31/31 after the Queue/DO logging quiescence fix, with no Vitest RPC
# teardown error. Controlled poison, stream-read, and corrupt-storage fault logs
# remain expected test evidence.

bun run check:web:readiness
# PASS; 51/51

bun run check
# PASS; Workerd 31/31, Playground 1/1, frontend build/audits, zero route gaps,
# 28 D1 migrations, workspace tests, and Worker/WFP wasm32 checks

cargo fmt --all -- --check
git diff --check
# PASS
```

Verified behavior:

- A positive-reserve 2xx whose untouched body cannot be inspected is delivered
  once and settles once at the frozen reserve with parse-fallback audit evidence.
- A consumed Cohere body-limit failure returns 502 only after one owned refund;
  user/token quota is restored, request accounting occurs once, and channel
  usage remains zero.
- Both runtime paths wait for the QuotaCoordinator terminal observation before
  test storage reset, so Queue ACK is not confused with D1 result visibility.
- Reconciliation readiness is represented in four stages. Its staging flag is
  false in every tracked environment and is required by the 37-input Realtime
  v1 cutover predicate.
- Workerd rejects forced eviction while the outgoing provider WebSocket remains
  active. No active-upstream hibernation claim is recorded. The retained local
  regression covers only detached-upstream restore and fail-closed cleanup,
  consistent with Cloudflare's documented inbound/outgoing socket distinction.

This remains local evidence. Remote direct/AI Gateway/WFP replay, migration and
Queue/D1 readback, provider invoice reconciliation, live network/redeploy
interruption, alerts, rollback, credential rotation, and G1-G8 approval remain
open. Production remains **NO-GO**.

## Zero-Reserve And Usage-Less Non-Stream Verification (2026-07-14)

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib
# PASS; 667/667

bun run check:do-lifecycle-runtime
# PASS; release Worker/WFP builds and 34/34 Workerd tests

bun run check
# PASS; release Worker/WFP builds, Workerd 34/34, Playground 1/1, frontend
# production build/readiness 51/51, 223 frontend calls / 326 Worker routes /
# zero missing, 28 D1 migrations, workspace tests, and all three wasm32 checks
```

Verified behavior:

- A tiered expression using completion tokens only begins with
  `pre_consumed_quota=0`, still creates and binds a reservation, and settles
  positive provider usage once through `BILLING_QUEUE` and D1 CAS.
- A configured flat model whose successful body cannot be inspected is blocked
  with 502 before delivery. User/token/channel quota stays unchanged, request
  count increments once, and the audit records
  `not_charged_response_blocked` plus redacted disposition metadata.
- Usage-less fixed-price `/v1/audio/speech` applies the configured `ModelPrice`
  before returning the binary response, with exact user/token/channel and
  request accounting.

This remains local E3 evidence. Generic flat billing idempotency, abort/idle
classification, remote direct/Gateway/WFP replay, provider invoice correlation,
credential rotation, alerts, rollback, and G1-G8 approval remain open.
Production remains **NO-GO**.

## Task Submit Reconciliation Local Verification (2026-07-15)

```powershell
python tools/verify_sqlite.py
# PASS; 33 migrations, 32 tables, 190 incremental columns, 34 key indexes

bun run check:d1:migration-config
# PASS; expected head 0033, exact migration count 33

bun run check:do-lifecycle-runtime
# PASS; release Wasm build and 41 Durable Object lifecycle tests

bun run check:web
# PASS; TypeScript and production frontend build

bun run check
# PASS; 702 Worker unit tests, 59 frontend readiness tests, 41 Workerd
# lifecycle tests, full workspace tests, route/bundle/config audits, and main,
# tenant, and outbound wasm32 checks
```

The schema replay proves that an operator cannot resolve a quarantined intent
without the matching immutable event, one atomic refund restores the frozen
wallet/token balances, and reconciliation events cannot be updated or deleted.
Worker unit tests cover action/reason validation, provider identity validation,
legacy refund-only handling, and deterministic preview binding. The frontend
tests cover queue record behavior, provider ID constraints, and readiness-stage
mapping.

This is local evidence only. Before staging proof, archive the exact candidate
SHA and redacted output, then follow the 0032/new-Worker/drain/0033 sequence in
the smoke runbook. No Cloudflare credential or remote deployment was used for
this increment. Production stays **NO-GO**.

## Durable Task Billing Ownership Hardening Verification (2026-07-15)

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 696/696

cargo test -p cinatoken-tasks
# PASS; 124/124

python tools/verify_sqlite.py
# PASS; 31 migrations/tables, 167 incremental columns, 30 key indexes,
# and the 0031 Task billing state machine

bun test apps/web/source/default/src/features/subscriptions/subscription-funding.test.ts
# PASS; 5/5

bun run check:web:readiness
# PASS; 56/56

bun run check
# PASS; frontend and Worker builds, D1/DO/Queue/TaskRunner contracts,
# workspace tests, and main/tenant/outbound wasm32 checks

git diff --check
# PASS
```

Verified behavior:

- Migration 0031 owns Task billing intent, reservation, attachment, terminal
  settlement, and refund state in D1. Trigger guards reject invalid
  transitions and channel deletion while money is reserved or recovery is
  required.
- Video, Suno, and Midjourney submission classify explicit provider rejection
  separately from ambiguous transport or response failures. Explicit
  `2xx`/`4xx` rejections atomically refund; `5xx`, redirects, network failures,
  and malformed outcomes remain recoverable and do not risk a duplicate
  provider submission.
- Recovery sweeps include confirmed pre-provider rejections and D1-owned
  Midjourney timeouts, including legacy second timestamps. Refunds remain
  possible after user or token soft deletion, and accepted provider work can
  still attach before reaching its terminal state.
- Task authentication preserves token, user, expiry, model, IP, and token-quota
  checks. Only a frozen billing plan with `free_model=true` may bypass an empty
  user wallet; paid plans remain fail-closed.
- Subscription funding controls consume server capability facts and show a
  localized blocking reason instead of exposing an unsupported production
  path.

This is local E3 evidence. Stable provider idempotency, generation-fenced poll
leases, `submit_unknown` operator reconciliation, checked 64-bit financial D1
bindings, full HTTP/Realtime free-model parity, remote fault/load/rollback
evidence, credential rotation, and G1-G8 approval remain blocking. Production
remains **NO-GO**.

## Native Container Shard Foundation Verification (2026-07-15)

```powershell
cargo test -p cinatoken-sharding
cargo test -p cinatoken-worker --lib container_scheduler
bun run check:container-scheduler-config
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:web
bun run check
```

Current-head local evidence is PASS: `cinatoken-sharding` 5/5, focused Worker
scheduler tests 3/3, scheduler configuration 4/4, full Worker unit tests
714/714, Workerd lifecycle tests 43/43, frontend readiness tests 70/70, and
the complete `bun run check` chain including 39 D1 migrations, workspace tests,
release builds, bundle audits, and all three wasm32 targets.

The pure planner must prove deterministic owner selection, canonical stable DO
names, generation fencing without same-topology remapping, bounded low-movement
N to N+1 expansion, invalid-input rejection, and absence of the opaque routing
key from serialized plans. Config verification must prove generation 1, eight
shards, runtime false, staging proof false, no tracked routing secret, and no
edge `[[containers]]` block in all three environments.

Capability readback must keep controller binding, Container runtime,
deny-by-default egress, shared-storage runtime contract, N/N-1 protocol,
capacity rejection, remote fault matrix, staging verification, and final
cutover false. Local PASS is not remote Container evidence. Production remains
**NO-GO**.

## 0038/0039 Recoverable Task Submit Verification Contract

This current-head overlay supersedes only older Task migration counts and
statements that local submit uniqueness/deadline/status recovery are absent. It
does not record remote or provider PASS evidence.

```powershell
python tools/verify_sqlite.py
# require: 39 migrations, 35 tables, 244 incremental columns, 45 key indexes

bun run check:task-poll-scheduler-config
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:web:readiness
bun run check:do-lifecycle-runtime
bun run check
```

SQLite verification must additionally prove:

1. 0038 immediately precedes 0039 and the expand phase accepts both old and new
   writer shapes;
2. client-operation uniqueness is scoped to user, exact token, and task kind;
3. provider-operation uniqueness is scoped to task kind, provider, channel,
   and frozen provider key;
4. both client digests require immutable lowercase SHA-256 after 0039;
5. submit deadline is immutable, inside 5..120 seconds, and no later than the
   intent lease;
6. historical zero-value rows remain unchanged while an old writer is rejected
   after enforcement;
7. the current deadline branch and legacy lease branch use their intended
   indexes.

Worker/Workerd verification must prove same-key same-request replay without a
second provider call, same-key changed-request conflict, 408/409/425/429 and
5xx ambiguity, bounded response-body failure, post-accept attachment failure,
stable 202 recovery, exact-token status ownership, 404 for another token,
no-store, and absence of provider/channel/contract/digest identity in the
public response. Capability assertions must keep provider-native idempotency,
provider lookup, operation cutover, and production cutover false.

Current local evidence on 2026-07-15:

```text
python tools/verify_sqlite.py
# PASS; 39 migrations, 35 tables, 244 incremental columns, 45 key indexes

cargo test -p cinatoken-worker --lib
# PASS; 711/711; six existing dead-code warnings

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; standalone Worker WASM target

bun run check:task-poll-scheduler-config
# PASS; 4/4 tests

bun run check:web:readiness
# PASS; 70/70 tests across 10 files

bun run check:do-lifecycle-runtime
# PASS; release builds of the main, WFP tenant, and WFP outbound Workers; 43/43 tests

bun run check
# PASS; full repository chain, including release builds, Workerd 43/43,
# Playground 1/1, frontend build/audits, D1 verification, workspace tests,
# and the main, WFP tenant, and WFP outbound wasm32 targets
```

The required-key flag remains false in tracked environments and provider proof
remains absent. Local PASS cannot promote these fields. Production remains
**NO-GO**.

## Ali Synchronous Image Actual-Count Settlement Verification (2026-07-15)

```powershell
cargo fmt --all --check
# PASS

cargo test -p cinatoken-providers --lib
# PASS; 95/95

cargo test -p cinatoken-relay --lib
# PASS; 89/89

cargo test -p cinatoken-worker --lib
# PASS; 689/689

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; three pre-existing dead_code warnings only

bun run check:web:readiness
# PASS; 52/52

bun run check
# PASS; release main/tenant/outbound Wasm builds, Workerd 41/41,
# Playground 1/1, frontend build and audits, billing/config/D1 checks,
# workspace tests, and main/tenant/outbound wasm32 checks
```

Verified behavior:

- Ali synchronous image generation and non-Wan image edit requests use the
  native DashScope multimodal endpoint and preserve the Go adapter's model,
  parameter, response-format, and request-count precedence.
- Multipart edits accept the Go-compatible `image`, `image[]`, and indexed
  image fields while preserving file order. They fail before quota reservation
  when the image set is absent, reaches file 17, exceeds 12 MiB, contains a part
  header over 8 KiB, or lacks a verified PNG, JPEG, GIF, or WebP byte signature.
- Provider responses are parsed within an 8 MiB bound. Actual count prefers a
  positive provider `usage.image_count`, then converted output count, then the
  normalized request count; zero provider usage cannot erase the fallback.
- Only a terminal clone of the legacy flat billing snapshot adjusts image
  count. The frozen reservation snapshot, digest, admission decision, and
  tiered-expression request input remain unchanged.
- `b64_json` mode never fetches provider-owned URLs from the Worker. Provider
  base64 output is accepted, while URL-only or partial conversion returns 502
  and refunds; it cannot create an outbound fetch, empty billed success, or
  SSRF path.
- Provider response metadata is reduced to bounded request, numeric usage, and
  terminal task/status fields; original image/base64 payloads are not duplicated.
- A bounded `ALI_SYNC_IMAGE_MODELS` replacement is applied consistently to
  candidate filtering, Admin Channel Test, and native generation/edit conversion.
- Audit records contain bounded request and count provenance only. Uploaded
  image bytes and channel credentials are never stored in the settlement audit.
- Platform readiness now names `ali_async_image_task_settlement` as the
  remaining Ali blocker; synchronous actual-count settlement is no longer
  represented as missing.

This closes local Ali synchronous image actual-count settlement. Ali async
submit/poll settlement, free-model runtime policy, staging usage and invoice
reconciliation, deployed Cloudflare evidence, credential rotation, rollback,
and G1-G8 approval remain blocking. Production remains **NO-GO**.

## Native Provider Usage Recovery Verification (2026-07-15)

Focused verification covers:

- Gemini JSON with `prompt=0`, candidates plus thoughts completion, and a
  provider total smaller than the normalized component sum.
- Gemini native response/SSE candidate text collection and empty-stream
  behavior.
- Anthropic `message_start` cache evidence followed by text and a missing
  `message_delta`/`message_stop`, plus explicit terminal-event detection.
- Provider-aware field supplementation that never replaces cache details or a
  positive Gemini provider total.
- Frontend rendering of the decomposed cache-scope, usage-provenance, and
  staging-reconciliation blocker IDs.

This is local evidence only. Live direct/AI Gateway/WFP reconciliation, Ali
actual image count, and the complete free-model runtime policy remain blocking.
Production remains **NO-GO**.

## Frozen Flat Billing Intent Verification (2026-07-14)

```powershell
cargo test -p cinatoken-billing
# PASS; 83 unit + 10 Go-expression parity tests

cargo test -p cinatoken-coordinator
# PASS; 15/15

cargo test -p cinatoken-worker --lib
# PASS; 669/669

python tools/verify_sqlite.py
# PASS; 29 migrations, 30 tables, 139 checked columns, 27 indexes,
# including the 0029 empty-flat-snapshot insert/update guards

bunx vitest run --config vitest.do.config.mjs `
  -t "blocks an uninspectable flat-billed response|reserves usage-less fixed-price audio|rejects an in-flight relay billing idempotency replay"
# PASS; 3 selected Workerd scenarios
```

Verified behavior:

- Per-token flat body-inspection failure creates one frozen reservation, blocks
  delivery, refunds user/token quota, leaves channel usage and request count at
  zero, and records a terminal Queue audit.
- Fixed-price audio reserves before response delivery and then settles one
  exact frozen amount through Queue/D1, with one terminal request accounting
  mutation.
- Two in-flight requests with the same caller request identity create one D1
  reservation and one provider call; the replay receives 409 while the original
  request can still settle.
- Snapshot bytes and `flat-v2` digest are durable and cross-validated; mutable
  pricing options are not reread for terminal computation.

This proves local intent durability, not Go pricing cutover parity. Decimal
terminal arithmetic, unset-ratio/self-use admission, complete image/audio/tool
and provider-specific multipliers, remote 0029/Queue readback, client abort and
idle fault classes, invoice reconciliation, credential rotation, and G1-G8
approval remain open. The capability parity gate is hard false and production
remains **NO-GO**.

## Flat Pricing Admission And Contract Immutability Verification (2026-07-14)

```powershell
cargo test -p cinatoken-billing -p cinatoken-storage -p cinatoken-relay
# PASS; billing 87 unit + 10 Go-expression parity, storage 7/7, relay 75/75

cargo test -p cinatoken-worker --lib
# PASS; 671/671

python tools/verify_sqlite.py
# PASS; 30 migrations, 30 tables, 139 checked columns, 27 indexes;
# 0030 financial-contract mutation probes rejected

bun run check:d1:migration-config
# PASS; exact 30-file set, latest 0030_billing_contract_immutability.sql

bun run check:do-lifecycle-runtime
# PASS; release main/tenant/outbound Rust/Wasm builds and Workerd 38/38

bun run check
# PASS; complete release gate, frontend production build/readiness/bundle audits,
# 223 frontend calls / 326 Worker routes / zero missing, workspace tests, and
# main/tenant/outbound wasm32 checks
```

Verified behavior:

- Exact decimal intermediates and half-away-from-zero final rounding match the
  audited Go boundary, including `61.5 -> 62`.
- An existing empty pricing option replaces the seeded defaults; a missing row
  uses defaults and explicit zero remains configured.
- Strict unknown-model admission returns 400 before provider egress with no
  reservation, quota, or audit mutation. Site self-use and per-user unset-model
  policy admit the same request, expose the model through `/v1/models`, freeze
  ratio 37.5, and settle once. Tiered-expression-only models remain visible.
- D1 rejects post-insert mutation of the frozen reservation identity and
  financial contract in both the SQLite verifier and the Workerd runtime.

This is local E3 evidence only. Per-token audio, fixed-image size/quality and
actual-count, Ali `prompt_extend`, actual tool-call surcharges, full provider
`OtherRatios`, usage-source semantics, and a Go-generated immutable flat
manifest remain open. Remote 0030/Queue/DLQ/provider-invoice and direct/Gateway/
WFP fault evidence, credential rotation, rollback, and G1-G8 approval are also
absent. `relay_flat_billing_go_parity_ready` remains hard false and production
remains **NO-GO**.

## Frozen Flat Tool Surcharge V3 Verification (2026-07-14)

```powershell
cargo test -p cinatoken-billing -p cinatoken-relay --lib
# PASS; billing 95/95, relay 80/80

cargo test -p cinatoken-worker --lib
# PASS; 673/673

bun run check
# PASS; complete release gate: Workerd 38/38, frontend readiness 52/52,
# 223 frontend calls / 326 Worker routes / zero missing, D1 30 migrations /
# 30 tables / 139 incremental columns / 27 key indexes, workspace tests, and
# main/tenant/outbound wasm32 checks
```

Verified behavior:

- `tool_price_setting.prices` resolves Go defaults plus longest operator model
  prefixes and is serialized into schema-v3 flat snapshots before egress.
- Responses JSON/SSE web, file, and image facts are bounded; duplicate SSE item
  IDs do not double charge. Claude cumulative web-search usage settles once.
- Search/file per-1K and image per-call quota is added to per-token or fixed
  base quota before `OtherRatios`; final decimal rounding occurs once.
- Audit output exposes call counts, frozen unit prices, selected image price
  class, and surcharge quota without storing provider credentials.
- Top-level cached-token, OpenAI-only llama.cpp timing, and Gemini streamed-image
  fallback vectors match the audited Go behavior.

This is local E3 evidence. OpenRouter cache-write inference, TTS/audio detail,
Gemini Imagen, image-edit/Ali actual count, a Go-generated flat manifest,
remote Queue/D1/DLQ/provider reconciliation, abort/idle faults, credential
rotation, rollback, and G1-G8 approval remain blocking. Tiered tool surcharge
parity was outside this increment. Production remains **NO-GO**.

## WFP Artifact And Gateway Credential Verification (2026-07-15)

```powershell
cargo test -p cinatoken-worker --lib
# PASS; 676/676

bun tools/deploy_wfp_tenant_artifact.mjs --self-test-artifact-manifest `
  --script-name selftest --namespace selftest --json
# PASS; 5/5 strict Rust/Wasm artifact cases

bun tools/deploy_wfp_tenant_artifact.mjs --self-test-deploy-plan `
  --script-name selftest --namespace selftest --json
# PASS; 3/3 tenant binding and observability policy cases

bun tools/collect_wfp_post_upload_readback.mjs --self-test
# PASS; schema v3, 19/19

bun tools/verify_wfp_post_upload.mjs --self-test --json
# PASS; schema v3, 28/28

bun run check
# PASS; complete release gate, Workerd 38/38, frontend readiness 52/52,
# 223 frontend calls / 326 Worker routes / zero missing, D1 30 migrations /
# 30 tables / 139 checked columns / 27 indexes, workspace tests, and
# main/tenant/outbound wasm32 checks
```

Verified behavior:

- The upload manifest starts at the actual `worker-build` `index.js`, contains
  a referenced Wasm binary, and rejects incomplete or fabricated artifacts.
- Upload intent and both Cloudflare readback surfaces must report enabled,
  nonzero, exactly matching observability. Schema-v2 or drifted evidence cannot
  pass the verifier.
- Tenant metadata cannot contain AI Gateway identity/policy, Cloudflare bearer
  tokens, or WFP authority secrets. The main relay requires the dedicated
  `CLOUDFLARE_AI_GATEWAY_TOKEN`; generic account-management credentials cannot
  make readiness true.
- The audited source formula includes
  `audio_output * audio_ratio * audio_completion_ratio`; documentation now
  reflects that contract without claiming runtime TTS parity.

This is local E3 evidence only. No live upload or authenticated Settings/Content
readback was executed. TTS binary duration and audio-detail settlement,
OpenRouter cost-based cache-write provenance, deployed Queue/D1/DLQ and provider
reconciliation, fault/load/alert evidence, credential rotation, rollback, and
G1-G8 approval remain blocking. Production remains **NO-GO**.

## Flat Audio And OpenRouter V4 Verification (2026-07-15)

```powershell
cargo test -p cinatoken-core audio_duration
# PASS; 16/16 selected duration tests

cargo test -p cinatoken-billing
# PASS; 101 unit tests plus 10 Go-expression parity fixtures

cargo test -p cinatoken-relay --lib
# PASS; 83/83

cargo test -p cinatoken-worker --lib
# PASS; 679/679

bunx vitest run --config vitest.do.config.mjs `
  -t "audio|PCM speech|oversized speech|OpenRouter Anthropic cache write"
# PASS; 4 selected, 37 skipped

cd apps/web/source/default
bun test src/stores/auth-store.test.mjs
# PASS; 6/6, 18 assertions

bun run build:check
# PASS; TypeScript and production Rsbuild

cd ../../../..
bun run check
# PASS; full release gate, Workerd 41/41, frontend readiness 52/52,
# route parity 223/326 with zero missing, D1 verification, workspace tests,
# and main/tenant/outbound wasm32 checks

bun run check:web:quality
# BASELINE FAIL; ESLint passes, but repository-wide Prettier still reports
# three pre-existing system-settings files outside this increment. The four
# changed auth files pass targeted ESLint and Prettier checks.
```

Verified behavior:

- A bounded 48-byte PCM response derives 17 output-audio tokens and settles
  once with frozen `AudioRatio` and `AudioCompletionRatio`. Unsupported MP3
  bytes use the Go decimal-byte fallback. A response beyond the configured
  bound returns 502 and refunds user, token, channel, and request accounting.
- Flat v4 snapshots are domain-separated as `flat-v4:<sha256>` and freeze the
  new audio and OpenRouter eligibility facts, including whether Go would route
  that model through audio-detail billing. Audio details on an unconfigured
  model retain the ordinary text completion formula.
- OpenRouter numeric cost and explicit semantic provenance survive JSON and
  SSE parsing. Type 20 Anthropic projection reproduces the Go
  `2604/2432/383 -> 798` vector; an eligible cost reconstructs 100 cache-write
  tokens, settles 823 quota in Workerd, and records raw/effective prompt,
  candidate, source, version, and reason.
- Explicit aggregate cache-write, fixed price, custom model ratio, missing
  cost, unit creation ratio, and invalid/out-of-range candidates disable
  inference. Tiered expressions retain original provider usage.
- Frontend requests capture their auth generation, GET deduplication is scoped
  to that generation, and verification generations prevent logout/401/relogin
  and stale request races from reusing data, clearing, or redirecting a newer
  session.

This is local E3 evidence. Full deployed browser journeys, provider
actual-count/image-edit parity, remote Queue/D1/DLQ and provider invoice
reconciliation, fault/load/alert evidence, credential rotation, rollback, and
G1-G8 approval remain blocking. Production remains **NO-GO**.

## Immutable Go Flat Billing Manifest Verification (2026-07-15)

```powershell
bun tools/generate_go_flat_billing_manifest.mjs `
  --source C:\cinagroup\cinatoken `
  --go-proxy "https://goproxy.cn,direct" `
  --json
# PASS; source commit 73652508abc5, 10 terminal cases, 8 admission cases,
# manifest SHA-256 76784eba4dc518ac7eb491542d6451196fef44e1610403c08c666377d79f6a60

bun run check:billing-flat-manifest
# PASS; canonical payload digest and both required case families verified

cargo test -p cinatoken-billing --test flat_go_manifest
# PASS; 3/3 (identity/uniqueness, terminal formula, admission/pre-consume)

bun run check:web:readiness
# PASS; 52/52
```

Verified behavior:

- Generation executes the real Go source package functions rather than a copied
  Rust or JavaScript formula. Source commit, eight billing source files, the
  generator script, and both injected test templates are hash-bound to the
  artifact.
- Temporary Go test files are collision-checked and removed on success or
  failure. Post-generation source status contains only the pre-existing
  `controller/nul` entry.
- Rust matches all Go terminal quotas and admission/pre-consume decisions over
  token/fixed, media/cache/audio/tool, DALL-E multiplier, unknown-model,
  free-model, and group-ratio cases.
- The ordinary artifact check is offline and deterministic; the optional
  source regeneration path may use an explicitly selected Go proxy, while Go
  module integrity remains verified by the configured checksum database.

This is local E3 evidence. It closes only the immutable Go flat-manifest item.
Provider actual-count/image-edit parity, free-model runtime policy, deployed
browser journeys, remote Queue/D1/DLQ/provider reconciliation, credential
rotation, rollback, and G1-G8 approval remain blocking. Production remains
**NO-GO**.

## Multipart Image Edit Flat Settlement Verification (2026-07-15)

```powershell
cargo fmt --all -- --check
# PASS

cargo test -p cinatoken-worker --lib
# PASS; 681/681

bun run check:web:readiness
# PASS; 52/52

cargo test -p cinatoken-providers zhipu
# PASS

bun run check
# PASS; frontend build/audits, route and Cloudflare contracts, workspace tests,
# and main/tenant/outbound wasm32 checks
```

Verified behavior:

- Multipart image edits keep the upload bytes untouched while a bounded,
  pricing-only projection captures `model`, positive integer `n`, `size`, and
  `quality` for the existing flat-v4 snapshot.
- The tiered-expression `RequestInput` remains model-only for multipart, so
  this change does not grant `param("n")` visibility that Go does not have.
- DALL-E edit size/quality uses the same source ratios as generation, and
  fixed-price edit count uses request `n`. A successful edit with no provider
  token usage receives the Go-compatible one-token request contract instead
  of refunding its reservation.
- Image response array length does not replace request `n` for ordinary
  OpenAI-compatible providers. Source audit confirms that response-count
  replacement belongs only to Ali/Bailian and ignores zero, falling back to
  the request count.
- Zhipu v4 preserves request `n` in the outbound image payload, matching the
  Go type-26 pass-through adapter and the frozen request-count billing fact.
- The flat snapshot remains schema v4 and the contract prefix remains
  `flat-v4:`; no in-flight reservation migration or replay-format change was
  introduced.
- Platform capabilities publish stable blockers for Ali actual count,
  free-model runtime policy, and provider usage-source parity. The frontend
  renders those blockers by name and refuses a contradictory `ready=true`
  response while the blocker list is non-empty.

This closes local OpenAI-compatible multipart image-edit flat settlement, not
the provider family as a whole. Ali native asynchronous submit/poll,
actual-count replacement, remote failure/refund reconciliation, provider
invoice comparison, and SiliconFlow/xAI edit semantics remain blocking.
Production remains **NO-GO**.

## Generation-Fenced Task Polling Verification Plan (2026-07-15)

This is a current-head verification plan, not historical PASS evidence. Do not
change earlier command output or migration counts when executing it.

### Local gates

```powershell
python tools/verify_sqlite.py
cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:web:readiness
bun run check:task-runner:alarm-replay-contract
bun run check:task-runner:alarm-replay-plan
bun run check:do-lifecycle-runtime
bun run check
```

The SQLite proof must verify 0034/0035 apply in order, both control defaults are
zero, one claimant wins, a loser cannot poll/apply, expiry permits a higher
generation, the old generation cannot apply, applied generation cannot exceed
claim generation, write revisions advance exactly once, old lifecycle writes
fail only after enforcement, and disabling enforcement restores
0033-compatible rollback behavior.

### Remote D1 and capability proof

Archive redacted output for the exact migration ledger and object-level probes.
Required capability transitions are:

| Checkpoint | schema | env enabled | D1 authority | enforcement | runtime | staging | cutover |
| --- | --- | --- | --- | --- | --- | --- | --- |
| After migration | true | false | false | false | false | false | false |
| After DB authority | true | false | true | false | false | false | false |
| After DB enforcement | true | false | true | true | false | false | false |
| Cron canary | true | true | true | true | true | false | false |
| Reviewed staging candidate | true | true | true | true | true | true | true |

Also record `task_poller_poll_lease_seconds`, TaskRunner
`schedule_generation`, and applied `poll_generation`. A capability response is
not evidence that provider, D1, billing, or alarms behaved correctly.

### Required race and failure cases

1. Two scheduled invocations select the same video row. Exactly one claim and
   provider poll may start for that generation.
2. Cron and TaskRunner race the same video row. One wins; the loser reports
   lease busy and preserves cron fallback.
3. Provider poll races Task timeout. Timeout must claim; only one terminal D1
   and financial transition may win.
4. Midjourney batch poll races its one-hour timeout. Both require a lease and
   exactly one terminal/refund batch wins.
5. Let generation N expire, claim N+1, then return N. N must be rejected even
   if its provider result is terminal.
6. Inject an ambiguous D1 response after claim commit. Canonical readback must
   recover ownership without creating generation N+1.
7. Time out provider fetch, fail abort, and fail lease release. No result may
   apply after expiry; later takeover must succeed.
8. Return partial Suno/Midjourney batches and malformed/duplicate/unrequested
   items. Missing items release or expire safely and cannot cross-apply.
9. Replace a TaskRunner schedule while an alarm polls. The stale
   `schedule_generation` must not overwrite or rearm the replacement record.
10. Re-run identical terminal responses, alarms, and cron windows. Billing,
    request counts, refund, settlement, and audit remain exactly once.

Run each case for video, Suno, and Midjourney where applicable. Confirm Suno
submission never arms the video TaskRunner. Measure provider auth,
request-build, D1 claim-loop, fetch/body, parse, and apply time against the
lease. Vertex auth plus fetch share one deadline; prove that deadline and abort
behavior remotely before promotion.

### Acceptance and blockers

Do not set `TASK_POLL_LEASE_STAGING_VERIFIED=true` in the same candidate used
to collect evidence. Review first, then ship a new immutable candidate.
Migration 0036 now supplies local persisted scheduler schema, but runtime and
remote proof, provider-operation uniqueness/idempotency lookup,
whole-operation deadline proof, provider invoice reconciliation, load/alert
evidence, credential rotation, and rollback remain required. Task v2 and
production stay **NO-GO**.

## 0036 Scheduler Verification Contract

Static verification must include:

```text
bun run check:task-poll-lease-config
bun run check:task-poll-scheduler-config
bun run check:d1:migration-config
bun run verify:sqlite
bun run check
```

The configuration test must parse all three Wrangler var maps and require the
five committed scheduler defaults. The total `check` script must run lease
config validation before scheduler config validation. Passing these commands
does not assert remote migration or deployment.

Schema verification must prove 0034 -> 0035 -> 0036 order, seven schedule
columns on each table with inert defaults/checks, two filtered due indexes,
and exactly five zeroed cursor rows. It must prove pre-migration business hashes
and counts are unchanged and that the 0034/0035 authority/enforcement controls
remain off during schema-only validation.

Staging verification must then prove:

1. no scheduler provider I/O when scheduler, lease env, D1 authority, or D1
   enforcement is false;
2. no candidate before D1 `next_poll_at`; finite frozen high-watermark rounds;
   claim-only cursor advance; and video/Suno/Midjourney minute-slot rotation with
   an eight-row family cap while both timeout sweeps remain independent;
3. deterministic identity/generation jitter within 15-18, 30-33, 60-63,
   120-123, 240-243, 480-483, and 900 seconds for failures one through seven
   across restart; failure eight quarantines without another due time;
   validated-response reset does not reset lifetime attempts;
4. threshold quarantine on failure eight, no later poll, no automatic release,
   and no quota/billing/audit terminal side effect; unsupported provider,
   invalid provider task identity, and deterministically invalid credential
   must quarantine immediately, while network/upstream/missing-item failures
   retain threshold backoff; the 0037 audited release/requeue workflow must pass
   its negative/positive matrix;
5. one provider operation/apply during cron/DO and poll/timeout races, stale
   generation rejection, canonical readback after ambiguous D1 writes, and cron
   correctness while the DO accelerator is unavailable;
6. scheduler-only rollback with 0036 retained, plus full lease rollback in the
   documented order and quarantine reconciliation before Go/VPS resumes.

Archive candidate/config/migration hashes, redacted D1 transitions, provider
operation counts, invoice/quota/audit deltas, timings, alerts, and named review.
Keep `TASK_POLL_SCHEDULER_STAGING_VERIFIED=false` during collection. A later
candidate may change it only after independent approval. No such evidence is
claimed by this document; production remains **NO-GO**.

The local focused suite currently proves 709 Worker unit tests, 42 Workerd
lifecycle tests, all three release WASM builds, and the executable 0036 SQLite
expand/default/CAS checks. These results are necessary but are not remote or
staging evidence.

## 0037 Audited Task Poll Recovery Verification Contract

This is a required verification contract until a dated command block below
records a clean candidate run. It must not be read as remote or staging PASS
evidence.

```powershell
python tools/verify_sqlite.py
# PASS: 37 migrations, 35 tables, 241 incremental columns, 42 key indexes

bun run check:task-poll-scheduler-config
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:do-lifecycle-runtime
bun run check
```

Current local evidence on 2026-07-15:

```text
python tools/verify_sqlite.py
# PASS; 37 migrations, 35 tables, 241 incremental columns, 42 key indexes

bun run check:task-poll-scheduler-config
# PASS; 4/4 tests and 28 assertions

cargo test -p cinatoken-worker --lib
# PASS; 709/709; six existing dead-code warnings

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; cinatoken-worker standalone WASM target check

bun run check:do-lifecycle-runtime
# PASS; release main/tenant/outbound Rust/Wasm builds and 42/42 Workerd tests

bun run check:web:readiness
# PASS; 70/70 tests across 10 files

bun run check:web
# PASS; TypeScript project build and production frontend bundle

bun run check:web:bundle
# PASS; 459 built files and 37,433,576 bytes scanned with zero findings

bunx prettier --check <changed system-settings files>
# PASS; all changed recovery/readiness frontend files use Prettier style
```

The full `bun run check` is not newly claimed by this evidence block. Full
`bun run check:web:quality` reached and passed ESLint, then reported four
pre-existing Prettier findings in unrelated Realtime/Task-submit files; the
changed recovery/readiness files pass the targeted Prettier check. These are
local results only. Production remains **NO-GO**.

SQLite verification must prove:

1. 0034 -> 0035 -> 0036 -> 0037 order and inert recovery defaults;
2. immutable update/delete guards and atomic event-triggered requeue;
3. lowercase-hex checks for resolution, evidence, preview, and decision fields;
4. one recovery per `(entity_kind, entity_id,
   expected_poll_write_revision)`;
5. exact partial Task/Midjourney quarantine-index predicates;
6. generation, write revision, quarantine timestamp/reason, provider identity,
   empty owner/lease, nonterminal, and hard-timeout trigger guards;
7. no business-row mutation from schema application and no financial mutation
   from quarantine/recovery itself.

Workerd must cover root authorization, fresh step-up, applied recovery,
identical duplicate convergence, conflicting idempotency, stale preview,
immutable audit, timeout-margin rejection, 409 stale/conflict responses, 503
D1/audit/readback responses, and first-Task best-effort rearm with cron fallback.
Queue and preview assertions must include `hard_timeout_at`,
`timeout_eligible`, and a margin at least 60 seconds and at least the poll lease.
They must expose `task_reference` plus a 64-character SHA-256 and never the
original Midjourney provider ID.

Capability verification must keep
`TASK_POLL_RECOVERY_ENABLED=false` and
`TASK_POLL_RECOVERY_STAGING_VERIFIED=false` in committed default, staging, and
production config. Scheduler cutover must remain false unless recovery cutover
is true. Local compiled/schema/runtime booleans are not evidence that D1,
provider, alarms, or billing behaved correctly.

Rollback verification disables recovery, then scheduler and TaskRunner, then
lease env authority, D1 authority, and D1 enforcement. It drains leases,
reconciles accepted provider work, and proves every quarantine is resolved,
held, or excluded before Go/VPS resumes.

Provider-operation uniqueness/native idempotency, whole-submit deadlines,
remote D1/staging/provider/TaskRunner hot paths, WFP namespace upload/readback,
paid WFP canary, invoice/load/alert evidence, credential rotation, and signed
rollback remain hard blockers. Production remains **NO-GO**.

## cinaVibeSDK Architecture Source Audit (2026-07-15)

The local source review established the following evidence boundaries:

- `worker/services/deployer/deploy.ts` sends dispatch deployments through the
  namespace path, while `worker/index.ts` serves preview traffic through
  `DISPATCHER.get(appName).fetch(request)`. This is internal binding traffic,
  not a public loop.
- `worker/agents/core/websocket.ts` starts generation from an unawaited Promise
  and persists `shouldBeGenerating`; `codingAgent.ts` can restore Agent state,
  but those facts do not prove automatic in-flight work recovery.
- `worker/agents/think/ThinkAgent.ts` keeps `thoughtSignatures` in an in-memory
  map. `worker/agents/core/state.ts` also permits an encrypted OAuth blob in
  Agent state that `codingAgent.ts` returns on connect. cinatoken-rust must not
  copy either pattern for correctness or client-returnable secrets.
- `worker/agents/inferutils/infer.ts` owns exponential retries and fallback
  switching in one application loop. cinatoken-rust must likewise designate
  one retry owner and add model permission, refund/re-reserve, and audit checks
  before any cross-model fallback.

The review is consistent with Cloudflare's Workers best practices, Durable
Object best practices and alarm semantics, and D1 transactional batch
behavior. It supports the D1/cron correctness spine, DO-as-accelerator, internal
dispatch Worker, and outbound credential-owner architecture. It does not prove
remote WFP upload/readback, paid egress, or TaskRunner recovery. Production
remains **NO-GO**.

## Container Controller And Native Runtime Verification (2026-07-16)

Required local commands:

```powershell
bun run check:container-controller
cargo test -p cinatoken-container-authority
cargo test -p cinatoken-container-runtime
cargo test -p cinatoken-worker --lib container_scheduler
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check
```

Current focused evidence:

```text
node_modules\.bin\tsc.exe -p services/container-controller/tsconfig.json --noEmit
# PASS: strict TypeScript

node_modules\.bin\vitest.exe run --config vitest.container-controller.config.mjs
# PASS: 10/10 Workerd/SQLite ledger scenarios

node_modules\.bin\wrangler.exe deploy --config services/container-controller/wrangler.jsonc --dry-run --containers-rollout none
# PASS: dry-run bundle with only the default-off Controller bindings and image

cargo test -p cinatoken-container-authority
# PASS: bounded authority, tamper/binding/time/key negatives, and shared golden
# vector

cargo test -p cinatoken-container-runtime
# PASS: 12 validation and HTTP endpoint tests on the stable host toolchain

cargo test -p cinatoken-worker --lib container_scheduler
# PASS: 4/4 focused scheduler and local Controller contract tests

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS: standalone Worker wasm32 target check
```

The dry-run reports only the `RELAY_SHARDS` DO, explicit default-off vars, and
the Container Dockerfile. `--containers-rollout none` means it does not build
or start an image. This host has no Docker engine. Rust 1.78 runtime verification
is also pending because the pre-existing local GNU toolchain was incomplete and
its repair download stalled; the Dockerfile remains pinned to the declared
workspace MSRV builder.

The Controller gate now runs ten Workerd/SQLite scenarios against the same
`RelayShardLedger` module used by production. They prove max+1 serialization,
operation/dispatch conflict behavior, expired in-flight 504 recovery, retry
after capacity release, terminal CAS against late completion, time/count
compaction, refreshed-dispatch protection, legacy rejection migration,
replay-window backpressure, and state persistence across DO eviction. The
fixture deliberately does not instantiate `RelayShardContainer`,
because the local Containers runtime requires Docker; protocol-to-container
dispatch and lifecycle callbacks remain unverified runtime behavior.

Do not promote C1/C2 from local evidence. Docker/Linux build, isolated
deployment, secret readback, actual Container lifecycle/OOM, egress,
R2 replay/KV lag/D1 ambiguity, sustained retention/load, N/N-1,
image supply chain, load/cost, and rollback evidence remain mandatory.
Production remains **NO-GO**.

## Private Edge-to-Controller Contract Verification (2026-07-16)

The private status-contract increment was verified with the tracked probe and
all runtime switches disabled:

```text
cargo test -p cinatoken-container-authority -p cinatoken-container-runtime \
  -p cinatoken-gateway -p cinatoken-worker
# PASS: authority 12/12; runtime unit 6/6 and HTTP 7/7; gateway 5/5;
# worker 717/717

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS: standalone Worker wasm32 target check

node_modules\.bin\tsc.exe \
  -p services/container-controller/tsconfig.json --noEmit
# PASS: strict TypeScript

node_modules\.bin\vitest.exe run \
  --config vitest.container-controller-protocol.config.mjs
# PASS: 8/8 portable authority/status/deadline/keyring contract tests

node_modules\.bin\vitest.exe run \
  --config vitest.container-controller.config.mjs
# PASS: 10/10 Workerd/SQLite ledger scenarios

node_modules\.bin\wrangler.exe types \
  services/container-controller/worker-configuration.d.ts \
  --config services/container-controller/wrangler.jsonc \
  --env-interface ContainerControllerEnv --check
# PASS: generated Controller Env types are current

node_modules\.bin\wrangler.exe deploy \
  --config services/container-controller/wrangler.jsonc --dry-run \
  --containers-rollout none --outdir .wrangler/container-controller-build
# PASS: Controller bundle, DO binding, default-off vars, and Container manifest
```

Wrangler type generation also parsed the root local, staging, and production
configuration after the custom build hook was temporarily omitted for this
parse-only check and then restored. The generated ignored declarations showed
the exact `CONTAINER_CONTROLLER` Fetcher targets, protocol and authority
metadata, and `CONTAINER_CONTROLLER_PROBE_ENABLED="false"` in every scope.

This Windows host currently has no Bun executable on `PATH`, so the changed
Bun-only TOML configuration test and the full `bun run check` aggregate were
not rerun in this increment. The portable protocol suite, strict TypeScript,
Wrangler parses/dry-run, Rust host tests, and wasm32 check all passed. Wrangler
also emitted an `EPERM` warning while attempting to write its optional user-log
file, but every successful command above exited zero and produced its expected
artifact or readback.

These are local contract results only. No Cloudflare credential was used, no
secret was provisioned, and no Worker, DO, image, or Container was deployed.
Authenticated remote status readback, a targeted shard readiness probe, actual
Container lifecycle, N/N-1, provider/billing integration, fault/load/cost,
canary, rollback, and C1-C5 approval remain required. Production remains
**NO-GO**.

## Targeted Container Readiness Verification (2026-07-16)

Required local commands:

```powershell
node node_modules/typescript/bin/tsc -p services/container-controller/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config vitest.container-controller-protocol.config.mjs
node node_modules/vitest/vitest.mjs run --config vitest.container-controller.config.mjs
cargo test -p cinatoken-container-runtime --test http
cargo test -p cinatoken-worker --lib container_controller
cargo test -p cinatoken-worker --lib container_scheduler
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
```

The protocol suite must prove signed ledger/live bodies, tamper rejection,
unknown-field rejection, stale fence, and 4 KiB bounds. The Workerd suite must
prove ledger-only inspection leaves the shard uninitialized, active and
expired counts are distinct, live probe generation is serialized, dispatch is
single-use, cooldown is enforced, stale completion loses CAS, draining rejects
new claims, and a new ring advances only after old in-flight work drains.

Rust response tests must reject a ledger response that claims health and a live
response that equates healthy process state with disabled execution. Runtime
HTTP tests must assert the exact `/readyz` protocol and
`execution_enabled=false`. Config tests and generated Controller types must
show all readiness gates false.

Remote acceptance remains separate: shallow status, non-waking ledger, one
explicit cold probe, warm probe, malformed/timeout/rate-limit, concurrency,
replay, draining, sleep/restart/OOM, N/N-1, image provenance, load/cost, and
rollback evidence must be archived without secrets. Local PASS cannot promote
the staging marker or production gate.

## Container Shared Storage Gateway Verification (2026-07-16)

Run the local contract gates with all storage flags false:

```powershell
node node_modules/typescript/bin/tsc -p services/container-controller/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config vitest.container-controller-protocol.config.mjs
node node_modules/vitest/vitest.mjs run --config vitest.container-controller.config.mjs
cargo test -p cinatoken-worker --lib container_scheduler
node node_modules/wrangler/bin/wrangler.js types services/container-controller/worker-configuration.d.ts --config services/container-controller/wrangler.jsonc --env-interface ContainerControllerEnv --check
node node_modules/wrangler/bin/wrangler.js deploy --config services/container-controller/wrangler.jsonc --dry-run --containers-rollout none
```

Current local evidence is TypeScript PASS, 32/32 portable protocol tests,
15/15 Workerd/SQLite scenarios, 720/720 Worker library tests, 12 authority
tests, 9 runtime library tests, 7 runtime HTTP tests, 6 sharding tests, wasm
check PASS, formatting PASS, generated types current, and Wrangler dry-run
PASS with every storage gate false. Bun is not installed in this environment,
so the equivalent checked-in TypeScript, Vitest, and Workerd entry points were
used. Wrangler also reports a non-fatal EPERM while attempting to write its
optional user-profile log; both the type check and dry run exit successfully.

The portable protocol suite must cover default deny, exact route/method/host,
R2 input version/digest/size/type, result size/type/checksum/create-only key,
exact replay, conflicting result, bounded KV, and D1 owner fencing. The
Workerd suite must prove running-only grants, wrong-generation denial, result
CAS/idempotency/conflict, DO eviction persistence, and terminal-state denial.
Generated types and dry-run binding output must contain `DB`, `CONFIG_KV`,
`FILE_BUCKET`, and all four false action gates.

Remote acceptance is separate: exercise the same cases from a real Container,
include cold/warm/sleep/restart/OOM and N/N-1, and archive exact deployment,
image, binding, R2 version, operation, and rollback identities without secrets.
Exercise simultaneous different-result uploads and prove bounded orphan-object
inventory/cleanup before enabling R2 writes. For D1, prove that `operation_id`
is the exact billing reservation key and that generation changes deny stale
Container reads.
No local test or dry run may change an action flag or production verdict.

## Durable Operation Recovery Verification (2026-07-16)

Current focused evidence:

- TypeScript Controller check: PASS.
- Portable protocol/outcome/storage suite: 32/32.
- Workerd/SQLite ledger suite: 15/15.
- Native Container runtime unit suite: 9/9.
- Native Container runtime HTTP suite: 7/7.

The outcome suite rejects legacy accepted responses, unknown fields, explicit
nulls, contradictory status/code/result combinations, incomplete durable
result columns, result-free relay completion, terminal/expired D1 admission,
and stale owner generation. Workerd proves that running expiry becomes
recovery_required, claimed expiry remains definite, result attachment survives
eviction, and relay completion fails before attachment.

The finalized local gate also passed the full 720/720 Worker library suite,
wasm32 check, formatting check, generated Controller type check, and Wrangler
4.110.0 dry run. Wrangler's optional user-profile log write reported a
non-fatal EPERM, while both Wrangler commands exited successfully and exposed
every execution/storage gate as false. Docker and Bun are not installed, so a
real Container, multi-Worker local E2E, and the Bun aggregate remain
unverified. Local PASS cannot change any tracked gate or production verdict.

## Global Container Lifecycle CAS Verification (2026-07-16)

Current local evidence:

```powershell
python tools/verify_sqlite.py
# PASS: 41 migrations, 36 tables, 277 incremental columns, 48 key indexes

node tools/audit_d1_migration_config.mjs --json
# PASS: 41 contiguous migrations; runtime/config head is 0041

node node_modules/typescript/bin/tsc -p services/container-controller/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config vitest.container-controller-protocol.config.mjs
# PASS: 39/39
node node_modules/vitest/vitest.mjs run --config vitest.container-controller.config.mjs
# PASS: 17/17 Workerd/SQLite

cargo test -p cinatoken-worker --lib
# PASS: 739/739; focused Container contract 28/28
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
# PASS

node node_modules/wrangler/bin/wrangler.js deploy \
  --config services/container-controller/wrangler.jsonc --dry-run \
  --containers-rollout none --outdir .wrangler/container-controller-build
# PASS: private DO/D1/KV/R2/Container bindings; every action gate false
```

The 0040/0041 verifier executes null-primary-key, nullable-terminal,
text-as-integer, operation/reservation mismatch, provider-ID collision,
identity rewrite, timestamp rollback, missing-result completion, terminal
reactivation, dispatched/recovery same-state rewrites, completed/failed updates,
and valid dispatched/completed/recovery-resolution transitions. It also proves
that append-only 0041 changes no columns or rows and synthesizes no operation.
The Rust tests cover guarded dispatch and terminal evidence CAS, distinct
`AlreadyDispatched`/`MatchingTerminal` outcomes, owner-lease expiry, canonical
readback, bounded recovery candidates, schema readiness, content-addressed R2
manifests, HMAC shard routing, strict private outcomes, and capacity/fence error
classification.

The Controller portable suite proves admission before ledger claim, rejects
every immutable 0040/envelope mismatch, and verifies the separately signed
operation-status contract. Workerd proves owner/shard/trace mismatch denial,
deadline-independent terminal lookup, read-only replay, and no Container
execution from status queries. The Rust private client accepts an attached
result only for `running`, never `claimed`, and verifies the same deterministic
manifest. Wrangler 4.110.0 dry-run exited zero after its log/output paths were
redirected into the writable workspace; all Controller action gates and all
five edge operation/canary/reconciliation gates remain false.

This is default-off local evidence. No remote D1 migration, R2 write,
Controller deployment, Container execution, provider call, billing settlement,
or traffic cutover occurred. The operation-side terminal writer is evidence
only: operation terminal state, billing terminal state, quota/request/channel
mutations, and immutable audit/outbox are not yet one D1 batch. Exact client
response replay, the Linux canary, remote fault/lifecycle evidence, N/N-1,
supply-chain, load/cost, rollback, and approval gates remain open. Production
remains **NO-GO**.

## Container Financial Terminal Expand Verification (2026-07-16)

This current-head overlay supersedes the preceding statement that the D1
financial terminal batch is absent. Current local evidence:

```powershell
C:\Users\cina\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe tools\verify_sqlite.py
# PASS: 42 migrations, 38 tables, 323 incremental columns, 54 key indexes

node tools/audit_d1_migration_config.mjs --json
# PASS: 42 contiguous migrations; config/runtime head is 0042.

cargo test -p cinatoken-worker --lib container_
# PASS: settlement delta, tokenless refund, two-stage recovery,
# response-header allowlist, and idempotency conflict coverage.

cargo test -p cinatoken-worker --lib
# PASS: 744 passed; 0 failed.

node ../../../../node_modules/typescript/bin/tsc -b
# PASS from apps/web/source/default.

node --input-type=module -e "import { createServer } from 'vite'; const s = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' }); await s.ssrLoadModule('/apps/web/source/default/src/features/system-settings/integrations/cloudflare-platform-readiness.test.ts'); await s.close();"
# PASS: 37/37 Cloudflare platform readiness tests.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS: wasm32 Worker check; default-off Container code emits expected
# dead-code warnings until runtime wiring is enabled.

cargo fmt --all -- --check
# PASS.
```

The SQLite verifier preserves two legacy all-empty operation identities, then
rejects mixed/uppercase/duplicate v1 identity, mutable identity, malformed and
partial response manifests, wrong owner/from-status/billing/channel/group/
accounting, tokenless token deltas, duplicate transition identity, event
update/delete, invalid outbox initialization, lease takeover, shortcut
delivery, terminal rewrite, and deletion. It also persists an initial
`recovery_required` event with held pre-consume and a separate revision-2
recovery settlement.

Rust freezes accounting from the existing reservation, never recomputes a
billing expression, and sends event, outbox, operation CAS, billing CAS, and
all accounting statements through one D1 batch. Each mutation has an in-batch
zero-row abort and the result requires joined canonical readback. The exact
client idempotency lookup separates same-request replay from a different-request
conflict; receipt readback recomputes both outbox and nested terminal hashes.

This verification does not claim a D1/DO/R2 distributed transaction. The
create-only R2 client-response path, actual byte replay, divergence reconciler,
Linux canary, 0046 enforcement, remote migration/fault matrix, and staging proof
remain open. All eight Container operation/financial/replay/reconciliation/
canary/proof gates remain false, and production remains **NO-GO**.

## Exact Container Response and Divergence Foundation Verification (2026-07-16)

This current-head overlay supersedes only the preceding claim that the local R2
client-response path is absent. It does not claim edge wiring or a complete
reconciler. Current local evidence:

```powershell
cargo test -p cinatoken-worker --lib container_
# PASS: 37 passed; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 748 passed; 0 failed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; expected dead-code warnings remain while all Container paths are off.

cargo fmt --all -- --check
# PASS.

C:\Users\cina\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe tools\verify_sqlite.py
# PASS: 42 migrations, 38 tables, 323 incremental columns, 54 key indexes.
```

Focused tests cover the deterministic 4 MiB response key, safe canonical
header allowlist, forced no-store policy, duplicate/control-character rejection,
strong D1 receipt-to-manifest conversion, fail-closed D1/DO/R2 classification,
and exclusion of Container-owned reservations from the generic billing orphan
sweep. The source-contract test requires the 0040-aware exclusion at candidate,
recovery-mark, refund, and defer mutation boundaries.

The R2 implementation uses conditional create, exact HEAD readback, and a
bounded GET whose returned bytes are independently rehashed and recounted.
These calls are not exercised against a remote R2 bucket by Rust unit tests.
The full suite also confirms every tracked Container gate remains false. No
frontend file or platform-readiness predicate changed; Bun remains unavailable
in this environment, so the aggregate frontend check was not rerun.

Still required are edge integration, live Service Binding and R2 evidence,
concurrent conflict/orphan fault injection, fair reconciliation pagination,
durable backoff and metrics, operator authorization, exact DO phase mapping,
provider-attempt journaling, the Linux non-streaming chat canary, N/N-1,
old-writer drain, 0046 enforcement, rollback, and C1-C5 approval. No remote
migration, deploy, object write, provider call, or traffic switch occurred;
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-18 Provider Response Protocol P3 Verification

This packet is local source, native Rust, TypeScript, and Workerd evidence only.
It did not apply D1 migration 0052 remotely, create an R2 object, invoke a real
provider, mutate financial state, deploy a Worker or Container, change a
secret, or switch traffic.

Confirmed focused commands for this candidate include:

```powershell
cargo test -p cinatoken-relay
cargo test -p cinatoken-container-egress
cargo test -p cinatoken-container-runtime
cargo fmt --all --check
cargo clippy -p cinatoken-relay --lib --no-deps -- -D warnings -A clippy::match-like-matches-macro -A clippy::needless-borrow
cargo clippy -p cinatoken-container-egress -p cinatoken-container-runtime --all-targets --no-deps -- -D warnings
cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
bun run build:container-egress
bun run test:container-egress:runtime
bunx tsc -p services/container-controller/tsconfig.json --noEmit
bun run test:container-controller
bun run test:container-controller:protocol-portable
bun run test:container-controller:runtime
git diff --check
```

The Controller checkpoint passes 178 Bun tests, 165 portable protocol tests,
and 38 Workerd/SQLite tests. The focused artifact-store packet contributes 32
tests, including every named raw/client/compatibility/receipt crash boundary. The
gateway packet proves 0052 preflight before provider I/O, protocol/profile and
Worker-version fencing, default-off terminal interlock, complete/raw-only
recovery without another send, success receipt/result attachment before the DO
artifact attachment, and invalid-envelope quarantine. Rust and
cross-language counts are recorded again in the final repository verification
checkpoint after the complete aggregate finishes.

The touched Rust packages pass package-scoped strict Clippy and the v3 code was
corrected to retain workspace MSRV 1.78 compatibility. A broader strict Clippy
attempt still reports pre-existing warnings in `crates/core/src/audio_duration.rs`,
`crates/relay/src/retry.rs`, and `crates/relay/src/usage_receipt.rs`; those files
were not changed in this packet and remain separate cleanup debt.

Required P3 evidence covered locally:

- shared Rust/TypeScript canonical success bytes and digest plus four response
  classes, including provider 202 as HTTP error;
- strict UTF-8, base64url, key order, duplicate/unknown/missing field, integer,
  header, body, receipt, attestation, and 4 MiB boundary rejection;
- create/replay/conflict for provider evidence, client artifact, success
  compatibility result, usage receipt, D1 raw/client rows, and DO attachment;
- no compatibility result or receipt for typed, HTTP, or invalid-body errors;
- receipt-less success rejection before any raw R2/D1 write;
- exact 0048/0052 foreign-key order, exact `application/json` compatibility
  metadata, and byte-identical exact-success alias;
- DO migration 3 schema fingerprint, immutable identity ledger, generation and
  egress fences, eviction readback, duplicate replay, and conflict rejection;
- runtime success/rejected/recovery outer statuses and complete client artifact
  manifest validation; and
- pre-dispatch `none/raw_only/complete` recovery in which every non-`none`
  state, existing dispatch, or unavailable/conflicting readback performs zero
  provider sends.
- protocol/storage 4 MiB compatibility bounds remain tested while the active P3
  path enforces 1 MiB provider and 3.2 MB envelope rollout limits, exact-length
  allocation, canonical-copy removal, and post-parse base64 release.

Release acceptance remains blocked. Before any gate changes, the signed packet
must add authenticated target-bound 0052 readback, real R2 conditional-write and
response-loss evidence, real DO/Container lifecycle and version-skew tests,
provider call counters, P4 financial atomicity, independent amount/invoice
convergence, load/cost/SLO/alerts, retention/privacy/security review,
disable-first rollback, and C1-C5/G1-G8 approval. Production remains **NO-GO**.

## Bounded Container Reconciliation Observer Verification (2026-07-16)

This overlay supersedes only the preceding claim that fair pagination and a
durable observer runner are absent. It does not claim reconciliation apply,
edge replay, or remote evidence.

```powershell
python tools/verify_sqlite.py
# PASS: 43 migrations, 40 tables, 360 incremental columns, 57 key indexes.

node tools/audit_d1_migration_config.mjs --json
# PASS: 43 contiguous migrations; config/runtime head is 0043.

cargo test -p cinatoken-worker --lib container_reconciliation
# PASS: 5 passed; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 752 passed; 0 failed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
# PASS.

bun run check
# PASS: aggregate Worker, Controller, Workerd/DO, frontend, migration,
# SQLite, workspace-test, and wasm checks.
```

SQLite executes default-lazy insert, identity/type/lifecycle negatives,
generation-fenced claim and expired-lease takeover, retry/converged/dead-letter
transitions, global run-lease exclusion/takeover/completion, and 0042
compatibility. Rust source-contract tests require keyset/high-watermark
pagination with no OFFSET, global and item fences, observer-only writes, and no
operation or billing mutation. Pure tests preserve `prepared` versus
`dispatched`, DO `claimed` versus `running`, exact terminal matching,
fail-closed D1/DO/R2 classification, and deterministic bounded backoff.

The scheduled hook remains behind
`CONTAINER_OPERATION_RECONCILIATION_ENABLED=false` in all three tracked
environments. The runner writes only 0043 observer state, emits a bounded
redacted class summary, and performs no provider, financial, operation, DO, or
R2 mutation. Exact-response and divergence compiled cutover flags remain
false, so configuration cannot make Container cutover ready.

Still required are bounded R2 orphan inventory, authenticated operator
status/list/retry, provider-attempt journaling, a separately gated apply
protocol, public exact replay, the Linux canary, N/N-1, remote migration and
fault evidence, old-writer drain, enforcement migration 0046, rollback, and
C1-C5 approval. No remote migration, deployment, provider call, object write,
financial mutation, or traffic switch occurred. Go/VPS remains authoritative
and production remains **NO-GO**.

## Container Reconciliation Operator Read Verification (2026-07-17)

This overlay adds only authenticated read visibility to the 0043 observer.

```powershell
cargo test -p cinatoken-worker --lib container_reconciliation
# PASS: 11 passed; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 758 passed; 0 failed.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 44 passed; 0 failed.

python tools/verify_sqlite.py
# PASS: 43 migrations, 40 tables, 360 incremental columns, 57 key indexes.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
bun run check
# PASS.
```

Rust tests cover domain-separated operation/reconciliation/cursor references,
raw identity and run-owner redaction, strict cursor/filter bounds, aggregate
and stored-row fail-closed validation, parameterized stable pagination, route
registration, AdminAuth/RootAuth separation, no-store responses, and absence
of INSERT/UPDATE/DELETE from the operator read implementation. The class
allowlist is byte-for-byte shared with the observer classifier.

Workerd applies the full migration chain, transitions two valid observations
through pending, leased, and retry, then proves unauthenticated 401 responses,
authenticated aggregate/list results, exact filters, stable two-page cursor
pagination, no-store headers, and no raw operation ID, reconciliation ID, or
claim owner in either response.

No retry/apply endpoint, financial mutation, operation mutation, DO/R2 write,
provider call, remote migration, deployment, or traffic switch is claimed.
All eight Container gates remain false; Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-25 Audited Syscall Trace Verifier

The full-transaction trace gate now uses a checked-in Node-compatible verifier
rather than an inline workflow parser. Its eight Bun tests cover successful
paired-lock traces, exact lock-count regression, failed `EEXIST` probes,
failed-call evidence rejection, mutation without both locks, `AT_FDCWD`,
outside-root descriptors, incomplete lines and CLI ambiguity.

The workflow records `strace -f -yy` `%file` output plus lock, sync, chmod and
descriptor lifecycle calls. The verifier binds `-yy` descriptors beneath the
exact fixture root, tracks dup/close and lock ownership, rejects successful
legacy pathname mutation, and counts only successful syscall results.

Frozen Ubuntu evidence:

- candidate `938950b2f3057167d8cbf5749650681732006e0b`;
- [run 30159686961](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961);
- [job 89682866508](https://github.com/cinagroup/cinatoken-rust/actions/runs/30159686961/job/89682866508);
- Ubuntu 24.04.4, kernel `6.17.0-1020-azure`, Rust 1.97.1;
- 147 Linux library tests, formatting and strict Clippy passed;
- recovery observed exactly 4 locks and full transaction exactly 10;
- both traces observed successful dirfd `openat2`, `renameat2`, directory sync
  and descriptor chmod;
- the full trace observed successful dirfd `mkdirat`; and
- both traces reported no successful post-lock unconfined mutation.

Local aggregate evidence is 126 Rust library tests, 3 binary/CLI tests and 70
Bun tests with 258 expectations. Clean source identity:

- Git tree `ed6bcf39865d4cb5ee695cf3f9e53577daa26881`;
- 35962880-byte archive with SHA-256
  `6a03ced213ccd8837890b2cd7eb5b0903fb416749b3461c6ecbafd3dcf0e6293`;
- 33 required modules totaling 1678772 bytes; and
- inventory SHA-256
  `6fe6f610a4835faa860d56076009cb8a70cff80fa6036919c0968c1bbb2b3222`.

Failure-only trace retention is pinned to
`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`
for seven days. The successful run skipped that artifact as designed; its
verifier JSON is retained in the job log. The prior zero-job outage attempts
remain historical evidence and no longer block this exact candidate.

This proves the traced happy path and focused recovery syscall policy, not the
remaining process-death matrix, production image ACLs/mounts, abrupt power
loss, restore, immutable external evidence or Cloudflare lifecycle. No
credential or remote mutation was used. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-25 Candidate-Synced SIGKILL and Startup Recovery Verification

The audited crash fixture now kills the real writer after candidate
create-new rename, retained closure-directory sync and object-bound readback,
but before the accepted operation finish. The workflow kills the recorded
tracee PID, not the `strace` wrapper, and records status 137 plus a parsed
`+++ killed by SIGKILL +++` event for the same PID that held the two locks and
published the candidate.

The new verifier regression suite proves the durable order is
`rename -> directory sync -> readback -> SIGKILL`. It rejects the old
synthetic order, wrong-PID readback, `SIGTERM`, normal exit, early termination
and missing or duplicate SIGKILL evidence. The fresh recovery process proves
the exact accepted finish, zero ambiguous recovery, candidate-bound local
seal, post-recovery audit and byte/inode/mode/count-stable replay.

Frozen Ubuntu evidence:

- candidate `43b1536f0e1f075d27c249ca849f7e67a7655b89`;
- [run 30162862290](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290);
- [job 89690905464](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/job/89690905464);
- Ubuntu 24.04.4, kernel `6.17.0-1020-azure`, Rust/Cargo 1.97.1;
- 148 Linux library tests, formatting and strict all-target Clippy passed;
- exact successful locks were 4 focused recovery, 10 full transaction, 4
  candidate writer and 8 fresh candidate recovery;
- candidate writer status was 137 and its JSON reported
  `sigkillExitObserved=true`;
- all four traces reported no successful post-lock unconfined mutation and
  successful retained-dirfd open/rename, directory sync and descriptor chmod;
  and
- required writer/full/recovery traces reported successful retained-dirfd
  `mkdirat`.

The successful run retained four verification JSON documents and one
candidate boundary JSON in
[artifact 8620731294](https://github.com/cinagroup/cinatoken-rust/actions/runs/30162862290/artifacts/8620731294).
The artifact is 7414 bytes with SHA-256
`8c68ec0966a7bfe5dda0408031b7bdb27befe01935ccb5aba33ba6481d87f2a2`.
Its boundary binds the exact Git SHA, signal, tracer status and 4/8 writer and
recovery lock counts.

Local acceptance passed:

- 127 Rust library tests;
- 1 main-command test and 2 CLI tests;
- 72 Bun tests with 276 expectations;
- `cargo fmt --all -- --check`;
- warning-free `cargo clippy --locked -p
  cinatoken-ring-transition-runner --all-targets -- -D warnings`;
- workflow YAML lint; and
- direct replay of both failed-run Ubuntu traces after each verifier
  correction.

The startup test uses the real credential-verification entrypoint and proves a
prepared terminal candidate recovers before HTTP-core construction. The
subsequent execution is `ReceiptSealed` and performs no network or mutation.

Clean source identity:

| Field | Value |
| --- | --- |
| Commit | `43b1536f0e1f075d27c249ca849f7e67a7655b89` |
| Git tree | `5a1c408426534d6a27ad7fa1d5b71edf0c2f3f5e` |
| Archive bytes / SHA-256 | 36003840 / `8c41a77cb0f366e02f6eb3a689669f31ea71654abdf4f53eb8913cc590f63923` |
| Cargo.lock SHA-256 | `306232dc09ebc27d6a36f30d78492a8282e148771ca5bf3250be38507d1807eb` |
| bun.lock SHA-256 | `da9ef4e1e16cd9e231340d2999200fdd69321a3dd7905fbc3d7754e18586c26a` |
| package.json SHA-256 | `a03a6446fc9d5dba5fe69eff98c5fb67c831435b6810ac06f26059382cd25191` |
| Modules / bytes | 34 / 1719654 |
| Inventory SHA-256 | `534170adf68de8e647bdd9b0382d00097f5b665df1b356aa6e2466c4d9427e7b` |

This is local and CI crash/restart evidence, not production storage authority.
At this candidate, concurrent dual-startup recovery remained open; the
receipt-store variant is verified below. Candidate-finish-before-plan, the
remaining receipt-prefix crash sweep, image ACL/mount checks, power loss,
restore, external immutable evidence and Cloudflare lifecycle remain open.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-26 Concurrent Candidate Recovery Verification

Two independent OS processes now validate the same candidate-after-sync
fixture, wait behind one shared gate and concurrently execute receipt-store
recovery. Both converge on the same closure identity; exactly one observes the
unfinished start and writes its accepted finish, while the other performs a
legal read-only replay. The final store has exactly two operation receipts,
one authorization/closure directory and a sealed execution graph.

The strace bundle verifies the actual Rust test-thread TIDs rather than their
parent harness PIDs. It requires two distinct lock TIDs, six exclusive locks
per TID and twelve total. A participant can contain no successful write, but
the bundle must contain at least one successful retained-dirfd open/rename,
directory sync, descriptor chmod and required mkdir; both traces being
read-only is rejected.

Frozen Ubuntu evidence:

- candidate `aaa52936765ec47afdc2871ccab4fd2e6115ffbd`;
- [run 30183935884](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884);
- [job 89745204486](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/job/89745204486);
- 148 Linux library tests, formatting and strict all-target Clippy passed;
- exact standalone locks were 4/10/4/8 and concurrent locks were 6+6;
- process PID and lock-thread TID were separately recorded and exactly joined
  to the strace lock identities; and
- the final run had no failure annotation. Its only annotation was the upload
  action Node 20 deprecation warning while GitHub forced Node 24.

[Artifact 8626449986](https://github.com/cinagroup/cinatoken-rust/actions/runs/30183935884/artifacts/8626449986)
is 87879 bytes with GitHub artifact digest
`sha256:a97bb267dd8e24d81f5bf16c3e7dd258107ebc251032cd1ee7f3132cb6b2a589`
and expires `2026-08-25T02:05:23Z`. The accepted Git tree is
`fb8a9ae44621e0c04b57496393391e56762601ff`.

Local aggregate verification passed 127 Rust library tests, three binary/CLI
tests and 146 Bun tests with 573 expectations, plus formatting, YAML and
warning-free Clippy. Native Ubuntu is the Linux compilation evidence because
the Windows host lacks `x86_64-linux-gnu-gcc`.

At that frozen candidate, this closed only concurrent receipt-store recovery.
Real concurrent `verify_loaded_credentials()` startup and the narrower
zero-network syscall window are verified below. Bounded `flock` acquisition,
candidate-finish-before-plan, remaining crash prefixes, production
ACL/mounts, power-loss/restore and external WORM evidence remain open. Run
`30183488782` also left one non-reproduced full-suite failure; focused replays
passed, so repeated Ubuntu soak remains an explicit gate. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-26 Real Dual-Startup Zero-Network Window Verification

The Linux gate now launches two independent, environment-cleared child
processes against one terminal-candidate fixture. Their current-thread Tokio
test threads each create unique start and finish marker files around the real
`verify_loaded_credentials()` call and terminal `execute_current()` replay.
Both recover the same terminal closure with no HTTP core, unverified access
token, `ReceiptSealed`, no claim classification and no mutation transport
outcome. A third real startup replay returns the same closure; raw store audit
after closure returns `AlreadySealed`.

The production startup path handles a concurrent `AlreadySealed` result from
either operation audit or unfinished recovery by reading the installed
terminal closure. That branch returns before `HyperHttpsExchange`
construction. The verifier rejects missing or malformed windows, every failed
or successful network-class syscall inside a window, and every
outside-window network name except the explicitly pinned local
`socketpair` baseline.

Frozen Ubuntu evidence:

- candidate `eb90c27af35b56e169b64e676eba2bbb37d0fe15`;
- Git tree `cf9a63b698c35b8addaa97c7d84bb69f46ebbfa1`;
- [run 30186091600](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600);
- [job 89750973529](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/job/89750973529);
- 149 Linux library tests, formatting and strict all-target Clippy passed;
- existing standalone lock policies remained 4/10/4/8 and receipt-store
  concurrency remained 6+6;
- startup TIDs `4172` and `4173` had two complete create-new marker windows;
- 7252 syscalls were parsed across six identities, with 3880 syscalls inside
  the two windows and zero network-class attempts there;
- 64 outside-window split lines were reconciled; and
- exactly three outside-window network-class calls were observed, all
  `socketpair`; any other name or count fails the workflow.

[Summary artifact 8627086351](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086351)
contains 18 structured/log/PID files, is 14803 bytes, has digest
`sha256:91720d03fd24d8daf49609671d84a238db8b1df0bf1a331b97c8ec6d01b30f5f`
and expires `2026-08-25T03:24:49Z`.
[Raw trace artifact 8627086439](https://github.com/cinagroup/cinatoken-rust/actions/runs/30186091600/artifacts/8627086439)
contains seven successful traces, is 123728 bytes, has digest
`sha256:d177ca95b21a796e3f686644f24af3563079377a7e34d938d0e7fff063bceb95`
and expires `2026-08-25T03:24:49Z`. Successful raw traces and structured
summaries retain for 30 days; failed raw traces are isolated to a seven-day
failure artifact.

Local aggregate verification passed 127 Rust library tests, three binary/CLI
tests and 147 Bun tests with 608 expectations, plus format, YAML, Node syntax
and strict Clippy. Failed runs `30184982382`, `30185436031` and `30185637997`
are retained as negative evidence for, respectively, parent-harness
`socketpair`, split unscoped `readlink`, and same-TID Tokio initialization
before the call window.

This is a syscall-observation proof, not kernel-enforced isolation. Inherited
socket descriptors used through ordinary `read`/`write`, `sendfile` or
`io_uring` remain outside `%network`; network namespace/seccomp denial,
schedule soak, bounded `flock`, remaining crash points, production
ACL/mount/power-loss/restore, external WORM evidence and real Cloudflare
lifecycle remain required. The accepted run has only the pinned upload
action's Node 20 deprecation warning while GitHub forces Node 24. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-26 Bounded Nonblocking Receipt Lock Verification

The production Linux lock path now has a fixed 5-second total deadline shared
by the receipts-root and authorization locks. Acquisition uses only
`LOCK_EX | LOCK_NB`; contention retries every 10 milliseconds using absolute
`CLOCK_MONOTONIC` sleep. `EINTR` preserves the original deadline,
`EAGAIN`/`EWOULDBLOCK` are the only contention results, and timeout/system
errors preserve typed scope, operation and errno.

Rust verification covers:

- receipts-root contention returning the expected typed bounded timeout;
- authorization contention consuming the same deadline, releasing the root
  lock and leaving the authorization directory empty;
- injected `EINTR` attempts not resetting the deadline;
- unexpected `flock` errno classification; and
- a static cross-platform gate fixing the production 5-second, nonblocking,
  monotonic absolute-sleep protocol.

The JavaScript verifier covers exact flags/results, blocking and unknown flag
rejection, abnormal errno and positive-result rejection, stable retry
identity, required root/authorization order, missing monotonic sleep, EINTR
sleep/retry handling and strict split-call reconciliation. The workflow
captures `clock_nanosleep` for recovery, full transaction, candidate recovery,
both concurrent receipt processes and real startup. The candidate writer is
the sole exception because the test deliberately kills it while it waits in
an unrelated relative 50-millisecond harness loop after durable sync. Its
actual `EAGAIN` retry would still fail without captured absolute-sleep
evidence.

Frozen Ubuntu result:

| Field | Value |
| --- | --- |
| Candidate | `d96753c5fe90cc59d0ea539be346c27285fbdb69` |
| Git tree | `a7a8c8aaa4ce97506432b21f84672c1af7636634` |
| Run / job | [30187560531](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531) / [89754869675](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/job/89754869675) |
| Platform | Ubuntu 24.04.4, `x86_64-unknown-linux-gnu`, rustc/cargo 1.97.1 |
| Source validation | formatting, 154/154 library tests, all syscall policies and strict all-target Clippy passed |
| Standalone traces | terminal recovery 4/4; full transaction 10/10; candidate writer 4/4; candidate recovery 8/8 successful/attempted locks, zero contention |
| Concurrent receipt trace | 12 successful / 57 attempts / 45 contention / 45 monotonic sleeps / 0 interrupted / 0 blocking |
| Concurrent startup trace | 24 successful / 58 attempts / 34 contention / 34 monotonic sleeps / 0 interrupted / 0 blocking |
| Startup trace scope | TIDs `4177`,`4178`; 7008 parsed / 3456 scoped / 0 scoped network / 62 unscoped incomplete / 348 reconciled split lines / exact 3 `socketpair` baseline |

[Summary artifact 8627504413](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504413)
contains 18 verifier, boundary, log and PID files, is 15924 bytes, has digest
`sha256:f6ed76b44a6232ec388ed4a3d1f7ff31974b23c018ace23af7f99697ace09583`
and expires `2026-08-25T04:19:18Z`.
[Successful raw trace artifact 8627504519](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187560531/artifacts/8627504519)
contains seven traces, is 120805 bytes, has digest
`sha256:2390b75f13b58f315b88b64e3f4096e95f203af82489d17d80c12df3da33b720`
and expires `2026-08-25T04:19:18Z`.

Local post-fix validation passed 128 Rust library tests, strict all-target
Clippy and 26 focused Bun verifier/workflow tests; workflow formatting, Node
syntax and `git diff --check` also passed. A complete earlier local aggregate
on the lock implementation passed 128 library, 3 binary/CLI and 150 Bun tests
with 622 expectations before the native Linux schedule exposed and corrected
the recovery-loser case.

Negative evidence is retained:

- [run 30187320790](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187320790)
  exposed the legal `AlreadySealed` loser after 153 passing tests; only that
  typed result is now accepted and both participants still verify/replay one
  closure; and
- [run 30187432173](https://github.com/cinagroup/cinatoken-rust/actions/runs/30187432173)
  passed all 154 Linux tests, then rejected the incomplete relative harness
  sleep interrupted by the planned writer `SIGKILL`.

No live `EINTR` was observed; interruption semantics are covered by injected
Rust and verifier fixtures. This proof does not replace a process-level real
startup timeout test, repeated schedule soak, dedicated UID/GID and exact
ACL/mount/inherited-FD controls, ext4/XFS power loss, restore, external
signed/WORM evidence, real Cloudflare lifecycle or G1-G8. No credential or
remote authority was used. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-26 Real Startup Receipt-Lock Timeout Verification

This verification isolates a blocked startup from the successful dual-startup
campaign. A holder process acquires the exact production receipts-root lock.
A separate process/TID executes real `verify_loaded_credentials()` under a
current-thread Tokio runtime and a fail-fast HTTP-construction tripwire.

Rust assertions require:

- the holder remains alive until the timeout child exits;
- only typed
  `ReceiptError::LockTimeout { scope: "operation_receipts_lock",
  timeout_ms: 5_000 }` is accepted;
- elapsed time is at least 4,900ms and below 8,000ms;
- `HyperHttpsExchange::new()` has zero construction attempts;
- descendant path/type/device/inode/mode/link-count/content snapshot is exactly
  unchanged before holder release; and
- after release, real startup has no HTTP core/access token and executes
  `ReceiptSealed`.

Verifier assertions require:

- exactly one reported startup TID and one complete create-new marker window;
- the terminal pending retry targets only
  `<fixture>/execution-operation-receipts`;
- scoped successful locks equal zero;
- scoped attempts equal contention plus interrupted attempts;
- at least one contention and exactly one successful absolute
  `CLOCK_MONOTONIC` sleep per contention;
- zero blocking lock attempts and zero scoped network syscalls; and
- no unscoped network syscall name other than the pinned test-harness
  `socketpair`.

Frozen Ubuntu result:

| Field | Value |
| --- | --- |
| Candidate / tree | `56acfce31dbe5e154dd5450d5112882aef4f5dbd` / `d4e6fe556049047745638c1d653b3d0edb50f426` |
| Run / job | [30188739169](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169) / [89757895460](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/job/89757895460) |
| Platform/source | Ubuntu 24.04.4, `x86_64-unknown-linux-gnu`, rustc/cargo 1.97.1; formatting, 156/156 library tests and strict all-target Clippy passed |
| Runtime identity | holder PID `4178`; startup PID `4180`; startup TID `4181` |
| Timeout | fixed 5,000ms budget, 5,002ms observed, 15,000ms external watchdog |
| Scoped trace | 1,008 parsed; 491 lock attempts; 0 success; 491 contention; 491 monotonic sleeps; 0 interrupted; 0 blocking; 0 network |
| Whole trace | 5,748 parsed; 502 total lock attempts including unscoped setup/recovery; 11 successful unscoped locks; exact 3 unscoped `socketpair`; 3,000 split lines reconciled |
| Authority/filesystem | 0 HTTP construction; metadata-and-byte snapshot unchanged; post-release action `ReceiptSealed` |

[Summary artifact 8627833392](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833392)
contains 21 files, is 18671 bytes, has digest
`sha256:370e16a6f46c4a0156ca7288e6a4280a4a9b72550a61086ae8ebc2f447c0288a`
and expires `2026-08-25T05:04:15Z`.
[Successful raw trace artifact 8627833482](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188739169/artifacts/8627833482)
contains eight traces, is 150104 bytes, has digest
`sha256:337a52b48e2e1be92b674f05120a128831d34f41da0008bf65a1c7f1a88ddfb1`
and expires `2026-08-25T05:04:16Z`.

[Run 30188633076](https://github.com/cinagroup/cinatoken-rust/actions/runs/30188633076)
passed all runtime and trace assertions and uploaded both artifacts, then
failed strict Linux Clippy on a redundant test-only import and snapshot tuple
complexity. The accepted candidate replaces the tuple with an alias and reruns
the entire gate.

Local verification passed 129 library tests, three binary/CLI tests, strict
Clippy, the 152-test aggregate Bun gate, focused timeout/verifier tests, Bash
syntax, YAML parsing, Node syntax and `git diff --check`. Native Linux remains
the accepted source for process, `flock` and `strace` behavior.

This closes the real-startup cooperative timeout sub-gate only. It does not
prove namespace/seccomp/inherited-FD isolation, production image UID/GID/ACL
and mount policy, ext4/XFS power-loss/restore, external signed WORM retention,
remote Cloudflare lifecycle or G1-G8. Repeated local schedule soak is closed by
the verification section below. No credential or remote authority was used.
Go/VPS remains authoritative and production remains **NO-GO**.

## Repeated startup schedule soak verification (2026-07-26)

Accepted command shape:

```bash
for iteration in $(seq 1 32); do
  timeout --signal=TERM --kill-after=2s 15s \
    "${test_binary}" \
    --exact transport::tests::linux_multiprocess_startup_terminal_candidate_converges_without_http \
    --nocapture
done
```

The workflow admits a sample only when the command exits zero and reports two
numeric unequal process PIDs, two numeric unequal lock TIDs, one nonempty
closure and action `receipt-sealed`. The exact Rust test itself asserts equal
child closures, both `ReceiptSealed` outcomes, no HTTP core/access token,
successful real-startup replay and exact installed-closure recovery. The
workflow adds a 15,000ms iteration watchdog, a separate 120,000ms campaign
budget, unique iteration indexes and SHA-256 binding of all normalized NDJSON
records.

Frozen result:

| Field | Value |
| --- | --- |
| Candidate / tree | `01c04940c77610a0d98a3feb61fa235724838d58` / `2f2ecc7d93da479d8ebf19e39f880da965c50af7` |
| Run / job | [30189628276](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276) / [89760384170](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/job/89760384170) |
| Platform/source | Ubuntu 24.04.4, Linux `6.17.0-1020-azure`, rustc/cargo 1.97.1; formatting, 156/156 library tests, all syscall policies and strict all-target Clippy passed |
| Iterations | 32 required / 32 observed; all per-sample PID and TID pairs unequal; all actions `ReceiptSealed` |
| Timing | campaign 6,133ms; sample minimum 173ms, maximum 177ms and total 5,574ms |
| Closure evidence | equal per-fixture participant closure and safe replay required by the exact Rust test; 7 cross-fixture closures observed but not pinned |
| Records | `startup-schedule-soak-records.ndjson`, 32 samples, `sha256:c72f8ad9a5b80ec88af002883bc33c0d1673c31532184f931fb04639a9bdc1d4` |
| Trace boundary | `single-captured-sample-plus-process-soak-v1`; one separate successful startup trace, `sha256:63ce773e5ba81b128373135ad4f3a1f8341c9d81308bb2bd9401f35e33a3b462` |

[Summary artifact 8628118657](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118657)
contains 24 files, is 28940 bytes, has digest
`sha256:b83cb16e39540e6dc25ec34c5f6ea4562bddcf2faca8f4f9d2054c0ce4e710e0`
and expires `2026-08-25T05:36:45Z`.
[Successful raw trace artifact 8628118769](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189628276/artifacts/8628118769)
contains eight traces, is 149155 bytes, has digest
`sha256:16d0a7c08df3b6d62e5776790632d51d8c429a0dcbe06af390982390da624e7e`
and expires `2026-08-25T05:36:46Z`.

[Run 30189502740](https://github.com/cinagroup/cinatoken-rust/actions/runs/30189502740)
is negative calibration evidence: all 32 exact iterations succeeded, then an
invalid single-global-closure aggregate assertion failed. The accepted policy
requires equality only within each fixture's two-process result and reports
cross-fixture diversity without freezing it.

Local validation for the implementation passed 129 Rust library tests, three
binary/CLI tests, strict Clippy, 153 aggregate Bun tests, 29 focused
syscall/workflow tests, Bash syntax, YAML parsing, Node syntax and
`git diff --check`. Native Linux run 30189628276 is authoritative for process,
`flock`, `strace` and campaign evidence.

This closes local repeated startup scheduling only. It does not prove 32
traced samples, production UID/GID/ACL/mount/inherited-FD policy, real
Cloudflare cold-start/eviction/replacement, long-duration load, power-loss
recovery, external WORM retention or G1-G8. No credential or remote authority
was used. Go/VPS remains authoritative and production remains **NO-GO**.

## Container Reconciliation Retry Preview Verification (2026-07-17)

This overlay adds only a RootAuth-protected preview for a dead-letter
observation. It does not compile or enable retry apply.

```powershell
cargo test -p cinatoken-worker --lib container_reconciliation
# PASS: 14 passed; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 761 passed; 0 failed.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 44 passed; 0 failed.

python tools/verify_sqlite.py
# PASS: 43 migrations, 40 tables, 360 incremental columns, 57 key indexes.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
bun run check
# PASS, including frontend, route ownership, workspace, and wasm checks.
```

Rust tests prove the versioned target binds the immutable observation sequence,
operation identity, owner generation, and reconciliation identity through a
domain-separated digest. Target tampering or digest mismatch shares the same
404 response as a missing observation. The preview accepts only one of four
bounded reasons and a strict evidence reference, returns only a separate
SHA-256 evidence fingerprint, and binds the complete observed state and proposed
action into a domain-separated preview token.

Workerd proves anonymous access is 401, active observer-managed states are 409,
and only a contract-valid dead-letter observation returns a no-store preview.
The response omits raw evidence and authority-bearing identities. A before/after
D1 read proves the preview does not change observer state.

`apply_compiled=false`, `apply_enabled=false`, and
`retry_apply_not_compiled` remain explicit. No apply route, provider attempt,
financial or operation mutation, DO/R2 write, remote migration, deployment, or
traffic switch was added. All eight Container gates remain false; Go/VPS
remains authoritative and production remains **NO-GO**.

## Container R2 Orphan Inventory Verification (2026-07-17)

This overlay adds a default-off, observer-only inventory for the three
Container R2 artifact lanes. It does not add cleanup, retry apply, remote
migration, or a Container cutover gate.

```powershell
python tools/verify_sqlite.py
# PASS: 44 migrations, 42 tables, 406 incremental columns, 62 key indexes.

node tools/audit_d1_migration_config.mjs --json
# PASS: 44 contiguous migrations; config/runtime head is 0044.

cargo test -p cinatoken-worker --lib
# PASS: 769 passed; 0 failed.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 passed; 0 failed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
node --check tests/do-lifecycle-runtime.test.mjs
# PASS.

worker-build --release
# PASS: optimized Worker Wasm and JS package generated from final Rust source.
```

The SQLite verifier covers default-lazy creation, fixed lane identities,
same-second lease transitions, generation fencing, expired-lease takeover,
first-generation observation, second-generation candidate promotion,
repeated candidate observations, exact resolution, and rejection of invalid
contract identities. Guard statements in each D1 batch require exactly one
finding or cursor mutation; a failed compare-and-swap aborts the complete
batch instead of committing partial findings.

Workerd inventories input, result, and client-response objects using bounded
R2 LIST pages with opaque cursors and metadata included. It proves recent and
active/recovery artifacts are deferred, divergent references remain observed,
and only unattached anomalies become candidates after two completed scan
generations. Coverage includes a same-key/different-version D1 reference and
the later demotion of an existing candidate when a divergent reference appears;
neither state can become a cleanup candidate. Result provider/admission
metadata and client response status/header provenance must match D1 exactly. A
later exact D1 reference resolves the missing-operation finding.

Before/after snapshots prove complete R2 object identity, version, ETag, size,
upload time, body digest, HTTP metadata, and custom metadata remain unchanged.
They also compare complete rows for operations, terminal events/outbox,
billing, reconciliation observations, users, tokens, and channels. Runtime
inventory writes are restricted to the 0044 cursor/finding tables and perform
no R2 GET, HEAD, PUT, or DELETE.

Admin status and Root findings responses are authenticated, no-store, bounded,
strictly filtered, and expose only domain-separated references. Apply and
delete are explicitly uncompiled and no routes exist. Independent TOML parsing
confirmed all three tracked environments keep inventory disabled, use a page
limit of 4 and a 24-hour grace period, and retain all eight Container cutover
gates as false.

Bun is unavailable in this shell, so the aggregate `bun run check` and the
Bun-native scheduler-config test were not rerun. Direct Node Workerd coverage,
an independent TOML assertion, migration audit, SQLite replay, Rust tests, and
Wasm compilation passed. The final optimized Worker build also passed. No
remote D1 migration, R2 access, deployment, provider call, or traffic switch
occurred; Go/VPS remains authoritative and production remains **NO-GO**.

## Container Reconciliation Retry Apply Verification (2026-07-17)

This overlay adds only the separately gated 0045 observer re-observation
protocol. It does not add provider retry, operation or financial mutation,
Durable Object mutation, R2 mutation, remote migration, or Container cutover
authority.

```powershell
python tools/verify_sqlite.py
# PASS: 45 migrations, 43 tables, 434 incremental columns, 64 key indexes.

node tools/audit_d1_migration_config.mjs --json
# PASS: 45 contiguous migrations; config/runtime head is 0045.

cargo test -p cinatoken-worker --lib container_reconciliation
# PASS: 15 passed; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 770 passed; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: 751 non-Worker unit/integration tests; all doc tests passed.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 passed; 0 failed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
node --check tests/do-lifecycle-runtime.test.mjs
# PASS.

worker-build --release
# PASS: optimized Worker Wasm and bundled JS generated from final source.
```

SQLite executes stale-preview rejection with zero partial events, one exact
dead-letter requeue, unchanged operation authority, consumed-dead-letter
rejection, immutable event update/delete rejection, and exhausted-horizon
rejection. The migration remains default-lazy: applying 0045 creates no event,
does not backfill an observation, and changes no existing operation or observer
state. The schema and runtime verifier require exact class/dead-letter reason,
at least 60 seconds of remaining recovery margin, event-backed lifecycle
authority, and one-row trigger assertions.

Rust source and validation tests prove that the repository writes only the
retry event, batches it with the supplied admin audit, and contains no direct
operation, billing, user, token, channel, or observer UPDATE. Event validation
rejects horizon exhaustion, inconsistent class/reason, zero timestamps and
insufficient margin. Admin tests cover strict target/evidence/idempotency
inputs, full-state preview binding, deadline eligibility, Root + step-up route
registration, no-store responses, and fixed false permissions for provider,
operation, financial, DO, and R2 mutation.

Workerd applies all 45 migrations and exercises the actual HTTP control chain.
Anonymous preview is 401, active observer-owned state is 409, apply before
fresh verification is 403, the first verified request is `applied`, an exact
repeat is `duplicate` with the original schedule, and a new idempotency key
with the consumed preview is 409. D1 contains exactly one immutable retry event
and one admin audit. Complete before/after snapshots of operations, terminal
events/outbox, HTTP and Realtime billing reservations, users, tokens, channels,
and R2 keys are unchanged; only the expected observer row moves from
`dead_letter` to `retry`.

Independent config inspection confirms exactly three tracked
`CONTAINER_RECONCILIATION_RETRY_APPLY_ENABLED=false` values and no true value;
the automatic observer gate is also false in all three environments. The
Workerd fixture alone enables apply. Bun is unavailable in this shell, so the
Bun-native scheduler TOML test and aggregate `bun run check` were not rerun;
the same gate counts were checked directly, while Node syntax, migration
audit, full Workerd, Rust/workspace, SQLite, wasm32, and release build checks
passed.

Remote 0045 application, isolated staging Root + fresh-step-up evidence,
alerting, rollback, real R2/Container faults, provider-broker/journal wiring,
exact edge replay, Linux canary, N/N-1, old-writer drain, and 0046 enforcement
remain mandatory. All eight Container cutover gates remain false. Go/VPS
remains authoritative and production remains **NO-GO**.

## Provider Attempt Journal Verification (2026-07-17)

This overlay verifies a default-off DO-local journal and protocol compatibility.
It does not verify a provider network call, Container image, remote deployment,
retry scheduler, global terminal acknowledgement, or production readiness.

```powershell
node node_modules/typescript/bin/tsc -p services/container-controller/tsconfig.json --noEmit
# PASS.

node node_modules/vitest/vitest.mjs run --config vitest.container-controller-protocol.config.mjs
# PASS: 45 tests across operation outcomes, signed v1/v2 protocol, storage, and provider gateway.

node node_modules/vitest/vitest.mjs run --config vitest.container-controller.config.mjs
# PASS: 22 Workerd/DO SQLite tests.

cargo test -p cinatoken-worker --lib container_controller
# PASS: 10 tests; 0 failed.
```

Portable tests prove the provider virtual host accepts only exact host/path,
POST JSON, bounded body, known fields, and attempt generations 1..3. The first
dispatch response alone authorizes send; replay does not. Terminal success,
definite rejection, and ambiguity have disjoint response shapes. Storage tests
prove legacy R2 metadata remains version 1 and journaled metadata is version 2
with the exact attempt generation.

Workerd exercises the real DO SQLite schema and transactions. Coverage proves
atomic operation start plus attempt creation, concurrent-start convergence,
prepared/dispatched persistence across eviction, one-shot dispatch, immutable
events, prepared deadline cancellation, dispatched ambiguity, definite-
reject-only bounded retry policy, retry due-time and maximum, ambiguous
operation recovery, exact attempt generation for result attach, and result-
required success. It also reads a cancelled attempt through the production row
validator so the safe-cancellation path cannot be write-only.

Protocol coverage proves status v1 omits `provider_attempt`, v2 includes it
under a separately signed path, and the two paths are not authority-
interchangeable. TypeScript and Rust reject contradictory operation/attempt
states and independently valid but unequal result manifests. Rust accepts a
missing attempt field from v1, supports cancelled status, checks immutable
provider/admission/request identity and generation bounds, and rejects malformed
success, forged generation, or prepare/dispatch timestamps at or beyond the
operation execution deadline.

The full local release matrix passed on the final source:

```powershell
python tools/verify_sqlite.py
# PASS: 45 migrations, 43 tables, 434 incremental columns, 64 key indexes.

node tools/audit_d1_migration_config.mjs --json
node --check tests/do-lifecycle-runtime.test.mjs
# PASS: migration head remains 0045; syntax is valid.

cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib
# PASS: 771 passed; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: 751 non-Worker unit/integration tests; all doc tests passed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-tenant --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-outbound --target wasm32-unknown-unknown
# PASS: all three wasm32 targets.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 Workerd lifecycle tests.

node node_modules/wrangler/bin/wrangler.js types `
  services/container-controller/worker-configuration.d.ts `
  --config services/container-controller/wrangler.jsonc `
  --env-interface ContainerControllerEnv --check
node node_modules/wrangler/bin/wrangler.js deploy `
  --config services/container-controller/wrangler.jsonc `
  --dry-run --containers-rollout none `
  --outdir .wrangler/container-controller-build
# PASS: generated types are current and the private Controller dry-run bundles.
```

An independent Node assertion parsed all three Controller JSON configs and
proved every execution/storage/journal/retry/staging flag remains false,
`CONTAINER_MAX_PROVIDER_ATTEMPTS=1`, no authority secret is committed, and
Container capacity matches shard count. The optimized Worker build passed from
`crates/worker` after explicitly injecting the Cargo.lock-matched global
`wasm-bindgen 0.2.125` and the repository-local esbuild binary. A preliminary
raw `worker-build` invocation exposed its private cached `wasm-bindgen 0.2.105`
and correctly failed schema compatibility before packaging; no dependency was
downgraded. Wrangler could not write its optional user-profile debug log under
the filesystem sandbox, but both commands completed with exit code 0.

Bun is unavailable in this shell, so the aggregate `bun run check` and the
Bun-native config wrapper were not run and are not inferred from the Node
substitutes. The underlying changed Controller suites, Workerd suites, Rust
workspace, SQLite chain, wasm targets, release package, dry-run, formatter, and
diff checks all passed.

Remote evidence remains empty. Required next proof is an atomic private
provider egress broker plus actual Linux Container client, followed by disabled
deployment readback, N/N-1, one deterministic non-provider canary, real R2 and
Container faults, global terminal ack/compaction, accounting convergence, load,
cost, alerts, and rollback. Go/VPS remains authoritative and production remains
**NO-GO**.

## Private Provider Egress Canary Verification (2026-07-17)

This overlay verifies the default-off local transport from the Rust Linux
runtime through the Controller and one-shot DO attempt journal to a separate
private credential-owning Worker. It does not verify a remote Container,
provider call, production secret, deployment, traffic switch, retry, streaming,
or financial terminalization.

```powershell
cargo test -p cinatoken-container-egress
# PASS: 3 tests; 0 failed.

cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
worker-build --release
# PASS: wasm32 check and optimized broker Wasm/JS package.

cargo test -p cinatoken-container-runtime
# PASS: 12 unit tests plus 7 HTTP tests; 0 failed.

node node_modules/typescript/bin/tsc `
  -p services/container-controller/tsconfig.json --noEmit

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller-protocol.config.mjs
# PASS: 5 files, 52 tests.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller.config.mjs
# PASS: 22 Workerd/DO SQLite tests.

cargo test -p cinatoken-worker --lib
# PASS: 771 tests; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 Workerd lifecycle tests.

python tools/verify_sqlite.py
node tools/audit_d1_migration_config.mjs --json
# PASS: 45 contiguous migrations, 43 tables, 434 incremental columns,
# 64 key indexes; runtime and configuration head remain 0045.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-tenant --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-outbound --target wasm32-unknown-unknown
cargo fmt --all -- --check
git diff --check
# PASS.
```

The portable gateway suite proves one successful provider call, create-only R2
result persistence, exact attempt attachment, and terminal success. It also
proves broker transport loss becomes ambiguous, dispatched replay never calls
the broker, attached-result replay converges without a provider call, R2-to-DO
attach uncertainty cannot resend, and a lost terminal RPC rereads canonical DO
state. Disabled or malformed requests, invalid deadlines, missing Service
Bindings, and non-dispatched global D1 state all fail before one-shot dispatch.

The broker's native tests enforce exact lowercase SHA-256, fixed configured
model, non-streaming JSON, bounded identity syntax, and a deadline no more than
five minutes ahead. Final source additionally bounds both request and provider
response bodies to 4 MiB, constructs a fixed upstream host/path, injects only
the broker secret, uses manual redirects, explicitly aborts the upstream fetch
at the absolute deadline, and contains no retry loop.

The runtime tests prove the execution gate remains false by default, health
still works while execution is disabled, only `chat_completions_canary` reaches
the injected executor, executor success returns only its exact manifest, and an
unknown execution result becomes recovery. The real client uses only internal
HTTP hosts, rechecks R2 input length/hash/type, applies the same absolute
deadline to transport and bounded body reads, and strictly validates the
gateway identity and success/ambiguity shape.

Wrangler generated-type checking reported the checked file current, and the
Controller dry-run bundled successfully with the `PROVIDER_EGRESS` Service
Binding and both new gates false. Wrangler could not write its optional
user-profile debug log under the filesystem sandbox but exited 0. Independent
PowerShell assertions parsed all three Controller JSON configurations and
proved private URLs, exact environment-specific broker targets, journal/client/
egress/retry false, and maximum attempts one. A separate source assertion proved
the broker TOML has no route, disables development and preview URLs, and keeps
its gate false and model empty in all three environments.

The optimized broker build used the Cargo.lock-matched global `wasm-bindgen
0.2.125` and repository-local esbuild binary. The package succeeded with the
existing optional missing-license-file and generated panic-hook warnings; no
dependency was downgraded. Bun is unavailable in this shell, so `bun run check`
and the Bun-native configuration test were not run. TypeScript, portable
Vitest, Workerd, Cargo workspace, Wasm, Wrangler, SQLite, syntax, configuration,
formatter, and diff checks cover the changed paths directly.

A focused credential/egress scan found the real provider host and Authorization
construction only in `cinatoken-container-egress`; the Controller contains one
readiness fetch and one execute fetch, and the Container has no credential. The
Container allowlist holds only synthetic internal hosts and
`enableInternet=false`. Remote evidence is
still empty: no API key was provisioned, no Worker or Container was deployed,
no Docker image was started, no R2/D1/DO remote state changed, and no provider
request was sent. Remote broker readiness/deployment-version readback, immutable
egress profile identity, provider-native idempotency/lookup, durable upstream
response provenance, global terminal acknowledgement, edge replay, financial
convergence, N/N-1, real fault/load/cost/alert/rollback evidence, and C1-C5
approval remain mandatory. Go/VPS remains authoritative and production remains
**NO-GO**.

## Pre-Dispatch Broker Readiness Verification (2026-07-17)

This overlay verifies the deterministic configuration probe added between
global D1 admission and one-shot DO dispatch. It does not claim provider health,
credential validity, deployment affinity, a remote Container, or production
readiness.

```powershell
cargo test -p cinatoken-container-egress
# PASS: 4 tests; 0 failed.

cargo test -p cinatoken-container-runtime
# PASS: 12 unit tests plus 7 HTTP tests; 0 failed.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller-protocol.config.mjs
# PASS: 5 files, 53 tests.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-egress.config.mjs
# PASS: compiled Rust broker behind Service Bindings; 3 tests.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller.config.mjs
# PASS: 22 Workerd/DO SQLite tests.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 Workerd lifecycle tests on the clean full rerun.

cargo test -p cinatoken-worker --lib
# PASS: 771 tests; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-tenant --target wasm32-unknown-unknown
cargo check -p cinatoken-wfp-outbound --target wasm32-unknown-unknown
cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
# PASS: all four wasm32 targets.

worker-build --release
# PASS: optimized broker Wasm/JS package.

node node_modules/typescript/bin/tsc `
  -p services/container-controller/tsconfig.json --noEmit

wrangler types services/container-controller/worker-configuration.d.ts `
  --config services/container-controller/wrangler.jsonc `
  --env-interface ContainerControllerEnv --check

wrangler deploy --config services/container-controller/wrangler.jsonc `
  --dry-run --containers-rollout none `
  --outdir .wrangler/container-controller-build
# PASS: TypeScript, generated bindings, private Service Binding, and bundle.

python tools/verify_sqlite.py
# PASS: 45 migrations, 43 tables, 434 incremental columns, 64 key indexes.

cargo fmt --all -- --check
git diff --check
# PASS.
```

The portable gateway suite proves the exact order is D1 admission, broker
readiness, DO dispatch, then execute. A 503, wrong profile, unknown field, or
oversized readiness body produces a no-store 503, zero dispatches, and zero
execute calls. The successful path makes exactly one readiness call and one
execute call. Existing post-dispatch transport, R2, attach, and terminal
uncertainty tests continue to prove no resend.

The separate broker Workerd suite loads the release-built Rust Worker rather
than a TypeScript mock. It proves the ready response is exact and contains
neither configured model nor test credential, while disabled, missing-model,
missing-secret, wrong-method, and wrong-profile cases fail closed. No outbound
provider service is present, so successful readiness also proves the probe does
not perform provider I/O. The test runtime uses compatibility date 2026-07-15,
the newest date supported by the installed Workerd; tracked deployment config
remains 2026-07-17.

The first full 45-test DO run had one timeout waiting for an authenticated
Realtime reservation while unrelated queue fault-injection work was active. The
same test passed immediately in isolation, and a complete clean rerun passed
45/45. This was treated as a timing observation, not hidden as an initial pass.

Static assertions independently proved the source call order, all three
Controller configurations remain private and default-off, and provider attempts
remain capped at one. The credential/egress scan found the real provider host
and API-key binding only in the private broker; the visible credential strings
are test fixtures or the documented secret-binding name. No Cloudflare token,
provider credential, or production secret was added.

Bun is unavailable in this shell, so the aggregate `bun run check` and
Bun-native configuration wrapper were not run. Their changed-path Rust,
TypeScript, Vitest, Workerd, Wrangler, SQLite, syntax, configuration, formatter,
and release-build gates were run directly. No remote migration, secret
provisioning, Worker/Container deployment, Docker launch, provider request,
financial mutation, or traffic switch occurred.

Readiness remains a non-atomic configuration snapshot. Production still needs
remote target/deployment-version readback, mixed-version N/N-1 proof, credential
rotation, provider-native idempotency or lookup, immutable D1/DO egress-profile
identity, actual Container and network fault evidence, global terminal
acknowledgement, exact edge replay, financial convergence, load/cost/alerts,
rollback, and C1-C5 approval. All tracked gates stay false; Go/VPS remains
authoritative and production remains **NO-GO**.

## Provider Broker Version Affinity Verification (2026-07-17)

This overlay verifies local Worker-version affinity and durable provider-egress
provenance. It does not claim a remote deployment, exact version pin, provider
health, production secret, real provider call, or traffic cutover.

```powershell
cargo test -p cinatoken-container-egress
# PASS: 5 tests.

cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
worker-build --release
# PASS: Wasm check and optimized compiled broker package.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-egress.config.mjs
# PASS: 1 file, 4 compiled Rust/Workerd tests.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller.config.mjs
# PASS: 1 file, 23 Workerd/DO SQLite tests.

node node_modules/vitest/vitest.mjs run `
  --config .codex-portable-tests.config.mjs
# PASS: 5 files, 58 portable Controller tests. The temporary config mapped
# bun:test to Vitest because Bun is unavailable; it was removed after the run.

node node_modules/typescript/bin/tsc `
  -p services/container-controller/tsconfig.json --noEmit

node node_modules/wrangler/bin/wrangler.js types `
  services/container-controller/worker-configuration.d.ts `
  --config services/container-controller/wrangler.jsonc `
  --env-interface ContainerControllerEnv --check
# PASS: source types and generated environment types are current.

node node_modules/wrangler/bin/wrangler.js deploy `
  --config services/container-controller/wrangler.jsonc `
  --dry-run --containers-rollout none `
  --outdir .wrangler/container-controller-build
# PASS: Controller bundle and private Service Binding.

# Run separately for local, staging, and production broker environments.
node node_modules/wrangler/bin/wrangler.js deploy `
  --config crates/container-egress/wrangler.toml `
  --env <environment> --dry-run `
  --outdir .wrangler/container-egress-<environment>
# PASS: all three report env.CF_VERSION_METADATA and default-false broker vars.

cargo test -p cinatoken-worker --lib
# PASS: 772 tests.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 45 Workerd lifecycle tests. Expected fault-injection exceptions and
# queue-to-DLQ warnings were observed; the suite passed.

python tools/verify_sqlite.py
# PASS: 45 migrations, 43 tables, 434 incremental columns, 64 key indexes.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
git diff --check
# PASS.
```

The compiled broker test supplies Worker Version Metadata through Miniflare and
proves an exact secret-free, N-1-compatible three-field readiness body plus the
private version header. A fifth broker omits
the binding and fails closed. Disabled, missing-model, missing-secret,
wrong-method, and wrong-profile behavior remains fail closed. The broker source
returns its actual version header on both readiness and execute responses and does not
forward affinity or provenance headers to the provider.

The execute test first proves protocol v2 reaches only the local provider mock
when the expected Worker version equals the runtime Version Metadata. It then
sends a different expected version and receives the broker's 409 mismatch with
no provider-mock response marker. The guard executes before body read, secret
access, and outbound fetch. Controller tests independently require execute v2
and the committed expected-version header.

The portable gateway suite proves readiness and execute use the same
`Cloudflare-Workers-Version-Key`, equal to the frozen provider operation ID.
The DO V2 dispatch receives and returns the exact profile/version identity before
the only POST. A missing old-DO RPC fails before send; corrupt dispatch readback
makes zero provider calls; a different execute version after POST returns
`provider_egress_version_ambiguous`, writes no R2 result, and records recovery
without retry. The success path writes R2 custom metadata schema 3.

The Workerd SQLite suite proves the version identity survives eviction, appears
in the immutable dispatch event, rejects later SQL mutation, accepts an exact V2
replay, and rejects a different identity. The legacy dispatch path persists
null identity fields, preserving N/N-1 rows. Storage tests independently prove
R2 metadata schemas 1 and 2 remain valid, schema 3 includes profile/version, and
a half-written identity is rejected before R2 I/O. Rust unit coverage validates
the exact result metadata shapes for schemas 1/2/3, rejects non-canonical or
partial schema-3 values, and the Workerd inventory scenario scans a real
schema-3 result without reporting an anomaly.

The readiness body intentionally does not duplicate the Worker version. Keeping
the established three-field v1 shape lets broker N serve Controller N-1 during
target-first rollout; Controller N obtains the platform identity from the new
private header and fails safely before dispatch when broker N-1 lacks it.
Rollback deploys Controller N-1 before broker N-1. This follows Cloudflare's
requirement that mixed Worker/Durable Object API versions remain forward and
backward compatible during gradual deployment.

Wrangler dry-runs confirm `CF_VERSION_METADATA` is declared separately in local,
staging, and production. Cloudflare version affinity is deliberately documented
as stable-key routing, not an exact pin; correctness comes from comparing the
actual runtime version ID returned before and after dispatch. See the official
[Version Metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
and [Version Affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)
contracts.

Bun is unavailable in this shell, so the aggregate `bun run check` and the
Bun-native TOML/config wrapper were not run. Their changed-path behavior was
covered by source TypeScript, the portable Vitest mapping, compiled Workerd,
three environment-specific Wrangler dry-runs, Cargo, SQLite, formatter, and
diff checks. No remote migration, secret provisioning, deployment, provider
request, R2/D1/DO production mutation, financial mutation, or traffic switch
occurred.

Migration 0046 remains reserved. Global D1 egress provenance, remote version
readback, target-first mixed-version drills, full edge/controller/DO/container
artifact identity, provider-native idempotency or lookup, real fault/load/cost
evidence, terminal acknowledgement, financial convergence, rollback, and C1-C5
approval remain required. All gates stay false; Go/VPS remains authoritative
and production remains **NO-GO**.

## Global Terminal Acknowledgement Verification (2026-07-17)

This overlay verifies the default-off D1 terminal-outbox delivery path and the
non-compacting shard acknowledgement ledger. It does not authorize a remote
migration, deployment, provider request, financial mutation, or traffic switch.

```powershell
cargo test -p cinatoken-worker --lib
# PASS: 783 passed; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 1 file, 48 Workerd/D1 tests. Expected fault-injection exceptions and
# queue-to-DLQ warnings were observed; the suite passed.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller-protocol.config.mjs
# PASS: 5 files, 60 protocol/gateway tests.

node node_modules/vitest/vitest.mjs run `
  --config vitest.container-controller.config.mjs
# PASS: 1 file, 27 Durable Object SQLite tests.

node node_modules/typescript/bin/tsc `
  -p services/container-controller/tsconfig.json --noEmit

node node_modules/wrangler/bin/wrangler.js types `
  services/container-controller/worker-configuration.d.ts `
  --config services/container-controller/wrangler.jsonc `
  --env-interface ContainerControllerEnv --check
# PASS: Controller source and generated Env types are current.

# Run separately with each local, staging, and production Controller JSONC.
node node_modules/wrangler/bin/wrangler.js deploy `
  --config <controller-config> --dry-run `
  --containers-rollout none --outdir <isolated-outdir>
# PASS: all three bundles; both terminal ACK and compaction gates report false.

python tools/verify_sqlite.py
# PASS: 45 migrations, 43 tables, 434 incremental columns, 64 key indexes.

node tools/audit_d1_migration_config.mjs --json
# PASS: 45 contiguous migrations; config/runtime head is 0045.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
cargo fmt --all -- --check
node --check tests/do-lifecycle-runtime.test.mjs
node --check tests/fixtures/container-terminal-ack-mock.mjs
node --check vitest.do.config.mjs
git diff --check
# PASS.

# From crates/worker with the locked wasm-bindgen and local esbuild binaries.
worker-build --release
# PASS: optimized Wasm and bundled Worker JavaScript generated from final Rust.
```

The Worker validates immutable event and operation identity before claiming one
30-second generation lease. D1 completion, retry, and dead-letter updates all
require the same generation, attempt count, expiry, and prior update timestamp.
Revision 2 is excluded from selection and claim until its exact revision-1
predecessor is delivered. The financial writer also refuses to create revision
2 unless that predecessor already exists for the same operation, owner
generation, and reconciliation ID; all dependent business updates then remain
unchanged. Migration 0042 was not rewritten and migration 0046 was not consumed.

The private Service Binding request is body-signed, bounded to 4 KiB, uses a
three-second timeout, and carries only terminal, result-manifest, shard, and
trace identity. Strict response validation checks status, JSON/no-store shape,
and every echoed identity. The Workerd fixture covers success, retry, permanent
conflict, old-state preservation, overlapping schedulers, and a lost-response
window: a Controller-side prior acceptance returns `duplicate` and converges
the original D1 row at delivery generation 1. Error classification keeps an
old Controller's exact `route_not_found` response retryable for rolling
upgrade, while the current Controller's exact `terminal_ack_not_found` response
is a permanent dead letter rather than an infinite retry. An exact
`authority_expired` response is retryable so the next attempt receives a fresh
body-bound authority token instead of dead-lettering valid durable work.

The Controller stores acknowledgements in the dedicated
`cinatoken_shard_terminal_acks` table, independent of provider journaling.
Tests prove journal-disabled final ACK, exact duplicate/conflict handling,
old-object schema creation across eviction, a recovery revision 1 with a result
manifest, and ordered revision-2 completion. The bounded protocol permits a
result-free successful envelope for `health_probe`, while the DO ledger's exact
stored-operation comparison rejects a missing result for every relay operation.
The Controller storage boundary, terminal protocol, Rust manifest validator,
and D1 contract share the same 128-character object-version maximum. A terminal
ACK may set
`final_acked_at` but never `compaction_authorized_at`. The compaction function
first checks the separately false runtime gate, and both age- and count-based
deletion additionally require both evidence fields. Tests exercise both
retention paths while the gate is false.

The Bun executable is unavailable in this shell, so `bun run check` and the
Bun-native TOML/config wrapper were not run. Changed-path behavior is covered by
Rust config assertions, TypeScript, protocol Vitest, compiled Workerd, generated
types, all three Controller Wrangler dry-runs, SQLite replay, syntax checks,
formatter, and the optimized Worker build.

Production remains blocked on deployed D1/Service Binding/version readback,
authority rotation, old-writer drain, migration 0046 enforcement, target-first
N/N-1 drills, real Container/network/R2/DO faults, alert and backlog ownership,
provider-native idempotency or lookup, full execution and financial
reconciliation, retention/archive/restore approval, load/cost evidence,
rollback, and C1-C5/G1-G8 approval. Every tracked activation and compaction gate
remains false; Go/VPS remains authoritative and production remains **NO-GO**.

## Migration 0046 Enforcement Verification (2026-07-17)

This overlay supersedes the preceding statement that migration 0046 remains
reserved. It verifies the local trigger-only enforcement boundary and its
read-only rollout audit. It does not claim a remote D1 apply, Worker deploy,
secret change, provider request, financial mutation, or traffic switch.

```powershell
python tools/verify_sqlite.py
# PASS: 46 migrations, 43 tables, 434 incremental columns, 64 key indexes.
# PASS: historical legacy/eventless rows unchanged; new legacy identity,
# direct terminal insert, event/outbox-less transition, and revision-2 without
# predecessor are rejected; an exact event plus outbox transition persists.

node tools/audit_d1_migration_config.mjs --json
# PASS: 46 contiguous migrations; local/config/runtime head is 0046.

node tools/audit_relay_container_enforcement_readiness.mjs --self-test --json
# PASS: clean pre/post fixtures and real 0001-0045/0046 SQL are snapshot-ready;
# authorizesEnforcement remains false; legacy identity, pre/post-Tdrain open
# operations, direct non-prepared insert, new legacy identity, eventless
# terminal, missing predecessor/outbox, short drain, migration drift,
# trigger-set drift, and exact trigger-body drift all block. Target binding,
# temporary account-config lifecycle, verified-UUID Wrangler arguments, local
# spawn/account/JSON envelope, strict numeric typing, success-envelope
# validation, quoted SQL literal preservation, and target UUID mismatch
# rejection also pass.

node --check tools/audit_relay_container_enforcement_readiness.mjs
cargo fmt --all --check
# PASS.

cargo test -p cinatoken-worker --lib
# PASS: 784 passed; 0 failed.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; existing default-off dead-code warnings only.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

node node_modules/vitest/vitest.mjs run --config vitest.do.config.mjs
# PASS: 1 file, 48 Workerd/D1 tests. Controlled corrupt-state, stream-failure,
# and DLQ logs are expected fault-injection evidence; suite exit code is zero.

# From crates/worker with locked wasm-bindgen and local esbuild binaries.
worker-build --release
# PASS: optimized Wasm and bundled Worker JavaScript generated successfully.
```

The self-test executes the generated audit query with Node 24 `node:sqlite`
(and `bun:sqlite` when run by Bun) against an in-memory database containing
migrations 0001-0045 and then 0001-0046. The pre query returns 45 migration rows and zero enforcement
triggers or trigger bodies; the post query returned 46 rows, four triggers, and
the four exact normalized local trigger bodies. Both queries parsed and
executed without mutation. A 46-row ledger with one expected name missing and
another duplicated was rejected by the distinct-name set check.

The CLI requires an explicit Cloudflare account ID, expected D1 UUID, candidate
version, `Tdrain` after every old owner is removed, computed drain window of at
least 86,400 seconds, phase, and lowercase SHA-256 of the signed deployment
inventory. It uses an
ephemeral Wrangler config pinned to that account, rejects a UUID mismatch, runs
the read against the verified UUID rather than re-resolving the alias, and
embeds the target account/database/environment in the report.
`snapshotReady=true` is explicitly scoped to one D1 snapshot:
the exact phase-specific migration/trigger set and trigger bodies, no open
protocol-v1 operation from either side of `Tdrain`, and zero legacy identity,
suspected direct insert, event/outbox, or revision-chain anomaly. The hash binds
the report to external evidence but
does not independently verify continuous deployed
Worker/Queue/Cron/alarm ownership or the lifecycle upper-bound calculation, so
the report always returns `authorizesEnforcement=false`.

The Worker repository's future operation schema-readiness helper requires the
0040/0041/0042/0046 migrations and all four enforcement trigger names, but it
has no production call site and is not an active runtime gate. The active
runtime capability contract expects 0046. On schema 0045, the authenticated
`/api/platform/capabilities` response must report applied count 45, latest 0045,
expected 0046, expected-applied false, set-match false, and readiness false;
this is the required default-off pre-enforcement state. After a valid 0046
apply, the same endpoint must report count 46, latest/expected 0046,
expected-applied/set-match/readiness true. It does not report trigger bodies;
those come from the readiness CLI or direct `sqlite_master` readback. All
Container operation paths remain default-off and unwired. The financial
writer's event, outbox, operation, billing, and accounting statements remain
one D1 batch; trigger evidence is defense in depth and does not replace
candidate-version or batch-contract proof.

Bun is unavailable in this shell, so the aggregate `bun run check` was not
run. Its changed-path coverage was executed through the bundled Node runtime,
Python SQLite replay, Cargo, compiled Workerd, and the optimized Worker build.
No remote command was issued. Production still requires authenticated 0045
staging apply, signed `Tdeploy`/`Tdrain` target-first inventory and continuous
old-owner absence, the computed drain, account/name/UUID/environment-bound 0046
apply/readback, atomic rollback-only negative probes, a pre-bookmark freeze of
every D1 writer, full pre/post logical-export and per-table fingerprints,
production-backend/retention-valid Time Travel evidence including the returned
undo bookmark, the exact-0046-only restore decision versus mandatory
quarantine/forward repair, controlled restoration of only pre-inventoried
non-Container writers with per-wave Container fingerprints, N/N-1 rollback
rehearsal, frozen time-derived pricing facts, durable canonical tiered
snapshots, real fault/load/cost and financial convergence, and C1-C5/G1-G8
approval. All gates remain false; Go/VPS remains authoritative and production
remains **NO-GO**.

## Migration 0047 Provider-Egress Grant Verification (2026-07-17)

This overlay supersedes the preceding runtime-head statement: the local and
runtime migration head is now
`0047_relay_container_provider_egress_grants.sql`. It verifies local code,
schema, and fail-closed protocol behavior only. It does not claim a remote D1
apply, Worker/Controller/Container deployment, secret change, provider call,
financial mutation, or traffic switch.

```powershell
cargo test -p cinatoken-billing
# PASS: 105 library + 3 flat-manifest + 10 Go-parity tests; 0 failed.

cargo test -p cinatoken-worker --lib
# PASS: 785 passed; 0 failed.

cargo test --workspace --exclude cinatoken-worker
# PASS: all non-Worker unit, integration, and doc tests.

cargo fmt --all -- --check
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS; existing default-off dead-code warnings only.

.\node_modules\.bin\tsc.exe -p services/container-controller/tsconfig.json --noEmit
# PASS.

.\node_modules\.bin\vitest.exe run --config vitest.container-controller-protocol.config.mjs
# PASS: 5 files, 65 tests.

.\node_modules\.bin\vitest.exe run --config vitest.container-controller.config.mjs
# PASS: 1 file, 27 tests.

python tools/verify_sqlite.py
# PASS: 47 migrations, 44 tables, 464 incremental columns, 66 key indexes,
# including the immutable 0047 grant authority and default-empty rollout.

node tools/audit_d1_migration_config.mjs --json
# PASS: 47 contiguous local/runtime migrations; exact head is 0047.

node tools/audit_relay_container_enforcement_readiness.mjs --self-test --json
# PASS: pre/post 0046 snapshots and every drift/negative fixture; the report
# remains read-only and never authorizes enforcement.

git diff --check
# PASS.
```

The Controller sequence is admission read, private broker readiness/version
readback, D1 grant, shard-DO one-shot dispatch, then provider POST. The grant
write and exact readback use one D1 `first-primary` session. Cloudflare defines
that option as starting on the primary and gives later session queries
sequential consistency; see the official
[D1 Database session contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession).
The implementation awaits every operation and uses bindings rather than the
Cloudflare REST API, consistent with the official
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

New tiered reservations now require a non-empty, byte-canonical serving-group
snapshot. Settlement freezes the literal request facts and evaluation instant,
rejects credentials, prompt/content persistence, structured facts,
DST-dependent timezone names, noncanonical JSON, and unsafe Unix timestamps,
and does not fall back to live request state or the current clock. Historical
empty snapshots are not upgraded and remain quarantine-only.

Bun is unavailable in this shell, so the aggregate `bun run check` was not run.
Its changed-path coverage was executed with TypeScript, both Controller Vitest
suites, Python SQLite replay, Cargo, and wasm32 compilation. No remote command
was issued. Every Container gate remains false. Actual provider usage is still
not persisted at the egress boundary or cryptographically linked to the
terminal financial event; provider-native idempotency/lookup and real
fault/load/cost evidence are also outstanding. Go/VPS remains authoritative
and production remains **NO-GO**.

## Migration 0048 Immutable Provider Usage Receipt Verification (2026-07-17)

This overlay supersedes the preceding statement that provider usage is not
persisted or linked locally. It describes the local 0048 contract and its
required release evidence. It does not claim a remote D1 apply,
Worker/Controller/Container deployment, binding or secret change, provider
request, financial mutation, or traffic switch.

The receipt verifier must lock the exact v1 constants and all 38 canonical
fields in this order:

```text
schema_version, parser_contract, normalization_contract, source, estimated,
operation_id, owner_generation, attempt_generation, provider_operation_id,
request_sha256, egress_profile, egress_worker_version_id,
provider_response_status, provider_response_sha256, provider_request_id,
provider_completed_at, usage_present, reported_usage_fields, prompt_tokens,
completion_tokens, total_tokens, cached_tokens, cache_creation_tokens,
cache_creation_tokens_5m, cache_creation_tokens_1h, image_input_tokens,
image_output_tokens, audio_input_tokens, audio_output_tokens,
is_anthropic_usage_semantic, usage_semantic_source, provider_cost_usd,
cache_creation_source, responses_web_search_calls,
responses_file_search_calls, claude_web_search_calls,
image_generation_quality, image_generation_size
```

The fixed values are schema 1, parser
`openai-chat-completions-usage-v1`, normalization
`billing-token-normalization-v1`, source `provider_response`,
`estimated=false`, and egress profile
`openai-chat-completions-canary-v1`. Tests must reject extra/reordered/missing
fields, noncanonical serialization, digest mismatch, canonical JSON over 8,192
bytes, encoded receipt over 12,288 bytes, unknown mask bits, and nonzero values
whose presence bit is clear.

The presence-mask cases cover bits 0 through 10 and maximum 2047. Prompt plus
completion, bits 0 and 1, define `usage_present`; prompt/completion without bit
2 is valid. The flat settlement test must prove a nonzero charge using the
checked prompt-plus-completion sum while the provider `total_tokens` field is
absent. A separate matrix removes each cache, cache-creation, image, or audio
bit needed by the frozen tiered expression or flat snapshot and requires a
fail-closed error; neutral/unreferenced categories remain optional. Tiered
tests also reject unversioned tool charges and non-finite/negative cost or
quota results.

The D1 replay and negative suite verifies:

- all 48 migrations apply in order and 0048 adds the receipt table, separate
  identity ledger, result-identity index, three receipt guards, three identity
  guards, terminal linkage columns/guard, and completion guard;
- exact receipt insert succeeds only against the matching immutable 0047
  grant, operation, reservation, billing snapshot digest, R2 result identity,
  and canonical receipt;
- receipt and identity updates/deletes fail, and `INSERT OR REPLACE` fails with
  `PRAGMA recursive_triggers=OFF` because the append-only identity ledger
  survives SQLite's implicit receipt delete;
- provider status 202 can be inserted as evidence but both settlement and
  completion fail; a settle with a client status different from the receipt
  provider status also fails;
- settle requires usage present, non-estimated evidence, attempt 1, exact
  receipt/result hashes, persisted-before-terminal ordering, and matching
  operation response status; refund/recovery must not carry provider linkage;
- raw negative, fractional, or greater-than-`i32::MAX` recognized token values,
  non-Anthropic `cc1h`, non-finite tiered output, and a flat `i64::MAX`
  calculator overflow sentinel fail closed;
- a true 0047 writer on schema 0048 cannot create an unlinked settle, proving
  the intentional drain-before-0048 safety boundary rather than rolling-write
  compatibility.

The Controller protocol suite must prove the operational order and each crash
boundary: pre-send 0048 schema readiness; complete egress body drain under the
same absolute upstream deadline; forced final `Cache-Control: no-store`; strict
receipt header/canonical/hash/status/body identity; R2 create-only write and
metadata-schema-4 exact replay; D1 `INSERT OR IGNORE` followed by complete
same-session readback; D1 before DO result attachment; and no provider resend
after any post-send ambiguous outcome. An R2 conflict, D1 zero-row write without
exact readback, receipt mismatch, DO attachment failure, or terminal-write loss
must not become public success.

The local release command set is:

```powershell
python tools/verify_sqlite.py
cargo test -p cinatoken-relay
cargo test -p cinatoken-container-egress
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run test:container-controller
bun run check:container-controller
cargo fmt --all -- --check
git diff --check
```

Passing these commands is local implementation evidence only. Production is
still **NO-GO** because D1 cannot independently evaluate arbitrary billing
expressions or attest final amount authority; the DO ledger does not store and
compare the receipt hash; reconciliation does not close the
R2/D1/DO/terminal/provider-invoice hash loop; no production terminal caller is
enabled; provider-native idempotency/lookup is absent; and provider completion
before the first R2 create remains an unrecoverable ambiguous window. A remote
0048 apply/readback, old-writer and in-flight-operation drain, deployed version
inventory, real fault/load/cost and financial convergence, disable-first
rollback rehearsal, and C1-C5/G1-G8 approval remain mandatory. No deploy or
secret command was run; all gates remain false and Go/VPS remains authoritative.

## Migration 0049 Provider Usage Binding Verification (2026-07-18)

This section supersedes only the 0048 local gap for DO receipt persistence and
R2/D1/DO/terminal reconciliation. It does not claim provider-invoice or remote
production proof.

The D1 replay and negative suite must prove all of the following:

- all 49 migrations apply in order, 0049 is the head, and the expanded
  observation columns, index, lifecycle replacement, authority guards,
  convergence guard, immutable-evidence guards, and late-receipt guard exist;
- an empty upgrade synthesizes no observations, while historical no-receipt
  rows retain legacy behavior;
- a receipt-backed non-terminal observation backfills exact canonical attempt,
  receipt, and result identity as `pending` without inventing DO/R2/terminal
  evidence;
- a historical receipt-backed `converged` row is preserved but marked
  `divergent`, and cannot later be rewritten to fabricated `matching` evidence;
- an old writer cannot converge a receipt-backed row, and missing R2 evidence,
  explicit divergence, a single-bit DO mismatch, or a rewritten canonical
  result all abort atomically;
- exact canonical D1, DO, R2, and terminal evidence may transition a valid
  lease directly to `converged/matching`, after which every binding field is
  immutable; and
- the full 0045 claim/retry/dead-letter/retry-apply lifecycle remains intact.

The Workerd DO tests must prove a real SQLite transaction, not only DTO logic:

- the legacy provider result RPC is rejected with or without an attempt
  generation;
- result manifest and receipt digest attach atomically to the operation and
  dispatched attempt, exact replay returns duplicate, and a changed digest or
  generation conflicts;
- an attachment failure rolls the operation update back, so retry can consume
  the already-durable D1 receipt without another provider request;
- eviction preserves the root/attempt receipt digest and attachment time;
- terminal success is impossible before attachment, while terminal history
  contains the exact receipt digest using the existing three-event journal
  range, preserving old Durable Object table checks; and
- v1 terminal ACK is rejected for a receipt-bearing operation, whereas v2 is
  accepted and idempotent only for the exact attempt/receipt/result tuple.

The Controller protocol and gateway tests must preserve byte-level
compatibility: status v1/v2 do not expose new fields; status v3 uses a distinct
signed domain and path and returns only the frozen v3 shape; ACK v1/v2 domains
and paths are isolated; unknown fields and partial binding tuples fail closed.
The provider gateway must show D1 readback before every non-prepared replay,
zero second provider calls, recovery from D1-to-DO and terminal-response loss,
and rejection of a partial DO result without its receipt digest. A concurrent
second request must observe the dispatched attempt, return non-mutating 202
while D1 is missing, leave the attempt active, and allow the first request to
complete with exactly one provider call. An `existing` dispatch has the same
non-mutating behavior. Verified D1 conflicts still terminalize as ambiguous.

Receipt persistence must prove one `first-primary` session per attempt, a read
before any insert, insert/readback only when no row exists, and a second exact
call that performs no write. Direct post-convergence receipt INSERT, including
identical `INSERT OR IGNORE`, must remain blocked by 0048/0049 guards; runtime
idempotency is the read-only replay path, not a late SQL write.

The Rust Worker tests must cover exact v3 decoding, all-null historical v3
success, and v2/v1 fallback. A receipt-backed D1 terminal may never converge
through null v3 fields or fallback. The observer
must validate canonical D1 receipt identity, compare DO status v3, perform an
R2 HEAD requiring metadata schema 4 and exact object version/checksum/size/
content type/custom metadata, and compare the terminal tuple. Missing,
unavailable, and divergent cases remain non-converged. Terminal outbox tests
must serialize ACK v2 binding from the immutable D1 receipt and reject partial
receipt/result/attempt identity.

Reconciliation readiness must first pass the complete 0047/0048 provider
egress schema check, then require the 0049 columns, index, ten binding guards,
and the rebuilt lifecycle trigger whose SQL still references the audited 0045
retry-event table.

The local release command set is:

```powershell
python tools/verify_sqlite.py
npx.cmd --yes bun run check:container-controller
cargo fmt --all --check
cargo test -p cinatoken-worker --lib
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
npx.cmd --yes bun run check
git diff --check
```

Passing local tests closes only the implementation-level four-store hash loop.
Production remains **NO-GO** until a remote 0049 apply/readback and writer
inventory, deployed N/N-1 isolation, real R2/D1/DO/outbox faults, provider
invoice reconciliation, provider-native idempotency or lookup, independent D1
amount authority, load/cost/alerts, disable-first rollback rehearsal, and
C1-C5/G1-G8 approvals are archived. Provider completion before the first R2
create remains ambiguous. No deploy, binding, secret, provider, financial, or
traffic mutation is part of this verification entry.

## Default-Off Edge-to-Shard Chat Canary Verification (2026-07-18)

This verification entry covers the local orchestration foundation only. It
must not be used as evidence that a client canary, Container deployment, D1
migration, secret, provider request, settlement, or traffic switch occurred.

Current Rust unit/static evidence covers the tracked false gates, strict cohort
parser, HMAC identity, dispatch-action mapping, recovery generation, D1 quote
and receipt-readback transition, and CORS header construction. The following
is the complete acceptance list; route-level Worker, Controller, real DO
lifecycle, remote, and fault items remain pending unless their separate command
and archived artifact are present:

- all tracked scheduler/operation/canary gates are false and the token/model/
  channel cohort is empty;
- `container_chat_canary_admission_compiled()` is false and participates in
  operation readiness, independently of environment flags;
- exact route/auth/non-stream scope exits before cohort parsing, so malformed
  config cannot return 503 on unrelated relay endpoints;
- token IDs are positive, canonical, bounded and unique; duplicate/empty/
  leading-zero forms fail closed;
- HMAC identities are deterministic and tenant-scoped, while request changes
  under one idempotency identity produce a 409 lookup conflict;
- dispatch CAS `Applied` maps to one send, `AlreadyDispatched` maps to query
  only, and a prepared operation re-enters through the same CAS;
- recovery owner generation advances exactly once;
- status v3, attempt 1, receipt/result identity, immutable settlement quote,
  R2 metadata/body, financial terminal readback and exact replay must all
  converge before a client success; and
- CORS permits `Idempotency-Key` without persisting CORS headers in the replay
  artifact.

The local command set is:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run check:container-scheduler-config
bun run check:container-controller
bun run check:do-lifecycle-runtime
python tools/verify_sqlite.py
bun run check
git diff --check
```

The focused commands above do not imply a live `RelayShardContainer`. That
requires an explicit Workerd/remote fixture executing the actual class across
eviction/restart and a provider-call counter. Route isolation and wildcard/
allowlisted CORS also require request-level Worker tests; the pure Rust tests
alone are not that evidence. On a shell without a direct Bun executable, use
the repository's existing `npx.cmd --yes bun run <script>` wrapper.

Before the hard admission gate can change, migration 0050 or an equivalent
schema-proven transaction must demonstrate crash injection before, during and
after quota debit, reservation insert, selected-attempt bind, operation insert,
and response readback. Every retry must classify as no state, matching
resumable state, terminal replay, or immutable conflict, with no second debit
and no provider send before a unique `Applied` dispatch CAS.

Separate required suites must then prove an autonomous reconciler terminalizes
completion without a client, source-parity handling of 200-error and non-2xx
responses, real `RelayShardContainer` eviction/restart, N/N-1 or blue/green
rollout, provider idempotency/lookup, and remote D1/R2/DO/provider fault and
financial convergence. Local pass status leaves Go/VPS authoritative and
production **NO-GO**.

## Migration 0051 Scheduled Terminalization Verification (2026-07-18)

This entry replaces the prior statement that autonomous terminalization is
entirely unimplemented. It records a local owner-fenced candidate only. It is
not evidence of a remote D1 apply, enabled schedule, deployed Worker/Controller/
DO/Container, provider request, financial mutation, alarm execution, or traffic
cutover.

### Contract under test

The verification target is deliberately narrow:

- both `CONTAINER_SCHEDULED_TERMINALIZER_ENABLED` and
  `CONTAINER_SCHEDULED_TERMINALIZER_STAGING_VERIFIED` are exact booleans,
  default false in every tracked scope, and both are required;
- runtime readiness additionally requires existing operation replay authority,
  `FILE_BUCKET`, observer compilation, the exact 0051 table/index/three-trigger
  schema, and a live pre-claim Controller probe proving
  probe/binding/authority/verified/controller/execution readiness;
- only D1 `dispatched` or `recovery_required` plus Controller exact
  `Completed`/`DefinitiveTerminal` under status v3, with no v1/v2 fallback,
  yields a terminal outcome;
- the path performs no dispatch, wake, provider send, retry, automatic refund,
  or mutable-price evaluation;
- status-v3 provider receipt/result, R2 artifact, frozen 0050 admission,
  reservation, operation and quote must converge, and a result manifest above
  the 4 MiB replay ceiling must fail before body buffering;
- terminal event, outbox, accounting, operation, reservation and 0051 evidence
  are one D1 batch; and
- claim owner/generation, attempt count, exact frozen lease expiry,
  lease/recovery horizon against D1 transaction-time `unixepoch()`,
  reconciliation revision and all terminal hashes are exact and immutable;
- client and scheduler use one reservation-derived financial audit schema v2,
  with frozen `request_id_hash` and no current request ID/CF Ray or client IP;
  and
- terminalizer errors retain exact class/code: unavailable or missing evidence
  retries within the horizon, while divergence, contract violation and
  conflicting financial decisions dead-letter immediately.

### Confirmed local evidence

For the exact local release candidate:

- `python tools/verify_sqlite.py` passes the 51-migration chain and reports 49
  tables, 557 incremental columns, and 73 key indexes. Its isolated 0051
  fixture rejects stale Worker time against D1's clock, wrong frozen expiry,
  expired lease, stale owner, forged result, update and delete, and accepts the
  exact live owner once;
- `bun run check:d1:migration-config` reports 51 contiguous migrations with
  exact head `0051_relay_container_scheduled_terminalization.sql`;
- `cargo test -p cinatoken-worker --lib` passes 827/827;
- `bun run check:do-lifecycle-runtime` passes 48/48, including the complete
  0051 commit, readback, replay, stale-owner, and wrong-frozen-expiry cases;
- `bun run test:relay-container-atomic-admission:runtime` passes 15/15 and
  `bun run check:container-scheduler-config` passes 4/4; and
- workspace tests, the Worker wasm32 check, formatting, `git diff --check`, and
  the repository-wide `bun run check` aggregate pass. The aggregate also
  rebuilds and verifies the Controller, Workerd/DO, frontend, migrations,
  SQLite chain, route ownership, redaction, bundle budgets, and tracked
  Wrangler dry-runs. Only the existing default-off/dead-code warning class is
  emitted.

These commands were rerun after implementation edits stopped. They remain the
required local release gate after any later implementation change; a pass from
this candidate does not transfer to a later candidate.

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run test:relay-container-atomic-admission:runtime
bun run check:container-scheduler-config
bun run check:do-lifecycle-runtime
bun run check:d1:migration-config
python tools/verify_sqlite.py
bun run check
git diff --check
```

The focused Workerd terminalization case proves a stale claim or wrong frozen
expiry on the final 0051 statement rolls back terminal event, outbox, all
accounting, operation and reservation changes; the live owner then commits
every statement exactly once; readback is exact; repeat, update and delete
fail. Rust tests cover both new gate truth tables, missing
replay/binding/schema/controller-probe prerequisites, exact status-v3
eligibility, pre-body size rejection, path-independent audit identity, and
transient/permanent terminal failure routing.

### Required staging fault matrix

| Fault | Required result and archived evidence |
| --- | --- |
| One terminalizer gate true | No mutation; capability distinguishes requested, staging-verified, enabled, schema-ready and runtime-ready |
| Missing replay authority, R2, 0051 schema, or any Controller probe/binding/authority/verified/controller/execution field | Readiness false before item claim and zero Controller terminalization/financial activity |
| Claimed/running/failed/recovery/matching/conflicting/missing Controller state | Observation/retry/quarantine only; zero provider and financial delta |
| Stale owner, wrong generation, wrong frozen expiry, stale Worker timestamp, D1-clock-expired lease/recovery horizon | Exact 0051 rejection and full D1 batch rollback |
| Failure at each D1 statement | No partial event/outbox/accounting/operation/reservation/evidence; unchanged table fingerprints |
| R2 client artifact created, D1 fails | Object classified as non-authoritative orphan; no settlement inferred; bounded retention/cleanup evidence |
| D1 commit response lost | One immutable 0051/terminal winner, exact readback/replay, no second accounting or provider call |
| Client retry versus scheduled replay | Same reservation-derived audit schema-v2 digest; current request ID/CF Ray and client IP cannot change the terminal decision |
| Result manifest above 4 MiB | Permanent contract failure before R2 body read/buffer, no settlement, bounded Worker memory |
| Missing/unavailable versus divergent/contract/decision conflict | Missing/unavailable evidence follows bounded retry; permanent classes keep exact error codes and immediately dead-letter; zero provider/financial delta |
| Duplicate Cron/alarm and lease reclaim | Same winner or safe retry/quarantine; no resend, refund, or duplicate terminal decision |
| DO eviction/cold start and Container sleep/restart/OOM | Durable state reconstruction, exact object/class/schema/alarm identity, no memory-only authority |
| N/N-1 and rollback | Version N reads N/N-1 object/alarm state; N-1 never handles N-only intent; incompatible state fails before provider/financial I/O |
| Jurisdiction/object mismatch | Fail closed with no alternate object creation or silent relocation |
| Cross-layer provenance gap | Candidate rejected; no promotion until edge/Controller/DO/Container/broker/provider/D1/R2/billing/0051 tuple is complete |

Remote schema evidence must include target account, database name/UUID,
Time Travel bookmark, migration hash/ledger, normalized table/index/trigger
bodies, full-table counts/hashes/high-watermarks before and after every negative
probe, and the exact deployment/binding/image/class/migration identifiers.
Evidence excludes credentials, raw idempotency values, tenant/user/token IDs,
prompt/response bodies, and provider secrets.

The cinaVibeSDK-derived lifecycle proof remains pending: stable logical-shard
object identity plus a separately approved jurisdiction, one frozen mutually
exclusive class-lifecycle mode (`exports` or retained legacy migrations) with
old-object drain, bounded idempotent cold start, a versioned application intent
using the `Container` base class's single alarm/schedule owner, N/N-1 ABI, and
redacted cross-layer provenance. Provider-native idempotency/lookup,
provider-response-before-R2
ambiguity, shared non-2xx semantics, independent amount authority and invoice
convergence, orphan policy, load/cost/SLO/alerts, rollback rehearsal, security
review and C1-C5/G1-G8 approvals also remain open.

Rollback verification must first read back both new gates false, then drain or
expire leases, preserve 0050/0051 and all immutable evidence, keep a compatible
recovery reader, and route new traffic to Go/VPS. Schema rollback, evidence
deletion, provider resend, ad hoc quota compensation, unversioned class rename,
and moving an existing object across jurisdiction are forbidden. Production
remains **NO-GO**.

## RelayShardContainer Durable Alarm Intent v1 Verification (2026-07-18)

This entry covers local source, configuration, pure ABI, and Workerd SQLite
evidence. It does not claim an actual `RelayShardContainer` base alarm, Linux
Container process, remote Durable Object, D1 migration, deployment, provider
request, financial mutation, secret change, or traffic switch. The intent
schema is DO-local; global D1 remains at migration 0051 and no 0052 was added.
The runtime identity remains one canonical
`cinatoken-relay-shard-v1-XXXX` DO/Container per logical shard; tenant HMAC
selects that shard and is never part of the object name. Jurisdiction remains a
future pre-ID subnamespace decision.

Confirmed focused commands:

```powershell
bunx tsc -p services/container-controller/tsconfig.json --noEmit
# PASS.

bun run test:container-controller
# PASS: 95 tests across 7 files.

bun run test:container-controller:runtime
# PASS: 1 file, 34 Workerd SQLite tests.
```

The evidence covers:

- exact legacy three-field v0 and strict v1 payload parsing, unknown-field and
  future-version rejection, canonical shard validation, and deterministic
  bounded retry timing;
- immutable DO-local schema migration rows 1/2 and exact readback;
- rejection of unknown future schema rows, direct intent deletion/replacement,
  and invalid delivery-generation/count relationships;
- one SQLite transaction for operation claim plus initial unarmed intent;
- persistence across `evictDurableObject`, armed readback, early delivery with
  generation advance, stale-generation no-op, due terminalization, duplicate
  terminal replay, and normal completion before alarm;
- current-generation shard mismatch quarantine without operation mutation;
- retry exhaustion at delivery eight with no provider-attempt,
  provider-retry-state, or terminal-ack rows; and
- all local/staging/production Controller configurations keeping both v1 writer
  gates exact `false`, while source retains an ungated v0/v1 reader and rearm;
  execution is rejected before claim and readiness is false if either writer
  gate is not exact `true`, with no new legacy-v0 writer path; and
- callback persistence/reschedule failures and legacy callback persistence
  failure invoke `ctx.abort()` instead of returning into one-shot cleanup.

The actual Container-derived class is not instantiated by this Workerd fixture.
Before either writer gate changes, isolated staging must prove package-0.3.7
alarm multiplexing, callback exception deletion, schedule/armed response loss,
real cold start/eviction/sleep/restart/OOM, provider and financial counters,
N/N-1 or blue/green reader-first rollout, jurisdiction mismatch, load/cost/SLO,
alerts, and disable-first rollback. The application must not override
`alarm()` or call `setAlarm` beside the `Container` base class.

The next implementation verification packet must compare the Go and Rust
response interpreters for exact HTTP-200 success, typed error bodies carried by
HTTP 200, non-200 compatible error envelopes and header filtering, and usage
retained across interrupted streams. Production remains **NO-GO**.

## 2026-07-18 Response Interpreter Verification Contract

The candidate verification packet is source-bound to Go commit
`73652508abc5cb09214dde02d51d69d1d1ccc703` and interpreter contract
`go-openai-response-v1`. Local acceptance requires all of the following:

```powershell
bun tools/generate_go_response_interpreter_manifest.mjs --check
bun tools/generate_go_response_interpreter_manifest.mjs --verify-artifact --json
cargo test -p cinatoken-relay
cargo test -p cinatoken-container-egress
cargo test -p cinatoken-worker --lib
cargo check -p cinatoken-container-egress --target wasm32-unknown-unknown
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
```

The immutable corpus must prove exact 200 versus every other 2xx, HTTP-200
typed object/string/scalar/message-only errors, malformed/empty/array bodies,
non-200 message precedence, error-header suppression, the six-header success
allowlist, usage parsing, and usage retained before stream interruption. It must
also verify source/template/script hashes, unique case names, exact counts, and
the canonical manifest digest.

Thin Worker and Container tests must show that each adapter consumes the shared
facts without changing classification, client status, error body, header
decision, usage, or raw hash. Container non-success remains recovery/ambiguous
until response-artifact protocol v3 and migration 0052 exist; this is the
required fail-closed result, not a canary pass. No remote verification is
authorized by this packet.

The 2026-07-18 local run passed with manifest digest
`3384f8ec568e082fd2b95ea300df80379d926b4f607cd1d9d80e78f51a8b789a`
and class counts `4/3/3/17` for success/typed-error/invalid-body/HTTP-error.
Relay ran 102 unit plus 2 manifest tests, Container egress ran 13 tests, Worker
ran 833 tests, both wasm checks passed, and `bun run check` completed
successfully. The source replay left its explicit Go roots clean and removed
the injected test. These are local results only; remote evidence remains open.

## 2026-07-18 Response Artifact Evidence P2 Verification

This entry supersedes the point-in-time statements above that global D1 ends at
0051 or that migration 0052 is absent. The local candidate now has 52
contiguous D1 migrations with exact head
`0052_relay_container_provider_response_artifacts.sql`. This packet changes no
Cloudflare resource, secret, deployment, provider request, financial record, or
traffic. Production remains **NO-GO**.

The migration and runtime contract prove all of the following:

- a persistent `response_artifact_contract` marker fences every new protocol-v1
  chat canary operation after migration, so an N-1 writer cannot arrive after
  the one-time drain and create an unmarked operation;
- provider raw evidence and client response artifacts use separate immutable
  D1 tables, identity ledgers, R2 namespaces, keys, content rules, and
  create-only replay checks;
- provider, client, inventory-cursor, and inventory-finding identity ledgers
  reject direct `INSERT OR REPLACE` conflict attempts even with
  `PRAGMA recursive_triggers = OFF`, while the original row and identity remain
  byte-for-byte unchanged;
- readiness checks the nullable provider content-type column, the operation
  writer-contract column, every required table/index/trigger, and exact foreign
  key targets and update/delete actions;
- the Controller accepts response-artifact grants only for owner generation 2,
  attempt generation 1, egress profile
  `openai-chat-completions-canary-v1`, and canonical client
  `application/json`; both artifact bodies are bounded at 4 MiB and R2 writes
  use create-only conditions with exact replay/conflict classification; and
- inventory cursors and findings are append-only, observe-only, and retain
  hard-zero apply/delete authority.

Independent review also confirmed two intentional next-phase interlocks. The
pre-P3/P4 operation and terminal shapes cannot terminalize an HTTP-200 typed
error, and a success without an immutable provider usage receipt cannot settle.
Non-200 2xx/3xx responses likewise have no approved terminal shape. The SQLite
verifier asserts these attempts fail with unchanged financial and operation
state; protocol-v3 parsing and the new terminal contract must land before any
writer gate can be enabled.

Confirmed local commands and results after implementation edits stopped:

```powershell
python tools/verify_sqlite.py
# PASS: 52 migrations, 57 tables, 667 incremental columns, 80 key indexes.

bun run check:d1:migration-config
# PASS: 52 contiguous migrations; exact head 0052.

bun run check:container-controller
# PASS: 103 Bun tests / 877 expectations, 90 protocol tests,
# and 34 Workerd storage tests.

bun run check:do-lifecycle-runtime
# PASS: 48/48, including fresh 0052 readiness.

bun run test:relay-container-atomic-admission:runtime
# PASS: 15/15. Current writers carry the marker; the N-1 writer is rejected.

cargo test -p cinatoken-worker --lib
# PASS: 833/833.

bun run check
# PASS: the complete repository aggregate, including both wasm checks,
# workspace tests, frontend, migration/config audits, Workerd suites,
# bundle budgets, and tracked Wrangler local dry-runs.

cargo fmt --all -- --check
git diff --check
```

Only the existing default-off/dead-code warning class is emitted. No remote
Cloudflare command was run. P3 must now implement the exact response-artifact
protocol-v3 envelope, parser, Durable Object schema migration 3, durable
provider/client artifact state, and fail-closed runtime rejection matrix; P4
then owns the new financial terminal shapes and replay proof.

## 2026-07-18 Financial Terminal P4 Verification

This packet supersedes the statement above that P4 remains unimplemented. P4
is a local, disabled candidate; it changes no remote Cloudflare, provider,
financial, secret, deployment, or traffic state.

The verification matrix proves:

- D1 migration 0053 drains incompatible work, requires the v2 terminal
  contract for response-bound generation-2 operations, and rejects downgrade,
  contradictory evidence, receipt-free settlement, response-bound recovery,
  request accounting on refund, and conflicting replay;
- exact success settles once, while typed, HTTP, and invalid-body rejection
  refunds once and preserves its exact client replay status;
- status v4 is an atomic operation/attempt/provider/client snapshot;
- ACK v3 is exact and response-bound for final success/reject, while unbound
  recovery remains ACK v2;
- raw R2 readback checks exact object identity, metadata, and bounded body hash
  before convergence; and
- scheduled terminalization, reconciliation, outbox delivery, replay, and
  readiness remain generation-fenced and fail closed.

Confirmed final local commands and results:

```powershell
python tools/verify_sqlite.py
# PASS: 53 migrations, 57 tables, 674 incremental columns, 81 key indexes.

cargo test -p cinatoken-worker --lib
# PASS: 837/837.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS.

bun run check
# PASS: full repository aggregate, including Controller 192 Bun tests,
# 176 portable protocol tests, 45 runtime tests, DO lifecycle 48/48,
# atomic admission 15/15, frontend 71 tests, both wasm checks,
# migration/config audits, bundle gates, Wrangler dry-runs, and workspace tests.

cargo fmt --all -- --check
git diff --check
```

Every tracked response rollout gate remains exact `false`. P5 must provide the
authenticated remote 0053/R2/DO/Container proof, mixed-version rollout,
response-loss and crash campaign, load/cost/SLO/alert evidence, retention and
privacy review, rollback rehearsal, and signed approvals. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-19 P5 Evidence Verifier Verification

The local packet verifier adds no remote evidence and cannot authorize traffic.
It proves that a future packet cannot omit or mix candidate, schema, lifecycle,
financial, provenance, load, rollback, security, or approval facts.

```powershell
bun run plan:relay-container:p5-evidence
# PASS: reports ten evidence kinds, five approval roles, no network/credentials,
# and false remote/customer/production authority.

bun run check:relay-container:p5-evidence
# PASS: 38/38 contract and adversarial tests.

bun test tests/container-controller-config.test.mjs
# PASS: 12/12, including exact edge/Controller D1/KV/R2/service identities.

bun run check:container-controller:deploy-preflight
# PASS: 4/4 bounded-subprocess and 18/18 deploy-preflight tests plus a
# credential-free tracked-staging self-test; it is explicitly not deploy-ready.
```

Negative coverage includes canonical encoding, byte/hash/candidate drift,
customer scope, freshness/expiry, reader-before-writer order, lifecycle and
provenance completeness, duplicate provider/financial effects, financial
terminal conservation, refund request accounting, load thresholds,
disable-first rollback, bundle path and symlink confinement, external trust
root, distinct public-key material, nonelapsed cohort windows, total timestamp
ordering, and complete fresh role-correct signatures with increasing validity
windows. File reads use one handle with before/after identity, size, and
timestamp checks.

No real evidence bundle, trust policy, private key, Cloudflare credential,
remote readback, deployment, provider call, financial mutation, or traffic
change was used. The final full repository verification passed after this local
increment. Production remains **NO-GO**.

## P5 Foundation Collector And Go/VPS Cutover Evidence (2026-07-19)

Focused verification after adding the production evidence foundation:

```powershell
bun run check:relay-container:p5-foundation
# PASS: 14/14 tests, 217 expectations, then the offline self-test.
# Self-test: 13 read-only Wrangler commands; mutation rejected; no credential,
# network, file write, customer traffic, P5, or production authority.

bun run check:go-vps-cutover:evidence
# PASS: 23/23 tests, 77 expectations.

bun run plan:go-vps-cutover:evidence
# PASS: eight evidence kinds; decisions are not-proven or
# eligible-for-production-cutover-review; authorization is hard false.

bun run plan:relay-container:p5-evidence
# PASS: shared foundation capture, complete pagination, and bounded observation
# are required; remote/customer/production authority is hard false.

bun run check:container-controller:deploy-preflight
# PASS: 22/22 combined security/preflight tests and offline self-test.
```

Foundation collector negatives cover production requests, request/candidate
digest drift, mutating Wrangler operations, token reflection, parent-environment
inheritance, 100-item incomplete Container pages, absent shard/R2/traffic/SBOM
sources, before/after drift, unknown writers, customer traffic, unknown source
status, and source timestamps outside the observation. The emitted capture
contains no token, raw account/KV/Container application identity, raw Wrangler
response, payload, or secret value.

Go/VPS negatives cover unpinned binaries, candidate/cohort/file digest drift,
path escape and symlink files, oversized/noncanonical/invalid evidence,
non-zero protocol/process/batch state, too few flushes, SQL/LOG_DB drift,
duplicate scheduler owners, forward lag/reverse conflict, incomplete pending
handoff, incomplete rollback, stale/future timestamps, payload/secret fields,
and any unknown/not-applicable status. The verifier has no process, network,
environment-value, SQL, or write capability.

No live Cloudflare readback or Go/VPS packet was used. The final `bun run check`
passed with P5 evidence 38/38, foundation collector 14/14, Go/VPS evidence
23/23, deploy preflight 22/22, Controller 192/192, portable protocol 176/176,
Workerd runtime 45/45, DO lifecycle 48/48, Worker Rust unit tests 837/837, and
the workspace and wasm checks. Production remains **NO-GO**.

## P5 Shard Activation And Foundation Binding (2026-07-19)

This tranche supersedes the P5 and foundation counts above. It remains a local,
default-off evidence implementation and grants no remote, customer-traffic, or
production authority.

The implementation now proves that:

- D1 migration 0054 provides an immutable, append-only shard activation ledger;
  the Controller checks the exact table, column, index, constraint, and trigger
  catalog before the first primary insert, including a real SQLite catalog test;
- runtime executable identity is hashed with bounded streaming reads, cached by
  immutable file identity, and prewarmed at startup; unreadable identity returns
  a typed 503 instead of panicking or executing;
- the shard registry collector accepts only the fixed staging Controller origin,
  bounded streamed responses, generation 1, fresh complete activation rows, and
  complete pagination;
- the foundation collector binds canonical collector source digests, bounded
  source artifacts, before/after readback stability, and the exact shard
  activation facts; and
- P5 promotion manifest v2 signs the actual canonical
  `evidence/foundation-capture.json` file by path, bytes, and SHA-256, then
  recomputes and compares its candidate and evidence facts.

Confirmed final local commands and results:

```powershell
bun run check:relay-container:p5-evidence
# PASS: 44/44 tests, 55 expectations.

bun run check:relay-container:p5-foundation
# PASS: 16/16 tests, 231 expectations, then the offline self-test.

bun run check:relay-container:p5-shard-registry
# PASS: 13/13 shard/campaign collector tests, 61 expectations.

bun run check:container-controller
# PASS: 210 Bun tests with 1433 expectations, 176 portable protocol tests,
# and 45 Workerd runtime tests.

python tools/verify_sqlite.py
# PASS: 55 migrations, 62 tables, 771 incremental columns, 91 key indexes.

bun tools/audit_d1_migration_config.mjs
# PASS: 3 bindings and 55 contiguous migrations through 0055.

cargo test -p cinatoken-worker --lib
# PASS: 850/850.

cargo test --workspace --exclude cinatoken-worker
# PASS, including Container runtime 13 unit tests and 7 HTTP tests.

cargo check -p cinatoken-worker --target wasm32-unknown-unknown
# PASS.

bun run check
# PASS: the complete repository aggregate, including all results above,
# frontend 71/71, DO lifecycle 48/48, Cloudflare dry-runs, workspace tests,
# migration/config audits, and all configured wasm checks.

cargo fmt --all -- --check
git diff --check
```

No Cloudflare credential, remote mutation, deployment, D1 migration, Container
wake, provider call, financial mutation, or traffic change was used. The local
root-authorized, one-time, candidate-bound campaign now closes the static-toggle
version gap, but it has not been applied or exercised remotely. Complete
Cloudflare control-plane pagination, remote schema/business fingerprints,
rotated credentials, fresh evidence, and signed approvals remain mandatory.
Go/VPS remains authoritative and production remains **NO-GO**.

## Migration 0055 One-Time Activation Verification (2026-07-19)

This section supersedes the implementation blocker above. The campaign exists
locally, but no remote campaign evidence exists.

The local gate must prove all of these contracts together:

- exact 0055 schema head: 55 migrations, 62 tables, 771 checked incremental
  columns, 91 key indexes, four campaign tables, one expiry view, eight indexes,
  and fourteen triggers;
- root creation requires root plus step-up, all 22 Controller gates false,
  exact candidate/ring/foundation bindings, bounded lifetime, and nonce-free
  logs/audit;
- D1 claim source order precedes every DO lookup; the raw nonce is absent from
  `readinessProbeV2`; completed consumption selects replay-only mode;
- DO schema migration v6 preserves exact canonical result JSON/hash, marks
  expired started rows ambiguous, retains terminal evidence for at least two
  hours, and never issues a second wake;
- final D1 consumption writes one matching 0054 row and seals only at N/N;
- root status recomputes activation and consumption hashes and validates the
  final seal pointer before returning receipts;
- ordinary root readiness probe/wake requests remain static-gated while a
  strict campaign credential is the only bypass; and
- shard capture v2/foundation sources v3 require a stable sealed campaign,
  exact receipt coverage, and one-to-one 0054 evidence.

Run the supported local commands, not a direct `bun test` of the Workerd file:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-worker --lib --no-fail-fast
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bunx tsc -p services/container-controller/tsconfig.json --noEmit
bun run test:container-controller
bun run test:container-controller:protocol-portable
bun run test:container-controller:runtime
bun run verify:sqlite
bun run check:relay-container:p5-shard-registry
bun run check:relay-container:p5-foundation
bun run check:relay-container:p5-evidence
bun run check
git diff --check
```

The Workerd runtime entrypoint is the repository Vitest script because it
provides the `cloudflare:workers` environment and Durable Object eviction
harness. A plain Bun test invocation is not an equivalent runtime check.

Any failed command, schema-count drift, second wake, ambiguous replay, receipt
hash mismatch, non-complete seal, static-gate bypass without a valid campaign,
or P5 source mismatch blocks promotion. Local pass results still cannot prove
credential rotation, remote schema state, deployed version/image identity,
live N/N consumption, all-page Cloudflare inventory, customer isolation, owner
approval, or Go/VPS drain. Production remains **NO-GO**.

## Cloudflare All-Page Readback Verification (2026-07-19)

This increment supersedes only the preceding statement that the Cloudflare
all-page reader is locally absent. Foundation collector version 4 uses a fixed
direct API GET allowlist and still grants no remote, customer, P5, or production
authority.

Focused verification completed as follows:

```powershell
bun run check:relay-container:p5-foundation
# PASS: 24/24 tests, 267 expectations, then the offline self-test.
# Self-test: 13 credential-free read requests; non-GET rejected; no credential,
# network, file write, customer traffic, P5, or production authority.

bun run check:relay-container:p5-evidence
# PASS: 44/44 tests, 55 expectations.

bun run check:relay-container:p5-shard-registry
# PASS: 13/13 tests, 61 expectations.

bun run check
# PASS: complete aggregate with exit code 0, including Worker 850/850,
# DO lifecycle 48/48, frontend contracts 71/71, Wrangler dry-run, wasm builds,
# workspace tests, migration/config audits, and bundle redaction/budget gates.
```

The new coverage proves exact API origin/account/path/query classification,
Authorization-only token injection, redirect and envelope rejection, 60-second
header/body plus five-minute whole-readback timeout scope, fatal UTF-8, 4 MiB
streamed page and 16 MiB aggregate bounds, strict KV page totals, explicit-null
Container token termination, duplicate/loop/page-limit/drift rejection,
single-response pagination rejection, endpoint-specific object schemas, first-
active Worker deployment at 100%, nonempty current Container deployment image
binding, parsed Unicode-escaped token-reflection failure, and strict 13-record
readback digest validation. No authenticated API request was made.

Remote staging must still rotate the exposed credential, prove the replacement
token's exact permissions, apply/read back 0055, deploy the frozen candidate,
complete and seal the N/N campaign, capture identical before/after inventory
and all sources-v3 evidence, run P5 faults/load/cost/SLO/rollback, collect five
signatures, and complete the Go/VPS drain. Production remains **NO-GO**.

## Edge Version And Linux Container Release Gate (2026-07-19)

Focused local verification for the release-control increment:

```powershell
bun test tests/container-runtime-linux-gate.test.mjs tests/container-controller-config.test.mjs
# PASS: 18/18 tests, 273 expectations.

bun run check:container-runtime:linux-contract
# PASS: 5/5 tests, 42 expectations, followed by the Node offline self-test.
# Report: contract v1 passed; base/action pins and credential-free workflow
# passed; remote/customer/production authority all false.

node --check tools/verify_container_runtime_linux.mjs
node --check tests/fixtures/container-runtime-linux-mock.mjs
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
git diff --check
# PASS.

bun run check
# PASS: complete repository aggregate with exit code 0, including the Linux
# contract 5/5 (42 expectations), Controller 211/211 (1441 expectations),
# portable protocol 176/176, Workerd runtime 45/45, deploy preflight 22/22
# (93 expectations), DO lifecycle 48/48, frontend contracts 71/71, P5 evidence
# 44/44 (55 expectations), foundation 24/24 (267 expectations), shard campaign
# 13/13 (61 expectations), Worker Rust unit tests 850/850, workspace tests,
# migration/config audits, Wrangler dry-runs, and all configured wasm checks.
```

The local self-test reads only tracked source/configuration. It neither invokes
Docker nor reads an environment credential. It proves exact base-image and
checkout pins, non-root entrypoint, credential-free workflow, internal-network
confinement, fixed aliases, offline aggregate placement, and hard-false remote/
traffic/cutover authority.

The real command is deliberately separate:

```powershell
docker build --platform linux/amd64 --tag cinatoken-container-runtime:linux-gate --file crates/container-runtime/Dockerfile .
node tools/verify_container_runtime_linux.mjs --image cinatoken-container-runtime:linux-gate --json
```

It is executed by `.github/workflows/container-runtime-linux.yml` on a Linux
x64 runner. It was not run in this Windows workspace because no Docker, Podman
or WSL engine is available. Therefore this section does not claim a successful
native image build or process run. A retained green CI result for the exact
candidate is still required, followed by Cloudflare image/version provenance,
remote lifecycle/fault/P5 evidence and Go/VPS drain. Production remains
**NO-GO**.

## Linux Gate First Remote Failure And Isolation Fix (2026-07-19)

The first exact-candidate GitHub run, [29675418915](https://github.com/cinagroup/cinatoken-rust/actions/runs/29675418915),
is retained as failed evidence rather than counted as a release pass. Commit
`16fd13b63832562aaf6399fb426a871b829fcdff` passed checkout, the credential-free
contract, and the real `linux/amd64` image build. Its process step then failed
at `docker port`; no runtime scenario completed.

The replacement contract publishes no host port. The digest-pinned mock owns a
mounted read-only probe and executes it with `docker exec` inside the same
`--internal` network as the runtime. The probe reaches the mock only over its
container loopback listener and reaches the runtime through the fixed
`runtime.cinatoken.internal` alias. It still proves the complete health,
success, ambiguity, input-integrity and restart sequence. The workflow also
pins current `actions/checkout` v7 to full commit
`9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` and disables credential
persistence.

Focused local evidence after the fix is 18/18 tests with 273 expectations; the
standalone Linux contract is 5/5 with 42 expectations and reports
`inNetworkProbe=true`, `hostPortsPublished=false`, and false remote/customer/
production authority. These results fix the test design but do not convert the
failed remote run into a pass. A new retained green run for the exact candidate
is mandatory. Production remains **NO-GO**.

## Linux Gate Native Green Closure (2026-07-22)

The first isolation-fix candidate, [run 29884596667](https://github.com/cinagroup/cinatoken-rust/actions/runs/29884596667)
for commit `a67afa164a644e3f66e12fc7d8e97e89a59c8a0f`, again passed checkout, the
offline contract, and the real `linux/amd64` image build. Its process step then
failed at `docker exec`. The retained log exposed a test-network mismatch: the
runtime's fixed internal HTTP contracts use default port 80, while the mock
still listened on port 9090 after host publication was removed.

Commit `20908f8282876d08046d55967e42eddf00015934` aligned the mock with the
production contract on internal port 80, explicitly set the mock network
namespace's unprivileged-port threshold, retained the non-root user and dropped
capabilities, and added bounded ASCII-only subprocess diagnostics. Exact
[run 29885010523](https://github.com/cinagroup/cinatoken-rust/actions/runs/29885010523)
then passed every `linux-amd64-e2e` step.

The native report proves `amd64`, `nonroot:nonroot`, runtime build ID
`dcda452174385d048e8b25f1f9cf0dcb762b0c02b90462022802d62829b1d824`,
health/readiness, one-attempt provider success, ambiguous no-retry, input hash
failure before provider dispatch, zero-exit SIGTERM, and stable same-image
restart identity. It also reports `inNetworkProbe=true`,
`hostPortsPublished=false`, and false remote/customer/production authority.

This closes the native Linux process evidence gap for that exact candidate. It
does not prove Cloudflare Container lifecycle, deployed image provenance,
remote D1 migrations, paid streaming durability, P5 campaigns, traffic drain,
or production readiness. Production remains **NO-GO**.

## Ordinary HTTP SSE Durable Handoff Verification (2026-07-22)

The local candidate adds migration 0056 and a real-D1 Workerd lifecycle case.
The exact-set SQLite verifier must report 56 migrations, 64 tables, 814 checked
incremental columns, and 94 key indexes. The migration test covers both 0056
tables, three indexes, eleven triggers, monotonic usage, immutable event
identity, exact receipt prerequisites, receipt immutability, and receipt-bound
terminal state.

The focused Workerd case executes this sequence against local D1:

1. create `forwarding` with exact reservation, owner, and attempt generation;
2. checkpoint usage and reject a usage regression;
3. stage the immutable finalization event;
4. claim one outbox lease atomically;
5. dead-letter delivery and reject event replacement;
6. settle the reservation and insert the matching audit finalization event;
7. insert the exact append-preserved receipt;
8. converge to `terminal` from recovery; and
9. reject receipt deletion.

Run the exact candidate gates:

```powershell
cargo fmt --all --check
cargo test -p cinatoken-worker --lib
cargo test --workspace --exclude cinatoken-worker
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
python tools/verify_sqlite.py
npx.cmd --yes bun run check:d1:migration-config
npx.cmd --yes bun run check:relay-http-stream-handoff:config
npx.cmd --yes bun run check:do-lifecycle-runtime
npx.cmd --yes bun run check:relay-container:p5-evidence
npx.cmd --yes bun run check:relay-container:p5-foundation
npx.cmd --yes bun run check
git diff --check
```

The handoff config audit must prove all four exact-string gates are false in all
tracked environments, producer prerequisites include Queue/schema/version and
all drain capabilities, outbox/recovery are independent from producer but
staging-latched, parser/finalization/error limits are 64 KiB/64 KiB/4 KiB,
outbox claim uses `UPDATE ... RETURNING`, and terminal convergence uses a D1
batch plus exact receipt.

This implementation worktree passed the complete command set. Recorded results
include Worker unit tests 856/856; the remaining Rust workspace and doc tests;
Worker `wasm32-unknown-unknown` check; SQLite 56/64/814/94; D1 and handoff
configuration audits; P5 verifier 44/44; foundation collector 24/24 plus
self-test; Workerd lifecycle 49/49; formatting and diff checks; and the complete
`bun run check` aggregate in 867.1 seconds. Existing Rust dead-code and generated
Wasm shim warnings remain non-fatal and were not introduced as production
evidence.

These gates are local evidence only. Promotion still requires fault injection
before headers, on client cancellation, on terminal D1 ambiguity, on Queue
acknowledgement ambiguity, and across Worker restart/version skew; provider
call/invoice and billing/audit/request counters; backlog-age alerts; cost/SLO;
rollback; remote 0056 readback; P5 signatures; and Go/VPS drain. The current
design also lacks a total stream deadline and retains a provider-dispatch-to-
handoff crash window. Production remains **NO-GO**.

## Ordinary HTTP SSE Dispatch Intent Verification (2026-07-22)

Migration 0057 is the current-head overlay for the preceding 0056 verification.
The exact-set SQLite verifier must report 57 migrations, 65 tables, 841 checked
incremental columns, and 96 key indexes. It additionally verifies the dispatch
intent table, two indexes, ten triggers, the 0056 hard-deadline column, guarded
state transitions, immutable identity/deadline evidence, and absence of body or
credential fields.

The focused Workerd sequence must prove:

1. reservation binding and `prepared` insert are atomic;
2. two concurrent authorization updates grant exactly one
   `prepared -> dispatched` transition;
3. a later authorization cannot regain send authority;
4. dispatch recovery and billing recovery, including the owner-generation
   increment, occur in one SQLite transaction;
5. `response_received` plus exact 0056 insert promotes 0057 to `stream_bound`
   in that insert transaction; and
6. the existing checkpoint/outbox/receipt terminal sequence still converges.

Run these focused commands before the full aggregate:

```powershell
python tools/verify_sqlite.py
bun tools/audit_d1_migration_config.mjs --json
bun tools/audit_relay_http_stream_handoff_config.mjs --json
cargo test -p cinatoken-worker --lib relay_http_stream_dispatch
bun run build:worker
bunx vitest run --config vitest.do.config.mjs -t "HTTP stream"
bun test tests/relay-container-p5-evidence.test.mjs tests/relay-container-p5-foundation-collector.test.mjs
```

The recorded 0057 source state passed SQLite 57/65/841/96, both configuration audits,
Worker unit tests 858/858, the production Worker build, complete Workerd
lifecycle 50/50, and the combined P5 evidence/foundation suite 68/68. The full
`bun run check` aggregate, including workspace tests, formatting, Wrangler
dry-runs and configured Wasm checks, passed in 878.4 seconds. Retained CI for
the exact commit remains separate evidence.

At the 0057 checkpoint these tests did not prove immediate downstream
cancellation recovery, `Request.signal`, or slow-client backpressure on the
durable-disabled clone path. The 0058 and single-forwarding sections below
supersede those local gaps. They still do not prove remote D1/Queue/provider
behavior. Production remains **NO-GO**.

## Ordinary HTTP SSE Client-Abort Watchdog Verification (2026-07-22)

Migration 0058 supersedes only the current-head and immediate-cancellation
statements above. The exact-set verifier must report 58 migrations, 66 tables,
848 checked incremental columns, and 97 key indexes. It verifies the exact
seven-column abort table, one index, five triggers, first-durable-decision race,
append preservation, duplicate-DDL failure, and forbidden-field absence.

The focused Workerd scenario must use the real Rust Worker with
`enable_request_signal`, version metadata, D1, Queue, provider outbound, and a
service binding. It must read one SSE chunk and cancel the response reader,
then prove:

1. one and only one provider call occurred;
2. one exact 0058 event was appended;
3. 0056 became `recovery_required/client_disconnected` for owner generation 2
   and attempt generation 1;
4. 0057 remained `stream_bound` and billing remained reserved with the frozen
   pre-consumption;
5. user request count stayed zero and no settle/refund was emitted; and
6. provider-terminal-first and abort-first races preserve the first durable
   decision.

Run:

```powershell
python tools/verify_sqlite.py
bun tools/audit_d1_migration_config.mjs --json
bun tools/audit_relay_http_stream_handoff_config.mjs --json
cargo check -p cinatoken-worker --target wasm32-unknown-unknown
bun run build:worker
bunx vitest run --config vitest.do.config.mjs -t "client abort"
bun run check:do-lifecycle-runtime
bun run check
```

The focused reader-cancel/service-binding test and direct D1 race test pass
locally. They do not prove real Cloudflare HTTP/2, HTTP/3, TCP loss, WFP chain,
D1 response loss, isolate restart/deploy, Queue ambiguity, provider invoice,
or production latency/cost. Production remains **NO-GO**.

The exact source worktree also passes Worker 858/858, the remaining Rust
workspace, P5 evidence/foundation 68/68, complete Workerd lifecycle 52/52,
Wrangler dry-runs, Web/Bun checks, formatting, and all configured wasm targets
through `bun run check` in 845.2 seconds.

## Ordinary HTTP SSE Single-Forwarding Backpressure Verification (2026-07-22)

The current ordinary durable-disabled HTTP SSE response is one pull-driven Rust
forwarding stream. Source inspection must find
`complete_instrumented_streaming_relay_response`,
`instrumented_relay_stream_next`,
`dispatch_instrumented_provider_finalization`, the client-abort/finalization
watcher, the bounded finalization retry helper, and the lease heartbeat, and must
find no `Response::cloned()`/clone/tee response-body audit consumer. Provider
terminal work must be registered as a short `waitUntil` before its chunk is
yielded. The `Request.signal` listener and stream Drop may register client
finalization only after cancellation occurs. Heartbeat code must use one
cancelable timer and short renewal tasks, never a response-lifetime `waitUntil`,
and cannot read or buffer the body.

Run the focused local runtime case:

```powershell
bun run build:worker
bunx vitest run --config vitest.do.config.mjs -t "keeps ordinary HTTP SSE provider reads bounded"
```

The case must prove all of the following against local Workerd:

1. a 256-chunk pull-generated provider returns one client chunk;
2. after a 300 ms client pause the provider is incomplete and pull count is
   greater than zero but no more than eight;
3. controlled provider-terminal release plus client drain advances pull count
   by at most one and keeps it below 256;
4. the billing reservation settles with positive final quota and one request
   accounting update;
5. audit metadata reports `usageSource=upstream`,
   `streamUsageParseFailed=false`, and
   `finalizationTransport=billing_queue`; and
6. terminal metadata reports `completion_reason=provider_terminal_event`.

This is acceptance evidence for bounded provider reads, upstream usage, Queue
settlement, and provider-terminal convergence without clone/tee. Accepted
implementation patterns are one response-owned pull-driven stream, bounded
incremental state, synchronous provider-terminal registration as a short-lived
`waitUntil` task, an event-triggered first-owner client listener/drop fallback, a
single-timer heartbeat, and frozen-reserve cancellation. Rejected patterns are response cloning/teeing,
detached body consumption, pull-owned async financial finalization, eager or unbounded
buffering, partial-usage charging after ambiguous disconnect, automatic
refund/resend, and treating a local reader cancellation as edge-network proof.

The static self-test must also reject
`async fn finalize_instrumented_relay_stream(...)` inside the response pull
scope and require `dispatch_instrumented_provider_finalization`, its short-lived
`waitUntil` task, the event-triggered client-abort path, and the timer-based
heartbeat without a response-lifetime promise. This is source-level cancellation
isolation evidence; runtime cancellation during finalization remains a remote
acceptance case.

Rollout verification freezes the exact Worker artifact and hot Go/VPS fallback,
keeps all durable SSE gates false, then repeats slow-reader, normal terminal,
usage-error, Queue retry, and reader-cancel cases in isolated staging before
direct/Gateway/WFP HTTP/2 and HTTP/3 canaries. Rollback must route new SSE to
Go/VPS first, retain migrations 0056-0058 and the N drain owner, reconcile all
owned work, and never restore clone/tee or resend an ambiguous provider call.

The focused Workerd proof does not establish real Cloudflare HTTP/2, HTTP/3, or
TCP client-disconnect propagation, intermediary cancellation, remote D1/Queue
fault behavior, provider invoices, or production load/cost/SLO. Those remain
remote acceptance gates. Production remains **NO-GO**.

## Container Shard Routing Contract Verification (2026-07-22)

Run:

```powershell
bun run check:container-shard-routing-contract
cargo test -p cinatoken-worker --lib production_planner_matches_versioned_cross_language_vectors
bun run check:container-scheduler-config
```

The contract must report schema/contract version 1, four vectors, 16 plans,
eight adjacent expansion transitions, one move to a newly appended shard,
maximum-ring coverage, and six rejected mutations. The report contains no
secret, tenant identifier, or routing digest. Rust must recompute the same
HMAC-SHA256 values and exact `ShardPlan` outputs from the fixture rather than
checking copied constants in a separate test.

Review the fixture and verifier together. Reject any candidate that changes the
domain bytes, omits the big-endian tenant-byte length, uses signed or unbounded
JavaScript arithmetic, accepts unknown fields, permits a stale generation,
moves an owner to an existing shard during `N -> N+1`, exceeds 1024 shards, or
derives a noncanonical instance name.

This is local algorithm evidence. Remote acceptance still requires a fixed
routing secret, zero old-generation active operations, Controller-first N+1
activation, generation/count change in one frozen release, full shard registry
readback, distribution and max+1 capacity replay, lifecycle/fault/load/cost,
billing/provider uniqueness, and disable-first rollback. Do not rotate the
routing secret in the same ring-transition candidate.

## Ring Transition Claim And Fail-Closed Runner Verification (2026-07-23)

Migration 0059 adds the single-use staging ring-transition claim and ordered
step ledger. The authorization evidence now binds three pairwise-distinct
read/claim/deploy identities, and the runner contract pins policy, approval-key,
account, ledger, service, source/build/trust, and release identities while the
checked-in trust object remains disabled.

Commands and results:

```powershell
python tools/verify_sqlite.py
# PASS: 59 migrations, 68 tables, 899 incremental columns, 100 key indexes

bun run check:d1:migration-config
# PASS: contiguous 0001..0059; runtime count 59

bun test --timeout 30000 `
  tests/relay-container-p5-evidence.test.mjs `
  tests/relay-container-p5-foundation-collector.test.mjs `
  tests/relay-container-ring-transition-contract.test.mjs `
  tests/relay-container-ring-transition-execution.test.mjs
# PASS: 106/106

cargo test -p cinatoken-worker --lib `
  d1_migration_readiness_requires_the_current_schema_marker
# PASS: 1/1

bun run check
# PASS: 1083.8 seconds
```

The execution suite proves claim/nonce/digest replay rejection, one active
scope, ordered owner-bound step evidence, no unjournaled state update,
immutable evidence, ambiguous mutation recovery without retry, self-consistent
trust pins, approval-key pinning, exact no-force deployment request shapes,
authorization annotation readback, stable response-loss classification, poison
credential isolation, and CLI execution rejection while trust roots are
unpublished.

The aggregate gate passed release Worker/WFP builds, Workerd 53/53, frontend
and route audits, exact D1 config/SQLite verification, Rust workspace tests,
formatting, and all configured wasm32 checks. Controlled stream failures, DLQ
movement, storage-corruption probes, and existing dead-code warnings appeared
inside expected passing tests.

No Cloudflare request, credential read, remote migration, deployment, provider
call, customer traffic, or production action occurred. The private
claim-authority Worker, live bounded mutation transport, immutable enabled
runner artifact, exposed-token revocation, remote 0059/fault/P5-B evidence, and
Go/VPS drain remain open. Production remains **NO-GO**.

## Ring Transition Authority Migration Verification (2026-07-23)

This section is the current-head overlay for the preceding 0059 verification
record. Historical command outputs remain historical. The current local
workspace D1 target is:

```text
head: 0060_relay_container_ring_transition_authority.sql
count: 60
required tables: 69
checked incremental columns: 909
key indexes: 101
```

Run the read-only local schema gates:

```powershell
python -B tools/verify_sqlite.py
bun run check:d1:migration-config
```

The schema verifier must prove the `0060/60, 69/909/101` integrated-workspace
totals and additionally reject:

1. applying 0060 while any 0059 writer remains active or any transition claim
   remains nonterminal;
2. an expiry actor equal to the claim owner;
3. expiry before D1 `expires_at`;
4. ordinary `expired` after Controller mutation;
5. a post-readback mutation digest that differs from the immediately preceding
   intent;
6. `transport_outcome=rejected` paired with `controller_verified` or
   `completed`; and
7. rejected transport without
   `to_status=recovery_required,failure_class=http_rejected`.

Positive cases must prove independent authority expiry, pre-mutation
`expired`, post-mutation `recovery_required`, exact intent-digest binding, and
explicit `not_applicable|success|ambiguous|rejected` transport evidence.

The local Authority verification aggregate currently passes:

```text
Wrangler types: up to date
Wrangler local dry-run: PASS
Authority unit tests: 22 PASS
Workerd/D1 runtime tests: 2 PASS
configuration and deploy-preflight tests: 22 PASS
full repository `bun run check`: PASS (2026-07-23)
```

The Workerd suite uses a dedicated in-memory D1 containing only the claim,
step, and expiry domain schema. It covers disabled defaults, exact
create/read/step, concurrent single-winner claims with exact replay, body-bound
HMAC rejection, invalid Ed25519 permits, premature expiry rejection, and
error/secret redaction. The broader authenticated staging fault campaign,
including Access enforcement, response loss, unavailable readback, clock
boundaries, key rotation, actor drift, state/version jumps, and outbound-fetch
inventory, remains remote acceptance work.

Configuration verification must reject any Authority Worker candidate unless:

- the only bindings are `cinatoken-ring-control-staging` D1 and Version
  Metadata;
- `workers_dev=false` and `preview_urls=false`;
- authority, claim, step, and expiry write gates are all false;
- no production configuration exists; and
- no KV, R2, Durable Object, Container, Queue, service, application-D1, URL, or
  general SQL authority is present.

The current local Authority Worker passes this static isolation gate: staging
names dedicated `cinatoken-ring-control-staging`, and the audit rejects the
shared application database name. Deploy preflight still returns NO-GO because
the database ID and trust identities are placeholders, every write gate is
false, and the authenticated remote D1, route, Access, key-rotation, and
revocation evidence is absent.

Remote acceptance is a separate retained packet: credential revocation,
control-D1 creation and exact catalog readback, route and Access inventory,
deployed version/config digest, secret rotation, failure campaigns, unchanged
application-D1 business fingerprint, and zero provider/financial/customer
effect. The integrated local total `69/909/101` must not be reported as the
three-domain-table control D1 catalog.

No remote verification or Cloudflare change is claimed by this section.
Production remains **NO-GO**, and Go/VPS remains authoritative.

## Immutable Runner And Native Transport Verification (2026-07-23)

This overlay verifies the current local runner/transport increment. Run:

```powershell
bun test --timeout 30000 `
  tests/relay-container-ring-transition-execution.test.mjs `
  tests/relay-container-ring-transition-transport.test.mjs
cargo test -p cinatoken-ring-transition-runner
bun run check:ring-transition-authority
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
bun run check
cargo fmt --all --check
bun run check
```

The focused contract target is 29 Bun tests: 14 claim/execution tests and 15
native-transport tests. The transport cases cover fixed secret handles,
pairwise-distinct credentials, raw-account binding, token-ID verification,
Authority HMAC compatibility, Authority version/permit-SPKI pinning, exact
request/body/header allowlists, bounded bodies, rejected and ambiguous status
families, atomic all-credential verification, response loss, immutable trust
snapshots, disjoint signing roles, exact fresh-intent binding, replay denial,
single-use permits and zero POST retry. A source guard rejects ambient
`process.env`, console logging, high-level unbounded response readers,
Wrangler, child processes and multiple fetch call sites.

The Rust package target is now 28 tests: 25 library, one binary and two CLI
integration tests. The original launcher cases still prove the checked-in
release is deterministic and disabled, every enabled identity requires all
release/Authority pins, only two fixed commands are accepted, the staging
Authority origin is exact rather than caller-selected, runtime trust/secret
poisoning does not alter description, and execution/override arguments fail
before credentials or network. The new library cases prove strict Authority
snapshot/history reconstruction, cross-language canonical digests,
readback-only inflight resumption, Authority-owned expiry, exact fresh append
versus replay, request-digest binding, and complete Controller/Edge typed
capability flow.

The Authority aggregate additionally verifies the read-only preflight route.
It must require an empty authenticated request, use no D1 operation or write
gate, and return the exact request ID, credential hash, permit SPKI and Worker
Version Metadata ID. The configuration gate remains restricted to the control
D1 and Version Metadata with every write flag false.

Passing local commands do not publish the required DSSE-signed reproducible
release or implement the Rust release/credential/HTTP/stable-read/receipt
integration around the pure orchestrator. They do not prove token revocation,
Access, remote D1, route, deployed version, stable Cloudflare readback,
customer traffic, billing conservation, P5-B or Go/VPS drain. No remote action
is claimed; production remains **NO-GO**.

The current final repository aggregate passed on 2026-07-23 in 826.4 seconds
with exit code 0. It included 36 runner tests, 17 detached release/source tests,
61 ring-transition contract tests with 458 expectations, 23 Authority unit
tests, two Authority Workerd tests, 22 Authority configuration/preflight tests,
the Rust workspace, all configured wasm32 builds, D1 migration/schema gates,
Worker dry-runs, frontend checks, and the existing fault suites.

## Detached Runner Release Verification (2026-07-23)

Run the local release gate:

```powershell
bun run check:ring-transition-runner
```

The release addition contributes 17 Bun tests:

- eleven packet tests cover canonical DSSE PAE, an independently generated
  deterministic Rust/JavaScript vector, Ed25519 verification, external
  policy/key pins, exact schema, time bounds, key separation, required module
  closure, build reproducibility claims, Authority/evidence drift, artifact
  replacement, hardlinks, CLI isolation and non-authorization;
- six source tests create real temporary Git repositories and prove stable
  commit/tree/archive/module identities, clean-tree enforcement, tracked and
  untracked change rejection, missing-module rejection, CLI collection and
  caller-override rejection.

The Rust package contributes 28 tests and describes fixed release/publication
sidecar trust rather than embedding its own future artifact digest.
The focused gate also runs both CLIs in describe mode. No test reads a real
release/transition credential, calls a network service, signs with a production
key, writes outside its temporary fixture, installs an artifact, enables
execution or changes Cloudflare.

These tests validate packet/source foundations and the Rust runtime verifier,
but do not publish a release. Two isolated real builds, a retained independent
DSSE signature, compiled non-null pins, atomic digest installation,
real operator-owned publication activation, live orchestrator integration,
credential revocation and remote staging evidence remain open. Production
remains **NO-GO**.

## Fresh Mutation Intent Verification (2026-07-23)

The native-transport subset now proves:

- caller mutation of the validated trust object and nested key arrays cannot
  change the stored allowlist, and a drifting getter is read into one frozen
  snapshot;
- transition-approval, authorization-approval and permit SPKI overlap fails;
- only an exact `step_appended` response with matching authorization, claim,
  state, status and step digest yields an opaque permit;
- `step_replayed` yields no permit and a caller-created object is rejected;
- target/body/request-digest tampering is rejected before Cloudflare fetch;
- one valid permit sends one deployment POST and reuse sends no second POST;
  and
- timeout-like and response-loss results remain ambiguous and never retry.

The JavaScript reference-transport cases now have a Rust structural
counterpart. Rust tests additionally prove:

- mixed claim/state/step/expiry versions, gaps, duplicate JSON fields and
  oversized snapshots fail closed;
- restored Controller and Edge inflight snapshots choose observation only;
- a non-cloneable request-ID-bound append attempt yields a typed permit only
  for exact `step_appended`, while `step_replayed` yields none;
- request-digest drift or claim expiry spends no write authority; and
- a complete Controller-to-Edge history reaches receipt sealing while each
  phase remains type-separated.

Run `cargo test -p cinatoken-ring-transition-runner` directly or use the
combined `bun run check:ring-transition-runner`. The combined gate currently
executes 36 Rust tests and 17 Bun release/source tests.

These tests do not prove the future Rust HTTP call site consumes the type,
process crash behavior around a real network send, persisted hash-chain
receipt, stable-read timing, remote deployment history or an enabled release.

## Rust Detached Release Runtime Verification (2026-07-23)

The runner package now adds seven release-verifier library cases. Together
with the orchestrator and launcher tests, the package result is:

```text
33 library tests: PASS
1 binary test: PASS
2 CLI integration tests: PASS
17 Bun packet/source tests: PASS
strict runner Clippy: PASS
```

The verifier cases prove:

- checked-in disabled trust exits before current-executable or sidecar reads;
- deterministic Rust and independently generated JavaScript vectors agree on
  SPKI, policy, inventory, manifest, packet and DSSE signature identities;
- canonical exact-schema policy/packet/manifest/inventory parsing rejects
  duplicate or unknown fields;
- compiled pins, policy/release windows, signature, permit-key separation,
  module closure, build/evidence/Authority and artifact identities fail closed
  under drift;
- fixed sibling reads reject missing/non-regular/moved files and Unix
  hardlinks, while the JavaScript installer gate rejects Windows hardlinks;
  and
- a fully signed foreign-platform artifact is rejected at installed-runtime
  verification even though it remains valid for offline packet inspection.

The lock pins `ed25519-dalek` to `2.1.1`. Its declared Rust 1.60 MSRV and the
declared Rust 1.60 MSRV of `curve25519-dalek 4.1.3` remain below this
workspace's Rust 1.78 requirement. The verifier does not enable PKCS#8; it
accepts only the fixed Ed25519 SPKI DER shape. The workspace lock also keeps
`base64ct 1.6.0` and `zeroize 1.8.1`, both Edition 2021/Rust 1.60, because
their newer Edition 2024 releases cannot be parsed by Cargo 1.78.

An explicit local `cargo +1.78.0-x86_64-pc-windows-msvc ... --locked` attempt
now resolves these manifests successfully, but this host cannot complete the
MSVC build because Visual Studio C++ Build Tools/SDK are absent and the only
`link.exe` on `PATH` is a non-MSVC utility. This is an environment limitation,
not recorded as an MSRV build pass; the isolated release builder must still
complete the locked Rust 1.78 compile and tests.

These are local fail-closed checks. They do not provide a production key,
signature, non-null compiled pins, isolated repeated builds, real installed
generation, credential revocation or remote evidence.

## Signed Publication And Activation Verification (2026-07-23)

Five publication tests extend the Rust library count from 20 to 25. They
verify:

- canonical domain-separated publication DSSE with the exact release key/key
  ID and validity bounded by the signed release;
- deterministic JavaScript/Rust generation, manifest, outer packet, signature
  and activation-record vectors;
- exact release/policy/artifact generation binding, with mixed release,
  artifact, file inventory, signature, unknown/duplicate/non-canonical JSON,
  sequence, predecessor and time drift rejected;
- create-new manifest-hash publication directories and four exact sibling
  files, installed-byte readback and read-only freeze;
- sequence-1 activation and exact sequence-2 predecessor CAS, while repeat
  install or wrong predecessor fails without overwrite; and
- source-level absence of credential enumeration, network clients,
  subprocesses, Wrangler and destructive cleanup.

`authorize_execution` now consumes the non-cloneable `ActivatedPublication`
into an opaque `LoadedCredentials`, rather than exposing the activation
capability. For an enabled build it first requires the current executable
to live under the exact publication-manifest-derived directory and requires
the fixed append-only activation record to match manifest, outer packet,
generation, sequence and predecessor before credential access.

The tests use temporary local roots only. They do not prove production
filesystem ownership, Windows source hardlink rejection, Unix runtime link
count, disk/power-loss durability, service-manager selection, two concurrent
OS processes or a real signed artifact.

## Activated Credential Identity Verification (2026-07-23)

Run the focused local gates:

```powershell
cargo test -p cinatoken-ring-transition-runner --locked
cargo clippy -p cinatoken-ring-transition-runner --all-targets --locked -- -D warnings
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
bun run --cwd services/ring-transition-authority test
```

The current focused results are:

```text
33 runner library tests: PASS
1 runner binary test: PASS
2 runner CLI integration tests: PASS
17 detached release/source tests: PASS
61 ring-transition contract/execution/transport tests, 458 expectations: PASS
23 Authority unit tests across 5 files: PASS
strict runner Clippy: PASS
complete repository bun run check, 826.4 seconds, exit code 0: PASS
```

Eight credential-library cases prove:

- checked-in disabled credential trust performs zero environment reads;
- activated trust-config, Authority version and permit-SPKI drift fails before
  the first handle;
- account identity is read and hashed before exactly the three fixed secret
  handles;
- malformed, short, whitespace or shared secret material fails closed;
- read then deploy then claim-preflight typestate is consuming and ordered;
- Cloudflare token ID/status and exact Authority response identities reject
  drift;
- duplicate and unknown preflight response fields fail; and
- production source uses zeroizing storage, no environment enumeration,
  network, subprocess or Wrangler primitive.

The release closure is now 20 paths and includes `credentials.rs`; independent
Rust/JavaScript release/publication vectors were advanced together. A separate
fixed token proves exact HS256 interoperability across the Rust builder,
JavaScript native transport and deployed-Authority protocol implementation,
including canonical header/claims bytes and signature.

The JavaScript transport now keeps preflight private and commits read, claim
and deploy proof flags only after all three succeed. Eighteen transport tests
cover preflight bypass, partial/revalidation failure clearing, HMAC UTF-8 byte
bounds, key-ID compatibility, identity drift and the existing no-retry,
fresh-intent and response-loss rules.

The orchestrator now carries both `generated_at` and `expires_at` through the
typed permit and rejects clock rollback as well as expiry before creating an
authorized mutation.

These are local synthetic proofs. They do not establish Cloudflare token
scope/owner/revocation evidence, a Cloudflare Access workload identity,
bounded Rust HTTP, a coherent remote Authority snapshot, sole POST use,
stable readback, an execution receipt or a crash campaign. No real environment
credential or network request was used; production remains **NO-GO**.

## Bounded Rust Control Plane Verification (2026-07-24)

Focused commands:

```powershell
cargo test -p cinatoken-ring-transition-runner --locked
cargo clippy -p cinatoken-ring-transition-runner --all-targets --locked -- -D warnings
bun test tests/relay-container-ring-transition-execution.test.mjs tests/relay-container-ring-transition-transport.test.mjs tests/relay-container-ring-transition-release.test.mjs tests/relay-container-ring-transition-release-source.test.mjs
bun run check:relay-container:ring-transition
```

Current local results:

```text
41 runner library tests: PASS
1 runner binary test: PASS
2 runner CLI integration tests: PASS
strict runner Clippy: PASS
17 detached release/source tests: PASS
61 ring-transition contract/execution/transport tests, 509 expectations: PASS
complete repository bun run check, 659.7 seconds, exit code 0: PASS
```

The dependency audit found and corrected two release-host issues before the
test claim was accepted. `native-tls 0.2.14` required Rust 1.80, so the
Windows validation path is locked to `native-tls 0.2.13`. Newer Schannel and
`winapi-util` resolution selected `windows-sys 0.61` and required a broken
local GNU raw-dylib tool path; the lock now uses `schannel 0.1.27`,
`windows-sys 0.59.0`, and `winapi-util 0.1.10`. With these
MSRV-compatible/prebuilt-import-library versions, the tests executed rather
than stopping at type checking.

Rust adversarial tests use only scripted exchanges and `127.0.0.1` raw HTTP
fixtures. They prove:

- read-token and deploy-token account verification precede the
  Access-protected Authority preflight;
- Access and Authority secrets never reach Cloudflare API requests;
- exact claim/build/trust/service drift aborts;
- one consumed typed request produces one exact POST path/body;
- 302 is not followed and poisoned proxy environment variables are ignored;
- declared and chunked overflow, timeout and disconnect fail closed;
- uncertain HTTP and connection outcomes are ambiguous with `retry=false`;
  and
- raw secret values do not appear in debug, error, JSON outcome, or release
  source inventory output.

Cross-language canonical vectors now use a 21-module release inventory and
advance the release manifest, DSSE packet, publication generation/manifest/
packet/signature, and activation digest together. Missing or digest-drifted
`transport.rs` is rejected by the clean commit-object source collector and the
detached release verifier.

The checked-in release and credential roots remain disabled. No real
credential, Access policy, Cloudflare API, remote D1, Worker, route,
deployment, customer traffic, provider call, financial mutation, or Go/VPS
authority was used. Stable double readback, execution receipts, exact Linux
Rust 1.78 reproducible builds, independent signing/installation, remote
scope/revocation/Access evidence and the crash campaign remain open.
Production remains **NO-GO**.

## 2026-07-24 Stable Readback And Authority Observation Verification

The local K6 implementation was verified without credentials or remote
network access:

```text
cargo test -p cinatoken-ring-transition-runner --locked
65 library tests: PASS
1 binary test: PASS
2 CLI integration tests: PASS

cargo clippy -p cinatoken-ring-transition-runner --all-targets --locked -- -D warnings
PASS

bun run check:ring-transition-runner
65 + 1 + 2 Rust tests, 18 release/source tests, both describe verifiers: PASS

bun run check:relay-container:ring-transition
65 tests, 728 expectations, three credential-free describe verifiers: PASS

bun run check
complete repository gate, 632.3 seconds, exit code 0: PASS
```

The new Rust cases prove:

- trust-pinned observation intervals accept only 5-120 seconds;
- deployment and target-version snapshots are bounded, duplicate-free, and
  normalized with the JavaScript-compatible deployment-set vector;
- complete target-version details, annotation, active versions, request
  digest, and both observation times alter the evidence digest;
- every one of the four GET boundaries stops immediately on failure;
- requests occur only as deployment GET, version GET, wait, deployment GET,
  version GET, with the read token and no Access/Authority headers;
- short, over-120-second, and nonmonotonic windows fail closed;
- observation step state, failure class, request digest, append response, and
  replay identity are exact; and
- Controller/Edge observation types and restored inflight paths expose no
  fresh mutation permit.

The JavaScript cases prove the canonical annotation no longer accepts the
legacy shortened form, the stable window uses the global 120-second ceiling,
ASCII version order is deterministic, version-detail/annotation drift enters
recovery, and readback never restores a deployment POST capability.

The detached closure is now 22 modules. Both collectors reject a missing or
digest-drifted `readback.rs`; Rust and JavaScript inventory, manifest, DSSE,
publication, signature, and activation vectors match.

These results are local scripted exchanges, loopback transport, and
deterministic fixtures. The checked-in release and credential roots remain
disabled. No Cloudflare API, Access application, D1 state, deployment,
credential, customer traffic, provider call, financial state, or Go/VPS
authority changed. Full repository gates, exact Rust 1.78 Linux reproducible
builds, execution receipts, remote identity/scope/revocation evidence, and
the crash campaign remain production blockers. Production remains **NO-GO**.

## 2026-07-24 K7 Terminal Receipt Store Verification

The local K7 foundation was verified without credentials or remote network
access:

```text
cargo test -p cinatoken-ring-transition-runner
70 library tests, 1 binary test, 2 CLI integration tests: PASS

cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
PASS

bun test --timeout 30000 \
  tests/relay-container-ring-transition-receipt.test.mjs \
  tests/relay-container-ring-transition-release.test.mjs \
  tests/relay-container-ring-transition-release-source.test.mjs
31 tests, 113 expectations: PASS
```

The Rust cases prove terminal Authority projection, exact step/expiry digest
recomputation, legal state progression, bounded canonical records,
predecessor-bound create-new install, complete exact replay, gap/conflict and
post-seal rejection. The independent JavaScript verifier rejects duplicate,
unknown, noncanonical and secret-like fields, shared-identity/time drift,
invalid step/expiry shapes and digest drift, and accepts both direct expiry and
post-controller recovery expiry.

The publication installer now keeps the Linux runner executable at `0555`,
keeps JSON and activation files at `0444`, synchronizes new Unix directory
entries, and performs a final activation-required readback. The signed source
closure is 25 modules and includes the Rust receipt store, independent
JavaScript verifier, and verifier tests.

The current host verified Windows contract/replay semantics. Installing the
`x86_64-unknown-linux-gnu` target did not complete within the bounded local
window, so the Linux-only `openat`/`renameat2` branch, parent-directory
durability, single-link enforcement under attack, ext4/XFS power loss, exact
ACLs, concurrent process death, external chain-head anchor, and real-time
driver integration remain open. Checked-in trust and `--execute` remain
fail-closed; production remains **NO-GO**.

## 2026-07-24 Signed Execution Activation Verification

The execution-activation increment is verified locally with credential-free,
network-free gates:

```powershell
cargo fmt --all --check
cargo test -p cinatoken-ring-transition-runner --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
bun run check
```

The merged local verification record is:

- runner Rust: 76 library tests, one binary test and two CLI tests;
- runner JavaScript: 38 tests across four files;
- broader ring-transition JavaScript: 65 tests across three files;
- Worker library: 859 tests;
- frontend: 71 tests, zero bundle-redaction findings and zero budget failures;
- signed release/source closure: both implementations agree on all 28 modules;
- repository-wide `bun run check`: exit code 0, including the Worker,
  WFP tenant and WFP outbound WASM target checks.

Activation-focused cases must prove:

- checked-in activation trust is disabled and fails before credential or
  network access;
- the only installed path is
  `execution-activations/<publication-manifest-sha>.execution-activation.json`;
- strict canonical parsing rejects duplicate, unknown, noncanonical,
  oversized and trailing content;
- the claim digest is recomputed and the domain-separated Ed25519 permit
  rejects signature, issuer, key, SPKI, identity and validity-window drift;
- publication manifest/packet/generation/sequence/build/trust identities join
  the transition/authorization policies, account, ledger, credentials,
  services, authorization, nonce, owner and claim;
- create-new installation accepts exact replay, rejects different existing
  bytes, and never offers overwrite/delete/repair behavior;
- publication verification precedes activation, activation precedes
  credential loading, and credential proof precedes Authority preflight; and
- the verified activation identity survives into the prepared control plane.

The independent JavaScript verifier and its adversarial tests must be included
with the Rust activation module in both signed source collectors. The release
inventory, manifest, DSSE, publication packet/signature and activation vectors
must agree across Rust and JavaScript for all 28 target modules. Missing or
digest-drifted activation code, verifier code or verifier tests must invalidate
the closure.

Windows results establish only canonical, signature, identity, create-new,
exact-replay and conflict semantics. Production acceptance still requires
Linux adversarial path/link and two-process tests, no-replace and parent-sync
fault injection, ext4/XFS power-loss evidence and exact UID/GID/ACL readback.

No live Authority claim, Cloudflare request, credential read, deployment,
route, DNS, customer traffic or Go/VPS authority change is part of this local
verification. Remaining P0 is live Authority claim creation, typed T1 and Edge
phases, live receipt append, the resumable driver, Linux adversarial tests,
full four-approval revalidation, an external receipt-chain anchor, and the
exposed-credential revocation gate. Checked-in trust and `--execute` remain
fail-closed; production remains **NO-GO**.

## 2026-07-24 Claim Dispatch And Exact Recovery Verification

The local at-most-once claim increment was verified without credentials or
remote network access:

```powershell
cargo fmt --all --check
cargo test -p cinatoken-ring-transition-runner --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

Observed results:

- Rust runner: 82 library tests, one binary test, two CLI tests;
- strict all-target runner Clippy: PASS;
- runner JavaScript: 39 tests, 146 expectations;
- broader ring-transition JavaScript: 65 tests, 728 expectations; and
- signed source/release descriptions: 28 fixed modules;
- complete repository gate: PASS in 719.5 seconds, exit code 0.

The new Rust cases prove:

- a create-new dispatch guard mints exactly one fresh capability across eight
  concurrent openers;
- exact restart replay never restores POST authority;
- the frozen activation body is rehashed and sent once to the fixed path;
- `201/created` and `200/exact_replay` are status/result paired;
- transport loss, invalid 2xx, `409`, `503 outcome_unknown`, throttling,
  timeout-like and server failures proceed only to exact GET;
- deterministic claim rejection and expired activation do not GET or retry;
- unresolved recovery can perform repeated GETs while the total POST count
  remains one;
- exact GET validates Authority version, request ID, authorization, digest,
  owner, credentials, build, trust, services, and complete history; and
- append, deploy, and observation capabilities remain claimed-snapshot bound.

The independent JavaScript case verifies the same closed dispatch schema,
canonical bytes, activation/publication/claim joins, request-ID digest,
reservation window, and dispatch digest. Unknown fields, identity drift,
late reservation, and noncanonical bytes fail closed.

These results do not prove the Linux directory-FD, same-UID attack,
two-process kill, ext4/XFS power-loss, remote Access/D1/version, or credential
revocation gates. Checked-in trust remains disabled. No Authority claim,
Cloudflare request, deployment, route, DNS, traffic, or Go/VPS change occurred.
Production remains **NO-GO**.

## 2026-07-24 Typed Stable Baseline Verification

The T1 and Edge-previous local baseline increment was verified without
credentials or remote network access:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-ring-transition-runner --lib --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun test tests/relay-container-ring-transition-execution.test.mjs
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

Observed results:

- runner Rust library: 91 passed;
- runner binary and CLI: one plus two passed;
- strict all-target Clippy: PASS;
- focused execution JavaScript: 16 tests and 89 expectations;
- runner JavaScript: 39 tests and 146 expectations; and
- broader ring-transition JavaScript: 66 tests and 729 expectations;
- complete repository `bun run check`: PASS with exit code 0 in 747 seconds;
- Worker library: 859 passed; and
- frontend: 71 passed, with zero bundle-redaction findings and zero budget
  failures.

The cases prove:

- T1 and Edge-previous are isolated sealed phases;
- each phase performs exactly four ordered read requests around the compiled
  stable wait;
- both observations bind the exact service, previous version, deployment set,
  annotation, version detail, and monotonic times;
- wait-time expiry, equality with expiry, and clock rollback perform no
  Authority append;
- `201/step_appended` and `200/step_replayed` are the only accepted pairs;
- response loss, invalid success, `503 outcome_unknown`, timeout-like status,
  redirect, throttling, or server failure never triggers a second POST;
- accepted and ambiguous appends both require an exact GET containing the
  expected canonical step;
- an ambiguous append followed by the prior Authority state fails closed;
- the old `ClaimedControlPlane` is consumed and cannot carry its stale
  snapshot into the next phase; and
- independent JavaScript recomputes the Rust T1 canonical step digest.

These tests do not prove live receipt persistence, end-to-end reducer resume,
the remaining append-path recovery changes, Linux process/power-loss
durability, remote Access/D1/version behavior, credential revocation, or
staging rollback. Checked-in trust remains disabled. No Authority claim,
Cloudflare request, deployment, route, DNS, traffic, billing, or Go/VPS
change occurred. Production remains **NO-GO**.

## 2026-07-24 Incremental Receipt Prefix Verification

The exact-GET receipt-prefix increment was verified without credentials or
remote network access:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-ring-transition-runner --lib --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun test tests/relay-container-ring-transition-receipt.test.mjs
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

Observed results before the repository-wide gate:

- runner Rust library: 95 passed;
- runner binary and CLI: one plus two passed;
- focused receipt JavaScript: 13 tests and 32 expectations;
- runner JavaScript aggregate: 40 tests and 150 expectations;
- broader ring-transition JavaScript: 66 tests and 729 expectations;
- signed source/release descriptions: 28 fixed modules; and
- formatting: PASS.

The complete repository `bun run check` passed with exit code 0 in 694.2
seconds. It included 859 Worker library tests, 71 frontend tests, required
Worker/WFP WASM target checks, 459-file bundle-redaction inspection with zero
findings, and all frontend bundle budgets with zero failures.

The new cases prove:

- claimed exact GET persists one unsealed genesis before returning;
- T1 exact GET extends that chain to two records without rewriting genesis;
- repeated exact T1 GET is an exact replay and creates no new slot;
- receipt conflict prevents a verified snapshot from becoming a capability;
- eight concurrent same-genesis installers yield one create and exact replays
  only;
- terminal-only Rust and JavaScript verification reject an unsealed prefix;
- prefix verification accepts claimed and T1 but rejects terminal status
  without its seal;
- canonical terminal vectors remain byte-for-byte unchanged; and
- receipt persistence joins snapshot, publication and credential identities
  without reading or serializing secret material.

Windows concurrency establishes canonical create-new/replay behavior only.
It does not establish Linux no-follow/no-replace durability, parent sync,
process-kill recovery, UID/GID/ACL isolation, ext4/XFS power-loss behavior,
external anchoring, or remote staging behavior.

The current prefix is post-readback evidence. It does not prove whether an
external mutation started or escaped before a crash. Operation-start and
operation-finish/ambiguous receipt boundaries, the resumable driver and the
remaining production gates are still required. Checked-in trust remains
disabled; production remains **NO-GO**.

## 2026-07-24 Mutation Operation Receipt Verification

The mutation Operation Receipt V1 increment was verified locally without
loading credentials or performing remote network requests:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-ring-transition-runner --lib --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun test --timeout 30000 tests/relay-container-ring-transition-receipt.test.mjs
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

Observed results:

- runner Rust library: 101 passed;
- strict all-target runner Clippy: PASS;
- focused receipt JavaScript: 19 tests and 51 expectations;
- runner aggregate: 101 library tests, one binary test, two CLI tests and 46
  JavaScript tests/169 expectations;
- broader ring-transition JavaScript: 66 tests/729 expectations; and
- signed release/source description: unchanged fixed 28-module closure; and
- complete repository `bun run check`: PASS with exit code 0 in 675.6
  seconds.

The cases prove:

- eight concurrent reservations mint exactly one fresh local send capability;
- a durable existing start blocks claim, Authority append and Cloudflare
  deployment network calls;
- a persistent claim restart performs one POST total and then only exact GET;
- an unfinished start is sealed ambiguous and never reopens the mutation;
- recovery does not create an absent start record;
- accepted, rejected and ambiguous finishes are first-terminal-wins;
- start/finish records reject identity drift, predecessor drift, canonical
  tampering, unknown files and a future third slot;
- Operation Receipt V1 contains no raw credential, header, request body or
  response body; and
- Rust and JavaScript match the exact operation ID, start SHA-256 and accepted
  finish SHA-256 vectors.

The current evidence is Windows local contract evidence. It does not prove
exact Rust 1.78 Linux no-follow/no-replace behavior, process-kill recovery,
parent-directory sync, UID/GID/ACL isolation, ext4/XFS power-loss behavior,
external anchoring, remote Authority/Cloudflare state, credential revocation
or Go/VPS fallback. Read-only GET request boundaries and a library-owned
one-action resumable driver also remain P0. Checked-in trust remains disabled;
production remains **NO-GO**.

## 2026-07-24 Single-Action Resume Driver Verification

The library-owned `execute_current()` increment was verified locally without
loading a live credential or performing a remote request:

```powershell
cargo fmt --all -- --check
cargo test -p cinatoken-ring-transition-runner
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

Observed focused results:

- runner Rust: 105 library tests, one binary test and two CLI tests;
- strict all-target Clippy: PASS;
- runner JavaScript: 46 tests and 169 expectations;
- broader ring-transition JavaScript: 66 tests and 729 expectations; and
- signed release/source description: unchanged fixed 28-module closure; and
- complete repository `bun run check`: PASS with exit code 0 in 639.9
  seconds.

The new and retained cases jointly prove:

- public `execute_current()` reuses the full authorization path and still
  fails before credentials/network under checked-in disabled trust;
- operation trees are audited before credential proof traffic;
- one finished plus one unfinished operation is recovered to two terminal
  chains, with the unfinished start sealed ambiguous exactly once;
- a second recovery finds zero unfinished operations and creates no new slot;
- eight concurrent reservations mint exactly one fresh send capability;
- an expired pre-mutation state returns the wait action with zero request and
  zero operation reservation;
- an existing Authority-intent operation returns recovery-pending with zero
  network and no deployment;
- a fresh Controller action performs exactly one Authority intent POST and
  exactly one Cloudflare deployment POST;
- no deployment retry or second state reduction occurs in that invocation;
  and
- inflight typestates remain readback-only after restart.

This evidence is local state-machine and Windows filesystem-contract evidence.
Later sections add local GET operation receipts and supplied-document
operation-head/candidate closure verification. They still do not establish
dirfd-pinned installed-chain enumeration on Linux, ext4/XFS power-loss
durability, real Durable Object/Container supervision, remote
Authority/Access/D1/version behavior, credential revocation, provider
exactly-once behavior, rollback or Go/VPS drain. Checked-in trust and CLI
execution remain disabled; production remains **NO-GO**.

## 2026-07-24 Read-Only Operation Receipt Verification

The request-bound GET receipt increment was verified locally without loading a
live credential or performing a remote mutation:

```powershell
cargo fmt --all --check
cargo test -p cinatoken-ring-transition-runner --locked --no-fail-fast
cargo clippy -p cinatoken-ring-transition-runner --all-targets --locked -- -D warnings
bun test --timeout 30000 tests/relay-container-ring-transition-receipt.test.mjs
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
bun run check
```

Observed results:

- runner Rust: 111 library tests, one binary test and two CLI tests: PASS;
- strict all-target Clippy with warnings denied: PASS;
- focused independent receipt verifier: 21 tests/72 expectations: PASS;
- runner JavaScript aggregate: 48 tests/190 expectations: PASS;
- broader ring-transition JavaScript: 66 tests/729 expectations: PASS; and
- complete repository gate: PASS with exit code 0 in 681.0 seconds.

The focused cases prove:

- Rust and JavaScript agree on the fixed read-request, operation-ID and
  request-start vectors;
- each read operation binds a fresh local nonce, absolute HTTPS URI, method,
  credential/endpoint kind and legal state version;
- read-token and deploy-token proofs are distinct receipt kinds;
- an internally recomputed operation ID cannot hide nonce/request-digest
  drift;
- every current Authority/Cloudflare GET reserves slot 1 before network;
- an existing operation performs zero network and transport loss is
  ambiguous;
- exact claim `408` and `425` are ambiguous rather than deterministic
  rejection;
- read `accepted` is exactly HTTP `200`; `408`, `425` and `429` cannot be
  reclassified as rejected, and Authority write `409` remains ambiguous;
- Cloudflare deployment/version reads cannot start after expiry;
- claim/preflight/token recovery reads stop after the 600-second recovery
  window;
- 128 fixed create-new capacity markers allow exactly one of eight boundary
  contenders to persist slot 1; the 129th persists no operation directory or
  start and fails before network authority is returned;
- interrupted marker staging and 128 complete crash-stranded markers create no
  operation directory/start, remain non-authorizing and fail closed without
  exceeding the fixed slot set;
- a marker-backed empty operation directory is ignored by audit and recovery,
  then only the exact operation can resume normal slot-1 publication; and
- checked-in disabled trust still exposes no CLI execution path.

The independent JavaScript function returns
`verificationScope=single_operation_chain`,
`aggregateCapacityVerified=false` and
`absoluteHttpsTargetVerified=false`. It verifies one supplied chain's internal
target digest; Rust transport proves the absolute HTTPS URI before hashing and
the native Rust authorization audit enforces the aggregate 128-marker bound.
Neither internal hash links nor this local test detect replacement of an
entire self-consistent operation tree by a directory writer. Receipt
timestamps are whole-second local evidence, not network latency, and a local
nonce does not prove remote receipt.

This remains Windows/local and dry-run evidence. It does not prove the exact
Rust 1.78 Linux no-follow/no-replace/fsync/ACL/power-loss behavior, terminal
operation-head and independent signed/WORM anchoring, real Authority or
Cloudflare state, replacement-credential isolation, DO/Container supervision,
rollback, credential revocation or Go/VPS drain. Checked-in trust remains
disabled; production remains **NO-GO**.

## 2026-07-24 Operation Anchor Release-Source Closure Verification

The independent local operation-anchor verifier and its complete release-source
closure were checked with no credential access or remote network request:

```powershell
bun test --timeout 30000 tests/relay-container-ring-transition-operation-anchor.test.mjs tests/relay-container-ring-transition-release-source.test.mjs tests/relay-container-ring-transition-release.test.mjs
bun tools/verify_relay_container_ring_transition_operation_anchor.mjs --describe
bun tools/collect_ring_transition_runner_release_source.mjs --describe --json
bun tools/verify_relay_container_ring_transition_release.mjs --describe --json
bun tools/collect_ring_transition_runner_release_source.mjs --repo <clean-candidate-repository> --json
bun run check:ring-transition-runner
```

Observed results:

- combined focused JavaScript: 33 tests passed, zero failed, with 141
  expectations;
- operation-anchor verifier: 12 tests passed with 49 expectations;
- release-source collector: 10 tests passed, including omission of each new
  contract/verifier/test path;
- detached release contract: 11 tests passed, including refreshed
  deterministic DSSE/release/publication vectors;
- standard `check:ring-transition-runner`: PASS with 124 Rust library tests,
  one binary test, two CLI tests and 61 JavaScript tests/242 expectations;
- required module count: `31`;
- canonical module inventory SHA-256:
  `7de1ae33cb4f36b7ea103fea15118680d076567c305270f8f74ef6d617ee4003`;
- aggregate module bytes: `1490766`; and
- package JSON SHA-256:
  `487f0469bc98ce6d9a7ae6e9cc904a3e52966798067be26886221aaa1fa3277d`.

The 31-path closure adds:

```text
tests/relay-container-ring-transition-operation-anchor.test.mjs
tools/relay_container_ring_transition_operation_anchor_contract.mjs
tools/verify_relay_container_ring_transition_operation_anchor.mjs
```

Both the source collector and detached release verifier now require these
paths. The clean commit-object-only fixture also commits them before `git
archive`, so omission changes or rejects the source candidate rather than
leaving the independent anchor verifier outside the signed release source.
The focused `check:ring-transition-runner` command now executes the
operation-anchor test with the existing execution-activation, receipt,
release-source and release tests.

The local verifier reports
`verificationScope=supplied_operation_anchor_documents`,
`maximumCapacityReservations=128`,
`suppliedHeadSetStructureVerified=true` and
`suppliedLocalSealBindingVerified=true`. It validates canonical closed-schema
bytes, slot ordering/uniqueness, supplied entry/count consistency, terminal-
shaped supplied entries, head-set digest/length binding and the local seal's
all-null/all-populated terminal-candidate tuple. When that tuple is populated,
the supplied head set must contain the matching `accepted` terminal
operation/start pair and
`suppliedTerminalCandidateOperationBindingVerified=true`; when the tuple is
absent that field remains false.

This scope cannot discover a marker omitted from the real filesystem when the
supplied document and counts omit it consistently, and it does not inspect the
real operation receipts or candidate bytes. The verifier explicitly reports
`executionChainVerified=false`,
`operationContextPreimageVerified=false`,
`operationReceiptHeadsVerified=false`,
`capacityMarkerFilesystemCompletenessVerified=false`,
`terminalSnapshotCandidateContentVerified=false`,
`localFilesystemCompletenessVerified=false`,
`detachedSignatureVerified=false`, `wormStorageVerified=false` and
`externalAnchored=false`. Release-packet DSSE verification is not an operation
anchor signature. Native Linux dirfd/`openat2`, rename/replacement,
ext4/XFS power-loss, external DSSE/WORM, remote staging and all remaining
K7/G1-G8 gates stay open. Go/VPS remains authoritative and this Rust
ring-transition candidate remains production **NO-GO**.

## 2026-07-24 Terminal Snapshot Candidate Crash-Window Verification

The terminal exact-claim read now executes this durable order:

```text
verify bounded Authority response
-> create-new TerminalSnapshotCandidateV1 + sync/readback
-> append the candidate-bound accepted operation finish
-> install terminal Execution Receipt V1
-> publish OperationHeadSetV1
-> publish candidate-bound OperationHeadLocalSealV1
```

Focused and aggregate local commands:

```powershell
cargo test -p cinatoken-ring-transition-runner --lib
cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D warnings
bun test --timeout 30000 tests/relay-container-ring-transition-operation-anchor.test.mjs
bun run check:ring-transition-runner
```

Observed local evidence:

- 124 Rust library tests passed;
- terminal transport ordering is exactly `candidate`, `terminal_finish`,
  `snapshot/closure`;
- a crash after candidate publication but before finish recovers the bound GET
  as `accepted`, completes the terminal execution/head-set/local-seal closure
  locally and does not mint a new send capability;
- other unfinished operations remain locally recoverable only as
  `ambiguous`;
- candidate/operation/closure staging residue blocks admission, and deleting a
  candidate bound by a published local seal makes closure verification fail;
- the zero-operation cross-runtime local-seal vector is 1000 bytes with
  SHA-256
  `5875614a4d23597ccf6406c013a8aaab99f9f3cb762d2c793ad4ab7b89fbe9b3`;
- the operation-anchor verifier passed 12 tests/49 expectations and continues
  to report `terminalSnapshotCandidateContentVerified=false`; and
- the clean commit-object-only 31-module inventory is 1490766 bytes with
  SHA-256
  `7de1ae33cb4f36b7ea103fea15118680d076567c305270f8f74ef6d617ee4003`.

This is Windows/local evidence. The Linux standard library is installed, but
the Windows host has no `x86_64-linux-gnu-gcc`, so dependency build scripts
prevent a complete local Linux cross-check. Native Linux execution is assigned
to the dedicated Ubuntu workflow. No multi-process kill/fsync, ext4/XFS
power-loss, external DSSE/WORM or remote staging campaign was run. The current
path re-resolution after directory `flock` remains a production blocker. No
credential or Cloudflare remote action occurred; Go/VPS remains authoritative
and production remains **NO-GO**.

## 2026-07-25 Linux Single-Parent Publication Verification

The immutable publication path now uses one Linux parent dirfd for target
lookup, staging create/write/sync, no-replace rename, parent sync and final
readback. The final target must match the staging dev/inode and pass
UID/GID/mode/nlink checks, while a reopened parent pathname must still resolve
to the pinned directory identity; bounded double-read catches content drift.
The same primitive covers execution receipts, operation receipts, capacity
markers, terminal candidates, head sets and local seals.

Local evidence:

- `cargo test -p cinatoken-ring-transition-runner --lib`: 124 Windows tests
  passed;
- the 23 focused receipt tests passed after the publication refactor;
- `cargo clippy -p cinatoken-ring-transition-runner --all-targets -- -D
  warnings`: passed; and
- `cargo check --target x86_64-unknown-linux-gnu` reached the native `ring`
  build and stopped because this Windows host lacks
  `x86_64-linux-gnu-gcc`, not because of a reported runner Rust diagnostic.

The new `.github/workflows/ring-transition-runner-linux.yml` gate runs the full
library plus three Linux-only tests on Ubuntu 24.04. Those tests replace the
parent pathname after staging sync and require fail-closed identity mismatch,
race a no-replace competitor and reject a hard-linked target. A remote pass
is recorded for commit
`0b8f50567d30d8c69e51982af44555879d7cf691`:

- [run 30142006553](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142006553)
  and
  [job 89636946500](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142006553/job/89636946500)
  completed successfully;
- formatting, 127 Linux library tests and `cargo clippy --locked -p
  cinatoken-ring-transition-runner --all-targets -- -D warnings` all passed;
- the final local `check:ring-transition-runner` passed 124 Rust library
  tests, 3 CLI tests and 61 Bun tests/242 expectations; and
- the clean commit-object collector reported Git tree
  `70f6b0491c5e90107899a4ae5f6753bb29ee0e03`, source archive SHA-256
  `7329461b1672194222f5be22076166947215282b22081237c2e7acdc31e55c9b`,
  31 modules, 1501593 module bytes and inventory SHA-256
  `26eea3d220a34d8c6538eedea55dbeca73de858f7965960db64b7c6523a4dac6`.

The failure chain is retained as evidence rather than hidden:

1. [run 30139739920](https://github.com/cinagroup/cinatoken-rust/actions/runs/30139739920)
   rejected the first Linux candidate;
2. [run 30141528423](https://github.com/cinagroup/cinatoken-rust/actions/runs/30141528423)
   exposed that a tamper fixture remained writable instead of restoring
   production mode `0444`;
3. [run 30141856643](https://github.com/cinagroup/cinatoken-rust/actions/runs/30141856643)
   caught a Linux-only conditional import error and warning; and
4. run 30142006553 passed after the cross-platform fixture and import fixes.

This gate proves same-parent publication continuity only. It does not yet
prove a pinned authorization/root/closure descriptor graph, split-lock
exclusion, zero `AT_FDCWD` after `flock`, multi-process recovery or power-loss
durability. K7, external anchoring and production remain **NO-GO**.

## 2026-07-25 Linux Authorization Lock-Domain Verification

The second native Linux increment introduces a typed `LockedAuthorization`
that retains the opened `operation-receipts` parent and authorization
directory descriptors, their stable filesystem identities and both exclusive
locks. The authorization child is opened relative to the retained parent.
Binding checks compare the retained objects with both parent-relative and
absolute pathname resolution before fresh send authority or terminal success
can escape.

Local commands:

```powershell
cargo fmt --all -- --check
cargo test --locked -p cinatoken-ring-transition-runner --lib
cargo clippy --locked -p cinatoken-ring-transition-runner --all-targets -- -D warnings
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local results:

- formatting and warning-free Clippy passed;
- 124 Rust library tests passed on Windows;
- 3 binary/CLI tests passed; and
- 61 Bun contract tests passed with 242 expectations.

Native Linux evidence is frozen at commit
`63df95c6f8390579e00b2788378abdb89eb5f3c5`:

- [run 30142822377](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142822377)
  and
  [job 89639172198](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142822377/job/89639172198)
  completed successfully;
- formatting, 129 Linux library tests and warning-free Clippy passed;
- Linux tests include authorization-path replacement fail-closed behavior and
  competing parent-lock exclusion; and
- clean commit-object collection produced Git tree
  `b73035bebda0b3f713243cf1353cef09f3fd0c80`, a 35676160-byte source
  archive with SHA-256
  `05b3eb98b90a9f90f201f4ca0153b8c59767223b165894714d7c3545b89de112`,
  and 31 required modules totaling 1509783 bytes with inventory SHA-256
  `8fd60cc8c0849f89ace289d6eb6b099f11f8a061d1226708185e946aa872d971`.

[Run 30142666351](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142666351)
is retained as the intermediate failure: all 129 Linux tests passed, but
Clippy rejected the candidate. Removing a dead Linux-only identity helper and
the redundant `EWOULDBLOCK`/`EAGAIN` branch produced the frozen passing
candidate; the workflow now emits bounded Clippy diagnostics on future
failures.

This evidence proves cooperative parent/authorization lock-domain continuity,
not complete hostile-path containment. Root, execution-chain, operation and
closure descriptors are not yet one retained fd graph; `openat2` containment,
zero-`AT_FDCWD` syscall tracing, true multi-process kill/rename campaigns,
ACL/backup/restore, ext4/XFS power-loss and external DSSE/WORM evidence remain
open. No Cloudflare credential or mutation was used. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-25 Linux openat2 Child-Containment Verification

The native Linux wrapper now opens authorization children, staging files and
stable readback targets with `SYS_openat2` and
`RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV`. The implementation has
no fallback to weaker path traversal. The Linux-only test opens a valid child
and rejects both `../outside` and a symlink to that outside directory.

The first pushed candidate,
`0e9fec41d02003a563cf0a1465eb51df630106bc`, failed
[run 30143319279](https://github.com/cinagroup/cinatoken-rust/actions/runs/30143319279)
at Linux compilation. GitHub's bounded test annotation recorded Rust
`E0639`: `libc::open_how` is non-exhaustive and cannot be built with a struct
literal outside the `libc` crate. The final implementation zero-initializes
the ABI structure, then assigns the three known fields so unknown tail fields
remain zero.

Native evidence is frozen at
`7c015f812ca42b73388166abd67b24da4d7cb6ae`:

- [run 30143505878](https://github.com/cinagroup/cinatoken-rust/actions/runs/30143505878)
  and
  [job 89641059840](https://github.com/cinagroup/cinatoken-rust/actions/runs/30143505878/job/89641059840)
  passed;
- formatting, 130 Linux library tests and warning-free Clippy completed
  successfully;
- the aggregate local command passed 124 Rust library tests, 3 binary/CLI
  tests and 61 Bun tests with 242 expectations; and
- clean commit-object collection produced Git tree
  `6dd3bd5366171c35295b4dc19d623459f308a34c`, a 35696640-byte source
  archive with SHA-256
  `72e9662384e3d2de4c3434fd8ae1df3679d0d741af436152b3ec67f9b33624a7`,
  and 31 required modules totaling 1511043 bytes with inventory SHA-256
  `86fa2af05728e11ed6d338e8dfb727489de1a821b38c10626042b735e0250be7`.

The verified scope begins only after an immediate parent descriptor has been
acquired. It does not prove that all such parents originate from one retained
root graph. Reserve-to-Fresh descriptor continuity, mount-fixture rejection,
zero-unapproved-`AT_FDCWD` traces, true multiprocess rename/kill, ACL,
backup/restore, ext4/XFS power-loss and external DSSE/WORM gates remain open.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 Linux Reserve Operation Dirfd Verification

This increment verifies descriptor continuity for capacity and per-operation
state during reserve. Linux creates operation directories relative to the
retained authorization descriptor, opens them with the common fail-closed
`openat2` policy, audits them through `fdopendir`/`readdir`, and appends,
reads and verifies the start receipt through the retained operation
descriptor.

Local command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result:

- 124 Rust library tests passed;
- 3 binary/CLI tests passed; and
- 61 Bun tests passed with 242 expectations.

Native evidence is frozen at
`8cf817f081d0001fc7ef1f6992984f990a1f8b50`:

- [run 30144317849](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849)
  and
  [job 89643177206](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849/job/89643177206)
  passed;
- formatting, 132 Linux library tests and warning-free Clippy completed
  successfully;
- Linux tests prove operation-path replacement fails closed before `Fresh`
  and that repeated direct directory scans rewind to the complete entry set;
  and
- clean commit-object collection produced Git tree
  `a46f6cf1bc1d3f3843fdde28e4c98c60043c8a36`, a 35727360-byte source
  archive with SHA-256
  `ee1e9c865893fe01075e1baaa169f901b83d996ef27a2c3e3e99c4fe7cbbd781`,
  and 31 required modules totaling 1534319 bytes with inventory SHA-256
  `2f9d12f0893b65d88001f61becc08d92a95f818e1ca03849d8bd715f06f3f6f0`.

[Run 30144186705](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144186705)
is retained as the intermediate failure. Its 132 Linux tests passed, but
Clippy rejected one dead Linux-only fallback and a publication test hook with
too many arguments. The frozen candidate cfg-gates the fallback and groups
the retained parent arguments; no lint suppression was added.

The replacement test acquires the operation descriptor, renames its pathname,
creates a different directory at the original path and then continues
reserve. The expected result is
`UnsafeFilesystem("operation_directory")`, with no `Fresh` result and no
start receipt redirected into either pathname. Static review found no
`fdopendir` ownership leak and no Windows cfg regression.

The verified boundary is deliberately partial. Reserve's terminal barrier
still performs path-based reads of the execution chain, head set, closure and
terminal candidate, and the final binding check covers authorization and
operation directories rather than that complete terminal graph. This is the
next P0. Publication staging cleanup and precise syscall-error preservation
remain P2. Multi-process rename/kill campaigns, zero-unapproved-`AT_FDCWD`
traces, ACL/backup/restore, ext4/XFS power-loss and independent DSSE/WORM
evidence remain open. No credential or Cloudflare mutation was used. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-25 Linux Reserve Terminal Descriptor Graph Verification

This increment verifies that reserve evaluates terminal admission and its
authorization-wide sibling tree through retained Linux directory descriptors.
The implementation directly scans execution receipts, capacity markers,
operation directories, operation receipts, the head set, local seal and
terminal candidate. It repeats the terminal barrier immediately before a
reservation may escape.

Local command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result:

- 124 Rust library tests passed;
- 3 binary/CLI tests passed; and
- 61 Bun tests passed with 242 expectations.

Native evidence is frozen at
`79b3f4a3e2534f3249c57e21f9314295d389105e`:

- [run 30147304951](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951)
  and
  [job 89651524827](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951/job/89651524827)
  passed;
- formatting, 136 Linux library tests and warning-free Clippy completed
  successfully;
- Linux tests replace the captured execution chain and closure directory,
  introduce a late head set before start publication, and preserve valid
  transient execution-staging behavior; and
- clean commit-object collection produced Git tree
  `85e4f7f267996c3d128a30bef6bfc17e1b3d780b`, a 35778560-byte source
  archive with SHA-256
  `c0dd0f59f9582f9c18b20271f851c67a104341abaad36ae15fe02a3b7a851dd5`,
  and 31 required modules totaling 1569772 bytes with inventory SHA-256
  `51e2c990d72bf140588ffa175f73600abbd4b6ffa4319a0ef0f9e63d674f8890`.

[Run 30145270642](https://github.com/cinagroup/cinatoken-rust/actions/runs/30145270642)
is retained as the intermediate failure. Formatting passed, but Linux
conditional compilation found a duplicate test-helper name before tests
could run. Commit `79b3f4a3` renamed the fixture; production code was
unchanged and the complete native gate then passed.

The tests prove:

1. execution-chain replacement after graph capture returns
   `UnsafeFilesystem("chain_directory")`;
2. closure-directory replacement returns
   `UnsafeFilesystem("operation_authorization_closure_directory")`;
3. a late malformed head set is parsed from the retained authorization fd and
   rejected before a start receipt exists; and
4. valid transient execution staging remains compatible with the previous
   scan contract.

The evidence does not claim atomic absence against a process that deliberately
shares the runner UID and ignores `flock`. Such a process could hide an object
before graph capture, keep it hidden through the final check and restore it
after return. Dedicated UID/GID, exact ACL and parent ownership, plus mount and
workload isolation are mandatory production controls. Finish/recovery/closure
descriptor conversion, multiprocess fault injection, syscall traces,
ext4/XFS power loss and external DSSE/WORM evidence remain open. No
credential, remote mutation or traffic change occurred. Go/VPS remains
authoritative and production remains **NO-GO**.

## 2026-07-25 Linux Finish and Recovery Retained Graph Verification

This increment verifies descriptor continuity for ordinary finish,
candidate-bound finish, unresolved-operation completion and startup recovery.
The candidate contract additionally binds the exact start receipt and exact
canonical finish receipt.

Local command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result:

- 126 Rust library tests passed;
- 3 binary/CLI tests passed; and
- 61 Bun tests passed with 242 expectations.

Native evidence is frozen at
`33bbda404a01ae2b2e068237f891a44a1a3b8a68`:

- [run 30148796402](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402)
  and
  [job 89655504013](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402/job/89655504013)
  passed;
- formatting, 140 Linux library tests and warning-free Clippy completed
  successfully;
- Linux tests replace the operation directory after finish verification and
  after recovery graph capture, require
  `UnsafeFilesystem("operation_directory")`, and prove that no finish receipt
  is redirected to the replacement or displaced directory;
- portable tests reject terminal-candidate start-receipt drift and reject a
  different existing accepted finish; and
- clean commit-object collection produced Git tree
  `34947264d0812d4faefd1d7006bf577463bcaefd`, a 35809280-byte source archive
  with SHA-256
  `5741487d63c7e710d0469dc3d8a8741c9c7c5521cb7d97eb08e625f30d290aea`,
  and 31 required modules totaling 1591919 bytes with inventory SHA-256
  `637906e8da2927e55467134368f584b6ffb500dce553efb650086f9bea2d7b5a`.

[Run 30148493686](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148493686)
and
[job 89654712996](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148493686/job/89654712996)
are retained as intermediate evidence. Formatting and the complete Linux
filesystem test step passed. Clippy then identified two old path fallbacks as
dead in the Linux production target. Commit `33bbda40` restricted them to
non-Linux and test builds; no lint suppression or production behavior change
was used.

The verified boundary includes:

1. the same retained operation object before and after finish append;
2. exact candidate start and finish binding;
3. the same retained operation set before and after recovery completion;
4. a final fd-relative authorization rescan with identical operation IDs; and
5. retained terminal-candidate reread before recovery success.

The next verification unit is candidate/head-set/local-seal publication and
terminal closure on a retained root-to-leaf descriptor graph. This evidence
does not replace dedicated UID/GID, exact ACL/ownership and mount isolation
against a peer that shares the runner identity and ignores `flock`.
Multiprocess kill/rename campaigns, syscall traces, ext4/XFS power-loss,
backup/restore, independent DSSE/WORM and Cloudflare lifecycle evidence
remain open. No credential, remote mutation or traffic change occurred.
Go/VPS remains authoritative and production remains **NO-GO**.

## 2026-07-25 Linux Terminal Closure Retained Graph Verification

This increment verifies descriptor continuity for terminal candidate
publication, terminal execution-plan installation, operation head-set and
local-seal publication, startup closure recovery and final closure
verification.

Local command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result:

- 126 Rust library tests passed;
- 3 binary/CLI tests passed; and
- 61 Bun tests passed with 242 expectations.

Native evidence is frozen at
`3cbddd719c1354ea7765d24089837120fdf6ca04`:

- [run 30154588102](https://github.com/cinagroup/cinatoken-rust/actions/runs/30154588102)
  and
  [job 89670450774](https://github.com/cinagroup/cinatoken-rust/actions/runs/30154588102/job/89670450774)
  passed;
- formatting, 145 Linux library tests and warning-free Clippy completed
  successfully;
- five Linux tests cover candidate-closure replacement, execution-chain
  replacement during append, operation replacement after state capture,
  closure replacement after candidate read and exact recovery from the
  head-set/local-seal crash boundary; and
- clean commit-object collection produced Git tree
  `c673790199bba2f1090654a4cfbc64b42c977934`, a 35870720-byte source
  archive with SHA-256
  `08bd3fb6857222853381a72be72c2d2604f85638e3d22de9c92b524098b758d9`,
  and 31 required modules totaling 1637476 bytes with inventory SHA-256
  `a2d6a538fca14072171642185e926db35a1b24837cbda526ec80abda37c0b140`.

The verified boundary includes:

1. candidate publication and direct readback beneath the retained closure
   descriptor;
2. terminal execution append and verification beneath the retained execution
   chain descriptor;
3. a retained authorization snapshot containing operation dirfds,
   marker-only directories, capacity records, optional head set and directory
   version;
4. descriptor-relative head-set publication, operation freeze and local-seal
   publication with version refresh only after authorized mutation;
5. graph and authorization-state checks after candidate read and immediately
   before local-seal publication; and
6. exact, network-free startup recovery when the head set exists but the
   local seal does not.

[Runs 30149938243](https://github.com/cinagroup/cinatoken-rust/actions/runs/30149938243),
[30151162327](https://github.com/cinagroup/cinatoken-rust/actions/runs/30151162327),
[30151378836](https://github.com/cinagroup/cinatoken-rust/actions/runs/30151378836)
and
[30151786816](https://github.com/cinagroup/cinatoken-rust/actions/runs/30151786816)
remain intermediate evidence. Linux conditional compilation and strict
Clippy exposed dead path fallbacks and an over-wide hook; the concurrent test
also preserved the exact `unfinished_operation_chain` retry classification.
The final candidate uses platform cfg and explicit input grouping, with no
lint suppression.

This evidence closes the current official-writer terminal graph after
trusted-root and authorization acquisition. It does not prove hostile
same-UID containment, true multi-process lock/rename behavior, filesystem
durability after power loss, restore integrity or independent external
closure. Dedicated UID/GID, exact ACL/ownership, mount isolation,
multi-process kill/rename, syscall traces, ext4/XFS, backup/restore,
DSSE/WORM, Cloudflare lifecycle and G1-G8 remain open. No credential, remote
mutation or traffic change occurred. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-25 Native Process-Death and Recovery Syscall Verification

Local aggregate command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result:

- 126 Rust library tests passed;
- 3 binary/CLI tests passed; and
- 61 Bun tests passed with 242 expectations.

Native Linux evidence is frozen at
`467fba330164841142c0cdd7c11658acd5605674`:

- [run 30157298245](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245)
  and
  [job 89677148809](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157298245/job/89677148809)
  passed;
- formatting, 147 Linux library tests and warning-free Clippy completed
  successfully;
- the independent closure-replacement child cannot redirect candidate
  publication to either the displaced or visible replacement directory;
- a child killed by `SIGKILL` after synced head-set publication releases the
  lock, and a fresh store recovers and exactly replays the local seal; and
- the focused `strace` gate passed two exclusive-lock, numeric-dirfd
  `openat2`, numeric-dirfd `renameat2`, directory-sync and descriptor-chmod
  requirements while finding no post-lock `AT_FDCWD` mutation.

The Linux suite also verifies the race correction discovered by the first
trace candidate. An unfinished closure attempt now returns
`unfinished_operation_chain` before creating the terminal execution or
closure roots. The same operation can then finish and install its terminal
closure. This prevents an empty execution-chain residue from surfacing as
`PredecessorMissing`.

Clean commit-object collection from an independent clean clone produced:

- Git tree `215e80c3220756764afe9cd3ae0829a00a60a887`;
- a 35901440-byte source archive with SHA-256
  `54bd395057dfedb4089ba344ad0835215ca717af75d7a440b6a35598363d1e90`;
- 31 required modules totaling 1649358 bytes; and
- module-inventory SHA-256
  `ae61249e39efe9cb70ac855302837995d0ea59a0b22d388250f4157e49175b9f`.

Intermediate evidence is retained:

- [run 30156048897](https://github.com/cinagroup/cinatoken-rust/actions/runs/30156048897)
  failed the existing finish/closure linearization test with
  `PredecessorMissing`, exposing the premature empty terminal graph; and
- [run 30157120814](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157120814)
  passed all 147 tests and trace assertions but failed only when its EXIT trap
  attempted to delete the intentionally read-only fixture.

The final cleanup restores owner write permission after the traced process
has exited and deletes only the temporary fixture. It is not part of the
production recovery trace.

Evidence scope is intentionally narrow. Read-only absolute path identity
checks are allowed, only the head-set recovery process is traced, and the
inline parser is neither independently signed nor immutable. This does not
prove all process interleavings, hostile same-UID containment, ext4/XFS
power-loss durability, production ACL/mount policy, backup/restore,
independent DSSE/WORM, Cloudflare lifecycle or G1-G8. No credential, network
mutation or traffic change occurred. Go/VPS remains authoritative and
production remains **NO-GO**.

## 2026-07-25 Full Terminal Transaction Syscall Verification

The Linux child-role fixture now performs one complete deterministic
transaction in a fresh process: exact claim-read reserve, candidate install,
candidate-bound accepted finish, terminal closure install and exact recovery.
The parent reopens the resulting store and binds the recovered execution head
to the plan derived from the frozen terminal snapshot.

Local aggregate command:

```powershell
npx.cmd --yes bun run check:ring-transition-runner
```

Observed local result for
`11c938720875dee8da5d19481a3b39a03bda9c84`:

- 126 Rust library tests passed;
- 3 binary/CLI tests passed;
- 61 Bun tests passed with 242 expectations;
- formatting passed; and
- strict all-target Clippy passed.

The Ubuntu workflow retains the focused recovery trace and adds a full
transaction trace. Both reject post-first-lock `AT_FDCWD` mutation and require
numeric-dirfd `openat2`/`renameat2`, sync and descriptor chmod. The full trace
also requires at least five successful exclusive locks and numeric-dirfd
`mkdirat`; focused recovery still requires at least two locks.

Clean commit-object evidence:

- Git tree `82d824341ccf6188a4515c4ff2373c3793d7ee86`;
- 35932160-byte source archive with SHA-256
  `f4605c6af5c6924da2262d9531929cd65e4e0b979bb5fcd36b62afc59aad7672`;
- 31 required modules totaling 1652800 bytes; and
- module-inventory SHA-256
  `2cc6f847b14da90f66ff0c3b4f82e72d8e60b0fc520ba6718841263e57dc24ab`.

Remote status is unresolved, not failed code evidence. Runs
[30157797156](https://github.com/cinagroup/cinatoken-rust/actions/runs/30157797156)
and
[30158073337](https://github.com/cinagroup/cinatoken-rust/actions/runs/30158073337)
created zero jobs and reported separate GitHub internal-server correlation
IDs during the official
[Actions run failures and delays incident](https://stspg.io/448g37mrq066).
The exact candidate still requires a fresh green Ubuntu run after service
recovery.

No credential, provider request, Cloudflare mutation or traffic change was
performed. Full crash-boundary, ACL/mount, power-loss, restore, immutable
external evidence, Cloudflare lifecycle and G1-G8 gates remain open. Go/VPS
remains authoritative and production remains **NO-GO**.

## 2026-07-26 Container Runtime Isolation Verification

### Local exact-source checks

```powershell
cargo test --locked -p cinatoken-container-runtime
cargo clippy --locked -p cinatoken-container-runtime --all-targets -- -D warnings
cargo clippy --locked -p cinatoken-container-runtime --all-targets --target x86_64-unknown-linux-gnu -- -D warnings
cargo fmt --all --check
bun test C:/cinagroup/cinatoken-rust/tests/container-runtime-linux-gate.test.mjs
node tools/verify_container_runtime_linux.mjs --self-test --json
```

Expected result for candidate
`304a8c1569db9c479430ef003379cc55d688ce54`:

- 13 container-runtime library tests and 7 HTTP tests pass;
- native and Linux-target strict Clippy pass;
- formatting passes;
- 8 Bun tests pass with 69 expectations; and
- the offline self-test reports contract version 2, `status=passed`, no
  credential/remote mutation/customer traffic/cutover authority, and a compiled
  non-HTTP runtime attestation.

The self-test is intentionally Docker-independent. The real image gate must run
on Linux x64:

```bash
docker build --platform linux/amd64 \
  --tag cinatoken-container-runtime:linux-gate \
  --file crates/container-runtime/Dockerfile .
node tools/verify_container_runtime_linux.mjs \
  --image cinatoken-container-runtime:linux-gate \
  --json
```

The verifier creates and removes a private internal network and two runtime
instances. It must not publish host ports, consume Cloudflare/provider
credentials, or authorize remote mutation.

### Accepted Ubuntu evidence

| Field | Value |
| --- | --- |
| Candidate / tree | `304a8c1569db9c479430ef003379cc55d688ce54` / `66e7ecdbad0430ba38ef120be1957d202afbb170` |
| Run / job | [30192249580](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580) / [89767475624](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/job/89767475624) |
| Host | Ubuntu 24.04.4, runner image `20260720.247.2`, Git 2.54.0 |
| Image | `sha256:85b333c3804a82031359929ea422baf98f35aed15e3062bff95ba0744f86f9e6`, amd64, 19 rootfs layers |
| Runtime build | `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` |
| Runtime policy | `sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d` for primary and restart |
| Artifact | [8628969468](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192249580/artifacts/8628969468), 2761 bytes, `sha256:c9d7d549c39e6879cf1cb29f7ea1982f93f4c39a537d5381037935c30686964a`, expires `2026-08-25T07:08:57Z` |
| JSON member | 7901 bytes, `sha256:29d05f1d142423140d4f479e2817d59020ebdab804c8099a5356cb1467412977` |
| Log member | 0 bytes, `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Independent verification downloaded the artifact, recomputed the ZIP and member
hashes, reconstructed this exact ordered policy object, and SHA-256 hashed its
compact JSON:

```javascript
const policy = {
  contract: "cinatoken-container-runtime-policy-v1",
  container: report.runtimeAttestation.container,
  processSecurity: report.runtimeAttestation.processSecurity,
  filesystem: report.runtimeAttestation.filesystem,
  fileDescriptorPolicy: report.runtimeAttestation.fileDescriptors.policy,
};
```

The recomputed value, top-level value, embedded attestation value, and restart
value all equal
`d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`.
The JSON also confirms UID/GID 65532, all capability masks zero, NNP 1,
seccomp mode 2/one filter, no unexpected writable mount, no POSIX ACL override,
and no unexpected path-backed descriptor.

### Negative calibration evidence

- [run 30191008408](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191008408)
  failed the overly strict Docker inspect tmpfs representation assumption;
  [artifact 8628562669](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191008408/artifacts/8628562669)
  is 442 bytes with
  `sha256:82576ff8a2676d8cab07301486646120759ec0844ca3b351f08e34f1e01d9e79`.
- [run 30191475197](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191475197)
  rejected inherited base-image cwd;
  [artifact 8628703302](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191475197/artifacts/8628703302)
  is 438 bytes with
  `sha256:5c73a0237bf99ca5d3d7bcfba3424d364a7b794741ae1964ffb520f0b31cbc07`.
- [run 30191703953](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191703953)
  rejected nonroot ownership of the immutable `/usr/local` layout;
  [artifact 8628772816](https://github.com/cinagroup/cinatoken-rust/actions/runs/30191703953/artifacts/8628772816)
  is 435 bytes with
  `sha256:11bd960cf69716ed75b6b1838b23f679612f2c2362bae25747877d02aa54f3ec`.

All four artifacts expire on 2026-08-25 at their recorded creation-relative
times; durable evidence must be copied into the approved signed/WORM system
before expiry.

This verification proves the source-owned image under Ubuntu/Docker. It does
not prove Cloudflare Containers host isolation, deployed image identity,
managed lifecycle, persistent storage durability, external evidence retention,
or production authorization. Go/VPS remains authoritative and production
remains **NO-GO**.

## 2026-07-26 Reproducible Container Image Verification

This section supersedes the single-image commands above for the reproducibility
gate. The offline contract remains credential-free and Docker-independent:

```powershell
bun run check:container-runtime:linux-contract
cargo test --locked -p cinatoken-container-runtime
cargo clippy --locked -p cinatoken-container-runtime --all-targets -- -D warnings
cargo clippy --locked -p cinatoken-container-runtime --all-targets --target x86_64-unknown-linux-gnu -- -D warnings
cargo fmt --all --check
```

The real Linux gate is the pinned workflow
`.github/workflows/container-runtime-linux.yml`. It performs two no-cache
Buildx builds with `SOURCE_DATE_EPOCH=0` and
`--output type=image,rewrite-timestamp=true`, retains both image inspections
and copied binary hashes, then invokes:

```bash
node tools/verify_container_runtime_linux.mjs \
  --image cinatoken-container-runtime:linux-gate-a \
  --reproducible-image cinatoken-container-runtime:linux-gate-b \
  --json
```

### Accepted evidence

| Field | Value |
| --- | --- |
| Contract | Version 5; local offline test 9/9 with 86 expectations |
| Candidate / tree | `cbe749907931435e280686c9b8c935b08fdd085f` / `0a21ce473d857fbcfc2adc60a5e7362bd7784bff` |
| Run / job | [30194108625](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625) / [89772437472](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/job/89772437472) |
| Image | `sha256:6a2f92415570e2b13e033b8c0d3d1acaadccf2bfa60ebd8d63faa359b687c514`; exact ID, config, and 19-layer equality |
| Binary/build | `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` for build A, build B, and live readiness |
| Policy | `sha256:d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d`; primary/restart/embedded/recomputed equality |
| Artifact | [8629556865](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625/artifacts/8629556865), 7822 bytes, `sha256:1bfac70cb2dd38418da1115ef5b6a15a67b46bb893fd00076a1cc5e8fe2b8ffe`, expires `2026-08-25T08:10:57Z` |
| Attestation JSON | 8270 bytes, `sha256:b17932d80e0e96465e81a10d3cd34f3be361d344ea05e753215f8180cb9eb326` |
| Image A/B inspections | 5400 bytes each, identical `sha256:ebb3609b1ff0bcd9e0de3931691446bac231d355ad5eb52dc336df920c8f3f7c` |
| Binary-hash log | 212 bytes, `sha256:705e2dd4f9af9a0d1d07f3edc88eb6505c64d4fff36ed8b91826d47366f93981` |
| Empty stderr log | `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Independent verification downloaded the artifact, matched its ZIP digest,
parsed both image inspections, confirmed their byte equality, parsed both
binary hashes, and reconstructed the ordered policy object. The recomputed
policy value equals the top-level, embedded, and restart values. The report
also keeps `remoteMutationAuthorized`, `customerTrafficAuthorized`, and
`productionCutoverAuthorized` false.

### Negative calibration

| Run | Observation | Result |
| --- | --- | --- |
| [30192996455](https://github.com/cinagroup/cinatoken-rust/actions/runs/30192996455) | Two epoch-only no-cache builds produced image IDs `86a4...` and `d39f...` | Rejected; file timestamps were not fully normalized |
| [30193875952](https://github.com/cinagroup/cinatoken-rust/actions/runs/30193875952) | Config, size, and epoch creation matched, but final RootFS layer 18 differed | Rejected; complete runtime-root metadata normalization added |
| [30194108625](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194108625) | Image/config/19 layers, both binaries, live build, and runtime policy all match | Accepted for the scoped local Docker boundary |

The accepted equality is Docker image ID plus uncompressed RootFS/config
identity on one hosted runner. It is not yet a claim of byte-identical
registry-compressed layers, OCI manifest/index, SBOM, provenance, signature,
independent-host reproduction, or deployed Cloudflare digest. Those remain
mandatory release gates. Go/VPS remains authoritative and production remains
**NO-GO**.

### Independent successor reproduction

Docs-only successor
`d407e44285a71d7d3fab50db0107eeca877450db`, tree
`e162b98811fae1167e8f10547142cb9650b4a09d`, passed
[run 30194409010](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010)
and
[job 89773225412](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010/job/89773225412).

| Cross-job check | Result |
| --- | --- |
| Image / layers | Same `sha256:6a2f92415570e2b13e033b8c0d3d1acaadccf2bfa60ebd8d63faa359b687c514`; 19; all equality flags true |
| Binary/build | Both copied hashes and readiness remain `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` |
| Policy | Primary and restart remain `d62ffa86ab957048547364d69b78f8c09b7b21d87f1d97a46fa2ebaea32d5e7d` |
| Attestation JSON | Same 8270 bytes and `sha256:b17932d80e0e96465e81a10d3cd34f3be361d344ea05e753215f8180cb9eb326` |
| Artifact | [8629649636](https://github.com/cinagroup/cinatoken-rust/actions/runs/30194409010/artifacts/8629649636), 7828 bytes, `sha256:ccef6562a6fa8d2774ef196a152c55506472e6c264bffe53c8aab1443c0d7648`, expires `2026-08-25T08:20:56Z` |

Within the successor run, image A/B inspection files are byte-identical at
5401 bytes and
`sha256:a36c373cc123732e104a504353a058689b0d86b01875441969beaabe887e0b67`.
Across hosted jobs, the complete inspection member differs only in
`GraphDriver.Data` paths and `Metadata.LastTagTime`; these are local daemon
state and are excluded from `validateReproducibleImages`. The portable fields
`Id`, `Config`, and ordered `RootFS.Layers` remain exact.

## 2026-07-26 OCI Archive Reproducibility Verification

The offline contract is credential-free and Docker-independent:

```powershell
bun run check:container-runtime:oci-contract
node --check tools/verify_container_runtime_oci.mjs
node --check tests/container-runtime-oci-gate.test.mjs
actionlint .github/workflows/container-runtime-oci.yml
```

The Bun suite passes 8/8 tests with 61 expectations. It constructs a minimal
OCI fixture and proves descriptor/blob size and digest checks, gzip/diffID
verification, exact runtime config, epoch history, final-layer metadata,
orphan-blob rejection, CLI mode separation, and complete A/B identity.

The Linux-only gate is:

```bash
node tools/verify_container_runtime_oci.mjs \
  --archive-a /tmp/container-runtime-oci/container-runtime-a.tar \
  --archive-b /tmp/container-runtime-oci/container-runtime-b.tar \
  --json
```

It passed for candidate
`383f53f5559674a9947b1939993ef2d9bdf0dd6a`, tree
`3ced752e73b6e82faaa29ceff85dc1bad3e012cf`, in
[run 30196543635](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635)
and
[job 89778965995](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/job/89778965995).

| Field | Accepted value |
| --- | --- |
| BuildKit | Two independent daemon instances, `v0.31.2`, pinned image `sha256:2f5adac4...` |
| Buildx / Docker | `v0.35.0` (`a319e5b...`) / Engine `28.0.4` |
| Archive A/B | 10,378,752 bytes each; `sha256:bdd67bd4335a922081e35fe344fb481599730ec37a3833d17fea85407852fb7e` |
| OCI index | `sha256:258828d41403fa220231c18327e83f9451978bec296b9aef1fd0003f1ea3cc80` |
| Manifest / config | `sha256:84ff02142ea078cb8ad3fa496c2a4ad49f001c9b1c3a08ab1e4d394a78bd5aaa` / `sha256:7b1326fde55626bb8b5770fa88418eafe610d17f737c1f3fb1cb653362044b51` |
| Platform / layers | `linux/amd64`, epoch creation, 19 exact compressed layers and 19 exact diffIDs |
| Runtime binary | `1ec31f049fed4aef27770cadde470e69b63e55b35dd53fa5721ee1af71112910` |
| Verifier report | 5223 bytes, `sha256:d87b6ec6fd08593ee8fc652ef0b51739797701f04c22a8c76bf17a9cb8cb8120` |
| Verifier stderr | Empty, `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Artifact | [8630296572](https://github.com/cinagroup/cinatoken-rust/actions/runs/30196543635/artifacts/8630296572), 20,767,686 bytes, `sha256:8ccbf80f44f8d134579b89f4cde8806d7f1460ee33524b27244ee5c8ed4d8014`, expires `2026-08-25T09:31:03Z` |

Independent verification range-downloaded the retained artifact, reconstructed
the exact ZIP digest, extracted both archives, rehashed every OCI blob and both
tar files, recomputed all diffIDs, checked the final-layer tree, and reproduced
all equality flags.

[Run 30195875838](https://github.com/cinagroup/cinatoken-rust/actions/runs/30195875838)
is retained static negative calibration: GitHub rejected an unavailable
job-level `runner` context before any job started. The corrected file passes
`actionlint`.

The report intentionally records generated SBOM/provenance and vulnerability
scan as absent, vulnerability counts as null, and signature, registry
readback, Cloudflare deployment digest, independent-runner reproduction,
transparency/WORM, P5 eligibility, remote mutation, customer traffic and
production cutover as false. This is OCI reproduction evidence only. Go/VPS
remains authoritative and production remains **NO-GO**.
