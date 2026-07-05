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

#[derive(Debug, Serialize)]
struct TenantStatus {
    service: &'static str,
    runtime: &'static str,
    tenant_id: String,
    ai_gateway_id_configured: bool,
    forwarding: &'static str,
    body_mode: &'static str,
    routes: &'static [&'static str],
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> WorkerResult<Response> {
    console_error_panic_hook::set_once();
    route(req, env).await
}

async fn route(req: Request, env: Env) -> WorkerResult<Response> {
    let path = req.path();
    if req.method() == Method::Get && path == STATUS_PATH {
        return tenant_status(&env);
    }

    let Some(upstream_path) = target_path(&path) else {
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

    forward_ai_gateway(req, env, upstream_path).await
}

fn tenant_status(env: &Env) -> WorkerResult<Response> {
    let status = TenantStatus {
        service: SERVICE_NAME,
        runtime: "rust-wasm",
        tenant_id: runtime_value(env, "CINATOKEN_TENANT_ID")
            .unwrap_or_else(|| "unknown".to_string()),
        ai_gateway_id_configured: runtime_value(env, "AI_GATEWAY_ID").is_some(),
        forwarding: "cloudflare-ai-gateway-rest",
        body_mode: "streamed_request_body",
        routes: &[
            STATUS_PATH,
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/embeddings",
            "/ai/run",
        ],
    };
    json_response(&status, 200)
}

async fn forward_ai_gateway(
    req: Request,
    env: Env,
    upstream_path: &'static str,
) -> WorkerResult<Response> {
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

    let target = ai_gateway_url(&account_id, upstream_path, req.url()?.query())?;
    let headers = upstream_headers(&req, &env, &api_token)?;
    let body = req.inner().body().map(JsValue::from);

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    if let Some(body) = body {
        init.with_body(Some(body));
    }
    let outbound = Request::new_with_init(target.as_str(), &init)?;
    let mut response = Fetch::Request(outbound).send().await?;
    response.headers_mut().set(
        "x-cinatoken-wfp-tenant",
        &runtime_value(&env, "CINATOKEN_TENANT_ID").unwrap_or_else(|| "unknown".to_string()),
    )?;
    response
        .headers_mut()
        .set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    Ok(response)
}

fn target_path(path: &str) -> Option<&'static str> {
    match path {
        "/v1/chat/completions" => Some("/v1/chat/completions"),
        "/v1/responses" => Some("/v1/responses"),
        "/v1/embeddings" => Some("/v1/embeddings"),
        "/ai/run" => Some("/run"),
        _ => None,
    }
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

fn upstream_headers(req: &Request, env: &Env, api_token: &str) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    copy_header(req, &mut headers, "content-type")?;
    copy_header(req, &mut headers, "accept")?;
    headers.set("authorization", &format!("Bearer {api_token}"))?;
    if let Some(gateway_id) = runtime_value(env, "AI_GATEWAY_ID") {
        headers.set("cf-aig-gateway-id", &gateway_id)?;
    }
    headers.set(
        "x-cinatoken-tenant",
        &runtime_value(env, "CINATOKEN_TENANT_ID").unwrap_or_else(|| "unknown".to_string()),
    )?;
    headers.set("x-cinatoken-wfp-runtime", "rust-wasm")?;
    Ok(headers)
}

fn copy_header(req: &Request, output: &mut Headers, name: &str) -> WorkerResult<()> {
    if let Some(value) = req.headers().get(name)? {
        output.set(name, &value)?;
    }
    Ok(())
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
            target_path("/v1/chat/completions"),
            Some("/v1/chat/completions")
        );
        assert_eq!(target_path("/v1/responses"), Some("/v1/responses"));
        assert_eq!(target_path("/v1/embeddings"), Some("/v1/embeddings"));
        assert_eq!(target_path("/ai/run"), Some("/run"));
        assert_eq!(target_path("/v1/models"), None);
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
}
