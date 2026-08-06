import type {
  JsonCompatibilityDeploymentTransitionOperationV1,
  JsonCompatibilityDeploymentTransitionReadbackRequestV2,
  JsonCompatibilityDeploymentTransitionReadbackV2,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";

export interface JsonCompatibilityDeploymentResolverIdentityV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-resolver-identity-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly versionId: string;
  readonly profileVersion: 1;
  readonly privateRpcOnly: true;
  readonly capability: "resolve-readback-only";
  readonly cloudflareApiCredentialPresent: false;
  readonly mutationBindingPresent: false;
  readonly sourceVerifierBindingPresent: false;
  readonly identitySha256: string;
}

export interface JsonCompatibilityDeploymentResolutionRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-resolution-request-v1";
  readonly environment: "staging";
  readonly operation: JsonCompatibilityDeploymentTransitionOperationV1;
  readonly authorizedTransitionSha256: string;
  readonly executionAuthoritySha256: string;
  readonly operationCreatedAt: number;
  readonly journalHead: {
    readonly ordinal: number;
    readonly digestSha256: string | null;
  };
  readonly pendingMutationIntentSha256: string | null;
  readonly claimGeneration: number;
  readonly resolver: JsonCompatibilityDeploymentResolverIdentityV1;
  readonly readback: Readonly<Record<string, unknown>>;
  readonly sourceAuthenticationDigestSha256: string;
  readonly sourceAuthenticationVerifiedAt: number;
  readonly sourceAuthenticationExpiresAt: number;
  readonly executionDisabledEvidenceSha256: string;
  readonly quiescedAt: number;
  readonly requiredQuiescenceSeconds: number;
  readonly settleNotBefore: number;
  readonly claimLeaseSeconds: 45;
  readonly mutationPermitted: false;
  readonly readbackLimit: 2;
  readonly nextTransitionAllowed: false;
  readonly executionRetryPermitted: false;
  readonly resolutionRequestSha256: string;
}

export interface JsonCompatibilityDeploymentExecutionDisabledEvidenceV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-execution-disabled-evidence-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly coordinatorServiceName: string;
  readonly coordinatorEntrypoint: string;
  readonly coordinatorVersionId: string;
  readonly coordinatorIdentitySha256: string;
  readonly coordinatorConfigurationSha256: string;
  readonly callerTopologySha256: string;
  readonly executionEnabled: false;
  readonly executionDisabledAt: number;
  readonly maximumAdmittedRequestLifetimeSeconds: number;
  readonly propagationAllowanceSeconds: number;
  readonly clockSkewAllowanceSeconds: number;
  readonly requiredQuiescenceSeconds: number;
  readonly quiescenceSatisfiedAt: number;
  readonly observedAt: number;
  readonly evidenceSha256: string;
}

export interface JsonCompatibilityAuthorizedDeploymentResolutionV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-authorized-deployment-resolution-v1";
  readonly request: JsonCompatibilityDeploymentResolutionRequestV1;
  readonly approval: Readonly<Record<string, unknown>>;
}

export interface JsonCompatibilityDeploymentResolutionReceiptV1
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly operationIdSha256: string;
  readonly operationDigestSha256: string;
  readonly resolutionRequestSha256: string;
  readonly claimGeneration: number;
  readonly classification:
    | "target_confirmed"
    | "manual_review_required"
    | "readback_inconclusive";
  readonly reasonCode: string;
  readonly readbackIdentitySha256: string;
  readonly targetReadbackRequests:
    readonly JsonCompatibilityDeploymentTransitionReadbackRequestV2[];
  readonly targetReadbacks:
    readonly JsonCompatibilityDeploymentTransitionReadbackV2[];
  readonly nextTransitionAllowed: false;
  readonly mutationAttempts: 0;
  readonly automaticRetries: 0;
  readonly mutationCalled: false;
  readonly executionRetryPermitted: false;
  readonly resolutionReceiptSha256: string;
}

export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MINIMUM_QUIESCENCE_SECONDS:
  30;
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_CLAIM_LEASE_SECONDS:
  45;
export const JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_MAX_DISABLE_EVIDENCE_AGE_SECONDS:
  30;

export function buildJsonCompatibilityDeploymentResolverIdentity(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentResolverIdentityV1;

export function buildJsonCompatibilityDeploymentExecutionDisabledEvidence(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentExecutionDisabledEvidenceV1;

export function validateJsonCompatibilityDeploymentExecutionDisabledEvidence(
  input: unknown,
): JsonCompatibilityDeploymentExecutionDisabledEvidenceV1;

export function buildJsonCompatibilityDeploymentResolutionRequest(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentResolutionRequestV1;

export function signJsonCompatibilityDeploymentResolution(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityAuthorizedDeploymentResolutionV1;

export function validateJsonCompatibilityDeploymentResolutionAuthorization(
  campaignPlan: unknown,
  statePlan: unknown,
  authorizedTransition: unknown,
  authorizedResolution: unknown,
  options?: {
    readonly now?: Date | null;
    readonly requireUsableWindow?: boolean;
    readonly requireCompleteLeaseWindow?: boolean;
  },
): JsonCompatibilityAuthorizedDeploymentResolutionV1;

export function buildJsonCompatibilityDeploymentResolutionReceipt(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentResolutionReceiptV1;

export function validateJsonCompatibilityDeploymentResolutionReceipt(
  input: unknown,
): JsonCompatibilityDeploymentResolutionReceiptV1;
