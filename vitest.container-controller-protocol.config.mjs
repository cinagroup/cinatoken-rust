import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": "vitest",
    },
  },
  test: {
    environment: "node",
    include: ["services/container-controller/tests/protocol.test.ts"],
  },
});
