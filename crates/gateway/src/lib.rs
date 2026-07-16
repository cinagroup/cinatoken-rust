//! Pure request ownership planner for the Rust scheduling gateway.
//!
//! Cloudflare bindings and request I/O remain in `cinatoken-worker`. This crate
//! owns route precedence so WFP, Realtime, provider-native routes, static
//! assets, and the compatibility router cannot silently shadow each other.

pub const SCHEDULING_GATEWAY_OWNER_CONTRACT_VERSION: u32 = 1;
pub const SCHEDULING_GATEWAY_ROUTE_PRECEDENCE: &[&str] = &[
    "cors_preflight",
    "wfp_internal_dispatch",
    "wfp_preview_dispatch",
    "wfp_preview_unavailable",
    "gemini_native",
    "realtime_session",
    "static_assets",
    "api_router",
];

pub const REALTIME_SESSION_GATEWAY_PREFIX: &str = "/api/platform/realtime/";
pub const REALTIME_OPENAI_PATH: &str = "/v1/realtime";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayMethod {
    Options,
    Post,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayOwner {
    CorsPreflight,
    GeminiNative,
    WfpDispatch,
    WfpPreviewUnavailable,
    RealtimeSession,
    StaticAssets,
    ApiRouter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WfpDispatchKind {
    InternalStatus,
    PreviewHost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WfpDispatchPlan {
    pub kind: WfpDispatchKind,
    pub public_name: String,
    pub tenant_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayPlan {
    pub owner: GatewayOwner,
    pub wfp_dispatch: Option<WfpDispatchPlan>,
}

impl GatewayPlan {
    fn owner(owner: GatewayOwner) -> Self {
        Self {
            owner,
            wfp_dispatch: None,
        }
    }

    fn wfp(plan: WfpDispatchPlan) -> Self {
        Self {
            owner: GatewayOwner::WfpDispatch,
            wfp_dispatch: Some(plan),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GatewayRequest<'a> {
    pub method: GatewayMethod,
    pub path: &'a str,
    pub host: Option<&'a str>,
    pub gemini_native_candidate: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct GatewayConfig<'a> {
    pub wfp_dispatch_enabled: bool,
    pub wfp_internal_dispatch_enabled: bool,
    pub wfp_preview_host_suffix: Option<&'a str>,
    pub wfp_tenant_status_path: &'a str,
}

pub fn plan_request(request: GatewayRequest<'_>, config: GatewayConfig<'_>) -> GatewayPlan {
    let path = request.path.split('?').next().unwrap_or(request.path);

    if request.method == GatewayMethod::Options {
        return GatewayPlan::owner(GatewayOwner::CorsPreflight);
    }
    if config.wfp_dispatch_enabled && config.wfp_internal_dispatch_enabled {
        if let Some(plan) = internal_wfp_dispatch_plan(path, config.wfp_tenant_status_path) {
            return GatewayPlan::wfp(plan);
        }
    }

    if let (Some(suffix), Some(host)) = (config.wfp_preview_host_suffix, request.host) {
        match classify_preview_host(host, suffix) {
            PreviewHostMatch::Tenant(public_name) if config.wfp_dispatch_enabled => {
                return GatewayPlan::wfp(WfpDispatchPlan {
                    kind: WfpDispatchKind::PreviewHost,
                    public_name,
                    tenant_path: None,
                });
            }
            PreviewHostMatch::Tenant(_)
            | PreviewHostMatch::SuffixRoot
            | PreviewHostMatch::InvalidTenant => {
                return GatewayPlan::owner(GatewayOwner::WfpPreviewUnavailable);
            }
            PreviewHostMatch::NotPreview => {}
        }
    }

    if request.method == GatewayMethod::Post && request.gemini_native_candidate {
        return GatewayPlan::owner(GatewayOwner::GeminiNative);
    }

    if realtime_gateway_candidate(path) {
        return GatewayPlan::owner(GatewayOwner::RealtimeSession);
    }
    if is_static_asset_path(path) {
        return GatewayPlan::owner(GatewayOwner::StaticAssets);
    }
    GatewayPlan::owner(GatewayOwner::ApiRouter)
}

pub fn realtime_gateway_candidate(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == REALTIME_OPENAI_PATH || realtime_session_from_path(path).is_some()
}

pub fn realtime_session_from_path(path: &str) -> Option<String> {
    let path = path.split('?').next().unwrap_or(path);
    let rest = path.strip_prefix(REALTIME_SESSION_GATEWAY_PREFIX)?;
    let mut segments = rest.split('/');
    let session = normalize_realtime_session_name(segments.next().unwrap_or_default())?;
    match (segments.next(), segments.next()) {
        (None, None) | (Some(""), None) | (Some("status"), None) => Some(session),
        _ => None,
    }
}

pub fn normalize_realtime_session_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 96 {
        return None;
    }
    value.chars().all(is_worker_name_char).then_some(value)
}

pub fn is_static_asset_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    if matches!(
        path,
        "/api"
            | "/internal"
            | "/v1"
            | "/v1beta"
            | "/mj"
            | "/jimeng"
            | "/suno"
            | "/pg"
            | "/dashboard/billing"
    ) {
        return false;
    }
    for prefix in [
        "/api/",
        "/internal/",
        "/v1/",
        "/v1beta/",
        "/mj/",
        "/jimeng/",
        "/suno/",
        "/pg/",
        "/dashboard/billing/",
    ] {
        if path.starts_with(prefix) {
            return false;
        }
    }
    !matches!(
        path,
        "/api/status"
            | "/api/setup"
            | "/v1/models"
            | "/v1/chat/completions"
            | "/v1/completions"
            | "/v1/responses"
            | "/v1/messages"
            | "/v1/embeddings"
            | "/v1/rerank"
            | "/v1/images/generations"
            | "/v1/audio/speech"
            | "/v1/audio/transcriptions"
            | "/v1/audio/translations"
            | "/v1/images/edits"
            | "/jimeng"
    )
}

pub fn preview_tenant_name(host: &str, suffix: &str) -> Option<String> {
    match classify_preview_host(host, suffix) {
        PreviewHostMatch::Tenant(public_name) => Some(public_name),
        PreviewHostMatch::SuffixRoot
        | PreviewHostMatch::InvalidTenant
        | PreviewHostMatch::NotPreview => None,
    }
}

enum PreviewHostMatch {
    Tenant(String),
    SuffixRoot,
    InvalidTenant,
    NotPreview,
}

fn classify_preview_host(host: &str, suffix: &str) -> PreviewHostMatch {
    let Some(host) = normalize_host(host) else {
        return PreviewHostMatch::NotPreview;
    };
    let Some(suffix) = normalize_host(suffix.trim_start_matches('.')) else {
        return PreviewHostMatch::NotPreview;
    };
    if host == suffix {
        return PreviewHostMatch::SuffixRoot;
    }
    let expected_tail = format!(".{suffix}");
    let Some(public_name) = host.strip_suffix(&expected_tail) else {
        return PreviewHostMatch::NotPreview;
    };
    match normalize_worker_name(public_name).filter(|_| !public_name.contains('.')) {
        Some(public_name) => PreviewHostMatch::Tenant(public_name),
        None => PreviewHostMatch::InvalidTenant,
    }
}

pub fn normalize_worker_name(value: &str) -> Option<String> {
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

pub fn is_worker_name_char(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_'
}

fn internal_wfp_dispatch_plan(path: &str, tenant_status_path: &str) -> Option<WfpDispatchPlan> {
    let rest = path.strip_prefix("/api/platform/dispatch/")?;
    let (script, tenant_path) = rest.split_once('/').unwrap_or((rest, ""));
    let tenant_path = if tenant_path.is_empty() {
        "/".to_string()
    } else {
        format!("/{tenant_path}")
    };
    if tenant_path != tenant_status_path {
        return None;
    }
    Some(WfpDispatchPlan {
        kind: WfpDispatchKind::InternalStatus,
        public_name: normalize_worker_name(script)?,
        tenant_path: Some(tenant_path),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS_PATH: &str = "/__cinatoken/tenant/status";

    fn config() -> GatewayConfig<'static> {
        GatewayConfig {
            wfp_dispatch_enabled: true,
            wfp_internal_dispatch_enabled: true,
            wfp_preview_host_suffix: Some("preview.example.com"),
            wfp_tenant_status_path: STATUS_PATH,
        }
    }

    fn request<'a>(method: GatewayMethod, path: &'a str) -> GatewayRequest<'a> {
        GatewayRequest {
            method,
            path,
            host: Some("api.example.com"),
            gemini_native_candidate: false,
        }
    }

    #[test]
    fn precedence_is_explicit_and_fail_closed() {
        let mut input = request(GatewayMethod::Options, "/v1/realtime");
        input.host = Some("tenant.preview.example.com");
        input.gemini_native_candidate = true;
        assert_eq!(
            plan_request(input, config()).owner,
            GatewayOwner::CorsPreflight
        );

        input.method = GatewayMethod::Post;
        let plan = plan_request(input, config());
        assert_eq!(plan.owner, GatewayOwner::WfpDispatch);
        assert_eq!(plan.wfp_dispatch.unwrap().public_name, "tenant");

        let disabled = GatewayConfig {
            wfp_dispatch_enabled: false,
            ..config()
        };
        assert_eq!(
            plan_request(input, disabled).owner,
            GatewayOwner::WfpPreviewUnavailable
        );

        input.host = Some("api.example.com");
        assert_eq!(
            plan_request(input, config()).owner,
            GatewayOwner::GeminiNative
        );
    }

    #[test]
    fn internal_wfp_status_is_exact_and_precedes_api_router() {
        let plan = plan_request(
            request(
                GatewayMethod::Other,
                "/api/platform/dispatch/Tenant_1/__cinatoken/tenant/status",
            ),
            config(),
        );
        assert_eq!(plan.owner, GatewayOwner::WfpDispatch);
        assert_eq!(
            plan.wfp_dispatch,
            Some(WfpDispatchPlan {
                kind: WfpDispatchKind::InternalStatus,
                public_name: "tenant_1".to_string(),
                tenant_path: Some(STATUS_PATH.to_string()),
            })
        );

        assert_eq!(
            plan_request(
                request(
                    GatewayMethod::Other,
                    "/api/platform/dispatch/tenant-a/v1/chat/completions",
                ),
                config(),
            )
            .owner,
            GatewayOwner::ApiRouter
        );
        assert_eq!(
            plan_request(
                request(
                    GatewayMethod::Other,
                    "/api/platform/realtime-billing/ledger/status",
                ),
                config(),
            )
            .owner,
            GatewayOwner::ApiRouter
        );
        assert_eq!(
            plan_request(
                request(
                    GatewayMethod::Other,
                    "/api/platform/relay-billing/ledger/status",
                ),
                config(),
            )
            .owner,
            GatewayOwner::ApiRouter
        );
    }

    #[test]
    fn realtime_control_routes_do_not_get_shadowed_by_the_do() {
        assert_eq!(
            plan_request(request(GatewayMethod::Post, REALTIME_OPENAI_PATH), config()).owner,
            GatewayOwner::RealtimeSession
        );
        assert_eq!(
            plan_request(
                request(
                    GatewayMethod::Post,
                    "/api/platform/realtime/session-a/status",
                ),
                config(),
            )
            .owner,
            GatewayOwner::RealtimeSession
        );
        assert_eq!(
            plan_request(
                request(
                    GatewayMethod::Post,
                    "/api/platform/realtime/settlement-batch/smoke",
                ),
                config(),
            )
            .owner,
            GatewayOwner::ApiRouter
        );
    }

    #[test]
    fn static_and_api_ownership_matches_the_public_surface() {
        assert_eq!(
            plan_request(request(GatewayMethod::Other, "/dashboard"), config()).owner,
            GatewayOwner::StaticAssets
        );
        assert_eq!(
            plan_request(request(GatewayMethod::Other, "/api/status"), config()).owner,
            GatewayOwner::ApiRouter
        );
        for path in [
            "/api",
            "/internal",
            "/internal/v1/status",
            "/v1",
            "/v1beta",
            "/mj",
            "/suno",
            "/pg",
        ] {
            assert_eq!(
                plan_request(request(GatewayMethod::Other, path), config()).owner,
                GatewayOwner::ApiRouter,
                "{path} must not fall through to the SPA"
            );
        }
        assert_eq!(
            plan_request(
                request(GatewayMethod::Other, "/v1/engines/model/embeddings"),
                config(),
            )
            .owner,
            GatewayOwner::ApiRouter
        );
    }

    #[test]
    fn preview_hosts_are_single_label_and_normalized() {
        assert_eq!(
            preview_tenant_name("Tenant-A.Preview.Example.Com:443", ".preview.example.com"),
            Some("tenant-a".to_string())
        );
        assert_eq!(
            preview_tenant_name("preview.example.com", "preview.example.com"),
            None
        );
        assert_eq!(
            preview_tenant_name("nested.tenant.preview.example.com", "preview.example.com"),
            None
        );
        let mut invalid = request(GatewayMethod::Other, "/");
        invalid.host = Some("nested.tenant.preview.example.com");
        assert_eq!(
            plan_request(invalid, config()).owner,
            GatewayOwner::WfpPreviewUnavailable
        );
        invalid.host = Some("preview.example.com");
        assert_eq!(
            plan_request(invalid, config()).owner,
            GatewayOwner::WfpPreviewUnavailable
        );
    }
}
