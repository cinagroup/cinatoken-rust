//! Root-admin custom OAuth provider configuration surface.
//!
//! This ports the Go `controller/custom_oauth.go` provider CRUD and OIDC
//! discovery helper. The actual custom-provider login/bind callback flow is a
//! separate auth migration because it needs state replay protection and account
//! binding policy as one unit.

use std::time::Duration;

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
    require_root_auth, unix_timestamp,
};
use crate::d1_repositories::{
    self, CreateCustomOAuthProvider, CustomOAuthProviderRow, UpdateCustomOAuthProvider,
};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const DISCOVERY_ERROR_BODY_LIMIT_BYTES: usize = 512;
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
