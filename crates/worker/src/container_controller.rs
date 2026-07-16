//! Private edge Worker client for the isolated Container Controller.
//!
//! The probe is deliberately admin-only at its call site, bounded, signed, and
//! default-off. A configured service binding proves reachability only after the
//! controller accepts the shared authority token and reports the expected ring.

use cinatoken_container_authority::{
    body_sha256, sign_authority, AuthorityInput, MIN_SECRET_BYTES,
};
use futures_util::future::{select, Either};
use serde::Deserialize;
use std::time::Duration;
use worker::{Delay, Env, Fetcher, Headers, Method, Request, RequestInit, RequestRedirect};

use crate::container_scheduler::ContainerSchedulerRuntimeStatus;

pub const CONTAINER_CONTROLLER_BINDING: &str = "CONTAINER_CONTROLLER";
pub const CONTAINER_CONTROLLER_PROBE_ENABLED_ENV: &str = "CONTAINER_CONTROLLER_PROBE_ENABLED";
pub const CONTAINER_AUTHORITY_ISSUER_ENV: &str = "CONTAINER_AUTHORITY_ISSUER";
pub const CONTAINER_AUTHORITY_AUDIENCE_ENV: &str = "CONTAINER_AUTHORITY_AUDIENCE";
pub const CONTAINER_AUTHORITY_CURRENT_KID_ENV: &str = "CONTAINER_AUTHORITY_CURRENT_KID";
pub const CONTAINER_AUTHORITY_CURRENT_SECRET_ENV: &str = "CONTAINER_AUTHORITY_CURRENT_SECRET";
pub const CONTAINER_PROTOCOL_VERSION_ENV: &str = "CONTAINER_PROTOCOL_VERSION";

const STATUS_PATH: &str = "/internal/v1/status";
const STATUS_URL: &str = "https://cinatoken-container-controller.internal/internal/v1/status";
const AUTHORITY_HEADER: &str = "x-cinatoken-container-authority";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STATUS_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerControllerProbe {
    pub probe_enabled: bool,
    pub binding_available: bool,
    pub authority_configured: bool,
    pub verified: bool,
    pub controller_enabled: bool,
    pub execution_enabled: bool,
    pub previous_secret_configured: bool,
    pub state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthorityConfig {
    issuer: String,
    audience: String,
    kid: String,
    secret: String,
    protocol_version: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControllerStatusPayload {
    controller_enabled: bool,
    execution_enabled: bool,
    protocol_version: u32,
    ring_generation: u64,
    shard_count: u16,
    authority_current_secret_configured: bool,
    authority_previous_secret_configured: bool,
}

pub fn authority_secret_configured(env: &Env) -> bool {
    env.secret(CONTAINER_AUTHORITY_CURRENT_SECRET_ENV)
        .ok()
        .map(|secret| secret.to_string())
        .is_some_and(|secret| secret.as_bytes().len() >= MIN_SECRET_BYTES)
}

pub async fn probe(
    env: &Env,
    runtime: ContainerSchedulerRuntimeStatus,
) -> ContainerControllerProbe {
    let probe_enabled = runtime_flag(env, CONTAINER_CONTROLLER_PROBE_ENABLED_ENV);
    let fetcher = match env.service(CONTAINER_CONTROLLER_BINDING) {
        Ok(fetcher) => fetcher,
        Err(_) => {
            return failed_probe(
                probe_enabled,
                false,
                authority_secret_configured(env),
                "binding_unavailable",
            )
        }
    };
    if !probe_enabled {
        return failed_probe(false, true, authority_secret_configured(env), "disabled");
    }
    if !runtime.valid {
        return failed_probe(true, true, false, "ring_misconfigured");
    }
    let authority = match authority_config(env) {
        Some(authority) => authority,
        None => return failed_probe(true, true, false, "authority_unavailable"),
    };
    let dispatch_id = match random_status_dispatch_id() {
        Some(dispatch_id) => dispatch_id,
        None => return failed_probe(true, true, true, "entropy_unavailable"),
    };
    let now = (worker::Date::now().as_millis() / 1000) as i64;
    let token = match sign_status_authority(&authority, &dispatch_id, now) {
        Some(token) => token,
        None => return failed_probe(true, true, true, "authority_sign_failed"),
    };
    let request = match status_request(&token) {
        Ok(request) => request,
        Err(_) => return failed_probe(true, true, true, "request_build_failed"),
    };

    let operation = execute_status_probe(&fetcher, request, &authority, runtime);
    let delay = Delay::from(PROBE_TIMEOUT);
    futures_util::pin_mut!(operation);
    futures_util::pin_mut!(delay);
    let payload = match select(operation, delay).await {
        Either::Left((Ok(payload), _)) => payload,
        Either::Left((Err(state), _)) => return failed_probe(true, true, true, state),
        Either::Right(((), _)) => return failed_probe(true, true, true, "timeout"),
    };

    ContainerControllerProbe {
        probe_enabled: true,
        binding_available: true,
        authority_configured: true,
        verified: true,
        controller_enabled: payload.controller_enabled,
        execution_enabled: payload.execution_enabled,
        previous_secret_configured: payload.authority_previous_secret_configured,
        state: "verified",
    }
}

async fn execute_status_probe(
    fetcher: &Fetcher,
    request: Request,
    authority: &AuthorityConfig,
    runtime: ContainerSchedulerRuntimeStatus,
) -> Result<ControllerStatusPayload, &'static str> {
    let mut response = fetcher
        .fetch_request(request)
        .await
        .map_err(|_| "request_failed")?;
    if response.status_code() != 200 {
        return Err("unexpected_status");
    }
    let content_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err("invalid_content_type");
    }
    let body =
        match crate::relay::read_response_bytes_limited(&mut response, STATUS_MAX_BYTES).await {
            Ok(body) => body,
            Err(_) => return Err("invalid_response_size"),
        };
    let payload = match serde_json::from_slice::<ControllerStatusPayload>(&body) {
        Ok(payload) => payload,
        Err(_) => return Err("invalid_response_body"),
    };
    if !status_matches(&payload, &authority, runtime) {
        return Err("contract_mismatch");
    }
    Ok(payload)
}

fn authority_config(env: &Env) -> Option<AuthorityConfig> {
    let issuer = runtime_value(env, CONTAINER_AUTHORITY_ISSUER_ENV)?;
    let audience = runtime_value(env, CONTAINER_AUTHORITY_AUDIENCE_ENV)?;
    let kid = runtime_value(env, CONTAINER_AUTHORITY_CURRENT_KID_ENV)?;
    let protocol_version = runtime_value(env, CONTAINER_PROTOCOL_VERSION_ENV)?
        .parse::<u32>()
        .ok()
        .filter(|version| (1..=255).contains(version))?;
    let secret = env
        .secret(CONTAINER_AUTHORITY_CURRENT_SECRET_ENV)
        .ok()?
        .to_string();
    if secret.as_bytes().len() < MIN_SECRET_BYTES {
        return None;
    }
    Some(AuthorityConfig {
        issuer,
        audience,
        kid,
        secret,
        protocol_version,
    })
}

fn random_status_dispatch_id() -> Option<String> {
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random).ok()?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(format!("status-{suffix}"))
}

fn sign_status_authority(
    authority: &AuthorityConfig,
    dispatch_id: &str,
    now: i64,
) -> Option<String> {
    let body_hash = body_sha256(&[]);
    sign_authority(
        authority.secret.as_bytes(),
        &authority.kid,
        AuthorityInput {
            issuer: &authority.issuer,
            audience: &authority.audience,
            protocol_version: authority.protocol_version,
            dispatch_id,
            body_sha256: &body_hash,
            method: "GET",
            path: STATUS_PATH,
            issued_at: now,
        },
    )
    .ok()
}

fn status_request(token: &str) -> worker::Result<Request> {
    let mut headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set(AUTHORITY_HEADER, token)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    Request::new_with_init(STATUS_URL, &init)
}

fn status_matches(
    payload: &ControllerStatusPayload,
    authority: &AuthorityConfig,
    runtime: ContainerSchedulerRuntimeStatus,
) -> bool {
    payload.protocol_version == authority.protocol_version
        && payload.ring_generation == runtime.ring_generation
        && payload.shard_count == runtime.shard_count
        && payload.authority_current_secret_configured
}

fn failed_probe(
    probe_enabled: bool,
    binding_available: bool,
    authority_configured: bool,
    state: &'static str,
) -> ContainerControllerProbe {
    ContainerControllerProbe {
        probe_enabled,
        binding_available,
        authority_configured,
        verified: false,
        controller_enabled: false,
        execution_enabled: false,
        previous_secret_configured: false,
        state,
    }
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn runtime_flag(env: &Env, name: &str) -> bool {
    runtime_value(env, name).as_deref() == Some("true")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct GoldenVector {
        secret: String,
        kid: String,
        issuer: String,
        audience: String,
        protocol_version: u32,
        dispatch_id: String,
        issued_at: i64,
        token: String,
    }

    #[test]
    fn status_authority_uses_the_shared_empty_body_golden_vector() {
        let vector: GoldenVector = serde_json::from_str(include_str!(
            "../../../tests/fixtures/container-authority-v1.json"
        ))
        .unwrap();
        let authority = AuthorityConfig {
            issuer: vector.issuer,
            audience: vector.audience,
            kid: vector.kid,
            secret: vector.secret,
            protocol_version: vector.protocol_version,
        };
        assert_eq!(
            sign_status_authority(&authority, &vector.dispatch_id, vector.issued_at).unwrap(),
            vector.token
        );
    }

    #[test]
    fn status_payload_must_match_the_active_ring_and_authority() {
        let authority = AuthorityConfig {
            issuer: "cinatoken-edge-test".to_string(),
            audience: "cinatoken-container-controller-test".to_string(),
            kid: "test-v1".to_string(),
            secret: "0123456789abcdef0123456789abcdef".to_string(),
            protocol_version: 1,
        };
        let runtime = ContainerSchedulerRuntimeStatus {
            configured: true,
            valid: true,
            ring_generation: 7,
            shard_count: 16,
        };
        let mut payload = ControllerStatusPayload {
            controller_enabled: false,
            execution_enabled: false,
            protocol_version: 1,
            ring_generation: 7,
            shard_count: 16,
            authority_current_secret_configured: true,
            authority_previous_secret_configured: false,
        };
        assert!(status_matches(&payload, &authority, runtime));
        payload.shard_count = 17;
        assert!(!status_matches(&payload, &authority, runtime));
        payload.shard_count = 16;
        payload.authority_current_secret_configured = false;
        assert!(!status_matches(&payload, &authority, runtime));
    }
}
