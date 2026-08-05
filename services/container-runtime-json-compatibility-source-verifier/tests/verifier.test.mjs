import { describe, expect, test } from "vitest";

import {
  sourceAuthenticationRevocationKey,
} from "../../../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  createSourceAuthenticationFixture,
} from "../../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  authenticateTransitionSource,
} from "../src/verifier.ts";

describe("private source verifier", () => {
  test("authenticates a canonical R2 bundle with the pinned Ed25519 key", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const bucket = new MemorySourceBucket(fixture);
    const proof = await authenticateTransitionSource(
      verifierEnv(fixture, bucket),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    );
    expect(proof).toMatchObject({
      schemaVersion: 2,
      classification: "authenticated",
      reasonCode: null,
      request: fixture.sourceAuthenticationRequest,
      verifiedAt: fixture.now,
    });
    expect(proof.verifierIdentitySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket.counts).toEqual({ head: 3, get: 1 });
  });

  test("supports a bounded previous-key window and rejects it after expiry", async () => {
    const fixture = await createSourceAuthenticationFixture({
      sourceSignerTrustSlot: "previous",
    });
    const bucket = new MemorySourceBucket(fixture);
    const previousEnv = verifierEnv(fixture, bucket);
    await expect(authenticateTransitionSource(
      previousEnv,
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({ classification: "authenticated" });
    await expect(authenticateTransitionSource(
      previousEnv,
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now + 61 },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_signer_key_untrusted",
    });
  });

  test("rejects missing, noncanonical, revoked, and invalid-signature bundles", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const missing = new MemorySourceBucket(fixture, { missing: true });
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, missing),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_bundle_missing",
    });

    const noncanonical = new MemorySourceBucket(fixture, {
      body: `${JSON.stringify(fixture.bundle, null, 2)}\n`,
    });
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, noncanonical),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_bundle_not_canonical",
    });

    const revoked = new MemorySourceBucket(fixture, { revoked: true });
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, revoked),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_signer_revoked",
    });

    const invalidSignature = await createSourceAuthenticationFixture({
      operationSeed: "invalid-source-signature-operation",
      invalidSourceSignature: true,
    });
    const invalidBucket = new MemorySourceBucket(invalidSignature);
    await expect(authenticateTransitionSource(
      verifierEnv(invalidSignature, invalidBucket),
      invalidSignature.sourceAuthenticationRequest,
      { now: () => invalidSignature.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_signature_invalid",
    });
  });

  test("classifies R2 uncertainty as ambiguous and gates before storage", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const unavailable = new MemorySourceBucket(fixture, { headError: true });
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, unavailable),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "ambiguous",
      reasonCode: "source_bundle_read_unavailable",
    });

    const gated = new MemorySourceBucket(fixture);
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, gated, {
        JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "false",
      }),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).rejects.toMatchObject({ code: "source_verifier_disabled" });
    expect(gated.counts).toEqual({ head: 0, get: 0 });
  });

  test("rejects an unapproved verifier policy before reading R2", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const bucket = new MemorySourceBucket(fixture);
    const proof = await authenticateTransitionSource(
      verifierEnv(fixture, bucket, {
        JSON_COMPATIBILITY_SOURCE_CURRENT_KID: "unapproved-source-key",
      }),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    );
    expect(proof).toMatchObject({
      classification: "rejected",
      reasonCode: "source_verifier_policy_mismatch",
    });
    expect(bucket.counts).toEqual({ head: 0, get: 0 });
  });
});

class MemorySourceBucket {
  constructor(fixture, options = {}) {
    this.fixture = fixture;
    this.options = options;
    this.counts = { head: 0, get: 0 };
    this.body = options.body ?? fixture.bundleBody;
  }

  async head(key) {
    this.counts.head += 1;
    if (this.options.headError) throw new Error("simulated R2 outage");
    if (key.includes("/revocations/")) {
      return this.options.revoked ? this.object(key, "revoked") : null;
    }
    if (this.options.missing || key !== this.fixture.bundleKey) return null;
    return this.object(key, this.body);
  }

  async get(key) {
    this.counts.get += 1;
    if (this.options.getError) throw new Error("simulated R2 outage");
    if (this.options.missing || key !== this.fixture.bundleKey) return null;
    return {
      ...this.object(key, this.body),
      arrayBuffer: async () => new TextEncoder().encode(this.body).buffer,
    };
  }

  object(key, body) {
    const bytes = new TextEncoder().encode(body).byteLength;
    return {
      key,
      version: "source-object-version-001",
      etag: "source-object-etag-001",
      size: bytes,
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contract:
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v1",
        bundleSha256: this.fixture.bundle.bundleSha256,
        sourceSignatureEnvelopeSha256:
          this.fixture.sourceSignatureEnvelopeSha256,
      },
    };
  }
}

function verifierEnv(fixture, bucket, overrides = {}) {
  return {
    CF_VERSION_METADATA: { id: "source-verifier-version-001" },
    SOURCE_AUTHENTICATION_BUCKET: bucket,
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION: "1",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
      "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
    JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
      "container-runtime/json-compatibility/source-authentication/v2/sha256",
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER:
      "cinatoken-json-compatibility-source-archive-authority-staging",
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
    JSON_COMPATIBILITY_SOURCE_CURRENT_KID:
      fixture.sourcePolicyCurrent.keyId,
    JSON_COMPATIBILITY_SOURCE_CURRENT_SPKI_SHA256:
      fixture.sourcePolicyCurrent.spkiSha256,
    JSON_COMPATIBILITY_SOURCE_PREVIOUS_KID:
      fixture.sourcePolicyPrevious?.keyId ?? "",
    JSON_COMPATIBILITY_SOURCE_PREVIOUS_SPKI_SHA256:
      fixture.sourcePolicyPrevious?.spkiSha256 ?? "",
    JSON_COMPATIBILITY_SOURCE_PREVIOUS_ACCEPT_UNTIL:
      fixture.sourcePolicyPrevious === null
        ? ""
        : String(fixture.sourcePolicyPrevious.acceptUntil),
    ...overrides,
  };
}
