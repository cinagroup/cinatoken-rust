import {
  JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
  parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
} from "../../container-runtime-json-compatibility-operator/src/protocol";

export const JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-runner-phase-status-request-v1" as const;

export interface JsonCompatibilityRunnerPhaseStatusRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT;
  readonly authorizedPhaseRequest:
    JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
}

export function parseJsonCompatibilityRunnerPhaseStatusRequestV1(
  input: unknown,
): JsonCompatibilityRunnerPhaseStatusRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "authorizedPhaseRequest",
  ]);
  if (
    value.schemaVersion !== 1
    || value.contract !== JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT
  ) {
    throw new Error("invalid_runner_status_request");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
    authorizedPhaseRequest:
      parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(
        value.authorizedPhaseRequest,
      ),
  };
}

export function operatorStatusRequest(
  authorizedPhaseRequest: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
) {
  return {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
    authorizedPhaseRequest,
  };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_runner_status_request");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("invalid_runner_status_request");
  }
  return value;
}
