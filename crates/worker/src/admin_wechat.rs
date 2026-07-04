//! WeChat QR/code login and account binding.
//!
//! Go delegates the QR-code verification step to an operator-managed WeChat
//! server (`WeChatServerAddress` + `WeChatServerToken`). This Worker port keeps
//! the same external contract but validates that the configured server is a
//! public HTTPS endpoint before sending the authorization token from the edge.

use cinatoken_auth::USER_STATUS_DISABLED;
use cinatoken_session::SessionClaims;
use cinatoken_ssrf::SsrfPolicy;
use futures_util::future::{select, Either};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use worker::Result as WorkerResult;
use worker::{
    AbortController, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response,
};

use crate::admin::{
    attach_session_cookie, envelope_error_response, envelope_ok_response, read_json_body,
    require_user_auth, session_codec, unix_timestamp,
};
use crate::d1_repositories::{self, AdminUserRow};

const WECHAT_CONFIG_KEYS: &[&str] = &[
    "WeChatAuthEnabled",
    "RegisterEnabled",
    "WeChatServerAddress",
    "WeChatServerToken",
    "QuotaForNewUser",
];
const WECHAT_SERVER_TIMEOUT: Duration = Duration::from_secs(5);

/// `GET /api/oauth/wechat?code=...`: verify the code through the configured
/// WeChat server, find-or-create the local account, and issue a session cookie.
pub async fn wechat_auth(req: Request, env: Env) -> WorkerResult<Response> {
    let code = query_param(&req, "code").unwrap_or_default();
    if code.trim().is_empty() {
        return Ok(envelope_error_response(200, "invalid parameters"));
    }

    let db = env.d1("DB")?;
    let config = read_wechat_config(&db).await?;
    if !config.enabled {
        return Ok(envelope_error_response(
            200,
            "WeChat login and registration are not enabled by the administrator",
        ));
    }
    let wechat_id = match fetch_wechat_id_by_code(&config, &code).await? {
        Ok(wechat_id) => wechat_id,
        Err(message) => return Ok(envelope_error_response(200, &message)),
    };

    let user = if d1_repositories::wechat_id_exists_any_status(&db, &wechat_id).await? {
        match d1_repositories::find_user_by_wechat_id(&db, &wechat_id).await? {
            Some(user) => user,
            None => return Ok(envelope_error_response(200, "user has been deleted")),
        }
    } else {
        if !config.register_enabled {
            return Ok(envelope_error_response(
                200,
                "new user registration has been disabled by the administrator",
            ));
        }
        create_wechat_account(&db, &wechat_id, config.quota_for_new_user).await?
    };

    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(200, "user is disabled"));
    }
    issue_login_response(&env, &db, user).await
}

/// `GET|POST /api/oauth/wechat/bind`: bind a verified WeChat id to the current
/// logged-in user. The Go route is POST JSON; the default React frontend calls
/// GET with `?code=...`, so the Worker accepts both shapes.
pub async fn bind_wechat(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let code = match query_param(&req, "code") {
        Some(code) if !code.trim().is_empty() => code,
        _ => {
            let body = match read_json_body(&mut req).await {
                Ok(body) => body,
                Err(response) => return Ok(response),
            };
            match serde_json::from_value::<WeChatBindRequest>(body) {
                Ok(payload) if !payload.code.trim().is_empty() => payload.code,
                _ => return Ok(envelope_error_response(200, "invalid request")),
            }
        }
    };

    let db = env.d1("DB")?;
    let config = read_wechat_config(&db).await?;
    if !config.enabled {
        return Ok(envelope_error_response(
            200,
            "WeChat login and registration are not enabled by the administrator",
        ));
    }
    let wechat_id = match fetch_wechat_id_by_code(&config, &code).await? {
        Ok(wechat_id) => wechat_id,
        Err(message) => return Ok(envelope_error_response(200, &message)),
    };
    if d1_repositories::wechat_id_exists_any_status(&db, &wechat_id).await? {
        return Ok(envelope_error_response(
            200,
            "this WeChat account is already linked",
        ));
    }
    if !d1_repositories::bind_wechat_id(&db, claims.id, &wechat_id).await? {
        return Ok(envelope_error_response(404, "user not found"));
    }
    envelope_ok_response(&Value::Null)
}

async fn create_wechat_account(
    db: &D1Database,
    wechat_id: &str,
    quota_for_new_user: i64,
) -> WorkerResult<AdminUserRow> {
    let next_id = d1_repositories::max_user_id(db).await?.saturating_add(1);
    let username = format!("wechat_{next_id}");
    let Some(aff_code) = crate::admin_2fa::new_pending_token() else {
        return Err(worker::Error::RustError(
            "failed to provision WeChat account".to_string(),
        ));
    };
    let now = unix_timestamp();
    let id = d1_repositories::create_wechat_user(
        db,
        &username,
        wechat_id,
        "WeChat User",
        &aff_code,
        quota_for_new_user,
        now,
    )
    .await?;
    d1_repositories::find_user_by_id(db, id)
        .await?
        .ok_or_else(|| worker::Error::RustError("failed to load new WeChat account".to_string()))
}

async fn issue_login_response(
    env: &Env,
    db: &D1Database,
    user: AdminUserRow,
) -> WorkerResult<Response> {
    let codec = match session_codec(env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
    let now = unix_timestamp();
    if let Err(err) = d1_repositories::update_last_login_at(db, user.id, now).await {
        worker::console_warn!(
            "failed to update last_login_at for WeChat user {}: {}",
            user.id,
            err
        );
    }
    let claims = SessionClaims {
        id: user.id,
        username: user.username.clone(),
        role: user.role,
        status: user.status,
        group: user.group.clone(),
        exp: 0,
    };
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ))
        }
    };
    let body = LoginResponse {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        status: user.status,
        group: user.group,
    };
    let mut response = envelope_ok_response(&body)?;
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    Ok(response)
}

async fn read_wechat_config(db: &D1Database) -> WorkerResult<WeChatConfig> {
    let values = d1_repositories::option_values(db, WECHAT_CONFIG_KEYS).await?;
    Ok(WeChatConfig {
        enabled: parse_bool_option(values[0].as_deref(), false),
        register_enabled: parse_bool_option(values[1].as_deref(), true),
        server_address: option_string(values[2].as_deref()),
        server_token: option_string(values[3].as_deref()),
        quota_for_new_user: parse_int_option(values[4].as_deref(), 0),
    })
}

async fn fetch_wechat_id_by_code(
    config: &WeChatConfig,
    code: &str,
) -> WorkerResult<Result<String, String>> {
    let url = match wechat_user_url(&config.server_address, code) {
        Ok(url) => url,
        Err(message) => return Ok(Err(message)),
    };
    let mut headers = Headers::new();
    headers.set("Accept", "application/json")?;
    if !config.server_token.trim().is_empty() {
        headers.set("Authorization", config.server_token.trim())?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let outbound = Request::new_with_init(&url, &init)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound_fetch = Fetch::Request(outbound);
    let fetch = outbound_fetch.send_with_signal(&signal);
    let delay = Delay::from(WECHAT_SERVER_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => match result {
            Ok(response) => response,
            Err(err) => return Ok(Err(format!("failed to reach WeChat server: {err}"))),
        },
        Either::Right(((), _)) => {
            controller.abort();
            return Ok(Err("WeChat server request timed out".to_string()));
        }
    };
    let text = response.text().await?;
    Ok(parse_wechat_response(&text))
}

fn parse_wechat_response(text: &str) -> Result<String, String> {
    let response: WeChatLoginResponse = serde_json::from_str(text)
        .map_err(|err| format!("invalid WeChat server response: {err}"))?;
    if !response.success {
        return Err(if response.message.trim().is_empty() {
            "WeChat verification failed".to_string()
        } else {
            response.message
        });
    }
    let wechat_id = response.data.trim();
    if wechat_id.is_empty() {
        return Err("verification code is incorrect or expired".to_string());
    }
    Ok(wechat_id.to_string())
}

fn wechat_user_url(server_address: &str, code: &str) -> Result<String, String> {
    let base = validate_wechat_server_address(server_address)?;
    Ok(format!(
        "{}/api/wechat/user?code={}",
        base,
        url_encode(code.trim())
    ))
}

fn validate_wechat_server_address(server_address: &str) -> Result<String, String> {
    let server_address = server_address.trim();
    if server_address.is_empty() {
        return Err("WeChat server is not configured".to_string());
    }
    let url = SsrfPolicy::strict_default()
        .validate_url(server_address)
        .map_err(|err| format!("invalid WeChat server address: {err}"))?;
    if url.scheme() != "https" {
        return Err("WeChat server address must use HTTPS".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("WeChat server address must not include a query or fragment".to_string());
    }
    Ok(server_address.trim_end_matches('/').to_string())
}

fn parse_bool_option(value: Option<&str>, default: bool) -> bool {
    value
        .map(str::trim)
        .and_then(|value| match value.to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

fn parse_int_option(value: Option<&str>, default: i64) -> i64 {
    value
        .map(str::trim)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(default)
}

fn option_string(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_string()
}

fn query_param(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Debug)]
struct WeChatConfig {
    enabled: bool,
    register_enabled: bool,
    server_address: String,
    server_token: String,
    quota_for_new_user: i64,
}

#[derive(Debug, Deserialize)]
struct WeChatLoginResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: String,
}

#[derive(Debug, Deserialize)]
struct WeChatBindRequest {
    #[serde(default)]
    code: String,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    id: i64,
    username: String,
    display_name: String,
    role: i32,
    status: i32,
    group: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wechat_user_url_requires_https_public_base_and_encodes_code() {
        assert_eq!(
            wechat_user_url("https://wechat.example.com/base/", "a b+c").unwrap(),
            "https://wechat.example.com/base/api/wechat/user?code=a+b%2Bc"
        );
        assert!(validate_wechat_server_address("http://wechat.example.com").is_err());
        assert!(validate_wechat_server_address("https://127.0.0.1").is_err());
        assert!(validate_wechat_server_address("https://wechat.example.com?x=1").is_err());
    }

    #[test]
    fn parses_wechat_server_response_contract() {
        assert_eq!(
            parse_wechat_response(r#"{"success":true,"message":"","data":"wx_123"}"#).unwrap(),
            "wx_123"
        );
        assert_eq!(
            parse_wechat_response(r#"{"success":true,"data":""}"#).unwrap_err(),
            "verification code is incorrect or expired"
        );
        assert_eq!(
            parse_wechat_response(r#"{"success":false,"message":"bad code"}"#).unwrap_err(),
            "bad code"
        );
    }

    #[test]
    fn bool_options_match_existing_status_parser_shape() {
        assert!(parse_bool_option(Some("true"), false));
        assert!(parse_bool_option(Some("1"), false));
        assert!(!parse_bool_option(Some("false"), true));
        assert!(parse_bool_option(Some("garbage"), true));
        assert_eq!(parse_int_option(Some("42"), 0), 42);
        assert_eq!(parse_int_option(Some("bad"), 7), 7);
    }
}
