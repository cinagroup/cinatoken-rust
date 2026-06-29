//! Cloudflare Turnstile server-side verification (migration item 2.4).
//!
//! Port of Go `middleware.TurnstileCheck`: when Turnstile is configured
//! (`TURNSTILE_SECRET` set, ≈ Go `TurnstileCheckEnabled`), endpoints that accept
//! anonymous input (login/register/reset) require a valid Turnstile token. The
//! token is read from the `turnstile` query parameter (Go `c.Query("turnstile")`)
//! and verified against Cloudflare's siteverify endpoint with the secret +
//! client IP. When unset, verification is a no-op so the default deployment is
//! unaffected.

use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Response, Result};

const SITEVERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SECRET_ENV: &str = "TURNSTILE_SECRET";

/// Whether Turnstile verification is enabled (a non-empty secret is configured).
pub fn turnstile_enabled(env: &Env) -> bool {
    turnstile_secret(env).is_some()
}

fn turnstile_secret(env: &Env) -> Option<String> {
    env.secret(TURNSTILE_SECRET_ENV)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| env.var(TURNSTILE_SECRET_ENV).map(|value| value.to_string()).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Verify a Turnstile token via Cloudflare siteverify. Faithful to Go
/// `TurnstileCheck`: POST form `{secret, response, remoteip}`, parse `{success}`.
/// Returns `Ok(true)` when Turnstile is disabled (no secret).
pub async fn verify_turnstile_token(
    env: &Env,
    token: &str,
    remote_ip: Option<&str>,
) -> Result<bool> {
    let Some(secret) = turnstile_secret(env) else {
        return Ok(true);
    };
    let mut form = format!(
        "secret={}&response={}",
        form_encode(&secret),
        form_encode(token)
    );
    if let Some(ip) = remote_ip.map(str::trim).filter(|ip| !ip.is_empty()) {
        form.push_str("&remoteip=");
        form.push_str(&form_encode(ip));
    }

    let mut headers = Headers::new();
    headers.set("Content-Type", "application/x-www-form-urlencoded")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&form)));
    let request = Request::new_with_init(SITEVERIFY_URL, &init)?;

    let mut response = Fetch::Request(request).send().await?;
    let body = response.text().await?;
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    Ok(parsed
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false))
}

/// Gate for anonymous endpoints. When Turnstile is enabled, require a valid
/// `?turnstile=` token; returns `Some(error_response)` on a missing/failed
/// token, `None` on pass (or when disabled). Mirrors Go's abort-with-message.
pub async fn require_turnstile(req: &Request, env: &Env) -> Result<Option<Response>> {
    if !turnstile_enabled(env) {
        return Ok(None);
    }
    let token = turnstile_query_token(req).unwrap_or_default();
    if token.is_empty() {
        return Ok(Some(crate::admin::envelope_error_response(
            400,
            "Turnstile token is empty",
        )));
    }
    let remote_ip = req.headers().get("CF-Connecting-IP").ok().flatten();
    if verify_turnstile_token(env, &token, remote_ip.as_deref()).await? {
        Ok(None)
    } else {
        Ok(Some(crate::admin::envelope_error_response(
            403,
            "Turnstile verification failed, please retry",
        )))
    }
}

fn turnstile_query_token(req: &Request) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key == "turnstile")
        .map(|(_, value)| value.into_owned())
}

/// Percent-encode a value for an `application/x-www-form-urlencoded` body.
/// Pure (host-testable) so the user-supplied token cannot break the form or be
/// injected into adjacent fields.
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encode_escapes_reserved_and_unsafe_bytes() {
        // Unreserved chars pass through.
        assert_eq!(form_encode("Abc-1_2.3~z"), "Abc-1_2.3~z");
        // Space -> '+'; reserved form chars are percent-encoded so a token
        // cannot inject extra fields.
        assert_eq!(form_encode("a b"), "a+b");
        assert_eq!(form_encode("x&y=z"), "x%26y%3Dz");
        assert_eq!(form_encode("a+b"), "a%2Bb");
        // UTF-8 multibyte is percent-encoded per byte.
        assert_eq!(form_encode("é"), "%C3%A9");
    }
}
