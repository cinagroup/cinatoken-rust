use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    #[serde(default)]
    pub cross_group_retry: i32,
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

    pub fn cross_group_retry_enabled(&self) -> bool {
        self.effective_group() == "auto" && self.cross_group_retry != 0
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
    /// Provider-specific server-owned channel configuration. Ali uses this as
    /// the optional `X-DashScope-Plugin` value; it is never client supplied.
    #[serde(default)]
    pub other: String,
    #[serde(default)]
    pub other_info: String,
    /// Selection priority tier (higher = preferred). Maps to `abilities.priority`
    /// for ability-matched channels, `channels.priority` for CSV-matched ones.
    #[serde(default)]
    pub priority: i64,
    /// Weighted-random weight within a priority tier. 0 is treated as uniform.
    #[serde(default)]
    pub weight: i32,
}

impl RelayChannel {
    pub fn ai_gateway_opted_in(&self) -> bool {
        channel_ai_gateway_opted_in(&self.other_info)
    }

    pub fn wfp_worker(&self) -> Option<String> {
        channel_wfp_worker(&self.other_info)
    }
}

pub fn channel_wfp_worker(other_info: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(other_info.trim()).ok()?;
    value
        .get("wfp_worker")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn channel_ai_gateway_opted_in(other_info: &str) -> bool {
    let other_info = other_info.trim();
    if other_info.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(other_info) else {
        return false;
    };
    ai_gateway_opt_in_value(&value).unwrap_or(false)
}

fn ai_gateway_opt_in_value(value: &Value) -> Option<bool> {
    if let Some(enabled) = value
        .get("ai_gateway")
        .and_then(ai_gateway_opt_in_nested_value)
    {
        return Some(enabled);
    }
    if let Some(enabled) = value
        .get("relay_ai_gateway")
        .and_then(ai_gateway_opt_in_nested_value)
    {
        return Some(enabled);
    }
    value
        .get("relay_ai_gateway_enabled")
        .and_then(ai_gateway_bool_value)
}

fn ai_gateway_opt_in_nested_value(value: &Value) -> Option<bool> {
    ai_gateway_bool_value(value).or_else(|| value.get("enabled").and_then(ai_gateway_bool_value))
}

fn ai_gateway_bool_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().map(|number| number != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" | "enabled" => Some(true),
            "false" | "0" | "no" | "off" | "disabled" => Some(false),
            _ => None,
        },
        _ => None,
    }
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

/// Owned, serializable audit log event for the LOG_QUEUE. Produced by the
/// relay path (via `Queue::send`) and consumed by the queue handler (via
/// `MessageBatch<AuditLogEvent>`) which bulk-INSERTs into D1. Covers every
/// column of the `logs` table that a relay audit row touches.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditLogEvent {
    pub user_id: i64,
    pub created_at: i64,
    pub log_type: i32,
    pub content: String,
    pub username: String,
    pub token_name: String,
    pub model_name: String,
    pub quota: i64,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub use_time: i64,
    pub is_stream: i32,
    pub channel_id: i64,
    pub token_id: i64,
    pub group: String,
    pub ip: String,
    pub request_id: String,
    pub upstream_request_id: String,
    pub other: String,
}

impl AuditLogEvent {
    /// Build an event from the relay audit context. `log_type` is 2
    /// (consume) for successful relays; the caller can override for error
    /// logs.
    pub fn from_relay_audit(
        created_at: i64,
        content: &str,
        audit: &RelayAuditLog<'_>,
        log_type: i32,
    ) -> Self {
        Self {
            user_id: audit.user_id,
            created_at,
            log_type,
            content: content.to_string(),
            username: audit.username.to_string(),
            token_name: audit.token_name.to_string(),
            model_name: audit.model.to_string(),
            quota: audit.quota,
            prompt_tokens: audit.prompt_tokens,
            completion_tokens: audit.completion_tokens,
            use_time: audit.use_time_seconds,
            is_stream: i32::from(audit.is_stream),
            channel_id: audit.channel_id,
            token_id: audit.token_id,
            group: audit.group.to_string(),
            ip: audit.ip.to_string(),
            request_id: audit.request_id.to_string(),
            upstream_request_id: audit.upstream_request_id.to_string(),
            other: audit.other.to_string(),
        }
    }

    pub fn is_terminal_relay_attempt_audit(&self) -> bool {
        self.log_type == 5
            && self
                .other
                .contains(r#""error_code":"relay_attempts_exhausted""#)
    }

    pub fn terminal_relay_attempt_audit_id(&self) -> Option<String> {
        if !self.is_terminal_relay_attempt_audit() {
            return None;
        }
        serde_json::from_str::<Value>(&self.other)
            .ok()?
            .get("terminal_audit_event_id")?
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }
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
            cross_group_retry: 0,
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

    #[test]
    fn cross_group_retry_applies_only_to_auto_tokens() {
        let mut auth = token("auto", "default");
        assert!(!auth.cross_group_retry_enabled());
        auth.cross_group_retry = 1;
        assert!(auth.cross_group_retry_enabled());

        auth.token_group = "vip".to_string();
        assert!(!auth.cross_group_retry_enabled());
    }

    #[test]
    fn relay_channel_ai_gateway_opt_in_reads_compatible_other_info_shapes() {
        for other_info in [
            r#"{"ai_gateway":{"enabled":true}}"#,
            r#"{"ai_gateway":true}"#,
            r#"{"relay_ai_gateway":true}"#,
            r#"{"relay_ai_gateway_enabled":"yes"}"#,
            r#"{"ai_gateway":{"enabled":1}}"#,
        ] {
            assert!(channel_ai_gateway_opted_in(other_info), "{other_info}");
        }

        for other_info in [
            "",
            "{}",
            "not-json",
            r#"{"ai_gateway":{"enabled":false}}"#,
            r#"{"relay_ai_gateway":"off"}"#,
            r#"{"relay_ai_gateway_enabled":0}"#,
        ] {
            assert!(!channel_ai_gateway_opted_in(other_info), "{other_info}");
        }
    }

    #[test]
    fn relay_channel_wfp_worker_requires_an_explicit_nonempty_string() {
        assert_eq!(
            channel_wfp_worker(r#"{"wfp_worker":" tenant-a "}"#).as_deref(),
            Some("tenant-a")
        );
        for other_info in [
            "",
            "{}",
            "not-json",
            r#"{"wfp_worker":""}"#,
            r#"{"wfp_worker":true}"#,
        ] {
            assert_eq!(channel_wfp_worker(other_info), None, "{other_info}");
        }
    }

    #[test]
    fn relay_channel_deserializes_old_cache_without_other_info() {
        let channel: RelayChannel = serde_json::from_value(serde_json::json!({
            "id": 1,
            "channel_type": 1,
            "key": "sk-test",
            "name": "openai",
            "base_url": null,
            "models": "gpt-test",
            "channel_group": "default",
            "model_mapping": null,
            "openai_organization": null,
            "priority": 0,
            "weight": 0
        }))
        .unwrap();

        assert_eq!(channel.other_info, "");
        assert!(!channel.ai_gateway_opted_in());
    }

    #[test]
    fn terminal_relay_attempt_event_is_identified_without_matching_other_errors() {
        let mut event = AuditLogEvent {
            user_id: 1,
            created_at: 1,
            log_type: 5,
            content: "terminal".to_string(),
            username: "user".to_string(),
            token_name: "token".to_string(),
            model_name: "model".to_string(),
            quota: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            use_time: 0,
            is_stream: 0,
            channel_id: 1,
            token_id: 1,
            group: "default".to_string(),
            ip: String::new(),
            request_id: "request".to_string(),
            upstream_request_id: String::new(),
            other:
                r#"{"error_code":"relay_attempts_exhausted","terminal_audit_event_id":"audit-1"}"#
                    .to_string(),
        };
        assert!(event.is_terminal_relay_attempt_audit());
        assert_eq!(
            event.terminal_relay_attempt_audit_id().as_deref(),
            Some("audit-1")
        );

        event.log_type = 2;
        assert!(!event.is_terminal_relay_attempt_audit());
        event.log_type = 5;
        event.other = r#"{"error_code":"another_error"}"#.to_string();
        assert!(!event.is_terminal_relay_attempt_audit());
        assert!(event.terminal_relay_attempt_audit_id().is_none());
    }
}
