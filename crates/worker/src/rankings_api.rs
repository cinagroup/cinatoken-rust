//! Public rankings endpoint.
//!
//! Mirrors Go `controller/rankings.go` + `service/rankings.go`, with one
//! Cloudflare-native storage difference: Go reads a background-fed
//! `quota_data` table, while this Worker reads the already indexed `logs`
//! table live, matching the Rust dashboard data endpoints.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, require_user_auth, unix_timestamp,
};
use crate::d1_repositories::{self, RankingQuotaBucket, RankingQuotaTotal};

const RANKING_LEADERBOARD_LIMIT: usize = 20;
const RANKING_HISTORY_LIMIT: usize = 10;
const RANKING_VENDOR_LIMIT: usize = 5;
const RANKING_MOVER_LIMIT: usize = 6;
const RANKING_OTHERS_LABEL: &str = "Others";
const RANKING_UNKNOWN_VENDOR: &str = "Unknown";

/// `GET /api/rankings`: public or authenticated according to
/// `HeaderNavModules.rankings`, matching Go `HeaderNavModuleAuth("rankings")`.
pub async fn get_rankings(req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let access = rankings_access(&db).await?;
    if !access.enabled {
        return Ok(envelope_error_response(403, "rankings is disabled"));
    }
    if access.require_auth {
        match require_user_auth(&req, &env).await? {
            Ok(_) => {}
            Err(response) => return Ok(response),
        }
    }

    let period = parse_query_string(&req, "period").unwrap_or_else(|| "week".to_string());
    let config = match ranking_config(&period) {
        Ok(config) => config,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let snapshot = build_rankings_snapshot(&db, config, unix_timestamp()).await?;
    envelope_ok_response(&snapshot)
}

async fn rankings_access(db: &worker::D1Database) -> WorkerResult<HeaderNavAccess> {
    let raw = d1_repositories::get_option(db, "HeaderNavModules").await?;
    Ok(parse_header_nav_access(raw.as_deref(), "rankings"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HeaderNavAccess {
    enabled: bool,
    require_auth: bool,
}

fn parse_header_nav_access(raw: Option<&str>, module: &str) -> HeaderNavAccess {
    let fallback = HeaderNavAccess {
        enabled: true,
        require_auth: false,
    };
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return fallback;
    };
    let raw_module = parsed.get(module);
    match raw_module {
        Some(Value::Object(value)) => HeaderNavAccess {
            enabled: parse_header_nav_bool(value.get("enabled"), fallback.enabled),
            require_auth: parse_header_nav_bool(value.get("requireAuth"), fallback.require_auth),
        },
        Some(value) => HeaderNavAccess {
            enabled: parse_header_nav_bool(Some(value), fallback.enabled),
            require_auth: fallback.require_auth,
        },
        None => fallback,
    }
}

fn parse_header_nav_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => {
            if value.as_i64() == Some(1) || value.as_f64() == Some(1.0) {
                true
            } else if value.as_i64() == Some(0) || value.as_f64() == Some(0.0) {
                false
            } else {
                fallback
            }
        }
        Some(Value::String(value)) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => fallback,
        },
        _ => fallback,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RankingLabelKind {
    Hour,
    Day,
    Month,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RankingPeriodConfig {
    id: &'static str,
    duration_seconds: Option<i64>,
    bucket_size: i64,
    label_kind: RankingLabelKind,
    has_previous: bool,
}

fn ranking_config(period: &str) -> std::result::Result<RankingPeriodConfig, String> {
    match period {
        "" | "week" => Ok(RankingPeriodConfig {
            id: "week",
            duration_seconds: Some(7 * 24 * 3600),
            bucket_size: 24 * 3600,
            label_kind: RankingLabelKind::Day,
            has_previous: true,
        }),
        "today" => Ok(RankingPeriodConfig {
            id: "today",
            duration_seconds: Some(24 * 3600),
            bucket_size: 3600,
            label_kind: RankingLabelKind::Hour,
            has_previous: true,
        }),
        "month" => Ok(RankingPeriodConfig {
            id: "month",
            duration_seconds: Some(30 * 24 * 3600),
            bucket_size: 24 * 3600,
            label_kind: RankingLabelKind::Day,
            has_previous: true,
        }),
        "year" => Ok(RankingPeriodConfig {
            id: "year",
            duration_seconds: Some(365 * 24 * 3600),
            bucket_size: 7 * 24 * 3600,
            label_kind: RankingLabelKind::Day,
            has_previous: true,
        }),
        "all" => Ok(RankingPeriodConfig {
            id: "all",
            duration_seconds: None,
            bucket_size: 30 * 24 * 3600,
            label_kind: RankingLabelKind::Month,
            has_previous: false,
        }),
        _ => Err(format!("invalid ranking period: {period}")),
    }
}

#[derive(Debug, Serialize)]
struct RankingsSnapshot {
    models: Vec<RankedModel>,
    vendors: Vec<RankedVendor>,
    top_movers: Vec<RankingMover>,
    top_droppers: Vec<RankingMover>,
    models_history: ModelHistorySeries,
    vendor_share_history: VendorShareSeries,
}

#[derive(Debug, Clone, Serialize)]
struct RankedModel {
    rank: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_rank: Option<usize>,
    model_name: String,
    vendor: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    vendor_icon: String,
    category: &'static str,
    total_tokens: i64,
    share: f64,
    growth_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
struct RankedVendor {
    rank: usize,
    vendor: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    vendor_icon: String,
    total_tokens: i64,
    share: f64,
    growth_pct: f64,
    models_count: usize,
    top_model: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct RankingMover {
    model_name: String,
    vendor: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    vendor_icon: String,
    rank_delta: isize,
    current_rank: usize,
    growth_pct: f64,
}

#[derive(Debug, Serialize)]
struct ModelHistoryPoint {
    ts: String,
    label: String,
    model: String,
    vendor: String,
    tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
struct ModelHistoryModel {
    name: String,
    vendor: String,
    total: i64,
}

#[derive(Debug, Serialize)]
struct ModelHistorySeries {
    points: Vec<ModelHistoryPoint>,
    models: Vec<ModelHistoryModel>,
    buckets: usize,
}

#[derive(Debug, Serialize)]
struct VendorSharePoint {
    ts: String,
    label: String,
    vendor: String,
    share: f64,
    tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
struct VendorShareVendor {
    name: String,
    total: i64,
    share: f64,
}

#[derive(Debug, Serialize)]
struct VendorShareSeries {
    points: Vec<VendorSharePoint>,
    vendors: Vec<VendorShareVendor>,
    buckets: usize,
}

#[derive(Debug, Clone)]
struct RankingModelMeta {
    vendor: String,
    vendor_icon: String,
}

#[derive(Debug)]
struct VendorAggregate {
    name: String,
    icon: String,
    total_tokens: i64,
    previous_tokens: i64,
    models: HashSet<String>,
    top_model: String,
    top_model_tokens: i64,
}

async fn build_rankings_snapshot(
    db: &worker::D1Database,
    config: RankingPeriodConfig,
    now: i64,
) -> WorkerResult<RankingsSnapshot> {
    let (start, end) = ranking_time_range(config, now);
    let current_totals = d1_repositories::ranking_quota_totals(db, start, end).await?;
    let current_buckets =
        d1_repositories::ranking_quota_buckets(db, start, end, config.bucket_size).await?;
    let previous_totals = if config.has_previous {
        let (previous_start, previous_end) = previous_ranking_time_range(config, start);
        d1_repositories::ranking_quota_totals(db, previous_start, previous_end).await?
    } else {
        Vec::new()
    };

    let model_names = ranking_model_names(&current_totals, &previous_totals, &current_buckets);
    let meta_rows = d1_repositories::list_model_meta(db).await?;
    let vendors_meta = d1_repositories::list_vendors(db).await?;
    let meta = build_ranking_model_meta(&model_names, &meta_rows, &vendors_meta);

    let total_tokens = sum_ranking_tokens(&current_totals);
    let previous_rank_by_model = ranking_rank_map(&previous_totals);
    let previous_tokens_by_model = ranking_token_map(&previous_totals);
    let ranked_models = build_ranked_models(
        &current_totals,
        total_tokens,
        &previous_rank_by_model,
        &previous_tokens_by_model,
        &meta,
        config.has_previous,
    );
    let vendors = build_ranked_vendors(
        &current_totals,
        &previous_totals,
        total_tokens,
        &meta,
        config.has_previous,
    );
    let model_history = build_model_history(&current_buckets, &current_totals, &meta, config);
    let vendor_history =
        build_vendor_share_history(&current_buckets, &vendors, total_tokens, &meta, config);
    let (movers, droppers) = build_ranking_movers(&ranked_models);

    Ok(RankingsSnapshot {
        models: limit_ranked_models(ranked_models, RANKING_LEADERBOARD_LIMIT),
        vendors,
        top_movers: movers,
        top_droppers: droppers,
        models_history: model_history,
        vendor_share_history: vendor_history,
    })
}

fn ranking_time_range(config: RankingPeriodConfig, now: i64) -> (i64, i64) {
    match config.duration_seconds {
        Some(duration) => (now - duration, now),
        None => (0, now),
    }
}

fn previous_ranking_time_range(config: RankingPeriodConfig, current_start: i64) -> (i64, i64) {
    let duration = config.duration_seconds.unwrap_or(0);
    (current_start - duration, current_start - 1)
}

fn ranking_model_names(
    current_totals: &[RankingQuotaTotal],
    previous_totals: &[RankingQuotaTotal],
    current_buckets: &[RankingQuotaBucket],
) -> Vec<String> {
    let mut names = BTreeSet::new();
    for item in current_totals {
        names.insert(item.model_name.clone());
    }
    for item in previous_totals {
        names.insert(item.model_name.clone());
    }
    for item in current_buckets {
        names.insert(item.model_name.clone());
    }
    names.into_iter().collect()
}

fn build_ranking_model_meta(
    model_names: &[String],
    meta_rows: &[d1_repositories::ModelMetaRow],
    vendors: &[d1_repositories::VendorRow],
) -> HashMap<String, RankingModelMeta> {
    let vendor_by_id: HashMap<i64, (&str, &str)> = vendors
        .iter()
        .map(|vendor| (vendor.id, (vendor.name.as_str(), vendor.icon.as_str())))
        .collect();
    let matched_meta = crate::pricing_api::match_meta(model_names, meta_rows);
    let mut result = HashMap::with_capacity(model_names.len());
    for model in model_names {
        let mut item = RankingModelMeta {
            vendor: RANKING_UNKNOWN_VENDOR.to_string(),
            vendor_icon: String::new(),
        };
        if let Some(meta) = matched_meta.get(model) {
            if meta.status == 1 {
                if let Some((vendor, icon)) = vendor_by_id.get(&meta.vendor_id) {
                    if !vendor.is_empty() {
                        item.vendor = (*vendor).to_string();
                        item.vendor_icon = (*icon).to_string();
                    }
                }
            }
        }
        result.insert(model.clone(), item);
    }
    result
}

fn model_meta(model_name: &str, meta: &HashMap<String, RankingModelMeta>) -> RankingModelMeta {
    meta.get(model_name)
        .filter(|item| !item.vendor.is_empty())
        .cloned()
        .unwrap_or_else(|| RankingModelMeta {
            vendor: RANKING_UNKNOWN_VENDOR.to_string(),
            vendor_icon: String::new(),
        })
}

fn build_ranked_models(
    totals: &[RankingQuotaTotal],
    total_tokens: i64,
    previous_ranks: &HashMap<String, usize>,
    previous_tokens: &HashMap<String, i64>,
    meta: &HashMap<String, RankingModelMeta>,
    show_growth: bool,
) -> Vec<RankedModel> {
    totals
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let model_meta = model_meta(&item.model_name, meta);
            let previous_rank = previous_ranks.get(&item.model_name).copied();
            let growth_pct = if show_growth {
                ranking_growth_pct(
                    item.total_tokens,
                    *previous_tokens.get(&item.model_name).unwrap_or(&0),
                )
            } else {
                0.0
            };
            RankedModel {
                rank: idx + 1,
                previous_rank,
                model_name: item.model_name.clone(),
                vendor: model_meta.vendor,
                vendor_icon: model_meta.vendor_icon,
                category: "all",
                total_tokens: item.total_tokens,
                share: ranking_share(item.total_tokens, total_tokens),
                growth_pct,
            }
        })
        .collect()
}

fn build_ranked_vendors(
    current_totals: &[RankingQuotaTotal],
    previous_totals: &[RankingQuotaTotal],
    total_tokens: i64,
    meta: &HashMap<String, RankingModelMeta>,
    show_growth: bool,
) -> Vec<RankedVendor> {
    let mut aggregates: HashMap<String, VendorAggregate> = HashMap::new();
    for item in current_totals {
        let model_meta = model_meta(&item.model_name, meta);
        let aggregate = ensure_vendor_aggregate(&mut aggregates, &model_meta);
        aggregate.total_tokens += item.total_tokens;
        aggregate.models.insert(item.model_name.clone());
        if item.total_tokens > aggregate.top_model_tokens {
            aggregate.top_model = item.model_name.clone();
            aggregate.top_model_tokens = item.total_tokens;
        }
    }
    for item in previous_totals {
        let model_meta = model_meta(&item.model_name, meta);
        let aggregate = ensure_vendor_aggregate(&mut aggregates, &model_meta);
        aggregate.previous_tokens += item.total_tokens;
    }

    let mut rows: Vec<RankedVendor> = aggregates
        .into_values()
        .filter(|aggregate| aggregate.total_tokens > 0)
        .map(|aggregate| {
            let growth_pct = if show_growth {
                ranking_growth_pct(aggregate.total_tokens, aggregate.previous_tokens)
            } else {
                0.0
            };
            RankedVendor {
                rank: 0,
                vendor: aggregate.name,
                vendor_icon: aggregate.icon,
                total_tokens: aggregate.total_tokens,
                share: ranking_share(aggregate.total_tokens, total_tokens),
                growth_pct,
                models_count: aggregate.models.len(),
                top_model: aggregate.top_model,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.vendor.cmp(&b.vendor))
    });
    for (idx, row) in rows.iter_mut().enumerate() {
        row.rank = idx + 1;
    }
    rows
}

fn ensure_vendor_aggregate<'a>(
    aggregates: &'a mut HashMap<String, VendorAggregate>,
    meta: &RankingModelMeta,
) -> &'a mut VendorAggregate {
    let name = if meta.vendor.is_empty() {
        RANKING_UNKNOWN_VENDOR
    } else {
        &meta.vendor
    };
    let entry = aggregates
        .entry(name.to_string())
        .or_insert_with(|| VendorAggregate {
            name: name.to_string(),
            icon: meta.vendor_icon.clone(),
            total_tokens: 0,
            previous_tokens: 0,
            models: HashSet::new(),
            top_model: String::new(),
            top_model_tokens: 0,
        });
    if entry.icon.is_empty() && !meta.vendor_icon.is_empty() {
        entry.icon = meta.vendor_icon.clone();
    }
    entry
}

fn build_model_history(
    buckets: &[RankingQuotaBucket],
    totals: &[RankingQuotaTotal],
    meta: &HashMap<String, RankingModelMeta>,
    config: RankingPeriodConfig,
) -> ModelHistorySeries {
    let mut top_models = HashSet::new();
    let mut models = Vec::with_capacity(totals.len().min(RANKING_HISTORY_LIMIT) + 1);
    let mut other_total = 0_i64;
    for (idx, item) in totals.iter().enumerate() {
        if idx < RANKING_HISTORY_LIMIT {
            top_models.insert(item.model_name.clone());
            let model_meta = model_meta(&item.model_name, meta);
            models.push(ModelHistoryModel {
                name: item.model_name.clone(),
                vendor: model_meta.vendor,
                total: item.total_tokens,
            });
        } else {
            other_total += item.total_tokens;
        }
    }
    if other_total > 0 {
        models.push(ModelHistoryModel {
            name: RANKING_OTHERS_LABEL.to_string(),
            vendor: "Various".to_string(),
            total: other_total,
        });
    }

    let mut bucket_set = BTreeSet::new();
    let mut tokens_by_bucket_and_model: BTreeMap<i64, HashMap<String, i64>> = BTreeMap::new();
    for item in buckets {
        let model_name = if top_models.contains(&item.model_name) {
            item.model_name.as_str()
        } else {
            RANKING_OTHERS_LABEL
        };
        bucket_set.insert(item.bucket);
        let by_model = tokens_by_bucket_and_model.entry(item.bucket).or_default();
        *by_model.entry(model_name.to_string()).or_default() += item.tokens;
    }

    let mut points = Vec::new();
    for bucket in &bucket_set {
        for history_model in &models {
            let tokens = tokens_by_bucket_and_model
                .get(bucket)
                .and_then(|by_model| by_model.get(&history_model.name))
                .copied()
                .unwrap_or(0);
            if tokens <= 0 {
                continue;
            }
            points.push(ModelHistoryPoint {
                ts: ranking_bucket_ts(*bucket),
                label: ranking_bucket_label(*bucket, config),
                model: history_model.name.clone(),
                vendor: history_model.vendor.clone(),
                tokens,
            });
        }
    }

    ModelHistorySeries {
        points,
        models,
        buckets: bucket_set.len(),
    }
}

fn build_vendor_share_history(
    buckets: &[RankingQuotaBucket],
    vendors: &[RankedVendor],
    total_tokens: i64,
    meta: &HashMap<String, RankingModelMeta>,
    config: RankingPeriodConfig,
) -> VendorShareSeries {
    let mut top_vendors = HashSet::new();
    let mut vendor_rows = Vec::with_capacity(vendors.len().min(RANKING_VENDOR_LIMIT) + 1);
    let mut other_total = 0_i64;
    for (idx, vendor) in vendors.iter().enumerate() {
        if idx < RANKING_VENDOR_LIMIT {
            top_vendors.insert(vendor.vendor.clone());
            vendor_rows.push(VendorShareVendor {
                name: vendor.vendor.clone(),
                total: vendor.total_tokens,
                share: vendor.share,
            });
        } else {
            other_total += vendor.total_tokens;
        }
    }
    if other_total > 0 {
        vendor_rows.push(VendorShareVendor {
            name: RANKING_OTHERS_LABEL.to_string(),
            total: other_total,
            share: ranking_share(other_total, total_tokens),
        });
    }

    let mut bucket_set = BTreeSet::new();
    let mut totals_by_bucket: BTreeMap<i64, i64> = BTreeMap::new();
    let mut tokens_by_bucket_and_vendor: BTreeMap<i64, HashMap<String, i64>> = BTreeMap::new();
    for item in buckets {
        let model_meta = model_meta(&item.model_name, meta);
        let vendor_name = if top_vendors.contains(&model_meta.vendor) {
            model_meta.vendor
        } else {
            RANKING_OTHERS_LABEL.to_string()
        };
        bucket_set.insert(item.bucket);
        *totals_by_bucket.entry(item.bucket).or_default() += item.tokens;
        let by_vendor = tokens_by_bucket_and_vendor.entry(item.bucket).or_default();
        *by_vendor.entry(vendor_name).or_default() += item.tokens;
    }

    let mut points = Vec::new();
    for bucket in &bucket_set {
        let bucket_total = *totals_by_bucket.get(bucket).unwrap_or(&0);
        for vendor in &vendor_rows {
            let tokens = tokens_by_bucket_and_vendor
                .get(bucket)
                .and_then(|by_vendor| by_vendor.get(&vendor.name))
                .copied()
                .unwrap_or(0);
            if tokens <= 0 {
                continue;
            }
            points.push(VendorSharePoint {
                ts: ranking_bucket_ts(*bucket),
                label: ranking_bucket_label(*bucket, config),
                vendor: vendor.name.clone(),
                share: ranking_share(tokens, bucket_total),
                tokens,
            });
        }
    }

    VendorShareSeries {
        points,
        vendors: vendor_rows,
        buckets: bucket_set.len(),
    }
}

fn build_ranking_movers(models: &[RankedModel]) -> (Vec<RankingMover>, Vec<RankingMover>) {
    let mut movers = Vec::new();
    let mut droppers = Vec::new();
    for item in models {
        let Some(previous_rank) = item.previous_rank else {
            continue;
        };
        let delta = previous_rank as isize - item.rank as isize;
        if delta == 0 {
            continue;
        }
        let row = RankingMover {
            model_name: item.model_name.clone(),
            vendor: item.vendor.clone(),
            vendor_icon: item.vendor_icon.clone(),
            rank_delta: delta,
            current_rank: item.rank,
            growth_pct: item.growth_pct,
        };
        if delta > 0 {
            movers.push(row);
        } else {
            droppers.push(row);
        }
    }
    movers.sort_by(|a, b| {
        b.rank_delta
            .cmp(&a.rank_delta)
            .then_with(|| b.growth_pct.total_cmp(&a.growth_pct))
    });
    droppers.sort_by(|a, b| {
        a.rank_delta
            .cmp(&b.rank_delta)
            .then_with(|| a.growth_pct.total_cmp(&b.growth_pct))
    });
    (
        limit_ranking_movers(movers, RANKING_MOVER_LIMIT),
        limit_ranking_movers(droppers, RANKING_MOVER_LIMIT),
    )
}

fn ranking_rank_map(totals: &[RankingQuotaTotal]) -> HashMap<String, usize> {
    totals
        .iter()
        .enumerate()
        .map(|(idx, item)| (item.model_name.clone(), idx + 1))
        .collect()
}

fn ranking_token_map(totals: &[RankingQuotaTotal]) -> HashMap<String, i64> {
    totals
        .iter()
        .map(|item| (item.model_name.clone(), item.total_tokens))
        .collect()
}

fn sum_ranking_tokens(totals: &[RankingQuotaTotal]) -> i64 {
    totals.iter().map(|item| item.total_tokens).sum()
}

fn ranking_share(value: i64, total: i64) -> f64 {
    if total <= 0 || value <= 0 {
        return 0.0;
    }
    round_ranking_float(value as f64 / total as f64)
}

fn ranking_growth_pct(current: i64, previous: i64) -> f64 {
    if previous <= 0 {
        if current > 0 {
            return 100.0;
        }
        return 0.0;
    }
    round_ranking_float(((current - previous) as f64 / previous as f64) * 100.0)
}

fn round_ranking_float(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 10000.0).round() / 10000.0
}

fn limit_ranked_models(mut rows: Vec<RankedModel>, limit: usize) -> Vec<RankedModel> {
    if rows.len() > limit {
        rows.truncate(limit);
    }
    rows
}

fn limit_ranking_movers(mut rows: Vec<RankingMover>, limit: usize) -> Vec<RankingMover> {
    if rows.len() > limit {
        rows.truncate(limit);
    }
    rows
}

fn ranking_bucket_ts(bucket: i64) -> String {
    let millis = wasm_bindgen::JsValue::from_f64(bucket as f64 * 1000.0);
    js_sys::Date::new(&millis)
        .to_iso_string()
        .as_string()
        .unwrap_or_else(|| bucket.to_string())
}

fn ranking_bucket_label(bucket: i64, config: RankingPeriodConfig) -> String {
    let millis = wasm_bindgen::JsValue::from_f64(bucket as f64 * 1000.0);
    let date = js_sys::Date::new(&millis);
    match config.label_kind {
        RankingLabelKind::Hour => format!(
            "{:02}:{:02}",
            date.get_utc_hours() as u32,
            date.get_utc_minutes() as u32
        ),
        RankingLabelKind::Day => {
            let month = month_name(date.get_utc_month() as usize);
            format!("{month} {}", date.get_utc_date() as u32)
        }
        RankingLabelKind::Month => {
            let month = month_name(date.get_utc_month() as usize);
            format!("{month} {}", date.get_utc_full_year() as i32)
        }
    }
}

fn month_name(month: usize) -> &'static str {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    MONTHS.get(month).copied().unwrap_or("Jan")
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let value = url
        .query_pairs()
        .find(|(name, _)| name == key)?
        .1
        .trim()
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn total(model_name: &str, total_tokens: i64) -> RankingQuotaTotal {
        RankingQuotaTotal {
            model_name: model_name.to_string(),
            total_tokens,
        }
    }

    fn meta(vendor_by_model: &[(&str, &str)]) -> HashMap<String, RankingModelMeta> {
        vendor_by_model
            .iter()
            .map(|(model, vendor)| {
                (
                    (*model).to_string(),
                    RankingModelMeta {
                        vendor: (*vendor).to_string(),
                        vendor_icon: String::new(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn ranking_periods_match_go_windows() {
        assert_eq!(ranking_config("").unwrap().id, "week");
        assert_eq!(
            ranking_config("today").unwrap().duration_seconds,
            Some(24 * 3600)
        );
        assert_eq!(ranking_config("year").unwrap().bucket_size, 7 * 24 * 3600);
        assert_eq!(ranking_config("all").unwrap().has_previous, false);
        assert_eq!(
            ranking_config("quarter").unwrap_err(),
            "invalid ranking period: quarter"
        );
    }

    #[test]
    fn header_access_accepts_object_and_legacy_boolean() {
        let object = r#"{"rankings":{"enabled":false,"requireAuth":true}}"#;
        assert_eq!(
            parse_header_nav_access(Some(object), "rankings"),
            HeaderNavAccess {
                enabled: false,
                require_auth: true,
            }
        );

        let legacy = r#"{"rankings":"0"}"#;
        assert_eq!(
            parse_header_nav_access(Some(legacy), "rankings"),
            HeaderNavAccess {
                enabled: false,
                require_auth: false,
            }
        );

        assert_eq!(
            parse_header_nav_access(Some("not-json"), "rankings"),
            HeaderNavAccess {
                enabled: true,
                require_auth: false,
            }
        );
    }

    #[test]
    fn ranked_models_growth_and_movers_match_go_rules() {
        let current = vec![total("alpha", 100), total("beta", 50), total("gamma", 25)];
        let previous = vec![total("beta", 80), total("alpha", 40), total("delta", 20)];
        let meta = meta(&[
            ("alpha", "OpenAI"),
            ("beta", "Anthropic"),
            ("gamma", "Google"),
        ]);
        let ranked = build_ranked_models(
            &current,
            sum_ranking_tokens(&current),
            &ranking_rank_map(&previous),
            &ranking_token_map(&previous),
            &meta,
            true,
        );

        assert_eq!(ranked[0].previous_rank, Some(2));
        assert_eq!(ranked[0].share, 0.5714);
        assert_eq!(ranked[0].growth_pct, 150.0);
        assert_eq!(ranked[1].growth_pct, -37.5);
        assert_eq!(ranked[2].previous_rank, None);
        assert_eq!(ranked[2].growth_pct, 100.0);

        let (movers, droppers) = build_ranking_movers(&ranked);
        assert_eq!(movers[0].model_name, "alpha");
        assert_eq!(movers[0].rank_delta, 1);
        assert_eq!(droppers[0].model_name, "beta");
        assert_eq!(droppers[0].rank_delta, -1);
    }

    #[test]
    fn ranked_vendors_aggregate_models_and_previous_growth() {
        let current = vec![total("alpha", 100), total("beta", 50), total("gamma", 25)];
        let previous = vec![total("alpha", 50), total("beta", 25)];
        let meta = meta(&[
            ("alpha", "OpenAI"),
            ("beta", "OpenAI"),
            ("gamma", "Anthropic"),
        ]);
        let vendors = build_ranked_vendors(
            &current,
            &previous,
            sum_ranking_tokens(&current),
            &meta,
            true,
        );

        assert_eq!(vendors[0].vendor, "OpenAI");
        assert_eq!(vendors[0].total_tokens, 150);
        assert_eq!(vendors[0].models_count, 2);
        assert_eq!(vendors[0].top_model, "alpha");
        assert_eq!(vendors[0].growth_pct, 100.0);
        assert_eq!(vendors[1].vendor, "Anthropic");
        assert_eq!(vendors[1].growth_pct, 100.0);
    }

    #[test]
    fn model_names_union_all_ranking_sources() {
        let names = ranking_model_names(
            &[total("alpha", 1)],
            &[total("beta", 1)],
            &[RankingQuotaBucket {
                model_name: "gamma".to_string(),
                bucket: 1,
                tokens: 1,
            }],
        );
        assert_eq!(names, vec!["alpha", "beta", "gamma"]);
    }
}
