import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_STATUS_PATH,
  MAX_OPERATION_BODY_BYTES,
  ProtocolError,
  type AuthorityEnvironment,
  type OperationEnvelope,
  verifyOperationRequest,
  verifyStatusRequest,
} from "./protocol";

export { ContainerProxy };

interface ControllerRuntimeEnvironment extends AuthorityEnvironment {
  CONTAINER_CONTROLLER_ENABLED: string;
  CONTAINER_EXECUTION_ENABLED: string;
  CONTAINER_MAX_IN_FLIGHT_PER_SHARD: string;
  CONTAINER_AUTHORITY_CURRENT_SECRET: string;
  CONTAINER_AUTHORITY_PREVIOUS_SECRET?: string;
}

type ControllerEnv = Omit<
  ContainerControllerEnv,
  keyof ControllerRuntimeEnvironment | "RELAY_SHARDS"
> & ControllerRuntimeEnvironment & {
  RELAY_SHARDS: DurableObjectNamespace<RelayShardContainer>;
};

interface OperationRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  owner_generation: number;
  envelope_sha256: string;
  status: OperationStatus;
  response_status: number | null;
}

type OperationStatus = "claimed" | "running" | "completed" | "failed" | "capacity_rejected";
type ClaimResult =
  | { kind: "new" }
  | { kind: "existing"; row: OperationRow }
  | { kind: "capacity" };

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export class RelayShardContainer extends Container<ControllerEnv> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "10m";
  override entrypoint = ["/usr/local/bin/cinatoken-container-runtime"];
  override envVars: Record<string, string> = { CINATOKEN_CONTAINER_PORT: "8080" };
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts: string[] = [];
  override pingEndpoint = "/healthz";

  static override outbound = (): Response => jsonError("container_egress_denied", 403);

  private schemaReady = false;

  override async fetch(request: Request): Promise<Response> {
    try {
      this.ensureSchema();
      const verified = await verifyOperationRequest(request, this.env);
      const maxInFlight = configuredInteger(this.env.CONTAINER_MAX_IN_FLIGHT_PER_SHARD, 1, 64);
      const claim = this.claimOperation(
        verified.envelope,
        verified.claims.body_sha256,
        verified.claims.dispatch_id,
        maxInFlight,
      );
      if (claim.kind === "existing") return responseForExisting(claim.row);
      if (claim.kind === "capacity") {
        return new Response(JSON.stringify({ error: "container_capacity_exhausted", retryable: true }), {
          status: 503,
          headers: { ...jsonHeaders, "retry-after": "1" },
        });
      }
      if (this.env.CONTAINER_EXECUTION_ENABLED !== "true") {
        this.updateOperation(verified.envelope.operation_id, verified.envelope.owner_generation, "failed", 503);
        return jsonError("container_execution_disabled", 503);
      }

      this.updateOperation(verified.envelope.operation_id, verified.envelope.owner_generation, "running", null);
      const remainingMs = Math.max(
        1,
        (verified.envelope.execution_deadline_at - Math.floor(Date.now() / 1000)) * 1000,
      );
      let upstream: Response;
      let body: Uint8Array;
      try {
        upstream = await this.containerFetch("http://container/v1/operations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cinatoken-container-protocol": "1" },
          body: copyArrayBuffer(verified.body),
          signal: AbortSignal.timeout(remainingMs),
        });
        body = await readBoundedResponse(upstream, MAX_OPERATION_BODY_BYTES);
      } catch {
        this.updateOperation(verified.envelope.operation_id, verified.envelope.owner_generation, "failed", 504);
        return jsonError("container_execution_ambiguous", 504);
      }
      const status: OperationStatus = upstream.ok ? "completed" : "failed";
      this.updateOperation(verified.envelope.operation_id, verified.envelope.owner_generation, status, upstream.status);
      return new Response(body, { status: upstream.status, headers: jsonHeaders });
    } catch (error) {
      return protocolErrorResponse(error);
    }
  }

  override onStart(): void {
    this.recordLifecycle("running", null);
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    this.recordLifecycle("stopped", `${params.exitCode ?? "unknown"}:${boundedLogValue(params.reason)}`);
  }

  override onError(error: unknown): unknown {
    this.recordLifecycle("error", boundedLogValue(error instanceof Error ? error.name : typeof error));
    throw error;
  }

  override async onActivityExpired(): Promise<void> {
    this.recordLifecycle("draining", null);
    await this.stop("SIGTERM");
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
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
      CREATE TABLE IF NOT EXISTS cinatoken_shard_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cinatoken_shard_dispatches_created
        ON cinatoken_shard_dispatches(created_at);
    `);
    this.schemaReady = true;
  }

  private claimOperation(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    maxInFlight: number,
  ): ClaimResult {
    return this.ctx.storage.transactionSync(() => {
      const now = Math.floor(Date.now() / 1000);
      this.ctx.storage.sql.exec(
        `DELETE FROM cinatoken_shard_dispatches WHERE created_at < ?1`,
        now - 600,
      );
      const dispatch = firstRow<DispatchRow>(
        this.ctx.storage.sql.exec<DispatchRow>(
          `SELECT dispatch_id, operation_id, envelope_sha256
             FROM cinatoken_shard_dispatches WHERE dispatch_id = ?1`,
          dispatchId,
        ),
      );
      if (
        dispatch !== null &&
        (dispatch.operation_id !== envelope.operation_id || dispatch.envelope_sha256 !== envelopeSha256)
      ) {
        throw new ProtocolError("dispatch_replay_conflict", 409);
      }
      const existing = firstRow<OperationRow>(
        this.ctx.storage.sql.exec<OperationRow>(
          `SELECT operation_id, owner_generation, envelope_sha256, status, response_status
             FROM cinatoken_shard_operations WHERE operation_id = ?1`,
          envelope.operation_id,
        ),
      );
      if (existing !== null) {
        if (existing.owner_generation !== envelope.owner_generation || existing.envelope_sha256 !== envelopeSha256) {
          throw new ProtocolError("operation_owner_conflict", 409);
        }
        if (dispatch === null) this.insertDispatch(dispatchId, envelope.operation_id, envelopeSha256, now);
        return { kind: "existing", row: existing };
      }

      const state = firstRow<{
        instance_name: string;
        contract_version: number;
        ring_generation: number;
        shard_count: number;
        shard_index: number;
      }>(
        this.ctx.storage.sql.exec(
          `SELECT instance_name, contract_version, ring_generation, shard_count, shard_index
             FROM cinatoken_shard_state WHERE singleton = 1`,
        ),
      );
      if (state === null) {
        this.ctx.storage.sql.exec(
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
      } else {
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
        if (state.ring_generation < envelope.shard.ring_generation) {
          const activeBeforeFence = firstRow<{ count: number }>(
            this.ctx.storage.sql.exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
                WHERE status IN ('claimed', 'running')`,
            ),
          )?.count ?? 0;
          if (activeBeforeFence > 0) {
            throw new ProtocolError("ring_generation_in_flight", 409);
          }
          this.ctx.storage.sql.exec(
            `UPDATE cinatoken_shard_state
                SET ring_generation = ?1, shard_count = ?2, updated_at = ?3
              WHERE singleton = 1`,
            envelope.shard.ring_generation,
            envelope.shard.shard_count,
            now,
          );
        }
      }

      const inFlight = firstRow<{ count: number }>(
        this.ctx.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM cinatoken_shard_operations
            WHERE status IN ('claimed', 'running')`,
        ),
      )?.count ?? 0;
      this.insertDispatch(dispatchId, envelope.operation_id, envelopeSha256, now);
      if (inFlight >= maxInFlight) {
        this.insertOperation(envelope, envelopeSha256, dispatchId, "capacity_rejected", 503, now);
        return { kind: "capacity" };
      }
      this.insertOperation(envelope, envelopeSha256, dispatchId, "claimed", null, now);
      return { kind: "new" };
    });
  }

  private insertOperation(
    envelope: OperationEnvelope,
    envelopeSha256: string,
    dispatchId: string,
    status: OperationStatus,
    responseStatus: number | null,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
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
    this.ctx.storage.sql.exec(
      `INSERT INTO cinatoken_shard_dispatches
         (dispatch_id, operation_id, envelope_sha256, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
      dispatchId,
      operationId,
      envelopeSha256,
      now,
    );
  }

  private updateOperation(
    operationId: string,
    ownerGeneration: number,
    status: OperationStatus,
    responseStatus: number | null,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE cinatoken_shard_operations SET status = ?1, response_status = ?2, updated_at = ?3
        WHERE operation_id = ?4 AND owner_generation = ?5`,
      status,
      responseStatus,
      Math.floor(Date.now() / 1000),
      operationId,
      ownerGeneration,
    );
  }

  private recordLifecycle(state: string, detail: string | null): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `UPDATE cinatoken_shard_state SET lifecycle_state = ?1, lifecycle_detail = ?2, updated_at = ?3
        WHERE singleton = 1`,
      state,
      detail,
      Math.floor(Date.now() / 1000),
    );
  }
}

const handler: ExportedHandler<ControllerEnv> = {
  async fetch(request, env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === INTERNAL_STATUS_PATH) {
        await verifyStatusRequest(request, env);
        return new Response(
          JSON.stringify({
            controller_enabled: env.CONTAINER_CONTROLLER_ENABLED === "true",
            execution_enabled: env.CONTAINER_EXECUTION_ENABLED === "true",
            protocol_version: Number(env.CONTAINER_PROTOCOL_VERSION),
            ring_generation: Number(env.CONTAINER_RING_GENERATION),
            shard_count: Number(env.CONTAINER_SHARD_COUNT),
            authority_current_secret_configured: env.CONTAINER_AUTHORITY_CURRENT_SECRET.length >= 32,
            authority_previous_secret_configured:
              env.CONTAINER_AUTHORITY_PREVIOUS_SECRET !== undefined &&
              env.CONTAINER_AUTHORITY_PREVIOUS_SECRET.length >= 32,
          }),
          { status: 200, headers: jsonHeaders },
        );
      }
      if (path !== INTERNAL_OPERATION_PATH) return jsonError("route_not_found", 404);
      const verified = await verifyOperationRequest(request, env);
      if (env.CONTAINER_CONTROLLER_ENABLED !== "true") {
        return jsonError("container_controller_disabled", 503);
      }
      if (env.CONTAINER_EXECUTION_ENABLED !== "true") {
        return jsonError("container_execution_disabled", 503);
      }
      const stub = env.RELAY_SHARDS.getByName(verified.envelope.shard.instance_name);
      return stub.fetch(
        new Request(`https://relay-shard.internal${INTERNAL_OPERATION_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [AUTHORITY_HEADER]: request.headers.get(AUTHORITY_HEADER) ?? "",
          },
          body: copyArrayBuffer(verified.body),
        }),
      );
    } catch (error) {
      return protocolErrorResponse(error);
    }
  },
};

export default handler;

function responseForExisting(row: OperationRow): Response {
  if (row.status === "capacity_rejected") {
    return new Response(JSON.stringify({ error: "container_capacity_exhausted", retryable: true }), {
      status: 503,
      headers: { ...jsonHeaders, "retry-after": "1" },
    });
  }
  const status = row.response_status ?? (row.status === "failed" ? 502 : 202);
  return new Response(
    JSON.stringify({ operation_id: row.operation_id, status: row.status, duplicate: true }),
    { status, headers: jsonHeaders },
  );
}

function protocolErrorResponse(error: unknown): Response {
  if (error instanceof ProtocolError) return jsonError(error.code, error.status);
  console.error(JSON.stringify({ event: "container_controller_error", error_type: error instanceof Error ? error.name : typeof error }));
  return jsonError("container_controller_failure", 503);
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

function configuredInteger(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new ProtocolError("controller_misconfigured", 503);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
  return parsed;
}

function firstRow<T>(cursor: Iterable<T>): T | null {
  for (const row of cursor) return row;
  return null;
}

interface DispatchRow {
  [key: string]: SqlStorageValue;
  dispatch_id: string;
  operation_id: string;
  envelope_sha256: string;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    throw new ProtocolError("container_response_too_large", 502);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("container_response_too_large");
        throw new ProtocolError("container_response_too_large", 502);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function boundedLogValue(value: unknown): string {
  return String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
}
