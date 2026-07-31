const AUTHORITY_HEADER =
  "x-cinatoken-drain-source-registration-coordinator-authority";
const AUTHORITY_TYPE =
  "CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR";
const AUTHORITY_DOMAIN =
  "cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:";
const OBJECT_NAME_DOMAIN =
  "cinatoken:relay-container:drain-source-registration:coordinator-object:v1";
const OBJECT_NAME_PREFIX = "drain-source-registration-coordinator-v1:";
const MAX_AUTHORITY_BYTES = 4096;
const MAX_AUTHORITY_PART_BYTES = 4096;
const MAX_BODY_BYTES = 16 * 1024;
const AUTHORITY_WINDOW_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 5;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;
const ROUTES = new Set(["/v1/begin", "/v1/finish", "/v1/status", "/v1/recover"]);
const HEADER_KEYS = ["alg", "kid", "typ"];
const CLAIM_KEYS = [
  "audience",
  "body_sha256",
  "caller_identity_sha256",
  "expires_at",
  "issued_at",
  "issuer",
  "method",
  "object_name",
  "path",
  "request_id_sha256",
];
const IDENTITY_KEYS = [
  "authorization_id_sha256",
  "contract_version",
  "environment",
  "operation_id_sha256",
  "root_user_id",
  "scope_id_sha256",
  "scope_kind",
];
const encoder = new TextEncoder();

class ProtocolError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   */
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export default {
  /**
   * @param {Request} request
   * @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env
   */
  async fetch(request, env) {
    try {
      const path = matchRoute(request);
      rejectAmbientHeaders(request);
      requireCoordinatorEnabled(env);
      if (!hasJsonContentType(request)) {
        throw new ProtocolError("invalid_content_type", 415);
      }
      const body = await readCanonicalBody(request);
      const authentication = await verifyAuthority(
        request,
        path,
        body.bytes,
        body.value,
        env,
      );
      const namespace = env.DRAIN_SOURCE_REGISTRATION_COORDINATORS;
      if (
        namespace === undefined ||
        namespace === null ||
        typeof namespace.getByName !== "function"
      ) {
        throw new ProtocolError("coordinator_unavailable", 503);
      }
      const stub = namespace.getByName(authentication.objectName);
      if (stub === undefined || stub === null || typeof stub.fetch !== "function") {
        throw new ProtocolError("coordinator_unavailable", 503);
      }
      return await stub.fetch(
        new Request(`https://registration-coordinator.internal${path}`, {
          method: "POST",
          headers: {
            "content-type": request.headers.get("content-type") ?? "",
            [AUTHORITY_HEADER]: authentication.token,
          },
          body: body.bytes,
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};

/** @param {Request} request */
function matchRoute(request) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    !ROUTES.has(url.pathname) ||
    url.search.length !== 0
  ) {
    throw new ProtocolError("not_found", 404);
  }
  return url.pathname;
}

/** @param {Request} request */
function rejectAmbientHeaders(request) {
  if (
    request.headers.has("authorization") ||
    request.headers.has("content-encoding") ||
    request.headers.has("cookie") ||
    request.headers.has("origin")
  ) {
    throw new ProtocolError("forbidden_request_header", 400);
  }
}

/** @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env */
function requireCoordinatorEnabled(env) {
  if (
    (env.DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT !== "local" &&
      env.DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT !== "staging") ||
    env.DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENABLED !== "true"
  ) {
    throw new ProtocolError("coordinator_disabled", 503);
  }
}

/** @param {Request} request */
function hasJsonContentType(request) {
  const value = request.headers.get("content-type");
  if (value === null) return false;
  const parts = value.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "application/json") return false;
  return (
    parts.length === 1 ||
    (parts.length === 2 && parts[1]?.toLowerCase() === "charset=utf-8")
  );
}

/** @param {Request} request */
async function readCanonicalBody(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength)) {
      throw new ProtocolError("invalid_content_length", 400);
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      throw new ProtocolError("invalid_content_length", 400);
    }
    if (length > MAX_BODY_BYTES) {
      throw new ProtocolError("request_too_large", 413);
    }
  }

  if (request.body === null) {
    throw new ProtocolError("invalid_request", 400);
  }
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new ProtocolError("invalid_request", 400);
      }
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ProtocolError("request_too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_request", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = concatBytes(...chunks);
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_canonical_json", 400);
  }
  if (canonicalJson(value) !== text) {
    throw new ProtocolError("invalid_canonical_json", 400);
  }
  return { bytes, value };
}

/**
 * @param {Request} request
 * @param {string} path
 * @param {Uint8Array} body
 * @param {unknown} bodyValue
 * @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env
 */
async function verifyAuthority(request, path, body, bodyValue, env) {
  const token = request.headers.get(AUTHORITY_HEADER);
  if (
    token === null ||
    token.length === 0 ||
    token.length > MAX_AUTHORITY_BYTES
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part.length > MAX_AUTHORITY_PART_BYTES ||
        !/^[A-Za-z0-9_-]+$/u.test(part),
    )
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }

  const configuration = authorityConfiguration(env);
  const header = parseCanonicalObject(
    decodeCanonicalBase64Url(parts[0], 1024),
    HEADER_KEYS,
  );
  if (
    header.alg !== "HS256" ||
    header.typ !== AUTHORITY_TYPE ||
    typeof header.kid !== "string" ||
    !validIdentifier(header.kid)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const key = [configuration.current, configuration.previous].find(
    (candidate) => candidate?.kid === header.kid,
  );
  if (key === undefined) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const signature = decodeCanonicalBase64Url(parts[2], 32);
  if (signature.byteLength !== 32) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const validSignature = await verifyHmac(
    key.secret,
    concatBytes(
      encoder.encode(AUTHORITY_DOMAIN),
      encoder.encode(parts[0]),
      encoder.encode("."),
      encoder.encode(parts[1]),
    ),
    signature,
  );
  if (!validSignature) {
    throw new ProtocolError("invalid_authority", 403);
  }

  const claims = parseCanonicalObject(
    decodeCanonicalBase64Url(parts[1], MAX_AUTHORITY_PART_BYTES),
    CLAIM_KEYS,
  );
  const bodySha256 = await sha256Hex(body);
  const objectName = await coordinatorObjectName(bodyValue, configuration.environment);
  const requestId = requestIdFromBody(bodyValue);
  if (
    claims.issuer !== configuration.issuer ||
    claims.audience !== configuration.audience ||
    claims.caller_identity_sha256 !== configuration.callerIdentitySha256 ||
    claims.method !== "POST" ||
    claims.method !== request.method ||
    claims.path !== path ||
    claims.body_sha256 !== bodySha256 ||
    claims.request_id_sha256 !== requestId ||
    claims.object_name !== objectName
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (
    !validSha256(claims.body_sha256) ||
    !validSha256(claims.request_id_sha256) ||
    typeof claims.issued_at !== "number" ||
    typeof claims.expires_at !== "number" ||
    !Number.isSafeInteger(claims.issued_at) ||
    !Number.isSafeInteger(claims.expires_at)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.issued_at > now + CLOCK_SKEW_SECONDS ||
    now - claims.issued_at > AUTHORITY_WINDOW_SECONDS ||
    claims.expires_at <= now ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at > AUTHORITY_WINDOW_SECONDS
  ) {
    throw new ProtocolError("authority_time_window", 403);
  }
  return { objectName, token };
}

/** @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env */
function authorityConfiguration(env) {
  const environment = env.DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT;
  const issuer = requiredEnv(
    env,
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER",
  );
  const audience = requiredEnv(
    env,
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE",
  );
  const callerIdentitySha256 = requiredEnv(
    env,
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256",
  );
  const current = {
    kid: requiredEnv(
      env,
      "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID",
    ),
    secret: requiredEnv(
      env,
      "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET",
    ),
  };
  if (
    !validIdentifier(issuer) ||
    !validIdentifier(audience) ||
    issuer === audience ||
    !validSha256(callerIdentitySha256) ||
    !validHmacKey(current)
  ) {
    throw new ProtocolError("coordinator_unavailable", 503);
  }

  const previousKid = optionalEnv(
    env,
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_KID",
  );
  const previousSecret = optionalEnv(
    env,
    "DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_SECRET",
  );
  let previous;
  if (previousKid !== undefined || previousSecret !== undefined) {
    if (previousKid === undefined || previousSecret === undefined) {
      throw new ProtocolError("coordinator_unavailable", 503);
    }
    previous = { kid: previousKid, secret: previousSecret };
    if (
      !validHmacKey(previous) ||
      previous.kid === current.kid ||
      previous.secret === current.secret
    ) {
      throw new ProtocolError("coordinator_unavailable", 503);
    }
  }
  return {
    environment,
    issuer,
    audience,
    callerIdentitySha256,
    current,
    previous,
  };
}

/**
 * @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env
 * @param {string} name
 */
function requiredEnv(env, name) {
  const value = Reflect.get(env, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError("coordinator_unavailable", 503);
  }
  return value;
}

/**
 * @param {DrainSourceRegistrationCoordinatorRuntimeEnv} env
 * @param {string} name
 */
function optionalEnv(env, name) {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {Uint8Array} bytes
 * @param {string[]} expectedKeys
 */
function parseCanonicalObject(bytes, expectedKeys) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (
    !isRecord(value) ||
    canonicalJson(value) !== text ||
    !sameKeys(value, expectedKeys)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

/**
 * @param {unknown} body
 * @param {string} environment
 */
async function coordinatorObjectName(body, environment) {
  if (!isRecord(body) || !isRecord(body.identity)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const identity = body.identity;
  if (
    !sameKeys(identity, IDENTITY_KEYS) ||
    identity.contract_version !== 1 ||
    identity.environment !== environment ||
    identity.scope_kind !== "global" ||
    typeof identity.root_user_id !== "string" ||
    !validRootUserId(identity.root_user_id) ||
    typeof identity.authorization_id_sha256 !== "string" ||
    !validSha256(identity.authorization_id_sha256) ||
    typeof identity.scope_id_sha256 !== "string" ||
    !validSha256(identity.scope_id_sha256) ||
    typeof identity.operation_id_sha256 !== "string" ||
    !validSha256(identity.operation_id_sha256)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const digest = await lengthPrefixedSha256(OBJECT_NAME_DOMAIN, [
    identity.environment,
    identity.root_user_id,
    identity.scope_kind,
    identity.scope_id_sha256,
    identity.operation_id_sha256,
  ]);
  return OBJECT_NAME_PREFIX + digest;
}

/** @param {unknown} body */
function requestIdFromBody(body) {
  if (
    !isRecord(body) ||
    typeof body.request_id_sha256 !== "string" ||
    !validSha256(body.request_id_sha256)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return body.request_id_sha256;
}

/**
 * @param {string} secret
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 */
async function verifyHmac(secret, message, signature) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("HMAC", key, signature, message);
  } catch {
    throw new ProtocolError("coordinator_unavailable", 503);
  }
}

/**
 * @param {string} domain
 * @param {string[]} values
 */
async function lengthPrefixedSha256(domain, values) {
  /** @type {Uint8Array[]} */
  const parts = [encoder.encode(domain)];
  for (const value of values) {
    const bytes = encoder.encode(value);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
    parts.push(length, bytes);
  }
  return sha256Hex(concatBytes(...parts));
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
function decodeCanonicalBase64Url(value, maxBytes) {
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > maxBytes ||
      encodeBase64Url(bytes) !== value
    ) {
      throw new Error("invalid base64url");
    }
    return bytes;
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
}

/** @param {Uint8Array} bytes */
function encodeBase64Url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** @param {{kid: string, secret: string}} key */
function validHmacKey(key) {
  const length = encoder.encode(key.secret).byteLength;
  return validIdentifier(key.kid) && length >= 32 && length <= 256;
}

/** @param {string} value */
function validIdentifier(value) {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

/** @param {unknown} value */
function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/** @param {string} value */
function validRootUserId(value) {
  try {
    const parsed = BigInt(value);
    return (
      parsed > 0n &&
      parsed <= MAX_SAFE_INTEGER &&
      parsed.toString() === value
    );
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} expected
 */
function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value)) ?? "";
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

/** @param {Uint8Array[]} parts */
function concatBytes(...parts) {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** @param {unknown} error */
function errorResponse(error) {
  if (error instanceof ProtocolError) {
    return jsonResponse(error.status, error.code);
  }
  return jsonResponse(503, "coordinator_unavailable");
}

/**
 * @param {number} status
 * @param {string} code
 */
function jsonResponse(status, code) {
  return new Response(JSON.stringify({ code, contract_version: 1 }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
