//! Cloudflare platform gateway foundation.
//!
//! This module is the Rust-side dispatch layer for the cinaVibeSDK-inspired
//! Workers for Platforms shape: the main Worker acts as a dispatch Worker and
//! forwards preview/tenant traffic to scripts inside a dispatch namespace. The
//! feature is off by default and only activates when explicitly configured.

use serde::Serialize;
use serde_json::json;
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{envelope_ok_response, require_admin_auth};

pub const WFP_DISPATCH_BINDING: &str = "DISPATCHER";
pub const WFP_DISPATCH_ENABLED_ENV: &str = "WFP_DISPATCH_ENABLED";
pub const WFP_INTERNAL_DISPATCH_ENABLED_ENV: &str = "WFP_INTERNAL_DISPATCH_ENABLED";
pub const WFP_PREVIEW_HOST_SUFFIX_ENV: &str = "WFP_PREVIEW_HOST_SUFFIX";
pub const WFP_DISPATCH_WORKER_PREFIX_ENV: &str = "WFP_DISPATCH_WORKER_PREFIX";
pub const INTERNAL_DISPATCH_PREFIX: &str = "/api/platform/dispatch/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchTarget {
    pub route_kind: DispatchRouteKind,
    pub public_name: String,
    pub worker_name: String,
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
    channel_affinity_do_available: bool,
    realtime_sessions_do_available: bool,
    wfp_dispatch_binding_available: bool,
    wfp_dispatch_enabled: bool,
    wfp_internal_dispatch_enabled: bool,
    wfp_preview_host_suffix_configured: bool,
    wfp_worker_prefix_configured: bool,
    do_websocket_hibernation_compiled: bool,
}

/// Admin-only capability probe for the production migration cockpit.
pub async fn capabilities(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }

    let capabilities = PlatformCapabilities {
        ai_binding_available: env.ai("AI").is_ok(),
        ai_gateway_id_configured: runtime_value(&env, "AI_GATEWAY_ID").is_some(),
        channel_affinity_do_available: env.durable_object("CHANNEL_AFFINITY").is_ok(),
        realtime_sessions_do_available: env.durable_object("REALTIME_SESSIONS").is_ok(),
        wfp_dispatch_binding_available: env.dynamic_dispatcher(WFP_DISPATCH_BINDING).is_ok(),
        wfp_dispatch_enabled: env_flag(&env, WFP_DISPATCH_ENABLED_ENV),
        wfp_internal_dispatch_enabled: env_flag(&env, WFP_INTERNAL_DISPATCH_ENABLED_ENV),
        wfp_preview_host_suffix_configured: runtime_value(&env, WFP_PREVIEW_HOST_SUFFIX_ENV)
            .is_some(),
        wfp_worker_prefix_configured: runtime_value(&env, WFP_DISPATCH_WORKER_PREFIX_ENV).is_some(),
        do_websocket_hibernation_compiled: true,
    };

    envelope_ok_response(&capabilities)
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
        if let Some(public_name) = internal_dispatch_script_name(&req.path()) {
            return Ok(Some(dispatch_target(
                DispatchRouteKind::InternalPath,
                &public_name,
                prefix.as_deref(),
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
    )?))
}

pub async fn dispatch_request(
    req: Request,
    env: Env,
    target: DispatchTarget,
) -> WorkerResult<Response> {
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

    let mut response = fetcher.fetch_request(req).await?;
    let headers = response.headers_mut();
    let _ = headers.set("X-Cinatoken-WFP-Route", target.route_kind.header_value());
    let _ = headers.set("X-Cinatoken-WFP-Worker", &target.public_name);
    Ok(response)
}

fn dispatch_target(
    route_kind: DispatchRouteKind,
    public_name: &str,
    prefix: Option<&str>,
) -> WorkerResult<DispatchTarget> {
    let public_name = normalize_worker_name(public_name)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker name".to_string()))?;
    let worker_name = prefixed_worker_name(&public_name, prefix)
        .ok_or_else(|| worker::Error::RustError("invalid WFP worker prefix".to_string()))?;
    Ok(DispatchTarget {
        route_kind,
        public_name,
        worker_name,
    })
}

fn host_header(req: &Request) -> WorkerResult<Option<String>> {
    Ok(req.headers().get("Host")?.or_else(|| {
        req.url()
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
    }))
}

fn internal_dispatch_script_name(path: &str) -> Option<String> {
    let rest = path.strip_prefix(INTERNAL_DISPATCH_PREFIX)?;
    let script = rest.split('/').next().unwrap_or_default();
    normalize_worker_name(script)
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
}
