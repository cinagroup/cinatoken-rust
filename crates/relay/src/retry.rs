//! Relay retry policy and upstream status-code classification.
//!
//! Mirrors the Go defaults in
//! `setting/operation_setting/status_code_ranges.go`:
//! `AutomaticRetryStatusCodeRanges` retries 1xx/3xx, 401-407, 409-499,
//! 500-503, 505-523, and 525-599, and explicitly never retries 504 and 524
//! (gateway timeouts surface to the caller instead of consuming another
//! upstream slot). `AutomaticDisableStatusCodeRanges` defaults to `{401}`,
//! which is a signal of bad credentials rather than a transient upstream
//! condition.
//!
//! The admin-configurable `AutomaticRetryStatusCodeRanges` /
//! `AutomaticDisableStatusCodeRanges` option maps are not wired through the
//! Worker option store yet. Until the admin option API lands, the Worker uses
//! these compiled defaults and TODO(admin-options): read
//! `retry_setting.*` / `disable_setting.*` options the same way billing
//! options are read today.

/// Default number of additional upstream attempts when the first selected
/// channel returns a retryable failure. `0` preserves the historical
/// single-attempt behavior; the Go default of `RetryTimes` is configurable via
/// the `RELAY_RETRY_TIMES` environment variable.
pub const DEFAULT_RETRY_TIMES: u32 = 0;

/// Status codes that should trigger a retry against the next candidate
/// channel, mirroring the Go `AutomaticRetryStatusCodeRanges` defaults.
///
/// - 1xx and 3xx: unusual for POST relay; treat as retryable.
/// - 401-407 and 409-499: client-style errors that, in this gateway, often
///   indicate the upstream key is bad for this specific channel — the next
///   channel may have a working key.
/// - 500-503: generic upstream server errors.
/// - 505-523 and 525-599: upstream server errors.
/// - 504 and 524 are excluded on purpose: a gateway timeout is unlikely to be
///   solved by another channel within the client's timeout window, and
///   retrying can amplify upstream load.
pub fn is_retryable_status(status: u16) -> bool {
    match status {
        100..=199 | 300..=399 => true,
        401..=407 | 409..=499 => true,
        500..=503 => true,
        505..=523 | 525..=599 => true,
        _ => false,
    }
}

/// Status codes that should trigger an automatic channel disable, mirroring
/// the Go `AutomaticDisableStatusCodeRanges` default of `{401}`. A 401 from a
/// configured upstream is a strong signal that the channel key is no longer
/// valid.
pub fn is_auto_disable_status(status: u16) -> bool {
    matches!(status, 401)
}

/// Result of parsing the `RELAY_RETRY_TIMES` environment variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryConfig {
    pub retry_times: u32,
}

impl RetryConfig {
    /// Maximum number of upstream attempts, including the first one. Always at
    /// least 1 so callers can `take(max_attempts())` over the candidate list.
    pub fn max_attempts(&self) -> usize {
        (self.retry_times as usize).saturating_add(1)
    }
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            retry_times: DEFAULT_RETRY_TIMES,
        }
    }
}

/// Parse the `RELAY_RETRY_TIMES` environment value. Returns the default when
/// the variable is absent; rejects negatives and non-numeric strings.
pub fn parse_retry_times_env(raw: Option<&str>) -> Result<u32, String> {
    let Some(raw) = raw.map(str::trim) else {
        return Ok(DEFAULT_RETRY_TIMES);
    };
    if raw.is_empty() {
        return Ok(DEFAULT_RETRY_TIMES);
    }
    let parsed: i64 = raw
        .parse()
        .map_err(|err| format!("RELAY_RETRY_TIMES must be a non-negative integer: {err}"))?;
    if parsed < 0 {
        return Err(format!(
            "RELAY_RETRY_TIMES must be a non-negative integer: got {parsed}"
        ));
    }
    u32::try_from(parsed).map_err(|_| format!("RELAY_RETRY_TIMES {parsed} exceeds u32 range"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_status_table_matches_go_defaults() {
        // Retryable ranges.
        for status in [
            100, 101, 199, 300, 301, 399, 401, 402, 403, 404, 405, 406, 407, 409, 410, 429, 499,
            500, 501, 502, 503, 505, 510, 523, 525, 530, 599,
        ] {
            assert!(is_retryable_status(status), "{status} should be retryable");
        }
        // Never retry.
        for status in [200, 201, 204, 400, 408, 504, 524] {
            assert!(
                !is_retryable_status(status),
                "{status} should NOT be retryable"
            );
        }
    }

    #[test]
    fn auto_disable_status_defaults_to_unauthorized() {
        assert!(is_auto_disable_status(401));
        assert!(!is_auto_disable_status(403));
        assert!(!is_auto_disable_status(500));
        assert!(!is_auto_disable_status(429));
    }

    #[test]
    fn retry_config_max_attempts_always_includes_first_try() {
        assert_eq!(RetryConfig::default().max_attempts(), 1);
        assert_eq!(RetryConfig { retry_times: 3 }.max_attempts(), 4);
    }

    #[test]
    fn parse_retry_times_env_accepts_absent_empty_and_valid_values() {
        assert_eq!(parse_retry_times_env(None).unwrap(), DEFAULT_RETRY_TIMES);
        assert_eq!(
            parse_retry_times_env(Some("")).unwrap(),
            DEFAULT_RETRY_TIMES
        );
        assert_eq!(
            parse_retry_times_env(Some("   ")).unwrap(),
            DEFAULT_RETRY_TIMES
        );
        assert_eq!(parse_retry_times_env(Some("0")).unwrap(), 0);
        assert_eq!(parse_retry_times_env(Some("5")).unwrap(), 5);
    }

    #[test]
    fn parse_retry_times_env_rejects_invalid_input() {
        assert!(parse_retry_times_env(Some("-1")).is_err());
        assert!(parse_retry_times_env(Some("abc")).is_err());
        assert!(parse_retry_times_env(Some("1.5")).is_err());
    }
}
