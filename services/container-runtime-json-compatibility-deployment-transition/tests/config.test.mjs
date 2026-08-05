import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

describe("private deployment transition Worker configuration", () => {
  test.each([
    ["local", "../wrangler.local.jsonc", "local"],
    ["staging", "../wrangler.staging.jsonc", "staging"],
  ])("keeps %s private, default-off, and credential-free", (_, path, environment) => {
    const config = readJson(path);
    expect(config.main).toBe("src/index.ts");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config).not.toHaveProperty("route");
    expect(config).not.toHaveProperty("routes");
    expect(config.services).toEqual([
      {
        binding: "JSON_COMPATIBILITY_DEPLOYMENT_LEAF",
        service:
          "cinatoken-container-runtime-json-compatibility-deployment-leaf-staging",
        entrypoint: "JsonCompatibilityDeploymentLeafEntrypoint",
      },
      {
        binding: "JSON_COMPATIBILITY_SOURCE_VERIFIER",
        service:
          "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
        entrypoint: "JsonCompatibilitySourceVerifierEntrypoint",
      },
    ]);
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "migrations",
    });
    expect(config.vars).toMatchObject({
      ENVIRONMENT: environment,
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_ENABLED: "false",
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_EXECUTION_ENABLED: "false",
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_STATUS_READ_ENABLED: "false",
      JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_PROFILE_VERSION: "1",
    });
    expect(Object.keys(config.vars).filter((key) =>
      /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL)/u.test(key))).toEqual([]);
  });

  test("exports mutation capability only from the named RPC entrypoint", () => {
    const files = readdirSync(new URL("..", import.meta.url));
    expect(files.filter((name) => name.includes("production"))).toEqual([]);
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/JsonCompatibilityDeploymentTransitionEntrypoint/u);
    expect(source).toMatch(/JsonCompatibilityDeploymentTransitionDefaultEntrypoint/u);
    expect(source).toMatch(/async executeTransition\(/u);
    expect(source).toMatch(/async getTransitionStatus\(/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });

  test("makes every D1 journal table append-only", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0001_json_compatibility_deployment_transition.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const table of ["operation", "event", "receipt"]) {
      expect(migration).toContain(
        `json_compatibility_deployment_transition_${table}_update_guard`,
      );
      expect(migration).toContain(
        `json_compatibility_deployment_transition_${table}_delete_guard`,
      );
    }
    expect(migration).toContain(
      "json_compatibility_deployment_transition_event_terminal_guard",
    );
    expect(migration).toContain(
      "json_compatibility_deployment_transition_receipt_source_guard",
    );
  });
});
