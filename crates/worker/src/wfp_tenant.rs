//! Workers for Platforms tenant-script control plane.
//!
//! The hot path dispatches through the `DISPATCHER` binding in
//! `platform_gateway`. This module is root-admin control-plane glue: it builds
//! a small tenant Worker module and, when explicitly requested, uploads it to a
//! Workers for Platforms dispatch namespace through the Cloudflare API.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{Env, Request, Response, Result as WorkerResult};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_root_auth,
};
use crate::platform_gateway::{
    is_worker_name_char, normalize_worker_name, runtime_value, WFP_DISPATCH_WORKER_PREFIX_ENV,
};

pub const WFP_DISPATCH_NAMESPACE_ENV: &str = "WFP_DISPATCH_NAMESPACE";
pub const WFP_TENANT_COMPATIBILITY_DATE_ENV: &str = "WFP_TENANT_COMPATIBILITY_DATE";

const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const AI_GATEWAY_ID_ENV: &str = "AI_GATEWAY_ID";
const AI_GATEWAY_ID_OPENAI_CHAT_ENV: &str = "AI_GATEWAY_ID_OPENAI_CHAT";
const AI_GATEWAY_ID_OPENAI_RESPONSES_ENV: &str = "AI_GATEWAY_ID_OPENAI_RESPONSES";
const AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV: &str = "AI_GATEWAY_ID_ANTHROPIC_MESSAGES";
const AI_GATEWAY_ID_AI_RUN_ENV: &str = "AI_GATEWAY_ID_AI_RUN";
const AI_GATEWAY_REQUEST_TIMEOUT_MS_ENV: &str = "AI_GATEWAY_REQUEST_TIMEOUT_MS";
const AI_GATEWAY_MAX_ATTEMPTS_ENV: &str = "AI_GATEWAY_MAX_ATTEMPTS";
const AI_GATEWAY_RETRY_DELAY_MS_ENV: &str = "AI_GATEWAY_RETRY_DELAY_MS";
const AI_GATEWAY_BACKOFF_ENV: &str = "AI_GATEWAY_BACKOFF";
const AI_GATEWAY_CACHE_TTL_SECONDS_ENV: &str = "AI_GATEWAY_CACHE_TTL_SECONDS";
const AI_GATEWAY_SKIP_CACHE_ENV: &str = "AI_GATEWAY_SKIP_CACHE";
const AI_GATEWAY_COLLECT_LOG_ENV: &str = "AI_GATEWAY_COLLECT_LOG";
const WFP_OUTBOUND_AUTH_MODE_ENV: &str = "CINATOKEN_WFP_OUTBOUND_AUTH_MODE";
const WFP_OUTBOUND_AUTH_MODE: &str = "platform-outbound-v1";
const TENANT_MODULE_NAME: &str = "tenant.mjs";
const CONTROL_PLANE_DEPLOYMENT_RUNTIME: &str = "js-fallback";
const CONTROL_PLANE_ARTIFACT_UPLOAD_REQUIRED: bool = true;
const JS_FALLBACK_AI_CAPABLE: bool = false;
const CONTROL_PLANE_DEPLOY_ERROR: &str = "generated JS fallback deployment is disabled; build and upload the Rust/Wasm tenant artifact with bun run deploy:wfp-tenant";
const DEFAULT_COMPATIBILITY_DATE: &str = "2026-07-11";
const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
const RUST_TENANT_CRATE: &str = "crates/wfp-tenant";
const RUST_TENANT_BUILD_COMMAND: &str = "bun run build:wfp-tenant";
const RUST_TENANT_SHIM_PATH: &str = "crates/wfp-tenant/build/worker/shim.mjs";
pub(crate) const WFP_TENANT_STATUS_PATH: &str = "/__cinatoken/tenant/status";
pub(crate) const WFP_TENANT_AI_GATEWAY_ROUTES: &[&str] = &[
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/ai/run",
];
pub(crate) const WFP_TENANT_SUPPORTED_ROUTES: &[&str] = &[
    WFP_TENANT_STATUS_PATH,
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/ai/run",
];
pub(crate) const WFP_TENANT_CUTOVER_GUARDS: &[&str] = &[
    "dispatcher_binding",
    "dispatch_gate",
    "dispatch_failure_contract",
    "relay_transport_gate",
    "internal_dispatch_gate",
    "central_relay_authority",
    "signed_body_bound_authority",
    "authority_replay_do",
    "tenant_scoped_authority_key",
    "outbound_worker_egress_policy",
    "outbound_worker_token_injection",
    "no_tenant_cloudflare_token",
    "tenant_script_plan",
    "rust_wasm_runtime",
    "rust_wasm_artifact_validation",
    "route_manifest",
    "internal_dispatch_required",
    "request_header_scrub",
    "response_header_allowlist",
    "preview_response_security_headers",
    "ai_gateway_policy_headers",
    "central_billing_settlement",
    "tenant_status_smoke",
    "relay_authority_staging_replay",
];

#[derive(Debug, Deserialize)]
struct TenantScriptRequest {
    script_name: String,
    tenant_id: Option<String>,
    dispatch_namespace: Option<String>,
    ai_gateway_id: Option<String>,
    ai_gateway_id_openai_chat: Option<String>,
    ai_gateway_id_openai_responses: Option<String>,
    ai_gateway_id_anthropic_messages: Option<String>,
    ai_gateway_id_ai_run: Option<String>,
    ai_gateway_request_timeout_ms: Option<String>,
    ai_gateway_max_attempts: Option<String>,
    ai_gateway_retry_delay_ms: Option<String>,
    ai_gateway_backoff: Option<String>,
    ai_gateway_cache_ttl_seconds: Option<String>,
    ai_gateway_skip_cache: Option<String>,
    ai_gateway_collect_log: Option<String>,
    compatibility_date: Option<String>,
}

#[derive(Debug)]
struct TenantScriptPlan {
    public_script_name: String,
    script_name: String,
    tenant_id: String,
    namespace: Option<String>,
    ai_gateway_id: Option<String>,
    route_ai_gateway_ids: RouteGatewayIds,
    ai_gateway_request_policy: GatewayRequestPolicy,
    compatibility_date: String,
    module_name: String,
    script: String,
    redacted_metadata: Value,
    upload_url: Option<String>,
    missing: Vec<ConfigRequirement>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ConfigRequirement {
    name: &'static str,
    secret: bool,
}

#[derive(Debug, Serialize)]
struct TenantScriptPlanResponse {
    public_script_name: String,
    script_name: String,
    tenant_id: String,
    namespace: Option<String>,
    upload_url: Option<String>,
    module_name: String,
    deployment_runtime: &'static str,
    compatibility_date: String,
    ai_gateway_id_configured: bool,
    route_ai_gateway_ids_configured: RouteGatewayIdConfigured,
    ai_gateway_request_policy_configured: GatewayRequestPolicyConfigured,
    outbound_auth_mode: &'static str,
    tenant_cloudflare_token_attached: bool,
    artifact_upload_required: bool,
    js_fallback_ai_capable: bool,
    deployable: bool,
    missing: Vec<ConfigRequirement>,
    warnings: Vec<String>,
    metadata: Value,
    script: String,
    rust_wasm_runtime: RustWasmRuntimePlan,
}

#[derive(Debug, Serialize)]
struct RustWasmRuntimePlan {
    available: bool,
    crate_path: &'static str,
    build_command: &'static str,
    shim_path: &'static str,
    deployment_status: &'static str,
}

#[derive(Debug, Clone, Default)]
struct RouteGatewayIds {
    openai_chat: Option<String>,
    openai_responses: Option<String>,
    anthropic_messages: Option<String>,
    ai_run: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RouteGatewayIdConfigured {
    openai_chat: bool,
    openai_responses: bool,
    anthropic_messages: bool,
    ai_run: bool,
}

#[derive(Debug, Clone, Default)]
struct GatewayRequestPolicy {
    request_timeout_ms: Option<String>,
    max_attempts: Option<String>,
    retry_delay_ms: Option<String>,
    backoff: Option<String>,
    cache_ttl_seconds: Option<String>,
    skip_cache: Option<String>,
    collect_log: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct GatewayRequestPolicyConfigured {
    request_timeout_ms: bool,
    max_attempts: bool,
    retry_delay_ms: bool,
    backoff: bool,
    cache_ttl_seconds: bool,
    skip_cache: bool,
    collect_log: bool,
}

impl RouteGatewayIds {
    fn from_request_and_env(env: &Env, request: &TenantScriptRequest) -> Result<Self, String> {
        Ok(Self {
            openai_chat: optional_request_or_env(
                request.ai_gateway_id_openai_chat.as_deref(),
                env,
                AI_GATEWAY_ID_OPENAI_CHAT_ENV,
                "ai_gateway_id_openai_chat",
            )?,
            openai_responses: optional_request_or_env(
                request.ai_gateway_id_openai_responses.as_deref(),
                env,
                AI_GATEWAY_ID_OPENAI_RESPONSES_ENV,
                "ai_gateway_id_openai_responses",
            )?,
            anthropic_messages: optional_request_or_env(
                request.ai_gateway_id_anthropic_messages.as_deref(),
                env,
                AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV,
                "ai_gateway_id_anthropic_messages",
            )?,
            ai_run: optional_request_or_env(
                request.ai_gateway_id_ai_run.as_deref(),
                env,
                AI_GATEWAY_ID_AI_RUN_ENV,
                "ai_gateway_id_ai_run",
            )?,
        })
    }

    fn any_configured(&self) -> bool {
        self.openai_chat.is_some()
            || self.openai_responses.is_some()
            || self.anthropic_messages.is_some()
            || self.ai_run.is_some()
    }

    fn configured(&self) -> RouteGatewayIdConfigured {
        RouteGatewayIdConfigured {
            openai_chat: self.openai_chat.is_some(),
            openai_responses: self.openai_responses.is_some(),
            anthropic_messages: self.anthropic_messages.is_some(),
            ai_run: self.ai_run.is_some(),
        }
    }
}

impl GatewayRequestPolicy {
    fn from_request_and_env(env: &Env, request: &TenantScriptRequest) -> Result<Self, String> {
        Ok(Self {
            request_timeout_ms: optional_policy_request_or_env(
                request.ai_gateway_request_timeout_ms.as_deref(),
                env,
                AI_GATEWAY_REQUEST_TIMEOUT_MS_ENV,
                "ai_gateway_request_timeout_ms",
                GatewayPolicyValidator::PositiveInteger {
                    min: 1,
                    max: Some(600_000),
                },
            )?,
            max_attempts: optional_policy_request_or_env(
                request.ai_gateway_max_attempts.as_deref(),
                env,
                AI_GATEWAY_MAX_ATTEMPTS_ENV,
                "ai_gateway_max_attempts",
                GatewayPolicyValidator::PositiveInteger {
                    min: 1,
                    max: Some(5),
                },
            )?,
            retry_delay_ms: optional_policy_request_or_env(
                request.ai_gateway_retry_delay_ms.as_deref(),
                env,
                AI_GATEWAY_RETRY_DELAY_MS_ENV,
                "ai_gateway_retry_delay_ms",
                GatewayPolicyValidator::PositiveInteger {
                    min: 1,
                    max: Some(5_000),
                },
            )?,
            backoff: optional_policy_request_or_env(
                request.ai_gateway_backoff.as_deref(),
                env,
                AI_GATEWAY_BACKOFF_ENV,
                "ai_gateway_backoff",
                GatewayPolicyValidator::Backoff,
            )?,
            cache_ttl_seconds: optional_policy_request_or_env(
                request.ai_gateway_cache_ttl_seconds.as_deref(),
                env,
                AI_GATEWAY_CACHE_TTL_SECONDS_ENV,
                "ai_gateway_cache_ttl_seconds",
                GatewayPolicyValidator::PositiveInteger { min: 1, max: None },
            )?,
            skip_cache: optional_policy_request_or_env(
                request.ai_gateway_skip_cache.as_deref(),
                env,
                AI_GATEWAY_SKIP_CACHE_ENV,
                "ai_gateway_skip_cache",
                GatewayPolicyValidator::Boolean,
            )?,
            collect_log: optional_policy_request_or_env(
                request.ai_gateway_collect_log.as_deref(),
                env,
                AI_GATEWAY_COLLECT_LOG_ENV,
                "ai_gateway_collect_log",
                GatewayPolicyValidator::Boolean,
            )?,
        })
    }

    fn configured(&self) -> GatewayRequestPolicyConfigured {
        GatewayRequestPolicyConfigured {
            request_timeout_ms: self.request_timeout_ms.is_some(),
            max_attempts: self.max_attempts.is_some(),
            retry_delay_ms: self.retry_delay_ms.is_some(),
            backoff: self.backoff.is_some(),
            cache_ttl_seconds: self.cache_ttl_seconds.is_some(),
            skip_cache: self.skip_cache.is_some(),
            collect_log: self.collect_log.is_some(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum GatewayPolicyValidator {
    PositiveInteger { min: u32, max: Option<u32> },
    Boolean,
    Backoff,
}

pub async fn plan(mut req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }
    let body = match read_json_body(&mut req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let payload: TenantScriptRequest = match serde_json::from_value(body) {
        Ok(payload) => payload,
        Err(err) => {
            return Ok(envelope_error_response(
                400,
                &format!("invalid WFP tenant script request: {err}"),
            ));
        }
    };
    let plan = match build_tenant_script_plan(&env, payload) {
        Ok(plan) => plan,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    let mut response = envelope_ok_response(&plan_response(&plan))?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

pub async fn deploy(req: Request, env: Env) -> WorkerResult<Response> {
    if let Err(response) = require_root_auth(&req, &env).await? {
        return Ok(response);
    }
    let mut response = envelope_error_response(409, CONTROL_PLANE_DEPLOY_ERROR);
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

fn build_tenant_script_plan(
    env: &Env,
    request: TenantScriptRequest,
) -> Result<TenantScriptPlanResponseInternal, String> {
    let public_script_name = normalize_worker_name(&request.script_name)
        .ok_or_else(|| "script_name must be a valid WFP worker name".to_string())?;
    let script_name = prefixed_worker_name(
        &public_script_name,
        runtime_value(env, WFP_DISPATCH_WORKER_PREFIX_ENV).as_deref(),
    )
    .ok_or_else(|| "WFP_DISPATCH_WORKER_PREFIX is not a valid worker-name prefix".to_string())?;
    let tenant_id = match request.tenant_id.as_deref() {
        Some(value) => validate_plain_header_value("tenant_id", value)?,
        None => public_script_name.clone(),
    };
    let namespace = match request
        .dispatch_namespace
        .as_deref()
        .and_then(normalize_dispatch_namespace)
        .or_else(|| {
            runtime_value(env, WFP_DISPATCH_NAMESPACE_ENV)
                .and_then(|value| normalize_dispatch_namespace(&value))
        }) {
        Some(value) => Some(value),
        None => None,
    };
    let account_id =
        runtime_value(env, CLOUDFLARE_ACCOUNT_ID_ENV).and_then(|value| validate_account_id(&value));
    let ai_gateway_id = optional_request_or_env(
        request.ai_gateway_id.as_deref(),
        env,
        AI_GATEWAY_ID_ENV,
        "ai_gateway_id",
    )?;
    let route_ai_gateway_ids = RouteGatewayIds::from_request_and_env(env, &request)?;
    let ai_gateway_request_policy = GatewayRequestPolicy::from_request_and_env(env, &request)?;
    let compatibility_date = request
        .compatibility_date
        .as_deref()
        .map(validate_compatibility_date)
        .transpose()?
        .or_else(|| runtime_value(env, WFP_TENANT_COMPATIBILITY_DATE_ENV))
        .unwrap_or_else(|| DEFAULT_COMPATIBILITY_DATE.to_string());
    let script = tenant_worker_script();

    let mut missing = Vec::new();
    if namespace.is_none() {
        missing.push(ConfigRequirement {
            name: WFP_DISPATCH_NAMESPACE_ENV,
            secret: false,
        });
    }
    if account_id.is_none() {
        missing.push(ConfigRequirement {
            name: CLOUDFLARE_ACCOUNT_ID_ENV,
            secret: false,
        });
    }
    let upload_url = account_id
        .as_deref()
        .zip(namespace.as_deref())
        .map(|(account, ns)| dispatch_script_upload_url(account, ns, &script_name));
    let redacted_metadata = upload_metadata(
        &compatibility_date,
        &tenant_id,
        account_id.as_deref(),
        ai_gateway_id.as_deref(),
        &route_ai_gateway_ids,
        &ai_gateway_request_policy,
    );
    let warnings = vec![
        "The generated JS fallback is status-only and cannot serve paid AI traffic.".to_string(),
        "Rust/Wasm artifact upload is required; use bun run deploy:wfp-tenant instead of the control-plane deploy endpoint.".to_string(),
        "Cloudflare AI authentication must be injected by the dispatch namespace outbound Worker; tenant scripts never receive CF_API_TOKEN.".to_string(),
    ];

    Ok(TenantScriptPlanResponseInternal {
        plan: TenantScriptPlan {
            public_script_name,
            script_name,
            tenant_id,
            namespace,
            ai_gateway_id,
            route_ai_gateway_ids,
            ai_gateway_request_policy,
            compatibility_date,
            module_name: TENANT_MODULE_NAME.to_string(),
            script,
            redacted_metadata,
            upload_url,
            missing,
            warnings,
        },
    })
}

struct TenantScriptPlanResponseInternal {
    plan: TenantScriptPlan,
}

impl std::ops::Deref for TenantScriptPlanResponseInternal {
    type Target = TenantScriptPlan;

    fn deref(&self) -> &Self::Target {
        &self.plan
    }
}

fn plan_response(plan: &TenantScriptPlanResponseInternal) -> TenantScriptPlanResponse {
    TenantScriptPlanResponse {
        public_script_name: plan.public_script_name.clone(),
        script_name: plan.script_name.clone(),
        tenant_id: plan.tenant_id.clone(),
        namespace: plan.namespace.clone(),
        upload_url: plan.upload_url.clone(),
        module_name: plan.module_name.clone(),
        deployment_runtime: CONTROL_PLANE_DEPLOYMENT_RUNTIME,
        compatibility_date: plan.compatibility_date.clone(),
        ai_gateway_id_configured: plan.ai_gateway_id.is_some()
            || plan.route_ai_gateway_ids.any_configured(),
        route_ai_gateway_ids_configured: plan.route_ai_gateway_ids.configured(),
        ai_gateway_request_policy_configured: plan.ai_gateway_request_policy.configured(),
        outbound_auth_mode: WFP_OUTBOUND_AUTH_MODE,
        tenant_cloudflare_token_attached: false,
        artifact_upload_required: CONTROL_PLANE_ARTIFACT_UPLOAD_REQUIRED,
        js_fallback_ai_capable: JS_FALLBACK_AI_CAPABLE,
        deployable: false,
        missing: plan.missing.clone(),
        warnings: plan.warnings.clone(),
        metadata: plan.redacted_metadata.clone(),
        script: plan.script.clone(),
        rust_wasm_runtime: RustWasmRuntimePlan {
            available: true,
            crate_path: RUST_TENANT_CRATE,
            build_command: RUST_TENANT_BUILD_COMMAND,
            shim_path: RUST_TENANT_SHIM_PATH,
            deployment_status: "artifact_upload_tool_required",
        },
    }
}

fn upload_metadata(
    compatibility_date: &str,
    tenant_id: &str,
    account_id: Option<&str>,
    ai_gateway_id: Option<&str>,
    route_ai_gateway_ids: &RouteGatewayIds,
    ai_gateway_request_policy: &GatewayRequestPolicy,
) -> Value {
    let mut bindings = vec![json!({
        "name": "CINATOKEN_TENANT_ID",
        "type": "plain_text",
        "text": tenant_id
    })];
    if let Some(account_id) = account_id {
        bindings.push(json!({
            "name": "CF_ACCOUNT_ID",
            "type": "plain_text",
            "text": account_id
        }));
    }
    bindings.push(json!({
        "name": WFP_OUTBOUND_AUTH_MODE_ENV,
        "type": "plain_text",
        "text": WFP_OUTBOUND_AUTH_MODE
    }));
    if let Some(ai_gateway_id) = ai_gateway_id {
        bindings.push(json!({
            "name": "AI_GATEWAY_ID",
            "type": "plain_text",
            "text": ai_gateway_id
        }));
    }
    for (name, ai_gateway_id) in route_gateway_binding_values(route_ai_gateway_ids) {
        if let Some(ai_gateway_id) = ai_gateway_id {
            bindings.push(json!({
                "name": name,
                "type": "plain_text",
                "text": ai_gateway_id
            }));
        }
    }
    for (name, value) in gateway_request_policy_binding_values(ai_gateway_request_policy) {
        if let Some(value) = value {
            bindings.push(json!({
                "name": name,
                "type": "plain_text",
                "text": value
            }));
        }
    }
    json!({
        "main_module": TENANT_MODULE_NAME,
        "compatibility_date": compatibility_date,
        "bindings": bindings
    })
}

fn gateway_request_policy_binding_values(
    policy: &GatewayRequestPolicy,
) -> [(&'static str, Option<&str>); 7] {
    [
        (
            AI_GATEWAY_REQUEST_TIMEOUT_MS_ENV,
            policy.request_timeout_ms.as_deref(),
        ),
        (AI_GATEWAY_MAX_ATTEMPTS_ENV, policy.max_attempts.as_deref()),
        (
            AI_GATEWAY_RETRY_DELAY_MS_ENV,
            policy.retry_delay_ms.as_deref(),
        ),
        (AI_GATEWAY_BACKOFF_ENV, policy.backoff.as_deref()),
        (
            AI_GATEWAY_CACHE_TTL_SECONDS_ENV,
            policy.cache_ttl_seconds.as_deref(),
        ),
        (AI_GATEWAY_SKIP_CACHE_ENV, policy.skip_cache.as_deref()),
        (AI_GATEWAY_COLLECT_LOG_ENV, policy.collect_log.as_deref()),
    ]
}

fn route_gateway_binding_values(
    route_ai_gateway_ids: &RouteGatewayIds,
) -> [(&'static str, Option<&str>); 4] {
    [
        (
            AI_GATEWAY_ID_OPENAI_CHAT_ENV,
            route_ai_gateway_ids.openai_chat.as_deref(),
        ),
        (
            AI_GATEWAY_ID_OPENAI_RESPONSES_ENV,
            route_ai_gateway_ids.openai_responses.as_deref(),
        ),
        (
            AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV,
            route_ai_gateway_ids.anthropic_messages.as_deref(),
        ),
        (
            AI_GATEWAY_ID_AI_RUN_ENV,
            route_ai_gateway_ids.ai_run.as_deref(),
        ),
    ]
}

pub(crate) fn wfp_tenant_supported_routes() -> Vec<&'static str> {
    WFP_TENANT_SUPPORTED_ROUTES.to_vec()
}

pub(crate) fn wfp_tenant_cutover_guards() -> Vec<&'static str> {
    WFP_TENANT_CUTOVER_GUARDS.to_vec()
}

pub(crate) fn wfp_tenant_script_plan_compiled() -> bool {
    let script = tenant_worker_script();
    script.contains("forwarding: \"disabled-status-only\"")
        && script.contains("body_mode: \"none\"")
        && script.contains("paid_ai_capable: false")
        && script.contains("status_only_tenant_runtime")
        && !script.contains("CF_API_TOKEN")
        && !script.contains("await fetch(")
}

pub(crate) fn wfp_tenant_rust_wasm_runtime_compiled() -> bool {
    let deploy_tool = include_str!("../../../tools/deploy_wfp_tenant_artifact.mjs");
    RUST_TENANT_CRATE == "crates/wfp-tenant"
        && RUST_TENANT_BUILD_COMMAND == "bun run build:wfp-tenant"
        && RUST_TENANT_SHIM_PATH == "crates/wfp-tenant/build/worker/shim.mjs"
        && deploy_tool.contains("wasmMagic")
        && deploy_tool.contains("WFP_RELAY_AUTHORITY_KEY")
        && deploy_tool.contains("WFP_AUTHORITY_REPLAY")
        && deploy_tool.contains("CINATOKEN_WFP_OUTBOUND_AUTH_MODE")
        && !deploy_tool.contains("name: \"CF_API_TOKEN\"")
        && deploy_tool.contains("durable_object_namespace")
        && deploy_tool.contains("--manifest-only is no longer supported")
}

pub(crate) fn wfp_outbound_egress_policy_compiled() -> bool {
    let source = include_str!("../../wfp-outbound/src/lib.rs");
    source.contains("CINATOKEN_WFP_OUTBOUND_AI_TOKEN")
        && source.contains("ALLOWED_AI_PATHS")
        && source.contains("/ai/v1/chat/completions")
        && source.contains("/ai/v1/responses")
        && source.contains("/ai/v1/messages")
        && source.contains("/ai/run")
        && source.contains("RequestRedirect::Manual")
        && source.contains("wfp_outbound_redirect_denied")
        && source.contains("is_redirect_status(status)")
        && source.contains("FORWARDED_REQUEST_HEADERS")
        && source.contains("FORWARDED_RESPONSE_HEADERS")
        && !source.contains("passThroughOnException")
}

pub(crate) fn wfp_tenant_route_manifest_compiled() -> bool {
    let script = tenant_worker_script();
    script.contains("const SUPPORTED_ROUTES = [STATUS_PATH];")
        && WFP_TENANT_SUPPORTED_ROUTES
            == &[
                WFP_TENANT_STATUS_PATH,
                "/v1/chat/completions",
                "/v1/responses",
                "/v1/messages",
                "/ai/run",
            ]
        && WFP_TENANT_AI_GATEWAY_ROUTES == &WFP_TENANT_SUPPORTED_ROUTES[1..]
        && WFP_TENANT_AI_GATEWAY_ROUTES
            .iter()
            .all(|route| !script.contains(route))
}

pub(crate) fn wfp_tenant_internal_dispatch_required_compiled() -> bool {
    let script = tenant_worker_script();
    script.contains("STATUS_CONTROL_AUTHORITY_MODES")
        && script.contains("paid_ai_authority_mode: WFP_RELAY_AUTHORITY_ROUTE")
        && script.contains("paid_ai_capable: false")
        && script.contains("WFP_INTERNAL_ROUTE")
        && script.contains("WFP_RELAY_AUTHORITY_ROUTE")
}

pub(crate) fn wfp_tenant_relay_authority_verifier_compiled() -> bool {
    let source = include_str!("../../wfp-tenant/src/lib.rs");
    source.contains("verify_authority_with_worker_key")
        && source.contains("decode_worker_key")
        && source.contains("AUTHORITY_TENANT_KEY_ENV")
        && source.contains("consume_authority_once")
        && source.contains("AUTHORITY_REPLAY_BINDING")
        && source.contains("bounded_verified_json")
        && !source.contains("secret_or_var(&env, AUTHORITY_SECRET_ENV)")
}

pub(crate) fn wfp_tenant_response_header_guard_compiled() -> bool {
    let script = tenant_worker_script();
    script.contains("\"x-cinatoken-wfp-tenant\": env.CINATOKEN_TENANT_ID")
        && script.contains("\"x-cinatoken-wfp-runtime\": \"js-fallback\"")
        && !script.contains("upstream.headers")
        && !script.contains("new Headers(upstream.headers)")
}

pub(crate) fn wfp_tenant_ai_gateway_policy_compiled() -> bool {
    WFP_TENANT_AI_GATEWAY_ROUTES.len() == 4
        && route_gateway_binding_values(&RouteGatewayIds::default()).len() == 4
        && gateway_request_policy_binding_values(&GatewayRequestPolicy::default()).len() == 7
}

fn tenant_worker_script() -> String {
    r#"const STATUS_PATH = "/__cinatoken/tenant/status";
const SUPPORTED_ROUTES = [STATUS_PATH];
const SENSITIVE_INBOUND_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "cf-access-client-id",
  "cf-access-client-secret"
];
const WFP_ROUTE_HEADER = "x-cinatoken-wfp-route";
const WFP_WORKER_HEADER = "x-cinatoken-wfp-worker";
const WFP_INTERNAL_ROUTE = "internal-path";
const WFP_RELAY_AUTHORITY_ROUTE = "relay-authority";
const STATUS_CONTROL_AUTHORITY_MODES = [
  WFP_INTERNAL_ROUTE,
  WFP_RELAY_AUTHORITY_ROUTE
];
const CONTROLLED_INBOUND_HEADERS = new Set([WFP_ROUTE_HEADER, WFP_WORKER_HEADER]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      const inboundSensitiveHeaders = inboundSensitiveHeaderNames(request.headers);
      return jsonResponse({
        service: "cinatoken-wfp-tenant",
        runtime: "js-fallback",
        tenant_id: env.CINATOKEN_TENANT_ID || "unknown",
        ai_gateway_id_configured: false,
        default_ai_gateway_id_configured: false,
        route_gateways: [],
        ai_gateway_request_policy: [],
        inbound_sensitive_headers_present: inboundSensitiveHeaders.length > 0,
        inbound_sensitive_headers: inboundSensitiveHeaders,
        status_control_authority_modes: STATUS_CONTROL_AUTHORITY_MODES,
        paid_ai_authority_mode: WFP_RELAY_AUTHORITY_ROUTE,
        paid_ai_authority_verifier: "disabled-status-only",
        paid_ai_replay_guard: "disabled-status-only",
        authority_replay_binding_configured: false,
        paid_ai_capable: false,
        inbound_dispatch_route: headerValue(request.headers, WFP_ROUTE_HEADER),
        inbound_dispatch_worker: headerValue(request.headers, WFP_WORKER_HEADER),
        forwarding: "disabled-status-only",
        body_mode: "none",
        routes: SUPPORTED_ROUTES
      }, {
        headers: {
          "x-cinatoken-wfp-tenant": env.CINATOKEN_TENANT_ID || "unknown",
          "x-cinatoken-wfp-runtime": "js-fallback"
        }
      });
    }

    return jsonError(404, "status_only_tenant_runtime", "generated JS fallback serves status only; deploy the Rust/Wasm tenant artifact for AI routes");
  }
};

function inboundSensitiveHeaderNames(input) {
  const names = new Set();
  for (const [name] of input) {
    if (isSensitiveInboundHeader(name)) names.add(name.toLowerCase());
  }
  return Array.from(names).sort();
}

function isSensitiveInboundHeader(name) {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_INBOUND_HEADERS.includes(normalized) ||
    (normalized.startsWith("x-cinatoken-") && !CONTROLLED_INBOUND_HEADERS.has(normalized));
}

function headerValue(input, name) {
  const value = input.get(name);
  return value && value.trim() ? value.trim() : null;
}

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function jsonError(status, code, message) {
  return jsonResponse({ error: { code, message, type: "cinatoken_wfp_tenant_error" } }, { status });
}
"#
    .to_string()
}

fn prefixed_worker_name(public_name: &str, prefix: Option<&str>) -> Option<String> {
    let prefix = prefix.unwrap_or_default().trim();
    if prefix.is_empty() {
        return Some(public_name.to_string());
    }
    if !prefix.chars().all(is_worker_name_char) {
        return None;
    }
    normalize_worker_name(&format!("{prefix}{public_name}"))
}

fn normalize_dispatch_namespace(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 64 {
        return None;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        .then_some(value)
}

fn validate_account_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|ch| ch.is_ascii_control() || ch == '/' || ch == '?' || ch == '#')
    {
        return None;
    }
    Some(value.to_string())
}

fn validate_plain_header_value(name: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(format!("{name} must be non-empty and header-safe"));
    }
    Ok(value.to_string())
}

fn validate_optional_plain_value(name: &str, value: &str) -> Option<Result<String, String>> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(validate_plain_header_value(name, value))
    }
}

fn optional_request_or_env(
    request_value: Option<&str>,
    env: &Env,
    env_name: &'static str,
    field_name: &str,
) -> Result<Option<String>, String> {
    let request_value = match request_value {
        Some(value) => validate_optional_plain_value(field_name, value).transpose()?,
        None => None,
    };
    Ok(request_value.or_else(|| runtime_value(env, env_name)))
}

fn optional_policy_request_or_env(
    request_value: Option<&str>,
    env: &Env,
    env_name: &'static str,
    field_name: &str,
    validator: GatewayPolicyValidator,
) -> Result<Option<String>, String> {
    let request_value = request_value
        .and_then(|value| validate_optional_gateway_policy_value(field_name, value, validator))
        .transpose()?;
    let env_value = match request_value {
        Some(value) => return Ok(Some(value)),
        None => runtime_value(env, env_name),
    };
    env_value
        .as_deref()
        .and_then(|value| validate_optional_gateway_policy_value(env_name, value, validator))
        .transpose()
}

fn validate_optional_gateway_policy_value(
    name: &str,
    value: &str,
    validator: GatewayPolicyValidator,
) -> Option<Result<String, String>> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(validate_gateway_policy_value(name, value, validator))
    }
}

fn validate_gateway_policy_value(
    name: &str,
    value: &str,
    validator: GatewayPolicyValidator,
) -> Result<String, String> {
    match validator {
        GatewayPolicyValidator::PositiveInteger { min, max } => {
            if !value.chars().all(|ch| ch.is_ascii_digit()) {
                return Err(format!("{name} must be a positive integer"));
            }
            let parsed = value
                .parse::<u32>()
                .map_err(|_| format!("{name} must be a positive integer"))?;
            if parsed < min {
                return Err(format!("{name} must be at least {min}"));
            }
            if let Some(max) = max {
                if parsed > max {
                    return Err(format!("{name} must be at most {max}"));
                }
            }
            Ok(parsed.to_string())
        }
        GatewayPolicyValidator::Boolean => match value.to_ascii_lowercase().as_str() {
            "true" => Ok("true".to_string()),
            "false" => Ok("false".to_string()),
            _ => Err(format!("{name} must be true or false")),
        },
        GatewayPolicyValidator::Backoff => match value.to_ascii_lowercase().as_str() {
            "constant" | "linear" | "exponential" => Ok(value.to_ascii_lowercase()),
            _ => Err(format!("{name} must be constant, linear, or exponential")),
        },
    }
}

fn validate_compatibility_date(value: &str) -> Result<String, String> {
    let value = value.trim();
    let valid = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .chars()
            .enumerate()
            .all(|(idx, ch)| idx == 4 || idx == 7 || ch.is_ascii_digit());
    if valid {
        Ok(value.to_string())
    } else {
        Err("compatibility_date must use YYYY-MM-DD".to_string())
    }
}

fn dispatch_script_upload_url(account_id: &str, namespace: &str, script_name: &str) -> String {
    format!(
        "{CLOUDFLARE_API_BASE}/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script_name}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_js_fallback_is_status_only() {
        let script = tenant_worker_script();
        assert!(script.contains("runtime: \"js-fallback\""));
        assert!(script.contains("forwarding: \"disabled-status-only\""));
        assert!(script.contains("body_mode: \"none\""));
        assert!(script.contains("paid_ai_capable: false"));
        assert!(script.contains("status_only_tenant_runtime"));
        assert!(script.contains("inbound_sensitive_headers_present"));
        assert!(script.contains("inboundSensitiveHeaderNames(request.headers)"));
        assert!(script.contains("SENSITIVE_INBOUND_HEADERS"));
        assert!(script.contains("CONTROLLED_INBOUND_HEADERS"));
        assert!(script.contains("WFP_ROUTE_HEADER"));
        assert!(script.contains("status_control_authority_modes"));
        assert!(script.contains("paid_ai_authority_mode"));
        assert!(script.contains("paid_ai_authority_verifier"));
        assert!(script.contains("inbound_dispatch_route"));
        assert!(script.contains("x-cinatoken-wfp-runtime"));
        assert!(script.contains("\"x-cinatoken-wfp-runtime\": \"js-fallback\""));
        for forbidden in [
            "request.body",
            "CF_API_TOKEN",
            "cf-aig-",
            "await fetch(",
            "upstream.headers",
            "AI_GATEWAY_ID_",
        ] {
            assert!(
                !script.contains(forbidden),
                "status-only script contains {forbidden}"
            );
        }
    }

    #[test]
    fn generated_js_fallback_manifest_is_status_only() {
        let script = tenant_worker_script();
        assert!(script.contains("const SUPPORTED_ROUTES = [STATUS_PATH];"));
        assert_eq!(
            WFP_TENANT_SUPPORTED_ROUTES,
            &[
                "/__cinatoken/tenant/status",
                "/v1/chat/completions",
                "/v1/responses",
                "/v1/messages",
                "/ai/run",
            ]
        );
        for route in WFP_TENANT_AI_GATEWAY_ROUTES {
            assert!(
                !script.contains(route),
                "status-only script contains AI route {route}"
            );
        }
        assert!(!script.contains("/v1/embeddings"));
    }

    #[test]
    fn generated_js_fallback_authority_status_is_explicit() {
        let script = tenant_worker_script();
        assert!(script.contains(
            r#"const STATUS_CONTROL_AUTHORITY_MODES = [
  WFP_INTERNAL_ROUTE,
  WFP_RELAY_AUTHORITY_ROUTE
];"#
        ));
        assert!(script.contains("const WFP_INTERNAL_ROUTE = \"internal-path\";"));
        assert!(script.contains("const WFP_RELAY_AUTHORITY_ROUTE = \"relay-authority\";"));
        assert!(script.contains("paid_ai_authority_mode: WFP_RELAY_AUTHORITY_ROUTE"));
        assert!(script.contains("paid_ai_capable: false"));
        assert!(!script.contains("\"preview-host\""));
    }

    #[test]
    fn control_plane_requires_rust_artifact_and_disables_fallback_ai() {
        assert_eq!(CONTROL_PLANE_DEPLOYMENT_RUNTIME, "js-fallback");
        assert!(CONTROL_PLANE_ARTIFACT_UPLOAD_REQUIRED);
        assert!(!JS_FALLBACK_AI_CAPABLE);
        assert!(CONTROL_PLANE_DEPLOY_ERROR.contains("bun run deploy:wfp-tenant"));
        assert_eq!(TENANT_MODULE_NAME, "tenant.mjs");
        assert!(tenant_worker_script().contains("runtime: \"js-fallback\""));
    }

    #[test]
    fn upload_metadata_requires_outbound_auth_and_never_attaches_cloudflare_token() {
        let metadata = upload_metadata(
            "2026-06-17",
            "tenant-a",
            Some("account"),
            Some("gateway"),
            &RouteGatewayIds::default(),
            &GatewayRequestPolicy::default(),
        );
        let raw = metadata.to_string();
        assert!(raw.contains(WFP_OUTBOUND_AUTH_MODE_ENV));
        assert!(raw.contains(WFP_OUTBOUND_AUTH_MODE));
        assert!(!raw.contains("CF_API_TOKEN"));
    }

    #[test]
    fn upload_metadata_includes_route_specific_gateway_bindings() {
        let route_gateway_ids = RouteGatewayIds {
            openai_chat: Some("gateway-chat".to_string()),
            anthropic_messages: Some("gateway-anthropic".to_string()),
            ai_run: Some("gateway-ai-run".to_string()),
            ..RouteGatewayIds::default()
        };
        let metadata = upload_metadata(
            "2026-06-17",
            "tenant-a",
            Some("account"),
            Some("gateway-default"),
            &route_gateway_ids,
            &GatewayRequestPolicy::default(),
        );
        let raw = metadata.to_string();
        assert!(raw.contains("\"name\":\"AI_GATEWAY_ID\""));
        assert!(raw.contains("\"text\":\"gateway-default\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_ID_OPENAI_CHAT\""));
        assert!(raw.contains("\"text\":\"gateway-chat\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_ID_ANTHROPIC_MESSAGES\""));
        assert!(raw.contains("\"text\":\"gateway-anthropic\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_ID_AI_RUN\""));
        assert!(raw.contains("\"text\":\"gateway-ai-run\""));
        assert!(!raw.contains("AI_GATEWAY_ID_OPENAI_RESPONSES"));
        assert!(!raw.contains("AI_GATEWAY_ID_OPENAI_EMBEDDINGS"));
    }

    #[test]
    fn upload_metadata_includes_gateway_request_policy_bindings() {
        let policy = GatewayRequestPolicy {
            request_timeout_ms: Some("30000".to_string()),
            max_attempts: Some("2".to_string()),
            retry_delay_ms: Some("250".to_string()),
            backoff: Some("exponential".to_string()),
            collect_log: Some("true".to_string()),
            ..GatewayRequestPolicy::default()
        };
        let metadata = upload_metadata(
            "2026-06-17",
            "tenant-a",
            Some("account"),
            Some("gateway-default"),
            &RouteGatewayIds::default(),
            &policy,
        );
        let raw = metadata.to_string();
        assert!(raw.contains("\"name\":\"AI_GATEWAY_REQUEST_TIMEOUT_MS\""));
        assert!(raw.contains("\"text\":\"30000\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_MAX_ATTEMPTS\""));
        assert!(raw.contains("\"text\":\"2\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_RETRY_DELAY_MS\""));
        assert!(raw.contains("\"text\":\"250\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_BACKOFF\""));
        assert!(raw.contains("\"text\":\"exponential\""));
        assert!(raw.contains("\"name\":\"AI_GATEWAY_COLLECT_LOG\""));
        assert!(raw.contains("\"text\":\"true\""));
        assert!(!raw.contains("AI_GATEWAY_SKIP_CACHE"));
        assert!(!raw.contains("AI_GATEWAY_CACHE_TTL_SECONDS"));
    }

    #[test]
    fn worker_names_and_namespaces_are_normalized() {
        assert_eq!(
            prefixed_worker_name("tenant-a", Some("ct-")).as_deref(),
            Some("ct-tenant-a")
        );
        assert!(prefixed_worker_name("tenant-a", Some("bad.prefix")).is_none());
        assert_eq!(
            normalize_dispatch_namespace("Prod_Dispatch").as_deref(),
            Some("prod_dispatch")
        );
        assert!(normalize_dispatch_namespace("../bad").is_none());
    }

    #[test]
    fn upload_url_targets_dispatch_namespace_scripts_api() {
        assert_eq!(
            dispatch_script_upload_url("acct", "prod", "ct-tenant-a"),
            "https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/prod/scripts/ct-tenant-a"
        );
    }
}
