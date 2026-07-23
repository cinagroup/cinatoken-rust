export const CLAIMS_PATH = "/internal/v1/ring-transition/claims";
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const HMAC_WINDOW_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 5;

const HMAC_DOMAIN = "cinatoken-ring-transition-authority-v1\n";
const PERMIT_DOMAIN = "cinatoken-ring-transition-claim-permit-v1\n";
const CLAIM_REQUEST_CONTRACT =
  "cinatoken-ring-transition-claim-request-v1";
const CLAIM_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-claim-v1";
const STEP_CONTRACT =
  "cinatoken-relay-container-ring-transition-execution-step-v1";
const EXPIRY_CONTRACT =
  "cinatoken-relay-container-ring-transition-expiry-event-v1";
const PERMIT_CONTRACT = "cinatoken-ring-transition-claim-permit-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = new Set([
  "claimed",
  "t1_verified",
  "controller_inflight",
  "controller_verified",
  "edge_prechecked",
  "edge_inflight",
  "completed",
  "recovery_required",
  "aborted",
  "expired",
]);
const STEP_CODES = new Set([
  "t1_readback",
  "controller_mutation_intent",
  "controller_post_readback",
  "edge_pre_readback",
  "edge_mutation_intent",
  "edge_post_readback",
  "terminal",
]);
const FAILURE_CLASSES = new Set([
  "",
  "authorization_expired",
  "operator_abort",
  "transport_response_lost",
  "http_rejected",
  "readback_drift",
  "target_not_stable",
]);
const TRANSPORT_OUTCOMES = new Set([
  "not_applicable",
  "success",
  "ambiguous",
  "rejected",
]);

export interface AuthoritySecurityEnv {
  RING_TRANSITION_AUTHORITY_ISSUER: string;
  RING_TRANSITION_AUTHORITY_AUDIENCE: string;
  RING_TRANSITION_HMAC_CURRENT_KID: string;
  RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  RING_TRANSITION_HMAC_CURRENT_SECRET?: string;
  RING_TRANSITION_HMAC_PREVIOUS_KID: string;
  RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  RING_TRANSITION_HMAC_PREVIOUS_SECRET?: string;
  RING_TRANSITION_PERMIT_KEY_ID: string;
  RING_TRANSITION_PERMIT_ISSUER: string;
  RING_TRANSITION_PERMIT_SPKI_BASE64URL: string;
  RING_TRANSITION_PERMIT_SPKI_SHA256: string;
  RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256: string;
}

export interface AuthenticatedRequest {
  credentialIdSha256: string;
  keyId: string;
  bodySha256: string;
  requestId: string;
}

export interface ServiceTarget {
  serviceName: string;
  previousVersionId: string;
  previousDeploymentSetSha256: string;
  targetVersionId: string;
}

export interface Claim {
  schemaVersion: 1;
  contract: typeof CLAIM_CONTRACT;
  claimAuthority: "d1-unique-claim-v1";
  claimScope: "staging-worker-ring-transition";
  environment: "staging";
  authorizationIdSha256: string;
  executionNonceSha256: string;
  authorizationManifestSha256: string;
  authorizationSubjectSha256: string;
  authorizationPolicySha256: string;
  transitionManifestSha256: string;
  transitionSubjectSha256: string;
  transitionPolicySha256: string;
  transitionPlanSha256: string;
  candidateSha256: string;
  executionPlanSha256: string;
  accountIdSha256: string;
  ledgerIdentitySha256: string;
  readCredentialIdSha256: string;
  claimCredentialIdSha256: string;
  deployCredentialIdSha256: string;
  controller: ServiceTarget;
  edge: ServiceTarget;
  runnerBuildSha256: string;
  runnerTrustConfigSha256: string;
  claimOwnerSha256: string;
  generatedAt: number;
  expiresAt: number;
  claimDigestSha256: string;
}

export interface Step {
  schemaVersion: 1;
  contract: typeof STEP_CONTRACT;
  ledgerIdentitySha256: string;
  claimDigestSha256: string;
  stateVersion: number;
  stepCode: string;
  fromStatus: string;
  toStatus: string;
  mutationRequestSha256: string | null;
  cloudflareRequestIdSha256: string | null;
  deploymentSetSha256: string | null;
  evidenceSha256: string;
  failureClass: string;
  transportOutcome: string;
  stepDigestSha256: string;
}

export interface ExpiryEvent {
  schemaVersion: 1;
  contract: typeof EXPIRY_CONTRACT;
  ledgerIdentitySha256: string;
  claimDigestSha256: string;
  stateVersion: number;
  fromStatus: string;
  toStatus: string;
  evidenceSha256: string;
  expiryEventDigestSha256: string;
  failureClass: "authorization_expired";
}

interface Permit {
  schemaVersion: 1;
  contract: typeof PERMIT_CONTRACT;
  issuer: string;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  ledgerIdentitySha256: string;
  claimCredentialIdSha256: string;
  signatureBase64url: string;
}

export interface AuthorityTokenClaims {
  issuer: string;
  audience: string;
  credential_id_sha256: string;
  request_id: string;
  method: string;
  path_and_query: string;
  body_sha256: string;
  issued_at: number;
  expires_at: number;
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
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    throw new ProtocolError("request_too_large", 413);
  }
  if (request.body === null) {
    throw new ProtocolError("invalid_json", 400);
  }
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
  if (total === 0) {
    throw new ProtocolError("invalid_json", 400);
  }
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
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== 0)) {
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

export async function verifyHmacRequest(
  request: Request,
  body: Uint8Array,
  env: AuthoritySecurityEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedRequest> {
  const token = requiredHeader(request, "x-cinatoken-ring-authority", 4096);
  if (token.length > 4096) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = parseDecodedObject(decodeBase64Url(headerPart, 1024));
  assertExactKeys(header, ["typ", "alg", "kid"]);
  requireLiteral(header.typ, "CINATOKEN-RING-AUTHORITY");
  requireLiteral(header.alg, "HS256");
  const keyId = requireString(header.kid, KEY_ID);
  const selected = selectHmacKey(keyId, env);
  const signature = decodeBase64Url(signaturePart, 32, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(selected.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(
    `${HMAC_DOMAIN}${headerPart}.${claimsPart}`,
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(signingInput),
  );
  if (!valid) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const claimsValue = parseDecodedObject(decodeBase64Url(claimsPart, 4096));
  assertExactKeys(claimsValue, [
    "issuer",
    "audience",
    "credential_id_sha256",
    "request_id",
    "method",
    "path_and_query",
    "body_sha256",
    "issued_at",
    "expires_at",
  ]);
  const claims: AuthorityTokenClaims = {
    issuer: requireString(claimsValue.issuer, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    audience: requireString(
      claimsValue.audience,
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    ),
    credential_id_sha256: requireSha256(claimsValue.credential_id_sha256),
    request_id: requireString(
      claimsValue.request_id,
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    ),
    method: requireString(claimsValue.method, /^[A-Z]+$/),
    path_and_query: requireString(claimsValue.path_and_query, /^\/[^\r\n]{0,2047}$/),
    body_sha256: requireSha256(claimsValue.body_sha256),
    issued_at: requireInteger(claimsValue.issued_at, 1, Number.MAX_SAFE_INTEGER),
    expires_at: requireInteger(claimsValue.expires_at, 1, Number.MAX_SAFE_INTEGER),
  };
  const url = new URL(request.url);
  const bodySha256 = await sha256Hex(body);
  if (
    claims.issuer !== env.RING_TRANSITION_AUTHORITY_ISSUER ||
    claims.audience !== env.RING_TRANSITION_AUTHORITY_AUDIENCE ||
    claims.credential_id_sha256 !== selected.credentialIdSha256 ||
    claims.method !== request.method ||
    claims.path_and_query !== `${url.pathname}${url.search}` ||
    claims.body_sha256 !== bodySha256
  ) {
    throw new ProtocolError("authority_claim_mismatch", 403);
  }
  if (
    claims.issued_at > now + CLOCK_SKEW_SECONDS ||
    now - claims.issued_at > HMAC_WINDOW_SECONDS ||
    claims.expires_at <= now ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at > HMAC_WINDOW_SECONDS
  ) {
    throw new ProtocolError("authority_time_window", 403);
  }
  return {
    credentialIdSha256: claims.credential_id_sha256,
    keyId,
    bodySha256,
    requestId: claims.request_id,
  };
}

export async function parseClaimRequest(
  body: Uint8Array,
  authenticatedCredentialIdSha256: string,
  env: AuthoritySecurityEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<Claim> {
  const envelope = parseCanonicalObject(body);
  assertExactKeys(envelope, ["schemaVersion", "contract", "claim", "permit"]);
  requireLiteral(envelope.schemaVersion, 1);
  requireLiteral(envelope.contract, CLAIM_REQUEST_CONTRACT);
  const claim = await parseClaim(requireObject(envelope.claim), now);
  if (claim.claimCredentialIdSha256 !== authenticatedCredentialIdSha256) {
    throw new ProtocolError("credential_identity_mismatch", 403);
  }
  await verifyPermit(requireObject(envelope.permit), claim, env, now);
  return claim;
}

export async function parseStepRequest(body: Uint8Array): Promise<Step> {
  const value = parseCanonicalObject(body);
  const keys = [
    "schemaVersion",
    "contract",
    "ledgerIdentitySha256",
    "claimDigestSha256",
    "stateVersion",
    "stepCode",
    "fromStatus",
    "toStatus",
    "mutationRequestSha256",
    "cloudflareRequestIdSha256",
    "deploymentSetSha256",
    "evidenceSha256",
    "failureClass",
    "transportOutcome",
    "stepDigestSha256",
  ];
  assertExactKeys(value, keys);
  requireLiteral(value.schemaVersion, 1);
  requireLiteral(value.contract, STEP_CONTRACT);
  const step: Step = {
    schemaVersion: 1,
    contract: STEP_CONTRACT,
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    stateVersion: requireInteger(value.stateVersion, 1, 6),
    stepCode: requireSetString(value.stepCode, STEP_CODES),
    fromStatus: requireSetString(value.fromStatus, STATUSES),
    toStatus: requireSetString(value.toStatus, STATUSES),
    mutationRequestSha256: requireNullableSha256(value.mutationRequestSha256),
    cloudflareRequestIdSha256: requireNullableSha256(value.cloudflareRequestIdSha256),
    deploymentSetSha256: requireNullableSha256(value.deploymentSetSha256),
    evidenceSha256: requireSha256(value.evidenceSha256),
    failureClass: requireSetString(value.failureClass, FAILURE_CLASSES),
    transportOutcome: requireSetString(value.transportOutcome, TRANSPORT_OUTCOMES),
    stepDigestSha256: requireSha256(value.stepDigestSha256),
  };
  await assertDigest(step, "stepDigestSha256");
  return step;
}

export async function parseExpiryRequest(body: Uint8Array): Promise<ExpiryEvent> {
  const value = parseCanonicalObject(body);
  const keys = [
    "schemaVersion",
    "contract",
    "ledgerIdentitySha256",
    "claimDigestSha256",
    "stateVersion",
    "fromStatus",
    "toStatus",
    "evidenceSha256",
    "expiryEventDigestSha256",
    "failureClass",
  ];
  assertExactKeys(value, keys);
  requireLiteral(value.schemaVersion, 1);
  requireLiteral(value.contract, EXPIRY_CONTRACT);
  const event: ExpiryEvent = {
    schemaVersion: 1,
    contract: EXPIRY_CONTRACT,
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    stateVersion: requireInteger(value.stateVersion, 1, 6),
    fromStatus: requireSetString(value.fromStatus, new Set([
      "claimed",
      "t1_verified",
      "controller_verified",
      "edge_prechecked",
    ])),
    toStatus: requireSetString(value.toStatus, new Set(["expired", "recovery_required"])),
    evidenceSha256: requireSha256(value.evidenceSha256),
    expiryEventDigestSha256: requireSha256(value.expiryEventDigestSha256),
    failureClass: requireLiteral(value.failureClass, "authorization_expired"),
  };
  await assertDigest(event, "expiryEventDigestSha256");
  return event;
}

export function parseExactClaimQuery(url: URL): {
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
} {
  const match = /^\/internal\/v1\/ring-transition\/claims\/([0-9a-f]{64})$/.exec(
    url.pathname,
  );
  if (match === null) throw new ProtocolError("route_not_found", 404);
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 ||
    entries[0]?.[0] !== "claimDigestSha256" ||
    entries[1]?.[0] !== "claimOwnerSha256"
  ) {
    throw new ProtocolError("invalid_query", 400);
  }
  return {
    authorizationIdSha256: match[1]!,
    claimDigestSha256: requireSha256(entries[0]![1]),
    claimOwnerSha256: requireSha256(entries[1]![1]),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await sha256Bytes(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
}

export async function createHmacTokenForTest(
  secret: string,
  keyId: string,
  claims: AuthorityTokenClaims,
): Promise<string> {
  const headerPart = encodeBase64Url(
    new TextEncoder().encode(
      canonicalJson({
        alg: "HS256",
        kid: keyId,
        typ: "CINATOKEN-RING-AUTHORITY",
      }),
    ),
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
      toArrayBuffer(new TextEncoder().encode(`${HMAC_DOMAIN}${headerPart}.${claimsPart}`)),
    ),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

async function parseClaim(
  value: Record<string, unknown>,
  now: number,
): Promise<Claim> {
  const keys = [
    "schemaVersion",
    "contract",
    "claimAuthority",
    "claimScope",
    "environment",
    "authorizationIdSha256",
    "executionNonceSha256",
    "authorizationManifestSha256",
    "authorizationSubjectSha256",
    "authorizationPolicySha256",
    "transitionManifestSha256",
    "transitionSubjectSha256",
    "transitionPolicySha256",
    "transitionPlanSha256",
    "candidateSha256",
    "executionPlanSha256",
    "accountIdSha256",
    "ledgerIdentitySha256",
    "readCredentialIdSha256",
    "claimCredentialIdSha256",
    "deployCredentialIdSha256",
    "controller",
    "edge",
    "runnerBuildSha256",
    "runnerTrustConfigSha256",
    "claimOwnerSha256",
    "generatedAt",
    "expiresAt",
    "claimDigestSha256",
  ];
  assertExactKeys(value, keys);
  requireLiteral(value.schemaVersion, 1);
  requireLiteral(value.contract, CLAIM_CONTRACT);
  const claim: Claim = {
    schemaVersion: 1,
    contract: CLAIM_CONTRACT,
    claimAuthority: requireLiteral(value.claimAuthority, "d1-unique-claim-v1"),
    claimScope: requireLiteral(value.claimScope, "staging-worker-ring-transition"),
    environment: requireLiteral(value.environment, "staging"),
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    executionNonceSha256: requireSha256(value.executionNonceSha256),
    authorizationManifestSha256: requireSha256(value.authorizationManifestSha256),
    authorizationSubjectSha256: requireSha256(value.authorizationSubjectSha256),
    authorizationPolicySha256: requireSha256(value.authorizationPolicySha256),
    transitionManifestSha256: requireSha256(value.transitionManifestSha256),
    transitionSubjectSha256: requireSha256(value.transitionSubjectSha256),
    transitionPolicySha256: requireSha256(value.transitionPolicySha256),
    transitionPlanSha256: requireSha256(value.transitionPlanSha256),
    candidateSha256: requireSha256(value.candidateSha256),
    executionPlanSha256: requireSha256(value.executionPlanSha256),
    accountIdSha256: requireSha256(value.accountIdSha256),
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    readCredentialIdSha256: requireSha256(value.readCredentialIdSha256),
    claimCredentialIdSha256: requireSha256(value.claimCredentialIdSha256),
    deployCredentialIdSha256: requireSha256(value.deployCredentialIdSha256),
    controller: parseServiceTarget(value.controller),
    edge: parseServiceTarget(value.edge),
    runnerBuildSha256: requireSha256(value.runnerBuildSha256),
    runnerTrustConfigSha256: requireSha256(value.runnerTrustConfigSha256),
    claimOwnerSha256: requireSha256(value.claimOwnerSha256),
    generatedAt: requireInteger(value.generatedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: requireInteger(value.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
  };
  if (
    claim.authorizationIdSha256 === claim.executionNonceSha256 ||
    new Set([
      claim.readCredentialIdSha256,
      claim.claimCredentialIdSha256,
      claim.deployCredentialIdSha256,
    ]).size !== 3 ||
    claim.controller.previousVersionId === claim.controller.targetVersionId ||
    claim.edge.previousVersionId === claim.edge.targetVersionId ||
    claim.generatedAt > now ||
    claim.expiresAt < now + 60 ||
    claim.expiresAt > claim.generatedAt + 600
  ) {
    throw new ProtocolError("invalid_claim", 400);
  }
  await assertDigest(claim, "claimDigestSha256");
  return claim;
}

function parseServiceTarget(value: unknown): ServiceTarget {
  const target = requireObject(value);
  assertExactKeys(target, [
    "serviceName",
    "previousVersionId",
    "previousDeploymentSetSha256",
    "targetVersionId",
  ]);
  const serviceName = requireString(target.serviceName, SERVICE_NAME);
  const previousVersionId = requireString(target.previousVersionId, VERSION_ID);
  const targetVersionId = requireString(target.targetVersionId, VERSION_ID);
  return {
    serviceName,
    previousVersionId,
    previousDeploymentSetSha256: requireSha256(
      target.previousDeploymentSetSha256,
    ),
    targetVersionId,
  };
}

async function verifyPermit(
  value: Record<string, unknown>,
  claim: Claim,
  env: AuthoritySecurityEnv,
  now: number,
): Promise<void> {
  const keys = [
    "schemaVersion",
    "contract",
    "issuer",
    "keyId",
    "issuedAt",
    "expiresAt",
    "authorizationIdSha256",
    "claimDigestSha256",
    "claimOwnerSha256",
    "ledgerIdentitySha256",
    "claimCredentialIdSha256",
    "signatureBase64url",
  ];
  assertExactKeys(value, keys);
  const permit: Permit = {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(value.contract, PERMIT_CONTRACT),
    issuer: requireString(value.issuer, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    keyId: requireString(value.keyId, KEY_ID),
    issuedAt: requireInteger(value.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: requireInteger(value.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    claimOwnerSha256: requireSha256(value.claimOwnerSha256),
    ledgerIdentitySha256: requireSha256(value.ledgerIdentitySha256),
    claimCredentialIdSha256: requireSha256(value.claimCredentialIdSha256),
    signatureBase64url: requireString(
      value.signatureBase64url,
      /^[A-Za-z0-9_-]{86}$/,
    ),
  };
  if (
    permit.issuer !== env.RING_TRANSITION_PERMIT_ISSUER ||
    permit.keyId !== env.RING_TRANSITION_PERMIT_KEY_ID ||
    permit.authorizationIdSha256 !== claim.authorizationIdSha256 ||
    permit.claimDigestSha256 !== claim.claimDigestSha256 ||
    permit.claimOwnerSha256 !== claim.claimOwnerSha256 ||
    permit.ledgerIdentitySha256 !== claim.ledgerIdentitySha256 ||
    permit.claimCredentialIdSha256 !== claim.claimCredentialIdSha256
  ) {
    throw new ProtocolError("permit_claim_mismatch", 403);
  }
  if (
    permit.issuedAt > now + CLOCK_SKEW_SECONDS ||
    now - permit.issuedAt > HMAC_WINDOW_SECONDS ||
    permit.expiresAt <= now ||
    permit.expiresAt <= permit.issuedAt ||
    permit.expiresAt - permit.issuedAt > HMAC_WINDOW_SECONDS ||
    permit.expiresAt > claim.expiresAt
  ) {
    throw new ProtocolError("permit_time_window", 403);
  }
  let spki: Uint8Array;
  let expectedSpkiSha256: Uint8Array;
  try {
    spki = decodeBase64Url(env.RING_TRANSITION_PERMIT_SPKI_BASE64URL, 512);
    expectedSpkiSha256 = decodeSha256Hex(
      env.RING_TRANSITION_PERMIT_SPKI_SHA256,
    );
  } catch {
    throw new ProtocolError("permit_verifier_unavailable", 503);
  }
  if (
    !constantTimeEqual(
      await sha256Bytes(spki),
      expectedSpkiSha256,
    )
  ) {
    throw new ProtocolError("permit_verifier_unavailable", 503);
  }
  const signature = decodeBase64Url(permit.signatureBase64url, 64, 64);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(spki),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new ProtocolError("permit_verifier_unavailable", 503);
  }
  const signedPermit = { ...permit };
  delete (signedPermit as Partial<Permit>).signatureBase64url;
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(
      new TextEncoder().encode(`${PERMIT_DOMAIN}${canonicalJson(signedPermit)}`),
    ),
  );
  if (!valid) throw new ProtocolError("invalid_permit", 403);
}

function selectHmacKey(
  keyId: string,
  env: AuthoritySecurityEnv,
): { secret: string; credentialIdSha256: string } {
  let secret: string | undefined;
  let credentialIdSha256 = "";
  if (keyId === env.RING_TRANSITION_HMAC_CURRENT_KID) {
    secret = env.RING_TRANSITION_HMAC_CURRENT_SECRET;
    credentialIdSha256 =
      env.RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256;
  } else if (
    env.RING_TRANSITION_HMAC_PREVIOUS_KID.length > 0 &&
    keyId === env.RING_TRANSITION_HMAC_PREVIOUS_KID
  ) {
    secret = env.RING_TRANSITION_HMAC_PREVIOUS_SECRET;
    credentialIdSha256 =
      env.RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256;
  } else {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (
    secret === undefined ||
    new TextEncoder().encode(secret).byteLength < 32 ||
    !SHA256.test(credentialIdSha256)
  ) {
    throw new ProtocolError("authority_unavailable", 503);
  }
  return { secret, credentialIdSha256 };
}

function parseCanonicalObject(body: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  const object = requireObject(value);
  let canonical: string;
  try {
    canonical = canonicalJson(object);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  if (canonical !== text) {
    throw new ProtocolError("non_canonical_json", 400);
  }
  return object;
}

function parseDecodedObject(body: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
  try {
    return requireObject(value);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("non_integer_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) throw new Error("non_json_value");
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

async function assertDigest<T extends Record<string, unknown> | object>(
  value: T,
  digestKey: keyof T,
): Promise<void> {
  const copy = { ...value } as Record<string, unknown>;
  const supplied = copy[String(digestKey)];
  delete copy[String(digestKey)];
  const digest = await sha256Hex(new TextEncoder().encode(canonicalJson(copy)));
  if (digest !== supplied) throw new ProtocolError("digest_mismatch", 400);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ProtocolError("invalid_fields", 400);
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ProtocolError("invalid_fields", 400);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireSha256(value: unknown): string {
  return requireString(value, SHA256);
}

function requireNullableSha256(value: unknown): string | null {
  return value === null ? null : requireSha256(value);
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return value;
}

function requireSetString(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return value;
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw new ProtocolError("invalid_fields", 400);
  return expected;
}

function requiredHeader(request: Request, name: string, maximumLength = 512): string {
  const value = request.headers.get(name);
  if (value === null || value.length === 0 || value.length > maximumLength) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function decodeBase64Url(
  value: string,
  maximumLength: number,
  exactLength?: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const bytes = decodeBase64(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    maximumLength,
  );
  if (exactLength !== undefined && bytes.byteLength !== exactLength) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return bytes;
}

function decodeBase64(value: string, maximumLength: number): Uint8Array {
  if (value.length === 0 || value.length > maximumLength * 2) {
    throw new ProtocolError("invalid_authority", 403);
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
  if (decoded.length === 0 || decoded.length > maximumLength) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeSha256Hex(value: string): Uint8Array {
  if (!SHA256.test(value)) {
    throw new ProtocolError("permit_verifier_unavailable", 503);
  }
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
