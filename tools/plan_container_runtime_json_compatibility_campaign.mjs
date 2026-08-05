#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  JsonCompatibilityCampaignError,
  buildJsonCompatibilityCampaignPlan,
  canonicalJson,
  parseStrictJsonObject,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
  validateJsonCompatibilityDeploymentStatePlan,
} from "./container_runtime_json_compatibility_deployment_states.mjs";
import {
  JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
  JSON_COMPATIBILITY_PLAN_MAX_BYTES,
  readBoundedUtf8File,
} from "./lib/bounded_json_file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(
  repoRoot,
  "services",
  "container-controller",
  "wrangler.staging.jsonc",
);

export async function runJsonCompatibilityCampaignPlanner(options) {
  const configPath = path.resolve(options.configPath ?? defaultConfigPath);
  const config = parseStrictJsonObject(
    await readBoundedUtf8File(
      configPath,
      JSON_COMPATIBILITY_CONFIG_MAX_BYTES,
      "staging Controller config",
    ),
    "staging Controller config",
  );
  if (options.selfTest) {
    config.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
  }
  const inputs = options.selfTest
    ? {
        campaignIdSha256: "11".repeat(32),
        deploymentStatePlanDigestSha256: "dd".repeat(32),
        controllerVersionId: "controller-version-self-test",
        callerVersionId: "caller-version-self-test",
        callerConfigSha256: "a1".repeat(32),
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
      }
    : await bindDeploymentStatePlan(config, options);
  const plan = buildJsonCompatibilityCampaignPlan({ config, ...inputs });
  validateJsonCompatibilityCampaignPlan(plan);
  if (!options.selfTest && options.outPath !== undefined) {
    const output = path.resolve(options.outPath);
    if (output === configPath) throw new Error("--out must not replace --config");
    if (output === path.resolve(options.deploymentStatePlanPath)) {
      throw new Error("--out must not replace --deployment-state-plan");
    }
    await writeFile(output, canonicalJson(plan), {
      encoding: "utf8",
      flag: "wx",
    });
  }
  if (!options.selfTest) return plan;
  return {
    ok: true,
    schemaVersion: 1,
    mode: "self-test",
    fixtureOnly: true,
    environment: "staging",
    planDigestSha256: plan.planDigestSha256,
    phaseCount: plan.phases.length,
    shardCount: plan.ring.shardCount,
    candidateShardIndex: plan.ring.candidateShardIndex,
    privateServiceCount: Object.keys(plan.privateServices).length,
    privateRpcOnly: Object.values(plan.privateServices).every(
      (service) => service.privateRpcOnly === true,
    ),
    privateProbeTransport: plan.controller.privateProbeTransport,
    jsonCompatibilityProbeEnabled:
      plan.controller.jsonCompatibilityProbeEnabled,
    protobufTransportEnabled: false,
    protobufTransportStagingVerified: false,
    credentialsRead: false,
    networkRequestsPerformed: false,
    filesWritten: false,
    deploymentMutationAuthorized: false,
    deploymentMutationPerformed: false,
    remoteEvidenceCollected: false,
  };
}

async function bindDeploymentStatePlan(config, options) {
  if (
    typeof options.deploymentStatePlanPath !== "string" ||
    options.deploymentStatePlanPath.length === 0
  ) {
    throw new Error("--deployment-state-plan is required");
  }
  const deploymentStatePlanPath = path.resolve(options.deploymentStatePlanPath);
  const deploymentStatePlan = validateJsonCompatibilityDeploymentStatePlan(
    parseStrictJsonObject(
      await readBoundedUtf8File(
        deploymentStatePlanPath,
        JSON_COMPATIBILITY_PLAN_MAX_BYTES,
        "deployment state plan",
      ),
      "deployment state plan",
    ),
  );
  if (
    deploymentStatePlan.schemaVersion !== 2
    || deploymentStatePlan.contract
      !== JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT
  ) {
    throw new Error("campaign planning requires the current deployment state plan contract");
  }
  const expected = {
    controller: {
      versionId: options.controllerVersionId,
      configSha256: sha256Canonical(config),
    },
    caller: {
      versionId: options.callerVersionId,
      configSha256: options.callerConfigSha256,
    },
    runner: {
      versionId: options.runnerVersionId,
      configSha256: options.runnerConfigSha256,
    },
    operator: {
      versionId: options.operatorVersionId,
      configSha256: options.operatorConfigSha256,
    },
    invoker: {
      versionId: options.invokerVersionId,
      configSha256: options.invokerConfigSha256,
    },
    permitIssuer: {
      versionId: options.permitIssuerVersionId,
      configSha256: options.permitIssuerConfigSha256,
    },
    executor: {
      versionId: options.executorVersionId,
      configSha256: options.executorConfigSha256,
    },
  };
  for (const [role, identity] of Object.entries(expected)) {
    const artifact = deploymentStatePlan.services[role].artifacts.execution;
    if (artifact.versionId !== identity.versionId) {
      throw new Error(
        `${role} execution version does not match --deployment-state-plan`,
      );
    }
    if (artifact.configSha256 !== identity.configSha256) {
      throw new Error(
        `${role} execution config digest does not match --deployment-state-plan`,
      );
    }
  }
  return {
    ...options,
    deploymentStatePlanDigestSha256:
      deploymentStatePlan.planDigestSha256,
  };
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    "--config",
    "--out",
    "--campaign-id-sha256",
    "--deployment-state-plan",
    "--controller-version-id",
    "--caller-version-id",
    "--caller-config-sha256",
    "--runner-version-id",
    "--runner-config-sha256",
    "--operator-version-id",
    "--operator-config-sha256",
    "--operator-hmac-kid",
    "--operator-hmac-credential-id-sha256",
    "--operator-status-hmac-kid",
    "--operator-status-hmac-credential-id-sha256",
    "--operator-approval-key-id",
    "--operator-approval-spki-sha256",
    "--invoker-version-id",
    "--invoker-config-sha256",
    "--permit-issuer-version-id",
    "--permit-issuer-config-sha256",
    "--executor-version-id",
    "--executor-config-sha256",
    "--runtime-n-build-id",
    "--runtime-n-image-digest",
    "--runtime-n-minus-one-build-id",
    "--runtime-n-minus-one-image-digest",
    "--candidate-shard-index",
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
  const liveInputOptions = [
    "--campaign-id-sha256",
    "--deployment-state-plan",
    "--controller-version-id",
    "--caller-version-id",
    "--caller-config-sha256",
    "--runner-version-id",
    "--runner-config-sha256",
    "--operator-version-id",
    "--operator-config-sha256",
    "--operator-hmac-kid",
    "--operator-hmac-credential-id-sha256",
    "--operator-status-hmac-kid",
    "--operator-status-hmac-credential-id-sha256",
    "--operator-approval-key-id",
    "--operator-approval-spki-sha256",
    "--invoker-version-id",
    "--invoker-config-sha256",
    "--permit-issuer-version-id",
    "--permit-issuer-config-sha256",
    "--executor-version-id",
    "--executor-config-sha256",
    "--runtime-n-build-id",
    "--runtime-n-image-digest",
    "--runtime-n-minus-one-build-id",
    "--runtime-n-minus-one-image-digest",
    "--candidate-shard-index",
  ];
  if (selfTest && liveInputOptions.some((name) => values.has(name))) {
    throw new Error("--self-test does not accept campaign identity options");
  }
  if (selfTest && values.has("--out")) {
    throw new Error("--self-test does not accept --out");
  }
  if (!selfTest) {
    for (const name of liveInputOptions.filter(
      (option) => option !== "--candidate-shard-index",
    )) {
      if (!values.has(name)) throw new Error(`${name} is required`);
    }
  }
  const candidateShardIndex = values.has("--candidate-shard-index")
    ? Number(values.get("--candidate-shard-index"))
    : undefined;
  return {
    selfTest,
    json: flags.has("--json"),
    configPath: values.get("--config"),
    outPath: values.get("--out"),
    campaignIdSha256: values.get("--campaign-id-sha256"),
    deploymentStatePlanPath: values.get("--deployment-state-plan"),
    controllerVersionId: values.get("--controller-version-id"),
    callerVersionId: values.get("--caller-version-id"),
    callerConfigSha256: values.get("--caller-config-sha256"),
    runnerVersionId: values.get("--runner-version-id"),
    runnerConfigSha256: values.get("--runner-config-sha256"),
    operatorVersionId: values.get("--operator-version-id"),
    operatorConfigSha256: values.get("--operator-config-sha256"),
    operatorHmacKeyId: values.get("--operator-hmac-kid"),
    operatorHmacCredentialIdSha256:
      values.get("--operator-hmac-credential-id-sha256"),
    operatorStatusHmacKeyId: values.get("--operator-status-hmac-kid"),
    operatorStatusHmacCredentialIdSha256:
      values.get("--operator-status-hmac-credential-id-sha256"),
    operatorApprovalKeyId: values.get("--operator-approval-key-id"),
    operatorApprovalSpkiSha256:
      values.get("--operator-approval-spki-sha256"),
    invokerVersionId: values.get("--invoker-version-id"),
    invokerConfigSha256: values.get("--invoker-config-sha256"),
    permitIssuerVersionId: values.get("--permit-issuer-version-id"),
    permitIssuerConfigSha256: values.get("--permit-issuer-config-sha256"),
    executorVersionId: values.get("--executor-version-id"),
    executorConfigSha256: values.get("--executor-config-sha256"),
    runtimeNBuildIdSha256: values.get("--runtime-n-build-id"),
    runtimeNImageDigest: values.get("--runtime-n-image-digest"),
    runtimeNMinusOneBuildIdSha256: values.get("--runtime-n-minus-one-build-id"),
    runtimeNMinusOneImageDigest: values.get("--runtime-n-minus-one-image-digest"),
    candidateShardIndex,
  };
}

function usage() {
  return [
    "Usage:",
    "  bun tools/plan_container_runtime_json_compatibility_campaign.mjs --campaign-id-sha256 <sha256> --deployment-state-plan <validated-state-plan.json> --controller-version-id <id> --caller-version-id <id> --caller-config-sha256 <sha256> --runner-version-id <id> --runner-config-sha256 <sha256> --operator-version-id <id> --operator-config-sha256 <sha256> --operator-hmac-kid <kid> --operator-hmac-credential-id-sha256 <sha256> --operator-status-hmac-kid <kid> --operator-status-hmac-credential-id-sha256 <sha256> --operator-approval-key-id <kid> --operator-approval-spki-sha256 <sha256> --invoker-version-id <id> --invoker-config-sha256 <sha256> --permit-issuer-version-id <id> --permit-issuer-config-sha256 <sha256> --executor-version-id <id> --executor-config-sha256 <sha256> --runtime-n-build-id <sha256> --runtime-n-image-digest <sha256:...> --runtime-n-minus-one-build-id <sha256> --runtime-n-minus-one-image-digest <sha256:...> [--candidate-shard-index <index>] [--config <path>] [--out <create-only-plan.json>] [--json]",
    "  bun tools/plan_container_runtime_json_compatibility_campaign.mjs --self-test [--config <path>] [--json]",
    "",
    "This planner requires a staging campaign config with only CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED=true plus a validated deployment-state plan. Every supplied execution version/config identity must equal that plan's execution artifact. It accepts no secret options or values and performs no network request, credential read, deployment, gate change, provider call, or traffic mutation.",
    "When --out is supplied, the local plan artifact is create-only. The resulting plan requires a private Service Binding probe executor; public Controller URLs are forbidden.",
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
    const result = await runJsonCompatibilityCampaignPlanner(options);
    if (!options.selfTest && options.outPath !== undefined) {
      const report = {
        ok: true,
        schemaVersion: 1,
        mode: "offline-plan-creation",
        environment: "staging",
        planDigestSha256: result.planDigestSha256,
        phaseCount: result.phases.length,
        shardCount: result.ring.shardCount,
        filesWritten: true,
        credentialsRead: false,
        networkRequestsPerformed: false,
        deploymentMutationPerformed: false,
      };
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(
          `JSON compatibility plan created: ${report.planDigestSha256}; ${report.phaseCount} phases and ${report.shardCount} shards.`,
        );
      }
      return;
    }
    if (options.json || !options.selfTest) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `JSON compatibility campaign planner self-test passed for ${result.shardCount} staging shards; fixture evidence only, no remote action performed.`,
    );
  } catch (error) {
    const message =
      error instanceof JsonCompatibilityCampaignError || error instanceof Error
        ? error.message
        : "unexpected JSON compatibility planner failure";
    if (options?.json || argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`JSON compatibility campaign planner failed: ${message}`);
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
