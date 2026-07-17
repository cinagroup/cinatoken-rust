import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const compiledWasmModules = [
  {
    type: "CompiledWasm",
    include: ["**/*.wasm"],
    fallthrough: true,
  },
];
const auxiliaryModuleRules = [
  {
    type: "ESModule",
    include: ["**/*.js", "**/*.mjs"],
    fallthrough: true,
  },
  ...compiledWasmModules,
];

function brokerWorker(name, bindings) {
  return {
    name,
    scriptPath: "./crates/container-egress/build/index.js",
    modules: true,
    modulesRules: auxiliaryModuleRules,
    compatibilityDate: "2026-07-15",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
  };
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/container-egress-readiness-harness.mjs",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          BROKER_READY: "container-egress-ready",
          BROKER_DISABLED: "container-egress-disabled",
          BROKER_MISSING_MODEL: "container-egress-missing-model",
          BROKER_MISSING_SECRET: "container-egress-missing-secret",
        },
        workers: [
          brokerWorker("container-egress-ready", {
            CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED: "true",
            CINATOKEN_CONTAINER_PROVIDER_MODEL: "canary-runtime-model",
            CINATOKEN_CONTAINER_PROVIDER_API_KEY: "runtime-provider-secret",
          }),
          brokerWorker("container-egress-disabled", {
            CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED: "false",
            CINATOKEN_CONTAINER_PROVIDER_MODEL: "canary-runtime-model",
            CINATOKEN_CONTAINER_PROVIDER_API_KEY: "runtime-provider-secret",
          }),
          brokerWorker("container-egress-missing-model", {
            CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED: "true",
            CINATOKEN_CONTAINER_PROVIDER_MODEL: "",
            CINATOKEN_CONTAINER_PROVIDER_API_KEY: "runtime-provider-secret",
          }),
          brokerWorker("container-egress-missing-secret", {
            CINATOKEN_CONTAINER_PROVIDER_EGRESS_ENABLED: "true",
            CINATOKEN_CONTAINER_PROVIDER_MODEL: "canary-runtime-model",
          }),
        ],
      },
    }),
  ],
  test: {
    include: ["tests/container-egress-runtime.test.ts"],
  },
});
