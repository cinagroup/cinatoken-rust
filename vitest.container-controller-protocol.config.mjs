import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": "vitest",
    },
  },
  test: {
    environment: "node",
    include: [
      "services/container-controller/tests/protocol.test.ts",
      "services/container-controller/tests/container_operation_telemetry.test.ts",
      "services/container-controller/tests/operation_outcome.test.ts",
      "services/container-controller/tests/storage_gateway.test.ts",
      "services/container-controller/tests/provider_attempt_gateway.test.ts",
      "services/container-controller/tests/provider_egress_gateway.test.ts",
      "services/container-controller/tests/provider_response_artifact_store.test.ts",
      "services/container-controller/tests/provider_response_v3.test.ts",
    ],
  },
});
