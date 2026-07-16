import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/container-controller-ledger-worker.ts",
      miniflare: {
        compatibilityDate: "2026-07-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CONTAINER_CONTROLLER_LEDGER: {
            className: "ContainerControllerLedgerTestObject",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["tests/container-controller-runtime.test.ts"],
  },
});
