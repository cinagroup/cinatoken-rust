import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

import {
  createAuthorizedTransitionFixture,
} from "../../tests/fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

const d1Migrations = await readD1Migrations("./migrations");
const invocation = await createAuthorizedTransitionFixture({
  operationSeed: "deployment-transition-workerd-operation",
});
const mockWorkerName = "json-compatibility-deployment-transition-rpc-mock";
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
          TEST_D1_MIGRATIONS: d1Migrations,
          TEST_TRANSITION_INVOCATION: JSON.stringify(invocation),
          CF_VERSION_METADATA: {
            id: "deployment-transition-runtime-version-001",
            tag: "runtime-test",
            timestamp: "2026-08-05T00:00:00.000Z",
          },
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_READ_ENABLED: "true",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_PROFILE_VERSION: "1",
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-transition-staging",
          JSON_COMPATIBILITY_DEPLOYMENT_LEAF_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-deployment-leaf-staging",
          JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME:
            "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
        },
        d1Databases: {
          DB: "json-compatibility-deployment-transition-runtime-test",
        },
        serviceBindings: {
          JSON_COMPATIBILITY_DEPLOYMENT_LEAF: {
            name: mockWorkerName,
            entrypoint: "JsonCompatibilityDeploymentLeafEntrypoint",
          },
          JSON_COMPATIBILITY_SOURCE_VERIFIER: {
            name: mockWorkerName,
            entrypoint: "JsonCompatibilitySourceVerifierEntrypoint",
          },
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_NAMED: {
            name: kCurrentWorker,
            entrypoint: "JsonCompatibilityDeploymentTransitionEntrypoint",
          },
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_MOCK_CONTROL: {
            name: mockWorkerName,
            entrypoint:
              "JsonCompatibilityDeploymentTransitionMockControlEntrypoint",
          },
        },
        workers: [
          {
            name: mockWorkerName,
            scriptPath: "./tests/fixtures/deployment-rpc-mock.mjs",
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
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
