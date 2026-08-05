import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseId,
  type JsonCompatibilityPhaseOrdinal,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
  parseJsonCompatibilityPermitIssueIntentV1,
  type JsonCompatibilityPermitIssueIntentV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";

export const JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-command-subject-v1" as const;
export const JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-authority-claims-v1" as const;
export const JSON_COMPATIBILITY_INVOKE_AUTHORITY_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-authority-envelope-v1" as const;
export const JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-command-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-status-target-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-status-query-subject-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-status-authority-claims-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-status-authority-envelope-v1" as const;
export const JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-status-query-v1" as const;

const SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invoke-authority-v1\n";
const STATUS_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-status-authority-v1\n";
const STATUS_QUERY_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-status-query-id-v1\n";
const WINDOW_SECONDS = 60;
const STATUS_WINDOW_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 5;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HMAC_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface JsonCompatibilityInvokeCommandSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT;
  readonly commandIdSha256: string;
  readonly issueIntent: JsonCompatibilityPermitIssueIntentV1;
}

export interface JsonCompatibilityInvokeAuthorityClaimsV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT;
  readonly issuer: string;
  readonly audience: string;
  readonly credentialIdSha256: string;
  readonly commandIdSha256: string;
  readonly commandSubjectSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityInvokeAuthorityEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOKE_AUTHORITY_ENVELOPE_CONTRACT;
  readonly algorithm: "HMAC-SHA-256";
  readonly keyId: string;
  readonly claims: JsonCompatibilityInvokeAuthorityClaimsV1;
  readonly claimsSha256: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilityInvokeCommandV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT;
  readonly subject: JsonCompatibilityInvokeCommandSubjectV1;
  readonly authority: JsonCompatibilityInvokeAuthorityEnvelopeV1;
}

export interface JsonCompatibilityInvocationStatusTargetV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT;
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseOrdinal: JsonCompatibilityPhaseOrdinal;
  readonly phaseId: JsonCompatibilityPhaseId;
  readonly phaseExecutionId: string;
  readonly commandIdSha256: string;
  readonly operatorRequestSha256: string;
  readonly approvalEnvelopeSha256: string;
  readonly operatorVersionId: string;
  readonly invokerVersionId: string;
}

export interface JsonCompatibilityInvocationStatusQuerySubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT;
  readonly statusQueryIdSha256: string;
  readonly target: JsonCompatibilityInvocationStatusTargetV1;
}

export interface JsonCompatibilityInvocationStatusAuthorityClaimsV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT;
  readonly issuer: string;
  readonly audience: string;
  readonly credentialIdSha256: string;
  readonly statusQueryIdSha256: string;
  readonly statusQuerySubjectSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityInvocationStatusAuthorityEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_ENVELOPE_CONTRACT;
  readonly algorithm: "HMAC-SHA-256";
  readonly keyId: string;
  readonly claims: JsonCompatibilityInvocationStatusAuthorityClaimsV1;
  readonly claimsSha256: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilityInvocationStatusQueryV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT;
  readonly subject: JsonCompatibilityInvocationStatusQuerySubjectV1;
  readonly authority: JsonCompatibilityInvocationStatusAuthorityEnvelopeV1;
}

export interface JsonCompatibilityInvokerOperatorEnv {
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET?: string;
}

export interface JsonCompatibilityInvokerStatusOperatorEnv {
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_SECRET?: string;
}

export interface VerifiedJsonCompatibilityInvokeAuthorityV1 {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly credentialIdSha256: string;
  readonly commandIdSha256: string;
  readonly commandSubjectSha256: string;
  readonly claimsSha256: string;
  readonly authorityEnvelopeSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface VerifiedJsonCompatibilityInvocationStatusAuthorityV1 {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly credentialIdSha256: string;
  readonly statusQueryIdSha256: string;
  readonly statusQuerySubjectSha256: string;
  readonly claimsSha256: string;
  readonly authorityEnvelopeSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class JsonCompatibilityInvokerAuthorizationError extends Error {
  constructor(
    readonly code:
      | "invalid_invoke_command"
      | "invalid_invoke_authority"
      | "invoke_authority_binding_mismatch"
      | "invoke_authority_time_window"
      | "invalid_status_query"
      | "invalid_status_authority"
      | "status_authority_binding_mismatch"
      | "status_authority_time_window",
  ) {
    super(code);
    this.name = "JsonCompatibilityInvokerAuthorizationError";
  }
}

export async function verifyJsonCompatibilityInvocationStatusQuery(
  env: JsonCompatibilityInvokerStatusOperatorEnv,
  input: unknown,
  expectedInvokerVersionId: string,
  nowMilliseconds: number,
): Promise<{
  readonly query: JsonCompatibilityInvocationStatusQueryV1;
  readonly authority: VerifiedJsonCompatibilityInvocationStatusAuthorityV1;
}> {
  const query = parseJsonCompatibilityInvocationStatusQueryV1(input);
  const subject = query.subject;
  const target = subject.target;
  const claims = query.authority.claims;
  const now = wholeSecond(nowMilliseconds);
  if (
    target.invokerVersionId !== expectedInvokerVersionId
    || target.phaseId !== JSON_COMPATIBILITY_PHASE_IDS[target.phaseOrdinal - 1]
  ) {
    throw authorizationError("status_authority_binding_mismatch");
  }
  const expectedQueryId = await deriveJsonCompatibilityInvocationStatusQueryId(
    target,
    claims.issuedAt,
  );
  const statusQuerySubjectSha256 = await sha256Hex(canonicalJson(subject));
  if (
    subject.statusQueryIdSha256 !== expectedQueryId
    || claims.issuer !== env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER
    || claims.audience !== env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE
    || claims.audience !== JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || claims.statusQueryIdSha256 !== subject.statusQueryIdSha256
    || claims.statusQuerySubjectSha256 !== statusQuerySubjectSha256
  ) {
    throw authorizationError("status_authority_binding_mismatch");
  }
  const selected = selectStatusKey(env, query.authority.keyId);
  if (claims.credentialIdSha256 !== selected.credentialIdSha256) {
    throw authorizationError("status_authority_binding_mismatch");
  }
  const claimsSha256 = await sha256Hex(canonicalJson(claims));
  if (!constantTimeEqual(claimsSha256, query.authority.claimsSha256)) {
    throw authorizationError("invalid_status_authority");
  }
  let signature: Uint8Array;
  try {
    signature = decodeBase64url(query.authority.signatureBase64url, 32, 32);
  } catch {
    throw authorizationError("invalid_status_authority");
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
    toArrayBuffer(signature),
    toArrayBuffer(statusSigningPayload(claims)),
  );
  if (!valid) throw authorizationError("invalid_status_authority");
  if (
    claims.issuedAt > now + CLOCK_SKEW_SECONDS
    || now - claims.issuedAt > STATUS_WINDOW_SECONDS
    || claims.expiresAt <= now
    || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > STATUS_WINDOW_SECONDS
  ) {
    throw authorizationError("status_authority_time_window");
  }
  return {
    query,
    authority: {
      issuer: claims.issuer,
      audience: claims.audience,
      keyId: query.authority.keyId,
      credentialIdSha256: claims.credentialIdSha256,
      statusQueryIdSha256: claims.statusQueryIdSha256,
      statusQuerySubjectSha256,
      claimsSha256,
      authorityEnvelopeSha256: await sha256Hex(
        canonicalJson(query.authority),
      ),
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
  };
}

export async function verifyJsonCompatibilityInvokeCommand(
  env: JsonCompatibilityInvokerOperatorEnv,
  input: unknown,
  expectedInvokerVersionId: string,
  nowMilliseconds: number,
): Promise<{
  readonly command: JsonCompatibilityInvokeCommandV1;
  readonly authority: VerifiedJsonCompatibilityInvokeAuthorityV1;
}> {
  const command = parseJsonCompatibilityInvokeCommandV1(input);
  const subject = command.subject;
  const claims = command.authority.claims;
  const now = wholeSecond(nowMilliseconds);
  if (
    subject.issueIntent.invoker.serviceName !==
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || subject.issueIntent.invoker.versionId !== expectedInvokerVersionId
    || subject.issueIntent.authorizationIdSha256 !== subject.commandIdSha256
  ) {
    throw authorizationError("invoke_authority_binding_mismatch");
  }
  const commandSubjectSha256 = await sha256Hex(canonicalJson(subject));
  if (
    claims.issuer !== env.JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER
    || claims.audience !== env.JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE
    || claims.audience !== JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || claims.commandIdSha256 !== subject.commandIdSha256
    || claims.commandSubjectSha256 !== commandSubjectSha256
  ) {
    throw authorizationError("invoke_authority_binding_mismatch");
  }
  const selected = selectKey(env, command.authority.keyId);
  if (claims.credentialIdSha256 !== selected.credentialIdSha256) {
    throw authorizationError("invoke_authority_binding_mismatch");
  }
  const claimsSha256 = await sha256Hex(canonicalJson(claims));
  if (!constantTimeEqual(claimsSha256, command.authority.claimsSha256)) {
    throw authorizationError("invalid_invoke_authority");
  }
  let signature: Uint8Array;
  try {
    signature = decodeBase64url(command.authority.signatureBase64url, 32, 32);
  } catch {
    throw authorizationError("invalid_invoke_authority");
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
    toArrayBuffer(signature),
    toArrayBuffer(signingPayload(claims)),
  );
  if (!valid) throw authorizationError("invalid_invoke_authority");
  if (
    claims.issuedAt > now + CLOCK_SKEW_SECONDS
    || now - claims.issuedAt > WINDOW_SECONDS
    || claims.expiresAt <= now
    || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > WINDOW_SECONDS
  ) {
    throw authorizationError("invoke_authority_time_window");
  }
  return {
    command,
    authority: {
      issuer: claims.issuer,
      audience: claims.audience,
      keyId: command.authority.keyId,
      credentialIdSha256: claims.credentialIdSha256,
      commandIdSha256: claims.commandIdSha256,
      commandSubjectSha256,
      claimsSha256,
      authorityEnvelopeSha256: await sha256Hex(canonicalJson(command.authority)),
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
  };
}

export async function createInvokeAuthorityEnvelope(
  secret: string,
  keyId: string,
  claims: JsonCompatibilityInvokeAuthorityClaimsV1,
): Promise<JsonCompatibilityInvokeAuthorityEnvelopeV1> {
  if (new TextEncoder().encode(secret).byteLength < 32 || !KEY_ID.test(keyId)) {
    throw authorizationError("invalid_invoke_authority");
  }
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
    toArrayBuffer(signingPayload(claims)),
  ));
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId,
    claims,
    claimsSha256: await sha256Hex(canonicalJson(claims)),
    signatureBase64url: encodeBase64url(signature),
  };
}

export async function deriveJsonCompatibilityInvocationStatusQueryId(
  target: JsonCompatibilityInvocationStatusTargetV1,
  issuedAt: number,
): Promise<string> {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) {
    throw authorizationError("invalid_status_query");
  }
  return await sha256Hex(
    `${STATUS_QUERY_ID_DOMAIN}${canonicalJson(target)}\n${issuedAt}`,
  );
}

export async function createInvocationStatusAuthorityEnvelope(
  secret: string,
  keyIdValue: string,
  claims: JsonCompatibilityInvocationStatusAuthorityClaimsV1,
): Promise<JsonCompatibilityInvocationStatusAuthorityEnvelopeV1> {
  if (
    new TextEncoder().encode(secret).byteLength < 32
    || !KEY_ID.test(keyIdValue)
  ) {
    throw authorizationError("invalid_status_authority");
  }
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
    toArrayBuffer(statusSigningPayload(claims)),
  ));
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId: keyIdValue,
    claims,
    claimsSha256: await sha256Hex(canonicalJson(claims)),
    signatureBase64url: encodeBase64url(signature),
  };
}

export function parseJsonCompatibilityInvocationStatusQueryV1(
  input: unknown,
): JsonCompatibilityInvocationStatusQueryV1 {
  const value = statusRecord(input);
  statusExactKeys(value, ["schemaVersion", "contract", "subject", "authority"]);
  statusLiteral(value.schemaVersion, 1);
  statusLiteral(
    value.contract,
    JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT,
    subject: parseStatusSubject(value.subject),
    authority: parseStatusEnvelope(value.authority),
  };
}

export function parseJsonCompatibilityInvokeCommandV1(
  input: unknown,
): JsonCompatibilityInvokeCommandV1 {
  const value = record(input);
  exactKeys(value, ["schemaVersion", "contract", "subject", "authority"]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
    subject: parseSubject(value.subject),
    authority: parseEnvelope(value.authority),
  };
}

function parseSubject(input: unknown): JsonCompatibilityInvokeCommandSubjectV1 {
  const value = record(input);
  exactKeys(value, ["schemaVersion", "contract", "commandIdSha256", "issueIntent"]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
    commandIdSha256: sha256(value.commandIdSha256),
    issueIntent: parseJsonCompatibilityPermitIssueIntentV1(value.issueIntent),
  };
}

function parseEnvelope(input: unknown): JsonCompatibilityInvokeAuthorityEnvelopeV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "keyId", "claims",
    "claimsSha256", "signatureBase64url",
  ]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_INVOKE_AUTHORITY_ENVELOPE_CONTRACT);
  literal(value.algorithm, "HMAC-SHA-256");
  const signature = value.signatureBase64url;
  if (typeof signature !== "string" || !HMAC_SIGNATURE.test(signature)) {
    throw authorizationError("invalid_invoke_command");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId: keyId(value.keyId),
    claims: parseClaims(value.claims),
    claimsSha256: sha256(value.claimsSha256),
    signatureBase64url: signature,
  };
}

function parseClaims(input: unknown): JsonCompatibilityInvokeAuthorityClaimsV1 {
  const value = record(input);
  exactKeys(value, [
    "schemaVersion", "contract", "issuer", "audience",
    "credentialIdSha256", "commandIdSha256", "commandSubjectSha256",
    "issuedAt", "expiresAt",
  ]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
    issuer: token(value.issuer),
    audience: token(value.audience),
    credentialIdSha256: sha256(value.credentialIdSha256),
    commandIdSha256: sha256(value.commandIdSha256),
    commandSubjectSha256: sha256(value.commandSubjectSha256),
    issuedAt: integer(value.issuedAt),
    expiresAt: integer(value.expiresAt),
  };
}

function parseStatusSubject(
  input: unknown,
): JsonCompatibilityInvocationStatusQuerySubjectV1 {
  const value = statusRecord(input);
  statusExactKeys(value, [
    "schemaVersion",
    "contract",
    "statusQueryIdSha256",
    "target",
  ]);
  statusLiteral(value.schemaVersion, 1);
  statusLiteral(
    value.contract,
    JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_SUBJECT_CONTRACT,
    statusQueryIdSha256: statusSha256(value.statusQueryIdSha256),
    target: parseStatusTarget(value.target),
  };
}

function parseStatusTarget(
  input: unknown,
): JsonCompatibilityInvocationStatusTargetV1 {
  const value = statusRecord(input);
  statusExactKeys(value, [
    "schemaVersion",
    "contract",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseOrdinal",
    "phaseId",
    "phaseExecutionId",
    "commandIdSha256",
    "operatorRequestSha256",
    "approvalEnvelopeSha256",
    "operatorVersionId",
    "invokerVersionId",
  ]);
  statusLiteral(value.schemaVersion, 1);
  statusLiteral(
    value.contract,
    JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT,
  );
  const phaseOrdinal = statusInteger(value.phaseOrdinal) as
    JsonCompatibilityPhaseOrdinal;
  if (phaseOrdinal > JSON_COMPATIBILITY_PHASE_IDS.length) {
    throw authorizationError("invalid_status_query");
  }
  const expectedPhaseId = JSON_COMPATIBILITY_PHASE_IDS[phaseOrdinal - 1];
  if (value.phaseId !== expectedPhaseId) {
    throw authorizationError("invalid_status_query");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_TARGET_CONTRACT,
    campaignIdSha256: statusSha256(value.campaignIdSha256),
    planDigestSha256: statusSha256(value.planDigestSha256),
    phaseOrdinal,
    phaseId: expectedPhaseId,
    phaseExecutionId: statusToken(value.phaseExecutionId),
    commandIdSha256: statusSha256(value.commandIdSha256),
    operatorRequestSha256: statusSha256(value.operatorRequestSha256),
    approvalEnvelopeSha256: statusSha256(value.approvalEnvelopeSha256),
    operatorVersionId: statusToken(value.operatorVersionId),
    invokerVersionId: statusToken(value.invokerVersionId),
  };
}

function parseStatusEnvelope(
  input: unknown,
): JsonCompatibilityInvocationStatusAuthorityEnvelopeV1 {
  const value = statusRecord(input);
  statusExactKeys(value, [
    "schemaVersion",
    "contract",
    "algorithm",
    "keyId",
    "claims",
    "claimsSha256",
    "signatureBase64url",
  ]);
  statusLiteral(value.schemaVersion, 1);
  statusLiteral(
    value.contract,
    JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_ENVELOPE_CONTRACT,
  );
  statusLiteral(value.algorithm, "HMAC-SHA-256");
  const signature = value.signatureBase64url;
  if (typeof signature !== "string" || !HMAC_SIGNATURE.test(signature)) {
    throw authorizationError("invalid_status_query");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_ENVELOPE_CONTRACT,
    algorithm: "HMAC-SHA-256",
    keyId: statusKeyId(value.keyId),
    claims: parseStatusClaims(value.claims),
    claimsSha256: statusSha256(value.claimsSha256),
    signatureBase64url: signature,
  };
}

function parseStatusClaims(
  input: unknown,
): JsonCompatibilityInvocationStatusAuthorityClaimsV1 {
  const value = statusRecord(input);
  statusExactKeys(value, [
    "schemaVersion",
    "contract",
    "issuer",
    "audience",
    "credentialIdSha256",
    "statusQueryIdSha256",
    "statusQuerySubjectSha256",
    "issuedAt",
    "expiresAt",
  ]);
  statusLiteral(value.schemaVersion, 1);
  statusLiteral(
    value.contract,
    JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOCATION_STATUS_AUTHORITY_CLAIMS_CONTRACT,
    issuer: statusToken(value.issuer),
    audience: statusToken(value.audience),
    credentialIdSha256: statusSha256(value.credentialIdSha256),
    statusQueryIdSha256: statusSha256(value.statusQueryIdSha256),
    statusQuerySubjectSha256: statusSha256(value.statusQuerySubjectSha256),
    issuedAt: statusInteger(value.issuedAt),
    expiresAt: statusInteger(value.expiresAt),
  };
}

function selectKey(
  env: JsonCompatibilityInvokerOperatorEnv,
  keyIdValue: string,
  invalidCode: "invalid_invoke_authority" | "invalid_status_authority" =
    "invalid_invoke_authority",
): { readonly secret: string; readonly credentialIdSha256: string } {
  const currentSecret = env.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET;
  if (
    keyIdValue === env.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID
    && typeof currentSecret === "string"
    && new TextEncoder().encode(currentSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: currentSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    };
  }
  const previousSecret = env.JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET;
  if (
    keyIdValue === env.JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID
    && typeof previousSecret === "string"
    && new TextEncoder().encode(previousSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: previousSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256,
    };
  }
  throw authorizationError(invalidCode);
}

function selectStatusKey(
  env: JsonCompatibilityInvokerStatusOperatorEnv,
  keyIdValue: string,
): { readonly secret: string; readonly credentialIdSha256: string } {
  const currentSecret =
    env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET;
  if (
    keyIdValue === env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID
    && typeof currentSecret === "string"
    && new TextEncoder().encode(currentSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: currentSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    };
  }
  const previousSecret =
    env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_SECRET;
  if (
    keyIdValue === env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID
    && typeof previousSecret === "string"
    && new TextEncoder().encode(previousSecret).byteLength >= 32
    && SHA256.test(
      env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256,
    )
  ) {
    return {
      secret: previousSecret,
      credentialIdSha256:
        env.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256,
    };
  }
  throw authorizationError("invalid_status_authority");
}

function signingPayload(claims: JsonCompatibilityInvokeAuthorityClaimsV1): Uint8Array {
  return new TextEncoder().encode(`${SIGNATURE_DOMAIN}${canonicalJson(claims)}`);
}

function statusSigningPayload(
  claims: JsonCompatibilityInvocationStatusAuthorityClaimsV1,
): Uint8Array {
  return new TextEncoder().encode(
    `${STATUS_SIGNATURE_DOMAIN}${canonicalJson(claims)}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw authorizationError("invalid_invoke_command");
  }
  return value as Record<string, unknown>;
}

function statusRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw authorizationError("invalid_status_query");
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
    throw authorizationError("invalid_invoke_command");
  }
}

function statusExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw authorizationError("invalid_status_query");
  }
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) throw authorizationError("invalid_invoke_command");
  return expected;
}

function statusLiteral<T>(value: unknown, expected: T): T {
  if (value !== expected) throw authorizationError("invalid_status_query");
  return expected;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw authorizationError("invalid_invoke_command");
  }
  return value;
}

function statusToken(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw authorizationError("invalid_status_query");
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw authorizationError("invalid_invoke_command");
  }
  return value;
}

function statusSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw authorizationError("invalid_status_query");
  }
  return value;
}

function keyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw authorizationError("invalid_invoke_command");
  }
  return value;
}

function statusKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw authorizationError("invalid_status_query");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw authorizationError("invalid_invoke_command");
  }
  return value;
}

function statusInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw authorizationError("invalid_status_query");
  }
  return value;
}

function wholeSecond(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw authorizationError("invalid_invoke_command");
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

function constantTimeEqual(left: string, right: string): boolean {
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

function authorizationError(
  code: JsonCompatibilityInvokerAuthorizationError["code"],
): JsonCompatibilityInvokerAuthorizationError {
  return new JsonCompatibilityInvokerAuthorizationError(code);
}
