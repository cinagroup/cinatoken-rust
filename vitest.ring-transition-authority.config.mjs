import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import {
  TEST_PERMIT_SPKI_BASE64URL,
  TEST_PERMIT_SPKI_SHA256,
} from "./tests/fixtures/ring-transition-authority-test-keys.mjs";

const d1Migrations = await readD1Migrations(
  "./services/ring-transition-authority/migrations",
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./services/ring-transition-authority/src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          CF_VERSION_METADATA: {
            id: "authority-runtime-test-version",
            tag: "runtime-test",
            timestamp: "2026-07-23T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          RING_TRANSITION_AUTHORITY_ENABLED: "true",
          RING_TRANSITION_CLAIM_WRITE_ENABLED: "true",
          RING_TRANSITION_STEP_WRITE_ENABLED: "true",
          RING_TRANSITION_EXPIRY_WRITE_ENABLED: "true",
          RING_TRANSITION_AUTHORITY_ISSUER:
            "cinatoken-ring-runner-runtime-test",
          RING_TRANSITION_AUTHORITY_AUDIENCE:
            "cinatoken-ring-transition-authority-runtime-test",
          RING_TRANSITION_HMAC_CURRENT_KID: "runtime-test-v1",
          RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "b".repeat(64),
          RING_TRANSITION_HMAC_CURRENT_SECRET:
            "runtime-test-hmac-secret-00000000000000000000000000000000",
          RING_TRANSITION_HMAC_PREVIOUS_KID: "",
          RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
          RING_TRANSITION_PERMIT_ISSUER:
            "cinatoken-ring-permit-runtime-test",
          RING_TRANSITION_PERMIT_KEY_ID: "runtime-test-permit-v1",
          RING_TRANSITION_PERMIT_SPKI_BASE64URL:
            TEST_PERMIT_SPKI_BASE64URL,
          RING_TRANSITION_PERMIT_SPKI_SHA256: TEST_PERMIT_SPKI_SHA256,
          RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256: "f".repeat(64),
        },
        d1Databases: {
          DB: "ring-transition-authority-runtime-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/ring-transition-authority-runtime.test.mjs"],
    testTimeout: 30_000,
  },
});
