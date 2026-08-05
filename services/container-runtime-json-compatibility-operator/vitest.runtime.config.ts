import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const invokerWorkerName = "json-compatibility-invoker-mock-runtime";
const moduleRules = [
  {
    type: "ESModule" as const,
    include: ["**/*.js", "**/*.mjs"],
    fallthrough: true,
  },
];

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_OPERATOR_ENABLED: "true",
          JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED: "true",
          JSON_COMPATIBILITY_OPERATOR_ISSUER:
            "cinatoken-json-compatibility-campaign-operator-staging",
          JSON_COMPATIBILITY_OPERATOR_AUDIENCE:
            "cinatoken-container-runtime-json-compatibility-invoker-staging",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER:
            "cinatoken-json-compatibility-campaign-approval-authority-staging",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE:
            "cinatoken-container-runtime-json-compatibility-operator-staging",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID:
            "json-campaign-approval-2026-08",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256:
            "471850d2dcfe546734941e2d44fde594cb3e4445900da72536ac9683f6be5d10",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID: "",
          JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256: "",
          JSON_COMPATIBILITY_OPERATOR_CURRENT_KID:
            "json-campaign-operator-current-2026-08",
          JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
            "b1".repeat(32),
          JSON_COMPATIBILITY_OPERATOR_STATUS_ISSUER:
            "cinatoken-json-compatibility-campaign-operator-status-staging",
          JSON_COMPATIBILITY_OPERATOR_STATUS_AUDIENCE:
            "cinatoken-container-runtime-json-compatibility-invoker-staging",
          JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID:
            "json-campaign-status-operator-current-2026-08",
          JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256:
            "b3".repeat(32),
          JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID:
            "invoker-version-001",
          JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET:
            "json-compatibility-operator-secret-32-byte-minimum",
          JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_SECRET:
            "json-compatibility-status-operator-secret-minimum",
        },
        versionMetadata: "CF_VERSION_METADATA",
        serviceBindings: {
          JSON_COMPATIBILITY_INVOKER_SERVICE: {
            name: invokerWorkerName,
            entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
          },
          JSON_COMPATIBILITY_INVOKER_MOCK_CONTROL: {
            name: invokerWorkerName,
            entrypoint: "JsonCompatibilityInvokerMockControlEntrypoint",
          },
        },
        workers: [
          {
            name: invokerWorkerName,
            scriptPath: "./tests/fixtures/invoker-rpc-mock.mjs",
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
            compatibilityFlags: ["nodejs_compat"],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.runtime.test.ts"],
    testTimeout: 30_000,
  },
});
