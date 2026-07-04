//! Admin CRUD for the `models` metadata + `vendors` tables (Go
//! `controller/model_meta.go` + `controller/vendor_meta.go`, routes
//! `/api/models/*` and `/api/vendors/*`, AdminAuth).
//!
//! Model list/detail responses include the display enrichment the default
//! frontend reads from Go: bound channels, enabled groups, quota types, rule
//! match counts, endpoint backfill, and vendor counts.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::Duration;

use futures_util::future::{select, Either};
use futures_util::TryStreamExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{
    AbortController, D1Database, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_admin_auth,
    unix_timestamp,
};
use crate::admin_user::merged_ratio_map;
use crate::d1_repositories::{self, BoundChannel, ModelMetaFull, VendorFull};

// ---------------------------------------------------------------------------
// Shared helpers (module-local copies of the admin CRUD conventions)
// ---------------------------------------------------------------------------

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let value = url
        .query_pairs()
        .find(|(k, _)| k == key)?
        .1
        .trim()
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_pagination(req: &Request) -> (u32, u32) {
    let parse = |key: &str| -> Option<u32> { parse_query_string(req, key)?.parse().ok() };
    let page = parse("p").unwrap_or(1).max(1);
    let page_size = parse("page_size").unwrap_or(10).clamp(1, 100);
    (page, page_size)
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param?.trim().parse().ok()
}

/// The `{items,total,page,page_size}` list envelope shared by the Go admin
/// list endpoints.
#[derive(Serialize)]
struct Page<T: Serialize> {
    items: Vec<T>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[derive(Serialize)]
struct ModelsPage {
    items: Vec<EnrichedModelMeta>,
    total: i64,
    page: u32,
    page_size: u32,
    vendor_counts: HashMap<String, i64>,
}

#[derive(Serialize)]
struct EnrichedModelMeta {
    #[serde(flatten)]
    row: ModelMetaFull,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    bound_channels: Vec<BoundChannel>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    enable_groups: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    quota_types: Vec<i32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    matched_models: Vec<String>,
    #[serde(skip_serializing_if = "is_zero_usize")]
    matched_count: usize,
}

fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

fn parse_model_status_filter(value: Option<&str>) -> Option<i32> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "enabled" | "enable" | "1" => Some(1),
        "disabled" | "disable" | "0" => Some(0),
        _ => None,
    }
}

fn parse_model_sync_filter(value: Option<&str>) -> Option<i32> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "yes" | "official" | "true" | "1" => Some(1),
        "no" | "false" | "0" => Some(0),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Models metadata CRUD
// ---------------------------------------------------------------------------

/// Create/update request body (Go binds straight into `model.Model`).
#[derive(Debug, Deserialize, Default)]
pub struct ModelMetaRequest {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub vendor_id: i64,
    #[serde(default)]
    pub endpoints: String,
    #[serde(default = "default_status")]
    pub status: i32,
    #[serde(default = "default_sync_official")]
    pub sync_official: i32,
    #[serde(default)]
    pub name_rule: i32,
}

fn default_status() -> i32 {
    1
}
fn default_sync_official() -> i32 {
    1
}

/// `GET /api/models/` and `GET /api/models/search`: paginated live metadata
/// rows; search adds `keyword` + `vendor` filters (the plain list is the
/// search with no filters, so one handler serves both).
pub async fn list_models_meta(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let keyword = parse_query_string(&req, "keyword");
    let vendor_id = parse_query_string(&req, "vendor").and_then(|value| value.parse::<i64>().ok());
    let status = parse_model_status_filter(parse_query_string(&req, "status").as_deref());
    let sync_official =
        parse_model_sync_filter(parse_query_string(&req, "sync_official").as_deref());
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (items, total) = d1_repositories::list_models_meta(
        &db,
        keyword.as_deref(),
        vendor_id,
        status,
        sync_official,
        (page - 1) * page_size,
        page_size,
    )
    .await?;
    let items = enrich_model_meta_rows(&db, items).await?;
    let vendor_counts = d1_repositories::vendor_model_counts(&db).await?;
    envelope_ok_response(&ModelsPage {
        items,
        total,
        page,
        page_size,
        vendor_counts,
    })
}

/// `GET /api/models/:id`: one metadata row.
pub async fn get_model_meta(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid model id"));
    };
    let db = env.d1("DB")?;
    match d1_repositories::get_model_meta(&db, id).await? {
        Some(row) => {
            let mut rows = enrich_model_meta_rows(&db, vec![row]).await?;
            match rows.pop() {
                Some(row) => envelope_ok_response(&row),
                None => Ok(envelope_error_response(404, "model not found")),
            }
        }
        None => Ok(envelope_error_response(404, "model not found")),
    }
}

/// `POST /api/models/`: create a metadata row (name must be unique among live
/// rows; Go `CreateModelMeta`).
pub async fn create_model_meta(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ModelMetaRequest = serde_json::from_value(body).unwrap_or_default();
    let name = payload.model_name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(400, "model name must not be empty"));
    }
    let db = env.d1("DB")?;
    if d1_repositories::model_meta_name_duplicated(&db, 0, name).await? {
        return Ok(envelope_error_response(409, "model name already exists"));
    }
    let now = unix_timestamp();
    let id = d1_repositories::insert_model_meta(
        &db,
        &ModelMetaFull {
            id: 0,
            model_name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            tags: payload.tags,
            vendor_id: payload.vendor_id,
            endpoints: payload.endpoints,
            status: payload.status,
            sync_official: payload.sync_official,
            name_rule: payload.name_rule,
            created_time: now,
            updated_time: now,
        },
    )
    .await?;
    envelope_ok_response(&serde_json::json!({"id": id}))
}

/// `PUT /api/models/`: update a metadata row. `?status_only=true` flips only
/// the status (Go `UpdateModelMeta`).
pub async fn update_model_meta(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let status_only = parse_query_string(&req, "status_only").as_deref() == Some("true");
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: ModelMetaRequest = serde_json::from_value(body).unwrap_or_default();
    if payload.id == 0 {
        return Ok(envelope_error_response(400, "missing model id"));
    }
    let db = env.d1("DB")?;
    if status_only {
        d1_repositories::update_model_meta_status(&db, payload.id, payload.status).await?;
        return envelope_ok_response(&serde_json::Value::Null);
    }
    let name = payload.model_name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(400, "model name must not be empty"));
    }
    if d1_repositories::model_meta_name_duplicated(&db, payload.id, name).await? {
        return Ok(envelope_error_response(409, "model name already exists"));
    }
    d1_repositories::update_model_meta(
        &db,
        &ModelMetaFull {
            id: payload.id,
            model_name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            tags: payload.tags,
            vendor_id: payload.vendor_id,
            endpoints: payload.endpoints,
            status: payload.status,
            sync_official: payload.sync_official,
            name_rule: payload.name_rule,
            created_time: 0,
            updated_time: unix_timestamp(),
        },
    )
    .await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `DELETE /api/models/:id`: soft-delete a metadata row.
pub async fn delete_model_meta(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid model id"));
    };
    let db = env.d1("DB")?;
    d1_repositories::soft_delete_model_meta(&db, id, unix_timestamp()).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

async fn enrich_model_meta_rows(
    db: &D1Database,
    rows: Vec<ModelMetaFull>,
) -> WorkerResult<Vec<EnrichedModelMeta>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let pricing_rows = pricing_rows_for_enrichment(db).await?;
    let bound_model_names = model_names_for_bound_channels(&rows, &pricing_rows);
    let bound_channels = d1_repositories::bound_channels_by_models(db, &bound_model_names).await?;
    Ok(enrich_model_meta_rows_with_context(
        rows,
        &pricing_rows,
        &bound_channels,
    ))
}

async fn pricing_rows_for_enrichment(
    db: &D1Database,
) -> WorkerResult<Vec<crate::pricing_api::PricingRow>> {
    let opts = d1_repositories::option_values(
        db,
        &[
            "ModelRatio",
            "CompletionRatio",
            "ModelPrice",
            "CacheRatio",
            "CreateCacheRatio",
        ],
    )
    .await?;
    use cinatoken_core::default_ratios as dr;
    let maps = crate::pricing_api::PricingMaps {
        model_ratios: merged_ratio_map(dr::DEFAULT_MODEL_RATIO, opts[0].as_deref()),
        completion_ratios: merged_ratio_map(dr::DEFAULT_COMPLETION_RATIO, opts[1].as_deref()),
        model_prices: merged_ratio_map(dr::DEFAULT_MODEL_PRICE, opts[2].as_deref()),
        cache_ratios: merged_ratio_map(dr::DEFAULT_CACHE_RATIO, opts[3].as_deref()),
        create_cache_ratios: merged_ratio_map(dr::DEFAULT_CREATE_CACHE_RATIO, opts[4].as_deref()),
    };
    let abilities = d1_repositories::enabled_abilities_with_channel_type(db).await?;
    let meta_rows = d1_repositories::list_model_meta(db).await?;
    Ok(crate::pricing_api::build_pricing_rows(
        &abilities, &meta_rows, &maps,
    ))
}

fn model_names_for_bound_channels(
    rows: &[ModelMetaFull],
    pricing_rows: &[crate::pricing_api::PricingRow],
) -> Vec<String> {
    let mut names = Vec::new();
    for row in rows {
        if row.name_rule == 0 {
            push_unique_string(&mut names, row.model_name.clone());
            continue;
        }
        for pricing in pricing_rows {
            if model_name_rule_matches(row.name_rule, &row.model_name, &pricing.model_name) {
                push_unique_string(&mut names, pricing.model_name.clone());
            }
        }
    }
    names
}

fn enrich_model_meta_rows_with_context(
    rows: Vec<ModelMetaFull>,
    pricing_rows: &[crate::pricing_api::PricingRow],
    bound_channels: &HashMap<String, Vec<BoundChannel>>,
) -> Vec<EnrichedModelMeta> {
    let pricing_by_model = pricing_rows
        .iter()
        .map(|row| (row.model_name.as_str(), row))
        .collect::<HashMap<_, _>>();

    rows.into_iter()
        .map(|mut row| {
            if row.name_rule == 0 {
                let bound_channels = bound_channels
                    .get(&row.model_name)
                    .cloned()
                    .unwrap_or_default();
                let (enable_groups, quota_types) =
                    if let Some(pricing) = pricing_by_model.get(row.model_name.as_str()) {
                        if row.endpoints.trim().is_empty()
                            && !pricing.supported_endpoint_types.is_empty()
                        {
                            row.endpoints = endpoint_array_json(&pricing.supported_endpoint_types);
                        }
                        (pricing.enable_groups.clone(), vec![pricing.quota_type])
                    } else {
                        (Vec::new(), Vec::new())
                    };
                return EnrichedModelMeta {
                    row,
                    bound_channels,
                    enable_groups,
                    quota_types,
                    matched_models: Vec::new(),
                    matched_count: 0,
                };
            }

            let mut matched_models = Vec::new();
            let mut endpoint_union = Vec::<&'static str>::new();
            let mut group_union = BTreeSet::<String>::new();
            let mut quota_union = BTreeSet::<i32>::new();
            let mut channel_union = BTreeMap::<(String, i32), BoundChannel>::new();

            for pricing in pricing_rows {
                if !model_name_rule_matches(row.name_rule, &row.model_name, &pricing.model_name) {
                    continue;
                }
                push_unique_string(&mut matched_models, pricing.model_name.clone());
                for endpoint in &pricing.supported_endpoint_types {
                    if !endpoint_union.contains(endpoint) {
                        endpoint_union.push(*endpoint);
                    }
                }
                for group in &pricing.enable_groups {
                    group_union.insert(group.clone());
                }
                quota_union.insert(pricing.quota_type);
                if let Some(channels) = bound_channels.get(&pricing.model_name) {
                    for channel in channels {
                        channel_union.insert(
                            (channel.name.clone(), channel.channel_type),
                            channel.clone(),
                        );
                    }
                }
            }

            matched_models.sort();
            if row.endpoints.trim().is_empty() && !endpoint_union.is_empty() {
                row.endpoints = endpoint_array_json(&endpoint_union);
            }
            let matched_count = matched_models.len();
            EnrichedModelMeta {
                row,
                bound_channels: channel_union.into_values().collect(),
                enable_groups: group_union.into_iter().collect(),
                quota_types: quota_union.into_iter().collect(),
                matched_models,
                matched_count,
            }
        })
        .collect()
}

fn model_name_rule_matches(rule: i32, pattern: &str, model: &str) -> bool {
    match rule {
        0 => model == pattern,
        1 => model.starts_with(pattern),
        2 => model.contains(pattern),
        3 => model.ends_with(pattern),
        _ => false,
    }
}

fn endpoint_array_json(endpoints: &[&'static str]) -> String {
    serde_json::to_string(endpoints).unwrap_or_else(|_| "[]".to_string())
}

fn push_unique_string(values: &mut Vec<String>, value: String) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

/// `GET /api/models/missing`: enabled ability models with no metadata row
/// under the name rules (Go `GetMissingModels`).
pub async fn get_missing_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let enabled = d1_repositories::distinct_all_enabled_models(&db).await?;
    let meta_rows = d1_repositories::list_model_meta(&db).await?;
    let matched = crate::pricing_api::match_meta(&enabled, &meta_rows);
    let missing: Vec<&String> = enabled
        .iter()
        .filter(|model| !matched.contains_key(model.as_str()))
        .collect();
    envelope_ok_response(&missing)
}

// ---------------------------------------------------------------------------
// Official upstream metadata sync
// ---------------------------------------------------------------------------

// This Worker intentionally supports the public official repository only.
// Keeping the origin compile-time fixed avoids turning an admin endpoint into
// an SSRF primitive through a request or environment supplied base URL.
const OFFICIAL_UPSTREAM_BASE: &str = "https://basellm.github.io/llm-metadata";
const SYNC_BODY_LIMIT_BYTES: usize = 64 * 1024;
const UPSTREAM_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_SYNC_TIMEOUT_SECONDS: u64 = 15;
const MAX_SYNC_TIMEOUT_SECONDS: u64 = 30;
const MAX_OVERWRITE_MODELS: usize = 500;
const MODEL_PAGE_SIZE: u32 = 100;
const OVERWRITE_FIELDS: [&str; 6] = [
    "description",
    "icon",
    "tags",
    "vendor",
    "name_rule",
    "status",
];

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
struct SyncOverwrite {
    #[serde(default)]
    model_name: String,
    #[serde(default)]
    fields: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct SyncUpstreamRequest {
    #[serde(default)]
    locale: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    overwrite: Vec<SyncOverwrite>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct UpstreamModel {
    #[serde(default)]
    description: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    model_name: String,
    #[serde(default)]
    name_rule: i32,
    #[serde(default)]
    status: i32,
    #[serde(default)]
    tags: String,
    #[serde(default)]
    vendor_name: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct UpstreamVendor {
    #[serde(default)]
    description: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: i32,
}

#[derive(Debug, Deserialize)]
struct UpstreamEnvelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    message: String,
    #[serde(default = "empty_vec")]
    data: Vec<T>,
}

fn empty_vec<T>() -> Vec<T> {
    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncLocale {
    Default,
    Zh,
    En,
    Ja,
}

impl SyncLocale {
    fn parse(value: &str) -> std::result::Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" => Ok(Self::Default),
            "zh" | "zh-cn" | "zh-tw" => Ok(Self::Zh),
            "en" => Ok(Self::En),
            "ja" => Ok(Self::Ja),
            _ => Err("unsupported sync locale; expected zh, zh-CN, zh-TW, en, or ja".to_string()),
        }
    }

    fn response_value(self) -> &'static str {
        match self {
            Self::Default => "",
            Self::Zh => "zh",
            Self::En => "en",
            Self::Ja => "ja",
        }
    }

    fn path_segment(self) -> Option<&'static str> {
        match self {
            // The official repository has no zh-CN/zh-TW newapi path. The Go
            // controller also falls back to the default URL for frontend
            // locale "zh".
            Self::Default | Self::Zh => None,
            Self::En => Some("en"),
            Self::Ja => Some("ja"),
        }
    }
}

#[derive(Debug, Serialize)]
struct SyncSourceInfo {
    locale: &'static str,
    source: &'static str,
    models_url: String,
    vendors_url: String,
}

impl SyncSourceInfo {
    fn official(locale: SyncLocale) -> Self {
        let (models_url, vendors_url) = official_upstream_urls(locale);
        Self {
            locale: locale.response_value(),
            source: "official",
            models_url,
            vendors_url,
        }
    }
}

#[derive(Debug, Serialize)]
struct SyncResult {
    created_models: usize,
    created_vendors: usize,
    updated_models: usize,
    skipped_models: Vec<String>,
    created_list: Vec<String>,
    updated_list: Vec<String>,
    source: SyncSourceInfo,
}

#[derive(Debug, Serialize, PartialEq)]
struct ConflictField {
    field: &'static str,
    local: Value,
    upstream: Value,
}

#[derive(Debug, Serialize, PartialEq)]
struct ConflictItem {
    model_name: String,
    fields: Vec<ConflictField>,
}

#[derive(Debug, Serialize)]
struct PreviewResult {
    missing: Vec<String>,
    conflicts: Vec<ConflictItem>,
    source: SyncSourceInfo,
}

fn official_upstream_urls(locale: SyncLocale) -> (String, String) {
    let prefix = match locale.path_segment() {
        Some(segment) => format!("{OFFICIAL_UPSTREAM_BASE}/api/i18n/{segment}/newapi"),
        None => format!("{OFFICIAL_UPSTREAM_BASE}/api/newapi"),
    };
    (
        format!("{prefix}/models.json"),
        format!("{prefix}/vendors.json"),
    )
}

fn validate_source(value: &str) -> std::result::Result<(), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "official" => Ok(()),
        "config" => {
            Err("sync source 'config' is not supported by the Worker deployment".to_string())
        }
        _ => Err("unsupported sync source; expected official".to_string()),
    }
}

fn normalize_overwrites(
    overwrites: Vec<SyncOverwrite>,
) -> std::result::Result<Vec<SyncOverwrite>, String> {
    if overwrites.len() > MAX_OVERWRITE_MODELS {
        return Err(format!(
            "too many overwrite entries; maximum is {MAX_OVERWRITE_MODELS}"
        ));
    }

    let mut normalized = Vec::<SyncOverwrite>::new();
    let mut positions = HashMap::<String, usize>::new();
    for overwrite in overwrites {
        let model_name = overwrite.model_name.trim();
        if model_name.is_empty() {
            return Err("overwrite model_name must not be empty".to_string());
        }
        if model_name.len() > 512 {
            return Err("overwrite model_name is too long".to_string());
        }

        let position = if let Some(position) = positions.get(model_name) {
            *position
        } else {
            let position = normalized.len();
            positions.insert(model_name.to_string(), position);
            normalized.push(SyncOverwrite {
                model_name: model_name.to_string(),
                fields: Vec::new(),
            });
            position
        };
        for field in overwrite.fields {
            let field = field.trim().to_ascii_lowercase();
            if OVERWRITE_FIELDS.contains(&field.as_str())
                && !normalized[position].fields.contains(&field)
            {
                normalized[position].fields.push(field);
            }
        }
    }
    Ok(normalized)
}

fn parse_sync_request(bytes: &[u8]) -> std::result::Result<SyncUpstreamRequest, String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(SyncUpstreamRequest::default());
    }
    serde_json::from_slice(bytes).map_err(|err| format!("request body is not valid JSON: {err}"))
}

async fn read_sync_request(
    req: &mut Request,
) -> std::result::Result<SyncUpstreamRequest, Response> {
    let bytes = req.bytes().await.map_err(|err| {
        envelope_error_response(400, &format!("failed to read request body: {err}"))
    })?;
    if bytes.len() > SYNC_BODY_LIMIT_BYTES {
        return Err(envelope_error_response(413, "sync request body too large"));
    }
    parse_sync_request(&bytes).map_err(|message| envelope_error_response(400, &message))
}

fn sync_timeout(env: &Env) -> Duration {
    let seconds = env
        .var("SYNC_HTTP_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.to_string().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SYNC_TIMEOUT_SECONDS)
        .clamp(1, MAX_SYNC_TIMEOUT_SECONDS);
    Duration::from_secs(seconds)
}

fn parse_upstream_payload<T: DeserializeOwned>(
    bytes: &[u8],
) -> std::result::Result<Vec<T>, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|err| format!("invalid JSON: {err}"))?;
    if value.is_array() {
        return serde_json::from_value(value).map_err(|err| format!("invalid data array: {err}"));
    }

    let envelope: UpstreamEnvelope<T> =
        serde_json::from_value(value).map_err(|err| format!("invalid response envelope: {err}"))?;
    if !envelope.success && envelope.data.is_empty() && !envelope.message.is_empty() {
        return Err(format!("upstream rejected request: {}", envelope.message));
    }
    Ok(envelope.data)
}

async fn fetch_official_json<T: DeserializeOwned>(
    url: &str,
    timeout: Duration,
) -> std::result::Result<Vec<T>, String> {
    // Build a fresh request with only an Accept header. In particular, admin
    // Authorization/Cookie headers and any provider keys are never forwarded.
    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let outbound = Request::new_with_init(url, &init).map_err(|err| err.to_string())?;

    let controller = AbortController::default();
    let signal = controller.signal();
    let fetch = Fetch::Request(outbound);
    let operation = async move {
        let mut response = fetch
            .send_with_signal(&signal)
            .await
            .map_err(|err| format!("upstream request failed: {err}"))?;
        if !(200..300).contains(&response.status_code()) {
            return Err(format!(
                "upstream returned status {}",
                response.status_code()
            ));
        }
        if let Some(content_length) = response
            .headers()
            .get("Content-Length")
            .map_err(|err| err.to_string())?
        {
            if content_length
                .parse::<usize>()
                .ok()
                .is_some_and(|length| length > UPSTREAM_BODY_LIMIT_BYTES)
            {
                return Err("upstream response exceeds 5 MiB limit".to_string());
            }
        }

        let bytes = response
            .stream()
            .map_err(|err| format!("failed to read upstream response: {err}"))?
            .try_fold(Vec::new(), |mut bytes, chunk| async move {
                if bytes.len().saturating_add(chunk.len()) > UPSTREAM_BODY_LIMIT_BYTES {
                    return Err(worker::Error::RustError(
                        "upstream response exceeds 5 MiB limit".to_string(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
                Ok(bytes)
            })
            .await
            .map_err(|err| format!("failed to read upstream response: {err}"))?;
        parse_upstream_payload(&bytes)
    };
    let timeout_future = Box::pin(Delay::from(timeout));
    match select(Box::pin(operation), timeout_future).await {
        Either::Left((result, _)) => result,
        Either::Right((_, pending_operation)) => {
            drop(pending_operation);
            controller.abort();
            Err(format!(
                "upstream request timed out after {} seconds",
                timeout.as_secs()
            ))
        }
    }
}

async fn load_all_models(db: &D1Database) -> WorkerResult<Vec<ModelMetaFull>> {
    let mut rows = Vec::new();
    loop {
        let offset = u32::try_from(rows.len()).unwrap_or(u32::MAX);
        let (mut page, total) =
            d1_repositories::list_models_meta(db, None, None, None, None, offset, MODEL_PAGE_SIZE)
                .await?;
        let page_len = page.len();
        rows.append(&mut page);
        if page_len == 0 || i64::try_from(rows.len()).unwrap_or(i64::MAX) >= total {
            break;
        }
    }
    Ok(rows)
}

fn exact_missing_models(enabled: &[String], locals: &[ModelMetaFull]) -> Vec<String> {
    let existing: HashSet<&str> = locals.iter().map(|row| row.model_name.as_str()).collect();
    enabled
        .iter()
        .filter(|name| !existing.contains(name.as_str()))
        .cloned()
        .collect()
}

fn choose_status(primary: i32, fallback: i32) -> i32 {
    if primary != 0 {
        primary
    } else if fallback != 0 {
        fallback
    } else {
        1
    }
}

fn upstream_models_by_name(models: Vec<UpstreamModel>) -> HashMap<String, UpstreamModel> {
    models
        .into_iter()
        .filter(|model| !model.model_name.trim().is_empty())
        .map(|mut model| {
            model.model_name = model.model_name.trim().to_string();
            (model.model_name.clone(), model)
        })
        .collect()
}

fn upstream_vendors_by_name(vendors: Vec<UpstreamVendor>) -> HashMap<String, UpstreamVendor> {
    vendors
        .into_iter()
        .filter(|vendor| !vendor.name.trim().is_empty())
        .map(|mut vendor| {
            vendor.name = vendor.name.trim().to_string();
            (vendor.name.clone(), vendor)
        })
        .collect()
}

fn conflict_fields(
    local: &ModelMetaFull,
    upstream: &UpstreamModel,
    local_vendor_name: &str,
) -> Vec<ConflictField> {
    let mut fields = Vec::new();
    if local.description.trim() != upstream.description.trim() {
        fields.push(ConflictField {
            field: "description",
            local: Value::String(local.description.clone()),
            upstream: Value::String(upstream.description.clone()),
        });
    }
    if local.icon.trim() != upstream.icon.trim() {
        fields.push(ConflictField {
            field: "icon",
            local: Value::String(local.icon.clone()),
            upstream: Value::String(upstream.icon.clone()),
        });
    }
    if local.tags.trim() != upstream.tags.trim() {
        fields.push(ConflictField {
            field: "tags",
            local: Value::String(local.tags.clone()),
            upstream: Value::String(upstream.tags.clone()),
        });
    }
    if local_vendor_name.trim() != upstream.vendor_name.trim() {
        fields.push(ConflictField {
            field: "vendor",
            local: Value::String(local_vendor_name.to_string()),
            upstream: Value::String(upstream.vendor_name.clone()),
        });
    }
    if local.name_rule != upstream.name_rule {
        fields.push(ConflictField {
            field: "name_rule",
            local: Value::from(local.name_rule),
            upstream: Value::from(upstream.name_rule),
        });
    }
    if local.status != choose_status(upstream.status, local.status) {
        fields.push(ConflictField {
            field: "status",
            local: Value::from(local.status),
            upstream: Value::from(upstream.status),
        });
    }
    fields
}

fn build_preview(
    enabled: &[String],
    locals: &[ModelMetaFull],
    upstream_models: &HashMap<String, UpstreamModel>,
    vendor_names: &HashMap<i64, String>,
) -> (Vec<String>, Vec<ConflictItem>) {
    let missing = exact_missing_models(enabled, locals)
        .into_iter()
        .filter(|name| upstream_models.contains_key(name))
        .collect();
    let conflicts = locals
        .iter()
        .filter(|local| local.sync_official != 0)
        .filter_map(|local| {
            let upstream = upstream_models.get(&local.model_name)?;
            let vendor_name = vendor_names
                .get(&local.vendor_id)
                .map(String::as_str)
                .unwrap_or("");
            let fields = conflict_fields(local, upstream, vendor_name);
            (!fields.is_empty()).then(|| ConflictItem {
                model_name: local.model_name.clone(),
                fields,
            })
        })
        .collect();
    (missing, conflicts)
}

fn apply_overwrite(
    local: &mut ModelMetaFull,
    upstream: &UpstreamModel,
    fields: &[String],
    upstream_vendor_id: i64,
) -> bool {
    let mut changed = false;
    for field in fields {
        match field.as_str() {
            "description" => local.description = upstream.description.clone(),
            "icon" => local.icon = upstream.icon.clone(),
            "tags" => local.tags = upstream.tags.clone(),
            "vendor" => local.vendor_id = upstream_vendor_id,
            "name_rule" => local.name_rule = upstream.name_rule,
            "status" => local.status = choose_status(upstream.status, local.status),
            _ => continue,
        }
        changed = true;
    }
    changed
}

async fn ensure_vendor_id(
    db: &D1Database,
    vendor_name: &str,
    upstream_vendors: &HashMap<String, UpstreamVendor>,
    vendor_ids: &mut HashMap<String, i64>,
    created_vendors: &mut usize,
) -> i64 {
    let vendor_name = vendor_name.trim();
    if vendor_name.is_empty() {
        return 0;
    }
    if let Some(id) = vendor_ids.get(vendor_name) {
        return *id;
    }

    let upstream = upstream_vendors
        .get(vendor_name)
        .cloned()
        .unwrap_or_default();
    let now = unix_timestamp();
    let result = d1_repositories::insert_vendor(
        db,
        &VendorFull {
            id: 0,
            name: vendor_name.to_string(),
            description: upstream.description,
            icon: upstream.icon,
            status: choose_status(upstream.status, 1),
            created_time: now,
            updated_time: now,
        },
    )
    .await;
    match result {
        Ok(id) => {
            *created_vendors += 1;
            vendor_ids.insert(vendor_name.to_string(), id);
            id
        }
        Err(err) => {
            worker::console_error!("failed to create sync vendor '{}': {}", vendor_name, err);
            vendor_ids.insert(vendor_name.to_string(), 0);
            0
        }
    }
}

/// `GET /api/models/sync_upstream/preview?locale&source`: preview official
/// metadata additions and selectable conflicts without modifying D1.
pub async fn preview_upstream_models(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let locale =
        match SyncLocale::parse(parse_query_string(&req, "locale").as_deref().unwrap_or("")) {
            Ok(locale) => locale,
            Err(message) => return Ok(envelope_error_response(400, &message)),
        };
    if let Err(message) =
        validate_source(parse_query_string(&req, "source").as_deref().unwrap_or(""))
    {
        return Ok(envelope_error_response(400, &message));
    }

    let source = SyncSourceInfo::official(locale);
    let timeout = sync_timeout(&env);
    let (models_result, vendors_result) = futures_util::join!(
        fetch_official_json::<UpstreamModel>(&source.models_url, timeout),
        fetch_official_json::<UpstreamVendor>(&source.vendors_url, timeout)
    );
    let upstream_models = match models_result {
        Ok(models) => upstream_models_by_name(models),
        Err(message) => {
            return Ok(envelope_error_response(
                502,
                &format!("failed to fetch upstream models: {message}"),
            ));
        }
    };
    // The Go endpoint treats vendor metadata as optional. Model rows still
    // carry vendor names, so preview remains useful if vendors.json is down.
    let _upstream_vendors = vendors_result.unwrap_or_default();

    let db = env.d1("DB")?;
    let enabled = d1_repositories::distinct_all_enabled_models(&db).await?;
    let locals = load_all_models(&db).await?;
    let vendor_names: HashMap<i64, String> = d1_repositories::list_vendors(&db)
        .await?
        .into_iter()
        .map(|vendor| (vendor.id, vendor.name))
        .collect();
    let (missing, conflicts) = build_preview(&enabled, &locals, &upstream_models, &vendor_names);
    envelope_ok_response(&PreviewResult {
        missing,
        conflicts,
        source,
    })
}

/// `POST /api/models/sync_upstream`: create exact-name missing metadata and
/// optionally overwrite selected fields on rows with `sync_official != 0`.
pub async fn sync_upstream_models(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let request = match read_sync_request(&mut req).await {
        Ok(request) => request,
        Err(response) => return Ok(response),
    };
    if let Err(message) = validate_source(&request.source) {
        return Ok(envelope_error_response(400, &message));
    }
    let locale = match SyncLocale::parse(&request.locale) {
        Ok(locale) => locale,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let overwrites = match normalize_overwrites(request.overwrite) {
        Ok(overwrites) => overwrites,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let source = SyncSourceInfo::official(locale);

    let db = env.d1("DB")?;
    let enabled = d1_repositories::distinct_all_enabled_models(&db).await?;
    let mut locals = load_all_models(&db).await?;
    let missing = exact_missing_models(&enabled, &locals);
    if missing.is_empty() && overwrites.is_empty() {
        return envelope_ok_response(&SyncResult {
            created_models: 0,
            created_vendors: 0,
            updated_models: 0,
            skipped_models: Vec::new(),
            created_list: Vec::new(),
            updated_list: Vec::new(),
            source,
        });
    }

    let timeout = sync_timeout(&env);
    let (models_result, vendors_result) = futures_util::join!(
        fetch_official_json::<UpstreamModel>(&source.models_url, timeout),
        fetch_official_json::<UpstreamVendor>(&source.vendors_url, timeout)
    );
    let upstream_models = match models_result {
        Ok(models) => upstream_models_by_name(models),
        Err(message) => {
            return Ok(envelope_error_response(
                502,
                &format!("failed to fetch upstream models: {message}"),
            ));
        }
    };
    let upstream_vendors = upstream_vendors_by_name(vendors_result.unwrap_or_default());
    let mut vendor_ids: HashMap<String, i64> = d1_repositories::list_vendors(&db)
        .await?
        .into_iter()
        .map(|vendor| (vendor.name, vendor.id))
        .collect();

    let mut created_models = 0;
    let mut created_vendors = 0;
    let mut updated_models = 0;
    let mut skipped_models = Vec::new();
    let mut created_list = Vec::new();
    let mut updated_list = Vec::new();

    for name in missing {
        let Some(upstream) = upstream_models.get(&name) else {
            skipped_models.push(name);
            continue;
        };
        let vendor_id = ensure_vendor_id(
            &db,
            &upstream.vendor_name,
            &upstream_vendors,
            &mut vendor_ids,
            &mut created_vendors,
        )
        .await;
        let now = unix_timestamp();
        let row = ModelMetaFull {
            id: 0,
            model_name: name.clone(),
            description: upstream.description.clone(),
            icon: upstream.icon.clone(),
            tags: upstream.tags.clone(),
            vendor_id,
            endpoints: String::new(),
            status: choose_status(upstream.status, 1),
            // Go's Model.Insert preserves this zero value for sync-created
            // rows, so later official overwrites remain opt-in.
            sync_official: 0,
            name_rule: upstream.name_rule,
            created_time: now,
            updated_time: now,
        };
        match d1_repositories::insert_model_meta(&db, &row).await {
            Ok(id) => {
                locals.push(ModelMetaFull { id, ..row });
                created_models += 1;
                created_list.push(name);
            }
            Err(err) => {
                worker::console_error!("failed to create synced model '{}': {}", name, err);
                skipped_models.push(name);
            }
        }
    }

    let local_positions: HashMap<String, usize> = locals
        .iter()
        .enumerate()
        .map(|(index, row)| (row.model_name.clone(), index))
        .collect();
    for overwrite in overwrites {
        let Some(upstream) = upstream_models.get(&overwrite.model_name) else {
            continue;
        };
        let Some(index) = local_positions.get(&overwrite.model_name).copied() else {
            continue;
        };
        if locals[index].sync_official == 0 {
            continue;
        }

        // Match the Go controller: resolving the upstream vendor happens for
        // every accepted overwrite item, even when "vendor" is not selected.
        let vendor_id = ensure_vendor_id(
            &db,
            &upstream.vendor_name,
            &upstream_vendors,
            &mut vendor_ids,
            &mut created_vendors,
        )
        .await;
        if apply_overwrite(&mut locals[index], upstream, &overwrite.fields, vendor_id) {
            locals[index].updated_time = unix_timestamp();
            match d1_repositories::update_model_meta(&db, &locals[index]).await {
                Ok(()) => {
                    updated_models += 1;
                    updated_list.push(overwrite.model_name);
                }
                Err(err) => {
                    worker::console_error!(
                        "failed to update synced model '{}': {}",
                        overwrite.model_name,
                        err
                    );
                }
            }
        }
    }

    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "model.sync_upstream",
        &format!("admin {} synced official model metadata", claims.username),
        &serde_json::json!({
            "created_models": created_models,
            "created_vendors": created_vendors,
            "updated_models": updated_models,
            "skipped_models": skipped_models.len(),
            "locale": source.locale,
            "source": source.source
        }),
        &crate::admin::admin_audit_info(&claims, &req),
        unix_timestamp(),
    )
    .await;

    envelope_ok_response(&SyncResult {
        created_models,
        created_vendors,
        updated_models,
        skipped_models,
        created_list,
        updated_list,
        source,
    })
}

// ---------------------------------------------------------------------------
// Vendors CRUD
// ---------------------------------------------------------------------------

/// Create/update request body (Go binds into `model.Vendor`).
#[derive(Debug, Deserialize, Default)]
pub struct VendorRequest {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_status")]
    pub status: i32,
}

/// `GET /api/vendors/` and `GET /api/vendors/search`: paginated live vendors
/// (search adds `keyword`).
pub async fn list_vendors(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let keyword = parse_query_string(&req, "keyword");
    let (page, page_size) = parse_pagination(&req);
    let db = env.d1("DB")?;
    let (items, total) = d1_repositories::list_vendors_page(
        &db,
        keyword.as_deref(),
        (page - 1) * page_size,
        page_size,
    )
    .await?;
    envelope_ok_response(&Page {
        items,
        total,
        page,
        page_size,
    })
}

/// `GET /api/vendors/:id`: one vendor.
pub async fn get_vendor(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid vendor id"));
    };
    let db = env.d1("DB")?;
    match d1_repositories::get_vendor(&db, id).await? {
        Some(row) => envelope_ok_response(&row),
        None => Ok(envelope_error_response(404, "vendor not found")),
    }
}

/// `POST /api/vendors/`: create a vendor (unique live name).
pub async fn create_vendor(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: VendorRequest = serde_json::from_value(body).unwrap_or_default();
    let name = payload.name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(
            400,
            "vendor name must not be empty",
        ));
    }
    let db = env.d1("DB")?;
    if d1_repositories::vendor_name_duplicated(&db, 0, name).await? {
        return Ok(envelope_error_response(409, "vendor name already exists"));
    }
    let now = unix_timestamp();
    let id = d1_repositories::insert_vendor(
        &db,
        &VendorFull {
            id: 0,
            name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            status: payload.status,
            created_time: now,
            updated_time: now,
        },
    )
    .await?;
    envelope_ok_response(&serde_json::json!({"id": id}))
}

/// `PUT /api/vendors/`: update a vendor.
pub async fn update_vendor(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: VendorRequest = serde_json::from_value(body).unwrap_or_default();
    if payload.id == 0 {
        return Ok(envelope_error_response(400, "missing vendor id"));
    }
    let name = payload.name.trim();
    if name.is_empty() {
        return Ok(envelope_error_response(
            400,
            "vendor name must not be empty",
        ));
    }
    let db = env.d1("DB")?;
    if d1_repositories::vendor_name_duplicated(&db, payload.id, name).await? {
        return Ok(envelope_error_response(409, "vendor name already exists"));
    }
    d1_repositories::update_vendor(
        &db,
        &VendorFull {
            id: payload.id,
            name: name.to_string(),
            description: payload.description,
            icon: payload.icon,
            status: payload.status,
            created_time: 0,
            updated_time: unix_timestamp(),
        },
    )
    .await?;
    envelope_ok_response(&serde_json::Value::Null)
}

/// `DELETE /api/vendors/:id`: soft-delete a vendor.
pub async fn delete_vendor(
    req: Request,
    env: Env,
    id_param: Option<&String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid vendor id"));
    };
    let db = env.d1("DB")?;
    d1_repositories::soft_delete_vendor(&db, id, unix_timestamp()).await?;
    envelope_ok_response(&serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(name: &str) -> ModelMetaFull {
        ModelMetaFull {
            id: 1,
            model_name: name.to_string(),
            description: "local description".to_string(),
            icon: "local-icon".to_string(),
            tags: "local,tags".to_string(),
            vendor_id: 7,
            endpoints: r#"[{"type":"openai"}]"#.to_string(),
            status: 0,
            sync_official: 1,
            name_rule: 0,
            created_time: 10,
            updated_time: 20,
        }
    }

    fn pricing_row(
        name: &str,
        groups: &[&str],
        quota_type: i32,
        endpoints: Vec<&'static str>,
    ) -> crate::pricing_api::PricingRow {
        crate::pricing_api::PricingRow {
            model_name: name.to_string(),
            enable_groups: groups.iter().map(|group| (*group).to_string()).collect(),
            quota_type,
            supported_endpoint_types: endpoints,
            ..Default::default()
        }
    }

    fn upstream(name: &str) -> UpstreamModel {
        UpstreamModel {
            model_name: name.to_string(),
            description: "upstream description".to_string(),
            icon: "upstream-icon".to_string(),
            tags: "upstream,tags".to_string(),
            vendor_name: "Upstream Vendor".to_string(),
            status: 1,
            name_rule: 2,
        }
    }

    #[test]
    fn model_filter_values_match_frontend_query_values() {
        assert_eq!(parse_model_status_filter(Some("enabled")), Some(1));
        assert_eq!(parse_model_status_filter(Some("disabled")), Some(0));
        assert_eq!(parse_model_status_filter(Some("all")), None);
        assert_eq!(parse_model_sync_filter(Some("yes")), Some(1));
        assert_eq!(parse_model_sync_filter(Some("no")), Some(0));
        assert_eq!(parse_model_sync_filter(Some("all")), None);
    }

    #[test]
    fn enrich_exact_model_adds_display_fields() {
        let mut row = model("gpt-4o");
        row.endpoints = String::new();
        let pricing = vec![pricing_row(
            "gpt-4o",
            &["vip", "default"],
            1,
            vec!["openai", "embeddings"],
        )];
        let bound = HashMap::from([(
            "gpt-4o".to_string(),
            vec![BoundChannel {
                name: "primary".to_string(),
                channel_type: 1,
            }],
        )]);

        let enriched = enrich_model_meta_rows_with_context(vec![row], &pricing, &bound);
        let row = &enriched[0];

        assert_eq!(row.row.endpoints, r#"["openai","embeddings"]"#);
        assert_eq!(row.enable_groups, vec!["vip", "default"]);
        assert_eq!(row.quota_types, vec![1]);
        assert_eq!(row.bound_channels[0].name, "primary");
        assert_eq!(row.bound_channels[0].channel_type, 1);
        assert!(row.matched_models.is_empty());
        assert_eq!(row.matched_count, 0);
    }

    #[test]
    fn enrich_rule_model_aggregates_matches() {
        let mut row = model("gpt-");
        row.name_rule = 1;
        row.endpoints = String::new();
        let pricing = vec![
            pricing_row("gpt-4o", &["default"], 0, vec!["openai"]),
            pricing_row("gpt-4o-mini", &["vip"], 1, vec!["openai", "embeddings"]),
            pricing_row("claude-3", &["default"], 0, vec!["anthropic"]),
        ];
        let bound = HashMap::from([
            (
                "gpt-4o".to_string(),
                vec![BoundChannel {
                    name: "a".to_string(),
                    channel_type: 1,
                }],
            ),
            (
                "gpt-4o-mini".to_string(),
                vec![BoundChannel {
                    name: "b".to_string(),
                    channel_type: 24,
                }],
            ),
        ]);

        let enriched = enrich_model_meta_rows_with_context(vec![row], &pricing, &bound);
        let row = &enriched[0];

        assert_eq!(
            row.matched_models,
            vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
        );
        assert_eq!(row.matched_count, 2);
        assert_eq!(row.row.endpoints, r#"["openai","embeddings"]"#);
        assert_eq!(
            row.enable_groups,
            vec!["default".to_string(), "vip".to_string()]
        );
        assert_eq!(row.quota_types, vec![0, 1]);
        assert_eq!(row.bound_channels.len(), 2);
    }

    #[test]
    fn official_urls_are_fixed_and_locale_is_enumerated() {
        let locale = SyncLocale::parse("zh").unwrap();
        let (models, vendors) = official_upstream_urls(locale);
        assert_eq!(
            models,
            "https://basellm.github.io/llm-metadata/api/newapi/models.json"
        );
        assert_eq!(
            vendors,
            "https://basellm.github.io/llm-metadata/api/newapi/vendors.json"
        );
        assert!(SyncLocale::parse("https://127.0.0.1/").is_err());
        assert!(validate_source("config").is_err());
        assert!(validate_source("official").is_ok());
    }

    #[test]
    fn sync_request_allows_empty_body_and_normalizes_overwrites() {
        assert!(parse_sync_request(b" \r\n\t").unwrap().overwrite.is_empty());
        let request = parse_sync_request(
            br#"{"locale":"en","source":"official","overwrite":[
                {"model_name":" model-a ","fields":["Description","unknown"]},
                {"model_name":"model-a","fields":["description","vendor"]}
            ]}"#,
        )
        .unwrap();
        let overwrites = normalize_overwrites(request.overwrite).unwrap();
        assert_eq!(
            overwrites,
            vec![SyncOverwrite {
                model_name: "model-a".to_string(),
                fields: vec!["description".to_string(), "vendor".to_string()],
            }]
        );
        assert!(parse_sync_request(b"{").is_err());
    }

    #[test]
    fn upstream_payload_accepts_envelope_and_array() {
        let envelope = br#"{"success":true,"data":[{"model_name":"model-a"}]}"#;
        let array = br#"[{"model_name":"model-b"}]"#;
        let from_envelope: Vec<UpstreamModel> = parse_upstream_payload(envelope).unwrap();
        let from_array: Vec<UpstreamModel> = parse_upstream_payload(array).unwrap();
        assert_eq!(from_envelope[0].model_name, "model-a");
        assert_eq!(from_array[0].model_name, "model-b");
    }

    #[test]
    fn missing_models_use_exact_names_like_source_controller() {
        let enabled = vec!["gpt-4".to_string(), "gpt-4o".to_string()];
        let mut prefix = model("gpt-");
        prefix.name_rule = 1;
        assert_eq!(exact_missing_models(&enabled, &[prefix]), enabled);
    }

    #[test]
    fn preview_reports_fields_and_skips_opted_out_rows() {
        let enabled = vec!["missing".to_string()];
        let local = model("existing");
        let mut opted_out = model("opted-out");
        opted_out.sync_official = 0;
        let upstream_models = upstream_models_by_name(vec![
            upstream("missing"),
            upstream("existing"),
            upstream("opted-out"),
        ]);
        let vendor_names = HashMap::from([(7, "Local Vendor".to_string())]);
        let (missing, conflicts) = build_preview(
            &enabled,
            &[local, opted_out],
            &upstream_models,
            &vendor_names,
        );
        assert_eq!(missing, vec!["missing"]);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].model_name, "existing");
        assert!(conflicts[0]
            .fields
            .iter()
            .any(|field| field.field == "vendor"));
        assert!(!conflicts[0]
            .fields
            .iter()
            .any(|field| field.field == "endpoints"));
    }

    #[test]
    fn overwrite_updates_selected_fields_only() {
        let mut local = model("existing");
        let old_icon = local.icon.clone();
        let old_endpoints = local.endpoints.clone();
        let old_sync_official = local.sync_official;
        let changed = apply_overwrite(
            &mut local,
            &upstream("existing"),
            &["description".to_string(), "vendor".to_string()],
            99,
        );
        assert!(changed);
        assert_eq!(local.description, "upstream description");
        assert_eq!(local.vendor_id, 99);
        assert_eq!(local.icon, old_icon);
        assert_eq!(local.endpoints, old_endpoints);
        assert_eq!(local.sync_official, old_sync_official);
    }

    #[test]
    fn zero_upstream_status_preserves_nonzero_local_status() {
        assert_eq!(choose_status(0, -1), -1);
        assert_eq!(choose_status(0, 0), 1);
        assert_eq!(choose_status(2, 1), 2);
    }
}
