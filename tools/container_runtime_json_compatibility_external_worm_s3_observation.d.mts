export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION: 1;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER: "amazon-s3";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE:
  "amazon-s3-object-lock-data-plane-observation-only";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_READBACK_REQUEST_SET_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-readback-request-set-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES: number;

export interface JsonCompatibilityExternalWormS3ObservationTargetV1 {
  readonly region: string;
  readonly bucketNameSha256: string;
  readonly objectKeySha256: string;
  readonly expectedBucketOwnerSha256: string;
}

export interface JsonCompatibilityExternalWormS3ObservationCredentialV1 {
  readonly role: "writer" | "reader";
  readonly credentialIdSha256: string;
  readonly expiresAt: string;
}

export interface JsonCompatibilityExternalWormS3ObjectFactsV1 {
  readonly contentLength: number;
  readonly contentSha256: string;
  readonly checksumSha256Base64: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly metadataSha256: string;
  readonly objectLockMode: "COMPLIANCE";
  readonly retainUntil: string;
}

export interface JsonCompatibilityExternalWormS3WriterObservationV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
  readonly provider: "amazon-s3";
  readonly decisionScope:
    "amazon-s3-object-lock-data-plane-observation-only";
  readonly authorizesC2Closure: false;
  readonly operation: "put-object";
  readonly observedAt: string;
  readonly target: JsonCompatibilityExternalWormS3ObservationTargetV1;
  readonly credential: JsonCompatibilityExternalWormS3ObservationCredentialV1 & {
    readonly role: "writer";
  };
  readonly requested: JsonCompatibilityExternalWormS3ObjectFactsV1 & {
    readonly ifNoneMatch: "*";
  };
  readonly providerResponse: {
    readonly versionId: string;
    readonly versionIdSha256: string;
    readonly eTag: string;
    readonly eTagSha256: string;
    readonly checksumSha256Base64: string;
    readonly httpStatusCode: 200;
    readonly providerRequestIdSha256: string;
  };
  readonly providerReadback: null;
  readonly classification: "observed";
  readonly providerCallsAttempted: 1;
  readonly retryPerformed: false;
}

export interface JsonCompatibilityExternalWormS3ReadbackObservationV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
  readonly provider: "amazon-s3";
  readonly decisionScope:
    "amazon-s3-object-lock-data-plane-observation-only";
  readonly authorizesC2Closure: false;
  readonly operation: "independent-readback";
  readonly observedAt: string;
  readonly target: JsonCompatibilityExternalWormS3ObservationTargetV1;
  readonly credential: JsonCompatibilityExternalWormS3ObservationCredentialV1 & {
    readonly role: "reader";
  };
  readonly writerCredentialIdSha256: string;
  readonly requested: JsonCompatibilityExternalWormS3ObjectFactsV1 & {
    readonly versionId: string;
    readonly versionIdSha256: string;
    readonly eTag: string;
    readonly eTagSha256: string;
    readonly checksumMode: "ENABLED";
  };
  readonly providerReadback: {
    readonly bucket: {
      readonly versioning: "Enabled";
      readonly objectLock: "Enabled";
      readonly versioningRequestIdSha256: string;
      readonly objectLockRequestIdSha256: string;
    };
    readonly object: JsonCompatibilityExternalWormS3ObjectFactsV1 & {
      readonly versionId: string;
      readonly versionIdSha256: string;
      readonly eTag: string;
      readonly eTagSha256: string;
      readonly providerRequestIdSha256: string;
    };
    readonly retention: {
      readonly objectLockMode: "COMPLIANCE";
      readonly retainUntil: string;
      readonly providerRequestIdSha256: string;
    };
  };
  readonly classification: "observed";
  readonly providerCallsAttempted: 4;
  readonly retryPerformed: false;
}

export class JsonCompatibilityExternalWormS3ObservationError extends Error {
  constructor(code: string);
  readonly code: string;
}

export function canonicalJsonCompatibilityExternalWormS3Json(
  value: unknown,
): string;

export function sha256JsonCompatibilityExternalWormS3Bytes(
  value: Uint8Array,
): Promise<string>;

export function sha256JsonCompatibilityExternalWormS3Text(
  value: string,
): Promise<string>;

export function sha256JsonCompatibilityExternalWormS3Canonical(
  value: unknown,
): Promise<string>;

export function validateJsonCompatibilityExternalWormS3WriterObservation(
  input: unknown,
): Promise<JsonCompatibilityExternalWormS3WriterObservationV1>;

export function validateJsonCompatibilityExternalWormS3ReadbackObservation(
  input: unknown,
): Promise<JsonCompatibilityExternalWormS3ReadbackObservationV1>;

export function deriveJsonCompatibilityExternalWormS3ReadbackRequestSetSha256(
  observation: unknown,
): Promise<string>;
