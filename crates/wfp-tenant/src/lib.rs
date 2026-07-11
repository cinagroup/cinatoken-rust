//! CinaToken Workers for Platforms tenant runtime.
//!
//! This crate is intentionally small: the main `cinatoken-worker` owns auth,
//! billing, audit logging, and tenant deployment. A WFP tenant Worker only
//! exposes a status smoke endpoint and forwards selected AI routes to
//! Cloudflare AI Gateway with tenant-scoped headers.

use cinatoken_wfp_authority::{
    authority_replay_bucket, decode_worker_key, validate_worker_name,
    verify_authority_with_worker_key, AuthorityClaims, AuthorityExpectation, AUTHORITY_HEADER,
    AUTHORITY_REPLAY_BINDING, AUTHORITY_TENANT_KEY_ENV,
};
use serde::Serialize;
use serde_json::json;
use url::Url;
use wasm_bindgen::JsValue;
use worker::{
    event, Context, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response,
    Result as WorkerResult,
};

const STATUS_PATH: &str = "/__cinatoken/tenant/status";
const SERVICE_NAME: &str = "cinatoken-wfp-tenant-rust";
const AI_GATEWAY_BASE: &str = "https://api.cloudflare.com/client/v4";
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
const WFP_ROUTE_HEADER: &str = "x-cinatoken-wfp-route";
const WFP_WORKER_HEADER: &str = "x-cinatoken-wfp-worker";
const WFP_WORKER_NAME_ENV: &str = "CINATOKEN_WFP_WORKER_NAME";
const WFP_INTERNAL_ROUTE: &str = "internal-path";
const WFP_RELAY_AUTHORITY_ROUTE: &str = "relay-authority";
const STATUS_CONTROL_AUTHORITY_MODES: &[&str] = &[WFP_INTERNAL_ROUTE, WFP_RELAY_AUTHORITY_ROUTE];
const PAID_AI_AUTHORITY_VERIFIER: &str = "hmac-sha256-body-bound-v1";
const PAID_AI_REPLAY_GUARD: &str = "platform-durable-object-once-v1";
const MAX_VERIFIED_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
const UNKNOWN_TENANT: &str = "unknown";
const SAFE_RESPONSE_HEADERS: &[&str] = &[
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
    "anthropic-request-id",
];
const SENSITIVE_INBOUND_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "api-key",
    "cf-access-client-id",
    "cf-access-client-secret",
];
const CONTROLLED_INBOUND_HEADERS: &[&str] = &[WFP_ROUTE_HEADER, WFP_WORKER_HEADER];
const SUPPORTED_ROUTES: &[TenantRoute] = &[
    TenantRoute {
        public_path: "/v1/chat/completions",
        upstream_path: "/v1/chat/completions",
        api_family: "openai_chat",
    },
    TenantRoute {
        public_path: "/v1/responses",
        upstream_path: "/v1/responses",
        api_family: "openai_responses",
    },
    TenantRoute {
        public_path: "/v1/messages",
        upstream_path: "/v1/messages",
        api_family: "anthropic_messages",
    },
    TenantRoute {
        public_path: "/ai/run",
        upstream_path: "/run",
        api_family: "ai_run",
    },
];
const SUPPORTED_ROUTE_PATHS: &[&str] = &[
    STATUS_PATH,
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/ai/run",
];
const AI_GATEWAY_REQUEST_POLICIES: &[AiGatewayRequestPolicy] = &[
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_REQUEST_TIMEOUT_MS_ENV,
        header: "cf-aig-request-timeout",
        validator: AiGatewayPolicyValidator::PositiveInteger {
            min: 1,
            max: Some(600_000),
        },
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_MAX_ATTEMPTS_ENV,
        header: "cf-aig-max-attempts",
        validator: AiGatewayPolicyValidator::PositiveInteger {
            min: 1,
            max: Some(5),
        },
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_RETRY_DELAY_MS_ENV,
        header: "cf-aig-retry-delay",
        validator: AiGatewayPolicyValidator::PositiveInteger {
            min: 1,
            max: Some(5_000),
        },
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_BACKOFF_ENV,
        header: "cf-aig-backoff",
        validator: AiGatewayPolicyValidator::Backoff,
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_CACHE_TTL_SECONDS_ENV,
        header: "cf-aig-cache-ttl",
        validator: AiGatewayPolicyValidator::PositiveInteger { min: 1, max: None },
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_SKIP_CACHE_ENV,
        header: "cf-aig-skip-cache",
        validator: AiGatewayPolicyValidator::Boolean,
    },
    AiGatewayRequestPolicy {
        env: AI_GATEWAY_COLLECT_LOG_ENV,
        header: "cf-aig-collect-log",
        validator: AiGatewayPolicyValidator::Boolean,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TenantRoute {
    public_path: &'static str,
    upstream_path: &'static str,
    api_family: &'static str,
}

#[derive(Debug, Serialize)]
struct TenantStatus {
    service: &'static str,
    runtime: &'static str,
    tenant_id: String,
    ai_gateway_id_configured: bool,
    default_ai_gateway_id_configured: bool,
    route_gateways: Vec<RouteGatewayStatus>,
    ai_gateway_request_policy: Vec<AiGatewayRequestPolicyStatus>,
    inbound_sensitive_headers_present: bool,
    inbound_sensitive_headers: Vec<String>,
    status_control_authority_modes: &'static [&'static str],
    paid_ai_authority_mode: &'static str,
    paid_ai_authority_verifier: &'static str,
    paid_ai_replay_guard: &'static str,
    authority_replay_binding_configured: bool,
    paid_ai_capable: bool,
    inbound_dispatch_route: Option<String>,
    inbound_dispatch_worker: Option<String>,
    forwarding: &'static str,
    body_mode: &'static str,
    routes: &'static [&'static str],
}

#[derive(Debug, Serialize)]
struct RouteGatewayStatus {
    route: &'static str,
    api: &'static str,
    gateway_env: &'static str,
    gateway_id_configured: bool,
}

#[derive(Debug, Serialize)]
struct AiGatewayRequestPolicyStatus {
    env: &'static str,
    header: &'static str,
    configured: bool,
    valid: bool,
}

#[derive(Debug, Clone, Copy)]
struct AiGatewayRequestPolicy {
    env: &'static str,
    header: &'static str,
    validator: AiGatewayPolicyValidator,
}

#[derive(Debug, Clone, Copy)]
enum AiGatewayPolicyValidator {
    PositiveInteger { min: u32, max: Option<u32> },
    Boolean,
    Backoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerifiedJsonBodyError {
    TooLarge,
    InvalidJson,
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> WorkerResult<Response> {
    console_error_panic_hook::set_once();
    route(req, env).await
}

async fn route(req: Request, env: Env) -> WorkerResult<Response> {
    let path = req.path();
    if req.method() == Method::Get && path == STATUS_PATH {
        return tenant_status(&req, &env);
    }

    let Some(route) = target_route(&path) else {
        return tenant_error(
            404,
            "unsupported_tenant_route",
            "unsupported tenant AI Gateway route",
        );
    };
    if req.method() != Method::Post {
        return tenant_error(
            405,
            "method_not_allowed",
            "tenant AI Gateway routes require POST",
        );
    }

    forward_ai_gateway(req, env, route).await
}

fn tenant_status(req: &Request, env: &Env) -> WorkerResult<Response> {
    let tenant_id = tenant_id(env);
    let default_ai_gateway_id_configured = runtime_value(env, AI_GATEWAY_ID_ENV).is_some();
    let route_gateways = route_gateway_statuses(env);
    let ai_gateway_id_configured = default_ai_gateway_id_configured
        || route_gateways
            .iter()
            .any(|route| route.gateway_id_configured);
    let inbound_sensitive_headers = inbound_sensitive_header_names(req.headers());
    let authority_replay_binding_configured = env.durable_object(AUTHORITY_REPLAY_BINDING).is_ok();
    let paid_ai_capable = paid_ai_runtime_configured(
        secret_or_var(env, AUTHORITY_TENANT_KEY_ENV).as_deref(),
        runtime_value(env, WFP_WORKER_NAME_ENV).as_deref(),
        runtime_value(env, "CF_ACCOUNT_ID").as_deref(),
        secret_or_var(env, "CF_API_TOKEN").as_deref(),
        authority_replay_binding_configured,
    );
    let status = TenantStatus {
        service: SERVICE_NAME,
        runtime: "rust-wasm",
        tenant_id,
        ai_gateway_id_configured,
        default_ai_gateway_id_configured,
        route_gateways,
        ai_gateway_request_policy: ai_gateway_request_policy_statuses(env),
        inbound_sensitive_headers_present: !inbound_sensitive_headers.is_empty(),
        inbound_sensitive_headers,
        status_control_authority_modes: STATUS_CONTROL_AUTHORITY_MODES,
        paid_ai_authority_mode: WFP_RELAY_AUTHORITY_ROUTE,
        paid_ai_authority_verifier: PAID_AI_AUTHORITY_VERIFIER,
        paid_ai_replay_guard: PAID_AI_REPLAY_GUARD,
        authority_replay_binding_configured,
        paid_ai_capable,
        inbound_dispatch_route: request_header(req, WFP_ROUTE_HEADER),
        inbound_dispatch_worker: request_header(req, WFP_WORKER_HEADER),
        forwarding: "cloudflare-ai-gateway-rest",
        body_mode: "bounded_verified_json",
        routes: SUPPORTED_ROUTE_PATHS,
    };
    let mut response = json_response(&status, 200)?;
    response
        .headers_mut()
        .set("x-cinatoken-wfp-tenant", &status.tenant_id)?;
    response
        .headers_mut()
        .set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    Ok(response)
}

async fn forward_ai_gateway(
    mut req: Request,
    env: Env,
    route: TenantRoute,
) -> WorkerResult<Response> {
    if !request_has_paid_ai_authority_mode(&req) {
        return tenant_error(
            403,
            "tenant_relay_authority_required",
            "tenant AI Gateway routes require relay authority",
        );
    }
    if request_url_has_query(&req.url()?) {
        return tenant_error(
            400,
            "tenant_query_not_supported",
            "tenant AI routes do not accept query strings",
        );
    }

    let Some(authority_key) = secret_or_var(&env, AUTHORITY_TENANT_KEY_ENV) else {
        return tenant_error(
            500,
            "tenant_relay_authority_not_configured",
            "tenant relay authority key must be bound",
        );
    };
    let Some(worker_name) = runtime_value(&env, WFP_WORKER_NAME_ENV) else {
        return tenant_error(
            500,
            "tenant_relay_authority_not_configured",
            "tenant relay worker name must be bound",
        );
    };
    let Some(authority_token) = request_header(&req, AUTHORITY_HEADER) else {
        return tenant_error(
            403,
            "tenant_relay_authority_required",
            "tenant relay authority token is required",
        );
    };

    if request_content_length_exceeds(&req, MAX_VERIFIED_JSON_BODY_BYTES)? {
        return tenant_error(
            413,
            "tenant_request_body_too_large",
            "tenant AI request body exceeds 4 MiB",
        );
    }
    let body = req.bytes().await?;
    match validate_verified_json_body(&body) {
        Ok(()) => {}
        Err(VerifiedJsonBodyError::TooLarge) => {
            return tenant_error(
                413,
                "tenant_request_body_too_large",
                "tenant AI request body exceeds 4 MiB",
            );
        }
        Err(VerifiedJsonBodyError::InvalidJson) => {
            return tenant_error(
                400,
                "tenant_invalid_json_body",
                "tenant AI request body must be valid JSON",
            );
        }
    }

    let claims = decode_worker_key(&authority_key).and_then(|worker_key| {
        verify_authority_with_worker_key(
            &worker_key,
            &authority_token,
            AuthorityExpectation {
                worker: &worker_name,
                method: "POST",
                path: route.public_path,
                body: &body,
                now: unix_timestamp(),
            },
        )
    });
    let claims = match claims {
        Ok(claims) => claims,
        Err(_) => {
            return tenant_error(
                403,
                "tenant_relay_authority_invalid",
                "tenant relay authority verification failed",
            );
        }
    };
    match consume_authority_once(&env, &worker_name, &authority_token, &claims).await {
        Ok(()) => {}
        Err(ReplayConsumeError::Replay) => {
            return tenant_error(
                409,
                "tenant_relay_authority_replayed",
                "tenant relay authority was already consumed",
            );
        }
        Err(ReplayConsumeError::Rejected) => {
            return tenant_error(
                403,
                "tenant_relay_authority_invalid",
                "tenant relay authority replay guard rejected the request",
            );
        }
        Err(ReplayConsumeError::Unavailable) => {
            return tenant_error(
                503,
                "tenant_relay_authority_replay_guard_unavailable",
                "tenant relay authority replay guard is unavailable",
            );
        }
    }

    let Some(account_id) = runtime_value(&env, "CF_ACCOUNT_ID") else {
        return tenant_error(
            500,
            "tenant_gateway_not_configured",
            "CF_ACCOUNT_ID must be bound",
        );
    };
    let Some(api_token) = secret_or_var(&env, "CF_API_TOKEN") else {
        return tenant_error(
            500,
            "tenant_gateway_not_configured",
            "CF_API_TOKEN must be bound",
        );
    };

    let target = ai_gateway_url(&account_id, route.upstream_path)?;
    let headers = upstream_headers(&req, &env, &api_token, route)?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(JsValue::from(js_sys::Uint8Array::from(
            body.as_slice(),
        ))));
    let outbound = Request::new_with_init(target.as_str(), &init)?;
    let mut upstream = Fetch::Request(outbound).send().await?;
    let status = upstream.status_code();
    let headers = tenant_response_headers(upstream.headers(), &env)?;
    Ok(Response::from_stream(upstream.stream()?)?
        .with_status(status)
        .with_headers(headers))
}

fn target_route(path: &str) -> Option<TenantRoute> {
    SUPPORTED_ROUTES
        .iter()
        .copied()
        .find(|route| route.public_path == path)
}

fn ai_gateway_url(account_id: &str, upstream_path: &str) -> WorkerResult<Url> {
    let account_id = account_id.trim();
    if account_id.is_empty()
        || account_id.len() > 128
        || account_id
            .chars()
            .any(|ch| ch.is_ascii_control() || ch == '/' || ch == '?' || ch == '#')
    {
        return Err(worker::Error::RustError(
            "CF_ACCOUNT_ID is not a valid account id".to_string(),
        ));
    }
    Url::parse(&format!(
        "{AI_GATEWAY_BASE}/accounts/{account_id}/ai{upstream_path}"
    ))
    .map_err(|err| worker::Error::RustError(format!("failed to build AI Gateway URL: {err}")))
}

fn upstream_headers(
    req: &Request,
    env: &Env,
    api_token: &str,
    route: TenantRoute,
) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    copy_header(req, &mut headers, "content-type")?;
    copy_header(req, &mut headers, "accept")?;
    headers.set("authorization", &format!("Bearer {api_token}"))?;
    if let Some(gateway_id) = gateway_id_for_route(env, route) {
        headers.set("cf-aig-gateway-id", &gateway_id)?;
    }
    append_ai_gateway_request_policy_headers(&mut headers, env)?;
    headers.set(
        "x-cinatoken-tenant",
        &runtime_value(env, "CINATOKEN_TENANT_ID").unwrap_or_else(|| UNKNOWN_TENANT.to_string()),
    )?;
    headers.set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    headers.set(
        "cf-aig-metadata",
        &ai_gateway_metadata_value(
            &runtime_value(env, "CINATOKEN_TENANT_ID")
                .unwrap_or_else(|| UNKNOWN_TENANT.to_string()),
            route,
        ),
    )?;
    Ok(headers)
}

fn append_ai_gateway_request_policy_headers(headers: &mut Headers, env: &Env) -> WorkerResult<()> {
    for policy in AI_GATEWAY_REQUEST_POLICIES {
        let Some(value) = runtime_value(env, policy.env) else {
            continue;
        };
        let Some(header_value) = validate_ai_gateway_policy_value(&value, policy.validator) else {
            return Err(worker::Error::RustError(format!(
                "{} is not a valid {} value",
                policy.env, policy.header
            )));
        };
        headers.set(policy.header, &header_value)?;
    }
    Ok(())
}

fn tenant_response_headers(upstream: &Headers, env: &Env) -> WorkerResult<Headers> {
    let mut headers = safe_response_headers(upstream)?;
    headers.set("x-cinatoken-wfp-tenant", &tenant_id(env))?;
    headers.set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    Ok(headers)
}

fn ai_gateway_request_policy_statuses(env: &Env) -> Vec<AiGatewayRequestPolicyStatus> {
    AI_GATEWAY_REQUEST_POLICIES
        .iter()
        .map(|policy| {
            let value = runtime_value(env, policy.env);
            AiGatewayRequestPolicyStatus {
                env: policy.env,
                header: policy.header,
                configured: value.is_some(),
                valid: value
                    .as_deref()
                    .and_then(|value| validate_ai_gateway_policy_value(value, policy.validator))
                    .is_some(),
            }
        })
        .collect()
}

fn route_gateway_statuses(env: &Env) -> Vec<RouteGatewayStatus> {
    SUPPORTED_ROUTES
        .iter()
        .map(|route| RouteGatewayStatus {
            route: route.public_path,
            api: route.api_family,
            gateway_env: route_gateway_env_name(*route),
            gateway_id_configured: runtime_value(env, route_gateway_env_name(*route)).is_some(),
        })
        .collect()
}

fn gateway_id_for_route(env: &Env, route: TenantRoute) -> Option<String> {
    select_gateway_id(
        runtime_value(env, route_gateway_env_name(route)),
        runtime_value(env, AI_GATEWAY_ID_ENV),
    )
}

fn route_gateway_env_name(route: TenantRoute) -> &'static str {
    match route.api_family {
        "openai_chat" => AI_GATEWAY_ID_OPENAI_CHAT_ENV,
        "openai_responses" => AI_GATEWAY_ID_OPENAI_RESPONSES_ENV,
        "anthropic_messages" => AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV,
        "ai_run" => AI_GATEWAY_ID_AI_RUN_ENV,
        _ => AI_GATEWAY_ID_ENV,
    }
}

fn select_gateway_id(route_specific: Option<String>, default: Option<String>) -> Option<String> {
    route_specific.or(default)
}

fn validate_ai_gateway_policy_value(
    value: &str,
    validator: AiGatewayPolicyValidator,
) -> Option<String> {
    let value = value.trim();
    match validator {
        AiGatewayPolicyValidator::PositiveInteger { min, max } => {
            if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
                return None;
            }
            let parsed = value.parse::<u32>().ok()?;
            if parsed < min || max.is_some_and(|max| parsed > max) {
                return None;
            }
            Some(parsed.to_string())
        }
        AiGatewayPolicyValidator::Boolean => match value.to_ascii_lowercase().as_str() {
            "true" => Some("true".to_string()),
            "false" => Some("false".to_string()),
            _ => None,
        },
        AiGatewayPolicyValidator::Backoff => match value.to_ascii_lowercase().as_str() {
            "constant" | "linear" | "exponential" => Some(value.to_ascii_lowercase()),
            _ => None,
        },
    }
}

fn safe_response_headers(upstream: &Headers) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    for name in SAFE_RESPONSE_HEADERS {
        if let Some(value) = upstream.get(name)? {
            headers.set(name, &value)?;
        }
    }
    Ok(headers)
}

#[cfg(test)]
fn is_safe_response_header(name: &str) -> bool {
    SAFE_RESPONSE_HEADERS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(name))
}

fn ai_gateway_metadata_value(tenant_id: &str, route: TenantRoute) -> String {
    json!({
        "tenant_id": tenant_id,
        "runtime": "rust-wasm",
        "source": SERVICE_NAME,
        "route": route.public_path,
        "api": route.api_family,
    })
    .to_string()
}

fn copy_header(req: &Request, output: &mut Headers, name: &str) -> WorkerResult<()> {
    if let Some(value) = req.headers().get(name)? {
        output.set(name, &value)?;
    }
    Ok(())
}

fn request_header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn request_has_paid_ai_authority_mode(req: &Request) -> bool {
    is_paid_ai_authority_mode(request_header(req, WFP_ROUTE_HEADER).as_deref())
}

fn is_paid_ai_authority_mode(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some(value) if value.eq_ignore_ascii_case(WFP_RELAY_AUTHORITY_ROUTE))
}

fn request_content_length_exceeds(req: &Request, limit: usize) -> WorkerResult<bool> {
    Ok(req
        .headers()
        .get("content-length")?
        .and_then(|value| value.trim().parse::<usize>().ok())
        .is_some_and(|length| length > limit))
}

fn request_url_has_query(url: &Url) -> bool {
    url.query().is_some()
}

fn authority_bindings_configured(worker_key: Option<&str>, worker_name: Option<&str>) -> bool {
    let (Some(worker_key), Some(worker_name)) = (worker_key, worker_name) else {
        return false;
    };
    decode_worker_key(worker_key).is_ok() && validate_worker_name(worker_name).is_ok()
}

fn paid_ai_runtime_configured(
    authority_key: Option<&str>,
    worker_name: Option<&str>,
    account_id: Option<&str>,
    tenant_api_token: Option<&str>,
    authority_replay_binding_configured: bool,
) -> bool {
    authority_bindings_configured(authority_key, worker_name)
        && account_id.is_some_and(|value| !value.trim().is_empty())
        && tenant_api_token.is_some_and(|value| !value.trim().is_empty())
        && authority_replay_binding_configured
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayConsumeError {
    Replay,
    Rejected,
    Unavailable,
}

async fn consume_authority_once(
    env: &Env,
    worker_name: &str,
    authority_token: &str,
    claims: &AuthorityClaims,
) -> Result<(), ReplayConsumeError> {
    let namespace = env
        .durable_object(AUTHORITY_REPLAY_BINDING)
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    let bucket = authority_replay_bucket(worker_name, claims.issued_at)
        .map_err(|_| ReplayConsumeError::Rejected)?;
    let stub = namespace
        .id_from_name(&bucket)
        .and_then(|id| id.get_stub())
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    let mut headers = Headers::new();
    headers
        .set(AUTHORITY_HEADER, authority_token)
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    headers
        .set(WFP_WORKER_HEADER, worker_name)
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let request = Request::new_with_init("https://wfp-authority-replay.internal/consume", &init)
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    let response = stub
        .fetch_with_request(request)
        .await
        .map_err(|_| ReplayConsumeError::Unavailable)?;
    match response.status_code() {
        200..=299 => Ok(()),
        409 => Err(ReplayConsumeError::Replay),
        401 | 403 => Err(ReplayConsumeError::Rejected),
        _ => Err(ReplayConsumeError::Unavailable),
    }
}

fn validate_verified_json_body(body: &[u8]) -> Result<(), VerifiedJsonBodyError> {
    if body.len() > MAX_VERIFIED_JSON_BODY_BYTES {
        return Err(VerifiedJsonBodyError::TooLarge);
    }
    serde_json::from_slice::<serde_json::Value>(body)
        .map(|_| ())
        .map_err(|_| VerifiedJsonBodyError::InvalidJson)
}

fn unix_timestamp() -> i64 {
    (js_sys::Date::now() / 1000.0) as i64
}

fn inbound_sensitive_header_names(headers: &Headers) -> Vec<String> {
    let mut names = Vec::new();
    for (name, _) in headers {
        if is_sensitive_inbound_header(&name) {
            names.push(name.to_ascii_lowercase());
        }
    }
    names.sort();
    names.dedup();
    names
}

fn is_sensitive_inbound_header(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    SENSITIVE_INBOUND_HEADERS.contains(&name.as_str())
        || (name.starts_with("x-cinatoken-")
            && !CONTROLLED_INBOUND_HEADERS.contains(&name.as_str()))
}

fn tenant_id(env: &Env) -> String {
    runtime_value(env, "CINATOKEN_TENANT_ID").unwrap_or_else(|| UNKNOWN_TENANT.to_string())
}

fn runtime_value(env: &Env, name: &str) -> Option<String> {
    env.var(name)
        .map(|value| value.to_string())
        .ok()
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

fn json_response<T: Serialize>(body: &T, status: u16) -> WorkerResult<Response> {
    let mut response = Response::from_json(body)?.with_status(status);
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

fn tenant_error(status: u16, code: &str, message: &str) -> WorkerResult<Response> {
    json_response(
        &json!({
            "error": {
                "code": code,
                "message": message,
                "type": "cinatoken_wfp_tenant_error"
            }
        }),
        status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_routes_map_to_ai_gateway_paths() {
        let expected = [
            ("/v1/chat/completions", "/v1/chat/completions"),
            ("/v1/responses", "/v1/responses"),
            ("/v1/messages", "/v1/messages"),
            ("/ai/run", "/run"),
        ];
        for (public_path, upstream_path) in expected {
            assert_eq!(
                target_route(public_path).map(|route| route.upstream_path),
                Some(upstream_path)
            );
        }
        assert_eq!(target_route("/v1/embeddings"), None);
        assert_eq!(target_route("/v1/models"), None);
    }

    #[test]
    fn status_route_manifest_exactly_matches_supported_routes() {
        assert_eq!(
            SUPPORTED_ROUTE_PATHS,
            &[
                STATUS_PATH,
                "/v1/chat/completions",
                "/v1/responses",
                "/v1/messages",
                "/ai/run",
            ]
        );
        assert_eq!(
            SUPPORTED_ROUTES
                .iter()
                .map(|route| route.public_path)
                .collect::<Vec<_>>(),
            SUPPORTED_ROUTE_PATHS[1..]
        );
    }

    #[test]
    fn ai_gateway_urls_exactly_match_supported_routes() {
        let expected = [
            (
                "/v1/chat/completions",
                "https://api.cloudflare.com/client/v4/accounts/account123/ai/v1/chat/completions",
            ),
            (
                "/v1/responses",
                "https://api.cloudflare.com/client/v4/accounts/account123/ai/v1/responses",
            ),
            (
                "/v1/messages",
                "https://api.cloudflare.com/client/v4/accounts/account123/ai/v1/messages",
            ),
            (
                "/ai/run",
                "https://api.cloudflare.com/client/v4/accounts/account123/ai/run",
            ),
        ];
        for (public_path, final_url) in expected {
            let route = target_route(public_path).unwrap();
            assert_eq!(
                ai_gateway_url("account123", route.upstream_path)
                    .unwrap()
                    .as_str(),
                final_url
            );
        }
        assert!(ai_gateway_url("bad/account", "/v1/responses").is_err());
        assert!(ai_gateway_url("", "/v1/responses").is_err());
    }

    #[test]
    fn ai_gateway_metadata_is_flat_and_route_specific() {
        for route in SUPPORTED_ROUTES {
            let metadata = ai_gateway_metadata_value("tenant-a", *route);
            let parsed: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(parsed["tenant_id"], "tenant-a");
            assert_eq!(parsed["runtime"], "rust-wasm");
            assert_eq!(parsed["source"], SERVICE_NAME);
            assert_eq!(parsed["route"], route.public_path);
            assert_eq!(parsed["api"], route.api_family);
            assert_eq!(parsed.as_object().unwrap().len(), 5);
            assert!(parsed
                .as_object()
                .unwrap()
                .values()
                .all(|value| value.is_string()));
        }
    }

    #[test]
    fn route_gateway_env_names_are_route_specific() {
        assert_eq!(
            route_gateway_env_name(target_route("/v1/chat/completions").unwrap()),
            AI_GATEWAY_ID_OPENAI_CHAT_ENV
        );
        assert_eq!(
            route_gateway_env_name(target_route("/v1/responses").unwrap()),
            AI_GATEWAY_ID_OPENAI_RESPONSES_ENV
        );
        assert_eq!(
            route_gateway_env_name(target_route("/v1/messages").unwrap()),
            AI_GATEWAY_ID_ANTHROPIC_MESSAGES_ENV
        );
        assert_eq!(
            route_gateway_env_name(target_route("/ai/run").unwrap()),
            AI_GATEWAY_ID_AI_RUN_ENV
        );
    }

    #[test]
    fn route_gateway_selection_prefers_route_specific_id() {
        assert_eq!(
            select_gateway_id(
                Some("route-gateway".to_string()),
                Some("default".to_string())
            )
            .as_deref(),
            Some("route-gateway")
        );
        assert_eq!(
            select_gateway_id(None, Some("default".to_string())).as_deref(),
            Some("default")
        );
        assert!(select_gateway_id(None, None).is_none());
    }

    #[test]
    fn ai_gateway_request_policy_values_are_sanitized() {
        assert_eq!(
            validate_ai_gateway_policy_value(
                " 5 ",
                AiGatewayPolicyValidator::PositiveInteger {
                    min: 1,
                    max: Some(5)
                }
            )
            .as_deref(),
            Some("5")
        );
        assert_eq!(
            validate_ai_gateway_policy_value("LINEAR", AiGatewayPolicyValidator::Backoff)
                .as_deref(),
            Some("linear")
        );
        assert_eq!(
            validate_ai_gateway_policy_value("false", AiGatewayPolicyValidator::Boolean).as_deref(),
            Some("false")
        );
        assert!(validate_ai_gateway_policy_value(
            "6",
            AiGatewayPolicyValidator::PositiveInteger {
                min: 1,
                max: Some(5)
            }
        )
        .is_none());
        assert!(validate_ai_gateway_policy_value(
            "0",
            AiGatewayPolicyValidator::PositiveInteger { min: 1, max: None }
        )
        .is_none());
        assert!(validate_ai_gateway_policy_value(
            "true; cf-aig-max-attempts=5",
            AiGatewayPolicyValidator::Boolean
        )
        .is_none());
        assert!(
            validate_ai_gateway_policy_value("jitter", AiGatewayPolicyValidator::Backoff).is_none()
        );
    }

    #[test]
    fn response_header_allowlist_keeps_only_public_headers() {
        for header in [
            "content-type",
            "cache-control",
            "retry-after",
            "x-request-id",
            "openai-request-id",
            "anthropic-request-id",
            "Content-Type",
        ] {
            assert!(is_safe_response_header(header), "expected {header} to pass");
        }

        for header in [
            "authorization",
            "set-cookie",
            "cf-aig-log-id",
            "cf-aig-step",
            "cf-ray",
            "server",
            "content-length",
            "transfer-encoding",
            "x-cinatoken-wfp-tenant",
        ] {
            assert!(
                !is_safe_response_header(header),
                "expected {header} to be blocked"
            );
        }
    }

    #[test]
    fn inbound_sensitive_header_detection_matches_dispatch_scrubbing_contract() {
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
            AUTHORITY_HEADER,
        ] {
            assert!(
                is_sensitive_inbound_header(header),
                "expected {header} to be reported by tenant status"
            );
        }

        for header in [
            "Content-Type",
            "Accept",
            "User-Agent",
            "Traceparent",
            "X-Cinatoken-WFP-Route",
            "x-cinatoken-wfp-worker",
        ] {
            assert!(
                !is_sensitive_inbound_header(header),
                "expected {header} to remain a normal forwarded header"
            );
        }
    }

    #[test]
    fn paid_ai_requires_relay_authority_mode() {
        assert!(is_paid_ai_authority_mode(Some("relay-authority")));
        assert!(is_paid_ai_authority_mode(Some(" RELAY-AUTHORITY ")));
        assert!(!is_paid_ai_authority_mode(Some("internal-path")));
        assert!(!is_paid_ai_authority_mode(Some("preview-host")));
        assert!(!is_paid_ai_authority_mode(Some("")));
        assert!(!is_paid_ai_authority_mode(None));
    }

    #[test]
    fn status_authority_contract_matches_shared_verifier() {
        assert_eq!(
            STATUS_CONTROL_AUTHORITY_MODES,
            &["internal-path", "relay-authority"]
        );
        assert_eq!(WFP_RELAY_AUTHORITY_ROUTE, "relay-authority");
        assert_eq!(PAID_AI_AUTHORITY_VERIFIER, "hmac-sha256-body-bound-v1");
        assert_eq!(PAID_AI_REPLAY_GUARD, "platform-durable-object-once-v1");
        assert_eq!(AUTHORITY_REPLAY_BINDING, "WFP_AUTHORITY_REPLAY");
        assert_eq!(WFP_WORKER_NAME_ENV, "CINATOKEN_WFP_WORKER_NAME");
        assert_eq!(AUTHORITY_TENANT_KEY_ENV, "WFP_RELAY_AUTHORITY_KEY");
        assert_eq!(MAX_VERIFIED_JSON_BODY_BYTES, 4 * 1024 * 1024);
    }

    #[test]
    fn paid_ai_capability_requires_both_authority_bindings() {
        assert!(authority_bindings_configured(
            Some("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"),
            Some("tenant-a")
        ));
        assert!(!authority_bindings_configured(None, Some("tenant-a")));
        assert!(!authority_bindings_configured(
            Some("0123456789abcdef0123456789abcdef"),
            None
        ));
        assert!(!authority_bindings_configured(
            Some("short"),
            Some("tenant-a")
        ));
        assert!(!authority_bindings_configured(
            Some("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"),
            Some("../tenant")
        ));
    }

    #[test]
    fn paid_ai_capability_requires_authority_account_and_tenant_token() {
        let secret = Some("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY");
        let worker = Some("tenant-a");
        assert!(paid_ai_runtime_configured(
            secret,
            worker,
            Some("account-a"),
            Some("tenant-api-token"),
            true
        ));
        assert!(!paid_ai_runtime_configured(
            secret,
            worker,
            None,
            Some("tenant-api-token"),
            true
        ));
        assert!(!paid_ai_runtime_configured(
            secret,
            worker,
            Some("account-a"),
            None,
            true
        ));
        assert!(!paid_ai_runtime_configured(
            secret,
            worker,
            Some("  "),
            Some("tenant-api-token"),
            true
        ));
        assert!(!paid_ai_runtime_configured(
            secret,
            worker,
            Some("account-a"),
            Some("tenant-api-token"),
            false
        ));
    }

    #[test]
    fn replay_guard_status_mapping_is_fail_closed() {
        assert_eq!(ReplayConsumeError::Replay, ReplayConsumeError::Replay);
        assert_ne!(ReplayConsumeError::Replay, ReplayConsumeError::Unavailable);
        assert_ne!(
            ReplayConsumeError::Rejected,
            ReplayConsumeError::Unavailable
        );
    }

    #[test]
    fn verified_json_body_enforces_valid_json_and_hard_limit() {
        assert_eq!(validate_verified_json_body(br#"{"ok":true}"#), Ok(()));
        assert_eq!(
            validate_verified_json_body(b"not-json"),
            Err(VerifiedJsonBodyError::InvalidJson)
        );
        assert_eq!(
            validate_verified_json_body(&vec![b' '; MAX_VERIFIED_JSON_BODY_BYTES + 1]),
            Err(VerifiedJsonBodyError::TooLarge)
        );
    }

    #[test]
    fn paid_ai_rejects_all_query_strings() {
        assert!(!request_url_has_query(
            &Url::parse("https://tenant.example/v1/responses").unwrap()
        ));
        assert!(request_url_has_query(
            &Url::parse("https://tenant.example/v1/responses?debug=true").unwrap()
        ));
        assert!(request_url_has_query(
            &Url::parse("https://tenant.example/v1/responses?").unwrap()
        ));
    }
}
