import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("private executor Worker configuration", () => {
  test.each([
    ["base", "../wrangler.jsonc", "local"],
    ["staging", "../wrangler.staging.jsonc", "staging"],
  ])("keeps the %s deployment private and default-off", (_, path, environment) => {
    const config = readJson(path);
    expect(config.main).toBe("src/index.ts");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("route");
    expect(config).not.toHaveProperty("routes");
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1 });
    expect(config.services).toEqual([
      {
        binding: "CONTAINER_CONTROLLER_JSON_PROBE",
        service: "cinatoken-container-controller-staging",
        entrypoint: "JsonCompatibilityProbeEntrypoint",
      },
    ]);
    expect(config.durable_objects).toEqual({
      bindings: [{
        name: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        class_name: "JsonCompatibilityCampaignAuthority",
      }],
    });
    expect(config.migrations).toEqual([{
      tag: "v1",
      new_sqlite_classes: ["JsonCompatibilityCampaignAuthority"],
    }]);
    expect(config.vars).toEqual({
      ENVIRONMENT: environment,
      JSON_COMPATIBILITY_EXECUTOR_ENABLED: "false",
      JSON_COMPATIBILITY_PERMIT_ISSUER:
        "cinatoken-json-compatibility-permit-issuer-staging",
      JSON_COMPATIBILITY_PERMIT_AUDIENCE:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      JSON_COMPATIBILITY_PERMIT_KEY_ID: "",
      JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: "",
    });
  });

  test("exports only WorkerEntrypoint RPC and no public fetch handler", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/extends WorkerEntrypoint/);
    expect(source).toMatch(/async executePhase\(/);
    expect(source).toMatch(/JsonCompatibilityCampaignAuthority/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
