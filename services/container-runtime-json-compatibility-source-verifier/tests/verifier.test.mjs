import { describe, expect, test } from "vitest";

import {
  sourceAuthenticationRevocationKey,
} from "../../../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  canonicalJson,
  sha256Canonical,
} from "../../../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  createSourceAuthenticationFixture,
} from "../../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  authenticateTransitionSource,
} from "../src/verifier.ts";

describe("private source verifier", () => {
  test("authenticates a canonical v3 bundle with pinned C2 and C4 keys", async () => {
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
    expect(fixture.bundle.externalWormArchiveEvidence).toEqual(
      fixture.externalWormArchiveEvidence,
    );
    expect(fixture.bundle.externalWormS3Closure).toEqual(
      fixture.externalWormS3Closure,
    );
    expect(fixture.bundle.externalWormS3Closure.authorizesC2Closure)
      .toBe(false);
    expect(
      fixture.bundle.immutableSourceArchiveReceipt.archivePolicySha256,
    ).toBe(fixture.externalWormArchivePolicySha256);
    expect(
      fixture.bundle.immutableSourceArchiveReceipt
        .externalWormS3ClosureSha256,
    ).toBe(fixture.externalWormS3Closure.closureSha256);
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

  test("rejects an unapproved policy or deployment identity before R2", async () => {
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

    const identityBucket = new MemorySourceBucket(fixture);
    const identityProof = await authenticateTransitionSource(
      verifierEnv(fixture, identityBucket, {
        CF_VERSION_METADATA: { id: "unapproved-source-verifier-version" },
      }),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    );
    expect(identityProof).toMatchObject({
      classification: "rejected",
      reasonCode: "source_verifier_identity_mismatch",
    });
    expect(identityBucket.counts).toEqual({ head: 0, get: 0 });
  });

  test("rejects a C4 policy pinned to the wrong external WORM anchor", async () => {
    const fixture = await createSourceAuthenticationFixture({
      operationSeed: "unapproved-c2-policy-anchor",
      invalidExternalWormPolicyAnchor: true,
    });
    const bucket = new MemorySourceBucket(fixture);
    expect(fixture.sourceVerifierExternalWormArchivePolicySha256)
      .not.toBe(fixture.externalWormArchivePolicySha256);
    const proof = await authenticateTransitionSource(
      verifierEnv(fixture, bucket),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    );
    expect(proof).toMatchObject({
      classification: "rejected",
      reasonCode: "external_worm_attestation_policy_anchor_mismatch",
    });
    expect(bucket.counts).toEqual({ head: 3, get: 1 });
  });

  test("fails closed on a zero C2 policy anchor before R2", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const bucket = new MemorySourceBucket(fixture);
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, bucket, {
        JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: "true",
        JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "true",
        JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_SHA256:
          "0".repeat(64),
      }),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).rejects.toMatchObject({
      code: "source_verifier_external_worm_policy_invalid",
    });
    expect(bucket.counts).toEqual({ head: 0, get: 0 });
  });

  test("rejects forged writer and independent-readback C2 attestations", async () => {
    for (const [option, operationSeed] of [
      ["invalidExternalWormWriterSignature", "forged-c2-writer"],
      ["invalidExternalWormReadbackSignature", "forged-c2-readback"],
    ]) {
      const fixture = await createSourceAuthenticationFixture({
        operationSeed,
        [option]: true,
      });
      const bucket = new MemorySourceBucket(fixture);
      await expect(authenticateTransitionSource(
        verifierEnv(fixture, bucket),
        fixture.sourceAuthenticationRequest,
        { now: () => fixture.now },
      )).resolves.toMatchObject({
        classification: "rejected",
        reasonCode: "external_worm_signature_invalid",
      });
      expect(bucket.counts).toEqual({ head: 3, get: 1 });
    }
  });

  test("rejects terminal body/object-set substitution under a valid C4 receipt", async () => {
    const fixture = await createSourceAuthenticationFixture({
      operationSeed: "detached-capture-terminal-body",
    });
    const bundle = structuredClone(fixture.bundle);
    bundle.collectionCaptureTerminal.rawObjects[0].contentSha256 =
      "f".repeat(64);
    const { bundleSha256: _oldBundleSha256, ...bundleSubject } = bundle;
    bundle.bundleSha256 = sha256Canonical(bundleSubject);
    const detached = {
      ...fixture,
      bundle,
      bundleBody: `${canonicalJson(bundle)}\n`,
    };
    const bucket = new MemorySourceBucket(detached);
    await expect(authenticateTransitionSource(
      verifierEnv(detached, bucket),
      detached.sourceAuthenticationRequest,
      { now: () => detached.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "source_archive_capture_terminal_invalid",
    });
    expect(bucket.counts).toEqual({ head: 1, get: 1 });
  });

  test("rejects raw S3 observation drift under a valid C4 receipt", async () => {
    const fixture = await createSourceAuthenticationFixture({
      operationSeed: "detached-s3-provider-observations",
      driftExternalWormS3ProviderObservations: true,
    });
    const bucket = new MemorySourceBucket(fixture);
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, bucket),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "c2_writer_provider_observation_set_mismatch",
    });
    expect(bucket.counts).toEqual({ head: 3, get: 1 });
  });

  test("rejects C2 writer reuse of the active C4 signer", async () => {
    const fixture = await createSourceAuthenticationFixture({
      operationSeed: "reused-c2-c4-signer",
      externalWormSignerReuseSource: "writer",
    });
    expect(fixture.externalWormWriterSpkiSha256)
      .toBe(fixture.sourceSignerSpkiSha256);
    const bucket = new MemorySourceBucket(fixture);
    await expect(authenticateTransitionSource(
      verifierEnv(fixture, bucket),
      fixture.sourceAuthenticationRequest,
      { now: () => fixture.now },
    )).resolves.toMatchObject({
      classification: "rejected",
      reasonCode: "external_worm_cross_domain_signer_reuse",
    });
    expect(bucket.counts).toEqual({ head: 3, get: 1 });
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
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3",
        bundleSha256: this.fixture.bundle.bundleSha256,
        sourceSignatureEnvelopeSha256:
          this.fixture.sourceSignatureEnvelopeSha256,
      },
    };
  }
}

function verifierEnv(fixture, bucket, overrides = {}) {
  return {
    CF_VERSION_METADATA: { id: fixture.sourceVerifierVersionId },
    SOURCE_AUTHENTICATION_BUCKET: bucket,
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION: "1",
    JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
      "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
    JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
      "container-runtime/json-compatibility/source-authentication/v3/sha256",
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER:
      "cinatoken-json-compatibility-source-archive-authority-staging",
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
    JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_SHA256:
      fixture.sourceVerifierExternalWormArchivePolicySha256,
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
