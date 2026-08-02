import { describe, expect, it } from "vitest";

import protobufCasesJson from "../../../contracts/container-runtime/v1/conformance/operation-protobuf-cases.json";
import type { OperationEnvelope } from "../src/container_runtime_contract";
import {
  CONTAINER_PROTOBUF_CONTENT_TYPE,
  decodeErrorResponseProtobuf,
  decodeOperationResponseProtobuf,
  encodeOperationEnvelopeProtobuf,
} from "../src/container_runtime_protobuf";

interface ProtobufCase {
  name: string;
  accepted: boolean;
  message_type: string;
  wire_hex: string;
  value?: Record<string, unknown>;
  rejection?: string;
}

interface ProtobufCasesDocument {
  schema_version: number;
  cases: ProtobufCase[];
}

const protobufCases = protobufCasesJson as ProtobufCasesDocument;
const COMPLETED_RESPONSE = fromHex(vectorCase("operation_response_completed").wire_hex);
const ERROR_RESPONSE = fromHex(vectorCase("error_response").wire_hex);

describe("container runtime protobuf codec", () => {
  it("matches the accepted OperationEnvelope conformance bytes exactly", () => {
    const testCase = vectorCase("operation_envelope_canonical");
    const envelope = operationEnvelopeFromVector(requireVectorValue(testCase));
    const encoded = encodeOperationEnvelopeProtobuf(envelope);

    expect(CONTAINER_PROTOBUF_CONTENT_TYPE).toBe("application/x-protobuf");
    expect(testCase.accepted).toBe(true);
    expect(toHex(encoded)).toBe(testCase.wire_hex);
    expect(encodeOperationEnvelopeProtobuf(envelope)).toEqual(encoded);
  });

  it("decodes every accepted OperationResponse conformance case", () => {
    const responseCases = protobufCases.cases.filter(
      (testCase) =>
        testCase.accepted &&
        testCase.message_type === "cinatoken.container.runtime.v1.OperationResponse",
    );
    expect(responseCases.length).toBeGreaterThan(0);

    for (const testCase of responseCases) {
      const decoded = decodeOperationResponseProtobuf(fromHex(testCase.wire_hex));
      expect(Object.getPrototypeOf(decoded), testCase.name).toBe(Object.prototype);
      expect(decoded, testCase.name).toEqual(
        operationResponseFromVector(requireVectorValue(testCase)),
      );
    }
  });

  it("decodes every accepted ErrorResponse conformance case", () => {
    const errorCases = protobufCases.cases.filter(
      (testCase) =>
        testCase.accepted &&
        testCase.message_type === "cinatoken.container.runtime.v1.ErrorResponse",
    );
    expect(errorCases.length).toBeGreaterThan(0);

    for (const testCase of errorCases) {
      expect(decodeErrorResponseProtobuf(fromHex(testCase.wire_hex)), testCase.name).toEqual(
        requireVectorValue(testCase),
      );
    }
  });

  it("rejects unknown trailing fields", () => {
    expect(() =>
      decodeOperationResponseProtobuf(concat(COMPLETED_RESPONSE, fromHex("5801"))),
    ).toThrow("invalid OperationResponse protobuf body");
    expect(() =>
      decodeErrorResponseProtobuf(concat(ERROR_RESPONSE, fromHex("1801"))),
    ).toThrow("invalid ErrorResponse protobuf body");
  });

  it("rejects duplicate fields", () => {
    expect(() =>
      decodeOperationResponseProtobuf(concat(COMPLETED_RESPONSE, fromHex("1801"))),
    ).toThrow("invalid OperationResponse protobuf body");
    expect(() =>
      decodeErrorResponseProtobuf(concat(ERROR_RESPONSE, fromHex("120178"))),
    ).toThrow("invalid ErrorResponse protobuf body");
  });

  it("rejects noncanonical field encodings", () => {
    expect(() =>
      decodeOperationResponseProtobuf(
        fromHex("08810012026f70180152057472616365"),
      ),
    ).toThrow("invalid OperationResponse protobuf body");
  });

  it("rejects uint64 values outside the TypeScript safe-integer range", () => {
    expect(() =>
      decodeOperationResponseProtobuf(
        fromHex(
          "080112026f7018012a290a036b6579120276311a0373686120" +
            "80808080808080102a106170706c69636174696f6e2f6a736f6e" +
            "52057472616365",
        ),
      ),
    ).toThrow("invalid OperationResponse protobuf body");
  });

  it("rejects invalid enum values and missing structural presence", () => {
    const invalidEnum = vectorCase("reject_operation_response_invalid_enum");
    expect(invalidEnum).toMatchObject({ accepted: false, rejection: "invalid_enum" });
    expect(() =>
      decodeOperationResponseProtobuf(fromHex(invalidEnum.wire_hex)),
    ).toThrow("invalid OperationResponse protobuf body");
    expect(() =>
      decodeOperationResponseProtobuf(fromHex("080112026f7052057472616365")),
    ).toThrow("invalid OperationResponse protobuf body");
    expect(() => decodeErrorResponseProtobuf(fromHex("0a03626164"))).toThrow(
      "invalid ErrorResponse protobuf body",
    );
  });
});

function vectorCase(name: string): ProtobufCase {
  const testCase = protobufCases.cases.find((candidate) => candidate.name === name);
  if (testCase === undefined) throw new Error(`missing protobuf conformance case: ${name}`);
  return testCase;
}

function requireVectorValue(testCase: ProtobufCase): Record<string, unknown> {
  if (testCase.value === undefined) {
    throw new Error(`protobuf conformance case has no value: ${testCase.name}`);
  }
  return testCase.value;
}

function operationEnvelopeFromVector(value: Record<string, unknown>): OperationEnvelope {
  const input = value.input as Record<string, unknown>;
  const shard = value.shard as Record<string, unknown>;
  const commonInput = {
    sha256: input.sha256 as string,
    size: input.size as number,
    content_type: input.content_type as string,
  };
  return {
    protocol_version: value.protocol_version as 1,
    operation_id: value.operation_id as string,
    operation_kind: value.operation_kind as string,
    owner_generation: value.owner_generation as number,
    owner_lease_expires_at: value.owner_lease_expires_at as number,
    execution_deadline_at: value.execution_deadline_at as number,
    provider_operation_id: value.provider_operation_id as string,
    admission_sha256: value.admission_sha256 as string,
    input:
      input.mode === "OPERATION_INPUT_MODE_INLINE"
        ? { mode: "inline", ...commonInput }
        : {
            mode: "r2",
            ...commonInput,
            request_object_key: input.request_object_key as string,
            object_version: input.object_version as string,
          },
    shard: {
      contract_version: shard.contract_version as 1,
      ring_generation: shard.ring_generation as number,
      shard_count: shard.shard_count as number,
      shard_index: shard.shard_index as number,
      instance_name: shard.instance_name as string,
    },
    trace_id: value.trace_id as string,
  };
}

function operationResponseFromVector(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    status: decodeVectorStatus(value.status),
    ...(value.classification === undefined
      ? {}
      : { classification: decodeVectorClassification(value.classification) }),
  };
}

function decodeVectorStatus(value: unknown): string {
  switch (value) {
    case "OPERATION_OUTCOME_STATUS_COMPLETED":
      return "completed";
    case "OPERATION_OUTCOME_STATUS_REJECTED":
      return "rejected";
    case "OPERATION_OUTCOME_STATUS_RECOVERY_REQUIRED":
      return "recovery_required";
    default:
      throw new Error(`invalid protobuf response status vector: ${String(value)}`);
  }
}

function decodeVectorClassification(value: unknown): string {
  switch (value) {
    case "PROVIDER_RESPONSE_CLASSIFICATION_TYPED_ERROR":
      return "typed_error";
    case "PROVIDER_RESPONSE_CLASSIFICATION_HTTP_ERROR":
      return "http_error";
    case "PROVIDER_RESPONSE_CLASSIFICATION_INVALID_BODY":
      return "invalid_body";
    default:
      throw new Error(`invalid protobuf classification vector: ${String(value)}`);
  }
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error("invalid test hex");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
}
