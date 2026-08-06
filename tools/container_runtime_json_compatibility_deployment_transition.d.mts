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

export interface JsonCompatibilityDeploymentArtifactObservationV1 {
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

export interface JsonCompatibilityDeploymentArtifactInventoryReadbackV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
  readonly kind:
    "container-runtime-json-compatibility-source-artifact-inventory";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly campaignPlanDigestSha256: string;
  readonly statePlanDigestSha256: string;
  readonly artifacts: readonly JsonCompatibilityDeploymentArtifactObservationV1[];
  readonly artifactCount: number;
  readonly observedAt: number;
  readonly artifactInventoryReadbackSha256: string;
}

export interface JsonCompatibilityDeploymentServiceAuthorityV1 {
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly versionId: string;
  readonly profileVersion: 1;
  readonly privateRpcOnly: true;
  readonly capability:
    | "coordinate-only"
    | "source-verify-only"
    | "read-only"
    | "mutation-only";
  readonly credentialIdSha256: string | null;
  readonly identitySha256: string;
}

export interface JsonCompatibilityDeploymentTransitionExecutionAuthorityV1 {
  readonly schemaVersion: 1;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-execution-authority-v1";
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly coordinator: JsonCompatibilityDeploymentServiceAuthorityV1;
  readonly sourceVerifier: JsonCompatibilityDeploymentServiceAuthorityV1;
  readonly readback: JsonCompatibilityDeploymentServiceAuthorityV1;
  readonly mutation: JsonCompatibilityDeploymentServiceAuthorityV1;
  readonly authorityDigestSha256: string;
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

export interface JsonCompatibilityAuthorizedDeploymentTransitionV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-authorized-deployment-transition-v2";
  readonly request: {
    readonly schemaVersion: 2;
    readonly operationIdSha256: string;
    readonly campaignPlan: { readonly planDigestSha256: string };
    readonly statePlan: { readonly planDigestSha256: string };
    readonly transition: {
      readonly id: string;
      readonly ordinal: number;
      readonly steps: readonly Readonly<Record<string, unknown>>[];
    };
    readonly sourceEvidence: JsonCompatibilityDeploymentTransitionSourceEvidenceV2;
    readonly artifactInventoryReadback:
      JsonCompatibilityDeploymentArtifactInventoryReadbackV1;
    readonly executionAuthority:
      JsonCompatibilityDeploymentTransitionExecutionAuthorityV1;
  };
  readonly approval: {
    readonly subject: {
      readonly notBefore: number;
      readonly expiresAt: number;
      readonly executionAuthoritySha256: string;
    };
  };
}

export type JsonCompatibilityAuthorizedDeploymentTransitionV1 =
  JsonCompatibilityAuthorizedDeploymentTransitionV2;

export interface JsonCompatibilityDeploymentTransitionExpectedReadbackV2 {
  readonly environment: "staging";
  readonly accountIdSha256: string;
  readonly serviceName: string;
  readonly entrypoint: string;
  readonly versionId: string;
  readonly configSha256: string;
  readonly deploymentState: "dark" | "status-only" | "execution";
  readonly gates: Readonly<Record<string, boolean>>;
  readonly privateRpcOnly: true;
  readonly workersDev: false;
  readonly previewUrls: false;
  readonly bindingSetSha256: string;
  readonly routeSetSha256: string;
  readonly secretNameSetSha256: string;
  readonly durableObjectMigrationSetSha256: string;
  readonly authenticationIdentitySha256: string;
}

export interface JsonCompatibilityDeploymentTransitionReadbackRequestV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-request-v2";
  readonly environment: "staging";
  readonly operation: JsonCompatibilityDeploymentTransitionOperationV1;
  readonly sourceAuthenticationDigestSha256: string;
  readonly transition: { readonly id: string; readonly ordinal: number };
  readonly step: Readonly<Record<string, unknown>>;
  readonly phase: "source" | "target";
  readonly observationOrdinal: 1 | 2;
  readonly expected: JsonCompatibilityDeploymentTransitionExpectedReadbackV2;
  readonly readbackRequestSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionReadbackV2
  extends JsonCompatibilityDeploymentTransitionExpectedReadbackV2 {
  readonly schemaVersion: 2;
  readonly contract:
    "cinatoken-container-runtime-json-compatibility-deployment-transition-readback-v2";
  readonly classification: "observed" | "ambiguous";
  readonly readbackRequestSha256: string;
  readonly readbackServiceIdentitySha256: string;
  readonly remoteStateSha256: string | null;
  readonly readbackRequestIdSha256: string;
  readonly remoteEvidenceSha256: string;
  readonly authenticationEvidenceSha256: string;
  readonly observedAt: number;
  readonly observationDigestSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionMutationIntentV2
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 2;
  readonly mutationIntentSha256: string;
  readonly mutationServiceIdentitySha256: string;
  readonly mutationCredentialIdSha256: string;
}

export interface JsonCompatibilityDeploymentTransitionMutationOutcomeV2
  extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 2;
  readonly mutationIntentSha256: string;
  readonly classification: "accepted" | "rejected" | "ambiguous";
  readonly outcomeDigestSha256: string;
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
  readback(
    input: JsonCompatibilityDeploymentTransitionReadbackRequestV2,
  ): Promise<unknown>;
  mutateOnce(input: {
    readonly mutationIntent:
      JsonCompatibilityDeploymentTransitionMutationIntentV2;
    readonly sourceReadbacks:
      readonly JsonCompatibilityDeploymentTransitionReadbackV2[];
  }): Promise<unknown>;
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
export const JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EMPTY_ROUTE_SET_SHA256:
  string;
export const JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_IDENTITY_CONTRACT:
  "cinatoken-container-runtime-json-compatibility-deployment-leaf-service-identity-v1";

export function buildJsonCompatibilityDeploymentLeafServiceIdentity(
  input: Omit<JsonCompatibilityDeploymentServiceAuthorityV1, "identitySha256">
    & { readonly accountIdSha256: string },
): Readonly<Record<string, unknown>> & { readonly identitySha256: string };

export function buildJsonCompatibilityDeploymentTransitionExecutionAuthority(
  input: {
    readonly accountIdSha256: string;
    readonly coordinator: JsonCompatibilityDeploymentServiceAuthorityV1;
    readonly sourceVerifier: JsonCompatibilityDeploymentServiceAuthorityV1;
    readonly readback: JsonCompatibilityDeploymentServiceAuthorityV1;
    readonly mutation: JsonCompatibilityDeploymentServiceAuthorityV1;
  },
): JsonCompatibilityDeploymentTransitionExecutionAuthorityV1;

export function validateJsonCompatibilityDeploymentTransitionExecutionAuthority(
  input: unknown,
  expectedAccountIdSha256?: string | null,
): JsonCompatibilityDeploymentTransitionExecutionAuthorityV1;

export function buildJsonCompatibilityDeploymentTransitionOperation(input: {
  readonly campaignPlan: unknown;
  readonly statePlan: unknown;
  readonly authorizedTransition: unknown;
}): JsonCompatibilityDeploymentTransitionOperationV1;

export function validateJsonCompatibilityDeploymentTransitionOperation(
  input: unknown,
): JsonCompatibilityDeploymentTransitionOperationV1;

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

export function buildJsonCompatibilityDeploymentTransitionReadbackRequest(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentTransitionReadbackRequestV2;

export function validateJsonCompatibilityDeploymentTransitionReadbackRequest(
  input: unknown,
): JsonCompatibilityDeploymentTransitionReadbackRequestV2;

export function buildJsonCompatibilityDeploymentTransitionReadback(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentTransitionReadbackV2;

export function validateJsonCompatibilityDeploymentTransitionReadback(
  input: unknown,
): JsonCompatibilityDeploymentTransitionReadbackV2;

export function buildJsonCompatibilityDeploymentTransitionMutationIntent(
  authorized: unknown,
  operation: unknown,
  sourceAuthentication: unknown,
  step: unknown,
  expected: unknown,
  sourceReadbacks: readonly unknown[],
): JsonCompatibilityDeploymentTransitionMutationIntentV2;

export function validateJsonCompatibilityDeploymentTransitionMutationIntent(
  input: unknown,
): JsonCompatibilityDeploymentTransitionMutationIntentV2;

export function buildJsonCompatibilityDeploymentTransitionMutationOutcome(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityDeploymentTransitionMutationOutcomeV2;

export function signJsonCompatibilityDeploymentTransition(
  input: Readonly<Record<string, unknown>>,
): JsonCompatibilityAuthorizedDeploymentTransitionV2;

export function validateJsonCompatibilityDeploymentTransitionExecutionContext(
  input: Readonly<Record<string, unknown>>,
  options?: { readonly now?: Date },
): Readonly<Record<string, unknown>> & {
  readonly authorizedTransition: JsonCompatibilityAuthorizedDeploymentTransitionV2;
  readonly sourceAuthentication:
    JsonCompatibilityDeploymentTransitionSourceAuthenticationV2;
  readonly artifactInventoryReadback:
    JsonCompatibilityDeploymentArtifactInventoryReadbackV1;
  readonly operation: JsonCompatibilityDeploymentTransitionOperationV1;
};

export function validateJsonCompatibilityDeploymentTransitionReadbackExecution(
  input: Readonly<Record<string, unknown>>,
  options?: { readonly now?: Date },
): Readonly<Record<string, unknown>> & {
  readonly readbackRequest:
    JsonCompatibilityDeploymentTransitionReadbackRequestV2;
  readonly expected: JsonCompatibilityDeploymentTransitionExpectedReadbackV2;
};

export function validateJsonCompatibilityDeploymentTransitionMutationExecution(
  input: Readonly<Record<string, unknown>>,
  options?: { readonly now?: Date },
): Readonly<Record<string, unknown>> & {
  readonly mutationIntent:
    JsonCompatibilityDeploymentTransitionMutationIntentV2;
  readonly sourceReadbacks:
    readonly JsonCompatibilityDeploymentTransitionReadbackV2[];
};

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
): JsonCompatibilityAuthorizedDeploymentTransitionV2;

export function validateJsonCompatibilityDeploymentTransitionReceipt(
  campaignPlan: unknown,
  statePlan: unknown,
  authorizedTransition: unknown,
  receipt: unknown,
): JsonCompatibilityDeploymentTransitionReceiptV1;
