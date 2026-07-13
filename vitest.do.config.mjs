import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const authoritySecret = "0123456789abcdef0123456789abcdef";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/do-runtime-worker.mjs",
      miniflare: {
        compatibilityDate: "2026-07-13",
        compatibilityFlags: ["nodejs_compat"],
        modulesRules: [
          {
            type: "CompiledWasm",
            include: ["**/*.wasm"],
            fallthrough: true,
          },
        ],
        bindings: {
          WFP_RELAY_AUTHORITY_SECRET: authoritySecret,
          TASK_RUNNER_DO_ENABLED: "false",
        },
        durableObjects: {
          WFP_AUTHORITY_REPLAY: "WfpAuthorityReplay",
          TASK_RUNNER: "TaskRunner",
        },
      },
    }),
  ],
  test: {
    include: ["tests/do-lifecycle-runtime.test.mjs"],
  },
});
