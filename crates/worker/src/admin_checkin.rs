//! User daily check-in endpoints (Go controller/checkin.go).
//!
//! Cloudflare Workers do not have a deployment-local timezone like a VPS. This
//! port uses an explicit UTC day string for the daily uniqueness key; a future
//! option can add a product timezone without depending on edge colo locality.

use serde::Serialize;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_error_response, envelope_ok_response, require_user_auth};
use crate::d1_repositories::{self, CheckinRecordRow};

const CHECKIN_ENABLED_KEY: &str = "checkin_setting.enabled";
const CHECKIN_MIN_QUOTA_KEY: &str = "checkin_setting.min_quota";
const CHECKIN_MAX_QUOTA_KEY: &str = "checkin_setting.max_quota";
const DEFAULT_MIN_QUOTA: i64 = 1_000;
const DEFAULT_MAX_QUOTA: i64 = 10_000;
const MAX_QUOTA_AWARD: i64 = i32::MAX as i64;

/// `GET /api/user/checkin`: current user's monthly check-in status.
pub async fn status(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let setting = load_checkin_setting(&db).await?;
    if !setting.enabled {
        return Ok(envelope_error_response(200, "check-in is not enabled"));
    }

    let now = unix_timestamp();
    let today = utc_date_from_unix_seconds(now);
    let month = parse_month(&req).unwrap_or_else(|| today[..7].to_string());
    let start_date = format!("{month}-01");
    let end_date = format!("{month}-31");
    let records =
        d1_repositories::list_user_checkins(&db, claims.id, &start_date, &end_date).await?;
    let checked_in_today = d1_repositories::has_user_checkin(&db, claims.id, &today).await?;
    let total_checkins = d1_repositories::count_user_checkins(&db, claims.id).await?;
    let total_quota = d1_repositories::sum_user_checkin_quota(&db, claims.id).await?;

    Ok(envelope_ok_response(&CheckinStatusResponse {
        enabled: setting.enabled,
        min_quota: setting.min_quota,
        max_quota: setting.max_quota,
        stats: CheckinStats {
            checked_in_today,
            total_checkins,
            total_quota,
            checkin_count: records.len() as i64,
            records,
        },
    })?)
}

/// `POST /api/user/checkin`: perform today's check-in.
pub async fn perform(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_user_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    if let Some(response) = crate::turnstile::require_turnstile(&req, &env).await? {
        return Ok(response);
    }

    let db = env.d1("DB")?;
    let setting = load_checkin_setting(&db).await?;
    if !setting.enabled {
        return Ok(envelope_error_response(200, "check-in is not enabled"));
    }

    let now = unix_timestamp();
    let today = utc_date_from_unix_seconds(now);
    if d1_repositories::has_user_checkin(&db, claims.id, &today).await? {
        return Ok(envelope_error_response(200, "already checked in today"));
    }
    let quota_awarded = random_quota(setting.min_quota, setting.max_quota)?;
    let inserted =
        d1_repositories::insert_user_checkin(&db, claims.id, &today, quota_awarded, now).await?;
    if !inserted {
        return Ok(envelope_error_response(200, "already checked in today"));
    }
    match d1_repositories::increase_user_quota(&db, claims.id, quota_awarded).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = d1_repositories::delete_user_checkin(&db, claims.id, &today).await;
            return Ok(envelope_error_response(
                200,
                "check-in failed: failed to update quota",
            ));
        }
        Err(err) => {
            let _ = d1_repositories::delete_user_checkin(&db, claims.id, &today).await;
            return Err(err);
        }
    }
    let _ = d1_repositories::insert_system_log(
        &db,
        claims.id,
        &claims.username,
        &format!("user checked in, awarded quota {quota_awarded}"),
        now,
    )
    .await;

    Ok(envelope_ok_response(&CheckinResponse {
        quota_awarded,
        checkin_date: today,
    })?)
}

#[derive(Debug, Clone, Copy)]
struct CheckinSetting {
    enabled: bool,
    min_quota: i64,
    max_quota: i64,
}

#[derive(Debug, Serialize)]
struct CheckinStatusResponse {
    enabled: bool,
    min_quota: i64,
    max_quota: i64,
    stats: CheckinStats,
}

#[derive(Debug, Serialize)]
struct CheckinStats {
    checked_in_today: bool,
    total_checkins: i64,
    total_quota: i64,
    checkin_count: i64,
    records: Vec<CheckinRecordRow>,
}

#[derive(Debug, Serialize)]
struct CheckinResponse {
    quota_awarded: i64,
    checkin_date: String,
}

async fn load_checkin_setting(db: &worker::D1Database) -> WorkerResult<CheckinSetting> {
    let values = d1_repositories::option_values(
        db,
        &[
            CHECKIN_ENABLED_KEY,
            CHECKIN_MIN_QUOTA_KEY,
            CHECKIN_MAX_QUOTA_KEY,
        ],
    )
    .await?;
    let min_quota = parse_i64(values[1].as_deref(), DEFAULT_MIN_QUOTA).clamp(0, MAX_QUOTA_AWARD);
    let max_quota =
        parse_i64(values[2].as_deref(), DEFAULT_MAX_QUOTA).clamp(min_quota, MAX_QUOTA_AWARD);
    Ok(CheckinSetting {
        enabled: parse_bool(values[0].as_deref(), false),
        min_quota,
        max_quota,
    })
}

fn parse_month(req: &Request) -> Option<String> {
    let url = req.url().ok()?;
    let value = url
        .query_pairs()
        .find(|(key, _)| key == "month")?
        .1
        .trim()
        .to_string();
    if is_valid_month(&value) {
        Some(value)
    } else {
        None
    }
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    value
        .map(|value| {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(default)
}

fn parse_i64(value: Option<&str>, default: i64) -> i64 {
    value
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

fn is_valid_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    matches!(
        &bytes[5..],
        b"01"
            | b"02"
            | b"03"
            | b"04"
            | b"05"
            | b"06"
            | b"07"
            | b"08"
            | b"09"
            | b"10"
            | b"11"
            | b"12"
    )
}

fn random_quota(min_quota: i64, max_quota: i64) -> WorkerResult<i64> {
    if max_quota <= min_quota {
        return Ok(min_quota);
    }
    let span = (max_quota - min_quota + 1) as u64;
    let rejection_threshold = u64::MAX - (u64::MAX % span);
    loop {
        let mut bytes = [0u8; 8];
        getrandom::getrandom(&mut bytes)
            .map_err(|err| worker::Error::RustError(format!("random quota failed: {err}")))?;
        let sample = u64::from_le_bytes(bytes);
        if sample < rejection_threshold {
            return Ok(min_quota + (sample % span) as i64);
        }
    }
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

fn utc_date_from_unix_seconds(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

// Howard Hinnant's civil-from-days algorithm, adjusted to Unix epoch days.
fn civil_from_days(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let d = doy - (153 * mp + 2).div_euclid(5) + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_date_from_unix_seconds_handles_epoch_and_leap_day() {
        assert_eq!(utc_date_from_unix_seconds(0), "1970-01-01");
        assert_eq!(utc_date_from_unix_seconds(1_582_934_400), "2020-02-29");
        assert_eq!(utc_date_from_unix_seconds(1_704_067_199), "2023-12-31");
        assert_eq!(utc_date_from_unix_seconds(1_704_067_200), "2024-01-01");
    }

    #[test]
    fn month_validation_is_strict() {
        assert!(is_valid_month("2026-07"));
        assert!(!is_valid_month("2026-00"));
        assert!(!is_valid_month("2026-13"));
        assert!(!is_valid_month("2026-7"));
        assert!(!is_valid_month("2026/07"));
        assert!(!is_valid_month("2026-七月"));
    }

    #[test]
    fn option_parsers_match_frontend_storage_values() {
        assert!(parse_bool(Some("true"), false));
        assert!(parse_bool(Some("1"), false));
        assert!(!parse_bool(Some("false"), true));
        assert_eq!(parse_i64(Some("2500"), 1), 2500);
        assert_eq!(parse_i64(Some("nope"), 1), 1);
    }

    #[test]
    fn quota_award_bound_matches_d1_integer_binding() {
        assert_eq!(MAX_QUOTA_AWARD, i64::from(i32::MAX));
        assert!(DEFAULT_MAX_QUOTA < MAX_QUOTA_AWARD);
    }
}
