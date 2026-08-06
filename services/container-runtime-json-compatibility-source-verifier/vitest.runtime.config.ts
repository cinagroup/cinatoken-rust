import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

import {
  createSourceAuthenticationFixture,
} from "../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";

const sourceVerifierVersionId = "source-verifier-runtime-version-001";
const fixture = await createSourceAuthenticationFixture({
  now: Math.floor(Date.now() / 1000),
  operationSeed: "source-verifier-workerd-operation",
  sourceVerifierVersionId,
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_SOURCE_AUTHENTICATION_REQUEST: JSON.stringify(
            fixture.sourceAuthenticationRequest,
          ),
          TEST_SOURCE_AUTHENTICATION_BUNDLE: fixture.bundleBody,
          TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY: fixture.bundleKey,
          TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256:
            fixture.bundle.bundleSha256,
          TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256:
            fixture.sourceSignatureEnvelopeSha256,
          TEST_SOURCE_SIGNER_SPKI_SHA256: fixture.sourceSignerSpkiSha256,
          CF_VERSION_METADATA: {
            id: sourceVerifierVersionId,
            tag: "runtime-test",
            timestamp: "2026-08-05T00:00:00.000Z",
          },
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
            fixture.externalWormArchivePolicySha256,
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
        },
        r2Buckets: {
          SOURCE_AUTHENTICATION_BUCKET:
            "json-compatibility-source-authentication-runtime-test",
        },
        serviceBindings: {
          JSON_COMPATIBILITY_SOURCE_VERIFIER_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilitySourceVerifierEntrypoint",
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
