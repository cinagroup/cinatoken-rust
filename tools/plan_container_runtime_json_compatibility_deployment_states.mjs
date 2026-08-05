#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  parseStrictJsonObject,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityDeploymentStatePlan,
  validateJsonCompatibilityDeploymentStateInventory,
  validateJsonCompatibilityDeploymentStatePlan,
} from "./container_runtime_json_compatibility_deployment_states.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

export async function runJsonCompatibilityDeploymentStatePlanner(options) {
  const inventoryPath = path.resolve(requiredPath(
    options?.inventoryPath,
    "--inventory",
  ));
  const outPath = path.resolve(requiredPath(options?.outPath, "--out"));
  if (outPath === inventoryPath) {
    throw new Error("--out must not replace --inventory");
  }
  const inventory = validateJsonCompatibilityDeploymentStateInventory(
    parseStrictJsonObject(
      await readBoundedUtf8File(
        inventoryPath,
        JSON_COMPATIBILITY_PLAN_MAX_BYTES,
        "deployment state inventory",
      ),
      "deployment state inventory",
    ),
  );
  const baseDirectory = path.dirname(inventoryPath);
  const configPaths = new Set();
  const services = {};
  for (const [role, artifacts] of Object.entries(inventory.services)) {
    services[role] = {};
    for (const [state, artifact] of Object.entries(artifacts)) {
      const configPath = path.resolve(baseDirectory, artifact.configPath);
      if (configPath === inventoryPath || configPath === outPath) {
        throw new Error(
          `deployment state ${role} ${state} config path must not be the inventory or output`,
        );
      }
      if (configPaths.has(configPath)) {
        throw new Error(
          `deployment state config path is reused: ${artifact.configPath}`,
        );
      }
      configPaths.add(configPath);
      services[role][state] = {
        versionId: artifact.versionId,
        config: parseStrictJsonObject(
          await readBoundedUtf8File(
            configPath,
            JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
            `deployment state ${role} ${state} config`,
          ),
          `deployment state ${role} ${state} config`,
        ),
      };
    }
  }
  const plan = buildJsonCompatibilityDeploymentStatePlan({ services });
  validateJsonCompatibilityDeploymentStatePlan(plan);
  await writeFile(outPath, canonicalJson(plan), {
    encoding: "utf8",
    flag: "wx",
  });
  return plan;
}

export function parseJsonCompatibilityDeploymentStatePlannerArgs(argv) {
  const values = new Map();
  let json = false;
  let help = false;
  const valueOptions = new Set(["--inventory", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      if (help) throw new Error("--help must not be repeated");
      help = true;
    } else if (argument === "--json") {
      if (json) throw new Error("--json must not be repeated");
      json = true;
    } else if (valueOptions.has(argument)) {
      if (values.has(argument)) {
        throw new Error(`${argument} must not be repeated`);
      }
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (help) {
    if (values.size > 0 || json) {
      throw new Error("--help does not accept planning options");
    }
    return { help: true };
  }
  requiredPath(values.get("--inventory"), "--inventory");
  requiredPath(values.get("--out"), "--out");
  return {
    inventoryPath: values.get("--inventory"),
    outPath: values.get("--out"),
    json,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/plan_container_runtime_json_compatibility_deployment_states.mjs --inventory <uploaded-version-inventory.json> --out <create-only-deployment-state-plan.json> [--json]",
    "",
    "The inventory contains only non-secret Worker version IDs and local config paths. Paths are resolved relative to the inventory file and are removed from the resulting plan.",
    "The planner strictly validates every actual Wrangler config, freezes its canonical SHA-256 digest, and permits only dark -> status-only -> execution -> status-only -> dark transitions.",
    "It performs no credential read, network request, upload, deployment, activation change, or remote readback. The output is create-only.",
  ].join("\n");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseJsonCompatibilityDeploymentStatePlannerArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const plan = await runJsonCompatibilityDeploymentStatePlanner(options);
    const report = {
      ok: true,
      schemaVersion: 1,
      mode: "offline-deployment-state-plan-creation",
      environment: "staging",
      planDigestSha256: plan.planDigestSha256,
      serviceCount: Object.keys(plan.services).length,
      artifactCount: Object.values(plan.services).reduce(
        (count, service) => count + Object.keys(service.artifacts).length,
        0,
      ),
      transitionCount: plan.transitions.length,
      filesWritten: true,
      credentialsRead: false,
      networkRequestsPerformed: false,
      deploymentMutationPerformed: false,
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `JSON compatibility deployment state plan created: ${report.planDigestSha256}; ${report.artifactCount} immutable artifacts and ${report.transitionCount} transitions.`,
      );
    }
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected deployment state planner failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility deployment state planner failed: ${message}`);
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
