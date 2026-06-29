//! OAuth login (item 4.6) — GitHub provider.
//!
//! The frontend initiates the flow: it calls `GET /api/oauth/state` to obtain a
//! single-use CSRF state nonce (stored in [`crate::flow_state`] `OAuthState`),
//! redirects the browser to GitHub's authorize URL with that `state`, and GitHub
//! redirects back to `GET /api/oauth/github?code&state`. This handler validates
//! the state (single-use `take`), exchanges the code for a token, fetches the
//! GitHub user, finds-or-creates the local account (matched by GitHub login),
//! issues the session cookie, and 302-redirects to the frontend.
//!
//! Faithful to Go `controller/github.go::GitHubOAuth`. Inert unless
//! `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are configured. Runtime needs a
//! real GitHub OAuth app + staging to verify (the token/userinfo HTTP hops
//! cannot be host-tested).

use serde::Serialize;
use serde_json::Value;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Response, Result as WorkerResult};

use cinatoken_auth::USER_STATUS_DISABLED;
use cinatoken_session::SessionClaims;

use crate::admin::{
    attach_session_cookie, envelope_error_response, envelope_ok_response, session_codec,
    unix_timestamp,
};
use crate::{d1_repositories, flow_state};

const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";

struct GitHubUser {
    login: String,
    name: String,
    email: String,
}

/// `GET /api/oauth/state`: issue a single-use CSRF state nonce for an OAuth
/// redirect. The frontend echoes it as the `state` query parameter to the
/// provider; the callback consumes it (`take`).
pub async fn oauth_state(_req: Request, env: Env) -> WorkerResult<Response> {
    let Some(state) = crate::admin_2fa::new_pending_token() else {
        return Ok(envelope_error_response(500, "failed to generate oauth state"));
    };
    flow_state::put(&env, flow_state::FlowKind::OAuthState, &state, "1").await?;
    envelope_ok_response(&StateResponse { state })
}

/// `GET /api/oauth/github?code&state`: GitHub OAuth callback. Validates the
/// CSRF state, exchanges the code, finds-or-creates the account, issues the
/// session, and redirects to the frontend.
pub async fn github_oauth(req: Request, env: Env) -> WorkerResult<Response> {
    let state = query_param(&req, "state").unwrap_or_default();
    // CSRF: the state must match a single-use stored nonce (consumed here).
    if state.is_empty()
        || flow_state::take(&env, flow_state::FlowKind::OAuthState, &state)
            .await?
            .is_none()
    {
        return Ok(envelope_error_response(403, "invalid or expired oauth state"));
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
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    // Issue the session, then redirect the browser to the frontend.
    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
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
    let _ = d1_repositories::update_last_login_at(&db, user.id, now).await;

    let location = env
        .var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/".to_string());
    let mut response = Response::empty()?.with_status(302);
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    response.headers_mut().set("Location", &location)?;
    Ok(response)
}

/// `(client_id, client_secret)` when GitHub OAuth is configured, else `None`.
fn github_config(env: &Env) -> Option<(String, String)> {
    let id = env
        .secret("GITHUB_CLIENT_ID")
        .map(|value| value.to_string())
        .ok()
        .or_else(|| env.var("GITHUB_CLIENT_ID").map(|value| value.to_string()).ok())
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
    user_init.with_method(Method::Get).with_headers(user_headers);
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

fn query_param(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

#[derive(Serialize)]
struct StateResponse {
    state: String,
}
