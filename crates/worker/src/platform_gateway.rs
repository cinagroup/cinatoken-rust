//! Cloudflare platform gateway foundation.
//!
//! This module is the Rust-side dispatch layer for the cinaVibeSDK-inspired
//! Workers for Platforms shape: the main Worker acts as a dispatch Worker and
//! forwards preview/tenant traffic to scripts inside a dispatch namespace. The
//! feature is off by default and only activates when explicitly configured.

use cinatoken_providers::ai_gateway::{
    MAIN_RELAY_AI_GATEWAY_CUTOVER_GUARDS, MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS,
};
use serde::Serialize;
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{Env, Headers, Request, RequestInit, Response, Result as WorkerResult};

use crate::admin::{envelope_ok_response, require_admin_auth};
use crate::realtime_session::{
    realtime_billing_presettlement_snapshot_compiled, realtime_billing_settlement_handoff_compiled,
    realtime_billing_settlement_preview_compiled,
    realtime_session_platform_header_boundary_compiled,
    realtime_upstream_bridge_backpressure_policy_compiled,
    realtime_upstream_bridge_backpressure_runtime_compiled,
    realtime_upstream_bridge_close_mapping_compiled,
    realtime_upstream_bridge_connect_contract_compiled,
    realtime_upstream_bridge_event_trace_compiled, realtime_upstream_bridge_frame_guard_compiled,
    realtime_upstream_bridge_lifecycle_compiled, realtime_upstream_bridge_planner_compiled,
    realtime_upstream_bridge_replay_contract_compiled,
    realtime_upstream_bridge_send_failure_guard_compiled,
    realtime_upstream_channel_planner_compiled, realtime_upstream_connect_handoff_compiled,
    realtime_upstream_fetch_upgrade_adapter_compiled, realtime_upstream_usage_capture_compiled,
    REALTIME_SESSION_CUTOVER_GUARDS, REALTIME_SESSION_GATEWAY_ENABLED_ENV,
    REALTIME_SESSION_V1_ENABLED_ENV,
};
use crate::task_orchestration::{task_poller_config_from_env, task_timeout_sweep_compiled};
use crate::task_repository::{
    task_refund_cas_batch_compiled, task_refund_replay_contract_compiled,
};
use crate::task_runner::{
    fetch_task_runner_status, is_task_runner_cutover_ready, task_runner_alarm_contract_compiled,
    task_runner_cutover_guards, task_runner_do_foundation_compiled, task_runner_poll_path_compiled,
    task_runner_staging_replay_verified, task_runner_status_probe_compiled,
    task_runner_status_probe_task_id, task_runner_submit_path_compiled, TASK_RUNNER_BINDING,
    TASK_RUNNER_DO_ENABLED_ENV,
};
use crate::wfp_tenant::{
    wfp_tenant_ai_gateway_policy_compiled, wfp_tenant_cutover_guards,
    wfp_tenant_internal_dispatch_required_compiled, wfp_tenant_response_header_guard_compiled,
    wfp_tenant_route_manifest_compiled, wfp_tenant_rust_wasm_runtime_compiled,
    wfp_tenant_script_plan_compiled, wfp_tenant_supported_routes,
};

pub const WFP_DISPATCH_BINDING: &str = "DISPATCHER";
pub const WFP_DISPATCH_ENABLED_ENV: &str = "WFP_DISPATCH_ENABLED";
pub const WFP_INTERNAL_DISPATCH_ENABLED_ENV: &str = "WFP_INTERNAL_DISPATCH_ENABLED";
pub const WFP_PREVIEW_HOST_SUFFIX_ENV: &str = "WFP_PREVIEW_HOST_SUFFIX";
pub const WFP_DISPATCH_WORKER_PREFIX_ENV: &str = "WFP_DISPATCH_WORKER_PREFIX";
pub const RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV: &str = "RELAY_AI_GATEWAY_ROUTER_ENABLED";
pub const INTERNAL_DISPATCH_PREFIX: &str = "/api/platform/dispatch/";
const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_TOKEN_ENV: &str = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_AI_GATEWAY_TOKEN_ENV: &str = "CLOUDFLARE_AI_GATEWAY_TOKEN";
const AI_GATEWAY_ID_ENV: &str = "AI_GATEWAY_ID";
const WFP_ROUTE_REQUEST_HEADER: &str = "x-cinatoken-wfp-route";
const WFP_WORKER_REQUEST_HEADER: &str = "x-cinatoken-wfp-worker";
const BLOCKED_DISPATCH_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "api-key",
    "cf-access-client-id",
    "cf-access-client-secret",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchTarget {
    pub route_kind: DispatchRouteKind,
    pub public_name: String,
    pub worker_name: String,
    pub tenant_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchRouteKind {
    PreviewHost,
    InternalPath,
}

impl DispatchRouteKind {
    fn header_value(self) -> &'static str {
        match self {
            DispatchRouteKind::PreviewHost => "preview-host",
            DispatchRouteKind::InternalPath => "internal-path",
        }
    }
}

#[derive(Debug, Serialize)]
struct PlatformCapabilities {
    ai_binding_available: bool,
    ai_gateway_id_configured: bool,
    cloudflare_account_id_configured: bool,
    cloudflare_ai_gateway_token_configured: bool,
    relay_ai_gateway_router_enabled: bool,
    relay_ai_gateway_router_ready: bool,
    relay_ai_gateway_rest_routes: Vec<&'static str>,
    relay_ai_gateway_cutover_guards: Vec<&'static str>,
    relay_ai_gateway_channel_opt_in_supported: bool,
    relay_ai_gateway_rest_forwarder_compiled: bool,
    relay_ai_gateway_same_channel_fallback_compiled: bool,
    channel_affinity_do_available: bool,
    realtime_sessions_do_available: bool,
    wfp_dispatch_binding_available: bool,
    wfp_dispatch_enabled: bool,
    wfp_internal_dispatch_enabled: bool,
    wfp_preview_host_suffix_configured: bool,
    wfp_worker_prefix_configured: bool,
    wfp_tenant_supported_routes: Vec<&'static str>,
    wfp_tenant_cutover_guards: Vec<&'static str>,
    wfp_tenant_script_plan_compiled: bool,
    wfp_tenant_rust_wasm_runtime_compiled: bool,
    wfp_tenant_route_manifest_compiled: bool,
    wfp_tenant_internal_dispatch_required_compiled: bool,
    wfp_tenant_response_header_guard_compiled: bool,
    wfp_tenant_ai_gateway_policy_compiled: bool,
    wfp_tenant_smoke_ready: bool,
    realtime_session_gateway_enabled: bool,
    realtime_session_v1_enabled: bool,
    do_websocket_hibernation_compiled: bool,
    realtime_session_cutover_guards: Vec<&'static str>,
    realtime_session_auth_boundary_compiled: bool,
    realtime_session_metrics_persisted_compiled: bool,
    realtime_session_control_no_echo_compiled: bool,
    realtime_session_upstream_bridge_planner_compiled: bool,
    realtime_session_upstream_channel_planner_compiled: bool,
    realtime_session_upstream_bridge_connect_contract_compiled: bool,
    realtime_session_upstream_connect_handoff_compiled: bool,
    realtime_session_upstream_fetch_upgrade_adapter_compiled: bool,
    realtime_session_upstream_bridge_lifecycle_compiled: bool,
    realtime_session_upstream_bridge_frame_guard_compiled: bool,
    realtime_session_upstream_bridge_close_mapping_compiled: bool,
    realtime_session_upstream_bridge_send_failure_guard_compiled: bool,
    realtime_session_upstream_bridge_event_trace_compiled: bool,
    realtime_session_upstream_bridge_replay_contract_compiled: bool,
    realtime_session_upstream_bridge_backpressure_policy_compiled: bool,
    realtime_session_upstream_bridge_backpressure_runtime_compiled: bool,
    realtime_session_upstream_usage_capture_compiled: bool,
    realtime_session_billing_presettlement_snapshot_compiled: bool,
    realtime_session_billing_settlement_preview_compiled: bool,
    realtime_session_billing_settlement_handoff_compiled: bool,
    realtime_session_platform_header_boundary_compiled: bool,
    realtime_session_upstream_bridge_compiled: bool,
    realtime_session_billing_settlement_compiled: bool,
    realtime_session_platform_smoke_ready: bool,
    realtime_session_v1_cutover_ready: bool,
    task_poller_scheduled_handler_compiled: bool,
    task_poller_timeout_sweep_compiled: bool,
    task_poller_refund_batch_compiled: bool,
    task_poller_refund_replay_contract_compiled: bool,
    task_runner_do_available: bool,
    task_runner_do_enabled: bool,
    task_runner_do_foundation_compiled: bool,
    task_runner_alarm_contract_compiled: bool,
    task_runner_submit_path_compiled: bool,
    task_runner_poll_path_compiled: bool,
    task_runner_status_probe_compiled: bool,
    task_runner_staging_replay_verified: bool,
    task_runner_cutover_ready: bool,
    task_runner_cutover_guards: Vec<&'static str>,
    task_poller_timeout_sweep_enabled: bool,
    task_poller_query_limit: i64,
    task_poller_timeout_minutes: i64,
    task_poller_timeout_sweep_limit: i64,
}

/// Admin-only capability probe for the production migration cockpit.
pub async fn capabilities(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }

    let ai_gateway_id_configured = runtime_value(&env, AI_GATEWAY_ID_ENV).is_some();
    let cloudflare_account_id_configured = runtime_value(&env, CLOUDFLARE_ACCOUNT_ID_ENV).is_some();
    let cloudflare_ai_gateway_token_configured = cloudflare_ai_gateway_token_configured(&env);
    let relay_ai_gateway_router_enabled = env_flag(&env, RELAY_AI_GATEWAY_ROUTER_ENABLED_ENV);
    let relay_ai_gateway_router_ready = is_relay_ai_gateway_router_ready(
        relay_ai_gateway_router_enabled,
        cloudflare_account_id_configured,
        ai_gateway_id_configured,
        cloudflare_ai_gateway_token_configured,
    );
    let realtime_sessions_do_available = env.durable_object("REALTIME_SESSIONS").is_ok();
    let wfp_dispatch_binding_available = env.dynamic_dispatcher(WFP_DISPATCH_BINDING).is_ok();
    let wfp_dispatch_enabled = env_flag(&env, WFP_DISPATCH_ENABLED_ENV);
    let wfp_internal_dispatch_enabled = env_flag(&env, WFP_INTERNAL_DISPATCH_ENABLED_ENV);
    let wfp_tenant_script_plan_compiled = wfp_tenant_script_plan_compiled();
    let wfp_tenant_rust_wasm_runtime_compiled = wfp_tenant_rust_wasm_runtime_compiled();
    let wfp_tenant_route_manifest_compiled = wfp_tenant_route_manifest_compiled();
    let wfp_tenant_internal_dispatch_required_compiled =
        wfp_tenant_internal_dispatch_required_compiled();
    let wfp_tenant_response_header_guard_compiled = wfp_tenant_response_header_guard_compiled();
    let wfp_tenant_ai_gateway_policy_compiled = wfp_tenant_ai_gateway_policy_compiled();
    let wfp_tenant_smoke_ready = is_wfp_tenant_smoke_ready(
        wfp_dispatch_binding_available,
        wfp_dispatch_enabled,
        wfp_internal_dispatch_enabled,
        wfp_tenant_script_plan_compiled,
        wfp_tenant_rust_wasm_runtime_compiled,
        wfp_tenant_route_manifest_compiled,
        wfp_tenant_internal_dispatch_required_compiled,
        wfp_tenant_response_header_guard_compiled,
        wfp_tenant_ai_gateway_policy_compiled,
    );
    let realtime_session_gateway_enabled = env_flag(&env, REALTIME_SESSION_GATEWAY_ENABLED_ENV);
    let realtime_session_v1_enabled = env_flag(&env, REALTIME_SESSION_V1_ENABLED_ENV);
    let do_websocket_hibernation_compiled = true;
    let realtime_session_auth_boundary_compiled = true;
    let realtime_session_metrics_persisted_compiled = true;
    let realtime_session_control_no_echo_compiled = true;
    let realtime_session_upstream_bridge_planner_compiled =
        realtime_upstream_bridge_planner_compiled();
    let realtime_session_upstream_channel_planner_compiled =
        realtime_upstream_channel_planner_compiled();
    let realtime_session_upstream_bridge_connect_contract_compiled =
        realtime_upstream_bridge_connect_contract_compiled();
    let realtime_session_upstream_connect_handoff_compiled =
        realtime_upstream_connect_handoff_compiled();
    let realtime_session_upstream_fetch_upgrade_adapter_compiled =
        realtime_upstream_fetch_upgrade_adapter_compiled();
    let realtime_session_upstream_bridge_lifecycle_compiled =
        realtime_upstream_bridge_lifecycle_compiled();
    let realtime_session_upstream_bridge_frame_guard_compiled =
        realtime_upstream_bridge_frame_guard_compiled();
    let realtime_session_upstream_bridge_close_mapping_compiled =
        realtime_upstream_bridge_close_mapping_compiled();
    let realtime_session_upstream_bridge_send_failure_guard_compiled =
        realtime_upstream_bridge_send_failure_guard_compiled();
    let realtime_session_upstream_bridge_event_trace_compiled =
        realtime_upstream_bridge_event_trace_compiled();
    let realtime_session_upstream_bridge_replay_contract_compiled =
        realtime_upstream_bridge_replay_contract_compiled();
    let realtime_session_upstream_bridge_backpressure_policy_compiled =
        realtime_upstream_bridge_backpressure_policy_compiled();
    let realtime_session_upstream_bridge_backpressure_runtime_compiled =
        realtime_upstream_bridge_backpressure_runtime_compiled();
    let realtime_session_upstream_usage_capture_compiled =
        realtime_upstream_usage_capture_compiled();
    let realtime_session_billing_presettlement_snapshot_compiled =
        realtime_billing_presettlement_snapshot_compiled();
    let realtime_session_billing_settlement_preview_compiled =
        realtime_billing_settlement_preview_compiled();
    let realtime_session_billing_settlement_handoff_compiled =
        realtime_billing_settlement_handoff_compiled();
    let realtime_session_platform_header_boundary_compiled =
        realtime_session_platform_header_boundary_compiled();
    let realtime_session_upstream_bridge_compiled = false;
    let realtime_session_billing_settlement_compiled = false;
    let realtime_session_platform_smoke_ready = is_realtime_session_platform_smoke_ready(
        realtime_sessions_do_available,
        realtime_session_gateway_enabled,
        do_websocket_hibernation_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_platform_header_boundary_compiled,
    );
    let realtime_session_v1_cutover_ready = is_realtime_session_v1_cutover_ready(
        realtime_sessions_do_available,
        realtime_session_v1_enabled,
        realtime_session_auth_boundary_compiled,
        do_websocket_hibernation_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_upstream_channel_planner_compiled,
        realtime_session_upstream_bridge_connect_contract_compiled,
        realtime_session_upstream_connect_handoff_compiled,
        realtime_session_upstream_fetch_upgrade_adapter_compiled,
        realtime_session_upstream_bridge_lifecycle_compiled,
        realtime_session_upstream_bridge_frame_guard_compiled,
        realtime_session_upstream_bridge_close_mapping_compiled,
        realtime_session_upstream_bridge_send_failure_guard_compiled,
        realtime_session_upstream_bridge_event_trace_compiled,
        realtime_session_upstream_bridge_replay_contract_compiled,
        realtime_session_upstream_bridge_backpressure_policy_compiled,
        realtime_session_upstream_bridge_backpressure_runtime_compiled,
        realtime_session_upstream_usage_capture_compiled,
        realtime_session_billing_presettlement_snapshot_compiled,
        realtime_session_billing_settlement_preview_compiled,
        realtime_session_billing_settlement_handoff_compiled,
        realtime_session_platform_header_boundary_compiled,
        realtime_session_upstream_bridge_compiled,
        realtime_session_billing_settlement_compiled,
    );
    let task_poller_config = task_poller_config_from_env(&env);
    let task_poller_timeout_sweep_compiled = task_timeout_sweep_compiled();
    let task_poller_refund_batch_compiled = task_refund_cas_batch_compiled();
    let task_poller_refund_replay_contract_compiled = task_refund_replay_contract_compiled();
    let task_runner_do_available = env.durable_object(TASK_RUNNER_BINDING).is_ok();
    let task_runner_do_enabled = env_flag(&env, TASK_RUNNER_DO_ENABLED_ENV);
    let task_runner_do_foundation_compiled = task_runner_do_foundation_compiled();
    let task_runner_alarm_contract_compiled = task_runner_alarm_contract_compiled();
    let task_runner_submit_path_compiled = task_runner_submit_path_compiled();
    let task_runner_poll_path_compiled = task_runner_poll_path_compiled();
    let task_runner_status_probe_compiled = task_runner_status_probe_compiled();
    let task_runner_staging_replay_verified = task_runner_staging_replay_verified(&env);
    let task_runner_cutover_ready = is_task_runner_cutover_ready(
        task_runner_do_available,
        task_runner_do_enabled,
        task_runner_do_foundation_compiled,
        task_runner_alarm_contract_compiled,
        task_runner_submit_path_compiled,
        task_runner_poll_path_compiled,
        task_runner_status_probe_compiled,
        task_runner_staging_replay_verified,
    );

    let capabilities = PlatformCapabilities {
        ai_binding_available: env.ai("AI").is_ok(),
        ai_gateway_id_configured,
        cloudflare_account_id_configured,
        cloudflare_ai_gateway_token_configured,
        relay_ai_gateway_router_enabled,
        relay_ai_gateway_router_ready,
        relay_ai_gateway_rest_routes: relay_ai_gateway_rest_routes(),
        relay_ai_gateway_cutover_guards: relay_ai_gateway_cutover_guards(),
        relay_ai_gateway_channel_opt_in_supported: true,
        relay_ai_gateway_rest_forwarder_compiled: true,
        relay_ai_gateway_same_channel_fallback_compiled: true,
        channel_affinity_do_available: env.durable_object("CHANNEL_AFFINITY").is_ok(),
        realtime_sessions_do_available,
        wfp_dispatch_binding_available,
        wfp_dispatch_enabled,
        wfp_internal_dispatch_enabled,
        wfp_preview_host_suffix_configured: runtime_value(&env, WFP_PREVIEW_HOST_SUFFIX_ENV)
            .is_some(),
        wfp_worker_prefix_configured: runtime_value(&env, WFP_DISPATCH_WORKER_PREFIX_ENV).is_some(),
        wfp_tenant_supported_routes: wfp_tenant_supported_routes(),
        wfp_tenant_cutover_guards: wfp_tenant_cutover_guards(),
        wfp_tenant_script_plan_compiled,
        wfp_tenant_rust_wasm_runtime_compiled,
        wfp_tenant_route_manifest_compiled,
        wfp_tenant_internal_dispatch_required_compiled,
        wfp_tenant_response_header_guard_compiled,
        wfp_tenant_ai_gateway_policy_compiled,
        wfp_tenant_smoke_ready,
        realtime_session_gateway_enabled,
        realtime_session_v1_enabled,
        do_websocket_hibernation_compiled,
        realtime_session_cutover_guards: realtime_session_cutover_guards(),
        realtime_session_auth_boundary_compiled,
        realtime_session_metrics_persisted_compiled,
        realtime_session_control_no_echo_compiled,
        realtime_session_upstream_bridge_planner_compiled,
        realtime_session_upstream_channel_planner_compiled,
        realtime_session_upstream_bridge_connect_contract_compiled,
        realtime_session_upstream_connect_handoff_compiled,
        realtime_session_upstream_fetch_upgrade_adapter_compiled,
        realtime_session_upstream_bridge_lifecycle_compiled,
        realtime_session_upstream_bridge_frame_guard_compiled,
        realtime_session_upstream_bridge_close_mapping_compiled,
        realtime_session_upstream_bridge_send_failure_guard_compiled,
        realtime_session_upstream_bridge_event_trace_compiled,
        realtime_session_upstream_bridge_replay_contract_compiled,
        realtime_session_upstream_bridge_backpressure_policy_compiled,
        realtime_session_upstream_bridge_backpressure_runtime_compiled,
        realtime_session_upstream_usage_capture_compiled,
        realtime_session_billing_presettlement_snapshot_compiled,
        realtime_session_billing_settlement_preview_compiled,
        realtime_session_billing_settlement_handoff_compiled,
        realtime_session_platform_header_boundary_compiled,
        realtime_session_upstream_bridge_compiled,
        realtime_session_billing_settlement_compiled,
        realtime_session_platform_smoke_ready,
        realtime_session_v1_cutover_ready,
        task_poller_scheduled_handler_compiled: true,
        task_poller_timeout_sweep_compiled,
        task_poller_refund_batch_compiled,
        task_poller_refund_replay_contract_compiled,
        task_runner_do_available,
        task_runner_do_enabled,
        task_runner_do_foundation_compiled,
        task_runner_alarm_contract_compiled,
        task_runner_submit_path_compiled,
        task_runner_poll_path_compiled,
        task_runner_status_probe_compiled,
        task_runner_staging_replay_verified,
        task_runner_cutover_ready,
        task_runner_cutover_guards: task_runner_cutover_guards(),
        task_poller_timeout_sweep_enabled: task_poller_config.timeout_minutes > 0,
        task_poller_query_limit: task_poller_config.query_limit,
        task_poller_timeout_minutes: task_poller_config.timeout_minutes,
        task_poller_timeout_sweep_limit: task_poller_config.timeout_sweep_limit,
    };

    envelope_ok_response(&capabilities)
}

pub async fn task_runner_status(
    req: Request,
    env: Env,
    task_id: Option<String>,
) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(task_id) = task_id
        .as_deref()
        .and_then(task_runner_status_probe_task_id)
    else {
        return gateway_error(
            400,
            "invalid_task_runner_task_id",
            "TaskRunner status probe requires a valid task id",
        );
    };
    let status = match fetch_task_runner_status(&env, &task_id).await {
        Ok(status) => status,
        Err(err) => {
            worker::console_warn!("TaskRunner status probe unavailable: {}", err);
            return gateway_error(
                503,
                "task_runner_status_unavailable",
                "TaskRunner status probe is unavailable",
            );
        }
    };
    let mut response = envelope_ok_response(&status)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

/// Resolve whether this request should be handled by WFP dispatch before the
/// normal API/static-asset router sees it.
pub fn dispatch_target_for_request(
    req: &Request,
    env: &Env,
) -> WorkerResult<Option<DispatchTarget>> {
    if !env_flag(env, WFP_DISPATCH_ENABLED_ENV) {
        return Ok(None);
    }

    let prefix = runtime_value(env, WFP_DISPATCH_WORKER_PREFIX_ENV);
    if env_flag(env, WFP_INTERNAL_DISPATCH_ENABLED_ENV) {
        if let Some(route) = internal_dispatch_route(&req.path()) {
            return Ok(Some(dispatch_target(
                DispatchRouteKind::InternalPath,
                &route.public_name,
                prefix.as_deref(),
                Some(route.tenant_path),
            )?));
        }
    }

    let suffix = match runtime_value(env, WFP_PREVIEW_HOST_SUFFIX_ENV) {
        Some(value) => value,
        None => return Ok(None),
    };
    let Some(host) = host_header(req)? else {
        return Ok(None);
    };
    let Some(public_name) = preview_script_name_from_host(&host, &suffix) else {
        return Ok(None);
    };

    Ok(Some(dispatch_target(
        DispatchRouteKind::PreviewHost,
        &public_name,
        prefix.as_deref(),
        None,
    )?))
}

pub async fn dispatch_request(
    req: Request,
    env: Env,
    target: DispatchTarget,
) -> WorkerResult<Response> {
    if internal_dispatch_requires_admin_auth(&target) {
        if let Err(response) = require_admin_auth(&req, &env).await? {
            return Ok(response);
        }
    }

    let dispatcher = match env.dynamic_dispatcher(WFP_DISPATCH_BINDING) {
        Ok(dispatcher) => dispatcher,
        Err(err) => {
            worker::console_error!("WFP dispatch binding unavailable: {}", err);
            return gateway_error(
                503,
                "wfp_dispatch_unavailable",
                "WFP dispatch binding is not configured",
            );
        }
    };
    let fetcher = match dispatcher.get(target.worker_name.clone()) {
        Ok(fetcher) => fetcher,
        Err(err) => {
            worker::console_warn!(
                "failed to resolve WFP tenant worker {}: {}",
                target.worker_name,
                err
            );
            return gateway_error(
                404,
                "wfp_worker_not_found",
                "WFP tenant worker was not found",
            );
        }
    };

    let outbound = request_for_dispatch_target(req, &target)?;
    let mut response = fetcher.fetch_request(outbound).await?;
    let headers = response.headers_mut();
    let _ = headers.set(WFP_ROUTE_REQUEST_HEADER, target.route_kind.header_value());
    let _ = headers.set(WFP_WORKER_REQUEST_HEADER, &target.public_name);
    Ok(response)
}

fn dispatch_target(
    route_kind: DispatchRouteKind,
    public_name: &str,
    prefix: Option<&str>,
    tenant_path: Option<String>,
) -> WorkerResult<DispatchTarget> {
    let public_name = normalize_worker_name(public_name)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker name".to_string()))?;
    let worker_name = prefixed_worker_name(&public_name, prefix)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker prefix".to_string()))?;
    Ok(DispatchTarget {
        route_kind,
        public_name,
        worker_name,
        tenant_path,
    })
}

fn host_header(req: &Request) -> WorkerResult<Option<String>> {
    Ok(req.headers().get("Host")?.or_else(|| {
        req.url()
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InternalDispatchRoute {
    public_name: String,
    tenant_path: String,
}

fn internal_dispatch_route(path: &str) -> Option<InternalDispatchRoute> {
    let rest = path.strip_prefix(INTERNAL_DISPATCH_PREFIX)?;
    let (script, tenant_path) = rest.split_once('/').unwrap_or((rest, ""));
    Some(InternalDispatchRoute {
        public_name: normalize_worker_name(script)?,
        tenant_path: normalize_tenant_dispatch_path(tenant_path),
    })
}

#[cfg(test)]
fn internal_dispatch_script_name(path: &str) -> Option<String> {
    internal_dispatch_route(path).map(|route| route.public_name)
}

fn normalize_tenant_dispatch_path(value: &str) -> String {
    if value.is_empty() {
        "/".to_string()
    } else {
        format!("/{value}")
    }
}

fn preview_script_name_from_host(host: &str, suffix: &str) -> Option<String> {
    let host = normalize_host(host)?;
    let suffix = normalize_host(suffix.trim_start_matches('.'))?;
    if host == suffix {
        return None;
    }
    let expected_tail = format!(".{suffix}");
    let script = host.strip_suffix(&expected_tail)?;
    if script.contains('.') {
        return None;
    }
    normalize_worker_name(script)
}

fn prefixed_worker_name(public_name: &str, prefix: Option<&str>) -> Option<String> {
    let prefix = prefix.unwrap_or_default().trim();
    if prefix.is_empty() {
        return Some(public_name.to_string());
    }
    if !prefix.chars().all(is_worker_name_char) {
        return None;
    }
    let worker_name = format!("{prefix}{public_name}");
    normalize_worker_name(&worker_name)
}

fn request_for_dispatch_target(req: Request, target: &DispatchTarget) -> WorkerResult<Request> {
    let mut url = req.url()?;
    if let Some(tenant_path) = target.tenant_path.as_deref() {
        url.set_path(tenant_path);
    }

    let headers = dispatch_forward_headers_for_target(req.headers(), target)?;
    let body = req.inner().body().map(JsValue::from);
    let mut init = RequestInit::new();
    init.with_method(req.method()).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(body));
    }
    Request::new_with_init(url.as_str(), &init)
}

fn internal_dispatch_requires_admin_auth(target: &DispatchTarget) -> bool {
    target.route_kind == DispatchRouteKind::InternalPath
}

fn dispatch_forward_headers(input: &Headers) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    for (name, value) in input {
        if should_forward_dispatch_request_header(&name) {
            headers.append(&name, &value)?;
        }
    }
    Ok(headers)
}

fn dispatch_forward_headers_for_target(
    input: &Headers,
    target: &DispatchTarget,
) -> WorkerResult<Headers> {
    let mut headers = dispatch_forward_headers(input)?;
    append_dispatch_platform_headers(&mut headers, target)?;
    Ok(headers)
}

fn append_dispatch_platform_headers(
    headers: &mut Headers,
    target: &DispatchTarget,
) -> WorkerResult<()> {
    let values = dispatch_platform_header_values(target);
    headers.set(WFP_ROUTE_REQUEST_HEADER, values.route)?;
    headers.set(WFP_WORKER_REQUEST_HEADER, values.worker)?;
    Ok(())
}

struct DispatchPlatformHeaderValues<'a> {
    route: &'static str,
    worker: &'a str,
}

fn dispatch_platform_header_values(target: &DispatchTarget) -> DispatchPlatformHeaderValues<'_> {
    DispatchPlatformHeaderValues {
        route: target.route_kind.header_value(),
        worker: &target.public_name,
    }
}

fn should_forward_dispatch_request_header(name: &str) -> bool {
    !is_blocked_dispatch_request_header(name)
}

fn is_blocked_dispatch_request_header(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    BLOCKED_DISPATCH_REQUEST_HEADERS.contains(&name.as_str()) || name.starts_with("x-cinatoken-")
}

fn normalize_host(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    if let Some(stripped) = host.strip_prefix('[') {
        return stripped
            .split_once(']')
            .map(|(ipv6, _)| ipv6.to_string())
            .filter(|value| !value.is_empty());
    }
    let without_port = host.split_once(':').map(|(name, _)| name).unwrap_or(&host);
    (!without_port.is_empty()).then(|| without_port.to_string())
}

pub(crate) fn normalize_worker_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 63 {
        return None;
    }
    if value.starts_with('-')
        || value.ends_with('-')
        || value.starts_with('_')
        || value.ends_with('_')
    {
        return None;
    }
    value.chars().all(is_worker_name_char).then_some(value)
}

pub(crate) fn is_worker_name_char(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_'
}

pub(crate) fn env_flag(env: &Env, name: &str) -> bool {
    runtime_value(env, name)
        .map(|value| matches!(value.as_str(), "true" | "1" | "yes" | "on"))
        .unwrap_or(false)
}

pub(crate) fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn secret_or_var(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| runtime_value(env, name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn cloudflare_ai_gateway_token_configured(env: &Env) -> bool {
    secret_or_var(env, CLOUDFLARE_AI_GATEWAY_TOKEN_ENV).is_some()
        || secret_or_var(env, CLOUDFLARE_API_TOKEN_ENV).is_some()
}

fn relay_ai_gateway_rest_routes() -> Vec<&'static str> {
    MAIN_RELAY_AI_GATEWAY_REST_ROUTE_PLANS
        .iter()
        .map(|plan| plan.rest_endpoint.relay_path())
        .collect()
}

fn relay_ai_gateway_cutover_guards() -> Vec<&'static str> {
    MAIN_RELAY_AI_GATEWAY_CUTOVER_GUARDS.to_vec()
}

fn realtime_session_cutover_guards() -> Vec<&'static str> {
    REALTIME_SESSION_CUTOVER_GUARDS.to_vec()
}

fn is_relay_ai_gateway_router_ready(
    router_enabled: bool,
    account_configured: bool,
    gateway_id_configured: bool,
    token_configured: bool,
) -> bool {
    router_enabled && account_configured && gateway_id_configured && token_configured
}

#[allow(clippy::too_many_arguments)]
fn is_wfp_tenant_smoke_ready(
    dispatcher_bound: bool,
    dispatch_enabled: bool,
    internal_dispatch_enabled: bool,
    tenant_script_plan_compiled: bool,
    rust_wasm_runtime_compiled: bool,
    route_manifest_compiled: bool,
    internal_dispatch_required_compiled: bool,
    response_header_guard_compiled: bool,
    ai_gateway_policy_compiled: bool,
) -> bool {
    dispatcher_bound
        && dispatch_enabled
        && internal_dispatch_enabled
        && tenant_script_plan_compiled
        && rust_wasm_runtime_compiled
        && route_manifest_compiled
        && internal_dispatch_required_compiled
        && response_header_guard_compiled
        && ai_gateway_policy_compiled
}

fn is_realtime_session_platform_smoke_ready(
    do_available: bool,
    platform_gate_enabled: bool,
    hibernation_compiled: bool,
    metrics_persisted_compiled: bool,
    control_no_echo_compiled: bool,
    platform_header_boundary_compiled: bool,
) -> bool {
    do_available
        && platform_gate_enabled
        && hibernation_compiled
        && metrics_persisted_compiled
        && control_no_echo_compiled
        && platform_header_boundary_compiled
}

#[allow(clippy::too_many_arguments)]
fn is_realtime_session_v1_cutover_ready(
    do_available: bool,
    v1_gate_enabled: bool,
    auth_boundary_compiled: bool,
    hibernation_compiled: bool,
    metrics_persisted_compiled: bool,
    control_no_echo_compiled: bool,
    upstream_channel_planner_compiled: bool,
    upstream_bridge_connect_contract_compiled: bool,
    upstream_connect_handoff_compiled: bool,
    upstream_fetch_upgrade_adapter_compiled: bool,
    upstream_bridge_lifecycle_compiled: bool,
    upstream_bridge_frame_guard_compiled: bool,
    upstream_bridge_close_mapping_compiled: bool,
    upstream_bridge_send_failure_guard_compiled: bool,
    upstream_bridge_event_trace_compiled: bool,
    upstream_bridge_replay_contract_compiled: bool,
    upstream_bridge_backpressure_policy_compiled: bool,
    upstream_bridge_backpressure_runtime_compiled: bool,
    upstream_usage_capture_compiled: bool,
    billing_presettlement_snapshot_compiled: bool,
    billing_settlement_preview_compiled: bool,
    billing_settlement_handoff_compiled: bool,
    platform_header_boundary_compiled: bool,
    upstream_bridge_compiled: bool,
    billing_settlement_compiled: bool,
) -> bool {
    do_available
        && v1_gate_enabled
        && auth_boundary_compiled
        && hibernation_compiled
        && metrics_persisted_compiled
        && control_no_echo_compiled
        && upstream_channel_planner_compiled
        && upstream_bridge_connect_contract_compiled
        && upstream_connect_handoff_compiled
        && upstream_fetch_upgrade_adapter_compiled
        && upstream_bridge_lifecycle_compiled
        && upstream_bridge_frame_guard_compiled
        && upstream_bridge_close_mapping_compiled
        && upstream_bridge_send_failure_guard_compiled
        && upstream_bridge_event_trace_compiled
        && upstream_bridge_replay_contract_compiled
        && upstream_bridge_backpressure_policy_compiled
        && upstream_bridge_backpressure_runtime_compiled
        && upstream_usage_capture_compiled
        && billing_presettlement_snapshot_compiled
        && billing_settlement_preview_compiled
        && billing_settlement_handoff_compiled
        && platform_header_boundary_compiled
        && upstream_bridge_compiled
        && billing_settlement_compiled
}

fn gateway_error(status: u16, code: &str, message: &str) -> WorkerResult<Response> {
    crate::json_with_status(
        &json!({
            "error": {
                "code": code,
                "message": message,
                "type": "platform_gateway_error"
            }
        }),
        status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_dispatch_extracts_script_name_only() {
        assert_eq!(
            internal_dispatch_script_name("/api/platform/dispatch/tenant-a/v1/models").as_deref(),
            Some("tenant-a")
        );
        assert_eq!(
            internal_dispatch_script_name("/api/platform/dispatch/Tenant_1").as_deref(),
            Some("tenant_1")
        );
        assert!(internal_dispatch_script_name("/api/platform/dispatch/../x").is_none());
        assert!(internal_dispatch_script_name("/api/platform/dispatch/-bad").is_none());
    }

    #[test]
    fn internal_dispatch_rewrites_to_tenant_visible_path() {
        let route =
            internal_dispatch_route("/api/platform/dispatch/tenant-a/__cinatoken/tenant/status")
                .unwrap();
        assert_eq!(route.public_name, "tenant-a");
        assert_eq!(route.tenant_path, "/__cinatoken/tenant/status");

        let route =
            internal_dispatch_route("/api/platform/dispatch/tenant-a/v1/responses").unwrap();
        assert_eq!(route.tenant_path, "/v1/responses");

        let route = internal_dispatch_route("/api/platform/dispatch/tenant-a").unwrap();
        assert_eq!(route.tenant_path, "/");
    }

    #[test]
    fn internal_dispatch_requires_admin_auth_but_preview_host_does_not() {
        let internal = DispatchTarget {
            route_kind: DispatchRouteKind::InternalPath,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/__cinatoken/tenant/status".to_string()),
        };
        assert!(internal_dispatch_requires_admin_auth(&internal));

        let preview = DispatchTarget {
            route_kind: DispatchRouteKind::PreviewHost,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: None,
        };
        assert!(!internal_dispatch_requires_admin_auth(&preview));
    }

    #[test]
    fn dispatch_request_header_forwarding_strips_credentials_and_platform_markers() {
        for header in [
            "Authorization",
            "Cookie",
            "Proxy-Authorization",
            "X-Api-Key",
            "X-Goog-Api-Key",
            "Api-Key",
            "CF-Access-Client-Id",
            "CF-Access-Client-Secret",
            "X-Cinatoken-Smoke",
            "x-cinatoken-tenant",
        ] {
            assert!(
                !should_forward_dispatch_request_header(header),
                "expected {header} to be stripped before WFP dispatch"
            );
        }

        for header in ["Content-Type", "Accept", "User-Agent", "Traceparent"] {
            assert!(
                should_forward_dispatch_request_header(header),
                "expected {header} to be forwarded to WFP dispatch"
            );
        }
    }

    #[test]
    fn dispatch_request_header_forwarding_adds_controlled_platform_markers() {
        let target = DispatchTarget {
            route_kind: DispatchRouteKind::InternalPath,
            public_name: "tenant-a".to_string(),
            worker_name: "tenant-a".to_string(),
            tenant_path: Some("/v1/responses".to_string()),
        };

        let values = dispatch_platform_header_values(&target);

        assert_eq!(values.route, "internal-path");
        assert_eq!(values.worker, "tenant-a");
        assert!(!should_forward_dispatch_request_header(
            WFP_ROUTE_REQUEST_HEADER
        ));
        assert!(!should_forward_dispatch_request_header(
            WFP_WORKER_REQUEST_HEADER
        ));
    }

    #[test]
    fn preview_host_maps_single_label_subdomains() {
        assert_eq!(
            preview_script_name_from_host(
                "Tenant-A.preview.example.com:443",
                "preview.example.com"
            )
            .as_deref(),
            Some("tenant-a")
        );
        assert_eq!(
            preview_script_name_from_host("tenant-a.preview.example.com", ".preview.example.com")
                .as_deref(),
            Some("tenant-a")
        );
        assert!(
            preview_script_name_from_host("preview.example.com", "preview.example.com").is_none()
        );
        assert!(preview_script_name_from_host(
            "nested.tenant.preview.example.com",
            "preview.example.com"
        )
        .is_none());
    }

    #[test]
    fn worker_name_prefix_is_validated() {
        assert_eq!(
            prefixed_worker_name("tenant-a", Some("ct-")).as_deref(),
            Some("ct-tenant-a")
        );
        assert!(prefixed_worker_name("tenant-a", Some("bad.prefix.")).is_none());
        assert!(normalize_worker_name("").is_none());
        assert!(normalize_worker_name("bad/path").is_none());
    }

    #[test]
    fn relay_ai_gateway_rest_routes_match_compiled_main_relay_plan() {
        assert_eq!(
            relay_ai_gateway_rest_routes(),
            vec!["chat/completions", "responses", "messages"]
        );
    }

    #[test]
    fn relay_ai_gateway_cutover_guards_are_operator_visible() {
        assert!(relay_ai_gateway_cutover_guards().contains(&"router_ready"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"channel_opted_in"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"direct_provider_fallback"));
        assert!(relay_ai_gateway_cutover_guards().contains(&"billing_settlement_invariant"));
    }

    #[test]
    fn relay_ai_gateway_router_ready_requires_explicit_gate_and_config() {
        assert!(is_relay_ai_gateway_router_ready(true, true, true, true));
        assert!(!is_relay_ai_gateway_router_ready(false, true, true, true));
        assert!(!is_relay_ai_gateway_router_ready(true, false, true, true));
        assert!(!is_relay_ai_gateway_router_ready(true, true, false, true));
        assert!(!is_relay_ai_gateway_router_ready(true, true, true, false));
    }

    #[test]
    fn wfp_tenant_capability_contract_is_operator_visible() {
        let routes = wfp_tenant_supported_routes();
        for route in [
            "/__cinatoken/tenant/status",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/messages",
            "/v1/embeddings",
            "/ai/run",
        ] {
            assert!(routes.contains(&route), "missing WFP tenant route {route}");
        }

        let guards = wfp_tenant_cutover_guards();
        for guard in [
            "dispatcher_binding",
            "dispatch_gate",
            "internal_dispatch_gate",
            "tenant_script_plan",
            "rust_wasm_runtime",
            "route_manifest",
            "internal_dispatch_required",
            "request_header_scrub",
            "response_header_allowlist",
            "ai_gateway_policy_headers",
            "tenant_status_smoke",
            "route_smoke",
        ] {
            assert!(guards.contains(&guard), "missing WFP tenant guard {guard}");
        }

        assert!(wfp_tenant_script_plan_compiled());
        assert!(wfp_tenant_rust_wasm_runtime_compiled());
        assert!(wfp_tenant_route_manifest_compiled());
        assert!(wfp_tenant_internal_dispatch_required_compiled());
        assert!(wfp_tenant_response_header_guard_compiled());
        assert!(wfp_tenant_ai_gateway_policy_compiled());
    }

    #[test]
    fn wfp_tenant_smoke_ready_requires_binding_gate_and_contracts() {
        assert!(wfp_tenant_smoke_ready_with_flags([true; 9]));

        for false_gate in 0..9 {
            let mut flags = [true; 9];
            flags[false_gate] = false;
            assert!(
                !wfp_tenant_smoke_ready_with_flags(flags),
                "expected WFP tenant smoke readiness to wait on gate index {false_gate}"
            );
        }
    }

    #[test]
    fn task_poller_timeout_sweep_is_operator_visible() {
        assert!(task_timeout_sweep_compiled());
        assert!(task_refund_cas_batch_compiled());
        assert!(task_refund_replay_contract_compiled());
    }

    #[test]
    fn task_runner_alarm_foundation_is_operator_visible_but_not_cutover_ready() {
        assert!(task_runner_do_foundation_compiled());
        assert!(task_runner_alarm_contract_compiled());
        assert!(task_runner_submit_path_compiled());
        assert!(task_runner_poll_path_compiled());
        assert!(task_runner_status_probe_compiled());
        let guards = task_runner_cutover_guards();
        assert!(guards.contains(&"task_runner_binding"));
        assert!(guards.contains(&"alarm_contract"));
        assert!(guards.contains(&"submit_path_armed"));
        assert!(guards.contains(&"cron_sweeper_fallback"));
        assert!(guards.contains(&"no_double_poll_cas"));
        assert!(guards.contains(&"status_probe"));
        assert!(!is_task_runner_cutover_ready(
            true, true, true, true, true, true, true, false
        ));
    }

    #[test]
    fn realtime_session_cutover_guards_expose_remaining_blockers() {
        let guards = realtime_session_cutover_guards();
        assert!(guards.contains(&"platform_gateway_gate"));
        assert!(guards.contains(&"v1_gateway_gate"));
        assert!(guards.contains(&"relay_token_auth"));
        assert!(guards.contains(&"relay_rate_limits"));
        assert!(guards.contains(&"upstream_fetch_upgrade_adapter"));
        assert!(guards.contains(&"upstream_bridge_lifecycle"));
        assert!(guards.contains(&"upstream_bridge_frame_guard"));
        assert!(guards.contains(&"upstream_bridge_close_mapping"));
        assert!(guards.contains(&"upstream_bridge_send_failure_guard"));
        assert!(guards.contains(&"upstream_bridge_event_trace"));
        assert!(guards.contains(&"upstream_bridge_replay_contract"));
        assert!(guards.contains(&"upstream_bridge_backpressure_policy"));
        assert!(guards.contains(&"upstream_bridge_backpressure_runtime"));
        assert!(guards.contains(&"upstream_usage_capture"));
        assert!(guards.contains(&"billing_presettlement_snapshot"));
        assert!(guards.contains(&"billing_settlement_preview"));
        assert!(guards.contains(&"billing_settlement_handoff"));
        assert!(guards.contains(&"platform_upstream_header_boundary"));
        assert!(guards.contains(&"hibernation_attachment_restore"));
        assert!(guards.contains(&"metadata_only_control_frames"));
        assert!(guards.contains(&"upstream_bridge"));
        assert!(guards.contains(&"billing_settlement"));
    }

    #[test]
    fn realtime_platform_smoke_ready_requires_do_gate_and_safe_control_surface() {
        assert!(is_realtime_session_platform_smoke_ready(
            true, true, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            false, true, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, false, true, true, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, false, true, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, true, false, true
        ));
        assert!(!is_realtime_session_platform_smoke_ready(
            true, true, true, true, true, false
        ));
    }

    #[test]
    fn realtime_v1_cutover_ready_stays_false_until_bridge_and_billing_land() {
        assert!(realtime_v1_ready_with_flags([true; 25]));

        for false_gate in 0..25 {
            let mut flags = [true; 25];
            flags[false_gate] = false;
            assert!(
                !realtime_v1_ready_with_flags(flags),
                "expected realtime v1 cutover to wait on gate index {false_gate}"
            );
        }
    }

    fn realtime_v1_ready_with_flags(flags: [bool; 25]) -> bool {
        is_realtime_session_v1_cutover_ready(
            flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
            flags[8], flags[9], flags[10], flags[11], flags[12], flags[13], flags[14], flags[15],
            flags[16], flags[17], flags[18], flags[19], flags[20], flags[21], flags[22], flags[23],
            flags[24],
        )
    }

    fn wfp_tenant_smoke_ready_with_flags(flags: [bool; 9]) -> bool {
        is_wfp_tenant_smoke_ready(
            flags[0], flags[1], flags[2], flags[3], flags[4], flags[5], flags[6], flags[7],
            flags[8],
        )
    }
}
