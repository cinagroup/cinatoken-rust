import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  NOW_MS,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validOperatorRequest,
} from "../../container-runtime-json-compatibility-operator/tests/fixtures";
import {
  JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
  getJsonCompatibilityCallerPhaseStatus,
  invokeJsonCompatibilityCallerPhase,
} from "../src/caller";
import {
  JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../src/protocol";
import {
  CALLER_VERSION_ID,
  RUNNER_CONFIG_SHA256,
  RUNNER_VERSION_ID,
  callerEnv,
  validRunnerInvocationReceipt,
  validRunnerStatusReceipt,
} from "./fixtures";

describe("private JSON compatibility campaign Caller", () => {
  test("pins Runner identity and wraps exactly one invocation RPC", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    const runnerReceipt = await validRunnerInvocationReceipt(authorized);
    let calls = 0;
    const receipt = await invokeJsonCompatibilityCallerPhase(
      callerEnv(
        async () => {
          calls += 1;
          return runnerReceipt;
        },
        async () => {
          throw new Error("unexpected status query");
        },
      ),
      authorized,
      runtimeSequence(NOW_MS - 1_000, NOW_MS + 4_000),
    );

    expect(calls).toBe(1);
    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
      status: "caller_phase_invocation_completed",
      caller: {
        versionId: CALLER_VERSION_ID,
        gateName: "JSON_COMPATIBILITY_CALLER_ENABLED",
        privateRpcOnly: true,
      },
      runner: {
        versionId: RUNNER_VERSION_ID,
        configSha256: RUNNER_CONFIG_SHA256,
      },
      privateTransport: {
        kind: "service-binding-rpc",
        runnerBinding: "JSON_COMPATIBILITY_RUNNER_SERVICE",
        rpcMethod: "invokePhase",
        publicUrlUsed: false,
        cloudflareRestUsed: false,
      },
    });
    await expectCallerDigests(receipt);
  });

  test("rejects Runner version or config drift before the RPC", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(
        async () => {
          calls += 1;
          return {};
        },
        async () => ({}),
        { runnerVersionId: "runner-version-002" },
      ),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "caller_runner_binding_mismatch" });
    expect(calls).toBe(0);

    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(async () => ({}), async () => ({}), {
        runnerConfigSha256: "d2".repeat(32),
      }),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "caller_runner_binding_mismatch" });
  });

  test("rejects a resealed Runner receipt with a detached deep private receipt", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    const runnerReceipt = mutableRecord(structuredClone(
      await validRunnerInvocationReceipt(authorized),
    ));
    const operatorReceipt = mutableRecord(runnerReceipt.operatorReceipt);
    const privateReceipt = mutableRecord(
      operatorReceipt.privateInvocationReceipt,
    );
    privateReceipt.phaseId = "candidate-n";
    await resealCanonicalReceipt(privateReceipt);
    operatorReceipt.privateInvocationReceiptSha256 = await sha256Hex(
      canonicalJson(privateReceipt),
    );
    await resealOperatorReceipt(operatorReceipt);
    runnerReceipt.operatorReceiptSha256 = await sha256Hex(
      canonicalJson(operatorReceipt),
    );
    await resealRunnerReceipt(runnerReceipt);

    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(async () => runnerReceipt, async () => ({})),
      authorized,
      runtimeSequence(NOW_MS - 1_000, NOW_MS + 4_000),
    )).rejects.toMatchObject({ code: "invalid_runner_receipt" });
  });

  test("maps one Runner exception without retrying", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(
        async () => {
          calls += 1;
          throw Object.assign(new Error("remote"), { code: "internal" });
        },
        async () => ({}),
      ),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "runner_unavailable" });
    expect(calls).toBe(1);
  });

  test("maps one Runner status exception without invoking execution", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let invokeCalls = 0;
    let statusCalls = 0;
    await expect(getJsonCompatibilityCallerPhaseStatus(
      callerEnv(
        async () => {
          invokeCalls += 1;
          return {};
        },
        async () => {
          statusCalls += 1;
          throw new Error("remote status failure");
        },
      ),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "runner_unavailable" });
    expect(invokeCalls).toBe(0);
    expect(statusCalls).toBe(1);
  });

  test("uses only one read-only Runner status RPC", async () => {
    const request = validOperatorRequest("14".repeat(32));
    const authorized = await validAuthorizedOperatorRequest(request);
    const statusStart = NOW_MS + 3_600_000;
    const runnerReceipt = await validRunnerStatusReceipt(
      authorized,
      statusStart,
    );
    let invokeCalls = 0;
    let statusCalls = 0;
    const callerStatusRequest = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
      authorizedPhaseRequest: authorized,
    };
    const receipt = await getJsonCompatibilityCallerPhaseStatus(
      callerEnv(
        async () => {
          invokeCalls += 1;
          throw new Error("execution must not be retried");
        },
        async () => {
          statusCalls += 1;
          return runnerReceipt;
        },
      ),
      callerStatusRequest,
      runtimeSequence(statusStart - 1_000, statusStart + 3_000),
    );

    expect(invokeCalls).toBe(0);
    expect(statusCalls).toBe(1);
    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
      status: "caller_phase_status_observed",
      phaseStatus: "completed",
      caller: {
        gateName: "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
      },
      privateTransport: { rpcMethod: "getPhaseStatus" },
      recovery: {
        executionRetryPermitted: false,
        runnerInvokePhaseCalled: false,
        originalCallerReceiptReconstructed: false,
      },
    });
    expect(receipt.callerStatusRequestSha256).toBe(
      await sha256Hex(canonicalJson(callerStatusRequest)),
    );
    await expectCallerDigests(receipt);
  });

  test("keeps status wrappers strict and gates both capabilities", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    let calls = 0;
    await expect(getJsonCompatibilityCallerPhaseStatus(
      callerEnv(async () => ({}), async () => {
        calls += 1;
        return {};
      }),
      {
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-runner-phase-status-request-v1",
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invalid_caller_request" });
    expect(calls).toBe(0);

    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(async () => ({}), async () => ({}), { enabled: false }),
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "caller_disabled" });

    await expect(getJsonCompatibilityCallerPhaseStatus(
      callerEnv(async () => ({}), async () => ({}), {
        statusEnabled: false,
      }),
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: authorized,
      },
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "caller_status_disabled" });
  });

  test("rejects non-JSON and over-deep input before the Runner RPC", async () => {
    let calls = 0;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 70; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(async () => {
        calls += 1;
        return {};
      }, async () => ({})),
      deep,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invalid_caller_request" });
    expect(calls).toBe(0);

    await expect(invokeJsonCompatibilityCallerPhase(
      callerEnv(async () => {
        calls += 1;
        return {};
      }, async () => ({})),
      { payload: "x".repeat(513 * 1024) },
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invalid_caller_request" });
    expect(calls).toBe(0);
  });
});

async function expectCallerDigests(
  receipt: Record<string, unknown>,
): Promise<void> {
  const { callerBodySha256, receiptSha256, ...body } = receipt;
  expect(callerBodySha256).toBe(await sha256Hex(canonicalJson(body)));
  expect(receiptSha256).toBe(await sha256Hex(canonicalJson({
    ...body,
    callerBodySha256,
  })));
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

async function resealRunnerReceipt(
  receipt: Record<string, unknown>,
): Promise<void> {
  const {
    runnerBodySha256: _runnerBodySha256,
    receiptSha256: _receiptSha256,
    ...body
  } = receipt;
  const runnerBodySha256 = await sha256Hex(canonicalJson(body));
  receipt.runnerBodySha256 = runnerBodySha256;
  receipt.receiptSha256 = await sha256Hex(canonicalJson({
    ...body,
    runnerBodySha256,
  }));
}
