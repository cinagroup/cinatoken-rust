//! Admin-triggered cache invalidation (G5).
//!
//! When an admin/user mutation changes a row that the relay hot path caches
//! in Upstash Redis (token auth, channel selection, options), the cache must
//! be invalidated so the next relay request sees the new state immediately
//! rather than waiting for the TTL. This module implements that invalidation
//! using Upstash Redis REST SCAN + DEL.
//!
//! ## Strategy
//!
//! Relay cache keys are not indexed by primary id (the token auth cache key
//! includes a fingerprint of the API key + model + client IP, and the channel
//! cache key includes the group + model + endpoint family). Precise
//! invalidation is therefore not practical without a separate id→key index.
//! Instead we pattern-scan and bulk-delete by prefix, mirroring the Go
//! gateway's `model.DeleteTokenCacheByUserId` / channel cache clear behavior.
//!
//! Trade-off: on a high-traffic deployment a token mutation causes a brief
//! cache-miss storm as every concurrent relay request rebuilds its auth
//! cache entry. This is the same cost the Go gateway pays and is acceptable
//! because admin mutations are rare relative to relay traffic.
//!
//! ## Failure mode
//!
//! All helpers are best-effort. If Upstash is not configured, returns `Ok`
//! immediately (the TTL is the safety net). If a SCAN or DEL fails, the error
//! is logged via `console_warn!` and the function returns `Ok(())` — the
//! mutation that triggered the invalidation has already succeeded and must
//! not be rolled back because of a cache cleanup problem. The relay path
//! already treats cache failures as fall-through-to-D1.

use cinatoken_cache::UpstashRedis;
use serde_json::Value;
use worker::{Env, Result as WorkerResult};

use crate::cache::{upstash_redis_from_env, WorkerRedisRestTransport};

/// Maximum SCAN iterations per invalidation call. Guards against a runaway
/// cursor in a degraded Redis. 50 iterations × 100 keys = up to 5000 keys,
/// which comfortably covers the relay cache working set on a single Worker
/// isolate.
const MAX_SCAN_ITERATIONS: usize = 50;
const SCAN_COUNT: i64 = 100;

/// Invalidate every relay token-auth cache entry (`relay:auth:*`). Called
/// after token create/update/delete/reveal and after user status/quota/role
/// changes.
pub async fn invalidate_token_cache(env: &Env) -> WorkerResult<()> {
    invalidate_pattern(env, "relay:auth:*").await
}

/// Invalidate every relay channel-selection cache entry
/// (`relay:channel:*`). Called after channel create/update/delete/status
/// changes and after ability/group/model mapping changes.
#[allow(dead_code)] // wired by the next G5 batch (channel admin CRUD)
pub async fn invalidate_channel_cache(env: &Env) -> WorkerResult<()> {
    invalidate_pattern(env, "relay:channel:*").await
}

/// Invalidate option-derived cache entries. The relay path does not cache
/// options today (it reads billing options from D1 on each request), so this
/// is a placeholder for future option caching; it currently scans
/// `relay:option:*` which is expected to be empty.
pub async fn invalidate_option_cache(env: &Env) -> WorkerResult<()> {
    invalidate_pattern(env, "relay:option:*").await
}

async fn invalidate_pattern(env: &Env, pattern: &str) -> WorkerResult<()> {
    let Some(redis) = upstash_redis_from_env(env)
        .map_err(|err| {
            worker::console_warn!("cache invalidation aborted: redis init failed: {err}");
        })
        .ok()
        .flatten()
    else {
        // Upstash not configured — TTL is the safety net. Not an error.
        return Ok(());
    };
    if let Err(err) = scan_and_delete(&redis, pattern).await {
        worker::console_warn!(
            "cache invalidation for pattern {pattern:?} failed (falling back to TTL): {err}"
        );
    }
    Ok(())
}

async fn scan_and_delete(
    redis: &UpstashRedis<WorkerRedisRestTransport>,
    pattern: &str,
) -> WorkerResult<()> {
    let mut cursor: i64 = 0;
    let mut iterations = 0usize;
    loop {
        iterations += 1;
        if iterations > MAX_SCAN_ITERATIONS {
            worker::console_warn!(
                "cache invalidation for {pattern:?} hit MAX_SCAN_ITERATIONS; remaining keys will expire via TTL"
            );
            return Ok(());
        }
        // SCAN returns [cursor, [keys...]] in Upstash REST form.
        let response = redis
            .command(vec![
                Value::String("SCAN".to_string()),
                Value::Number(cursor.into()),
                Value::String("MATCH".to_string()),
                Value::String(pattern.to_string()),
                Value::String("COUNT".to_string()),
                Value::Number(SCAN_COUNT.into()),
            ])
            .await
            .map_err(|err| worker::Error::RustError(err.to_string()))?;
        let (next_cursor, keys) = parse_scan_response(&response)?;
        if !keys.is_empty() {
            // Best-effort DEL; ignore per-key errors (key may have expired
            // between SCAN and DEL).
            let mut del_cmd = vec![Value::String("DEL".to_string())];
            for key in &keys {
                del_cmd.push(Value::String(key.clone()));
            }
            let _ = redis.command(del_cmd).await;
        }
        cursor = next_cursor;
        if cursor == 0 {
            return Ok(());
        }
    }
}

/// Parse the Upstash REST SCAN response into `(next_cursor, keys)`.
fn parse_scan_response(response: &Value) -> WorkerResult<(i64, Vec<String>)> {
    let arr = response.as_array().ok_or_else(|| {
        worker::Error::RustError(format!("SCAN response not an array: {response}"))
    })?;
    // Upstash wraps the Redis reply: `{"result": [cursor, [keys...]]}` is
    // already unwrapped by `UpstashRedis::command` into the inner value, so
    // `response` is `[cursor, [keys...]]` directly.
    let next_cursor = arr
        .first()
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| worker::Error::RustError("SCAN response missing cursor".into()))?;
    let keys: Vec<String> = arr
        .get(1)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok((next_cursor, keys))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scan_response_extracts_cursor_and_keys() {
        let response = serde_json::json!([0, ["relay:auth:abc", "relay:auth:def"]]);
        let (cursor, keys) = parse_scan_response(&response).unwrap();
        assert_eq!(cursor, 0);
        assert_eq!(keys, vec!["relay:auth:abc", "relay:auth:def"]);
    }

    #[test]
    fn parse_scan_response_accepts_string_cursor() {
        // Some Redis/Upstash builds return the cursor as a string.
        let response = serde_json::json!(["42", ["relay:auth:abc"]]);
        let (cursor, keys) = parse_scan_response(&response).unwrap();
        assert_eq!(cursor, 42);
        assert_eq!(keys, vec!["relay:auth:abc"]);
    }

    #[test]
    fn parse_scan_response_handles_empty_keys() {
        let response = serde_json::json!([0, []]);
        let (cursor, keys) = parse_scan_response(&response).unwrap();
        assert_eq!(cursor, 0);
        assert!(keys.is_empty());
    }

    #[test]
    fn parse_scan_response_rejects_non_array() {
        let response = serde_json::json!("oops");
        assert!(parse_scan_response(&response).is_err());
    }

    #[test]
    fn parse_scan_response_rejects_missing_cursor() {
        let response = serde_json::json!([]);
        assert!(parse_scan_response(&response).is_err());
    }
}
