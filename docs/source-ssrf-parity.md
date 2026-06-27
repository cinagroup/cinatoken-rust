# Source SSRF And Outbound-URL Validation Parity (G6)

Date: 2026-06-25

Status: canonical, source-derived parity comparison between Go
`common/ssrf_protection.go` and Rust `crates/ssrf`. Complements the module doc
`docs/ssrf.md` (which describes the crate API and the WASM DNS limitation); this
file is the **parity verification** — what matches, the concrete CIDR-table
divergences found, the DNS-rebinding decision, and the wiring gate. Outbound URL
validation is a G6 security control for user-controlled URLs.

## Source Of Truth

- Go: `common/ssrf_protection.go` (`SSRFProtection`, `isPrivateIP`,
  `ValidateURL`, `ValidateURLWithFetchSetting`), `common/url_validator.go`
  (`ValidateRedirectURL`).
- Rust: `crates/ssrf/src/lib.rs` (`SsrfPolicy`, `is_private_ip`, `validate_url`),
  `docs/ssrf.md`.

## Validation Flow (Go `ValidateURL`)

1. Parse URL; reject parse errors.
2. **Scheme** must be `http`/`https` (no `file`, `gopher`, etc.).
3. Split host/port (default 443 for https, 80 for http).
4. **Port** must pass `isAllowedPort`.
5. If host is an **IP literal** -> `IsIPAccessAllowed` (private-IP block unless
   `AllowPrivateIp`, then IP allowlist/blocklist).
6. Else (**domain**) -> `isDomainAllowed` (allowlist/blocklist).
7. If `ApplyIPFilterForDomain` -> `net.LookupIP(host)` and re-check **each
   resolved IP** (the DNS-rebinding defense).

`ValidateURLWithFetchSetting` short-circuits to allow when SSRF protection is
disabled, and builds the policy from operator `FetchSetting` options.

`isPrivateIP` (Go) is belt-and-suspenders: std checks
(`IsUnspecified/IsLoopback/IsLinkLocalUnicast/IsLinkLocalMulticast/IsInterfaceLocalMulticast`),
then the IPv4/IPv6 CIDR tables, then `ip.IsPrivate()`.

Rust `validate_url` matches steps 1-6 (scheme, port, IP-literal/domain) but
**cannot do step 7** (no synchronous DNS resolver in Workers), so it validates
only the literal host. This is intentional and documented in `docs/ssrf.md`.

## CIDR Table Divergences (found 2026-06-25 — RECONCILED 2026-06-25)

Comparing Go `privateIPv4Nets`/`privateIPv6Nets` against Rust
`PRIVATE_IPV4_NETS`/`PRIVATE_IPV6_NETS`. All four divergences are now resolved in
`crates/ssrf/src/lib.rs`; the Rust tables match the Go set range-for-range (same
order) with one documented superset addition. Fixtures live in the
`reconciled_ranges_match_go` unit test.

| Range | Go | Rust (before) | Resolution |
| --- | --- | --- | --- |
| `192.0.0.0/24` | full /24 blocked | only `192.0.0.0/29` + `192.0.0.170/31` (allowed .8–.255) | **Widened Rust to `192.0.0.0/24`** to match Go. |
| NAT64 well-known | `64:ff9b::/96` | `64:ff9b:1::/48` only (well-known **missing**) | **Added `64:ff9b::/96`** (well-known NAT64 can embed private v4). Kept `64:ff9b:1::/48` as a documented superset (RFC 8215 local-use). |
| `2001::/23` | whole /23 blocked | `2001:0000::/32` (Teredo) + `2001:20::/28` (ORCHIDv2) | **Widened Rust to `2001::/23`**, which subsumes both narrow sub-ranges. |
| IPv6 multicast `ff00::/8` | in Go CIDR list **and** via std methods | **absent**; Rust `is_private_ip` had no `is_multicast()` check → IPv6 multicast was **not blocked** (real bypass) | **Added `ff00::/8`** to the table **and** added the `is_multicast()` std check (below). Highest-priority item. |

### Intentional divergence (documented)

- Rust additionally blocks `64:ff9b:1::/48` (RFC 8215 local-use IPv4/IPv6
  translation). Go does not list it. This is a safe superset (block-list only
  ever rejects more), kept as defense-in-depth and covered by a fixture.

### Belt-and-suspenders std checks (now mirrored)

Go `isPrivateIP` runs std-method checks *in addition to* the CIDR tables
(`IsUnspecified`/`IsLoopback`/`IsLinkLocalUnicast`/`IsLinkLocalMulticast`/`IsInterfaceLocalMulticast`).
Rust `is_private_ip` previously relied on the CIDR table alone — which is exactly
why the missing `ff00::/8` opened a multicast bypass. It now runs equivalent std
checks first: `ip.is_unspecified()`, `ip.is_loopback()`; for v4
`is_link_local()`/`is_multicast()`/`is_broadcast()`; for v6 `is_multicast()`
(covers link-local + interface-local multicast). v6 link-local *unicast*
(`fe80::/10`) stays covered by the CIDR table. These checks are redundant with
the reconciled tables but guard against a future table typo silently reopening a
gap.

## DNS-Rebinding Decision (the central gap)

Go's `ApplyIPFilterForDomain` resolves the host and re-checks resolved IPs; the
Worker cannot. So a domain that resolves to a private IP at fetch time
(`rebind.example -> 127.0.0.1`) is **not** blocked by `crates/ssrf` alone. Pick
and document one:

1. **DoH resolve-and-check** before fetch (Cloudflare `1.1.1.1` DNS-over-HTTPS
   subrequest), re-checking resolved IPs against the private/block CIDRs. Closes
   most of the gap but leaves a TOCTOU rebinding window between resolve and
   fetch; pin the resolved IP into the fetch where possible.
2. **Container/native escape hatch** (§21.4): run user-controlled-URL fetches in
   a Cloudflare Container that can resolve + validate + connect to the pinned IP.
3. **Accept + compensate**: rely on the literal-IP + domain allow/blocklist
   checks plus Cloudflare WAF and account-level egress controls, and on the
   Workers threat-model difference below. Lowest effort, highest residual risk.

Recommended: option 1 (DoH) for webhook/OAuth/discovery paths, escalating to
option 2 for any path that must be strongly rebinding-safe.

## Cloudflare Threat-Model Difference (frame accurately)

The Workers blast radius differs from the Go/VPS deployment:

- There is **no cloud-metadata endpoint** (`169.254.169.254`) co-located with a
  Worker to exfiltrate, unlike a VPS. Blocking link-local still matters for
  parity and defense-in-depth, but the classic metadata-SSRF target is absent.
- Workers egress generally **cannot reach the operator's RFC1918 network** (no
  internal network is attached), shrinking internal-pivot risk.
- SSRF still matters for: abuse/port-scanning of third parties, reaching other
  Cloudflare-internal services, and bypassing intended allowlists. So keep the
  IP-literal and (resolved-IP, where feasible) checks.

## Parallel Surface: Redirect URL Validation

`common/url_validator.go: ValidateRedirectURL` validates payment success/cancel
callback URLs against `TrustedRedirectDomains` (subdomain match). This is a
**separate** allowlist from SSRF and must be ported for the payment flows
(`docs/source-payment-idempotency-parity.md`); the env var is in the
Environment And Config Inventory.

**Ported 2026-06-26** as `crates/ssrf::redirect::validate_redirect_url` — a
faithful, tested port (12 unit tests mirroring Go's `TestValidateRedirectURL`
table: exact/subdomain/case-insensitive matches, suffix-attack `fakeexample.com`
reject, empty-trusted-list reject, `javascript:`/`data:` scheme reject,
empty-URL reject). Uses the `url` crate (already a dependency) and matches Go's
lenient empty-URL behavior (empty → "invalid URL scheme"). Stays unwired until a
payment flow accepts user-supplied callback URLs (the Rust `stripe_pay` currently
builds redirect URLs server-side from `FRONTEND_BASE_URL`).

## Wiring Gate (crate is not yet wired in)

`crates/ssrf` is a standalone, unit-tested crate **not wired into any Worker
route**. It must be applied before any user-controlled-URL endpoint ships:

- payment webhook **outbound** delivery,
- custom OAuth provider callback / discovery fetch,
- image / file download proxy,
- Midjourney / async-task image proxy.

Each must build an `SsrfPolicy` from the operator `FetchSetting` D1 options (same
pattern as billing options) per request. Channel `base_url` is **intentionally
not** SSRF-validated (admin-trusted) in both deployments.

## G6 Checklist

1. ~~Reconcile the CIDR-table divergences above (or document as intentional) and
   add fixtures per range.~~ **Done 2026-06-25** — tables aligned to Go, std
   belt-and-suspenders checks added, `reconciled_ranges_match_go` fixture covers
   each range.
2. Decide and document the DNS-rebinding approach (DoH vs Container vs accept).
3. Wire `crates/ssrf` into each user-controlled-URL endpoint as it lands; load
   `FetchSetting` from options.
4. Port `ValidateRedirectURL` + `TrustedRedirectDomains` for payment callbacks.
5. Confirm scheme/port/allowlist/blocklist parity with Go fixtures, including the
   `EnableSSRFProtection=false` short-circuit.
6. Keep WAF + account egress controls as defense-in-depth regardless of approach.

## Wire-In

- `docs/ssrf.md` is the crate module/status doc; this file is the Go<->Rust
  parity + decisions doc.
- `docs/observability-slo-security-runbook.md` G6 security section and
  `docs/production-readiness-matrices.md` (G6 / security rows) reference this
  file.
- DNS-rebinding escape hatch ties to Cloudflare Containers
  (`docs/cinatoken-rust-migration-plan.md` §21.4).
