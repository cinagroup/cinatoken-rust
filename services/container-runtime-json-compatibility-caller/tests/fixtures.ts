import {
  getJsonCompatibilityOperatorPhaseStatus,
  invokeJsonCompatibilityOperatorPhase,
} from "../../container-runtime-json-compatibility-operator/src/operator";
import {
  JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
} from "../../container-runtime-json-compatibility-operator/src/protocol";
import {
  NOW_MS,
  OPERATOR_VERSION_ID,
  operatorEnv,
  runtimeSequence,
  validInvokeCommandForOperatorRequest,
  validPrivateInvocationReceipt,
  validPrivateInvocationStatusReceipt,
} from "../../container-runtime-json-compatibility-operator/tests/fixtures";
import {
  getJsonCompatibilityRunnerPhaseStatus,
  invokeJsonCompatibilityRunnerPhase,
  type JsonCompatibilityRunnerEnv,
} from "../../container-runtime-json-compatibility-runner/src/runner";
import {
  JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../../container-runtime-json-compatibility-runner/src/protocol";
import type { JsonCompatibilityCallerEnv } from "../src/caller";

export const CALLER_VERSION_ID = "caller-version-001";
export const RUNNER_VERSION_ID = "runner-version-001";
export const RUNNER_CONFIG_SHA256 = "c1".repeat(32);

export function callerEnv(
  invokePhase: (input: unknown) => Promise<unknown>,
  getPhaseStatus: (input: unknown) => Promise<unknown>,
  overrides: {
    readonly environment?: string;
    readonly enabled?: boolean;
    readonly statusEnabled?: boolean;
    readonly runnerVersionId?: string;
    readonly runnerConfigSha256?: string;
  } = {},
): JsonCompatibilityCallerEnv {
  return {
    ENVIRONMENT: overrides.environment ?? "staging",
    JSON_COMPATIBILITY_CALLER_ENABLED:
      overrides.enabled === false ? "false" : "true",
    JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED:
      overrides.statusEnabled === false ? "false" : "true",
    JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID:
      overrides.runnerVersionId ?? RUNNER_VERSION_ID,
    JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256:
      overrides.runnerConfigSha256 ?? RUNNER_CONFIG_SHA256,
    CF_VERSION_METADATA: { id: CALLER_VERSION_ID },
    JSON_COMPATIBILITY_RUNNER_SERVICE: { invokePhase, getPhaseStatus },
  };
}

export async function validRunnerInvocationReceipt(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  runnerStartedAtMs = NOW_MS,
) {
  return await invokeJsonCompatibilityRunnerPhase(
    runnerEnv(
      async (input) => await invokeJsonCompatibilityOperatorPhase(
        operatorEnv(async (command) =>
          await validPrivateInvocationReceipt(command)),
        input,
        runtimeSequence(NOW_MS, NOW_MS + 2_000),
      ),
      async () => {
        throw new Error("unexpected status query");
      },
    ),
    authorized,
    runtimeSequence(runnerStartedAtMs, runnerStartedAtMs + 3_000),
  );
}

export async function validRunnerStatusReceipt(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  runnerStartedAtMs = NOW_MS + 3_600_000,
) {
  const request = authorized.request;
  const command = await validInvokeCommandForOperatorRequest(request);
  const privateReceipt = await validPrivateInvocationReceipt(command);
  return await getJsonCompatibilityRunnerPhaseStatus(
    runnerEnv(
      async () => {
        throw new Error("execution must not be retried");
      },
      async (input) => await getJsonCompatibilityOperatorPhaseStatus(
        operatorEnv(
          async () => {
            throw new Error("execution must not be retried");
          },
          true,
          async (query) =>
            await validPrivateInvocationStatusReceipt(query, privateReceipt),
        ),
        input,
        runtimeSequence(runnerStartedAtMs, runnerStartedAtMs + 1_000),
      ),
    ),
    {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
      authorizedPhaseRequest: authorized,
    },
    runtimeSequence(runnerStartedAtMs, runnerStartedAtMs + 2_000),
  );
}

function runnerEnv(
  invokePhase: (input: unknown) => Promise<unknown>,
  getPhaseStatus: (input: unknown) => Promise<unknown>,
): JsonCompatibilityRunnerEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_RUNNER_ENABLED: "true",
    JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: "true",
    JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID: OPERATOR_VERSION_ID,
    CF_VERSION_METADATA: { id: RUNNER_VERSION_ID },
    JSON_COMPATIBILITY_OPERATOR_SERVICE: { invokePhase, getPhaseStatus },
  };
}
