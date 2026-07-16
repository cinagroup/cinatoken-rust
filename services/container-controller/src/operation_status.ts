import type { OperationRow, OperationStatusSnapshot } from "./ledger";
import { operationOutcomeResponse, operationStatusResponse } from "./operation_outcome";
import {
  ProtocolError,
  verifyOperationStatusRequest,
  verifyOperationStatusV2Request,
  type AuthorityEnvironment,
  type OperationStatusQuery,
} from "./protocol";

export type ShardOperationStatusRpcResult =
  | { ok: true; row: OperationRow }
  | { ok: false; error: { code: string; status: number } };

export type ShardOperationStatusV2RpcResult =
  | { ok: true; snapshot: OperationStatusSnapshot }
  | { ok: false; error: { code: string; status: number } };

interface OperationStatusStub {
  readOperationStatus(query: OperationStatusQuery): Promise<ShardOperationStatusRpcResult>;
  readOperationStatusV2(query: OperationStatusQuery): Promise<ShardOperationStatusV2RpcResult>;
}

export interface OperationStatusEnvironment extends AuthorityEnvironment {
  RELAY_SHARDS: {
    getByName(name: string): OperationStatusStub;
  };
}

export async function handleOperationStatusRequest(
  request: Request,
  env: OperationStatusEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyOperationStatusRequest(request, env, now);
    const stub = env.RELAY_SHARDS.getByName(verified.query.shard.instance_name);
    const result = await stub.readOperationStatus(verified.query);
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return operationOutcomeResponse(result.row);
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("operation_status_unavailable", 503);
  }
}

export async function handleOperationStatusV2Request(
  request: Request,
  env: OperationStatusEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyOperationStatusV2Request(request, env, now);
    const stub = env.RELAY_SHARDS.getByName(verified.query.shard.instance_name);
    const result = await stub.readOperationStatusV2(verified.query);
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return operationStatusResponse(result.snapshot);
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("operation_status_unavailable", 503);
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
