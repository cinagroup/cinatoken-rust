import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

import {
  buildJsonCompatibilitySourcePublicationPacket,
} from "../../tools/container_runtime_json_compatibility_source_publication.mjs";
import {
  createSourceAuthenticationFixture,
} from "../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";

const publisherVersionId = "source-publisher-runtime-version-001";
const fixture = await createSourceAuthenticationFixture({
  now: Math.floor(Date.now() / 1000),
  operationSeed: "source-publisher-workerd-operation",
});
const packet = buildJsonCompatibilitySourcePublicationPacket({
  sourceAuthenticationRequest: fixture.sourceAuthenticationRequest,
  bundle: fixture.bundle,
}, { now: fixture.now });

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_SOURCE_PUBLICATION_PACKET: JSON.stringify(packet),
          TEST_SOURCE_PUBLICATION_BUNDLE_BODY: fixture.bundleBody,
          TEST_SOURCE_PUBLICATION_BUNDLE_KEY: packet.bundleKey,
          TEST_SOURCE_PUBLICATION_BUNDLE_SHA256: packet.bundleSha256,
          TEST_SOURCE_PUBLICATION_BODY_SHA256: packet.bodySha256,
          TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256:
            packet.sourceSignatureEnvelopeSha256,
          CF_VERSION_METADATA: {
            id: publisherVersionId,
            tag: "runtime-test",
            timestamp: "2026-08-06T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED: "true",
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_R2_WRITE_ENABLED: "true",
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-source-publisher-staging",
          JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
            "container-runtime/json-compatibility/source-authentication/v3/sha256",
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256:
            fixture.sourceVerifierIdentity.sourceVerifierPolicySha256,
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_IDENTITY_SHA256:
            fixture.sourceVerifierIdentity.sourceVerifierIdentitySha256,
        },
        r2Buckets: {
          SOURCE_AUTHENTICATION_BUCKET:
            "json-compatibility-source-publication-runtime-test",
        },
        serviceBindings: {
          JSON_COMPATIBILITY_SOURCE_PUBLISHER_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilitySourcePublisherEntrypoint",
          },
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.runtime.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
