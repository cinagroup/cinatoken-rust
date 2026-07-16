import { ProtocolError, type OperationEnvelope, type OperationShard } from "./protocol";

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
}

export interface StorageResultRecord {
  object_key: string;
  object_version: string;
  sha256: string;
  size: number;
  content_type: string;
}

export type RecordStorageResultOutcome = "recorded" | "duplicate";

export type ClaimResult =
  | { kind: "new" }
  | { kind: "existing"; row: OperationRow }
  | { kind: "capacity" };

export interface RelayShardLedgerPolicy {
  maxInFlight: number;
  dispatchRetentionSeconds: number;
  terminalRetentionSeconds: number;
  maxTerminalOperations: number;
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
    return storageGrant(row);
  }

  recordStorageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    now: number,
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
      const grant = this.authorizeStorageAccess(operationId, ownerGeneration, now);
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
          storageResultMatches(storageGrant(current).result, result)
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
      if (
        status === "completed" &&
        ((current.operation_kind === "health_probe" && result !== null) ||
          (current.operation_kind !== "health_probe" && result === null))
      ) {
        throw new ProtocolError("operation_result_required", 409);
      }
      this.storage.sql.exec(
        `UPDATE cinatoken_shard_operations
            SET status = ?1, response_status = ?2, response_code = ?3, updated_at = ?4
          WHERE operation_id = ?5 AND owner_generation = ?6 AND status = ?7${deadlineGuard}`,
        status,
        responseStatus,
        responseCode,
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
        `UPDATE cinatoken_shard_operations
            SET status = 'recovery_required', response_status = 202,
                response_code = 'container_execution_ambiguous', updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status = 'running' AND deadline_at <= ?1`,
        now,
        operationId,
        ownerGeneration,
      );
      return claimedExpired || changedRowCount(this.storage) === 1;
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
    this.storage.sql.exec(
      `DELETE FROM cinatoken_shard_operations
        WHERE status IN (${TERMINAL_STATUS_SQL}) AND updated_at < ?1
          AND NOT EXISTS (
            SELECT 1 FROM cinatoken_shard_dispatches AS dispatch
              WHERE dispatch.operation_id = cinatoken_shard_operations.operation_id
                AND dispatch.created_at >= ?2
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

  private readStorageOperation(operationId: string): StorageOperationRow | null {
    return firstRow<StorageOperationRow>(
      this.storage.sql.exec<StorageOperationRow>(
        `SELECT protocol_version, operation_id, owner_generation, owner_lease_expires_at,
                operation_kind, provider_operation_id, admission_sha256, status, deadline_at,
                input_mode, input_sha256, input_size, input_content_type, request_object_key,
                object_version, shard_contract_version, ring_generation, shard_count,
                shard_index, instance_name, trace_id, result_object_key, result_object_version,
                result_sha256, result_size, result_content_type
           FROM cinatoken_shard_operations WHERE operation_id = ?1`,
        operationId,
      ),
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

function storageGrant(row: StorageOperationRow): StorageAccessGrant {
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
    result.object_version.length > 256 ||
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
    policy.maxTerminalOperations < 1
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
