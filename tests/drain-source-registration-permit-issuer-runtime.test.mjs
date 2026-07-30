import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  PERMITS_PATH,
  canonicalJson,
  createHmacTokenForTest,
  permitSignatureEnvelopeSha256,
  permitSubjectSha256,
  sha256Hex,
} from "../services/drain-source-registration-permit-issuer/src/protocol.ts";
import {
  CURRENT_CREDENTIAL_ID_SHA256,
  CURRENT_SECRET,
  FIXTURE_REQUEST_ID,
  fixtureBindings,
} from "../services/drain-source-registration-permit-issuer/tests/fixtures.ts";

const origin = "https://drain-registration-permit-runtime.test";
const authorityIssuer = "cinatoken-relay-application-staging";
const authorityAudience =
  "cinatoken-drain-source-registration-permit-issuer-staging";

describe("drain-source registration permit issuer Workerd runtime", () => {
  it("signs, concurrently replays, and cross-second replays exact bytes", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const body = new TextEncoder().encode(
      canonicalJson(
        fixtureBindings({
          verifiedAt: now,
          verificationExpiresAt: now + 24,
        }),
      ),
    );
    const token = await authorityToken(body, now);
    const request = () =>
      SELF.fetch(`${origin}${PERMITS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cinatoken-drain-source-registration-issuer": token,
        },
        body,
      });

    const concurrent = await Promise.all(
      Array.from({ length: 16 }, () => request()),
    );
    expect(concurrent.every((response) => response.status === 201)).toBe(true);
    expect(
      concurrent.every(
        (response) => response.headers.get("cache-control") === "no-store",
      ),
    ).toBe(true);
    const payloads = await Promise.all(
      concurrent.map((response) => response.text()),
    );
    expect(new Set(payloads).size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const replay = await request();
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(payloads[0]);

    const parsed = JSON.parse(payloads[0]);
    expect(parsed).toMatchObject({
      requestId: FIXTURE_REQUEST_ID,
      envelope: {
        algorithm: "Ed25519",
        subject: {
          issuedAt: now,
          expiresAt: now + 24,
          passkeyPreviousSignCount: 41,
          passkeySignCount: 42,
        },
      },
    });
    expect(parsed.issuerVersionId).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
    expect(parsed.subjectSha256).toBe(
      await permitSubjectSha256(parsed.envelope.subject),
    );
    expect(parsed.envelope.subjectSha256).toBe(parsed.subjectSha256);
    expect(parsed.signatureEnvelopeSha256).toBe(
      await permitSignatureEnvelopeSha256(parsed.envelope),
    );
  });

  it("rejects body and ambient-authority drift without leaking material", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const body = new TextEncoder().encode(
      canonicalJson(
        fixtureBindings({
          verifiedAt: now,
          verificationExpiresAt: now + 24,
        }),
      ),
    );
    const token = await authorityToken(body, now);
    const tamperedBody = new TextEncoder().encode(
      canonicalJson(
        fixtureBindings({
          actionDigestSha256: "ff".repeat(32),
          verifiedAt: now,
          verificationExpiresAt: now + 24,
        }),
      ),
    );
    const tampered = await SELF.fetch(`${origin}${PERMITS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-drain-source-registration-issuer": token,
      },
      body: tamperedBody,
    });
    expect(tampered.status).toBe(403);
    expect(tampered.headers.get("cache-control")).toBe("no-store");
    const tamperedText = await tampered.text();
    expect(tamperedText).toBe('{"error":"authority_claim_mismatch"}');
    expect(tamperedText).not.toContain(CURRENT_SECRET);

    const ambient = await SELF.fetch(`${origin}${PERMITS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=forbidden",
        "x-cinatoken-drain-source-registration-issuer": token,
      },
      body,
    });
    expect(ambient.status).toBe(400);
    expect(await ambient.json()).toEqual({
      error: "forbidden_request_header",
    });
  });
});

async function authorityToken(body, now) {
  return createHmacTokenForTest(CURRENT_SECRET, "current-v1", {
    issuer: authorityIssuer,
    audience: authorityAudience,
    credential_id_sha256: CURRENT_CREDENTIAL_ID_SHA256,
    request_id: FIXTURE_REQUEST_ID,
    method: "POST",
    path_and_query: PERMITS_PATH,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
  });
}
