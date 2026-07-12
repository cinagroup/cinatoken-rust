//! Two-factor authentication (2FA / TOTP) enrollment endpoints (item 4.6).
//!
//! Flow (faithful to Go `controller/twofa.go`):
//!   1. `POST /api/user/2fa/setup` — provision a disabled CSPRNG TOTP secret,
//!      return its `otpauth://` URI and one-time backup codes, and persist the
//!      same backup-code set as bcrypt hashes.
//!   2. `POST /api/user/2fa/enable` (legacy alias: `/confirm`) — verify TOTP and
//!      enable the already-provisioned secret without replacing backup codes.
//!   3. `GET /api/user/2fa/status` — report whether 2FA is enabled.
//!   4. `POST /api/user/2fa/disable` — verify TOTP or a backup code in the
//!      request, then hard-delete 2FA. Bodyless legacy calls retain the
//!      secure-verification step-up behavior.
//!   5. `POST /api/user/2fa/backup_codes` — verify TOTP and replace backup
//!      codes. The legacy `/backup-codes` alias retains its step-up behavior.
//!
//! The TOTP math + base32 + backup-code helpers live in `cinatoken_auth`; the
//! secret/backup bytes come from the Worker CSPRNG (`getrandom`). Backup codes
//! are bcrypt-hashed via the shared `hash_password` (Go `HashBackupCode`).
//!
use serde::Serialize;
use worker::{Env, Request, Response, Result as WorkerResult};

use cinatoken_auth::{
    backup_code_from_bytes, encode_base32, hash_password, normalize_backup_code,
    validate_backup_code_format, validate_totp, verify_password, BACKUP_CODE_LENGTH,
};
use worker::D1Database;

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_secure_verification,
    require_user_auth, unix_timestamp,
};
use crate::d1_repositories;

/// 160-bit TOTP secret (RFC 4226 recommended minimum).
const TOTP_SECRET_BYTES: usize = 20;
const BACKUP_CODE_COUNT: usize = 10;
const TWO_FA_BODY_LIMIT_BYTES: usize = 64 * 1024;
/// otpauth issuer label shown in the authenticator app.
const TWO_FA_ISSUER: &str = "Cinatoken";

/// `POST /api/user/2fa/setup`: provision a disabled TOTP secret, its otpauth
/// URI, and the backup codes that remain valid after confirmation.
pub async fn setup(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    if let Some(existing) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? {
        if existing.is_enabled != 0 {
            return Ok(envelope_error_response(
                409,
                "2FA is already enabled; disable it before re-enrolling",
            ));
        }
    }
    let Some(secret) = generate_totp_secret() else {
        return Ok(envelope_error_response(
            500,
            "failed to generate 2FA secret",
        ));
    };
    let Some((backup_codes, backup_code_hashes)) = generate_backup_codes() else {
        return Ok(envelope_error_response(
            500,
            "failed to generate backup codes",
        ));
    };
    let now = unix_timestamp();
    d1_repositories::upsert_two_fa_secret(&db, claims.id, &secret, now).await?;
    d1_repositories::replace_backup_codes(&db, claims.id, &backup_code_hashes, now).await?;
    let qr_code_data = otpauth_uri(TWO_FA_ISSUER, &claims.username, &secret);
    envelope_ok_response(&SetupResponse {
        secret,
        otpauth_url: qr_code_data.clone(),
        qr_code_data,
        backup_codes,
    })
}

/// `POST /api/user/2fa/enable` `{code}` (legacy alias: `/confirm`): verify TOTP
/// and enable the setup without replacing the backup codes already shown.
pub async fn confirm(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let code = verification_code(&body);
    let db = env.d1("DB")?;
    let Some(existing) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? else {
        return Ok(envelope_error_response(
            400,
            "no pending 2FA setup; call /api/user/2fa/setup first",
        ));
    };
    if existing.is_enabled != 0 {
        return Ok(envelope_error_response(409, "2FA is already enabled"));
    }
    let now = unix_timestamp();
    if !validate_totp(&existing.secret, &code, now.max(0) as u64) {
        return Ok(envelope_error_response(401, "invalid 2FA code"));
    }
    d1_repositories::enable_two_fa(&db, claims.id, now).await?;
    envelope_ok_response(&ConfirmResponse { enabled: true })
}

/// `POST /api/user/2fa/backup-codes`: legacy backup-code regeneration endpoint.
/// It invalidates the old set and requires a fresh secure-verification step-up
/// (item 2.3).
pub async fn regenerate_backup_codes(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let enabled = d1_repositories::find_two_fa_by_user(&db, claims.id)
        .await?
        .map(|row| row.is_enabled != 0)
        .unwrap_or(false);
    if !enabled {
        return Ok(envelope_error_response(400, "2FA is not enabled"));
    }
    replace_backup_codes(&db, claims.id).await
}

/// `POST /api/user/2fa/backup_codes` `{code}`: Go/frontend-compatible backup
/// code regeneration. Unlike the legacy hyphenated endpoint, this route
/// verifies the submitted second factor in the same request.
pub async fn regenerate_backup_codes_with_code(
    mut req: Request,
    env: Env,
) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let code = verification_code(&body);
    let db = env.d1("DB")?;
    let Some(two_fa) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? else {
        return Ok(envelope_error_response(400, "2FA is not enabled"));
    };
    if two_fa.is_enabled == 0 {
        return Ok(envelope_error_response(400, "2FA is not enabled"));
    }
    let now = unix_timestamp();
    match verify_2fa_code_inner(&db, &two_fa, &code, now, CodeVerification::TotpOnly).await? {
        TwoFaVerifyResult::Verified => replace_backup_codes(&db, claims.id).await,
        TwoFaVerifyResult::Invalid => Ok(envelope_error_response(401, "invalid 2FA code")),
        TwoFaVerifyResult::Locked { until } => Ok(envelope_error_response(
            429,
            &format!("too many 2FA attempts; locked until {until}"),
        )),
    }
}

async fn replace_backup_codes(db: &D1Database, user_id: i64) -> WorkerResult<Response> {
    let Some((plaintext, hashes)) = generate_backup_codes() else {
        return Ok(envelope_error_response(
            500,
            "failed to generate backup codes",
        ));
    };
    d1_repositories::replace_backup_codes(db, user_id, &hashes, unix_timestamp()).await?;
    envelope_ok_response(&BackupCodesResponse {
        backup_codes: plaintext,
    })
}

fn verification_code(body: &serde_json::Value) -> String {
    body.get("code")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// `GET /api/user/2fa/status`: whether the user has 2FA enabled.
pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let two_fa = d1_repositories::find_two_fa_by_user(&db, claims.id).await?;
    let enabled = two_fa
        .as_ref()
        .map(|row| row.is_enabled != 0)
        .unwrap_or(false);
    let now = unix_timestamp();
    let locked = two_fa
        .as_ref()
        .and_then(|row| row.locked_until)
        .map(|until| until > now)
        .unwrap_or(false);
    let backup_codes_remaining = if enabled {
        d1_repositories::count_unused_backup_codes(&db, claims.id).await?
    } else {
        0
    };
    envelope_ok_response(&StatusResponse {
        enabled,
        locked,
        backup_codes_remaining,
    })
}

/// `POST /api/user/2fa/disable` `{code}`: verify TOTP or a single-use backup
/// code, then hard-delete 2FA. A bodyless request retains the legacy
/// secure-verification step-up contract.
pub async fn disable(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let body = match read_optional_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    if let Some(body) = body {
        let code = verification_code(&body);
        let Some(two_fa) = d1_repositories::find_two_fa_by_user(&db, claims.id).await? else {
            return Ok(envelope_error_response(400, "2FA is not enabled"));
        };
        if two_fa.is_enabled == 0 {
            return Ok(envelope_error_response(400, "2FA is not enabled"));
        }
        let now = unix_timestamp();
        match verify_2fa_code(&db, &two_fa, &code, now).await? {
            TwoFaVerifyResult::Verified => {}
            TwoFaVerifyResult::Invalid => {
                return Ok(envelope_error_response(401, "invalid 2FA code"));
            }
            TwoFaVerifyResult::Locked { until } => {
                return Ok(envelope_error_response(
                    429,
                    &format!("too many 2FA attempts; locked until {until}"),
                ));
            }
        }
    } else if let Some(response) = require_secure_verification(&req, &env, claims.id).await? {
        return Ok(response);
    }
    d1_repositories::delete_two_fa(&db, claims.id).await?;
    envelope_ok_response(&DisableResponse { disabled: true })
}

async fn read_optional_json_body(
    req: &mut Request,
) -> std::result::Result<Option<serde_json::Value>, Response> {
    let bytes = match req.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return Err(envelope_error_response(
                400,
                &format!("failed to read request body: {err}"),
            ));
        }
    };
    if bytes.len() > TWO_FA_BODY_LIMIT_BYTES {
        return Err(envelope_error_response(413, "2FA request body too large"));
    }
    parse_optional_json_bytes(&bytes).map_err(|err| {
        envelope_error_response(400, &format!("request body is not valid JSON: {err}"))
    })
}

fn parse_optional_json_bytes(bytes: &[u8]) -> serde_json::Result<Option<serde_json::Value>> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        Ok(None)
    } else {
        serde_json::from_slice(bytes).map(Some)
    }
}

/// Generate a single-use, URL-safe pending-login token (CSPRNG). Used as the
/// flow-state key for the two-step login 2FA challenge (the value is the user
/// id), so the client can complete `/api/user/login/2fa` without a session.
pub fn new_pending_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(encode_base32(&bytes))
}

/// Go `common.MaxFailAttempts` — lock 2FA after this many failures.
const TWO_FA_MAX_FAIL_ATTEMPTS: i64 = 5;
/// Go `common.LockoutDuration` — lock window in seconds.
const TWO_FA_LOCKOUT_SECONDS: i64 = 300;

/// Outcome of a login-2FA / step-up verification.
pub enum TwoFaVerifyResult {
    Verified,
    Invalid,
    /// Verification is locked (too many failures) until this unix-seconds time.
    Locked {
        until: i64,
    },
}

#[derive(Clone, Copy)]
enum CodeVerification {
    TotpOnly,
    TotpOrBackupCode,
}

/// Verify a 2FA `code` for an enrolled user: a current TOTP code (±1 skew) OR a
/// single-use backup code (consumed on match), with anti-brute-force lockout
/// (Go `IncrementFailedAttempts`/`ResetFailedAttempts`). Used by
/// `/api/user/login/2fa` and the secure-verification 2fa method. The caller
/// supplies the loaded [`d1_repositories::TwoFaRow`] (for the lock state).
pub async fn verify_2fa_code(
    db: &D1Database,
    two_fa: &d1_repositories::TwoFaRow,
    code: &str,
    now: i64,
) -> WorkerResult<TwoFaVerifyResult> {
    verify_2fa_code_inner(db, two_fa, code, now, CodeVerification::TotpOrBackupCode).await
}

async fn verify_2fa_code_inner(
    db: &D1Database,
    two_fa: &d1_repositories::TwoFaRow,
    code: &str,
    now: i64,
    verification: CodeVerification,
) -> WorkerResult<TwoFaVerifyResult> {
    if let Some(until) = two_fa.locked_until {
        if until > now {
            return Ok(TwoFaVerifyResult::Locked { until });
        }
    }
    let matched = if validate_totp(&two_fa.secret, code, now.max(0) as u64) {
        true
    } else if matches!(verification, CodeVerification::TotpOrBackupCode) {
        backup_code_matches(db, two_fa.user_id, code, now).await?
    } else {
        false
    };
    if matched {
        d1_repositories::reset_two_fa_attempts(db, two_fa.user_id).await?;
        Ok(TwoFaVerifyResult::Verified)
    } else {
        d1_repositories::record_two_fa_failure(
            db,
            two_fa.user_id,
            now,
            TWO_FA_MAX_FAIL_ATTEMPTS,
            TWO_FA_LOCKOUT_SECONDS,
        )
        .await?;
        Ok(TwoFaVerifyResult::Invalid)
    }
}

/// Backup-code fallback: bcrypt-compare `code` against the user's unused codes,
/// consuming the matching one (single-use).
async fn backup_code_matches(
    db: &D1Database,
    user_id: i64,
    code: &str,
    now: i64,
) -> WorkerResult<bool> {
    if !validate_backup_code_format(code) {
        return Ok(false);
    }
    let normalized = normalize_backup_code(code);
    for row in d1_repositories::find_unused_backup_codes(db, user_id).await? {
        if verify_password(&normalized, &row.code_hash).unwrap_or(false) {
            d1_repositories::mark_backup_code_used(db, row.id, now).await?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn generate_totp_secret() -> Option<String> {
    let mut bytes = [0u8; TOTP_SECRET_BYTES];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(encode_base32(&bytes))
}

/// Generate `BACKUP_CODE_COUNT` backup codes, returning `(plaintext, hashes)`.
/// Plaintext is shown to the user once; only the bcrypt hashes are persisted.
fn generate_backup_codes() -> Option<(Vec<String>, Vec<String>)> {
    generate_backup_codes_with_count(BACKUP_CODE_COUNT)
}

fn generate_backup_codes_with_count(count: usize) -> Option<(Vec<String>, Vec<String>)> {
    let mut plaintext = Vec::with_capacity(count);
    let mut hashes = Vec::with_capacity(count);
    for _ in 0..count {
        let mut bytes = [0u8; BACKUP_CODE_LENGTH];
        getrandom::getrandom(&mut bytes).ok()?;
        let code = backup_code_from_bytes(&bytes);
        let hash = hash_password(&normalize_backup_code(&code)).ok()?;
        plaintext.push(code);
        hashes.push(hash);
    }
    Some((plaintext, hashes))
}

/// Build a Google-Authenticator-compatible `otpauth://totp/` key URI.
pub fn otpauth_uri(issuer: &str, account: &str, secret: &str) -> String {
    let label = uri_encode(&format!("{issuer}:{account}"));
    let issuer_enc = uri_encode(issuer);
    format!(
        "otpauth://totp/{label}?secret={secret}&issuer={issuer_enc}&algorithm=SHA1&digits=6&period=30"
    )
}

/// Percent-encode a URI component (space → `%20`, not `+`). The base32 secret
/// needs no encoding (`A-Z2-7`), but the issuer/account label can contain
/// arbitrary characters.
fn uri_encode(value: &str) -> String {
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

#[derive(Serialize)]
struct SetupResponse {
    secret: String,
    qr_code_data: String,
    backup_codes: Vec<String>,
    /// Legacy Rust field retained for clients already using `/2fa/setup`.
    otpauth_url: String,
}

#[derive(Serialize)]
struct ConfirmResponse {
    enabled: bool,
}

#[derive(Serialize)]
struct StatusResponse {
    enabled: bool,
    locked: bool,
    backup_codes_remaining: i64,
}

#[derive(Serialize)]
struct BackupCodesResponse {
    backup_codes: Vec<String>,
}

#[derive(Serialize)]
struct DisableResponse {
    disabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cinatoken_auth::{decode_base32, totp_code_at, validate_backup_code_format};

    #[test]
    fn generated_secret_is_valid_base32_and_totp_usable() {
        let secret = generate_totp_secret().expect("secret");
        // 20 bytes -> 32 base32 chars (unpadded), all in the base32 alphabet.
        assert_eq!(secret.len(), 32);
        let decoded = decode_base32(&secret).expect("decodes");
        assert_eq!(decoded.len(), TOTP_SECRET_BYTES);
        // The secret drives the TOTP function (a code can be derived + validated).
        let code = totp_code_at(&secret, 1_700_000_000).expect("code");
        assert!(validate_totp(&secret, &code, 1_700_000_000));
        // Two secrets differ (CSPRNG).
        assert_ne!(generate_totp_secret(), generate_totp_secret());
    }

    #[test]
    fn pending_token_is_distinct_url_safe_base32() {
        let token = new_pending_token().expect("token");
        assert_eq!(token.len(), 26); // 16 bytes -> 26 unpadded base32 chars
        assert!(decode_base32(&token).is_some());
        assert_ne!(new_pending_token(), new_pending_token());
    }

    #[test]
    fn otpauth_uri_is_well_formed() {
        let uri = otpauth_uri("Cinatoken", "alice@example.com", "JBSWY3DPEHPK3PXP");
        assert!(uri.starts_with("otpauth://totp/Cinatoken%3Aalice%40example.com?"));
        assert!(uri.contains("secret=JBSWY3DPEHPK3PXP"));
        assert!(uri.contains("issuer=Cinatoken"));
        assert!(uri.contains("digits=6"));
        assert!(uri.contains("period=30"));
        assert!(uri.contains("algorithm=SHA1"));
    }

    #[test]
    fn backup_code_generation_is_distinct_and_well_formed() {
        // One code keeps the test fast while exercising the production pairing
        // logic (bcrypt is intentionally slow).
        let (plaintext, hashes) = generate_backup_codes_with_count(1).unwrap();
        assert_eq!(plaintext.len(), 1);
        assert_eq!(hashes.len(), plaintext.len());
        let code = &plaintext[0];
        assert!(validate_backup_code_format(&code));
        assert!(cinatoken_auth::verify_password(&normalize_backup_code(code), &hashes[0]).unwrap());
        assert!(!cinatoken_auth::verify_password("WRONGCODE", &hashes[0]).unwrap());
    }

    #[test]
    fn frontend_verification_code_contract_is_shared_by_enable_and_backup_codes() {
        assert_eq!(
            verification_code(&serde_json::json!({"code": " 123456 "})),
            "123456"
        );
        assert_eq!(verification_code(&serde_json::json!({})), "");
        assert_eq!(verification_code(&serde_json::json!({"code": 123456})), "");
    }

    #[test]
    fn disable_accepts_frontend_json_and_preserves_bodyless_legacy_flow() {
        let body = parse_optional_json_bytes(br#"{"code":"123456"}"#)
            .unwrap()
            .unwrap();
        assert_eq!(verification_code(&body), "123456");
        assert_eq!(parse_optional_json_bytes(b"").unwrap(), None);
        assert_eq!(parse_optional_json_bytes(b" \r\n").unwrap(), None);
        assert!(parse_optional_json_bytes(b"{").is_err());
    }

    #[test]
    fn frontend_2fa_response_contracts_serialize_expected_fields() {
        let qr_code_data = otpauth_uri("Cinatoken", "alice@example.com", "JBSWY3DPEHPK3PXP");
        let setup = serde_json::to_value(SetupResponse {
            secret: "JBSWY3DPEHPK3PXP".to_string(),
            qr_code_data: qr_code_data.clone(),
            backup_codes: vec!["AAAA-BBBB".to_string()],
            otpauth_url: qr_code_data,
        })
        .unwrap();
        assert_eq!(setup["secret"], serde_json::json!("JBSWY3DPEHPK3PXP"));
        assert!(setup["qr_code_data"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/"));
        assert_eq!(setup["qr_code_data"], setup["otpauth_url"]);
        assert!(setup["backup_codes"].is_array());

        let enabled = serde_json::to_value(ConfirmResponse { enabled: true }).unwrap();
        assert_eq!(enabled["enabled"], serde_json::json!(true));
        assert!(enabled.get("backup_codes").is_none());

        let status = serde_json::to_value(StatusResponse {
            enabled: true,
            locked: false,
            backup_codes_remaining: 7,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({
                "enabled": true,
                "locked": false,
                "backup_codes_remaining": 7
            })
        );

        let regenerated = serde_json::to_value(BackupCodesResponse {
            backup_codes: vec!["CCCC-DDDD".to_string()],
        })
        .unwrap();
        assert!(regenerated["backup_codes"].is_array());
    }
}
