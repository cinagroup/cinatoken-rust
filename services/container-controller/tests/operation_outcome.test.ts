import { describe, expect, it } from "vitest";

import type { OperationRow, ProviderAttemptRow } from "../src/ledger";
import {
  operationOutcomeResponse,
  operationStatusResponse,
  operationStatusResponseV3,
  parseContainerOperationResponse,
  serializeOperationOutcome,
} from "../src/operation_outcome";

const encoder = new TextEncoder();

function containerEnvelope(operationKind = "relay") {
  return {
    protocol_version: 1,
    operation_id: "relayreserve-v2-operation",
    operation_kind: operationKind,
    owner_generation: 2,
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
    provider_usage_receipt_sha256: null,
    ...overrides,
  };
}

function providerAttemptRow(overrides: Partial<ProviderAttemptRow> = {}): ProviderAttemptRow {
  return {
    operation_id: "relayreserve-v2-operation",
    owner_generation: 3,
    attempt_generation: 1,
    provider_operation_id: "provider-operation-1",
    admission_sha256: "a".repeat(64),
    request_sha256: "b".repeat(64),
    egress_profile: null,
    egress_worker_version_id: null,
    status: "dispatched",
    response_status: null,
    response_code: null,
    result_object_key: null,
    result_object_version: null,
    result_sha256: null,
    result_size: null,
    result_content_type: null,
    provider_usage_receipt_sha256: null,
    provider_usage_receipt_attached_at: null,
    prepared_at: 1_800_000_001,
    dispatched_at: 1_800_000_002,
    terminal_at: null,
    updated_at: 1_800_000_002,
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
    ).toEqual({
      status: "completed",
      code: null,
      result,
      classification: null,
      provider_status: null,
      client_status: null,
      client_artifact: null,
    });
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
    ).toEqual({
      status: "rejected",
      code: "execution_not_enabled",
      result: null,
      classification: null,
      provider_status: null,
      client_status: null,
      client_artifact: null,
    });
    expect(
      parseContainer(202, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "recovery_required",
        code: "ambiguous_execution",
        trace_id: "trace-operation",
      }),
    ).toEqual({
      status: "recovery_required",
      code: "ambiguous_execution",
      result: null,
      classification: null,
      provider_status: null,
      client_status: null,
      client_artifact: null,
    });
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
    ).toEqual({
      status: "completed",
      code: null,
      result: null,
      classification: null,
      provider_status: null,
      client_status: null,
      client_artifact: null,
    });
  });

  it("accepts a complete interpreted provider rejection and rejects provider 202 as success", () => {
    const artifactDigest = "c".repeat(64);
    const artifact = {
      object_key:
        `container-client-artifacts/v1/relayreserve-v2-operation/2/${artifactDigest}`,
      object_version: "client-artifact-version-1",
      client_response_artifact_sha256: artifactDigest,
      sha256: "d".repeat(64),
      size: 128,
      content_type: "application/json",
    };
    expect(
      parseContainer(422, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "rejected",
        code: "provider_http_error",
        classification: "http_error",
        provider_status: 202,
        client_status: 202,
        client_artifact: artifact,
        trace_id: "trace-operation",
      }),
    ).toEqual({
      status: "rejected",
      code: "provider_http_error",
      result: null,
      classification: "http_error",
      provider_status: 202,
      client_status: 202,
      client_artifact: artifact,
    });

    expect(() =>
      parseContainer(200, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "completed",
        result: {
          object_key: storedResult.result_object_key,
          object_version: storedResult.result_object_version,
          sha256: storedResult.result_sha256,
          size: storedResult.result_size,
          content_type: storedResult.result_content_type,
        },
        provider_status: 202,
        trace_id: "trace-operation",
      }),
    ).toThrowError("invalid_container_response");

    expect(() =>
      parseContainer(422, {
        protocol_version: 1,
        operation_id: "relayreserve-v2-operation",
        status: "rejected",
        code: "provider_http_error",
        classification: "http_error",
        provider_status: 202,
        client_status: 202,
        client_artifact: { ...artifact, object_version: "v".repeat(129) },
        trace_id: "trace-operation",
      }),
    ).toThrowError("invalid_container_response");
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

  it("keeps v1 unchanged and exposes the attempt only in the v2 status payload", async () => {
    const operation = operationRow();
    const legacy = (await operationOutcomeResponse(operation).json()) as Record<string, unknown>;
    expect("provider_attempt" in legacy).toBe(false);

    const response = operationStatusResponse({
      operation,
      provider_attempt: providerAttemptRow(),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      operation_id: operation.operation_id,
      status: "running",
      provider_attempt: {
        attempt_generation: 1,
        provider_operation_id: "provider-operation-1",
        status: "dispatched",
        response_status: null,
        result: null,
      },
    });
    expect(() =>
      operationStatusResponse({
        operation,
        provider_attempt: providerAttemptRow({ operation_id: "other-operation" }),
      }),
    ).toThrowError("operation_outcome_corrupt");
  });

  it("keeps receipt fields out of v2 and returns the exact status v3 shape", async () => {
    const receiptSha256 = "c".repeat(64);
    const operation = operationRow({
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
    });
    const attempt = providerAttemptRow({
      provider_usage_receipt_sha256: receiptSha256,
      provider_usage_receipt_attached_at: 1_800_000_003,
    });

    const v2 = (await operationStatusResponse({
      operation,
      provider_attempt: attempt,
    }).json()) as Record<string, unknown>;
    expect("status_contract_version" in v2).toBe(false);
    expect("provider_usage_receipt_sha256" in v2).toBe(false);
    expect(
      "provider_usage_receipt_sha256" in
        (v2.provider_attempt as Record<string, unknown>),
    ).toBe(false);

    const v3 = operationStatusResponseV3({ operation, provider_attempt: attempt });
    expect(v3.status).toBe(202);
    expect(await v3.json()).toEqual({
      status_contract_version: 3,
      protocol_version: 1,
      operation_id: operation.operation_id,
      status: "running",
      trace_id: operation.trace_id,
      result: {
        object_key: storedResult.result_object_key,
        object_version: storedResult.result_object_version,
        sha256: storedResult.result_sha256,
        size: storedResult.result_size,
        content_type: storedResult.result_content_type,
      },
      provider_usage_receipt_sha256: receiptSha256,
      provider_attempt: {
        attempt_generation: 1,
        provider_operation_id: "provider-operation-1",
        admission_sha256: "a".repeat(64),
        request_sha256: "b".repeat(64),
        status: "dispatched",
        response_status: null,
        response_code: null,
        result: null,
        provider_usage_receipt_sha256: receiptSha256,
        provider_usage_receipt_attached_at: 1_800_000_003,
        prepared_at: 1_800_000_001,
        dispatched_at: 1_800_000_002,
        terminal_at: null,
      },
    });
  });

  it("fails status v3 closed on divergent provider usage receipt state", () => {
    const receiptSha256 = "c".repeat(64);
    const operation = operationRow({
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
    });
    const attempt = providerAttemptRow({
      provider_usage_receipt_sha256: receiptSha256,
      provider_usage_receipt_attached_at: 1_800_000_003,
    });

    for (const snapshot of [
      { operation, provider_attempt: null },
      {
        operation,
        provider_attempt: {
          ...attempt,
          provider_usage_receipt_sha256: "d".repeat(64),
        },
      },
      {
        operation,
        provider_attempt: {
          ...attempt,
          provider_usage_receipt_attached_at: null,
        },
      },
      {
        operation: operationRow(storedResult),
        provider_attempt: attempt,
      },
      {
        operation,
        provider_attempt: {
          ...attempt,
          provider_usage_receipt_attached_at: 1_800_000_001,
        },
      },
    ]) {
      expect(() => operationStatusResponseV3(snapshot)).toThrowError(
        "operation_outcome_corrupt",
      );
    }
  });

  it("rejects contradictory operation and attempt states or result manifests", () => {
    const operation = operationRow({
      status: "completed",
      response_status: 200,
      ...storedResult,
    });
    expect(() =>
      operationStatusResponse({ operation, provider_attempt: providerAttemptRow() }),
    ).toThrowError("operation_outcome_corrupt");

    const succeeded = providerAttemptRow({
      status: "succeeded",
      response_status: 200,
      ...storedResult,
      terminal_at: 1_800_000_003,
      updated_at: 1_800_000_003,
    });
    expect(
      operationStatusResponse({ operation, provider_attempt: succeeded }).status,
    ).toBe(200);
    expect(() =>
      operationStatusResponse({
        operation,
        provider_attempt: {
          ...succeeded,
          result_object_version: "different-r2-version",
        },
      }),
    ).toThrowError("operation_outcome_corrupt");
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
