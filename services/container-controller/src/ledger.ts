import { ProtocolError, type OperationEnvelope } from "./protocol";

export const DISPATCH_REPLAY_RETENTION_SECONDS = 600;

export type OperationStatus =
  | "claimed"
  | "running"
  | "completed"
  | "failed";

export interface OperationRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  envelope_sha256: string;
  status: OperationStatus;
  response_status: number | null;
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
}

const TERMINAL_STATUS_SQL = "'completed', 'failed'";

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
        operation_id TEXT PRIMARY KEY,
        owner_generation INTEGER NOT NULL,
        provider_operation_id TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status INTEGER,
        deadline_at INTEGER NOT NULL,
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
    `);
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'failed', response_status = COALESCE(response_status, 503)
        WHERE status = 'capacity_rejected'`,
    );
    this.schemaReady = true;
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
      const existing = firstRow<OperationRow>(
        this.storage.sql.exec<OperationRow>(
          `SELECT operation_id, owner_generation, envelope_sha256, status, response_status
             FROM cinatoken_shard_operations WHERE operation_id = ?1`,
          envelope.operation_id,
        ),
      );
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
            SET status = 'failed', response_status = 504, updated_at = ?1
          WHERE operation_id = ?2 AND owner_generation = ?3
            AND status IN ('claimed', 'running') AND deadline_at <= ?1`,
        now,
        operationId,
        ownerGeneration,
      );
      return changedRowCount(this.storage) === 1;
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

  private runMaintenance(policy: RelayShardLedgerPolicy, now: number): void {
    this.storage.sql.exec(
      `UPDATE cinatoken_shard_operations
          SET status = 'failed', response_status = 504, updated_at = ?1
        WHERE status IN ('claimed', 'running') AND deadline_at <= ?1`,
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

  private assertAndAdvanceShardFence(envelope: OperationEnvelope, now: number): void {
    const state = firstRow<ShardStateRow>(
      this.storage.sql.exec<ShardStateRow>(
        `SELECT instance_name, contract_version, ring_generation, shard_count, shard_index
           FROM cinatoken_shard_state WHERE singleton = 1`,
      ),
    );
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
         (operation_id, owner_generation, provider_operation_id, envelope_sha256, dispatch_id,
          status, response_status, deadline_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      envelope.operation_id,
      envelope.owner_generation,
      envelope.provider_operation_id,
      envelopeSha256,
      dispatchId,
      status,
      responseStatus,
      envelope.execution_deadline_at,
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
