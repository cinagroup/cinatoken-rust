import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-invoker",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};
const COMPATIBILITY_DATE = "2026-08-04";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const ISSUER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const PERMIT_ISSUER = "cinatoken-json-compatibility-permit-issuer-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
const SECRET_BINDINGS = [
  "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
  "JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET",
  "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
  "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
];

describe("JSON compatibility private invoker Wrangler config", () => {
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
        `cinatoken-container-runtime-json-compatibility-invoker-${environment}`;

      expect(commonTopLevelKeys(config)).toEqual([
        "$schema",
        "compatibility_date",
        "durable_objects",
        "main",
        "migrations",
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
      expectOptionalNodeCompatibility(config);
      expect(config.services).toEqual([
        {
          binding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
          service: ISSUER_SERVICE,
          entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
        },
        {
          binding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
          service: EXECUTOR_SERVICE,
          entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
        },
      ]);
      expect(config.durable_objects).toEqual({
        bindings: [
          {
            name: "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
            class_name: "JsonCompatibilityInvocationAuthority",
          },
        ],
      });
      expect(config.migrations).toEqual([
        {
          tag: "v1",
          new_sqlite_classes: ["JsonCompatibilityInvocationAuthority"],
        },
      ]);
      expect(config.vars).toEqual({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_INVOKER_ENABLED: "false",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER: INVOKER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE: ISSUER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID: "",
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
        JSON_COMPATIBILITY_PERMIT_AUDIENCE: EXECUTOR_SERVICE,
        JSON_COMPATIBILITY_PERMIT_KEY_ID: "",
        JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: "",
      });
      for (const binding of SECRET_BINDINGS) {
        expect(config.vars).not.toHaveProperty(binding);
      }
    });
  }
});

async function trackedConfig(environment) {
  const filename = CONFIG_FILES[environment];
  return JSON.parse(await readFile(path.join(SERVICE_DIR, filename), "utf8"));
}

function commonTopLevelKeys(config) {
  return Object.keys(config)
    .filter((key) => key !== "compatibility_flags")
    .sort();
}

function expectOptionalNodeCompatibility(config) {
  if ("compatibility_flags" in config) {
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
  }
}
