//! Admin channel-affinity cache controls.
//!
//! This is intentionally narrower than Go's rule-aware affinity subsystem:
//! Rust currently has one fixed Worker-native affinity key and exposes only
//! stats/clear for the KV-indexed Durable Object records it actually writes.

use std::collections::HashMap;

use serde_json::json;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, require_admin_auth,
    unix_timestamp,
};
use crate::{affinity, d1_repositories};

const CLEAR_ACTION: &str = "channel_affinity.cache_clear";

pub async fn get_cache_stats(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let query = query_map(&req)?;
    let cursor = query
        .get("cursor")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let limit = bounded_limit(query.get("limit").map(String::as_str));
    let stats = affinity::affinity_cache_stats(&env, cursor, limit).await?;
    envelope_ok_response(&stats)
}

pub async fn clear_cache(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let query = query_map(&req)?;
    let all = query
        .get("all")
        .map(String::as_str)
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1");
    let rule_name = query
        .get("rule_name")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if !all && rule_name.is_none() {
        return Ok(envelope_error_response(
            400,
            "missing parameter: rule_name, or use all=true to clear all channel affinity cache entries",
        ));
    }

    let limit = bounded_limit(query.get("limit").map(String::as_str));
    let result = affinity::clear_affinity_cache(&env, rule_name, limit).await?;
    if let Ok(db) = env.d1("DB") {
        let now = unix_timestamp();
        let _ = d1_repositories::insert_admin_audit_log(
            &db,
            None,
            None,
            &claims.username,
            CLEAR_ACTION,
            &format!(
                "admin {} cleared channel affinity cache entries",
                claims.username
            ),
            &json!({
                "all": result.all,
                "rule_name": result.rule_name,
                "deleted": result.deleted,
                "do_deleted": result.do_deleted,
                "kv_deleted": result.kv_deleted,
                "failed": result.failed,
                "skipped_rule": result.skipped_rule,
                "truncated": result.truncated,
                "cursor": result.cursor,
                "scope": result.scope,
            }),
            &admin_audit_info(&claims, &req),
            now,
        )
        .await;
    }
    envelope_ok_response(&result)
}

fn query_map(req: &Request) -> WorkerResult<HashMap<String, String>> {
    Ok(req
        .url()?
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect())
}

fn bounded_limit(value: Option<&str>) -> usize {
    value
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(affinity::AFFINITY_INDEX_SCAN_LIMIT))
        .unwrap_or(affinity::AFFINITY_INDEX_SCAN_LIMIT)
}
