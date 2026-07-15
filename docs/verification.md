# Verification

Last checked: 2026-07-13

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
  cinatoken-rust-staging --wrangler-env staging --json`: passed and emitted
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
