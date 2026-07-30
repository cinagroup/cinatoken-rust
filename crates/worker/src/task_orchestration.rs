//! Worker-side task polling I/O.
//!
//! The pure halves — building the upstream poll request, parsing the response,
//! and deciding the settlement — live in `cinatoken_tasks` and are host-tested.
//! This module is the thin wasm I/O that executes a [`PollRequest`] over the
//! Workers `fetch` runtime and threads the bytes into the parser + the D1
//! settle-apply. It is foundation ahead of the submit flow / poll trigger /
//! routes that drive it; runtime-verified by a staging poll.
#![allow(dead_code)]

use crate::task_repository::{
    advance_task_poll_family_cursor, apply_poll_result, apply_task_timeout,
    attach_task_billing_intent, claim_task_poll_lease, claim_task_timeout_poll_lease,
    find_task_billing_intent_for_owner, find_timed_out_unfinished_tasks,
    find_unfinished_suno_tasks, find_unfinished_tasks, generate_task_id, generate_task_poll_owner,
    mark_task_billing_intent_submit_unknown,
    mark_task_billing_intent_submit_unknown_with_provider_task_id,
    mark_task_billing_intent_submitting, record_task_poll_failure,
    reject_and_refund_task_billing_intent, release_task_poll_lease, reserve_task_billing_intent,
    NewTask, TaskBillingIntent, TaskBillingIntentAttachOutcome, TaskBillingIntentRecord,
    TaskBillingIntentReserveOutcome, TaskPollLease, TaskRow, TASK_BILLING_INTENT_LEASE_SECONDS,
};
use base64::{
    engine::general_purpose::{
        STANDARD as BASE64_STANDARD, STANDARD_NO_PAD as BASE64_STANDARD_NO_PAD,
    },
    Engine as _,
};
use cinatoken_auth::USER_STATUS_ENABLED;
use cinatoken_billing::{
    free_model_runtime_decision, FlatBillingMode, FlatPricingSnapshot, FreeModelRuntimeDecision,
    PricingConfig,
};
use cinatoken_ssrf::SsrfPolicy;
use cinatoken_tasks::providers::poll_request::{self, HttpMethod, PollRequest};
use cinatoken_tasks::providers::{
    ali, doubao, gemini, hailuo, jimeng, kling, midjourney, sora, submit_request, suno, vertex,
    vidu, SubmitResponseFailure, VideoProvider,
};
use cinatoken_tasks::taskcommon::decode_local_task_id;
use cinatoken_tasks::{
    apply_other_ratios, cover_task_action_to_model_name, TaskInfo, TaskStatus, TaskSubmitReq,
};
use futures_util::future::{select, Either};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    AbortController, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response,
};

const VIDEO_CONTENT_DATA_URL_MAX_BYTES: usize = 25 * 1024 * 1024;
const VIDEO_PROXY_REDIRECT_POLICY: RequestRedirect = RequestRedirect::Error;
const TASK_ACTION_GENERATE: &str = "generate";
const TASK_ACTION_TEXT_GENERATE: &str = "textGenerate";
const TASK_ACTION_REMIX: &str = "remixGenerate";
const TASK_IDEMPOTENCY_KEY_HEADER: &str = "Idempotency-Key";
const TASK_IDEMPOTENCY_KEY_MAX_LEN: usize = 128;
pub(crate) const TASK_QUERY_LIMIT_ENV: &str = "TASK_QUERY_LIMIT";
pub(crate) const TASK_TIMEOUT_MINUTES_ENV: &str = "TASK_TIMEOUT_MINUTES";
pub(crate) const TASK_POLL_LEASE_SECONDS_ENV: &str = "TASK_POLL_LEASE_SECONDS";
pub(crate) const TASK_POLL_LEASE_ENABLED_ENV: &str = "TASK_POLL_LEASE_ENABLED";
pub(crate) const TASK_POLL_SCHEDULER_ENABLED_ENV: &str = "TASK_POLL_SCHEDULER_ENABLED";
pub(crate) const TASK_POLL_RETRY_BASE_SECONDS_ENV: &str = "TASK_POLL_RETRY_BASE_SECONDS";
pub(crate) const TASK_POLL_RETRY_MAX_SECONDS_ENV: &str = "TASK_POLL_RETRY_MAX_SECONDS";
pub(crate) const TASK_POLL_MAX_CONSECUTIVE_FAILURES_ENV: &str =
    "TASK_POLL_MAX_CONSECUTIVE_FAILURES";
pub(crate) const TASK_SUBMIT_TIMEOUT_SECONDS_ENV: &str = "TASK_SUBMIT_TIMEOUT_SECONDS";
pub(crate) const TASK_CLIENT_IDEMPOTENCY_REQUIRED_ENV: &str = "TASK_CLIENT_IDEMPOTENCY_REQUIRED";
pub(crate) const DEFAULT_TASK_QUERY_LIMIT: i64 = 100;
pub(crate) const DEFAULT_TASK_TIMEOUT_MINUTES: i64 = 1_440;
pub(crate) const DEFAULT_TASK_POLL_LEASE_SECONDS: i64 = 120;
pub(crate) const DEFAULT_TASK_POLL_RETRY_BASE_SECONDS: i64 = 15;
pub(crate) const DEFAULT_TASK_POLL_RETRY_MAX_SECONDS: i64 = 900;
pub(crate) const DEFAULT_TASK_POLL_MAX_CONSECUTIVE_FAILURES: i64 = 8;
pub(crate) const DEFAULT_TASK_SUBMIT_TIMEOUT_SECONDS: i64 = 90;
pub(crate) const TASK_TIMEOUT_SWEEP_LIMIT: i64 = 100;
const MAX_TASK_QUERY_LIMIT: i64 = 1_000;
const MAX_TASK_TIMEOUT_MINUTES: i64 = 30 * 24 * 60;
const MIN_TASK_POLL_LEASE_SECONDS: i64 = 30;
const MAX_TASK_POLL_LEASE_SECONDS: i64 = 900;
const MAX_TASK_POLL_RETRY_SECONDS: i64 = 86_400;
const MAX_TASK_POLL_CONSECUTIVE_FAILURES: i64 = 100;
const MIN_TASK_SUBMIT_TIMEOUT_SECONDS: i64 = 5;
const MAX_TASK_SUBMIT_TIMEOUT_SECONDS: i64 = 120;
const TASK_PROVIDER_POLL_MAX_TIMEOUT_SECONDS: i64 = 90;
const TASK_PROVIDER_POLL_LEASE_SAFETY_SECONDS: i64 = 15;
pub(crate) const TASK_POLL_FAMILY_QUERY_LIMIT: i64 = 8;
const TASK_POLL_STORED_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const TASK_PROVIDER_RESPONSE_MAX_BYTES: usize = 4 * 1024 * 1024;
const TASK_POLL_STORED_VIDEO_PREFIX_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TaskSubmitTimeoutRuntimeStatus {
    pub configured: bool,
    pub valid: bool,
    pub effective_seconds: i64,
}

#[derive(Debug, Clone, Copy)]
struct TaskSubmitDeadline {
    deadline_ms: f64,
}

impl TaskSubmitDeadline {
    fn until(deadline_at: i64) -> Self {
        Self {
            deadline_ms: deadline_at.max(0) as f64 * 1_000.0,
        }
    }

    fn remaining(&self) -> worker::Result<Duration> {
        let remaining_ms = self.deadline_ms - js_sys::Date::now();
        if remaining_ms <= 0.0 {
            return Err(worker::Error::RustError(
                "task provider submit deadline expired".to_string(),
            ));
        }
        Ok(Duration::from_millis(remaining_ms.ceil() as u64))
    }
}

fn task_submit_timeout_value(raw: Option<&str>) -> Option<i64> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| {
            (MIN_TASK_SUBMIT_TIMEOUT_SECONDS..=MAX_TASK_SUBMIT_TIMEOUT_SECONDS).contains(value)
        })
}

pub(crate) fn task_submit_timeout_runtime_status(env: &Env) -> TaskSubmitTimeoutRuntimeStatus {
    let raw = env
        .var(TASK_SUBMIT_TIMEOUT_SECONDS_ENV)
        .ok()
        .map(|value| value.to_string());
    let configured = raw.as_deref().is_some_and(|value| !value.trim().is_empty());
    let parsed = task_submit_timeout_value(raw.as_deref());
    TaskSubmitTimeoutRuntimeStatus {
        configured,
        valid: configured && parsed.is_some(),
        effective_seconds: parsed.unwrap_or(DEFAULT_TASK_SUBMIT_TIMEOUT_SECONDS),
    }
}

pub(crate) fn task_client_idempotency_required(env: &Env) -> bool {
    env.var(TASK_CLIENT_IDEMPOTENCY_REQUIRED_ENV)
        .ok()
        .is_some_and(|value| value.to_string().trim().eq_ignore_ascii_case("true"))
}

fn task_submit_deadline_at(now: i64, timeout_seconds: i64) -> i64 {
    now.saturating_add(timeout_seconds.clamp(
        MIN_TASK_SUBMIT_TIMEOUT_SECONDS,
        MAX_TASK_SUBMIT_TIMEOUT_SECONDS,
    ))
}

fn task_submit_idempotency_key(req: &Request, required: bool) -> Result<Option<String>, String> {
    let Some(value) = req
        .headers()
        .get(TASK_IDEMPOTENCY_KEY_HEADER)
        .ok()
        .flatten()
    else {
        return if required {
            Err("Idempotency-Key header is required".to_string())
        } else {
            Ok(None)
        };
    };
    let value = value.trim();
    if value.is_empty()
        || value.len() > TASK_IDEMPOTENCY_KEY_MAX_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid Idempotency-Key header".to_string());
    }
    Ok(Some(value.to_string()))
}

fn task_submit_digest(domain: &str, parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

fn task_submit_client_operation_digest(
    user_id: i64,
    token_id: i64,
    task_kind: &str,
    client_key: Option<&str>,
    fallback_public_task_id: &str,
) -> String {
    let user_id = user_id.to_string();
    let token_id = token_id.to_string();
    let key = client_key.unwrap_or(fallback_public_task_id);
    let mode = if client_key.is_some() {
        b"client".as_slice()
    } else {
        b"generated".as_slice()
    };
    task_submit_digest(
        "cinatoken:task-client-operation:v1",
        &[
            user_id.as_bytes(),
            token_id.as_bytes(),
            task_kind.as_bytes(),
            mode,
            key.as_bytes(),
        ],
    )
}

fn task_submit_client_request_digest(scope: &str, body: &[u8]) -> String {
    task_submit_digest(
        "cinatoken:task-client-request:v1",
        &[scope.as_bytes(), body],
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskPollFamily {
    Video,
    Suno,
    Midjourney,
}

pub(crate) fn task_poll_family_for_slot(now: i64) -> TaskPollFamily {
    match now.saturating_div(60).rem_euclid(3) {
        0 => TaskPollFamily::Video,
        1 => TaskPollFamily::Suno,
        _ => TaskPollFamily::Midjourney,
    }
}

pub(crate) fn task_poll_family_query_limit(query_limit: i64) -> i64 {
    query_limit.clamp(1, TASK_POLL_FAMILY_QUERY_LIMIT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TaskPollerConfig {
    pub query_limit: i64,
    pub timeout_minutes: i64,
    pub timeout_sweep_limit: i64,
    pub poll_lease_seconds: i64,
    pub scheduler_enabled: bool,
    pub retry_base_seconds: i64,
    pub retry_max_seconds: i64,
    pub max_consecutive_failures: i64,
}

pub(crate) fn task_poller_config_from_env(env: &Env) -> TaskPollerConfig {
    let retry_base_seconds = parse_task_i64_env(
        env.var(TASK_POLL_RETRY_BASE_SECONDS_ENV)
            .ok()
            .map(|value| value.to_string()),
        DEFAULT_TASK_POLL_RETRY_BASE_SECONDS,
        1,
        MAX_TASK_POLL_RETRY_SECONDS,
    );
    let retry_max_seconds = parse_task_i64_env(
        env.var(TASK_POLL_RETRY_MAX_SECONDS_ENV)
            .ok()
            .map(|value| value.to_string()),
        DEFAULT_TASK_POLL_RETRY_MAX_SECONDS,
        retry_base_seconds,
        MAX_TASK_POLL_RETRY_SECONDS,
    )
    .max(retry_base_seconds);
    TaskPollerConfig {
        query_limit: parse_task_i64_env(
            env.var(TASK_QUERY_LIMIT_ENV)
                .ok()
                .map(|value| value.to_string()),
            DEFAULT_TASK_QUERY_LIMIT,
            1,
            MAX_TASK_QUERY_LIMIT,
        ),
        timeout_minutes: parse_task_i64_env(
            env.var(TASK_TIMEOUT_MINUTES_ENV)
                .ok()
                .map(|value| value.to_string()),
            DEFAULT_TASK_TIMEOUT_MINUTES,
            0,
            MAX_TASK_TIMEOUT_MINUTES,
        ),
        timeout_sweep_limit: TASK_TIMEOUT_SWEEP_LIMIT,
        poll_lease_seconds: task_poll_lease_seconds_from_env(env),
        scheduler_enabled: task_poll_scheduler_enabled(env),
        retry_base_seconds,
        retry_max_seconds,
        max_consecutive_failures: parse_task_i64_env(
            env.var(TASK_POLL_MAX_CONSECUTIVE_FAILURES_ENV)
                .ok()
                .map(|value| value.to_string()),
            DEFAULT_TASK_POLL_MAX_CONSECUTIVE_FAILURES,
            1,
            MAX_TASK_POLL_CONSECUTIVE_FAILURES,
        ),
    }
}

pub(crate) fn task_poll_lease_seconds_from_env(env: &Env) -> i64 {
    parse_task_i64_env(
        env.var(TASK_POLL_LEASE_SECONDS_ENV)
            .ok()
            .map(|value| value.to_string()),
        DEFAULT_TASK_POLL_LEASE_SECONDS,
        MIN_TASK_POLL_LEASE_SECONDS,
        MAX_TASK_POLL_LEASE_SECONDS,
    )
}

pub(crate) fn task_poll_lease_enabled(env: &Env) -> bool {
    env.var(TASK_POLL_LEASE_ENABLED_ENV)
        .ok()
        .map(|value| {
            matches!(
                value.to_string().trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn task_poll_scheduler_enabled(env: &Env) -> bool {
    env.var(TASK_POLL_SCHEDULER_ENABLED_ENV)
        .ok()
        .map(|value| {
            matches!(
                value.to_string().trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn task_poll_next_at(now: i64, retry_base_seconds: i64) -> i64 {
    now.saturating_add(retry_base_seconds.max(1))
}

fn truncate_task_poll_video_value(value: &str) -> String {
    if value.chars().count() <= TASK_POLL_STORED_VIDEO_PREFIX_CHARS {
        return value.to_string();
    }
    let prefix: String = value
        .chars()
        .take(TASK_POLL_STORED_VIDEO_PREFIX_CHARS)
        .collect();
    format!("{prefix}...")
}

fn redact_task_poll_response_body(body: &[u8]) -> String {
    let mut value = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(value) => value,
        Err(_) if body.len() <= TASK_POLL_STORED_RESPONSE_MAX_BYTES => {
            return String::from_utf8_lossy(body).into_owned();
        }
        Err(_) => return task_poll_response_overflow_metadata(body),
    };
    if let Some(response) = value
        .get_mut("response")
        .and_then(serde_json::Value::as_object_mut)
    {
        response.remove("bytesBase64Encoded");
        if let Some(video) = response
            .get_mut("video")
            .and_then(|value| value.as_str())
            .map(truncate_task_poll_video_value)
        {
            response.insert("video".to_string(), serde_json::Value::String(video));
        }
        if let Some(videos) = response
            .get_mut("videos")
            .and_then(serde_json::Value::as_array_mut)
        {
            for video in videos {
                if let Some(video) = video.as_object_mut() {
                    video.remove("bytesBase64Encoded");
                }
            }
        }
    }
    match serde_json::to_string(&value) {
        Ok(encoded) if encoded.len() <= TASK_POLL_STORED_RESPONSE_MAX_BYTES => encoded,
        _ => task_poll_response_overflow_metadata(body),
    }
}

fn task_poll_response_overflow_metadata(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    let digest_hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    serde_json::json!({
        "redacted": true,
        "reason": "provider_response_too_large",
        "original_bytes": body.len(),
        "sha256": digest_hex,
    })
    .to_string()
}

pub(crate) fn task_poll_provider_timeout_seconds(lease_seconds: i64) -> u64 {
    lease_seconds
        .saturating_sub(TASK_PROVIDER_POLL_LEASE_SAFETY_SECONDS)
        .clamp(1, TASK_PROVIDER_POLL_MAX_TIMEOUT_SECONDS) as u64
}

fn task_poll_provider_timeout_until(expires_at: i64, now: i64) -> Option<u64> {
    let remaining_seconds = expires_at.saturating_sub(now);
    if remaining_seconds <= TASK_PROVIDER_POLL_LEASE_SAFETY_SECONDS {
        return None;
    }
    Some(task_poll_provider_timeout_seconds(remaining_seconds))
}

fn task_poll_now_unix_seconds() -> i64 {
    (js_sys::Date::now() / 1_000.0).floor() as i64
}

pub(crate) fn task_timeout_sweep_compiled() -> bool {
    TASK_TIMEOUT_SWEEP_LIMIT > 0 && DEFAULT_TASK_TIMEOUT_MINUTES > 0 && DEFAULT_TASK_QUERY_LIMIT > 0
}

pub(crate) fn parse_task_i64_env(
    value: Option<String>,
    default_value: i64,
    min_value: i64,
    max_value: i64,
) -> i64 {
    let Some(value) = value else {
        return default_value;
    };
    match value.trim().parse::<i64>() {
        Ok(parsed) if parsed >= min_value => parsed.min(max_value),
        _ => default_value,
    }
}

/// Build the submit request body for a provider by dispatching to its ported
/// body transform (the submit half of Go `BuildRequestBody`). The JSON-payload
/// providers serialize their `convert_to_request_payload`; Sora overrides `model`
/// in the raw client body; Gemini/Vertex share the Veo payload. All providers'
/// bodies are ported. `raw_client_body` is the original request body Sora
/// reshapes.
pub fn build_submit_body(
    provider: VideoProvider,
    req: &TaskSubmitReq,
    upstream_model: &str,
    raw_client_body: &[u8],
) -> Result<Vec<u8>, String> {
    fn serialize_payload<T: serde::Serialize>(
        result: Result<T, String>,
    ) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&result?).map_err(|err| err.to_string())
    }
    match provider {
        VideoProvider::Doubao => serialize_payload(doubao::convert_to_request_payload(req)),
        VideoProvider::Hailuo => {
            serialize_payload(hailuo::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Vidu => {
            serialize_payload(vidu::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Kling => {
            serialize_payload(kling::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Jimeng => {
            serialize_payload(jimeng::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Ali => {
            serialize_payload(ali::convert_to_request_payload(req, upstream_model))
        }
        VideoProvider::Sora => Ok(sora::build_json_body(raw_client_body, upstream_model)),
        // Gemini and Vertex share the Veo predictLongRunning body. (Vertex's full
        // submit runs through submit_vertex_task, which needs the async token, so
        // this arm is only reached for Gemini in practice.)
        VideoProvider::Gemini | VideoProvider::Vertex => {
            serialize_payload(gemini::convert_to_request_payload(req))
        }
    }
}

/// The host component of a base URL (scheme stripped, up to the first `/`), for
/// the Jimeng/Volcengine SigV4 `Host` header.
fn url_host(base_url: &str) -> &str {
    base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or(base_url)
}

/// Build a signed Jimeng (Volcengine) request for a `CVSync2Async*` action. A
/// new-api relay key (`sk-`) uses `Bearer` auth and the `/jimeng/` path; a direct
/// `accessKey|secretKey` uses SigV4 signing (host/date/content-sha256/auth
/// headers). Shared by submit (`SubmitTask`) and poll (`GetResult`).
fn build_jimeng_request(
    base_url: &str,
    key: &str,
    query_action: &str,
    body: Vec<u8>,
    now: i64,
) -> Result<PollRequest, String> {
    let is_relay = key.starts_with("sk-");
    let path_prefix = if is_relay { "/jimeng/" } else { "/" };
    let url = format!("{base_url}{path_prefix}?Action={query_action}&Version=2022-08-31");
    let body_string = String::from_utf8(body.clone()).map_err(|err| err.to_string())?;

    let mut headers = vec![
        ("Accept".to_string(), "application/json".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
    ];
    if is_relay {
        headers.push(("Authorization".to_string(), format!("Bearer {key}")));
    } else {
        let parts: Vec<&str> = key.split('|').collect();
        if parts.len() != 2 {
            return Err("invalid jimeng key, required accessKey|secretKey".to_string());
        }
        let (access_key, secret_key) = (parts[0].trim(), parts[1].trim());
        let (x_date, short_date) = jimeng::format_volcengine_dates(now);
        let query = [
            ("Action".to_string(), query_action.to_string()),
            ("Version".to_string(), "2022-08-31".to_string()),
        ];
        let signed = jimeng::sign_request(
            "POST",
            url_host(base_url),
            "/",
            &query,
            Some("application/json"),
            &body,
            access_key,
            secret_key,
            &x_date,
            &short_date,
        );
        headers.push(("Host".to_string(), signed.host));
        headers.push(("X-Date".to_string(), signed.x_date));
        headers.push(("X-Content-Sha256".to_string(), signed.x_content_sha256));
        headers.push(("Authorization".to_string(), signed.authorization));
    }

    Ok(PollRequest {
        method: HttpMethod::Post,
        url,
        headers,
        body: Some(body_string),
    })
}

/// Build the signed submit HTTP request (a `POST` [`PollRequest`]). The
/// simple-auth providers use the action-dependent submit URL + a key-derived
/// auth header (`Bearer` for sora/doubao/ali/hailuo, `Token` for vidu); Kling
/// mints a JWT, Jimeng builds a Volcengine-SigV4-signed request, and Gemini posts
/// to `predictLongRunning` with an `x-goog-api-key` header. Vertex is handled by
/// [`submit_vertex_task`] (async GCP token exchange) and never reaches here.
pub fn build_submit_http_request(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    upstream_model: &str,
    gemini_version: &str,
    body: Vec<u8>,
    now: i64,
) -> Result<PollRequest, String> {
    // Jimeng builds the full signed request (SigV4 adds host/date/sha256 headers).
    if provider == VideoProvider::Jimeng {
        return build_jimeng_request(base_url, key, "CVSync2AsyncSubmitTask", body, now);
    }
    // Gemini posts to predictLongRunning with the `x-goog-api-key` header (not a
    // bearer Authorization), so it builds its request directly.
    if provider == VideoProvider::Gemini {
        let body = String::from_utf8(body).map_err(|err| err.to_string())?;
        return Ok(PollRequest {
            method: HttpMethod::Post,
            url: submit_request::gemini(base_url, gemini_version, upstream_model),
            headers: vec![
                ("x-goog-api-key".to_string(), key.to_string()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(body),
        });
    }
    let (url, auth) = match provider {
        VideoProvider::Sora => (
            submit_request::sora(base_url, action, origin_task_id),
            format!("Bearer {key}"),
        ),
        VideoProvider::Doubao => (submit_request::doubao(base_url), format!("Bearer {key}")),
        VideoProvider::Ali => (submit_request::ali(base_url), format!("Bearer {key}")),
        VideoProvider::Hailuo => (submit_request::hailuo(base_url), format!("Bearer {key}")),
        VideoProvider::Vidu => (
            submit_request::vidu(base_url, action),
            format!("Token {key}"),
        ),
        VideoProvider::Kling => {
            // Kling signs with a JWT minted from the channel key (an `sk-`-prefixed
            // key is a new-api relay key, routed through the `/kling` prefix and
            // passed through verbatim by create_jwt_token).
            let is_new_api_relay = key.starts_with("sk-");
            let token = kling::create_jwt_token(key, now)?;
            (
                submit_request::kling(base_url, action, is_new_api_relay),
                format!("Bearer {token}"),
            )
        }
        VideoProvider::Jimeng | VideoProvider::Gemini | VideoProvider::Vertex => {
            // Jimeng + Gemini are handled above; only Vertex (GCP OAuth) is
            // genuinely unported here.
            return Err(
                "submit request not wired for this provider (Vertex GCP OAuth)".to_string(),
            );
        }
    };
    let body = String::from_utf8(body).map_err(|err| err.to_string())?;
    Ok(PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), auth),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(body),
    })
}

/// The submit HTTP half (symmetric to [`poll_task`]): build the provider body,
/// build the signed submit request, send it, and parse the upstream task id from
/// the response. The pure pieces (body transform, request URL, response parser)
/// are host-tested; this thin I/O wrapper is runtime-verified by a staging
/// submit. Returns the upstream task id.
/// Acquire a Vertex access token: parse the service-account JSON (the channel
/// key), mint the RS256 assertion JWT, and exchange it at Google's OAuth2 token
/// endpoint. Returns `(access_token, project_id)`. No caching yet — each
/// submit/poll exchanges fresh (Vertex is low-volume); a KV-backed cache is a
/// follow-up.
async fn acquire_vertex_token(
    service_account_json: &str,
    now: i64,
    timeout: Option<Duration>,
) -> worker::Result<(String, String)> {
    let sa: vertex::ServiceAccount = serde_json::from_str(service_account_json)
        .map_err(|err| worker::Error::RustError(format!("parse service account: {err}")))?;
    let jwt = vertex::create_signed_jwt(&sa.client_email, &sa.private_key, now)
        .map_err(worker::Error::RustError)?;
    let request = PollRequest {
        method: HttpMethod::Post,
        url: vertex::TOKEN_ENDPOINT.to_string(),
        headers: vec![(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        )],
        body: Some(vertex::token_exchange_body(&jwt)),
    };
    let response = match timeout {
        Some(timeout) => {
            execute_provider_request_with_timeout(
                &request,
                timeout,
                "Vertex OAuth token exchange timed out",
            )
            .await?
            .body
        }
        None => execute_poll_request(&request).await?,
    };
    let token = vertex::parse_token_response(&response).map_err(worker::Error::RustError)?;
    Ok((token, sa.project_id))
}

/// Submit a Vertex task: acquire a token, build the `predictLongRunning` URL +
/// the shared Veo body, POST, and return the encoded operation name.
async fn submit_vertex_task(
    base_url: &str,
    service_account_json: &str,
    region: &str,
    req: &TaskSubmitReq,
    model: &str,
    now: i64,
    deadline: TaskSubmitDeadline,
) -> Result<String, SubmitTaskFailure> {
    let token_timeout = deadline
        .remaining()
        .map_err(SubmitTaskFailure::BeforeProvider)?;
    let (token, project_id) = acquire_vertex_token(service_account_json, now, Some(token_timeout))
        .await
        .map_err(SubmitTaskFailure::BeforeProvider)?;
    let url = vertex::build_predict_url(base_url, "v1", &project_id, region, model);
    let payload = gemini::convert_to_request_payload(req)
        .map_err(worker::Error::RustError)
        .map_err(SubmitTaskFailure::BeforeProvider)?;
    let body = serde_json::to_string(&payload)
        .map_err(worker::Error::from)
        .map_err(SubmitTaskFailure::BeforeProvider)?;
    let request = PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), format!("Bearer {token}")),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(body),
    };
    let response = execute_provider_request_with_timeout(
        &request,
        deadline
            .remaining()
            .map_err(SubmitTaskFailure::BeforeProvider)?,
        "task provider submit timed out",
    )
    .await
    .map_err(SubmitTaskFailure::ProviderResultUnknown)?;
    if submit_http_status_is_ambiguous(response.status) {
        return Err(SubmitTaskFailure::ProviderResultUnknown(
            worker::Error::RustError(format!(
                "provider submit returned ambiguous HTTP status {}",
                response.status
            )),
        ));
    }
    if (400..500).contains(&response.status) {
        return Err(SubmitTaskFailure::ProviderRejected(
            worker::Error::RustError(format!(
                "provider rejected submit with HTTP status {}",
                response.status
            )),
        ));
    }
    vertex::parse_submit_response(&response.body)
        .map_err(worker::Error::RustError)
        .map_err(SubmitTaskFailure::ProviderResultUnknown)
}

/// Poll a Vertex task: decode the operation name, build the
/// `fetchPredictOperation` URL, acquire a token, POST `{operationName}`, parse,
/// and apply the settle.
async fn poll_vertex_task(
    db: &D1Database,
    task: &TaskRow,
    lease: &TaskPollLease,
    base_url: &str,
    service_account_json: &str,
    timeout_seconds: u64,
    now: i64,
    retry_base_seconds: i64,
) -> worker::Result<TaskPollApplyOutcome> {
    let deadline_ms = js_sys::Date::now() + timeout_seconds.max(1) as f64 * 1_000.0;
    let operation_name =
        decode_local_task_id(&task.upstream_task_id).map_err(worker::Error::RustError)?;
    let url =
        vertex::build_fetch_url(base_url, &operation_name).map_err(worker::Error::RustError)?;
    let (token, _project_id) = acquire_vertex_token(
        service_account_json,
        now,
        Some(Duration::from_secs(timeout_seconds.max(1))),
    )
    .await?;
    let remaining_ms = deadline_ms - js_sys::Date::now();
    if remaining_ms <= 0.0 {
        return Err(worker::Error::RustError(
            "task provider poll timed out".to_string(),
        ));
    }
    let remaining_seconds = ((remaining_ms / 1_000.0).floor() as u64).max(1);
    let request = PollRequest {
        method: HttpMethod::Post,
        url,
        headers: vec![
            ("Authorization".to_string(), format!("Bearer {token}")),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(serde_json::json!({ "operationName": operation_name }).to_string()),
    };
    let response = execute_poll_request_with_timeout(&request, remaining_seconds).await?;
    let info = vertex::parse_task_result(&response).map_err(worker::Error::RustError)?;
    let applied_at = task_poll_now_unix_seconds().max(now);
    let finish_time = if info.status.is_terminal() {
        applied_at
    } else {
        0
    };
    let result_data = redact_task_poll_response_body(&response);
    let terminal = info.status.is_terminal();
    let next_poll_at = task_poll_next_at(applied_at, retry_base_seconds);
    let cas_won = apply_poll_result(
        db,
        task,
        lease,
        &info,
        Some(result_data.as_str()),
        finish_time,
        applied_at,
        next_poll_at,
    )
    .await?;
    Ok(TaskPollApplyOutcome {
        lease_claimed: true,
        poll_generation: Some(lease.generation),
        cas_won,
        terminal,
    })
}

pub struct SubmitTaskOutcome {
    pub upstream_task_id: String,
    pub task_data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayTaskSubmitOutcome {
    pub public_task_id: String,
    pub lifecycle_status: String,
    pub submit_state: String,
    pub provider_task_id: Option<String>,
    pub replayed: bool,
    pub http_status: u16,
}

fn replay_task_submit_outcome(intent: TaskBillingIntent) -> RelayTaskSubmitOutcome {
    let http_status = if matches!(intent.status.as_str(), "attached" | "settled") {
        200
    } else if intent.status == "refunded" || intent.submit_state == "rejected" {
        409
    } else {
        202
    };
    RelayTaskSubmitOutcome {
        public_task_id: intent.public_task_id,
        lifecycle_status: intent.status,
        submit_state: intent.submit_state,
        provider_task_id: (!intent.provider_task_id.is_empty()).then_some(intent.provider_task_id),
        replayed: true,
        http_status,
    }
}

fn pending_task_submit_outcome(
    public_task_id: String,
    provider_task_id: Option<String>,
    recovery_persisted: bool,
) -> RelayTaskSubmitOutcome {
    RelayTaskSubmitOutcome {
        public_task_id,
        lifecycle_status: if recovery_persisted {
            "recovery_required".to_string()
        } else {
            "reserved".to_string()
        },
        submit_state: if recovery_persisted {
            "submit_unknown".to_string()
        } else {
            "submitting".to_string()
        },
        provider_task_id,
        replayed: false,
        http_status: 202,
    }
}

fn relay_task_submit_response(
    outcome: RelayTaskSubmitOutcome,
    response_kind: VideoSubmitResponse,
    model: &str,
    created_at: i64,
) -> worker::Result<Response> {
    if outcome.http_status == 200 {
        return match response_kind {
            VideoSubmitResponse::LegacyTaskId => {
                task_submission_json(&serde_json::json!({"task_id": outcome.public_task_id}), 200)
            }
            VideoSubmitResponse::OpenAiVideo => task_submission_json(
                &openai_video_submit_json(&outcome.public_task_id, model, created_at),
                200,
            ),
        };
    }
    let status_url = format!("/api/task/submissions/{}", outcome.public_task_id);
    let mut payload = serde_json::json!({
        "task_id": &outcome.public_task_id,
        "submission_id": &outcome.public_task_id,
        "status": &outcome.submit_state,
        "lifecycle_status": &outcome.lifecycle_status,
        "replayed": outcome.replayed,
        "status_url": status_url,
    });
    if outcome.http_status == 409 {
        payload["error"] = serde_json::Value::String(
            "idempotency key already resolved to a terminal submission".to_string(),
        );
    }
    task_submission_json(&payload, outcome.http_status)
}

fn midjourney_task_submit_response(
    outcome: RelayTaskSubmitOutcome,
    description: &str,
) -> worker::Result<Response> {
    if outcome.http_status == 200 {
        let Some(provider_task_id) = outcome.provider_task_id else {
            return task_submission_json(
                &serde_json::json!({
                    "code": 4,
                    "description": "task is attached but provider identity is unavailable",
                    "submission_id": outcome.public_task_id,
                }),
                502,
            );
        };
        return task_submission_json(
            &serde_json::json!({
                "code": 1,
                "description": "submit success",
                "result": provider_task_id,
            }),
            200,
        );
    }
    let status_url = format!("/api/task/submissions/{}", outcome.public_task_id);
    task_submission_json(
        &serde_json::json!({
            "code": 4,
            "description": description,
            "submission_id": &outcome.public_task_id,
            "status": &outcome.submit_state,
            "lifecycle_status": &outcome.lifecycle_status,
            "replayed": outcome.replayed,
            "status_url": status_url,
        }),
        outcome.http_status,
    )
}

pub enum SubmitTaskFailure {
    BeforeProvider(worker::Error),
    ProviderRejected(worker::Error),
    ProviderResultUnknown(worker::Error),
}

impl SubmitTaskFailure {
    fn into_error(self) -> worker::Error {
        match self {
            Self::BeforeProvider(err)
            | Self::ProviderRejected(err)
            | Self::ProviderResultUnknown(err) => err,
        }
    }
}

async fn submit_task(
    provider: VideoProvider,
    base_url: &str,
    key: &str,
    action: &str,
    origin_task_id: &str,
    req: &TaskSubmitReq,
    upstream_model: &str,
    gemini_version: &str,
    vertex_region: &str,
    raw_client_body: &[u8],
    now: i64,
    deadline: TaskSubmitDeadline,
) -> Result<SubmitTaskOutcome, SubmitTaskFailure> {
    // Vertex needs an async GCP token exchange before building the request, so it
    // bypasses the sync build_submit_* path.
    if provider == VideoProvider::Vertex {
        let upstream_task_id = submit_vertex_task(
            base_url,
            key,
            vertex_region,
            req,
            upstream_model,
            now,
            deadline,
        )
        .await?;
        return Ok(SubmitTaskOutcome {
            upstream_task_id,
            task_data: Vec::new(),
        });
    }
    let body = build_submit_body(provider, req, upstream_model, raw_client_body)
        .map_err(worker::Error::RustError)
        .map_err(SubmitTaskFailure::BeforeProvider)?;
    let request = build_submit_http_request(
        provider,
        base_url,
        key,
        action,
        origin_task_id,
        upstream_model,
        gemini_version,
        body,
        now,
    )
    .map_err(worker::Error::RustError)
    .map_err(SubmitTaskFailure::BeforeProvider)?;
    let response = execute_provider_request_with_timeout(
        &request,
        deadline
            .remaining()
            .map_err(SubmitTaskFailure::BeforeProvider)?,
        "task provider submit timed out",
    )
    .await
    .map_err(SubmitTaskFailure::ProviderResultUnknown)?;
    if submit_http_status_is_ambiguous(response.status) {
        return Err(SubmitTaskFailure::ProviderResultUnknown(
            worker::Error::RustError(format!(
                "provider submit returned ambiguous HTTP status {}",
                response.status
            )),
        ));
    }
    let upstream_task_id = provider
        .parse_submit_response_classified(&response.body)
        .map_err(|failure| match failure {
            SubmitResponseFailure::Rejected(message) => SubmitTaskFailure::ProviderRejected(
                worker::Error::RustError(format!("provider rejected submit: {message}")),
            ),
            SubmitResponseFailure::Unknown(message) => SubmitTaskFailure::ProviderResultUnknown(
                worker::Error::RustError(format!("parse submit response: {message}")),
            ),
        })?;
    Ok(SubmitTaskOutcome {
        upstream_task_id,
        task_data: response.body,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskBillingPlan {
    pub base_quota: i64,
    pub snapshot: FlatPricingSnapshot,
    pub free_model_runtime_policy: FreeModelRuntimeDecision,
}

fn task_wallet_admission_allows(user_quota: i64, billing_plan: &TaskBillingPlan) -> bool {
    billing_plan.free_model_runtime_policy.free_model || user_quota > 0
}

fn task_option_flag(raw: Option<&str>, default: bool) -> bool {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return default;
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "t" | "true" => true,
        "0" | "f" | "false" => false,
        _ => default,
    }
}

fn task_free_model_preconsume_enabled(
    flat_value: Option<&str>,
    legacy_object: Option<&str>,
) -> bool {
    if flat_value.is_some() {
        return task_option_flag(flat_value, true);
    }
    legacy_object
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.trim()).ok())
        .and_then(|value| {
            value
                .get("enable_free_model_pre_consume")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true)
}

/// Go `ModelPriceHelperPerCall` arithmetic over frozen pricing facts. Fixed
/// models use their per-call USD price; ratio models reserve half of one model
/// ratio unit. Both paths apply the request-time effective group ratio.
pub fn task_base_quota_from_snapshot(snapshot: &FlatPricingSnapshot) -> i64 {
    let quota = match snapshot.mode {
        FlatBillingMode::FixedPrice => {
            snapshot.model_price.unwrap_or(0.0) * snapshot.quota_per_unit * snapshot.group_ratio
        }
        FlatBillingMode::PerToken => {
            snapshot.model_ratio / 2.0 * snapshot.quota_per_unit * snapshot.group_ratio
        }
    };
    quota as i64
}

/// Resolve and freeze the per-call billing contract for a task model. `None`
/// means Go would reject the model as unconfigured; callers must return a 4xx
/// and must never silently turn that state into a zero-priced task.
pub async fn compute_task_billing_plan(
    db: &D1Database,
    model: &str,
    user_group: &str,
    using_group: &str,
    accept_unset_ratio_model: bool,
) -> worker::Result<Option<TaskBillingPlan>> {
    let keys = [
        "ModelRatio",
        "CompletionRatio",
        "ModelPrice",
        "CacheRatio",
        "QuotaPerUnit",
        crate::d1_repositories::GROUP_GROUP_RATIO_OPTION_KEY,
        crate::d1_repositories::LEGACY_GROUP_GROUP_RATIO_OPTION_KEY,
        crate::d1_repositories::GROUP_RATIO_OPTION_KEY,
        crate::d1_repositories::LEGACY_GROUP_RATIO_OPTION_KEY,
        "CreateCacheRatio",
        "ImageRatio",
        "AudioRatio",
        "AudioCompletionRatio",
        "SelfUseModeEnabled",
        "quota_setting.enable_free_model_pre_consume",
        "quota_setting",
    ];
    let values = crate::d1_repositories::option_values(db, &keys).await?;
    let mut config = PricingConfig::new()
        .with_json_maps(
            values[0].as_deref(),
            values[1].as_deref(),
            values[2].as_deref(),
            values[3].as_deref(),
            None,
            values[4].as_deref(), // quota per unit
        )
        .with_subcategory_maps(
            values[9].as_deref(),
            values[10].as_deref(),
            values[11].as_deref(),
            values[12].as_deref(),
        )
        .with_self_use_mode(
            accept_unset_ratio_model || task_option_flag(values[13].as_deref(), false),
        );
    if !config.admits_model(model) {
        return Ok(None);
    }

    let groups = [using_group.to_string()];
    let ratios = crate::d1_repositories::resolve_effective_group_ratios_from_options(
        user_group,
        &groups,
        values[5].as_deref(),
        values[6].as_deref(),
        values[7].as_deref(),
        values[8].as_deref(),
    )?;
    config.group_ratios.insert(
        using_group.to_string(),
        ratios.get(using_group).copied().unwrap_or(1.0),
    );
    let snapshot = FlatPricingSnapshot::from_config(model, using_group, &config, 1.0, 0);
    let enable_free_model_pre_consume =
        task_free_model_preconsume_enabled(values[14].as_deref(), values[15].as_deref());
    let free_model_runtime_policy =
        free_model_runtime_decision(&snapshot, enable_free_model_pre_consume);
    Ok(Some(TaskBillingPlan {
        base_quota: task_base_quota_from_snapshot(&snapshot),
        snapshot,
        free_model_runtime_policy,
    }))
}

/// The resolved auth/channel/billing context for a task submit — what the route
/// handler produces (authenticate → select channel → price the base model)
/// before the billing+submit orchestration runs.
pub struct TaskSubmitContext<'a> {
    pub provider: VideoProvider,
    pub channel_id: i64,
    pub channel_base_url: &'a str,
    pub channel_key: &'a str,
    pub user_id: i64,
    pub token_id: i64,
    pub username: &'a str,
    pub group: &'a str,
    pub platform: &'a str,
    pub upstream_model: &'a str,
    pub origin_model: &'a str,
    pub action: &'a str,
    pub origin_task_id: &'a str,
    pub client_idempotency_key: Option<&'a str>,
    pub billing_plan: &'a TaskBillingPlan,
    pub now: i64,
    pub submit_deadline_at: i64,
    /// Configured Gemini API version (e.g. `v1beta`); only used by Gemini.
    pub gemini_version: &'a str,
    /// Configured Vertex region (e.g. `us-central1`); only used by Vertex.
    pub vertex_region: &'a str,
}

/// Orchestrate a task submit — the billing + submit + insert core of Go
/// `RelayTaskSubmit` (the route handler supplies the resolved context). Steps:
/// estimate the pre-charge ratios and apply them to the base quota, reserve it,
/// submit upstream, and on success insert the task row (status `SUBMITTED`). A
/// submit failure refunds the reserve before returning the error. Returns the
/// public task id.
///
/// Today only Sora contributes a billing estimate; other providers use the base
/// quota. The estimate ratios are applied via `apply_other_ratios` whose per-step
/// truncation is order-sensitive — like Go (which iterates a map), so the
/// ordering is unspecified for multi-ratio estimates. Runtime-verified by a
/// staging submit.
pub async fn relay_task_submit(
    db: &D1Database,
    ctx: &TaskSubmitContext<'_>,
    req: &TaskSubmitReq,
    raw_client_body: &[u8],
) -> worker::Result<RelayTaskSubmitOutcome> {
    let submit_deadline = TaskSubmitDeadline::until(ctx.submit_deadline_at);
    let submit_deadline_at = ctx.submit_deadline_at;
    let ratios: Vec<f64> = match ctx.provider {
        VideoProvider::Sora => sora::estimate_billing(
            &req.seconds,
            req.duration,
            &req.size,
            ctx.action == "remixGenerate",
        )
        .map(|estimate| estimate.into_values().collect())
        .unwrap_or_default(),
        _ => Vec::new(),
    };
    let quota = apply_other_ratios(ctx.billing_plan.base_quota, &ratios);
    let free_model = ctx.billing_plan.free_model_runtime_policy.free_model;
    let reserved_quota = if free_model { 0 } else { quota };
    let public_task_id = generate_task_id();
    let client_operation_key_sha256 = task_submit_client_operation_digest(
        ctx.user_id,
        ctx.token_id,
        "task",
        ctx.client_idempotency_key,
        &public_task_id,
    );
    let request_scope = format!(
        "task:{}:{}:{}",
        ctx.platform, ctx.action, ctx.upstream_model
    );
    let client_request_sha256 = task_submit_client_request_digest(&request_scope, raw_client_body);
    let billing_contract = serde_json::json!({
        "contract_version": "task-flat-v1",
        "snapshot": &ctx.billing_plan.snapshot,
        "free_model_runtime_policy": ctx.billing_plan.free_model_runtime_policy,
        "applied_other_ratios": ratios,
        "reserved_quota": reserved_quota,
    });
    let billing_contract_json = billing_contract.to_string();
    let task_properties = serde_json::json!({
        "upstream_model_name": ctx.upstream_model,
        "origin_model_name": ctx.origin_model,
        "task_billing_contract": billing_contract,
    })
    .to_string();
    let attach_contract_json = serde_json::json!({
        "contract_version": "task-attach-v1",
        "task_kind": "task",
        "platform": ctx.platform,
        "username": ctx.username,
        "group": ctx.group,
        "action": ctx.action,
        "properties": task_properties,
        "data": "{}",
    })
    .to_string();
    match reserve_task_billing_intent(
        db,
        TaskBillingIntentRecord {
            reservation_key: &public_task_id,
            task_kind: "task",
            public_task_id: &public_task_id,
            user_id: ctx.user_id,
            token_id: ctx.token_id,
            channel_id: ctx.channel_id,
            quota: reserved_quota,
            funding_source: "wallet",
            subscription_id: 0,
            billing_contract_json: &billing_contract_json,
            attach_contract_json: &attach_contract_json,
            provider_kind: ctx.platform,
            provider_idempotency_key: &public_task_id,
            client_operation_key_sha256: &client_operation_key_sha256,
            client_request_sha256: &client_request_sha256,
            created_at: ctx.now,
            submit_deadline_at,
            lease_expires_at: ctx.now.saturating_add(TASK_BILLING_INTENT_LEASE_SECONDS),
        },
    )
    .await?
    {
        TaskBillingIntentReserveOutcome::Applied => {}
        TaskBillingIntentReserveOutcome::Replay(intent) => {
            return Ok(replay_task_submit_outcome(intent));
        }
    }
    if !mark_task_billing_intent_submitting(db, &public_task_id, ctx.now).await? {
        return Err(worker::Error::RustError(
            "task billing intent could not claim provider submission".to_string(),
        ));
    }

    let submit_outcome = match submit_task(
        ctx.provider,
        ctx.channel_base_url,
        ctx.channel_key,
        ctx.action,
        ctx.origin_task_id,
        req,
        ctx.upstream_model,
        ctx.gemini_version,
        ctx.vertex_region,
        raw_client_body,
        ctx.now,
        submit_deadline,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(SubmitTaskFailure::BeforeProvider(err)) => {
            let _ = reject_and_refund_task_billing_intent(
                db,
                &public_task_id,
                ctx.now,
                &format!("provider request preparation rejected: {err}"),
            )
            .await?;
            return Err(err);
        }
        Err(SubmitTaskFailure::ProviderRejected(err)) => {
            let _ = reject_and_refund_task_billing_intent(
                db,
                &public_task_id,
                ctx.now,
                &format!("provider rejected submit: {err}"),
            )
            .await?;
            return Err(err);
        }
        Err(failure @ SubmitTaskFailure::ProviderResultUnknown(_)) => {
            let err = failure.into_error();
            let recovery_persisted = mark_task_billing_intent_submit_unknown(
                db,
                &public_task_id,
                ctx.now,
                &format!("provider submit result unknown: {err}"),
            )
            .await
            .unwrap_or(false);
            worker::console_warn!("provider task submit is ambiguous: {}", err);
            return Ok(pending_task_submit_outcome(
                public_task_id,
                None,
                recovery_persisted,
            ));
        }
    };

    let task_data = if submit_outcome.task_data.is_empty() {
        "{}".to_string()
    } else {
        String::from_utf8(submit_outcome.task_data).unwrap_or_else(|_| "{}".to_string())
    };
    let new_task = NewTask {
        task_id: &public_task_id,
        upstream_task_id: &submit_outcome.upstream_task_id,
        platform: ctx.platform,
        user_id: ctx.user_id,
        username: ctx.username,
        group: ctx.group,
        channel_id: ctx.channel_id,
        token_id: ctx.token_id,
        billing_reservation_key: &public_task_id,
        quota: reserved_quota,
        action: ctx.action,
        status: TaskStatus::Submitted,
        submit_time: ctx.now,
        created_at: ctx.now,
        updated_at: ctx.now,
        properties: &task_properties,
        data: &task_data,
    };
    match attach_task_billing_intent(db, &new_task).await {
        Ok(TaskBillingIntentAttachOutcome::Applied)
        | Ok(TaskBillingIntentAttachOutcome::MatchingAttached) => {}
        Ok(TaskBillingIntentAttachOutcome::Conflict) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                db,
                &public_task_id,
                ctx.now,
                "provider accepted but local attachment conflicted",
                &submit_outcome.upstream_task_id,
            )
            .await
            .unwrap_or(false);
            return Ok(pending_task_submit_outcome(
                public_task_id,
                Some(submit_outcome.upstream_task_id),
                recovery_persisted,
            ));
        }
        Err(insert_err) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                db,
                &public_task_id,
                ctx.now,
                &format!("provider accepted but local attachment failed: {insert_err}"),
                &submit_outcome.upstream_task_id,
            )
            .await
            .unwrap_or(false);
            worker::console_error!(
                "provider task attachment failed after acceptance: {}",
                insert_err
            );
            return Ok(pending_task_submit_outcome(
                public_task_id,
                Some(submit_outcome.upstream_task_id),
                recovery_persisted,
            ));
        }
    }

    Ok(RelayTaskSubmitOutcome {
        public_task_id,
        lifecycle_status: "attached".to_string(),
        submit_state: "submitted".to_string(),
        provider_task_id: Some(submit_outcome.upstream_task_id),
        replayed: false,
        http_status: 200,
    })
}

/// Video channel types that run task providers (`constant/channel.go`), used to
/// scope channel selection to task-capable channels.
const VIDEO_CHANNEL_TYPES: &[i32] = &[1, 17, 24, 35, 41, 45, 50, 51, 52, 54, 55];

#[derive(Clone, Copy)]
enum VideoSubmitResponse {
    LegacyTaskId,
    OpenAiVideo,
}

fn task_submit_request_from_body(body_bytes: &[u8]) -> Result<TaskSubmitReq, String> {
    serde_json::from_slice(body_bytes).map_err(|err| format!("invalid request: {err}"))
}

fn string_value(value: Option<&serde_json::Value>) -> &str {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

fn query_string_value(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_string())
}

fn metadata_field_is_present(metadata: Option<&serde_json::Value>, field: &str) -> bool {
    let Some(value) = metadata.and_then(|value| value.get(field)) else {
        return false;
    };
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::String(value) => !value.trim().is_empty(),
        _ => true,
    }
}

fn official_task_submit_body_from_model_field(
    body_bytes: &[u8],
    model_field: &str,
    fallback_model_field: Option<&str>,
) -> Result<(TaskSubmitReq, Vec<u8>), String> {
    let original: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(body_bytes).map_err(|err| format!("invalid request: {err}"))?;
    let original_value = serde_json::Value::Object(original.clone());
    let model = string_value(
        original
            .get(model_field)
            .or_else(|| fallback_model_field.and_then(|field| original.get(field))),
    );
    let prompt = string_value(original.get("prompt"));
    let unified = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "metadata": original_value,
    });
    let unified_body = serde_json::to_vec(&unified).map_err(|err| err.to_string())?;
    let task_req: TaskSubmitReq =
        serde_json::from_value(unified).map_err(|err| format!("invalid request: {err}"))?;
    Ok((task_req, unified_body))
}

fn kling_submit_action(task_req: &TaskSubmitReq) -> &'static str {
    if !task_req.image.trim().is_empty()
        || metadata_field_is_present(task_req.metadata.as_ref(), "image")
        || metadata_field_is_present(task_req.metadata.as_ref(), "image_tail")
    {
        TASK_ACTION_GENERATE
    } else {
        TASK_ACTION_TEXT_GENERATE
    }
}

fn jimeng_submit_action(task_req: &TaskSubmitReq) -> &'static str {
    if metadata_field_is_present(task_req.metadata.as_ref(), "image") {
        TASK_ACTION_GENERATE
    } else {
        TASK_ACTION_TEXT_GENERATE
    }
}

fn default_task_submit_action(provider: VideoProvider, task_req: &TaskSubmitReq) -> &'static str {
    match provider {
        VideoProvider::Kling => kling_submit_action(task_req),
        VideoProvider::Jimeng => jimeng_submit_action(task_req),
        _ => TASK_ACTION_GENERATE,
    }
}

fn kling_official_task_submit_body(body_bytes: &[u8]) -> Result<(TaskSubmitReq, Vec<u8>), String> {
    official_task_submit_body_from_model_field(body_bytes, "model_name", Some("model"))
}

fn jimeng_official_task_submit_body(body_bytes: &[u8]) -> Result<(TaskSubmitReq, Vec<u8>), String> {
    official_task_submit_body_from_model_field(body_bytes, "req_key", None)
        .map_err(|_| "Invalid request body".to_string())
}

fn jimeng_official_fetch_task_id(body_bytes: &[u8]) -> Result<String, String> {
    let body: serde_json::Value =
        serde_json::from_slice(body_bytes).map_err(|_| "Invalid request body".to_string())?;
    let task_id = string_value(body.get("task_id")).to_string();
    if task_id.is_empty() {
        Err("task_id is required for CVSync2AsyncGetResult".to_string())
    } else {
        Ok(task_id)
    }
}

/// HTTP entry for a video task submit — the route handler that produces the
/// [`TaskSubmitContext`] and drives [`relay_task_submit`]: authenticate the key,
/// parse the request, select a task channel for the model, price the base model
/// ([`compute_task_billing_plan`]), and submit. Returns `{"task_id": "task_..."}`.
///
/// Simplifications pending runtime tuning against Go: channel model-mapping and
/// several non-Kling provider action special cases are still future slices, and
/// are validated by staging submits before production ownership.
async fn handle_parsed_task_submit_with_response(
    req: &Request,
    env: Env,
    now: i64,
    response_kind: VideoSubmitResponse,
    task_req: TaskSubmitReq,
    body_bytes: Vec<u8>,
    action_override: Option<&str>,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let submit_deadline_at = task_submit_deadline_at(
        now,
        task_submit_timeout_runtime_status(&env).effective_seconds,
    );
    let client_idempotency_key =
        match task_submit_idempotency_key(req, task_client_idempotency_required(&env)) {
            Ok(value) => value,
            Err(message) => {
                return crate::json_with_status(&serde_json::json!({"error": message}), 400)
            }
        };

    let Some(api_key) = crate::relay::extract_api_key(req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let model = task_req.model.clone();
    let client_ip = crate::relay::client_ip(req);
    let auth = match crate::relay::authenticate_for_task(
        &db,
        &env,
        &api_key,
        &model,
        client_ip.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let using_group = if auth.effective_group() == "auto" {
        auth.user_group.clone()
    } else {
        auth.effective_group().to_string()
    };

    let channels = crate::d1_repositories::select_relay_channels(
        &db,
        &model,
        &using_group,
        VIDEO_CHANNEL_TYPES,
    )
    .await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available channel for model"}),
            503,
        );
    };
    let Some(provider) = VideoProvider::from_channel_type(channel.channel_type as i64) else {
        return crate::json_with_status(
            &serde_json::json!({"error": "channel is not a task provider"}),
            503,
        );
    };

    let Some(billing_plan) = compute_task_billing_plan(
        &db,
        &model,
        &auth.user_group,
        &using_group,
        auth.accepts_unset_ratio_model(),
    )
    .await?
    else {
        return crate::json_with_status(
            &serde_json::json!({"error": format!("model {model} has no billing configuration")}),
            400,
        );
    };
    if !task_wallet_admission_allows(auth.user_quota, &billing_plan) {
        return crate::json_with_status(
            &serde_json::json!({"error": "user quota is exhausted"}),
            403,
        );
    }

    let channel_base_url = channel.base_url.as_deref().unwrap_or_default();
    let gemini_version = env
        .var("GEMINI_VERSION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "v1beta".to_string());
    let vertex_region = env
        .var("VERTEX_REGION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "us-central1".to_string());
    let platform = channel.channel_type.to_string();
    let action = action_override.unwrap_or_else(|| default_task_submit_action(provider, &task_req));
    let ctx = TaskSubmitContext {
        provider,
        channel_id: channel.id,
        channel_base_url,
        channel_key: &channel.key,
        user_id: auth.user_id,
        token_id: auth.token_id,
        username: &auth.username,
        group: &using_group,
        platform: &platform,
        upstream_model: &model,
        origin_model: &model,
        action,
        origin_task_id: "",
        client_idempotency_key: client_idempotency_key.as_deref(),
        billing_plan: &billing_plan,
        now,
        submit_deadline_at,
        gemini_version: &gemini_version,
        vertex_region: &vertex_region,
    };

    match relay_task_submit(&db, &ctx, &task_req, &body_bytes).await {
        Ok(outcome) => {
            if !outcome.replayed && outcome.http_status == 200 {
                crate::task_runner::arm_task_runner_after_submit(&env, &outcome.public_task_id)
                    .await;
            }
            relay_task_submit_response(outcome, response_kind, &model, now)
        }
        Err(err) => crate::json_with_status(&serde_json::json!({"error": err.to_string()}), 500),
    }
}

async fn handle_task_submit_with_response(
    mut req: Request,
    env: Env,
    now: i64,
    response_kind: VideoSubmitResponse,
    action_override: Option<&str>,
) -> worker::Result<Response> {
    let body_bytes = req.bytes().await?;
    let task_req = match task_submit_request_from_body(&body_bytes) {
        Ok(parsed) => parsed,
        Err(err) => return crate::json_with_status(&serde_json::json!({"error": err}), 400),
    };
    handle_parsed_task_submit_with_response(
        &req,
        env,
        now,
        response_kind,
        task_req,
        body_bytes,
        action_override,
    )
    .await
}

/// `POST /v1/video/generations`: legacy New API task response shape.
pub async fn handle_task_submit(req: Request, env: Env, now: i64) -> worker::Result<Response> {
    handle_task_submit_with_response(req, env, now, VideoSubmitResponse::LegacyTaskId, None).await
}

/// `POST /v1/videos`: OpenAI-compatible video create response shell.
pub async fn handle_openai_video_submit(
    req: Request,
    env: Env,
    now: i64,
) -> worker::Result<Response> {
    handle_task_submit_with_response(req, env, now, VideoSubmitResponse::OpenAiVideo, None).await
}

/// `POST /kling/v1/videos/{text2video|image2video}`: official Kling-compatible
/// route. Go wraps the official request in the unified task shape
/// (`model`, `prompt`, `metadata`) before normal token auth, distribution,
/// submit, and task persistence.
pub async fn handle_kling_video_submit(
    mut req: Request,
    env: Env,
    action: &str,
    now: i64,
) -> worker::Result<Response> {
    let body_bytes = req.bytes().await?;
    let (task_req, unified_body) = match kling_official_task_submit_body(&body_bytes) {
        Ok(converted) => converted,
        Err(err) => return crate::json_with_status(&serde_json::json!({"error": err}), 400),
    };
    handle_parsed_task_submit_with_response(
        &req,
        env,
        now,
        VideoSubmitResponse::OpenAiVideo,
        task_req,
        unified_body,
        Some(action),
    )
    .await
}

/// `POST /jimeng/?Action=CVSync2Async*`: Jimeng official API route. Source Go
/// rewrites submit requests into the unified task shape and rewrites
/// `CVSync2AsyncGetResult` into a by-id task fetch.
pub async fn handle_jimeng_official(
    mut req: Request,
    env: Env,
    now: i64,
) -> worker::Result<Response> {
    let action = query_string_value(&req, "Action").unwrap_or_default();
    if action.is_empty() {
        return crate::json_with_status(
            &serde_json::json!({"error": "Action query parameter is required"}),
            400,
        );
    }

    let body_bytes = req.bytes().await?;
    if action == "CVSync2AsyncGetResult" {
        let task_id = match jimeng_official_fetch_task_id(&body_bytes) {
            Ok(task_id) => task_id,
            Err(err) => return crate::json_with_status(&serde_json::json!({"error": err}), 400),
        };
        return handle_task_fetch_by_id(req, env, Some(&task_id)).await;
    }

    let (task_req, unified_body) = match jimeng_official_task_submit_body(&body_bytes) {
        Ok(converted) => converted,
        Err(err) => return crate::json_with_status(&serde_json::json!({"error": err}), 400),
    };
    let action = jimeng_submit_action(&task_req);
    handle_parsed_task_submit_with_response(
        &req,
        env,
        now,
        VideoSubmitResponse::OpenAiVideo,
        task_req,
        unified_body,
        Some(action),
    )
    .await
}

/// `POST /v1/videos/:video_id/remix`: OpenAI-compatible Sora remix. Go resolves
/// the public origin task, locks the submit to that task's channel, and uses
/// the origin's stored upstream task id for the provider URL.
pub async fn handle_openai_video_remix(
    mut req: Request,
    env: Env,
    video_id: Option<&String>,
    now: i64,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let submit_deadline_at = task_submit_deadline_at(
        now,
        task_submit_timeout_runtime_status(&env).effective_seconds,
    );
    let client_idempotency_key =
        match task_submit_idempotency_key(&req, task_client_idempotency_required(&env)) {
            Ok(value) => value,
            Err(message) => return task_error_response("invalid_request", &message, 400),
        };

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return task_error_response("unauthorized", "missing api key", 401);
    };
    let client_ip = crate::relay::client_ip(&req);
    let auth =
        match crate::relay::authenticate_for_model_list(&db, &env, &api_key, client_ip.as_deref())
            .await
        {
            Ok(auth) => auth,
            Err(response) => return response,
        };
    let Some(video_id) = video_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return task_error_response("invalid_request", "video_id is required", 400);
    };

    let Some(origin) = crate::task_repository::find_task_dto(&db, auth.user_id, video_id).await?
    else {
        return task_error_response("task_not_exist", "task_origin_not_exist", 400);
    };
    let origin_upstream_task_id = upstream_task_id_from_private_data(&origin)
        .trim()
        .to_string();
    if origin_upstream_task_id.is_empty() {
        return task_error_response(
            "invalid_request",
            "origin task missing upstream task id",
            400,
        );
    }

    let body_bytes = req.bytes().await?;
    let task_req: TaskSubmitReq = match serde_json::from_slice(&body_bytes) {
        Ok(parsed) => parsed,
        Err(err) => {
            return task_error_response("invalid_request", &format!("invalid request: {err}"), 400)
        }
    };
    if task_req.prompt.trim().is_empty() {
        return task_error_response("invalid_request", "field prompt is required", 400);
    }

    let model = remix_origin_model(&origin, &task_req.model);
    if model.trim().is_empty() {
        return task_error_response("invalid_request", "origin task model is missing", 400);
    }
    let auth = match crate::relay::authenticate_for_task(
        &db,
        &env,
        &api_key,
        &model,
        client_ip.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let using_group = if auth.effective_group() == "auto" {
        auth.user_group.clone()
    } else {
        auth.effective_group().to_string()
    };

    let Some(channel) =
        crate::d1_repositories::find_enabled_relay_channel_by_id(&db, origin.channel_id).await?
    else {
        return task_error_response(
            "task_channel_disable",
            "the channel of the origin task is disabled",
            400,
        );
    };
    let Some(provider) = VideoProvider::from_channel_type(channel.channel_type as i64) else {
        return task_error_response(
            "invalid_api_platform",
            "channel is not a task provider",
            400,
        );
    };
    if provider != VideoProvider::Sora {
        return task_error_response(
            "invalid_api_platform",
            "origin task channel does not support OpenAI video remix",
            400,
        );
    }

    let Some(mut billing_plan) = compute_task_billing_plan(
        &db,
        &model,
        &auth.user_group,
        &using_group,
        auth.accepts_unset_ratio_model(),
    )
    .await?
    else {
        return task_error_response(
            "model_price_error",
            &format!("model {model} has no billing configuration"),
            400,
        );
    };
    billing_plan.base_quota = apply_other_ratios(
        billing_plan.base_quota,
        &remix_billing_ratios_from_origin(&origin),
    );
    if !task_wallet_admission_allows(auth.user_quota, &billing_plan) {
        return task_error_response("insufficient_user_quota", "user quota is exhausted", 403);
    }

    let channel_base_url = channel.base_url.as_deref().unwrap_or_default();
    let gemini_version = env
        .var("GEMINI_VERSION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "v1beta".to_string());
    let vertex_region = env
        .var("VERTEX_REGION")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "us-central1".to_string());
    let platform = channel.channel_type.to_string();
    let ctx = TaskSubmitContext {
        provider,
        channel_id: channel.id,
        channel_base_url,
        channel_key: &channel.key,
        user_id: auth.user_id,
        token_id: auth.token_id,
        username: &auth.username,
        group: &using_group,
        platform: &platform,
        upstream_model: &model,
        origin_model: &model,
        action: TASK_ACTION_REMIX,
        origin_task_id: &origin_upstream_task_id,
        client_idempotency_key: client_idempotency_key.as_deref(),
        billing_plan: &billing_plan,
        now,
        submit_deadline_at,
        gemini_version: &gemini_version,
        vertex_region: &vertex_region,
    };

    match relay_task_submit(&db, &ctx, &task_req, &body_bytes).await {
        Ok(outcome) => {
            if !outcome.replayed && outcome.http_status == 200 {
                crate::task_runner::arm_task_runner_after_submit(&env, &outcome.public_task_id)
                    .await;
            }
            relay_task_submit_response(outcome, VideoSubmitResponse::OpenAiVideo, &model, now)
        }
        Err(err) => task_error_response("submit_task_failed", &err.to_string(), 500),
    }
}

/// HTTP entry for a Suno task submit (`POST /suno/submit/:action`). Suno is a
/// platform (not a channel-type video provider): it selects a SunoAPI channel
/// (type 36), reserves the base quota, forwards the client body verbatim to
/// `{base}/suno/submit/{action}` with bearer auth, parses the upstream task id,
/// and inserts the task with platform `suno`. The billing model is the request's
/// model, or `suno_<action>` when absent. A submit failure refunds the reserve.
/// Runtime-verified by a staging submit.
pub async fn handle_suno_submit(
    mut req: Request,
    env: Env,
    action: &str,
    now: i64,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let submit_timeout_seconds = task_submit_timeout_runtime_status(&env).effective_seconds;
    let submit_deadline_at = task_submit_deadline_at(now, submit_timeout_seconds);
    let submit_deadline = TaskSubmitDeadline::until(submit_deadline_at);
    let client_idempotency_key =
        match task_submit_idempotency_key(&req, task_client_idempotency_required(&env)) {
            Ok(value) => value,
            Err(message) => {
                return crate::json_with_status(&serde_json::json!({"error": message}), 400)
            }
        };
    // Go uppercases the action (ValidateRequestAndSetAction); the upstream URL
    // and stored action use it, while the billing model lowercases it back.
    let action = action.to_uppercase();

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let body_bytes = req.bytes().await?;
    let task_req: TaskSubmitReq = serde_json::from_slice(&body_bytes).unwrap_or_default();
    let model = if task_req.model.is_empty() {
        cover_task_action_to_model_name("suno", &action)
    } else {
        task_req.model.clone()
    };
    let client_ip = crate::relay::client_ip(&req);
    let auth = match crate::relay::authenticate_for_task(
        &db,
        &env,
        &api_key,
        &model,
        client_ip.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let using_group = if auth.effective_group() == "auto" {
        auth.user_group.clone()
    } else {
        auth.effective_group().to_string()
    };

    // Suno channels are channel type 36 (SunoAPI).
    let channels =
        crate::d1_repositories::select_relay_channels(&db, &model, &using_group, &[36]).await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available suno channel for model"}),
            503,
        );
    };

    let Some(billing_plan) = compute_task_billing_plan(
        &db,
        &model,
        &auth.user_group,
        &using_group,
        auth.accepts_unset_ratio_model(),
    )
    .await?
    else {
        return crate::json_with_status(
            &serde_json::json!({"error": format!("model {model} has no billing configuration")}),
            400,
        );
    };
    if !task_wallet_admission_allows(auth.user_quota, &billing_plan) {
        return crate::json_with_status(
            &serde_json::json!({"error": "user quota is exhausted"}),
            403,
        );
    }
    let base_quota = billing_plan.base_quota;
    let free_model = billing_plan.free_model_runtime_policy.free_model;
    let reserved_quota = if free_model { 0 } else { base_quota };
    let public_task_id = generate_task_id();
    let client_operation_key_sha256 = task_submit_client_operation_digest(
        auth.user_id,
        auth.token_id,
        "task",
        client_idempotency_key.as_deref(),
        &public_task_id,
    );
    let client_request_sha256 =
        task_submit_client_request_digest(&format!("task:suno:{action}:{model}"), &body_bytes);
    let billing_contract = serde_json::json!({
        "contract_version": "task-flat-v1",
        "snapshot": &billing_plan.snapshot,
        "free_model_runtime_policy": billing_plan.free_model_runtime_policy,
        "reserved_quota": reserved_quota,
    });
    let billing_contract_json = billing_contract.to_string();
    let task_properties = serde_json::json!({
        "upstream_model_name": model,
        "origin_model_name": model,
        "task_billing_contract": billing_contract,
    })
    .to_string();
    let attach_contract_json = serde_json::json!({
        "contract_version": "task-attach-v1",
        "task_kind": "task",
        "platform": "suno",
        "username": auth.username,
        "group": using_group,
        "action": action,
        "properties": task_properties,
        "data": "{}",
    })
    .to_string();
    match reserve_task_billing_intent(
        &db,
        TaskBillingIntentRecord {
            reservation_key: &public_task_id,
            task_kind: "task",
            public_task_id: &public_task_id,
            user_id: auth.user_id,
            token_id: auth.token_id,
            channel_id: channel.id,
            quota: reserved_quota,
            funding_source: "wallet",
            subscription_id: 0,
            billing_contract_json: &billing_contract_json,
            attach_contract_json: &attach_contract_json,
            provider_kind: "suno",
            provider_idempotency_key: &public_task_id,
            client_operation_key_sha256: &client_operation_key_sha256,
            client_request_sha256: &client_request_sha256,
            created_at: now,
            submit_deadline_at,
            lease_expires_at: now.saturating_add(TASK_BILLING_INTENT_LEASE_SECONDS),
        },
    )
    .await?
    {
        TaskBillingIntentReserveOutcome::Applied => {}
        TaskBillingIntentReserveOutcome::Replay(intent) => {
            let outcome = replay_task_submit_outcome(intent);
            return relay_task_submit_response(
                outcome,
                VideoSubmitResponse::LegacyTaskId,
                &model,
                now,
            );
        }
    }
    if !mark_task_billing_intent_submitting(&db, &public_task_id, now).await? {
        return crate::json_with_status(
            &serde_json::json!({"error": "task billing intent could not claim provider submission"}),
            503,
        );
    }

    let base_url = channel.base_url.as_deref().unwrap_or_default();
    let request = PollRequest {
        method: HttpMethod::Post,
        url: format!("{base_url}/suno/submit/{action}"),
        headers: vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", channel.key),
            ),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(String::from_utf8(body_bytes).unwrap_or_default()),
    };

    let remaining = match submit_deadline.remaining() {
        Ok(remaining) => remaining,
        Err(err) => {
            let _ = reject_and_refund_task_billing_intent(
                &db,
                &public_task_id,
                now,
                "Suno submit deadline expired before provider I/O",
            )
            .await?;
            return crate::json_with_status(&serde_json::json!({"error": err.to_string()}), 504);
        }
    };
    let upstream_task_id = match execute_provider_request_with_timeout(
        &request,
        remaining,
        "task provider submit timed out",
    )
    .await
    {
        Ok(response) if submit_http_status_is_ambiguous(response.status) => {
            let err = format!(
                "Suno submit returned ambiguous HTTP status {}",
                response.status
            );
            let recovery_persisted =
                mark_task_billing_intent_submit_unknown(&db, &public_task_id, now, &err)
                    .await
                    .unwrap_or(false);
            worker::console_warn!("Suno task submit is ambiguous: {}", err);
            return relay_task_submit_response(
                pending_task_submit_outcome(public_task_id, None, recovery_persisted),
                VideoSubmitResponse::LegacyTaskId,
                &model,
                now,
            );
        }
        Ok(response) => match suno::parse_submit_response_classified(&response.body) {
            Ok(id) => id,
            Err(SubmitResponseFailure::Rejected(err)) => {
                let _ = reject_and_refund_task_billing_intent(
                    &db,
                    &public_task_id,
                    now,
                    &format!("Suno provider rejected submit: {err}"),
                )
                .await?;
                return crate::json_with_status(&serde_json::json!({"error": err}), 400);
            }
            Err(SubmitResponseFailure::Unknown(err)) => {
                let recovery_persisted = mark_task_billing_intent_submit_unknown(
                    &db,
                    &public_task_id,
                    now,
                    &format!("Suno submit response could not be classified: {err}"),
                )
                .await
                .unwrap_or(false);
                worker::console_warn!("Suno task submit response is ambiguous: {}", err);
                return relay_task_submit_response(
                    pending_task_submit_outcome(public_task_id, None, recovery_persisted),
                    VideoSubmitResponse::LegacyTaskId,
                    &model,
                    now,
                );
            }
        },
        Err(err) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown(
                &db,
                &public_task_id,
                now,
                &format!("Suno submit result unknown: {err}"),
            )
            .await
            .unwrap_or(false);
            worker::console_warn!("Suno task submit transport is ambiguous: {}", err);
            return relay_task_submit_response(
                pending_task_submit_outcome(public_task_id, None, recovery_persisted),
                VideoSubmitResponse::LegacyTaskId,
                &model,
                now,
            );
        }
    };

    let new_task = NewTask {
        task_id: &public_task_id,
        upstream_task_id: &upstream_task_id,
        platform: "suno",
        user_id: auth.user_id,
        username: &auth.username,
        group: &using_group,
        channel_id: channel.id,
        token_id: auth.token_id,
        billing_reservation_key: &public_task_id,
        quota: reserved_quota,
        action: &action,
        status: TaskStatus::Submitted,
        submit_time: now,
        created_at: now,
        updated_at: now,
        properties: &task_properties,
        data: "{}",
    };
    match attach_task_billing_intent(&db, &new_task).await {
        Ok(TaskBillingIntentAttachOutcome::Applied)
        | Ok(TaskBillingIntentAttachOutcome::MatchingAttached) => {}
        Ok(TaskBillingIntentAttachOutcome::Conflict) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                &db,
                &public_task_id,
                now,
                "Suno provider accepted but local attachment conflicted",
                &upstream_task_id,
            )
            .await
            .unwrap_or(false);
            return relay_task_submit_response(
                pending_task_submit_outcome(
                    public_task_id,
                    Some(upstream_task_id),
                    recovery_persisted,
                ),
                VideoSubmitResponse::LegacyTaskId,
                &model,
                now,
            );
        }
        Err(insert_err) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                &db,
                &public_task_id,
                now,
                &format!("Suno provider accepted but local attachment failed: {insert_err}"),
                &upstream_task_id,
            )
            .await
            .unwrap_or(false);
            worker::console_error!(
                "Suno attachment failed after provider acceptance: {}",
                insert_err
            );
            return relay_task_submit_response(
                pending_task_submit_outcome(
                    public_task_id,
                    Some(upstream_task_id),
                    recovery_persisted,
                ),
                VideoSubmitResponse::LegacyTaskId,
                &model,
                now,
            );
        }
    }
    crate::json_with_status(&serde_json::json!({"task_id": public_task_id}), 200)
}

/// HTTP entry for a Midjourney submit (`POST /mj/submit/:action`). mj is its own
/// subsystem: it selects a Midjourney channel (type 2 or 5), reserves the base
/// quota, forwards the client body to `{base}/mj/submit/{action}` with the
/// `mj-api-secret` header, parses the `MidjourneyResponse` (`code == 1` ⇒ the
/// `result` mj id), and inserts a row into `midjourneys`. The billing model is
/// `mj_<action>`. A submit failure refunds the reserve. Runtime-verified by a
/// staging submit.
pub async fn handle_mj_submit(
    mut req: Request,
    env: Env,
    action: &str,
    now: i64,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let submit_timeout_seconds = task_submit_timeout_runtime_status(&env).effective_seconds;
    let submit_deadline_at = task_submit_deadline_at(now, submit_timeout_seconds);
    let submit_deadline = TaskSubmitDeadline::until(submit_deadline_at);
    let client_idempotency_key =
        match task_submit_idempotency_key(&req, task_client_idempotency_required(&env)) {
            Ok(value) => value,
            Err(message) => {
                return crate::json_with_status(&serde_json::json!({"error": message}), 400)
            }
        };

    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return crate::json_with_status(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let body_bytes = req.bytes().await?;
    let body_value: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or_default();
    let prompt = body_value
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let model = cover_task_action_to_model_name("mj", action);
    let client_ip = crate::relay::client_ip(&req);
    let auth = match crate::relay::authenticate_for_task(
        &db,
        &env,
        &api_key,
        &model,
        client_ip.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let using_group = if auth.effective_group() == "auto" {
        auth.user_group.clone()
    } else {
        auth.effective_group().to_string()
    };

    // Midjourney channels are type 2 (Midjourney) or 5 (MidjourneyPlus).
    let channels =
        crate::d1_repositories::select_relay_channels(&db, &model, &using_group, &[2, 5]).await?;
    let Some(channel) = channels.into_iter().next() else {
        return crate::json_with_status(
            &serde_json::json!({"error": "no available midjourney channel for model"}),
            503,
        );
    };

    let Some(billing_plan) = compute_task_billing_plan(
        &db,
        &model,
        &auth.user_group,
        &using_group,
        auth.accepts_unset_ratio_model(),
    )
    .await?
    else {
        return crate::json_with_status(
            &serde_json::json!({
                "code": 4,
                "description": format!("model {model} has no billing configuration")
            }),
            400,
        );
    };
    if !task_wallet_admission_allows(auth.user_quota, &billing_plan) {
        return crate::json_with_status(
            &serde_json::json!({"code": 4, "description": "user quota is exhausted"}),
            403,
        );
    }
    let base_quota = billing_plan.base_quota;
    let free_model = billing_plan.free_model_runtime_policy.free_model;
    let reserved_quota = if free_model { 0 } else { base_quota };
    let billing_reservation_key = generate_task_id();
    let client_operation_key_sha256 = task_submit_client_operation_digest(
        auth.user_id,
        auth.token_id,
        "midjourney",
        client_idempotency_key.as_deref(),
        &billing_reservation_key,
    );
    let client_request_sha256 = task_submit_client_request_digest(
        &format!("task:midjourney:{action}:{model}"),
        &body_bytes,
    );
    let billing_contract = serde_json::json!({
        "contract_version": "task-flat-v1",
        "snapshot": &billing_plan.snapshot,
        "free_model_runtime_policy": billing_plan.free_model_runtime_policy,
        "reserved_quota": reserved_quota,
    });
    let billing_contract_json = billing_contract.to_string();
    let mj_properties = serde_json::json!({
        "token_id": auth.token_id,
        "billing_reservation_key": billing_reservation_key,
        "group": using_group,
        "origin_model_name": model,
        "task_billing_contract": billing_contract,
    })
    .to_string();
    let attach_contract_json = serde_json::json!({
        "contract_version": "task-attach-v1",
        "task_kind": "midjourney",
        "action": action,
        "prompt": prompt,
        "prompt_en": prompt,
        "properties": mj_properties,
    })
    .to_string();
    match reserve_task_billing_intent(
        &db,
        TaskBillingIntentRecord {
            reservation_key: &billing_reservation_key,
            task_kind: "midjourney",
            public_task_id: &billing_reservation_key,
            user_id: auth.user_id,
            token_id: auth.token_id,
            channel_id: channel.id,
            quota: reserved_quota,
            funding_source: "wallet",
            subscription_id: 0,
            billing_contract_json: &billing_contract_json,
            attach_contract_json: &attach_contract_json,
            provider_kind: "midjourney",
            provider_idempotency_key: &billing_reservation_key,
            client_operation_key_sha256: &client_operation_key_sha256,
            client_request_sha256: &client_request_sha256,
            created_at: now,
            submit_deadline_at,
            lease_expires_at: now.saturating_add(TASK_BILLING_INTENT_LEASE_SECONDS),
        },
    )
    .await?
    {
        TaskBillingIntentReserveOutcome::Applied => {}
        TaskBillingIntentReserveOutcome::Replay(intent) => {
            return midjourney_task_submit_response(
                replay_task_submit_outcome(intent),
                "idempotent task submission replay",
            );
        }
    }
    if !mark_task_billing_intent_submitting(&db, &billing_reservation_key, now).await? {
        return crate::json_with_status(
            &serde_json::json!({"code": 4, "description": "task billing intent could not claim provider submission"}),
            503,
        );
    }

    let base_url = channel.base_url.as_deref().unwrap_or_default();
    let request = PollRequest {
        method: HttpMethod::Post,
        url: format!("{base_url}/mj/submit/{action}"),
        headers: vec![
            ("mj-api-secret".to_string(), channel.key.clone()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ],
        body: Some(String::from_utf8(body_bytes.clone()).unwrap_or_default()),
    };

    let remaining = match submit_deadline.remaining() {
        Ok(remaining) => remaining,
        Err(err) => {
            let _ = reject_and_refund_task_billing_intent(
                &db,
                &billing_reservation_key,
                now,
                "Midjourney submit deadline expired before provider I/O",
            )
            .await?;
            return crate::json_with_status(
                &serde_json::json!({"code": 4, "description": err.to_string()}),
                504,
            );
        }
    };
    let mj_id = match execute_provider_request_with_timeout(
        &request,
        remaining,
        "task provider submit timed out",
    )
    .await
    {
        Ok(response) if submit_http_status_is_ambiguous(response.status) => {
            let err = format!(
                "Midjourney submit returned ambiguous HTTP status {}",
                response.status
            );
            let recovery_persisted =
                mark_task_billing_intent_submit_unknown(&db, &billing_reservation_key, now, &err)
                    .await
                    .unwrap_or(false);
            worker::console_warn!("Midjourney task submit is ambiguous: {}", err);
            return midjourney_task_submit_response(
                pending_task_submit_outcome(billing_reservation_key, None, recovery_persisted),
                "provider submit result is being reconciled",
            );
        }
        Ok(response) => match midjourney::parse_submit_response_classified(&response.body) {
            Ok(id) => id,
            Err(SubmitResponseFailure::Rejected(err)) => {
                let _ = reject_and_refund_task_billing_intent(
                    &db,
                    &billing_reservation_key,
                    now,
                    &format!("Midjourney provider rejected submit: {err}"),
                )
                .await?;
                return crate::json_with_status(
                    &serde_json::json!({"code": 4, "description": err}),
                    400,
                );
            }
            Err(SubmitResponseFailure::Unknown(err)) => {
                let recovery_persisted = mark_task_billing_intent_submit_unknown(
                    &db,
                    &billing_reservation_key,
                    now,
                    &format!("Midjourney submit response could not be classified: {err}"),
                )
                .await
                .unwrap_or(false);
                worker::console_warn!("Midjourney submit response is ambiguous: {}", err);
                return midjourney_task_submit_response(
                    pending_task_submit_outcome(billing_reservation_key, None, recovery_persisted),
                    "provider submit response is being reconciled",
                );
            }
        },
        Err(err) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown(
                &db,
                &billing_reservation_key,
                now,
                &format!("Midjourney submit result unknown: {err}"),
            )
            .await
            .unwrap_or(false);
            worker::console_warn!("Midjourney submit transport is ambiguous: {}", err);
            return midjourney_task_submit_response(
                pending_task_submit_outcome(billing_reservation_key, None, recovery_persisted),
                "provider submit transport result is being reconciled",
            );
        }
    };

    let new_mj = crate::mj_repository::NewMidjourney {
        code: 1,
        user_id: auth.user_id,
        action,
        mj_id: &mj_id,
        prompt,
        prompt_en: prompt,
        channel_id: channel.id,
        quota: reserved_quota,
        status: "SUBMITTED",
        progress: "0%",
        // Go Midjourney rows store millisecond timestamps; usage-log filters
        // and duration rendering expect that unit. The shared task pipeline
        // keeps second timestamps, so only the mj subsystem multiplies here.
        submit_time: now.saturating_mul(1000),
        properties: &mj_properties,
        billing_reservation_key: &billing_reservation_key,
    };
    match crate::mj_repository::attach_midjourney_billing_intent(&db, &new_mj).await {
        Ok(TaskBillingIntentAttachOutcome::Applied)
        | Ok(TaskBillingIntentAttachOutcome::MatchingAttached) => {}
        Ok(TaskBillingIntentAttachOutcome::Conflict) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                &db,
                &billing_reservation_key,
                now,
                "Midjourney provider accepted but local attachment conflicted",
                &mj_id,
            )
            .await
            .unwrap_or(false);
            return midjourney_task_submit_response(
                pending_task_submit_outcome(
                    billing_reservation_key,
                    Some(mj_id),
                    recovery_persisted,
                ),
                "provider accepted task; durable attachment is being reconciled",
            );
        }
        Err(insert_err) => {
            let recovery_persisted = mark_task_billing_intent_submit_unknown_with_provider_task_id(
                &db,
                &billing_reservation_key,
                now,
                &format!("Midjourney provider accepted but local attachment failed: {insert_err}"),
                &mj_id,
            )
            .await
            .unwrap_or(false);
            worker::console_error!(
                "Midjourney attachment failed after provider acceptance: {}",
                insert_err
            );
            return midjourney_task_submit_response(
                pending_task_submit_outcome(
                    billing_reservation_key,
                    Some(mj_id),
                    recovery_persisted,
                ),
                "provider accepted task; durable attachment is being reconciled",
            );
        }
    }

    midjourney_task_submit_response(
        RelayTaskSubmitOutcome {
            public_task_id: billing_reservation_key,
            lifecycle_status: "attached".to_string(),
            submit_state: "submitted".to_string(),
            provider_task_id: Some(mj_id),
            replayed: false,
            http_status: 200,
        },
        "submit success",
    )
}

struct ProviderHttpResponse {
    status: u16,
    body: Vec<u8>,
}

fn submit_http_status_is_ambiguous(status: u16) -> bool {
    matches!(status, 408 | 409 | 425 | 429)
        || !(200..500).contains(&status)
        || (300..400).contains(&status)
}

async fn execute_provider_request(request: &PollRequest) -> worker::Result<ProviderHttpResponse> {
    let mut headers = Headers::new();
    for (name, value) in &request.headers {
        headers.set(name, value)?;
    }

    let mut init = RequestInit::new();
    init.with_method(match request.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    })
    .with_headers(headers);
    if let Some(body) = &request.body {
        init.with_body(Some(JsValue::from_str(body)));
    }

    let outbound = Request::new_with_init(&request.url, &init)?;
    let mut response = Fetch::Request(outbound).send().await?;
    let status = response.status_code();
    let body =
        crate::relay::read_response_bytes_limited(&mut response, TASK_PROVIDER_RESPONSE_MAX_BYTES)
            .await
            .map_err(|err| worker::Error::RustError(err.message("task provider response body")))?;
    Ok(ProviderHttpResponse { status, body })
}

async fn execute_provider_request_with_timeout(
    request: &PollRequest,
    timeout: Duration,
    timeout_message: &'static str,
) -> worker::Result<ProviderHttpResponse> {
    if timeout.is_zero() {
        return Err(worker::Error::RustError(timeout_message.to_string()));
    }
    let mut headers = Headers::new();
    for (name, value) in &request.headers {
        headers.set(name, value)?;
    }
    let mut init = RequestInit::new();
    init.with_method(match request.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    })
    .with_headers(headers)
    .with_redirect(RequestRedirect::Error);
    if let Some(body) = request.body.as_ref() {
        init.with_body(Some(JsValue::from_str(body)));
    }
    let outbound = Request::new_with_init(&request.url, &init)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = async move {
        let mut response = Fetch::Request(outbound).send_with_signal(&signal).await?;
        let status = response.status_code();
        let body = crate::relay::read_response_bytes_limited(
            &mut response,
            TASK_PROVIDER_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(|err| worker::Error::RustError(err.message("task provider response body")))?;
        Ok(ProviderHttpResponse { status, body })
    };
    let delay = Delay::from(timeout);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    match select(fetch, delay).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => {
            controller.abort();
            Err(worker::Error::RustError(timeout_message.to_string()))
        }
    }
}

/// Execute a provider poll request and return the response body bytes. The
/// caller feeds these to the matching provider parser
/// ([`VideoProvider::parse_task_result`]).
pub async fn execute_poll_request(request: &PollRequest) -> worker::Result<Vec<u8>> {
    Ok(execute_provider_request(request).await?.body)
}

async fn execute_poll_request_with_timeout(
    request: &PollRequest,
    timeout_seconds: u64,
) -> worker::Result<Vec<u8>> {
    Ok(execute_provider_request_with_timeout(
        request,
        Duration::from_secs(timeout_seconds.max(1)),
        "task provider poll timed out",
    )
    .await?
    .body)
}

/// Execute a poll request and parse it with the given provider's parser — the
/// fetch-then-parse half of one poll cycle. The settle-apply half is
/// [`crate::task_repository::apply_poll_result`], which the caller invokes with
/// the returned [`TaskInfo`].
pub async fn poll_task(
    provider: VideoProvider,
    request: &PollRequest,
    timeout_seconds: u64,
) -> worker::Result<(TaskInfo, Vec<u8>)> {
    let body = execute_poll_request_with_timeout(request, timeout_seconds).await?;
    let info = provider
        .parse_task_result(&body)
        .map_err(|message| worker::Error::RustError(format!("parse task result: {message}")))?;
    Ok((info, body))
}

/// Run one full poll cycle for a task against its channel: resolve the provider
/// from the channel type, build the (simple-auth) poll request, fetch + parse,
/// and apply the result through the CAS settle-apply.
///
/// Returns `Ok(None)` when the channel type runs no task provider;
/// `Ok(Some(outcome))` otherwise. The outcome separates the D1 CAS result from
/// the provider's terminal state so callers do not mistake a non-terminal
/// progress update for completed task settlement.
///
/// The fetch id is the task's `upstream_task_id` (for Gemini that is the
/// base64-encoded operation name the request builder decodes). The exact id
/// field per provider is confirmed by a staging poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskPollApplyOutcome {
    pub lease_claimed: bool,
    pub poll_generation: Option<i64>,
    pub cas_won: bool,
    pub terminal: bool,
}

struct TaskPollAttemptError {
    source: worker::Error,
    error_code: &'static str,
    immediate_quarantine: bool,
}

impl TaskPollAttemptError {
    fn poison(source: worker::Error, error_code: &'static str) -> Self {
        Self {
            source,
            error_code,
            immediate_quarantine: true,
        }
    }
}

impl From<worker::Error> for TaskPollAttemptError {
    fn from(source: worker::Error) -> Self {
        Self {
            source,
            error_code: "provider_poll_failed",
            immediate_quarantine: false,
        }
    }
}

fn task_poll_failure_limit(configured_limit: i64, immediate_quarantine: bool) -> i64 {
    if immediate_quarantine {
        1
    } else {
        configured_limit
    }
}

pub async fn poll_one_task(
    db: &D1Database,
    task: &TaskRow,
    channel_type: i32,
    channel_key: &str,
    channel_base_url: &str,
    gemini_version: &str,
    poll_owner: &str,
    poll_lease_seconds: i64,
    retry_base_seconds: i64,
    retry_max_seconds: i64,
    max_consecutive_failures: i64,
    now: i64,
) -> worker::Result<Option<TaskPollApplyOutcome>> {
    let Some(provider) = VideoProvider::from_channel_type(channel_type as i64) else {
        return Ok(None);
    };
    let claim_now = task_poll_now_unix_seconds().max(now);
    let Some(lease) =
        claim_task_poll_lease(db, task, poll_owner, claim_now, poll_lease_seconds).await?
    else {
        return Ok(Some(TaskPollApplyOutcome {
            lease_claimed: false,
            poll_generation: None,
            cas_won: false,
            terminal: false,
        }));
    };
    let Some(provider_timeout_seconds) = task_poll_provider_timeout_until(
        lease.expires_at,
        task_poll_now_unix_seconds().max(claim_now),
    ) else {
        let failure_now = task_poll_now_unix_seconds().max(claim_now);
        let _ = record_task_poll_failure(
            db,
            task,
            &lease,
            failure_now,
            retry_base_seconds,
            retry_max_seconds,
            max_consecutive_failures,
            "lease_budget_exhausted",
        )
        .await;
        return Err(worker::Error::RustError(
            "task poll lease has no provider budget".to_string(),
        ));
    };
    let id = task.upstream_task_id.as_str();

    let poll_result: Result<Option<TaskPollApplyOutcome>, TaskPollAttemptError> = async {
        let request = match provider {
            VideoProvider::Sora => poll_request::sora(channel_base_url, channel_key, id),
            VideoProvider::Vidu => poll_request::vidu(channel_base_url, channel_key, id),
            VideoProvider::Ali => poll_request::ali(channel_base_url, channel_key, id),
            VideoProvider::Doubao => poll_request::doubao(channel_base_url, channel_key, id),
            VideoProvider::Hailuo => poll_request::hailuo(channel_base_url, channel_key, id),
            VideoProvider::Gemini => {
                poll_request::gemini(channel_base_url, channel_key, id, gemini_version).map_err(
                    |message| {
                        TaskPollAttemptError::poison(
                            worker::Error::RustError(format!(
                                "build Gemini poll request: {message}"
                            )),
                            "provider_task_identity_invalid",
                        )
                    },
                )?
            }
            VideoProvider::Kling => {
                let is_new_api_relay = channel_key.starts_with("sk-");
                let token = kling::create_jwt_token(channel_key, claim_now).map_err(|message| {
                    TaskPollAttemptError::poison(
                        worker::Error::RustError(format!("build Kling poll credential: {message}")),
                        "provider_credential_invalid",
                    )
                })?;
                poll_request::kling(channel_base_url, &token, &task.action, id, is_new_api_relay)
            }
            VideoProvider::Jimeng => {
                // Jimeng polls with a POST carrying a fixed req_key + the task id,
                // SigV4-signed (or Bearer for a relay key).
                let body = serde_json::to_vec(&serde_json::json!({
                    "req_key": "jimeng_vgfm_t2v_l20",
                    "task_id": id,
                }))
                .map_err(|err| worker::Error::RustError(err.to_string()))?;
                build_jimeng_request(
                    channel_base_url,
                    channel_key,
                    "CVSync2AsyncGetResult",
                    body,
                    claim_now,
                )
                .map_err(|message| {
                    TaskPollAttemptError::poison(
                        worker::Error::RustError(format!(
                            "build Jimeng poll credential: {message}"
                        )),
                        "provider_credential_invalid",
                    )
                })?
            }
            VideoProvider::Vertex => {
                // Vertex needs an async GCP token exchange + the operation-name-based
                // fetch URL, so it runs its own poll cycle.
                return poll_vertex_task(
                    db,
                    task,
                    &lease,
                    channel_base_url,
                    channel_key,
                    provider_timeout_seconds,
                    claim_now,
                    retry_base_seconds,
                )
                .await
                .map(Some)
                .map_err(TaskPollAttemptError::from);
            }
        };

        let (info, body) = poll_task(provider, &request, provider_timeout_seconds).await?;
        let applied_at = task_poll_now_unix_seconds().max(claim_now);
        let finish_time = if info.status.is_terminal() {
            applied_at
        } else {
            0
        };
        let result_data = redact_task_poll_response_body(&body);
        let terminal = info.status.is_terminal();
        let next_poll_at = task_poll_next_at(applied_at, retry_base_seconds);
        let cas_won = apply_poll_result(
            db,
            task,
            &lease,
            &info,
            Some(result_data.as_str()),
            finish_time,
            applied_at,
            next_poll_at,
        )
        .await?;
        Ok(Some(TaskPollApplyOutcome {
            lease_claimed: true,
            poll_generation: Some(lease.generation),
            cas_won,
            terminal,
        }))
    }
    .await;

    match poll_result {
        Ok(Some(outcome)) => {
            if !outcome.cas_won {
                let _ = release_task_poll_lease(db, task.id, &lease).await;
            }
            Ok(Some(outcome))
        }
        Ok(None) => {
            let _ = release_task_poll_lease(db, task.id, &lease).await;
            Ok(None)
        }
        Err(failure) => {
            let failure_now = task_poll_now_unix_seconds().max(claim_now);
            let _ = record_task_poll_failure(
                db,
                task,
                &lease,
                failure_now,
                retry_base_seconds,
                retry_max_seconds,
                task_poll_failure_limit(max_consecutive_failures, failure.immediate_quarantine),
                failure.error_code,
            )
            .await;
            Err(failure.source)
        }
    }
}

/// Drive one batch of the poller: load up to `limit` unfinished tasks, look up
/// each task's channel, and run a poll cycle. Best-effort per task — a lookup or
/// poll failure on one task is skipped rather than aborting the batch (mirroring
/// the per-task error handling in Go's pollers). Returns the number of tasks
/// whose terminal settlement this run won.
pub async fn sweep_timed_out_tasks(
    db: &D1Database,
    now: i64,
    timeout_minutes: i64,
    poll_lease_seconds: i64,
    limit: i64,
) -> worker::Result<u32> {
    if timeout_minutes <= 0 {
        return Ok(0);
    }
    let cutoff = now.saturating_sub(timeout_minutes.saturating_mul(60));
    let tasks = find_timed_out_unfinished_tasks(db, cutoff, now, limit).await?;
    let owner = generate_task_poll_owner("cron-task-timeout")?;
    let mut settled = 0u32;
    for task in &tasks {
        let claim_now = task_poll_now_unix_seconds().max(now);
        let Some(lease) =
            claim_task_timeout_poll_lease(db, task, &owner, claim_now, poll_lease_seconds).await?
        else {
            continue;
        };
        let _ = advance_task_poll_family_cursor(db, "task_timeout", task.id, claim_now).await?;
        let applied_at = task_poll_now_unix_seconds().max(claim_now);
        match apply_task_timeout(db, task, &lease, timeout_minutes, applied_at).await {
            Ok(true) => settled += 1,
            Ok(false) | Err(_) => {
                let _ = release_task_poll_lease(db, task.id, &lease).await;
            }
        }
    }
    Ok(settled)
}

pub async fn poll_unfinished_tasks(
    db: &D1Database,
    gemini_version: &str,
    now: i64,
    poll_lease_seconds: i64,
    retry_base_seconds: i64,
    retry_max_seconds: i64,
    max_consecutive_failures: i64,
    limit: i64,
) -> worker::Result<u32> {
    let tasks = find_unfinished_tasks(db, now, limit).await?;
    let owner = generate_task_poll_owner("cron-video")?;
    let mut settled = 0u32;
    for task in &tasks {
        let channel = match crate::d1_repositories::find_channel_by_id(db, task.channel_id).await {
            Ok(Some(channel)) => channel,
            _ => {
                let failure_now = task_poll_now_unix_seconds().max(now);
                if let Some(lease) =
                    claim_task_poll_lease(db, task, &owner, failure_now, poll_lease_seconds).await?
                {
                    let _ =
                        advance_task_poll_family_cursor(db, "video", task.id, failure_now).await?;
                    let _ = record_task_poll_failure(
                        db,
                        task,
                        &lease,
                        failure_now,
                        retry_base_seconds,
                        retry_max_seconds,
                        max_consecutive_failures,
                        "channel_unavailable",
                    )
                    .await;
                }
                continue;
            }
        };
        if VideoProvider::from_channel_type(channel.kind as i64).is_none() {
            let failure_now = task_poll_now_unix_seconds().max(now);
            if let Some(lease) =
                claim_task_poll_lease(db, task, &owner, failure_now, poll_lease_seconds).await?
            {
                let _ = advance_task_poll_family_cursor(db, "video", task.id, failure_now).await?;
                let _ = record_task_poll_failure(
                    db,
                    task,
                    &lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    1,
                    "provider_unsupported",
                )
                .await;
            }
            continue;
        }
        let outcome = poll_one_task(
            db,
            task,
            channel.kind,
            &channel.key,
            &channel.base_url,
            gemini_version,
            &owner,
            poll_lease_seconds,
            retry_base_seconds,
            retry_max_seconds,
            max_consecutive_failures,
            task_poll_now_unix_seconds().max(now),
        )
        .await;
        if let Ok(Some(outcome)) = outcome {
            if outcome.lease_claimed {
                let _ = advance_task_poll_family_cursor(
                    db,
                    "video",
                    task.id,
                    task_poll_now_unix_seconds().max(now),
                )
                .await?;
            }
            if outcome.cas_won && outcome.terminal {
                settled += 1;
            }
        }
    }
    Ok(settled)
}

/// Drive the Suno batch poll (Go `UpdateSunoTasks`): load unfinished `suno`
/// tasks, group them by channel, and for each channel POST the batch of upstream
/// ids to `{base}/suno/fetch`, parse the `TaskResponse<Vec<SunoDataResponse>>`,
/// and merge each item back onto its task via
/// [`crate::task_repository::apply_suno_poll_result`] (CAS status + refund on
/// failure). Best-effort per channel/item. Returns the count of settlements won.
pub async fn poll_unfinished_suno_tasks(
    db: &D1Database,
    now: i64,
    poll_lease_seconds: i64,
    retry_base_seconds: i64,
    retry_max_seconds: i64,
    max_consecutive_failures: i64,
    limit: i64,
) -> worker::Result<u32> {
    let tasks = find_unfinished_suno_tasks(db, now, limit).await?;
    let owner = generate_task_poll_owner("cron-suno")?;
    let mut by_channel: HashMap<i64, Vec<&TaskRow>> = HashMap::new();
    for task in &tasks {
        if task.platform == "suno" && !task.upstream_task_id.is_empty() {
            by_channel.entry(task.channel_id).or_default().push(task);
        }
    }

    let mut settled = 0u32;
    for (channel_id, channel_tasks) in by_channel {
        let channel = match crate::d1_repositories::find_channel_by_id(db, channel_id).await {
            Ok(Some(channel)) => channel,
            _ => {
                let failure_now = task_poll_now_unix_seconds().max(now);
                for task in channel_tasks {
                    if let Some(lease) =
                        claim_task_poll_lease(db, task, &owner, failure_now, poll_lease_seconds)
                            .await?
                    {
                        let _ = advance_task_poll_family_cursor(db, "suno", task.id, failure_now)
                            .await?;
                        let _ = record_task_poll_failure(
                            db,
                            task,
                            &lease,
                            failure_now,
                            retry_base_seconds,
                            retry_max_seconds,
                            max_consecutive_failures,
                            "channel_unavailable",
                        )
                        .await;
                    }
                }
                continue;
            }
        };
        let mut claimed = Vec::with_capacity(channel_tasks.len());
        let claim_now = task_poll_now_unix_seconds().max(now);
        for task in channel_tasks {
            if let Some(lease) =
                claim_task_poll_lease(db, task, &owner, claim_now, poll_lease_seconds).await?
            {
                let _ = advance_task_poll_family_cursor(db, "suno", task.id, claim_now).await?;
                claimed.push((task, lease));
            }
        }
        if claimed.is_empty() {
            continue;
        }
        let ids: Vec<&str> = claimed
            .iter()
            .map(|(task, _)| task.upstream_task_id.as_str())
            .collect();
        let request = PollRequest {
            method: HttpMethod::Post,
            url: format!("{}/suno/fetch", channel.base_url),
            headers: vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", channel.key),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(serde_json::json!({ "ids": ids }).to_string()),
        };

        let earliest_expiry = claimed
            .iter()
            .map(|(_, lease)| lease.expires_at)
            .min()
            .unwrap_or(claim_now);
        let Some(provider_timeout_seconds) = task_poll_provider_timeout_until(
            earliest_expiry,
            task_poll_now_unix_seconds().max(claim_now),
        ) else {
            for (task, lease) in &claimed {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_task_poll_failure(
                    db,
                    task,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "lease_budget_exhausted",
                )
                .await;
            }
            continue;
        };
        let Ok(response) =
            execute_poll_request_with_timeout(&request, provider_timeout_seconds).await
        else {
            for (task, lease) in &claimed {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_task_poll_failure(
                    db,
                    task,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "provider_poll_failed",
                )
                .await;
            }
            continue;
        };
        let parsed: suno::TaskResponse<Vec<suno::SunoDataResponse>> =
            match serde_json::from_slice(&response) {
                Ok(parsed) => parsed,
                Err(_) => {
                    for (task, lease) in &claimed {
                        let failure_now = task_poll_now_unix_seconds().max(claim_now);
                        let _ = record_task_poll_failure(
                            db,
                            task,
                            lease,
                            failure_now,
                            retry_base_seconds,
                            retry_max_seconds,
                            max_consecutive_failures,
                            "provider_response_invalid",
                        )
                        .await;
                    }
                    continue;
                }
            };
        if !parsed.is_success() {
            for (task, lease) in &claimed {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_task_poll_failure(
                    db,
                    task,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "provider_poll_rejected",
                )
                .await;
            }
            continue;
        }

        for item in &parsed.data {
            let Some((task, lease)) = claimed
                .iter()
                .find(|(task, _)| task.upstream_task_id == item.task_id)
            else {
                continue;
            };
            let applied_at = task_poll_now_unix_seconds().max(claim_now);
            let next_poll_at = task_poll_next_at(applied_at, retry_base_seconds);
            if let Ok(true) = crate::task_repository::apply_suno_poll_result(
                db,
                task,
                lease,
                &item.status,
                &item.fail_reason,
                applied_at,
                next_poll_at,
            )
            .await
            {
                settled += 1;
            }
        }
        for (task, lease) in &claimed {
            if !parsed
                .data
                .iter()
                .any(|item| item.task_id == task.upstream_task_id)
            {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_task_poll_failure(
                    db,
                    task,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "provider_item_missing",
                )
                .await;
            } else {
                let _ = release_task_poll_lease(db, task.id, lease).await;
            }
        }
    }
    Ok(settled)
}

/// Drive the Midjourney batch poll (Go `controller/midjourney.go`): load
/// unfinished `midjourneys` rows, group by channel, POST the batch of `mj_id`s to
/// `{base}/mj/task/list-by-condition` (authenticated with the `mj-api-secret`
/// header), parse the `[]MidjourneyDto` array, and merge each item onto its row
/// via [`crate::mj_repository::apply_midjourney_poll_result`]. A row that has
/// been unfinished for over an hour without reaching 100% is forced to FAILURE
/// (Go's timeout guard). Best-effort per channel/item; returns settlements won.
pub async fn poll_unfinished_midjourney_tasks(
    db: &D1Database,
    now: i64,
    poll_lease_seconds: i64,
    retry_base_seconds: i64,
    retry_max_seconds: i64,
    max_consecutive_failures: i64,
    limit: i64,
) -> worker::Result<u32> {
    use crate::mj_repository::{
        apply_midjourney_poll_result, claim_midjourney_poll_lease, record_midjourney_poll_failure,
        release_midjourney_poll_lease, MjPollResult, MjRow,
    };

    let rows = crate::mj_repository::find_unfinished_midjourneys(db, now, limit).await?;
    let owner = generate_task_poll_owner("cron-midjourney")?;
    let mut by_channel: HashMap<i64, Vec<&MjRow>> = HashMap::new();
    for row in &rows {
        by_channel.entry(row.channel_id).or_default().push(row);
    }

    let mut settled = 0u32;
    for (channel_id, channel_rows) in by_channel {
        let channel = match crate::d1_repositories::find_channel_by_id(db, channel_id).await {
            Ok(Some(channel)) => channel,
            _ => {
                let failure_now = task_poll_now_unix_seconds().max(now);
                for row in channel_rows {
                    if let Some(lease) = claim_midjourney_poll_lease(
                        db,
                        row,
                        &owner,
                        failure_now,
                        poll_lease_seconds,
                    )
                    .await?
                    {
                        let _ =
                            advance_task_poll_family_cursor(db, "midjourney", row.id, failure_now)
                                .await?;
                        let _ = record_midjourney_poll_failure(
                            db,
                            row,
                            &lease,
                            failure_now,
                            retry_base_seconds,
                            retry_max_seconds,
                            max_consecutive_failures,
                            "channel_unavailable",
                        )
                        .await;
                    }
                }
                continue;
            }
        };
        let mut claimed = Vec::with_capacity(channel_rows.len());
        let claim_now = task_poll_now_unix_seconds().max(now);
        for row in channel_rows {
            if let Some(lease) =
                claim_midjourney_poll_lease(db, row, &owner, claim_now, poll_lease_seconds).await?
            {
                let _ =
                    advance_task_poll_family_cursor(db, "midjourney", row.id, claim_now).await?;
                claimed.push((row, lease));
            }
        }
        if claimed.is_empty() {
            continue;
        }
        let ids: Vec<&str> = claimed.iter().map(|(row, _)| row.mj_id.as_str()).collect();
        let request = PollRequest {
            method: HttpMethod::Post,
            url: format!("{}/mj/task/list-by-condition", channel.base_url),
            headers: vec![
                ("mj-api-secret".to_string(), channel.key.clone()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            body: Some(serde_json::json!({ "ids": ids }).to_string()),
        };

        let earliest_expiry = claimed
            .iter()
            .map(|(_, lease)| lease.expires_at)
            .min()
            .unwrap_or(claim_now);
        let Some(provider_timeout_seconds) = task_poll_provider_timeout_until(
            earliest_expiry,
            task_poll_now_unix_seconds().max(claim_now),
        ) else {
            for (row, lease) in &claimed {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_midjourney_poll_failure(
                    db,
                    row,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "lease_budget_exhausted",
                )
                .await;
            }
            continue;
        };
        let Ok(response) =
            execute_poll_request_with_timeout(&request, provider_timeout_seconds).await
        else {
            for (row, lease) in &claimed {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_midjourney_poll_failure(
                    db,
                    row,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "provider_poll_failed",
                )
                .await;
            }
            continue;
        };
        let items: Vec<midjourney::MidjourneyDto> = match serde_json::from_slice(&response) {
            Ok(items) => items,
            Err(_) => {
                for (row, lease) in &claimed {
                    let failure_now = task_poll_now_unix_seconds().max(claim_now);
                    let _ = record_midjourney_poll_failure(
                        db,
                        row,
                        lease,
                        failure_now,
                        retry_base_seconds,
                        retry_max_seconds,
                        max_consecutive_failures,
                        "provider_response_invalid",
                    )
                    .await;
                }
                continue;
            }
        };

        for item in &items {
            let Some((row, lease)) = claimed.iter().find(|(row, _)| row.mj_id == item.mj_id) else {
                continue;
            };
            let applied_at = task_poll_now_unix_seconds().max(claim_now);
            // Over an hour unfinished and not at 100% -> force failure (Go guard).
            let timed_out = crate::mj_repository::midjourney_is_timed_out(
                row.submit_time,
                &row.progress,
                applied_at,
            );
            let status = if timed_out {
                "FAILURE"
            } else {
                item.status.as_str()
            };
            let fail_reason = if timed_out {
                "upstream task timeout (over 1 hour)"
            } else {
                item.fail_reason.as_str()
            };
            let finish_time = if status == "SUCCESS" || status == "FAILURE" {
                applied_at.saturating_mul(1_000)
            } else {
                0
            };
            let result = MjPollResult {
                status,
                progress: &item.progress,
                fail_reason,
                image_url: &item.image_url,
                video_url: &item.video_url,
                finish_time,
            };
            let next_poll_at = task_poll_next_at(applied_at, retry_base_seconds);
            if let Ok(true) =
                apply_midjourney_poll_result(db, row, lease, &result, applied_at, next_poll_at)
                    .await
            {
                settled += 1;
            }
        }
        for (row, lease) in &claimed {
            if !items.iter().any(|item| item.mj_id == row.mj_id) {
                let failure_now = task_poll_now_unix_seconds().max(claim_now);
                let _ = record_midjourney_poll_failure(
                    db,
                    row,
                    lease,
                    failure_now,
                    retry_base_seconds,
                    retry_max_seconds,
                    max_consecutive_failures,
                    "provider_item_missing",
                )
                .await;
            } else {
                let _ = release_midjourney_poll_lease(db, row.id, lease).await;
            }
        }
    }
    Ok(settled)
}

// ---------------------------------------------------------------------------
// Client-facing task fetch (Go RelayTaskFetch)
// ---------------------------------------------------------------------------

fn result_url_from_private_data(private_data: &str, fail_reason: &str) -> String {
    result_url_option_from_private_data(private_data).unwrap_or_else(|| fail_reason.to_string())
}

fn result_url_option_from_private_data(private_data: &str) -> Option<String> {
    let private: serde_json::Value =
        serde_json::from_str(private_data).unwrap_or(serde_json::Value::Null);
    private
        .get("result_url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| !url.is_empty())
        .map(ToString::to_string)
}

fn progress_percent(progress: &str) -> i64 {
    progress
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<i64>()
        .unwrap_or(0)
}

fn task_data_json(row: &crate::task_repository::TaskDtoRow) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(&row.data).ok()?;
    match &value {
        serde_json::Value::Object(map) if map.is_empty() => None,
        serde_json::Value::Null => None,
        _ => Some(value),
    }
}

fn json_path_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_str()
        .filter(|item| !item.trim().is_empty())
        .map(ToString::to_string)
}

fn json_path_i64(value: &serde_json::Value, path: &[&str]) -> Option<i64> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_i64()
}

fn json_first_array_string(
    value: &serde_json::Value,
    array_path: &[&str],
    item_field: &str,
) -> Option<String> {
    let mut current = value;
    for segment in array_path {
        current = current.get(*segment)?;
    }
    current
        .as_array()?
        .first()?
        .get(item_field)?
        .as_str()
        .filter(|item| !item.trim().is_empty())
        .map(ToString::to_string)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenAiVideoProvider {
    Ali,
    Doubao,
    Kling,
    Vidu,
    Jimeng,
    Gemini,
    Vertex,
    Hailuo,
    Sora,
}

fn openai_video_provider(row: &crate::task_repository::TaskDtoRow) -> Option<OpenAiVideoProvider> {
    match row.platform.as_str() {
        "17" => Some(OpenAiVideoProvider::Ali),
        "45" | "54" => Some(OpenAiVideoProvider::Doubao),
        "50" => Some(OpenAiVideoProvider::Kling),
        "52" => Some(OpenAiVideoProvider::Vidu),
        "51" => Some(OpenAiVideoProvider::Jimeng),
        "24" => Some(OpenAiVideoProvider::Gemini),
        "41" => Some(OpenAiVideoProvider::Vertex),
        "35" => Some(OpenAiVideoProvider::Hailuo),
        "1" | "55" | "sora" => Some(OpenAiVideoProvider::Sora),
        _ => None,
    }
}

fn provider_data_url(data: Option<&serde_json::Value>) -> Option<String> {
    let data = data?;
    for path in [
        &["content", "video_url"][..],
        &["output", "video_url"][..],
        &["data", "video_url"][..],
        &["video_url"][..],
        &["url"][..],
    ] {
        if let Some(url) = json_path_string(data, path) {
            return Some(url);
        }
    }
    json_first_array_string(data, &["data", "task_result", "videos"], "url")
        .or_else(|| json_first_array_string(data, &["task_result", "videos"], "url"))
        .or_else(|| json_first_array_string(data, &["creations"], "url"))
}

fn build_video_data_url(
    mime_type: Option<&str>,
    encoding: Option<&str>,
    base64_data: &str,
) -> String {
    let mime = mime_type
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let encoding = encoding
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .unwrap_or("mp4");
            if encoding.contains('/') {
                encoding.to_string()
            } else {
                format!("video/{encoding}")
            }
        });
    format!("data:{mime};base64,{base64_data}")
}

fn vertex_video_url_from_data(data: Option<&serde_json::Value>) -> Option<String> {
    let response = data?.get("response")?;
    if let Some(video) = response
        .get("videos")
        .and_then(serde_json::Value::as_array)
        .and_then(|videos| videos.first())
    {
        if let Some(b64) = json_path_string(video, &["bytesBase64Encoded"])
            .filter(|value| !value.trim().is_empty())
        {
            let mime = json_path_string(video, &["mimeType"]);
            let encoding = json_path_string(video, &["encoding"]);
            return Some(build_video_data_url(
                mime.as_deref(),
                encoding.as_deref(),
                &b64,
            ));
        }
    }
    if let Some(b64) =
        json_path_string(response, &["bytesBase64Encoded"]).filter(|value| !value.trim().is_empty())
    {
        let encoding = json_path_string(response, &["encoding"]);
        return Some(build_video_data_url(None, encoding.as_deref(), &b64));
    }
    if let Some(video) =
        json_path_string(response, &["video"]).filter(|value| !value.trim().is_empty())
    {
        if video.starts_with("data:")
            || video.starts_with("http://")
            || video.starts_with("https://")
        {
            return Some(video);
        }
        let encoding = json_path_string(response, &["encoding"]);
        return Some(build_video_data_url(None, encoding.as_deref(), &video));
    }
    None
}

fn is_self_video_content_url(url: &str, task_id: &str) -> bool {
    let task_id = task_id.trim();
    !task_id.is_empty() && url.contains(&format!("/v1/videos/{task_id}/content"))
}

fn non_self_video_content_url(url: String, task_id: &str) -> Option<String> {
    if is_self_video_content_url(&url, task_id) {
        None
    } else {
        Some(url)
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum VideoContentSourceError {
    NotCompleted(String),
    MissingUrl,
}

fn video_content_source_url(
    row: &crate::task_repository::TaskDtoRow,
) -> Result<String, VideoContentSourceError> {
    let status = TaskStatus::from_status_str(&row.status);
    if status != TaskStatus::Success {
        return Err(VideoContentSourceError::NotCompleted(row.status.clone()));
    }

    let data = task_data_json(row);
    let provider = openai_video_provider(row);
    let url = result_url_option_from_private_data(&row.private_data)
        .and_then(|url| non_self_video_content_url(url, &row.task_id))
        .or_else(|| {
            let fail_reason = row.fail_reason.trim();
            if fail_reason.is_empty() || is_self_video_content_url(fail_reason, &row.task_id) {
                None
            } else {
                Some(fail_reason.to_string())
            }
        })
        .or_else(|| {
            if provider == Some(OpenAiVideoProvider::Vertex) {
                vertex_video_url_from_data(data.as_ref())
                    .and_then(|url| non_self_video_content_url(url, &row.task_id))
            } else {
                None
            }
        })
        .or_else(|| {
            provider_data_url(data.as_ref())
                .and_then(|url| non_self_video_content_url(url, &row.task_id))
        });

    url.ok_or(VideoContentSourceError::MissingUrl)
}

fn is_openai_video_passthrough(
    row: &crate::task_repository::TaskDtoRow,
    data: Option<&serde_json::Value>,
) -> bool {
    openai_video_provider(row) == Some(OpenAiVideoProvider::Sora)
        || data
            .and_then(|value| json_path_string(value, &["object"]))
            .as_deref()
            == Some("video")
}

fn convert_ali_video_status(status: &str) -> &'static str {
    match status {
        "PENDING" => "queued",
        "RUNNING" => "in_progress",
        "SUCCEEDED" => "completed",
        "FAILED" | "CANCELED" | "UNKNOWN" => "failed",
        _ => "unknown",
    }
}

fn provider_video_status(
    provider: Option<OpenAiVideoProvider>,
    status: TaskStatus,
    data: Option<&serde_json::Value>,
) -> String {
    if provider == Some(OpenAiVideoProvider::Ali) {
        if let Some(ali_status) =
            data.and_then(|item| json_path_string(item, &["output", "task_status"]))
        {
            return convert_ali_video_status(&ali_status).to_string();
        }
    }
    status.to_video_status().to_string()
}

fn provider_data_error_message(data: Option<&serde_json::Value>) -> Option<String> {
    let data = data?;
    json_path_string(data, &["error", "message"])
        .or_else(|| json_path_string(data, &["output", "message"]))
        .or_else(|| json_path_string(data, &["message"]))
}

fn provider_video_error(
    provider: Option<OpenAiVideoProvider>,
    data: Option<&serde_json::Value>,
) -> Option<(String, String)> {
    let data = data?;
    match provider? {
        OpenAiVideoProvider::Ali => {
            if let Some(code) = json_path_string(data, &["code"]).filter(|code| !code.is_empty()) {
                let message = json_path_string(data, &["message"]).unwrap_or_default();
                return Some((message, code));
            }
            if let Some(code) =
                json_path_string(data, &["output", "code"]).filter(|code| !code.is_empty())
            {
                let message = json_path_string(data, &["output", "message"]).unwrap_or_default();
                return Some((message, code));
            }
            None
        }
        OpenAiVideoProvider::Doubao => {
            if json_path_string(data, &["status"]).as_deref() == Some("failed") {
                let message = json_path_string(data, &["error", "message"]).unwrap_or_default();
                let code = json_path_string(data, &["error", "code"]).unwrap_or_default();
                return Some((message, code));
            }
            None
        }
        OpenAiVideoProvider::Kling => {
            let mut error = None;
            if let (Some(code), Some(message)) = (
                json_path_i64(data, &["code"]).filter(|code| *code != 0),
                json_path_string(data, &["message"]),
            ) {
                error = Some((message, code.to_string()));
            }
            if json_path_string(data, &["data", "task_status"]).as_deref() == Some("failed") {
                let message =
                    json_path_string(data, &["data", "task_status_msg"]).unwrap_or_default();
                error = Some((message, String::new()));
            }
            error
        }
        OpenAiVideoProvider::Vidu => {
            if json_path_string(data, &["state"]).as_deref() == Some("failed") {
                if let Some(code) = json_path_string(data, &["err_code"]) {
                    return Some((code.clone(), code));
                }
            }
            None
        }
        OpenAiVideoProvider::Jimeng => {
            if let Some(code) = json_path_i64(data, &["code"]).filter(|code| *code != 10000) {
                let message = json_path_string(data, &["message"]).unwrap_or_default();
                return Some((message, code.to_string()));
            }
            None
        }
        OpenAiVideoProvider::Hailuo => {
            if let Some(code) =
                json_path_i64(data, &["base_resp", "status_code"]).filter(|code| *code != 0)
            {
                let message =
                    json_path_string(data, &["base_resp", "status_msg"]).unwrap_or_default();
                return Some((message, code.to_string()));
            }
            None
        }
        OpenAiVideoProvider::Gemini | OpenAiVideoProvider::Vertex | OpenAiVideoProvider::Sora => {
            None
        }
    }
}

fn upstream_task_id_from_private_data(row: &crate::task_repository::TaskDtoRow) -> String {
    let private: serde_json::Value =
        serde_json::from_str(&row.private_data).unwrap_or(serde_json::Value::Null);
    private
        .get("upstream_task_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(&row.task_id)
        .to_string()
}

fn extract_operation_model(name: &str) -> Option<String> {
    let start = name.find("models/")? + "models/".len();
    let rest = &name[start..];
    let end = rest.find("/operations/")?;
    let model = &rest[..end];
    if model.trim().is_empty() {
        None
    } else {
        Some(model.to_string())
    }
}

fn veo_model_from_upstream_task(row: &crate::task_repository::TaskDtoRow) -> String {
    let upstream_task_id = upstream_task_id_from_private_data(row);
    decode_local_task_id(&upstream_task_id)
        .ok()
        .and_then(|name| extract_operation_model(&name))
        .unwrap_or_else(|| "veo-3.0-generate-001".to_string())
}

fn task_origin_model(
    row: &crate::task_repository::TaskDtoRow,
    data: Option<&serde_json::Value>,
) -> String {
    let properties: serde_json::Value =
        serde_json::from_str(&row.properties).unwrap_or(serde_json::Value::Null);
    properties
        .get("origin_model_name")
        .and_then(serde_json::Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .or_else(|| {
            data.and_then(|value| value.get("model"))
                .and_then(serde_json::Value::as_str)
                .filter(|model| !model.trim().is_empty())
        })
        .unwrap_or(&row.platform)
        .to_string()
}

fn string_or_number_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_i64(),
        Some(serde_json::Value::String(value)) => value.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn remix_billing_ratios_from_origin(row: &crate::task_repository::TaskDtoRow) -> Vec<f64> {
    let data = task_data_json(row);
    let seconds = data
        .as_ref()
        .and_then(|value| string_or_number_i64(value.get("seconds")))
        .filter(|value| *value > 0)
        .unwrap_or(4);
    let size = data
        .as_ref()
        .and_then(|value| value.get("size"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let size_ratio = if size == "1792x1024" || size == "1024x1792" {
        1.666667
    } else {
        1.0
    };
    vec![seconds as f64, size_ratio]
}

fn remix_origin_model(row: &crate::task_repository::TaskDtoRow, fallback_model: &str) -> String {
    let data = task_data_json(row);
    let properties: serde_json::Value =
        serde_json::from_str(&row.properties).unwrap_or(serde_json::Value::Null);
    let model = properties
        .get("origin_model_name")
        .and_then(serde_json::Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .or_else(|| {
            properties
                .get("upstream_model_name")
                .and_then(serde_json::Value::as_str)
                .filter(|model| !model.trim().is_empty())
        })
        .or_else(|| {
            data.as_ref()
                .and_then(|value| value.get("model"))
                .and_then(serde_json::Value::as_str)
                .filter(|model| !model.trim().is_empty())
        })
        .unwrap_or("");
    if model.trim().is_empty() {
        fallback_model.trim().to_string()
    } else {
        model.to_string()
    }
}

fn openai_video_submit_json(task_id: &str, model: &str, created_at: i64) -> serde_json::Value {
    serde_json::json!({
        "id": task_id,
        "object": "video",
        "model": model,
        "status": TaskStatus::Submitted.to_video_status(),
        "progress": 0,
        "created_at": created_at,
    })
}

fn openai_video_json(row: &crate::task_repository::TaskDtoRow) -> serde_json::Value {
    let status = TaskStatus::from_status_str(&row.status);
    let data = task_data_json(row);
    let provider = openai_video_provider(row);
    let result_url = result_url_option_from_private_data(&row.private_data)
        .or_else(|| provider_data_url(data.as_ref()))
        .unwrap_or_else(|| row.fail_reason.clone());
    let progress = if row.progress.trim().is_empty() {
        data.as_ref()
            .and_then(|value| json_path_i64(value, &["progress"]))
            .unwrap_or(0)
    } else {
        progress_percent(&row.progress)
    };
    let mut video = serde_json::json!({
        "id": row.task_id,
        "object": "video",
        "model": task_origin_model(row, data.as_ref()),
        "status": provider_video_status(provider, status, data.as_ref()),
        "progress": progress,
        "created_at": row.created_at,
        "metadata": {
            "url": result_url,
        },
    });
    if row.finish_time > 0 {
        video["completed_at"] = serde_json::json!(row.finish_time);
    }
    for field in ["seconds", "size", "remixed_from_video_id"] {
        if let Some(value) = data
            .as_ref()
            .and_then(|item| json_path_string(item, &[field]))
        {
            video[field] = serde_json::json!(value);
        }
    }
    if let Some(value) = data
        .as_ref()
        .and_then(|item| json_path_i64(item, &["expires_at"]))
    {
        video["expires_at"] = serde_json::json!(value);
    }
    if is_openai_video_passthrough(row, data.as_ref()) {
        if let Some(value) = data
            .as_ref()
            .and_then(|item| json_path_i64(item, &["created_at"]))
        {
            video["created_at"] = serde_json::json!(value);
        }
        if row.finish_time == 0 {
            if let Some(value) = data
                .as_ref()
                .and_then(|item| json_path_i64(item, &["completed_at"]))
            {
                video["completed_at"] = serde_json::json!(value);
            }
        }
    }

    match provider {
        Some(OpenAiVideoProvider::Ali)
        | Some(OpenAiVideoProvider::Doubao)
        | Some(OpenAiVideoProvider::Vidu)
        | Some(OpenAiVideoProvider::Jimeng)
        | Some(OpenAiVideoProvider::Hailuo)
        | Some(OpenAiVideoProvider::Vertex) => {
            if row.updated_at > 0 {
                video["completed_at"] = serde_json::json!(row.updated_at);
            }
        }
        Some(OpenAiVideoProvider::Gemini) => {
            if row.finish_time > 0 {
                video["completed_at"] = serde_json::json!(row.finish_time);
            } else if row.updated_at > 0 {
                video["completed_at"] = serde_json::json!(row.updated_at);
            }
            video["model"] = serde_json::json!(veo_model_from_upstream_task(row));
        }
        Some(OpenAiVideoProvider::Kling) => {
            if let Some(value) = data
                .as_ref()
                .and_then(|item| json_path_i64(item, &["data", "created_at"]))
            {
                video["created_at"] = serde_json::json!(value);
            }
            if let Some(value) = data
                .as_ref()
                .and_then(|item| json_path_i64(item, &["data", "updated_at"]))
            {
                video["completed_at"] = serde_json::json!(value);
            }
            if let Some(value) = data.as_ref().and_then(|item| {
                json_first_array_string(item, &["data", "task_result", "videos"], "duration")
            }) {
                video["seconds"] = serde_json::json!(value);
            }
        }
        Some(OpenAiVideoProvider::Sora) | None => {}
    }
    if provider == Some(OpenAiVideoProvider::Doubao) {
        video["task_id"] = serde_json::json!(row.task_id);
    }
    if provider == Some(OpenAiVideoProvider::Vertex) {
        video["model"] = serde_json::json!(veo_model_from_upstream_task(row));
    }

    let error = provider_video_error(provider, data.as_ref()).or_else(|| {
        if status == TaskStatus::Failure {
            if row.fail_reason.trim().is_empty() {
                provider_data_error_message(data.as_ref())
                    .map(|message| (message, "task_failed".to_string()))
            } else {
                Some((row.fail_reason.clone(), "task_failed".to_string()))
            }
        } else {
            None
        }
    });
    if let Some((message, code)) = error {
        video["error"] = serde_json::json!({
            "message": message,
            "code": code,
        });
    }
    video
}

/// Serialize a stored task as Go `dto.TaskDto` (JSON field names preserved).
/// `result_url` follows Go `Task.GetResultURL`: `private_data.result_url`,
/// falling back to `fail_reason`. `properties`/`data` are re-emitted as raw
/// JSON values (Go stores them as JSON blobs).
fn task_dto_json(row: &crate::task_repository::TaskDtoRow) -> serde_json::Value {
    let result_url = result_url_from_private_data(&row.private_data, &row.fail_reason);
    let properties: serde_json::Value =
        serde_json::from_str(&row.properties).unwrap_or(serde_json::Value::Null);
    let data: serde_json::Value =
        serde_json::from_str(&row.data).unwrap_or(serde_json::Value::Null);
    let mut dto = serde_json::json!({
        "id": row.id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "task_id": row.task_id,
        "platform": row.platform,
        "user_id": row.user_id,
        "group": row.group,
        "channel_id": row.channel_id,
        "quota": row.quota,
        "action": row.action,
        "status": row.status,
        "fail_reason": row.fail_reason,
        "submit_time": row.submit_time,
        "start_time": row.start_time,
        "finish_time": row.finish_time,
        "progress": row.progress,
        "properties": properties,
        "data": data,
    });
    // Go marks result_url/username omitempty.
    if !result_url.is_empty() {
        dto["result_url"] = serde_json::json!(result_url);
    }
    if !row.username.is_empty() {
        dto["username"] = serde_json::json!(row.username);
    }
    dto
}

/// Go `dto.TaskError` response shape.
fn task_error_response(code: &str, message: &str, status: u16) -> worker::Result<Response> {
    crate::json_with_status(
        &serde_json::json!({"code": code, "message": message, "data": null}),
        status,
    )
}

fn video_proxy_error(
    status: u16,
    err_type: &str,
    message: impl Into<String>,
) -> worker::Result<Response> {
    crate::json_with_status(
        &serde_json::json!({
            "error": {
                "message": message.into(),
                "type": err_type,
            }
        }),
        status,
    )
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum VideoDataUrlError {
    Invalid,
    Unsupported,
    TooLarge,
    DecodeFailed,
}

fn decode_video_data_url(
    data_url: &str,
    max_bytes: usize,
) -> Result<(String, Vec<u8>), VideoDataUrlError> {
    let (header, payload) = data_url.split_once(',').ok_or(VideoDataUrlError::Invalid)?;
    let metadata = header
        .strip_prefix("data:")
        .ok_or(VideoDataUrlError::Invalid)?;
    let mut metadata_parts = metadata.split(';');
    let mime_type = metadata_parts
        .next()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or("video/mp4")
        .trim()
        .to_string();
    if !metadata_parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Err(VideoDataUrlError::Unsupported);
    }

    let encoded = payload.trim();
    if encoded.len().saturating_mul(3) / 4 > max_bytes.saturating_add(2) {
        return Err(VideoDataUrlError::TooLarge);
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .or_else(|_| BASE64_STANDARD_NO_PAD.decode(encoded))
        .map_err(|_| VideoDataUrlError::DecodeFailed)?;
    if bytes.len() > max_bytes {
        return Err(VideoDataUrlError::TooLarge);
    }
    Ok((mime_type, bytes))
}

fn video_bytes_response(mime_type: &str, bytes: Vec<u8>) -> worker::Result<Response> {
    let mut headers = Headers::new();
    headers.set("content-type", mime_type)?;
    headers.set("cache-control", "public, max-age=86400")?;
    let mut response = Response::from_bytes(bytes)?
        .with_status(200)
        .with_headers(headers);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn finalize_video_proxy_response(upstream: Response) -> worker::Result<Response> {
    let status = upstream.status_code();
    let mut headers = Headers::new();
    for (name, value) in upstream.headers().entries() {
        let _ = headers.set(&name, &value);
    }
    headers.set("cache-control", "public, max-age=86400")?;
    let (_, body) = upstream.into_parts();
    let mut response = Response::from_body(body)?
        .with_status(status)
        .with_headers(headers);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

async fn proxy_video_content_url(url: &str) -> worker::Result<Response> {
    let url = url.trim();
    if url.starts_with("data:") {
        return match decode_video_data_url(url, VIDEO_CONTENT_DATA_URL_MAX_BYTES) {
            Ok((mime_type, bytes)) => video_bytes_response(&mime_type, bytes),
            Err(VideoDataUrlError::TooLarge) => video_proxy_error(
                413,
                "invalid_request_error",
                "Video data URL exceeds Worker inline content limit",
            ),
            Err(_) => video_proxy_error(502, "server_error", "Failed to fetch video content"),
        };
    }

    let parsed = match SsrfPolicy::strict_default().validate_url(url) {
        Ok(url) => url,
        Err(err) => {
            return video_proxy_error(403, "server_error", format!("request blocked: {err}"))
        }
    };
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    init.with_redirect(VIDEO_PROXY_REDIRECT_POLICY);
    let outbound = Request::new_with_init(parsed.as_str(), &init)?;
    let upstream = Fetch::Request(outbound).send().await?;
    if upstream.status_code() != 200 {
        return video_proxy_error(
            502,
            "server_error",
            format!(
                "Upstream service returned status {}",
                upstream.status_code()
            ),
        );
    }
    finalize_video_proxy_response(upstream)
}

fn task_submission_json(value: &serde_json::Value, status: u16) -> worker::Result<Response> {
    let mut response = crate::json_with_status(value, status)?;
    response
        .headers_mut()
        .set("Cache-Control", "private, no-store")?;
    Ok(response)
}

/// Return the durable submit-operation state for the API token that created it.
/// Provider IDs, channel identity, billing contracts, and idempotency digests
/// stay private so a timed-out caller can recover without duplicating work.
pub async fn handle_task_submission_status(
    req: Request,
    env: Env,
    submission_id: Option<&String>,
) -> worker::Result<Response> {
    let Some(submission_id) = submission_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && value.len() <= 160)
    else {
        return task_submission_json(&serde_json::json!({"error": "invalid submission id"}), 400);
    };
    let Some(api_key) = crate::relay::extract_api_key(&req) else {
        return task_submission_json(&serde_json::json!({"error": "missing api key"}), 401);
    };
    let db = env.d1("DB")?;
    let client_ip = crate::relay::client_ip(&req);
    let auth =
        match crate::relay::authenticate_for_model_list(&db, &env, &api_key, client_ip.as_deref())
            .await
        {
            Ok(auth) => auth,
            Err(response) => {
                let mut response = response?;
                response
                    .headers_mut()
                    .set("Cache-Control", "private, no-store")?;
                return Ok(response);
            }
        };
    let Some(intent) =
        find_task_billing_intent_for_owner(&db, auth.user_id, auth.token_id, submission_id).await?
    else {
        return task_submission_json(&serde_json::json!({"error": "submission not found"}), 404);
    };
    let task_available = matches!(intent.status.as_str(), "attached" | "settled");
    let terminal = intent.status == "settled"
        || intent.status == "refunded"
        || intent.submit_state == "rejected";
    task_submission_json(
        &serde_json::json!({
            "submission_id": intent.public_task_id,
            "task_id": intent.public_task_id,
            "task_kind": intent.task_kind,
            "lifecycle_status": intent.status,
            "submit_state": intent.submit_state,
            "task_available": task_available,
            "terminal": terminal,
            "created_at": intent.created_at,
            "submit_deadline_at": intent.submit_deadline_at,
            "updated_at": intent.updated_at,
        }),
        200,
    )
}

/// Shared auth for the fetch endpoints (same token auth as task submit).
async fn authenticate_fetch(
    req: &Request,
    env: &Env,
    db: &worker::D1Database,
) -> worker::Result<std::result::Result<cinatoken_storage::AuthenticatedToken, Response>> {
    let Some(api_key) = crate::relay::extract_api_key(req) else {
        return Ok(Err(task_error_response(
            "unauthorized",
            "missing api key",
            401,
        )?));
    };
    let client_ip = crate::relay::client_ip(req);
    match crate::relay::authenticate_for_model_list(db, env, &api_key, client_ip.as_deref()).await {
        Ok(auth) => Ok(Ok(auth)),
        Err(response) => Ok(Err(response?)),
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
enum VideoContentSessionAuthError {
    MissingUser,
    DisabledUser,
}

fn active_session_video_user_id(
    user: Option<&crate::d1_repositories::AdminUserRow>,
) -> Result<i64, VideoContentSessionAuthError> {
    let user = user.ok_or(VideoContentSessionAuthError::MissingUser)?;
    if user.status != USER_STATUS_ENABLED {
        return Err(VideoContentSessionAuthError::DisabledUser);
    }
    Ok(user.id)
}

/// Go `TokenOrUserAuth` parity for `/v1/videos/:task_id/content`: dashboard
/// sessions are tried first, then API tokens for programmatic clients.
async fn authenticate_video_content_user_id(
    req: &Request,
    env: &Env,
    db: &worker::D1Database,
) -> worker::Result<std::result::Result<i64, Response>> {
    let api_key = crate::relay::extract_api_key(req);
    match crate::admin::optional_user_auth(req, env).await {
        Ok(Ok(Some(claims))) => {
            let user = crate::d1_repositories::find_user_by_id(db, claims.id).await?;
            return match active_session_video_user_id(user.as_ref()) {
                Ok(user_id) => Ok(Ok(user_id)),
                Err(VideoContentSessionAuthError::MissingUser) => Ok(Err(video_proxy_error(
                    401,
                    "authentication_error",
                    "invalid session user",
                )?)),
                Err(VideoContentSessionAuthError::DisabledUser) => Ok(Err(video_proxy_error(
                    403,
                    "permission_error",
                    "user is disabled",
                )?)),
            };
        }
        Ok(Ok(None)) => {}
        Ok(Err(response)) if api_key.is_none() => {
            let status = response.status_code();
            let (error_type, message) = match status {
                401 => ("authentication_error", "invalid session user"),
                403 => ("permission_error", "user is disabled"),
                _ => ("server_error", "failed to parse session"),
            };
            return Ok(Err(video_proxy_error(status, error_type, message)?));
        }
        Ok(Err(_response)) => {}
        Err(err) => return Err(err),
    }

    let Some(api_key) = api_key else {
        return Ok(Err(video_proxy_error(
            401,
            "authentication_error",
            "missing api key or session",
        )?));
    };
    let client_ip = crate::relay::client_ip(req);
    match crate::relay::authenticate_for_model_list(db, env, &api_key, client_ip.as_deref()).await {
        Ok(auth) => Ok(Ok(auth.user_id)),
        Err(response) => Ok(Err(response?)),
    }
}

/// `GET /v1/video/generations/:task_id` + `GET /suno/fetch/:id` (Go
/// `RelayTaskFetch` by-id): the owner's task as a `{code:"success", data:
/// TaskDto}` envelope. Bounded vs Go (documented): the Gemini/Vertex
/// realtime-refetch and the `/v1/videos/*` OpenAI-video conversion branches
/// are not ported; the DB-backed TaskDto (kept current by the poller cron) is
/// authoritative here.
pub async fn handle_task_fetch_by_id(
    req: Request,
    env: Env,
    task_id: Option<&String>,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let auth = match authenticate_fetch(&req, &env, &db).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    let Some(task_id) = task_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return task_error_response("invalid_request", "missing task id", 400);
    };
    let Some(row) = crate::task_repository::find_task_dto(&db, auth.user_id, task_id).await? else {
        return task_error_response("task_not_exist", "task_not_exist", 400);
    };
    crate::json_with_status(
        &serde_json::json!({"code": "success", "data": task_dto_json(&row)}),
        200,
    )
}

/// `GET /v1/videos/:task_id`: OpenAI-compatible video status response. The
/// DB-backed serializer ports provider-specific fields that can be derived from
/// stored task JSON; credentialed artifact refetch remains a content-proxy/R2
/// follow-up.
pub async fn handle_openai_video_fetch_by_id(
    req: Request,
    env: Env,
    task_id: Option<&String>,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let auth = match authenticate_fetch(&req, &env, &db).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    let Some(task_id) = task_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return task_error_response("invalid_request", "missing task id", 400);
    };
    let Some(row) = crate::task_repository::find_task_dto(&db, auth.user_id, task_id).await? else {
        return task_error_response("task_not_exist", "task_not_exist", 400);
    };
    crate::json_with_status(&openai_video_json(&row), 200)
}

/// `GET /v1/videos/:task_id/content`: owner-scoped OpenAI-compatible video
/// content proxy. This first production slice serves stored provider URLs and
/// bounded `data:` URLs only. Provider refetches that require stored upstream
/// credentials (Gemini/Vertex/Sora/OpenAI) remain out of this request path until
/// the Queue/R2 artifact pipeline owns retrieval and retention.
pub async fn handle_openai_video_content_by_id(
    req: Request,
    env: Env,
    task_id: Option<&String>,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let user_id = match authenticate_video_content_user_id(&req, &env, &db).await? {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let Some(task_id) = task_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return video_proxy_error(400, "invalid_request_error", "task_id is required");
    };
    let Some(row) = crate::task_repository::find_task_dto(&db, user_id, task_id).await? else {
        return video_proxy_error(404, "invalid_request_error", "Task not found");
    };
    let url = match video_content_source_url(&row) {
        Ok(url) => url,
        Err(VideoContentSourceError::NotCompleted(status)) => {
            return video_proxy_error(
                400,
                "invalid_request_error",
                format!("Task is not completed yet, current status: {status}"),
            )
        }
        Err(VideoContentSourceError::MissingUrl) => {
            return video_proxy_error(502, "server_error", "Failed to fetch video content")
        }
    };
    proxy_video_content_url(&url).await
}

/// `POST /suno/fetch` (Go `sunoFetchRespBodyBuilder`): batch fetch by public
/// task ids; unknown ids are simply absent from the result.
pub async fn handle_task_fetch_batch(mut req: Request, env: Env) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let auth = match authenticate_fetch(&req, &env, &db).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    #[derive(serde::Deserialize, Default)]
    struct FetchReq {
        #[serde(default)]
        ids: Vec<serde_json::Value>,
    }
    let body: FetchReq = match req.json().await {
        Ok(body) => body,
        Err(_) => return task_error_response("invalid_request", "invalid request body", 400),
    };
    // Go binds ids as []any (strings or numbers); normalize to strings.
    let ids: Vec<String> = body
        .ids
        .iter()
        .filter_map(|value| match value {
            serde_json::Value::String(id) => Some(id.clone()),
            serde_json::Value::Number(id) => Some(id.to_string()),
            _ => None,
        })
        .collect();
    let tasks: Vec<serde_json::Value> = if ids.is_empty() {
        Vec::new()
    } else {
        crate::task_repository::find_task_dtos(&db, auth.user_id, &ids)
            .await?
            .iter()
            .map(task_dto_json)
            .collect()
    };
    crate::json_with_status(&serde_json::json!({"code": "success", "data": tasks}), 200)
}

/// Serialize a midjourneys row as Go `dto.MidjourneyDto` (exact JSON tags;
/// `buttons`/`videoUrls`/`properties` re-emitted as parsed JSON when present).
/// Bounded vs Go (documented): the `MjForwardUrlEnabled` image-URL rewrite to
/// a local `/mj/image/:id` proxy is not ported (no image proxy); the stored
/// upstream URL is returned as-is.
fn mj_dto_json(row: &crate::mj_repository::MjDtoRow) -> serde_json::Value {
    let parse_or_null = |raw: &str| -> serde_json::Value {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(trimmed).unwrap_or(serde_json::Value::Null)
        }
    };
    serde_json::json!({
        "id": row.mj_id,
        "action": row.action,
        "customId": "",
        "botType": "",
        "prompt": row.prompt,
        "promptEn": row.prompt_en,
        "description": row.description,
        "state": row.state,
        "submitTime": row.submit_time,
        "startTime": row.start_time,
        "finishTime": row.finish_time,
        "imageUrl": row.image_url,
        "videoUrl": row.video_url,
        "videoUrls": parse_or_null(&row.video_urls),
        "status": row.status,
        "progress": row.progress,
        "failReason": row.fail_reason,
        "buttons": parse_or_null(&row.buttons),
        "maskBase64": "",
        "properties": parse_or_null(&row.properties),
    })
}

/// `GET /mj/task/:id/fetch` (Go `RelayMidjourneyTask` fetch mode): the owner's
/// Midjourney task as a raw `MidjourneyDto`. Unknown id returns Go's
/// `{code:4, description:"task_no_found"}` shape.
pub async fn handle_mj_task_fetch(
    req: Request,
    env: Env,
    mj_id: Option<&String>,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let auth = match authenticate_fetch(&req, &env, &db).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    let Some(mj_id) = mj_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return crate::json_with_status(
            &serde_json::json!({"code": 4, "description": "task_no_found"}),
            400,
        );
    };
    let Some(row) = crate::mj_repository::find_mj_dto(&db, auth.user_id, mj_id).await? else {
        return crate::json_with_status(
            &serde_json::json!({"code": 4, "description": "task_no_found"}),
            400,
        );
    };
    crate::json_with_status(&mj_dto_json(&row), 200)
}

/// `POST /mj/task/list-by-condition` (Go fetch-by-condition mode): the owner's
/// Midjourney tasks matching `{ids: [...]}` as a raw `MidjourneyDto` array.
pub async fn handle_mj_task_list_by_condition(
    mut req: Request,
    env: Env,
) -> worker::Result<Response> {
    let db = env.d1("DB")?;
    let auth = match authenticate_fetch(&req, &env, &db).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    #[derive(serde::Deserialize, Default)]
    struct Condition {
        #[serde(default)]
        ids: Vec<String>,
    }
    let condition: Condition = match req.json().await {
        Ok(condition) => condition,
        Err(_) => {
            return crate::json_with_status(
                &serde_json::json!({"code": 4, "description": "do_request_failed"}),
                400,
            )
        }
    };
    let tasks: Vec<serde_json::Value> = if condition.ids.is_empty() {
        Vec::new()
    } else {
        crate::mj_repository::find_mj_dtos(&db, auth.user_id, &condition.ids)
            .await?
            .iter()
            .map(mj_dto_json)
            .collect()
    };
    crate::json_with_status(&tasks, 200)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_poll_family_slots_rotate_and_cap_each_invocation() {
        assert_eq!(task_poll_family_for_slot(0), TaskPollFamily::Video);
        assert_eq!(task_poll_family_for_slot(60), TaskPollFamily::Suno);
        assert_eq!(task_poll_family_for_slot(120), TaskPollFamily::Midjourney);
        assert_eq!(task_poll_family_for_slot(180), TaskPollFamily::Video);
        assert_eq!(task_poll_family_query_limit(0), 1);
        assert_eq!(task_poll_family_query_limit(4), 4);
        assert_eq!(task_poll_family_query_limit(100), 8);
    }

    #[test]
    fn deterministic_poll_poison_bypasses_retry_threshold() {
        assert_eq!(task_poll_failure_limit(8, false), 8);
        assert_eq!(task_poll_failure_limit(8, true), 1);
        assert_eq!(task_poll_failure_limit(64, true), 1);
    }

    #[test]
    fn task_poll_response_redacts_video_bytes_and_bounds_storage() {
        let body = serde_json::json!({
            "response": {
                "bytesBase64Encoded": "secret",
                "video": "a".repeat(300),
                "videos": [{"bytesBase64Encoded": "secret", "uri": "https://cdn.example/v.mp4"}],
                "status": "done"
            }
        })
        .to_string();
        let redacted = redact_task_poll_response_body(body.as_bytes());
        let value: serde_json::Value = serde_json::from_str(&redacted).unwrap();
        let response = value
            .get("response")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert!(!response.contains_key("bytesBase64Encoded"));
        assert_eq!(response.get("video").unwrap().as_str().unwrap().len(), 259);
        assert!(!response["videos"][0]
            .as_object()
            .unwrap()
            .contains_key("bytesBase64Encoded"));
        assert_eq!(response["status"], "done");

        let oversized = vec![b'x'; TASK_POLL_STORED_RESPONSE_MAX_BYTES + 1];
        let metadata: serde_json::Value =
            serde_json::from_str(&redact_task_poll_response_body(&oversized)).unwrap();
        assert_eq!(metadata["redacted"], true);
        assert_eq!(metadata["reason"], "provider_response_too_large");
        assert_eq!(metadata["original_bytes"], oversized.len());
        assert_eq!(metadata["sha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn task_per_call_quota_covers_fixed_and_ratio_pricing() {
        let mut fixed_config = PricingConfig::new();
        fixed_config
            .model_prices
            .insert("task-fixed".to_string(), 0.02);
        fixed_config.group_ratios.insert("vip".to_string(), 1.5);
        let fixed = FlatPricingSnapshot::from_config("task-fixed", "vip", &fixed_config, 1.0, 0);
        assert_eq!(fixed.mode, FlatBillingMode::FixedPrice);
        assert_eq!(task_base_quota_from_snapshot(&fixed), 15_000);

        let mut ratio_config = PricingConfig::new();
        ratio_config
            .model_ratios
            .insert("task-ratio".to_string(), 0.8);
        ratio_config.group_ratios.insert("vip".to_string(), 1.5);
        let ratio = FlatPricingSnapshot::from_config("task-ratio", "vip", &ratio_config, 1.0, 0);
        assert_eq!(ratio.mode, FlatBillingMode::PerToken);
        assert_eq!(task_base_quota_from_snapshot(&ratio), 300_000);
    }

    #[test]
    fn task_free_model_policy_keeps_setting_default_strict() {
        let mut config = PricingConfig::new();
        config.model_ratios.insert("task-free".to_string(), 0.0);
        let snapshot = FlatPricingSnapshot::from_config("task-free", "default", &config, 1.0, 0);

        assert!(free_model_runtime_decision(&snapshot, false).free_model);
        assert!(!free_model_runtime_decision(&snapshot, true).free_model);
        let free_plan = TaskBillingPlan {
            base_quota: 0,
            snapshot: snapshot.clone(),
            free_model_runtime_policy: free_model_runtime_decision(&snapshot, false),
        };
        let paid_plan = TaskBillingPlan {
            base_quota: 0,
            snapshot: snapshot.clone(),
            free_model_runtime_policy: free_model_runtime_decision(&snapshot, true),
        };
        assert!(task_wallet_admission_allows(0, &free_plan));
        assert!(!task_wallet_admission_allows(0, &paid_plan));
        assert!(task_wallet_admission_allows(1, &paid_plan));
        assert!(task_option_flag(None, true));
        assert!(task_option_flag(Some("invalid"), true));
        assert!(!task_option_flag(Some("false"), true));
        assert!(!task_free_model_preconsume_enabled(
            None,
            Some(r#"{"enable_free_model_pre_consume":false}"#),
        ));
        assert!(task_free_model_preconsume_enabled(
            Some("true"),
            Some(r#"{"enable_free_model_pre_consume":false}"#),
        ));
    }

    #[test]
    fn task_submit_http_status_keeps_ambiguous_outcomes_reserved() {
        assert!(!submit_http_status_is_ambiguous(200));
        assert!(submit_http_status_is_ambiguous(408));
        assert!(submit_http_status_is_ambiguous(409));
        assert!(submit_http_status_is_ambiguous(425));
        assert!(submit_http_status_is_ambiguous(429));
        assert!(!submit_http_status_is_ambiguous(400));
        assert!(submit_http_status_is_ambiguous(302));
        assert!(submit_http_status_is_ambiguous(500));
        assert!(submit_http_status_is_ambiguous(599));
    }

    #[test]
    fn task_submit_client_operation_digest_is_token_scoped_and_replay_stable() {
        let first = task_submit_client_operation_digest(
            7,
            11,
            "task",
            Some("client-operation-1"),
            "generated-a",
        );
        let replay = task_submit_client_operation_digest(
            7,
            11,
            "task",
            Some("client-operation-1"),
            "generated-b",
        );
        let other_token = task_submit_client_operation_digest(
            7,
            12,
            "task",
            Some("client-operation-1"),
            "generated-a",
        );
        let generated = task_submit_client_operation_digest(7, 11, "task", None, "generated-a");
        assert_eq!(first, replay);
        assert_ne!(first, other_token);
        assert_ne!(first, generated);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn task_submit_request_digest_binds_scope_and_body() {
        let first = task_submit_client_request_digest("task:suno:generate:model", br#"{"x":1}"#);
        assert_eq!(
            first,
            task_submit_client_request_digest("task:suno:generate:model", br#"{"x":1}"#)
        );
        assert_ne!(
            first,
            task_submit_client_request_digest("task:suno:extend:model", br#"{"x":1}"#)
        );
        assert_ne!(
            first,
            task_submit_client_request_digest("task:suno:generate:model", br#"{"x":2}"#)
        );
    }

    fn task_row() -> crate::task_repository::TaskDtoRow {
        crate::task_repository::TaskDtoRow {
            id: 1,
            created_at: 100,
            updated_at: 110,
            task_id: "task_video".to_string(),
            platform: "sora".to_string(),
            user_id: 7,
            group: "default".to_string(),
            channel_id: 9,
            quota: 1000,
            action: "generate".to_string(),
            status: "SUCCESS".to_string(),
            fail_reason: String::new(),
            submit_time: 100,
            start_time: 0,
            finish_time: 150,
            progress: "45%".to_string(),
            properties: r#"{"origin_model_name":"sora-2"}"#.to_string(),
            username: "alice".to_string(),
            data: "{}".to_string(),
            private_data: r#"{"result_url":"https://cdn.example/video.mp4"}"#.to_string(),
        }
    }

    fn admin_user_row(id: i64, status: i32) -> crate::d1_repositories::AdminUserRow {
        crate::d1_repositories::AdminUserRow {
            id,
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            role: 1,
            status,
            email: String::new(),
            github_id: String::new(),
            discord_id: String::new(),
            oidc_id: String::new(),
            wechat_id: String::new(),
            telegram_id: String::new(),
            linux_do_id: String::new(),
            password: String::new(),
            quota: 100,
            used_quota: 0,
            request_count: 0,
            group: "default".to_string(),
            aff_count: 0,
            aff_quota: 0,
            aff_history_quota: 0,
            created_at: 100,
            last_login_at: 100,
            session_epoch: 0,
        }
    }

    #[test]
    fn task_poller_env_parser_defaults_clamps_and_accepts_zero_timeout() {
        assert_eq!(parse_task_i64_env(None, 100, 1, 1_000), 100);
        assert_eq!(
            parse_task_i64_env(Some(" 250 ".to_string()), 100, 1, 1_000),
            250
        );
        assert_eq!(
            parse_task_i64_env(Some("0".to_string()), 100, 1, 1_000),
            100
        );
        assert_eq!(
            parse_task_i64_env(Some("2000".to_string()), 100, 1, 1_000),
            1_000
        );
        assert_eq!(
            parse_task_i64_env(Some("0".to_string()), 1_440, 0, 43_200),
            0
        );
        assert_eq!(
            parse_task_i64_env(Some("nope".to_string()), 1_440, 0, 43_200),
            1_440
        );
        assert_eq!(task_poll_provider_timeout_seconds(30), 15);
        assert_eq!(task_poll_provider_timeout_seconds(120), 90);
        assert_eq!(task_poll_provider_timeout_seconds(900), 90);
        assert_eq!(task_poll_provider_timeout_until(130, 100), Some(15));
        assert_eq!(task_poll_provider_timeout_until(115, 100), None);
        assert_eq!(task_poll_provider_timeout_until(220, 100), Some(90));
        assert_eq!(task_poll_next_at(100, 15), 115);
        assert_eq!(DEFAULT_TASK_POLL_RETRY_BASE_SECONDS, 15);
        assert_eq!(DEFAULT_TASK_POLL_RETRY_MAX_SECONDS, 900);
        assert_eq!(DEFAULT_TASK_POLL_MAX_CONSECUTIVE_FAILURES, 8);
    }

    #[test]
    fn task_timeout_sweep_capability_is_compiled() {
        assert!(task_timeout_sweep_compiled());
        assert_eq!(TASK_TIMEOUT_SWEEP_LIMIT, 100);
        assert_eq!(DEFAULT_TASK_TIMEOUT_MINUTES, 1_440);
    }

    #[test]
    fn kling_official_body_wraps_model_prompt_and_metadata() {
        let (task_req, unified_body) = kling_official_task_submit_body(
            br#"{
                "model_name": "kling-v2-master",
                "model": "ignored-model",
                "prompt": "a cat playing piano",
                "image": "https://img.example/cat.png",
                "duration": "5",
                "negative_prompt": "blurry"
            }"#,
        )
        .unwrap();

        assert_eq!(task_req.model, "kling-v2-master");
        assert_eq!(task_req.prompt, "a cat playing piano");
        let metadata = task_req.metadata.as_ref().unwrap();
        assert_eq!(metadata["image"], "https://img.example/cat.png");
        assert_eq!(metadata["negative_prompt"], "blurry");

        let unified: serde_json::Value = serde_json::from_slice(&unified_body).unwrap();
        assert_eq!(unified["model"], "kling-v2-master");
        assert_eq!(unified["prompt"], "a cat playing piano");
        assert_eq!(unified["metadata"]["model_name"], "kling-v2-master");
        assert_eq!(unified["metadata"]["model"], "ignored-model");
    }

    #[test]
    fn kling_submit_action_follows_official_text_and_image_modes() {
        let text_req = TaskSubmitReq {
            prompt: "text only".to_string(),
            model: "kling-v1".to_string(),
            ..Default::default()
        };
        assert_eq!(kling_submit_action(&text_req), TASK_ACTION_TEXT_GENERATE);

        let image_req = TaskSubmitReq {
            prompt: "image".to_string(),
            model: "kling-v1".to_string(),
            image: "https://img.example/seed.png".to_string(),
            ..Default::default()
        };
        assert_eq!(kling_submit_action(&image_req), TASK_ACTION_GENERATE);

        let image_tail_req = TaskSubmitReq {
            prompt: "tail".to_string(),
            model: "kling-v1".to_string(),
            metadata: Some(serde_json::json!({"image_tail": "https://img.example/tail.png"})),
            ..Default::default()
        };
        assert_eq!(kling_submit_action(&image_tail_req), TASK_ACTION_GENERATE);
    }

    #[test]
    fn jimeng_official_body_wraps_req_key_prompt_and_metadata() {
        let (task_req, unified_body) = jimeng_official_task_submit_body(
            br#"{
                "req_key": "jimeng_vgfm_t2v_l20",
                "prompt": "a city timelapse",
                "binary_data_base64": ["QUJD"],
                "duration": 10
            }"#,
        )
        .unwrap();

        assert_eq!(task_req.model, "jimeng_vgfm_t2v_l20");
        assert_eq!(task_req.prompt, "a city timelapse");
        let metadata = task_req.metadata.as_ref().unwrap();
        assert_eq!(metadata["binary_data_base64"], serde_json::json!(["QUJD"]));
        assert_eq!(metadata["duration"], 10);

        let unified: serde_json::Value = serde_json::from_slice(&unified_body).unwrap();
        assert_eq!(unified["model"], "jimeng_vgfm_t2v_l20");
        assert_eq!(unified["prompt"], "a city timelapse");
        assert_eq!(unified["metadata"]["req_key"], "jimeng_vgfm_t2v_l20");

        assert_eq!(
            jimeng_official_task_submit_body(b"not json").unwrap_err(),
            "Invalid request body"
        );
    }

    #[test]
    fn jimeng_official_fetch_task_id_requires_task_id() {
        assert_eq!(
            jimeng_official_fetch_task_id(br#"{"task_id":"task_abc"}"#).unwrap(),
            "task_abc"
        );
        assert_eq!(
            jimeng_official_fetch_task_id(br#"{"task_id":" "}"#).unwrap_err(),
            "task_id is required for CVSync2AsyncGetResult"
        );
        assert_eq!(
            jimeng_official_fetch_task_id(b"not json").unwrap_err(),
            "Invalid request body"
        );
    }

    #[test]
    fn jimeng_submit_action_matches_go_image_field_rule() {
        let text_req = TaskSubmitReq {
            metadata: Some(serde_json::json!({"prompt": "text only"})),
            ..Default::default()
        };
        assert_eq!(jimeng_submit_action(&text_req), TASK_ACTION_TEXT_GENERATE);

        let image_req = TaskSubmitReq {
            metadata: Some(serde_json::json!({"image": "https://img.example/seed.png"})),
            ..Default::default()
        };
        assert_eq!(jimeng_submit_action(&image_req), TASK_ACTION_GENERATE);

        let empty_image_req = TaskSubmitReq {
            metadata: Some(serde_json::json!({"image": ""})),
            ..Default::default()
        };
        assert_eq!(
            jimeng_submit_action(&empty_image_req),
            TASK_ACTION_TEXT_GENERATE
        );
    }

    #[test]
    fn active_session_video_user_requires_existing_enabled_user() {
        let enabled = admin_user_row(42, USER_STATUS_ENABLED);
        assert_eq!(active_session_video_user_id(Some(&enabled)), Ok(42));
        assert_eq!(
            active_session_video_user_id(None),
            Err(VideoContentSessionAuthError::MissingUser)
        );

        let disabled = admin_user_row(42, cinatoken_auth::USER_STATUS_DISABLED);
        assert_eq!(
            active_session_video_user_id(Some(&disabled)),
            Err(VideoContentSessionAuthError::DisabledUser)
        );
    }

    #[test]
    fn remix_origin_model_prefers_origin_then_upstream_then_data_then_request() {
        let row = task_row();
        assert_eq!(remix_origin_model(&row, "request-model"), "sora-2");

        let mut row = task_row();
        row.properties = r#"{"upstream_model_name":"sora-upstream"}"#.to_string();
        assert_eq!(remix_origin_model(&row, "request-model"), "sora-upstream");

        row.properties = "{}".to_string();
        row.data = serde_json::json!({"model": "sora-data"}).to_string();
        assert_eq!(remix_origin_model(&row, "request-model"), "sora-data");

        row.data = "{}".to_string();
        assert_eq!(remix_origin_model(&row, "request-model"), "request-model");
    }

    #[test]
    fn remix_billing_ratios_follow_origin_task_data() {
        let mut row = task_row();
        row.data = serde_json::json!({
            "seconds": "8",
            "size": "1792x1024"
        })
        .to_string();
        assert_eq!(remix_billing_ratios_from_origin(&row), vec![8.0, 1.666667]);
        assert_eq!(
            apply_other_ratios(100, &remix_billing_ratios_from_origin(&row)),
            1333
        );

        row.data = serde_json::json!({
            "seconds": 0,
            "size": "720x1280"
        })
        .to_string();
        assert_eq!(remix_billing_ratios_from_origin(&row), vec![4.0, 1.0]);
    }

    #[test]
    fn openai_video_submit_json_is_queued_shell() {
        let video = openai_video_submit_json("task_1", "sora-2", 123);
        assert_eq!(video["id"], "task_1");
        assert_eq!(video["object"], "video");
        assert_eq!(video["model"], "sora-2");
        assert_eq!(video["status"], "queued");
        assert_eq!(video["progress"], 0);
        assert_eq!(video["created_at"], 123);
        assert!(video.get("completed_at").is_none());
    }

    #[test]
    fn openai_video_json_maps_task_row_to_video_shape() {
        let video = openai_video_json(&task_row());
        assert_eq!(video["id"], "task_video");
        assert_eq!(video["object"], "video");
        assert_eq!(video["model"], "sora-2");
        assert_eq!(video["status"], "completed");
        assert_eq!(video["progress"], 45);
        assert_eq!(video["created_at"], 100);
        assert_eq!(video["completed_at"], 150);
        assert_eq!(video["metadata"]["url"], "https://cdn.example/video.mp4");
    }

    #[test]
    fn openai_video_json_falls_back_to_platform_and_error() {
        let mut row = task_row();
        row.status = "FAILURE".to_string();
        row.fail_reason = "upstream rejected request".to_string();
        row.finish_time = 0;
        row.progress = "not-a-percent".to_string();
        row.properties = "{}".to_string();
        row.private_data = "{}".to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["model"], "sora");
        assert_eq!(video["status"], "failed");
        assert_eq!(video["progress"], 0);
        assert!(video.get("completed_at").is_none());
        assert_eq!(video["metadata"]["url"], "upstream rejected request");
        assert_eq!(video["error"]["message"], "upstream rejected request");
        assert_eq!(video["error"]["code"], "task_failed");
    }

    #[test]
    fn openai_video_json_enriches_from_sora_data() {
        let mut row = task_row();
        row.status = "SUBMITTED".to_string();
        row.progress = String::new();
        row.finish_time = 0;
        row.properties = "{}".to_string();
        row.private_data = "{}".to_string();
        row.data = serde_json::json!({
            "id": "upstream_vid",
            "object": "video",
            "model": "sora-2",
            "status": "queued",
            "progress": 37,
            "created_at": 101,
            "expires_at": 999,
            "seconds": "4",
            "size": "720x1280",
            "remixed_from_video_id": "task_origin"
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["id"], "task_video");
        assert_eq!(video["model"], "sora-2");
        assert_eq!(video["status"], "queued");
        assert_eq!(video["progress"], 37);
        assert_eq!(video["created_at"], 101);
        assert_eq!(video["expires_at"], 999);
        assert_eq!(video["seconds"], "4");
        assert_eq!(video["size"], "720x1280");
        assert_eq!(video["remixed_from_video_id"], "task_origin");
    }

    #[test]
    fn openai_video_json_uses_provider_data_url_when_private_url_absent() {
        let mut row = task_row();
        row.private_data = "{}".to_string();
        row.fail_reason = String::new();
        row.data = serde_json::json!({
            "content": {
                "video_url": "https://provider.example/doubao.mp4"
            }
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(
            video["metadata"]["url"],
            "https://provider.example/doubao.mp4"
        );
    }

    #[test]
    fn openai_video_json_extracts_first_nested_provider_video_url() {
        let mut row = task_row();
        row.private_data = "{}".to_string();
        row.fail_reason = String::new();
        row.data = serde_json::json!({
            "data": {
                "task_result": {
                    "videos": [
                        {"url": "https://provider.example/kling-first.mp4"},
                        {"url": "https://provider.example/kling-second.mp4"}
                    ]
                }
            }
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(
            video["metadata"]["url"],
            "https://provider.example/kling-first.mp4"
        );
    }

    #[test]
    fn video_content_source_requires_completed_task() {
        let mut row = task_row();
        row.status = "IN_PROGRESS".to_string();

        assert_eq!(
            video_content_source_url(&row),
            Err(VideoContentSourceError::NotCompleted(
                "IN_PROGRESS".to_string()
            ))
        );
    }

    #[test]
    fn video_content_source_uses_private_result_url_and_legacy_fail_reason() {
        let mut row = task_row();
        assert_eq!(
            video_content_source_url(&row).unwrap(),
            "https://cdn.example/video.mp4"
        );

        row.private_data = "{}".to_string();
        row.fail_reason = "https://legacy.example/video.mp4".to_string();
        assert_eq!(
            video_content_source_url(&row).unwrap(),
            "https://legacy.example/video.mp4"
        );
    }

    #[test]
    fn video_content_source_skips_self_proxy_and_uses_provider_data_url() {
        let mut row = task_row();
        row.private_data =
            r#"{"result_url":"https://api.example/v1/videos/task_video/content"}"#.to_string();
        row.data = serde_json::json!({
            "content": {
                "video_url": "https://provider.example/video.mp4"
            }
        })
        .to_string();

        assert_eq!(
            video_content_source_url(&row).unwrap(),
            "https://provider.example/video.mp4"
        );
    }

    #[test]
    fn video_proxy_redirect_policy_is_fail_closed() {
        assert!(matches!(
            VIDEO_PROXY_REDIRECT_POLICY,
            RequestRedirect::Error
        ));
    }

    #[test]
    fn vertex_video_content_source_builds_data_url_from_stored_response() {
        let mut row = task_row();
        row.platform = "41".to_string();
        row.private_data = "{}".to_string();
        row.data = serde_json::json!({
            "response": {
                "videos": [
                    {
                        "bytesBase64Encoded": "aGVsbG8=",
                        "mimeType": "video/webm"
                    }
                ]
            }
        })
        .to_string();

        assert_eq!(
            video_content_source_url(&row).unwrap(),
            "data:video/webm;base64,aGVsbG8="
        );
    }

    #[test]
    fn decode_video_data_url_accepts_standard_and_no_pad_base64() {
        let (mime, bytes) = decode_video_data_url("data:video/mp4;base64,aGk=", 16).unwrap();
        assert_eq!(mime, "video/mp4");
        assert_eq!(bytes, b"hi");

        let (mime, bytes) = decode_video_data_url("data:;base64,aGk", 16).unwrap();
        assert_eq!(mime, "video/mp4");
        assert_eq!(bytes, b"hi");
    }

    #[test]
    fn decode_video_data_url_rejects_non_base64_and_oversize_payloads() {
        assert_eq!(
            decode_video_data_url("data:video/mp4,hello", 16),
            Err(VideoDataUrlError::Unsupported)
        );
        assert_eq!(
            decode_video_data_url("data:video/mp4;base64,aGVsbG8=", 2),
            Err(VideoDataUrlError::TooLarge)
        );
    }

    #[test]
    fn openai_video_json_keeps_local_created_at_for_provider_data() {
        let mut row = task_row();
        row.platform = "17".to_string();
        row.properties = "{}".to_string();
        row.private_data = "{}".to_string();
        row.data = serde_json::json!({
            "created_at": 999,
            "output": {
                "video_url": "https://provider.example/ali.mp4"
            }
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["created_at"], 100);
        assert_eq!(video["metadata"]["url"], "https://provider.example/ali.mp4");
    }

    #[test]
    fn openai_video_json_applies_ali_status_and_error_mapping() {
        let mut row = task_row();
        row.platform = "17".to_string();
        row.status = "SUCCESS".to_string();
        row.private_data = "{}".to_string();
        row.data = serde_json::json!({
            "output": {
                "task_status": "FAILED",
                "video_url": "https://provider.example/ali.mp4",
                "code": "ALI_FAILED",
                "message": "ali rejected"
            }
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["status"], "failed");
        assert_eq!(video["completed_at"], 110);
        assert_eq!(video["metadata"]["url"], "https://provider.example/ali.mp4");
        assert_eq!(video["error"]["message"], "ali rejected");
        assert_eq!(video["error"]["code"], "ALI_FAILED");
    }

    #[test]
    fn openai_video_json_applies_kling_provider_times_seconds_and_error() {
        let mut row = task_row();
        row.platform = "50".to_string();
        row.status = "FAILURE".to_string();
        row.private_data = "{}".to_string();
        row.data = serde_json::json!({
            "data": {
                "created_at": 1000,
                "updated_at": 1100,
                "task_status": "failed",
                "task_status_msg": "kling failed",
                "task_result": {
                    "videos": [
                        {
                            "url": "https://provider.example/kling.mp4",
                            "duration": "8"
                        }
                    ]
                }
            }
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["created_at"], 1000);
        assert_eq!(video["completed_at"], 1100);
        assert_eq!(video["seconds"], "8");
        assert_eq!(
            video["metadata"]["url"],
            "https://provider.example/kling.mp4"
        );
        assert_eq!(video["error"]["message"], "kling failed");
        assert_eq!(video["error"]["code"], "");
    }

    #[test]
    fn openai_video_json_extracts_veo_model_from_encoded_operation_name() {
        let mut row = task_row();
        row.platform = "24".to_string();
        row.status = "IN_PROGRESS".to_string();
        row.finish_time = 0;
        let upstream_task_id = cinatoken_tasks::taskcommon::encode_local_task_id(
            "projects/proj/locations/us-central1/publishers/google/models/veo-3.1-generate-preview/operations/op123",
        );
        row.private_data = serde_json::json!({
            "upstream_task_id": upstream_task_id
        })
        .to_string();

        let video = openai_video_json(&row);
        assert_eq!(video["model"], "veo-3.1-generate-preview");
        assert_eq!(video["status"], "in_progress");
        assert_eq!(video["completed_at"], 110);
    }
}
