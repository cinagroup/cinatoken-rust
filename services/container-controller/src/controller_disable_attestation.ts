import {
  campaignActionGateInventory,
  type CampaignActionGateEnvironment,
} from "./shard_activation_campaign";
import { ProtocolError } from "./protocol";

export const CONTROLLER_DISABLE_ATTESTATION_PATH =
  "/internal/v1/shard-placement/disable-attestation";
export const CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER =
  "x-cinatoken-controller-disable-attestation-authority";
export const CONTROLLER_DISABLE_ATTESTATION_CONTRACT =
  "cinatoken-container-controller-disable-attestation-v1";
export const CONTROLLER_DISABLE_ATTESTATION_ROLE = "disable_attestation";

const AUTHORITY_DOMAIN =
  "cinatoken:container-controller:disable-attestation-authority:v1\0";
const CREDENTIAL_DOMAIN =
  "cinatoken:container-controller:disable-attestation-credential:v1\0";
const AUTHORITY_TYPE = "CINATOKEN-CONTROLLER-DISABLE-ATTESTATION-AUTH";
const MAX_AUTHORITY_TOKEN_BYTES = 4_096;
const MAX_AUTHORITY_JSON_SEGMENT_BYTES = 2_048;
const MAX_AUTHORITY_LIFETIME_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();

export interface ControllerDisableAttestationEnvironment
  extends CampaignActionGateEnvironment {
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER: string;
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE: string;
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: string;
  CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: string;
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: string;
  CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET?: string;
  CONTAINER_CONTROLLER_SERVICE_NAME: string;
  CF_VERSION_METADATA: { id: string };
}

interface ControllerDisableAttestationAuthorityHeader {
  alg: "HS256";
  kid: string;
  typ: typeof AUTHORITY_TYPE;
}

export interface ControllerDisableAttestationAuthorityClaims {
  audience: string;
  authority_version: 1;
  body_sha256: string;
  credential_id_sha256: string;
  expires_at: number;
  issued_at: number;
  issuer: string;
  method: "POST";
  path_and_query: typeof CONTROLLER_DISABLE_ATTESTATION_PATH;
  request_id_sha256: string;
  role: typeof CONTROLLER_DISABLE_ATTESTATION_ROLE;
}

export interface VerifiedControllerDisableAttestationRequest {
  claims: ControllerDisableAttestationAuthorityClaims;
}

export async function handleControllerDisableAttestationRequest(
  request: Request,
  env: ControllerDisableAttestationEnvironment,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  try {
    const verified = await verifyControllerDisableAttestationRequest(
      request,
      env,
      now,
    );
    return await controllerDisableAttestationResponse(verified, env);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return secureJsonResponse({ error: error.code }, error.status);
    }
    return secureJsonResponse(
      { error: "controller_disable_attestation_failure" },
      503,
    );
  }
}

export async function verifyControllerDisableAttestationRequest(
  request: Request,
  env: ControllerDisableAttestationEnvironment,
  now = Math.floor(Date.now() / 1_000),
): Promise<VerifiedControllerDisableAttestationRequest> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== CONTROLLER_DISABLE_ATTESTATION_PATH ||
    url.search.length !== 0
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  await requireStrictEmptyBody(request);
  const claims = await verifyDisableAttestationAuthority(
    requiredAuthority(request),
    env,
    now,
  );
  return { claims };
}

export async function controllerDisableAttestationResponse(
  verified: VerifiedControllerDisableAttestationRequest,
  env: ControllerDisableAttestationEnvironment,
): Promise<Response> {
  const serviceName = env.CONTAINER_CONTROLLER_SERVICE_NAME;
  const versionId = env.CF_VERSION_METADATA?.id;
  if (
    typeof serviceName !== "string" ||
    !SERVICE_NAME.test(serviceName) ||
    typeof versionId !== "string" ||
    !VERSION_ID.test(versionId)
  ) {
    throw new ProtocolError(
      "controller_disable_attestation_identity_unavailable",
      503,
    );
  }

  const actionGates = await campaignActionGateInventory(env);
  if (
    !actionGates.allActionGatesFalse ||
    actionGates.count !== actionGates.gates.length ||
    actionGates.gates.some((gate) => gate.enabled)
  ) {
    throw new ProtocolError(
      "controller_disable_attestation_action_gate_open",
      409,
    );
  }

  return secureJsonResponse({
    action_gates: {
      all_action_gates_false: true,
      count: actionGates.count,
      digest_sha256: actionGates.digestSha256,
      inventory: actionGates.gates,
    },
    all_action_gates_false: true,
    contract: CONTROLLER_DISABLE_ATTESTATION_CONTRACT,
    controller_enabled: false,
    controller_service_name: serviceName,
    controller_version_id: versionId,
    execution_enabled: false,
    request_id_sha256: verified.claims.request_id_sha256,
    schema_version: 1,
  });
}

export async function createControllerDisableAttestationAuthorityTokenForTest(
  secret: string,
  kid: string,
  claims: ControllerDisableAttestationAuthorityClaims,
  canonical = true,
): Promise<string> {
  const header: ControllerDisableAttestationAuthorityHeader = canonical
    ? {
        alg: "HS256",
        kid,
        typ: AUTHORITY_TYPE,
      }
    : {
        typ: AUTHORITY_TYPE,
        alg: "HS256",
        kid,
      };
  const serialize = canonical
    ? canonicalJsonStringify
    : (value: unknown): string => JSON.stringify(value);
  const headerPart = encodeBase64Url(encoder.encode(serialize(header)));
  const claimsPart = encodeBase64Url(encoder.encode(serialize(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(
    `${AUTHORITY_DOMAIN}${CONTROLLER_DISABLE_ATTESTATION_ROLE}\0${headerPart}.${claimsPart}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, copyArrayBuffer(signed)),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export async function controllerDisableAttestationCredentialIdSha256(
  kid: string,
): Promise<string> {
  return sha256Hex(
    encoder.encode(
      `${CREDENTIAL_DOMAIN}${CONTROLLER_DISABLE_ATTESTATION_ROLE}\0${kid}`,
    ),
  );
}

async function verifyDisableAttestationAuthority(
  token: string,
  env: ControllerDisableAttestationEnvironment,
  now: number,
): Promise<ControllerDisableAttestationAuthorityClaims> {
  validateKeyring(env);
  if (
    token.length === 0 ||
    encoder.encode(token).byteLength > MAX_AUTHORITY_TOKEN_BYTES
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  const [headerPart, claimsPart, signaturePart] = parts;
  const header = parseCanonicalJsonObject(
    decodeBase64Url(headerPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
  );
  assertExactKeys(header, ["alg", "kid", "typ"]);
  const kid = readString(header, "kid", 1, 32, KEY_ID);
  if (header.alg !== "HS256" || header.typ !== AUTHORITY_TYPE) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }

  const signature = decodeBase64Url(signaturePart, 32);
  if (signature.byteLength !== 32) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  const secret = selectSecret(env, kid);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(
    `${AUTHORITY_DOMAIN}${CONTROLLER_DISABLE_ATTESTATION_ROLE}\0${headerPart}.${claimsPart}`,
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      copyArrayBuffer(signature),
      copyArrayBuffer(signed),
    ))
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }

  const value = parseCanonicalJsonObject(
    decodeBase64Url(claimsPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
  );
  assertExactKeys(value, [
    "audience",
    "authority_version",
    "body_sha256",
    "credential_id_sha256",
    "expires_at",
    "issued_at",
    "issuer",
    "method",
    "path_and_query",
    "request_id_sha256",
    "role",
  ]);
  const claims: ControllerDisableAttestationAuthorityClaims = {
    audience: readString(value, "audience", 1, 128, IDENTIFIER),
    authority_version: readInteger(value, "authority_version", 1, 1) as 1,
    body_sha256: readHex(value, "body_sha256"),
    credential_id_sha256: readHex(value, "credential_id_sha256"),
    expires_at: readInteger(
      value,
      "expires_at",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    issued_at: readInteger(
      value,
      "issued_at",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    issuer: readString(value, "issuer", 1, 128, IDENTIFIER),
    method: readLiteral(value, "method", "POST"),
    path_and_query: readLiteral(
      value,
      "path_and_query",
      CONTROLLER_DISABLE_ATTESTATION_PATH,
    ),
    request_id_sha256: readHex(value, "request_id_sha256"),
    role: readLiteral(
      value,
      "role",
      CONTROLLER_DISABLE_ATTESTATION_ROLE,
    ),
  };

  if (
    claims.issuer !==
      env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER ||
    claims.audience !==
      env.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE ||
    claims.body_sha256 !== EMPTY_BODY_SHA256 ||
    claims.credential_id_sha256 !==
      (await controllerDisableAttestationCredentialIdSha256(kid))
  ) {
    throw new ProtocolError(
      "controller_disable_attestation_authority_claim_mismatch",
      403,
    );
  }
  if (claims.expires_at <= now) {
    throw new ProtocolError(
      "controller_disable_attestation_authority_expired",
      409,
    );
  }
  if (
    claims.issued_at > now + MAX_CLOCK_SKEW_SECONDS ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at >
      MAX_AUTHORITY_LIFETIME_SECONDS ||
    now - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS
  ) {
    throw new ProtocolError(
      "controller_disable_attestation_authority_time_window",
      403,
    );
  }
  return claims;
}

async function requireStrictEmptyBody(request: Request): Promise<void> {
  if (
    request.headers.has("content-type") ||
    request.headers.has("content-encoding") ||
    request.headers.has("content-range") ||
    request.headers.has("location")
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_transport",
      400,
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength !== "0") {
    throw new ProtocolError(
      "controller_disable_attestation_body_not_empty",
      400,
    );
  }
  if (request.body === null) return;

  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done && first.value.byteLength > 0) {
      await reader.cancel(
        "controller_disable_attestation_body_not_empty",
      );
      throw new ProtocolError(
        "controller_disable_attestation_body_not_empty",
        400,
      );
    }
    if (!first.done) {
      const second = await reader.read();
      if (!second.done) {
        await reader.cancel(
          "controller_disable_attestation_body_not_empty",
        );
        throw new ProtocolError(
          "controller_disable_attestation_body_not_empty",
          400,
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function requiredAuthority(request: Request): string {
  const value = request.headers.get(
    CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER,
  );
  if (value === null) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  return value;
}

function validateKeyring(
  env: ControllerDisableAttestationEnvironment,
): void {
  const currentSecret =
    env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET;
  const previousSecret =
    env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET;
  const currentValid =
    KEY_ID.test(env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID) &&
    typeof currentSecret === "string" &&
    encoder.encode(currentSecret).byteLength >= 32;
  const previousKidConfigured =
    env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID.length > 0;
  const previousSecretConfigured =
    typeof previousSecret === "string" && previousSecret.length > 0;
  const previousValid =
    previousKidConfigured === previousSecretConfigured &&
    (!previousKidConfigured ||
      (KEY_ID.test(
        env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID,
      ) &&
        env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID !==
          env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID &&
        encoder.encode(previousSecret ?? "").byteLength >= 32));
  if (!currentValid || !previousValid) {
    throw new ProtocolError(
      "controller_disable_attestation_authority_unavailable",
      503,
    );
  }
}

function selectSecret(
  env: ControllerDisableAttestationEnvironment,
  kid: string,
): string {
  if (kid === env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID) {
    return env.CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET;
  }
  if (
    kid === env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID &&
    env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET !== undefined
  ) {
    return env.CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET;
  }
  throw new ProtocolError(
    "invalid_controller_disable_attestation_authority",
    403,
  );
}

function secureJsonResponse(
  value: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(canonicalJsonStringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseCanonicalJsonObject(
  bytes: Uint8Array,
): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      canonicalJsonStringify(value) !== text
    ) {
      throw new Error("canonical object required");
    }
    return value;
  } catch {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
}

function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("integer required");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) throw new Error("JSON value required");

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalJsonValue(value[key]);
  }
  return result;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
}

function readString(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  pattern: RegExp,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length < min ||
    candidate.length > max ||
    !pattern.test(candidate)
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  return candidate;
}

function readHex(
  value: Record<string, unknown>,
  key: string,
): string {
  return readString(value, key, 64, 64, LOWER_HEX_64);
}

function readInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const candidate = value[key];
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < min ||
    (candidate as number) > max
  ) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  return candidate as number;
}

function readLiteral<T extends string>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  return expected;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      copyArrayBuffer(value),
    ),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64Url(
  value: string,
  maxBytes: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
    if (
      decoded.byteLength > maxBytes ||
      encodeBase64Url(decoded) !== value
    ) {
      throw new Error("noncanonical base64url");
    }
    return decoded;
  } catch {
    throw new ProtocolError(
      "invalid_controller_disable_attestation_authority",
      403,
    );
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
