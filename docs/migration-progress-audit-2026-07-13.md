# Go/VPS To Rust/Cloudflare Migration Progress Audit

Date: 2026-07-13

## Audit Purpose

This is a requirement-level re-audit of the full migration objective, not a
summary of recently completed commits. It compares the current Go source,
`cinatoken-rust`, the tracked React/Bun frontend, the checked-out
`cinaVibeSDK` reference at `918e97480ee44e357abe99bf33c27259d6ac7ebd`, and
the production execution gates.

Evidence strength is classified as:

- **E1 Source**: code or documentation exists.
- **E2 Unit/contract**: deterministic local tests prove a bounded behavior.
- **E3 Runtime local**: release Worker/Wasm behavior is exercised in Workerd.
- **E4 Staging**: deployed Cloudflare resources and real integrations are
  archived and reconciled.
- **E5 Production**: canary, SLO, billing/data reconciliation, rollback, and
  operator approval are complete.

No E4/E5 claim is inferred from a green local gate. The Cloudflare credential
included in the migration objective is exposed and was not read or used.

## Objective Requirement Audit

| Requirement | Current evidence | Result | Missing proof |
| --- | --- | --- | --- |
| Replace the Go/VPS product with Rust/Cloudflare | Rust owns the main API/static gateway, D1 repositories, auth, administration, relay core, billing, payments, tasks, and the tracked frontend route surface | **Partial, E2-E3** | Production data migration, every enabled provider/payment workflow, staging capacity/security/SLO evidence, canary, rollback, and Go decommission |
| Include the frontend migration | React/Bun source, strict type/lint/format gates, production build, route audit, readiness UI, bundle redaction, and budget checks pass locally | **Locally wired, E2-E3** | Deployed browser hard-refresh, auth/role/session, CRUD, 2FA/Passkey, payments/callbacks, Playground, console, performance, and rollback runs |
| Rust scheduling gateway | `cinatoken-gateway` is the versioned host/path owner planner before Worker execution; negative WFP preview ownership is explicit | **Locally wired, E2-E3** | Deployed main/API/static/tenant hostname matrix, edge-auth parity, negative dispatch, traces, and rollback |
| Rust Durable Objects | RealtimeSession, TaskRunner, PasskeyCeremony, channel affinity, and WFP authority/replay DOs exist; release Workerd proves hibernatable socket restoration, authenticated Realtime reserve/refund recovery, scheduled orphan recovery, and authority replay behavior | **Runtime local, E3** | Deployed eviction/redeploy/alarm/reconnect/load, active-provider fault replay, exactly-once settlement evidence, alerting, and rollback |
| WFP Rust tenant script | Dedicated Rust/Wasm tenant and outbound crates, strict artifact manifest/uploader, central authority, outbound context validation, replay DO, and four-route egress allowlist exist | **Gated substrate, E2-E3** | Real namespace upload/readback, outbound attachment and secret ownership, dynamic context propagation, paid call, resource-fault matrix, billing/audit reconciliation, and rollback |
| AI Gateway multi-model forwarding | Provider registry, native route planner, direct and cross-model fallback, actual-serving-group billing plan, and operator readiness exist behind default-off gates | **Gated substrate, E2-E3** | Deployed per-provider route canaries, Gateway logs, usage/error/billing correlation, Queue/D1 terminal audit replay, fault injection, and rollback |
| Deploy `cinatoken.com` to Cloudflare | Production config intentionally retains resource placeholders and all high-risk cutover flags remain false | **Not approved** | Revoke/rotate exposed credential, least-privilege replacement, G1-G8 evidence, production resources/secrets, staging, canary, DNS cutover, rollback, and post-cutover observation |

The full objective is therefore not complete. The current system is suitable
for isolated staging, not an all-traffic production declaration.

## Go Product Surface Audit

### Routes And Frontend

- The canonical source route inventory is `docs/source-route-inventory.md`.
  The current route audit classifies 217 frontend calls against 320 Worker
  routes with zero explicit missing calls.
- Zero missing calls proves only that statically detected frontend requests
  have a Worker owner. It does not prove response-shape parity, browser state,
  callback origin behavior, provider health, or deployed authorization.
- The default frontend uses the Worker-owned auth, user, token, channel, model,
  log, option, payment, task, Playground, Passkey, OAuth, deployment, and
  platform-readiness APIs. The classic source remains compatibility material,
  not the production frontend target.
- Frontend provider readiness is implementation metadata. It must not be used
  as a health check or as evidence that a provider credential works.

### Provider Relay

- The capability registry covers all 53 real Go channel types exactly once.
- After this audit increment it reports **16 Ready, 14 Partial, and 23
  Deferred** types.
- Generic OpenAI compatibility remains restricted to the 14 types that the Go
  dispatcher actually sends through `openai.Adaptor`.
- Dedicated Partial providers are Ali(17), Moonshot(25), ZhipuV4(26),
  Perplexity(27), Jina(38), Cloudflare(39), SiliconFlow(40), Mistral(42),
  DeepSeek(43), VolcEngine(45), BaiduV2(46), xAI(48), and Submodel(53), plus
  Cohere rerank(34).
- Ali(17) now admits only direct DashScope Chat Completions, legacy
  Completions, current Responses, Embeddings, model-allowlisted native
  Messages, and `gte-rerank-v2`. Messages model patterns retain the source
  operator override through `ALI_ANTHROPIC_MESSAGES_MODELS`. Optional
  `X-DashScope-Plugin` is generated only from a printable, at-most-4-KiB
  server-side `channels.other` value; relay cache schema v4 invalidates older
  cached channels that do not carry it. The source's image polling/remote URL
  fetch, audio, Gemini, non-native Messages conversion, and qwen3 rerank
  protocols remain Deferred.
- VolcEngine(45) now admits only the source/current-official intersection:
  Chat Completions, Embeddings, Image Generations, and Responses at Ark v3.
  `doubao-coding-plan` is chat-only. Bot chat, TTS, rerank, image edits, and
  ordinary Messages remain rejected before reserve.
- BaiduV2(46) now admits Chat Completions at Qianfan v2, including source
  `-search` normalization and `token|appid` header separation. Source URL
  branches whose converters return not-implemented remain rejected before
  reserve.
- Neither provider is listed by Cloudflare as a native AI Gateway provider.
  Both are direct-only; AI Gateway and WFP configuration is filtered before
  quota reservation.
- Every Partial provider still needs route-specific live success/error/stream
  fixtures, bounded-response evidence, usage reconciliation, reserve/settle/
  refund proof, audit comparison, disable behavior, and Go rollback.

### Data, Billing, Auth, Payments, And Tasks

- D1 has 22 contiguous migrations and the local SQLite verifier expects 27
  business tables, 69 incremental columns, and 17 key indexes.
- Deterministic source-to-D1 reconciliation tooling exists for core entities,
  topups, Passkeys, TOTP, and backup codes. No production freeze/export/import/
  hash artifact has been supplied.
- Flat and tiered billing, maximum pre-reserve, actual-serving-group
  settlement, refunds, image request pricing, task settlement, and Realtime
  reservation ledgers have local tests. Production tokenizer/media shadows and
  provider invoices are not reconciled.
- Session auth, registration, role/status rechecks, OAuth, 2FA, Passkey,
  Turnstile, and secure verification are Worker-owned. Imported authenticator
  login and real-provider OAuth/email/WeChat evidence remain open.
- Stripe, Creem, Epay, Waffo variants, redemption, check-in, and subscription
  routes used by the tracked frontend are present. Real callback replay,
  credited-anchor reconciliation, duplicate/race evidence, and rollback remain
  required.
- Task submit/poll/CAS foundations and TaskRunner DO exist. Provider-specific
  async media conversion, live alarm replay, cron fallback, exactly-once
  settlement, artifact retention, and operational recovery remain incomplete.

## cinaVibeSDK Architecture Re-Audit

The reference checkout is unchanged at `918e97480ee44e357abe99bf33c27259d6ac7ebd`.
Its reusable design principles are still correctly applied:

1. **Long sessions belong to a hibernatable DO boundary.** RealtimeSession owns
   the client socket and durable attachment/metrics; live provider bridges are
   treated as transient and fail closed after reconstruction.
2. **Persistent coordination belongs in SQLite/D1, not global memory.** Billing
   reservations, replay markers, ceremony state, task progress, and recovery
   policy are durable and idempotent.
3. **Tenant execution is not billing authority.** The Rust WFP tenant validates
   a bounded request and forwards opaque central authority. The outbound Worker
   owns final egress policy, replay consumption, and Cloudflare authorization.
4. **Provider routing is a registry concern.** URL allowlists, request
   transforms, native Gateway eligibility, and route capabilities live in
   `crates/providers`; selection, reserve, settlement, retry, and audit remain
   central Worker responsibilities.
5. **Transport boundaries are explicit.** Service bindings/dispatch are used
   for internal Workers, DOs for stateful WebSockets, and AI Gateway only for
   reviewed provider routes. A provider being OpenAI-shaped does not make it
   Gateway-eligible.

The reference is guidance, not production proof. cinatoken-rust deliberately
keeps stronger boundaries where the reference implementation is insufficient:
WebSocket upgrade responses are preserved, WFP paid egress has a final replay
guard, provider response sizes are bounded, and request-scoped credentials are
not persisted in DO attachments.

## Production Gate Audit

| Gate | Current state | Required closure evidence |
| --- | --- | --- |
| G1 Inventory | Partial | Final enabled routes/providers/payments/options and owner approval |
| G2 Infrastructure | Partial | Production D1/KV/R2/Queues/DO/Rate Limit/Gateway/WFP IDs and readback |
| G3 Provider parity | Partial | Live matrix for every enabled channel type and route |
| G4 Data migration | Not run on production source | Freeze, export, import, counts/hashes/relationships, rollback |
| G5 Billing/payment | Partial local | Shadow thresholds, callback replay, provider invoice reconciliation |
| G6 Frontend | Local only | Deployed browser matrix, accessibility/performance, callback and rollback |
| G7 Runtime/operations | Partial local | DO/WFP/Gateway load, fault, alarm, trace, alert, SLO, and cost evidence |
| G8 Cutover | Not approved | Credential rotation, canary, DNS plan, rollback rehearsal, signatures |

`wrangler.toml` still contains `REPLACE_WITH_PRODUCTION_*` identifiers. The
production environment keeps AI Gateway fallback, WFP dispatch/transport,
Realtime, Realtime settlement/recovery, and TaskRunner gates false. This is the
correct fail-closed state.

## Ordered Continuation Plan

1. Rotate the exposed Cloudflare credential and create scoped staging and
   production credentials; do not reuse the exposed value.
2. Apply and verify all 22 D1 migrations in isolated staging, then run the full
   production-source reconciliation toolchain against a controlled snapshot.
3. Deploy the main Worker and frontend to a staging hostname and execute the
   browser/API owner matrix before enabling any paid transport.
4. Attach and read back the Rust WFP tenant/outbound topology, prove no tenant
   bearer or authority key, then run one bounded paid route at a time.
5. Run Realtime and TaskRunner eviction/alarm/provider/billing fault matrices
   with archived D1/trace/provider evidence.
6. Close G3 for each enabled provider, prioritizing currently configured Go
   channels rather than implementing unused catalog entries.
7. Run billing/payment shadows, capacity/cost/security review, canary, and the
   documented rollback rehearsal before `cinatoken.com` DNS cutover.

## Safe Conclusion

The migration has moved beyond an MVP: the deployable Rust/Cloudflare core,
React/Bun frontend, scheduling gateway, Durable Object substrate, WFP Rust
tenant/outbound boundary, and AI Gateway planner are real and locally tested.
It is still not a complete production replacement for Go/VPS. The next proof
boundary is deployed staging with rotated credentials, not another local flag
flip. Production remains **NO-GO**.
