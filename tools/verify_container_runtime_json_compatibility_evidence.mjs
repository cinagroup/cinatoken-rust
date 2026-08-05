#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  buildJsonCompatibilityCampaignPlan,
  parseStrictJsonObject,
  verifyJsonCompatibilityCampaignEvidence,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityEvidenceFromSourceManifest,
  createSyntheticJsonCompatibilitySourceManifest,
  validateJsonCompatibilitySourceManifest,
  verifyJsonCompatibilityEvidenceSourceManifestBinding,
} from "./container_runtime_json_compatibility_source_manifest.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  JSON_COMPATIBILITY_EVIDENCE_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  JSON_COMPATIBILITY_SOURCE_MANIFEST_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(
  repoRoot,
  "services",
  "container-controller",
  "wrangler.staging.jsonc",
);

export async function runJsonCompatibilityEvidenceVerifier(options) {
  if (options.selfTest) {
    const config = parseStrictJsonObject(
      await readBoundedUtf8File(
        path.resolve(options.configPath ?? defaultConfigPath),
        JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
        "staging Controller config",
      ),
      "staging Controller config",
    );
    config.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
    const plan = buildJsonCompatibilityCampaignPlan({
      config,
      campaignIdSha256: "11".repeat(32),
      deploymentStatePlanDigestSha256: "d4".repeat(32),
      controllerVersionId: "controller-version-self-test",
      runnerVersionId: "runner-version-self-test",
      runnerConfigSha256: "aa".repeat(32),
      operatorVersionId: "operator-version-self-test",
      operatorConfigSha256: "66".repeat(32),
      operatorHmacKeyId: "operator-hmac-self-test",
      operatorHmacCredentialIdSha256: "c1".repeat(32),
      operatorStatusHmacKeyId: "operator-status-hmac-self-test",
      operatorStatusHmacCredentialIdSha256: "c2".repeat(32),
      operatorApprovalKeyId: "operator-approval-self-test",
      operatorApprovalSpkiSha256: "bb".repeat(32),
      invokerVersionId: "invoker-version-self-test",
      invokerConfigSha256: "77".repeat(32),
      permitIssuerVersionId: "permit-issuer-version-self-test",
      permitIssuerConfigSha256: "88".repeat(32),
      executorVersionId: "executor-version-self-test",
      executorConfigSha256: "99".repeat(32),
      runtimeNBuildIdSha256: "22".repeat(32),
      runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
      runtimeNMinusOneBuildIdSha256: "44".repeat(32),
      runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
      candidateShardIndex: 3,
    });
    const sourceManifest = createSyntheticJsonCompatibilitySourceManifest(plan);
    const evidence = buildJsonCompatibilityEvidenceFromSourceManifest(
      plan,
      sourceManifest,
      {
        capturedAt: "2026-08-03T00:08:00Z",
        evidenceSource: "synthetic-self-test",
      },
    );
    validateJsonCompatibilitySourceManifest(plan, sourceManifest);
    verifyJsonCompatibilityEvidenceSourceManifestBinding(
      plan,
      sourceManifest,
      evidence,
    );
    return {
      ...verifyJsonCompatibilityCampaignEvidence(plan, evidence, {
        allowSynthetic: true,
      }),
      mode: "self-test",
      fixtureOnly: true,
      sourceManifestValidated: true,
    };
  }
  const [planSource, sourceManifestSource, evidenceSource] = await Promise.all([
    readBoundedUtf8File(
      path.resolve(options.planPath),
      JSON_COMPATIBILITY_PLAN_MAX_BYTES,
      "JSON compatibility plan",
    ),
    readBoundedUtf8File(
      path.resolve(options.sourceManifestPath),
      JSON_COMPATIBILITY_SOURCE_MANIFEST_MAX_BYTES,
      "JSON compatibility source manifest",
    ),
    readBoundedUtf8File(
      path.resolve(options.evidencePath),
      JSON_COMPATIBILITY_EVIDENCE_MAX_BYTES,
      "JSON compatibility evidence",
    ),
  ]);
  const plan = parseStrictJsonObject(planSource, "JSON compatibility plan");
  const sourceManifest = parseStrictJsonObject(
    sourceManifestSource,
    "JSON compatibility source manifest",
  );
  const evidence = parseStrictJsonObject(
    evidenceSource,
    "JSON compatibility evidence",
  );
  validateJsonCompatibilitySourceManifest(plan, sourceManifest);
  verifyJsonCompatibilityEvidenceSourceManifestBinding(
    plan,
    sourceManifest,
    evidence,
  );
  return {
    ...verifyJsonCompatibilityCampaignEvidence(plan, evidence),
    sourceManifestValidated: true,
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--plan",
    "--source-manifest",
    "--evidence",
    "--config",
  ]);
  const flagOptions = new Set(["--self-test", "--json", "--help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") flags.add("--help");
    else if (flagOptions.has(argument)) {
      if (flags.has(argument)) throw new Error(`${argument} must not be repeated`);
      flags.add(argument);
    } else if (valueOptions.has(argument)) {
      if (values.has(argument)) throw new Error(`${argument} must not be repeated`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (flags.has("--help")) return { help: true };
  const selfTest = flags.has("--self-test");
  if (
    selfTest &&
    (values.has("--plan") ||
      values.has("--source-manifest") ||
      values.has("--evidence"))
  ) {
    throw new Error(
      "--self-test does not accept --plan, --source-manifest, or --evidence",
    );
  }
  if (!selfTest) {
    for (const name of ["--plan", "--source-manifest", "--evidence"]) {
      if (!values.has(name)) throw new Error(`${name} is required`);
    }
    if (values.has("--config")) {
      throw new Error("--config is accepted only with --self-test");
    }
  }
  return {
    selfTest,
    json: flags.has("--json"),
    configPath: values.get("--config"),
    planPath: values.get("--plan"),
    sourceManifestPath: values.get("--source-manifest"),
    evidencePath: values.get("--evidence"),
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/verify_container_runtime_json_compatibility_evidence.mjs --plan <plan.json> --source-manifest <manifest.json> --evidence <evidence.json> [--json]",
    "  bun tools/verify_container_runtime_json_compatibility_evidence.mjs --self-test [--config <path>] [--json]",
    "",
    "Verification is offline and read-only. Normal mode requires the complete source manifest, accepts only the untrusted remote-staging source claim, and rejects any evidence projection that differs from the manifest. Cryptographic source authentication remains external and mandatory.",
  ].join("\n");
}

async function cliMain(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runJsonCompatibilityEvidenceVerifier(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `JSON compatibility evidence ${result.mode} passed: ${result.phaseCount} phases, ${result.observationCount} shard observations, zero Protobuf attempts and zero protected mutations.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility evidence failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility evidence verification failed: ${message}`);
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
