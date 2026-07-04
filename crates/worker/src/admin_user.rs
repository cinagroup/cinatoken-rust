//! Admin user CRUD handlers (G5 P0): list, search, get, create, edit,
//! delete, and manage.
//!
//! Mirrors Go `controller/user.go` admin surface. Permission rules use the
//! `cinatoken_auth` helpers (`is_root`, `outranks`) and match the Go
//! `canManageTargetRole` semantics:
//!
//! - GetUser / UpdateUser / ManageUser (non-promote): `is_root || outranks`.
//! - DeleteUser: `outranks` (strict; no root-bypass-via-equality).
//! - CreateUser role: `new_role < caller_role` (strict).
//! - ManageUser promote: `is_root` only.
//! - ManageUser disable/delete/demote: block if target is root.
//!
//! All responses omit `password` (SQL-level omit) and `access_token`
//! (handler redaction). DELETE uses soft delete so tokens do not orphan,
//! differing from the Go gateway's hard delete.

use cinatoken_auth::{
    hash_password, is_root, outranks, verify_password, ROLE_ADMIN_USER, ROLE_COMMON_USER,
    ROLE_ROOT_USER, USER_STATUS_DISABLED, USER_STATUS_ENABLED,
};
use serde::{Deserialize, Serialize};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    require_user_auth, unix_timestamp,
};
use crate::cache_invalidation::invalidate_token_cache;
use crate::d1_repositories;

// ---------------------------------------------------------------------------
// List / search / get
// ---------------------------------------------------------------------------

pub async fn list_users(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::list_users(&db, page, page_size).await?;
    let total = d1_repositories::count_users(&db).await?;
    Ok(envelope_ok_response(&UsersPage {
        items: items.into_iter().map(user_response).collect(),
        total,
        page,
        page_size,
    })?)
}

pub async fn search_users(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let keyword = parse_query_string(&req, "keyword");
    let group = parse_query_string(&req, "group");
    let role = parse_query_i32(&req, "role");
    let status = parse_query_i32(&req, "status");
    let (page, page_size) = parse_pagination(&req);
    let items = d1_repositories::search_users(
        &db,
        keyword.as_deref(),
        group.as_deref(),
        role,
        status,
        page,
        page_size,
    )
    .await?;
    let total = d1_repositories::count_search_users(
        &db,
        keyword.as_deref(),
        group.as_deref(),
        role,
        status,
    )
    .await?;
    Ok(envelope_ok_response(&UsersPage {
        items: items.into_iter().map(user_response).collect(),
        total,
        page,
        page_size,
    })?)
}

pub async fn get_user(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if !is_root(claims.role) && !outranks(claims.role, target.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to view this user",
        ));
    }
    let Some(row) = d1_repositories::find_user_by_id_full(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    Ok(envelope_ok_response(&user_response(row))?)
}

// ---------------------------------------------------------------------------
// Create / edit / delete
// ---------------------------------------------------------------------------

pub async fn create_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UserCreateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid user create request: {err}"),
            ));
        }
    };
    let username = payload.username.trim();
    if username.is_empty() {
        return Ok(envelope_error_response(400, "username must not be empty"));
    }
    if payload.password.is_empty() {
        return Ok(envelope_error_response(400, "password must not be empty"));
    }
    // Role clamp: new role must be STRICTLY less than caller's role.
    let new_role = payload.role.unwrap_or(ROLE_COMMON_USER);
    if new_role >= claims.role {
        return Ok(envelope_error_response(
            403,
            "cannot create a user with role equal to or higher than your own",
        ));
    }
    let display_name = match payload.display_name.as_deref() {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => username.to_string(),
    };
    let password_hash = match hash_password(&payload.password) {
        Ok(hash) => hash,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to hash password: {err}"),
            ));
        }
    };
    let now = unix_timestamp();
    let aff_code = random_aff_code();
    let db = env.d1("DB")?;
    let user_id = d1_repositories::create_user(
        &db,
        d1_repositories::CreateUser {
            username,
            password_hash: &password_hash,
            display_name: &display_name,
            role: new_role,
            group: "default",
            aff_code: &aff_code,
            quota: 0,
            inviter_id: 0,
            created_at: now,
        },
    )
    .await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(user_id),
        Some(username),
        &claims.username,
        "user.create",
        &format!(
            "admin {} created user {} (role {})",
            claims.username, username, new_role
        ),
        &serde_json::json!({"username": username, "role": new_role}),
        &crate::admin::admin_audit_info(&claims, &req),
        now,
    )
    .await;
    Ok(envelope_ok_response(&UserCreateResult { id: user_id })?)
}

// ---------------------------------------------------------------------------
// Public self-registration
// ---------------------------------------------------------------------------

/// Registration request body. Go decodes into `model.User`; only these fields
/// are meaningful for registration (`aff_code` is the *inviter's* code, not the
/// new user's own).
#[derive(Debug, Deserialize, Default)]
pub struct RegisterRequest {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub verification_code: String,
    #[serde(default)]
    pub aff_code: String,
}

/// Validate a registration request against Go `model.User`'s validator tags
/// (`username max=20`, `password min=8,max=20`, `email max=50`), returning the
/// first failure message. Pure, so it is unit-testable without a D1.
pub fn validate_registration(username: &str, password: &str, email: &str) -> Result<(), String> {
    if username.is_empty() {
        return Err("username must not be empty".to_string());
    }
    if username.chars().count() > 20 {
        return Err("username must be at most 20 characters".to_string());
    }
    let password_len = password.chars().count();
    if !(8..=20).contains(&password_len) {
        return Err("password must be between 8 and 20 characters".to_string());
    }
    if email.chars().count() > 50 {
        return Err("email must be at most 50 characters".to_string());
    }
    Ok(())
}

/// Read a boolean option (Go stores `"true"`/`"false"`), falling back to
/// `default` only when the option is absent.
fn parse_bool_option(value: Option<&str>, default: bool) -> bool {
    match value {
        Some(raw) => raw == "1" || raw.eq_ignore_ascii_case("true"),
        None => default,
    }
}

/// Read an integer option, falling back to `default` when absent or unparseable.
fn parse_int_option(value: Option<&str>, default: i64) -> i64 {
    value
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

/// `POST /api/user/register`: public self-registration (Go `controller.Register`).
///
/// Honors the `RegisterEnabled` / `PasswordRegisterEnabled` gates (default
/// true), validates against Go's `model.User` tags, rejects an existing
/// username/email, links the inviter from the affiliation code, and applies the
/// configured `QuotaForNewUser` / `QuotaForInvitee` grants plus inviter
/// affiliation tracking. Does NOT auto-login — Go returns `{success:true}` and
/// the client logs in separately.
///
/// Deferred parity (all off in the default config): Turnstile bot-check;
/// email-verified registration (`EmailVerificationEnabled` — rejected here since
/// the email send/verify subsystem is not ported); default-token generation
/// (`GenerateDefaultToken`); the `IsPaymentComplianceConfirmed` sub-gate on the
/// invitee reward; and the informational new-user/referral system-log entries.
pub async fn register(mut req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;

    let opts = d1_repositories::option_values(
        &db,
        &[
            "RegisterEnabled",
            "PasswordRegisterEnabled",
            "EmailVerificationEnabled",
            "QuotaForNewUser",
            "QuotaForInvitee",
            "QuotaForInviter",
        ],
    )
    .await?;
    if !parse_bool_option(opts[0].as_deref(), true) {
        return Ok(envelope_error_response(403, "registration is disabled"));
    }
    if !parse_bool_option(opts[1].as_deref(), true) {
        return Ok(envelope_error_response(
            403,
            "password registration is disabled",
        ));
    }
    let email_verification_enabled = parse_bool_option(opts[2].as_deref(), false);
    let quota_for_new_user = parse_int_option(opts[3].as_deref(), 0);
    let quota_for_invitee = parse_int_option(opts[4].as_deref(), 0);
    let quota_for_inviter = parse_int_option(opts[5].as_deref(), 0);

    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: RegisterRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid register request: {err}"),
            ));
        }
    };
    let username = payload.username.trim();
    let email = payload.email.trim();
    if let Err(message) = validate_registration(username, &payload.password, email) {
        return Ok(envelope_error_response(400, &message));
    }

    if email_verification_enabled {
        // Go requires a valid emailed code here; refuse rather than silently
        // skip the check, because the email send/verify subsystem is unported.
        return Ok(envelope_error_response(
            400,
            "email-verified registration is not supported by this deployment",
        ));
    }

    // Reject an already-taken username or email (Go `CheckUserExistOrDeleted`).
    if d1_repositories::find_user_by_username_or_email(&db, username)
        .await?
        .is_some()
    {
        return Ok(envelope_error_response(409, "user already exists"));
    }
    if !email.is_empty()
        && d1_repositories::find_user_by_username_or_email(&db, email)
            .await?
            .is_some()
    {
        return Ok(envelope_error_response(409, "user already exists"));
    }

    let inviter_id = d1_repositories::find_user_id_by_aff_code(&db, payload.aff_code.trim())
        .await?
        .unwrap_or(0);

    let password_hash = match hash_password(&payload.password) {
        Ok(hash) => hash,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to hash password: {err}"),
            ));
        }
    };
    let now = unix_timestamp();
    let aff_code = random_aff_code();
    let user_id = d1_repositories::create_user(
        &db,
        d1_repositories::CreateUser {
            username,
            password_hash: &password_hash,
            display_name: username,
            role: ROLE_COMMON_USER,
            group: "default",
            aff_code: &aff_code,
            quota: quota_for_new_user,
            inviter_id,
            created_at: now,
        },
    )
    .await?;

    // Affiliation rewards (Go `User.Insert`): the invitee's spendable quota is
    // credited on top of the signup grant; the inviter only accrues affiliation
    // counters (Go leaves the inviter's spendable-quota credit commented out).
    if inviter_id != 0 {
        if quota_for_invitee > 0 {
            let _ = d1_repositories::increase_user_quota(&db, user_id, quota_for_invitee).await;
        }
        if quota_for_inviter > 0 {
            let _ = d1_repositories::record_inviter_aff(&db, inviter_id, quota_for_inviter).await;
        }
    }

    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

// ---------------------------------------------------------------------------
// Self-service account endpoints (require a logged-in session, act on self)
// ---------------------------------------------------------------------------

/// `GET /api/user/aff`: return the caller's affiliation code, lazily generating
/// and persisting a 4-char code when none is set yet (Go `GetAffCode`).
pub async fn get_aff_code(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let Some(mut aff_code) = d1_repositories::get_user_aff_code(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };
    if aff_code.is_empty() {
        aff_code = random_aff_code();
        d1_repositories::update_user_aff_code(&db, claims.id, &aff_code).await?;
    }
    Ok(envelope_ok_response(&aff_code)?)
}

/// `DELETE /api/user/self`: soft-delete the caller's own account (Go
/// `DeleteSelf`). The root user cannot self-delete.
pub async fn delete_self(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if claims.role == ROLE_ROOT_USER {
        return Ok(envelope_error_response(403, "cannot delete the root user"));
    }
    let db = env.d1("DB")?;
    d1_repositories::soft_delete_user(&db, claims.id, unix_timestamp()).await?;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

/// `GET /api/user/token`: (re)generate the caller's system access token (Go
/// `GenerateAccessToken`) — a 32-char random key persisted on the user row and
/// returned once. Distinct from relay API keys.
pub async fn generate_access_token(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let token = random_access_token();
    d1_repositories::update_user_access_token(&db, claims.id, &token).await?;
    Ok(envelope_ok_response(&token)?)
}

/// Transfer request body (Go `TransferAffQuotaRequest`).
#[derive(Debug, Deserialize, Default)]
pub struct TransferAffQuotaRequest {
    #[serde(default)]
    pub quota: i64,
}

/// `POST /api/user/aff_transfer`: move affiliation quota into spendable quota
/// (Go `TransferAffQuota` -> `TransferAffQuotaToQuota`). The minimum transfer is
/// one `QuotaPerUnit`; the move is CAS-guarded on sufficient affiliation quota.
/// (Go's `requirePaymentCompliance` pre-gate is deferred — see the register
/// parity notes.)
pub async fn transfer_aff_quota(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: TransferAffQuotaRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid transfer request: {err}"),
            ));
        }
    };
    let db = env.d1("DB")?;
    let quota_per_unit = parse_int_option(
        d1_repositories::get_option(&db, "QuotaPerUnit")
            .await?
            .as_deref(),
        500_000,
    );
    if payload.quota < quota_per_unit {
        return Ok(envelope_error_response(
            400,
            &format!("minimum transfer is {quota_per_unit}"),
        ));
    }
    if d1_repositories::transfer_aff_quota(&db, claims.id, payload.quota).await? {
        Ok(envelope_ok_response(&serde_json::Value::Null)?)
    } else {
        Ok(envelope_error_response(
            400,
            "insufficient affiliation quota",
        ))
    }
}

/// Self-profile update request (Go `UpdateSelf` profile branch). All fields are
/// optional; changing the password requires the correct `original_password`.
#[derive(Debug, Deserialize, Default)]
pub struct UpdateSelfRequest {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub original_password: Option<String>,
}

/// Validate optional self-profile fields against Go `model.User` tags
/// (username / display_name `max=20`; password `min=8,max=20` only when a
/// non-empty new password is supplied). Pure, so it is unit-testable.
pub fn validate_self_update(
    username: Option<&str>,
    display_name: Option<&str>,
    password: Option<&str>,
) -> Result<(), String> {
    if let Some(name) = username {
        if name.chars().count() > 20 {
            return Err("username must be at most 20 characters".to_string());
        }
    }
    if let Some(name) = display_name {
        if name.chars().count() > 20 {
            return Err("display name must be at most 20 characters".to_string());
        }
    }
    if let Some(pw) = password {
        if !pw.is_empty() && !(8..=20).contains(&pw.chars().count()) {
            return Err("password must be between 8 and 20 characters".to_string());
        }
    }
    Ok(())
}

/// `PUT /api/user/self`: update the caller's own username / display_name and,
/// optionally, password (Go `UpdateSelf` profile branch). A password change
/// verifies `original_password` first (unless the account has no password yet).
/// Empty fields are left unchanged, matching Go's zero-value-skipping `Update`.
///
/// Deferred: the Go `sidebar_modules` / `language` user-setting branches
/// (display-only preferences persisted in the `setting` JSON, which the Rust
/// worker does not yet manage).
/// Merge the `sidebar_modules` / `language` string fields from `body` into the
/// existing user `setting` JSON, returning the new setting JSON string. A blank
/// or non-object current setting is treated as `{}`. Pure, so it is
/// unit-testable.
fn merge_setting_fields(current_setting: &str, body: &serde_json::Value) -> String {
    let mut setting =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(current_setting.trim())
            .unwrap_or_default();
    for field in ["sidebar_modules", "language"] {
        if let Some(value) = body.get(field).and_then(serde_json::Value::as_str) {
            setting.insert(
                field.to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
    serde_json::Value::Object(setting).to_string()
}

pub async fn update_self(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };

    // User-setting branch (Go `UpdateSelf` sidebar_modules / language): merge the
    // preference field(s) into the `setting` JSON and return, without touching
    // the profile.
    if body.get("sidebar_modules").is_some() || body.get("language").is_some() {
        let db = env.d1("DB")?;
        let current = d1_repositories::get_user_setting(&db, claims.id)
            .await?
            .unwrap_or_default();
        let new_setting = merge_setting_fields(&current, &body);
        d1_repositories::update_user_setting(&db, claims.id, &new_setting).await?;
        return Ok(envelope_ok_response(&serde_json::Value::Null)?);
    }

    let payload: UpdateSelfRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid update request: {err}"),
            ));
        }
    };
    // Empty strings mean "no change" (Go's `Updates` skips zero values).
    let username = payload
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let display_name = payload
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let new_password = payload.password.as_deref().unwrap_or("");
    if let Err(message) = validate_self_update(username, display_name, payload.password.as_deref())
    {
        return Ok(envelope_error_response(400, &message));
    }

    let db = env.d1("DB")?;
    let Some(user) = d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };

    // Go `checkUpdatePassword`: a password change requires the correct current
    // password (skipped only when the account has no password set yet); an empty
    // new password leaves it unchanged.
    let update_password = !new_password.is_empty();
    if update_password && !user.password.is_empty() {
        let original = payload.original_password.as_deref().unwrap_or("");
        if !verify_password(original, &user.password).unwrap_or(false) {
            return Ok(envelope_error_response(
                400,
                "original password is incorrect",
            ));
        }
    }
    let password_hash = if update_password {
        match hash_password(new_password) {
            Ok(hash) => Some(hash),
            Err(err) => {
                return Ok(envelope_error_response(
                    500,
                    &format!("failed to hash password: {err}"),
                ));
            }
        }
    } else {
        None
    };

    d1_repositories::edit_user(
        &db,
        claims.id,
        username,
        display_name,
        None,
        None,
        password_hash.as_deref(),
    )
    .await?;

    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

/// A 32-char random access token from the same alphabet as [`random_aff_code`]
/// (Go `GenerateRandomKey`, length 29-32; we fix 32).
fn random_access_token() -> String {
    let alphabet: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut out = String::with_capacity(32);
    for _ in 0..32 {
        let r = js_sys::Math::random() * (alphabet.len() as f64);
        out.push(alphabet[r as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// Exposed ratio config (Go GetRatioConfig)
// ---------------------------------------------------------------------------

/// Merge a default ratio table with the option override (Go seeds the in-memory
/// map with the defaults, then loads the option on top). Values may be numbers
/// or numeric strings. `BTreeMap` for a deterministic response ordering. Pure.
pub(crate) fn merged_ratio_map(
    defaults: &[(&str, f64)],
    option: Option<&str>,
) -> std::collections::BTreeMap<String, f64> {
    let mut map: std::collections::BTreeMap<String, f64> = defaults
        .iter()
        .map(|(name, ratio)| (name.to_string(), *ratio))
        .collect();
    if let Some(raw) = option {
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(overrides) =
                serde_json::from_str::<std::collections::HashMap<String, serde_json::Value>>(raw)
            {
                for (name, value) in overrides {
                    if let Some(ratio) = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
                    {
                        map.insert(name, ratio);
                    }
                }
            }
        }
    }
    map
}

/// `GET /api/ratio_config`: expose the merged model/completion/cache/price
/// ratio tables (Go `GetRatioConfig` -> `GetExposedData`), gated by the
/// `ExposeRatioEnabled` option (default off -> 403). Each map is the ported
/// default table merged with its option override.
pub async fn get_ratio_config(_req: Request, env: Env) -> WorkerResult<Response> {
    use cinatoken_core::default_ratios as dr;
    let db = env.d1("DB")?;
    let enabled = parse_bool_option(
        d1_repositories::get_option(&db, "ExposeRatioEnabled")
            .await?
            .as_deref(),
        false,
    );
    if !enabled {
        return Ok(envelope_error_response(
            403,
            "ratio config endpoint is not enabled",
        ));
    }
    let opts = d1_repositories::option_values(
        &db,
        &[
            "ModelRatio",
            "CompletionRatio",
            "CacheRatio",
            "CreateCacheRatio",
            "ModelPrice",
        ],
    )
    .await?;
    let data = serde_json::json!({
        "model_ratio": merged_ratio_map(dr::DEFAULT_MODEL_RATIO, opts[0].as_deref()),
        "completion_ratio": merged_ratio_map(dr::DEFAULT_COMPLETION_RATIO, opts[1].as_deref()),
        "cache_ratio": merged_ratio_map(dr::DEFAULT_CACHE_RATIO, opts[2].as_deref()),
        "create_cache_ratio": merged_ratio_map(dr::DEFAULT_CREATE_CACHE_RATIO, opts[3].as_deref()),
        "model_price": merged_ratio_map(dr::DEFAULT_MODEL_PRICE, opts[4].as_deref()),
    });
    Ok(envelope_ok_response(&data)?)
}

// ---------------------------------------------------------------------------
// Notification settings (Go UpdateUserSetting)
// ---------------------------------------------------------------------------

/// Request body for `PUT /api/user/setting` (Go `UpdateUserSettingRequest`).
#[derive(Debug, Deserialize, Default)]
pub struct UpdateUserSettingRequest {
    #[serde(default, rename = "notify_type")]
    pub notify_type: String,
    #[serde(default)]
    pub quota_warning_threshold: f64,
    #[serde(default)]
    pub webhook_url: String,
    #[serde(default)]
    pub webhook_secret: String,
    #[serde(default)]
    pub notification_email: String,
    #[serde(default)]
    pub bark_url: String,
    #[serde(default)]
    pub gotify_url: String,
    #[serde(default)]
    pub gotify_token: String,
    #[serde(default)]
    pub gotify_priority: i64,
    #[serde(default)]
    pub upstream_model_update_notify_enabled: Option<bool>,
    #[serde(default)]
    pub accept_unset_model_ratio_model: bool,
    #[serde(default)]
    pub record_ip_log: bool,
}

/// Validate a notification-settings request (Go `UpdateUserSetting` checks):
/// notify_type in {email,webhook,bark,gotify}; threshold > 0; and the
/// type-specific URL/email/token requirements. URL validation approximates Go's
/// `url.ParseRequestURI` with a scheme (`://`) check, plus the explicit http(s)
/// requirement for Bark. Pure, so it is unit-testable.
pub fn validate_user_setting(req: &UpdateUserSettingRequest) -> Result<(), String> {
    match req.notify_type.as_str() {
        "email" | "webhook" | "bark" | "gotify" => {}
        _ => return Err("invalid notify type".to_string()),
    }
    if req.quota_warning_threshold <= 0.0 {
        return Err("quota warning threshold must be greater than zero".to_string());
    }
    match req.notify_type.as_str() {
        "webhook" => {
            if req.webhook_url.is_empty() {
                return Err("webhook url is required".to_string());
            }
            if !req.webhook_url.contains("://") {
                return Err("webhook url is invalid".to_string());
            }
        }
        "email" => {
            if !req.notification_email.is_empty() && !req.notification_email.contains('@') {
                return Err("notification email is invalid".to_string());
            }
        }
        "bark" => {
            if req.bark_url.is_empty() {
                return Err("bark url is required".to_string());
            }
            if !(req.bark_url.starts_with("http://") || req.bark_url.starts_with("https://")) {
                return Err("bark url must start with http:// or https://".to_string());
            }
        }
        "gotify" => {
            if req.gotify_url.is_empty() {
                return Err("gotify url is required".to_string());
            }
            if req.gotify_token.is_empty() {
                return Err("gotify token is required".to_string());
            }
            if !req.gotify_url.contains("://") {
                return Err("gotify url is invalid".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Build the persisted notification `setting` JSON from a validated request and
/// the caller's (already admin-resolved) `upstream_notify` flag. Mirrors Go's
/// fresh `dto.UserSetting` build: the common fields plus only the type-specific
/// fields for the selected `notify_type`. Pure/testable. Note (Go-faithful):
/// this REPLACES the setting, so sidebar_modules/language are dropped — same as
/// Go's `SetSetting`.
fn build_notify_setting(
    req: &UpdateUserSettingRequest,
    upstream_notify: bool,
) -> serde_json::Value {
    let mut setting = serde_json::Map::new();
    setting.insert("notify_type".into(), serde_json::json!(req.notify_type));
    setting.insert(
        "quota_warning_threshold".into(),
        serde_json::json!(req.quota_warning_threshold),
    );
    setting.insert(
        "upstream_model_update_notify_enabled".into(),
        serde_json::json!(upstream_notify),
    );
    setting.insert(
        "accept_unset_model_ratio_model".into(),
        serde_json::json!(req.accept_unset_model_ratio_model),
    );
    setting.insert("record_ip_log".into(), serde_json::json!(req.record_ip_log));
    match req.notify_type.as_str() {
        "webhook" => {
            setting.insert("webhook_url".into(), serde_json::json!(req.webhook_url));
            if !req.webhook_secret.is_empty() {
                setting.insert(
                    "webhook_secret".into(),
                    serde_json::json!(req.webhook_secret),
                );
            }
        }
        "email" => {
            if !req.notification_email.is_empty() {
                setting.insert(
                    "notification_email".into(),
                    serde_json::json!(req.notification_email),
                );
            }
        }
        "bark" => {
            setting.insert("bark_url".into(), serde_json::json!(req.bark_url));
        }
        "gotify" => {
            setting.insert("gotify_url".into(), serde_json::json!(req.gotify_url));
            setting.insert("gotify_token".into(), serde_json::json!(req.gotify_token));
            // Gotify priority is 0-10; out-of-range falls back to the default 5.
            let priority = if (0..=10).contains(&req.gotify_priority) {
                req.gotify_priority
            } else {
                5
            };
            setting.insert("gotify_priority".into(), serde_json::json!(priority));
        }
        _ => {}
    }
    serde_json::Value::Object(setting)
}

/// `PUT /api/user/setting`: persist the caller's notification preferences (Go
/// `UpdateUserSetting`). The `upstream_model_update_notify_enabled` flag is only
/// honored for admins (else the existing value is kept). Note the actual
/// notification dispatch (email/webhook/bark/gotify on quota warnings) is a
/// separate, unported subsystem — this endpoint only stores the config.
pub async fn update_user_setting(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UpdateUserSettingRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid setting request: {err}"),
            ));
        }
    };
    if let Err(message) = validate_user_setting(&payload) {
        return Ok(envelope_error_response(400, &message));
    }

    let db = env.d1("DB")?;
    let existing = d1_repositories::get_user_setting(&db, claims.id)
        .await?
        .unwrap_or_default();
    let existing_upstream = serde_json::from_str::<serde_json::Value>(existing.trim())
        .ok()
        .and_then(|value| {
            value
                .get("upstream_model_update_notify_enabled")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    let upstream_notify = if claims.role >= ROLE_ADMIN_USER {
        payload
            .upstream_model_update_notify_enabled
            .unwrap_or(existing_upstream)
    } else {
        existing_upstream
    };

    let setting = build_notify_setting(&payload, upstream_notify);
    d1_repositories::update_user_setting(&db, claims.id, &setting.to_string()).await?;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

// ---------------------------------------------------------------------------
// Usable groups (Go GetUserGroups)
// ---------------------------------------------------------------------------

/// Go `defaultUserUsableGroups` (group -> description).
const DEFAULT_USABLE_GROUPS: &[(&str, &str)] = &[("default", "默认分组"), ("vip", "vip分组")];
/// Go `defaultGroupRatio` (group -> ratio).
const DEFAULT_GROUP_RATIOS: &[(&str, f64)] = &[("default", 1.0), ("vip", 1.0), ("svip", 1.0)];

/// Parse the `UserUsableGroups` option (a JSON `{group: desc}` map). Go REPLACES
/// the map on config, so a set option overrides the defaults entirely; an absent
/// or unparseable option falls back to [`DEFAULT_USABLE_GROUPS`].
pub(crate) fn parse_usable_groups(
    option: Option<&str>,
) -> std::collections::HashMap<String, String> {
    if let Some(raw) = option {
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, String>>(raw)
            {
                return map;
            }
        }
    }
    DEFAULT_USABLE_GROUPS
        .iter()
        .map(|(group, desc)| (group.to_string(), desc.to_string()))
        .collect()
}

/// Parse the group-ratio option (JSON `{group: ratio}`) merged onto
/// [`DEFAULT_GROUP_RATIOS`] (Go seeds the map with the defaults via `AddAll`,
/// then loads the option on top). Ratio values may be numbers or numeric
/// strings.
pub(crate) fn parse_group_ratios(option: Option<&str>) -> std::collections::HashMap<String, f64> {
    let mut ratios: std::collections::HashMap<String, f64> = DEFAULT_GROUP_RATIOS
        .iter()
        .map(|(group, ratio)| (group.to_string(), *ratio))
        .collect();
    if let Some(raw) = option {
        let raw = raw.trim();
        if !raw.is_empty() {
            if let Ok(map) =
                serde_json::from_str::<std::collections::HashMap<String, serde_json::Value>>(raw)
            {
                for (group, value) in map {
                    if let Some(ratio) = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
                    {
                        ratios.insert(group, ratio);
                    }
                }
            }
        }
    }
    ratios
}

/// Build the GetUserGroups response: the groups present in BOTH the ratio map
/// and the usable map, each `{ratio, desc}`, plus the `auto` special entry
/// (`ratio: "自动"`) when `auto` is usable. Pure, so it is unit-testable.
fn build_user_groups(
    usable: &std::collections::HashMap<String, String>,
    ratios: &std::collections::HashMap<String, f64>,
) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for (group, ratio) in ratios {
        if let Some(desc) = usable.get(group) {
            out.insert(
                group.clone(),
                serde_json::json!({ "ratio": ratio, "desc": desc }),
            );
        }
    }
    if let Some(desc) = usable.get("auto") {
        out.insert(
            "auto".to_string(),
            serde_json::json!({ "ratio": "自动", "desc": desc }),
        );
    }
    serde_json::Value::Object(out)
}

fn sorted_group_names(ratios: &std::collections::HashMap<String, f64>) -> Vec<String> {
    let mut groups: Vec<String> = ratios.keys().cloned().collect();
    groups.sort();
    groups
}

async fn configured_group_ratios(
    db: &worker::D1Database,
) -> WorkerResult<std::collections::HashMap<String, f64>> {
    let ratio_option =
        match d1_repositories::get_option(db, "group_ratio_setting.group_ratio").await? {
            Some(value) => Some(value),
            None => d1_repositories::get_option(db, "GroupRatio").await?,
        };
    Ok(parse_group_ratios(ratio_option.as_deref()))
}

/// Shared GetUserGroups body. `user_group` only feeds the per-user-group ratio
/// overrides / special usable-group `+:`/`-:` rules, both deferred (their Go
/// defaults are example placeholders), so the default-config result is identical
/// for the self and public variants.
async fn user_groups_response(env: &Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let usable = parse_usable_groups(
        d1_repositories::get_option(&db, "UserUsableGroups")
            .await?
            .as_deref(),
    );
    let ratios = configured_group_ratios(&db).await?;
    Ok(envelope_ok_response(&build_user_groups(&usable, &ratios))?)
}

/// `GET /api/group/`: all configured groups for channel/user admin forms.
pub async fn get_groups(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let ratios = configured_group_ratios(&db).await?;
    Ok(envelope_ok_response(&sorted_group_names(&ratios))?)
}

/// `GET /api/user/self/groups`: usable groups for the logged-in user.
pub async fn get_self_groups(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_user_auth(&req, &env).await? {
        return Ok(response);
    }
    user_groups_response(&env).await
}

/// `GET /api/user/groups`: usable groups (public; anonymous callers see the
/// default-config groups).
pub async fn get_public_groups(_req: Request, env: Env) -> WorkerResult<Response> {
    user_groups_response(&env).await
}

/// `GET /api/user/models`: the distinct enabled models available across the
/// caller's usable groups (Go `GetUserModels`). Uses the default-config usable
/// groups (per-user-group special rules deferred, as in GetUserGroups).
pub async fn get_self_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_user_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let usable = parse_usable_groups(
        d1_repositories::get_option(&db, "UserUsableGroups")
            .await?
            .as_deref(),
    );
    let mut models: Vec<String> = Vec::new();
    for group in usable.keys() {
        for model in d1_repositories::distinct_enabled_models_for_group(&db, group).await? {
            if !models.contains(&model) {
                models.push(model);
            }
        }
    }
    Ok(envelope_ok_response(&models)?)
}

// ---------------------------------------------------------------------------
// Account bindings (custom OAuth + built-in binding clear)
// ---------------------------------------------------------------------------

pub async fn list_self_oauth_bindings(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let bindings = d1_repositories::list_user_oauth_bindings(&db, claims.id).await?;
    envelope_ok_response(&oauth_binding_responses(bindings))
}

pub async fn unbind_self_oauth_binding(
    req: Request,
    env: Env,
    provider_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let provider_id = match parse_id_param(provider_id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "invalid provider id")),
    };
    let db = env.d1("DB")?;
    let _deleted = d1_repositories::delete_user_oauth_binding(&db, claims.id, provider_id).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "user.oauth_unbind",
        &format!(
            "user {} unbound custom OAuth provider {}",
            claims.username, provider_id
        ),
        &serde_json::json!({"provider_id": provider_id, "self_service": true}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn list_user_oauth_bindings_by_admin(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let target = match require_manage_target_user(&db, &claims, id_param).await {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    let bindings = d1_repositories::list_user_oauth_bindings(&db, target.id).await?;
    envelope_ok_response(&oauth_binding_responses(bindings))
}

pub async fn unbind_user_oauth_binding_by_admin(
    req: Request,
    env: Env,
    id_param: Option<&String>,
    provider_id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let provider_id = match parse_id_param(provider_id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "invalid provider id")),
    };
    let db = env.d1("DB")?;
    let target = match require_manage_target_user(&db, &claims, id_param).await {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    let _deleted = d1_repositories::delete_user_oauth_binding(&db, target.id, provider_id).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(target.id),
        Some(&target.username),
        &claims.username,
        "user.oauth_unbind",
        &format!(
            "admin {} unbound custom OAuth provider {} for user {}",
            claims.username, provider_id, target.id
        ),
        &serde_json::json!({
            "id": target.id,
            "username": &target.username,
            "provider_id": provider_id
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn clear_user_binding_by_admin(
    req: Request,
    env: Env,
    id_param: Option<&String>,
    binding_type_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let binding_type = match binding_type_param {
        Some(binding_type) => binding_type.trim().to_ascii_lowercase(),
        None => String::new(),
    };
    if binding_type.is_empty() {
        return Ok(envelope_error_response(400, "invalid binding type"));
    }
    let db = env.d1("DB")?;
    let target = match require_manage_target_user(&db, &claims, id_param).await {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    let cleared =
        match d1_repositories::clear_user_builtin_binding(&db, target.id, &binding_type).await? {
            Some(cleared) => cleared,
            None => return Ok(envelope_error_response(400, "invalid binding type")),
        };
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(target.id),
        Some(&target.username),
        &claims.username,
        "user.binding_clear",
        &format!(
            "admin {} cleared {} binding for user {}",
            claims.username, binding_type, target.id
        ),
        &serde_json::json!({
            "id": target.id,
            "username": &target.username,
            "bindingType": binding_type,
            "cleared": cleared
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn update_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: UserUpdateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid user update request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let Some(origin) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    // Caller must outrank the origin role.
    if !is_root(claims.role) && !outranks(claims.role, origin.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to edit this user",
        ));
    }
    // Caller must also outrank the new role if the body attempts to change it.
    // (Edit itself does not persist role, but we check defensively.)
    if let Some(new_role) = payload.role {
        if !is_root(claims.role) && !outranks(claims.role, new_role) {
            return Ok(envelope_error_response(
                403,
                "cannot set a role equal to or higher than your own",
            ));
        }
    }
    let password_hash = if payload.password.as_deref().is_some_and(|p| !p.is_empty()) {
        match hash_password(payload.password.as_deref().unwrap_or("")) {
            Ok(hash) => Some(hash),
            Err(err) => {
                return Ok(envelope_error_response(
                    500,
                    &format!("failed to hash password: {err}"),
                ));
            }
        }
    } else {
        None
    };
    let updated = d1_repositories::edit_user(
        &db,
        id,
        payload.username.as_deref(),
        payload.display_name.as_deref(),
        payload.group.as_deref(),
        payload.remark.as_deref(),
        password_hash.as_deref(),
    )
    .await?;
    if !updated {
        return Ok(envelope_error_response(
            404,
            "user not found or no fields to update",
        ));
    }
    // If a role change was requested, persist it via a dedicated update.
    if let Some(new_role) = payload.role {
        let _ = d1_repositories::set_user_role(&db, id, new_role).await;
        let _ = invalidate_token_cache(&env).await;
    }
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "user.update",
        &format!("admin {} updated user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

pub async fn delete_user(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    // Strict outrank: caller's role must be STRICTLY GREATER than the
    // target's role. This is stricter than the `outranks` helper (which lets
    // root bypass equality) and matches Go's `myRole <= originUser.Role`
    // rejection: even root cannot delete another root.
    if claims.role <= target.role {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to delete this user",
        ));
    }
    let deleted = d1_repositories::soft_delete_user(&db, id, unix_timestamp()).await?;
    if !deleted {
        return Ok(envelope_error_response(
            404,
            "user not found or already deleted",
        ));
    }
    let _ = invalidate_token_cache(&env).await;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "user.delete",
        &format!("admin {} deleted user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&serde_json::Value::Null)?)
}

/// `POST /api/user/:id/2fa/disable`: an admin clears a target user's 2FA
/// (account recovery when the user loses their authenticator). Requires manage
/// privilege over the target (`is_root || outranks`) and is audited. Mirrors Go
/// `AdminDisable2FA`.
pub async fn admin_disable_2fa(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "user id is required")),
    };
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    if !is_root(claims.role) && !outranks(claims.role, target.role) {
        return Ok(envelope_error_response(
            403,
            "insufficient privileges to manage this user",
        ));
    }
    d1_repositories::delete_two_fa(&db, id).await?;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        "two_fa.admin_disable",
        &format!("admin {} disabled 2FA for user {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::json!({ "disabled": true }))
}

/// `DELETE /api/user/:id/reset_passkey`: admin account recovery for a user who
/// lost their Passkey. Mirrors Go `AdminResetPasskey`: manage-target privilege,
/// report "not bound" as a 200 envelope error, hard-delete credentials, audit.
pub async fn reset_user_passkey(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let target = match require_manage_target_user(&db, &claims, id_param).await {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    if !d1_repositories::passkey_exists_by_user(&db, target.id).await? {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    }
    if !d1_repositories::delete_passkey_by_user(&db, target.id).await? {
        return Ok(envelope_error_response(
            200,
            "this user has not bound Passkey",
        ));
    }
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(target.id),
        Some(&target.username),
        &claims.username,
        "user.reset_passkey",
        &format!(
            "admin {} reset Passkey for user {}",
            claims.username, target.id
        ),
        &serde_json::json!({
            "id": target.id,
            "username": &target.username
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&serde_json::json!({ "reset": true }))
}

// ---------------------------------------------------------------------------
// ManageUser (the action switch)
// ---------------------------------------------------------------------------

pub async fn manage_user(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ManageUserRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid manage user request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let Some(target) = d1_repositories::find_user_role_status(&db, id).await? else {
        return Ok(envelope_error_response(404, "user not found"));
    };
    let action = payload.action.trim().to_ascii_lowercase();
    let target_is_root = target.role >= ROLE_ROOT_USER;

    // Permission gate shared by most actions: caller must outrank the target.
    let can_manage = is_root(claims.role) || outranks(claims.role, target.role);

    let mut invalidate = false;
    match action.as_str() {
        "disable" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot disable a root user"));
            }
            let _ = d1_repositories::set_user_status(&db, id, USER_STATUS_DISABLED).await;
            invalidate = true;
        }
        "enable" => {
            if !can_manage {
                return Ok(forbidden());
            }
            let _ = d1_repositories::set_user_status(&db, id, USER_STATUS_ENABLED).await;
            // Go does not invalidate on enable.
        }
        "delete" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot delete a root user"));
            }
            let _ = d1_repositories::soft_delete_user(&db, id, unix_timestamp()).await;
            invalidate = true;
        }
        "promote" => {
            if !is_root(claims.role) {
                return Ok(envelope_error_response(403, "only root can promote users"));
            }
            if target.role >= ROLE_ADMIN_USER {
                return Ok(envelope_error_response(400, "user is already an admin"));
            }
            let _ = d1_repositories::set_user_role(&db, id, ROLE_ADMIN_USER).await;
            invalidate = true;
        }
        "demote" => {
            if !can_manage {
                return Ok(forbidden());
            }
            if target_is_root {
                return Ok(envelope_error_response(403, "cannot demote a root user"));
            }
            if target.role <= ROLE_COMMON_USER {
                return Ok(envelope_error_response(
                    400,
                    "user is already a common user",
                ));
            }
            let _ = d1_repositories::set_user_role(&db, id, ROLE_COMMON_USER).await;
            invalidate = true;
        }
        "add_quota" => {
            if !can_manage {
                return Ok(forbidden());
            }
            let value = payload.value.unwrap_or(0);
            match payload.mode.as_deref().unwrap_or("add") {
                "add" => {
                    let _ = d1_repositories::increase_user_quota(&db, id, value).await;
                }
                "subtract" => {
                    let _ = d1_repositories::decrease_user_quota(&db, id, value).await;
                }
                "override" => {
                    let _ = d1_repositories::override_user_quota(&db, id, value).await;
                }
                other => {
                    return Ok(envelope_error_response(
                        400,
                        &format!("unknown quota mode: {other}"),
                    ));
                }
            }
            // Go does not invalidate token cache on quota changes.
        }
        other => {
            return Ok(envelope_error_response(
                400,
                &format!("unknown manage action: {other}"),
            ));
        }
    }
    if invalidate {
        let _ = invalidate_token_cache(&env).await;
    }
    // Record the audit row. The action name and params mirror Go's
    // per-action audit calls (user.manage / user.quota_add / etc.).
    let (audit_action, audit_params) = match action.as_str() {
        "add_quota" => {
            let mode = payload.mode.as_deref().unwrap_or("add");
            let named = match mode {
                "subtract" => "user.quota_subtract",
                "override" => "user.quota_override",
                _ => "user.quota_add",
            };
            (
                named,
                serde_json::json!({"id": id, "value": payload.value.unwrap_or(0), "mode": mode}),
            )
        }
        other => (
            "user.manage",
            serde_json::json!({"action": other, "id": id}),
        ),
    };
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(id),
        None,
        &claims.username,
        audit_action,
        &format!(
            "admin {} performed {} on user {}",
            claims.username, audit_action, id
        ),
        &audit_params,
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    // Return the post-action role + status (re-read).
    let after = d1_repositories::find_user_role_status(&db, id).await?;
    Ok(envelope_ok_response(&ManageUserResult {
        role: after.as_ref().map(|r| r.role).unwrap_or(target.role),
        status: after.as_ref().map(|r| r.status).unwrap_or(target.status),
    })?)
}

fn forbidden() -> Response {
    envelope_error_response(403, "insufficient privileges to manage this user")
}

async fn require_manage_target_user(
    db: &worker::D1Database,
    claims: &cinatoken_session::SessionClaims,
    id_param: Option<&String>,
) -> std::result::Result<d1_repositories::AdminUserFullRow, Response> {
    let id = parse_id_param(id_param)
        .ok_or_else(|| envelope_error_response(400, "user id is required"))?;
    let target = d1_repositories::find_user_role_status(db, id)
        .await
        .map_err(|err| envelope_error_response(500, &format!("failed to load user: {err}")))?
        .ok_or_else(|| envelope_error_response(404, "user not found"))?;
    if !is_root(claims.role) && !outranks(claims.role, target.role) {
        return Err(forbidden());
    }
    d1_repositories::find_user_by_id_full(db, id)
        .await
        .map_err(|err| envelope_error_response(500, &format!("failed to load user: {err}")))?
        .ok_or_else(|| envelope_error_response(404, "user not found"))
}

fn oauth_binding_responses(
    rows: Vec<d1_repositories::UserOAuthBindingJoinedRow>,
) -> Vec<OAuthBindingResponse> {
    rows.into_iter()
        .map(|row| OAuthBindingResponse {
            provider_id: row.provider_id,
            provider_name: row.provider_name,
            provider_slug: row.provider_slug,
            provider_icon: row.provider_icon,
            provider_user_id: row.provider_user_id.clone(),
            external_id: row.provider_user_id,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers and DTOs
// ---------------------------------------------------------------------------

fn parse_pagination(req: &Request) -> (u32, u32) {
    let page = parse_query_u32(req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(req, "page_size")
        .unwrap_or(10)
        .clamp(1, 100);
    (page, page_size)
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let pair = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if pair.is_empty() {
        None
    } else {
        Some(pair)
    }
}

fn parse_query_i32(req: &Request, key: &str) -> Option<i32> {
    parse_query_string(req, key)?.parse::<i32>().ok()
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse::<i64>().ok()
}

/// Generate a 4-character alphanumeric affiliation code, matching the Go
/// `common.GetRandomString(4)` behavior.
fn random_aff_code() -> String {
    let alphabet: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut out = String::with_capacity(4);
    for _ in 0..4 {
        let r = js_sys::Math::random() * (alphabet.len() as f64);
        out.push(alphabet[r as usize] as char);
    }
    out
}

/// Admin-facing user response. `access_token` is intentionally absent (never
/// useful in an admin response). `password` is never selected by the SQL.
#[derive(Debug, Serialize)]
struct UserResponse {
    id: i64,
    username: String,
    display_name: String,
    role: i32,
    status: i32,
    email: String,
    github_id: String,
    discord_id: String,
    oidc_id: String,
    wechat_id: String,
    telegram_id: String,
    linux_do_id: String,
    quota: i64,
    used_quota: i64,
    request_count: i64,
    #[serde(rename = "group")]
    channel_group: String,
    aff_code: String,
    aff_count: i64,
    aff_quota: i64,
    aff_history_quota: i64,
    inviter_id: i64,
    setting: String,
    remark: String,
    stripe_customer: String,
    created_at: i64,
    last_login_at: i64,
    deleted_at: Option<i64>,
}

fn user_response(row: d1_repositories::AdminUserFullRow) -> UserResponse {
    UserResponse {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        status: row.status,
        email: row.email,
        github_id: row.github_id,
        discord_id: row.discord_id,
        oidc_id: row.oidc_id,
        wechat_id: row.wechat_id,
        telegram_id: row.telegram_id,
        linux_do_id: row.linux_do_id,
        quota: row.quota,
        used_quota: row.used_quota,
        request_count: row.request_count,
        channel_group: row.channel_group,
        aff_code: row.aff_code,
        aff_count: row.aff_count,
        aff_quota: row.aff_quota,
        aff_history_quota: row.aff_history_quota,
        inviter_id: row.inviter_id,
        setting: row.setting,
        remark: row.remark,
        stripe_customer: row.stripe_customer,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
        deleted_at: row.deleted_at,
    }
}

#[derive(Debug, Serialize)]
struct UsersPage {
    items: Vec<UserResponse>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Serialize)]
struct UserCreateResult {
    id: i64,
}

#[derive(Debug, Serialize)]
struct OAuthBindingResponse {
    provider_id: i64,
    provider_name: String,
    provider_slug: String,
    provider_icon: String,
    provider_user_id: String,
    external_id: String,
}

#[derive(Debug, Serialize)]
struct ManageUserResult {
    role: i32,
    status: i32,
}

#[derive(Debug, Deserialize)]
struct UserCreateRequest {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    role: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct UserUpdateRequest {
    id: i64,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    remark: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    role: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ManageUserRequest {
    id: i64,
    action: String,
    #[serde(default)]
    value: Option<i64>,
    #[serde(default)]
    mode: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinatoken_auth::{ROLE_ADMIN_USER, ROLE_COMMON_USER, ROLE_ROOT_USER};

    #[test]
    fn permission_rules_match_go_canmanage() {
        // Root can manage anyone (including other roots).
        assert!(is_root(ROLE_ROOT_USER) || outranks(ROLE_ROOT_USER, ROLE_ROOT_USER));
        assert!(is_root(ROLE_ROOT_USER) || outranks(ROLE_ROOT_USER, ROLE_ADMIN_USER));
        // Admin can manage common users but not other admins.
        assert!(!is_root(ROLE_ADMIN_USER));
        assert!(outranks(ROLE_ADMIN_USER, ROLE_COMMON_USER));
        assert!(!outranks(ROLE_ADMIN_USER, ROLE_ADMIN_USER));
        // Common users cannot manage anyone.
        assert!(!outranks(ROLE_COMMON_USER, ROLE_COMMON_USER));
    }

    #[test]
    fn delete_requires_strict_outrank() {
        // DeleteUser uses `claims.role > target.role` (strictly greater).
        // Root can delete admin/common but NOT another root; admin can
        // delete common only.
        assert!(ROLE_ROOT_USER > ROLE_ADMIN_USER);
        assert!(ROLE_ROOT_USER > ROLE_COMMON_USER);
        assert!(!(ROLE_ROOT_USER > ROLE_ROOT_USER));
        assert!(ROLE_ADMIN_USER > ROLE_COMMON_USER);
        assert!(!(ROLE_ADMIN_USER > ROLE_ADMIN_USER));
    }

    #[test]
    fn user_create_request_defaults_role_to_common() {
        let req: UserCreateRequest =
            serde_json::from_str(r#"{"username":"alice","password":"pw123456"}"#).unwrap();
        assert_eq!(req.role, None); // handler defaults to ROLE_COMMON_USER
        assert!(req.display_name.is_none());
    }

    #[test]
    fn manage_user_request_parses_quota_action() {
        let req: ManageUserRequest =
            serde_json::from_str(r#"{"id":7,"action":"add_quota","value":500,"mode":"add"}"#)
                .unwrap();
        assert_eq!(req.id, 7);
        assert_eq!(req.action, "add_quota");
        assert_eq!(req.value, Some(500));
        assert_eq!(req.mode.as_deref(), Some("add"));
    }

    #[test]
    fn manage_user_request_defaults_mode_and_value() {
        let req: ManageUserRequest =
            serde_json::from_str(r#"{"id":1,"action":"disable"}"#).unwrap();
        assert_eq!(req.value, None);
        assert_eq!(req.mode, None);
    }

    #[test]
    fn user_update_request_all_fields_optional_except_id() {
        let req: UserUpdateRequest = serde_json::from_str(r#"{"id":42}"#).unwrap();
        assert_eq!(req.id, 42);
        assert!(req.username.is_none());
        assert!(req.password.is_none());
        assert!(req.role.is_none());
    }

    #[test]
    fn parse_id_param_accepts_numeric_strings() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"  7 ".to_string())), Some(7));
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
        assert_eq!(parse_id_param(None), None);
    }

    #[test]
    fn register_validation_matches_go_user_tags() {
        // Happy path.
        assert!(validate_registration("alice", "password1", "a@b.co").is_ok());
        // Empty username rejected.
        assert!(validate_registration("", "password1", "").is_err());
        // Username > 20 chars rejected (Go `max=20`).
        assert!(validate_registration(&"u".repeat(21), "password1", "").is_err());
        assert!(validate_registration(&"u".repeat(20), "password1", "").is_ok());
        // Password 8..=20 (Go `min=8,max=20`).
        assert!(validate_registration("bob", "short", "").is_err()); // 5 chars
        assert!(validate_registration("bob", "eightchr", "").is_ok()); // 8 chars
        assert!(validate_registration("bob", &"p".repeat(20), "").is_ok());
        assert!(validate_registration("bob", &"p".repeat(21), "").is_err());
        // Email > 50 chars rejected (Go `max=50`); empty email is fine.
        assert!(validate_registration("bob", "password1", &"x".repeat(51)).is_err());
        assert!(validate_registration("bob", "password1", "").is_ok());
    }

    #[test]
    fn register_request_treats_all_fields_optional() {
        // A minimal body parses; missing fields default to empty.
        let req: RegisterRequest =
            serde_json::from_str(r#"{"username":"alice","password":"password1"}"#).unwrap();
        assert_eq!(req.username, "alice");
        assert_eq!(req.password, "password1");
        assert!(req.email.is_empty());
        assert!(req.aff_code.is_empty());
        assert!(req.verification_code.is_empty());
    }

    #[test]
    fn self_update_validation_matches_go_tags() {
        // All-None (no changes) is valid.
        assert!(validate_self_update(None, None, None).is_ok());
        // username / display_name max=20.
        assert!(validate_self_update(Some(&"u".repeat(20)), None, None).is_ok());
        assert!(validate_self_update(Some(&"u".repeat(21)), None, None).is_err());
        assert!(validate_self_update(None, Some(&"d".repeat(21)), None).is_err());
        // password: empty means "no change" (valid); non-empty must be 8..=20.
        assert!(validate_self_update(None, None, Some("")).is_ok());
        assert!(validate_self_update(None, None, Some("short")).is_err());
        assert!(validate_self_update(None, None, Some("eightchr")).is_ok());
        assert!(validate_self_update(None, None, Some(&"p".repeat(21))).is_err());
    }

    #[test]
    fn merge_setting_fields_updates_only_present_prefs() {
        // From {}: sets sidebar_modules.
        let s = merge_setting_fields("{}", &serde_json::json!({"sidebar_modules": "a,b,c"}));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["sidebar_modules"], serde_json::json!("a,b,c"));
        // Preserves existing fields; updates language only.
        let s2 = merge_setting_fields(
            r#"{"sidebar_modules":"x","language":"zh"}"#,
            &serde_json::json!({"language": "en"}),
        );
        let v2: serde_json::Value = serde_json::from_str(&s2).unwrap();
        assert_eq!(v2["sidebar_modules"], serde_json::json!("x")); // preserved
        assert_eq!(v2["language"], serde_json::json!("en")); // updated
                                                             // Blank/invalid current setting is treated as {}.
        let s3 = merge_setting_fields("", &serde_json::json!({"language": "en"}));
        let v3: serde_json::Value = serde_json::from_str(&s3).unwrap();
        assert_eq!(v3["language"], serde_json::json!("en"));
    }

    #[test]
    fn self_update_request_all_fields_optional() {
        let req: UpdateSelfRequest = serde_json::from_str(r#"{"display_name":"Bob"}"#).unwrap();
        assert_eq!(req.display_name.as_deref(), Some("Bob"));
        assert!(req.username.is_none());
        assert!(req.password.is_none());
        assert!(req.original_password.is_none());
        let empty: UpdateSelfRequest = serde_json::from_str("{}").unwrap();
        assert!(empty.username.is_none());
    }

    #[test]
    fn merged_ratio_map_overrides_defaults() {
        let defaults: &[(&str, f64)] = &[("a", 1.0), ("b", 2.0)];
        let d = merged_ratio_map(defaults, None);
        assert_eq!(d.get("a"), Some(&1.0));
        assert_eq!(d.get("b"), Some(&2.0));
        let m = merged_ratio_map(defaults, Some(r#"{"b":5,"c":"3"}"#));
        assert_eq!(m.get("a"), Some(&1.0)); // default kept
        assert_eq!(m.get("b"), Some(&5.0)); // overridden
        assert_eq!(m.get("c"), Some(&3.0)); // added from numeric string
    }

    #[test]
    fn user_setting_validation_matches_go() {
        let mk = |ty: &str| UpdateUserSettingRequest {
            notify_type: ty.to_string(),
            quota_warning_threshold: 0.8,
            ..Default::default()
        };
        // Bad type / non-positive threshold.
        assert!(validate_user_setting(&mk("sms")).is_err());
        let mut zero = mk("email");
        zero.quota_warning_threshold = 0.0;
        assert!(validate_user_setting(&zero).is_err());
        // email: optional address, but must contain '@' when present.
        assert!(validate_user_setting(&mk("email")).is_ok());
        let mut bad_email = mk("email");
        bad_email.notification_email = "no-at".to_string();
        assert!(validate_user_setting(&bad_email).is_err());
        // webhook requires a scheme'd url.
        assert!(validate_user_setting(&mk("webhook")).is_err());
        let mut wh = mk("webhook");
        wh.webhook_url = "https://h/x".to_string();
        assert!(validate_user_setting(&wh).is_ok());
        // bark must be http(s).
        let mut bark = mk("bark");
        bark.bark_url = "ftp://x".to_string();
        assert!(validate_user_setting(&bark).is_err());
        bark.bark_url = "https://x".to_string();
        assert!(validate_user_setting(&bark).is_ok());
        // gotify needs url + token.
        let mut go = mk("gotify");
        go.gotify_url = "https://g".to_string();
        assert!(validate_user_setting(&go).is_err()); // no token
        go.gotify_token = "tok".to_string();
        assert!(validate_user_setting(&go).is_ok());
    }

    #[test]
    fn build_notify_setting_gotify_clamps_priority() {
        let req = UpdateUserSettingRequest {
            notify_type: "gotify".to_string(),
            quota_warning_threshold: 0.9,
            gotify_url: "https://g".to_string(),
            gotify_token: "t".to_string(),
            gotify_priority: 99, // out of 0..=10 -> default 5
            ..Default::default()
        };
        let v = build_notify_setting(&req, true);
        assert_eq!(v["gotify_priority"], serde_json::json!(5));
        assert_eq!(v["gotify_url"], serde_json::json!("https://g"));
        assert_eq!(
            v["upstream_model_update_notify_enabled"],
            serde_json::json!(true)
        );
        // Non-selected-type fields are absent (fresh build, Go-faithful).
        assert!(v.get("webhook_url").is_none());
    }

    #[test]
    fn usable_groups_default_and_override() {
        // Absent/empty -> Go defaults.
        let d = parse_usable_groups(None);
        assert_eq!(d.get("default").map(String::as_str), Some("默认分组"));
        assert_eq!(d.get("vip").map(String::as_str), Some("vip分组"));
        assert!(parse_usable_groups(Some("")).contains_key("default"));
        // Set option REPLACES the map.
        let o = parse_usable_groups(Some(r#"{"gold":"Gold tier"}"#));
        assert_eq!(o.get("gold").map(String::as_str), Some("Gold tier"));
        assert!(!o.contains_key("default"));
    }

    #[test]
    fn group_ratios_merge_over_defaults() {
        // Defaults present when unset.
        let d = parse_group_ratios(None);
        assert_eq!(d.get("default"), Some(&1.0));
        assert_eq!(d.get("svip"), Some(&1.0));
        // Option merges/overrides; numeric strings accepted.
        let m = parse_group_ratios(Some(r#"{"vip":0.5,"gold":"2"}"#));
        assert_eq!(m.get("vip"), Some(&0.5)); // overridden
        assert_eq!(m.get("default"), Some(&1.0)); // default kept
        assert_eq!(m.get("gold"), Some(&2.0)); // added from string
    }

    #[test]
    fn group_names_are_stable_and_include_configured_groups() {
        let ratios = parse_group_ratios(Some(r#"{"vip":0.5,"gold":"2"}"#));
        assert_eq!(
            sorted_group_names(&ratios),
            vec!["default", "gold", "svip", "vip"]
        );
    }

    #[test]
    fn build_user_groups_intersects_and_adds_auto() {
        let usable: std::collections::HashMap<String, String> = [
            ("default", "默认分组"),
            ("vip", "vip分组"),
            ("auto", "自动选择"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let ratios = parse_group_ratios(None); // default,vip,svip
        let out = build_user_groups(&usable, &ratios);
        let obj = out.as_object().unwrap();
        // default+vip are in both maps; svip is rated but not usable -> excluded.
        assert!(obj.contains_key("default"));
        assert!(obj.contains_key("vip"));
        assert!(!obj.contains_key("svip"));
        assert_eq!(obj["default"]["ratio"], serde_json::json!(1.0));
        assert_eq!(obj["default"]["desc"], serde_json::json!("默认分组"));
        // auto is usable -> included with the "自动" ratio sentinel.
        assert_eq!(obj["auto"]["ratio"], serde_json::json!("自动"));
    }

    #[test]
    fn transfer_request_parses_and_defaults_quota() {
        let req: TransferAffQuotaRequest = serde_json::from_str(r#"{"quota":500000}"#).unwrap();
        assert_eq!(req.quota, 500_000);
        let empty: TransferAffQuotaRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.quota, 0); // below any QuotaPerUnit min -> rejected by handler
    }

    #[test]
    fn option_parsers_default_only_when_absent() {
        // Bool: Go stores "true"/"false"; "1" also truthy. Absent -> default.
        assert!(parse_bool_option(Some("true"), false));
        assert!(parse_bool_option(Some("1"), false));
        assert!(!parse_bool_option(Some("false"), true)); // present overrides default
        assert!(parse_bool_option(None, true));
        assert!(!parse_bool_option(None, false));
        // Int: parse, else default.
        assert_eq!(parse_int_option(Some("500000"), 0), 500_000);
        assert_eq!(parse_int_option(Some(" 42 "), 0), 42);
        assert_eq!(parse_int_option(Some("nan"), 7), 7);
        assert_eq!(parse_int_option(None, 0), 0);
    }
}
