import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTAINER_OPERATION_TRANSPORT_TELEMETRY_EVENT,
  classifyContainerOperationRecoveryOutcome,
  classifyContainerOperationTransportFailure,
  createContainerOperationTransportAttempt,
  createContainerOperationTransportTelemetryEvent,
  emitContainerOperationTransportTelemetry,
  type ContainerOperationTransportAttempt,
} from "../src/container_operation_telemetry";
import { ProtocolError } from "../src/protocol";

afterEach(() => {
  vi.restoreAllMocks();
});

function attempt(
  overrides: Partial<Parameters<typeof createContainerOperationTransportAttempt>[0]> = {},
): ContainerOperationTransportAttempt {
  return createContainerOperationTransportAttempt({
    ordinal: 1,
    transport: "json",
    requestBytes: 512,
    responseBytes: 128,
    latencyMs: 24,
    responseStatus: 200,
    responseContentType: "application/json",
    resultClass: "outcome",
    ...overrides,
  });
}

describe("container operation transport telemetry", () => {
  it("emits only the fixed summary and attempt field inventory", () => {
    const event = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "json",
      attempts: [attempt()],
      outcome: "completed",
      recoveryRequired: false,
      totalLatencyMs: 31,
    });

    expect(event).toEqual({
      event: CONTAINER_OPERATION_TRANSPORT_TELEMETRY_EVENT,
      schema_version: 1,
      selected_transport: "json",
      effective_transport: "json",
      attempt_count: 1,
      legacy_json_fallback_count: 0,
      outcome: "completed",
      recovery_required: false,
      total_latency_bucket: "lt_50_ms",
      attempts: [{
        ordinal: 1,
        transport: "json",
        request_bytes_bucket: "1_1024",
        response_bytes_bucket: "1_1024",
        latency_bucket: "lt_50_ms",
        response_media: "json",
        http_status_class: "2xx",
        result_class: "outcome",
      }],
    });
  });

  it("records the exact one-shot legacy fallback without identifiers", () => {
    const event = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "protobuf",
      attempts: [
        attempt({
          ordinal: 1,
          transport: "protobuf",
          requestBytes: 4_097,
          responseBytes: 64,
          responseStatus: 415,
          responseContentType: "application/json",
          resultClass: "protocol_error",
        }),
        attempt({
          ordinal: 2,
          transport: "json",
          requestBytes: 65_536,
          responseBytes: 16_385,
          latencyMs: 750,
        }),
      ],
      outcome: "completed",
      recoveryRequired: false,
      totalLatencyMs: 780,
    });

    expect(event).toMatchObject({
      selected_transport: "protobuf",
      effective_transport: "json",
      attempt_count: 2,
      legacy_json_fallback_count: 1,
      total_latency_bucket: "lt_1000_ms",
    });
    expect(event.attempts[0]).toMatchObject({
      request_bytes_bucket: "4097_16384",
      http_status_class: "4xx",
      response_media: "json",
    });
    expect(event.attempts[1]).toMatchObject({
      request_bytes_bucket: "16385_65536",
      response_bytes_bucket: "16385_65536",
      latency_bucket: "lt_1000_ms",
    });
    expect(Object.keys(event).sort()).toEqual([
      "attempt_count",
      "attempts",
      "effective_transport",
      "event",
      "legacy_json_fallback_count",
      "outcome",
      "recovery_required",
      "schema_version",
      "selected_transport",
      "total_latency_bucket",
    ]);
  });

  it("maps malformed, oversized, deadline, and network failures to bounded classes", () => {
    expect(classifyContainerOperationTransportFailure(
      new ProtocolError("invalid_container_response", 502),
      "protobuf",
      20_000,
      10_000,
    )).toBe("protobuf_response_rejected");
    expect(classifyContainerOperationTransportFailure(
      new ProtocolError("container_response_too_large", 502),
      "json",
      20_000,
      10_000,
    )).toBe("response_too_large");
    expect(classifyContainerOperationTransportFailure(
      new Error("socket contained tenant-a secret-token payload"),
      "json",
      20_000,
      20_000,
    )).toBe("deadline_exhausted");
    expect(classifyContainerOperationTransportFailure(
      new Error("socket contained tenant-a secret-token payload"),
      "json",
      20_000,
      10_000,
    )).toBe("transport_failure");
  });

  it("never serializes error text, payloads, credentials, tenants, or operation ids", () => {
    const sensitive = "tenant-a operation-123 sk-secret request-payload";
    const failure = classifyContainerOperationTransportFailure(
      new Error(sensitive),
      "protobuf",
      20_000,
      10_000,
    );
    const event = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "protobuf",
      attempts: [attempt({
        transport: "protobuf",
        requestBytes: null,
        responseBytes: null,
        responseStatus: null,
        responseContentType: null,
        resultClass: failure,
      })],
      outcome: classifyContainerOperationRecoveryOutcome(
        new Error(sensitive),
        [attempt({ transport: "protobuf", resultClass: failure })],
      ),
      recoveryRequired: true,
      totalLatencyMs: Number.POSITIVE_INFINITY,
    });
    const serialized = JSON.stringify(event);

    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toMatch(/tenant|operation-123|sk-secret|request-payload/);
    expect(event).toMatchObject({
      outcome: "transport_failure",
      recovery_required: true,
      total_latency_bucket: "gte_10000_ms",
    });
    expect(event.attempts[0]).toMatchObject({
      request_bytes_bucket: "unknown",
      response_bytes_bucket: "unknown",
      response_media: "missing",
      http_status_class: "none",
    });
  });

  it("classifies media mismatch, result mismatch, and recovery without changing retry semantics", () => {
    const protobufAttempt = attempt({
      transport: "protobuf",
      resultClass: "protobuf_response_rejected",
    });
    expect(classifyContainerOperationRecoveryOutcome(
      new ProtocolError("invalid_container_response", 502),
      [protobufAttempt],
    )).toBe("response_rejected");
    expect(classifyContainerOperationRecoveryOutcome(
      new ProtocolError("container_result_mismatch", 502),
      [attempt()],
    )).toBe("result_mismatch");

    const mismatch = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "protobuf",
      attempts: [attempt({
        transport: "protobuf",
        responseContentType: "application/json",
      })],
      outcome: "response_media_mismatch",
      recoveryRequired: true,
      totalLatencyMs: 10,
    });
    expect(mismatch).toMatchObject({
      attempt_count: 1,
      legacy_json_fallback_count: 0,
      outcome: "response_media_mismatch",
      recovery_required: true,
    });
  });

  it("caps malformed attempt input at the protocol maximum of two", () => {
    const event = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "protobuf",
      attempts: [
        attempt({ ordinal: 1, transport: "protobuf" }),
        attempt({ ordinal: 2, transport: "json" }),
        attempt({ ordinal: 2, transport: "json" }),
      ],
      outcome: "internal_failure",
      recoveryRequired: true,
      totalLatencyMs: 1,
    });

    expect(event.attempt_count).toBe(2);
    expect(event.attempts).toHaveLength(2);
  });

  it("never reports a fallback when Protobuf was not the selected transport", () => {
    const event = createContainerOperationTransportTelemetryEvent({
      selectedTransport: "json",
      attempts: [
        attempt({ ordinal: 1, transport: "protobuf", resultClass: "protocol_error" }),
        attempt({ ordinal: 2, transport: "json" }),
      ],
      outcome: "internal_failure",
      recoveryRequired: true,
      totalLatencyMs: 1,
    });

    expect(event.legacy_json_fallback_count).toBe(0);
  });

  it("swallows logging failures so observability cannot change execution", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("logging unavailable");
    });

    expect(() => emitContainerOperationTransportTelemetry({
      selectedTransport: "json",
      attempts: [attempt()],
      outcome: "completed",
      recoveryRequired: false,
      totalLatencyMs: 1,
    })).not.toThrow();
  });
});
