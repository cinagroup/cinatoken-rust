export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-policy-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_PASS_ROOT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-pass-root-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_DESCRIPTOR_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-descriptor-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_MANIFEST_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-manifest-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_OBSERVATION_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_WRITE_OBSERVATION_SUBJECT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-write-observation-subject-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_OBSERVATION_SUBJECT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-readback-observation-subject-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ATTESTATION_ENVELOPE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-attestation-envelope-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_EVIDENCE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-evidence-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN:
  "cinatoken-container-runtime-json-compatibility-external-worm-writer-attestation-v1\n";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN:
  "cinatoken-container-runtime-json-compatibility-external-worm-independent-readback-attestation-v1\n";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS: 31536000;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS: 5;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_READBACK_DELAY_SECONDS: 900;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT: 512;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES: 805306368;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_ROLES: readonly [
  "account-binding-evidence",
  "account-binding-inventory",
  "artifact-inventory-readback",
  "campaign-plan",
  "capture-manifest",
  "capture-terminal",
  "collection-artifact",
  "collection-profile",
  "collector-identity",
  "page-receipt",
  "phase-source-manifest",
  "raw-response-body",
  "state-plan",
  "transition-source-manifest",
];

export type JsonCompatibilityExternalWormCollectionMode =
  | "collection"
  | "independent-readback";
export type JsonCompatibilityExternalWormAttestationRole =
  | "writer"
  | "independent-readback";
export type JsonCompatibilityExternalWormArchiveObjectRole =
  (typeof JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_ROLES)[number];

export interface JsonCompatibilityExternalWormTrustActorV1 {
  readonly keyId: string;
  readonly spkiSha256: string;
  readonly spkiBase64url: string;
  readonly principalIdentitySha256: string;
  readonly credentialIdSha256: string;
  readonly permissionSetSha256: string;
}

export interface JsonCompatibilityExternalWormArchivePolicyV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-policy-v1";
  readonly environment: "staging";
  readonly archiveBackend: "external-worm";
  readonly providerControl: "version-specific-object-lock-compliance";
  readonly r2BucketLockAccepted: false;
  readonly backendIdentitySha256: string;
  readonly namespaceIdentitySha256: string;
  readonly providerObservationSetSha256: string;
  readonly retentionMode: "compliance";
  readonly legalHoldRequired: false;
  readonly minimumRetentionSeconds: number;
  readonly minimumReadbackDelaySeconds: 5;
  readonly maximumReadbackDelaySeconds: 900;
  readonly effectiveAt: number;
  readonly writer: JsonCompatibilityExternalWormTrustActorV1;
  readonly readback: JsonCompatibilityExternalWormTrustActorV1;
  readonly independentPrincipalsRequired: true;
  readonly independentCredentialsRequired: true;
  readonly independentKeysRequired: true;
  readonly writerDeleteForbidden: true;
  readonly writerRetentionReductionForbidden: true;
  readonly readbackReadOnlyRequired: true;
  readonly readbackWriteForbidden: true;
  readonly readbackDeleteForbidden: true;
  readonly readbackRetentionMutationForbidden: true;
  readonly archivePolicySha256: string;
}

export interface JsonCompatibilityExternalWormArchiveObjectDescriptorV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-descriptor-v1";
  readonly logicalRole: JsonCompatibilityExternalWormArchiveObjectRole;
  readonly mode: JsonCompatibilityExternalWormCollectionMode | null;
  readonly sequence: number | null;
  readonly resourceFamily: string | null;
  readonly objectKeySha256: string;
  readonly mediaType: "application/json";
  readonly contentIdentitySha256: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly pageReceiptSha256: string | null;
  readonly objectDescriptorSha256: string;
}

export interface JsonCompatibilityExternalWormArchivePassRootV1<
  TMode extends JsonCompatibilityExternalWormCollectionMode =
    JsonCompatibilityExternalWormCollectionMode,
> {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-pass-root-v1";
  readonly mode: TMode;
  readonly credentialReceiptSha256: string;
  readonly custodianIdentitySha256: string;
  readonly authenticationIdentitySha256: string;
  readonly collectionArtifactSha256: string;
  readonly snapshotSha256: string;
  readonly pageChainHeadSha256: string;
  readonly captureManifestSha256: string;
  readonly captureTerminalSha256: string;
  readonly pageCount: number;
  readonly passObjectSetSha256: string;
  readonly passObjectCount: number;
  readonly passTotalByteLength: number;
  readonly rawResponseByteLength: number;
  readonly observedAt: number;
  readonly passRootSha256: string;
}

export interface JsonCompatibilityExternalWormArchiveManifestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-manifest-v1";
  readonly kind:
    "container-runtime-json-compatibility-external-worm-archive-manifest";
  readonly environment: "staging";
  readonly archiveOperationIdSha256: string;
  readonly archivePolicySha256: string;
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly collectionProfileSha256: string;
  readonly collectorIdentitySha256: string;
  readonly collection: JsonCompatibilityExternalWormArchivePassRootV1<"collection">;
  readonly independentReadback:
    JsonCompatibilityExternalWormArchivePassRootV1<"independent-readback">;
  readonly accountBindingEvidenceSha256: string;
  readonly accountBindingInventorySha256: string;
  readonly transitionSourceManifestSha256: string;
  readonly phaseSourceManifestSha256: string | null;
  readonly artifactInventoryReadbackSha256: string;
  readonly objects: readonly JsonCompatibilityExternalWormArchiveObjectDescriptorV1[];
  readonly archiveObjectSetSha256: string;
  readonly archiveObjectCount: number;
  readonly archiveTotalByteLength: number;
  readonly createdAt: number;
  readonly archiveManifestSha256: string;
}

export interface JsonCompatibilityExternalWormArchiveObjectObservationV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-observation-v1";
  readonly objectDescriptorSha256: string;
  readonly objectKeySha256: string;
  readonly objectVersionSha256: string;
  readonly objectEtagSha256: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly retentionMode: "compliance";
  readonly retainUntil: number;
  readonly providerRequestIdSha256: string;
  readonly observedAt: number;
  readonly objectObservationSha256: string;
}

export interface JsonCompatibilityExternalWormWriteObservationSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-write-observation-subject-v1";
  readonly environment: "staging";
  readonly attestationRole: "writer";
  readonly archiveOperationIdSha256: string;
  readonly writeOperationIdSha256: string;
  readonly archivePolicySha256: string;
  readonly archiveManifestSha256: string;
  readonly accountBindingEvidenceSha256: string;
  readonly attestorKeyId: string;
  readonly attestorSpkiSha256: string;
  readonly principalIdentitySha256: string;
  readonly credentialIdSha256: string;
  readonly permissionSetSha256: string;
  readonly backendIdentitySha256: string;
  readonly namespaceIdentitySha256: string;
  readonly providerObservationSetSha256: string;
  readonly observations: readonly JsonCompatibilityExternalWormArchiveObjectObservationV1[];
  readonly objectIdentitySetSha256: string;
  readonly objectObservationSetSha256: string;
  readonly objectCount: number;
  readonly totalByteLength: number;
  readonly retainUntil: number;
  readonly startedAt: number;
  readonly lockedAt: number;
  readonly completedAt: number;
  readonly writeObservationSubjectSha256: string;
}

export interface JsonCompatibilityExternalWormReadbackObservationSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-readback-observation-subject-v1";
  readonly environment: "staging";
  readonly attestationRole: "independent-readback";
  readonly archiveOperationIdSha256: string;
  readonly readbackOperationIdSha256: string;
  readonly archivePolicySha256: string;
  readonly archiveManifestSha256: string;
  readonly writeObservationEnvelopeSha256: string;
  readonly accountBindingEvidenceSha256: string;
  readonly attestorKeyId: string;
  readonly attestorSpkiSha256: string;
  readonly principalIdentitySha256: string;
  readonly credentialIdSha256: string;
  readonly permissionSetSha256: string;
  readonly backendIdentitySha256: string;
  readonly namespaceIdentitySha256: string;
  readonly readOnly: true;
  readonly writePermissionsAbsent: true;
  readonly deletePermissionsAbsent: true;
  readonly retentionMutationPermissionsAbsent: true;
  readonly observations: readonly JsonCompatibilityExternalWormArchiveObjectObservationV1[];
  readonly objectIdentitySetSha256: string;
  readonly objectObservationSetSha256: string;
  readonly objectCount: number;
  readonly totalByteLength: number;
  readonly retainUntil: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly readbackObservationSubjectSha256: string;
}

export type JsonCompatibilityExternalWormAttestationSubjectV1 =
  | JsonCompatibilityExternalWormWriteObservationSubjectV1
  | JsonCompatibilityExternalWormReadbackObservationSubjectV1;

export interface JsonCompatibilityExternalWormAttestationEnvelopeV1<
  TSubject extends JsonCompatibilityExternalWormAttestationSubjectV1 =
    JsonCompatibilityExternalWormAttestationSubjectV1,
> {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-attestation-envelope-v1";
  readonly environment: "staging";
  readonly role: TSubject["attestationRole"];
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signerSpkiBase64url: string;
  readonly signerSpkiSha256: string;
  readonly subject: TSubject;
  readonly subjectSha256: string;
  readonly signatureBase64url: string;
  readonly attestationEnvelopeSha256: string;
}

export interface JsonCompatibilityExternalWormArchiveEvidenceV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-external-worm-archive-evidence-v1";
  readonly kind:
    "container-runtime-json-compatibility-external-worm-archive-evidence";
  readonly environment: "staging";
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1;
  readonly writeObservationEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormWriteObservationSubjectV1>;
  readonly independentReadbackEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormReadbackObservationSubjectV1>;
  readonly archivePolicySha256: string;
  readonly archiveManifestSha256: string;
  readonly writeObservationEnvelopeSha256: string;
  readonly independentReadbackEnvelopeSha256: string;
  readonly accountBindingEvidenceSha256: string;
  readonly accountBindingInventorySha256: string;
  readonly objectIdentitySetSha256: string;
  readonly exactObjectReadback: true;
  readonly independentWriterAndReader: true;
  readonly complianceRetentionVerified: true;
  readonly observedAt: number;
  readonly archiveEvidenceSha256: string;
}

export class JsonCompatibilityExternalWormArchiveError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildJsonCompatibilityExternalWormArchivePolicy(input: {
  readonly backendIdentitySha256: string;
  readonly namespaceIdentitySha256: string;
  readonly effectiveAt: number;
  readonly writer: JsonCompatibilityExternalWormTrustActorV1;
  readonly readback: JsonCompatibilityExternalWormTrustActorV1;
}): JsonCompatibilityExternalWormArchivePolicyV1;

export function validateJsonCompatibilityExternalWormArchivePolicy(
  input: unknown,
): JsonCompatibilityExternalWormArchivePolicyV1;

export function buildJsonCompatibilityExternalWormArchiveObjectDescriptor(input: {
  readonly logicalRole: JsonCompatibilityExternalWormArchiveObjectRole;
  readonly mode: JsonCompatibilityExternalWormCollectionMode | null;
  readonly sequence: number | null;
  readonly resourceFamily: string | null;
  readonly objectKeySha256: string;
  readonly contentIdentitySha256: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly pageReceiptSha256: string | null;
}): JsonCompatibilityExternalWormArchiveObjectDescriptorV1;

export function validateJsonCompatibilityExternalWormArchiveObjectDescriptor(
  input: unknown,
): JsonCompatibilityExternalWormArchiveObjectDescriptorV1;

export function buildJsonCompatibilityExternalWormArchivePassRoot<
  TMode extends JsonCompatibilityExternalWormCollectionMode,
>(input: {
  readonly mode: TMode;
  readonly credentialReceiptSha256: string;
  readonly custodianIdentitySha256: string;
  readonly authenticationIdentitySha256: string;
  readonly collectionArtifactSha256: string;
  readonly snapshotSha256: string;
  readonly pageChainHeadSha256: string;
  readonly captureManifestSha256: string;
  readonly captureTerminalSha256: string;
  readonly objects: readonly JsonCompatibilityExternalWormArchiveObjectDescriptorV1[];
  readonly observedAt: number;
}): JsonCompatibilityExternalWormArchivePassRootV1<TMode>;

export function validateJsonCompatibilityExternalWormArchivePassRoot(
  input: unknown,
  objects: readonly JsonCompatibilityExternalWormArchiveObjectDescriptorV1[],
): JsonCompatibilityExternalWormArchivePassRootV1;

export function buildJsonCompatibilityExternalWormArchiveManifest(input: {
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly archiveOperationIdSha256: string;
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly collectionProfileSha256: string;
  readonly collectorIdentitySha256: string;
  readonly collection: JsonCompatibilityExternalWormArchivePassRootV1<"collection">;
  readonly independentReadback:
    JsonCompatibilityExternalWormArchivePassRootV1<"independent-readback">;
  readonly accountBindingEvidenceSha256: string;
  readonly accountBindingInventorySha256: string;
  readonly transitionSourceManifestSha256: string;
  readonly phaseSourceManifestSha256: string | null;
  readonly artifactInventoryReadbackSha256: string;
  readonly objects: readonly JsonCompatibilityExternalWormArchiveObjectDescriptorV1[];
  readonly createdAt: number;
}): JsonCompatibilityExternalWormArchiveManifestV1;

export function validateJsonCompatibilityExternalWormArchiveManifest(
  archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1,
  input: unknown,
): JsonCompatibilityExternalWormArchiveManifestV1;

export function buildJsonCompatibilityExternalWormArchiveObjectObservation(input: {
  readonly objectDescriptor: JsonCompatibilityExternalWormArchiveObjectDescriptorV1;
  readonly objectVersionSha256: string;
  readonly objectEtagSha256: string;
  readonly retainUntil: number;
  readonly providerRequestIdSha256: string;
  readonly observedAt: number;
}): JsonCompatibilityExternalWormArchiveObjectObservationV1;

export function validateJsonCompatibilityExternalWormArchiveObjectObservation(
  objectDescriptor: JsonCompatibilityExternalWormArchiveObjectDescriptorV1,
  input: unknown,
): JsonCompatibilityExternalWormArchiveObjectObservationV1;

export function buildJsonCompatibilityExternalWormWriteObservationSubject(input: {
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1;
  readonly writeOperationIdSha256: string;
  readonly providerObservationSetSha256: string;
  readonly observations: readonly JsonCompatibilityExternalWormArchiveObjectObservationV1[];
  readonly startedAt: number;
  readonly lockedAt: number;
  readonly completedAt: number;
}): JsonCompatibilityExternalWormWriteObservationSubjectV1;

export function validateJsonCompatibilityExternalWormWriteObservationSubject(
  archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1,
  archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1,
  input: unknown,
): JsonCompatibilityExternalWormWriteObservationSubjectV1;

export function buildJsonCompatibilityExternalWormReadbackObservationSubject(input: {
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1;
  readonly writeObservationEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormWriteObservationSubjectV1>;
  readonly readbackOperationIdSha256: string;
  readonly providerObservationSetSha256: string;
  readonly observations: readonly JsonCompatibilityExternalWormArchiveObjectObservationV1[];
  readonly startedAt: number;
  readonly completedAt: number;
}): JsonCompatibilityExternalWormReadbackObservationSubjectV1;

export function validateJsonCompatibilityExternalWormReadbackObservationSubject(
  archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1,
  archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1,
  writeObservationEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormWriteObservationSubjectV1>,
  input: unknown,
): JsonCompatibilityExternalWormReadbackObservationSubjectV1;

export function buildJsonCompatibilityExternalWormAttestationEnvelope<
  TSubject extends JsonCompatibilityExternalWormAttestationSubjectV1,
>(input: {
  readonly subject: TSubject;
  readonly signerSpkiBase64url: string;
  readonly signatureBase64url: string;
}): JsonCompatibilityExternalWormAttestationEnvelopeV1<TSubject>;

export function validateJsonCompatibilityExternalWormAttestationEnvelope(
  input: unknown,
): JsonCompatibilityExternalWormAttestationEnvelopeV1;

export function externalWormArchiveAttestationSigningPayload(
  subject: JsonCompatibilityExternalWormAttestationSubjectV1,
): Uint8Array;

export function verifyJsonCompatibilityExternalWormArchiveAttestation(input: {
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly envelope: JsonCompatibilityExternalWormAttestationEnvelopeV1;
  readonly expectedArchivePolicySha256: string;
}): JsonCompatibilityExternalWormAttestationEnvelopeV1;

export function buildJsonCompatibilityExternalWormArchiveEvidence(input: {
  readonly archivePolicy: JsonCompatibilityExternalWormArchivePolicyV1;
  readonly archiveManifest: JsonCompatibilityExternalWormArchiveManifestV1;
  readonly writeObservationEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormWriteObservationSubjectV1>;
  readonly independentReadbackEnvelope:
    JsonCompatibilityExternalWormAttestationEnvelopeV1<JsonCompatibilityExternalWormReadbackObservationSubjectV1>;
}): JsonCompatibilityExternalWormArchiveEvidenceV1;

export function validateJsonCompatibilityExternalWormArchiveEvidence(
  input: unknown,
): JsonCompatibilityExternalWormArchiveEvidenceV1;

export function verifyJsonCompatibilityExternalWormArchiveEvidence(
  input: unknown,
  options: {
    readonly expectedArchivePolicySha256: string;
    readonly forbiddenSignerSpkiSha256s?: readonly string[];
  },
): JsonCompatibilityExternalWormArchiveEvidenceV1;
