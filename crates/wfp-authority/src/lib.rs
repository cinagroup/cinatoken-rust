use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const AUTHORITY_HEADER: &str = "x-cinatoken-wfp-authority";
pub const AUTHORITY_SECRET_ENV: &str = "WFP_RELAY_AUTHORITY_SECRET";
pub const AUTHORITY_TENANT_KEY_ENV: &str = "WFP_RELAY_AUTHORITY_KEY";
pub const AUTHORITY_VERSION: u8 = 1;
pub const AUTHORITY_TTL_SECONDS: i64 = 30;
const MAX_CLOCK_SKEW_SECONDS: i64 = 5;
const MAX_AUTHORITY_LIFETIME_SECONDS: i64 = 60;
const KEY_DOMAIN: &[u8] = b"cinatoken-wfp-authority-key:v1\0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityClaims {
    pub version: u8,
    pub worker: String,
    pub method: String,
    pub path: String,
    pub body_sha256: String,
    pub request_id: String,
    pub channel_id: i64,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthorityInput<'a> {
    pub worker: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
    pub request_id: &'a str,
    pub channel_id: i64,
    pub issued_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthorityExpectation<'a> {
    pub worker: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
    pub now: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityError {
    InvalidSecret,
    InvalidInput,
    InvalidToken,
    InvalidSignature,
    ClaimMismatch,
    Expired,
    InvalidTimeWindow,
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSecret => "invalid authority secret",
            Self::InvalidInput => "invalid authority input",
            Self::InvalidToken => "invalid authority token",
            Self::InvalidSignature => "invalid authority signature",
            Self::ClaimMismatch => "authority claim mismatch",
            Self::Expired => "authority token expired",
            Self::InvalidTimeWindow => "invalid authority time window",
        })
    }
}

impl std::error::Error for AuthorityError {}

pub fn sign_authority(secret: &[u8], input: AuthorityInput<'_>) -> Result<String, AuthorityError> {
    validate_secret(secret)?;
    validate_identity(
        input.worker,
        input.method,
        input.path,
        input.request_id,
        input.channel_id,
    )?;
    let claims = AuthorityClaims {
        version: AUTHORITY_VERSION,
        worker: input.worker.to_string(),
        method: input.method.to_ascii_uppercase(),
        path: input.path.to_string(),
        body_sha256: body_sha256(input.body),
        request_id: input.request_id.to_string(),
        channel_id: input.channel_id,
        issued_at: input.issued_at,
        expires_at: input.issued_at.saturating_add(AUTHORITY_TTL_SECONDS),
    };
    let payload = serde_json::to_vec(&claims).map_err(|_| AuthorityError::InvalidInput)?;
    let signature = sign_payload(secret, input.worker, &payload)?;
    Ok(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn verify_authority(
    secret: &[u8],
    token: &str,
    expected: AuthorityExpectation<'_>,
) -> Result<AuthorityClaims, AuthorityError> {
    let key = derive_worker_key(secret, expected.worker)?;
    verify_authority_with_worker_key(&key, token, expected)
}

pub fn verify_authority_with_worker_key(
    worker_key: &[u8],
    token: &str,
    expected: AuthorityExpectation<'_>,
) -> Result<AuthorityClaims, AuthorityError> {
    validate_worker_key(worker_key)?;
    let mut parts = token.split('.');
    let payload = parts.next().ok_or(AuthorityError::InvalidToken)?;
    let signature = parts.next().ok_or(AuthorityError::InvalidToken)?;
    if parts.next().is_some() {
        return Err(AuthorityError::InvalidToken);
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| AuthorityError::InvalidToken)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| AuthorityError::InvalidToken)?;
    verify_signature_with_worker_key(worker_key, &payload, &signature)?;
    let claims: AuthorityClaims =
        serde_json::from_slice(&payload).map_err(|_| AuthorityError::InvalidToken)?;
    validate_identity(
        &claims.worker,
        &claims.method,
        &claims.path,
        &claims.request_id,
        claims.channel_id,
    )?;
    if claims.version != AUTHORITY_VERSION
        || claims.worker != expected.worker
        || claims.method != expected.method.to_ascii_uppercase()
        || claims.path != expected.path
        || claims.body_sha256 != body_sha256(expected.body)
    {
        return Err(AuthorityError::ClaimMismatch);
    }
    if claims.expires_at <= expected.now {
        return Err(AuthorityError::Expired);
    }
    if claims.issued_at > expected.now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || claims.expires_at <= claims.issued_at
        || claims.expires_at.saturating_sub(claims.issued_at) > MAX_AUTHORITY_LIFETIME_SECONDS
        || expected.now.saturating_sub(claims.issued_at) > MAX_AUTHORITY_LIFETIME_SECONDS
    {
        return Err(AuthorityError::InvalidTimeWindow);
    }
    Ok(claims)
}

pub fn derive_worker_key(secret: &[u8], worker: &str) -> Result<[u8; 32], AuthorityError> {
    validate_secret(secret)?;
    validate_worker_name(worker)?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| AuthorityError::InvalidSecret)?;
    mac.update(KEY_DOMAIN);
    mac.update(worker.as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

pub fn encode_worker_key(key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(key)
}

pub fn decode_worker_key(value: &str) -> Result<[u8; 32], AuthorityError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| AuthorityError::InvalidSecret)?;
    bytes.try_into().map_err(|_| AuthorityError::InvalidSecret)
}

fn validate_secret(secret: &[u8]) -> Result<(), AuthorityError> {
    if secret.len() < 32 {
        Err(AuthorityError::InvalidSecret)
    } else {
        Ok(())
    }
}

fn validate_worker_key(worker_key: &[u8]) -> Result<(), AuthorityError> {
    if worker_key.len() == 32 {
        Ok(())
    } else {
        Err(AuthorityError::InvalidSecret)
    }
}

pub fn validate_worker_name(worker: &str) -> Result<(), AuthorityError> {
    let valid = !worker.is_empty()
        && worker.len() <= 63
        && !worker.starts_with(['-', '_'])
        && !worker.ends_with(['-', '_'])
        && worker
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
    if valid {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_identity(
    worker: &str,
    method: &str,
    path: &str,
    request_id: &str,
    channel_id: i64,
) -> Result<(), AuthorityError> {
    validate_worker_name(worker)?;
    let method_valid = !method.is_empty()
        && method.len() <= 16
        && method.chars().all(|ch| ch.is_ascii_alphabetic());
    let path_valid = path.starts_with('/')
        && path.len() <= 512
        && !path.contains(['?', '#'])
        && !path.chars().any(char::is_control);
    let request_id_valid = !request_id.is_empty()
        && request_id.len() <= 128
        && !request_id.chars().any(char::is_control);
    if method_valid && path_valid && request_id_valid && channel_id > 0 {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn sign_payload(secret: &[u8], worker: &str, payload: &[u8]) -> Result<[u8; 32], AuthorityError> {
    let key = derive_worker_key(secret, worker)?;
    let mut mac = HmacSha256::new_from_slice(&key).map_err(|_| AuthorityError::InvalidSecret)?;
    mac.update(payload);
    Ok(mac.finalize().into_bytes().into())
}

fn verify_signature_with_worker_key(
    worker_key: &[u8],
    payload: &[u8],
    signature: &[u8],
) -> Result<(), AuthorityError> {
    let mut mac =
        HmacSha256::new_from_slice(worker_key).map_err(|_| AuthorityError::InvalidSecret)?;
    mac.update(payload);
    mac.verify_slice(signature)
        .map_err(|_| AuthorityError::InvalidSignature)
}

fn body_sha256(body: &[u8]) -> String {
    Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn input<'a>(body: &'a [u8], issued_at: i64) -> AuthorityInput<'a> {
        AuthorityInput {
            worker: "tenant-a",
            method: "POST",
            path: "/v1/responses",
            body,
            request_id: "req-1",
            channel_id: 42,
            issued_at,
        }
    }

    fn expected<'a>(body: &'a [u8], now: i64) -> AuthorityExpectation<'a> {
        AuthorityExpectation {
            worker: "tenant-a",
            method: "POST",
            path: "/v1/responses",
            body,
            now,
        }
    }

    #[test]
    fn signed_authority_round_trips() {
        let token = sign_authority(SECRET, input(b"{}", 100)).unwrap();
        let claims = verify_authority(SECRET, &token, expected(b"{}", 101)).unwrap();
        assert_eq!(claims.channel_id, 42);
        assert_eq!(claims.request_id, "req-1");

        let worker_key = derive_worker_key(SECRET, "tenant-a").unwrap();
        let encoded = encode_worker_key(&worker_key);
        let decoded = decode_worker_key(&encoded).unwrap();
        assert_eq!(decoded, worker_key);
        assert!(verify_authority_with_worker_key(&decoded, &token, expected(b"{}", 101)).is_ok());
    }

    #[test]
    fn derived_keys_are_tenant_scoped() {
        let tenant_a = derive_worker_key(SECRET, "tenant-a").unwrap();
        let tenant_b = derive_worker_key(SECRET, "tenant-b").unwrap();
        assert_ne!(tenant_a, tenant_b);

        let token = sign_authority(SECRET, input(b"{}", 100)).unwrap();
        assert_eq!(
            verify_authority_with_worker_key(&tenant_b, &token, expected(b"{}", 101)).unwrap_err(),
            AuthorityError::InvalidSignature
        );
        assert_eq!(
            decode_worker_key("not-a-worker-key").unwrap_err(),
            AuthorityError::InvalidSecret
        );
    }

    #[test]
    fn body_path_worker_and_signature_tampering_fail() {
        let token = sign_authority(SECRET, input(b"{}", 100)).unwrap();
        assert_eq!(
            verify_authority(SECRET, &token, expected(b"{\"x\":1}", 101)).unwrap_err(),
            AuthorityError::ClaimMismatch
        );
        let wrong_path = AuthorityExpectation {
            path: "/v1/messages",
            ..expected(b"{}", 101)
        };
        assert_eq!(
            verify_authority(SECRET, &token, wrong_path).unwrap_err(),
            AuthorityError::ClaimMismatch
        );
        let wrong_worker = AuthorityExpectation {
            worker: "tenant-b",
            ..expected(b"{}", 101)
        };
        assert_eq!(
            verify_authority(SECRET, &token, wrong_worker).unwrap_err(),
            AuthorityError::InvalidSignature
        );
        let mut tampered = token.into_bytes();
        *tampered.last_mut().unwrap() = b'A';
        assert!(verify_authority(
            SECRET,
            std::str::from_utf8(&tampered).unwrap(),
            expected(b"{}", 101)
        )
        .is_err());
    }

    #[test]
    fn expired_future_and_oversized_windows_fail_closed() {
        let expired = sign_authority(SECRET, input(b"{}", 100)).unwrap();
        assert_eq!(
            verify_authority(SECRET, &expired, expected(b"{}", 130)).unwrap_err(),
            AuthorityError::Expired
        );
        let future = sign_authority(SECRET, input(b"{}", 200)).unwrap();
        assert_eq!(
            verify_authority(SECRET, &future, expected(b"{}", 100)).unwrap_err(),
            AuthorityError::InvalidTimeWindow
        );
    }

    #[test]
    fn weak_secret_and_invalid_identity_are_rejected() {
        assert_eq!(
            sign_authority(b"short", input(b"{}", 100)).unwrap_err(),
            AuthorityError::InvalidSecret
        );
        let invalid = AuthorityInput {
            worker: "../tenant",
            ..input(b"{}", 100)
        };
        assert_eq!(
            sign_authority(SECRET, invalid).unwrap_err(),
            AuthorityError::InvalidInput
        );
    }
}
