import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("private invoker Worker configuration", () => {
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
        binding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
        service:
          "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
        entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
      },
      {
        binding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
        service:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
      },
    ]);
    expect(config.durable_objects).toEqual({
      bindings: [{
        name: "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
        class_name: "JsonCompatibilityInvocationAuthority",
      }],
    });
    expect(config.migrations).toEqual([{
      tag: "v1",
      new_sqlite_classes: ["JsonCompatibilityInvocationAuthority"],
    }]);

    const vars = config.vars as Record<string, unknown>;
    expect(vars.ENVIRONMENT).toBe(environment);
    expect(vars.JSON_COMPATIBILITY_INVOKER_ENABLED).toBe("false");
    expect(vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID).toBe("");
    expect(
      vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    ).toBe("");
    expect(vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID).toBe("");
    expect(
      vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256,
    ).toBe("");
    expect(vars.JSON_COMPATIBILITY_PERMIT_KEY_ID).toBe("");
    expect(vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256).toBe("");
    expect(Object.keys(vars).filter((key) =>
      key.endsWith("_SECRET") || key.endsWith("_BASE64URL")
    )).toEqual([]);
  });

  test("exports one RPC Entrypoint and no public fetch handler", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/extends WorkerEntrypoint/);
    expect(source).toMatch(/async invokePhase\(/);
    expect(source).toMatch(/JsonCompatibilityInvocationAuthority/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
