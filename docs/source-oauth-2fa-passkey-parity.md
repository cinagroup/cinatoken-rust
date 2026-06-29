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

**Remaining (follow-ups):** failed-attempt **lockout** (schema columns exist),
`RegenerateBackupCodes`, the `secure_verify` **2fa method** for `/api/verify`
(so step-up can use TOTP, reusing `verify_2fa_code`, not just password), and
admin 2FA stats/disable.

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
delete-on-read). The Go `go-webauthn` library has no direct WASM equivalent — use
a WASM-compatible WebAuthn verify (assertion/attestation verification over Web
Crypto) if one exists, **else run the WebAuthn ceremony in a Cloudflare Container
(§21.4)** (migration-plan §7.12). RPID/RPOrigins derive from `FRONTEND_BASE_URL`
+ the deploy domain.

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

Per the matrices, OAuth/Passkey/2FA are `Planned`. Checklist:

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
3. Passkey: KV/DO single-use challenge; choose WASM WebAuthn vs Container;
   RP config from options; secure-verification gating on register/delete/verify.
4. Decide and document forced re-enroll vs credential import per credential type.
5. Staging smoke: OAuth state replay rejection, 2FA login + backup code,
   Passkey register/login/verify, and step-up gating.

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
