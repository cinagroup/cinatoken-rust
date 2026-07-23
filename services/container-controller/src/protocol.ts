const AUTHORITY_DOMAIN = "cinatoken-container-authority:v1\0";
export const OPERATION_STATUS_V3_AUTHORITY_DOMAIN =
  "cinatoken-container-operation-status:v3\0";
export const OPERATION_STATUS_V4_AUTHORITY_DOMAIN =
  "cinatoken-container-operation-status:v4\0";
export const TERMINAL_ACK_V2_AUTHORITY_DOMAIN =
  "cinatoken-container-terminal-ack:v2\0";
export const TERMINAL_ACK_V3_AUTHORITY_DOMAIN =
  "cinatoken-container-terminal-ack:v3\0";
export const AUTHORITY_HEADER = "x-cinatoken-container-authority";
export const INTERNAL_OPERATION_PATH = "/internal/v1/operations";
export const INTERNAL_OPERATION_TERMINAL_ACK_PATH =
  "/internal/v1/operations/terminal-ack";
export const INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH =
  "/internal/v2/operations/terminal-ack";
export const INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH =
  "/internal/v3/operations/terminal-ack";
export const INTERNAL_OPERATION_STATUS_PATH = "/internal/v1/operations/status";
export const INTERNAL_OPERATION_STATUS_V2_PATH = "/internal/v2/operations/status";
export const INTERNAL_OPERATION_STATUS_V3_PATH = "/internal/v3/operations/status";
export const INTERNAL_OPERATION_STATUS_V4_PATH = "/internal/v4/operations/status";
export const INTERNAL_READINESS_PATH = "/internal/v1/shards/readiness";
export const INTERNAL_STATUS_PATH = "/internal/v1/status";
export const MAX_OPERATION_BODY_BYTES = 64 * 1024;
export const MAX_OPERATION_STATUS_BODY_BYTES = 4 * 1024;
export const MAX_TERMINAL_ACK_BODY_BYTES = 4 * 1024;
export const MAX_READINESS_BODY_BYTES = 4 * 1024;
export const MAX_EXECUTION_WINDOW_SECONDS = 300;
export const MAX_PREVIOUS_RING_ADMISSION_WINDOW_SECONDS = 15 * 60;
export const MAX_STORAGE_OBJECT_VERSION_BYTES = 128;
const MAX_TOKEN_BYTES = 4096;
const MAX_JSON_SEGMENT_BYTES = 2048;
const MAX_AUTHORITY_LIFETIME_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const ID = /^[A-Za-z0-9._:-]+$/;
const KEY_ID = /^[a-z0-9-]+$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/;

export interface AuthorityEnvironment {
  CONTAINER_AUTHORITY_ISSUER: string;
  CONTAINER_AUTHORITY_AUDIENCE: string;
  CONTAINER_AUTHORITY_CURRENT_KID: string;
  CONTAINER_AUTHORITY_PREVIOUS_KID: string;
  CONTAINER_AUTHORITY_CURRENT_SECRET: string;
  CONTAINER_AUTHORITY_PREVIOUS_SECRET?: string;
  CONTAINER_PROTOCOL_VERSION: string;
  CONTAINER_RING_GENERATION: string;
  CONTAINER_SHARD_COUNT: string;
  CONTAINER_PREVIOUS_RING_GENERATION: string;
  CONTAINER_PREVIOUS_SHARD_COUNT: string;
  CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: string;
  CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: string;
}

export interface AuthorityHeader {
  typ: "CINATOKEN-CONTAINER-AUTH";
  alg: "HS256";
  kid: string;
}

export interface AuthorityClaims {
  authority_version: 1;
  issuer: string;
  audience: string;
  protocol_version: number;
  dispatch_id: string;
  method: string;
  path: string;
  body_sha256: string;
  issued_at: number;
  expires_at: number;
}

export interface OperationInput {
  mode: "inline" | "r2";
  sha256: string;
  size: number;
  content_type: string;
  request_object_key?: string;
  object_version?: string;
}

export interface OperationShard {
  contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
}

export interface OperationEnvelope {
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

export interface VerifiedOperation {
  envelope: OperationEnvelope;
  claims: AuthorityClaims;
  body: Uint8Array;
  ring_admission: OperationRingAdmission;
}

export interface ConfiguredRingTransition {
  current_ring_generation: number;
  current_shard_count: number;
  previous_ring_generation: number;
  previous_shard_count: number;
  admission_started_at: number;
  admission_until: number;
  admission_open: boolean;
}

export type OperationRingAdmission = {
  role: "current" | "previous_admit" | "previous_replay_only";
  transition: ConfiguredRingTransition | null;
};

export interface RingTransitionStatus {
  configured: boolean;
  valid: boolean;
  admission_open: boolean;
  previous_ring_generation: number | null;
  previous_shard_count: number | null;
  admission_started_at: number | null;
  admission_until: number | null;
}

export interface OperationStatusQuery {
  protocol_version: number;
  operation_id: string;
  owner_generation: number;
  shard: OperationShard;
  trace_id: string;
}

export interface VerifiedOperationStatusQuery {
  query: OperationStatusQuery;
  claims: AuthorityClaims;
  body: Uint8Array;
}

export interface TerminalAckResultManifest {
  object_key: string;
  object_version: string;
  sha256: string;
  size: number;
  content_type: string;
}

/**
 * Exact JSON body for POST /internal/v1/operations/terminal-ack.
 *
 * The body is intentionally flat except for `result` and `shard`. Additional
 * keys, response bodies or headers, billing data, credentials, audit data, and
 * client idempotency plaintext are rejected.
 */
interface TerminalAckRequestBase {
  protocol_version: 1;
  billing_event_id: string;
  terminal_contract_sha256: string;
  reconciliation_id: string;
  reconciliation_revision: 1 | 2;
  predecessor_billing_event_id: string | null;
  operation_id: string;
  owner_generation: number;
  operation_from_status: "prepared" | "dispatched" | "recovery_required";
  operation_status: "completed" | "failed" | "recovery_required";
  response_status: number;
  response_code: string | null;
  result: TerminalAckResultManifest | null;
  shard: OperationShard;
  trace_id: string;
}

export interface TerminalAckProviderUsageBinding {
  attempt_generation: number;
  receipt_sha256: string;
  result_sha256: string;
}

export interface TerminalAckProviderResponseBinding {
  attempt_generation: number;
  status: "succeeded" | "interpreted_reject";
  response_class: "success" | "typed_error" | "http_error" | "invalid_body";
  provider_status: number;
  client_status: number;
  response_code: string | null;
  provider_response_evidence_sha256: string;
  client_response_artifact_sha256: string;
}

export interface TerminalAckRequestV1 extends TerminalAckRequestBase {
  provider_usage_binding?: never;
}

export interface TerminalAckRequestV2 extends TerminalAckRequestBase {
  provider_usage_binding: TerminalAckProviderUsageBinding | null;
}

export interface TerminalAckRequestV3 extends TerminalAckRequestBase {
  terminal_ack_contract_version: 3;
  financial_terminal_contract_version: 2;
  provider_usage_binding: TerminalAckProviderUsageBinding | null;
  provider_response_binding: TerminalAckProviderResponseBinding;
}

export type TerminalAckRequest = TerminalAckRequestV1 | TerminalAckRequestV2;

export interface VerifiedTerminalAckRequest {
  ack: TerminalAckRequestV1;
  claims: AuthorityClaims;
  body: Uint8Array;
}

export interface VerifiedTerminalAckV2Request {
  ack: TerminalAckRequestV2;
  claims: AuthorityClaims;
  body: Uint8Array;
}

export interface VerifiedTerminalAckV3Request {
  ack: TerminalAckRequestV3;
  claims: AuthorityClaims;
  body: Uint8Array;
}

export interface ShardReadinessProbe {
  protocol_version: number;
  shard: OperationShard;
  wake_container: boolean;
  activation_campaign?: ShardActivationCampaignCredential;
}

export interface ShardActivationCampaignCredential {
  contract_version: 1;
  campaign_id: string;
  nonce: string;
  confirm_consume: true;
}

export interface VerifiedShardReadinessProbe {
  probe: ShardReadinessProbe;
  claims: AuthorityClaims;
  body: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export async function verifyOperationRequest(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOperation> {
  if (request.method !== "POST" || new URL(request.url).pathname !== INTERNAL_OPERATION_PATH) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(request, true);
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_OPERATION_PATH,
    body,
    env,
    now,
  );
  const envelope = parseOperationEnvelope(body, env, now);
  if (envelope.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  const ringAdmission = operationRingAdmission(envelope.shard, env, now);
  return { envelope, claims, body, ring_admission: ringAdmission };
}

export async function verifyOperationStatusRequest(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOperationStatusQuery> {
  return verifyOperationStatusRequestForPath(
    request,
    env,
    INTERNAL_OPERATION_STATUS_PATH,
    now,
  );
}

export async function verifyOperationStatusV2Request(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOperationStatusQuery> {
  return verifyOperationStatusRequestForPath(
    request,
    env,
    INTERNAL_OPERATION_STATUS_V2_PATH,
    now,
  );
}

export async function verifyOperationStatusV3Request(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOperationStatusQuery> {
  return verifyOperationStatusRequestForPath(
    request,
    env,
    INTERNAL_OPERATION_STATUS_V3_PATH,
    now,
    OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
  );
}

export async function verifyOperationStatusV4Request(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOperationStatusQuery> {
  return verifyOperationStatusRequestForPath(
    request,
    env,
    INTERNAL_OPERATION_STATUS_V4_PATH,
    now,
    OPERATION_STATUS_V4_AUTHORITY_DOMAIN,
  );
}

export async function verifyTerminalAckRequest(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedTerminalAckRequest> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== INTERNAL_OPERATION_TERMINAL_ACK_PATH
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(
    request,
    true,
    MAX_TERMINAL_ACK_BODY_BYTES,
    "terminal_ack_too_large",
    "invalid_terminal_ack",
  );
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_OPERATION_TERMINAL_ACK_PATH,
    body,
    env,
    now,
  );
  const ack = parseTerminalAckRequest(body);
  if (ack.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  return { ack, claims, body };
}

export async function verifyTerminalAckV2Request(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedTerminalAckV2Request> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(
    request,
    true,
    MAX_TERMINAL_ACK_BODY_BYTES,
    "terminal_ack_too_large",
    "invalid_terminal_ack",
  );
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
    body,
    env,
    now,
    TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
  );
  const ack = parseTerminalAckV2Request(body);
  if (ack.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  return { ack, claims, body };
}

export async function verifyTerminalAckV3Request(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedTerminalAckV3Request> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(
    request,
    true,
    MAX_TERMINAL_ACK_BODY_BYTES,
    "terminal_ack_too_large",
    "invalid_terminal_ack",
  );
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH,
    body,
    env,
    now,
    TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
  );
  const ack = parseTerminalAckV3Request(body);
  if (ack.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  return { ack, claims, body };
}

async function verifyOperationStatusRequestForPath(
  request: Request,
  env: AuthorityEnvironment,
  path: string,
  now: number,
  authorityDomain = AUTHORITY_DOMAIN,
): Promise<VerifiedOperationStatusQuery> {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== path
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(
    request,
    true,
    MAX_OPERATION_STATUS_BODY_BYTES,
    "operation_status_query_too_large",
    "invalid_operation_status_query",
  );
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    path,
    body,
    env,
    now,
    authorityDomain,
  );
  const query = parseOperationStatusQuery(body);
  if (query.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  return { query, claims, body };
}

export async function verifyStatusRequest(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthorityClaims> {
  if (request.method !== "GET" || new URL(request.url).pathname !== INTERNAL_STATUS_PATH) {
    throw new ProtocolError("route_not_found", 404);
  }
  await requireEmptyBody(request);
  return verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_STATUS_PATH,
    new Uint8Array(),
    env,
    now,
  );
}

export async function verifyReadinessRequest(
  request: Request,
  env: AuthorityEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedShardReadinessProbe> {
  if (request.method !== "POST" || new URL(request.url).pathname !== INTERNAL_READINESS_PATH) {
    throw new ProtocolError("route_not_found", 404);
  }
  const body = await readBoundedBody(
    request,
    true,
    MAX_READINESS_BODY_BYTES,
    "readiness_probe_too_large",
    "invalid_readiness_probe",
  );
  const claims = await verifyAuthority(
    requiredAuthority(request),
    request.method,
    INTERNAL_READINESS_PATH,
    body,
    env,
    now,
  );
  const probe = parseReadinessProbe(body, env);
  if (probe.protocol_version !== claims.protocol_version) {
    throw new ProtocolError("protocol_mismatch", 426);
  }
  return { probe, claims, body };
}

export async function verifyAuthority(
  token: string,
  method: string,
  path: string,
  body: Uint8Array,
  env: AuthorityEnvironment,
  now: number,
  authorityDomain = AUTHORITY_DOMAIN,
): Promise<AuthorityClaims> {
  validateAuthorityKeyring(env);
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const [headerPart, claimsPart, signaturePart] = parts;
  const headerBytes = decodeBase64Url(headerPart, MAX_JSON_SEGMENT_BYTES);
  const signature = decodeBase64Url(signaturePart, 32);
  if (signature.length !== 32) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const untrustedHeader = parseJsonObject(headerBytes, "invalid_authority");
  const kid = readString(untrustedHeader, "kid", 1, 32, KEY_ID, "invalid_authority");
  const secret = selectAuthoritySecret(kid, env);
  if (new TextEncoder().encode(secret).length < 32) {
    throw new ProtocolError("authority_unavailable", 503);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${authorityDomain}${headerPart}.${claimsPart}`);
  if (!(await crypto.subtle.verify("HMAC", key, copyArrayBuffer(signature), copyArrayBuffer(signed)))) {
    throw new ProtocolError("invalid_authority", 403);
  }
  assertExactKeys(untrustedHeader, ["typ", "alg", "kid"], "invalid_authority");
  if (untrustedHeader.typ !== "CINATOKEN-CONTAINER-AUTH" || untrustedHeader.alg !== "HS256") {
    throw new ProtocolError("invalid_authority", 403);
  }
  const claimsBytes = decodeBase64Url(claimsPart, MAX_JSON_SEGMENT_BYTES);
  const value = parseJsonObject(claimsBytes, "invalid_authority");
  assertExactKeys(
    value,
    [
      "authority_version",
      "issuer",
      "audience",
      "protocol_version",
      "dispatch_id",
      "method",
      "path",
      "body_sha256",
      "issued_at",
      "expires_at",
    ],
    "invalid_authority",
  );
  const claims: AuthorityClaims = {
    authority_version: readInteger(value, "authority_version", 1, 1, "invalid_authority") as 1,
    issuer: readString(value, "issuer", 1, 128, ID, "invalid_authority"),
    audience: readString(value, "audience", 1, 128, ID, "invalid_authority"),
    protocol_version: readInteger(value, "protocol_version", 1, 255, "invalid_authority"),
    dispatch_id: readString(value, "dispatch_id", 1, 128, ID, "invalid_authority"),
    method: readString(value, "method", 1, 16, /^[A-Z]+$/, "invalid_authority"),
    path: readPath(value.path),
    body_sha256: readString(value, "body_sha256", 64, 64, LOWER_HEX_64, "invalid_authority"),
    issued_at: readInteger(value, "issued_at", 1, MAX_SAFE_INTEGER, "invalid_authority"),
    expires_at: readInteger(value, "expires_at", 1, MAX_SAFE_INTEGER, "invalid_authority"),
  };
  const expectedProtocol = parseConfiguredInteger(env.CONTAINER_PROTOCOL_VERSION, 1, 255);
  const bodySha256 = await sha256Hex(body);
  if (
    claims.issuer !== env.CONTAINER_AUTHORITY_ISSUER ||
    claims.audience !== env.CONTAINER_AUTHORITY_AUDIENCE ||
    claims.protocol_version !== expectedProtocol ||
    claims.method !== method ||
    claims.path !== path ||
    claims.body_sha256 !== bodySha256
  ) {
    throw new ProtocolError("authority_claim_mismatch", 403);
  }
  if (claims.expires_at <= now) {
    throw new ProtocolError("authority_expired", 409);
  }
  if (
    claims.issued_at > now + MAX_CLOCK_SKEW_SECONDS ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS ||
    now - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS
  ) {
    throw new ProtocolError("authority_time_window", 403);
  }
  return claims;
}

export function parseOperationEnvelope(
  body: Uint8Array,
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_PROTOCOL_VERSION"
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
  now: number,
): OperationEnvelope {
  const value = parseJsonObject(body, "invalid_operation");
  assertExactKeys(
    value,
    [
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
    ],
    "invalid_operation",
  );
  const inputValue = readObject(value, "input");
  assertExactKeys(
    inputValue,
    ["mode", "sha256", "size", "content_type", "request_object_key", "object_version"],
    "invalid_operation",
    true,
  );
  const mode = readString(inputValue, "mode", 2, 6, /^(inline|r2)$/) as "inline" | "r2";
  const input: OperationInput = {
    mode,
    sha256: readString(inputValue, "sha256", 64, 64, LOWER_HEX_64),
    size: readInteger(inputValue, "size", 0, 64 * 1024 * 1024),
    content_type: readString(inputValue, "content_type", 3, 128, CONTENT_TYPE),
  };
  if (inputValue.request_object_key !== undefined) {
    input.request_object_key = readString(inputValue, "request_object_key", 8, 512, /^[A-Za-z0-9/_.:-]+$/);
  }
  if (inputValue.object_version !== undefined) {
    input.object_version = readString(
      inputValue,
      "object_version",
      1,
      MAX_STORAGE_OBJECT_VERSION_BYTES,
      ID,
    );
  }
  if (
    (mode === "inline" && (input.request_object_key !== undefined || input.object_version !== undefined)) ||
    (mode === "r2" && (input.request_object_key === undefined || input.object_version === undefined))
  ) {
    throw new ProtocolError("invalid_input_reference", 400);
  }

  const shardValue = readObject(value, "shard");
  assertExactKeys(
    shardValue,
    ["contract_version", "ring_generation", "shard_count", "shard_index", "instance_name"],
    "invalid_operation",
  );
  const shard: OperationShard = {
    contract_version: readInteger(shardValue, "contract_version", 1, 1),
    ring_generation: readInteger(shardValue, "ring_generation", 1, MAX_SAFE_INTEGER),
    shard_count: readInteger(shardValue, "shard_count", 1, 1024),
    shard_index: readInteger(shardValue, "shard_index", 0, 1023),
    instance_name: readString(shardValue, "instance_name", 29, 64, /^[a-z0-9-]+$/),
  };
  const protocolVersion = readInteger(value, "protocol_version", 1, 255);
  const ownerLeaseExpiresAt = readInteger(value, "owner_lease_expires_at", 1, MAX_SAFE_INTEGER);
  const executionDeadlineAt = readInteger(value, "execution_deadline_at", 1, MAX_SAFE_INTEGER);
  const envelope: OperationEnvelope = {
    protocol_version: protocolVersion,
    operation_id: readString(value, "operation_id", 1, 128, ID),
    operation_kind: readString(value, "operation_kind", 1, 64, /^[a-z0-9_:-]+$/),
    owner_generation: readInteger(value, "owner_generation", 1, MAX_SAFE_INTEGER),
    owner_lease_expires_at: ownerLeaseExpiresAt,
    execution_deadline_at: executionDeadlineAt,
    provider_operation_id: readString(value, "provider_operation_id", 1, 128, ID),
    admission_sha256: readString(value, "admission_sha256", 64, 64, LOWER_HEX_64),
    input,
    shard,
    trace_id: readString(value, "trace_id", 1, 128, ID),
  };
  const expectedProtocol = parseConfiguredInteger(env.CONTAINER_PROTOCOL_VERSION, 1, 255);
  if (protocolVersion !== expectedProtocol) {
    throw new ProtocolError("unsupported_protocol", 426);
  }
  operationRingAdmission(shard, env, now);
  if (
    executionDeadlineAt <= now ||
    executionDeadlineAt > ownerLeaseExpiresAt ||
    executionDeadlineAt > now + MAX_EXECUTION_WINDOW_SECONDS
  ) {
    throw new ProtocolError("invalid_operation_deadline", 409);
  }
  return envelope;
}

export function inspectRingTransition(
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
  now: number,
): RingTransitionStatus {
  const rawPrevious = [
    env.CONTAINER_PREVIOUS_RING_GENERATION,
    env.CONTAINER_PREVIOUS_SHARD_COUNT,
    env.CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT,
    env.CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL,
  ];
  const configured = rawPrevious.some((value) => value !== "0");
  if (!configured) {
    return {
      configured: false,
      valid: rawPrevious.every((value) => value === "0"),
      admission_open: false,
      previous_ring_generation: null,
      previous_shard_count: null,
      admission_started_at: null,
      admission_until: null,
    };
  }

  const currentGeneration = configuredIntegerOrNull(
    env.CONTAINER_RING_GENERATION,
    1,
    MAX_SAFE_INTEGER,
  );
  const currentShardCount = configuredIntegerOrNull(env.CONTAINER_SHARD_COUNT, 1, 1024);
  const previousGeneration = configuredIntegerOrNull(
    env.CONTAINER_PREVIOUS_RING_GENERATION,
    1,
    MAX_SAFE_INTEGER,
  );
  const previousShardCount = configuredIntegerOrNull(
    env.CONTAINER_PREVIOUS_SHARD_COUNT,
    1,
    1024,
  );
  const admissionStartedAt = configuredIntegerOrNull(
    env.CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT,
    1,
    MAX_SAFE_INTEGER,
  );
  const admissionUntil = configuredIntegerOrNull(
    env.CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL,
    1,
    MAX_SAFE_INTEGER,
  );
  const valid =
    Number.isSafeInteger(now) &&
    now >= 1 &&
    currentGeneration !== null &&
    currentShardCount !== null &&
    previousGeneration !== null &&
    previousShardCount !== null &&
    admissionStartedAt !== null &&
    admissionUntil !== null &&
    previousGeneration + 1 === currentGeneration &&
    previousShardCount < currentShardCount &&
    admissionStartedAt < admissionUntil &&
    admissionUntil - admissionStartedAt <= MAX_PREVIOUS_RING_ADMISSION_WINDOW_SECONDS;
  return {
    configured: true,
    valid,
    admission_open:
      valid &&
      admissionStartedAt !== null &&
      admissionUntil !== null &&
      now >= admissionStartedAt &&
      now < admissionUntil,
    previous_ring_generation: previousGeneration,
    previous_shard_count: previousShardCount,
    admission_started_at: admissionStartedAt,
    admission_until: admissionUntil,
  };
}

export function configuredRingTransition(
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
  now: number,
): ConfiguredRingTransition | null {
  const status = inspectRingTransition(env, now);
  if (!status.valid) throw new ProtocolError("ring_transition_misconfigured", 503);
  if (!status.configured) return null;
  const {
    previous_ring_generation: previousRingGeneration,
    previous_shard_count: previousShardCount,
    admission_started_at: admissionStartedAt,
    admission_until: admissionUntil,
  } = status;
  if (
    previousRingGeneration === null ||
    previousShardCount === null ||
    admissionStartedAt === null ||
    admissionUntil === null
  ) {
    throw new ProtocolError("ring_transition_misconfigured", 503);
  }
  return {
    current_ring_generation: parseConfiguredInteger(
      env.CONTAINER_RING_GENERATION,
      1,
      MAX_SAFE_INTEGER,
    ),
    current_shard_count: parseConfiguredInteger(env.CONTAINER_SHARD_COUNT, 1, 1024),
    previous_ring_generation: previousRingGeneration,
    previous_shard_count: previousShardCount,
    admission_started_at: admissionStartedAt,
    admission_until: admissionUntil,
    admission_open: status.admission_open,
  };
}

export function operationRingAdmission(
  shard: OperationShard,
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
  now: number,
): OperationRingAdmission {
  const currentGeneration = parseConfiguredInteger(
    env.CONTAINER_RING_GENERATION,
    1,
    MAX_SAFE_INTEGER,
  );
  const currentShardCount = parseConfiguredInteger(env.CONTAINER_SHARD_COUNT, 1, 1024);
  const expectedName =
    `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`;
  if (
    shard.contract_version !== 1 ||
    shard.shard_index >= shard.shard_count ||
    shard.instance_name !== expectedName
  ) {
    throw new ProtocolError("stale_shard_fence", 409);
  }
  const transition = configuredRingTransition(env, now);
  if (
    shard.ring_generation === currentGeneration &&
    shard.shard_count === currentShardCount
  ) {
    return { role: "current", transition };
  }
  if (
    transition !== null &&
    shard.ring_generation === transition.previous_ring_generation &&
    shard.shard_count === transition.previous_shard_count
  ) {
    return {
      role: transition.admission_open ? "previous_admit" : "previous_replay_only",
      transition,
    };
  }
  throw new ProtocolError("stale_shard_fence", 409);
}

export function parseOperationStatusQuery(body: Uint8Array): OperationStatusQuery {
  return validateOperationStatusQuery(
    parseJsonObject(body, "invalid_operation_status_query"),
  );
}

export function parseTerminalAckRequest(body: Uint8Array): TerminalAckRequestV1 {
  return validateTerminalAckV1Request(parseJsonObject(body, "invalid_terminal_ack"));
}

export function parseTerminalAckV2Request(body: Uint8Array): TerminalAckRequestV2 {
  return validateTerminalAckV2Request(parseJsonObject(body, "invalid_terminal_ack"));
}

export function parseTerminalAckV3Request(body: Uint8Array): TerminalAckRequestV3 {
  return validateTerminalAckV3Request(parseJsonObject(body, "invalid_terminal_ack"));
}

export function validateTerminalAckV1Request(value: unknown): TerminalAckRequestV1 {
  return validateTerminalAckRequestForContract(value, 1) as TerminalAckRequestV1;
}

export function validateTerminalAckV2Request(value: unknown): TerminalAckRequestV2 {
  return validateTerminalAckRequestForContract(value, 2) as TerminalAckRequestV2;
}

export function validateTerminalAckV3Request(value: unknown): TerminalAckRequestV3 {
  const code = "invalid_terminal_ack";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(code, 400);
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    [
      "protocol_version",
      "terminal_ack_contract_version",
      "financial_terminal_contract_version",
      "billing_event_id",
      "terminal_contract_sha256",
      "reconciliation_id",
      "reconciliation_revision",
      "predecessor_billing_event_id",
      "operation_id",
      "owner_generation",
      "operation_from_status",
      "operation_status",
      "response_status",
      "response_code",
      "result",
      "provider_usage_binding",
      "provider_response_binding",
      "shard",
      "trace_id",
    ],
    code,
  );

  if (
    readInteger(record, "terminal_ack_contract_version", 3, 3, code) !== 3 ||
    readInteger(record, "financial_terminal_contract_version", 2, 2, code) !== 2
  ) {
    throw new ProtocolError(code, 400);
  }

  const compatibleV2 = { ...record };
  delete compatibleV2.terminal_ack_contract_version;
  delete compatibleV2.financial_terminal_contract_version;
  delete compatibleV2.provider_response_binding;
  const ack = validateTerminalAckV2Request(compatibleV2);

  const bindingValue = readObject(record, "provider_response_binding", code);
  assertExactKeys(
    bindingValue,
    [
      "attempt_generation",
      "status",
      "response_class",
      "provider_status",
      "client_status",
      "response_code",
      "provider_response_evidence_sha256",
      "client_response_artifact_sha256",
    ],
    code,
  );
  const binding: TerminalAckProviderResponseBinding = {
    attempt_generation: readInteger(
      bindingValue,
      "attempt_generation",
      1,
      MAX_SAFE_INTEGER,
      code,
    ),
    status: readString(
      bindingValue,
      "status",
      9,
      18,
      /^(succeeded|interpreted_reject)$/,
      code,
    ) as TerminalAckProviderResponseBinding["status"],
    response_class: readString(
      bindingValue,
      "response_class",
      7,
      13,
      /^(success|typed_error|http_error|invalid_body)$/,
      code,
    ) as TerminalAckProviderResponseBinding["response_class"],
    provider_status: readInteger(bindingValue, "provider_status", 100, 599, code),
    client_status: readInteger(bindingValue, "client_status", 100, 599, code),
    response_code:
      bindingValue.response_code === null
        ? null
        : readString(
            bindingValue,
            "response_code",
            1,
            64,
            /^[a-z0-9_:-]+$/,
            code,
          ),
    provider_response_evidence_sha256: readString(
      bindingValue,
      "provider_response_evidence_sha256",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
    client_response_artifact_sha256: readString(
      bindingValue,
      "client_response_artifact_sha256",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
  };

  const usageBinding = ack.provider_usage_binding;
  const successValid =
    binding.status === "succeeded" &&
    binding.response_class === "success" &&
    binding.provider_status === 200 &&
    binding.client_status === 200 &&
    binding.response_code === null &&
    ack.operation_status === "completed" &&
    ack.response_status === 200 &&
    ack.response_code === null &&
    ack.result !== null &&
    usageBinding !== null &&
    usageBinding.attempt_generation === binding.attempt_generation &&
    usageBinding.result_sha256 === ack.result.sha256;
  const rejectionMatrixValid =
    (binding.response_class === "typed_error" &&
      binding.provider_status === 200 &&
      binding.client_status === 200 &&
      binding.response_code === "provider_typed_error") ||
    (binding.response_class === "http_error" &&
      binding.provider_status !== 200 &&
      binding.client_status === binding.provider_status &&
      binding.response_code === "provider_http_error") ||
    (binding.response_class === "invalid_body" &&
      binding.provider_status === 200 &&
      binding.client_status === 500 &&
      binding.response_code === "provider_invalid_body");
  const rejectionValid =
    binding.status === "interpreted_reject" &&
    binding.response_class !== "success" &&
    rejectionMatrixValid &&
    ack.operation_status === "failed" &&
    ack.response_status === 422 &&
    ack.response_code === binding.response_code &&
    ack.result === null &&
    usageBinding === null;
  const sourceStatusValid =
    (ack.reconciliation_revision === 1 && ack.operation_from_status === "dispatched") ||
    (ack.reconciliation_revision === 2 &&
      ack.operation_from_status === "recovery_required");
  if (
    ack.owner_generation !== 2 ||
    binding.attempt_generation !== 1 ||
    !sourceStatusValid ||
    (!successValid && !rejectionValid)
  ) {
    throw new ProtocolError(code, 400);
  }

  return {
    ...ack,
    terminal_ack_contract_version: 3,
    financial_terminal_contract_version: 2,
    provider_response_binding: binding,
  };
}

export function validateTerminalAckRequest(value: unknown): TerminalAckRequest {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "provider_usage_binding")
  ) {
    return validateTerminalAckV2Request(value);
  }
  return validateTerminalAckV1Request(value);
}

function validateTerminalAckRequestForContract(
  value: unknown,
  contractVersion: 1 | 2,
): TerminalAckRequest {
  const code = "invalid_terminal_ack";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(code, 400);
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    [
      "protocol_version",
      "billing_event_id",
      "terminal_contract_sha256",
      "reconciliation_id",
      "reconciliation_revision",
      "predecessor_billing_event_id",
      "operation_id",
      "owner_generation",
      "operation_from_status",
      "operation_status",
      "response_status",
      "response_code",
      "result",
      "shard",
      "trace_id",
      ...(contractVersion === 2 ? ["provider_usage_binding"] : []),
    ],
    code,
  );

  const protocolVersion = readInteger(record, "protocol_version", 1, 255, code);
  if (protocolVersion !== 1) throw new ProtocolError("unsupported_protocol", 426);
  const billingEventId = readString(
    record,
    "billing_event_id",
    64,
    64,
    LOWER_HEX_64,
    code,
  );
  const predecessorBillingEventId =
    record.predecessor_billing_event_id === null
      ? null
      : readString(
          record,
          "predecessor_billing_event_id",
          64,
          64,
          LOWER_HEX_64,
          code,
        );
  const reconciliationRevision = readInteger(
    record,
    "reconciliation_revision",
    1,
    2,
    code,
  ) as 1 | 2;
  const operationId = readString(record, "operation_id", 1, 128, ID, code);
  const ownerGeneration = readInteger(
    record,
    "owner_generation",
    1,
    MAX_SAFE_INTEGER,
    code,
  );
  const operationFromStatus = readString(
    record,
    "operation_from_status",
    8,
    17,
    /^(prepared|dispatched|recovery_required)$/,
    code,
  ) as TerminalAckRequest["operation_from_status"];
  const operationStatus = readString(
    record,
    "operation_status",
    6,
    17,
    /^(completed|failed|recovery_required)$/,
    code,
  ) as TerminalAckRequest["operation_status"];
  const responseStatus = readInteger(record, "response_status", 100, 599, code);
  const responseCode =
    record.response_code === null
      ? null
      : readString(record, "response_code", 1, 64, /^[a-z0-9_:-]+$/, code);

  let result: TerminalAckResultManifest | null = null;
  if (record.result !== null) {
    const resultValue = readObject(record, "result", code);
    assertExactKeys(
      resultValue,
      ["object_key", "object_version", "sha256", "size", "content_type"],
      code,
    );
    result = {
      object_key: readString(
        resultValue,
        "object_key",
        8,
        512,
        /^[A-Za-z0-9/_.:-]+$/,
        code,
      ),
      object_version: readString(
        resultValue,
        "object_version",
        1,
        MAX_STORAGE_OBJECT_VERSION_BYTES,
        ID,
        code,
      ),
      sha256: readString(resultValue, "sha256", 64, 64, LOWER_HEX_64, code),
      size: readInteger(resultValue, "size", 0, 64 * 1024 * 1024, code),
      content_type: readString(resultValue, "content_type", 3, 128, CONTENT_TYPE, code),
    };
  }

  let providerUsageBinding: TerminalAckProviderUsageBinding | null = null;
  if (contractVersion === 2 && record.provider_usage_binding !== null) {
    const bindingValue = readObject(record, "provider_usage_binding", code);
    assertExactKeys(
      bindingValue,
      ["attempt_generation", "receipt_sha256", "result_sha256"],
      code,
    );
    providerUsageBinding = {
      attempt_generation: readInteger(
        bindingValue,
        "attempt_generation",
        1,
        MAX_SAFE_INTEGER,
        code,
      ),
      receipt_sha256: readString(
        bindingValue,
        "receipt_sha256",
        64,
        64,
        LOWER_HEX_64,
        code,
      ),
      result_sha256: readString(
        bindingValue,
        "result_sha256",
        64,
        64,
        LOWER_HEX_64,
        code,
      ),
    };
  }

  const shardValue = readObject(record, "shard", code);
  assertExactKeys(
    shardValue,
    ["contract_version", "ring_generation", "shard_count", "shard_index", "instance_name"],
    code,
  );
  const shard: OperationShard = {
    contract_version: readInteger(shardValue, "contract_version", 1, 1, code),
    ring_generation: readInteger(shardValue, "ring_generation", 1, MAX_SAFE_INTEGER, code),
    shard_count: readInteger(shardValue, "shard_count", 1, 1024, code),
    shard_index: readInteger(shardValue, "shard_index", 0, 1023, code),
    instance_name: readString(
      shardValue,
      "instance_name",
      29,
      64,
      /^[a-z0-9-]+$/,
      code,
    ),
  };
  const expectedName =
    `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`;
  if (shard.shard_index >= shard.shard_count || shard.instance_name !== expectedName) {
    throw new ProtocolError(code, 400);
  }

  const transitionValid =
    (operationFromStatus === "prepared" && operationStatus !== "completed") ||
    operationFromStatus === "dispatched" ||
    (operationFromStatus === "recovery_required" && operationStatus !== "recovery_required");
  const revisionValid =
    (reconciliationRevision === 1 &&
      operationFromStatus !== "recovery_required" &&
      predecessorBillingEventId === null) ||
    (reconciliationRevision === 2 &&
      operationFromStatus === "recovery_required" &&
      predecessorBillingEventId !== null);
  const outcomeValid =
    (operationStatus === "completed" &&
      responseStatus >= 200 &&
      responseStatus <= 299 &&
      responseStatus !== 202 &&
      responseCode === null) ||
    (operationStatus === "failed" &&
      responseStatus >= 400 &&
      responseCode !== null &&
      result === null) ||
    (operationStatus === "recovery_required" &&
      responseStatus === 202 &&
      responseCode !== null);
  if (
    !transitionValid ||
    !revisionValid ||
    !outcomeValid ||
    (contractVersion === 2 &&
      providerUsageBinding !== null &&
      (result === null || providerUsageBinding.result_sha256 !== result.sha256)) ||
    (result !== null &&
      result.object_key !==
        `container-results/v1/${operationId}/${ownerGeneration}/${result.sha256}`)
  ) {
    throw new ProtocolError(code, 400);
  }

  const ack = {
    protocol_version: 1,
    billing_event_id: billingEventId,
    terminal_contract_sha256: readString(
      record,
      "terminal_contract_sha256",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
    reconciliation_id: readString(
      record,
      "reconciliation_id",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
    reconciliation_revision: reconciliationRevision,
    predecessor_billing_event_id: predecessorBillingEventId,
    operation_id: operationId,
    owner_generation: ownerGeneration,
    operation_from_status: operationFromStatus,
    operation_status: operationStatus,
    response_status: responseStatus,
    response_code: responseCode,
    result,
    shard,
    trace_id: readString(record, "trace_id", 1, 128, ID, code),
  };
  return contractVersion === 1
    ? (ack as TerminalAckRequestV1)
    : ({ ...ack, provider_usage_binding: providerUsageBinding } as TerminalAckRequestV2);
}

export function validateOperationStatusQuery(value: unknown): OperationStatusQuery {
  const code = "invalid_operation_status_query";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(code, 400);
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    ["protocol_version", "operation_id", "owner_generation", "shard", "trace_id"],
    code,
  );
  const shardValue = readObject(record, "shard", code);
  assertExactKeys(
    shardValue,
    ["contract_version", "ring_generation", "shard_count", "shard_index", "instance_name"],
    code,
  );
  const shard: OperationShard = {
    contract_version: readInteger(shardValue, "contract_version", 1, 1, code),
    ring_generation: readInteger(shardValue, "ring_generation", 1, MAX_SAFE_INTEGER, code),
    shard_count: readInteger(shardValue, "shard_count", 1, 1024, code),
    shard_index: readInteger(shardValue, "shard_index", 0, 1023, code),
    instance_name: readString(shardValue, "instance_name", 29, 64, /^[a-z0-9-]+$/, code),
  };
  const expectedName =
    `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`;
  if (shard.shard_index >= shard.shard_count || shard.instance_name !== expectedName) {
    throw new ProtocolError(code, 400);
  }
  return {
    protocol_version: readInteger(record, "protocol_version", 1, 255, code),
    operation_id: readString(record, "operation_id", 1, 128, ID, code),
    owner_generation: readInteger(record, "owner_generation", 1, MAX_SAFE_INTEGER, code),
    shard,
    trace_id: readString(record, "trace_id", 1, 128, ID, code),
  };
}

export function parseReadinessProbe(
  body: Uint8Array,
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_PROTOCOL_VERSION"
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
): ShardReadinessProbe {
  const code = "invalid_readiness_probe";
  const value = parseJsonObject(body, code);
  assertExactKeys(
    value,
    ["protocol_version", "shard", "wake_container", "activation_campaign"],
    code,
    true,
  );
  const shardValue = readObject(value, "shard", code);
  assertExactKeys(
    shardValue,
    ["contract_version", "ring_generation", "shard_count", "shard_index", "instance_name"],
    code,
  );
  const protocolVersion = readInteger(value, "protocol_version", 1, 255, code);
  const shard: OperationShard = {
    contract_version: readInteger(shardValue, "contract_version", 1, 1, code),
    ring_generation: readInteger(shardValue, "ring_generation", 1, MAX_SAFE_INTEGER, code),
    shard_count: readInteger(shardValue, "shard_count", 1, 1024, code),
    shard_index: readInteger(shardValue, "shard_index", 0, 1023, code),
    instance_name: readString(shardValue, "instance_name", 29, 64, /^[a-z0-9-]+$/, code),
  };
  validateShardFence(protocolVersion, shard, env);
  const wakeContainer = readBoolean(value, "wake_container", code);
  const probe: ShardReadinessProbe = {
    protocol_version: protocolVersion,
    shard,
    wake_container: wakeContainer,
  };
  if (value.activation_campaign !== undefined) {
    const campaign = readObject(value, "activation_campaign", code);
    assertExactKeys(
      campaign,
      ["contract_version", "campaign_id", "nonce", "confirm_consume"],
      code,
    );
    if (
      !wakeContainer ||
      readInteger(campaign, "contract_version", 1, 1, code) !== 1 ||
      !readBoolean(campaign, "confirm_consume", code)
    ) {
      throw new ProtocolError(code, 400);
    }
    probe.activation_campaign = {
      contract_version: 1,
      campaign_id: readString(campaign, "campaign_id", 64, 64, LOWER_HEX_64, code),
      nonce: readString(campaign, "nonce", 64, 64, LOWER_HEX_64, code),
      confirm_consume: true,
    };
  }
  return probe;
}

function validateShardFence(
  protocolVersion: number,
  shard: OperationShard,
  env: Pick<
    AuthorityEnvironment,
    | "CONTAINER_PROTOCOL_VERSION"
    | "CONTAINER_RING_GENERATION"
    | "CONTAINER_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_GENERATION"
    | "CONTAINER_PREVIOUS_SHARD_COUNT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT"
    | "CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL"
  >,
): void {
  const expectedProtocol = parseConfiguredInteger(env.CONTAINER_PROTOCOL_VERSION, 1, 255);
  const expectedGeneration = parseConfiguredInteger(
    env.CONTAINER_RING_GENERATION,
    1,
    MAX_SAFE_INTEGER,
  );
  const expectedShardCount = parseConfiguredInteger(env.CONTAINER_SHARD_COUNT, 1, 1024);
  const expectedName = `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`;
  configuredRingTransition(env, Math.floor(Date.now() / 1000));
  if (protocolVersion !== expectedProtocol) {
    throw new ProtocolError("unsupported_protocol", 426);
  }
  if (
    shard.contract_version !== 1 ||
    shard.ring_generation !== expectedGeneration ||
    shard.shard_count !== expectedShardCount ||
    shard.shard_index >= shard.shard_count ||
    shard.instance_name !== expectedName
  ) {
    throw new ProtocolError("stale_shard_fence", 409);
  }
}

export async function createAuthorityTokenForTest(
  secret: string,
  kid: string,
  claims: AuthorityClaims,
  authorityDomain = AUTHORITY_DOMAIN,
): Promise<string> {
  const header: AuthorityHeader = { typ: "CINATOKEN-CONTAINER-AUTH", alg: "HS256", kid };
  const headerPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const claimsPart = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new TextEncoder().encode(`${authorityDomain}${headerPart}.${claimsPart}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copyArrayBuffer(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBody(
  request: Request,
  requireJson: boolean,
  limit = MAX_OPERATION_BODY_BYTES,
  tooLargeCode = "operation_too_large",
  invalidCode = "invalid_operation",
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new ProtocolError(tooLargeCode, 413);
  }
  if (requireJson && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ProtocolError("invalid_content_type", 415);
  }
  if (request.body === null) throw new ProtocolError(invalidCode, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel(tooLargeCode);
        throw new ProtocolError(tooLargeCode, 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new ProtocolError(invalidCode, 400);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function requireEmptyBody(request: Request): Promise<void> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== 0)) {
    throw new ProtocolError("invalid_status_body", 400);
  }
  if (request.body === null) return;
  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      if (next.value.byteLength > 0) {
        await reader.cancel("invalid_status_body");
        throw new ProtocolError("invalid_status_body", 400);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function requiredAuthority(request: Request): string {
  const value = request.headers.get(AUTHORITY_HEADER);
  if (value === null) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function selectAuthoritySecret(kid: string, env: AuthorityEnvironment): string {
  if (kid === env.CONTAINER_AUTHORITY_CURRENT_KID) {
    return env.CONTAINER_AUTHORITY_CURRENT_SECRET;
  }
  if (
    env.CONTAINER_AUTHORITY_PREVIOUS_KID.length > 0 &&
    kid === env.CONTAINER_AUTHORITY_PREVIOUS_KID &&
    env.CONTAINER_AUTHORITY_PREVIOUS_SECRET !== undefined
  ) {
    return env.CONTAINER_AUTHORITY_PREVIOUS_SECRET;
  }
  throw new ProtocolError("invalid_authority", 403);
}

function validateAuthorityKeyring(env: AuthorityEnvironment): void {
  const encoder = new TextEncoder();
  const currentSecretValid = encoder.encode(env.CONTAINER_AUTHORITY_CURRENT_SECRET).length >= 32;
  const currentKidValid = KEY_ID.test(env.CONTAINER_AUTHORITY_CURRENT_KID);
  const previousKidConfigured = env.CONTAINER_AUTHORITY_PREVIOUS_KID.length > 0;
  const previousSecretConfigured =
    env.CONTAINER_AUTHORITY_PREVIOUS_SECRET !== undefined &&
    env.CONTAINER_AUTHORITY_PREVIOUS_SECRET.length > 0;
  const previousPairValid =
    previousKidConfigured === previousSecretConfigured &&
    (!previousKidConfigured ||
      (KEY_ID.test(env.CONTAINER_AUTHORITY_PREVIOUS_KID) &&
        env.CONTAINER_AUTHORITY_PREVIOUS_KID !== env.CONTAINER_AUTHORITY_CURRENT_KID &&
        encoder.encode(env.CONTAINER_AUTHORITY_PREVIOUS_SECRET ?? "").length >= 32));
  if (!currentSecretValid || !currentKidValid || !previousPairValid) {
    throw new ProtocolError("authority_unavailable", 503);
  }
}

function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (decoded.length > maxBytes) {
      throw new ProtocolError("invalid_authority", 403);
    }
    return decoded;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_authority", 403);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseJsonObject(bytes: Uint8Array, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ProtocolError(code, 400);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(code, code === "invalid_authority" ? 403 : 400);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  code: string,
  optional = false,
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) || (!optional && allowed.some((key) => !(key in value)))) {
    throw new ProtocolError(code, code === "invalid_authority" ? 403 : 400);
  }
}

function readObject(
  value: Record<string, unknown>,
  name: string,
  code = "invalid_operation",
): Record<string, unknown> {
  const member = value[name];
  if (member === null || typeof member !== "object" || Array.isArray(member)) {
    throw new ProtocolError(code, 400);
  }
  return member as Record<string, unknown>;
}

function readBoolean(value: Record<string, unknown>, name: string, code: string): boolean {
  const member = value[name];
  if (typeof member !== "boolean") throw new ProtocolError(code, 400);
  return member;
}

function readString(
  value: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  pattern: RegExp,
  code = "invalid_operation",
): string {
  const member = value[name];
  if (typeof member !== "string" || member.length < min || member.length > max || !pattern.test(member)) {
    throw new ProtocolError(code, code === "invalid_authority" ? 403 : 400);
  }
  return member;
}

function readInteger(
  value: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  code = "invalid_operation",
): number {
  const member = value[name];
  if (!Number.isSafeInteger(member) || (member as number) < min || (member as number) > max) {
    throw new ProtocolError(code, code === "invalid_authority" ? 403 : 400);
  }
  return member as number;
}

function readPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function parseConfiguredInteger(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new ProtocolError("controller_misconfigured", 503);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProtocolError("controller_misconfigured", 503);
  }
  return parsed;
}

function configuredIntegerOrNull(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
