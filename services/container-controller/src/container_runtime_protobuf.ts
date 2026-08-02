import { Reader, Root, type Type, Writer } from "protobufjs/light";

import { containerRuntimeProtobufDescriptor } from "../../../contracts/container-runtime/v1/generated/container-runtime.protobuf";
import type { ErrorResponse, OperationEnvelope } from "./container_runtime_contract";

export const CONTAINER_PROTOBUF_CONTENT_TYPE = "application/x-protobuf";

const PROTOBUF_PACKAGE = "cinatoken.container.runtime.v1";
const PROTOBUF_ROOT = Root.fromJSON(containerRuntimeProtobufDescriptor);
const OPERATION_ENVELOPE_TYPE = lookupType("OperationEnvelope");
const OPERATION_INPUT_TYPE = lookupType("OperationInput");
const OPERATION_SHARD_TYPE = lookupType("OperationShard");
const OPERATION_RESPONSE_TYPE = lookupType("OperationResponse");
const OPERATION_RESULT_TYPE = lookupType("OperationResultManifest");
const CLIENT_ARTIFACT_TYPE = lookupType("ClientResponseArtifactManifest");
const ERROR_RESPONSE_TYPE = lookupType("ErrorResponse");

type OperationStatus = "completed" | "rejected" | "recovery_required";
type ProviderClassification = "typed_error" | "http_error" | "invalid_body";

interface DecodedResultManifest {
  object_key?: string;
  object_version?: string;
  sha256?: string;
  size?: number;
  content_type?: string;
}

interface DecodedClientArtifactManifest {
  object_key?: string;
  object_version?: string;
  client_response_artifact_sha256?: string;
  sha256?: string;
  size?: number;
  content_type?: string;
}

interface DecodedOperationResponse {
  protocol_version?: number;
  operation_id?: string;
  status?: OperationStatus;
  code?: string;
  result?: DecodedResultManifest;
  classification?: ProviderClassification;
  provider_status?: number;
  client_status?: number;
  client_artifact?: DecodedClientArtifactManifest;
  trace_id?: string;
}

interface DecodedErrorResponse {
  code?: string;
  message?: string;
}

assertDescriptorShape();

export function encodeOperationEnvelopeProtobuf(
  envelope: OperationEnvelope,
): Uint8Array {
  try {
    validateEnvelopeValue(envelope);

    const writer = Writer.create();
    writeUint32(writer, 1, envelope.protocol_version);
    writeString(writer, 2, envelope.operation_id);
    writeString(writer, 3, envelope.operation_kind);
    writeUint64(writer, 4, envelope.owner_generation);
    writeUint64(writer, 5, envelope.owner_lease_expires_at);
    writeUint64(writer, 6, envelope.execution_deadline_at);
    writeString(writer, 7, envelope.provider_operation_id);
    writeString(writer, 8, envelope.admission_sha256);
    writeMessage(writer, 9, (nested) => encodeOperationInput(nested, envelope.input));
    writeMessage(writer, 10, (nested) => encodeOperationShard(nested, envelope.shard));
    writeString(writer, 11, envelope.trace_id);
    return writer.finish();
  } catch {
    throw new Error("invalid OperationEnvelope protobuf value");
  }
}

export function decodeOperationResponseProtobuf(body: Uint8Array): unknown {
  try {
    const reader = Reader.create(body);
    const value = decodeOperationResponse(reader);
    const canonical = encodeOperationResponseCanonical(value);
    if (!equalBytes(body, canonical)) throw invalidWire();
    return value;
  } catch {
    throw new Error("invalid OperationResponse protobuf body");
  }
}

export function decodeErrorResponseProtobuf(body: Uint8Array): ErrorResponse {
  try {
    const reader = Reader.create(body);
    const value = decodeErrorResponse(reader);
    const canonical = encodeErrorResponseCanonical(value);
    if (!equalBytes(body, canonical)) throw invalidWire();
    return value as ErrorResponse;
  } catch {
    throw new Error("invalid ErrorResponse protobuf body");
  }
}

function lookupType(name: string): Type {
  return PROTOBUF_ROOT.lookupType(`${PROTOBUF_PACKAGE}.${name}`);
}

function assertDescriptorShape(): void {
  assertFields(OPERATION_ENVELOPE_TYPE, {
    protocol_version: 1,
    operation_id: 2,
    operation_kind: 3,
    owner_generation: 4,
    owner_lease_expires_at: 5,
    execution_deadline_at: 6,
    provider_operation_id: 7,
    admission_sha256: 8,
    input: 9,
    shard: 10,
    trace_id: 11,
  });
  assertFields(OPERATION_INPUT_TYPE, {
    mode: 1,
    sha256: 2,
    size: 3,
    content_type: 4,
    request_object_key: 5,
    object_version: 6,
  });
  assertFields(OPERATION_SHARD_TYPE, {
    contract_version: 1,
    ring_generation: 2,
    shard_count: 3,
    shard_index: 4,
    instance_name: 5,
  });
  assertFields(OPERATION_RESPONSE_TYPE, {
    protocol_version: 1,
    operation_id: 2,
    status: 3,
    code: 4,
    result: 5,
    classification: 6,
    provider_status: 7,
    client_status: 8,
    client_artifact: 9,
    trace_id: 10,
  });
  assertFields(OPERATION_RESULT_TYPE, {
    object_key: 1,
    object_version: 2,
    sha256: 3,
    size: 4,
    content_type: 5,
  });
  assertFields(CLIENT_ARTIFACT_TYPE, {
    object_key: 1,
    object_version: 2,
    client_response_artifact_sha256: 3,
    sha256: 4,
    size: 5,
    content_type: 6,
  });
  assertFields(ERROR_RESPONSE_TYPE, { code: 1, message: 2 });
  assertEnum("OperationInputMode", [0, 1, 2]);
  assertEnum("OperationOutcomeStatus", [0, 1, 2, 3]);
  assertEnum("ProviderResponseClassification", [0, 1, 2, 3]);
}

function assertFields(type: Type, expected: Readonly<Record<string, number>>): void {
  const names = Object.keys(expected);
  if (
    type.fieldsArray.length !== names.length ||
    names.some((name) => type.fields[name]?.id !== expected[name])
  ) {
    throw new Error(`invalid protobuf descriptor for ${type.fullName}`);
  }
}

function assertEnum(name: string, expectedNumbers: readonly number[]): void {
  const enumeration = PROTOBUF_ROOT.lookupEnum(`${PROTOBUF_PACKAGE}.${name}`);
  const actualNumbers = Object.values(enumeration.values).sort((left, right) => left - right);
  if (
    actualNumbers.length !== expectedNumbers.length ||
    actualNumbers.some((value, index) => value !== expectedNumbers[index])
  ) {
    throw new Error(`invalid protobuf descriptor for ${enumeration.fullName}`);
  }
}

function validateEnvelopeValue(envelope: OperationEnvelope): void {
  if (envelope === null || typeof envelope !== "object") throw invalidValue();
  assertUint32(envelope.protocol_version);
  assertString(envelope.operation_id);
  assertString(envelope.operation_kind);
  assertSafeUint64(envelope.owner_generation);
  assertSafeUint64(envelope.owner_lease_expires_at);
  assertSafeUint64(envelope.execution_deadline_at);
  assertString(envelope.provider_operation_id);
  assertString(envelope.admission_sha256);
  assertString(envelope.trace_id);

  const input = envelope.input;
  if (input === null || typeof input !== "object") throw invalidValue();
  if (input.mode !== "inline" && input.mode !== "r2") throw invalidValue();
  assertString(input.sha256);
  assertSafeUint64(input.size);
  assertString(input.content_type);
  const inputRecord = input as unknown as Record<string, unknown>;
  const hasRequestObjectKey = Object.hasOwn(inputRecord, "request_object_key");
  const hasObjectVersion = Object.hasOwn(inputRecord, "object_version");
  if (input.mode === "inline") {
    if (hasRequestObjectKey || hasObjectVersion) throw invalidValue();
  } else {
    if (!hasRequestObjectKey || !hasObjectVersion) throw invalidValue();
    assertString(inputRecord.request_object_key);
    assertString(inputRecord.object_version);
  }

  const shard = envelope.shard;
  if (shard === null || typeof shard !== "object") throw invalidValue();
  assertUint32(shard.contract_version);
  assertSafeUint64(shard.ring_generation);
  assertUint32(shard.shard_count);
  assertUint32(shard.shard_index);
  assertString(shard.instance_name);
}

function encodeOperationInput(
  writer: Writer,
  input: OperationEnvelope["input"],
): void {
  writer.uint32(8).int32(input.mode === "inline" ? 1 : 2);
  writeString(writer, 2, input.sha256);
  writeUint64(writer, 3, input.size);
  writeString(writer, 4, input.content_type);
  if (input.mode === "r2") {
    writer.uint32(42).string(input.request_object_key);
    writer.uint32(50).string(input.object_version);
  }
}

function encodeOperationShard(
  writer: Writer,
  shard: OperationEnvelope["shard"],
): void {
  writeUint32(writer, 1, shard.contract_version);
  writeUint64(writer, 2, shard.ring_generation);
  writeUint32(writer, 3, shard.shard_count);
  writeUint32(writer, 4, shard.shard_index);
  writeString(writer, 5, shard.instance_name);
}

function decodeOperationResponse(reader: Reader): DecodedOperationResponse {
  const value: DecodedOperationResponse = {};
  let seen = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field < 1 || field > 10) throw invalidWire();
    seen = markSeen(seen, field);

    switch (field) {
      case 1:
        requireWireType(tag, 0);
        value.protocol_version = reader.uint32();
        break;
      case 2:
        requireWireType(tag, 2);
        value.operation_id = reader.string();
        break;
      case 3:
        requireWireType(tag, 0);
        value.status = decodeOperationStatus(reader.int32());
        break;
      case 4:
        requireWireType(tag, 2);
        value.code = reader.string();
        break;
      case 5:
        requireWireType(tag, 2);
        value.result = readMessage(reader, decodeResultManifest);
        break;
      case 6:
        requireWireType(tag, 0);
        value.classification = decodeProviderClassification(reader.int32());
        break;
      case 7:
        requireWireType(tag, 0);
        value.provider_status = reader.uint32();
        break;
      case 8:
        requireWireType(tag, 0);
        value.client_status = reader.uint32();
        break;
      case 9:
        requireWireType(tag, 2);
        value.client_artifact = readMessage(reader, decodeClientArtifactManifest);
        break;
      case 10:
        requireWireType(tag, 2);
        value.trace_id = reader.string();
        break;
    }
  }
  requirePresence(seen, fieldMask(1, 2, 3, 10));
  return value;
}

function decodeResultManifest(reader: Reader): DecodedResultManifest {
  const value: DecodedResultManifest = {};
  let seen = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field < 1 || field > 5) throw invalidWire();
    seen = markSeen(seen, field);
    switch (field) {
      case 1:
        requireWireType(tag, 2);
        value.object_key = reader.string();
        break;
      case 2:
        requireWireType(tag, 2);
        value.object_version = reader.string();
        break;
      case 3:
        requireWireType(tag, 2);
        value.sha256 = reader.string();
        break;
      case 4:
        requireWireType(tag, 0);
        value.size = readSafeUint64(reader);
        break;
      case 5:
        requireWireType(tag, 2);
        value.content_type = reader.string();
        break;
    }
  }
  requirePresence(seen, fieldMask(1, 2, 3, 4, 5));
  return value;
}

function decodeClientArtifactManifest(reader: Reader): DecodedClientArtifactManifest {
  const value: DecodedClientArtifactManifest = {};
  let seen = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field < 1 || field > 6) throw invalidWire();
    seen = markSeen(seen, field);
    switch (field) {
      case 1:
        requireWireType(tag, 2);
        value.object_key = reader.string();
        break;
      case 2:
        requireWireType(tag, 2);
        value.object_version = reader.string();
        break;
      case 3:
        requireWireType(tag, 2);
        value.client_response_artifact_sha256 = reader.string();
        break;
      case 4:
        requireWireType(tag, 2);
        value.sha256 = reader.string();
        break;
      case 5:
        requireWireType(tag, 0);
        value.size = readSafeUint64(reader);
        break;
      case 6:
        requireWireType(tag, 2);
        value.content_type = reader.string();
        break;
    }
  }
  requirePresence(seen, fieldMask(1, 2, 3, 4, 5, 6));
  return value;
}

function decodeErrorResponse(reader: Reader): DecodedErrorResponse {
  const value: DecodedErrorResponse = {};
  let seen = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field < 1 || field > 2) throw invalidWire();
    seen = markSeen(seen, field);
    requireWireType(tag, 2);
    if (field === 1) value.code = reader.string();
    else value.message = reader.string();
  }
  requirePresence(seen, fieldMask(1, 2));
  return value;
}

function encodeOperationResponseCanonical(value: DecodedOperationResponse): Uint8Array {
  const writer = Writer.create();
  if (value.protocol_version !== undefined) {
    writeUint32(writer, 1, value.protocol_version);
  }
  if (value.operation_id !== undefined) writeString(writer, 2, value.operation_id);
  if (value.status !== undefined) writer.uint32(24).int32(encodeOperationStatus(value.status));
  if (value.code !== undefined) writer.uint32(34).string(value.code);
  if (value.result !== undefined) {
    writeMessage(writer, 5, (nested) => encodeResultManifestCanonical(nested, value.result!));
  }
  if (value.classification !== undefined) {
    writer.uint32(48).int32(encodeProviderClassification(value.classification));
  }
  if (value.provider_status !== undefined) writer.uint32(56).uint32(value.provider_status);
  if (value.client_status !== undefined) writer.uint32(64).uint32(value.client_status);
  if (value.client_artifact !== undefined) {
    writeMessage(writer, 9, (nested) =>
      encodeClientArtifactManifestCanonical(nested, value.client_artifact!),
    );
  }
  if (value.trace_id !== undefined) writeString(writer, 10, value.trace_id);
  return writer.finish();
}

function encodeResultManifestCanonical(
  writer: Writer,
  value: DecodedResultManifest,
): void {
  if (value.object_key !== undefined) writeString(writer, 1, value.object_key);
  if (value.object_version !== undefined) writeString(writer, 2, value.object_version);
  if (value.sha256 !== undefined) writeString(writer, 3, value.sha256);
  if (value.size !== undefined) writeUint64(writer, 4, value.size);
  if (value.content_type !== undefined) writeString(writer, 5, value.content_type);
}

function encodeClientArtifactManifestCanonical(
  writer: Writer,
  value: DecodedClientArtifactManifest,
): void {
  if (value.object_key !== undefined) writeString(writer, 1, value.object_key);
  if (value.object_version !== undefined) writeString(writer, 2, value.object_version);
  if (value.client_response_artifact_sha256 !== undefined) {
    writeString(writer, 3, value.client_response_artifact_sha256);
  }
  if (value.sha256 !== undefined) writeString(writer, 4, value.sha256);
  if (value.size !== undefined) writeUint64(writer, 5, value.size);
  if (value.content_type !== undefined) writeString(writer, 6, value.content_type);
}

function encodeErrorResponseCanonical(value: DecodedErrorResponse): Uint8Array {
  const writer = Writer.create();
  if (value.code !== undefined) writeString(writer, 1, value.code);
  if (value.message !== undefined) writeString(writer, 2, value.message);
  return writer.finish();
}

function decodeOperationStatus(value: number): OperationStatus {
  switch (value) {
    case 1:
      return "completed";
    case 2:
      return "rejected";
    case 3:
      return "recovery_required";
    default:
      throw invalidWire();
  }
}

function encodeOperationStatus(value: OperationStatus): number {
  switch (value) {
    case "completed":
      return 1;
    case "rejected":
      return 2;
    case "recovery_required":
      return 3;
  }
}

function decodeProviderClassification(value: number): ProviderClassification {
  switch (value) {
    case 1:
      return "typed_error";
    case 2:
      return "http_error";
    case 3:
      return "invalid_body";
    default:
      throw invalidWire();
  }
}

function encodeProviderClassification(value: ProviderClassification): number {
  switch (value) {
    case "typed_error":
      return 1;
    case "http_error":
      return 2;
    case "invalid_body":
      return 3;
  }
}

function readMessage<T>(reader: Reader, decode: (nested: Reader) => T): T {
  const length = reader.uint32();
  const end = reader.pos + length;
  if (end < reader.pos || end > reader.len) throw invalidWire();
  const nested = Reader.create(reader.buf.subarray(reader.pos, end));
  reader.pos = end;
  return decode(nested);
}

function readSafeUint64(reader: Reader): number {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (reader.pos >= reader.len) throw invalidWire();
    const byte = reader.buf[reader.pos++];
    if (index === 9 && byte > 1) throw invalidWire();
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > 9_007_199_254_740_991n) throw invalidWire();
      return Number(value);
    }
    shift += 7n;
  }
  throw invalidWire();
}

function writeMessage(writer: Writer, field: number, encode: (nested: Writer) => void): void {
  const nested = writer.uint32((field << 3) | 2).fork();
  encode(nested);
  nested.ldelim();
}

function writeString(writer: Writer, field: number, value: string): void {
  if (value !== "") writer.uint32((field << 3) | 2).string(value);
}

function writeUint32(writer: Writer, field: number, value: number): void {
  if (value !== 0) writer.uint32(field << 3).uint32(value);
}

function writeUint64(writer: Writer, field: number, value: number): void {
  if (value !== 0) writer.uint32(field << 3).uint64(value);
}

function markSeen(seen: number, field: number): number {
  const mask = 1 << field;
  if ((seen & mask) !== 0) throw invalidWire();
  return seen | mask;
}

function fieldMask(...fields: number[]): number {
  return fields.reduce((mask, field) => mask | (1 << field), 0);
}

function requirePresence(seen: number, required: number): void {
  if ((seen & required) !== required) throw invalidWire();
}

function requireWireType(tag: number, expected: number): void {
  if ((tag & 7) !== expected) throw invalidWire();
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw invalidValue();
}

function assertUint32(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw invalidValue();
  }
}

function assertSafeUint64(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidValue();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function invalidWire(): Error {
  return new Error("invalid protobuf wire value");
}

function invalidValue(): Error {
  return new Error("invalid protobuf input value");
}
