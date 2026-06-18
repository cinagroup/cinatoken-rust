use async_trait::async_trait;
use cinatoken_core::{ApiError, ApiResult};
use serde_json::Value;

#[async_trait(?Send)]
pub trait KeyValueCache {
    async fn get_string(&self, key: &str) -> ApiResult<Option<String>>;

    async fn put_string(&self, key: &str, value: &str, ttl_seconds: Option<u32>) -> ApiResult<()>;

    async fn delete(&self, key: &str) -> ApiResult<()>;
}

#[async_trait(?Send)]
pub trait RateLimiter {
    async fn check(&self, key: &str, limit: u32, window_seconds: u32) -> ApiResult<bool>;
}

#[async_trait(?Send)]
pub trait CounterStore {
    async fn incr_by(&self, key: &str, delta: i64, ttl_seconds: u32) -> ApiResult<i64>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisRestCall {
    pub url: String,
    pub bearer_token: String,
    pub body: Value,
}

#[async_trait(?Send)]
pub trait RedisRestTransport {
    async fn post_json(&self, call: RedisRestCall) -> ApiResult<Value>;
}

#[derive(Debug, Clone)]
pub struct UpstashRedis<T> {
    rest_url: String,
    bearer_token: String,
    transport: T,
}

impl<T> UpstashRedis<T> {
    pub fn new(rest_url: impl Into<String>, bearer_token: impl Into<String>, transport: T) -> Self {
        Self {
            rest_url: trim_trailing_slashes(rest_url.into()),
            bearer_token: bearer_token.into(),
            transport,
        }
    }

    pub fn rest_url(&self) -> &str {
        &self.rest_url
    }

    pub fn bearer_token(&self) -> &str {
        &self.bearer_token
    }
}

impl<T> UpstashRedis<T>
where
    T: RedisRestTransport,
{
    pub async fn command(&self, command: Vec<Value>) -> ApiResult<Value> {
        let response = self
            .transport
            .post_json(RedisRestCall {
                url: self.rest_url.clone(),
                bearer_token: self.bearer_token.clone(),
                body: Value::Array(command),
            })
            .await?;
        parse_upstash_single_result(response)
    }

    pub async fn transaction(&self, commands: Vec<Vec<Value>>) -> ApiResult<Vec<Value>> {
        let response = self
            .transport
            .post_json(RedisRestCall {
                url: format!("{}/multi-exec", self.rest_url),
                bearer_token: self.bearer_token.clone(),
                body: Value::Array(commands.into_iter().map(Value::Array).collect()),
            })
            .await?;
        parse_upstash_array_result(response)
    }

    pub async fn set_string_ex(&self, key: &str, value: &str, ttl_seconds: u32) -> ApiResult<()> {
        let result = self
            .command(redis_command([
                redis_string("SET"),
                redis_string(key),
                redis_string(value),
                redis_string("EX"),
                redis_i64(i64::from(ttl_seconds)),
            ]))
            .await?;
        expect_ok(result, "SET")
    }

    pub async fn delete_key(&self, key: &str) -> ApiResult<()> {
        self.command(redis_command([redis_string("DEL"), redis_string(key)]))
            .await?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl<T> KeyValueCache for UpstashRedis<T>
where
    T: RedisRestTransport,
{
    async fn get_string(&self, key: &str) -> ApiResult<Option<String>> {
        let result = self
            .command(redis_command([redis_string("GET"), redis_string(key)]))
            .await?;
        match result {
            Value::Null => Ok(None),
            Value::String(value) => Ok(Some(value)),
            other => Err(ApiError::Internal(format!(
                "GET returned non-string Redis value: {other}"
            ))),
        }
    }

    async fn put_string(&self, key: &str, value: &str, ttl_seconds: Option<u32>) -> ApiResult<()> {
        let command = if let Some(ttl_seconds) = ttl_seconds {
            redis_command([
                redis_string("SET"),
                redis_string(key),
                redis_string(value),
                redis_string("EX"),
                redis_i64(i64::from(ttl_seconds)),
            ])
        } else {
            redis_command([redis_string("SET"), redis_string(key), redis_string(value)])
        };
        let result = self.command(command).await?;
        expect_ok(result, "SET")
    }

    async fn delete(&self, key: &str) -> ApiResult<()> {
        self.delete_key(key).await
    }
}

#[async_trait(?Send)]
impl<T> CounterStore for UpstashRedis<T>
where
    T: RedisRestTransport,
{
    async fn incr_by(&self, key: &str, delta: i64, ttl_seconds: u32) -> ApiResult<i64> {
        let results = self
            .transaction(vec![
                redis_command([redis_string("INCRBY"), redis_string(key), redis_i64(delta)]),
                redis_command([
                    redis_string("EXPIRE"),
                    redis_string(key),
                    redis_i64(i64::from(ttl_seconds)),
                ]),
            ])
            .await?;
        parse_i64_result(results.first(), "INCRBY")
    }
}

#[derive(Debug, Clone)]
pub struct ExpiringCounterRateLimiter<S> {
    store: S,
    prefix: String,
}

impl<S> ExpiringCounterRateLimiter<S> {
    pub fn new(store: S, prefix: impl Into<String>) -> Self {
        Self {
            store,
            prefix: prefix.into(),
        }
    }

    pub fn cache_key(&self, key: &str) -> String {
        scoped_cache_key(&self.prefix, key)
    }
}

#[async_trait(?Send)]
impl<S> RateLimiter for ExpiringCounterRateLimiter<S>
where
    S: CounterStore,
{
    async fn check(&self, key: &str, limit: u32, window_seconds: u32) -> ApiResult<bool> {
        if limit == 0 {
            return Ok(false);
        }
        let count = self
            .store
            .incr_by(&self.cache_key(key), 1, window_seconds)
            .await?;
        Ok(count <= i64::from(limit))
    }
}

pub fn redis_command(items: impl IntoIterator<Item = Value>) -> Vec<Value> {
    items.into_iter().collect()
}

pub fn redis_string(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

pub fn redis_i64(value: i64) -> Value {
    Value::Number(value.into())
}

pub fn scoped_cache_key(prefix: &str, key: &str) -> String {
    let prefix = prefix.trim_matches(':');
    let key = key.trim_matches(':');
    if prefix.is_empty() {
        key.to_string()
    } else if key.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}:{key}")
    }
}

fn trim_trailing_slashes(value: String) -> String {
    value.trim_end_matches('/').to_string()
}

fn parse_upstash_single_result(response: Value) -> ApiResult<Value> {
    let object = response
        .as_object()
        .ok_or_else(|| ApiError::Internal("Upstash response was not a JSON object".to_string()))?;
    if let Some(error) = object.get("error") {
        return Err(ApiError::Internal(format!("Upstash Redis error: {error}")));
    }
    object
        .get("result")
        .cloned()
        .ok_or_else(|| ApiError::Internal("Upstash response missing result".to_string()))
}

fn parse_upstash_array_result(response: Value) -> ApiResult<Vec<Value>> {
    let values = response.as_array().ok_or_else(|| {
        ApiError::Internal("Upstash transaction response was not an array".to_string())
    })?;
    values
        .iter()
        .cloned()
        .map(parse_upstash_single_result)
        .collect()
}

fn expect_ok(value: Value, command: &str) -> ApiResult<()> {
    match value.as_str() {
        Some("OK") => Ok(()),
        _ => Err(ApiError::Internal(format!(
            "{command} returned unexpected Redis value: {value}"
        ))),
    }
}

fn parse_i64_result(value: Option<&Value>, command: &str) -> ApiResult<i64> {
    value
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::Internal(format!("{command} returned non-integer Redis value")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        future::Future,
        pin::Pin,
        task::{Context, Poll, RawWaker, RawWakerVTable, Waker},
    };

    #[test]
    fn scoped_cache_key_joins_without_duplicate_colons() {
        assert_eq!(scoped_cache_key("rate:", ":token:abc:"), "rate:token:abc");
        assert_eq!(scoped_cache_key("", "token:abc"), "token:abc");
        assert_eq!(scoped_cache_key("rate", ""), "rate");
    }

    #[test]
    fn upstash_url_is_normalized() {
        let client =
            UpstashRedis::new("https://redis.example.com///", "token", FakeTransport::ok());
        assert_eq!(client.rest_url(), "https://redis.example.com");
    }

    #[test]
    fn parses_upstash_result_and_error_shapes() {
        assert_eq!(
            parse_upstash_single_result(serde_json::json!({"result": 12})).unwrap(),
            serde_json::json!(12)
        );
        let err = parse_upstash_single_result(serde_json::json!({"error": "ERR no"})).unwrap_err();
        assert!(err.to_string().contains("Upstash Redis error"));
    }

    #[test]
    fn parses_transaction_response_in_order() {
        let result = parse_upstash_array_result(serde_json::json!([
            {"result": 3},
            {"result": 1}
        ]))
        .unwrap();
        assert_eq!(result, vec![serde_json::json!(3), serde_json::json!(1)]);
    }

    #[test]
    fn get_string_posts_json_command() {
        let transport = FakeTransport::new(vec![serde_json::json!({"result": "cached"})]);
        let client = UpstashRedis::new("https://redis.example.com", "secret", transport);

        let value = block_on(client.get_string("token:1")).unwrap();
        assert_eq!(value.as_deref(), Some("cached"));

        let calls = client.transport.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].url, "https://redis.example.com");
        assert_eq!(calls[0].bearer_token, "secret");
        assert_eq!(calls[0].body, serde_json::json!(["GET", "token:1"]));
    }

    #[test]
    fn incr_by_uses_multi_exec_with_ttl() {
        let transport = FakeTransport::new(vec![serde_json::json!([
            {"result": 5},
            {"result": 1}
        ])]);
        let client = UpstashRedis::new("https://redis.example.com", "secret", transport);

        let value = block_on(client.incr_by("rate:token", 1, 60)).unwrap();
        assert_eq!(value, 5);

        let calls = client.transport.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].url, "https://redis.example.com/multi-exec");
        assert_eq!(
            calls[0].body,
            serde_json::json!([["INCRBY", "rate:token", 1], ["EXPIRE", "rate:token", 60]])
        );
    }

    #[test]
    fn rate_limiter_allows_until_limit() {
        let store = FakeCounterStore {
            responses: RefCell::new(vec![1, 2, 3]),
            calls: RefCell::new(Vec::new()),
        };
        let limiter = ExpiringCounterRateLimiter::new(store, "rate");

        assert!(block_on(limiter.check("token", 2, 60)).unwrap());
        assert!(block_on(limiter.check("token", 2, 60)).unwrap());
        assert!(!block_on(limiter.check("token", 2, 60)).unwrap());

        let calls = limiter.store.calls.borrow();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0], ("rate:token".to_string(), 1, 60));
    }

    struct FakeTransport {
        responses: RefCell<Vec<Value>>,
        calls: RefCell<Vec<RedisRestCall>>,
    }

    impl FakeTransport {
        fn ok() -> Self {
            Self::new(vec![serde_json::json!({"result": "OK"})])
        }

        fn new(responses: Vec<Value>) -> Self {
            Self {
                responses: RefCell::new(responses),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    #[async_trait(?Send)]
    impl RedisRestTransport for FakeTransport {
        async fn post_json(&self, call: RedisRestCall) -> ApiResult<Value> {
            self.calls.borrow_mut().push(call);
            if self.responses.borrow().is_empty() {
                return Err(ApiError::Internal("no fake response queued".to_string()));
            }
            Ok(self.responses.borrow_mut().remove(0))
        }
    }

    struct FakeCounterStore {
        responses: RefCell<Vec<i64>>,
        calls: RefCell<Vec<(String, i64, u32)>>,
    }

    #[async_trait(?Send)]
    impl CounterStore for FakeCounterStore {
        async fn incr_by(&self, key: &str, delta: i64, ttl_seconds: u32) -> ApiResult<i64> {
            self.calls
                .borrow_mut()
                .push((key.to_string(), delta, ttl_seconds));
            Ok(self.responses.borrow_mut().remove(0))
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match Future::poll(Pin::as_mut(&mut future), &mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => {}
            }
        }
    }

    fn noop_waker() -> Waker {
        unsafe { Waker::from_raw(noop_raw_waker()) }
    }

    fn noop_raw_waker() -> RawWaker {
        RawWaker::new(std::ptr::null(), &NOOP_WAKER_VTABLE)
    }

    static NOOP_WAKER_VTABLE: RawWakerVTable =
        RawWakerVTable::new(noop_clone, noop_wake, noop_wake, noop_drop);

    unsafe fn noop_clone(_: *const ()) -> RawWaker {
        noop_raw_waker()
    }

    unsafe fn noop_wake(_: *const ()) {}

    unsafe fn noop_drop(_: *const ()) {}
}
