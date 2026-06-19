use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct UserQuota {
    pub user_id: i64,
    pub quota: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct AuthenticatedToken {
    pub token_id: i64,
    pub user_id: i64,
    pub token_name: String,
    pub token_status: i32,
    pub expired_time: i64,
    pub remain_quota: i64,
    pub unlimited_quota: i32,
    pub model_limits_enabled: i32,
    pub model_limits: String,
    pub allow_ips: String,
    pub token_group: String,
    pub username: String,
    pub user_status: i32,
    pub user_quota: i64,
    pub user_group: String,
}

impl AuthenticatedToken {
    pub fn effective_group(&self) -> &str {
        if self.token_group.trim().is_empty() {
            self.user_group.trim()
        } else {
            self.token_group.trim()
        }
    }

    pub fn has_unlimited_quota(&self) -> bool {
        self.unlimited_quota != 0
    }

    pub fn has_model_limits(&self) -> bool {
        self.model_limits_enabled != 0
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RelayChannel {
    pub id: i64,
    pub channel_type: i32,
    pub key: String,
    pub name: String,
    pub base_url: Option<String>,
    pub models: String,
    pub channel_group: String,
    pub model_mapping: Option<String>,
    pub openai_organization: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelayAuditLog<'a> {
    pub user_id: i64,
    pub username: &'a str,
    pub token_id: i64,
    pub token_name: &'a str,
    pub channel_id: i64,
    pub model: &'a str,
    pub group: &'a str,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub quota: i64,
    pub use_time_seconds: i64,
    pub is_stream: bool,
    pub ip: &'a str,
    pub request_id: &'a str,
    pub upstream_request_id: &'a str,
    pub other: &'a str,
}

#[async_trait(?Send)]
pub trait QuotaRepository {
    async fn get_user_quota(&self, user_id: i64) -> cinatoken_core::ApiResult<UserQuota>;
    async fn apply_user_quota_delta(
        &self,
        user_id: i64,
        delta: i64,
    ) -> cinatoken_core::ApiResult<()>;
}

#[async_trait(?Send)]
pub trait TokenAuthRepository {
    async fn authenticate_token(
        &self,
        api_key: &str,
    ) -> cinatoken_core::ApiResult<Option<AuthenticatedToken>>;
}

#[async_trait(?Send)]
pub trait RelayChannelRepository {
    async fn list_openai_compatible_channels(&self)
        -> cinatoken_core::ApiResult<Vec<RelayChannel>>;
}

#[async_trait(?Send)]
pub trait RelayAuditRepository {
    async fn record_relay_audit(&self, log: RelayAuditLog<'_>) -> cinatoken_core::ApiResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(token_group: &str, user_group: &str) -> AuthenticatedToken {
        AuthenticatedToken {
            token_id: 1,
            user_id: 1,
            token_name: "dev-token".to_string(),
            token_status: 1,
            expired_time: -1,
            remain_quota: 100,
            unlimited_quota: 0,
            model_limits_enabled: 0,
            model_limits: String::new(),
            allow_ips: String::new(),
            token_group: token_group.to_string(),
            username: "dev".to_string(),
            user_status: 1,
            user_quota: 100,
            user_group: user_group.to_string(),
        }
    }

    #[test]
    fn effective_group_prefers_token_group() {
        assert_eq!(token("vip", "default").effective_group(), "vip");
        assert_eq!(token("", "default").effective_group(), "default");
        assert_eq!(token("  ", " default ").effective_group(), "default");
    }

    #[test]
    fn integer_flags_have_boolean_helpers() {
        let mut auth = token("", "default");
        assert!(!auth.has_unlimited_quota());
        assert!(!auth.has_model_limits());
        auth.unlimited_quota = 1;
        auth.model_limits_enabled = 1;
        assert!(auth.has_unlimited_quota());
        assert!(auth.has_model_limits());
    }
}
