import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";
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

});
