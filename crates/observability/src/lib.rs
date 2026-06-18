use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayLogEvent {
    pub request_id: String,
    pub upstream_request_id: Option<String>,
    pub user_id: i64,
    pub token_id: Option<i64>,
    pub channel_id: Option<i64>,
    pub model_name: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub quota: i64,
    pub is_stream: bool,
    pub use_time_ms: i64,
    pub other: Value,
}

#[async_trait(?Send)]
pub trait LogSink {
    async fn write_relay_log(&self, event: RelayLogEvent) -> cinatoken_core::ApiResult<()>;
}
