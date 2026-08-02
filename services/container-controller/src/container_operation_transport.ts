import type { ContainerOperationHttpResult } from "./operation_outcome";

export type ContainerOperationTransport = "json" | "protobuf";

export interface ContainerOperationDispatchResult {
  parsed: ContainerOperationHttpResult;
  response: Response;
}

export interface ContainerOperationTransportResult
  extends ContainerOperationDispatchResult {
  transport: ContainerOperationTransport;
}

export async function dispatchContainerOperationWithLegacyFallback(
  protobufEnabled: boolean,
  dispatch: (
    transport: ContainerOperationTransport,
  ) => Promise<ContainerOperationDispatchResult>,
): Promise<ContainerOperationTransportResult> {
  const selectedTransport: ContainerOperationTransport = protobufEnabled
    ? "protobuf"
    : "json";
  let result = await dispatch(selectedTransport);
  let transport = selectedTransport;
  if (isLegacyJsonUnsupportedMediaType(selectedTransport, result)) {
    result = await dispatch("json");
    transport = "json";
  }
  return { ...result, transport };
}

function isLegacyJsonUnsupportedMediaType(
  selectedTransport: ContainerOperationTransport,
  result: ContainerOperationDispatchResult,
): boolean {
  return (
    selectedTransport === "protobuf" &&
    result.response.status === 415 &&
    responseContentType(result.response) === "application/json" &&
    result.parsed.kind === "protocol_error" &&
    result.parsed.error.code === "unsupported_media_type"
  );
}

export function responseContentType(response: Response): string | null {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? null;
}
