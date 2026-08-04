#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  parseStrictJsonObject,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  DeployPreflightError,
  validateControllerConfig,
} from "./preflight_container_controller_deploy.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBasePath = path.join(
  repoRoot,
  "services",
  "container-controller",
  "wrangler.staging.jsonc",
);

export async function prepareJsonCompatibilityControllerConfig(options) {
  const basePath = path.resolve(options?.basePath ?? defaultBasePath);
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (basePath === outPath) throw new Error("--out must not replace the base config");
  const base = parseStrictJsonObject(
    await readBoundedUtf8File(
      basePath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "base staging Controller config",
    ),
    "base staging Controller config",
  );
  validateControllerConfig(base, "staging");
  const campaign = structuredClone(base);
  campaign.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
  const validation = validateControllerConfig(campaign, "staging", {
    jsonCompatibilityCampaign: true,
  });
  const canonicalOutput = canonicalJson(campaign);
  await writeFile(outPath, canonicalOutput, { encoding: "utf8", flag: "wx" });
  return {
    ok: true,
    schemaVersion: 1,
    mode: "offline-campaign-config-preparation",
    environment: "staging",
    controllerName: validation.controllerName,
    configSha256: sha256Canonical(campaign),
    changedVars: ["CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED"],
    jsonCompatibilityProbeEnabled: true,
    credentialsRead: false,
    networkRequestsPerformed: false,
    deploymentMutationPerformed: false,
  };
}

export function parseJsonCompatibilityControllerConfigArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") flags.add("--help");
    else if (["--help", "--json"].includes(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} must not be repeated`);
      flags.add(argument);
    } else if (["--base", "--out"].includes(argument)) {
      if (values.has(argument)) throw new Error(`${argument} must not be repeated`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
    } else {
      throw new Error("unknown option");
    }
  }
  if (flags.has("--help")) {
    if (values.size !== 0 || flags.has("--json")) {
      throw new Error("--help does not accept preparation options");
    }
    return { help: true };
  }
  if (!values.has("--out")) throw new Error("--out is required");
  return {
    basePath: values.get("--base"),
    outPath: values.get("--out"),
    json: flags.has("--json"),
  };
}

function requiredPath(value, option) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  bun tools/prepare_container_runtime_json_compatibility_controller_config.mjs --out <campaign-wrangler.jsonc> [--base <tracked-staging.jsonc>] [--json]",
    "",
    "The output is create-only and differs from the validated staging base only by enabling the isolated JSON compatibility probe gate.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityControllerConfigArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await prepareJsonCompatibilityControllerConfig(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `JSON compatibility Controller config prepared: ${result.configSha256}; isolated probe gate only, no deployment performed.`,
      );
    }
  } catch (error) {
    const message =
      error instanceof DeployPreflightError || error instanceof Error
        ? error.message
        : "unexpected campaign config preparation failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility Controller config preparation failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (import.meta.main === true) return true;
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) await cliMain();
