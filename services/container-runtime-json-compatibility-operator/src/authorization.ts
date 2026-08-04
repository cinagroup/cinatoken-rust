import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorCallerV1,
  type JsonCompatibilityOperatorPhaseApprovalEnvelopeV1,
} from "./protocol";

export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER =
  "cinatoken-json-compatibility-campaign-approval-authority-staging" as const;
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-v1\n" as const;
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS = 600;
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_MIN_REMAINING_SECONDS = 180;

const CLOCK_SKEW_SECONDS = 5;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface JsonCompatibilityOperatorApprovalVerifierEnv {
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER: string;
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE: string;
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID: string;
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256: string;
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID: string;
  readonly JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256: string;
}

export interface VerifiedJsonCompatibilityOperatorApprovalV1 {
  readonly envelope: JsonCompatibilityOperatorPhaseApprovalEnvelopeV1;
  readonly envelopeSha256: string;
  readonly subjectSha256: string;
  readonly issuer: typeof JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER;
  readonly audience: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
  readonly keyId: string;
  readonly signerSpkiSha256: string;
  readonly caller: JsonCompatibilityOperatorCallerV1;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type JsonCompatibilityOperatorApprovalErrorCode =
  | "invalid_operator_phase_approval"
  | "operator_phase_approval_time_window"
  | "operator_approval_verifier_unavailable";

export class JsonCompatibilityOperatorApprovalError extends Error {
  constructor(readonly code: JsonCompatibilityOperatorApprovalErrorCode) {
    super(code);
    this.name = "JsonCompatibilityOperatorApprovalError";
  }
}

export async function verifyJsonCompatibilityOperatorApproval(
  env: JsonCompatibilityOperatorApprovalVerifierEnv,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  operatorVersionId: string,
  expectedRequestSha256: string,
  expectedCommandIdSha256: string,
  nowMilliseconds: number,
): Promise<VerifiedJsonCompatibilityOperatorApprovalV1> {
  const trust = requireApprovalTrust(env);
  const envelope = authorized.approval;
  const subject = envelope.subject;
  const request = authorized.request;
  if (
    subject.issuer !== JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER
    || subject.audience !== JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME
    || subject.operator.serviceName !== JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME
    || subject.operator.versionId !== operatorVersionId
    || subject.campaignIdSha256 !== request.execution.campaignIdSha256
    || subject.planDigestSha256 !== request.execution.planDigestSha256
    || subject.phaseExecutionId !== request.execution.phaseExecutionId
    || subject.phaseOrdinal !== request.execution.phase.ordinal
    || subject.phaseId !== request.execution.phase.id
    || subject.requestSha256 !== expectedRequestSha256
    || subject.commandIdSha256 !== expectedCommandIdSha256
    || subject.topologyReadbackSha256 !== request.topologyReadbackSha256
    || subject.beforeContextSha256 !== request.beforeContextSha256
  ) {
    throw approvalError("invalid_operator_phase_approval");
  }

  const selected = selectTrustKey(trust, subject.keyId);
  const now = Math.floor(nowMilliseconds / 1000);
  if (
    subject.issuedAt > now + CLOCK_SKEW_SECONDS
    || subject.notBefore > now + CLOCK_SKEW_SECONDS
    || subject.notBefore < subject.issuedAt - CLOCK_SKEW_SECONDS
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt
      > JSON_COMPATIBILITY_OPERATOR_APPROVAL_MAX_LIFETIME_SECONDS
    || subject.expiresAt - now
      < JSON_COMPATIBILITY_OPERATOR_APPROVAL_MIN_REMAINING_SECONDS
  ) {
    throw approvalError("operator_phase_approval_time_window");
  }

  const subjectSha256 = await sha256Hex(canonicalJson(subject));
  if (!constantTimeHexEqual(subjectSha256, envelope.subjectSha256)) {
    throw approvalError("invalid_operator_phase_approval");
  }

  let spki: Uint8Array;
  let signature: Uint8Array;
  try {
    spki = decodeBase64url(envelope.signerSpkiBase64url, 512);
    signature = decodeBase64url(envelope.signatureBase64url, 64, 64);
  } catch {
    throw approvalError("invalid_operator_phase_approval");
  }
  const signerSpkiSha256 = await sha256Hex(spki);
  if (!constantTimeHexEqual(signerSpkiSha256, selected.spkiSha256)) {
    throw approvalError("invalid_operator_phase_approval");
  }

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
    throw approvalError("operator_approval_verifier_unavailable");
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(operatorApprovalSigningPayload(envelope)),
    );
  } catch {
    throw approvalError("operator_approval_verifier_unavailable");
  }
  if (!valid) throw approvalError("invalid_operator_phase_approval");

  return {
    envelope,
    envelopeSha256: await sha256Hex(canonicalJson(envelope)),
    subjectSha256,
    issuer: JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    audience: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
    keyId: subject.keyId,
    signerSpkiSha256,
    caller: subject.caller,
    issuedAt: subject.issuedAt,
    notBefore: subject.notBefore,
    expiresAt: subject.expiresAt,
  };
}

export function operatorApprovalSigningPayload(
  envelope: Pick<JsonCompatibilityOperatorPhaseApprovalEnvelopeV1, "subject">,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(envelope.subject)}`,
  );
}

interface TrustKey {
  readonly keyId: string;
  readonly spkiSha256: string;
}

interface ApprovalTrust {
  readonly current: TrustKey;
  readonly previous: TrustKey | null;
}

function requireApprovalTrust(
  env: JsonCompatibilityOperatorApprovalVerifierEnv,
): ApprovalTrust {
  if (
    env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER
      !== JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER
    || env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE
      !== JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME
  ) {
    throw approvalError("operator_approval_verifier_unavailable");
  }
  const current = trustKey(
    env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID,
    env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256,
  );
  const previousKid = env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID;
  const previousSpki =
    env.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256;
  const previousEmpty = previousKid === "" && previousSpki === "";
  if ((previousKid === "") !== (previousSpki === "")) {
    throw approvalError("operator_approval_verifier_unavailable");
  }
  const previous = previousEmpty ? null : trustKey(previousKid, previousSpki);
  if (
    previous !== null
    && (
      previous.keyId === current.keyId
      || constantTimeHexEqual(previous.spkiSha256, current.spkiSha256)
    )
  ) {
    throw approvalError("operator_approval_verifier_unavailable");
  }
  return { current, previous };
}

function trustKey(keyId: unknown, spkiSha256: unknown): TrustKey {
  if (
    typeof keyId !== "string"
    || !KEY_ID.test(keyId)
    || typeof spkiSha256 !== "string"
    || !SHA256.test(spkiSha256)
  ) {
    throw approvalError("operator_approval_verifier_unavailable");
  }
  return { keyId, spkiSha256 };
}

function selectTrustKey(trust: ApprovalTrust, keyId: string): TrustKey {
  if (trust.current.keyId === keyId) return trust.current;
  if (trust.previous?.keyId === keyId) return trust.previous;
  throw approvalError("invalid_operator_phase_approval");
}

function decodeBase64url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength > maximumBytes
    || (exactBytes !== undefined && bytes.byteLength !== exactBytes)
    || encodeBase64url(bytes) !== value
  ) {
    throw new Error("invalid base64url length or encoding");
  }
  return bytes;
}

function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  return bytes.slice().buffer;
}

function approvalError(
  code: JsonCompatibilityOperatorApprovalErrorCode,
): JsonCompatibilityOperatorApprovalError {
  return new JsonCompatibilityOperatorApprovalError(code);
}
