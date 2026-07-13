import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const compiledWasmModules = [
  {
    type: "CompiledWasm",
    include: ["**/*.wasm"],
    fallthrough: true,
  },
];
const d1Migrations = await readD1Migrations("./migrations/d1");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./crates/worker/build/index.js",
      miniflare: {
        compatibilityDate: "2026-06-24",
        compatibilityFlags: ["nodejs_compat"],
        modulesRules: compiledWasmModules,
        bindings: {
          ENVIRONMENT: "test",
          SESSION_SECRET: "playground-runtime-session-secret-0123456789",
          RELAY_RATE_LIMIT_BACKEND: "disabled",
          RELAY_READ_CACHE_TTL_SECONDS: "0",
          TEST_D1_MIGRATIONS: d1Migrations,
        },
        d1Databases: { DB: "playground-runtime-test" },
        outboundService: "playground-provider-mock",
        workers: [
          {
            name: "playground-provider-mock",
            scriptPath: "./tests/fixtures/playground-provider-mock.mjs",
            modules: true,
            compatibilityDate: "2026-06-24",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/playground-runtime.test.mjs"],
  },
});
