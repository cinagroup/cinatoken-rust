import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import authorityWorker from "../services/ring-transition-authority/src/index.ts";
import {
  canonicalJson,
  createHmacTokenForTest,
  sha256Hex,
} from "../services/ring-transition-authority/src/protocol.ts";
import { TEST_PERMIT_PKCS8_BASE64URL } from "./fixtures/ring-transition-authority-test-keys.mjs";

const encoder = new TextEncoder();
const origin = "https://ring-transition-authority-runtime.test";
const credentialIdSha256 = "b".repeat(64);
const hmacSecret =
  "runtime-test-hmac-secret-00000000000000000000000000000000";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

describe("ring transition Authority Workerd runtime", () => {
  it("creates, exactly replays, reads, and advances a signed D1 claim", async () => {
    const preflight = await authorityFetch(
      "GET",
      "/internal/v1/ring-transition/preflight",
      { requestId: "authority-preflight-1" },
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      result: "authority_ready",
      requestId: "authority-preflight-1",
      credentialIdSha256,
      permitSpkiSha256:
        "471850d2dcfe546734941e2d44fde594cb3e4445900da72536ac9683f6be5d10",
    });

    const claim = await claimFixture();
    const permit = await signedPermit(claim);
    const createBody = canonicalJson({
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-claim-request-v1",
      claim,
      permit,
    });
    const concurrent = await Promise.all([
      authorityFetch("POST", "/internal/v1/ring-transition/claims", {
        body: createBody,
        requestId: "claim-create-1",
      }),
      authorityFetch("POST", "/internal/v1/ring-transition/claims", {
        body: createBody,
        requestId: "claim-create-2",
      }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const concurrentPayloads = await Promise.all(
      concurrent.map((response) => response.json()),
    );
    expect(
      concurrentPayloads.map((payload) => payload.result).sort(),
    ).toEqual(["created", "exact_replay"]);
    expect(concurrent[0].headers.get("cache-control")).toBe("no-store");
    expect(concurrentPayloads[0]).toMatchObject({
      claim: {
        authorizationIdSha256: claim.authorizationIdSha256,
        claimDigestSha256: claim.claimDigestSha256,
        status: "claimed",
        stateVersion: 0,
      },
    });

    const query =
      `?claimDigestSha256=${claim.claimDigestSha256}` +
      `&claimOwnerSha256=${claim.claimOwnerSha256}`;
    const read = await authorityFetch(
      "GET",
      `/internal/v1/ring-transition/claims/${claim.authorizationIdSha256}${query}`,
      { requestId: "claim-read-1" },
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      result: "exact_claim",
      snapshot: {
        state: { status: "claimed", stateVersion: 0 },
        steps: [],
        expiryEvents: [],
      },
    });

    const unsignedStep = {
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-ring-transition-execution-step-v1",
      ledgerIdentitySha256: claim.ledgerIdentitySha256,
      claimDigestSha256: claim.claimDigestSha256,
      stateVersion: 1,
      stepCode: "t1_readback",
      fromStatus: "claimed",
      toStatus: "t1_verified",
      mutationRequestSha256: null,
      cloudflareRequestIdSha256: null,
      deploymentSetSha256: "1".repeat(64),
      evidenceSha256: "2".repeat(64),
      failureClass: "",
      transportOutcome: "not_applicable",
    };
    const step = {
      ...unsignedStep,
      stepDigestSha256: await digestCanonical(unsignedStep),
    };
    const advanced = await authorityFetch(
      "POST",
      `/internal/v1/ring-transition/claims/${claim.authorizationIdSha256}/steps`,
      { body: canonicalJson(step), requestId: "claim-step-1" },
    );
    expect(advanced.status).toBe(201);
    expect(await advanced.json()).toMatchObject({
      result: "step_appended",
      status: "t1_verified",
      stateVersion: 1,
      stepDigestSha256: step.stepDigestSha256,
    });
  });

  it("fails closed on gate, HMAC, permit, and premature expiry violations", async () => {
    const disabled = await authorityWorker.fetch(
      new Request(`${origin}/internal/v1/ring-transition/claims`, {
        method: "POST",
      }),
      {
        ...env,
        RING_TRANSITION_AUTHORITY_ENABLED: "false",
      },
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "authority_disabled" });

    const claim = await claimFixture();
    const permit = await signedPermit(claim);
    const body = canonicalJson({
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-claim-request-v1",
      claim,
      permit,
    });
    const tokenForEmptyBody = await authorityToken(
      "POST",
      "/internal/v1/ring-transition/claims",
      "",
      "wrong-body-token",
    );
    const wrongBody = await SELF.fetch(
      `${origin}/internal/v1/ring-transition/claims`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cinatoken-ring-authority": tokenForEmptyBody,
        },
        body,
      },
    );
    expect(wrongBody.status).toBe(403);

    const tamperedBody = canonicalJson({
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-claim-request-v1",
      claim,
      permit: { ...permit, signatureBase64url: "A".repeat(86) },
    });
    const tampered = await authorityFetch(
      "POST",
      "/internal/v1/ring-transition/claims",
      { body: tamperedBody, requestId: "bad-permit" },
    );
    expect(tampered.status).toBe(403);
    expect(await tampered.json()).toEqual({ error: "invalid_permit" });

    const created = await authorityFetch(
      "POST",
      "/internal/v1/ring-transition/claims",
      { body, requestId: "claim-for-expiry" },
    );
    expect(created.status).toBe(201);
    const unsignedExpiry = {
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-ring-transition-expiry-event-v1",
      ledgerIdentitySha256: claim.ledgerIdentitySha256,
      claimDigestSha256: claim.claimDigestSha256,
      stateVersion: 1,
      fromStatus: "claimed",
      toStatus: "expired",
      evidenceSha256: "3".repeat(64),
      failureClass: "authorization_expired",
    };
    const expiry = {
      ...unsignedExpiry,
      expiryEventDigestSha256: await digestCanonical(unsignedExpiry),
    };
    const premature = await authorityFetch(
      "POST",
      `/internal/v1/ring-transition/claims/${claim.authorizationIdSha256}/expire`,
      { body: canonicalJson(expiry), requestId: "premature-expiry" },
    );
    expect(premature.status).toBe(409);
    const prematurePayload = await premature.json();
    expect(prematurePayload).toEqual({ error: "expiry_conflict" });
    expect(JSON.stringify(prematurePayload)).not.toContain("SQL");
    expect(JSON.stringify(prematurePayload)).not.toContain(hmacSecret);
  });
});

async function authorityFetch(method, pathAndQuery, { body = null, requestId }) {
  const token = await authorityToken(
    method,
    pathAndQuery,
    body ?? "",
    requestId,
  );
  const headers = {
    accept: "application/json",
    "x-cinatoken-ring-authority": token,
  };
  if (body !== null) headers["content-type"] = "application/json";
  return SELF.fetch(`${origin}${pathAndQuery}`, {
    method,
    headers,
    body,
  });
}

async function authorityToken(method, pathAndQuery, body, requestId) {
  const now = Math.floor(Date.now() / 1000);
  return createHmacTokenForTest(hmacSecret, "runtime-test-v1", {
    issuer: "cinatoken-ring-runner-runtime-test",
    audience: "cinatoken-ring-transition-authority-runtime-test",
    credential_id_sha256: credentialIdSha256,
    request_id: requestId,
    method,
    path_and_query: pathAndQuery,
    body_sha256: await sha256Hex(encoder.encode(body)),
    issued_at: now,
    expires_at: now + 60,
  });
}

async function claimFixture() {
  const generatedAt = Math.floor(Date.now() / 1000);
  const unsigned = {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-container-ring-transition-execution-claim-v1",
    claimAuthority: "d1-unique-claim-v1",
    claimScope: "staging-worker-ring-transition",
    environment: "staging",
    authorizationIdSha256: "1".repeat(64),
    executionNonceSha256: "2".repeat(64),
    authorizationManifestSha256: "3".repeat(64),
    authorizationSubjectSha256: "4".repeat(64),
    authorizationPolicySha256: "5".repeat(64),
    transitionManifestSha256: "6".repeat(64),
    transitionSubjectSha256: "7".repeat(64),
    transitionPolicySha256: "8".repeat(64),
    transitionPlanSha256: "9".repeat(64),
    candidateSha256: "a".repeat(64),
    executionPlanSha256: "c".repeat(64),
    accountIdSha256: "d".repeat(64),
    ledgerIdentitySha256: "e".repeat(64),
    readCredentialIdSha256: "a".repeat(64),
    claimCredentialIdSha256: credentialIdSha256,
    deployCredentialIdSha256: "c".repeat(64),
    controller: {
      serviceName: "cinatoken-container-controller-staging",
      previousVersionId: "controller-version-001",
      previousDeploymentSetSha256: "1".repeat(64),
      targetVersionId: "controller-version-002",
    },
    edge: {
      serviceName: "cinatoken-rust-api-staging",
      previousVersionId: "edge-version-001",
      previousDeploymentSetSha256: "2".repeat(64),
      targetVersionId: "edge-version-002",
    },
    runnerBuildSha256: "3".repeat(64),
    runnerTrustConfigSha256: "4".repeat(64),
    claimOwnerSha256: "5".repeat(64),
    generatedAt,
    expiresAt: generatedAt + 300,
  };
  return {
    ...unsigned,
    claimDigestSha256: await digestCanonical(unsigned),
  };
}

async function signedPermit(claim) {
  const now = Math.floor(Date.now() / 1000);
  const subject = {
    schemaVersion: 1,
    contract: "cinatoken-ring-transition-claim-permit-v1",
    issuer: "cinatoken-ring-permit-runtime-test",
    keyId: "runtime-test-permit-v1",
    authorizationIdSha256: claim.authorizationIdSha256,
    claimDigestSha256: claim.claimDigestSha256,
    claimOwnerSha256: claim.claimOwnerSha256,
    ledgerIdentitySha256: claim.ledgerIdentitySha256,
    claimCredentialIdSha256: claim.claimCredentialIdSha256,
    issuedAt: now,
    expiresAt: now + 60,
  };
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlBytes(TEST_PERMIT_PKCS8_BASE64URL),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      encoder.encode(
        `cinatoken-ring-transition-claim-permit-v1\n${canonicalJson(subject)}`,
      ),
    ),
  );
  return {
    ...subject,
    signatureBase64url: base64Url(signature),
  };
}

async function digestCanonical(value) {
  return sha256Hex(encoder.encode(canonicalJson(value)));
}

function base64UrlBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function base64Url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
