import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  DISPATCH_REPLAY_RETENTION_SECONDS,
  RelayShardLedger,
  operationStorageResult,
  type OperationRow,
  type RecordStorageResultOutcome,
  type RelayShardLedgerPolicy,
  type StorageAccessGrant,
  type StorageResultRecord,
} from "./ledger";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_READINESS_PATH,
  INTERNAL_STATUS_PATH,
  MAX_OPERATION_BODY_BYTES,
  ProtocolError,
  type AuthorityEnvironment,
  type OperationEnvelope,
  type OperationShard,
  type ShardReadinessProbe,
  verifyOperationRequest,
  verifyReadinessRequest,
  verifyStatusRequest,
} from "./protocol";
import {
  operationOutcomeResponse,
  parseContainerOperationResponse,
} from "./operation_outcome";
import {
  CONTENT_SHA256_HEADER,
  D1_ADMISSION_HOST,
  KV_CONFIG_HOST,
  MAX_R2_OBJECT_BYTES,
  R2_INPUT_HOST,
  R2_OBJECT_VERSION_HEADER,
  R2_RESULT_HOST,
  STORAGE_GATEWAY_ACTIONS,
  deriveR2ResultKey,
  handleStorageGatewayRequest,
  type R2ResultPutGrant,
  type StorageAccessGrant as GatewayStorageAccessGrant,
  type StorageGatewayAction,
  type StorageGatewayEnvironment,
} from "./storage_gateway";

export { ContainerProxy };

interface ControllerRuntimeEnvironment extends AuthorityEnvironment {
  CONTAINER_CONTROLLER_ENABLED: string;
  CONTAINER_EXECUTION_ENABLED: string;
  CONTAINER_READINESS_PROBE_ENABLED: string;
  CONTAINER_READINESS_WAKE_ENABLED: string;
  CONTAINER_STORAGE_R2_READ_ENABLED: string;
  CONTAINER_STORAGE_R2_WRITE_ENABLED: string;
  CONTAINER_STORAGE_KV_READ_ENABLED: string;
  CONTAINER_STORAGE_D1_READ_ENABLED: string;
  CONTAINER_MAX_IN_FLIGHT_PER_SHARD: string;
  CONTAINER_TERMINAL_RETENTION_SECONDS: string;
  CONTAINER_MAX_TERMINAL_OPERATIONS: string;
  CONTAINER_AUTHORITY_CURRENT_SECRET: string;
  CONTAINER_AUTHORITY_PREVIOUS_SECRET?: string;
}

type ControllerEnv = Omit<
  ContainerControllerEnv,
  keyof ControllerRuntimeEnvironment | "RELAY_SHARDS"
> & ControllerRuntimeEnvironment & {
  RELAY_SHARDS: DurableObjectNamespace<RelayShardContainer>;
};

interface ContainerStorageRuntimeEnvironment {
  CONTAINER_STORAGE_R2_READ_ENABLED: string;
  CONTAINER_STORAGE_R2_WRITE_ENABLED: string;
  CONTAINER_STORAGE_KV_READ_ENABLED: string;
  CONTAINER_STORAGE_D1_READ_ENABLED: string;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const READINESS_TIMEOUT_MS = 10_000;
const READINESS_COOLDOWN_MS = 5_000;
const READINESS_RESPONSE_MAX_BYTES = 1024;

interface ContainerStateSnapshot {
  status: "running" | "healthy" | "stopping" | "stopped" | "stopped_with_code";
  last_change_ms: number;
  exit_code: number | null;
}

interface RuntimeReadinessSnapshot {
  process_ready: boolean;
  execution_ready: boolean;
  protocol_version: number;
  shard_contract_version: number;
  execution_enabled: boolean;
}

export interface ShardReadinessResult {
  checked_at: number;
  mode: "ledger" | "live";
  ready: boolean;
  verdict: "unknown" | "ready" | "not_ready";
  result_code: string;
  shard: OperationShard;
  wake_requested: boolean;
  container_state: ContainerStateSnapshot | null;
  ledger: import("./ledger").ShardReadinessSnapshot;
  runtime: RuntimeReadinessSnapshot | null;
}

type ShardReadinessRpcResult =
  | { ok: true; result: ShardReadinessResult }
  | { ok: false; error: { code: string; status: number } };

export type ShardStorageAccessRpcResult =
  | { ok: true; grant: StorageAccessGrant }
  | { ok: false; error: { code: string; status: number } };

export type ShardStorageResultRpcResult =
  | { ok: true; result: RecordStorageResultOutcome }
  | { ok: false; error: { code: string; status: number } };

export class RelayShardContainer extends Container<ControllerEnv> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "10m";
  override entrypoint = ["/usr/local/bin/cinatoken-container-runtime"];
  override envVars: Record<string, string> = { CINATOKEN_CONTAINER_PORT: "8080" };
  override enableInternet = false;
  override interceptHttps = true;
  override allowedHosts: string[] = [
    R2_INPUT_HOST,
    R2_RESULT_HOST,
    KV_CONFIG_HOST,
    D1_ADMISSION_HOST,
  ];
  override pingEndpoint = "/healthz";

  static override outbound = (): Response => jsonError("container_egress_denied", 403);

  private readonly ledger = new RelayShardLedger(this.ctx.storage);

  async authorizeStorageAccess(
    operationId: string,
    ownerGeneration: number,
  ): Promise<ShardStorageAccessRpcResult> {
    try {
      return {
        ok: true,
        grant: this.ledger.authorizeStorageAccess(
          operationId,
          ownerGeneration,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "storage_access_unavailable", status: 503 } };
    }
  }

  async recordStorageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
  ): Promise<ShardStorageResultRpcResult> {
    try {
      return {
        ok: true,
        result: this.ledger.recordStorageResult(
          operationId,
          ownerGeneration,
          result,
          Math.floor(Date.now() / 1000),
        ),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return { ok: false, error: { code: "storage_result_unavailable", status: 503 } };
    }
  }

  async reconcileOperationDeadline(payload: unknown): Promise<void> {
    const schedule = parseOperationRecoverySchedule(payload);
    const now = Math.floor(Date.now() / 1000);
    if (schedule.deadline_at > now) {
      await this.schedule(
        new Date((schedule.deadline_at + 1) * 1000),
        "reconcileOperationDeadline",
        schedule,
      );
      return;
    }
    this.ledger.expireOperation(schedule.operation_id, schedule.owner_generation, now);
  }

  async readinessProbe(
    probe: ShardReadinessProbe,
    probeId: string,
  ): Promise<ShardReadinessRpcResult> {
    const startedAtMs = Date.now();
    try {
      if (!probe.wake_container) {
        return {
          ok: true,
          result: {
            checked_at: Math.floor(startedAtMs / 1000),
            mode: "ledger",
            ready: false,
            verdict: "unknown",
            result_code: "ledger_snapshot",
            shard: probe.shard,
            wake_requested: false,
            container_state: null,
            ledger: this.ledger.readShardReadiness(probe.shard, Math.floor(startedAtMs / 1000)),
            runtime: null,
          },
        };
      }

      this.ledger.initializeShardForReadiness(probe.shard, Math.floor(startedAtMs / 1000));
      const generation = this.ledger.beginReadinessProbe(
        probe.shard,
        probeId,
        startedAtMs,
        startedAtMs + READINESS_TIMEOUT_MS,
        READINESS_COOLDOWN_MS,
      );
      let containerState: ContainerStateSnapshot | null = null;
      let runtime: RuntimeReadinessSnapshot | null = null;
      let resultCode = "container_readiness_unavailable";
      try {
        const deadlineAtMs = startedAtMs + READINESS_TIMEOUT_MS;
        const response = await this.containerFetch("http://container/readyz", {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now())),
        });
        const body = await readBoundedResponse(
          response,
          READINESS_RESPONSE_MAX_BYTES,
          deadlineAtMs,
        );
        if (response.status !== 200) {
          throw new ProtocolError(
            response.status === 429
              ? "container_start_rate_limited"
              : response.status === 503
                ? "container_start_unavailable"
                : "container_readiness_rejected",
            response.status === 429 ? 429 : 503,
          );
        }
        const readiness = validateRuntimeReadinessResponse(response, body);
        containerState = containerStateSnapshot(
          await withAbsoluteDeadline(
            this.getState(),
            deadlineAtMs,
            "container_readiness_timeout",
            504,
          ),
        );
        const processReady = containerState.status === "healthy";
        const ledgerBeforeCompletion = this.ledger.readShardReadiness(
          probe.shard,
          Math.floor(Date.now() / 1000),
        );
        const lifecycleAccepting = !["draining", "stopped", "error"].includes(
          ledgerBeforeCompletion.lifecycle_state ?? "",
        );
        const capacityAvailable =
          ledgerBeforeCompletion.active_in_flight_operations <
          controllerLedgerPolicy(this.env).maxInFlight;
        const executionReady =
          processReady &&
          readiness.execution_enabled &&
          this.env.CONTAINER_EXECUTION_ENABLED === "true" &&
          lifecycleAccepting &&
          capacityAvailable;
        runtime = {
          process_ready: processReady,
          execution_ready: executionReady,
          protocol_version: readiness.protocol_version,
          shard_contract_version: readiness.shard_contract_version,
          execution_enabled: readiness.execution_enabled,
        };
        resultCode = !processReady
          ? "container_not_healthy"
          : !readiness.execution_enabled
            ? "process_ready_execution_disabled"
            : this.env.CONTAINER_EXECUTION_ENABLED !== "true"
              ? "controller_execution_disabled"
              : !lifecycleAccepting
                ? "shard_not_accepting"
                : !capacityAvailable
                  ? "shard_capacity_exhausted"
                  : "execution_ready";
      } catch (error) {
        resultCode = error instanceof ProtocolError ? error.code : "container_readiness_unavailable";
        try {
          containerState = containerStateSnapshot(await this.getState());
        } catch {
          containerState = null;
        }
      }

      const completedAtMs = Date.now();
      const completed = this.ledger.completeReadinessProbe(generation, completedAtMs, {
        resultCode,
        containerStatus: containerState?.status ?? null,
        containerLastChangeMs: containerState?.last_change_ms ?? null,
        containerExitCode: containerState?.exit_code ?? null,
        runtimeProtocolVersion: runtime?.protocol_version ?? null,
        runtimeContractVersion: runtime?.shard_contract_version ?? null,
        runtimeExecutionEnabled: runtime?.execution_enabled ?? null,
        processReady: runtime?.process_ready ?? false,
      });
      if (!completed) throw new ProtocolError("readiness_probe_superseded", 409);
      const executionReady = runtime?.execution_ready ?? false;
      return {
        ok: true,
        result: {
          checked_at: Math.floor(completedAtMs / 1000),
          mode: "live",
          ready: executionReady,
          verdict: executionReady ? "ready" : "not_ready",
          result_code: resultCode,
          shard: probe.shard,
          wake_requested: true,
          container_state: containerState,
          ledger: this.ledger.readShardReadiness(
            probe.shard,
            Math.floor(completedAtMs / 1000),
          ),
          runtime,
        },
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      return {
        ok: false,
        error: { code: "container_readiness_unavailable", status: 504 },
      };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const verified = await verifyOperationRequest(request, this.env);
      const now = Math.floor(Date.now() / 1000);
      const claim = this.ledger.claimOperation(
        verified.envelope,
        verified.claims.body_sha256,
        verified.claims.dispatch_id,
        controllerLedgerPolicy(this.env),
        now,
      );
      if (claim.kind === "existing") return responseForExisting(claim.row);
      if (claim.kind === "capacity") {
        return new Response(JSON.stringify({ error: "container_capacity_exhausted", retryable: true }), {
          status: 503,
          headers: { ...jsonHeaders, "retry-after": "1" },
        });
      }
      if (this.env.CONTAINER_EXECUTION_ENABLED !== "true") {
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "claimed",
          "failed",
          503,
          "container_execution_disabled",
          now,
          false,
        );
        return operationOutcomeResponse(outcome);
      }

      try {
        await this.schedule(
          new Date((verified.envelope.execution_deadline_at + 1) * 1000),
          "reconcileOperationDeadline",
          {
            operation_id: verified.envelope.operation_id,
            owner_generation: verified.envelope.owner_generation,
            deadline_at: verified.envelope.execution_deadline_at,
          } satisfies OperationRecoverySchedule,
        );
      } catch {
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "claimed",
          "failed",
          503,
          "container_recovery_schedule_unavailable",
          Math.floor(Date.now() / 1000),
          false,
        );
        return operationOutcomeResponse(outcome);
      }
      const started = this.ledger.transitionOperation(
        verified.envelope.operation_id,
        verified.envelope.owner_generation,
        "claimed",
        "running",
        null,
        now,
        true,
      );
      if (!started) {
        this.ledger.expireOperation(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          now,
        );
        const outcome = this.ledger.readOperationOutcome(verified.envelope.operation_id);
        return outcome === null
          ? jsonError("operation_completion_conflict", 409)
          : operationOutcomeResponse(outcome);
      }
      const remainingMs = Math.max(
        1,
        (verified.envelope.execution_deadline_at - Math.floor(Date.now() / 1000)) * 1000,
      );
      try {
        const upstream = await this.containerFetch("http://container/v1/operations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cinatoken-container-protocol": "1" },
          body: copyArrayBuffer(verified.body),
          signal: AbortSignal.timeout(remainingMs),
        });
        const body = await readBoundedResponse(upstream, MAX_OPERATION_BODY_BYTES);
        const containerOutcome = parseContainerOperationResponse(
          upstream,
          body,
          verified.envelope,
        );
        validatePersistedContainerResult(this.ledger, verified.envelope, containerOutcome.result);
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "running",
          containerOutcome.status === "completed"
            ? "completed"
            : containerOutcome.status === "rejected"
              ? "failed"
              : "recovery_required",
          containerOutcome.status === "recovery_required" ? 202 : upstream.status,
          containerOutcome.code,
          Math.floor(Date.now() / 1000),
          containerOutcome.status !== "recovery_required",
        );
        return operationOutcomeResponse(outcome);
      } catch {
        const outcome = finalizeOperationOutcome(
          this.ledger,
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "running",
          "recovery_required",
          202,
          "container_execution_ambiguous",
          Math.floor(Date.now() / 1000),
          false,
        );
        return operationOutcomeResponse(outcome);
      }
    } catch (error) {
      return protocolErrorResponse(error);
    }
  }

  override onStart(): void {
    this.ledger.recordLifecycle("running", null, Math.floor(Date.now() / 1000));
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    this.ledger.recordLifecycle(
      "stopped",
      `${params.exitCode ?? "unknown"}:${boundedLogValue(params.reason)}`,
      Math.floor(Date.now() / 1000),
    );
  }

  override onError(error: unknown): unknown {
    this.ledger.recordLifecycle(
      "error",
      boundedLogValue(error instanceof Error ? error.name : typeof error),
      Math.floor(Date.now() / 1000),
    );
    throw error;
  }

  override async onActivityExpired(): Promise<void> {
    this.ledger.recordLifecycle("draining", null, Math.floor(Date.now() / 1000));
    await this.stop("SIGTERM");
  }
}

RelayShardContainer.outboundByHost = {
  [R2_INPUT_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET),
  [R2_RESULT_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT),
  [KV_CONFIG_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET),
  [D1_ADMISSION_HOST]: storageOutboundHandler(STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET),
};

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
            authority_current_secret_configured: authoritySecretConfigured(
              env.CONTAINER_AUTHORITY_CURRENT_SECRET,
            ),
            authority_previous_secret_configured:
              env.CONTAINER_AUTHORITY_PREVIOUS_SECRET !== undefined &&
              authoritySecretConfigured(env.CONTAINER_AUTHORITY_PREVIOUS_SECRET),
          }),
          { status: 200, headers: jsonHeaders },
        );
      }
      if (path === INTERNAL_READINESS_PATH) {
        const verified = await verifyReadinessRequest(request, env);
        if (env.CONTAINER_CONTROLLER_ENABLED !== "true") {
          return jsonError("container_controller_disabled", 503);
        }
        if (env.CONTAINER_READINESS_PROBE_ENABLED !== "true") {
          return jsonError("container_readiness_probe_disabled", 503);
        }
        if (
          verified.probe.wake_container &&
          env.CONTAINER_READINESS_WAKE_ENABLED !== "true"
        ) {
          return jsonError("container_readiness_wake_disabled", 503);
        }
        const stub = env.RELAY_SHARDS.getByName(verified.probe.shard.instance_name);
        const outcome = await stub.readinessProbe(
          verified.probe,
          verified.claims.dispatch_id,
        );
        if (!outcome.ok) return jsonError(outcome.error.code, outcome.error.status);
        return new Response(
          JSON.stringify({
            protocol_version: verified.probe.protocol_version,
            probe_id: verified.claims.dispatch_id,
            ...outcome.result,
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
      return await stub.fetch(
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
  return operationOutcomeResponse(row);
}

interface OperationRecoverySchedule {
  operation_id: string;
  owner_generation: number;
  deadline_at: number;
}

function parseOperationRecoverySchedule(value: unknown): OperationRecoverySchedule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_operation_recovery_schedule", 500);
  }
  const record = value as Record<string, unknown>;
  const expected = ["operation_id", "owner_generation", "deadline_at"];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    typeof record.operation_id !== "string" ||
    record.operation_id.length < 1 ||
    record.operation_id.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(record.operation_id) ||
    typeof record.owner_generation !== "number" ||
    !Number.isSafeInteger(record.owner_generation) ||
    record.owner_generation < 1 ||
    typeof record.deadline_at !== "number" ||
    !Number.isSafeInteger(record.deadline_at) ||
    record.deadline_at < 1
  ) {
    throw new ProtocolError("invalid_operation_recovery_schedule", 500);
  }
  return {
    operation_id: record.operation_id,
    owner_generation: record.owner_generation,
    deadline_at: record.deadline_at,
  };
}

function finalizeOperationOutcome(
  ledger: RelayShardLedger,
  operationId: string,
  ownerGeneration: number,
  expectedStatus: "claimed" | "running",
  status: "completed" | "failed" | "recovery_required",
  responseStatus: number,
  responseCode: string | null,
  now: number,
  requireBeforeDeadline: boolean,
): OperationRow {
  try {
    return ledger.finalizeOperation(
      operationId,
      ownerGeneration,
      expectedStatus,
      status,
      responseStatus,
      responseCode,
      now,
      requireBeforeDeadline,
    );
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "operation_completion_conflict") {
      const current = ledger.readOperationOutcome(operationId);
      if (
        current !== null &&
        current.owner_generation === ownerGeneration &&
        ["completed", "failed", "recovery_required"].includes(current.status)
      ) {
        return current;
      }
    }
    throw error;
  }
}

const STORAGE_OPERATION_ID_HEADER = "x-cinatoken-operation-id";
const STORAGE_OWNER_GENERATION_HEADER = "x-cinatoken-owner-generation";

function storageOutboundHandler(action: StorageGatewayAction) {
  return async (
    request: Request,
    env: Cloudflare.Env,
    context: { containerId: string },
  ): Promise<Response> => {
    if (!storageActionEnabled(action, env)) {
      await cancelRequestBody(request);
      return jsonError("storage_gateway_disabled", 503);
    }
    const identity = storageOperationIdentity(request);
    if (identity === null) {
      await cancelRequestBody(request);
      return jsonError("storage_access_denied", 403);
    }
    let id: DurableObjectId;
    try {
      id = env.RELAY_SHARDS.idFromString(context.containerId);
    } catch {
      await cancelRequestBody(request);
      return jsonError("storage_access_denied", 403);
    }
    const stub = env.RELAY_SHARDS.get(id);
    const access = await stub.authorizeStorageAccess(
      identity.operationId,
      identity.ownerGeneration,
    );
    if (!access.ok) {
      await cancelRequestBody(request);
      return jsonError(access.error.code, access.error.status);
    }
    const gatewayGrant = gatewayStorageGrant(action, request, access.grant);
    if (gatewayGrant === null) {
      await cancelRequestBody(request);
      return jsonError("storage_access_denied", 403);
    }
    const response = await handleStorageGatewayRequest(storageGatewayEnv(env), request, gatewayGrant);
    if (gatewayGrant.action !== STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT || !response.ok) {
      return response;
    }
    return persistStorageResultResponse(stub, response, gatewayGrant);
  };
}

function storageActionEnabled(
  action: StorageGatewayAction,
  env: ContainerStorageRuntimeEnvironment,
): boolean {
  const value =
    action === STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET
      ? env.CONTAINER_STORAGE_R2_READ_ENABLED
      : action === STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT
        ? env.CONTAINER_STORAGE_R2_WRITE_ENABLED
        : action === STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET
          ? env.CONTAINER_STORAGE_KV_READ_ENABLED
          : env.CONTAINER_STORAGE_D1_READ_ENABLED;
  return value === "true";
}

function storageOperationIdentity(
  request: Request,
): { operationId: string; ownerGeneration: number } | null {
  const operationId = request.headers.get(STORAGE_OPERATION_ID_HEADER);
  const generation = request.headers.get(STORAGE_OWNER_GENERATION_HEADER);
  if (
    operationId === null ||
    operationId.length < 1 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(operationId) ||
    generation === null ||
    !/^[1-9]\d{0,15}$/.test(generation)
  ) {
    return null;
  }
  const ownerGeneration = Number(generation);
  return Number.isSafeInteger(ownerGeneration) ? { operationId, ownerGeneration } : null;
}

function gatewayStorageGrant(
  action: StorageGatewayAction,
  request: Request,
  grant: StorageAccessGrant,
): GatewayStorageAccessGrant | null {
  switch (action) {
    case STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET:
      return grant.input.mode === "r2" &&
        grant.input.request_object_key !== null &&
        grant.input.object_version !== null
        ? {
            action,
            key: grant.input.request_object_key,
            version: grant.input.object_version,
            sha256: grant.input.sha256,
            size: grant.input.size,
            content_type: grant.input.content_type,
          }
        : null;
    case STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT: {
      if (grant.result !== null) {
        return {
          action,
          operation_id: grant.operation_id,
          owner_generation: grant.owner_generation,
          provider_operation_id: grant.provider_operation_id,
          admission_sha256: grant.admission_sha256,
          sha256: grant.result.sha256,
          size: grant.result.size,
          content_type: grant.result.content_type,
        };
      }
      const sha256 = request.headers.get(CONTENT_SHA256_HEADER);
      const contentLength = request.headers.get("content-length");
      const contentType = request.headers.get("content-type");
      if (
        sha256 === null ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        contentLength === null ||
        !/^\d+$/.test(contentLength) ||
        contentType === null
      ) {
        return null;
      }
      const size = Number(contentLength);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_R2_OBJECT_BYTES) return null;
      return {
        action,
        operation_id: grant.operation_id,
        owner_generation: grant.owner_generation,
        provider_operation_id: grant.provider_operation_id,
        admission_sha256: grant.admission_sha256,
        sha256,
        size,
        content_type: contentType,
      };
    }
    case STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET:
      return { action, operation_kind: grant.operation_kind };
    case STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET:
      return {
        action,
        operation_id: grant.operation_id,
        owner_generation: grant.owner_generation,
      };
  }
}

function storageGatewayEnv(env: Cloudflare.Env): StorageGatewayEnvironment {
  return {
    CONTAINER_STORAGE_GATEWAY_ENABLED: "true",
    CONTAINER_STORAGE_INPUT_R2: env.FILE_BUCKET,
    CONTAINER_STORAGE_RESULT_R2: env.FILE_BUCKET,
    CONTAINER_STORAGE_CONFIG_KV: env.CONFIG_KV,
    CONTAINER_STORAGE_ADMISSION_DB: env.DB,
  };
}

async function persistStorageResultResponse(
  stub: DurableObjectStub<RelayShardContainer>,
  response: Response,
  grant: R2ResultPutGrant,
): Promise<Response> {
  const status = response.status;
  const headers = new Headers(response.headers);
  const objectVersion = response.headers.get(R2_OBJECT_VERSION_HEADER);
  if (
    objectVersion === null ||
    objectVersion.length < 1 ||
    objectVersion.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(objectVersion)
  ) {
    await response.body?.cancel("storage_result_invalid").catch(() => undefined);
    return jsonError("storage_result_invalid", 502);
  }
  let body: Uint8Array;
  try {
    body = await readBoundedResponse(response, 1024);
  } catch {
    return jsonError("storage_result_invalid", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    return jsonError("storage_result_invalid", 502);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return jsonError("storage_result_invalid", 502);
  }
  const record = value as Record<string, unknown>;
  const expectedKey = deriveR2ResultKey(grant);
  if (
    record.key !== expectedKey ||
    record.sha256 !== grant.sha256 ||
    record.size !== grant.size ||
    typeof record.replayed !== "boolean" ||
    Object.keys(record).some(
      (key) => !["key", "sha256", "size", "replayed"].includes(key),
    )
  ) {
    return jsonError("storage_result_invalid", 502);
  }
  const persisted = await stub.recordStorageResult(grant.operation_id, grant.owner_generation, {
    object_key: expectedKey,
    object_version: objectVersion,
    sha256: grant.sha256,
    size: grant.size,
    content_type: grant.content_type,
  });
  if (!persisted.ok) return jsonError(persisted.error.code, persisted.error.status);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status, headers });
}

async function cancelRequestBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return;
  await request.body.cancel("storage_request_rejected").catch(() => undefined);
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

function controllerLedgerPolicy(env: ControllerRuntimeEnvironment): RelayShardLedgerPolicy {
  return {
    maxInFlight: configuredInteger(env.CONTAINER_MAX_IN_FLIGHT_PER_SHARD, 1, 64),
    dispatchRetentionSeconds: DISPATCH_REPLAY_RETENTION_SECONDS,
    terminalRetentionSeconds: configuredInteger(
      env.CONTAINER_TERMINAL_RETENTION_SECONDS,
      DISPATCH_REPLAY_RETENTION_SECONDS,
      31_536_000,
    ),
    maxTerminalOperations: configuredInteger(env.CONTAINER_MAX_TERMINAL_OPERATIONS, 1, 1_000_000),
  };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  deadlineAtMs?: number,
): Promise<Uint8Array> {
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
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = deadlineAtMs === undefined
          ? await reader.read()
          : await withAbsoluteDeadline(
              reader.read(),
              deadlineAtMs,
              "container_readiness_timeout",
              504,
            );
      } catch (error) {
        await reader.cancel("container_response_aborted").catch(() => undefined);
        throw error;
      }
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

async function withAbsoluteDeadline<T>(
  operation: Promise<T>,
  deadlineAtMs: number,
  code: string,
  status: number,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw new ProtocolError(code, status);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ProtocolError(code, status)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function boundedLogValue(value: unknown): string {
  return String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
}

function validatePersistedContainerResult(
  ledger: RelayShardLedger,
  envelope: OperationEnvelope,
  reported: StorageResultRecord | null,
): void {
  const row = ledger.readOperationOutcome(envelope.operation_id);
  if (row === null || row.owner_generation !== envelope.owner_generation) {
    throw new ProtocolError("container_result_unavailable", 502);
  }
  const persisted = operationStorageResult(row);
  if (reported === null && persisted === null) return;
  if (
    reported === null ||
    persisted === null ||
    reported.object_key !== persisted.object_key ||
    reported.object_version !== persisted.object_version ||
    reported.sha256 !== persisted.sha256 ||
    reported.size !== persisted.size ||
    reported.content_type !== persisted.content_type
  ) {
    throw new ProtocolError("container_result_mismatch", 502);
  }
}

function authoritySecretConfigured(secret: string): boolean {
  return new TextEncoder().encode(secret).length >= 32;
}

function containerStateSnapshot(state: Awaited<ReturnType<RelayShardContainer["getState"]>>): ContainerStateSnapshot {
  return {
    status: state.status,
    last_change_ms: state.lastChange,
    exit_code: "exitCode" in state ? state.exitCode ?? null : null,
  };
}

function validateRuntimeReadinessResponse(
  response: Response,
  body: Uint8Array,
): {
  protocol_version: number;
  shard_contract_version: number;
  execution_enabled: boolean;
} {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["status", "protocol_version", "shard_contract_version", "execution_enabled"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record)) ||
    record.status !== "ready" ||
    record.protocol_version !== 1 ||
    record.shard_contract_version !== 1 ||
    typeof record.execution_enabled !== "boolean"
  ) {
    throw new ProtocolError("invalid_container_readiness", 502);
  }
  return {
    protocol_version: record.protocol_version,
    shard_contract_version: record.shard_contract_version,
    execution_enabled: record.execution_enabled,
  };
}
