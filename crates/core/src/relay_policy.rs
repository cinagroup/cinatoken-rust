//! Relay retry and channel-disable decision policies — pure ports of Go
//! `controller.shouldRetry` (`controller/relay.go:324`) and
//! `service.ShouldDisableChannel` (`service/channel.go:45`).
//!
//! Both are parameterized: the caller supplies the error-taxonomy booleans
//! (`is_channel_error`, `is_skip_retry`, ...), the configurable status-code
//! predicates, and the keyword list (all of which come from runtime config /
//! error types). This keeps the ordered decision logic pure and testable.
//!
//! Note on `should_disable_channel`: this is the **Go-matching** immediate
//! disable-on-classification policy. The Rust Worker currently uses a
//! failure-threshold/window model instead (a deliberate divergence, see
//! `docs/source-retry-autoban-parity.md`). This function is available if the
//! decision is to match Go; it does not force that choice.

/// Go `shouldRetry` ordered decision. `retry_remaining` is
/// `RetryTimes - currentRetry` (the caller's budget). The two caller-handled
/// short-circuits (nil error, channel-affinity-failure skip) are omitted; call
/// this only when there is an error to classify.
#[allow(clippy::too_many_arguments)]
pub fn should_retry(
    is_channel_error: bool,
    is_skip_retry: bool,
    is_always_skip_retry_code: bool,
    has_specific_channel: bool,
    status_code: u16,
    retry_remaining: i32,
    retry_by_status: impl Fn(u16) -> bool,
) -> bool {
    if is_channel_error {
        return true;
    }
    if is_skip_retry {
        return false;
    }
    if retry_remaining <= 0 {
        return false;
    }
    if has_specific_channel {
        return false;
    }
    if (200..300).contains(&status_code) {
        return false;
    }
    if !(100..=599).contains(&status_code) {
        // Non-HTTP status (network/timeout) — retry.
        return true;
    }
    if is_always_skip_retry_code {
        return false;
    }
    retry_by_status(status_code)
}

/// Go `ShouldDisableChannel` ordered decision (immediate disable-on-
/// classification). The `AutomaticDisableChannelEnabled` gate and the nil-error
/// check are the caller's responsibility. `auto_disable_keywords` are matched
/// case-insensitively as substrings of the error message (Go uses an
/// Aho-Corasick search over the lowercased message).
pub fn should_disable_channel(
    is_channel_error: bool,
    is_skip_retry: bool,
    status_code: u16,
    error_message: &str,
    disable_by_status: impl Fn(u16) -> bool,
    auto_disable_keywords: &[&str],
) -> bool {
    if is_channel_error {
        return true;
    }
    if is_skip_retry {
        return false;
    }
    if disable_by_status(status_code) {
        return true;
    }
    let lower = error_message.to_lowercase();
    auto_disable_keywords
        .iter()
        .any(|kw| lower.contains(&kw.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A representative configurable retry policy: retry 429 and 5xx.
    fn retry_5xx_429(code: u16) -> bool {
        code == 429 || (500..600).contains(&code)
    }
    fn disable_401_403(code: u16) -> bool {
        code == 401 || code == 403
    }

    #[test]
    fn channel_error_always_retries() {
        assert!(should_retry(
            true,
            false,
            false,
            false,
            400,
            0,
            retry_5xx_429
        ));
    }

    #[test]
    fn skip_retry_and_budget_and_specific_channel() {
        assert!(!should_retry(
            false,
            true,
            false,
            false,
            500,
            3,
            retry_5xx_429
        )); // skip-retry
        assert!(!should_retry(
            false,
            false,
            false,
            false,
            500,
            0,
            retry_5xx_429
        )); // no budget
        assert!(!should_retry(
            false,
            false,
            false,
            true,
            500,
            3,
            retry_5xx_429
        )); // pinned channel
    }

    #[test]
    fn status_code_rules() {
        assert!(!should_retry(
            false,
            false,
            false,
            false,
            200,
            3,
            retry_5xx_429
        )); // 2xx
        assert!(should_retry(
            false,
            false,
            false,
            false,
            0,
            3,
            retry_5xx_429
        )); // non-HTTP -> retry
        assert!(should_retry(
            false,
            false,
            false,
            false,
            503,
            3,
            retry_5xx_429
        )); // 5xx
        assert!(!should_retry(
            false,
            false,
            false,
            false,
            400,
            3,
            retry_5xx_429
        )); // 400 not retryable
        assert!(!should_retry(
            false,
            false,
            true,
            false,
            503,
            3,
            retry_5xx_429
        )); // always-skip code
    }

    #[test]
    fn disable_on_channel_error_and_status() {
        assert!(should_disable_channel(
            true,
            false,
            200,
            "",
            disable_401_403,
            &[]
        ));
        assert!(should_disable_channel(
            false,
            false,
            401,
            "bad key",
            disable_401_403,
            &[]
        ));
        assert!(!should_disable_channel(
            false,
            true,
            401,
            "",
            disable_401_403,
            &[]
        )); // skip-retry wins
    }

    #[test]
    fn disable_on_keyword_case_insensitive() {
        let kw = ["insufficient_quota", "invalid api key"];
        assert!(should_disable_channel(
            false,
            false,
            400,
            "Error: Insufficient_Quota exceeded",
            disable_401_403,
            &kw
        ));
        assert!(should_disable_channel(
            false,
            false,
            400,
            "INVALID API KEY",
            disable_401_403,
            &kw
        ));
        assert!(!should_disable_channel(
            false,
            false,
            400,
            "rate limited, try later",
            disable_401_403,
            &kw
        ));
    }
}
