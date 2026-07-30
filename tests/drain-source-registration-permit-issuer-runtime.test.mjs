import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  PERMITS_PATH,
  REQUEST_FIELDS,
  SUBJECT_FIELDS,
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
const rawTrustedIp = "203.0.113.42";
const adminNetworkIdentityHmacSha256 =
  "b8de0f80c9ba10bc79d9534f35da4341bcca1f76e288c3d2059dd8186d96b2cf";

const expectedRequestFields = [
  "environment",
  "action",
  "authorizationIdSha256",
  "authorizationSubjectSha256",
  "authorizationSignatureEnvelopeSha256",
  "actionSubjectSha256",
  "actionDigestSha256",
  "registrationRequestSha256",
  "adminAuditDigestSha256",
  "adminNetworkIdentityHmacSha256",
  "changeTicketSha256",
  "rootAdminId",
  "rootSessionEpoch",
  "rootSessionIssuedAt",
  "rootSessionExpiresAt",
  "rootSessionBindingSha256",
  "passkeyCredentialRowId",
  "passkeyCredentialIdSha256",
  "passkeyCredentialRegistrationIdSha256",
  "passkeyCredentialBindingSha256",
  "passkeyPreviousUseGeneration",
  "passkeyAssertionSubjectSha256",
  "passkeyAssertionSignatureSha256",
  "secureVerificationChallengeSha256",
  "passkeyPreviousSignCount",
  "passkeySignCount",
  "passkeyUserPresent",
  "passkeyUserVerified",
  "passkeyBackupEligible",
  "passkeyBackupState",
  "registeredByServiceName",
  "registeredByVersionId",
  "registrationExecutionIdSha256",
  "registrationCredentialIdSha256",
  "authorityLedgerIdentitySha256",
  "receiptSequence",
  "ledgerHeadBeforeSha256",
  "verificationExpiresAt",
  "verifiedAt",
];

const expectedSubjectFields = [
  "schemaVersion",
  "contract",
  "issuer",
  "audience",
  "keyId",
  "signerIdentitySha256",
  "signerSpkiSha256",
  ...expectedRequestFields.slice(0, -1),
  "permitIdSha256",
  "verifiedAt",
  "issuedAt",
  "expiresAt",
];

describe("drain-source registration permit issuer Workerd runtime", () => {
  it("signs, concurrently replays, and cross-second replays exact bytes", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    const body = new TextEncoder().encode(canonicalJson(runtimeBindings(now)));
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
          adminNetworkIdentityHmacSha256,
          rootSessionIssuedAt: now - 60,
          rootSessionExpiresAt: now + 300,
          passkeyCredentialRegistrationIdSha256: digest(21),
          passkeyCredentialBindingSha256: digest(22),
          passkeyPreviousUseGeneration: 17,
          passkeyPreviousSignCount: 41,
          passkeySignCount: 42,
        },
      },
    });
    expect(Object.keys(parsed.envelope.subject).sort()).toEqual(
      [...expectedSubjectFields].sort(),
    );
    expect(payloads[0]).not.toContain(rawTrustedIp);
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
    const body = new TextEncoder().encode(canonicalJson(runtimeBindings(now)));
    const token = await authorityToken(body, now);
    const tamperedBody = new TextEncoder().encode(
      canonicalJson(
        runtimeBindings(now, {
          actionDigestSha256: "ff".repeat(32),
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

  it("enforces the exact 39-key request closure", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    const bindings = runtimeBindings(now);
    expect(Object.keys(bindings).sort()).toEqual(
      [...expectedRequestFields].sort(),
    );

    await expectInvalidFields(
      {
        ...bindings,
        unexpectedNetworkIdentity: digest(30),
      },
      now,
    );

    for (const field of [
      "adminNetworkIdentityHmacSha256",
      "rootSessionIssuedAt",
      "rootSessionExpiresAt",
      "passkeyCredentialRegistrationIdSha256",
      "passkeyCredentialBindingSha256",
      "passkeyPreviousUseGeneration",
    ]) {
      const missing = { ...bindings };
      Reflect.deleteProperty(missing, field);
      await expectInvalidFields(missing, now);
    }
  });

  it("keeps root session generation independent from time bounds", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    const valid = runtimeBindings(now);
    const independentGeneration = await postBindings(
      runtimeBindings(now, { rootSessionEpoch: Number.MAX_SAFE_INTEGER }),
      now,
    );
    expect(independentGeneration.status).toBe(201);
    const independentEnvelope = await independentGeneration.json();
    expect(independentEnvelope.envelope.subject.rootSessionEpoch).toBe(
      Number.MAX_SAFE_INTEGER,
    );

    for (const overrides of [
      { rootSessionExpiresAt: valid.rootSessionIssuedAt },
      { verifiedAt: valid.rootSessionIssuedAt - 1 },
      { verificationExpiresAt: valid.rootSessionExpiresAt + 1 },
    ]) {
      await expectInvalidFields(runtimeBindings(now, overrides), now);
    }
  });

  it("accepts passkey use-generation boundaries and rejects invalid values", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    for (const passkeyPreviousUseGeneration of [
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ]) {
      const response = await postBindings(
        runtimeBindings(now, { passkeyPreviousUseGeneration }),
        now,
      );
      expect(response.status).toBe(201);
      const parsed = await response.json();
      expect(parsed.envelope.subject.passkeyPreviousUseGeneration).toBe(
        passkeyPreviousUseGeneration,
      );
    }

    await expectInvalidFields(
      runtimeBindings(now, { passkeyPreviousUseGeneration: -1 }),
      now,
    );
    await expectInvalidFields(
      runtimeBindings(now, {
        passkeyPreviousUseGeneration: Number.MAX_SAFE_INTEGER,
      }),
      now,
    );

    for (const invalidJsonNumber of ["1.5", "9007199254740992"]) {
      const invalidNumberBody = new TextEncoder().encode(
        canonicalJson(runtimeBindings(now)).replace(
          '"passkeyPreviousUseGeneration":17',
          `"passkeyPreviousUseGeneration":${invalidJsonNumber}`,
        ),
      );
      const invalidNumber = await postBody(invalidNumberBody, now);
      expect(invalidNumber.status).toBe(400);
      expect(await invalidNumber.json()).toEqual({
        error: "invalid_json",
      });
    }
  });

  it("binds all three passkey digests and rejects malformed or unauthorized drift", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    const bindings = runtimeBindings(now);
    const response = await postBindings(bindings, now);
    expect(response.status).toBe(201);
    const parsed = await response.json();
    expect(parsed.envelope.subject).toMatchObject({
      passkeyCredentialIdSha256: bindings.passkeyCredentialIdSha256,
      passkeyCredentialRegistrationIdSha256:
        bindings.passkeyCredentialRegistrationIdSha256,
      passkeyCredentialBindingSha256: bindings.passkeyCredentialBindingSha256,
    });

    for (const field of [
      "passkeyCredentialIdSha256",
      "passkeyCredentialRegistrationIdSha256",
      "passkeyCredentialBindingSha256",
    ]) {
      await expectInvalidFields(runtimeBindings(now, { [field]: "ff" }), now);
    }

    const authorizedBody = new TextEncoder().encode(canonicalJson(bindings));
    const authorizedToken = await authorityToken(authorizedBody, now);
    for (const [index, field] of [
      "passkeyCredentialIdSha256",
      "passkeyCredentialRegistrationIdSha256",
      "passkeyCredentialBindingSha256",
    ].entries()) {
      const driftedBody = new TextEncoder().encode(
        canonicalJson(
          runtimeBindings(now, {
            [field]: digest(24 + index),
          }),
        ),
      );
      const drifted = await SELF.fetch(`${origin}${PERMITS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cinatoken-drain-source-registration-issuer": authorizedToken,
        },
        body: driftedBody,
      });
      expect(drifted.status).toBe(403);
      expect(await drifted.json()).toEqual({
        error: "authority_claim_mismatch",
      });
    }

    for (const overrides of [
      {
        passkeyCredentialRegistrationIdSha256:
          bindings.passkeyCredentialIdSha256,
      },
      {
        passkeyCredentialBindingSha256: bindings.passkeyCredentialIdSha256,
      },
      {
        passkeyCredentialBindingSha256:
          bindings.passkeyCredentialRegistrationIdSha256,
      },
    ]) {
      await expectInvalidFields(runtimeBindings(now, overrides), now);
    }
  });

  it("binds the network identity HMAC without disclosing the trusted IP", async () => {
    expectExpandedProtocolContract();
    const now = Math.floor(Date.now() / 1_000);
    const first = await postBindings(runtimeBindings(now), now);
    expect(first.status).toBe(201);
    const firstText = await first.text();
    const firstParsed = JSON.parse(firstText);
    expect(firstParsed.envelope.subject.adminNetworkIdentityHmacSha256).toBe(
      adminNetworkIdentityHmacSha256,
    );
    expect(firstText).not.toContain(rawTrustedIp);

    const second = await postBindings(
      runtimeBindings(now, {
        adminNetworkIdentityHmacSha256: digest(23),
      }),
      now,
    );
    expect(second.status).toBe(201);
    const secondText = await second.text();
    const secondParsed = JSON.parse(secondText);
    expect(secondParsed.envelope.subject.adminNetworkIdentityHmacSha256).toBe(
      digest(23),
    );
    expect(secondParsed.subjectSha256).not.toBe(firstParsed.subjectSha256);
    expect(secondText).not.toContain(rawTrustedIp);

    const invalid = await postBindings(
      runtimeBindings(now, {
        adminNetworkIdentityHmacSha256: rawTrustedIp,
      }),
      now,
    );
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toBe('{"error":"invalid_fields"}');
    expect(invalidText).not.toContain(rawTrustedIp);
  });
});

function expectExpandedProtocolContract() {
  expect(REQUEST_FIELDS).toEqual(expectedRequestFields);
  expect(REQUEST_FIELDS).toHaveLength(39);
  expect(SUBJECT_FIELDS).toEqual(expectedSubjectFields);
  expect(SUBJECT_FIELDS).toHaveLength(49);
}

function runtimeBindings(now, overrides = {}) {
  return {
    ...fixtureBindings({
      verifiedAt: now,
      verificationExpiresAt: now + 24,
    }),
    adminNetworkIdentityHmacSha256,
    rootSessionIssuedAt: now - 60,
    rootSessionExpiresAt: now + 300,
    passkeyCredentialRegistrationIdSha256: digest(21),
    passkeyCredentialBindingSha256: digest(22),
    passkeyPreviousUseGeneration: 17,
    ...overrides,
  };
}

function digest(byte) {
  return byte.toString(16).padStart(2, "0").repeat(32);
}

async function postBindings(bindings, now) {
  const body = new TextEncoder().encode(canonicalJson(bindings));
  return postBody(body, now);
}

async function postBody(body, now) {
  const token = await authorityToken(body, now);
  return SELF.fetch(`${origin}${PERMITS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-issuer": token,
    },
    body,
  });
}

async function expectInvalidFields(bindings, now) {
  const response = await postBindings(bindings, now);
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "invalid_fields" });
}

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
