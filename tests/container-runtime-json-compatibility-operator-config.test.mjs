import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-operator",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};
const COMPATIBILITY_DATE = "2026-08-04";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";

describe("JSON compatibility private operator Wrangler config", () => {
  test("keeps exactly local and staging configs and omits production", async () => {
    const filenames = (await readdir(SERVICE_DIR))
      .filter((name) => /^wrangler(?:\.[^.]+)?\.(?:jsonc|json|toml)$/.test(name))
      .sort();

    expect(filenames).toEqual(Object.values(CONFIG_FILES).sort());
  });

  for (const environment of Object.keys(CONFIG_FILES)) {
    test(`${environment} is private, disabled, and RPC-only`, async () => {
      const config = await trackedConfig(environment);
      const workerName =
        `cinatoken-container-runtime-json-compatibility-operator-${environment}`;

      expect(Object.keys(config).sort()).toEqual([
        "$schema",
        "compatibility_date",
        "main",
        "name",
        "observability",
        "preview_urls",
        "services",
        "vars",
        "version_metadata",
        "workers_dev",
      ]);
      expect(config).toMatchObject({
        name: workerName,
        main: "src/index.ts",
        compatibility_date: COMPATIBILITY_DATE,
        workers_dev: false,
        preview_urls: false,
        observability: { enabled: true, head_sampling_rate: 1 },
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });
      expect(config.services).toEqual([{
        binding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
        service: INVOKER_SERVICE,
        entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
      }]);
      expect(config.vars).toEqual({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_OPERATOR_ENABLED: "false",
        JSON_COMPATIBILITY_OPERATOR_ISSUER: OPERATOR_ISSUER,
        JSON_COMPATIBILITY_OPERATOR_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: "",
        JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID: "",
      });
      expect(config.vars).not.toHaveProperty(
        "JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET",
      );
    });
  }
});

async function trackedConfig(environment) {
  const filename = CONFIG_FILES[environment];
  return JSON.parse(await readFile(path.join(SERVICE_DIR, filename), "utf8"));
}
