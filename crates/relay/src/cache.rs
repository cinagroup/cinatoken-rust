use cinatoken_storage::{AuthenticatedToken, RelayChannel};
use serde::{Deserialize, Serialize};

pub const RELAY_CACHE_SCHEMA_VERSION: u32 = 5;
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayCacheKeys {
    prefix: String,
}

impl RelayCacheKeys {
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    pub fn token_auth(&self, api_key: &str, model: &str, client_ip: Option<&str>) -> String {
        scoped_key(
            &self.prefix,
            &[
                "auth",
                &token_fingerprint(api_key),
                &stable_part(model),
                &stable_part(client_ip.unwrap_or("")),
            ],
        )
    }

    pub fn channel(&self, endpoint_family: &str, group: &str, model: &str) -> String {
        scoped_key(
            &self.prefix,
            &[
                "channel",
                &stable_part(endpoint_family),
                &stable_part(group),
                &stable_part(model),
            ],
        )
    }
}

impl Default for RelayCacheKeys {
    fn default() -> Self {
        Self::new("relay")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct CachedAuthenticatedToken {
    pub schema_version: u32,
    pub value: AuthenticatedToken,
}

impl CachedAuthenticatedToken {
    pub fn new(value: AuthenticatedToken) -> Self {
        Self {
            schema_version: RELAY_CACHE_SCHEMA_VERSION,
            value,
        }
    }

    pub fn into_current(self) -> Option<AuthenticatedToken> {
        (self.schema_version == RELAY_CACHE_SCHEMA_VERSION).then_some(self.value)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct CachedRelayChannel {
    pub schema_version: u32,
    pub value: RelayChannel,
}

impl CachedRelayChannel {
    pub fn new(value: RelayChannel) -> Self {
        Self {
            schema_version: RELAY_CACHE_SCHEMA_VERSION,
            value,
        }
    }

    pub fn into_current(self) -> Option<RelayChannel> {
        (self.schema_version == RELAY_CACHE_SCHEMA_VERSION).then_some(self.value)
    }
}

/// Returns a stable, non-plaintext cache-key fingerprint for API keys.
///
/// This is key hygiene, not a cryptographic verifier.
pub fn token_fingerprint(api_key: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in api_key.trim().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

pub fn scoped_key(prefix: &str, parts: &[&str]) -> String {
    let mut key_parts = Vec::with_capacity(parts.len() + 1);
    let prefix = stable_part(prefix);
    if !prefix.is_empty() {
        key_parts.push(prefix);
    }
    key_parts.extend(parts.iter().map(|part| stable_part(part)));
    key_parts.join(":")
}

fn stable_part(value: &str) -> String {
    value
        .trim()
        .trim_matches(':')
        .to_ascii_lowercase()
        .replace(':', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_fingerprint_hashes_trimmed_secret() {
        let first = token_fingerprint("  ct-secret  ");
        let second = token_fingerprint("ct-secret");

        assert_eq!(first, second);
        assert_eq!(first.len(), 16);
        assert!(!first.contains("ct-secret"));
    }

    #[test]
    fn cache_keys_do_not_expose_plain_api_key() {
        let keys = RelayCacheKeys::new("relay");
        let key = keys.token_auth("ct-secret", "GPT-4O", Some("203.0.113.9"));

        assert!(key.starts_with("relay:auth:"));
        assert!(key.ends_with(":gpt-4o:203.0.113.9"));
        assert!(!key.contains("ct-secret"));
    }

    #[test]
    fn cache_keys_normalize_group_and_model() {
        let keys = RelayCacheKeys::new("relay:");
        assert_eq!(
            keys.channel(" OpenAI:Compatible ", " Default:Tier ", " GPT-4O "),
            "relay:channel:openai_compatible:default_tier:gpt-4o"
        );
    }

    #[test]
    fn cached_token_rejects_future_schema_version() {
        let token = CachedAuthenticatedToken {
            schema_version: RELAY_CACHE_SCHEMA_VERSION + 1,
            value: fake_auth(),
        };

        assert!(token.into_current().is_none());
    }

    #[test]
    fn cached_channel_round_trips_current_schema() {
        let channel = fake_channel();
        let cached = CachedRelayChannel::new(channel.clone());
        let encoded = serde_json::to_string(&cached).unwrap();
        let decoded = serde_json::from_str::<CachedRelayChannel>(&encoded).unwrap();

        assert_eq!(decoded.into_current(), Some(channel));
    }

    #[test]
    fn cached_channel_rejects_previous_schema_without_provider_config() {
        let cached = CachedRelayChannel {
            schema_version: RELAY_CACHE_SCHEMA_VERSION - 1,
            value: fake_channel(),
        };

        assert!(cached.into_current().is_none());
    }

    fn fake_auth() -> AuthenticatedToken {
        AuthenticatedToken {
            token_id: 1,
            user_id: 2,
            token_name: "dev-token".to_string(),
            token_status: 1,
            expired_time: -1,
            remain_quota: 100,
            unlimited_quota: 0,
            model_limits_enabled: 0,
            model_limits: String::new(),
            allow_ips: String::new(),
            token_group: "default".to_string(),
            cross_group_retry: 0,
            accept_unset_ratio_model: 0,
            username: "dev".to_string(),
            user_status: 1,
            user_quota: 100,
            user_group: "default".to_string(),
        }
    }

    fn fake_channel() -> RelayChannel {
        RelayChannel {
            id: 1,
            channel_type: 1,
            key: "sk-test".to_string(),
            name: "dev".to_string(),
            base_url: None,
            models: "gpt-test".to_string(),
            channel_group: "default".to_string(),
            model_mapping: None,
            openai_organization: None,
            other: r#"{"plugin":"web-search"}"#.to_string(),
            other_info: String::new(),
            priority: 0,
            weight: 0,
        }
    }
}
