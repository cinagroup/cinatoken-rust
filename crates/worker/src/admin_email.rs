//! Email verification, email binding, and anonymous password reset routes.
//!
//! Go sends mail over SMTP and stores verification codes in an in-process
//! 10-minute map. Workers cannot open SMTP sockets, so this port uses the
//! Cloudflare Email Service `send_email` binding named `EMAIL`, and stores
//! short-lived codes in the shared `flow_state` KV substrate.

use cinatoken_auth::hash_password;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_user_auth,
};
use crate::{d1_repositories, flow_state, turnstile};

const EMAIL_BINDING: &str = "EMAIL";
const VERIFICATION_VALID_MINUTES: i64 = 10;

pub async fn send_email_verification(req: Request, env: Env) -> WorkerResult<Response> {
    if let Some(response) = turnstile::require_turnstile(&req, &env).await? {
        return Ok(response);
    }
    let email = match query_email(&req).and_then(|email| normalize_email(&email).ok()) {
        Some(email) => email,
        None => return Ok(envelope_error_response(200, "invalid parameters")),
    };
    let db = env.d1("DB")?;
    let options = d1_repositories::option_values(
        &db,
        &[
            "EmailDomainRestrictionEnabled",
            "EmailDomainWhitelist",
            "EmailAliasRestrictionEnabled",
            "SystemName",
            "SMTPFrom",
            "SMTPAccount",
        ],
    )
    .await?;
    if let Err(message) = validate_email_policy(
        &email,
        parse_bool_option(options[0].as_deref(), false),
        options[1].as_deref().unwrap_or(""),
        parse_bool_option(options[2].as_deref(), false),
    ) {
        return Ok(envelope_error_response(200, &message));
    }
    if d1_repositories::email_exists_any_status(&db, &email).await? {
        return Ok(envelope_error_response(
            200,
            "email address is already taken",
        ));
    }

    let system_name = option_string(options[3].as_deref(), "CinaToken");
    let from = sender_from_options(options[4].as_deref(), options[5].as_deref());
    let code = generate_hex_code(6)?;
    let key = email_flow_id(&email);
    flow_state::put(&env, flow_state::FlowKind::EmailVerification, &key, &code).await?;
    let subject = format!("{system_name} email verification");
    let html = format!(
        "<p>Hello, you are verifying your email for {system_name}.</p>\
         <p>Your verification code is: <strong>{code}</strong></p>\
         <p>The code is valid for {VERIFICATION_VALID_MINUTES} minutes. If this was not you, ignore this email.</p>"
    );
    match send_html_email(&env, &from, &email, &subject, &html).await {
        Ok(()) => envelope_ok_response(&serde_json::Value::Null),
        Err(err) => {
            let _ = flow_state::delete(&env, flow_state::FlowKind::EmailVerification, &key).await;
            Ok(envelope_error_response(
                500,
                &format!("failed to send verification email: {err}"),
            ))
        }
    }
}

pub async fn send_password_reset_email(req: Request, env: Env) -> WorkerResult<Response> {
    if let Some(response) = turnstile::require_turnstile(&req, &env).await? {
        return Ok(response);
    }
    let email = match query_email(&req).and_then(|email| normalize_email(&email).ok()) {
        Some(email) => email,
        None => return Ok(envelope_error_response(200, "invalid parameters")),
    };
    let db = env.d1("DB")?;
    if !d1_repositories::email_exists_any_status(&db, &email).await? {
        return envelope_ok_response(&serde_json::Value::Null);
    }

    let options = d1_repositories::option_values(
        &db,
        &["SystemName", "ServerAddress", "SMTPFrom", "SMTPAccount"],
    )
    .await?;
    let system_name = option_string(options[0].as_deref(), "CinaToken");
    let frontend_base_url = env
        .var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .ok();
    let server_address = reset_base_url(options[1].as_deref(), frontend_base_url.as_deref(), &req);
    let from = sender_from_options(options[2].as_deref(), options[3].as_deref());
    let token = generate_hex_code(32)?;
    let link = reset_link(&server_address, &email, &token);
    let key = email_flow_id(&email);
    flow_state::put(&env, flow_state::FlowKind::PasswordReset, &key, &token).await?;
    let subject = format!("{system_name} password reset");
    let html = format!(
        "<p>Hello, you requested a password reset for {system_name}.</p>\
         <p>Click <a href='{link}'>here</a> to reset your password.</p>\
         <p>If the link is not clickable, copy this URL into your browser:<br>{link}</p>\
         <p>The reset link is valid for {VERIFICATION_VALID_MINUTES} minutes. If this was not you, ignore this email.</p>"
    );
    if let Err(err) = send_html_email(&env, &from, &email, &subject, &html).await {
        worker::console_warn!("failed to send password reset email to {}: {}", email, err);
    }
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn reset_password(mut req: Request, env: Env) -> WorkerResult<Response> {
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: PasswordResetRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(_) => return Ok(envelope_error_response(200, "invalid parameters")),
    };
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(_) => return Ok(envelope_error_response(200, "invalid parameters")),
    };
    let key = email_flow_id(&email);
    let expected = flow_state::get(&env, flow_state::FlowKind::PasswordReset, &key).await?;
    if !expected
        .as_deref()
        .is_some_and(|expected| constant_time_eq(expected, payload.token.trim()))
    {
        return Ok(envelope_error_response(
            200,
            "reset link is invalid or expired",
        ));
    }

    let password = generate_hex_code(12)?;
    let password_hash = match hash_password(&password) {
        Ok(hash) => hash,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to hash password: {err}"),
            ));
        }
    };
    let db = env.d1("DB")?;
    if !d1_repositories::reset_user_password_by_email(&db, &email, &password_hash).await? {
        return Ok(envelope_error_response(404, "user not found"));
    }
    flow_state::delete(&env, flow_state::FlowKind::PasswordReset, &key).await?;
    envelope_ok_response(&password)
}

pub async fn bind_email(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: EmailBindRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(_) => return Ok(envelope_error_response(400, "invalid request body")),
    };
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(_) => return Ok(envelope_error_response(200, "invalid parameters")),
    };
    if !verify_email_code(&env, &email, &payload.code).await? {
        return Ok(envelope_error_response(
            200,
            "verification code is incorrect",
        ));
    }
    let db = env.d1("DB")?;
    if d1_repositories::email_exists_any_status(&db, &email).await? {
        return Ok(envelope_error_response(
            200,
            "email address is already taken",
        ));
    }
    if !d1_repositories::update_user_email(&db, claims.id, &email).await? {
        return Ok(envelope_error_response(404, "user not found"));
    }
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn verify_email_code(env: &Env, email: &str, code: &str) -> WorkerResult<bool> {
    let email = match normalize_email(email) {
        Ok(email) => email,
        Err(_) => return Ok(false),
    };
    let key = email_flow_id(&email);
    let expected = flow_state::get(env, flow_state::FlowKind::EmailVerification, &key).await?;
    Ok(expected
        .as_deref()
        .is_some_and(|expected| constant_time_eq(expected, code.trim())))
}

fn query_email(req: &Request) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key == "email")
        .map(|(_, value)| value.into_owned())
}

pub fn normalize_email(email: &str) -> Result<String, String> {
    let email = email.trim();
    if !is_valid_email(email) {
        return Err("invalid email address".to_string());
    }
    Ok(email.to_string())
}

fn is_valid_email(email: &str) -> bool {
    if email.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = email.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || local.is_empty() || domain.is_empty() {
        return false;
    }
    domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn validate_email_policy(
    email: &str,
    domain_restriction_enabled: bool,
    domain_whitelist: &str,
    alias_restriction_enabled: bool,
) -> Result<(), String> {
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| "invalid email address".to_string())?;
    if domain_restriction_enabled {
        let allowed = domain_whitelist
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .any(|allowed| allowed.eq_ignore_ascii_case(domain));
        if !allowed {
            return Err("email domain is not allowed by the administrator".to_string());
        }
    }
    if alias_restriction_enabled && (local.contains('+') || local.contains('.')) {
        return Err("email aliases are not allowed by the administrator".to_string());
    }
    Ok(())
}

fn sender_from_options(smtp_from: Option<&str>, smtp_account: Option<&str>) -> String {
    smtp_from
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            smtp_account
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("")
        .to_string()
}

fn option_string(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_string()
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

fn reset_base_url(
    option_server_address: Option<&str>,
    frontend_base_url: Option<&str>,
    req: &Request,
) -> String {
    option_server_address
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            frontend_base_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or_else(|| {
            req.url()
                .ok()
                .map(|url| format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()))
                .unwrap_or_default()
        })
}

fn reset_link(base: &str, email: &str, token: &str) -> String {
    let email = url_encode(email);
    let token = url_encode(token);
    format!(
        "{}/user/reset?email={email}&token={token}",
        base.trim_end_matches('/')
    )
}

fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn email_flow_id(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.trim().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_hash = Sha256::digest(left.as_bytes());
    let right_hash = Sha256::digest(right.as_bytes());
    left_hash
        .iter()
        .zip(right_hash.iter())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

fn generate_hex_code(len: usize) -> WorkerResult<String> {
    let byte_len = (len + 1) / 2;
    let mut bytes = vec![0u8; byte_len];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| worker::Error::RustError(format!("random generation failed: {err}")))?;
    let mut out = String::with_capacity(byte_len * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out.truncate(len);
    Ok(out)
}

async fn send_html_email(
    env: &Env,
    from: &str,
    to: &str,
    subject: &str,
    html: &str,
) -> WorkerResult<()> {
    if from.trim().is_empty() {
        return Err(worker::Error::RustError(
            "email sender is not configured".to_string(),
        ));
    }
    let binding = js_sys::Reflect::get(env, &JsValue::from_str(EMAIL_BINDING))
        .map_err(|err| worker::Error::RustError(format!("email binding lookup failed: {err:?}")))?;
    if binding.is_undefined() || binding.is_null() {
        return Err(worker::Error::RustError(format!(
            "{EMAIL_BINDING} send_email binding is not configured"
        )));
    }
    let send_fn = js_sys::Reflect::get(&binding, &JsValue::from_str("send"))
        .map_err(|err| worker::Error::RustError(format!("email send lookup failed: {err:?}")))?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| worker::Error::RustError("email send binding has no send()".to_string()))?;
    let builder = js_sys::Object::new();
    set_prop(&builder, "from", from)?;
    set_prop(&builder, "to", to)?;
    set_prop(&builder, "subject", subject)?;
    set_prop(&builder, "html", html)?;
    let promise_value = send_fn
        .call1(&binding, &builder)
        .map_err(|err| worker::Error::RustError(format!("email send failed: {err:?}")))?;
    let promise = promise_value
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| worker::Error::RustError("email send did not return a Promise".to_string()))?;
    wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(|err| worker::Error::RustError(format!("email send failed: {err:?}")))?;
    Ok(())
}

fn set_prop(target: &js_sys::Object, key: &str, value: &str) -> WorkerResult<()> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), &JsValue::from_str(value))
        .map(|_| ())
        .map_err(|err| {
            worker::Error::RustError(format!("failed to set email field {key}: {err:?}"))
        })
}

#[derive(Debug, Deserialize)]
struct PasswordResetRequest {
    #[serde(default)]
    email: String,
    #[serde(default)]
    token: String,
}

#[derive(Debug, Deserialize)]
struct EmailBindRequest {
    #[serde(default)]
    email: String,
    #[serde(default)]
    code: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_basic_email_shape_and_policy() {
        assert!(normalize_email(" user@example.com ").is_ok());
        assert!(normalize_email("bad").is_err());
        assert!(normalize_email("a@b").is_err());
        assert!(validate_email_policy("a@example.com", true, "example.com", false).is_ok());
        assert!(validate_email_policy("a@other.com", true, "example.com", false).is_err());
        assert!(validate_email_policy("a+b@example.com", false, "", true).is_err());
        assert!(validate_email_policy("a.b@example.com", false, "", true).is_err());
    }

    #[test]
    fn reset_link_encodes_query_values() {
        assert_eq!(
            reset_link("https://example.test/", "user+1@example.com", "a b"),
            "https://example.test/user/reset?email=user%2B1%40example.com&token=a+b"
        );
    }

    #[test]
    fn flow_id_hashes_without_exposing_email() {
        let id = email_flow_id("person@example.com");
        assert_eq!(id.len(), 64);
        assert!(!id.contains("person"));
        assert_eq!(id, email_flow_id("person@example.com"));
    }

    #[test]
    fn constant_time_compare_uses_value_equality() {
        assert!(constant_time_eq("abcdef", "abcdef"));
        assert!(!constant_time_eq("abcdef", "abcdeg"));
    }
}
