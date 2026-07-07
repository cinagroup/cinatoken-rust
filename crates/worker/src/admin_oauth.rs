//! OAuth login (item 4.6) — GitHub provider.
//!
//! The frontend initiates the flow: it calls `GET /api/oauth/state` to obtain a
//! single-use CSRF state nonce (stored in [`crate::flow_state`] `OAuthState`)
//! and a browser-bound HttpOnly cookie, redirects the browser to GitHub's
//! authorize URL with that `state`, and GitHub redirects back through the
//! frontend callback. This handler validates the state against the same browser
//! cookie (single-use `take`), exchanges the code for a token, fetches the
//! GitHub user, finds-or-creates the local account (matched by GitHub login),
//! issues the session cookie, and 302-redirects to the frontend.
//!
//! Faithful to Go `controller/github.go::GitHubOAuth`. Inert unless
//! `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are configured. Runtime needs a
//! real GitHub OAuth app + staging to verify (the token/userinfo HTTP hops
//! cannot be host-tested).

use serde_json::Value;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Response, Result as WorkerResult};

use cinatoken_auth::USER_STATUS_ENABLED;

use crate::admin::{
    attach_session_cookie, envelope_error_response, envelope_ok_response, session_claims_from_user,
    session_codec, unix_timestamp,
};
use crate::{d1_repositories, flow_state};

const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const OAUTH_STATE_COOKIE_NAME: &str = "cinatoken_oauth_state";
const OAUTH_STATE_COOKIE_PATH: &str = "/api/oauth";
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS: u64 = 600;

struct GitHubUser {
    login: String,
    name: String,
    email: String,
}

/// `GET /api/oauth/state`: issue a single-use CSRF state nonce for an OAuth
/// redirect. The frontend echoes it as the `state` query parameter to the
/// provider; the callback consumes it (`take`).
pub async fn oauth_state(_req: Request, env: Env) -> WorkerResult<Response> {
    let (state, browser_binding) = new_oauth_state(&env).await?;
    let mut response = envelope_ok_response(&state)?;
    attach_oauth_state_cookie(&mut response, &browser_binding)?;
    Ok(response)
}

pub(crate) async fn new_oauth_state(env: &Env) -> WorkerResult<(String, String)> {
    new_oauth_state_with_payload(env, None).await
}

pub(crate) async fn new_oauth_state_with_payload(
    env: &Env,
    payload: Option<&str>,
) -> WorkerResult<(String, String)> {
    let Some(state) = crate::admin_2fa::new_pending_token() else {
        return Err(worker::Error::RustError(
            "failed to generate oauth state".to_string(),
        ));
    };
    let Some(browser_binding) = crate::admin_2fa::new_pending_token() else {
        return Err(worker::Error::RustError(
            "failed to generate oauth browser binding".to_string(),
        ));
    };
    let stored_value = match payload.map(str::trim).filter(|value| !value.is_empty()) {
        Some(payload) => format!("{browser_binding}\n{payload}"),
        None => browser_binding.clone(),
    };
    flow_state::put(env, flow_state::FlowKind::OAuthState, &state, &stored_value).await?;
    Ok((state, browser_binding))
}

/// `GET /api/oauth/github?code&state`: GitHub OAuth callback. Validates the
/// CSRF state, exchanges the code, finds-or-creates the account, issues the
/// session, and redirects to the frontend.
pub async fn github_oauth(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = validate_oauth_state(&req, &env).await? {
        return Ok(response);
    }
    let Some((client_id, client_secret)) = github_config(&env) else {
        return Ok(envelope_error_response(400, "GitHub login is not enabled"));
    };
    let code = query_param(&req, "code").unwrap_or_default();
    if code.is_empty() {
        return Ok(envelope_error_response(400, "missing authorization code"));
    }

    let github = match fetch_github_user(&client_id, &client_secret, &code).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return Ok(envelope_error_response(
                502,
                "GitHub did not return a valid user",
            ))
        }
        Err(err) => {
            worker::console_error!("github oauth exchange failed: {err}");
            return Ok(envelope_error_response(502, "failed to reach GitHub"));
        }
    };

    let db = env.d1("DB")?;
    let now = unix_timestamp();

    // BIND: if the caller is already logged in, link this GitHub login to their
    // existing account instead of logging in / registering (Go GitHubBind).
    match crate::admin::optional_user_auth(&req, &env).await? {
        Ok(Some(claims)) => {
            if let Some(existing) =
                d1_repositories::find_user_by_github_id(&db, &github.login).await?
            {
                if existing.id != claims.id {
                    return Ok(envelope_error_response(
                        409,
                        "this GitHub account is already linked to another user",
                    ));
                }
            }
            d1_repositories::bind_github_id(&db, claims.id, &github.login).await?;
            let mut response = Response::empty()?.with_status(302);
            response
                .headers_mut()
                .set("Location", &frontend_location(&env))?;
            attach_clear_oauth_state_cookie(&mut response)?;
            return Ok(response);
        }
        Ok(None) => {}
        Err(response) => return Ok(response),
    }

    let user = match d1_repositories::find_user_by_github_id(&db, &github.login).await? {
        Some(user) => user,
        None => {
            // Register a new account linked to this GitHub login.
            let username = format!("github_{}", github.login);
            let Some(aff_code) = crate::admin_2fa::new_pending_token() else {
                return Ok(envelope_error_response(500, "failed to provision account"));
            };
            let display_name = if github.name.trim().is_empty() {
                "GitHub User".to_string()
            } else {
                github.name.clone()
            };
            let id = d1_repositories::create_github_user(
                &db,
                &username,
                &github.login,
                &display_name,
                &github.email,
                &aff_code,
                now,
            )
            .await?;
            match d1_repositories::find_user_by_id(&db, id).await? {
                Some(user) => user,
                None => return Ok(envelope_error_response(500, "failed to load new account")),
            }
        }
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    // Issue the session, then redirect the browser to the frontend.
    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
    let claims = session_claims_from_user(&user);
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ))
        }
    };
    let _ = d1_repositories::update_last_login_at(&db, user.id, now).await;

    let mut response = Response::empty()?.with_status(302);
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    attach_clear_oauth_state_cookie(&mut response)?;
    response
        .headers_mut()
        .set("Location", &frontend_location(&env))?;
    Ok(response)
}

/// The post-OAuth redirect target: `FRONTEND_BASE_URL`, or `/` when unset.
pub(crate) fn frontend_location(env: &Env) -> String {
    env.var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/".to_string())
}

pub(crate) async fn validate_oauth_state(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<(), Response>> {
    match validate_oauth_state_with_payload(req, env).await? {
        Ok(_) => Ok(Ok(())),
        Err(response) => Ok(Err(response)),
    }
}

pub(crate) async fn validate_oauth_state_with_payload(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<Option<String>, Response>> {
    let state = query_param(req, "state").unwrap_or_default();
    if state.is_empty() {
        return Ok(Err(envelope_error_response(
            403,
            "invalid or expired oauth state",
        )));
    }
    let Some(browser_binding) = oauth_state_cookie(req) else {
        return Ok(Err(envelope_error_response(
            403,
            "invalid or expired oauth state",
        )));
    };
    let stored_binding = flow_state::get(env, flow_state::FlowKind::OAuthState, &state).await?;
    let (stored_binding, _payload) = split_oauth_state_payload(stored_binding.as_deref());
    if !oauth_state_binding_matches(stored_binding, Some(&browser_binding)) {
        return Ok(Err(envelope_error_response(
            403,
            "invalid or expired oauth state",
        )));
    }
    let taken_binding = flow_state::take(env, flow_state::FlowKind::OAuthState, &state).await?;
    let (taken_binding, payload) = split_oauth_state_payload(taken_binding.as_deref());
    if !oauth_state_binding_matches(taken_binding, Some(&browser_binding)) {
        return Ok(Err(envelope_error_response(
            403,
            "invalid or expired oauth state",
        )));
    }
    Ok(Ok(payload.map(str::to_string)))
}

fn split_oauth_state_payload(stored: Option<&str>) -> (Option<&str>, Option<&str>) {
    let Some(stored) = stored else {
        return (None, None);
    };
    match stored.split_once('\n') {
        Some((binding, payload)) => (Some(binding), Some(payload)),
        None => (Some(stored), None),
    }
}

fn oauth_state_binding_matches(stored: Option<&str>, cookie: Option<&str>) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    let Some(cookie) = cookie else {
        return false;
    };
    !stored.is_empty() && stored == cookie
}

fn oauth_state_cookie(req: &Request) -> Option<String> {
    let header = req.headers().get("Cookie").ok().flatten()?;
    extract_oauth_state_cookie(&header)
}

fn extract_oauth_state_cookie(cookie_header: &str) -> Option<String> {
    for pair in cookie_header.split(';') {
        let trimmed = pair.trim();
        let (name, value) = trimmed.split_once('=')?;
        if name == OAUTH_STATE_COOKIE_NAME && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn build_oauth_state_cookie_value(binding: &str) -> String {
    format!(
        "{OAUTH_STATE_COOKIE_NAME}={binding}; Path={OAUTH_STATE_COOKIE_PATH}; Max-Age={OAUTH_STATE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax; Secure"
    )
}

fn build_clear_oauth_state_cookie_value() -> String {
    format!(
        "{OAUTH_STATE_COOKIE_NAME}=; Path={OAUTH_STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax; Secure"
    )
}

pub(crate) fn attach_oauth_state_cookie(
    response: &mut Response,
    binding: &str,
) -> WorkerResult<()> {
    response
        .headers_mut()
        .append("Set-Cookie", &build_oauth_state_cookie_value(binding))
}

pub(crate) fn attach_clear_oauth_state_cookie(response: &mut Response) -> WorkerResult<()> {
    response
        .headers_mut()
        .append("Set-Cookie", &build_clear_oauth_state_cookie_value())
}

// ---------------------------------------------------------------------------
// OIDC (generic OpenID Connect — backs Google and any OIDC provider).
// ---------------------------------------------------------------------------

struct OidcConfig {
    client_id: String,
    client_secret: String,
    token_url: String,
    userinfo_url: String,
    redirect_uri: String,
}

struct OidcUser {
    sub: String,
    name: String,
    email: String,
}

/// `GET /api/oauth/oidc?code&state`: generic OIDC callback. Validates the CSRF
/// state (single-use), exchanges the code at the configured token endpoint
/// (form-encoded), fetches userinfo, finds-or-creates (or binds) the account by
/// the OIDC subject, issues the session, and redirects to the frontend. Inert
/// unless `OIDC_CLIENT_ID/SECRET/TOKEN_URL/USERINFO_URL/REDIRECT_URI` are set.
pub async fn oidc_oauth(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = validate_oauth_state(&req, &env).await? {
        return Ok(response);
    }
    let Some(config) = oidc_config(&env) else {
        return Ok(envelope_error_response(400, "OIDC login is not enabled"));
    };
    let code = query_param(&req, "code").unwrap_or_default();
    if code.is_empty() {
        return Ok(envelope_error_response(400, "missing authorization code"));
    }

    let oidc = match fetch_oidc_user(&config, &code).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return Ok(envelope_error_response(
                502,
                "OIDC provider did not return a valid user",
            ))
        }
        Err(err) => {
            worker::console_error!("oidc exchange failed: {err}");
            return Ok(envelope_error_response(
                502,
                "failed to reach the OIDC provider",
            ));
        }
    };

    let db = env.d1("DB")?;
    let now = unix_timestamp();

    // BIND: link the OIDC subject to a logged-in account.
    match crate::admin::optional_user_auth(&req, &env).await? {
        Ok(Some(claims)) => {
            if let Some(existing) = d1_repositories::find_user_by_oidc_id(&db, &oidc.sub).await? {
                if existing.id != claims.id {
                    return Ok(envelope_error_response(
                        409,
                        "this OIDC account is already linked to another user",
                    ));
                }
            }
            d1_repositories::bind_oidc_id(&db, claims.id, &oidc.sub).await?;
            let mut response = Response::empty()?.with_status(302);
            response
                .headers_mut()
                .set("Location", &frontend_location(&env))?;
            attach_clear_oauth_state_cookie(&mut response)?;
            return Ok(response);
        }
        Ok(None) => {}
        Err(response) => return Ok(response),
    }

    let user = match d1_repositories::find_user_by_oidc_id(&db, &oidc.sub).await? {
        Some(user) => user,
        None => {
            let username = format!("oidc_{}", oidc.sub);
            let Some(aff_code) = crate::admin_2fa::new_pending_token() else {
                return Ok(envelope_error_response(500, "failed to provision account"));
            };
            let display_name = if oidc.name.trim().is_empty() {
                "OIDC User".to_string()
            } else {
                oidc.name.clone()
            };
            let id = d1_repositories::create_oidc_user(
                &db,
                &username,
                &oidc.sub,
                &display_name,
                &oidc.email,
                &aff_code,
                now,
            )
            .await?;
            match d1_repositories::find_user_by_id(&db, id).await? {
                Some(user) => user,
                None => return Ok(envelope_error_response(500, "failed to load new account")),
            }
        }
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
    let claims = session_claims_from_user(&user);
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ))
        }
    };
    let _ = d1_repositories::update_last_login_at(&db, user.id, now).await;
    let mut response = Response::empty()?.with_status(302);
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    attach_clear_oauth_state_cookie(&mut response)?;
    response
        .headers_mut()
        .set("Location", &frontend_location(&env))?;
    Ok(response)
}

fn oidc_config(env: &Env) -> Option<OidcConfig> {
    let secret_or_var = |name: &str| -> Option<String> {
        env.secret(name)
            .map(|value| value.to_string())
            .ok()
            .or_else(|| env.var(name).map(|value| value.to_string()).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(OidcConfig {
        client_id: secret_or_var("OIDC_CLIENT_ID")?,
        client_secret: secret_or_var("OIDC_CLIENT_SECRET")?,
        token_url: secret_or_var("OIDC_TOKEN_URL")?,
        userinfo_url: secret_or_var("OIDC_USERINFO_URL")?,
        redirect_uri: secret_or_var("OIDC_REDIRECT_URI")?,
    })
}

async fn fetch_oidc_user(config: &OidcConfig, code: &str) -> WorkerResult<Option<OidcUser>> {
    let body = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri={}",
        form_encode(code),
        form_encode(&config.client_id),
        form_encode(&config.client_secret),
        form_encode(&config.redirect_uri),
    );
    let mut token_headers = Headers::new();
    token_headers.set("Content-Type", "application/x-www-form-urlencoded")?;
    token_headers.set("Accept", "application/json")?;
    let mut token_init = RequestInit::new();
    token_init
        .with_method(Method::Post)
        .with_headers(token_headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&body)));
    let token_request = Request::new_with_init(&config.token_url, &token_init)?;
    let mut token_response = Fetch::Request(token_request).send().await?;
    let token_text = token_response.text().await?;
    let access_token = serde_json::from_str::<Value>(&token_text)
        .ok()
        .and_then(|value| {
            value
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|token| !token.is_empty());
    let Some(access_token) = access_token else {
        return Ok(None);
    };

    let mut user_headers = Headers::new();
    user_headers.set("Authorization", &format!("Bearer {access_token}"))?;
    user_headers.set("Accept", "application/json")?;
    user_headers.set("User-Agent", "cinatoken-rust")?;
    let mut user_init = RequestInit::new();
    user_init
        .with_method(Method::Get)
        .with_headers(user_headers);
    let user_request = Request::new_with_init(&config.userinfo_url, &user_init)?;
    let mut user_response = Fetch::Request(user_request).send().await?;
    let user_text = user_response.text().await?;
    let value: Value = serde_json::from_str(&user_text).unwrap_or(Value::Null);
    let sub = value
        .get("sub")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if sub.is_empty() {
        return Ok(None);
    }
    // Prefer `name`, fall back to `preferred_username`.
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| value.get("preferred_username").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    Ok(Some(OidcUser {
        sub,
        name,
        email: value
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Discord (fixed endpoints; OAuth2 authorization-code, like OIDC).
// ---------------------------------------------------------------------------

const DISCORD_TOKEN_URL: &str = "https://discord.com/api/oauth2/token";
const DISCORD_USER_URL: &str = "https://discord.com/api/users/@me";

struct DiscordUser {
    id: String,
    username: String,
    email: String,
}

/// `GET /api/oauth/discord?code&state`: Discord OAuth callback (login / register
/// / bind by Discord id). Inert unless `DISCORD_CLIENT_ID/SECRET/REDIRECT_URI`
/// are configured.
pub async fn discord_oauth(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = validate_oauth_state(&req, &env).await? {
        return Ok(response);
    }
    let Some((client_id, client_secret, redirect_uri)) = discord_config(&env) else {
        return Ok(envelope_error_response(400, "Discord login is not enabled"));
    };
    let code = query_param(&req, "code").unwrap_or_default();
    if code.is_empty() {
        return Ok(envelope_error_response(400, "missing authorization code"));
    }

    let discord = match fetch_discord_user(&client_id, &client_secret, &redirect_uri, &code).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return Ok(envelope_error_response(
                502,
                "Discord did not return a valid user",
            ))
        }
        Err(err) => {
            worker::console_error!("discord oauth exchange failed: {err}");
            return Ok(envelope_error_response(502, "failed to reach Discord"));
        }
    };

    let db = env.d1("DB")?;
    let now = unix_timestamp();

    match crate::admin::optional_user_auth(&req, &env).await? {
        Ok(Some(claims)) => {
            if let Some(existing) =
                d1_repositories::find_user_by_discord_id(&db, &discord.id).await?
            {
                if existing.id != claims.id {
                    return Ok(envelope_error_response(
                        409,
                        "this Discord account is already linked to another user",
                    ));
                }
            }
            d1_repositories::bind_discord_id(&db, claims.id, &discord.id).await?;
            let mut response = Response::empty()?.with_status(302);
            response
                .headers_mut()
                .set("Location", &frontend_location(&env))?;
            attach_clear_oauth_state_cookie(&mut response)?;
            return Ok(response);
        }
        Ok(None) => {}
        Err(response) => return Ok(response),
    }

    let user = match d1_repositories::find_user_by_discord_id(&db, &discord.id).await? {
        Some(user) => user,
        None => {
            let username = format!("discord_{}", discord.id);
            let Some(aff_code) = crate::admin_2fa::new_pending_token() else {
                return Ok(envelope_error_response(500, "failed to provision account"));
            };
            let display_name = if discord.username.trim().is_empty() {
                "Discord User".to_string()
            } else {
                discord.username.clone()
            };
            let id = d1_repositories::create_discord_user(
                &db,
                &username,
                &discord.id,
                &display_name,
                &discord.email,
                &aff_code,
                now,
            )
            .await?;
            match d1_repositories::find_user_by_id(&db, id).await? {
                Some(user) => user,
                None => return Ok(envelope_error_response(500, "failed to load new account")),
            }
        }
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
    let claims = session_claims_from_user(&user);
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ))
        }
    };
    let _ = d1_repositories::update_last_login_at(&db, user.id, now).await;
    let mut response = Response::empty()?.with_status(302);
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    attach_clear_oauth_state_cookie(&mut response)?;
    response
        .headers_mut()
        .set("Location", &frontend_location(&env))?;
    Ok(response)
}

fn discord_config(env: &Env) -> Option<(String, String, String)> {
    let read = |name: &str| -> Option<String> {
        env.secret(name)
            .map(|value| value.to_string())
            .ok()
            .or_else(|| env.var(name).map(|value| value.to_string()).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some((
        read("DISCORD_CLIENT_ID")?,
        read("DISCORD_CLIENT_SECRET")?,
        read("DISCORD_REDIRECT_URI")?,
    ))
}

async fn fetch_discord_user(
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> WorkerResult<Option<DiscordUser>> {
    let body = format!(
        "grant_type=authorization_code&code={}&client_id={}&client_secret={}&redirect_uri={}",
        form_encode(code),
        form_encode(client_id),
        form_encode(client_secret),
        form_encode(redirect_uri),
    );
    let mut token_headers = Headers::new();
    token_headers.set("Content-Type", "application/x-www-form-urlencoded")?;
    token_headers.set("Accept", "application/json")?;
    let mut token_init = RequestInit::new();
    token_init
        .with_method(Method::Post)
        .with_headers(token_headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&body)));
    let token_request = Request::new_with_init(DISCORD_TOKEN_URL, &token_init)?;
    let mut token_response = Fetch::Request(token_request).send().await?;
    let token_text = token_response.text().await?;
    let access_token = serde_json::from_str::<Value>(&token_text)
        .ok()
        .and_then(|value| {
            value
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|token| !token.is_empty());
    let Some(access_token) = access_token else {
        return Ok(None);
    };

    let mut user_headers = Headers::new();
    user_headers.set("Authorization", &format!("Bearer {access_token}"))?;
    user_headers.set("Accept", "application/json")?;
    user_headers.set("User-Agent", "cinatoken-rust")?;
    let mut user_init = RequestInit::new();
    user_init
        .with_method(Method::Get)
        .with_headers(user_headers);
    let user_request = Request::new_with_init(DISCORD_USER_URL, &user_init)?;
    let mut user_response = Fetch::Request(user_request).send().await?;
    let user_text = user_response.text().await?;
    let value: Value = serde_json::from_str(&user_text).unwrap_or(Value::Null);
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Ok(None);
    }
    Ok(Some(DiscordUser {
        id,
        username: value
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

/// Percent-encode a value for an `application/x-www-form-urlencoded` body.
pub(crate) fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `(client_id, client_secret)` when GitHub OAuth is configured, else `None`.
fn github_config(env: &Env) -> Option<(String, String)> {
    let id = env
        .secret("GITHUB_CLIENT_ID")
        .map(|value| value.to_string())
        .ok()
        .or_else(|| {
            env.var("GITHUB_CLIENT_ID")
                .map(|value| value.to_string())
                .ok()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    let secret = env
        .secret("GITHUB_CLIENT_SECRET")
        .map(|value| value.to_string())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    Some((id, secret))
}

/// Exchange an authorization `code` for an access token and fetch the GitHub
/// user. Faithful to Go `getGitHubUserInfoByCode`. `None` when the response is
/// missing the access token or the user login.
async fn fetch_github_user(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> WorkerResult<Option<GitHubUser>> {
    let token_body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
    })
    .to_string();
    let mut token_headers = Headers::new();
    token_headers.set("Content-Type", "application/json")?;
    token_headers.set("Accept", "application/json")?;
    let mut token_init = RequestInit::new();
    token_init
        .with_method(Method::Post)
        .with_headers(token_headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&token_body)));
    let token_request = Request::new_with_init(GITHUB_TOKEN_URL, &token_init)?;
    let mut token_response = Fetch::Request(token_request).send().await?;
    let token_text = token_response.text().await?;
    let access_token = serde_json::from_str::<Value>(&token_text)
        .ok()
        .and_then(|value| {
            value
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|token| !token.is_empty());
    let Some(access_token) = access_token else {
        return Ok(None);
    };

    let mut user_headers = Headers::new();
    user_headers.set("Authorization", &format!("Bearer {access_token}"))?;
    user_headers.set("Accept", "application/vnd.github+json")?;
    // GitHub's API rejects requests without a User-Agent.
    user_headers.set("User-Agent", "cinatoken-rust")?;
    let mut user_init = RequestInit::new();
    user_init
        .with_method(Method::Get)
        .with_headers(user_headers);
    let user_request = Request::new_with_init(GITHUB_USER_URL, &user_init)?;
    let mut user_response = Fetch::Request(user_request).send().await?;
    let user_text = user_response.text().await?;
    let value: Value = serde_json::from_str(&user_text).unwrap_or(Value::Null);
    let login = value
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if login.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitHubUser {
        login,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

pub(crate) fn query_param(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_state_cookie_is_browser_bound_and_short_lived() {
        let header = build_oauth_state_cookie_value("browser-binding");

        assert!(header.starts_with("cinatoken_oauth_state=browser-binding;"));
        assert!(header.contains("Path=/api/oauth"));
        assert!(header.contains("Max-Age=600"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Lax"));
        assert!(header.contains("Secure"));
    }

    #[test]
    fn clear_oauth_state_cookie_uses_matching_scope() {
        let header = build_clear_oauth_state_cookie_value();

        assert!(header.starts_with("cinatoken_oauth_state=;"));
        assert!(header.contains("Path=/api/oauth"));
        assert!(header.contains("Max-Age=0"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Lax"));
        assert!(header.contains("Secure"));
    }

    #[test]
    fn oauth_state_cookie_extraction_handles_multiple_cookies() {
        assert_eq!(
            extract_oauth_state_cookie("session=abc; cinatoken_oauth_state=bind123; theme=dark"),
            Some("bind123".to_string())
        );
        assert_eq!(
            extract_oauth_state_cookie("cinatoken_oauth_state=first; session=abc"),
            Some("first".to_string())
        );
        assert_eq!(
            extract_oauth_state_cookie("cinatoken_oauth_state=; session=abc"),
            None
        );
        assert_eq!(extract_oauth_state_cookie("session=abc"), None);
    }

    #[test]
    fn oauth_state_binding_requires_stored_value_and_cookie_match() {
        assert!(oauth_state_binding_matches(Some("same"), Some("same")));
        assert!(!oauth_state_binding_matches(Some("same"), Some("other")));
        assert!(!oauth_state_binding_matches(Some("same"), None));
        assert!(!oauth_state_binding_matches(None, Some("same")));
        assert!(!oauth_state_binding_matches(Some(""), Some("")));
    }

    #[test]
    fn oauth_state_payload_preserves_browser_binding_prefix() {
        assert_eq!(
            split_oauth_state_payload(Some("binding\nhttps://app.example/oauth/7")),
            (Some("binding"), Some("https://app.example/oauth/7"))
        );
        assert_eq!(
            split_oauth_state_payload(Some("binding-only")),
            (Some("binding-only"), None)
        );
        assert_eq!(split_oauth_state_payload(None), (None, None));
    }
}
