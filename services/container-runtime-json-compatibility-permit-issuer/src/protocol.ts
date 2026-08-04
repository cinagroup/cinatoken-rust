import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  jsonCompatibilityPermitSigningPayload,
} from "../../container-runtime-json-compatibility-executor/src/authorization";
import {
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  JSON_COMPATIBILITY_PHASE_IDS,
  JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
  parseJsonCompatibilityExecutePhaseRequestSubjectV2,
  type JsonCompatibilityExecutePhaseRequestSubjectV2,
  type JsonCompatibilityPhasePermitEnvelopeV1,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JsonCompatibilityPermitIssuanceAuthority,
  type JsonCompatibilityPermitIssuanceReceiptV1,
} from "./issuance_authority";

export const JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging" as const;
export const JSON_COMPATIBILITY_INVOKER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-invoker-staging" as const;
export const JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-intent-v1" as const;
export const JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-authority-claims-v1" as const;
export const JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-authority-envelope-v1" as const;
export const JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-request-v1" as const;
export const JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-receipt-v1" as const;

const AUTHORITY_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-permit-issue-authority-v1\n";
const PERMIT_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-phase-permit-id-v1\n";
const AUTHORITY_WINDOW_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const MIN_PERMIT_REMAINING_SECONDS = 180;
const MAX_PERMIT_LIFETIME_SECONDS = 600;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HMAC_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface JsonCompatibilityPermitIssueIntentV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT;
  readonly execution: JsonCompatibilityExecutePhaseRequestSubjectV2;
  readonly executor: {
    readonly serviceName: typeof JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly invoker: {
    readonly serviceName: typeof JSON_COMPATIBILITY_INVOKER_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly authorizationIdSha256: string;
  readonly topologyReadbackSha256: string;
  readonly beforeContextSha256: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityPermitIssueAuthorityClaimsV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT;
  readonly issuer: string;
  readonly audience: string;
  readonly credentialIdSha256: string;
  readonly requestIdSha256: string;
  readonly issueIntentSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityPermitIssueAuthorityEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_ENVELOPE_CONTRACT;
  readonly algorithm: "HMAC-SHA-256";
  readonly keyId: string;
  readonly claims: JsonCompatibilityPermitIssueAuthorityClaimsV1;
  readonly claimsSha256: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilityPermitIssueRequestV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT;
  readonly intent: JsonCompatibilityPermitIssueIntentV1;
  readonly authority: JsonCompatibilityPermitIssueAuthorityEnvelopeV1;
}

export interface JsonCompatibilityPermitIssueReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT;
  readonly status: "phase_permit_issued";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseExecutionId: string;
  readonly issuer: {
    readonly serviceName: typeof JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME;
    readonly versionId: string;
    readonly keyId: string;
    readonly signerSpkiSha256: string;
  };
  readonly authority: {
    readonly issuer: string;
    readonly audience: string;
    readonly keyId: string;
    readonly credentialIdSha256: string;
    readonly requestIdSha256: string;
    readonly claimsSha256: string;
  };
  readonly issueIntent: JsonCompatibilityPermitIssueIntentV1;
  readonly issueIntentSha256: string;
  readonly permitEnvelope: JsonCompatibilityPhasePermitEnvelopeV1;
  readonly permitEnvelopeSha256: string;
  readonly issuanceAuthority: JsonCompatibilityPermitIssuanceReceiptV1;
  readonly receiptSha256: string;
}

interface IssuerSecrets {
  readonly JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET?: string;
  readonly JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_SECRET?: string;
  readonly JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL?: string;
  readonly JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL?: string;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type JsonCompatibilityPermitIssuerEnv = Omit<
  WidenGeneratedStringBindings<JsonCompatibilityPermitIssuerGeneratedEnv>,
  | "CF_VERSION_METADATA"
  | "JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY:
    DurableObjectNamespace<JsonCompatibilityPermitIssuanceAuthority>;
} & IssuerSecrets;

interface AuthenticatedPermitIssueAuthority {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly credentialIdSha256: string;
  readonly requestIdSha256: string;
  readonly claimsSha256: string;
}

interface SigningConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly signerSpkiSha256: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

export class JsonCompatibilityPermitIssuerError extends Error {
  constructor(
    readonly code:
      | "permit_issuer_disabled"
      | "invalid_permit_issue_request"
      | "invalid_permit_issue_authority"
      | "permit_issue_authority_time_window"
      | "permit_issue_binding_mismatch"
      | "permit_signer_unavailable"
      | "permit_issuance_conflict"
      | "permit_issuance_authority_unavailable",
  ) {
    super(code);
    this.name = "JsonCompatibilityPermitIssuerError";
  }
}

export async function issueJsonCompatibilityPhasePermit(
  env: JsonCompatibilityPermitIssuerEnv,
  input: unknown,
  nowMilliseconds = Date.now(),
): Promise<JsonCompatibilityPermitIssueReceiptV1> {
  requireIssuerEnabled(env);
  const request = parseJsonCompatibilityPermitIssueRequestV1(input);
  const now = wholeSecond(nowMilliseconds);
  const issueIntentSha256 = await sha256Hex(canonicalJson(request.intent));
  const authority = await verifyPermitIssueAuthority(
    env,
    request.authority,
    request.intent,
    issueIntentSha256,
    now,
  );
  validatePermitWindow(request.intent, authority, now);
  const signing = await loadSigningConfiguration(env);
  const issuerVersionId = safeToken(
    env.CF_VERSION_METADATA?.id,
    "permit issuer version",
    "permit_signer_unavailable",
  );
  const permitIdSha256 = await sha256Hex(
    `${PERMIT_ID_DOMAIN}${issueIntentSha256}\n${authority.requestIdSha256}`,
  );
  const execution = request.intent.execution;
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    issuer: signing.issuer,
    audience: signing.audience,
    keyId: signing.keyId,
    permitIdSha256,
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseExecutionId: execution.phaseExecutionId,
    controller: execution.controller,
    executor: request.intent.executor,
    runtimes: execution.runtimes,
    ring: execution.ring,
    phase: execution.phase,
    issuedAt: request.intent.issuedAt,
    notBefore: request.intent.notBefore,
    expiresAt: request.intent.expiresAt,
  };
  const subjectSha256 = await sha256Hex(canonicalJson(subject));
  const unsignedEnvelope = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519" as const,
    subject,
    subjectSha256,
    signatureBase64url: "",
  };
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      signing.privateKey,
      toArrayBuffer(jsonCompatibilityPermitSigningPayload(unsignedEnvelope)),
    ));
  } catch {
    throw issuerError("permit_signer_unavailable");
  }
  if (signature.byteLength !== 64) {
    throw issuerError("permit_signer_unavailable");
  }
  const envelope: JsonCompatibilityPhasePermitEnvelopeV1 = {
    ...unsignedEnvelope,
    signatureBase64url: encodeBase64url(signature),
  };
  let selfVerified = false;
  try {
    selfVerified = await crypto.subtle.verify(
      "Ed25519",
      signing.publicKey,
      toArrayBuffer(signature),
      toArrayBuffer(jsonCompatibilityPermitSigningPayload(envelope)),
    );
  } catch {
    throw issuerError("permit_signer_unavailable");
  }
  if (!selfVerified) throw issuerError("permit_signer_unavailable");

  const permitEnvelopeSha256 = await sha256Hex(canonicalJson(envelope));
  const campaignBindingSha256 = await jsonCompatibilityIssuerCampaignBinding(
    request.intent,
  );
  const issuanceAuthority = await recordIssuance(
    env,
    request.intent,
    issueIntentSha256,
    campaignBindingSha256,
    authority.requestIdSha256,
    permitIdSha256,
    subjectSha256,
    permitEnvelopeSha256,
    issuerVersionId,
  );
  const receiptSubject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
    status: "phase_permit_issued" as const,
    environment: "staging" as const,
    campaignIdSha256: execution.campaignIdSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseExecutionId: execution.phaseExecutionId,
    issuer: {
      serviceName: JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
      versionId: issuerVersionId,
      keyId: signing.keyId,
      signerSpkiSha256: signing.signerSpkiSha256,
    },
    authority,
    issueIntent: request.intent,
    issueIntentSha256,
    permitEnvelope: envelope,
    permitEnvelopeSha256,
    issuanceAuthority,
  };
  return {
    ...receiptSubject,
    receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
  };
}

export function parseJsonCompatibilityPermitIssueRequestV1(
  input: unknown,
): JsonCompatibilityPermitIssueRequestV1 {
  const value = record(input);
  exactKeys(value, ["schemaVersion", "contract", "intent", "authority"]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT,
    intent: parseIssueIntent(value.intent),
    authority: parseAuthorityEnvelope(value.authority),
  };
}

export function parseJsonCompatibilityPermitIssueIntentV1(
  input: unknown,
): JsonCompatibilityPermitIssueIntentV1 {
  return parseIssueIntent(input);
}

export async function createPermitIssueAuthorityEnvelope(
  secret: string,
  keyId: string,
  claims: JsonCompatibilityPermitIssueAuthorityClaimsV1,
): Promise<JsonCompatibilityPermitIssueAuthorityEnvelopeV1> {
  if (new TextEncoder().encode(secret).byteLength < 32 || !KEY_ID.test(keyId)) {
    throw issuerError("invalid_permit_issue_authority");
  }
  const claimsSha256 = await sha256Hex(canonicalJson(claims));
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(authoritySigningPayload(claims)),
  ));
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId,
    claims,
    claimsSha256,
    signatureBase64url: encodeBase64url(signature),
  };
}

export async function deriveJsonCompatibilityPermitIdSha256(
  issueIntentSha256: string,
  requestIdSha256: string,
): Promise<string> {
  requireSha256(issueIntentSha256);
  requireSha256(requestIdSha256);
  return await sha256Hex(
    `${PERMIT_ID_DOMAIN}${issueIntentSha256}\n${requestIdSha256}`,
  );
}

export async function jsonCompatibilityIssuerCampaignBinding(
  intent: JsonCompatibilityPermitIssueIntentV1,
): Promise<string> {
  const execution = intent.execution;
  return await sha256Hex(canonicalJson({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-issuer-campaign-binding-v1",
    environment: execution.environment,
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    controller: execution.controller,
    executor: intent.executor,
    invoker: intent.invoker,
    runtimes: execution.runtimes,
    ring: execution.ring,
  }));
}

async function verifyPermitIssueAuthority(
  env: JsonCompatibilityPermitIssuerEnv,
  envelope: JsonCompatibilityPermitIssueAuthorityEnvelopeV1,
  intent: JsonCompatibilityPermitIssueIntentV1,
  issueIntentSha256: string,
  now: number,
): Promise<AuthenticatedPermitIssueAuthority> {
  const claims = envelope.claims;
  if (
    claims.issuer !== env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_ISSUER
    || claims.audience !== env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_AUDIENCE
    || claims.issueIntentSha256 !== issueIntentSha256
    || intent.invoker.serviceName !== claims.issuer
  ) {
    throw issuerError("permit_issue_binding_mismatch");
  }
  const selected = selectAuthorityKey(env, envelope.keyId);
  if (claims.credentialIdSha256 !== selected.credentialIdSha256) {
    throw issuerError("permit_issue_binding_mismatch");
  }
  const actualClaimsSha256 = await sha256Hex(canonicalJson(claims));
  if (!constantTimeStringEqual(actualClaimsSha256, envelope.claimsSha256)) {
    throw issuerError("invalid_permit_issue_authority");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(selected.secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(decodeBase64url(envelope.signatureBase64url, 32, 32)),
    toArrayBuffer(authoritySigningPayload(claims)),
  );
  if (!valid) throw issuerError("invalid_permit_issue_authority");
  if (
    claims.issuedAt > now + CLOCK_SKEW_SECONDS
    || now - claims.issuedAt > AUTHORITY_WINDOW_SECONDS
    || claims.expiresAt <= now
    || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > AUTHORITY_WINDOW_SECONDS
  ) {
    throw issuerError("permit_issue_authority_time_window");
  }
  return {
    issuer: claims.issuer,
    audience: claims.audience,
    keyId: envelope.keyId,
    credentialIdSha256: claims.credentialIdSha256,
    requestIdSha256: claims.requestIdSha256,
    claimsSha256: envelope.claimsSha256,
  };
}

function validatePermitWindow(
  intent: JsonCompatibilityPermitIssueIntentV1,
  authority: AuthenticatedPermitIssueAuthority,
  now: number,
): void {
  void authority;
  if (
    intent.issuedAt > now + CLOCK_SKEW_SECONDS
    || now - intent.issuedAt > AUTHORITY_WINDOW_SECONDS
    || intent.notBefore < intent.issuedAt - CLOCK_SKEW_SECONDS
    || intent.notBefore > now + CLOCK_SKEW_SECONDS
    || intent.expiresAt <= intent.notBefore
    || intent.expiresAt - intent.issuedAt > MAX_PERMIT_LIFETIME_SECONDS
    || intent.expiresAt - now < MIN_PERMIT_REMAINING_SECONDS
  ) {
    throw issuerError("permit_issue_binding_mismatch");
  }
}

async function loadSigningConfiguration(
  env: JsonCompatibilityPermitIssuerEnv,
): Promise<SigningConfiguration> {
  const issuer = safeToken(
    env.JSON_COMPATIBILITY_PERMIT_ISSUER,
    "permit issuer",
    "permit_signer_unavailable",
  );
  const audience = safeToken(
    env.JSON_COMPATIBILITY_PERMIT_AUDIENCE,
    "permit audience",
    "permit_signer_unavailable",
  );
  const keyId = keyIdValue(
    env.JSON_COMPATIBILITY_PERMIT_KEY_ID,
    "permit_signer_unavailable",
  );
  const signerSpkiSha256 = sha256Value(
    env.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256,
    "permit_signer_unavailable",
  );
  let pkcs8: Uint8Array;
  let spki: Uint8Array;
  try {
    pkcs8 = decodeBase64url(
      env.JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL ?? "",
      512,
    );
    spki = decodeBase64url(
      env.JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL ?? "",
      512,
    );
  } catch {
    throw issuerError("permit_signer_unavailable");
  }
  const actualSpkiSha256 = await sha256Hex(spki);
  if (!constantTimeStringEqual(actualSpkiSha256, signerSpkiSha256)) {
    throw issuerError("permit_signer_unavailable");
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
    throw issuerError("permit_signer_unavailable");
  }
  return { issuer, audience, keyId, signerSpkiSha256, privateKey, publicKey };
}

async function recordIssuance(
  env: JsonCompatibilityPermitIssuerEnv,
  intent: JsonCompatibilityPermitIssueIntentV1,
  issueIntentSha256: string,
  campaignBindingSha256: string,
  authorityRequestIdSha256: string,
  permitIdSha256: string,
  permitSubjectSha256: string,
  permitEnvelopeSha256: string,
  issuerVersionId: string,
): Promise<JsonCompatibilityPermitIssuanceReceiptV1> {
  const execution = intent.execution;
  let result;
  try {
    result = await env.JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY
      .getByName(execution.campaignIdSha256)
      .recordIssuance({
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-permit-issuance-record-v1",
        campaignIdSha256: execution.campaignIdSha256,
        campaignBindingSha256,
        planDigestSha256: execution.planDigestSha256,
        phaseOrdinal: execution.phase.ordinal,
        phaseId: execution.phase.id,
        phaseExecutionId: execution.phaseExecutionId,
        issueIntentSha256,
        authorityRequestIdSha256,
        permitIdSha256,
        permitSubjectSha256,
        permitEnvelopeSha256,
        issuerVersionId,
        issuedAt: intent.issuedAt,
        expiresAt: intent.expiresAt,
      });
  } catch {
    throw issuerError("permit_issuance_authority_unavailable");
  }
  if (!result.ok) throw issuerError("permit_issuance_conflict");
  const receipt = result.receipt;
  const { receiptSha256, ...receiptSubject } = receipt;
  const expectedSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1",
    status: "permit_issuance_recorded",
    campaignIdSha256: execution.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseId: execution.phase.id,
    phaseExecutionId: execution.phaseExecutionId,
    issueIntentSha256,
    authorityRequestIdSha256,
    permitIdSha256,
    permitSubjectSha256,
    permitEnvelopeSha256,
    issuerVersionId,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    onePermitPerPhasePersisted: true,
    phaseIssuanceOrderEnforced: true,
    ambiguousRetryRejected: true,
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(expectedSubject)
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw issuerError("permit_issuance_authority_unavailable");
  }
  return receipt;
}

function parseIssueIntent(input: unknown): JsonCompatibilityPermitIssueIntentV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "execution", "executor", "invoker",
    "authorizationIdSha256", "topologyReadbackSha256", "beforeContextSha256",
    "issuedAt", "notBefore", "expiresAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT);
  const executor = record(value.executor);
  exactKeys(executor, ["serviceName", "versionId"]);
  literal(executor.serviceName, JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME);
  const invoker = record(value.invoker);
  exactKeys(invoker, ["serviceName", "versionId"]);
  literal(invoker.serviceName, JSON_COMPATIBILITY_INVOKER_SERVICE_NAME);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
    execution: parseJsonCompatibilityExecutePhaseRequestSubjectV2(value.execution),
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: safeToken(executor.versionId, "executor version"),
    },
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: safeToken(invoker.versionId, "invoker version"),
    },
    authorizationIdSha256: requireSha256(value.authorizationIdSha256),
    topologyReadbackSha256: requireSha256(value.topologyReadbackSha256),
    beforeContextSha256: requireSha256(value.beforeContextSha256),
    issuedAt: integer(value.issuedAt),
    notBefore: integer(value.notBefore),
    expiresAt: integer(value.expiresAt),
  };
}

function parseAuthorityEnvelope(
  input: unknown,
): JsonCompatibilityPermitIssueAuthorityEnvelopeV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "keyId", "claims",
    "claimsSha256", "signatureBase64url",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_ENVELOPE_CONTRACT,
  );
  literal(value.algorithm, "HMAC-SHA-256");
  const signature = value.signatureBase64url;
  if (typeof signature !== "string" || !HMAC_SIGNATURE.test(signature)) {
    throw issuerError("invalid_permit_issue_request");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId: keyIdValue(value.keyId),
    claims: parseAuthorityClaims(value.claims),
    claimsSha256: requireSha256(value.claimsSha256),
    signatureBase64url: signature,
  };
}

function parseAuthorityClaims(
  input: unknown,
): JsonCompatibilityPermitIssueAuthorityClaimsV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "issuer", "audience",
    "credentialIdSha256", "requestIdSha256", "issueIntentSha256",
    "issuedAt", "expiresAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
    issuer: safeToken(value.issuer, "authority issuer"),
    audience: safeToken(value.audience, "authority audience"),
    credentialIdSha256: requireSha256(value.credentialIdSha256),
    requestIdSha256: requireSha256(value.requestIdSha256),
    issueIntentSha256: requireSha256(value.issueIntentSha256),
    issuedAt: integer(value.issuedAt),
    expiresAt: integer(value.expiresAt),
  };
}

function requireIssuerEnabled(env: JsonCompatibilityPermitIssuerEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED !== "true"
  ) {
    throw issuerError("permit_issuer_disabled");
  }
}

function selectAuthorityKey(
  env: JsonCompatibilityPermitIssuerEnv,
  keyId: string,
): { readonly secret: string; readonly credentialIdSha256: string } {
  const currentSecret = env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET;
  if (
    keyId === env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID
    && typeof currentSecret === "string"
    && new TextEncoder().encode(currentSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: currentSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256,
    };
  }
  const previousSecret = env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_SECRET;
  if (
    keyId === env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_KID
    && typeof previousSecret === "string"
    && new TextEncoder().encode(previousSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: previousSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_CREDENTIAL_ID_SHA256,
    };
  }
  throw issuerError("invalid_permit_issue_authority");
}

function authoritySigningPayload(
  claims: JsonCompatibilityPermitIssueAuthorityClaimsV1,
): Uint8Array {
  return new TextEncoder().encode(
    `${AUTHORITY_SIGNATURE_DOMAIN}${canonicalJson(claims)}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw issuerError("invalid_permit_issue_request");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw issuerError("invalid_permit_issue_request");
  }
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) throw issuerError("invalid_permit_issue_request");
  return expected;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw issuerError("invalid_permit_issue_request");
  }
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw issuerError("invalid_permit_issue_request");
  }
  return value;
}

function sha256Value(
  value: unknown,
  code: JsonCompatibilityPermitIssuerError["code"] =
    "invalid_permit_issue_request",
): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw issuerError(code);
  return value;
}

function keyIdValue(
  value: unknown,
  code: JsonCompatibilityPermitIssuerError["code"] =
    "invalid_permit_issue_request",
): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw issuerError(code);
  return value;
}

function safeToken(
  value: unknown,
  _label: string,
  code: JsonCompatibilityPermitIssuerError["code"] =
    "invalid_permit_issue_request",
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw issuerError(code);
  }
  return value;
}

function wholeSecond(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw issuerError("permit_signer_unavailable");
  }
  return Math.floor(milliseconds / 1000);
}

function decodeBase64url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength > maximumBytes
    || (exactBytes !== undefined && bytes.byteLength !== exactBytes)
    || encodeBase64url(bytes) !== value
  ) {
    throw new Error("invalid base64url");
  }
  return bytes;
}

function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function issuerError(
  code: JsonCompatibilityPermitIssuerError["code"],
): JsonCompatibilityPermitIssuerError {
  return new JsonCompatibilityPermitIssuerError(code);
}
