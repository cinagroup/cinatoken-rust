import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const baseline = await readD1Migrations(
  "./tests/workerd-send-migrations",
);
const authorityMigrations = await readD1Migrations("./migrations");
const sendAttemptMigration = authorityMigrations.find(
  (migration) =>
    migration.name === "0005_operation_five_send_attempts.sql",
);
const gatewayEventMigration = authorityMigrations.find(
  (migration) =>
    migration.name === "0006_operation_five_gateway_events.sql",
);
if (
  sendAttemptMigration === undefined
  || gatewayEventMigration === undefined
) {
  throw new Error("operation-5 send/gateway migrations are missing");
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-07-15",
        bindings: {
          TEST_D1_MIGRATIONS: [
            ...baseline,
            sendAttemptMigration,
            gatewayEventMigration,
          ],
        },
        d1Databases: {
          DB: "operation-five-send-attempt-runtime-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/operation5_send_attempt_runtime.test.ts"],
    testTimeout: 30_000,
  },
});
