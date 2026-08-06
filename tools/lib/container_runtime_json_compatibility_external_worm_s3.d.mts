export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION: 1;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER: "amazon-s3";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE:
  "amazon-s3-object-lock-data-plane-observation-only";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_CREDENTIAL_REMAINING_SECONDS:
  3600;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MIN_CREDENTIAL_REMAINING_SECONDS:
  60;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES: number;

export type JsonCompatibilityExternalWormS3Role = "writer" | "reader";

export interface JsonCompatibilityExternalWormS3RoleEnvironmentNames {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT: Readonly<{
  readonly writer: Readonly<JsonCompatibilityExternalWormS3RoleEnvironmentNames>;
  readonly reader: Readonly<JsonCompatibilityExternalWormS3RoleEnvironmentNames>;
}>;

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_FORBIDDEN_CREDENTIAL_ENVIRONMENT:
  readonly string[];

export class JsonCompatibilityExternalWormS3InputError extends Error {
  constructor(code: string);
  readonly code: string;
}

export interface JsonCompatibilityExternalWormS3RoleCredentials {
  readonly role: JsonCompatibilityExternalWormS3Role;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly credentialIdSha256: string;
}

export interface JsonCompatibilityExternalWormS3Target {
  readonly provider: "amazon-s3";
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly expectedBucketOwner: string;
}

export interface JsonCompatibilityExternalWormS3PublishObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly retainUntil: string;
}

export type JsonCompatibilityExternalWormS3MaybePromise<T> =
  T | PromiseLike<T>;

export interface JsonCompatibilityExternalWormS3ProviderMetadata {
  readonly httpStatusCode?: number;
  readonly requestId?: string;
}

export interface JsonCompatibilityExternalWormS3PutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: Uint8Array;
  readonly ContentLength: number;
  readonly ContentType: string;
  readonly Metadata: Readonly<Record<string, string>>;
  readonly IfNoneMatch: "*";
  readonly ObjectLockMode: "COMPLIANCE";
  readonly ObjectLockRetainUntilDate: Date;
  readonly ChecksumSHA256: string;
  readonly ExpectedBucketOwner: string;
}

export interface JsonCompatibilityExternalWormS3PutObjectOutput {
  readonly $metadata?: JsonCompatibilityExternalWormS3ProviderMetadata;
  readonly VersionId?: string;
  readonly ETag?: string;
  readonly ChecksumSHA256?: string;
}

export interface JsonCompatibilityExternalWormS3BucketInput {
  readonly Bucket: string;
  readonly ExpectedBucketOwner: string;
}

export interface JsonCompatibilityExternalWormS3BucketVersioningOutput {
  readonly $metadata?: JsonCompatibilityExternalWormS3ProviderMetadata;
  readonly Status?: string;
}

export interface JsonCompatibilityExternalWormS3ObjectLockOutput {
  readonly $metadata?: JsonCompatibilityExternalWormS3ProviderMetadata;
  readonly ObjectLockConfiguration?: {
    readonly ObjectLockEnabled?: string;
  };
}

export interface JsonCompatibilityExternalWormS3VersionedObjectInput
  extends JsonCompatibilityExternalWormS3BucketInput {
  readonly Key: string;
  readonly VersionId: string;
}

export interface JsonCompatibilityExternalWormS3GetObjectInput
  extends JsonCompatibilityExternalWormS3VersionedObjectInput {
  readonly ChecksumMode: "ENABLED";
}

export type JsonCompatibilityExternalWormS3BodyChunk =
  Uint8Array | ArrayBuffer | ArrayBufferView;

export type JsonCompatibilityExternalWormS3StreamingBody =
  | Uint8Array
  | ArrayBuffer
  | AsyncIterable<JsonCompatibilityExternalWormS3BodyChunk>
  | ReadableStream<JsonCompatibilityExternalWormS3BodyChunk>;

export interface JsonCompatibilityExternalWormS3GetObjectOutput {
  readonly $metadata?: JsonCompatibilityExternalWormS3ProviderMetadata;
  readonly Body?: JsonCompatibilityExternalWormS3StreamingBody;
  readonly VersionId?: string;
  readonly ETag?: string;
  readonly ContentLength?: number;
  readonly ContentType?: string;
  readonly ChecksumSHA256?: string;
  readonly Metadata?: Readonly<Record<string, string>>;
  readonly ObjectLockMode?: string;
  readonly ObjectLockRetainUntilDate?: Date;
}

export interface JsonCompatibilityExternalWormS3RetentionOutput {
  readonly $metadata?: JsonCompatibilityExternalWormS3ProviderMetadata;
  readonly Retention?: {
    readonly Mode?: string;
    readonly RetainUntilDate?: Date;
  };
}

export interface JsonCompatibilityExternalWormS3Adapter {
  readonly provider: "amazon-s3";
  readonly region: string;
  readonly maxAttempts: 1;
  putObject?(
    input: JsonCompatibilityExternalWormS3PutObjectInput,
    signal: AbortSignal,
  ): JsonCompatibilityExternalWormS3MaybePromise<
    JsonCompatibilityExternalWormS3PutObjectOutput
  >;
  getBucketVersioning?(
    input: JsonCompatibilityExternalWormS3BucketInput,
    signal: AbortSignal,
  ): JsonCompatibilityExternalWormS3MaybePromise<
    JsonCompatibilityExternalWormS3BucketVersioningOutput
  >;
  getObjectLockConfiguration?(
    input: JsonCompatibilityExternalWormS3BucketInput,
    signal: AbortSignal,
  ): JsonCompatibilityExternalWormS3MaybePromise<
    JsonCompatibilityExternalWormS3ObjectLockOutput
  >;
  getObject?(
    input: JsonCompatibilityExternalWormS3GetObjectInput,
    signal: AbortSignal,
  ): JsonCompatibilityExternalWormS3MaybePromise<
    JsonCompatibilityExternalWormS3GetObjectOutput
  >;
  getObjectRetention?(
    input: JsonCompatibilityExternalWormS3VersionedObjectInput,
    signal: AbortSignal,
  ): JsonCompatibilityExternalWormS3MaybePromise<
    JsonCompatibilityExternalWormS3RetentionOutput
  >;
  destroy?(): void;
}

export interface JsonCompatibilityExternalWormS3ObservationTarget {
  readonly region: string;
  readonly bucketNameSha256: string;
  readonly objectKeySha256: string;
  readonly expectedBucketOwnerSha256: string;
}

export interface JsonCompatibilityExternalWormS3ObservationCredential {
  readonly role: JsonCompatibilityExternalWormS3Role;
  readonly credentialIdSha256: string;
  readonly expiresAt: string;
}

export interface JsonCompatibilityExternalWormS3ObservationBase {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
  readonly provider: "amazon-s3";
  readonly decisionScope:
    "amazon-s3-object-lock-data-plane-observation-only";
  readonly authorizesC2Closure: false;
  readonly operation: "put-object" | "independent-readback";
  readonly observedAt: string;
  readonly target: JsonCompatibilityExternalWormS3ObservationTarget;
  readonly credential: JsonCompatibilityExternalWormS3ObservationCredential;
  readonly providerCallsAttempted: number;
  readonly retryPerformed: false;
}

export interface JsonCompatibilityExternalWormS3RequestedObjectFacts {
  readonly contentLength: number;
  readonly contentSha256: string;
  readonly checksumSha256Base64: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly metadataSha256: string;
  readonly objectLockMode: "COMPLIANCE";
  readonly retainUntil: string;
}

export interface JsonCompatibilityExternalWormS3PublicationRequested
  extends JsonCompatibilityExternalWormS3RequestedObjectFacts {
  readonly ifNoneMatch: "*";
}

export interface JsonCompatibilityExternalWormS3ProviderResponse {
  readonly httpStatusCode: 200;
  readonly versionId: string;
  readonly versionIdSha256: string;
  readonly eTag: string;
  readonly eTagSha256: string;
  readonly checksumSha256Base64: string;
  readonly providerRequestIdSha256: string;
}

export interface JsonCompatibilityExternalWormS3ReadbackRequested
  extends JsonCompatibilityExternalWormS3RequestedObjectFacts {
  readonly versionId: string;
  readonly versionIdSha256: string;
  readonly eTag: string;
  readonly eTagSha256: string;
  readonly checksumMode: "ENABLED";
}

export interface JsonCompatibilityExternalWormS3ProviderReadback {
  readonly bucket: {
    readonly versioning: "Enabled";
    readonly objectLock: "Enabled";
    readonly versioningRequestIdSha256: string | null;
    readonly objectLockRequestIdSha256: string | null;
  };
  readonly object: JsonCompatibilityExternalWormS3RequestedObjectFacts & {
    readonly versionId: string;
    readonly versionIdSha256: string;
    readonly eTag: string;
    readonly eTagSha256: string;
    readonly providerRequestIdSha256: string | null;
  };
  readonly retention: {
    readonly objectLockMode: "COMPLIANCE";
    readonly retainUntil: string;
    readonly providerRequestIdSha256: string | null;
  };
}

export interface JsonCompatibilityExternalWormS3PublicationObserved
  extends JsonCompatibilityExternalWormS3ObservationBase {
  readonly operation: "put-object";
  readonly classification: "observed";
  readonly providerCallsAttempted: 1;
  readonly requested: JsonCompatibilityExternalWormS3PublicationRequested;
  readonly providerResponse: JsonCompatibilityExternalWormS3ProviderResponse;
  readonly providerReadback: null;
}

export interface JsonCompatibilityExternalWormS3ReadbackObserved
  extends JsonCompatibilityExternalWormS3ObservationBase {
  readonly operation: "independent-readback";
  readonly classification: "observed";
  readonly writerCredentialIdSha256: string;
  readonly requested: JsonCompatibilityExternalWormS3ReadbackRequested;
  readonly providerReadback: JsonCompatibilityExternalWormS3ProviderReadback;
}

export interface JsonCompatibilityExternalWormS3ObservationError {
  readonly category:
    | "timeout"
    | "provider-error"
    | "incomplete-provider-response";
  readonly code: string;
  readonly httpStatusCode: number | null;
  readonly providerRequestIdSha256: string | null;
}

export interface JsonCompatibilityExternalWormS3PublicationAmbiguous
  extends JsonCompatibilityExternalWormS3ObservationBase {
  readonly operation: "put-object";
  readonly classification: "ambiguous";
  readonly requested: JsonCompatibilityExternalWormS3PublicationRequested;
  readonly providerResponse: null;
  readonly providerReadback: null;
  readonly phase: string;
  readonly error: JsonCompatibilityExternalWormS3ObservationError;
}

export interface JsonCompatibilityExternalWormS3ReadbackAmbiguous
  extends JsonCompatibilityExternalWormS3ObservationBase {
  readonly operation: "independent-readback";
  readonly classification: "ambiguous";
  readonly writerCredentialIdSha256: string;
  readonly requested: JsonCompatibilityExternalWormS3ReadbackRequested;
  readonly providerReadback: null;
  readonly phase: string;
  readonly error: JsonCompatibilityExternalWormS3ObservationError;
}

export interface JsonCompatibilityExternalWormS3MismatchObservation
  extends JsonCompatibilityExternalWormS3ObservationBase {
  readonly operation: "independent-readback";
  readonly classification: "mismatch";
  readonly writerCredentialIdSha256: string;
  readonly requested: JsonCompatibilityExternalWormS3ReadbackRequested;
  readonly providerReadback: null;
  readonly phase: string;
  readonly mismatch: {
    readonly code: string;
  };
}

export type JsonCompatibilityExternalWormS3PublicationObservation =
  | JsonCompatibilityExternalWormS3PublicationObserved
  | JsonCompatibilityExternalWormS3PublicationAmbiguous;

export type JsonCompatibilityExternalWormS3ReadbackObservation =
  | JsonCompatibilityExternalWormS3ReadbackObserved
  | JsonCompatibilityExternalWormS3ReadbackAmbiguous
  | JsonCompatibilityExternalWormS3MismatchObservation;

export function readJsonCompatibilityExternalWormS3RoleCredentials(
  role: JsonCompatibilityExternalWormS3Role,
  environment: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly now?: number;
    readonly maximumRemainingSeconds?: number;
    readonly minimumRemainingSeconds?: number;
  },
): JsonCompatibilityExternalWormS3RoleCredentials;

export function createJsonCompatibilityExternalWormS3AwsAdapter(input: {
  readonly region: string;
  readonly credentials: JsonCompatibilityExternalWormS3RoleCredentials;
}): JsonCompatibilityExternalWormS3Adapter & {
  readonly region: string;
  readonly maxAttempts: 1;
  putObject(
    input: JsonCompatibilityExternalWormS3PutObjectInput,
    signal: AbortSignal,
  ): Promise<JsonCompatibilityExternalWormS3PutObjectOutput>;
  getBucketVersioning(
    input: JsonCompatibilityExternalWormS3BucketInput,
    signal: AbortSignal,
  ): Promise<JsonCompatibilityExternalWormS3BucketVersioningOutput>;
  getObjectLockConfiguration(
    input: JsonCompatibilityExternalWormS3BucketInput,
    signal: AbortSignal,
  ): Promise<JsonCompatibilityExternalWormS3ObjectLockOutput>;
  getObject(
    input: JsonCompatibilityExternalWormS3GetObjectInput,
    signal: AbortSignal,
  ): Promise<JsonCompatibilityExternalWormS3GetObjectOutput>;
  getObjectRetention(
    input: JsonCompatibilityExternalWormS3VersionedObjectInput,
    signal: AbortSignal,
  ): Promise<JsonCompatibilityExternalWormS3RetentionOutput>;
  destroy(): void;
};

export function publishJsonCompatibilityExternalWormS3Object(input: {
  readonly adapter: JsonCompatibilityExternalWormS3Adapter & {
    readonly putObject: NonNullable<
      JsonCompatibilityExternalWormS3Adapter["putObject"]
    >;
  };
  readonly credentials: JsonCompatibilityExternalWormS3RoleCredentials;
  readonly target: JsonCompatibilityExternalWormS3Target;
  readonly object: JsonCompatibilityExternalWormS3PublishObject;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}): Promise<JsonCompatibilityExternalWormS3PublicationObservation>;

export function readBackJsonCompatibilityExternalWormS3Object(input: {
  readonly adapter: JsonCompatibilityExternalWormS3Adapter & {
    readonly getBucketVersioning: NonNullable<
      JsonCompatibilityExternalWormS3Adapter["getBucketVersioning"]
    >;
    readonly getObjectLockConfiguration: NonNullable<
      JsonCompatibilityExternalWormS3Adapter[
        "getObjectLockConfiguration"
      ]
    >;
    readonly getObject: NonNullable<
      JsonCompatibilityExternalWormS3Adapter["getObject"]
    >;
    readonly getObjectRetention: NonNullable<
      JsonCompatibilityExternalWormS3Adapter["getObjectRetention"]
    >;
  };
  readonly credentials: JsonCompatibilityExternalWormS3RoleCredentials;
  readonly target: JsonCompatibilityExternalWormS3Target;
  readonly publication: JsonCompatibilityExternalWormS3PublicationObserved;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}): Promise<JsonCompatibilityExternalWormS3ReadbackObservation>;
