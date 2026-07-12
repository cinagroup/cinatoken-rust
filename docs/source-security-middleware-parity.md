# Source Security Middleware Parity (G6): Turnstile, Secure-Verification, CORS

Date: 2026-06-25

Status: canonical, source-derived parity for the three request-time security
middlewares — Cloudflare Turnstile, secure-verification (step-up), and CORS.
Completes the G6 security surface alongside `docs/source-ssrf-parity.md`. A
central finding: all three write **mutable session state mid-request**, which the
Rust immutable HMAC cookie (`crates/session`) cannot do — that state must move to
KV/Durable Objects.

## Source Of Truth

- `middleware/turnstile-check.go` — `TurnstileCheck`.
- `middleware/secure_verification.go` — `SecureVerificationRequired`,
  `OptionalSecureVerification`, `ClearSecureVerification`.
- `middleware/cors.go` — `CORS`, `PoweredBy`.
- Rust: `crates/session`, `crates/worker/src/admin*.rs`.

## Turnstile (`TurnstileCheck`)

- Gated by `TurnstileCheckEnabled`.
- **Session-cached**: if `session["turnstile"]` is set, skip (verified once per
  session, not per request).
- Else read `?turnstile` token (empty -> fail), POST to
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` with
  `secret` (`TurnstileSecretKey`), `response`, `remoteip` (`ClientIP`).
- On `success` -> `session["turnstile"]=true` + save.
- Applied to: register, login, reset_password, email verification, checkin
  (the public/critical routes in `docs/source-route-inventory.md`).

**Rust status (DONE 2026-06-28, item 2.4):** `crates/worker/src/turnstile.rs`
ports the siteverify flow — `verify_turnstile_token` POSTs the form
`{secret, response, remoteip}` to the Cloudflare endpoint and reads `success`;
`require_turnstile` reads the `?turnstile=` token (empty → 400), uses
`CF-Connecting-IP` as `remoteip`, and is a no-op when `TURNSTILE_SECRET` is
unset (≈ `TurnstileCheckEnabled`). The user-supplied token is percent-encoded
into the form body (host-tested `form_encode`) so it can't inject fields. Wired
into `POST /api/user/login`. Remaining: the session-cached "verified once per
session" optimization (use [`crate::flow_state`] `Turnstile` for authenticated
routes) and wiring the other public routes (register/reset/checkin) as they
land.

## Secure Verification (`SecureVerificationRequired`) — step-up

- Session keys: `secure_verified_at` (unix ts), `secure_verified_method`.
- **Timeout 300s (5 min)**.
- Requires a logged-in user (`id != 0`, else 401).
- Missing ts -> 403 `VERIFICATION_REQUIRED`; wrong type -> 403
  `VERIFICATION_INVALID` (+clear); `now - ts >= 300` -> 403
  `VERIFICATION_EXPIRED` (+clear); else pass.
- The verification itself is performed by `UniversalVerify` (`POST /api/verify`,
  password/2FA/passkey re-auth) which writes `secure_verified_at`.
- Applied to: channel key reveal (`POST /api/channel/:id/key`, stacked with
  RootAuth + CriticalRateLimit + DisableCache — see
  `docs/source-auth-session-parity.md`).
- `OptionalSecureVerification` sets a `secure_verified` context flag without
  blocking.

**Rust status (DONE 2026-06-28, item 2.3):** `POST /api/verify`
(`admin::secure_verify_handler`) re-authenticates the logged-in user and writes
a `SecureVerify` entry to [`crate::flow_state`] (300s TTL = the freshness
window). `admin::require_secure_verification` is the step-up gate (403
`secure verification required` when absent), wired into the token-key reveal (`POST /api/token/:id/key`) and the
Go-canonical channel-key reveal (`POST /api/channel/:id/key`,
`admin_channel::reveal_channel_key` — admin + step-up + audit; `get_channel`
already masks the key via `channel_response_no_key`). `/api/verify` accepts
`method: "password"` (re-auth) **or** `method: "2fa"` (TOTP/backup code via
`admin_2fa::verify_2fa_code`, matching Go's 2FA step-up) since 2FA enrollment
landed (item 4.6); passkey step-up is still pending WebAuthn. Remaining: the
expired-vs-missing distinction (the KV TTL collapses both to "absent").

## CORS (`CORS`)

- Origins from `CORS_ORIGINS` env (comma-separated), else defaults
  (`https://app.cinatoken.com`, `http://localhost:5173`).
- `AllowCredentials=true`; methods GET/POST/PUT/DELETE/PATCH/OPTIONS; headers
  `*`; expose `Content-Length, Cache-Control, X-Accel-Buffering, X-Request-Id`
  (the last two for SSE).
- Empty origin list -> `AllowAllOrigins=true` (fallback).

**Rust status (DONE 2026-06-28):** `crates/worker/src/lib.rs::resolve_cors_allow_origin`
ports the allowlist (`CORS_ORIGINS` Worker var, else the default pair) and is
host-tested (`cors_allowlist_resolves_like_go`). The global `fetch` pass
(`upgrade_cors_for_origin`) echoes an allowlisted browser `Origin` with
`Access-Control-Allow-Credentials: true` + `Vary: Origin`; non-allowlisted /
no-`Origin` (Bearer/API) requests keep the permissive non-credentialed wildcard
from `set_cors_headers`. A **credentialed wildcard is never emitted** (finding
#4). `set_cors_headers` now also sets the Go `ExposeHeaders`. Applied to the
OPTIONS preflight, the Gemini-native path, and all router responses (static
assets are same-origin and skipped). Remaining: `CORS_ORIGINS` is read from the
Worker var; wire it per-environment in `wrangler.toml` before the separated-
frontend cutover.

## Parity-Critical Findings

1. **Mutable session state vs immutable HMAC cookie.** `TurnstileCheck` and
   `UniversalVerify` write to the session mid-request (`session.Set` + `Save`).
   The Rust session is a signed, immutable cookie set at login. So the
   **turnstile-passed flag and `secure_verified_at` timestamp must live in KV or
   a Durable Object** (short TTL: 300s for secure-verification), keyed by session
   binding — not only user id. Alternatively re-issue the cookie via `Set-Cookie`
   on the response, but KV/DO is cleaner for short-TTL step-up state (§21.2).
   **Substrate DONE 2026-06-28 (item 2.1):** `crates/worker/src/flow_state.rs` is
   the `CACHE_KV`-backed store — namespaced keys (`flow:secure_verify:*`,
   `flow:turnstile:*`, `flow:oauth_state:*`, `flow:2fa_pending:*`), per-kind
   TTLs (secure-verify/2fa 300s, oauth
   600s, turnstile 1800s), and `take()` delete-on-read for single-use tokens.
   Pure key/TTL logic is host-tested; consumers (secure-verify, Turnstile, 2FA)
   wire in following increments. Passkey challenges moved to the dedicated
   strongly consistent `PasskeyCeremony` DO on 2026-07-12; secure-verification
   keys are now bound to `user_id + SHA-256(session cookie)` so one browser's
   step-up cannot unlock another session for the same account.
2. **Turnstile is once-per-session in Go.** Preserve the semantics: cache the
   passed flag (KV/DO) so a user isn't re-challenged every critical action within
   the session, or deliberately re-challenge per action and document the change.
   Server-side `siteverify` via Worker `fetch`; secret from a Wrangler secret;
   include `remoteip` = `CF-Connecting-IP`.
3. **Secure-verification 5-min step-up must be preserved** for channel key reveal
   (and any future secret reveal). Store `verified_at` in KV/DO with a 300s TTL;
   `/api/verify` re-checks password/2FA/passkey before writing it. Keep the exact
   error codes (`VERIFICATION_REQUIRED/INVALID/EXPIRED`) the frontend branches on.
4. **CORS: `AllowCredentials=true` + `AllowAllOrigins` is invalid** and browsers
   reject it. Do **not** replicate the empty-origins -> allow-all fallback as a
   credentialed wildcard; **fail closed** to the configured allowlist per
   environment (`CORS_ORIGINS` -> Worker var). Reflect a specific allowed origin,
   never `*`, when credentials are sent.
5. **Single-origin Static Assets reduces CORS scope** (§21.6): the admin UI is
   same-origin, so admin-API CORS is largely unnecessary. CORS still matters for
   relay endpoints called cross-origin by browser SDKs and any separated
   frontend; keep the SSE expose-headers (`X-Accel-Buffering`, `X-Request-Id`).
6. **`headers: ["*"]`** with credentials should be tightened to the actually-used
   request headers in the Rust port (wildcard request headers + credentials is
   also browser-restricted).

## Rust Status And Checklist

Per the matrices, Turnstile/CORS are `Planned`/`Partial` and secure-verification
is implied by the channel-key-reveal route (not yet wired). Checklist:

1. Implement Turnstile server-side `siteverify` in the Worker; store the
   passed flag in KV/DO (session-scoped) to match once-per-session semantics;
   secret via Wrangler.
2. Implement secure-verification step-up: `/api/verify` re-auth writes a 300s
   KV/DO entry; `SecureVerificationRequired` equivalent guards key-reveal with
   the same error codes.
3. Implement environment-scoped CORS from `CORS_ORIGINS`; fail closed (no
   credentialed wildcard); keep SSE expose-headers; tighten allowed request
   headers.
4. Wire Turnstile to register/login/reset/email-verify/checkin and
   secure-verification to channel key reveal.
5. Add staging smoke: a Turnstile challenge pass/fail, a step-up
   required/expired/valid cycle, and a credentialed cross-origin preflight.

## Wire-In

- `docs/source-auth-session-parity.md` (secure-verification is the step-up for
  the admin pin / key-reveal routes; both rely on session/KV state).
- `docs/observability-slo-security-runbook.md` G6 Turnstile/CORS/WAF rows and
  `docs/production-readiness-matrices.md` (CORS/WAF, security rows) reference
  this file.
- Short-TTL verification/turnstile state follows migration-plan §21.2 (KV/DO);
  same-origin CORS simplification follows §21.6.
