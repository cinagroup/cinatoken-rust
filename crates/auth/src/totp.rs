//! TOTP two-factor auth — Rust counterpart of Go `common/totp.go` (which uses
//! `github.com/pquerna/otp`). Parity-matched parameters: HMAC-**SHA1**, 30-second
//! period, **6** digits, **±1** period of skew on validation, and a **base32**
//! (RFC 4648 alphabet `A-Z2-7`, padding optional, case-insensitive) secret —
//! exactly pquerna/otp's `totp.Validate` defaults.
//!
//! This module is the pure algorithm (RFC 4226 HOTP / RFC 6238 TOTP) plus the
//! backup-code format helpers. Secret generation and backup-code hashing
//! (bcrypt, see [`crate::password`]) and the random-byte source are the caller's
//! job; everything here is deterministic and unit-tested against the RFC 6238
//! Appendix B vectors.

use hmac::{Hmac, Mac};
use sha1::Sha1;

/// TOTP period (Go: `Period: 30`).
const PERIOD_SECONDS: u64 = 30;
/// Code length (Go: `Digits: otp.DigitsSix`).
const DIGITS: u32 = 6;
/// Accepted clock skew in periods (pquerna `totp.Validate` default `Skew: 1`).
const SKEW: i64 = 1;
/// Backup-code length without the separator (Go `BackupCodeLength`).
pub const BACKUP_CODE_LENGTH: usize = 8;
/// Backup-code alphabet (Go `generateRandomBackupCode` charset).
const BACKUP_CODE_CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// Decode an RFC 4648 base32 secret (alphabet `A-Z2-7`, case-insensitive,
/// padding `=` and spaces ignored). Returns `None` on an invalid character —
/// matching pquerna, which uppercases then decodes with `NoPadding`.
pub fn decode_base32(secret: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(secret.len() * 5 / 8 + 1);
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    for ch in secret.chars() {
        if ch == '=' || ch.is_whitespace() {
            continue;
        }
        let value = match ch.to_ascii_uppercase() {
            c @ 'A'..='Z' => (c as u8 - b'A') as u64,
            c @ '2'..='7' => (c as u8 - b'2' + 26) as u64,
            _ => return None,
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// RFC 4226 HOTP: the `DIGITS`-digit value for `counter` under `key`, via
/// HMAC-SHA1 dynamic truncation.
fn hotp(key: &[u8], counter: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC-SHA1 accepts any key length");
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte is the
    // offset of the 4-byte big-endian slice; mask the high bit.
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = ((hash[offset] as u32 & 0x7f) << 24)
        | ((hash[offset + 1] as u32) << 16)
        | ((hash[offset + 2] as u32) << 8)
        | (hash[offset + 3] as u32);
    binary % 10u32.pow(DIGITS)
}

/// Zero-padded `DIGITS`-digit string for a HOTP value.
fn format_code(value: u32) -> String {
    format!("{value:0width$}", width = DIGITS as usize)
}

/// The TOTP code for `secret` (base32) at `unix_seconds`, zero-padded to 6
/// digits. `None` if the secret is not valid base32.
pub fn totp_code_at(secret: &str, unix_seconds: u64) -> Option<String> {
    let key = decode_base32(secret)?;
    Some(format_code(hotp(&key, unix_seconds / PERIOD_SECONDS)))
}

/// Validate a TOTP `code` against `secret` at `unix_seconds`, accepting ±1
/// period of skew (pquerna default). Whitespace is stripped; the code must be
/// exactly 6 digits (Go `ValidateTOTPCode` rejects other lengths). Invalid
/// base32 secret -> `false`.
pub fn validate_totp(secret: &str, code: &str, unix_seconds: u64) -> bool {
    let clean: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() != DIGITS as usize || !clean.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let Some(key) = decode_base32(secret) else {
        return false;
    };
    let base = (unix_seconds / PERIOD_SECONDS) as i64;
    (-SKEW..=SKEW).any(|delta| {
        let counter = (base + delta).max(0) as u64;
        format_code(hotp(&key, counter)) == clean
    })
}

/// Format a backup code from 8 random bytes the Go way: each byte indexes the
/// `A-Z0-9` charset, formatted `XXXX-XXXX`. The caller supplies cryptographic
/// random bytes (`crate::password`/`getrandom` in the Worker).
pub fn backup_code_from_bytes(bytes: &[u8; BACKUP_CODE_LENGTH]) -> String {
    let chars: Vec<char> = bytes
        .iter()
        .map(|b| BACKUP_CODE_CHARSET[(*b as usize) % BACKUP_CODE_CHARSET.len()] as char)
        .collect();
    let code: String = chars.iter().collect();
    format!("{}-{}", &code[..4], &code[4..])
}

/// Whether `code` is a well-formed backup code (Go `ValidateBackupCode`):
/// 8 chars after removing `-`, all `A-Z0-9` (case-insensitive).
pub fn validate_backup_code_format(code: &str) -> bool {
    let clean = code.replace('-', "").to_ascii_uppercase();
    clean.len() == BACKUP_CODE_LENGTH
        && clean
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// Canonical `XXXX-XXXX` form (Go `NormalizeBackupCode`): strip `-`, uppercase,
/// re-insert the separator when it is the expected length; otherwise return the
/// input unchanged.
pub fn normalize_backup_code(code: &str) -> String {
    let clean = code.replace('-', "").to_ascii_uppercase();
    if clean.len() == BACKUP_CODE_LENGTH {
        format!("{}-{}", &clean[..4], &clean[4..])
    } else {
        code.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B test secret "12345678901234567890" (SHA1), base32.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn base32_decodes_rfc_secret() {
        assert_eq!(decode_base32(RFC_SECRET).unwrap(), b"12345678901234567890");
        // Case-insensitive + padding/space tolerant.
        assert_eq!(decode_base32("me======").unwrap(), b"a");
        assert_eq!(decode_base32("M E").unwrap(), decode_base32("ME").unwrap());
        assert!(decode_base32("0189").is_none()); // 0/1/8/9 not in base32
    }

    #[test]
    fn totp_matches_rfc6238_vectors() {
        // RFC 6238 Appendix B (SHA1) truncated to 6 digits.
        let cases = [
            (59u64, "287082"),
            (1111111109, "081804"),
            (1111111111, "050471"),
            (1234567890, "005924"),
            (2000000000, "279037"),
            (20000000000, "353130"),
        ];
        for (t, expected) in cases {
            assert_eq!(totp_code_at(RFC_SECRET, t).as_deref(), Some(expected), "T={t}");
        }
    }

    #[test]
    fn validate_accepts_current_and_skew_window() {
        // The code valid at T=59 is in counter 1 (30..=59).
        let code = totp_code_at(RFC_SECRET, 59).unwrap();
        assert!(validate_totp(RFC_SECRET, &code, 59));
        // ±1 period skew accepted (counter 0 and 2 windows).
        assert!(validate_totp(RFC_SECRET, &code, 29)); // prev period
        assert!(validate_totp(RFC_SECRET, &code, 89)); // next period
        // Two periods away is rejected.
        assert!(!validate_totp(RFC_SECRET, &code, 120));
        // Spaces stripped; wrong length / non-digits rejected.
        assert!(validate_totp(RFC_SECRET, "287 082", 59));
        assert!(!validate_totp(RFC_SECRET, "28708", 59));
        assert!(!validate_totp(RFC_SECRET, "abcdef", 59));
        // Bad secret -> false, never panics.
        assert!(!validate_totp("not!base32", "287082", 59));
    }

    #[test]
    fn backup_code_format_and_normalize() {
        // All-zero bytes -> first charset char 'A'.
        assert_eq!(backup_code_from_bytes(&[0; 8]), "AAAA-AAAA");
        // byte 26 -> '0' (index 26 in A-Z0-9); 35 -> '9'; 36 wraps to 'A'.
        assert_eq!(backup_code_from_bytes(&[26, 35, 36, 0, 0, 0, 0, 0]), "09AA-AAAA");
        assert!(validate_backup_code_format("ABCD-1234"));
        assert!(validate_backup_code_format("abcd1234")); // case-insensitive, sep optional
        assert!(!validate_backup_code_format("ABC-123")); // too short
        assert!(!validate_backup_code_format("ABCD-12!4")); // bad char
        assert_eq!(normalize_backup_code("abcd1234"), "ABCD-1234");
        assert_eq!(normalize_backup_code("AB-CD-12-34"), "ABCD-1234");
        assert_eq!(normalize_backup_code("short"), "short"); // unchanged
    }
}
