//! Workers for Platforms outbound egress policy.
//!
//! Tenant Workers never receive the Cloudflare AI Gateway bearer. This Worker
//! admits only the four reviewed Cloudflare AI REST routes, injects its own
//! least-privilege secret, and returns a bounded public response-header set.

use futures_util::StreamExt;
use serde_json::json;
use url::Url;
use wasm_bindgen::JsValue;
use worker::{
    event, Context, Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response,
    Result as WorkerResult,
};

const CLOUDFLARE_AI_HOST: &str = "api.cloudflare.com";
const ACCOUNT_ID_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const OUTBOUND_TOKEN_ENV: &str = "CINATOKEN_WFP_OUTBOUND_AI_TOKEN";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const ALLOWED_AI_PATHS: &[&str] = &[
    "/ai/run",
    "/ai/v1/chat/completions",
    "/ai/v1/responses",
    "/ai/v1/messages",
];
const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "cf-aig-gateway-id",
    "cf-aig-request-timeout",
    "cf-aig-max-attempts",
    "cf-aig-retry-delay",
    "cf-aig-backoff",
    "cf-aig-cache-ttl",
    "cf-aig-skip-cache",
    "cf-aig-collect-log",
    "cf-aig-metadata",
    "x-cinatoken-tenant",
    "x-cinatoken-wfp-runtime",
];
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EgressPolicyError {
    Method,
    Scheme,
    Host,
    Credentials,
    Query,
    Account,
    Route,
    ContentType,
    BodyTooLarge,
    BodyRead,
    InvalidJson,
}

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> WorkerResult<Response> {
    console_error_panic_hook::set_once();

    let account_id = env
        .var(ACCOUNT_ID_ENV)
        .map(|value| value.to_string())
        .unwrap_or_default();
    let url = req.url()?;
    if let Err(error) = validate_egress_request(
        req.method(),
        &url,
        &account_id,
        req.headers().get("content-type")?.as_deref(),
        req.headers().get("content-length")?.as_deref(),
    ) {
        return policy_error_response(error);
    }

    let body = match read_bounded_json_body(&mut req).await {
        Ok(body) => body,
        Err(error) => return policy_error_response(error),
    };

    let token = match env.secret(OUTBOUND_TOKEN_ENV) {
        Ok(value) if !value.to_string().trim().is_empty() => value,
        _ => {
            return json_error(
                503,
                "wfp_outbound_auth_unavailable",
                "outbound authentication is unavailable",
            )
        }
    };
    let headers = outbound_headers(req.headers(), token.to_string().as_str())?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error)
        .with_body(Some(JsValue::from(js_sys::Uint8Array::from(
            body.as_slice(),
        ))));
    let outbound = Request::new_with_init(url.as_str(), &init)?;
    let mut upstream = match Fetch::Request(outbound).send().await {
        Ok(response) => response,
        Err(_) => {
            return json_error(
                502,
                "wfp_outbound_fetch_failed",
                "outbound AI Gateway request failed",
            )
        }
    };
    let status = upstream.status_code();
    let response_headers = public_response_headers(upstream.headers())?;
    Ok(Response::from_stream(upstream.stream()?)?
        .with_status(status)
        .with_headers(response_headers))
}

fn validate_egress_request(
    method: Method,
    url: &Url,
    account_id: &str,
    content_type: Option<&str>,
    content_length: Option<&str>,
) -> Result<(), EgressPolicyError> {
    if method != Method::Post {
        return Err(EgressPolicyError::Method);
    }
    if url.scheme() != "https" {
        return Err(EgressPolicyError::Scheme);
    }
    if url.host_str() != Some(CLOUDFLARE_AI_HOST) || url.port().is_some() {
        return Err(EgressPolicyError::Host);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(EgressPolicyError::Credentials);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(EgressPolicyError::Query);
    }
    let account_id = account_id.trim();
    if !valid_account_id(account_id) {
        return Err(EgressPolicyError::Account);
    }
    let prefix = format!("/client/v4/accounts/{account_id}");
    let Some(suffix) = url.path().strip_prefix(&prefix) else {
        return Err(EgressPolicyError::Account);
    };
    if !ALLOWED_AI_PATHS.contains(&suffix) {
        return Err(EgressPolicyError::Route);
    }
    if !content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(EgressPolicyError::ContentType);
    }
    if content_length
        .and_then(|value| value.trim().parse::<usize>().ok())
        .is_some_and(|value| value > MAX_BODY_BYTES)
    {
        return Err(EgressPolicyError::BodyTooLarge);
    }
    Ok(())
}

fn valid_account_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn read_bounded_json_body(req: &mut Request) -> Result<Vec<u8>, EgressPolicyError> {
    let mut stream = req.stream().map_err(|_| EgressPolicyError::BodyRead)?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| EgressPolicyError::BodyRead)?;
        append_bounded_chunk(&mut body, &chunk, MAX_BODY_BYTES)?;
    }
    serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|_| EgressPolicyError::InvalidJson)?;
    Ok(body)
}

fn append_bounded_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    limit: usize,
) -> Result<(), EgressPolicyError> {
    if body.len().saturating_add(chunk.len()) > limit {
        return Err(EgressPolicyError::BodyTooLarge);
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn outbound_headers(input: &Headers, token: &str) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = input.get(name)? {
            headers.set(name, &value)?;
        }
    }
    headers.set("authorization", &format!("Bearer {}", token.trim()))?;
    Ok(headers)
}

fn public_response_headers(input: &Headers) -> WorkerResult<Headers> {
    let mut headers = Headers::new();
    for name in FORWARDED_RESPONSE_HEADERS {
        if let Some(value) = input.get(name)? {
            headers.set(name, &value)?;
        }
    }
    Ok(headers)
}

fn policy_error_response(error: EgressPolicyError) -> WorkerResult<Response> {
    let (status, code, message) = match error {
        EgressPolicyError::Method => (
            405,
            "wfp_outbound_method_denied",
            "outbound route requires POST",
        ),
        EgressPolicyError::BodyTooLarge => (
            413,
            "wfp_outbound_body_too_large",
            "outbound request body exceeds 4 MiB",
        ),
        EgressPolicyError::ContentType => (
            415,
            "wfp_outbound_content_type_denied",
            "outbound request must be JSON",
        ),
        EgressPolicyError::BodyRead => (
            400,
            "wfp_outbound_body_unreadable",
            "outbound request body could not be read",
        ),
        EgressPolicyError::InvalidJson => (
            400,
            "wfp_outbound_invalid_json",
            "outbound request body must be valid JSON",
        ),
        _ => (
            403,
            "wfp_outbound_target_denied",
            "outbound target is not allowed",
        ),
    };
    json_error(status, code, message)
}

fn json_error(status: u16, code: &str, message: &str) -> WorkerResult<Response> {
    Response::from_json(&json!({
        "success": false,
        "error": { "type": "platform_egress_error", "code": code, "message": message }
    }))
    .map(|response| {
        response
            .with_status(status)
            .with_headers(no_store_headers())
    })
}

fn no_store_headers() -> Headers {
    let mut headers = Headers::new();
    let _ = headers.set("cache-control", "no-store");
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    fn url(path: &str) -> Url {
        Url::parse(&format!(
            "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}{path}"
        ))
        .unwrap()
    }

    #[test]
    fn allows_only_reviewed_cloudflare_ai_rest_routes() {
        for path in ALLOWED_AI_PATHS {
            assert_eq!(
                validate_egress_request(
                    Method::Post,
                    &url(path),
                    ACCOUNT,
                    Some("application/json; charset=utf-8"),
                    Some("1024")
                ),
                Ok(())
            );
        }
    }

    #[test]
    fn rejects_cross_account_hosts_queries_methods_and_unreviewed_routes() {
        let wrong_account = url("/ai/v1/chat/completions");
        assert_eq!(
            validate_egress_request(
                Method::Post,
                &wrong_account,
                "ffffffffffffffffffffffffffffffff",
                Some("application/json"),
                None
            ),
            Err(EgressPolicyError::Account)
        );
        let mut query = url("/ai/v1/chat/completions");
        query.set_query(Some("debug=1"));
        assert_eq!(
            validate_egress_request(
                Method::Post,
                &query,
                ACCOUNT,
                Some("application/json"),
                None
            ),
            Err(EgressPolicyError::Query)
        );
        assert_eq!(
            validate_egress_request(
                Method::Get,
                &url("/ai/v1/chat/completions"),
                ACCOUNT,
                Some("application/json"),
                None
            ),
            Err(EgressPolicyError::Method)
        );
        assert_eq!(
            validate_egress_request(
                Method::Post,
                &url("/workers/scripts"),
                ACCOUNT,
                Some("application/json"),
                None
            ),
            Err(EgressPolicyError::Route)
        );
    }

    #[test]
    fn rejects_non_json_and_oversized_requests() {
        assert_eq!(
            validate_egress_request(
                Method::Post,
                &url("/ai/run"),
                ACCOUNT,
                Some("text/plain"),
                None
            ),
            Err(EgressPolicyError::ContentType)
        );
        assert_eq!(
            validate_egress_request(
                Method::Post,
                &url("/ai/run"),
                ACCOUNT,
                Some("application/json"),
                Some("4194305")
            ),
            Err(EgressPolicyError::BodyTooLarge)
        );

        let mut body = b"123".to_vec();
        assert_eq!(append_bounded_chunk(&mut body, b"45", 5), Ok(()));
        assert_eq!(body, b"12345");
        assert_eq!(
            append_bounded_chunk(&mut body, b"6", 5),
            Err(EgressPolicyError::BodyTooLarge)
        );
    }

    #[test]
    fn account_ids_and_header_sets_are_narrow() {
        assert!(valid_account_id(ACCOUNT));
        assert!(!valid_account_id("tenant-name"));
        assert!(FORWARDED_REQUEST_HEADERS.contains(&"cf-aig-metadata"));
        assert!(!FORWARDED_REQUEST_HEADERS.contains(&"authorization"));
        assert!(!FORWARDED_REQUEST_HEADERS.contains(&"cookie"));
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"set-cookie"));
        assert!(!FORWARDED_RESPONSE_HEADERS.contains(&"cf-aig-log-id"));
    }
}
