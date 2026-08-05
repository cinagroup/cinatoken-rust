export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTOR_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-collector-identity-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_PROFILE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-collection-profile-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_AUTHENTICATION_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-authentication-identity-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_PAGE_RECEIPT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-page-receipt-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_SNAPSHOT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-snapshot-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_ARTIFACT_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-collection-artifact-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_EVIDENCE_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-account-binding-evidence-v1";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES: readonly [
  "credential-verification",
  "workers-scripts",
  "worker-deployments",
  "worker-version",
  "worker-subdomain",
  "account-worker-domains",
  "account-zones",
  "zone-worker-routes",
];

export type JsonCompatibilityAccountBindingResourceFamily =
  (typeof JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES)[number];

export type JsonCompatibilityAccountBindingCollectionMode =
  | "collection"
  | "independent-readback";

export type JsonCompatibilityAccountBindingType =
  | "service"
  | "durable-object"
  | "dispatch-outbound"
  | "workflow";

export interface JsonCompatibilityAccountBindingLogicalEdgeV1 {
  readonly bindingType: JsonCompatibilityAccountBindingType;
  readonly callerServiceName: string;
  readonly bindingName: string;
  readonly targetServiceName: string;
  readonly targetEnvironment: string | null;
  readonly targetEntrypoint: string | null;
}

export interface JsonCompatibilityAccountBindingVersionedEdgeV1
  extends JsonCompatibilityAccountBindingLogicalEdgeV1 {
  readonly callerVersionId: string;
}

export interface JsonCompatibilityAccountBindingCampaignServiceV1 {
  readonly role: string;
  readonly serviceName: string;
  readonly entrypoint: string;
}

export interface JsonCompatibilityAccountBindingCollectorIdentityV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-collector-identity-v1";
  readonly implementation:
    "tools/collect_container_runtime_json_compatibility_account_bindings.mjs";
  readonly runtime: "bun";
  readonly sourceRevisionSha256: string;
  readonly sourceTreeSha256: string;
  readonly executableSha256: string;
  readonly dependencyLockSha256: string;
  readonly collectorIdentitySha256: string;
}

export interface JsonCompatibilityAccountBindingCollectionProfileV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-collection-profile-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly collectorIdentitySha256: string;
  readonly collectionPermissionSetSha256: string;
  readonly readbackPermissionSetSha256: string;
  readonly requiredResourceFamilies: readonly JsonCompatibilityAccountBindingResourceFamily[];
  readonly campaignServices: readonly JsonCompatibilityAccountBindingCampaignServiceV1[];
  readonly allowedCampaignBindingEdges: readonly JsonCompatibilityAccountBindingLogicalEdgeV1[];
  readonly minimumIndependentReadbackDelaySeconds: 5;
  readonly maximumIndependentReadbackDelaySeconds: 900;
  readonly collectionProfileSha256: string;
}

export interface JsonCompatibilityAccountBindingAuthenticationIdentityV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-authentication-identity-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly credentialIdSha256: string;
  readonly permissionSetSha256: string;
  readonly active: true;
  readonly readOnly: true;
  readonly verifiedAt: number;
  readonly authenticationIdentitySha256: string;
}

export interface JsonCompatibilityAccountBindingPageReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-page-receipt-v1";
  readonly environment: "staging";
  readonly sequence: number;
  readonly resourceFamily: JsonCompatibilityAccountBindingResourceFamily;
  readonly resourceIdentitySha256: string;
  readonly method: "GET";
  readonly requestPathSha256: string;
  readonly responseBodySha256: string;
  readonly responseByteLength: number;
  readonly resultCount: number;
  readonly pageNumber: number | null;
  readonly totalPages: number | null;
  readonly requestIdSha256: string;
  readonly predecessorSha256: string | null;
  readonly observedAt: number;
  readonly pageReceiptSha256: string;
}

export interface JsonCompatibilityAccountBindingServiceV1 {
  readonly serviceName: string;
  readonly activeVersionIds: readonly string[];
  readonly workersDev: boolean;
  readonly previewUrls: boolean;
  readonly deploymentSetSha256: string;
  readonly versionBindingSetSha256: string;
}

export interface JsonCompatibilityAccountBindingZoneRouteV1 {
  readonly kind: "zone-route";
  readonly zoneIdSha256: string;
  readonly pattern: string;
  readonly serviceName: string | null;
}

export interface JsonCompatibilityAccountBindingCustomDomainRouteV1 {
  readonly kind: "custom-domain";
  readonly zoneIdSha256: string;
  readonly hostname: string;
  readonly serviceName: string;
  readonly environment: string | null;
}

export interface JsonCompatibilityAccountBindingSyntheticRouteV1 {
  readonly kind: "workers-dev" | "preview-url";
  readonly serviceName: string;
}

export type JsonCompatibilityAccountBindingRouteV1 =
  | JsonCompatibilityAccountBindingZoneRouteV1
  | JsonCompatibilityAccountBindingCustomDomainRouteV1
  | JsonCompatibilityAccountBindingSyntheticRouteV1;

export interface JsonCompatibilityAccountBindingSnapshotV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-snapshot-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly services: readonly JsonCompatibilityAccountBindingServiceV1[];
  readonly zoneIdSha256s: readonly string[];
  readonly zoneIdSetSha256: string;
  readonly zoneCount: number;
  readonly routes: readonly JsonCompatibilityAccountBindingRouteV1[];
  readonly serviceBindingEdges: readonly JsonCompatibilityAccountBindingVersionedEdgeV1[];
  readonly accountServiceNameSetSha256: string;
  readonly accountRouteSetSha256: string;
  readonly accountServiceBindingEdgeSetSha256: string;
  readonly accountServiceCount: number;
  readonly accountRouteCount: number;
  readonly accountServiceBindingEdgeCount: number;
  readonly cloudflareApiRequestCount: number;
  readonly cloudflareApiPageCount: number;
  readonly paginationComplete: true;
  readonly pageReceipts: readonly JsonCompatibilityAccountBindingPageReceiptV1[];
  readonly pageChainHeadSha256: string;
  readonly observedAt: number;
  readonly snapshotSha256: string;
}

export interface JsonCompatibilityAccountBindingCollectionArtifactV1<
  TMode extends JsonCompatibilityAccountBindingCollectionMode =
    JsonCompatibilityAccountBindingCollectionMode,
> {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-collection-artifact-v1";
  readonly kind:
    "container-runtime-json-compatibility-account-binding-collection";
  readonly environment: "staging";
  readonly mode: TMode;
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly collectionProfileSha256: string;
  readonly collectorIdentity: JsonCompatibilityAccountBindingCollectorIdentityV1;
  readonly authenticationIdentity: JsonCompatibilityAccountBindingAuthenticationIdentityV1;
  readonly snapshot: JsonCompatibilityAccountBindingSnapshotV1;
  readonly observedAt: number;
  readonly collectionArtifactSha256: string;
}

export interface JsonCompatibilityAccountBindingEvidenceV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-account-binding-evidence-v1";
  readonly kind: "container-runtime-json-compatibility-account-binding-evidence";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly collectionProfile: JsonCompatibilityAccountBindingCollectionProfileV1;
  readonly collection: JsonCompatibilityAccountBindingCollectionArtifactV1<"collection">;
  readonly independentReadback: JsonCompatibilityAccountBindingCollectionArtifactV1<"independent-readback">;
  readonly stableSemanticInventory: true;
  readonly campaignServiceNames: readonly string[];
  readonly campaignPrivateRpcOnly: true;
  readonly campaignPublicRouteCount: 0;
  readonly campaignWorkersDevEnabledCount: 0;
  readonly campaignPreviewUrlEnabledCount: 0;
  readonly campaignUnexpectedCallerBindingCount: 0;
  readonly accountServiceNameSetSha256: string;
  readonly zoneIdSetSha256: string;
  readonly zoneCount: number;
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
  readonly accountBindingEvidenceSha256: string;
}

export interface JsonCompatibilityAccountBindingInventoryProjectionV1 {
  readonly accountIdSha256: string;
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
}

export class JsonCompatibilityAccountBindingEvidenceError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function buildJsonCompatibilityAccountBindingCollectorIdentity(input: {
  readonly sourceRevisionSha256: string;
  readonly sourceTreeSha256: string;
  readonly executableSha256: string;
  readonly dependencyLockSha256: string;
}): JsonCompatibilityAccountBindingCollectorIdentityV1;

export function validateJsonCompatibilityAccountBindingCollectorIdentity(
  input: unknown,
): JsonCompatibilityAccountBindingCollectorIdentityV1;

export function buildJsonCompatibilityAccountBindingCollectionProfile(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly accountIdSha256: string;
  readonly collectorIdentitySha256: string;
  readonly collectionPermissionSetSha256: string;
  readonly readbackPermissionSetSha256: string;
  readonly allowedCampaignBindingEdges: readonly JsonCompatibilityAccountBindingLogicalEdgeV1[];
}): JsonCompatibilityAccountBindingCollectionProfileV1;

export function validateJsonCompatibilityAccountBindingCollectionProfile(
  campaignPlan: unknown,
  statePlan: unknown,
  input: unknown,
): JsonCompatibilityAccountBindingCollectionProfileV1;

export function buildJsonCompatibilityAccountBindingAuthenticationIdentity(
  input: {
    readonly accountIdSha256: string;
    readonly credentialIdSha256: string;
    readonly permissionSetSha256: string;
    readonly verifiedAt: number;
  },
): JsonCompatibilityAccountBindingAuthenticationIdentityV1;

export function validateJsonCompatibilityAccountBindingAuthenticationIdentity(
  input: unknown,
): JsonCompatibilityAccountBindingAuthenticationIdentityV1;

export function buildJsonCompatibilityAccountBindingPageReceipt(input: {
  readonly sequence: number;
  readonly resourceFamily: JsonCompatibilityAccountBindingResourceFamily;
  readonly resourceIdentitySha256: string;
  readonly requestPathSha256: string;
  readonly responseBodySha256: string;
  readonly responseByteLength: number;
  readonly resultCount: number;
  readonly pageNumber: number | null;
  readonly totalPages: number | null;
  readonly requestIdSha256: string;
  readonly predecessorSha256: string | null;
  readonly observedAt: number;
}): JsonCompatibilityAccountBindingPageReceiptV1;

export function validateJsonCompatibilityAccountBindingPageReceipt(
  input: unknown,
): JsonCompatibilityAccountBindingPageReceiptV1;

export function buildJsonCompatibilityAccountBindingSnapshot(input: {
  readonly accountIdSha256: string;
  readonly services: readonly JsonCompatibilityAccountBindingServiceV1[];
  readonly zoneIdSha256s: readonly string[];
  readonly routes: readonly JsonCompatibilityAccountBindingRouteV1[];
  readonly serviceBindingEdges: readonly JsonCompatibilityAccountBindingVersionedEdgeV1[];
  readonly pageReceipts: readonly JsonCompatibilityAccountBindingPageReceiptV1[];
  readonly observedAt: number;
}): JsonCompatibilityAccountBindingSnapshotV1;

export function validateJsonCompatibilityAccountBindingSnapshot(
  input: unknown,
): JsonCompatibilityAccountBindingSnapshotV1;

export function buildJsonCompatibilityAccountBindingCollectionArtifact<
  TMode extends JsonCompatibilityAccountBindingCollectionMode,
>(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly collectionProfile: JsonCompatibilityAccountBindingCollectionProfileV1;
  readonly mode: TMode;
  readonly collectorIdentity: JsonCompatibilityAccountBindingCollectorIdentityV1;
  readonly authenticationIdentity: JsonCompatibilityAccountBindingAuthenticationIdentityV1;
  readonly snapshot: JsonCompatibilityAccountBindingSnapshotV1;
}): JsonCompatibilityAccountBindingCollectionArtifactV1<TMode>;

export function validateJsonCompatibilityAccountBindingCollectionArtifact(
  campaignPlan: unknown,
  statePlan: unknown,
  collectionProfile: unknown,
  input: unknown,
): JsonCompatibilityAccountBindingCollectionArtifactV1;

export function buildJsonCompatibilityAccountBindingEvidence(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly collectionProfile: JsonCompatibilityAccountBindingCollectionProfileV1;
  readonly collection: JsonCompatibilityAccountBindingCollectionArtifactV1<"collection">;
  readonly independentReadback: JsonCompatibilityAccountBindingCollectionArtifactV1<"independent-readback">;
}): JsonCompatibilityAccountBindingEvidenceV1;

export function validateJsonCompatibilityAccountBindingEvidence(
  campaignPlan: unknown,
  statePlan: unknown,
  input: unknown,
): JsonCompatibilityAccountBindingEvidenceV1;

export function accountBindingInventoryInputFromEvidence(
  input: JsonCompatibilityAccountBindingEvidenceV1,
): JsonCompatibilityAccountBindingInventoryProjectionV1;
