//! Private single-attempt provider egress for the Container execution plane.
//!
//! The caller resolves routing and billing before invoking this Worker. This
//! service owns one fixed canary profile and its credential; it never selects
//! a channel, retries a request, or interprets provider usage.

use std::time::Duration;

use futures_util::{future::Either, pin_mut, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use wasm_bindgen::JsValue;
use worker::{
    event, AbortController, Context, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult, WorkerVersionMetadata,
};

pub const EGRESS_PROTOCOL_VERSION: &str = "1";
pub const EGRESS_EXECUTION_PROTOCOL_VERSION: &str = "2";
pub const EGRESS_PROFILE: &str = "openai-chat-completions-canary-v1";
pub const INTERNAL_EGRESS_HOST: &str = "provider-egress.cinatoken.internal";
pub const INTERNAL_EGRESS_PATH: &str = "/internal/v1/provider-attempts/execute";
pub const INTERNAL_EGRESS_READINESS_PATH: &str = "/internal/v1/provider-egress/readiness";
pub const UPSTREAM_HOST: &str = "api.openai.com";
pub const UPSTREAM_PATH: &str = "/v1/chat/completions";
pub const MAX_PROVIDER_BODY_BYTES: usize = 4 * 1024 * 1024;

const ENABLED_ENV: &str = "CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED";
const MODEL_ENV: &str = "CINATOKEN_CONTAINER_PROVIDER_MODEL";
const API_KEY_ENV: &str = "CINATOKEN_CONTAINER_PROVIDER_API_KEY";
const VERSION_METADATA_ENV: &str = "CF_VERSION_METADATA";

const PROTOCOL_HEADER: &str = "x-cinatoken-provider-egress-protocol";
const PROFILE_HEADER: &str = "x-cinatoken-provider-egress-profile";
pub const WORKER_VERSION_HEADER: &str = "x-cinatoken-provider-egress-worker-version";
pub const EXPECTED_WORKER_VERSION_HEADER: &str =
    "x-cinatoken-provider-egress-expected-worker-version";
const OPERATION_ID_HEADER: &str = "x-cinatoken-operation-id";
const OWNER_GENERATION_HEADER: &str = "x-cinatoken-owner-generation";
const ATTEMPT_GENERATION_HEADER: &str = "x-cinatoken-provider-attempt-generation";
const PROVIDER_OPERATION_ID_HEADER: &str = "x-cinatoken-provider-operation-id";
const DEADLINE_HEADER: &str = "x-cinatoken-provider-deadline";
const CONTENT_SHA256_HEADER: &str = "x-cinatoken-content-sha256";

const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "content-language",
    "retry-after",
    "x-request-id",
    "request-id",
    "openai-request-id",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EgressError {
    Disabled,
    Route,
    Method,
    Protocol,
    VersionMismatch,
    Identity,
    ContentType,
    BodyTooLarge,
    BodyRead,
    BodyHash,
    InvalidJson,
    Streaming,
    Model,
    Configuration,
    Credential,
    Upstream,
    Redirect,
}

#[event(fetch)]
pub async fn fetch(mut request: Request, env: Env, _ctx: Context) -> WorkerResult<Response> {
    console_error_panic_hook::set_once();

    if env
        .var(ENABLED_ENV)
        .map(|value| value.to_string())
        .unwrap_or_default()
        != "true"
    {
        return policy_error(EgressError::Disabled);
    }
    let worker_version_id = match worker_version_id(&env) {
        Ok(worker_version_id) => worker_version_id,
        Err(error) => return policy_error(error),
    };

    let url = request.url()?;
    if url.path() == INTERNAL_EGRESS_READINESS_PATH {
        if let Err(error) = validate_readiness_request(request.method(), &url, request.headers()) {
            return versioned_policy_error(error, &worker_version_id);
        }
        return readiness_response(&env, &worker_version_id);
    }
    let deadline_at = match validate_request_metadata(
        request.method(),
        &url,
        request.headers(),
        &worker_version_id,
    ) {
        Ok(deadline_at) => deadline_at,
        Err(error) => return versioned_policy_error(error, &worker_version_id),
    };
    let expected_sha256 = request.headers().get(CONTENT_SHA256_HEADER)?;
    let body = match read_bounded_body(&mut request).await {
        Ok(body) => body,
        Err(error) => return versioned_policy_error(error, &worker_version_id),
    };
    if let Err(error) = validate_body(
        &body,
        expected_sha256.as_deref(),
        env.var(MODEL_ENV)
            .map(|value| value.to_string())
            .ok()
            .as_deref(),
    ) {
        return versioned_policy_error(error, &worker_version_id);
    }

    let api_key = match env.secret(API_KEY_ENV) {
        Ok(secret) if !secret.to_string().trim().is_empty() => secret.to_string(),
        _ => return versioned_policy_error(EgressError::Credential, &worker_version_id),
    };
    let mut outbound_headers = Headers::new();
    outbound_headers.set("accept", "application/json")?;
    outbound_headers.set("content-type", "application/json")?;
    outbound_headers.set("authorization", &format!("Bearer {api_key}"))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(outbound_headers)
        .with_redirect(RequestRedirect::Manual)
        .with_body(Some(JsValue::from(js_sys::Uint8Array::from(
            body.as_slice(),
        ))));
    let outbound =
        Request::new_with_init(&format!("https://{UPSTREAM_HOST}{UPSTREAM_PATH}"), &init)?;
    let mut upstream = match send_with_deadline(outbound, deadline_at).await {
        Ok(response) => response,
        Err(_) => return versioned_policy_error(EgressError::Upstream, &worker_version_id),
    };
    let status = upstream.status_code();
    if (300..=399).contains(&status) {
        return versioned_policy_error(EgressError::Redirect, &worker_version_id);
    }
    let response_headers = public_response_headers(upstream.headers(), &worker_version_id)?;
    let response_body = match read_bounded_response(&mut upstream).await {
        Ok(body) => body,
        Err(error) => return versioned_policy_error(error, &worker_version_id),
    };
    Ok(Response::from_bytes(response_body)?
        .with_status(status)
        .with_headers(response_headers))
}

fn validate_readiness_request(
    method: Method,
    url: &Url,
    headers: &Headers,
) -> Result<(), EgressError> {
    if url.scheme() != "https"
        || url.host_str() != Some(INTERNAL_EGRESS_HOST)
        || url.path() != INTERNAL_EGRESS_READINESS_PATH
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(EgressError::Route);
    }
    if method != Method::Get {
        return Err(EgressError::Method);
    }
    if header(headers, PROTOCOL_HEADER).as_deref() != Some(EGRESS_PROTOCOL_VERSION)
        || header(headers, PROFILE_HEADER).as_deref() != Some(EGRESS_PROFILE)
    {
        return Err(EgressError::Protocol);
    }
    Ok(())
}

fn readiness_response(env: &Env, worker_version_id: &str) -> WorkerResult<Response> {
    let model = env.var(MODEL_ENV).map(|value| value.to_string()).ok();
    if !configured_value(model.as_deref()) {
        return versioned_policy_error(EgressError::Configuration, worker_version_id);
    }
    let api_key = env
        .secret(API_KEY_ENV)
        .map(|secret| secret.to_string())
        .ok();
    if !configured_value(api_key.as_deref()) {
        return versioned_policy_error(EgressError::Credential, worker_version_id);
    }
    let mut headers = no_store_json_headers()?;
    headers.set(PROTOCOL_HEADER, EGRESS_PROTOCOL_VERSION)?;
    headers.set(PROFILE_HEADER, EGRESS_PROFILE)?;
    headers.set(WORKER_VERSION_HEADER, worker_version_id)?;
    Ok(Response::from_json(&serde_json::json!({
        "protocol_version": 1,
        "profile": EGRESS_PROFILE,
        "ready": true,
    }))?
    .with_status(200)
    .with_headers(headers))
}

fn validate_request_metadata(
    method: Method,
    url: &Url,
    headers: &Headers,
    worker_version_id: &str,
) -> Result<u64, EgressError> {
    if method != Method::Post {
        return Err(EgressError::Method);
    }
    if url.scheme() != "https"
        || url.host_str() != Some(INTERNAL_EGRESS_HOST)
        || url.path() != INTERNAL_EGRESS_PATH
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(EgressError::Route);
    }
    if header(headers, PROFILE_HEADER).as_deref() != Some(EGRESS_PROFILE) {
        return Err(EgressError::Protocol);
    }
    let protocol = header(headers, PROTOCOL_HEADER);
    let expected_worker_version = header(headers, EXPECTED_WORKER_VERSION_HEADER);
    validate_execution_version(
        protocol.as_deref(),
        expected_worker_version.as_deref(),
        worker_version_id,
    )?;
    let deadline = header(headers, DEADLINE_HEADER)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(EgressError::Identity)?;
    let now = (js_sys::Date::now() / 1000.0).floor() as u64;
    if !valid_identifier(header(headers, OPERATION_ID_HEADER).as_deref(), 128)
        || !valid_positive_integer(header(headers, OWNER_GENERATION_HEADER).as_deref(), 16)
        || header(headers, ATTEMPT_GENERATION_HEADER).as_deref() != Some("1")
        || !valid_identifier(
            header(headers, PROVIDER_OPERATION_ID_HEADER).as_deref(),
            128,
        )
        || !valid_positive_integer(header(headers, DEADLINE_HEADER).as_deref(), 16)
        || !valid_deadline(now, deadline)
    {
        return Err(EgressError::Identity);
    }
    if header(headers, "content-type")
        .as_deref()
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return Err(EgressError::ContentType);
    }
    if let Some(length) = header(headers, "content-length") {
        let Ok(length) = length.parse::<usize>() else {
            return Err(EgressError::BodyTooLarge);
        };
        if length > MAX_PROVIDER_BODY_BYTES {
            return Err(EgressError::BodyTooLarge);
        }
    }
    Ok(deadline)
}

fn validate_execution_version(
    protocol: Option<&str>,
    expected_worker_version: Option<&str>,
    worker_version_id: &str,
) -> Result<(), EgressError> {
    match protocol {
        Some(EGRESS_PROTOCOL_VERSION) if expected_worker_version.is_none() => Ok(()),
        Some(EGRESS_EXECUTION_PROTOCOL_VERSION)
            if valid_identifier(expected_worker_version, 128)
                && expected_worker_version == Some(worker_version_id) =>
        {
            Ok(())
        }
        Some(EGRESS_EXECUTION_PROTOCOL_VERSION) => Err(EgressError::VersionMismatch),
        _ => Err(EgressError::Protocol),
    }
}

async fn send_with_deadline(request: Request, deadline_at: u64) -> WorkerResult<Response> {
    let now_ms = js_sys::Date::now();
    let remaining_ms = ((deadline_at as f64 * 1000.0) - now_ms).floor();
    if !(1.0..=300_000.0).contains(&remaining_ms) {
        return Err(worker::Error::RustError(
            "provider egress deadline expired".to_string(),
        ));
    }
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch_request = Fetch::Request(request);
    let fetch = fetch_request.send_with_signal(&signal);
    let timeout = Delay::from(Duration::from_millis(remaining_ms as u64));
    pin_mut!(fetch, timeout);
    match futures_util::future::select(fetch, timeout).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => {
            controller.abort();
            Err(worker::Error::RustError(
                "provider egress deadline exceeded".to_string(),
            ))
        }
    }
}

fn validate_body(
    body: &[u8],
    expected_sha256: Option<&str>,
    configured_model: Option<&str>,
) -> Result<(), EgressError> {
    let Some(expected_sha256) = expected_sha256 else {
        return Err(EgressError::BodyHash);
    };
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || format!("{:x}", Sha256::digest(body)) != expected_sha256
    {
        return Err(EgressError::BodyHash);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| EgressError::InvalidJson)?;
    let object = value.as_object().ok_or(EgressError::InvalidJson)?;
    if object
        .get("stream")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(EgressError::Streaming);
    }
    let model = configured_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if model.is_none() || object.get("model").and_then(Value::as_str) != model {
        return Err(EgressError::Model);
    }
    Ok(())
}

async fn read_bounded_body(request: &mut Request) -> Result<Vec<u8>, EgressError> {
    let mut stream = request.stream().map_err(|_| EgressError::BodyRead)?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| EgressError::BodyRead)?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_BODY_BYTES {
            return Err(EgressError::BodyTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Err(EgressError::InvalidJson);
    }
    Ok(body)
}

async fn read_bounded_response(response: &mut Response) -> Result<Vec<u8>, EgressError> {
    if let Some(length) = header(response.headers(), "content-length") {
        let length = length.parse::<usize>().map_err(|_| EgressError::Upstream)?;
        if length > MAX_PROVIDER_BODY_BYTES {
            return Err(EgressError::Upstream);
        }
    }
    let mut stream = response.stream().map_err(|_| EgressError::Upstream)?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| EgressError::Upstream)?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_BODY_BYTES {
            return Err(EgressError::Upstream);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn public_response_headers(source: &Headers, worker_version_id: &str) -> WorkerResult<Headers> {
    let mut result = Headers::new();
    result.set("cache-control", "no-store")?;
    result.set(WORKER_VERSION_HEADER, worker_version_id)?;
    for name in FORWARDED_RESPONSE_HEADERS {
        if let Some(value) = source.get(name)? {
            result.set(name, &value)?;
        }
    }
    Ok(result)
}

fn policy_error(error: EgressError) -> WorkerResult<Response> {
    policy_error_with_version(error, None)
}

fn versioned_policy_error(error: EgressError, worker_version_id: &str) -> WorkerResult<Response> {
    policy_error_with_version(error, Some(worker_version_id))
}

fn policy_error_with_version(
    error: EgressError,
    worker_version_id: Option<&str>,
) -> WorkerResult<Response> {
    let (status, code) = match error {
        EgressError::Disabled => (503, "provider_egress_disabled"),
        EgressError::Route => (404, "provider_egress_route_not_found"),
        EgressError::Method => (405, "provider_egress_method_not_allowed"),
        EgressError::Protocol | EgressError::Identity => (403, "provider_egress_access_denied"),
        EgressError::VersionMismatch => (409, "provider_egress_worker_version_mismatch"),
        EgressError::ContentType => (415, "provider_egress_content_type_invalid"),
        EgressError::BodyTooLarge => (413, "provider_egress_body_too_large"),
        EgressError::BodyRead
        | EgressError::BodyHash
        | EgressError::InvalidJson
        | EgressError::Streaming
        | EgressError::Model => (400, "provider_egress_request_invalid"),
        EgressError::Configuration => (503, "provider_egress_configuration_unavailable"),
        EgressError::Credential => (503, "provider_egress_credential_unavailable"),
        EgressError::Upstream => (502, "provider_egress_upstream_failed"),
        EgressError::Redirect => (502, "provider_egress_redirect_denied"),
    };
    let mut headers = no_store_json_headers()?;
    if let Some(worker_version_id) = worker_version_id {
        headers.set(WORKER_VERSION_HEADER, worker_version_id)?;
    }
    Ok(Response::from_json(&serde_json::json!({ "error": code }))?
        .with_status(status)
        .with_headers(headers))
}

fn no_store_json_headers() -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    headers.set("cache-control", "no-store")?;
    headers.set("content-type", "application/json; charset=utf-8")?;
    Ok(headers)
}

fn header(headers: &Headers, name: &str) -> Option<String> {
    headers.get(name).ok().flatten()
}

fn worker_version_id(env: &Env) -> Result<String, EgressError> {
    let id = env
        .get_binding::<WorkerVersionMetadata>(VERSION_METADATA_ENV)
        .map_err(|_| EgressError::Configuration)?
        .id();
    if valid_identifier(Some(id.as_str()), 128) {
        Ok(id)
    } else {
        Err(EgressError::Configuration)
    }
}

fn valid_identifier(value: Option<&str>, max: usize) -> bool {
    value.is_some_and(|value| {
        !value.is_empty()
            && value.len() <= max
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
            })
    })
}

fn valid_positive_integer(value: Option<&str>, max_digits: usize) -> bool {
    value.is_some_and(|value| {
        !value.is_empty()
            && value.len() <= max_digits
            && !value.starts_with('0')
            && value.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn valid_deadline(now: u64, deadline: u64) -> bool {
    deadline > now && deadline <= now.saturating_add(300)
}

fn configured_value(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_configured_non_streaming_model_and_exact_digest() {
        let body = br#"{"model":"canary-model","messages":[],"stream":false}"#;
        let digest = format!("{:x}", Sha256::digest(body));
        assert_eq!(
            validate_body(body, Some(&digest), Some("canary-model")),
            Ok(())
        );
        assert_eq!(
            validate_body(body, Some(&"0".repeat(64)), Some("canary-model")),
            Err(EgressError::BodyHash)
        );
        assert_eq!(
            validate_body(body, Some(&digest), Some("other-model")),
            Err(EgressError::Model)
        );
    }

    #[test]
    fn rejects_streaming_and_missing_model_configuration() {
        let streaming = br#"{"model":"canary-model","stream":true}"#;
        let digest = format!("{:x}", Sha256::digest(streaming));
        assert_eq!(
            validate_body(streaming, Some(&digest), Some("canary-model")),
            Err(EgressError::Streaming)
        );
        let body = br#"{"model":"canary-model"}"#;
        let digest = format!("{:x}", Sha256::digest(body));
        assert_eq!(
            validate_body(body, Some(&digest), None),
            Err(EgressError::Model)
        );
    }

    #[test]
    fn validates_bounded_identity_syntax() {
        assert!(valid_identifier(Some("operation:1"), 128));
        assert!(!valid_identifier(Some("operation 1"), 128));
        assert!(valid_positive_integer(Some("123"), 16));
        assert!(!valid_positive_integer(Some("01"), 16));
        assert!(valid_deadline(1_000, 1_300));
        assert!(!valid_deadline(1_000, 1_000));
        assert!(!valid_deadline(1_000, 1_301));
    }

    #[test]
    fn execution_v2_requires_the_exact_runtime_worker_version() {
        assert_eq!(
            validate_execution_version(
                Some(EGRESS_EXECUTION_PROTOCOL_VERSION),
                Some("worker-version-1"),
                "worker-version-1",
            ),
            Ok(())
        );
        for expected in [None, Some("worker-version-2"), Some("bad version")] {
            assert_eq!(
                validate_execution_version(
                    Some(EGRESS_EXECUTION_PROTOCOL_VERSION),
                    expected,
                    "worker-version-1",
                ),
                Err(EgressError::VersionMismatch)
            );
        }
        assert_eq!(
            validate_execution_version(Some(EGRESS_PROTOCOL_VERSION), None, "worker-version-1"),
            Ok(())
        );
        assert_eq!(
            validate_execution_version(
                Some(EGRESS_PROTOCOL_VERSION),
                Some("worker-version-1"),
                "worker-version-1",
            ),
            Err(EgressError::Protocol)
        );
    }

    #[test]
    fn readiness_requires_nonempty_model_and_credential_without_exposing_values() {
        assert!(configured_value(Some("canary-model")));
        assert!(configured_value(Some("provider-secret")));
        assert!(!configured_value(None));
        assert!(!configured_value(Some("  ")));
    }
}
