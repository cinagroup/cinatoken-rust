//! Passkey/WebAuthn route boundary.
//!
//! Challenges are stored in a per-ceremony Durable Object for atomic one-time
//! consumption. Finish handlers validate the complete WebAuthn ceremony before
//! changing D1 credentials, issuing sessions, or granting step-up state.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use cinatoken_auth::USER_STATUS_ENABLED;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, attach_session_cookie, envelope_error_response, envelope_ok_response,
    mark_secure_verification, read_json_body, require_secure_verification_method,
    require_user_auth, session_binding_id, session_claims_from_user, session_codec, unix_timestamp,
    SECURE_VERIFICATION_METHOD_2FA, SECURE_VERIFICATION_METHOD_PASSKEY,
};
use crate::d1_repositories::{self, PasskeyCredentialRow, PasskeyCredentialWrite};
use crate::passkey_ceremony::{self, PasskeyCeremonyError};
use crate::webauthn::{
    self, AssertionCredential, CeremonyExpectation, RegistrationCredential, StoredCredential,
    VerifiedAssertion,
};

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
const PASSKEY_CHALLENGE_TTL_SECONDS: u64 = 300;
const PASSKEY_LOGIN_COOKIE: &str = "passkey_challenge";
const PASSKEY_CREDENTIAL_ID_DIGEST_DOMAIN: &[u8] = b"cinatoken:passkey:credential-id:v1";
const PASSKEY_PUBLIC_KEY_DIGEST_DOMAIN: &[u8] = b"cinatoken:passkey:public-key:v1";
const PASSKEY_REGISTRATION_ID_DIGEST_DOMAIN: &[u8] = b"cinatoken:passkey:registration-id:v1";
const PASSKEY_CREDENTIAL_BINDING_DIGEST_DOMAIN: &[u8] = b"cinatoken:passkey:credential-binding:v1";

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
    user_verification: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PasskeyCredentialBindings {
    credential_registration_id_sha256: String,
    credential_id_sha256: String,
    credential_binding_sha256: String,
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
    let verification_method = match d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
        Some(two_fa) if two_fa.is_enabled != 0 => SECURE_VERIFICATION_METHOD_2FA,
        _ => SECURE_VERIFICATION_METHOD_PASSKEY,
    };
    if let Some(response) =
        require_secure_verification_method(&req, &env, claims.id, verification_method).await?
    {
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
    let origin = match validated_ceremony_origin(&settings, &req) {
        Ok(origin) => origin,
        Err(response) => return Ok(response),
    };
    if let Some(two_fa) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
        if two_fa.is_enabled != 0 {
            if let Some(response) = require_secure_verification_method(
                &req,
                &env,
                claims.id,
                SECURE_VERIFICATION_METHOD_2FA,
            )
            .await?
            {
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
    let ceremony_key = match authenticated_challenge_key(&req, "register", claims.id) {
        Ok(key) => key,
        Err(response) => return Ok(response),
    };
    let challenge = new_challenge()?;
    let state = PasskeyChallengeState {
        flow: "register".to_string(),
        user_id: Some(claims.id),
        challenge: challenge.clone(),
        rp_id: settings.rp_id.clone(),
        origin,
        user_verification: settings.user_verification.clone(),
        issued_at: unix_timestamp(),
    };
    if let Err(response) = put_challenge(&env, &ceremony_key, &state).await {
        return Ok(response);
    }
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
    let db = env.d1("DB")?;
    let ceremony_key = match authenticated_challenge_key(&req, "register", claims.id) {
        Ok(key) => key,
        Err(response) => return Ok(response),
    };
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    if let Some(two_fa) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
        if two_fa.is_enabled != 0 {
            if let Some(response) = require_secure_verification_method(
                &req,
                &env,
                claims.id,
                SECURE_VERIFICATION_METHOD_2FA,
            )
            .await?
            {
                return Ok(response);
            }
        }
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let state = match take_challenge(&env, &ceremony_key).await {
        Ok(state) => state,
        Err(response) => return Ok(response),
    };
    if !valid_challenge_state(&state, "register", Some(claims.id)) {
        return Ok(envelope_error_response(
            400,
            "Passkey registration challenge is invalid; start again",
        ));
    }
    let credential: RegistrationCredential = match serde_json::from_value(body) {
        Ok(credential) => credential,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "invalid Passkey registration response",
            ))
        }
    };
    let verified = match webauthn::verify_registration(&credential, &ceremony_expectation(&state)) {
        Ok(verified) => verified,
        Err(err) => return Ok(webauthn_failure_response("registration", err)),
    };
    let credential_id = STANDARD.encode(&verified.credential_id);
    let public_key = STANDARD.encode(&verified.public_key_cose);
    let aaguid = STANDARD.encode(verified.aaguid);
    let transports = serde_json::to_string(&verified.transports).map_err(|err| {
        worker::Error::RustError(format!("failed to encode Passkey transports: {err}"))
    })?;
    let attachment = verified.authenticator_attachment.as_deref().unwrap_or("");
    let now = unix_timestamp();
    let bindings = derive_passkey_credential_bindings(
        &state.challenge,
        claims.id,
        &verified.credential_id,
        &verified.public_key_cose,
        verified.attestation_format,
        &aaguid,
        &transports,
        attachment,
        now,
    )?;
    let write = PasskeyCredentialWrite {
        user_id: claims.id,
        credential_id: &credential_id,
        public_key: &public_key,
        attestation_type: verified.attestation_format,
        aaguid: &aaguid,
        credential_registration_id_sha256: &bindings.credential_registration_id_sha256,
        credential_id_sha256: &bindings.credential_id_sha256,
        credential_binding_sha256: &bindings.credential_binding_sha256,
        sign_count: verified.sign_count,
        clone_warning: false,
        user_present: verified.user_present,
        user_verified: verified.user_verified,
        backup_eligible: verified.backup_eligible,
        backup_state: verified.backup_state,
        transports: &transports,
        attachment,
        last_used_at: None,
    };
    if let Err(err) = d1_repositories::replace_passkey_credential(&db, write, now).await {
        worker::console_error!(
            "failed to persist Passkey registration for user {}: {}",
            claims.id,
            err
        );
        return Ok(envelope_error_response(
            500,
            "failed to persist Passkey credential",
        ));
    }
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "user.passkey_register",
        &format!("user {} registered a Passkey", claims.username),
        &json!({"id": claims.id, "username": claims.username.clone()}),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;
    envelope_ok_response(&json!({"registered": true}))
}

pub async fn login_begin(req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    let origin = match validated_ceremony_origin(&settings, &req) {
        Ok(origin) => origin,
        Err(response) => return Ok(response),
    };
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
        origin,
        user_verification: settings.user_verification.clone(),
        issued_at: unix_timestamp(),
    };
    if let Err(response) =
        put_challenge(&env, &challenge_key_by_flow_id("login", &flow_id), &state).await
    {
        return Ok(response);
    }
    let mut response = envelope_ok_response(&json!({
        "options": {
            "publicKey": request_options(&settings, &challenge, None)
        }
    }))?;
    response.headers_mut().append(
        "Set-Cookie",
        &format!(
            "{PASSKEY_LOGIN_COOKIE}={flow_id}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict; Secure",
            PASSKEY_CHALLENGE_TTL_SECONDS
        ),
    )?;
    Ok(response)
}

pub async fn login_finish(mut req: Request, env: Env) -> WorkerResult<Response> {
    let Some(flow_id) = passkey_login_cookie(&req) else {
        return Ok(envelope_error_response(
            400,
            "Passkey login challenge expired; start again",
        ));
    };
    let db = env.d1("DB")?;
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return clear_passkey_login_cookie(passkey_disabled_response());
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return clear_passkey_login_cookie(response),
    };
    let state = match take_challenge(&env, &challenge_key_by_flow_id("login", &flow_id)).await {
        Ok(state) => state,
        Err(response) => return clear_passkey_login_cookie(response),
    };
    if !valid_challenge_state(&state, "login", None) {
        return clear_passkey_login_cookie(envelope_error_response(
            400,
            "Passkey login challenge is invalid; start again",
        ));
    }
    let credential: AssertionCredential = match serde_json::from_value(body) {
        Ok(credential) => credential,
        Err(_) => {
            return clear_passkey_login_cookie(envelope_error_response(
                400,
                "invalid Passkey authentication response",
            ))
        }
    };
    let Some((raw_credential_id, stored_credential_id)) = browser_credential_id(&credential.raw_id)
    else {
        return clear_passkey_login_cookie(envelope_error_response(
            401,
            "Passkey authentication failed",
        ));
    };
    let Some(stored) =
        d1_repositories::find_passkey_by_credential_id(&db, &stored_credential_id).await?
    else {
        return clear_passkey_login_cookie(envelope_error_response(
            401,
            "Passkey authentication failed",
        ));
    };
    let Some(user) = d1_repositories::find_user_by_id(&db, stored.user_id).await? else {
        return clear_passkey_login_cookie(envelope_error_response(
            401,
            "Passkey authentication failed",
        ));
    };
    if user.status != USER_STATUS_ENABLED {
        return clear_passkey_login_cookie(envelope_error_response(403, "user is disabled"));
    }
    let verified = match verify_assertion(&credential, &state, &stored, &raw_credential_id) {
        Ok(verified) => verified,
        Err(response) => return clear_passkey_login_cookie(response),
    };
    if verified
        .user_handle
        .as_deref()
        .is_some_and(|handle| handle != user.id.to_string().as_bytes())
    {
        return clear_passkey_login_cookie(envelope_error_response(
            401,
            "Passkey authentication failed",
        ));
    }
    let now = unix_timestamp();
    if let Err(response) =
        persist_assertion(&db, &stored, &verified, &stored.credential_id, now).await
    {
        return clear_passkey_login_cookie(response);
    }
    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return clear_passkey_login_cookie(response),
    };
    let cookie_value = match codec.issue(session_claims_from_user(&user), now) {
        Ok(value) => value,
        Err(err) => {
            worker::console_error!(
                "failed to issue Passkey session for user {}: {}",
                user.id,
                err
            );
            return clear_passkey_login_cookie(envelope_error_response(
                500,
                "failed to issue session",
            ));
        }
    };
    if let Err(err) = d1_repositories::update_last_login_at(&db, user.id, now).await {
        worker::console_warn!(
            "failed to update Passkey last_login_at for user {}: {}",
            user.id,
            err
        );
    }
    let mut response = envelope_ok_response(&json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "status": user.status,
        "group": user.group,
    }))?;
    attach_session_cookie(&mut response, &cookie_value, codec.ttl_seconds())?;
    clear_passkey_login_cookie(response)
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
    let origin = match validated_ceremony_origin(&settings, &req) {
        Ok(origin) => origin,
        Err(response) => return Ok(response),
    };
    let Some(credential) = d1_repositories::find_passkey_by_user(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    };
    let ceremony_key = match authenticated_challenge_key(&req, "verify", claims.id) {
        Ok(key) => key,
        Err(response) => return Ok(response),
    };
    let challenge = new_challenge()?;
    let state = PasskeyChallengeState {
        flow: "verify".to_string(),
        user_id: Some(claims.id),
        challenge: challenge.clone(),
        rp_id: settings.rp_id.clone(),
        origin,
        user_verification: settings.user_verification.clone(),
        issued_at: unix_timestamp(),
    };
    if let Err(response) = put_challenge(&env, &ceremony_key, &state).await {
        return Ok(response);
    }
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
    let db = env.d1("DB")?;
    let ceremony_key = match authenticated_challenge_key(&req, "verify", claims.id) {
        Ok(key) => key,
        Err(response) => return Ok(response),
    };
    let settings = passkey_settings(&db, &req).await?;
    if !settings.enabled {
        return Ok(passkey_disabled_response());
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let state = match take_challenge(&env, &ceremony_key).await {
        Ok(state) => state,
        Err(response) => return Ok(response),
    };
    if !valid_challenge_state(&state, "verify", Some(claims.id)) {
        return Ok(envelope_error_response(
            400,
            "Passkey verification challenge is invalid; start again",
        ));
    }
    let credential: AssertionCredential = match serde_json::from_value(body) {
        Ok(credential) => credential,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "invalid Passkey verification response",
            ))
        }
    };
    let Some(stored) = d1_repositories::find_passkey_by_user(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    };
    let Some((raw_credential_id, _)) = browser_credential_id(&credential.raw_id) else {
        return Ok(envelope_error_response(401, "Passkey verification failed"));
    };
    let verified = match verify_assertion(&credential, &state, &stored, &raw_credential_id) {
        Ok(verified) => verified,
        Err(response) => return Ok(response),
    };
    if verified
        .user_handle
        .as_deref()
        .is_some_and(|handle| handle != claims.id.to_string().as_bytes())
    {
        return Ok(envelope_error_response(401, "Passkey verification failed"));
    }
    let now = unix_timestamp();
    if let Err(response) =
        persist_assertion(&db, &stored, &verified, &stored.credential_id, now).await
    {
        return Ok(response);
    }
    mark_secure_verification(
        &req,
        &env,
        claims.id,
        SECURE_VERIFICATION_METHOD_PASSKEY,
        now,
    )
    .await?;
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "user.passkey_verify",
        &format!("user {} completed Passkey verification", claims.username),
        &json!({"id": claims.id, "username": claims.username.clone()}),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;
    envelope_ok_response(&json!({"verified": true}))
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
        .filter_map(|origin| normalize_origin(&origin, allow_insecure))
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
        return normalize_origin(&origin, true);
    }
    let url = req.url().ok()?;
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

fn normalize_origin(value: &str, allow_insecure: bool) -> Option<String> {
    let parsed = url::Url::parse(value.trim()).ok()?;
    let scheme_allowed =
        parsed.scheme() == "https" || (allow_insecure && parsed.scheme() == "http");
    if !scheme_allowed || parsed.host_str().is_none() {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

fn validated_ceremony_origin(
    settings: &PasskeySettings,
    req: &Request,
) -> std::result::Result<String, Response> {
    if settings.rp_id.trim().is_empty() || settings.origins.is_empty() {
        return Err(envelope_error_response(
            503,
            "Passkey relying party configuration is incomplete",
        ));
    }
    let Some(origin) = request_origin(req) else {
        return Err(envelope_error_response(400, "request origin is invalid"));
    };
    if !settings.origins.iter().any(|allowed| allowed == &origin) {
        return Err(envelope_error_response(
            403,
            "request origin is not allowed for Passkey",
        ));
    }
    let origin_host = url::Url::parse(&origin)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
        .unwrap_or_default();
    let rp_id = settings.rp_id.trim().to_ascii_lowercase();
    if origin_host != rp_id && !origin_host.ends_with(&format!(".{rp_id}")) {
        return Err(envelope_error_response(
            503,
            "Passkey RP ID does not match the configured origin",
        ));
    }
    Ok(origin)
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
    if let Ok(values) = serde_json::from_str::<Vec<String>>(raw) {
        return normalize_stored_transports(values);
    }
    normalize_stored_transports(raw.split([',', ';', ' ']).map(str::to_string))
}

fn normalize_stored_transports(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || result.contains(&value)
        {
            continue;
        }
        result.push(value);
        if result.len() == 16 {
            break;
        }
    }
    result
}

fn credential_id_to_base64url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > ((webauthn::MAX_CREDENTIAL_ID_BYTES + 2) / 3 * 4 + 2) {
        return None;
    }
    STANDARD
        .decode(value.as_bytes())
        .or_else(|_| URL_SAFE_NO_PAD.decode(value.as_bytes()))
        .ok()
        .filter(|bytes| bytes.len() <= webauthn::MAX_CREDENTIAL_ID_BYTES)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
}

fn new_challenge() -> WorkerResult<String> {
    let mut bytes = [0u8; PASSKEY_CHALLENGE_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| worker::Error::RustError(format!("random challenge failed: {err}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn derive_passkey_credential_bindings(
    challenge_base64url: &str,
    user_id: i64,
    credential_id: &[u8],
    public_key_cose: &[u8],
    attestation_type: &str,
    aaguid_base64: &str,
    transports_json: &str,
    attachment: &str,
    created_at: i64,
) -> WorkerResult<PasskeyCredentialBindings> {
    let challenge = URL_SAFE_NO_PAD
        .decode(challenge_base64url.as_bytes())
        .map_err(|_| worker::Error::RustError("invalid consumed Passkey challenge".to_string()))?;
    if challenge.len() != PASSKEY_CHALLENGE_BYTES
        || URL_SAFE_NO_PAD.encode(&challenge) != challenge_base64url
        || user_id <= 0
        || created_at < 0
    {
        return Err(worker::Error::RustError(
            "invalid Passkey registration binding input".to_string(),
        ));
    }

    let user_id_bytes = user_id.to_be_bytes();
    let created_at_bytes = created_at.to_be_bytes();
    let credential_id_sha256 = passkey_credential_id_sha256(credential_id);
    let public_key_sha256 =
        passkey_sha256_len_prefixed(PASSKEY_PUBLIC_KEY_DIGEST_DOMAIN, &[public_key_cose]);
    let immutable_fields = [
        user_id_bytes.as_slice(),
        credential_id_sha256.as_bytes(),
        public_key_sha256.as_bytes(),
        attestation_type.as_bytes(),
        aaguid_base64.as_bytes(),
        transports_json.as_bytes(),
        attachment.as_bytes(),
        created_at_bytes.as_slice(),
    ];

    let mut registration_fields = Vec::with_capacity(immutable_fields.len() + 1);
    registration_fields.push(challenge.as_slice());
    registration_fields.extend(immutable_fields);
    let credential_registration_id_sha256 =
        passkey_sha256_len_prefixed(PASSKEY_REGISTRATION_ID_DIGEST_DOMAIN, &registration_fields);

    let mut binding_fields = Vec::with_capacity(immutable_fields.len() + 1);
    binding_fields.push(credential_registration_id_sha256.as_bytes());
    binding_fields.extend(immutable_fields);
    let credential_binding_sha256 =
        passkey_sha256_len_prefixed(PASSKEY_CREDENTIAL_BINDING_DIGEST_DOMAIN, &binding_fields);

    Ok(PasskeyCredentialBindings {
        credential_registration_id_sha256,
        credential_id_sha256,
        credential_binding_sha256,
    })
}

fn passkey_sha256_len_prefixed(domain: &[u8], fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn passkey_credential_id_sha256(credential_id: &[u8]) -> String {
    passkey_sha256_len_prefixed(PASSKEY_CREDENTIAL_ID_DIGEST_DOMAIN, &[credential_id])
}

async fn put_challenge(
    env: &Env,
    key: &str,
    state: &PasskeyChallengeState,
) -> std::result::Result<(), Response> {
    let payload = serde_json::to_string(state)
        .map_err(|_| envelope_error_response(500, "failed to encode Passkey challenge"))?;
    passkey_ceremony::put_json(env, key, &payload, PASSKEY_CHALLENGE_TTL_SECONDS)
        .await
        .map_err(challenge_error_response)
}

async fn take_challenge(
    env: &Env,
    key: &str,
) -> std::result::Result<PasskeyChallengeState, Response> {
    let payload = passkey_ceremony::take_json(env, key)
        .await
        .map_err(challenge_error_response)?;
    serde_json::from_str(&payload)
        .map_err(|_| envelope_error_response(400, "Passkey challenge state is invalid"))
}

fn challenge_error_response(error: PasskeyCeremonyError) -> Response {
    match error {
        PasskeyCeremonyError::AlreadyExists => envelope_error_response(
            409,
            "Passkey challenge already exists; finish it or start a new flow",
        ),
        PasskeyCeremonyError::StateConflict => {
            envelope_error_response(409, "Passkey challenge state changed; start a new flow")
        }
        PasskeyCeremonyError::ClaimConflict => envelope_error_response(
            409,
            "Passkey challenge is already claimed; start a new flow",
        ),
        PasskeyCeremonyError::ExpiredOrConsumed => envelope_error_response(
            400,
            "Passkey challenge expired or was already consumed; start again",
        ),
        PasskeyCeremonyError::BindingUnavailable => {
            envelope_error_response(503, "Passkey ceremony service is not configured")
        }
        PasskeyCeremonyError::InvalidRequest(_) => {
            worker::console_error!("invalid internal Passkey ceremony request");
            envelope_error_response(500, "failed to process Passkey challenge")
        }
        PasskeyCeremonyError::Unavailable(_) => {
            worker::console_error!("Passkey ceremony Durable Object is unavailable");
            envelope_error_response(503, "Passkey ceremony service is unavailable")
        }
    }
}

fn valid_challenge_state(state: &PasskeyChallengeState, flow: &str, user_id: Option<i64>) -> bool {
    valid_challenge_state_at(state, flow, user_id, unix_timestamp())
}

fn valid_challenge_state_at(
    state: &PasskeyChallengeState,
    flow: &str,
    user_id: Option<i64>,
    now: i64,
) -> bool {
    let age = now.saturating_sub(state.issued_at);
    state.flow == flow
        && state.user_id == user_id
        && !state.challenge.is_empty()
        && !state.rp_id.is_empty()
        && !state.origin.is_empty()
        && matches!(
            state.user_verification.as_str(),
            "required" | "preferred" | "discouraged"
        )
        && age >= 0
        && age < PASSKEY_CHALLENGE_TTL_SECONDS as i64
}

fn ceremony_expectation(state: &PasskeyChallengeState) -> CeremonyExpectation<'_> {
    CeremonyExpectation {
        challenge: &state.challenge,
        origin: &state.origin,
        rp_id: &state.rp_id,
        require_user_verification: state.user_verification == "required",
    }
}

fn webauthn_failure_response(flow: &str, error: webauthn::WebauthnError) -> Response {
    worker::console_warn!("Passkey {} verification rejected: {}", flow, error.code());
    envelope_error_response(401, &format!("Passkey {flow} verification failed"))
}

fn browser_credential_id(value: &str) -> Option<(Vec<u8>, String)> {
    if value.is_empty()
        || value.len() > (webauthn::MAX_CREDENTIAL_ID_BYTES + 2) / 3 * 4
        || value.contains('=')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(value.as_bytes()).ok()?;
    if bytes.is_empty()
        || bytes.len() > webauthn::MAX_CREDENTIAL_ID_BYTES
        || URL_SAFE_NO_PAD.encode(&bytes) != value
    {
        return None;
    }
    let standard = STANDARD.encode(&bytes);
    Some((bytes, standard))
}

pub(crate) fn decode_stored_passkey_binary(value: &str, max_decoded_len: usize) -> Option<Vec<u8>> {
    let value = value.trim();
    if value.is_empty() || value.len() > ((max_decoded_len + 2) / 3 * 4 + 2) {
        return None;
    }
    let decoded = STANDARD
        .decode(value.as_bytes())
        .or_else(|_| URL_SAFE_NO_PAD.decode(value.as_bytes()))
        .ok()?;
    (decoded.len() <= max_decoded_len).then_some(decoded)
}

fn stored_bool(value: i32) -> Option<bool> {
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn verify_assertion(
    credential: &AssertionCredential,
    state: &PasskeyChallengeState,
    stored: &PasskeyCredentialRow,
    raw_credential_id: &[u8],
) -> std::result::Result<VerifiedAssertion, Response> {
    let stored_id =
        decode_stored_passkey_binary(&stored.credential_id, webauthn::MAX_CREDENTIAL_ID_BYTES)
            .filter(|value| value.as_slice() == raw_credential_id)
            .ok_or_else(|| envelope_error_response(401, "Passkey verification failed"))?;
    let public_key = decode_stored_passkey_binary(&stored.public_key, webauthn::MAX_COSE_KEY_BYTES)
        .ok_or_else(|| envelope_error_response(401, "Passkey verification failed"))?;
    let sign_count = u32::try_from(stored.sign_count)
        .map_err(|_| envelope_error_response(401, "Passkey verification failed"))?;
    let backup_eligible = stored_bool(stored.backup_eligible)
        .ok_or_else(|| envelope_error_response(401, "Passkey verification failed"))?;
    let stored = StoredCredential {
        credential_id: &stored_id,
        public_key_cose: &public_key,
        sign_count,
        backup_eligible,
    };
    webauthn::verify_assertion(credential, &ceremony_expectation(state), &stored)
        .map_err(|error| webauthn_failure_response("authentication", error))
}

async fn persist_assertion(
    db: &worker::D1Database,
    stored: &PasskeyCredentialRow,
    verified: &VerifiedAssertion,
    credential_id: &str,
    now: i64,
) -> std::result::Result<(), Response> {
    let expected_sign_count = u32::try_from(stored.sign_count)
        .map_err(|_| envelope_error_response(401, "Passkey verification failed"))?;
    let clone_warning = stored_bool(stored.clone_warning)
        .ok_or_else(|| envelope_error_response(401, "Passkey verification failed"))?
        || verified.clone_warning;
    if verified.clone_warning {
        worker::console_warn!(
            "Passkey signature counter rollback detected for user {}",
            stored.user_id
        );
    }
    let updated = d1_repositories::update_passkey_after_authentication(
        db,
        stored.user_id,
        credential_id,
        expected_sign_count,
        stored.credential_use_generation,
        stored.credential_registration_id_sha256.as_deref(),
        stored.credential_id_sha256.as_deref(),
        stored.credential_binding_sha256.as_deref(),
        verified.sign_count,
        clone_warning,
        verified.user_present,
        verified.user_verified,
        verified.backup_eligible,
        verified.backup_state,
        now,
    )
    .await
    .map_err(|err| {
        worker::console_error!(
            "failed to persist Passkey assertion for user {}: {}",
            stored.user_id,
            err
        );
        envelope_error_response(500, "failed to update Passkey credential")
    })?;
    if !updated {
        return Err(envelope_error_response(
            409,
            "Passkey credential state changed; start again",
        ));
    }
    Ok(())
}

fn clear_passkey_login_cookie(mut response: Response) -> WorkerResult<Response> {
    response.headers_mut().append(
        "Set-Cookie",
        &format!("{PASSKEY_LOGIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure"),
    )?;
    Ok(response)
}

fn authenticated_challenge_key(
    req: &Request,
    flow: &str,
    user_id: i64,
) -> std::result::Result<String, Response> {
    session_binding_id(req, user_id)
        .map(|binding| format!("{flow}:{binding}"))
        .ok_or_else(|| envelope_error_response(401, "authenticated session is unavailable"))
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

pub(crate) fn finish_contract_compiled() -> bool {
    passkey_ceremony::ceremony_contract_compiled()
        && webauthn::CoseAlgorithm::Es256.cose_id() == -7
        && webauthn::CoseAlgorithm::Rs256.cose_id() == -257
        && webauthn::MAX_CREDENTIAL_ID_BYTES <= 1_024
        && webauthn::MAX_ATTESTATION_OBJECT_BYTES <= 64 * 1_024
        && PASSKEY_CHALLENGE_TTL_SECONDS <= 300
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
    fn origin_normalization_keeps_non_default_port_and_drops_paths() {
        assert_eq!(
            normalize_origin("https://example.test:8443/passkey", false).as_deref(),
            Some("https://example.test:8443")
        );
        assert_eq!(normalize_origin("http://example.test", false), None);
        assert_eq!(
            normalize_origin("http://localhost:8787/path", true).as_deref(),
            Some("http://localhost:8787")
        );
    }

    #[test]
    fn credential_id_is_reencoded_to_base64url() {
        let standard = STANDARD.encode([1u8, 2, 3, 250]);
        assert_eq!(credential_id_to_base64url(&standard).unwrap(), "AQID-g");
    }

    #[test]
    fn browser_credential_id_requires_canonical_base64url() {
        let encoded = URL_SAFE_NO_PAD.encode([1u8, 2, 3, 250]);
        let (bytes, standard) = browser_credential_id(&encoded).unwrap();
        assert_eq!(bytes, [1u8, 2, 3, 250]);
        assert_eq!(standard, STANDARD.encode([1u8, 2, 3, 250]));
        assert!(browser_credential_id(&format!("{encoded}=")).is_none());
    }

    #[test]
    fn challenge_state_is_bound_to_flow_user_and_ttl() {
        let now = 1_700_000_000;
        let state = PasskeyChallengeState {
            flow: "verify".to_string(),
            user_id: Some(42),
            challenge: URL_SAFE_NO_PAD.encode([7u8; PASSKEY_CHALLENGE_BYTES]),
            rp_id: "example.com".to_string(),
            origin: "https://example.com".to_string(),
            user_verification: "required".to_string(),
            issued_at: now,
        };
        assert!(valid_challenge_state_at(&state, "verify", Some(42), now));
        assert!(!valid_challenge_state_at(&state, "login", Some(42), now));
        assert!(!valid_challenge_state_at(&state, "verify", Some(43), now));
        let expired = PasskeyChallengeState {
            issued_at: now - PASSKEY_CHALLENGE_TTL_SECONDS as i64,
            ..state
        };
        assert!(!valid_challenge_state_at(&expired, "verify", Some(42), now));
    }

    #[test]
    fn registration_bindings_match_fixed_domain_separated_vectors() {
        let challenge = URL_SAFE_NO_PAD.encode([7u8; PASSKEY_CHALLENGE_BYTES]);
        let aaguid = STANDARD.encode([9u8; 16]);
        let bindings = derive_passkey_credential_bindings(
            &challenge,
            42,
            &[1, 2, 3, 250],
            &[0xa5, 1, 2, 3],
            "packed",
            &aaguid,
            r#"["internal","hybrid"]"#,
            "platform",
            1_700_000_000,
        )
        .unwrap();

        assert_eq!(
            bindings.credential_id_sha256,
            "bf96852d43d8c2af87499b9b5b942e555e2395f240d92a5fe839867b06fe67cc"
        );
        assert_eq!(
            bindings.credential_registration_id_sha256,
            "fd12a5a0062f0f9d445d6a3dc4e648d2b473e1e7380d5280fb61b7444b2a0281"
        );
        assert_eq!(
            bindings.credential_binding_sha256,
            "1354609638d3f4d0136df85433fb3921e9d6d72c8f3017009b2cc6dccd2115c2"
        );
    }

    #[test]
    fn registration_bindings_change_with_challenge_or_immutable_metadata() {
        let derive = |challenge_byte, attachment| {
            derive_passkey_credential_bindings(
                &URL_SAFE_NO_PAD.encode([challenge_byte; PASSKEY_CHALLENGE_BYTES]),
                42,
                &[1, 2, 3, 250],
                &[0xa5, 1, 2, 3],
                "packed",
                &STANDARD.encode([9u8; 16]),
                r#"["internal","hybrid"]"#,
                attachment,
                1_700_000_000,
            )
            .unwrap()
        };
        let baseline = derive(7, "platform");
        let different_challenge = derive(8, "platform");
        let different_attachment = derive(7, "cross-platform");

        assert_ne!(
            baseline.credential_registration_id_sha256,
            different_challenge.credential_registration_id_sha256
        );
        assert_eq!(
            baseline.credential_id_sha256,
            different_challenge.credential_id_sha256
        );
        assert_ne!(
            baseline.credential_binding_sha256,
            different_attachment.credential_binding_sha256
        );
    }

    #[test]
    fn transport_storage_reads_go_json_and_legacy_csv() {
        assert_eq!(
            split_transports(r#"["internal","hybrid"]"#),
            vec!["internal", "hybrid"]
        );
        assert_eq!(
            split_transports("usb,nfc"),
            vec!["usb".to_string(), "nfc".to_string()]
        );
    }

    #[test]
    fn finish_contract_covers_do_and_both_offered_algorithms() {
        assert!(finish_contract_compiled());
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
            ..PasskeyCredentialRow::default()
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
