//! Trusted-redirect-URL validation — faithful port of Go
//! `common.ValidateRedirectURL` (`url_validator.go`).
//!
//! This is a **separate allowlist** from the SSRF outbound-URL check (see this
//! crate's root). SSRF validates where the *server* fetches; this validates
//! where the *client* is redirected after a payment (success/cancel callback
//! URLs), which must stay inside an operator-configured set of trusted domains
//! to prevent open-redirect / phishing abuse.
//!
//! ## Rules (match Go exactly)
//!
//! 1. The scheme must be `http` or `https`.
//! 2. The host (lowercased) must exactly equal a trusted domain OR be a
//!    subdomain of one (`host == trusted` || `host.ends_with("." + trusted)`).
//!    This is suffix-attack safe: `fakeexample.com` does NOT match
//!    `example.com` (no leading dot).
//!
//! ## Config
//!
//! The trusted list is the `TRUSTED_REDIRECT_DOMAINS` env var in Go
//! (comma-separated, normalized to lowercase). The caller parses the env into a
//! `Vec<&str>` / `Vec<String>` and passes it here. Not yet wired into any Worker
//! route (see `docs/source-ssrf-parity.md` Wiring Gate) — this is the
//! ready-to-wire primitive.

use thiserror::Error;
use url::Url;

/// Why a redirect URL was rejected. The `Display` messages mirror Go's error
/// strings so operator-facing diagnostics stay familiar.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RedirectUrlError {
    /// Scheme was not http/https (also covers the empty-URL / no-scheme case,
    /// matching Go `url.Parse("")` -> empty scheme -> "invalid URL scheme").
    #[error("invalid URL scheme: only http and https are allowed")]
    InvalidScheme,
    /// The URL did not parse (malformed). Go's lenient parser rarely produces
    /// this; the strict Rust `url` crate does for some inputs, so surface it.
    #[error("invalid URL format")]
    InvalidFormat,
    /// The host matched no trusted domain.
    #[error("domain {domain} is not in the trusted domains list")]
    UntrustedDomain { domain: String },
}

/// Validate that `raw_url` is safe to redirect a client to, given the trusted
/// redirect domains (already lowercased by the caller). Returns `Ok(())` when
/// the URL is valid and trusted.
///
/// Mirrors Go `ValidateRedirectURL`. The host comparison uses the parsed
/// hostname (which `url` lowercases), so `EXAMPLE.COM` matches `example.com`.
pub fn validate_redirect_url(
    raw_url: &str,
    trusted_domains: &[&str],
) -> Result<(), RedirectUrlError> {
    // Go's url.Parse("") succeeds with an empty scheme, yielding the
    // "invalid URL scheme" error. The strict Rust parser errors on empty /
    // relative URLs; map that to the same InvalidScheme outcome so behavior and
    // the error message both match Go.
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(RedirectUrlError::InvalidScheme);
    }
    let parsed = Url::parse(trimmed).map_err(|_| RedirectUrlError::InvalidFormat)?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(RedirectUrlError::InvalidScheme);
    }
    // `host_str()` is already lowercased by the url crate. `None` (e.g. a
    // `javascript:`-style scheme already rejected above, or a hostless URL)
    // can never match a trusted domain.
    let domain = parsed.host_str().unwrap_or("").to_lowercase();
    if trusted_domains
        .iter()
        .any(|trusted| domain == **trusted || domain.ends_with(&format!(".{trusted}")))
    {
        Ok(())
    } else {
        Err(RedirectUrlError::UntrustedDomain { domain })
    }
}

#[cfg(test)]
mod tests {
    //! Ports Go's `TestValidateRedirectURL` table verbatim, plus the
    //! suffix-attack and empty-trusted-list cases.
    use super::*;

    fn ok(url: &str, trusted: &[&str]) {
        assert!(
            validate_redirect_url(url, trusted).is_ok(),
            "{url:?} with {trusted:?} should be valid"
        );
    }
    fn err(url: &str, trusted: &[&str], expected: RedirectUrlError) {
        let got = validate_redirect_url(url, trusted);
        assert_eq!(got, Err(expected), "{url:?} with {trusted:?}");
    }

    #[test]
    fn exact_domain_match_https() {
        ok("https://example.com/success", &["example.com"]);
    }

    #[test]
    fn exact_domain_match_http() {
        ok("http://example.com/callback", &["example.com"]);
    }

    #[test]
    fn subdomain_match() {
        ok("https://sub.example.com/success", &["example.com"]);
    }

    #[test]
    fn case_insensitive_domain() {
        // url crate lowercases the host, so EXAMPLE.COM matches example.com.
        ok("https://EXAMPLE.COM/success", &["example.com"]);
    }

    #[test]
    fn untrusted_domain_rejected() {
        err(
            "https://evil.com/phishing",
            &["example.com"],
            RedirectUrlError::UntrustedDomain {
                domain: "evil.com".to_string(),
            },
        );
    }

    #[test]
    fn suffix_attack_rejected() {
        // fakeexample.com must NOT match example.com (no leading dot).
        err(
            "https://fakeexample.com/success",
            &["example.com"],
            RedirectUrlError::UntrustedDomain {
                domain: "fakeexample.com".to_string(),
            },
        );
    }

    #[test]
    fn empty_trusted_domains_list_rejected() {
        err(
            "https://example.com/success",
            &[],
            RedirectUrlError::UntrustedDomain {
                domain: "example.com".to_string(),
            },
        );
    }

    #[test]
    fn javascript_scheme_rejected() {
        err(
            "javascript:alert('xss')",
            &["example.com"],
            RedirectUrlError::InvalidScheme,
        );
    }

    #[test]
    fn data_scheme_rejected() {
        err(
            "data:text/html,<script>alert('xss')</script>",
            &["example.com"],
            RedirectUrlError::InvalidScheme,
        );
    }

    #[test]
    fn empty_url_rejected_as_invalid_scheme() {
        // Go's url.Parse("") yields an empty scheme -> "invalid URL scheme".
        err("", &["example.com"], RedirectUrlError::InvalidScheme);
    }

    #[test]
    fn nested_subdomain_matches() {
        // a.b.example.com is still a subdomain of example.com.
        ok("https://a.b.example.com/path", &["example.com"]);
    }

    #[test]
    fn trusted_substring_not_a_suffix_rejected() {
        // "notexample.com" shares a substring but is not a subdomain.
        err(
            "https://notexample.com/x",
            &["example.com"],
            RedirectUrlError::UntrustedDomain {
                domain: "notexample.com".to_string(),
            },
        );
    }
}
