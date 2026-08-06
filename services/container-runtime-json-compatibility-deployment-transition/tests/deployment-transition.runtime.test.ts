import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  executeDeploymentTransition,
  type DeploymentTransitionEnv,
  type DeploymentTransitionStatusV2,
} from "../src/coordinator";
import type {
  JsonCompatibilityDeploymentTransitionReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

interface TransitionRpcBinding {
  executeTransition(
    input: unknown,
  ): Promise<JsonCompatibilityDeploymentTransitionReceiptV1>;
  getTransitionStatus(input: unknown): Promise<DeploymentTransitionStatusV2>;
}

interface MockControlBinding {
  reset(): Promise<void>;
  getCallCount(): Promise<number>;
}

interface SourceVerifierProxyControlBinding {
  reset(): Promise<void>;
  getCallCount(): Promise<number>;
}

interface RuntimeTestEnv extends DeploymentTransitionEnv {
  readonly TEST_D1_MIGRATIONS: D1Migration[];
  readonly TEST_TRANSITION_INVOCATION: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUCKET: R2Bucket;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256: string;
  readonly TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256: string;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED:
    TransitionRpcBinding;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL:
    MockControlBinding;
  readonly JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL:
    MockControlBinding;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL:
    SourceVerifierProxyControlBinding;
}

const runtimeEnv = env as unknown as RuntimeTestEnv;

beforeEach(async () => {
  await applyD1Migrations(runtimeEnv.DB, runtimeEnv.TEST_D1_MIGRATIONS);
  await runtimeEnv.JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL.reset();
  await runtimeEnv.JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL.reset();
  await runtimeEnv.JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL.reset();
  await runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUCKET.put(
    runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY,
    runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE,
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contract:
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3",
        bundleSha256: runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256,
        sourceSignatureEnvelopeSha256:
          runtimeEnv.TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256,
      },
    },
  );
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

    const readbackCallsAfterExecution = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL.getCallCount();
    const mutationCallsAfterExecution = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL.getCallCount();
    expect(readbackCallsAfterExecution).toBe(16);
    expect(mutationCallsAfterExecution).toBe(4);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL.getCallCount())
      .toBe(1);

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
          AS receipts,
        (SELECT COUNT(*)
         FROM json_compatibility_deployment_transition_authorities)
          AS authorities`,
    ).first();
    expect(counts).toEqual({
      operations: 1,
      events: 25,
      receipts: 1,
      authorities: 1,
    });

    const replay = await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED
      .executeTransition(invocation);
    expect(replay.receiptDigestSha256).toBe(
      receipts[0]?.receiptDigestSha256,
    );
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL.getCallCount())
      .toBe(readbackCallsAfterExecution);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL.getCallCount())
      .toBe(mutationCallsAfterExecution);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL.getCallCount())
      .toBe(1);

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
      deploymentReadbackCalled: false,
      deploymentMutationCalled: false,
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
      .JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL.getCallCount())
      .toBe(readbackCallsAfterExecution);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL.getCallCount())
      .toBe(mutationCallsAfterExecution);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL.getCallCount())
      .toBe(1);

    for (const table of [
      "operations",
      "events",
      "receipts",
      "authorities",
    ]) {
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
      .JSON_COMPATIBILITY_DEPLOYMENT_READBACK_MOCK_CONTROL.getCallCount())
      .toBe(0);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_MOCK_CONTROL.getCallCount())
      .toBe(0);
    expect(await runtimeEnv
      .JSON_COMPATIBILITY_SOURCE_VERIFIER_PROXY_CONTROL.getCallCount())
      .toBe(0);
  });
});
