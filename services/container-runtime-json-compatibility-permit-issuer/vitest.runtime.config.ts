import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY: {
            className: "JsonCompatibilityPermitIssuanceAuthority",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.runtime.test.ts"],
    testTimeout: 30_000,
  },
});
