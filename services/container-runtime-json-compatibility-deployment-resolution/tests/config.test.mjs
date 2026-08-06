import { readFile, readdir } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const serviceName =
  "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging";
const readerBinding = {
  binding: "JSON_COMPATIBILITY_DEPLOYMENT_READBACK",
  service:
    "cinatoken-container-runtime-json-compatibility-deployment-readback-staging",
  entrypoint: "JsonCompatibilityDeploymentReadbackEntrypoint",
};

async function readText(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

describe("private deployment resolution Worker shell", () => {
  test.each([
    [
      "local",
      "cinatoken-container-runtime-json-compatibility-deployment-resolution-local",
      "cinatoken-json-compatibility-deployment-transition-local",
    ],
    [
      "staging",
      serviceName,
      "cinatoken-json-compatibility-deployment-transition-staging",
    ],
  ])(
    "keeps the %s profile private, observable, and disabled",
    async (environment, workerName, databaseName) => {
      const source = await readText(`../wrangler.${environment}.jsonc`);
      const config = JSON.parse(source);

      expect(config).toMatchObject({
        name: workerName,
        main: "src/index.ts",
        compatibility_date: "2026-08-06",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: false,
        preview_urls: false,
        observability: {
          enabled: true,
          head_sampling_rate: 1,
        },
        version_metadata: {
          binding: "CF_VERSION_METADATA",
        },
      });
      expect(config).not.toHaveProperty("route");
      expect(config).not.toHaveProperty("routes");
      expect(config.services).toEqual([readerBinding]);
      expect(config.d1_databases).toEqual([
        {
          binding: "DB",
          database_name: databaseName,
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir:
            "../container-runtime-json-compatibility-deployment-transition/migrations",
        },
      ]);
      expect(config.vars).toMatchObject({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENABLED: "false",
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_EXECUTION_ENABLED: "false",
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_READ_ENABLED: "false",
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_PROFILE_VERSION: "1",
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SERVICE_NAME: serviceName,
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENTRYPOINT:
          "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
        JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256:
          "84e0c0eafaa95a34c293f278ac52e45ce537bab5e752a00e6959a13ae103b65a",
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME:
          readerBinding.service,
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT:
          readerBinding.entrypoint,
      });
      expect(Object.keys(config.vars).filter((key) =>
        /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL)/u.test(key))).toEqual([]);
      expect(config.vars).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
      expect(source).not.toMatch(/JSON_COMPATIBILITY_DEPLOYMENT_MUTATION/u);
      expect(source).not.toMatch(/JSON_COMPATIBILITY_SOURCE_VERIFIER/u);
      expect(source).not.toMatch(/CLOUDFLARE_API_TOKEN/u);
    },
  );

  test("exports only the two named resolution RPC methods", async () => {
    const source = await readText("../src/index.ts");

    expect(source).toContain(
      "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
    );
    expect(source).toContain("resolveDeploymentTransitionInflight");
    expect(source).toContain("getDeploymentTransitionResolutionStatus");
    expect(source).toContain("type DeploymentTransitionResolutionEnv");
    expect(source).toContain("type ReceiptV1");
    expect(source).toContain("type StatusV1");
    expect(source).toMatch(
      /JsonCompatibilityDeploymentTransitionResolutionDefaultEntrypoint[\s\S]*WorkerEntrypoint<DeploymentTransitionResolutionEnv> \{\}/u,
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/mutation|sourceVerifier/iu);
  });

  test("ships no production profile and exposes a complete local gate", async () => {
    const files = await readdir(new URL("..", import.meta.url));
    const packageJson = await readJson("../package.json");
    const runtimeConfig = await readText("../vitest.runtime.config.ts");

    expect(files.filter((name) => name.includes("production"))).toEqual([]);
    expect(runtimeConfig).toContain('compatibilityDate: "2026-07-15"');
    expect(runtimeConfig).toContain("workerd 1.20260708.1");
    expect(packageJson.scripts.check).toContain("types:check");
    expect(packageJson.scripts.check).toContain("typecheck");
    expect(packageJson.scripts.check).toContain("test");
    expect(packageJson.scripts.check).toContain("dry-run");
  });
});
