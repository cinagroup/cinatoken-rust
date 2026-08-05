import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  getJsonCompatibilityOperatorPhaseStatus,
  invokeJsonCompatibilityOperatorPhase,
} from "../../container-runtime-json-compatibility-operator/src/operator";
import {
  JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
} from "../../container-runtime-json-compatibility-operator/src/protocol";
import {
  NOW_MS,
  operatorEnv,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validInvokeCommandForOperatorRequest,
  validOperatorRequest,
  validPrivateInvocationReceipt,
  validPrivateInvocationStatusReceipt,
} from "../../container-runtime-json-compatibility-operator/tests/fixtures";
import {
  JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
  type JsonCompatibilityRunnerInvocationReceiptV1,
  type JsonCompatibilityRunnerStatusReceiptV1,
} from "../src/runner";
import {
  JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../src/protocol";

interface RunnerRpcBinding {
  invokePhase(input: unknown): Promise<JsonCompatibilityRunnerInvocationReceiptV1>;
  getPhaseStatus(input: unknown): Promise<JsonCompatibilityRunnerStatusReceiptV1>;
}

interface OperatorMockControlBinding {
  reset(): Promise<void>;
  setInvocationReceipt(value: unknown): Promise<void>;
  setStatusReceipt(value: unknown): Promise<void>;
}

const runtimeEnv = env as unknown as {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_RUNNER_NAMED: RunnerRpcBinding;
  readonly JSON_COMPATIBILITY_RUNNER_DEFAULT: RunnerRpcBinding;
  readonly JSON_COMPATIBILITY_OPERATOR_MOCK_CONTROL:
    OperatorMockControlBinding;
};

async function validOperatorReceipt(input: unknown) {
  return await invokeJsonCompatibilityOperatorPhase(
    operatorEnv(async (command) =>
      await validPrivateInvocationReceipt(command)),
    input,
    runtimeSequence(NOW_MS, NOW_MS + 2_000),
  );
}

async function runtimeAuthorizedRequest(
  request = validOperatorRequest(),
) {
  return await validAuthorizedOperatorRequest(request, {
    callerVersionId: runtimeEnv.CF_VERSION_METADATA.id,
  });
}

describe("Runner named Service Binding runtime", () => {
  beforeEach(async () => {
    await runtimeEnv.JSON_COMPATIBILITY_OPERATOR_MOCK_CONTROL.reset();
  });

  test("round-trips one named Runner RPC through one named Operator RPC", async () => {
    const authorized = await runtimeAuthorizedRequest();
    await runtimeEnv.JSON_COMPATIBILITY_OPERATOR_MOCK_CONTROL
      .setInvocationReceipt(await validOperatorReceipt(authorized));

    const receipt = await runtimeEnv.JSON_COMPATIBILITY_RUNNER_NAMED
      .invokePhase(authorized);

    expect(receipt.contract).toBe(
      JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
    );
    expect(receipt.status).toBe("runner_phase_invocation_completed");
    expect(receipt.privateTransport).toMatchObject({
      kind: "service-binding-rpc",
      operatorBinding: "JSON_COMPATIBILITY_OPERATOR_SERVICE",
      rpcMethod: "invokePhase",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
    });
    const { runnerBodySha256, receiptSha256, ...body } = receipt;
    expect(runnerBodySha256).toBe(await sha256Hex(canonicalJson(body)));
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson({
      ...body,
      runnerBodySha256,
    })));
  });

  test("round-trips the read-only status path without an execution RPC", async () => {
    const request = validOperatorRequest("14".repeat(32));
    const authorized = await runtimeAuthorizedRequest(request);
    const command = await validInvokeCommandForOperatorRequest(request);
    const privateReceipt = await validPrivateInvocationReceipt(command);
    const statusStart = NOW_MS + 3_600_000;
    const operatorStatusReceipt = await getJsonCompatibilityOperatorPhaseStatus(
      operatorEnv(
        async () => {
          throw new Error("execution must not be retried");
        },
        true,
        async (query) =>
          await validPrivateInvocationStatusReceipt(query, privateReceipt),
      ),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(statusStart, statusStart + 1_000),
    );
    await runtimeEnv.JSON_COMPATIBILITY_OPERATOR_MOCK_CONTROL
      .setStatusReceipt(operatorStatusReceipt);

    const receipt = await runtimeEnv.JSON_COMPATIBILITY_RUNNER_NAMED
      .getPhaseStatus({
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      });

    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
      status: "runner_phase_status_observed",
      phaseStatus: "completed",
      recovery: {
        executionRetryPermitted: false,
        operatorInvokePhaseCalled: false,
        originalRunnerReceiptReconstructed: false,
      },
      privateTransport: {
        rpcMethod: "getPhaseStatus",
      },
    });
  });
});
