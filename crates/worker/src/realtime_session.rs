//! Durable Object foundation for realtime/session-heavy relay flows.
//!
//! The current relay does not yet implement full OpenAI Realtime protocol
//! parity. This object establishes the Cloudflare-native stateful WebSocket
//! substrate: hibernatable accepts through `State::accept_web_socket`, socket
//! attachments for resume metadata, and a tiny control protocol for smoke
//! testing.

use cinatoken_relay::token_fingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::{
    durable_object, Env, Method, Request, Response, Result as WorkerResult, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair,
};

use crate::platform_gateway::env_flag;

pub const REALTIME_SESSIONS_BINDING: &str = "REALTIME_SESSIONS";
pub const REALTIME_SESSION_GATEWAY_ENABLED_ENV: &str = "REALTIME_SESSION_GATEWAY_ENABLED";
pub const REALTIME_SESSION_V1_ENABLED_ENV: &str = "REALTIME_SESSION_V1_ENABLED";
pub const REALTIME_SESSION_GATEWAY_PREFIX: &str = "/api/platform/realtime/";
pub const REALTIME_OPENAI_PATH: &str = "/v1/realtime";
pub const REALTIME_SESSION_CUTOVER_GUARDS: &[&str] = &[
    "platform_gateway_gate",
    "v1_gateway_gate",
    "relay_token_auth",
    "relay_rate_limits",
    "hibernation_attachment_restore",
    "metadata_only_control_frames",
    "upstream_bridge",
    "billing_settlement",
];

const SESSION_TAG_PREFIX: &str = "session:";
const OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX: &str = "openai-insecure-api-key.";
const SESSION_METRICS_KEY: &str = "session_metrics_v1";
const MAX_STORED_TEXT_CHARS: usize = 160;
const MAX_PROTOCOL_TOKEN_CHARS: usize = 96;
const SESSION_HASH_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const SESSION_HASH_PRIME: u64 = 0x0000_0100_0000_01b3;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SocketAttachment {
    session: String,
    connected_at_ms: f64,
    protocol: Option<String>,
    entrypoint: String,
    model: Option<String>,
    token_source: Option<String>,
    token_fingerprint: Option<String>,
    auth_state: String,
}

#[derive(Debug, Serialize)]
struct RealtimeSessionStatus {
    session: String,
    active_websockets: usize,
    restored_attachments: usize,
    hibernation: bool,
    observability: &'static str,
    metrics: RealtimeSessionMetrics,
    attachments: Vec<RealtimeSocketSummary>,
}

#[derive(Debug, Serialize)]
struct RealtimeSocketSummary {
    session: String,
    entrypoint: String,
    model: Option<String>,
    token_source: Option<String>,
    token_fingerprint: Option<String>,
    auth_state: String,
    connected_at_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RealtimeApiKey {
    value: String,
    source: &'static str,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RealtimeTextControlSummary {
    text_chars: usize,
    text_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RealtimeSessionMetrics {
    session: String,
    created_at_ms: f64,
    updated_at_ms: f64,
    connected_count: u32,
    text_message_count: u32,
    binary_message_count: u32,
    closed_count: u32,
    error_count: u32,
    last_connected_at_ms: Option<f64>,
    last_message_at_ms: Option<f64>,
    last_closed_at_ms: Option<f64>,
    last_error_at_ms: Option<f64>,
    last_entrypoint: Option<String>,
    last_model: Option<String>,
    last_token_source: Option<String>,
    last_token_fingerprint: Option<String>,
    last_auth_state: Option<String>,
    last_close_code: Option<usize>,
    last_close_reason: Option<String>,
    last_error: Option<String>,
}

#[durable_object]
pub struct RealtimeSession {
    state: State,
}

#[durable_object]
impl DurableObject for RealtimeSession {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        let session = session_from_request(&req).unwrap_or_else(|| self.state.id().to_string());
        if wants_websocket(&req) {
            return self.accept_websocket(req, session).await;
        }

        let sockets = self.state.get_websockets();
        let attachments = sockets
            .iter()
            .filter_map(|ws| {
                ws.deserialize_attachment::<SocketAttachment>()
                    .ok()
                    .flatten()
            })
            .map(|attachment| RealtimeSocketSummary {
                session: attachment.session,
                entrypoint: attachment.entrypoint,
                model: attachment.model,
                token_source: attachment.token_source,
                token_fingerprint: attachment.token_fingerprint,
                auth_state: attachment.auth_state,
                connected_at_ms: attachment.connected_at_ms,
            })
            .collect::<Vec<_>>();
        let restored_attachments = attachments.len();
        let metrics = self.load_metrics(&session, js_sys::Date::now()).await?;
        Response::from_json(&RealtimeSessionStatus {
            session,
            active_websockets: sockets.len(),
            restored_attachments,
            hibernation: true,
            observability: "durable_object_storage",
            metrics,
            attachments,
        })
    }

    async fn websocket_message(
        &mut self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> WorkerResult<()> {
        let attachment = ws
            .deserialize_attachment::<SocketAttachment>()
            .ok()
            .flatten();
        let now_ms = js_sys::Date::now();
        let session = attachment
            .as_ref()
            .map(|attachment| attachment.session.clone())
            .unwrap_or_else(|| self.state.id().to_string());
        let mut metrics = self.load_metrics(&session, now_ms).await?;
        metrics.record_message(attachment.as_ref(), now_ms, &message);
        self.store_metrics(&metrics).await?;
        let context = attachment_context_json(attachment.as_ref());
        match message {
            WebSocketIncomingMessage::String(message) if message.trim() == "ping" => {
                ws.send(&json!({
                    "type": "pong",
                    "context": context,
                    "time_ms": js_sys::Date::now()
                }))?;
            }
            WebSocketIncomingMessage::String(message) if message.trim() == "status" => {
                ws.send(&json!({
                    "type": "realtime_session_status",
                    "context": context,
                    "metrics": metrics
                }))?;
            }
            WebSocketIncomingMessage::String(message) => {
                let summary = realtime_text_control_summary(&message);
                ws.send(&json!({
                    "type": "realtime_session_control",
                    "status": "upstream_bridge_not_wired",
                    "context": context,
                    "text_chars": summary.text_chars,
                    "text_bytes": summary.text_bytes
                }))?;
            }
            WebSocketIncomingMessage::Binary(bytes) => {
                ws.send(&json!({
                    "type": "realtime_session_control",
                    "status": "upstream_bridge_not_wired",
                    "context": context,
                    "binary_bytes": bytes.len()
                }))?;
            }
        }
        Ok(())
    }

    async fn websocket_close(
        &mut self,
        ws: WebSocket,
        code: usize,
        reason: String,
        _was_clean: bool,
    ) -> WorkerResult<()> {
        let attachment = ws
            .deserialize_attachment::<SocketAttachment>()
            .ok()
            .flatten();
        let now_ms = js_sys::Date::now();
        let session = attachment
            .as_ref()
            .map(|attachment| attachment.session.clone())
            .unwrap_or_else(|| self.state.id().to_string());
        let mut metrics = self.load_metrics(&session, now_ms).await?;
        metrics.record_close(attachment.as_ref(), now_ms, code, &reason);
        self.store_metrics(&metrics).await?;
        Ok(())
    }

    async fn websocket_error(&mut self, ws: WebSocket, error: worker::Error) -> WorkerResult<()> {
        worker::console_warn!("RealtimeSession websocket error: {}", error);
        let attachment = ws
            .deserialize_attachment::<SocketAttachment>()
            .ok()
            .flatten();
        let now_ms = js_sys::Date::now();
        let session = attachment
            .as_ref()
            .map(|attachment| attachment.session.clone())
            .unwrap_or_else(|| self.state.id().to_string());
        let mut metrics = self.load_metrics(&session, now_ms).await?;
        metrics.record_error(attachment.as_ref(), now_ms, &error.to_string());
        self.store_metrics(&metrics).await?;
        Ok(())
    }
}

impl RealtimeSession {
    async fn accept_websocket(&mut self, req: Request, session: String) -> WorkerResult<Response> {
        let pair = WebSocketPair::new()?;
        let client = pair.client;
        let server = pair.server;
        let attachment = socket_attachment_from_request(&req, session.clone());
        server.serialize_attachment(attachment.clone())?;
        let tag = format!("{SESSION_TAG_PREFIX}{session}");
        self.state
            .accept_websocket_with_tags(&server, &[tag.as_str()]);
        let now_ms = js_sys::Date::now();
        let mut metrics = self.load_metrics(&attachment.session, now_ms).await?;
        metrics.record_connect(&attachment, now_ms);
        self.store_metrics(&metrics).await?;
        Response::from_websocket(client)
    }

    async fn load_metrics(
        &self,
        session: &str,
        now_ms: f64,
    ) -> WorkerResult<RealtimeSessionMetrics> {
        match self
            .state
            .storage()
            .get::<RealtimeSessionMetrics>(SESSION_METRICS_KEY)
            .await
        {
            Ok(mut metrics) => {
                if metrics.session != session {
                    metrics.session = session.to_string();
                }
                Ok(metrics)
            }
            Err(_) => Ok(RealtimeSessionMetrics::new(session, now_ms)),
        }
    }

    async fn store_metrics(&self, metrics: &RealtimeSessionMetrics) -> WorkerResult<()> {
        let mut storage = self.state.storage();
        storage.put(SESSION_METRICS_KEY, metrics).await
    }
}

impl RealtimeSessionMetrics {
    fn new(session: &str, now_ms: f64) -> Self {
        Self {
            session: session.to_string(),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            connected_count: 0,
            text_message_count: 0,
            binary_message_count: 0,
            closed_count: 0,
            error_count: 0,
            last_connected_at_ms: None,
            last_message_at_ms: None,
            last_closed_at_ms: None,
            last_error_at_ms: None,
            last_entrypoint: None,
            last_model: None,
            last_token_source: None,
            last_token_fingerprint: None,
            last_auth_state: None,
            last_close_code: None,
            last_close_reason: None,
            last_error: None,
        }
    }

    fn record_connect(&mut self, attachment: &SocketAttachment, now_ms: f64) {
        self.connected_count = self.connected_count.saturating_add(1);
        self.last_connected_at_ms = Some(now_ms);
        self.record_context(Some(attachment), now_ms);
    }

    fn record_message(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        message: &WebSocketIncomingMessage,
    ) {
        match message {
            WebSocketIncomingMessage::String(_) => {
                self.text_message_count = self.text_message_count.saturating_add(1);
            }
            WebSocketIncomingMessage::Binary(_) => {
                self.binary_message_count = self.binary_message_count.saturating_add(1);
            }
        }
        self.last_message_at_ms = Some(now_ms);
        self.record_context(attachment, now_ms);
    }

    fn record_close(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        code: usize,
        reason: &str,
    ) {
        self.closed_count = self.closed_count.saturating_add(1);
        self.last_closed_at_ms = Some(now_ms);
        self.last_close_code = Some(code);
        self.last_close_reason = truncate_stored_text(reason);
        self.record_context(attachment, now_ms);
    }

    fn record_error(&mut self, attachment: Option<&SocketAttachment>, now_ms: f64, error: &str) {
        self.error_count = self.error_count.saturating_add(1);
        self.last_error_at_ms = Some(now_ms);
        self.last_error = truncate_stored_text(error);
        self.record_context(attachment, now_ms);
    }

    fn record_context(&mut self, attachment: Option<&SocketAttachment>, now_ms: f64) {
        self.updated_at_ms = now_ms;
        if let Some(attachment) = attachment {
            self.session = attachment.session.clone();
            self.last_entrypoint = Some(attachment.entrypoint.clone());
            self.last_model = attachment.model.clone();
            self.last_token_source = attachment.token_source.clone();
            self.last_token_fingerprint = attachment.token_fingerprint.clone();
            self.last_auth_state = Some(attachment.auth_state.clone());
        }
    }
}

pub fn realtime_gateway_candidate(path: &str) -> bool {
    path.starts_with(REALTIME_SESSION_GATEWAY_PREFIX) || path == REALTIME_OPENAI_PATH
}

pub async fn handle_gateway(req: Request, env: Env) -> WorkerResult<Response> {
    if req.path() == REALTIME_OPENAI_PATH {
        return handle_openai_realtime_gateway(req, env).await;
    }
    handle_platform_realtime_gateway(req, env).await
}

async fn handle_platform_realtime_gateway(req: Request, env: Env) -> WorkerResult<Response> {
    if !env_flag(&env, REALTIME_SESSION_GATEWAY_ENABLED_ENV) {
        return realtime_error_response(
            "realtime_session_gateway_disabled",
            "Realtime session gateway is disabled",
            "platform_gateway_error",
            501,
        );
    }

    let session = match session_from_gateway_path(&req.path()) {
        Some(session) => session,
        None => {
            return realtime_error_response(
                "invalid_realtime_session",
                "Realtime session name is invalid",
                "platform_gateway_error",
                400,
            );
        }
    };

    fetch_session_stub(req, env, session).await
}

async fn handle_openai_realtime_gateway(req: Request, env: Env) -> WorkerResult<Response> {
    if !env_flag(&env, REALTIME_SESSION_V1_ENABLED_ENV) {
        return realtime_error_response(
            "realtime_v1_gateway_disabled",
            "OpenAI Realtime gateway is disabled",
            "invalid_request_error",
            501,
        );
    }

    if req.method() != Method::Get {
        return realtime_error_response(
            "method_not_allowed",
            "OpenAI Realtime requires GET WebSocket upgrade requests",
            "invalid_request_error",
            405,
        );
    }

    if !wants_websocket(&req) {
        return realtime_error_response(
            "websocket_upgrade_required",
            "OpenAI Realtime requires an Upgrade: websocket request",
            "invalid_request_error",
            426,
        );
    }

    let model = match realtime_model_from_request(&req) {
        Some(model) => model,
        None => {
            return realtime_error_response(
                "missing_model",
                "OpenAI Realtime requires a non-empty model query parameter",
                "invalid_request_error",
                400,
            );
        }
    };
    let websocket_key = match request_header(&req, "sec-websocket-key") {
        Some(key) => key,
        None => {
            return realtime_error_response(
                "missing_websocket_key",
                "OpenAI Realtime requires Sec-WebSocket-Key",
                "invalid_request_error",
                400,
            );
        }
    };
    let api_key = match extract_realtime_api_key(&req) {
        Some(api_key) => api_key,
        None => {
            return realtime_error_response(
                "missing_api_key",
                "missing Authorization Bearer token, x-api-key, or realtime protocol API key",
                "invalid_request_error",
                401,
            );
        }
    };
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(err) => {
            worker::console_error!("Realtime token auth D1 binding unavailable: {}", err);
            return realtime_error_response(
                "realtime_auth_unavailable",
                "Realtime token auth database is not configured",
                "server_error",
                503,
            );
        }
    };
    let client_ip = crate::relay::client_ip(&req);
    let auth =
        match crate::relay::authenticate(&db, &env, &api_key.value, &model, client_ip.as_deref())
            .await
        {
            Ok(auth) => auth,
            Err(response) => return response,
        };
    if let Err(response) =
        crate::relay::enforce_relay_rate_limits(&env, &auth, client_ip.as_deref()).await
    {
        return response;
    }

    let session = realtime_session_name(&model, &websocket_key, &token_fingerprint(&api_key.value));
    fetch_session_stub(req, env, session).await
}

async fn fetch_session_stub(req: Request, env: Env, session: String) -> WorkerResult<Response> {
    let namespace = match env.durable_object(REALTIME_SESSIONS_BINDING) {
        Ok(namespace) => namespace,
        Err(err) => {
            worker::console_error!("RealtimeSession binding unavailable: {}", err);
            return realtime_error_response(
                "realtime_session_unavailable",
                "Realtime session Durable Object is not configured",
                "platform_gateway_error",
                503,
            );
        }
    };
    let id = namespace.id_from_name(&session)?;
    let stub = id.get_stub()?;
    stub.fetch_with_request(req).await
}

fn socket_attachment_from_request(req: &Request, session: String) -> SocketAttachment {
    let protocol = request_header(req, "sec-websocket-protocol")
        .as_deref()
        .and_then(redacted_realtime_protocols);
    let api_key = extract_realtime_api_key(req);
    SocketAttachment {
        session,
        connected_at_ms: js_sys::Date::now(),
        protocol,
        entrypoint: realtime_entrypoint(&req.path()).to_string(),
        model: realtime_model_from_request(req),
        token_source: api_key.as_ref().map(|key| key.source.to_string()),
        token_fingerprint: api_key.as_ref().map(|key| token_fingerprint(&key.value)),
        auth_state: auth_state_for_path(&req.path()).to_string(),
    }
}

fn attachment_context_json(attachment: Option<&SocketAttachment>) -> Value {
    match attachment {
        Some(attachment) => json!({
            "session": attachment.session,
            "entrypoint": attachment.entrypoint,
            "model": attachment.model,
            "token_source": attachment.token_source,
            "token_fingerprint": attachment.token_fingerprint,
            "auth_state": attachment.auth_state
        }),
        None => Value::Null,
    }
}

fn realtime_text_control_summary(message: &str) -> RealtimeTextControlSummary {
    RealtimeTextControlSummary {
        text_chars: message.chars().count(),
        text_bytes: message.as_bytes().len(),
    }
}

fn realtime_error_response(
    code: &str,
    message: &str,
    error_type: &str,
    status: u16,
) -> WorkerResult<Response> {
    crate::json_with_status(
        &json!({
            "error": {
                "code": code,
                "message": message,
                "type": error_type
            }
        }),
        status,
    )
}

fn wants_websocket(req: &Request) -> bool {
    req.headers()
        .get("Upgrade")
        .ok()
        .flatten()
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

fn session_from_request(req: &Request) -> Option<String> {
    session_from_gateway_path(&req.path()).or_else(|| {
        (req.path() == REALTIME_OPENAI_PATH).then(|| {
            let model = realtime_model_from_request(req).unwrap_or_else(|| "unknown".to_string());
            let websocket_key = request_header(req, "sec-websocket-key").unwrap_or_default();
            let token_hash = extract_realtime_api_key(req)
                .map(|key| token_fingerprint(&key.value))
                .unwrap_or_else(|| "anonymous".to_string());
            realtime_session_name(&model, &websocket_key, &token_hash)
        })
    })
}

fn session_from_gateway_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(REALTIME_SESSION_GATEWAY_PREFIX)?;
    let session = rest.split('/').next().unwrap_or_default();
    normalize_session_name(session)
}

fn normalize_session_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 96 {
        return None;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        .then_some(value)
}

fn realtime_session_name(model: &str, websocket_key: &str, token_hash: &str) -> String {
    let seed = format!(
        "{}|{}|{}",
        model.trim(),
        websocket_key.trim(),
        token_hash.trim()
    );
    format!("rt-{}", stable_hash_hex(&seed))
}

fn stable_hash_hex(value: &str) -> String {
    let mut hash = SESSION_HASH_OFFSET_BASIS;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(SESSION_HASH_PRIME);
    }
    format!("{hash:016x}")
}

fn realtime_entrypoint(path: &str) -> &'static str {
    if path == REALTIME_OPENAI_PATH {
        "openai_realtime_v1"
    } else {
        "platform_realtime"
    }
}

fn auth_state_for_path(path: &str) -> &'static str {
    if path == REALTIME_OPENAI_PATH {
        "gateway_checked"
    } else {
        "not_required"
    }
}

fn realtime_model_from_request(req: &Request) -> Option<String> {
    request_query_param(req, "model")
}

fn extract_realtime_api_key(req: &Request) -> Option<RealtimeApiKey> {
    request_header(req, "sec-websocket-protocol")
        .as_deref()
        .and_then(api_key_from_realtime_protocols)
        .map(|value| RealtimeApiKey {
            value,
            source: "sec-websocket-protocol",
        })
        .or_else(|| {
            request_header(req, "authorization")
                .as_deref()
                .and_then(bearer_token)
                .map(|value| RealtimeApiKey {
                    value,
                    source: "authorization",
                })
        })
        .or_else(|| {
            request_header(req, "x-api-key").map(|value| RealtimeApiKey {
                value,
                source: "x-api-key",
            })
        })
        .or_else(|| {
            request_header(req, "x-goog-api-key").map(|value| RealtimeApiKey {
                value,
                source: "x-goog-api-key",
            })
        })
        .or_else(|| {
            request_query_param(req, "key").map(|value| RealtimeApiKey {
                value,
                source: "query:key",
            })
        })
}

fn api_key_from_realtime_protocols(value: &str) -> Option<String> {
    value.split(',').find_map(|part| {
        let part = part.trim();
        part.strip_prefix(OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
    })
}

fn redacted_realtime_protocols(value: &str) -> Option<String> {
    let protocols = value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .take(8)
        .map(|part| {
            if part.starts_with(OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX) {
                format!("{OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX}<redacted>")
            } else {
                truncate_protocol_token(part)
            }
        })
        .collect::<Vec<_>>();
    (!protocols.is_empty()).then(|| protocols.join(","))
}

fn truncate_protocol_token(value: &str) -> String {
    truncate_text(value, MAX_PROTOCOL_TOKEN_CHARS).unwrap_or_default()
}

fn truncate_stored_text(value: &str) -> Option<String> {
    truncate_text(value.trim(), MAX_STORED_TEXT_CHARS)
}

fn truncate_text(value: &str, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        Some(format!("{truncated}..."))
    } else {
        Some(value.to_string())
    }
}

fn bearer_token(value: &str) -> Option<String> {
    let mut parts = value.trim().splitn(2, char::is_whitespace);
    let scheme = parts.next()?;
    let token = parts.next()?.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

fn request_header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn request_query_param(req: &Request, name: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_candidate_matches_realtime_prefixes() {
        assert!(realtime_gateway_candidate(
            "/api/platform/realtime/session-a"
        ));
        assert!(realtime_gateway_candidate(
            "/api/platform/realtime/session-a/status"
        ));
        assert!(realtime_gateway_candidate("/v1/realtime"));
        assert!(!realtime_gateway_candidate("/v1/realtime/sessions"));
    }

    #[test]
    fn gateway_session_name_is_sanitized() {
        assert_eq!(
            session_from_gateway_path("/api/platform/realtime/Session_1/status").as_deref(),
            Some("session_1")
        );
        assert!(session_from_gateway_path("/api/platform/realtime/../bad").is_none());
        assert!(session_from_gateway_path("/api/platform/realtime/").is_none());
    }

    #[test]
    fn realtime_protocol_api_key_is_extracted() {
        assert_eq!(
            api_key_from_realtime_protocols(
                "realtime, openai-insecure-api-key.sk-live, openai-beta.realtime-v1"
            )
            .as_deref(),
            Some("sk-live")
        );
        assert!(api_key_from_realtime_protocols("realtime, openai-beta.realtime-v1").is_none());
    }

    #[test]
    fn realtime_protocol_summary_redacts_inline_key() {
        assert_eq!(
            redacted_realtime_protocols(
                "realtime, openai-insecure-api-key.sk-live, openai-beta.realtime-v1"
            )
            .as_deref(),
            Some("realtime,openai-insecure-api-key.<redacted>,openai-beta.realtime-v1")
        );
    }

    #[test]
    fn authorization_bearer_is_case_insensitive() {
        assert_eq!(bearer_token("Bearer sk-one").as_deref(), Some("sk-one"));
        assert_eq!(bearer_token("bearer sk-two").as_deref(), Some("sk-two"));
        assert_eq!(bearer_token("BEARER sk-three").as_deref(), Some("sk-three"));
        assert!(bearer_token("Basic abc").is_none());
    }

    #[test]
    fn realtime_session_name_is_stable_and_safe() {
        let first = realtime_session_name("gpt-4o-realtime-preview", "abc", "secret-hash");
        let second = realtime_session_name("gpt-4o-realtime-preview", "abc", "secret-hash");
        let other = realtime_session_name("gpt-4o-realtime-preview", "def", "secret-hash");
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(first.starts_with("rt-"));
        assert!(normalize_session_name(&first).is_some());
    }

    #[test]
    fn realtime_metrics_record_lifecycle_without_payload_or_token() {
        let attachment = SocketAttachment {
            session: "rt-session".to_string(),
            connected_at_ms: 10.0,
            protocol: Some("realtime,openai-insecure-api-key.<redacted>".to_string()),
            entrypoint: "openai_realtime_v1".to_string(),
            model: Some("gpt-4o-realtime-preview".to_string()),
            token_source: Some("authorization".to_string()),
            token_fingerprint: Some("fp-token".to_string()),
            auth_state: "gateway_checked".to_string(),
        };
        let mut metrics = RealtimeSessionMetrics::new("rt-session", 1.0);
        metrics.record_connect(&attachment, 2.0);
        metrics.record_message(
            Some(&attachment),
            3.0,
            &WebSocketIncomingMessage::String("secret client payload".to_string()),
        );
        metrics.record_message(
            Some(&attachment),
            4.0,
            &WebSocketIncomingMessage::Binary(vec![1]),
        );
        metrics.record_close(Some(&attachment), 5.0, 1000, "normal close");

        assert_eq!(metrics.connected_count, 1);
        assert_eq!(metrics.text_message_count, 1);
        assert_eq!(metrics.binary_message_count, 1);
        assert_eq!(metrics.closed_count, 1);
        assert_eq!(
            metrics.last_model.as_deref(),
            Some("gpt-4o-realtime-preview")
        );
        assert_eq!(metrics.last_token_source.as_deref(), Some("authorization"));
        assert_eq!(metrics.last_token_fingerprint.as_deref(), Some("fp-token"));
        assert_eq!(metrics.last_close_code, Some(1000));
        assert_eq!(metrics.last_close_reason.as_deref(), Some("normal close"));
        let raw = serde_json::to_string(&metrics).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("openai-insecure-api-key.sk"));
    }

    #[test]
    fn realtime_text_control_summary_does_not_include_payload() {
        let payload = "secret client payload 云";
        let summary = realtime_text_control_summary(payload);

        assert_eq!(summary.text_chars, payload.chars().count());
        assert_eq!(summary.text_bytes, payload.as_bytes().len());

        let raw = serde_json::to_string(&summary).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("云"));
    }

    #[test]
    fn realtime_metrics_truncate_close_and_error_text_safely() {
        let mut metrics = RealtimeSessionMetrics::new("rt-session", 1.0);
        let long_unicode = "云".repeat(MAX_STORED_TEXT_CHARS + 8);
        metrics.record_close(None, 2.0, 1006, &long_unicode);
        metrics.record_error(None, 3.0, &long_unicode);

        let close = metrics.last_close_reason.unwrap();
        let error = metrics.last_error.unwrap();
        assert!(close.ends_with("..."));
        assert!(error.ends_with("..."));
        assert_eq!(
            close.trim_end_matches("...").chars().count(),
            MAX_STORED_TEXT_CHARS
        );
        assert_eq!(
            error.trim_end_matches("...").chars().count(),
            MAX_STORED_TEXT_CHARS
        );
    }

    #[test]
    fn protocol_truncation_is_unicode_safe() {
        let long_protocol = "协议".repeat(MAX_PROTOCOL_TOKEN_CHARS);
        let truncated = truncate_protocol_token(&long_protocol);
        assert!(truncated.ends_with("..."));
        assert_eq!(
            truncated.trim_end_matches("...").chars().count(),
            MAX_PROTOCOL_TOKEN_CHARS
        );
    }
}
