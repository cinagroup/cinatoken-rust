import type {
  JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  JsonCompatibilityDeploymentTransitionSourceEvidenceV2,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";
import type {
  JsonCompatibilityAccountBindingEvidenceV1,
  JsonCompatibilityAccountBindingInventoryProjectionV1,
} from "./container_runtime_json_compatibility_account_binding_evidence.mjs";
import type {
  JsonCompatibilityExternalWormArchiveEvidenceV1,
} from "./container_runtime_json_compatibility_external_worm_archive.mjs";
import type {
  JsonCompatibilityAccountBindingRawCaptureTerminalV1,
} from "./container_runtime_json_compatibility_account_binding_raw_capture.mjs";
import type {
  JsonCompatibilityExternalWormS3ClosureV1,
} from "./container_runtime_json_compatibility_external_worm_s3_closure.mjs";

export const JSON_COMPATIBILITY_SOURCE_ARTIFACT_INVENTORY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
export const JSON_COMPATIBILITY_TRANSITION_SOURCE_MANIFEST_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-transition-source-manifest-v1";
export const JSON_COMPATIBILITY_SOURCE_ACCOUNT_BINDING_INVENTORY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-account-binding-inventory-v1";
export const JSON_COMPATIBILITY_SOURCE_ARCHIVE_RECEIPT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-immutable-archive-receipt-v3";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_SUBJECT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-signature-subject-v2";
export const JSON_COMPATIBILITY_SOURCE_SIGNING_INTENT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-signing-intent-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-signature-envelope-v2";
export const JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN:
  "cinatoken-container-runtime-json-compatibility-source-signature-v2\n";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER:
  "cinatoken-json-compatibility-source-archive-authority-staging";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE:
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
export const JSON_COMPATIBILITY_SOURCE_VERIFIER_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-source-verifier-identity-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_MAX_LIFETIME_SECONDS: 604800;
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_MIN_REMAINING_SECONDS: 900;
export const JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS: 3600;
export const JSON_COMPATIBILITY_SOURCE_MIN_ARCHIVE_RETENTION_SECONDS: 31536000;

export type JsonCompatibilitySourceProfile =
  | "release-v1"
  | "campaign-closure-v1";

export type JsonCompatibilityDeploymentState =
  | "dark"
  | "statusOnly"
  | "execution";

export interface JsonCompatibilityCampaignPlanV5
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 4;
  readonly contract: "cinatoken-container-runtime-json-compatibility-plan-v5";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly deploymentStateBinding: Readonly<Record<string, unknown>> & {
    readonly planDigestSha256: string;
  };
}

export interface JsonCompatibilityDeploymentStateArtifactV2 {
  readonly deploymentState: "dark" | "status-only" | "execution";
  readonly versionId: string;
  readonly configSha256: string;
  readonly gates: Readonly<Record<string, boolean>>;
}

export interface JsonCompatibilityDeploymentStateServiceV2 {
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly privateRpcOnly: true;
  readonly workersDev: false;
  readonly previewUrls: false;
  readonly artifacts: Readonly<
    Record<string, JsonCompatibilityDeploymentStateArtifactV2>
  >;
}

export interface JsonCompatibilityDeploymentStatePlanV2
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v2";
  readonly kind: "container-runtime-json-compatibility-deployment-state-plan";
  readonly mode: "offline-version-freeze";
  readonly environment: "staging";
  readonly services: Readonly<
    Record<string, JsonCompatibilityDeploymentStateServiceV2>
  >;
  readonly planDigestSha256: string;
}

export interface JsonCompatibilityPhaseSourceManifestV3
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 3;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-manifest-v3";
  readonly sourceManifestSha256: string;
}

export interface JsonCompatibilitySourceVerifierTrustKeyV1 {
  readonly keyId: string;
  readonly spkiSha256: string;
}

export interface JsonCompatibilitySourceVerifierPreviousTrustKeyV1
  extends JsonCompatibilitySourceVerifierTrustKeyV1 {
  readonly acceptUntil: number;
}

export interface JsonCompatibilitySourceVerifierPolicyV2 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-verifier-policy-v2";
  readonly environment: "staging";
  readonly serviceName:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly profileVersion: 1;
  readonly keyPrefix: string;
  readonly issuer:
    "cinatoken-json-compatibility-source-archive-authority-staging";
  readonly audience:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly externalWormArchivePolicySha256: string;
  readonly current: JsonCompatibilitySourceVerifierTrustKeyV1;
  readonly previous: JsonCompatibilitySourceVerifierPreviousTrustKeyV1 | null;
  readonly sourceVerifierPolicySha256: string;
}

export type JsonCompatibilitySourceVerifierPolicyV1 =
  JsonCompatibilitySourceVerifierPolicyV2;

export interface JsonCompatibilitySourceVerifierIdentityV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-verifier-identity-v1";
  readonly environment: "staging";
  readonly serviceName:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly versionId: string;
  readonly sourceVerifierPolicySha256: string;
  readonly sourceVerifierIdentitySha256: string;
}

export interface JsonCompatibilityTransitionSourceManifestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-transition-source-manifest-v1";
  readonly kind:
    "container-runtime-json-compatibility-transition-source-manifest";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly campaignIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly sourceRevisionSha256: string;
  readonly sourceTreeSha256: string;
  readonly workerBundleSetSha256: string;
  readonly containerImageSetSha256: string;
  readonly d1MigrationSetSha256: string;
  readonly contractSetSha256: string;
  readonly serviceArtifactSetSha256: string;
  readonly serviceCount: number;
  readonly artifactCount: number;
  readonly createdAt: number;
  readonly transitionSourceManifestSha256: string;
}

export interface JsonCompatibilitySourceArtifactObservationV1 {
  readonly role: string;
  readonly artifact: string;
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly deploymentState: "dark" | "status-only" | "execution";
  readonly versionId: string;
  readonly configSha256: string;
  readonly gates: Readonly<Record<string, boolean>>;
  readonly privateRpcOnly: true;
  readonly workersDev: false;
  readonly previewUrls: false;
  readonly bindingSetSha256: string;
  readonly routeSetSha256: string;
  readonly secretNameSetSha256: string;
  readonly durableObjectMigrationSetSha256: string;
}

export interface JsonCompatibilitySourceArtifactInventoryReadbackV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
  readonly kind:
    "container-runtime-json-compatibility-source-artifact-inventory";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly artifacts: readonly JsonCompatibilitySourceArtifactObservationV1[];
  readonly artifactCount: number;
  readonly observedAt: number;
  readonly artifactInventoryReadbackSha256: string;
}

export interface JsonCompatibilitySourceAccountBindingInventoryV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-account-binding-inventory-v1";
  readonly kind:
    "container-runtime-json-compatibility-source-account-binding-inventory";
  readonly environment: "staging";
  readonly scope: "account-wide-workers-bindings";
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly campaignServiceNames: readonly string[];
  readonly campaignPrivateRpcOnly: true;
  readonly campaignPublicRouteCount: 0;
  readonly campaignWorkersDevEnabledCount: 0;
  readonly campaignPreviewUrlEnabledCount: 0;
  readonly campaignUnexpectedCallerBindingCount: 0;
  readonly accountServiceNameSetSha256: string;
  readonly accountRouteSetSha256: string;
  readonly accountServiceBindingEdgeSetSha256: string;
  readonly accountServiceCount: number;
  readonly accountRouteCount: number;
  readonly accountServiceBindingEdgeCount: number;
  readonly cloudflareApiRequestCount: number;
  readonly cloudflareApiPageCount: number;
  readonly paginationComplete: true;
  readonly collectorIdentitySha256: string;
  readonly authenticationIdentitySha256: string;
  readonly pageChainHeadSha256: string;
  readonly readbackEvidenceSha256: string;
  readonly observedAt: number;
  readonly accountBindingInventorySha256: string;
}

export interface JsonCompatibilitySourceImmutableArchiveReceiptV3 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-immutable-archive-receipt-v3";
  readonly kind:
    "container-runtime-json-compatibility-source-immutable-archive-receipt";
  readonly environment: "staging";
  readonly archiveBackend: "external-worm";
  readonly retentionMode: "compliance";
  readonly providerControl: "version-specific-object-lock-compliance";
  readonly r2BucketLockAccepted: false;
  readonly accountIdSha256: string;
  readonly transitionSourceManifestSha256: string;
  readonly phaseSourceManifestSha256: string | null;
  readonly artifactInventoryReadbackSha256: string;
  readonly accountBindingEvidenceSha256: string;
  readonly accountBindingInventorySha256: string;
  readonly archivePolicySha256: string;
  readonly archiveManifestSha256: string;
  readonly archiveEvidenceSha256: string;
  readonly externalWormS3ClosureSha256: string;
  readonly archiveObjectSetSha256: string;
  readonly objectIdentitySetSha256: string;
  readonly archiveObjectCount: number;
  readonly archiveTotalByteLength: number;
  readonly collectionCaptureTerminalSha256: string;
  readonly independentReadbackCaptureTerminalSha256: string;
  readonly writeObservationEnvelopeSha256: string;
  readonly independentReadbackEnvelopeSha256: string;
  readonly lockedAt: number;
  readonly retainUntil: number;
  readonly independentlyReadBackAt: number;
  readonly exactObjectReadback: true;
  readonly independentWriterAndReader: true;
  readonly complianceRetentionVerified: true;
  readonly immutableSourceArchiveReceiptSha256: string;
}

export type JsonCompatibilitySourceImmutableArchiveReceiptV2 =
  JsonCompatibilitySourceImmutableArchiveReceiptV3;
export type JsonCompatibilitySourceImmutableArchiveReceiptV1 =
  JsonCompatibilitySourceImmutableArchiveReceiptV3;

export interface JsonCompatibilitySourceSignatureSubjectV2 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-signature-subject-v2";
  readonly environment: "staging";
  readonly issuer:
    "cinatoken-json-compatibility-source-archive-authority-staging";
  readonly audience:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly keyId: string;
  readonly profile: JsonCompatibilitySourceProfile;
  readonly operationIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly transitionId: string;
  readonly transitionOrdinal: number;
  readonly fromState: JsonCompatibilityDeploymentState;
  readonly toState: JsonCompatibilityDeploymentState;
  readonly transitionSha256: string;
  readonly accountIdSha256: string;
  readonly sourceVerifierPolicySha256: string;
  readonly sourceVerifierIdentitySha256: string;
  readonly transitionSourceManifestSha256: string;
  readonly phaseSourceManifestSha256: string | null;
  readonly artifactInventoryReadbackSha256: string;
  readonly accountBindingEvidenceSha256: string;
  readonly accountBindingInventorySha256: string;
  readonly immutableSourceArchiveReceiptSha256: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilitySourceSigningIntentV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-signing-intent-v1";
  readonly environment: "staging";
  readonly operationIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly transition:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2["transition"];
  readonly sourceEvidence: Omit<
    JsonCompatibilityDeploymentTransitionSourceEvidenceV2,
    "sourceSignatureEnvelopeSha256"
  >;
  readonly accountBindingEvidenceSha256: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly sourceSignatureSubjectSha256: string;
  readonly sourceSigningIntentSha256: string;
}

export type JsonCompatibilitySourceSignatureSubjectV1 =
  JsonCompatibilitySourceSignatureSubjectV2;

export interface JsonCompatibilitySourceSignatureEnvelopeV2 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-signature-envelope-v2";
  readonly algorithm: "Ed25519";
  readonly subject: JsonCompatibilitySourceSignatureSubjectV2;
  readonly subjectSha256: string;
  readonly signerSpkiBase64url: string;
  readonly signatureBase64url: string;
}

export type JsonCompatibilitySourceSignatureEnvelopeV1 =
  JsonCompatibilitySourceSignatureEnvelopeV2;

export interface JsonCompatibilitySourceAuthenticationBundleV3 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3";
  readonly kind:
    "container-runtime-json-compatibility-source-authentication-bundle";
  readonly environment: "staging";
  readonly campaignPlan: JsonCompatibilityCampaignPlanV5;
  readonly statePlan: JsonCompatibilityDeploymentStatePlanV2;
  readonly transitionSourceManifest: JsonCompatibilityTransitionSourceManifestV1;
  readonly phaseSourceManifest: JsonCompatibilityPhaseSourceManifestV3 | null;
  readonly artifactInventoryReadback: JsonCompatibilitySourceArtifactInventoryReadbackV1;
  readonly accountBindingEvidence: JsonCompatibilityAccountBindingEvidenceV1;
  readonly accountBindingInventory: JsonCompatibilitySourceAccountBindingInventoryV1;
  readonly externalWormArchiveEvidence:
    JsonCompatibilityExternalWormArchiveEvidenceV1;
  readonly externalWormS3Closure: JsonCompatibilityExternalWormS3ClosureV1;
  readonly collectionCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
  readonly independentReadbackCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
  readonly immutableSourceArchiveReceipt: JsonCompatibilitySourceImmutableArchiveReceiptV3;
  readonly sourceSignatureEnvelope: JsonCompatibilitySourceSignatureEnvelopeV2;
  readonly bundleSha256: string;
}

export type JsonCompatibilitySourceAuthenticationBundleV2 =
  JsonCompatibilitySourceAuthenticationBundleV3;
export type JsonCompatibilitySourceAuthenticationBundleV1 =
  JsonCompatibilitySourceAuthenticationBundleV3;

export class JsonCompatibilitySourceAuthenticationProtocolError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildJsonCompatibilitySourceVerifierPolicy(input: {
  readonly serviceName:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly profileVersion: 1;
  readonly keyPrefix: string;
  readonly issuer:
    "cinatoken-json-compatibility-source-archive-authority-staging";
  readonly audience:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly externalWormArchivePolicySha256: string;
  readonly current: JsonCompatibilitySourceVerifierTrustKeyV1;
  readonly previous: JsonCompatibilitySourceVerifierPreviousTrustKeyV1 | null;
}): JsonCompatibilitySourceVerifierPolicyV2;

export function buildJsonCompatibilitySourceVerifierIdentity(input: {
  readonly versionId: string;
  readonly sourceVerifierPolicySha256: string;
}): JsonCompatibilitySourceVerifierIdentityV1;

export function buildJsonCompatibilityTransitionSourceManifest(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly accountIdSha256: string;
  readonly sourceRevisionSha256: string;
  readonly sourceTreeSha256: string;
  readonly workerBundleSetSha256: string;
  readonly containerImageSetSha256: string;
  readonly d1MigrationSetSha256: string;
  readonly contractSetSha256: string;
  readonly createdAt: number;
}): JsonCompatibilityTransitionSourceManifestV1;

export function validateJsonCompatibilityTransitionSourceManifest(
  campaignPlan: unknown,
  statePlan: unknown,
  input: unknown,
): JsonCompatibilityTransitionSourceManifestV1;

export function buildJsonCompatibilitySourceArtifactInventoryReadback(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly accountIdSha256: string;
  readonly artifacts: readonly JsonCompatibilitySourceArtifactObservationV1[];
  readonly observedAt: number;
}): JsonCompatibilitySourceArtifactInventoryReadbackV1;

export function validateJsonCompatibilitySourceArtifactInventoryReadback(
  campaignPlan: unknown,
  statePlan: unknown,
  input: unknown,
): JsonCompatibilitySourceArtifactInventoryReadbackV1;

export function buildJsonCompatibilitySourceAccountBindingInventory(
  input: {
    readonly campaignPlan: unknown;
    readonly statePlan: unknown;
  } & JsonCompatibilityAccountBindingInventoryProjectionV1,
): JsonCompatibilitySourceAccountBindingInventoryV1;

export function validateJsonCompatibilitySourceAccountBindingInventory(
  campaignPlan: unknown,
  statePlan: unknown,
  input: unknown,
): JsonCompatibilitySourceAccountBindingInventoryV1;

export function buildJsonCompatibilitySourceImmutableArchiveReceipt(input: {
  readonly externalWormArchiveEvidence:
    JsonCompatibilityExternalWormArchiveEvidenceV1;
  readonly externalWormS3Closure: JsonCompatibilityExternalWormS3ClosureV1;
  readonly collectionCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
  readonly independentReadbackCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
}): JsonCompatibilitySourceImmutableArchiveReceiptV3;

export function validateJsonCompatibilitySourceImmutableArchiveReceipt(
  input: unknown,
  externalWormArchiveEvidence: JsonCompatibilityExternalWormArchiveEvidenceV1,
  externalWormS3Closure: JsonCompatibilityExternalWormS3ClosureV1,
  collectionCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1,
  independentReadbackCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1,
): JsonCompatibilitySourceImmutableArchiveReceiptV3;

export function buildJsonCompatibilitySourceSignatureSubject(input: {
  readonly sourceAuthenticationRequest:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
  readonly accountBindingEvidenceSha256: string;
  readonly immutableSourceArchiveReceiptSha256: string;
  readonly issuer?:
    "cinatoken-json-compatibility-source-archive-authority-staging";
  readonly audience?:
    "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
  readonly keyId: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}): JsonCompatibilitySourceSignatureSubjectV2;

export function buildJsonCompatibilitySourceSigningIntent(input: {
  readonly operationIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly transition:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2["transition"];
  readonly sourceEvidence: Omit<
    JsonCompatibilityDeploymentTransitionSourceEvidenceV2,
    "sourceSignatureEnvelopeSha256"
  >;
  readonly accountBindingEvidenceSha256: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}): JsonCompatibilitySourceSigningIntentV1;

export function buildJsonCompatibilitySourceSignatureSubjectFromIntent(
  intent: unknown,
): JsonCompatibilitySourceSignatureSubjectV2;

export function buildJsonCompatibilitySourceSignatureEnvelope(input: {
  readonly subject: JsonCompatibilitySourceSignatureSubjectV2;
  readonly signerSpkiBase64url: string;
  readonly signatureBase64url: string;
}): JsonCompatibilitySourceSignatureEnvelopeV2;

export function validateJsonCompatibilitySourceSignatureSubject(
  input: unknown,
): JsonCompatibilitySourceSignatureSubjectV2;

export function validateJsonCompatibilitySourceSignatureEnvelope(
  input: unknown,
): JsonCompatibilitySourceSignatureEnvelopeV2;

export function sourceSignatureSigningPayload(subject: unknown): Uint8Array;

export function buildJsonCompatibilitySourceAuthenticationBundle(input: {
  readonly sourceAuthenticationRequest:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
  readonly campaignPlan: JsonCompatibilityCampaignPlanV5;
  readonly statePlan: JsonCompatibilityDeploymentStatePlanV2;
  readonly transitionSourceManifest: JsonCompatibilityTransitionSourceManifestV1;
  readonly phaseSourceManifest: JsonCompatibilityPhaseSourceManifestV3 | null;
  readonly artifactInventoryReadback: JsonCompatibilitySourceArtifactInventoryReadbackV1;
  readonly accountBindingEvidence: JsonCompatibilityAccountBindingEvidenceV1;
  readonly accountBindingInventory: JsonCompatibilitySourceAccountBindingInventoryV1;
  readonly externalWormArchiveEvidence:
    JsonCompatibilityExternalWormArchiveEvidenceV1;
  readonly externalWormS3Closure: JsonCompatibilityExternalWormS3ClosureV1;
  readonly collectionCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
  readonly independentReadbackCaptureTerminal:
    JsonCompatibilityAccountBindingRawCaptureTerminalV1;
  readonly immutableSourceArchiveReceipt: JsonCompatibilitySourceImmutableArchiveReceiptV3;
  readonly sourceSignatureEnvelope: JsonCompatibilitySourceSignatureEnvelopeV2;
}): JsonCompatibilitySourceAuthenticationBundleV3;

export function validateJsonCompatibilitySourceAuthenticationBundle(
  sourceAuthenticationRequest:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  input: unknown,
  options?: {
    readonly now?: number | null;
    readonly requireUsableWindow?: boolean;
  },
): JsonCompatibilitySourceAuthenticationBundleV3;

export function sourceAuthenticationBundleKey(
  sourceSignatureEnvelopeSha256: string,
  prefix?: string,
): string;

export function sourceAuthenticationRevocationKey(
  signerSpkiSha256: string,
  prefix?: string,
): string;
