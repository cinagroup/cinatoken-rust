import {
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  parseJsonCompatibilityExecutePhaseRequestSubjectV2,
  type JsonCompatibilityExecutePhaseRequestSubjectV2,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";

export const JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-operator-staging" as const;
export const JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-request-v1" as const;
export const JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityOperatorPhaseRequestV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT;
  readonly execution: JsonCompatibilityExecutePhaseRequestSubjectV2;
  readonly executor: {
    readonly serviceName: typeof JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly invoker: {
    readonly serviceName: typeof JSON_COMPATIBILITY_INVOKER_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly topologyReadbackSha256: string;
  readonly beforeContextSha256: string;
}

export class JsonCompatibilityOperatorProtocolError extends Error {
  constructor(readonly code: "invalid_operator_phase_request") {
    super(code);
    this.name = "JsonCompatibilityOperatorProtocolError";
  }
}

export function parseJsonCompatibilityOperatorPhaseRequestV1(
  input: unknown,
): JsonCompatibilityOperatorPhaseRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "execution",
    "executor",
    "invoker",
    "topologyReadbackSha256",
    "beforeContextSha256",
  ]);
  literal(value.schemaVersion, 1);
  literal(value.contract, JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT);

  let execution: JsonCompatibilityExecutePhaseRequestSubjectV2;
  try {
    execution = parseJsonCompatibilityExecutePhaseRequestSubjectV2(
      value.execution,
    );
  } catch {
    throw protocolError();
  }

  const executor = exactRecord(value.executor, ["serviceName", "versionId"]);
  const invoker = exactRecord(value.invoker, ["serviceName", "versionId"]);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT,
    execution,
    executor: {
      serviceName: literal(
        executor.serviceName,
        JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      ),
      versionId: token(executor.versionId),
    },
    invoker: {
      serviceName: literal(
        invoker.serviceName,
        JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      ),
      versionId: token(invoker.versionId),
    },
    topologyReadbackSha256: digest(value.topologyReadbackSha256),
    beforeContextSha256: digest(value.beforeContextSha256),
  };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw protocolError();
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw protocolError();
  }
  return value;
}

function literal<const T>(value: unknown, expected: T): T {
  if (value !== expected) throw protocolError();
  return expected;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw protocolError();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw protocolError();
  }
  return value;
}

function protocolError(): JsonCompatibilityOperatorProtocolError {
  return new JsonCompatibilityOperatorProtocolError(
    "invalid_operator_phase_request",
  );
}
