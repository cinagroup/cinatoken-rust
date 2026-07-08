//! Durable Object foundation for realtime/session-heavy relay flows.
//!
//! The current relay does not yet implement full OpenAI Realtime protocol
//! parity. This object establishes the Cloudflare-native stateful WebSocket
//! substrate: hibernatable accepts through `State::accept_web_socket`, socket
//! attachments for resume metadata, and a tiny control protocol for smoke
//! testing.

use cinatoken_billing::{
    build_tiered_token_params, compute_tiered_quota_with_request, detect_billing_expr_variables,
    RequestInput, TieredBillingResult, TieredBillingSnapshot, TieredTokenUsage, UsageSemantic,
};
use cinatoken_relay::{
    openai_compatible::{default_base_url, upstream_v1_url, usage_summary_from_body, UsageSummary},
    token_fingerprint,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::time::Duration;
use url::Url;
use worker::{
    durable_object, Delay, Env, Fetch, Method, Request, Response, Result as WorkerResult, State,
    Storage, WebSocket, WebSocketIncomingMessage, WebSocketPair, WebsocketEvent,
};

use crate::platform_gateway::env_flag;

pub const REALTIME_SESSIONS_BINDING: &str = "REALTIME_SESSIONS";
pub const REALTIME_SESSION_GATEWAY_ENABLED_ENV: &str = "REALTIME_SESSION_GATEWAY_ENABLED";
pub const REALTIME_SESSION_V1_ENABLED_ENV: &str = "REALTIME_SESSION_V1_ENABLED";
pub const REALTIME_UPSTREAM_BRIDGE_PLANNER_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_CHANNEL_PLANNER_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_CONNECT_CONTRACT_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_CONNECT_HANDOFF_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_FETCH_UPGRADE_ADAPTER_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_LIFECYCLE_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_FRAME_GUARD_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_CLOSE_MAPPING_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_SEND_FAILURE_GUARD_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_EVENT_TRACE_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_REPLAY_CONTRACT_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_BACKPRESSURE_POLICY_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_BRIDGE_BACKPRESSURE_RUNTIME_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_USAGE_CAPTURE_COMPILED: bool = true;
pub const REALTIME_BILLING_PRESETTLEMENT_SNAPSHOT_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_PREVIEW_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_HANDOFF_COMPILED: bool = true;
pub const REALTIME_SESSION_PLATFORM_HEADER_BOUNDARY_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_PLAN_HEADER: &str = "x-cinatoken-realtime-upstream-plan";
const REALTIME_UPSTREAM_CONNECT_HEADER: &str = "x-cinatoken-realtime-upstream-connect";
pub const REALTIME_SESSION_GATEWAY_PREFIX: &str = "/api/platform/realtime/";
pub const REALTIME_OPENAI_PATH: &str = "/v1/realtime";
pub const REALTIME_SESSION_CUTOVER_GUARDS: &[&str] = &[
    "platform_gateway_gate",
    "v1_gateway_gate",
    "relay_token_auth",
    "relay_rate_limits",
    "upstream_channel_selection",
    "upstream_fetch_upgrade_adapter",
    "upstream_bridge_lifecycle",
    "upstream_bridge_frame_guard",
    "upstream_bridge_close_mapping",
    "upstream_bridge_send_failure_guard",
    "upstream_bridge_event_trace",
    "upstream_bridge_replay_contract",
    "upstream_bridge_backpressure_policy",
    "upstream_bridge_backpressure_runtime",
    "upstream_usage_capture",
    "billing_presettlement_snapshot",
    "billing_settlement_preview",
    "billing_settlement_handoff",
    "platform_upstream_header_boundary",
    "hibernation_attachment_restore",
    "metadata_only_control_frames",
    "upstream_bridge",
    "billing_settlement",
];

const REALTIME_INTERNAL_UPSTREAM_HEADERS: &[&str] = &[
    REALTIME_UPSTREAM_PLAN_HEADER,
    REALTIME_UPSTREAM_CONNECT_HEADER,
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
const MAX_UPSTREAM_CONNECT_HEADER_CHARS: usize = 3600;
const MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES: usize = 1_048_576;
const MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES: usize = 1_048_576;
const MAX_REALTIME_BRIDGE_PENDING_FRAMES: usize = 32;
const MAX_REALTIME_BRIDGE_PENDING_BYTES: usize = 4 * 1_048_576;
const REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE: u16 = 1009;
const REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE: u16 = 1011;
const REALTIME_BRIDGE_NORMAL_CLOSE_CODE: u16 = 1000;
const REALTIME_BRIDGE_REASON_CLIENT_CLOSED: &str = "client_websocket_closed";
const REALTIME_BRIDGE_REASON_CLIENT_ERROR: &str = "client_websocket_error";
const REALTIME_BRIDGE_REASON_CONNECT_FAILED: &str = "upstream_bridge_connect_failed";
const REALTIME_BRIDGE_REASON_EVENT_STREAM_FAILED: &str = "upstream_bridge_event_stream_failed";
const REALTIME_BRIDGE_REASON_ACCEPT_FAILED: &str = "upstream_bridge_accept_failed";
const REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE: &str = "upstream_bridge_frame_too_large";
const REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED: &str = "upstream_bridge_closed";
const REALTIME_BRIDGE_REASON_UPSTREAM_ERROR: &str = "upstream_bridge_error";
const REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED: &str = "upstream_bridge_forward_failed";
const REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED: &str = "client_bridge_forward_failed";
const REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW: &str = "upstream_bridge_backpressure_overflow";
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
    upstream_connect_handoff: bool,
}

#[derive(Debug, Serialize)]
struct RealtimeSessionStatus {
    session: String,
    active_websockets: usize,
    active_upstream_bridges: usize,
    queued_upstream_frames: usize,
    queued_upstream_bytes: usize,
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
    upstream_connect_handoff: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RealtimeMockUpstreamFault {
    EventStreamFailed,
    AcceptFailed,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    billing_snapshot: Option<RealtimeBillingSnapshotMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_queue_probe_delay_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mock_upstream_fault: Option<RealtimeMockUpstreamFault>,
}

pub(crate) struct RealtimeSelectedUpstream {
    plan: RealtimeSelectedUpstreamPlan,
    connect_handoff: RealtimeUpstreamBridgeConnectHandoff,
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

#[derive(Debug, Clone)]
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
    pub billing_snapshot: Option<RealtimeBillingSnapshotMetadata>,
    pub billing_settlement: Option<RealtimeBillingSettlementHandoff>,
    pub startup_queue_probe_delay_ms: Option<u32>,
    pub mock_upstream_fault: Option<RealtimeMockUpstreamFault>,
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

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct RealtimeUpstreamBridgeConnectHandoff {
    url: String,
    auth_mode: RealtimeUpstreamAuthMode,
    protocol: Vec<String>,
    headers: Vec<RealtimeUpstreamConnectHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    billing_settlement: Option<RealtimeBillingSettlementHandoff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_queue_probe_delay_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mock_upstream_fault: Option<RealtimeMockUpstreamFault>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RealtimeUpstreamConnectHeader {
    name: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RealtimeUpstreamFetchRequestPlan {
    fetch_url: String,
    upgrade: &'static str,
    protocol_header: Option<String>,
    headers: Vec<(String, String)>,
}

struct RealtimeUpstreamBridgeRuntime {
    state: Rc<RefCell<RealtimeUpstreamBridgeState>>,
}

struct RealtimeUpstreamBridgeState {
    upstream: WebSocket,
    upstream_ready: bool,
    closed: bool,
    pending: RealtimeBridgePendingQueue,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct RealtimeBridgePendingQueue {
    frames: VecDeque<RealtimeBridgeQueuedFrame>,
    bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RealtimeBridgeQueuedFrame {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeDrainFailure {
    frame: RealtimeBridgeFrameMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeBridgeFrameKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeFrameRejection {
    kind: RealtimeBridgeFrameKind,
    bytes: usize,
    max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeFrameMetadata {
    kind: RealtimeBridgeFrameKind,
    bytes: usize,
    max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeQueueState {
    pending_frames: usize,
    pending_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeBackpressurePolicy {
    max_pending_frames: usize,
    max_pending_bytes: usize,
    overflow_close_code: u16,
    overflow_reason: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeBackpressureOverflow {
    pending_frames: usize,
    pending_bytes: usize,
    incoming_bytes: usize,
    max_pending_frames: usize,
    max_pending_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeBridgeBackpressureDecision {
    SendNow,
    Queue,
    Overflow(RealtimeBridgeBackpressureOverflow),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeBridgeForwardResult {
    Sent,
    Queued,
    NotActive,
    Overflow(RealtimeBridgeBackpressureOverflow),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeBridgeCloseCause {
    ClientClosed,
    ClientError,
    UpstreamConnectFailed,
    UpstreamEventStreamFailed,
    UpstreamAcceptFailed,
    FrameTooLarge,
    UpstreamClosed(u16),
    UpstreamError,
    ClientToUpstreamSendFailed,
    UpstreamToClientSendFailed,
    BackpressureOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeCloseAction {
    client_code: u16,
    client_reason: &'static str,
    upstream_code: Option<u16>,
    upstream_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RealtimeBridgeTerminalEvent {
    event: String,
    direction: String,
    occurred_at_ms: f64,
    client_code: u16,
    client_reason: String,
    upstream_code: Option<u16>,
    upstream_reason: Option<String>,
    upstream_close_code: Option<u16>,
    frame_kind: Option<String>,
    frame_bytes: Option<usize>,
    frame_max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct RealtimeUsageMetadata {
    source_event: String,
    prompt_tokens: i32,
    completion_tokens: i32,
    total_tokens: i32,
    cached_tokens: i32,
    cache_creation_tokens: i32,
    image_input_tokens: i32,
    image_output_tokens: i32,
    audio_input_tokens: i32,
    audio_output_tokens: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct RealtimeBillingSnapshotMetadata {
    billing_mode: String,
    model_name: String,
    expr_hash: String,
    expr_version: u32,
    request_rule_present: bool,
    group_ratio: f64,
    quota_per_unit: f64,
    estimated_prompt_tokens: i64,
    estimated_completion_tokens: i64,
    estimated_quota_after_group: i64,
    estimated_tier: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct RealtimeBillingSettlementPreviewMetadata {
    billing_mode: String,
    model_name: String,
    expr_hash: String,
    expr_version: u32,
    request_rule_present: bool,
    usage_source_event: String,
    actual_prompt_tokens: i64,
    actual_completion_tokens: i64,
    actual_total_tokens: i64,
    pre_consumed_quota: i64,
    final_quota: i64,
    refund_quota: i64,
    additional_quota: i64,
    matched_tier: String,
    crossed_tier: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RealtimeBillingSettlementHandoff {
    snapshot: TieredBillingSnapshot,
    request: RequestInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RealtimeBridgeReplayScenario {
    name: &'static str,
    active_status_before_terminal: &'static str,
    terminal_cause: RealtimeBridgeCloseCause,
    terminal_frame: Option<RealtimeBridgeFrameMetadata>,
    expected_event: &'static str,
    expected_direction: &'static str,
    expected_client_code: u16,
    expected_client_reason: &'static str,
    expected_upstream_code: Option<u16>,
    expected_upstream_reason: Option<&'static str>,
    expected_upstream_close_code: Option<u16>,
    expected_frame_kind: Option<&'static str>,
    expected_frame_bytes: Option<usize>,
    expected_frame_max_bytes: Option<usize>,
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
    #[serde(default)]
    usage_event_count: u32,
    #[serde(default)]
    last_usage_at_ms: Option<f64>,
    #[serde(default)]
    last_usage: Option<RealtimeUsageMetadata>,
    #[serde(default)]
    billing_snapshot_count: u32,
    #[serde(default)]
    last_billing_snapshot_at_ms: Option<f64>,
    #[serde(default)]
    last_billing_snapshot: Option<RealtimeBillingSnapshotMetadata>,
    #[serde(default)]
    billing_settlement_preview_count: u32,
    #[serde(default)]
    last_billing_settlement_preview_at_ms: Option<f64>,
    #[serde(default)]
    last_billing_settlement_preview: Option<RealtimeBillingSettlementPreviewMetadata>,
    #[serde(default)]
    last_bridge_terminal_event: Option<RealtimeBridgeTerminalEvent>,
}

#[durable_object]
pub struct RealtimeSession {
    state: State,
    upstream_bridges: HashMap<String, RealtimeUpstreamBridgeRuntime>,
}

#[durable_object]
impl DurableObject for RealtimeSession {
    fn new(state: State, _env: Env) -> Self {
        Self {
            state,
            upstream_bridges: HashMap::new(),
        }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        self.drop_closed_upstream_bridges();
        let session = session_from_request(&req).unwrap_or_else(|| self.state.id().to_string());
        if wants_websocket(&req) {
            return self.accept_websocket(req, session).await;
        }

        let sockets = self.state.get_websockets();
        let (active_upstream_bridges, queued_upstream_frames, queued_upstream_bytes) =
            self.upstream_bridge_runtime_status();
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
                upstream_connect_handoff: attachment.upstream_connect_handoff,
            })
            .collect::<Vec<_>>();
        let restored_attachments = attachments.len();
        let metrics = self.load_metrics(&session, js_sys::Date::now()).await?;
        Response::from_json(&RealtimeSessionStatus {
            session,
            active_websockets: sockets.len(),
            active_upstream_bridges,
            queued_upstream_frames,
            queued_upstream_bytes,
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
        let mut metrics_changed = false;
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
                self.drop_closed_upstream_bridges();
                let (active_upstream_bridges, queued_upstream_frames, queued_upstream_bytes) =
                    self.upstream_bridge_runtime_status();
                ws.send(&json!({
                    "type": "realtime_session_status",
                    "context": context,
                    "metrics": metrics,
                    "active_upstream_bridges": active_upstream_bridges,
                    "queued_upstream_frames": queued_upstream_frames,
                    "queued_upstream_bytes": queued_upstream_bytes
                }))?;
            }
            WebSocketIncomingMessage::String(message) => {
                let summary = realtime_text_control_summary(&message);
                if let Some(rejection) = realtime_text_frame_guard_rejection(&message) {
                    let now_ms = js_sys::Date::now();
                    let close_action =
                        realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge);
                    metrics.record_error(
                        attachment.as_ref(),
                        now_ms,
                        REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
                    );
                    metrics.record_bridge_terminal_event(
                        attachment.as_ref(),
                        now_ms,
                        realtime_bridge_terminal_event(
                            RealtimeBridgeCloseCause::FrameTooLarge,
                            close_action,
                            now_ms,
                            Some(realtime_bridge_frame_metadata_from_rejection(rejection)),
                        ),
                    );
                    metrics_changed = true;
                    let _ = ws.send(&json!({
                        "type": "realtime_session_control",
                        "status": REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
                        "frame_kind": rejection.kind.as_str(),
                        "context": context,
                        "text_chars": summary.text_chars,
                        "text_bytes": rejection.bytes,
                        "max_bytes": rejection.max_bytes
                    }));
                    if let Some(attachment) = attachment.as_ref() {
                        self.close_upstream_bridge_for(attachment, close_action);
                    }
                    let _ = ws.close(
                        Some(close_action.client_code),
                        Some(close_action.client_reason),
                    );
                    if metrics_changed {
                        self.store_metrics(&metrics).await?;
                    }
                    return Ok(());
                }
                match self.forward_text_to_upstream(attachment.as_ref(), message) {
                    Ok(RealtimeBridgeForwardResult::Sent)
                    | Ok(RealtimeBridgeForwardResult::Queued) => {}
                    Ok(RealtimeBridgeForwardResult::NotActive) => {
                        ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": realtime_client_message_bridge_status(
                                attachment.as_ref().map(|item| item.upstream_connect_handoff).unwrap_or(false),
                                false
                            ),
                            "context": context,
                            "text_chars": summary.text_chars,
                            "text_bytes": summary.text_bytes
                        }))?;
                    }
                    Ok(RealtimeBridgeForwardResult::Overflow(overflow)) => {
                        let now_ms = js_sys::Date::now();
                        let close_action = realtime_bridge_close_action(
                            RealtimeBridgeCloseCause::BackpressureOverflow,
                        );
                        metrics.record_error(
                            attachment.as_ref(),
                            now_ms,
                            REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
                        );
                        metrics.record_bridge_terminal_event(
                            attachment.as_ref(),
                            now_ms,
                            realtime_bridge_terminal_event(
                                RealtimeBridgeCloseCause::BackpressureOverflow,
                                close_action,
                                now_ms,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Text,
                                    bytes: summary.text_bytes,
                                    max_bytes: None,
                                }),
                            ),
                        );
                        metrics_changed = true;
                        let _ = ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
                            "context": context,
                            "text_chars": summary.text_chars,
                            "text_bytes": summary.text_bytes,
                            "pending_frames": overflow.pending_frames,
                            "pending_bytes": overflow.pending_bytes,
                            "max_pending_frames": MAX_REALTIME_BRIDGE_PENDING_FRAMES,
                            "max_pending_bytes": MAX_REALTIME_BRIDGE_PENDING_BYTES
                        }));
                        if let Some(attachment) = attachment.as_ref() {
                            self.close_upstream_bridge_for(attachment, close_action);
                        }
                        let _ = ws.close(
                            Some(close_action.client_code),
                            Some(close_action.client_reason),
                        );
                    }
                    Err(_) => {
                        let now_ms = js_sys::Date::now();
                        let close_action = realtime_bridge_close_action(
                            RealtimeBridgeCloseCause::ClientToUpstreamSendFailed,
                        );
                        metrics.record_error(
                            attachment.as_ref(),
                            now_ms,
                            REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
                        );
                        metrics.record_bridge_terminal_event(
                            attachment.as_ref(),
                            now_ms,
                            realtime_bridge_terminal_event(
                                RealtimeBridgeCloseCause::ClientToUpstreamSendFailed,
                                close_action,
                                now_ms,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Text,
                                    bytes: summary.text_bytes,
                                    max_bytes: None,
                                }),
                            ),
                        );
                        metrics_changed = true;
                        let _ = ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
                            "context": context,
                            "text_chars": summary.text_chars,
                            "text_bytes": summary.text_bytes
                        }));
                        if let Some(attachment) = attachment.as_ref() {
                            self.close_upstream_bridge_for(attachment, close_action);
                        }
                        let _ = ws.close(
                            Some(close_action.client_code),
                            Some(close_action.client_reason),
                        );
                    }
                }
            }
            WebSocketIncomingMessage::Binary(bytes) => {
                if let Some(rejection) = realtime_binary_frame_guard_rejection(&bytes) {
                    let now_ms = js_sys::Date::now();
                    let close_action =
                        realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge);
                    metrics.record_error(
                        attachment.as_ref(),
                        now_ms,
                        REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
                    );
                    metrics.record_bridge_terminal_event(
                        attachment.as_ref(),
                        now_ms,
                        realtime_bridge_terminal_event(
                            RealtimeBridgeCloseCause::FrameTooLarge,
                            close_action,
                            now_ms,
                            Some(realtime_bridge_frame_metadata_from_rejection(rejection)),
                        ),
                    );
                    metrics_changed = true;
                    let _ = ws.send(&json!({
                        "type": "realtime_session_control",
                        "status": REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
                        "frame_kind": rejection.kind.as_str(),
                        "context": context,
                        "binary_bytes": rejection.bytes,
                        "max_bytes": rejection.max_bytes
                    }));
                    if let Some(attachment) = attachment.as_ref() {
                        self.close_upstream_bridge_for(attachment, close_action);
                    }
                    let _ = ws.close(
                        Some(close_action.client_code),
                        Some(close_action.client_reason),
                    );
                    if metrics_changed {
                        self.store_metrics(&metrics).await?;
                    }
                    return Ok(());
                }
                let binary_bytes = bytes.len();
                match self.forward_binary_to_upstream(attachment.as_ref(), bytes) {
                    Ok(RealtimeBridgeForwardResult::Sent)
                    | Ok(RealtimeBridgeForwardResult::Queued) => {}
                    Ok(RealtimeBridgeForwardResult::NotActive) => {
                        ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": realtime_client_message_bridge_status(
                                attachment.as_ref().map(|item| item.upstream_connect_handoff).unwrap_or(false),
                                false
                            ),
                            "context": context,
                            "binary_bytes": binary_bytes
                        }))?;
                    }
                    Ok(RealtimeBridgeForwardResult::Overflow(overflow)) => {
                        let now_ms = js_sys::Date::now();
                        let close_action = realtime_bridge_close_action(
                            RealtimeBridgeCloseCause::BackpressureOverflow,
                        );
                        metrics.record_error(
                            attachment.as_ref(),
                            now_ms,
                            REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
                        );
                        metrics.record_bridge_terminal_event(
                            attachment.as_ref(),
                            now_ms,
                            realtime_bridge_terminal_event(
                                RealtimeBridgeCloseCause::BackpressureOverflow,
                                close_action,
                                now_ms,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Binary,
                                    bytes: binary_bytes,
                                    max_bytes: None,
                                }),
                            ),
                        );
                        metrics_changed = true;
                        let _ = ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
                            "context": context,
                            "binary_bytes": binary_bytes,
                            "pending_frames": overflow.pending_frames,
                            "pending_bytes": overflow.pending_bytes,
                            "max_pending_frames": MAX_REALTIME_BRIDGE_PENDING_FRAMES,
                            "max_pending_bytes": MAX_REALTIME_BRIDGE_PENDING_BYTES
                        }));
                        if let Some(attachment) = attachment.as_ref() {
                            self.close_upstream_bridge_for(attachment, close_action);
                        }
                        let _ = ws.close(
                            Some(close_action.client_code),
                            Some(close_action.client_reason),
                        );
                    }
                    Err(_) => {
                        let now_ms = js_sys::Date::now();
                        let close_action = realtime_bridge_close_action(
                            RealtimeBridgeCloseCause::ClientToUpstreamSendFailed,
                        );
                        metrics.record_error(
                            attachment.as_ref(),
                            now_ms,
                            REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
                        );
                        metrics.record_bridge_terminal_event(
                            attachment.as_ref(),
                            now_ms,
                            realtime_bridge_terminal_event(
                                RealtimeBridgeCloseCause::ClientToUpstreamSendFailed,
                                close_action,
                                now_ms,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Binary,
                                    bytes: binary_bytes,
                                    max_bytes: None,
                                }),
                            ),
                        );
                        metrics_changed = true;
                        let _ = ws.send(&json!({
                            "type": "realtime_session_control",
                            "status": REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
                            "context": context,
                            "binary_bytes": binary_bytes
                        }));
                        if let Some(attachment) = attachment.as_ref() {
                            self.close_upstream_bridge_for(attachment, close_action);
                        }
                        let _ = ws.close(
                            Some(close_action.client_code),
                            Some(close_action.client_reason),
                        );
                    }
                }
            }
        }
        if metrics_changed {
            self.store_metrics(&metrics).await?;
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
        let action = realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientClosed);
        if let Some(attachment) = attachment.as_ref() {
            self.close_upstream_bridge_for(attachment, action);
        }
        let mut metrics = self.load_metrics(&session, now_ms).await?;
        metrics.record_close(attachment.as_ref(), now_ms, code, &reason);
        if !realtime_bridge_generated_close_reason(&reason) {
            metrics.record_bridge_terminal_event(
                attachment.as_ref(),
                now_ms,
                realtime_bridge_terminal_event(
                    RealtimeBridgeCloseCause::ClientClosed,
                    action,
                    now_ms,
                    None,
                ),
            );
        }
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
        let action = realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientError);
        if let Some(attachment) = attachment.as_ref() {
            self.close_upstream_bridge_for(attachment, action);
        }
        let mut metrics = self.load_metrics(&session, now_ms).await?;
        metrics.record_error(attachment.as_ref(), now_ms, &error.to_string());
        metrics.record_bridge_terminal_event(
            attachment.as_ref(),
            now_ms,
            realtime_bridge_terminal_event(
                RealtimeBridgeCloseCause::ClientError,
                action,
                now_ms,
                None,
            ),
        );
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
        let handoff = realtime_upstream_connect_handoff_from_request(&req);
        server.serialize_attachment(attachment.clone())?;
        let tag = format!("{SESSION_TAG_PREFIX}{session}");
        self.state
            .accept_websocket_with_tags(&server, &[tag.as_str()]);
        let now_ms = js_sys::Date::now();
        let mut metrics = self.load_metrics(&attachment.session, now_ms).await?;
        metrics.record_connect(&attachment, now_ms);
        if let Some(handoff) = handoff.as_ref() {
            if self
                .start_upstream_bridge(&server, &attachment, handoff)
                .await
                .is_err()
            {
                worker::console_warn!("RealtimeSession upstream bridge connect failed");
                let now_ms = js_sys::Date::now();
                let action =
                    realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamConnectFailed);
                metrics.record_error(
                    Some(&attachment),
                    now_ms,
                    REALTIME_BRIDGE_REASON_CONNECT_FAILED,
                );
                metrics.record_bridge_terminal_event(
                    Some(&attachment),
                    now_ms,
                    realtime_bridge_terminal_event(
                        RealtimeBridgeCloseCause::UpstreamConnectFailed,
                        action,
                        now_ms,
                        None,
                    ),
                );
                let _ = server.close(Some(action.client_code), Some(action.client_reason));
            }
        }
        self.store_metrics(&metrics).await?;
        Response::from_websocket(client)
    }

    async fn start_upstream_bridge(
        &mut self,
        client: &WebSocket,
        attachment: &SocketAttachment,
        handoff: &RealtimeUpstreamBridgeConnectHandoff,
    ) -> WorkerResult<()> {
        let upstream = connect_realtime_upstream(handoff).await?;
        let bridge_key = realtime_upstream_bridge_key(attachment);
        let context = attachment_context_json(Some(attachment));
        let runtime = RealtimeUpstreamBridgeRuntime {
            state: Rc::new(RefCell::new(RealtimeUpstreamBridgeState {
                upstream,
                upstream_ready: false,
                closed: false,
                pending: RealtimeBridgePendingQueue::default(),
            })),
        };
        spawn_realtime_upstream_event_pump(
            runtime.state.clone(),
            client.clone(),
            attachment.clone(),
            self.state.storage(),
            context,
            handoff.startup_queue_probe_delay_ms,
            handoff.mock_upstream_fault,
            handoff.billing_settlement.clone(),
        );
        self.upstream_bridges.insert(bridge_key, runtime);
        Ok(())
    }

    fn forward_text_to_upstream(
        &mut self,
        attachment: Option<&SocketAttachment>,
        message: String,
    ) -> WorkerResult<RealtimeBridgeForwardResult> {
        self.forward_frame_to_upstream(attachment, RealtimeBridgeQueuedFrame::Text(message))
    }

    fn forward_binary_to_upstream(
        &mut self,
        attachment: Option<&SocketAttachment>,
        bytes: Vec<u8>,
    ) -> WorkerResult<RealtimeBridgeForwardResult> {
        self.forward_frame_to_upstream(attachment, RealtimeBridgeQueuedFrame::Binary(bytes))
    }

    fn forward_frame_to_upstream(
        &mut self,
        attachment: Option<&SocketAttachment>,
        frame: RealtimeBridgeQueuedFrame,
    ) -> WorkerResult<RealtimeBridgeForwardResult> {
        self.drop_closed_upstream_bridges();
        let Some(runtime) = attachment.and_then(|item| {
            self.upstream_bridges
                .get(&realtime_upstream_bridge_key(item))
        }) else {
            return Ok(RealtimeBridgeForwardResult::NotActive);
        };

        let mut state = runtime.state.borrow_mut();
        if state.closed {
            return Ok(RealtimeBridgeForwardResult::NotActive);
        }
        if state.upstream_ready && state.pending.is_empty() {
            frame.send_to_upstream(&state.upstream)?;
            return Ok(RealtimeBridgeForwardResult::Sent);
        }

        match state
            .pending
            .try_enqueue(realtime_bridge_backpressure_policy(), frame)
        {
            Ok(_) => Ok(RealtimeBridgeForwardResult::Queued),
            Err(overflow) => Ok(RealtimeBridgeForwardResult::Overflow(overflow)),
        }
    }

    fn close_upstream_bridge_for(
        &mut self,
        attachment: &SocketAttachment,
        action: RealtimeBridgeCloseAction,
    ) {
        if let Some(runtime) = self
            .upstream_bridges
            .remove(&realtime_upstream_bridge_key(attachment))
        {
            close_realtime_upstream_runtime(&runtime.state, action);
        }
    }

    fn drop_closed_upstream_bridges(&mut self) {
        self.upstream_bridges
            .retain(|_, runtime| !runtime.state.borrow().closed);
    }

    fn upstream_bridge_runtime_status(&self) -> (usize, usize, usize) {
        let mut active = 0;
        let mut queued_frames = 0;
        let mut queued_bytes = 0;
        for runtime in self.upstream_bridges.values() {
            let state = runtime.state.borrow();
            if state.closed {
                continue;
            }
            active += 1;
            queued_frames += state.pending.len();
            queued_bytes += state.pending.bytes();
        }
        (active, queued_frames, queued_bytes)
    }

    async fn load_metrics(
        &self,
        session: &str,
        now_ms: f64,
    ) -> WorkerResult<RealtimeSessionMetrics> {
        let storage = self.state.storage();
        load_realtime_session_metrics(&storage, session, now_ms).await
    }

    async fn store_metrics(&self, metrics: &RealtimeSessionMetrics) -> WorkerResult<()> {
        let mut storage = self.state.storage();
        store_realtime_session_metrics(&mut storage, metrics).await
    }
}

async fn load_realtime_session_metrics(
    storage: &Storage,
    session: &str,
    now_ms: f64,
) -> WorkerResult<RealtimeSessionMetrics> {
    match storage
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

async fn store_realtime_session_metrics(
    storage: &mut Storage,
    metrics: &RealtimeSessionMetrics,
) -> WorkerResult<()> {
    storage.put(SESSION_METRICS_KEY, metrics).await
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
            usage_event_count: 0,
            last_usage_at_ms: None,
            last_usage: None,
            billing_snapshot_count: 0,
            last_billing_snapshot_at_ms: None,
            last_billing_snapshot: None,
            billing_settlement_preview_count: 0,
            last_billing_settlement_preview_at_ms: None,
            last_billing_settlement_preview: None,
            last_bridge_terminal_event: None,
        }
    }

    fn record_connect(&mut self, attachment: &SocketAttachment, now_ms: f64) {
        self.connected_count = self.connected_count.saturating_add(1);
        self.last_connected_at_ms = Some(now_ms);
        self.record_context(Some(attachment), now_ms);
        self.record_billing_snapshot(Some(attachment), now_ms);
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

    fn record_bridge_terminal_event(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        event: RealtimeBridgeTerminalEvent,
    ) {
        self.last_bridge_terminal_event = Some(event);
        self.record_context(attachment, now_ms);
    }

    fn record_realtime_usage(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        usage: RealtimeUsageMetadata,
        billing_settlement: Option<&RealtimeBillingSettlementHandoff>,
    ) {
        let preview = billing_settlement.and_then(|handoff| {
            realtime_billing_settlement_preview(&handoff.snapshot, &usage, handoff.request.clone())
                .map_err(|err| {
                    worker::console_warn!(
                        "RealtimeSession billing settlement preview failed: {}",
                        err
                    );
                    err
                })
                .ok()
        });
        self.usage_event_count = self.usage_event_count.saturating_add(1);
        self.last_usage_at_ms = Some(now_ms);
        self.last_usage = Some(usage);
        self.record_context(attachment, now_ms);
        if let Some(preview) = preview {
            self.record_billing_settlement_preview(attachment, now_ms, preview);
        }
    }

    fn record_billing_snapshot(&mut self, attachment: Option<&SocketAttachment>, now_ms: f64) {
        let Some(snapshot) = attachment
            .and_then(|attachment| attachment.upstream.as_ref())
            .and_then(|upstream| upstream.billing_snapshot.clone())
        else {
            return;
        };
        self.billing_snapshot_count = self.billing_snapshot_count.saturating_add(1);
        self.last_billing_snapshot_at_ms = Some(now_ms);
        self.last_billing_snapshot = Some(snapshot);
        self.record_context(attachment, now_ms);
    }

    fn record_billing_settlement_preview(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        preview: RealtimeBillingSettlementPreviewMetadata,
    ) {
        self.billing_settlement_preview_count =
            self.billing_settlement_preview_count.saturating_add(1);
        self.last_billing_settlement_preview_at_ms = Some(now_ms);
        self.last_billing_settlement_preview = Some(preview);
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

    let req = platform_realtime_gateway_request(&req)?;
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
        &req,
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
    let req = attach_realtime_upstream_headers(req, &upstream_plan)?;
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
        upstream_connect_handoff: realtime_upstream_connect_handoff_from_request(req).is_some(),
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
            "upstream": attachment.upstream,
            "upstream_connect_handoff": attachment.upstream_connect_handoff
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
        billing_snapshot: None,
        billing_settlement: None,
        startup_queue_probe_delay_ms: None,
        mock_upstream_fault: None,
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

pub(crate) fn realtime_upstream_connect_handoff_compiled() -> bool {
    if !REALTIME_UPSTREAM_CONNECT_HANDOFF_COMPILED {
        return false;
    }
    let secret = "connect-handoff-smoke-key";
    let Ok(selected) = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
        selected_group: "default",
        channel_id: 1,
        channel_type: 1,
        channel_name: "openai-primary",
        channel_base_url: Some("https://api.openai.com"),
        request_model: "gpt-4o-realtime-preview",
        upstream_model: "gpt-4o-realtime-preview",
        upstream_api_key: secret,
        api_version: None,
        client_requested_subprotocol: true,
        billing_snapshot: None,
        billing_settlement: None,
        startup_queue_probe_delay_ms: None,
        mock_upstream_fault: None,
    }) else {
        return false;
    };
    let Ok(plan_header) = realtime_upstream_plan_header_value(&selected.plan) else {
        return false;
    };
    let Ok(connect_header) = realtime_upstream_connect_header_value(&selected.connect_handoff)
    else {
        return false;
    };
    let Some(decoded) = realtime_upstream_connect_handoff_from_header_value(&connect_header) else {
        return false;
    };
    let Ok(fetch_plan) = realtime_upstream_fetch_request_plan(&decoded) else {
        return false;
    };

    !plan_header.contains(secret)
        && connect_header.contains(secret)
        && fetch_plan.fetch_url
            == "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
        && fetch_plan.upgrade == "websocket"
        && fetch_plan
            .protocol_header
            .as_deref()
            .unwrap_or_default()
            .contains(secret)
}

pub(crate) fn realtime_upstream_fetch_upgrade_adapter_compiled() -> bool {
    if !REALTIME_UPSTREAM_FETCH_UPGRADE_ADAPTER_COMPILED {
        return false;
    }
    let secret = "fetch-upgrade-smoke-key";
    let Ok(selected) = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
        selected_group: "default",
        channel_id: 1,
        channel_type: 1,
        channel_name: "openai-primary",
        channel_base_url: Some("https://api.openai.com"),
        request_model: "gpt-4o-realtime-preview",
        upstream_model: "gpt-4o-realtime-preview",
        upstream_api_key: secret,
        api_version: None,
        client_requested_subprotocol: false,
        billing_snapshot: None,
        billing_settlement: None,
        startup_queue_probe_delay_ms: None,
        mock_upstream_fault: None,
    }) else {
        return false;
    };
    let Ok(fetch_plan) = realtime_upstream_fetch_request_plan(&selected.connect_handoff) else {
        return false;
    };

    fetch_plan.fetch_url == "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
        && fetch_plan.upgrade == "websocket"
        && fetch_plan.protocol_header.is_none()
        && fetch_plan.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("authorization") && value == &format!("Bearer {secret}")
        })
        && fetch_plan
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("openai-beta") && value == "realtime=v1")
}

pub(crate) fn realtime_upstream_bridge_lifecycle_compiled() -> bool {
    REALTIME_UPSTREAM_BRIDGE_LIFECYCLE_COMPILED
        && realtime_client_message_bridge_status(false, false) == "upstream_bridge_not_wired"
        && realtime_client_message_bridge_status(true, false) == "upstream_bridge_not_active"
        && realtime_client_message_bridge_status(true, true) == "upstream_bridge_active"
        && realtime_client_close_code_from_upstream(1000) == 1000
        && realtime_client_close_code_from_upstream(1005) == 1011
        && realtime_client_close_code_from_upstream(4000) == 4000
}

pub(crate) fn realtime_upstream_bridge_frame_guard_compiled() -> bool {
    REALTIME_UPSTREAM_BRIDGE_FRAME_GUARD_COMPILED
        && realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Text,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
        )
        .is_none()
        && realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Text,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
        )
        .is_some_and(|rejection| {
            rejection.kind == RealtimeBridgeFrameKind::Text
                && rejection.bytes == MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1
                && rejection.max_bytes == MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES
        })
        && realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Binary,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
        )
        .is_none()
        && realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Binary,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES + 1,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
        )
        .is_some_and(|rejection| {
            rejection.kind == RealtimeBridgeFrameKind::Binary
                && rejection.bytes == MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES + 1
                && rejection.max_bytes == MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES
        })
        && REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE == 1009
}

pub(crate) fn realtime_upstream_bridge_close_mapping_compiled() -> bool {
    let normal = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1000));
    let reserved = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1006));
    let app = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(4000));
    let frame_too_large = realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge);
    let client_closed = realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientClosed);
    let client_error = realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientError);
    let upstream_error = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamError);

    REALTIME_UPSTREAM_BRIDGE_CLOSE_MAPPING_COMPILED
        && normal.client_code == REALTIME_BRIDGE_NORMAL_CLOSE_CODE
        && normal.client_reason == REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED
        && normal.upstream_code.is_none()
        && reserved.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && reserved.client_reason == REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED
        && app.client_code == 4000
        && frame_too_large.client_code == REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE
        && frame_too_large.client_reason == REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE
        && frame_too_large.upstream_code == Some(REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE)
        && frame_too_large.upstream_reason == Some(REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE)
        && client_closed.upstream_code == Some(REALTIME_BRIDGE_NORMAL_CLOSE_CODE)
        && client_closed.upstream_reason == Some(REALTIME_BRIDGE_REASON_CLIENT_CLOSED)
        && client_error.upstream_code == Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE)
        && client_error.upstream_reason == Some(REALTIME_BRIDGE_REASON_CLIENT_ERROR)
        && upstream_error.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && upstream_error.client_reason == REALTIME_BRIDGE_REASON_UPSTREAM_ERROR
}

pub(crate) fn realtime_upstream_bridge_send_failure_guard_compiled() -> bool {
    let upstream_forward =
        realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientToUpstreamSendFailed);
    let client_forward =
        realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamToClientSendFailed);

    REALTIME_UPSTREAM_BRIDGE_SEND_FAILURE_GUARD_COMPILED
        && upstream_forward.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && upstream_forward.client_reason == REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED
        && upstream_forward.upstream_code == Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE)
        && upstream_forward.upstream_reason == Some(REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED)
        && client_forward.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && client_forward.client_reason == REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED
        && client_forward.upstream_code == Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE)
        && client_forward.upstream_reason == Some(REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED)
}

pub(crate) fn realtime_upstream_bridge_event_trace_compiled() -> bool {
    let close_action = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1006));
    let close_event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::UpstreamClosed(1006),
        close_action,
        10.0,
        None,
    );
    let frame_action = realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge);
    let frame_event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::FrameTooLarge,
        frame_action,
        11.0,
        Some(RealtimeBridgeFrameMetadata {
            kind: RealtimeBridgeFrameKind::Text,
            bytes: MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
            max_bytes: Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES),
        }),
    );
    let send_action =
        realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamToClientSendFailed);
    let send_event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::UpstreamToClientSendFailed,
        send_action,
        12.0,
        Some(RealtimeBridgeFrameMetadata {
            kind: RealtimeBridgeFrameKind::Binary,
            bytes: 32,
            max_bytes: None,
        }),
    );
    let backpressure_action =
        realtime_bridge_close_action(RealtimeBridgeCloseCause::BackpressureOverflow);
    let backpressure_event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::BackpressureOverflow,
        backpressure_action,
        13.0,
        Some(RealtimeBridgeFrameMetadata {
            kind: RealtimeBridgeFrameKind::Text,
            bytes: 1024,
            max_bytes: None,
        }),
    );

    REALTIME_UPSTREAM_BRIDGE_EVENT_TRACE_COMPILED
        && close_event.event == "upstream_closed"
        && close_event.direction == "upstream_to_client"
        && close_event.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && close_event.upstream_close_code == Some(1006)
        && close_event.frame_kind.is_none()
        && frame_event.event == "frame_too_large"
        && frame_event.client_code == REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE
        && frame_event.frame_kind.as_deref() == Some("text")
        && frame_event.frame_bytes == Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1)
        && frame_event.frame_max_bytes == Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES)
        && send_event.event == "upstream_to_client_send_failed"
        && send_event.client_reason == REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED
        && send_event.upstream_reason.as_deref()
            == Some(REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED)
        && send_event.frame_kind.as_deref() == Some("binary")
        && send_event.frame_bytes == Some(32)
        && send_event.frame_max_bytes.is_none()
        && backpressure_event.event == "backpressure_overflow"
        && backpressure_event.direction == "bridge"
        && backpressure_event.client_reason == REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW
        && backpressure_event.upstream_reason.as_deref()
            == Some(REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW)
        && backpressure_event.frame_kind.as_deref() == Some("text")
        && backpressure_event.frame_bytes == Some(1024)
        && backpressure_event.frame_max_bytes.is_none()
}

pub(crate) fn realtime_upstream_bridge_replay_contract_compiled() -> bool {
    REALTIME_UPSTREAM_BRIDGE_REPLAY_CONTRACT_COMPILED
        && realtime_client_message_bridge_status(true, true) == "upstream_bridge_active"
        && realtime_client_message_bridge_status(true, false) == "upstream_bridge_not_active"
        && realtime_bridge_replay_contract_scenarios()
            .iter()
            .all(realtime_bridge_replay_scenario_matches)
}

pub(crate) fn realtime_upstream_bridge_backpressure_policy_compiled() -> bool {
    if !REALTIME_UPSTREAM_BRIDGE_BACKPRESSURE_POLICY_COMPILED {
        return false;
    }
    let policy = realtime_bridge_backpressure_policy();
    let frame = RealtimeBridgeFrameMetadata {
        kind: RealtimeBridgeFrameKind::Text,
        bytes: 1024,
        max_bytes: None,
    };
    let empty = RealtimeBridgeQueueState {
        pending_frames: 0,
        pending_bytes: 0,
    };
    let queued = RealtimeBridgeQueueState {
        pending_frames: 1,
        pending_bytes: 1024,
    };
    let full_by_frame_count = RealtimeBridgeQueueState {
        pending_frames: policy.max_pending_frames,
        pending_bytes: 0,
    };
    let full_by_bytes = RealtimeBridgeQueueState {
        pending_frames: 1,
        pending_bytes: policy.max_pending_bytes,
    };
    let overflow_action =
        realtime_bridge_close_action(RealtimeBridgeCloseCause::BackpressureOverflow);
    let overflow_event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::BackpressureOverflow,
        overflow_action,
        14.0,
        Some(frame),
    );

    policy.max_pending_frames == MAX_REALTIME_BRIDGE_PENDING_FRAMES
        && policy.max_pending_bytes == MAX_REALTIME_BRIDGE_PENDING_BYTES
        && policy.overflow_close_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && policy.overflow_reason == REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW
        && realtime_bridge_backpressure_decision(policy, empty, frame)
            == RealtimeBridgeBackpressureDecision::SendNow
        && realtime_bridge_backpressure_decision(policy, queued, frame)
            == RealtimeBridgeBackpressureDecision::Queue
        && matches!(
            realtime_bridge_backpressure_decision(policy, full_by_frame_count, frame),
            RealtimeBridgeBackpressureDecision::Overflow(overflow)
                if overflow.max_pending_frames == policy.max_pending_frames
                    && overflow.incoming_bytes == frame.bytes
        )
        && matches!(
            realtime_bridge_backpressure_decision(policy, full_by_bytes, frame),
            RealtimeBridgeBackpressureDecision::Overflow(overflow)
                if overflow.max_pending_bytes == policy.max_pending_bytes
                    && overflow.pending_bytes == policy.max_pending_bytes
        )
        && overflow_event.event == "backpressure_overflow"
        && overflow_event.direction == "bridge"
        && overflow_event.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && overflow_event.client_reason == REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW
        && overflow_event.upstream_code == Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE)
        && overflow_event.upstream_reason.as_deref()
            == Some(REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW)
        && overflow_event.frame_kind.as_deref() == Some("text")
        && overflow_event.frame_bytes == Some(frame.bytes)
        && overflow_event.frame_max_bytes.is_none()
}

pub(crate) fn realtime_upstream_bridge_backpressure_runtime_compiled() -> bool {
    if !REALTIME_UPSTREAM_BRIDGE_BACKPRESSURE_RUNTIME_COMPILED {
        return false;
    }
    let policy = realtime_bridge_backpressure_policy();
    let mut pending = RealtimeBridgePendingQueue::default();

    let first = RealtimeBridgeQueuedFrame::Text("first".to_string());
    let second = RealtimeBridgeQueuedFrame::Binary(vec![1, 2, 3]);
    let first_metadata = first.metadata();
    let second_metadata = second.metadata();

    let Ok(first_state) = pending.try_enqueue(policy, first) else {
        return false;
    };
    let Ok(second_state) = pending.try_enqueue(policy, second) else {
        return false;
    };
    let Some(popped_first) = pending.pop_front() else {
        return false;
    };
    let Some(popped_second) = pending.pop_front() else {
        return false;
    };

    let mut bounded = RealtimeBridgePendingQueue::default();
    for _ in 0..policy.max_pending_frames {
        if bounded
            .try_enqueue(policy, RealtimeBridgeQueuedFrame::Text("x".to_string()))
            .is_err()
        {
            return false;
        }
    }

    first_state.pending_frames == 1
        && first_state.pending_bytes == first_metadata.bytes
        && second_state.pending_frames == 2
        && second_state.pending_bytes == first_metadata.bytes + second_metadata.bytes
        && popped_first.metadata() == first_metadata
        && popped_second.metadata() == second_metadata
        && pending.is_empty()
        && pending.bytes() == 0
        && matches!(
            bounded.try_enqueue(policy, RealtimeBridgeQueuedFrame::Text("y".to_string())),
            Err(overflow)
                if overflow.pending_frames == policy.max_pending_frames
                    && overflow.incoming_bytes == 1
        )
}

pub(crate) fn realtime_upstream_usage_capture_compiled() -> bool {
    if !REALTIME_UPSTREAM_USAGE_CAPTURE_COMPILED {
        return false;
    }
    let Some(usage) = realtime_usage_metadata_from_upstream_text_frame(
        r#"{
            "type":"response.done",
            "response":{
                "usage":{
                    "input_tokens":1200,
                    "output_tokens":350,
                    "total_tokens":1550,
                    "input_token_details":{
                        "cached_tokens":400,
                        "audio_tokens":180
                    },
                    "output_token_details":{
                        "audio_tokens":90
                    }
                }
            },
            "secret_probe":"sk-realtime-upstream-secret"
        }"#,
    ) else {
        return false;
    };
    let serialized = serde_json::to_string(&usage).unwrap_or_default();

    usage.source_event == "response.done"
        && usage.prompt_tokens == 1200
        && usage.completion_tokens == 350
        && usage.total_tokens == 1550
        && usage.cached_tokens == 400
        && usage.audio_input_tokens == 180
        && usage.audio_output_tokens == 90
        && realtime_usage_metadata_from_upstream_text_frame(
            r#"{"type":"session.updated","usage":{"total_tokens":1}}"#,
        )
        .is_none()
        && !serialized.contains("sk-realtime-upstream-secret")
        && !serialized.contains("secret_probe")
        && !serialized.contains(OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX)
}

pub(crate) fn realtime_billing_presettlement_snapshot_compiled() -> bool {
    if !REALTIME_BILLING_PRESETTLEMENT_SNAPSHOT_COMPILED {
        return false;
    }
    let request = cinatoken_billing::RequestInput::from_json_body(json!({
        "model": "gpt-4o-realtime-preview",
        "service_tier": "fast"
    }));
    let Ok(snapshot) = cinatoken_billing::estimate_tiered_billing_snapshot_with_request(
        "gpt-4o-realtime-preview",
        r#"tier("base", p * 2 + c * 8 + ai * 3 + ao * 12)|||(param("service_tier") == "fast" ? 2 : 1)"#,
        cinatoken_billing::TokenParams {
            p: 1200.0,
            c: 0.0,
            ai: 180.0,
            ao: 0.0,
            ..cinatoken_billing::TokenParams::default()
        },
        1.25,
        request,
    ) else {
        return false;
    };
    let metadata = RealtimeBillingSnapshotMetadata::from_tiered_snapshot(&snapshot);
    let serialized = serde_json::to_string(&metadata).unwrap_or_default();

    metadata.billing_mode == "tiered_expr"
        && metadata.model_name == "gpt-4o-realtime-preview"
        && metadata.expr_hash == snapshot.expr_hash
        && metadata.expr_version == snapshot.expr_version
        && metadata.request_rule_present
        && metadata.estimated_prompt_tokens == snapshot.estimated_prompt_tokens
        && metadata.estimated_completion_tokens == snapshot.estimated_completion_tokens
        && metadata.estimated_quota_after_group == snapshot.estimated_quota_after_group.0
        && metadata.estimated_tier == snapshot.estimated_tier
        && !serialized.contains(&snapshot.expr_string)
        && !serialized.contains("service_tier")
        && !serialized.contains("fast")
        && !serialized.contains("param(")
}

pub(crate) fn realtime_billing_settlement_preview_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_PREVIEW_COMPILED {
        return false;
    }
    let request = RequestInput::from_json_body(json!({
        "model": "gpt-4o-realtime-preview",
        "service_tier": "fast"
    }));
    let Ok(snapshot) = cinatoken_billing::estimate_tiered_billing_snapshot_with_request(
        "gpt-4o-realtime-preview",
        r#"tier("detail", p * 2 + c * 10 + cr * 0.5 + img * 3 + ao * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#,
        cinatoken_billing::TokenParams {
            p: 1200.0,
            c: 0.0,
            ..cinatoken_billing::TokenParams::default()
        },
        1.0,
        request.clone(),
    ) else {
        return false;
    };
    let usage = RealtimeUsageMetadata {
        source_event: "response.done".to_string(),
        prompt_tokens: 1000,
        completion_tokens: 600,
        total_tokens: 1600,
        cached_tokens: 200,
        image_input_tokens: 100,
        audio_output_tokens: 50,
        ..RealtimeUsageMetadata::default()
    };
    let Ok(preview) = realtime_billing_settlement_preview(&snapshot, &usage, request) else {
        return false;
    };
    let serialized = serde_json::to_string(&preview).unwrap_or_default();

    preview.billing_mode == "tiered_expr"
        && preview.expr_hash == snapshot.expr_hash
        && preview.request_rule_present
        && preview.usage_source_event == "response.done"
        && preview.actual_prompt_tokens == 1000
        && preview.actual_completion_tokens == 600
        && preview.actual_total_tokens == 1600
        && preview.pre_consumed_quota == 2400
        && preview.final_quota == 8300
        && preview.refund_quota == 0
        && preview.additional_quota == 5900
        && preview.matched_tier == "detail"
        && !preview.crossed_tier
        && !serialized.contains(&snapshot.expr_string)
        && !serialized.contains("service_tier")
        && !serialized.contains("fast")
        && !serialized.contains("param(")
}

pub(crate) fn realtime_billing_settlement_handoff_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_HANDOFF_COMPILED {
        return false;
    }
    let request = RequestInput::from_json_body(json!({
        "model": "gpt-4o-realtime-preview",
        "service_tier": "fast"
    }));
    let Ok(snapshot) = cinatoken_billing::estimate_tiered_billing_snapshot_with_request(
        "gpt-4o-realtime-preview",
        r#"tier("detail", p * 2 + c * 10 + cr * 0.5 + img * 3 + ao * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#,
        cinatoken_billing::TokenParams {
            p: 1200.0,
            c: 0.0,
            ..cinatoken_billing::TokenParams::default()
        },
        1.0,
        request.clone(),
    ) else {
        return false;
    };
    let metadata = RealtimeBillingSnapshotMetadata::from_tiered_snapshot(&snapshot);
    let handoff = RealtimeBillingSettlementHandoff::new(snapshot.clone(), request);
    let Ok(selected) = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
        selected_group: "default",
        channel_id: 1,
        channel_type: 1,
        channel_name: "openai-primary",
        channel_base_url: Some("https://api.openai.com"),
        request_model: "gpt-4o-realtime-preview",
        upstream_model: "gpt-4o-realtime-preview",
        upstream_api_key: "handoff-preview-smoke-key",
        api_version: None,
        client_requested_subprotocol: true,
        billing_snapshot: Some(metadata),
        billing_settlement: Some(handoff),
        startup_queue_probe_delay_ms: None,
        mock_upstream_fault: None,
    }) else {
        return false;
    };
    let Ok(plan_header) = realtime_upstream_plan_header_value(&selected.plan) else {
        return false;
    };
    let Ok(connect_header) = realtime_upstream_connect_header_value(&selected.connect_handoff)
    else {
        return false;
    };
    let Some(decoded) = realtime_upstream_connect_handoff_from_header_value(&connect_header) else {
        return false;
    };
    let usage = RealtimeUsageMetadata {
        source_event: "response.done".to_string(),
        prompt_tokens: 1000,
        completion_tokens: 600,
        total_tokens: 1600,
        cached_tokens: 200,
        image_input_tokens: 100,
        audio_output_tokens: 50,
        ..RealtimeUsageMetadata::default()
    };
    let mut metrics = RealtimeSessionMetrics::new("handoff-preview-smoke", 1.0);
    let attachment = SocketAttachment {
        session: "handoff-preview-smoke".to_string(),
        connected_at_ms: 1.0,
        protocol: None,
        entrypoint: "v1".to_string(),
        model: Some("gpt-4o-realtime-preview".to_string()),
        token_source: Some("header".to_string()),
        token_fingerprint: Some("fp".to_string()),
        auth_state: "authenticated".to_string(),
        upstream: Some(selected.plan),
        upstream_connect_handoff: true,
    };
    metrics.record_realtime_usage(
        Some(&attachment),
        2.0,
        usage,
        decoded.billing_settlement.as_ref(),
    );
    let attachment_raw = serde_json::to_string(&attachment).unwrap_or_default();
    let metrics_raw = serde_json::to_string(&metrics).unwrap_or_default();

    decoded.billing_settlement.is_some()
        && metrics.billing_settlement_preview_count == 1
        && metrics
            .last_billing_settlement_preview
            .as_ref()
            .map(|preview| {
                preview.final_quota == 8300
                    && preview.additional_quota == 5900
                    && preview.usage_source_event == "response.done"
            })
            .unwrap_or(false)
        && !plan_header.contains(&snapshot.expr_string)
        && !plan_header.contains("service_tier")
        && !plan_header.contains("fast")
        && !attachment_raw.contains(&snapshot.expr_string)
        && !attachment_raw.contains("service_tier")
        && !attachment_raw.contains("fast")
        && !metrics_raw.contains(&snapshot.expr_string)
        && !metrics_raw.contains("service_tier")
        && !metrics_raw.contains("fast")
        && !metrics_raw.contains("param(")
}

fn realtime_billing_settlement_preview(
    snapshot: &TieredBillingSnapshot,
    usage: &RealtimeUsageMetadata,
    request: RequestInput,
) -> Result<RealtimeBillingSettlementPreviewMetadata, String> {
    let tiered_usage = usage.to_tiered_token_usage();
    let params = build_tiered_token_params(
        tiered_usage,
        false,
        detect_billing_expr_variables(&snapshot.expr_string),
    );
    let result = compute_tiered_quota_with_request(snapshot, params, request)
        .map_err(|err| format!("failed to compute realtime tiered billing preview: {err}"))?;
    Ok(RealtimeBillingSettlementPreviewMetadata::from_settlement(
        snapshot, usage, &result,
    ))
}

impl RealtimeBillingSettlementHandoff {
    pub(crate) fn new(snapshot: TieredBillingSnapshot, request: RequestInput) -> Self {
        Self { snapshot, request }
    }
}

pub(crate) fn realtime_selected_upstream(
    input: RealtimeSelectedUpstreamInput<'_>,
) -> Result<RealtimeSelectedUpstream, String> {
    let selected_group = non_empty_trimmed(input.selected_group, "selected_group")?;
    let request_model = non_empty_trimmed(input.request_model, "request_model")?;
    let upstream_model = non_empty_trimmed(input.upstream_model, "upstream_model")?;
    let bridge = realtime_upstream_bridge_connect_spec(RealtimeUpstreamBridgeInput {
        channel_type: input.channel_type,
        base_url: input.channel_base_url,
        model: &upstream_model,
        upstream_api_key: input.upstream_api_key,
        api_version: input.api_version,
        client_requested_subprotocol: input.client_requested_subprotocol,
    })?;
    let RealtimeUpstreamBridgeConnectSpec {
        redacted_plan: bridge_plan,
        protocol,
        headers,
    } = bridge;
    let plan = RealtimeSelectedUpstreamPlan {
        selected_group,
        channel_id: input.channel_id,
        channel_type: bridge_plan.channel_type,
        channel_name: truncate_text(input.channel_name, MAX_CHANNEL_NAME_CHARS),
        provider: bridge_plan.provider,
        upstream_url: bridge_plan.url.clone(),
        request_model,
        upstream_model: bridge_plan.model,
        channel_has_custom_base_url: bridge_plan.channel_has_custom_base_url,
        auth_mode: bridge_plan.auth_mode,
        protocol_redacted: bridge_plan.protocol_redacted,
        header_names: bridge_plan
            .header_names
            .into_iter()
            .map(str::to_string)
            .collect(),
        billing_snapshot: input.billing_snapshot,
        startup_queue_probe_delay_ms: input.startup_queue_probe_delay_ms,
        mock_upstream_fault: input.mock_upstream_fault,
    };
    let connect_handoff = RealtimeUpstreamBridgeConnectHandoff {
        url: plan.upstream_url.clone(),
        auth_mode: plan.auth_mode,
        protocol,
        headers: headers
            .into_iter()
            .map(|(name, value)| RealtimeUpstreamConnectHeader {
                name: name.to_string(),
                value,
            })
            .collect(),
        billing_settlement: input.billing_settlement,
        startup_queue_probe_delay_ms: input.startup_queue_probe_delay_ms,
        mock_upstream_fault: input.mock_upstream_fault,
    };
    Ok(RealtimeSelectedUpstream {
        plan,
        connect_handoff,
    })
}

pub(crate) fn realtime_selected_upstream_plan(
    input: RealtimeSelectedUpstreamInput<'_>,
) -> Result<RealtimeSelectedUpstreamPlan, String> {
    realtime_selected_upstream(input).map(|selected| selected.plan)
}

fn attach_realtime_upstream_headers(
    req: Request,
    selected: &RealtimeSelectedUpstream,
) -> WorkerResult<Request> {
    let mut req = req.clone_mut()?;
    let value = realtime_upstream_plan_header_value(&selected.plan)?;
    req.headers_mut()?
        .set(REALTIME_UPSTREAM_PLAN_HEADER, &value)?;
    let value = realtime_upstream_connect_header_value(&selected.connect_handoff)?;
    req.headers_mut()?
        .set(REALTIME_UPSTREAM_CONNECT_HEADER, &value)?;
    Ok(req)
}

fn platform_realtime_gateway_request(req: &Request) -> WorkerResult<Request> {
    let mut forwarded = req.clone_mut()?;
    let headers = forwarded.headers_mut()?;
    for name in REALTIME_INTERNAL_UPSTREAM_HEADERS {
        headers.delete(name)?;
    }
    Ok(forwarded)
}

fn is_realtime_internal_upstream_header(name: &str) -> bool {
    REALTIME_INTERNAL_UPSTREAM_HEADERS
        .iter()
        .any(|internal| internal.eq_ignore_ascii_case(name.trim()))
}

fn should_forward_platform_realtime_header(name: &str) -> bool {
    !is_realtime_internal_upstream_header(name)
}

pub(crate) fn realtime_session_platform_header_boundary_compiled() -> bool {
    REALTIME_SESSION_PLATFORM_HEADER_BOUNDARY_COMPILED
        && is_realtime_internal_upstream_header(REALTIME_UPSTREAM_PLAN_HEADER)
        && is_realtime_internal_upstream_header(REALTIME_UPSTREAM_CONNECT_HEADER)
        && should_forward_platform_realtime_header("sec-websocket-key")
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

fn realtime_upstream_connect_header_value(
    handoff: &RealtimeUpstreamBridgeConnectHandoff,
) -> WorkerResult<String> {
    let value = serde_json::to_string(handoff).map_err(|err| {
        worker::Error::RustError(format!(
            "failed to encode realtime upstream connect handoff: {err}"
        ))
    })?;
    if value.len() > MAX_UPSTREAM_CONNECT_HEADER_CHARS {
        return Err(worker::Error::RustError(format!(
            "realtime upstream connect handoff exceeds {MAX_UPSTREAM_CONNECT_HEADER_CHARS} byte header limit"
        )));
    }
    Ok(value)
}

fn realtime_upstream_connect_handoff_from_request(
    req: &Request,
) -> Option<RealtimeUpstreamBridgeConnectHandoff> {
    request_header(req, REALTIME_UPSTREAM_CONNECT_HEADER)
        .as_deref()
        .and_then(realtime_upstream_connect_handoff_from_header_value)
}

fn realtime_upstream_connect_handoff_from_header_value(
    value: &str,
) -> Option<RealtimeUpstreamBridgeConnectHandoff> {
    if value.len() > MAX_UPSTREAM_CONNECT_HEADER_CHARS {
        return None;
    }
    serde_json::from_str::<RealtimeUpstreamBridgeConnectHandoff>(value).ok()
}

fn realtime_upstream_fetch_request_plan(
    handoff: &RealtimeUpstreamBridgeConnectHandoff,
) -> Result<RealtimeUpstreamFetchRequestPlan, String> {
    let mut url = Url::parse(&handoff.url)
        .map_err(|err| format!("invalid realtime upstream connect URL: {err}"))?;
    let fetch_scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        "http" => "http",
        "https" => "https",
        other => {
            return Err(format!(
                "unsupported realtime upstream connect scheme: {other}"
            ))
        }
    };
    url.set_scheme(fetch_scheme)
        .map_err(|_| format!("failed to set realtime upstream fetch scheme to {fetch_scheme}"))?;
    let protocol_header = (!handoff.protocol.is_empty()).then(|| handoff.protocol.join(","));
    let headers = handoff
        .headers
        .iter()
        .map(|header| (header.name.clone(), header.value.clone()))
        .collect::<Vec<_>>();
    Ok(RealtimeUpstreamFetchRequestPlan {
        fetch_url: url.to_string(),
        upgrade: "websocket",
        protocol_header,
        headers,
    })
}

#[allow(dead_code)]
fn realtime_upstream_fetch_upgrade_request(
    handoff: &RealtimeUpstreamBridgeConnectHandoff,
) -> WorkerResult<Request> {
    let plan = realtime_upstream_fetch_request_plan(handoff).map_err(worker::Error::RustError)?;
    let mut request = Request::new(&plan.fetch_url, Method::Get)?;
    {
        let headers = request.headers_mut()?;
        headers.set("Upgrade", plan.upgrade)?;
        if let Some(protocol) = plan.protocol_header.as_deref() {
            headers.set("Sec-WebSocket-Protocol", protocol)?;
        }
        for (name, value) in plan.headers {
            headers.set(&name, &value)?;
        }
    }
    Ok(request)
}

async fn connect_realtime_upstream(
    handoff: &RealtimeUpstreamBridgeConnectHandoff,
) -> WorkerResult<WebSocket> {
    let request = realtime_upstream_fetch_upgrade_request(handoff)?;
    let response = Fetch::Request(request).send().await?;
    let status = response.status_code();
    response.websocket().ok_or_else(|| {
        worker::Error::RustError(format!(
            "realtime upstream did not accept WebSocket upgrade: status {status}"
        ))
    })
}

async fn record_realtime_upstream_usage(
    storage: &mut Storage,
    attachment: &SocketAttachment,
    now_ms: f64,
    usage: RealtimeUsageMetadata,
    billing_settlement: Option<&RealtimeBillingSettlementHandoff>,
) -> WorkerResult<()> {
    let mut metrics = load_realtime_session_metrics(storage, &attachment.session, now_ms).await?;
    metrics.record_realtime_usage(Some(attachment), now_ms, usage, billing_settlement);
    store_realtime_session_metrics(storage, &metrics).await
}

fn realtime_usage_metadata_from_upstream_text_frame(text: &str) -> Option<RealtimeUsageMetadata> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let source_event = value.get("type").and_then(Value::as_str)?;
    if source_event != "response.done" {
        return None;
    }
    let usage = usage_summary_from_body(text);
    RealtimeUsageMetadata::from_usage(source_event, usage)
}

impl RealtimeUsageMetadata {
    fn from_usage(source_event: &str, usage: UsageSummary) -> Option<Self> {
        realtime_usage_summary_has_tokens(&usage).then(|| Self {
            source_event: source_event.to_string(),
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_tokens: usage.cached_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            image_input_tokens: usage.image_input_tokens,
            image_output_tokens: usage.image_output_tokens,
            audio_input_tokens: usage.audio_input_tokens,
            audio_output_tokens: usage.audio_output_tokens,
        })
    }

    fn to_tiered_token_usage(&self) -> TieredTokenUsage {
        TieredTokenUsage {
            prompt_tokens: i64::from(self.prompt_tokens.max(0)),
            completion_tokens: i64::from(self.completion_tokens.max(0)),
            cached_tokens: i64::from(self.cached_tokens.max(0)),
            cache_creation_tokens: i64::from(self.cache_creation_tokens.max(0)),
            image_input_tokens: i64::from(self.image_input_tokens.max(0)),
            image_output_tokens: i64::from(self.image_output_tokens.max(0)),
            audio_input_tokens: i64::from(self.audio_input_tokens.max(0)),
            audio_output_tokens: i64::from(self.audio_output_tokens.max(0)),
            usage_semantic: UsageSemantic::OpenAi,
            ..TieredTokenUsage::default()
        }
    }
}

impl RealtimeBillingSnapshotMetadata {
    pub(crate) fn from_tiered_snapshot(snapshot: &TieredBillingSnapshot) -> Self {
        Self {
            billing_mode: snapshot.billing_mode.clone(),
            model_name: snapshot.model_name.clone(),
            expr_hash: snapshot.expr_hash.clone(),
            expr_version: snapshot.expr_version,
            request_rule_present: snapshot.request_rule_expr.is_some(),
            group_ratio: snapshot.group_ratio,
            quota_per_unit: snapshot.quota_per_unit,
            estimated_prompt_tokens: snapshot.estimated_prompt_tokens,
            estimated_completion_tokens: snapshot.estimated_completion_tokens,
            estimated_quota_after_group: snapshot.estimated_quota_after_group.0,
            estimated_tier: snapshot.estimated_tier.clone(),
        }
    }
}

impl RealtimeBillingSettlementPreviewMetadata {
    fn from_settlement(
        snapshot: &TieredBillingSnapshot,
        usage: &RealtimeUsageMetadata,
        result: &TieredBillingResult,
    ) -> Self {
        Self {
            billing_mode: snapshot.billing_mode.clone(),
            model_name: snapshot.model_name.clone(),
            expr_hash: snapshot.expr_hash.clone(),
            expr_version: snapshot.expr_version,
            request_rule_present: snapshot.request_rule_expr.is_some(),
            usage_source_event: usage.source_event.clone(),
            actual_prompt_tokens: i64::from(usage.prompt_tokens.max(0)),
            actual_completion_tokens: i64::from(usage.completion_tokens.max(0)),
            actual_total_tokens: i64::from(usage.total_tokens.max(0)),
            pre_consumed_quota: snapshot.estimated_quota_after_group.0.max(0),
            final_quota: result.settlement.final_quota.0,
            refund_quota: result.settlement.refund_quota.0,
            additional_quota: result.settlement.additional_quota.0,
            matched_tier: result.matched_tier.clone(),
            crossed_tier: result.crossed_tier,
        }
    }
}

fn realtime_usage_summary_has_tokens(usage: &UsageSummary) -> bool {
    usage.total_tokens > 0
        || usage.prompt_tokens > 0
        || usage.completion_tokens > 0
        || usage.cached_tokens > 0
        || usage.cache_creation_tokens > 0
        || usage.image_input_tokens > 0
        || usage.image_output_tokens > 0
        || usage.audio_input_tokens > 0
        || usage.audio_output_tokens > 0
}

fn spawn_realtime_upstream_event_pump(
    runtime_state: Rc<RefCell<RealtimeUpstreamBridgeState>>,
    client: WebSocket,
    attachment: SocketAttachment,
    mut metrics_storage: Storage,
    context: Value,
    startup_queue_probe_delay_ms: Option<u32>,
    mock_upstream_fault: Option<RealtimeMockUpstreamFault>,
    billing_settlement: Option<RealtimeBillingSettlementHandoff>,
) {
    wasm_bindgen_futures::spawn_local(async move {
        let upstream = runtime_state.borrow().upstream.clone();
        if mock_upstream_fault == Some(RealtimeMockUpstreamFault::EventStreamFailed) {
            let cause = RealtimeBridgeCloseCause::UpstreamEventStreamFailed;
            let action = realtime_bridge_close_action(cause);
            close_realtime_upstream_runtime(&runtime_state, action);
            send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
            let _ = client.close(Some(action.client_code), Some(action.client_reason));
            return;
        }
        let mut events = match upstream.events() {
            Ok(events) => events,
            Err(_) => {
                let cause = RealtimeBridgeCloseCause::UpstreamEventStreamFailed;
                let action = realtime_bridge_close_action(cause);
                close_realtime_upstream_runtime(&runtime_state, action);
                send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
                let _ = client.close(Some(action.client_code), Some(action.client_reason));
                return;
            }
        };
        if let Some(delay_ms) = startup_queue_probe_delay_ms.filter(|delay_ms| *delay_ms > 0) {
            Delay::from(Duration::from_millis(u64::from(delay_ms))).await;
            if runtime_state.borrow().closed {
                return;
            }
        }
        if mock_upstream_fault == Some(RealtimeMockUpstreamFault::AcceptFailed) {
            let cause = RealtimeBridgeCloseCause::UpstreamAcceptFailed;
            let action = realtime_bridge_close_action(cause);
            close_realtime_upstream_runtime(&runtime_state, action);
            send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
            let _ = client.close(Some(action.client_code), Some(action.client_reason));
            return;
        }
        if upstream.accept().is_err() {
            let cause = RealtimeBridgeCloseCause::UpstreamAcceptFailed;
            let action = realtime_bridge_close_action(cause);
            close_realtime_upstream_runtime(&runtime_state, action);
            send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
            let _ = client.close(Some(action.client_code), Some(action.client_reason));
            return;
        }
        let drain_failure = {
            let mut state = runtime_state.borrow_mut();
            if state.closed {
                return;
            }
            state.upstream_ready = true;
            realtime_bridge_drain_pending_to_upstream(&mut state).err()
        };
        if let Some(failure) = drain_failure {
            let cause = RealtimeBridgeCloseCause::ClientToUpstreamSendFailed;
            let action = realtime_bridge_close_action(cause);
            close_realtime_upstream_runtime(&runtime_state, action);
            send_realtime_bridge_terminal_event(
                &client,
                &context,
                cause,
                action,
                Some(failure.frame),
            );
            let _ = client.close(Some(action.client_code), Some(action.client_reason));
            return;
        }

        while let Some(event) = events.next().await {
            match event {
                Ok(WebsocketEvent::Message(message)) => {
                    if let Some(text) = message.text() {
                        if let Some(rejection) = realtime_text_frame_guard_rejection(&text) {
                            let cause = RealtimeBridgeCloseCause::FrameTooLarge;
                            let action = realtime_bridge_close_action(cause);
                            send_realtime_bridge_terminal_event(
                                &client,
                                &context,
                                cause,
                                action,
                                Some(realtime_bridge_frame_metadata_from_rejection(rejection)),
                            );
                            close_realtime_upstream_runtime(&runtime_state, action);
                            let _ =
                                client.close(Some(action.client_code), Some(action.client_reason));
                            break;
                        }
                        if let Some(usage) = realtime_usage_metadata_from_upstream_text_frame(&text)
                        {
                            let now_ms = js_sys::Date::now();
                            if record_realtime_upstream_usage(
                                &mut metrics_storage,
                                &attachment,
                                now_ms,
                                usage,
                                billing_settlement.as_ref(),
                            )
                            .await
                            .is_err()
                            {
                                worker::console_warn!(
                                    "RealtimeSession upstream usage metadata capture failed"
                                );
                            }
                        }
                        let text_bytes = text.as_bytes().len();
                        if client.send_with_str(&text).is_err() {
                            let cause = RealtimeBridgeCloseCause::UpstreamToClientSendFailed;
                            let action = realtime_bridge_close_action(cause);
                            send_realtime_bridge_terminal_event(
                                &client,
                                &context,
                                cause,
                                action,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Text,
                                    bytes: text_bytes,
                                    max_bytes: None,
                                }),
                            );
                            close_realtime_upstream_runtime(&runtime_state, action);
                            let _ =
                                client.close(Some(action.client_code), Some(action.client_reason));
                            break;
                        }
                    } else if let Some(bytes) = message.bytes() {
                        if let Some(rejection) = realtime_binary_frame_guard_rejection(&bytes) {
                            let cause = RealtimeBridgeCloseCause::FrameTooLarge;
                            let action = realtime_bridge_close_action(cause);
                            send_realtime_bridge_terminal_event(
                                &client,
                                &context,
                                cause,
                                action,
                                Some(realtime_bridge_frame_metadata_from_rejection(rejection)),
                            );
                            close_realtime_upstream_runtime(&runtime_state, action);
                            let _ =
                                client.close(Some(action.client_code), Some(action.client_reason));
                            break;
                        }
                        let byte_len = bytes.len();
                        if client.send_with_bytes(&bytes).is_err() {
                            let cause = RealtimeBridgeCloseCause::UpstreamToClientSendFailed;
                            let action = realtime_bridge_close_action(cause);
                            send_realtime_bridge_terminal_event(
                                &client,
                                &context,
                                cause,
                                action,
                                Some(RealtimeBridgeFrameMetadata {
                                    kind: RealtimeBridgeFrameKind::Binary,
                                    bytes: byte_len,
                                    max_bytes: None,
                                }),
                            );
                            close_realtime_upstream_runtime(&runtime_state, action);
                            let _ =
                                client.close(Some(action.client_code), Some(action.client_reason));
                            break;
                        }
                    }
                }
                Ok(WebsocketEvent::Close(close)) => {
                    let cause = RealtimeBridgeCloseCause::UpstreamClosed(close.code());
                    let action = realtime_bridge_close_action(cause);
                    mark_realtime_upstream_runtime_closed(&runtime_state);
                    send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
                    let _ = client.close(Some(action.client_code), Some(action.client_reason));
                    break;
                }
                Err(_) => {
                    let cause = RealtimeBridgeCloseCause::UpstreamError;
                    let action = realtime_bridge_close_action(cause);
                    mark_realtime_upstream_runtime_closed(&runtime_state);
                    send_realtime_bridge_terminal_event(&client, &context, cause, action, None);
                    let _ = client.close(Some(action.client_code), Some(action.client_reason));
                    break;
                }
            }
        }
    });
}

fn mark_realtime_upstream_runtime_closed(runtime_state: &Rc<RefCell<RealtimeUpstreamBridgeState>>) {
    let mut state = runtime_state.borrow_mut();
    state.closed = true;
    state.upstream_ready = false;
    state.pending.clear();
}

fn close_realtime_upstream_runtime(
    runtime_state: &Rc<RefCell<RealtimeUpstreamBridgeState>>,
    action: RealtimeBridgeCloseAction,
) {
    let mut state = runtime_state.borrow_mut();
    if state.closed {
        return;
    }
    state.closed = true;
    state.upstream_ready = false;
    state.pending.clear();
    if let (Some(code), Some(reason)) = (action.upstream_code, action.upstream_reason) {
        let _ = state.upstream.close(Some(code), Some(reason));
    }
}

fn send_realtime_bridge_terminal_event(
    client: &WebSocket,
    context: &Value,
    cause: RealtimeBridgeCloseCause,
    action: RealtimeBridgeCloseAction,
    frame: Option<RealtimeBridgeFrameMetadata>,
) {
    let event = realtime_bridge_terminal_event(cause, action, js_sys::Date::now(), frame);
    let _ = client.send(&json!({
        "type": "realtime_session_bridge_event",
        "status": event.event.as_str(),
        "context": context,
        "event": &event
    }));
}

fn realtime_bridge_replay_contract_scenarios() -> [RealtimeBridgeReplayScenario; 6] {
    [
        RealtimeBridgeReplayScenario {
            name: "client_text_then_upstream_normal_close",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::UpstreamClosed(1000),
            terminal_frame: None,
            expected_event: "upstream_closed",
            expected_direction: "upstream_to_client",
            expected_client_code: REALTIME_BRIDGE_NORMAL_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED,
            expected_upstream_code: None,
            expected_upstream_reason: None,
            expected_upstream_close_code: Some(1000),
            expected_frame_kind: None,
            expected_frame_bytes: None,
            expected_frame_max_bytes: None,
        },
        RealtimeBridgeReplayScenario {
            name: "client_binary_then_upstream_reserved_close",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::UpstreamClosed(1006),
            terminal_frame: None,
            expected_event: "upstream_closed",
            expected_direction: "upstream_to_client",
            expected_client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED,
            expected_upstream_code: None,
            expected_upstream_reason: None,
            expected_upstream_close_code: Some(1006),
            expected_frame_kind: None,
            expected_frame_bytes: None,
            expected_frame_max_bytes: None,
        },
        RealtimeBridgeReplayScenario {
            name: "upstream_error_after_client_forward",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::UpstreamError,
            terminal_frame: None,
            expected_event: "upstream_error",
            expected_direction: "upstream_to_client",
            expected_client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_ERROR,
            expected_upstream_code: None,
            expected_upstream_reason: None,
            expected_upstream_close_code: None,
            expected_frame_kind: None,
            expected_frame_bytes: None,
            expected_frame_max_bytes: None,
        },
        RealtimeBridgeReplayScenario {
            name: "upstream_oversized_text_frame",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::FrameTooLarge,
            terminal_frame: Some(RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
                max_bytes: Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES),
            }),
            expected_event: "frame_too_large",
            expected_direction: "bridge",
            expected_client_code: REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
            expected_upstream_code: Some(REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE),
            expected_upstream_reason: Some(REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE),
            expected_upstream_close_code: None,
            expected_frame_kind: Some("text"),
            expected_frame_bytes: Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1),
            expected_frame_max_bytes: Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES),
        },
        RealtimeBridgeReplayScenario {
            name: "upstream_to_client_send_failure_binary",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::UpstreamToClientSendFailed,
            terminal_frame: Some(RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Binary,
                bytes: 32,
                max_bytes: None,
            }),
            expected_event: "upstream_to_client_send_failed",
            expected_direction: "upstream_to_client",
            expected_client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED,
            expected_upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            expected_upstream_reason: Some(REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED),
            expected_upstream_close_code: None,
            expected_frame_kind: Some("binary"),
            expected_frame_bytes: Some(32),
            expected_frame_max_bytes: None,
        },
        RealtimeBridgeReplayScenario {
            name: "backpressure_overflow_text",
            active_status_before_terminal: "upstream_bridge_active",
            terminal_cause: RealtimeBridgeCloseCause::BackpressureOverflow,
            terminal_frame: Some(RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: 1024,
                max_bytes: None,
            }),
            expected_event: "backpressure_overflow",
            expected_direction: "bridge",
            expected_client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            expected_client_reason: REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
            expected_upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            expected_upstream_reason: Some(REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW),
            expected_upstream_close_code: None,
            expected_frame_kind: Some("text"),
            expected_frame_bytes: Some(1024),
            expected_frame_max_bytes: None,
        },
    ]
}

fn realtime_bridge_replay_scenario_matches(scenario: &RealtimeBridgeReplayScenario) -> bool {
    let action = realtime_bridge_close_action(scenario.terminal_cause);
    let event = realtime_bridge_terminal_event(
        scenario.terminal_cause,
        action,
        13.0,
        scenario.terminal_frame,
    );
    let serialized = serde_json::to_string(&event).unwrap_or_default();

    scenario.active_status_before_terminal == "upstream_bridge_active"
        && event.event == scenario.expected_event
        && event.direction == scenario.expected_direction
        && event.client_code == scenario.expected_client_code
        && event.client_reason == scenario.expected_client_reason
        && event.upstream_code == scenario.expected_upstream_code
        && event.upstream_reason.as_deref() == scenario.expected_upstream_reason
        && event.upstream_close_code == scenario.expected_upstream_close_code
        && event.frame_kind.as_deref() == scenario.expected_frame_kind
        && event.frame_bytes == scenario.expected_frame_bytes
        && event.frame_max_bytes == scenario.expected_frame_max_bytes
        && !serialized.contains("cinatoken-bridge-replay-secret")
        && !serialized.contains(OPENAI_REALTIME_API_KEY_PROTOCOL_PREFIX)
}

fn realtime_bridge_frame_metadata_from_rejection(
    rejection: RealtimeBridgeFrameRejection,
) -> RealtimeBridgeFrameMetadata {
    RealtimeBridgeFrameMetadata {
        kind: rejection.kind,
        bytes: rejection.bytes,
        max_bytes: Some(rejection.max_bytes),
    }
}

fn realtime_bridge_terminal_event(
    cause: RealtimeBridgeCloseCause,
    action: RealtimeBridgeCloseAction,
    occurred_at_ms: f64,
    frame: Option<RealtimeBridgeFrameMetadata>,
) -> RealtimeBridgeTerminalEvent {
    let (event, direction, upstream_close_code) = realtime_bridge_terminal_event_labels(cause);
    RealtimeBridgeTerminalEvent {
        event: event.to_string(),
        direction: direction.to_string(),
        occurred_at_ms,
        client_code: action.client_code,
        client_reason: action.client_reason.to_string(),
        upstream_code: action.upstream_code,
        upstream_reason: action.upstream_reason.map(str::to_string),
        upstream_close_code,
        frame_kind: frame.map(|frame| frame.kind.as_str().to_string()),
        frame_bytes: frame.map(|frame| frame.bytes),
        frame_max_bytes: frame.and_then(|frame| frame.max_bytes),
    }
}

fn realtime_bridge_terminal_event_labels(
    cause: RealtimeBridgeCloseCause,
) -> (&'static str, &'static str, Option<u16>) {
    match cause {
        RealtimeBridgeCloseCause::ClientClosed => ("client_closed", "client_to_upstream", None),
        RealtimeBridgeCloseCause::ClientError => ("client_error", "client_to_upstream", None),
        RealtimeBridgeCloseCause::UpstreamConnectFailed => {
            ("upstream_connect_failed", "upstream_to_client", None)
        }
        RealtimeBridgeCloseCause::UpstreamEventStreamFailed => {
            ("upstream_event_stream_failed", "upstream_to_client", None)
        }
        RealtimeBridgeCloseCause::UpstreamAcceptFailed => {
            ("upstream_accept_failed", "upstream_to_client", None)
        }
        RealtimeBridgeCloseCause::FrameTooLarge => ("frame_too_large", "bridge", None),
        RealtimeBridgeCloseCause::UpstreamClosed(code) => {
            ("upstream_closed", "upstream_to_client", Some(code))
        }
        RealtimeBridgeCloseCause::UpstreamError => ("upstream_error", "upstream_to_client", None),
        RealtimeBridgeCloseCause::ClientToUpstreamSendFailed => {
            ("client_to_upstream_send_failed", "client_to_upstream", None)
        }
        RealtimeBridgeCloseCause::UpstreamToClientSendFailed => {
            ("upstream_to_client_send_failed", "upstream_to_client", None)
        }
        RealtimeBridgeCloseCause::BackpressureOverflow => ("backpressure_overflow", "bridge", None),
    }
}

fn realtime_bridge_generated_close_reason(reason: &str) -> bool {
    matches!(
        reason,
        REALTIME_BRIDGE_REASON_CONNECT_FAILED
            | REALTIME_BRIDGE_REASON_EVENT_STREAM_FAILED
            | REALTIME_BRIDGE_REASON_ACCEPT_FAILED
            | REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE
            | REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED
            | REALTIME_BRIDGE_REASON_UPSTREAM_ERROR
            | REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED
            | REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED
            | REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW
    )
}

impl RealtimeBridgeFrameKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Binary => "binary",
        }
    }
}

impl RealtimeBridgePendingQueue {
    fn state(&self) -> RealtimeBridgeQueueState {
        RealtimeBridgeQueueState {
            pending_frames: self.frames.len(),
            pending_bytes: self.bytes,
        }
    }

    fn len(&self) -> usize {
        self.frames.len()
    }

    fn bytes(&self) -> usize {
        self.bytes
    }

    fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    fn try_enqueue(
        &mut self,
        policy: RealtimeBridgeBackpressurePolicy,
        frame: RealtimeBridgeQueuedFrame,
    ) -> Result<RealtimeBridgeQueueState, RealtimeBridgeBackpressureOverflow> {
        let metadata = frame.metadata();
        match realtime_bridge_backpressure_decision(policy, self.state(), metadata) {
            RealtimeBridgeBackpressureDecision::Overflow(overflow) => Err(overflow),
            RealtimeBridgeBackpressureDecision::SendNow
            | RealtimeBridgeBackpressureDecision::Queue => {
                self.bytes = self.bytes.saturating_add(metadata.bytes);
                self.frames.push_back(frame);
                Ok(self.state())
            }
        }
    }

    fn pop_front(&mut self) -> Option<RealtimeBridgeQueuedFrame> {
        let frame = self.frames.pop_front()?;
        self.bytes = self.bytes.saturating_sub(frame.metadata().bytes);
        Some(frame)
    }

    fn clear(&mut self) {
        self.frames.clear();
        self.bytes = 0;
    }
}

impl RealtimeBridgeQueuedFrame {
    fn metadata(&self) -> RealtimeBridgeFrameMetadata {
        match self {
            Self::Text(text) => RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: text.as_bytes().len(),
                max_bytes: None,
            },
            Self::Binary(bytes) => RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Binary,
                bytes: bytes.len(),
                max_bytes: None,
            },
        }
    }

    fn send_to_upstream(&self, upstream: &WebSocket) -> WorkerResult<()> {
        match self {
            Self::Text(text) => upstream.send_with_str(text),
            Self::Binary(bytes) => upstream.send_with_bytes(bytes),
        }
    }
}

fn realtime_bridge_drain_pending_to_upstream(
    state: &mut RealtimeUpstreamBridgeState,
) -> Result<usize, RealtimeBridgeDrainFailure> {
    let mut sent = 0;
    while let Some(frame) = state.pending.pop_front() {
        let metadata = frame.metadata();
        if frame.send_to_upstream(&state.upstream).is_err() {
            return Err(RealtimeBridgeDrainFailure { frame: metadata });
        }
        sent += 1;
    }
    Ok(sent)
}

fn realtime_text_frame_guard_rejection(message: &str) -> Option<RealtimeBridgeFrameRejection> {
    realtime_frame_guard_rejection(
        RealtimeBridgeFrameKind::Text,
        message.as_bytes().len(),
        MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
    )
}

fn realtime_binary_frame_guard_rejection(bytes: &[u8]) -> Option<RealtimeBridgeFrameRejection> {
    realtime_frame_guard_rejection(
        RealtimeBridgeFrameKind::Binary,
        bytes.len(),
        MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
    )
}

fn realtime_frame_guard_rejection(
    kind: RealtimeBridgeFrameKind,
    bytes: usize,
    max_bytes: usize,
) -> Option<RealtimeBridgeFrameRejection> {
    (bytes > max_bytes).then_some(RealtimeBridgeFrameRejection {
        kind,
        bytes,
        max_bytes,
    })
}

fn realtime_bridge_close_action(cause: RealtimeBridgeCloseCause) -> RealtimeBridgeCloseAction {
    match cause {
        RealtimeBridgeCloseCause::ClientClosed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_NORMAL_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_CLIENT_CLOSED,
            upstream_code: Some(REALTIME_BRIDGE_NORMAL_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_CLIENT_CLOSED),
        },
        RealtimeBridgeCloseCause::ClientError => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_CLIENT_ERROR,
            upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_CLIENT_ERROR),
        },
        RealtimeBridgeCloseCause::UpstreamConnectFailed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_CONNECT_FAILED,
            upstream_code: None,
            upstream_reason: None,
        },
        RealtimeBridgeCloseCause::UpstreamEventStreamFailed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_EVENT_STREAM_FAILED,
            upstream_code: None,
            upstream_reason: None,
        },
        RealtimeBridgeCloseCause::UpstreamAcceptFailed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_ACCEPT_FAILED,
            upstream_code: None,
            upstream_reason: None,
        },
        RealtimeBridgeCloseCause::FrameTooLarge => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
            upstream_code: Some(REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE),
        },
        RealtimeBridgeCloseCause::UpstreamClosed(code) => RealtimeBridgeCloseAction {
            client_code: realtime_client_close_code_from_upstream(code),
            client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED,
            upstream_code: None,
            upstream_reason: None,
        },
        RealtimeBridgeCloseCause::UpstreamError => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_ERROR,
            upstream_code: None,
            upstream_reason: None,
        },
        RealtimeBridgeCloseCause::ClientToUpstreamSendFailed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
            upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED),
        },
        RealtimeBridgeCloseCause::UpstreamToClientSendFailed => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED,
            upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED),
        },
        RealtimeBridgeCloseCause::BackpressureOverflow => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
            upstream_code: Some(REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE),
            upstream_reason: Some(REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW),
        },
    }
}

fn realtime_bridge_backpressure_policy() -> RealtimeBridgeBackpressurePolicy {
    RealtimeBridgeBackpressurePolicy {
        max_pending_frames: MAX_REALTIME_BRIDGE_PENDING_FRAMES,
        max_pending_bytes: MAX_REALTIME_BRIDGE_PENDING_BYTES,
        overflow_close_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
        overflow_reason: REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
    }
}

fn realtime_bridge_backpressure_decision(
    policy: RealtimeBridgeBackpressurePolicy,
    queue: RealtimeBridgeQueueState,
    frame: RealtimeBridgeFrameMetadata,
) -> RealtimeBridgeBackpressureDecision {
    if queue.pending_frames >= policy.max_pending_frames
        || queue.pending_bytes.saturating_add(frame.bytes) > policy.max_pending_bytes
    {
        return RealtimeBridgeBackpressureDecision::Overflow(RealtimeBridgeBackpressureOverflow {
            pending_frames: queue.pending_frames,
            pending_bytes: queue.pending_bytes,
            incoming_bytes: frame.bytes,
            max_pending_frames: policy.max_pending_frames,
            max_pending_bytes: policy.max_pending_bytes,
        });
    }

    if queue.pending_frames == 0 && queue.pending_bytes == 0 {
        RealtimeBridgeBackpressureDecision::SendNow
    } else {
        RealtimeBridgeBackpressureDecision::Queue
    }
}

fn realtime_upstream_bridge_key(attachment: &SocketAttachment) -> String {
    format!("{}:{:.3}", attachment.session, attachment.connected_at_ms)
}

fn realtime_client_message_bridge_status(
    upstream_connect_handoff: bool,
    active_bridge: bool,
) -> &'static str {
    if active_bridge {
        "upstream_bridge_active"
    } else if upstream_connect_handoff {
        "upstream_bridge_not_active"
    } else {
        "upstream_bridge_not_wired"
    }
}

fn realtime_client_close_code_from_upstream(code: u16) -> u16 {
    match code {
        1000..=1014 if !matches!(code, 1004 | 1005 | 1006) => code,
        3000..=4999 => code,
        _ => 1011,
    }
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
    fn platform_realtime_gateway_strips_internal_upstream_headers() {
        for name in [
            REALTIME_UPSTREAM_PLAN_HEADER,
            REALTIME_UPSTREAM_CONNECT_HEADER,
            "X-Cinatoken-Realtime-Upstream-Plan",
            " x-cinatoken-realtime-upstream-connect ",
        ] {
            assert!(is_realtime_internal_upstream_header(name));
            assert!(!should_forward_platform_realtime_header(name));
        }

        for name in ["sec-websocket-key", "upgrade", "authorization", "cookie"] {
            assert!(!is_realtime_internal_upstream_header(name));
            assert!(should_forward_platform_realtime_header(name));
        }
    }

    #[test]
    fn realtime_platform_header_boundary_self_check_is_compiled() {
        assert!(realtime_session_platform_header_boundary_compiled());
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
            upstream_connect_handoff: true,
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
        metrics.record_bridge_terminal_event(
            Some(&attachment),
            6.0,
            realtime_bridge_terminal_event(
                RealtimeBridgeCloseCause::ClientToUpstreamSendFailed,
                realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientToUpstreamSendFailed),
                6.0,
                Some(RealtimeBridgeFrameMetadata {
                    kind: RealtimeBridgeFrameKind::Text,
                    bytes: "secret client payload".len(),
                    max_bytes: None,
                }),
            ),
        );
        metrics.record_realtime_usage(
            Some(&attachment),
            7.0,
            RealtimeUsageMetadata {
                source_event: "response.done".to_string(),
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17,
                cached_tokens: 3,
                cache_creation_tokens: 0,
                image_input_tokens: 0,
                image_output_tokens: 0,
                audio_input_tokens: 2,
                audio_output_tokens: 1,
            },
            None,
        );

        assert_eq!(metrics.connected_count, 1);
        assert_eq!(metrics.text_message_count, 1);
        assert_eq!(metrics.binary_message_count, 1);
        assert_eq!(metrics.closed_count, 1);
        assert_eq!(metrics.usage_event_count, 1);
        assert_eq!(
            metrics.last_model.as_deref(),
            Some("gpt-4o-realtime-preview")
        );
        assert_eq!(metrics.last_token_source.as_deref(), Some("authorization"));
        assert_eq!(metrics.last_token_fingerprint.as_deref(), Some("fp-token"));
        assert_eq!(metrics.last_close_code, Some(1000));
        assert_eq!(metrics.last_close_reason.as_deref(), Some("normal close"));
        assert_eq!(
            metrics
                .last_bridge_terminal_event
                .as_ref()
                .map(|event| event.event.as_str()),
            Some("client_to_upstream_send_failed")
        );
        assert_eq!(
            metrics
                .last_usage
                .as_ref()
                .map(|usage| usage.source_event.as_str()),
            Some("response.done")
        );
        assert_eq!(
            metrics.last_usage.as_ref().map(|usage| usage.total_tokens),
            Some(17)
        );
        let raw = serde_json::to_string(&metrics).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("openai-insecure-api-key.sk"));
    }

    #[test]
    fn realtime_upstream_usage_capture_is_metadata_only() {
        let raw_frame = r#"{
            "type":"response.done",
            "response":{
                "usage":{
                    "input_tokens":1200,
                    "output_tokens":350,
                    "total_tokens":1550,
                    "input_token_details":{
                        "cached_tokens":400,
                        "audio_tokens":180
                    },
                    "output_token_details":{
                        "audio_tokens":90
                    }
                }
            },
            "secret_probe":"do-not-store-this"
        }"#;
        let usage = realtime_usage_metadata_from_upstream_text_frame(raw_frame).unwrap();

        assert_eq!(usage.source_event, "response.done");
        assert_eq!(usage.prompt_tokens, 1200);
        assert_eq!(usage.completion_tokens, 350);
        assert_eq!(usage.total_tokens, 1550);
        assert_eq!(usage.cached_tokens, 400);
        assert_eq!(usage.audio_input_tokens, 180);
        assert_eq!(usage.audio_output_tokens, 90);
        assert!(realtime_usage_metadata_from_upstream_text_frame(
            r#"{"type":"session.updated","usage":{"total_tokens":99}}"#
        )
        .is_none());

        let serialized = serde_json::to_string(&usage).unwrap();
        assert!(!serialized.contains("do-not-store-this"));
        assert!(!serialized.contains("secret_probe"));
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
    fn realtime_upstream_bridge_lifecycle_status_is_explicit() {
        assert_eq!(
            realtime_client_message_bridge_status(false, false),
            "upstream_bridge_not_wired"
        );
        assert_eq!(
            realtime_client_message_bridge_status(true, false),
            "upstream_bridge_not_active"
        );
        assert_eq!(
            realtime_client_message_bridge_status(true, true),
            "upstream_bridge_active"
        );
    }

    #[test]
    fn realtime_upstream_bridge_close_code_mapping_avoids_reserved_codes() {
        assert_eq!(realtime_client_close_code_from_upstream(1000), 1000);
        assert_eq!(realtime_client_close_code_from_upstream(1005), 1011);
        assert_eq!(realtime_client_close_code_from_upstream(1006), 1011);
        assert_eq!(realtime_client_close_code_from_upstream(1015), 1011);
        assert_eq!(realtime_client_close_code_from_upstream(4000), 4000);
    }

    #[test]
    fn realtime_upstream_bridge_key_is_stable_without_secrets() {
        let attachment = SocketAttachment {
            session: "rt-session".to_string(),
            connected_at_ms: 10.1234,
            protocol: Some("realtime,openai-insecure-api-key.<redacted>".to_string()),
            entrypoint: "openai_realtime_v1".to_string(),
            model: Some("gpt-4o-realtime-preview".to_string()),
            token_source: Some("authorization".to_string()),
            token_fingerprint: Some("fp-token".to_string()),
            auth_state: "gateway_checked".to_string(),
            upstream: None,
            upstream_connect_handoff: true,
        };

        let key = realtime_upstream_bridge_key(&attachment);

        assert_eq!(key, "rt-session:10.123");
        assert!(!key.contains("openai-insecure-api-key"));
    }

    #[test]
    fn realtime_upstream_bridge_frame_guard_is_byte_bounded() {
        assert!(realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Text,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
            MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
        )
        .is_none());
        assert_eq!(
            realtime_frame_guard_rejection(
                RealtimeBridgeFrameKind::Text,
                MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
                MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
            ),
            Some(RealtimeBridgeFrameRejection {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
                max_bytes: MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES,
            })
        );
        assert!(realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Binary,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
            MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
        )
        .is_none());
        assert_eq!(
            realtime_frame_guard_rejection(
                RealtimeBridgeFrameKind::Binary,
                MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES + 1,
                MAX_REALTIME_BRIDGE_BINARY_FRAME_BYTES,
            )
            .map(|rejection| rejection.kind.as_str()),
            Some("binary")
        );
        assert_eq!(REALTIME_BRIDGE_MESSAGE_TOO_BIG_CLOSE_CODE, 1009);
    }

    #[test]
    fn realtime_upstream_bridge_close_mapping_is_explicit_and_safe() {
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1000)),
            RealtimeBridgeCloseAction {
                client_code: 1000,
                client_reason: "upstream_bridge_closed",
                upstream_code: None,
                upstream_reason: None,
            }
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1006)),
            RealtimeBridgeCloseAction {
                client_code: 1011,
                client_reason: "upstream_bridge_closed",
                upstream_code: None,
                upstream_reason: None,
            }
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge),
            RealtimeBridgeCloseAction {
                client_code: 1009,
                client_reason: "upstream_bridge_frame_too_large",
                upstream_code: Some(1009),
                upstream_reason: Some("upstream_bridge_frame_too_large"),
            }
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientClosed).upstream_reason,
            Some("client_websocket_closed")
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientError).upstream_code,
            Some(1011)
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamError).client_reason,
            "upstream_bridge_error"
        );
    }

    #[test]
    fn realtime_upstream_bridge_send_failure_guard_is_fail_closed() {
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::ClientToUpstreamSendFailed),
            RealtimeBridgeCloseAction {
                client_code: 1011,
                client_reason: "upstream_bridge_forward_failed",
                upstream_code: Some(1011),
                upstream_reason: Some("upstream_bridge_forward_failed"),
            }
        );
        assert_eq!(
            realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamToClientSendFailed),
            RealtimeBridgeCloseAction {
                client_code: 1011,
                client_reason: "client_bridge_forward_failed",
                upstream_code: Some(1011),
                upstream_reason: Some("client_bridge_forward_failed"),
            }
        );
    }

    #[test]
    fn realtime_upstream_bridge_backpressure_policy_is_bounded_and_fail_closed() {
        let policy = realtime_bridge_backpressure_policy();
        assert_eq!(policy.max_pending_frames, 32);
        assert_eq!(policy.max_pending_bytes, 4 * 1_048_576);
        assert_eq!(policy.overflow_close_code, 1011);
        assert_eq!(
            policy.overflow_reason,
            "upstream_bridge_backpressure_overflow"
        );

        let frame = RealtimeBridgeFrameMetadata {
            kind: RealtimeBridgeFrameKind::Text,
            bytes: 1024,
            max_bytes: None,
        };

        assert_eq!(
            realtime_bridge_backpressure_decision(
                policy,
                RealtimeBridgeQueueState {
                    pending_frames: 0,
                    pending_bytes: 0,
                },
                frame,
            ),
            RealtimeBridgeBackpressureDecision::SendNow
        );
        assert_eq!(
            realtime_bridge_backpressure_decision(
                policy,
                RealtimeBridgeQueueState {
                    pending_frames: 1,
                    pending_bytes: 1024,
                },
                frame,
            ),
            RealtimeBridgeBackpressureDecision::Queue
        );
        assert_eq!(
            realtime_bridge_backpressure_decision(
                policy,
                RealtimeBridgeQueueState {
                    pending_frames: policy.max_pending_frames,
                    pending_bytes: 0,
                },
                frame,
            ),
            RealtimeBridgeBackpressureDecision::Overflow(RealtimeBridgeBackpressureOverflow {
                pending_frames: policy.max_pending_frames,
                pending_bytes: 0,
                incoming_bytes: 1024,
                max_pending_frames: policy.max_pending_frames,
                max_pending_bytes: policy.max_pending_bytes,
            })
        );
        assert!(matches!(
            realtime_bridge_backpressure_decision(
                policy,
                RealtimeBridgeQueueState {
                    pending_frames: 1,
                    pending_bytes: policy.max_pending_bytes,
                },
                frame,
            ),
            RealtimeBridgeBackpressureDecision::Overflow(overflow)
                if overflow.pending_bytes == policy.max_pending_bytes
                    && overflow.incoming_bytes == frame.bytes
        ));
    }

    #[test]
    fn realtime_upstream_bridge_pending_queue_is_bounded_and_fifo() {
        let policy = realtime_bridge_backpressure_policy();
        let mut queue = RealtimeBridgePendingQueue::default();

        let state = queue
            .try_enqueue(
                policy,
                RealtimeBridgeQueuedFrame::Text("client-one".to_string()),
            )
            .unwrap();
        assert_eq!(
            state,
            RealtimeBridgeQueueState {
                pending_frames: 1,
                pending_bytes: 10,
            }
        );

        let state = queue
            .try_enqueue(policy, RealtimeBridgeQueuedFrame::Binary(vec![1, 2, 3, 4]))
            .unwrap();
        assert_eq!(
            state,
            RealtimeBridgeQueueState {
                pending_frames: 2,
                pending_bytes: 14,
            }
        );

        assert!(matches!(
            queue.pop_front(),
            Some(RealtimeBridgeQueuedFrame::Text(text)) if text == "client-one"
        ));
        assert!(matches!(
            queue.pop_front(),
            Some(RealtimeBridgeQueuedFrame::Binary(bytes)) if bytes == vec![1, 2, 3, 4]
        ));
        assert!(queue.is_empty());
        assert_eq!(queue.bytes(), 0);

        for _ in 0..policy.max_pending_frames {
            queue
                .try_enqueue(policy, RealtimeBridgeQueuedFrame::Text("x".to_string()))
                .unwrap();
        }
        let overflow = queue
            .try_enqueue(policy, RealtimeBridgeQueuedFrame::Text("y".to_string()))
            .unwrap_err();
        assert_eq!(overflow.pending_frames, policy.max_pending_frames);
        assert_eq!(overflow.incoming_bytes, 1);
    }

    #[test]
    fn realtime_upstream_bridge_backpressure_overflow_event_is_metadata_only() {
        let frame = RealtimeBridgeFrameMetadata {
            kind: RealtimeBridgeFrameKind::Text,
            bytes: 1024,
            max_bytes: None,
        };
        let event = realtime_bridge_terminal_event(
            RealtimeBridgeCloseCause::BackpressureOverflow,
            realtime_bridge_close_action(RealtimeBridgeCloseCause::BackpressureOverflow),
            14.0,
            Some(frame),
        );

        assert_eq!(event.event, "backpressure_overflow");
        assert_eq!(event.direction, "bridge");
        assert_eq!(event.client_code, 1011);
        assert_eq!(event.client_reason, "upstream_bridge_backpressure_overflow");
        assert_eq!(event.upstream_code, Some(1011));
        assert_eq!(
            event.upstream_reason.as_deref(),
            Some("upstream_bridge_backpressure_overflow")
        );
        assert_eq!(event.frame_kind.as_deref(), Some("text"));
        assert_eq!(event.frame_bytes, Some(1024));
        assert!(event.frame_max_bytes.is_none());

        let raw = serde_json::to_string(&event).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("openai-insecure-api-key.sk"));
    }

    #[test]
    fn realtime_upstream_bridge_terminal_event_trace_is_metadata_only() {
        let upstream_close = realtime_bridge_terminal_event(
            RealtimeBridgeCloseCause::UpstreamClosed(1006),
            realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamClosed(1006)),
            10.0,
            None,
        );
        assert_eq!(upstream_close.event, "upstream_closed");
        assert_eq!(upstream_close.direction, "upstream_to_client");
        assert_eq!(upstream_close.client_code, 1011);
        assert_eq!(upstream_close.upstream_close_code, Some(1006));
        assert!(upstream_close.frame_kind.is_none());

        let frame_too_large = realtime_bridge_terminal_event(
            RealtimeBridgeCloseCause::FrameTooLarge,
            realtime_bridge_close_action(RealtimeBridgeCloseCause::FrameTooLarge),
            11.0,
            Some(RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1,
                max_bytes: Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES),
            }),
        );
        assert_eq!(frame_too_large.event, "frame_too_large");
        assert_eq!(frame_too_large.frame_kind.as_deref(), Some("text"));
        assert_eq!(
            frame_too_large.frame_bytes,
            Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES + 1)
        );
        assert_eq!(
            frame_too_large.frame_max_bytes,
            Some(MAX_REALTIME_BRIDGE_TEXT_FRAME_BYTES)
        );

        let raw = serde_json::to_string(&frame_too_large).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("openai-insecure-api-key.sk"));
    }

    #[test]
    fn realtime_bridge_generated_close_reasons_do_not_overwrite_specific_events() {
        for reason in [
            REALTIME_BRIDGE_REASON_CONNECT_FAILED,
            REALTIME_BRIDGE_REASON_EVENT_STREAM_FAILED,
            REALTIME_BRIDGE_REASON_ACCEPT_FAILED,
            REALTIME_BRIDGE_REASON_FRAME_TOO_LARGE,
            REALTIME_BRIDGE_REASON_UPSTREAM_CLOSED,
            REALTIME_BRIDGE_REASON_UPSTREAM_ERROR,
            REALTIME_BRIDGE_REASON_UPSTREAM_FORWARD_FAILED,
            REALTIME_BRIDGE_REASON_CLIENT_FORWARD_FAILED,
            REALTIME_BRIDGE_REASON_BACKPRESSURE_OVERFLOW,
        ] {
            assert!(realtime_bridge_generated_close_reason(reason));
        }
        assert!(!realtime_bridge_generated_close_reason(
            REALTIME_BRIDGE_REASON_CLIENT_CLOSED
        ));
    }

    #[test]
    fn realtime_text_frame_guard_counts_utf8_bytes_not_chars() {
        let text = "云".repeat(4);
        let rejection = realtime_frame_guard_rejection(
            RealtimeBridgeFrameKind::Text,
            text.as_bytes().len(),
            text.chars().count(),
        )
        .unwrap();

        assert_eq!(rejection.bytes, 12);
        assert_eq!(rejection.max_bytes, 4);
        assert_eq!(rejection.kind.as_str(), "text");
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
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
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
    fn realtime_selected_upstream_handoff_round_trips_with_request_scoped_secret() {
        let secret = "sk-live-secret";
        let selected = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
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
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
        })
        .unwrap();
        let plan_header = realtime_upstream_plan_header_value(&selected.plan).unwrap();
        let connect_header =
            realtime_upstream_connect_header_value(&selected.connect_handoff).unwrap();
        let decoded = realtime_upstream_connect_handoff_from_header_value(&connect_header).unwrap();
        let fetch_plan = realtime_upstream_fetch_request_plan(&decoded).unwrap();

        assert!(!plan_header.contains(secret));
        assert!(connect_header.contains(secret));
        assert_eq!(
            fetch_plan.fetch_url,
            "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
        );
        assert_eq!(fetch_plan.upgrade, "websocket");
        assert!(fetch_plan.headers.is_empty());
        assert!(fetch_plan
            .protocol_header
            .as_deref()
            .unwrap_or_default()
            .contains(secret));
    }

    #[test]
    fn realtime_startup_queue_probe_delay_round_trips_without_secret() {
        let secret = "sk-live-secret";
        let selected = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
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
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: Some(250),
            mock_upstream_fault: None,
        })
        .unwrap();
        let plan_header = realtime_upstream_plan_header_value(&selected.plan).unwrap();
        let connect_header =
            realtime_upstream_connect_header_value(&selected.connect_handoff).unwrap();
        let decoded_plan = realtime_upstream_plan_from_header_value(&plan_header).unwrap();
        let decoded_handoff =
            realtime_upstream_connect_handoff_from_header_value(&connect_header).unwrap();

        assert_eq!(decoded_plan.startup_queue_probe_delay_ms, Some(250));
        assert_eq!(decoded_handoff.startup_queue_probe_delay_ms, Some(250));
        assert!(!plan_header.contains(secret));
        assert!(connect_header.contains(secret));
    }

    #[test]
    fn realtime_mock_upstream_fault_round_trips_without_secret_in_plan() {
        let secret = "sk-live-secret";
        let selected = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
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
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: Some(RealtimeMockUpstreamFault::AcceptFailed),
        })
        .unwrap();
        let plan_header = realtime_upstream_plan_header_value(&selected.plan).unwrap();
        let connect_header =
            realtime_upstream_connect_header_value(&selected.connect_handoff).unwrap();
        let decoded_plan = realtime_upstream_plan_from_header_value(&plan_header).unwrap();
        let decoded_handoff =
            realtime_upstream_connect_handoff_from_header_value(&connect_header).unwrap();

        assert_eq!(
            decoded_plan.mock_upstream_fault,
            Some(RealtimeMockUpstreamFault::AcceptFailed)
        );
        assert_eq!(
            decoded_handoff.mock_upstream_fault,
            Some(RealtimeMockUpstreamFault::AcceptFailed)
        );
        assert!(!plan_header.contains(secret));
        assert!(connect_header.contains(secret));
    }

    #[test]
    fn realtime_header_auth_handoff_fetch_plan_carries_headers_only_request_scoped() {
        let secret = "sk-live-secret";
        let selected = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
            selected_group: "vip",
            channel_id: 42,
            channel_type: 1,
            channel_name: "primary-openai",
            channel_base_url: Some("https://api.openai.com"),
            request_model: "gpt-4o-realtime-preview",
            upstream_model: "gpt-4o-realtime-preview",
            upstream_api_key: secret,
            api_version: None,
            client_requested_subprotocol: false,
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
        })
        .unwrap();
        let plan_header = realtime_upstream_plan_header_value(&selected.plan).unwrap();
        let connect_header =
            realtime_upstream_connect_header_value(&selected.connect_handoff).unwrap();
        let decoded = realtime_upstream_connect_handoff_from_header_value(&connect_header).unwrap();
        let fetch_plan = realtime_upstream_fetch_request_plan(&decoded).unwrap();

        assert!(!plan_header.contains(secret));
        assert!(connect_header.contains(secret));
        assert!(fetch_plan.protocol_header.is_none());
        assert_eq!(
            fetch_plan.headers,
            vec![
                ("openai-beta".to_string(), "realtime=v1".to_string()),
                (
                    "authorization".to_string(),
                    "Bearer sk-live-secret".to_string()
                ),
            ]
        );
    }

    #[test]
    fn realtime_fetch_upgrade_adapter_contract_is_compiled() {
        assert!(realtime_upstream_fetch_upgrade_adapter_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_lifecycle_contract_is_compiled() {
        assert!(realtime_upstream_bridge_lifecycle_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_frame_guard_contract_is_compiled() {
        assert!(realtime_upstream_bridge_frame_guard_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_close_mapping_contract_is_compiled() {
        assert!(realtime_upstream_bridge_close_mapping_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_send_failure_guard_contract_is_compiled() {
        assert!(realtime_upstream_bridge_send_failure_guard_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_event_trace_contract_is_compiled() {
        assert!(realtime_upstream_bridge_event_trace_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_replay_contract_is_compiled() {
        assert!(realtime_upstream_bridge_replay_contract_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_backpressure_policy_contract_is_compiled() {
        assert!(realtime_upstream_bridge_backpressure_policy_compiled());
    }

    #[test]
    fn realtime_upstream_bridge_backpressure_runtime_contract_is_compiled() {
        assert!(realtime_upstream_bridge_backpressure_runtime_compiled());
    }

    #[test]
    fn realtime_upstream_usage_capture_contract_is_compiled() {
        assert!(realtime_upstream_usage_capture_compiled());
    }

    #[test]
    fn realtime_billing_presettlement_snapshot_contract_is_compiled() {
        assert!(realtime_billing_presettlement_snapshot_compiled());
    }

    #[test]
    fn realtime_billing_settlement_preview_contract_is_compiled() {
        assert!(realtime_billing_settlement_preview_compiled());
    }

    #[test]
    fn realtime_billing_settlement_handoff_contract_is_compiled() {
        assert!(realtime_billing_settlement_handoff_compiled());
    }

    #[test]
    fn realtime_billing_settlement_preview_is_redacted_and_uses_actual_usage() {
        let request = RequestInput::from_json_body(json!({
            "service_tier": "fast"
        }));
        let snapshot = cinatoken_billing::estimate_tiered_billing_snapshot_with_request(
            "gpt-4o-realtime-preview",
            r#"tier("detail", p * 2 + c * 10 + cr * 0.5 + img * 3 + ao * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#,
            cinatoken_billing::TokenParams {
                p: 1200.0,
                c: 0.0,
                ..cinatoken_billing::TokenParams::default()
            },
            1.0,
            request.clone(),
        )
        .unwrap();
        let usage = RealtimeUsageMetadata {
            source_event: "response.done".to_string(),
            prompt_tokens: 1000,
            completion_tokens: 600,
            total_tokens: 1600,
            cached_tokens: 200,
            image_input_tokens: 100,
            audio_output_tokens: 50,
            ..RealtimeUsageMetadata::default()
        };

        let preview = realtime_billing_settlement_preview(&snapshot, &usage, request).unwrap();
        let raw = serde_json::to_string(&preview).unwrap();

        assert_eq!(preview.pre_consumed_quota, 2400);
        assert_eq!(preview.final_quota, 8300);
        assert_eq!(preview.additional_quota, 5900);
        assert_eq!(preview.refund_quota, 0);
        assert_eq!(preview.matched_tier, "detail");
        assert!(!preview.crossed_tier);
        assert_eq!(preview.usage_source_event, "response.done");
        assert!(!raw.contains(&snapshot.expr_string));
        assert!(!raw.contains("service_tier"));
        assert!(!raw.contains("fast"));
        assert!(!raw.contains("param("));
    }

    #[test]
    fn realtime_azure_handoff_fetch_plan_carries_api_key_header() {
        let secret = "azure-secret";
        let selected = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
            selected_group: "vip",
            channel_id: 3,
            channel_type: CHANNEL_TYPE_AZURE,
            channel_name: "azure-realtime",
            channel_base_url: Some("https://example.openai.azure.com"),
            request_model: "gpt-4o-realtime-deployment",
            upstream_model: "gpt-4o-realtime-deployment",
            upstream_api_key: secret,
            api_version: Some("2025-04-01-preview"),
            client_requested_subprotocol: true,
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
        })
        .unwrap();
        let fetch_plan = realtime_upstream_fetch_request_plan(&selected.connect_handoff).unwrap();

        assert_eq!(
            fetch_plan.fetch_url,
            "https://example.openai.azure.com/openai/realtime?deployment=gpt-4o-realtime-deployment&api-version=2025-04-01-preview"
        );
        assert_eq!(fetch_plan.upgrade, "websocket");
        assert!(fetch_plan.protocol_header.is_none());
        assert_eq!(
            fetch_plan.headers,
            vec![("api-key".to_string(), secret.to_string())]
        );
    }

    #[test]
    fn realtime_connect_handoff_is_not_serialized_in_attachment_or_metrics() {
        let secret = "sk-live-secret";
        let upstream = realtime_selected_upstream_plan(RealtimeSelectedUpstreamInput {
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
            billing_snapshot: None,
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
        })
        .unwrap();
        let attachment = SocketAttachment {
            session: "rt-session".to_string(),
            connected_at_ms: 10.0,
            protocol: Some("realtime,openai-insecure-api-key.<redacted>".to_string()),
            entrypoint: "openai_realtime_v1".to_string(),
            model: Some("gpt-4o-realtime-preview".to_string()),
            token_source: Some("authorization".to_string()),
            token_fingerprint: Some("fp-token".to_string()),
            auth_state: "gateway_checked".to_string(),
            upstream: Some(upstream),
            upstream_connect_handoff: true,
        };
        let mut metrics = RealtimeSessionMetrics::new("rt-session", 1.0);
        metrics.record_connect(&attachment, 2.0);

        let attachment_raw = serde_json::to_string(&attachment).unwrap();
        let metrics_raw = serde_json::to_string(&metrics).unwrap();
        assert!(!attachment_raw.contains(secret));
        assert!(!attachment_raw.contains("Bearer sk-"));
        assert!(!metrics_raw.contains(secret));
        assert!(!metrics_raw.contains("Bearer sk-"));
        assert!(attachment_raw.contains("\"upstream_connect_handoff\":true"));
    }

    #[test]
    fn realtime_billing_snapshot_is_redacted_and_captured_in_metrics() {
        let billing_snapshot = RealtimeBillingSnapshotMetadata {
            billing_mode: "tiered_expr".to_string(),
            model_name: "gpt-4o-realtime-preview".to_string(),
            expr_hash: "exprhash123".to_string(),
            expr_version: 1,
            request_rule_present: true,
            group_ratio: 1.25,
            quota_per_unit: 500_000.0,
            estimated_prompt_tokens: 1200,
            estimated_completion_tokens: 0,
            estimated_quota_after_group: 4200,
            estimated_tier: "fast-tier".to_string(),
        };
        let upstream = realtime_selected_upstream_plan(RealtimeSelectedUpstreamInput {
            selected_group: "vip",
            channel_id: 42,
            channel_type: 1,
            channel_name: "primary-openai",
            channel_base_url: Some("https://api.openai.com"),
            request_model: "gpt-4o-realtime-preview",
            upstream_model: "gpt-4o-realtime-preview",
            upstream_api_key: "sk-live-secret",
            api_version: None,
            client_requested_subprotocol: true,
            billing_snapshot: Some(billing_snapshot),
            billing_settlement: None,
            startup_queue_probe_delay_ms: None,
            mock_upstream_fault: None,
        })
        .unwrap();
        let attachment = SocketAttachment {
            session: "rt-session".to_string(),
            connected_at_ms: 10.0,
            protocol: Some("realtime,openai-insecure-api-key.<redacted>".to_string()),
            entrypoint: "openai_realtime_v1".to_string(),
            model: Some("gpt-4o-realtime-preview".to_string()),
            token_source: Some("authorization".to_string()),
            token_fingerprint: Some("fp-token".to_string()),
            auth_state: "gateway_checked".to_string(),
            upstream: Some(upstream),
            upstream_connect_handoff: true,
        };
        let mut metrics = RealtimeSessionMetrics::new("rt-session", 1.0);
        metrics.record_connect(&attachment, 2.0);

        let metrics_snapshot = metrics.last_billing_snapshot.as_ref().unwrap();
        let attachment_raw = serde_json::to_string(&attachment).unwrap();
        let metrics_raw = serde_json::to_string(&metrics).unwrap();
        assert_eq!(metrics.billing_snapshot_count, 1);
        assert_eq!(metrics.last_billing_snapshot_at_ms, Some(2.0));
        assert_eq!(metrics_snapshot.expr_hash, "exprhash123");
        assert!(attachment_raw.contains("\"billing_snapshot\""));
        assert!(metrics_raw.contains("\"last_billing_snapshot\""));
        assert!(!attachment_raw.contains("sk-live-secret"));
        assert!(!metrics_raw.contains("sk-live-secret"));
        assert!(!attachment_raw.contains("param("));
        assert!(!metrics_raw.contains("param("));
        assert!(!attachment_raw.contains("service_tier"));
        assert!(!metrics_raw.contains("service_tier"));
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
    fn realtime_upstream_connect_handoff_self_check_passes() {
        assert!(realtime_upstream_connect_handoff_compiled());
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
