import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import {
  validAuthorizedOperatorRequest,
  validOperatorRequest,
} from "../../container-runtime-json-compatibility-operator/tests/fixtures";
import {
  JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
  type JsonCompatibilityCallerInvocationReceiptV1,
  type JsonCompatibilityCallerStatusReceiptV1,
} from "../src/caller";
import {
  JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../src/protocol";
import {
  validRunnerInvocationReceipt,
  validRunnerStatusReceipt,
} from "./fixtures";

interface CallerRpcBinding {
  invokePhase(input: unknown): Promise<JsonCompatibilityCallerInvocationReceiptV1>;
  getPhaseStatus(input: unknown): Promise<JsonCompatibilityCallerStatusReceiptV1>;
}

interface RunnerMockControlBinding {
  reset(): Promise<void>;
  setInvocationReceipt(value: unknown): Promise<void>;
  setStatusReceipt(value: unknown): Promise<void>;
  getCallCounts(): Promise<{
    readonly invocationCalls: number;
    readonly statusCalls: number;
  }>;
}

const runtimeEnv = env as unknown as {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_CALLER_NAMED: CallerRpcBinding;
  readonly JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL: RunnerMockControlBinding;
};

describe("Caller named Service Binding runtime", () => {
  beforeEach(async () => {
    await runtimeEnv.JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL.reset();
  });

  test("round-trips one named Caller RPC through one named Runner RPC", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    await runtimeEnv.JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL
      .setInvocationReceipt(await validRunnerInvocationReceipt(authorized));

    const receipt = await runtimeEnv.JSON_COMPATIBILITY_CALLER_NAMED
      .invokePhase(authorized);

    expect(receipt.contract).toBe(
      JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
    );
    expect(receipt.status).toBe("caller_phase_invocation_completed");
    expect(receipt.caller.versionId).toBe(runtimeEnv.CF_VERSION_METADATA.id);
    expect(receipt.privateTransport).toMatchObject({
      kind: "service-binding-rpc",
      runnerBinding: "JSON_COMPATIBILITY_RUNNER_SERVICE",
      rpcMethod: "invokePhase",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
    });
    await expect(runtimeEnv.JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL
      .getCallCounts()).resolves.toEqual({
      invocationCalls: 1,
      statusCalls: 0,
    });
  });

  test("round-trips status without invoking execution", async () => {
    const request = validOperatorRequest("14".repeat(32));
    const authorized = await validAuthorizedOperatorRequest(request);
    await runtimeEnv.JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL
      .setStatusReceipt(await validRunnerStatusReceipt(authorized));

    const receipt = await runtimeEnv.JSON_COMPATIBILITY_CALLER_NAMED
      .getPhaseStatus({
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      });

    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
      status: "caller_phase_status_observed",
      phaseStatus: "completed",
      recovery: {
        executionRetryPermitted: false,
        runnerInvokePhaseCalled: false,
        originalCallerReceiptReconstructed: false,
      },
      privateTransport: { rpcMethod: "getPhaseStatus" },
    });
    await expect(runtimeEnv.JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL
      .getCallCounts()).resolves.toEqual({
      invocationCalls: 0,
      statusCalls: 1,
    });
  });
});
