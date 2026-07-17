import type { TerminalAckLedgerOutcome } from "./ledger";
import {
  ProtocolError,
  verifyTerminalAckRequest,
  verifyTerminalAckV2Request,
  type AuthorityEnvironment,
  type TerminalAckRequest,
} from "./protocol";

/** Exact successful JSON response for the private terminal-ack endpoint. */
export interface TerminalAckResponse {
  protocol_version: 1;
  billing_event_id: string;
  operation_id: string;
  reconciliation_revision: 1 | 2;
  status: "acknowledged" | "duplicate";
  final_ack: boolean;
  acknowledged_at: number | null;
}

/** Strict error JSON response; `retryable` is reserved for explicit callers. */
export interface TerminalAckErrorResponse {
  error: string;
  retryable?: boolean;
}

export type ShardTerminalAckRpcResult =
  | { ok: true; result: TerminalAckLedgerOutcome }
  | { ok: false; error: { code: string; status: number } };

interface TerminalAckStub {
  acknowledgeGlobalTerminal(ack: TerminalAckRequest): Promise<ShardTerminalAckRpcResult>;
}

export interface TerminalAckEnvironment extends AuthorityEnvironment {
  CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED: string;
  RELAY_SHARDS: {
    getByName(name: string): TerminalAckStub;
  };
}

export async function handleTerminalAckRequest(
  request: Request,
  env: TerminalAckEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyTerminalAckRequest(request, env, now);
    if (env.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED !== "true") {
      return jsonError("container_global_terminal_ack_disabled", 503);
    }
    const stub = env.RELAY_SHARDS.getByName(verified.ack.shard.instance_name);
    const outcome = await stub.acknowledgeGlobalTerminal(verified.ack);
    if (!outcome.ok) return jsonError(outcome.error.code, outcome.error.status);
    const body: TerminalAckResponse = {
      protocol_version: verified.ack.protocol_version,
      billing_event_id: verified.ack.billing_event_id,
      operation_id: verified.ack.operation_id,
      reconciliation_revision: verified.ack.reconciliation_revision,
      status: outcome.result.kind,
      final_ack: outcome.result.finalAck,
      acknowledged_at: outcome.result.acknowledgedAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("terminal_ack_unavailable", 503);
  }
}

export async function handleTerminalAckV2Request(
  request: Request,
  env: TerminalAckEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyTerminalAckV2Request(request, env, now);
    if (env.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED !== "true") {
      return jsonError("container_global_terminal_ack_disabled", 503);
    }
    const stub = env.RELAY_SHARDS.getByName(verified.ack.shard.instance_name);
    const outcome = await stub.acknowledgeGlobalTerminal(verified.ack);
    if (!outcome.ok) return jsonError(outcome.error.code, outcome.error.status);
    const body: TerminalAckResponse = {
      protocol_version: verified.ack.protocol_version,
      billing_event_id: verified.ack.billing_event_id,
      operation_id: verified.ack.operation_id,
      reconciliation_revision: verified.ack.reconciliation_revision,
      status: outcome.result.kind,
      final_ack: outcome.result.finalAck,
      acknowledged_at: outcome.result.acknowledgedAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("terminal_ack_unavailable", 503);
  }
}

export type {
  TerminalAckProviderUsageBinding,
  TerminalAckRequest,
  TerminalAckRequestV1,
  TerminalAckRequestV2,
  TerminalAckResultManifest,
} from "./protocol";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonError(error: string, status: number, retryable?: boolean): Response {
  const body: TerminalAckErrorResponse =
    retryable === undefined ? { error } : { error, retryable };
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
