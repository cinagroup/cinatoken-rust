import {
  ProtocolError,
  canonicalJson,
  sha256Canonical,
  sha256Hex,
} from "./protocol";

export const DISABLE_CREATE_REQUEST_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-create-request-v1";
export const CONTROLLER_DISABLE_COMMAND_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-command-v1";
export const DISABLE_IDEMPOTENCY_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-idempotency-v1";
export const DISABLE_HMAC_WINDOW_SECONDS = 60;
export const DISABLE_HMAC_CLOCK_SKEW_SECONDS = 5;

const HMAC_DOMAIN =
  "cinatoken-controller-deployment-gateway-disable-v1\n";
const HMAC_HEADER =
  "x-cinatoken-controller-deployment-gateway-disable";
const HMAC_TYPE =
  "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY-DISABLE";
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
  "operation14IdSha256",
  "authorityDatabaseIdentitySha256",
  "authorityLedgerIdentitySha256",
  "authorityLedgerHeadSha256",
  "authorityVersionId",
  "leaseOwnerSha256",
  "leaseTokenSha256",
  "leaseGeneration",
  "controllerServiceName",
  "controllerEnabledSourceVersionId",
  "controllerBaselineTargetVersionId",
  "sendAttemptLimit",
  "retryLimit",
] as const;

export type DisableHmacRole = "disable_create" | "disable_status";

export interface DisableGatewaySecurityEnv {
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET?: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID: string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_SECRET?: string;
}

export interface DisableAuthorityTokenClaims {
  issuer: string;
  audience: string;
  role: DisableHmacRole;
  credential_id_sha256: string;
  request_id: string;
  method: string;
  path_and_query: string;
  body_sha256: string;
  issued_at: number;
  expires_at: number;
}

export interface AuthenticatedDisableRequest {
  role: DisableHmacRole;
  credentialIdSha256: string;
  keyId: string;
  bodySha256: string;
  requestId: string;
}

export interface FrozenControllerDisableCommand {
  schemaVersion: 1;
  contract: typeof CONTROLLER_DISABLE_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  operation14IdSha256: string;
  authorityDatabaseIdentitySha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  authorityVersionId: string;
  leaseOwnerSha256: string;
  leaseTokenSha256: string;
  leaseGeneration: number;
  controllerServiceName: string;
  controllerEnabledSourceVersionId: string;
  controllerBaselineTargetVersionId: string;
  sendAttemptLimit: 1;
  retryLimit: 0;
}

export interface DisableCreateRequest {
  schemaVersion: 1;
  contract: typeof DISABLE_CREATE_REQUEST_CONTRACT;
  command: FrozenControllerDisableCommand;
  controllerDisableCommandDigestSha256: string;
  gatewayDisableIdempotencyKeySha256: string;
  authorityAttemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
}

export async function parseDisableCreateRequest(
  body: Uint8Array,
): Promise<DisableCreateRequest> {
  const object = parseCanonicalObject(body);
  assertExactKeys(object, [
    "schemaVersion",
    "contract",
    "command",
    "controllerDisableCommandDigestSha256",
    "gatewayDisableIdempotencyKeySha256",
    "authorityAttemptDigestSha256",
    "sendStartedEventDigestSha256",
  ]);
  const command = parseFrozenControllerDisableCommand(object.command);
  const request: DisableCreateRequest = {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      DISABLE_CREATE_REQUEST_CONTRACT,
    ),
    command,
    controllerDisableCommandDigestSha256:
      requireSha256(object.controllerDisableCommandDigestSha256),
    gatewayDisableIdempotencyKeySha256:
      requireSha256(object.gatewayDisableIdempotencyKeySha256),
    authorityAttemptDigestSha256:
      requireSha256(object.authorityAttemptDigestSha256),
    sendStartedEventDigestSha256:
      requireSha256(object.sendStartedEventDigestSha256),
  };
  const commandDigest = await sha256Canonical(command);
  if (commandDigest !== request.controllerDisableCommandDigestSha256) {
    throw new ProtocolError("disable_command_digest_mismatch", 400);
  }
  const idempotencyDigest = await sha256Canonical({
    schemaVersion: 1,
    contract: DISABLE_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    controllerDisableCommandDigestSha256: commandDigest,
    operation14IdSha256: command.operation14IdSha256,
  });
  if (idempotencyDigest !== request.gatewayDisableIdempotencyKeySha256) {
    throw new ProtocolError("disable_idempotency_key_mismatch", 400);
  }
  return request;
}

export async function verifyDisableHmacRequest(
  request: Request,
  body: Uint8Array,
  expectedRole: DisableHmacRole,
  env: DisableGatewaySecurityEnv,
  now = Math.floor(Date.now() / 1_000),
): Promise<AuthenticatedDisableRequest> {
  const token = requiredHeader(request, HMAC_HEADER, 4096);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("invalid_disable_authority", 403);
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
  if (!valid) throw new ProtocolError("invalid_disable_authority", 403);

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
  const claims: DisableAuthorityTokenClaims = {
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
    throw new ProtocolError("disable_authority_claim_mismatch", 403);
  }
  if (
    claims.issued_at > now + DISABLE_HMAC_CLOCK_SKEW_SECONDS
    || now - claims.issued_at > DISABLE_HMAC_WINDOW_SECONDS
    || claims.expires_at <= now
    || claims.expires_at <= claims.issued_at
    || claims.expires_at - claims.issued_at > DISABLE_HMAC_WINDOW_SECONDS
  ) {
    throw new ProtocolError("disable_authority_time_window", 403);
  }
  return {
    role: expectedRole,
    credentialIdSha256: selected.credentialIdSha256,
    keyId,
    bodySha256,
    requestId: claims.request_id,
  };
}

export async function createDisableHmacTokenForTest(
  secret: string,
  keyId: string,
  claims: DisableAuthorityTokenClaims,
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

export function disableHmacIdentityConfigValid(
  env: DisableGatewaySecurityEnv,
): boolean {
  const configured = disableIdentityCandidates(env);
  const identities: Array<{
    keyId: string;
    credentialIdSha256: string;
    secret: string;
  }> = [];
  for (const identity of configured) {
    if (
      identity.generation === "previous"
      && identity.keyId === ""
      && identity.credentialIdSha256 === ""
    ) {
      if (identity.secret !== "") return false;
      continue;
    }
    if (
      !KEY_ID.test(identity.keyId)
      || !SHA256.test(identity.credentialIdSha256)
      || identity.secret.length < 32
    ) {
      return false;
    }
    identities.push(identity);
  }
  return identities.length >= 2
    && new Set(identities.map((identity) => identity.keyId)).size
      === identities.length
    && new Set(
      identities.map((identity) => identity.credentialIdSha256),
    ).size === identities.length
    && new Set(identities.map((identity) => identity.secret)).size
      === identities.length;
}

export function parseFrozenControllerDisableCommand(
  value: unknown,
): FrozenControllerDisableCommand {
  const object = requireObject(value);
  assertExactKeys(object, COMMAND_FIELDS);
  const command: FrozenControllerDisableCommand = {
    schemaVersion: requireLiteral(object.schemaVersion, 1),
    contract: requireLiteral(
      object.contract,
      CONTROLLER_DISABLE_COMMAND_CONTRACT,
    ),
    authorizationIdSha256: requireSha256(object.authorizationIdSha256),
    claimDigestSha256: requireSha256(object.claimDigestSha256),
    operation14IdSha256: requireSha256(object.operation14IdSha256),
    authorityDatabaseIdentitySha256:
      requireSha256(object.authorityDatabaseIdentitySha256),
    authorityLedgerIdentitySha256:
      requireSha256(object.authorityLedgerIdentitySha256),
    authorityLedgerHeadSha256:
      requireSha256(object.authorityLedgerHeadSha256),
    authorityVersionId: requireString(object.authorityVersionId, VERSION_ID),
    leaseOwnerSha256: requireSha256(object.leaseOwnerSha256),
    leaseTokenSha256: requireSha256(object.leaseTokenSha256),
    leaseGeneration: requireInteger(
      object.leaseGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    controllerServiceName:
      requireString(object.controllerServiceName, SERVICE_NAME),
    controllerEnabledSourceVersionId:
      requireString(object.controllerEnabledSourceVersionId, VERSION_ID),
    controllerBaselineTargetVersionId:
      requireString(object.controllerBaselineTargetVersionId, VERSION_ID),
    sendAttemptLimit: requireLiteral(object.sendAttemptLimit, 1),
    retryLimit: requireLiteral(object.retryLimit, 0),
  };
  if (
    command.controllerEnabledSourceVersionId
      === command.controllerBaselineTargetVersionId
  ) {
    throw new ProtocolError("disable_versions_not_distinct", 400);
  }
  return command;
}

function selectHmacKey(
  role: DisableHmacRole,
  keyId: string,
  env: DisableGatewaySecurityEnv,
): { secret: string; credentialIdSha256: string } {
  const candidates = disableIdentityCandidates(env).filter(
    (candidate) => candidate.role === role,
  );
  for (const candidate of candidates) {
    if (
      candidate.keyId === keyId
      && candidate.secret.length >= 32
      && SHA256.test(candidate.credentialIdSha256)
    ) {
      return {
        secret: candidate.secret,
        credentialIdSha256: candidate.credentialIdSha256,
      };
    }
  }
  throw new ProtocolError("invalid_disable_authority", 403);
}

function disableIdentityCandidates(env: DisableGatewaySecurityEnv) {
  return [
    {
      role: "disable_create" as const,
      generation: "current" as const,
      keyId:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET
          ?? "",
    },
    {
      role: "disable_create" as const,
      generation: "previous" as const,
      keyId:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET
          ?? "",
    },
    {
      role: "disable_status" as const,
      generation: "current" as const,
      keyId:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET
          ?? "",
    },
    {
      role: "disable_status" as const,
      generation: "previous" as const,
      keyId:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID,
      credentialIdSha256:
        env
          .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      secret:
        env.CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_SECRET
          ?? "",
    },
  ];
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
    throw new ProtocolError("invalid_disable_json", 400);
  }
  if (canonicalJson(value) !== text) {
    throw new ProtocolError("noncanonical_disable_json", 400);
  }
  return requireObject(value);
}

function parseDecodedObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new Error("noncanonical");
    }
    return requireObject(value, "invalid_disable_authority", 403);
  } catch {
    throw new ProtocolError("invalid_disable_authority", 403);
  }
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
    throw new ProtocolError("invalid_disable_shape", 400);
  }
}

function requireObject(
  value: unknown,
  code = "invalid_disable_shape",
  status = 400,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(code, status);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("invalid_disable_field", 400);
  }
  return value;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new ProtocolError("invalid_disable_field", 400);
  }
  return value;
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_disable_field", 400);
  }
  return expected;
}

function requireRole(value: unknown): DisableHmacRole {
  if (value !== "disable_create" && value !== "disable_status") {
    throw new ProtocolError("invalid_disable_authority", 403);
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
    throw new ProtocolError("invalid_disable_authority", 403);
  }
  return value;
}

function decodeBase64Url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("invalid_disable_authority", 403);
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  let binary: string;
  try {
    binary = atob(`${normalized}${"=".repeat(padding)}`);
  } catch {
    throw new ProtocolError("invalid_disable_authority", 403);
  }
  if (
    binary.length > maximumBytes
    || (exactBytes !== undefined && binary.length !== exactBytes)
  ) {
    throw new ProtocolError("invalid_disable_authority", 403);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
