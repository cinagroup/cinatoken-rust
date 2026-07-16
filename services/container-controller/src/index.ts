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
