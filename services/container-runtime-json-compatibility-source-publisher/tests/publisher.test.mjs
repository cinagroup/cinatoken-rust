import { beforeAll, describe, expect, test } from "vitest";

import {
  buildJsonCompatibilitySourcePublicationPacket,
} from "../../../tools/container_runtime_json_compatibility_source_publication.mjs";
import {
  createSourceAuthenticationFixture,
} from "../../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  JsonCompatibilitySourcePublisherWorkerError,
  publishSourceBundle,
} from "../src/publisher.ts";

let fixture;
let packet;

beforeAll(async () => {
  fixture = await createSourceAuthenticationFixture({
    operationSeed: "source-publisher-node-operation",
  });
  packet = buildJsonCompatibilitySourcePublicationPacket({
    sourceAuthenticationRequest: fixture.sourceAuthenticationRequest,
    bundle: fixture.bundle,
  }, { now: fixture.now });
});

describe("private source publisher", () => {
  test("performs one conditional put and returns a write-only receipt", async () => {
    const bucket = new MockWriteBucket(packet);
    const receipt = await publishSourceBundle(
      publisherEnv(fixture, bucket),
      packet,
      { now: () => fixture.now },
    );
    expect(bucket.calls).toHaveLength(1);
    expect(bucket.calls[0]).toMatchObject({
      key: packet.bundleKey,
      options: {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: packet.objectMetadata,
      },
    });
    expect(bucket.calls[0].value.byteLength).toBe(packet.bodyByteLength);
    expect(receipt).toMatchObject({
      contract:
        "cinatoken-container-runtime-json-compatibility-source-publication-write-receipt-v1",
      bundleKey: packet.bundleKey,
      bundleSha256: packet.bundleSha256,
      bodySha256: packet.bodySha256,
      bodyByteLength: packet.bodyByteLength,
      createOnly: true,
      writeAttemptCount: 1,
      retryPerformed: false,
      readbackPerformed: false,
    });
  });

  test("fails closed on occupied or ambiguous writes without retry", async () => {
    for (const mode of ["occupied", "throw", "commit-then-throw"]) {
      const bucket = new MockWriteBucket(packet, mode);
      await expect(publishSourceBundle(
        publisherEnv(fixture, bucket),
        packet,
        { now: () => fixture.now },
      )).rejects.toBeInstanceOf(JsonCompatibilitySourcePublisherWorkerError);
      expect(bucket.calls).toHaveLength(1);
      if (mode === "commit-then-throw") {
        expect(bucket.stored).toMatchObject({
          key: packet.bundleKey,
          byteLength: packet.bodyByteLength,
        });
      }
    }
  });

  test("rejects disabled and verifier-anchor drift before R2", async () => {
    const disabledBucket = new MockWriteBucket(packet);
    await expect(publishSourceBundle(
      publisherEnv(fixture, disabledBucket, {
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED: "false",
      }),
      packet,
      { now: () => fixture.now },
    )).rejects.toMatchObject({ code: "source_publisher_disabled" });
    expect(disabledBucket.calls).toHaveLength(0);

    const driftBucket = new MockWriteBucket(packet);
    await expect(publishSourceBundle(
      publisherEnv(fixture, driftBucket, {
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256:
          "1".repeat(64),
      }),
      packet,
      { now: () => fixture.now },
    )).rejects.toMatchObject({
      code: "source_publication_verifier_policy_mismatch",
    });
    expect(driftBucket.calls).toHaveLength(0);
  });

  test("rejects packet substitution before R2", async () => {
    const bucket = new MockWriteBucket(packet);
    const drifted = structuredClone(packet);
    drifted.bundleKey = drifted.bundleKey.replace(/\.json$/u, "-drift.json");
    await expect(publishSourceBundle(
      publisherEnv(fixture, bucket),
      drifted,
      { now: () => fixture.now },
    )).rejects.toMatchObject({ code: "source_publication_packet_invalid" });
    expect(bucket.calls).toHaveLength(0);
  });
});

class MockWriteBucket {
  constructor(packetValue, mode = "success") {
    this.packet = packetValue;
    this.mode = mode;
    this.calls = [];
    this.stored = null;
  }

  async put(key, value, options) {
    this.calls.push({ key, value, options });
    if (this.mode === "throw") throw new Error("simulated pre-commit outage");
    if (this.mode === "commit-then-throw") {
      this.stored = { key, byteLength: value.byteLength, options };
      throw new Error("simulated response loss after commit");
    }
    if (this.mode === "occupied") return null;
    return {
      key,
      size: value.byteLength,
      version: "source-publisher-object-version-001",
      etag: "source-publisher-object-etag-001",
    };
  }
}

function publisherEnv(fixtureValue, bucket, overrides = {}) {
  return {
    CF_VERSION_METADATA: { id: "source-publisher-version-001" },
    SOURCE_AUTHENTICATION_BUCKET: bucket,
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_R2_WRITE_ENABLED: "true",
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME:
      "cinatoken-container-runtime-json-compatibility-source-publisher-staging",
    JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
      "container-runtime/json-compatibility/source-authentication/v3/sha256",
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256:
      fixtureValue.sourceVerifierIdentity.sourceVerifierPolicySha256,
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_IDENTITY_SHA256:
      fixtureValue.sourceVerifierIdentity.sourceVerifierIdentitySha256,
    ...overrides,
  };
}
