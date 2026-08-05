import { describe, expect, test } from "vitest";

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
  OPERATOR_VERSION_ID,
  operatorEnv,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validInvokeCommandForOperatorRequest,
  validOperatorRequest,
  validPrivateInvocationReceipt,
  validPrivateInvocationStatusReceipt,
} from "../../container-runtime-json-compatibility-operator/tests/fixtures";
import {
  JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../src/protocol";
import {
  JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
  getJsonCompatibilityRunnerPhaseStatus,
  invokeJsonCompatibilityRunnerPhase,
  type JsonCompatibilityRunnerEnv,
} from "../src/runner";

const RUNNER_VERSION_ID = "runner-version-001";

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

async function operatorInvocationReceipt(input: unknown) {
  return await invokeJsonCompatibilityOperatorPhase(
    operatorEnv(async (command) =>
      await validPrivateInvocationReceipt(command)),
    input,
    runtimeSequence(NOW_MS, NOW_MS + 2_000),
  );
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("test fixture must be an object");
  }
  return value as Record<string, unknown>;
}

async function resealCanonicalReceipt(
  receipt: Record<string, unknown>,
): Promise<void> {
  const { receiptSha256: _receiptSha256, ...subject } = receipt;
  receipt.receiptSha256 = await sha256Hex(canonicalJson(subject));
}

async function resealOperatorReceipt(
  receipt: Record<string, unknown>,
): Promise<void> {
  const {
    operatorBodySha256: _operatorBodySha256,
    receiptSha256: _receiptSha256,
    ...body
  } = receipt;
  const operatorBodySha256 = await sha256Hex(canonicalJson(body));
  receipt.operatorBodySha256 = operatorBodySha256;
  receipt.receiptSha256 = await sha256Hex(canonicalJson({
    ...body,
    operatorBodySha256,
  }));
}

describe("private JSON compatibility campaign Runner", () => {
  test("binds the signed caller to its actual version and wraps one Operator RPC", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    const receipt = await invokeJsonCompatibilityRunnerPhase(
      runnerEnv(
        async (input) => {
          calls += 1;
          return await operatorInvocationReceipt(input);
        },
        async () => {
          throw new Error("unexpected status query");
        },
      ),
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 3_000),
    );
    expect(calls).toBe(1);
    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
      status: "runner_phase_invocation_completed",
      runner: {
        versionId: RUNNER_VERSION_ID,
        gateName: "JSON_COMPATIBILITY_RUNNER_ENABLED",
        privateRpcOnly: true,
      },
      operator: { versionId: OPERATOR_VERSION_ID },
      privateTransport: {
        kind: "service-binding-rpc",
        rpcMethod: "invokePhase",
        publicUrlUsed: false,
        cloudflareRestUsed: false,
      },
    });
    const { runnerBodySha256, receiptSha256, ...body } = receipt;
    expect(runnerBodySha256).toBe(await sha256Hex(canonicalJson(body)));
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson({
      ...body,
      runnerBodySha256,
    })));
  });

  test("rejects caller-version drift before the Operator RPC", async () => {
    const authorized = await validAuthorizedOperatorRequest(undefined, {
      callerVersionId: "different-runner-version",
    });
    let calls = 0;
    await expect(invokeJsonCompatibilityRunnerPhase(
      runnerEnv(
        async () => {
          calls += 1;
          return {};
        },
        async () => ({}),
      ),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "runner_caller_binding_mismatch" });
    expect(calls).toBe(0);
  });

  test("rejects an outer-valid Operator receipt with a detached private receipt", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    const operatorReceipt = mutableRecord(structuredClone(
      await operatorInvocationReceipt(authorized),
    ));
    const detachedPrivateReceipt: Record<string, unknown> = {
      contract: "detached-private-receipt",
      status: "completed",
    };
    await resealCanonicalReceipt(detachedPrivateReceipt);
    operatorReceipt.privateInvocationReceipt = detachedPrivateReceipt;
    operatorReceipt.privateInvocationReceiptSha256 = await sha256Hex(
      canonicalJson(detachedPrivateReceipt),
    );
    await resealOperatorReceipt(operatorReceipt);

    await expect(invokeJsonCompatibilityRunnerPhase(
      runnerEnv(async () => operatorReceipt, async () => ({})),
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 3_000),
    )).rejects.toMatchObject({ code: "invalid_operator_receipt" });
  });

  test("uses only the read-only Operator status method during recovery", async () => {
    const request = validOperatorRequest("14".repeat(32));
    const authorized = await validAuthorizedOperatorRequest(request);
    const command = await validInvokeCommandForOperatorRequest(request);
    const privateReceipt = await validPrivateInvocationReceipt(command);
    const statusStart = NOW_MS + 3_600_000;
    let invokeCalls = 0;
    let statusCalls = 0;
    const receipt = await getJsonCompatibilityRunnerPhaseStatus(
      runnerEnv(
        async () => {
          invokeCalls += 1;
          throw new Error("execution must not be retried");
        },
        async (input) => {
          statusCalls += 1;
          return await getJsonCompatibilityOperatorPhaseStatus(
            operatorEnv(
              async () => {
                throw new Error("execution must not be retried");
              },
              true,
              async (query) =>
                await validPrivateInvocationStatusReceipt(query, privateReceipt),
            ),
            input,
            runtimeSequence(statusStart, statusStart + 1_000),
          );
        },
      ),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(statusStart, statusStart + 2_000),
    );
    expect(invokeCalls).toBe(0);
    expect(statusCalls).toBe(1);
    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
      status: "runner_phase_status_observed",
      phaseStatus: "completed",
      runner: {
        gateName: "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
      },
      recovery: {
        executionRetryPermitted: false,
        operatorInvokePhaseCalled: false,
        originalRunnerReceiptReconstructed: false,
      },
    });
  });

  test("rejects completed outer status when the nested private result disagrees", async () => {
    const request = validOperatorRequest("15".repeat(32));
    const authorized = await validAuthorizedOperatorRequest(request);
    const command = await validInvokeCommandForOperatorRequest(request);
    const privateReceipt = await validPrivateInvocationReceipt(command);
    const statusStart = NOW_MS + 3_600_000;
    const operatorStatusReceipt = mutableRecord(structuredClone(
      await getJsonCompatibilityOperatorPhaseStatus(
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
      ),
    ));
    const privateStatus = mutableRecord(
      operatorStatusReceipt.privateInvocationStatusReceipt,
    );
    mutableRecord(privateStatus.result).status = "failed";
    await resealCanonicalReceipt(privateStatus);
    operatorStatusReceipt.privateInvocationStatusReceiptSha256 =
      await sha256Hex(canonicalJson(privateStatus));
    await resealOperatorReceipt(operatorStatusReceipt);

    await expect(getJsonCompatibilityRunnerPhaseStatus(
      runnerEnv(async () => ({}), async () => operatorStatusReceipt),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_RUNNER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(statusStart, statusStart + 2_000),
    )).rejects.toMatchObject({ code: "invalid_operator_receipt" });
  });

  test("maps every Operator RPC exception to one non-retried unavailable result", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    await expect(invokeJsonCompatibilityRunnerPhase(
      runnerEnv(
        async () => {
          calls += 1;
          throw Object.assign(new Error("remote"), { code: "business_code" });
        },
        async () => ({}),
      ),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(calls).toBe(1);
  });

  test("keeps Runner and Operator status wrappers non-interchangeable", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    await expect(getJsonCompatibilityRunnerPhaseStatus(
      runnerEnv(async () => ({}), async () => {
        calls += 1;
        return {};
      }),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invalid_runner_request" });
    expect(calls).toBe(0);
  });
});
