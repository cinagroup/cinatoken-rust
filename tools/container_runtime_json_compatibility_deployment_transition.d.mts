export interface JsonCompatibilityDeploymentTransitionOperationV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-operation-v1";
  readonly operationIdSha256: string;
  readonly authorizedRequestSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly transitionId: string;
  readonly operationDigestSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-request-v2";
  readonly environment: "staging";
  readonly profile: "release-v1" | "campaign-closure-v1";
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly authorizedTransitionSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly transition: {
    readonly id: string;
    readonly ordinal: number;
    readonly fromState: "dark" | "statusOnly" | "execution";
    readonly toState: "dark" | "statusOnly" | "execution";
    readonly transitionSha256: string;
  };
  readonly sourceEvidence: JsonCompatibilityDeploymentTransitionSourceEvidenceV2;
  readonly sourceAuthenticationRequestSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionSourceEvidenceV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-source-evidence-v2";
  readonly profile: "release-v1" | "campaign-closure-v1";
  readonly accountIdSha256: string;
  readonly transitionSourceManifestSha256: string;
  readonly phaseSourceManifestSha256: string | null;
  readonly sourceSignatureEnvelopeSha256: string;
  readonly sourceVerifierPolicySha256: string;
  readonly sourceVerifierIdentitySha256: string;
  readonly immutableSourceArchiveReceiptSha256: string;
  readonly artifactInventoryReadbackSha256: string;
  readonly accountBindingInventorySha256: string;
}

export interface JsonCompatibilityDeploymentTransitionSourceAuthenticationV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-source-authentication-v2";
  readonly classification: "authenticated" | "rejected" | "ambiguous";
  readonly reasonCode: string | null;
  readonly request: JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
  readonly verifierIdentitySha256: string;
  readonly evidenceSha256: string;
  readonly verifiedAt: number;
  readonly sourceAuthenticationDigestSha256: string;
}

export interface JsonCompatibilityAuthorizedDeploymentTransitionV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-authorized-deployment-transition-v1";
  readonly request: {
    readonly operationIdSha256: string;
    readonly campaignPlan: { readonly planDigestSha256: string };
    readonly statePlan: { readonly planDigestSha256: string };
    readonly transition: {
      readonly id: string;
      readonly ordinal: number;
    };
    readonly sourceEvidence: Readonly<Record<string, unknown>>;
  };
  readonly approval: {
    readonly subject: {
      readonly notBefore: number;
      readonly expiresAt: number;
    };
  };
}

export interface JsonCompatibilityDeploymentTransitionReceiptV1
  extends Readonly<Record<string, unknown>> {
  readonly operationIdSha256: string;
  readonly authorizedRequestSha256: string;
  readonly transitionId: string;
  readonly result: "completed" | "stopped";
  readonly receiptDigestSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionJournalEventV1 {
  readonly kind: string;
  readonly digestSha256: string;
  readonly payload: unknown;
}

export interface JsonCompatibilityDeploymentTransitionDependencies {
  now(): number;
  authenticateSource(
    request: JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  ): Promise<unknown>;
  readback(input: unknown): Promise<unknown>;
  mutateOnce(input: unknown): Promise<unknown>;
  readonly journal: {
    reserve(
      operation: JsonCompatibilityDeploymentTransitionOperationV1,
    ): Promise<{
      readonly classification:
        | "reserved"
        | "exact_replay"
        | "inflight"
        | "conflict";
      readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
    }>;
    append(
      event: JsonCompatibilityDeploymentTransitionJournalEventV1,
    ): Promise<{ readonly classification: string }>;
    finalize(
      receipt: JsonCompatibilityDeploymentTransitionReceiptV1,
    ): Promise<{
      readonly classification:
        | "created"
        | "exact_replay"
        | "conflict"
        | "ambiguous";
      readonly receipt: JsonCompatibilityDeploymentTransitionReceiptV1 | null;
    }>;
  };
}

export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-deployment-transition-operation-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STABILITY_MINIMUM_SECONDS:
  5;

export function buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
  input: {
    readonly operationIdSha256: string;
    readonly operationDigestSha256: string;
    readonly authorizedTransitionSha256: string;
    readonly campaignPlanDigestSha256: string;
    readonly statePlanDigestSha256: string;
    readonly transition: Readonly<Record<string, unknown>>;
    readonly sourceEvidence: unknown;
  },
): JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;

export function validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
  input: unknown,
): JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;

export function buildJsonCompatibilityDeploymentTransitionSourceAuthentication(
  input: {
    readonly sourceAuthenticationRequest: unknown;
    readonly classification: "authenticated" | "rejected" | "ambiguous";
    readonly reasonCode?: string | null;
    readonly verifierIdentitySha256: string;
    readonly evidenceSha256: string;
    readonly verifiedAt: number;
  },
): JsonCompatibilityDeploymentTransitionSourceAuthenticationV2;

export class JsonCompatibilityDeploymentTransitionUncertainError
  extends Error {
  readonly code: string;
}

export function executeJsonCompatibilityDeploymentTransition(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly authorizedTransition: unknown;
  readonly dependencies: JsonCompatibilityDeploymentTransitionDependencies;
}): Promise<JsonCompatibilityDeploymentTransitionReceiptV1>;

export function validateJsonCompatibilityDeploymentTransitionAuthorization(
  campaignPlan: unknown,
  statePlan: unknown,
  authorizedTransition: unknown,
  options?: {
    readonly now?: Date | null;
    readonly requireUsableWindow?: boolean;
  },
): JsonCompatibilityAuthorizedDeploymentTransitionV1;

export function validateJsonCompatibilityDeploymentTransitionReceipt(
  campaignPlan: unknown,
  statePlan: unknown,
  authorizedTransition: unknown,
  receipt: unknown,
): JsonCompatibilityDeploymentTransitionReceiptV1;
