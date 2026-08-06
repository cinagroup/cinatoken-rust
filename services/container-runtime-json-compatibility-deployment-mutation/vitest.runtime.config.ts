import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          CF_VERSION_METADATA: {
            id: "mutation-version-2026-08",
            tag: "runtime-test",
            timestamp: "2026-08-06T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          CLOUDFLARE_ACCOUNT_ID: "cloudflare-account-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ENABLED: "false",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_REMOTE_ENABLED: "false",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_PROFILE_VERSION: "1",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_CREDENTIAL_ID_SHA256:
            "ce904ef437d5322df4bfb8e6ff1818a89368e93611ae76019c38a0c4af72f0e9",
          JSON_COMPATIBILITY_DEPLOYMENT_MUTATION_ACCOUNT_ID_SHA256:
            "a0d1aa4ac1f4124fcf72860328712eec72715c4f20bb84ed7d67cdc0064322eb",
        },
        d1Databases: {
          DB: "json-compatibility-deployment-mutation-runtime-test",
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
