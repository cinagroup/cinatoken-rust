import type { ContainerOperationTransport } from "./container_operation_transport";
import { ProtocolError } from "./protocol";

export const CONTAINER_OPERATION_TRANSPORT_TELEMETRY_EVENT =
  "relay_container_operation_transport_v1";

export type ContainerOperationTransportAttemptResult =
  | "outcome"
  | "protocol_error"
  | "json_response_rejected"
  | "protobuf_response_rejected"
  | "response_too_large"
  | "deadline_exhausted"
  | "transport_failure";

export type ContainerOperationTransportOutcome =
  | "completed"
  | "rejected"
  | "runtime_recovery_required"
  | "protocol_error"
  | "response_media_mismatch"
  | "response_too_large"
  | "response_rejected"
  | "deadline_exhausted"
  | "result_mismatch"
  | "transport_failure"
  | "internal_failure";

type ByteBucket =
  | "unknown"
  | "0"
  | "1_1024"
  | "1025_4096"
  | "4097_16384"
  | "16385_65536"
  | "over_65536";

type LatencyBucket =
  | "lt_10_ms"
  | "lt_50_ms"
  | "lt_100_ms"
  | "lt_250_ms"
  | "lt_500_ms"
  | "lt_1000_ms"
  | "lt_2500_ms"
  | "lt_5000_ms"
  | "lt_10000_ms"
  | "gte_10000_ms";

type ResponseMedia = "json" | "protobuf" | "missing" | "other";
type HttpStatusClass = "none" | "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";

export interface ContainerOperationTransportAttempt {
  ordinal: 1 | 2;
  transport: ContainerOperationTransport;
  request_bytes_bucket: ByteBucket;
  response_bytes_bucket: ByteBucket;
  latency_bucket: LatencyBucket;
  response_media: ResponseMedia;
  http_status_class: HttpStatusClass;
  result_class: ContainerOperationTransportAttemptResult;
}

export interface ContainerOperationTransportTelemetryEvent {
  event: typeof CONTAINER_OPERATION_TRANSPORT_TELEMETRY_EVENT;
  schema_version: 1;
  selected_transport: ContainerOperationTransport;
  effective_transport: ContainerOperationTransport | "none";
  attempt_count: 0 | 1 | 2;
  legacy_json_fallback_count: 0 | 1;
  outcome: ContainerOperationTransportOutcome;
  recovery_required: boolean;
  total_latency_bucket: LatencyBucket;
  attempts: readonly ContainerOperationTransportAttempt[];
}

export interface ContainerOperationTransportAttemptInput {
  ordinal: 1 | 2;
  transport: ContainerOperationTransport;
  requestBytes: number | null;
  responseBytes: number | null;
  latencyMs: number;
  responseStatus: number | null;
  responseContentType: string | null;
  resultClass: ContainerOperationTransportAttemptResult;
}

export interface ContainerOperationTransportTelemetryInput {
  selectedTransport: ContainerOperationTransport;
  attempts: readonly ContainerOperationTransportAttempt[];
  outcome: ContainerOperationTransportOutcome;
  recoveryRequired: boolean;
  totalLatencyMs: number;
}

export function createContainerOperationTransportAttempt(
  input: ContainerOperationTransportAttemptInput,
): ContainerOperationTransportAttempt {
  return {
    ordinal: input.ordinal,
    transport: input.transport,
    request_bytes_bucket: byteBucket(input.requestBytes),
    response_bytes_bucket: byteBucket(input.responseBytes),
    latency_bucket: latencyBucket(input.latencyMs),
    response_media: responseMedia(input.responseContentType),
    http_status_class: httpStatusClass(input.responseStatus),
    result_class: input.resultClass,
  };
}

export function createContainerOperationTransportTelemetryEvent(
  input: ContainerOperationTransportTelemetryInput,
): ContainerOperationTransportTelemetryEvent {
  const attempts = input.attempts.slice(0, 2);
  const effectiveTransport = attempts.at(-1)?.transport ?? "none";
  const legacyFallback =
    input.selectedTransport === "protobuf" &&
    attempts.length === 2 &&
    attempts[0]?.transport === "protobuf" &&
    attempts[0].result_class === "protocol_error" &&
    attempts[1]?.transport === "json";
  return {
    event: CONTAINER_OPERATION_TRANSPORT_TELEMETRY_EVENT,
    schema_version: 1,
    selected_transport: input.selectedTransport,
    effective_transport: effectiveTransport,
    attempt_count: attempts.length as 0 | 1 | 2,
    legacy_json_fallback_count: legacyFallback ? 1 : 0,
    outcome: input.outcome,
    recovery_required: input.recoveryRequired,
    total_latency_bucket: latencyBucket(input.totalLatencyMs),
    attempts,
  };
}

export function emitContainerOperationTransportTelemetry(
  input: ContainerOperationTransportTelemetryInput,
): void {
  try {
    console.log(JSON.stringify(createContainerOperationTransportTelemetryEvent(input)));
  } catch {
    // Observability must never change dispatch, fallback, or recovery semantics.
  }
}

export function classifyContainerOperationTransportFailure(
  error: unknown,
  transport: ContainerOperationTransport,
  deadlineAtMs: number,
  nowMs = Date.now(),
): ContainerOperationTransportAttemptResult {
  if (
    error instanceof ProtocolError &&
    error.code === "container_response_too_large"
  ) {
    return "response_too_large";
  }
  if (
    error instanceof ProtocolError &&
    error.code === "invalid_container_response"
  ) {
    return transport === "protobuf"
      ? "protobuf_response_rejected"
      : "json_response_rejected";
  }
  if (
    nowMs >= deadlineAtMs ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof ProtocolError && error.code === "container_readiness_timeout")
  ) {
    return "deadline_exhausted";
  }
  return "transport_failure";
}

export function classifyContainerOperationRecoveryOutcome(
  error: unknown,
  attempts: readonly ContainerOperationTransportAttempt[],
): ContainerOperationTransportOutcome {
  if (
    error instanceof ProtocolError &&
    ["container_result_mismatch", "container_result_unavailable"].includes(error.code)
  ) {
    return "result_mismatch";
  }
  const resultClass = attempts.at(-1)?.result_class;
  switch (resultClass) {
    case "deadline_exhausted":
      return "deadline_exhausted";
    case "response_too_large":
      return "response_too_large";
    case "json_response_rejected":
    case "protobuf_response_rejected":
      return "response_rejected";
    case "transport_failure":
      return "transport_failure";
    case "outcome":
    case "protocol_error":
    case undefined:
      return "internal_failure";
  }
}

function byteBucket(value: number | null): ByteBucket {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return "unknown";
  if (value === 0) return "0";
  if (value <= 1_024) return "1_1024";
  if (value <= 4_096) return "1025_4096";
  if (value <= 16_384) return "4097_16384";
  if (value <= 65_536) return "16385_65536";
  return "over_65536";
}

function latencyBucket(value: number): LatencyBucket {
  const latency = Number.isFinite(value) ? Math.max(0, value) : 10_000;
  if (latency < 10) return "lt_10_ms";
  if (latency < 50) return "lt_50_ms";
  if (latency < 100) return "lt_100_ms";
  if (latency < 250) return "lt_250_ms";
  if (latency < 500) return "lt_500_ms";
  if (latency < 1_000) return "lt_1000_ms";
  if (latency < 2_500) return "lt_2500_ms";
  if (latency < 5_000) return "lt_5000_ms";
  if (latency < 10_000) return "lt_10000_ms";
  return "gte_10000_ms";
}

function responseMedia(value: string | null): ResponseMedia {
  if (value === null) return "missing";
  if (value === "application/json") return "json";
  if (value === "application/x-protobuf") return "protobuf";
  return "other";
}

function httpStatusClass(value: number | null): HttpStatusClass {
  if (value === null) return "none";
  if (!Number.isSafeInteger(value) || value < 100 || value > 999) return "other";
  const hundred = Math.floor(value / 100);
  return hundred >= 1 && hundred <= 5
    ? (`${hundred}xx` as HttpStatusClass)
    : "other";
}
