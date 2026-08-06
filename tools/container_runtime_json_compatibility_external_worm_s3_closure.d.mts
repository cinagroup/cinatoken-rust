import type {
  JsonCompatibilityExternalWormArchiveEvidenceV1,
} from "./container_runtime_json_compatibility_external_worm_archive.mjs";
import type {
  JsonCompatibilityExternalWormS3ReadbackObservationV1,
  JsonCompatibilityExternalWormS3WriterObservationV1,
} from "./container_runtime_json_compatibility_external_worm_s3_observation.mjs";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_BACKEND_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-backend-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_NAMESPACE_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-namespace-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBJECT_BINDING_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-object-binding-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-binding-closure-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_DECISION_SCOPE:
  "amazon-s3-provider-observation-to-external-worm-c2-evidence-binding-only";

export interface JsonCompatibilityExternalWormS3IdentityInputV1 {
  readonly provider: "amazon-s3";
  readonly region: string;
  readonly bucketNameSha256: string;
  readonly expectedBucketOwnerSha256: string;
  readonly objectKeySha256s: readonly string[];
}

export interface JsonCompatibilityExternalWormS3ArchiveIdentitiesV1
  extends JsonCompatibilityExternalWormS3IdentityInputV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-identity-v1";
  readonly objectKeySetSha256: string;
  readonly objectCount: number;
  readonly backendIdentitySha256: string;
  readonly namespaceIdentitySha256: string;
  readonly identitySha256: string;
}

export interface JsonCompatibilityExternalWormS3ObjectBindingV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-object-binding-v1";
  readonly provider: "amazon-s3";
  readonly region: string;
  readonly bucketNameSha256: string;
  readonly expectedBucketOwnerSha256: string;
  readonly objectDescriptorSha256: string;
  readonly objectKeySha256: string;
  readonly writerProviderObservationSha256: string;
  readonly readerProviderObservationSha256: string;
  readonly c2WriteObjectObservationSha256: string;
  readonly c2ReadbackObjectObservationSha256: string;
  readonly versionId: string;
  readonly versionIdSha256: string;
  readonly eTag: string;
  readonly eTagSha256: string;
  readonly checksumSha256Base64: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly metadataSha256: string;
  readonly writerRetainUntil: string;
  readonly writerRetainUntilEpochSeconds: number;
  readonly readbackRetainUntil: string;
  readonly readbackRetainUntilEpochSeconds: number;
  readonly writerObservedAt: string;
  readonly writerObservedAtEpochSeconds: number;
  readonly readbackObservedAt: string;
  readonly readbackObservedAtEpochSeconds: number;
  readonly writerProviderRequestIdSha256: string;
  readonly readerBucketVersioningRequestIdSha256: string;
  readonly readerBucketObjectLockRequestIdSha256: string;
  readonly readerObjectRequestIdSha256: string;
  readonly readerRetentionRequestIdSha256: string;
  readonly readerProviderRequestSetSha256: string;
  readonly writerCredentialIdSha256: string;
  readonly readerCredentialIdSha256: string;
  readonly readerWriterCredentialIdSha256: string;
  readonly objectBindingSha256: string;
}

export interface JsonCompatibilityExternalWormS3ClosureV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-binding-closure-v1";
  readonly kind:
    "container-runtime-json-compatibility-external-worm-s3-c2-binding-closure";
  readonly provider: "amazon-s3";
  readonly decisionScope:
    "amazon-s3-provider-observation-to-external-worm-c2-evidence-binding-only";
  readonly authorizesC2Closure: false;
  readonly archiveEvidenceSha256: string;
  readonly archivePolicySha256: string;
  readonly archiveManifestSha256: string;
  readonly identity: JsonCompatibilityExternalWormS3ArchiveIdentitiesV1;
  readonly writerCredentialIdSha256: string;
  readonly readerCredentialIdSha256: string;
  readonly rawWriterObservations:
    readonly JsonCompatibilityExternalWormS3WriterObservationV1[];
  readonly rawReadbackObservations:
    readonly JsonCompatibilityExternalWormS3ReadbackObservationV1[];
  readonly writerObservationSetSha256: string;
  readonly readbackObservationSetSha256: string;
  readonly bindings: readonly JsonCompatibilityExternalWormS3ObjectBindingV1[];
  readonly objectBindingSetSha256: string;
  readonly objectKeySetSha256: string;
  readonly objectCount: number;
  readonly closureSha256: string;
}

export class JsonCompatibilityExternalWormS3ClosureError extends Error {
  constructor(code: string);
  readonly code: string;
}

export function deriveJsonCompatibilityExternalWormS3ArchiveIdentities(
  input: JsonCompatibilityExternalWormS3IdentityInputV1,
): Promise<JsonCompatibilityExternalWormS3ArchiveIdentitiesV1>;

export function buildJsonCompatibilityExternalWormS3Closure(input: {
  readonly archiveEvidence: JsonCompatibilityExternalWormArchiveEvidenceV1;
  readonly target: JsonCompatibilityExternalWormS3IdentityInputV1;
  readonly writerObservations:
    readonly JsonCompatibilityExternalWormS3WriterObservationV1[];
  readonly readbackObservations:
    readonly JsonCompatibilityExternalWormS3ReadbackObservationV1[];
}): Promise<JsonCompatibilityExternalWormS3ClosureV1>;

export function validateJsonCompatibilityExternalWormS3Closure(
  archiveEvidence: JsonCompatibilityExternalWormArchiveEvidenceV1,
  input: unknown,
): Promise<JsonCompatibilityExternalWormS3ClosureV1>;
