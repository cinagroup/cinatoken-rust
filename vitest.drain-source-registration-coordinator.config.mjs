import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const coordinatorCurrentSecret =
  "registration-coordinator-service-runtime-secret-v1";
const moduleRules = [
  {
    type: "ESModule",
    include: ["**/*.js", "**/*.mjs"],
    fallthrough: true,
  },
  {
    type: "CompiledWasm",
    include: ["**/*.wasm"],
    fallthrough: true,
  },
];

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/drain-source-registration-coordinator-service-caller.mjs",
      miniflare: {
        compatibilityDate: "2026-07-15",
        modulesRules: moduleRules,
        serviceBindings: {
          DRAIN_SOURCE_REGISTRATION_COORDINATOR:
            "drain-source-registration-coordinator-runtime",
        },
        workers: [
          {
            name: "drain-source-registration-coordinator-runtime",
            scriptPath:
              "./services/drain-source-registration-coordinator/src/index.mjs",
            modules: true,
            modulesRules: moduleRules,
            compatibilityDate: "2026-07-15",
            bindings: {
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT: "local",
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENABLED: "true",
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER:
                "cinatoken-application-service-runtime-test",
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE:
                "drain-source-registration-coordinator-service-runtime-test",
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256:
                "8a".repeat(32),
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID:
                "registration-coordinator-service-runtime-v1",
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET:
                coordinatorCurrentSecret,
              DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_KID: "",
            },
            durableObjects: {
              DRAIN_SOURCE_REGISTRATION_COORDINATORS: {
                className: "DrainSourceRegistrationCoordinator",
                useSQLite: true,
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: [
      "tests/drain-source-registration-coordinator-worker-runtime.test.mjs",
    ],
  },
});
