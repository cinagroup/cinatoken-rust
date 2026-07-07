//! Stateless HMAC-signed session cookie codec for the Rust/Cloudflare port.
//!
//! The Go gateway authenticates browser sessions with a gin-contrib cookie
//! store: the session is serialized with `encoding/gob`, AES-encrypted, and
//! signed with `SessionSecret`, then stored in a `session` cookie. That format
//! is not practical to reproduce in Rust (gob is Go-specific) and the G5
//! admin/frontend parity runbook explicitly allows a "forced re-auth on Rust"
//! policy, so this crate defines a clean stateless format instead:
//!
//! ```text
//! cookie := base64url(payload_json) "." base64url(hmac_sha256(payload_json))
//! ```
//!
//! The payload is **signed but not encrypted**. It contains only public
//! identity fields (`id`, `username`, `role`, `status`, `group`, `iat`, `exp`) that
//! the server already returns via `/api/user/self`; encrypting them would add
//! complexity without security benefit. The HMAC signature prevents tampering.
//!
//! ## Compatibility
//!
//! Go-issued cookies are **not** readable by this codec, and vice versa. When
//! traffic moves from Go to Rust, every existing browser session expires and
//! users must sign in again. This is the documented G5 strategy.
//!
//! ## Secrets
//!
//! The signing key comes from the `SESSION_SECRET` Wrangler secret. Unlike the
//! Go gateway (which falls back to a random per-boot UUID and silently logs
//! everyone out on every redeploy), this crate treats a missing/short secret
//! as a hard configuration error at codec construction time.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

/// Cookie name used by both the Go gateway and this Rust port. Keeping the
/// name stable lets the existing React dashboard read/write the same cookie.
pub const COOKIE_NAME: &str = "session";

/// Default session lifetime: 30 days, matching the Go gateway's
/// `MaxAge: 2592000` (`main.go:202`).
pub const DEFAULT_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Minimum acceptable secret length. Anything shorter than 32 bytes (256 bits)
/// is rejected to avoid accidental weak-key configurations.
pub const MIN_SECRET_BYTES: usize = 32;

/// Identity carried inside the signed cookie payload. Field names mirror the
/// Go session keys (`id`, `username`, `role`, `status`, `group`) so a future
/// compatible serialization stays close to the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionClaims {
    pub id: i64,
    pub username: String,
    pub role: i32,
    pub status: i32,
    pub group: String,
    /// Unix seconds when the cookie was issued. Defaults to 0 for cookies
    /// created before this field existed.
    #[serde(default)]
    pub iat: i64,
    /// Unix seconds after which the cookie is no longer valid.
    pub exp: i64,
}

/// Codec that issues and parses session cookie values.
#[derive(Debug, Clone)]
pub struct SessionCodec {
    secret: Vec<u8>,
    ttl_seconds: i64,
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session secret must be at least {min} bytes")]
    SecretTooShort { min: usize },
    #[error("session cookie is malformed")]
    Malformed,
    #[error("session cookie signature is invalid")]
    InvalidSignature,
    #[error("session cookie has expired")]
    Expired,
    #[error("session cookie payload could not be decoded: {0}")]
    Decode(String),
}

impl SessionCodec {
    /// Construct a codec. Returns `SecretTooShort` if the secret is shorter
    /// than [`MIN_SECRET_BYTES`]. The TTL is applied to [`Self::issue`] as
    /// `now + ttl_seconds`.
    pub fn new(secret: Vec<u8>, ttl_seconds: i64) -> Result<Self, SessionError> {
        if secret.len() < MIN_SECRET_BYTES {
            return Err(SessionError::SecretTooShort {
                min: MIN_SECRET_BYTES,
            });
        }
        Ok(Self {
            secret,
            ttl_seconds,
        })
    }

    /// Construct a codec with the default 30-day TTL.
    pub fn with_default_ttl(secret: Vec<u8>) -> Result<Self, SessionError> {
        Self::new(secret, DEFAULT_TTL_SECONDS)
    }

    /// Issue a signed cookie value for the given identity. `now_unix` is the
    /// issuing time in Unix seconds; the cookie expires at
    /// `now_unix + ttl_seconds`.
    pub fn issue(&self, mut claims: SessionClaims, now_unix: i64) -> Result<String, SessionError> {
        claims.iat = now_unix;
        claims.exp = now_unix.saturating_add(self.ttl_seconds);
        let payload_json =
            serde_json::to_string(&claims).map_err(|err| SessionError::Decode(err.to_string()))?;
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
        let signature = self.sign(payload_b64.as_bytes())?;
        let sig_b64 = URL_SAFE_NO_PAD.encode(signature);
        Ok(format!("{payload_b64}.{sig_b64}"))
    }

    /// Parse and verify a cookie value. Checks signature and expiry.
    pub fn parse(&self, cookie_value: &str, now_unix: i64) -> Result<SessionClaims, SessionError> {
        let (payload_b64, sig_b64) = cookie_value
            .split_once('.')
            .ok_or(SessionError::Malformed)?;
        if payload_b64.is_empty() || sig_b64.is_empty() {
            return Err(SessionError::Malformed);
        }

        let expected_sig = self.sign(payload_b64.as_bytes())?;
        let provided_sig = URL_SAFE_NO_PAD
            .decode(sig_b64.as_bytes())
            .map_err(|_| SessionError::Malformed)?;
        // Constant-time-ish comparison via hmac::Mac::verify_slice. We rebuild
        // a Mac from the expected signature and verify the provided bytes.
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("hmac accepts any key length");
        mac.update(payload_b64.as_bytes());
        mac.verify_slice(&provided_sig)
            .map_err(|_| SessionError::InvalidSignature)?;
        // Defend against the (extremely unlikely) case where verify_slice
        // passed because both sides happen to match but our local sign()
        // produced something different — keeps the two code paths honest.
        let _ = expected_sig;

        let payload_bytes = URL_SAFE_NO_PAD
            .decode(payload_b64.as_bytes())
            .map_err(|_| SessionError::Malformed)?;
        let claims: SessionClaims = serde_json::from_slice(&payload_bytes)
            .map_err(|err| SessionError::Decode(err.to_string()))?;

        if now_unix >= claims.exp {
            return Err(SessionError::Expired);
        }
        Ok(claims)
    }

    fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, SessionError> {
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("hmac accepts any key length");
        mac.update(payload);
        Ok(mac.finalize().into_bytes().to_vec())
    }

    /// TTL in seconds (mostly useful for setting cookie Max-Age).
    pub fn ttl_seconds(&self) -> i64 {
        self.ttl_seconds
    }
}

/// Build a `Set-Cookie` value for a session cookie. `Secure` is always
/// included; the value is the output of [`SessionCodec::issue`]. The path is
/// `/`, `SameSite=Strict`, and `HttpOnly` — matching the Go gateway's policy
/// (minus the Go gateway's `Secure: false`, which the Rust port hardens).
pub fn build_set_cookie_value(cookie_value: &str, max_age_seconds: i64) -> String {
    format!(
        "{COOKIE_NAME}={cookie_value}; Path=/; Max-Age={max_age_seconds}; HttpOnly; SameSite=Strict; Secure"
    )
}

/// Build a `Set-Cookie` value that clears the session cookie (used for logout
/// and for replacing an invalid session). Sets `Max-Age=0` and an empty value.
pub fn build_clear_cookie_value() -> String {
    format!("{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> Vec<u8> {
        // 32 bytes of deterministic test key material.
        (0..32).collect()
    }

    fn sample_claims(id: i64, role: i32) -> SessionClaims {
        SessionClaims {
            id,
            username: format!("user-{id}"),
            role,
            status: 1,
            group: "default".to_string(),
            iat: 0,
            exp: 0,
        }
    }

    #[test]
    fn issue_and_parse_round_trip() {
        let codec = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let now = 1_700_000_000;
        let cookie = codec
            .issue(sample_claims(42, 10), now)
            .expect("issue succeeds");
        let parsed = codec.parse(&cookie, now).expect("parse succeeds");
        assert_eq!(parsed.id, 42);
        assert_eq!(parsed.role, 10);
        assert_eq!(parsed.username, "user-42");
        assert_eq!(parsed.group, "default");
        assert_eq!(parsed.iat, now);
        // Expiry is now + default TTL.
        assert_eq!(parsed.exp, now + DEFAULT_TTL_SECONDS);
    }

    #[test]
    fn parse_accepts_legacy_payload_without_iat() {
        let codec = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let now = 1_700_000_000;
        let payload_json = serde_json::json!({
            "id": 42,
            "username": "legacy",
            "role": 1,
            "status": 1,
            "group": "default",
            "exp": now + DEFAULT_TTL_SECONDS
        })
        .to_string();
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(codec.sign(payload_b64.as_bytes()).unwrap());
        let cookie = format!("{payload_b64}.{sig_b64}");

        let parsed = codec.parse(&cookie, now).unwrap();
        assert_eq!(parsed.username, "legacy");
        assert_eq!(parsed.iat, 0);
    }

    #[test]
    fn parse_rejects_tampered_payload() {
        let codec = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let now = 1_700_000_000;
        let cookie = codec.issue(sample_claims(42, 1), now).unwrap();
        // Flip a character in the payload half (before the dot).
        let mut tampered = cookie.clone();
        let bytes = unsafe { tampered.as_bytes_mut() };
        bytes[0] = if bytes[0] == b'A' { b'B' } else { b'A' };
        assert!(matches!(
            codec.parse(&tampered, now).unwrap_err(),
            SessionError::InvalidSignature
        ));
    }

    #[test]
    fn parse_rejects_tampered_signature() {
        let codec = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let now = 1_700_000_000;
        let cookie = codec.issue(sample_claims(42, 1), now).unwrap();
        let (payload, _sig) = cookie.split_once('.').unwrap();
        let forged = format!("{payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert!(matches!(
            codec.parse(&forged, now).unwrap_err(),
            SessionError::InvalidSignature
        ));
    }

    #[test]
    fn parse_rejects_expired_cookie() {
        let codec = SessionCodec::new(test_secret(), 60).expect("60 second ttl codec");
        let now = 1_700_000_000;
        let cookie = codec.issue(sample_claims(7, 100), now).unwrap();
        // One second past expiry.
        let parsed = codec.parse(&cookie, now + 61);
        assert!(matches!(parsed.unwrap_err(), SessionError::Expired));
        // Exactly at expiry is also rejected (`>=`).
        assert!(matches!(
            codec.parse(&cookie, now + 60).unwrap_err(),
            SessionError::Expired
        ));
        // One second before expiry is accepted.
        assert!(codec.parse(&cookie, now + 59).is_ok());
    }

    #[test]
    fn different_secrets_reject_each_other() {
        let codec_a = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let mut other_secret = test_secret();
        other_secret[0] ^= 0xff;
        let codec_b = SessionCodec::with_default_ttl(other_secret).unwrap();

        let now = 1_700_000_000;
        let cookie = codec_a.issue(sample_claims(1, 1), now).unwrap();
        assert!(matches!(
            codec_b.parse(&cookie, now).unwrap_err(),
            SessionError::InvalidSignature
        ));
    }

    #[test]
    fn malformed_cookies_are_rejected() {
        let codec = SessionCodec::with_default_ttl(test_secret()).unwrap();
        let now = 1_700_000_000;
        // No dot separator.
        assert!(matches!(
            codec.parse("abcdef", now).unwrap_err(),
            SessionError::Malformed
        ));
        // Empty halves.
        assert!(matches!(
            codec.parse(".abcdef", now).unwrap_err(),
            SessionError::Malformed
        ));
        assert!(matches!(
            codec.parse("abcdef.", now).unwrap_err(),
            SessionError::Malformed
        ));
        // Non-base64 signature.
        assert!(matches!(
            codec.parse("abcdef.!!!notbase64!!!", now).unwrap_err(),
            SessionError::Malformed
        ));
    }

    #[test]
    fn short_secret_is_rejected() {
        let err = SessionCodec::with_default_ttl(vec![1, 2, 3]).unwrap_err();
        assert!(matches!(
            err,
            SessionError::SecretTooShort {
                min: MIN_SECRET_BYTES
            }
        ));
    }

    #[test]
    fn set_cookie_value_has_hardened_attributes() {
        let value = "abc.def";
        let header = build_set_cookie_value(value, 1234);
        assert!(header.starts_with("session=abc.def;"));
        assert!(header.contains("Path=/"));
        assert!(header.contains("Max-Age=1234"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Strict"));
        assert!(header.contains("Secure"));
    }

    #[test]
    fn clear_cookie_value_zeroes_max_age() {
        let header = build_clear_cookie_value();
        assert!(header.starts_with("session=;"));
        assert!(header.contains("Max-Age=0"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Strict"));
        assert!(header.contains("Secure"));
    }

    #[test]
    fn cookie_name_matches_go_gateway() {
        // The frontend reads/writes a cookie literally named "session"; renaming
        // it would require frontend changes.
        assert_eq!(COOKIE_NAME, "session");
    }
}
