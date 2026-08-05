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
export const JSON_COMPATIBILITY_RUNNER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-runner-staging" as const;
export const JSON_COMPATIBILITY_RUNNER_ENTRYPOINT =
  "JsonCompatibilityCampaignRunnerEntrypoint" as const;
export const JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-request-v1" as const;
export const JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-authorized-phase-request-v1" as const;
export const JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-subject-v1" as const;
export const JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-envelope-v1" as const;
export const JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v2" as const;
export const JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-status-request-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

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

export interface JsonCompatibilityOperatorCallerV1 {
  readonly serviceName: typeof JSON_COMPATIBILITY_RUNNER_SERVICE_NAME;
  readonly entrypoint: typeof JSON_COMPATIBILITY_RUNNER_ENTRYPOINT;
  readonly versionId: string;
  readonly configSha256: string;
  readonly gateName: "JSON_COMPATIBILITY_RUNNER_ENABLED";
  readonly privateRpcOnly: true;
}

export interface JsonCompatibilityOperatorPhaseApprovalSubjectV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT;
  readonly environment: "staging";
  readonly issuer: string;
  readonly audience: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
  readonly keyId: string;
  readonly operator: {
    readonly serviceName: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
    readonly versionId: string;
  };
  readonly caller: JsonCompatibilityOperatorCallerV1;
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly requestSha256: string;
  readonly commandIdSha256: string;
  readonly topologyReadbackSha256: string;
  readonly beforeContextSha256: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface JsonCompatibilityOperatorPhaseApprovalEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT;
  readonly algorithm: "Ed25519";
  readonly subject: JsonCompatibilityOperatorPhaseApprovalSubjectV1;
  readonly subjectSha256: string;
  readonly signerSpkiBase64url: string;
  readonly signatureBase64url: string;
}

export interface JsonCompatibilityOperatorAuthorizedPhaseRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT;
  readonly request: JsonCompatibilityOperatorPhaseRequestV1;
  readonly approval: JsonCompatibilityOperatorPhaseApprovalEnvelopeV1;
}

export interface JsonCompatibilityOperatorPhaseStatusRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT;
  readonly authorizedPhaseRequest:
    JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
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

export function parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(
  input: unknown,
): JsonCompatibilityOperatorAuthorizedPhaseRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "request",
    "approval",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    request: parseJsonCompatibilityOperatorPhaseRequestV1(value.request),
    approval: parseJsonCompatibilityOperatorPhaseApprovalEnvelopeV1(
      value.approval,
    ),
  };
}

export function parseJsonCompatibilityOperatorPhaseStatusRequestV1(
  input: unknown,
): JsonCompatibilityOperatorPhaseStatusRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "authorizedPhaseRequest",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
    authorizedPhaseRequest:
      parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(
        value.authorizedPhaseRequest,
      ),
  };
}

export function parseJsonCompatibilityOperatorPhaseApprovalEnvelopeV1(
  input: unknown,
): JsonCompatibilityOperatorPhaseApprovalEnvelopeV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signerSpkiBase64url",
    "signatureBase64url",
  ]);
  literal(value.schemaVersion, 1);
  literal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
  );
  literal(value.algorithm, "Ed25519");
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject: parseApprovalSubject(value.subject),
    subjectSha256: digest(value.subjectSha256),
    signerSpkiBase64url: base64url(value.signerSpkiBase64url, 56, 700),
    signatureBase64url: base64url(value.signatureBase64url, 86, 86),
  };
}

function parseApprovalSubject(
  input: unknown,
): JsonCompatibilityOperatorPhaseApprovalSubjectV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "environment",
    "issuer",
    "audience",
    "keyId",
    "operator",
    "caller",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "phaseOrdinal",
    "phaseId",
    "requestSha256",
    "commandIdSha256",
    "topologyReadbackSha256",
    "beforeContextSha256",
    "issuedAt",
    "notBefore",
    "expiresAt",
  ]);
  const operator = exactRecord(value.operator, ["serviceName", "versionId"]);
  const caller = exactRecord(value.caller, [
    "serviceName",
    "entrypoint",
    "versionId",
    "configSha256",
    "gateName",
    "privateRpcOnly",
  ]);
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    contract: literal(
      value.contract,
      JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
    ),
    environment: literal(value.environment, "staging"),
    issuer: token(value.issuer),
    audience: literal(
      value.audience,
      JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
    ),
    keyId: keyId(value.keyId),
    operator: {
      serviceName: literal(
        operator.serviceName,
        JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
      ),
      versionId: token(operator.versionId),
    },
    caller: {
      serviceName: literal(
        caller.serviceName,
        JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
      ),
      entrypoint: literal(
        caller.entrypoint,
        JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
      ),
      versionId: token(caller.versionId),
      configSha256: digest(caller.configSha256),
      gateName: literal(
        caller.gateName,
        "JSON_COMPATIBILITY_RUNNER_ENABLED",
      ),
      privateRpcOnly: literal(caller.privateRpcOnly, true),
    },
    campaignIdSha256: digest(value.campaignIdSha256),
    planDigestSha256: digest(value.planDigestSha256),
    phaseExecutionId: token(value.phaseExecutionId),
    phaseOrdinal: integer(value.phaseOrdinal, 1, 4) as 1 | 2 | 3 | 4,
    phaseId: token(value.phaseId),
    requestSha256: digest(value.requestSha256),
    commandIdSha256: digest(value.commandIdSha256),
    topologyReadbackSha256: digest(value.topologyReadbackSha256),
    beforeContextSha256: digest(value.beforeContextSha256),
    issuedAt: integer(value.issuedAt, 0, Number.MAX_SAFE_INTEGER),
    notBefore: integer(value.notBefore, 0, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER),
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

function keyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw protocolError();
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw protocolError();
  }
  return value as number;
}

function base64url(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
): string {
  if (
    typeof value !== "string"
    || value.length < minimumCharacters
    || value.length > maximumCharacters
    || !BASE64URL.test(value)
  ) {
    throw protocolError();
  }
  return value;
}

function protocolError(): JsonCompatibilityOperatorProtocolError {
  return new JsonCompatibilityOperatorProtocolError(
    "invalid_operator_phase_request",
  );
}
