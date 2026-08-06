import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations(
  "../container-runtime-json-compatibility-deployment-transition/migrations",
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        // Pinned workerd 1.20260708.1 rejects newer compatibility dates.
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          CF_VERSION_METADATA: {
            id: "deployment-resolution-runtime-version-001",
            tag: "runtime-test",
            timestamp: "2026-08-06T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENABLED: "false",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_EXECUTION_ENABLED: "false",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_READ_ENABLED: "false",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_PROFILE_VERSION: "1",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENTRYPOINT:
            "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
          JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256:
            "84e0c0eafaa95a34c293f278ac52e45ce537bab5e752a00e6959a13ae103b65a",
          JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-readback-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT:
            "JsonCompatibilityDeploymentReadbackEntrypoint",
        },
        d1Databases: {
          DB: "json-compatibility-deployment-resolution-runtime-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.runtime.test.ts"],
    sequence: { concurrent: false },
    testTimeout: 30_000,
  },
});
