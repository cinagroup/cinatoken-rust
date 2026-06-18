use async_trait::async_trait;
use cinatoken_cache::{RedisRestCall, RedisRestTransport, UpstashRedis};
use cinatoken_core::{ApiError, ApiResult};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit};

#[derive(Debug, Clone, Copy)]
pub struct WorkerRedisRestTransport;

#[async_trait(?Send)]
impl RedisRestTransport for WorkerRedisRestTransport {
    async fn post_json(&self, call: RedisRestCall) -> ApiResult<Value> {
        let body = serde_json::to_string(&call.body)
            .map_err(|err| ApiError::Internal(format!("failed to encode Redis command: {err}")))?;
        let mut headers = Headers::new();
        headers
            .set("content-type", "application/json")
            .map_err(worker_api_error)?;
        headers
            .set("authorization", &format!("Bearer {}", call.bearer_token))
            .map_err(worker_api_error)?;

        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(JsValue::from_str(&body)));
        let outbound = Request::new_with_init(&call.url, &init).map_err(worker_api_error)?;
        let mut response = Fetch::Request(outbound)
            .send()
            .await
            .map_err(worker_api_error)?;
        let status = response.status_code();
        let text = response.text().await.map_err(worker_api_error)?;
        let value = serde_json::from_str::<Value>(&text).map_err(|err| {
            ApiError::Internal(format!(
                "failed to decode Upstash Redis response: {err}: {text}"
            ))
        })?;

        if !(200..300).contains(&status) {
            return Err(ApiError::Internal(format!(
                "Upstash Redis HTTP {status}: {value}"
            )));
        }

        Ok(value)
    }
}

pub fn upstash_redis_from_env(
    env: &Env,
) -> ApiResult<Option<UpstashRedis<WorkerRedisRestTransport>>> {
    let Some(rest_url) = optional_env_var(env, "UPSTASH_REDIS_REST_URL")? else {
        return Ok(None);
    };
    let Some(token) = optional_env_var(env, "UPSTASH_REDIS_REST_TOKEN")? else {
        return Ok(None);
    };
    Ok(Some(UpstashRedis::new(
        rest_url,
        token,
        WorkerRedisRestTransport,
    )))
}

pub fn upstash_redis_configured(env: &Env) -> bool {
    upstash_redis_from_env(env)
        .ok()
        .flatten()
        .map(|client| !client.rest_url().is_empty() && !client.bearer_token().is_empty())
        .unwrap_or(false)
}

fn optional_env_var(env: &Env, name: &str) -> ApiResult<Option<String>> {
    match env.var(name) {
        Ok(value) => {
            let value = value.to_string();
            if value.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(value))
            }
        }
        Err(_) => Ok(None),
    }
}

fn worker_api_error(err: worker::Error) -> ApiError {
    ApiError::Internal(err.to_string())
}
