import { describe, expect, test } from "vitest";
import {
  CLAIMS_PATH,
  MAX_JSON_BODY_BYTES,
  ProtocolError,
  canonicalJson,
  createHmacTokenForTest,
  parseClaimRequest,
  parseExpiryRequest,
  parseStepRequest,
  readBoundedJson,
  sha256Hex,
  verifyHmacRequest,
  type AuthorityTokenClaims,
} from "../src/protocol";
import {
  AUTHORIZATION_ID,
  CURRENT_CREDENTIAL,
  CURRENT_SECRET,
  LEDGER,
  NOW,
  OWNER,
  PREVIOUS_CREDENTIAL,
  PREVIOUS_SECRET,
  buildClaim,
  securityEnv,
} from "./fixtures";

describe("compact HMAC authority token", () => {
  test.each([
    ["current-v1", CURRENT_SECRET, CURRENT_CREDENTIAL],
    ["previous-v1", PREVIOUS_SECRET, PREVIOUS_CREDENTIAL],
  ])("accepts the %s keyring entry", async (kid, secret, credential) => {
    const body = new TextEncoder().encode("{}");
    const claims = await authorityClaims(credential, "POST", CLAIMS_PATH, body);
    const token = await createHmacTokenForTest(secret, kid, claims);
    const request = new Request(`https://authority.example${CLAIMS_PATH}`, {
      method: "POST",
      headers: { "x-cinatoken-ring-authority": token },
      body,
    });
    await expect(
      verifyHmacRequest(request, body, securityEnv(), NOW),
    ).resolves.toMatchObject({ credentialIdSha256: credential, requestId: "request-1" });
  });

  test("binds method, path and query, body digest, identity, and 60-second time", async () => {
    const body = new TextEncoder().encode("{}");
    const claims = await authorityClaims(
      CURRENT_CREDENTIAL,
      "POST",
      `${CLAIMS_PATH}?unexpected=1`,
      body,
      { issued_at: NOW - 61, expires_at: NOW + 1 },
    );
    const token = await createHmacTokenForTest(
      CURRENT_SECRET,
      "current-v1",
      claims,
    );
    const request = new Request(`https://authority.example${CLAIMS_PATH}`, {
      method: "POST",
      headers: { "x-cinatoken-ring-authority": token },
      body,
    });
    await expectProtocolCode(
      verifyHmacRequest(request, body, securityEnv(), NOW),
      "authority_claim_mismatch",
    );
  });
});

describe("claim permit", () => {
  test("verifies the exact Ed25519 permit and pinned SPKI fingerprint", async () => {
    const claim = await buildClaim();
    const signed = await signedPermit(claim);
    const envelope = {
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-claim-request-v1",
      claim,
      permit: signed.permit,
    };
    await expect(
      parseClaimRequest(
        new TextEncoder().encode(canonicalJson(envelope)),
        CURRENT_CREDENTIAL,
        securityEnv({
          RING_TRANSITION_PERMIT_SPKI_BASE64URL: signed.spkiBase64url,
          RING_TRANSITION_PERMIT_SPKI_SHA256: signed.spkiSha256,
        }),
        NOW,
      ),
    ).resolves.toEqual(claim);
  });

  test("fails closed when the remotely provisioned SPKI misses the tracked fingerprint", async () => {
    const claim = await buildClaim();
    const signed = await signedPermit(claim);
    const envelope = {
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-claim-request-v1",
      claim,
      permit: signed.permit,
    };
    await expectProtocolCode(
      parseClaimRequest(
        new TextEncoder().encode(canonicalJson(envelope)),
        CURRENT_CREDENTIAL,
        securityEnv({
          RING_TRANSITION_PERMIT_SPKI_BASE64URL: signed.spkiBase64url,
          RING_TRANSITION_PERMIT_SPKI_SHA256: "0".repeat(64),
        }),
        NOW,
      ),
      "permit_verifier_unavailable",
    );
  });
});

describe("strict request schemas", () => {
  test("does not accept client supplied step or expiry actors", async () => {
    const step = await validStep();
    const stepWithActor = { ...step, actorExecutionIdSha256: OWNER };
    await expectProtocolCode(
      parseStepRequest(
        new TextEncoder().encode(canonicalJson(stepWithActor)),
      ),
      "invalid_fields",
    );

    const expiry = await validExpiry();
    const expiryWithActor = {
      ...expiry,
      authorityActorIdSha256: "6".repeat(64),
    };
    await expectProtocolCode(
      parseExpiryRequest(
        new TextEncoder().encode(canonicalJson(expiryWithActor)),
      ),
      "invalid_fields",
    );
  });

  test("rejects non-canonical JSON and bodies above 64 KiB", async () => {
    const nonCanonical = new Request("https://authority.example/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{ "a": 1 }',
    });
    const bytes = await readBoundedJson(nonCanonical);
    await expectProtocolCode(parseStepRequest(bytes), "non_canonical_json");

    const oversized = new Request("https://authority.example/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    });
    await expectProtocolCode(readBoundedJson(oversized), "request_too_large");
  });
});

async function authorityClaims(
  credential: string,
  method: string,
  pathAndQuery: string,
  body: Uint8Array,
  overrides: Partial<AuthorityTokenClaims> = {},
): Promise<AuthorityTokenClaims> {
  return {
    issuer: "runner-staging",
    audience: "authority-staging",
    credential_id_sha256: credential,
    request_id: "request-1",
    method,
    path_and_query: pathAndQuery,
    body_sha256: await sha256Hex(body),
    issued_at: NOW - 1,
    expires_at: NOW + 30,
    ...overrides,
  };
}

async function signedPermit(claim: Awaited<ReturnType<typeof buildClaim>>) {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  );
  const unsigned = {
    schemaVersion: 1,
    contract: "cinatoken-ring-transition-claim-permit-v1",
    issuer: "permit-issuer",
    keyId: "permit-v1",
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    claimOwnerSha256: claim.claimOwnerSha256,
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    claimCredentialIdSha256: claim.claimCredentialIdSha256,
    issuedAt: NOW - 1,
    expiresAt: NOW + 30,
  };
  const message = new TextEncoder().encode(
    `cinatoken-ring-transition-claim-permit-v1\n${canonicalJson(unsigned)}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", keyPair.privateKey, message),
  );
  return {
    permit: {
      ...unsigned,
      signatureBase64url: base64url(signature),
    },
    spkiBase64url: base64url(spki),
    spkiSha256: await sha256Hex(spki),
  };
}

async function validStep() {
  const value = {
    schemaVersion: 1,
    contract: "cinatoken-relay-container-ring-transition-execution-step-v1",
    ledgerIdentitySha256: LEDGER,
    claimDigestSha256: "7".repeat(64),
    stateVersion: 1,
    stepCode: "t1_readback",
    fromStatus: "claimed",
    toStatus: "t1_verified",
    mutationRequestSha256: null,
    cloudflareRequestIdSha256: null,
    deploymentSetSha256: "8".repeat(64),
    evidenceSha256: "9".repeat(64),
    failureClass: "",
    transportOutcome: "not_applicable",
  };
  return {
    ...value,
    stepDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(value)),
    ),
  };
}

async function validExpiry() {
  const value = {
    schemaVersion: 1,
    contract: "cinatoken-relay-container-ring-transition-expiry-event-v1",
    ledgerIdentitySha256: LEDGER,
    claimDigestSha256: "7".repeat(64),
    stateVersion: 1,
    fromStatus: "claimed",
    toStatus: "expired",
    evidenceSha256: "9".repeat(64),
    failureClass: "authorization_expired",
  };
  return {
    ...value,
    expiryEventDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(value)),
    ),
  };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function expectProtocolCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected protocol rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
