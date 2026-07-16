use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const AUTHORITY_TYPE: &str = "CINATOKEN-CONTAINER-AUTH";
pub const AUTHORITY_ALGORITHM: &str = "HS256";
pub const AUTHORITY_VERSION: u8 = 1;
pub const DEFAULT_TTL_SECONDS: i64 = 30;
pub const MAX_TTL_SECONDS: i64 = 60;
pub const CLOCK_SKEW_SECONDS: i64 = 5;
pub const MIN_SECRET_BYTES: usize = 32;
pub const MAX_TOKEN_BYTES: usize = 4096;
pub const MAX_JSON_BYTES: usize = 2048;

const SIGNATURE_DOMAIN: &[u8] = b"cinatoken-container-authority:v1\0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedHeader {
    pub typ: String,
    pub alg: String,
    pub kid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityClaims {
    pub authority_version: u8,
    pub issuer: String,
    pub audience: String,
    pub protocol_version: u32,
    pub dispatch_id: String,
    pub body_sha256: String,
    pub method: String,
    pub path: String,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthorityInput<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub protocol_version: u32,
    pub dispatch_id: &'a str,
    pub body_sha256: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub issued_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AuthorityExpectation<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub protocol_version: u32,
    pub body_sha256: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub now: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityError {
    InvalidSecret,
    InvalidInput,
    InvalidToken,
    InvalidHeader,
    InvalidSignature,
    KeyIdMismatch,
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
            Self::InvalidHeader => "invalid authority protected header",
            Self::InvalidSignature => "invalid authority signature",
            Self::KeyIdMismatch => "authority key id mismatch",
            Self::ClaimMismatch => "authority claim mismatch",
            Self::Expired => "authority token expired",
            Self::InvalidTimeWindow => "invalid authority time window",
        })
    }
}

impl std::error::Error for AuthorityError {}

pub fn sign_authority(
    secret: &[u8],
    kid: &str,
    input: AuthorityInput<'_>,
) -> Result<String, AuthorityError> {
    sign_authority_with_ttl(secret, kid, input, DEFAULT_TTL_SECONDS)
}

pub fn sign_authority_with_ttl(
    secret: &[u8],
    kid: &str,
    input: AuthorityInput<'_>,
    ttl_seconds: i64,
) -> Result<String, AuthorityError> {
    validate_secret(secret)?;
    validate_kid(kid)?;
    validate_authority_input(input)?;
    if !(1..=MAX_TTL_SECONDS).contains(&ttl_seconds) {
        return Err(AuthorityError::InvalidTimeWindow);
    }
    let expires_at = input
        .issued_at
        .checked_add(ttl_seconds)
        .ok_or(AuthorityError::InvalidTimeWindow)?;
    let protected = ProtectedHeader {
        typ: AUTHORITY_TYPE.to_string(),
        alg: AUTHORITY_ALGORITHM.to_string(),
        kid: kid.to_string(),
    };
    let claims = AuthorityClaims {
        authority_version: AUTHORITY_VERSION,
        issuer: input.issuer.to_string(),
        audience: input.audience.to_string(),
        protocol_version: input.protocol_version,
        dispatch_id: input.dispatch_id.to_string(),
        body_sha256: input.body_sha256.to_string(),
        method: input.method.to_string(),
        path: input.path.to_string(),
        issued_at: input.issued_at,
        expires_at,
    };

    let protected_json =
        serde_json::to_vec(&protected).map_err(|_| AuthorityError::InvalidInput)?;
    let claims_json = serde_json::to_vec(&claims).map_err(|_| AuthorityError::InvalidInput)?;
    if protected_json.len() > MAX_JSON_BYTES || claims_json.len() > MAX_JSON_BYTES {
        return Err(AuthorityError::InvalidInput);
    }
    let protected_segment = URL_SAFE_NO_PAD.encode(protected_json);
    let claims_segment = URL_SAFE_NO_PAD.encode(claims_json);
    let signature = sign_segments(secret, &protected_segment, &claims_segment)?;
    let token = format!(
        "{protected_segment}.{claims_segment}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    );
    if token.len() > MAX_TOKEN_BYTES {
        return Err(AuthorityError::InvalidInput);
    }
    Ok(token)
}

pub fn verify_authority(
    secret: &[u8],
    expected_kid: &str,
    token: &str,
    expected: AuthorityExpectation<'_>,
) -> Result<AuthorityClaims, AuthorityError> {
    validate_secret(secret)?;
    validate_kid(expected_kid)?;
    validate_expectation(expected)?;

    let decoded = decode_token(token)?;
    let protected: ProtectedHeader = serde_json::from_slice(&decoded.protected_json)
        .map_err(|_| AuthorityError::InvalidHeader)?;
    validate_protected_header(&protected)?;
    if protected.kid != expected_kid {
        return Err(AuthorityError::KeyIdMismatch);
    }

    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| AuthorityError::InvalidSecret)?;
    mac.update(SIGNATURE_DOMAIN);
    mac.update(decoded.protected_segment.as_bytes());
    mac.update(b".");
    mac.update(decoded.claims_segment.as_bytes());
    mac.verify_slice(&decoded.signature)
        .map_err(|_| AuthorityError::InvalidSignature)?;

    // Claims are deliberately not deserialized until their signature is verified.
    let claims: AuthorityClaims =
        serde_json::from_slice(&decoded.claims_json).map_err(|_| AuthorityError::InvalidToken)?;
    validate_claims(&claims, expected)?;
    Ok(claims)
}

pub fn body_sha256(body: &[u8]) -> String {
    Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct DecodedToken<'a> {
    protected_segment: &'a str,
    claims_segment: &'a str,
    protected_json: Vec<u8>,
    claims_json: Vec<u8>,
    signature: Vec<u8>,
}

fn decode_token(token: &str) -> Result<DecodedToken<'_>, AuthorityError> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(AuthorityError::InvalidToken);
    }
    let mut parts = token.split('.');
    let protected_segment = parts.next().ok_or(AuthorityError::InvalidToken)?;
    let claims_segment = parts.next().ok_or(AuthorityError::InvalidToken)?;
    let signature_segment = parts.next().ok_or(AuthorityError::InvalidToken)?;
    if protected_segment.is_empty()
        || claims_segment.is_empty()
        || signature_segment.is_empty()
        || parts.next().is_some()
    {
        return Err(AuthorityError::InvalidToken);
    }

    let protected_json = URL_SAFE_NO_PAD
        .decode(protected_segment)
        .map_err(|_| AuthorityError::InvalidToken)?;
    let claims_json = URL_SAFE_NO_PAD
        .decode(claims_segment)
        .map_err(|_| AuthorityError::InvalidToken)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_segment)
        .map_err(|_| AuthorityError::InvalidToken)?;
    if protected_json.is_empty()
        || protected_json.len() > MAX_JSON_BYTES
        || claims_json.is_empty()
        || claims_json.len() > MAX_JSON_BYTES
        || signature.len() != 32
    {
        return Err(AuthorityError::InvalidToken);
    }

    Ok(DecodedToken {
        protected_segment,
        claims_segment,
        protected_json,
        claims_json,
        signature,
    })
}

fn sign_segments(
    secret: &[u8],
    protected_segment: &str,
    claims_segment: &str,
) -> Result<[u8; 32], AuthorityError> {
    validate_secret(secret)?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| AuthorityError::InvalidSecret)?;
    mac.update(SIGNATURE_DOMAIN);
    mac.update(protected_segment.as_bytes());
    mac.update(b".");
    mac.update(claims_segment.as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

fn validate_secret(secret: &[u8]) -> Result<(), AuthorityError> {
    if secret.len() < MIN_SECRET_BYTES {
        Err(AuthorityError::InvalidSecret)
    } else {
        Ok(())
    }
}

fn validate_kid(kid: &str) -> Result<(), AuthorityError> {
    if !kid.is_empty()
        && kid.len() <= 32
        && kid
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_protected_header(protected: &ProtectedHeader) -> Result<(), AuthorityError> {
    if protected.typ != AUTHORITY_TYPE || protected.alg != AUTHORITY_ALGORITHM {
        return Err(AuthorityError::InvalidHeader);
    }
    validate_kid(&protected.kid).map_err(|_| AuthorityError::InvalidHeader)
}

fn validate_authority_input(input: AuthorityInput<'_>) -> Result<(), AuthorityError> {
    validate_identifier(input.issuer)?;
    validate_identifier(input.audience)?;
    validate_identifier(input.dispatch_id)?;
    validate_protocol_version(input.protocol_version)?;
    validate_body_hash(input.body_sha256)?;
    validate_method(input.method)?;
    validate_path(input.path)?;
    if input.issued_at <= 0 {
        return Err(AuthorityError::InvalidTimeWindow);
    }
    Ok(())
}

fn validate_expectation(expected: AuthorityExpectation<'_>) -> Result<(), AuthorityError> {
    validate_identifier(expected.issuer)?;
    validate_identifier(expected.audience)?;
    validate_protocol_version(expected.protocol_version)?;
    validate_body_hash(expected.body_sha256)?;
    validate_method(expected.method)?;
    validate_path(expected.path)?;
    if expected.now <= 0 {
        return Err(AuthorityError::InvalidTimeWindow);
    }
    Ok(())
}

fn validate_claims(
    claims: &AuthorityClaims,
    expected: AuthorityExpectation<'_>,
) -> Result<(), AuthorityError> {
    validate_identifier(&claims.issuer).map_err(|_| AuthorityError::InvalidToken)?;
    validate_identifier(&claims.audience).map_err(|_| AuthorityError::InvalidToken)?;
    validate_identifier(&claims.dispatch_id).map_err(|_| AuthorityError::InvalidToken)?;
    validate_protocol_version(claims.protocol_version).map_err(|_| AuthorityError::InvalidToken)?;
    validate_body_hash(&claims.body_sha256).map_err(|_| AuthorityError::InvalidToken)?;
    validate_method(&claims.method).map_err(|_| AuthorityError::InvalidToken)?;
    validate_path(&claims.path).map_err(|_| AuthorityError::InvalidToken)?;

    if claims.authority_version != AUTHORITY_VERSION {
        return Err(AuthorityError::ClaimMismatch);
    }
    if claims.issued_at <= 0
        || claims.expires_at <= claims.issued_at
        || claims.expires_at.saturating_sub(claims.issued_at) > MAX_TTL_SECONDS
        || claims.issued_at > expected.now.saturating_add(CLOCK_SKEW_SECONDS)
    {
        return Err(AuthorityError::InvalidTimeWindow);
    }
    if claims.expires_at <= expected.now {
        return Err(AuthorityError::Expired);
    }
    if claims.issuer != expected.issuer
        || claims.audience != expected.audience
        || claims.protocol_version != expected.protocol_version
        || claims.body_sha256 != expected.body_sha256
        || claims.method != expected.method
        || claims.path != expected.path
    {
        return Err(AuthorityError::ClaimMismatch);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), AuthorityError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_protocol_version(version: u32) -> Result<(), AuthorityError> {
    if (1..=255).contains(&version) {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_body_hash(hash: &str) -> Result<(), AuthorityError> {
    if hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_method(method: &str) -> Result<(), AuthorityError> {
    let valid = !method.is_empty()
        && method.len() <= 16
        && method.bytes().all(|byte| byte.is_ascii_uppercase());
    if valid {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

fn validate_path(path: &str) -> Result<(), AuthorityError> {
    if path.starts_with('/')
        && path.len() <= 256
        && !path.contains(['?', '#'])
        && !path.chars().any(char::is_control)
    {
        Ok(())
    } else {
        Err(AuthorityError::InvalidInput)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[derive(Deserialize)]
    struct GoldenVector {
        secret: String,
        kid: String,
        issuer: String,
        audience: String,
        protocol_version: u32,
        dispatch_id: String,
        body_sha256: String,
        method: String,
        path: String,
        issued_at: i64,
        expires_at: i64,
        token: String,
    }

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const OTHER_SECRET: &[u8] = b"abcdef0123456789abcdef0123456789";
    const KID: &str = "container-key-1";
    const BODY_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_BODY_HASH: &str =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn input(issued_at: i64) -> AuthorityInput<'static> {
        AuthorityInput {
            issuer: "worker.prod:1",
            audience: "container.runtime",
            protocol_version: 2,
            dispatch_id: "dispatch_123:abc",
            body_sha256: BODY_HASH,
            method: "POST",
            path: "/v1/containers/run",
            issued_at,
        }
    }

    fn expected(now: i64) -> AuthorityExpectation<'static> {
        AuthorityExpectation {
            issuer: "worker.prod:1",
            audience: "container.runtime",
            protocol_version: 2,
            body_sha256: BODY_HASH,
            method: "POST",
            path: "/v1/containers/run",
            now,
        }
    }

    fn raw_token(protected: &Value, claims: &Value, secret: &[u8]) -> String {
        let protected_segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(protected).unwrap());
        let claims_segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = sign_segments(secret, &protected_segment, &claims_segment).unwrap();
        format!(
            "{protected_segment}.{claims_segment}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        )
    }

    fn token_values(token: &str) -> (Value, Value) {
        let mut parts = token.split('.');
        let protected = URL_SAFE_NO_PAD.decode(parts.next().unwrap()).unwrap();
        let claims = URL_SAFE_NO_PAD.decode(parts.next().unwrap()).unwrap();
        (
            serde_json::from_slice(&protected).unwrap(),
            serde_json::from_slice(&claims).unwrap(),
        )
    }

    fn tamper_claim(token: &str, field: &str, value: Value) -> String {
        let parts: Vec<_> = token.split('.').collect();
        let claims_json = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        let mut claims: Value = serde_json::from_slice(&claims_json).unwrap();
        claims[field] = value;
        format!(
            "{}.{}.{}",
            parts[0],
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()),
            parts[2]
        )
    }

    #[test]
    fn authority_round_trips_with_strict_wire_format() {
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        assert!(token.len() <= MAX_TOKEN_BYTES);
        assert_eq!(token.split('.').count(), 3);

        let (protected, wire_claims) = token_values(&token);
        assert_eq!(protected["typ"], AUTHORITY_TYPE);
        assert_eq!(protected["alg"], AUTHORITY_ALGORITHM);
        assert_eq!(protected["kid"], KID);
        assert_eq!(wire_claims["expires_at"], 130);

        let claims = verify_authority(SECRET, KID, &token, expected(101)).unwrap();
        assert_eq!(claims.authority_version, AUTHORITY_VERSION);
        assert_eq!(claims.dispatch_id, "dispatch_123:abc");
        assert_eq!(claims.method, "POST");
        assert_eq!(claims.path, "/v1/containers/run");
    }

    #[test]
    fn cross_language_golden_vector_is_stable() {
        let vector: GoldenVector = serde_json::from_str(include_str!(
            "../../../tests/fixtures/container-authority-v1.json"
        ))
        .unwrap();
        let input = AuthorityInput {
            issuer: &vector.issuer,
            audience: &vector.audience,
            protocol_version: vector.protocol_version,
            dispatch_id: &vector.dispatch_id,
            body_sha256: &vector.body_sha256,
            method: &vector.method,
            path: &vector.path,
            issued_at: vector.issued_at,
        };
        assert_eq!(
            sign_authority(vector.secret.as_bytes(), &vector.kid, input).unwrap(),
            vector.token
        );
        let claims = verify_authority(
            vector.secret.as_bytes(),
            &vector.kid,
            &vector.token,
            AuthorityExpectation {
                issuer: &vector.issuer,
                audience: &vector.audience,
                protocol_version: vector.protocol_version,
                body_sha256: &vector.body_sha256,
                method: &vector.method,
                path: &vector.path,
                now: vector.issued_at + 1,
            },
        )
        .unwrap();
        assert_eq!(claims.expires_at, vector.expires_at);
    }

    #[test]
    fn custom_ttl_accepts_the_maximum_and_rejects_larger_values() {
        let token = sign_authority_with_ttl(SECRET, KID, input(100), 60).unwrap();
        assert_eq!(
            verify_authority(SECRET, KID, &token, expected(159))
                .unwrap()
                .expires_at,
            160
        );
        assert_eq!(
            sign_authority_with_ttl(SECRET, KID, input(100), 61).unwrap_err(),
            AuthorityError::InvalidTimeWindow
        );
        assert_eq!(
            sign_authority_with_ttl(SECRET, KID, input(100), 0).unwrap_err(),
            AuthorityError::InvalidTimeWindow
        );
    }

    #[test]
    fn tampering_is_rejected() {
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        let parts: Vec<_> = token.split('.').collect();
        let mut signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        signature[0] ^= 0x80;
        let signature_tampered = format!(
            "{}.{}.{}",
            parts[0],
            parts[1],
            URL_SAFE_NO_PAD.encode(signature)
        );
        assert_eq!(
            verify_authority(SECRET, KID, &signature_tampered, expected(101)).unwrap_err(),
            AuthorityError::InvalidSignature
        );

        for tampered in [
            tamper_claim(&token, "method", json!("GET")),
            tamper_claim(&token, "path", json!("/v1/containers/stop")),
        ] {
            assert_eq!(
                verify_authority(SECRET, KID, &tampered, expected(101)).unwrap_err(),
                AuthorityError::InvalidSignature
            );
        }
    }

    #[test]
    fn wrong_key_and_kid_are_rejected() {
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        assert_eq!(
            verify_authority(OTHER_SECRET, KID, &token, expected(101)).unwrap_err(),
            AuthorityError::InvalidSignature
        );
        assert_eq!(
            verify_authority(SECRET, "container-key-2", &token, expected(101)).unwrap_err(),
            AuthorityError::KeyIdMismatch
        );
    }

    #[test]
    fn all_expected_claim_bindings_are_enforced() {
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        let wrong_issuer = AuthorityExpectation {
            issuer: "worker.prod:2",
            ..expected(101)
        };
        let wrong_audience = AuthorityExpectation {
            audience: "container.other",
            ..expected(101)
        };
        let wrong_protocol = AuthorityExpectation {
            protocol_version: 3,
            ..expected(101)
        };
        let wrong_body = AuthorityExpectation {
            body_sha256: OTHER_BODY_HASH,
            ..expected(101)
        };
        let wrong_method = AuthorityExpectation {
            method: "PUT",
            ..expected(101)
        };
        let wrong_path = AuthorityExpectation {
            path: "/v1/containers/stop",
            ..expected(101)
        };
        for expectation in [
            wrong_issuer,
            wrong_audience,
            wrong_protocol,
            wrong_body,
            wrong_method,
            wrong_path,
        ] {
            assert_eq!(
                verify_authority(SECRET, KID, &token, expectation).unwrap_err(),
                AuthorityError::ClaimMismatch
            );
        }
    }

    #[test]
    fn expired_future_and_oversized_time_windows_fail_closed() {
        let expired = sign_authority(SECRET, KID, input(100)).unwrap();
        assert_eq!(
            verify_authority(SECRET, KID, &expired, expected(130)).unwrap_err(),
            AuthorityError::Expired
        );

        let future = sign_authority(SECRET, KID, input(200)).unwrap();
        assert_eq!(
            verify_authority(SECRET, KID, &future, expected(194)).unwrap_err(),
            AuthorityError::InvalidTimeWindow
        );
        assert!(verify_authority(SECRET, KID, &future, expected(195)).is_ok());

        let (protected, mut claims) = token_values(&expired);
        claims["expires_at"] = json!(161);
        let oversized = raw_token(&protected, &claims, SECRET);
        assert_eq!(
            verify_authority(SECRET, KID, &oversized, expected(101)).unwrap_err(),
            AuthorityError::InvalidTimeWindow
        );
    }

    #[test]
    fn token_json_and_signature_bounds_are_enforced() {
        let oversized_token = "a".repeat(MAX_TOKEN_BYTES + 1);
        assert_eq!(
            verify_authority(SECRET, KID, &oversized_token, expected(101)).unwrap_err(),
            AuthorityError::InvalidToken
        );

        let oversized_json = vec![b'a'; MAX_JSON_BYTES + 1];
        let small_json = b"{}";
        let signature = [0_u8; 32];
        let oversized_header = format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(&oversized_json),
            URL_SAFE_NO_PAD.encode(small_json),
            URL_SAFE_NO_PAD.encode(signature)
        );
        assert_eq!(
            verify_authority(SECRET, KID, &oversized_header, expected(101)).unwrap_err(),
            AuthorityError::InvalidToken
        );

        let valid = sign_authority(SECRET, KID, input(100)).unwrap();
        let parts: Vec<_> = valid.split('.').collect();
        let oversized_claims_segment = URL_SAFE_NO_PAD.encode(&oversized_json);
        let oversized_claims_signature =
            sign_segments(SECRET, parts[0], &oversized_claims_segment).unwrap();
        let oversized_claims = format!(
            "{}.{}.{}",
            parts[0],
            oversized_claims_segment,
            URL_SAFE_NO_PAD.encode(oversized_claims_signature)
        );
        assert_eq!(
            verify_authority(SECRET, KID, &oversized_claims, expected(101)).unwrap_err(),
            AuthorityError::InvalidToken
        );

        let short_signature = format!(
            "{}.{}.{}",
            parts[0],
            parts[1],
            URL_SAFE_NO_PAD.encode([0_u8; 31])
        );
        assert_eq!(
            verify_authority(SECRET, KID, &short_signature, expected(101)).unwrap_err(),
            AuthorityError::InvalidToken
        );
    }

    #[test]
    fn unknown_fields_and_noncanonical_headers_are_rejected() {
        let valid = sign_authority(SECRET, KID, input(100)).unwrap();
        let (mut protected, mut claims) = token_values(&valid);

        protected["extra"] = json!(true);
        let unknown_header = raw_token(&protected, &claims, SECRET);
        assert_eq!(
            verify_authority(SECRET, KID, &unknown_header, expected(101)).unwrap_err(),
            AuthorityError::InvalidHeader
        );

        let (mut protected, _) = token_values(&valid);
        claims["extra"] = json!(true);
        let unknown_claim = raw_token(&protected, &claims, SECRET);
        assert_eq!(
            verify_authority(SECRET, KID, &unknown_claim, expected(101)).unwrap_err(),
            AuthorityError::InvalidToken
        );

        protected["typ"] = json!("JWT");
        let wrong_type = raw_token(&protected, &token_values(&valid).1, SECRET);
        assert_eq!(
            verify_authority(SECRET, KID, &wrong_type, expected(101)).unwrap_err(),
            AuthorityError::InvalidHeader
        );
    }

    #[test]
    fn claims_are_not_parsed_before_signature_verification() {
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        let parts: Vec<_> = token.split('.').collect();
        let malformed_claims = URL_SAFE_NO_PAD.encode(b"not-json");
        let token = format!(
            "{}.{}.{}",
            parts[0],
            malformed_claims,
            URL_SAFE_NO_PAD.encode([0_u8; 32])
        );
        assert_eq!(
            verify_authority(SECRET, KID, &token, expected(101)).unwrap_err(),
            AuthorityError::InvalidSignature
        );
    }

    #[test]
    fn short_secrets_are_rejected_for_signing_and_verification() {
        assert_eq!(
            sign_authority(b"short", KID, input(100)).unwrap_err(),
            AuthorityError::InvalidSecret
        );
        let token = sign_authority(SECRET, KID, input(100)).unwrap();
        assert_eq!(
            verify_authority(b"short", KID, &token, expected(101)).unwrap_err(),
            AuthorityError::InvalidSecret
        );
    }

    #[test]
    fn identifiers_hash_protocol_method_and_path_are_validated() {
        assert_eq!(
            body_sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let invalid_issuer = AuthorityInput {
            issuer: "bad issuer",
            ..input(100)
        };
        let invalid_protocol = AuthorityInput {
            protocol_version: 0,
            ..input(100)
        };
        let oversized_protocol = AuthorityInput {
            protocol_version: 256,
            ..input(100)
        };
        let invalid_hash = AuthorityInput {
            body_sha256: OTHER_BODY_HASH.to_ascii_uppercase().leak(),
            ..input(100)
        };
        let lowercase_method = AuthorityInput {
            method: "Post",
            ..input(100)
        };
        let spaced_method = AuthorityInput {
            method: "BAD METHOD",
            ..input(100)
        };
        let missing_slash = AuthorityInput {
            path: "v1/containers/run",
            ..input(100)
        };
        let query_path = AuthorityInput {
            path: "/v1/containers/run?debug=1",
            ..input(100)
        };
        for invalid in [
            invalid_issuer,
            invalid_protocol,
            oversized_protocol,
            invalid_hash,
            lowercase_method,
            spaced_method,
            missing_slash,
            query_path,
        ] {
            assert_eq!(
                sign_authority(SECRET, KID, invalid).unwrap_err(),
                AuthorityError::InvalidInput
            );
        }

        let long_method = AuthorityInput {
            method: "ABCDEFGHIJKLMNOPQ",
            ..input(100)
        };
        let long_path = format!("/{}", "a".repeat(256));
        let long_path_input = AuthorityInput {
            path: &long_path,
            ..input(100)
        };
        assert_eq!(
            sign_authority(SECRET, KID, long_method).unwrap_err(),
            AuthorityError::InvalidInput
        );
        assert_eq!(
            sign_authority(SECRET, KID, long_path_input).unwrap_err(),
            AuthorityError::InvalidInput
        );
    }
}
