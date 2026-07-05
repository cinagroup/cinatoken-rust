//! Workers for Platforms tenant-script control plane.
//!
//! The hot path dispatches through the `DISPATCHER` binding in
//! `platform_gateway`. This module is root-admin control-plane glue: it builds
//! a small tenant Worker module and, when explicitly requested, uploads it to a
//! Workers for Platforms dispatch namespace through the Cloudflare API.

use std::time::Duration;

use futures_util::{future::select, future::Either, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{
    AbortController, Delay, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect,
    Response, Result as WorkerResult,
};

use crate::admin::{
    envelope_error_response, envelope_ok_response, read_json_body, require_root_auth,
};
use crate::platform_gateway::{
    is_worker_name_char, normalize_worker_name, runtime_value, WFP_DISPATCH_WORKER_PREFIX_ENV,
};

pub const WFP_DISPATCH_NAMESPACE_ENV: &str = "WFP_DISPATCH_NAMESPACE";
pub const WFP_TENANT_COMPATIBILITY_DATE_ENV: &str = "WFP_TENANT_COMPATIBILITY_DATE";

const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_TOKEN_ENV: &str = "CLOUDFLARE_API_TOKEN";
const AI_GATEWAY_ID_ENV: &str = "AI_GATEWAY_ID";
const AI_GATEWAY_ID_OPENAI_CHAT_ENV: &str = "AI_GATEWAY_ID_OPENAI_CHAT";
const AI_GATEWAY_ID_OPENAI_RESPONSES_ENV: &str = "AI_GATEWAY_ID_OPENAI_RESPONSES";
const AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV: &str = "AI_GATEWAY_ID_ANTHROPIC_MESSAGES";
const AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV: &str = "AI_GATEWAY_ID_OPENAI_EMBEDDINGS";
const AI_GATEWAY_ID_AI_RUN_ENV: &str = "AI_GATEWAY_ID_AI_RUN";
const TENANT_MODULE_NAME: &str = "tenant.mjs";
const DEFAULT_COMPATIBILITY_DATE: &str = "2026-06-17";
const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
const CF_API_RESPONSE_LIMIT_BYTES: usize = 32 * 1024;
const CF_API_TIMEOUT: Duration = Duration::from_secs(20);
const RUST_TENANT_CRATE: &str = "crates/wfp-tenant";
const RUST_TENANT_BUILD_COMMAND: &str = "bun run build:wfp-tenant";
const RUST_TENANT_SHIM_PATH: &str = "crates/wfp-tenant/build/worker/shim.mjs";

#[derive(Debug, Deserialize)]
struct TenantScriptRequest {
    script_name: String,
    tenant_id: Option<String>,
    dispatch_namespace: Option<String>,
    ai_gateway_id: Option<String>,
    ai_gateway_id_openai_chat: Option<String>,
    ai_gateway_id_openai_responses: Option<String>,
    ai_gateway_id_anthropic_messages: Option<String>,
    ai_gateway_id_openai_embeddings: Option<String>,
    ai_gateway_id_ai_run: Option<String>,
    compatibility_date: Option<String>,
    attach_gateway_token: Option<bool>,
}

#[derive(Debug)]
struct TenantScriptPlan {
    public_script_name: String,
    script_name: String,
    tenant_id: String,
    namespace: Option<String>,
    api_token: Option<String>,
    ai_gateway_id: Option<String>,
    route_ai_gateway_ids: RouteGatewayIds,
    compatibility_date: String,
    module_name: String,
    script: String,
    upload_metadata: Value,
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
    compatibility_date: String,
    ai_gateway_id_configured: bool,
    route_ai_gateway_ids_configured: RouteGatewayIdConfigured,
    attach_gateway_token: bool,
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

#[derive(Debug, Serialize)]
struct TenantScriptDeployResponse {
    public_script_name: String,
    script_name: String,
    tenant_id: String,
    namespace: String,
    upload_url: String,
    module_name: String,
    compatibility_date: String,
    ai_gateway_id_configured: bool,
    route_ai_gateway_ids_configured: RouteGatewayIdConfigured,
    status: u16,
    ok: bool,
    cloudflare_response_preview: String,
    cloudflare_response_json: Option<Value>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct RouteGatewayIds {
    openai_chat: Option<String>,
    openai_responses: Option<String>,
    anthropic_messages: Option<String>,
    openai_embeddings: Option<String>,
    ai_run: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RouteGatewayIdConfigured {
    openai_chat: bool,
    openai_responses: bool,
    anthropic_messages: bool,
    openai_embeddings: bool,
    ai_run: bool,
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
            openai_embeddings: optional_request_or_env(
                request.ai_gateway_id_openai_embeddings.as_deref(),
                env,
                AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV,
                "ai_gateway_id_openai_embeddings",
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
            || self.openai_embeddings.is_some()
            || self.ai_run.is_some()
    }

    fn configured(&self) -> RouteGatewayIdConfigured {
        RouteGatewayIdConfigured {
            openai_chat: self.openai_chat.is_some(),
            openai_responses: self.openai_responses.is_some(),
            anthropic_messages: self.anthropic_messages.is_some(),
            openai_embeddings: self.openai_embeddings.is_some(),
            ai_run: self.ai_run.is_some(),
        }
    }
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

pub async fn deploy(mut req: Request, env: Env) -> WorkerResult<Response> {
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
                &format!("invalid WFP tenant script deploy request: {err}"),
            ));
        }
    };
    let plan_internal = match build_tenant_script_plan(&env, payload) {
        Ok(plan) => plan,
        Err(message) => return Ok(envelope_error_response(400, &message)),
    };
    if !plan_internal.missing.is_empty() {
        let missing = plan_internal
            .missing
            .iter()
            .map(|item| item.name)
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(envelope_error_response(
            400,
            &format!("missing required Cloudflare deployment configuration: {missing}"),
        ));
    }

    let plan = plan_internal.plan;
    let namespace = plan.namespace.clone().unwrap_or_default();
    let upload_url = plan.upload_url.clone().unwrap_or_default();
    let body = build_multipart_upload_body(
        "cinatoken_wfp_tenant_boundary",
        &plan.upload_metadata,
        &plan.module_name,
        &plan.script,
    )
    .map_err(|err| worker::Error::RustError(format!("failed to build upload body: {err}")))?;
    let (status, preview, parsed) =
        upload_tenant_script(&upload_url, plan.api_token.as_deref(), body).await?;
    let ok = (200..300).contains(&status);
    let deploy_response = TenantScriptDeployResponse {
        public_script_name: plan.public_script_name,
        script_name: plan.script_name,
        tenant_id: plan.tenant_id,
        namespace,
        upload_url,
        module_name: plan.module_name,
        compatibility_date: plan.compatibility_date,
        ai_gateway_id_configured: plan.ai_gateway_id.is_some()
            || plan.route_ai_gateway_ids.any_configured(),
        route_ai_gateway_ids_configured: plan.route_ai_gateway_ids.configured(),
        status,
        ok,
        cloudflare_response_preview: preview,
        cloudflare_response_json: parsed,
        warnings: plan.warnings,
    };
    let mut response =
        envelope_ok_response(&deploy_response)?.with_status(if ok { 200 } else { 502 });
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
    let api_token = secret_or_var(env, CLOUDFLARE_API_TOKEN_ENV);
    let ai_gateway_id = optional_request_or_env(
        request.ai_gateway_id.as_deref(),
        env,
        AI_GATEWAY_ID_ENV,
        "ai_gateway_id",
    )?;
    let route_ai_gateway_ids = RouteGatewayIds::from_request_and_env(env, &request)?;
    let compatibility_date = request
        .compatibility_date
        .as_deref()
        .map(validate_compatibility_date)
        .transpose()?
        .or_else(|| runtime_value(env, WFP_TENANT_COMPATIBILITY_DATE_ENV))
        .unwrap_or_else(|| DEFAULT_COMPATIBILITY_DATE.to_string());
    let attach_gateway_token = request.attach_gateway_token.unwrap_or(true);
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
    if api_token.is_none() {
        missing.push(ConfigRequirement {
            name: CLOUDFLARE_API_TOKEN_ENV,
            secret: true,
        });
    }

    let upload_url = account_id
        .as_deref()
        .zip(namespace.as_deref())
        .map(|(account, ns)| dispatch_script_upload_url(account, ns, &script_name));
    let actual_metadata = upload_metadata(
        &compatibility_date,
        &tenant_id,
        account_id.as_deref(),
        ai_gateway_id.as_deref(),
        &route_ai_gateway_ids,
        attach_gateway_token
            .then_some(api_token.as_deref())
            .flatten(),
        false,
    );
    let redacted_metadata = upload_metadata(
        &compatibility_date,
        &tenant_id,
        account_id.as_deref(),
        ai_gateway_id.as_deref(),
        &route_ai_gateway_ids,
        attach_gateway_token.then_some(Some("<redacted>")).flatten(),
        true,
    );
    let mut warnings = vec![
        "Generated tenant script forwards request bodies to Cloudflare AI Gateway REST without reading them; model policy and billing remain enforced by the main cinatoken relay.".to_string(),
    ];
    if !attach_gateway_token {
        warnings.push(
            "attach_gateway_token=false uses CLOUDFLARE_API_TOKEN only for the upload call; tenant runtime will fail closed until CF_API_TOKEN is attached out of band.".to_string(),
        );
    }

    Ok(TenantScriptPlanResponseInternal {
        plan: TenantScriptPlan {
            public_script_name,
            script_name,
            tenant_id,
            namespace,
            api_token,
            ai_gateway_id,
            route_ai_gateway_ids,
            compatibility_date,
            module_name: TENANT_MODULE_NAME.to_string(),
            script,
            upload_metadata: actual_metadata,
            redacted_metadata,
            upload_url,
            missing,
            warnings,
        },
        attach_gateway_token,
    })
}

struct TenantScriptPlanResponseInternal {
    plan: TenantScriptPlan,
    attach_gateway_token: bool,
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
        compatibility_date: plan.compatibility_date.clone(),
        ai_gateway_id_configured: plan.ai_gateway_id.is_some()
            || plan.route_ai_gateway_ids.any_configured(),
        route_ai_gateway_ids_configured: plan.route_ai_gateway_ids.configured(),
        attach_gateway_token: plan.attach_gateway_token,
        deployable: plan.missing.is_empty(),
        missing: plan.missing.clone(),
        warnings: plan.warnings.clone(),
        metadata: plan.redacted_metadata.clone(),
        script: plan.script.clone(),
        rust_wasm_runtime: RustWasmRuntimePlan {
            available: true,
            crate_path: RUST_TENANT_CRATE,
            build_command: RUST_TENANT_BUILD_COMMAND,
            shim_path: RUST_TENANT_SHIM_PATH,
            deployment_status: "compile_ready_artifact_upload_not_wired",
        },
    }
}

fn upload_metadata(
    compatibility_date: &str,
    tenant_id: &str,
    account_id: Option<&str>,
    ai_gateway_id: Option<&str>,
    route_ai_gateway_ids: &RouteGatewayIds,
    api_token: Option<&str>,
    redacted: bool,
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
    if let Some(api_token) = api_token {
        bindings.push(json!({
            "name": "CF_API_TOKEN",
            "type": "secret_text",
            "text": if redacted { "<redacted>" } else { api_token }
        }));
    }
    json!({
        "main_module": TENANT_MODULE_NAME,
        "compatibility_date": compatibility_date,
        "bindings": bindings
    })
}

fn route_gateway_binding_values(
    route_ai_gateway_ids: &RouteGatewayIds,
) -> [(&'static str, Option<&str>); 5] {
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
            AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV,
            route_ai_gateway_ids.openai_embeddings.as_deref(),
        ),
        (
            AI_GATEWAY_ID_AI_RUN_ENV,
            route_ai_gateway_ids.ai_run.as_deref(),
        ),
    ]
}

fn tenant_worker_script() -> String {
    r#"const STATUS_PATH = "/__cinatoken/tenant/status";
const REST_API_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/embeddings"
]);
const SUPPORTED_ROUTES = [
  STATUS_PATH,
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/embeddings",
  "/ai/run"
];
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-language",
  "expires",
  "last-modified",
  "etag",
  "vary",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-request-id",
  "anthropic-request-id"
];
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
const CONTROLLED_INBOUND_HEADERS = new Set([WFP_ROUTE_HEADER, WFP_WORKER_HEADER]);
const ROUTE_GATEWAY_ENVS = {
  "/v1/chat/completions": "AI_GATEWAY_ID_OPENAI_CHAT",
  "/v1/responses": "AI_GATEWAY_ID_OPENAI_RESPONSES",
  "/v1/messages": "AI_GATEWAY_ID_ANTHROPIC_MESSAGES",
  "/v1/embeddings": "AI_GATEWAY_ID_OPENAI_EMBEDDINGS",
  "/ai/run": "AI_GATEWAY_ID_AI_RUN"
};
const GATEWAY_ID_ENVS = [
  "AI_GATEWAY_ID",
  ...Object.values(ROUTE_GATEWAY_ENVS)
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      const inboundSensitiveHeaders = inboundSensitiveHeaderNames(request.headers);
      return jsonResponse({
        service: "cinatoken-wfp-tenant",
        runtime: "js-fallback",
        tenant_id: env.CINATOKEN_TENANT_ID || "unknown",
        ai_gateway_id_configured: gatewayIdConfigured(env),
        default_ai_gateway_id_configured: Boolean(env.AI_GATEWAY_ID),
        route_gateways: routeGatewayStatus(env),
        inbound_sensitive_headers_present: inboundSensitiveHeaders.length > 0,
        inbound_sensitive_headers: inboundSensitiveHeaders,
        inbound_dispatch_route: headerValue(request.headers, WFP_ROUTE_HEADER),
        inbound_dispatch_worker: headerValue(request.headers, WFP_WORKER_HEADER),
        forwarding: "cloudflare-ai-gateway-rest",
        body_mode: "streamed_request_body",
        routes: SUPPORTED_ROUTES
      }, {
        headers: {
          "x-cinatoken-wfp-tenant": env.CINATOKEN_TENANT_ID || "unknown",
          "x-cinatoken-wfp-runtime": "js-fallback"
        }
      });
    }

    const upstreamPath = targetPath(url.pathname);
    if (!upstreamPath) {
      return jsonError(404, "unsupported_tenant_route", "unsupported tenant AI Gateway route");
    }
    if (request.method !== "POST") {
      return jsonError(405, "method_not_allowed", "tenant AI Gateway routes require POST");
    }
    if (!isInternalDispatch(request.headers)) {
      return jsonError(403, "tenant_internal_dispatch_required", "tenant AI Gateway routes require internal WFP dispatch");
    }
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      return jsonError(500, "tenant_gateway_not_configured", "CF_ACCOUNT_ID and CF_API_TOKEN must be bound");
    }

    const target = new URL(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai${upstreamPath}`);
    target.search = url.search;
    const headers = upstreamHeaders(request.headers, env, url.pathname);
    const upstream = await fetch(target.toString(), {
      method: "POST",
      headers,
      body: request.body,
      redirect: "error"
    });
    const responseHeaders = safeResponseHeaders(upstream.headers);
    responseHeaders.set("x-cinatoken-wfp-tenant", env.CINATOKEN_TENANT_ID || "unknown");
    responseHeaders.set("x-cinatoken-wfp-runtime", "js-fallback");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  }
};

function targetPath(pathname) {
  if (REST_API_PATHS.has(pathname)) return pathname;
  if (pathname === "/ai/run") return "/run";
  return null;
}

function upstreamHeaders(input, env, pathname) {
  const headers = new Headers();
  copyHeader(input, headers, "content-type");
  copyHeader(input, headers, "accept");
  headers.set("authorization", `Bearer ${env.CF_API_TOKEN}`);
  const gatewayId = routeGatewayId(env, pathname);
  if (gatewayId) headers.set("cf-aig-gateway-id", gatewayId);
  headers.set("x-cinatoken-tenant", env.CINATOKEN_TENANT_ID || "unknown");
  headers.set("x-cinatoken-wfp-runtime", "js-fallback");
  headers.set("cf-aig-metadata", JSON.stringify({
    tenant_id: env.CINATOKEN_TENANT_ID || "unknown",
    runtime: "js-fallback",
    source: "cinatoken-wfp-tenant",
    route: pathname,
    api: routeFamily(pathname)
  }));
  return headers;
}

function routeGatewayId(env, pathname) {
  const gatewayEnv = ROUTE_GATEWAY_ENVS[pathname];
  const routeGatewayId = gatewayEnv ? env[gatewayEnv] : "";
  return routeGatewayId || env.AI_GATEWAY_ID || "";
}

function gatewayIdConfigured(env) {
  return GATEWAY_ID_ENVS.some((name) => Boolean(env[name]));
}

function routeGatewayStatus(env) {
  return Object.entries(ROUTE_GATEWAY_ENVS).map(([route, gatewayEnv]) => ({
    route,
    api: routeFamily(route),
    gateway_env: gatewayEnv,
    gateway_id_configured: Boolean(env[gatewayEnv])
  }));
}

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

function isInternalDispatch(input) {
  return (input.get(WFP_ROUTE_HEADER) || "").trim().toLowerCase() === WFP_INTERNAL_ROUTE;
}

function headerValue(input, name) {
  const value = input.get(name);
  return value && value.trim() ? value.trim() : null;
}

function safeResponseHeaders(input) {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function routeFamily(pathname) {
  if (pathname === "/v1/chat/completions") return "openai_chat";
  if (pathname === "/v1/responses") return "openai_responses";
  if (pathname === "/v1/messages") return "anthropic_messages";
  if (pathname === "/v1/embeddings") return "openai_embeddings";
  if (pathname === "/ai/run") return "ai_run";
  return "unknown";
}

function copyHeader(input, output, name) {
  const value = input.get(name);
  if (value) output.set(name, value);
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

fn secret_or_var(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .ok()
        .or_else(|| runtime_value(env, name))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn dispatch_script_upload_url(account_id: &str, namespace: &str, script_name: &str) -> String {
    format!(
        "{CLOUDFLARE_API_BASE}/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script_name}"
    )
}

fn build_multipart_upload_body(
    boundary: &str,
    metadata: &Value,
    module_name: &str,
    script: &str,
) -> serde_json::Result<Vec<u8>> {
    let metadata = serde_json::to_string(metadata)?;
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"{module_name}\"; filename=\"{module_name}\"\r\nContent-Type: application/javascript+module\r\n\r\n{script}\r\n--{boundary}--\r\n"
    );
    Ok(body.into_bytes())
}

async fn upload_tenant_script(
    upload_url: &str,
    api_token: Option<&str>,
    body: Vec<u8>,
) -> WorkerResult<(u16, String, Option<Value>)> {
    let api_token = api_token.ok_or_else(|| {
        worker::Error::RustError("CLOUDFLARE_API_TOKEN is required for WFP deploy".to_string())
    })?;
    let mut headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {api_token}"))?;
    headers.set(
        "Content-Type",
        "multipart/form-data; boundary=cinatoken_wfp_tenant_boundary",
    )?;
    headers.set("Accept", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Put)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(wasm_bindgen::JsValue::from(js_sys::Uint8Array::from(
            body.as_slice(),
        ))));
    let request = Request::new_with_init(upload_url, &init)?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(CF_API_TIMEOUT);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => result?,
        Either::Right(((), _)) => {
            controller.abort();
            return Err(worker::Error::RustError(
                "Cloudflare dispatch script upload timed out".to_string(),
            ));
        }
    };
    let status = response.status_code();
    let bytes = read_limited_response_body(&mut response, CF_API_RESPONSE_LIMIT_BYTES).await?;
    let preview = String::from_utf8_lossy(&bytes).trim().to_string();
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    Ok((status, preview, parsed))
}

async fn read_limited_response_body(
    response: &mut Response,
    limit: usize,
) -> WorkerResult<Vec<u8>> {
    if let Some(raw) = response.headers().get("Content-Length")? {
        if raw
            .trim()
            .parse::<usize>()
            .ok()
            .is_some_and(|length| length > limit)
        {
            return Err(worker::Error::RustError(format!(
                "Cloudflare API response exceeds {limit} bytes"
            )));
        }
    }
    response
        .stream()?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(worker::Error::RustError(format!(
                    "Cloudflare API response exceeds {limit} bytes"
                )));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_worker_streams_body_to_ai_gateway_without_client_auth_forward() {
        let script = tenant_worker_script();
        assert!(script.contains("request.body"));
        assert!(script.contains("Bearer ${env.CF_API_TOKEN}"));
        assert!(script.contains("cf-aig-gateway-id"));
        assert!(script.contains("AI_GATEWAY_ID_OPENAI_CHAT"));
        assert!(script.contains("AI_GATEWAY_ID_OPENAI_RESPONSES"));
        assert!(script.contains("AI_GATEWAY_ID_ANTHROPIC_MESSAGES"));
        assert!(script.contains("AI_GATEWAY_ID_OPENAI_EMBEDDINGS"));
        assert!(script.contains("AI_GATEWAY_ID_AI_RUN"));
        assert!(script.contains("routeGatewayId(env, pathname)"));
        assert!(script.contains("routeGatewayStatus(env)"));
        assert!(script.contains("cf-aig-metadata"));
        assert!(script.contains("runtime: \"js-fallback\""));
        assert!(script.contains("body_mode: \"streamed_request_body\""));
        assert!(script.contains("inbound_sensitive_headers_present"));
        assert!(script.contains("inboundSensitiveHeaderNames(request.headers)"));
        assert!(script.contains("SENSITIVE_INBOUND_HEADERS"));
        assert!(script.contains("CONTROLLED_INBOUND_HEADERS"));
        assert!(script.contains("WFP_ROUTE_HEADER"));
        assert!(script.contains("inbound_dispatch_route"));
        assert!(script.contains("isInternalDispatch(request.headers)"));
        assert!(script.contains("tenant_internal_dispatch_required"));
        assert!(script.contains("x-cinatoken-wfp-runtime"));
        assert!(script.contains("\"x-cinatoken-wfp-runtime\": \"js-fallback\""));
        assert!(script.contains("safeResponseHeaders(upstream.headers)"));
        assert!(script.contains("SAFE_RESPONSE_HEADERS"));
        assert!(!script.contains("new Headers(upstream.headers)"));
        assert!(!script.contains("input.get(\"authorization\")"));
        assert!(!script.contains("input.get(\"cookie\")"));
        assert!(!script.contains("if (env.AI_GATEWAY_ID) headers.set"));
        assert!(!script.contains("await request.json()"));
    }

    #[test]
    fn tenant_worker_generated_route_manifest_stays_in_sync() {
        let script = tenant_worker_script();
        for route in [
            "/__cinatoken/tenant/status",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/messages",
            "/v1/embeddings",
            "/ai/run",
        ] {
            assert!(script.contains(route), "missing generated route {route}");
        }
        for family in [
            "openai_chat",
            "openai_responses",
            "anthropic_messages",
            "openai_embeddings",
            "ai_run",
        ] {
            assert!(script.contains(family), "missing route family {family}");
        }
    }

    #[test]
    fn multipart_upload_body_contains_metadata_and_module() {
        let metadata = upload_metadata(
            "2026-06-17",
            "tenant-a",
            Some("account"),
            Some("gateway"),
            &RouteGatewayIds::default(),
            Some("secret"),
            false,
        );
        let body = build_multipart_upload_body(
            "boundary",
            &metadata,
            TENANT_MODULE_NAME,
            "export default {}",
        )
        .unwrap();
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("name=\"metadata\""));
        assert!(body.contains("\"main_module\":\"tenant.mjs\""));
        assert!(body.contains("\"type\":\"secret_text\""));
        assert!(body.contains("name=\"tenant.mjs\"; filename=\"tenant.mjs\""));
        assert!(body.ends_with("--boundary--\r\n"));
    }

    #[test]
    fn redacted_metadata_never_exposes_api_token() {
        let metadata = upload_metadata(
            "2026-06-17",
            "tenant-a",
            Some("account"),
            Some("gateway"),
            &RouteGatewayIds::default(),
            Some("secret-token"),
            true,
        );
        let raw = metadata.to_string();
        assert!(raw.contains("<redacted>"));
        assert!(!raw.contains("secret-token"));
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
            None,
            false,
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
