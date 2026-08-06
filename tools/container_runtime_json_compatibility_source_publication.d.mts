import type {
  JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";
import type {
  JsonCompatibilitySourceAuthenticationBundleV3,
} from "./container_runtime_json_compatibility_source_authentication.mjs";

export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_PACKET_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-publication-packet-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_WRITE_RECEIPT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-publication-write-receipt-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_REQUEST_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-publication-readback-request-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_RECEIPT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-publication-readback-receipt-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME:
  "cinatoken-container-runtime-json-compatibility-source-publisher-staging";
export const JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";

export interface JsonCompatibilitySourcePublicationObjectMetadataV1 {
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3";
  readonly bundleSha256: string;
  readonly sourceSignatureEnvelopeSha256: string;
}

export interface JsonCompatibilitySourcePublicationPacketV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-publication-packet-v1";
  readonly environment: "staging";
  readonly sourceAuthenticationRequest:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
  readonly bundle: JsonCompatibilitySourceAuthenticationBundleV3;
  readonly bundleKey: string;
  readonly bundleSha256: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly sourceSignatureEnvelopeSha256: string;
  readonly objectMetadata: JsonCompatibilitySourcePublicationObjectMetadataV1;
  readonly publicationPacketSha256: string;
}

export interface JsonCompatibilitySourcePublicationWriteReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-publication-write-receipt-v1";
  readonly environment: "staging";
  readonly publisherServiceName:
    "cinatoken-container-runtime-json-compatibility-source-publisher-staging";
  readonly publisherVersionId: string;
  readonly sourceAuthenticationRequestSha256: string;
  readonly bundleKey: string;
  readonly bundleSha256: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly sourceSignatureEnvelopeSha256: string;
  readonly objectVersionSha256: string;
  readonly objectEtagSha256: string;
  readonly publishedAt: number;
  readonly createOnly: true;
  readonly writeAttemptCount: 1;
  readonly retryPerformed: false;
  readonly readbackPerformed: false;
  readonly writeReceiptSha256: string;
}

export interface JsonCompatibilitySourcePublicationReadbackReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-publication-readback-receipt-v1";
  readonly environment: "staging";
  readonly sourcePublicationReadbackRequestSha256: string;
  readonly publicationPacketSha256: string;
  readonly writeOutcome: "published" | "ambiguous";
  readonly writeReceiptSha256: string | null;
  readonly publisherServiceName:
    | "cinatoken-container-runtime-json-compatibility-source-publisher-staging"
    | null;
  readonly publisherVersionId: string | null;
  readonly sourceVerifierServiceName:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly sourceVerifierVersionId: string;
  readonly sourceAuthenticationRequestSha256: string;
  readonly bundleKey: string;
  readonly bundleSha256: string;
  readonly bodySha256: string;
  readonly bodyByteLength: number;
  readonly sourceSignatureEnvelopeSha256: string;
  readonly objectVersionSha256: string;
  readonly objectEtagSha256: string;
  readonly objectMetadataSha256: string;
  readonly signerSpkiSha256: string;
  readonly verifierIdentitySha256: string;
  readonly verifiedAt: number;
  readonly exactBodyReadback: true;
  readonly exactVersionReadback: true;
  readonly exactEtagReadback: true;
  readonly exactMetadataReadback: true;
  readonly independentFromPublisher: true;
  readonly readbackReceiptSha256: string;
}

export interface JsonCompatibilitySourcePublicationReadbackRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-publication-readback-request-v1";
  readonly environment: "staging";
  readonly sourceAuthenticationRequest:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
  readonly expectedPublicationPacketSha256: string;
  readonly writeOutcome: "published" | "ambiguous";
  readonly writeReceipt: JsonCompatibilitySourcePublicationWriteReceiptV1
    | null;
  readonly sourcePublicationReadbackRequestSha256: string;
}

export class JsonCompatibilitySourcePublicationProtocolError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildJsonCompatibilitySourcePublicationPacket(
  input: {
    readonly sourceAuthenticationRequest:
      JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
    readonly bundle: JsonCompatibilitySourceAuthenticationBundleV3;
  },
  options?: {
    readonly now?: number | null;
    readonly requireUsableWindow?: boolean;
  },
): JsonCompatibilitySourcePublicationPacketV1;

export function validateJsonCompatibilitySourcePublicationPacket(
  input: unknown,
  options?: {
    readonly now?: number | null;
    readonly requireUsableWindow?: boolean;
  },
): JsonCompatibilitySourcePublicationPacketV1;

export function sourcePublicationBundleBody(
  bundle: JsonCompatibilitySourceAuthenticationBundleV3,
): string;

export function sourcePublicationObjectMetadata(
  bundleSha256: string,
  sourceSignatureEnvelopeSha256: string,
): JsonCompatibilitySourcePublicationObjectMetadataV1;

export function buildJsonCompatibilitySourcePublicationWriteReceipt(
  input: Omit<JsonCompatibilitySourcePublicationWriteReceiptV1,
    "schemaVersion" | "contract" | "environment" | "createOnly"
    | "writeAttemptCount" | "retryPerformed" | "readbackPerformed"
    | "writeReceiptSha256">,
): JsonCompatibilitySourcePublicationWriteReceiptV1;

export function validateJsonCompatibilitySourcePublicationWriteReceipt(
  input: unknown,
): JsonCompatibilitySourcePublicationWriteReceiptV1;

export function buildJsonCompatibilitySourcePublicationReadbackRequest(
  input: {
    readonly sourceAuthenticationRequest:
      JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
    readonly expectedPublicationPacketSha256: string;
    readonly writeOutcome: "published" | "ambiguous";
    readonly writeReceipt: JsonCompatibilitySourcePublicationWriteReceiptV1
      | null;
  },
): JsonCompatibilitySourcePublicationReadbackRequestV1;

export function validateJsonCompatibilitySourcePublicationReadbackRequest(
  input: unknown,
): JsonCompatibilitySourcePublicationReadbackRequestV1;

export function buildJsonCompatibilitySourcePublicationReadbackReceipt(
  input: Omit<JsonCompatibilitySourcePublicationReadbackReceiptV1,
    "schemaVersion" | "contract" | "environment" | "exactBodyReadback"
    | "exactVersionReadback" | "exactEtagReadback"
    | "exactMetadataReadback" | "independentFromPublisher"
    | "readbackReceiptSha256">,
): JsonCompatibilitySourcePublicationReadbackReceiptV1;
