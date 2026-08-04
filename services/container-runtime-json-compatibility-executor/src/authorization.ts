import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JsonCompatibilityExecutorProtocolError,
  type JsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityPhasePermitEnvelopeV1,
} from "./protocol";

const PERMIT_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-phase-permit-v1\n";
const CLOCK_SKEW_SECONDS = 5;
const MAX_PERMIT_LIFETIME_SECONDS = 600;
const MIN_REMAINING_LIFETIME_SECONDS = 180;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityPermitVerifierEnv {
  readonly JSON_COMPATIBILITY_PERMIT_ISSUER: string;
  readonly JSON_COMPATIBILITY_PERMIT_AUDIENCE: string;
  readonly JSON_COMPATIBILITY_PERMIT_KEY_ID: string;
  readonly JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: string;
  readonly JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL?: string;
}

export interface VerifiedJsonCompatibilityPhasePermitV1 {
  readonly permitIdSha256: string;
  readonly subjectSha256: string;
  readonly envelopeSha256: string;
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly signerSpkiSha256: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export async function verifyJsonCompatibilityPhasePermit(
  env: JsonCompatibilityPermitVerifierEnv,
  request: JsonCompatibilityExecutePhaseRequestV2,
  executorVersionId: string,
  nowMilliseconds: number,
): Promise<VerifiedJsonCompatibilityPhasePermitV1> {
  const issuer = requireConfiguredIdentity(
    env.JSON_COMPATIBILITY_PERMIT_ISSUER,
    "permit issuer",
  );
  const audience = requireConfiguredIdentity(
    env.JSON_COMPATIBILITY_PERMIT_AUDIENCE,
    "permit audience",
  );
  const keyId = requireConfiguredKeyId(
    env.JSON_COMPATIBILITY_PERMIT_KEY_ID,
  );
  const signerSpkiSha256 = requireConfiguredSha256(
    env.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256,
    "permit SPKI digest",
  );
  const envelope = request.authorization;
  const subject = envelope.subject;
  if (
    subject.issuer !== issuer
    || subject.audience !== audience
    || subject.keyId !== keyId
    || subject.executor.versionId !== executorVersionId
  ) {
    throw permitError(
      "invalid_phase_permit",
      "phase permit trust identity or executor version does not match",
    );
  }

  const now = Math.floor(nowMilliseconds / 1000);
  if (
    subject.issuedAt > now + CLOCK_SKEW_SECONDS
    || subject.notBefore > now + CLOCK_SKEW_SECONDS
    || subject.notBefore < subject.issuedAt - CLOCK_SKEW_SECONDS
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt > MAX_PERMIT_LIFETIME_SECONDS
    || subject.expiresAt - now < MIN_REMAINING_LIFETIME_SECONDS
  ) {
    throw permitError(
      "phase_permit_time_window",
      "phase permit is outside the approved execution time window",
    );
  }

  const subjectSha256 = await sha256Hex(canonicalJson(subject));
  if (!constantTimeHexEqual(subjectSha256, envelope.subjectSha256)) {
    throw permitError(
      "invalid_phase_permit",
      "phase permit subject digest does not match",
    );
  }

  const spkiBase64url = env.JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL;
  if (typeof spkiBase64url !== "string" || spkiBase64url.length === 0) {
    throw verifierUnavailable("phase permit SPKI is not provisioned");
  }
  let spki: Uint8Array;
  try {
    spki = decodeBase64url(spkiBase64url, 512);
  } catch {
    throw verifierUnavailable("phase permit verifier material is malformed");
  }
  let signature: Uint8Array;
  try {
    signature = decodeBase64url(envelope.signatureBase64url, 64, 64);
  } catch {
    throw permitError(
      "invalid_phase_permit",
      "phase permit signature encoding is invalid",
    );
  }
  const actualSpkiSha256 = await sha256Hex(spki);
  if (!constantTimeHexEqual(actualSpkiSha256, signerSpkiSha256)) {
    throw verifierUnavailable("phase permit SPKI digest does not match");
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
    throw verifierUnavailable("phase permit Ed25519 key cannot be imported");
  }
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(
        new TextEncoder().encode(
          `${PERMIT_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
        ),
      ),
    );
  } catch {
    throw verifierUnavailable("phase permit signature verification failed");
  }
  if (!valid) {
    throw permitError(
      "invalid_phase_permit",
      "phase permit signature is invalid",
    );
  }

  return {
    permitIdSha256: subject.permitIdSha256,
    subjectSha256,
    envelopeSha256: await sha256Hex(canonicalJson(envelope)),
    issuer,
    audience,
    keyId,
    signerSpkiSha256,
    issuedAt: subject.issuedAt,
    notBefore: subject.notBefore,
    expiresAt: subject.expiresAt,
  };
}

export function jsonCompatibilityPermitSigningPayload(
  envelope: JsonCompatibilityPhasePermitEnvelopeV1,
): Uint8Array {
  return new TextEncoder().encode(
    `${PERMIT_SIGNATURE_DOMAIN}${canonicalJson(envelope.subject)}`,
  );
}

function requireConfiguredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTITY.test(value)) {
    throw verifierUnavailable(`${label} is not configured`);
  }
  return value;
}

function requireConfiguredKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw verifierUnavailable("permit key ID is not configured");
  }
  return value;
}

function requireConfiguredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw verifierUnavailable(`${label} is not configured`);
  }
  return value;
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

function permitError(
  code: "invalid_phase_permit" | "phase_permit_time_window",
  message: string,
): JsonCompatibilityExecutorProtocolError {
  return new JsonCompatibilityExecutorProtocolError(code, message);
}

function verifierUnavailable(
  message: string,
): JsonCompatibilityExecutorProtocolError {
  return new JsonCompatibilityExecutorProtocolError(
    "phase_permit_verifier_unavailable",
    message,
  );
}
