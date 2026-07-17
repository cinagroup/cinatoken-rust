import {
  type DispatchProviderAttemptOutcome,
  type ProviderEgressIdentity,
  type ProviderAttemptTerminal,
  type RecordProviderAttemptOutcome,
  type RecordStorageResultOutcome,
  type StorageAccessGrant,
  type StorageResultRecord,
} from "./ledger";
import { ProtocolError } from "./protocol";
import {
  CONTENT_SHA256_HEADER,
  OPERATION_ID_HEADER,
  OWNER_GENERATION_HEADER,
  PROVIDER_ATTEMPT_GENERATION_HEADER,
  R2_OBJECT_VERSION_HEADER,
  R2_RESULT_HOST,
  R2_RESULT_PATH,
  STORAGE_GATEWAY_ACTIONS,
  deriveR2ResultKey,
  handleStorageGatewayRequest,
  requireD1ProviderEgressAdmission,
  requireD1ProviderEgressGrant,
  type D1AdmissionSnapshot,
  type R2ResultPutGrant,
  type StorageGatewayEnvironment,
} from "./storage_gateway";

export const PROVIDER_EGRESS_HOST = "provider-egress.cinatoken.internal";
export const PROVIDER_EGRESS_PATH = "/v1/provider-attempts/execute";
export const PROVIDER_EGRESS_SERVICE_PATH = "/internal/v1/provider-attempts/execute";
export const PROVIDER_EGRESS_READINESS_SERVICE_PATH =
  "/internal/v1/provider-egress/readiness";
export const PROVIDER_EGRESS_PROFILE = "openai-chat-completions-canary-v1";
export const PROVIDER_CANARY_OPERATION_KIND = "chat_completions_canary";
export const PROVIDER_EGRESS_PROTOCOL_HEADER = "x-cinatoken-provider-egress-protocol";
export const PROVIDER_EGRESS_PROFILE_HEADER = "x-cinatoken-provider-egress-profile";
export const PROVIDER_EGRESS_WORKER_VERSION_HEADER =
  "x-cinatoken-provider-egress-worker-version";
export const PROVIDER_EGRESS_EXPECTED_WORKER_VERSION_HEADER =
  "x-cinatoken-provider-egress-expected-worker-version";
export const CLOUDFLARE_WORKERS_VERSION_KEY_HEADER = "cloudflare-workers-version-key";
export const PROVIDER_OPERATION_ID_HEADER = "x-cinatoken-provider-operation-id";
export const PROVIDER_DEADLINE_HEADER = "x-cinatoken-provider-deadline";
export const MAX_PROVIDER_EGRESS_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_EGRESS_READINESS_BYTES = 1024;

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

type RpcError = { code: string; status: number };
type RpcResult<T> = { ok: true; result: T } | { ok: false; error: RpcError };

export interface ProviderEgressGatewayPort {
  authorizeStorageAccess(
    operationId: string,
    ownerGeneration: number,
  ): Promise<{ ok: true; grant: StorageAccessGrant } | { ok: false; error: RpcError }>;
  dispatchProviderAttemptV2(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    identity: ProviderEgressIdentity,
  ): Promise<RpcResult<DispatchProviderAttemptOutcome>>;
  recordStorageResult(
    operationId: string,
    ownerGeneration: number,
    result: StorageResultRecord,
    providerAttemptGeneration?: number,
  ): Promise<RpcResult<RecordStorageResultOutcome>>;
  recordProviderAttemptOutcome(
    operationId: string,
    ownerGeneration: number,
    attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
  ): Promise<RpcResult<RecordProviderAttemptOutcome>>;
}

export interface ProviderEgressGatewayEnvironment extends StorageGatewayEnvironment {
  CONTAINER_PROVIDER_EGRESS_ENABLED?: string;
  PROVIDER_EGRESS?: Pick<Fetcher, "fetch">;
}

export async function handleProviderEgressGatewayRequest(
  request: Request,
  env: ProviderEgressGatewayEnvironment,
  port: ProviderEgressGatewayPort,
  identity: { operationId: string; ownerGeneration: number },
): Promise<Response> {
  if (env.CONTAINER_PROVIDER_EGRESS_ENABLED !== "true") {
    await cancelBody(request);
    return jsonError("provider_egress_disabled", 503);
  }
  const url = new URL(request.url);
  if (!matchesContainerRoute(url)) {
    await cancelBody(request);
    return jsonError("provider_egress_route_not_found", 404);
  }
  if (request.method !== "POST") {
    await cancelBody(request);
    return jsonError("provider_egress_method_not_allowed", 405);
  }
  const attemptGeneration = readAttemptGeneration(request);
  const expectedSha256 = request.headers.get(CONTENT_SHA256_HEADER);
  if (attemptGeneration !== 1 || expectedSha256 === null || !validSha256(expectedSha256)) {
    await cancelBody(request);
    return jsonError("provider_egress_access_denied", 403);
  }

  let body: Uint8Array;
  try {
    body = await readBoundedJsonBody(request);
  } catch (error) {
    return gatewayError(error, "provider_egress_request_invalid", 400);
  }
  if ((await sha256(body)) !== expectedSha256 || !isNonStreamingJsonObject(body)) {
    return jsonError("provider_egress_request_invalid", 400);
  }

  const access = await port.authorizeStorageAccess(
    identity.operationId,
    identity.ownerGeneration,
  );
  if (!access.ok) return jsonError(access.error.code, access.error.status);
  const grant = access.grant;
  if (!matchesCanaryGrant(grant, attemptGeneration, expectedSha256, body.byteLength)) {
    return jsonError("provider_egress_access_denied", 403);
  }

  const replay = await replayWithoutProviderSend(port, grant, attemptGeneration);
  if (replay !== null) return replay;

  let admission: D1AdmissionSnapshot;
  try {
    admission = await requireD1ProviderEgressAdmission(env, grant);
  } catch (error) {
    return error instanceof ProtocolError
      ? jsonError(error.code, error.status)
      : jsonError("provider_egress_admission_unavailable", 503);
  }

  const broker = env.PROVIDER_EGRESS;
  if (broker === undefined) {
    return jsonError("provider_egress_binding_unavailable", 503);
  }
  let egressIdentity: ProviderEgressIdentity;
  try {
    egressIdentity = await requireProviderEgressReadiness(
      broker,
      grant.deadline_at,
      grant.provider_operation_id,
    );
  } catch {
    return jsonError("provider_egress_not_ready", 503);
  }

  try {
    await requireD1ProviderEgressGrant(env, admission, {
      attempt_generation: attemptGeneration,
      request_sha256: expectedSha256,
      egress_profile: egressIdentity.profile,
      egress_worker_version_id: egressIdentity.worker_version_id,
    });
  } catch (error) {
    return error instanceof ProtocolError
      ? jsonError(error.code, error.status)
      : jsonError("provider_egress_grant_unavailable", 503);
  }

  let dispatch: RpcResult<DispatchProviderAttemptOutcome>;
  try {
    dispatch = await port.dispatchProviderAttemptV2(
      grant.operation_id,
      grant.owner_generation,
      attemptGeneration,
      egressIdentity,
    );
  } catch {
    return jsonError("provider_egress_dispatch_unavailable", 503);
  }
  if (!dispatch.ok) return jsonError(dispatch.error.code, dispatch.error.status);
  if (dispatch.result.kind !== "dispatched") {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_egress_replay_ambiguous");
  }
  if (!providerAttemptEgressIdentityMatches(dispatch.result.row, egressIdentity)) {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_egress_identity_ambiguous");
  }

  let upstream: Response;
  try {
    upstream = await broker.fetch(
      new Request(`https://${PROVIDER_EGRESS_HOST}${PROVIDER_EGRESS_SERVICE_PATH}`, {
        method: "POST",
        headers: brokerHeaders(
          grant,
          attemptGeneration,
          expectedSha256,
          body.byteLength,
          egressIdentity.worker_version_id,
        ),
        body,
        signal: AbortSignal.timeout(remainingMilliseconds(grant.deadline_at)),
      }),
    );
  } catch {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_egress_transport_ambiguous");
  }
  if (
    upstream.headers.get(PROVIDER_EGRESS_WORKER_VERSION_HEADER) !==
    egressIdentity.worker_version_id
  ) {
    await cancelResponse(upstream);
    return ambiguousResponse(port, grant, attemptGeneration, "provider_egress_version_ambiguous");
  }
  if (upstream.status < 200 || upstream.status > 299) {
    await cancelResponse(upstream);
    return ambiguousResponse(port, grant, attemptGeneration, "provider_response_ambiguous");
  }

  let providerBody: Uint8Array;
  try {
    providerBody = await readBoundedResponse(upstream, MAX_PROVIDER_EGRESS_BODY_BYTES);
  } catch {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_response_ambiguous");
  }
  const contentType = normalizedJsonContentType(upstream.headers.get("content-type"));
  if (contentType === null || !isJsonObject(providerBody)) {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_response_invalid");
  }
  const resultSha256 = await sha256(providerBody);
  const resultGrant: R2ResultPutGrant = {
    action: STORAGE_GATEWAY_ACTIONS.R2_RESULT_PUT,
    operation_id: grant.operation_id,
    owner_generation: grant.owner_generation,
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    attempt_generation: attemptGeneration,
    egress_profile: egressIdentity.profile,
    egress_worker_version_id: egressIdentity.worker_version_id,
    sha256: resultSha256,
    size: providerBody.byteLength,
    content_type: contentType,
  };

  let result: StorageResultRecord;
  try {
    result = await persistResult(env, resultGrant, providerBody);
  } catch {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_result_persistence_ambiguous");
  }
  const attached = await port.recordStorageResult(
    grant.operation_id,
    grant.owner_generation,
    result,
    attemptGeneration,
  );
  if (!attached.ok) {
    return ambiguousResponse(port, grant, attemptGeneration, "provider_result_persistence_ambiguous");
  }
  const terminal = await port.recordProviderAttemptOutcome(
    grant.operation_id,
    grant.owner_generation,
    attemptGeneration,
    { status: "succeeded", response_status: upstream.status, response_code: null },
  );
  if (!terminal.ok) {
    const refreshed = await port.authorizeStorageAccess(
      grant.operation_id,
      grant.owner_generation,
    );
    const recovered = refreshed.ok
      ? await replayWithoutProviderSend(port, refreshed.grant, attemptGeneration)
      : null;
    return recovered ?? jsonResponse(ambiguousPayload(grant, "provider_terminal_ambiguous"), 202);
  }
  return successResponse(grant, attemptGeneration, upstream.status, result);
}

async function requireProviderEgressReadiness(
  broker: Pick<Fetcher, "fetch">,
  deadlineAt: number,
  affinityKey: string,
): Promise<ProviderEgressIdentity> {
  const response = await broker.fetch(
    new Request(`https://${PROVIDER_EGRESS_HOST}${PROVIDER_EGRESS_READINESS_SERVICE_PATH}`, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "cache-control": "no-store",
        [PROVIDER_EGRESS_PROTOCOL_HEADER]: "1",
        [PROVIDER_EGRESS_PROFILE_HEADER]: PROVIDER_EGRESS_PROFILE,
        [CLOUDFLARE_WORKERS_VERSION_KEY_HEADER]: affinityKey,
      },
      signal: AbortSignal.timeout(readinessTimeoutMilliseconds(deadlineAt)),
    }),
  );
  const workerVersionId = response.headers.get(PROVIDER_EGRESS_WORKER_VERSION_HEADER);
  if (
    response.status !== 200 ||
    response.headers.get(PROVIDER_EGRESS_PROTOCOL_HEADER) !== "1" ||
    response.headers.get(PROVIDER_EGRESS_PROFILE_HEADER) !== PROVIDER_EGRESS_PROFILE ||
    normalizedJsonContentType(response.headers.get("content-type")) === null ||
    !validProviderEgressIdentifier(workerVersionId, 128)
  ) {
    await cancelResponse(response);
    throw new Error("provider egress readiness unavailable");
  }
  const body = await readBoundedResponse(response, MAX_PROVIDER_EGRESS_READINESS_BYTES);
  if (!isExactProviderEgressReadiness(body)) {
    throw new Error("provider egress readiness invalid");
  }
  return {
    profile: PROVIDER_EGRESS_PROFILE,
    worker_version_id: workerVersionId,
  };
}

function matchesCanaryGrant(
  grant: StorageAccessGrant,
  attemptGeneration: number,
  requestSha256: string,
  requestSize: number,
): boolean {
  const attempt = grant.provider_attempt;
  return (
    attempt !== null &&
    grant.operation_kind === PROVIDER_CANARY_OPERATION_KIND &&
    grant.input.mode === "r2" &&
    grant.input.content_type.split(";", 1)[0].trim().toLowerCase() === "application/json" &&
    grant.input.sha256 === requestSha256 &&
    grant.input.size === requestSize &&
    validProviderDeadline(grant.deadline_at) &&
    (attempt.status !== "prepared" || grant.result === null) &&
    attempt.attempt_generation === attemptGeneration &&
    attempt.provider_operation_id === grant.provider_operation_id &&
    attempt.admission_sha256 === grant.admission_sha256 &&
    attempt.request_sha256 === requestSha256
  );
}

async function replayWithoutProviderSend(
  port: ProviderEgressGatewayPort,
  grant: StorageAccessGrant,
  attemptGeneration: number,
): Promise<Response | null> {
  const attempt = grant.provider_attempt;
  if (attempt === null || attempt.status === "prepared") return null;
  if (grant.result !== null && attempt.status === "dispatched") {
    const terminal = await port.recordProviderAttemptOutcome(
      grant.operation_id,
      grant.owner_generation,
      attemptGeneration,
      { status: "succeeded", response_status: 200, response_code: null },
    );
    if (terminal.ok) return successResponse(grant, attemptGeneration, 200, grant.result);
    return jsonResponse(ambiguousPayload(grant, "provider_terminal_ambiguous"), 202);
  }
  if (grant.result !== null && attempt.status === "succeeded") {
    return successResponse(grant, attemptGeneration, 200, grant.result);
  }
  return ambiguousResponse(port, grant, attemptGeneration, "provider_egress_replay_ambiguous");
}

async function ambiguousResponse(
  port: ProviderEgressGatewayPort,
  grant: StorageAccessGrant,
  attemptGeneration: number,
  code: string,
): Promise<Response> {
  await port.recordProviderAttemptOutcome(
    grant.operation_id,
    grant.owner_generation,
    attemptGeneration,
    { status: "ambiguous", response_status: 202, response_code: code },
  );
  return jsonResponse(ambiguousPayload(grant, code), 202);
}

function successResponse(
  grant: StorageAccessGrant,
  attemptGeneration: number,
  providerStatus: number,
  result: StorageResultRecord,
): Response {
  return jsonResponse(
    {
      protocol_version: 1,
      operation_id: grant.operation_id,
      owner_generation: grant.owner_generation,
      attempt_generation: attemptGeneration,
      status: "succeeded",
      provider_status: providerStatus,
      result,
      trace_id: grant.trace_id,
    },
    200,
  );
}

function ambiguousPayload(grant: StorageAccessGrant, code: string): Record<string, unknown> {
  return {
    protocol_version: 1,
    operation_id: grant.operation_id,
    owner_generation: grant.owner_generation,
    attempt_generation: 1,
    status: "ambiguous",
    code,
    trace_id: grant.trace_id,
  };
}

async function persistResult(
  env: ProviderEgressGatewayEnvironment,
  grant: R2ResultPutGrant,
  body: Uint8Array,
): Promise<StorageResultRecord> {
  const response = await handleStorageGatewayRequest(
    env,
    new Request(`http://${R2_RESULT_HOST}${R2_RESULT_PATH}`, {
      method: "PUT",
      headers: {
        "content-length": String(body.byteLength),
        "content-type": grant.content_type,
        [CONTENT_SHA256_HEADER]: grant.sha256,
      },
      body,
    }),
    grant,
  );
  if (!response.ok) {
    await cancelResponse(response);
    throw new Error("provider result write failed");
  }
  const objectVersion = response.headers.get(R2_OBJECT_VERSION_HEADER);
  const bytes = await readBoundedResponse(response, 1024);
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  ) as unknown;
  const expectedKey = deriveR2ResultKey(grant);
  if (
    objectVersion === null ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(objectVersion) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("provider result write response invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.key !== expectedKey ||
    record.sha256 !== grant.sha256 ||
    record.size !== grant.size ||
    typeof record.replayed !== "boolean" ||
    Object.keys(record).some((key) => !["key", "sha256", "size", "replayed"].includes(key))
  ) {
    throw new Error("provider result write response invalid");
  }
  return {
    object_key: expectedKey,
    object_version: objectVersion,
    sha256: grant.sha256,
    size: grant.size,
    content_type: grant.content_type,
  };
}

function brokerHeaders(
  grant: StorageAccessGrant,
  attemptGeneration: number,
  bodySha256: string,
  bodySize: number,
  expectedWorkerVersionId: string,
): Headers {
  return new Headers({
    "accept": "application/json",
    "content-length": String(bodySize),
    "content-type": "application/json",
    [PROVIDER_EGRESS_PROTOCOL_HEADER]: "2",
    [PROVIDER_EGRESS_PROFILE_HEADER]: PROVIDER_EGRESS_PROFILE,
    [PROVIDER_EGRESS_EXPECTED_WORKER_VERSION_HEADER]: expectedWorkerVersionId,
    [CLOUDFLARE_WORKERS_VERSION_KEY_HEADER]: grant.provider_operation_id,
    [OPERATION_ID_HEADER]: grant.operation_id,
    [OWNER_GENERATION_HEADER]: String(grant.owner_generation),
    [PROVIDER_ATTEMPT_GENERATION_HEADER]: String(attemptGeneration),
    [PROVIDER_OPERATION_ID_HEADER]: grant.provider_operation_id,
    [PROVIDER_DEADLINE_HEADER]: String(grant.deadline_at),
    [CONTENT_SHA256_HEADER]: bodySha256,
  });
}

function readAttemptGeneration(request: Request): number | null {
  const value = request.headers.get(PROVIDER_ATTEMPT_GENERATION_HEADER);
  return value !== null && /^[1-3]$/.test(value) ? Number(value) : null;
}

function matchesContainerRoute(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.hostname === PROVIDER_EGRESS_HOST &&
    url.pathname === PROVIDER_EGRESS_PATH &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

async function readBoundedJsonBody(request: Request): Promise<Uint8Array> {
  const contentType = normalizedJsonContentType(request.headers.get("content-type"));
  if (contentType === null) throw new ProtocolError("provider_egress_content_type_invalid", 415);
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PROVIDER_EGRESS_BODY_BYTES)
  ) {
    await cancelBody(request);
    throw new ProtocolError("provider_egress_body_too_large", 413);
  }
  if (request.body === null) throw new ProtocolError("provider_egress_request_invalid", 400);
  return readBoundedStream(request.body, MAX_PROVIDER_EGRESS_BODY_BYTES);
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    await cancelResponse(response);
    throw new Error("response too large");
  }
  if (response.body === null) return new Uint8Array();
  return readBoundedStream(response.body, limit);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("body too large");
        throw new Error("body too large");
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

function remainingMilliseconds(deadlineAt: number): number {
  return Math.min(300_000, Math.max(1, deadlineAt * 1000 - Date.now()));
}

function readinessTimeoutMilliseconds(deadlineAt: number): number {
  return Math.min(2_000, remainingMilliseconds(deadlineAt));
}

function validProviderDeadline(deadlineAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Number.isSafeInteger(deadlineAt) && deadlineAt > now && deadlineAt <= now + 300;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isNonStreamingJsonObject(bytes: Uint8Array): boolean {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (!("stream" in value) || (value as Record<string, unknown>).stream === false)
    );
  } catch {
    return false;
  }
}

function isJsonObject(bytes: Uint8Array): boolean {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isExactProviderEgressReadiness(bytes: Uint8Array): boolean {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      record.protocol_version === 1 &&
      record.profile === PROVIDER_EGRESS_PROFILE &&
      record.ready === true &&
      Object.keys(record).length === 3
    );
  } catch {
    return false;
  }
}

function providerAttemptEgressIdentityMatches(
  attempt: DispatchProviderAttemptOutcome["row"],
  identity: ProviderEgressIdentity,
): boolean {
  return (
    attempt.egress_profile === identity.profile &&
    attempt.egress_worker_version_id === identity.worker_version_id
  );
}

function validProviderEgressIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function normalizedJsonContentType(value: string | null): string | null {
  if (value === null || value.length > 255) return null;
  const essence = value.split(";", 1)[0].trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json") ? value : null;
}

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

async function cancelBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed) return;
  await request.body.cancel("provider egress request rejected").catch(() => undefined);
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel("provider egress response rejected").catch(() => undefined);
}

function gatewayError(error: unknown, fallbackCode: string, fallbackStatus: number): Response {
  return error instanceof ProtocolError
    ? jsonError(error.code, error.status)
    : jsonError(fallbackCode, fallbackStatus);
}

function jsonResponse(value: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}
