//! Root-admin custom OAuth provider configuration surface.
//!
//! This ports the Go `controller/custom_oauth.go` provider CRUD and OIDC
//! discovery helper. The actual custom-provider login/bind callback flow is a
//! separate auth migration because it needs state replay protection and account
//! binding policy as one unit.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use cinatoken_auth::USER_STATUS_ENABLED;
use cinatoken_core::ApiEnvelope;
use cinatoken_ssrf::SsrfPolicy;
use futures_util::{
    future::{select, Either},
    TryStreamExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_root_auth, session_claims_from_user, session_codec, unix_timestamp,
};
use crate::d1_repositories::{
    self, CreateCustomOAuthProvider, CustomOAuthBindingUpsert, CustomOAuthProviderRow,
    UpdateCustomOAuthProvider,
};
use crate::set_cors_headers;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const DISCOVERY_ERROR_BODY_LIMIT_BYTES: usize = 512;
const OAUTH_FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const OAUTH_TOKEN_BODY_LIMIT_BYTES: usize = 64 * 1024;
const OAUTH_USERINFO_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const CUSTOM_OAUTH_USERNAME_MAX_LEN: usize = 20;
const DEFAULT_SCOPES: &str = "openid profile email";
const DEFAULT_USER_ID_FIELD: &str = "sub";
const DEFAULT_USERNAME_FIELD: &str = "preferred_username";
const DEFAULT_DISPLAY_NAME_FIELD: &str = "name";
const DEFAULT_EMAIL_FIELD: &str = "email";
const BUILTIN_PROVIDER_SLUGS: &[&str] = &["github", "discord", "oidc", "linuxdo"];

#[derive(Debug, Serialize)]
struct CustomOAuthProviderResponse {
    id: i64,
    name: String,
    slug: String,
    icon: String,
    enabled: bool,
    client_id: String,
    authorization_endpoint: String,
    token_endpoint: String,
    user_info_endpoint: String,
    scopes: String,
    user_id_field: String,
    username_field: String,
    display_name_field: String,
    email_field: String,
    well_known: String,
    auth_style: i32,
    access_policy: String,
    access_denied_message: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CustomOAuthStatusProvider {
    id: i64,
    name: String,
    slug: String,
    icon: String,
    client_id: String,
    authorization_endpoint: String,
    scopes: String,
}

#[derive(Debug, Deserialize)]
struct CreateCustomOAuthProviderRequest {
    name: String,
    slug: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    enabled: bool,
    client_id: String,
    client_secret: String,
    authorization_endpoint: String,
    token_endpoint: String,
    user_info_endpoint: String,
    #[serde(default)]
    scopes: String,
    #[serde(default)]
    user_id_field: String,
    #[serde(default)]
    username_field: String,
    #[serde(default)]
    display_name_field: String,
    #[serde(default)]
    email_field: String,
    #[serde(default)]
    well_known: String,
    #[serde(default)]
    auth_style: i32,
    #[serde(default)]
    access_policy: String,
    #[serde(default)]
    access_denied_message: String,
}

#[derive(Debug, Deserialize, Default)]
struct UpdateCustomOAuthProviderRequest {
    name: Option<String>,
    slug: Option<String>,
    icon: Option<String>,
    enabled: Option<bool>,
    client_id: Option<String>,
    client_secret: Option<String>,
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    user_info_endpoint: Option<String>,
    scopes: Option<String>,
    user_id_field: Option<String>,
    username_field: Option<String>,
    display_name_field: Option<String>,
    email_field: Option<String>,
    well_known: Option<String>,
    auth_style: Option<i32>,
    access_policy: Option<String>,
    access_denied_message: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct DiscoveryRequest {
    #[serde(default)]
    well_known_url: String,
    #[serde(default)]
    issuer_url: String,
}

#[derive(Debug, Serialize)]
struct DiscoveryResponse {
    well_known_url: String,
    discovery: Value,
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

impl LoginResponse {
    fn from_row(row: &d1_repositories::AdminUserRow) -> Self {
        Self {
            id: row.id,
            username: row.username.clone(),
            display_name: row.display_name.clone(),
            role: row.role,
            status: row.status,
            group: row.group.clone(),
        }
    }
}

#[derive(Debug)]
struct CustomOAuthToken {
    access_token: String,
    token_type: String,
}

#[derive(Debug)]
struct CustomOAuthUser {
    provider_user_id: String,
    username: String,
    display_name: String,
    email: String,
}

#[derive(Debug, Deserialize, Default)]
struct TokenResponseBody {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    token_type: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Debug, Clone)]
struct ProviderConfig {
    name: String,
    slug: String,
    icon: String,
    enabled: bool,
    client_id: String,
    authorization_endpoint: String,
    token_endpoint: String,
    user_info_endpoint: String,
    scopes: String,
    user_id_field: String,
    username_field: String,
    display_name_field: String,
    email_field: String,
    well_known: String,
    auth_style: i32,
    access_policy: String,
    access_denied_message: String,
}

pub async fn list(req: Request, env: Env) -> WorkerResult<Response> {
    match require_root_auth(&req, &env).await? {
        Ok(_) => {}
        Err(response) => return Ok(response),
    }
    let db = env.d1("DB")?;
    let rows = d1_repositories::list_custom_oauth_providers(&db).await?;
    let response: Vec<_> = rows.into_iter().map(provider_response).collect();
    envelope_ok_response(&response)
}

pub async fn get(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    match require_root_auth(&req, &env).await? {
        Ok(_) => {}
        Err(response) => return Ok(response),
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid provider id"));
    };
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_custom_oauth_provider_by_id(&db, id).await? else {
        return Ok(envelope_error_response(
            404,
            "custom OAuth provider not found",
        ));
    };
    envelope_ok_response(&provider_response(row))
}

pub async fn create(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: CreateCustomOAuthProviderRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid custom OAuth provider request: {err}"),
            ));
        }
    };
    let (config, client_secret) = match normalize_create_request(payload) {
        Ok(normalized) => normalized,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };

    let db = env.d1("DB")?;
    if let Some(response) = reject_slug_conflict(&db, &config.slug, None).await? {
        return Ok(response);
    }

    let now = unix_timestamp();
    let id = d1_repositories::create_custom_oauth_provider(
        &db,
        CreateCustomOAuthProvider {
            name: &config.name,
            slug: &config.slug,
            icon: &config.icon,
            enabled: config.enabled,
            client_id: &config.client_id,
            client_secret: &client_secret,
            authorization_endpoint: &config.authorization_endpoint,
            token_endpoint: &config.token_endpoint,
            user_info_endpoint: &config.user_info_endpoint,
            scopes: &config.scopes,
            user_id_field: &config.user_id_field,
            username_field: &config.username_field,
            display_name_field: &config.display_name_field,
            email_field: &config.email_field,
            well_known: &config.well_known,
            auth_style: config.auth_style,
            access_policy: &config.access_policy,
            access_denied_message: &config.access_denied_message,
            now,
        },
    )
    .await?;
    let row = d1_repositories::find_custom_oauth_provider_by_id(&db, id)
        .await?
        .ok_or_else(|| {
            worker::Error::RustError("custom OAuth provider insert was not readable".to_string())
        })?;
    audit_custom_oauth(
        &db,
        &claims,
        &req,
        "custom_oauth.create",
        "created custom OAuth provider",
        &row,
    )
    .await;
    envelope_ok_response(&provider_response(row))
}

pub async fn update(
    mut req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid provider id"));
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UpdateCustomOAuthProviderRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid custom OAuth provider update request: {err}"),
            ));
        }
    };

    let db = env.d1("DB")?;
    let Some(existing) = d1_repositories::find_custom_oauth_provider_by_id(&db, id).await? else {
        return Ok(envelope_error_response(
            404,
            "custom OAuth provider not found",
        ));
    };
    let (config, client_secret_update) = match normalize_update_request(&existing, payload) {
        Ok(normalized) => normalized,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    if let Some(response) = reject_slug_conflict(&db, &config.slug, Some(id)).await? {
        return Ok(response);
    }

    d1_repositories::update_custom_oauth_provider(
        &db,
        UpdateCustomOAuthProvider {
            id,
            name: Some(&config.name),
            slug: Some(&config.slug),
            icon: Some(&config.icon),
            enabled: Some(config.enabled),
            client_id: Some(&config.client_id),
            client_secret: client_secret_update.as_deref(),
            authorization_endpoint: Some(&config.authorization_endpoint),
            token_endpoint: Some(&config.token_endpoint),
            user_info_endpoint: Some(&config.user_info_endpoint),
            scopes: Some(&config.scopes),
            user_id_field: Some(&config.user_id_field),
            username_field: Some(&config.username_field),
            display_name_field: Some(&config.display_name_field),
            email_field: Some(&config.email_field),
            well_known: Some(&config.well_known),
            auth_style: Some(config.auth_style),
            access_policy: Some(&config.access_policy),
            access_denied_message: Some(&config.access_denied_message),
            updated_at: unix_timestamp(),
        },
    )
    .await?;
    let row = d1_repositories::find_custom_oauth_provider_by_id(&db, id)
        .await?
        .ok_or_else(|| {
            worker::Error::RustError("custom OAuth provider update was not readable".to_string())
        })?;
    audit_custom_oauth(
        &db,
        &claims,
        &req,
        "custom_oauth.update",
        "updated custom OAuth provider",
        &row,
    )
    .await;
    envelope_ok_response(&provider_response(row))
}

pub async fn delete(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid provider id"));
    };
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_custom_oauth_provider_by_id(&db, id).await? else {
        return Ok(envelope_error_response(
            404,
            "custom OAuth provider not found",
        ));
    };
    let binding_count = d1_repositories::count_custom_oauth_bindings(&db, id).await?;
    if binding_count > 0 {
        return Ok(envelope_error_response(
            409,
            "custom OAuth provider still has user bindings",
        ));
    }
    d1_repositories::delete_custom_oauth_provider(&db, id).await?;
    audit_custom_oauth(
        &db,
        &claims,
        &req,
        "custom_oauth.delete",
        "deleted custom OAuth provider",
        &row,
    )
    .await;
    envelope_ok_response(&Value::Null)
}

pub async fn discover(mut req: Request, env: Env) -> WorkerResult<Response> {
    match require_root_auth(&req, &env).await? {
        Ok(_) => {}
        Err(response) => return Ok(response),
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: DiscoveryRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid discovery request: {err}"),
            ));
        }
    };
    let target = match discovery_target_url(&payload.well_known_url, &payload.issuer_url) {
        Ok(target) => target,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let discovery = match fetch_discovery_json(&target).await {
        Ok(value) => value,
        Err(message) => return Ok(envelope_error_response(502, &message)),
    };
    envelope_ok_response(&DiscoveryResponse {
        well_known_url: target,
        discovery,
    })
}

pub async fn oauth_callback(
    req: Request,
    env: Env,
    provider_param: Option<&String>,
) -> WorkerResult<Response> {
    let provider_key = provider_param
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if provider_key.is_empty() {
        return Ok(envelope_error_response(400, "unknown OAuth provider"));
    }

    let db = env.d1("DB")?;
    let Some(provider) =
        d1_repositories::find_enabled_custom_oauth_provider_by_slug_or_id(&db, &provider_key)
            .await?
    else {
        return Ok(envelope_error_response(
            400,
            "custom OAuth provider is not enabled",
        ));
    };

    let error = crate::admin_oauth::query_param(&req, "error").unwrap_or_default();
    if !error.is_empty() {
        match crate::admin_oauth::validate_oauth_state_with_payload(&req, &env).await? {
            Ok(_) => {}
            Err(response) => return Ok(response),
        }
        let message = crate::admin_oauth::query_param(&req, "error_description")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(error);
        let mut response = oauth_business_error_response(200, &message)?;
        crate::admin_oauth::attach_clear_oauth_state_cookie(&mut response)?;
        return Ok(response);
    }

    let code = crate::admin_oauth::query_param(&req, "code").unwrap_or_default();
    if code.trim().is_empty() {
        if crate::admin_oauth::query_param(&req, "state").is_some() {
            return Ok(envelope_error_response(400, "missing authorization code"));
        }
        return start_custom_oauth_redirect(req, env, provider, &provider_key).await;
    }

    let redirect_uri =
        match crate::admin_oauth::validate_oauth_state_with_payload(&req, &env).await? {
            Ok(Some(redirect_uri)) => redirect_uri,
            Ok(None) => default_custom_callback_url(&req, &env, &provider_key),
            Err(response) => return Ok(response),
        };
    let redirect_uri = match validate_custom_redirect_uri(&req, &env, &redirect_uri) {
        Ok(redirect_uri) => redirect_uri,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };

    let oauth_user = match fetch_custom_oauth_user(&provider, code.trim(), &redirect_uri).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return Ok(envelope_error_response(
                502,
                "custom OAuth provider did not return a valid user",
            ))
        }
        Err(message) => {
            worker::console_error!(
                "custom OAuth callback failed for {}: {}",
                provider.slug,
                message
            );
            return Ok(envelope_error_response(502, &message));
        }
    };

    let now = unix_timestamp();
    match crate::admin::optional_user_auth(&req, &env).await? {
        Ok(Some(claims)) => {
            let result = d1_repositories::upsert_user_oauth_binding(
                &db,
                claims.id,
                provider.id,
                &oauth_user.provider_user_id,
                now,
            )
            .await?;
            if result == CustomOAuthBindingUpsert::Conflict {
                return Ok(envelope_error_response(
                    409,
                    "this OAuth account is already bound to another user",
                ));
            }
            audit_custom_oauth_bind(
                &db,
                &claims,
                &req,
                &provider,
                &oauth_user.provider_user_id,
                "custom_oauth.bind",
                "bound custom OAuth provider",
            )
            .await;
            let mut response =
                oauth_ok_response_with_message("bind", &serde_json::json!({"action": "bind"}))?;
            crate::admin_oauth::attach_clear_oauth_state_cookie(&mut response)?;
            return Ok(response);
        }
        Ok(None) => {}
        Err(response) => return Ok(response),
    }

    let user = match d1_repositories::find_user_by_custom_oauth_binding(
        &db,
        provider.id,
        &oauth_user.provider_user_id,
    )
    .await?
    {
        Some(user) => user,
        None => {
            let username = choose_custom_oauth_username(&db, &provider, &oauth_user).await?;
            let display_name = if oauth_user.display_name.trim().is_empty() {
                if oauth_user.username.trim().is_empty() {
                    format!("{} User", provider.name)
                } else {
                    oauth_user.username.clone()
                }
            } else {
                oauth_user.display_name.clone()
            };
            let Some(aff_code) = crate::admin_2fa::new_pending_token() else {
                return Ok(envelope_error_response(500, "failed to provision account"));
            };
            let user_id = match d1_repositories::create_custom_oauth_user_with_binding(
                &db,
                &username,
                &display_name,
                &oauth_user.email,
                &aff_code,
                provider.id,
                &oauth_user.provider_user_id,
                now,
            )
            .await
            {
                Ok(user_id) => user_id,
                Err(err) => {
                    worker::console_error!(
                        "custom OAuth user+binding create failed for {}: {}",
                        provider.slug,
                        err
                    );
                    return Ok(envelope_error_response(
                        409,
                        "this OAuth account is already bound to another user",
                    ));
                }
            };
            match d1_repositories::find_user_by_id(&db, user_id).await? {
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
    let mut response = oauth_ok_response_with_message("", &LoginResponse::from_row(&user))?;
    crate::admin::attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    crate::admin_oauth::attach_clear_oauth_state_cookie(&mut response)?;
    Ok(response)
}

async fn start_custom_oauth_redirect(
    req: Request,
    env: Env,
    provider: CustomOAuthProviderRow,
    provider_key: &str,
) -> WorkerResult<Response> {
    let redirect_uri = match crate::admin_oauth::query_param(&req, "redirect") {
        Some(redirect) if !redirect.trim().is_empty() => {
            match validate_custom_redirect_uri(&req, &env, &redirect) {
                Ok(redirect) => redirect,
                Err(message) => return Ok(envelope_error_response(400, &message)),
            }
        }
        _ => default_custom_callback_url(&req, &env, provider_key),
    };
    let (state, browser_binding) =
        crate::admin_oauth::new_oauth_state_with_payload(&env, Some(&redirect_uri)).await?;
    let authorization_url = build_custom_authorization_url(&provider, &redirect_uri, &state)?;
    let mut response = Response::empty()?.with_status(302);
    response.headers_mut().set("Location", &authorization_url)?;
    crate::admin_oauth::attach_oauth_state_cookie(&mut response, &browser_binding)?;
    Ok(response)
}

fn build_custom_authorization_url(
    provider: &CustomOAuthProviderRow,
    redirect_uri: &str,
    state: &str,
) -> WorkerResult<String> {
    let url = validate_public_oauth_url(&provider.authorization_endpoint).map_err(|message| {
        worker::Error::RustError(format!("invalid authorization URL: {message}"))
    })?;
    let mut parsed = url::Url::parse(&url)
        .map_err(|err| worker::Error::RustError(format!("invalid authorization URL: {err}")))?;
    {
        let mut query = parsed.query_pairs_mut();
        query.append_pair("client_id", &provider.client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("response_type", "code");
        query.append_pair("state", state);
        if !provider.scopes.trim().is_empty() {
            query.append_pair("scope", provider.scopes.trim());
        }
    }
    Ok(parsed.to_string())
}

async fn fetch_custom_oauth_user(
    provider: &CustomOAuthProviderRow,
    code: &str,
    redirect_uri: &str,
) -> Result<Option<CustomOAuthUser>, String> {
    let token = fetch_custom_oauth_token(provider, code, redirect_uri).await?;
    fetch_custom_oauth_userinfo(provider, &token).await
}

async fn fetch_custom_oauth_token(
    provider: &CustomOAuthProviderRow,
    code: &str,
    redirect_uri: &str,
) -> Result<CustomOAuthToken, String> {
    let token_url = validate_public_oauth_url(&provider.token_endpoint)
        .map_err(|message| format!("custom OAuth token endpoint is not allowed: {message}"))?;
    let auth_style = match provider.auth_style {
        2 => 2,
        _ => 1,
    };
    let mut body = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ];
    if auth_style == 1 {
        body.push(("client_id", &provider.client_id));
        body.push(("client_secret", &provider.client_secret));
    }
    let body = form_body(&body);
    let mut headers = Headers::new();
    headers
        .set("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|err| err.to_string())?;
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("User-Agent", "cinatoken-rust")
        .map_err(|err| err.to_string())?;
    if auth_style == 2 {
        let encoded =
            BASE64_STANDARD.encode(format!("{}:{}", provider.client_id, provider.client_secret));
        headers
            .set("Authorization", &format!("Basic {encoded}"))
            .map_err(|err| err.to_string())?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&body)));
    let request = Request::new_with_init(&token_url, &init)
        .map_err(|err| format!("failed to build token request: {err}"))?;
    let mut response = send_request_with_timeout(request, OAUTH_FETCH_TIMEOUT)
        .await
        .map_err(|err| format!("failed to fetch OAuth token: {err}"))?;
    let status = response.status_code();
    let bytes = read_limited_response_body(&mut response, OAUTH_TOKEN_BODY_LIMIT_BYTES).await?;
    let parsed = parse_token_response(&bytes)?;
    if !parsed.error.trim().is_empty() {
        let detail = if parsed.error_description.trim().is_empty() {
            parsed.error
        } else {
            parsed.error_description
        };
        return Err(format!("custom OAuth token exchange failed: {detail}"));
    }
    if !(200..=299).contains(&status) {
        return Err(format!("custom OAuth token exchange failed: HTTP {status}"));
    }
    if parsed.access_token.trim().is_empty() {
        return Err("custom OAuth token exchange returned no access token".to_string());
    }
    Ok(CustomOAuthToken {
        access_token: parsed.access_token,
        token_type: parsed.token_type,
    })
}

async fn fetch_custom_oauth_userinfo(
    provider: &CustomOAuthProviderRow,
    token: &CustomOAuthToken,
) -> Result<Option<CustomOAuthUser>, String> {
    let userinfo_url = validate_public_oauth_url(&provider.user_info_endpoint)
        .map_err(|message| format!("custom OAuth userinfo endpoint is not allowed: {message}"))?;
    let mut headers = Headers::new();
    headers
        .set(
            "Authorization",
            &format!(
                "{} {}",
                normalize_authorization_token_type(&token.token_type),
                token.access_token
            ),
        )
        .map_err(|err| err.to_string())?;
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    headers
        .set("User-Agent", "cinatoken-rust")
        .map_err(|err| err.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(&userinfo_url, &init)
        .map_err(|err| format!("failed to build userinfo request: {err}"))?;
    let mut response = send_request_with_timeout(request, OAUTH_FETCH_TIMEOUT)
        .await
        .map_err(|err| format!("failed to fetch OAuth userinfo: {err}"))?;
    if response.status_code() != 200 {
        return Err(format!(
            "custom OAuth userinfo request failed: HTTP {}",
            response.status_code()
        ));
    }
    let bytes = read_limited_response_body(&mut response, OAUTH_USERINFO_BODY_LIMIT_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|err| format!("custom OAuth userinfo is not valid JSON: {err}"))?;
    let provider_user_id = json_path_string(&value, &provider.user_id_field);
    if provider_user_id.trim().is_empty() {
        return Ok(None);
    }
    if let Some(message) = access_policy_denial(provider, &value)? {
        return Err(message);
    }
    Ok(Some(CustomOAuthUser {
        provider_user_id,
        username: json_path_string(&value, &provider.username_field),
        display_name: json_path_string(&value, &provider.display_name_field),
        email: json_path_string(&value, &provider.email_field),
    }))
}

async fn send_request_with_timeout(
    request: Request,
    timeout: Duration,
) -> Result<Response, String> {
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = Fetch::Request(request);
    let request = fetch.send_with_signal(&signal);
    let delay = Delay::from(timeout);
    futures_util::pin_mut!(request);
    futures_util::pin_mut!(delay);
    match select(request, delay).await {
        Either::Left((result, _)) => result.map_err(|err| err.to_string()),
        Either::Right(((), _)) => {
            controller.abort();
            Err("request timed out".to_string())
        }
    }
}

fn parse_token_response(bytes: &[u8]) -> Result<TokenResponseBody, String> {
    match serde_json::from_slice::<TokenResponseBody>(bytes) {
        Ok(value) => Ok(value),
        Err(_) => {
            let mut parsed = TokenResponseBody::default();
            for (key, value) in url::form_urlencoded::parse(bytes) {
                match key.as_ref() {
                    "access_token" => parsed.access_token = value.into_owned(),
                    "token_type" => parsed.token_type = value.into_owned(),
                    "error" => parsed.error = value.into_owned(),
                    "error_description" => parsed.error_description = value.into_owned(),
                    _ => {}
                }
            }
            Ok(parsed)
        }
    }
}

fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        form.append_pair(key, value);
    }
    form.finish()
}

fn normalize_authorization_token_type(token_type: &str) -> String {
    let token_type = token_type.trim();
    if token_type.is_empty() || token_type.eq_ignore_ascii_case("bearer") {
        "Bearer".to_string()
    } else {
        token_type.to_string()
    }
}

fn validate_public_oauth_url(raw: &str) -> Result<String, String> {
    let parsed = SsrfPolicy::strict_default()
        .validate_url(raw.trim())
        .map_err(|err| err.to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("URL must not contain a fragment".to_string());
    }
    Ok(parsed.to_string())
}

fn validate_custom_redirect_uri(req: &Request, env: &Env, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("redirect URI is required".to_string());
    }
    let parsed = url::Url::parse(raw).map_err(|_| "redirect URI must be absolute".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("redirect URI must be HTTP(S)".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("redirect URI must not contain a fragment".to_string());
    }
    if !parsed.path().starts_with("/oauth/") {
        return Err("redirect URI must target the frontend OAuth callback".to_string());
    }
    let origin = origin_of(&parsed);
    let mut allowed = Vec::new();
    if let Some(origin) = request_origin(req) {
        allowed.push(origin);
    }
    if let Some(origin) = frontend_base_origin(env) {
        allowed.push(origin);
    }
    if !allowed
        .iter()
        .any(|allowed_origin| allowed_origin == &origin)
    {
        return Err("redirect URI origin is not allowed".to_string());
    }
    Ok(parsed.to_string())
}

fn default_custom_callback_url(req: &Request, env: &Env, provider_key: &str) -> String {
    let base = request_origin(req)
        .or_else(|| frontend_base_url(env))
        .unwrap_or_default();
    let encoded_provider =
        url::form_urlencoded::byte_serialize(provider_key.as_bytes()).collect::<String>();
    format!("{}/oauth/{}", base.trim_end_matches('/'), encoded_provider)
}

fn frontend_base_url(env: &Env) -> Option<String> {
    env.var("FRONTEND_BASE_URL")
        .map(|value| value.to_string())
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty() && value != "/")
}

fn frontend_base_origin(env: &Env) -> Option<String> {
    let base = frontend_base_url(env)?;
    let parsed = url::Url::parse(&base).ok()?;
    Some(origin_of(&parsed))
}

fn request_origin(req: &Request) -> Option<String> {
    req.headers()
        .get("Origin")
        .ok()
        .flatten()
        .and_then(|origin| url::Url::parse(origin.trim()).ok())
        .map(|url| origin_of(&url))
        .or_else(|| req.url().ok().map(|url| origin_of(&url)))
}

#[cfg(test)]
fn request_origin_from_parts(origin_header: Option<&str>, request_url: &str) -> Option<String> {
    origin_header
        .and_then(|origin| url::Url::parse(origin.trim()).ok())
        .map(|url| origin_of(&url))
        .or_else(|| url::Url::parse(request_url).ok().map(|url| origin_of(&url)))
}

fn origin_of(url: &url::Url) -> String {
    match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or("")),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")),
    }
}

async fn choose_custom_oauth_username(
    db: &worker::D1Database,
    provider: &CustomOAuthProviderRow,
    oauth_user: &CustomOAuthUser,
) -> WorkerResult<String> {
    let preferred = normalize_username_candidate(&oauth_user.username);
    if !preferred.is_empty()
        && preferred.len() <= CUSTOM_OAUTH_USERNAME_MAX_LEN
        && d1_repositories::find_user_by_username_or_email(db, &preferred)
            .await?
            .is_none()
    {
        return Ok(preferred);
    }
    let next_id = d1_repositories::max_user_id(db).await? + 1;
    let mut prefix = format!("{}_", provider.slug);
    if prefix.len() > CUSTOM_OAUTH_USERNAME_MAX_LEN.saturating_sub(8) {
        prefix.truncate(CUSTOM_OAUTH_USERNAME_MAX_LEN.saturating_sub(8));
    }
    Ok(format!("{prefix}{next_id}"))
}

fn normalize_username_candidate(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .collect()
}

fn json_path_string(value: &Value, path: &str) -> String {
    let Some(value) = json_path_value(value, path) else {
        return String::new();
    };
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_path_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        let segment = segment.trim();
        if segment.is_empty() {
            return None;
        }
        match current {
            Value::Object(map) => current = map.get(segment)?,
            Value::Array(items) => {
                let index = segment.parse::<usize>().ok()?;
                current = items.get(index)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

#[derive(Debug, Deserialize)]
struct RuntimeAccessPolicy {
    #[serde(default)]
    logic: String,
    #[serde(default)]
    conditions: Vec<RuntimeAccessCondition>,
    #[serde(default)]
    groups: Vec<RuntimeAccessPolicy>,
}

#[derive(Debug, Deserialize)]
struct RuntimeAccessCondition {
    field: String,
    op: String,
    #[serde(default)]
    value: Value,
}

#[derive(Debug)]
struct AccessPolicyFailure {
    field: String,
    op: String,
    expected: Value,
    current: Value,
}

fn access_policy_denial(
    provider: &CustomOAuthProviderRow,
    userinfo: &Value,
) -> Result<Option<String>, String> {
    let raw = provider.access_policy.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let policy = serde_json::from_str::<RuntimeAccessPolicy>(raw)
        .map_err(|err| format!("custom OAuth access policy is invalid: {err}"))?;
    match evaluate_access_policy(userinfo, &policy) {
        Ok(()) => Ok(None),
        Err(failure) => Ok(Some(render_access_denied_message(
            &provider.access_denied_message,
            &provider.name,
            userinfo,
            &failure,
        ))),
    }
}

fn evaluate_access_policy(
    userinfo: &Value,
    policy: &RuntimeAccessPolicy,
) -> Result<(), AccessPolicyFailure> {
    let logic = policy.logic.trim().to_ascii_lowercase();
    let logic = if logic.is_empty() { "and" } else { &logic };
    if logic == "or" {
        let mut first_failure = None;
        for condition in &policy.conditions {
            match evaluate_access_condition(userinfo, condition) {
                Ok(()) => return Ok(()),
                Err(failure) => {
                    if first_failure.is_none() {
                        first_failure = Some(failure);
                    }
                }
            }
        }
        for group in &policy.groups {
            match evaluate_access_policy(userinfo, group) {
                Ok(()) => return Ok(()),
                Err(failure) => {
                    if first_failure.is_none() {
                        first_failure = Some(failure);
                    }
                }
            }
        }
        return Err(first_failure.unwrap_or_else(|| AccessPolicyFailure {
            field: String::new(),
            op: "or".to_string(),
            expected: Value::Bool(true),
            current: Value::Bool(false),
        }));
    }

    for condition in &policy.conditions {
        evaluate_access_condition(userinfo, condition)?;
    }
    for group in &policy.groups {
        evaluate_access_policy(userinfo, group)?;
    }
    Ok(())
}

fn evaluate_access_condition(
    userinfo: &Value,
    condition: &RuntimeAccessCondition,
) -> Result<(), AccessPolicyFailure> {
    let op = condition.op.trim().to_ascii_lowercase();
    let current = json_path_value(userinfo, &condition.field)
        .cloned()
        .unwrap_or(Value::Null);
    let failure = || AccessPolicyFailure {
        field: condition.field.clone(),
        op: op.clone(),
        expected: condition.value.clone(),
        current: current.clone(),
    };
    let ok = match op.as_str() {
        "exists" => !current.is_null(),
        "not_exists" => current.is_null(),
        "eq" => compare_json_values(&current, &condition.value) == 0,
        "ne" => compare_json_values(&current, &condition.value) != 0,
        "gt" => compare_json_values(&current, &condition.value) > 0,
        "gte" => compare_json_values(&current, &condition.value) >= 0,
        "lt" => compare_json_values(&current, &condition.value) < 0,
        "lte" => compare_json_values(&current, &condition.value) <= 0,
        "in" => value_in_array(&current, &condition.value),
        "not_in" => !value_in_array(&current, &condition.value),
        "contains" => contains_json_value(&current, &condition.value),
        "not_contains" => !contains_json_value(&current, &condition.value),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(failure())
    }
}

fn compare_json_values(left: &Value, right: &Value) -> i8 {
    if let (Some(left), Some(right)) = (json_as_f64(left), json_as_f64(right)) {
        return left
            .partial_cmp(&right)
            .map(|ordering| match ordering {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            })
            .unwrap_or(0);
    }
    let left = json_display_value(left);
    let right = json_display_value(right);
    match left.cmp(&right) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn json_as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn value_in_array(current: &Value, expected: &Value) -> bool {
    expected.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| compare_json_values(current, item) == 0)
    })
}

fn contains_json_value(current: &Value, expected: &Value) -> bool {
    match current {
        Value::String(value) => value.contains(&json_display_value(expected)),
        Value::Array(items) => items
            .iter()
            .any(|item| compare_json_values(item, expected) == 0),
        _ => false,
    }
}

fn render_access_denied_message(
    template: &str,
    provider_name: &str,
    userinfo: &Value,
    failure: &AccessPolicyFailure,
) -> String {
    let mut message = template.trim().to_string();
    if message.is_empty() {
        return "Access denied: your account does not meet this provider's access requirements."
            .to_string();
    }
    let replacements = [
        ("{{provider}}", provider_name.to_string()),
        ("{{field}}", failure.field.clone()),
        ("{{op}}", failure.op.clone()),
        ("{{required}}", json_display_value(&failure.expected)),
        ("{{current}}", json_display_value(&failure.current)),
    ];
    for (token, value) in replacements {
        message = message.replace(token, &value);
    }
    replace_path_placeholders(&message, "{{current.", "}}", |path| {
        json_path_string(userinfo, path)
    })
}

fn replace_path_placeholders(
    input: &str,
    prefix: &str,
    suffix: &str,
    value: impl Fn(&str) -> String,
) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(prefix) {
        out.push_str(&rest[..start]);
        let after_prefix = &rest[start + prefix.len()..];
        let Some(end) = after_prefix.find(suffix) else {
            out.push_str(&rest[start..]);
            return out;
        };
        let path = &after_prefix[..end];
        out.push_str(&value(path.trim()));
        rest = &after_prefix[end + suffix.len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn json_display_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

async fn audit_custom_oauth_bind(
    db: &worker::D1Database,
    claims: &cinatoken_session::SessionClaims,
    req: &Request,
    provider: &CustomOAuthProviderRow,
    provider_user_id: &str,
    action: &str,
    verb: &str,
) {
    let _ = d1_repositories::insert_admin_audit_log(
        db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        action,
        &format!("user {} {verb} {}", claims.username, provider.slug),
        &serde_json::json!({
            "provider_id": provider.id,
            "slug": &provider.slug,
            "provider_user_id": provider_user_id
        }),
        &admin_audit_info(claims, req),
        unix_timestamp(),
    )
    .await;
}

fn oauth_ok_response_with_message<T: Serialize>(message: &str, data: &T) -> WorkerResult<Response> {
    let body = ApiEnvelope {
        success: true,
        message: message.to_string(),
        data,
    };
    let mut response = Response::from_json(&body)?.with_status(200);
    set_cors_headers(&mut response)?;
    Ok(response)
}

fn oauth_business_error_response(status: u16, message: &str) -> WorkerResult<Response> {
    let body = ApiEnvelope {
        success: false,
        message: message.to_string(),
        data: Value::Null,
    };
    let mut response = Response::from_json(&body)?.with_status(status);
    set_cors_headers(&mut response)?;
    Ok(response)
}

pub(crate) fn status_provider(row: CustomOAuthProviderRow) -> CustomOAuthStatusProvider {
    CustomOAuthStatusProvider {
        id: row.id,
        name: row.name,
        slug: row.slug,
        icon: row.icon,
        client_id: row.client_id,
        authorization_endpoint: row.authorization_endpoint,
        scopes: row.scopes,
    }
}

fn provider_response(row: CustomOAuthProviderRow) -> CustomOAuthProviderResponse {
    CustomOAuthProviderResponse {
        id: row.id,
        name: row.name,
        slug: row.slug,
        icon: row.icon,
        enabled: row.enabled != 0,
        client_id: row.client_id,
        authorization_endpoint: row.authorization_endpoint,
        token_endpoint: row.token_endpoint,
        user_info_endpoint: row.user_info_endpoint,
        scopes: row.scopes,
        user_id_field: row.user_id_field,
        username_field: row.username_field,
        display_name_field: row.display_name_field,
        email_field: row.email_field,
        well_known: row.well_known,
        auth_style: row.auth_style,
        access_policy: row.access_policy,
        access_denied_message: row.access_denied_message,
    }
}

fn normalize_create_request(
    req: CreateCustomOAuthProviderRequest,
) -> Result<(ProviderConfig, String), String> {
    let config = ProviderConfig {
        name: trim_owned(req.name),
        slug: normalize_slug(&req.slug),
        icon: trim_owned(req.icon),
        enabled: req.enabled,
        client_id: trim_owned(req.client_id),
        authorization_endpoint: trim_owned(req.authorization_endpoint),
        token_endpoint: trim_owned(req.token_endpoint),
        user_info_endpoint: trim_owned(req.user_info_endpoint),
        scopes: defaulted(req.scopes, DEFAULT_SCOPES),
        user_id_field: defaulted(req.user_id_field, DEFAULT_USER_ID_FIELD),
        username_field: defaulted(req.username_field, DEFAULT_USERNAME_FIELD),
        display_name_field: defaulted(req.display_name_field, DEFAULT_DISPLAY_NAME_FIELD),
        email_field: defaulted(req.email_field, DEFAULT_EMAIL_FIELD),
        well_known: trim_owned(req.well_known),
        auth_style: req.auth_style,
        access_policy: trim_owned(req.access_policy),
        access_denied_message: trim_owned(req.access_denied_message),
    };
    validate_provider_config(&config)?;
    let client_secret = trim_owned(req.client_secret);
    if client_secret.is_empty() {
        return Err("client secret is required".to_string());
    }
    Ok((config, client_secret))
}

fn normalize_update_request(
    existing: &CustomOAuthProviderRow,
    req: UpdateCustomOAuthProviderRequest,
) -> Result<(ProviderConfig, Option<String>), String> {
    let mut config = provider_config_from_row(existing);
    update_if_nonempty(&mut config.name, req.name);
    update_if_nonempty_with(&mut config.slug, req.slug, |value| normalize_slug(&value));
    if let Some(icon) = req.icon {
        config.icon = trim_owned(icon);
    }
    if let Some(enabled) = req.enabled {
        config.enabled = enabled;
    }
    update_if_nonempty(&mut config.client_id, req.client_id);
    update_if_nonempty(
        &mut config.authorization_endpoint,
        req.authorization_endpoint,
    );
    update_if_nonempty(&mut config.token_endpoint, req.token_endpoint);
    update_if_nonempty(&mut config.user_info_endpoint, req.user_info_endpoint);
    update_if_nonempty_with(&mut config.scopes, req.scopes, |value| {
        defaulted(value, DEFAULT_SCOPES)
    });
    update_if_nonempty_with(&mut config.user_id_field, req.user_id_field, |value| {
        defaulted(value, DEFAULT_USER_ID_FIELD)
    });
    update_if_nonempty_with(&mut config.username_field, req.username_field, |value| {
        defaulted(value, DEFAULT_USERNAME_FIELD)
    });
    update_if_nonempty_with(
        &mut config.display_name_field,
        req.display_name_field,
        |value| defaulted(value, DEFAULT_DISPLAY_NAME_FIELD),
    );
    update_if_nonempty_with(&mut config.email_field, req.email_field, |value| {
        defaulted(value, DEFAULT_EMAIL_FIELD)
    });
    if let Some(well_known) = req.well_known {
        config.well_known = trim_owned(well_known);
    }
    if let Some(auth_style) = req.auth_style {
        config.auth_style = auth_style;
    }
    if let Some(policy) = req.access_policy {
        config.access_policy = trim_owned(policy);
    }
    if let Some(message) = req.access_denied_message {
        config.access_denied_message = trim_owned(message);
    }
    let client_secret_update = req
        .client_secret
        .map(trim_owned)
        .filter(|value| !value.is_empty());
    validate_provider_config(&config)?;
    Ok((config, client_secret_update))
}

fn provider_config_from_row(row: &CustomOAuthProviderRow) -> ProviderConfig {
    ProviderConfig {
        name: row.name.clone(),
        slug: row.slug.clone(),
        icon: row.icon.clone(),
        enabled: row.enabled != 0,
        client_id: row.client_id.clone(),
        authorization_endpoint: row.authorization_endpoint.clone(),
        token_endpoint: row.token_endpoint.clone(),
        user_info_endpoint: row.user_info_endpoint.clone(),
        scopes: row.scopes.clone(),
        user_id_field: row.user_id_field.clone(),
        username_field: row.username_field.clone(),
        display_name_field: row.display_name_field.clone(),
        email_field: row.email_field.clone(),
        well_known: row.well_known.clone(),
        auth_style: row.auth_style,
        access_policy: row.access_policy.clone(),
        access_denied_message: row.access_denied_message.clone(),
    }
}

fn validate_provider_config(config: &ProviderConfig) -> Result<(), String> {
    if config.name.is_empty() {
        return Err("provider name is required".to_string());
    }
    if config.slug.is_empty() {
        return Err("provider slug is required".to_string());
    }
    if !valid_slug(&config.slug) {
        return Err(
            "provider slug must contain only lowercase letters, numbers, and hyphens".to_string(),
        );
    }
    if config.client_id.is_empty() {
        return Err("client ID is required".to_string());
    }
    if config.authorization_endpoint.is_empty() {
        return Err("authorization endpoint is required".to_string());
    }
    if config.token_endpoint.is_empty() {
        return Err("token endpoint is required".to_string());
    }
    if config.user_info_endpoint.is_empty() {
        return Err("user info endpoint is required".to_string());
    }
    if !(0..=2).contains(&config.auth_style) {
        return Err("auth_style must be 0, 1, or 2".to_string());
    }
    if !config.access_policy.trim().is_empty() {
        validate_access_policy_json(&config.access_policy)
            .map_err(|message| format!("access_policy is invalid: {message}"))?;
    }
    Ok(())
}

async fn reject_slug_conflict(
    db: &worker::D1Database,
    slug: &str,
    exclude_id: Option<i64>,
) -> WorkerResult<Option<Response>> {
    if BUILTIN_PROVIDER_SLUGS.contains(&slug) {
        return Ok(Some(envelope_error_response(
            409,
            "provider slug conflicts with a built-in OAuth provider",
        )));
    }
    if d1_repositories::custom_oauth_slug_taken(db, slug, exclude_id).await? {
        return Ok(Some(envelope_error_response(
            409,
            "provider slug is already used",
        )));
    }
    Ok(None)
}

async fn audit_custom_oauth(
    db: &worker::D1Database,
    claims: &cinatoken_session::SessionClaims,
    req: &Request,
    action: &str,
    verb: &str,
    row: &CustomOAuthProviderRow,
) {
    let _ = d1_repositories::insert_admin_audit_log(
        db,
        None,
        None,
        &claims.username,
        action,
        &format!("root {} {verb} {}", claims.username, row.slug),
        &serde_json::json!({"provider_id": row.id, "slug": &row.slug, "name": &row.name}),
        &admin_audit_info(claims, req),
        unix_timestamp(),
    )
    .await;
}

fn discovery_target_url(well_known_url: &str, issuer_url: &str) -> Result<String, String> {
    let well_known_url = well_known_url.trim();
    let issuer_url = issuer_url.trim();
    if well_known_url.is_empty() && issuer_url.is_empty() {
        return Err("please provide a Discovery URL or Issuer URL".to_string());
    }
    let target = if well_known_url.is_empty() {
        format!(
            "{}/.well-known/openid-configuration",
            issuer_url.trim_end_matches('/')
        )
    } else {
        well_known_url.to_string()
    };
    let parsed = SsrfPolicy::strict_default()
        .validate_url(target.trim())
        .map_err(|err| format!("Discovery URL is not allowed: {err}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Discovery URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("Discovery URL must not contain a fragment".to_string());
    }
    Ok(parsed.to_string())
}

async fn fetch_discovery_json(target: &str) -> Result<Value, String> {
    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(target, &init)
        .map_err(|err| format!("failed to build Discovery request: {err}"))?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = Fetch::Request(request);
    let request = fetch.send_with_signal(&signal);
    let delay = Delay::from(DISCOVERY_TIMEOUT);
    futures_util::pin_mut!(request);
    futures_util::pin_mut!(delay);
    let mut response = match select(request, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|err| format!("failed to fetch Discovery document: {err}"))?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err("failed to fetch Discovery document: request timed out".to_string());
        }
    };
    if response.status_code() != 200 {
        let status = response.status_code();
        let message = read_limited_response_body(&mut response, DISCOVERY_ERROR_BODY_LIMIT_BYTES)
            .await
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty())
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("failed to fetch Discovery document: {message}"));
    }
    let bytes = read_limited_response_body(&mut response, DISCOVERY_BODY_LIMIT_BYTES).await?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|err| format!("failed to parse Discovery document: {err}"))
}

async fn read_limited_response_body(
    response: &mut Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if let Some(raw) = response
        .headers()
        .get("Content-Length")
        .map_err(|err| format!("failed to inspect response headers: {err}"))?
    {
        let raw = raw.trim();
        if !raw.is_empty() {
            let length = raw
                .parse::<usize>()
                .map_err(|_| "response Content-Length is invalid".to_string())?;
            if length > limit {
                return Err(format!("response exceeds {limit} byte limit"));
            }
        }
    }
    response
        .stream()
        .map_err(|err| format!("failed to read response: {err}"))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(worker::Error::RustError(format!(
                    "response exceeds {limit} byte limit"
                )));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| err.to_string())
}

fn validate_access_policy_json(raw: &str) -> Result<(), String> {
    let value = serde_json::from_str::<Value>(raw)
        .map_err(|_| "access_policy must be valid JSON".to_string())?;
    validate_access_policy_value(&value)
}

fn validate_access_policy_value(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "policy must be an object".to_string())?;
    let logic = object
        .get("logic")
        .and_then(Value::as_str)
        .map(|logic| logic.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "and".to_string());
    if logic != "and" && logic != "or" {
        return Err(format!("unsupported logic: {logic}"));
    }

    let empty_conditions = Vec::new();
    let conditions = match object.get("conditions") {
        Some(Value::Array(items)) => items,
        Some(_) => return Err("conditions must be an array".to_string()),
        None => &empty_conditions,
    };
    let empty_groups = Vec::new();
    let groups = match object.get("groups") {
        Some(Value::Array(items)) => items,
        Some(_) => return Err("groups must be an array".to_string()),
        None => &empty_groups,
    };
    if conditions.is_empty() && groups.is_empty() {
        return Err("policy requires at least one condition or group".to_string());
    }

    for (index, condition) in conditions.iter().enumerate() {
        validate_access_condition(index, condition)?;
    }
    for (index, group) in groups.iter().enumerate() {
        validate_access_policy_value(group)
            .map_err(|message| format!("group[{index}]: {message}"))?;
    }
    Ok(())
}

fn validate_access_condition(index: usize, condition: &Value) -> Result<(), String> {
    let object = condition
        .as_object()
        .ok_or_else(|| format!("condition[{index}] must be an object"))?;
    let field = object
        .get("field")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if field.is_empty() {
        return Err(format!("condition[{index}].field is required"));
    }
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .map(|op| op.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !supported_access_policy_op(&op) {
        return Err(format!("condition[{index}].op is unsupported: {op}"));
    }
    if matches!(op.as_str(), "in" | "not_in") && !object.get("value").is_some_and(Value::is_array) {
        return Err(format!(
            "condition[{index}].value must be an array for op {op}"
        ));
    }
    Ok(())
}

fn supported_access_policy_op(op: &str) -> bool {
    matches!(
        op,
        "eq" | "ne"
            | "gt"
            | "gte"
            | "lt"
            | "lte"
            | "in"
            | "not_in"
            | "contains"
            | "not_contains"
            | "exists"
            | "not_exists"
    )
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|id| *id > 0 && *id <= i32::MAX as i64)
}

fn trim_owned(value: String) -> String {
    value.trim().to_string()
}

fn defaulted(value: String, default: &str) -> String {
    let value = trim_owned(value);
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

fn normalize_slug(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn valid_slug(slug: &str) -> bool {
    slug.bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn update_if_nonempty(target: &mut String, value: Option<String>) {
    update_if_nonempty_with(target, value, trim_owned);
}

fn update_if_nonempty_with(
    target: &mut String,
    value: Option<String>,
    normalize: impl FnOnce(String) -> String,
) {
    if let Some(value) = value {
        let value = normalize(value);
        if !value.is_empty() {
            *target = value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_create(slug: &str) -> CreateCustomOAuthProviderRequest {
        CreateCustomOAuthProviderRequest {
            name: "Example".to_string(),
            slug: slug.to_string(),
            icon: String::new(),
            enabled: true,
            client_id: "client".to_string(),
            client_secret: "secret".to_string(),
            authorization_endpoint: "https://idp.example/authorize".to_string(),
            token_endpoint: "https://idp.example/token".to_string(),
            user_info_endpoint: "https://idp.example/userinfo".to_string(),
            scopes: String::new(),
            user_id_field: String::new(),
            username_field: String::new(),
            display_name_field: String::new(),
            email_field: String::new(),
            well_known: String::new(),
            auth_style: 0,
            access_policy: String::new(),
            access_denied_message: String::new(),
        }
    }

    fn provider_row() -> CustomOAuthProviderRow {
        CustomOAuthProviderRow {
            id: 7,
            name: "Corp".to_string(),
            slug: "corp".to_string(),
            icon: String::new(),
            enabled: 1,
            client_id: "client".to_string(),
            client_secret: "secret".to_string(),
            authorization_endpoint: "https://idp.example/authorize".to_string(),
            token_endpoint: "https://idp.example/token".to_string(),
            user_info_endpoint: "https://idp.example/userinfo".to_string(),
            scopes: "openid profile email".to_string(),
            user_id_field: "account.id".to_string(),
            username_field: "account.username".to_string(),
            display_name_field: "account.name".to_string(),
            email_field: "account.email".to_string(),
            well_known: String::new(),
            auth_style: 1,
            access_policy: String::new(),
            access_denied_message: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn normalize_create_defaults_fields_and_lowercases_slug() {
        let (config, secret) = normalize_create_request(valid_create("Corp-IDP")).unwrap();
        assert_eq!(config.slug, "corp-idp");
        assert_eq!(config.scopes, DEFAULT_SCOPES);
        assert_eq!(config.user_id_field, DEFAULT_USER_ID_FIELD);
        assert_eq!(config.username_field, DEFAULT_USERNAME_FIELD);
        assert_eq!(secret, "secret");
    }

    #[test]
    fn validate_rejects_invalid_slug_and_auth_style() {
        let mut req = valid_create("bad_slug");
        assert!(normalize_create_request(req).is_err());
        req = valid_create("good-slug");
        req.auth_style = 9;
        assert!(normalize_create_request(req).is_err());
    }

    #[test]
    fn validates_nested_access_policy() {
        let policy = serde_json::json!({
            "logic": "and",
            "conditions": [{"field": "email", "op": "contains", "value": "@example.com"}],
            "groups": [{
                "logic": "or",
                "conditions": [{"field": "groups", "op": "in", "value": ["staff"]}]
            }]
        })
        .to_string();
        validate_access_policy_json(&policy).unwrap();

        let invalid = serde_json::json!({
            "conditions": [{"field": "groups", "op": "in", "value": "staff"}]
        })
        .to_string();
        assert!(validate_access_policy_json(&invalid).is_err());
    }

    #[test]
    fn authorization_url_includes_callback_state_and_scopes() {
        let url = build_custom_authorization_url(
            &provider_row(),
            "https://app.example/oauth/corp",
            "state-123",
        )
        .unwrap();

        assert!(url.starts_with("https://idp.example/authorize?"));
        assert!(url.contains("client_id=client"));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fapp.example%2Foauth%2Fcorp"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("state=state-123"));
        assert!(url.contains("scope=openid+profile+email"));
    }

    #[test]
    fn token_response_accepts_json_and_form_encoding() {
        let json = br#"{"access_token":"tok","token_type":"mac"}"#;
        let parsed = parse_token_response(json).unwrap();
        assert_eq!(parsed.access_token, "tok");
        assert_eq!(parsed.token_type, "mac");

        let parsed = parse_token_response(b"access_token=tok2&token_type=Bearer").unwrap();
        assert_eq!(parsed.access_token, "tok2");
        assert_eq!(parsed.token_type, "Bearer");
    }

    #[test]
    fn userinfo_path_extraction_supports_nested_numbers() {
        let value = serde_json::json!({
            "account": {
                "id": 42,
                "username": "alice",
                "name": "Alice Example",
                "email": "alice@example.com"
            }
        });

        assert_eq!(json_path_string(&value, "account.id"), "42");
        assert_eq!(json_path_string(&value, "account.username"), "alice");
        assert_eq!(json_path_string(&value, "missing.path"), "");
    }

    #[test]
    fn access_policy_allows_and_denies_with_template_context() {
        let mut provider = provider_row();
        provider.access_policy = serde_json::json!({
            "logic": "and",
            "conditions": [
                {"field": "email", "op": "contains", "value": "@example.com"},
                {"field": "groups", "op": "contains", "value": "staff"}
            ]
        })
        .to_string();
        provider.access_denied_message =
            "{{provider}} denied {{field}} {{op}} current={{current.email}}".to_string();

        let allowed = serde_json::json!({
            "email": "alice@example.com",
            "groups": ["staff", "admin"]
        });
        assert_eq!(access_policy_denial(&provider, &allowed).unwrap(), None);

        let denied = serde_json::json!({
            "email": "mallory@other.test",
            "groups": ["guest"]
        });
        assert_eq!(
            access_policy_denial(&provider, &denied).unwrap(),
            Some("Corp denied email contains current=mallory@other.test".to_string())
        );
    }

    #[test]
    fn callback_origin_prefers_browser_origin_header() {
        assert_eq!(
            request_origin_from_parts(
                Some("https://frontend.example"),
                "https://api.example/api/oauth/corp"
            ),
            Some("https://frontend.example".to_string())
        );
        assert_eq!(
            request_origin_from_parts(None, "https://api.example/api/oauth/corp"),
            Some("https://api.example".to_string())
        );
    }

    #[test]
    fn discovery_target_accepts_well_known_or_issuer() {
        assert_eq!(
            discovery_target_url("https://idp.example/.well-known/openid-configuration", "")
                .unwrap(),
            "https://idp.example/.well-known/openid-configuration"
        );
        assert_eq!(
            discovery_target_url("", "https://idp.example/").unwrap(),
            "https://idp.example/.well-known/openid-configuration"
        );
    }

    #[test]
    fn discovery_target_rejects_ssrf_sensitive_urls() {
        assert!(
            discovery_target_url("http://127.0.0.1/.well-known/openid-configuration", "").is_err()
        );
        assert!(discovery_target_url(
            "https://user:pass@idp.example/.well-known/openid-configuration",
            ""
        )
        .is_err());
        assert!(discovery_target_url(
            "https://idp.example/.well-known/openid-configuration#frag",
            ""
        )
        .is_err());
    }

    #[test]
    fn parse_id_param_accepts_positive_i32_ids() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"0".to_string())), None);
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
    }
}
