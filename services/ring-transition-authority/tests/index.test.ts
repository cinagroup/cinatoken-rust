import { describe, expect, test } from "vitest";
import worker from "../src/index";
import {
  createHmacTokenForTest,
  sha256Hex,
  type AuthorityTokenClaims,
} from "../src/protocol";
import {
  CURRENT_CREDENTIAL,
  CURRENT_SECRET,
  securityEnv,
} from "./fixtures";

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

  test("authenticates a read-only preflight without touching D1 or write gates", async () => {
    const path = "/internal/v1/ring-transition/preflight";
    const now = Math.floor(Date.now() / 1000);
    const claims: AuthorityTokenClaims = {
      issuer: "runner-staging",
      audience: "authority-staging",
      credential_id_sha256: CURRENT_CREDENTIAL,
      request_id: "preflight-request-1",
      method: "GET",
      path_and_query: path,
      body_sha256: await sha256Hex(new Uint8Array()),
      issued_at: now,
      expires_at: now + 30,
    };
    const token = await createHmacTokenForTest(
      CURRENT_SECRET,
      "current-v1",
      claims,
    );
    const response = await worker.fetch(
      new Request(`https://authority.example${path}`, {
        headers: { "x-cinatoken-ring-authority": token },
      }),
      {
        ...securityEnv({
          RING_TRANSITION_PERMIT_SPKI_SHA256: "f".repeat(64),
        }),
        ENVIRONMENT: "staging",
        RING_TRANSITION_AUTHORITY_ENABLED: "true",
        RING_TRANSITION_CLAIM_WRITE_ENABLED: "false",
        RING_TRANSITION_STEP_WRITE_ENABLED: "false",
        RING_TRANSITION_EXPIRY_WRITE_ENABLED: "false",
        CF_VERSION_METADATA: {
          id: "authority-version-001",
          tag: "",
          timestamp: "",
        },
      } as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: "authority_ready",
      requestId: "preflight-request-1",
      credentialIdSha256: CURRENT_CREDENTIAL,
      permitSpkiSha256: "f".repeat(64),
      authorityVersionId: "authority-version-001",
    });
  });
});
