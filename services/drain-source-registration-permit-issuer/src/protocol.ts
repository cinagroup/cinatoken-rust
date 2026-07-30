export const PERMITS_PATH = "/internal/v1/drain-source-registration/permits";
export const MAX_JSON_BODY_BYTES = 16 * 1024;
export const HMAC_WINDOW_SECONDS = 60;
export const CLOCK_SKEW_SECONDS = 5;
export const PERMIT_MAX_LIFETIME_SECONDS = 30;
export const PERMIT_MIN_LIFETIME_SECONDS = 5;

export const SUBJECT_CONTRACT =
  "relay-container-drain-source-registration-permit-v1";
export const ENVELOPE_CONTRACT =
  "relay-container-drain-source-registration-permit-envelope-v1";
export const SUBJECT_DOMAIN =
  "cinatoken-relay-container-drain-source-registration-permit-v1";
export const ENVELOPE_DIGEST_DOMAIN =
  "cinatoken-relay-container-drain-source-registration-permit-envelope-v1";
export const PERMIT_ID_DOMAIN =
  "cinatoken-relay-container-drain-source-registration-permit-id-v1";

const HMAC_DOMAIN =
  "cinatoken-drain-source-registration-permit-issuer-authority-v1\n";
const HMAC_HEADER_TYPE = "CINATOKEN-DRAIN-SOURCE-REGISTRATION-PERMIT-ISSUER";
const ACTION = "relay_container.drain_source_authorization_register";
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_AND_QUERY = /^\/[^\r\n]{0,2047}$/;
const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAXIMUM_PREVIOUS_USE_GENERATION = MAXIMUM_SAFE_INTEGER - 1;
const MAXIMUM_SIGN_COUNT = 0xffff_ffff;
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export const SUBJECT_FIELDS = Object.freeze([
  "schemaVersion",
  "contract",
  "issuer",
  "audience",
  "keyId",
  "signerIdentitySha256",
  "signerSpkiSha256",
  "environment",
  "action",
  "authorizationIdSha256",
  "authorizationSubjectSha256",
  "authorizationSignatureEnvelopeSha256",
  "actionSubjectSha256",
  "actionDigestSha256",
  "registrationRequestSha256",
  "adminAuditDigestSha256",
  "adminNetworkIdentityHmacSha256",
  "changeTicketSha256",
  "rootAdminId",
  "rootSessionEpoch",
  "rootSessionIssuedAt",
  "rootSessionExpiresAt",
  "rootSessionBindingSha256",
  "passkeyCredentialRowId",
  "passkeyCredentialIdSha256",
  "passkeyCredentialRegistrationIdSha256",
  "passkeyCredentialBindingSha256",
  "passkeyPreviousUseGeneration",
  "passkeyAssertionSubjectSha256",
  "passkeyAssertionSignatureSha256",
  "secureVerificationChallengeSha256",
  "passkeyPreviousSignCount",
  "passkeySignCount",
  "passkeyUserPresent",
  "passkeyUserVerified",
  "passkeyBackupEligible",
  "passkeyBackupState",
  "registeredByServiceName",
  "registeredByVersionId",
  "registrationExecutionIdSha256",
  "registrationCredentialIdSha256",
  "authorityLedgerIdentitySha256",
  "receiptSequence",
  "ledgerHeadBeforeSha256",
  "verificationExpiresAt",
  "permitIdSha256",
  "verifiedAt",
  "issuedAt",
  "expiresAt",
] as const);

export const REQUEST_FIELDS = Object.freeze([
  "environment",
  "action",
  "authorizationIdSha256",
  "authorizationSubjectSha256",
  "authorizationSignatureEnvelopeSha256",
  "actionSubjectSha256",
  "actionDigestSha256",
  "registrationRequestSha256",
  "adminAuditDigestSha256",
  "adminNetworkIdentityHmacSha256",
  "changeTicketSha256",
  "rootAdminId",
  "rootSessionEpoch",
  "rootSessionIssuedAt",
  "rootSessionExpiresAt",
  "rootSessionBindingSha256",
  "passkeyCredentialRowId",
  "passkeyCredentialIdSha256",
  "passkeyCredentialRegistrationIdSha256",
  "passkeyCredentialBindingSha256",
  "passkeyPreviousUseGeneration",
  "passkeyAssertionSubjectSha256",
  "passkeyAssertionSignatureSha256",
  "secureVerificationChallengeSha256",
  "passkeyPreviousSignCount",
  "passkeySignCount",
  "passkeyUserPresent",
  "passkeyUserVerified",
  "passkeyBackupEligible",
  "passkeyBackupState",
  "registeredByServiceName",
  "registeredByVersionId",
  "registrationExecutionIdSha256",
  "registrationCredentialIdSha256",
  "authorityLedgerIdentitySha256",
  "receiptSequence",
  "ledgerHeadBeforeSha256",
  "verificationExpiresAt",
  "verifiedAt",
] as const);

interface IssuerSecrets {
  DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET?: string;
  DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET?: string;
  DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL?: string;
  DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL?: string;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type IssuerEnv =
  WidenGeneratedStringBindings<DrainSourceRegistrationPermitIssuerEnv> &
    IssuerSecrets;

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

export interface AuthenticatedRequest {
  credentialIdSha256: string;
  keyId: string;
  bodySha256: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RegistrationPermitSubject {
  schemaVersion: 1;
  contract: typeof SUBJECT_CONTRACT;
  issuer: string;
  audience: string;
  keyId: string;
  signerIdentitySha256: string;
  signerSpkiSha256: string;
  environment: string;
  action: typeof ACTION;
  authorizationIdSha256: string;
  authorizationSubjectSha256: string;
  authorizationSignatureEnvelopeSha256: string;
  actionSubjectSha256: string;
  actionDigestSha256: string;
  registrationRequestSha256: string;
  adminAuditDigestSha256: string;
  adminNetworkIdentityHmacSha256: string;
  changeTicketSha256: string;
  rootAdminId: number;
  rootSessionEpoch: number;
  rootSessionIssuedAt: number;
  rootSessionExpiresAt: number;
  rootSessionBindingSha256: string;
  passkeyCredentialRowId: number;
  passkeyCredentialIdSha256: string;
  passkeyCredentialRegistrationIdSha256: string;
  passkeyCredentialBindingSha256: string;
  passkeyPreviousUseGeneration: number;
  passkeyAssertionSubjectSha256: string;
  passkeyAssertionSignatureSha256: string;
  secureVerificationChallengeSha256: string;
  passkeyPreviousSignCount: number;
  passkeySignCount: number;
  passkeyUserPresent: boolean;
  passkeyUserVerified: boolean;
  passkeyBackupEligible: boolean;
  passkeyBackupState: boolean;
  registeredByServiceName: string;
  registeredByVersionId: string;
  registrationExecutionIdSha256: string;
  registrationCredentialIdSha256: string;
  authorityLedgerIdentitySha256: string;
  receiptSequence: number;
  ledgerHeadBeforeSha256: string;
  verificationExpiresAt: number;
  permitIdSha256: string;
  verifiedAt: number;
  issuedAt: number;
  expiresAt: number;
}

export type RegistrationPermitBindings = Pick<
  RegistrationPermitSubject,
  (typeof REQUEST_FIELDS)[number]
>;

export interface RegistrationPermitEnvelope {
  schemaVersion: 1;
  contract: typeof ENVELOPE_CONTRACT;
  algorithm: "Ed25519";
  subject: RegistrationPermitSubject;
  subjectSha256: string;
  signatureBase64url: string;
}

export interface IssuedRegistrationPermit {
  envelope: RegistrationPermitEnvelope;
  subjectSha256: string;
  signatureEnvelopeSha256: string;
}

interface SigningConfiguration {
  issuer: string;
  audience: string;
  keyId: string;
  signerIdentitySha256: string;
  signerSpkiSha256: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
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
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ProtocolError("invalid_content_type", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_JSON_BODY_BYTES)
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
  if (total === 0) throw new ProtocolError("invalid_json", 400);

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function verifyHmacRequest(
  request: Request,
  body: Uint8Array,
  env: IssuerEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedRequest> {
  validateHmacConfiguration(env);
  const token = requiredHeader(
    request,
    "x-cinatoken-drain-source-registration-issuer",
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
  const header = parseAuthorityObject(headerPart, 1024);
  assertAuthorityKeys(header, ["typ", "alg", "kid"]);
  if (header.typ !== HMAC_HEADER_TYPE || header.alg !== "HS256") {
    throw new ProtocolError("invalid_authority", 403);
  }
  const keyId = authorityString(header.kid, KEY_ID);
  const selected = selectHmacKey(keyId, env);
  const signature = decodeBase64Url(
    signaturePart,
    32,
    32,
    "invalid_authority",
    403,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(selected.secret)),
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
  if (!valid) throw new ProtocolError("invalid_authority", 403);

  const value = parseAuthorityObject(claimsPart, 4096);
  assertAuthorityKeys(value, [
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
    issuer: authorityString(value.issuer, IDENTIFIER),
    audience: authorityString(value.audience, IDENTIFIER),
    credential_id_sha256: authoritySha256(value.credential_id_sha256),
    request_id: authorityString(value.request_id, REQUEST_ID),
    method: authorityString(value.method, /^[A-Z]+$/),
    path_and_query: authorityString(value.path_and_query, PATH_AND_QUERY),
    body_sha256: authoritySha256(value.body_sha256),
    issued_at: authorityInteger(value.issued_at),
    expires_at: authorityInteger(value.expires_at),
  };
  const url = new URL(request.url);
  const bodySha256 = await sha256Hex(body);
  if (
    claims.issuer !== env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER ||
    claims.audience !== env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE ||
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
    issuedAt: claims.issued_at,
    expiresAt: claims.expires_at,
  };
}

export async function issueRegistrationPermit(
  body: Uint8Array,
  authentication: AuthenticatedRequest,
  env: IssuerEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<IssuedRegistrationPermit> {
  const configuration = await loadSigningConfiguration(env);
  const bindings = parseRegistrationBindings(body);
  const bodySha256 = await sha256Hex(body);
  if (
    !REQUEST_ID.test(authentication.requestId) ||
    !KEY_ID.test(authentication.keyId) ||
    !SHA256.test(authentication.credentialIdSha256) ||
    !SHA256.test(authentication.bodySha256) ||
    authentication.bodySha256 !== bodySha256 ||
    authentication.issuedAt > now + CLOCK_SKEW_SECONDS ||
    now - authentication.issuedAt > HMAC_WINDOW_SECONDS ||
    authentication.expiresAt <= now ||
    authentication.expiresAt <= authentication.issuedAt ||
    authentication.expiresAt - authentication.issuedAt > HMAC_WINDOW_SECONDS ||
    bindings.environment !== env.ENVIRONMENT ||
    bindings.registrationCredentialIdSha256 !==
      authentication.credentialIdSha256
  ) {
    throw new ProtocolError("registration_binding_mismatch", 403);
  }
  if (
    authentication.issuedAt < bindings.verifiedAt ||
    authentication.issuedAt - bindings.verifiedAt > CLOCK_SKEW_SECONDS
  ) {
    throw new ProtocolError("registration_verification_time_window", 403);
  }
  const issuedAt = authentication.issuedAt;
  const expiresAt = Math.min(
    issuedAt + PERMIT_MAX_LIFETIME_SECONDS,
    bindings.verificationExpiresAt,
    authentication.expiresAt,
  );
  if (expiresAt - issuedAt < PERMIT_MIN_LIFETIME_SECONDS || expiresAt <= now) {
    throw new ProtocolError(
      "registration_verification_window_unavailable",
      403,
    );
  }
  const permitIdSha256 = await derivePermitIdSha256(
    authentication.requestId,
    bindings.actionSubjectSha256,
    bindings.passkeyAssertionSignatureSha256,
    bindings.secureVerificationChallengeSha256,
    issuedAt,
    expiresAt,
  );
  const { verifiedAt, ...bindingsBeforePermitId } = bindings;
  const subject: RegistrationPermitSubject = {
    schemaVersion: 1,
    contract: SUBJECT_CONTRACT,
    issuer: configuration.issuer,
    audience: configuration.audience,
    keyId: configuration.keyId,
    signerIdentitySha256: configuration.signerIdentitySha256,
    signerSpkiSha256: configuration.signerSpkiSha256,
    ...bindingsBeforePermitId,
    permitIdSha256,
    verifiedAt,
    issuedAt,
    expiresAt,
  };
  const message = encodePermitSubject(subject);
  const subjectSha256 = await permitSubjectSha256(subject);
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        configuration.privateKey,
        toArrayBuffer(message),
      ),
    );
  } catch {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  if (signature.byteLength !== 64) {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  const verified = await crypto.subtle.verify(
    "Ed25519",
    configuration.publicKey,
    toArrayBuffer(signature),
    toArrayBuffer(message),
  );
  if (!verified) throw new ProtocolError("issuer_unavailable", 503);

  const signatureBase64url = encodeBase64Url(signature);
  const envelope: RegistrationPermitEnvelope = {
    schemaVersion: 1,
    contract: ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject,
    subjectSha256,
    signatureBase64url,
  };
  const signatureEnvelopeSha256 = await permitSignatureEnvelopeSha256(envelope);
  return { envelope, subjectSha256, signatureEnvelopeSha256 };
}

export function parseRegistrationBindings(
  body: Uint8Array,
): RegistrationPermitBindings {
  const value = parseCanonicalRequestObject(body);
  assertExactKeys(value, REQUEST_FIELDS);
  const bindings: RegistrationPermitBindings = {
    environment: requireString(value.environment, /^(?:local|staging)$/),
    action: requireLiteral(value.action, ACTION),
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    authorizationSubjectSha256: requireSha256(value.authorizationSubjectSha256),
    authorizationSignatureEnvelopeSha256: requireSha256(
      value.authorizationSignatureEnvelopeSha256,
    ),
    actionSubjectSha256: requireSha256(value.actionSubjectSha256),
    actionDigestSha256: requireSha256(value.actionDigestSha256),
    registrationRequestSha256: requireSha256(value.registrationRequestSha256),
    adminAuditDigestSha256: requireSha256(value.adminAuditDigestSha256),
    adminNetworkIdentityHmacSha256: requireSha256(
      value.adminNetworkIdentityHmacSha256,
    ),
    changeTicketSha256: requireSha256(value.changeTicketSha256),
    rootAdminId: requireInteger(value.rootAdminId, 1, MAXIMUM_SAFE_INTEGER),
    rootSessionEpoch: requireInteger(
      value.rootSessionEpoch,
      0,
      MAXIMUM_SAFE_INTEGER,
    ),
    rootSessionIssuedAt: requireInteger(
      value.rootSessionIssuedAt,
      1,
      MAXIMUM_SAFE_INTEGER,
    ),
    rootSessionExpiresAt: requireInteger(
      value.rootSessionExpiresAt,
      1,
      MAXIMUM_SAFE_INTEGER,
    ),
    rootSessionBindingSha256: requireSha256(value.rootSessionBindingSha256),
    passkeyCredentialRowId: requireInteger(
      value.passkeyCredentialRowId,
      1,
      MAXIMUM_SAFE_INTEGER,
    ),
    passkeyCredentialIdSha256: requireSha256(value.passkeyCredentialIdSha256),
    passkeyCredentialRegistrationIdSha256: requireSha256(
      value.passkeyCredentialRegistrationIdSha256,
    ),
    passkeyCredentialBindingSha256: requireSha256(
      value.passkeyCredentialBindingSha256,
    ),
    passkeyPreviousUseGeneration: requireInteger(
      value.passkeyPreviousUseGeneration,
      0,
      MAXIMUM_PREVIOUS_USE_GENERATION,
    ),
    passkeyAssertionSubjectSha256: requireSha256(
      value.passkeyAssertionSubjectSha256,
    ),
    passkeyAssertionSignatureSha256: requireSha256(
      value.passkeyAssertionSignatureSha256,
    ),
    secureVerificationChallengeSha256: requireSha256(
      value.secureVerificationChallengeSha256,
    ),
    passkeyPreviousSignCount: requireInteger(
      value.passkeyPreviousSignCount,
      0,
      MAXIMUM_SIGN_COUNT,
    ),
    passkeySignCount: requireInteger(
      value.passkeySignCount,
      0,
      MAXIMUM_SIGN_COUNT,
    ),
    passkeyUserPresent: requireBoolean(value.passkeyUserPresent),
    passkeyUserVerified: requireBoolean(value.passkeyUserVerified),
    passkeyBackupEligible: requireBoolean(value.passkeyBackupEligible),
    passkeyBackupState: requireBoolean(value.passkeyBackupState),
    registeredByServiceName: requireString(
      value.registeredByServiceName,
      SERVICE_NAME,
    ),
    registeredByVersionId: requireString(
      value.registeredByVersionId,
      VERSION_ID,
    ),
    registrationExecutionIdSha256: requireSha256(
      value.registrationExecutionIdSha256,
    ),
    registrationCredentialIdSha256: requireSha256(
      value.registrationCredentialIdSha256,
    ),
    authorityLedgerIdentitySha256: requireSha256(
      value.authorityLedgerIdentitySha256,
    ),
    receiptSequence: requireInteger(value.receiptSequence, 1, 1_000_000),
    ledgerHeadBeforeSha256: requireSha256(value.ledgerHeadBeforeSha256),
    verificationExpiresAt: requireInteger(
      value.verificationExpiresAt,
      1,
      MAXIMUM_SAFE_INTEGER,
    ),
    verifiedAt: requireInteger(value.verifiedAt, 1, MAXIMUM_SAFE_INTEGER),
  };
  if (
    !bindings.passkeyUserPresent ||
    !bindings.passkeyUserVerified ||
    (bindings.passkeyBackupState && !bindings.passkeyBackupEligible) ||
    bindings.rootSessionIssuedAt < bindings.rootSessionEpoch ||
    bindings.rootSessionExpiresAt <= bindings.rootSessionIssuedAt ||
    bindings.verifiedAt < bindings.rootSessionIssuedAt ||
    bindings.verificationExpiresAt > bindings.rootSessionExpiresAt ||
    bindings.authorizationSubjectSha256 ===
      bindings.authorizationSignatureEnvelopeSha256 ||
    bindings.rootSessionBindingSha256 === bindings.passkeyCredentialIdSha256 ||
    bindings.passkeyCredentialIdSha256 ===
      bindings.passkeyCredentialRegistrationIdSha256 ||
    bindings.passkeyCredentialIdSha256 ===
      bindings.passkeyCredentialBindingSha256 ||
    bindings.passkeyCredentialRegistrationIdSha256 ===
      bindings.passkeyCredentialBindingSha256 ||
    bindings.actionDigestSha256 === bindings.registrationRequestSha256 ||
    bindings.actionDigestSha256 === bindings.adminAuditDigestSha256 ||
    bindings.registrationRequestSha256 === bindings.adminAuditDigestSha256 ||
    bindings.registrationExecutionIdSha256 ===
      bindings.registrationCredentialIdSha256 ||
    bindings.passkeyAssertionSubjectSha256 ===
      bindings.passkeyAssertionSignatureSha256 ||
    !(
      (bindings.passkeyPreviousSignCount === 0 &&
        bindings.passkeySignCount === 0) ||
      bindings.passkeySignCount > bindings.passkeyPreviousSignCount
    )
  ) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return bindings;
}

export function encodePermitSubject(
  subject: RegistrationPermitSubject,
): Uint8Array {
  return encodeLengthPrefixedMessage(
    SUBJECT_DOMAIN,
    SUBJECT_FIELDS.map((field) => canonicalFieldValue(subject[field])),
  );
}

export async function permitSubjectSha256(
  subject: RegistrationPermitSubject,
): Promise<string> {
  return sha256Hex(encodePermitSubject(subject));
}

export async function permitSignatureEnvelopeSha256(
  envelope: RegistrationPermitEnvelope,
): Promise<string> {
  return sha256Hex(
    encodeLengthPrefixedMessage(ENVELOPE_DIGEST_DOMAIN, [
      envelope.algorithm,
      envelope.subject.issuer,
      envelope.subject.audience,
      envelope.subject.keyId,
      envelope.subject.signerIdentitySha256,
      envelope.subject.signerSpkiSha256,
      envelope.subjectSha256,
      envelope.signatureBase64url,
    ]),
  );
}

export async function derivePermitIdSha256(
  requestId: string,
  actionSubjectSha256: string,
  passkeyAssertionSignatureSha256: string,
  secureVerificationChallengeSha256: string,
  issuedAt: number,
  expiresAt: number,
): Promise<string> {
  return sha256Hex(
    encodeLengthPrefixedMessage(PERMIT_ID_DOMAIN, [
      requestId,
      actionSubjectSha256,
      passkeyAssertionSignatureSha256,
      secureVerificationChallengeSha256,
      canonicalFieldValue(issuedAt),
      canonicalFieldValue(expiresAt),
    ]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await sha256Bytes(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
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
        typ: HMAC_HEADER_TYPE,
      }),
    ),
  );
  const claimsPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson(claims)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
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

export function encodeBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function loadSigningConfiguration(
  env: IssuerEnv,
): Promise<SigningConfiguration> {
  if (
    (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "staging") ||
    !IDENTIFIER.test(env.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER) ||
    !IDENTIFIER.test(env.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE) ||
    !KEY_ID.test(env.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID) ||
    !SHA256.test(env.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256) ||
    !SHA256.test(env.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256) ||
    env.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256 ===
      env.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256 ||
    env.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER ===
      env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER ||
    env.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE ===
      env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE
  ) {
    throw new ProtocolError("issuer_unavailable", 503);
  }

  let pkcs8: Uint8Array;
  let spki: Uint8Array;
  try {
    pkcs8 = decodeBase64Url(
      env.DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL ?? "",
      ED25519_PKCS8_PREFIX.byteLength + 32,
      ED25519_PKCS8_PREFIX.byteLength + 32,
      "issuer_unavailable",
      503,
    );
    spki = decodeBase64Url(
      env.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL ?? "",
      ED25519_SPKI_PREFIX.byteLength + 32,
      ED25519_SPKI_PREFIX.byteLength + 32,
      "issuer_unavailable",
      503,
    );
  } catch {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  if (
    !hasPrefix(pkcs8, ED25519_PKCS8_PREFIX) ||
    !hasPrefix(spki, ED25519_SPKI_PREFIX)
  ) {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  const expectedSpkiSha256 = decodeSha256Hex(
    env.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256,
  );
  if (!constantTimeEqual(await sha256Bytes(spki), expectedSpkiSha256)) {
    throw new ProtocolError("issuer_unavailable", 503);
  }

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(pkcs8),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    publicKey = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(spki),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  return {
    issuer: env.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER,
    audience: env.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE,
    keyId: env.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID,
    signerIdentitySha256:
      env.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256,
    signerSpkiSha256: env.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256,
    privateKey,
    publicKey,
  };
}

function validateHmacConfiguration(env: IssuerEnv): void {
  const currentSecret = env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET;
  if (
    !IDENTIFIER.test(env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER) ||
    !IDENTIFIER.test(env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE) ||
    !KEY_ID.test(env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID) ||
    !SHA256.test(
      env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    ) ||
    currentSecret === undefined ||
    new TextEncoder().encode(currentSecret).byteLength < 32
  ) {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  const previousSecret = env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET;
  const previousConfigured =
    env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID.length > 0 ||
    env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256.length >
      0 ||
    previousSecret !== undefined;
  if (
    previousConfigured &&
    (!KEY_ID.test(env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID) ||
      env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID ===
        env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID ||
      !SHA256.test(
        env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
      ) ||
      env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256 ===
        env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256 ||
      previousSecret === undefined ||
      new TextEncoder().encode(previousSecret).byteLength < 32 ||
      previousSecret === currentSecret)
  ) {
    throw new ProtocolError("issuer_unavailable", 503);
  }
}

function selectHmacKey(
  keyId: string,
  env: IssuerEnv,
): { secret: string; credentialIdSha256: string } {
  if (keyId === env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID) {
    return {
      secret: env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET!,
      credentialIdSha256:
        env.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    };
  }
  if (
    env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID.length > 0 &&
    keyId === env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID
  ) {
    return {
      secret: env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET!,
      credentialIdSha256:
        env.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    };
  }
  throw new ProtocolError("invalid_authority", 403);
}

function parseCanonicalRequestObject(
  body: Uint8Array,
): Record<string, unknown> {
  if (
    body.byteLength >= 3 &&
    body[0] === 0xef &&
    body[1] === 0xbb &&
    body[2] === 0xbf
  ) {
    throw new ProtocolError("invalid_json", 400);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
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

function parseAuthorityObject(
  encoded: string,
  maximumLength: number,
): Record<string, unknown> {
  try {
    const bytes = decodeBase64Url(
      encoded,
      maximumLength,
      undefined,
      "invalid_authority",
      403,
    );
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    const object = requirePlainObject(value);
    if (canonicalJson(object) !== text) {
      throw new Error("non_canonical");
    }
    return object;
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
  const object = requirePlainObject(value);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(object).sort()) {
    result[key] = canonicalValue(object[key]);
  }
  return result;
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

function assertAuthorityKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  try {
    assertExactKeys(value, expected);
  } catch {
    throw new ProtocolError("invalid_authority", 403);
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  try {
    return requirePlainObject(value);
  } catch {
    throw new ProtocolError("invalid_fields", 400);
  }
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("not_object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("not_plain_object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("invalid_fields", 400);
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
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
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

function authorityString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("invalid_authority", 403);
  }
  return value;
}

function authoritySha256(value: unknown): string {
  return authorityString(value, SHA256);
}

function authorityInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError("invalid_authority", 403);
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
  maximumLength: number,
  exactLength: number | undefined,
  errorCode: string,
  errorStatus: number,
): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError(errorCode, errorStatus);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new ProtocolError(errorCode, errorStatus);
  }
  if (
    decoded.length === 0 ||
    decoded.length > maximumLength ||
    (exactLength !== undefined && decoded.length !== exactLength)
  ) {
    throw new ProtocolError(errorCode, errorStatus);
  }
  const bytes = Uint8Array.from(decoded, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(bytes) !== value) {
    throw new ProtocolError(errorCode, errorStatus);
  }
  return bytes;
}

function decodeSha256Hex(value: string): Uint8Array {
  if (!SHA256.test(value)) {
    throw new ProtocolError("issuer_unavailable", 503);
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function canonicalFieldValue(value: string | number | boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError("invalid_fields", 400);
  }
  return value.toString(10);
}

function encodeLengthPrefixedMessage(
  domain: string,
  values: readonly string[],
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode(domain)];
  let total = parts[0]!.byteLength;
  for (const value of values) {
    const bytes = encoder.encode(value);
    const length = new Uint8Array(4);
    const view = new DataView(length.buffer);
    view.setUint32(0, bytes.byteLength, false);
    parts.push(length, bytes);
    total += length.byteLength + bytes.byteLength;
  }
  const message = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.byteLength;
  }
  return message;
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hasPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  return (
    value.byteLength >= prefix.byteLength &&
    prefix.every((byte, index) => value[index] === byte)
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
