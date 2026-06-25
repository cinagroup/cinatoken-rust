# SSRF Protection

Date: 2026-06-22

Status: standalone module, not yet wired into the Worker hot path.

The Go<->Rust parity verification (CIDR-table divergences, DNS-rebinding
decision, and the wiring gate) is in `docs/source-ssrf-parity.md`.

## Purpose

`crates/ssrf` ports the validation surface of the Go gateway's
`common/ssrf_protection.go` so the Rust/Cloudflare port can apply the same
SSRF (Server-Side Request Forgery) checks to URLs that originate from request
bodies. The Go gateway applies SSRF validation to user-controlled URLs only —

- `service/download.go` (file download / image fetch),
- `service/http_client.go` (general outbound HTTP),
- `service/webhook.go` and `service/user_notify.go` (outbound webhooks and
  notifications),
- `controller/video_proxy.go` and `relay/mjproxy_handler.go` (Midjourney image
  URLs).

Channel `base_url` is admin-configured and is **not** validated by SSRF in
either the Go or the Rust deployment; rejecting it there would block
legitimate custom provider deployments.

## Module surface

```rust
use cinatoken_ssrf::{SsrfPolicy, SsrfPolicyBuilder, SsrfError};

let policy = SsrfPolicy::strict_default();
let url = policy.validate_url("https://example.com/path")?;
```

`SsrfPolicy::strict_default()` mirrors Go `EnableSSRFProtection: true`:

- HTTP/HTTPS only.
- Ports 80/443 only.
- Private / loopback / metadata IP literals rejected (see
  [`SsrfPolicy::is_private_ip`] for the full CIDR table, ported from Go
  `privateIPv4Nets` and `privateIPv6Nets`).
- No domain allowlist or blocklist.

`SsrfPolicyBuilder` exposes the remaining knobs (`allow_private_ip`,
`allowed_ports`, `domain_allowlist`, `domain_blocklist`, `ip_block_cidrs`) for
callers that read the runtime-configured `FetchSetting` from options.

## Worker / WASM limitation (intentional)

Cloudflare Workers do not expose a synchronous DNS resolver. The Go gateway's
`ApplyIPFilterForDomain` path resolves the host and re-checks the resolved IP
against the private/block CIDR lists; that step cannot run inside a Worker
without a subrequest to a resolver, so `crates/ssrf` validates only the URL's
literal host (domain or IP literal).

Consequences callers must know before wiring this module in:

- A domain name that resolves to a private IP at request time
  (`rebind.example` → `127.0.0.1`) is **not** blocked by this module.
- Until a Workers-compatible DNS path or a native server escape hatch is
  added, treat the `domain_allowlist` + `domain_blocklist` + IP-literal checks
  as the only layer of defense for user-controlled URLs.
- Always pair this module with the Cloudflare WAF, egress IP allow/deny
  lists at the account level, and per-channel `base_url` review.

## Integration status

This module ships as a standalone crate with full unit-test coverage of the Go
parity cases. It is intentionally **not** wired into any Worker route in this
revision because no current Worker endpoint ingests user-controlled URLs (the
relay endpoints forward JSON to admin-configured `base_url`s, and
download/webhook/image-proxy paths have not been ported yet).

The module will be wired in when the first user-controlled-URL endpoint lands:

- payment webhook outbound delivery,
- custom OAuth provider callback / discovery,
- image / file download proxy,
- Midjourney / async-task image proxy.

The integration point will read the operator-configured `FetchSetting` from
D1 options (same pattern as billing options) and build a `SsrfPolicy` once per
request.
