//! KV-backed mutable flow state (migration item 2.1).
//!
//! Go writes short-lived, single-use flow state into the server-side session
//! mid-request (`session.Set` + `Save`): the Turnstile-passed flag, the
//! `secure_verified_at` step-up timestamp, OAuth `state`, the Passkey
//! challenge, and the 2FA-pending marker. The Rust session is a stateless,
//! signed, immutable cookie issued at login, so that mutable state cannot live
//! in the cookie. This module is the shared substrate: a `CACHE_KV`-backed
//! store with namespaced keys, per-kind TTLs, and delete-on-read (single-use)
//! semantics.
//!
//! Ready-to-wire consumers (each gated on its own feature): secure-verification
//! step-up (`docs/source-security-middleware-parity.md` §Secure-verification),
//! Turnstile once-per-session (§Turnstile), and OAuth/2FA/passkey enrollment
//! (`docs/source-oauth-2fa-passkey-parity.md`).

use worker::{Env, Result};

/// KV namespace used for all flow state. `CACHE_KV` is the short-TTL cache
/// binding (distinct from `CONFIG_KV`, which holds operator config).
const FLOW_STATE_KV_BINDING: &str = "CACHE_KV";

/// A category of mutable flow state. The variant determines the key namespace
/// and the default TTL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowKind {
    /// Turnstile challenge passed for a session/principal (Go `session["turnstile"]`).
    Turnstile,
    /// Secure-verification step-up timestamp (Go `secure_verified_at`, 300s window).
    SecureVerify,
    /// OAuth `state` parameter pending the provider callback.
    OAuthState,
    /// WebAuthn/passkey challenge pending the authenticator response.
    PasskeyChallenge,
    /// 2FA pending after password but before the TOTP/backup code is presented.
    TwoFaPending,
}

impl FlowKind {
    /// Key-namespace prefix, kept stable so entries are greppable in KV.
    const fn prefix(self) -> &'static str {
        match self {
            FlowKind::Turnstile => "flow:turnstile",
            FlowKind::SecureVerify => "flow:secure_verify",
            FlowKind::OAuthState => "flow:oauth_state",
            FlowKind::PasskeyChallenge => "flow:passkey_challenge",
            FlowKind::TwoFaPending => "flow:2fa_pending",
        }
    }

    /// Default time-to-live in seconds. Secure-verification mirrors Go's 300s
    /// step-up window; OAuth/passkey challenges are short-lived; 2FA-pending and
    /// Turnstile are bounded to a single login flow / session window.
    pub const fn default_ttl_secs(self) -> u64 {
        match self {
            FlowKind::SecureVerify => 300,
            FlowKind::TwoFaPending => 300,
            FlowKind::OAuthState => 600,
            FlowKind::PasskeyChallenge => 300,
            FlowKind::Turnstile => 1800,
        }
    }
}

/// Namespaced KV key for a flow-state entry. Pure (host-testable). `id` is the
/// principal/flow identifier (e.g. user id, session id, or OAuth state nonce).
pub fn flow_state_key(kind: FlowKind, id: &str) -> String {
    format!("{}:{}", kind.prefix(), id)
}

/// Store `value` under `(kind, id)` with the kind's default TTL.
pub async fn put(env: &Env, kind: FlowKind, id: &str, value: &str) -> Result<()> {
    put_with_ttl(env, kind, id, value, kind.default_ttl_secs()).await
}

/// Store `value` with an explicit TTL (clamped to a 60s minimum so an entry is
/// never written without an expiry).
pub async fn put_with_ttl(
    env: &Env,
    kind: FlowKind,
    id: &str,
    value: &str,
    ttl_secs: u64,
) -> Result<()> {
    let key = flow_state_key(kind, id);
    env.kv(FLOW_STATE_KV_BINDING)?
        .put(&key, value)
        .map_err(|err| worker::Error::RustError(format!("flow-state KV put: {err}")))?
        .expiration_ttl(ttl_secs.max(60))
        .execute()
        .await
        .map_err(|err| worker::Error::RustError(format!("flow-state KV put: {err}")))
}

/// Read the value for `(kind, id)` without consuming it. `None` when absent or
/// expired.
pub async fn get(env: &Env, kind: FlowKind, id: &str) -> Result<Option<String>> {
    let key = flow_state_key(kind, id);
    env.kv(FLOW_STATE_KV_BINDING)?
        .get(&key)
        .text()
        .await
        .map_err(|err| worker::Error::RustError(format!("flow-state KV get: {err}")))
}

/// Single-use read: return the value and delete it (delete-on-read). Use for
/// one-shot tokens like OAuth `state` and passkey challenges so a captured
/// value cannot be replayed.
pub async fn take(env: &Env, kind: FlowKind, id: &str) -> Result<Option<String>> {
    let key = flow_state_key(kind, id);
    let kv = env.kv(FLOW_STATE_KV_BINDING)?;
    let value = kv
        .get(&key)
        .text()
        .await
        .map_err(|err| worker::Error::RustError(format!("flow-state KV get: {err}")))?;
    if value.is_some() {
        kv.delete(&key)
            .await
            .map_err(|err| worker::Error::RustError(format!("flow-state KV delete: {err}")))?;
    }
    Ok(value)
}

/// Delete the entry for `(kind, id)` (e.g. on logout / forced re-verification).
pub async fn delete(env: &Env, kind: FlowKind, id: &str) -> Result<()> {
    let key = flow_state_key(kind, id);
    env.kv(FLOW_STATE_KV_BINDING)?
        .delete(&key)
        .await
        .map_err(|err| worker::Error::RustError(format!("flow-state KV delete: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_namespaced_per_kind() {
        assert_eq!(
            flow_state_key(FlowKind::SecureVerify, "42"),
            "flow:secure_verify:42"
        );
        assert_eq!(
            flow_state_key(FlowKind::Turnstile, "sess-abc"),
            "flow:turnstile:sess-abc"
        );
        assert_eq!(
            flow_state_key(FlowKind::OAuthState, "nonce"),
            "flow:oauth_state:nonce"
        );
        assert_eq!(
            flow_state_key(FlowKind::PasskeyChallenge, "7"),
            "flow:passkey_challenge:7"
        );
        assert_eq!(
            flow_state_key(FlowKind::TwoFaPending, "7"),
            "flow:2fa_pending:7"
        );
        // Distinct kinds never collide for the same id.
        assert_ne!(
            flow_state_key(FlowKind::SecureVerify, "7"),
            flow_state_key(FlowKind::TwoFaPending, "7")
        );
    }

    #[test]
    fn default_ttls_match_go_windows() {
        assert_eq!(FlowKind::SecureVerify.default_ttl_secs(), 300); // Go step-up window
        assert_eq!(FlowKind::TwoFaPending.default_ttl_secs(), 300);
        assert_eq!(FlowKind::PasskeyChallenge.default_ttl_secs(), 300);
        assert_eq!(FlowKind::OAuthState.default_ttl_secs(), 600);
        assert_eq!(FlowKind::Turnstile.default_ttl_secs(), 1800);
    }
}
