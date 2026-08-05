import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseJsonCompatibilityCallerConfigArgs,
  prepareJsonCompatibilityCallerConfig,
  validateJsonCompatibilityCallerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_caller_config.mjs";

const RUNNER_VERSION_ID = "runner-version-2026-08-05";
const RUNNER_CONFIG_SHA256 = "a1".repeat(32);

function darkBaseConfig() {
  return {
    name: "cinatoken-container-runtime-json-compatibility-caller-staging",
    main: "src/index.ts",
    compatibility_date: "2026-08-05",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true, head_sampling_rate: 1 },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    services: [{
      binding: "JSON_COMPATIBILITY_RUNNER_SERVICE",
      service:
        "cinatoken-container-runtime-json-compatibility-runner-staging",
      entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
    }],
    vars: {
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_CALLER_ENABLED: "false",
      JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED: "false",
      JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID: "",
      JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256: "",
    },
  };
}

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(
    os.tmpdir(),
    "cinatoken-caller-config-",
  ));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeBase(directory) {
  const basePath = path.join(directory, "wrangler.staging.jsonc");
  await writeFile(basePath, JSON.stringify(darkBaseConfig()), "utf8");
  return basePath;
}

describe("JSON compatibility private Caller config preparer", () => {
  for (const profile of [
    {
      deploymentState: "dark",
      executionGateEnabled: false,
      statusGateEnabled: false,
      runnerIdentityPinned: false,
    },
    {
      deploymentState: "status-only",
      executionGateEnabled: false,
      statusGateEnabled: true,
      runnerIdentityPinned: true,
    },
    {
      deploymentState: "execution",
      executionGateEnabled: true,
      statusGateEnabled: true,
      runnerIdentityPinned: true,
    },
  ]) {
    test(`creates the ${profile.deploymentState} state with exact gates`, async () => {
      await withTemporaryDirectory(async (directory) => {
        const basePath = await writeBase(directory);
        const outPath = path.join(directory, "campaign.jsonc");
        const args = [
          "--base", basePath,
          "--out", outPath,
          "--deployment-state", profile.deploymentState,
        ];
        if (profile.runnerIdentityPinned) {
          args.push(
            "--runner-version-id", RUNNER_VERSION_ID,
            "--runner-config-sha256", RUNNER_CONFIG_SHA256,
          );
        }
        const options = parseJsonCompatibilityCallerConfigArgs(args);
        const result = await prepareJsonCompatibilityCallerConfig(options);
        const source = await readFile(outPath, "utf8");
        const config = JSON.parse(source);

        expect(validateJsonCompatibilityCallerConfig(config, options))
          .toMatchObject({
            deploymentState: profile.deploymentState,
            executionEnabled: profile.executionGateEnabled,
            statusReadEnabled: profile.statusGateEnabled,
            privateServiceBinding: true,
            runnerIdentityPinned: profile.runnerIdentityPinned,
          });
        expect(config.services).toEqual(darkBaseConfig().services);
        expect(config.vars).toEqual({
          ENVIRONMENT: "staging",
          JSON_COMPATIBILITY_CALLER_ENABLED:
            profile.executionGateEnabled ? "true" : "false",
          JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED:
            profile.statusGateEnabled ? "true" : "false",
          JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID:
            profile.runnerIdentityPinned ? RUNNER_VERSION_ID : "",
          JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256:
            profile.runnerIdentityPinned ? RUNNER_CONFIG_SHA256 : "",
        });
        expect(result).toMatchObject({
          ok: true,
          mode: "offline-private-caller-campaign-config-preparation",
          deploymentState: profile.deploymentState,
          executionEnabled: profile.executionGateEnabled,
          statusReadEnabled: profile.statusGateEnabled,
          runnerIdentityPinned: profile.runnerIdentityPinned,
          secretsRequired: [],
          credentialsRead: false,
          networkRequestsPerformed: false,
          deploymentMutationPerformed: false,
        });
        expect(source).not.toContain("SECRET");
      });
    });
  }

  test("defaults to execution and requires both Runner identity pins", () => {
    expect(() => parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
    ])).toThrow(
      "--runner-version-id is required when --deployment-state is execution",
    );
    expect(() => parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
      "--runner-version-id", RUNNER_VERSION_ID,
    ])).toThrow(
      "--runner-config-sha256 is required when --deployment-state is execution",
    );
    expect(parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
      "--runner-version-id", RUNNER_VERSION_ID,
      "--runner-config-sha256", RUNNER_CONFIG_SHA256,
    ])).toMatchObject({
      deploymentState: "execution",
      runnerVersionId: RUNNER_VERSION_ID,
      runnerConfigSha256: RUNNER_CONFIG_SHA256,
    });
  });

  test("forbids either Runner identity pin in dark state", () => {
    for (const identityArgs of [
      ["--runner-version-id", RUNNER_VERSION_ID],
      ["--runner-config-sha256", RUNNER_CONFIG_SHA256],
      [
        "--runner-version-id", RUNNER_VERSION_ID,
        "--runner-config-sha256", RUNNER_CONFIG_SHA256,
      ],
    ]) {
      expect(() => parseJsonCompatibilityCallerConfigArgs([
        "--out", "caller.jsonc",
        "--deployment-state", "dark",
        ...identityArgs,
      ])).toThrow(
        "Runner identity flags are not allowed when --deployment-state is dark",
      );
    }
  });

  test("rejects invalid state, version, digest, binding, and extra vars", () => {
    expect(() => parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
      "--deployment-state", "status",
    ])).toThrow(
      "--deployment-state must be one of: dark, status-only, execution",
    );
    expect(() => parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
      "--runner-version-id", "bad version",
      "--runner-config-sha256", RUNNER_CONFIG_SHA256,
    ])).toThrow("--runner-version-id must be a safe token");
    expect(() => parseJsonCompatibilityCallerConfigArgs([
      "--out", "caller.jsonc",
      "--runner-version-id", RUNNER_VERSION_ID,
      "--runner-config-sha256", "AA".repeat(32),
    ])).toThrow(
      "--runner-config-sha256 must be a lowercase SHA-256 digest",
    );

    const wrongBinding = darkBaseConfig();
    wrongBinding.services[0].entrypoint = "DefaultEntrypoint";
    expect(() => validateJsonCompatibilityCallerConfig(wrongBinding))
      .toThrow("caller Runner binding does not match");
    const extraVar = darkBaseConfig();
    extraVar.vars.CALLER_SECRET = "must-never-be-accepted";
    expect(() => validateJsonCompatibilityCallerConfig(extraVar))
      .toThrow("caller vars does not match");
  });

  test("uses create-only output and leaves an existing file untouched", async () => {
    await withTemporaryDirectory(async (directory) => {
      const basePath = await writeBase(directory);
      const outPath = path.join(directory, "campaign.jsonc");
      await writeFile(outPath, "sentinel", "utf8");
      await expect(prepareJsonCompatibilityCallerConfig({
        basePath,
        outPath,
        deploymentState: "dark",
      })).rejects.toThrow();
      expect(await readFile(outPath, "utf8")).toBe("sentinel");
    });
  });

  test("reads the tracked staging TOML base without mutating it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const basePath = path.resolve(
        "services/container-runtime-json-compatibility-caller/wrangler.staging.toml",
      );
      const before = await readFile(basePath, "utf8");
      const outPath = path.join(directory, "campaign.jsonc");
      const result = await prepareJsonCompatibilityCallerConfig({
        basePath,
        outPath,
        deploymentState: "status-only",
        runnerVersionId: RUNNER_VERSION_ID,
        runnerConfigSha256: RUNNER_CONFIG_SHA256,
      });
      expect(result).toMatchObject({
        deploymentState: "status-only",
        executionEnabled: false,
        statusReadEnabled: true,
        runnerIdentityPinned: true,
      });
      expect(validateJsonCompatibilityCallerConfig(
        JSON.parse(await readFile(outPath, "utf8")),
        {
          deploymentState: "status-only",
          runnerVersionId: RUNNER_VERSION_ID,
          runnerConfigSha256: RUNNER_CONFIG_SHA256,
        },
      )).toMatchObject({ privateServiceBinding: true });
      expect(await readFile(basePath, "utf8")).toBe(before);
    });
  });

  test("never allows the output path to replace the base config", async () => {
    await withTemporaryDirectory(async (directory) => {
      const basePath = await writeBase(directory);
      await expect(prepareJsonCompatibilityCallerConfig({
        basePath,
        outPath: basePath,
        deploymentState: "dark",
      })).rejects.toThrow("--out must not replace the base config");
      expect(JSON.parse(await readFile(basePath, "utf8")))
        .toEqual(darkBaseConfig());
    });
  });

  test("documents all states and the no-secret create-only boundary", async () => {
    const child = Bun.spawn([
      "bun",
      "tools/prepare_container_runtime_json_compatibility_caller_config.mjs",
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
    expect(stdout).toContain("requires exact Runner version and config digest");
    expect(stdout).toContain("create-only output contains no secret material");
  });
});
