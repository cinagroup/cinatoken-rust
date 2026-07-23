import {
  CLOUDFLARE_API_ORIGIN,
  RING_TRANSITION_AUTHORITY_HEADER,
  RING_TRANSITION_CLAIM_AUTHORITY_PATH,
  validatePublishedRingTransitionTrust,
} from "./relay_container_ring_transition_execution_contract.mjs";
import {
  normalizeAccountTokenVerifyResponse,
  normalizeDeploymentApiResponse,
} from "./relay_container_ring_transition_deployment_set_collector.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";

export const RING_TRANSITION_NATIVE_TRANSPORT_CONTRACT =
  "cinatoken-relay-container-ring-transition-native-transport-v1";
export const RING_TRANSITION_TRANSPORT_ENV = Object.freeze({
  accountId: "CINATOKEN_RING_TRANSITION_ACCOUNT_ID",
  readToken: "CINATOKEN_RING_TRANSITION_READ_TOKEN",
  claimHmacSecret: "CINATOKEN_RING_TRANSITION_CLAIM_HMAC_SECRET",
  deployToken: "CINATOKEN_RING_TRANSITION_DEPLOY_TOKEN",
});

const AUTHORITY_HMAC_DOMAIN =
  "cinatoken-ring-transition-authority-v1\n";
const AUTHORITY_PREFLIGHT_PATH = "/internal/v1/ring-transition/preflight";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHORITY_TOKEN_WINDOW_SECONDS = 30;
const AUTHORITY_RESPONSE_LIMIT = 256 * 1024;
const CLOUDFLARE_RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAX_AUTHORITY_REQUEST_BYTES = 64 * 1024;
const MAX_DEPLOYMENT_REQUEST_BYTES = 16 * 1024;

export class RingTransitionTransportError extends Error {
  constructor(readonlyCode) {
    super(readonlyCode);
    this.name = "RingTransitionTransportError";
    this.code = readonlyCode;
  }
}

export function describeRingTransitionNativeTransport() {
  return {
    ok: true,
    schemaVersion: 1,
    contract: RING_TRANSITION_NATIVE_TRANSPORT_CONTRACT,
    environment: "staging",
    credentialEnvironmentBindings: Object.values(RING_TRANSITION_TRANSPORT_ENV),
    credentialClasses: ["read", "claim", "deploy"],
    cloudflareApiOrigin: CLOUDFLARE_API_ORIGIN,
    requestTimeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
    authorityMaximumResponseBytes: AUTHORITY_RESPONSE_LIMIT,
    cloudflareMaximumResponseBytes: CLOUDFLARE_RESPONSE_LIMIT,
    redirectsFollowed: false,
    postRetries: 0,
    credentialsRead: false,
    networkRequestsPerformed: false,
    mutationPerformed: false,
  };
}

export function createRingTransitionNativeTransport(options) {
  return new RingTransitionNativeTransport(options);
}

class RingTransitionNativeTransport {
  #trust;
  #accountId;
  #credentialIds;
  #readToken;
  #claimHmacSecret;
  #deployToken;
  #fetch;
  #clock;
  #requestIdFactory;
  #readCredentialVerified = false;
  #claimCredentialVerified = false;
  #deployCredentialVerified = false;

  constructor({
    anchors,
    credentialIds,
    environment,
    fetchImpl = fetch,
    clockImpl = () => new Date(),
    requestIdFactory = () => crypto.randomUUID(),
  }) {
    this.#trust = validatePublishedRingTransitionTrust(anchors);
    this.#credentialIds = validateCredentialIds(credentialIds);
    if (
      typeof environment !== "object" ||
      environment === null ||
      Array.isArray(environment)
    ) {
      throw new RingTransitionTransportError("invalid_environment_source");
    }
    this.#accountId = requireEnvironmentValue(
      environment,
      RING_TRANSITION_TRANSPORT_ENV.accountId,
      ACCOUNT_ID_PATTERN,
      32,
      32,
    );
    if (
      sha256Hex(Buffer.from(this.#accountId, "utf8")) !==
      this.#trust.accountIdSha256
    ) {
      throw new RingTransitionTransportError("account_identity_mismatch");
    }
    this.#readToken = requireEnvironmentSecret(
      environment,
      RING_TRANSITION_TRANSPORT_ENV.readToken,
    );
    this.#claimHmacSecret = requireEnvironmentSecret(
      environment,
      RING_TRANSITION_TRANSPORT_ENV.claimHmacSecret,
    );
    this.#deployToken = requireEnvironmentSecret(
      environment,
      RING_TRANSITION_TRANSPORT_ENV.deployToken,
    );
    if (
      typeof fetchImpl !== "function" ||
      typeof clockImpl !== "function" ||
      typeof requestIdFactory !== "function"
    ) {
      throw new RingTransitionTransportError("invalid_transport_dependency");
    }
    this.#fetch = fetchImpl;
    this.#clock = clockImpl;
    this.#requestIdFactory = requestIdFactory;
  }

  describe() {
    return {
      ...describeRingTransitionNativeTransport(),
      credentialsRead: true,
      accountIdentityMatched: true,
      readCredentialVerified: this.#readCredentialVerified,
      claimCredentialVerified: this.#claimCredentialVerified,
      deployCredentialVerified: this.#deployCredentialVerified,
    };
  }

  async verifyCredentialIdentities() {
    this.#readCredentialVerified = false;
    this.#claimCredentialVerified = false;
    this.#deployCredentialVerified = false;
    const readIdentity = await this.#verifyCloudflareToken(
      this.#readToken,
      this.#credentialIds.read,
      "read",
    );
    const deployIdentity = await this.#verifyCloudflareToken(
      this.#deployToken,
      this.#credentialIds.deploy,
      "deploy",
    );
    await this.preflightAuthority();
    this.#readCredentialVerified = true;
    this.#deployCredentialVerified = true;
    return {
      readCredentialIdSha256: readIdentity,
      claimCredentialIdSha256: this.#credentialIds.claim,
      deployCredentialIdSha256: deployIdentity,
      allDistinct: true,
      allCredentialsVerified: true,
    };
  }

  async sendAuthorityRequest(request) {
    assertAuthorityRequest(request, this.#trust);
    const responseKind = authorityResponseKind(request);
    if (responseKind !== "preflight" && !this.#claimCredentialVerified) {
      throw new RingTransitionTransportError("claim_credential_not_verified");
    }
    const requestId = this.#requestIdFactory();
    const token = await createRingTransitionAuthorityToken({
      request,
      issuer: this.#trust.claimAuthorityIssuer,
      audience: this.#trust.claimAuthorityAudience,
      keyId: this.#trust.claimAuthorityHmacKeyId,
      credentialIdSha256: this.#credentialIds.claim,
      secret: this.#claimHmacSecret,
      now: this.#clock(),
      requestId,
    });
    const headers = {
      ...request.headers,
      [RING_TRANSITION_AUTHORITY_HEADER]: token,
    };
    const result = await executeBoundedJsonRequest({
      request: { ...request, headers },
      authorization: null,
      fetchImpl: this.#fetch,
      postOutcomeAware: request.method === "POST",
      label: "claim_authority",
    });
    let classified = result;
    if (
      request.method === "POST" &&
      result.transportOutcome === "rejected" &&
      result.httpStatus === 503 &&
      result.errorCode === "outcome_unknown" &&
      result.outcomeUnknown === true
    ) {
      classified = {
        ...result,
        transportOutcome: "ambiguous",
        errorCode: null,
        outcomeUnknown: true,
      };
    }
    if (classified.transportOutcome === "success") {
      validateAuthoritySuccessResponse(
        classified.payload,
        responseKind,
        requestId,
        this.#credentialIds.claim,
        this.#trust,
      );
    }
    return classified;
  }

  async preflightAuthority() {
    this.#claimCredentialVerified = false;
    const request = {
      method: "GET",
      url: `${this.#trust.claimAuthorityOrigin}${AUTHORITY_PREFLIGHT_PATH}`,
      headers: { accept: "application/json" },
      body: null,
      retry: false,
      timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
      maximumResponseBytes: AUTHORITY_RESPONSE_LIMIT,
    };
    const result = await this.sendAuthorityRequest(request);
    if (result.transportOutcome !== "success") {
      throw new RingTransitionTransportError("claim_credential_preflight_rejected");
    }
    this.#claimCredentialVerified = true;
    return {
      claimCredentialIdSha256: this.#credentialIds.claim,
      authorityVersionId: this.#trust.claimAuthorityVersionId,
      permitSpkiSha256: this.#trust.claimPermitSpkiSha256,
    };
  }

  async readDeployment(serviceName) {
    this.#requireReadCredential();
    requirePinnedService(serviceName, this.#trust);
    const request = {
      method: "GET",
      url: cloudflareServiceUrl(this.#accountId, serviceName, "deployments"),
      headers: { accept: "application/json" },
      body: null,
      retry: false,
      timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
      maximumResponseBytes: CLOUDFLARE_RESPONSE_LIMIT,
    };
    const result = await this.#sendCloudflareRead(request);
    return normalizeDeploymentReadback(result.payload, serviceName);
  }

  async readVersion(serviceName, versionId) {
    this.#requireReadCredential();
    requirePinnedService(serviceName, this.#trust);
    requireToken(versionId, VERSION_ID_PATTERN, "invalid_version_id");
    const request = {
      method: "GET",
      url: cloudflareServiceUrl(
        this.#accountId,
        serviceName,
        `versions/${encodeURIComponent(versionId)}`,
      ),
      headers: { accept: "application/json" },
      body: null,
      retry: false,
      timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
      maximumResponseBytes: CLOUDFLARE_RESPONSE_LIMIT,
    };
    const result = await this.#sendCloudflareRead(request);
    const envelope = requireObject(result.payload, "invalid_version_response");
    const version = requireObject(envelope.result, "invalid_version_response");
    if (envelope.success !== true || version.id !== versionId) {
      throw new RingTransitionTransportError("version_identity_mismatch");
    }
    return {
      versionId,
      versionDetailSha256: sha256Hex(
        Buffer.from(canonicalApiJson(version), "utf8"),
      ),
    };
  }

  async deployOnce(request) {
    this.#requireDeployCredential();
    assertCloudflareMutationRequest(request, this.#trust, this.#accountId);
    const result = await executeBoundedJsonRequest({
      request,
      authorization: `Bearer ${this.#deployToken}`,
      fetchImpl: this.#fetch,
      postOutcomeAware: true,
      label: "cloudflare_deployment",
    });
    if (result.transportOutcome === "rejected") {
      if (
        [408, 425, 429].includes(result.httpStatus) ||
        result.httpStatus >= 500 ||
        result.rejectionValidated !== true
      ) {
        return {
          ...result,
          transportOutcome: "ambiguous",
          errorCode: null,
          errorCodes: [],
        };
      }
      return result;
    }
    if (result.transportOutcome !== "success") return result;
    if (
      result.payload === null ||
      typeof result.payload !== "object" ||
      result.payload.success !== true
    ) {
      return { ...result, transportOutcome: "ambiguous", payload: null };
    }
    return result;
  }

  async #verifyCloudflareToken(token, expectedIdSha256, credentialClass) {
    const request = {
      method: "GET",
      url:
        `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.#accountId}` +
        "/tokens/verify",
      headers: { accept: "application/json" },
      body: null,
      retry: false,
      timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
      maximumResponseBytes: AUTHORITY_RESPONSE_LIMIT,
    };
    assertCloudflareTokenVerifyRequest(request, this.#accountId);
    const result = await executeBoundedJsonRequest({
      request,
      authorization: `Bearer ${token}`,
      fetchImpl: this.#fetch,
      postOutcomeAware: false,
      label: `${credentialClass}_credential_identity`,
    });
    if (result.transportOutcome !== "success") {
      throw new RingTransitionTransportError(
        `${credentialClass}_credential_identity_rejected`,
      );
    }
    const verified = normalizeAccountTokenVerifyResponse(result.payload);
    const actualIdSha256 = sha256Hex(Buffer.from(verified.id, "utf8"));
    if (actualIdSha256 !== expectedIdSha256) {
      throw new RingTransitionTransportError(
        `${credentialClass}_credential_identity_mismatch`,
      );
    }
    return actualIdSha256;
  }

  async #sendCloudflareRead(request) {
    assertCloudflareReadRequest(request, this.#trust, this.#accountId);
    const result = await executeBoundedJsonRequest({
      request,
      authorization: `Bearer ${this.#readToken}`,
      fetchImpl: this.#fetch,
      postOutcomeAware: false,
      label: "cloudflare_readback",
    });
    if (result.transportOutcome !== "success") {
      throw new RingTransitionTransportError("cloudflare_read_rejected");
    }
    return result;
  }

  #requireReadCredential() {
    if (
      !this.#readCredentialVerified ||
      !this.#claimCredentialVerified ||
      !this.#deployCredentialVerified
    ) {
      throw new RingTransitionTransportError("read_credential_not_verified");
    }
  }

  #requireDeployCredential() {
    if (
      !this.#readCredentialVerified ||
      !this.#claimCredentialVerified ||
      !this.#deployCredentialVerified
    ) {
      throw new RingTransitionTransportError("deploy_credential_not_verified");
    }
  }
}

export async function createRingTransitionAuthorityToken({
  request,
  issuer,
  audience,
  keyId,
  credentialIdSha256,
  secret,
  now,
  requestId,
}) {
  requireToken(issuer, /^[a-z0-9][a-z0-9._:-]{0,127}$/, "invalid_hmac_issuer");
  requireToken(
    audience,
    /^[a-z0-9][a-z0-9._:-]{0,127}$/,
    "invalid_hmac_audience",
  );
  requireToken(keyId, /^[a-z0-9][a-z0-9._-]{0,63}$/, "invalid_hmac_key_id");
  requireToken(credentialIdSha256, SHA256_PATTERN, "invalid_claim_credential_id");
  requireSecret(secret, "invalid_claim_hmac_secret");
  requireToken(requestId, REQUEST_ID_PATTERN, "invalid_request_id");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RingTransitionTransportError("invalid_request_time");
  }
  const url = new URL(request.url);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const bodyBytes = Buffer.from(request.body ?? "", "utf8");
  const headerPart = encodeBase64Url(
    Buffer.from(
      canonicalJson({ alg: "HS256", kid: keyId, typ: "CINATOKEN-RING-AUTHORITY" }),
      "utf8",
    ),
  );
  const claimsPart = encodeBase64Url(
    Buffer.from(
      canonicalJson({
        issuer,
        audience,
        credential_id_sha256: credentialIdSha256,
        request_id: requestId,
        method: request.method,
        path_and_query: `${url.pathname}${url.search}`,
        body_sha256: sha256Hex(bodyBytes),
        issued_at: issuedAt,
        expires_at: issuedAt + AUTHORITY_TOKEN_WINDOW_SECONDS,
      }),
      "utf8",
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    Buffer.from(`${AUTHORITY_HMAC_DOMAIN}${headerPart}.${claimsPart}`, "utf8"),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function executeBoundedJsonRequest({
  request,
  authorization,
  fetchImpl,
  postOutcomeAware,
  label,
}) {
  assertRequestDescriptor(request);
  const headers = { ...request.headers };
  if (authorization !== null) headers.authorization = authorization;
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      redirect: "error",
      headers,
      body: request.body ?? undefined,
      signal: AbortSignal.timeout(request.timeoutMilliseconds),
    });
    if (!response || typeof response.body?.getReader !== "function") {
      throw new RingTransitionTransportError(`${label}_invalid_response`);
    }
    const bytes = await readBoundedBody(
      response,
      request.maximumResponseBytes,
      label,
    );
    const responseIdSha256 = responseIdentitySha256(response.headers);
    const contentType = response.headers?.get?.("content-type") ?? "";
    const contentTypeIsJson = /^application\/json(?:\s*;|$)/i.test(contentType);
    if (!response.ok && !contentTypeIsJson) {
      return rejectedResponse(response, bytes, responseIdSha256, null);
    }
    if (!contentTypeIsJson) {
      throw new RingTransitionTransportError(`${label}_invalid_content_type`);
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      if (!response.ok) {
        return rejectedResponse(response, bytes, responseIdSha256, null);
      }
      throw new RingTransitionTransportError(`${label}_invalid_json`);
    }
    if (!response.ok) {
      return rejectedResponse(response, bytes, responseIdSha256, payload);
    }
    return {
      transportOutcome: "success",
      httpStatus: response.status,
      payload,
      responseBodySha256: sha256Hex(bytes),
      responseIdSha256,
      retry: false,
    };
  } catch (error) {
    if (postOutcomeAware) {
      return {
        transportOutcome: "ambiguous",
        httpStatus: null,
        payload: null,
        responseBodySha256: null,
        responseIdSha256: null,
        retry: false,
      };
    }
    if (error instanceof RingTransitionTransportError) throw error;
    throw new RingTransitionTransportError(`${label}_failed`);
  }
}

function rejectedResponse(response, bytes, responseIdSha256, payload) {
  const errorCodes = cloudflareErrorCodes(payload);
  const errorCode =
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.error === "string" &&
    /^[a-z0-9_]{1,64}$/.test(payload.error)
      ? payload.error
      : null;
  return {
    transportOutcome: "rejected",
    httpStatus: response.status,
    payload: null,
    responseBodySha256: sha256Hex(bytes),
    responseIdSha256,
    errorCode,
    errorCodes,
    rejectionValidated: errorCode !== null || errorCodes.length > 0,
    outcomeUnknown:
      payload !== null &&
      typeof payload === "object" &&
      payload.outcomeUnknown === true,
    retry: false,
  };
}

async function readBoundedBody(response, maximumBytes, label) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new RingTransitionTransportError(`${label}_response_too_large`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new RingTransitionTransportError(`${label}_invalid_chunk`);
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel("response_too_large");
        } catch {
          // The byte-bound failure remains authoritative.
        }
        throw new RingTransitionTransportError(`${label}_response_too_large`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes < 2) {
    throw new RingTransitionTransportError(`${label}_empty_response`);
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertRequestDescriptor(request) {
  const value = requireObject(request, "invalid_request_descriptor");
  if (value.retry !== false) {
    throw new RingTransitionTransportError("request_retry_must_be_false");
  }
  if (value.timeoutMilliseconds !== REQUEST_TIMEOUT_MILLISECONDS) {
    throw new RingTransitionTransportError("request_timeout_mismatch");
  }
  if (
    !Number.isSafeInteger(value.maximumResponseBytes) ||
    value.maximumResponseBytes < 2 ||
    value.maximumResponseBytes > CLOUDFLARE_RESPONSE_LIMIT
  ) {
    throw new RingTransitionTransportError("request_response_bound_invalid");
  }
  if (value.method !== "GET" && value.method !== "POST") {
    throw new RingTransitionTransportError("request_method_invalid");
  }
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new RingTransitionTransportError("request_url_invalid");
  }
  const headers = requireObject(value.headers, "request_headers_invalid");
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (
      ["authorization", "cookie", "origin", "host", "content-encoding"].includes(
        normalized,
      )
    ) {
      throw new RingTransitionTransportError("request_header_forbidden");
    }
  }
  if (value.method === "GET" && value.body !== null) {
    throw new RingTransitionTransportError("get_body_forbidden");
  }
  if (value.method === "POST" && typeof value.body !== "string") {
    throw new RingTransitionTransportError("post_body_required");
  }
  if (
    value.method === "POST" &&
    Buffer.byteLength(value.body, "utf8") > MAX_AUTHORITY_REQUEST_BYTES
  ) {
    throw new RingTransitionTransportError("post_body_too_large");
  }
}

function assertAuthorityRequest(request, trust) {
  assertRequestDescriptor(request);
  if (request.maximumResponseBytes !== AUTHORITY_RESPONSE_LIMIT) {
    throw new RingTransitionTransportError("authority_response_bound_mismatch");
  }
  const url = new URL(request.url);
  if (url.origin !== trust.claimAuthorityOrigin) {
    throw new RingTransitionTransportError("authority_origin_mismatch");
  }
  assertExactHeaderNames(
    request.headers,
    request.method === "GET" && url.pathname === AUTHORITY_PREFLIGHT_PATH
      ? ["accept"]
      : request.method === "GET"
        ? ["accept", RING_TRANSITION_AUTHORITY_HEADER]
        : ["accept", "content-type", RING_TRANSITION_AUTHORITY_HEADER],
    "authority_headers_invalid",
  );
  if (url.pathname === AUTHORITY_PREFLIGHT_PATH) {
    if (request.method !== "GET" || url.search !== "") {
      throw new RingTransitionTransportError("authority_preflight_invalid");
    }
    return;
  }
  const claimId = "[0-9a-f]{64}";
  const pathPattern = new RegExp(
    `^${RING_TRANSITION_CLAIM_AUTHORITY_PATH}(?:/${claimId}(?:/steps|/expire)?)?$`,
  );
  if (!pathPattern.test(url.pathname)) {
    throw new RingTransitionTransportError("authority_path_forbidden");
  }
  if (request.method === "POST" && url.search !== "") {
    throw new RingTransitionTransportError("authority_query_forbidden");
  }
  if (request.method === "GET") {
    if (!new RegExp(`^${RING_TRANSITION_CLAIM_AUTHORITY_PATH}/${claimId}$`).test(url.pathname)) {
      throw new RingTransitionTransportError("authority_read_path_invalid");
    }
    const keys = [...url.searchParams.keys()].sort();
    if (
      canonicalJson(keys) !==
        canonicalJson(["claimDigestSha256", "claimOwnerSha256"]) ||
      [...url.searchParams.entries()].length !== 2
    ) {
      throw new RingTransitionTransportError("authority_read_query_invalid");
    }
  }
}

function assertCloudflareTokenVerifyRequest(request, accountId) {
  assertRequestDescriptor(request);
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== CLOUDFLARE_API_ORIGIN ||
    url.pathname !== `/client/v4/accounts/${accountId}/tokens/verify` ||
    url.search !== ""
  ) {
    throw new RingTransitionTransportError("token_verify_path_forbidden");
  }
  assertExactHeaderNames(request.headers, ["accept"], "token_verify_headers_invalid");
}

function assertCloudflareReadRequest(request, trust, accountId) {
  assertRequestDescriptor(request);
  assertExactHeaderNames(request.headers, ["accept"], "cloudflare_read_headers_invalid");
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== CLOUDFLARE_API_ORIGIN) {
    throw new RingTransitionTransportError("cloudflare_read_path_forbidden");
  }
  const prefix = `/client/v4/accounts/${accountId}/workers/scripts/`;
  if (!url.pathname.startsWith(prefix) || url.search !== "") {
    throw new RingTransitionTransportError("cloudflare_read_path_forbidden");
  }
  const suffix = url.pathname.slice(prefix.length);
  const [encodedService, resource, encodedVersion, extra] = suffix.split("/");
  if (extra !== undefined) {
    throw new RingTransitionTransportError("cloudflare_read_path_forbidden");
  }
  const serviceName = decodeURIComponent(encodedService);
  requirePinnedService(serviceName, trust);
  if (resource === "deployments" && encodedVersion === undefined) return;
  if (resource === "versions" && encodedVersion !== undefined) {
    requireToken(decodeURIComponent(encodedVersion), VERSION_ID_PATTERN, "invalid_version_id");
    return;
  }
  throw new RingTransitionTransportError("cloudflare_read_path_forbidden");
}

function assertCloudflareMutationRequest(request, trust, accountId) {
  assertRequestDescriptor(request);
  if (
    request.method !== "POST" ||
    request.maximumResponseBytes !== CLOUDFLARE_RESPONSE_LIMIT ||
    request.force !== false
  ) {
    throw new RingTransitionTransportError("cloudflare_mutation_contract_invalid");
  }
  assertExactHeaderNames(
    request.headers,
    ["accept", "content-type"],
    "cloudflare_mutation_headers_invalid",
  );
  if (Buffer.byteLength(request.body, "utf8") > MAX_DEPLOYMENT_REQUEST_BYTES) {
    throw new RingTransitionTransportError("cloudflare_mutation_body_too_large");
  }
  if (
    typeof request.requestDigestSha256 !== "string" ||
    request.requestDigestSha256 !== sha256Hex(Buffer.from(request.body, "utf8"))
  ) {
    throw new RingTransitionTransportError("cloudflare_mutation_digest_mismatch");
  }
  const url = new URL(request.url);
  if (url.origin !== CLOUDFLARE_API_ORIGIN || url.search !== "") {
    throw new RingTransitionTransportError("cloudflare_mutation_path_forbidden");
  }
  for (const serviceName of [trust.controllerServiceName, trust.edgeServiceName]) {
    if (
      url.pathname ===
      `/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(serviceName)}/deployments`
    ) {
      return;
    }
  }
  throw new RingTransitionTransportError("cloudflare_mutation_path_forbidden");
}

function normalizeDeploymentReadback(payload, serviceName) {
  const normalized = normalizeDeploymentApiResponse(payload, serviceName);
  const envelope = requireObject(payload, "invalid_deployment_response");
  const result = requireObject(envelope.result, "invalid_deployment_response");
  const deployment = requireObject(
    result.deployments?.[0],
    "invalid_deployment_response",
  );
  let mutationAnnotation = null;
  if (deployment.annotations !== undefined) {
    const annotations = requireObject(
      deployment.annotations,
      "invalid_deployment_annotations",
    );
    const value = annotations["workers/message"];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 256 || /[\r\n]/.test(value)) {
        throw new RingTransitionTransportError("invalid_deployment_annotation");
      }
      mutationAnnotation = value;
    }
  }
  return { ...normalized, mutationAnnotation };
}

function validateCredentialIds(value) {
  const credentials = requireObject(value, "invalid_credential_id_set");
  const keys = Object.keys(credentials).sort();
  if (canonicalJson(keys) !== canonicalJson(["claim", "deploy", "read"])) {
    throw new RingTransitionTransportError("invalid_credential_id_set");
  }
  const normalized = {
    read: requireToken(credentials.read, SHA256_PATTERN, "invalid_read_credential_id"),
    claim: requireToken(credentials.claim, SHA256_PATTERN, "invalid_claim_credential_id"),
    deploy: requireToken(
      credentials.deploy,
      SHA256_PATTERN,
      "invalid_deploy_credential_id",
    ),
  };
  if (new Set(Object.values(normalized)).size !== 3) {
    throw new RingTransitionTransportError("credential_ids_must_be_distinct");
  }
  return normalized;
}

function authorityResponseKind(request) {
  const url = new URL(request.url);
  if (url.pathname === AUTHORITY_PREFLIGHT_PATH) return "preflight";
  if (request.method === "GET") return "claim_read";
  if (url.pathname.endsWith("/steps")) return "step_append";
  if (url.pathname.endsWith("/expire")) return "claim_expire";
  return "claim_create";
}

function validateAuthoritySuccessResponse(
  payload,
  responseKind,
  requestId,
  credentialIdSha256,
  trust,
) {
  const response = requireObject(payload, "authority_response_invalid");
  if (
    response.requestId !== requestId ||
    response.authorityVersionId !== trust.claimAuthorityVersionId
  ) {
    throw new RingTransitionTransportError("authority_response_identity_mismatch");
  }
  const allowedResults = {
    preflight: ["authority_ready"],
    claim_create: ["created", "exact_replay"],
    claim_read: ["exact_claim"],
    step_append: ["step_appended", "step_replayed"],
    claim_expire: ["claim_expired", "expiry_replayed"],
  };
  if (!allowedResults[responseKind].includes(response.result)) {
    throw new RingTransitionTransportError("authority_response_contract_mismatch");
  }
  if (
    responseKind === "preflight" &&
    (response.credentialIdSha256 !== credentialIdSha256 ||
      response.permitSpkiSha256 !== trust.claimPermitSpkiSha256)
  ) {
    throw new RingTransitionTransportError("authority_preflight_identity_mismatch");
  }
}

function assertExactHeaderNames(headers, expected, code) {
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const normalizedExpected = expected.map((name) => name.toLowerCase()).sort();
  if (canonicalJson(names) !== canonicalJson(normalizedExpected)) {
    throw new RingTransitionTransportError(code);
  }
}

function cloudflareErrorCodes(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.success !== false ||
    !Array.isArray(payload.errors) ||
    payload.errors.length < 1 ||
    payload.errors.length > 16
  ) {
    return [];
  }
  const codes = [];
  for (const error of payload.errors) {
    if (
      error === null ||
      typeof error !== "object" ||
      !Number.isSafeInteger(error.code) ||
      error.code < 1
    ) {
      return [];
    }
    codes.push(error.code);
  }
  return codes;
}

function requirePinnedService(serviceName, trust) {
  requireToken(serviceName, SERVICE_NAME_PATTERN, "invalid_service_name");
  if (
    serviceName !== trust.controllerServiceName &&
    serviceName !== trust.edgeServiceName
  ) {
    throw new RingTransitionTransportError("service_outside_pinned_ring");
  }
}

function cloudflareServiceUrl(accountId, serviceName, resource) {
  return (
    `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${accountId}` +
    `/workers/scripts/${encodeURIComponent(serviceName)}/${resource}`
  );
}

function requireEnvironmentValue(environment, name, pattern, minimum, maximum) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    !pattern.test(value)
  ) {
    throw new RingTransitionTransportError(`missing_or_invalid_${name.toLowerCase()}`);
  }
  return value;
}

function requireEnvironmentSecret(environment, name) {
  const value = environment[name];
  requireSecret(value, `missing_or_invalid_${name.toLowerCase()}`);
  return value;
}

function requireSecret(value, code) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 4096 ||
    /\s/.test(value)
  ) {
    throw new RingTransitionTransportError(code);
  }
  return value;
}

function requireObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RingTransitionTransportError(code);
  }
  return value;
}

function requireToken(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RingTransitionTransportError(code);
  }
  return value;
}

function responseIdentitySha256(headers) {
  for (const name of ["cf-ray", "cf-request-id"]) {
    const value = headers?.get?.(name);
    if (
      typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 256 &&
      /^[\x21-\x7e]+$/.test(value)
    ) {
      return sha256Hex(Buffer.from(value, "utf8"));
    }
  }
  return null;
}

function canonicalApiJson(value) {
  return JSON.stringify(canonicalApiValue(value));
}

function canonicalApiValue(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RingTransitionTransportError("invalid_api_number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalApiValue);
  if (typeof value !== "object") {
    throw new RingTransitionTransportError("invalid_api_json");
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalApiValue(value[key]);
  }
  return result;
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
