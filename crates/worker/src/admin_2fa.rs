//! Two-factor authentication (2FA / TOTP) enrollment endpoints (item 4.6).
//!
//! Flow (faithful to Go `controller/twofa.go`):
//!   1. `POST /api/user/2fa/setup`   — provision a CSPRNG TOTP secret (disabled)
//!      and return it + an `otpauth://` URI for the authenticator app.
//!   2. `POST /api/user/2fa/confirm` — verify a TOTP code; on success enable 2FA
//!      and issue single-use backup codes (shown once, stored bcrypt-hashed).
//!   3. `GET  /api/user/2fa/status`  — whether 2FA is enabled.
//!   4. `POST /api/user/2fa/disable` — disable (hard-delete), gated by
//!      secure-verification step-up (item 2.3).
//!
//! The TOTP math + base32 + backup-code helpers live in `cinatoken_auth`; the
//! secret/backup bytes come from the Worker CSPRNG (`getrandom`). Backup codes
//! are bcrypt-hashed via the shared `hash_password` (Go `HashBackupCode`).
//!
//! Not yet wired (follow-ups): failed-attempt lockout (the schema has the
//! columns), and the login 2FA challenge (password -> 2FA via flow-state
//! `TwoFaPending`).

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
/// otpauth issuer label shown in the authenticator app.
const TWO_FA_ISSUER: &str = "Cinatoken";

/// `POST /api/user/2fa/setup`: provision a disabled TOTP secret + otpauth URI.
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
        return Ok(envelope_error_response(500, "failed to generate 2FA secret"));
    };
    d1_repositories::upsert_two_fa_secret(&db, claims.id, &secret, unix_timestamp()).await?;
    let otpauth_url = otpauth_uri(TWO_FA_ISSUER, &claims.username, &secret);
    envelope_ok_response(&SetupResponse { secret, otpauth_url })
}

/// `POST /api/user/2fa/confirm` `{code}`: verify a TOTP code → enable 2FA and
/// issue single-use backup codes (returned once, stored hashed).
pub async fn confirm(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let code = body
        .get("code")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
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
    let Some((plaintext, hashes)) = generate_backup_codes() else {
        return Ok(envelope_error_response(500, "failed to generate backup codes"));
    };
    d1_repositories::replace_backup_codes(&db, claims.id, &hashes, now).await?;
    d1_repositories::enable_two_fa(&db, claims.id, now).await?;
    envelope_ok_response(&ConfirmResponse {
        enabled: true,
        backup_codes: plaintext,
    })
}

/// `GET /api/user/2fa/status`: whether the user has 2FA enabled.
pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let enabled = d1_repositories::find_two_fa_by_user(&db, claims.id)
        .await?
        .map(|row| row.is_enabled != 0)
        .unwrap_or(false);
    envelope_ok_response(&StatusResponse { enabled })
}

/// `POST /api/user/2fa/disable`: disable 2FA (hard-delete), gated by a fresh
/// secure-verification step-up (item 2.3) so a hijacked session can't strip it.
pub async fn disable(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if let Some(response) = require_secure_verification(&env, claims.id).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    d1_repositories::delete_two_fa(&db, claims.id).await?;
    envelope_ok_response(&DisableResponse { disabled: true })
}

/// Generate a single-use, URL-safe pending-login token (CSPRNG). Used as the
/// flow-state key for the two-step login 2FA challenge (the value is the user
/// id), so the client can complete `/api/user/login/2fa` without a session.
pub fn new_pending_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(encode_base32(&bytes))
}

/// Verify a login 2FA `code` for `user_id`: a current TOTP code (±1 skew) OR a
/// single-use backup code (consumed on match). Used by `/api/user/login/2fa`
/// and re-usable for the secure-verification 2fa method.
pub async fn verify_2fa_code(
    db: &D1Database,
    user_id: i64,
    secret: &str,
    code: &str,
    now: i64,
) -> WorkerResult<bool> {
    if validate_totp(secret, code, now.max(0) as u64) {
        return Ok(true);
    }
    // Backup-code fallback: bcrypt-compare against the unused codes, consuming
    // the matching one (single-use).
    if validate_backup_code_format(code) {
        let normalized = normalize_backup_code(code);
        for row in d1_repositories::find_unused_backup_codes(db, user_id).await? {
            if verify_password(&normalized, &row.code_hash).unwrap_or(false) {
                d1_repositories::mark_backup_code_used(db, row.id, now).await?;
                return Ok(true);
            }
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
    let mut plaintext = Vec::with_capacity(BACKUP_CODE_COUNT);
    let mut hashes = Vec::with_capacity(BACKUP_CODE_COUNT);
    for _ in 0..BACKUP_CODE_COUNT {
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
    otpauth_url: String,
}

#[derive(Serialize)]
struct ConfirmResponse {
    enabled: bool,
    backup_codes: Vec<String>,
}

#[derive(Serialize)]
struct StatusResponse {
    enabled: bool,
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
        // One code to keep the test fast (bcrypt is intentionally slow).
        let mut bytes = [0u8; BACKUP_CODE_LENGTH];
        getrandom::getrandom(&mut bytes).unwrap();
        let code = backup_code_from_bytes(&bytes);
        assert!(validate_backup_code_format(&code));
        // The hash verifies the (normalized) code and rejects a wrong one.
        let hash = hash_password(&normalize_backup_code(&code)).unwrap();
        assert!(cinatoken_auth::verify_password(&normalize_backup_code(&code), &hash).unwrap());
        assert!(!cinatoken_auth::verify_password("WRONGCODE", &hash).unwrap());
    }
}
