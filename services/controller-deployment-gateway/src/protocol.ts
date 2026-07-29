export const CREATE_REQUEST_CONTRACT =
  "cinatoken-controller-deployment-gateway-create-request-v1";
export const CONTROLLER_ENABLE_COMMAND_CONTRACT =
  "cinatoken-controller-deployment-gateway-enable-command-v1";
export const GATEWAY_IDEMPOTENCY_CONTRACT =
  "cinatoken-controller-deployment-gateway-idempotency-v1";
export const HMAC_WINDOW_SECONDS = 60;
export const HMAC_CLOCK_SKEW_SECONDS = 5;

const HMAC_DOMAIN = "cinatoken-controller-deployment-gateway-v1\n";
const HMAC_HEADER = "x-cinatoken-controller-deployment-gateway";
const HMAC_TYPE = "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY";
const MAX_JSON_BODY_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDENTITY = /^[A-Za-z0-9._:@/-]{1,256}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "dispatchClaimDigestSha256",
  "dispatchConsumptionReceiptDigestSha256",
  "applicationDispatchConsumptionDigestSha256",
  "applicationTicketIdSha256",
  "campaignId",
  "applicationDatabaseIdentitySha256",
  "applicationVersionId",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "dispatchOwnerSha256",
  "leaseTokenSha256",
  "leaseGeneration",
  "controllerServiceName",
  "controllerEnableOperationIdSha256",
  "controllerBaselineVersionId",
  "controllerEnabledVersionId",
  "sendAttemptLimit",
  "retryLimit",
] as const;

export type HmacRole = "create" | "status";

export interface GatewaySecurityEnv {
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET?: string;
}

export interface AuthorityTokenClaims {
  issuer: string;
  audience: string;
  role: HmacRole;
  credential_id_sha256: string;
  request_id: string;
  method: string;
  path_and_query: string;
  body_sha256: string;
  issued_at: number;
  expires_at: number;
}

export interface AuthenticatedRequest {
  role: HmacRole;
  credentialIdSha256: string;
  keyId: string;
  bodySha256: string;
  requestId: string;
}

export interface FrozenControllerEnableCommand {
  schemaVersion: 1;
  contract: typeof CONTROLLER_ENABLE_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  dispatchClaimDigestSha256: string;
  dispatchConsumptionReceiptDigestSha256: string;
  applicationDispatchConsumptionDigestSha256: string;
  applicationTicketIdSha256: string;
  campaignId: string;
  applicationDatabaseIdentitySha256: string;
  applicationVersionId: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  dispatchOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: 1;
  controllerServiceName: string;
  controllerEnableOperationIdSha256: string;
  controllerBaselineVersionId: string;
  controllerEnabledVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
}

export interface CreateDeploymentRequest {
  schemaVersion: 1;
  contract: typeof CREATE_REQUEST_CONTRACT;
  command: FrozenControllerEnableCommand;
  controllerCommandDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  authorityAttemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ProtocolError";
  }
}

export async function readBoundedJson(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ProtocolError("invalid_content_type", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength)
      || Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    throw new ProtocolError("request_too_large", 413);
  }
  if (request.body === null) throw new ProtocolError("invalid_json", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel("request_too_large");
        throw new ProtocolError("request_too_large", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new ProtocolError("invalid_json", 400);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function requireEmptyBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== 0)
  ) {
    throw new ProtocolError("unexpected_body", 400);
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return new Uint8Array();
      if (next.value.byteLength > 0) {
        await reader.cancel("unexpected_body");
        throw new ProtocolError("unexpected_body", 400);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function parseCreateDeploymentRequest(
  body: Uint8Array,
): Promise<CreateDeploymentRequest> {
  const object = parseCanonicalObject(body);
  assertExactKeys(object, [
    "schemaVersion",
    "contract",
    "command",
    "controllerCommandDigestSha256",
    "gatewayIdempotencyKeySha256",
    "authorityAttemptDigestSha256",
    "sendStartedEventDigestSha256",
  ]);
  const command = parseFrozenCommand(requireObject(object.command));
  const request: CreateDeploymentRequest = {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(object.contract, CREATE_REQUEST_CONTRACT),
    command,
    controllerCommandDigestSha256:
      requireSha256(object.controllerCommandDigestSha256),
    gatewayIdempotencyKeySha256:
      requireSha256(object.gatewayIdempotencyKeySha256),
    authorityAttemptDigestSha256:
      requireSha256(object.authorityAttemptDigestSha256),
    sendStartedEventDigestSha256:
      requireSha256(object.sendStartedEventDigestSha256),
  };
  const commandDigest = await sha256Canonical(command);
  if (commandDigest !== request.controllerCommandDigestSha256) {
    throw new ProtocolError("controller_command_digest_mismatch", 400);
  }
  const idempotencyDigest = await sha256Canonical({
    schemaVersion: 1,
    contract: GATEWAY_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    authorizationIdSha256: command.authorizationIdSha256,
    dispatchConsumptionReceiptDigestSha256:
      command.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256: commandDigest,
    controllerEnableOperationIdSha256:
      command.controllerEnableOperationIdSha256,
  });
  if (idempotencyDigest !== request.gatewayIdempotencyKeySha256) {
    throw new ProtocolError("gateway_idempotency_key_mismatch", 400);
  }
  return request;
}

export async function verifyHmacRequest(
  request: Request,
  body: Uint8Array,
  expectedRole: HmacRole,
  env: GatewaySecurityEnv,
  now = Math.floor(Date.now() / 1_000),
): Promise<AuthenticatedRequest> {
  const token = requiredHeader(request, HMAC_HEADER, 4096);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const [headerPart, claimsPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = parseDecodedObject(decodeBase64Url(headerPart, 1024));
  assertExactKeys(header, ["typ", "alg", "kid"]);
  requireLiteral(header.typ, HMAC_TYPE);
  requireLiteral(header.alg, "HS256");
  const keyId = requireString(header.kid, KEY_ID);
  const selected = selectHmacKey(expectedRole, keyId, env);
  const signature = decodeBase64Url(signaturePart, 32, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(selected.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(
      new TextEncoder().encode(`${HMAC_DOMAIN}${headerPart}.${claimsPart}`),
    ),
  );
  if (!valid) throw new ProtocolError("invalid_authority", 403);

  const value = parseDecodedObject(decodeBase64Url(claimsPart, 4096));
  assertExactKeys(value, [
    "issuer",
    "audience",
    "role",
    "credential_id_sha256",
    "request_id",
    "method",
    "path_and_query",
    "body_sha256",
    "issued_at",
    "expires_at",
  ]);
  const claims: AuthorityTokenClaims = {
    issuer: requireString(value.issuer, IDENTITY),
    audience: requireString(value.audience, IDENTITY),
    role: requireRole(value.role),
    credential_id_sha256: requireSha256(value.credential_id_sha256),
    request_id: requireString(value.request_id, IDENTITY),
    method: requireString(value.method, /^[A-Z]+$/),
    path_and_query: requireString(value.path_and_query, /^\/[^\r\n]{0,2047}$/),
    body_sha256: requireSha256(value.body_sha256),
    issued_at: requireInteger(value.issued_at, 1, Number.MAX_SAFE_INTEGER),
    expires_at: requireInteger(value.expires_at, 1, Number.MAX_SAFE_INTEGER),
  };
  const url = new URL(request.url);
  const bodySha256 = await sha256Hex(body);
  if (
    claims.issuer !== env.CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER
    || claims.audience !== env.CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE
    || claims.role !== expectedRole
    || claims.credential_id_sha256 !== selected.credentialIdSha256
    || claims.method !== request.method
    || claims.path_and_query !== `${url.pathname}${url.search}`
    || claims.body_sha256 !== bodySha256
  ) {
    throw new ProtocolError("authority_claim_mismatch", 403);
  }
  if (
    claims.issued_at > now + HMAC_CLOCK_SKEW_SECONDS
    || now - claims.issued_at > HMAC_WINDOW_SECONDS
    || claims.expires_at <= now
    || claims.expires_at <= claims.issued_at
    || claims.expires_at - claims.issued_at > HMAC_WINDOW_SECONDS
  ) {
    throw new ProtocolError("authority_time_window", 403);
  }
  return {
    role: expectedRole,
    credentialIdSha256: selected.credentialIdSha256,
    keyId,
    bodySha256,
    requestId: claims.request_id,
  };
}

export async function createHmacTokenForTest(
  secret: string,
  keyId: string,
  claims: AuthorityTokenClaims,
): Promise<string> {
  const headerPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson({
      alg: "HS256",
      kid: keyId,
      typ: HMAC_TYPE,
    })),
  );
  const claimsPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson(claims)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(
        new TextEncoder().encode(`${HMAC_DOMAIN}${headerPart}.${claimsPart}`),
      ),
    ),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseFrozenCommand(
  object: Record<string, unknown>,
): FrozenControllerEnableCommand {
  assertExactKeys(object, COMMAND_FIELDS);
  const command: FrozenControllerEnableCommand = {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      CONTROLLER_ENABLE_COMMAND_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(object.authorizationIdSha256),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    dispatchClaimDigestSha256:
      requireSha256(object.dispatchClaimDigestSha256),
    dispatchConsumptionReceiptDigestSha256:
      requireSha256(object.dispatchConsumptionReceiptDigestSha256),
    applicationDispatchConsumptionDigestSha256:
      requireSha256(object.applicationDispatchConsumptionDigestSha256),
    applicationTicketIdSha256:
      requireSha256(object.applicationTicketIdSha256),
    campaignId: requireSha256(object.campaignId),
    applicationDatabaseIdentitySha256:
      requireSha256(object.applicationDatabaseIdentitySha256),
    applicationVersionId: requireString(object.applicationVersionId, VERSION_ID),
    authorityDatabaseIdentitySha256:
      requireSha256(object.authorityDatabaseIdentitySha256),
    authorityLedgerIdentitySha256:
      requireSha256(object.authorityLedgerIdentitySha256),
    authorityLedgerHeadSha256:
      requireSha256(object.authorityLedgerHeadSha256),
    authorityVersionId: requireString(object.authorityVersionId, VERSION_ID),
    dispatchOwnerSha256: requireSha256(object.dispatchOwnerSha256),
    leaseTokenSha256: requireSha256(object.leaseTokenSha256),
    leaseGeneration: requireLiteral(object.leaseGeneration, 1),
    controllerServiceName:
      requireString(object.controllerServiceName, SERVICE_NAME),
    controllerEnableOperationIdSha256:
      requireSha256(object.controllerEnableOperationIdSha256),
    controllerBaselineVersionId:
      requireString(object.controllerBaselineVersionId, VERSION_ID),
    controllerEnabledVersionId:
      requireString(object.controllerEnabledVersionId, VERSION_ID),
    sendAttemptLimit: requireLiteral(object.sendAttemptLimit, 1),
    retryLimit: requireLiteral(object.retryLimit, 0),
  };
  if (
    command.controllerBaselineVersionId === command.controllerEnabledVersionId
  ) {
    throw new ProtocolError("controller_versions_not_distinct", 400);
  }
  return command;
}

function selectHmacKey(
  role: HmacRole,
  keyId: string,
  env: GatewaySecurityEnv,
): { secret: string; credentialIdSha256: string } {
  const candidates = role === "create"
    ? [
      {
        keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID,
        credentialIdSha256:
          env
            .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET,
      },
      {
        keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID,
        credentialIdSha256:
          env
            .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET,
      },
    ]
    : [
      {
        keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID,
        credentialIdSha256:
          env
            .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET,
      },
      {
        keyId: env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID,
        credentialIdSha256:
          env
            .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET,
      },
    ];
  for (const candidate of candidates) {
    if (
      candidate.keyId === keyId
      && candidate.secret !== undefined
      && candidate.secret.length >= 32
      && SHA256.test(candidate.credentialIdSha256)
    ) {
      return {
        secret: candidate.secret,
        credentialIdSha256: candidate.credentialIdSha256,
      };
    }
  }
  throw new ProtocolError("invalid_authority", 403);
}

function parseCanonicalObject(body: Uint8Array): Record<string, unknown> {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  if (canonicalJson(value) !== text) {
    throw new ProtocolError("noncanonical_json", 400);
  }
  return requireObject(value);
}

function parseDecodedObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (canonicalJson(value) !== text) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return requireObject(value, "invalid_authority", 403);
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ProtocolError("invalid_number", 400);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  throw new ProtocolError("invalid_json_value", 400);
}

function assertExactKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
}

function requireObject(
  value: unknown,
  code = "invalid_shape",
  status = 400,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(code, status);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("invalid_value", 400);
  }
  return value;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireLiteral<T extends string | number>(
  value: unknown,
  literal: T,
): T {
  if (value !== literal) throw new ProtocolError("invalid_value", 400);
  return literal;
}

function requireRole(value: unknown): HmacRole {
  if (value !== "create" && value !== "status") {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new ProtocolError("invalid_value", 400);
  }
  return value;
}

function requiredHeader(
  request: Request,
  name: string,
  maximumLength: number,
): string {
  const value = request.headers.get(name);
  if (value === null || value.length === 0 || value.length > maximumLength) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function decodeBase64Url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  let decoded: string;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    decoded = atob(padded);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (
    decoded.length > maximumBytes
    || (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
