import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-runner",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};

describe("JSON compatibility private Runner Wrangler config", () => {
  test("keeps exactly local and staging configs and omits production", async () => {
    const filenames = (await readdir(SERVICE_DIR))
      .filter((name) => /^wrangler(?:\.[^.]+)?\.(?:jsonc|json|toml)$/.test(name))
      .sort();
    expect(filenames).toEqual(Object.values(CONFIG_FILES).sort());
  });

  for (const environment of Object.keys(CONFIG_FILES)) {
    test(`${environment} is private, disabled, and named-entrypoint-only`, async () => {
      const config = JSON.parse(await readFile(
        path.join(SERVICE_DIR, CONFIG_FILES[environment]),
        "utf8",
      ));
      expect(Object.keys(config).sort()).toEqual([
        "$schema", "compatibility_date", "main", "name", "observability",
        "preview_urls", "services", "vars", "version_metadata", "workers_dev",
      ]);
      expect(config).toMatchObject({
        name: `cinatoken-container-runtime-json-compatibility-runner-${environment}`,
        main: "src/index.ts",
        compatibility_date: "2026-08-04",
        workers_dev: false,
        preview_urls: false,
        observability: { enabled: true, head_sampling_rate: 1 },
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });
      expect(config.services).toEqual([{
        binding: "JSON_COMPATIBILITY_OPERATOR_SERVICE",
        service:
          "cinatoken-container-runtime-json-compatibility-operator-staging",
        entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
      }]);
      expect(config.vars).toEqual({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_RUNNER_ENABLED: "false",
        JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: "false",
        JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID: "",
      });
      expect(Object.keys(config.vars).filter((key) => key.endsWith("_SECRET")))
        .toEqual([]);
    });
  }
});
