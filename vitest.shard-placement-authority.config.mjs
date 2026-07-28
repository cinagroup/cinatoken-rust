import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import {
  SHARD_PLACEMENT_AUTHORITY_HMAC,
  SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
  SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
} from "./tests/fixtures/shard-placement-authority-fixture.mjs";
import { SHARD_PLACEMENT_AUTHORITY_TEST_KEYS } from "./tests/fixtures/shard-placement-authority-test-keys.mjs";

const d1Migrations = await readD1Migrations(
  "./services/shard-placement-authority/migrations",
);
const keys = SHARD_PLACEMENT_AUTHORITY_TEST_KEYS;

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./services/shard-placement-authority/src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          CF_VERSION_METADATA: {
            id: "shard-placement-authority-runtime-test-version",
            tag: "runtime-test",
            timestamp: "2026-07-28T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          SHARD_PLACEMENT_AUTHORITY_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_READ_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED: "true",
          SHARD_PLACEMENT_AUTHORITY_ISSUER:
            "cinatoken-shard-placement-operator-runtime-test",
          SHARD_PLACEMENT_AUTHORITY_AUDIENCE:
            "cinatoken-shard-placement-authority-runtime-test",
          SHARD_PLACEMENT_AUTHORITY_POLICY_ID:
            SHARD_PLACEMENT_AUTHORITY_POLICY_ID,
          SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256:
            SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256,
          SHARD_PLACEMENT_PERMIT_ISSUER:
            "cinatoken-shard-placement-permit-runtime-test",
          SHARD_PLACEMENT_PERMIT_KEY_ID: keys.permit.keyId,
          SHARD_PLACEMENT_PERMIT_SPKI_BASE64URL:
            keys.permit.spkiBase64url,
          SHARD_PLACEMENT_PERMIT_SPKI_SHA256:
            keys.permit.spkiSha256,
          SHARD_PLACEMENT_SECURITY_KEY_ID: keys.security.keyId,
          SHARD_PLACEMENT_SECURITY_SPKI_BASE64URL:
            keys.security.spkiBase64url,
          SHARD_PLACEMENT_SECURITY_SPKI_SHA256:
            keys.security.spkiSha256,
          SHARD_PLACEMENT_OPERATIONS_KEY_ID: keys.operations.keyId,
          SHARD_PLACEMENT_OPERATIONS_SPKI_BASE64URL:
            keys.operations.spkiBase64url,
          SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256:
            keys.operations.spkiSha256,
          SHARD_PLACEMENT_RELEASE_KEY_ID: keys.release.keyId,
          SHARD_PLACEMENT_RELEASE_SPKI_BASE64URL:
            keys.release.spkiBase64url,
          SHARD_PLACEMENT_RELEASE_SPKI_SHA256:
            keys.release.spkiSha256,
          SHARD_PLACEMENT_ROLLBACK_KEY_ID: keys.rollback.keyId,
          SHARD_PLACEMENT_ROLLBACK_SPKI_BASE64URL:
            keys.rollback.spkiBase64url,
          SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256:
            keys.rollback.spkiSha256,
          ...hmacBindings("READ", SHARD_PLACEMENT_AUTHORITY_HMAC.read),
          ...hmacBindings("ISSUE", SHARD_PLACEMENT_AUTHORITY_HMAC.issue),
          ...hmacBindings("REVOKE", SHARD_PLACEMENT_AUTHORITY_HMAC.revoke),
          ...hmacBindings("CLAIM", SHARD_PLACEMENT_AUTHORITY_HMAC.claim),
          ...hmacBindings(
            "RECEIPT",
            SHARD_PLACEMENT_AUTHORITY_HMAC.receipt,
          ),
          ...hmacBindings(
            "RECOVERY",
            SHARD_PLACEMENT_AUTHORITY_HMAC.recovery,
          ),
        },
        d1Databases: {
          DB: "shard-placement-authority-runtime-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/shard-placement-authority-runtime.test.mjs"],
    testTimeout: 30_000,
  },
});

function hmacBindings(label, identity) {
  return {
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_KID`]: identity.keyId,
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_CREDENTIAL_ID_SHA256`]:
      identity.credentialIdSha256,
    [`SHARD_PLACEMENT_${label}_HMAC_CURRENT_SECRET`]: identity.secret,
    [`SHARD_PLACEMENT_${label}_HMAC_PREVIOUS_KID`]: "",
    [`SHARD_PLACEMENT_${label}_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256`]:
      "",
  };
}
