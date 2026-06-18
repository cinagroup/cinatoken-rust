use async_trait::async_trait;

#[async_trait(?Send)]
pub trait RateLimiter {
    async fn check(
        &self,
        key: &str,
        limit: u32,
        window_seconds: u32,
    ) -> cinatoken_core::ApiResult<bool>;
}

#[async_trait(?Send)]
pub trait CounterStore {
    async fn incr_by(
        &self,
        key: &str,
        delta: i64,
        ttl_seconds: u32,
    ) -> cinatoken_core::ApiResult<i64>;
}
