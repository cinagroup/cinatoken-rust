use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub id: i64,
    pub username: String,
    pub role: i32,
    pub status: i32,
    pub group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedToken {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub group: String,
    pub remain_quota: i64,
    pub unlimited_quota: bool,
    pub model_limits_enabled: bool,
    pub model_limits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user: AuthenticatedUser,
    pub token: Option<AuthenticatedToken>,
}

#[async_trait(?Send)]
pub trait TokenAuthenticator {
    async fn authenticate_token(&self, api_key: &str) -> cinatoken_core::ApiResult<AuthContext>;
}

#[async_trait(?Send)]
pub trait SessionAuthenticator {
    async fn authenticate_session(
        &self,
        bearer_or_cookie: &str,
    ) -> cinatoken_core::ApiResult<AuthContext>;
}
