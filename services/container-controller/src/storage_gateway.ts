import {
  ProtocolError,
  type OperationEnvelope,
  type OperationInput,
  type OperationShard,
} from "./protocol";

export const R2_INPUT_HOST = "r2-input.cinatoken.internal";
export const R2_RESULT_HOST = "r2-result.cinatoken.internal";
export const KV_CONFIG_HOST = "kv-config.cinatoken.internal";
export const D1_ADMISSION_HOST = "d1-admission.cinatoken.internal";

export const R2_INPUT_PATH = "/v1/input";
export const R2_RESULT_PATH = "/v1/result";
export const KV_CONFIG_PATH = "/v1/config";
export const D1_ADMISSION_PATH = "/v1/admission";

export const CONTENT_SHA256_HEADER = "x-cinatoken-content-sha256";
export const R2_OBJECT_VERSION_HEADER = "x-cinatoken-r2-version";
export const PROVIDER_ATTEMPT_GENERATION_HEADER =
  "x-cinatoken-provider-attempt-generation";
export const OPERATION_ID_HEADER = "x-cinatoken-operation-id";
export const OWNER_GENERATION_HEADER = "x-cinatoken-owner-generation";
export const MAX_R2_OBJECT_BYTES = 64 * 1024 * 1024;
export const MAX_KV_CONFIG_BYTES = 32 * 1024;
export const KV_OPERATION_CONFIG_PREFIX = "container-operation-config/v1/";
export const R2_RESULT_KEY_PREFIX = "container-results/v1";

export const STORAGE_GATEWAY_ACTIONS = {
  R2_INPUT_GET: "r2_input_get",
  R2_RESULT_PUT: "r2_result_put",
  KV_CONFIG_GET: "kv_config_get",
  D1_ADMISSION_GET: "d1_admission_get",
} as const;

export type StorageGatewayAction =
  (typeof STORAGE_GATEWAY_ACTIONS)[keyof typeof STORAGE_GATEWAY_ACTIONS];

export interface R2InputGetGrant {
  action: typeof STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET;
  key: string;
  version: string;
  sha256: string;
  size: number;
  content_type: string;
}

export interface R2ResultPutGrant {
  action: typeof STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT;
  operation_id: string;
  owner_generation: number;
  provider_operation_id: string;
  admission_sha256: string;
  attempt_generation: number | null;
  egress_profile: string | null;
  egress_worker_version_id: string | null;
  sha256: string;
  size: number;
  content_type: string;
}

export interface KvConfigGetGrant {
  action: typeof STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET;
  operation_kind: string;
}

export interface D1AdmissionGetGrant {
  action: typeof STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET;
  protocol_version: number;
  operation_id: string;
  operation_kind: string;
  owner_generation: number;
  owner_lease_expires_at: number;
  execution_deadline_at: number;
  provider_operation_id: string;
  admission_sha256: string;
  input: OperationInput;
  shard: OperationShard;
  trace_id: string;
}

export type StorageAccessGrant =
  | R2InputGetGrant
  | R2ResultPutGrant
  | KvConfigGetGrant
  | D1AdmissionGetGrant;

export type StorageGatewayD1Database = Pick<D1Database, "prepare"> &
  Partial<Pick<D1Database, "withSession">>;

export interface StorageGatewayEnvironment {
  CONTAINER_STORAGE_GATEWAY_ENABLED?: string;
  CONTAINER_STORAGE_INPUT_R2?: Pick<R2Bucket, "get">;
  CONTAINER_STORAGE_RESULT_R2?: Pick<R2Bucket, "head" | "put">;
  CONTAINER_STORAGE_CONFIG_KV?: Pick<KVNamespace, "get">;
  CONTAINER_STORAGE_ADMISSION_DB?: StorageGatewayD1Database;
}

export interface ProviderEgressAdmission {
  protocol_version: number;
  operation_id: string;
  operation_kind: string;
  owner_generation: number;
  owner_lease_expires_at: number;
  deadline_at: number;
  provider_operation_id: string;
  admission_sha256: string;
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
}

export interface ProviderEgressGrantIdentity {
  attempt_generation: number;
  request_sha256: string;
  egress_profile: string;
  egress_worker_version_id: string;
}

export interface ProviderEgressGrantOutcome {
  replayed: boolean;
  authorized_at: number;
}

interface StorageRoute {
  host: string;
  method: "GET" | "PUT";
  path: string;
}

export interface D1AdmissionSnapshot {
  reservation_key: string;
  operation_reservation_key: string;
  reservation_status: string;
  lease_expires_at: number;
  owner_deadline_at: number;
  reservation_owner_generation: number;
  reservation_channel_id: number;
  reservation_selected_group: string;
  reservation_selected_at: number;
  model_name: string;
  endpoint_path: string;
  billing_kind: string;
  billing_contract_hash: string;
  billing_snapshot_json: string;
  operation_id: string;
  owner_generation: number;
  owner_lease_expires_at: number;
  channel_id: number;
  selected_group: string;
  operation_kind: string;
  provider_operation_id: string;
  admission_sha256: string;
  protocol_version: number;
  shard_contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
  execution_deadline_at: number;
  input_mode: string;
  input_object_key: string;
  input_object_version: string;
  input_sha256: string;
  input_size: number;
  input_content_type: string;
  trace_id: string;
  operation_status: string;
  operation_created_at: number;
  operation_updated_at: number;
}

interface ProviderEgressGrantRow {
  operation_id: string;
  reservation_key: string;
  owner_generation: number;
  attempt_generation: number;
  provider_operation_id: string;
  admission_sha256: string;
  request_sha256: string;
  egress_profile: string;
  egress_worker_version_id: string;
  channel_id: number;
  selected_group: string;
  model_name: string;
  endpoint_path: string;
  input_mode: string;
  input_object_key: string;
  input_object_version: string;
  input_sha256: string;
  input_size: number;
  input_content_type: string;
  billing_kind: string;
  billing_contract_hash: string;
  billing_snapshot_sha256: string;
  stream_policy: string;
  operation_created_at: number;
  operation_dispatched_at: number;
  authorized_at: number;
  execution_deadline_at: number;
  owner_lease_expires_at: number;
  reservation_owner_deadline_at: number;
  reservation_lease_expires_at: number;
}

const ROUTES: Record<StorageGatewayAction, StorageRoute> = {
  [STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET]: {
    host: R2_INPUT_HOST,
    method: "GET",
    path: R2_INPUT_PATH,
  },
  [STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT]: {
    host: R2_RESULT_HOST,
    method: "PUT",
    path: R2_RESULT_PATH,
  },
  [STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET]: {
    host: KV_CONFIG_HOST,
    method: "GET",
    path: KV_CONFIG_PATH,
  },
  [STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET]: {
    host: D1_ADMISSION_HOST,
    method: "GET",
    path: D1_ADMISSION_PATH,
  },
};

const ADMISSION_SNAPSHOT_SQL = `
SELECT reservation.reservation_key,
       operation.reservation_key AS operation_reservation_key,
       reservation.status AS reservation_status,
       reservation.lease_expires_at,
       reservation.owner_deadline_at,
       reservation.owner_generation AS reservation_owner_generation,
       reservation.channel_id AS reservation_channel_id,
       reservation.selected_group AS reservation_selected_group,
       reservation.selected_at AS reservation_selected_at,
       reservation.model_name,
       reservation.endpoint_path,
       reservation.billing_kind,
       reservation.expr_hash AS billing_contract_hash,
       reservation.billing_snapshot_json,
       operation.operation_id,
       operation.owner_generation,
       operation.owner_lease_expires_at,
       operation.channel_id,
       operation.selected_group,
       operation.operation_kind,
       operation.provider_operation_id,
       operation.admission_sha256,
       operation.protocol_version,
       operation.shard_contract_version,
       operation.ring_generation,
       operation.shard_count,
       operation.shard_index,
       operation.instance_name,
       operation.execution_deadline_at,
       operation.input_mode,
       operation.input_object_key,
       operation.input_object_version,
       operation.input_sha256,
       operation.input_size,
       operation.input_content_type,
       operation.trace_id,
       operation.status AS operation_status,
       operation.created_at AS operation_created_at,
       operation.updated_at AS operation_updated_at
FROM relay_container_operations AS operation
JOIN relay_billing_reservations AS reservation
  ON reservation.reservation_key = operation.reservation_key
WHERE operation.operation_id = ?1
  AND operation.owner_generation = ?2
  AND reservation.owner_generation = ?2
LIMIT 1
`.trim();

const PROVIDER_EGRESS_GRANT_INSERT_SQL = `
INSERT OR IGNORE INTO relay_container_provider_egress_grants (
  operation_id,
  reservation_key,
  owner_generation,
  attempt_generation,
  provider_operation_id,
  admission_sha256,
  request_sha256,
  egress_profile,
  egress_worker_version_id,
  channel_id,
  selected_group,
  model_name,
  endpoint_path,
  input_mode,
  input_object_key,
  input_object_version,
  input_sha256,
  input_size,
  input_content_type,
  billing_kind,
  billing_contract_hash,
  billing_snapshot_sha256,
  stream_policy,
  operation_created_at,
  operation_dispatched_at,
  authorized_at,
  execution_deadline_at,
  owner_lease_expires_at,
  reservation_owner_deadline_at,
  reservation_lease_expires_at
)
SELECT operation.operation_id,
       reservation.reservation_key,
       operation.owner_generation,
       ?3,
       operation.provider_operation_id,
       operation.admission_sha256,
       ?4,
       ?5,
       ?6,
       operation.channel_id,
       operation.selected_group,
       reservation.model_name,
       reservation.endpoint_path,
       operation.input_mode,
       operation.input_object_key,
       operation.input_object_version,
       operation.input_sha256,
       operation.input_size,
       operation.input_content_type,
       reservation.billing_kind,
       reservation.expr_hash,
       ?24,
       'non_streaming',
       operation.created_at,
       operation.updated_at,
       ?7,
       operation.execution_deadline_at,
       operation.owner_lease_expires_at,
       reservation.owner_deadline_at,
       reservation.lease_expires_at
FROM relay_container_operations AS operation
JOIN relay_billing_reservations AS reservation
  ON reservation.reservation_key = operation.reservation_key
WHERE operation.operation_id = ?1
  AND operation.owner_generation = ?2
  AND ?3 = 1
  AND operation.protocol_version = 1
  AND operation.status = 'dispatched'
  AND reservation.status = 'reserved'
  AND reservation.owner_generation = operation.owner_generation
  AND reservation.selected_at > 0
  AND reservation.selected_at <= operation.created_at
  AND operation.input_sha256 = ?4
  AND ?7 >= operation.updated_at
  AND ?7 < operation.execution_deadline_at
  AND ?7 < operation.owner_lease_expires_at
  AND ?7 < reservation.owner_deadline_at
  AND ?7 < reservation.lease_expires_at
  AND reservation.reservation_key = ?8
  AND operation.provider_operation_id = ?9
  AND operation.admission_sha256 = ?10
  AND operation.channel_id = ?11
  AND reservation.channel_id = ?11
  AND operation.selected_group = ?12
  AND reservation.selected_group = ?12
  AND reservation.model_name = ?13
  AND reservation.endpoint_path = ?14
  AND operation.input_mode = ?15
  AND operation.input_object_key = ?16
  AND operation.input_object_version = ?17
  AND operation.input_sha256 = ?18
  AND operation.input_size = ?19
  AND operation.input_content_type = ?20
  AND reservation.billing_kind = ?21
  AND reservation.expr_hash = ?22
  AND length(?23) BETWEEN 1 AND 32768
  AND reservation.billing_snapshot_json = ?23
  AND operation.created_at = ?25
  AND operation.updated_at = ?26
  AND operation.execution_deadline_at = ?27
  AND operation.owner_lease_expires_at = ?28
  AND reservation.owner_deadline_at = ?29
  AND reservation.lease_expires_at = ?30
`.trim();

const PROVIDER_EGRESS_GRANT_READBACK_SQL = `
SELECT operation_id,
       reservation_key,
       owner_generation,
       attempt_generation,
       provider_operation_id,
       admission_sha256,
       request_sha256,
       egress_profile,
       egress_worker_version_id,
       channel_id,
       selected_group,
       model_name,
       endpoint_path,
       input_mode,
       input_object_key,
       input_object_version,
       input_sha256,
       input_size,
       input_content_type,
       billing_kind,
       billing_contract_hash,
       billing_snapshot_sha256,
       stream_policy,
       operation_created_at,
       operation_dispatched_at,
       authorized_at,
       execution_deadline_at,
       owner_lease_expires_at,
       reservation_owner_deadline_at,
       reservation_lease_expires_at
FROM relay_container_provider_egress_grants
WHERE operation_id = ?1
  AND owner_generation = ?2
  AND attempt_generation = ?3
LIMIT 1
`.trim();

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const STORAGE_KEY = /^[A-Za-z0-9/_.:-]+$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const OPERATION_KIND = /^[a-z0-9_:-]+$/;
const EGRESS_IDENTITY = /^[A-Za-z0-9._:/@-]+$/;
const MODEL_NAME = /^[A-Za-z0-9._:/-]+$/;
const ENDPOINT_PATH = /^[A-Za-z0-9_./:-]+$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/;
const MAX_BILLING_SNAPSHOT_BYTES = 32 * 1024;

class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export async function handleStorageGatewayRequest(
  env: StorageGatewayEnvironment,
  request: Request,
  grant: StorageAccessGrant | null | undefined,
): Promise<Response> {
  if (env.CONTAINER_STORAGE_GATEWAY_ENABLED !== "true") {
    return rejectRequest(request, "storage_gateway_disabled", 503);
  }
  if (!isStorageAccessGrant(grant)) {
    return rejectRequest(request, "storage_access_denied", 403);
  }

  const route = ROUTES[grant.action];
  const url = new URL(request.url);
  if (!matchesRoute(url, route)) {
    return rejectRequest(request, "storage_route_not_found", 404);
  }
  if (request.method !== route.method) {
    return rejectRequest(request, "storage_method_not_allowed", 405, { allow: route.method });
  }

  try {
    if (route.method === "GET") await requireEmptyRequest(request);
    switch (grant.action) {
      case STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET:
        return await getR2Input(env, grant);
      case STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT:
        return await putR2Result(env, request, grant);
      case STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET:
        return await getKvConfig(env, grant);
      case STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET:
        return await getD1Admission(env, grant);
    }
  } catch (error) {
    await cancelRequestBody(request);
    if (error instanceof GatewayError) return jsonError(error.code, error.status);
    return jsonError("storage_gateway_failure", 503);
  }
}

export function deriveR2ResultKey(grant: R2ResultPutGrant): string {
  return `${R2_RESULT_KEY_PREFIX}/${grant.operation_id}/${grant.owner_generation}/${grant.sha256}`;
}

export function deriveKvConfigKey(operationKind: string): string {
  return `${KV_OPERATION_CONFIG_PREFIX}${operationKind}`;
}

async function getR2Input(
  env: StorageGatewayEnvironment,
  grant: R2InputGetGrant,
): Promise<Response> {
  enforceR2Limit(grant.size);
  const bucket = env.CONTAINER_STORAGE_INPUT_R2;
  if (bucket === undefined) throw new GatewayError("storage_binding_unavailable", 503);

  const object = await bucket.get(grant.key);
  if (object === null) throw new GatewayError("r2_input_not_found", 404);
  if (!r2ObjectMatches(object, grant.key, grant.version, grant.size, grant.content_type, grant.sha256)) {
    await cancelStream(object.body);
    throw new GatewayError("r2_input_integrity_mismatch", 502);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(grant.size),
      "content-type": grant.content_type,
      [CONTENT_SHA256_HEADER]: grant.sha256,
      [R2_OBJECT_VERSION_HEADER]: grant.version,
    },
  });
}

async function putR2Result(
  env: StorageGatewayEnvironment,
  request: Request,
  grant: R2ResultPutGrant,
): Promise<Response> {
  enforceR2Limit(grant.size);
  requireResultHeaders(request, grant);
  const bucket = env.CONTAINER_STORAGE_RESULT_R2;
  if (bucket === undefined) throw new GatewayError("storage_binding_unavailable", 503);

  const key = deriveR2ResultKey(grant);
  const customMetadata = resultMetadata(grant);
  let created: R2Object | null;
  try {
    created = await bucket.put(key, request.body, {
      onlyIf: new Headers({ "if-none-match": "*" }),
      httpMetadata: { contentType: grant.content_type },
      customMetadata,
      sha256: grant.sha256,
    });
  } finally {
    await cancelRequestBody(request);
  }

  if (created !== null) {
    if (!r2ResultMatches(created, key, grant, customMetadata)) {
      throw new GatewayError("r2_result_integrity_mismatch", 502);
    }
    return resultWriteResponse(key, created.version, grant, false, 201);
  }

  const existing = await bucket.head(key);
  if (existing !== null && r2ResultMatches(existing, key, grant, customMetadata)) {
    return resultWriteResponse(key, existing.version, grant, true, 200);
  }
  throw new GatewayError("r2_result_conflict", 409);
}

async function getKvConfig(
  env: StorageGatewayEnvironment,
  grant: KvConfigGetGrant,
): Promise<Response> {
  const namespace = env.CONTAINER_STORAGE_CONFIG_KV;
  if (namespace === undefined) throw new GatewayError("storage_binding_unavailable", 503);

  const stream = await namespace.get(deriveKvConfigKey(grant.operation_kind), "stream");
  if (stream === null) throw new GatewayError("kv_config_not_found", 404);
  const bytes = await readBoundedStream(stream, MAX_KV_CONFIG_BYTES);
  return new Response(bytes, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.byteLength),
      "content-type": "application/octet-stream",
    },
  });
}

async function getD1Admission(
  env: StorageGatewayEnvironment,
  grant: D1AdmissionGetGrant,
): Promise<Response> {
  const row = await readD1Admission(env, grant, Math.floor(Date.now() / 1000));
  return admissionResponse(row);
}

export async function requireD1OperationAdmission(
  env: StorageGatewayEnvironment,
  envelope: OperationEnvelope,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const grant: D1AdmissionGetGrant = {
    action: STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET,
    protocol_version: envelope.protocol_version,
    operation_id: envelope.operation_id,
    operation_kind: envelope.operation_kind,
    owner_generation: envelope.owner_generation,
    owner_lease_expires_at: envelope.owner_lease_expires_at,
    execution_deadline_at: envelope.execution_deadline_at,
    provider_operation_id: envelope.provider_operation_id,
    admission_sha256: envelope.admission_sha256,
    input: envelope.input,
    shard: envelope.shard,
    trace_id: envelope.trace_id,
  };
  if (!isStorageAccessGrant(grant)) {
    throw new ProtocolError("admission_authority_mismatch", 409);
  }
  try {
    await readD1Admission(env, grant, now);
  } catch (error) {
    if (error instanceof GatewayError) throw new ProtocolError(error.code, error.status);
    throw new ProtocolError("admission_unavailable", 503);
  }
}

export async function requireD1ProviderEgressAdmission(
  env: StorageGatewayEnvironment,
  admission: ProviderEgressAdmission,
  now = Math.floor(Date.now() / 1000),
): Promise<D1AdmissionSnapshot> {
  const grant: D1AdmissionGetGrant = {
    action: STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET,
    protocol_version: admission.protocol_version,
    operation_id: admission.operation_id,
    operation_kind: admission.operation_kind,
    owner_generation: admission.owner_generation,
    owner_lease_expires_at: admission.owner_lease_expires_at,
    execution_deadline_at: admission.deadline_at,
    provider_operation_id: admission.provider_operation_id,
    admission_sha256: admission.admission_sha256,
    input: {
      mode: admission.input.mode,
      sha256: admission.input.sha256,
      size: admission.input.size,
      content_type: admission.input.content_type,
      ...(admission.input.request_object_key === null
        ? {}
        : { request_object_key: admission.input.request_object_key }),
      ...(admission.input.object_version === null
        ? {}
        : { object_version: admission.input.object_version }),
    },
    shard: admission.shard,
    trace_id: admission.trace_id,
  };
  if (!isStorageAccessGrant(grant)) {
    throw new ProtocolError("provider_egress_admission_mismatch", 409);
  }
  try {
    const row = await readD1Admission(env, grant, now);
    if (row.operation_status !== "dispatched") {
      throw new GatewayError("provider_egress_not_dispatched", 409);
    }
    return row;
  } catch (error) {
    if (error instanceof GatewayError) throw new ProtocolError(error.code, error.status);
    throw new ProtocolError("provider_egress_admission_unavailable", 503);
  }
}

export async function requireD1ProviderEgressGrant(
  env: StorageGatewayEnvironment,
  admission: D1AdmissionSnapshot,
  identity: ProviderEgressGrantIdentity,
  now = Math.floor(Date.now() / 1000),
): Promise<ProviderEgressGrantOutcome> {
  if (
    !validAdmissionSnapshot(admission) ||
    admission.reservation_status !== "reserved" ||
    admission.operation_status !== "dispatched" ||
    admission.lease_expires_at <= now ||
    admission.owner_deadline_at <= now ||
    admission.owner_lease_expires_at <= now ||
    admission.execution_deadline_at <= now ||
    !validProviderEgressGrantIdentity(identity)
  ) {
    throw new ProtocolError("provider_egress_grant_authority_mismatch", 409);
  }

  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new ProtocolError("provider_egress_grant_unavailable", 503);
  }

  try {
    const billingSnapshotSha256 = await sha256Utf8(admission.billing_snapshot_json);
    const session = database.withSession("first-primary");
    const write = await session
      .prepare(PROVIDER_EGRESS_GRANT_INSERT_SQL)
      .bind(
        admission.operation_id,
        admission.owner_generation,
        identity.attempt_generation,
        identity.request_sha256,
        identity.egress_profile,
        identity.egress_worker_version_id,
        now,
        admission.reservation_key,
        admission.provider_operation_id,
        admission.admission_sha256,
        admission.channel_id,
        admission.selected_group,
        admission.model_name,
        admission.endpoint_path,
        admission.input_mode,
        admission.input_object_key,
        admission.input_object_version,
        admission.input_sha256,
        admission.input_size,
        admission.input_content_type,
        admission.billing_kind,
        admission.billing_contract_hash,
        admission.billing_snapshot_json,
        billingSnapshotSha256,
        admission.operation_created_at,
        admission.operation_updated_at,
        admission.execution_deadline_at,
        admission.owner_lease_expires_at,
        admission.owner_deadline_at,
        admission.lease_expires_at,
      )
      .run();
    const changes = write?.meta?.changes;
    if (write?.success !== true || (changes !== 0 && changes !== 1)) {
      throw new GatewayError("provider_egress_grant_write_invalid", 502);
    }

    const row = await session
      .prepare(PROVIDER_EGRESS_GRANT_READBACK_SQL)
      .bind(admission.operation_id, admission.owner_generation, identity.attempt_generation)
      .first<Record<string, unknown>>();
    if (row === null) {
      throw new GatewayError(
        changes === 1
          ? "provider_egress_grant_readback_invalid"
          : "provider_egress_grant_conflict",
        changes === 1 ? 502 : 409,
      );
    }
    if (!validProviderEgressGrantRow(row, now)) {
      throw new GatewayError("provider_egress_grant_readback_invalid", 502);
    }
    if (
      !providerEgressGrantMatches(
        row,
        admission,
        identity,
        billingSnapshotSha256,
        changes,
        now,
      )
    ) {
      throw new GatewayError("provider_egress_grant_conflict", 409);
    }
    return { replayed: changes === 0, authorized_at: row.authorized_at };
  } catch (error) {
    if (error instanceof GatewayError) {
      throw new ProtocolError(error.code, error.status);
    }
    throw new ProtocolError("provider_egress_grant_unavailable", 503);
  }
}

async function readD1Admission(
  env: StorageGatewayEnvironment,
  grant: D1AdmissionGetGrant,
  now: number,
): Promise<D1AdmissionSnapshot> {
  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined) throw new GatewayError("storage_binding_unavailable", 503);

  const row = await database
    .prepare(ADMISSION_SNAPSHOT_SQL)
    .bind(grant.operation_id, grant.owner_generation)
    .first<D1AdmissionSnapshot>();
  if (row === null) throw new GatewayError("admission_snapshot_not_found", 404);
  if (!validAdmissionSnapshot(row)) {
    throw new GatewayError("admission_snapshot_invalid", 502);
  }
  if (row.reservation_status !== "reserved") {
    throw new GatewayError("admission_not_reserved", 409);
  }
  if (row.operation_status !== "prepared" && row.operation_status !== "dispatched") {
    throw new GatewayError("admission_operation_not_active", 409);
  }
  if (
    row.lease_expires_at <= now ||
    row.owner_deadline_at <= now ||
    row.owner_deadline_at > row.lease_expires_at ||
    row.owner_lease_expires_at <= now ||
    row.execution_deadline_at <= now
  ) {
    throw new GatewayError("admission_lease_expired", 409);
  }
  if (!admissionAuthorityMatches(row, grant)) {
    throw new GatewayError("admission_authority_mismatch", 409);
  }
  return row;
}

function admissionResponse(row: D1AdmissionSnapshot): Response {
  return jsonResponse({
    status: row.reservation_status,
    operation_status: row.operation_status,
    lease_expires_at: row.lease_expires_at,
    owner_deadline_at: row.owner_deadline_at,
    owner_generation: row.owner_generation,
  });
}

function validAdmissionSnapshot(row: D1AdmissionSnapshot): boolean {
  return (
    validIdentifier(row.reservation_key, 128) &&
    validIdentifier(row.operation_reservation_key, 128) &&
    typeof row.reservation_status === "string" &&
    isPositiveInteger(row.lease_expires_at) &&
    isPositiveInteger(row.owner_deadline_at) &&
    isPositiveInteger(row.reservation_owner_generation) &&
    isPositiveInteger(row.reservation_channel_id) &&
    typeof row.reservation_selected_group === "string" &&
    row.reservation_selected_group.length >= 1 &&
    row.reservation_selected_group.length <= 64 &&
    isPositiveInteger(row.reservation_selected_at) &&
    typeof row.model_name === "string" &&
    row.model_name.length >= 1 &&
    row.model_name.length <= 200 &&
    MODEL_NAME.test(row.model_name) &&
    typeof row.endpoint_path === "string" &&
    row.endpoint_path.length >= 1 &&
    row.endpoint_path.length <= 256 &&
    ENDPOINT_PATH.test(row.endpoint_path) &&
    validBillingContract(row.billing_kind, row.billing_contract_hash) &&
    validBillingSnapshotJson(row.billing_snapshot_json) &&
    validIdentifier(row.operation_id, 128) &&
    isPositiveInteger(row.owner_generation) &&
    isPositiveInteger(row.owner_lease_expires_at) &&
    isPositiveInteger(row.channel_id) &&
    typeof row.selected_group === "string" &&
    row.selected_group.length >= 1 &&
    row.selected_group.length <= 64 &&
    typeof row.operation_kind === "string" &&
    row.operation_kind.length >= 1 &&
    row.operation_kind.length <= 64 &&
    OPERATION_KIND.test(row.operation_kind) &&
    validIdentifier(row.provider_operation_id, 128) &&
    validSha256(row.admission_sha256) &&
    isPositiveInteger(row.protocol_version) &&
    row.protocol_version <= 255 &&
    row.shard_contract_version === 1 &&
    isPositiveInteger(row.ring_generation) &&
    isPositiveInteger(row.shard_count) &&
    row.shard_count <= 1024 &&
    isNonNegativeInteger(row.shard_index) &&
    row.shard_index < row.shard_count &&
    validShardInstanceName(row.instance_name, row.shard_index) &&
    isPositiveInteger(row.execution_deadline_at) &&
    row.input_mode === "r2" &&
    validStorageKey(row.input_object_key) &&
    validIdentifier(row.input_object_version, 128) &&
    validSha256(row.input_sha256) &&
    isNonNegativeInteger(row.input_size) &&
    row.input_size <= MAX_R2_OBJECT_BYTES &&
    validContentType(row.input_content_type) &&
    validIdentifier(row.trace_id, 128) &&
    typeof row.operation_status === "string" &&
    isPositiveInteger(row.operation_created_at) &&
    isPositiveInteger(row.operation_updated_at) &&
    row.reservation_selected_at <= row.operation_created_at &&
    row.operation_created_at <= row.operation_updated_at &&
    row.operation_updated_at < row.execution_deadline_at
  );
}

function admissionAuthorityMatches(
  row: D1AdmissionSnapshot,
  grant: D1AdmissionGetGrant,
): boolean {
  return (
    row.reservation_key === row.operation_reservation_key &&
    row.reservation_owner_generation === row.owner_generation &&
    row.reservation_channel_id === row.channel_id &&
    row.reservation_selected_group === row.selected_group &&
    row.owner_generation === grant.owner_generation &&
    row.operation_id === grant.operation_id &&
    row.owner_lease_expires_at === grant.owner_lease_expires_at &&
    row.owner_lease_expires_at <= row.lease_expires_at &&
    row.execution_deadline_at <= row.owner_deadline_at &&
    row.execution_deadline_at <= row.owner_lease_expires_at &&
    row.operation_kind === grant.operation_kind &&
    row.provider_operation_id === grant.provider_operation_id &&
    row.admission_sha256 === grant.admission_sha256 &&
    row.protocol_version === grant.protocol_version &&
    row.shard_contract_version === grant.shard.contract_version &&
    row.ring_generation === grant.shard.ring_generation &&
    row.shard_count === grant.shard.shard_count &&
    row.shard_index === grant.shard.shard_index &&
    row.instance_name === grant.shard.instance_name &&
    row.execution_deadline_at === grant.execution_deadline_at &&
    row.input_mode === grant.input.mode &&
    row.input_object_key === grant.input.request_object_key &&
    row.input_object_version === grant.input.object_version &&
    row.input_sha256 === grant.input.sha256 &&
    row.input_size === grant.input.size &&
    row.input_content_type === grant.input.content_type &&
    row.trace_id === grant.trace_id
  );
}

function validProviderEgressGrantIdentity(identity: ProviderEgressGrantIdentity): boolean {
  return (
    identity.attempt_generation === 1 &&
    validSha256(identity.request_sha256) &&
    identity.egress_profile === "openai-chat-completions-canary-v1" &&
    validEgressIdentity(identity.egress_worker_version_id, 128)
  );
}

function validProviderEgressGrantRow(
  value: unknown,
  now: number,
): value is ProviderEgressGrantRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operation_id",
      "reservation_key",
      "owner_generation",
      "attempt_generation",
      "provider_operation_id",
      "admission_sha256",
      "request_sha256",
      "egress_profile",
      "egress_worker_version_id",
      "channel_id",
      "selected_group",
      "model_name",
      "endpoint_path",
      "input_mode",
      "input_object_key",
      "input_object_version",
      "input_sha256",
      "input_size",
      "input_content_type",
      "billing_kind",
      "billing_contract_hash",
      "billing_snapshot_sha256",
      "stream_policy",
      "operation_created_at",
      "operation_dispatched_at",
      "authorized_at",
      "execution_deadline_at",
      "owner_lease_expires_at",
      "reservation_owner_deadline_at",
      "reservation_lease_expires_at",
    ])
  ) {
    return false;
  }
  const row = value;
  return (
    validIdentifier(row.operation_id, 128) &&
    validIdentifier(row.reservation_key, 128) &&
    row.operation_id === row.reservation_key &&
    isPositiveInteger(row.owner_generation) &&
    row.attempt_generation === 1 &&
    validIdentifier(row.provider_operation_id, 128) &&
    validSha256(row.admission_sha256) &&
    validSha256(row.request_sha256) &&
    row.egress_profile === "openai-chat-completions-canary-v1" &&
    validEgressIdentity(row.egress_worker_version_id, 128) &&
    isPositiveInteger(row.channel_id) &&
    typeof row.selected_group === "string" &&
    row.selected_group.length >= 1 &&
    row.selected_group.length <= 64 &&
    typeof row.model_name === "string" &&
    row.model_name.length >= 1 &&
    row.model_name.length <= 200 &&
    MODEL_NAME.test(row.model_name) &&
    typeof row.endpoint_path === "string" &&
    row.endpoint_path.length >= 1 &&
    row.endpoint_path.length <= 256 &&
    ENDPOINT_PATH.test(row.endpoint_path) &&
    row.input_mode === "r2" &&
    validStorageKey(row.input_object_key) &&
    row.input_object_key.length >= 8 &&
    row.input_object_key.length <= 512 &&
    validIdentifier(row.input_object_version, 128) &&
    validSha256(row.input_sha256) &&
    row.request_sha256 === row.input_sha256 &&
    row.input_object_key ===
      `container-inputs/v1/${row.operation_id}/${row.owner_generation}/${row.input_sha256}` &&
    isNonNegativeInteger(row.input_size) &&
    row.input_size <= MAX_R2_OBJECT_BYTES &&
    validContentType(row.input_content_type) &&
    validBillingContract(row.billing_kind, row.billing_contract_hash) &&
    validSha256(row.billing_snapshot_sha256) &&
    (row.billing_kind !== "flat" ||
      row.billing_contract_hash.slice(-64) === row.billing_snapshot_sha256) &&
    row.stream_policy === "non_streaming" &&
    isPositiveInteger(row.operation_created_at) &&
    isPositiveInteger(row.operation_dispatched_at) &&
    row.operation_dispatched_at >= row.operation_created_at &&
    isPositiveInteger(row.authorized_at) &&
    row.authorized_at >= row.operation_dispatched_at &&
    row.authorized_at <= now &&
    isPositiveInteger(row.execution_deadline_at) &&
    row.execution_deadline_at > row.authorized_at &&
    isPositiveInteger(row.owner_lease_expires_at) &&
    row.owner_lease_expires_at > row.execution_deadline_at &&
    isPositiveInteger(row.reservation_owner_deadline_at) &&
    row.reservation_owner_deadline_at >= row.execution_deadline_at &&
    row.reservation_owner_deadline_at > row.authorized_at &&
    isPositiveInteger(row.reservation_lease_expires_at) &&
    row.reservation_lease_expires_at >= row.owner_lease_expires_at &&
    row.reservation_lease_expires_at >= row.reservation_owner_deadline_at
  );
}

function providerEgressGrantMatches(
  row: ProviderEgressGrantRow,
  admission: D1AdmissionSnapshot,
  identity: ProviderEgressGrantIdentity,
  billingSnapshotSha256: string,
  changes: 0 | 1,
  now: number,
): boolean {
  return (
    row.operation_id === admission.operation_id &&
    row.reservation_key === admission.reservation_key &&
    row.owner_generation === admission.owner_generation &&
    row.attempt_generation === identity.attempt_generation &&
    row.provider_operation_id === admission.provider_operation_id &&
    row.admission_sha256 === admission.admission_sha256 &&
    row.request_sha256 === identity.request_sha256 &&
    row.egress_profile === identity.egress_profile &&
    row.egress_worker_version_id === identity.egress_worker_version_id &&
    row.channel_id === admission.channel_id &&
    row.selected_group === admission.selected_group &&
    row.model_name === admission.model_name &&
    row.endpoint_path === admission.endpoint_path &&
    row.input_mode === admission.input_mode &&
    row.input_object_key === admission.input_object_key &&
    row.input_object_version === admission.input_object_version &&
    row.input_sha256 === admission.input_sha256 &&
    row.input_size === admission.input_size &&
    row.input_content_type === admission.input_content_type &&
    row.billing_kind === admission.billing_kind &&
    row.billing_contract_hash === admission.billing_contract_hash &&
    row.billing_snapshot_sha256 === billingSnapshotSha256 &&
    row.operation_created_at === admission.operation_created_at &&
    row.operation_dispatched_at === admission.operation_updated_at &&
    row.execution_deadline_at === admission.execution_deadline_at &&
    row.owner_lease_expires_at === admission.owner_lease_expires_at &&
    row.reservation_owner_deadline_at === admission.owner_deadline_at &&
    row.reservation_lease_expires_at === admission.lease_expires_at &&
    (changes === 0 || row.authorized_at === now)
  );
}

function validBillingContract(kind: unknown, contract: unknown): contract is string {
  if (kind === "tiered_expr") {
    return validSha256(contract);
  }
  if (kind !== "flat" || typeof contract !== "string") {
    return false;
  }
  return (
    contract.length >= 66 &&
    contract.length <= 96 &&
    contract[contract.length - 65] === ":" &&
    validSha256(contract.slice(-64))
  );
}

function validBillingSnapshotJson(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1) return false;
  if (new TextEncoder().encode(value).byteLength > MAX_BILLING_SNAPSHOT_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function validEgressIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    EGRESS_IDENTITY.test(value)
  );
}

function isStorageAccessGrant(value: unknown): value is StorageAccessGrant {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  switch (value.action) {
    case STORAGE_GATEWAY_ACTIONS.R2_INPUT_GET:
      return (
        hasExactKeys(value, ["action", "key", "version", "sha256", "size", "content_type"]) &&
        validStorageKey(value.key) &&
        validIdentifier(value.version, 128) &&
        validSha256(value.sha256) &&
        isNonNegativeInteger(value.size) &&
        validContentType(value.content_type)
      );
    case STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT:
      return (
        hasExactKeys(value, [
          "action",
          "operation_id",
          "owner_generation",
          "provider_operation_id",
          "admission_sha256",
          "attempt_generation",
          "egress_profile",
          "egress_worker_version_id",
          "sha256",
          "size",
          "content_type",
        ]) &&
        validIdentifier(value.operation_id, 128) &&
        isPositiveInteger(value.owner_generation) &&
        validIdentifier(value.provider_operation_id, 128) &&
        validSha256(value.admission_sha256) &&
        (value.attempt_generation === null ||
          (isPositiveInteger(value.attempt_generation) && value.attempt_generation <= 3)) &&
        ((value.egress_profile === null && value.egress_worker_version_id === null) ||
          (value.attempt_generation !== null &&
            validIdentifier(value.egress_profile, 64) &&
            validIdentifier(value.egress_worker_version_id, 128))) &&
        validSha256(value.sha256) &&
        isNonNegativeInteger(value.size) &&
        validContentType(value.content_type)
      );
    case STORAGE_GATEWAY_ACTIONS.KV_CONFIG_GET:
      return (
        hasExactKeys(value, ["action", "operation_kind"]) &&
        typeof value.operation_kind === "string" &&
        value.operation_kind.length <= 64 &&
        OPERATION_KIND.test(value.operation_kind)
      );
    case STORAGE_GATEWAY_ACTIONS.D1_ADMISSION_GET:
      return (
        hasExactKeys(value, [
          "action",
          "protocol_version",
          "operation_id",
          "operation_kind",
          "owner_generation",
          "owner_lease_expires_at",
          "execution_deadline_at",
          "provider_operation_id",
          "admission_sha256",
          "input",
          "shard",
          "trace_id",
        ]) &&
    isPositiveInteger(value.protocol_version) &&
    value.protocol_version <= 255 &&
        validIdentifier(value.operation_id, 128) &&
        typeof value.operation_kind === "string" &&
        value.operation_kind.length >= 1 &&
        value.operation_kind.length <= 64 &&
        OPERATION_KIND.test(value.operation_kind) &&
        isPositiveInteger(value.owner_generation) &&
        isPositiveInteger(value.owner_lease_expires_at) &&
        isPositiveInteger(value.execution_deadline_at) &&
        value.execution_deadline_at <= value.owner_lease_expires_at &&
        validIdentifier(value.provider_operation_id, 128) &&
        validSha256(value.admission_sha256) &&
        validAdmissionInput(value.input) &&
        validAdmissionShard(value.shard) &&
        validIdentifier(value.trace_id, 128)
      );
    default:
      return false;
  }
}

function validAdmissionInput(value: unknown): value is OperationInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "mode",
      "sha256",
      "size",
      "content_type",
      "request_object_key",
      "object_version",
    ]) &&
    value.mode === "r2" &&
    validSha256(value.sha256) &&
    isNonNegativeInteger(value.size) &&
    value.size <= MAX_R2_OBJECT_BYTES &&
    validContentType(value.content_type) &&
    validStorageKey(value.request_object_key) &&
    validIdentifier(value.object_version, 128)
  );
}

function validAdmissionShard(value: unknown): value is OperationShard {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "contract_version",
      "ring_generation",
      "shard_count",
      "shard_index",
      "instance_name",
    ]) &&
    value.contract_version === 1 &&
    isPositiveInteger(value.ring_generation) &&
    isPositiveInteger(value.shard_count) &&
    value.shard_count <= 1024 &&
    isNonNegativeInteger(value.shard_index) &&
    value.shard_index < value.shard_count &&
    validShardInstanceName(value.instance_name, value.shard_index)
  );
}

function validShardInstanceName(value: unknown, shardIndex: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 29 &&
    value.length <= 64 &&
    value === `cinatoken-relay-shard-v1-${shardIndex.toString().padStart(4, "0")}`
  );
}

function matchesRoute(url: URL, route: StorageRoute): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname === route.host &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === route.path &&
    url.search === ""
  );
}

async function requireEmptyRequest(request: Request): Promise<void> {
  const contentLength = request.headers.get("content-length");
  if (
    request.body !== null ||
    (contentLength !== null && contentLength !== "0") ||
    request.headers.has("content-type") ||
    request.headers.has(CONTENT_SHA256_HEADER)
  ) {
    throw new GatewayError("storage_request_body_not_allowed", 400);
  }
}

function requireResultHeaders(request: Request, grant: R2ResultPutGrant): void {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) !== grant.size) {
    throw new GatewayError("r2_result_length_mismatch", 400);
  }
  if (request.headers.get("content-type") !== grant.content_type) {
    throw new GatewayError("r2_result_content_type_mismatch", 400);
  }
  if (request.headers.get(CONTENT_SHA256_HEADER) !== grant.sha256) {
    throw new GatewayError("r2_result_sha256_mismatch", 400);
  }
  if (request.headers.has("content-encoding") || request.headers.has("content-range")) {
    throw new GatewayError("r2_result_encoding_not_allowed", 400);
  }
  if ((grant.size === 0) !== (request.body === null)) {
    throw new GatewayError("r2_result_body_mismatch", 400);
  }
}

function enforceR2Limit(size: number): void {
  if (size > MAX_R2_OBJECT_BYTES) throw new GatewayError("r2_object_too_large", 413);
}

function r2ObjectMatches(
  object: R2Object,
  key: string,
  version: string,
  size: number,
  contentType: string,
  sha256: string,
): boolean {
  return (
    object.key === key &&
    object.version === version &&
    object.size === size &&
    object.httpMetadata?.contentType === contentType &&
    checksumHex(object.checksums.sha256) === sha256
  );
}

function r2ResultMatches(
  object: R2Object,
  key: string,
  grant: R2ResultPutGrant,
  expectedMetadata: Record<string, string>,
): boolean {
  const metadata = object.customMetadata;
  return (
    object.key === key &&
    object.size === grant.size &&
    object.httpMetadata?.contentType === grant.content_type &&
    checksumHex(object.checksums.sha256) === grant.sha256 &&
    metadata !== undefined &&
    Object.keys(metadata).length === Object.keys(expectedMetadata).length &&
    Object.entries(expectedMetadata).every(([name, value]) => metadata[name] === value)
  );
}

function resultMetadata(grant: R2ResultPutGrant): Record<string, string> {
  const egressMetadata: Record<string, string> =
    grant.egress_profile === null || grant.egress_worker_version_id === null
      ? {}
      : {
          egress_profile: grant.egress_profile,
          egress_worker_version_id: grant.egress_worker_version_id,
        };
  return {
    gateway_version:
      grant.attempt_generation === null
        ? "1"
        : Object.keys(egressMetadata).length === 0
          ? "2"
          : "3",
    operation_id: grant.operation_id,
    owner_generation: String(grant.owner_generation),
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    ...(grant.attempt_generation === null
      ? {}
      : { attempt_generation: String(grant.attempt_generation) }),
    ...egressMetadata,
    sha256: grant.sha256,
    size: String(grant.size),
    content_type: grant.content_type,
  };
}

function resultWriteResponse(
  key: string,
  version: string,
  grant: R2ResultPutGrant,
  replayed: boolean,
  status: number,
): Response {
  const response = jsonResponse(
    { key, sha256: grant.sha256, size: grant.size, replayed },
    status,
  );
  response.headers.set(R2_OBJECT_VERSION_HEADER, version);
  return response;
}

async function readBoundedStream(stream: ReadableStream, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        await reader.cancel();
        throw new GatewayError("kv_config_invalid", 502);
      }
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GatewayError("kv_config_too_large", 502);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (value === undefined || value.byteLength !== 32) return null;
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validStorageKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && STORAGE_KEY.test(value);
}

function validIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= maxLength && IDENTIFIER.test(value)
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && LOWER_HEX_64.test(value);
}

function validContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 128 &&
    CONTENT_TYPE.test(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

async function rejectRequest(
  request: Request,
  error: string,
  status: number,
  headers?: Record<string, string>,
): Promise<Response> {
  await cancelRequestBody(request);
  return jsonError(error, status, headers);
}

async function cancelRequestBody(request: Request): Promise<void> {
  if (!request.bodyUsed) await cancelStream(request.body);
}

async function cancelStream(stream: ReadableStream | null): Promise<void> {
  if (stream === null) return;
  try {
    await stream.cancel();
  } catch {
    // The binding may already have locked or consumed the stream.
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function jsonError(error: string, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
