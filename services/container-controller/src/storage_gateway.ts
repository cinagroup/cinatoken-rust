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
  operation_id: string;
  owner_generation: number;
}

export type StorageAccessGrant =
  | R2InputGetGrant
  | R2ResultPutGrant
  | KvConfigGetGrant
  | D1AdmissionGetGrant;

export interface StorageGatewayEnvironment {
  CONTAINER_STORAGE_GATEWAY_ENABLED?: string;
  CONTAINER_STORAGE_INPUT_R2?: Pick<R2Bucket, "get">;
  CONTAINER_STORAGE_RESULT_R2?: Pick<R2Bucket, "head" | "put">;
  CONTAINER_STORAGE_CONFIG_KV?: Pick<KVNamespace, "get">;
  CONTAINER_STORAGE_ADMISSION_DB?: Pick<D1Database, "prepare">;
}

interface StorageRoute {
  host: string;
  method: "GET" | "PUT";
  path: string;
}

interface AdmissionSnapshotRow {
  status: string;
  lease_expires_at: number;
  owner_deadline_at: number;
  owner_generation: number;
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
SELECT status, lease_expires_at, owner_deadline_at, owner_generation
FROM relay_billing_reservations
WHERE reservation_key = ?1 AND owner_generation = ?2
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
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/;

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
  const database = env.CONTAINER_STORAGE_ADMISSION_DB;
  if (database === undefined) throw new GatewayError("storage_binding_unavailable", 503);

  const row = await database
    .prepare(ADMISSION_SNAPSHOT_SQL)
    .bind(grant.operation_id, grant.owner_generation)
    .first<AdmissionSnapshotRow>();
  if (row === null) throw new GatewayError("admission_snapshot_not_found", 404);
  if (
    typeof row.status !== "string" ||
    !isNonNegativeInteger(row.lease_expires_at) ||
    !isNonNegativeInteger(row.owner_deadline_at) ||
    row.owner_generation !== grant.owner_generation
  ) {
    throw new GatewayError("admission_snapshot_invalid", 502);
  }
  if (row.status !== "reserved") {
    throw new GatewayError("admission_not_reserved", 409);
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    row.lease_expires_at <= now ||
    row.owner_deadline_at <= now ||
    row.owner_deadline_at > row.lease_expires_at
  ) {
    throw new GatewayError("admission_lease_expired", 409);
  }
  return jsonResponse({
    status: row.status,
    lease_expires_at: row.lease_expires_at,
    owner_deadline_at: row.owner_deadline_at,
    owner_generation: row.owner_generation,
  });
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
          "sha256",
          "size",
          "content_type",
        ]) &&
        validIdentifier(value.operation_id, 128) &&
        isPositiveInteger(value.owner_generation) &&
        validIdentifier(value.provider_operation_id, 128) &&
        validSha256(value.admission_sha256) &&
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
        hasExactKeys(value, ["action", "operation_id", "owner_generation"]) &&
        validIdentifier(value.operation_id, 128) &&
        isPositiveInteger(value.owner_generation)
      );
    default:
      return false;
  }
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
  return {
    gateway_version: "1",
    operation_id: grant.operation_id,
    owner_generation: String(grant.owner_generation),
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
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
