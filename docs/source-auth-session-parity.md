# Source Auth And Session Parity (G5)

Date: 2026-06-25

Status: canonical, source-derived specification of the Go authentication and
session model, with the Rust posture and the migration decisions G5 must make.
Covers the four auth classes from `docs/source-route-inventory.md` at the
mechanism level: session/access-token user auth, relay token auth, and the
OAuth/2FA/Passkey enrollment surfaces.

## Source Of Truth

- `middleware/auth.go` — `authHelper`, `UserAuth/AdminAuth/RootAuth`,
  `TokenAuth`, `TokenAuthReadOnly`, `TokenOrUserAuth`, `SetupContextForToken`.
- `main.go` session store config (cookie `MaxAge: 2592000`).
- `controller/{user,oauth,passkey,twofa}.go`, `oauth/`, `controller/{github,
  discord,linuxdo,oidc}.go`.
- Rust: `crates/session/src/lib.rs`, `crates/auth/src/{lib,password}.rs`,
  `crates/worker/src/admin*.rs` (`require_user_auth/admin/root`).

## Session Model

Go uses `gin-contrib/sessions` cookie store: session serialized with
`encoding/gob`, AES-encrypted, signed with `SessionSecret`, cookie name
`session`, `MaxAge` 30 days. Session keys: `id`, `username`, `role`, `status`,
`group`.

Rust (`crates/session`) uses a **stateless HMAC-SHA256-signed** cookie
(`base64url(payload).base64url(hmac)`), same cookie name `session`, same 30-day
TTL, payload fields mirroring the Go session keys plus `exp`. The format is
**deliberately not Go-compatible**.

> **Decision (already made): forced re-auth.** Go-issued cookies are not readable
> by Rust. Cutover logs every browser session out; users sign in again. This is
> the documented G5 strategy — do not attempt gob/AES session migration.

## User Auth (`authHelper`, role-gated)

`UserAuth`/`AdminAuth`/`RootAuth` call `authHelper(c, minRole)` with roles
`RoleCommonUser < RoleAdminUser < RoleRootUser`. Steps:

1. Read `username/role/id/status/group` from the session cookie.
2. **Access-token fallback**: if no session username, read `Authorization` header
   and `ValidateAccessToken` (the 32-char `access_token` on the `users` row, for
   API-based admin clients). On success, identity comes from that user.
3. **`New-Api-User` header required**: the request must send `New-Api-User:
   <userId>` and it must equal the authenticated `id`, else 401. A double-submit
   guard the React frontend always sends.
4. `status == disabled` -> banned; `role < minRole` -> insufficient privilege.
5. Sets `Auth-Version` response header (version fingerprint) and request context
   (`username/role/id/group/user_group/use_access_token`).
6. For `minRole >= RoleAdminUser`, wraps the response to auto-record an admin
   audit row (`beginAdminAudit`/`finishAdminAudit`).

Rust status: `require_user_auth/admin/root` enforce role (`is_admin`/`is_root`)
and disabled-status from session claims, with admin audit. Gaps below.

## Relay Token Auth (`TokenAuth`)

Key extraction precedence (Rust relay must match):

1. **WebSocket**: `Sec-WebSocket-Protocol` -> `openai-insecure-api-key.<sk>` ->
   `Authorization: Bearer <sk>`.
2. **Anthropic**: on `/v1/messages` and `/v1/models`, `x-api-key` -> Bearer.
3. **Gemini**: on `/v1beta/models*`, `/v1beta/openai/models*`, `/v1/models/*`,
   `?key` query or `x-goog-api-key` header -> Bearer.
4. **mj fallback**: empty/`midjourney-proxy` -> `mj-api-secret` header.
5. Strip `Bearer ` and `sk-`, split on `-`: **`key = parts[0]`**; `parts[1]` is a
   specific channel id.

Then: `ValidateUserToken(key)`; **IP allowlist** (`token.GetIpLimits()` CIDR vs
`ClientIP`); user-cache `status == enabled`; **group authorization** — a non-empty
token group must be in the user's usable groups and present in `GroupRatio` (or
literally `auto`), else 403; `usingGroup = tokenGroup or userGroup`.

`SetupContextForToken`: sets token context, and **`sk-<key>-<channelid>` admin
channel pin** — `parts[1]` sets `specific_channel_id` **only if the user is an
admin**; normal users get 403 "普通用户不支持指定渠道".

## TokenAuthReadOnly And TokenOrUserAuth

- `TokenAuthReadOnly` (usage/log-by-key): validates only that the key exists;
  **ignores token status/expiry/quota**, but still rejects banned users.
- `TokenOrUserAuth` (video proxy): session first (enabled), else `TokenAuth`.

## OAuth / 2FA / Passkey

- OAuth providers: GitHub, Discord, OIDC, LinuxDO (unified `/oauth/:provider`),
  plus non-standard WeChat/Telegram; state via `/oauth/state` with
  `CriticalRateLimit`. State must be single-use and origin-checked
  (`TrustedRedirectDomains`).
- 2FA: TOTP setup/enable/disable/backup-codes; login second factor
  `/user/login/2fa`.
- Passkey/WebAuthn: register/login/verify begin/finish; challenge is short-lived
  server state.

Migration policy (P1/P2): import securely or **force re-enroll/rebind**. Passkey
challenges and OAuth state are short-TTL state -> KV or Durable Object
(migration-plan §21.2); WebAuthn that cannot compile to WASM runs in a Cloudflare
Container (§21.4). The user/credential rows migrate via the data plan; the live
challenge/state does not.

## Parity-Critical Findings

1. **`New-Api-User` double-submit header.** The React frontend always sends it
   and `authHelper` enforces id-match. Rust must decide: enforce it (keep CSRF
   parity), or rely on same-origin Static Assets (§21.6) + `SameSite` cookie and
   accept-but-ignore it. Either way Rust must not 500/400 when it is present.
   Document the choice.
2. **Access-token (32-char) admin path.** Non-browser admin clients authenticate
   by `access_token` + `New-Api-User`, not a cookie. Rust must support this for
   API-based operators or explicitly drop it (and update any tooling).
3. **`sk-<key>-<channelid>` admin channel pin.** Rust relay must parse the same
   `parts[0]=key, parts[1]=channel` format and enforce admin-only pinning with
   the same 403 for non-admins. Ties to the specific-channel pin in
   `docs/source-channel-selection-parity.md`.
4. **Per-format key extraction** (WS/Anthropic/Gemini/mj) must match precedence,
   or some SDKs fail to authenticate.
5. **Password hash scheme.** Verify `crates/auth/password.rs` matches the Go hash
   (algorithm + cost) so imported `users.password` validates; otherwise force a
   password reset. Decide and document.
6. **Constant-time / hashed secret comparison** for tokens/access-tokens
   (audit P1). Avoid timing leaks; never log full keys.
7. **`Auth-Version`/version-fingerprint headers** are Go anti-mismatch guards;
   Rust may omit them but should not depend on the frontend requiring them.

## Rust Status And G5 Checklist

Per the readiness matrices, login/current-user/logout with HMAC cookies are
implemented; operator CRUD and frontend smoke are pending. Auth-specific gaps:

1. Decide and document the `New-Api-User` policy; ensure the React frontend's
   header does not break Rust admin calls.
2. Decide the access-token (API operator) path: support or drop.
3. Implement the `sk-<key>-<channelid>` admin pin with non-admin 403.
4. Confirm relay key-extraction precedence (WS/Anthropic/Gemini/mj) parity.
5. Resolve password-hash parity vs forced reset.
6. Define OAuth state / Passkey challenge storage (KV/DO) and WebAuthn runtime
   (WASM vs Container), plus the forced re-enroll policy.
7. Keep admin-mutation audit on every `require_admin_auth/root_auth` path
   (matches `authHelper`'s automatic audit).

## Wire-In

- `docs/admin-frontend-parity-runbook.md` G5 auth/session section consumes this
  spec.
- `docs/production-readiness-matrices.md` G5 row and the Admin/Frontend/Auth
  matrix reference this file.
- Storage of short-TTL auth state (OAuth/Passkey) follows the cache/rate-limit
  plan (Durable Objects, migration-plan §21.2); WebAuthn runtime follows §21.4.
- `docs/source-security-middleware-parity.md` for the secure-verification
  (step-up) guard on key-reveal, Turnstile, and CORS — all of which need
  KV/DO-backed mutable session state.
- `docs/source-oauth-2fa-passkey-parity.md` for the OAuth state (CSRF), TOTP 2FA,
  and WebAuthn/Passkey ceremony detail behind the OAuth/2FA/Passkey section above.
