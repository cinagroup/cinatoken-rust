# Worker D1 Repositories

The Worker crate now keeps Cloudflare D1 SQL behind `crates/worker/src/d1_repositories.rs`.

This module owns Worker-specific storage operations:

- token and user authentication row lookup;
- best-effort token status updates for expired or exhausted tokens;
- OpenAI-compatible channel selection from `abilities` first, then channel CSV fallback;
- billing option lookup for Go-compatible `billing_setting.*` maps and group
  ratio maps;
- token access-time updates;
- user request-count increments;
- relay audit log insertion.

`relay.rs` remains responsible for request parsing, auth validation policy,
cache orchestration, upstream forwarding, and audit payload construction. D1
remains the source of truth; Upstash Redis read-through cache is an acceleration
layer only.

Keeping this boundary inside the Worker crate avoids making pure Rust crates
depend on Cloudflare Worker runtime types while still removing raw SQL from the
relay control flow. If a non-Worker runtime is added later, it can implement the
same repository-shaped operations without changing relay orchestration.
