import {
  MAX_PREVIOUS_RING_ADMISSION_WINDOW_SECONDS,
  MAX_STORAGE_OBJECT_VERSION_BYTES,
  ProtocolError,
  validateTerminalAckRequest,
  validateTerminalAckV3Request,
  validateOperationStatusQuery,
  type ConfiguredRingTransition,
  type OperationEnvelope,
  type OperationRingAdmission,
  type OperationShard,
  type OperationStatusQuery,
  type TerminalAckRequest,
  type TerminalAckRequestV3,
} from "./protocol";
import {
  RELAY_SHARD_ALARM_INTENT_KIND,
  RELAY_SHARD_ALARM_INTENT_VERSION,
  RELAY_SHARD_ALARM_MAX_DELIVERIES,
  buildRelayShardAlarmIntentV1,
  operationShardsEqual,
  relayShardAlarmRetryAt,
  type RelayShardAlarmIntentV1,
} from "./relay_shard_durable_state";

export const DISPATCH_REPLAY_RETENTION_SECONDS = 600;
export const READINESS_PROBE_JOURNAL_RETENTION_MS = 2 * 60 * 60 * 1_000;
export const READINESS_PROBE_RESULT_JSON_MAX_BYTES = 16_384;

export type OperationStatus =
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "recovery_required";

export interface OperationRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  operation_kind: string;
  trace_id: string;
  envelope_sha256: string;
  status: OperationStatus;
  response_status: number | null;
  response_code: string | null;
  result_object_key: string | null;
  result_object_version: string | null;
  result_sha256: string | null;
  result_size: number | null;
  result_content_type: string | null;
  provider_usage_receipt_sha256: string | null;
}

export interface StorageAccessGrant {
  protocol_version: number;
  operation_id: string;
  owner_generation: number;
  owner_lease_expires_at: number;
  operation_kind: string;
  provider_operation_id: string;
  admission_sha256: string;
  deadline_at: number;
  input: {
    mode: "inline" | "r2";
    sha256: string;
    size: number;
    content_type: string;
    request_object_key: string | null;
    object_version: string | null;
  };
  shard: OperationShard;
  trace_id: string;
  result: StorageResultRecord | null;
  provider_usage_receipt_sha256: string | null;
  provider_attempt: {
    attempt_generation: number;
    provider_operation_id: string;
    admission_sha256: string;
    request_sha256: string;
    egress_profile: string | null;
    egress_worker_version_id: string | null;
    status: ProviderAttemptStatus;
    response_status: number | null;
    provider_usage_receipt_sha256: string | null;
    provider_usage_receipt_attached_at: number | null;
  } | null;
}

export interface StorageResultRecord {
  object_key: string;
  object_version: string;
  sha256: string;
  size: number;
  content_type: string;
}

export type RecordStorageResultOutcome = "recorded" | "duplicate";

export type ProviderAttemptStatus =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "definite_reject"
  | "ambiguous"
  | "cancelled";

export interface ProviderEgressIdentity {
  profile: string;
  worker_version_id: string;
}

export interface ProviderAttemptRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  attempt_generation: number;
  provider_operation_id: string;
  admission_sha256: string;
  request_sha256: string;
  egress_profile: string | null;
  egress_worker_version_id: string | null;
  status: ProviderAttemptStatus;
  response_status: number | null;
  response_code: string | null;
  result_object_key: string | null;
  result_object_version: string | null;
  result_sha256: string | null;
  result_size: number | null;
  result_content_type: string | null;
  provider_usage_receipt_sha256: string | null;
  provider_usage_receipt_attached_at: number | null;
  prepared_at: number;
  dispatched_at: number | null;
  terminal_at: number | null;
  updated_at: number;
}

export type PrepareProviderAttemptOutcome =
  | { kind: "prepared"; row: ProviderAttemptRow }
  | { kind: "existing"; row: ProviderAttemptRow };

export type DispatchProviderAttemptOutcome =
  | { kind: "dispatched"; row: ProviderAttemptRow }
  | { kind: "existing"; row: ProviderAttemptRow };

export type RecordProviderAttemptOutcome =
  | { kind: "recorded"; row: ProviderAttemptRow }
  | { kind: "duplicate"; row: ProviderAttemptRow };

export interface ProviderAttemptTerminal {
  status: "succeeded" | "definite_reject" | "ambiguous";
  response_status: number;
  response_code: string | null;
}

export type ProviderResponseClass =
  | "success"
  | "typed_error"
  | "http_error"
  | "invalid_body";

export interface ProviderResponseEvidenceManifest {
  object_key: string;
  object_version: string;
  provider_response_evidence_sha256: string;
  sha256: string;
  size: number;
  content_type: string;
}

export interface ClientResponseArtifactManifest {
  object_key: string;
  object_version: string;
  client_response_artifact_sha256: string;
  sha256: string;
  size: number;
  content_type: "application/json";
}

export type ProviderResponseArtifactAttachment =
  | {
      status: "succeeded";
      provider_status: 200;
      client_status: 200;
      response_class: "success";
      response_code: null;
      raw_manifest: ProviderResponseEvidenceManifest;
      client_manifest: ClientResponseArtifactManifest;
      provider_usage_receipt_sha256: string | null;
    }
  | {
      status: "interpreted_reject";
      provider_status: number;
      client_status: number;
      response_class: Exclude<ProviderResponseClass, "success">;
      response_code: string;
      raw_manifest: ProviderResponseEvidenceManifest;
      client_manifest: ClientResponseArtifactManifest;
      provider_usage_receipt_sha256: null;
    }
  | {
      status: "ambiguous";
      provider_status: null;
      client_status: null;
      response_class: null;
      response_code: string;
      raw_manifest: null;
      client_manifest: null;
      provider_usage_receipt_sha256: null;
    };

export type ProviderResponseArtifactAttachmentRow =
  ProviderResponseArtifactAttachment & {
    operation_id: string;
    owner_generation: number;
    attempt_generation: number;
    provider_operation_id: string;
    admission_sha256: string;
    request_sha256: string;
    egress_profile: string;
    egress_worker_version_id: string;
    attached_at: number;
  };

export type AttachProviderResponseArtifactsOutcome =
  | { kind: "attached"; row: ProviderResponseArtifactAttachmentRow }
  | { kind: "duplicate"; row: ProviderResponseArtifactAttachmentRow };

export interface ProviderRetryPolicy {
  maxAttempts: number;
  retryEnabled: boolean;
}

interface ProviderRetryStateRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  policy_version: number;
  max_attempts: number;
  retry_enabled: number;
  state: "active" | "waiting" | "terminal";
  active_attempt_generation: number | null;
  last_attempt_generation: number;
  schedule_generation: number;
  next_attempt_at: number | null;
  retry_deadline_at: number;
  global_terminal_event_id: string | null;
  global_terminal_acked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TerminalAckStateRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  terminal_ack_contract_version: number;
  financial_terminal_contract_version: number | null;
  billing_event_id: string;
  terminal_contract_sha256: string;
  reconciliation_id: string;
  reconciliation_revision: number;
  predecessor_billing_event_id: string | null;
  ack_payload_json: string;
  recovery_payload_json: string | null;
  provider_response_binding_json: string | null;
  client_response_artifact_sha256: string | null;
  final_acked_at: number | null;
  compaction_authorized_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TerminalAckLedgerOutcome {
  kind: "acknowledged" | "duplicate";
  finalAck: boolean;
  acknowledgedAt: number | null;
}

export interface OperationStatusSnapshot {
  operation: OperationRow;
  provider_attempt: ProviderAttemptRow | null;
}

export interface OperationStatusV4Snapshot extends OperationStatusSnapshot {
  provider_response_artifacts: ProviderResponseArtifactAttachmentRow | null;
}

export type ClaimResult =
  | { kind: "new" }
  | { kind: "existing"; row: OperationRow }
  | { kind: "capacity" };

export interface RelayShardLedgerPolicy {
  maxInFlight: number;
  dispatchRetentionSeconds: number;
  terminalRetentionSeconds: number;
  maxTerminalOperations: number;
  globalTerminalCompactionEnabled: boolean;
}

export type OperationRecoveryIntentState =
  | "pending"
  | "completed"
  | "quarantined";

export interface OperationRecoveryIntent {
  [key: string]: SqlStorageValue;
  payload_version: number;
  intent_kind: string;
  operation_id: string;
  owner_generation: number;
  deadline_at: number;
  delivery_generation: number;
  delivery_count: number;
  state: OperationRecoveryIntentState;
  armed_at: number | null;
  next_delivery_at: number;
  last_error_code: string | null;
  shard_contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
  created_at: number;
  updated_at: number;
}

export type OperationRecoveryIntentOutcome =
  | "completed"
  | "duplicate"
  | "not_due"
  | "stale"
  | "quarantined";

interface DispatchRow {
  [key: string]: SqlStorageValue;
  dispatch_id: string;
  operation_id: string;
  envelope_sha256: string;
}

interface ShardStateRow {
  [key: string]: SqlStorageValue;
  instance_name: string;
  contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  lifecycle_state: string;
  lifecycle_detail: string | null;
  updated_at: number;
}

export interface ShardReadinessSnapshot {
  initialized: boolean;
  lifecycle_state: string | null;
  lifecycle_detail: string | null;
  lifecycle_updated_at: number | null;
  active_in_flight_operations: number;
  expired_in_flight_operations: number;
  terminal_operations: number;
  readiness: PersistedReadinessSnapshot;
}

export interface PersistedReadinessSnapshot {
  generation: number;
  phase: "idle" | "probing" | "complete";
  last_probe_id: string | null;
  started_at_ms: number | null;
  deadline_at_ms: number | null;
  completed_at_ms: number | null;
  result_code: string | null;
  container_status: string | null;
  container_last_change_ms: number | null;
  container_exit_code: number | null;
  runtime_protocol_version: number | null;
  runtime_contract_version: number | null;
  runtime_execution_enabled: boolean | null;
  last_ready_at_ms: number | null;
}

export interface ReadinessCompletion {
  resultCode: string;
  containerStatus: string | null;
  containerLastChangeMs: number | null;
  containerExitCode: number | null;
  runtimeProtocolVersion: number | null;
  runtimeContractVersion: number | null;
  runtimeBuildId: string | null;
  runtimeExecutionEnabled: boolean | null;
  processReady: boolean;
  executionReady: boolean;
}

export interface ReadinessProbeReplay {
  completedAtMs: number;
  resultCode: string;
  containerStatus:
    | "running"
    | "healthy"
    | "stopping"
    | "stopped"
    | "stopped_with_code"
    | null;
  containerLastChangeMs: number | null;
  containerExitCode: number | null;
  runtimeProtocolVersion: number | null;
  runtimeContractVersion: number | null;
  runtimeBuildId: string | null;
  runtimeExecutionEnabled: boolean | null;
  processReady: boolean;
  executionReady: boolean;
}

export interface ReadinessProbeWakePermit {
  kind: "wake";
  probeId: string;
  claimDigestSha256: string;
  generation: number;
  startedAtMs: number;
  deadlineAtMs: number;
  retentionUntilMs: number;
}

export interface ReadinessProbeCompletedReplay {
  kind: "completed";
  probeId: string;
  claimDigestSha256: string;
  generation: number;
  startedAtMs: number;
  deadlineAtMs: number;
  retentionUntilMs: number;
  completedAtMs: number;
  resultJson: string;
  resultSha256: string;
}

export type BeginOrReplayReadinessProbeOutcome =
  | ReadinessProbeWakePermit
  | ReadinessProbeCompletedReplay;

export interface ReadinessProbeJournalCompletion extends ReadinessCompletion {
  resultJson: string;
  resultSha256: string;
}

interface ReadinessRow {
  [key: string]: SqlStorageValue;
  probe_generation: number;
  phase: "probing" | "complete";
  last_probe_id: string;
  started_at_ms: number;
  deadline_at_ms: number;
  completed_at_ms: number | null;
  result_code: string | null;
  container_status: string | null;
  container_last_change_ms: number | null;
  container_exit_code: number | null;
  runtime_protocol_version: number | null;
  runtime_contract_version: number | null;
  runtime_build_id: string | null;
  runtime_execution_enabled: number | null;
  process_ready: number | null;
  execution_ready: number | null;
  last_ready_at_ms: number | null;
}

interface ReadinessProbeJournalRow {
  [key: string]: SqlStorageValue;
  probe_id: string;
  claim_digest_sha256: string;
  generation: number;
  state: "started" | "completed" | "ambiguous";
  started_at_ms: number;
  deadline_at_ms: number;
  retention_until_ms: number;
  completed_at_ms: number | null;
  ambiguous_at_ms: number | null;
  result_json: string | null;
  result_sha256: string | null;
  result_size_bytes: number | null;
}

type ReadinessProbeJournalTransactionOutcome =
  | ReadinessProbeWakePermit
  | { kind: "completed_row"; row: ReadinessProbeJournalRow }
  | { kind: "ambiguous" };

interface StorageOperationRow {
  [key: string]: SqlStorageValue;
  protocol_version: number;
  operation_id: string;
  owner_generation: number;
  owner_lease_expires_at: number;
  operation_kind: string;
  provider_operation_id: string;
  admission_sha256: string;
  status: OperationStatus;
  response_status: number | null;
  response_code: string | null;
  deadline_at: number;
  input_mode: string;
  input_sha256: string;
  input_size: number;
  input_content_type: string;
  request_object_key: string | null;
  object_version: string | null;
  shard_contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
  trace_id: string;
  result_object_key: string | null;
  result_object_version: string | null;
  result_sha256: string | null;
  result_size: number | null;
  result_content_type: string | null;
  provider_usage_receipt_sha256: string | null;
}

interface ProviderResponseArtifactAttachmentSqlRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  attempt_generation: number;
  provider_operation_id: string;
  admission_sha256: string;
  request_sha256: string;
  egress_profile: string;
  egress_worker_version_id: string;
  status: "succeeded" | "interpreted_reject" | "ambiguous";
  provider_status: number | null;
  client_status: number | null;
  response_class: ProviderResponseClass | null;
  response_code: string | null;
  provider_response_evidence_sha256: string | null;
  raw_object_key: string | null;
  raw_object_version: string | null;
  raw_sha256: string | null;
  raw_size: number | null;
  raw_content_type: string | null;
  client_response_artifact_sha256: string | null;
  client_object_key: string | null;
  client_object_version: string | null;
  client_sha256: string | null;
  client_size: number | null;
  client_content_type: string | null;
  provider_usage_receipt_sha256: string | null;
  attached_at: number;
}

const TERMINAL_STATUS_SQL = "'completed', 'failed', 'recovery_required'";
const MAX_UNIX_TIMESTAMP_SECONDS = 253_402_300_799;
const MAX_UNIX_TIMESTAMP_MILLISECONDS = MAX_UNIX_TIMESTAMP_SECONDS * 1_000;

export class RelayShardLedger {
  private schemaReady = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  ensureSchema(): void {
    if (this.schemaReady) return;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cinatoken_shard_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_name TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        ring_generation INTEGER NOT NULL,
        shard_count INTEGER NOT NULL,
        shard_index INTEGER NOT NULL,
        lifecycle_state TEXT NOT NULL,
        lifecycle_detail TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cinatoken_shard_operations (
        protocol_version INTEGER NOT NULL DEFAULT 0,
        operation_id TEXT PRIMARY KEY,
        owner_generation INTEGER NOT NULL,
        owner_lease_expires_at INTEGER NOT NULL DEFAULT 0,
        operation_kind TEXT NOT NULL DEFAULT '',
        provider_operation_id TEXT NOT NULL,
        admission_sha256 TEXT NOT NULL DEFAULT '',
        trace_id TEXT NOT NULL DEFAULT '',
        envelope_sha256 TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status INTEGER,
        response_code TEXT,
        deadline_at INTEGER NOT NULL,
        input_mode TEXT NOT NULL DEFAULT '',
        input_sha256 TEXT NOT NULL DEFAULT '',
        input_size INTEGER NOT NULL DEFAULT -1,
        input_content_type TEXT NOT NULL DEFAULT '',
        request_object_key TEXT,
        object_version TEXT,
        shard_contract_version INTEGER NOT NULL DEFAULT 0,
        ring_generation INTEGER NOT NULL DEFAULT 0,
        shard_count INTEGER NOT NULL DEFAULT 0,
        shard_index INTEGER NOT NULL DEFAULT -1,
        instance_name TEXT NOT NULL DEFAULT '',
        result_object_key TEXT,
        result_object_version TEXT,
        result_sha256 TEXT,
        result_size INTEGER,
        result_content_type TEXT,
        provider_usage_receipt_sha256 TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_operations_status_deadline
        ON cinatoken_shard_operations(status, deadline_at);
      CREATE INDEX IF NOT EXISTS cinatoken_shard_operations_terminal_updated
        ON cinatoken_shard_operations(status, updated_at, operation_id);
      CREATE TABLE IF NOT EXISTS cinatoken_shard_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_dispatches_created
        ON cinatoken_shard_dispatches(created_at);
      CREATE TABLE IF NOT EXISTS cinatoken_shard_provider_attempts (
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        attempt_generation INTEGER NOT NULL,
        provider_operation_id TEXT NOT NULL,
        admission_sha256 TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        egress_profile TEXT,
        egress_worker_version_id TEXT,
        status TEXT NOT NULL,
        response_status INTEGER,
        response_code TEXT,
        result_object_key TEXT,
        result_object_version TEXT,
        result_sha256 TEXT,
        result_size INTEGER,
        result_content_type TEXT,
        provider_usage_receipt_sha256 TEXT,
        provider_usage_receipt_attached_at INTEGER,
        prepared_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        terminal_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, owner_generation, attempt_generation),
        CHECK (length(operation_id) BETWEEN 1 AND 128),
        CHECK (owner_generation > 0),
        CHECK (attempt_generation BETWEEN 1 AND 3),
        CHECK (length(provider_operation_id) BETWEEN 1 AND 128),
        CHECK (length(admission_sha256) = 64),
        CHECK (length(request_sha256) = 64),
        CHECK (
          (egress_profile IS NULL AND egress_worker_version_id IS NULL) OR
          (egress_profile IS NOT NULL AND length(egress_profile) BETWEEN 1 AND 64
            AND egress_worker_version_id IS NOT NULL
            AND length(egress_worker_version_id) BETWEEN 1 AND 128)
        ),
        CHECK (
          provider_usage_receipt_sha256 IS NULL OR
          (length(provider_usage_receipt_sha256) = 64
            AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        CHECK (status IN ('prepared', 'dispatched', 'succeeded', 'definite_reject', 'ambiguous', 'cancelled')),
        CHECK (prepared_at > 0 AND updated_at >= prepared_at),
        CHECK (
          (status = 'prepared'
            AND dispatched_at IS NULL AND terminal_at IS NULL
            AND response_status IS NULL AND response_code IS NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND provider_usage_receipt_sha256 IS NULL
            AND provider_usage_receipt_attached_at IS NULL
            AND updated_at = prepared_at)
          OR
          (status = 'dispatched'
            AND dispatched_at IS NOT NULL AND dispatched_at >= prepared_at
            AND terminal_at IS NULL AND response_status IS NULL AND response_code IS NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND ((provider_usage_receipt_sha256 IS NULL
                  AND provider_usage_receipt_attached_at IS NULL)
              OR (provider_usage_receipt_sha256 IS NOT NULL
                  AND provider_usage_receipt_attached_at IS NOT NULL
                  AND provider_usage_receipt_attached_at >= dispatched_at))
            AND updated_at = dispatched_at)
          OR
          (status = 'succeeded'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status BETWEEN 200 AND 299 AND response_code IS NULL
            AND result_object_key IS NOT NULL AND result_object_version IS NOT NULL
            AND result_sha256 IS NOT NULL AND result_size IS NOT NULL
            AND result_content_type IS NOT NULL
            AND provider_usage_receipt_sha256 IS NOT NULL
            AND provider_usage_receipt_attached_at BETWEEN dispatched_at AND terminal_at)
          OR
          (status = 'definite_reject'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status BETWEEN 400 AND 599 AND response_code IS NOT NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND provider_usage_receipt_sha256 IS NULL
            AND provider_usage_receipt_attached_at IS NULL)
          OR
          (status = 'ambiguous'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status = 202 AND response_code IS NOT NULL
            AND ((result_object_key IS NULL
                  AND provider_usage_receipt_sha256 IS NULL
                  AND provider_usage_receipt_attached_at IS NULL)
              OR (result_object_key IS NOT NULL
                  AND provider_usage_receipt_sha256 IS NOT NULL
                  AND provider_usage_receipt_attached_at BETWEEN dispatched_at AND terminal_at)))
          OR
          (status = 'cancelled'
            AND dispatched_at IS NULL AND terminal_at IS NOT NULL
            AND terminal_at >= prepared_at AND updated_at = terminal_at
            AND response_status BETWEEN 400 AND 599 AND response_code IS NOT NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND provider_usage_receipt_sha256 IS NULL
            AND provider_usage_receipt_attached_at IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cinatoken_shard_provider_attempts_active
        ON cinatoken_shard_provider_attempts(operation_id, owner_generation)
        WHERE status IN ('prepared', 'dispatched');
      CREATE INDEX IF NOT EXISTS cinatoken_shard_provider_attempts_latest
        ON cinatoken_shard_provider_attempts(
          operation_id,
          owner_generation,
          attempt_generation DESC
        );
      CREATE TABLE IF NOT EXISTS cinatoken_shard_provider_retry_state (
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        policy_version INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        retry_enabled INTEGER NOT NULL,
        state TEXT NOT NULL,
        active_attempt_generation INTEGER,
        last_attempt_generation INTEGER NOT NULL,
        schedule_generation INTEGER NOT NULL,
        next_attempt_at INTEGER,
        retry_deadline_at INTEGER NOT NULL,
        global_terminal_event_id TEXT,
        global_terminal_acked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, owner_generation),
        CHECK (policy_version = 1),
        CHECK (max_attempts BETWEEN 1 AND 3),
        CHECK (retry_enabled IN (0, 1)),
        CHECK (retry_enabled = 1 OR max_attempts = 1),
        CHECK (state IN ('active', 'waiting', 'terminal')),
        CHECK (last_attempt_generation BETWEEN 1 AND max_attempts),
        CHECK (schedule_generation >= 0),
        CHECK (retry_deadline_at > created_at),
        CHECK (updated_at >= created_at),
        CHECK (
          (state = 'active'
            AND active_attempt_generation = last_attempt_generation
            AND next_attempt_at IS NULL)
          OR
          (state = 'waiting'
            AND active_attempt_generation IS NULL
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at < retry_deadline_at)
          OR
          (state = 'terminal'
            AND active_attempt_generation IS NULL
            AND next_attempt_at IS NULL)
        ),
        CHECK (
          global_terminal_acked_at IS NULL OR global_terminal_event_id IS NOT NULL
        )
      );
      CREATE TABLE IF NOT EXISTS cinatoken_shard_terminal_acks (
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        terminal_ack_contract_version INTEGER NOT NULL DEFAULT 1,
        financial_terminal_contract_version INTEGER,
        billing_event_id TEXT NOT NULL,
        terminal_contract_sha256 TEXT NOT NULL,
        reconciliation_id TEXT NOT NULL,
        reconciliation_revision INTEGER NOT NULL,
        predecessor_billing_event_id TEXT,
        ack_payload_json TEXT NOT NULL,
        recovery_payload_json TEXT,
        provider_response_binding_json TEXT,
        client_response_artifact_sha256 TEXT,
        final_acked_at INTEGER,
        compaction_authorized_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, owner_generation),
        CHECK (length(operation_id) BETWEEN 1 AND 128),
        CHECK (owner_generation > 0),
        CHECK (length(billing_event_id) = 64),
        CHECK (length(terminal_contract_sha256) = 64),
        CHECK (length(reconciliation_id) = 64),
        CHECK (reconciliation_revision IN (1, 2)),
        CHECK (created_at > 0 AND updated_at >= created_at),
        CHECK (
          (reconciliation_revision = 1
            AND predecessor_billing_event_id IS NULL
            AND (
              (recovery_payload_json IS NULL AND final_acked_at IS NOT NULL) OR
              (recovery_payload_json = ack_payload_json AND final_acked_at IS NULL)
            ))
          OR
          (reconciliation_revision = 2
            AND predecessor_billing_event_id IS NOT NULL
            AND (
              recovery_payload_json IS NOT NULL OR
              (terminal_ack_contract_version = 3
                AND recovery_payload_json IS NULL)
            )
            AND final_acked_at IS NOT NULL)
        ),
        CHECK (compaction_authorized_at IS NULL OR final_acked_at IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_terminal_acks_compaction
        ON cinatoken_shard_terminal_acks(final_acked_at, compaction_authorized_at);
      CREATE TABLE IF NOT EXISTS cinatoken_shard_provider_attempt_events (
        event_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        attempt_generation INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        response_status INTEGER,
        response_code TEXT,
        egress_profile TEXT,
        egress_worker_version_id TEXT,
        provider_usage_receipt_sha256 TEXT,
        provider_usage_receipt_attached_at INTEGER,
        observed_at INTEGER NOT NULL,
        UNIQUE (operation_id, owner_generation, attempt_generation, event_sequence),
        CHECK (event_sequence BETWEEN 1 AND 3),
        CHECK (to_status IN ('prepared', 'dispatched', 'succeeded', 'definite_reject', 'ambiguous', 'cancelled')),
        CHECK (
          provider_usage_receipt_sha256 IS NULL OR
          (length(provider_usage_receipt_sha256) = 64
            AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        CHECK (
          (provider_usage_receipt_sha256 IS NULL
            AND provider_usage_receipt_attached_at IS NULL)
          OR
          (provider_usage_receipt_sha256 IS NOT NULL
            AND provider_usage_receipt_attached_at IS NOT NULL
            AND provider_usage_receipt_attached_at > 0
            AND provider_usage_receipt_attached_at <= observed_at)
        ),
        CHECK (observed_at > 0)
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_provider_attempt_events_operation
        ON cinatoken_shard_provider_attempt_events(
          operation_id,
          owner_generation,
          attempt_generation,
          event_sequence
        );
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_event_update_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempt_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt event is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_event_delete_guard
      BEFORE DELETE ON cinatoken_shard_provider_attempt_events
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt event is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_retry_policy_guard
      BEFORE UPDATE ON cinatoken_shard_provider_retry_state
      FOR EACH ROW
      WHEN
        NEW.operation_id IS NOT OLD.operation_id OR
        NEW.owner_generation IS NOT OLD.owner_generation OR
        NEW.policy_version IS NOT OLD.policy_version OR
        NEW.max_attempts IS NOT OLD.max_attempts OR
        NEW.retry_enabled IS NOT OLD.retry_enabled OR
        NEW.retry_deadline_at IS NOT OLD.retry_deadline_at OR
        NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'provider retry policy is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_insert_guard
      BEFORE INSERT ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
            FROM cinatoken_shard_operations AS operation
           WHERE operation.operation_id = NEW.operation_id
             AND operation.owner_generation = NEW.owner_generation
             AND operation.provider_operation_id = NEW.provider_operation_id
             AND operation.admission_sha256 = NEW.admission_sha256
             AND operation.input_sha256 = NEW.request_sha256
             AND operation.operation_kind != 'health_probe'
             AND operation.status = 'running'
             AND operation.deadline_at > NEW.prepared_at
             AND operation.owner_lease_expires_at > NEW.prepared_at
        ) THEN RAISE(ABORT, 'provider attempt operation authority mismatch') END;
        SELECT CASE WHEN NEW.attempt_generation != COALESCE((
          SELECT MAX(existing.attempt_generation) + 1
            FROM cinatoken_shard_provider_attempts AS existing
           WHERE existing.operation_id = NEW.operation_id
             AND existing.owner_generation = NEW.owner_generation
        ), 1) THEN RAISE(ABORT, 'provider attempt generation mismatch') END;
        SELECT CASE WHEN NEW.attempt_generation > 1 AND NOT EXISTS (
          SELECT 1
            FROM cinatoken_shard_provider_attempts AS previous
           WHERE previous.operation_id = NEW.operation_id
             AND previous.owner_generation = NEW.owner_generation
             AND previous.attempt_generation = NEW.attempt_generation - 1
             AND previous.status = 'definite_reject'
        ) THEN RAISE(ABORT, 'provider attempt retry authority mismatch') END;
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_identity_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN
        NEW.operation_id IS NOT OLD.operation_id OR
        NEW.owner_generation IS NOT OLD.owner_generation OR
        NEW.attempt_generation IS NOT OLD.attempt_generation OR
        NEW.provider_operation_id IS NOT OLD.provider_operation_id OR
        NEW.admission_sha256 IS NOT OLD.admission_sha256 OR
        NEW.request_sha256 IS NOT OLD.request_sha256 OR
        NEW.prepared_at IS NOT OLD.prepared_at
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_lifecycle_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN NOT (
        (OLD.status = 'prepared' AND NEW.status IN ('dispatched', 'cancelled')) OR
        (OLD.status = 'dispatched'
          AND NEW.status IN ('succeeded', 'definite_reject', 'ambiguous'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt lifecycle transition is invalid');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_event_append
      AFTER UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      BEGIN
        INSERT INTO cinatoken_shard_provider_attempt_events
          (event_id, operation_id, owner_generation, attempt_generation, event_sequence,
           from_status, to_status, response_status, response_code,
           provider_usage_receipt_sha256, provider_usage_receipt_attached_at, observed_at)
        VALUES (
          'provider-attempt-v1:' || NEW.operation_id || ':' || NEW.owner_generation || ':' ||
            NEW.attempt_generation || ':' ||
            CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          NEW.operation_id,
          NEW.owner_generation,
          NEW.attempt_generation,
          CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          OLD.status,
          NEW.status,
          NEW.response_status,
          NEW.response_code,
          NEW.provider_usage_receipt_sha256,
          NEW.provider_usage_receipt_attached_at,
          NEW.updated_at
        );
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_attempt_delete_guard
      BEFORE DELETE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1 FROM cinatoken_shard_operations AS operation
         WHERE operation.operation_id = OLD.operation_id
           AND operation.owner_generation = OLD.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt cannot be deleted before its operation');
      END;
      CREATE TABLE IF NOT EXISTS cinatoken_shard_provider_response_attachments (
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        attempt_generation INTEGER NOT NULL,
        provider_operation_id TEXT NOT NULL,
        admission_sha256 TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        egress_profile TEXT NOT NULL,
        egress_worker_version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_status INTEGER,
        client_status INTEGER,
        response_class TEXT,
        response_code TEXT,
        provider_response_evidence_sha256 TEXT,
        raw_object_key TEXT,
        raw_object_version TEXT,
        raw_sha256 TEXT,
        raw_size INTEGER,
        raw_content_type TEXT,
        client_response_artifact_sha256 TEXT,
        client_object_key TEXT,
        client_object_version TEXT,
        client_sha256 TEXT,
        client_size INTEGER,
        client_content_type TEXT,
        provider_usage_receipt_sha256 TEXT,
        attached_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, owner_generation, attempt_generation),
        UNIQUE (provider_response_evidence_sha256),
        UNIQUE (raw_object_key, raw_object_version),
        UNIQUE (client_response_artifact_sha256),
        UNIQUE (client_object_key, client_object_version),
        CHECK (
          length(operation_id) BETWEEN 1 AND 128
          AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        CHECK (owner_generation > 0),
        CHECK (attempt_generation BETWEEN 1 AND 3),
        CHECK (
          length(provider_operation_id) BETWEEN 1 AND 128
          AND provider_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        CHECK (
          length(admission_sha256) = 64
          AND admission_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          length(request_sha256) = 64
          AND request_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (
          egress_profile = 'openai-chat-completions-canary-v1'
        ),
        CHECK (
          length(egress_worker_version_id) BETWEEN 1 AND 128
          AND egress_worker_version_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
        ),
        CHECK (status IN ('succeeded', 'interpreted_reject', 'ambiguous')),
        CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
        CHECK (client_status IS NULL OR client_status BETWEEN 100 AND 599),
        CHECK (
          response_class IS NULL OR
          response_class IN ('success', 'typed_error', 'http_error', 'invalid_body')
        ),
        CHECK (
          response_code IS NULL OR
          (length(response_code) BETWEEN 1 AND 64
            AND response_code NOT GLOB '*[^a-z0-9_:-]*')
        ),
        CHECK (
          (provider_response_evidence_sha256 IS NULL
            AND raw_object_key IS NULL
            AND raw_object_version IS NULL
            AND raw_sha256 IS NULL
            AND raw_size IS NULL
            AND raw_content_type IS NULL)
          OR
          (provider_response_evidence_sha256 IS NOT NULL
            AND length(provider_response_evidence_sha256) = 64
            AND provider_response_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
            AND raw_object_key IS NOT NULL
            AND raw_object_key =
              'container-provider-evidence/v1/' || operation_id || '/' ||
              owner_generation || '/' || attempt_generation || '/' || raw_sha256
            AND raw_object_version IS NOT NULL
            AND length(raw_object_version) BETWEEN 1 AND 128
            AND raw_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
            AND raw_sha256 IS NOT NULL
            AND length(raw_sha256) = 64
            AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
            AND raw_size IS NOT NULL
            AND raw_size BETWEEN 0 AND 4194304
            AND raw_content_type IS NOT NULL
            AND length(raw_content_type) BETWEEN 3 AND 128
            AND raw_content_type NOT GLOB '*[^ -~]*')
        ),
        CHECK (
          (client_response_artifact_sha256 IS NULL
            AND client_object_key IS NULL
            AND client_object_version IS NULL
            AND client_sha256 IS NULL
            AND client_size IS NULL
            AND client_content_type IS NULL)
          OR
          (client_response_artifact_sha256 IS NOT NULL
            AND length(client_response_artifact_sha256) = 64
            AND client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
            AND client_object_key IS NOT NULL
            AND client_object_key =
              'container-client-artifacts/v1/' || operation_id || '/' ||
              owner_generation || '/' || client_response_artifact_sha256
            AND client_object_version IS NOT NULL
            AND length(client_object_version) BETWEEN 1 AND 128
            AND client_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
            AND client_sha256 IS NOT NULL
            AND length(client_sha256) = 64
            AND client_sha256 NOT GLOB '*[^0-9a-f]*'
            AND client_size IS NOT NULL
            AND client_size BETWEEN 2 AND 4194304
            AND client_content_type IS NOT NULL
            AND client_content_type = 'application/json')
        ),
        CHECK (
          provider_usage_receipt_sha256 IS NULL OR
          (length(provider_usage_receipt_sha256) = 64
            AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        CHECK (
          (status = 'succeeded'
            AND provider_status IS NOT NULL
            AND provider_status = 200
            AND client_status IS NOT NULL
            AND client_status = 200
            AND response_class IS NOT NULL
            AND response_class = 'success'
            AND response_code IS NULL
            AND provider_response_evidence_sha256 IS NOT NULL
            AND client_response_artifact_sha256 IS NOT NULL)
          OR
          (status = 'interpreted_reject'
            AND provider_status IS NOT NULL
            AND client_status IS NOT NULL
            AND response_class IS NOT NULL
            AND response_code IS NOT NULL
            AND provider_response_evidence_sha256 IS NOT NULL
            AND client_response_artifact_sha256 IS NOT NULL
            AND provider_usage_receipt_sha256 IS NULL
            AND (
              (response_class = 'typed_error'
                AND provider_status = 200 AND client_status = 200)
              OR
              (response_class = 'http_error'
                AND provider_status <> 200 AND client_status = provider_status)
              OR
              (response_class = 'invalid_body'
                AND provider_status = 200 AND client_status = 500)
            ))
          OR
          (status = 'ambiguous'
            AND provider_status IS NULL
            AND client_status IS NULL
            AND response_class IS NULL
            AND response_code IS NOT NULL
            AND provider_response_evidence_sha256 IS NULL
            AND client_response_artifact_sha256 IS NULL
            AND provider_usage_receipt_sha256 IS NULL)
        ),
        CHECK (attached_at > 0 AND attached_at <= 253402300799)
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_provider_response_attachments_time
        ON cinatoken_shard_provider_response_attachments(attached_at, operation_id);
      CREATE TABLE IF NOT EXISTS cinatoken_shard_provider_response_attachment_identities (
        operation_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        attempt_generation INTEGER NOT NULL,
        provider_response_evidence_sha256 TEXT,
        raw_object_key TEXT,
        raw_object_version TEXT,
        client_response_artifact_sha256 TEXT,
        client_object_key TEXT,
        client_object_version TEXT,
        PRIMARY KEY (operation_id, owner_generation, attempt_generation),
        UNIQUE (provider_response_evidence_sha256),
        UNIQUE (raw_object_key, raw_object_version),
        UNIQUE (client_response_artifact_sha256),
        UNIQUE (client_object_key, client_object_version)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_insert_guard
      BEFORE INSERT ON cinatoken_shard_provider_response_attachments
      FOR EACH ROW
      WHEN
        EXISTS (
          SELECT 1
            FROM cinatoken_shard_provider_response_attachment_identities AS identity
           WHERE (identity.operation_id = NEW.operation_id
               AND identity.owner_generation = NEW.owner_generation
               AND identity.attempt_generation = NEW.attempt_generation)
              OR identity.provider_response_evidence_sha256 =
                   NEW.provider_response_evidence_sha256
              OR (identity.raw_object_key = NEW.raw_object_key
                AND identity.raw_object_version = NEW.raw_object_version)
              OR identity.client_response_artifact_sha256 =
                   NEW.client_response_artifact_sha256
              OR (identity.client_object_key = NEW.client_object_key
                AND identity.client_object_version = NEW.client_object_version)
        )
        OR NOT EXISTS (
          SELECT 1
            FROM cinatoken_shard_operations AS operation
            JOIN cinatoken_shard_provider_attempts AS attempt
              ON attempt.operation_id = operation.operation_id
             AND attempt.owner_generation = operation.owner_generation
           WHERE operation.operation_id = NEW.operation_id
             AND operation.owner_generation = NEW.owner_generation
             AND operation.operation_kind != 'health_probe'
             AND operation.provider_operation_id = NEW.provider_operation_id
             AND operation.admission_sha256 = NEW.admission_sha256
             AND operation.input_sha256 = NEW.request_sha256
             AND attempt.attempt_generation = NEW.attempt_generation
             AND attempt.provider_operation_id = NEW.provider_operation_id
             AND attempt.admission_sha256 = NEW.admission_sha256
             AND attempt.request_sha256 = NEW.request_sha256
             AND attempt.egress_profile = NEW.egress_profile
             AND attempt.egress_worker_version_id = NEW.egress_worker_version_id
             AND attempt.status = 'dispatched'
             AND attempt.dispatched_at IS NOT NULL
             AND NEW.attached_at >= attempt.dispatched_at
             AND (
               (NEW.status = 'ambiguous'
                 AND operation.status IN ('running', 'recovery_required'))
               OR
               (NEW.status IN ('succeeded', 'interpreted_reject')
                 AND operation.status = 'running'
                 AND operation.deadline_at > NEW.attached_at
                 AND operation.owner_lease_expires_at > NEW.attached_at)
             )
             AND (
               (NEW.status = 'succeeded'
                 AND (
                   (NEW.provider_usage_receipt_sha256 IS NULL
                     AND operation.provider_usage_receipt_sha256 IS NULL
                     AND attempt.provider_usage_receipt_sha256 IS NULL
                     AND (
                       operation.result_object_key IS NULL
                       OR (operation.result_sha256 = NEW.client_sha256
                         AND operation.result_size = NEW.client_size
                         AND operation.result_content_type = NEW.client_content_type)
                     ))
                   OR
                   (NEW.provider_usage_receipt_sha256 IS NOT NULL
                     AND operation.provider_usage_receipt_sha256 =
                       NEW.provider_usage_receipt_sha256
                     AND attempt.provider_usage_receipt_sha256 =
                       NEW.provider_usage_receipt_sha256
                     AND attempt.provider_usage_receipt_attached_at IS NOT NULL
                     AND attempt.provider_usage_receipt_attached_at <= NEW.attached_at
                     AND operation.result_object_key IS NOT NULL
                     AND operation.result_sha256 = NEW.client_sha256
                     AND operation.result_size = NEW.client_size
                     AND operation.result_content_type = NEW.client_content_type)
                 ))
               OR
               (NEW.status IN ('interpreted_reject', 'ambiguous')
                 AND operation.result_object_key IS NULL
                 AND operation.result_object_version IS NULL
                 AND operation.result_sha256 IS NULL
                 AND operation.result_size IS NULL
                 AND operation.result_content_type IS NULL
                 AND operation.provider_usage_receipt_sha256 IS NULL
                 AND attempt.provider_usage_receipt_sha256 IS NULL
                 AND attempt.provider_usage_receipt_attached_at IS NULL)
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment authority mismatch');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_identity_append
      AFTER INSERT ON cinatoken_shard_provider_response_attachments
      FOR EACH ROW
      BEGIN
        INSERT INTO cinatoken_shard_provider_response_attachment_identities
          (operation_id, owner_generation, attempt_generation,
           provider_response_evidence_sha256, raw_object_key, raw_object_version,
           client_response_artifact_sha256, client_object_key, client_object_version)
        VALUES (
          NEW.operation_id,
          NEW.owner_generation,
          NEW.attempt_generation,
          NEW.provider_response_evidence_sha256,
          NEW.raw_object_key,
          NEW.raw_object_version,
          NEW.client_response_artifact_sha256,
          NEW.client_object_key,
          NEW.client_object_version
        );
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_update_guard
      BEFORE UPDATE ON cinatoken_shard_provider_response_attachments
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_delete_guard
      BEFORE DELETE ON cinatoken_shard_provider_response_attachments
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment cannot be deleted');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_identity_insert_guard
      BEFORE INSERT ON cinatoken_shard_provider_response_attachment_identities
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
          FROM cinatoken_shard_provider_response_attachment_identities AS identity
         WHERE (identity.operation_id = NEW.operation_id
             AND identity.owner_generation = NEW.owner_generation
             AND identity.attempt_generation = NEW.attempt_generation)
            OR identity.provider_response_evidence_sha256 =
                 NEW.provider_response_evidence_sha256
            OR (identity.raw_object_key = NEW.raw_object_key
              AND identity.raw_object_version = NEW.raw_object_version)
            OR identity.client_response_artifact_sha256 =
                 NEW.client_response_artifact_sha256
            OR (identity.client_object_key = NEW.client_object_key
              AND identity.client_object_version = NEW.client_object_version)
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_identity_update_guard
      BEFORE UPDATE ON cinatoken_shard_provider_response_attachment_identities
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_provider_response_attachment_identity_delete_guard
      BEFORE DELETE ON cinatoken_shard_provider_response_attachment_identities
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'provider response attachment identity cannot be deleted');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_operation_attempt_cleanup
      AFTER DELETE ON cinatoken_shard_operations
      FOR EACH ROW
      BEGIN
        DELETE FROM cinatoken_shard_provider_attempts
         WHERE operation_id = OLD.operation_id
           AND owner_generation = OLD.owner_generation;
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_operation_terminal_ack_cleanup
      AFTER DELETE ON cinatoken_shard_operations
      FOR EACH ROW
      BEGIN
        DELETE FROM cinatoken_shard_terminal_acks
         WHERE operation_id = OLD.operation_id
           AND owner_generation = OLD.owner_generation;
      END;
      CREATE TABLE IF NOT EXISTS cinatoken_shard_readiness (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        probe_generation INTEGER NOT NULL,
        phase TEXT NOT NULL,
        last_probe_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        deadline_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        result_code TEXT,
        container_status TEXT,
        container_last_change_ms INTEGER,
        container_exit_code INTEGER,
        runtime_protocol_version INTEGER,
        runtime_contract_version INTEGER,
        runtime_build_id TEXT,
        runtime_execution_enabled INTEGER,
        process_ready INTEGER,
        execution_ready INTEGER,
        last_ready_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS cinatoken_shard_readiness_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_readiness_dispatches_created
        ON cinatoken_shard_readiness_dispatches(created_at_ms);
      CREATE TABLE IF NOT EXISTS cinatoken_shard_schema_migrations (
        schema_version INTEGER PRIMARY KEY,
        migration_name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL CHECK (applied_at > 0)
      );
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_schema_migration_update_guard
      BEFORE UPDATE ON cinatoken_shard_schema_migrations
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'shard schema migration is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_schema_migration_delete_guard
      BEFORE DELETE ON cinatoken_shard_schema_migrations
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'shard schema migration cannot be deleted');
      END;
      CREATE TABLE IF NOT EXISTS cinatoken_shard_alarm_intents (
        operation_id TEXT PRIMARY KEY,
        owner_generation INTEGER NOT NULL,
        payload_version INTEGER NOT NULL,
        intent_kind TEXT NOT NULL,
        deadline_at INTEGER NOT NULL,
        delivery_generation INTEGER NOT NULL,
        delivery_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        armed_at INTEGER,
        next_delivery_at INTEGER NOT NULL,
        last_error_code TEXT,
        shard_contract_version INTEGER NOT NULL,
        ring_generation INTEGER NOT NULL,
        shard_count INTEGER NOT NULL,
        shard_index INTEGER NOT NULL,
        instance_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (length(operation_id) BETWEEN 1 AND 128),
        CHECK (owner_generation > 0),
        CHECK (payload_version = 1),
        CHECK (intent_kind = 'operation_deadline'),
        CHECK (deadline_at > 0),
        CHECK (delivery_generation BETWEEN 1 AND 8),
        CHECK (delivery_count BETWEEN 0 AND 8),
        CHECK (delivery_count <= delivery_generation),
        CHECK (delivery_generation - delivery_count BETWEEN 0 AND 1),
        CHECK (state IN ('pending', 'completed', 'quarantined')),
        CHECK (armed_at IS NULL OR armed_at > 0),
        CHECK (next_delivery_at > 0),
        CHECK (
          last_error_code IS NULL OR
          (length(last_error_code) BETWEEN 1 AND 96
            AND last_error_code NOT GLOB '*[^a-z0-9_]*')
        ),
        CHECK (shard_contract_version = 1),
        CHECK (ring_generation > 0),
        CHECK (shard_count BETWEEN 1 AND 1024),
        CHECK (shard_index BETWEEN 0 AND shard_count - 1),
        CHECK (length(instance_name) BETWEEN 29 AND 64),
        CHECK (created_at > 0 AND updated_at >= created_at),
        CHECK (
          (state = 'pending') OR
          (state IN ('completed', 'quarantined') AND armed_at IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_alarm_intents_pending
        ON cinatoken_shard_alarm_intents(state, armed_at, next_delivery_at, operation_id);
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_alarm_intent_insert_guard
      BEFORE INSERT ON cinatoken_shard_alarm_intents
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1 FROM cinatoken_shard_alarm_intents AS existing
         WHERE existing.operation_id = NEW.operation_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'shard alarm intent cannot be replaced');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_alarm_intent_identity_guard
      BEFORE UPDATE ON cinatoken_shard_alarm_intents
      FOR EACH ROW
      WHEN
        NEW.operation_id IS NOT OLD.operation_id OR
        NEW.owner_generation IS NOT OLD.owner_generation OR
        NEW.payload_version IS NOT OLD.payload_version OR
        NEW.intent_kind IS NOT OLD.intent_kind OR
        NEW.deadline_at IS NOT OLD.deadline_at OR
        NEW.shard_contract_version IS NOT OLD.shard_contract_version OR
        NEW.ring_generation IS NOT OLD.ring_generation OR
        NEW.shard_count IS NOT OLD.shard_count OR
        NEW.shard_index IS NOT OLD.shard_index OR
        NEW.instance_name IS NOT OLD.instance_name OR
        NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'shard alarm intent identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_alarm_intent_delete_guard
      BEFORE DELETE ON cinatoken_shard_alarm_intents
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1 FROM cinatoken_shard_operations AS operation
         WHERE operation.operation_id = OLD.operation_id
           AND operation.owner_generation = OLD.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'shard alarm intent cannot be deleted before its operation');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_operation_alarm_intent_terminal
      AFTER UPDATE OF status ON cinatoken_shard_operations
      FOR EACH ROW
      WHEN
        NEW.status IN ('completed', 'failed', 'recovery_required') AND
        OLD.status NOT IN ('completed', 'failed', 'recovery_required')
      BEGIN
        UPDATE cinatoken_shard_alarm_intents
           SET state = 'completed', armed_at = NULL, last_error_code = NULL,
               updated_at = MAX(updated_at, NEW.updated_at)
         WHERE operation_id = NEW.operation_id
           AND owner_generation = NEW.owner_generation
           AND state = 'pending';
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_operation_alarm_intent_cleanup
      AFTER DELETE ON cinatoken_shard_operations
      FOR EACH ROW
      BEGIN
        DELETE FROM cinatoken_shard_alarm_intents
         WHERE operation_id = OLD.operation_id
           AND owner_generation = OLD.owner_generation;
      END;
      INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
        (schema_version, migration_name, applied_at)
      VALUES (1, '0001_legacy_schema_observed', unixepoch());
      INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
        (schema_version, migration_name, applied_at)
      VALUES (2, '0002_operation_deadline_alarm_intent_v1', unixepoch());
      INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
        (schema_version, migration_name, applied_at)
      VALUES (3, '0003_provider_response_artifact_attachment_v1', unixepoch());
    `);
    this.validateShardSchemaMigrations(3);
    this.ensureOperationColumns();
    this.ensureProviderAttemptEgressColumns();
    this.ensureProviderUsageReceiptColumns();
    this.ensureTerminalAckV3Columns();
    this.ensureTerminalAckV3TableShape();
    this.installProviderAttemptEgressGuards();
    this.installProviderUsageReceiptGuards();
    this.installTerminalAckV3Guards();
    this.validateProviderResponseAttachmentSchema();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
         (schema_version, migration_name, applied_at)
       VALUES (4, '0004_terminal_ack_v3_convergence', unixepoch())`,
    );
    this.validateShardSchemaMigrations(2);
    this.ensureReadinessReplayColumns();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
         (schema_version, migration_name, applied_at)
       VALUES (5, '0005_readiness_probe_recovery_v1', unixepoch())`,
    );
    this.validateShardSchemaMigrations(1);
    this.ensureReadinessProbeJournalV6();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO cinatoken_shard_schema_migrations
         (schema_version, migration_name, applied_at)
       VALUES (6, '0006_readiness_probe_at_most_once_journal_v1', unixepoch())`,
    );
    this.validateShardSchemaMigrations();
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'failed', response_status = COALESCE(response_status, 503)
        WHERE status = 'capacity_rejected'`,
    );
    this.schemaReady = true;
  }

  authorizeStorageAccess(
    operationId: string,
    ownerGeneration: number,
    now: number,
    requireProviderAttempt = false,
  ): StorageAccessGrant {
    this.ensureSchema();
    if (
      operationId.length < 1 ||
      operationId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(operationId) ||
      !Number.isSafeInteger(ownerGeneration) ||
      ownerGeneration < 1 ||
      !Number.isSafeInteger(now) ||
      now < 1
    ) {
      throw new ProtocolError("storage_access_denied", 403);
    }
    const row = this.readStorageOperation(operationId);
    if (
      row === null ||
      row.protocol_version < 1 ||
      row.protocol_version > 255 ||
      row.owner_generation !== ownerGeneration ||
      row.owner_lease_expires_at <= now ||
      row.status !== "running" ||
      row.deadline_at <= now ||
      row.deadline_at > row.owner_lease_expires_at ||
      row.operation_kind.length < 1 ||
      row.operation_kind.length > 64 ||
      !/^[a-z0-9_:-]+$/.test(row.operation_kind) ||
      row.provider_operation_id.length < 1 ||
      row.provider_operation_id.length > 128 ||
      !/^[A-Za-z0-9._:/@-]+$/.test(row.provider_operation_id) ||
      !/^[0-9a-f]{64}$/.test(row.admission_sha256) ||
      !/^[0-9a-f]{64}$/.test(row.input_sha256) ||
      row.input_size < 0 ||
      row.input_size > 64 * 1024 * 1024 ||
      row.input_content_type.length < 3 ||
      row.input_content_type.length > 128 ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(
        row.input_content_type,
      ) ||
      (row.input_mode !== "inline" && row.input_mode !== "r2") ||
      (row.input_mode === "inline" &&
        (row.request_object_key !== null || row.object_version !== null)) ||
      (row.input_mode === "r2" &&
        (row.request_object_key === null ||
          row.request_object_key.length < 1 ||
          row.request_object_key.length > 512 ||
          !/^[A-Za-z0-9/_.:-]+$/.test(row.request_object_key) ||
          row.object_version === null ||
          row.object_version.length < 1 ||
          row.object_version.length > 128 ||
          !/^[A-Za-z0-9._:-]+$/.test(row.object_version))) ||
      row.shard_contract_version !== 1 ||
      row.ring_generation < 1 ||
      row.shard_count < 1 ||
      row.shard_count > 1024 ||
      row.shard_index < 0 ||
      row.shard_index >= row.shard_count ||
      row.instance_name.length < 29 ||
      row.instance_name.length > 64 ||
      !/^[a-z0-9-]+$/.test(row.instance_name) ||
      row.trace_id.length < 1 ||
      row.trace_id.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(row.trace_id)
    ) {
      throw new ProtocolError("storage_access_denied", 403);
    }
    const providerAttempt = this.readLatestProviderAttempt(operationId, ownerGeneration);
    if (requireProviderAttempt && providerAttempt === null) {
      throw new ProtocolError("provider_attempt_required", 409);
    }
    return storageGrant(row, providerAttempt);
  }

  recordStorageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    now: number,
    providerAttemptGeneration?: number,
  ): RecordStorageResultOutcome {
    this.ensureSchema();
    validateStorageResult(result);
    if (providerAttemptGeneration !== undefined) {
      throw new ProtocolError("provider_usage_result_required", 409);
    }
    if (
      result.object_key !==
      `container-results/v1/${operationId}/${ownerGeneration}/${result.sha256}`
    ) {
      throw new ProtocolError("invalid_storage_result", 400);
    }
    return this.storage.transactionSync(() => {
      const grant = this.authorizeStorageAccess(operationId, ownerGeneration, now, false);
      if (grant.provider_attempt !== null) {
        throw new ProtocolError("provider_usage_result_required", 409);
      }
      if (grant.result !== null) {
        if (storageResultMatches(grant.result, result)) return "duplicate";
        throw new ProtocolError("storage_result_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET result_object_key = ?1, result_object_version = ?2, result_sha256 = ?3,
                result_size = ?4, result_content_type = ?5, updated_at = ?6
          WHERE operation_id = ?7 AND owner_generation = ?8 AND status = 'running'
            AND deadline_at > ?6 AND result_object_key IS NULL`,
        result.object_key,
        result.object_version,
        result.sha256,
        result.size,
        result.content_type,
        now,
        operationId,
        ownerGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        const current = this.readStorageOperation(operationId);
        if (
          current !== null &&
          current.owner_generation === ownerGeneration &&
          current.result_object_key !== null &&
          storageResultMatches(operationStorageResult(current), result)
        ) {
          return "duplicate";
        }
        throw new ProtocolError("storage_result_conflict", 409);
      }
      return "recorded";
    });
  }

  recordProviderUsageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    attemptGeneration: number,
    usageReceiptSha256: string,
    now: number,
  ): RecordStorageResultOutcome {
    this.ensureSchema();
    validateStorageResult(result);
    validateProviderAttemptCommand(operationId, ownerGeneration, now, attemptGeneration);
    if (
      !/^[0-9a-f]{64}$/.test(usageReceiptSha256) ||
      result.object_key !==
        `container-results/v1/${operationId}/${ownerGeneration}/${result.sha256}`
    ) {
      throw new ProtocolError("invalid_provider_usage_result", 400);
    }
    return this.storage.transactionSync(() => {
      const grant = this.authorizeStorageAccess(operationId, ownerGeneration, now, true);
      const attempt = grant.provider_attempt;
      if (
        attempt === null ||
        attempt.attempt_generation !== attemptGeneration ||
        attempt.status !== "dispatched"
      ) {
        throw new ProtocolError("provider_attempt_result_conflict", 409);
      }
      if (grant.result !== null) {
        if (
          storageResultMatches(grant.result, result) &&
          grant.provider_usage_receipt_sha256 === usageReceiptSha256 &&
          attempt.provider_usage_receipt_sha256 === usageReceiptSha256 &&
          attempt.provider_usage_receipt_attached_at !== null
        ) {
          return "duplicate";
        }
        throw new ProtocolError("provider_usage_result_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET result_object_key = ?1, result_object_version = ?2, result_sha256 = ?3,
                result_size = ?4, result_content_type = ?5,
                provider_usage_receipt_sha256 = ?6, updated_at = ?7
          WHERE operation_id = ?8 AND owner_generation = ?9 AND status = 'running'
            AND deadline_at > ?7 AND result_object_key IS NULL
            AND provider_usage_receipt_sha256 IS NULL`,
        result.object_key,
        result.object_version,
        result.sha256,
        result.size,
        result.content_type,
        usageReceiptSha256,
        now,
        operationId,
        ownerGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_usage_result_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_attempts
            SET provider_usage_receipt_sha256 = ?1,
                provider_usage_receipt_attached_at = ?2
          WHERE operation_id = ?3 AND owner_generation = ?4
            AND attempt_generation = ?5 AND status = 'dispatched'
            AND provider_usage_receipt_sha256 IS NULL
            AND provider_usage_receipt_attached_at IS NULL`,
        usageReceiptSha256,
        now,
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_usage_result_conflict", 409);
      }
      const operation = this.readStorageOperation(operationId);
      const recordedAttempt = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (
        operation === null ||
        operation.owner_generation !== ownerGeneration ||
        !storageResultMatches(operationStorageResult(operation), result) ||
        operation.provider_usage_receipt_sha256 !== usageReceiptSha256 ||
        recordedAttempt === null ||
        recordedAttempt.status !== "dispatched" ||
        recordedAttempt.provider_usage_receipt_sha256 !== usageReceiptSha256 ||
        recordedAttempt.provider_usage_receipt_attached_at !== now
      ) {
        throw new ProtocolError("provider_usage_result_conflict", 409);
      }
      return "recorded";
    });
  }

  attachProviderResponseArtifacts(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    attachment: ProviderResponseArtifactAttachment,
    now: number,
  ): AttachProviderResponseArtifactsOutcome {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, now, attemptGeneration);
    validateProviderResponseArtifactAttachment(
      operationId,
      ownerGeneration,
      attemptGeneration,
      attachment,
    );
    if (now > MAX_UNIX_TIMESTAMP_SECONDS) {
      throw new ProtocolError("invalid_provider_response_attachment", 400);
    }
    return this.storage.transactionSync(() => {
      const existing = this.readProviderResponseArtifactAttachmentRow(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (existing !== null) {
        if (providerResponseArtifactAttachmentMatches(existing, attachment)) {
          return { kind: "duplicate", row: existing };
        }
        throw new ProtocolError("provider_response_attachment_conflict", 409);
      }

      const operation = this.readStorageOperation(operationId);
      const attempt = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (
        operation === null ||
        attempt === null ||
        operation.owner_generation !== ownerGeneration ||
        operation.operation_kind === "health_probe" ||
        operation.provider_operation_id !== attempt.provider_operation_id ||
        operation.admission_sha256 !== attempt.admission_sha256 ||
        operation.input_sha256 !== attempt.request_sha256 ||
        attempt.status !== "dispatched" ||
        attempt.dispatched_at === null ||
        attempt.dispatched_at > now ||
        attempt.egress_profile !== "openai-chat-completions-canary-v1" ||
        attempt.egress_worker_version_id === null ||
        (attachment.status === "ambiguous"
          ? operation.status !== "running" && operation.status !== "recovery_required"
          : operation.status !== "running" ||
            operation.deadline_at <= now ||
            operation.owner_lease_expires_at <= now)
      ) {
        throw new ProtocolError("provider_response_attachment_conflict", 409);
      }

      const result = operationStorageResult(operation);
      const hasNoUsageReceipt =
        operation.provider_usage_receipt_sha256 === null &&
        attempt.provider_usage_receipt_sha256 === null &&
        attempt.provider_usage_receipt_attached_at === null;
      const usageReceiptMatches =
        attachment.status === "succeeded" &&
        attachment.provider_usage_receipt_sha256 !== null &&
        operation.provider_usage_receipt_sha256 ===
          attachment.provider_usage_receipt_sha256 &&
        attempt.provider_usage_receipt_sha256 ===
          attachment.provider_usage_receipt_sha256 &&
        attempt.provider_usage_receipt_attached_at !== null &&
        attempt.provider_usage_receipt_attached_at <= now &&
        result !== null &&
        storageResultBodyMatches(result, attachment.client_manifest);
      const noReceiptSuccessMatches =
        attachment.status === "succeeded" &&
        attachment.provider_usage_receipt_sha256 === null &&
        hasNoUsageReceipt &&
        (result === null || storageResultBodyMatches(result, attachment.client_manifest));
      const nonSuccessMatches =
        attachment.status !== "succeeded" && result === null && hasNoUsageReceipt;
      if (!usageReceiptMatches && !noReceiptSuccessMatches && !nonSuccessMatches) {
        throw new ProtocolError("provider_response_attachment_conflict", 409);
      }

      try {
        this.storage.sql.exec(
          `INSERT INTO cinatoken_shard_provider_response_attachments
             (operation_id, owner_generation, attempt_generation, provider_operation_id,
              admission_sha256, request_sha256, egress_profile, egress_worker_version_id,
              status, provider_status, client_status, response_class, response_code,
              provider_response_evidence_sha256, raw_object_key, raw_object_version,
              raw_sha256, raw_size, raw_content_type,
              client_response_artifact_sha256, client_object_key, client_object_version,
              client_sha256, client_size, client_content_type,
              provider_usage_receipt_sha256, attached_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
                   ?26, ?27)`,
          operationId,
          ownerGeneration,
          attemptGeneration,
          attempt.provider_operation_id,
          attempt.admission_sha256,
          attempt.request_sha256,
          attempt.egress_profile,
          attempt.egress_worker_version_id,
          attachment.status,
          attachment.provider_status,
          attachment.client_status,
          attachment.response_class,
          attachment.response_code,
          attachment.raw_manifest?.provider_response_evidence_sha256 ?? null,
          attachment.raw_manifest?.object_key ?? null,
          attachment.raw_manifest?.object_version ?? null,
          attachment.raw_manifest?.sha256 ?? null,
          attachment.raw_manifest?.size ?? null,
          attachment.raw_manifest?.content_type ?? null,
          attachment.client_manifest?.client_response_artifact_sha256 ?? null,
          attachment.client_manifest?.object_key ?? null,
          attachment.client_manifest?.object_version ?? null,
          attachment.client_manifest?.sha256 ?? null,
          attachment.client_manifest?.size ?? null,
          attachment.client_manifest?.content_type ?? null,
          attachment.provider_usage_receipt_sha256,
          now,
        );
      } catch {
        throw new ProtocolError("provider_response_attachment_conflict", 409);
      }
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_response_attachment_conflict", 409);
      }
      const recorded = this.readProviderResponseArtifactAttachmentRow(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (
        recorded === null ||
        !providerResponseArtifactAttachmentMatches(recorded, attachment)
      ) {
        throw new ProtocolError("provider_response_attachment_unavailable", 503);
      }
      return { kind: "attached", row: recorded };
    });
  }

  readProviderResponseArtifactAttachment(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): ProviderResponseArtifactAttachmentRow | null {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, 1, attemptGeneration);
    return this.readProviderResponseArtifactAttachmentRow(
      operationId,
      ownerGeneration,
      attemptGeneration,
    );
  }

  readOperationOutcome(operationId: string): OperationRow | null {
    this.ensureSchema();
    return firstRow<OperationRow>(
      this.storage.sql.exec<OperationRow>(
        `SELECT operation_id, owner_generation, operation_kind, trace_id, envelope_sha256,
                status, response_status, response_code, result_object_key,
                result_object_version, result_sha256, result_size, result_content_type,
                provider_usage_receipt_sha256
           FROM cinatoken_shard_operations WHERE operation_id = ?1`,
        operationId,
      ),
    );
  }

  readOperationStatus(queryValue: unknown): OperationRow {
    const query: OperationStatusQuery = validateOperationStatusQuery(queryValue);
    const row = firstRow<OperationRow>(
      this.storage.sql.exec<OperationRow>(
        `SELECT operation_id, owner_generation, operation_kind, trace_id, envelope_sha256,
                status, response_status, response_code, result_object_key,
                result_object_version, result_sha256, result_size, result_content_type,
                provider_usage_receipt_sha256
           FROM cinatoken_shard_operations
          WHERE protocol_version = ?1 AND operation_id = ?2 AND owner_generation = ?3
            AND shard_contract_version = ?4 AND ring_generation = ?5 AND shard_count = ?6
            AND shard_index = ?7 AND instance_name = ?8 AND trace_id = ?9`,
        query.protocol_version,
        query.operation_id,
        query.owner_generation,
        query.shard.contract_version,
        query.shard.ring_generation,
        query.shard.shard_count,
        query.shard.shard_index,
        query.shard.instance_name,
        query.trace_id,
      ),
    );
    if (row === null) throw new ProtocolError("operation_status_not_found", 404);
    return row;
  }

  readOperationStatusSnapshot(queryValue: unknown): OperationStatusSnapshot {
    const operation = this.readOperationStatus(queryValue);
    return {
      operation,
      provider_attempt: this.readLatestProviderAttempt(
        operation.operation_id,
        operation.owner_generation,
      ),
    };
  }

  readOperationStatusV4Snapshot(queryValue: unknown): OperationStatusV4Snapshot {
    return this.storage.transactionSync(() => {
      const operation = this.readOperationStatus(queryValue);
      const providerAttempt = this.readLatestProviderAttempt(
        operation.operation_id,
        operation.owner_generation,
      );
      const providerResponseArtifacts =
        providerAttempt === null
          ? null
          : this.readProviderResponseArtifactAttachmentRow(
              operation.operation_id,
              operation.owner_generation,
              providerAttempt.attempt_generation,
            );
      if (providerResponseArtifacts !== null) {
        if (
          providerAttempt === null ||
          providerResponseArtifacts.provider_operation_id !==
            providerAttempt.provider_operation_id ||
          providerResponseArtifacts.admission_sha256 !==
            providerAttempt.admission_sha256 ||
          providerResponseArtifacts.request_sha256 !==
            providerAttempt.request_sha256 ||
          providerResponseArtifacts.egress_profile !==
            providerAttempt.egress_profile ||
          providerResponseArtifacts.egress_worker_version_id !==
            providerAttempt.egress_worker_version_id
        ) {
          throw new ProtocolError("provider_response_attachment_corrupt", 503);
        }
      }
      return {
        operation,
        provider_attempt: providerAttempt,
        provider_response_artifacts: providerResponseArtifacts,
      };
    });
  }

  acknowledgeGlobalTerminal(
    ackValue: unknown,
    now: number,
  ): TerminalAckLedgerOutcome {
    this.ensureSchema();
    const ack = validateTerminalAckRequest(ackValue);
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new ProtocolError("invalid_terminal_ack_time", 500);
    }
    const payloadJson = terminalAckPayloadJson(ack);
    return this.storage.transactionSync(() => {
      const providerAttempt = this.readLatestProviderAttempt(
        ack.operation_id,
        ack.owner_generation,
      );
      const completeProviderResponseArtifacts = firstRow<{ present: number }>(
        this.storage.sql.exec<{ present: number }>(
          `SELECT 1 AS present
             FROM cinatoken_shard_provider_response_attachments
            WHERE operation_id = ?1 AND owner_generation = ?2
              AND status IN ('succeeded', 'interpreted_reject')
            LIMIT 1`,
          ack.operation_id,
          ack.owner_generation,
        ),
      );
      if (completeProviderResponseArtifacts !== null) {
        throw new ProtocolError("terminal_ack_contract_downgrade", 409);
      }
      const state = this.readTerminalAckState(ack.operation_id, ack.owner_generation);
      if (state !== null && currentTerminalAckMatches(state, ack, payloadJson)) {
        const finalAck = ack.operation_status !== "recovery_required";
        if ((state.final_acked_at !== null) !== finalAck) {
          throw new ProtocolError("terminal_ack_conflict", 409);
        }
        return {
          kind: "duplicate",
          finalAck,
          acknowledgedAt: state.final_acked_at,
        };
      }
      if (state !== null && recoveryTerminalAckReplayMatches(state, ack, payloadJson)) {
        return { kind: "duplicate", finalAck: false, acknowledgedAt: null };
      }

      const progressingRecovery =
        state !== null && canProgressRecoveryTerminalAck(state, ack);
      if (
        (state === null && ack.reconciliation_revision !== 1) ||
        (state !== null && !progressingRecovery)
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      const operation = this.readStorageOperation(ack.operation_id);
      if (operation === null) throw new ProtocolError("terminal_ack_not_found", 404);
      const localAck = progressingRecovery
        ? storedTerminalAck(state?.recovery_payload_json ?? null)
        : ack;
      if (
        localAck === null ||
        (progressingRecovery && operation.status !== ack.operation_from_status) ||
        !terminalAckOperationMatches(operation, providerAttempt, localAck)
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      if (progressingRecovery) {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_terminal_acks
              SET terminal_ack_contract_version = ?1,
                  financial_terminal_contract_version = NULL,
                  provider_response_binding_json = NULL,
                  client_response_artifact_sha256 = NULL,
                  billing_event_id = ?2,
                  terminal_contract_sha256 = ?3,
                  reconciliation_id = ?4,
                  reconciliation_revision = 2,
                  predecessor_billing_event_id = ?5,
                  ack_payload_json = ?6,
                  final_acked_at = ?7,
                  updated_at = ?7
            WHERE operation_id = ?8 AND owner_generation = ?9
              AND billing_event_id = ?5
              AND terminal_contract_sha256 = ?10
              AND reconciliation_id = ?4
              AND reconciliation_revision = 1
              AND predecessor_billing_event_id IS NULL
              AND ack_payload_json = ?11
              AND recovery_payload_json = ?11
              AND final_acked_at IS NULL
              AND compaction_authorized_at IS NULL`,
          terminalAckContractVersion(ack),
          ack.billing_event_id,
          ack.terminal_contract_sha256,
          ack.reconciliation_id,
          ack.predecessor_billing_event_id,
          payloadJson,
          now,
          ack.operation_id,
          ack.owner_generation,
          state?.terminal_contract_sha256 ?? null,
          state?.recovery_payload_json ?? null,
        );
      } else {
        const finalAck = ack.operation_status !== "recovery_required";
        this.storage.sql.exec(
          `INSERT INTO cinatoken_shard_terminal_acks
             (operation_id, owner_generation, terminal_ack_contract_version,
              financial_terminal_contract_version, billing_event_id,
              terminal_contract_sha256, reconciliation_id, reconciliation_revision,
              predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
              provider_response_binding_json, client_response_artifact_sha256,
              final_acked_at, compaction_authorized_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 1, NULL, ?7, ?8,
                   NULL, NULL, ?9, NULL, ?10, ?10)`,
          ack.operation_id,
          ack.owner_generation,
          terminalAckContractVersion(ack),
          ack.billing_event_id,
          ack.terminal_contract_sha256,
          ack.reconciliation_id,
          payloadJson,
          finalAck ? null : payloadJson,
          finalAck ? now : null,
          now,
        );
      }
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }
      const finalAck = ack.operation_status !== "recovery_required";
      return {
        kind: "acknowledged",
        finalAck,
        acknowledgedAt: finalAck ? now : null,
      };
    });
  }

  acknowledgeGlobalTerminalV3(
    ackValue: unknown,
    now: number,
  ): TerminalAckLedgerOutcome {
    this.ensureSchema();
    const ack = validateTerminalAckV3Request(ackValue);
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new ProtocolError("invalid_terminal_ack_time", 500);
    }
    const payloadJson = terminalAckV3PayloadJson(ack);
    const bindingJson = terminalAckV3ProviderResponseBindingJson(ack);
    return this.storage.transactionSync(() => {
      const state = this.readTerminalAckState(ack.operation_id, ack.owner_generation);
      if (state !== null && currentTerminalAckV3Matches(state, ack, payloadJson, bindingJson)) {
        const operation = this.readStorageOperation(ack.operation_id);
        const attempt = this.readProviderAttempt(
          ack.operation_id,
          ack.owner_generation,
          ack.provider_response_binding.attempt_generation,
        );
        const attachment = this.readProviderResponseArtifactAttachmentRow(
          ack.operation_id,
          ack.owner_generation,
          ack.provider_response_binding.attempt_generation,
        );
        const retryState = this.readProviderRetryState(
          ack.operation_id,
          ack.owner_generation,
        );
        if (
          operation === null ||
          attempt === null ||
          attachment === null ||
          retryState === null ||
          !terminalAckV3EvidenceIdentityMatches(operation, attempt, attachment, ack) ||
          !terminalAckV3RequestEvidenceMatches(operation, attempt, attachment, ack) ||
          !terminalAckV3ConvergedStateMatches(
            operation,
            attempt,
            retryState,
            state,
            ack,
          )
        ) {
          throw new ProtocolError("terminal_ack_state_corrupt", 503);
        }
        return {
          kind: "duplicate",
          finalAck: true,
          acknowledgedAt: state.final_acked_at,
        };
      }

      const progressingRecovery =
        state !== null && canProgressRecoveryTerminalAckV3(state, ack);
      if (state !== null && !progressingRecovery) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      const operation = this.readStorageOperation(ack.operation_id);
      if (operation === null) throw new ProtocolError("terminal_ack_not_found", 404);
      const attempt = this.readProviderAttempt(
        ack.operation_id,
        ack.owner_generation,
        ack.provider_response_binding.attempt_generation,
      );
      const latestAttempt = this.readLatestProviderAttempt(
        ack.operation_id,
        ack.owner_generation,
      );
      const attachment = this.readProviderResponseArtifactAttachmentRow(
        ack.operation_id,
        ack.owner_generation,
        ack.provider_response_binding.attempt_generation,
      );
      const retryState = this.readProviderRetryState(
        ack.operation_id,
        ack.owner_generation,
      );
      if (
        attempt === null ||
        latestAttempt === null ||
        latestAttempt.attempt_generation !== attempt.attempt_generation ||
        retryState === null
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }
      if (attachment === null || attachment.status === "ambiguous") {
        throw new ProtocolError("terminal_ack_evidence_required", 409);
      }
      if (!terminalAckV3EvidenceIdentityMatches(operation, attempt, attachment, ack)) {
        throw new ProtocolError("provider_response_attachment_corrupt", 503);
      }
      if (!terminalAckV3RequestEvidenceMatches(operation, attempt, attachment, ack)) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }
      if (
        !terminalAckV3SourceStateMatches(operation, attempt, ack) ||
        attachment.attached_at > now
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      const targetAttemptStatus =
        ack.provider_response_binding.status === "succeeded"
          ? "succeeded"
          : "definite_reject";
      if (attempt.status !== targetAttemptStatus) {
        if (targetAttemptStatus === "succeeded") {
          this.storage.sql.exec(
            `UPDATE cinatoken_shard_provider_attempts
                SET status = 'succeeded', response_status = 200, response_code = NULL,
                    result_object_key = ?1, result_object_version = ?2,
                    result_sha256 = ?3, result_size = ?4, result_content_type = ?5,
                    terminal_at = ?6, updated_at = ?6
              WHERE operation_id = ?7 AND owner_generation = ?8
                AND attempt_generation = ?9 AND status = ?10`,
            operation.result_object_key,
            operation.result_object_version,
            operation.result_sha256,
            operation.result_size,
            operation.result_content_type,
            now,
            ack.operation_id,
            ack.owner_generation,
            ack.provider_response_binding.attempt_generation,
            attempt.status,
          );
        } else {
          this.storage.sql.exec(
            `UPDATE cinatoken_shard_provider_attempts
                SET status = 'definite_reject', response_status = 422,
                    response_code = ?1,
                    result_object_key = NULL, result_object_version = NULL,
                    result_sha256 = NULL, result_size = NULL,
                    result_content_type = NULL,
                    terminal_at = ?2, updated_at = ?2
              WHERE operation_id = ?3 AND owner_generation = ?4
                AND attempt_generation = ?5 AND status = ?6`,
            ack.response_code,
            now,
            ack.operation_id,
            ack.owner_generation,
            ack.provider_response_binding.attempt_generation,
            attempt.status,
          );
        }
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("terminal_ack_conflict", 409);
        }
      }

      if (operation.status !== ack.operation_status) {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_operations
              SET status = ?1, response_status = ?2, response_code = ?3, updated_at = ?4
            WHERE operation_id = ?5 AND owner_generation = ?6 AND status = ?7`,
          ack.operation_status,
          ack.response_status,
          ack.response_code,
          now,
          ack.operation_id,
          ack.owner_generation,
          operation.status,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("terminal_ack_conflict", 409);
        }
      }

      if (
        retryState.global_terminal_event_id !== null ||
        retryState.global_terminal_acked_at !== null
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_retry_state
            SET state = 'terminal', active_attempt_generation = NULL,
                next_attempt_at = NULL, global_terminal_event_id = ?1,
                global_terminal_acked_at = ?2, updated_at = MAX(updated_at, ?2)
          WHERE operation_id = ?3 AND owner_generation = ?4
            AND last_attempt_generation = ?5
            AND global_terminal_event_id IS NULL
            AND global_terminal_acked_at IS NULL`,
        ack.billing_event_id,
        now,
        ack.operation_id,
        ack.owner_generation,
        ack.provider_response_binding.attempt_generation,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      if (progressingRecovery) {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_terminal_acks
              SET terminal_ack_contract_version = 3,
                  financial_terminal_contract_version = 2,
                  billing_event_id = ?1,
                  terminal_contract_sha256 = ?2,
                  reconciliation_id = ?3,
                  reconciliation_revision = 2,
                  predecessor_billing_event_id = ?4,
                  ack_payload_json = ?5,
                  provider_response_binding_json = ?6,
                  client_response_artifact_sha256 = ?7,
                  final_acked_at = ?8,
                  updated_at = ?8
            WHERE operation_id = ?9 AND owner_generation = ?10
              AND billing_event_id = ?4
              AND reconciliation_id = ?3
              AND reconciliation_revision = 1
              AND predecessor_billing_event_id IS NULL
              AND recovery_payload_json = ack_payload_json
              AND final_acked_at IS NULL
              AND compaction_authorized_at IS NULL`,
          ack.billing_event_id,
          ack.terminal_contract_sha256,
          ack.reconciliation_id,
          ack.predecessor_billing_event_id,
          payloadJson,
          bindingJson,
          ack.provider_response_binding.client_response_artifact_sha256,
          now,
          ack.operation_id,
          ack.owner_generation,
        );
      } else {
        this.storage.sql.exec(
          `INSERT INTO cinatoken_shard_terminal_acks
             (operation_id, owner_generation, terminal_ack_contract_version,
              financial_terminal_contract_version, billing_event_id,
              terminal_contract_sha256, reconciliation_id, reconciliation_revision,
              predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
              provider_response_binding_json, client_response_artifact_sha256,
              final_acked_at, compaction_authorized_at, created_at, updated_at)
           VALUES (?1, ?2, 3, 2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10,
                   ?11, NULL, ?11, ?11)`,
          ack.operation_id,
          ack.owner_generation,
          ack.billing_event_id,
          ack.terminal_contract_sha256,
          ack.reconciliation_id,
          ack.reconciliation_revision,
          ack.predecessor_billing_event_id,
          payloadJson,
          bindingJson,
          ack.provider_response_binding.client_response_artifact_sha256,
          now,
        );
      }
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      const convergedOperation = this.readStorageOperation(ack.operation_id);
      const convergedAttempt = this.readProviderAttempt(
        ack.operation_id,
        ack.owner_generation,
        ack.provider_response_binding.attempt_generation,
      );
      const convergedRetry = this.readProviderRetryState(
        ack.operation_id,
        ack.owner_generation,
      );
      const convergedAck = this.readTerminalAckState(
        ack.operation_id,
        ack.owner_generation,
      );
      if (
        convergedOperation === null ||
        convergedAttempt === null ||
        convergedRetry === null ||
        convergedAck === null ||
        !terminalAckV3EvidenceIdentityMatches(
          convergedOperation,
          convergedAttempt,
          attachment,
          ack,
        ) ||
        !terminalAckV3RequestEvidenceMatches(
          convergedOperation,
          convergedAttempt,
          attachment,
          ack,
        ) ||
        !terminalAckV3ConvergedStateMatches(
          convergedOperation,
          convergedAttempt,
          convergedRetry,
          convergedAck,
          ack,
        )
      ) {
        throw new ProtocolError("terminal_ack_state_corrupt", 503);
      }
      return {
        kind: "acknowledged",
        finalAck: true,
        acknowledgedAt: now,
      };
    });
  }

  prepareProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    maxAttempts: number,
    now: number,
  ): PrepareProviderAttemptOutcome {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, now);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new ProtocolError("controller_misconfigured", 503);
    }
    return this.storage.transactionSync(() => {
      const operation = this.readStorageOperation(operationId);
      if (
        operation === null ||
        operation.owner_generation !== ownerGeneration ||
        operation.operation_kind === "health_probe" ||
        operation.status !== "running" ||
        operation.deadline_at <= now ||
        operation.owner_lease_expires_at <= now
      ) {
        throw new ProtocolError("provider_attempt_not_authorized", 409);
      }
      const current = this.readLatestProviderAttempt(operationId, ownerGeneration);
      const retryState = this.readProviderRetryState(operationId, ownerGeneration);
      if (current !== null && matchesActiveProviderAttempt(current.status)) {
        if (
          retryState === null ||
          retryState.max_attempts !== maxAttempts ||
          retryState.state !== "active" ||
          retryState.active_attempt_generation !== current.attempt_generation
        ) {
          throw new ProtocolError("provider_retry_state_conflict", 409);
        }
        return { kind: "existing", row: current };
      }
      if (current !== null && current.status !== "definite_reject") {
        throw new ProtocolError("provider_attempt_terminal", 409);
      }
      const nextGeneration = (current?.attempt_generation ?? 0) + 1;
      if (nextGeneration > maxAttempts) {
        throw new ProtocolError("provider_attempt_limit_exhausted", 409);
      }
      if (
        retryState === null ||
        retryState.retry_enabled !== 1 ||
        retryState.max_attempts !== maxAttempts ||
        retryState.state !== "waiting" ||
        retryState.next_attempt_at === null ||
        retryState.next_attempt_at > now ||
        retryState.last_attempt_generation + 1 !== nextGeneration
      ) {
        throw new ProtocolError("provider_retry_not_due", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_retry_state
            SET state = 'active', active_attempt_generation = ?1,
                last_attempt_generation = ?1, next_attempt_at = NULL, updated_at = ?2
          WHERE operation_id = ?3 AND owner_generation = ?4
            AND state = 'waiting' AND active_attempt_generation IS NULL
            AND next_attempt_at <= ?2`,
        nextGeneration,
        now,
        operationId,
        ownerGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_retry_state_conflict", 409);
      }
      this.insertPreparedProviderAttempt(operation, nextGeneration, now);
      this.insertProviderAttemptEvent(
        operationId,
        ownerGeneration,
        nextGeneration,
        1,
        null,
        "prepared",
        null,
        null,
        now,
      );
      const created = this.readProviderAttempt(operationId, ownerGeneration, nextGeneration);
      if (created === null) throw new ProtocolError("provider_attempt_unavailable", 503);
      return { kind: "prepared", row: created };
    });
  }

  dispatchProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    now: number,
  ): DispatchProviderAttemptOutcome {
    return this.dispatchProviderAttemptInternal(
      operationId,
      ownerGeneration,
      attemptGeneration,
      now,
      null,
    );
  }

  dispatchProviderAttemptWithEgressIdentity(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    identity: ProviderEgressIdentity,
    now: number,
  ): DispatchProviderAttemptOutcome {
    validateProviderEgressIdentity(identity);
    return this.dispatchProviderAttemptInternal(
      operationId,
      ownerGeneration,
      attemptGeneration,
      now,
      identity,
    );
  }

  private dispatchProviderAttemptInternal(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    now: number,
    identity: ProviderEgressIdentity | null,
  ): DispatchProviderAttemptOutcome {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, now, attemptGeneration);
    return this.storage.transactionSync(() => {
      const current = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (current === null) throw new ProtocolError("provider_attempt_not_found", 404);
      if (current.status !== "prepared") {
        if (identity !== null && !providerEgressIdentityMatches(current, identity)) {
          throw new ProtocolError("provider_attempt_egress_identity_conflict", 409);
        }
        return { kind: "existing", row: current };
      }
      const retryState = this.readProviderRetryState(operationId, ownerGeneration);
      if (
        retryState === null ||
        retryState.state !== "active" ||
        retryState.active_attempt_generation !== attemptGeneration ||
        retryState.last_attempt_generation !== attemptGeneration
      ) {
        throw new ProtocolError("provider_retry_state_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_attempts
            SET status = 'dispatched', dispatched_at = ?1, updated_at = ?1,
                egress_profile = ?5, egress_worker_version_id = ?6
          WHERE operation_id = ?2 AND owner_generation = ?3 AND attempt_generation = ?4
            AND status = 'prepared'
            AND EXISTS (
              SELECT 1 FROM cinatoken_shard_operations AS operation
               WHERE operation.operation_id = ?2
                 AND operation.owner_generation = ?3
                 AND operation.status = 'running'
                 AND operation.deadline_at > ?1
                 AND operation.owner_lease_expires_at > ?1
            )`,
        now,
        operationId,
        ownerGeneration,
        attemptGeneration,
        identity?.profile ?? null,
        identity?.worker_version_id ?? null,
      );
      if (changedRowCount(this.storage) !== 1) {
        const replay = this.readProviderAttempt(
          operationId,
          ownerGeneration,
          attemptGeneration,
        );
        if (replay !== null && replay.status !== "prepared") {
          if (identity !== null && !providerEgressIdentityMatches(replay, identity)) {
            throw new ProtocolError("provider_attempt_egress_identity_conflict", 409);
          }
          return { kind: "existing", row: replay };
        }
        throw new ProtocolError("provider_attempt_dispatch_conflict", 409);
      }
      const dispatched = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (dispatched === null) throw new ProtocolError("provider_attempt_unavailable", 503);
      return { kind: "dispatched", row: dispatched };
    });
  }

  recordProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
    now: number,
  ): RecordProviderAttemptOutcome {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, now, attemptGeneration);
    validateProviderAttemptTerminal(terminal);
    return this.storage.transactionSync(() => {
      const current = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (current === null) throw new ProtocolError("provider_attempt_not_found", 404);
      if (!matchesActiveProviderAttempt(current.status)) {
        if (providerAttemptTerminalMatches(current, terminal)) {
          return { kind: "duplicate", row: current };
        }
        throw new ProtocolError("provider_attempt_outcome_conflict", 409);
      }
      if (current.status !== "dispatched") {
        throw new ProtocolError("provider_attempt_not_dispatched", 409);
      }
      const operation = this.readStorageOperation(operationId);
      if (
        operation === null ||
        operation.owner_generation !== ownerGeneration ||
        (operation.status !== "running" &&
          !(terminal.status === "ambiguous" && operation.status === "recovery_required"))
      ) {
        throw new ProtocolError("provider_attempt_outcome_conflict", 409);
      }
      if (
        terminal.status !== "ambiguous" &&
        (operation.deadline_at <= now || operation.owner_lease_expires_at <= now)
      ) {
        throw new ProtocolError("provider_attempt_deadline_expired", 409);
      }
      const result = operationStorageResult(operation);
      if (
        (terminal.status === "succeeded" && result === null) ||
        (terminal.status === "definite_reject" && result !== null)
      ) {
        throw new ProtocolError("provider_attempt_result_conflict", 409);
      }
      const retryState = this.readProviderRetryState(operationId, ownerGeneration);
      if (
        retryState === null ||
        retryState.state !== "active" ||
        retryState.active_attempt_generation !== attemptGeneration ||
        retryState.last_attempt_generation !== attemptGeneration
      ) {
        throw new ProtocolError("provider_retry_state_conflict", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_attempts
            SET status = ?1, response_status = ?2, response_code = ?3,
                result_object_key = ?4, result_object_version = ?5, result_sha256 = ?6,
                result_size = ?7, result_content_type = ?8,
                terminal_at = ?9, updated_at = ?9
          WHERE operation_id = ?10 AND owner_generation = ?11 AND attempt_generation = ?12
            AND status = 'dispatched'`,
        terminal.status,
        terminal.response_status,
        terminal.response_code,
        result?.object_key ?? null,
        result?.object_version ?? null,
        result?.sha256 ?? null,
        result?.size ?? null,
        result?.content_type ?? null,
        now,
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_attempt_outcome_conflict", 409);
      }
      const retryAt = now + 15;
      const waiting =
        terminal.status === "definite_reject" &&
        retryState.retry_enabled === 1 &&
        attemptGeneration < retryState.max_attempts &&
        retryAt < retryState.retry_deadline_at;
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_retry_state
            SET state = ?1, active_attempt_generation = NULL,
                schedule_generation = schedule_generation + ?2,
                next_attempt_at = ?3, updated_at = ?4
          WHERE operation_id = ?5 AND owner_generation = ?6
            AND state = 'active' AND active_attempt_generation = ?7`,
        waiting ? "waiting" : "terminal",
        waiting ? 1 : 0,
        waiting ? retryAt : null,
        now,
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("provider_retry_state_conflict", 409);
      }
      if (terminal.status === "ambiguous" && operation.status === "running") {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_operations
              SET status = 'recovery_required', response_status = 202,
                  response_code = ?1, updated_at = ?2
            WHERE operation_id = ?3 AND owner_generation = ?4 AND status = 'running'`,
          terminal.response_code,
          now,
          operationId,
          ownerGeneration,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("provider_attempt_outcome_conflict", 409);
        }
      }
      const recorded = this.readProviderAttempt(
        operationId,
        ownerGeneration,
        attemptGeneration,
      );
      if (recorded === null) throw new ProtocolError("provider_attempt_unavailable", 503);
      return { kind: "recorded", row: recorded };
    });
  }

  finalizeOperation(
    operationId: string,
    ownerGeneration: number,
    expectedStatus: "claimed" | "running",
    status: "completed" | "failed" | "recovery_required",
    responseStatus: number,
    responseCode: string | null,
    now: number,
    requireBeforeDeadline: boolean,
  ): OperationRow {
    this.ensureSchema();
    if (
      !Number.isSafeInteger(responseStatus) ||
      responseStatus < 100 ||
      responseStatus > 599 ||
      !Number.isSafeInteger(now) ||
      now < 1 ||
      (status === "completed" && responseCode !== null) ||
      (status === "completed" && (responseStatus < 200 || responseStatus > 299)) ||
      (status === "failed" && responseStatus < 400) ||
      (status !== "completed" && !validResponseCode(responseCode)) ||
      (status === "recovery_required" && responseStatus !== 202)
    ) {
      throw new ProtocolError("invalid_operation_outcome", 500);
    }
    const deadlineGuard = requireBeforeDeadline ? " AND deadline_at > ?4" : "";
    return this.storage.transactionSync(() => {
      const current = this.readOperationOutcome(operationId);
      if (
        current === null ||
        current.owner_generation !== ownerGeneration ||
        current.status !== expectedStatus
      ) {
        throw new ProtocolError("operation_completion_conflict", 409);
      }
      const result = operationStorageResult(current);
      const providerAttempt = this.readLatestProviderAttempt(operationId, ownerGeneration);
      if (
        status === "completed" &&
        ((current.operation_kind === "health_probe" && result !== null) ||
          (current.operation_kind !== "health_probe" && result === null))
      ) {
        throw new ProtocolError("operation_result_required", 409);
      }
      if (
        providerAttempt !== null &&
        ((status === "completed" && providerAttempt.status !== "succeeded") ||
          (status === "failed" && providerAttempt.status !== "definite_reject"))
      ) {
        throw new ProtocolError("provider_attempt_outcome_required", 409);
      }
      let effectiveStatus = status;
      let effectiveResponseStatus = responseStatus;
      let effectiveResponseCode = responseCode;
      if (status === "recovery_required" && providerAttempt?.status === "prepared") {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_attempts
              SET status = 'cancelled', response_status = 503,
                  response_code = 'provider_attempt_not_dispatched',
                  terminal_at = ?1, updated_at = ?1
            WHERE operation_id = ?2 AND owner_generation = ?3
              AND attempt_generation = ?4 AND status = 'prepared'`,
          now,
          operationId,
          ownerGeneration,
          providerAttempt.attempt_generation,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("provider_attempt_outcome_conflict", 409);
        }
        effectiveStatus = "failed";
        effectiveResponseStatus = 503;
        effectiveResponseCode = "provider_attempt_not_dispatched";
      }
      if (status === "recovery_required" && providerAttempt?.status === "dispatched") {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_attempts
              SET status = 'ambiguous', response_status = 202, response_code = ?1,
                  result_object_key = ?2, result_object_version = ?3, result_sha256 = ?4,
                  result_size = ?5, result_content_type = ?6,
                  terminal_at = ?7, updated_at = ?7
            WHERE operation_id = ?8 AND owner_generation = ?9
              AND attempt_generation = ?10 AND status = 'dispatched'`,
          responseCode,
          result?.object_key ?? null,
          result?.object_version ?? null,
          result?.sha256 ?? null,
          result?.size ?? null,
          result?.content_type ?? null,
          now,
          operationId,
          ownerGeneration,
          providerAttempt.attempt_generation,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("provider_attempt_outcome_conflict", 409);
        }
      }
      if (
        status === "recovery_required" &&
        providerAttempt !== null &&
        (providerAttempt.status === "prepared" || providerAttempt.status === "dispatched")
      ) {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_provider_retry_state
              SET state = 'terminal', active_attempt_generation = NULL,
                  next_attempt_at = NULL, updated_at = ?1
            WHERE operation_id = ?2 AND owner_generation = ?3
              AND state = 'active' AND active_attempt_generation = ?4`,
          now,
          operationId,
          ownerGeneration,
          providerAttempt.attempt_generation,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("provider_retry_state_conflict", 409);
        }
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = ?1, response_status = ?2, response_code = ?3, updated_at = ?4
          WHERE operation_id = ?5 AND owner_generation = ?6 AND status = ?7${deadlineGuard}`,
        effectiveStatus,
        effectiveResponseStatus,
        effectiveResponseCode,
        now,
        operationId,
        ownerGeneration,
        expectedStatus,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("operation_completion_conflict", 409);
      }
      const row = this.readOperationOutcome(operationId);
      if (row === null) throw new ProtocolError("operation_outcome_unavailable", 503);
      return row;
    });
  }

  claimOperation(
    envelope: OperationEnvelope,
    ringAdmission: OperationRingAdmission,
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
    persistRecoveryIntentV1 = false,
  ): ClaimResult {
    this.ensureSchema();
    validatePolicy(policy);
    validateOperationRingAdmission(envelope, ringAdmission);
    return this.storage.transactionSync(() => {
      this.runMaintenance(policy, now);
      const dispatch = firstRow<DispatchRow>(
        this.storage.sql.exec<DispatchRow>(
          `SELECT dispatch_id, operation_id, envelope_sha256
             FROM cinatoken_shard_dispatches WHERE dispatch_id = ?1`,
          dispatchId,
        ),
      );
      if (
        dispatch !== null &&
        (dispatch.operation_id !== envelope.operation_id ||
          dispatch.envelope_sha256 !== envelopeSha256)
      ) {
        throw new ProtocolError("dispatch_replay_conflict", 409);
      }
      const existing = this.readOperationOutcome(envelope.operation_id);
      if (existing !== null) {
        if (
          existing.owner_generation !== envelope.owner_generation ||
          existing.envelope_sha256 !== envelopeSha256
        ) {
          throw new ProtocolError("operation_owner_conflict", 409);
        }
        if (dispatch === null) {
          this.insertDispatch(dispatchId, envelope.operation_id, envelopeSha256, now);
        }
        if (
          persistRecoveryIntentV1 &&
          (existing.status === "claimed" || existing.status === "running")
        ) {
          const operation = this.readStorageOperation(envelope.operation_id);
          if (operation === null) {
            throw new ProtocolError("operation_recovery_intent_unavailable", 503);
          }
          this.ensureOperationRecoveryIntentRow(operation, now);
        }
        return { kind: "existing", row: existing };
      }

      const existingState = this.readShardStateRow();
      if (existingState?.lifecycle_state === "draining") {
        throw new ProtocolError("shard_draining", 503);
      }

      if (ringAdmission.role === "previous_replay_only") {
        throw new ProtocolError("previous_ring_admission_closed", 409);
      }

      this.assertAndAdvanceShardFence(envelope, now, ringAdmission.transition);
      const inFlight =
        firstRow<{ count: number }>(
          this.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
              WHERE status IN ('claimed', 'running')`,
          ),
        )?.count ?? 0;
      const operationCount =
        firstRow<{ count: number }>(
          this.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cinatoken_shard_operations",
          ),
        )?.count ?? 0;
      if (
        inFlight >= policy.maxInFlight ||
        operationCount >= policy.maxTerminalOperations + policy.maxInFlight
      ) {
        return { kind: "capacity" };
      }
      this.insertDispatch(dispatchId, envelope.operation_id, envelopeSha256, now);
      this.insertOperation(envelope, envelopeSha256, dispatchId, "claimed", null, now);
      if (persistRecoveryIntentV1) {
        const operation = this.readStorageOperation(envelope.operation_id);
        if (operation === null) {
          throw new ProtocolError("operation_recovery_intent_unavailable", 503);
        }
        this.ensureOperationRecoveryIntentRow(operation, now);
      }
      return { kind: "new" };
    });
  }

  startOperationWithProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    policy: ProviderRetryPolicy,
    now: number,
  ): PrepareProviderAttemptOutcome {
    this.ensureSchema();
    validateProviderAttemptCommand(operationId, ownerGeneration, now);
    validateProviderRetryPolicy(policy);
    return this.storage.transactionSync(() => {
      const operation = this.readStorageOperation(operationId);
      if (
        operation === null ||
        operation.owner_generation !== ownerGeneration ||
        operation.operation_kind === "health_probe"
      ) {
        throw new ProtocolError("provider_attempt_not_authorized", 409);
      }
      const retryState = this.readProviderRetryState(operationId, ownerGeneration);
      const existingAttempt = this.readLatestProviderAttempt(operationId, ownerGeneration);
      if (operation.status === "running" && retryState !== null && existingAttempt !== null) {
        if (
          retryState.policy_version !== 1 ||
          retryState.max_attempts !== policy.maxAttempts ||
          retryState.retry_enabled !== (policy.retryEnabled ? 1 : 0) ||
          retryState.retry_deadline_at !== operation.deadline_at ||
          retryState.state !== "active" ||
          retryState.active_attempt_generation !== 1 ||
          retryState.last_attempt_generation !== 1 ||
          existingAttempt.attempt_generation !== 1 ||
          !matchesActiveProviderAttempt(existingAttempt.status)
        ) {
          throw new ProtocolError("provider_retry_policy_conflict", 409);
        }
        return { kind: "existing", row: existingAttempt };
      }
      if (
        operation.status !== "claimed" ||
        retryState !== null ||
        existingAttempt !== null ||
        operation.deadline_at <= now ||
        operation.owner_lease_expires_at <= now
      ) {
        throw new ProtocolError("provider_attempt_not_authorized", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = 'running', response_status = NULL, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3 AND status = 'claimed'
            AND deadline_at > ?1 AND owner_lease_expires_at > ?1`,
        now,
        operationId,
        ownerGeneration,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("operation_completion_conflict", 409);
      }
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_provider_retry_state
           (operation_id, owner_generation, policy_version, max_attempts, retry_enabled,
            state, active_attempt_generation, last_attempt_generation, schedule_generation,
            next_attempt_at, retry_deadline_at, global_terminal_event_id,
            global_terminal_acked_at, created_at, updated_at)
         VALUES (?1, ?2, 1, ?3, ?4, 'active', 1, 1, 0, NULL, ?5,
                 NULL, NULL, ?6, ?6)`,
        operationId,
        ownerGeneration,
        policy.maxAttempts,
        policy.retryEnabled ? 1 : 0,
        operation.deadline_at,
        now,
      );
      this.insertPreparedProviderAttempt(operation, 1, now);
      this.insertProviderAttemptEvent(
        operationId,
        ownerGeneration,
        1,
        1,
        null,
        "prepared",
        null,
        null,
        now,
      );
      const created = this.readProviderAttempt(operationId, ownerGeneration, 1);
      if (created === null) throw new ProtocolError("provider_attempt_unavailable", 503);
      return { kind: "prepared", row: created };
    });
  }

  transitionOperation(
    operationId: string,
    ownerGeneration: number,
    expectedStatus: OperationStatus,
    status: OperationStatus,
    responseStatus: number | null,
    now: number,
    requireBeforeDeadline = false,
  ): boolean {
    this.ensureSchema();
    const deadlineGuard = requireBeforeDeadline ? " AND deadline_at > ?3" : "";
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations SET status = ?1, response_status = ?2, updated_at = ?3
          WHERE operation_id = ?4 AND owner_generation = ?5 AND status = ?6${deadlineGuard}`,
        status,
        responseStatus,
        now,
        operationId,
        ownerGeneration,
        expectedStatus,
      );
      return changedRowCount(this.storage) === 1;
    });
  }

  expireOperation(operationId: string, ownerGeneration: number, now: number): boolean {
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = 'failed', response_status = 504,
                response_code = 'container_execution_deadline_expired', updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status = 'claimed' AND deadline_at <= ?1`,
        now,
        operationId,
        ownerGeneration,
      );
      const claimedExpired = changedRowCount(this.storage) === 1;
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_attempts
            SET status = 'cancelled', response_status = 504,
                response_code = 'provider_attempt_not_dispatched',
                terminal_at = ?1, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3 AND status = 'prepared'
            AND EXISTS (
              SELECT 1 FROM cinatoken_shard_operations AS operation
               WHERE operation.operation_id = ?2 AND operation.owner_generation = ?3
                 AND operation.status = 'running' AND operation.deadline_at <= ?1
            )`,
        now,
        operationId,
        ownerGeneration,
      );
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_attempts
            SET status = 'ambiguous', response_status = 202,
                response_code = 'provider_attempt_deadline_expired',
                result_object_key = (
                  SELECT result_object_key FROM cinatoken_shard_operations
                   WHERE operation_id = ?2 AND owner_generation = ?3
                ),
                result_object_version = (
                  SELECT result_object_version FROM cinatoken_shard_operations
                   WHERE operation_id = ?2 AND owner_generation = ?3
                ),
                result_sha256 = (
                  SELECT result_sha256 FROM cinatoken_shard_operations
                   WHERE operation_id = ?2 AND owner_generation = ?3
                ),
                result_size = (
                  SELECT result_size FROM cinatoken_shard_operations
                   WHERE operation_id = ?2 AND owner_generation = ?3
                ),
                result_content_type = (
                  SELECT result_content_type FROM cinatoken_shard_operations
                   WHERE operation_id = ?2 AND owner_generation = ?3
                ),
                terminal_at = ?1, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3 AND status = 'dispatched'
            AND EXISTS (
              SELECT 1 FROM cinatoken_shard_operations AS operation
               WHERE operation.operation_id = ?2 AND operation.owner_generation = ?3
                 AND operation.status = 'running' AND operation.deadline_at <= ?1
            )`,
        now,
        operationId,
        ownerGeneration,
      );
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_provider_retry_state
            SET state = 'terminal', active_attempt_generation = NULL,
                next_attempt_at = NULL, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND state IN ('active', 'waiting')`,
        now,
        operationId,
        ownerGeneration,
      );
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = 'recovery_required', response_status = 202,
                response_code = 'container_execution_ambiguous', updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status = 'running' AND deadline_at <= ?1
            AND EXISTS (
              SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
               WHERE attempt.operation_id = ?2 AND attempt.owner_generation = ?3
                 AND attempt.status = 'ambiguous'
            )`,
        now,
        operationId,
        ownerGeneration,
      );
      const ambiguousExpired = changedRowCount(this.storage) === 1;
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = 'failed', response_status = 504,
                response_code = 'provider_attempt_not_dispatched', updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status = 'running' AND deadline_at <= ?1
            AND EXISTS (
              SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
               WHERE attempt.operation_id = ?2 AND attempt.owner_generation = ?3
                 AND attempt.status = 'cancelled'
            )`,
        now,
        operationId,
        ownerGeneration,
      );
      const cancelledExpired = changedRowCount(this.storage) === 1;
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = 'recovery_required', response_status = 202,
                response_code = 'container_execution_ambiguous', updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status = 'running' AND deadline_at <= ?1`,
        now,
        operationId,
        ownerGeneration,
      );
      return (
        claimedExpired ||
        ambiguousExpired ||
        cancelledExpired ||
        changedRowCount(this.storage) === 1
      );
    });
  }

  ensureOperationRecoveryIntent(
    envelope: OperationEnvelope,
    now: number,
  ): OperationRecoveryIntent {
    this.ensureSchema();
    validateOperationRecoveryNow(now);
    buildRelayShardAlarmIntentV1(
      envelope.operation_id,
      envelope.owner_generation,
      envelope.execution_deadline_at,
      1,
      envelope.shard,
    );
    return this.storage.transactionSync(() => {
      const operation = this.readStorageOperation(envelope.operation_id);
      if (
        operation === null ||
        operation.owner_generation !== envelope.owner_generation ||
        operation.deadline_at !== envelope.execution_deadline_at ||
        !operationShardsEqual(storageOperationShard(operation), envelope.shard)
      ) {
        throw new ProtocolError("operation_recovery_intent_conflict", 409);
      }
      return this.ensureOperationRecoveryIntentRow(operation, now);
    });
  }

  readOperationRecoveryIntent(
    operationId: string,
    ownerGeneration: number,
  ): OperationRecoveryIntent | null {
    this.ensureSchema();
    validateOperationRecoveryIdentity(operationId, ownerGeneration);
    return this.readOperationRecoveryIntentRow(operationId, ownerGeneration);
  }

  listUnarmedOperationRecoveryIntents(limit = 64): OperationRecoveryIntent[] {
    this.ensureSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new ProtocolError("invalid_operation_recovery_intent_limit", 500);
    }
    const rows = this.storage.sql
      .exec<OperationRecoveryIntent>(
        `SELECT payload_version, intent_kind, operation_id, owner_generation, deadline_at,
                delivery_generation, delivery_count, state, armed_at, next_delivery_at,
                last_error_code, shard_contract_version, ring_generation, shard_count,
                shard_index, instance_name, created_at, updated_at
           FROM cinatoken_shard_alarm_intents
          WHERE state = 'pending' AND armed_at IS NULL
          ORDER BY next_delivery_at ASC, operation_id ASC
          LIMIT ?1`,
        limit,
      )
      .toArray();
    for (const row of rows) validateOperationRecoveryIntentRow(row);
    return rows;
  }

  markOperationRecoveryIntentArmed(
    payloadValue: RelayShardAlarmIntentV1,
    now: number,
  ): boolean {
    this.ensureSchema();
    const payload = validateOperationRecoveryIntentPayload(payloadValue);
    validateOperationRecoveryNow(now);
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_alarm_intents
            SET armed_at = ?1, updated_at = MAX(updated_at, ?1)
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND delivery_generation = ?4 AND state = 'pending'
            AND armed_at IS NULL
            AND payload_version = ?5 AND intent_kind = ?6
            AND deadline_at = ?7
            AND shard_contract_version = ?8 AND ring_generation = ?9
            AND shard_count = ?10 AND shard_index = ?11 AND instance_name = ?12`,
        now,
        payload.operation_id,
        payload.owner_generation,
        payload.delivery_generation,
        payload.payload_version,
        payload.kind,
        payload.deadline_at,
        payload.shard.contract_version,
        payload.shard.ring_generation,
        payload.shard.shard_count,
        payload.shard.shard_index,
        payload.shard.instance_name,
      );
      if (changedRowCount(this.storage) === 1) return true;
      const current = this.readOperationRecoveryIntentRow(
        payload.operation_id,
        payload.owner_generation,
      );
      return (
        current !== null &&
        current.state === "pending" &&
        current.delivery_generation === payload.delivery_generation &&
        current.armed_at !== null &&
        operationRecoveryIntentMatchesPayload(current, payload)
      );
    });
  }

  reconcileOperationRecoveryIntent(
    payloadValue: RelayShardAlarmIntentV1,
    now: number,
  ): OperationRecoveryIntentOutcome {
    this.ensureSchema();
    const payload = validateOperationRecoveryIntentPayload(payloadValue);
    validateOperationRecoveryNow(now);
    const preflight: OperationRecoveryIntentOutcome | "expire" =
      this.storage.transactionSync(() => {
        const intent = this.readOperationRecoveryIntentRow(
          payload.operation_id,
          payload.owner_generation,
        );
        if (intent === null) return "stale";
        if (intent.state === "completed") return "duplicate";
        if (intent.state === "quarantined") return "quarantined";
        if (intent.delivery_generation !== payload.delivery_generation) return "stale";
        if (!operationRecoveryIntentMatchesPayload(intent, payload)) {
          this.quarantineOperationRecoveryIntentRow(
            intent,
            now,
            "operation_recovery_payload_mismatch",
            Math.max(intent.delivery_count, payload.delivery_generation),
          );
          return "quarantined";
        }
        const operation = this.readStorageOperation(payload.operation_id);
        if (
          operation === null ||
          operation.owner_generation !== payload.owner_generation ||
          operation.deadline_at !== payload.deadline_at ||
          !operationShardsEqual(storageOperationShard(operation), payload.shard)
        ) {
          this.quarantineOperationRecoveryIntentRow(
            intent,
            now,
            "operation_recovery_operation_mismatch",
            Math.max(intent.delivery_count, payload.delivery_generation),
          );
          return "quarantined";
        }
        const deliveredCount = Math.max(
          intent.delivery_count,
          payload.delivery_generation,
        );
        if (isTerminalOperationStatus(operation.status)) {
          this.completeOperationRecoveryIntentRow(intent, deliveredCount, now);
          return "duplicate";
        }
        if (payload.deadline_at > now) {
          if (deliveredCount >= RELAY_SHARD_ALARM_MAX_DELIVERIES) {
            this.quarantineOperationRecoveryIntentRow(
              intent,
              now,
              "operation_recovery_delivery_exhausted",
              deliveredCount,
            );
            return "quarantined";
          }
          this.storage.sql.exec(
            `UPDATE cinatoken_shard_alarm_intents
                SET delivery_generation = ?1, delivery_count = ?2, armed_at = NULL,
                    next_delivery_at = ?3, last_error_code = NULL,
                    updated_at = MAX(updated_at, ?4)
              WHERE operation_id = ?5 AND owner_generation = ?6
                AND state = 'pending' AND delivery_generation = ?7`,
            payload.delivery_generation + 1,
            deliveredCount,
            payload.deadline_at + 1,
            now,
            payload.operation_id,
            payload.owner_generation,
            payload.delivery_generation,
          );
          if (changedRowCount(this.storage) !== 1) {
            throw new ProtocolError("operation_recovery_intent_conflict", 409);
          }
          return "not_due";
        }
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_alarm_intents
              SET delivery_count = ?1, armed_at = NULL, updated_at = MAX(updated_at, ?2)
            WHERE operation_id = ?3 AND owner_generation = ?4
              AND state = 'pending' AND delivery_generation = ?5`,
          deliveredCount,
          now,
          payload.operation_id,
          payload.owner_generation,
          payload.delivery_generation,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("operation_recovery_intent_conflict", 409);
        }
        return "expire";
      });
    if (preflight !== "expire") return preflight;

    this.expireOperation(payload.operation_id, payload.owner_generation, now);
    return this.storage.transactionSync(() => {
      const intent = this.readOperationRecoveryIntentRow(
        payload.operation_id,
        payload.owner_generation,
      );
      if (intent === null) return "stale";
      if (intent.state === "completed") return "completed";
      if (intent.state === "quarantined") return "quarantined";
      if (intent.delivery_generation !== payload.delivery_generation) return "stale";
      const operation = this.readStorageOperation(payload.operation_id);
      if (operation !== null && isTerminalOperationStatus(operation.status)) {
        this.completeOperationRecoveryIntentRow(intent, intent.delivery_count, now);
        return "completed";
      }
      throw new ProtocolError("operation_recovery_reconcile_incomplete", 503);
    });
  }

  retryOperationRecoveryIntent(
    payloadValue: RelayShardAlarmIntentV1,
    now: number,
    errorCode: string,
  ): OperationRecoveryIntent | null {
    this.ensureSchema();
    const payload = validateOperationRecoveryIntentPayload(payloadValue);
    validateOperationRecoveryNow(now);
    validateOperationRecoveryErrorCode(errorCode);
    return this.storage.transactionSync(() => {
      const intent = this.readOperationRecoveryIntentRow(
        payload.operation_id,
        payload.owner_generation,
      );
      if (
        intent === null ||
        intent.state !== "pending" ||
        intent.delivery_generation !== payload.delivery_generation
      ) {
        return null;
      }
      if (!operationRecoveryIntentMatchesPayload(intent, payload)) {
        this.quarantineOperationRecoveryIntentRow(
          intent,
          now,
          "operation_recovery_payload_mismatch",
        );
        return null;
      }
      const deliveredCount = Math.max(
        intent.delivery_count,
        payload.delivery_generation,
      );
      const retryAt = relayShardAlarmRetryAt(
        payload.operation_id,
        deliveredCount,
        now,
        payload.deadline_at,
      );
      if (retryAt === null) {
        this.quarantineOperationRecoveryIntentRow(
          intent,
          now,
          errorCode,
          deliveredCount,
        );
        return null;
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_alarm_intents
            SET delivery_generation = ?1, delivery_count = ?2, armed_at = NULL,
                next_delivery_at = ?3, last_error_code = ?4,
                updated_at = MAX(updated_at, ?5)
          WHERE operation_id = ?6 AND owner_generation = ?7
            AND state = 'pending' AND delivery_generation = ?8`,
        payload.delivery_generation + 1,
        deliveredCount,
        retryAt,
        errorCode,
        now,
        payload.operation_id,
        payload.owner_generation,
        payload.delivery_generation,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("operation_recovery_intent_conflict", 409);
      }
      const next = this.readOperationRecoveryIntentRow(
        payload.operation_id,
        payload.owner_generation,
      );
      if (next === null) {
        throw new ProtocolError("operation_recovery_intent_unavailable", 503);
      }
      return next;
    });
  }

  quarantineOperationRecoveryIntent(
    payloadValue: RelayShardAlarmIntentV1,
    now: number,
    errorCode: string,
  ): boolean {
    this.ensureSchema();
    const payload = validateOperationRecoveryIntentPayload(payloadValue);
    validateOperationRecoveryNow(now);
    validateOperationRecoveryErrorCode(errorCode);
    return this.storage.transactionSync(() => {
      const intent = this.readOperationRecoveryIntentRow(
        payload.operation_id,
        payload.owner_generation,
      );
      if (
        intent === null ||
        intent.state !== "pending" ||
        intent.delivery_generation !== payload.delivery_generation ||
        !operationRecoveryIntentMatchesPayload(intent, payload)
      ) {
        return false;
      }
      this.quarantineOperationRecoveryIntentRow(intent, now, errorCode);
      return true;
    });
  }

  recordLifecycle(state: string, detail: string | null, now: number): void {
    this.ensureSchema();
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_state SET lifecycle_state = ?1, lifecycle_detail = ?2, updated_at = ?3
        WHERE singleton = 1`,
      state,
      detail,
      now,
    );
  }

  initializeShardForReadiness(
    shard: OperationShard,
    now: number,
    ringTransition: ConfiguredRingTransition | null = null,
  ): void {
    this.ensureSchema();
    validateConfiguredRingTransition(ringTransition);
    this.storage.transactionSync(() => {
      const state = this.readShardStateRow();
      if (state !== null) {
        this.assertAndAdvanceReadinessFence(state, shard, now, ringTransition);
        return;
      }
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_state
           (singleton, instance_name, contract_version, ring_generation, shard_count, shard_index,
            lifecycle_state, lifecycle_detail, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, 'idle', NULL, ?6)`,
        shard.instance_name,
        shard.contract_version,
        shard.ring_generation,
        shard.shard_count,
        shard.shard_index,
        now,
      );
    });
  }

  async beginOrReplayReadinessProbe(
    shard: OperationShard,
    probeId: string,
    claimDigestSha256: string,
    nowMs: number,
    deadlineAtMs: number | null,
    allowWake: boolean,
  ): Promise<BeginOrReplayReadinessProbeOutcome> {
    this.ensureSchema();
    validateReadinessProbeJournalIdentity(probeId, claimDigestSha256, nowMs);
    if (typeof allowWake !== "boolean") {
      throw new ProtocolError("invalid_readiness_probe_journal", 400);
    }
    if (allowWake) {
      validateReadinessProbeWakeDeadline(nowMs, deadlineAtMs);
    } else if (deadlineAtMs !== null) {
      throw new ProtocolError("invalid_readiness_probe_journal", 400);
    }

    const outcome = this.storage.transactionSync<ReadinessProbeJournalTransactionOutcome>(() => {
      const state = this.readShardStateRow();
      if (state === null) throw new ProtocolError("shard_not_initialized", 409);
      assertShardStateMatches(state, shard);

      const existing = this.readReadinessProbeJournalRow(probeId);
      if (existing !== null) {
        if (existing.claim_digest_sha256 !== claimDigestSha256) {
          throw new ProtocolError("readiness_probe_claim_mismatch", 409);
        }
        if (existing.state === "completed") {
          return { kind: "completed_row", row: existing };
        }
        if (existing.state === "ambiguous") {
          throw new ProtocolError("readiness_probe_ambiguous", 409);
        }
        if (existing.deadline_at_ms > nowMs) {
          throw new ProtocolError("readiness_probe_in_progress", 409);
        }

        const ambiguousAtMs = Math.min(
          Math.max(nowMs, existing.deadline_at_ms),
          existing.retention_until_ms,
        );
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_readiness_probe_journal
              SET state = 'ambiguous', ambiguous_at_ms = ?1
            WHERE probe_id = ?2
              AND claim_digest_sha256 = ?3
              AND generation = ?4
              AND state = 'started'
              AND started_at_ms = ?5
              AND deadline_at_ms = ?6
              AND deadline_at_ms <= ?7`,
          ambiguousAtMs,
          probeId,
          claimDigestSha256,
          existing.generation,
          existing.started_at_ms,
          existing.deadline_at_ms,
          nowMs,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("readiness_probe_superseded", 409);
        }
        this.recordReadinessProbeAmbiguousSummary(existing, ambiguousAtMs);
        return { kind: "ambiguous" };
      }

      if (!allowWake) {
        throw new ProtocolError("readiness_probe_missing", 503);
      }
      if (state.lifecycle_state === "draining") {
        throw new ProtocolError("shard_draining", 503);
      }
      this.maintainReadinessProbeJournal();

      const legacyGeneration = this.readReadinessRow()?.probe_generation ?? 0;
      const journalGeneration =
        firstRow<{ generation: number | null }>(
          this.storage.sql.exec<{ generation: number | null }>(
            `SELECT MAX(generation) AS generation
               FROM cinatoken_shard_readiness_probe_journal`,
          ),
        )?.generation ?? 0;
      const generation = Math.max(legacyGeneration, journalGeneration) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new ProtocolError("readiness_probe_generation_exhausted", 503);
      }
      const wakeDeadlineAtMs = deadlineAtMs as number;
      const retentionUntilMs =
        wakeDeadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS;
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_readiness_probe_journal
           (probe_id, claim_digest_sha256, generation, state, started_at_ms,
            deadline_at_ms, retention_until_ms, completed_at_ms, ambiguous_at_ms,
            result_json, result_sha256, result_size_bytes)
         VALUES (?1, ?2, ?3, 'started', ?4, ?5, ?6, NULL, NULL, NULL, NULL, NULL)`,
        probeId,
        claimDigestSha256,
        generation,
        nowMs,
        wakeDeadlineAtMs,
        retentionUntilMs,
      );
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_readiness
           (singleton, probe_generation, phase, last_probe_id, started_at_ms, deadline_at_ms,
            completed_at_ms, result_code, container_status, container_last_change_ms,
            container_exit_code, runtime_protocol_version, runtime_contract_version,
            runtime_build_id, runtime_execution_enabled, process_ready, execution_ready)
         VALUES (1, ?1, 'probing', ?2, ?3, ?4,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
         ON CONFLICT(singleton) DO UPDATE SET
           probe_generation = excluded.probe_generation,
           phase = excluded.phase,
           last_probe_id = excluded.last_probe_id,
           started_at_ms = excluded.started_at_ms,
           deadline_at_ms = excluded.deadline_at_ms,
           completed_at_ms = NULL,
           result_code = NULL,
           container_status = NULL,
           container_last_change_ms = NULL,
           container_exit_code = NULL,
           runtime_protocol_version = NULL,
           runtime_contract_version = NULL,
           runtime_build_id = NULL,
           runtime_execution_enabled = NULL,
           process_ready = NULL,
           execution_ready = NULL`,
        generation,
        probeId,
        nowMs,
        wakeDeadlineAtMs,
      );
      return {
        kind: "wake",
        probeId,
        claimDigestSha256,
        generation,
        startedAtMs: nowMs,
        deadlineAtMs: wakeDeadlineAtMs,
        retentionUntilMs,
      };
    });

    if (outcome.kind === "ambiguous") {
      throw new ProtocolError("readiness_probe_ambiguous", 409);
    }
    if (outcome.kind === "completed_row") {
      return readinessProbeJournalCompletedReplay(outcome.row);
    }
    return outcome;
  }

  async replayReadinessProbeJournal(
    shard: OperationShard,
    probeId: string,
    claimDigestSha256: string,
    nowMs: number,
  ): Promise<ReadinessProbeCompletedReplay> {
    const replay = await this.beginOrReplayReadinessProbe(
      shard,
      probeId,
      claimDigestSha256,
      nowMs,
      null,
      false,
    );
    if (replay.kind !== "completed") {
      throw new ProtocolError("readiness_probe_missing", 503);
    }
    return replay;
  }

  async completeReadinessProbeJournal(
    shard: OperationShard,
    permit: ReadinessProbeWakePermit,
    completedAtMs: number,
    completion: ReadinessProbeJournalCompletion,
  ): Promise<ReadinessProbeCompletedReplay> {
    this.ensureSchema();
    validateReadinessProbeWakePermit(permit, completedAtMs);
    validateReadinessJournalCompletion(completion, permit, completedAtMs);
    const resultSizeBytes = new TextEncoder().encode(completion.resultJson).byteLength;
    const computedResultSha256 = await sha256Utf8(completion.resultJson);
    if (computedResultSha256 !== completion.resultSha256) {
      throw new ProtocolError("invalid_readiness_probe_result", 400);
    }

    const outcome = this.storage.transactionSync<ReadinessProbeJournalTransactionOutcome>(() => {
      const state = this.readShardStateRow();
      if (state === null) throw new ProtocolError("shard_not_initialized", 409);
      assertShardStateMatches(state, shard);
      const existing = this.readReadinessProbeJournalRow(permit.probeId);
      if (existing === null) {
        throw new ProtocolError("readiness_probe_missing", 503);
      }
      if (existing.claim_digest_sha256 !== permit.claimDigestSha256) {
        throw new ProtocolError("readiness_probe_claim_mismatch", 409);
      }
      if (
        existing.generation !== permit.generation ||
        existing.started_at_ms !== permit.startedAtMs ||
        existing.deadline_at_ms !== permit.deadlineAtMs ||
        existing.retention_until_ms !== permit.retentionUntilMs
      ) {
        throw new ProtocolError("readiness_probe_superseded", 409);
      }
      if (existing.state === "completed") {
        return { kind: "completed_row", row: existing };
      }
      if (existing.state === "ambiguous") {
        throw new ProtocolError("readiness_probe_ambiguous", 409);
      }
      if (completedAtMs > existing.deadline_at_ms) {
        const ambiguousAtMs = Math.min(
          completedAtMs,
          existing.retention_until_ms,
        );
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_readiness_probe_journal
              SET state = 'ambiguous', ambiguous_at_ms = ?1
            WHERE probe_id = ?2
              AND claim_digest_sha256 = ?3
              AND generation = ?4
              AND state = 'started'
              AND started_at_ms = ?5
              AND deadline_at_ms = ?6`,
          ambiguousAtMs,
          permit.probeId,
          permit.claimDigestSha256,
          permit.generation,
          permit.startedAtMs,
          permit.deadlineAtMs,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("readiness_probe_superseded", 409);
        }
        this.recordReadinessProbeAmbiguousSummary(existing, ambiguousAtMs);
        return { kind: "ambiguous" };
      }

      this.storage.sql.exec(
        `UPDATE cinatoken_shard_readiness_probe_journal
            SET state = 'completed', completed_at_ms = ?1,
                result_json = ?2, result_sha256 = ?3, result_size_bytes = ?4
          WHERE probe_id = ?5
            AND claim_digest_sha256 = ?6
            AND generation = ?7
            AND state = 'started'
            AND started_at_ms = ?8
            AND deadline_at_ms = ?9
            AND retention_until_ms = ?10`,
        completedAtMs,
        completion.resultJson,
        completion.resultSha256,
        resultSizeBytes,
        permit.probeId,
        permit.claimDigestSha256,
        permit.generation,
        permit.startedAtMs,
        permit.deadlineAtMs,
        permit.retentionUntilMs,
      );
      if (changedRowCount(this.storage) !== 1) {
        throw new ProtocolError("readiness_probe_superseded", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_readiness
            SET phase = 'complete', completed_at_ms = ?1, result_code = ?2,
                container_status = ?3, container_last_change_ms = ?4,
                container_exit_code = ?5, runtime_protocol_version = ?6,
                runtime_contract_version = ?7, runtime_build_id = ?8,
                runtime_execution_enabled = ?9, process_ready = ?10,
                execution_ready = ?11,
                last_ready_at_ms = CASE WHEN ?10 = 1 THEN ?1 ELSE last_ready_at_ms END
          WHERE singleton = 1
            AND probe_generation = ?12
            AND last_probe_id = ?13
            AND started_at_ms = ?14
            AND phase = 'probing'`,
        completedAtMs,
        completion.resultCode,
        completion.containerStatus,
        completion.containerLastChangeMs,
        completion.containerExitCode,
        completion.runtimeProtocolVersion,
        completion.runtimeContractVersion,
        completion.runtimeBuildId,
        completion.runtimeExecutionEnabled === null
          ? null
          : completion.runtimeExecutionEnabled
            ? 1
            : 0,
        completion.processReady ? 1 : 0,
        completion.executionReady ? 1 : 0,
        permit.generation,
        permit.probeId,
        permit.startedAtMs,
      );
      const row = this.readReadinessProbeJournalRow(permit.probeId);
      if (row === null || row.state !== "completed") {
        throw new ProtocolError("readiness_probe_result_corrupt", 500);
      }
      return { kind: "completed_row", row };
    });

    if (outcome.kind === "ambiguous") {
      throw new ProtocolError("readiness_probe_ambiguous", 409);
    }
    if (outcome.kind !== "completed_row") {
      throw new ProtocolError("readiness_probe_superseded", 409);
    }
    const replay = await readinessProbeJournalCompletedReplay(outcome.row);
    if (
      replay.completedAtMs !== completedAtMs ||
      replay.resultJson !== completion.resultJson ||
      replay.resultSha256 !== completion.resultSha256
    ) {
      throw new ProtocolError("readiness_probe_completion_conflict", 409);
    }
    return replay;
  }

  recoverReadinessProbe(
    shard: OperationShard,
    probeId: string,
    nowMs: number,
  ): ReadinessProbeReplay | null {
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      const state = this.readShardStateRow();
      if (state === null) throw new ProtocolError("shard_not_initialized", 409);
      assertShardStateMatches(state, shard);
      const dispatch = firstRow<{ dispatch_id: string }>(
        this.storage.sql.exec<{ dispatch_id: string }>(
          `SELECT dispatch_id FROM cinatoken_shard_readiness_dispatches WHERE dispatch_id = ?1`,
          probeId,
        ),
      );
      if (dispatch === null) return null;

      let row = this.readReadinessRow();
      if (row === null || row.last_probe_id !== probeId) {
        throw new ProtocolError("readiness_probe_replay", 409);
      }
      if (row.phase === "probing") {
        if (row.deadline_at_ms > nowMs) {
          throw new ProtocolError("readiness_probe_in_progress", 409);
        }
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_readiness
              SET phase = 'complete', completed_at_ms = deadline_at_ms,
                  result_code = 'container_readiness_timeout', container_status = NULL,
                  container_last_change_ms = NULL, container_exit_code = NULL,
                  runtime_protocol_version = NULL, runtime_contract_version = NULL,
                  runtime_build_id = NULL, runtime_execution_enabled = NULL,
                  process_ready = 0, execution_ready = 0
            WHERE singleton = 1 AND last_probe_id = ?1 AND phase = 'probing'
              AND deadline_at_ms <= ?2`,
          probeId,
          nowMs,
        );
        if (changedRowCount(this.storage) !== 1) {
          throw new ProtocolError("readiness_probe_in_progress", 409);
        }
        row = this.readReadinessRow();
      }
      if (row === null) throw new ProtocolError("readiness_probe_replay", 409);
      return readinessProbeReplay(row);
    });
  }

  beginReadinessProbe(
    shard: OperationShard,
    probeId: string,
    nowMs: number,
    deadlineAtMs: number,
    cooldownMs: number,
  ): number {
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      const state = this.readShardStateRow();
      if (state === null) throw new ProtocolError("shard_not_initialized", 409);
      assertShardStateMatches(state, shard);
      if (state.lifecycle_state === "draining") {
        throw new ProtocolError("shard_draining", 503);
      }
      this.storage.sql.exec(
        `DELETE FROM cinatoken_shard_readiness_dispatches WHERE created_at_ms < ?1`,
        nowMs - DISPATCH_REPLAY_RETENTION_SECONDS * 1000,
      );
      const replay = firstRow<{ dispatch_id: string }>(
        this.storage.sql.exec<{ dispatch_id: string }>(
          `SELECT dispatch_id FROM cinatoken_shard_readiness_dispatches WHERE dispatch_id = ?1`,
          probeId,
        ),
      );
      if (replay !== null) throw new ProtocolError("readiness_probe_replay", 409);
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_readiness_dispatches (dispatch_id, created_at_ms)
         VALUES (?1, ?2)`,
        probeId,
        nowMs,
      );
      const previous = this.readReadinessRow();
      if (previous?.phase === "probing" && previous.deadline_at_ms > nowMs) {
        throw new ProtocolError("readiness_probe_in_progress", 409);
      }
      if (
        previous?.completed_at_ms !== null &&
        previous?.completed_at_ms !== undefined &&
        previous.completed_at_ms + cooldownMs > nowMs
      ) {
        throw new ProtocolError("readiness_probe_cooldown", 429);
      }
      const generation = (previous?.probe_generation ?? 0) + 1;
      if (previous === null) {
        this.storage.sql.exec(
          `INSERT INTO cinatoken_shard_readiness
             (singleton, probe_generation, phase, last_probe_id, started_at_ms, deadline_at_ms,
              completed_at_ms, result_code, container_status, container_last_change_ms,
              container_exit_code, runtime_protocol_version, runtime_contract_version,
              runtime_execution_enabled, last_ready_at_ms)
           VALUES (1, ?1, 'probing', ?2, ?3, ?4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
          generation,
          probeId,
          nowMs,
          deadlineAtMs,
        );
      } else {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_readiness
              SET probe_generation = ?1, phase = 'probing', last_probe_id = ?2,
                  started_at_ms = ?3, deadline_at_ms = ?4, completed_at_ms = NULL,
                   result_code = NULL, container_status = NULL, container_last_change_ms = NULL,
                   container_exit_code = NULL, runtime_protocol_version = NULL,
                   runtime_contract_version = NULL, runtime_build_id = NULL,
                   runtime_execution_enabled = NULL, process_ready = NULL,
                   execution_ready = NULL
            WHERE singleton = 1`,
          generation,
          probeId,
          nowMs,
          deadlineAtMs,
        );
      }
      return generation;
    });
  }

  completeReadinessProbe(
    generation: number,
    completedAtMs: number,
    completion: ReadinessCompletion,
  ): boolean {
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_readiness
            SET phase = 'complete', completed_at_ms = ?1, result_code = ?2,
                container_status = ?3, container_last_change_ms = ?4, container_exit_code = ?5,
                runtime_protocol_version = ?6, runtime_contract_version = ?7,
                runtime_build_id = ?8, runtime_execution_enabled = ?9,
                process_ready = ?10, execution_ready = ?11,
                last_ready_at_ms = CASE WHEN ?10 = 1 THEN ?1 ELSE last_ready_at_ms END
          WHERE singleton = 1 AND probe_generation = ?12 AND phase = 'probing'`,
        completedAtMs,
        completion.resultCode,
        completion.containerStatus,
        completion.containerLastChangeMs,
        completion.containerExitCode,
        completion.runtimeProtocolVersion,
        completion.runtimeContractVersion,
        completion.runtimeBuildId,
        completion.runtimeExecutionEnabled === null
          ? null
          : completion.runtimeExecutionEnabled
            ? 1
            : 0,
        completion.processReady ? 1 : 0,
        completion.executionReady ? 1 : 0,
        generation,
      );
      return changedRowCount(this.storage) === 1;
    });
  }

  readShardReadiness(shard: OperationShard, now: number): ShardReadinessSnapshot {
    this.ensureSchema();
    const state = this.readShardStateRow();
    if (state !== null) assertShardStateMatches(state, shard);
    const activeInFlight =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running') AND deadline_at > ?1`,
          now,
        ),
      )?.count ?? 0;
    const expiredInFlight =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running') AND deadline_at <= ?1`,
          now,
        ),
      )?.count ?? 0;
    const terminal =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN (${TERMINAL_STATUS_SQL})`,
        ),
      )?.count ?? 0;
    return {
      initialized: state !== null,
      lifecycle_state: state?.lifecycle_state ?? null,
      lifecycle_detail: state?.lifecycle_detail ?? null,
      lifecycle_updated_at: state?.updated_at ?? null,
      active_in_flight_operations: activeInFlight,
      expired_in_flight_operations: expiredInFlight,
      terminal_operations: terminal,
      readiness: readinessSnapshot(this.readReadinessRow()),
    };
  }

  private runMaintenance(policy: RelayShardLedgerPolicy, now: number): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'failed', response_status = 504,
              response_code = 'container_execution_deadline_expired', updated_at = ?1
        WHERE status = 'claimed' AND deadline_at <= ?1`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_provider_attempts
          SET status = 'cancelled', response_status = 504,
              response_code = 'provider_attempt_not_dispatched',
              terminal_at = ?1, updated_at = ?1
        WHERE status = 'prepared'
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_operations AS operation
             WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
               AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
               AND operation.status = 'running' AND operation.deadline_at <= ?1
          )`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_provider_attempts
          SET status = 'ambiguous', response_status = 202,
              response_code = 'provider_attempt_deadline_expired',
              result_object_key = (
                SELECT operation.result_object_key FROM cinatoken_shard_operations AS operation
                 WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
                   AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
              ),
              result_object_version = (
                SELECT operation.result_object_version FROM cinatoken_shard_operations AS operation
                 WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
                   AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
              ),
              result_sha256 = (
                SELECT operation.result_sha256 FROM cinatoken_shard_operations AS operation
                 WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
                   AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
              ),
              result_size = (
                SELECT operation.result_size FROM cinatoken_shard_operations AS operation
                 WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
                   AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
              ),
              result_content_type = (
                SELECT operation.result_content_type FROM cinatoken_shard_operations AS operation
                 WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
                   AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
              ),
              terminal_at = ?1, updated_at = ?1
        WHERE status = 'dispatched'
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_operations AS operation
             WHERE operation.operation_id = cinatoken_shard_provider_attempts.operation_id
               AND operation.owner_generation = cinatoken_shard_provider_attempts.owner_generation
               AND operation.status = 'running' AND operation.deadline_at <= ?1
          )`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_provider_retry_state
          SET state = 'terminal', active_attempt_generation = NULL,
              next_attempt_at = NULL, updated_at = ?1
        WHERE state IN ('active', 'waiting')
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_operations AS operation
             WHERE operation.operation_id = cinatoken_shard_provider_retry_state.operation_id
               AND operation.owner_generation = cinatoken_shard_provider_retry_state.owner_generation
               AND operation.status = 'running' AND operation.deadline_at <= ?1
          )`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'recovery_required', response_status = 202,
              response_code = 'container_execution_ambiguous', updated_at = ?1
        WHERE status = 'running' AND deadline_at <= ?1
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
             WHERE attempt.operation_id = cinatoken_shard_operations.operation_id
               AND attempt.owner_generation = cinatoken_shard_operations.owner_generation
               AND attempt.status = 'ambiguous'
          )`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'failed', response_status = 504,
              response_code = 'provider_attempt_not_dispatched', updated_at = ?1
        WHERE status = 'running' AND deadline_at <= ?1
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
             WHERE attempt.operation_id = cinatoken_shard_operations.operation_id
               AND attempt.owner_generation = cinatoken_shard_operations.owner_generation
               AND attempt.status = 'cancelled'
          )`,
      now,
    );
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'recovery_required', response_status = 202,
              response_code = 'container_execution_ambiguous', updated_at = ?1
        WHERE status = 'running' AND deadline_at <= ?1`,
      now,
    );
    this.storage.sql.exec(
      `DELETE FROM cinatoken_shard_dispatches WHERE created_at < ?1`,
      now - policy.dispatchRetentionSeconds,
    );
    if (!policy.globalTerminalCompactionEnabled) return;
    this.storage.sql.exec(
      `DELETE FROM cinatoken_shard_operations
        WHERE status IN (${TERMINAL_STATUS_SQL}) AND updated_at < ?1
          AND NOT EXISTS (
            SELECT 1 FROM cinatoken_shard_dispatches AS dispatch
              WHERE dispatch.operation_id = cinatoken_shard_operations.operation_id
                AND dispatch.created_at >= ?2
          )
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_terminal_acks AS ack
              WHERE ack.operation_id = cinatoken_shard_operations.operation_id
                AND ack.owner_generation = cinatoken_shard_operations.owner_generation
                AND ack.final_acked_at IS NOT NULL
                AND ack.compaction_authorized_at IS NOT NULL
          )`,
      now - policy.terminalRetentionSeconds,
      now - policy.dispatchRetentionSeconds,
    );
    const terminalCount =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN (${TERMINAL_STATUS_SQL})`,
        ),
      )?.count ?? 0;
    const excess = terminalCount - policy.maxTerminalOperations;
    if (excess <= 0) return;
    this.storage.sql.exec(
      `DELETE FROM cinatoken_shard_operations
        WHERE operation_id IN (
          SELECT operation_id FROM cinatoken_shard_operations
            WHERE status IN (${TERMINAL_STATUS_SQL}) AND updated_at < ?1
              AND NOT EXISTS (
                SELECT 1 FROM cinatoken_shard_dispatches AS dispatch
                  WHERE dispatch.operation_id = cinatoken_shard_operations.operation_id
                    AND dispatch.created_at >= ?1
              )
              AND EXISTS (
                SELECT 1 FROM cinatoken_shard_terminal_acks AS ack
                  WHERE ack.operation_id = cinatoken_shard_operations.operation_id
                    AND ack.owner_generation = cinatoken_shard_operations.owner_generation
                    AND ack.final_acked_at IS NOT NULL
                    AND ack.compaction_authorized_at IS NOT NULL
              )
            ORDER BY updated_at ASC, operation_id ASC
            LIMIT ?2
        )`,
      now - policy.dispatchRetentionSeconds,
      excess,
    );
  }

  private validateShardSchemaMigrations(allowedPendingTail = 0): void {
    const rows = this.storage.sql
      .exec<{ schema_version: number; migration_name: string }>(
        `SELECT schema_version, migration_name
           FROM cinatoken_shard_schema_migrations
          ORDER BY schema_version ASC`,
      )
      .toArray();
    const expected = [
      { schema_version: 1, migration_name: "0001_legacy_schema_observed" },
      {
        schema_version: 2,
        migration_name: "0002_operation_deadline_alarm_intent_v1",
      },
      {
        schema_version: 3,
        migration_name: "0003_provider_response_artifact_attachment_v1",
      },
      {
        schema_version: 4,
        migration_name: "0004_terminal_ack_v3_convergence",
      },
      {
        schema_version: 5,
        migration_name: "0005_readiness_probe_recovery_v1",
      },
      {
        schema_version: 6,
        migration_name: "0006_readiness_probe_at_most_once_journal_v1",
      },
    ];
    const minimumExpectedLength = expected.length - allowedPendingTail;
    if (
      rows.length < minimumExpectedLength ||
      rows.length > expected.length ||
      rows.some(
        (row, index) =>
          row.schema_version !== expected[index]?.schema_version ||
          row.migration_name !== expected[index]?.migration_name,
      )
    ) {
      throw new ProtocolError("shard_schema_migration_conflict", 500);
    }
  }

  private validateProviderResponseAttachmentSchema(): void {
    const expectedColumns = new Map<string, readonly string[]>([
      [
        "cinatoken_shard_provider_response_attachments",
        [
          "operation_id",
          "owner_generation",
          "attempt_generation",
          "provider_operation_id",
          "admission_sha256",
          "request_sha256",
          "egress_profile",
          "egress_worker_version_id",
          "status",
          "provider_status",
          "client_status",
          "response_class",
          "response_code",
          "provider_response_evidence_sha256",
          "raw_object_key",
          "raw_object_version",
          "raw_sha256",
          "raw_size",
          "raw_content_type",
          "client_response_artifact_sha256",
          "client_object_key",
          "client_object_version",
          "client_sha256",
          "client_size",
          "client_content_type",
          "provider_usage_receipt_sha256",
          "attached_at",
        ],
      ],
      [
        "cinatoken_shard_provider_response_attachment_identities",
        [
          "operation_id",
          "owner_generation",
          "attempt_generation",
          "provider_response_evidence_sha256",
          "raw_object_key",
          "raw_object_version",
          "client_response_artifact_sha256",
          "client_object_key",
          "client_object_version",
        ],
      ],
    ]);
    for (const [table, expected] of expectedColumns) {
      const actual = this.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(${table})`)
        .toArray()
        .map(({ name }) => name);
      if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== expected[index])
      ) {
        throw new ProtocolError("shard_schema_migration_conflict", 500);
      }
    }

    const expectedObjects = new Map<string, string>([
      ["cinatoken_shard_provider_response_attachments", "table"],
      ["cinatoken_shard_provider_response_attachment_identities", "table"],
      ["cinatoken_shard_provider_response_attachments_time", "index"],
      ["cinatoken_shard_provider_response_attachment_insert_guard", "trigger"],
      ["cinatoken_shard_provider_response_attachment_identity_append", "trigger"],
      ["cinatoken_shard_provider_response_attachment_update_guard", "trigger"],
      ["cinatoken_shard_provider_response_attachment_delete_guard", "trigger"],
      [
        "cinatoken_shard_provider_response_attachment_identity_insert_guard",
        "trigger",
      ],
      [
        "cinatoken_shard_provider_response_attachment_identity_update_guard",
        "trigger",
      ],
      [
        "cinatoken_shard_provider_response_attachment_identity_delete_guard",
        "trigger",
      ],
    ]);
    const objects = this.storage.sql
      .exec<{ name: string; type: string }>(
        `SELECT name, type
           FROM sqlite_master
          WHERE name LIKE 'cinatoken_shard_provider_response_attachment%'`,
      )
      .toArray();
    if (
      objects.length !== expectedObjects.size ||
      objects.some(({ name, type }) => expectedObjects.get(name) !== type)
    ) {
      throw new ProtocolError("shard_schema_migration_conflict", 500);
    }
  }

  private ensureOperationColumns(): void {
    const existing = new Set(
      this.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cinatoken_shard_operations)")
        .toArray()
        .map(({ name }) => name),
    );
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["protocol_version", "INTEGER NOT NULL DEFAULT 0"],
      ["owner_lease_expires_at", "INTEGER NOT NULL DEFAULT 0"],
      ["operation_kind", "TEXT NOT NULL DEFAULT ''"],
      ["admission_sha256", "TEXT NOT NULL DEFAULT ''"],
      ["trace_id", "TEXT NOT NULL DEFAULT ''"],
      ["response_code", "TEXT"],
      ["input_mode", "TEXT NOT NULL DEFAULT ''"],
      ["input_sha256", "TEXT NOT NULL DEFAULT ''"],
      ["input_size", "INTEGER NOT NULL DEFAULT -1"],
      ["input_content_type", "TEXT NOT NULL DEFAULT ''"],
      ["request_object_key", "TEXT"],
      ["object_version", "TEXT"],
      ["shard_contract_version", "INTEGER NOT NULL DEFAULT 0"],
      ["ring_generation", "INTEGER NOT NULL DEFAULT 0"],
      ["shard_count", "INTEGER NOT NULL DEFAULT 0"],
      ["shard_index", "INTEGER NOT NULL DEFAULT -1"],
      ["instance_name", "TEXT NOT NULL DEFAULT ''"],
      ["result_object_key", "TEXT"],
      ["result_object_version", "TEXT"],
      ["result_sha256", "TEXT"],
      ["result_size", "INTEGER"],
      ["result_content_type", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.storage.sql.exec(
          `ALTER TABLE cinatoken_shard_operations ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }

  private ensureReadinessReplayColumns(): void {
    const existing = new Set(
      this.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cinatoken_shard_readiness)")
        .toArray()
        .map(({ name }) => name),
    );
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["runtime_build_id", "TEXT"],
      ["process_ready", "INTEGER"],
      ["execution_ready", "INTEGER"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.storage.sql.exec(
          `ALTER TABLE cinatoken_shard_readiness ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }

  private ensureReadinessProbeJournalV6(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cinatoken_shard_readiness_probe_journal (
        probe_id TEXT PRIMARY KEY,
        claim_digest_sha256 TEXT NOT NULL,
        generation INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        deadline_at_ms INTEGER NOT NULL,
        retention_until_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        ambiguous_at_ms INTEGER,
        result_json TEXT,
        result_sha256 TEXT,
        result_size_bytes INTEGER,
        CHECK (length(probe_id) = 64 AND probe_id NOT GLOB '*[^0-9a-f]*'),
        CHECK (
          length(claim_digest_sha256) = 64 AND
          claim_digest_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (generation > 0),
        CHECK (state IN ('started', 'completed', 'ambiguous')),
        CHECK (
          started_at_ms > 0 AND
          deadline_at_ms > started_at_ms AND
          deadline_at_ms <= ${MAX_UNIX_TIMESTAMP_MILLISECONDS} AND
          retention_until_ms >= deadline_at_ms + ${READINESS_PROBE_JOURNAL_RETENTION_MS} AND
          retention_until_ms <= ${MAX_UNIX_TIMESTAMP_MILLISECONDS}
        ),
        CHECK (
          (state = 'started' AND completed_at_ms IS NULL AND ambiguous_at_ms IS NULL
            AND result_json IS NULL AND result_sha256 IS NULL AND result_size_bytes IS NULL)
          OR
          (state = 'completed' AND completed_at_ms BETWEEN started_at_ms AND deadline_at_ms
            AND ambiguous_at_ms IS NULL
            AND result_json IS NOT NULL
            AND result_size_bytes BETWEEN 2 AND ${READINESS_PROBE_RESULT_JSON_MAX_BYTES}
            AND length(CAST(result_json AS BLOB)) = result_size_bytes
            AND result_sha256 IS NOT NULL
            AND length(result_sha256) = 64
            AND result_sha256 NOT GLOB '*[^0-9a-f]*')
          OR
          (state = 'ambiguous' AND completed_at_ms IS NULL
            AND ambiguous_at_ms BETWEEN deadline_at_ms AND retention_until_ms
            AND result_json IS NULL AND result_sha256 IS NULL AND result_size_bytes IS NULL)
        )
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS cinatoken_shard_readiness_probe_journal_state_deadline
        ON cinatoken_shard_readiness_probe_journal(state, deadline_at_ms, probe_id);
      CREATE INDEX IF NOT EXISTS cinatoken_shard_readiness_probe_journal_retention
        ON cinatoken_shard_readiness_probe_journal(retention_until_ms, probe_id);
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_readiness_probe_journal_identity_guard
      BEFORE UPDATE ON cinatoken_shard_readiness_probe_journal
      FOR EACH ROW
      WHEN
        NEW.probe_id IS NOT OLD.probe_id OR
        NEW.claim_digest_sha256 IS NOT OLD.claim_digest_sha256 OR
        NEW.generation IS NOT OLD.generation OR
        NEW.started_at_ms IS NOT OLD.started_at_ms OR
        NEW.deadline_at_ms IS NOT OLD.deadline_at_ms OR
        NEW.retention_until_ms IS NOT OLD.retention_until_ms
      BEGIN
        SELECT RAISE(ABORT, 'readiness probe journal identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_readiness_probe_journal_transition_guard
      BEFORE UPDATE ON cinatoken_shard_readiness_probe_journal
      FOR EACH ROW
      WHEN
        (OLD.state IN ('completed', 'ambiguous')) OR
        (OLD.state = 'started' AND NEW.state NOT IN ('completed', 'ambiguous'))
      BEGIN
        SELECT RAISE(ABORT, 'readiness probe journal terminal state is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS cinatoken_shard_readiness_probe_journal_retention_guard
      BEFORE DELETE ON cinatoken_shard_readiness_probe_journal
      FOR EACH ROW
      WHEN
        OLD.state NOT IN ('completed', 'ambiguous') OR
        OLD.retention_until_ms >= unixepoch() * 1000
      BEGIN
        SELECT RAISE(ABORT, 'readiness probe journal retention is active');
      END;
    `);

    const expectedColumns = [
      "probe_id",
      "claim_digest_sha256",
      "generation",
      "state",
      "started_at_ms",
      "deadline_at_ms",
      "retention_until_ms",
      "completed_at_ms",
      "ambiguous_at_ms",
      "result_json",
      "result_sha256",
      "result_size_bytes",
    ];
    const columns = this.storage.sql
      .exec<{ name: string }>(
        "PRAGMA table_info(cinatoken_shard_readiness_probe_journal)",
      )
      .toArray()
      .map(({ name }) => name);
    const expectedObjects = [
      "cinatoken_shard_readiness_probe_journal_identity_guard",
      "cinatoken_shard_readiness_probe_journal_retention",
      "cinatoken_shard_readiness_probe_journal_retention_guard",
      "cinatoken_shard_readiness_probe_journal_state_deadline",
      "cinatoken_shard_readiness_probe_journal_transition_guard",
    ];
    const objects = this.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE name IN (${expectedObjects.map(() => "?").join(", ")})
          ORDER BY name ASC`,
        ...expectedObjects,
      )
      .toArray()
      .map(({ name }) => name);
    if (
      columns.length !== expectedColumns.length ||
      columns.some((name, index) => name !== expectedColumns[index]) ||
      objects.length !== expectedObjects.length ||
      objects.some((name, index) => name !== expectedObjects[index])
    ) {
      throw new ProtocolError("shard_schema_migration_conflict", 500);
    }
  }

  private ensureProviderAttemptEgressColumns(): void {
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["egress_profile", "TEXT"],
      ["egress_worker_version_id", "TEXT"],
    ];
    for (const table of [
      "cinatoken_shard_provider_attempts",
      "cinatoken_shard_provider_attempt_events",
    ]) {
      const existing = new Set(
        this.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .map(({ name }) => name),
      );
      for (const [name, definition] of additions) {
        if (!existing.has(name)) {
          this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
    }
  }

  private ensureProviderUsageReceiptColumns(): void {
    for (const table of [
      "cinatoken_shard_operations",
      "cinatoken_shard_provider_attempts",
      "cinatoken_shard_provider_attempt_events",
    ]) {
      const existing = new Set(
        this.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .map(({ name }) => name),
      );
      if (!existing.has("provider_usage_receipt_sha256")) {
        this.storage.sql.exec(
          `ALTER TABLE ${table} ADD COLUMN provider_usage_receipt_sha256 TEXT`,
        );
      }
      if (
        table !== "cinatoken_shard_operations" &&
        !existing.has("provider_usage_receipt_attached_at")
      ) {
        this.storage.sql.exec(
          `ALTER TABLE ${table} ADD COLUMN provider_usage_receipt_attached_at INTEGER`,
        );
      }
    }
  }

  private ensureTerminalAckV3Columns(): void {
    const existing = new Set(
      this.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cinatoken_shard_terminal_acks)")
        .toArray()
        .map(({ name }) => name),
    );
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["terminal_ack_contract_version", "INTEGER NOT NULL DEFAULT 1"],
      ["financial_terminal_contract_version", "INTEGER"],
      ["provider_response_binding_json", "TEXT"],
      ["client_response_artifact_sha256", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        this.storage.sql.exec(
          `ALTER TABLE cinatoken_shard_terminal_acks ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_terminal_acks
          SET terminal_ack_contract_version = 2
        WHERE terminal_ack_contract_version = 1
          AND json_type(ack_payload_json, '$.provider_usage_binding') IS NOT NULL`,
    );
  }

  private ensureTerminalAckV3TableShape(): void {
    const table = firstRow<{ sql: string }>(
      this.storage.sql.exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'cinatoken_shard_terminal_acks'`,
      ),
    );
    if (table?.sql.includes("terminal_ack_contract_version = 3") === true) return;

    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        DROP TRIGGER IF EXISTS cinatoken_shard_terminal_ack_contract_insert_guard;
        DROP TRIGGER IF EXISTS cinatoken_shard_terminal_ack_contract_update_guard;
        DROP TRIGGER IF EXISTS cinatoken_shard_operation_terminal_ack_cleanup;
        ALTER TABLE cinatoken_shard_terminal_acks
          RENAME TO cinatoken_shard_terminal_acks_schema3;
        CREATE TABLE cinatoken_shard_terminal_acks (
          operation_id TEXT NOT NULL,
          owner_generation INTEGER NOT NULL,
          terminal_ack_contract_version INTEGER NOT NULL DEFAULT 1,
          financial_terminal_contract_version INTEGER,
          billing_event_id TEXT NOT NULL,
          terminal_contract_sha256 TEXT NOT NULL,
          reconciliation_id TEXT NOT NULL,
          reconciliation_revision INTEGER NOT NULL,
          predecessor_billing_event_id TEXT,
          ack_payload_json TEXT NOT NULL,
          recovery_payload_json TEXT,
          provider_response_binding_json TEXT,
          client_response_artifact_sha256 TEXT,
          final_acked_at INTEGER,
          compaction_authorized_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (operation_id, owner_generation),
          CHECK (length(operation_id) BETWEEN 1 AND 128),
          CHECK (owner_generation > 0),
          CHECK (terminal_ack_contract_version IN (1, 2, 3)),
          CHECK (length(billing_event_id) = 64),
          CHECK (length(terminal_contract_sha256) = 64),
          CHECK (length(reconciliation_id) = 64),
          CHECK (reconciliation_revision IN (1, 2)),
          CHECK (created_at > 0 AND updated_at >= created_at),
          CHECK (
            (reconciliation_revision = 1
              AND predecessor_billing_event_id IS NULL
              AND (
                (recovery_payload_json IS NULL AND final_acked_at IS NOT NULL) OR
                (recovery_payload_json = ack_payload_json AND final_acked_at IS NULL)
              ))
            OR
            (reconciliation_revision = 2
              AND predecessor_billing_event_id IS NOT NULL
              AND (
                recovery_payload_json IS NOT NULL OR
                (terminal_ack_contract_version = 3
                  AND recovery_payload_json IS NULL)
              )
              AND final_acked_at IS NOT NULL)
          ),
          CHECK (compaction_authorized_at IS NULL OR final_acked_at IS NOT NULL)
        );
        INSERT INTO cinatoken_shard_terminal_acks
          (operation_id, owner_generation, terminal_ack_contract_version,
           financial_terminal_contract_version, billing_event_id,
           terminal_contract_sha256, reconciliation_id, reconciliation_revision,
           predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
           provider_response_binding_json, client_response_artifact_sha256,
           final_acked_at, compaction_authorized_at, created_at, updated_at)
        SELECT operation_id, owner_generation, terminal_ack_contract_version,
               financial_terminal_contract_version, billing_event_id,
               terminal_contract_sha256, reconciliation_id, reconciliation_revision,
               predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
               provider_response_binding_json, client_response_artifact_sha256,
               final_acked_at, compaction_authorized_at, created_at, updated_at
          FROM cinatoken_shard_terminal_acks_schema3;
        DROP TABLE cinatoken_shard_terminal_acks_schema3;
        CREATE INDEX cinatoken_shard_terminal_acks_compaction
          ON cinatoken_shard_terminal_acks(final_acked_at, compaction_authorized_at);
        CREATE TRIGGER cinatoken_shard_operation_terminal_ack_cleanup
        AFTER DELETE ON cinatoken_shard_operations
        FOR EACH ROW
        BEGIN
          DELETE FROM cinatoken_shard_terminal_acks
           WHERE operation_id = OLD.operation_id
             AND owner_generation = OLD.owner_generation;
        END;
      `);
    });
  }

  private installTerminalAckV3Guards(): void {
    this.storage.sql.exec(`
      DROP TRIGGER IF EXISTS cinatoken_shard_terminal_ack_contract_insert_guard;
      CREATE TRIGGER cinatoken_shard_terminal_ack_contract_insert_guard
      BEFORE INSERT ON cinatoken_shard_terminal_acks
      FOR EACH ROW
      WHEN NOT (
        (NEW.terminal_ack_contract_version IN (1, 2)
          AND NEW.financial_terminal_contract_version IS NULL
          AND NEW.provider_response_binding_json IS NULL
          AND NEW.client_response_artifact_sha256 IS NULL
          AND (
            (NEW.terminal_ack_contract_version = 1
              AND json_type(NEW.ack_payload_json, '$.provider_usage_binding') IS NULL)
            OR
            (NEW.terminal_ack_contract_version = 2
              AND json_type(NEW.ack_payload_json, '$.provider_usage_binding') IS NOT NULL)
          ))
        OR
        (NEW.terminal_ack_contract_version = 3
          AND NEW.financial_terminal_contract_version = 2
          AND json_valid(NEW.provider_response_binding_json) = 1
          AND json_type(NEW.provider_response_binding_json) = 'object'
          AND NEW.provider_response_binding_json =
                json_extract(NEW.ack_payload_json, '$.provider_response_binding')
          AND length(NEW.client_response_artifact_sha256) = 64
          AND NEW.client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
          AND json_extract(
                NEW.ack_payload_json,
                '$.terminal_ack_contract_version'
              ) = 3
          AND json_extract(
                NEW.ack_payload_json,
                '$.financial_terminal_contract_version'
              ) = 2
          AND json_extract(
                NEW.ack_payload_json,
                '$.provider_response_binding.client_response_artifact_sha256'
              ) = NEW.client_response_artifact_sha256)
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal ack contract metadata mismatch');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_terminal_ack_contract_update_guard;
      CREATE TRIGGER cinatoken_shard_terminal_ack_contract_update_guard
      BEFORE UPDATE ON cinatoken_shard_terminal_acks
      FOR EACH ROW
      WHEN NOT (
        (NEW.terminal_ack_contract_version IN (1, 2)
          AND NEW.financial_terminal_contract_version IS NULL
          AND NEW.provider_response_binding_json IS NULL
          AND NEW.client_response_artifact_sha256 IS NULL
          AND (
            (NEW.terminal_ack_contract_version = 1
              AND json_type(NEW.ack_payload_json, '$.provider_usage_binding') IS NULL)
            OR
            (NEW.terminal_ack_contract_version = 2
              AND json_type(NEW.ack_payload_json, '$.provider_usage_binding') IS NOT NULL)
          ))
        OR
        (NEW.terminal_ack_contract_version = 3
          AND NEW.financial_terminal_contract_version = 2
          AND json_valid(NEW.provider_response_binding_json) = 1
          AND json_type(NEW.provider_response_binding_json) = 'object'
          AND NEW.provider_response_binding_json =
                json_extract(NEW.ack_payload_json, '$.provider_response_binding')
          AND length(NEW.client_response_artifact_sha256) = 64
          AND NEW.client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
          AND json_extract(
                NEW.ack_payload_json,
                '$.terminal_ack_contract_version'
              ) = 3
          AND json_extract(
                NEW.ack_payload_json,
                '$.financial_terminal_contract_version'
              ) = 2
          AND json_extract(
                NEW.ack_payload_json,
                '$.provider_response_binding.client_response_artifact_sha256'
              ) = NEW.client_response_artifact_sha256)
      )
      BEGIN
        SELECT RAISE(ABORT, 'terminal ack contract metadata mismatch');
      END;
    `);
  }

  private installProviderAttemptEgressGuards(): void {
    this.storage.sql.exec(`
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_egress_insert_guard;
      CREATE TRIGGER cinatoken_shard_provider_attempt_egress_insert_guard
      BEFORE INSERT ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN NEW.egress_profile IS NOT NULL OR NEW.egress_worker_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt egress identity must be assigned at dispatch');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_egress_identity_guard;
      CREATE TRIGGER cinatoken_shard_provider_attempt_egress_identity_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN NOT (
        (NEW.egress_profile IS OLD.egress_profile
          AND NEW.egress_worker_version_id IS OLD.egress_worker_version_id)
        OR
        (OLD.status = 'prepared' AND NEW.status = 'dispatched'
          AND OLD.egress_profile IS NULL AND OLD.egress_worker_version_id IS NULL
          AND NEW.egress_profile IS NOT NULL
          AND length(NEW.egress_profile) BETWEEN 1 AND 64
          AND NEW.egress_profile NOT GLOB '*[^A-Za-z0-9._:/@-]*'
          AND NEW.egress_worker_version_id IS NOT NULL
          AND length(NEW.egress_worker_version_id) BETWEEN 1 AND 128
          AND NEW.egress_worker_version_id NOT GLOB '*[^A-Za-z0-9._:/@-]*')
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt egress identity is immutable');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_event_append;
      CREATE TRIGGER cinatoken_shard_provider_attempt_event_append
      AFTER UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN OLD.status IS NOT NEW.status
      BEGIN
        INSERT INTO cinatoken_shard_provider_attempt_events
          (event_id, operation_id, owner_generation, attempt_generation, event_sequence,
           from_status, to_status, response_status, response_code, egress_profile,
           egress_worker_version_id, observed_at)
        VALUES (
          'provider-attempt-v1:' || NEW.operation_id || ':' || NEW.owner_generation || ':' ||
            NEW.attempt_generation || ':' ||
            CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          NEW.operation_id,
          NEW.owner_generation,
          NEW.attempt_generation,
          CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          OLD.status,
          NEW.status,
          NEW.response_status,
          NEW.response_code,
          NEW.egress_profile,
          NEW.egress_worker_version_id,
          NEW.updated_at
        );
      END;
    `);
  }

  private installProviderUsageReceiptGuards(): void {
    this.storage.sql.exec(`
      DROP TRIGGER IF EXISTS cinatoken_shard_operation_provider_usage_receipt_guard;
      CREATE TRIGGER cinatoken_shard_operation_provider_usage_receipt_guard
      BEFORE UPDATE ON cinatoken_shard_operations
      FOR EACH ROW
      WHEN NOT (
        NEW.provider_usage_receipt_sha256 IS OLD.provider_usage_receipt_sha256
        OR
        (OLD.status = 'running' AND NEW.status = 'running'
          AND OLD.provider_usage_receipt_sha256 IS NULL
          AND NEW.provider_usage_receipt_sha256 IS NOT NULL
          AND length(NEW.provider_usage_receipt_sha256) = 64
          AND NEW.provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
          AND OLD.result_object_key IS NULL AND OLD.result_object_version IS NULL
          AND OLD.result_sha256 IS NULL AND OLD.result_size IS NULL
          AND OLD.result_content_type IS NULL
          AND NEW.result_object_key IS NOT NULL AND NEW.result_object_version IS NOT NULL
          AND NEW.result_sha256 IS NOT NULL AND NEW.result_size IS NOT NULL
          AND NEW.result_content_type IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
             WHERE attempt.operation_id = OLD.operation_id
               AND attempt.owner_generation = OLD.owner_generation
               AND attempt.status = 'dispatched'
               AND attempt.provider_usage_receipt_sha256 IS NULL
          ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider usage receipt identity is immutable');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_operation_provider_result_guard;
      CREATE TRIGGER cinatoken_shard_operation_provider_result_guard
      BEFORE UPDATE ON cinatoken_shard_operations
      FOR EACH ROW
      WHEN OLD.result_object_key IS NULL
        AND NEW.result_object_key IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM cinatoken_shard_provider_attempts AS attempt
           WHERE attempt.operation_id = OLD.operation_id
             AND attempt.owner_generation = OLD.owner_generation
             AND attempt.status = 'dispatched'
        )
        AND NEW.provider_usage_receipt_sha256 IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'provider usage receipt is required for provider result');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_usage_receipt_guard;
      CREATE TRIGGER cinatoken_shard_provider_attempt_usage_receipt_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN NOT (
        NEW.provider_usage_receipt_sha256 IS OLD.provider_usage_receipt_sha256
        OR
        (OLD.status = 'dispatched' AND NEW.status = 'dispatched'
          AND OLD.provider_usage_receipt_sha256 IS NULL
          AND OLD.provider_usage_receipt_attached_at IS NULL
          AND NEW.provider_usage_receipt_sha256 IS NOT NULL
          AND NEW.provider_usage_receipt_attached_at IS NOT NULL
          AND NEW.provider_usage_receipt_attached_at >= OLD.dispatched_at
          AND length(NEW.provider_usage_receipt_sha256) = 64
          AND NEW.provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
          AND EXISTS (
            SELECT 1 FROM cinatoken_shard_operations AS operation
             WHERE operation.operation_id = OLD.operation_id
               AND operation.owner_generation = OLD.owner_generation
               AND operation.status = 'running'
               AND operation.provider_usage_receipt_sha256 =
                 NEW.provider_usage_receipt_sha256
               AND operation.result_object_key IS NOT NULL
          ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt usage receipt identity is immutable');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_usage_terminal_guard;
      CREATE TRIGGER cinatoken_shard_provider_attempt_usage_terminal_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN
        (NEW.status = 'succeeded' AND NEW.provider_usage_receipt_sha256 IS NULL)
        OR
        (NEW.status IN ('prepared', 'definite_reject', 'cancelled')
          AND (NEW.provider_usage_receipt_sha256 IS NOT NULL
            OR NEW.provider_usage_receipt_attached_at IS NOT NULL))
        OR
        ((NEW.provider_usage_receipt_sha256 IS NULL) IS NOT
          (NEW.provider_usage_receipt_attached_at IS NULL))
        OR
        (NEW.status = 'ambiguous'
          AND ((NEW.result_object_key IS NULL) IS NOT
            (NEW.provider_usage_receipt_sha256 IS NULL)))
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt usage receipt terminal state is invalid');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_lifecycle_guard;
      CREATE TRIGGER cinatoken_shard_provider_attempt_lifecycle_guard
      BEFORE UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN NOT (
        (OLD.status = 'prepared' AND NEW.status IN ('dispatched', 'cancelled'))
        OR
        (OLD.status = 'dispatched'
          AND NEW.status IN ('succeeded', 'definite_reject', 'ambiguous'))
        OR
        (OLD.status = 'dispatched' AND NEW.status = 'dispatched'
          AND OLD.provider_usage_receipt_sha256 IS NULL
          AND OLD.provider_usage_receipt_attached_at IS NULL
          AND NEW.provider_usage_receipt_sha256 IS NOT NULL
          AND NEW.provider_usage_receipt_attached_at IS NOT NULL)
        OR
        (OLD.status = 'ambiguous'
          AND (
            (NEW.status = 'succeeded'
              AND NEW.response_status = 200
              AND NEW.response_code IS NULL
              AND EXISTS (
                SELECT 1
                  FROM cinatoken_shard_provider_response_attachments AS attachment
                 WHERE attachment.operation_id = OLD.operation_id
                   AND attachment.owner_generation = OLD.owner_generation
                   AND attachment.attempt_generation = OLD.attempt_generation
                   AND attachment.status = 'succeeded'
                   AND attachment.provider_usage_receipt_sha256 =
                         NEW.provider_usage_receipt_sha256
              ))
            OR
            (NEW.status = 'definite_reject'
              AND NEW.response_status = 422
              AND NEW.response_code IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM cinatoken_shard_provider_response_attachments AS attachment
                 WHERE attachment.operation_id = OLD.operation_id
                   AND attachment.owner_generation = OLD.owner_generation
                   AND attachment.attempt_generation = OLD.attempt_generation
                   AND attachment.status = 'interpreted_reject'
                   AND attachment.response_code = NEW.response_code
              ))
          ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider attempt lifecycle transition is invalid');
      END;
      DROP TRIGGER IF EXISTS cinatoken_shard_provider_attempt_event_append;
      CREATE TRIGGER cinatoken_shard_provider_attempt_event_append
      AFTER UPDATE ON cinatoken_shard_provider_attempts
      FOR EACH ROW
      WHEN OLD.status IS NOT NEW.status AND OLD.status <> 'ambiguous'
      BEGIN
        INSERT INTO cinatoken_shard_provider_attempt_events
          (event_id, operation_id, owner_generation, attempt_generation, event_sequence,
           from_status, to_status, response_status, response_code, egress_profile,
           egress_worker_version_id, provider_usage_receipt_sha256,
           provider_usage_receipt_attached_at, observed_at)
        VALUES (
          'provider-attempt-v1:' || NEW.operation_id || ':' || NEW.owner_generation || ':' ||
            NEW.attempt_generation || ':' ||
            CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          NEW.operation_id,
          NEW.owner_generation,
          NEW.attempt_generation,
          CASE WHEN OLD.status = 'prepared' THEN 2 ELSE 3 END,
          OLD.status,
          NEW.status,
          NEW.response_status,
          NEW.response_code,
          NEW.egress_profile,
          NEW.egress_worker_version_id,
          NEW.provider_usage_receipt_sha256,
          NEW.provider_usage_receipt_attached_at,
          NEW.updated_at
        );
      END;
    `);
  }

  private readStorageOperation(operationId: string): StorageOperationRow | null {
    return firstRow<StorageOperationRow>(
      this.storage.sql.exec<StorageOperationRow>(
        `SELECT protocol_version, operation_id, owner_generation, owner_lease_expires_at,
                operation_kind, provider_operation_id, admission_sha256, status,
                response_status, response_code, deadline_at,
                input_mode, input_sha256, input_size, input_content_type, request_object_key,
                object_version, shard_contract_version, ring_generation, shard_count,
                shard_index, instance_name, trace_id, result_object_key, result_object_version,
                result_sha256, result_size, result_content_type,
                provider_usage_receipt_sha256
           FROM cinatoken_shard_operations WHERE operation_id = ?1`,
        operationId,
      ),
    );
  }

  private readProviderAttempt(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): ProviderAttemptRow | null {
    const row = firstRow<ProviderAttemptRow>(
      this.storage.sql.exec<ProviderAttemptRow>(
        `SELECT operation_id, owner_generation, attempt_generation, provider_operation_id,
                admission_sha256, request_sha256, egress_profile, egress_worker_version_id,
                status, response_status, response_code,
                result_object_key, result_object_version, result_sha256, result_size,
                result_content_type, provider_usage_receipt_sha256,
                provider_usage_receipt_attached_at,
                prepared_at, dispatched_at, terminal_at, updated_at
           FROM cinatoken_shard_provider_attempts
          WHERE operation_id = ?1 AND owner_generation = ?2 AND attempt_generation = ?3`,
        operationId,
        ownerGeneration,
        attemptGeneration,
      ),
    );
    if (row !== null) validateProviderAttemptRow(row);
    return row;
  }

  private readProviderResponseArtifactAttachmentRow(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
  ): ProviderResponseArtifactAttachmentRow | null {
    const row = firstRow<ProviderResponseArtifactAttachmentSqlRow>(
      this.storage.sql.exec<ProviderResponseArtifactAttachmentSqlRow>(
        `SELECT operation_id, owner_generation, attempt_generation, provider_operation_id,
                admission_sha256, request_sha256, egress_profile, egress_worker_version_id,
                status, provider_status, client_status, response_class, response_code,
                provider_response_evidence_sha256, raw_object_key, raw_object_version,
                raw_sha256, raw_size, raw_content_type,
                client_response_artifact_sha256, client_object_key, client_object_version,
                client_sha256, client_size, client_content_type,
                provider_usage_receipt_sha256, attached_at
           FROM cinatoken_shard_provider_response_attachments
          WHERE operation_id = ?1 AND owner_generation = ?2 AND attempt_generation = ?3`,
        operationId,
        ownerGeneration,
        attemptGeneration,
      ),
    );
    return row === null ? null : providerResponseArtifactAttachmentRow(row);
  }

  private readLatestProviderAttempt(
    operationId: string,
    ownerGeneration: number,
  ): ProviderAttemptRow | null {
    const row = firstRow<ProviderAttemptRow>(
      this.storage.sql.exec<ProviderAttemptRow>(
        `SELECT operation_id, owner_generation, attempt_generation, provider_operation_id,
                admission_sha256, request_sha256, egress_profile, egress_worker_version_id,
                status, response_status, response_code,
                result_object_key, result_object_version, result_sha256, result_size,
                result_content_type, provider_usage_receipt_sha256,
                provider_usage_receipt_attached_at,
                prepared_at, dispatched_at, terminal_at, updated_at
           FROM cinatoken_shard_provider_attempts
          WHERE operation_id = ?1 AND owner_generation = ?2
          ORDER BY attempt_generation DESC
          LIMIT 1`,
        operationId,
        ownerGeneration,
      ),
    );
    if (row !== null) validateProviderAttemptRow(row);
    return row;
  }

  private readProviderRetryState(
    operationId: string,
    ownerGeneration: number,
  ): ProviderRetryStateRow | null {
    return firstRow<ProviderRetryStateRow>(
      this.storage.sql.exec<ProviderRetryStateRow>(
        `SELECT operation_id, owner_generation, policy_version, max_attempts, retry_enabled,
                state, active_attempt_generation, last_attempt_generation, schedule_generation,
                next_attempt_at, retry_deadline_at, global_terminal_event_id,
                global_terminal_acked_at, created_at, updated_at
           FROM cinatoken_shard_provider_retry_state
          WHERE operation_id = ?1 AND owner_generation = ?2`,
        operationId,
        ownerGeneration,
      ),
    );
  }

  private readTerminalAckState(
    operationId: string,
    ownerGeneration: number,
  ): TerminalAckStateRow | null {
    return firstRow<TerminalAckStateRow>(
      this.storage.sql.exec<TerminalAckStateRow>(
        `SELECT operation_id, owner_generation, terminal_ack_contract_version,
                financial_terminal_contract_version, billing_event_id,
                terminal_contract_sha256, reconciliation_id, reconciliation_revision,
                predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
                provider_response_binding_json, client_response_artifact_sha256,
                final_acked_at, compaction_authorized_at, created_at, updated_at
           FROM cinatoken_shard_terminal_acks
          WHERE operation_id = ?1 AND owner_generation = ?2`,
        operationId,
        ownerGeneration,
      ),
    );
  }

  private insertPreparedProviderAttempt(
    operation: StorageOperationRow,
    attemptGeneration: number,
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO cinatoken_shard_provider_attempts
         (operation_id, owner_generation, attempt_generation, provider_operation_id,
          admission_sha256, request_sha256, status, response_status, response_code,
          result_object_key, result_object_version, result_sha256, result_size,
          result_content_type, prepared_at, dispatched_at, terminal_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, NULL,
               NULL, NULL, NULL, NULL, NULL, ?7, NULL, NULL, ?7)`,
      operation.operation_id,
      operation.owner_generation,
      attemptGeneration,
      operation.provider_operation_id,
      operation.admission_sha256,
      operation.input_sha256,
      now,
    );
  }

  private insertProviderAttemptEvent(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    eventSequence: number,
    fromStatus: ProviderAttemptStatus | null,
    toStatus: ProviderAttemptStatus,
    responseStatus: number | null,
    responseCode: string | null,
    observedAt: number,
  ): void {
    const eventId = [
      "provider-attempt-v1",
      operationId,
      ownerGeneration,
      attemptGeneration,
      eventSequence,
    ].join(":");
    this.storage.sql.exec(
      `INSERT INTO cinatoken_shard_provider_attempt_events
         (event_id, operation_id, owner_generation, attempt_generation, event_sequence,
          from_status, to_status, response_status, response_code, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      eventId,
      operationId,
      ownerGeneration,
      attemptGeneration,
      eventSequence,
      fromStatus,
      toStatus,
      responseStatus,
      responseCode,
      observedAt,
    );
  }

  private assertAndAdvanceShardFence(
    envelope: OperationEnvelope,
    now: number,
    ringTransition: ConfiguredRingTransition | null,
  ): void {
    const state = this.readShardStateRow();
    if (state === null) {
      this.storage.sql.exec(
        `INSERT INTO cinatoken_shard_state
           (singleton, instance_name, contract_version, ring_generation, shard_count, shard_index,
            lifecycle_state, lifecycle_detail, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, 'idle', NULL, ?6)`,
        envelope.shard.instance_name,
        envelope.shard.contract_version,
        envelope.shard.ring_generation,
        envelope.shard.shard_count,
        envelope.shard.shard_index,
        now,
      );
      return;
    }
    if (
      state.instance_name !== envelope.shard.instance_name ||
      state.contract_version !== envelope.shard.contract_version ||
      state.shard_index !== envelope.shard.shard_index ||
      (state.ring_generation === envelope.shard.ring_generation &&
        state.shard_count !== envelope.shard.shard_count)
    ) {
      throw new ProtocolError("stale_shard_fence", 409);
    }
    if (state.ring_generation === envelope.shard.ring_generation) return;
    if (ringTransitionAllowsOverlap(state, envelope.shard, ringTransition)) {
      if (envelope.shard.ring_generation === ringTransition?.current_ring_generation) {
        this.updateShardRing(envelope.shard, now);
      }
      return;
    }
    if (state.ring_generation > envelope.shard.ring_generation) {
      throw new ProtocolError("stale_shard_fence", 409);
    }

    const activeBeforeFence =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running')`,
        ),
      )?.count ?? 0;
    if (activeBeforeFence > 0) {
      throw new ProtocolError("ring_generation_in_flight", 409);
    }
    this.updateShardRing(envelope.shard, now);
  }

  private assertAndAdvanceReadinessFence(
    state: ShardStateRow,
    shard: OperationShard,
    now: number,
    ringTransition: ConfiguredRingTransition | null,
  ): void {
    if (
      state.instance_name !== shard.instance_name ||
      state.contract_version !== shard.contract_version ||
      state.shard_index !== shard.shard_index ||
      (state.ring_generation === shard.ring_generation && state.shard_count !== shard.shard_count)
    ) {
      throw new ProtocolError("stale_shard_fence", 409);
    }
    if (state.ring_generation === shard.ring_generation) return;
    if (ringTransitionAllowsOverlap(state, shard, ringTransition)) {
      if (shard.ring_generation === ringTransition?.current_ring_generation) {
        this.updateShardRing(shard, now);
      }
      return;
    }
    if (state.ring_generation > shard.ring_generation) {
      throw new ProtocolError("stale_shard_fence", 409);
    }
    const active =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running')`,
        ),
      )?.count ?? 0;
    if (active > 0) throw new ProtocolError("ring_generation_in_flight", 409);
    this.updateShardRing(shard, now);
  }

  private updateShardRing(shard: OperationShard, now: number): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_state
          SET ring_generation = ?1, shard_count = ?2, updated_at = ?3
        WHERE singleton = 1`,
      shard.ring_generation,
      shard.shard_count,
      now,
    );
  }

  private readShardStateRow(): ShardStateRow | null {
    return firstRow<ShardStateRow>(
      this.storage.sql.exec<ShardStateRow>(
        `SELECT instance_name, contract_version, ring_generation, shard_count, shard_index,
                lifecycle_state, lifecycle_detail, updated_at
           FROM cinatoken_shard_state WHERE singleton = 1`,
      ),
    );
  }

  private readReadinessRow(): ReadinessRow | null {
    return firstRow<ReadinessRow>(
      this.storage.sql.exec<ReadinessRow>(
        `SELECT probe_generation, phase, last_probe_id, started_at_ms, deadline_at_ms,
                completed_at_ms, result_code, container_status, container_last_change_ms,
                container_exit_code, runtime_protocol_version, runtime_contract_version,
                runtime_build_id, runtime_execution_enabled, process_ready, execution_ready,
                last_ready_at_ms
           FROM cinatoken_shard_readiness WHERE singleton = 1`,
      ),
    );
  }

  private readReadinessProbeJournalRow(
    probeId: string,
  ): ReadinessProbeJournalRow | null {
    return firstRow<ReadinessProbeJournalRow>(
      this.storage.sql.exec<ReadinessProbeJournalRow>(
        `SELECT probe_id, claim_digest_sha256, generation, state, started_at_ms,
                deadline_at_ms, retention_until_ms, completed_at_ms, ambiguous_at_ms,
                result_json, result_sha256, result_size_bytes
           FROM cinatoken_shard_readiness_probe_journal
          WHERE probe_id = ?1`,
        probeId,
      ),
    );
  }

  private recordReadinessProbeAmbiguousSummary(
    row: ReadinessProbeJournalRow,
    ambiguousAtMs: number,
  ): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_readiness
          SET phase = 'complete', completed_at_ms = ?1,
              result_code = 'container_readiness_ambiguous',
              container_status = NULL, container_last_change_ms = NULL,
              container_exit_code = NULL, runtime_protocol_version = NULL,
              runtime_contract_version = NULL, runtime_build_id = NULL,
              runtime_execution_enabled = NULL, process_ready = 0, execution_ready = 0
        WHERE singleton = 1
          AND probe_generation = ?2
          AND last_probe_id = ?3
          AND started_at_ms = ?4
          AND phase = 'probing'`,
      ambiguousAtMs,
      row.generation,
      row.probe_id,
      row.started_at_ms,
    );
  }

  private maintainReadinessProbeJournal(): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_readiness_probe_journal
          SET state = 'ambiguous',
              ambiguous_at_ms = MIN(
                retention_until_ms,
                MAX(deadline_at_ms, unixepoch() * 1000)
              )
        WHERE probe_id IN (
          SELECT probe_id
            FROM cinatoken_shard_readiness_probe_journal
           WHERE state = 'started'
             AND deadline_at_ms <= unixepoch() * 1000
           ORDER BY deadline_at_ms ASC, probe_id ASC
           LIMIT 64
        )`,
    );
    this.storage.sql.exec(
      `DELETE FROM cinatoken_shard_readiness_probe_journal
        WHERE probe_id IN (
          SELECT probe_id
            FROM cinatoken_shard_readiness_probe_journal
           WHERE state IN ('completed', 'ambiguous')
             AND retention_until_ms < unixepoch() * 1000
           ORDER BY retention_until_ms ASC, probe_id ASC
           LIMIT 64
        )`,
    );
  }

  private ensureOperationRecoveryIntentRow(
    operation: StorageOperationRow,
    now: number,
  ): OperationRecoveryIntent {
    if (operation.status !== "claimed" && operation.status !== "running") {
      throw new ProtocolError("operation_recovery_intent_not_authorized", 409);
    }
    const payload = buildRelayShardAlarmIntentV1(
      operation.operation_id,
      operation.owner_generation,
      operation.deadline_at,
      1,
      storageOperationShard(operation),
    );
    const existing = this.readOperationRecoveryIntentRow(
      operation.operation_id,
      operation.owner_generation,
    );
    if (existing !== null) {
      if (!operationRecoveryIntentMatchesOperation(existing, operation)) {
        throw new ProtocolError("operation_recovery_intent_conflict", 409);
      }
      return existing;
    }
    if (!Number.isSafeInteger(operation.deadline_at + 1)) {
      throw new ProtocolError("operation_recovery_intent_conflict", 409);
    }
    this.storage.sql.exec(
      `INSERT INTO cinatoken_shard_alarm_intents
         (operation_id, owner_generation, payload_version, intent_kind, deadline_at,
          delivery_generation, delivery_count, state, armed_at, next_delivery_at,
          last_error_code, shard_contract_version, ring_generation, shard_count,
          shard_index, instance_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'pending', NULL, ?7,
               NULL, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
      payload.operation_id,
      payload.owner_generation,
      payload.payload_version,
      payload.kind,
      payload.deadline_at,
      payload.delivery_generation,
      payload.deadline_at + 1,
      payload.shard.contract_version,
      payload.shard.ring_generation,
      payload.shard.shard_count,
      payload.shard.shard_index,
      payload.shard.instance_name,
      now,
    );
    const created = this.readOperationRecoveryIntentRow(
      operation.operation_id,
      operation.owner_generation,
    );
    if (created === null) {
      throw new ProtocolError("operation_recovery_intent_unavailable", 503);
    }
    return created;
  }

  private readOperationRecoveryIntentRow(
    operationId: string,
    ownerGeneration: number,
  ): OperationRecoveryIntent | null {
    const row = firstRow<OperationRecoveryIntent>(
      this.storage.sql.exec<OperationRecoveryIntent>(
        `SELECT payload_version, intent_kind, operation_id, owner_generation, deadline_at,
                delivery_generation, delivery_count, state, armed_at, next_delivery_at,
                last_error_code, shard_contract_version, ring_generation, shard_count,
                shard_index, instance_name, created_at, updated_at
           FROM cinatoken_shard_alarm_intents
          WHERE operation_id = ?1 AND owner_generation = ?2`,
        operationId,
        ownerGeneration,
      ),
    );
    if (row !== null) validateOperationRecoveryIntentRow(row);
    return row;
  }

  private completeOperationRecoveryIntentRow(
    intent: OperationRecoveryIntent,
    deliveryCount: number,
    now: number,
  ): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_alarm_intents
          SET state = 'completed', delivery_count = ?1, armed_at = NULL,
              last_error_code = NULL, updated_at = MAX(updated_at, ?2)
        WHERE operation_id = ?3 AND owner_generation = ?4 AND state = 'pending'`,
      deliveryCount,
      now,
      intent.operation_id,
      intent.owner_generation,
    );
    if (changedRowCount(this.storage) !== 1) {
      throw new ProtocolError("operation_recovery_intent_conflict", 409);
    }
  }

  private quarantineOperationRecoveryIntentRow(
    intent: OperationRecoveryIntent,
    now: number,
    errorCode: string,
    deliveryCount = intent.delivery_count,
  ): void {
    validateOperationRecoveryErrorCode(errorCode);
    if (
      !Number.isSafeInteger(deliveryCount) ||
      deliveryCount < 0 ||
      deliveryCount > RELAY_SHARD_ALARM_MAX_DELIVERIES
    ) {
      throw new ProtocolError("operation_recovery_intent_conflict", 409);
    }
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_alarm_intents
          SET state = 'quarantined', delivery_count = ?1, armed_at = NULL,
              last_error_code = ?2, updated_at = MAX(updated_at, ?3)
        WHERE operation_id = ?4 AND owner_generation = ?5 AND state = 'pending'`,
      deliveryCount,
      errorCode,
      now,
      intent.operation_id,
      intent.owner_generation,
    );
    if (changedRowCount(this.storage) !== 1) {
      throw new ProtocolError("operation_recovery_intent_conflict", 409);
    }
  }

  private insertOperation(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    status: OperationStatus,
    responseStatus: number | null,
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO cinatoken_shard_operations
         (protocol_version, operation_id, owner_generation, owner_lease_expires_at,
          operation_kind, provider_operation_id, admission_sha256, trace_id, envelope_sha256,
          dispatch_id, status, response_status, deadline_at,
          input_mode, input_sha256, input_size, input_content_type, request_object_key,
          object_version, shard_contract_version, ring_generation, shard_count, shard_index,
          instance_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
               ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?25)`,
      envelope.protocol_version,
      envelope.operation_id,
      envelope.owner_generation,
      envelope.owner_lease_expires_at,
      envelope.operation_kind,
      envelope.provider_operation_id,
      envelope.admission_sha256,
      envelope.trace_id,
      envelopeSha256,
      dispatchId,
      status,
      responseStatus,
      envelope.execution_deadline_at,
      envelope.input.mode,
      envelope.input.sha256,
      envelope.input.size,
      envelope.input.content_type,
      envelope.input.request_object_key ?? null,
      envelope.input.object_version ?? null,
      envelope.shard.contract_version,
      envelope.shard.ring_generation,
      envelope.shard.shard_count,
      envelope.shard.shard_index,
      envelope.shard.instance_name,
      now,
    );
  }

  private insertDispatch(
    dispatchId: string,
    operationId: string,
    envelopeSha256: string,
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO cinatoken_shard_dispatches
         (dispatch_id, operation_id, envelope_sha256, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
      dispatchId,
      operationId,
      envelopeSha256,
      now,
    );
  }
}

export function operationRecoveryIntentPayload(
  intent: OperationRecoveryIntent,
): RelayShardAlarmIntentV1 {
  validateOperationRecoveryIntentRow(intent);
  return buildRelayShardAlarmIntentV1(
    intent.operation_id,
    intent.owner_generation,
    intent.deadline_at,
    intent.delivery_generation,
    {
      contract_version: intent.shard_contract_version,
      ring_generation: intent.ring_generation,
      shard_count: intent.shard_count,
      shard_index: intent.shard_index,
      instance_name: intent.instance_name,
    },
  );
}

function validateOperationRecoveryIntentPayload(
  payload: RelayShardAlarmIntentV1,
): RelayShardAlarmIntentV1 {
  return buildRelayShardAlarmIntentV1(
    payload.operation_id,
    payload.owner_generation,
    payload.deadline_at,
    payload.delivery_generation,
    payload.shard,
  );
}

function validateOperationRecoveryIntentRow(row: OperationRecoveryIntent): void {
  operationRecoveryIntentPayloadFields(row);
  if (
    row.payload_version !== RELAY_SHARD_ALARM_INTENT_VERSION ||
    row.intent_kind !== RELAY_SHARD_ALARM_INTENT_KIND ||
    !Number.isSafeInteger(row.delivery_generation) ||
    row.delivery_generation < 1 ||
    row.delivery_generation > RELAY_SHARD_ALARM_MAX_DELIVERIES ||
    !Number.isSafeInteger(row.delivery_count) ||
    row.delivery_count < 0 ||
    row.delivery_count > row.delivery_generation ||
    row.delivery_generation - row.delivery_count > 1 ||
    !["pending", "completed", "quarantined"].includes(row.state) ||
    (row.armed_at !== null &&
      (!Number.isSafeInteger(row.armed_at) || row.armed_at < 1)) ||
    (row.state !== "pending" && row.armed_at !== null) ||
    !Number.isSafeInteger(row.next_delivery_at) ||
    row.next_delivery_at < 1 ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 1 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.created_at ||
    (row.last_error_code !== null && !validOperationRecoveryErrorCode(row.last_error_code))
  ) {
    throw new ProtocolError("operation_recovery_intent_corrupt", 500);
  }
}

function operationRecoveryIntentPayloadFields(
  row: OperationRecoveryIntent,
): RelayShardAlarmIntentV1 {
  try {
    return buildRelayShardAlarmIntentV1(
      row.operation_id,
      row.owner_generation,
      row.deadline_at,
      row.delivery_generation,
      {
        contract_version: row.shard_contract_version,
        ring_generation: row.ring_generation,
        shard_count: row.shard_count,
        shard_index: row.shard_index,
        instance_name: row.instance_name,
      },
    );
  } catch {
    throw new ProtocolError("operation_recovery_intent_corrupt", 500);
  }
}

function operationRecoveryIntentMatchesPayload(
  intent: OperationRecoveryIntent,
  payload: RelayShardAlarmIntentV1,
): boolean {
  return (
    intent.payload_version === payload.payload_version &&
    intent.intent_kind === payload.kind &&
    intent.operation_id === payload.operation_id &&
    intent.owner_generation === payload.owner_generation &&
    intent.deadline_at === payload.deadline_at &&
    intent.shard_contract_version === payload.shard.contract_version &&
    intent.ring_generation === payload.shard.ring_generation &&
    intent.shard_count === payload.shard.shard_count &&
    intent.shard_index === payload.shard.shard_index &&
    intent.instance_name === payload.shard.instance_name
  );
}

function operationRecoveryIntentMatchesOperation(
  intent: OperationRecoveryIntent,
  operation: StorageOperationRow,
): boolean {
  return (
    intent.operation_id === operation.operation_id &&
    intent.owner_generation === operation.owner_generation &&
    intent.deadline_at === operation.deadline_at &&
    operationShardsEqual(
      {
        contract_version: intent.shard_contract_version,
        ring_generation: intent.ring_generation,
        shard_count: intent.shard_count,
        shard_index: intent.shard_index,
        instance_name: intent.instance_name,
      },
      storageOperationShard(operation),
    )
  );
}

function storageOperationShard(operation: StorageOperationRow): OperationShard {
  return {
    contract_version: operation.shard_contract_version,
    ring_generation: operation.ring_generation,
    shard_count: operation.shard_count,
    shard_index: operation.shard_index,
    instance_name: operation.instance_name,
  };
}

function validateOperationRecoveryIdentity(
  operationId: string,
  ownerGeneration: number,
): void {
  if (
    operationId.length < 1 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(operationId) ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration < 1
  ) {
    throw new ProtocolError("invalid_operation_recovery_intent_query", 500);
  }
}

function validateOperationRecoveryNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new ProtocolError("invalid_operation_recovery_time", 500);
  }
}

function validateOperationRecoveryErrorCode(errorCode: string): void {
  if (!validOperationRecoveryErrorCode(errorCode)) {
    throw new ProtocolError("invalid_operation_recovery_error_code", 500);
  }
}

function validOperationRecoveryErrorCode(errorCode: string): boolean {
  return (
    errorCode.length >= 1 &&
    errorCode.length <= 96 &&
    /^[a-z0-9_]+$/.test(errorCode)
  );
}

function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === "completed" || status === "failed" || status === "recovery_required";
}

function terminalAckContractVersion(ack: TerminalAckRequest): 1 | 2 {
  return "provider_usage_binding" in ack ? 2 : 1;
}

function terminalAckPayloadJson(ack: TerminalAckRequest): string {
  return JSON.stringify({
    protocol_version: ack.protocol_version,
    billing_event_id: ack.billing_event_id,
    terminal_contract_sha256: ack.terminal_contract_sha256,
    reconciliation_id: ack.reconciliation_id,
    reconciliation_revision: ack.reconciliation_revision,
    predecessor_billing_event_id: ack.predecessor_billing_event_id,
    operation_id: ack.operation_id,
    owner_generation: ack.owner_generation,
    operation_from_status: ack.operation_from_status,
    operation_status: ack.operation_status,
    response_status: ack.response_status,
    response_code: ack.response_code,
    result: ack.result,
    shard: ack.shard,
    trace_id: ack.trace_id,
    ...("provider_usage_binding" in ack
      ? { provider_usage_binding: ack.provider_usage_binding }
      : {}),
  });
}

function terminalAckV3PayloadJson(ack: TerminalAckRequestV3): string {
  return JSON.stringify({
    protocol_version: ack.protocol_version,
    terminal_ack_contract_version: ack.terminal_ack_contract_version,
    financial_terminal_contract_version: ack.financial_terminal_contract_version,
    billing_event_id: ack.billing_event_id,
    terminal_contract_sha256: ack.terminal_contract_sha256,
    reconciliation_id: ack.reconciliation_id,
    reconciliation_revision: ack.reconciliation_revision,
    predecessor_billing_event_id: ack.predecessor_billing_event_id,
    operation_id: ack.operation_id,
    owner_generation: ack.owner_generation,
    operation_from_status: ack.operation_from_status,
    operation_status: ack.operation_status,
    response_status: ack.response_status,
    response_code: ack.response_code,
    result: ack.result,
    provider_usage_binding: ack.provider_usage_binding,
    provider_response_binding: ack.provider_response_binding,
    shard: ack.shard,
    trace_id: ack.trace_id,
  });
}

function terminalAckV3ProviderResponseBindingJson(ack: TerminalAckRequestV3): string {
  return JSON.stringify({
    attempt_generation: ack.provider_response_binding.attempt_generation,
    status: ack.provider_response_binding.status,
    response_class: ack.provider_response_binding.response_class,
    provider_status: ack.provider_response_binding.provider_status,
    client_status: ack.provider_response_binding.client_status,
    response_code: ack.provider_response_binding.response_code,
    provider_response_evidence_sha256:
      ack.provider_response_binding.provider_response_evidence_sha256,
    client_response_artifact_sha256:
      ack.provider_response_binding.client_response_artifact_sha256,
  });
}

function currentTerminalAckV3Matches(
  row: TerminalAckStateRow,
  ack: TerminalAckRequestV3,
  payloadJson: string,
  bindingJson: string,
): boolean {
  return (
    row.terminal_ack_contract_version === 3 &&
    row.financial_terminal_contract_version === 2 &&
    row.billing_event_id === ack.billing_event_id &&
    row.terminal_contract_sha256 === ack.terminal_contract_sha256 &&
    row.reconciliation_id === ack.reconciliation_id &&
    row.reconciliation_revision === ack.reconciliation_revision &&
    row.predecessor_billing_event_id === ack.predecessor_billing_event_id &&
    row.ack_payload_json === payloadJson &&
    row.provider_response_binding_json === bindingJson &&
    row.client_response_artifact_sha256 ===
      ack.provider_response_binding.client_response_artifact_sha256 &&
    row.final_acked_at !== null
  );
}

function canProgressRecoveryTerminalAckV3(
  row: TerminalAckStateRow,
  ack: TerminalAckRequestV3,
): boolean {
  if (
    ack.reconciliation_revision !== 2 ||
    ack.predecessor_billing_event_id === null ||
    row.billing_event_id !== ack.predecessor_billing_event_id ||
    row.reconciliation_id !== ack.reconciliation_id ||
    row.reconciliation_revision !== 1 ||
    row.predecessor_billing_event_id !== null ||
    row.recovery_payload_json !== row.ack_payload_json ||
    row.final_acked_at !== null ||
    row.compaction_authorized_at !== null ||
    ![1, 2].includes(row.terminal_ack_contract_version) ||
    row.financial_terminal_contract_version !== null ||
    row.provider_response_binding_json !== null ||
    row.client_response_artifact_sha256 !== null
  ) {
    return false;
  }
  const recovery = storedTerminalAck(row.recovery_payload_json);
  return (
    recovery !== null &&
    recovery.reconciliation_revision === 1 &&
    recovery.predecessor_billing_event_id === null &&
    recovery.operation_status === "recovery_required" &&
    recovery.billing_event_id === row.billing_event_id &&
    recovery.terminal_contract_sha256 === row.terminal_contract_sha256 &&
    recovery.reconciliation_id === ack.reconciliation_id &&
    terminalAckBaseIdentityMatches(recovery, ack)
  );
}

function terminalAckBaseIdentityMatches(
  left: TerminalAckRequest,
  right: TerminalAckRequestV3,
): boolean {
  return (
    left.protocol_version === right.protocol_version &&
    left.operation_id === right.operation_id &&
    left.owner_generation === right.owner_generation &&
    left.trace_id === right.trace_id &&
    left.shard.contract_version === right.shard.contract_version &&
    left.shard.ring_generation === right.shard.ring_generation &&
    left.shard.shard_count === right.shard.shard_count &&
    left.shard.shard_index === right.shard.shard_index &&
    left.shard.instance_name === right.shard.instance_name
  );
}

function terminalAckV3EvidenceIdentityMatches(
  operation: StorageOperationRow,
  attempt: ProviderAttemptRow,
  attachment: ProviderResponseArtifactAttachmentRow,
  ack: TerminalAckRequestV3,
): boolean {
  return (
    operation.protocol_version === ack.protocol_version &&
    operation.operation_id === ack.operation_id &&
    operation.owner_generation === ack.owner_generation &&
    operation.provider_operation_id === attempt.provider_operation_id &&
    operation.admission_sha256 === attempt.admission_sha256 &&
    operation.input_sha256 === attempt.request_sha256 &&
    operation.shard_contract_version === ack.shard.contract_version &&
    operation.ring_generation === ack.shard.ring_generation &&
    operation.shard_count === ack.shard.shard_count &&
    operation.shard_index === ack.shard.shard_index &&
    operation.instance_name === ack.shard.instance_name &&
    operation.trace_id === ack.trace_id &&
    attempt.operation_id === ack.operation_id &&
    attempt.owner_generation === ack.owner_generation &&
    attempt.attempt_generation === ack.provider_response_binding.attempt_generation &&
    attempt.egress_profile !== null &&
    attempt.egress_worker_version_id !== null &&
    attempt.dispatched_at !== null &&
    attachment.operation_id === attempt.operation_id &&
    attachment.owner_generation === attempt.owner_generation &&
    attachment.attempt_generation === attempt.attempt_generation &&
    attachment.provider_operation_id === attempt.provider_operation_id &&
    attachment.admission_sha256 === attempt.admission_sha256 &&
    attachment.request_sha256 === attempt.request_sha256 &&
    attachment.egress_profile === attempt.egress_profile &&
    attachment.egress_worker_version_id === attempt.egress_worker_version_id &&
    attachment.attached_at >= attempt.dispatched_at &&
    (attempt.status === "dispatched"
      ? attempt.terminal_at === null
      : attempt.terminal_at !== null && attempt.terminal_at >= attachment.attached_at)
  );
}

function terminalAckV3RequestEvidenceMatches(
  operation: StorageOperationRow,
  attempt: ProviderAttemptRow,
  attachment: ProviderResponseArtifactAttachmentRow,
  ack: TerminalAckRequestV3,
): boolean {
  const binding = ack.provider_response_binding;
  if (
    attachment.status !== binding.status ||
    attachment.provider_status !== binding.provider_status ||
    attachment.client_status !== binding.client_status ||
    attachment.response_class !== binding.response_class ||
    attachment.response_code !== binding.response_code ||
    attachment.raw_manifest === null ||
    attachment.client_manifest === null ||
    attachment.raw_manifest.provider_response_evidence_sha256 !==
      binding.provider_response_evidence_sha256 ||
    attachment.client_manifest.client_response_artifact_sha256 !==
      binding.client_response_artifact_sha256
  ) {
    return false;
  }

  const operationResult = operationStorageResult(operation);
  const attemptResult = operationStorageResult(attempt);
  if (binding.status === "succeeded") {
    const usage = ack.provider_usage_binding;
    return (
      usage !== null &&
      ack.result !== null &&
      operationResult !== null &&
      terminalAckResultMatches(operationResult, ack.result) &&
      usage.attempt_generation === attempt.attempt_generation &&
      usage.result_sha256 === operationResult.sha256 &&
      operation.provider_usage_receipt_sha256 === usage.receipt_sha256 &&
      attempt.provider_usage_receipt_sha256 === usage.receipt_sha256 &&
      attempt.provider_usage_receipt_attached_at !== null &&
      attempt.provider_usage_receipt_attached_at <= attachment.attached_at &&
      attachment.provider_usage_receipt_sha256 === usage.receipt_sha256 &&
      attachment.client_manifest.sha256 === operationResult.sha256 &&
      attachment.client_manifest.size === operationResult.size &&
      attachment.client_manifest.content_type === operationResult.content_type &&
      (attempt.status === "dispatched"
        ? attemptResult === null
        : attemptResult !== null && terminalAckResultMatches(attemptResult, operationResult))
    );
  }

  return (
    ack.provider_usage_binding === null &&
    ack.result === null &&
    operationResult === null &&
    attemptResult === null &&
    operation.provider_usage_receipt_sha256 === null &&
    attempt.provider_usage_receipt_sha256 === null &&
    attempt.provider_usage_receipt_attached_at === null &&
    attachment.provider_usage_receipt_sha256 === null
  );
}

function terminalAckV3SourceStateMatches(
  operation: StorageOperationRow,
  attempt: ProviderAttemptRow,
  ack: TerminalAckRequestV3,
): boolean {
  const targetAttemptStatus =
    ack.provider_response_binding.status === "succeeded"
      ? "succeeded"
      : "definite_reject";
  if (operation.status === ack.operation_status) {
    return attempt.status === targetAttemptStatus;
  }
  if (ack.reconciliation_revision === 1) {
    return (
      operation.status === "running" &&
      (attempt.status === "dispatched" || attempt.status === targetAttemptStatus)
    );
  }
  return (
    operation.status === "recovery_required" &&
    (attempt.status === "ambiguous" || attempt.status === targetAttemptStatus)
  );
}

function terminalAckV3ConvergedStateMatches(
  operation: StorageOperationRow,
  attempt: ProviderAttemptRow,
  retryState: ProviderRetryStateRow,
  state: TerminalAckStateRow,
  ack: TerminalAckRequestV3,
): boolean {
  const targetAttemptStatus =
    ack.provider_response_binding.status === "succeeded"
      ? "succeeded"
      : "definite_reject";
  const resultMatches = terminalAckResultMatches(
    operationStorageResult(operation),
    ack.result,
  );
  const attemptResultMatches = terminalAckResultMatches(
    operationStorageResult(attempt),
    ack.result,
  );
  return (
    currentTerminalAckV3Matches(
      state,
      ack,
      terminalAckV3PayloadJson(ack),
      terminalAckV3ProviderResponseBindingJson(ack),
    ) &&
    operation.status === ack.operation_status &&
    operation.response_status === ack.response_status &&
    operation.response_code === ack.response_code &&
    resultMatches &&
    attempt.status === targetAttemptStatus &&
    attempt.response_status === ack.response_status &&
    attempt.response_code === ack.response_code &&
    attemptResultMatches &&
    attempt.terminal_at !== null &&
    retryState.state === "terminal" &&
    retryState.active_attempt_generation === null &&
    retryState.next_attempt_at === null &&
    retryState.last_attempt_generation ===
      ack.provider_response_binding.attempt_generation &&
    retryState.global_terminal_event_id === ack.billing_event_id &&
    retryState.global_terminal_acked_at === state.final_acked_at
  );
}

function currentTerminalAckMatches(
  row: TerminalAckStateRow,
  ack: TerminalAckRequest,
  payloadJson: string,
): boolean {
  return (
    row.billing_event_id === ack.billing_event_id &&
    row.terminal_contract_sha256 === ack.terminal_contract_sha256 &&
    row.reconciliation_id === ack.reconciliation_id &&
    row.reconciliation_revision === ack.reconciliation_revision &&
    row.predecessor_billing_event_id === ack.predecessor_billing_event_id &&
    row.ack_payload_json === payloadJson
  );
}

function recoveryTerminalAckReplayMatches(
  row: TerminalAckStateRow,
  ack: TerminalAckRequest,
  payloadJson: string,
): boolean {
  return (
    ack.reconciliation_revision === 1 &&
    ack.operation_status === "recovery_required" &&
    row.reconciliation_revision === 2 &&
    row.final_acked_at !== null &&
    row.reconciliation_id === ack.reconciliation_id &&
    row.predecessor_billing_event_id === ack.billing_event_id &&
    row.recovery_payload_json === payloadJson
  );
}

function canProgressRecoveryTerminalAck(
  row: TerminalAckStateRow,
  ack: TerminalAckRequest,
): boolean {
  if (
    ack.reconciliation_revision !== 2 ||
    ack.predecessor_billing_event_id === null ||
    row.billing_event_id !== ack.predecessor_billing_event_id ||
    row.reconciliation_id !== ack.reconciliation_id ||
    row.reconciliation_revision !== 1 ||
    row.predecessor_billing_event_id !== null ||
    row.recovery_payload_json !== row.ack_payload_json ||
    row.final_acked_at !== null ||
    row.compaction_authorized_at !== null
  ) {
    return false;
  }
  const recovery = storedTerminalAck(row.recovery_payload_json);
  return (
    recovery !== null &&
    recovery.reconciliation_revision === 1 &&
    recovery.predecessor_billing_event_id === null &&
    recovery.operation_status === "recovery_required" &&
    recovery.billing_event_id === row.billing_event_id &&
    recovery.terminal_contract_sha256 === row.terminal_contract_sha256 &&
    recovery.reconciliation_id === ack.reconciliation_id &&
    terminalAckOperationIdentityMatches(recovery, ack)
  );
}

function storedTerminalAck(value: string | null): TerminalAckRequest | null {
  if (value === null) return null;
  try {
    return validateTerminalAckRequest(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function terminalAckOperationIdentityMatches(
  left: TerminalAckRequest,
  right: TerminalAckRequest,
): boolean {
  return (
    left.protocol_version === right.protocol_version &&
    left.operation_id === right.operation_id &&
    left.owner_generation === right.owner_generation &&
    left.trace_id === right.trace_id &&
    left.shard.contract_version === right.shard.contract_version &&
    left.shard.ring_generation === right.shard.ring_generation &&
    left.shard.shard_count === right.shard.shard_count &&
    left.shard.shard_index === right.shard.shard_index &&
    left.shard.instance_name === right.shard.instance_name &&
    terminalAckProviderUsageBindingsMatch(left, right)
  );
}

function terminalAckOperationMatches(
  operation: StorageOperationRow,
  providerAttempt: ProviderAttemptRow | null,
  ack: TerminalAckRequest,
): boolean {
  return (
    operation.protocol_version === ack.protocol_version &&
    operation.operation_id === ack.operation_id &&
    operation.owner_generation === ack.owner_generation &&
    operation.status === ack.operation_status &&
    operation.response_status === ack.response_status &&
    operation.response_code === ack.response_code &&
    operation.shard_contract_version === ack.shard.contract_version &&
    operation.ring_generation === ack.shard.ring_generation &&
    operation.shard_count === ack.shard.shard_count &&
    operation.shard_index === ack.shard.shard_index &&
    operation.instance_name === ack.shard.instance_name &&
    operation.trace_id === ack.trace_id &&
    (ack.operation_status !== "completed" ||
      (operation.operation_kind === "health_probe") === (ack.result === null)) &&
    terminalAckResultMatches(operationStorageResult(operation), ack.result) &&
    terminalAckProviderUsageBindingMatches(operation, providerAttempt, ack)
  );
}

function terminalAckProviderUsageBindingMatches(
  operation: StorageOperationRow,
  providerAttempt: ProviderAttemptRow | null,
  ack: TerminalAckRequest,
): boolean {
  const binding =
    ("provider_usage_binding" in ack ? ack.provider_usage_binding : null) ?? null;
  if (operation.provider_usage_receipt_sha256 === null) {
    return binding === null;
  }
  const result = operationStorageResult(operation);
  return (
    "provider_usage_binding" in ack &&
    binding !== null &&
    result !== null &&
    providerAttempt !== null &&
    providerAttempt.provider_usage_receipt_attached_at !== null &&
    providerAttempt.provider_usage_receipt_sha256 ===
      operation.provider_usage_receipt_sha256 &&
    binding.attempt_generation === providerAttempt.attempt_generation &&
    binding.receipt_sha256 === operation.provider_usage_receipt_sha256 &&
    binding.result_sha256 === result.sha256
  );
}

function terminalAckProviderUsageBindingsMatch(
  left: TerminalAckRequest,
  right: TerminalAckRequest,
): boolean {
  const leftBinding =
    ("provider_usage_binding" in left ? left.provider_usage_binding : null) ?? null;
  const rightBinding =
    ("provider_usage_binding" in right ? right.provider_usage_binding : null) ?? null;
  return (
    (leftBinding === null && rightBinding === null) ||
    (leftBinding !== null &&
      rightBinding !== null &&
      leftBinding.attempt_generation === rightBinding.attempt_generation &&
      leftBinding.receipt_sha256 === rightBinding.receipt_sha256 &&
      leftBinding.result_sha256 === rightBinding.result_sha256)
  );
}

function terminalAckResultMatches(
  left: StorageResultRecord | null,
  right: StorageResultRecord | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.object_key === right.object_key &&
      left.object_version === right.object_version &&
      left.sha256 === right.sha256 &&
      left.size === right.size &&
      left.content_type === right.content_type)
  );
}

function assertShardStateMatches(state: ShardStateRow, shard: OperationShard): void {
  if (
    state.instance_name !== shard.instance_name ||
    state.contract_version !== shard.contract_version ||
    state.ring_generation !== shard.ring_generation ||
    state.shard_count !== shard.shard_count ||
    state.shard_index !== shard.shard_index
  ) {
    throw new ProtocolError("stale_shard_fence", 409);
  }
}

function validateReadinessProbeJournalIdentity(
  probeId: string,
  claimDigestSha256: string,
  nowMs: number,
): void {
  if (
    !/^[0-9a-f]{64}$/.test(probeId) ||
    !/^[0-9a-f]{64}$/.test(claimDigestSha256) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 1 ||
    nowMs > MAX_UNIX_TIMESTAMP_MILLISECONDS
  ) {
    throw new ProtocolError("invalid_readiness_probe_journal", 400);
  }
}

function validateReadinessProbeWakeDeadline(
  nowMs: number,
  deadlineAtMs: number | null,
): asserts deadlineAtMs is number {
  if (
    deadlineAtMs === null ||
    !Number.isSafeInteger(deadlineAtMs) ||
    deadlineAtMs <= nowMs ||
    deadlineAtMs > nowMs + 5 * 60 * 1_000 ||
    deadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS >
      MAX_UNIX_TIMESTAMP_MILLISECONDS
  ) {
    throw new ProtocolError("invalid_readiness_probe_journal", 400);
  }
}

function validateReadinessProbeWakePermit(
  permit: ReadinessProbeWakePermit,
  completedAtMs: number,
): void {
  if (
    permit === null ||
    typeof permit !== "object" ||
    permit.kind !== "wake" ||
    !/^[0-9a-f]{64}$/.test(permit.probeId) ||
    !/^[0-9a-f]{64}$/.test(permit.claimDigestSha256) ||
    !Number.isSafeInteger(permit.generation) ||
    permit.generation < 1 ||
    !Number.isSafeInteger(permit.startedAtMs) ||
    permit.startedAtMs < 1 ||
    !Number.isSafeInteger(permit.deadlineAtMs) ||
    permit.deadlineAtMs <= permit.startedAtMs ||
    permit.deadlineAtMs > permit.startedAtMs + 5 * 60 * 1_000 ||
    !Number.isSafeInteger(permit.retentionUntilMs) ||
    permit.retentionUntilMs !==
      permit.deadlineAtMs + READINESS_PROBE_JOURNAL_RETENTION_MS ||
    permit.retentionUntilMs > MAX_UNIX_TIMESTAMP_MILLISECONDS ||
    !Number.isSafeInteger(completedAtMs) ||
    completedAtMs < permit.startedAtMs ||
    completedAtMs > permit.retentionUntilMs
  ) {
    throw new ProtocolError("invalid_readiness_probe_journal", 400);
  }
}

function validateReadinessJournalCompletion(
  completion: ReadinessProbeJournalCompletion,
  permit: ReadinessProbeWakePermit,
  completedAtMs: number,
): void {
  if (
    completion === null ||
    typeof completion !== "object" ||
    typeof completion.resultJson !== "string" ||
    !/^[0-9a-f]{64}$/.test(completion.resultSha256) ||
    typeof completion.resultCode !== "string" ||
    completion.resultCode.length < 1 ||
    completion.resultCode.length > 96 ||
    !/^[a-z0-9_:-]+$/.test(completion.resultCode) ||
    typeof completion.processReady !== "boolean" ||
    typeof completion.executionReady !== "boolean"
  ) {
    throw new ProtocolError("invalid_readiness_probe_result", 400);
  }
  parseCanonicalReadinessProbeResult(
    completion.resultJson,
    "invalid_readiness_probe_result",
    400,
  );
  try {
    readinessProbeReplay({
      probe_generation: permit.generation,
      phase: "complete",
      last_probe_id: permit.probeId,
      started_at_ms: permit.startedAtMs,
      deadline_at_ms: permit.deadlineAtMs,
      completed_at_ms: completedAtMs,
      result_code: completion.resultCode,
      container_status: completion.containerStatus,
      container_last_change_ms: completion.containerLastChangeMs,
      container_exit_code: completion.containerExitCode,
      runtime_protocol_version: completion.runtimeProtocolVersion,
      runtime_contract_version: completion.runtimeContractVersion,
      runtime_build_id: completion.runtimeBuildId,
      runtime_execution_enabled:
        completion.runtimeExecutionEnabled === null
          ? null
          : completion.runtimeExecutionEnabled
            ? 1
            : 0,
      process_ready: completion.processReady ? 1 : 0,
      execution_ready: completion.executionReady ? 1 : 0,
      last_ready_at_ms: completion.processReady ? completedAtMs : null,
    });
  } catch {
    throw new ProtocolError("invalid_readiness_probe_result", 400);
  }
}

async function readinessProbeJournalCompletedReplay(
  row: ReadinessProbeJournalRow,
): Promise<ReadinessProbeCompletedReplay> {
  if (
    row.state !== "completed" ||
    !/^[0-9a-f]{64}$/.test(row.probe_id) ||
    !/^[0-9a-f]{64}$/.test(row.claim_digest_sha256) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !Number.isSafeInteger(row.started_at_ms) ||
    row.started_at_ms < 1 ||
    !Number.isSafeInteger(row.deadline_at_ms) ||
    row.deadline_at_ms <= row.started_at_ms ||
    !Number.isSafeInteger(row.retention_until_ms) ||
    row.retention_until_ms <
      row.deadline_at_ms + READINESS_PROBE_JOURNAL_RETENTION_MS ||
    row.retention_until_ms > MAX_UNIX_TIMESTAMP_MILLISECONDS ||
    row.completed_at_ms === null ||
    !Number.isSafeInteger(row.completed_at_ms) ||
    row.completed_at_ms < row.started_at_ms ||
    row.completed_at_ms > row.deadline_at_ms ||
    row.ambiguous_at_ms !== null ||
    row.result_json === null ||
    row.result_sha256 === null ||
    !/^[0-9a-f]{64}$/.test(row.result_sha256) ||
    row.result_size_bytes === null ||
    !Number.isSafeInteger(row.result_size_bytes)
  ) {
    throw new ProtocolError("readiness_probe_result_corrupt", 500);
  }
  const resultSizeBytes = new TextEncoder().encode(row.result_json).byteLength;
  if (
    resultSizeBytes !== row.result_size_bytes ||
    resultSizeBytes < 2 ||
    resultSizeBytes > READINESS_PROBE_RESULT_JSON_MAX_BYTES
  ) {
    throw new ProtocolError("readiness_probe_result_corrupt", 500);
  }
  parseCanonicalReadinessProbeResult(
    row.result_json,
    "readiness_probe_result_corrupt",
    500,
  );
  if ((await sha256Utf8(row.result_json)) !== row.result_sha256) {
    throw new ProtocolError("readiness_probe_result_corrupt", 500);
  }
  return {
    kind: "completed",
    probeId: row.probe_id,
    claimDigestSha256: row.claim_digest_sha256,
    generation: row.generation,
    startedAtMs: row.started_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    retentionUntilMs: row.retention_until_ms,
    completedAtMs: row.completed_at_ms,
    resultJson: row.result_json,
    resultSha256: row.result_sha256,
  };
}

function parseCanonicalReadinessProbeResult(
  resultJson: string,
  errorCode: string,
  status: number,
): Record<string, unknown> {
  const size = new TextEncoder().encode(resultJson).byteLength;
  if (size < 2 || size > READINESS_PROBE_RESULT_JSON_MAX_BYTES) {
    throw new ProtocolError(errorCode, status);
  }
  try {
    const value = JSON.parse(resultJson) as unknown;
    if (!isRecord(value) || JSON.stringify(value) !== resultJson) {
      throw new Error("non-canonical readiness result");
    }
    return value;
  } catch {
    throw new ProtocolError(errorCode, status);
  }
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readinessSnapshot(row: ReadinessRow | null): PersistedReadinessSnapshot {
  if (row === null) {
    return {
      generation: 0,
      phase: "idle",
      last_probe_id: null,
      started_at_ms: null,
      deadline_at_ms: null,
      completed_at_ms: null,
      result_code: null,
      container_status: null,
      container_last_change_ms: null,
      container_exit_code: null,
      runtime_protocol_version: null,
      runtime_contract_version: null,
      runtime_execution_enabled: null,
      last_ready_at_ms: null,
    };
  }
  return {
    generation: row.probe_generation,
    phase: row.phase,
    last_probe_id: row.last_probe_id,
    started_at_ms: row.started_at_ms,
    deadline_at_ms: row.deadline_at_ms,
    completed_at_ms: row.completed_at_ms,
    result_code: row.result_code,
    container_status: row.container_status,
    container_last_change_ms: row.container_last_change_ms,
    container_exit_code: row.container_exit_code,
    runtime_protocol_version: row.runtime_protocol_version,
    runtime_contract_version: row.runtime_contract_version,
    runtime_execution_enabled:
      row.runtime_execution_enabled === null ? null : row.runtime_execution_enabled === 1,
    last_ready_at_ms: row.last_ready_at_ms,
  };
}

function readinessProbeReplay(row: ReadinessRow): ReadinessProbeReplay {
  const containerStatus = row.container_status;
  const validContainerStatus =
    containerStatus === null ||
    ["running", "healthy", "stopping", "stopped", "stopped_with_code"].includes(
      containerStatus,
    );
  const runtimeAbsent =
    row.runtime_protocol_version === null &&
    row.runtime_contract_version === null &&
    row.runtime_build_id === null &&
    row.runtime_execution_enabled === null;
  const runtimePresent =
    Number.isSafeInteger(row.runtime_protocol_version) &&
    (row.runtime_protocol_version ?? 0) > 0 &&
    Number.isSafeInteger(row.runtime_contract_version) &&
    (row.runtime_contract_version ?? 0) > 0 &&
    (row.runtime_build_id === null || /^[0-9a-f]{64}$/.test(row.runtime_build_id)) &&
    (row.runtime_execution_enabled === 0 || row.runtime_execution_enabled === 1);
  if (
    row.phase !== "complete" ||
    row.completed_at_ms === null ||
    row.completed_at_ms <= 0 ||
    row.result_code === null ||
    !validContainerStatus ||
    (containerStatus === null) !== (row.container_last_change_ms === null) ||
    (containerStatus !== "stopped_with_code" && row.container_exit_code !== null) ||
    (row.process_ready !== 0 && row.process_ready !== 1) ||
    (row.execution_ready !== 0 && row.execution_ready !== 1) ||
    (!runtimeAbsent && !runtimePresent) ||
    (row.execution_ready === 1 &&
      (row.process_ready !== 1 || row.runtime_execution_enabled !== 1))
  ) {
    throw new ProtocolError("readiness_probe_replay_invalid", 500);
  }
  return {
    completedAtMs: row.completed_at_ms,
    resultCode: row.result_code,
    containerStatus: containerStatus as ReadinessProbeReplay["containerStatus"],
    containerLastChangeMs: row.container_last_change_ms,
    containerExitCode: row.container_exit_code,
    runtimeProtocolVersion: row.runtime_protocol_version,
    runtimeContractVersion: row.runtime_contract_version,
    runtimeBuildId: row.runtime_build_id,
    runtimeExecutionEnabled:
      row.runtime_execution_enabled === null ? null : row.runtime_execution_enabled === 1,
    processReady: row.process_ready === 1,
    executionReady: row.execution_ready === 1,
  };
}

function storageGrant(
  row: StorageOperationRow,
  providerAttempt: ProviderAttemptRow | null,
): StorageAccessGrant {
  const result = operationStorageResult(row);
  return {
    protocol_version: row.protocol_version,
    operation_id: row.operation_id,
    owner_generation: row.owner_generation,
    owner_lease_expires_at: row.owner_lease_expires_at,
    operation_kind: row.operation_kind,
    provider_operation_id: row.provider_operation_id,
    admission_sha256: row.admission_sha256,
    deadline_at: row.deadline_at,
    input: {
      mode: row.input_mode as "inline" | "r2",
      sha256: row.input_sha256,
      size: row.input_size,
      content_type: row.input_content_type,
      request_object_key: row.request_object_key,
      object_version: row.object_version,
    },
    shard: {
      contract_version: row.shard_contract_version,
      ring_generation: row.ring_generation,
      shard_count: row.shard_count,
      shard_index: row.shard_index,
      instance_name: row.instance_name,
    },
    trace_id: row.trace_id,
    result,
    provider_usage_receipt_sha256: row.provider_usage_receipt_sha256,
    provider_attempt:
      providerAttempt === null
        ? null
        : {
            attempt_generation: providerAttempt.attempt_generation,
            provider_operation_id: providerAttempt.provider_operation_id,
            admission_sha256: providerAttempt.admission_sha256,
            request_sha256: providerAttempt.request_sha256,
            egress_profile: providerAttempt.egress_profile,
            egress_worker_version_id: providerAttempt.egress_worker_version_id,
            status: providerAttempt.status,
            response_status: providerAttempt.response_status,
            provider_usage_receipt_sha256:
              providerAttempt.provider_usage_receipt_sha256,
            provider_usage_receipt_attached_at:
              providerAttempt.provider_usage_receipt_attached_at,
          },
  };
}

export function operationStorageResult(
  row: Pick<
    OperationRow,
    | "result_object_key"
    | "result_object_version"
    | "result_sha256"
    | "result_size"
    | "result_content_type"
  >,
): StorageResultRecord | null {
  const resultValues = [
    row.result_object_key,
    row.result_object_version,
    row.result_sha256,
    row.result_size,
    row.result_content_type,
  ];
  const resultAbsent = resultValues.every((value) => value === null);
  const resultComplete = resultValues.every((value) => value !== null);
  if (!resultAbsent && !resultComplete) {
    throw new ProtocolError("storage_result_corrupt", 503);
  }
  const result = resultComplete
    ? {
        object_key: row.result_object_key!,
        object_version: row.result_object_version!,
        sha256: row.result_sha256!,
        size: row.result_size!,
        content_type: row.result_content_type!,
      }
    : null;
  if (result !== null) validateStorageResult(result);
  return result;
}

function validateStorageResult(result: StorageResultRecord): void {
  if (
    result.object_key.length < 1 ||
    result.object_key.length > 1024 ||
    !/^[A-Za-z0-9/_.:-]+$/.test(result.object_key) ||
    result.object_version.length < 1 ||
    result.object_version.length > MAX_STORAGE_OBJECT_VERSION_BYTES ||
    !/^[A-Za-z0-9._:-]+$/.test(result.object_version) ||
    !/^[0-9a-f]{64}$/.test(result.sha256) ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    result.size > 64 * 1024 * 1024 ||
    result.content_type.length < 3 ||
    result.content_type.length > 128 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(
      result.content_type,
    )
  ) {
    throw new ProtocolError("invalid_storage_result", 400);
  }
}

function storageResultMatches(
  left: StorageResultRecord | null,
  right: StorageResultRecord,
): boolean {
  return (
    left !== null &&
    left.object_key === right.object_key &&
    left.object_version === right.object_version &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.content_type === right.content_type
  );
}

function storageResultBodyMatches(
  result: StorageResultRecord,
  manifest: ClientResponseArtifactManifest,
): boolean {
  return (
    result.sha256 === manifest.sha256 &&
    result.size === manifest.size &&
    result.content_type === manifest.content_type
  );
}

function validateProviderResponseArtifactAttachment(
  operationId: string,
  ownerGeneration: number,
  attemptGeneration: number,
  attachment: ProviderResponseArtifactAttachment,
): void {
  if (
    !isRecord(attachment) ||
    !hasExactKeys(attachment, [
      "status",
      "provider_status",
      "client_status",
      "response_class",
      "response_code",
      "raw_manifest",
      "client_manifest",
      "provider_usage_receipt_sha256",
    ]) ||
    (attachment.provider_usage_receipt_sha256 !== null &&
      (typeof attachment.provider_usage_receipt_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(attachment.provider_usage_receipt_sha256)))
  ) {
    throw new ProtocolError("invalid_provider_response_attachment", 400);
  }

  const hasArtifacts =
    validProviderResponseEvidenceManifest(
      attachment.raw_manifest,
      operationId,
      ownerGeneration,
      attemptGeneration,
    ) &&
    validClientResponseArtifactManifest(
      attachment.client_manifest,
      operationId,
      ownerGeneration,
    );
  const validSuccess =
    attachment.status === "succeeded" &&
    attachment.provider_status === 200 &&
    attachment.client_status === 200 &&
    attachment.response_class === "success" &&
    attachment.response_code === null &&
    hasArtifacts;
  const validInterpretedReject =
    attachment.status === "interpreted_reject" &&
    validResponseCode(attachment.response_code) &&
    attachment.provider_usage_receipt_sha256 === null &&
    hasArtifacts &&
    ((attachment.response_class === "typed_error" &&
      attachment.provider_status === 200 &&
      attachment.client_status === 200) ||
      (attachment.response_class === "http_error" &&
        Number.isSafeInteger(attachment.provider_status) &&
        attachment.provider_status >= 100 &&
        attachment.provider_status <= 599 &&
        attachment.provider_status !== 200 &&
        attachment.client_status === attachment.provider_status) ||
      (attachment.response_class === "invalid_body" &&
        attachment.provider_status === 200 &&
        attachment.client_status === 500));
  const validAmbiguous =
    attachment.status === "ambiguous" &&
    attachment.provider_status === null &&
    attachment.client_status === null &&
    attachment.response_class === null &&
    validResponseCode(attachment.response_code) &&
    attachment.raw_manifest === null &&
    attachment.client_manifest === null &&
    attachment.provider_usage_receipt_sha256 === null;
  if (!validSuccess && !validInterpretedReject && !validAmbiguous) {
    throw new ProtocolError("invalid_provider_response_attachment", 400);
  }
}

function validProviderResponseEvidenceManifest(
  value: unknown,
  operationId: string,
  ownerGeneration: number,
  attemptGeneration: number,
): value is ProviderResponseEvidenceManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "object_key",
      "object_version",
      "provider_response_evidence_sha256",
      "sha256",
      "size",
      "content_type",
    ]) ||
    typeof value.object_key !== "string" ||
    typeof value.object_version !== "string" ||
    typeof value.provider_response_evidence_sha256 !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.size !== "number" ||
    typeof value.content_type !== "string"
  ) {
    return false;
  }
  return (
    value.object_key ===
      `container-provider-evidence/v1/${operationId}/${ownerGeneration}/${attemptGeneration}/${value.sha256}` &&
    validResponseArtifactObjectVersion(value.object_version) &&
    /^[0-9a-f]{64}$/.test(value.provider_response_evidence_sha256) &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= 4_194_304 &&
    validResponseArtifactContentType(value.content_type)
  );
}

function validClientResponseArtifactManifest(
  value: unknown,
  operationId: string,
  ownerGeneration: number,
): value is ClientResponseArtifactManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "object_key",
      "object_version",
      "client_response_artifact_sha256",
      "sha256",
      "size",
      "content_type",
    ]) ||
    typeof value.object_key !== "string" ||
    typeof value.object_version !== "string" ||
    typeof value.client_response_artifact_sha256 !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.size !== "number" ||
    value.content_type !== "application/json"
  ) {
    return false;
  }
  return (
    value.object_key ===
      `container-client-artifacts/v1/${operationId}/${ownerGeneration}/${value.client_response_artifact_sha256}` &&
    validResponseArtifactObjectVersion(value.object_version) &&
    /^[0-9a-f]{64}$/.test(value.client_response_artifact_sha256) &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 2 &&
    value.size <= 4_194_304
  );
}

function validResponseArtifactObjectVersion(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validResponseArtifactContentType(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 128 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(value)
  );
}

function providerResponseArtifactAttachmentRow(
  row: ProviderResponseArtifactAttachmentSqlRow,
): ProviderResponseArtifactAttachmentRow {
  let attachment: ProviderResponseArtifactAttachment;
  try {
    if (row.status === "ambiguous") {
      if (
        row.provider_status !== null ||
        row.client_status !== null ||
        row.response_class !== null ||
        row.response_code === null ||
        row.provider_response_evidence_sha256 !== null ||
        row.raw_object_key !== null ||
        row.raw_object_version !== null ||
        row.raw_sha256 !== null ||
        row.raw_size !== null ||
        row.raw_content_type !== null ||
        row.client_response_artifact_sha256 !== null ||
        row.client_object_key !== null ||
        row.client_object_version !== null ||
        row.client_sha256 !== null ||
        row.client_size !== null ||
        row.client_content_type !== null ||
        row.provider_usage_receipt_sha256 !== null
      ) {
        throw new Error("invalid ambiguous attachment");
      }
      attachment = {
        status: "ambiguous",
        provider_status: null,
        client_status: null,
        response_class: null,
        response_code: row.response_code,
        raw_manifest: null,
        client_manifest: null,
        provider_usage_receipt_sha256: null,
      };
    } else {
      if (
        row.provider_status === null ||
        row.client_status === null ||
        row.response_class === null ||
        row.provider_response_evidence_sha256 === null ||
        row.raw_object_key === null ||
        row.raw_object_version === null ||
        row.raw_sha256 === null ||
        row.raw_size === null ||
        row.raw_content_type === null ||
        row.client_response_artifact_sha256 === null ||
        row.client_object_key === null ||
        row.client_object_version === null ||
        row.client_sha256 === null ||
        row.client_size === null ||
        row.client_content_type !== "application/json"
      ) {
        throw new Error("incomplete response artifact attachment");
      }
      const rawManifest: ProviderResponseEvidenceManifest = {
        object_key: row.raw_object_key,
        object_version: row.raw_object_version,
        provider_response_evidence_sha256:
          row.provider_response_evidence_sha256,
        sha256: row.raw_sha256,
        size: row.raw_size,
        content_type: row.raw_content_type,
      };
      const clientManifest: ClientResponseArtifactManifest = {
        object_key: row.client_object_key,
        object_version: row.client_object_version,
        client_response_artifact_sha256:
          row.client_response_artifact_sha256,
        sha256: row.client_sha256,
        size: row.client_size,
        content_type: row.client_content_type,
      };
      if (row.status === "succeeded") {
        if (
          row.provider_status !== 200 ||
          row.client_status !== 200 ||
          row.response_class !== "success" ||
          row.response_code !== null
        ) {
          throw new Error("invalid succeeded attachment");
        }
        attachment = {
          status: "succeeded",
          provider_status: 200,
          client_status: 200,
          response_class: "success",
          response_code: null,
          raw_manifest: rawManifest,
          client_manifest: clientManifest,
          provider_usage_receipt_sha256:
            row.provider_usage_receipt_sha256,
        };
      } else {
        if (
          row.response_class === "success" ||
          row.response_code === null ||
          row.provider_usage_receipt_sha256 !== null
        ) {
          throw new Error("invalid interpreted rejection attachment");
        }
        attachment = {
          status: "interpreted_reject",
          provider_status: row.provider_status,
          client_status: row.client_status,
          response_class: row.response_class,
          response_code: row.response_code,
          raw_manifest: rawManifest,
          client_manifest: clientManifest,
          provider_usage_receipt_sha256: null,
        };
      }
    }
    validateProviderAttemptCommand(
      row.operation_id,
      row.owner_generation,
      row.attached_at,
      row.attempt_generation,
    );
    if (
      row.attached_at > MAX_UNIX_TIMESTAMP_SECONDS ||
      row.provider_operation_id.length < 1 ||
      row.provider_operation_id.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(row.provider_operation_id) ||
      !/^[0-9a-f]{64}$/.test(row.admission_sha256) ||
      !/^[0-9a-f]{64}$/.test(row.request_sha256) ||
      row.egress_profile !== "openai-chat-completions-canary-v1" ||
      row.egress_worker_version_id.length < 1 ||
      row.egress_worker_version_id.length > 128 ||
      !/^[A-Za-z0-9._:/@-]+$/.test(row.egress_worker_version_id)
    ) {
      throw new Error("invalid attachment identity");
    }
    validateProviderResponseArtifactAttachment(
      row.operation_id,
      row.owner_generation,
      row.attempt_generation,
      attachment,
    );
  } catch {
    throw new ProtocolError("provider_response_attachment_corrupt", 503);
  }
  return {
    ...attachment,
    operation_id: row.operation_id,
    owner_generation: row.owner_generation,
    attempt_generation: row.attempt_generation,
    provider_operation_id: row.provider_operation_id,
    admission_sha256: row.admission_sha256,
    request_sha256: row.request_sha256,
    egress_profile: row.egress_profile,
    egress_worker_version_id: row.egress_worker_version_id,
    attached_at: row.attached_at,
  };
}

function providerResponseArtifactAttachmentMatches(
  row: ProviderResponseArtifactAttachmentRow,
  attachment: ProviderResponseArtifactAttachment,
): boolean {
  return (
    row.status === attachment.status &&
    row.provider_status === attachment.provider_status &&
    row.client_status === attachment.client_status &&
    row.response_class === attachment.response_class &&
    row.response_code === attachment.response_code &&
    row.provider_usage_receipt_sha256 ===
      attachment.provider_usage_receipt_sha256 &&
    providerResponseEvidenceManifestMatches(
      row.raw_manifest,
      attachment.raw_manifest,
    ) &&
    clientResponseArtifactManifestMatches(
      row.client_manifest,
      attachment.client_manifest,
    )
  );
}

function providerResponseEvidenceManifestMatches(
  left: ProviderResponseEvidenceManifest | null,
  right: ProviderResponseEvidenceManifest | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.object_key === right.object_key &&
      left.object_version === right.object_version &&
      left.provider_response_evidence_sha256 ===
        right.provider_response_evidence_sha256 &&
      left.sha256 === right.sha256 &&
      left.size === right.size &&
      left.content_type === right.content_type)
  );
}

function clientResponseArtifactManifestMatches(
  left: ClientResponseArtifactManifest | null,
  right: ClientResponseArtifactManifest | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.object_key === right.object_key &&
      left.object_version === right.object_version &&
      left.client_response_artifact_sha256 ===
        right.client_response_artifact_sha256 &&
      left.sha256 === right.sha256 &&
      left.size === right.size &&
      left.content_type === right.content_type)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function validateProviderAttemptCommand(
  operationId: string,
  ownerGeneration: number,
  now: number,
  attemptGeneration?: number,
): void {
  if (
    operationId.length < 1 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(operationId) ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration < 1 ||
    !Number.isSafeInteger(now) ||
    now < 1 ||
    (attemptGeneration !== undefined &&
      (!Number.isSafeInteger(attemptGeneration) ||
        attemptGeneration < 1 ||
        attemptGeneration > 3))
  ) {
    throw new ProtocolError("invalid_provider_attempt", 400);
  }
}

function validateProviderAttemptTerminal(terminal: ProviderAttemptTerminal): void {
  if (
    (terminal.status === "succeeded" &&
      (!Number.isSafeInteger(terminal.response_status) ||
        terminal.response_status < 200 ||
        terminal.response_status > 299 ||
        terminal.response_code !== null)) ||
    (terminal.status === "definite_reject" &&
      (!Number.isSafeInteger(terminal.response_status) ||
        terminal.response_status < 400 ||
        terminal.response_status > 599 ||
        !validResponseCode(terminal.response_code))) ||
    (terminal.status === "ambiguous" &&
      (terminal.response_status !== 202 || !validResponseCode(terminal.response_code)))
  ) {
    throw new ProtocolError("invalid_provider_attempt_outcome", 400);
  }
}

function validateProviderRetryPolicy(policy: ProviderRetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 3 ||
    (!policy.retryEnabled && policy.maxAttempts !== 1)
  ) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
}

function validateProviderEgressIdentity(identity: ProviderEgressIdentity): void {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity)
  ) {
    throw new ProtocolError("invalid_provider_egress_identity", 400);
  }
  const keys = Object.keys(identity).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "profile" ||
    keys[1] !== "worker_version_id" ||
    typeof identity.profile !== "string" ||
    identity.profile.length < 1 ||
    identity.profile.length > 64 ||
    !/^[A-Za-z0-9._:/@-]+$/.test(identity.profile) ||
    typeof identity.worker_version_id !== "string" ||
    identity.worker_version_id.length < 1 ||
    identity.worker_version_id.length > 128 ||
    !/^[A-Za-z0-9._:/@-]+$/.test(identity.worker_version_id)
  ) {
    throw new ProtocolError("invalid_provider_egress_identity", 400);
  }
}

function providerEgressIdentityMatches(
  row: ProviderAttemptRow,
  identity: ProviderEgressIdentity,
): boolean {
  return (
    row.egress_profile === identity.profile &&
    row.egress_worker_version_id === identity.worker_version_id
  );
}

function validateProviderAttemptRow(row: ProviderAttemptRow): void {
  validateProviderAttemptCommand(
    row.operation_id,
    row.owner_generation,
    row.prepared_at,
    row.attempt_generation,
  );
  if (
    row.provider_operation_id.length < 1 ||
    row.provider_operation_id.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(row.provider_operation_id) ||
    !/^[0-9a-f]{64}$/.test(row.admission_sha256) ||
    !/^[0-9a-f]{64}$/.test(row.request_sha256) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.prepared_at ||
    (row.dispatched_at !== null &&
      (!Number.isSafeInteger(row.dispatched_at) || row.dispatched_at < row.prepared_at)) ||
    (row.terminal_at !== null &&
      (!Number.isSafeInteger(row.terminal_at) ||
        row.terminal_at < row.prepared_at ||
        (row.dispatched_at !== null && row.terminal_at < row.dispatched_at)))
  ) {
    throw new ProtocolError("provider_attempt_corrupt", 503);
  }
  const hasLegacyEgressIdentity =
    row.egress_profile === null && row.egress_worker_version_id === null;
  const hasVersionedEgressIdentity =
    row.egress_profile !== null &&
    row.egress_worker_version_id !== null &&
    row.egress_profile.length <= 64 &&
    /^[A-Za-z0-9._:/@-]+$/.test(row.egress_profile) &&
    row.egress_worker_version_id.length <= 128 &&
    /^[A-Za-z0-9._:/@-]+$/.test(row.egress_worker_version_id);
  const hasNoUsageReceipt =
    row.provider_usage_receipt_sha256 === null &&
    row.provider_usage_receipt_attached_at === null;
  const hasUsageReceipt =
    row.provider_usage_receipt_sha256 !== null &&
    /^[0-9a-f]{64}$/.test(row.provider_usage_receipt_sha256) &&
    row.provider_usage_receipt_attached_at !== null &&
    Number.isSafeInteger(row.provider_usage_receipt_attached_at) &&
    row.dispatched_at !== null &&
    row.provider_usage_receipt_attached_at >= row.dispatched_at &&
    (row.terminal_at === null || row.provider_usage_receipt_attached_at <= row.terminal_at);
  if (
    (!hasLegacyEgressIdentity && !hasVersionedEgressIdentity) ||
    ((row.status === "prepared" || row.status === "cancelled") &&
      !hasLegacyEgressIdentity) ||
    (!hasNoUsageReceipt && !hasUsageReceipt) ||
    (hasUsageReceipt && !hasVersionedEgressIdentity)
  ) {
    throw new ProtocolError("provider_attempt_corrupt", 503);
  }
  const result = operationStorageResult(row);
  if (
    (result !== null &&
      result.object_key !==
        `container-results/v1/${row.operation_id}/${row.owner_generation}/${result.sha256}`) ||
    (row.status === "prepared" &&
      (row.dispatched_at !== null ||
        row.terminal_at !== null ||
        row.response_status !== null ||
        row.response_code !== null ||
        result !== null ||
        !hasNoUsageReceipt ||
        row.updated_at !== row.prepared_at)) ||
    (row.status === "dispatched" &&
      (row.dispatched_at === null ||
        row.terminal_at !== null ||
        row.response_status !== null ||
        row.response_code !== null ||
        result !== null ||
        row.updated_at !== row.dispatched_at)) ||
    (row.status === "succeeded" &&
      (row.dispatched_at === null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status === null ||
        row.response_status < 200 ||
        row.response_status > 299 ||
        row.response_code !== null ||
        result === null ||
        (!hasUsageReceipt && !hasNoUsageReceipt))) ||
    (row.status === "definite_reject" &&
      (row.dispatched_at === null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status === null ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code) ||
        result !== null ||
        !hasNoUsageReceipt)) ||
    (row.status === "ambiguous" &&
      (row.dispatched_at === null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status !== 202 ||
        !validResponseCode(row.response_code) ||
        (result === null && !hasNoUsageReceipt) ||
        (result !== null && !hasNoUsageReceipt && !hasUsageReceipt))) ||
    (row.status === "cancelled" &&
      (row.dispatched_at !== null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status === null ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code) ||
        result !== null ||
        !hasNoUsageReceipt))
  ) {
    throw new ProtocolError("provider_attempt_corrupt", 503);
  }
}

function matchesActiveProviderAttempt(status: ProviderAttemptStatus): boolean {
  return status === "prepared" || status === "dispatched";
}

function providerAttemptTerminalMatches(
  row: ProviderAttemptRow,
  terminal: ProviderAttemptTerminal,
): boolean {
  return (
    row.status === terminal.status &&
    row.response_status === terminal.response_status &&
    row.response_code === terminal.response_code
  );
}

function validResponseCode(value: string | null): value is string {
  return value !== null && value.length >= 1 && value.length <= 64 && /^[a-z0-9_:-]+$/.test(value);
}

function validatePolicy(policy: RelayShardLedgerPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxInFlight) ||
    policy.maxInFlight < 1 ||
    !Number.isSafeInteger(policy.dispatchRetentionSeconds) ||
    policy.dispatchRetentionSeconds < 1 ||
    !Number.isSafeInteger(policy.terminalRetentionSeconds) ||
    policy.terminalRetentionSeconds < policy.dispatchRetentionSeconds ||
    !Number.isSafeInteger(policy.maxTerminalOperations) ||
    policy.maxTerminalOperations < 1 ||
    typeof policy.globalTerminalCompactionEnabled !== "boolean"
  ) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
}

function validateOperationRingAdmission(
  envelope: OperationEnvelope,
  admission: OperationRingAdmission,
): void {
  if (
    admission === null ||
    typeof admission !== "object" ||
    !["current", "previous_admit", "previous_replay_only"].includes(admission.role)
  ) {
    throw new ProtocolError("invalid_ring_admission", 400);
  }
  validateConfiguredRingTransition(admission.transition);
  if (admission.transition === null) {
    if (admission.role !== "current") {
      throw new ProtocolError("invalid_ring_admission", 400);
    }
    return;
  }
  const transition = admission.transition;
  const matchesCurrent =
    envelope.shard.ring_generation === transition.current_ring_generation &&
    envelope.shard.shard_count === transition.current_shard_count;
  const matchesPrevious =
    envelope.shard.ring_generation === transition.previous_ring_generation &&
    envelope.shard.shard_count === transition.previous_shard_count;
  if (
    (admission.role === "current" && !matchesCurrent) ||
    (admission.role === "previous_admit" &&
      (!matchesPrevious || !transition.admission_open)) ||
    (admission.role === "previous_replay_only" &&
      (!matchesPrevious || transition.admission_open))
  ) {
    throw new ProtocolError("invalid_ring_admission", 400);
  }
}

function validateConfiguredRingTransition(
  transition: ConfiguredRingTransition | null,
): void {
  if (transition === null) return;
  if (
    !Number.isSafeInteger(transition.current_ring_generation) ||
    transition.current_ring_generation < 2 ||
    !Number.isSafeInteger(transition.current_shard_count) ||
    transition.current_shard_count < 2 ||
    transition.current_shard_count > 1024 ||
    !Number.isSafeInteger(transition.previous_ring_generation) ||
    transition.previous_ring_generation < 1 ||
    transition.previous_ring_generation + 1 !== transition.current_ring_generation ||
    !Number.isSafeInteger(transition.previous_shard_count) ||
    transition.previous_shard_count < 1 ||
    transition.previous_shard_count >= transition.current_shard_count ||
    !Number.isSafeInteger(transition.admission_started_at) ||
    transition.admission_started_at < 1 ||
    !Number.isSafeInteger(transition.admission_until) ||
    transition.admission_until <= transition.admission_started_at ||
    transition.admission_until - transition.admission_started_at >
      MAX_PREVIOUS_RING_ADMISSION_WINDOW_SECONDS ||
    typeof transition.admission_open !== "boolean"
  ) {
    throw new ProtocolError("invalid_ring_transition", 400);
  }
}

function ringTransitionAllowsOverlap(
  state: ShardStateRow,
  shard: OperationShard,
  transition: ConfiguredRingTransition | null,
): boolean {
  if (transition === null) return false;
  const stateIsCurrent =
    state.ring_generation === transition.current_ring_generation &&
    state.shard_count === transition.current_shard_count;
  const stateIsPrevious =
    state.ring_generation === transition.previous_ring_generation &&
    state.shard_count === transition.previous_shard_count;
  const shardIsCurrent =
    shard.ring_generation === transition.current_ring_generation &&
    shard.shard_count === transition.current_shard_count;
  const shardIsPrevious =
    shard.ring_generation === transition.previous_ring_generation &&
    shard.shard_count === transition.previous_shard_count;
  return (stateIsCurrent && shardIsPrevious) || (stateIsPrevious && shardIsCurrent);
}

function firstRow<T>(cursor: Iterable<T>): T | null {
  for (const row of cursor) return row;
  return null;
}

function changedRowCount(storage: DurableObjectStorage): number {
  return (
    firstRow<{ count: number }>(
      storage.sql.exec<{ count: number }>("SELECT changes() AS count"),
    )?.count ?? 0
  );
}
