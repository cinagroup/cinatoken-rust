import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import {
  MAX_JSON_BODY_BYTES,
  PERMITS_PATH,
  canonicalJson,
  createHmacTokenForTest,
  sha256Hex,
  type AuthorityTokenClaims,
  type IssuerEnv,
} from "../src/protocol";
import {
  CURRENT_CREDENTIAL_ID_SHA256,
  CURRENT_SECRET,
  FIXTURE_ENVELOPE_SHA256,
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  FIXTURE_SUBJECT_SHA256,
  fixtureBindings,
  fixtureBody,
  fixtureEnv,
} from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration permit HTTP boundary", () => {
  test("is default-off and always returns hardened errors", async () => {
    const response = await worker.fetch(
      new Request(`https://issuer.example${PERMITS_PATH}`, {
        method: "POST",
      }),
      fixtureEnv({
        DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED: "false",
      }),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "issuer_disabled" });
  });

  test("serves only the exact POST path without a query", async () => {
    for (const request of [
      new Request(`https://issuer.example${PERMITS_PATH}`),
      new Request(`https://issuer.example${PERMITS_PATH}?mode=test`, {
        method: "POST",
      }),
      new Request("https://issuer.example/internal/v1/other", {
        method: "POST",
      }),
    ]) {
      const response = await worker.fetch(
        request,
        fixtureEnv(),
        {} as ExecutionContext,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "route_not_found" });
    }
  });

  test.each(["content-encoding", "cookie", "origin"])(
    "rejects the ambient %s header before gate or body processing",
    async (header) => {
      const response = await worker.fetch(
        new Request(`https://issuer.example${PERMITS_PATH}`, {
          method: "POST",
          headers: { [header]: "forbidden" },
        }),
        fixtureEnv({
          DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED: "false",
        }),
        {} as ExecutionContext,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "forbidden_request_header",
      });
    },
  );

  test("issues the exact envelope with no extra response fields", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW * 1000);
    const env = fixtureEnv();
    const response = await worker.fetch(
      await signedRequest(fixtureBody(), env),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual([
      "envelope",
      "issuerVersionId",
      "requestId",
      "signatureEnvelopeSha256",
      "subjectSha256",
    ]);
    expect(value.requestId).toBe(FIXTURE_REQUEST_ID);
    expect(value.issuerVersionId).toBe(
      "registration-permit-issuer-version-001",
    );
    expect(value.subjectSha256).toBe(FIXTURE_SUBJECT_SHA256);
    expect(value.signatureEnvelopeSha256).toBe(FIXTURE_ENVELOPE_SHA256);
  });

  test("rejects unknown fields after successful authentication", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW * 1000);
    const env = fixtureEnv();
    const body = new TextEncoder().encode(
      canonicalJson({ ...fixtureBindings(), issuedAt: FIXTURE_NOW }),
    );
    const response = await worker.fetch(
      await signedRequest(body, env),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_fields" });
  });

  test("rejects non-canonical and oversized request bodies", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW * 1000);
    const env = fixtureEnv();
    const nonCanonical = new TextEncoder().encode(
      `${canonicalJson(fixtureBindings())}\n`,
    );
    const nonCanonicalResponse = await worker.fetch(
      await signedRequest(nonCanonical, env),
      env,
      {} as ExecutionContext,
    );
    expect(nonCanonicalResponse.status).toBe(400);
    expect(await nonCanonicalResponse.json()).toEqual({
      error: "non_canonical_json",
    });

    const oversizedResponse = await worker.fetch(
      new Request(`https://issuer.example${PERMITS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(MAX_JSON_BODY_BYTES + 1),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(oversizedResponse.status).toBe(413);
    expect(await oversizedResponse.json()).toEqual({
      error: "request_too_large",
    });
  });

  test("does not accept an HMAC token for a different body", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW * 1000);
    const env = fixtureEnv();
    const request = await signedRequest(fixtureBody(), env);
    const changedBody = new TextEncoder().encode(
      canonicalJson(fixtureBindings({ rootSessionEpoch: 8 })),
    );
    const changedRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: changedBody,
    });
    const response = await worker.fetch(
      changedRequest,
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "authority_claim_mismatch",
    });
  });
});

async function signedRequest(
  body: Uint8Array,
  env: IssuerEnv,
): Promise<Request> {
  const claims: AuthorityTokenClaims = {
    issuer: env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER,
    audience: env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE,
    credential_id_sha256: CURRENT_CREDENTIAL_ID_SHA256,
    request_id: FIXTURE_REQUEST_ID,
    method: "POST",
    path_and_query: PERMITS_PATH,
    body_sha256: await sha256Hex(body),
    issued_at: FIXTURE_NOW,
    expires_at: FIXTURE_NOW + 30,
  };
  const token = await createHmacTokenForTest(
    CURRENT_SECRET,
    "current-v1",
    claims,
  );
  return new Request(`https://issuer.example${PERMITS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-issuer": token,
    },
    body,
  });
}
