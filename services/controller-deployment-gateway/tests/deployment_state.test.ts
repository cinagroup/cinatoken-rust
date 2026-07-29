import { describe, expect, it } from "vitest";

import {
  deploymentStateDigest,
  isTargetStable,
  type DeploymentStateObservation,
} from "../src/deployment_state";
import { sha256Canonical } from "../src/protocol";
import { commandFixture } from "./fixtures";

describe("controller deployment state stability", () => {
  it("uses one state digest across distinct status requests and becomes stable", async () => {
    const command = commandFixture();
    const commandDigestSha256 = await sha256Canonical(command);
    const gatewayIdempotencyKeySha256 = "f".repeat(64);
    const state = targetObservation();

    const firstDigest = await deploymentStateDigest(
      gatewayIdempotencyKeySha256,
      commandDigestSha256,
      command,
      state,
    );
    const secondDigest = await deploymentStateDigest(
      gatewayIdempotencyKeySha256,
      commandDigestSha256,
      command,
      state,
    );

    expect(secondDigest).toBe(firstDigest);
    expect(isTargetStable(
      {
        classification: "target_observed",
        statusRequestIdSha256: "2".repeat(64),
        recordedAt: 1_005,
        deploymentStateDigestSha256: secondDigest,
      },
      {
        classification: "target_observed",
        statusRequestIdSha256: "1".repeat(64),
        recordedAt: 1_000,
        deploymentStateDigestSha256: firstDigest,
      },
      5,
    )).toBe(true);
    expect(isTargetStable(
      {
        classification: "target_observed",
        statusRequestIdSha256: "1".repeat(64),
        recordedAt: 1_005,
        deploymentStateDigestSha256: secondDigest,
      },
      {
        classification: "target_observed",
        statusRequestIdSha256: "1".repeat(64),
        recordedAt: 1_000,
        deploymentStateDigestSha256: firstDigest,
      },
      5,
    )).toBe(false);
    expect(isTargetStable(
      {
        classification: "target_observed",
        statusRequestIdSha256: "2".repeat(64),
        recordedAt: 1_004,
        deploymentStateDigestSha256: secondDigest,
      },
      {
        classification: "target_observed",
        statusRequestIdSha256: "1".repeat(64),
        recordedAt: 1_000,
        deploymentStateDigestSha256: firstDigest,
      },
      5,
    )).toBe(false);
  });

  it("rejects stability when any deployment-state evidence changes", async () => {
    const command = commandFixture();
    const commandDigestSha256 = await sha256Canonical(command);
    const gatewayIdempotencyKeySha256 = "f".repeat(64);
    const firstDigest = await deploymentStateDigest(
      gatewayIdempotencyKeySha256,
      commandDigestSha256,
      command,
      targetObservation(),
    );

    for (const changedState of [
      targetObservation({ classification: "deployment_drift" }),
      targetObservation({ deploymentsHttpStatus: 206 }),
      targetObservation({ versionHttpStatus: 206 }),
      targetObservation({ deploymentSetSha256: "c".repeat(64) }),
      targetObservation({ targetVersionSha256: "d".repeat(64) }),
    ]) {
      const changedDigest = await deploymentStateDigest(
        gatewayIdempotencyKeySha256,
        commandDigestSha256,
        command,
        changedState,
      );
      expect(changedDigest).not.toBe(firstDigest);
      expect(isTargetStable(
        {
          classification: "target_observed",
          statusRequestIdSha256: "2".repeat(64),
          recordedAt: 1_005,
          deploymentStateDigestSha256: changedDigest,
        },
        {
          classification: "target_observed",
          statusRequestIdSha256: "1".repeat(64),
          recordedAt: 1_000,
          deploymentStateDigestSha256: firstDigest,
        },
        5,
      )).toBe(false);
    }
  });
});

function targetObservation(
  overrides: Partial<DeploymentStateObservation> = {},
): DeploymentStateObservation {
  return {
    classification: "target_observed",
    deploymentsHttpStatus: 200,
    versionHttpStatus: 200,
    deploymentSetSha256: "a".repeat(64),
    targetVersionSha256: "b".repeat(64),
    ...overrides,
  };
}
