//! Admin/frontend (G5) auth surface: login, logout, self, setup.
//!
//! These routes are the foundation of the operator control plane. They mirror
//! the Go gateway's `controller/user.go` (`Login`, `Logout`, `GetSelf`) and
//! `controller/setup.go` (`GetSetup`, `PostSetup`) behavior. The session is a
//! stateless HMAC-signed cookie issued by [`cinatoken_session`]; see
//! `docs/admin-frontend-parity-runbook.md` and `docs/frontend-deploy.md` for
//! the compatibility boundary (Go-issued cookies are not portable to Rust, so
//! the first visit after cutover requires a fresh sign-in — the documented
//! "Forced re-auth on Rust" G5 policy).
//!
//! Future G5 work (token/channel/user/log/option CRUD, OAuth, 2FA, Passkey)
//! plugs into the same `require_user_auth` / `require_admin_auth` /
//! `require_root_auth` helpers added here.

use std::collections::HashMap;

use cinatoken_auth::{
    hash_password, is_admin, is_root, verify_password, ROLE_ROOT_USER, USER_STATUS_ENABLED,
};
use cinatoken_core::ApiEnvelope;
use cinatoken_session::{
    build_clear_cookie_value, build_set_cookie_value, SessionClaims, SessionCodec, SessionError,
    COOKIE_NAME, MIN_SECRET_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::d1_repositories::AdminAuditInfo;

/// Build an `AdminAuditInfo` from the authenticated session claims and the
/// request's client IP. Used by every admin mutation handler to record a
/// durable audit row.
pub(crate) fn admin_audit_info(claims: &SessionClaims, req: &Request) -> AdminAuditInfo {
    AdminAuditInfo {
        admin_id: claims.id,
        admin_username: claims.username.clone(),
        admin_role: claims.role,
        auth_method: "session".to_string(),
        ip: crate::relay::client_ip(req).unwrap_or_default(),
    }
}

pub(crate) fn session_claims_from_user(
    user: &crate::d1_repositories::AdminUserRow,
) -> SessionClaims {
    SessionClaims {
        id: user.id,
        username: user.username.clone(),
        role: user.role,
        status: user.status,
        group: user.group.clone(),
        iat: 0,
        exp: 0,
    }
}

use crate::set_cors_headers;

const SESSION_SECRET_ENV: &str = "SESSION_SECRET";
pub(crate) const SECURE_VERIFICATION_METHOD_2FA: &str = "2fa";
pub(crate) const SECURE_VERIFICATION_METHOD_PASSKEY: &str = "passkey";
const SECURE_VERIFICATION_METHOD_PASSWORD: &str = "password";
const SETUP_USERNAME_MAX_LEN: usize = 12;
const SETUP_PASSWORD_MIN_LEN: usize = 8;
const SETUP_DEFAULT_ROOT_QUOTA: i64 = 100_000_000;
const SETUP_DEFAULT_DISPLAY_NAME: &str = "Root User";
const ADMIN_BODY_LIMIT_BYTES: usize = 64 * 1024;
const PUBLIC_STATUS_OPTION_KEYS: &[&str] = &[
    "SystemName",
    "Logo",
    "Footer",
    "DocsLink",
    "general_setting.docs_link",
    "general_setting.quota_display_type",
    "general_setting.custom_currency_symbol",
    "general_setting.custom_currency_exchange_rate",
    "RegisterEnabled",
    "PasswordLoginEnabled",
    "PasswordRegisterEnabled",
    "TurnstileSiteKey",
    "QuotaPerUnit",
    "DisplayInCurrencyEnabled",
    "USDExchangeRate",
    "DisplayTokenStatEnabled",
    "DemoSiteEnabled",
    "SelfUseModeEnabled",
    "legal.user_agreement",
    "legal.privacy_policy",
    "checkin_setting.enabled",
    "checkin_setting.min_quota",
    "checkin_setting.max_quota",
    "HeaderNavModules",
    "SidebarModulesAdmin",
    "oidc.authorization_endpoint",
    "model_deployment.ionet.enabled",
    "WeChatAuthEnabled",
    "WeChatAccountQRCodeImageURL",
    "passkey.enabled",
    "passkey.rp_display_name",
    "passkey.rp_id",
    "passkey.origins",
    "passkey.allow_insecure_origin",
    "passkey.user_verification",
    "passkey.attachment_preference",
];

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// `GET /api/status`: expose the Go-compatible public configuration envelope
/// consumed by the React application, while retaining Rust runtime diagnostics.
pub async fn get_status(_req: Request, env: Env) -> WorkerResult<Response> {
    let environment = env
        .var("ENVIRONMENT")
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "development".to_string());
    let mut runtime_status = cinatoken_api::status(environment);

    let db = env.d1("DB").ok();
    set_runtime_feature(&mut runtime_status, "d1", db.is_some());
    set_runtime_feature(
        &mut runtime_status,
        "upstash_redis",
        crate::cache::upstash_redis_configured(&env),
    );
    set_runtime_feature(
        &mut runtime_status,
        "relay_rate_limit",
        crate::relay::relay_rate_limit_configured(&env),
    );
    set_runtime_feature(
        &mut runtime_status,
        "relay_read_cache",
        crate::relay::relay_read_cache_configured(&env),
    );
    set_runtime_feature(
        &mut runtime_status,
        "session_auth",
        session_auth_configured(&env),
    );
    set_runtime_feature(&mut runtime_status, "workers_ai", env.ai("AI").is_ok());
    set_runtime_feature(
        &mut runtime_status,
        "ai_gateway",
        runtime_value(&env, "AI_GATEWAY_ID").is_some(),
    );

    let mut options = HashMap::new();
    let mut setup_completed = false;
    let mut custom_oauth_providers = Vec::new();
    if let Some(db) = db {
        match crate::d1_repositories::option_values(&db, PUBLIC_STATUS_OPTION_KEYS).await {
            Ok(values) => {
                for (key, value) in PUBLIC_STATUS_OPTION_KEYS.iter().zip(values) {
                    if let Some(value) = value {
                        options.insert((*key).to_string(), value);
                    }
                }
            }
            Err(err) => {
                worker::console_warn!("failed to read public status options: {}", err);
            }
        }
        match crate::d1_repositories::setup_completed(&db).await {
            Ok(completed) => setup_completed = completed,
            Err(err) => worker::console_warn!("failed to read setup status: {}", err),
        }
        match crate::d1_repositories::list_enabled_custom_oauth_providers(&db).await {
            Ok(rows) => {
                for row in rows {
                    match serde_json::to_value(crate::admin_custom_oauth::status_provider(row)) {
                        Ok(value) => custom_oauth_providers.push(value),
                        Err(err) => {
                            worker::console_warn!(
                                "failed to encode custom OAuth status provider: {}",
                                err
                            );
                        }
                    }
                }
            }
            Err(err) => {
                worker::console_warn!("failed to read custom OAuth providers: {}", err);
            }
        }
    }

    let public_runtime = PublicRuntimeConfig::from_env(&env);
    let data = build_frontend_status(
        runtime_status,
        &options,
        setup_completed,
        &public_runtime,
        &custom_oauth_providers,
    )?;
    envelope_ok_response(&data)
}

/// `POST /api/user/login`: authenticate by username/email + password, then
/// issue a signed session cookie and return the user summary.
pub async fn login(mut req: Request, env: Env) -> WorkerResult<Response> {
    // Turnstile gate (item 2.4): when configured, an anonymous login must carry
    // a valid `?turnstile=` token. No-op when TURNSTILE_SECRET is unset.
    if let Some(response) = crate::turnstile::require_turnstile(&req, &env).await? {
        return Ok(response);
    }
    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };

    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: LoginRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid login request body: {err}"),
            ));
        }
    };
    let username = payload.username.trim().to_string();
    if username.is_empty() || payload.password.is_empty() {
        return Ok(envelope_error_response(401, "invalid username or password"));
    }

    let db = env.d1("DB")?;
    let Some(user) = crate::d1_repositories::find_user_by_username_or_email(&db, &username).await?
    else {
        // Match the Go gateway's behavior: do not distinguish "no such user"
        // from "wrong password" in the response text.
        return Ok(envelope_error_response(401, "invalid username or password"));
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    let password_ok = match verify_password(&payload.password, &user.password) {
        Ok(ok) => ok,
        Err(err) => {
            worker::console_error!("bcrypt verify error for user {}: {}", user.id, err);
            // Treat a malformed hash as a login failure, not a 500 — the user
            // cannot log in until an admin resets the password.
            false
        }
    };
    if !password_ok {
        return Ok(envelope_error_response(401, "invalid username or password"));
    }

    // 2FA second factor: if the user has 2FA enabled, do NOT issue a session
    // yet. Hold a single-use pending marker (flow-state, keyed by an opaque
    // token -> user id) and require POST /api/user/login/2fa to finish.
    if let Some(two_fa) = crate::d1_repositories::find_two_fa_by_user(&db, user.id).await? {
        if two_fa.is_enabled != 0 {
            let Some(pending_token) = crate::admin_2fa::new_pending_token() else {
                return Ok(envelope_error_response(
                    500,
                    "failed to start 2FA challenge",
                ));
            };
            crate::flow_state::put(
                &env,
                crate::flow_state::FlowKind::TwoFaPending,
                &pending_token,
                &user.id.to_string(),
            )
            .await?;
            return Ok(envelope_ok_response(&TwoFaRequiredResponse {
                two_fa_required: true,
                pending_token,
            })?);
        }
    }

    let now = unix_timestamp();
    if let Err(err) = crate::d1_repositories::update_last_login_at(&db, user.id, now).await {
        worker::console_warn!(
            "failed to update last_login_at for user {}: {}",
            user.id,
            err
        );
    }

    let claims = session_claims_from_user(&user);
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ));
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

/// `POST /api/user/login/2fa` `{pending_token, code}`: complete a two-step login
/// for a 2FA-enabled user. Consumes the single-use pending marker from login,
/// verifies a TOTP code (or a single-use backup code), and issues the session.
pub async fn login_2fa(mut req: Request, env: Env) -> WorkerResult<Response> {
    let codec = match session_codec(&env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let pending_token = body
        .get("pending_token")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let code = body
        .get("code")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if pending_token.is_empty() || code.is_empty() {
        return Ok(envelope_error_response(
            400,
            "pending_token and code are required",
        ));
    }
    // Consume the pending marker (single-use): an expired/replayed token fails.
    let Some(user_id_raw) = crate::flow_state::take(
        &env,
        crate::flow_state::FlowKind::TwoFaPending,
        &pending_token,
    )
    .await?
    else {
        return Ok(envelope_error_response(
            401,
            "2FA challenge expired; sign in again",
        ));
    };
    let Ok(user_id) = user_id_raw.parse::<i64>() else {
        return Ok(envelope_error_response(401, "invalid 2FA challenge"));
    };

    let db = env.d1("DB")?;
    let Some(user) = crate::d1_repositories::find_user_by_id(&db, user_id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }
    let Some(two_fa) = crate::d1_repositories::find_two_fa_by_user(&db, user_id).await? else {
        return Ok(envelope_error_response(
            400,
            "2FA is not enabled for this user",
        ));
    };
    let now = unix_timestamp();
    match crate::admin_2fa::verify_2fa_code(&db, &two_fa, &code, now).await? {
        crate::admin_2fa::TwoFaVerifyResult::Verified => {}
        crate::admin_2fa::TwoFaVerifyResult::Locked { until } => {
            return Ok(envelope_error_response(
                429,
                &format!("too many 2FA attempts; locked until {until}"),
            ));
        }
        crate::admin_2fa::TwoFaVerifyResult::Invalid => {
            return Ok(envelope_error_response(401, "invalid 2FA code"));
        }
    }

    let claims = session_claims_from_user(&user);
    let cookie_value = match codec.issue(claims, now) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                500,
                &format!("failed to issue session: {err}"),
            ));
        }
    };
    let _ = crate::d1_repositories::update_last_login_at(&db, user.id, now).await;
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

/// `POST /api/verify`: secure-verification step-up (item 2.3). Re-authenticates
/// the already-logged-in user and records a short-lived `secure_verified_at`
/// marker in the [`crate::flow_state`] store, which gates sensitive operations
/// (key reveal) for the next 300s.
///
/// NOTE: Go `UniversalVerify` steps up via 2FA/passkey. Until 2FA/passkey
/// enrollment lands (item 4.6) this uses a password re-auth — a valid step-up
/// (it defends sensitive ops against a hijacked session, since the attacker
/// would still need the password) and a documented simplification of the Go
/// method set.
pub async fn secure_verify_handler(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    // Step-up method: "2fa" (TOTP or backup code), "passkey" (a marker created
    // only after the WebAuthn finish handler succeeds), or "password" (the
    // compatibility re-auth method). Passkey confirmation never refreshes the
    // marker, so replaying this endpoint cannot extend a completed ceremony.
    let method = body
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("password");
    let db = env.d1("DB")?;
    let Some(user) = crate::d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }
    let now = unix_timestamp();
    if method == SECURE_VERIFICATION_METHOD_PASSKEY {
        let Some(marker) = secure_verification_marker(&req, &env, claims.id).await? else {
            return Ok(envelope_error_response(401, "secure verification failed"));
        };
        if marker.method != SECURE_VERIFICATION_METHOD_PASSKEY {
            return Ok(envelope_error_response(401, "secure verification failed"));
        }
        let ttl = crate::flow_state::FlowKind::SecureVerify.default_ttl_secs() as i64;
        return envelope_ok_response(&serde_json::json!({
            "verified": true,
            "expires_at": marker.verified_at.saturating_add(ttl),
        }));
    }
    let verified = match method {
        SECURE_VERIFICATION_METHOD_2FA => {
            let code = body
                .get("code")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            match crate::d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
                Some(two_fa) if two_fa.is_enabled != 0 => {
                    match crate::admin_2fa::verify_2fa_code(&db, &two_fa, code, now).await? {
                        crate::admin_2fa::TwoFaVerifyResult::Verified => true,
                        crate::admin_2fa::TwoFaVerifyResult::Locked { until } => {
                            return Ok(envelope_error_response(
                                429,
                                &format!("too many 2FA attempts; locked until {until}"),
                            ));
                        }
                        crate::admin_2fa::TwoFaVerifyResult::Invalid => false,
                    }
                }
                _ => return Ok(envelope_error_response(400, "2FA is not enabled")),
            }
        }
        SECURE_VERIFICATION_METHOD_PASSWORD => {
            let password = body
                .get("password")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if password.is_empty() {
                return Ok(envelope_error_response(400, "password is required"));
            }
            verify_password(password, &user.password).unwrap_or(false)
        }
        _ => {
            return Ok(envelope_error_response(
                400,
                "unsupported verification method",
            ))
        }
    };
    if !verified {
        return Ok(envelope_error_response(401, "secure verification failed"));
    }
    mark_secure_verification(&req, &env, claims.id, method, now).await?;
    let ttl = crate::flow_state::FlowKind::SecureVerify.default_ttl_secs() as i64;
    envelope_ok_response(&serde_json::json!({
        "verified": true,
        "expires_at": now + ttl,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SecureVerificationMarker {
    method: String,
    verified_at: i64,
}

pub(crate) async fn mark_secure_verification(
    req: &Request,
    env: &Env,
    user_id: i64,
    method: &str,
    verified_at: i64,
) -> WorkerResult<()> {
    let marker = serde_json::to_string(&SecureVerificationMarker {
        method: method.to_string(),
        verified_at,
    })
    .map_err(|err| worker::Error::RustError(format!("encode secure verification: {err}")))?;
    let storage_id = session_binding_id(req, user_id).ok_or_else(|| {
        worker::Error::RustError("authenticated session cookie is unavailable".to_string())
    })?;
    crate::flow_state::put(
        env,
        crate::flow_state::FlowKind::SecureVerify,
        &storage_id,
        &marker,
    )
    .await
}

async fn secure_verification_marker(
    req: &Request,
    env: &Env,
    user_id: i64,
) -> WorkerResult<Option<SecureVerificationMarker>> {
    let Some(storage_id) = session_binding_id(req, user_id) else {
        return Ok(None);
    };
    let Some(value) =
        crate::flow_state::get(env, crate::flow_state::FlowKind::SecureVerify, &storage_id).await?
    else {
        return Ok(None);
    };
    Ok(decode_secure_verification_marker(&value, unix_timestamp()))
}

pub(crate) fn session_binding_id(req: &Request, user_id: i64) -> Option<String> {
    session_cookie(req)
        .as_deref()
        .map(|cookie| secure_verification_storage_id_for_cookie(user_id, cookie))
}

fn secure_verification_storage_id_for_cookie(user_id: i64, cookie: &str) -> String {
    let digest = Sha256::digest(cookie.as_bytes());
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{user_id}:{digest}")
}

fn decode_secure_verification_marker(value: &str, now: i64) -> Option<SecureVerificationMarker> {
    let marker = serde_json::from_str::<SecureVerificationMarker>(value)
        .ok()
        .or_else(|| {
            // Accept an in-flight marker written by the previous Worker version
            // for generic gates only. Method-specific gates intentionally reject it.
            value
                .parse::<i64>()
                .ok()
                .map(|verified_at| SecureVerificationMarker {
                    method: "legacy".to_string(),
                    verified_at,
                })
        });
    let Some(marker) = marker else {
        return None;
    };
    let ttl = crate::flow_state::FlowKind::SecureVerify.default_ttl_secs() as i64;
    let age = now.saturating_sub(marker.verified_at);
    if age < 0 || age >= ttl {
        return None;
    }
    Some(marker)
}

/// Step-up gate (item 2.3): returns `Some(403)` when `user_id` has no fresh
/// secure-verification marker, else `None`. The flow-state entry's 300s TTL IS
/// the freshness window (Go's `SecureVerificationTimeout`), so mere presence
/// means verified; `/api/verify` (re)sets it.
pub async fn require_secure_verification(
    req: &Request,
    env: &Env,
    user_id: i64,
) -> WorkerResult<Option<Response>> {
    let verified = secure_verification_marker(req, env, user_id)
        .await?
        .is_some();
    if verified {
        Ok(None)
    } else {
        Ok(Some(envelope_error_response(
            403,
            "secure verification required",
        )))
    }
}

pub(crate) async fn require_secure_verification_method(
    req: &Request,
    env: &Env,
    user_id: i64,
    method: &str,
) -> WorkerResult<Option<Response>> {
    let verified = secure_verification_marker(req, env, user_id)
        .await?
        .is_some_and(|marker| marker.method == method);
    if verified {
        Ok(None)
    } else {
        Ok(Some(envelope_error_response(
            403,
            "corresponding secure verification required",
        )))
    }
}

/// `GET|POST /api/user/logout`: clear the session cookie.
pub async fn logout(_req: Request, _env: Env) -> WorkerResult<Response> {
    let mut response = envelope_ok_response(&Value::Null)?;
    response
        .headers_mut()
        .append("Set-Cookie", &build_clear_cookie_value())?;
    Ok(response)
}

/// `GET /api/user/self`: return the currently authenticated user's profile.
pub async fn get_self(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };

    let db = env.d1("DB")?;
    let Some(user) = crate::d1_repositories::find_user_by_id(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            401,
            "session user no longer exists",
        ));
    };
    if user.status != USER_STATUS_ENABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    Ok(envelope_ok_response(&SelfResponse::from_row(&user))?)
}

/// Return a single public option string as the envelope `data` (Go's
/// `OptionMap[key]` misc endpoints). Absent option -> empty string.
async fn public_option_string(env: &Env, key: &str) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let value = crate::d1_repositories::get_option(&db, key)
        .await?
        .unwrap_or_default();
    envelope_ok_response(&value)
}

/// `GET /api/notice`: public notice text (Go `GetNotice`).
pub async fn get_notice(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "Notice").await
}

/// `GET /api/about`: public about text (Go `GetAbout`).
pub async fn get_about(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "About").await
}

/// `GET /api/home_page_content`: public home-page content (Go
/// `GetHomePageContent`).
pub async fn get_home_page_content(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "HomePageContent").await
}

/// `GET /api/user-agreement`: legal user-agreement text (Go `GetUserAgreement`;
/// the `legal` config module stores string fields raw under `legal.<field>`).
pub async fn get_user_agreement(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "legal.user_agreement").await
}

/// `GET /api/privacy-policy`: legal privacy-policy text (Go `GetPrivacyPolicy`).
pub async fn get_privacy_policy(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "legal.privacy_policy").await
}

/// `GET /api/midjourney`: public Midjourney display config (Go `GetMidjourney`).
pub async fn get_midjourney(_req: Request, env: Env) -> WorkerResult<Response> {
    public_option_string(&env, "Midjourney").await
}

/// `GET /api/setup`: report whether initial bootstrap is still allowed.
pub async fn get_setup(_req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let root_init = crate::d1_repositories::root_user_exists(&db).await?;
    let completed = crate::d1_repositories::setup_completed(&db).await?;
    let body = build_setup_status(completed, root_init);
    Ok(envelope_ok_response(&body)?)
}

/// `POST /api/setup`: create the initial root user. Refuses once setup is
/// complete or any root user already exists.
pub async fn post_setup(mut req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    if crate::d1_repositories::setup_completed(&db).await? {
        return Ok(envelope_error_response(400, "setup is already completed"));
    }
    if crate::d1_repositories::root_user_exists(&db).await? {
        return Ok(envelope_error_response(400, "root user already exists"));
    }

    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: SetupRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid setup request body: {err}"),
            ));
        }
    };

    let username = payload.username.trim();
    if username.is_empty() || username.chars().count() > SETUP_USERNAME_MAX_LEN {
        return Ok(envelope_error_response(
            400,
            &format!("username must be 1-{} characters", SETUP_USERNAME_MAX_LEN),
        ));
    }
    if payload.password.len() < SETUP_PASSWORD_MIN_LEN {
        return Ok(envelope_error_response(
            400,
            &format!(
                "password must be at least {} characters",
                SETUP_PASSWORD_MIN_LEN
            ),
        ));
    }

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
    let display_name = if payload.display_name.trim().is_empty() {
        SETUP_DEFAULT_DISPLAY_NAME.to_string()
    } else {
        payload.display_name.trim().to_string()
    };
    let _root_id = crate::d1_repositories::create_root_user(
        &db,
        username,
        &password_hash,
        &display_name,
        SETUP_DEFAULT_ROOT_QUOTA,
        now,
    )
    .await?;
    if let Err(err) = crate::d1_repositories::mark_setup_completed(&db, now).await {
        worker::console_warn!("failed to mark setup completed: {}", err);
    }

    Ok(envelope_ok_response(&SetupCompleteResponse {
        username: username.to_string(),
        role: ROLE_ROOT_USER,
    })?)
}

// ---------------------------------------------------------------------------
// Session middleware helpers
// ---------------------------------------------------------------------------

/// Try to extract a valid session from the request. Returns `Ok(None)` when
/// the request has no session cookie; surfaces parse failures as `Err`.
pub async fn parse_session_claims(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<Option<SessionClaims>, Response>> {
    let Some(cookie_value) = session_cookie(req) else {
        return Ok(Ok(None));
    };
    let codec = match session_codec(env)? {
        Ok(codec) => codec,
        Err(response) => return Ok(Err(response)),
    };
    match codec.parse(&cookie_value, unix_timestamp()) {
        Ok(claims) => Ok(Ok(Some(claims))),
        Err(SessionError::Expired | SessionError::InvalidSignature | SessionError::Malformed) => {
            // Treat any invalid cookie as "no session"; the route handler will
            // return 401.
            Ok(Ok(None))
        }
        Err(SessionError::Decode(err)) => Ok(Err(envelope_error_response(
            500,
            &format!("failed to decode session: {err}"),
        ))),
        Err(SessionError::SecretTooShort { min }) => Ok(Err(envelope_error_response(
            500,
            &format!("SESSION_SECRET must be at least {min} bytes"),
        ))),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiveSessionRecheckError {
    Deleted,
    Disabled,
    Revoked,
}

fn refresh_session_claims_from_live_user(
    mut claims: SessionClaims,
    user: &crate::d1_repositories::UserRoleStatus,
) -> std::result::Result<SessionClaims, LiveSessionRecheckError> {
    if user.deleted_at.is_some() {
        return Err(LiveSessionRecheckError::Deleted);
    }
    if user.status != USER_STATUS_ENABLED {
        return Err(LiveSessionRecheckError::Disabled);
    }
    if user.session_epoch > 0 && claims.iat < user.session_epoch {
        return Err(LiveSessionRecheckError::Revoked);
    }
    claims.id = user.id;
    claims.username = user.username.clone();
    claims.role = user.role;
    claims.status = user.status;
    claims.group = user.group.clone();
    Ok(claims)
}

/// Require a logged-in user. On success returns the claims; on failure
/// returns a 401 envelope response ready to send.
pub async fn optional_user_auth(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<Option<SessionClaims>, Response>> {
    match parse_session_claims(req, env).await? {
        Ok(Some(claims)) => {
            let db = env.d1("DB")?;
            let Some(user) = crate::d1_repositories::find_user_role_status(&db, claims.id).await?
            else {
                return Ok(Err(envelope_error_response(
                    401,
                    "session user no longer exists",
                )));
            };
            match refresh_session_claims_from_live_user(claims, &user) {
                Ok(claims) => Ok(Ok(Some(claims))),
                Err(LiveSessionRecheckError::Deleted) => Ok(Err(envelope_error_response(
                    401,
                    "session user no longer exists",
                ))),
                Err(LiveSessionRecheckError::Disabled) => {
                    Ok(Err(envelope_error_response(403, "user is disabled")))
                }
                Err(LiveSessionRecheckError::Revoked) => Ok(Err(session_rejected_response(
                    401,
                    "session has been revoked; sign in again",
                ))),
            }
        }
        Ok(None) => Ok(Ok(None)),
        Err(response) => Ok(Err(response)),
    }
}

fn session_rejected_response(status: u16, message: &str) -> Response {
    let mut response = envelope_error_response(status, message);
    let _ = response
        .headers_mut()
        .append("Set-Cookie", &build_clear_cookie_value());
    response
}

/// Require a logged-in user. On success returns the claims; on failure
/// returns a 401 envelope response ready to send.
pub async fn require_user_auth(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<SessionClaims, Response>> {
    match optional_user_auth(req, env).await? {
        Ok(Some(claims)) => Ok(Ok(claims)),
        Ok(None) => Ok(Err(envelope_error_response(401, "not logged in"))),
        Err(response) => Ok(Err(response)),
    }
}

/// Require a logged-in user whose role is at least `ROLE_ADMIN_USER`.
#[allow(dead_code)] // wired by the next G5 batch (channel/user/log/option CRUD)
pub async fn require_admin_auth(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<SessionClaims, Response>> {
    match require_user_auth(req, env).await? {
        Ok(claims) if is_admin(claims.role) => Ok(Ok(claims)),
        Ok(_) => Ok(Err(envelope_error_response(
            403,
            "admin privileges required",
        ))),
        Err(response) => Ok(Err(response)),
    }
}

/// Require a logged-in user whose role is `ROLE_ROOT_USER`.
#[allow(dead_code)] // wired by the next G5 batch (option CRUD, channel key reveal)
pub async fn require_root_auth(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<SessionClaims, Response>> {
    match require_user_auth(req, env).await? {
        Ok(claims) if is_root(claims.role) => Ok(Ok(claims)),
        Ok(_) => Ok(Err(envelope_error_response(
            403,
            "root privileges required",
        ))),
        Err(response) => Ok(Err(response)),
    }
}

/// Surface (for `/api/status` feature detection) whether session auth is
/// configured, i.e. `SESSION_SECRET` is present and at least
/// [`MIN_SECRET_BYTES`] long.
pub(crate) fn session_auth_configured(env: &Env) -> bool {
    matches!(session_secret(env), Ok(Some(secret)) if secret.len() >= MIN_SECRET_BYTES)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
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

/// Login response when the user has 2FA enabled: no session is issued; the
/// client must call `/api/user/login/2fa` with `pending_token` + a code.
#[derive(Debug, Serialize)]
struct TwoFaRequiredResponse {
    two_fa_required: bool,
    pending_token: String,
}

#[derive(Debug, Serialize)]
struct SelfResponse {
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
    group: String,
    quota: i64,
    used_quota: i64,
    request_count: i64,
    aff_quota: i64,
    aff_history_quota: i64,
    aff_count: i64,
    created_at: i64,
    last_login_at: i64,
}

impl SelfResponse {
    fn from_row(row: &crate::d1_repositories::AdminUserRow) -> Self {
        Self {
            id: row.id,
            username: row.username.clone(),
            display_name: row.display_name.clone(),
            role: row.role,
            status: row.status,
            email: row.email.clone(),
            github_id: row.github_id.clone(),
            discord_id: row.discord_id.clone(),
            oidc_id: row.oidc_id.clone(),
            wechat_id: row.wechat_id.clone(),
            telegram_id: row.telegram_id.clone(),
            linux_do_id: row.linux_do_id.clone(),
            group: row.group.clone(),
            quota: row.quota,
            used_quota: row.used_quota,
            request_count: row.request_count,
            aff_quota: row.aff_quota,
            aff_history_quota: row.aff_history_quota,
            aff_count: row.aff_count,
            created_at: row.created_at,
            last_login_at: row.last_login_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct SetupStatusResponse {
    status: bool,
    root_init: bool,
    database_type: String,
}

fn build_setup_status(completed: bool, root_init: bool) -> SetupStatusResponse {
    SetupStatusResponse {
        status: completed,
        root_init,
        database_type: "d1".to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct SetupRequest {
    username: String,
    password: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Debug, Serialize)]
struct SetupCompleteResponse {
    username: String,
    role: i32,
}

#[derive(Debug, Default)]
struct PublicRuntimeConfig {
    github_client_id: Option<String>,
    github_oauth: bool,
    discord_client_id: Option<String>,
    discord_oauth: bool,
    oidc_client_id: Option<String>,
    oidc_authorization_endpoint: Option<String>,
    oidc_backend_configured: bool,
    turnstile_site_key: Option<String>,
    turnstile_check: bool,
    passkey_ceremony: bool,
}

impl PublicRuntimeConfig {
    fn from_env(env: &Env) -> Self {
        let github_client_id = runtime_value(env, "GITHUB_CLIENT_ID");
        let github_oauth =
            github_client_id.is_some() && runtime_value(env, "GITHUB_CLIENT_SECRET").is_some();

        let discord_client_id = runtime_value(env, "DISCORD_CLIENT_ID");
        let discord_oauth = discord_client_id.is_some()
            && runtime_value(env, "DISCORD_CLIENT_SECRET").is_some()
            && runtime_value(env, "DISCORD_REDIRECT_URI").is_some();

        let oidc_client_id = runtime_value(env, "OIDC_CLIENT_ID");
        let oidc_authorization_endpoint = runtime_value(env, "OIDC_AUTHORIZATION_ENDPOINT");
        let oidc_backend_configured = oidc_client_id.is_some()
            && runtime_value(env, "OIDC_CLIENT_SECRET").is_some()
            && runtime_value(env, "OIDC_TOKEN_URL").is_some()
            && runtime_value(env, "OIDC_USERINFO_URL").is_some()
            && runtime_value(env, "OIDC_REDIRECT_URI").is_some();

        Self {
            github_client_id,
            github_oauth,
            discord_client_id,
            discord_oauth,
            oidc_client_id,
            oidc_authorization_endpoint,
            oidc_backend_configured,
            turnstile_site_key: runtime_value(env, "TURNSTILE_SITE_KEY"),
            turnstile_check: runtime_value(env, "TURNSTILE_SECRET").is_some(),
            passkey_ceremony: crate::passkey_ceremony::binding_available(env)
                && crate::passkey_ceremony::ceremony_contract_compiled()
                && crate::admin_passkey::finish_contract_compiled(),
        }
    }
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| env.var(name).map(|value| value.to_string()).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn set_runtime_feature(
    status: &mut cinatoken_core::StatusResponse,
    name: &'static str,
    enabled: bool,
) {
    if let Some(feature) = status
        .features
        .iter_mut()
        .find(|feature| feature.name == name)
    {
        feature.enabled = enabled;
    }
}

fn option_string(options: &HashMap<String, String>, key: &str, default: &str) -> String {
    options
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn option_bool(options: &HashMap<String, String>, key: &str, default: bool) -> bool {
    options
        .get(key)
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(default)
}

fn option_number(options: &HashMap<String, String>, key: &str, default: f64) -> f64 {
    options
        .get(key)
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn configured_sidebar_bool(
    configured: Option<&Value>,
    section: &str,
    field: &str,
    default: bool,
) -> bool {
    configured
        .and_then(|value| value.get(section))
        .and_then(|value| value.get(field))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn configured_header_bool(
    configured: Option<&Value>,
    field: &str,
    nested_field: Option<&str>,
    default: bool,
) -> bool {
    let value = configured.and_then(|value| value.get(field));
    match nested_field {
        Some("enabled") => match value {
            Some(Value::Object(_)) => {
                json_bool(value.and_then(|value| value.get("enabled")), default)
            }
            Some(_) => json_bool(value, default),
            None => default,
        },
        Some(nested) => json_bool(value.and_then(|value| value.get(nested)), default),
        None => json_bool(value, default),
    }
}

fn json_bool(value: Option<&Value>, default: bool) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => {
            if value.as_i64() == Some(1) || value.as_f64() == Some(1.0) {
                true
            } else if value.as_i64() == Some(0) || value.as_f64() == Some(0.0) {
                false
            } else {
                default
            }
        }
        Some(Value::String(value)) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => default,
        },
        _ => default,
    }
}

fn capability_clamped_header(raw: Option<&str>) -> String {
    let configured = raw
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let configured = configured.as_ref();

    serde_json::json!({
        "home": configured_header_bool(configured, "home", None, true),
        "console": configured_header_bool(configured, "console", None, true),
        "pricing": {
            "enabled": configured_header_bool(configured, "pricing", Some("enabled"), true),
            "requireAuth": configured_header_bool(configured, "pricing", Some("requireAuth"), false)
        },
        "rankings": {
            "enabled": configured_header_bool(configured, "rankings", Some("enabled"), true),
            "requireAuth": configured_header_bool(configured, "rankings", Some("requireAuth"), false)
        },
        "docs": configured_header_bool(configured, "docs", None, true),
        "about": configured_header_bool(configured, "about", None, true)
    })
    .to_string()
}

/// Preserve operator choices for supported modules, but never advertise pages
/// whose backing APIs are not yet available in the Rust deployment.
fn capability_clamped_sidebar(raw: Option<&str>) -> String {
    let configured = raw
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let configured = configured.as_ref();

    serde_json::json!({
        "chat": {
            "enabled": configured_sidebar_bool(configured, "chat", "enabled", true),
            "playground": false,
            "chat": configured_sidebar_bool(configured, "chat", "chat", true)
        },
        "console": {
            "enabled": configured_sidebar_bool(configured, "console", "enabled", true),
            "detail": configured_sidebar_bool(configured, "console", "detail", true),
            "token": configured_sidebar_bool(configured, "console", "token", true),
            "log": configured_sidebar_bool(configured, "console", "log", true),
            "midjourney": false,
            "task": false
        },
        "personal": {
            "enabled": configured_sidebar_bool(configured, "personal", "enabled", true),
            "topup": false,
            "personal": configured_sidebar_bool(configured, "personal", "personal", true)
        },
        "admin": {
            "enabled": configured_sidebar_bool(configured, "admin", "enabled", true),
            "channel": configured_sidebar_bool(configured, "admin", "channel", true),
            "models": configured_sidebar_bool(configured, "admin", "models", true),
            "redemption": configured_sidebar_bool(configured, "admin", "redemption", true),
            "user": configured_sidebar_bool(configured, "admin", "user", true),
            "setting": configured_sidebar_bool(configured, "admin", "setting", true),
            "subscription": false
        }
    })
    .to_string()
}

fn build_frontend_status(
    runtime_status: cinatoken_core::StatusResponse,
    options: &HashMap<String, String>,
    setup_completed: bool,
    runtime: &PublicRuntimeConfig,
    custom_oauth_providers: &[Value],
) -> WorkerResult<Value> {
    let mut data = match serde_json::to_value(runtime_status).map_err(|err| {
        worker::Error::RustError(format!("failed to encode runtime status: {err}"))
    })? {
        Value::Object(data) => data,
        _ => Map::new(),
    };

    let register_enabled = option_bool(options, "RegisterEnabled", true);
    let password_register_enabled = option_bool(options, "PasswordRegisterEnabled", true);
    let sidebar =
        capability_clamped_sidebar(options.get("SidebarModulesAdmin").map(String::as_str));
    let header = capability_clamped_header(options.get("HeaderNavModules").map(String::as_str));
    let turnstile_site_key = runtime
        .turnstile_site_key
        .clone()
        .unwrap_or_else(|| option_string(options, "TurnstileSiteKey", ""));
    let oidc_authorization_endpoint = runtime
        .oidc_authorization_endpoint
        .clone()
        .or_else(|| options.get("oidc.authorization_endpoint").cloned())
        .filter(|value| !value.trim().is_empty());
    let oidc_enabled = runtime.oidc_backend_configured && oidc_authorization_endpoint.is_some();
    let wechat_login = option_bool(options, "WeChatAuthEnabled", false);
    let oauth_register_enabled = register_enabled
        && (runtime.github_oauth
            || runtime.discord_oauth
            || oidc_enabled
            || wechat_login
            || !custom_oauth_providers.is_empty());
    let docs_link = options
        .get("general_setting.docs_link")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| option_string(options, "DocsLink", "https://docs.cinatoken.com"));
    let quota_display_type = options
        .get("general_setting.quota_display_type")
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| matches!(value.as_str(), "USD" | "CNY" | "TOKENS" | "CUSTOM"))
        .unwrap_or_else(|| {
            if option_bool(options, "DisplayInCurrencyEnabled", true) {
                "USD".to_string()
            } else {
                "TOKENS".to_string()
            }
        });
    let custom_currency_symbol =
        option_string(options, "general_setting.custom_currency_symbol", "$");
    let custom_currency_exchange_rate = option_number(
        options,
        "general_setting.custom_currency_exchange_rate",
        1.0,
    );
    let system_name = option_string(options, "SystemName", "CinaToken");
    let passkey_configured = option_bool(options, "passkey.enabled", false);
    let passkey_login = passkey_configured && runtime.passkey_ceremony;

    let compatibility = serde_json::json!({
        "system_name": system_name.clone(),
        "logo": option_string(options, "Logo", "/logo.png"),
        "footer_html": option_string(options, "Footer", ""),
        "docs_link": docs_link,
        "setup": setup_completed,
        "register_enabled": register_enabled,
        "password_login_enabled": option_bool(options, "PasswordLoginEnabled", true),
        "password_register_enabled": password_register_enabled,
        "email_verification": option_bool(options, "EmailVerificationEnabled", false),
        "github_oauth": runtime.github_oauth,
        "github_client_id": runtime.github_client_id,
        "discord_oauth": runtime.discord_oauth,
        "discord_client_id": runtime.discord_client_id,
        "oidc_enabled": oidc_enabled,
        "oidc_client_id": runtime.oidc_client_id,
        "oidc_authorization_endpoint": oidc_authorization_endpoint,
        "linuxdo_oauth": false,
        "telegram_oauth": false,
        "wechat_login": wechat_login,
        "wechat_qrcode": option_string(options, "WeChatAccountQRCodeImageURL", ""),
        "passkey_login": passkey_login,
        "passkey_configured": passkey_configured,
        "passkey_display_name": option_string(options, "passkey.rp_display_name", &system_name),
        "passkey_rp_id": option_string(options, "passkey.rp_id", ""),
        "passkey_origins": option_string(options, "passkey.origins", ""),
        "passkey_allow_insecure": option_bool(options, "passkey.allow_insecure_origin", false),
        "passkey_user_verification": option_string(options, "passkey.user_verification", "preferred"),
        "passkey_attachment": option_string(options, "passkey.attachment_preference", ""),
        "oauth_register_enabled": oauth_register_enabled,
        "custom_oauth_providers": custom_oauth_providers,
        "turnstile_check": runtime.turnstile_check,
        "turnstile_site_key": turnstile_site_key,
        "quota_per_unit": option_number(options, "QuotaPerUnit", 500_000.0),
        "display_in_currency": quota_display_type != "TOKENS",
        "quota_display_type": quota_display_type,
        "usd_exchange_rate": option_number(options, "USDExchangeRate", 7.3),
        "custom_currency_symbol": custom_currency_symbol,
        "custom_currency_exchange_rate": custom_currency_exchange_rate,
        "display_token_stat_enabled": option_bool(options, "DisplayTokenStatEnabled", true),
        "demo_site_enabled": option_bool(options, "DemoSiteEnabled", false),
        "self_use_mode_enabled": option_bool(options, "SelfUseModeEnabled", false),
        "user_agreement_enabled": options.get("legal.user_agreement").is_some_and(|value| !value.trim().is_empty()),
        "privacy_policy_enabled": options.get("legal.privacy_policy").is_some_and(|value| !value.trim().is_empty()),
        "checkin_enabled": option_bool(options, "checkin_setting.enabled", false),
        "enable_drawing": false,
        "enable_task": false,
        "enable_data_export": false,
        "enable_deployments": option_bool(options, "model_deployment.ionet.enabled", false),
        "HeaderNavModules": header,
        "SidebarModulesAdmin": sidebar
    });
    if let Value::Object(compatibility) = compatibility {
        data.extend(compatibility);
    }
    Ok(Value::Object(data))
}

fn session_secret(env: &Env) -> WorkerResult<Option<Vec<u8>>> {
    let Ok(value) = env.var(SESSION_SECRET_ENV) else {
        return Ok(None);
    };
    let value = value.to_string();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(value.into_bytes()))
}

/// Construct a `SessionCodec` from the env. Missing or short secret returns a
/// 500 envelope response instead of a randomly generated fallback (the Go
/// gateway's behavior of defaulting to a per-boot random secret is an
/// anti-pattern that silently invalidates every session on redeploy).
pub(crate) fn session_codec(
    env: &Env,
) -> WorkerResult<std::result::Result<SessionCodec, Response>> {
    let Some(secret) = session_secret(env)? else {
        return Ok(Err(envelope_error_response(
            500,
            "SESSION_SECRET is not configured",
        )));
    };
    match SessionCodec::with_default_ttl(secret) {
        Ok(codec) => Ok(Ok(codec)),
        Err(SessionError::SecretTooShort { min }) => Ok(Err(envelope_error_response(
            500,
            &format!("SESSION_SECRET must be at least {min} bytes"),
        ))),
        Err(err) => Ok(Err(envelope_error_response(
            500,
            &format!("SESSION_SECRET configuration error: {err}"),
        ))),
    }
}

fn session_cookie(req: &Request) -> Option<String> {
    // Cookies arrive in the `Cookie` request header (COOKIE_NAME is the cookie's
    // own name, `session`, matched inside extract_session_cookie — NOT the
    // header name).
    let header = req.headers().get("Cookie").ok().flatten()?;
    extract_session_cookie(&header)
}

fn extract_session_cookie(cookie_header: &str) -> Option<String> {
    // A Cookie header may contain multiple cookies separated by `; `. Find the
    // one named `session`. Format: `name=value; name2=value2`.
    for pair in cookie_header.split(';') {
        let pair = pair.trim();
        if let Some((name, value)) = pair.split_once('=') {
            if name.trim() == COOKIE_NAME {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn attach_session_cookie(
    response: &mut Response,
    cookie_value: &str,
    max_age_seconds: i64,
) -> WorkerResult<()> {
    response.headers_mut().append(
        "Set-Cookie",
        &build_set_cookie_value(cookie_value, max_age_seconds),
    )?;
    Ok(())
}

/// Read a JSON request body. Bounded to [`ADMIN_BODY_LIMIT_BYTES`] — admin
/// JSON bodies are small.
pub(crate) async fn read_json_body(req: &mut Request) -> std::result::Result<Value, Response> {
    let bytes = match req.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return Err(envelope_error_response(
                400,
                &format!("failed to read request body: {err}"),
            ));
        }
    };
    if bytes.len() > ADMIN_BODY_LIMIT_BYTES {
        return Err(envelope_error_response(413, "admin request body too large"));
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Ok(value),
        Err(err) => Err(envelope_error_response(
            400,
            &format!("request body is not valid JSON: {err}"),
        )),
    }
}

pub(crate) fn envelope_ok_response<T: Serialize>(data: &T) -> WorkerResult<Response> {
    let body = ApiEnvelope::ok(data);
    let mut response = Response::from_json(&body)?.with_status(200);
    set_cors_headers(&mut response)?;
    Ok(response)
}

pub(crate) fn envelope_error_response(status: u16, message: &str) -> Response {
    let body = ApiEnvelope {
        success: false,
        message: message.to_string(),
        data: Value::Null,
    };
    let mut response = match Response::from_json(&body) {
        Ok(response) => response.with_status(status),
        Err(err) => {
            worker::console_error!("failed to encode admin error response: {}", err);
            return Response::error("internal server error", 500)
                .unwrap_or_else(|_| Response::empty().expect("fallback response builds"));
        }
    };
    let _ = set_cors_headers(&mut response);
    response
}

pub(crate) fn unix_timestamp() -> i64 {
    // Workers do not expose std::time::SystemTime reliably; use the JS Date
    // via js-sys. This matches how the rest of the worker crate derives time
    // for audit timestamps.
    let now_ms = js_sys::Date::now();
    (now_ms / 1000.0) as i64
}

// Re-exported so the lib.rs router can register the admin routes alongside
// the existing relay routes without duplicating the handler names.
pub use get_self as self_handler;
pub use get_setup as get_setup_handler;
pub use login as login_handler;
pub use logout as logout_handler;
pub use post_setup as post_setup_handler;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_constants_match_go_defaults() {
        // Go controller/setup.go:113-122 constraints.
        assert_eq!(SETUP_USERNAME_MAX_LEN, 12);
        assert_eq!(SETUP_PASSWORD_MIN_LEN, 8);
        assert_eq!(SETUP_DEFAULT_ROOT_QUOTA, 100_000_000);
        assert_eq!(SETUP_DEFAULT_DISPLAY_NAME, "Root User");
    }

    #[test]
    fn public_status_option_whitelist_excludes_secrets() {
        assert!(PUBLIC_STATUS_OPTION_KEYS.contains(&"SystemName"));
        assert!(PUBLIC_STATUS_OPTION_KEYS.contains(&"SidebarModulesAdmin"));
        assert!(PUBLIC_STATUS_OPTION_KEYS.contains(&"checkin_setting.enabled"));
        assert!(PUBLIC_STATUS_OPTION_KEYS.contains(&"checkin_setting.min_quota"));
        assert!(PUBLIC_STATUS_OPTION_KEYS.contains(&"checkin_setting.max_quota"));
        for forbidden in [
            "StripeApiSecret",
            "StripeWebhookSecret",
            "OIDCClientSecret",
            "TurnstileSecretKey",
            "SMTPToken",
            "WorkerValidKey",
        ] {
            assert!(
                !PUBLIC_STATUS_OPTION_KEYS.contains(&forbidden),
                "{forbidden}"
            );
        }
    }

    #[test]
    fn setup_status_true_means_initialization_is_complete() {
        let complete = build_setup_status(true, true);
        assert!(complete.status);
        assert!(complete.root_init);
        assert_eq!(complete.database_type, "d1");

        let pending = build_setup_status(false, false);
        assert!(!pending.status);
        assert!(!pending.root_init);
    }

    #[test]
    fn frontend_status_preserves_runtime_diagnostics_and_go_fields() {
        let mut options = HashMap::new();
        options.insert("SystemName".to_string(), "Production CinaToken".to_string());
        options.insert("RegisterEnabled".to_string(), "false".to_string());
        options.insert("QuotaPerUnit".to_string(), "750000".to_string());
        options.insert(
            "general_setting.docs_link".to_string(),
            "https://docs.example.test".to_string(),
        );
        options.insert(
            "general_setting.quota_display_type".to_string(),
            "CUSTOM".to_string(),
        );
        options.insert(
            "general_setting.custom_currency_symbol".to_string(),
            "C".to_string(),
        );
        options.insert(
            "general_setting.custom_currency_exchange_rate".to_string(),
            "2.5".to_string(),
        );

        let data = build_frontend_status(
            cinatoken_api::status("test"),
            &options,
            true,
            &PublicRuntimeConfig::default(),
            &[],
        )
        .unwrap();

        assert_eq!(data["service"], "cinatoken-rust");
        assert_eq!(data["environment"], "test");
        assert_eq!(data["system_name"], "Production CinaToken");
        assert_eq!(data["register_enabled"], false);
        assert_eq!(data["quota_per_unit"], 750_000.0);
        assert_eq!(data["docs_link"], "https://docs.example.test");
        assert_eq!(data["quota_display_type"], "CUSTOM");
        assert_eq!(data["display_in_currency"], true);
        assert_eq!(data["custom_currency_symbol"], "C");
        assert_eq!(data["custom_currency_exchange_rate"], 2.5);
        assert_eq!(data["setup"], true);
        assert_eq!(data["checkin_enabled"], false);
        assert_eq!(data["enable_deployments"], false);
        assert!(data["features"].is_array());

        options.insert("checkin_setting.enabled".to_string(), "true".to_string());
        let data = build_frontend_status(
            cinatoken_api::status("test"),
            &options,
            true,
            &PublicRuntimeConfig::default(),
            &[],
        )
        .unwrap();
        assert_eq!(data["checkin_enabled"], true);
    }

    #[test]
    fn sidebar_status_never_reenables_unported_modules() {
        let raw = serde_json::json!({
            "chat": {"enabled": true, "playground": true, "chat": false},
            "console": {
                "enabled": true,
                "detail": false,
                "token": true,
                "log": true,
                "midjourney": true,
                "task": true
            },
            "personal": {"enabled": true, "topup": true, "personal": true},
            "admin": {
                "enabled": true,
                "channel": true,
                "models": true,
                "redemption": true,
                "user": true,
                "setting": true,
                "subscription": true
            }
        })
        .to_string();
        let clamped: Value = serde_json::from_str(&capability_clamped_sidebar(Some(&raw))).unwrap();

        assert_eq!(clamped["chat"]["chat"], false);
        assert_eq!(clamped["console"]["detail"], false);
        assert_eq!(clamped["console"]["token"], true);
        assert_eq!(clamped["chat"]["playground"], false);
        assert_eq!(clamped["console"]["midjourney"], false);
        assert_eq!(clamped["console"]["task"], false);
        assert_eq!(clamped["personal"]["topup"], false);
        assert_eq!(clamped["admin"]["redemption"], true);
        assert_eq!(clamped["admin"]["subscription"], false);
    }

    #[test]
    fn header_status_advertises_ported_rankings_from_config() {
        let raw = serde_json::json!({
            "home": false,
            "console": true,
            "pricing": {"enabled": false, "requireAuth": true},
            "rankings": {"enabled": true, "requireAuth": false},
            "docs": true,
            "about": true
        })
        .to_string();
        let clamped: Value = serde_json::from_str(&capability_clamped_header(Some(&raw))).unwrap();

        assert_eq!(clamped["home"], false);
        assert_eq!(clamped["pricing"]["enabled"], false);
        assert_eq!(clamped["pricing"]["requireAuth"], true);
        assert_eq!(clamped["rankings"]["enabled"], true);
        assert_eq!(clamped["rankings"]["requireAuth"], false);
    }

    #[test]
    fn header_status_preserves_legacy_boolean_access_config() {
        let raw = serde_json::json!({
            "pricing": false,
            "rankings": "0"
        })
        .to_string();
        let clamped: Value = serde_json::from_str(&capability_clamped_header(Some(&raw))).unwrap();

        assert_eq!(clamped["pricing"]["enabled"], false);
        assert_eq!(clamped["pricing"]["requireAuth"], false);
        assert_eq!(clamped["rankings"]["enabled"], false);
        assert_eq!(clamped["rankings"]["requireAuth"], false);
    }

    #[test]
    fn oidc_is_advertised_only_with_backend_and_authorization_endpoint() {
        let mut options = HashMap::new();
        options.insert(
            "oidc.authorization_endpoint".to_string(),
            "https://issuer.example/authorize".to_string(),
        );
        let runtime = PublicRuntimeConfig {
            oidc_client_id: Some("client".to_string()),
            oidc_backend_configured: true,
            ..PublicRuntimeConfig::default()
        };
        let data =
            build_frontend_status(cinatoken_api::status("test"), &options, true, &runtime, &[])
                .unwrap();
        assert_eq!(data["oidc_enabled"], true);
        assert_eq!(
            data["oidc_authorization_endpoint"],
            "https://issuer.example/authorize"
        );

        let disabled = build_frontend_status(
            cinatoken_api::status("test"),
            &options,
            true,
            &PublicRuntimeConfig::default(),
            &[],
        )
        .unwrap();
        assert_eq!(disabled["oidc_enabled"], false);
    }

    #[test]
    fn passkey_status_requires_configuration_and_runtime_contract() {
        let mut options = HashMap::new();
        options.insert("SystemName".to_string(), "CinaToken Test".to_string());
        options.insert("passkey.enabled".to_string(), "true".to_string());
        options.insert(
            "passkey.rp_display_name".to_string(),
            "CinaToken Passkey".to_string(),
        );
        options.insert("passkey.rp_id".to_string(), "example.com".to_string());

        let runtime = PublicRuntimeConfig {
            passkey_ceremony: true,
            ..PublicRuntimeConfig::default()
        };
        let data =
            build_frontend_status(cinatoken_api::status("test"), &options, true, &runtime, &[])
                .unwrap();

        assert_eq!(data["passkey_configured"], true);
        assert_eq!(data["passkey_display_name"], "CinaToken Passkey");
        assert_eq!(data["passkey_rp_id"], "example.com");
        assert_eq!(data["passkey_login"], true);

        let unavailable = build_frontend_status(
            cinatoken_api::status("test"),
            &options,
            true,
            &PublicRuntimeConfig::default(),
            &[],
        )
        .unwrap();
        assert_eq!(unavailable["passkey_login"], false);
    }

    #[test]
    fn secure_verification_markers_preserve_method_and_expiry() {
        let marker = SecureVerificationMarker {
            method: SECURE_VERIFICATION_METHOD_PASSKEY.to_string(),
            verified_at: 1_000,
        };
        let encoded = serde_json::to_string(&marker).unwrap();
        assert_eq!(
            decode_secure_verification_marker(&encoded, 1_299),
            Some(marker)
        );
        assert!(decode_secure_verification_marker(&encoded, 1_300).is_none());
        assert!(decode_secure_verification_marker(&encoded, 999).is_none());
    }

    #[test]
    fn legacy_secure_verification_marker_is_generic_only() {
        let marker = decode_secure_verification_marker("1000", 1_001).unwrap();
        assert_eq!(marker.method, "legacy");
        assert_eq!(marker.verified_at, 1_000);
    }

    #[test]
    fn secure_verification_storage_is_bound_to_exact_session() {
        let first = secure_verification_storage_id_for_cookie(42, "session-a");
        let second = secure_verification_storage_id_for_cookie(42, "session-b");
        let other_user = secure_verification_storage_id_for_cookie(43, "session-a");
        assert_ne!(first, second);
        assert_ne!(first, other_user);
        assert!(first.starts_with("42:"));
        assert!(!first.contains("session-a"));
        assert_eq!(first.len(), "42:".len() + 64);
    }

    #[test]
    fn custom_oauth_status_enables_oauth_registration_surface() {
        let options = HashMap::new();
        let providers = vec![serde_json::json!({
            "id": 1,
            "name": "Corp",
            "slug": "corp",
            "icon": "openid",
            "client_id": "client",
            "authorization_endpoint": "https://idp.example/auth",
            "scopes": "openid profile email"
        })];
        let data = build_frontend_status(
            cinatoken_api::status("test"),
            &options,
            true,
            &PublicRuntimeConfig::default(),
            &providers,
        )
        .unwrap();
        assert_eq!(data["oauth_register_enabled"], true);
        assert_eq!(data["custom_oauth_providers"][0]["slug"], "corp");
    }

    #[test]
    fn self_response_excludes_sensitive_columns() {
        let row = crate::d1_repositories::AdminUserRow {
            id: 1,
            username: "root".into(),
            display_name: "Root User".into(),
            role: 100,
            status: 1,
            email: "root@example.test".into(),
            github_id: "octo".into(),
            discord_id: "disc".into(),
            oidc_id: "oidc-sub".into(),
            wechat_id: "wechat".into(),
            telegram_id: "telegram".into(),
            linux_do_id: "linuxdo".into(),
            password: "secret-hash".into(), // must NOT appear in SelfResponse
            quota: 100,
            used_quota: 5,
            request_count: 3,
            group: "default".into(),
            aff_count: 2,
            aff_quota: 50,
            aff_history_quota: 150,
            created_at: 1_700_000_000,
            last_login_at: 1_700_000_100,
        };
        let resp = SelfResponse::from_row(&row);
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(!serialized.contains("password"), "{serialized}");
        assert!(!serialized.contains("secret-hash"), "{serialized}");
        assert!(serialized.contains("\"username\":\"root\""));
        assert!(serialized.contains("\"role\":100"));
        assert!(serialized.contains("\"github_id\":\"octo\""));
    }

    #[test]
    fn session_cookie_extraction_handles_multiple_cookies() {
        assert_eq!(
            extract_session_cookie("session=abc.def; theme=dark"),
            Some("abc.def".to_string())
        );
        assert_eq!(
            extract_session_cookie("theme=dark; session=xyz"),
            Some("xyz".to_string())
        );
        assert_eq!(extract_session_cookie("session=; theme=dark"), None);
        assert_eq!(extract_session_cookie("theme=dark"), None);
        assert_eq!(extract_session_cookie(""), None);
    }

    fn test_session_claims() -> SessionClaims {
        SessionClaims {
            id: 7,
            username: "stale-root".to_string(),
            role: ROLE_ROOT_USER,
            status: USER_STATUS_ENABLED,
            group: "stale-group".to_string(),
            iat: 1_700_000_000,
            exp: 2_000_000_000,
        }
    }

    fn test_user_role_status(
        role: i32,
        status: i32,
        deleted_at: Option<i64>,
    ) -> crate::d1_repositories::UserRoleStatus {
        crate::d1_repositories::UserRoleStatus {
            id: 7,
            username: "live-user".to_string(),
            role,
            status,
            group: "live-group".to_string(),
            session_epoch: 0,
            deleted_at,
        }
    }

    #[test]
    fn live_session_recheck_refreshes_authoritative_user_fields() {
        let claims = test_session_claims();
        let live_user = test_user_role_status(1, USER_STATUS_ENABLED, None);

        let refreshed = refresh_session_claims_from_live_user(claims, &live_user).unwrap();

        assert_eq!(refreshed.id, 7);
        assert_eq!(refreshed.username, "live-user");
        assert_eq!(refreshed.role, 1);
        assert_eq!(refreshed.status, USER_STATUS_ENABLED);
        assert_eq!(refreshed.group, "live-group");
        assert_eq!(refreshed.iat, 1_700_000_000);
        assert_eq!(refreshed.exp, 2_000_000_000);
    }

    #[test]
    fn live_session_recheck_rejects_non_enabled_users() {
        let result = refresh_session_claims_from_live_user(
            test_session_claims(),
            &test_user_role_status(1, 2, None),
        );

        assert_eq!(result.unwrap_err(), LiveSessionRecheckError::Disabled);
    }

    #[test]
    fn live_session_recheck_rejects_soft_deleted_users() {
        let result = refresh_session_claims_from_live_user(
            test_session_claims(),
            &test_user_role_status(ROLE_ROOT_USER, USER_STATUS_ENABLED, Some(1_700_000_000)),
        );

        assert_eq!(result.unwrap_err(), LiveSessionRecheckError::Deleted);
    }

    #[test]
    fn live_session_recheck_rejects_revoked_session_epoch() {
        let mut live_user = test_user_role_status(1, USER_STATUS_ENABLED, None);
        live_user.session_epoch = 1_700_000_001;

        let result = refresh_session_claims_from_live_user(test_session_claims(), &live_user);

        assert_eq!(result.unwrap_err(), LiveSessionRecheckError::Revoked);

        live_user.session_epoch = 1_700_000_000;
        assert!(refresh_session_claims_from_live_user(test_session_claims(), &live_user).is_ok());
    }

    #[test]
    fn setup_request_deserializes_optional_display_name() {
        let req: SetupRequest =
            serde_json::from_str(r#"{"username":"root","password":"password1"}"#).unwrap();
        assert_eq!(req.username, "root");
        assert_eq!(req.display_name, "");

        let req: SetupRequest = serde_json::from_str(
            r#"{"username":"root","password":"password1","display_name":" Boss "}"#,
        )
        .unwrap();
        assert_eq!(req.display_name, " Boss ");
    }

    #[test]
    fn login_request_requires_both_fields() {
        let req: LoginRequest = serde_json::from_str(r#"{"username":"a","password":"b"}"#).unwrap();
        assert_eq!(req.username, "a");
        assert_eq!(req.password, "b");
    }
}
