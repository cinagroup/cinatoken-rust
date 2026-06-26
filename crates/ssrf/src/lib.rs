//! SSRF (Server-Side Request Forgery) protection for user-controlled URLs.
//!
//! This crate ports the validation surface of the Go gateway's
//! `common/ssrf_protection.go` so the Rust/Cloudflare port can apply the same
//! safety checks to URLs that originate from request bodies (download, file
//! fetch, webhook delivery, image proxy, custom OAuth provider callback, and
//! similar user-influenced paths).
//!
//! ## Scope
//!
//! This module is intended for **user-controlled URLs only**, not for the
//! admin-configured channel `base_url`. Channel upstream URLs are operator
//! configuration; SSRF protection there would just reject legitimate custom
//! provider deployments.
//!
//! ## Differences from the Go implementation
//!
//! Cloudflare Workers do not expose a synchronous DNS resolver, so this module
//! validates the URL's literal host (domain or IP literal) and does **not**
//! perform DNS resolution + IP-range re-validation. Domain-based SSRF attacks
//! that resolve to private IPs at request time (`rebind.example` → `127.0.0.1`)
//! must be handled by a native server / Workers AI fetch binding escape hatch
//! in a future revision. The plan's `docs/ssrf.md` records this gap so callers
//! know the boundary before they wire user URLs into the hot path.
//!
//! ## Defaults
//!
//! `SsrfPolicy::strict_default()` mirrors the Go `EnableSSRFProtection: true`
//! defaults: HTTP/HTTPS only, ports 80/443, private IPs rejected, no domain
//! allowlist / blocklist.

use std::net::IpAddr;
use std::str::FromStr;

use ipnet::IpNet;
use thiserror::Error;
use url::Url;

/// IPv4 CIDRs that are always treated as private/loopback/metadata when
/// `allow_private_ip` is false. Mirrors Go `privateIPv4Nets` in
/// `common/ssrf_protection.go` exactly (same ranges, same order). See
/// `docs/source-ssrf-parity.md` (CIDR Table Divergences) for the reconciliation
/// log and per-range fixtures.
const PRIVATE_IPV4_NETS: &[&str] = &[
    "0.0.0.0/8",        // "This network" / unspecified
    "10.0.0.0/8",       // private
    "100.64.0.0/10",    // CGNAT
    "127.0.0.0/8",      // loopback
    "169.254.0.0/16",   // link-local
    "172.16.0.0/12",    // private
    "192.0.0.0/24",     // IETF protocol assignments (full /24, matches Go)
    "192.0.2.0/24",     // TEST-NET-1
    "192.168.0.0/16",   // private
    "198.18.0.0/15",    // benchmarking
    "198.51.100.0/24",  // TEST-NET-2
    "203.0.113.0/24",   // TEST-NET-3
    "224.0.0.0/4",      // multicast
    "240.0.0.0/4",      // reserved
    "255.255.255.255/32", // limited broadcast
];

/// IPv6 CIDRs that are always treated as private/loopback when
/// `allow_private_ip` is false. Mirrors Go `privateIPv6Nets` (same ranges, same
/// order) with one documented superset addition: `64:ff9b:1::/48` (RFC 8215
/// local-use NAT64) is blocked here as defense-in-depth even though Go does not
/// list it. See `docs/source-ssrf-parity.md` (CIDR Table Divergences).
const PRIVATE_IPV6_NETS: &[&str] = &[
    "::/128",          // unspecified
    "::1/128",         // loopback
    "::ffff:0:0/96",   // IPv4-mapped
    "64:ff9b::/96",    // well-known NAT64 (can embed private IPv4)
    "64:ff9b:1::/48",  // local-use NAT64 (RFC 8215) — superset over Go, defense-in-depth
    "100::/64",        // discard-only
    "2001::/23",       // IETF protocol assignments (subsumes Teredo + ORCHIDv2)
    "2001:db8::/32",   // documentation
    "fc00::/7",        // unique local address (ULA)
    "fe80::/10",       // link-local
    "ff00::/8",        // multicast
];

/// SSRF validation policy. Built from runtime configuration in the future; for
/// now constructed via [`SsrfPolicy::strict_default`] or
/// [`SsrfPolicy::builder`].
#[derive(Debug, Clone)]
pub struct SsrfPolicy {
    allow_private_ip: bool,
    allowed_ports: Vec<u16>,
    domain_allowlist: Vec<String>,
    domain_blocklist: Vec<String>,
    ip_block_cidrs: Vec<IpNet>,
}

/// Builder for [`SsrfPolicy`].
#[derive(Debug, Default, Clone)]
pub struct SsrfPolicyBuilder {
    allow_private_ip: bool,
    allowed_ports: Vec<u16>,
    domain_allowlist: Vec<String>,
    domain_blocklist: Vec<String>,
    ip_block_cidrs: Vec<String>,
}

impl SsrfPolicyBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// When true, private/loopback/metadata IPs are permitted. Defaults to
    /// `false` (the Go `EnableSSRFProtection: true` behavior).
    pub fn allow_private_ip(mut self, allow: bool) -> Self {
        self.allow_private_ip = allow;
        self
    }

    /// Override the default `[80, 443]` port allowlist. Empty means "any port".
    pub fn allowed_ports(mut self, ports: impl IntoIterator<Item = u16>) -> Self {
        self.allowed_ports = ports.into_iter().collect();
        self
    }

    /// Domain allowlist. When non-empty, only listed domains (exact match,
    /// case-insensitive) are accepted.
    pub fn domain_allowlist(mut self, domains: impl IntoIterator<Item = String>) -> Self {
        self.domain_allowlist = domains.into_iter().map(|d| normalize_domain(&d)).collect();
        self
    }

    /// Domain blocklist. Domains listed here are always rejected.
    pub fn domain_blocklist(mut self, domains: impl IntoIterator<Item = String>) -> Self {
        self.domain_blocklist = domains.into_iter().map(|d| normalize_domain(&d)).collect();
        self
    }

    /// Additional CIDR blocklist applied to IP-literal hosts. Each entry must
    /// be parseable by `ipnet::IpNet::from_str`, otherwise
    /// [`SsrfPolicyBuilder::build`] returns an error.
    pub fn ip_block_cidrs(mut self, cidrs: impl IntoIterator<Item = String>) -> Self {
        self.ip_block_cidrs = cidrs.into_iter().collect();
        self
    }

    /// Finalize the policy. Fails if any configured CIDR is malformed.
    pub fn build(self) -> Result<SsrfPolicy, SsrfError> {
        let mut ip_block_cidrs = Vec::new();
        for raw in &self.ip_block_cidrs {
            let net = IpNet::from_str(raw.trim()).map_err(|err| {
                SsrfError::InvalidPolicy(format!("invalid IP block CIDR {raw:?}: {err}"))
            })?;
            ip_block_cidrs.push(net);
        }
        Ok(SsrfPolicy {
            allow_private_ip: self.allow_private_ip,
            allowed_ports: self.allowed_ports,
            domain_allowlist: self.domain_allowlist,
            domain_blocklist: self.domain_blocklist,
            ip_block_cidrs,
        })
    }
}

impl SsrfPolicy {
    /// Defaults mirroring Go `EnableSSRFProtection: true`: HTTP/HTTPS only,
    /// ports 80/443, private IPs rejected, no domain lists.
    pub fn strict_default() -> Self {
        SsrfPolicyBuilder::new()
            .allowed_ports([80, 443])
            .build()
            .expect("strict_default has no CIDRs to parse")
    }

    /// Validate a URL against the policy. Returns the parsed [`Url`] on
    /// success. See the crate docs for the DNS-resolution limitation.
    pub fn validate_url(&self, raw: &str) -> Result<Url, SsrfError> {
        let url = Url::parse(raw).map_err(|err| SsrfError::InvalidUrl(err.to_string()))?;
        self.validate_url_parts(&url)?;
        Ok(url)
    }

    fn validate_url_parts(&self, url: &Url) -> Result<(), SsrfError> {
        match url.scheme() {
            "http" | "https" => {}
            other => return Err(SsrfError::InvalidScheme(other.to_string())),
        }

        if !self.allowed_ports.is_empty() {
            let port = url.port_or_known_default().unwrap_or(0);
            if port == 0 || !self.allowed_ports.contains(&port) {
                return Err(SsrfError::PortNotAllowed(port));
            }
        }

        let host = url
            .host_str()
            .ok_or_else(|| SsrfError::InvalidUrl("URL is missing a host component".to_string()))?;

        // Domain-level allow/block lists.
        let domain = normalize_domain(host);
        if !self.domain_allowlist.is_empty() && !self.domain_allowlist.contains(&domain) {
            return Err(SsrfError::DomainNotAllowed(domain));
        }
        if self.domain_blocklist.iter().any(|blocked| {
            blocked == &domain || (blocked.starts_with('.') && domain.ends_with(blocked.as_str()))
        }) {
            return Err(SsrfError::DomainBlocked(domain));
        }

        // IP-literal checks. `url.host_str()` returns the bracketed form for
        // IPv6 hosts (e.g. "[::1]"), which `IpAddr::from_str` cannot parse
        // directly. Use the typed `url::Host` to recover the canonical address
        // string instead. For domain hosts we cannot do DNS in a Worker, so
        // only the literal address is inspected here.
        let host_for_parse = match url.host() {
            Some(url::Host::Ipv6(addr)) => addr.to_string(),
            _ => host.to_string(),
        };
        if let Ok(ip) = host_for_parse.parse::<IpAddr>() {
            if !self.allow_private_ip && Self::is_private_ip(ip) {
                return Err(SsrfError::PrivateIp(ip.to_string()));
            }
            if self.ip_block_cidrs.iter().any(|cidr| cidr.contains(&ip)) {
                return Err(SsrfError::IpBlocked(ip.to_string()));
            }
        }

        Ok(())
    }

    /// Return true when `ip` is inside a private/loopback/metadata range.
    /// Mirrors Go `isPrivateIP`, including its belt-and-suspenders std-method
    /// checks (`IsUnspecified`/`IsLoopback`/`IsLinkLocal*`/`IsInterfaceLocalMulticast`)
    /// that run *in addition to* the CIDR tables. These std checks are redundant
    /// with the CIDR tables above (e.g. `ff00::/8` already covers all v6
    /// multicast) but guard against a typo in the tables silently opening a
    /// bypass — the multicast gap this method previously had is exactly that
    /// class of bug.
    pub fn is_private_ip(ip: IpAddr) -> bool {
        if ip.is_unspecified() || ip.is_loopback() {
            return true;
        }
        match ip {
            IpAddr::V4(v4) => {
                // Go: IsLinkLocalUnicast / IsLinkLocalMulticast / broadcast.
                if v4.is_link_local() || v4.is_multicast() || v4.is_broadcast() {
                    return true;
                }
                PRIVATE_IPV4_NETS
                    .iter()
                    .any(|cidr| matches_cidr_v4(v4, cidr))
            }
            IpAddr::V6(v6) => {
                // Go: IsLinkLocalMulticast + IsInterfaceLocalMulticast, both
                // subsets of `is_multicast()` (ff00::/8). Link-local *unicast*
                // (fe80::/10) is covered by the CIDR table.
                if v6.is_multicast() {
                    return true;
                }
                PRIVATE_IPV6_NETS
                    .iter()
                    .any(|cidr| matches_cidr_v6(v6, cidr))
            }
        }
    }
}

fn matches_cidr_v4(ip: std::net::Ipv4Addr, cidr: &str) -> bool {
    IpNet::from_str(cidr)
        .map(|net| net.contains(&IpAddr::V4(ip)))
        .unwrap_or(false)
}

fn matches_cidr_v6(ip: std::net::Ipv6Addr, cidr: &str) -> bool {
    IpNet::from_str(cidr)
        .map(|net| net.contains(&IpAddr::V6(ip)))
        .unwrap_or(false)
}

fn normalize_domain(value: &str) -> String {
    value.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// Validation failure reasons.
#[derive(Debug, Error)]
pub enum SsrfError {
    #[error("URL scheme must be http or https, got {0}")]
    InvalidScheme(String),
    #[error("port {0} is not allowed")]
    PortNotAllowed(u16),
    #[error("private or loopback IP is not allowed: {0}")]
    PrivateIp(String),
    #[error("domain is not in the allowlist: {0}")]
    DomainNotAllowed(String),
    #[error("domain is blocked: {0}")]
    DomainBlocked(String),
    #[error("IP is blocked by policy: {0}")]
    IpBlocked(String),
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("invalid policy configuration: {0}")]
    InvalidPolicy(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strict() -> SsrfPolicy {
        SsrfPolicy::strict_default()
    }

    #[test]
    fn strict_default_allows_public_http_and_https() {
        assert!(strict().validate_url("https://example.com/path").is_ok());
        assert!(strict().validate_url("http://example.com:80/foo").is_ok());
        assert!(strict().validate_url("https://example.com:443/bar").is_ok());
    }

    #[test]
    fn strict_default_rejects_non_http_schemes() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "gopher://example.com/",
            "data:text/plain,hello",
            "javascript:alert(1)",
        ] {
            let err = strict().validate_url(url).unwrap_err();
            assert!(
                matches!(err, SsrfError::InvalidScheme(_)),
                "{url} should be rejected as invalid scheme, got {err:?}"
            );
        }
    }

    #[test]
    fn strict_default_rejects_non_standard_ports() {
        assert!(matches!(
            strict()
                .validate_url("https://example.com:8080/")
                .unwrap_err(),
            SsrfError::PortNotAllowed(8080)
        ));
        assert!(matches!(
            strict()
                .validate_url("https://example.com:8443/")
                .unwrap_err(),
            SsrfError::PortNotAllowed(8443)
        ));
    }

    #[test]
    fn strict_default_rejects_ipv4_private_ranges() {
        for url in [
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://10.255.255.255/",
            "http://169.254.169.254/", // cloud metadata
            "http://169.254.170.2/",   // ECS metadata
            "http://192.168.1.1/",
            "http://172.16.0.1/",
            "http://0.0.0.0/",
            "http://100.64.0.1/", // CGNAT
            "http://192.0.2.1/",  // TEST-NET-1
            "http://224.0.0.1/",  // multicast
        ] {
            let err = strict().validate_url(url).unwrap_err();
            assert!(
                matches!(err, SsrfError::PrivateIp(_)),
                "{url} should be PrivateIp, got {err:?}"
            );
        }
    }

    #[test]
    fn strict_default_rejects_ipv6_private_ranges() {
        for url in [
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[fd00::1]/",
            "http://[2001:db8::1]/",
        ] {
            let err = strict().validate_url(url).unwrap_err();
            assert!(
                matches!(err, SsrfError::PrivateIp(_)),
                "{url} should be PrivateIp, got {err:?}"
            );
        }
    }

    #[test]
    fn strict_default_allows_public_ip_literals() {
        assert!(strict().validate_url("https://1.1.1.1/").is_ok());
        assert!(strict().validate_url("http://8.8.8.8:80/").is_ok());
        assert!(strict()
            .validate_url("https://[2606:4700:4700::1111]/")
            .is_ok());
    }

    #[test]
    fn allow_private_ip_flag_permits_loopback() {
        let policy = SsrfPolicyBuilder::new()
            .allowed_ports([80, 443])
            .allow_private_ip(true)
            .build()
            .unwrap();
        assert!(policy.validate_url("http://127.0.0.1/").is_ok());
        assert!(policy.validate_url("http://10.0.0.1/").is_ok());
    }

    #[test]
    fn domain_allowlist_rejects_unlisted_domains() {
        let policy = SsrfPolicyBuilder::new()
            .allowed_ports([80, 443])
            .domain_allowlist(["example.com".to_string()])
            .build()
            .unwrap();
        assert!(policy.validate_url("https://example.com/").is_ok());
        assert!(matches!(
            policy.validate_url("https://other.example/").unwrap_err(),
            SsrfError::DomainNotAllowed(_)
        ));
    }

    #[test]
    fn domain_blocklist_rejects_listed_domains_and_subdomains() {
        let policy = SsrfPolicyBuilder::new()
            .allowed_ports([80, 443])
            .domain_blocklist(["evil.example".to_string(), ".metadata.example".to_string()])
            .build()
            .unwrap();
        assert!(matches!(
            policy.validate_url("https://evil.example/").unwrap_err(),
            SsrfError::DomainBlocked(_)
        ));
        // Subdomain suffix matching via the leading-dot form.
        assert!(matches!(
            policy
                .validate_url("https://latest.metadata.example/")
                .unwrap_err(),
            SsrfError::DomainBlocked(_)
        ));
        // Sibling domain is unaffected.
        assert!(policy.validate_url("https://safe.example/").is_ok());
    }

    #[test]
    fn ip_blocklist_rejects_listed_cidrs_only() {
        let policy = SsrfPolicyBuilder::new()
            .allowed_ports([80, 443])
            .allow_private_ip(true) // so the loopback check does not trigger first
            .ip_block_cidrs(["203.0.113.0/24".to_string()])
            .build()
            .unwrap();
        assert!(matches!(
            policy.validate_url("http://203.0.113.10/").unwrap_err(),
            SsrfError::IpBlocked(_)
        ));
        assert!(policy.validate_url("http://198.51.100.1/").is_ok());
    }

    #[test]
    fn invalid_cidr_is_reported_at_build_time() {
        let err = SsrfPolicyBuilder::new()
            .ip_block_cidrs(["not-a-cidr".to_string()])
            .build()
            .unwrap_err();
        assert!(matches!(err, SsrfError::InvalidPolicy(_)));
    }

    #[test]
    fn empty_allowed_ports_allows_any_port() {
        let policy = SsrfPolicyBuilder::new().build().unwrap();
        assert!(policy.validate_url("https://example.com:8443/").is_ok());
    }

    #[test]
    fn malformed_urls_are_reported_as_invalid() {
        let err = strict().validate_url("https://").unwrap_err();
        assert!(matches!(err, SsrfError::InvalidUrl(_)));
    }

    #[test]
    fn private_ip_helper_matches_go_table() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "192.168.0.1",
            "172.16.5.5",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fc00::1",
        ] {
            assert!(
                SsrfPolicy::is_private_ip(ip.parse().unwrap()),
                "{ip} should be private"
            );
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                !SsrfPolicy::is_private_ip(ip.parse().unwrap()),
                "{ip} should be public"
            );
        }
    }

    /// Go<->Rust fixtures for the CIDR ranges reconciled on 2026-06-25. Each
    /// address was a divergence (Rust allowed it while Go blocked it, or vice
    /// versa); see `docs/source-ssrf-parity.md`.
    #[test]
    fn reconciled_ranges_match_go() {
        let blocked = [
            // 192.0.0.0/24 widened from /29 + 192.0.0.170/31: these were ALLOWED
            // before the fix.
            "192.0.0.8",
            "192.0.0.100",
            "192.0.0.255",
            // Well-known NAT64 64:ff9b::/96 — was MISSING; can embed private v4
            // (64:ff9b::192.0.2.33).
            "64:ff9b::1",
            "64:ff9b::c000:221",
            // Local-use NAT64 64:ff9b:1::/48 (intentional superset over Go).
            "64:ff9b:1::1",
            // 2001::/23 widened: Teredo (2001::/32) + ORCHIDv2 (2001:20::/28)
            // plus the rest of the /23.
            "2001::1",
            "2001:20::1",
            "2001:1ff:ffff::1",
            // IPv6 multicast ff00::/8 — was NOT blocked before the fix (the real
            // bypass): link-local, interface-local, and site-local multicast.
            "ff02::1",
            "ff01::1",
            "ff05::1",
        ];
        for ip in blocked {
            assert!(
                SsrfPolicy::is_private_ip(ip.parse().unwrap()),
                "{ip} should be blocked (reconciled to match Go)"
            );
        }

        // Just outside the widened ranges must stay public (no over-blocking).
        let allowed = [
            "192.0.1.1",       // immediately above 192.0.0.0/24
            "2001:200::1",     // immediately above 2001::/23
        ];
        for ip in allowed {
            assert!(
                !SsrfPolicy::is_private_ip(ip.parse().unwrap()),
                "{ip} should remain public (not over-blocked)"
            );
        }
    }
}
