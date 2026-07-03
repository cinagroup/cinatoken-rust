//! Single-channel upstream model detection and apply operations.
//!
//! Go runs the all-channel variants synchronously. The Worker migration keeps
//! this module deliberately single-channel so each request has bounded
//! outbound work; batch orchestration belongs in Queue/Workflow.

use futures_util::future::{select, Either};
use futures_util::TryStreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::Duration;
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, unix_timestamp,
};
use crate::cache_invalidation::invalidate_channel_cache;
use crate::d1_repositories::{self, ChannelRow};

const CHANNEL_TYPE_OLLAMA: i32 = 4;
const CHANNEL_TYPE_ANTHROPIC: i32 = 14;
const CHANNEL_TYPE_ALI: i32 = 17;
const CHANNEL_TYPE_GEMINI: i32 = 24;
const CHANNEL_TYPE_MOONSHOT: i32 = 25;
const CHANNEL_TYPE_ZHIPU_V4: i32 = 26;
const CHANNEL_TYPE_VOLC_ENGINE: i32 = 45;

const OUTBOUND_TIMEOUT: Duration = Duration::from_secs(15);
const OUTBOUND_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const GEMINI_MAX_PAGES: usize = 10;

const LAST_CHECK_TIME: &str = "upstream_model_update_last_check_time";
const LAST_DETECTED_MODELS: &str = "upstream_model_update_last_detected_models";
const LAST_REMOVED_MODELS: &str = "upstream_model_update_last_removed_models";
const IGNORED_MODELS: &str = "upstream_model_update_ignored_models";

#[derive(Debug, Deserialize, Default)]
struct UpstreamUpdateRequest {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    add_models: Vec<String>,
    #[serde(default)]
    remove_models: Vec<String>,
    #[serde(default)]
    ignore_models: Vec<String>,
}

#[derive(Debug, Serialize)]
struct DetectResult {
    channel_id: i64,
    channel_name: String,
    add_models: Vec<String>,
    remove_models: Vec<String>,
    last_check_time: i64,
    auto_added_models: usize,
}

#[derive(Debug, Serialize)]
struct ApplyResult {
    id: i64,
    added_models: Vec<String>,
    removed_models: Vec<String>,
    ignored_models: Vec<String>,
    remaining_models: Vec<String>,
    remaining_remove_models: Vec<String>,
    models: String,
    settings: String,
}

#[derive(Debug)]
pub(crate) enum ModelFetchError {
    Unsupported(String),
    Upstream(String),
}

impl ModelFetchError {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Unsupported(_) => 422,
            Self::Upstream(_) => 502,
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Unsupported(message) | Self::Upstream(message) => message,
        }
    }
}

pub async fn detect(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let payload = match read_payload(&mut req).await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, payload.id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };

    let now = unix_timestamp();
    let mut settings = parse_settings(&channel.settings);
    let upstream_models = match fetch_channel_model_ids(&channel).await {
        Ok(models) => models,
        Err(error) => {
            settings.insert(LAST_CHECK_TIME.to_string(), Value::from(now));
            let next_settings = Value::Object(settings).to_string();
            let persisted = d1_repositories::update_channel_upstream_model_state(
                &db,
                channel.id,
                &channel.models,
                &channel.settings,
                &channel.models,
                &next_settings,
            )
            .await?;
            if !persisted {
                return Ok(envelope_error_response(
                    409,
                    "channel changed during upstream model detection; retry",
                ));
            }
            invalidate_channel_cache(&env).await?;
            return Ok(match error {
                ModelFetchError::Unsupported(message) => envelope_error_response(422, &message),
                ModelFetchError::Upstream(message) => envelope_error_response(502, &message),
            });
        }
    };

    let ignored = settings_models(&settings, IGNORED_MODELS);
    let mapping = parse_model_mapping(channel.model_mapping.as_deref());
    let (add_models, remove_models) = collect_pending_changes(
        &csv_models(&channel.models),
        &upstream_models,
        &ignored,
        &mapping,
    );
    settings.insert(LAST_CHECK_TIME.to_string(), Value::from(now));
    settings.insert(
        LAST_DETECTED_MODELS.to_string(),
        serde_json::to_value(&add_models).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    settings.insert(
        LAST_REMOVED_MODELS.to_string(),
        serde_json::to_value(&remove_models).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    let next_settings = Value::Object(settings).to_string();
    let persisted = d1_repositories::update_channel_upstream_model_state(
        &db,
        channel.id,
        &channel.models,
        &channel.settings,
        &channel.models,
        &next_settings,
    )
    .await?;
    if !persisted {
        return Ok(envelope_error_response(
            409,
            "channel changed during upstream model detection; retry",
        ));
    }
    invalidate_channel_cache(&env).await?;

    envelope_ok_response(&DetectResult {
        channel_id: channel.id,
        channel_name: channel.name,
        add_models,
        remove_models,
        last_check_time: now,
        // Manual detection intentionally does not auto-apply, matching Go.
        auto_added_models: 0,
    })
}

pub async fn apply(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_payload(&mut req).await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, payload.id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };

    let mut settings = parse_settings(&channel.settings);
    let pending_add = settings_models(&settings, LAST_DETECTED_MODELS);
    let pending_remove = settings_models(&settings, LAST_REMOVED_MODELS);
    let added_models = intersect_models(&payload.add_models, &pending_add);
    let ignored_models = intersect_models(&payload.ignore_models, &pending_add);
    let removed_models = subtract_models(
        &intersect_models(&payload.remove_models, &pending_remove),
        &added_models,
    );

    let origin_models = csv_models(&channel.models);
    let next_models = apply_selected_changes(&origin_models, &added_models, &removed_models);
    let models_changed = origin_models != next_models;
    let next_models_csv = next_models.join(",");

    let existing_ignored = settings_models(&settings, IGNORED_MODELS);
    let merged_ignored = subtract_models(
        &merge_models(&existing_ignored, &ignored_models),
        &added_models,
    );
    let remaining_models =
        subtract_models(&pending_add, &merge_models(&added_models, &ignored_models));
    let remaining_remove_models = subtract_models(&pending_remove, &removed_models);
    let now = unix_timestamp();
    settings.insert(
        IGNORED_MODELS.to_string(),
        serde_json::to_value(&merged_ignored).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    settings.insert(
        LAST_DETECTED_MODELS.to_string(),
        serde_json::to_value(&remaining_models).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    settings.insert(
        LAST_REMOVED_MODELS.to_string(),
        serde_json::to_value(&remaining_remove_models).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    settings.insert(LAST_CHECK_TIME.to_string(), Value::from(now));
    let next_settings = Value::Object(settings).to_string();

    let persisted = d1_repositories::update_channel_upstream_model_state(
        &db,
        channel.id,
        &channel.models,
        &channel.settings,
        &next_models_csv,
        &next_settings,
    )
    .await?;
    if !persisted {
        return Ok(envelope_error_response(
            409,
            "channel changed while applying upstream model updates; reload and retry",
        ));
    }

    if models_changed {
        d1_repositories::update_abilities_for_channel(
            &db,
            channel.id,
            &next_models_csv,
            &channel.channel_group,
            channel.status,
            channel.priority,
            channel.weight,
        )
        .await?;
    }
    invalidate_channel_cache(&env).await?;
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.upstream_apply",
        &format!(
            "admin {} applied upstream model changes to channel {}",
            claims.username, channel.id
        ),
        &serde_json::json!({
            "id": channel.id,
            "added_count": added_models.len(),
            "removed_count": removed_models.len(),
            "ignored_count": ignored_models.len()
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    envelope_ok_response(&ApplyResult {
        id: channel.id,
        added_models,
        removed_models,
        ignored_models,
        remaining_models,
        remaining_remove_models,
        models: next_models_csv,
        settings: next_settings,
    })
}

async fn read_payload(req: &mut Request) -> Result<UpstreamUpdateRequest, Response> {
    let body = read_json_body(req).await?;
    let payload: UpstreamUpdateRequest = serde_json::from_value(body)
        .map_err(|_| envelope_error_response(400, "invalid upstream update request"))?;
    if payload.id <= 0 || payload.id > i32::MAX as i64 {
        return Err(envelope_error_response(400, "invalid channel id"));
    }
    Ok(payload)
}

fn parse_settings(raw: &str) -> Map<String, Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Map::new();
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn settings_models(settings: &Map<String, Value>, key: &str) -> Vec<String> {
    settings
        .get(key)
        .and_then(Value::as_array)
        .map(|models| normalize_models(models.iter().filter_map(Value::as_str).map(str::to_string)))
        .unwrap_or_default()
}

fn csv_models(raw: &str) -> Vec<String> {
    normalize_models(raw.split(',').map(str::to_string))
}

fn normalize_models(models: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .filter_map(|model| {
            let model = model.trim().to_string();
            if model.is_empty() || !seen.insert(model.clone()) {
                None
            } else {
                Some(model)
            }
        })
        .collect()
}

fn merge_models(base: &[String], appended: &[String]) -> Vec<String> {
    normalize_models(base.iter().chain(appended).cloned())
}

fn subtract_models(base: &[String], removed: &[String]) -> Vec<String> {
    let removed: HashSet<&str> = removed.iter().map(String::as_str).collect();
    normalize_models(
        base.iter()
            .filter(|model| !removed.contains(model.as_str()))
            .cloned(),
    )
}

fn intersect_models(base: &[String], allowed: &[String]) -> Vec<String> {
    let allowed: HashSet<&str> = allowed.iter().map(String::as_str).collect();
    normalize_models(
        base.iter()
            .filter(|model| allowed.contains(model.as_str()))
            .cloned(),
    )
}

fn apply_selected_changes(
    origin: &[String],
    add_models: &[String],
    remove_models: &[String],
) -> Vec<String> {
    let effective_remove = subtract_models(remove_models, add_models);
    subtract_models(&merge_models(origin, add_models), &effective_remove)
}

fn parse_model_mapping(raw: Option<&str>) -> Map<String, Value> {
    raw.map(str::trim)
        .filter(|raw| !raw.is_empty() && *raw != "{}")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn collect_pending_changes(
    local_models: &[String],
    upstream_models: &[String],
    ignored_models: &[String],
    model_mapping: &Map<String, Value>,
) -> (Vec<String>, Vec<String>) {
    let local: HashSet<&str> = local_models.iter().map(String::as_str).collect();
    let upstream: HashSet<&str> = upstream_models.iter().map(String::as_str).collect();
    let mut redirect_sources = HashSet::new();
    let mut redirect_targets = HashSet::new();
    for (source, target) in model_mapping {
        let source = source.trim();
        let Some(target) = target.as_str().map(str::trim) else {
            continue;
        };
        if !source.is_empty() && !target.is_empty() {
            redirect_sources.insert(source);
            redirect_targets.insert(target);
        }
    }

    let add_models = normalize_models(
        upstream_models
            .iter()
            .filter(|model| {
                !local.contains(model.as_str())
                    && !redirect_targets.contains(model.as_str())
                    && !is_ignored_model(model, ignored_models)
            })
            .cloned(),
    );
    let remove_models = normalize_models(
        local_models
            .iter()
            .filter(|model| {
                !redirect_sources.contains(model.as_str()) && !upstream.contains(model.as_str())
            })
            .cloned(),
    );
    (add_models, remove_models)
}

fn is_ignored_model(model: &str, ignored_models: &[String]) -> bool {
    ignored_models.iter().any(|ignored| {
        if let Some(pattern) = ignored.strip_prefix("regex:").map(str::trim) {
            !pattern.is_empty() && Regex::new(pattern).is_ok_and(|regex| regex.is_match(model))
        } else {
            ignored == model
        }
    })
}

pub(crate) async fn fetch_channel_model_ids(
    channel: &ChannelRow,
) -> Result<Vec<String>, ModelFetchError> {
    if channel.kind == CHANNEL_TYPE_OLLAMA {
        return Err(ModelFetchError::Unsupported(
            "Ollama model detection requires an approved Tunnel, Container, or service binding; direct local-daemon access is disabled"
                .to_string(),
        ));
    }
    let key = channel
        .key
        .lines()
        .map(str::trim)
        .find(|key| !key.is_empty())
        .ok_or_else(|| ModelFetchError::Unsupported("channel key is empty".to_string()))?;

    if channel.kind == CHANNEL_TYPE_GEMINI {
        return fetch_gemini_models(channel, key).await;
    }

    let url = openai_models_url(channel)?;
    let headers = channel_headers(channel, key)?;
    let value = fetch_json(&url, headers).await?;
    parse_openai_model_ids(&value)
}

pub(crate) async fn fetch_openai_probe_model_ids(
    base_url: &str,
    key: &str,
) -> Result<Vec<String>, ModelFetchError> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err(ModelFetchError::Unsupported(
            "base_url is required (per-type default URLs are not supported)".to_string(),
        ));
    }
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    validate_outbound_url(&url).map_err(ModelFetchError::Unsupported)?;
    let mut headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {}", key.trim()))
        .map_err(|_| invalid_header_error())?;
    headers
        .set("Accept", "application/json")
        .map_err(|_| invalid_header_error())?;
    let value = fetch_json(&url, headers).await?;
    parse_openai_model_ids(&value)
}

fn parse_openai_model_ids(value: &Value) -> Result<Vec<String>, ModelFetchError> {
    let entries = value.get("data").and_then(Value::as_array).ok_or_else(|| {
        ModelFetchError::Upstream(
            "upstream models response does not contain a data array".to_string(),
        )
    })?;
    Ok(normalize_models(entries.iter().filter_map(|entry| {
        entry.get("id").and_then(Value::as_str).map(str::to_string)
    })))
}

async fn fetch_gemini_models(
    channel: &ChannelRow,
    key: &str,
) -> Result<Vec<String>, ModelFetchError> {
    let base_url = resolved_base_url(channel)?;
    let mut all_models = Vec::new();
    let mut next_page_token: Option<String> = None;
    for page in 0..GEMINI_MAX_PAGES {
        let mut url =
            worker::Url::parse(&format!("{}/v1beta/models", base_url.trim_end_matches('/')))
                .map_err(|_| ModelFetchError::Unsupported("channel URL is invalid".to_string()))?;
        if let Some(token) = next_page_token.as_deref() {
            url.query_pairs_mut().append_pair("pageToken", token);
        }
        let headers = channel_headers(channel, key)?;
        let value = fetch_json(url.as_str(), headers).await?;
        let models = value
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ModelFetchError::Upstream(
                    "Gemini models response does not contain a models array".to_string(),
                )
            })?;
        all_models.extend(models.iter().filter_map(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.strip_prefix("models/").unwrap_or(name).to_string())
        }));
        next_page_token = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        if next_page_token.is_none() {
            return Ok(normalize_models(all_models));
        }
        if page + 1 == GEMINI_MAX_PAGES {
            return Err(ModelFetchError::Upstream(format!(
                "Gemini model pagination exceeds the {GEMINI_MAX_PAGES}-page Worker limit"
            )));
        }
    }
    Ok(normalize_models(all_models))
}

fn openai_models_url(channel: &ChannelRow) -> Result<String, ModelFetchError> {
    if let Some(special) = special_openai_base(channel.base_url.trim()) {
        let url = format!("{}/models", special.trim_end_matches('/'));
        validate_outbound_url(&url).map_err(ModelFetchError::Unsupported)?;
        return Ok(url);
    }
    let base_url = resolved_base_url(channel)?;
    let suffix = match channel.kind {
        CHANNEL_TYPE_ALI => "/compatible-mode/v1/models",
        CHANNEL_TYPE_ZHIPU_V4 => "/api/paas/v4/models",
        CHANNEL_TYPE_MOONSHOT | CHANNEL_TYPE_VOLC_ENGINE => "/v1/models",
        _ => "/v1/models",
    };
    let url = format!("{}{}", base_url.trim_end_matches('/'), suffix);
    validate_outbound_url(&url).map_err(ModelFetchError::Unsupported)?;
    Ok(url)
}

fn resolved_base_url(channel: &ChannelRow) -> Result<String, ModelFetchError> {
    let configured = channel.base_url.trim();
    if !configured.is_empty() {
        return Ok(configured.to_string());
    }
    default_base_url(channel.kind)
        .map(str::to_string)
        .ok_or_else(|| {
            ModelFetchError::Unsupported(format!(
                "channel type {} requires a base_url for model detection",
                channel.kind
            ))
        })
}

fn special_openai_base(value: &str) -> Option<&'static str> {
    match value {
        "glm-coding-plan" => Some("https://open.bigmodel.cn/api/coding/paas/v4"),
        "glm-coding-plan-international" => Some("https://api.z.ai/api/coding/paas/v4"),
        "kimi-coding-plan" => Some("https://api.kimi.com/coding/v1"),
        "doubao-coding-plan" => Some("https://ark.cn-beijing.volces.com/api/coding/v3"),
        _ => None,
    }
}

fn default_base_url(kind: i32) -> Option<&'static str> {
    match kind {
        1 => Some("https://api.openai.com"),
        5 => Some("https://api.openai-sb.com"),
        6 => Some("https://api.openaimax.com"),
        7 => Some("https://api.ohmygpt.com"),
        9 => Some("https://api.caipacity.com"),
        10 | 21 => Some("https://api.aiproxy.io"),
        12 => Some("https://api.api2gpt.com"),
        13 => Some("https://api.aigc2d.com"),
        14 => Some("https://api.anthropic.com"),
        15 => Some("https://aip.baidubce.com"),
        16 | 26 => Some("https://open.bigmodel.cn"),
        17 => Some("https://dashscope.aliyuncs.com"),
        19 => Some("https://api.360.cn"),
        20 => Some("https://openrouter.ai/api"),
        22 => Some("https://fastgpt.run/api/openapi"),
        23 => Some("https://hunyuan.tencentcloudapi.com"),
        24 => Some("https://generativelanguage.googleapis.com"),
        25 => Some("https://api.moonshot.cn"),
        27 => Some("https://api.perplexity.ai"),
        31 => Some("https://api.lingyiwanwu.com"),
        34 => Some("https://api.cohere.ai"),
        35 => Some("https://api.minimax.chat"),
        37 => Some("https://api.dify.ai"),
        38 => Some("https://api.jina.ai"),
        39 => Some("https://api.cloudflare.com"),
        40 => Some("https://api.siliconflow.cn"),
        42 => Some("https://api.mistral.ai"),
        43 => Some("https://api.deepseek.com"),
        44 => Some("https://api.moka.ai"),
        45 | 54 => Some("https://ark.cn-beijing.volces.com"),
        46 => Some("https://qianfan.baidubce.com"),
        48 => Some("https://api.x.ai"),
        49 => Some("https://api.coze.cn"),
        50 => Some("https://api.klingai.com"),
        51 => Some("https://visual.volcengineapi.com"),
        52 => Some("https://api.vidu.cn"),
        53 => Some("https://llm.submodel.ai"),
        55 => Some("https://api.openai.com"),
        56 => Some("https://api.replicate.com"),
        57 => Some("https://chatgpt.com"),
        _ => None,
    }
}

fn channel_headers(channel: &ChannelRow, key: &str) -> Result<Headers, ModelFetchError> {
    let mut headers = Headers::new();
    if channel.kind == CHANNEL_TYPE_GEMINI {
        headers
            .set("x-goog-api-key", key)
            .map_err(|_| invalid_header_error())?;
    } else if channel.kind == CHANNEL_TYPE_ANTHROPIC {
        headers
            .set("x-api-key", key)
            .map_err(|_| invalid_header_error())?;
        headers
            .set("anthropic-version", "2023-06-01")
            .map_err(|_| invalid_header_error())?;
    } else {
        headers
            .set("Authorization", &format!("Bearer {key}"))
            .map_err(|_| invalid_header_error())?;
    }
    headers
        .set("Accept", "application/json")
        .map_err(|_| invalid_header_error())?;
    apply_header_overrides(&mut headers, channel.header_override.as_deref(), key)?;
    Ok(headers)
}

fn invalid_header_error() -> ModelFetchError {
    ModelFetchError::Unsupported("channel key is not valid for an HTTP header".to_string())
}

fn apply_header_overrides(
    headers: &mut Headers,
    raw: Option<&str>,
    key: &str,
) -> Result<(), ModelFetchError> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(());
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| {
        ModelFetchError::Unsupported("channel header_override is not valid JSON".to_string())
    })?;
    let object = value.as_object().ok_or_else(|| {
        ModelFetchError::Unsupported("channel header_override must be an object".to_string())
    })?;
    for (name, value) in object {
        let trimmed = name.trim();
        let lower = trimmed.to_ascii_lowercase();
        if trimmed == "*" || lower.starts_with("re:") || lower.starts_with("regex:") {
            continue;
        }
        let Some(value) = value.as_str() else {
            return Err(ModelFetchError::Unsupported(format!(
                "channel header_override value for {trimmed} must be a string"
            )));
        };
        let value = value.replace("{api_key}", key);
        headers.set(trimmed, &value).map_err(|_| {
            ModelFetchError::Unsupported(format!(
                "channel header_override value for {trimmed} is invalid"
            ))
        })?;
    }
    Ok(())
}

async fn fetch_json(url: &str, headers: Headers) -> Result<Value, ModelFetchError> {
    validate_outbound_url(url).map_err(ModelFetchError::Unsupported)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init).map_err(|_| {
        ModelFetchError::Unsupported("failed to build upstream models request".to_string())
    })?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(OUTBOUND_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => result
            .map_err(|_| ModelFetchError::Upstream("upstream models request failed".to_string()))?,
        Either::Right(((), _)) => {
            controller.abort();
            return Err(ModelFetchError::Upstream(
                "upstream models request timed out".to_string(),
            ));
        }
    };
    if !(200..300).contains(&response.status_code()) {
        return Err(ModelFetchError::Upstream(format!(
            "upstream models request returned status {}",
            response.status_code()
        )));
    }
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|_| {
            ModelFetchError::Upstream(
                "failed to inspect upstream models response headers".to_string(),
            )
        })?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err(ModelFetchError::Upstream(
            "upstream models response is not JSON".to_string(),
        ));
    }
    if response
        .headers()
        .get("Content-Length")
        .map_err(|_| {
            ModelFetchError::Upstream(
                "failed to inspect upstream models response headers".to_string(),
            )
        })?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > OUTBOUND_BODY_LIMIT_BYTES)
    {
        return Err(ModelFetchError::Upstream(
            "upstream models response exceeds 1 MiB limit".to_string(),
        ));
    }
    let bytes = response
        .stream()
        .map_err(|_| {
            ModelFetchError::Upstream("failed to read upstream models response".to_string())
        })?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > OUTBOUND_BODY_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "upstream models response exceeds 1 MiB limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| ModelFetchError::Upstream(err.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| {
        ModelFetchError::Upstream("upstream models response is not valid JSON".to_string())
    })
}

fn validate_outbound_url(raw: &str) -> Result<(), String> {
    let parsed = worker::Url::parse(raw).map_err(|_| "channel URL is invalid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("channel model detection requires HTTPS".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("channel URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("channel URL must not contain a fragment".to_string());
    }
    if parsed.port_or_known_default() != Some(443) {
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
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err("literal IP channel URLs are not allowed for model detection".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn model_set_operations_match_go_order_and_deduplication() {
        assert_eq!(
            normalize_models(strings(&[" gpt-4o ", "", "gpt-4o", "gpt-4.1"])),
            strings(&["gpt-4o", "gpt-4.1"])
        );
        assert_eq!(
            merge_models(
                &strings(&["gpt-4o", "gpt-4.1"]),
                &strings(&["gpt-4.1", "gpt-4.1-mini"])
            ),
            strings(&["gpt-4o", "gpt-4.1", "gpt-4.1-mini"])
        );
        assert_eq!(
            subtract_models(
                &strings(&["gpt-4o", "gpt-4.1", "gpt-4.1-mini"]),
                &strings(&["gpt-4.1"])
            ),
            strings(&["gpt-4o", "gpt-4.1-mini"])
        );
        assert_eq!(
            intersect_models(
                &strings(&["gpt-4o", "gpt-4.1", "unknown"]),
                &strings(&["gpt-4.1", "gpt-4o"])
            ),
            strings(&["gpt-4o", "gpt-4.1"])
        );
    }

    #[test]
    fn add_wins_when_a_model_is_selected_for_add_and_remove() {
        assert_eq!(
            apply_selected_changes(
                &strings(&["gpt-4o"]),
                &strings(&["gpt-4.1"]),
                &strings(&["gpt-4.1"])
            ),
            strings(&["gpt-4o", "gpt-4.1"])
        );
    }

    #[test]
    fn apply_flow_keeps_go_remaining_and_ignore_semantics() {
        let pending_add = strings(&["gpt-4.1", "o3", "sora"]);
        let pending_remove = strings(&["old-model", "gpt-4.1"]);
        let selected_add = intersect_models(&strings(&["gpt-4.1"]), &pending_add);
        let ignored = intersect_models(&strings(&["o3", "sora"]), &pending_add);
        let selected_remove = subtract_models(
            &intersect_models(&strings(&["old-model", "gpt-4.1"]), &pending_remove),
            &selected_add,
        );

        assert_eq!(selected_remove, strings(&["old-model"]));
        assert_eq!(
            apply_selected_changes(
                &strings(&["gpt-4o", "old-model"]),
                &selected_add,
                &selected_remove
            ),
            strings(&["gpt-4o", "gpt-4.1"])
        );
        assert_eq!(
            subtract_models(
                &merge_models(&strings(&["legacy", "gpt-4.1"]), &ignored),
                &selected_add,
            ),
            strings(&["legacy", "o3", "sora"])
        );
        assert_eq!(
            subtract_models(&pending_add, &merge_models(&selected_add, &ignored)),
            Vec::<String>::new()
        );
        assert_eq!(
            subtract_models(&pending_remove, &selected_remove),
            strings(&["gpt-4.1"])
        );
    }

    #[test]
    fn pending_changes_respect_mapping_and_regex_ignores() {
        let mapping = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "alias-model": "mapped-target"
        }))
        .unwrap();
        let (add, remove) = collect_pending_changes(
            &strings(&["alias-model", "gpt-4o", "stale-model"]),
            &strings(&[
                "gpt-4o",
                "gpt-4.1",
                "mapped-target",
                "sora-video",
                "claude-3-5-sonnet",
            ]),
            &strings(&["gpt-4.1", "regex:^sora-.*$"]),
            &mapping,
        );
        assert_eq!(add, strings(&["claude-3-5-sonnet"]));
        assert_eq!(remove, strings(&["stale-model"]));
    }

    #[test]
    fn malformed_regex_ignore_is_not_a_match() {
        assert!(!is_ignored_model("gpt-4o", &strings(&["regex:["])));
    }

    #[test]
    fn settings_parser_preserves_unknown_fields() {
        let mut settings =
            parse_settings(r#"{"custom":true,"upstream_model_update_ignored_models":["x"]}"#);
        settings.insert(LAST_CHECK_TIME.to_string(), Value::from(42));
        assert_eq!(settings.get("custom"), Some(&Value::Bool(true)));
        assert_eq!(settings_models(&settings, IGNORED_MODELS), strings(&["x"]));
    }

    #[test]
    fn provider_urls_match_go_special_cases() {
        let mut channel = sample_channel();
        channel.kind = CHANNEL_TYPE_ALI;
        channel.base_url = "https://dashscope.aliyuncs.com".to_string();
        assert_eq!(
            openai_models_url(&channel).unwrap(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        channel.kind = CHANNEL_TYPE_ZHIPU_V4;
        channel.base_url = "glm-coding-plan".to_string();
        assert_eq!(
            openai_models_url(&channel).unwrap(),
            "https://open.bigmodel.cn/api/coding/paas/v4/models"
        );
    }

    #[test]
    fn outbound_validation_rejects_local_and_non_https_targets() {
        assert!(validate_outbound_url("https://api.example.com/v1/models").is_ok());
        assert!(validate_outbound_url("http://api.example.com/v1/models").is_err());
        assert!(validate_outbound_url("https://localhost/v1/models").is_err());
        assert!(validate_outbound_url("https://127.0.0.1/v1/models").is_err());
    }

    fn sample_channel() -> ChannelRow {
        ChannelRow {
            id: 1,
            kind: 1,
            key: "sk-test".to_string(),
            openai_organization: None,
            test_model: None,
            status: 1,
            name: "test".to_string(),
            weight: 0,
            created_time: 0,
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
            settings: "{}".to_string(),
        }
    }
}
