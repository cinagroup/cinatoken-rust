import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    sequence: { concurrent: false },
    testTimeout: 30_000,
  },
});
