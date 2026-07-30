import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  ENVELOPE_CONTRACT,
  PERMITS_PATH,
  REQUEST_FIELDS,
  SUBJECT_FIELDS,
  ProtocolError,
  canonicalJson,
  createHmacTokenForTest,
  derivePermitIdSha256,
  encodePermitSubject,
  issueRegistrationPermit,
  parseRegistrationBindings,
  permitSignatureEnvelopeSha256,
  permitSubjectSha256,
  sha256Hex,
  verifyHmacRequest,
  type AuthorityTokenClaims,
  type IssuerEnv,
  type RegistrationPermitBindings,
  type RegistrationPermitSubject,
} from "../src/protocol";
import {
  CURRENT_CREDENTIAL_ID_SHA256,
  CURRENT_SECRET,
  FIXTURE_ENVELOPE_SHA256,
  FIXTURE_ISSUE_REQUEST_SHA256,
  FIXTURE_NOW,
  FIXTURE_PERMIT_ID_SHA256,
  FIXTURE_REQUEST_ID,
  FIXTURE_SIGNATURE_BASE64URL,
  FIXTURE_SUBJECT_SHA256,
  PREVIOUS_CREDENTIAL_ID_SHA256,
  PREVIOUS_SECRET,
  TEST_PKCS8_BASE64URL,
  TEST_SPKI_BASE64URL,
  TEST_SPKI_SHA256,
  digest,
  fixtureBindings,
  fixtureBody,
  fixtureEnv,
  fixtureSubject,
} from "./fixtures";

const CROSS_LANGUAGE_CANARY = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/drain-source-registration-permit-v1-canary.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  schemaVersion: number;
  requestFields: string[];
  subjectFields: string[];
  adminNetworkIdentityHmacSha256: string;
  spkiBase64url: string;
  spkiSha256: string;
  permitIdSha256: string;
  requestBytes: number;
  requestSha256: string;
  subjectBytes: number;
  subjectSha256: string;
  signatureBase64url: string;
  signatureEnvelopeSha256: string;
};

const EXPECTED_SUBJECT_FIELDS = [
  "schemaVersion",
  "contract",
  "issuer",
  "audience",
  "keyId",
  "signerIdentitySha256",
  "signerSpkiSha256",
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
  "permitIdSha256",
  "verifiedAt",
  "issuedAt",
  "expiresAt",
] as const;

const EXPECTED_REQUEST_FIELDS = [
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
] as const;

const ADDED_REQUEST_FIELDS = [
  "adminNetworkIdentityHmacSha256",
  "rootSessionIssuedAt",
  "rootSessionExpiresAt",
  "passkeyCredentialRegistrationIdSha256",
  "passkeyCredentialBindingSha256",
  "passkeyPreviousUseGeneration",
] as const;

describe("registration permit canonical protocol", () => {
  test("pins the deterministic 0x07 Ed25519 cross-language canary", async () => {
    expect(CROSS_LANGUAGE_CANARY.schemaVersion).toBe(1);
    expect(CROSS_LANGUAGE_CANARY.requestFields).toEqual(
      EXPECTED_REQUEST_FIELDS,
    );
    expect(CROSS_LANGUAGE_CANARY.subjectFields).toEqual(
      EXPECTED_SUBJECT_FIELDS,
    );
    expect(SUBJECT_FIELDS).toEqual(EXPECTED_SUBJECT_FIELDS);
    expect(SUBJECT_FIELDS).toHaveLength(49);
    expect(REQUEST_FIELDS).toEqual(EXPECTED_REQUEST_FIELDS);
    expect(REQUEST_FIELDS).toHaveLength(39);
    expect(Object.keys(fixtureBindings()).sort()).toEqual(
      [...EXPECTED_REQUEST_FIELDS].sort(),
    );
    expect(TEST_SPKI_BASE64URL).toBe(CROSS_LANGUAGE_CANARY.spkiBase64url);
    expect(TEST_SPKI_SHA256).toBe(CROSS_LANGUAGE_CANARY.spkiSha256);
    expect(fixtureBindings().adminNetworkIdentityHmacSha256).toBe(
      CROSS_LANGUAGE_CANARY.adminNetworkIdentityHmacSha256,
    );
    expect(fixtureBody()).toHaveLength(CROSS_LANGUAGE_CANARY.requestBytes);
    expect(await sha256Hex(fixtureBody())).toBe(
      CROSS_LANGUAGE_CANARY.requestSha256,
    );
    expect(FIXTURE_ISSUE_REQUEST_SHA256).toBe(
      CROSS_LANGUAGE_CANARY.requestSha256,
    );

    const authentication = await fixtureAuthentication();
    const issued = await issueRegistrationPermit(
      fixtureBody(),
      authentication,
      fixtureEnv(),
      FIXTURE_NOW,
    );
    expect(Object.keys(issued.envelope.subject)).toEqual(SUBJECT_FIELDS);
    expect(issued.envelope.subject).toEqual(await fixtureSubject());
    expect(encodePermitSubject(issued.envelope.subject)).toHaveLength(
      CROSS_LANGUAGE_CANARY.subjectBytes,
    );
    expect(issued.envelope.subject.permitIdSha256).toBe(
      CROSS_LANGUAGE_CANARY.permitIdSha256,
    );
    expect(FIXTURE_PERMIT_ID_SHA256).toBe(CROSS_LANGUAGE_CANARY.permitIdSha256);
    expect(issued.subjectSha256).toBe(CROSS_LANGUAGE_CANARY.subjectSha256);
    expect(FIXTURE_SUBJECT_SHA256).toBe(CROSS_LANGUAGE_CANARY.subjectSha256);
    expect(issued.envelope.subjectSha256).toBe(FIXTURE_SUBJECT_SHA256);
    expect(issued.envelope.signatureBase64url).toBe(
      CROSS_LANGUAGE_CANARY.signatureBase64url,
    );
    expect(FIXTURE_SIGNATURE_BASE64URL).toBe(
      CROSS_LANGUAGE_CANARY.signatureBase64url,
    );
    expect(issued.signatureEnvelopeSha256).toBe(
      CROSS_LANGUAGE_CANARY.signatureEnvelopeSha256,
    );
    expect(FIXTURE_ENVELOPE_SHA256).toBe(
      CROSS_LANGUAGE_CANARY.signatureEnvelopeSha256,
    );
    expect(await permitSubjectSha256(issued.envelope.subject)).toBe(
      FIXTURE_SUBJECT_SHA256,
    );
    expect(await permitSignatureEnvelopeSha256(issued.envelope)).toBe(
      FIXTURE_ENVELOPE_SHA256,
    );
    expect(
      await derivePermitIdSha256(
        FIXTURE_REQUEST_ID,
        issued.envelope.subject.actionSubjectSha256,
        issued.envelope.subject.passkeyAssertionSignatureSha256,
        issued.envelope.subject.secureVerificationChallengeSha256,
        FIXTURE_NOW,
        FIXTURE_NOW + 24,
      ),
    ).toBe(FIXTURE_PERMIT_ID_SHA256);

    const publicKey = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(Buffer.from(TEST_SPKI_BASE64URL, "base64url")),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        toArrayBuffer(
          Buffer.from(issued.envelope.signatureBase64url, "base64url"),
        ),
        toArrayBuffer(encodePermitSubject(issued.envelope.subject)),
      ),
    ).toBe(true);
  });

  test("every one of the 49 ordered fields changes the subject digest", async () => {
    const subject = await fixtureSubject();
    const baseline = await permitSubjectSha256(subject);
    for (const field of EXPECTED_SUBJECT_FIELDS) {
      const drifted = driftSubject(subject, field);
      expect(await permitSubjectSha256(drifted), field).not.toBe(baseline);
    }
  });

  test("binds all six added request fields and rejects each one when missing", async () => {
    const baseline = await sha256Hex(fixtureBody());
    const drifts: Partial<RegistrationPermitBindings>[] = [
      { adminNetworkIdentityHmacSha256: digest(23) },
      { rootSessionIssuedAt: FIXTURE_NOW - 59 },
      { rootSessionExpiresAt: FIXTURE_NOW + 299 },
      { passkeyCredentialRegistrationIdSha256: digest(24) },
      { passkeyCredentialBindingSha256: digest(25) },
      { passkeyPreviousUseGeneration: 18 },
    ];
    for (const drift of drifts) {
      expect(await sha256Hex(fixtureBody(fixtureBindings(drift)))).not.toBe(
        baseline,
      );
    }

    for (const field of ADDED_REQUEST_FIELDS) {
      const missing: Record<string, unknown> = { ...fixtureBindings() };
      Reflect.deleteProperty(missing, field);
      expectProtocolError(
        () =>
          parseRegistrationBindings(
            new TextEncoder().encode(canonicalJson(missing)),
          ),
        "invalid_fields",
        400,
      );
    }
  });

  test("enforces root session time boundaries", () => {
    const atEpoch = parseRegistrationBindings(
      fixtureBody(
        fixtureBindings({
          rootSessionEpoch: FIXTURE_NOW - 60,
          rootSessionIssuedAt: FIXTURE_NOW - 60,
          rootSessionExpiresAt: FIXTURE_NOW + 24,
        }),
      ),
    );
    expect(atEpoch.rootSessionIssuedAt).toBe(atEpoch.rootSessionEpoch);
    expect(atEpoch.rootSessionExpiresAt).toBe(atEpoch.verificationExpiresAt);

    for (const overrides of [
      {
        rootSessionEpoch: FIXTURE_NOW - 59,
        rootSessionIssuedAt: FIXTURE_NOW - 60,
      },
      {
        rootSessionIssuedAt: FIXTURE_NOW - 60,
        rootSessionExpiresAt: FIXTURE_NOW - 60,
      },
      {
        rootSessionIssuedAt: FIXTURE_NOW + 1,
        verifiedAt: FIXTURE_NOW,
      },
      {
        rootSessionExpiresAt: FIXTURE_NOW + 23,
        verificationExpiresAt: FIXTURE_NOW + 24,
      },
    ] satisfies Partial<RegistrationPermitBindings>[]) {
      expectProtocolError(
        () =>
          parseRegistrationBindings(fixtureBody(fixtureBindings(overrides))),
        "invalid_fields",
        400,
      );
    }
  });

  test("accepts generation boundaries and rejects unsafe generations", () => {
    for (const passkeyPreviousUseGeneration of [
      0,
      Number.MAX_SAFE_INTEGER - 1,
    ]) {
      const parsed = parseRegistrationBindings(
        fixtureBody(fixtureBindings({ passkeyPreviousUseGeneration })),
      );
      expect(parsed.passkeyPreviousUseGeneration).toBe(
        passkeyPreviousUseGeneration,
      );
    }
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          fixtureBody(fixtureBindings({ passkeyPreviousUseGeneration: -1 })),
        ),
      "invalid_fields",
      400,
    );
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          fixtureBody(
            fixtureBindings({
              passkeyPreviousUseGeneration: Number.MAX_SAFE_INTEGER,
            }),
          ),
        ),
      "invalid_fields",
      400,
    );
    expect(() =>
      fixtureBody(
        fixtureBindings({
          passkeyPreviousUseGeneration: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
    ).toThrow("non_integer_number");
  });

  test("requires canonical added digests and Rust-aligned binding distinctness", () => {
    for (const field of [
      "adminNetworkIdentityHmacSha256",
      "passkeyCredentialRegistrationIdSha256",
      "passkeyCredentialBindingSha256",
    ] as const) {
      expectProtocolError(
        () =>
          parseRegistrationBindings(
            fixtureBody(fixtureBindings({ [field]: "A".repeat(64) })),
          ),
        "invalid_fields",
        400,
      );
    }

    expectProtocolError(
      () =>
        parseRegistrationBindings(
          fixtureBody(
            fixtureBindings({ rootSessionBindingSha256: digest(11) }),
          ),
        ),
      "invalid_fields",
      400,
    );

    for (const overrides of [
      {
        passkeyCredentialRegistrationIdSha256:
          fixtureBindings().passkeyCredentialIdSha256,
      },
      {
        passkeyCredentialBindingSha256:
          fixtureBindings().passkeyCredentialIdSha256,
      },
      {
        passkeyCredentialBindingSha256:
          fixtureBindings().passkeyCredentialRegistrationIdSha256,
      },
    ] satisfies Partial<RegistrationPermitBindings>[]) {
      expectProtocolError(
        () =>
          parseRegistrationBindings(fixtureBody(fixtureBindings(overrides))),
        "invalid_fields",
        400,
      );
    }
  });

  test("accepts zero counters together and requires a strict increment otherwise", () => {
    expect(
      parseRegistrationBindings(
        fixtureBody(
          fixtureBindings({
            passkeyPreviousSignCount: 0,
            passkeySignCount: 0,
          }),
        ),
      ),
    ).toMatchObject({
      passkeyPreviousSignCount: 0,
      passkeySignCount: 0,
    });
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          fixtureBody(
            fixtureBindings({
              passkeyPreviousSignCount: 42,
              passkeySignCount: 42,
            }),
          ),
        ),
      "invalid_fields",
      400,
    );
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          fixtureBody(
            fixtureBindings({
              passkeyPreviousSignCount: 43,
              passkeySignCount: 42,
            }),
          ),
        ),
      "invalid_fields",
      400,
    );
  });

  test("rejects unknown, missing, duplicate, and non-canonical fields", () => {
    const unknown = {
      ...fixtureBindings(),
      permitIdSha256: digest(30),
    };
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          new TextEncoder().encode(canonicalJson(unknown)),
        ),
      "invalid_fields",
      400,
    );

    const missing = { ...fixtureBindings() };
    Reflect.deleteProperty(missing, "changeTicketSha256");
    expectProtocolError(
      () =>
        parseRegistrationBindings(
          new TextEncoder().encode(canonicalJson(missing)),
        ),
      "invalid_fields",
      400,
    );

    const canonical = canonicalJson(fixtureBindings());
    const duplicate = canonical.replace(
      '"action":"relay_container.drain_source_authorization_register",',
      '"action":"relay_container.drain_source_authorization_register","action":"relay_container.drain_source_authorization_register",',
    );
    expectProtocolError(
      () => parseRegistrationBindings(new TextEncoder().encode(duplicate)),
      "non_canonical_json",
      400,
    );
    expectProtocolError(
      () =>
        parseRegistrationBindings(new TextEncoder().encode(`${canonical}\n`)),
      "non_canonical_json",
      400,
    );
  });
});

describe("registration permit authority and signing", () => {
  test("accepts both the current and previous authenticated credentials", async () => {
    const body = fixtureBody();
    const current = await authenticatedRequest(
      fixtureEnv(),
      body,
      FIXTURE_NOW,
      "current",
    );
    await expect(
      verifyHmacRequest(current, body, fixtureEnv(), FIXTURE_NOW),
    ).resolves.toMatchObject({
      keyId: "current-v1",
      credentialIdSha256: CURRENT_CREDENTIAL_ID_SHA256,
      requestId: FIXTURE_REQUEST_ID,
    });

    const previous = await authenticatedRequest(
      fixtureEnv(),
      body,
      FIXTURE_NOW,
      "previous",
    );
    await expect(
      verifyHmacRequest(previous, body, fixtureEnv(), FIXTURE_NOW),
    ).resolves.toMatchObject({
      keyId: "previous-v1",
      credentialIdSha256: PREVIOUS_CREDENTIAL_ID_SHA256,
    });

    for (const env of [
      fixtureEnv({
        DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          CURRENT_CREDENTIAL_ID_SHA256,
      }),
      fixtureEnv({
        DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET: CURRENT_SECRET,
      }),
    ]) {
      await expect(
        verifyHmacRequest(current, body, env, FIXTURE_NOW),
      ).rejects.toMatchObject({ code: "issuer_unavailable", status: 503 });
    }
  });

  test("binds issuer, audience, method, path, body, request, and time", async () => {
    const env = fixtureEnv();
    const body = fixtureBody();
    const mismatches: Array<{
      claims: Partial<AuthorityTokenClaims>;
      requestUrl?: string;
      requestMethod?: string;
      suppliedBody?: Uint8Array;
    }> = [
      { claims: { issuer: "other-issuer" } },
      { claims: { audience: "other-audience" } },
      { claims: { method: "GET" } },
      { claims: { path_and_query: "/internal/v1/other" } },
      { claims: { body_sha256: digest(31) } },
      { claims: { issued_at: FIXTURE_NOW - 61 } },
      { claims: { expires_at: FIXTURE_NOW } },
    ];
    for (const mismatch of mismatches) {
      const request = await authenticatedRequest(
        env,
        body,
        FIXTURE_NOW,
        "current",
        mismatch.claims,
        mismatch.requestUrl,
        mismatch.requestMethod,
      );
      await expect(
        verifyHmacRequest(
          request,
          mismatch.suppliedBody ?? body,
          env,
          FIXTURE_NOW,
        ),
      ).rejects.toBeInstanceOf(ProtocolError);
    }

    const token = await authorityToken(env, body, FIXTURE_NOW, "current");
    const [header, claims, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const decoded = JSON.parse(
      Buffer.from(claims, "base64url").toString("utf8"),
    ) as AuthorityTokenClaims;
    const tamperedClaims = Buffer.from(
      canonicalJson({ ...decoded, request_id: "tampered-request-id" }),
    ).toString("base64url");
    const tampered = new Request(`https://issuer.example${PERMITS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-drain-source-registration-issuer": `${header}.${tamperedClaims}.${signature}`,
      },
      body,
    });
    await expect(
      verifyHmacRequest(tampered, body, env, FIXTURE_NOW),
    ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
  });

  test("caps permits at 30 seconds and rejects stale verification windows", async () => {
    const longBody = fixtureBody(
      fixtureBindings({ verificationExpiresAt: FIXTURE_NOW + 100 }),
    );
    const longWindow = await issueRegistrationPermit(
      longBody,
      await fixtureAuthentication(longBody),
      fixtureEnv(),
      FIXTURE_NOW,
    );
    expect(longWindow.envelope.subject.expiresAt).toBe(FIXTURE_NOW + 30);

    const shortBody = fixtureBody(
      fixtureBindings({ verificationExpiresAt: FIXTURE_NOW + 4 }),
    );
    await expect(
      issueRegistrationPermit(
        shortBody,
        await fixtureAuthentication(shortBody),
        fixtureEnv(),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({
      code: "registration_verification_window_unavailable",
      status: 403,
    });
    const staleBody = fixtureBody(
      fixtureBindings({ verifiedAt: FIXTURE_NOW - 6 }),
    );
    await expect(
      issueRegistrationPermit(
        staleBody,
        await fixtureAuthentication(staleBody),
        fixtureEnv(),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({
      code: "registration_verification_time_window",
      status: 403,
    });

    const boundaryBody = fixtureBody(
      fixtureBindings({ verifiedAt: FIXTURE_NOW - 5 }),
    );
    await expect(
      issueRegistrationPermit(
        boundaryBody,
        await fixtureAuthentication(boundaryBody),
        fixtureEnv(),
        FIXTURE_NOW,
      ),
    ).resolves.toBeDefined();

    const futureVerificationBody = fixtureBody(
      fixtureBindings({ verifiedAt: FIXTURE_NOW + 1 }),
    );
    await expect(
      issueRegistrationPermit(
        futureVerificationBody,
        await fixtureAuthentication(futureVerificationBody),
        fixtureEnv(),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({
      code: "registration_verification_time_window",
      status: 403,
    });
  });

  test("exactly replays one authenticated request across server clock ticks", async () => {
    const authentication = await fixtureAuthentication();
    const first = await issueRegistrationPermit(
      fixtureBody(),
      authentication,
      fixtureEnv(),
      FIXTURE_NOW,
    );
    const replay = await issueRegistrationPermit(
      fixtureBody(),
      authentication,
      fixtureEnv(),
      FIXTURE_NOW + 1,
    );
    expect(canonicalJson(replay)).toBe(canonicalJson(first));
  });

  test("fails closed on an invalid SPKI pin", async () => {
    const authentication = await fixtureAuthentication();
    await expect(
      issueRegistrationPermit(
        fixtureBody(),
        authentication,
        fixtureEnv({
          DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256: digest(0),
        }),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ code: "issuer_unavailable", status: 503 });
  });

  test("rejects a valid but mismatched PKCS8/SPKI pair by self-verification", async () => {
    const authentication = await fixtureAuthentication();
    const otherPkcs8 = Buffer.from(TEST_PKCS8_BASE64URL, "base64url");
    otherPkcs8[otherPkcs8.length - 1] = 0x08;
    await expect(
      issueRegistrationPermit(
        fixtureBody(),
        authentication,
        fixtureEnv({
          DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL:
            otherPkcs8.toString("base64url"),
        }),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ code: "issuer_unavailable", status: 503 });
  });

  test("binds the signed registration credential to the HMAC credential", async () => {
    const body = fixtureBody(
      fixtureBindings({ registrationCredentialIdSha256: digest(22) }),
    );
    await expect(
      issueRegistrationPermit(
        body,
        await fixtureAuthentication(body),
        fixtureEnv(),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({
      code: "registration_binding_mismatch",
      status: 403,
    });

    for (const bindings of [
      fixtureBindings({
        authorizationSignatureEnvelopeSha256: digest(2),
      }),
      fixtureBindings({ registrationRequestSha256: digest(5) }),
      fixtureBindings({ adminAuditDigestSha256: digest(5) }),
      fixtureBindings({ adminAuditDigestSha256: digest(6) }),
      fixtureBindings({ registrationExecutionIdSha256: digest(20) }),
      fixtureBindings({ passkeyAssertionSignatureSha256: digest(12) }),
    ]) {
      expect(() => parseRegistrationBindings(fixtureBody(bindings))).toThrow(
        expect.objectContaining({ code: "invalid_fields", status: 400 }),
      );
    }
  });

  test("uses the Rust-compatible identifier grammars", async () => {
    const authentication = await fixtureAuthentication();
    await expect(
      issueRegistrationPermit(
        fixtureBody(),
        authentication,
        fixtureEnv({
          DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID: "Uppercase-Key",
        }),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ code: "issuer_unavailable", status: 503 });

    for (const registeredByServiceName of [
      "service-",
      `s${"a".repeat(127)}x`,
    ]) {
      expect(() =>
        parseRegistrationBindings(
          fixtureBody(fixtureBindings({ registeredByServiceName })),
        ),
      ).toThrow(
        expect.objectContaining({ code: "invalid_fields", status: 400 }),
      );
    }
    expect(
      parseRegistrationBindings(
        fixtureBody(
          fixtureBindings({
            registeredByServiceName: `s${"a".repeat(126)}x`,
          }),
        ),
      ).registeredByServiceName,
    ).toHaveLength(128);

    await expect(
      issueRegistrationPermit(
        fixtureBody(),
        authentication,
        fixtureEnv({
          DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256:
            TEST_SPKI_SHA256,
        }),
        FIXTURE_NOW,
      ),
    ).rejects.toMatchObject({ code: "issuer_unavailable", status: 503 });
  });
});

async function fixtureAuthentication(body = fixtureBody()) {
  return {
    credentialIdSha256: CURRENT_CREDENTIAL_ID_SHA256,
    keyId: "current-v1",
    bodySha256: await sha256Hex(body),
    requestId: FIXTURE_REQUEST_ID,
    issuedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 30,
  };
}

async function authorityToken(
  env: IssuerEnv,
  body: Uint8Array,
  now: number,
  key: "current" | "previous",
  overrides: Partial<AuthorityTokenClaims> = {},
): Promise<string> {
  const current = key === "current";
  const claims: AuthorityTokenClaims = {
    issuer: env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER,
    audience: env.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE,
    credential_id_sha256: current
      ? CURRENT_CREDENTIAL_ID_SHA256
      : PREVIOUS_CREDENTIAL_ID_SHA256,
    request_id: FIXTURE_REQUEST_ID,
    method: "POST",
    path_and_query: PERMITS_PATH,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
    ...overrides,
  };
  return createHmacTokenForTest(
    current ? CURRENT_SECRET : PREVIOUS_SECRET,
    current ? "current-v1" : "previous-v1",
    claims,
  );
}

async function authenticatedRequest(
  env: IssuerEnv,
  body: Uint8Array,
  now: number,
  key: "current" | "previous",
  claims: Partial<AuthorityTokenClaims> = {},
  requestUrl = `https://issuer.example${PERMITS_PATH}`,
  requestMethod = "POST",
): Promise<Request> {
  const token = await authorityToken(env, body, now, key, claims);
  return new Request(requestUrl, {
    method: requestMethod,
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-issuer": token,
    },
    body: requestMethod === "GET" || requestMethod === "HEAD" ? null : body,
  });
}

function driftSubject(
  subject: RegistrationPermitSubject,
  field: (typeof EXPECTED_SUBJECT_FIELDS)[number],
): RegistrationPermitSubject {
  const drifted = structuredClone(subject);
  const value = drifted[field];
  if (typeof value === "boolean") {
    Reflect.set(drifted, field, !value);
  } else if (typeof value === "number") {
    Reflect.set(drifted, field, value + 1);
  } else if (/^[0-9a-f]{64}$/.test(value)) {
    Reflect.set(
      drifted,
      field,
      `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`,
    );
  } else {
    Reflect.set(drifted, field, `${value}-drift`);
  }
  return drifted;
}

function expectProtocolError(
  action: () => unknown,
  code: string,
  status: number,
): void {
  try {
    action();
    throw new Error("expected_protocol_error");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ code, status });
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
