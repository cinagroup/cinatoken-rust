import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

const runnerWorkerName = "json-compatibility-runner-mock-runtime";
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
          JSON_COMPATIBILITY_CALLER_ENABLED: "true",
          JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED: "true",
          JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID: "runner-version-001",
          JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256: "c1".repeat(32),
        },
        versionMetadata: "CF_VERSION_METADATA",
        serviceBindings: {
          JSON_COMPATIBILITY_RUNNER_SERVICE: {
            name: runnerWorkerName,
            entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
          },
          JSON_COMPATIBILITY_RUNNER_MOCK_CONTROL: {
            name: runnerWorkerName,
            entrypoint: "JsonCompatibilityRunnerMockControlEntrypoint",
          },
          JSON_COMPATIBILITY_CALLER_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilityCampaignCallerEntrypoint",
          },
        },
        workers: [
          {
            name: runnerWorkerName,
            scriptPath: "./tests/fixtures/runner-rpc-mock.mjs",
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
