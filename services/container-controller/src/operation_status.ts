import type {
  OperationRow,
  OperationStatusSnapshot,
  OperationStatusV4Snapshot,
} from "./ledger";
import {
  operationOutcomeResponse,
  operationStatusResponse,
  operationStatusResponseV3,
  operationStatusResponseV4,
} from "./operation_outcome";
import {
  ProtocolError,
  verifyOperationStatusRequest,
  verifyOperationStatusV2Request,
  verifyOperationStatusV3Request,
  verifyOperationStatusV4Request,
  type AuthorityEnvironment,
  type OperationStatusQuery,
} from "./protocol";
import {
  selectRelayShardNamespace,
  type RelayShardJurisdictionEnvironment,
  type RelayShardNamespaceLike,
} from "./relay_shard_jurisdiction";

export type ShardOperationStatusRpcResult =
  | { ok: true; row: OperationRow }
  | { ok: false; error: { code: string; status: number } };

export type ShardOperationStatusV2RpcResult =
  | { ok: true; snapshot: OperationStatusSnapshot }
  | { ok: false; error: { code: string; status: number } };

export type ShardOperationStatusV3RpcResult =
  | { ok: true; snapshot: OperationStatusSnapshot }
  | { ok: false; error: { code: string; status: number } };

export type ShardOperationStatusV4RpcResult =
  | { ok: true; snapshot: OperationStatusV4Snapshot }
  | { ok: false; error: { code: string; status: number } };

interface OperationStatusStub {
  readOperationStatus(query: OperationStatusQuery): Promise<ShardOperationStatusRpcResult>;
  readOperationStatusV2(query: OperationStatusQuery): Promise<ShardOperationStatusV2RpcResult>;
  readOperationStatusV3(query: OperationStatusQuery): Promise<ShardOperationStatusV3RpcResult>;
}

interface OperationStatusV4Stub {
  readOperationStatusV4(query: OperationStatusQuery): Promise<ShardOperationStatusV4RpcResult>;
}

export interface OperationStatusEnvironment
  extends AuthorityEnvironment, RelayShardJurisdictionEnvironment {
  RELAY_SHARDS: RelayShardNamespaceLike<OperationStatusStub>;
}

export interface OperationStatusV4Environment
  extends AuthorityEnvironment, RelayShardJurisdictionEnvironment {
  RELAY_SHARDS: RelayShardNamespaceLike<OperationStatusV4Stub>;
}

export async function handleOperationStatusRequest(
  request: Request,
  env: OperationStatusEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyOperationStatusRequest(request, env, now);
    const stub = selectRelayShardNamespace(env).getByName(
      verified.query.shard.instance_name,
    );
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
    const stub = selectRelayShardNamespace(env).getByName(
      verified.query.shard.instance_name,
    );
    const result = await stub.readOperationStatusV2(verified.query);
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return operationStatusResponse(result.snapshot);
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("operation_status_unavailable", 503);
  }
}

export async function handleOperationStatusV3Request(
  request: Request,
  env: OperationStatusEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyOperationStatusV3Request(request, env, now);
    const stub = selectRelayShardNamespace(env).getByName(
      verified.query.shard.instance_name,
    );
    const result = await stub.readOperationStatusV3(verified.query);
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return operationStatusResponseV3(result.snapshot);
  } catch (error) {
    if (error instanceof ProtocolError) return jsonError(error.code, error.status);
    return jsonError("operation_status_unavailable", 503);
  }
}

export async function handleOperationStatusV4Request(
  request: Request,
  env: OperationStatusV4Environment,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  try {
    const verified = await verifyOperationStatusV4Request(request, env, now);
    const stub = selectRelayShardNamespace(env).getByName(
      verified.query.shard.instance_name,
    );
    const result = await stub.readOperationStatusV4(verified.query);
    if (!result.ok) return jsonError(result.error.code, result.error.status);
    return operationStatusResponseV4(result.snapshot);
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
