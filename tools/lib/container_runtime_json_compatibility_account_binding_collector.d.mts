import type {
  JsonCompatibilityAccountBindingCollectionArtifactV1,
  JsonCompatibilityAccountBindingCollectionMode,
  JsonCompatibilityAccountBindingCollectionProfileV1,
  JsonCompatibilityAccountBindingCollectorIdentityV1,
  JsonCompatibilityAccountBindingCustomDomainRouteV1,
  JsonCompatibilityAccountBindingEvidenceV1,
  JsonCompatibilityAccountBindingPageReceiptV1,
  JsonCompatibilityAccountBindingVersionedEdgeV1,
  JsonCompatibilityAccountBindingZoneRouteV1,
} from "../container_runtime_json_compatibility_account_binding_evidence.mjs";
import type {
  JsonCompatibilitySourceAccountBindingInventoryV1,
} from "../container_runtime_json_compatibility_source_authentication.mjs";

export interface JsonCompatibilityAccountBindingRawPageV1 {
  readonly sequence: number;
  readonly resourceFamily:
    JsonCompatibilityAccountBindingPageReceiptV1["resourceFamily"];
  readonly requestPathSha256: string;
  readonly responseBodySha256: string;
  readonly body: Uint8Array;
  readonly receipt: JsonCompatibilityAccountBindingPageReceiptV1;
}

export type JsonCompatibilityAccountBindingRawPageSink = (
  page: JsonCompatibilityAccountBindingRawPageV1,
) => void | Promise<void>;

export interface JsonCompatibilityAccountBindingCollectorDependencies {
  readonly rawPageSink: JsonCompatibilityAccountBindingRawPageSink;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
}

export interface JsonCompatibilityNormalizedTokenVerification {
  readonly id: string;
  readonly status: "active";
}

export interface JsonCompatibilityNormalizedDeployments {
  readonly activeVersionIds: readonly string[];
  readonly deploymentSetSha256: string;
}

export interface JsonCompatibilityNormalizedVersionDetail {
  readonly serviceBindingEdges: readonly JsonCompatibilityAccountBindingVersionedEdgeV1[];
}

export interface JsonCompatibilityNormalizedSubdomain {
  readonly enabled: boolean;
  readonly previewsEnabled: boolean;
}

export interface JsonCompatibilityFinalizedAccountBindingEvidence {
  readonly evidence: JsonCompatibilityAccountBindingEvidenceV1;
  readonly inventory: JsonCompatibilitySourceAccountBindingInventoryV1;
}

export class JsonCompatibilityAccountBindingCollectorError extends Error {
  constructor(code: string, message?: string);
  readonly code: string;
}

export function collectJsonCompatibilityAccountBindingArtifact<
  TMode extends JsonCompatibilityAccountBindingCollectionMode,
>(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly collectionProfile: JsonCompatibilityAccountBindingCollectionProfileV1;
  readonly collectorIdentity: JsonCompatibilityAccountBindingCollectorIdentityV1;
  readonly mode: TMode;
  readonly accountId: string;
  readonly apiToken: string;
  readonly rawPageSink: JsonCompatibilityAccountBindingRawPageSink;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
}): Promise<JsonCompatibilityAccountBindingCollectionArtifactV1<TMode>>;

export function finalizeJsonCompatibilityAccountBindingEvidence(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly collectionProfile: JsonCompatibilityAccountBindingCollectionProfileV1;
  readonly collection: JsonCompatibilityAccountBindingCollectionArtifactV1<"collection">;
  readonly independentReadback: JsonCompatibilityAccountBindingCollectionArtifactV1<"independent-readback">;
}): JsonCompatibilityFinalizedAccountBindingEvidence;

export function normalizeTokenVerification(
  input: unknown,
): JsonCompatibilityNormalizedTokenVerification;

export function normalizeScriptList(input: unknown): string[];

export function normalizeDeployments(
  input: unknown,
  serviceName: string,
): JsonCompatibilityNormalizedDeployments;

export function normalizeVersionDetail(
  input: unknown,
  serviceName: string,
  versionId: string,
): JsonCompatibilityNormalizedVersionDetail;

export function normalizeSubdomain(
  input: unknown,
): JsonCompatibilityNormalizedSubdomain;

export function normalizeCustomDomains(
  input: unknown,
): JsonCompatibilityAccountBindingCustomDomainRouteV1[];

export function normalizeZoneRoutes(
  input: unknown,
  zoneId: string,
): JsonCompatibilityAccountBindingZoneRouteV1[];
