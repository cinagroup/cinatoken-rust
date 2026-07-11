//! Durable Object foundation for realtime/session-heavy relay flows.
//!
//! The current relay does not yet implement full OpenAI Realtime protocol
//! parity. This object establishes the Cloudflare-native stateful WebSocket
//! substrate: hibernatable accepts through `State::accept_web_socket`, socket
//! attachments for resume metadata, and a tiny control protocol for smoke
//! testing.

use cinatoken_billing::{
    build_tiered_token_params, compute_tiered_quota_with_request, detect_billing_expr_variables,
    expr_hash_string, split_billing_expr_request_rule, RequestInput, TieredBillingResult,
    TieredBillingSnapshot, TieredTokenUsage, UsageSemantic,
};
#[cfg(test)]
use cinatoken_billing::{estimate_tiered_billing_snapshot_with_request, TokenParams};
use cinatoken_relay::{
    clamp_i64_to_i32,
    openai_compatible::{default_base_url, upstream_v1_url, usage_summary_from_body, UsageSummary},
    token_fingerprint,
};
use cinatoken_storage::RelayAuditLog;
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::time::Duration;
use url::Url;
use wasm_bindgen::JsValue;
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
pub const REALTIME_BILLING_SETTLEMENT_MUTATION_PLAN_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_WRITER_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_REPLAY_MARKER_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_AUDIT_LOG_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_BATCH_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_RETRY_COMPILED: bool = true;
pub const REALTIME_BILLING_RESERVATION_LEASE_COMPILED: bool = true;
pub const REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED_ENV: &str =
    "REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED";
pub const REALTIME_BILLING_RESERVATION_LEASE_SECONDS_ENV: &str =
    "REALTIME_BILLING_RESERVATION_LEASE_SECONDS";
pub const REALTIME_SESSION_PLATFORM_HEADER_BOUNDARY_COMPILED: bool = true;
pub const REALTIME_UPSTREAM_PLAN_HEADER: &str = "x-cinatoken-realtime-upstream-plan";
const REALTIME_UPSTREAM_CONNECT_HEADER: &str = "x-cinatoken-realtime-upstream-connect";
pub use cinatoken_gateway::REALTIME_OPENAI_PATH;
pub const REALTIME_SESSION_CUTOVER_GUARDS: &[&str] = &[
    "platform_gateway_gate",
    "v1_gateway_gate",
    "relay_token_auth",
    "relay_rate_limits",
    "upstream_channel_selection",
    "upstream_fetch_upgrade_adapter",
    "upstream_bridge_lifecycle",
    "upstream_bridge_hibernation_fail_closed",
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
    "billing_settlement_mutation_plan",
    "billing_settlement_writer",
    "billing_settlement_replay_marker",
    "billing_settlement_audit_log",
    "billing_settlement_batch",
    "billing_settlement_retry",
    "billing_response_reservation",
    "billing_response_correlation",
    "billing_explicit_response_mode",
    "billing_reservation_lease_recovery",
    "d1_migration_ready",
    "billing_settlement_write_gate",
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
const BILLING_SETTLEMENT_RETRY_KEY: &str = "billing_settlement_retries_v2";
const BILLING_RESERVATION_SEQUENCE_KEY: &str = "billing_reservation_sequence_v1";
const BILLING_RESERVATION_LEASES_KEY: &str = "billing_reservation_leases_v1";
const BILLING_SETTLEMENT_RETRY_INITIAL_DELAY_MS: u64 = 1_000;
const BILLING_SETTLEMENT_RETRY_MAX_DELAY_MS: u64 = 30_000;
const BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS: u8 = 7;
const BILLING_SETTLEMENT_RETRY_MAX_RECORDS: usize = 64;
const BILLING_RESERVATION_LEASE_DEFAULT_SECONDS: u64 = 600;
const BILLING_RESERVATION_LEASE_MIN_SECONDS: u64 = 30;
const BILLING_RESERVATION_LEASE_MAX_SECONDS: u64 = 3_600;
const BILLING_RESERVATION_LEASE_MAX_RECORDS: usize = 128;
const BILLING_RESERVATION_LEASE_RETRY_DELAY_MS: u64 = 30_000;
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
const REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE: &str = "upstream_bridge_unavailable";
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
    billing_settlement_retry: Option<RealtimeBillingSettlementRetryStatus>,
    billing_reservation_lease: Option<RealtimeBillingReservationLeaseStatus>,
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
    billing_settlement: Option<RealtimeBillingSettlementHandoff>,
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
    UpstreamUnavailable,
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
    response_identity_hash: String,
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
    mutation_plan_present: bool,
    mutation_token_scoped: bool,
    mutation_channel_scoped: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
struct RealtimeBillingSettlementWriteMetadata {
    write_enabled: bool,
    write_attempted: bool,
    applied: bool,
    skipped_reason: Option<String>,
    error: Option<String>,
    pre_consumed_quota: i64,
    final_quota: i64,
    refund_quota: i64,
    additional_quota: i64,
    delta_quota: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replay_key_hash: Option<String>,
    #[serde(default)]
    replay_recorded: bool,
    #[serde(default)]
    audit_plan_present: bool,
    #[serde(default)]
    audit_attempted: bool,
    #[serde(default)]
    audit_recorded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audit_error: Option<String>,
    mutation_plan_present: bool,
    mutation_token_scoped: bool,
    mutation_channel_scoped: bool,
    #[serde(default)]
    retry_scheduled: bool,
    #[serde(default)]
    retry_attempt: u8,
    #[serde(default)]
    retry_max_attempts: u8,
    #[serde(default)]
    retry_exhausted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_next_at_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct RealtimeBillingSettlementRetryStatus {
    record_count: usize,
    pending: bool,
    paused: bool,
    exhausted: bool,
    attempts: u8,
    max_attempts: u8,
    next_retry_at_ms: Option<f64>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RealtimeBillingSettlementRetryRecord {
    attachment: SocketAttachment,
    preview: RealtimeBillingSettlementPreviewMetadata,
    snapshot: TieredBillingSnapshot,
    mutation_plan: RealtimeBillingSettlementMutationPlan,
    audit_plan: RealtimeBillingSettlementAuditPlan,
    reservation_key: String,
    #[serde(default)]
    reservation_sequence: i64,
    #[serde(default)]
    lease_expires_at: i64,
    upstream_response_id_hash: String,
    replay_key: String,
    attempts: u8,
    max_attempts: u8,
    created_at_ms: f64,
    updated_at_ms: f64,
    next_retry_at_ms: Option<f64>,
    paused: bool,
    exhausted: bool,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RealtimeBillingSettlementRetryQueue {
    records: Vec<RealtimeBillingSettlementRetryRecord>,
}

#[derive(Debug, Clone, Serialize)]
struct RealtimeBillingReservationLeaseStatus {
    record_count: usize,
    due_count: usize,
    next_expiry_at_ms: Option<f64>,
    highest_attempts: u8,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RealtimeBillingReservationLeaseRecord {
    reservation_key: String,
    #[serde(default)]
    reservation_sequence: i64,
    #[serde(default)]
    lease_expires_at: i64,
    expires_at_ms: f64,
    attempts: u8,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RealtimeBillingReservationLeaseQueue {
    records: Vec<RealtimeBillingReservationLeaseRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RealtimeBillingSettlementHandoff {
    snapshot: TieredBillingSnapshot,
    request: RequestInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mutation_plan: Option<RealtimeBillingSettlementMutationPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audit_plan: Option<RealtimeBillingSettlementAuditPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RealtimeBillingSettlementMutationPlan {
    user_id: i64,
    token_id: i64,
    channel_id: i64,
    selected_group: String,
    pre_consumed_quota: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RealtimeBillingSettlementAuditPlan {
    username: String,
    token_name: String,
    client_ip: Option<String>,
    request_id: Option<String>,
    started_at: i64,
    endpoint_path: String,
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
    billing_settlement_write_count: u32,
    #[serde(default)]
    billing_settlement_applied_count: u32,
    #[serde(default)]
    last_billing_settlement_write_at_ms: Option<f64>,
    #[serde(default)]
    last_billing_settlement_write: Option<RealtimeBillingSettlementWriteMetadata>,
    #[serde(default)]
    last_bridge_terminal_event: Option<RealtimeBridgeTerminalEvent>,
}

#[durable_object]
pub struct RealtimeSession {
    state: State,
    env: Env,
    upstream_bridges: HashMap<String, RealtimeUpstreamBridgeRuntime>,
}

#[durable_object]
impl DurableObject for RealtimeSession {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            upstream_bridges: HashMap::new(),
        }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        self.drop_closed_upstream_bridges();
        let session = session_from_request(&req).unwrap_or_else(|| self.state.id().to_string());
        if let Err(err) = self.resume_billing_settlement_retry_if_enabled().await {
            worker::console_warn!("RealtimeSession settlement retry resume failed: {}", err);
        }
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
        let billing_settlement_retry = self.load_billing_settlement_retry_status().await?;
        let billing_reservation_lease = self.load_billing_reservation_lease_status().await?;
        Response::from_json(&RealtimeSessionStatus {
            session,
            active_websockets: sockets.len(),
            active_upstream_bridges,
            queued_upstream_frames,
            queued_upstream_bytes,
            restored_attachments,
            hibernation: true,
            observability: "durable_object_storage",
            billing_settlement_retry,
            billing_reservation_lease,
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
                let billing_settlement_retry = self.load_billing_settlement_retry_status().await?;
                let billing_reservation_lease =
                    self.load_billing_reservation_lease_status().await?;
                ws.send(&json!({
                    "type": "realtime_session_status",
                    "context": context,
                    "metrics": metrics,
                    "active_upstream_bridges": active_upstream_bridges,
                    "queued_upstream_frames": queued_upstream_frames,
                    "queued_upstream_bytes": queued_upstream_bytes,
                    "billing_settlement_retry": billing_settlement_retry,
                    "billing_reservation_lease": billing_reservation_lease
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
                self.drop_closed_upstream_bridges();
                if self.upstream_bridge_requires_terminal(attachment.as_ref()) {
                    return self
                        .terminate_unavailable_upstream_bridge(
                            &ws,
                            attachment.as_ref(),
                            &context,
                            &mut metrics,
                            Some(RealtimeBridgeFrameMetadata {
                                kind: RealtimeBridgeFrameKind::Text,
                                bytes: summary.text_bytes,
                                max_bytes: None,
                            }),
                        )
                        .await;
                }
                let message = match self
                    .enforce_realtime_explicit_response_mode(attachment.as_ref(), message)
                {
                    Ok(message) => message,
                    Err(err) => {
                        metrics.record_error(attachment.as_ref(), js_sys::Date::now(), &err);
                        self.store_metrics(&metrics).await?;
                        ws.send(&json!({
                            "type": "error",
                            "error": {
                                "type": "invalid_request_error",
                                "code": "billing_explicit_response_required",
                                "message": "Realtime billing requires explicit response.create events"
                            }
                        }))?;
                        return Ok(());
                    }
                };
                let reservation_key = match self
                    .reserve_realtime_response(attachment.as_ref(), &message)
                    .await
                {
                    Ok(reservation_key) => reservation_key,
                    Err(err) => {
                        metrics.record_error(attachment.as_ref(), js_sys::Date::now(), &err);
                        self.store_metrics(&metrics).await?;
                        ws.send(&json!({
                            "type": "error",
                            "error": {
                                "type": "invalid_request_error",
                                "code": "billing_reservation_failed",
                                "message": "Unable to reserve quota for response.create"
                            }
                        }))?;
                        return Ok(());
                    }
                };
                match self.forward_text_to_upstream(attachment.as_ref(), message) {
                    Ok(RealtimeBridgeForwardResult::Sent)
                    | Ok(RealtimeBridgeForwardResult::Queued) => {}
                    Ok(RealtimeBridgeForwardResult::NotActive) => {
                        self.refund_realtime_response_best_effort(reservation_key.as_deref())
                            .await;
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
                        self.refund_realtime_response_best_effort(reservation_key.as_deref())
                            .await;
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
                        self.refund_realtime_response_best_effort(reservation_key.as_deref())
                            .await;
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
                self.drop_closed_upstream_bridges();
                if self.upstream_bridge_requires_terminal(attachment.as_ref()) {
                    return self
                        .terminate_unavailable_upstream_bridge(
                            &ws,
                            attachment.as_ref(),
                            &context,
                            &mut metrics,
                            Some(RealtimeBridgeFrameMetadata {
                                kind: RealtimeBridgeFrameKind::Binary,
                                bytes: binary_bytes,
                                max_bytes: None,
                            }),
                        )
                        .await;
                }
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
        self.refund_realtime_session_reservations_best_effort(&session)
            .await;
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
        self.refund_realtime_session_reservations_best_effort(&session)
            .await;
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

    async fn alarm(&mut self) -> WorkerResult<Response> {
        let mut storage = self.state.storage();
        let now_ms = js_sys::Date::now();
        let mut lease_result = None;
        let queue = load_realtime_billing_settlement_retry(&storage)
            .await?
            .unwrap_or_default();
        let lease_queue = load_realtime_billing_reservation_leases(&storage)
            .await?
            .unwrap_or_default();
        if let Some(index) = lease_queue.next_due_index(now_ms) {
            let lease = lease_queue.records[index].clone();
            let initially_transferred = realtime_billing_reservation_owned_by_retry(
                &queue,
                &lease.reservation_key,
                lease.reservation_sequence,
                lease.lease_expires_at,
            );
            let refund = if initially_transferred {
                None
            } else {
                Some(match self.env.d1("DB") {
                    Ok(db) => {
                        crate::d1_repositories::refund_expired_realtime_billing_reservation(
                            &db,
                            &lease.reservation_key,
                            lease.reservation_sequence,
                            lease.lease_expires_at,
                            crate::admin::unix_timestamp(),
                        )
                        .await
                    }
                    Err(err) => Err(err),
                })
            };
            let latest_retry_queue = load_realtime_billing_settlement_retry(&storage)
                .await?
                .unwrap_or_default();
            let transferred = initially_transferred
                || realtime_billing_reservation_owned_by_retry(
                    &latest_retry_queue,
                    &lease.reservation_key,
                    lease.reservation_sequence,
                    lease.lease_expires_at,
                );
            let mut latest_lease_queue = load_realtime_billing_reservation_leases(&storage)
                .await?
                .unwrap_or_default();
            if transferred {
                latest_lease_queue.records.retain(|record| {
                    record.reservation_key != lease.reservation_key
                        || record.reservation_sequence != lease.reservation_sequence
                        || record.lease_expires_at != lease.lease_expires_at
                });
                lease_result = Some("reservation lease transferred to settlement retry");
            } else {
                match refund.expect("refund is attempted unless retry owns the reservation") {
                    Ok(
                        crate::d1_repositories::RealtimeBillingReservationRefundOutcome::Applied
                        | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::AlreadyFinalized
                        | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::NotFound,
                    ) => {
                        latest_lease_queue
                            .records
                            .retain(|record| {
                                record.reservation_key != lease.reservation_key
                                    || record.reservation_sequence != lease.reservation_sequence
                                    || record.lease_expires_at != lease.lease_expires_at
                            });
                        lease_result = Some("reservation lease recovered");
                    }
                    Ok(
                        crate::d1_repositories::RealtimeBillingReservationRefundOutcome::LeaseActive {
                            reservation_sequence,
                            lease_expires_at,
                        },
                    ) => {
                        if let Some(current) = latest_lease_queue.records.iter_mut().find(|record| {
                            record.reservation_key == lease.reservation_key
                                && record.reservation_sequence == lease.reservation_sequence
                                && record.lease_expires_at == lease.lease_expires_at
                        }) {
                            current.reservation_sequence = reservation_sequence;
                            current.lease_expires_at = lease_expires_at;
                            current.expires_at_ms = (lease_expires_at as f64 * 1_000.0)
                                .max(js_sys::Date::now() + 1.0);
                            current.last_error = None;
                        }
                        lease_result = Some("reservation lease generation refreshed");
                    }
                    Err(err) => {
                        if let Some(current) = latest_lease_queue
                            .records
                            .iter_mut()
                            .find(|record| {
                                record.reservation_key == lease.reservation_key
                                    && record.reservation_sequence == lease.reservation_sequence
                                    && record.lease_expires_at == lease.lease_expires_at
                            })
                        {
                            current.attempts = current.attempts.saturating_add(1);
                            current.last_error =
                                truncate_text(&err.to_string(), MAX_STORED_TEXT_CHARS);
                            current.expires_at_ms = js_sys::Date::now()
                                + BILLING_RESERVATION_LEASE_RETRY_DELAY_MS as f64;
                        }
                        lease_result = Some("reservation lease refund rescheduled");
                    }
                }
            }
            store_realtime_billing_reservation_lease_queue(
                &mut storage,
                &latest_lease_queue,
                js_sys::Date::now(),
            )
            .await?;
        }

        let mut queue = load_realtime_billing_settlement_retry(&storage)
            .await?
            .unwrap_or_default();

        if queue.records.is_empty() {
            schedule_realtime_billing_alarm(&mut storage, now_ms).await?;
            return Response::ok(
                lease_result.unwrap_or("realtime billing alarm skipped: no due work"),
            );
        }

        if let Some(index) = queue.next_due_refund_index(now_ms) {
            let mut retry = queue.records[index].clone();
            retry.attempts = retry.attempts.saturating_add(1);
            retry.updated_at_ms = now_ms;
            let refund = match self.env.d1("DB") {
                Ok(db) => {
                    crate::d1_repositories::refund_realtime_billing_reservation(
                        &db,
                        &retry.reservation_key,
                        crate::admin::unix_timestamp(),
                    )
                    .await
                }
                Err(err) => Err(err),
            };
            let refunded = matches!(
                &refund,
                Ok(
                    crate::d1_repositories::RealtimeBillingReservationRefundOutcome::Applied
                        | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::AlreadyFinalized
                        | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::NotFound
                )
            );
            let mut latest_queue = load_realtime_billing_settlement_retry(&storage)
                .await?
                .unwrap_or_default();
            if refunded {
                latest_queue
                    .records
                    .retain(|record| record.replay_key != retry.replay_key);
                retry.next_retry_at_ms = None;
                retry.last_error = None;
            } else if let Some(current) = latest_queue
                .records
                .iter_mut()
                .find(|record| record.replay_key == retry.replay_key)
            {
                current.attempts = retry.attempts;
                current.updated_at_ms = js_sys::Date::now();
                current.next_retry_at_ms =
                    Some(current.updated_at_ms + BILLING_RESERVATION_LEASE_RETRY_DELAY_MS as f64);
                current.paused = false;
                current.exhausted = true;
                current.last_error = truncate_text(
                    &format!(
                        "refund-only retry failed: {}",
                        refund
                            .err()
                            .map(|err| err.to_string())
                            .unwrap_or_else(|| "unknown refund failure".to_string())
                    ),
                    MAX_STORED_TEXT_CHARS,
                );
                retry = current.clone();
            }
            store_realtime_billing_settlement_retry_queue(
                &mut storage,
                &latest_queue,
                js_sys::Date::now(),
            )
            .await?;
            record_realtime_billing_settlement_retry_metrics(
                &mut storage,
                &retry,
                js_sys::Date::now(),
                true,
                false,
                Some(if refunded {
                    "retry_exhausted_refunded"
                } else {
                    "retry_exhausted_refund_rescheduled"
                }),
            )
            .await?;
            return Response::ok(if refunded {
                "realtime settlement exhausted reservation refunded"
            } else {
                "realtime settlement exhausted refund rescheduled"
            });
        }

        if !realtime_billing_settlement_write_enabled(&self.env) {
            for retry in &mut queue.records {
                if !retry.exhausted {
                    retry.paused = true;
                    retry.updated_at_ms = now_ms;
                    retry.next_retry_at_ms =
                        Some(now_ms + BILLING_RESERVATION_LEASE_RETRY_DELAY_MS as f64);
                    retry.last_error = Some("write_disabled".to_string());
                }
            }
            store_realtime_billing_settlement_retry_queue(&mut storage, &queue, now_ms).await?;
            return Response::ok("realtime settlement retry paused: write disabled");
        }

        let mut resumed = false;
        for retry in &mut queue.records {
            if retry.paused && !retry.exhausted {
                retry.paused = false;
                retry.updated_at_ms = now_ms;
                retry.next_retry_at_ms = Some(retry.next_retry_at_ms.unwrap_or(now_ms).min(now_ms));
                resumed = true;
            }
        }
        if resumed {
            store_realtime_billing_settlement_retry_queue(&mut storage, &queue, now_ms).await?;
        }

        let Some(index) = queue.next_due_index(now_ms) else {
            store_realtime_billing_settlement_retry_queue(&mut storage, &queue, now_ms).await?;
            return Response::ok("realtime settlement retry skipped: no due record");
        };
        let mut retry = queue.records[index].clone();
        retry.updated_at_ms = now_ms;
        retry.next_retry_at_ms = None;
        retry.paused = false;
        retry.attempts = retry.attempts.saturating_add(1);
        match apply_realtime_billing_settlement_write(
            &self.env,
            &retry.attachment,
            &retry.preview,
            &retry.snapshot,
            &retry.mutation_plan,
            &retry.audit_plan,
            &retry.reservation_key,
            &retry.upstream_response_id_hash,
            &retry.replay_key,
        )
        .await
        {
            Ok(outcome) => {
                retry.last_error = None;
                let mut latest_queue = load_realtime_billing_settlement_retry(&storage)
                    .await?
                    .unwrap_or_default();
                latest_queue
                    .records
                    .retain(|record| record.replay_key != retry.replay_key);
                store_realtime_billing_settlement_retry_queue(
                    &mut storage,
                    &latest_queue,
                    js_sys::Date::now(),
                )
                .await?;
                clear_realtime_billing_reservation_lease(
                    &mut storage,
                    &retry.reservation_key,
                    js_sys::Date::now(),
                )
                .await?;
                record_realtime_billing_settlement_retry_metrics(
                    &mut storage,
                    &retry,
                    js_sys::Date::now(),
                    true,
                    true,
                    match outcome {
                        RealtimeBillingSettlementWriteOutcome::Applied => None,
                        RealtimeBillingSettlementWriteOutcome::DuplicateReplay => {
                            Some("replay_duplicate_recovered")
                        }
                    },
                )
                .await?;
                Response::ok("realtime settlement retry applied")
            }
            Err(err) => {
                retry.last_error = truncate_text(&err, MAX_STORED_TEXT_CHARS);
                retry.exhausted = retry.attempts >= retry.max_attempts;
                let mut exhausted_refunded = false;
                let mut exhausted_refund_deferred = false;
                if retry.exhausted {
                    retry.next_retry_at_ms = None;
                    match self.env.d1("DB") {
                        Ok(db) => {
                            match crate::d1_repositories::refund_realtime_billing_reservation(
                                &db,
                                &retry.reservation_key,
                                crate::admin::unix_timestamp(),
                            )
                            .await
                            {
                                Ok(
                                    crate::d1_repositories::RealtimeBillingReservationRefundOutcome::Applied
                                    | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::AlreadyFinalized
                                    | crate::d1_repositories::RealtimeBillingReservationRefundOutcome::NotFound,
                                ) => exhausted_refunded = true,
                                Ok(
                                    crate::d1_repositories::RealtimeBillingReservationRefundOutcome::LeaseActive { .. },
                                ) => {
                                    retry.last_error = truncate_text(
                                        &format!(
                                            "{err}; exhausted reservation refund observed an unexpected active lease"
                                        ),
                                        MAX_STORED_TEXT_CHARS,
                                    );
                                }
                                Err(refund_err) => {
                                    retry.last_error = truncate_text(
                                        &format!(
                                            "{err}; exhausted reservation refund failed: {refund_err}"
                                        ),
                                        MAX_STORED_TEXT_CHARS,
                                    );
                                }
                            }
                        }
                        Err(refund_err) => {
                            retry.last_error = truncate_text(
                                &format!(
                                    "{err}; exhausted reservation refund DB unavailable: {refund_err}"
                                ),
                                MAX_STORED_TEXT_CHARS,
                            );
                        }
                    }
                    if !exhausted_refunded {
                        match persist_realtime_billing_reservation_lease(
                            &mut storage,
                            &retry.reservation_key,
                            retry.reservation_sequence,
                            retry.lease_expires_at,
                            now_ms + BILLING_RESERVATION_LEASE_RETRY_DELAY_MS as f64,
                            now_ms,
                        )
                        .await
                        {
                            Ok(()) => exhausted_refund_deferred = true,
                            Err(lease_err) => {
                                retry.last_error = truncate_text(
                                    &format!(
                                        "{}; refund lease persistence failed: {lease_err}",
                                        retry.last_error.as_deref().unwrap_or(&err)
                                    ),
                                    MAX_STORED_TEXT_CHARS,
                                );
                            }
                        }
                    }
                } else {
                    let delay_ms = realtime_billing_settlement_retry_delay_ms(retry.attempts);
                    retry.next_retry_at_ms = Some(now_ms + delay_ms as f64);
                }
                if retry.exhausted && !exhausted_refunded && !exhausted_refund_deferred {
                    retry.next_retry_at_ms =
                        Some(js_sys::Date::now() + BILLING_RESERVATION_LEASE_RETRY_DELAY_MS as f64);
                }
                let mut latest_queue = load_realtime_billing_settlement_retry(&storage)
                    .await?
                    .unwrap_or_default();
                match realtime_billing_retry_failure_ownership(
                    exhausted_refunded,
                    exhausted_refund_deferred,
                ) {
                    RealtimeBillingRetryFailureOwnership::SettlementRetry => {
                        if let Some(current) = latest_queue
                            .records
                            .iter_mut()
                            .find(|record| record.replay_key == retry.replay_key)
                        {
                            *current = retry.clone();
                        }
                    }
                    RealtimeBillingRetryFailureOwnership::Refunded => {
                        latest_queue
                            .records
                            .retain(|record| record.replay_key != retry.replay_key);
                        clear_realtime_billing_reservation_lease(
                            &mut storage,
                            &retry.reservation_key,
                            js_sys::Date::now(),
                        )
                        .await?;
                    }
                    RealtimeBillingRetryFailureOwnership::ReservationLease => {
                        latest_queue
                            .records
                            .retain(|record| record.replay_key != retry.replay_key);
                    }
                }
                store_realtime_billing_settlement_retry_queue(
                    &mut storage,
                    &latest_queue,
                    js_sys::Date::now(),
                )
                .await?;
                record_realtime_billing_settlement_retry_metrics(
                    &mut storage,
                    &retry,
                    js_sys::Date::now(),
                    true,
                    false,
                    Some(if exhausted_refunded {
                        "retry_exhausted_refunded"
                    } else if exhausted_refund_deferred {
                        "retry_exhausted_refund_deferred"
                    } else if retry.exhausted {
                        "retry_exhausted"
                    } else {
                        "retry_scheduled"
                    }),
                )
                .await?;
                Response::ok(if exhausted_refunded {
                    "realtime settlement retry exhausted and reservation refunded"
                } else if exhausted_refund_deferred {
                    "realtime settlement retry exhausted and refund lease scheduled"
                } else if retry.exhausted {
                    "realtime settlement retry exhausted"
                } else {
                    "realtime settlement retry scheduled"
                })
            }
        }
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
                billing_settlement: handoff.billing_settlement.clone(),
            })),
        };
        spawn_realtime_upstream_event_pump(
            runtime.state.clone(),
            client.clone(),
            attachment.clone(),
            self.env.clone(),
            self.state.storage(),
            context,
            handoff.startup_queue_probe_delay_ms,
            handoff.mock_upstream_fault,
            handoff.billing_settlement.clone(),
        );
        self.upstream_bridges.insert(bridge_key, runtime);
        Ok(())
    }

    async fn reserve_realtime_response(
        &self,
        attachment: Option<&SocketAttachment>,
        message: &str,
    ) -> Result<Option<String>, String> {
        let Some(event) = realtime_response_create_event(message)? else {
            return Ok(None);
        };
        let attachment = attachment.ok_or_else(|| {
            "response.create cannot be billed without a realtime socket attachment".to_string()
        })?;
        let bridge_key = realtime_upstream_bridge_key(attachment);
        let handoff = self
            .upstream_bridges
            .get(&bridge_key)
            .and_then(|runtime| runtime.state.borrow().billing_settlement.clone());
        let Some(handoff) = handoff else {
            return if realtime_billing_settlement_write_enabled(&self.env) {
                Err("response.create has no billable Realtime reservation plan".to_string())
            } else {
                Ok(None)
            };
        };
        if !realtime_billing_settlement_write_enabled(&self.env) {
            return Err("realtime billing reservation writes are disabled".to_string());
        }
        let mutation_plan = handoff
            .mutation_plan()
            .cloned()
            .ok_or_else(|| "realtime billing mutation plan is missing".to_string())?;
        let audit_plan = handoff
            .audit_plan()
            .cloned()
            .ok_or_else(|| "realtime billing audit plan is missing".to_string())?;

        let mut storage = self.state.storage();
        let sequence = load_optional_do_value::<i64>(&storage, BILLING_RESERVATION_SEQUENCE_KEY)
            .await
            .map_err(|err| format!("failed to load realtime reservation sequence: {err}"))?
            .unwrap_or(0)
            .saturating_add(1);
        storage
            .put(BILLING_RESERVATION_SEQUENCE_KEY, sequence)
            .await
            .map_err(|err| format!("failed to persist realtime reservation sequence: {err}"))?;

        let request = realtime_response_create_request(&event, &handoff);
        let snapshot =
            crate::relay::realtime_billing_response_snapshot(&handoff.snapshot, request.clone())?;
        let pre_consumed_quota = snapshot.estimated_quota_after_group.0;
        let client_event_id_hash = event
            .get("event_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(realtime_billing_identity_hash)
            .unwrap_or_else(|| {
                realtime_billing_identity_hash(&format!(
                    "{}|sequence|{sequence}",
                    attachment.session
                ))
            });
        let reservation_key = format!(
            "rtreserve-{}",
            realtime_billing_identity_hash(&format!(
                "{}|{}|{}|{}",
                attachment.session, client_event_id_hash, snapshot.model_name, snapshot.expr_hash
            ))
        );
        let snapshot_json = serde_json::to_string(&snapshot)
            .map_err(|err| format!("failed to serialize realtime billing snapshot: {err}"))?;
        let request_json = serde_json::to_string(&request)
            .map_err(|err| format!("failed to serialize realtime billing request: {err}"))?;
        let now_ms = js_sys::Date::now();
        let lease_seconds = realtime_billing_reservation_lease_seconds(&self.env);
        let created_at = crate::admin::unix_timestamp();
        let lease_expires_at = created_at.saturating_add(lease_seconds as i64);
        let lease_expires_at_ms = lease_expires_at as f64 * 1_000.0;
        persist_realtime_billing_reservation_lease(
            &mut storage,
            &reservation_key,
            sequence,
            lease_expires_at,
            lease_expires_at_ms,
            now_ms,
        )
        .await
        .map_err(|err| format!("failed to persist realtime reservation lease: {err}"))?;
        let db = self
            .env
            .d1("DB")
            .map_err(|err| format!("failed to load DB binding for realtime reservation: {err}"))?;
        let endpoint_path = audit_plan.endpoint_path.as_str();
        let empty = "";
        let outcome = crate::d1_repositories::reserve_realtime_billing_quota(
            &db,
            crate::d1_repositories::RealtimeBillingReservationRecord {
                reservation_key: &reservation_key,
                session: &attachment.session,
                client_event_id_hash: &client_event_id_hash,
                reservation_sequence: sequence,
                user_id: mutation_plan.user_id,
                token_id: mutation_plan.token_id,
                channel_id: mutation_plan.channel_id,
                selected_group: &mutation_plan.selected_group,
                model_name: &snapshot.model_name,
                pre_consumed_quota,
                snapshot_json: &snapshot_json,
                request_json: &request_json,
                username: &audit_plan.username,
                token_name: &audit_plan.token_name,
                client_ip: audit_plan.client_ip.as_deref().unwrap_or(empty),
                request_id: audit_plan.request_id.as_deref().unwrap_or(empty),
                started_at: audit_plan.started_at,
                endpoint_path,
                created_at,
                lease_expires_at,
            },
        )
        .await
        .map_err(|err| format!("failed to reserve realtime response quota: {err}"))?;
        if outcome == crate::d1_repositories::RealtimeBillingReservationWriteOutcome::Duplicate {
            match crate::d1_repositories::realtime_billing_reservation_lease_identity(
                &db,
                &reservation_key,
            )
            .await
            .map_err(|err| format!("failed to restore duplicate reservation lease: {err}"))?
            {
                Some(identity) => {
                    refresh_realtime_billing_reservation_lease(
                        &mut storage,
                        &reservation_key,
                        identity.reservation_sequence,
                        identity.lease_expires_at,
                        identity.lease_expires_at as f64 * 1_000.0,
                        js_sys::Date::now(),
                    )
                    .await
                    .map_err(|err| {
                        format!("failed to restore authoritative duplicate lease: {err}")
                    })?;
                }
                None => {
                    clear_realtime_billing_reservation_lease(
                        &mut storage,
                        &reservation_key,
                        js_sys::Date::now(),
                    )
                    .await
                    .map_err(|err| format!("failed to clear finalized duplicate lease: {err}"))?;
                }
            }
            return Err("duplicate response.create event_id was already reserved".to_string());
        }
        refresh_realtime_billing_reservation_lease(
            &mut storage,
            &reservation_key,
            sequence,
            lease_expires_at,
            lease_expires_at_ms,
            js_sys::Date::now(),
        )
        .await
        .map_err(|err| format!("failed to refresh applied realtime reservation lease: {err}"))?;

        match load_realtime_session_metrics(&storage, &attachment.session, now_ms).await {
            Ok(mut metrics) => {
                metrics.record_billing_snapshot_metadata(
                    Some(attachment),
                    now_ms,
                    RealtimeBillingSnapshotMetadata::from_tiered_snapshot(&snapshot),
                );
                if let Err(err) = store_realtime_session_metrics(&mut storage, &metrics).await {
                    worker::console_warn!(
                        "RealtimeSession could not persist reservation metrics: {}",
                        err
                    );
                }
            }
            Err(err) => worker::console_warn!(
                "RealtimeSession could not load reservation metrics: {}",
                err
            ),
        }
        Ok(Some(reservation_key))
    }

    fn enforce_realtime_explicit_response_mode(
        &self,
        attachment: Option<&SocketAttachment>,
        message: String,
    ) -> Result<String, String> {
        if !realtime_billing_settlement_write_enabled(&self.env) {
            return Ok(message);
        }
        let billing_active = attachment
            .and_then(|attachment| {
                self.upstream_bridges
                    .get(&realtime_upstream_bridge_key(attachment))
            })
            .is_some_and(|runtime| runtime.state.borrow().billing_settlement.is_some());
        if !billing_active {
            return Ok(message);
        }
        realtime_enforce_explicit_response_mode(&message)
    }

    async fn refund_realtime_response_best_effort(&self, reservation_key: Option<&str>) {
        let Some(reservation_key) = reservation_key else {
            return;
        };
        let Ok(db) = self.env.d1("DB") else {
            worker::console_warn!(
                "RealtimeSession could not load DB while refunding reservation {}",
                reservation_key
            );
            return;
        };
        match crate::d1_repositories::refund_realtime_billing_reservation(
            &db,
            reservation_key,
            crate::admin::unix_timestamp(),
        )
        .await
        {
            Ok(_) => {
                let mut storage = self.state.storage();
                if let Err(err) = clear_realtime_billing_reservation_lease(
                    &mut storage,
                    reservation_key,
                    js_sys::Date::now(),
                )
                .await
                {
                    worker::console_warn!(
                        "RealtimeSession failed to clear reservation lease {}: {}",
                        reservation_key,
                        err
                    );
                }
            }
            Err(err) => worker::console_warn!(
                "RealtimeSession failed to refund reservation {}: {}",
                reservation_key,
                err
            ),
        }
    }

    fn upstream_bridge_requires_terminal(&self, attachment: Option<&SocketAttachment>) -> bool {
        let Some(attachment) = attachment else {
            return false;
        };
        let active_bridge = self
            .upstream_bridges
            .get(&realtime_upstream_bridge_key(attachment))
            .is_some_and(|runtime| !runtime.state.borrow().closed);
        realtime_upstream_bridge_requires_terminal(
            attachment.upstream_connect_handoff,
            active_bridge,
        )
    }

    async fn terminate_unavailable_upstream_bridge(
        &self,
        client: &WebSocket,
        attachment: Option<&SocketAttachment>,
        context: &Value,
        metrics: &mut RealtimeSessionMetrics,
        frame: Option<RealtimeBridgeFrameMetadata>,
    ) -> WorkerResult<()> {
        let now_ms = js_sys::Date::now();
        let cause = RealtimeBridgeCloseCause::UpstreamUnavailable;
        let action = realtime_bridge_close_action(cause);
        let session = attachment
            .map(|attachment| attachment.session.clone())
            .unwrap_or_else(|| self.state.id().to_string());
        metrics.record_error(
            attachment,
            now_ms,
            REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE,
        );
        metrics.record_bridge_terminal_event(
            attachment,
            now_ms,
            realtime_bridge_terminal_event(cause, action, now_ms, frame),
        );
        send_realtime_bridge_terminal_event(client, context, cause, action, frame);
        let _ = client.close(Some(action.client_code), Some(action.client_reason));
        self.refund_realtime_session_reservations_best_effort(&session)
            .await;
        self.store_metrics(metrics).await?;
        Ok(())
    }

    async fn refund_realtime_session_reservations_best_effort(&self, session: &str) {
        let Ok(db) = self.env.d1("DB") else {
            worker::console_warn!("RealtimeSession could not load DB during session refund");
            return;
        };
        let retry_reservations = match load_realtime_billing_settlement_retry(&self.state.storage())
            .await
        {
            Ok(Some(queue)) => queue
                .records
                .into_iter()
                .map(|record| record.reservation_key)
                .collect::<Vec<_>>(),
            Ok(None) => Vec::new(),
            Err(err) => {
                worker::console_warn!(
                    "RealtimeSession could not load settlement retry ownership during session refund: {}",
                    err
                );
                return;
            }
        };
        let reservations =
            match crate::d1_repositories::reserved_realtime_billing_for_session(&db, session).await
            {
                Ok(reservations) => reservations,
                Err(err) => {
                    worker::console_warn!(
                        "RealtimeSession failed to list session reservations for refund: {}",
                        err
                    );
                    return;
                }
            };
        let now = crate::admin::unix_timestamp();
        for reservation in reservations {
            if retry_reservations.contains(&reservation.reservation_key) {
                continue;
            }
            match crate::d1_repositories::refund_realtime_billing_reservation(
                &db,
                &reservation.reservation_key,
                now,
            )
            .await
            {
                Ok(_) => {
                    let mut storage = self.state.storage();
                    if let Err(err) = clear_realtime_billing_reservation_lease(
                        &mut storage,
                        &reservation.reservation_key,
                        js_sys::Date::now(),
                    )
                    .await
                    {
                        worker::console_warn!(
                            "RealtimeSession failed to clear terminal reservation lease {}: {}",
                            reservation.reservation_key,
                            err
                        );
                    }
                }
                Err(err) => worker::console_warn!(
                    "RealtimeSession failed to refund terminal reservation {}: {}",
                    reservation.reservation_key,
                    err
                ),
            }
        }
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

    async fn load_billing_settlement_retry_status(
        &self,
    ) -> WorkerResult<Option<RealtimeBillingSettlementRetryStatus>> {
        let storage = self.state.storage();
        Ok(load_realtime_billing_settlement_retry(&storage)
            .await?
            .and_then(|queue| queue.status()))
    }

    async fn load_billing_reservation_lease_status(
        &self,
    ) -> WorkerResult<Option<RealtimeBillingReservationLeaseStatus>> {
        let storage = self.state.storage();
        Ok(load_realtime_billing_reservation_leases(&storage)
            .await?
            .and_then(|queue| queue.status(js_sys::Date::now())))
    }

    async fn resume_billing_settlement_retry_if_enabled(&self) -> WorkerResult<()> {
        if !realtime_billing_settlement_write_enabled(&self.env) {
            return Ok(());
        }
        let mut storage = self.state.storage();
        let Some(mut queue) = load_realtime_billing_settlement_retry(&storage).await? else {
            return Ok(());
        };
        let now_ms = js_sys::Date::now();
        for retry in &mut queue.records {
            if retry.exhausted {
                continue;
            }
            if retry.paused {
                retry.paused = false;
                retry.updated_at_ms = now_ms;
                retry.next_retry_at_ms = Some(now_ms);
            } else if retry.next_retry_at_ms.is_none() {
                retry.updated_at_ms = now_ms;
                retry.next_retry_at_ms = Some(
                    now_ms + realtime_billing_settlement_retry_delay_ms(retry.attempts) as f64,
                );
            }
        }
        store_realtime_billing_settlement_retry_queue(&mut storage, &queue, now_ms).await
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

async fn load_optional_do_value<T: DeserializeOwned>(
    storage: &Storage,
    key: &str,
) -> WorkerResult<Option<T>> {
    let values = storage.get_multiple(vec![key]).await?;
    let value = values.get(&JsValue::from_str(key));
    if value.is_undefined() {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(value)
        .map(Some)
        .map_err(|err| {
            worker::Error::RustError(format!("failed to decode DO storage {key}: {err}"))
        })
}

async fn load_realtime_billing_settlement_retry(
    storage: &Storage,
) -> WorkerResult<Option<RealtimeBillingSettlementRetryQueue>> {
    Ok(
        load_optional_do_value(storage, BILLING_SETTLEMENT_RETRY_KEY)
            .await?
            .filter(|queue: &RealtimeBillingSettlementRetryQueue| !queue.records.is_empty()),
    )
}

async fn load_realtime_billing_reservation_leases(
    storage: &Storage,
) -> WorkerResult<Option<RealtimeBillingReservationLeaseQueue>> {
    Ok(
        load_optional_do_value(storage, BILLING_RESERVATION_LEASES_KEY)
            .await?
            .filter(|queue: &RealtimeBillingReservationLeaseQueue| !queue.records.is_empty()),
    )
}

async fn persist_realtime_billing_reservation_lease(
    storage: &mut Storage,
    reservation_key: &str,
    reservation_sequence: i64,
    lease_expires_at: i64,
    expires_at_ms: f64,
    now_ms: f64,
) -> WorkerResult<()> {
    let mut queue = load_realtime_billing_reservation_leases(storage)
        .await?
        .unwrap_or_default();
    queue
        .upsert(
            reservation_key,
            reservation_sequence,
            lease_expires_at,
            expires_at_ms,
        )
        .map_err(worker::Error::RustError)?;
    store_realtime_billing_reservation_lease_queue(storage, &queue, now_ms).await
}

async fn refresh_realtime_billing_reservation_lease(
    storage: &mut Storage,
    reservation_key: &str,
    reservation_sequence: i64,
    lease_expires_at: i64,
    expires_at_ms: f64,
    now_ms: f64,
) -> WorkerResult<()> {
    let mut queue = load_realtime_billing_reservation_leases(storage)
        .await?
        .unwrap_or_default();
    let Some(record) = queue
        .records
        .iter_mut()
        .find(|record| record.reservation_key == reservation_key)
    else {
        return Err(worker::Error::RustError(
            "applied realtime reservation lease is missing".to_string(),
        ));
    };
    record.reservation_sequence = reservation_sequence;
    record.lease_expires_at = lease_expires_at;
    record.expires_at_ms = expires_at_ms;
    record.attempts = 0;
    record.last_error = None;
    store_realtime_billing_reservation_lease_queue(storage, &queue, now_ms).await
}

async fn clear_realtime_billing_reservation_lease(
    storage: &mut Storage,
    reservation_key: &str,
    now_ms: f64,
) -> WorkerResult<()> {
    let Some(mut queue) = load_realtime_billing_reservation_leases(storage).await? else {
        return Ok(());
    };
    queue
        .records
        .retain(|record| record.reservation_key != reservation_key);
    store_realtime_billing_reservation_lease_queue(storage, &queue, now_ms).await
}

async fn store_realtime_billing_reservation_lease_queue(
    storage: &mut Storage,
    queue: &RealtimeBillingReservationLeaseQueue,
    now_ms: f64,
) -> WorkerResult<()> {
    if queue.records.is_empty() {
        storage.delete(BILLING_RESERVATION_LEASES_KEY).await?;
    } else {
        storage
            .put(BILLING_RESERVATION_LEASES_KEY, queue.clone())
            .await?;
    }
    schedule_realtime_billing_alarm(storage, now_ms).await
}

async fn persist_realtime_billing_settlement_retry(
    storage: &mut Storage,
    retry: &mut RealtimeBillingSettlementRetryRecord,
    now_ms: f64,
    delay_ms: u64,
) -> WorkerResult<()> {
    retry.updated_at_ms = now_ms;
    retry.next_retry_at_ms = Some(now_ms + delay_ms as f64);
    let mut queue = load_realtime_billing_settlement_retry(storage)
        .await?
        .unwrap_or_default();
    if let Some(existing) = queue
        .records
        .iter_mut()
        .find(|existing| existing.replay_key == retry.replay_key)
    {
        *existing = retry.clone();
    } else {
        if queue.records.len() >= BILLING_SETTLEMENT_RETRY_MAX_RECORDS {
            return Err(worker::Error::RustError(format!(
                "realtime settlement retry queue reached {} records",
                BILLING_SETTLEMENT_RETRY_MAX_RECORDS
            )));
        }
        queue.records.push(retry.clone());
    }
    store_realtime_billing_settlement_retry_queue(storage, &queue, now_ms).await
}

async fn clear_realtime_billing_settlement_retry(
    storage: &mut Storage,
    replay_key: &str,
    now_ms: f64,
) -> WorkerResult<()> {
    let Some(mut queue) = load_realtime_billing_settlement_retry(storage).await? else {
        return Ok(());
    };
    queue
        .records
        .retain(|record| record.replay_key != replay_key);
    store_realtime_billing_settlement_retry_queue(storage, &queue, now_ms).await
}

async fn store_realtime_billing_settlement_retry_queue(
    storage: &mut Storage,
    queue: &RealtimeBillingSettlementRetryQueue,
    now_ms: f64,
) -> WorkerResult<()> {
    if queue.records.is_empty() {
        storage.delete(BILLING_SETTLEMENT_RETRY_KEY).await?;
    } else {
        storage
            .put(BILLING_SETTLEMENT_RETRY_KEY, queue.clone())
            .await?;
    }
    schedule_realtime_billing_alarm(storage, now_ms).await
}

async fn schedule_realtime_billing_alarm(storage: &mut Storage, _now_ms: f64) -> WorkerResult<()> {
    let retry_at_ms = load_realtime_billing_settlement_retry(storage)
        .await?
        .and_then(|queue| queue.next_retry_at_ms());
    let lease_at_ms = load_realtime_billing_reservation_leases(storage)
        .await?
        .and_then(|queue| queue.next_expiry_at_ms());
    let next_at_ms = match (retry_at_ms, lease_at_ms) {
        (Some(retry), Some(lease)) => Some(retry.min(lease)),
        (Some(retry), None) => Some(retry),
        (None, Some(lease)) => Some(lease),
        (None, None) => None,
    };
    let Some(next_at_ms) = next_at_ms else {
        return storage.delete_alarm().await;
    };
    let delay_ms = (next_at_ms - js_sys::Date::now()).max(1.0) as u64;
    storage.set_alarm(Duration::from_millis(delay_ms)).await
}

fn realtime_billing_settlement_retry_delay_ms(attempts: u8) -> u64 {
    let exponent = u32::from(attempts.saturating_sub(1).min(15));
    BILLING_SETTLEMENT_RETRY_INITIAL_DELAY_MS
        .saturating_mul(1_u64 << exponent)
        .min(BILLING_SETTLEMENT_RETRY_MAX_DELAY_MS)
}

fn realtime_billing_reservation_owned_by_retry(
    queue: &RealtimeBillingSettlementRetryQueue,
    reservation_key: &str,
    reservation_sequence: i64,
    lease_expires_at: i64,
) -> bool {
    queue.records.iter().any(|retry| {
        retry.reservation_key == reservation_key
            && retry.reservation_sequence == reservation_sequence
            && retry.lease_expires_at == lease_expires_at
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RealtimeBillingRetryFailureOwnership {
    SettlementRetry,
    Refunded,
    ReservationLease,
}

fn realtime_billing_retry_failure_ownership(
    exhausted_refunded: bool,
    exhausted_refund_deferred: bool,
) -> RealtimeBillingRetryFailureOwnership {
    if exhausted_refunded {
        RealtimeBillingRetryFailureOwnership::Refunded
    } else if exhausted_refund_deferred {
        RealtimeBillingRetryFailureOwnership::ReservationLease
    } else {
        RealtimeBillingRetryFailureOwnership::SettlementRetry
    }
}

async fn record_realtime_billing_settlement_retry_metrics(
    storage: &mut Storage,
    retry: &RealtimeBillingSettlementRetryRecord,
    now_ms: f64,
    attempted: bool,
    applied: bool,
    skipped_reason: Option<&str>,
) -> WorkerResult<()> {
    let mut metrics =
        load_realtime_session_metrics(storage, &retry.attachment.session, now_ms).await?;
    let mut metadata = realtime_billing_settlement_write_metadata(
        &retry.preview,
        Some(&retry.mutation_plan),
        Some(&retry.replay_key),
        applied,
        true,
        attempted,
        applied,
        skipped_reason,
        if applied {
            None
        } else {
            retry.last_error.as_deref()
        },
    );
    metadata.audit_plan_present = true;
    metadata.audit_attempted = attempted;
    metadata.audit_recorded = applied;
    metadata.audit_error = (!applied).then(|| retry.last_error.clone()).flatten();
    metadata.apply_retry_status(&retry.status());
    metrics.record_billing_settlement_write(Some(&retry.attachment), now_ms, metadata);
    store_realtime_session_metrics(storage, &metrics).await
}

impl RealtimeBillingSettlementRetryRecord {
    fn new(
        attachment: &SocketAttachment,
        preview: &RealtimeBillingSettlementPreviewMetadata,
        handoff: &RealtimeBillingSettlementHandoff,
        reservation_key: &str,
        reservation_sequence: i64,
        lease_expires_at: i64,
        upstream_response_id_hash: &str,
        replay_key: &str,
        now_ms: f64,
        error: &str,
    ) -> Option<Self> {
        if reservation_sequence <= 0 || lease_expires_at <= 0 {
            return None;
        }
        Some(Self {
            attachment: attachment.clone(),
            preview: preview.clone(),
            snapshot: handoff.snapshot.clone(),
            mutation_plan: handoff.mutation_plan()?.clone(),
            audit_plan: handoff.audit_plan()?.clone(),
            reservation_key: reservation_key.to_string(),
            reservation_sequence,
            lease_expires_at,
            upstream_response_id_hash: upstream_response_id_hash.to_string(),
            replay_key: replay_key.to_string(),
            attempts: 1,
            max_attempts: BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            next_retry_at_ms: None,
            paused: false,
            exhausted: false,
            last_error: truncate_text(error, MAX_STORED_TEXT_CHARS),
        })
    }

    fn status(&self) -> RealtimeBillingSettlementRetryStatus {
        RealtimeBillingSettlementRetryStatus {
            record_count: 1,
            pending: self.next_retry_at_ms.is_some(),
            paused: self.paused,
            exhausted: self.exhausted,
            attempts: self.attempts,
            max_attempts: self.max_attempts,
            next_retry_at_ms: self.next_retry_at_ms,
            last_error: self.last_error.clone(),
        }
    }
}

impl RealtimeBillingSettlementRetryQueue {
    fn next_retry_at_ms(&self) -> Option<f64> {
        self.records
            .iter()
            .filter_map(|record| record.next_retry_at_ms)
            .min_by(|left, right| left.total_cmp(right))
    }

    fn next_due_refund_index(&self, now_ms: f64) -> Option<usize> {
        self.records
            .iter()
            .enumerate()
            .filter(|(_, record)| record.exhausted)
            .filter_map(|(index, record)| {
                record
                    .next_retry_at_ms
                    .filter(|next_at_ms| *next_at_ms <= now_ms)
                    .map(|next_at_ms| (index, next_at_ms))
            })
            .min_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(index, _)| index)
    }

    fn next_due_index(&self, now_ms: f64) -> Option<usize> {
        self.records
            .iter()
            .enumerate()
            .filter(|(_, record)| !record.paused && !record.exhausted)
            .filter_map(|(index, record)| {
                record
                    .next_retry_at_ms
                    .filter(|next_at_ms| *next_at_ms <= now_ms)
                    .map(|next_at_ms| (index, next_at_ms))
            })
            .min_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(index, _)| index)
    }

    fn status(&self) -> Option<RealtimeBillingSettlementRetryStatus> {
        let representative = self.records.iter().min_by(|left, right| {
            match (left.next_retry_at_ms, right.next_retry_at_ms) {
                (Some(left), Some(right)) => left.total_cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => left.created_at_ms.total_cmp(&right.created_at_ms),
            }
        })?;
        Some(RealtimeBillingSettlementRetryStatus {
            record_count: self.records.len(),
            pending: self
                .records
                .iter()
                .any(|record| record.next_retry_at_ms.is_some()),
            paused: self
                .records
                .iter()
                .filter(|record| !record.exhausted)
                .all(|record| record.paused),
            exhausted: self.records.iter().all(|record| record.exhausted),
            attempts: self
                .records
                .iter()
                .map(|record| record.attempts)
                .max()
                .unwrap_or(0),
            max_attempts: representative.max_attempts,
            next_retry_at_ms: self.next_retry_at_ms(),
            last_error: representative.last_error.clone(),
        })
    }
}

impl RealtimeBillingReservationLeaseQueue {
    fn upsert(
        &mut self,
        reservation_key: &str,
        reservation_sequence: i64,
        lease_expires_at: i64,
        expires_at_ms: f64,
    ) -> Result<(), String> {
        if reservation_sequence <= 0 || lease_expires_at <= 0 {
            return Err("realtime billing reservation lease identity is invalid".to_string());
        }
        if let Some(existing) = self
            .records
            .iter_mut()
            .find(|record| record.reservation_key == reservation_key)
        {
            if existing.reservation_sequence == reservation_sequence {
                existing.lease_expires_at = existing.lease_expires_at.min(lease_expires_at);
                existing.expires_at_ms = existing.expires_at_ms.min(expires_at_ms);
            } else {
                existing.reservation_sequence = reservation_sequence;
                existing.lease_expires_at = lease_expires_at;
                existing.expires_at_ms = expires_at_ms;
                existing.attempts = 0;
                existing.last_error = None;
            }
            return Ok(());
        }
        if self.records.len() >= BILLING_RESERVATION_LEASE_MAX_RECORDS {
            return Err(format!(
                "realtime billing reservation lease queue reached {} records",
                BILLING_RESERVATION_LEASE_MAX_RECORDS
            ));
        }
        self.records.push(RealtimeBillingReservationLeaseRecord {
            reservation_key: reservation_key.to_string(),
            reservation_sequence,
            lease_expires_at,
            expires_at_ms,
            attempts: 0,
            last_error: None,
        });
        Ok(())
    }

    fn next_expiry_at_ms(&self) -> Option<f64> {
        self.records
            .iter()
            .map(|record| record.expires_at_ms)
            .min_by(|left, right| left.total_cmp(right))
    }

    fn next_due_index(&self, now_ms: f64) -> Option<usize> {
        self.records
            .iter()
            .enumerate()
            .filter(|(_, record)| record.expires_at_ms <= now_ms)
            .min_by(|(_, left), (_, right)| left.expires_at_ms.total_cmp(&right.expires_at_ms))
            .map(|(index, _)| index)
    }

    fn status(&self, now_ms: f64) -> Option<RealtimeBillingReservationLeaseStatus> {
        let representative = self
            .records
            .iter()
            .min_by(|left, right| left.expires_at_ms.total_cmp(&right.expires_at_ms))?;
        Some(RealtimeBillingReservationLeaseStatus {
            record_count: self.records.len(),
            due_count: self
                .records
                .iter()
                .filter(|record| record.expires_at_ms <= now_ms)
                .count(),
            next_expiry_at_ms: self.next_expiry_at_ms(),
            highest_attempts: self
                .records
                .iter()
                .map(|record| record.attempts)
                .max()
                .unwrap_or(0),
            last_error: representative.last_error.clone(),
        })
    }
}

impl RealtimeBillingSettlementWriteMetadata {
    fn apply_retry_status(&mut self, status: &RealtimeBillingSettlementRetryStatus) {
        self.retry_scheduled = status.pending && status.next_retry_at_ms.is_some();
        self.retry_attempt = status.attempts;
        self.retry_max_attempts = status.max_attempts;
        self.retry_exhausted = status.exhausted;
        self.retry_next_at_ms = status.next_retry_at_ms;
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
            usage_event_count: 0,
            last_usage_at_ms: None,
            last_usage: None,
            billing_snapshot_count: 0,
            last_billing_snapshot_at_ms: None,
            last_billing_snapshot: None,
            billing_settlement_preview_count: 0,
            last_billing_settlement_preview_at_ms: None,
            last_billing_settlement_preview: None,
            billing_settlement_write_count: 0,
            billing_settlement_applied_count: 0,
            last_billing_settlement_write_at_ms: None,
            last_billing_settlement_write: None,
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
    ) -> Option<RealtimeBillingSettlementPreviewMetadata> {
        let preview = billing_settlement.and_then(|handoff| {
            realtime_billing_settlement_preview(
                &handoff.snapshot,
                &usage,
                handoff.request.clone(),
                handoff.mutation_plan(),
            )
            .map_err(|err| {
                worker::console_warn!("RealtimeSession billing settlement preview failed: {}", err);
                err
            })
            .ok()
        });
        self.usage_event_count = self.usage_event_count.saturating_add(1);
        self.last_usage_at_ms = Some(now_ms);
        self.last_usage = Some(usage);
        self.record_context(attachment, now_ms);
        if let Some(preview) = preview.as_ref() {
            self.record_billing_settlement_preview(attachment, now_ms, preview.clone());
        }
        preview
    }

    fn record_billing_snapshot(&mut self, attachment: Option<&SocketAttachment>, now_ms: f64) {
        let Some(snapshot) = attachment
            .and_then(|attachment| attachment.upstream.as_ref())
            .and_then(|upstream| upstream.billing_snapshot.clone())
        else {
            return;
        };
        self.record_billing_snapshot_metadata(attachment, now_ms, snapshot);
    }

    fn record_billing_snapshot_metadata(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        snapshot: RealtimeBillingSnapshotMetadata,
    ) {
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

    fn record_billing_settlement_write(
        &mut self,
        attachment: Option<&SocketAttachment>,
        now_ms: f64,
        metadata: RealtimeBillingSettlementWriteMetadata,
    ) {
        self.billing_settlement_write_count = self.billing_settlement_write_count.saturating_add(1);
        if metadata.applied {
            self.billing_settlement_applied_count =
                self.billing_settlement_applied_count.saturating_add(1);
        }
        self.last_billing_settlement_write_at_ms = Some(now_ms);
        self.last_billing_settlement_write = Some(metadata);
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

#[cfg(test)]
fn realtime_gateway_candidate(path: &str) -> bool {
    cinatoken_gateway::realtime_gateway_candidate(path)
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

    if !realtime_billing_settlement_write_enabled(&env) {
        return realtime_error_response(
            "realtime_billing_settlement_disabled",
            "OpenAI Realtime requires billing settlement writes to be enabled",
            "server_error",
            503,
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

pub(crate) fn realtime_upstream_bridge_hibernation_fail_closed_compiled() -> bool {
    let action = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamUnavailable);
    let event = realtime_bridge_terminal_event(
        RealtimeBridgeCloseCause::UpstreamUnavailable,
        action,
        1.0,
        None,
    );
    realtime_upstream_bridge_requires_terminal(true, false)
        && !realtime_upstream_bridge_requires_terminal(true, true)
        && !realtime_upstream_bridge_requires_terminal(false, false)
        && action.client_code == REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        && action.client_reason == REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE
        && event.event == "upstream_unavailable"
        && event.direction == "upstream_to_client"
        && event.frame_kind.is_none()
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
                "id":"resp_realtime_123",
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
    let Ok(preview) = realtime_billing_settlement_preview(&snapshot, &usage, request, None) else {
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
        && !preview.mutation_plan_present
        && !preview.mutation_token_scoped
        && !preview.mutation_channel_scoped
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
                    && !preview.mutation_plan_present
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

pub(crate) fn realtime_billing_settlement_mutation_plan_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_MUTATION_PLAN_COMPILED {
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
    let handoff = RealtimeBillingSettlementHandoff::new(snapshot.clone(), request)
        .with_mutation_plan(RealtimeBillingSettlementMutationPlan::new(
            101,
            202,
            303,
            "default",
            snapshot.estimated_quota_after_group.0,
        ));
    let Ok(selected) = realtime_selected_upstream(RealtimeSelectedUpstreamInput {
        selected_group: "default",
        channel_id: 303,
        channel_type: 1,
        channel_name: "openai-primary",
        channel_base_url: Some("https://api.openai.com"),
        request_model: "gpt-4o-realtime-preview",
        upstream_model: "gpt-4o-realtime-preview",
        upstream_api_key: "handoff-mutation-smoke-key",
        api_version: None,
        client_requested_subprotocol: true,
        billing_snapshot: Some(metadata),
        billing_settlement: Some(handoff),
        startup_queue_probe_delay_ms: None,
        mock_upstream_fault: None,
    }) else {
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
    let mut metrics = RealtimeSessionMetrics::new("handoff-mutation-smoke", 1.0);
    let attachment = SocketAttachment {
        session: "handoff-mutation-smoke".to_string(),
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
    let Some(decoded_handoff) = decoded.billing_settlement.as_ref() else {
        return false;
    };
    let Some(preview) = metrics.last_billing_settlement_preview.as_ref() else {
        return false;
    };
    let metrics_raw = serde_json::to_string(&metrics).unwrap_or_default();
    let attachment_raw = serde_json::to_string(&attachment).unwrap_or_default();

    decoded_handoff.mutation_plan().is_some()
        && preview.mutation_plan_present
        && preview.mutation_token_scoped
        && preview.mutation_channel_scoped
        && preview.pre_consumed_quota == snapshot.estimated_quota_after_group.0
        && !metrics_raw.contains("\"user_id\"")
        && !metrics_raw.contains("\"token_id\"")
        && !metrics_raw.contains("\"channel_id\"")
        && !metrics_raw.contains("\"selected_group\"")
        && !attachment_raw.contains("\"user_id\"")
        && !attachment_raw.contains("\"token_id\"")
        && !attachment_raw.contains("\"channel_id\"")
        && !attachment_raw.contains("\"selected_group\"")
        && !metrics_raw.contains(&snapshot.expr_string)
        && !metrics_raw.contains("service_tier")
        && !metrics_raw.contains("fast")
        && !metrics_raw.contains("param(")
}

pub(crate) fn realtime_billing_settlement_writer_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_WRITER_COMPILED {
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
    let handoff = RealtimeBillingSettlementHandoff::new(snapshot.clone(), request.clone())
        .with_mutation_plan(RealtimeBillingSettlementMutationPlan::new(
            101,
            202,
            303,
            "default",
            snapshot.estimated_quota_after_group.0,
        ));
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
    let Ok(preview) =
        realtime_billing_settlement_preview(&snapshot, &usage, request, handoff.mutation_plan())
    else {
        return false;
    };
    let disabled = realtime_billing_settlement_write_metadata(
        &preview,
        handoff.mutation_plan(),
        None,
        false,
        false,
        false,
        false,
        Some("write_disabled"),
        None,
    );
    let applied = realtime_billing_settlement_write_metadata(
        &preview,
        handoff.mutation_plan(),
        Some("rtsettle-smoke"),
        true,
        true,
        true,
        true,
        None,
        None,
    );
    let mut metrics = RealtimeSessionMetrics::new("settlement-writer-smoke", 1.0);
    metrics.record_billing_settlement_write(None, 2.0, disabled.clone());
    metrics.record_billing_settlement_write(None, 3.0, applied.clone());
    let raw =
        serde_json::to_string(&(disabled.clone(), applied.clone(), metrics)).unwrap_or_default();

    !disabled.write_enabled
        && !disabled.write_attempted
        && !disabled.applied
        && disabled.skipped_reason.as_deref() == Some("write_disabled")
        && applied.write_enabled
        && applied.write_attempted
        && applied.applied
        && applied.mutation_plan_present
        && applied.mutation_token_scoped
        && applied.mutation_channel_scoped
        && applied.pre_consumed_quota == snapshot.estimated_quota_after_group.0
        && applied.final_quota == 8300
        && applied.additional_quota == 5900
        && applied.refund_quota == 0
        && applied.delta_quota == 5900
        && applied.replay_key_hash.as_deref() == Some("rtsettle-smoke")
        && applied.replay_recorded
        && !raw.contains("\"user_id\"")
        && !raw.contains("\"token_id\"")
        && !raw.contains("\"channel_id\"")
        && !raw.contains("\"selected_group\"")
        && !raw.contains("101")
        && !raw.contains("202")
        && !raw.contains("303")
        && !raw.contains(&snapshot.expr_string)
        && !raw.contains("service_tier")
        && !raw.contains("fast")
        && !raw.contains("param(")
}

pub(crate) fn realtime_billing_settlement_replay_marker_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_REPLAY_MARKER_COMPILED {
        return false;
    }
    let preview = RealtimeBillingSettlementPreviewMetadata {
        billing_mode: "tiered_expr".to_string(),
        model_name: "gpt-4o-realtime-preview".to_string(),
        expr_hash: "exprhash123".to_string(),
        expr_version: 1,
        request_rule_present: true,
        usage_source_event: "response.done".to_string(),
        actual_prompt_tokens: 1000,
        actual_completion_tokens: 600,
        actual_total_tokens: 1600,
        pre_consumed_quota: 2400,
        final_quota: 8300,
        refund_quota: 0,
        additional_quota: 5900,
        matched_tier: "detail".to_string(),
        crossed_tier: false,
        mutation_plan_present: true,
        mutation_token_scoped: true,
        mutation_channel_scoped: true,
    };
    let plan = RealtimeBillingSettlementMutationPlan::new(101, 202, 303, "default", 2400);
    let attachment = SocketAttachment {
        session: "rt-replay-marker-smoke".to_string(),
        connected_at_ms: 1.0,
        protocol: None,
        entrypoint: "openai_realtime_v1".to_string(),
        model: Some("gpt-4o-realtime-preview".to_string()),
        token_source: Some("authorization".to_string()),
        token_fingerprint: Some("fp-token".to_string()),
        auth_state: "gateway_checked".to_string(),
        upstream: None,
        upstream_connect_handoff: true,
    };
    let replay_key = realtime_billing_settlement_replay_key(
        &attachment,
        &preview,
        &plan,
        "rtreserve-smoke",
        "response-smoke",
    );
    let duplicate = realtime_billing_settlement_write_metadata(
        &preview,
        Some(&plan),
        Some(&replay_key),
        true,
        true,
        false,
        false,
        Some("replay_duplicate"),
        None,
    );
    let raw = serde_json::to_string(&(replay_key.clone(), duplicate.clone())).unwrap_or_default();
    replay_key.starts_with("rtsettle-")
        && replay_key.len() == "rtsettle-".len() + 64
        && duplicate.replay_key_hash.as_deref() == Some(replay_key.as_str())
        && duplicate.replay_recorded
        && duplicate.skipped_reason.as_deref() == Some("replay_duplicate")
        && !raw.contains("\"user_id\"")
        && !raw.contains("\"token_id\"")
        && !raw.contains("\"channel_id\"")
        && !raw.contains("\"selected_group\"")
        && !raw.contains("101")
        && !raw.contains("202")
        && !raw.contains("303")
        && !raw.contains("service_tier")
        && !raw.contains("param(")
}

pub(crate) fn realtime_billing_settlement_audit_log_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_AUDIT_LOG_COMPILED {
        return false;
    }
    let expr = r#"tier("detail", p * 2 + c * 10 + cr * 0.5 + img * 3 + ao * 20)|||(param("service_tier") == "fast" ? 2 : 1)"#;
    let request = RequestInput::from_json_body(json!({
        "model": "gpt-4o-realtime-preview",
        "service_tier": "fast",
        "secret_probe": "do-not-persist"
    }));
    let Ok(snapshot) = cinatoken_billing::estimate_tiered_billing_snapshot_with_request(
        "gpt-4o-realtime-preview",
        expr,
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
    let plan = RealtimeBillingSettlementMutationPlan::new(
        101,
        202,
        303,
        "default",
        snapshot.estimated_quota_after_group.0,
    );
    let audit_plan = RealtimeBillingSettlementAuditPlan::new(
        "alice@example.test",
        "prod-token",
        Some("203.0.113.10".to_string()),
        Some("req-realtime-audit".to_string()),
        10,
        "realtime",
    );
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
    let Ok(preview) = realtime_billing_settlement_preview(&snapshot, &usage, request, Some(&plan))
    else {
        return false;
    };
    let attachment = SocketAttachment {
        session: "rt-audit-log-smoke".to_string(),
        connected_at_ms: 1.0,
        protocol: None,
        entrypoint: "openai_realtime_v1".to_string(),
        model: Some("gpt-4o-realtime-preview".to_string()),
        token_source: Some("authorization".to_string()),
        token_fingerprint: Some("fp-token".to_string()),
        auth_state: "gateway_checked".to_string(),
        upstream: None,
        upstream_connect_handoff: true,
    };
    let replay_key = realtime_billing_settlement_replay_key(
        &attachment,
        &preview,
        &plan,
        "rtreserve-audit-smoke",
        "response-audit-smoke",
    );
    let other = realtime_billing_settlement_audit_other(
        &attachment,
        &preview,
        &snapshot,
        &replay_key,
        true,
    );
    let mut metadata = realtime_billing_settlement_write_metadata(
        &preview,
        Some(&plan),
        Some(&replay_key),
        true,
        true,
        true,
        true,
        None,
        None,
    );
    metadata.audit_plan_present = true;
    metadata.audit_attempted = true;
    metadata.audit_recorded = true;
    let expr_parts = split_billing_expr_request_rule(expr);
    let expected_expr_b64 = base64_standard_encode(&expr_parts.billing_expr);
    let other_raw = other.to_string();
    let metadata_raw = serde_json::to_string(&metadata).unwrap_or_default();

    other.get("billing_mode").and_then(Value::as_str) == Some("tiered_expr")
        && other.get("expr_b64").and_then(Value::as_str) == Some(expected_expr_b64.as_str())
        && other.get("matched_tier").and_then(Value::as_str) == Some("detail")
        && other
            .get("tiered_billing")
            .and_then(|value| value.get("settlement"))
            .and_then(|value| value.get("final_quota"))
            .and_then(Value::as_i64)
            == Some(8300)
        && other
            .get("realtime_billing")
            .and_then(|value| value.get("replay_key_hash"))
            .and_then(Value::as_str)
            == Some(replay_key.as_str())
        && other
            .get("realtime_billing")
            .and_then(|value| value.get("replay_recorded"))
            .and_then(Value::as_bool)
            == Some(true)
        && !other_raw.contains(expr)
        && !other_raw.contains("service_tier")
        && !other_raw.contains("fast")
        && !other_raw.contains("secret_probe")
        && !other_raw.contains("param(")
        && !other_raw.contains("alice@example.test")
        && !other_raw.contains("prod-token")
        && !other_raw.contains("203.0.113.10")
        && !other_raw.contains("req-realtime-audit")
        && !metadata_raw.contains(&snapshot.expr_string)
        && !metadata_raw.contains("service_tier")
        && !metadata_raw.contains("fast")
        && !metadata_raw.contains("secret_probe")
        && !metadata_raw.contains("param(")
        && !metadata_raw.contains(&audit_plan.username)
        && !metadata_raw.contains(&audit_plan.token_name)
        && !metadata_raw.contains(audit_plan.client_ip.as_deref().unwrap_or_default())
        && !metadata_raw.contains(audit_plan.request_id.as_deref().unwrap_or_default())
}

pub(crate) fn realtime_billing_settlement_batch_compiled() -> bool {
    if !REALTIME_BILLING_SETTLEMENT_BATCH_COMPILED {
        return false;
    }
    let preview = RealtimeBillingSettlementPreviewMetadata {
        billing_mode: "tiered_expr".to_string(),
        model_name: "gpt-4o-realtime-preview".to_string(),
        expr_hash: "exprhash123".to_string(),
        expr_version: 1,
        request_rule_present: true,
        usage_source_event: "response.done".to_string(),
        actual_prompt_tokens: 1000,
        actual_completion_tokens: 600,
        actual_total_tokens: 1600,
        pre_consumed_quota: 2400,
        final_quota: 8300,
        refund_quota: 0,
        additional_quota: 5900,
        matched_tier: "detail".to_string(),
        crossed_tier: false,
        mutation_plan_present: true,
        mutation_token_scoped: true,
        mutation_channel_scoped: true,
    };
    let plan = RealtimeBillingSettlementMutationPlan::new(101, 202, 303, "default", 2400);
    let mut metadata = realtime_billing_settlement_write_metadata(
        &preview,
        Some(&plan),
        Some("rtsettle-batch-smoke"),
        true,
        true,
        true,
        true,
        None,
        None,
    );
    metadata.audit_plan_present = true;
    metadata.audit_attempted = true;
    metadata.audit_recorded = true;
    let duplicate = realtime_billing_settlement_write_metadata(
        &preview,
        Some(&plan),
        Some("rtsettle-batch-smoke"),
        true,
        true,
        false,
        false,
        Some("replay_duplicate"),
        None,
    );
    let missing_audit = realtime_billing_settlement_write_metadata(
        &preview,
        Some(&plan),
        Some("rtsettle-batch-smoke"),
        false,
        true,
        false,
        false,
        Some("audit_plan_missing"),
        None,
    );
    let raw = serde_json::to_string(&(metadata.clone(), duplicate.clone(), missing_audit.clone()))
        .unwrap_or_default();

    metadata.applied
        && metadata.replay_recorded
        && metadata.audit_plan_present
        && metadata.audit_attempted
        && metadata.audit_recorded
        && duplicate.skipped_reason.as_deref() == Some("replay_duplicate")
        && duplicate.replay_recorded
        && !duplicate.write_attempted
        && missing_audit.skipped_reason.as_deref() == Some("audit_plan_missing")
        && !missing_audit.applied
        && !missing_audit.replay_recorded
        && !raw.contains("\"user_id\"")
        && !raw.contains("\"token_id\"")
        && !raw.contains("\"channel_id\"")
        && !raw.contains("\"selected_group\"")
        && !raw.contains("101")
        && !raw.contains("202")
        && !raw.contains("303")
        && !raw.contains("service_tier")
        && !raw.contains("param(")
}

pub(crate) fn realtime_billing_settlement_retry_compiled() -> bool {
    REALTIME_BILLING_SETTLEMENT_RETRY_COMPILED
        && BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS > 1
        && BILLING_SETTLEMENT_RETRY_MAX_RECORDS > 1
        && BILLING_SETTLEMENT_RETRY_KEY.ends_with("_v2")
        && realtime_billing_settlement_retry_delay_ms(1) == 1_000
        && realtime_billing_settlement_retry_delay_ms(2) == 2_000
        && realtime_billing_settlement_retry_delay_ms(6) == 30_000
        && realtime_billing_settlement_retry_delay_ms(u8::MAX) == 30_000
}

pub(crate) fn realtime_billing_reservation_lease_compiled() -> bool {
    REALTIME_BILLING_RESERVATION_LEASE_COMPILED
        && BILLING_RESERVATION_LEASE_MAX_RECORDS > BILLING_SETTLEMENT_RETRY_MAX_RECORDS
        && BILLING_RESERVATION_LEASE_MIN_SECONDS < BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
        && BILLING_RESERVATION_LEASE_DEFAULT_SECONDS < BILLING_RESERVATION_LEASE_MAX_SECONDS
        && normalize_realtime_billing_reservation_lease_seconds(None)
            == BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
        && normalize_realtime_billing_reservation_lease_seconds(Some("30".to_string())) == 30
        && normalize_realtime_billing_reservation_lease_seconds(Some("3600".to_string())) == 3_600
        && normalize_realtime_billing_reservation_lease_seconds(Some("0".to_string()))
            == BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
}

fn realtime_billing_settlement_preview(
    snapshot: &TieredBillingSnapshot,
    usage: &RealtimeUsageMetadata,
    request: RequestInput,
    mutation_plan: Option<&RealtimeBillingSettlementMutationPlan>,
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
        snapshot,
        usage,
        &result,
        mutation_plan,
    ))
}

impl RealtimeBillingSettlementHandoff {
    pub(crate) fn new(snapshot: TieredBillingSnapshot, request: RequestInput) -> Self {
        Self {
            snapshot,
            request,
            mutation_plan: None,
            audit_plan: None,
        }
    }

    pub(crate) fn with_mutation_plan(
        mut self,
        plan: RealtimeBillingSettlementMutationPlan,
    ) -> Self {
        self.mutation_plan = Some(plan);
        self
    }

    pub(crate) fn with_audit_plan(mut self, plan: RealtimeBillingSettlementAuditPlan) -> Self {
        self.audit_plan = Some(plan);
        self
    }

    fn mutation_plan(&self) -> Option<&RealtimeBillingSettlementMutationPlan> {
        self.mutation_plan.as_ref()
    }

    fn audit_plan(&self) -> Option<&RealtimeBillingSettlementAuditPlan> {
        self.audit_plan.as_ref()
    }
}

impl RealtimeBillingSettlementMutationPlan {
    pub(crate) fn new(
        user_id: i64,
        token_id: i64,
        channel_id: i64,
        selected_group: &str,
        pre_consumed_quota: i64,
    ) -> Self {
        Self {
            user_id,
            token_id,
            channel_id,
            selected_group: selected_group.to_string(),
            pre_consumed_quota: pre_consumed_quota.max(0),
        }
    }

    fn token_scoped(&self) -> bool {
        self.token_id > 0
    }

    fn channel_scoped(&self) -> bool {
        self.channel_id > 0
    }
}

impl RealtimeBillingSettlementAuditPlan {
    pub(crate) fn new(
        username: &str,
        token_name: &str,
        client_ip: Option<String>,
        request_id: Option<String>,
        started_at: i64,
        endpoint_path: &str,
    ) -> Self {
        Self {
            username: username.to_string(),
            token_name: token_name.to_string(),
            client_ip,
            request_id,
            started_at,
            endpoint_path: endpoint_path.to_string(),
        }
    }
}

fn realtime_billing_settlement_write_enabled(env: &Env) -> bool {
    env_flag(env, REALTIME_BILLING_SETTLEMENT_WRITE_ENABLED_ENV)
}

pub(crate) fn realtime_billing_reservation_lease_seconds(env: &Env) -> u64 {
    normalize_realtime_billing_reservation_lease_seconds(
        env.var(REALTIME_BILLING_RESERVATION_LEASE_SECONDS_ENV)
            .ok()
            .map(|value| value.to_string()),
    )
}

fn normalize_realtime_billing_reservation_lease_seconds(value: Option<String>) -> u64 {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| {
            (BILLING_RESERVATION_LEASE_MIN_SECONDS..=BILLING_RESERVATION_LEASE_MAX_SECONDS)
                .contains(value)
        })
        .unwrap_or(BILLING_RESERVATION_LEASE_DEFAULT_SECONDS)
}

fn realtime_billing_settlement_write_metadata(
    preview: &RealtimeBillingSettlementPreviewMetadata,
    mutation_plan: Option<&RealtimeBillingSettlementMutationPlan>,
    replay_key_hash: Option<&str>,
    replay_recorded: bool,
    write_enabled: bool,
    write_attempted: bool,
    applied: bool,
    skipped_reason: Option<&str>,
    error: Option<&str>,
) -> RealtimeBillingSettlementWriteMetadata {
    RealtimeBillingSettlementWriteMetadata {
        write_enabled,
        write_attempted,
        applied,
        skipped_reason: skipped_reason.map(str::to_string),
        error: error.and_then(|value| truncate_text(value, MAX_STORED_TEXT_CHARS)),
        pre_consumed_quota: preview.pre_consumed_quota,
        final_quota: preview.final_quota,
        refund_quota: preview.refund_quota,
        additional_quota: preview.additional_quota,
        delta_quota: preview
            .final_quota
            .saturating_sub(preview.pre_consumed_quota),
        replay_key_hash: replay_key_hash.map(str::to_string),
        replay_recorded,
        audit_plan_present: false,
        audit_attempted: false,
        audit_recorded: false,
        audit_error: None,
        mutation_plan_present: mutation_plan.is_some(),
        mutation_token_scoped: mutation_plan
            .map(RealtimeBillingSettlementMutationPlan::token_scoped)
            .unwrap_or(false),
        mutation_channel_scoped: mutation_plan
            .map(RealtimeBillingSettlementMutationPlan::channel_scoped)
            .unwrap_or(false),
        retry_scheduled: false,
        retry_attempt: 0,
        retry_max_attempts: BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS,
        retry_exhausted: false,
        retry_next_at_ms: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RealtimeBillingSettlementWriteOutcome {
    Applied,
    DuplicateReplay,
}

fn realtime_billing_settlement_replay_key(
    attachment: &SocketAttachment,
    preview: &RealtimeBillingSettlementPreviewMetadata,
    plan: &RealtimeBillingSettlementMutationPlan,
    reservation_key: &str,
    upstream_response_id_hash: &str,
) -> String {
    let seed = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        attachment.session.trim(),
        reservation_key.trim(),
        upstream_response_id_hash.trim(),
        preview.model_name.trim(),
        preview.expr_hash.trim(),
        preview.expr_version,
        preview.usage_source_event.trim(),
        plan.pre_consumed_quota,
        preview.pre_consumed_quota,
        preview.final_quota,
        plan.token_scoped(),
        plan.channel_scoped()
    );
    format!("rtsettle-{}", realtime_billing_identity_hash(&seed))
}

async fn apply_realtime_billing_settlement_write(
    env: &Env,
    attachment: &SocketAttachment,
    preview: &RealtimeBillingSettlementPreviewMetadata,
    snapshot: &TieredBillingSnapshot,
    plan: &RealtimeBillingSettlementMutationPlan,
    audit_plan: &RealtimeBillingSettlementAuditPlan,
    reservation_key: &str,
    upstream_response_id_hash: &str,
    replay_key: &str,
) -> Result<RealtimeBillingSettlementWriteOutcome, String> {
    let db = env
        .d1("DB")
        .map_err(|err| format!("failed to load DB binding for realtime settlement: {err}"))?;
    let now = crate::admin::unix_timestamp();
    let other_json =
        realtime_billing_settlement_audit_other(attachment, preview, snapshot, replay_key, true)
            .to_string();
    let empty = "";
    let audit_log = RelayAuditLog {
        user_id: plan.user_id,
        username: &audit_plan.username,
        token_id: plan.token_id,
        token_name: &audit_plan.token_name,
        channel_id: plan.channel_id,
        model: &preview.model_name,
        group: &plan.selected_group,
        prompt_tokens: clamp_i64_to_i32(preview.actual_prompt_tokens),
        completion_tokens: clamp_i64_to_i32(preview.actual_completion_tokens),
        quota: preview.final_quota,
        use_time_seconds: now.saturating_sub(audit_plan.started_at),
        is_stream: true,
        ip: audit_plan.client_ip.as_deref().unwrap_or(empty),
        request_id: audit_plan.request_id.as_deref().unwrap_or(empty),
        upstream_request_id: empty,
        other: &other_json,
    };
    let content = format!(
        "Rust realtime settled {}; tiered quota {}",
        audit_plan.endpoint_path, preview.final_quota
    );
    match crate::d1_repositories::apply_realtime_reserved_settlement_batch(
        &db,
        reservation_key,
        upstream_response_id_hash,
        crate::d1_repositories::RealtimeSettlementReplayRecord {
            replay_key,
            session: &attachment.session,
            user_id: plan.user_id,
            token_id: plan.token_id,
            channel_id: plan.channel_id,
            model_name: &preview.model_name,
            pre_consumed_quota: plan.pre_consumed_quota,
            final_quota: preview.final_quota,
            created_at: now,
            applied_at: now,
        },
        &content,
        &audit_log,
    )
    .await
    {
        Ok(crate::d1_repositories::RealtimeSettlementBatchOutcome::Applied) => {
            Ok(RealtimeBillingSettlementWriteOutcome::Applied)
        }
        Ok(crate::d1_repositories::RealtimeSettlementBatchOutcome::DuplicateReplay) => {
            Ok(RealtimeBillingSettlementWriteOutcome::DuplicateReplay)
        }
        Err(err) => Err(format!(
            "failed to apply realtime settlement batch with replay marker and audit log: {err}"
        )),
    }
}

fn realtime_billing_settlement_audit_other(
    attachment: &SocketAttachment,
    preview: &RealtimeBillingSettlementPreviewMetadata,
    snapshot: &TieredBillingSnapshot,
    replay_key: &str,
    replay_recorded: bool,
) -> Value {
    let expr_parts = split_billing_expr_request_rule(&snapshot.expr_string);
    json!({
        "billing_pending": false,
        "relay_runtime": "cloudflare_worker_rust",
        "endpoint": "realtime",
        "upstream_status": 101,
        "total_tokens": preview.actual_total_tokens,
        "usage_source": "upstream",
        "billing_mode": snapshot.billing_mode,
        "expr_b64": base64_standard_encode(&expr_parts.billing_expr),
        "matched_tier": preview.matched_tier,
        "tiered_billing": {
            "billing_mode": snapshot.billing_mode,
            "shadow_only": false,
            "applied": true,
            "expr_hash": snapshot.expr_hash,
            "expr_version": snapshot.expr_version,
            "has_request_rule": snapshot.request_rule_expr.is_some(),
            "group_ratio": snapshot.group_ratio,
            "pre_consumed_quota": preview.pre_consumed_quota,
            "estimated_prompt_tokens": snapshot.estimated_prompt_tokens,
            "estimated_completion_tokens": snapshot.estimated_completion_tokens,
            "estimated_expression_cost": snapshot.estimated_expression_cost,
            "estimated_quota_before_group": snapshot.estimated_quota_before_group,
            "estimated_quota_after_group": snapshot.estimated_quota_after_group.0,
            "estimated_tier": snapshot.estimated_tier,
            "matched_tier": preview.matched_tier,
            "crossed_tier": preview.crossed_tier,
            "quota_after_group": preview.final_quota,
            "settlement": {
                "final_quota": preview.final_quota,
                "refund_quota": preview.refund_quota,
                "additional_quota": preview.additional_quota,
            }
        },
        "realtime_billing": {
            "session": attachment.session,
            "usage_source_event": preview.usage_source_event,
            "replay_key_hash": replay_key,
            "replay_recorded": replay_recorded,
        }
    })
}

fn base64_standard_encode(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let bytes = input.as_bytes();
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or_default() as u32;
        let b2 = chunk.get(2).copied().unwrap_or_default() as u32;
        let bits = (b0 << 16) | (b1 << 8) | b2;

        encoded.push(TABLE[((bits >> 18) & 0x3f) as usize] as char);
        encoded.push(TABLE[((bits >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[((bits >> 6) & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(bits & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
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
    env: &Env,
    attachment: &SocketAttachment,
    now_ms: f64,
    usage: RealtimeUsageMetadata,
    billing_settlement: Option<&RealtimeBillingSettlementHandoff>,
) -> WorkerResult<()> {
    let mut metrics = load_realtime_session_metrics(storage, &attachment.session, now_ms).await?;
    let write_enabled = realtime_billing_settlement_write_enabled(env);
    let response_identity_hash = usage.response_identity_hash.clone();
    let db = env.d1("DB")?;
    if crate::d1_repositories::realtime_response_settlement_applied(
        &db,
        &attachment.session,
        &response_identity_hash,
    )
    .await?
    {
        metrics.record_realtime_usage(Some(attachment), now_ms, usage, None);
        return store_realtime_session_metrics(storage, &metrics).await;
    }
    let retry_queue = load_realtime_billing_settlement_retry(storage)
        .await?
        .unwrap_or_default();
    if retry_queue
        .records
        .iter()
        .any(|record| record.upstream_response_id_hash == response_identity_hash)
    {
        metrics.record_realtime_usage(Some(attachment), now_ms, usage, None);
        return store_realtime_session_metrics(storage, &metrics).await;
    }
    let reservation = if write_enabled {
        let mut reservation = crate::d1_repositories::realtime_billing_reservation_for_response(
            &db,
            &attachment.session,
            &response_identity_hash,
        )
        .await?;
        if reservation.is_none() {
            match crate::d1_repositories::bind_realtime_response_to_reservation(
                &db,
                &attachment.session,
                &response_identity_hash,
                crate::admin::unix_timestamp(),
            )
            .await?
            {
                crate::d1_repositories::RealtimeBillingResponseBindOutcome::Applied
                | crate::d1_repositories::RealtimeBillingResponseBindOutcome::Duplicate => {
                    reservation =
                        crate::d1_repositories::realtime_billing_reservation_for_response(
                            &db,
                            &attachment.session,
                            &response_identity_hash,
                        )
                        .await?;
                }
                crate::d1_repositories::RealtimeBillingResponseBindOutcome::NotFound => {}
            }
        }
        reservation.filter(|reservation| reservation.status == "reserved")
    } else {
        None
    };
    if !realtime_usage_metadata_has_tokens(&usage) {
        if let Some(reservation) = reservation.as_ref() {
            crate::d1_repositories::refund_realtime_billing_reservation_for_response(
                &db,
                &reservation.reservation_key,
                &response_identity_hash,
                crate::admin::unix_timestamp(),
            )
            .await?;
            clear_realtime_billing_reservation_lease(storage, &reservation.reservation_key, now_ms)
                .await?;
        }
        metrics.record_realtime_usage(Some(attachment), now_ms, usage, None);
        return store_realtime_session_metrics(storage, &metrics).await;
    }
    if write_enabled && reservation.is_none() {
        metrics.record_realtime_usage(Some(attachment), now_ms, usage, None);
        metrics.record_billing_settlement_write(
            Some(attachment),
            now_ms,
            RealtimeBillingSettlementWriteMetadata {
                write_enabled: true,
                skipped_reason: Some("reservation_missing".to_string()),
                error: Some("response.done has no unclaimed billing reservation".to_string()),
                ..RealtimeBillingSettlementWriteMetadata::default()
            },
        );
        return store_realtime_session_metrics(storage, &metrics).await;
    }
    let reserved_handoff = reservation
        .as_ref()
        .map(realtime_billing_handoff_from_reservation)
        .transpose()
        .map_err(worker::Error::RustError)?;
    let effective_handoff = if write_enabled {
        reserved_handoff.as_ref()
    } else {
        reserved_handoff.as_ref().or(billing_settlement)
    };
    let billing_snapshot = effective_handoff.map(|handoff| handoff.snapshot.clone());
    let audit_plan = effective_handoff
        .and_then(RealtimeBillingSettlementHandoff::audit_plan)
        .cloned();
    let audit_plan_present = audit_plan.is_some();
    let mutation_plan = effective_handoff
        .and_then(RealtimeBillingSettlementHandoff::mutation_plan)
        .cloned();
    let preview = metrics.record_realtime_usage(Some(attachment), now_ms, usage, effective_handoff);
    if let Some(preview) = preview.as_ref() {
        let reservation_key = reservation
            .as_ref()
            .map(|reservation| reservation.reservation_key.as_str());
        let replay_key = mutation_plan.as_ref().and_then(|plan| {
            reservation_key.map(|reservation_key| {
                realtime_billing_settlement_replay_key(
                    attachment,
                    preview,
                    plan,
                    reservation_key,
                    &response_identity_hash,
                )
            })
        });
        let replay_key_hash = replay_key.as_deref();
        let mut write = if !write_enabled {
            realtime_billing_settlement_write_metadata(
                preview,
                mutation_plan.as_ref(),
                replay_key_hash,
                false,
                false,
                false,
                false,
                Some("write_disabled"),
                None,
            )
        } else if reservation.is_none() {
            realtime_billing_settlement_write_metadata(
                preview,
                mutation_plan.as_ref(),
                None,
                false,
                true,
                false,
                false,
                Some("reservation_missing"),
                None,
            )
        } else if mutation_plan.is_none() {
            realtime_billing_settlement_write_metadata(
                preview,
                None,
                None,
                false,
                true,
                false,
                false,
                Some("mutation_plan_missing"),
                None,
            )
        } else if billing_snapshot.is_none() || audit_plan.is_none() {
            realtime_billing_settlement_write_metadata(
                preview,
                mutation_plan.as_ref(),
                replay_key_hash,
                false,
                true,
                false,
                false,
                Some("audit_plan_missing"),
                None,
            )
        } else if let Some(plan) = mutation_plan.as_ref() {
            let replay_key = replay_key.as_deref().unwrap_or_default();
            match apply_realtime_billing_settlement_write(
                env,
                attachment,
                preview,
                billing_snapshot.as_ref().expect("checked above"),
                plan,
                audit_plan.as_ref().expect("checked above"),
                reservation_key.expect("checked above"),
                &response_identity_hash,
                replay_key,
            )
            .await
            {
                Ok(RealtimeBillingSettlementWriteOutcome::Applied) => {
                    if let Err(err) =
                        clear_realtime_billing_settlement_retry(storage, replay_key, now_ms).await
                    {
                        worker::console_warn!(
                            "RealtimeSession settlement retry cleanup failed after apply: {}",
                            err
                        );
                    }
                    if let Err(err) = clear_realtime_billing_reservation_lease(
                        storage,
                        reservation_key.expect("checked above"),
                        now_ms,
                    )
                    .await
                    {
                        worker::console_warn!(
                            "RealtimeSession reservation lease cleanup failed after apply: {}",
                            err
                        );
                    }
                    let mut metadata = realtime_billing_settlement_write_metadata(
                        preview,
                        Some(plan),
                        replay_key_hash,
                        true,
                        true,
                        true,
                        true,
                        None,
                        None,
                    );
                    metadata.audit_attempted = true;
                    metadata.audit_recorded = true;
                    metadata
                }
                Ok(RealtimeBillingSettlementWriteOutcome::DuplicateReplay) => {
                    if let Err(err) =
                        clear_realtime_billing_settlement_retry(storage, replay_key, now_ms).await
                    {
                        worker::console_warn!(
                            "RealtimeSession settlement retry cleanup failed after duplicate: {}",
                            err
                        );
                    }
                    if let Err(err) = clear_realtime_billing_reservation_lease(
                        storage,
                        reservation_key.expect("checked above"),
                        now_ms,
                    )
                    .await
                    {
                        worker::console_warn!(
                            "RealtimeSession reservation lease cleanup failed after duplicate: {}",
                            err
                        );
                    }
                    let mut metadata = realtime_billing_settlement_write_metadata(
                        preview,
                        Some(plan),
                        replay_key_hash,
                        true,
                        true,
                        true,
                        true,
                        Some("replay_duplicate"),
                        None,
                    );
                    metadata.audit_attempted = true;
                    metadata.audit_recorded = true;
                    metadata
                }
                Err(err) => {
                    let mut metadata = realtime_billing_settlement_write_metadata(
                        preview,
                        Some(plan),
                        replay_key_hash,
                        false,
                        true,
                        true,
                        false,
                        Some("write_failed"),
                        Some(&err),
                    );
                    metadata.audit_attempted = true;
                    metadata.audit_error = truncate_text(&err, MAX_STORED_TEXT_CHARS);
                    if let Some(mut retry) = effective_handoff.and_then(|handoff| {
                        let reservation = reservation.as_ref()?;
                        RealtimeBillingSettlementRetryRecord::new(
                            attachment,
                            preview,
                            handoff,
                            reservation_key.expect("checked above"),
                            reservation.reservation_sequence,
                            reservation.lease_expires_at,
                            &response_identity_hash,
                            replay_key,
                            now_ms,
                            &err,
                        )
                    }) {
                        let retry_delay_ms =
                            realtime_billing_settlement_retry_delay_ms(retry.attempts);
                        match persist_realtime_billing_settlement_retry(
                            storage,
                            &mut retry,
                            now_ms,
                            retry_delay_ms,
                        )
                        .await
                        {
                            Ok(()) => {
                                if let Err(err) = clear_realtime_billing_reservation_lease(
                                    storage,
                                    reservation_key.expect("checked above"),
                                    now_ms,
                                )
                                .await
                                {
                                    worker::console_warn!(
                                        "RealtimeSession could not transfer reservation lease to settlement retry: {}",
                                        err
                                    );
                                }
                                metadata.apply_retry_status(&retry.status());
                            }
                            Err(schedule_err) => {
                                metadata.skipped_reason =
                                    Some("write_failed_retry_schedule_failed".to_string());
                                metadata.error = truncate_text(
                                    &format!(
                                        "{err}; failed to schedule settlement retry: {schedule_err}"
                                    ),
                                    MAX_STORED_TEXT_CHARS,
                                );
                            }
                        }
                    }
                    metadata
                }
            }
        } else {
            realtime_billing_settlement_write_metadata(
                preview,
                None,
                None,
                false,
                true,
                false,
                false,
                Some("mutation_plan_missing"),
                None,
            )
        };
        write.audit_plan_present = audit_plan_present;
        metrics.record_billing_settlement_write(Some(attachment), now_ms, write);
    }
    store_realtime_session_metrics(storage, &metrics).await
}

fn realtime_billing_handoff_from_reservation(
    reservation: &crate::d1_repositories::RealtimeBillingReservation,
) -> Result<RealtimeBillingSettlementHandoff, String> {
    let snapshot = serde_json::from_str::<TieredBillingSnapshot>(&reservation.snapshot_json)
        .map_err(|err| format!("failed to deserialize realtime billing snapshot: {err}"))?;
    let request = serde_json::from_str::<RequestInput>(&reservation.request_json)
        .map_err(|err| format!("failed to deserialize realtime billing request: {err}"))?;
    Ok(RealtimeBillingSettlementHandoff::new(snapshot, request)
        .with_mutation_plan(RealtimeBillingSettlementMutationPlan::new(
            reservation.user_id,
            reservation.token_id,
            reservation.channel_id,
            &reservation.selected_group,
            reservation.pre_consumed_quota,
        ))
        .with_audit_plan(RealtimeBillingSettlementAuditPlan::new(
            &reservation.username,
            &reservation.token_name,
            (!reservation.client_ip.is_empty()).then(|| reservation.client_ip.clone()),
            (!reservation.request_id.is_empty()).then(|| reservation.request_id.clone()),
            reservation.started_at,
            &reservation.endpoint_path,
        )))
}

fn realtime_response_create_event(text: &str) -> Result<Option<Value>, String> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Ok(None);
    };
    if value.get("type").and_then(Value::as_str) != Some("response.create") {
        return Ok(None);
    }
    if !value.is_object() {
        return Err("response.create event must be a JSON object".to_string());
    }
    Ok(Some(value))
}

fn realtime_enforce_explicit_response_mode(text: &str) -> Result<String, String> {
    let Ok(mut value) = serde_json::from_str::<Value>(text) else {
        return Ok(text.to_string());
    };
    if value.get("type").and_then(Value::as_str) != Some("session.update") {
        return Ok(text.to_string());
    }
    let Some(session) = value.get_mut("session").and_then(Value::as_object_mut) else {
        return Err("session.update must include a session object".to_string());
    };
    let Some(turn_detection) = session.get_mut("turn_detection") else {
        return Ok(text.to_string());
    };
    if turn_detection.is_null() {
        return Ok(text.to_string());
    }
    let Some(turn_detection) = turn_detection.as_object_mut() else {
        return Err("session.update turn_detection must be an object or null".to_string());
    };
    turn_detection.insert("create_response".to_string(), Value::Bool(false));
    turn_detection.remove("idle_timeout_ms");
    serde_json::to_string(&value)
        .map_err(|err| format!("failed to enforce explicit Realtime responses: {err}"))
}

fn realtime_explicit_response_bootstrap_event() -> String {
    json!({
        "type": "session.update",
        "event_id": "cinatoken-explicit-response-mode",
        "session": {
            "turn_detection": null
        }
    })
    .to_string()
}

fn realtime_response_create_request(
    event: &Value,
    handoff: &RealtimeBillingSettlementHandoff,
) -> RequestInput {
    let mut body = event.get("response").cloned().unwrap_or_else(|| json!({}));
    if !body.is_object() {
        body = json!({ "response": body });
    }
    if let Some(object) = body.as_object_mut() {
        object
            .entry("model".to_string())
            .or_insert_with(|| Value::String(handoff.snapshot.model_name.clone()));
        object.insert(
            "endpoint".to_string(),
            Value::String("realtime".to_string()),
        );
        object.insert(
            "realtime_event_type".to_string(),
            Value::String("response.create".to_string()),
        );
        if let Some(event_id) = event.get("event_id").cloned() {
            object.insert("event_id".to_string(), event_id);
        }
    }
    RequestInput::from_json_body(body).with_headers(handoff.request.headers.clone())
}

fn realtime_response_created_identity_hash(text: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    (value.get("type").and_then(Value::as_str) == Some("response.created"))
        .then(|| {
            value
                .pointer("/response/id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(realtime_billing_identity_hash)
        })
        .flatten()
}

fn realtime_usage_metadata_from_upstream_text_frame(text: &str) -> Option<RealtimeUsageMetadata> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let source_event = value.get("type").and_then(Value::as_str)?;
    if source_event != "response.done" {
        return None;
    }
    let response_identity = value
        .pointer("/response/id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let usage = usage_summary_from_body(text);
    RealtimeUsageMetadata::from_usage(source_event, response_identity, usage)
}

impl RealtimeUsageMetadata {
    fn from_usage(
        source_event: &str,
        response_identity: &str,
        usage: UsageSummary,
    ) -> Option<Self> {
        Some(Self {
            source_event: source_event.to_string(),
            response_identity_hash: realtime_billing_identity_hash(response_identity),
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
        mutation_plan: Option<&RealtimeBillingSettlementMutationPlan>,
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
            mutation_plan_present: mutation_plan.is_some(),
            mutation_token_scoped: mutation_plan
                .map(RealtimeBillingSettlementMutationPlan::token_scoped)
                .unwrap_or(false),
            mutation_channel_scoped: mutation_plan
                .map(RealtimeBillingSettlementMutationPlan::channel_scoped)
                .unwrap_or(false),
        }
    }
}

fn realtime_usage_metadata_has_tokens(usage: &RealtimeUsageMetadata) -> bool {
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
    env: Env,
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
        if billing_settlement.is_some() && realtime_billing_settlement_write_enabled(&env) {
            let bootstrap = realtime_explicit_response_bootstrap_event();
            if upstream.send_with_str(&bootstrap).is_err() {
                let cause = RealtimeBridgeCloseCause::ClientToUpstreamSendFailed;
                let action = realtime_bridge_close_action(cause);
                close_realtime_upstream_runtime(&runtime_state, action);
                send_realtime_bridge_terminal_event(
                    &client,
                    &context,
                    cause,
                    action,
                    Some(RealtimeBridgeFrameMetadata {
                        kind: RealtimeBridgeFrameKind::Text,
                        bytes: bootstrap.len(),
                        max_bytes: None,
                    }),
                );
                let _ = client.close(Some(action.client_code), Some(action.client_reason));
                return;
            }
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
                        if billing_settlement.is_some()
                            && realtime_billing_settlement_write_enabled(&env)
                        {
                            if let Some(response_identity_hash) =
                                realtime_response_created_identity_hash(&text)
                            {
                                let binding = match env.d1("DB") {
                                    Ok(db) => crate::d1_repositories::bind_realtime_response_to_reservation(
                                        &db,
                                        &attachment.session,
                                        &response_identity_hash,
                                        crate::admin::unix_timestamp(),
                                    )
                                    .await,
                                    Err(err) => Err(err),
                                };
                                if !matches!(
                                    binding,
                                    Ok(
                                        crate::d1_repositories::RealtimeBillingResponseBindOutcome::Applied
                                            | crate::d1_repositories::RealtimeBillingResponseBindOutcome::Duplicate
                                    )
                                ) {
                                    worker::console_warn!(
                                        "RealtimeSession could not bind response.created to a reservation"
                                    );
                                    let _ = client.send(&json!({
                                        "type": "error",
                                        "error": {
                                            "type": "server_error",
                                            "code": "billing_reservation_missing",
                                            "message": "Upstream response has no billing reservation"
                                        }
                                    }));
                                    let cause = RealtimeBridgeCloseCause::UpstreamEventStreamFailed;
                                    let action = realtime_bridge_close_action(cause);
                                    close_realtime_upstream_runtime(&runtime_state, action);
                                    let _ = client.close(
                                        Some(action.client_code),
                                        Some(action.client_reason),
                                    );
                                    break;
                                }
                            }
                        }
                        if let Some(usage) = realtime_usage_metadata_from_upstream_text_frame(&text)
                        {
                            let now_ms = js_sys::Date::now();
                            if record_realtime_upstream_usage(
                                &mut metrics_storage,
                                &env,
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
        RealtimeBridgeCloseCause::UpstreamUnavailable => {
            ("upstream_unavailable", "upstream_to_client", None)
        }
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
            | REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE
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
        RealtimeBridgeCloseCause::UpstreamUnavailable => RealtimeBridgeCloseAction {
            client_code: REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE,
            client_reason: REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE,
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

fn realtime_upstream_bridge_requires_terminal(
    upstream_connect_handoff: bool,
    active_bridge: bool,
) -> bool {
    upstream_connect_handoff && !active_bridge
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
    cinatoken_gateway::realtime_session_from_path(path)
}

#[cfg(test)]
fn normalize_session_name(value: &str) -> Option<String> {
    cinatoken_gateway::normalize_realtime_session_name(value)
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

fn realtime_billing_identity_hash(value: &str) -> String {
    expr_hash_string(value)
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
        assert!(!realtime_gateway_candidate(
            "/api/platform/realtime/settlement-batch/smoke"
        ));
        assert!(!realtime_gateway_candidate(
            "/api/platform/realtime/session-a/unknown"
        ));
        assert!(!realtime_gateway_candidate(
            "/api/platform/realtime/session-a/status/extra"
        ));
    }

    #[test]
    fn gateway_session_name_is_sanitized() {
        assert_eq!(
            session_from_gateway_path("/api/platform/realtime/Session_1/status").as_deref(),
            Some("session_1")
        );
        assert_eq!(
            session_from_gateway_path("/api/platform/realtime/Session_1/").as_deref(),
            Some("session_1")
        );
        assert!(session_from_gateway_path("/api/platform/realtime/../bad").is_none());
        assert!(session_from_gateway_path("/api/platform/realtime/").is_none());
        assert!(
            session_from_gateway_path("/api/platform/realtime/settlement-batch/smoke").is_none()
        );
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
                response_identity_hash: "response-metrics".to_string(),
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
    fn realtime_response_create_freezes_request_aware_billing_input() {
        let expr = r#"param("service_tier") == "fast" ? tier("fast", p * 4 + c * 20) : tier("normal", p * 2 + c * 10)"#;
        let template_request = RequestInput::from_json_body(json!({
            "model": "gpt-4o-realtime-preview",
            "endpoint": "realtime"
        }))
        .with_headers([("x-billing-region".to_string(), "sg".to_string())]);
        let snapshot = estimate_tiered_billing_snapshot_with_request(
            "gpt-4o-realtime-preview",
            expr,
            TokenParams {
                p: 1_000.0,
                c: 500.0,
                len: 1_000.0,
                ..TokenParams::default()
            },
            1.0,
            template_request.clone(),
        )
        .expect("template snapshot");
        let handoff = RealtimeBillingSettlementHandoff::new(snapshot, template_request);
        let event = realtime_response_create_event(
            r#"{"type":"response.create","event_id":"evt_123","response":{"service_tier":"fast","instructions":"private"}}"#,
        )
        .expect("valid event")
        .expect("response.create");
        let request = realtime_response_create_request(&event, &handoff);
        let body = request.body.as_ref().expect("request body");

        assert_eq!(
            body.get("model").and_then(Value::as_str),
            Some("gpt-4o-realtime-preview")
        );
        assert_eq!(
            body.get("endpoint").and_then(Value::as_str),
            Some("realtime")
        );
        assert_eq!(
            body.get("service_tier").and_then(Value::as_str),
            Some("fast")
        );
        assert_eq!(
            body.get("event_id").and_then(Value::as_str),
            Some("evt_123")
        );
        assert_eq!(
            request.headers.get("x-billing-region").map(String::as_str),
            Some("sg")
        );

        let response_snapshot = estimate_tiered_billing_snapshot_with_request(
            handoff.snapshot.model_name.clone(),
            handoff.snapshot.expr_string.clone(),
            TokenParams {
                p: 1_000.0,
                c: 500.0,
                len: 1_000.0,
                ..TokenParams::default()
            },
            handoff.snapshot.group_ratio,
            request,
        )
        .expect("response snapshot");
        assert_eq!(response_snapshot.estimated_tier, "fast");
        assert!(
            realtime_response_create_event(r#"{"type":"session.update"}"#)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn realtime_billing_requires_explicit_responses_with_vad_preserved() {
        let updated = realtime_enforce_explicit_response_mode(
            r#"{"type":"session.update","event_id":"evt-vad","session":{"turn_detection":{"type":"server_vad","threshold":0.7,"create_response":true,"idle_timeout_ms":10000}}}"#,
        )
        .expect("session update");
        let value = serde_json::from_str::<Value>(&updated).expect("updated JSON");
        let turn_detection = value
            .pointer("/session/turn_detection")
            .and_then(Value::as_object)
            .expect("turn detection");
        assert_eq!(
            turn_detection.get("type").and_then(Value::as_str),
            Some("server_vad")
        );
        assert_eq!(
            turn_detection
                .get("create_response")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(!turn_detection.contains_key("idle_timeout_ms"));
        assert_eq!(
            realtime_enforce_explicit_response_mode(
                r#"{"type":"response.create","event_id":"evt-response"}"#
            )
            .unwrap(),
            r#"{"type":"response.create","event_id":"evt-response"}"#
        );

        let bootstrap = realtime_explicit_response_bootstrap_event();
        let bootstrap = serde_json::from_str::<Value>(&bootstrap).expect("bootstrap JSON");
        assert!(bootstrap
            .pointer("/session/turn_detection")
            .is_some_and(Value::is_null));
    }

    #[test]
    fn realtime_upstream_usage_capture_is_metadata_only() {
        let raw_frame = r#"{
            "type":"response.done",
            "response":{
                "id":"resp_realtime_123",
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
        assert_eq!(
            usage.response_identity_hash,
            realtime_billing_identity_hash("resp_realtime_123")
        );
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
        let empty_usage = realtime_usage_metadata_from_upstream_text_frame(
            r#"{"type":"response.done","response":{"id":"resp_empty","usage":null}}"#,
        )
        .expect("response.done without usage still releases its reservation");
        assert!(!realtime_usage_metadata_has_tokens(&empty_usage));

        let serialized = serde_json::to_string(&usage).unwrap();
        assert!(!serialized.contains("do-not-store-this"));
        assert!(!serialized.contains("secret_probe"));
        assert!(!serialized.contains("resp_realtime_123"));
    }

    #[test]
    fn realtime_response_created_identity_matches_done_identity() {
        let created = realtime_response_created_identity_hash(
            r#"{"type":"response.created","response":{"id":"resp_parallel_2"}}"#,
        )
        .expect("response.created identity");
        let done = realtime_usage_metadata_from_upstream_text_frame(
            r#"{"type":"response.done","response":{"id":"resp_parallel_2","usage":null}}"#,
        )
        .expect("response.done identity");

        assert_eq!(created, done.response_identity_hash);
        assert!(realtime_response_created_identity_hash(
            r#"{"type":"response.created","response":{}}"#
        )
        .is_none());
        assert!(realtime_response_created_identity_hash(
            r#"{"type":"response.done","response":{"id":"resp_parallel_2"}}"#
        )
        .is_none());
        assert!(realtime_usage_metadata_from_upstream_text_frame(
            r#"{"type":"response.done","event_id":"evt_without_response_id","response":{"usage":{"total_tokens":1}}}"#
        )
        .is_none());
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
        assert!(!realtime_upstream_bridge_requires_terminal(false, false));
        assert!(!realtime_upstream_bridge_requires_terminal(true, true));
        assert!(realtime_upstream_bridge_requires_terminal(true, false));
    }

    #[test]
    fn realtime_unavailable_restored_bridge_is_metadata_only_and_fail_closed() {
        let action = realtime_bridge_close_action(RealtimeBridgeCloseCause::UpstreamUnavailable);
        let event = realtime_bridge_terminal_event(
            RealtimeBridgeCloseCause::UpstreamUnavailable,
            action,
            12.0,
            Some(RealtimeBridgeFrameMetadata {
                kind: RealtimeBridgeFrameKind::Text,
                bytes: 42,
                max_bytes: None,
            }),
        );

        assert_eq!(
            action.client_code,
            REALTIME_BRIDGE_INTERNAL_ERROR_CLOSE_CODE
        );
        assert_eq!(
            action.client_reason,
            REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE
        );
        assert!(action.upstream_code.is_none());
        assert_eq!(event.event, "upstream_unavailable");
        assert_eq!(event.direction, "upstream_to_client");
        assert_eq!(event.frame_kind.as_deref(), Some("text"));
        assert_eq!(event.frame_bytes, Some(42));

        let raw = serde_json::to_string(&event).unwrap();
        assert!(!raw.contains("secret client payload"));
        assert!(!raw.contains("openai-insecure-api-key.sk"));
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
            REALTIME_BRIDGE_REASON_UPSTREAM_UNAVAILABLE,
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
    fn realtime_upstream_bridge_hibernation_fail_closed_contract_is_compiled() {
        assert!(realtime_upstream_bridge_hibernation_fail_closed_compiled());
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
    fn realtime_billing_settlement_writer_contract_is_compiled() {
        assert!(realtime_billing_settlement_writer_compiled());
    }

    #[test]
    fn realtime_billing_settlement_replay_marker_contract_is_compiled() {
        assert!(realtime_billing_settlement_replay_marker_compiled());
    }

    #[test]
    fn realtime_billing_settlement_audit_log_contract_is_compiled() {
        assert!(realtime_billing_settlement_audit_log_compiled());
    }

    #[test]
    fn realtime_billing_settlement_batch_contract_is_compiled() {
        assert!(realtime_billing_settlement_batch_compiled());
    }

    #[test]
    fn realtime_billing_settlement_retry_contract_is_compiled() {
        assert!(realtime_billing_settlement_retry_compiled());
        assert_eq!(realtime_billing_settlement_retry_delay_ms(0), 1_000);
        assert_eq!(realtime_billing_settlement_retry_delay_ms(1), 1_000);
        assert_eq!(realtime_billing_settlement_retry_delay_ms(2), 2_000);
        assert_eq!(realtime_billing_settlement_retry_delay_ms(6), 30_000);
        assert_eq!(realtime_billing_settlement_retry_delay_ms(20), 30_000);

        let status = RealtimeBillingSettlementRetryStatus {
            record_count: 2,
            pending: true,
            paused: false,
            exhausted: false,
            attempts: 2,
            max_attempts: BILLING_SETTLEMENT_RETRY_MAX_ATTEMPTS,
            next_retry_at_ms: Some(3_000.0),
            last_error: Some("d1 temporarily unavailable".to_string()),
        };
        let raw = serde_json::to_string(&status).unwrap();
        assert!(raw.contains("\"attempts\":2"));
        assert!(!raw.contains("user_id"));
        assert!(!raw.contains("token_id"));
        assert!(!raw.contains("channel_id"));
        assert!(!raw.contains("selected_group"));
        assert!(!raw.contains("upstream_api_key"));
    }

    #[test]
    fn realtime_billing_reservation_lease_contract_is_compiled_and_redacted() {
        assert!(realtime_billing_reservation_lease_compiled());
        assert_eq!(
            normalize_realtime_billing_reservation_lease_seconds(None),
            BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
        );
        assert_eq!(
            normalize_realtime_billing_reservation_lease_seconds(Some("29".to_string())),
            BILLING_RESERVATION_LEASE_DEFAULT_SECONDS
        );
        assert_eq!(
            normalize_realtime_billing_reservation_lease_seconds(Some(" 120 ".to_string())),
            120
        );

        let mut queue = RealtimeBillingReservationLeaseQueue::default();
        queue
            .upsert("private-reservation-2", 2, 2, 2_000.0)
            .unwrap();
        queue
            .upsert("private-reservation-1", 1, 1, 1_000.0)
            .unwrap();
        queue
            .upsert("private-reservation-1", 1, 5, 5_000.0)
            .unwrap();
        queue
            .upsert("private-reservation-1", 3, 500, 500.0)
            .unwrap();
        assert_eq!(queue.records.len(), 2);
        let original = queue
            .records
            .iter()
            .find(|record| record.reservation_key == "private-reservation-1")
            .unwrap();
        assert_eq!(original.reservation_sequence, 3);
        assert_eq!(original.lease_expires_at, 500);
        assert_eq!(queue.next_due_index(1_500.0), Some(1));
        assert_eq!(queue.next_expiry_at_ms(), Some(500.0));

        let status = queue.status(1_500.0).expect("lease status");
        assert_eq!(status.record_count, 2);
        assert_eq!(status.due_count, 1);
        assert_eq!(status.next_expiry_at_ms, Some(500.0));
        let raw = serde_json::to_string(&status).unwrap();
        assert!(!raw.contains("private-reservation"));
        assert!(!raw.contains("reservation_key"));
        assert_eq!(
            realtime_billing_retry_failure_ownership(false, false),
            RealtimeBillingRetryFailureOwnership::SettlementRetry
        );
        assert_eq!(
            realtime_billing_retry_failure_ownership(true, false),
            RealtimeBillingRetryFailureOwnership::Refunded
        );
        assert_eq!(
            realtime_billing_retry_failure_ownership(false, true),
            RealtimeBillingRetryFailureOwnership::ReservationLease
        );

        let mut capacity_queue = RealtimeBillingReservationLeaseQueue::default();
        for index in 0..BILLING_RESERVATION_LEASE_MAX_RECORDS {
            capacity_queue
                .upsert(
                    &format!("reservation-{index}"),
                    index as i64 + 1,
                    10_000 + index as i64,
                    10_000.0 + index as f64,
                )
                .unwrap();
        }
        assert_eq!(
            capacity_queue.records.len(),
            BILLING_RESERVATION_LEASE_MAX_RECORDS
        );
        assert!(capacity_queue
            .upsert("reservation-over-capacity", 129, 20_000, 20_000.0)
            .unwrap_err()
            .contains("reached 128 records"));
    }

    #[test]
    fn realtime_billing_retry_queue_keeps_multiple_due_records() {
        let snapshot = estimate_tiered_billing_snapshot_with_request(
            "gpt-4o-realtime-preview",
            r#"tier("default", p * 2 + c * 10)"#,
            TokenParams {
                p: 100.0,
                c: 50.0,
                len: 100.0,
                ..TokenParams::default()
            },
            1.0,
            RequestInput::default(),
        )
        .expect("snapshot");
        let handoff =
            RealtimeBillingSettlementHandoff::new(snapshot.clone(), RequestInput::default())
                .with_mutation_plan(RealtimeBillingSettlementMutationPlan::new(
                    101,
                    202,
                    303,
                    "default",
                    snapshot.estimated_quota_after_group.0,
                ))
                .with_audit_plan(RealtimeBillingSettlementAuditPlan::new(
                    "user", "token", None, None, 1, "realtime",
                ));
        let attachment = SocketAttachment {
            session: "retry-queue-session".to_string(),
            connected_at_ms: 1.0,
            protocol: None,
            entrypoint: "openai_realtime_v1".to_string(),
            model: Some("gpt-4o-realtime-preview".to_string()),
            token_source: Some("authorization".to_string()),
            token_fingerprint: Some("fp".to_string()),
            auth_state: "gateway_checked".to_string(),
            upstream: None,
            upstream_connect_handoff: true,
        };
        let preview = RealtimeBillingSettlementPreviewMetadata {
            model_name: "gpt-4o-realtime-preview".to_string(),
            pre_consumed_quota: snapshot.estimated_quota_after_group.0,
            final_quota: snapshot.estimated_quota_after_group.0,
            ..RealtimeBillingSettlementPreviewMetadata::default()
        };
        let mut first = RealtimeBillingSettlementRetryRecord::new(
            &attachment,
            &preview,
            &handoff,
            "reservation-1",
            1,
            1_000,
            "response-1",
            "replay-1",
            100.0,
            "temporary failure",
        )
        .expect("retry record");
        first.next_retry_at_ms = Some(2_000.0);
        let mut second = first.clone();
        second.reservation_key = "reservation-2".to_string();
        second.reservation_sequence = 2;
        second.upstream_response_id_hash = "response-2".to_string();
        second.replay_key = "replay-2".to_string();
        second.next_retry_at_ms = Some(1_000.0);
        let mut exhausted_refund = first.clone();
        exhausted_refund.reservation_key = "reservation-3".to_string();
        exhausted_refund.reservation_sequence = 3;
        exhausted_refund.upstream_response_id_hash = "response-3".to_string();
        exhausted_refund.replay_key = "replay-3".to_string();
        exhausted_refund.exhausted = true;
        exhausted_refund.next_retry_at_ms = Some(500.0);
        let mut gate_paused = first.clone();
        gate_paused.reservation_key = "reservation-4".to_string();
        gate_paused.reservation_sequence = 4;
        gate_paused.upstream_response_id_hash = "response-4".to_string();
        gate_paused.replay_key = "replay-4".to_string();
        gate_paused.paused = true;
        gate_paused.next_retry_at_ms = Some(750.0);
        let queue = RealtimeBillingSettlementRetryQueue {
            records: vec![first, second, exhausted_refund, gate_paused],
        };

        let status = queue.status().expect("queue status");
        assert_eq!(status.record_count, 4);
        assert_eq!(status.next_retry_at_ms, Some(500.0));
        assert_eq!(queue.next_due_index(1_500.0), Some(1));
        assert_eq!(queue.next_due_index(500.0), None);
        assert_eq!(queue.next_due_refund_index(500.0), Some(2));
        assert_eq!(queue.next_due_refund_index(499.0), None);
        assert!(realtime_billing_reservation_owned_by_retry(
            &queue,
            "reservation-1",
            1,
            1_000
        ));
        assert!(realtime_billing_reservation_owned_by_retry(
            &queue,
            "reservation-2",
            2,
            1_000
        ));
        assert!(!realtime_billing_reservation_owned_by_retry(
            &queue,
            "reservation-2",
            1,
            1_000
        ));
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

        let preview =
            realtime_billing_settlement_preview(&snapshot, &usage, request, None).unwrap();
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
