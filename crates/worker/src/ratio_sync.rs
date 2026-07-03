//! Upstream pricing ratio sync endpoints.
//!
//! This ports Go `controller/ratio_sync.go` for the admin pricing UI while
//! keeping Worker-specific guardrails around outbound fetches: root-only access,
//! bounded response bodies, explicit redirect handling, and request timeouts.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use cinatoken_core::default_ratios as dr;
use cinatoken_relay::first_channel_key;
use cinatoken_ssrf::SsrfPolicy;
use futures_util::future::{select, Either};
use futures_util::stream::{self, StreamExt};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use worker::{
    AbortController, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_root_auth,
};
use crate::d1_repositories::{self, ChannelFilter, ChannelRow};

type SyncData = BTreeMap<String, BTreeMap<String, Value>>;
type DifferencesMap = BTreeMap<String, BTreeMap<String, DifferenceItem>>;

const DEFAULT_TIMEOUT_SECONDS: i64 = 10;
const MAX_TIMEOUT_SECONDS: i64 = 60;
const DEFAULT_ENDPOINT: &str = "/api/pricing";
const MAX_CONCURRENT_FETCHES: usize = 8;
const MAX_RATIO_CONFIG_BYTES: usize = 10 * 1024 * 1024;
const FLOAT_EPSILON: f64 = 1e-9;
const OFFICIAL_RATIO_PRESET_ID: i64 = -100;
const OFFICIAL_RATIO_PRESET_NAME: &str = "\u{5b98}\u{65b9}\u{500d}\u{7387}\u{9884}\u{8bbe}";
const OFFICIAL_RATIO_PRESET_BASE_URL: &str = "https://basellm.github.io";
const MODELS_DEV_PRESET_ID: i64 = -101;
const MODELS_DEV_PRESET_NAME: &str = "models.dev \u{4ef7}\u{683c}\u{9884}\u{8bbe}";
const MODELS_DEV_PRESET_BASE_URL: &str = "https://models.dev";
const MODELS_DEV_HOST: &str = "models.dev";
const MODELS_DEV_PATH: &str = "/api.json";
const MODELS_DEV_INPUT_COST_RATIO_BASE: f64 = 1000.0;
const BILLING_MODE_FIELD: &str = "billing_mode";
const BILLING_EXPR_FIELD: &str = "billing_expr";
const BILLING_MODE_OPTION_KEY: &str = "billing_setting.billing_mode";
const BILLING_EXPR_OPTION_KEY: &str = "billing_setting.billing_expr";
const BILLING_MODE_TIERED_EXPR: &str = "tiered_expr";

const PRICING_SYNC_FIELDS: &[&str] = &[
    "model_ratio",
    "completion_ratio",
    "cache_ratio",
    "create_cache_ratio",
    "image_ratio",
    "audio_ratio",
    "audio_completion_ratio",
    "model_price",
    BILLING_MODE_FIELD,
    BILLING_EXPR_FIELD,
];

const NUMERIC_PRICING_SYNC_FIELDS: &[&str] = &[
    "model_ratio",
    "completion_ratio",
    "cache_ratio",
    "create_cache_ratio",
    "image_ratio",
    "audio_ratio",
    "audio_completion_ratio",
    "model_price",
];

#[derive(Debug, Deserialize, Default)]
struct UpstreamRequest {
    #[serde(default)]
    channel_ids: Vec<i64>,
    #[serde(default)]
    upstreams: Vec<UpstreamConfig>,
    #[serde(default)]
    timeout: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct UpstreamConfig {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    endpoint: String,
}

#[derive(Debug, Serialize)]
struct SyncableChannel {
    id: i64,
    name: String,
    base_url: String,
    status: i32,
    #[serde(rename = "type")]
    kind: i32,
}

#[derive(Debug, Serialize)]
struct FetchData {
    differences: DifferencesMap,
    test_results: Vec<TestResult>,
}

#[derive(Debug, Serialize)]
struct TestResult {
    name: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DifferenceItem {
    current: Value,
    upstreams: BTreeMap<String, Value>,
    confidence: BTreeMap<String, bool>,
}

#[derive(Debug)]
struct UpstreamResult {
    name: String,
    data: Option<SyncData>,
    err: Option<String>,
}

#[derive(Debug)]
struct SuccessfulChannel {
    name: String,
    data: SyncData,
}

/// `GET /api/ratio_sync/channels`: root-only list of upstreams usable by the
/// pricing sync dialog, plus the two Go-compatible virtual presets.
pub async fn channels(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let mut rows = Vec::new();
    let mut page = 1;
    loop {
        let chunk =
            d1_repositories::list_channels(&db, &ChannelFilter::default(), page, 100).await?;
        let done = chunk.len() < 100;
        rows.extend(chunk);
        if done {
            break;
        }
        page += 1;
    }

    let mut syncable = rows
        .into_iter()
        .filter_map(|channel| {
            let base_url = channel.base_url.trim();
            if base_url.is_empty() {
                return None;
            }
            Some(SyncableChannel {
                id: channel.id,
                name: channel.name,
                base_url: base_url.to_string(),
                status: channel.status,
                kind: channel.kind,
            })
        })
        .collect::<Vec<_>>();

    syncable.push(SyncableChannel {
        id: OFFICIAL_RATIO_PRESET_ID,
        name: OFFICIAL_RATIO_PRESET_NAME.to_string(),
        base_url: OFFICIAL_RATIO_PRESET_BASE_URL.to_string(),
        status: 1,
        kind: 0,
    });
    syncable.push(SyncableChannel {
        id: MODELS_DEV_PRESET_ID,
        name: MODELS_DEV_PRESET_NAME.to_string(),
        base_url: MODELS_DEV_PRESET_BASE_URL.to_string(),
        status: 1,
        kind: 0,
    });

    envelope_ok_response(&syncable)
}

/// `POST /api/ratio_sync/fetch`: fetch selected upstream price metadata and
/// return only the fields that differ from the local effective settings.
pub async fn fetch(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }

    let body = match read_json_body(&mut req).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let request = match serde_json::from_value::<UpstreamRequest>(body) {
        Ok(value) => value,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("request parameters are invalid: {err}"),
            ));
        }
    };

    let timeout = normalize_timeout(request.timeout);
    let db = env.d1("DB")?;
    let upstreams = resolve_upstreams(&db, request).await?;
    if upstreams.is_empty() {
        return Ok(envelope_error_response(
            200,
            "\u{65e0}\u{6709}\u{6548}\u{4e0a}\u{6e38}\u{6e20}\u{9053}",
        ));
    }

    let results = stream::iter(
        upstreams
            .into_iter()
            .map(|upstream| fetch_upstream(&db, upstream, timeout)),
    )
    .buffer_unordered(MAX_CONCURRENT_FETCHES)
    .collect::<Vec<_>>()
    .await;

    let local = load_local_pricing_sync_data(&db).await?;
    let mut test_results = Vec::with_capacity(results.len());
    let mut successful = Vec::new();
    for result in results {
        if let Some(err) = result.err {
            test_results.push(TestResult {
                name: result.name,
                status: "error",
                error: Some(err),
            });
        } else {
            test_results.push(TestResult {
                name: result.name.clone(),
                status: "success",
                error: None,
            });
            successful.push(SuccessfulChannel {
                name: result.name,
                data: result.data.unwrap_or_default(),
            });
        }
    }

    envelope_ok_response(&FetchData {
        differences: build_differences(&local, &successful),
        test_results,
    })
}

async fn resolve_upstreams(
    db: &D1Database,
    request: UpstreamRequest,
) -> WorkerResult<Vec<UpstreamConfig>> {
    if !request.upstreams.is_empty() {
        let upstreams = request
            .upstreams
            .into_iter()
            .filter_map(normalize_requested_upstream)
            .collect();
        return Ok(upstreams);
    }

    if request.channel_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut upstreams = Vec::new();
    for id in request.channel_ids {
        if let Some(channel) = d1_repositories::find_channel_by_id(db, id).await? {
            if let Some(upstream) = upstream_from_channel(channel) {
                upstreams.push(upstream);
            }
        }
    }
    Ok(upstreams)
}

fn normalize_requested_upstream(mut upstream: UpstreamConfig) -> Option<UpstreamConfig> {
    upstream.base_url = upstream.base_url.trim().trim_end_matches('/').to_string();
    if !starts_with_http_scheme(&upstream.base_url) {
        return None;
    }
    upstream.name = upstream.name.trim().to_string();
    if upstream.name.is_empty() {
        upstream.name = upstream.base_url.clone();
    }
    upstream.endpoint = upstream.endpoint.trim().to_string();
    if upstream.endpoint.is_empty() {
        upstream.endpoint = DEFAULT_ENDPOINT.to_string();
    }
    Some(upstream)
}

fn upstream_from_channel(channel: ChannelRow) -> Option<UpstreamConfig> {
    let base_url = channel.base_url.trim().trim_end_matches('/').to_string();
    if !starts_with_http_scheme(&base_url) {
        return None;
    }
    Some(UpstreamConfig {
        id: channel.id,
        name: channel.name,
        base_url,
        endpoint: String::new(),
    })
}

fn starts_with_http_scheme(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

async fn fetch_upstream(db: &D1Database, upstream: UpstreamConfig, timeout: i64) -> UpstreamResult {
    let name = unique_upstream_name(&upstream);
    let is_openrouter = upstream.endpoint == "openrouter";
    let full_url = match build_full_url(&upstream, is_openrouter) {
        Ok(url) => url,
        Err(err) => {
            return UpstreamResult {
                name,
                data: None,
                err: Some(err),
            };
        }
    };
    let is_models_dev = is_models_dev_api_endpoint(&full_url);
    let bearer = if is_openrouter {
        match openrouter_bearer_token(db, upstream.id).await {
            Ok(token) => Some(token),
            Err(err) => {
                return UpstreamResult {
                    name,
                    data: None,
                    err: Some(err),
                };
            }
        }
    } else {
        None
    };

    let bytes = match fetch_ratio_bytes(&full_url, bearer.as_deref(), timeout, &name).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return UpstreamResult {
                name,
                data: None,
                err: Some(err),
            };
        }
    };

    let converted = if is_openrouter {
        convert_openrouter_to_ratio_data(&bytes)
    } else if is_models_dev {
        convert_models_dev_to_ratio_data(&bytes)
    } else {
        convert_generic_upstream_data(&bytes)
    };

    match converted {
        Ok(data) => UpstreamResult {
            name,
            data: Some(data),
            err: None,
        },
        Err(err) => UpstreamResult {
            name,
            data: None,
            err: Some(err),
        },
    }
}

fn unique_upstream_name(upstream: &UpstreamConfig) -> String {
    let mut name = upstream.name.trim();
    if name.is_empty() {
        name = upstream.base_url.trim();
    }
    if upstream.id != 0 {
        format!("{name}({})", upstream.id)
    } else {
        name.to_string()
    }
}

fn build_full_url(upstream: &UpstreamConfig, is_openrouter: bool) -> Result<String, String> {
    let base = validate_base_url(&upstream.base_url)?;
    if is_openrouter {
        return Ok(format!("{}/v1/models", base.trim_end_matches('/')));
    }

    let endpoint = upstream.endpoint.trim();
    if starts_with_http_scheme(endpoint) {
        return validate_endpoint_url(endpoint);
    }

    let path = if endpoint.is_empty() {
        DEFAULT_ENDPOINT.to_string()
    } else if endpoint.starts_with('/') {
        endpoint.to_string()
    } else {
        format!("/{endpoint}")
    };
    Ok(format!("{}{}", base.trim_end_matches('/'), path))
}

fn validate_base_url(raw: &str) -> Result<String, String> {
    let parsed = validate_outbound_url(raw, "base URL")?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("base URL must not contain credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("base URL must not contain query or fragment".to_string());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn validate_endpoint_url(raw: &str) -> Result<String, String> {
    let parsed = validate_outbound_url(raw, "endpoint URL")?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("endpoint URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("endpoint URL must not contain fragment".to_string());
    }
    Ok(parsed.to_string())
}

fn validate_outbound_url(raw: &str, label: &str) -> Result<url::Url, String> {
    SsrfPolicy::strict_default()
        .validate_url(raw.trim())
        .map_err(|err| format!("{label} is not allowed: {err}"))
}

fn is_models_dev_api_endpoint(raw_url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw_url) else {
        return false;
    };
    if parsed.host_str().map(str::to_ascii_lowercase).as_deref() != Some(MODELS_DEV_HOST) {
        return false;
    }
    let path = parsed.path().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    path == MODELS_DEV_PATH
}

async fn openrouter_bearer_token(db: &D1Database, channel_id: i64) -> Result<String, String> {
    if channel_id == 0 {
        return Err("OpenRouter requires a valid channel with API key".to_string());
    }
    let channel = d1_repositories::find_channel_by_id(db, channel_id)
        .await
        .map_err(|err| format!("failed to get channel key: {err}"))?
        .ok_or_else(|| "failed to get channel key: channel not found".to_string())?;
    first_channel_key(&channel.key)
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "no API key configured for this channel".to_string())
}

async fn fetch_ratio_bytes(
    url: &str,
    bearer: Option<&str>,
    timeout_seconds: i64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        match fetch_ratio_bytes_once(url, bearer, timeout_seconds, label).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                last_error = err;
                if attempt < 2 {
                    Delay::from(Duration::from_millis(200 * (1_u64 << attempt))).await;
                }
            }
        }
    }
    Err(last_error)
}

async fn fetch_ratio_bytes_once(
    url: &str,
    bearer: Option<&str>,
    timeout_seconds: i64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    if let Some(token) = bearer {
        headers
            .set("Authorization", &format!("Bearer {token}"))
            .map_err(|err| err.to_string())?;
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init).map_err(|err| err.to_string())?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(Duration::from_secs(timeout_seconds as u64));
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => result.map_err(|err| format!("{label}: {err}"))?,
        Either::Right(((), _)) => {
            controller.abort();
            return Err(format!("{label}: request timed out"));
        }
    };

    if response.status_code() != 200 {
        return Err(format!("{label}: HTTP {}", response.status_code()));
    }
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|err| err.to_string())?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err(format!("{label}: response is not JSON"));
    }
    if response
        .headers()
        .get("Content-Length")
        .map_err(|err| err.to_string())?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RATIO_CONFIG_BYTES)
    {
        return Err(format!("{label}: response exceeds 10 MiB limit"));
    }

    response
        .stream()
        .map_err(|err| format!("{label}: failed to read response: {err}"))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > MAX_RATIO_CONFIG_BYTES {
                return Err(worker::Error::RustError(
                    "ratio sync response exceeds 10 MiB limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| format!("{label}: {err}"))
}

async fn load_local_pricing_sync_data(db: &D1Database) -> WorkerResult<SyncData> {
    let opts = d1_repositories::option_values(
        db,
        &[
            "ModelRatio",
            "CompletionRatio",
            "CacheRatio",
            "CreateCacheRatio",
            "ImageRatio",
            "AudioRatio",
            "AudioCompletionRatio",
            "ModelPrice",
            BILLING_MODE_OPTION_KEY,
            BILLING_EXPR_OPTION_KEY,
        ],
    )
    .await?;

    let mut data = SyncData::new();
    insert_f64_map(
        &mut data,
        "model_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_MODEL_RATIO, opts[0].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "completion_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_COMPLETION_RATIO, opts[1].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "cache_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_CACHE_RATIO, opts[2].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "create_cache_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_CREATE_CACHE_RATIO, opts[3].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "image_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_IMAGE_RATIO, opts[4].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "audio_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_AUDIO_RATIO, opts[5].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "audio_completion_ratio",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_AUDIO_COMPLETION_RATIO, opts[6].as_deref()),
    );
    insert_f64_map(
        &mut data,
        "model_price",
        crate::admin_user::merged_ratio_map(dr::DEFAULT_MODEL_PRICE, opts[7].as_deref()),
    );
    insert_string_option_map(&mut data, BILLING_MODE_FIELD, opts[8].as_deref());
    insert_string_option_map(&mut data, BILLING_EXPR_FIELD, opts[9].as_deref());
    Ok(data)
}

fn insert_f64_map(data: &mut SyncData, field: &str, values: BTreeMap<String, f64>) {
    if values.is_empty() {
        return;
    }
    let map = values
        .into_iter()
        .filter_map(|(model, value)| Some((model, number_value(value)?)))
        .collect::<BTreeMap<_, _>>();
    if !map.is_empty() {
        data.insert(field.to_string(), map);
    }
}

fn insert_string_option_map(data: &mut SyncData, field: &str, raw: Option<&str>) {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<BTreeMap<String, Value>>(raw) else {
        return;
    };
    let values = parsed
        .into_iter()
        .filter_map(|(model, value)| {
            value
                .as_str()
                .map(|text| (model, Value::String(text.to_string())))
        })
        .collect::<BTreeMap<_, _>>();
    if !values.is_empty() {
        data.insert(field.to_string(), values);
    }
}

fn convert_generic_upstream_data(bytes: &[u8]) -> Result<SyncData, String> {
    let envelope = serde_json::from_slice::<GenericEnvelope>(bytes)
        .map_err(|err| format!("json decode failed: {err}"))?;
    if !envelope.success {
        return Err(if envelope.message.trim().is_empty() {
            "upstream returned success=false".to_string()
        } else {
            envelope.message
        });
    }

    if let Some(type1) = try_convert_type1_data(&envelope.data) {
        return Ok(type1);
    }

    let pricing_items = serde_json::from_value::<Vec<PricingItem>>(envelope.data)
        .map_err(|err| format!("unrecognized upstream data format: {err}"))?;
    Ok(convert_pricing_items(pricing_items))
}

#[derive(Debug, Deserialize)]
struct GenericEnvelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    message: String,
}

fn try_convert_type1_data(data: &Value) -> Option<SyncData> {
    let Value::Object(object) = data else {
        return None;
    };
    if !PRICING_SYNC_FIELDS
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return None;
    }
    Some(convert_type1_object(object))
}

fn convert_type1_object(object: &Map<String, Value>) -> SyncData {
    let mut converted = SyncData::new();
    for field in PRICING_SYNC_FIELDS {
        if let Some(map) = object.get(*field).and_then(|value| value.as_object()) {
            let values = map
                .iter()
                .map(|(model, value)| {
                    (
                        model.clone(),
                        normalize_sync_value(field, value).unwrap_or_else(|| value.clone()),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            if !values.is_empty() {
                converted.insert((*field).to_string(), values);
            }
        }
    }
    converted
}

#[derive(Debug, Deserialize)]
struct PricingItem {
    #[serde(default)]
    model_name: String,
    #[serde(default)]
    quota_type: i32,
    #[serde(default)]
    model_ratio: f64,
    #[serde(default)]
    model_price: f64,
    #[serde(default)]
    completion_ratio: f64,
    cache_ratio: Option<f64>,
    create_cache_ratio: Option<f64>,
    image_ratio: Option<f64>,
    audio_ratio: Option<f64>,
    audio_completion_ratio: Option<f64>,
    #[serde(default)]
    billing_mode: String,
    #[serde(default)]
    billing_expr: String,
}

fn convert_pricing_items(items: Vec<PricingItem>) -> SyncData {
    let mut model_ratio = BTreeMap::new();
    let mut completion_ratio = BTreeMap::new();
    let mut cache_ratio = BTreeMap::new();
    let mut create_cache_ratio = BTreeMap::new();
    let mut image_ratio = BTreeMap::new();
    let mut audio_ratio = BTreeMap::new();
    let mut audio_completion_ratio = BTreeMap::new();
    let mut model_price = BTreeMap::new();
    let mut billing_mode = BTreeMap::new();
    let mut billing_expr = BTreeMap::new();

    for item in items {
        if item.model_name.trim().is_empty() {
            continue;
        }
        let model = item.model_name;
        if item.billing_mode == BILLING_MODE_TIERED_EXPR && !item.billing_expr.trim().is_empty() {
            billing_mode.insert(
                model.clone(),
                Value::String(BILLING_MODE_TIERED_EXPR.to_string()),
            );
            billing_expr.insert(model.clone(), Value::String(item.billing_expr));
        }
        if item.quota_type == 1 {
            insert_number(&mut model_price, model.clone(), item.model_price);
        } else {
            insert_number(&mut model_ratio, model.clone(), item.model_ratio);
            insert_number(&mut completion_ratio, model.clone(), item.completion_ratio);
        }
        insert_optional_number(&mut cache_ratio, &model, item.cache_ratio);
        insert_optional_number(&mut create_cache_ratio, &model, item.create_cache_ratio);
        insert_optional_number(&mut image_ratio, &model, item.image_ratio);
        insert_optional_number(&mut audio_ratio, &model, item.audio_ratio);
        insert_optional_number(
            &mut audio_completion_ratio,
            &model,
            item.audio_completion_ratio,
        );
    }

    let mut converted = SyncData::new();
    insert_non_empty(&mut converted, "model_ratio", model_ratio);
    insert_non_empty(&mut converted, "completion_ratio", completion_ratio);
    insert_non_empty(&mut converted, "cache_ratio", cache_ratio);
    insert_non_empty(&mut converted, "create_cache_ratio", create_cache_ratio);
    insert_non_empty(&mut converted, "image_ratio", image_ratio);
    insert_non_empty(&mut converted, "audio_ratio", audio_ratio);
    insert_non_empty(
        &mut converted,
        "audio_completion_ratio",
        audio_completion_ratio,
    );
    insert_non_empty(&mut converted, "model_price", model_price);
    insert_non_empty(&mut converted, BILLING_MODE_FIELD, billing_mode);
    insert_non_empty(&mut converted, BILLING_EXPR_FIELD, billing_expr);
    converted
}

fn convert_openrouter_to_ratio_data(bytes: &[u8]) -> Result<SyncData, String> {
    let response = serde_json::from_slice::<OpenRouterResponse>(bytes)
        .map_err(|err| format!("failed to decode OpenRouter response: {err}"))?;
    let mut model_ratio = BTreeMap::new();
    let mut completion_ratio = BTreeMap::new();
    let mut cache_ratio = BTreeMap::new();

    for model in response.data {
        let prompt = model.pricing.prompt.trim().parse::<f64>();
        let completion = model.pricing.completion.trim().parse::<f64>();
        if prompt.is_err() && completion.is_err() {
            continue;
        }
        let prompt_price = prompt.unwrap_or(0.0);
        let completion_price = completion.unwrap_or(0.0);
        if prompt_price < 0.0 || completion_price < 0.0 {
            continue;
        }
        if prompt_price == 0.0 && completion_price == 0.0 {
            insert_number(&mut model_ratio, model.id, 0.0);
            continue;
        }
        if prompt_price <= 0.0 {
            continue;
        }

        insert_number(
            &mut model_ratio,
            model.id.clone(),
            round_ratio_value(prompt_price * 1000.0 * dr::USD),
        );
        insert_number(
            &mut completion_ratio,
            model.id.clone(),
            round_ratio_value(completion_price / prompt_price),
        );
        if !model.pricing.input_cache_read.trim().is_empty() {
            if let Ok(cache_price) = model.pricing.input_cache_read.trim().parse::<f64>() {
                if cache_price >= 0.0 {
                    insert_number(
                        &mut cache_ratio,
                        model.id,
                        round_ratio_value(cache_price / prompt_price),
                    );
                }
            }
        }
    }

    let mut converted = SyncData::new();
    insert_non_empty(&mut converted, "model_ratio", model_ratio);
    insert_non_empty(&mut converted, "completion_ratio", completion_ratio);
    insert_non_empty(&mut converted, "cache_ratio", cache_ratio);
    Ok(converted)
}

#[derive(Debug, Deserialize)]
struct OpenRouterResponse {
    #[serde(default)]
    data: Vec<OpenRouterModel>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    pricing: OpenRouterPricing,
}

#[derive(Debug, Default, Deserialize)]
struct OpenRouterPricing {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    completion: String,
    #[serde(default)]
    input_cache_read: String,
}

fn convert_models_dev_to_ratio_data(bytes: &[u8]) -> Result<SyncData, String> {
    let upstream = serde_json::from_slice::<BTreeMap<String, ModelsDevProvider>>(bytes)
        .map_err(|err| format!("failed to decode models.dev response: {err}"))?;
    if upstream.is_empty() {
        return Err("empty models.dev response".to_string());
    }

    let mut selected: BTreeMap<String, ModelsDevCandidate> = BTreeMap::new();
    for (provider, provider_data) in upstream {
        for (model_name, model) in provider_data.models {
            let Some(candidate) = build_models_dev_candidate(&provider, model.cost) else {
                continue;
            };
            if selected
                .get(&model_name)
                .is_none_or(|current| should_replace_models_dev_candidate(current, &candidate))
            {
                selected.insert(model_name, candidate);
            }
        }
    }
    if selected.is_empty() {
        return Err("no valid models.dev pricing entries found".to_string());
    }

    let mut model_ratio = BTreeMap::new();
    let mut completion_ratio = BTreeMap::new();
    let mut cache_ratio = BTreeMap::new();
    for (model_name, candidate) in selected {
        if candidate.input == 0.0 {
            insert_number(&mut model_ratio, model_name, 0.0);
            continue;
        }
        insert_number(
            &mut model_ratio,
            model_name.clone(),
            round_ratio_value(candidate.input * dr::USD / MODELS_DEV_INPUT_COST_RATIO_BASE),
        );
        if let Some(output) = candidate.output {
            insert_number(
                &mut completion_ratio,
                model_name.clone(),
                round_ratio_value(output / candidate.input),
            );
        }
        if let Some(cache_read) = candidate.cache_read {
            insert_number(
                &mut cache_ratio,
                model_name,
                round_ratio_value(cache_read / candidate.input),
            );
        }
    }

    let mut converted = SyncData::new();
    insert_non_empty(&mut converted, "model_ratio", model_ratio);
    insert_non_empty(&mut converted, "completion_ratio", completion_ratio);
    insert_non_empty(&mut converted, "cache_ratio", cache_ratio);
    Ok(converted)
}

#[derive(Debug, Default, Deserialize)]
struct ModelsDevProvider {
    #[serde(default)]
    models: BTreeMap<String, ModelsDevModel>,
}

#[derive(Debug, Default, Deserialize)]
struct ModelsDevModel {
    #[serde(default)]
    cost: ModelsDevCost,
}

#[derive(Debug, Default, Deserialize)]
struct ModelsDevCost {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
}

#[derive(Debug)]
struct ModelsDevCandidate {
    provider: String,
    input: f64,
    output: Option<f64>,
    cache_read: Option<f64>,
}

fn build_models_dev_candidate(provider: &str, cost: ModelsDevCost) -> Option<ModelsDevCandidate> {
    let input = cost.input?;
    if !is_valid_non_negative_cost(input) {
        return None;
    }
    let output = match cost.output {
        Some(value) if !is_valid_non_negative_cost(value) => return None,
        value => value,
    };
    if input == 0.0 && output.is_some_and(|value| value > 0.0) {
        return None;
    }
    let cache_read = match cost.cache_read {
        Some(value) if is_valid_non_negative_cost(value) => Some(value),
        _ => None,
    };
    Some(ModelsDevCandidate {
        provider: provider.to_string(),
        input,
        output,
        cache_read,
    })
}

fn should_replace_models_dev_candidate(
    current: &ModelsDevCandidate,
    next: &ModelsDevCandidate,
) -> bool {
    let current_non_zero = current.input > 0.0;
    let next_non_zero = next.input > 0.0;
    if current_non_zero != next_non_zero {
        return next_non_zero;
    }
    if next_non_zero && !nearly_equal(next.input, current.input) {
        return next.input < current.input;
    }
    next.provider < current.provider
}

fn is_valid_non_negative_cost(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn build_differences(local: &SyncData, successful: &[SuccessfulChannel]) -> DifferencesMap {
    let mut differences = DifferencesMap::new();
    let mut all_models = BTreeSet::new();

    for field in PRICING_SYNC_FIELDS {
        if let Some(values) = local.get(*field) {
            all_models.extend(values.keys().cloned());
        }
    }
    for channel in successful {
        for field in PRICING_SYNC_FIELDS {
            if let Some(values) = channel.data.get(*field) {
                all_models.extend(values.keys().cloned());
            }
        }
    }

    let mut confidence_map: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    for channel in successful {
        let mut channel_confidence = BTreeMap::new();
        let model_ratios = channel.data.get("model_ratio");
        let completion_ratios = channel.data.get("completion_ratio");
        for model in &all_models {
            let mut trusted = true;
            if let (Some(model_ratios), Some(completion_ratios)) = (model_ratios, completion_ratios)
            {
                if let (Some(model_ratio), Some(completion_ratio)) =
                    (model_ratios.get(model), completion_ratios.get(model))
                {
                    if model_ratio.as_f64().is_some_and(|v| nearly_equal(v, 37.5))
                        && completion_ratio
                            .as_f64()
                            .is_some_and(|v| nearly_equal(v, 1.0))
                    {
                        trusted = false;
                    }
                }
            }
            channel_confidence.insert(model.clone(), trusted);
        }
        confidence_map.insert(channel.name.clone(), channel_confidence);
    }

    for model in &all_models {
        for field in PRICING_SYNC_FIELDS {
            let local_value = local
                .get(*field)
                .and_then(|values| values.get(model))
                .and_then(|value| normalize_sync_value(field, value))
                .unwrap_or(Value::Null);
            let mut upstream_values = BTreeMap::new();
            let mut confidence_values = BTreeMap::new();
            let mut has_upstream_value = false;
            let mut has_difference = false;

            for channel in successful {
                let mut upstream_value = Value::Null;
                if let Some(value) = channel
                    .data
                    .get(*field)
                    .and_then(|values| values.get(model))
                    .and_then(|value| normalize_sync_value(field, value))
                {
                    upstream_value = value;
                    has_upstream_value = true;
                    if !local_value.is_null() && !values_equal(&local_value, &upstream_value) {
                        has_difference = true;
                    } else if values_equal(&local_value, &upstream_value) {
                        upstream_value = same_value();
                    }
                }
                if upstream_value.is_null() && local_value.is_null() {
                    upstream_value = same_value();
                }
                if local_value.is_null() && !upstream_value.is_null() && !is_same(&upstream_value) {
                    has_difference = true;
                }

                upstream_values.insert(channel.name.clone(), upstream_value);
                confidence_values.insert(
                    channel.name.clone(),
                    confidence_map
                        .get(&channel.name)
                        .and_then(|values| values.get(model))
                        .copied()
                        .unwrap_or(true),
                );
            }

            let should_include = if local_value.is_null() {
                has_upstream_value
            } else {
                has_difference
            };
            if should_include {
                differences.entry(model.clone()).or_default().insert(
                    (*field).to_string(),
                    DifferenceItem {
                        current: local_value,
                        upstreams: upstream_values,
                        confidence: confidence_values,
                    },
                );
            }
        }
    }

    let mut channel_has_diff = BTreeSet::new();
    for ratio_map in differences.values() {
        for item in ratio_map.values() {
            for (channel, value) in &item.upstreams {
                if !value.is_null() && !is_same(value) {
                    channel_has_diff.insert(channel.clone());
                }
            }
        }
    }

    let mut empty_models = Vec::new();
    for (model, ratio_map) in differences.iter_mut() {
        let mut empty_fields = Vec::new();
        for (field, item) in ratio_map.iter_mut() {
            item.upstreams
                .retain(|channel, _| channel_has_diff.contains(channel));
            item.confidence
                .retain(|channel, _| channel_has_diff.contains(channel));
            let all_same = item.upstreams.values().all(is_same);
            if item.upstreams.is_empty() || all_same {
                empty_fields.push(field.clone());
            }
        }
        for field in empty_fields {
            ratio_map.remove(&field);
        }
        if ratio_map.is_empty() {
            empty_models.push(model.clone());
        }
    }
    for model in empty_models {
        differences.remove(&model);
    }

    differences
}

fn normalize_timeout(timeout: i64) -> i64 {
    if timeout <= 0 {
        DEFAULT_TIMEOUT_SECONDS
    } else {
        timeout.min(MAX_TIMEOUT_SECONDS)
    }
}

fn normalize_sync_value(field: &str, value: &Value) -> Option<Value> {
    if is_numeric_field(field) {
        return value.as_f64().and_then(number_value);
    }
    Some(value.clone())
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(left), Some(right)) => nearly_equal(left, right),
        _ => a == b,
    }
}

fn nearly_equal(a: f64, b: f64) -> bool {
    (a - b).abs() < FLOAT_EPSILON
}

fn round_ratio_value(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}

fn is_numeric_field(field: &str) -> bool {
    NUMERIC_PRICING_SYNC_FIELDS.contains(&field)
}

fn same_value() -> Value {
    Value::String("same".to_string())
}

fn is_same(value: &Value) -> bool {
    value.as_str() == Some("same")
}

fn insert_optional_number(map: &mut BTreeMap<String, Value>, model: &str, value: Option<f64>) {
    if let Some(value) = value {
        insert_number(map, model.to_string(), value);
    }
}

fn insert_number(map: &mut BTreeMap<String, Value>, model: String, value: f64) {
    if let Some(value) = number_value(value) {
        map.insert(model, value);
    }
}

fn insert_non_empty(data: &mut SyncData, field: &str, values: BTreeMap<String, Value>) {
    if !values.is_empty() {
        data.insert(field.to_string(), values);
    }
}

fn number_value(value: f64) -> Option<Value> {
    serde_json::Number::from_f64(value).map(Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(value: f64) -> Value {
        number_value(value).expect("finite number")
    }

    #[test]
    fn openrouter_converter_derives_local_ratio_maps() {
        let body = br#"{
          "data": [
            {
              "id": "paid",
              "pricing": {
                "prompt": "0.000001",
                "completion": "0.000002",
                "input_cache_read": "0.0000005"
              }
            },
            {
              "id": "free",
              "pricing": { "prompt": "0", "completion": "0" }
            },
            {
              "id": "dynamic",
              "pricing": { "prompt": "-1", "completion": "0.1" }
            }
          ]
        }"#;
        let data = convert_openrouter_to_ratio_data(body).expect("converted");
        assert_eq!(data["model_ratio"]["paid"], number(0.5));
        assert_eq!(data["completion_ratio"]["paid"], number(2.0));
        assert_eq!(data["cache_ratio"]["paid"], number(0.5));
        assert_eq!(data["model_ratio"]["free"], number(0.0));
        assert!(!data["model_ratio"].contains_key("dynamic"));
    }

    #[test]
    fn models_dev_converter_prefers_cheapest_non_zero_provider() {
        let body = br#"{
          "z-provider": {
            "models": {
              "shared": { "cost": { "input": 2, "output": 8, "cache_read": 1 } },
              "free": { "cost": { "input": 0, "output": 0 } }
            }
          },
          "a-provider": {
            "models": {
              "shared": { "cost": { "input": 1, "output": 2, "cache_read": 0.5 } }
            }
          }
        }"#;
        let data = convert_models_dev_to_ratio_data(body).expect("converted");
        assert_eq!(data["model_ratio"]["shared"], number(0.5));
        assert_eq!(data["completion_ratio"]["shared"], number(2.0));
        assert_eq!(data["cache_ratio"]["shared"], number(0.5));
        assert_eq!(data["model_ratio"]["free"], number(0.0));
    }

    #[test]
    fn pricing_items_converter_maps_tiered_billing_fields() {
        let items = vec![
            PricingItem {
                model_name: "tiered".to_string(),
                quota_type: 0,
                model_ratio: 1.25,
                model_price: 0.0,
                completion_ratio: 2.0,
                cache_ratio: Some(0.5),
                create_cache_ratio: None,
                image_ratio: None,
                audio_ratio: None,
                audio_completion_ratio: None,
                billing_mode: BILLING_MODE_TIERED_EXPR.to_string(),
                billing_expr: "p * 2 + c".to_string(),
            },
            PricingItem {
                model_name: "fixed".to_string(),
                quota_type: 1,
                model_ratio: 0.0,
                model_price: 3.5,
                completion_ratio: 0.0,
                cache_ratio: None,
                create_cache_ratio: None,
                image_ratio: None,
                audio_ratio: None,
                audio_completion_ratio: None,
                billing_mode: String::new(),
                billing_expr: String::new(),
            },
        ];
        let data = convert_pricing_items(items);
        assert_eq!(data["model_ratio"]["tiered"], number(1.25));
        assert_eq!(data["completion_ratio"]["tiered"], number(2.0));
        assert_eq!(data["cache_ratio"]["tiered"], number(0.5));
        assert_eq!(
            data[BILLING_MODE_FIELD]["tiered"],
            Value::String(BILLING_MODE_TIERED_EXPR.to_string())
        );
        assert_eq!(
            data[BILLING_EXPR_FIELD]["tiered"],
            Value::String("p * 2 + c".to_string())
        );
        assert_eq!(data["model_price"]["fixed"], number(3.5));
    }

    #[test]
    fn differences_remove_channels_that_only_have_same_values() {
        let mut local = SyncData::new();
        local.insert(
            "model_ratio".to_string(),
            BTreeMap::from([("alpha".to_string(), number(1.0))]),
        );
        let successful = vec![
            SuccessfulChannel {
                name: "same-channel".to_string(),
                data: BTreeMap::from([(
                    "model_ratio".to_string(),
                    BTreeMap::from([("alpha".to_string(), number(1.0))]),
                )]),
            },
            SuccessfulChannel {
                name: "different-channel".to_string(),
                data: BTreeMap::from([(
                    "model_ratio".to_string(),
                    BTreeMap::from([("alpha".to_string(), number(2.0))]),
                )]),
            },
        ];

        let diff = build_differences(&local, &successful);
        let upstreams = &diff["alpha"]["model_ratio"].upstreams;
        assert_eq!(upstreams.len(), 1);
        assert_eq!(upstreams["different-channel"], number(2.0));
        assert!(!upstreams.contains_key("same-channel"));
    }

    #[test]
    fn full_url_builder_matches_special_endpoint_rules() {
        let upstream = UpstreamConfig {
            id: 1,
            name: "OpenRouter".to_string(),
            base_url: "https://openrouter.ai/".to_string(),
            endpoint: "openrouter".to_string(),
        };
        assert_eq!(
            build_full_url(&upstream, true).expect("url"),
            "https://openrouter.ai/v1/models"
        );

        let upstream = UpstreamConfig {
            id: 0,
            name: "custom".to_string(),
            base_url: "https://example.com/root/".to_string(),
            endpoint: "api/pricing".to_string(),
        };
        assert_eq!(
            build_full_url(&upstream, false).expect("url"),
            "https://example.com/root/api/pricing"
        );
    }
}
