export const AUTHORIZATIONS_PATH =
  "/internal/v1/shard-placement/authorizations";
export const PREFLIGHT_PATH =
  "/internal/v1/shard-placement/preflight";
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const HMAC_WINDOW_SECONDS = 60;
export const HMAC_CLOCK_SKEW_SECONDS = 5;
export const PERMIT_CLOCK_SKEW_SECONDS = 120;
export const PERMIT_MIN_REMAINING_SECONDS = 60;

export const ISSUANCE_CONTRACT =
  "cinatoken-relay-shard-placement-mutation-authority-issuance-v1";
export const APPROVAL_CONTRACT =
  "cinatoken-relay-shard-placement-mutation-approval-v1";
export const REVOCATION_CONTRACT =
  "cinatoken-relay-shard-placement-mutation-authority-revocation-v1";
export const PERMIT_CONTRACT =
  "cinatoken-relay-shard-placement-mutation-authorization-v1";

const HMAC_DOMAIN = "cinatoken-shard-placement-authority-v1\n";
const APPROVAL_DOMAIN = `${APPROVAL_CONTRACT}\n`;
const PERMIT_DOMAIN = new TextEncoder().encode(PERMIT_CONTRACT);
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
  0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const APPROVAL_ROLES = [
  "security",
  "operations",
  "release",
  "rollback",
] as const;
const REVOCATION_REASONS = new Set([
  "operator_abort",
  "key_compromise",
  "candidate_retired",
  "evidence_drift",
]);

const PERMIT_FIELDS = [
  "schema_version",
  "contract",
  "issuer",
  "key_id",
  "environment",
  "authorization_id_sha256",
  "execution_nonce_sha256",
  "campaign_id",
  "campaign_nonce_sha256",
  "controller_service_name",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "campaign_lifetime_seconds",
  "issued_at",
  "expires_at",
  "signature_base64url",
] as const;
const UNSIGNED_PERMIT_FIELDS = [
  "schema_version",
  "contract",
  "issuer",
  "key_id",
  "environment",
  "authorization_id_sha256",
  "execution_nonce_sha256",
  "campaign_id",
  "campaign_nonce_sha256",
  "controller_service_name",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "campaign_lifetime_seconds",
  "issued_at",
  "expires_at",
] as const;
const APPROVAL_FIELDS = [
  "schema_version",
  "contract",
  "role",
  "key_id",
  "policy_id",
  "policy_sha256",
  "permit_subject_digest_sha256",
  "authorization_id_sha256",
  "execution_nonce_sha256",
  "campaign_id",
  "controller_version_id",
  "signed_at",
  "expires_at",
  "signature_base64url",
] as const;
const UNSIGNED_APPROVAL_FIELDS = APPROVAL_FIELDS.slice(0, -1);

export type HmacRole =
  | "read"
  | "issue"
  | "revoke"
  | "claim"
  | "receipt"
  | "recovery";
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

export interface ShardPlacementAuthoritySecurityEnv {
  SHARD_PLACEMENT_AUTHORITY_ISSUER: string;
  SHARD_PLACEMENT_AUTHORITY_AUDIENCE: string;
  SHARD_PLACEMENT_AUTHORITY_POLICY_ID: string;
  SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256: string;
  SHARD_PLACEMENT_PERMIT_ISSUER: string;
  SHARD_PLACEMENT_PERMIT_KEY_ID: string;
  SHARD_PLACEMENT_PERMIT_SPKI_BASE64URL?: string;
  SHARD_PLACEMENT_PERMIT_SPKI_SHA256: string;
  SHARD_PLACEMENT_SECURITY_KEY_ID: string;
  SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL?: string;
  SHARD_PLACEMENT_SECURITY_SPKI_SHA256: string;
  SHARD_PLACEMENT_OPERATIONS_KEY_ID: string;
  SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL?: string;
  SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256: string;
  SHARD_PLACEMENT_RELEASE_KEY_ID: string;
  SHARD_PLACEMENT_RELEASE_SPKI_BASE64URL?: string;
  SHARD_PLACEMENT_RELEASE_SPKI_SHA256: string;
  SHARD_PLACEMENT_ROLLBACK_KEY_ID: string;
  SHARD_PLACEMENT_ROLLBACK_SPKI_BASE64URL?: string;
  SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256: string;
  SHARD_PLACEMENT_READ_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_READ_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_READ_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_READ_HMAC_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_KID: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_SECRET?: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_KID: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_SECRET?: string;
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

export interface PlacementPermit {
  schema_version: 1;
  contract: typeof PERMIT_CONTRACT;
  issuer: string;
  key_id: string;
  environment: "staging";
  authorization_id_sha256: string;
  execution_nonce_sha256: string;
  campaign_id: string;
  campaign_nonce_sha256: string;
  controller_service_name: "cinatoken-container-controller-staging";
  controller_version_id: string;
  action_gate_inventory_sha256: string;
  foundation_manifest_sha256: string;
  runtime_build_id: string;
  ring_generation: number;
  shard_count: number;
  campaign_lifetime_seconds: number;
  issued_at: number;
  expires_at: number;
  signature_base64url: string;
}

export interface VerifiedApproval {
  role: ApprovalRole;
  keyId: string;
  spkiSha256: string;
  signedAt: number;
  expiresAt: number;
}

export interface VerifiedIssuance {
  permit: Omit<PlacementPermit, "signature_base64url">;
  permitSubjectDigestSha256: string;
  permitSignerSpkiSha256: string;
  policyId: string;
  policySha256: string;
  issuanceRequestSha256: string;
  approvalsDigestSha256: string;
  approvals: readonly VerifiedApproval[];
}

export interface RevocationRequest {
  schemaVersion: 1;
  contract: typeof REVOCATION_CONTRACT;
  authorizationIdSha256: string;
  permitSubjectDigestSha256: string;
  reasonCode: string;
  evidenceSha256: string;
  revocationEventSha256: string;
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

export async function verifyHmacRequest(
  request: Request,
  body: Uint8Array,
  expectedRole: HmacRole,
  env: ShardPlacementAuthoritySecurityEnv,
  now = Math.floor(Date.now() / 1_000),
): Promise<AuthenticatedRequest> {
  const token = requiredHeader(
    request,
    "x-cinatoken-shard-placement-authority",
    4096,
  );
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
  requireLiteral(header.typ, "CINATOKEN-SHARD-PLACEMENT-AUTHORITY");
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
      new TextEncoder().encode(
        `${HMAC_DOMAIN}${headerPart}.${claimsPart}`,
      ),
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
    role: requireExactRole(value.role),
    credential_id_sha256: requireSha256(value.credential_id_sha256),
    request_id: requireString(value.request_id, IDENTITY),
    method: requireString(value.method, /^[A-Z]+$/),
    path_and_query: requireString(
      value.path_and_query,
      /^\/[^\r\n]{0,2047}$/,
    ),
    body_sha256: requireSha256(value.body_sha256),
    issued_at: requireInteger(value.issued_at, 1, Number.MAX_SAFE_INTEGER),
    expires_at: requireInteger(value.expires_at, 1, Number.MAX_SAFE_INTEGER),
  };
  const url = new URL(request.url);
  const bodySha256 = await sha256Hex(body);
  if (
    claims.issuer !== env.SHARD_PLACEMENT_AUTHORITY_ISSUER
    || claims.audience !== env.SHARD_PLACEMENT_AUTHORITY_AUDIENCE
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

export async function parseIssuanceRequest(
  body: Uint8Array,
  env: ShardPlacementAuthoritySecurityEnv,
  now = Math.floor(Date.now() / 1_000),
): Promise<VerifiedIssuance> {
  const envelope = parseCanonicalObject(body);
  assertExactKeys(envelope, [
    "schema_version",
    "contract",
    "policy_id",
    "policy_sha256",
    "permit",
    "approvals",
  ]);
  requireLiteral(envelope.schema_version, 1);
  requireLiteral(envelope.contract, ISSUANCE_CONTRACT);
  const policyId = requireString(envelope.policy_id, POLICY_ID);
  const policySha256 = requireSha256(envelope.policy_sha256);
  if (
    policyId !== env.SHARD_PLACEMENT_AUTHORITY_POLICY_ID
    || policySha256 !== env.SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256
  ) {
    throw new ProtocolError("policy_mismatch", 403);
  }

  const permit = parsePermit(requireObject(envelope.permit));
  const permitVerification = await verifyPermit(permit, env, now);
  const rawApprovals = requireArray(envelope.approvals);
  if (rawApprovals.length !== APPROVAL_ROLES.length) {
    throw new ProtocolError("approval_inventory_invalid", 403);
  }
  const approvals: VerifiedApproval[] = [];
  const keyIds = new Set<string>();
  const fingerprints = new Set<string>([
    permitVerification.signerSpkiSha256,
  ]);
  for (let index = 0; index < APPROVAL_ROLES.length; index += 1) {
    const role = APPROVAL_ROLES[index]!;
    const verified = await verifyApproval({
      value: requireObject(rawApprovals[index]),
      expectedRole: role,
      permit,
      permitSubjectDigestSha256:
        permitVerification.subjectDigestSha256,
      policyId,
      policySha256,
      env,
      now,
    });
    if (
      keyIds.has(verified.keyId)
      || fingerprints.has(verified.spkiSha256)
    ) {
      throw new ProtocolError("approval_key_isolation_invalid", 403);
    }
    keyIds.add(verified.keyId);
    fingerprints.add(verified.spkiSha256);
    approvals.push(verified);
  }
  return {
    permit: selectFields(
      permit as unknown as Record<string, unknown>,
      UNSIGNED_PERMIT_FIELDS,
    ) as unknown as Omit<PlacementPermit, "signature_base64url">,
    permitSubjectDigestSha256:
      permitVerification.subjectDigestSha256,
    permitSignerSpkiSha256: permitVerification.signerSpkiSha256,
    policyId,
    policySha256,
    issuanceRequestSha256: await sha256Hex(body),
    approvalsDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(rawApprovals)),
    ),
    approvals,
  };
}

export async function parseRevocationRequest(
  body: Uint8Array,
): Promise<RevocationRequest> {
  const value = parseCanonicalObject(body);
  assertExactKeys(value, [
    "schemaVersion",
    "contract",
    "authorizationIdSha256",
    "permitSubjectDigestSha256",
    "reasonCode",
    "evidenceSha256",
    "revocationEventSha256",
  ]);
  const request: RevocationRequest = {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(value.contract, REVOCATION_CONTRACT),
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    permitSubjectDigestSha256: requireSha256(
      value.permitSubjectDigestSha256,
    ),
    reasonCode: requireSetString(value.reasonCode, REVOCATION_REASONS),
    evidenceSha256: requireSha256(value.evidenceSha256),
    revocationEventSha256: requireSha256(value.revocationEventSha256),
  };
  const copy = { ...request };
  delete (copy as Partial<RevocationRequest>).revocationEventSha256;
  if (
    request.revocationEventSha256
    !== await sha256Hex(
      new TextEncoder().encode(canonicalJson(copy)),
    )
  ) {
    throw new ProtocolError("revocation_digest_mismatch", 400);
  }
  return request;
}

export function parseExactAuthorizationQuery(url: URL): {
  permitSubjectDigestSha256: string;
  campaignId: string;
} {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2
    || entries[0]?.[0] !== "permitSubjectDigestSha256"
    || entries[1]?.[0] !== "campaignId"
  ) {
    throw new ProtocolError("invalid_query", 400);
  }
  return {
    permitSubjectDigestSha256: requireSha256(entries[0]![1]),
    campaignId: requireSha256(entries[1]![1]),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
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
        typ: "CINATOKEN-SHARD-PLACEMENT-AUTHORITY",
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
      toArrayBuffer(
        new TextEncoder().encode(
          `${HMAC_DOMAIN}${headerPart}.${claimsPart}`,
        ),
      ),
    ),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export function encodePermitMessage(
  permit: Omit<PlacementPermit, "signature_base64url">,
): Uint8Array {
  const parts: Uint8Array[] = [PERMIT_DOMAIN];
  for (const field of UNSIGNED_PERMIT_FIELDS) {
    const value = new TextEncoder().encode(String(permit[field]));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, value.byteLength, false);
    parts.push(length, value);
  }
  return concatenate(parts);
}

export function approvalMessage(
  approval: Record<string, unknown>,
): Uint8Array {
  return new TextEncoder().encode(
    `${APPROVAL_DOMAIN}${canonicalJson(approval)}`,
  );
}

async function verifyPermit(
  permit: PlacementPermit,
  env: ShardPlacementAuthoritySecurityEnv,
  now: number,
): Promise<{
  subjectDigestSha256: string;
  signerSpkiSha256: string;
}> {
  if (
    permit.issuer !== env.SHARD_PLACEMENT_PERMIT_ISSUER
    || permit.key_id !== env.SHARD_PLACEMENT_PERMIT_KEY_ID
  ) {
    throw new ProtocolError("permit_trust_mismatch", 403);
  }
  if (
    permit.issued_at > now + PERMIT_CLOCK_SKEW_SECONDS
    || permit.expires_at < now + PERMIT_MIN_REMAINING_SECONDS
    || permit.expires_at < permit.issued_at + 60
    || permit.expires_at > permit.issued_at + 600
  ) {
    throw new ProtocolError("permit_time_window", 403);
  }
  const unsigned = selectFields(
    permit as unknown as Record<string, unknown>,
    UNSIGNED_PERMIT_FIELDS,
  ) as unknown as Omit<
    PlacementPermit,
    "signature_base64url"
  >;
  const message = encodePermitMessage(unsigned);
  const key = await importPinnedEd25519Key(
    env.SHARD_PLACEMENT_PERMIT_SPKI_BASE64URL,
    env.SHARD_PLACEMENT_PERMIT_SPKI_SHA256,
    "permit",
  );
  const signature = decodeBase64Url(
    permit.signature_base64url,
    64,
    64,
  );
  if (
    !await crypto.subtle.verify(
      "Ed25519",
      key.key,
      toArrayBuffer(signature),
      toArrayBuffer(message),
    )
  ) {
    throw new ProtocolError("invalid_permit", 403);
  }
  return {
    subjectDigestSha256: await sha256Hex(message),
    signerSpkiSha256: key.fingerprint,
  };
}

async function verifyApproval({
  value,
  expectedRole,
  permit,
  permitSubjectDigestSha256,
  policyId,
  policySha256,
  env,
  now,
}: {
  value: Record<string, unknown>;
  expectedRole: ApprovalRole;
  permit: PlacementPermit;
  permitSubjectDigestSha256: string;
  policyId: string;
  policySha256: string;
  env: ShardPlacementAuthoritySecurityEnv;
  now: number;
}): Promise<VerifiedApproval> {
  assertExactKeys(value, APPROVAL_FIELDS);
  const parsed = {
    schema_version: requireLiteral(value.schema_version, 1),
    contract: requireLiteral(value.contract, APPROVAL_CONTRACT),
    role: requireExactApprovalRole(value.role, expectedRole),
    key_id: requireString(value.key_id, KEY_ID),
    policy_id: requireString(value.policy_id, POLICY_ID),
    policy_sha256: requireSha256(value.policy_sha256),
    permit_subject_digest_sha256: requireSha256(
      value.permit_subject_digest_sha256,
    ),
    authorization_id_sha256: requireSha256(
      value.authorization_id_sha256,
    ),
    execution_nonce_sha256: requireSha256(
      value.execution_nonce_sha256,
    ),
    campaign_id: requireSha256(value.campaign_id),
    controller_version_id: requireString(
      value.controller_version_id,
      VERSION_ID,
    ),
    signed_at: requireInteger(value.signed_at, 1, Number.MAX_SAFE_INTEGER),
    expires_at: requireInteger(value.expires_at, 1, Number.MAX_SAFE_INTEGER),
    signature_base64url: requireCanonicalBase64Url(
      value.signature_base64url,
      64,
    ),
  };
  if (
    parsed.policy_id !== policyId
    || parsed.policy_sha256 !== policySha256
    || parsed.permit_subject_digest_sha256
      !== permitSubjectDigestSha256
    || parsed.authorization_id_sha256
      !== permit.authorization_id_sha256
    || parsed.execution_nonce_sha256
      !== permit.execution_nonce_sha256
    || parsed.campaign_id !== permit.campaign_id
    || parsed.controller_version_id
      !== permit.controller_version_id
  ) {
    throw new ProtocolError("approval_subject_mismatch", 403);
  }
  if (
    parsed.signed_at < permit.issued_at - PERMIT_CLOCK_SKEW_SECONDS
    || parsed.signed_at > now + PERMIT_CLOCK_SKEW_SECONDS
    || parsed.signed_at >= parsed.expires_at
    || parsed.expires_at < permit.expires_at
  ) {
    throw new ProtocolError("approval_time_window", 403);
  }
  const trust = approvalTrust(expectedRole, env);
  if (parsed.key_id !== trust.keyId) {
    throw new ProtocolError("approval_trust_mismatch", 403);
  }
  const key = await importPinnedEd25519Key(
    trust.spkiBase64url,
    trust.spkiSha256,
    `approval_${expectedRole}`,
  );
  const unsigned = selectFields(parsed, UNSIGNED_APPROVAL_FIELDS);
  const signature = decodeBase64Url(
    parsed.signature_base64url,
    64,
    64,
  );
  if (
    !await crypto.subtle.verify(
      "Ed25519",
      key.key,
      toArrayBuffer(signature),
      toArrayBuffer(approvalMessage(unsigned)),
    )
  ) {
    throw new ProtocolError("invalid_approval", 403);
  }
  return {
    role: expectedRole,
    keyId: parsed.key_id,
    spkiSha256: key.fingerprint,
    signedAt: parsed.signed_at,
    expiresAt: parsed.expires_at,
  };
}

function parsePermit(value: Record<string, unknown>): PlacementPermit {
  assertExactKeys(value, PERMIT_FIELDS);
  const permit: PlacementPermit = {
    schema_version: requireLiteral(value.schema_version, 1),
    contract: requireLiteral(value.contract, PERMIT_CONTRACT),
    issuer: requireString(value.issuer, IDENTITY),
    key_id: requireString(value.key_id, KEY_ID),
    environment: requireLiteral(value.environment, "staging"),
    authorization_id_sha256: requireSha256(
      value.authorization_id_sha256,
    ),
    execution_nonce_sha256: requireSha256(
      value.execution_nonce_sha256,
    ),
    campaign_id: requireSha256(value.campaign_id),
    campaign_nonce_sha256: requireSha256(
      value.campaign_nonce_sha256,
    ),
    controller_service_name: requireLiteral(
      value.controller_service_name,
      "cinatoken-container-controller-staging",
    ),
    controller_version_id: requireString(
      value.controller_version_id,
      VERSION_ID,
    ),
    action_gate_inventory_sha256: requireSha256(
      value.action_gate_inventory_sha256,
    ),
    foundation_manifest_sha256: requireSha256(
      value.foundation_manifest_sha256,
    ),
    runtime_build_id: requireSha256(value.runtime_build_id),
    ring_generation: requireInteger(
      value.ring_generation,
      1,
      1_000_000,
    ),
    shard_count: requireInteger(value.shard_count, 1, 1_024),
    campaign_lifetime_seconds: requireInteger(
      value.campaign_lifetime_seconds,
      60,
      3_600,
    ),
    issued_at: requireInteger(value.issued_at, 1, Number.MAX_SAFE_INTEGER),
    expires_at: requireInteger(value.expires_at, 1, Number.MAX_SAFE_INTEGER),
    signature_base64url: requireCanonicalBase64Url(
      value.signature_base64url,
      64,
    ),
  };
  if (
    permit.authorization_id_sha256 === permit.execution_nonce_sha256
    || permit.authorization_id_sha256 === permit.campaign_nonce_sha256
    || permit.execution_nonce_sha256 === permit.campaign_nonce_sha256
  ) {
    throw new ProtocolError("permit_replay_identity_collision", 400);
  }
  return permit;
}

async function importPinnedEd25519Key(
  spkiBase64url: string | undefined,
  expectedFingerprint: string,
  label: string,
): Promise<{ key: CryptoKey; fingerprint: string }> {
  if (
    typeof spkiBase64url !== "string"
    || !SHA256.test(expectedFingerprint)
  ) {
    throw new ProtocolError(`${label}_verifier_unavailable`, 503);
  }
  const spki = decodeBase64Url(
    spkiBase64url,
    ED25519_SPKI_PREFIX.byteLength + 32,
    ED25519_SPKI_PREFIX.byteLength + 32,
  );
  if (
    !spki
      .subarray(0, ED25519_SPKI_PREFIX.byteLength)
      .every((byte, index) => byte === ED25519_SPKI_PREFIX[index])
  ) {
    throw new ProtocolError(`${label}_verifier_unavailable`, 503);
  }
  const fingerprint = await sha256Hex(spki);
  if (!constantTimeHexEqual(fingerprint, expectedFingerprint)) {
    throw new ProtocolError(`${label}_verifier_unavailable`, 503);
  }
  try {
    return {
      key: await crypto.subtle.importKey(
        "spki",
        toArrayBuffer(spki),
        { name: "Ed25519" },
        false,
        ["verify"],
      ),
      fingerprint,
    };
  } catch {
    throw new ProtocolError(`${label}_verifier_unavailable`, 503);
  }
}

function approvalTrust(
  role: ApprovalRole,
  env: ShardPlacementAuthoritySecurityEnv,
): {
  keyId: string;
  spkiBase64url: string | undefined;
  spkiSha256: string;
} {
  if (role === "security") {
    return {
      keyId: env.SHARD_PLACEMENT_SECURITY_KEY_ID,
      spkiBase64url: env.SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL,
      spkiSha256: env.SHARD_PLACEMENT_SECURITY_SPKI_SHA256,
    };
  }
  if (role === "operations") {
    return {
      keyId: env.SHARD_PLACEMENT_OPERATIONS_KEY_ID,
      spkiBase64url: env.SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL,
      spkiSha256: env.SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256,
    };
  }
  if (role === "release") {
    return {
      keyId: env.SHARD_PLACEMENT_RELEASE_KEY_ID,
      spkiBase64url: env.SHARD_PLACEMENT_RELEASE_SPKI_BASE64URL,
      spkiSha256: env.SHARD_PLACEMENT_RELEASE_SPKI_SHA256,
    };
  }
  return {
    keyId: env.SHARD_PLACEMENT_ROLLBACK_KEY_ID,
    spkiBase64url: env.SHARD_PLACEMENT_ROLLBACK_SPKI_BASE64URL,
    spkiSha256: env.SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256,
  };
}

function selectHmacKey(
  role: HmacRole,
  keyId: string,
  env: ShardPlacementAuthoritySecurityEnv,
): { secret: string; credentialIdSha256: string } {
  const prefix =
    role === "read"
      ? "SHARD_PLACEMENT_READ_HMAC"
      : role === "issue"
        ? "SHARD_PLACEMENT_ISSUE_HMAC"
        : role === "revoke"
          ? "SHARD_PLACEMENT_REVOKE_HMAC"
          : role === "claim"
            ? "SHARD_PLACEMENT_CLAIM_HMAC"
            : role === "receipt"
              ? "SHARD_PLACEMENT_RECEIPT_HMAC"
              : "SHARD_PLACEMENT_RECOVERY_HMAC";
  const values = env as unknown as Record<string, string | undefined>;
  let secret: string | undefined;
  let credentialIdSha256 = "";
  let matched = false;
  if (keyId === values[`${prefix}_CURRENT_KID`]) {
    matched = true;
    secret = values[`${prefix}_CURRENT_SECRET`];
    credentialIdSha256 =
      values[`${prefix}_CURRENT_CREDENTIAL_ID_SHA256`] ?? "";
  } else if (
    (values[`${prefix}_PREVIOUS_KID`] ?? "").length > 0
    && keyId === values[`${prefix}_PREVIOUS_KID`]
  ) {
    matched = true;
    secret = values[`${prefix}_PREVIOUS_SECRET`];
    credentialIdSha256 =
      values[`${prefix}_PREVIOUS_CREDENTIAL_ID_SHA256`] ?? "";
  }
  if (!matched) throw new ProtocolError("invalid_authority", 403);
  if (
    typeof secret !== "string"
    || secret.length < 32
    || secret.length > 256
    || !SHA256.test(credentialIdSha256)
  ) {
    throw new ProtocolError("authority_verifier_unavailable", 503);
  }
  return { secret, credentialIdSha256 };
}

function parseCanonicalObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", 400);
  }
  const object = requireObject(value);
  if (canonicalJson(object) !== text) {
    throw new ProtocolError("noncanonical_json", 400);
  }
  return object;
}

function parseDecodedObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    return requireObject(
      JSON.parse(
        new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes),
      ),
    );
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
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

function requiredHeader(
  request: Request,
  name: string,
  maximumLength: number,
): string {
  const value = request.headers.get(name);
  if (
    value === null
    || value.length === 0
    || value.length > maximumLength
    || /[\r\n]/.test(value)
  ) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ProtocolError("invalid_shape", 400);
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError("invalid_shape", 400);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) throw new ProtocolError("invalid_value", 400);
  return expected;
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

function requireSetString(
  value: unknown,
  accepted: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || !accepted.has(value)) {
    throw new ProtocolError("invalid_value", 400);
  }
  return value;
}

function requireExactRole(value: unknown): HmacRole {
  if (
    value === "read"
    || value === "issue"
    || value === "revoke"
    || value === "claim"
    || value === "receipt"
    || value === "recovery"
  ) {
    return value;
  }
  throw new ProtocolError("invalid_authority", 403);
}

function requireExactApprovalRole(
  value: unknown,
  expected: ApprovalRole,
): ApprovalRole {
  if (value !== expected) {
    throw new ProtocolError("approval_role_order_invalid", 403);
  }
  return expected;
}

function requireCanonicalBase64Url(
  value: unknown,
  expectedBytes: number,
): string {
  const text = requireString(value, BASE64URL);
  const decoded = decodeBase64Url(text, expectedBytes, expectedBytes);
  if (encodeBase64Url(decoded) !== text) {
    throw new ProtocolError("invalid_base64url", 400);
  }
  return text;
}

function decodeBase64Url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (
    !BASE64URL.test(value)
    || value.includes("=")
    || value.length > Math.ceil(maximumBytes * 4 / 3)
  ) {
    throw new ProtocolError("invalid_base64url", 400);
  }
  try {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(`${normalized}${padding}`);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0));
    if (
      bytes.byteLength > maximumBytes
      || (exactBytes !== undefined && bytes.byteLength !== exactBytes)
      || encodeBase64Url(bytes) !== value
    ) {
      throw new Error("invalid");
    }
    return bytes;
  } catch {
    throw new ProtocolError("invalid_base64url", 400);
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function selectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields) selected[field] = value[field];
  return selected;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
