import { Container, ContainerProxy } from "@cloudflare/containers";
import {
  DISPATCH_REPLAY_RETENTION_SECONDS,
  RelayShardLedger,
  type OperationRow,
  type OperationStatus,
  type RelayShardLedgerPolicy,
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

export { ContainerProxy };

interface ControllerRuntimeEnvironment extends AuthorityEnvironment {
  CONTAINER_CONTROLLER_ENABLED: string;
  CONTAINER_EXECUTION_ENABLED: string;
  CONTAINER_READINESS_PROBE_ENABLED: string;
  CONTAINER_READINESS_WAKE_ENABLED: string;
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

  private readonly ledger = new RelayShardLedger(this.ctx.storage);

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
        this.ledger.transitionOperation(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "claimed",
          "failed",
          503,
          now,
        );
        return jsonError("container_execution_disabled", 503);
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
        return jsonError("container_execution_ambiguous", 504);
      }
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
        validateContainerOperationResponse(upstream, body, verified.envelope);
      } catch (error) {
        if (error instanceof ProtocolError) {
          this.ledger.transitionOperation(
            verified.envelope.operation_id,
            verified.envelope.owner_generation,
            "running",
            "failed",
            error.status,
            Math.floor(Date.now() / 1000),
          );
          return jsonError(error.code, error.status);
        }
        this.ledger.transitionOperation(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          "running",
          "failed",
          504,
          Math.floor(Date.now() / 1000),
        );
        return jsonError("container_execution_ambiguous", 504);
      }
      const status: OperationStatus = upstream.ok ? "completed" : "failed";
      const completed = this.ledger.transitionOperation(
        verified.envelope.operation_id,
        verified.envelope.owner_generation,
        "running",
        status,
        upstream.status,
        Math.floor(Date.now() / 1000),
        true,
      );
      if (!completed) {
        this.ledger.expireOperation(
          verified.envelope.operation_id,
          verified.envelope.owner_generation,
          Math.floor(Date.now() / 1000),
        );
        return jsonError("container_execution_ambiguous", 504);
      }
      return new Response(body, { status: upstream.status, headers: jsonHeaders });
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

function validateContainerOperationResponse(
  response: Response,
  body: Uint8Array,
  envelope: Pick<OperationEnvelope, "protocol_version" | "operation_id" | "trace_id">,
): void {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError("invalid_container_response", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    throw new ProtocolError("invalid_container_response", 502);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_container_response", 502);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = ["protocol_version", "operation_id", "status", "code", "trace_id"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    !["protocol_version", "operation_id", "status", "trace_id"].every((key) => key in record) ||
    record.protocol_version !== envelope.protocol_version ||
    record.operation_id !== envelope.operation_id ||
    record.trace_id !== envelope.trace_id ||
    (record.status !== "accepted" && record.status !== "rejected") ||
    (response.ok && (record.status !== "accepted" || record.code !== undefined)) ||
    (!response.ok && (record.status !== "rejected" || typeof record.code !== "string"))
  ) {
    throw new ProtocolError("invalid_container_response", 502);
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
