# Worker D1 Repositories

The Worker crate now keeps Cloudflare D1 SQL behind `crates/worker/src/d1_repositories.rs`.

This module owns Worker-specific storage operations:

- token and user authentication row lookup;
- best-effort token status updates for expired or exhausted tokens;
- OpenAI-compatible channel selection from `abilities` first, then channel CSV fallback;
- billing option lookup for Go-compatible `billing_setting.*` maps and group
  ratio maps;
- cached-auth quota-state refresh before validation;
- tiered-expression quota reserve, refund, and settlement mutation for user,
  token, and channel counters with compensation on later-step failures;
- token access-time updates;
- user request-count increments;
- relay audit log insertion;
- stable-cursor discovery of open Realtime usage reconciliations;
- revision-fenced, idempotent Realtime reconciliation settlement/refund batches
  that retain quarantine provenance and write financial plus root audit state
  atomically;
- generation-fenced Container reconciliation status/list reads and observer
  lifecycle mutations;
- the default-off 0045 Container observer retry event, exact dead-letter
  readback, and event-plus-admin-audit D1 batch. The repository contains no
  direct operation, billing, user, token, channel, DO, provider, or R2 mutation
  for this command; the observer transition is owned by the migration trigger;
  and
- a future Container operation schema-readiness helper for the trigger-only
  0046 enforcement boundary. The helper requires the 0040/0041/0042/0046
  migration records and all four identity, initial-state, terminal
  event/outbox, and recovery-predecessor trigger names. It is compiled and
  source-tested but has no production call site yet; every Container operation
  path remains default-off and unwired, so this helper is not an active runtime
  gate.

`relay.rs` remains responsible for request parsing, auth validation policy,
cache orchestration, upstream forwarding, and audit payload construction. D1
remains the source of truth; Upstash Redis read-through cache is an acceleration
layer only.

Keeping this boundary inside the Worker crate avoids making pure Rust crates
depend on Cloudflare Worker runtime types while still removing raw SQL from the
relay control flow. If a non-Worker runtime is added later, it can implement the
same repository-shaped operations without changing relay orchestration.

The reconciliation HTTP module passes typed mutation and audit values into the
repository. It does not construct D1 prepared statements. Frozen billing
expression snapshots remain the only pricing input, and the default-off runtime
gate is enforced above this repository boundary.

Migration 0046 does not add a pricing lookup, recalculate a billing expression,
or repair financial rows. The financial writer still owns one ordered D1 batch
for immutable event, outbox, operation, billing, and accounting statements, and
settlement must continue from the frozen reservation snapshot. The separate
read-only enforcement audit binds aggregate D1 preconditions to a signed
deployment-inventory hash; it does not grant mutation authority or replace
remote version and trigger-SQL readback.

Migration 0047 adds a separate provider-egress schema-readiness helper. It
requires the 0047 ledger row plus the immutable grant table and its insert,
update, and delete trigger names. It does not replace the 0046 helper: 0046
proves historical financial-terminal enforcement, while 0047 proves the later
pre-send provenance schema.

New tiered reservation writes are no longer allowed to carry an empty snapshot.
The repository parses the canonical serving-group map, validates every durable
`TieredBillingSnapshot`, binds its expression hash to the reservation contract,
requires byte-for-byte equality with its own canonical reserialization, and
rejects cross-group differences in model, expression/version, request facts,
evaluation instant, QuotaPerUnit, estimate, or tier. The frozen instant must be
a non-negative Unix second representable through year 9999. The relay owns
request projection and serialization; D1 owns immutable storage. Historical
empty rows remain readable for quarantine and migration accounting and are not
silently upgraded.
