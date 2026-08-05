import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseJsonCompatibilityRunnerConfigArgs,
  prepareJsonCompatibilityRunnerConfig,
  validateJsonCompatibilityRunnerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_runner_config.mjs";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-runner",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};
const OPERATOR_VERSION_ID = "operator-version-2026-08-05";

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "cinatoken-runner-config-",
  ));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

  for (const profile of [
    {
      deploymentState: "dark",
      executionGateEnabled: false,
      statusGateEnabled: false,
      operatorVersionId: "",
    },
    {
      deploymentState: "status-only",
      executionGateEnabled: false,
      statusGateEnabled: true,
      operatorVersionId: OPERATOR_VERSION_ID,
    },
    {
      deploymentState: "execution",
      executionGateEnabled: true,
      statusGateEnabled: true,
      operatorVersionId: OPERATOR_VERSION_ID,
    },
  ]) {
    test(`prepares the ${profile.deploymentState} deployment state`, async () => {
      await withTemporaryDirectory(async (directory) => {
        const outPath = path.join(directory, "wrangler.jsonc");
        const args = [
          "--out", outPath,
          "--deployment-state", profile.deploymentState,
        ];
        if (profile.operatorVersionId !== "") {
          args.push("--operator-version-id", profile.operatorVersionId);
        }
        const options = parseJsonCompatibilityRunnerConfigArgs(args);
        const result = await prepareJsonCompatibilityRunnerConfig(options);
        const source = await readFile(outPath, "utf8");
        const config = JSON.parse(source);

        expect(validateJsonCompatibilityRunnerConfig(config, options))
          .toMatchObject({
            deploymentState: profile.deploymentState,
            executionEnabled: profile.executionGateEnabled,
            statusReadEnabled: profile.statusGateEnabled,
            privateServiceBinding: true,
          });
        expect(config.vars).toEqual({
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_RUNNER_ENABLED:
            profile.executionGateEnabled ? "true" : "false",
          JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED:
            profile.statusGateEnabled ? "true" : "false",
          JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID:
            profile.operatorVersionId,
        });
        expect(result).toMatchObject({
          ok: true,
          deploymentState: profile.deploymentState,
          executionEnabled: profile.executionGateEnabled,
          statusReadEnabled: profile.statusGateEnabled,
          changedVars: profile.deploymentState === "dark"
            ? []
            : profile.deploymentState === "status-only"
              ? [
                  "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
                  "JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID",
                ]
              : [
                  "JSON_COMPATIBILITY_RUNNER_ENABLED",
                  "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
                  "JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID",
                ],
          secretsRequired: [],
          credentialsRead: false,
          networkRequestsPerformed: false,
          deploymentMutationPerformed: false,
        });
        expect(source).not.toContain("SECRET");
      });
    });
  }

  test("defaults omitted deployment state to execution", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outPath = path.join(directory, "wrangler.jsonc");
      const parsed = parseJsonCompatibilityRunnerConfigArgs([
        "--out", outPath,
        "--operator-version-id", OPERATOR_VERSION_ID,
      ]);
      expect(parsed.deploymentState).toBe("execution");

      const result = await prepareJsonCompatibilityRunnerConfig({
        outPath,
        operatorVersionId: OPERATOR_VERSION_ID,
      });
      const config = JSON.parse(await readFile(outPath, "utf8"));
      expect(result).toMatchObject({
        deploymentState: "execution",
        executionEnabled: true,
        statusReadEnabled: true,
      });
      expect(config.vars.JSON_COMPATIBILITY_RUNNER_ENABLED).toBe("true");
      expect(config.vars.JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED)
        .toBe("true");
      expect(config.vars.JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID)
        .toBe(OPERATOR_VERSION_ID);
    });
  });

  test("rejects missing or forbidden Operator version flags", () => {
    for (const deploymentState of ["status-only", "execution"]) {
      expect(() => parseJsonCompatibilityRunnerConfigArgs([
        "--out", "runner.jsonc",
        "--deployment-state", deploymentState,
      ])).toThrow(
        `--operator-version-id is required when --deployment-state is ${deploymentState}`,
      );
    }
    expect(() => parseJsonCompatibilityRunnerConfigArgs([
      "--out", "runner.jsonc",
    ])).toThrow(
      "--operator-version-id is required when --deployment-state is execution",
    );
    expect(() => parseJsonCompatibilityRunnerConfigArgs([
      "--out", "runner.jsonc",
      "--deployment-state", "dark",
      "--operator-version-id", OPERATOR_VERSION_ID,
    ])).toThrow(
      "--operator-version-id is not allowed when --deployment-state is dark",
    );
  });

  test("rejects invalid deployment states", () => {
    expect(() => parseJsonCompatibilityRunnerConfigArgs([
      "--out", "runner.jsonc",
      "--deployment-state", "status",
    ])).toThrow(
      "--deployment-state must be one of: dark, status-only, execution",
    );
  });

  test("keeps Runner output create-only", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outPath = path.join(directory, "wrangler.jsonc");
      await writeFile(outPath, "sentinel", "utf8");
      await expect(prepareJsonCompatibilityRunnerConfig({
        outPath,
        deploymentState: "dark",
      })).rejects.toThrow();
      expect(await readFile(outPath, "utf8")).toBe("sentinel");
    });
  });

  test("documents all deployment state CLI contracts", async () => {
    const child = Bun.spawn([
      "bun",
      "tools/prepare_container_runtime_json_compatibility_runner_config.mjs",
      "--help",
    ], {
      cwd: path.resolve("."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--deployment-state <dark|status-only|execution>");
    expect(stdout).toContain("dark         Disable execution and status reads");
    expect(stdout).toContain("status-only  Enable status reads only");
    expect(stdout).toContain("execution    Enable execution and status reads");
  });
});
