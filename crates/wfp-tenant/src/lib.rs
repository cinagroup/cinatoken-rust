//! CinaToken Workers for Platforms tenant runtime.
//!
//! This crate is intentionally small: the main `cinatoken-worker` owns auth,
//! billing, audit logging, and tenant deployment. A WFP tenant Worker only
//! exposes a status smoke endpoint and forwards selected AI routes to
//! Cloudflare AI Gateway with tenant-scoped headers.

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
const AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV: &str = "AI_GATEWAY_ID_OPENAI_EMBEDDINGS";
const AI_GATEWAY_ID_AI_RUN_ENV: &str = "AI_GATEWAY_ID_AI_RUN";
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
        public_path: "/v1/embeddings",
        upstream_path: "/v1/embeddings",
        api_family: "openai_embeddings",
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
    "/v1/embeddings",
    "/ai/run",
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
    inbound_sensitive_headers_present: bool,
    inbound_sensitive_headers: Vec<String>,
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
    let default_ai_gateway_id_configured = runtime_value(env, AI_GATEWAY_ID_ENV).is_some();
    let route_gateways = route_gateway_statuses(env);
    let ai_gateway_id_configured = default_ai_gateway_id_configured
        || route_gateways
            .iter()
            .any(|route| route.gateway_id_configured);
    let inbound_sensitive_headers = inbound_sensitive_header_names(req.headers());
    let status = TenantStatus {
        service: SERVICE_NAME,
        runtime: "rust-wasm",
        tenant_id: runtime_value(env, "CINATOKEN_TENANT_ID")
            .unwrap_or_else(|| UNKNOWN_TENANT.to_string()),
        ai_gateway_id_configured,
        default_ai_gateway_id_configured,
        route_gateways,
        inbound_sensitive_headers_present: !inbound_sensitive_headers.is_empty(),
        inbound_sensitive_headers,
        forwarding: "cloudflare-ai-gateway-rest",
        body_mode: "streamed_request_body",
        routes: SUPPORTED_ROUTE_PATHS,
    };
    json_response(&status, 200)
}

async fn forward_ai_gateway(req: Request, env: Env, route: TenantRoute) -> WorkerResult<Response> {
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

    let target = ai_gateway_url(&account_id, route.upstream_path, req.url()?.query())?;
    let headers = upstream_headers(&req, &env, &api_token, route)?;
    let body = req.inner().body().map(JsValue::from);

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    if let Some(body) = body {
        init.with_body(Some(body));
    }
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

fn ai_gateway_url(account_id: &str, upstream_path: &str, query: Option<&str>) -> WorkerResult<Url> {
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
    let mut url = Url::parse(&format!(
        "{AI_GATEWAY_BASE}/accounts/{account_id}/ai{upstream_path}"
    ))
    .map_err(|err| worker::Error::RustError(format!("failed to build AI Gateway URL: {err}")))?;
    url.set_query(query);
    Ok(url)
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

fn tenant_response_headers(upstream: &Headers, env: &Env) -> WorkerResult<Headers> {
    let mut headers = safe_response_headers(upstream)?;
    headers.set("x-cinatoken-wfp-tenant", &tenant_id(env))?;
    headers.set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    Ok(headers)
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
        "openai_embeddings" => AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV,
        "ai_run" => AI_GATEWAY_ID_AI_RUN_ENV,
        _ => AI_GATEWAY_ID_ENV,
    }
}

fn select_gateway_id(route_specific: Option<String>, default: Option<String>) -> Option<String> {
    route_specific.or(default)
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
    SENSITIVE_INBOUND_HEADERS.contains(&name.as_str()) || name.starts_with("x-cinatoken-")
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
        assert_eq!(
            target_route("/v1/chat/completions").map(|route| route.upstream_path),
            Some("/v1/chat/completions")
        );
        assert_eq!(
            target_route("/v1/responses").map(|route| route.upstream_path),
            Some("/v1/responses")
        );
        assert_eq!(
            target_route("/v1/messages").map(|route| route.upstream_path),
            Some("/v1/messages")
        );
        assert_eq!(
            target_route("/v1/embeddings").map(|route| route.upstream_path),
            Some("/v1/embeddings")
        );
        assert_eq!(
            target_route("/ai/run").map(|route| route.upstream_path),
            Some("/run")
        );
        assert_eq!(target_route("/v1/models"), None);
    }

    #[test]
    fn status_route_manifest_includes_every_supported_route() {
        assert!(SUPPORTED_ROUTE_PATHS.contains(&STATUS_PATH));
        for route in SUPPORTED_ROUTES {
            assert!(
                SUPPORTED_ROUTE_PATHS.contains(&route.public_path),
                "status manifest missing {}",
                route.public_path
            );
        }
    }

    #[test]
    fn ai_gateway_url_preserves_query_and_rejects_bad_account_ids() {
        let url = ai_gateway_url("account123", "/v1/responses", Some("debug=true&x=1")).unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.cloudflare.com/client/v4/accounts/account123/ai/v1/responses?debug=true&x=1"
        );
        assert!(ai_gateway_url("bad/account", "/v1/responses", None).is_err());
        assert!(ai_gateway_url("", "/v1/responses", None).is_err());
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
            route_gateway_env_name(target_route("/v1/embeddings").unwrap()),
            AI_GATEWAY_ID_OPENAI_EMBEDDINGS_ENV
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
        ] {
            assert!(
                is_sensitive_inbound_header(header),
                "expected {header} to be reported by tenant status"
            );
        }

        for header in ["Content-Type", "Accept", "User-Agent", "Traceparent"] {
            assert!(
                !is_sensitive_inbound_header(header),
                "expected {header} to remain a normal forwarded header"
            );
        }
    }
}
