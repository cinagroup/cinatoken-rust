import { describe, expect, test } from "vitest";
import worker from "../src/index";

const disabledEnv = {
  ENVIRONMENT: "staging",
  RING_TRANSITION_AUTHORITY_ENABLED: "false",
  RING_TRANSITION_CLAIM_WRITE_ENABLED: "false",
  RING_TRANSITION_STEP_WRITE_ENABLED: "false",
  RING_TRANSITION_EXPIRY_WRITE_ENABLED: "false",
  CF_VERSION_METADATA: { id: "version-test", tag: "", timestamp: "" },
} as never;

describe("HTTP boundary", () => {
  test("is disabled by default and emits hardened JSON responses", async () => {
    const response = await worker.fetch(
      new Request("https://authority.example/internal/v1/ring-transition/claims", {
        method: "POST",
      }),
      disabledEnv,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "authority_disabled" });
  });

  test.each(["content-encoding", "cookie", "origin"])(
    "rejects the %s header",
    async (header) => {
      const response = await worker.fetch(
        new Request("https://authority.example/internal/v1/ring-transition/claims", {
          method: "POST",
          headers: { [header]: "forbidden" },
        }),
        disabledEnv,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "forbidden_request_header",
      });
    },
  );

  test("requires the exact ordered GET query and returns 404 for unknown routes", async () => {
    const id = "a".repeat(64);
    const digest = "b".repeat(64);
    const owner = "c".repeat(64);
    const wrongOrder = await worker.fetch(
      new Request(
        `https://authority.example/internal/v1/ring-transition/claims/${id}` +
          `?claimOwnerSha256=${owner}&claimDigestSha256=${digest}`,
      ),
      disabledEnv,
      {} as ExecutionContext,
    );
    expect(wrongOrder.status).toBe(400);

    const unknown = await worker.fetch(
      new Request("https://authority.example/internal/v1/ring-transition/unknown", {
        headers: { origin: "https://browser.example" },
      }),
      disabledEnv,
      {} as ExecutionContext,
    );
    expect(unknown.status).toBe(404);
  });
});
