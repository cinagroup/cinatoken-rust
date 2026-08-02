import { describe, expect, it } from "vitest";

import type {
  OperationRow,
  OperationStatusV4Snapshot,
  ProviderAttemptRow,
  ProviderResponseArtifactAttachmentRow,
} from "../src/ledger";
import type { TerminalAckRequestV3 } from "../src/protocol";
import {
  operationOutcomeResponse,
  operationStatusResponse,
  operationStatusResponseV3,
  operationStatusResponseV4,
  parseContainerOperationHttpResponse,
  parseContainerOperationResponse,
  serializeOperationOutcome,
  terminalAckV3Response,
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

function parseContainerHttp(status: number, value: unknown, operationKind = "relay") {
  const response = containerResponse(status, value);
  return parseContainerOperationHttpResponse(
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

const receiptSha256 = "c".repeat(64);
const providerEgressIdentity = {
  profile: "openai-chat-completions-canary-v1",
  worker_version_id: "worker-version-v4",
};

function successArtifactRow(
  overrides: Partial<ProviderResponseArtifactAttachmentRow> = {},
): ProviderResponseArtifactAttachmentRow {
  const clientArtifactSha256 = "e".repeat(64);
  return {
    status: "succeeded",
    provider_status: 200,
    client_status: 200,
    response_class: "success",
    response_code: null,
    raw_manifest: {
      object_key:
        `container-provider-evidence/v1/relayreserve-v2-operation/3/1/${storedResult.result_sha256}`,
      object_version: "provider-evidence-version-v4",
      provider_response_evidence_sha256: "d".repeat(64),
      sha256: storedResult.result_sha256,
      size: storedResult.result_size,
      content_type: "application/json",
    },
    client_manifest: {
      object_key:
        `container-client-artifacts/v1/relayreserve-v2-operation/3/${clientArtifactSha256}`,
      object_version: "client-artifact-version-v4",
      client_response_artifact_sha256: clientArtifactSha256,
      sha256: storedResult.result_sha256,
      size: storedResult.result_size,
      content_type: "application/json",
    },
    provider_usage_receipt_sha256: receiptSha256,
    operation_id: "relayreserve-v2-operation",
    owner_generation: 3,
    attempt_generation: 1,
    provider_operation_id: "provider-operation-1",
    admission_sha256: "a".repeat(64),
    request_sha256: "b".repeat(64),
    egress_profile: providerEgressIdentity.profile,
    egress_worker_version_id: providerEgressIdentity.worker_version_id,
    attached_at: 1_800_000_004,
    ...overrides,
  } as ProviderResponseArtifactAttachmentRow;
}

function rejectArtifactRow(
  responseClass: "typed_error" | "http_error" | "invalid_body",
  providerStatus: number,
  clientStatus: number,
): ProviderResponseArtifactAttachmentRow {
  const rawSha256 = "d".repeat(64);
  const clientSha256 = "e".repeat(64);
  return {
    ...successArtifactRow(),
    status: "interpreted_reject",
    provider_status: providerStatus,
    client_status: clientStatus,
    response_class: responseClass,
    response_code: `provider_${responseClass}`,
    raw_manifest: {
      ...successArtifactRow().raw_manifest!,
      object_key:
        `container-provider-evidence/v1/relayreserve-v2-operation/3/1/${rawSha256}`,
      sha256: rawSha256,
      size: 2,
    },
    client_manifest: {
      ...successArtifactRow().client_manifest!,
      sha256: clientSha256,
      size: 2,
    },
    provider_usage_receipt_sha256: null,
  } as ProviderResponseArtifactAttachmentRow;
}

function ambiguousArtifactRow(): ProviderResponseArtifactAttachmentRow {
  return {
    ...successArtifactRow(),
    status: "ambiguous",
    provider_status: null,
    client_status: null,
    response_class: null,
    response_code: "provider_response_ambiguous",
    raw_manifest: null,
    client_manifest: null,
    provider_usage_receipt_sha256: null,
  } as ProviderResponseArtifactAttachmentRow;
}

function exactSuccessV4Snapshot(): OperationStatusV4Snapshot {
  return {
    operation: operationRow({
      status: "completed",
      response_status: 200,
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
    }),
    provider_attempt: providerAttemptRow({
      egress_profile: providerEgressIdentity.profile,
      egress_worker_version_id: providerEgressIdentity.worker_version_id,
      status: "succeeded",
      response_status: 200,
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
      provider_usage_receipt_attached_at: 1_800_000_003,
      terminal_at: 1_800_000_005,
      updated_at: 1_800_000_005,
    }),
    provider_response_artifacts: successArtifactRow(),
  };
}

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

  it("classifies exact pre-execution protocol errors without inventing ambiguity", () => {
    for (const status of [400, 413, 415, 422, 426, 500] as const) {
      expect(
        parseContainerHttp(status, {
          code: "invalid_operation_envelope",
          message: "request body must match the operation envelope",
        }),
      ).toEqual({
        kind: "protocol_error",
        status,
        error: {
          code: "invalid_operation_envelope",
          message: "request body must match the operation envelope",
        },
      });
    }
    expect(() =>
      parseContainerHttp(422, {
        code: "invalid:operation",
        message: "noncanonical error code",
      }),
    ).toThrowError("invalid_container_response");
  });

  it("enforces the OpenAPI operation response status matrix", () => {
    const completed = {
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
      trace_id: "trace-operation",
    };
    const rejected = {
      protocol_version: 1,
      operation_id: "relayreserve-v2-operation",
      status: "rejected",
      code: "execution_not_enabled",
      trace_id: "trace-operation",
    };
    expect(() => parseContainer(201, completed)).toThrowError("invalid_container_response");
    expect(() => parseContainer(500, rejected)).toThrowError("invalid_container_response");
    expect(() => parseContainer(422, rejected)).toThrowError("invalid_container_response");
  });

  it("enforces every OpenAPI result manifest boundary", () => {
    const result = {
      object_key: storedResult.result_object_key,
      object_version: storedResult.result_object_version,
      sha256: storedResult.result_sha256,
      size: storedResult.result_size,
      content_type: storedResult.result_content_type,
    };
    const response = (overrides: Record<string, unknown>) => ({
      protocol_version: 1,
      operation_id: "relayreserve-v2-operation",
      status: "completed",
      result: { ...result, ...overrides },
      trace_id: "trace-operation",
    });
    for (const overrides of [
      { object_key: "" },
      { object_version: "version with spaces" },
      { sha256: "A".repeat(64) },
      { size: -1 },
      { size: Number.MAX_SAFE_INTEGER + 1 },
      { content_type: "not-a-media-type" },
    ]) {
      expect(() => parseContainer(200, response(overrides))).toThrowError(
        "invalid_container_response",
      );
    }
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
    const expectedV3Payload = {
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
    };
    expect(await v3.text()).toBe(JSON.stringify(expectedV3Payload));
  });

  it("returns the exact v4 success evidence with every nested field explicit", async () => {
    const snapshot = exactSuccessV4Snapshot();
    const response = operationStatusResponseV4(snapshot);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      status_contract_version: 4,
      protocol_version: 1,
      operation_id: snapshot.operation.operation_id,
      status: "completed",
      trace_id: snapshot.operation.trace_id,
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
        status: "succeeded",
        response_status: 200,
        response_code: null,
        result: {
          object_key: storedResult.result_object_key,
          object_version: storedResult.result_object_version,
          sha256: storedResult.result_sha256,
          size: storedResult.result_size,
          content_type: storedResult.result_content_type,
        },
        provider_usage_receipt_sha256: receiptSha256,
        provider_usage_receipt_attached_at: 1_800_000_003,
        prepared_at: 1_800_000_001,
        dispatched_at: 1_800_000_002,
        terminal_at: 1_800_000_005,
      },
      provider_response_artifacts: successArtifactRow(),
    });
  });

  for (const scenario of [
    { responseClass: "typed_error" as const, providerStatus: 200, clientStatus: 200 },
    { responseClass: "http_error" as const, providerStatus: 202, clientStatus: 202 },
    { responseClass: "invalid_body" as const, providerStatus: 200, clientStatus: 500 },
  ]) {
    it(`returns exact ${scenario.responseClass} v4 evidence without result authority`, async () => {
      const artifacts = rejectArtifactRow(
        scenario.responseClass,
        scenario.providerStatus,
        scenario.clientStatus,
      );
      const response = operationStatusResponseV4({
        operation: operationRow({
          status: "failed",
          response_status: 422,
          response_code: artifacts.response_code,
        }),
        provider_attempt: providerAttemptRow({
          egress_profile: providerEgressIdentity.profile,
          egress_worker_version_id: providerEgressIdentity.worker_version_id,
          status: "definite_reject",
          response_status: 422,
          response_code: artifacts.response_code,
          terminal_at: 1_800_000_005,
          updated_at: 1_800_000_005,
        }),
        provider_response_artifacts: artifacts,
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        status_contract_version: 4,
        provider_usage_receipt_sha256: null,
        provider_attempt: {
          status: "definite_reject",
          result: null,
          provider_usage_receipt_sha256: null,
          provider_usage_receipt_attached_at: null,
        },
        provider_response_artifacts: {
          status: "interpreted_reject",
          provider_status: scenario.providerStatus,
          client_status: scenario.clientStatus,
          response_class: scenario.responseClass,
          raw_manifest: artifacts.raw_manifest,
          client_manifest: artifacts.client_manifest,
          provider_usage_receipt_sha256: null,
        },
      });
    });
  }

  it("keeps ambiguous v4 evidence null and non-financial", async () => {
    const artifacts = ambiguousArtifactRow();
    const snapshot: OperationStatusV4Snapshot = {
      operation: operationRow({
        status: "recovery_required",
        response_status: 202,
        response_code: "provider_response_ambiguous",
      }),
      provider_attempt: providerAttemptRow({
        egress_profile: providerEgressIdentity.profile,
        egress_worker_version_id: providerEgressIdentity.worker_version_id,
        status: "ambiguous",
        response_status: 202,
        response_code: "provider_response_ambiguous",
        terminal_at: 1_800_000_005,
        updated_at: 1_800_000_005,
      }),
      provider_response_artifacts: artifacts,
    };
    const payload = (await operationStatusResponseV4(snapshot).json()) as Record<
      string,
      unknown
    >;
    expect("result" in payload).toBe(false);
    expect(payload).toMatchObject({
      provider_usage_receipt_sha256: null,
      provider_attempt: { result: null, provider_usage_receipt_sha256: null },
      provider_response_artifacts: {
        status: "ambiguous",
        provider_status: null,
        client_status: null,
        response_class: null,
        raw_manifest: null,
        client_manifest: null,
        provider_usage_receipt_sha256: null,
      },
    });

    expect(() =>
      operationStatusResponseV4({
        ...snapshot,
        operation: operationRow({
          status: "recovery_required",
          response_status: 202,
          response_code: "provider_response_ambiguous",
          ...storedResult,
        }),
        provider_attempt: providerAttemptRow({
          egress_profile: providerEgressIdentity.profile,
          egress_worker_version_id: providerEgressIdentity.worker_version_id,
          status: "ambiguous",
          response_status: 202,
          response_code: "provider_response_ambiguous",
          ...storedResult,
          terminal_at: 1_800_000_005,
          updated_at: 1_800_000_005,
        }),
      }),
    ).toThrowError("operation_outcome_corrupt");
  });

  it("trusts complete immutable evidence after deadline recovery", async () => {
    const snapshot = exactSuccessV4Snapshot();
    snapshot.operation = operationRow({
      status: "recovery_required",
      response_status: 202,
      response_code: "container_execution_ambiguous",
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
    });
    snapshot.provider_attempt = providerAttemptRow({
      egress_profile: providerEgressIdentity.profile,
      egress_worker_version_id: providerEgressIdentity.worker_version_id,
      status: "ambiguous",
      response_status: 202,
      response_code: "provider_attempt_deadline_expired",
      ...storedResult,
      provider_usage_receipt_sha256: receiptSha256,
      provider_usage_receipt_attached_at: 1_800_000_003,
      terminal_at: 1_800_000_006,
      updated_at: 1_800_000_006,
    });

    const payload = await operationStatusResponseV4(snapshot).json();
    expect(payload).toMatchObject({
      status_contract_version: 4,
      status: "recovery_required",
      provider_attempt: { status: "ambiguous" },
      provider_response_artifacts: {
        status: "succeeded",
        response_class: "success",
        provider_usage_receipt_sha256: receiptSha256,
      },
    });
  });

  it("fails v4 closed on identity, matrix, body, receipt, or timestamp corruption", () => {
    const base = exactSuccessV4Snapshot();
    const corruptArtifacts = [
      successArtifactRow({ provider_operation_id: "provider-operation-other" }),
      successArtifactRow({ attempt_generation: 2 }),
      successArtifactRow({ provider_status: 202 } as Partial<ProviderResponseArtifactAttachmentRow>),
      successArtifactRow({ provider_usage_receipt_sha256: "f".repeat(64) }),
      successArtifactRow({ attached_at: 1_800_000_001 }),
      successArtifactRow({
        client_manifest: {
          ...successArtifactRow().client_manifest!,
          sha256: "f".repeat(64),
        },
      }),
    ];
    for (const artifacts of corruptArtifacts) {
      expect(() =>
        operationStatusResponseV4({
          ...base,
          provider_response_artifacts: artifacts,
        }),
      ).toThrowError("operation_outcome_corrupt");
    }
    expect(() =>
      operationStatusResponseV4({
        ...base,
        provider_attempt: {
          ...base.provider_attempt!,
          provider_usage_receipt_attached_at: 1_800_000_005,
        },
      }),
    ).toThrowError("operation_outcome_corrupt");
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

  it("returns the exact terminal ACK v3 no-store response", async () => {
    const resultSha256 = "b".repeat(64);
    const ack: TerminalAckRequestV3 = {
      protocol_version: 1,
      terminal_ack_contract_version: 3,
      financial_terminal_contract_version: 2,
      billing_event_id: "1".repeat(64),
      terminal_contract_sha256: "2".repeat(64),
      reconciliation_id: "3".repeat(64),
      reconciliation_revision: 1,
      predecessor_billing_event_id: null,
      operation_id: "relayreserve-v2-operation",
      owner_generation: 2,
      operation_from_status: "dispatched",
      operation_status: "completed",
      response_status: 200,
      response_code: null,
      result: {
        object_key:
          `container-results/v1/relayreserve-v2-operation/2/${resultSha256}`,
        object_version: "result-version-v3",
        sha256: resultSha256,
        size: 37,
        content_type: "application/json",
      },
      provider_usage_binding: {
        attempt_generation: 1,
        receipt_sha256: "4".repeat(64),
        result_sha256: resultSha256,
      },
      provider_response_binding: {
        attempt_generation: 1,
        status: "succeeded",
        response_class: "success",
        provider_status: 200,
        client_status: 200,
        response_code: null,
        provider_response_evidence_sha256: "5".repeat(64),
        client_response_artifact_sha256: "6".repeat(64),
      },
      shard: {
        contract_version: 1,
        ring_generation: 1,
        shard_count: 8,
        shard_index: 3,
        instance_name: "cinatoken-relay-shard-v1-0003",
      },
      trace_id: "trace-operation",
    };
    const response = terminalAckV3Response(ack, {
      kind: "duplicate",
      finalAck: true,
      acknowledgedAt: 1_800_000_010,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.text()).toBe(
      JSON.stringify({
        protocol_version: 1,
        terminal_ack_contract_version: 3,
        financial_terminal_contract_version: 2,
        billing_event_id: ack.billing_event_id,
        operation_id: ack.operation_id,
        reconciliation_revision: 1,
        terminal_contract_sha256: ack.terminal_contract_sha256,
        client_response_artifact_sha256:
          ack.provider_response_binding.client_response_artifact_sha256,
        status: "duplicate",
        final_ack: true,
        acknowledged_at: 1_800_000_010,
      }),
    );
    expect(() =>
      terminalAckV3Response(ack, {
        kind: "acknowledged",
        finalAck: false,
        acknowledgedAt: null,
      }),
    ).toThrowError("terminal_ack_outcome_corrupt");
  });
});
