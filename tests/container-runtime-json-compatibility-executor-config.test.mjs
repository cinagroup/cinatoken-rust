import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareJsonCompatibilityExecutorConfig,
  validateJsonCompatibilityExecutorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_executor_config.mjs";

const trackedConfigPath = path.resolve(
  "services/container-runtime-json-compatibility-executor/wrangler.staging.jsonc",
);
const temporaryDirectories = [];
const PERMIT_KEY_ID = "json-compatibility-campaign-2026-08";
const PERMIT_SPKI_SHA256 = "ab".repeat(32);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-executor-config-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("JSON compatibility executor campaign config", () => {
  test("creates a private campaign config that changes only the executor gate", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "campaign.jsonc");
    const result = await prepareJsonCompatibilityExecutorConfig({
      basePath: trackedConfigPath,
      outPath: output,
      permitKeyId: PERMIT_KEY_ID,
      permitSpkiSha256: PERMIT_SPKI_SHA256,
    });
    const base = JSON.parse(await readFile(trackedConfigPath, "utf8"));
    const campaign = JSON.parse(await readFile(output, "utf8"));

    expect(campaign).toEqual({
      ...base,
      vars: {
        ...base.vars,
        JSON_COMPATIBILITY_EXECUTOR_ENABLED: "true",
        JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
        JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
      },
    });
    expect(validateJsonCompatibilityExecutorConfig(campaign, {
      campaign: true,
      permitKeyId: PERMIT_KEY_ID,
      permitSpkiSha256: PERMIT_SPKI_SHA256,
    })).toMatchObject({
      environment: "staging",
      executorEnabled: true,
      privateServiceBinding: true,
      campaignScopedDurableObject: true,
      permitTrustPinned: true,
    });
    expect(result).toMatchObject({
      ok: true,
      changedVars: [
        "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
        "JSON_COMPATIBILITY_PERMIT_KEY_ID",
        "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
      ],
      permitPublicKeySecretRequired:
        "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
      credentialsRead: false,
      networkRequestsPerformed: false,
      deploymentMutationPerformed: false,
    });
  });

  test("rejects public or already-enabled base configs before writing", async () => {
    const directory = await temporaryDirectory();
    const base = JSON.parse(await readFile(trackedConfigPath, "utf8"));
    base.workers_dev = true;
    const basePath = path.join(directory, "unsafe.jsonc");
    const output = path.join(directory, "campaign.jsonc");
    await writeFile(basePath, JSON.stringify(base), "utf8");

    await expect(
      prepareJsonCompatibilityExecutorConfig({
        basePath,
        outPath: output,
        permitKeyId: PERMIT_KEY_ID,
        permitSpkiSha256: PERMIT_SPKI_SHA256,
      }),
    ).rejects.toThrow(/workers_dev/);
    expect(await Bun.file(output).exists()).toBe(false);
  });

  test("never overwrites an existing output", async () => {
    const directory = await temporaryDirectory();
    const output = path.join(directory, "campaign.jsonc");
    await writeFile(output, "preserve", "utf8");
    await expect(
      prepareJsonCompatibilityExecutorConfig({
        basePath: trackedConfigPath,
        outPath: output,
        permitKeyId: PERMIT_KEY_ID,
        permitSpkiSha256: PERMIT_SPKI_SHA256,
      }),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("preserve");
  });
});
