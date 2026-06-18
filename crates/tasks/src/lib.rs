use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Submitted,
    Queued,
    Processing,
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub id: i64,
    pub public_task_id: String,
    pub upstream_task_id: String,
    pub platform: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub model: String,
    pub quota: i64,
    pub status: TaskStatus,
    pub progress: String,
    pub result_url: Option<String>,
    pub data: Value,
}

#[async_trait(?Send)]
pub trait TaskRepository {
    async fn insert(&self, task: &TaskRecord) -> cinatoken_core::ApiResult<()>;
    async fn update_status(
        &self,
        public_task_id: &str,
        status: TaskStatus,
        result_url: Option<String>,
    ) -> cinatoken_core::ApiResult<()>;
    async fn get_by_public_id(&self, public_task_id: &str)
        -> cinatoken_core::ApiResult<TaskRecord>;
}
