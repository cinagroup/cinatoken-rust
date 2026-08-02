import type {
  CompletedOperationResponse,
  ProviderRejectedOperationResponse,
  RecoveryRequiredOperationResponse,
  SimpleRejectedOperationResponse,
} from "../../../contracts/container-runtime/v1/generated/container-runtime.openapi";

export type {
  ClientResponseArtifactManifest,
  CompletedOperationResponse,
  ErrorResponse,
  HealthResponse,
  OperationEnvelope,
  OperationInput,
  OperationResultManifest,
  OperationShard,
  ProviderRejectedOperationResponse,
  ReadinessResponse,
  RecoveryRequiredOperationResponse,
  SimpleRejectedOperationResponse,
} from "../../../contracts/container-runtime/v1/generated/container-runtime.openapi";

export type ContainerOperationResponse =
  | CompletedOperationResponse
  | SimpleRejectedOperationResponse
  | ProviderRejectedOperationResponse
  | RecoveryRequiredOperationResponse;

export type ContainerOperationStatus = ContainerOperationResponse["status"];
export type ProviderResponseClassification =
  ProviderRejectedOperationResponse["classification"];
