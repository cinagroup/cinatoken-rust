# Parity Implementation Backlog (sequenced)

Date: 2026-06-25

Status: the executable ordering of the 15 `docs/source-*.md` parity specs. The
parity docs say *what* must match Go; this file says *in what order* to build it,
*what blocks what*, and *which items are hard cutover blockers*. It is the bridge
from the gate-driven `docs/production-migration-execution-plan.md` to day-to-day
implementation.

How to read: items are grouped into phases that map to the cutover scenarios.
Within a phase, items are listed in dependency order. Each item names its source
parity doc, gate, and dependencies. `BLOCKER` marks a hard cutover blocker (must
be done + proven before the phase's traffic).

## Cutover Scenarios → Gates (recap)

- **Scenario A — Relay-only beta**: G1, G2-subset, G3, G4-shadow, G6-core.
- **Scenario B — + Admin core**: adds G5.
- **Scenario C — + Payments/billing ownership**: adds G4-apply, G7-payments.
- **Scenario D — Full platform**: adds G7-async/long-tail, realtime.

## Hard Cutover Blockers (the short list)

These cause wrong charges, double-credit, or auth/selection failure — none may be
deferred past their phase:

1. **Non-tiered billing settlement** — Rust logs `quota=0/billing_pending` today;
   the default billing path. `source-pricing-ratio-parity.md`. (G4, Scenario A)
2. **Missing-usage SSE estimate fallback** — streams without usage settle to 0/
   wrong. `source-usage-parsing-parity.md`. (G4, Scenario A)
3. **CAS idempotency** for payments (conditional credit) and tasks (conditional
   status) — prevents double-credit/double-refund.
   `source-payment-idempotency-parity.md`, `source-task-lifecycle-parity.md`.
   (G7/C, G7/D)
4. **KV/DO mutable-flow state** — Turnstile flag, secure-verified-at, OAuth state,
   Passkey challenge, 2FA-pending cannot live in the immutable HMAC cookie.
   `source-security-middleware-parity.md`, `source-oauth-2fa-passkey-parity.md`.
   (G5, Scenario B)
5. **0004 schema fixes** — abilities `tag` + composite uniqueness, OAuth-id +
   log search indexes, before import. `source-d1-schema-parity.md`. (G2)
6. **Native rate-limit + DO atomic state** — remove Upstash from the hot path.
   migration-plan §21.1/§21.2. (G1/G3)

## Critical-Path Dependency Chain

```text
G1 foundation (bindings, secrets, types, Rate Limit binding, DO ns, 0004 schema)
   -> token auth (key extraction, admin pin, IP, group)
      -> channel selection (priority/weight/smoothing, affinity-on-DO, normalize)
         -> retry/auto-ban (CAS ban + selection-cache invalidation)
      -> usage parsing (final-chunk, ValidUsage, missing-usage fallback)
         -> token estimation (tiktoken cl100k+o200k, image, audio)
            -> billing non-tiered (default) + tiered (expr)  [feeds settlement]
   -> shadow billing -> Scenario A canary
Scenario A -> KV/DO flow-state + session (New-Api-User, roles) -> admin CRUD
   + cache invalidation + CORS fail-closed + frontend assets -> Scenario B
Scenario B -> payment signature+CAS credit + subscriptions -> Scenario C
Scenario C -> Workflows tasks + R2 + SSRF wiring + WebAuthn runtime -> Scenario D
```

## Phase 0 — Foundation (G1) — blocks everything

| # | Item | Gate | Source | Depends |
| --- | --- | --- | --- | --- |
| 0.1 | Staging Worker with real D1/KV/R2/Queue IDs, env blocks, generated types, secrets | G1 | config-checklist | — |
| 0.2 | Stand up Rate Limiting binding + a Durable Object namespace (atomic state) | G1 | migration-plan §21.1/§21.2 | 0.1 |
| 0.3 | `BLOCKER` Apply `0004_schema_parity.sql` to staging D1 (abilities tag/uniqueness after dedup, OAuth-id/log indexes, tokens.name) | G2 | d1-schema-parity | 0.1 |
| 0.4 | D1 Sessions API read path + read-your-writes bookmark | G1 | migration-plan §21.3 | 0.1 |
| 0.5 | Shared `FormatMatchingModelName` normalizer (used by selection, token-limit, pricing) | G3 | channel-selection / pricing-ratio | — |

## Phase 1 — Relay MVP (Scenario A: G3 + G4-shadow + G6-core)

Build in this order; each depends on the previous unless noted.

| # | Item | Gate | Source | Depends |
| --- | --- | --- | --- | --- |
| 1.1 | Token auth parity: WS/Anthropic/Gemini/mj key extraction, `sk-<key>-<channelid>` admin pin (non-admin 403), IP CIDR allowlist, group authorization | G3 | auth-session | 0.1 |
| 1.2 | Channel selection: priority sort + weighted-random **smoothing** (exact), retry→priority mapping, pre-selection gates (specific-channel, token model-limit) | G3 | channel-selection | 0.5, 1.1 |
| 1.3 | Affinity on Durable Object (preferred-channel reuse, record-on-success, fail-open) | G3 | channel-selection | 0.2, 1.2 |
| 1.4 | Auto cross-group retry state machine (exhaust priorities → advance group) | G3 | channel-selection | 1.2 |
| 1.5 | Retry loop (RetryTimes+1) + `shouldRetry` rule order + `use_channel` chain | G3 | retry-autoban | 1.2 |
| 1.6 | Auto-ban: `ShouldDisableChannel` (status + keyword AC match), CAS ban off-path (wait_until/DO), **invalidate selection cache**, AutoDisabled vs manual, recovery | G3 | retry-autoban | 1.5, 0.2 |
| 1.7 | `BLOCKER` Usage parsing: final-chunk (audio second-to-last), `ValidUsage` gate, **missing-usage estimate fallback** (+toolCount*7), stream_options strip/forward/synthesize matrix | G3/G4 | usage-parsing | — |
| 1.8 | Token estimation: tiktoken **cl100k + o200k**, OpenAI overhead (8/3/3/3), image algorithm (patch/tile), audio duration, media fallbacks; bundle/CPU budget (vocab from KV/R2, `cpu_ms`) | G4 | token-estimation | — |
| 1.9 | `BLOCKER` Non-tiered billing: three-way branch (per-call/tiered/per-token), full ratio set, default-37.5 tri-state, hardcoded completion table, options-backed cached maps (CONFIG_KV/DO + invalidation) | G4 | pricing-ratio | 1.7, 1.8 |
| 1.10 | Tiered billing: engine contract (rounding half-away-from-zero, single round at group step), version dispatch, AST exclusion, request-rule split; golden fixtures (rounding, time, image/audio, math, fuzz, gjson `param()`, cross-tier) | G4 | billing-expr | 1.7, 1.8 |
| 1.11 | Native rate limits (Rate Limiting binding) per token/IP/route; retire `ct:rate:*`; 429 via Analytics Engine | G3/G6 | migration-plan §21.1 | 0.2 |
| 1.12 | Shadow billing mode (Go applies, Rust computes+logs delta) + reserve/refund/additional under success/error/timeout/disconnect/missing-usage | G4 | billing-expr / billing-parity-runbook | 1.9, 1.10 |
| 1.13 | Provider adapter waves: generic OpenAI (1,3,6-10,12,13,19,20,22,31,47), Anthropic(14), Gemini(24), Jina(38), Cohere(34); dedicated OpenAI-like + Moonshot(25 Claude bridge) next | G3 | provider-channel-matrix | 1.5, 1.7 |
| 1.14 | Live SSE/non-stream smoke per provider family (first byte, final/estimated usage, `[DONE]`, abort settlement, upstream id) | G3 | route-provider-runbook | 1.13, 1.12 |

Scenario A gate: G1, G2-subset (token/channel/option/ability/log import verified),
G3 smoke, G4 shadow clean, G6 core (rate limit + redaction).

## Phase 2 — Admin + Frontend (Scenario B: G5)

| # | Item | Gate | Source | Depends |
| --- | --- | --- | --- | --- |
| 2.1 | `BLOCKER` KV/DO mutable-flow state layer (single-use, short TTL, delete-on-read) — the shared substrate for 2.2–2.6 | G5/G6 | security-middleware / oauth-2fa-passkey | 0.2 |
| 2.2 | Session/role enforcement: `New-Api-User` policy, access-token path decision, AdminAuth/RootAuth, admin audit on every mutation | G5 | auth-session | 0.1 |
| 2.3 | Secure-verification step-up (300s, KV/DO) gating channel key reveal; `/api/verify` re-auth | G5/G6 | security-middleware | 2.1, 2.2 |
| 2.4 | Turnstile server-side siteverify (KV/DO once-per-session flag) on register/login/reset/email/checkin | G6 | security-middleware | 2.1 |
| 2.5 | CORS fail-closed (env `CORS_ORIGINS`, no credentialed wildcard, SSE expose-headers) | G6 | security-middleware | 0.1 |
| 2.6 | Admin CRUD APIs (token/channel/user/log/option/model/vendor) + cache invalidation on mutation (token/channel/ability/ratio/option) | G5 | route-inventory / admin-frontend-runbook | 2.2 |
| 2.7 | Frontend Workers Static Assets build/deploy (same-origin), SPA fallback, API-path precedence, bundle redaction | G5 | migration-plan §21.6 | 0.1 |

Scenario B gate: G5 report (operator CRUD without DB edits, auth/session smoke,
cache invalidation, audit, frontend deploy).

## Phase 3 — Payments + Billing Ownership (Scenario C: G4-apply, G7-payments)

| # | Item | Gate | Source | Depends |
| --- | --- | --- | --- | --- |
| 3.1 | `BLOCKER` Payment idempotency: per-provider signature verify → `payment_events` event-dedup → `topups` conditional credit (`WHERE status=0`, rows-affected) | G7 | payment-idempotency | 2.x, 0.3 |
| 3.2 | Per-provider quota formulas (truncate not round), amount/currency/product/env match, replay→200 no-op | G4/G7 | payment-idempotency | 3.1 |
| 3.3 | `ValidateRedirectURL` + `TrustedRedirectDomains` for callbacks | G6 | ssrf-parity | 3.1 |
| 3.4 | Subscriptions (subscription_orders CAS, funding-source settlement) | G4/G7 | payment-idempotency / billing-expr | 3.1 |
| 3.5 | Flip billing to Rust-apply after shadow passes thresholds; paid canary with strict abort | G4 | billing-parity-runbook | 1.12, 3.x |

Scenario C gate: G4 apply, G7 payments (no double-credit), paid canary clean.

## Phase 4 — Async / Long-tail (Scenario D: G7-async)

| # | Item | Gate | Source | Depends |
| --- | --- | --- | --- | --- |
| 4.1 | Task orchestration via **Workflows** (one instance/task, sleep/sleepUntil poll + timeout), or Cron+Queue | G7 | task-lifecycle | 0.1 |
| 4.2 | `BLOCKER` Task CAS status transitions (rows-affected) + refund/settle only on won; three-stage billing idempotent across retries | G7 | task-lifecycle | 4.1 |
| 4.3 | R2 artifact storage (large results; optional re-host external URLs); timeout sweep Cron (legacy no-refund) | G7 | task-lifecycle | 4.1 |
| 4.4 | TaskAdaptor per-provider waves (Suno, video, MJ) | G7 | task-lifecycle / provider-channel-matrix | 4.2 |
| 4.5 | SSRF wiring on user-controlled-URL paths (webhook outbound, OAuth discovery, image/file/MJ proxy) + DNS-rebinding decision (DoH vs Container) | G6 | ssrf-parity | 2.1, 4.4 |
| 4.6 | OAuth/2FA/Passkey enrollment (KV/DO single-use state); WebAuthn runtime (WASM vs Container); forced re-enroll policy | G5 | oauth-2fa-passkey | 2.1 |
| 4.7 | Realtime `/v1/realtime` WebSocket (DO hibernation or Container bridge) | G7 | route-inventory / migration-plan §21.4 | 0.2 |
| 4.8 | Long-tail providers needing complex signing/runtime → Cloudflare Containers (AWS/Vertex/Tencent, Codex, io.net) | G7 | provider-channel-matrix / migration-plan §21.4 | 4.4 |

## Cross-Cutting (every phase)

- **Native-first**: rate limits → Rate Limiting binding; atomic state → DO; reads
  → D1 Sessions API; keep hot-path non-Cloudflare egress at zero. (§21.1–21.3)
- **Idempotency pattern**: conditional `UPDATE ... WHERE <guard>` + rows-affected
  is the one CAS pattern for payments, tasks, backup codes, timeout sweep.
- **Mutable-flow state**: one KV/DO single-use store for Turnstile/secure-verify/
  OAuth/Passkey/2FA-pending.
- **Cache invalidation**: any admin mutation invalidates token/channel/ability/
  ratio/option caches; bans invalidate selection cache.
- **Golden fixtures**: every billing/usage/selection/payment item ships Go↔Rust
  fixtures before its gate.
- **Observability/redaction**: structured logs + `usage_source`, no secret/key
  leakage, before any canary.

## Wire-In

- This backlog sequences the checklists in: route-inventory, provider-channel-
  matrix, channel-selection, retry-autoban, usage-parsing, token-estimation,
  billing-expr, pricing-ratio, payment-idempotency, task-lifecycle, auth-session,
  security-middleware, oauth-2fa-passkey, ssrf, d1-schema parity docs.
- It is the implementation companion to `docs/production-migration-execution-plan.md`
  (gates) and `docs/production-readiness-matrices.md` (evidence).
