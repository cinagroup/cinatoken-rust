import { describe, expect, it } from "vitest";

import { matchDisableRoute } from "../src/disable_routes";

describe("controller deployment disable routes", () => {
  it("matches only the isolated create-once path", () => {
    const id = "a".repeat(64);
    expect(matchDisableRoute(new Request(
      `https://gateway.test/internal/v1/controller-deployment-disables/${id}/create-once`,
      { method: "POST" },
    ))).toEqual({
      kind: "disable_create",
      idempotencyKeySha256: id,
    });
  });

  it("requires the exact status command digest query", () => {
    const id = "a".repeat(64);
    const digest = "b".repeat(64);
    expect(matchDisableRoute(new Request(
      `https://gateway.test/internal/v1/controller-deployment-disables/${id}/status-readback?commandDigestSha256=${digest}`,
      { method: "POST" },
    ))).toEqual({
      kind: "disable_status",
      idempotencyKeySha256: id,
      commandDigestSha256: digest,
    });
    expect(() => matchDisableRoute(new Request(
      `https://gateway.test/internal/v1/controller-deployment-disables/${id}/status-readback`,
      { method: "POST" },
    ))).toThrowError(/invalid_disable_query/);
  });

  it("does not capture enable-v1 and rejects alternate disable methods", () => {
    expect(matchDisableRoute(new Request(
      `https://gateway.test/internal/v1/controller-deployments/${"a".repeat(64)}/create-once`,
      { method: "POST" },
    ))).toBeNull();
    expect(() => matchDisableRoute(new Request(
      `https://gateway.test/internal/v1/controller-deployment-disables/${"a".repeat(64)}/create-once`,
      { method: "GET" },
    ))).toThrowError(/disable_route_not_found/);
  });
});
