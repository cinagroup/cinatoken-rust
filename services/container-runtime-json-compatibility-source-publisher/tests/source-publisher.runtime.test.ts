import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";

import type {
  JsonCompatibilitySourcePublicationPacketV1,
  JsonCompatibilitySourcePublicationWriteReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_source_publication.mjs";
import {
  publishSourceBundle,
  type JsonCompatibilitySourcePublisherEnv,
} from "../src/publisher";

interface SourcePublisherRpcBinding {
  publishSourceBundle(
    input: unknown,
  ): Promise<JsonCompatibilitySourcePublicationWriteReceiptV1>;
}

interface RuntimeTestEnv {
  readonly SOURCE_AUTHENTICATION_BUCKET: R2Bucket;
  readonly JSON_COMPATIBILITY_SOURCE_PUBLISHER_NAMED: SourcePublisherRpcBinding;
  readonly TEST_SOURCE_PUBLICATION_PACKET: string;
  readonly TEST_SOURCE_PUBLICATION_BUNDLE_BODY: string;
  readonly TEST_SOURCE_PUBLICATION_BUNDLE_KEY: string;
  readonly TEST_SOURCE_PUBLICATION_BUNDLE_SHA256: string;
  readonly TEST_SOURCE_PUBLICATION_BODY_SHA256: string;
  readonly TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256: string;
}

const runtimeEnv = env as unknown as RuntimeTestEnv;

afterEach(async () => {
  await reset();
});

describe("source publisher named RPC with real R2", () => {
  test("atomically creates one canonical object with exact metadata", async () => {
    const receipt = await runtimeEnv.JSON_COMPATIBILITY_SOURCE_PUBLISHER_NAMED
      .publishSourceBundle(packet());
    expect(receipt).toMatchObject({
      bundleKey: runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_KEY,
      bundleSha256: runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_SHA256,
      bodySha256: runtimeEnv.TEST_SOURCE_PUBLICATION_BODY_SHA256,
      writeAttemptCount: 1,
      retryPerformed: false,
      readbackPerformed: false,
    });
    const object = await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.get(
      runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_KEY,
    );
    expect(object).not.toBeNull();
    expect(await object?.text()).toBe(
      runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_BODY,
    );
    expect(object).toMatchObject({
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contract:
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3",
        bundleSha256: runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_SHA256,
        sourceSignatureEnvelopeSha256:
          runtimeEnv.TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256,
      },
    });
  });

  test("admits exactly one concurrent create and never changes its body", async () => {
    const input = packet();
    const outcomes = await Promise.allSettled([
      publishSourceBundle(
        runtimeEnv as unknown as JsonCompatibilitySourcePublisherEnv,
        input,
      ),
      publishSourceBundle(
        runtimeEnv as unknown as JsonCompatibilitySourcePublisherEnv,
        input,
      ),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected"))
      .toHaveLength(1);
    const rejected = outcomes.find((value) => value.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "source_publication_bundle_key_occupied" },
    });
    const object = await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.get(
      runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_KEY,
    );
    expect(await object?.text()).toBe(
      runtimeEnv.TEST_SOURCE_PUBLICATION_BUNDLE_BODY,
    );
  });
});

function packet(): JsonCompatibilitySourcePublicationPacketV1 {
  return JSON.parse(runtimeEnv.TEST_SOURCE_PUBLICATION_PACKET) as
    JsonCompatibilitySourcePublicationPacketV1;
}
