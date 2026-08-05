import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

const operatorWorkerName = "json-compatibility-operator-mock-runtime";
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
          JSON_COMPATIBILITY_RUNNER_ENABLED: "true",
          JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: "true",
          JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID:
            "operator-version-001",
        },
        versionMetadata: "CF_VERSION_METADATA",
        serviceBindings: {
          JSON_COMPATIBILITY_OPERATOR_SERVICE: {
            name: operatorWorkerName,
            entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
          },
          JSON_COMPATIBILITY_OPERATOR_MOCK_CONTROL: {
            name: operatorWorkerName,
            entrypoint: "JsonCompatibilityOperatorMockControlEntrypoint",
          },
          JSON_COMPATIBILITY_RUNNER_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
          },
          JSON_COMPATIBILITY_RUNNER_DEFAULT: kCurrentWorker,
        },
        workers: [
          {
            name: operatorWorkerName,
            scriptPath: "./tests/fixtures/operator-rpc-mock.mjs",
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
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
