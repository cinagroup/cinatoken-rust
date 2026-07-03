//! Codex-specific channel admin operations.
//!
//! The Go gateway exposes these as small, synchronous admin actions. The Worker
//! port keeps the same bounded shape: one usage request, and at most one OAuth
//! refresh + retry, with explicit outbound timeouts and response-size caps.

use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use cinatoken_session::SessionClaims;
use futures_util::future::{select, Either};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use url::form_urlencoded;
use wasm_bindgen::JsValue;
use worker::{
    AbortController, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{admin_audit_info, envelope_error_response, require_admin_auth, unix_timestamp};
use crate::cache_invalidation::invalidate_channel_cache;
use crate::d1_repositories::{self, ChannelRow};

const CHANNEL_TYPE_CODEX: i32 = 57;
const CODEX_DEFAULT_BASE_URL: &str = "https://chatgpt.com";
const CODEX_USAGE_PATH: &str = "/backend-api/wham/usage";
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_JWT_AUTH_CLAIM: &str = "https://api.openai.com/auth";
const CODEX_JWT_ACCOUNT_FLAT_CLAIM: &str = "https://api.openai.com/auth.chatgpt_account_id";
const OUTBOUND_TIMEOUT: Duration = Duration::from_secs(15);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(10);
const USAGE_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const TOKEN_BODY_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct CodexAdminError {
    status: u16,
    message: String,
}

impl CodexAdminError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(502, message)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct CodexOAuthKey {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    id_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    access_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    refresh_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    account_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    last_refresh: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    email: String,
    #[serde(default, rename = "type", skip_serializing_if = "String::is_empty")]
    key_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    expired: String,
}

#[derive(Debug)]
struct CodexUsageFetch {
    upstream_status: u16,
    data: Value,
}

#[derive(Debug, Deserialize)]
struct CodexOAuthRefresh {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_in: i64,
}

#[derive(Debug)]
struct RefreshedCodexCredential {
    key: CodexOAuthKey,
    encoded_key: String,
    last_refresh: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct CodexUsageResponse {
    success: bool,
    message: String,
    upstream_status: u16,
    data: Value,
}

#[derive(Debug, Serialize)]
struct CodexCredentialRefreshResponse {
    success: bool,
    message: &'static str,
    data: CodexCredentialRefreshData,
}

#[derive(Debug, Serialize)]
struct CodexCredentialRefreshData {
    expires_at: String,
    last_refresh: String,
    account_id: String,
    email: String,
    channel_id: i64,
    channel_type: i32,
    channel_name: String,
}

/// `GET /api/channel/:id/codex/usage`: fetch Codex WHAM usage for a Codex
/// channel. A stale access token is refreshed once when the upstream responds
/// 401/403 and the stored key has a refresh token.
pub async fn get_usage(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_channel_id(id_param) {
        Ok(id) => id,
        Err(error) => return Ok(error_response(error)),
    };

    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    if let Err(error) = ensure_codex_channel(&channel) {
        return Ok(error_response(error));
    }
    let mut oauth = match parse_oauth_key(&channel.key) {
        Ok(oauth) => oauth,
        Err(error) => return Ok(error_response(error)),
    };
    if oauth.access_token.is_empty() {
        return Ok(envelope_error_response(
            422,
            "Codex access token is missing",
        ));
    }
    if oauth.account_id.is_empty() {
        return Ok(envelope_error_response(422, "Codex account_id is missing"));
    }

    let base_url = channel_base_url(&channel);
    let mut usage = match fetch_codex_usage(&base_url, &oauth.access_token, &oauth.account_id).await
    {
        Ok(usage) => usage,
        Err(error) => return Ok(error_response(error)),
    };

    if matches!(usage.upstream_status, 401 | 403) && !oauth.refresh_token.is_empty() {
        match refresh_and_persist(
            &db,
            &env,
            &req,
            &claims,
            &channel,
            oauth.clone(),
            "usage_auto_refresh",
        )
        .await
        {
            Ok(Ok(refreshed)) => {
                oauth = refreshed.key;
                if !oauth.access_token.is_empty() && !oauth.account_id.is_empty() {
                    usage =
                        match fetch_codex_usage(&base_url, &oauth.access_token, &oauth.account_id)
                            .await
                        {
                            Ok(usage) => usage,
                            Err(error) => return Ok(error_response(error)),
                        };
                }
            }
            Ok(Err(error)) => worker::console_warn!(
                "codex usage auto-refresh failed for channel {}: {}",
                channel.id,
                error.message
            ),
            Err(err) => worker::console_warn!(
                "codex usage auto-refresh failed for channel {}: {}",
                channel.id,
                err
            ),
        }
    }

    codex_usage_response(usage)
}

/// `POST /api/channel/:id/codex/refresh`: manually refresh a Codex OAuth key.
pub async fn refresh_credential(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_channel_id(id_param) {
        Ok(id) => id,
        Err(error) => return Ok(error_response(error)),
    };

    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    if let Err(error) = ensure_codex_channel(&channel) {
        return Ok(error_response(error));
    }
    let oauth = match parse_oauth_key(&channel.key) {
        Ok(oauth) => oauth,
        Err(error) => return Ok(error_response(error)),
    };
    if oauth.refresh_token.is_empty() {
        return Ok(envelope_error_response(
            422,
            "Codex refresh token is missing",
        ));
    }

    let refreshed =
        match refresh_and_persist(&db, &env, &req, &claims, &channel, oauth, "manual").await? {
            Ok(refreshed) => refreshed,
            Err(error) => return Ok(error_response(error)),
        };

    let mut response = Response::from_json(&CodexCredentialRefreshResponse {
        success: true,
        message: "refreshed",
        data: CodexCredentialRefreshData {
            expires_at: refreshed.expires_at,
            last_refresh: refreshed.last_refresh,
            account_id: refreshed.key.account_id,
            email: refreshed.key.email,
            channel_id: channel.id,
            channel_type: channel.kind,
            channel_name: channel.name,
        },
    })?
    .with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

async fn refresh_and_persist(
    db: &D1Database,
    env: &Env,
    req: &Request,
    claims: &SessionClaims,
    channel: &ChannelRow,
    current: CodexOAuthKey,
    reason: &'static str,
) -> WorkerResult<Result<RefreshedCodexCredential, CodexAdminError>> {
    let refresh = match refresh_codex_oauth_token(&current.refresh_token).await {
        Ok(refresh) => refresh,
        Err(error) => return Ok(Err(error)),
    };
    let refreshed = match build_refreshed_oauth_key(current, refresh) {
        Ok(refreshed) => refreshed,
        Err(error) => return Ok(Err(error)),
    };
    let changed = d1_repositories::update_channel_key_if_current(
        db,
        channel.id,
        &channel.key,
        &refreshed.encoded_key,
    )
    .await?;
    if !changed {
        return Ok(Err(CodexAdminError::new(
            409,
            "channel changed during Codex credential refresh",
        )));
    }
    if let Err(err) = invalidate_channel_cache(env).await {
        worker::console_warn!(
            "codex credential refresh cache invalidation failed for channel {}: {}",
            channel.id,
            err
        );
    }
    let now = unix_timestamp();
    let _ = d1_repositories::insert_admin_audit_log(
        db,
        None,
        None,
        &claims.username,
        "channel.codex_refresh",
        &format!(
            "admin {} refreshed Codex channel {}",
            claims.username, channel.id
        ),
        &json!({
            "id": channel.id,
            "type": channel.kind,
            "reason": reason,
            "account_id_present": !refreshed.key.account_id.is_empty(),
            "email_present": !refreshed.key.email.is_empty()
        }),
        &admin_audit_info(claims, req),
        now,
    )
    .await;

    Ok(Ok(refreshed))
}

fn build_refreshed_oauth_key(
    current: CodexOAuthKey,
    refresh: CodexOAuthRefresh,
) -> Result<RefreshedCodexCredential, CodexAdminError> {
    if refresh.access_token.trim().is_empty() {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response is missing access_token",
        ));
    }
    if refresh.refresh_token.trim().is_empty() {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response is missing refresh_token",
        ));
    }
    if refresh.expires_in <= 0 {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response has invalid expires_in",
        ));
    }
    let now_ms = js_sys::Date::now();
    let last_refresh = iso_timestamp(now_ms)?;
    let expires_at = iso_timestamp(now_ms + (refresh.expires_in as f64 * 1000.0))?;
    build_refreshed_oauth_key_at(current, refresh, last_refresh, expires_at)
}

fn build_refreshed_oauth_key_at(
    mut current: CodexOAuthKey,
    refresh: CodexOAuthRefresh,
    last_refresh: String,
    expires_at: String,
) -> Result<RefreshedCodexCredential, CodexAdminError> {
    current.access_token = refresh.access_token.trim().to_string();
    current.refresh_token = refresh.refresh_token.trim().to_string();
    current.last_refresh = last_refresh.clone();
    current.expired = expires_at.clone();
    if current.key_type.trim().is_empty() {
        current.key_type = "codex".to_string();
    } else {
        current.key_type = current.key_type.trim().to_string();
    }
    if current.account_id.trim().is_empty() {
        current.account_id = extract_account_id_from_jwt(&current.access_token).unwrap_or_default();
    } else {
        current.account_id = current.account_id.trim().to_string();
    }
    if current.email.trim().is_empty() {
        current.email = extract_email_from_jwt(&current.access_token).unwrap_or_default();
    } else {
        current.email = current.email.trim().to_string();
    }
    current.id_token = current.id_token.trim().to_string();

    let encoded_key = serde_json::to_string(&current)
        .map_err(|err| CodexAdminError::new(500, format!("failed to encode Codex key: {err}")))?;
    Ok(RefreshedCodexCredential {
        key: current,
        encoded_key,
        last_refresh,
        expires_at,
    })
}

async fn fetch_codex_usage(
    base_url: &str,
    access_token: &str,
    account_id: &str,
) -> Result<CodexUsageFetch, CodexAdminError> {
    let url = codex_usage_url(base_url)?;
    let mut headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {access_token}"))
        .map_err(|_| CodexAdminError::new(422, "Codex access token is invalid for HTTP headers"))?;
    headers
        .set("chatgpt-account-id", account_id)
        .map_err(|_| CodexAdminError::new(422, "Codex account_id is invalid for HTTP headers"))?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex usage request"))?;
    headers
        .set("originator", "codex_cli_rs")
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex usage request"))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(&url, &init)
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex usage request"))?;
    let mut response = send_with_timeout(request, OUTBOUND_TIMEOUT, "Codex usage").await?;
    let upstream_status = response.status_code();
    let bytes = read_limited_body(
        &mut response,
        USAGE_BODY_LIMIT_BYTES,
        "Codex usage response",
    )
    .await?;
    Ok(CodexUsageFetch {
        upstream_status,
        data: payload_from_bytes(&bytes),
    })
}

async fn refresh_codex_oauth_token(
    refresh_token: &str,
) -> Result<CodexOAuthRefresh, CodexAdminError> {
    let body = form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("refresh_token", refresh_token)
        .append_pair("client_id", CODEX_OAUTH_CLIENT_ID)
        .finish();
    let mut headers = Headers::new();
    headers
        .set("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex OAuth request"))?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex OAuth request"))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)))
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(CODEX_OAUTH_TOKEN_URL, &init)
        .map_err(|_| CodexAdminError::bad_gateway("failed to build Codex OAuth request"))?;
    let mut response = send_with_timeout(request, REFRESH_TIMEOUT, "Codex OAuth refresh").await?;
    let status = response.status_code();
    ensure_json_response(&response, "Codex OAuth refresh response")?;
    let bytes = read_limited_body(
        &mut response,
        TOKEN_BODY_LIMIT_BYTES,
        "Codex OAuth refresh response",
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(CodexAdminError::bad_gateway(format!(
            "Codex OAuth refresh failed: status={status}"
        )));
    }
    let refresh = serde_json::from_slice::<CodexOAuthRefresh>(&bytes).map_err(|_| {
        CodexAdminError::bad_gateway("Codex OAuth refresh response is not valid JSON")
    })?;
    if refresh.access_token.trim().is_empty() {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response is missing access_token",
        ));
    }
    if refresh.refresh_token.trim().is_empty() {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response is missing refresh_token",
        ));
    }
    if refresh.expires_in <= 0 {
        return Err(CodexAdminError::bad_gateway(
            "Codex OAuth refresh response has invalid expires_in",
        ));
    }
    Ok(refresh)
}

async fn send_with_timeout(
    request: Request,
    timeout: Duration,
    label: &str,
) -> Result<Response, CodexAdminError> {
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(timeout);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|_| CodexAdminError::bad_gateway(format!("{label} request failed")))
        }
        Either::Right(((), _)) => {
            controller.abort();
            Err(CodexAdminError::bad_gateway(format!(
                "{label} request timed out"
            )))
        }
    }
}

async fn read_limited_body(
    response: &mut Response,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>, CodexAdminError> {
    if let Some(content_length) = response_content_length(response, label)? {
        if content_length > limit {
            return Err(CodexAdminError::bad_gateway(format!(
                "{label} exceeds {limit} byte limit"
            )));
        }
    }
    let mut stream = response
        .stream()
        .map_err(|_| CodexAdminError::bad_gateway(format!("failed to read {label}")))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| CodexAdminError::bad_gateway(format!("failed to read {label}")))?;
        let next_len = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| CodexAdminError::bad_gateway(format!("{label} is too large")))?;
        if next_len > limit {
            return Err(CodexAdminError::bad_gateway(format!(
                "{label} exceeds {limit} byte limit"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn response_content_length(
    response: &Response,
    label: &str,
) -> Result<Option<usize>, CodexAdminError> {
    let Some(raw) = response
        .headers()
        .get("content-length")
        .map_err(|_| CodexAdminError::bad_gateway(format!("failed to inspect {label} headers")))?
    else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    raw.parse::<usize>()
        .map(Some)
        .map_err(|_| CodexAdminError::bad_gateway(format!("{label} content-length is invalid")))
}

fn ensure_json_response(response: &Response, label: &str) -> Result<(), CodexAdminError> {
    let content_type = response
        .headers()
        .get("content-type")
        .map_err(|_| CodexAdminError::bad_gateway(format!("failed to inspect {label} headers")))?;
    if let Some(content_type) = content_type {
        let media_type = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if media_type != "application/json"
            && !(media_type.starts_with("application/") && media_type.ends_with("+json"))
        {
            return Err(CodexAdminError::bad_gateway(format!("{label} is not JSON")));
        }
    }
    Ok(())
}

fn payload_from_bytes(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).to_string()))
}

fn codex_usage_url(base_url: &str) -> Result<String, CodexAdminError> {
    let raw = format!("{}{}", base_url.trim_end_matches('/'), CODEX_USAGE_PATH);
    validate_codex_outbound_url(&raw)?;
    Ok(raw)
}

fn validate_codex_outbound_url(raw: &str) -> Result<(), CodexAdminError> {
    let parsed =
        worker::Url::parse(raw).map_err(|_| CodexAdminError::new(422, "Codex URL is invalid"))?;
    if parsed.scheme() != "https" {
        return Err(CodexAdminError::new(422, "Codex URL scheme must be https"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CodexAdminError::new(
            422,
            "Codex URL must not contain credentials",
        ));
    }
    if parsed.fragment().is_some() {
        return Err(CodexAdminError::new(
            422,
            "Codex URL must not contain a fragment",
        ));
    }
    if parsed.query().is_some() {
        return Err(CodexAdminError::new(
            422,
            "Codex URL must not contain a query",
        ));
    }
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| CodexAdminError::new(422, "Codex URL port is invalid"))?;
    if port != 443 {
        return Err(CodexAdminError::new(422, "Codex URL port is not allowed"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| CodexAdminError::new(422, "Codex URL is missing a host"))?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "localhost" | "metadata.google.internal" | "metadata.internal"
    ) || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(CodexAdminError::new(422, "Codex URL host is not allowed"));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let message = if is_private_or_special_ip(ip) {
            "Codex URL IP address is not allowed"
        } else {
            "Codex URL literal IP address is not allowed"
        };
        return Err(CodexAdminError::new(422, message));
    }
    Ok(())
}

fn is_private_or_special_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_or_special_ipv4(ip),
        IpAddr::V6(ip) => is_private_or_special_ipv6(ip),
    }
}

fn is_private_or_special_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && matches!(c, 0 | 2))
        || (a == 192 && b == 168)
        || (a == 198 && matches!(b, 18 | 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn is_private_or_special_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4() {
        return is_private_or_special_ipv4(v4);
    }
    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x64 && segments[1] == 0xff9b)
        || (segments[0] == 0x100 && segments[1] == 0)
        || (segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0)
}

fn ensure_codex_channel(channel: &ChannelRow) -> Result<(), CodexAdminError> {
    if channel.kind != CHANNEL_TYPE_CODEX {
        return Err(CodexAdminError::new(422, "channel type is not Codex"));
    }
    let info = parse_channel_info(&channel.channel_info)?;
    if info
        .get("is_multi_key")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(CodexAdminError::new(
            422,
            "multi-key channel is not supported",
        ));
    }
    ensure_no_proxy_setting(channel)?;
    Ok(())
}

fn ensure_no_proxy_setting(channel: &ChannelRow) -> Result<(), CodexAdminError> {
    let Some(raw) = channel.setting.as_deref() else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return Ok(());
    };
    let proxy = value
        .get("proxy")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !proxy.is_empty() {
        return Err(CodexAdminError::new(
            422,
            "Codex proxy settings are not supported on Cloudflare Workers; use Cloudflare egress/Tunnel or remove the proxy",
        ));
    }
    Ok(())
}

fn parse_channel_info(raw: &str) -> Result<serde_json::Map<String, Value>, CodexAdminError> {
    let value = serde_json::from_str::<Value>(if raw.trim().is_empty() { "{}" } else { raw })
        .map_err(|_| CodexAdminError::new(422, "channel_info is not valid JSON"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| CodexAdminError::new(422, "channel_info must be a JSON object"))
}

fn parse_oauth_key(raw: &str) -> Result<CodexOAuthKey, CodexAdminError> {
    if raw.trim().is_empty() {
        return Err(CodexAdminError::new(422, "Codex key is empty"));
    }
    let value = serde_json::from_str::<Value>(raw.trim())
        .map_err(|_| CodexAdminError::new(422, "Codex key must be a JSON OAuth credential"))?;
    if !value.is_object() {
        return Err(CodexAdminError::new(
            422,
            "Codex key must be a JSON OAuth credential",
        ));
    }
    let mut key = serde_json::from_value::<CodexOAuthKey>(value)
        .map_err(|_| CodexAdminError::new(422, "Codex key must be a JSON OAuth credential"))?;
    trim_oauth_key(&mut key);
    Ok(key)
}

fn trim_oauth_key(key: &mut CodexOAuthKey) {
    key.id_token = key.id_token.trim().to_string();
    key.access_token = key.access_token.trim().to_string();
    key.refresh_token = key.refresh_token.trim().to_string();
    key.account_id = key.account_id.trim().to_string();
    key.last_refresh = key.last_refresh.trim().to_string();
    key.email = key.email.trim().to_string();
    key.key_type = key.key_type.trim().to_string();
    key.expired = key.expired.trim().to_string();
}

fn channel_base_url(channel: &ChannelRow) -> String {
    let base_url = channel.base_url.trim();
    if base_url.is_empty() {
        CODEX_DEFAULT_BASE_URL.to_string()
    } else {
        base_url.to_string()
    }
}

fn parse_channel_id(id_param: Option<&String>) -> Result<i64, CodexAdminError> {
    let Some(id) = id_param.and_then(|value| value.parse::<i64>().ok()) else {
        return Err(CodexAdminError::new(400, "invalid channel id"));
    };
    if id <= 0 || id > i32::MAX as i64 {
        return Err(CodexAdminError::new(400, "invalid channel id"));
    }
    Ok(id)
}

fn codex_usage_response(usage: CodexUsageFetch) -> WorkerResult<Response> {
    let success = (200..300).contains(&usage.upstream_status);
    let message = if success {
        String::new()
    } else {
        format!("upstream status: {}", usage.upstream_status)
    };
    let mut response = Response::from_json(&CodexUsageResponse {
        success,
        message,
        upstream_status: usage.upstream_status,
        data: usage.data,
    })?
    .with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

fn error_response(error: CodexAdminError) -> Response {
    envelope_error_response(error.status, &error.message)
}

fn iso_timestamp(milliseconds: f64) -> Result<String, CodexAdminError> {
    js_sys::Date::new(&JsValue::from_f64(milliseconds))
        .to_iso_string()
        .as_string()
        .ok_or_else(|| CodexAdminError::new(500, "failed to format Codex refresh timestamp"))
}

fn extract_account_id_from_jwt(token: &str) -> Option<String> {
    let payload = jwt_payload_value(token)?;
    payload
        .get(CODEX_JWT_AUTH_CLAIM)
        .and_then(|value| value.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get(CODEX_JWT_ACCOUNT_FLAT_CLAIM)
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_email_from_jwt(token: &str) -> Option<String> {
    jwt_payload_value(token)?
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn jwt_payload_value(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_oauth_key_requires_json_object_and_trims() {
        let key = parse_oauth_key(
            r#"{
                "access_token": " access ",
                "refresh_token": " refresh ",
                "account_id": " acct ",
                "email": " user@example.com ",
                "type": " codex "
            }"#,
        )
        .unwrap();

        assert_eq!(key.access_token, "access");
        assert_eq!(key.refresh_token, "refresh");
        assert_eq!(key.account_id, "acct");
        assert_eq!(key.email, "user@example.com");
        assert_eq!(key.key_type, "codex");
        assert_eq!(parse_oauth_key("").unwrap_err().status, 422);
        assert_eq!(parse_oauth_key("[]").unwrap_err().status, 422);
    }

    #[test]
    fn jwt_claim_extraction_reads_account_and_email() {
        let token = jwt_with_payload(json!({
            CODEX_JWT_AUTH_CLAIM: { "chatgpt_account_id": "acct_nested" },
            "email": "person@example.com"
        }));

        assert_eq!(
            extract_account_id_from_jwt(&token).as_deref(),
            Some("acct_nested")
        );
        assert_eq!(
            extract_email_from_jwt(&token).as_deref(),
            Some("person@example.com")
        );

        let flat_token = jwt_with_payload(json!({
            CODEX_JWT_ACCOUNT_FLAT_CLAIM: "acct_flat"
        }));
        assert_eq!(
            extract_account_id_from_jwt(&flat_token).as_deref(),
            Some("acct_flat")
        );
    }

    #[test]
    fn codex_outbound_url_validation_blocks_ssrf_targets() {
        assert!(validate_codex_outbound_url("https://chatgpt.com/backend-api/wham/usage").is_ok());

        for url in [
            "http://chatgpt.com/backend-api/wham/usage",
            "https://127.0.0.1/backend-api/wham/usage",
            "https://8.8.8.8/backend-api/wham/usage",
            "https://[::1]/backend-api/wham/usage",
            "https://metadata.google.internal/backend-api/wham/usage",
            "https://chatgpt.com:8443/backend-api/wham/usage",
            "https://user:pass@chatgpt.com/backend-api/wham/usage",
            "https://chatgpt.com/backend-api/wham/usage?redirect=1",
        ] {
            assert!(
                validate_codex_outbound_url(url).is_err(),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn proxy_setting_is_explicitly_rejected() {
        let channel = sample_codex_channel_with_setting(Some(
            r#"{"proxy":"http://127.0.0.1:8080"}"#.to_string(),
        ));

        let err = ensure_no_proxy_setting(&channel).unwrap_err();
        assert_eq!(err.status, 422);
        assert!(err.message.contains("proxy settings are not supported"));
    }

    #[test]
    fn refreshed_key_preserves_existing_identity() {
        let token = jwt_with_payload(json!({
            CODEX_JWT_AUTH_CLAIM: { "chatgpt_account_id": "acct_new" },
            "email": "new@example.com"
        }));
        let refreshed = build_refreshed_oauth_key_at(
            CodexOAuthKey {
                refresh_token: "old_refresh".to_string(),
                account_id: "acct_existing".to_string(),
                email: "existing@example.com".to_string(),
                ..Default::default()
            },
            CodexOAuthRefresh {
                access_token: token,
                refresh_token: "new_refresh".to_string(),
                expires_in: 3600,
            },
            "2026-01-02T03:04:05.000Z".to_string(),
            "2026-01-02T04:04:05.000Z".to_string(),
        )
        .unwrap();

        assert_eq!(refreshed.key.account_id, "acct_existing");
        assert_eq!(refreshed.key.email, "existing@example.com");
        assert_eq!(refreshed.key.key_type, "codex");
        assert!(refreshed.encoded_key.contains("\"access_token\""));
        assert!(refreshed.encoded_key.contains("\"refresh_token\""));
    }

    fn jwt_with_payload(payload: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(payload.to_string());
        format!("{header}.{payload}.sig")
    }

    fn sample_codex_channel_with_setting(setting: Option<String>) -> ChannelRow {
        ChannelRow {
            id: 1,
            kind: CHANNEL_TYPE_CODEX,
            key: "{}".to_string(),
            openai_organization: None,
            test_model: None,
            status: 1,
            name: "codex".to_string(),
            weight: 1,
            created_time: 0,
            test_time: 0,
            response_time: 0,
            base_url: CODEX_DEFAULT_BASE_URL.to_string(),
            other: String::new(),
            balance: 0.0,
            balance_updated_time: 0,
            models: String::new(),
            channel_group: "default".to_string(),
            used_quota: 0,
            model_mapping: None,
            status_code_mapping: String::new(),
            priority: 0,
            auto_ban: 1,
            other_info: String::new(),
            tag: None,
            setting,
            param_override: None,
            header_override: None,
            remark: None,
            channel_info: "{}".to_string(),
            settings: String::new(),
        }
    }
}
