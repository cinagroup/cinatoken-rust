import type {
  ContainerOperationResponse,
  ErrorResponse,
  OperationEnvelope,
  OperationInput,
  ProviderResponseClassification,
} from "../../services/container-controller/src/container_runtime_contract";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type InlineInput = Extract<OperationInput, { readonly mode: "inline" }>;
type R2Input = Extract<OperationInput, { readonly mode: "r2" }>;

type ProtocolVersionIsV1 = Assert<
  Equal<OperationEnvelope["protocol_version"], 1>
>;
type InlineHasNoR2References = Assert<
  Equal<
    keyof InlineInput,
    "content_type" | "mode" | "sha256" | "size"
  >
>;
type R2RequiresBothReferences = Assert<
  Equal<
    keyof R2Input,
    | "content_type"
    | "mode"
    | "object_version"
    | "request_object_key"
    | "sha256"
    | "size"
  >
>;
type R2ReferenceTypesAreClosed = Assert<
  Equal<
    Pick<R2Input, "request_object_key" | "object_version">,
    {
      readonly request_object_key: string;
      readonly object_version: string;
    }
  >
>;
type OperationStatusesAreClosed = Assert<
  Equal<
    ContainerOperationResponse["status"],
    "completed" | "rejected" | "recovery_required"
  >
>;
type ProviderClassificationsAreClosed = Assert<
  Equal<
    ProviderResponseClassification,
    "typed_error" | "http_error" | "invalid_body"
  >
>;
type ProtocolErrorShapeIsClosed = Assert<
  Equal<keyof ErrorResponse, "code" | "message">
>;

export type ContainerRuntimeContractTypeAssertions =
  | ProtocolVersionIsV1
  | InlineHasNoR2References
  | R2RequiresBothReferences
  | R2ReferenceTypesAreClosed
  | OperationStatusesAreClosed
  | ProviderClassificationsAreClosed
  | ProtocolErrorShapeIsClosed;
