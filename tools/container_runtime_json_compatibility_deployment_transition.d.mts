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
  authenticateSource(sourceEvidence: unknown): Promise<unknown>;
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
