import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  executeDeploymentTransition,
  type DeploymentTransitionEnv,
  type DeploymentTransitionStatusV1,
} from "../src/coordinator";
import type {
  JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

interface TransitionRpcBinding {
  executeTransition(
    input: unknown,
  ): Promise<JsonCompatibilityDeploymentTransitionReceiptV1>;
  getTransitionStatus(input: unknown): Promise<DeploymentTransitionStatusV1>;
}

interface MockControlBinding {
  reset(): Promise<void>;
  getCallCounts(): Promise<{
    readonly sourceAuthenticationCalls: number;
    readonly readbackCalls: number;
    readonly mutationCalls: number;
  }>;
}

interface RuntimeTestEnv extends DeploymentTransitionEnv {
  readonly TEST_D1_MIGRATIONS: D1Migration[];
  readonly TEST_TRANSITION_INVOCATION: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED:
    TransitionRpcBinding;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL:
    MockControlBinding;
}

const runtimeEnv = env as unknown as RuntimeTestEnv;

beforeEach(async () => {
  await applyD1Migrations(runtimeEnv.DB, runtimeEnv.TEST_D1_MIGRATIONS);
  await runtimeEnv.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL.reset();
});

afterEach(async () => {
  await reset();
});

describe("deployment transition named RPC with real D1", () => {
  test("linearizes concurrent execution and makes replay/status mutation-free", async () => {
    const invocation: unknown = JSON.parse(
      runtimeEnv.TEST_TRANSITION_INVOCATION,
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        runtimeEnv.JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED
          .executeTransition(invocation)),
    );
    const receipts = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : []);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(receipts.map((receipt) => receipt.receiptDigestSha256)).size)
      .toBe(1);
    expect(
      receipts[0],
      JSON.stringify({
        result: receipts[0]?.result,
        stopReason: receipts[0]?.stopReason,
        steps: receipts[0]?.steps,
      }),
    ).toMatchObject({
      result: "completed",
      nextTransitionAllowed: true,
      mutationAttempts: 4,
      automaticRetries: 0,
      readbackAttempts: 16,
    });

    const callsAfterExecution = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL.getCallCounts();
    expect(callsAfterExecution).toEqual({
      sourceAuthenticationCalls: 1,
      readbackCalls: 16,
      mutationCalls: 4,
    });

    const counts = await runtimeEnv.DB.prepare(
      `SELECT
        (SELECT COUNT(*)
         FROM json_compatibility_deployment_transition_operations)
          AS operations,
        (SELECT COUNT(*)
         FROM json_compatibility_deployment_transition_events)
          AS events,
        (SELECT COUNT(*)
         FROM json_compatibility_deployment_transition_receipts)
          AS receipts`,
    ).first();
    expect(counts).toEqual({ operations: 1, events: 25, receipts: 1 });

    const replay = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED
      .executeTransition(invocation);
    expect(replay.receiptDigestSha256).toBe(
      receipts[0]?.receiptDigestSha256,
    );
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL.getCallCounts())
      .toEqual(callsAfterExecution);

    const status = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED
      .getTransitionStatus(invocation);
    expect(status).toMatchObject({
      classification: "terminal",
      transitionResult: "completed",
      eventCount: 25,
      mutationIntentCount: 4,
      mutationOutcomeCount: 4,
      sourceVerifierCalled: false,
      deploymentLeafReadCalled: false,
      deploymentLeafMutationCalled: false,
      executionRetryPermitted: false,
      coordinator: {
        versionId: "deployment-transition-runtime-version-001",
        privateRpcOnly: true,
      },
    });
    expect(status.receipt?.receiptDigestSha256).toBe(
      replay.receiptDigestSha256,
    );
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL.getCallCounts())
      .toEqual(callsAfterExecution);

    for (const table of ["operations", "events", "receipts"]) {
      const qualified =
        `json_compatibility_deployment_transition_${table}`;
      await expect(runtimeEnv.DB.prepare(
        `UPDATE ${qualified} SET operation_id_sha256 = operation_id_sha256`,
      ).run()).rejects.toThrow();
      await expect(runtimeEnv.DB.prepare(
        `DELETE FROM ${qualified}`,
      ).run()).rejects.toThrow();
    }
  });

  test("rejects disabled execution before D1 or either downstream binding", async () => {
    const invocation: unknown = JSON.parse(
      runtimeEnv.TEST_TRANSITION_INVOCATION,
    );
    const disabledEnv: DeploymentTransitionEnv = {
      ...runtimeEnv,
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_ENABLED: "false",
    };
    await expect(executeDeploymentTransition(disabledEnv, invocation))
      .rejects.toMatchObject({ code: "transition_execution_disabled" });
    expect(await runtimeEnv.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM json_compatibility_deployment_transition_operations`,
    ).first()).toEqual({ count: 0 });
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL.getCallCounts())
      .toEqual({
        sourceAuthenticationCalls: 0,
        readbackCalls: 0,
        mutationCalls: 0,
      });
  });
});
