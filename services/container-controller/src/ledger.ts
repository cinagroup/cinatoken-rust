import {
  MAX_STORAGE_OBJECT_VERSION_BYTES,
  ProtocolError,
  validateTerminalAckRequest,
  validateOperationStatusQuery,
  type OperationEnvelope,
  type OperationShard,
  type OperationStatusQuery,
  type TerminalAckRequest,
} from "./protocol";

export const DISPATCH_REPLAY_RETENTION_SECONDS = 600;

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
  provider_attempt: {
    attempt_generation: number;
    provider_operation_id: string;
    admission_sha256: string;
    request_sha256: string;
    egress_profile: string | null;
    egress_worker_version_id: string | null;
    status: ProviderAttemptStatus;
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
  billing_event_id: string;
  terminal_contract_sha256: string;
  reconciliation_id: string;
  reconciliation_revision: number;
  predecessor_billing_event_id: string | null;
  ack_payload_json: string;
  recovery_payload_json: string | null;
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
  runtimeExecutionEnabled: boolean | null;
  processReady: boolean;
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
  runtime_execution_enabled: number | null;
  last_ready_at_ms: number | null;
}

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
}

const TERMINAL_STATUS_SQL = "'completed', 'failed', 'recovery_required'";

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
        CHECK (status IN ('prepared', 'dispatched', 'succeeded', 'definite_reject', 'ambiguous', 'cancelled')),
        CHECK (prepared_at > 0 AND updated_at >= prepared_at),
        CHECK (
          (status = 'prepared'
            AND dispatched_at IS NULL AND terminal_at IS NULL
            AND response_status IS NULL AND response_code IS NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND updated_at = prepared_at)
          OR
          (status = 'dispatched'
            AND dispatched_at IS NOT NULL AND dispatched_at >= prepared_at
            AND terminal_at IS NULL AND response_status IS NULL AND response_code IS NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL
            AND updated_at = dispatched_at)
          OR
          (status = 'succeeded'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status BETWEEN 200 AND 299 AND response_code IS NULL
            AND result_object_key IS NOT NULL AND result_object_version IS NOT NULL
            AND result_sha256 IS NOT NULL AND result_size IS NOT NULL
            AND result_content_type IS NOT NULL)
          OR
          (status = 'definite_reject'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status BETWEEN 400 AND 599 AND response_code IS NOT NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL)
          OR
          (status = 'ambiguous'
            AND dispatched_at IS NOT NULL AND terminal_at IS NOT NULL
            AND terminal_at >= dispatched_at AND updated_at = terminal_at
            AND response_status = 202 AND response_code IS NOT NULL)
          OR
          (status = 'cancelled'
            AND dispatched_at IS NULL AND terminal_at IS NOT NULL
            AND terminal_at >= prepared_at AND updated_at = terminal_at
            AND response_status BETWEEN 400 AND 599 AND response_code IS NOT NULL
            AND result_object_key IS NULL AND result_object_version IS NULL
            AND result_sha256 IS NULL AND result_size IS NULL AND result_content_type IS NULL)
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
        billing_event_id TEXT NOT NULL,
        terminal_contract_sha256 TEXT NOT NULL,
        reconciliation_id TEXT NOT NULL,
        reconciliation_revision INTEGER NOT NULL,
        predecessor_billing_event_id TEXT,
        ack_payload_json TEXT NOT NULL,
        recovery_payload_json TEXT,
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
            AND recovery_payload_json IS NOT NULL
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
        observed_at INTEGER NOT NULL,
        UNIQUE (operation_id, owner_generation, attempt_generation, event_sequence),
        CHECK (event_sequence BETWEEN 1 AND 4),
        CHECK (to_status IN ('prepared', 'dispatched', 'succeeded', 'definite_reject', 'ambiguous', 'cancelled')),
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
           from_status, to_status, response_status, response_code, observed_at)
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
        runtime_execution_enabled INTEGER,
        last_ready_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS cinatoken_shard_readiness_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_readiness_dispatches_created
        ON cinatoken_shard_readiness_dispatches(created_at_ms);
    `);
    this.ensureOperationColumns();
    this.ensureProviderAttemptEgressColumns();
    this.installProviderAttemptEgressGuards();
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
    if (
      result.object_key !==
      `container-results/v1/${operationId}/${ownerGeneration}/${result.sha256}`
    ) {
      throw new ProtocolError("invalid_storage_result", 400);
    }
    return this.storage.transactionSync(() => {
      if (
        providerAttemptGeneration !== undefined &&
        (!Number.isSafeInteger(providerAttemptGeneration) ||
          providerAttemptGeneration < 1 ||
          providerAttemptGeneration > 3)
      ) {
        throw new ProtocolError("invalid_provider_attempt", 400);
      }
      const grant = this.authorizeStorageAccess(
        operationId,
        ownerGeneration,
        now,
        providerAttemptGeneration !== undefined,
      );
      if (
        providerAttemptGeneration !== undefined &&
        (grant.provider_attempt?.attempt_generation !== providerAttemptGeneration ||
          grant.provider_attempt.status !== "dispatched")
      ) {
        throw new ProtocolError("provider_attempt_result_conflict", 409);
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

  readOperationOutcome(operationId: string): OperationRow | null {
    this.ensureSchema();
    return firstRow<OperationRow>(
      this.storage.sql.exec<OperationRow>(
        `SELECT operation_id, owner_generation, operation_kind, trace_id, envelope_sha256,
                status, response_status, response_code, result_object_key,
                result_object_version, result_sha256, result_size, result_content_type
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
                result_object_version, result_sha256, result_size, result_content_type
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
        !terminalAckOperationMatches(operation, localAck)
      ) {
        throw new ProtocolError("terminal_ack_conflict", 409);
      }

      if (progressingRecovery) {
        this.storage.sql.exec(
          `UPDATE cinatoken_shard_terminal_acks
              SET billing_event_id = ?1,
                  terminal_contract_sha256 = ?2,
                  reconciliation_id = ?3,
                  reconciliation_revision = 2,
                  predecessor_billing_event_id = ?4,
                  ack_payload_json = ?5,
                  final_acked_at = ?6,
                  updated_at = ?6
            WHERE operation_id = ?7 AND owner_generation = ?8
              AND billing_event_id = ?4
              AND terminal_contract_sha256 = ?9
              AND reconciliation_id = ?3
              AND reconciliation_revision = 1
              AND predecessor_billing_event_id IS NULL
              AND ack_payload_json = ?10
              AND recovery_payload_json = ?10
              AND final_acked_at IS NULL
              AND compaction_authorized_at IS NULL`,
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
             (operation_id, owner_generation, billing_event_id,
              terminal_contract_sha256, reconciliation_id, reconciliation_revision,
              predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
              final_acked_at, compaction_authorized_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, NULL, ?6, ?7, ?8, NULL, ?9, ?9)`,
          ack.operation_id,
          ack.owner_generation,
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
    envelopeSha256: string,
    dispatchId: string,
    policy: RelayShardLedgerPolicy,
    now: number,
  ): ClaimResult {
    this.ensureSchema();
    validatePolicy(policy);
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
        return { kind: "existing", row: existing };
      }

      const existingState = this.readShardStateRow();
      if (existingState?.lifecycle_state === "draining") {
        throw new ProtocolError("shard_draining", 503);
      }

      this.assertAndAdvanceShardFence(envelope, now);
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

  initializeShardForReadiness(shard: OperationShard, now: number): void {
    this.ensureSchema();
    this.storage.transactionSync(() => {
      const state = this.readShardStateRow();
      if (state !== null) {
        this.assertAndAdvanceReadinessFence(state, shard, now);
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
                  runtime_contract_version = NULL, runtime_execution_enabled = NULL
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
                runtime_execution_enabled = ?8,
                last_ready_at_ms = CASE WHEN ?9 = 1 THEN ?1 ELSE last_ready_at_ms END
          WHERE singleton = 1 AND probe_generation = ?10 AND phase = 'probing'`,
        completedAtMs,
        completion.resultCode,
        completion.containerStatus,
        completion.containerLastChangeMs,
        completion.containerExitCode,
        completion.runtimeProtocolVersion,
        completion.runtimeContractVersion,
        completion.runtimeExecutionEnabled === null
          ? null
          : completion.runtimeExecutionEnabled
            ? 1
            : 0,
        completion.processReady ? 1 : 0,
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

  private readStorageOperation(operationId: string): StorageOperationRow | null {
    return firstRow<StorageOperationRow>(
      this.storage.sql.exec<StorageOperationRow>(
        `SELECT protocol_version, operation_id, owner_generation, owner_lease_expires_at,
                operation_kind, provider_operation_id, admission_sha256, status,
                response_status, response_code, deadline_at,
                input_mode, input_sha256, input_size, input_content_type, request_object_key,
                object_version, shard_contract_version, ring_generation, shard_count,
                shard_index, instance_name, trace_id, result_object_key, result_object_version,
                result_sha256, result_size, result_content_type
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
                result_content_type, prepared_at, dispatched_at, terminal_at, updated_at
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
                result_content_type, prepared_at, dispatched_at, terminal_at, updated_at
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
        `SELECT operation_id, owner_generation, billing_event_id,
                terminal_contract_sha256, reconciliation_id, reconciliation_revision,
                predecessor_billing_event_id, ack_payload_json, recovery_payload_json,
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

  private assertAndAdvanceShardFence(envelope: OperationEnvelope, now: number): void {
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
      state.ring_generation > envelope.shard.ring_generation ||
      (state.ring_generation === envelope.shard.ring_generation &&
        state.shard_count !== envelope.shard.shard_count)
    ) {
      throw new ProtocolError("stale_shard_fence", 409);
    }
    if (state.ring_generation === envelope.shard.ring_generation) return;

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
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_state
          SET ring_generation = ?1, shard_count = ?2, updated_at = ?3
        WHERE singleton = 1`,
      envelope.shard.ring_generation,
      envelope.shard.shard_count,
      now,
    );
  }

  private assertAndAdvanceReadinessFence(
    state: ShardStateRow,
    shard: OperationShard,
    now: number,
  ): void {
    if (
      state.instance_name !== shard.instance_name ||
      state.contract_version !== shard.contract_version ||
      state.shard_index !== shard.shard_index ||
      state.ring_generation > shard.ring_generation ||
      (state.ring_generation === shard.ring_generation && state.shard_count !== shard.shard_count)
    ) {
      throw new ProtocolError("stale_shard_fence", 409);
    }
    if (state.ring_generation === shard.ring_generation) return;
    const active =
      firstRow<{ count: number }>(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running')`,
        ),
      )?.count ?? 0;
    if (active > 0) throw new ProtocolError("ring_generation_in_flight", 409);
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
                runtime_execution_enabled, last_ready_at_ms
           FROM cinatoken_shard_readiness WHERE singleton = 1`,
      ),
    );
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
  });
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
    left.shard.instance_name === right.shard.instance_name
  );
}

function terminalAckOperationMatches(
  operation: StorageOperationRow,
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
    terminalAckResultMatches(operationStorageResult(operation), ack.result)
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
  if (
    (!hasLegacyEgressIdentity && !hasVersionedEgressIdentity) ||
    ((row.status === "prepared" || row.status === "cancelled") &&
      !hasLegacyEgressIdentity)
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
        result === null)) ||
    (row.status === "definite_reject" &&
      (row.dispatched_at === null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status === null ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code) ||
        result !== null)) ||
    (row.status === "ambiguous" &&
      (row.dispatched_at === null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status !== 202 ||
        !validResponseCode(row.response_code))) ||
    (row.status === "cancelled" &&
      (row.dispatched_at !== null ||
        row.terminal_at === null ||
        row.updated_at !== row.terminal_at ||
        row.response_status === null ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code) ||
        result !== null))
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
