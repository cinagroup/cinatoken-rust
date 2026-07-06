//! Durable Object foundation for realtime/session-heavy relay flows.
//!
//! The current relay does not yet implement full OpenAI Realtime protocol
//! parity. This object establishes the Cloudflare-native stateful WebSocket
//! substrate: hibernatable accepts through `State::accept_web_socket`, socket
//! attachments for resume metadata, and a tiny control protocol for smoke
//! testing.

use cinatoken_relay::{
    openai_compatible::{default_base_url, upstream_v1_url},
    token_fingerprint,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use worker::{
    durable_object, Env, Method, Request, Response, Result as WorkerResult, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair,
};

use crate::platform_gateway::env_flag;

pub const REALTIME_SESSIONS_BINDING: &str = "REALTIME_SESSIONS";
pub const REALTIME_SESSION_GATEWAY_ENABLED_ENV: &str = "REALTIME_SESSION_GATEWAY_ENABLED";
pub const REALTIME_SESSION_V1_ENABLED_ENV: &str = "REALTIME_SESSION_V1_ENABLED";
pub const REALTIME_UPSTREAM_BRIDGE_PLANNER_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_CHANNEL_PLANNER_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_CONNECT_CONTRACT_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_PLAN_HEADER: &str = "x-cinatoken-realtime-upstream-plan";
pub const REALTIME_SESSION_GATEWAY_PREFIX: &str = "/api/platform/realtime/";
pub const REALTIME_OPENAI_PATH: &str = "/v1/realtime";
pub const REALTIME_SESSION_CUTOVER_GUARDS: &[&str] = &[
    "platform_gateway_gate",
    "v1_gateway_gate",
    "relay_token_auth",
    "relay_rate_limits",
    "upstream_channel_selection",
    "hibernation_attachment_restore",
    "metadata_only_control_frames",
    "upstream_bridge",
    "billing_settlement",
];

const SESSION_TAG_PREFIX: &str = "session:";
const OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX: &str = "openai-insecure-api-key.";
const OPENAI_REALTIME_PROTOCOL: &str = "realtime";
const OPENAI_REALTIME_BETA_PROTOCOL: &str = "openai-beta.realtime-v1";
const OPENAI_REALTIME_BETA_HEADER_VALUE: &str = "realtime=v1";
const CHANNEL_TYPE_AZURE: i32 = 3;
const AZURE_DEFAULT_API_VERSION: &str = "2025-04-01-preview";
const SESSION_METRICS_KEY: &str = "session_metrics_v1";
const MAX_STORED_TEXT_CHARS: usize = 160;
const MAX_PROTOCOL_TOKEN_CHARS: usize = 96;
const MAX_CHANNEL_NAME_CHARS: usize = 80;
const MAX_UPSTREAM_PLAN_HEADER_CHARS: usize = 1800;
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
    upstream: Option<RealtimeSelectedUpstreamPlan>,
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
    upstream: Option<RealtimeSelectedUpstreamPlan>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RealtimeUpstreamProvider {
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
    #[serde(rename = "azure_openai")]
    AzureOpenAi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RealtimeUpstreamAuthMode {
    RealtimeSubprotocol,
    AuthorizationBearer,
    AzureApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct RealtimeUpstreamBridgePlan {
    provider: RealtimeUpstreamProvider,
    url: String,
    model: String,
    channel_type: i32,
    channel_has_custom_base_url: bool,
    auth_mode: RealtimeUpstreamAuthMode,
    protocol_redacted: Vec<String>,
    header_names: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RealtimeSelectedUpstreamPlan {
    selected_group: String,
    channel_id: i64,
    channel_type: i32,
    channel_name: Option<String>,
    provider: RealtimeUpstreamProvider,
    upstream_url: String,
    request_model: String,
    upstream_model: String,
    channel_has_custom_base_url: bool,
    auth_mode: RealtimeUpstreamAuthMode,
    protocol_redacted: Vec<String>,
    header_names: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct RealtimeUpstreamBridgeInput<'a> {
    channel_type: i32,
    base_url: Option<&'a str>,
    model: &'a str,
    upstream_api_key: &'a str,
    api_version: Option<&'a str>,
    client_requested_subprotocol: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RealtimeSelectedUpstreamInput<'a> {
    pub selected_group: &'a str,
    pub channel_id: i64,
    pub channel_type: i32,
    pub channel_name: &'a str,
    pub channel_base_url: Option<&'a str>,
    pub request_model: &'a str,
    pub upstream_model: &'a str,
    pub upstream_api_key: &'a str,
    pub api_version: Option<&'a str>,
    pub client_requested_subprotocol: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RealtimeUpstreamBridgeHandshake {
    auth_mode: RealtimeUpstreamAuthMode,
    protocol: Vec<String>,
    headers: Vec<(&'static str, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RealtimeUpstreamBridgeConnectSpec {
    redacted_plan: RealtimeUpstreamBridgePlan,
    protocol: Vec<String>,
    headers: Vec<(&'static str, String)>,
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
                upstream: attachment.upstream,
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
    let upstream_plan = match crate::relay::plan_realtime_upstream_channel(
        &db,
        &env,
        &auth,
        &model,
        client_requested_realtime_subprotocol(&req),
    )
    .await
    {
        Ok(plan) => plan,
        Err(response) => return response,
    };

    let session = realtime_session_name(&model, &websocket_key, &token_fingerprint(&api_key.value));
    let req = attach_realtime_upstream_plan_header(req, &upstream_plan)?;
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
        upstream: realtime_upstream_plan_from_request(req),
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
            "auth_state": attachment.auth_state,
            "upstream": attachment.upstream
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

pub(crate) fn realtime_upstream_bridge_planner_compiled() -> bool {
    REALTIME_UPSTREAM_BRIDGE_PLANNER_COMPILED
        && realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: "planner-smoke-key",
            api_version: None,
            client_requested_subprotocol: true,
        })
        .is_ok()
        && realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: CHANNEL_TYPE_AZURE,
            base_url: Some("https://example.openai.azure.com"),
            model: "gpt-4o-realtime-deployment",
            upstream_api_key: "planner-smoke-key",
            api_version: Some(AZURE_DEFAULT_API_VERSION),
            client_requested_subprotocol: true,
        })
        .is_ok()
}

pub(crate) fn realtime_upstream_channel_planner_compiled() -> bool {
    if !REALTIME_UPSTREAM_CHANNEL_PLANNER_COMPILED {
        return false;
    }
    let Ok(plan) = realtime_selected_upstream_plan(RealtimeSelectedUpstreamInput {
        selected_group: "default",
        channel_id: 1,
        channel_type: 1,
        channel_name: "openai-primary",
        channel_base_url: Some("https://api.openai.com"),
        request_model: "gpt-4o-realtime-preview",
        upstream_model: "gpt-4o-realtime-preview",
        upstream_api_key: "planner-smoke-key",
        api_version: None,
        client_requested_subprotocol: true,
    }) else {
        return false;
    };
    let Ok(header) = realtime_upstream_plan_header_value(&plan) else {
        return false;
    };
    realtime_upstream_plan_from_header_value(&header).as_ref() == Some(&plan)
}

pub(crate) fn realtime_upstream_bridge_connect_contract_compiled() -> bool {
    if !REALTIME_UPSTREAM_BRIDGE_CONNECT_CONTRACT_COMPILED {
        return false;
    }
    let secret = "connect-contract-smoke-key";
    let Ok(openai_subprotocol) =
        realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: true,
        })
    else {
        return false;
    };
    let Ok(openai_headers) = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
        channel_type: 1,
        base_url: Some("https://api.openai.com"),
        model: "gpt-4o-realtime-preview",
        upstream_api_key: secret,
        api_version: None,
        client_requested_subprotocol: false,
    }) else {
        return false;
    };
    let Ok(azure) = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
        channel_type: CHANNEL_TYPE_AZURE,
        base_url: Some("https://example.openai.azure.com"),
        model: "gpt-4o-realtime-deployment",
        upstream_api_key: secret,
        api_version: Some(AZURE_DEFAULT_API_VERSION),
        client_requested_subprotocol: true,
    }) else {
        return false;
    };

    let openai_plan = serde_json::to_string(&openai_subprotocol.redacted_plan).unwrap_or_default();
    let headers_plan = serde_json::to_string(&openai_headers.redacted_plan).unwrap_or_default();
    let azure_plan = serde_json::to_string(&azure.redacted_plan).unwrap_or_default();
    openai_subprotocol
        .protocol
        .iter()
        .any(|value| value.contains(secret))
        && openai_subprotocol.headers.is_empty()
        && !openai_plan.contains(secret)
        && openai_headers.protocol.is_empty()
        && openai_headers
            .headers
            .iter()
            .any(|(name, value)| *name == "authorization" && value == &format!("Bearer {secret}"))
        && !headers_plan.contains(secret)
        && azure.protocol.is_empty()
        && azure
            .headers
            .iter()
            .any(|(name, value)| *name == "api-key" && value == secret)
        && !azure_plan.contains(secret)
}

pub(crate) fn realtime_selected_upstream_plan(
    input: RealtimeSelectedUpstreamInput<'_>,
) -> Result<RealtimeSelectedUpstreamPlan, String> {
    let selected_group = non_empty_trimmed(input.selected_group, "selected_group")?;
    let request_model = non_empty_trimmed(input.request_model, "request_model")?;
    let upstream_model = non_empty_trimmed(input.upstream_model, "upstream_model")?;
    let bridge = realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
        channel_type: input.channel_type,
        base_url: input.channel_base_url,
        model: &upstream_model,
        upstream_api_key: input.upstream_api_key,
        api_version: input.api_version,
        client_requested_subprotocol: input.client_requested_subprotocol,
    })?;
    Ok(RealtimeSelectedUpstreamPlan {
        selected_group,
        channel_id: input.channel_id,
        channel_type: input.channel_type,
        channel_name: truncate_text(input.channel_name, MAX_CHANNEL_NAME_CHARS),
        provider: bridge.provider,
        upstream_url: bridge.url,
        request_model,
        upstream_model: bridge.model,
        channel_has_custom_base_url: bridge.channel_has_custom_base_url,
        auth_mode: bridge.auth_mode,
        protocol_redacted: bridge.protocol_redacted,
        header_names: bridge
            .header_names
            .into_iter()
            .map(str::to_string)
            .collect(),
    })
}

fn attach_realtime_upstream_plan_header(
    mut req: Request,
    plan: &RealtimeSelectedUpstreamPlan,
) -> WorkerResult<Request> {
    let value = realtime_upstream_plan_header_value(plan)?;
    req.headers_mut()?
        .set(REALTIME_UPSTREAM_PLAN_HEADER, &value)?;
    Ok(req)
}

fn realtime_upstream_plan_header_value(
    plan: &RealtimeSelectedUpstreamPlan,
) -> WorkerResult<String> {
    let value = serde_json::to_string(plan).map_err(|err| {
        worker::Error::RustError(format!("failed to encode realtime upstream plan: {err}"))
    })?;
    if value.len() > MAX_UPSTREAM_PLAN_HEADER_CHARS {
        return Err(worker::Error::RustError(format!(
            "realtime upstream plan exceeds {MAX_UPSTREAM_PLAN_HEADER_CHARS} byte header limit"
        )));
    }
    Ok(value)
}

fn realtime_upstream_plan_from_request(req: &Request) -> Option<RealtimeSelectedUpstreamPlan> {
    request_header(req, REALTIME_UPSTREAM_PLAN_HEADER)
        .as_deref()
        .and_then(realtime_upstream_plan_from_header_value)
}

fn realtime_upstream_plan_from_header_value(value: &str) -> Option<RealtimeSelectedUpstreamPlan> {
    if value.len() > MAX_UPSTREAM_PLAN_HEADER_CHARS {
        return None;
    }
    serde_json::from_str::<RealtimeSelectedUpstreamPlan>(value).ok()
}

fn realtime_upstream_bridge_plan(
    input: RealtimeUpstreamBridgeInput<'_>,
) -> Result<RealtimeUpstreamBridgePlan, String> {
    realtime_upstream_bridge_connect_spec(input).map(|spec| spec.redacted_plan)
}

fn realtime_upstream_bridge_connect_spec(
    input: RealtimeUpstreamBridgeInput<'_>,
) -> Result<RealtimeUpstreamBridgeConnectSpec, String> {
    let model = non_empty_trimmed(input.model, "model")?;
    let upstream_api_key = non_empty_trimmed(input.upstream_api_key, "upstream_api_key")?;
    let provider = realtime_upstream_provider(input.channel_type);
    let url = match provider {
        RealtimeUpstreamProvider::OpenAiCompatible => {
            openai_realtime_upstream_url(input.channel_type, input.base_url, &model)?
        }
        RealtimeUpstreamProvider::AzureOpenAi => azure_realtime_upstream_url(
            input
                .base_url
                .unwrap_or_else(|| default_base_url(input.channel_type)),
            &model,
            input.api_version,
        )?,
    };
    let handshake = realtime_upstream_bridge_handshake(
        provider,
        &upstream_api_key,
        input.client_requested_subprotocol,
    );
    let protocol_redacted = handshake
        .protocol
        .iter()
        .map(|value| redact_realtime_protocol_token(value))
        .collect::<Vec<_>>();
    let header_names = handshake
        .headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();

    let redacted_plan = RealtimeUpstreamBridgePlan {
        provider,
        url,
        model,
        channel_type: input.channel_type,
        channel_has_custom_base_url: input
            .base_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some(),
        auth_mode: handshake.auth_mode,
        protocol_redacted,
        header_names,
    };

    Ok(RealtimeUpstreamBridgeConnectSpec {
        redacted_plan,
        protocol: handshake.protocol,
        headers: handshake.headers,
    })
}

fn realtime_upstream_provider(channel_type: i32) -> RealtimeUpstreamProvider {
    if channel_type == CHANNEL_TYPE_AZURE {
        RealtimeUpstreamProvider::AzureOpenAi
    } else {
        RealtimeUpstreamProvider::OpenAiCompatible
    }
}

fn openai_realtime_upstream_url(
    channel_type: i32,
    base_url: Option<&str>,
    model: &str,
) -> Result<String, String> {
    let mut url = Url::parse(&upstream_v1_url(channel_type, base_url, "realtime"))
        .map_err(|err| format!("invalid OpenAI-compatible realtime upstream URL: {err}"))?;
    set_realtime_websocket_scheme(&mut url)?;
    url.query_pairs_mut().append_pair("model", model);
    Ok(url.to_string())
}

fn azure_realtime_upstream_url(
    base_url: &str,
    deployment: &str,
    api_version: Option<&str>,
) -> Result<String, String> {
    let base_url = non_empty_trimmed(base_url, "base_url")?;
    let api_version = api_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(AZURE_DEFAULT_API_VERSION);
    let mut url = Url::parse(&base_url)
        .map_err(|err| format!("invalid Azure realtime upstream base URL: {err}"))?;
    set_realtime_websocket_scheme(&mut url)?;
    let path = append_url_path(url.path(), "/openai/realtime");
    url.set_path(&path);
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("deployment", deployment)
        .append_pair("api-version", api_version);
    Ok(url.to_string())
}

fn set_realtime_websocket_scheme(url: &mut Url) -> Result<(), String> {
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => {
            return Err(format!("unsupported realtime upstream URL scheme: {other}"));
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| format!("failed to set realtime upstream scheme to {scheme}"))
}

fn append_url_path(base_path: &str, request_path: &str) -> String {
    let base_path = base_path.trim_end_matches('/');
    let request_path = request_path.trim_start_matches('/');
    if base_path.is_empty() {
        format!("/{request_path}")
    } else {
        format!("{base_path}/{request_path}")
    }
}

fn realtime_upstream_bridge_handshake(
    provider: RealtimeUpstreamProvider,
    upstream_api_key: &str,
    client_requested_subprotocol: bool,
) -> RealtimeUpstreamBridgeHandshake {
    match provider {
        RealtimeUpstreamProvider::AzureOpenAi => RealtimeUpstreamBridgeHandshake {
            auth_mode: RealtimeUpstreamAuthMode::AzureApiKey,
            protocol: Vec::new(),
            headers: vec![("api-key", upstream_api_key.to_string())],
        },
        RealtimeUpstreamProvider::OpenAiCompatible if client_requested_subprotocol => {
            RealtimeUpstreamBridgeHandshake {
                auth_mode: RealtimeUpstreamAuthMode::RealtimeSubprotocol,
                protocol: realtime_upstream_protocols(upstream_api_key),
                headers: Vec::new(),
            }
        }
        RealtimeUpstreamProvider::OpenAiCompatible => RealtimeUpstreamBridgeHandshake {
            auth_mode: RealtimeUpstreamAuthMode::AuthorizationBearer,
            protocol: Vec::new(),
            headers: vec![
                ("openai-beta", OPENAI_REALTIME_BETA_HEADER_VALUE.to_string()),
                ("authorization", format!("Bearer {upstream_api_key}")),
            ],
        },
    }
}

fn realtime_upstream_protocols(upstream_api_key: &str) -> Vec<String> {
    vec![
        OPENAI_REALTIME_PROTOCOL.to_string(),
        format!("{OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX}{upstream_api_key}"),
        OPENAI_REALTIME_BETA_PROTOCOL.to_string(),
    ]
}

fn redact_realtime_protocol_token(value: &str) -> String {
    if value.starts_with(OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX) {
        format!("{OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX}<redacted>")
    } else {
        value.to_string()
    }
}

fn non_empty_trimmed(value: &str, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{name} is required"))
    } else {
        Ok(value.to_string())
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

fn client_requested_realtime_subprotocol(req: &Request) -> bool {
    request_header(req, "sec-websocket-protocol")
        .map(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(OPENAI_REALTIME_PROTOCOL))
        })
        .unwrap_or(false)
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
            upstream: None,
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
    fn realtime_openai_upstream_plan_uses_wss_realtime_model_query() {
        let plan = realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: "sk-upstream",
            api_version: None,
            client_requested_subprotocol: true,
        })
        .unwrap();

        assert_eq!(
            plan.url,
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
        );
        assert_eq!(plan.provider, RealtimeUpstreamProvider::OpenAiCompatible);
        assert_eq!(
            plan.auth_mode,
            RealtimeUpstreamAuthMode::RealtimeSubprotocol
        );
        assert_eq!(
            plan.protocol_redacted,
            vec![
                "realtime".to_string(),
                "openai-insecure-api-key.<redacted>".to_string(),
                "openai-beta.realtime-v1".to_string(),
            ]
        );
    }

    #[test]
    fn realtime_openai_upstream_plan_preserves_local_ws_scheme() {
        let plan = realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("http://localhost:8787"),
            model: "gpt-realtime-local",
            upstream_api_key: "sk-upstream",
            api_version: None,
            client_requested_subprotocol: false,
        })
        .unwrap();

        assert_eq!(
            plan.url,
            "ws://localhost:8787/v1/realtime?model=gpt-realtime-local"
        );
        assert_eq!(
            plan.auth_mode,
            RealtimeUpstreamAuthMode::AuthorizationBearer
        );
        assert_eq!(plan.header_names, vec!["openai-beta", "authorization"]);
        assert!(plan.protocol_redacted.is_empty());
    }

    #[test]
    fn realtime_azure_upstream_plan_uses_deployment_and_api_version() {
        let plan = realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: CHANNEL_TYPE_AZURE,
            base_url: Some("https://example.openai.azure.com"),
            model: "gpt-4o-realtime-deployment",
            upstream_api_key: "azure-secret",
            api_version: Some("2025-04-01-preview"),
            client_requested_subprotocol: true,
        })
        .unwrap();

        assert_eq!(
            plan.url,
            "wss://example.openai.azure.com/openai/realtime?deployment=gpt-4o-realtime-deployment&api-version=2025-04-01-preview"
        );
        assert_eq!(plan.provider, RealtimeUpstreamProvider::AzureOpenAi);
        assert_eq!(plan.auth_mode, RealtimeUpstreamAuthMode::AzureApiKey);
        assert_eq!(plan.header_names, vec!["api-key"]);
        assert!(plan.protocol_redacted.is_empty());
    }

    #[test]
    fn realtime_upstream_secret_handshake_is_not_serialized_in_plan() {
        let secret = "sk-live-secret";
        let handshake = realtime_upstream_bridge_handshake(
            RealtimeUpstreamProvider::OpenAiCompatible,
            secret,
            true,
        );
        assert!(handshake.protocol.iter().any(|item| item.contains(secret)));

        let plan = realtime_upstream_bridge_plan(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: true,
        })
        .unwrap();
        let raw = serde_json::to_string(&plan).unwrap();
        assert!(!raw.contains(secret));
        assert!(!raw.contains("Bearer sk-"));
        assert!(raw.contains("openai-insecure-api-key.<redacted>"));
    }

    #[test]
    fn realtime_openai_subprotocol_connect_spec_keeps_secret_request_scoped() {
        let secret = "sk-live-secret";
        let spec = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: true,
        })
        .unwrap();

        assert!(spec.headers.is_empty());
        assert!(spec.protocol.iter().any(|value| value.contains(secret)));
        assert_eq!(
            spec.redacted_plan.auth_mode,
            RealtimeUpstreamAuthMode::RealtimeSubprotocol
        );
        assert_eq!(
            spec.redacted_plan.protocol_redacted,
            vec![
                "realtime".to_string(),
                "openai-insecure-api-key.<redacted>".to_string(),
                "openai-beta.realtime-v1".to_string(),
            ]
        );
        let raw_plan = serde_json::to_string(&spec.redacted_plan).unwrap();
        assert!(!raw_plan.contains(secret));
        assert!(!raw_plan.contains("Bearer sk-"));
    }

    #[test]
    fn realtime_openai_header_connect_spec_keeps_secret_request_scoped() {
        let secret = "sk-live-secret";
        let spec = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
            channel_type: 1,
            base_url: Some("https://api.openai.com"),
            model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: false,
        })
        .unwrap();

        assert!(spec.protocol.is_empty());
        assert!(spec
            .headers
            .iter()
            .any(|(name, value)| *name == "authorization" && value == "Bearer sk-live-secret"));
        assert_eq!(
            spec.redacted_plan.auth_mode,
            RealtimeUpstreamAuthMode::AuthorizationBearer
        );
        assert_eq!(
            spec.redacted_plan.header_names,
            vec!["openai-beta", "authorization"]
        );
        let raw_plan = serde_json::to_string(&spec.redacted_plan).unwrap();
        assert!(!raw_plan.contains(secret));
        assert!(!raw_plan.contains("Bearer sk-"));
    }

    #[test]
    fn realtime_azure_connect_spec_uses_api_key_without_serializing_secret() {
        let secret = "azure-secret";
        let spec = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
            channel_type: CHANNEL_TYPE_AZURE,
            base_url: Some("https://example.openai.azure.com"),
            model: "gpt-4o-realtime-deployment",
            upstream_api_key: secret,
            api_version: Some("2025-04-01-preview"),
            client_requested_subprotocol: true,
        })
        .unwrap();

        assert!(spec.protocol.is_empty());
        assert_eq!(spec.headers, vec![("api-key", secret.to_string())]);
        assert_eq!(
            spec.redacted_plan.auth_mode,
            RealtimeUpstreamAuthMode::AzureApiKey
        );
        assert_eq!(spec.redacted_plan.header_names, vec!["api-key"]);
        let raw_plan = serde_json::to_string(&spec.redacted_plan).unwrap();
        assert!(!raw_plan.contains(secret));
    }

    #[test]
    fn realtime_selected_upstream_plan_header_round_trips_without_secret() {
        let secret = "sk-live-secret";
        let plan = realtime_selected_upstream_plan(RealtimeSelectedUpstreamInput {
            selected_group: "vip",
            channel_id: 42,
            channel_type: 1,
            channel_name: "primary-openai",
            channel_base_url: Some("https://api.openai.com"),
            request_model: "gpt-4o-realtime-preview",
            upstream_model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: true,
        })
        .unwrap();
        let header = realtime_upstream_plan_header_value(&plan).unwrap();
        let decoded = realtime_upstream_plan_from_header_value(&header).unwrap();
        let raw = serde_json::to_string(&decoded).unwrap();

        assert_eq!(decoded, plan);
        assert!(header.len() < MAX_UPSTREAM_PLAN_HEADER_CHARS);
        assert!(!raw.contains(secret));
        assert!(!raw.contains("Bearer sk-"));
        assert!(raw.contains("openai-insecure-api-key.<redacted>"));
    }

    #[test]
    fn realtime_upstream_channel_planner_self_check_passes() {
        assert!(realtime_upstream_channel_planner_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_connect_contract_self_check_passes() {
        assert!(realtime_upstream_bridge_connect_contract_compiled());
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
