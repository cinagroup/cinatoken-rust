import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const d1Migrations = await readD1Migrations("./migrations/d1");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/fixtures/container-terminal-ack-mock.mjs",
      miniflare: {
        compatibilityDate: "2026-07-13",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
        },
        d1Databases: {
          DB: "relay-container-atomic-admission-runtime-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/relay-container-atomic-admission-runtime.test.mjs"],
  },
});
