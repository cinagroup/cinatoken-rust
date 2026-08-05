import type {
  JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";

export const JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-signature-envelope-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER:
  "cinatoken-json-compatibility-source-archive-authority-staging";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE:
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_MIN_REMAINING_SECONDS: 900;

export interface JsonCompatibilitySourceSignatureSubjectV1
  extends Readonly<Record<string, unknown>> {
  readonly keyId: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilitySourceSignatureEnvelopeV1
  extends Readonly<Record<string, unknown>> {
  readonly subject: JsonCompatibilitySourceSignatureSubjectV1;
  readonly subjectSha256: string;
  readonly signerSpkiBase64url: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilitySourceAuthenticationBundleV1
  extends Readonly<Record<string, unknown>> {
  readonly sourceSignatureEnvelope:
    JsonCompatibilitySourceSignatureEnvelopeV1;
  readonly bundleSha256: string;
}

export class JsonCompatibilitySourceAuthenticationProtocolError
  extends Error {
  readonly code: string;
}

export function buildJsonCompatibilitySourceVerifierPolicy(input: {
  readonly serviceName: string;
  readonly profileVersion: number;
  readonly keyPrefix: string;
  readonly issuer: string;
  readonly audience: string;
  readonly current: {
    readonly keyId: string;
    readonly spkiSha256: string;
  };
  readonly previous: {
    readonly keyId: string;
    readonly spkiSha256: string;
    readonly acceptUntil: number;
  } | null;
}): Readonly<Record<string, unknown>> & {
  readonly sourceVerifierPolicySha256: string;
};

export function buildJsonCompatibilitySourceVerifierIdentity(input: {
  readonly versionId: string;
  readonly sourceVerifierPolicySha256: string;
}): Readonly<Record<string, unknown>> & {
  readonly sourceVerifierIdentitySha256: string;
};

export function validateJsonCompatibilitySourceAuthenticationBundle(
  request: JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  input: unknown,
  options?: {
    readonly now?: number | null;
    readonly requireUsableWindow?: boolean;
  },
): JsonCompatibilitySourceAuthenticationBundleV1;

export function validateJsonCompatibilitySourceSignatureEnvelope(
  input: unknown,
): JsonCompatibilitySourceSignatureEnvelopeV1;

export function sourceSignatureSigningPayload(
  subject: unknown,
): Uint8Array;

export function sourceAuthenticationBundleKey(
  sourceSignatureEnvelopeSha256: string,
  prefix?: string,
): string;

export function sourceAuthenticationRevocationKey(
  signerSpkiSha256: string,
  prefix?: string,
): string;
