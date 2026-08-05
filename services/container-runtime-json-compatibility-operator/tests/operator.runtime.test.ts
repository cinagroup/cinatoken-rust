import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import {
  getJsonCompatibilityOperatorPhaseStatus,
  invokeJsonCompatibilityOperatorPhase,
  type JsonCompatibilityOperatorEnv,
} from "../src/operator";
import {
  NOW_MS,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validOperatorRequest,
} from "./fixtures";

interface InvokerMockControlBinding {
  reset(): Promise<void>;
  invocationCallCount(): Promise<number>;
  statusCallCount(): Promise<number>;
}

const runtimeEnv = env as unknown as JsonCompatibilityOperatorEnv & {
  readonly JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL:
    InvokerMockControlBinding;
};

async function runtimeAuthorizedRequest() {
  return await validAuthorizedOperatorRequest(validOperatorRequest(), {
    issuedAt: Math.floor(NOW_MS / 1000),
    operatorVersionId: runtimeEnv.CF_VERSION_METADATA.id,
  });
}

describe("Operator workerd runtime", () => {
  beforeEach(async () => {
    await runtimeEnv.JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL.reset();
  });

  test("accepts a signed v2 approval and invokes the named Invoker once", async () => {
    const authorized = await runtimeAuthorizedRequest();

    await expect(invokeJsonCompatibilityOperatorPhase(
      runtimeEnv,
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toThrow(/invalid_private_invocation_receipt/u);

    expect(await runtimeEnv.JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL
      .invocationCallCount()).toBe(1);
  });

  test("rejects v1 and invalid Plan bindings before named Invoker RPC", async () => {
    const authorized = await runtimeAuthorizedRequest();
    const legacy = structuredClone(authorized) as unknown as {
      approval: {
        schemaVersion: number;
        contract: string;
        subject: Record<string, unknown>;
      };
    };
    legacy.approval.schemaVersion = 1;
    legacy.approval.contract =
      "cinatoken-container-runtime-json-compatibility-operator-phase-approval-envelope-v1";
    legacy.approval.subject.schemaVersion = 1;
    legacy.approval.subject.contract =
      "cinatoken-container-runtime-json-compatibility-operator-phase-approval-subject-v1";
    delete legacy.approval.subject.planContract;
    delete legacy.approval.subject.planSchemaVersion;

    await expect(invokeJsonCompatibilityOperatorPhase(
      runtimeEnv,
      legacy,
      runtimeSequence(NOW_MS),
    )).rejects.toThrow(/invalid_operator_phase_request/u);
    expect(await runtimeEnv.JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL
      .invocationCallCount()).toBe(0);

    const wrongPlan = await runtimeAuthorizedRequest() as unknown as {
      approval: { subject: Record<string, unknown> };
    };
    wrongPlan.approval.subject.planSchemaVersion = 3;
    await expect(getJsonCompatibilityOperatorPhaseStatus(
      runtimeEnv,
      {
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-operator-phase-status-request-v1",
        authorizedPhaseRequest: wrongPlan,
      },
      runtimeSequence(NOW_MS),
    )).rejects.toThrow(/invalid_operator_status_request/u);
    expect(await runtimeEnv.JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL
      .statusCallCount()).toBe(0);
  });
});
