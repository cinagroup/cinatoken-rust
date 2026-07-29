import { describe, expect, it } from "vitest";

import {
  disableDeploymentStateDigest,
  isDisableTargetStable,
} from "../src/disable_deployment_state";
import { disableCommandFixture } from "./disable_fixtures";

describe("controller deployment disable stability", () => {
  it("keeps the state digest independent of request identity", async () => {
    const command = disableCommandFixture();
    const observation = {
      classification: "exact_disable_observed",
      deploymentsHttpStatus: 200,
      baselineVersionHttpStatus: 200,
      deploymentSetSha256: "a".repeat(64),
      baselineVersionSha256: "b".repeat(64),
    };
    const first = await disableDeploymentStateDigest(
      "c".repeat(64),
      "d".repeat(64),
      command,
      observation,
    );
    const second = await disableDeploymentStateDigest(
      "c".repeat(64),
      "d".repeat(64),
      command,
      observation,
    );
    expect(first).toBe(second);
  });

  it("requires two different request ids and the full stability interval", () => {
    const previous = {
      classification: "exact_disable_observed",
      statusRequestIdSha256: "a".repeat(64),
      recordedAt: 100,
      stateDigestSha256: "b".repeat(64),
    };
    expect(isDisableTargetStable({
      ...previous,
      statusRequestIdSha256: "c".repeat(64),
      recordedAt: 105,
    }, previous, 5)).toBe(true);
    expect(isDisableTargetStable({
      ...previous,
      statusRequestIdSha256: "c".repeat(64),
      recordedAt: 104,
    }, previous, 5)).toBe(false);
  });

  it("rejects drift, repeated request ids, and changed state", () => {
    const previous = {
      classification: "exact_disable_observed",
      statusRequestIdSha256: "a".repeat(64),
      recordedAt: 100,
      stateDigestSha256: "b".repeat(64),
    };
    expect(isDisableTargetStable({
      ...previous,
      recordedAt: 105,
    }, previous, 5)).toBe(false);
    expect(isDisableTargetStable({
      ...previous,
      statusRequestIdSha256: "c".repeat(64),
      recordedAt: 105,
      stateDigestSha256: "d".repeat(64),
    }, previous, 5)).toBe(false);
    expect(isDisableTargetStable({
      ...previous,
      classification: "deployment_drift",
      statusRequestIdSha256: "c".repeat(64),
      recordedAt: 105,
    }, previous, 5)).toBe(false);
  });
});
