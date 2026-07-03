//! Admin Ollama model-management routes.
//!
//! Go assumes the API server can reach a local Ollama daemon. On Workers the
//! channel must point at an HTTPS endpoint, for example a Cloudflare Tunnel,
//! Container-fronted service, or another approved gateway. The pull endpoint
//! streams upstream NDJSON as browser-facing SSE without buffering the model
//! download progress in memory.

use futures_util::future::{select, Either};
use futures_util::Stream;
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use worker::{
    AbortController, ByteStream, Delay, Env, Fetch, Headers, Method, Request, RequestInit,
    RequestRedirect, Response, Result as WorkerResult,
};

use crate::admin::{
    admin_audit_info, envelope_error_response, envelope_ok_response, read_json_body,
    require_admin_auth, unix_timestamp,
};
use crate::d1_repositories::{self, ChannelRow};
use crate::set_cors_headers;

const CHANNEL_TYPE_OLLAMA: i32 = 4;
const OLLAMA_JSON_TIMEOUT: Duration = Duration::from_secs(15);
const OLLAMA_PULL_START_TIMEOUT: Duration = Duration::from_secs(20);
const OLLAMA_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const OLLAMA_STREAM_LINE_LIMIT_BYTES: usize = 1024 * 1024;
const OLLAMA_MODEL_NAME_MAX_BYTES: usize = 1024;

#[derive(Debug, Deserialize)]
struct OllamaModelRequest {
    channel_id: i64,
    model_name: String,
}

#[derive(Debug)]
pub(crate) enum OllamaAdminError {
    BadRequest(String),
    Unsupported(String),
    Upstream(String),
    Timeout(String),
}

impl OllamaAdminError {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            Self::Unsupported(_) => 422,
            Self::Timeout(_) => 504,
            Self::Upstream(_) => 502,
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            Self::BadRequest(message)
            | Self::Unsupported(message)
            | Self::Upstream(message)
            | Self::Timeout(message) => message,
        }
    }

    fn into_response(self) -> Response {
        envelope_error_response(self.status_code(), self.message())
    }
}

pub async fn version(req: Request, env: Env, id_param: Option<&String>) -> WorkerResult<Response> {
    if let Err(response) = require_admin_auth(&req, &env).await? {
        return Ok(response);
    }
    let Some(id) = parse_id_param(id_param) else {
        return Ok(envelope_error_response(400, "invalid channel id"));
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    match fetch_ollama_version_for_channel(&channel).await {
        Ok(version) => envelope_ok_response(&serde_json::json!({ "version": version })),
        Err(error) => Ok(error.into_response()),
    }
}

pub async fn delete_model(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_model_request(&mut req).await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, payload.channel_id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    if let Err(error) = ensure_ollama_channel(&channel) {
        return Ok(error.into_response());
    }
    match delete_ollama_model_for_channel(&channel, &payload.model_name).await {
        Ok(()) => {
            let now = unix_timestamp();
            let _ = d1_repositories::insert_admin_audit_log(
                &db,
                None,
                None,
                &claims.username,
                "channel.ollama_delete_model",
                &format!(
                    "admin {} deleted Ollama model {} from channel {}",
                    claims.username, payload.model_name, channel.id
                ),
                &serde_json::json!({
                    "id": channel.id,
                    "model": payload.model_name,
                    "type": channel.kind
                }),
                &admin_audit_info(&claims, &req),
                now,
            )
            .await;
            envelope_ok_response(&Value::Null)
        }
        Err(error) => Ok(error.into_response()),
    }
}

pub async fn pull_model_stream(mut req: Request, env: Env) -> WorkerResult<Response> {
    let claims = match require_admin_auth(&req, &env).await? {
        Ok(claims) => claims,
        Err(response) => return Ok(response),
    };
    let payload = match read_model_request(&mut req).await {
        Ok(payload) => payload,
        Err(response) => return Ok(response),
    };
    let db = env.d1("DB")?;
    let Some(channel) = d1_repositories::find_channel_by_id(&db, payload.channel_id).await? else {
        return Ok(envelope_error_response(404, "channel not found"));
    };
    if let Err(error) = ensure_ollama_channel(&channel) {
        return Ok(error.into_response());
    }

    let mut upstream =
        match start_ollama_pull_stream_for_channel(&channel, &payload.model_name).await {
            Ok(response) => response,
            Err(error) => return sse_error_response(error.message()),
        };
    let now = unix_timestamp();
    let _ = d1_repositories::insert_admin_audit_log(
        &db,
        None,
        None,
        &claims.username,
        "channel.ollama_pull_model",
        &format!(
            "admin {} started Ollama model pull {} on channel {}",
            claims.username, payload.model_name, channel.id
        ),
        &serde_json::json!({
            "id": channel.id,
            "model": payload.model_name,
            "type": channel.kind
        }),
        &admin_audit_info(&claims, &req),
        now,
    )
    .await;

    let stream = upstream.stream()?;
    sse_stream_response(OllamaPullSseStream::new(stream, payload.model_name))
}

pub(crate) async fn fetch_ollama_model_names_for_channel(
    channel: &ChannelRow,
) -> Result<Vec<String>, OllamaAdminError> {
    ensure_ollama_channel(channel)?;
    fetch_ollama_model_names(&channel.base_url, first_key_line(&channel.key)).await
}

pub(crate) async fn fetch_ollama_model_names(
    base_url: &str,
    key: &str,
) -> Result<Vec<String>, OllamaAdminError> {
    let url = ollama_url(base_url, "/api/tags")?;
    let response = send_ollama_request(&url, key, Method::Get, None, OLLAMA_JSON_TIMEOUT).await?;
    let value = read_bounded_json_response(response, "Ollama tags").await?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            OllamaAdminError::Upstream(
                "Ollama tags response does not contain a models array".to_string(),
            )
        })?;
    let mut names = Vec::new();
    for model in models {
        if let Some(name) = model.get("name").and_then(Value::as_str).map(str::trim) {
            if !name.is_empty() && !names.iter().any(|existing: &String| existing == name) {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}

async fn fetch_ollama_version_for_channel(
    channel: &ChannelRow,
) -> Result<String, OllamaAdminError> {
    ensure_ollama_channel(channel)?;
    let url = ollama_url(&channel.base_url, "/api/version")?;
    let response = send_ollama_request(
        &url,
        first_key_line(&channel.key),
        Method::Get,
        None,
        OLLAMA_JSON_TIMEOUT,
    )
    .await?;
    let value = read_bounded_json_response(response, "Ollama version").await?;
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| {
            OllamaAdminError::Upstream("Ollama version response is incomplete".to_string())
        })?;
    Ok(version.to_string())
}

async fn delete_ollama_model_for_channel(
    channel: &ChannelRow,
    model_name: &str,
) -> Result<(), OllamaAdminError> {
    let url = ollama_url(&channel.base_url, "/api/delete")?;
    let body = serde_json::json!({ "name": model_name }).to_string();
    send_ollama_request(
        &url,
        first_key_line(&channel.key),
        Method::Delete,
        Some(body),
        OLLAMA_JSON_TIMEOUT,
    )
    .await?;
    Ok(())
}

async fn start_ollama_pull_stream_for_channel(
    channel: &ChannelRow,
    model_name: &str,
) -> Result<Response, OllamaAdminError> {
    let url = ollama_url(&channel.base_url, "/api/pull")?;
    let body = serde_json::json!({
        "name": model_name,
        "stream": true
    })
    .to_string();
    send_ollama_request(
        &url,
        first_key_line(&channel.key),
        Method::Post,
        Some(body),
        OLLAMA_PULL_START_TIMEOUT,
    )
    .await
}

async fn send_ollama_request(
    url: &str,
    key: &str,
    method: Method,
    body: Option<String>,
    timeout: Duration,
) -> Result<Response, OllamaAdminError> {
    validate_ollama_url(url)?;
    let mut headers = Headers::new();
    headers
        .set("Accept", "application/json")
        .map_err(|_| OllamaAdminError::BadRequest("invalid Ollama request header".to_string()))?;
    if body.is_some() {
        headers
            .set("Content-Type", "application/json")
            .map_err(|_| {
                OllamaAdminError::BadRequest("invalid Ollama request header".to_string())
            })?;
    }
    let key = key.trim();
    if !key.is_empty() {
        headers
            .set("Authorization", &format!("Bearer {key}"))
            .map_err(|_| {
                OllamaAdminError::BadRequest("Ollama key is not valid for HTTP headers".to_string())
            })?;
    }
    let mut init = RequestInit::new();
    init.with_method(method)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Error);
    if let Some(body) = body {
        init.with_body(Some(body.into()));
    }
    let request = Request::new_with_init(url, &init)
        .map_err(|_| OllamaAdminError::BadRequest("failed to build Ollama request".to_string()))?;
    let controller = AbortController::default();
    let signal = controller.signal();
    let outbound = Fetch::Request(request);
    let fetch = outbound.send_with_signal(&signal);
    let delay = Delay::from(timeout);
    futures_util::pin_mut!(fetch);
    futures_util::pin_mut!(delay);
    let mut response = match select(fetch, delay).await {
        Either::Left((result, _)) => {
            result.map_err(|_| OllamaAdminError::Upstream("Ollama request failed".to_string()))?
        }
        Either::Right(((), _)) => {
            controller.abort();
            return Err(OllamaAdminError::Timeout(
                "Ollama request timed out".to_string(),
            ));
        }
    };
    if !(200..300).contains(&response.status_code()) {
        let status = response.status_code();
        let detail = read_bounded_text_response(&mut response).await;
        return Err(OllamaAdminError::Upstream(format!(
            "Ollama upstream status {status}: {detail}"
        )));
    }
    Ok(response)
}

async fn read_bounded_json_response(
    mut response: Response,
    label: &str,
) -> Result<Value, OllamaAdminError> {
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(|_| {
            OllamaAdminError::Upstream(format!("failed to inspect {label} response headers"))
        })?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("application/json")
        && !content_type.contains("+json")
    {
        return Err(OllamaAdminError::Upstream(format!(
            "{label} response is not JSON"
        )));
    }
    let bytes = read_bounded_response_bytes(&mut response).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| OllamaAdminError::Upstream(format!("{label} response is not valid JSON")))
}

async fn read_bounded_text_response(response: &mut Response) -> String {
    match read_bounded_response_bytes(response).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).chars().take(300).collect(),
        Err(error) => error.message().to_string(),
    }
}

async fn read_bounded_response_bytes(response: &mut Response) -> Result<Vec<u8>, OllamaAdminError> {
    if response
        .headers()
        .get("Content-Length")
        .map_err(|_| {
            OllamaAdminError::Upstream("failed to inspect Ollama response headers".to_string())
        })?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > OLLAMA_BODY_LIMIT_BYTES)
    {
        return Err(OllamaAdminError::Upstream(
            "Ollama response exceeds 1 MiB limit".to_string(),
        ));
    }
    response
        .stream()
        .map_err(|_| OllamaAdminError::Upstream("failed to read Ollama response".to_string()))?
        .try_fold(Vec::new(), |mut bytes, chunk| async move {
            if bytes.len().saturating_add(chunk.len()) > OLLAMA_BODY_LIMIT_BYTES {
                return Err(worker::Error::RustError(
                    "Ollama response exceeds 1 MiB limit".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            Ok(bytes)
        })
        .await
        .map_err(|error| OllamaAdminError::Upstream(error.to_string()))
}

fn sse_stream_response<S>(stream: S) -> WorkerResult<Response>
where
    S: futures_util::TryStream + 'static,
    S::Ok: Into<Vec<u8>>,
    S::Error: Into<worker::Error>,
{
    let mut response = Response::from_stream(stream)?.with_status(200);
    response
        .headers_mut()
        .set("Content-Type", "text/event-stream")?;
    response.headers_mut().set("Cache-Control", "no-cache")?;
    response.headers_mut().set("X-Accel-Buffering", "no")?;
    set_cors_headers(&mut response)?;
    Ok(response)
}

fn sse_error_response(message: &str) -> WorkerResult<Response> {
    let stream = futures_util::stream::iter(
        sse_error_chunks(message)
            .into_iter()
            .map(Ok::<Vec<u8>, worker::Error>),
    );
    sse_stream_response(stream)
}

fn sse_error_chunks(message: &str) -> Vec<Vec<u8>> {
    let body = serde_json::json!({ "error": message });
    let line =
        serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"Ollama error\"}".to_vec());
    vec![sse_event_bytes(&line), sse_done_bytes()]
}

async fn read_model_request(req: &mut Request) -> Result<OllamaModelRequest, Response> {
    let body = read_json_body(req).await?;
    let payload: OllamaModelRequest = serde_json::from_value(body)
        .map_err(|_| envelope_error_response(400, "invalid Ollama model request"))?;
    if payload.channel_id <= 0 || payload.channel_id > i32::MAX as i64 {
        return Err(envelope_error_response(400, "invalid channel id"));
    }
    let model_name = payload.model_name.trim();
    if model_name.is_empty() {
        return Err(envelope_error_response(400, "model name is required"));
    }
    if model_name.len() > OLLAMA_MODEL_NAME_MAX_BYTES {
        return Err(envelope_error_response(400, "model name is too long"));
    }
    Ok(OllamaModelRequest {
        channel_id: payload.channel_id,
        model_name: model_name.to_string(),
    })
}

fn ensure_ollama_channel(channel: &ChannelRow) -> Result<(), OllamaAdminError> {
    if channel.kind != CHANNEL_TYPE_OLLAMA {
        return Err(OllamaAdminError::BadRequest(
            "This operation is only supported for Ollama channels".to_string(),
        ));
    }
    if channel.base_url.trim().is_empty() {
        return Err(OllamaAdminError::Unsupported(
            "Ollama channel requires an HTTPS base_url reachable from Cloudflare".to_string(),
        ));
    }
    Ok(())
}

fn ollama_url(base_url: &str, suffix: &str) -> Result<String, OllamaAdminError> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err(OllamaAdminError::Unsupported(
            "Ollama base_url is required".to_string(),
        ));
    }
    let raw = format!("{}{}", base_url.trim_end_matches('/'), suffix);
    validate_ollama_url(&raw)?;
    Ok(raw)
}

fn validate_ollama_url(raw: &str) -> Result<(), OllamaAdminError> {
    let parsed = worker::Url::parse(raw)
        .map_err(|_| OllamaAdminError::BadRequest("Ollama URL is invalid".to_string()))?;
    if parsed.scheme() != "https" {
        return Err(OllamaAdminError::Unsupported(
            "Ollama management requires an HTTPS base_url".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(OllamaAdminError::BadRequest(
            "Ollama URL must not contain credentials".to_string(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(OllamaAdminError::BadRequest(
            "Ollama URL must not contain a fragment".to_string(),
        ));
    }
    if parsed.port_or_known_default() != Some(443) {
        return Err(OllamaAdminError::Unsupported(
            "Ollama URL port is not allowed".to_string(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| OllamaAdminError::BadRequest("Ollama URL is missing a host".to_string()))?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "localhost" | "metadata.google.internal" | "metadata.internal"
    ) || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(OllamaAdminError::Unsupported(
            "Ollama URL host is not allowed".to_string(),
        ));
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err(OllamaAdminError::Unsupported(
            "literal IP Ollama URLs are not allowed".to_string(),
        ));
    }
    Ok(())
}

fn first_key_line(key: &str) -> &str {
    key.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn parse_id_param(id_param: Option<&String>) -> Option<i64> {
    id_param
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|id| *id > 0 && *id <= i32::MAX as i64)
}

struct OllamaPullSseStream {
    inner: Pin<Box<dyn Stream<Item = WorkerResult<Vec<u8>>>>>,
    buffer: Vec<u8>,
    pending: VecDeque<Vec<u8>>,
    model_name: String,
    saw_success: bool,
    saw_error: bool,
    finished: bool,
}

impl OllamaPullSseStream {
    fn new(inner: ByteStream, model_name: String) -> Self {
        Self {
            inner: Box::pin(inner),
            buffer: Vec::new(),
            pending: VecDeque::new(),
            model_name,
            saw_success: false,
            saw_error: false,
            finished: false,
        }
    }

    fn queue_chunk(&mut self, chunk: &[u8]) {
        if self.finished {
            return;
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > OLLAMA_STREAM_LINE_LIMIT_BYTES {
            self.queue_error("Ollama pull stream line exceeds 1 MiB limit");
            return;
        }
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=position).collect::<Vec<u8>>();
            trim_line_end(&mut line);
            self.queue_line(line);
        }
    }

    fn queue_line(&mut self, line: Vec<u8>) {
        if line.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        match observe_pull_line(&line) {
            PullLineStatus::Success => self.saw_success = true,
            PullLineStatus::Error => self.saw_error = true,
            PullLineStatus::Other => {}
        }
        self.pending.push_back(sse_event_bytes(&line));
    }

    fn queue_error(&mut self, message: &str) {
        let line = serde_json::to_vec(&serde_json::json!({ "error": message }))
            .unwrap_or_else(|_| b"{\"error\":\"Ollama error\"}".to_vec());
        self.pending.push_back(sse_event_bytes(&line));
        self.pending.push_back(sse_done_bytes());
        self.finished = true;
        self.buffer.clear();
    }

    fn queue_finish(&mut self) {
        if self.finished {
            return;
        }
        if !self.buffer.iter().all(u8::is_ascii_whitespace) {
            let mut line = std::mem::take(&mut self.buffer);
            trim_line_end(&mut line);
            self.queue_line(line);
        }
        if self.saw_error {
            let message = format!("Model {} pull failed", self.model_name);
            let line = serde_json::to_vec(&serde_json::json!({ "error": message }))
                .unwrap_or_else(|_| b"{\"error\":\"Ollama pull failed\"}".to_vec());
            self.pending.push_back(sse_event_bytes(&line));
        } else if self.saw_success {
            let message = format!("Model {} pulled successfully", self.model_name);
            let line = serde_json::to_vec(&serde_json::json!({ "message": message }))
                .unwrap_or_else(|_| b"{\"message\":\"Ollama model pulled successfully\"}".to_vec());
            self.pending.push_back(sse_event_bytes(&line));
        } else {
            let line = serde_json::to_vec(
                &serde_json::json!({ "error": "Ollama pull did not report success" }),
            )
            .unwrap_or_else(|_| b"{\"error\":\"Ollama pull did not report success\"}".to_vec());
            self.pending.push_back(sse_event_bytes(&line));
        }
        self.pending.push_back(sse_done_bytes());
        self.finished = true;
    }
}

impl Stream for OllamaPullSseStream {
    type Item = WorkerResult<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(chunk) = self.pending.pop_front() {
            return Poll::Ready(Some(Ok(chunk)));
        }
        if self.finished {
            return Poll::Ready(None);
        }
        loop {
            match self.inner.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(chunk))) => {
                    self.queue_chunk(&chunk);
                    if let Some(next) = self.pending.pop_front() {
                        return Poll::Ready(Some(Ok(next)));
                    }
                    if self.finished {
                        return Poll::Ready(None);
                    }
                }
                Poll::Ready(Some(Err(error))) => {
                    self.queue_error(&format!("Ollama pull stream failed: {error}"));
                    return Poll::Ready(self.pending.pop_front().map(Ok));
                }
                Poll::Ready(None) => {
                    self.queue_finish();
                    return Poll::Ready(self.pending.pop_front().map(Ok));
                }
            }
        }
    }
}

impl Unpin for OllamaPullSseStream {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PullLineStatus {
    Success,
    Error,
    Other,
}

fn observe_pull_line(line: &[u8]) -> PullLineStatus {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return PullLineStatus::Other;
    };
    if value.get("error").is_some() {
        return PullLineStatus::Error;
    }
    match value.get("status").and_then(Value::as_str) {
        Some(status) if status.eq_ignore_ascii_case("success") => PullLineStatus::Success,
        Some(status) if status.eq_ignore_ascii_case("error") => PullLineStatus::Error,
        _ => PullLineStatus::Other,
    }
}

fn sse_event_bytes(line: &[u8]) -> Vec<u8> {
    let mut event = Vec::with_capacity(line.len() + 8);
    event.extend_from_slice(b"data: ");
    event.extend_from_slice(line);
    event.extend_from_slice(b"\n\n");
    event
}

fn sse_done_bytes() -> Vec<u8> {
    b"data: [DONE]\n\n".to_vec()
}

fn trim_line_end(line: &mut Vec<u8>) {
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_ollama_url_requires_cloudflare_reachable_https() {
        assert!(validate_ollama_url("https://ollama.example.com/api/tags").is_ok());
        assert!(matches!(
            validate_ollama_url("http://localhost:11434/api/tags"),
            Err(OllamaAdminError::Unsupported(_))
        ));
        assert!(matches!(
            validate_ollama_url("https://127.0.0.1/api/tags"),
            Err(OllamaAdminError::Unsupported(_))
        ));
        assert!(matches!(
            validate_ollama_url("https://ollama.example.com:11434/api/tags"),
            Err(OllamaAdminError::Unsupported(_))
        ));
    }

    #[test]
    fn sse_event_wraps_ollama_json_lines() {
        assert_eq!(
            sse_event_bytes(br#"{"status":"pulling manifest"}"#),
            br#"data: {"status":"pulling manifest"}

"#
            .to_vec()
        );
    }

    #[test]
    fn sse_error_chunks_emit_error_then_done() {
        let chunks = sse_error_chunks("boom");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], b"data: {\"error\":\"boom\"}\n\n".to_vec());
        assert_eq!(chunks[1], b"data: [DONE]\n\n".to_vec());
    }

    #[test]
    fn observe_pull_line_tracks_success_and_error_statuses() {
        assert_eq!(
            observe_pull_line(br#"{"status":"success"}"#),
            PullLineStatus::Success
        );
        assert_eq!(
            observe_pull_line(br#"{"status":"error"}"#),
            PullLineStatus::Error
        );
        assert_eq!(
            observe_pull_line(br#"{"error":"failed"}"#),
            PullLineStatus::Error
        );
        assert_eq!(
            observe_pull_line(br#"{"status":"downloading"}"#),
            PullLineStatus::Other
        );
    }

    #[test]
    fn trim_line_end_removes_crlf_only() {
        let mut line = b"{\"status\":\"success\"}\r\n".to_vec();
        trim_line_end(&mut line);
        assert_eq!(line, br#"{"status":"success"}"#);
    }
}
