import { describe, expect, it } from "vitest";

import type { OperationRow } from "../src/ledger";
import {
  operationOutcomeResponse,
  parseContainerOperationResponse,
  serializeOperationOutcome,
} from "../src/operation_outcome";

const encoder = new TextEncoder();

function containerEnvelope(operationKind = "relay") {
  return {
    protocol_version: 1,
    operation_id: "relayreserve-v2-operation",
    operation_kind: operationKind,
    trace_id: "trace-operation",
  };
}

function containerResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseContainer(status: number, value: unknown, operationKind = "relay") {
  const response = containerResponse(status, value);
  return parseContainerOperationResponse(
    response,
    encoder.encode(JSON.stringify(value)),
    containerEnvelope(operationKind),
  );
}

function operationRow(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    operation_id: "relayreserve-v2-operation",
    owner_generation: 3,
    operation_kind: "relay",
    trace_id: "trace-operation",
    envelope_sha256: "a".repeat(64),
    status: "running",
    response_status: null,
    response_code: null,
    result_object_key: null,
    result_object_version: null,
    result_sha256: null,
    result_size: null,
    result_content_type: null,
    ...overrides,
  };
}

const storedResult = {
  result_object_key:
    "container-results/v1/relayreserve-v2-operation/3/" + "b".repeat(64),
  result_object_version: "r2-version-1",
  result_sha256: "b".repeat(64),
  result_size: 37,
  result_content_type: "application/json",
};

describe("durable container operation outcomes", () => {
  it("accepts the exact runtime completed result envelope", () => {
    const result = {
      object_key: storedResult.result_object_key,
      object_version: storedResult.result_object_version,
      sha256: storedResult.result_sha256,
      size: storedResult.result_size,
      content_type: storedResult.result_content_type,
    };
    expect(
      parseContainer(200, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "completed",
        result,
        trace_id: "trace-operation",
      }),
    ).toEqual({ status: "completed", code: null, result });
  });

  it("accepts strict rejected and recovery-required runtime envelopes", () => {
    expect(
      parseContainer(501, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "rejected",
        code: "execution_not_enabled",
        trace_id: "trace-operation",
      }),
    ).toEqual({ status: "rejected", code: "execution_not_enabled", result: null });
    expect(
      parseContainer(202, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "recovery_required",
        code: "ambiguous_execution",
        trace_id: "trace-operation",
      }),
    ).toEqual({ status: "recovery_required", code: "ambiguous_execution", result: null });
  });

  it("allows a result-free completed health probe only", () => {
    expect(
      parseContainer(
        200,
        {
          protocol_version: 1,
          operation_id: "relayreserve-v2-operation",
          status: "completed",
          trace_id: "trace-operation",
        },
        "health_probe",
      ),
    ).toEqual({ status: "completed", code: null, result: null });
  });

  it("rejects legacy, unknown, null, and contradictory runtime fields", () => {
    const base = {
      protocol_version: 1,
      operation_id: "relayreserve-v2-operation",
      status: "rejected",
      code: "execution_not_enabled",
      trace_id: "trace-operation",
    };
    for (const [status, value, kind] of [
      [200, { ...base, status: "accepted", code: undefined }, "health_probe"],
      [501, { ...base, unknown: true }, "relay"],
      [501, { ...base, code: null }, "relay"],
      [200, { ...base, status: "completed", code: undefined }, "relay"],
      [200, { ...base, status: "completed", code: undefined, result: null }, "relay"],
    ] as const) {
      expect(() => parseContainer(status, value, kind)).toThrowError(
        "invalid_container_response",
      );
    }
  });

  it("returns a stable in-progress response without inventing a result", async () => {
    const row = operationRow();
    expect(serializeOperationOutcome(row)).toEqual({
      http_status: 202,
      payload: {
        protocol_version: 1,
        operation_id: row.operation_id,
        status: "running",
        trace_id: row.trace_id,
      },
    });
    const response = operationOutcomeResponse(row);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a validated result manifest already persisted while running", () => {
    const outcome = serializeOperationOutcome(operationRow(storedResult));
    expect(outcome).toMatchObject({
      http_status: 202,
      payload: {
        status: "running",
        result: {
          object_key: storedResult.result_object_key,
          object_version: storedResult.result_object_version,
          sha256: storedResult.result_sha256,
          size: storedResult.result_size,
          content_type: storedResult.result_content_type,
        },
      },
    });
  });

  it("allows a result-free completed health probe", () => {
    expect(
      serializeOperationOutcome(
        operationRow({
          operation_kind: "health_probe",
          status: "completed",
          response_status: 200,
        }),
      ).payload,
    ).toMatchObject({ status: "completed", trace_id: "trace-operation" });
  });

  it("reconstructs an exact completed result manifest from durable columns", () => {
    const row = operationRow({
      status: "completed",
      response_status: 200,
      ...storedResult,
    });
    const first = serializeOperationOutcome(row);
    const replay = serializeOperationOutcome(row);
    expect(replay).toEqual(first);
    expect(first.payload.result).toEqual({
      object_key: storedResult.result_object_key,
      object_version: storedResult.result_object_version,
      sha256: storedResult.result_sha256,
      size: storedResult.result_size,
      content_type: storedResult.result_content_type,
    });
  });

  it("keeps definitive rejection distinct from ambiguous execution", () => {
    expect(
      serializeOperationOutcome(
        operationRow({
          status: "failed",
          response_status: 501,
          response_code: "execution_not_enabled",
        }),
      ),
    ).toMatchObject({ http_status: 501, payload: { status: "failed" } });
    expect(
      serializeOperationOutcome(
        operationRow({
          status: "recovery_required",
          response_status: 202,
          response_code: "container_execution_ambiguous",
        }),
      ),
    ).toMatchObject({
      http_status: 202,
      payload: {
        status: "recovery_required",
        code: "container_execution_ambiguous",
      },
    });
  });

  it("retains an attached result as reconciliation evidence", () => {
    const outcome = serializeOperationOutcome(
      operationRow({
        status: "recovery_required",
        response_status: 202,
        response_code: "container_execution_ambiguous",
        ...storedResult,
      }),
    );
    expect(outcome.payload.result?.object_version).toBe("r2-version-1");
  });

  it("fails closed for incomplete or contradictory terminal state", () => {
    expect(() =>
      serializeOperationOutcome(
        operationRow({ status: "completed", response_status: 200 }),
      ),
    ).toThrowError("operation_outcome_corrupt");
    expect(() =>
      serializeOperationOutcome(
        operationRow({ status: "failed", response_status: 500 }),
      ),
    ).toThrowError("operation_outcome_corrupt");
    expect(() =>
      serializeOperationOutcome(
        operationRow({
          status: "completed",
          response_status: 200,
          result_object_key: storedResult.result_object_key,
        }),
      ),
    ).toThrowError("storage_result_corrupt");
  });
});
