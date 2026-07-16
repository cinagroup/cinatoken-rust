import {
  operationStorageResult,
  type OperationRow,
  type StorageResultRecord,
} from "./ledger";
import { ProtocolError, type OperationEnvelope } from "./protocol";

export interface ContainerOperationOutcome {
  status: "completed" | "rejected" | "recovery_required";
  code: string | null;
  result: StorageResultRecord | null;
}

export interface OperationOutcomePayload {
  protocol_version: 1;
  operation_id: string;
  status: OperationRow["status"];
  code?: string;
  trace_id: string;
  result?: StorageResultRecord;
}

export interface SerializedOperationOutcome {
  http_status: number;
  payload: OperationOutcomePayload;
}

const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const OPERATION_KIND = /^[a-z0-9_:-]+$/;
const RESPONSE_CODE = /^[a-z0-9_:-]+$/;

export function parseContainerOperationResponse(
  response: Response,
  body: Uint8Array,
  envelope: Pick<
    OperationEnvelope,
    "protocol_version" | "operation_id" | "operation_kind" | "trace_id"
  >,
): ContainerOperationOutcome {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw invalidContainerResponse();

  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    throw invalidContainerResponse();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContainerResponse();
  }

  const record = value as Record<string, unknown>;
  const allowed = ["protocol_version", "operation_id", "status", "code", "result", "trace_id"];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !["protocol_version", "operation_id", "status", "trace_id"].every((key) => key in record) ||
    record.protocol_version !== envelope.protocol_version ||
    record.operation_id !== envelope.operation_id ||
    record.trace_id !== envelope.trace_id ||
    !["completed", "rejected", "recovery_required"].includes(String(record.status))
  ) {
    throw invalidContainerResponse();
  }

  const status = record.status as ContainerOperationOutcome["status"];
  const code = record.code === undefined ? null : record.code;
  if (
    (status === "completed" && (!response.ok || response.status === 202 || code !== null)) ||
    (status === "rejected" &&
      (response.ok || !validResponseCode(code) || record.result !== undefined)) ||
    (status === "recovery_required" &&
      (response.status !== 202 || !validResponseCode(code) || record.result !== undefined))
  ) {
    throw invalidContainerResponse();
  }

  const result = record.result === undefined ? null : parseContainerResult(record.result);
  if (
    (status !== "completed" && result !== null) ||
    (status === "completed" && envelope.operation_kind === "health_probe" && result !== null) ||
    (status === "completed" && envelope.operation_kind !== "health_probe" && result === null)
  ) {
    throw invalidContainerResponse();
  }
  return { status, code: typeof code === "string" ? code : null, result };
}

export function serializeOperationOutcome(row: OperationRow): SerializedOperationOutcome {
  const result = operationStorageResult(row);
  validateOperationIdentity(row);

  let httpStatus: number;
  switch (row.status) {
    case "claimed":
    case "running":
      if (row.response_status !== null || row.response_code !== null || result !== null) {
        throw corruptOutcome();
      }
      httpStatus = 202;
      break;
    case "completed":
      if (
        row.response_status === null ||
        !Number.isSafeInteger(row.response_status) ||
        row.response_status < 200 ||
        row.response_status > 299 ||
        row.response_code !== null ||
        (row.operation_kind !== "health_probe" && result === null)
      ) {
        throw corruptOutcome();
      }
      httpStatus = row.response_status;
      break;
    case "failed":
      if (
        row.response_status === null ||
        !Number.isSafeInteger(row.response_status) ||
        row.response_status < 400 ||
        row.response_status > 599 ||
        !validResponseCode(row.response_code)
      ) {
        throw corruptOutcome();
      }
      httpStatus = row.response_status;
      break;
    case "recovery_required":
      if (row.response_status !== 202 || !validResponseCode(row.response_code)) {
        throw corruptOutcome();
      }
      httpStatus = 202;
      break;
    default:
      throw corruptOutcome();
  }

  return {
    http_status: httpStatus,
    payload: {
      protocol_version: 1,
      operation_id: row.operation_id,
      status: row.status,
      ...(row.response_code === null ? {} : { code: row.response_code }),
      trace_id: row.trace_id,
      ...(result === null ? {} : { result }),
    },
  };
}

export function operationOutcomeResponse(row: OperationRow): Response {
  const outcome = serializeOperationOutcome(row);
  return new Response(JSON.stringify(outcome.payload), {
    status: outcome.http_status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function validateOperationIdentity(row: OperationRow): void {
  if (
    row.operation_id.length < 1 ||
    row.operation_id.length > 128 ||
    !IDENTIFIER.test(row.operation_id) ||
    !Number.isSafeInteger(row.owner_generation) ||
    row.owner_generation < 1 ||
    row.operation_kind.length < 1 ||
    row.operation_kind.length > 64 ||
    !OPERATION_KIND.test(row.operation_kind) ||
    row.trace_id.length < 1 ||
    row.trace_id.length > 128 ||
    !IDENTIFIER.test(row.trace_id)
  ) {
    throw corruptOutcome();
  }
}

function validResponseCode(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && RESPONSE_CODE.test(value);
}

function parseContainerResult(value: unknown): StorageResultRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidContainerResponse();
  }
  const record = value as Record<string, unknown>;
  const expected = ["object_key", "object_version", "sha256", "size", "content_type"];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !(key in record)) ||
    typeof record.object_key !== "string" ||
    typeof record.object_version !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number" ||
    typeof record.content_type !== "string"
  ) {
    throw invalidContainerResponse();
  }
  return {
    object_key: record.object_key,
    object_version: record.object_version,
    sha256: record.sha256,
    size: record.size,
    content_type: record.content_type,
  };
}

function invalidContainerResponse(): ProtocolError {
  return new ProtocolError("invalid_container_response", 502);
}

function corruptOutcome(): ProtocolError {
  return new ProtocolError("operation_outcome_corrupt", 503);
}
