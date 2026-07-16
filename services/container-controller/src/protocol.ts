const AUTHORITY_DOMAIN = "cinatoken-container-authority:v1\0";
export const AUTHORITY_HEADER = "x-cinatoken-container-authority";
export const INTERNAL_OPERATION_PATH = "/internal/v1/operations";
export const INTERNAL_READINESS_PATH = "/internal/v1/shards/readiness";
export const INTERNAL_STATUS_PATH = "/internal/v1/status";
export const MAX_OPERATION_BODY_BYTES = 64 * 1024;
export const MAX_READINESS_BODY_BYTES = 4 * 1024;
export const MAX_EXECUTION_WINDOW_SECONDS = 300;
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
}

export interface ShardReadinessProbe {
  protocol_version: number;
  shard: OperationShard;
  wake_container: boolean;
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
  return { envelope, claims, body };
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
  const signed = new TextEncoder().encode(`${AUTHORITY_DOMAIN}${headerPart}.${claimsPart}`);
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
    "CONTAINER_PROTOCOL_VERSION" | "CONTAINER_RING_GENERATION" | "CONTAINER_SHARD_COUNT"
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
    input.object_version = readString(inputValue, "object_version", 1, 128, ID);
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
  const expectedGeneration = parseConfiguredInteger(env.CONTAINER_RING_GENERATION, 1, MAX_SAFE_INTEGER);
  const expectedShardCount = parseConfiguredInteger(env.CONTAINER_SHARD_COUNT, 1, 1024);
  const expectedName = `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`;
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
  if (
    executionDeadlineAt <= now ||
    executionDeadlineAt > ownerLeaseExpiresAt ||
    executionDeadlineAt > now + MAX_EXECUTION_WINDOW_SECONDS
  ) {
    throw new ProtocolError("invalid_operation_deadline", 409);
  }
  return envelope;
}

export function parseReadinessProbe(
  body: Uint8Array,
  env: Pick<
    AuthorityEnvironment,
    "CONTAINER_PROTOCOL_VERSION" | "CONTAINER_RING_GENERATION" | "CONTAINER_SHARD_COUNT"
  >,
): ShardReadinessProbe {
  const code = "invalid_readiness_probe";
  const value = parseJsonObject(body, code);
  assertExactKeys(value, ["protocol_version", "shard", "wake_container"], code);
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
  return {
    protocol_version: protocolVersion,
    shard,
    wake_container: readBoolean(value, "wake_container", code),
  };
}

function validateShardFence(
  protocolVersion: number,
  shard: OperationShard,
  env: Pick<
    AuthorityEnvironment,
    "CONTAINER_PROTOCOL_VERSION" | "CONTAINER_RING_GENERATION" | "CONTAINER_SHARD_COUNT"
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
  const signed = new TextEncoder().encode(`${AUTHORITY_DOMAIN}${headerPart}.${claimsPart}`);
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

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
