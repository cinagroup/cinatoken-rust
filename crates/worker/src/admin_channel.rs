//! Admin channel CRUD handlers (G5 P0): Tier 1 routes.
//!
//! Mirrors Go `controller/channel.go` Tier 1 surface: list, search, get,
//! create (single mode only), update, delete, batch delete, and fix
//! abilities. Every write operation keeps the `abilities` table in sync so
//! the relay's `select_channels_from_abilities` finds new/edited channels.
//!
//! Tier 2 key reveal, tag, connectivity, and disabled-channel operations are
//! implemented. Tier 3 now includes balance and multi-key management; Codex,
//! Ollama, and upstream-update operations remain deferred.

use futures_util::future::{select, Either};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use wasm_bindgen::JsValue;
use worker::{
    AbortController, Delay, Env, Request, RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    unix_timestamp,
};
use crate::cache_invalidation::invalidate_channel_cache;
use crate::d1_repositories::{self, ChannelFilter, ChannelRow, CreateChannel, UpdateChannel};

// ---------------------------------------------------------------------------
// List / search / get
// ---------------------------------------------------------------------------

/// `GET /api/channel/`: admin channel list. AdminAuth.
/// `GET /api/channel/models_enabled`: all distinct enabled model names across
/// every group (Go `EnabledListModels` -> `GetEnabledModels`). AdminAuth.
pub async fn enabled_list_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let models = d1_repositories::distinct_all_enabled_models(&db).await?;
    envelope_ok_response(&models)
}

/// `GET /api/channel/update_balance/:id`: query the provider's authoritative
/// balance and persist it only after a fully validated response. AdminAuth.
pub async fn update_channel_balance(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let Some(id) = parse_id_param(id_param).filter(|id| *id > 0 && *id <= i32::MAX as i64) else {
        return Ok(envelope_error_response(400, "invalid channel id"));
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    match parse_channel_info(&channel.channel_info) {
        Ok(info) if is_multi_key_info(&info) => {
            return Ok(envelope_error_response(
                422,
                "multi-key channels do not support balance queries",
            ));
        }
        Err(message) => return Ok(envelope_error_response(500, &message)),
        _ => {}
    }
    if channel.key.trim().is_empty() {
        return Ok(envelope_error_response(422, "channel key is empty"));
    }

    let balance = match fetch_channel_balance(&db, &channel).await {
        Ok(balance) => balance,
        Err(message) => return Ok(envelope_error_response(502, &message)),
    };
    if !balance.is_finite() {
        return Ok(envelope_error_response(
            502,
            "upstream returned an invalid balance",
        ));
    }
    let now = unix_timestamp();
    if !d1_repositories::update_channel_balance(&db, id, balance, now).await? {
        return Ok(envelope_error_response(
            409,
            "channel changed during balance update",
        ));
    }
    invalidate_channel_cache(&env).await?;
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.balance_update",
        &format!("admin {} updated channel {} balance", claims.username, id),
        &serde_json::json!({"id": id, "type": channel.kind, "balance": balance}),
        &crate::admin::admin_audit_info(&claims, &req),
        now,
    )
    .await;

    let mut response = Response::from_json(&ChannelBalanceResponse {
        success: true,
        message: "",
        balance,
    })?
    .with_status(200);
    crate::set_cors_headers(&mut response)?;
    Ok(response)
}

/// `POST /api/channel/multi_key/manage`: complete compatibility surface for
/// the default frontend's seven multi-key actions. Channel keys are never
/// returned or written to logs/audit records.
pub async fn manage_multi_keys(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: MultiKeyManageRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(envelope_error_response(
                400,
                "invalid multi-key management request",
            ));
        }
    };
    if payload.channel_id <= 0 || payload.channel_id > i32::MAX as i64 {
        return Ok(envelope_error_response(400, "invalid channel id"));
    }

    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, payload.channel_id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    let operation = match apply_multi_key_action(&channel.key, &channel.channel_info, &payload) {
        Ok(operation) => operation,
        Err(error) => return Ok(envelope_error_response(error.status, &error.message)),
    };

    match operation {
        MultiKeyOperation::Read(data) => envelope_ok_response(&data),
        MultiKeyOperation::Write(write) => {
            let changed = d1_repositories::update_multi_key_channel(
                &db,
                channel.id,
                &channel.key,
                &channel.channel_info,
                &write.key,
                &write.channel_info,
            )
            .await?;
            if !changed {
                return Ok(envelope_error_response(
                    409,
                    "channel changed; reload key status and retry",
                ));
            }
            invalidate_channel_cache(&env).await?;
            let now = unix_timestamp();
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                None,
                None,
                &claims.username,
                "channel.multi_key_manage",
                &format!(
                    "admin {} performed {} on channel {}",
                    claims.username, payload.action, channel.id
                ),
                &serde_json::json!({
                    "action": payload.action,
                    "id": channel.id,
                    "key_index": payload.key_index
                }),
                &crate::admin::admin_audit_info(&claims, &req),
                now,
            )
            .await;
            match write.data {
                Some(data) => envelope_ok_response(&data),
                None => {
                    let mut response = Response::from_json(&serde_json::json!({
                        "success": true,
                        "message": write.message
                    }))?
                    .with_status(200);
                    crate::set_cors_headers(&mut response)?;
                    Ok(response)
                }
            }
        }
    }
}

/// `GET /api/channel/test/:id?model=`: send a minimal chat completion through
/// the channel with its own stored key and record the latency (Go
/// `TestChannel`). Test model precedence: query param > channel `test_model` >
/// first of the channel's `models` CSV > `gpt-4o-mini` (Go's fallback chain).
/// On success the channel's `response_time`/`test_time` are updated and the
/// elapsed seconds returned. Bounded subset vs Go (documented): tests the
/// OpenAI-compatible chat endpoint only (no per-endpoint-type dispatch /
/// embedding / rerank variants).
pub async fn test_channel(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid channel id"));
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    let query_model = parse_query_string(&req, "model");
    let test_model = query_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            channel
                .test_model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            channel
                .models
                .split(',')
                .map(str::trim)
                .find(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    let url = format!(
        "{}/v1/chat/completions",
        channel.base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": test_model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    });
    let mut headers = worker::Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Authorization", &format!("Bearer {}", channel.key))?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Post)
        .with_headers(headers)
        .with_body(Some(body.to_string().into()));
    let outbound = Request::new_with_init(&url, &init)?;

    let started = js_sys::Date::now();
    let result = worker::Fetch::Request(outbound).send().await;
    let elapsed_ms = (js_sys::Date::now() - started).max(0.0);
    let mut upstream = match result {
        Ok(response) => response,
        Err(err) => {
            return Response::from_json(&serde_json::json!({
                "success": false,
                "message": format!("channel request failed: {err}"),
                "time": 0.0,
            }));
        }
    };
    if upstream.status_code() < 200 || upstream.status_code() >= 300 {
        let detail = upstream.text().await.unwrap_or_default();
        let truncated: String = detail.chars().take(300).collect();
        return Response::from_json(&serde_json::json!({
            "success": false,
            "message": format!(
                "upstream status {}: {truncated}",
                upstream.status_code()
            ),
            "time": 0.0,
        }));
    }
    // Record the measured latency on the channel (Go updates response_time in
    // ms + test_time).
    d1_repositories::record_channel_test(&db, id, elapsed_ms as i64, unix_timestamp()).await?;
    Response::from_json(&serde_json::json!({
        "success": true,
        "message": "",
        "time": elapsed_ms / 1000.0,
    }))
}

/// Fetch `{base_url}/v1/models` with a bearer key and return the model ids
/// (the OpenAI-compatible list shape). Shared by the by-id and by-body probes.
async fn fetch_openai_model_ids(
    base_url: &str,
    key: &str,
) -> std::result::Result<Vec<String>, String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let mut headers = worker::Headers::new();
    headers
        .set("Authorization", &format!("Bearer {key}"))
        .map_err(|err| err.to_string())?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Get).with_headers(headers);
    let outbound = Request::new_with_init(&url, &init).map_err(|err| err.to_string())?;
    let mut upstream = worker::Fetch::Request(outbound)
        .send()
        .await
        .map_err(|err| format!("failed to fetch upstream models: {err}"))?;
    if upstream.status_code() < 200 || upstream.status_code() >= 300 {
        return Err(format!("upstream status {}", upstream.status_code()));
    }
    #[derive(serde::Deserialize)]
    struct ModelsList {
        #[serde(default)]
        data: Vec<ModelEntry>,
    }
    #[derive(serde::Deserialize)]
    struct ModelEntry {
        #[serde(default)]
        id: String,
    }
    let parsed: ModelsList = upstream
        .json()
        .await
        .map_err(|err| format!("unparseable upstream models response: {err}"))?;
    Ok(parsed
        .data
        .into_iter()
        .map(|entry| entry.id)
        .filter(|id| !id.is_empty())
        .collect())
}

/// `GET /api/channel/fetch_models/:id`: list the upstream's available model ids
/// by calling `{base_url}/v1/models` with the channel's own key (Go
/// `FetchUpstreamModels`, OpenAI-compatible shape).
pub async fn fetch_upstream_models(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid channel id"));
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    match fetch_openai_model_ids(&channel.base_url, &channel.key).await {
        Ok(ids) => envelope_ok_response(&ids),
        Err(message) => Ok(envelope_error_response(502, &message)),
    }
}

/// `POST /api/channel/fetch_models`: probe an upstream with a body-supplied
/// `{base_url, key}` before the channel exists (Go `FetchModels`; the
/// channel-create UI's "fetch models" button). Bounded subset vs Go
/// (documented): OpenAI-compatible probing only — the per-type default
/// base-URL table and the Ollama/Gemini-specific listers are not ported, so
/// `base_url` is required here. The key is trimmed to its first line, as Go
/// does for multi-key input.
pub async fn fetch_models_probe(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    #[derive(Deserialize, Default)]
    struct Probe {
        #[serde(default)]
        base_url: String,
        #[serde(default)]
        key: String,
    }
    let probe: Probe = serde_json::from_value(body).unwrap_or_default();
    let base_url = probe.base_url.trim();
    if base_url.is_empty() {
        return Ok(envelope_error_response(
            400,
            "base_url is required (per-type default URLs are not supported)",
        ));
    }
    let key = probe.key.trim().lines().next().unwrap_or("").trim();
    match fetch_openai_model_ids(base_url, key).await {
        Ok(ids) => envelope_ok_response(&ids),
        Err(message) => Ok(envelope_error_response(502, &message)),
    }
}

/// A `{ "tag": "..." }` body (Go `ChannelTag`).
#[derive(Debug, Deserialize, Default)]
struct ChannelTagRequest {
    #[serde(default)]
    tag: String,
}

/// Read + validate a non-empty `tag` from the request body.
async fn read_tag(req: &mut Request) -> Result<String, Response> {
    let body = read_json_body(req).await?;
    let payload: ChannelTagRequest = serde_json::from_value(body).unwrap_or_default();
    let tag = payload.tag.trim().to_string();
    if tag.is_empty() {
        return Err(envelope_error_response(400, "tag must not be empty"));
    }
    Ok(tag)
}

/// `POST /api/channel/tag/disabled`: manually disable all channels with a tag
/// (Go `DisableTagChannels`). AdminAuth.
pub async fn disable_tag_channels(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let tag = match read_tag(&mut req).await {
        Ok(tag) => tag,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    d1_repositories::set_channels_status_by_tag(&db, &tag, 2, false).await?;
    invalidate_channel_cache(&env).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `POST /api/channel/tag/enabled`: re-enable all channels with a tag (Go
/// `EnableTagChannels`). AdminAuth.
pub async fn enable_tag_channels(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let tag = match read_tag(&mut req).await {
        Ok(tag) => tag,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    d1_repositories::set_channels_status_by_tag(&db, &tag, 1, true).await?;
    invalidate_channel_cache(&env).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `DELETE /api/channel/disabled`: delete all disabled channels + their
/// abilities (Go `DeleteDisabledChannel`). Returns the count deleted. AdminAuth.
pub async fn delete_disabled_channels(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let count = d1_repositories::delete_disabled_channels(&db).await?;
    invalidate_channel_cache(&env).await?;
    envelope_ok_response(&count)
}

/// Full edit-by-tag request (Go `ChannelTag`).
#[derive(Debug, Deserialize, Default)]
struct ChannelTagEditRequest {
    #[serde(default)]
    tag: String,
    #[serde(default)]
    new_tag: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
    #[serde(default)]
    weight: Option<i64>,
    #[serde(default)]
    model_mapping: Option<String>,
    #[serde(default)]
    models: Option<String>,
    #[serde(default)]
    groups: Option<String>,
    #[serde(default)]
    param_override: Option<String>,
    #[serde(default)]
    header_override: Option<String>,
}

/// Validate that an optional override is blank or valid JSON (Go's `json.Valid`
/// check), returning the trimmed value. Pure, so it is unit-testable.
fn validate_override(value: &Option<String>, label: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && serde_json::from_str::<serde_json::Value>(trimmed).is_err() {
                return Err(format!("{label} must be valid JSON"));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

/// `PUT /api/channel/tag`: bulk-edit every channel carrying a tag (Go
/// `EditTagChannels` -> `EditChannelByTag`). Optionally retags, and updates
/// model_mapping / models / group / priority / weight / param+header override.
/// When models or group change, abilities are rebuilt per channel; otherwise the
/// abilities' priority/weight are updated. AdminAuth.
pub async fn edit_tag_channels(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ChannelTagEditRequest = serde_json::from_value(body).unwrap_or_default();
    let tag = payload.tag.trim().to_string();
    if tag.is_empty() {
        return Ok(envelope_error_response(400, "tag must not be empty"));
    }
    let param_override = match validate_override(&payload.param_override, "param_override") {
        Ok(value) => value,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let header_override = match validate_override(&payload.header_override, "header_override") {
        Ok(value) => value,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };

    // Only retag when a different, non-empty tag is supplied.
    let new_tag = payload
        .new_tag
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty() && *candidate != tag)
        .map(str::to_string);
    // Go treats models/group as "changed" only when a non-empty value is given.
    let models = payload
        .models
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let groups = payload
        .groups
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let should_recreate = models.is_some() || groups.is_some();
    let updated_tag = new_tag.clone().unwrap_or_else(|| tag.clone());

    let edit = d1_repositories::EditChannelsByTag {
        new_tag: new_tag.as_deref(),
        model_mapping: payload.model_mapping.as_deref(),
        models: models.as_deref(),
        group: groups.as_deref(),
        priority: payload.priority,
        weight: payload.weight,
        param_override: param_override.as_deref(),
        header_override: header_override.as_deref(),
    };
    let db = env.d1("DB")?;
    d1_repositories::edit_channels_by_tag(&db, &tag, &edit).await?;

    if should_recreate {
        // Rebuild abilities from each (retagged) channel's current models × group.
        for channel in d1_repositories::channels_by_tag(&db, &updated_tag).await? {
            let _ = d1_repositories::update_abilities_for_channel(
                &db,
                channel.id,
                &channel.models,
                &channel.group,
                channel.status,
                channel.priority as i32,
                channel.weight as i32,
            )
            .await;
        }
    } else {
        d1_repositories::update_abilities_priority_weight_by_tag(
            &db,
            &updated_tag,
            payload.priority,
            payload.weight,
        )
        .await?;
    }
    invalidate_channel_cache(&env).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

pub async fn list_channels(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let filter = parse_channel_filter(&req);
    let (page, page_size) = parse_pagination(&req);
    let rows = d1_repositories::list_channels(&db, &filter, page, page_size).await?;
    let total = d1_repositories::count_channels(&db, &filter).await?;
    let type_counts =
        d1_repositories::count_channels_by_type(&db, filter.group.as_deref(), filter.status)
            .await?;
    let items: Vec<ChannelResponse> = rows.into_iter().map(channel_response_no_key).collect();
    Ok(envelope_ok_response(&ChannelsPage {
        items,
        total,
        page,
        page_size,
        type_counts,
    })?)
}

/// `GET /api/channel/search`: admin channel search. AdminAuth.
pub async fn search_channels(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let keyword = parse_query_string(&req, "keyword").unwrap_or_default();
    let filter = parse_channel_filter(&req);
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let rows = d1_repositories::search_channels(&db, &keyword, &filter, page, page_size).await?;
    // Search computes type_counts in-memory (Go behavior): iterate the page
    // results. This under-counts types not on the current page, matching the
    // Go SearchChannels implementation.
    let mut type_counts: Vec<d1_repositories::TypeCount> = Vec::new();
    for row in &rows {
        if let Some(existing) = type_counts.iter_mut().find(|t| t.kind == row.kind) {
            existing.count += 1;
        } else {
            type_counts.push(d1_repositories::TypeCount {
                kind: row.kind,
                count: 1,
            });
        }
    }
    let total = rows.len() as i64;
    let items: Vec<ChannelResponse> = rows.into_iter().map(channel_response_no_key).collect();
    Ok(envelope_ok_response(&ChannelsPage {
        items,
        total,
        page,
        page_size,
        type_counts,
    })?)
}

/// `GET /api/channel/:id`: get one channel (key omitted). AdminAuth.
pub async fn get_channel(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "channel id is required")),
    };
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    Ok(envelope_ok_response(&channel_response_no_key(row))?)
}

/// `POST /api/channel/:id/key`: reveal a channel's upstream key. Admin-only and
/// gated by secure-verification step-up (item 2.3) — the Go-canonical
/// secure-verified credential reveal. The reveal is audited (the key itself is
/// NEVER logged, only channel id/name) so the trail shows who revealed what.
pub async fn reveal_channel_key(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "channel id is required")),
    };
    // Step-up gate: revealing a credential requires a fresh secure-verification.
    if let Some(response) = crate::admin::require_secure_verification(&env, claims.id).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let Some(row) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    let channel_id = row.id;
    let channel_name = row.name.clone();
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        Some(claims.id),
        Some(&claims.username),
        &claims.username,
        "channel.key_view",
        &format!(
            "user {} revealed key for channel {}",
            claims.username, channel_name
        ),
        &serde_json::json!({"channel_id": channel_id, "channel_name": channel_name}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(
        &serde_json::json!({ "key": row.key }),
    )?)
}

// ---------------------------------------------------------------------------
// Create / update / delete / batch / fix
// ---------------------------------------------------------------------------

/// `POST /api/channel/`: create a channel (single mode only). AdminAuth.
pub async fn create_channel(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ChannelCreateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid channel create request: {err}"),
            ));
        }
    };
    let key = payload.key.trim();
    let name = payload.name.trim();
    if key.is_empty() {
        return Ok(envelope_error_response(
            400,
            "channel key must not be empty",
        ));
    }
    if name.is_empty() {
        return Ok(envelope_error_response(
            400,
            "channel name must not be empty",
        ));
    }
    let now = unix_timestamp();
    let db = env.d1("DB")?;
    let channel_id = d1_repositories::create_channel(
        &db,
        CreateChannel {
            kind: payload.kind,
            key,
            name,
            base_url: payload.base_url.as_deref().unwrap_or(""),
            models: payload.models.as_deref().unwrap_or(""),
            group: payload.group.as_deref().unwrap_or("default"),
            model_mapping: payload.model_mapping.as_deref(),
            priority: payload.priority.unwrap_or(0),
            weight: payload.weight.unwrap_or(0),
            status: payload.status.unwrap_or(1),
            auto_ban: payload.auto_ban.unwrap_or(1),
            tag: payload.tag.as_deref(),
            openai_organization: payload.openai_organization.as_deref(),
            test_model: payload.test_model.as_deref(),
            other: payload.other.as_deref().unwrap_or(""),
            status_code_mapping: payload.status_code_mapping.as_deref().unwrap_or(""),
            other_info: payload.other_info.as_deref().unwrap_or(""),
            setting: payload.setting.as_deref(),
            param_override: payload.param_override.as_deref(),
            header_override: payload.header_override.as_deref(),
            remark: payload.remark.as_deref(),
            created_time: now,
        },
    )
    .await?;
    // Best-effort abilities sync. Failure is logged but does not roll back
    // the channel — operator can run POST /api/channel/fix to rebuild.
    if let Err(err) = d1_repositories::add_abilities_for_channel(
        &db,
        channel_id,
        payload.models.as_deref().unwrap_or(""),
        payload.group.as_deref().unwrap_or("default"),
        payload.status.unwrap_or(1),
        payload.priority.unwrap_or(0),
        payload.weight.unwrap_or(0),
    )
    .await
    {
        worker::console_warn!(
            "create_channel: abilities sync failed for channel {channel_id}: {err}"
        );
    }
    let _ = invalidate_channel_cache(&env).await;
    let channel_name = name.to_string();
    let channel_type = payload.kind;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.create",
        &format!(
            "admin {} created channel {} (type {})",
            claims.username, channel_name, channel_type
        ),
        &serde_json::json!({"name": channel_name, "type": channel_type, "id": channel_id}),
        &crate::admin::admin_audit_info(&claims, &req),
        now,
    )
    .await;
    Ok(envelope_ok_response(&ChannelCreateResult {
        id: channel_id,
    })?)
}

/// `PUT /api/channel/`: update a channel. AdminAuth.
pub async fn update_channel(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ChannelUpdateRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid channel update request: {err}"),
            ));
        }
    };
    let id = payload.id;
    let db = env.d1("DB")?;
    let updated = d1_repositories::update_channel(
        &db,
        UpdateChannel {
            id,
            kind: payload.kind,
            key: payload.key.as_deref(),
            name: payload.name.as_deref(),
            base_url: payload.base_url.as_deref(),
            models: payload.models.as_deref(),
            group: payload.group.as_deref(),
            model_mapping: payload.model_mapping.as_ref().map(|o| o.as_deref()),
            priority: payload.priority,
            weight: payload.weight,
            status: payload.status,
            auto_ban: payload.auto_ban,
            tag: payload.tag.as_ref().map(|o| o.as_deref()),
            other: payload.other.as_deref(),
            status_code_mapping: payload.status_code_mapping.as_deref(),
            other_info: payload.other_info.as_deref(),
            setting: payload.setting.as_ref().map(|o| o.as_deref()),
            param_override: payload.param_override.as_ref().map(|o| o.as_deref()),
            header_override: payload.header_override.as_ref().map(|o| o.as_deref()),
            remark: payload.remark.as_ref().map(|o| o.as_deref()),
            openai_organization: payload.openai_organization.as_ref().map(|o| o.as_deref()),
            test_model: payload.test_model.as_ref().map(|o| o.as_deref()),
        },
    )
    .await?;
    if !updated {
        return Ok(envelope_error_response(
            404,
            "channel not found or no fields to update",
        ));
    }
    // Rebuild abilities from the post-update channel state.
    if let Some(row) = d1_repositories::find_channel_by_id(&db, id).await? {
        if let Err(err) = d1_repositories::update_abilities_for_channel(
            &db,
            id,
            &row.models,
            &row.channel_group,
            row.status,
            row.priority,
            row.weight,
        )
        .await
        {
            worker::console_warn!(
                "update_channel: abilities rebuild failed for channel {id}: {err}"
            );
        }
    }
    let _ = invalidate_channel_cache(&env).await;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.update",
        &format!("admin {} updated channel {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&Value::Null)?)
}

/// `DELETE /api/channel/:id`: hard-delete a channel + its abilities. AdminAuth.
pub async fn delete_channel(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let id = match parse_id_param(id_param) {
        Some(id) => id,
        None => return Ok(envelope_error_response(400, "channel id is required")),
    };
    let db = env.d1("DB")?;
    if let Err(err) = d1_repositories::delete_abilities_for_channel(&db, id).await {
        worker::console_warn!("delete_channel: abilities cleanup failed for channel {id}: {err}");
    }
    let deleted = d1_repositories::delete_channel(&db, id).await?;
    if !deleted {
        return Ok(envelope_error_response(404, "channel not found"));
    }
    let _ = invalidate_channel_cache(&env).await;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.delete",
        &format!("admin {} deleted channel {}", claims.username, id),
        &serde_json::json!({"id": id}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&Value::Null)?)
}

/// `POST /api/channel/batch`: hard-delete multiple channels + abilities. AdminAuth.
pub async fn delete_channels_batch(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ChannelBatchDeleteRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid channel batch delete request: {err}"),
            ));
        }
    };
    if payload.ids.is_empty() {
        return Ok(envelope_ok_response(&ChannelBatchDeleteResult {
            count: 0,
        })?);
    }
    let db = env.d1("DB")?;
    // Clean up abilities for each id first (best-effort).
    for id in &payload.ids {
        let _ = d1_repositories::delete_abilities_for_channel(&db, *id).await;
    }
    let count = d1_repositories::delete_channels_batch(&db, &payload.ids).await?;
    let _ = invalidate_channel_cache(&env).await;
    let deleted_count = count;
    let _ = crate::d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.delete_batch",
        &format!(
            "admin {} batch-deleted {} channels",
            claims.username, deleted_count
        ),
        &serde_json::json!({"count": deleted_count}),
        &crate::admin::admin_audit_info(&claims, &req),
        crate::admin::unix_timestamp(),
    )
    .await;
    Ok(envelope_ok_response(&ChannelBatchDeleteResult {
        count: count as i64,
    })?)
}

/// `POST /api/channel/batch/tag`: set or clear the tag on selected channels.
/// Returns the number of requested ids, matching Go's frontend contract.
pub async fn batch_set_channel_tag(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ChannelBatchTagRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid channel batch tag request: {err}"),
            ));
        }
    };
    if let Err(message) = validate_batch_tag_ids(&payload.ids) {
        return Ok(envelope_error_response(400, message));
    }

    let db = env.d1("DB")?;
    let requested_count = payload.ids.len();
    let updated_count =
        d1_repositories::set_channels_tag_batch(&db, &payload.ids, payload.tag.as_deref()).await?;
    invalidate_channel_cache(&env).await?;
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.tag_batch_set",
        &format!(
            "admin {} batch-set tags on {} channels",
            claims.username, requested_count
        ),
        &serde_json::json!({
            "count": requested_count,
            "updated_count": updated_count
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;
    envelope_ok_response(&requested_count)
}

/// `GET /api/channel/tag/models?tag=...`: return the original models CSV from
/// the same-tag channel with the most comma-separated items. AdminAuth.
pub async fn get_tag_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(tag) = parse_query_string(&req, "tag") else {
        return Ok(envelope_error_response(400, "tag must not be empty"));
    };
    let db = env.d1("DB")?;
    let models = d1_repositories::longest_channel_models_by_tag(&db, &tag).await?;
    envelope_ok_response(&models)
}

/// `POST /api/channel/fix`: rebuild the entire abilities table. AdminAuth.
pub async fn fix_abilities(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let _ = claims;
    let db = env.d1("DB")?;
    let (success, fails) = d1_repositories::fix_abilities(&db).await?;
    let _ = invalidate_channel_cache(&env).await;
    Ok(envelope_ok_response(&FixAbilitiesResult {
        success,
        fails,
    })?)
}

// ---------------------------------------------------------------------------
// Helpers and DTOs
// ---------------------------------------------------------------------------

const CHANNEL_OUTBOUND_TIMEOUT: Duration = Duration::from_secs(15);
const CHANNEL_BALANCE_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const MULTI_KEY_PAGE_SIZE_MAX: i64 = 200;

#[derive(Debug, Serialize)]
struct ChannelBalanceResponse<'a> {
    success: bool,
    message: &'a str,
    balance: f64,
}

#[derive(Debug, Deserialize)]
struct MultiKeyManageRequest {
    channel_id: i64,
    action: String,
    #[serde(default)]
    key_index: Option<i64>,
    #[serde(default)]
    page: i64,
    #[serde(default)]
    page_size: i64,
    #[serde(default)]
    status: Option<i32>,
}

#[derive(Debug, Serialize, PartialEq)]
struct MultiKeyStatusData {
    keys: Vec<MultiKeyStatus>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
    enabled_count: usize,
    manual_disabled_count: usize,
    auto_disabled_count: usize,
}

#[derive(Debug, Serialize, PartialEq)]
struct MultiKeyStatus {
    index: usize,
    status: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    key_preview: &'static str,
}

enum MultiKeyOperation {
    Read(MultiKeyStatusData),
    Write(MultiKeyWrite),
}

struct MultiKeyWrite {
    key: String,
    channel_info: String,
    message: &'static str,
    data: Option<Value>,
}

#[derive(Debug, PartialEq)]
struct MultiKeyActionError {
    status: u16,
    message: String,
}

impl MultiKeyActionError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn parse_channel_info(raw: &str) -> Result<Map<String, Value>, String> {
    let value: Value = serde_json::from_str(if raw.trim().is_empty() { "{}" } else { raw })
        .map_err(|_| "channel_info is not valid JSON".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "channel_info must be a JSON object".to_string())
}

fn is_multi_key_info(info: &Map<String, Value>) -> bool {
    info.get("is_multi_key")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_multi_keys(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        return Vec::new();
    }
    let trimmed = raw.trim();
    if trimmed.starts_with('[') {
        if let Ok(values) = serde_json::from_str::<Vec<Value>>(trimmed) {
            return values.into_iter().map(|value| value.to_string()).collect();
        }
    }
    raw.trim_matches('\n')
        .split('\n')
        .map(str::to_string)
        .collect()
}

fn indexed_i32_map(value: Option<&Value>) -> BTreeMap<usize, i32> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(index, value)| {
                    let value = value.as_i64()?;
                    Some((index.parse::<usize>().ok()?, i32::try_from(value).ok()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn indexed_i64_map(value: Option<&Value>) -> BTreeMap<usize, i64> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(index, value)| Some((index.parse::<usize>().ok()?, value.as_i64()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn indexed_string_map(value: Option<&Value>) -> BTreeMap<usize, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(index, value)| {
                    Some((index.parse::<usize>().ok()?, value.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn store_multi_key_state(
    info: &mut Map<String, Value>,
    key_count: usize,
    statuses: &BTreeMap<usize, i32>,
    disabled_times: &BTreeMap<usize, i64>,
    disabled_reasons: &BTreeMap<usize, String>,
) {
    info.insert(
        "multi_key_size".to_string(),
        Value::Number((key_count as u64).into()),
    );
    info.insert(
        "multi_key_status_list".to_string(),
        serde_json::to_value(statuses).unwrap_or_else(|_| serde_json::json!({})),
    );
    info.insert(
        "multi_key_disabled_time".to_string(),
        serde_json::to_value(disabled_times).unwrap_or_else(|_| serde_json::json!({})),
    );
    info.insert(
        "multi_key_disabled_reason".to_string(),
        serde_json::to_value(disabled_reasons).unwrap_or_else(|_| serde_json::json!({})),
    );
}

fn require_key_index(
    request: &MultiKeyManageRequest,
    key_count: usize,
) -> Result<usize, MultiKeyActionError> {
    let index = request
        .key_index
        .ok_or_else(|| MultiKeyActionError::new(400, "key_index is required"))?;
    let index = usize::try_from(index)
        .map_err(|_| MultiKeyActionError::new(400, "key_index is out of range"))?;
    if index >= key_count {
        return Err(MultiKeyActionError::new(400, "key_index is out of range"));
    }
    Ok(index)
}

fn apply_multi_key_action(
    raw_key: &str,
    raw_channel_info: &str,
    request: &MultiKeyManageRequest,
) -> Result<MultiKeyOperation, MultiKeyActionError> {
    let mut info = parse_channel_info(raw_channel_info)
        .map_err(|message| MultiKeyActionError::new(500, message))?;
    if !is_multi_key_info(&info) {
        return Err(MultiKeyActionError::new(
            422,
            "channel is not in multi-key mode",
        ));
    }

    let mut keys = parse_multi_keys(raw_key);
    let mut statuses = indexed_i32_map(info.get("multi_key_status_list"));
    let mut disabled_times = indexed_i64_map(info.get("multi_key_disabled_time"));
    let mut disabled_reasons = indexed_string_map(info.get("multi_key_disabled_reason"));
    statuses.retain(|index, _| *index < keys.len());
    disabled_times.retain(|index, _| *index < keys.len());
    disabled_reasons.retain(|index, _| *index < keys.len());

    if request.action == "get_key_status" {
        if let Some(status) = request.status {
            if !matches!(status, 1..=3) {
                return Err(MultiKeyActionError::new(400, "status must be 1, 2, or 3"));
            }
        }
        let mut enabled_count = 0;
        let mut manual_disabled_count = 0;
        let mut auto_disabled_count = 0;
        let mut filtered = Vec::new();
        for index in 0..keys.len() {
            let status = statuses.get(&index).copied().unwrap_or(1);
            match status {
                1 => enabled_count += 1,
                2 => manual_disabled_count += 1,
                3 => auto_disabled_count += 1,
                _ => {}
            }
            if request.status.is_some_and(|filter| filter != status) {
                continue;
            }
            filtered.push(MultiKeyStatus {
                index,
                status,
                disabled_time: (status != 1)
                    .then(|| disabled_times.get(&index).copied())
                    .flatten(),
                reason: (status != 1)
                    .then(|| disabled_reasons.get(&index).cloned())
                    .flatten(),
                key_preview: "********",
            });
        }
        let page_size = if request.page_size <= 0 {
            50
        } else {
            request.page_size.min(MULTI_KEY_PAGE_SIZE_MAX)
        } as usize;
        let total = filtered.len();
        let total_pages = total.div_ceil(page_size).max(1);
        let requested_page = if request.page <= 0 {
            1
        } else {
            request.page as usize
        };
        let page = requested_page.min(total_pages);
        let start = (page - 1) * page_size;
        let keys = filtered.into_iter().skip(start).take(page_size).collect();
        return Ok(MultiKeyOperation::Read(MultiKeyStatusData {
            keys,
            total,
            page,
            page_size,
            total_pages,
            enabled_count,
            manual_disabled_count,
            auto_disabled_count,
        }));
    }

    let (new_key, message, data) = match request.action.as_str() {
        "disable_key" => {
            let index = require_key_index(request, keys.len())?;
            statuses.insert(index, 2);
            (raw_key.to_string(), "key disabled", None)
        }
        "enable_key" => {
            let index = require_key_index(request, keys.len())?;
            statuses.remove(&index);
            disabled_times.remove(&index);
            disabled_reasons.remove(&index);
            (raw_key.to_string(), "key enabled", None)
        }
        "enable_all_keys" => {
            let changed = (0..keys.len())
                .filter(|index| statuses.get(index).copied().unwrap_or(1) != 1)
                .count();
            statuses.clear();
            disabled_times.clear();
            disabled_reasons.clear();
            (
                raw_key.to_string(),
                "all keys enabled",
                Some(serde_json::json!(changed)),
            )
        }
        "disable_all_keys" => {
            let mut changed = 0usize;
            for index in 0..keys.len() {
                if statuses.get(&index).copied().unwrap_or(1) == 1 {
                    statuses.insert(index, 2);
                    changed += 1;
                }
            }
            if changed == 0 {
                return Err(MultiKeyActionError::new(409, "no enabled keys to disable"));
            }
            (
                raw_key.to_string(),
                "all keys disabled",
                Some(serde_json::json!(changed)),
            )
        }
        "delete_key" => {
            let deleted = require_key_index(request, keys.len())?;
            if keys.len() == 1 {
                return Err(MultiKeyActionError::new(409, "cannot delete the last key"));
            }
            let (new_statuses, new_times, new_reasons) = reindex_multi_key_maps(
                keys.len(),
                |index| index != deleted,
                &statuses,
                &disabled_times,
                &disabled_reasons,
            );
            keys.remove(deleted);
            statuses = new_statuses;
            disabled_times = new_times;
            disabled_reasons = new_reasons;
            (keys.join("\n"), "key deleted", None)
        }
        "delete_disabled_keys" => {
            let keep = |index: usize| statuses.get(&index).copied().unwrap_or(1) != 3;
            let deleted = (0..keys.len()).filter(|index| !keep(*index)).count();
            if deleted == 0 {
                return Err(MultiKeyActionError::new(
                    409,
                    "no auto-disabled keys to delete",
                ));
            }
            let (new_statuses, new_times, new_reasons) = reindex_multi_key_maps(
                keys.len(),
                keep,
                &statuses,
                &disabled_times,
                &disabled_reasons,
            );
            keys = keys
                .into_iter()
                .enumerate()
                .filter_map(|(index, key)| keep(index).then_some(key))
                .collect();
            statuses = new_statuses;
            disabled_times = new_times;
            disabled_reasons = new_reasons;
            (
                keys.join("\n"),
                "auto-disabled keys deleted",
                Some(serde_json::json!(deleted)),
            )
        }
        _ => {
            return Err(MultiKeyActionError::new(
                400,
                "unsupported multi-key action",
            ));
        }
    };

    store_multi_key_state(
        &mut info,
        keys.len(),
        &statuses,
        &disabled_times,
        &disabled_reasons,
    );
    let channel_info = serde_json::to_string(&info)
        .map_err(|_| MultiKeyActionError::new(500, "failed to encode channel_info"))?;
    Ok(MultiKeyOperation::Write(MultiKeyWrite {
        key: new_key,
        channel_info,
        message,
        data,
    }))
}

fn reindex_multi_key_maps<F>(
    key_count: usize,
    keep: F,
    statuses: &BTreeMap<usize, i32>,
    disabled_times: &BTreeMap<usize, i64>,
    disabled_reasons: &BTreeMap<usize, String>,
) -> (
    BTreeMap<usize, i32>,
    BTreeMap<usize, i64>,
    BTreeMap<usize, String>,
)
where
    F: Fn(usize) -> bool,
{
    let mut new_statuses = BTreeMap::new();
    let mut new_times = BTreeMap::new();
    let mut new_reasons = BTreeMap::new();
    let mut new_index = 0usize;
    for old_index in 0..key_count {
        if !keep(old_index) {
            continue;
        }
        if let Some(status) = statuses
            .get(&old_index)
            .copied()
            .filter(|status| *status != 1)
        {
            new_statuses.insert(new_index, status);
        }
        if let Some(disabled_time) = disabled_times.get(&old_index) {
            new_times.insert(new_index, *disabled_time);
        }
        if let Some(reason) = disabled_reasons.get(&old_index) {
            new_reasons.insert(new_index, reason.clone());
        }
        new_index += 1;
    }
    (new_statuses, new_times, new_reasons)
}

#[derive(Clone, Copy)]
enum BalanceAuth {
    Bearer,
    ApiKey,
}

async fn fetch_channel_balance(
    db: &worker::D1Database,
    channel: &ChannelRow,
) -> Result<f64, String> {
    match channel.kind {
        1 | 8 => fetch_openai_compatible_balance(channel).await,
        10 => {
            let value = fetch_balance_json(
                "https://aiproxy.io/api/report/getUserOverview",
                &channel.key,
                BalanceAuth::ApiKey,
            )
            .await?;
            if value.get("success").and_then(Value::as_bool) != Some(true) {
                return Err("upstream rejected the balance query".to_string());
            }
            required_number(&value, "/data/totalPoints")
        }
        12 => {
            let value = fetch_balance_json(
                "https://api.api2gpt.com/dashboard/billing/credit_grants",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            required_number(&value, "/total_remaining")
        }
        13 => {
            let value = fetch_balance_json(
                "https://api.aigc2d.com/dashboard/billing/credit_grants",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            required_number(&value, "/total_available")
        }
        20 => {
            let value = fetch_balance_json(
                "https://openrouter.ai/api/v1/credits",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            Ok(required_number(&value, "/data/total_credits")?
                - required_number(&value, "/data/total_usage")?)
        }
        25 => {
            let value = fetch_balance_json(
                "https://api.moonshot.cn/v1/users/me/balance",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            if value.get("status").and_then(Value::as_bool) != Some(true)
                || value.get("code").and_then(Value::as_i64) != Some(0)
            {
                return Err("upstream rejected the balance query".to_string());
            }
            let cny = required_number(&value, "/data/available_balance")?;
            let price = d1_repositories::get_option(db, "Price")
                .await
                .map_err(|_| "failed to load the balance exchange rate".to_string())?
                .as_deref()
                .unwrap_or("7.3")
                .trim()
                .parse::<f64>()
                .map_err(|_| "balance exchange rate is invalid".to_string())?;
            if !price.is_finite() || price <= 0.0 {
                return Err("balance exchange rate must be positive".to_string());
            }
            Ok(cny / price)
        }
        40 => {
            let value = fetch_balance_json(
                "https://api.siliconflow.cn/v1/user/info",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            if value.get("code").and_then(Value::as_i64) != Some(20_000) {
                return Err("upstream rejected the balance query".to_string());
            }
            required_number(&value, "/data/totalBalance")
        }
        43 => {
            let value = fetch_balance_json(
                "https://api.deepseek.com/user/balance",
                &channel.key,
                BalanceAuth::Bearer,
            )
            .await?;
            value
                .get("balance_infos")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("currency").and_then(Value::as_str) == Some("CNY"))
                })
                .ok_or_else(|| "upstream response has no CNY balance".to_string())
                .and_then(|item| required_number(item, "/total_balance"))
        }
        _ => Err(format!(
            "balance query is not supported for channel type {}",
            channel.kind
        )),
    }
}

async fn fetch_openai_compatible_balance(channel: &ChannelRow) -> Result<f64, String> {
    let base_url = if channel.base_url.trim().is_empty() {
        if channel.kind == 1 {
            "https://api.openai.com"
        } else {
            return Err("custom channels require base_url for balance queries".to_string());
        }
    } else {
        channel.base_url.trim()
    };
    let subscription_url = validated_channel_url(base_url, "/v1/dashboard/billing/subscription")?;
    let subscription =
        fetch_balance_json(&subscription_url, &channel.key, BalanceAuth::Bearer).await?;
    let hard_limit = required_number(&subscription, "/hard_limit_usd")?;
    let has_payment_method = subscription
        .get("has_payment_method")
        .and_then(Value::as_bool)
        .ok_or_else(|| "upstream subscription response is incomplete".to_string())?;
    let (start_date, end_date) = openai_usage_dates(has_payment_method)?;
    let usage_url = validated_channel_url(
        base_url,
        &format!("/v1/dashboard/billing/usage?start_date={start_date}&end_date={end_date}"),
    )?;
    let usage = fetch_balance_json(&usage_url, &channel.key, BalanceAuth::Bearer).await?;
    Ok(hard_limit - required_number(&usage, "/total_usage")? / 100.0)
}

fn openai_usage_dates(has_payment_method: bool) -> Result<(String, String), String> {
    let now = js_sys::Date::now();
    let end_date = iso_date(now)?;
    let start_date = if has_payment_method {
        format!("{}-01", &end_date[..7])
    } else {
        iso_date(now - 100.0 * 86_400_000.0)?
    };
    Ok((start_date, end_date))
}

fn iso_date(milliseconds: f64) -> Result<String, String> {
    let date = js_sys::Date::new(&JsValue::from_f64(milliseconds));
    let iso = date
        .to_iso_string()
        .as_string()
        .ok_or_else(|| "failed to format billing date".to_string())?;
    iso.get(..10)
        .map(str::to_string)
        .ok_or_else(|| "failed to format billing date".to_string())
}

fn validated_channel_url(base_url: &str, suffix: &str) -> Result<String, String> {
    let raw = format!("{}{}", base_url.trim_end_matches('/'), suffix);
    validate_channel_outbound_url(&raw)?;
    Ok(raw)
}

fn validate_channel_outbound_url(raw: &str) -> Result<(), String> {
    let parsed = worker::Url::parse(raw).map_err(|_| "channel URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("channel URL scheme is not allowed".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("channel URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("channel URL must not contain a fragment".to_string());
    }
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "channel URL port is invalid".to_string())?;
    if !matches!(port, 80 | 443) {
        return Err("channel URL port is not allowed".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "channel URL is missing a host".to_string())?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "localhost" | "metadata.google.internal" | "metadata.internal"
    ) || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("channel URL host is not allowed".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_or_special_ip(ip) {
            return Err("channel URL IP address is not allowed".to_string());
        }
    }
    Ok(())
}

fn is_private_or_special_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_or_special_ipv4(ip),
        IpAddr::V6(ip) => is_private_or_special_ipv6(ip),
    }
}

fn is_private_or_special_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && matches!(c, 0 | 2))
        || (a == 192 && b == 168)
        || (a == 198 && matches!(b, 18 | 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn is_private_or_special_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4() {
        return is_private_or_special_ipv4(v4);
    }
    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x64 && segments[1] == 0xff9b)
        || (segments[0] == 0x100 && segments[1] == 0)
        || (segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0)
}

async fn fetch_balance_json(url: &str, key: &str, auth: BalanceAuth) -> Result<Value, String> {
    validate_channel_outbound_url(url)?;
    let mut headers = worker::Headers::new();
    let header_value = match auth {
        BalanceAuth::Bearer => format!("Bearer {key}"),
        BalanceAuth::ApiKey => key.to_string(),
    };
    headers
        .set(
            match auth {
                BalanceAuth::Bearer => "Authorization",
                BalanceAuth::ApiKey => "Api-Key",
            },
            &header_value,
        )
        .map_err(|_| "channel key is not valid for an HTTP header".to_string())?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| "failed to build upstream request".to_string())?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init)
        .map_err(|_| "failed to build upstream request".to_string())?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = worker::Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(CHANNEL_OUTBOUND_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|_| "upstream balance request failed".to_string())?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err("upstream balance request timed out".to_string());
        }
    };
    if !(200..300).contains(&response.status_code()) {
        return Err(format!(
            "upstream balance request returned status {}",
            response.status_code()
        ));
    }
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|_| "failed to inspect upstream response headers".to_string())?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err("upstream balance response is not JSON".to_string());
    }
    if response
        .headers()
        .get("Content-Length")
        .map_err(|_| "failed to inspect upstream response headers".to_string())?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > CHANNEL_BALANCE_BODY_LIMIT_BYTES)
    {
        return Err("upstream balance response exceeds 1 MiB limit".to_string());
    }
    let bytes = response
        .stream()
        .map_err(|_| "failed to read upstream balance response".to_string())?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > CHANNEL_BALANCE_BODY_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "upstream balance response exceeds 1 MiB limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "upstream balance response is not valid JSON".to_string())
}

fn required_number(value: &Value, pointer: &str) -> Result<f64, String> {
    let candidate = value
        .pointer(pointer)
        .ok_or_else(|| "upstream balance response is incomplete".to_string())?;
    let number = candidate
        .as_f64()
        .or_else(|| candidate.as_str().and_then(|raw| raw.trim().parse().ok()))
        .ok_or_else(|| "upstream balance response contains an invalid number".to_string())?;
    if number.is_finite() {
        Ok(number)
    } else {
        Err("upstream balance response contains an invalid number".to_string())
    }
}

fn parse_channel_filter(req: &Request) -> ChannelFilter {
    ChannelFilter {
        group: parse_query_string(req, "group"),
        status: parse_query_i32(req, "status"),
        kind: parse_query_i32(req, "type"),
        tag_mode: parse_query_string(req, "tag_mode"),
    }
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let page = parse_query_u32(req, "p").unwrap_or(1).max(1);
    let page_size = parse_query_u32(req, "page_size")
        .unwrap_or(10)
        .clamp(1, 100);
    (page, page_size)
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let pair = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if pair.is_empty() {
        None
    } else {
        Some(pair)
    }
}

fn parse_query_i32(req: &Request, key: &str) -> Option<i32> {
    parse_query_string(req, key)?.parse::<i32>().ok()
}

fn parse_query_u32(req: &Request, key: &str) -> Option<u32> {
    parse_query_string(req, key)?.parse::<u32>().ok()
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse::<i64>().ok()
}

/// Response shape with `key` cleared (Go behavior: never return upstream key
/// in list/get responses; reveal is a separate RootAuth route).
#[derive(Debug, Serialize)]
struct ChannelResponse {
    id: i64,
    #[serde(rename = "type")]
    kind: i32,
    key: String,
    openai_organization: Option<String>,
    test_model: Option<String>,
    status: i32,
    name: String,
    weight: i32,
    created_time: i64,
    test_time: i64,
    response_time: i64,
    base_url: String,
    other: String,
    balance: f64,
    balance_updated_time: i64,
    models: String,
    #[serde(rename = "group")]
    channel_group: String,
    used_quota: i64,
    model_mapping: Option<String>,
    status_code_mapping: String,
    priority: i32,
    auto_ban: i32,
    other_info: String,
    tag: Option<String>,
    setting: Option<String>,
    param_override: Option<String>,
    header_override: Option<String>,
    remark: Option<String>,
    channel_info: String,
    settings: String,
}

fn channel_response_no_key(row: ChannelRow) -> ChannelResponse {
    ChannelResponse {
        id: row.id,
        kind: row.kind,
        key: String::new(),
        openai_organization: row.openai_organization,
        test_model: row.test_model,
        status: row.status,
        name: row.name,
        weight: row.weight,
        created_time: row.created_time,
        test_time: row.test_time,
        response_time: row.response_time,
        base_url: row.base_url,
        other: row.other,
        balance: row.balance,
        balance_updated_time: row.balance_updated_time,
        models: row.models,
        channel_group: row.channel_group,
        used_quota: row.used_quota,
        model_mapping: row.model_mapping,
        status_code_mapping: row.status_code_mapping,
        priority: row.priority,
        auto_ban: row.auto_ban,
        other_info: row.other_info,
        tag: row.tag,
        setting: row.setting,
        param_override: row.param_override,
        header_override: row.header_override,
        remark: row.remark,
        channel_info: row.channel_info,
        settings: row.settings,
    }
}

#[derive(Debug, Serialize)]
struct ChannelsPage {
    items: Vec<ChannelResponse>,
    total: i64,
    page: u32,
    page_size: u32,
    type_counts: Vec<d1_repositories::TypeCount>,
}

#[derive(Debug, Serialize)]
struct ChannelCreateResult {
    id: i64,
}

#[derive(Debug, Serialize)]
struct ChannelBatchDeleteResult {
    count: i64,
}

#[derive(Debug, Serialize)]
struct FixAbilitiesResult {
    success: usize,
    fails: usize,
}

#[derive(Debug, Deserialize)]
struct ChannelCreateRequest {
    #[serde(rename = "type")]
    kind: i32,
    key: String,
    name: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    models: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    model_mapping: Option<String>,
    #[serde(default)]
    priority: Option<i32>,
    #[serde(default)]
    weight: Option<i32>,
    #[serde(default)]
    status: Option<i32>,
    #[serde(default)]
    auto_ban: Option<i32>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    openai_organization: Option<String>,
    #[serde(default)]
    test_model: Option<String>,
    #[serde(default)]
    other: Option<String>,
    #[serde(default)]
    status_code_mapping: Option<String>,
    #[serde(default)]
    other_info: Option<String>,
    #[serde(default)]
    setting: Option<String>,
    #[serde(default)]
    param_override: Option<String>,
    #[serde(default)]
    header_override: Option<String>,
    #[serde(default)]
    remark: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChannelUpdateRequest {
    id: i64,
    #[serde(default, rename = "type")]
    kind: Option<i32>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    models: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    model_mapping: Option<Option<String>>,
    #[serde(default)]
    priority: Option<i32>,
    #[serde(default)]
    weight: Option<i32>,
    #[serde(default)]
    status: Option<i32>,
    #[serde(default)]
    auto_ban: Option<i32>,
    #[serde(default)]
    tag: Option<Option<String>>,
    #[serde(default)]
    other: Option<String>,
    #[serde(default)]
    status_code_mapping: Option<String>,
    #[serde(default)]
    other_info: Option<String>,
    #[serde(default)]
    setting: Option<Option<String>>,
    #[serde(default)]
    param_override: Option<Option<String>>,
    #[serde(default)]
    header_override: Option<Option<String>>,
    #[serde(default)]
    remark: Option<Option<String>>,
    #[serde(default)]
    openai_organization: Option<Option<String>>,
    #[serde(default)]
    test_model: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct ChannelBatchDeleteRequest {
    ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct ChannelBatchTagRequest {
    ids: Vec<i64>,
    #[serde(default)]
    tag: Option<String>,
}

fn validate_batch_tag_ids(ids: &[i64]) -> Result<(), &'static str> {
    if ids.is_empty() {
        return Err("channel ids must not be empty");
    }
    if ids.iter().any(|id| *id <= 0 || *id > i32::MAX as i64) {
        return Err("channel ids must be positive 32-bit integers");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_validation_requires_json_or_blank() {
        // None / blank -> Ok (blank normalized).
        assert_eq!(validate_override(&None, "x").unwrap(), None);
        assert_eq!(
            validate_override(&Some("   ".to_string()), "x").unwrap(),
            Some(String::new())
        );
        // Valid JSON -> Ok (trimmed).
        assert_eq!(
            validate_override(&Some(" {\"a\":1} ".to_string()), "x").unwrap(),
            Some("{\"a\":1}".to_string())
        );
        // Invalid JSON -> Err.
        assert!(validate_override(&Some("{not json".to_string()), "param_override").is_err());
    }

    #[test]
    fn channel_response_never_exposes_key() {
        let row = ChannelRow {
            id: 1,
            kind: 1,
            key: "sk-secret-upstream-key".to_string(),
            openai_organization: None,
            test_model: None,
            status: 1,
            name: "openai-prod".to_string(),
            weight: 0,
            created_time: 1_700_000_000,
            test_time: 0,
            response_time: 0,
            base_url: "https://api.openai.com".to_string(),
            other: String::new(),
            balance: 0.0,
            balance_updated_time: 0,
            models: "gpt-4o".to_string(),
            channel_group: "default".to_string(),
            used_quota: 0,
            model_mapping: None,
            status_code_mapping: String::new(),
            priority: 0,
            auto_ban: 1,
            other_info: String::new(),
            tag: None,
            setting: None,
            param_override: None,
            header_override: None,
            remark: None,
            channel_info: "{}".to_string(),
            settings: String::new(),
        };
        let resp = channel_response_no_key(row);
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(
            !serialized.contains("sk-secret-upstream-key"),
            "{serialized}"
        );
        assert!(
            serialized.contains("\"key\":\"\""),
            "key should be empty string"
        );
    }

    #[test]
    fn channel_create_request_minimal_fields() {
        let req: ChannelCreateRequest =
            serde_json::from_str(r#"{"type":1,"key":"sk-abc","name":"my channel"}"#).unwrap();
        assert_eq!(req.kind, 1);
        assert_eq!(req.key, "sk-abc");
        assert_eq!(req.name, "my channel");
        assert!(req.models.is_none());
        assert!(req.group.is_none());
        assert!(req.priority.is_none());
    }

    #[test]
    fn channel_update_request_all_optional_except_id() {
        let req: ChannelUpdateRequest = serde_json::from_str(r#"{"id":42}"#).unwrap();
        assert_eq!(req.id, 42);
        assert!(req.kind.is_none());
        assert!(req.key.is_none());
        assert!(req.tag.is_none());
    }

    #[test]
    fn channel_update_request_distinguishes_set_and_omit_for_optional_fields() {
        // Omitting an optional field → `None` (do not modify).
        let req: ChannelUpdateRequest = serde_json::from_str(r#"{"id":1}"#).unwrap();
        assert_eq!(req.tag, None);

        // Providing a concrete value → `Some(Some(value))` (set the field).
        let req: ChannelUpdateRequest = serde_json::from_str(r#"{"id":1,"tag":"prod"}"#).unwrap();
        assert_eq!(req.tag, Some(Some("prod".to_string())));

        // NOTE: explicit `"tag":null` currently deserializes to `None` (do
        // not modify) rather than `Some(None)` (clear), because serde's
        // default Option deserialization treats `null` as absence. Clearing
        // an optional field via update is a Tier 2 follow-up; for now admins
        // must set such fields to an empty string to clear them.
        let req: ChannelUpdateRequest = serde_json::from_str(r#"{"id":1,"tag":null}"#).unwrap();
        assert_eq!(req.tag, None);
    }

    #[test]
    fn channel_batch_delete_request_parses_ids() {
        let req: ChannelBatchDeleteRequest = serde_json::from_str(r#"{"ids":[1,2,3]}"#).unwrap();
        assert_eq!(req.ids, vec![1, 2, 3]);
    }

    #[test]
    fn channel_batch_tag_request_accepts_value_and_null() {
        let req: ChannelBatchTagRequest =
            serde_json::from_str(r#"{"ids":[1,2],"tag":"prod"}"#).unwrap();
        assert_eq!(req.ids, vec![1, 2]);
        assert_eq!(req.tag.as_deref(), Some("prod"));

        let req: ChannelBatchTagRequest =
            serde_json::from_str(r#"{"ids":[3],"tag":null}"#).unwrap();
        assert_eq!(req.tag, None);
    }

    #[test]
    fn channel_batch_tag_ids_must_be_nonempty_positive_i32_values() {
        assert!(validate_batch_tag_ids(&[1, i32::MAX as i64]).is_ok());
        assert!(validate_batch_tag_ids(&[]).is_err());
        assert!(validate_batch_tag_ids(&[0]).is_err());
        assert!(validate_batch_tag_ids(&[-1]).is_err());
        assert!(validate_batch_tag_ids(&[i32::MAX as i64 + 1]).is_err());
    }

    #[test]
    fn parse_id_param_accepts_numeric_strings() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"  7 ".to_string())), Some(7));
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
        assert_eq!(parse_id_param(None), None);
    }

    fn multi_key_request(action: &str, key_index: Option<i64>) -> MultiKeyManageRequest {
        MultiKeyManageRequest {
            channel_id: 7,
            action: action.to_string(),
            key_index,
            page: 1,
            page_size: 50,
            status: None,
        }
    }

    fn multi_key_info() -> &'static str {
        r#"{
            "is_multi_key":true,
            "multi_key_size":3,
            "multi_key_mode":"polling",
            "future_field":{"keep":true},
            "multi_key_status_list":{"1":2,"2":3},
            "multi_key_disabled_time":{"1":1700000000,"2":1700000001},
            "multi_key_disabled_reason":{"1":"manual","2":"upstream"}
        }"#
    }

    #[test]
    fn multi_key_status_is_compatible_and_never_exposes_keys() {
        let operation = apply_multi_key_action(
            "sk-secret-one\nsk-secret-two\nsk-secret-three",
            multi_key_info(),
            &multi_key_request("get_key_status", None),
        )
        .unwrap();
        let MultiKeyOperation::Read(data) = operation else {
            panic!("expected read operation");
        };
        assert_eq!(data.total, 3);
        assert_eq!(data.enabled_count, 1);
        assert_eq!(data.manual_disabled_count, 1);
        assert_eq!(data.auto_disabled_count, 1);
        assert_eq!(data.keys[0].key_preview, "********");
        assert_eq!(data.keys[1].disabled_time, Some(1_700_000_000));
        let encoded = serde_json::to_string(&data).unwrap();
        assert!(!encoded.contains("sk-secret"));
        assert!(encoded.contains("\"key_preview\":\"********\""));
    }

    #[test]
    fn multi_key_status_filter_and_pagination_match_frontend_contract() {
        let mut request = multi_key_request("get_key_status", None);
        request.status = Some(2);
        request.page = 99;
        request.page_size = 1_000;
        let operation =
            apply_multi_key_action("key-1\nkey-2\nkey-3", multi_key_info(), &request).unwrap();
        let MultiKeyOperation::Read(data) = operation else {
            panic!("expected read operation");
        };
        assert_eq!(data.total, 1);
        assert_eq!(data.page, 1);
        assert_eq!(data.page_size, MULTI_KEY_PAGE_SIZE_MAX as usize);
        assert_eq!(data.total_pages, 1);
        assert_eq!(data.keys[0].index, 1);
    }

    #[test]
    fn delete_multi_key_reindexes_status_and_preserves_unknown_info() {
        let operation = apply_multi_key_action(
            "key-one\nkey-two\nkey-three",
            multi_key_info(),
            &multi_key_request("delete_key", Some(1)),
        )
        .unwrap();
        let MultiKeyOperation::Write(write) = operation else {
            panic!("expected write operation");
        };
        assert_eq!(write.key, "key-one\nkey-three");
        let info: Value = serde_json::from_str(&write.channel_info).unwrap();
        assert_eq!(info["multi_key_size"], 2);
        assert_eq!(info["multi_key_status_list"], serde_json::json!({"1": 3}));
        assert_eq!(
            info["multi_key_disabled_reason"],
            serde_json::json!({"1": "upstream"})
        );
        assert_eq!(info["future_field"], serde_json::json!({"keep": true}));
    }

    #[test]
    fn multi_key_mutation_actions_update_only_compatible_state() {
        let disabled = apply_multi_key_action(
            "key-one\nkey-two\nkey-three",
            multi_key_info(),
            &multi_key_request("disable_key", Some(0)),
        )
        .unwrap();
        let MultiKeyOperation::Write(disabled) = disabled else {
            panic!("expected write operation");
        };
        let info: Value = serde_json::from_str(&disabled.channel_info).unwrap();
        assert_eq!(info["multi_key_status_list"]["0"], 2);

        let enabled = apply_multi_key_action(
            &disabled.key,
            &disabled.channel_info,
            &multi_key_request("enable_key", Some(1)),
        )
        .unwrap();
        let MultiKeyOperation::Write(enabled) = enabled else {
            panic!("expected write operation");
        };
        let info: Value = serde_json::from_str(&enabled.channel_info).unwrap();
        assert!(info["multi_key_status_list"].get("1").is_none());

        let enabled_all = apply_multi_key_action(
            &enabled.key,
            &enabled.channel_info,
            &multi_key_request("enable_all_keys", None),
        )
        .unwrap();
        let MultiKeyOperation::Write(enabled_all) = enabled_all else {
            panic!("expected write operation");
        };
        let disable_all = apply_multi_key_action(
            &enabled_all.key,
            &enabled_all.channel_info,
            &multi_key_request("disable_all_keys", None),
        )
        .unwrap();
        let MultiKeyOperation::Write(disable_all) = disable_all else {
            panic!("expected write operation");
        };
        let info: Value = serde_json::from_str(&disable_all.channel_info).unwrap();
        assert_eq!(
            info["multi_key_status_list"],
            serde_json::json!({"0": 2, "1": 2, "2": 2})
        );
    }

    #[test]
    fn delete_auto_disabled_keys_keeps_manual_disabled_keys() {
        let operation = apply_multi_key_action(
            "key-one\nkey-two\nkey-three",
            multi_key_info(),
            &multi_key_request("delete_disabled_keys", None),
        )
        .unwrap();
        let MultiKeyOperation::Write(write) = operation else {
            panic!("expected write operation");
        };
        assert_eq!(write.key, "key-one\nkey-two");
        assert_eq!(write.data, Some(serde_json::json!(1)));
        let info: Value = serde_json::from_str(&write.channel_info).unwrap();
        assert_eq!(info["multi_key_status_list"], serde_json::json!({"1": 2}));
        assert_eq!(info["multi_key_size"], 2);
    }

    #[test]
    fn multi_key_rejects_non_multi_channels_and_unknown_actions() {
        let error = apply_multi_key_action("key", "{}", &multi_key_request("get_key_status", None))
            .err()
            .unwrap();
        assert_eq!(error.status, 422);

        let error = apply_multi_key_action(
            "key-one\nkey-two\nkey-three",
            multi_key_info(),
            &multi_key_request("rotate_keys", None),
        )
        .err()
        .unwrap();
        assert_eq!(error.status, 400);
    }

    #[test]
    fn channel_outbound_url_validation_blocks_ssrf_targets() {
        assert!(validate_channel_outbound_url("https://example.com/v1/balance").is_ok());
        assert!(validate_channel_outbound_url("https://1.1.1.1/v1/balance").is_ok());
        for rejected in [
            "file:///etc/passwd",
            "http://127.0.0.1/balance",
            "http://169.254.169.254/latest/meta-data",
            "https://10.0.0.1/balance",
            "https://[::1]/balance",
            "https://metadata.google.internal/computeMetadata/v1",
            "https://user:secret@example.com/balance",
            "https://example.com:8443/balance",
        ] {
            assert!(
                validate_channel_outbound_url(rejected).is_err(),
                "{rejected} must be rejected"
            );
        }
    }

    #[test]
    fn required_balance_number_accepts_number_or_string_but_not_missing() {
        assert_eq!(
            required_number(
                &serde_json::json!({"data": {"balance": 12.5}}),
                "/data/balance"
            )
            .unwrap(),
            12.5
        );
        assert_eq!(
            required_number(
                &serde_json::json!({"data": {"balance": " 7.25 "}}),
                "/data/balance"
            )
            .unwrap(),
            7.25
        );
        assert!(required_number(&serde_json::json!({}), "/data/balance").is_err());
    }
}
