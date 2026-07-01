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

use cinatoken_auth::{
    hash_password, is_admin, is_root, verify_password, ROLE_ROOT_USER, USER_STATUS_DISABLED,
};
use cinatoken_core::ApiEnvelope;
use cinatoken_session::{
    build_clear_cookie_value, build_set_cookie_value, SessionClaims, SessionCodec, SessionError,
    COOKIE_NAME, MIN_SECRET_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

use crate::set_cors_headers;

const SESSION_SECRET_ENV: &str = "SESSION_SECRET";
const SETUP_USERNAME_MAX_LEN: usize = 12;
const SETUP_PASSWORD_MIN_LEN: usize = 8;
const SETUP_DEFAULT_ROOT_QUOTA: i64 = 100_000_000;
const SETUP_DEFAULT_DISPLAY_NAME: &str = "Root User";
const ADMIN_BODY_LIMIT_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

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
    if user.status == USER_STATUS_DISABLED {
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
    if user.status == USER_STATUS_DISABLED {
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
    // Step-up method: "2fa" (TOTP or backup code, Go's method) or "password"
    // (the default re-auth). Both, on success, refresh the SecureVerify marker.
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
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }
    let now = unix_timestamp();
    let verified = match method {
        "2fa" => {
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
        _ => {
            let password = body
                .get("password")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if password.is_empty() {
                return Ok(envelope_error_response(400, "password is required"));
            }
            verify_password(password, &user.password).unwrap_or(false)
        }
    };
    if !verified {
        return Ok(envelope_error_response(401, "secure verification failed"));
    }
    crate::flow_state::put(
        &env,
        crate::flow_state::FlowKind::SecureVerify,
        &claims.id.to_string(),
        &now.to_string(),
    )
    .await?;
    let ttl = crate::flow_state::FlowKind::SecureVerify.default_ttl_secs() as i64;
    envelope_ok_response(&serde_json::json!({
        "verified": true,
        "expires_at": now + ttl,
    }))
}

/// Step-up gate (item 2.3): returns `Some(403)` when `user_id` has no fresh
/// secure-verification marker, else `None`. The flow-state entry's 300s TTL IS
/// the freshness window (Go's `SecureVerificationTimeout`), so mere presence
/// means verified; `/api/verify` (re)sets it.
pub async fn require_secure_verification(
    env: &Env,
    user_id: i64,
) -> WorkerResult<Option<Response>> {
    let verified = crate::flow_state::get(
        env,
        crate::flow_state::FlowKind::SecureVerify,
        &user_id.to_string(),
    )
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

/// `POST /api/user/logout`: clear the session cookie.
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
    if user.status == USER_STATUS_DISABLED {
        return Ok(envelope_error_response(403, "user is disabled"));
    }

    Ok(envelope_ok_response(&SelfResponse::from_row(&user))?)
}

/// `GET /api/setup`: report whether initial bootstrap is still allowed.
pub async fn get_setup(_req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let root_init = crate::d1_repositories::root_user_exists(&db).await?;
    let completed = crate::d1_repositories::setup_completed(&db).await?;
    let body = SetupStatusResponse {
        status: !completed,
        root_init,
        database_type: "d1".to_string(),
    };
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

/// Require a logged-in user. On success returns the claims; on failure
/// returns a 401 envelope response ready to send.
pub async fn require_user_auth(
    req: &Request,
    env: &Env,
) -> WorkerResult<std::result::Result<SessionClaims, Response>> {
    match parse_session_claims(req, env).await? {
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
    group: String,
    quota: i64,
    used_quota: i64,
    request_count: i64,
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
            group: row.group.clone(),
            quota: row.quota,
            used_quota: row.used_quota,
            request_count: row.request_count,
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
    fn self_response_excludes_sensitive_columns() {
        let row = crate::d1_repositories::AdminUserRow {
            id: 1,
            username: "root".into(),
            display_name: "Root User".into(),
            role: 100,
            status: 1,
            email: "root@example.test".into(),
            password: "secret-hash".into(), // must NOT appear in SelfResponse
            quota: 100,
            used_quota: 5,
            request_count: 3,
            group: "default".into(),
            created_at: 1_700_000_000,
            last_login_at: 1_700_000_100,
        };
        let resp = SelfResponse::from_row(&row);
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(!serialized.contains("password"), "{serialized}");
        assert!(!serialized.contains("secret-hash"), "{serialized}");
        assert!(serialized.contains("\"username\":\"root\""));
        assert!(serialized.contains("\"role\":100"));
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
