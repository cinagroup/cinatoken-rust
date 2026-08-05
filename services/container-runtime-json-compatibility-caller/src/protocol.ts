import {
  parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
} from "../../container-runtime-json-compatibility-operator/src/protocol";
import {
  JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../../container-runtime-json-compatibility-runner/src/protocol";

export const JSON_COMPATIBILITY_CALLER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-caller-staging" as const;
export const JSON_COMPATIBILITY_CALLER_ENTRYPOINT =
  "JsonCompatibilityCampaignCallerEntrypoint" as const;
export const JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-phase-status-request-v1" as const;

export interface JsonCompatibilityCallerPhaseStatusRequestV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT;
  readonly authorizedPhaseRequest:
    JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
}

export function parseJsonCompatibilityCallerPhaseStatusRequestV1(
  input: unknown,
): JsonCompatibilityCallerPhaseStatusRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "contract",
    "authorizedPhaseRequest",
  ]);
  if (
    value.schemaVersion !== 1
    || value.contract !== JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT
  ) {
    throw new Error("invalid_caller_status_request");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
    authorizedPhaseRequest:
      parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(
        value.authorizedPhaseRequest,
      ),
  };
}

export function runnerStatusRequest(
  authorizedPhaseRequest: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
) {
  return {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
    authorizedPhaseRequest,
  };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_caller_status_request");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("invalid_caller_status_request");
  }
  return value;
}
