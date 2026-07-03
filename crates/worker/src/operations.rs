//! Operational dashboard endpoints.
//!
//! The Go deployment exposes local-process maintenance routes (disk cache,
//! log files, GC) alongside Uptime Kuma and model performance metrics. Workers
//! do not have a local disk or process-level GC controls, so the maintenance
//! actions return explicit compatible no-op results while the read paths expose
//! Cloudflare-native data from D1 and bounded outbound fetches.

use std::collections::BTreeMap;
use std::time::Duration;

use cinatoken_ssrf::SsrfPolicy;
use futures_util::future::{join, select, Either};
use futures_util::TryStreamExt;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::{
    AbortController, D1Database, D1Type, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, require_root_auth,
    unix_timestamp,
};
use crate::d1_i32;
use crate::d1_repositories;

const UPTIME_STATUS_PATH: &str = "/api/status-page/";
const UPTIME_HEARTBEAT_PATH: &str = "/api/status-page/heartbeat/";
const UPTIME_KEY_SUFFIX: &str = "_24";
const UPTIME_OUTBOUND_TIMEOUT: Duration = Duration::from_secs(10);
const UPTIME_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const UPTIME_MAX_GROUPS: usize = 10;
const PERF_SERIES_SCHEMA: &str = "dbcd0a3c01b55203";
const PERF_MAX_HOURS: i64 = 24 * 30;
const PERF_SUMMARY_LIMIT: i32 = 200;
const LOG_TYPE_CONSUME: i32 = 2;

// ---------------------------------------------------------------------------
// Uptime Kuma
// ---------------------------------------------------------------------------

/// `GET /api/uptime/status`: public dashboard Uptime Kuma panel.
pub async fn uptime_status(_req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let groups = load_uptime_groups(&db).await?;
    if groups.is_empty() {
        return envelope_ok_response(&Vec::<UptimeGroupResult>::new());
    }

    let futures = groups
        .into_iter()
        .take(UPTIME_MAX_GROUPS)
        .map(fetch_uptime_group)
        .collect::<Vec<_>>();
    let results = futures_util::future::join_all(futures).await;
    envelope_ok_response(&results)
}

async fn load_uptime_groups(db: &D1Database) -> WorkerResult<Vec<UptimeGroupConfig>> {
    let values = d1_repositories::option_values(
        db,
        &[
            "console_setting.uptime_kuma_groups",
            "console_setting.uptime_kuma_enabled",
            "UptimeKumaUrl",
            "UptimeKumaSlug",
        ],
    )
    .await?;

    if values[1]
        .as_deref()
        .is_some_and(|value| is_false_string(value.trim()))
    {
        return Ok(Vec::new());
    }

    if let Some(raw) = values[0]
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        if let Ok(groups) = serde_json::from_str::<Vec<UptimeGroupConfig>>(raw) {
            return Ok(groups
                .into_iter()
                .filter(|group| !group.url.trim().is_empty() && !group.slug.trim().is_empty())
                .collect());
        }
    }

    let legacy_url = values[2].as_deref().map(str::trim).unwrap_or_default();
    let legacy_slug = values[3].as_deref().map(str::trim).unwrap_or_default();
    if legacy_url.is_empty() || legacy_slug.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![UptimeGroupConfig {
        category_name: "Uptime".to_string(),
        url: legacy_url.to_string(),
        slug: legacy_slug.to_string(),
    }])
}

async fn fetch_uptime_group(group: UptimeGroupConfig) -> UptimeGroupResult {
    let mut result = UptimeGroupResult {
        category_name: group.category_name.trim().to_string(),
        monitors: Vec::new(),
    };
    if result.category_name.is_empty() {
        result.category_name = "Uptime".to_string();
    }

    let status_url = match build_uptime_url(&group.url, UPTIME_STATUS_PATH, &group.slug) {
        Ok(url) => url,
        Err(message) => {
            worker::console_warn!("uptime group skipped: {message}");
            return result;
        }
    };
    let heartbeat_url = match build_uptime_url(&group.url, UPTIME_HEARTBEAT_PATH, &group.slug) {
        Ok(url) => url,
        Err(message) => {
            worker::console_warn!("uptime heartbeat group skipped: {message}");
            return result;
        }
    };

    let (status, heartbeat) = join(
        fetch_json::<UptimeStatusPage>(&status_url, "Uptime status"),
        fetch_json::<UptimeHeartbeatPage>(&heartbeat_url, "Uptime heartbeat"),
    )
    .await;
    let (Ok(status), Ok(heartbeat)) = (status, heartbeat) else {
        return result;
    };

    for public_group in status.public_group_list {
        for monitor in public_group.monitor_list {
            let monitor_id = monitor.id.to_string();
            let uptime_key = format!("{monitor_id}{UPTIME_KEY_SUFFIX}");
            let uptime = heartbeat
                .uptime_list
                .get(&uptime_key)
                .copied()
                .unwrap_or(0.0);
            let status = heartbeat
                .heartbeat_list
                .get(&monitor_id)
                .and_then(|items| items.first())
                .map(|item| item.status)
                .unwrap_or(0);
            result.monitors.push(UptimeMonitor {
                name: monitor.name,
                uptime,
                status,
                group: Some(public_group.name.clone()).filter(|name| !name.is_empty()),
            });
        }
    }
    result
}

fn build_uptime_url(base_url: &str, path: &str, slug: &str) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty()
        || slug
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
    {
        return Err("Uptime Kuma slug contains unsupported characters".to_string());
    }

    let policy = SsrfPolicy::strict_default();
    let parsed = policy
        .validate_url(base_url.trim())
        .map_err(|err| format!("Uptime Kuma URL is not allowed: {err}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Uptime Kuma URL must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() || parsed.query().is_some() {
        return Err("Uptime Kuma URL must not contain query or fragment".to_string());
    }
    Ok(format!(
        "{}{}{}",
        parsed.as_str().trim_end_matches('/'),
        path,
        slug
    ))
}

async fn fetch_json<T: DeserializeOwned>(url: &str, label: &str) -> Result<T, String> {
    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|err| err.to_string())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    let request = Request::new_with_init(url, &init).map_err(|err| err.to_string())?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(UPTIME_OUTBOUND_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|err| format!("{label} request failed: {err}"))?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err(format!("{label} request timed out"));
        }
    };
    if response.status_code() != 200 {
        return Err(format!(
            "{label} request returned status {}",
            response.status_code()
        ));
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
        return Err(format!("{label} response is not JSON"));
    }
    if response
        .headers()
        .get("Content-Length")
        .map_err(|err| err.to_string())?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > UPTIME_BODY_LIMIT_BYTES)
    {
        return Err(format!("{label} response exceeds 1 MiB limit"));
    }

    let bytes = response
        .stream()
        .map_err(|err| format!("failed to read {label} response: {err}"))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > UPTIME_BODY_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "Uptime response exceeds 1 MiB limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&bytes).map_err(|err| format!("{label} response is invalid JSON: {err}"))
}

// ---------------------------------------------------------------------------
// Performance maintenance compatibility
// ---------------------------------------------------------------------------

/// `GET /api/performance/stats`: root-only operational stats.
pub async fn performance_stats(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }
    let db = env.d1("DB")?;
    let options = d1_repositories::option_values(
        &db,
        &[
            "performance_setting.disk_cache_enabled",
            "performance_setting.disk_cache_threshold_mb",
            "performance_setting.disk_cache_max_size_mb",
            "performance_setting.disk_cache_path",
            "performance_setting.monitor_enabled",
            "performance_setting.monitor_cpu_threshold",
            "performance_setting.monitor_memory_threshold",
            "performance_setting.monitor_disk_threshold",
        ],
    )
    .await?;

    let stats = PerformanceStatsResponse {
        cache_stats: CacheStats::default(),
        memory_stats: MemoryStats::default(),
        disk_cache_info: DiskCacheInfo {
            path: option_string(options[3].as_deref(), ""),
            exists: false,
            file_count: 0,
            total_size: 0,
        },
        disk_space_info: DiskSpaceInfo::default(),
        config: PerformanceConfig {
            disk_cache_enabled: false,
            disk_cache_threshold_mb: option_i64(options[1].as_deref(), 32),
            disk_cache_max_size_mb: option_i64(options[2].as_deref(), 1024),
            disk_cache_path: option_string(options[3].as_deref(), ""),
            is_running_in_container: true,
            monitor_enabled: option_bool(options[4].as_deref(), false),
            monitor_cpu_threshold: option_i64(options[5].as_deref(), 90),
            monitor_memory_threshold: option_i64(options[6].as_deref(), 90),
            monitor_disk_threshold: option_i64(options[7].as_deref(), 90),
        },
    };
    envelope_ok_response(&stats)
}

pub async fn clear_disk_cache(req: Request, env: Env) -> WorkerResult<Response> {
    root_noop_action(
        req,
        env,
        "performance.clear_disk_cache",
        "disk cache is not local on Workers",
    )
    .await
}

pub async fn reset_performance_stats(req: Request, env: Env) -> WorkerResult<Response> {
    root_noop_action(
        req,
        env,
        "performance.reset_stats",
        "performance stats reset",
    )
    .await
}

pub async fn force_gc(req: Request, env: Env) -> WorkerResult<Response> {
    root_noop_action(
        req,
        env,
        "performance.gc",
        "GC is managed by the Workers runtime",
    )
    .await
}

pub async fn log_files(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }
    envelope_ok_response(&LogFilesResponse {
        enabled: false,
        log_dir: String::new(),
        file_count: 0,
        total_size: 0,
        oldest_time: None,
        newest_time: None,
        files: Vec::new(),
    })
}

pub async fn cleanup_log_files(req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let mode = parse_query_string(&req, "mode").unwrap_or_default();
    if mode != "by_count" && mode != "by_days" {
        return Ok(envelope_error_response(
            400,
            "invalid mode, must be by_count or by_days",
        ));
    }
    let Some(value) = parse_query_i64(&req, "value").filter(|value| *value >= 1) else {
        return Ok(envelope_error_response(
            400,
            "invalid value, must be a positive integer",
        ));
    };
    let db = env.d1("DB")?;
    audit_root_action(
        &db,
        &claims,
        &req,
        "performance.clear_logs",
        &serde_json::json!({ "mode": mode, "value": value }),
    )
    .await;
    envelope_ok_response(&serde_json::json!({
        "deleted_count": 0,
        "freed_bytes": 0,
        "failed_files": []
    }))
}

async fn root_noop_action(
    req: Request,
    env: Env,
    action: &str,
    message: &str,
) -> WorkerResult<Response> {
    let claims = match require_root_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    audit_root_action(
        &db,
        &claims,
        &req,
        action,
        &serde_json::json!({ "worker_noop": true }),
    )
    .await;
    envelope_ok_response(&serde_json::json!({ "message": message }))
}

async fn audit_root_action(
    db: &D1Database,
    claims: &cinatoken_session::SessionClaims,
    req: &Request,
    action: &str,
    params: &Value,
) {
    let now = unix_timestamp();
    let _ = d1_repositories::insert_admin_audit_log(
        db,
        None,
        None,
        &claims.username,
        action,
        &format!("root {} executed {action}", claims.username),
        params,
        &admin_audit_info(claims, req),
        now,
    )
    .await;
}

// ---------------------------------------------------------------------------
// Model performance metrics
// ---------------------------------------------------------------------------

/// `GET /api/perf-metrics/summary`: public model performance summary.
pub async fn perf_metrics_summary(req: Request, env: Env) -> WorkerResult<Response> {
    let db = env.d1("DB")?;
    let hours = parse_hours(&req);
    let (start, end) = hours_window(hours);
    let rows = query_perf_summary_from_logs(&db, start, end).await?;
    envelope_ok_response(&PerfSummaryAllData {
        models: build_summary_models(rows),
    })
}

/// `GET /api/perf-metrics`: public model performance detail by model.
pub async fn perf_metrics(req: Request, env: Env) -> WorkerResult<Response> {
    let Some(model) = parse_query_string(&req, "model") else {
        return Ok(envelope_error_response(400, "model is required"));
    };
    let db = env.d1("DB")?;
    let hours = parse_hours(&req);
    let group = parse_query_string(&req, "group");
    let bucket_seconds = load_bucket_seconds(&db).await?;
    let (start, end) = hours_window(hours);
    let rows =
        query_perf_model_from_logs(&db, &model, group.as_deref(), start, end, bucket_seconds)
            .await?;
    envelope_ok_response(&build_perf_model_data(&model, rows))
}

async fn load_bucket_seconds(db: &D1Database) -> WorkerResult<i64> {
    let raw = d1_repositories::get_option(db, "perf_metrics_setting.bucket_time").await?;
    Ok(match raw.as_deref().map(str::trim) {
        Some("minute") => 60,
        Some("5min") => 300,
        _ => 3600,
    })
}

async fn query_perf_summary_from_logs(
    db: &D1Database,
    start: i64,
    end: i64,
) -> WorkerResult<Vec<PerfSummaryRow>> {
    let args = [
        D1Type::Integer(LOG_TYPE_CONSUME),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
        D1Type::Integer(PERF_SUMMARY_LIMIT),
    ];
    Ok(db
        .prepare(
            r#"
            SELECT model_name,
                   COUNT(*) AS request_count,
                   COUNT(*) AS success_count,
                   COALESCE(SUM(use_time * 1000), 0) AS total_latency_ms,
                   COALESCE(SUM(completion_tokens), 0) AS output_tokens,
                   COALESCE(SUM(CASE WHEN use_time > 0 THEN use_time * 1000 ELSE 0 END), 0)
                     AS generation_ms
            FROM logs
            WHERE type = ?1
              AND created_at >= ?2
              AND created_at <= ?3
              AND model_name != ''
            GROUP BY model_name
            HAVING COUNT(*) > 0
            ORDER BY request_count DESC, model_name ASC
            LIMIT ?4
            "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<PerfSummaryRow>()?)
}

async fn query_perf_model_from_logs(
    db: &D1Database,
    model: &str,
    group: Option<&str>,
    start: i64,
    end: i64,
    bucket_seconds: i64,
) -> WorkerResult<Vec<PerfBucketRow>> {
    let mut args = vec![
        D1Type::Integer(LOG_TYPE_CONSUME),
        D1Type::Text(model),
        D1Type::Integer(d1_i32(start)),
        D1Type::Integer(d1_i32(end)),
        D1Type::Integer(d1_i32(bucket_seconds)),
    ];
    let group_clause = if let Some(group) = group.map(str::trim).filter(|group| !group.is_empty()) {
        args.push(D1Type::Text(group));
        "AND \"group\" = ?6"
    } else {
        ""
    };
    let sql = format!(
        r#"
        SELECT "group" AS model_group,
               (created_at - (created_at % ?5)) AS bucket_ts,
               COUNT(*) AS request_count,
               COUNT(*) AS success_count,
               COALESCE(SUM(use_time * 1000), 0) AS total_latency_ms,
               0 AS ttft_sum_ms,
               0 AS ttft_count,
               COALESCE(SUM(completion_tokens), 0) AS output_tokens,
               COALESCE(SUM(CASE WHEN use_time > 0 THEN use_time * 1000 ELSE 0 END), 0)
                 AS generation_ms
        FROM logs
        WHERE type = ?1
          AND model_name = ?2
          AND created_at >= ?3
          AND created_at <= ?4
          {group_clause}
        GROUP BY "group", bucket_ts
        ORDER BY bucket_ts ASC
        "#
    );
    Ok(db
        .prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<PerfBucketRow>()?)
}

fn build_summary_models(rows: Vec<PerfSummaryRow>) -> Vec<PerfModelSummary> {
    rows.into_iter()
        .filter(|row| row.request_count > 0)
        .map(|row| PerfModelSummary {
            model_name: row.model_name,
            avg_latency_ms: avg(row.total_latency_ms, row.request_count),
            success_rate: round2(success_rate(row.success_count, row.request_count)),
            avg_tps: round2(avg_tps(row.output_tokens, row.generation_ms)),
            request_count: Some(row.request_count),
        })
        .collect()
}

fn build_perf_model_data(model: &str, rows: Vec<PerfBucketRow>) -> PerformanceMetricsData {
    let mut groups: BTreeMap<String, Vec<PerfBucketRow>> = BTreeMap::new();
    for row in rows.into_iter().filter(|row| row.request_count > 0) {
        groups.entry(row.model_group.clone()).or_default().push(row);
    }

    let groups = groups
        .into_iter()
        .map(|(group, rows)| {
            let mut total = PerfCounters::default();
            let mut series = Vec::new();
            for row in rows {
                total.request_count += row.request_count;
                total.success_count += row.success_count;
                total.total_latency_ms += row.total_latency_ms;
                total.ttft_sum_ms += row.ttft_sum_ms;
                total.ttft_count += row.ttft_count;
                total.output_tokens += row.output_tokens;
                total.generation_ms += row.generation_ms;
                series.push(PerformanceSeriesPoint {
                    ts: row.bucket_ts,
                    avg_ttft_ms: avg(row.ttft_sum_ms, row.ttft_count),
                    avg_latency_ms: avg(row.total_latency_ms, row.request_count),
                    success_rate: success_rate(row.success_count, row.request_count),
                    avg_tps: avg_tps(row.output_tokens, row.generation_ms),
                });
            }
            PerformanceGroup {
                group,
                avg_ttft_ms: avg(total.ttft_sum_ms, total.ttft_count),
                avg_latency_ms: avg(total.total_latency_ms, total.request_count),
                success_rate: success_rate(total.success_count, total.request_count),
                avg_tps: avg_tps(total.output_tokens, total.generation_ms),
                series,
            }
        })
        .collect();

    PerformanceMetricsData {
        model_name: model.to_string(),
        series_schema: PERF_SERIES_SCHEMA.to_string(),
        groups,
    }
}

fn avg(sum: i64, count: i64) -> i64 {
    if count <= 0 {
        0
    } else {
        sum / count
    }
}

fn success_rate(success_count: i64, request_count: i64) -> f64 {
    if request_count <= 0 {
        0.0
    } else {
        success_count as f64 / request_count as f64 * 100.0
    }
}

fn avg_tps(output_tokens: i64, generation_ms: i64) -> f64 {
    if output_tokens <= 0 || generation_ms <= 0 {
        0.0
    } else {
        output_tokens as f64 / (generation_ms as f64 / 1000.0)
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn parse_hours(req: &Request) -> i64 {
    parse_query_i64(req, "hours")
        .unwrap_or(24)
        .clamp(1, PERF_MAX_HOURS)
}

fn hours_window(hours: i64) -> (i64, i64) {
    let end = unix_timestamp();
    let start = end.saturating_sub(hours.saturating_mul(3600));
    (start, end)
}

fn parse_query_string(req: &Request, key: &str) -> Option<String> {
    let url = req.url().ok()?;
    let value = url
        .query_pairs()
        .find(|(candidate, _)| candidate == key)?
        .1
        .trim()
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_query_i64(req: &Request, key: &str) -> Option<i64> {
    parse_query_string(req, key)?.parse::<i64>().ok()
}

fn option_bool(raw: Option<&str>, default: bool) -> bool {
    raw.map(str::trim)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(default)
}

fn option_i64(raw: Option<&str>, default: i64) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

fn option_string(raw: Option<&str>, default: &str) -> String {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn is_false_string(value: &str) -> bool {
    value == "0" || value.eq_ignore_ascii_case("false")
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct UptimeGroupConfig {
    #[serde(default, rename = "categoryName")]
    category_name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    slug: String,
}

#[derive(Debug, Serialize)]
struct UptimeMonitor {
    name: String,
    uptime: f64,
    status: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

#[derive(Debug, Serialize)]
struct UptimeGroupResult {
    #[serde(rename = "categoryName")]
    category_name: String,
    monitors: Vec<UptimeMonitor>,
}

#[derive(Debug, Deserialize, Default)]
struct UptimeStatusPage {
    #[serde(default, rename = "publicGroupList")]
    public_group_list: Vec<UptimePublicGroup>,
}

#[derive(Debug, Deserialize, Default)]
struct UptimePublicGroup {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "monitorList")]
    monitor_list: Vec<UptimePublicMonitor>,
}

#[derive(Debug, Deserialize, Default)]
struct UptimePublicMonitor {
    id: i64,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize, Default)]
struct UptimeHeartbeatPage {
    #[serde(default, rename = "heartbeatList")]
    heartbeat_list: BTreeMap<String, Vec<UptimeHeartbeat>>,
    #[serde(default, rename = "uptimeList")]
    uptime_list: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize, Default)]
struct UptimeHeartbeat {
    status: i32,
}

#[derive(Debug, Serialize, Default)]
struct CacheStats {
    current_disk_usage_bytes: i64,
    disk_cache_max_bytes: i64,
    active_disk_files: i64,
    disk_cache_hits: i64,
    current_memory_usage_bytes: i64,
    active_memory_buffers: i64,
    memory_cache_hits: i64,
}

#[derive(Debug, Serialize, Default)]
struct MemoryStats {
    alloc: i64,
    total_alloc: i64,
    sys: i64,
    num_gc: i64,
    num_goroutine: i64,
}

#[derive(Debug, Serialize)]
struct DiskCacheInfo {
    path: String,
    exists: bool,
    file_count: i64,
    total_size: i64,
}

#[derive(Debug, Serialize, Default)]
struct DiskSpaceInfo {
    total: i64,
    free: i64,
    used: i64,
    used_percent: f64,
}

#[derive(Debug, Serialize)]
struct PerformanceConfig {
    disk_cache_enabled: bool,
    disk_cache_threshold_mb: i64,
    disk_cache_max_size_mb: i64,
    disk_cache_path: String,
    is_running_in_container: bool,
    monitor_enabled: bool,
    monitor_cpu_threshold: i64,
    monitor_memory_threshold: i64,
    monitor_disk_threshold: i64,
}

#[derive(Debug, Serialize)]
struct PerformanceStatsResponse {
    cache_stats: CacheStats,
    memory_stats: MemoryStats,
    disk_cache_info: DiskCacheInfo,
    disk_space_info: DiskSpaceInfo,
    config: PerformanceConfig,
}

#[derive(Debug, Serialize)]
struct LogFilesResponse {
    enabled: bool,
    log_dir: String,
    file_count: i64,
    total_size: i64,
    oldest_time: Option<String>,
    newest_time: Option<String>,
    files: Vec<LogFileInfo>,
}

#[derive(Debug, Serialize)]
struct LogFileInfo {
    name: String,
    size: i64,
    mod_time: String,
}

#[derive(Debug, Deserialize)]
struct PerfSummaryRow {
    model_name: String,
    request_count: i64,
    success_count: i64,
    total_latency_ms: i64,
    output_tokens: i64,
    generation_ms: i64,
}

#[derive(Debug, Deserialize, Clone)]
struct PerfBucketRow {
    model_group: String,
    bucket_ts: i64,
    request_count: i64,
    success_count: i64,
    total_latency_ms: i64,
    ttft_sum_ms: i64,
    ttft_count: i64,
    output_tokens: i64,
    generation_ms: i64,
}

#[derive(Debug, Default)]
struct PerfCounters {
    request_count: i64,
    success_count: i64,
    total_latency_ms: i64,
    ttft_sum_ms: i64,
    ttft_count: i64,
    output_tokens: i64,
    generation_ms: i64,
}

#[derive(Debug, Serialize)]
struct PerformanceSeriesPoint {
    ts: i64,
    avg_ttft_ms: i64,
    avg_latency_ms: i64,
    success_rate: f64,
    avg_tps: f64,
}

#[derive(Debug, Serialize)]
struct PerformanceGroup {
    group: String,
    avg_ttft_ms: i64,
    avg_latency_ms: i64,
    success_rate: f64,
    avg_tps: f64,
    series: Vec<PerformanceSeriesPoint>,
}

#[derive(Debug, Serialize)]
struct PerformanceMetricsData {
    model_name: String,
    series_schema: String,
    groups: Vec<PerformanceGroup>,
}

#[derive(Debug, Serialize)]
struct PerfModelSummary {
    model_name: String,
    avg_latency_ms: i64,
    success_rate: f64,
    avg_tps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_count: Option<i64>,
}

#[derive(Debug, Serialize)]
struct PerfSummaryAllData {
    models: Vec<PerfModelSummary>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perf_summary_rounds_like_go_summary() {
        let rows = vec![PerfSummaryRow {
            model_name: "gpt-test".to_string(),
            request_count: 3,
            success_count: 2,
            total_latency_ms: 3000,
            output_tokens: 7,
            generation_ms: 3000,
        }];
        let models = build_summary_models(rows);
        assert_eq!(models[0].avg_latency_ms, 1000);
        assert_eq!(models[0].success_rate, 66.67);
        assert_eq!(models[0].avg_tps, 2.33);
    }

    #[test]
    fn perf_model_groups_series_by_group_and_time() {
        let data = build_perf_model_data(
            "gpt-test",
            vec![
                PerfBucketRow {
                    model_group: "vip".to_string(),
                    bucket_ts: 100,
                    request_count: 2,
                    success_count: 2,
                    total_latency_ms: 4000,
                    ttft_sum_ms: 0,
                    ttft_count: 0,
                    output_tokens: 20,
                    generation_ms: 4000,
                },
                PerfBucketRow {
                    model_group: "default".to_string(),
                    bucket_ts: 50,
                    request_count: 1,
                    success_count: 1,
                    total_latency_ms: 500,
                    ttft_sum_ms: 0,
                    ttft_count: 0,
                    output_tokens: 5,
                    generation_ms: 500,
                },
            ],
        );
        assert_eq!(data.series_schema, PERF_SERIES_SCHEMA);
        assert_eq!(data.groups[0].group, "default");
        assert_eq!(data.groups[1].group, "vip");
        assert_eq!(data.groups[1].avg_latency_ms, 2000);
        assert_eq!(data.groups[1].avg_tps, 5.0);
    }

    #[test]
    fn uptime_url_rejects_non_page_slug() {
        assert!(build_uptime_url("https://status.example", UPTIME_STATUS_PATH, "prod_1").is_ok());
        assert!(
            build_uptime_url("https://status.example", UPTIME_STATUS_PATH, "../admin").is_err()
        );
    }
}
