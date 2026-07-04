//! Passkey/WebAuthn route boundary.
//!
//! This module ports the frontend-visible route surface and the safe half of
//! the WebAuthn ceremony to Workers: status, delete, and begin/challenge
//! generation. The finish handlers deliberately fail closed until a Worker-safe
//! verifier (or service binding/Container verifier) validates attestation and
//! assertion signatures. Accepting finish payloads without cryptographic
//! verification would be worse than leaving the route absent.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_secure_verification, require_user_auth, unix_timestamp,
};
use crate::d1_repositories::{self, PasskeyCredentialRow};
use crate::flow_state::{self, FlowKind};

const PASSKEY_OPTION_KEYS: &[&str] = &[
    "passkey.enabled",
    "passkey.rp_display_name",
    "passkey.rp_id",
    "passkey.origins",
    "passkey.allow_insecure_origin",
    "passkey.user_verification",
    "passkey.attachment_preference",
    "SystemName",
    "ServerAddress",
];
const PASSKEY_TIMEOUT_MS: u32 = 120_000;
const PASSKEY_CHALLENGE_BYTES: usize = 32;
const PASSKEY_LOGIN_COOKIE: &str = "passkey_challenge";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
struct PasskeySettings {
    enabled: bool,
    rp_display_name: String,
    rp_id: String,
    origins: Vec<String>,
    allow_insecure_origin: bool,
    user_verification: String,
    attachment_preference: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct PasskeyChallengeState {
    flow: String,
    user_id: Option<i64>,
    challenge: String,
    rp_id: String,
    origin: String,
    issued_at: i64,
}

#[derive(Debug, Serialize)]
struct PasskeyStatusResponse {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_eligible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_state: Option<bool>,
}

pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let credential = d1_repositories::find_passkey_by_user(&db, claims.id).await?;
    envelope_ok_response(&status_from_credential(credential.as_ref()))
}

pub async fn delete(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if !d1_repositories::passkey_exists_by_user(&db, claims.id).await? {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    }
    if let Some(response) = require_secure_verification(&env, claims.id).await? {
        return Ok(response);
    }
    d1_repositories::delete_passkey_by_user(&db, claims.id).await?;
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "user.passkey_delete",
        &format!("user {} deleted their Passkey", claims.username),
        &json!({"id": claims.id, "username": claims.username.clone()}),
        &admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&json!({"deleted": true}))
}

pub async fn register_begin(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    if let Some(two_fa) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
        if two_fa.is_enabled != 0 {
            if let Some(response) = require_secure_verification(&env, claims.id).await? {
                return Ok(response);
            }
        }
    }
    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };
    let existing = d1_repositories::find_passkey_by_user(&db, claims.id).await?;
    let challenge = new_challenge()?;
    let state = PasskeyChallengeState {
        flow: "register".to_string(),
        user_id: Some(claims.id),
        challenge: challenge.clone(),
        rp_id: settings.rp_id.clone(),
        origin: settings.primary_origin(),
        issued_at: unix_timestamp(),
    };
    put_challenge(&env, &challenge_key("register", claims.id), &state).await?;
    envelope_ok_response(&json!({
        "options": {
            "publicKey": creation_options(&settings, &user.username, &user.display_name, user.id, &challenge, existing.as_ref())
        }
    }))
}

pub async fn register_finish(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if let Err(response) = read_json_body(&mut req).await {
        return Ok(response);
    }
    if flow_state::take(
        &env,
        FlowKind::PasskeyChallenge,
        &challenge_key("register", claims.id),
    )
    .await?
    .is_none()
    {
        return Ok(envelope_error_response(
            400,
            "Passkey registration challenge expired; start again",
        ));
    }
    Ok(passkey_finish_unavailable_response())
}

pub async fn login_begin(req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    let challenge = new_challenge()?;
    let Some(flow_id) = crate::admin_2fa::new_pending_token() else {
        return Ok(envelope_error_response(
            500,
            "failed to start Passkey challenge",
        ));
    };
    let state = PasskeyChallengeState {
        flow: "login".to_string(),
        user_id: None,
        challenge: challenge.clone(),
        rp_id: settings.rp_id.clone(),
        origin: settings.primary_origin(),
        issued_at: unix_timestamp(),
    };
    put_challenge(&env, &challenge_key_by_flow_id("login", &flow_id), &state).await?;
    let mut response = envelope_ok_response(&json!({
        "options": {
            "publicKey": request_options(&settings, &challenge, None)
        }
    }))?;
    response.headers_mut().append(
        "Set-Cookie",
        &format!(
            "{PASSKEY_LOGIN_COOKIE}={flow_id}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict; Secure",
            FlowKind::PasskeyChallenge.default_ttl_secs()
        ),
    )?;
    Ok(response)
}

pub async fn login_finish(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = read_json_body(&mut req).await {
        return Ok(response);
    }
    let Some(flow_id) = passkey_login_cookie(&req) else {
        return Ok(envelope_error_response(
            400,
            "Passkey login challenge expired; start again",
        ));
    };
    if flow_state::take(
        &env,
        FlowKind::PasskeyChallenge,
        &challenge_key_by_flow_id("login", &flow_id),
    )
    .await?
    .is_none()
    {
        return Ok(envelope_error_response(
            400,
            "Passkey login challenge expired; start again",
        ));
    }
    let mut response = passkey_finish_unavailable_response();
    response.headers_mut().append(
        "Set-Cookie",
        &format!("{PASSKEY_LOGIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure"),
    )?;
    Ok(response)
}

pub async fn verify_begin(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    let Some(credential) = d1_repositories::find_passkey_by_user(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    };
    let challenge = new_challenge()?;
    let state = PasskeyChallengeState {
        flow: "verify".to_string(),
        user_id: Some(claims.id),
        challenge: challenge.clone(),
        rp_id: settings.rp_id.clone(),
        origin: settings.primary_origin(),
        issued_at: unix_timestamp(),
    };
    put_challenge(&env, &challenge_key("verify", claims.id), &state).await?;
    envelope_ok_response(&json!({
        "options": {
            "publicKey": request_options(&settings, &challenge, Some(&credential))
        }
    }))
}

pub async fn verify_finish(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if let Err(response) = read_json_body(&mut req).await {
        return Ok(response);
    }
    if flow_state::take(
        &env,
        FlowKind::PasskeyChallenge,
        &challenge_key("verify", claims.id),
    )
    .await?
    .is_none()
    {
        return Ok(envelope_error_response(
            400,
            "Passkey verification challenge expired; start again",
        ));
    }
    Ok(passkey_finish_unavailable_response())
}

fn status_from_credential(credential: Option<&PasskeyCredentialRow>) -> PasskeyStatusResponse {
    match credential {
        Some(credential) => PasskeyStatusResponse {
            enabled: true,
            last_used_at: credential.last_used_at,
            backup_eligible: Some(credential.backup_eligible != 0),
            backup_state: Some(credential.backup_state != 0),
        },
        None => PasskeyStatusResponse {
            enabled: false,
            last_used_at: None,
            backup_eligible: None,
            backup_state: None,
        },
    }
}

async fn passkey_settings(db: &worker::D1Database, req: &Request) -> WorkerResult<PasskeySettings> {
    let values = d1_repositories::option_values(db, PASSKEY_OPTION_KEYS).await?;
    let value = |index: usize| values.get(index).and_then(|value| value.as_deref());
    Ok(resolve_passkey_settings(
        &SettingsInput {
            enabled_raw: value(0),
            display_name_raw: value(1),
            rp_id_raw: value(2),
            origins_raw: value(3),
            allow_insecure_raw: value(4),
            user_verification_raw: value(5),
            attachment_raw: value(6),
            system_name_raw: value(7),
            server_address_raw: value(8),
        },
        request_origin(req),
    ))
}

struct SettingsInput<'a> {
    enabled_raw: Option<&'a str>,
    display_name_raw: Option<&'a str>,
    rp_id_raw: Option<&'a str>,
    origins_raw: Option<&'a str>,
    allow_insecure_raw: Option<&'a str>,
    user_verification_raw: Option<&'a str>,
    attachment_raw: Option<&'a str>,
    system_name_raw: Option<&'a str>,
    server_address_raw: Option<&'a str>,
}

fn resolve_passkey_settings(
    input: &SettingsInput<'_>,
    request_origin: Option<String>,
) -> PasskeySettings {
    let enabled = option_bool(input.enabled_raw, false);
    let system_name = non_empty(input.system_name_raw).unwrap_or("CinaToken");
    let rp_display_name = non_empty(input.display_name_raw).unwrap_or(system_name);
    let allow_insecure_origin = option_bool(input.allow_insecure_raw, false);
    let origins = resolve_origins(
        input.origins_raw,
        input.server_address_raw,
        request_origin.as_deref(),
        allow_insecure_origin,
    );
    let rp_id = non_empty(input.rp_id_raw)
        .map(host_without_port)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            origins
                .first()
                .and_then(|origin| url::Url::parse(origin).ok())
                .and_then(|url| url.host_str().map(str::to_string))
                .unwrap_or_default()
        });
    let user_verification = match non_empty(input.user_verification_raw).unwrap_or("preferred") {
        "required" => "required",
        "discouraged" => "discouraged",
        _ => "preferred",
    }
    .to_string();
    let attachment_preference = match non_empty(input.attachment_raw).unwrap_or("") {
        "platform" => "platform",
        "cross-platform" => "cross-platform",
        _ => "",
    }
    .to_string();
    PasskeySettings {
        enabled,
        rp_display_name: rp_display_name.to_string(),
        rp_id,
        origins,
        allow_insecure_origin,
        user_verification,
        attachment_preference,
    }
}

fn resolve_origins(
    raw: Option<&str>,
    server_address: Option<&str>,
    request_origin: Option<&str>,
    allow_insecure: bool,
) -> Vec<String> {
    let configured = split_origins(raw);
    let mut origins = if configured.is_empty() {
        split_origins(server_address)
    } else {
        configured
    };
    if origins.is_empty() {
        if let Some(origin) = request_origin {
            origins.push(origin.to_string());
        }
    }
    origins
        .into_iter()
        .filter(|origin| allow_insecure || !origin.to_ascii_lowercase().starts_with("http://"))
        .collect()
}

fn split_origins(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw
        .map(str::trim)
        .filter(|raw| !raw.is_empty() && *raw != "[]")
    else {
        return Vec::new();
    };
    if let Ok(values) = serde_json::from_str::<Vec<String>>(raw) {
        return values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
    }
    raw.split([',', '\n', '\r'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn request_origin(req: &Request) -> Option<String> {
    if let Ok(Some(origin)) = req.headers().get("Origin") {
        return Some(origin);
    }
    let url = req.url().ok()?;
    Some(format!("{}://{}", url.scheme(), url.host_str()?))
}

fn creation_options(
    settings: &PasskeySettings,
    username: &str,
    display_name: &str,
    user_id: i64,
    challenge: &str,
    existing: Option<&PasskeyCredentialRow>,
) -> Value {
    let mut public_key = json!({
        "challenge": challenge,
        "rp": {
            "name": settings.rp_display_name,
            "id": settings.rp_id,
        },
        "user": {
            "id": URL_SAFE_NO_PAD.encode(user_id.to_string().as_bytes()),
            "name": username,
            "displayName": if display_name.trim().is_empty() { username } else { display_name },
        },
        "pubKeyCredParams": [
            {"type": "public-key", "alg": -7},
            {"type": "public-key", "alg": -257}
        ],
        "timeout": PASSKEY_TIMEOUT_MS,
        "attestation": "none",
        "authenticatorSelection": {
            "residentKey": "required",
            "requireResidentKey": true,
            "userVerification": settings.user_verification,
        }
    });
    if !settings.attachment_preference.is_empty() {
        public_key["authenticatorSelection"]["authenticatorAttachment"] =
            Value::String(settings.attachment_preference.clone());
    }
    if let Some(existing) = existing.and_then(credential_descriptor) {
        public_key["excludeCredentials"] = Value::Array(vec![existing]);
    }
    public_key
}

fn request_options(
    settings: &PasskeySettings,
    challenge: &str,
    credential: Option<&PasskeyCredentialRow>,
) -> Value {
    let mut public_key = json!({
        "challenge": challenge,
        "timeout": PASSKEY_TIMEOUT_MS,
        "rpId": settings.rp_id,
        "userVerification": settings.user_verification,
    });
    if let Some(credential) = credential.and_then(credential_descriptor) {
        public_key["allowCredentials"] = Value::Array(vec![credential]);
    }
    public_key
}

fn credential_descriptor(credential: &PasskeyCredentialRow) -> Option<Value> {
    let id = credential_id_to_base64url(&credential.credential_id)?;
    let transports = split_transports(&credential.transports);
    let mut descriptor = json!({
        "type": "public-key",
        "id": id,
    });
    if !transports.is_empty() {
        descriptor["transports"] =
            Value::Array(transports.into_iter().map(Value::String).collect());
    }
    Some(descriptor)
}

fn split_transports(raw: &str) -> Vec<String> {
    raw.split([',', ';', ' '])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn credential_id_to_base64url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    STANDARD
        .decode(value.as_bytes())
        .or_else(|_| URL_SAFE_NO_PAD.decode(value.as_bytes()))
        .ok()
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}

fn new_challenge() -> WorkerResult<String> {
    let mut bytes = [0u8; PASSKEY_CHALLENGE_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| worker::Error::RustError(format!("random challenge failed: {err}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn put_challenge(env: &Env, key: &str, state: &PasskeyChallengeState) -> WorkerResult<()> {
    let payload = serde_json::to_string(state).map_err(|err| {
        worker::Error::RustError(format!("failed to encode Passkey challenge: {err}"))
    })?;
    flow_state::put(env, FlowKind::PasskeyChallenge, key, &payload).await
}

fn challenge_key(flow: &str, user_id: i64) -> String {
    format!("{flow}:{user_id}")
}

fn challenge_key_by_flow_id(flow: &str, flow_id: &str) -> String {
    format!("{flow}:{flow_id}")
}

fn passkey_login_cookie(req: &Request) -> Option<String> {
    let header = req.headers().get("Cookie").ok().flatten()?;
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some((name, value)) = pair.split_once('=') {
            if name.trim() == PASSKEY_LOGIN_COOKIE {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn passkey_disabled_response() -> Response {
    envelope_error_response(200, "administrator has not enabled Passkey login")
}

fn passkey_finish_unavailable_response() -> Response {
    envelope_error_response(
        501,
        "Passkey WebAuthn finish verification is not available in this Worker build",
    )
}

impl PasskeySettings {
    fn primary_origin(&self) -> String {
        self.origins.first().cloned().unwrap_or_default()
    }
}

fn option_bool(value: Option<&str>, default: bool) -> bool {
    value
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(default)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn host_without_port(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = url::Url::parse(value) {
        if let Some(host) = parsed.host_str() {
            return host.to_string();
        }
    }
    value.split(':').next().unwrap_or(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_input<'a>(
        enabled: Option<&'a str>,
        rp_id: Option<&'a str>,
        origins: Option<&'a str>,
    ) -> SettingsInput<'a> {
        SettingsInput {
            enabled_raw: enabled,
            display_name_raw: None,
            rp_id_raw: rp_id,
            origins_raw: origins,
            allow_insecure_raw: None,
            user_verification_raw: None,
            attachment_raw: None,
            system_name_raw: Some("CinaToken"),
            server_address_raw: None,
        }
    }

    #[test]
    fn resolve_passkey_settings_derives_origin_and_rp_id() {
        let settings = resolve_passkey_settings(
            &settings_input(Some("true"), None, None),
            Some("https://example.com".to_string()),
        );
        assert!(settings.enabled);
        assert_eq!(settings.rp_display_name, "CinaToken");
        assert_eq!(settings.rp_id, "example.com");
        assert_eq!(settings.origins, vec!["https://example.com"]);
        assert_eq!(settings.user_verification, "preferred");
    }

    #[test]
    fn resolve_passkey_settings_filters_insecure_origins_by_default() {
        let settings = resolve_passkey_settings(
            &settings_input(Some("true"), None, Some("http://bad.test,https://ok.test")),
            None,
        );
        assert_eq!(settings.origins, vec!["https://ok.test"]);
        assert_eq!(settings.rp_id, "ok.test");
    }

    #[test]
    fn credential_id_is_reencoded_to_base64url() {
        let standard = STANDARD.encode([1u8, 2, 3, 250]);
        assert_eq!(credential_id_to_base64url(&standard).unwrap(), "AQID-g");
    }

    #[test]
    fn creation_options_include_existing_credential_exclusion() {
        let settings = PasskeySettings {
            enabled: true,
            rp_display_name: "CinaToken".to_string(),
            rp_id: "example.com".to_string(),
            origins: vec!["https://example.com".to_string()],
            allow_insecure_origin: false,
            user_verification: "required".to_string(),
            attachment_preference: "platform".to_string(),
        };
        let credential = PasskeyCredentialRow {
            credential_id: STANDARD.encode([1u8, 2, 3]),
            transports: "internal,hybrid".to_string(),
            last_used_at: None,
            backup_eligible: 1,
            backup_state: 0,
        };
        let options = creation_options(
            &settings,
            "alice",
            "Alice",
            42,
            "challenge",
            Some(&credential),
        );
        assert_eq!(options["rp"]["id"], "example.com");
        assert_eq!(
            options["authenticatorSelection"]["authenticatorAttachment"],
            "platform"
        );
        assert_eq!(options["excludeCredentials"][0]["id"], "AQID");
        assert_eq!(options["user"]["id"], "NDI");
    }

    #[test]
    fn status_response_is_false_without_credential() {
        let status = status_from_credential(None);
        assert!(!status.enabled);
        assert!(status.last_used_at.is_none());
    }
}
