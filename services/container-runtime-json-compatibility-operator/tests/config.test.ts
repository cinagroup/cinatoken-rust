import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("private operator Worker configuration", () => {
  test.each([
    ["local", "../wrangler.jsonc", "local"],
    ["staging", "../wrangler.staging.jsonc", "staging"],
  ])("keeps the %s deployment private and default-off", (_, path, environment) => {
    const config = readJson(path);
    expect(config.main).toBe("src/index.ts");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("route");
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("compatibility_flags");
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1 });
    expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(config.services).toEqual([{
      binding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
      service: "cinatoken-container-runtime-json-compatibility-invoker-staging",
      entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
    }]);
    const vars = config.vars as Record<string, unknown>;
    expect(vars.ENVIRONMENT).toBe(environment);
    expect(vars.JSON_COMPATIBILITY_OPERATOR_ENABLED).toBe("false");
    expect(vars.JSON_COMPATIBILITY_OPERATOR_ISSUER).toBe(
      "cinatoken-json-compatibility-campaign-operator-staging",
    );
    expect(vars.JSON_COMPATIBILITY_OPERATOR_AUDIENCE).toBe(
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    );
    expect(vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER).toBe(
      "cinatoken-json-compatibility-campaign-approval-authority-staging",
    );
    expect(vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE).toBe(
      "cinatoken-container-runtime-json-compatibility-operator-staging",
    );
    expect(vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID).toBe("");
    expect(
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256,
    ).toBe("");
    expect(vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID).toBe("");
    expect(
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256,
    ).toBe("");
    expect(vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_KID).toBe("");
    expect(
      vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    ).toBe("");
    expect(vars.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID).toBe("");
    expect(Object.keys(vars).filter((key) => key.endsWith("_SECRET")))
      .toEqual([]);
  });

  test("has no production config, public fetch handler, or extra entrypoint", () => {
    const files = readdirSync(new URL("..", import.meta.url));
    expect(files.filter((name) => name.includes("production"))).toEqual([]);
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/JsonCompatibilityCampaignOperatorEntrypoint/u);
    expect(source).toMatch(/extends WorkerEntrypoint/u);
    expect(source).toMatch(/async invokePhase\(/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
