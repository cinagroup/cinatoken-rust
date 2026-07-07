# Source OAuth / 2FA / Passkey Enrollment Parity (G5)

Date: 2026-06-25

Status: canonical, source-derived specification of the OAuth state (CSRF), TOTP
2FA, and WebAuthn/Passkey ceremonies — the security-sensitive enrollment detail
that `docs/source-auth-session-parity.md` sketched. The recurring finding: all
three store **mutable mid-flow state in the session cookie**, which the Rust
immutable HMAC cookie cannot do, so that state must move to KV / Durable Objects
(short TTL), single-use.

## Source Of Truth

- OAuth: `controller/oauth.go` (`GenerateOAuthCode`, `HandleOAuth`), `oauth/`.
- 2FA: `controller/twofa.go` (`Setup2FA`/`Enable2FA`/`Verify2FALogin`/
  `RegenerateBackupCodes`/`Disable2FA`/`Admin2FAStats`/`AdminDisable2FA`).
- Passkey: `controller/passkey.go`, `service/passkey/{service,session,user}.go`
  (go-webauthn).
- Tables: `two_fas`, `two_fa_backup_codes`, `passkey_credentials`,
  `user_oauth_bindings`, `custom_oauth_providers`.

## OAuth State (CSRF)

- `GenerateOAuthCode`: `state = GetRandomString(12)`; `session["oauth_state"]=state`
  (+ optional `aff`); returns state to the client.
- `HandleOAuth`: reject unless `query.state == session["oauth_state"]`. Then:
  if `session["username"]` is set -> **bind** flow; else login/register. Provider
  must be enabled.
- The state lives in the session cookie; validation is equality. (The shown path
  does not explicitly delete it, so it is session-scoped, not strictly
  single-use — Rust should make it single-use.)

Migration: store state in **KV/DO short TTL** keyed by a pre-auth session id;
**delete on validate (single-use)** for replay protection; validate the callback
origin against `TrustedRedirectDomains` (`docs/source-ssrf-parity.md`); provider
client secrets come from options / Secrets Store (§21.7).

**Rust status (GitHub OAuth DONE 2026-06-28, item 4.6):**
`crates/worker/src/admin_oauth.rs`. `GET /api/oauth/state` issues a CSPRNG state
nonce stored in `flow_state::OAuthState` (the Rust has no pre-auth session, so
the nonce is self-keyed). `GET /api/oauth/github` consumes the state with
`flow_state::take` (**single-use / replay-proof**, the explicit improvement
called for above), exchanges the code (`getGitHubUserInfoByCode` port — JSON
token POST + `api.github.com/user` GET with the required `User-Agent`),
finds-or-creates the account by GitHub login (`find_user_by_github_id` /
`create_github_user` with a CSPRNG `aff_code` for the UNIQUE column), issues the
session, and 302-redirects to `FRONTEND_BASE_URL`. Inert unless
`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are set. The **bind** flow is wired:
when `/api/oauth/github` is hit with a valid session, it links the GitHub login
to the current account (`bind_github_id`, rejecting a login already linked
elsewhere) instead of logging in/registering (Go `GitHubBind`). **Generic OIDC
DONE 2026-06-28** (`oidc_oauth`, stored in `oidc_id`) — covers Google and any
OpenID Connect provider: form-encoded token exchange at `OIDC_TOKEN_URL` +
`OIDC_USERINFO_URL` (`sub`/`name`/`email`), same single-use state, login /
register / bind, gated on `OIDC_CLIENT_ID/SECRET/TOKEN_URL/USERINFO_URL/
REDIRECT_URI`. **Discord DONE 2026-06-28** (`discord_oauth`, stored in
`discord_id`; fixed Discord endpoints, `users/@me` -> `id`/`username`/`email`;
login/register/bind; gated on `DISCORD_CLIENT_ID/SECRET/REDIRECT_URI`).
**Remaining:** WeChat (custom QR flow) and `TrustedRedirectDomains` validation
for the final redirect.

**2026-07-07 update:** fixed GitHub, OIDC, and Discord callbacks now restore the
Go session-bound CSRF property in the stateless Rust session model. `GET
/api/oauth/state` returns a Go-compatible bare state string in the envelope
`data`, stores a CSPRNG browser binding in `flow_state::OAuthState`, and sets a
short-lived HttpOnly `cinatoken_oauth_state` cookie scoped to `/api/oauth`.
Callbacks require both the query `state` and the same-browser cookie binding
before consuming the KV state with `flow_state::take`. OAuth bind branches now
use live optional session auth before mutating account links. Remaining OAuth
work: custom/generic callback routing, staging replay smoke, and final redirect
domain validation.

## 2FA (TOTP)

- Lifecycle: `Setup2FA` (generate secret) -> `Enable2FA` (verify a TOTP code) ->
  login second factor `POST /user/login/2fa` (after password) -> `Disable2FA` ->
  `RegenerateBackupCodes`; admin `Admin2FAStats` / `AdminDisable2FA`.
- Login is two-step: password validates, and if 2FA is enabled a **pending-2FA
  state** is held until `/user/login/2fa` verifies the TOTP (or a backup code).
- Backup codes are stored hashed and are single-use.

Migration: TOTP verification is pure HMAC-SHA1 compute -> **WASM-friendly** (no
escape hatch needed). The **pending-2FA login state** (between password and
TOTP) is session state -> KV/DO short TTL. Backup codes stay hashed + single-use
(consume via conditional D1 update, like the payment CAS pattern).

**Rust status (enrollment DONE 2026-06-28, item 4.6):** schema in
`migrations/d1/0006_two_fa.sql`; primitives in `cinatoken_auth` (TOTP +
`encode_base32` + backup-code gen, all host-tested); endpoints in
`crates/worker/src/admin_2fa.rs`:
- `POST /api/user/2fa/setup` — CSPRNG 160-bit secret (getrandom + encode_base32),
  stored disabled, returns the secret + an `otpauth://totp` URI.
- `POST /api/user/2fa/confirm {code}` — `validate_totp` (±1 skew) -> enable +
  issue 10 single-use backup codes (returned once, stored bcrypt-hashed via the
  shared `hash_password`, = Go `HashBackupCode`).
- `GET /api/user/2fa/status`; `POST /api/user/2fa/disable` (hard-delete, gated by
  secure-verification step-up §2.3).

**Login 2FA DONE 2026-06-28:** `login` no longer issues a session for a
2FA-enabled user — it stores a single-use pending marker
(`flow_state::TwoFaPending`, keyed by an opaque CSPRNG token → user id, 300s)
and returns `{two_fa_required, pending_token}`. `POST /api/user/login/2fa`
(`admin::login_2fa`) consumes the marker (`take`, single-use), then
`admin_2fa::verify_2fa_code` accepts a current TOTP code **or** a single-use
backup code (bcrypt-compared, consumed via `mark_backup_code_used`) before
issuing the session.

**Secure-verify 2fa method DONE 2026-06-28:** `/api/verify` accepts
`method: "2fa"` (`{code}`) and verifies via `verify_2fa_code` (TOTP or backup
code), in addition to `method: "password"`.

**Lockout + RegenerateBackupCodes DONE 2026-06-28:** `verify_2fa_code` enforces
Go's anti-brute-force lockout — after `MaxFailAttempts` (5) failures it locks for
`LockoutDuration` (300s) via `record_two_fa_failure` (atomic increment + CASE
lock) / `reset_two_fa_attempts` on success, returning `Verified` / `Invalid` /
`Locked{until}` (callers map Locked -> 429). `POST /api/user/2fa/backup-codes`
regenerates the code set (secure-verify gated).

**Remaining (follow-ups):** admin 2FA stats/disable; Passkey/WebAuthn finish
verification (needs a WASM-compatible WebAuthn verifier or a service-binding /
Container verifier).

## Passkey / WebAuthn

- Three ceremonies, each begin/finish: registration, login, verify (step-up).
  `*Begin` generates options + a challenge and `SaveSessionData(key, data)`;
  `*Finish` calls `PopSessionData(key)` which is **get + delete (single-use)** and
  verifies the assertion.
- Session keys: `passkey_registration_session`, `passkey_login_session`,
  `passkey_verify_session`. `SaveSessionData` marshals the WebAuthn `SessionData`
  (challenge) into the session cookie; `PopSessionData` deletes it.
- RP config from `PasskeySettings` options: `RPID`, `RPDisplayName`, `RPOrigins`;
  `resolveRPID` derives RPID from the configured origin (errors if none).
- Passkey register/delete/verify ops are gated by secure-verification
  (`requireSecureVerificationMethod` -> `docs/source-security-middleware-parity.md`).
- Credentials persist in `passkey_credentials`.

Migration: the **challenge/SessionData -> KV/DO short TTL**, single-use (pop =
delete-on-read). Rust now uses `flow_state::PasskeyChallenge` for
registration/verify and an HttpOnly short-TTL login flow cookie for anonymous
login begin/finish correlation. The Go `go-webauthn` library has no direct WASM
equivalent — use a WASM-compatible WebAuthn verify (assertion/attestation
verification over Web Crypto) if one exists, **else run the WebAuthn ceremony in
a Cloudflare Container or service binding (§21.4)** (migration-plan §7.12).
RPID/RPOrigins derive from `passkey.*` options, `ServerAddress`, or the deploy
origin.

## The Recurring Finding (consolidated)

OAuth state, the Passkey challenge, the 2FA-pending state, plus the Turnstile and
secure-verification flags (`docs/source-security-middleware-parity.md`) are **all
mutable mid-flow session writes** (`session.Set`/`Delete`, `SaveSessionData`/
`PopSessionData`). The Rust session is a signed, immutable cookie issued at login.

Decision: hold all short-lived auth-flow state in **KV or a Durable Object**,
keyed by a pre-auth/session id, with a short TTL, and consume it single-use
(delete-on-read mirrors `PopSessionData`). Do not try to mutate the signed cookie
per request. This is migration-plan §21.2 (atomic/short-TTL state on DO/KV).

## Migration Policy (forced re-enroll, default)

Per `docs/source-auth-session-parity.md`, the simplest cutover is **forced
re-enroll/re-link**: credential rows (`passkey_credentials`, `two_fas`,
`user_oauth_bindings`) migrate via the data plan, but live challenges/states do
not. If forced re-enroll is unacceptable, prove credential-format compatibility
(WebAuthn credential blob, TOTP secret) before importing.

## Rust Status And Checklist

Per the matrices, OAuth/Passkey/2FA are `Partial`. Checklist:

1. OAuth: KV/DO single-use state, callback origin validation
   (`TrustedRedirectDomains`), provider secrets from options/Secrets Store,
   bind-vs-login branch, `user_oauth_bindings` + `custom_oauth_providers`
   (custom-provider discovery fetch needs SSRF validation).
2. 2FA: **TOTP verify DONE 2026-06-27** — `cinatoken_auth::totp` ports the pure
   algorithm matching Go's pquerna/otp params (HMAC-SHA1, 30s, 6 digits, ±1 skew,
   base32 secret): `validate_totp` / `totp_code_at` + backup-code format helpers
   (`backup_code_from_bytes` / `validate_backup_code_format` /
   `normalize_backup_code`). Verified against the RFC 6238 Appendix B vectors;
   compiles to wasm (sha1+hmac). **Remaining**: the KV/DO pending-2FA login
   state, secret generation + persistence, single-use backup-code hashing
   (bcrypt via `crate::password`) + the `/user/login/2fa` flow + admin
   stats/disable with audit.
3. Passkey: **route boundary + begin challenge DONE 2026-07-04** — status,
   delete, register/login/verify begin, and fail-closed finish routes are
   Worker-owned. Begin routes generate WebAuthn publicKey options, read RP
   config from `passkey.*`, write short-TTL KV challenge state, and avoid global
   request state. **Remaining**: choose and implement WASM WebAuthn vs
   service-binding/Container verifier; finish routes must validate
   attestation/assertion signatures, challenge, origin/RPID, credential id,
   user handle, sign count, and credential import/update before any success.
4. Decide and document forced re-enroll vs credential import per credential type.
5. Staging smoke: OAuth state replay rejection, 2FA login + backup code,
   Passkey begin routes, finish fail-closed behavior before verifier, then full
   Passkey register/login/verify and step-up gating after verifier lands.

## Wire-In

- `docs/source-auth-session-parity.md` (these are the enrollment details behind
  its OAuth/2FA/Passkey section) and
  `docs/source-security-middleware-parity.md` (shared KV/DO mutable-state
  finding; secure-verification gating).
- `docs/production-readiness-matrices.md` OAuth/Passkey/2FA rows and the auth
  table-family rows reference this file.
- `docs/data-migration-runbook.md` Wave 4 (auth/security) consumes the credential
  tables and the forced-re-enroll decision.
- KV/DO state follows migration-plan §21.2; WebAuthn runtime follows §21.4.
