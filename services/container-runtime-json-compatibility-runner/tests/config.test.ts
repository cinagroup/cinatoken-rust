import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("private Runner Worker configuration", () => {
  test.each([
    ["local", "../wrangler.jsonc", "local"],
    ["staging", "../wrangler.staging.jsonc", "staging"],
  ])("keeps %s private, default-off, and bound to the named Operator", (_, path, environment) => {
    const config = readJson(path);
    expect(config.main).toBe("src/index.ts");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("route");
    expect(config).not.toHaveProperty("routes");
    expect(config.services).toEqual([{
      binding: "JSON_COMPATIBILITY_OPERATOR_SERVICE",
      service: "cinatoken-container-runtime-json-compatibility-operator-staging",
      entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
    }]);
    const vars = config.vars as Record<string, unknown>;
    expect(vars).toEqual({
      ENVIRONMENT: environment,
      JSON_COMPATIBILITY_RUNNER_ENABLED: "false",
      JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: "false",
      JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID: "",
    });
    expect(Object.keys(vars).filter((key) => key.endsWith("_SECRET")))
      .toEqual([]);
  });

  test("exports capability only from the named entrypoint", () => {
    const files = readdirSync(new URL("..", import.meta.url));
    expect(files.filter((name) => name.includes("production"))).toEqual([]);
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/JsonCompatibilityCampaignRunnerEntrypoint/u);
    expect(source).toMatch(/JsonCompatibilityRunnerDefaultEntrypoint/u);
    expect(source).toMatch(/async invokePhase\(/u);
    expect(source).toMatch(/async getPhaseStatus\(/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
