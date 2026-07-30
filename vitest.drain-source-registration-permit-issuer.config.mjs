import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath:
          "./services/drain-source-registration-permit-issuer/wrangler.staging.jsonc",
      },
      miniflare: {
        bindings: {
          DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED: "true",
          DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID: "current-v1",
          DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
            "14".repeat(32),
          DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET:
            "current-registration-authority-secret-0001",
          DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID:
            "registration-permit-staging-v1",
          DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256:
            "13".repeat(32),
          DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256:
            "324be2dea8bc44461b0233e51fa48902ed6b1cc671e7739af2551e0bfe68f54e",
          DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL:
            "MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL:
            "MCowBQYDK2VwAyEA6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
        },
      },
    }),
  ],
  test: {
    include: [
      "tests/drain-source-registration-permit-issuer-runtime.test.mjs",
    ],
    testTimeout: 30_000,
  },
});
