//! Admin channel CRUD handlers (G5 P0): Tier 1 routes.
//!
//! Mirrors Go `controller/channel.go` Tier 1 surface: list, search, get,
//! create (single mode only), update, delete, batch delete, and fix
//! abilities. Every write operation keeps the `abilities` table in sync so
//! the relay's `select_channels_from_abilities` finds new/edited channels.
//!
//! Tier 2 (key reveal, copy, tag ops, fetch_models, delete disabled) and
//! Tier 3 (test, billing, multi-key, codex, ollama, upstream_updates) are
//! deferred to later batches.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{Env, Request, Response, Result as WorkerResult};

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
    fn parse_id_param_accepts_numeric_strings() {
        assert_eq!(parse_id_param(Some(&"42".to_string())), Some(42));
        assert_eq!(parse_id_param(Some(&"  7 ".to_string())), Some(7));
        assert_eq!(parse_id_param(Some(&"abc".to_string())), None);
        assert_eq!(parse_id_param(None), None);
    }
}
