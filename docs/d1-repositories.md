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
  lifecycle mutations; and
- the default-off 0045 Container observer retry event, exact dead-letter
  readback, and event-plus-admin-audit D1 batch. The repository contains no
  direct operation, billing, user, token, channel, DO, provider, or R2 mutation
  for this command; the observer transition is owned by the migration trigger.

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
