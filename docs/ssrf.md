# SSRF Protection

Date: 2026-07-07

Status: shared module, wired into selected Worker hot paths.

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

This module ships as a shared crate with full unit-test coverage of the Go
parity cases. It is now wired into selected Worker routes that fetch
externally supplied URLs:

- `GET /v1/videos/:task_id/content` resolves completed, owner-scoped task
  artifact URLs from stored provider/task data, validates HTTP(S) URLs with
  `SsrfPolicy::strict_default()`, disables redirect following with
  `RequestRedirect::Error`, and streams successful upstream responses through
  the Worker. Bounded `data:` URLs stay on the inline-content path and do not
  use outbound fetch.
- Admin/root outbound helpers such as custom OAuth discovery, WeChat
  verification, Uptime Kuma status, ratio sync, model metadata, channel
  upstream update, deployment provider calls, and payment/subscription
  provider calls use their own SSRF or fixed-destination validation plus
  redirect-fail-closed fetch initialization.

Future user-controlled outbound fetch endpoints must continue to build the
appropriate `SsrfPolicy` from D1 options (same pattern as billing options)
and must keep redirect handling fail-closed unless the caller re-validates
every hop.
