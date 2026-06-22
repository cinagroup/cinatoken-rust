# Production Readiness Matrices

Date: 2026-06-22

Status: companion evidence matrix for
`docs/production-migration-execution-plan.md`.

## Purpose

This file tracks the concrete evidence required to migrate from the Go/VPS
deployment to the Rust/Cloudflare deployment. The execution plan defines gates;
this file defines the matrices that those gates consume.

Source inputs inspected for this revision:

- `C:\cinagroup\cinatoken\router\relay-router.go`
- `C:\cinagroup\cinatoken\router\video-router.go`
- `C:\cinagroup\cinatoken\router\api-router.go`
- `C:\cinagroup\cinatoken\router\dashboard.go`
- `C:\cinagroup\cinatoken\model\main.go`
- `C:\cinagroup\cinatoken\constant\channel.go`
- `C:\cinagroup\cinatoken\relay\channel`
- `wrangler.toml`
- `crates/worker/src/lib.rs`
- `crates/worker/src/relay.rs`

Cloudflare references refreshed on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Wrangler configuration:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Compatibility dates:
  <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- Workers observability:
  <https://developers.cloudflare.com/workers/observability/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>
- Gradual deployments:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>
- Rollbacks:
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>

## Status Legend

| Status | Meaning |
| --- | --- |
| Done | Implemented and covered by local tests or docs evidence. |
| Partial | Some implementation exists, but live evidence or parity is missing. |
| Planned | Required for production but not implemented in Rust yet. |
| Blocked | Cannot proceed until a prerequisite is implemented or external data exists. |
| Deferred | Not part of the first production cutover scenario. |

Gate labels:

- G0: inventory freeze
- G1: Cloudflare staging foundation
- G2: data dry run
- G3: relay parity
- G4: billing parity
- G5: admin/frontend parity
- G6: observability/security
- G7: canary
- G8: cutover
- G9: post-cutover hardening

## Evidence Model

Every production-ready row should eventually carry:

- source evidence: Go route/model/provider/config location;
- Rust evidence: source file, test, or migration file;
- live evidence: staging smoke log, request ID, or dashboard proof;
- data evidence: row counts, hashes, import result, or rollback bundle;
- rollback evidence: how to return authority to Go/VPS.

Do not mark a row `Done` for production solely because local unit tests pass.
Local tests can satisfy implementation evidence, but live staging evidence is
required for G1-G8 decisions.

## Gate Evidence Matrix

| Gate | Required Matrix Rows | Current Status | Next Evidence |
| --- | --- | --- | --- |
| G0 | Route, provider, table, secret, config inventory | Partial | Fill this file with real production row counts and environment inventory. |
| G1 | Cloudflare binding/config checklist | Partial | Deploy staging Worker with real D1/KV/R2/Queue IDs and generated types. |
| G2 | Table migration matrix | Partial | Run real source export/import/verify against staging D1. |
| G3 | Relay route and provider matrices | Partial | Run live non-stream and SSE provider smoke tests. |
| G4 | Billing matrix | Partial | Expand Go/Rust fixtures and run shadow settlement report. |
| G5 | Admin/frontend route matrix | Planned | Deploy Pages/admin staging and smoke operator flows. |
| G6 | Observability/security matrix | Partial | Prove logs, traces, alerts, WAF/rate limits, redaction, and runbooks. |
| G7 | Canary matrix and rollback runbook | Planned | Rehearse rollback and run internal-token canary. |
| G8 | Cutover evidence checklist | Planned | Capture final export, DNS/route plan, freeze window, and owner sign-off. |
| G9 | Decommission matrix | Planned | Post-cutover audit, cost report, and VPS decommission plan. |

## Route Readiness Matrix

The first production migration should prefer Scenario A from the execution
plan: relay-only beta. Admin, payments, async tasks, and long-tail media routes
should not be cut over until their own rows are proven.

| Route Family | Source Evidence | Rust Status | Body/Stream Mode | Gate | Next Evidence |
| --- | --- | --- | --- | --- | --- |
| Public status and setup: `/api/status`, `/api/setup`, static content endpoints | `api-router.go` | Partial: `/api/status` exists; setup/content not migrated | JSON/read-only | G1/G5 | Decide which public dashboard metadata must move before Scenario B. |
| Relay model list: `GET /v1/models`, `GET /v1/models/:model` | `relay-router.go` | Partial: `GET /v1/models` exists; model retrieve is not complete | JSON | G3 | Add provider-aware retrieve/list parity and live smoke. |
| Gemini model list: `GET /v1beta/models`, `/v1beta/openai/models` | `relay-router.go` | Planned | JSON | G3 | Add only if required for first customer canary. |
| Playground: `POST /pg/chat/completions` | `relay-router.go` | Planned | JSON | G5 | Defer until admin/frontend staging exists. |
| OpenAI chat/completions: `/v1/chat/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI completions: `/v1/completions` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live upstream smoke with billing shadow report. |
| OpenAI responses: `/v1/responses` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live smoke for response usage and error mapping. |
| Responses compaction: `/v1/responses/compact` | `relay-router.go` | Planned | JSON | G3/G4 | Add route only after base Responses parity is proven. |
| Moderations: `/v1/moderations` | `relay-router.go` | Planned | JSON | G3/G4 | Decide first-canary priority; add usage/error fixture. |
| Embeddings: `/v1/embeddings`, `/v1/engines/:model/embeddings` | `relay-router.go` | Partial: `/v1/embeddings` implemented | Bounded JSON request/response | G3/G4 | Add engines alias if still required; live batch-size smoke. |
| Image generations: `/v1/images/generations` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, bounded/stream response | G3/G4 | Live image smoke and large response policy evidence. |
| Image edits and legacy edits: `/v1/images/edits`, `/v1/edits` | `relay-router.go` | Planned | Multipart or JSON depending provider | G3/G4 | Block until multipart/raw body modes are implemented. |
| Image variations and files/fine-tunes not implemented in Go | `relay-router.go` | Deferred | Large body/file | G3 | Keep explicit 501/unsupported behavior documented. |
| Audio speech: `/v1/audio/speech` | `relay-router.go` | Partial: JSON passthrough implemented | Bounded JSON request, unparsed audio/SSE response | G3 | Live binary/audio-event smoke and audit policy evidence. |
| Audio transcription/translation: `/v1/audio/transcriptions`, `/v1/audio/translations` | `relay-router.go` | Blocked | Multipart/raw upload | G3/G4 | Implement multipart/raw request modes before enabling. |
| Anthropic Messages: `/v1/messages` | `relay-router.go` | Partial: JSON and SSE implemented | Bounded JSON request, streaming response | G3/G4 | Live Anthropic smoke and billing shadow report. |
| Native Gemini: `/v1beta/models/*path`, `/v1/models/*path` aliases | `relay-router.go`, Rust path parser | Partial: generate/stream/embed/count routes implemented | Bounded JSON request, streaming response for stream action | G3/G4 | Live Gemini smoke for generate, stream, embed, and countTokens. |
| OpenAI realtime: `/v1/realtime` | `relay-router.go` | Planned | WebSocket | G7 | Decide Durable Object/service fallback before migration. |
| Midjourney: `/mj/*`, `/:mode/mj/*` | `relay-router.go` | Planned | Task + images + uploads | G7 | Queue/R2 task design, image proxy policy, billing replay tests. |
| Suno: `/suno/submit/:action`, `/suno/fetch`, `/suno/fetch/:id` | `relay-router.go` | Planned | Async task | G7 | Queue/Workflow task design and idempotent polling. |
| Video OpenAI-compatible: `/v1/videos`, `/v1/video/generations`, `/v1/videos/:id/remix` | `video-router.go` | Planned | Async task + binary content | G7 | Queue/R2 artifact plan and task billing replay tests. |
| Kling/Jimeng video routes | `video-router.go` | Planned | Async task + provider conversion | G7 | Provider-specific conversion fixtures and task replay tests. |
| Dashboard billing usage: `/dashboard/billing/*`, `/v1/dashboard/billing/*` | `dashboard.go` | Planned | Token-auth read-only | G5/G4 | Decide whether dashboard compatibility stays on Go during Scenario A. |
| User auth/profile/payment/checkin/OAuth/Passkey/2FA | `api-router.go` | Planned | Session/JSON/security-sensitive | G5/G6 | Build auth/session strategy and forced re-auth policy if needed. |
| Channel admin | `api-router.go` | Planned | Admin JSON + secret access | G5/G6 | D1 APIs, secret redaction, key reveal controls, admin audit. |
| Token admin/user token management | `api-router.go` | Planned | User JSON + secret access | G5/G6 | D1 APIs, cache invalidation, key reveal controls. |
| Logs, quota data, usage | `api-router.go` | Planned | Query/read-heavy | G5/G6 | Queue/R2/archive strategy and query indexes. |
| Models, vendors, prefill groups | `api-router.go` | Planned | Admin JSON | G5 | D1 schema/import and operator UI smoke. |
| Redemptions, topups, subscriptions, payment webhooks | `api-router.go` | Planned | Payment/idempotent writes | G4/G5/G6 | Signature verification, replay tests, double-credit prevention. |
| Custom OAuth provider management | `api-router.go` | Planned | Root-admin JSON + secrets | G5/G6 | SSRF validation, secret storage policy, admin audit. |
| Performance, ratio sync, deployments/io.net | `api-router.go` | Planned | External API/ops | G7 | Keep on Go or move behind service/Workflow escape hatch. |

## Provider And Channel Matrix

Source channel constants currently span OpenAI-compatible text, native
provider APIs, rerank, task/media providers, deployments, and special
subscription-backed credentials. Rust production should cut over by provider
family rather than by channel number alone.

| Provider Family | Source Channel Types | Rust Status | Required Evidence |
| --- | --- | --- | --- |
| OpenAI-compatible direct/custom/proxy families | 1, 3, 6-13, 20-23, 25, 27, 31, 40, 42-48, 53 and related adapters | Partial | URL mapping, header mapping, model mapping, usage parser, error mapping, live smoke per first-canary provider. |
| Anthropic native | 14 | Partial | Live Messages non-stream/SSE smoke, cache token usage parity, error mapping. |
| Gemini native | 24 | Partial | Live generate/stream/embed/batch/count smoke, path alias parity, usageMetadata parity. |
| Jina rerank | 38 | Partial | Live `/v1/rerank` smoke, request estimate, usage parser evidence. |
| Cohere rerank | 34 | Partial | Live `/v1/rerank` smoke, request/response transform parity, billed unit usage evidence. |
| Baidu/Zhipu/Ali/Tencent/Xunfei/360/VolcEngine regional adapters | 15-19, 23, 45, 46 | Planned | Adapter fixtures, auth headers, error normalization, usage parser parity. |
| AWS/Vertex AI/Cloudflare Workers AI | 33, 41 and Cloudflare adapter | Planned | Credential/binding strategy, region/project config, usage parser, live smoke. |
| Ollama/Xinference/self-hosted | 4, 47 | Planned | Network reachability model; Cloudflare Worker may need service fallback or Tunnel. |
| Dify/Coze/FastGPT/application APIs | 22, 37, 49 | Planned | App-specific request/response fixtures and billing semantics. |
| Midjourney/Suno/Kling/Jimeng/Vidu/Sora/Replicate/video task providers | 2, 5, 36, 50-52, 54-56 | Planned | Queue/R2 task architecture, callback/polling idempotency, artifact retention. |
| Codex subscription-backed channel | 57 | Planned | Credential refresh flow, protected identity preservation, audit logging. |

## Data And Table Matrix

Source `model/main.go` auto-migrates the following production-relevant models.
Current Rust D1 coverage is intentionally smaller than the Go schema; do not
cut over non-covered table families until the target schema and import/verify
steps exist.

| Source Model/Table Family | Production Criticality | Current Rust Coverage | Required Migration Evidence |
| --- | --- | --- | --- |
| `User` | P0 | Partial D1 core | Row count/hash, quota fields, role/status, group, OAuth IDs, stripe customer, deletion handling. |
| `Token` | P0 | Partial D1 core | Key handling, quota fields, model limits, IP allowlist, token group, expiry/status, cache invalidation. |
| `Channel` | P0 | Partial D1 core | Provider type, base URL, keys, models, groups, status, weight/priority, key encryption/redaction policy. |
| `Ability` | P0 | Partial D1 core | Group/model/channel mapping, priority/weight/tag parity, provider-family filtering. |
| `Option` | P0 | Partial D1 core | Billing expressions, group ratios, rate limits, feature flags, security/payment settings. |
| `Log` | P0/P1 | Partial relay audit logs | Recent queryable D1 logs plus Queue/R2 archive plan, request/upstream ID preservation. |
| `QuotaData` | P1 | Planned | Aggregation import or recomputation strategy, dashboard parity. |
| `Model`, `Vendor`, `PrefillGroup`, `Setup` | P1 | Export-supported, D1/API incomplete | Admin schema, import, operator smoke, frontend display parity. |
| `TopUp`, `Redemption` | P1 | Planned | Payment/accounting import, idempotency, double-credit prevention, refund/replay tests. |
| `SubscriptionPlan`, `SubscriptionOrder`, `UserSubscription`, `SubscriptionPreConsumeRecord` | P1 | Partial billing foundation, schema incomplete | Plan/order/subscription import, settlement ownership decision, shadow billing report. |
| `PasskeyCredential`, `TwoFA`, `TwoFABackupCode` | P1/P2 | Planned | Migrate securely or force re-auth/reset; secret/hash handling documented. |
| `CustomOAuthProvider`, `UserOAuthBinding` | P1/P2 | Planned | Provider secret migration, SSRF checks, state replay protections, forced rebind option. |
| `Checkin` | P2 | Planned | Decide whether history is imported or reset; quota award idempotency. |
| `Midjourney`, `Task` | P2/G7 | Planned | Queue/R2 task state, provider polling, billing replay, artifact retention. |
| `PerfMetric` | P2 | Planned | Decide whether to import historical metrics or start fresh with Workers logs/traces. |

## Cloudflare Binding And Secret Matrix

Current `wrangler.toml` is development-shaped. Production readiness requires
real IDs, deliberate environments, generated types, and out-of-band secrets.

| Binding/Config | Current State | Production Target | Evidence |
| --- | --- | --- | --- |
| Config format | `wrangler.toml` | Prefer `wrangler.jsonc` or documented TOML exception | Config migration PR or exception note. |
| `compatibility_date` | `2026-06-17` | Keep current; review periodically | Date review recorded before deploy. |
| `compatibility_flags` | `nodejs_compat` enabled | Keep enabled | `wrangler types` generated Env after binding changes. |
| Observability | Enabled with `head_sampling_rate = 1` | Staging/prod sampling policy documented | Logs/traces visible in staging. |
| `DB` D1 | Placeholder UUID | Separate staging/prod D1 IDs | Staging migrations applied and `/api/status` D1 true. |
| `CACHE_KV`, `CONFIG_KV` | Placeholder IDs | Real namespaces or remove unused bindings | Binding checklist and code usage decision. |
| `FILE_BUCKET` | Named bucket, no code usage | Real R2 bucket plus retention policy | R2 smoke for upload/read/delete if enabled. |
| `LOG_QUEUE`, `TASK_QUEUE` | Declared producers, no code usage | Real queues with consumers/DLQ when async moves | Queue producer/consumer smoke and DLQ alert. |
| Upstash vars/secrets | Runtime env driven | Separate staging/prod credentials | Secret names, no values, rotation owner. |
| Provider API keys | D1 channel keys | Encrypted/redacted storage policy | Admin key reveal audit and redaction tests. |
| Payment/OAuth/Turnstile/JWT/session secrets | Go/VPS-owned today | Cloudflare secrets or forced re-auth/defer plan | Secret inventory without values. |
| AI Gateway ID | Empty var | Real ID or direct-provider policy | Provider matrix records chosen path. |

## Billing And Quota Matrix

Billing is a cutover blocker. Rust can relay traffic before it owns paid
settlement only if shadow mode proves deltas.

| Billing Area | Rust Status | Required Evidence |
| --- | --- | --- |
| Tiered expression parser/executor | Partial | Golden fixtures across real production expressions. |
| `billing_expr|||request_rule_expr` split | Partial | Go/Rust fixture coverage and metadata redaction evidence. |
| Request-time token estimate | Partial | Go `TokenCountMeta` parity for tokenizer, image, audio, cache categories. |
| Streaming usage reconciliation | Partial | Live SSE smoke with final usage and refund-on-missing-usage behavior. |
| Non-stream usage reconciliation | Partial | Live JSON smoke for each first-canary provider. |
| Reserve/refund/additional settlement | Partial | Success, upstream error, timeout, client disconnect, missing usage tests. |
| Non-tiered billing | Planned | Source-compatible settlement path and fixtures. |
| Subscription/pre-consume records | Planned | Schema, import, idempotency, replay tests. |
| Payment balance mutations | Planned | Webhook signature validation, idempotent event storage, double-credit prevention. |
| Shadow billing report | Planned | Production-shaped request sample with agreed delta threshold. |

## Observability, Security, And SLO Matrix

| Area | Required Production Evidence | Current Status |
| --- | --- | --- |
| Structured logs | Request ID, user/token fingerprint, endpoint, model, channel, upstream status, latency, quota delta, billing mode | Partial |
| Workers Logs/Traces | Staging and prod sampling policy; visible traces during smoke | Partial |
| Alerts | 5xx, D1 failures, Redis failures, queue lag, billing mismatch, payment replay failures | Planned |
| Redaction | No raw keys, bearer tokens, payment secrets, OAuth secrets, or full provider credentials in logs | Partial |
| CORS/WAF/rate limits | Environment-specific allowlist and abuse protection | Planned |
| SSRF controls | Any user-controlled URL fetch path is validated | Planned |
| Admin audit | Every sensitive admin mutation writes actor/action/target/request ID | Planned |
| Rollback | DNS/route/feature rollback rehearsed; Rust state preserved for investigation | Planned |
| SLOs | Auth overhead, first-byte overhead, stream duration, D1 write latency, error budget, queue lag, billing delta | Planned |
| Load test | Mixed 500-concurrency or agreed production-shaped equivalent | Planned |

## Update Rules

1. Update this file when adding a route, provider, table, binding, or billing
   behavior.
2. Keep status conservative: `Partial` is the default until live evidence
   exists.
3. Add links to smoke logs or verification docs instead of pasting secrets or
   raw provider responses.
4. Never store production export bundles, API keys, channel keys, OAuth
   secrets, payment secrets, or raw bearer tokens in this repository.
5. If a billing expression implementation changes, first read
   `C:\cinagroup\cinatoken\pkg\billingexpr\expr.md` and add Go/Rust parity
   evidence before updating production status.
