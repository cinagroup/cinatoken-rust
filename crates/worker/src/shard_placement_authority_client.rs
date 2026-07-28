//! Bounded private client for exact Shard Placement Authority readback.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::future::{select, Either};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::Duration;
use worker::{Delay, Env, Fetcher, Headers, Method, Request, RequestInit, RequestRedirect};

pub const SHARD_PLACEMENT_AUTHORITY_BINDING: &str = "SHARD_PLACEMENT_AUTHORITY";
pub const SHARD_PLACEMENT_AUTHORITY_READ_ENABLED_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_ENABLED";
pub const SHARD_PLACEMENT_AUTHORITY_ISSUER_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_ISSUER";
pub const SHARD_PLACEMENT_AUTHORITY_AUDIENCE_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_AUDIENCE";
pub const SHARD_PLACEMENT_AUTHORITY_READ_HMAC_KID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_KID";
pub const SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CREDENTIAL_ID_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256";
pub const SHARD_PLACEMENT_AUTHORITY_READ_HMAC_SECRET_ENV: &str =
    "RELAY_CONTAINER_SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CURRENT_SECRET";

const AUTHORITY_HEADER: &str = "x-cinatoken-shard-placement-authority";
const AUTHORITY_ORIGIN: &str = "https://cinatoken-shard-placement-authority.internal";
const HMAC_DOMAIN: &[u8] = b"cinatoken-shard-placement-authority-v1\n";
const EMPTY_BODY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const READ_TIMEOUT: Duration = Duration::from_secs(3);
const READ_RESPONSE_MAX_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactExecutionClaimQuery<'a> {
    pub authorization_id_sha256: &'a str,
    pub claim_digest_sha256: &'a str,
    pub claim_owner_sha256: &'a str,
    pub request_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactExecutionClaimReadback {
    pub credential_id_sha256: String,
    pub response: AuthorityExecutionClaimReadResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityClientError {
    Disabled,
    Configuration,
    Binding,
    Request,
    Timeout,
    Response,
}

impl AuthorityClientError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Configuration => "configuration_invalid",
            Self::Binding => "binding_unavailable",
            Self::Request => "request_failed",
            Self::Timeout => "timeout",
            Self::Response => "response_invalid",
        }
    }
}

struct AuthorityReadConfig {
    issuer: String,
    audience: String,
    kid: String,
    credential_id_sha256: String,
    secret: String,
}

#[derive(Debug, Serialize)]
struct AuthorityTokenHeader<'a> {
    typ: &'static str,
    alg: &'static str,
    kid: &'a str,
}

#[derive(Debug, Serialize)]
struct AuthorityTokenClaims<'a> {
    issuer: &'a str,
    audience: &'a str,
    role: &'static str,
    credential_id_sha256: &'a str,
    request_id: &'a str,
    method: &'static str,
    path_and_query: &'a str,
    body_sha256: &'static str,
    issued_at: i64,
    expires_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionClaimReadResponse {
    pub result: String,
    pub request_id: String,
    pub snapshot: AuthorityExecutionSnapshot,
    pub authority_version_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionSnapshot {
    pub schema_version: i64,
    pub contract: String,
    pub claim: AuthorityExecutionClaim,
    pub state: AuthorityExecutionState,
    pub operations: Vec<AuthorityExecutionOperation>,
    pub receipts: Vec<AuthorityExecutionReceipt>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionClaim {
    pub authorization_id_sha256: String,
    pub permit_subject_digest_sha256: String,
    pub execution_nonce_sha256: String,
    pub application_ticket_id_sha256: String,
    pub application_ticket_digest_sha256: String,
    pub application_database_identity_sha256: String,
    pub authority_database_identity_sha256: String,
    pub campaign_id: String,
    pub campaign_nonce_sha256: String,
    pub claim_scope: String,
    pub execution_plan_sha256: String,
    pub release_sha256: String,
    pub publication_sha256: String,
    pub execution_activation_sha256: String,
    pub runner_build_sha256: String,
    pub claim_owner_sha256: String,
    pub lease_owner_sha256: String,
    pub ledger_identity_sha256: String,
    pub baseline_operation_id_sha256: String,
    pub baseline_terminal_receipt_sha256: String,
    pub preparation_operation_id_sha256: String,
    pub claim_operation_id_sha256: String,
    pub operation_schedule_sha256: String,
    pub claim_credential_id_sha256: String,
    pub claim_request_id_sha256: String,
    pub claim_digest_sha256: String,
    pub claim_acquired_receipt_sha256: String,
    pub generated_at: i64,
    pub permit_expires_at: i64,
    pub normal_deadline_at: i64,
    pub recovery_deadline_at: i64,
    pub claimed_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionState {
    pub status: String,
    pub lease_generation: i64,
    pub lease_expires_at: i64,
    pub next_operation_ordinal: Option<i64>,
    pub active_operation_ordinal: Option<i64>,
    pub inflight_readback_only: bool,
    pub receipt_count: i64,
    pub receipt_head_sha256: String,
    pub controller_enable_intent_recorded: bool,
    pub controller_disabled_verified: bool,
    pub application_activation_digest_sha256: Option<String>,
    pub ticket_activation_confirmed: bool,
    pub renewal_count: i64,
    pub takeover_count: i64,
    pub updated_at: i64,
    pub terminal_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionOperation {
    pub ordinal: i64,
    pub operation_id_sha256: String,
    pub kind: String,
    pub shard_index: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityExecutionReceipt {
    pub sequence: i64,
    pub event_kind: String,
    pub claim_digest_sha256: String,
    pub execution_plan_sha256: String,
    pub ledger_identity_sha256: String,
    pub operation_ordinal: i64,
    pub operation_id_sha256: String,
    pub operation_kind: String,
    pub shard_index: Option<i64>,
    pub predecessor_receipt_sha256: String,
    pub request_sha256: String,
    pub response_sha256: String,
    pub cloudflare_request_id_sha256: String,
    pub evidence_sha256: String,
    pub safety_reason: Option<String>,
    pub outcome: String,
    pub lease_owner_sha256: String,
    pub lease_token_sha256: String,
    pub lease_generation: i64,
    pub lease_expires_at: i64,
    pub receipt_credential_id_sha256: String,
    pub request_id_sha256: String,
    pub receipt_digest_sha256: String,
    pub recorded_at: i64,
}

pub async fn read_exact_execution_claim(
    env: &Env,
    query: &ExactExecutionClaimQuery<'_>,
) -> Result<ExactExecutionClaimReadback, AuthorityClientError> {
    if !runtime_flag(env, SHARD_PLACEMENT_AUTHORITY_READ_ENABLED_ENV) {
        return Err(AuthorityClientError::Disabled);
    }
    if !valid_sha256(query.authorization_id_sha256)
        || !valid_sha256(query.claim_digest_sha256)
        || !valid_sha256(query.claim_owner_sha256)
        || !valid_identity(query.request_id)
    {
        return Err(AuthorityClientError::Request);
    }
    let config = authority_read_config(env).ok_or(AuthorityClientError::Configuration)?;
    let fetcher = env
        .service(SHARD_PLACEMENT_AUTHORITY_BINDING)
        .map_err(|_| AuthorityClientError::Binding)?;
    let path_and_query = format!(
        "/internal/v1/shard-placement/execution-claims/{}?claimDigestSha256={}&claimOwnerSha256={}",
        query.authorization_id_sha256, query.claim_digest_sha256, query.claim_owner_sha256
    );
    let now = (worker::Date::now().as_millis() / 1_000) as i64;
    let token = sign_read_token(&config, query.request_id, &path_and_query, now)
        .ok_or(AuthorityClientError::Configuration)?;
    let request = authority_read_request(&path_and_query, &token)
        .map_err(|_| AuthorityClientError::Request)?;
    let operation = execute_read(&fetcher, request, query.request_id);
    let delay = Delay::from(READ_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    let response = match select(operation, delay).await {
        Either::Left((result, _)) => result?,
        Either::Right(((), _)) => return Err(AuthorityClientError::Timeout),
    };
    Ok(ExactExecutionClaimReadback {
        credential_id_sha256: config.credential_id_sha256,
        response,
    })
}

async fn execute_read(
    fetcher: &Fetcher,
    request: Request,
    request_id: &str,
) -> Result<AuthorityExecutionClaimReadResponse, AuthorityClientError> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| AuthorityClientError::Request)?;
    if response.status_code() != 200 {
        return Err(AuthorityClientError::Response);
    }
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let cache_control = response
        .headers()
        .get("cache-control")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json")
        || !cache_control
            .split(',')
            .any(|directive| directive.trim() == "no-store")
    {
        return Err(AuthorityClientError::Response);
    }
    let body = crate::relay::read_response_bytes_limited(&mut response, READ_RESPONSE_MAX_BYTES)
        .await
        .map_err(|_| AuthorityClientError::Response)?;
    let payload = serde_json::from_slice::<AuthorityExecutionClaimReadResponse>(&body)
        .map_err(|_| AuthorityClientError::Response)?;
    if payload.result != "exact_execution_claim" || payload.request_id != request_id {
        return Err(AuthorityClientError::Response);
    }
    Ok(payload)
}

fn authority_read_config(env: &Env) -> Option<AuthorityReadConfig> {
    let issuer = runtime_value(env, SHARD_PLACEMENT_AUTHORITY_ISSUER_ENV)?;
    let audience = runtime_value(env, SHARD_PLACEMENT_AUTHORITY_AUDIENCE_ENV)?;
    let kid = runtime_value(env, SHARD_PLACEMENT_AUTHORITY_READ_HMAC_KID_ENV)?;
    let credential_id_sha256 =
        runtime_value(env, SHARD_PLACEMENT_AUTHORITY_READ_HMAC_CREDENTIAL_ID_ENV)?;
    let secret = env
        .secret(SHARD_PLACEMENT_AUTHORITY_READ_HMAC_SECRET_ENV)
        .ok()?
        .to_string();
    if !valid_identity(&issuer)
        || !valid_identity(&audience)
        || !valid_key_id(&kid)
        || !valid_sha256(&credential_id_sha256)
        || !(32..=256).contains(&secret.as_bytes().len())
    {
        return None;
    }
    Some(AuthorityReadConfig {
        issuer,
        audience,
        kid,
        credential_id_sha256,
        secret,
    })
}

fn sign_read_token(
    config: &AuthorityReadConfig,
    request_id: &str,
    path_and_query: &str,
    now: i64,
) -> Option<String> {
    if !valid_identity(request_id) || !valid_path_and_query(path_and_query) || now <= 1 {
        return None;
    }
    let header = serde_json::to_vec(&AuthorityTokenHeader {
        typ: "CINATOKEN-SHARD-PLACEMENT-AUTHORITY",
        alg: "HS256",
        kid: &config.kid,
    })
    .ok()?;
    let claims = serde_json::to_vec(&AuthorityTokenClaims {
        issuer: &config.issuer,
        audience: &config.audience,
        role: "read",
        credential_id_sha256: &config.credential_id_sha256,
        request_id,
        method: "GET",
        path_and_query,
        body_sha256: EMPTY_BODY_SHA256,
        issued_at: now.saturating_sub(1),
        expires_at: now.saturating_add(30),
    })
    .ok()?;
    let header_part = URL_SAFE_NO_PAD.encode(header);
    let claims_part = URL_SAFE_NO_PAD.encode(claims);
    let mut mac = Hmac::<Sha256>::new_from_slice(config.secret.as_bytes()).ok()?;
    mac.update(HMAC_DOMAIN);
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(claims_part.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{header_part}.{claims_part}.{signature}"))
}

fn authority_read_request(path_and_query: &str, token: &str) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(&format!("{AUTHORITY_ORIGIN}{path_and_query}"), &init)
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    env.var(name)
        .ok()
        .is_some_and(|value| value.to_string() == "true")
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty() && value == value.trim())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identity(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_path_and_query(value: &str) -> bool {
    (1..=2048).contains(&value.len())
        && value.starts_with('/')
        && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    fn config() -> AuthorityReadConfig {
        AuthorityReadConfig {
            issuer: "cinatoken-shard-placement-operator-runtime-test".to_string(),
            audience: "cinatoken-shard-placement-authority-runtime-test".to_string(),
            kid: "read-current-v1".to_string(),
            credential_id_sha256: "a".repeat(64),
            secret: "0123456789abcdef0123456789abcdef".to_string(),
        }
    }

    #[test]
    fn authority_read_token_is_deterministic_and_body_bound() {
        let path = concat!(
            "/internal/v1/shard-placement/execution-claims/",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "?claimDigestSha256=",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "&claimOwnerSha256=",
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        );
        let first = sign_read_token(&config(), "activation-read-request-1", path, 1_750_000_000)
            .expect("token");
        assert_eq!(
            first,
            concat!(
                "eyJ0eXAiOiJDSU5BVE9LRU4tU0hBUkQtUExBQ0VNRU5ULUFVVEhPUklUWSIsImFsZyI6IkhTMjU2Iiwia2lkIjoicmVhZC1jdXJyZW50LXYxIn0.",
                "eyJpc3N1ZXIiOiJjaW5hdG9rZW4tc2hhcmQtcGxhY2VtZW50LW9wZXJhdG9yLXJ1bnRpbWUtdGVzdCIsImF1ZGllbmNlIjoiY2luYXRva2VuLXNoYXJkLXBsYWNlbWVudC1hdXRob3JpdHktcnVudGltZS10ZXN0Iiwicm9sZSI6InJlYWQiLCJjcmVkZW50aWFsX2lkX3NoYTI1NiI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJyZXF1ZXN0X2lkIjoiYWN0aXZhdGlvbi1yZWFkLXJlcXVlc3QtMSIsIm1ldGhvZCI6IkdFVCIsInBhdGhfYW5kX3F1ZXJ5IjoiL2ludGVybmFsL3YxL3NoYXJkLXBsYWNlbWVudC9leGVjdXRpb24tY2xhaW1zL2JiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI_Y2xhaW1EaWdlc3RTaGEyNTY9Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyZjbGFpbU93bmVyU2hhMjU2PWRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQiLCJib2R5X3NoYTI1NiI6ImUzYjBjNDQyOThmYzFjMTQ5YWZiZjRjODk5NmZiOTI0MjdhZTQxZTQ2NDliOTM0Y2E0OTU5OTFiNzg1MmI4NTUiLCJpc3N1ZWRfYXQiOjE3NDk5OTk5OTksImV4cGlyZXNfYXQiOjE3NTAwMDAwMzB9.",
                "DWt6oKEseW6FuY-goUHP988jDUegBE5Qguuv7Hz_sIg"
            )
        );
        let second = sign_read_token(&config(), "activation-read-request-1", path, 1_750_000_000)
            .expect("token");
        assert_eq!(first, second);
        assert_eq!(first.split('.').count(), 3);
        assert_ne!(
            first,
            sign_read_token(&config(), "activation-read-request-2", path, 1_750_000_000)
                .expect("token")
        );
    }

    #[test]
    fn authority_read_token_rejects_invalid_identity_and_path() {
        assert!(sign_read_token(&config(), " invalid", "/ok", 1_750_000_000).is_none());
        assert!(sign_read_token(&config(), "request-1", "not-a-path", 1_750_000_000).is_none());
        assert!(sign_read_token(&config(), "request-1", "/bad\npath", 1_750_000_000).is_none());
    }

    #[test]
    fn authority_response_contract_rejects_unknown_fields() {
        let invalid = br#"{
          "result":"exact_execution_claim",
          "requestId":"request-1",
          "snapshot":{},
          "authorityVersionId":"version-1",
          "unexpected":true
        }"#;
        assert!(serde_json::from_slice::<AuthorityExecutionClaimReadResponse>(invalid).is_err());
    }

    #[test]
    fn sha256_and_identity_validation_are_strict() {
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(!valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256(&"a".repeat(63)));
        assert!(valid_identity("activation-read-request-1"));
        assert!(!valid_identity(" activation-read-request-1"));
    }

    #[test]
    fn empty_body_digest_is_the_sha256_of_empty_bytes() {
        assert_eq!(
            EMPTY_BODY_SHA256,
            Sha256::digest([])
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }
}
