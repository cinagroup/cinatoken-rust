import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";
import {
  runJsonCompatibilityCampaignPlanner,
} from "../tools/plan_container_runtime_json_compatibility_campaign.mjs";
import {
  validateControllerConfig,
} from "../tools/preflight_container_controller_deploy.mjs";

const trackedConfigPath = path.resolve(
  "services/container-controller/wrangler.staging.jsonc",
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-campaign-config-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("JSON compatibility Controller campaign config", () => {
  test("creates a campaign config that changes only the isolated probe gate", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "campaign.jsonc");
    const result = await prepareJsonCompatibilityControllerConfig({
      basePath: trackedConfigPath,
      outPath: output,
    });
    const base = JSON.parse(await readFile(trackedConfigPath, "utf8"));
    const campaign = JSON.parse(await readFile(output, "utf8"));
    expect(campaign).toEqual({
      ...base,
      vars: {
        ...base.vars,
        CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED: "true",
      },
    });
    expect(
      validateControllerConfig(campaign, "staging", {
        jsonCompatibilityCampaign: true,
      }),
    ).toMatchObject({
      jsonCompatibilityCampaign: true,
      jsonCompatibilityProbeEnabled: true,
    });
    expect(result).toMatchObject({
      ok: true,
      changedVars: ["CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED"],
      credentialsRead: false,
      networkRequestsPerformed: false,
      deploymentMutationPerformed: false,
    });
  });

  test("rejects an unsafe base before writing output", async () => {
    const directory = await temporaryDirectory();
    const base = JSON.parse(await readFile(trackedConfigPath, "utf8"));
    base.vars.CONTAINER_EXECUTION_ENABLED = "true";
    const basePath = path.join(directory, "unsafe.jsonc");
    const output = path.join(directory, "campaign.jsonc");
    await writeFile(basePath, JSON.stringify(base), "utf8");

    await expect(
      prepareJsonCompatibilityControllerConfig({ basePath, outPath: output }),
    ).rejects.toThrow(/CONTAINER_EXECUTION_ENABLED/);
    expect(await Bun.file(output).exists()).toBe(false);
  });

  test("never overwrites an existing output", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "campaign.jsonc");
    await writeFile(output, "preserve", "utf8");
    await expect(
      prepareJsonCompatibilityControllerConfig({
        basePath: trackedConfigPath,
        outPath: output,
      }),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("preserve");
  });

  test("writes an approved plan only through a create-only output", async () => {
    const directory = await temporaryDirectory();
    const campaignConfig = path.join(directory, "campaign.jsonc");
    const planPath = path.join(directory, "plan.json");
    await prepareJsonCompatibilityControllerConfig({
      basePath: trackedConfigPath,
      outPath: campaignConfig,
    });
    const options = {
      selfTest: false,
      configPath: campaignConfig,
      outPath: planPath,
      campaignIdSha256: "11".repeat(32),
      controllerVersionId: "controller-version-plan-output-001",
      runnerVersionId: "runner-version-plan-output-001",
      runnerConfigSha256: "aa".repeat(32),
      operatorVersionId: "operator-version-plan-output-001",
      operatorConfigSha256: "66".repeat(32),
      operatorApprovalKeyId: "operator-approval-plan-output-001",
      operatorApprovalSpkiSha256: "bb".repeat(32),
      invokerVersionId: "invoker-version-plan-output-001",
      invokerConfigSha256: "77".repeat(32),
      permitIssuerVersionId: "permit-issuer-version-plan-output-001",
      permitIssuerConfigSha256: "88".repeat(32),
      executorVersionId: "executor-version-plan-output-001",
      executorConfigSha256: "99".repeat(32),
      runtimeNBuildIdSha256: "22".repeat(32),
      runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
      runtimeNMinusOneBuildIdSha256: "44".repeat(32),
      runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
      candidateShardIndex: 3,
    };
    const plan = await runJsonCompatibilityCampaignPlanner(options);

    expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual(plan);
    await expect(runJsonCompatibilityCampaignPlanner(options)).rejects.toThrow();
  });
});
