import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildJsonCompatibilityCampaignPlan,
  sha256Canonical,
} from "../../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
  validateJsonCompatibilityDeploymentStatePlan,
} from "../../tools/container_runtime_json_compatibility_deployment_states.mjs";
import {
  buildJsonCompatibilityDeploymentLeafServiceIdentity,
  buildJsonCompatibilityDeploymentTransitionExecutionAuthority,
  signJsonCompatibilityDeploymentTransition,
} from "../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";

export const TRANSITION_IDS = Object.freeze([
  "arm-status-callee-to-caller",
  "arm-execution-callee-to-caller",
  "disarm-execution-retain-status-caller-to-callee",
  "close-status-caller-to-callee",
]);

export const EXPECTED_ROLE_ORDERS = Object.freeze([
  ["invoker", "operator", "runner", "caller"],
  ["controller", "executor", "permitIssuer", "invoker", "operator", "runner", "caller"],
  ["caller", "runner", "operator", "invoker", "permitIssuer", "executor", "controller"],
  ["caller", "runner", "operator", "invoker"],
]);

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildSourceEvidence(
  accountIdSha256,
  transition,
  artifactInventoryReadbackSha256 = digest("artifact-inventory-readback"),
) {
  const pair = `${transition.fromState}->${transition.toState}`;
  const profile = pair === "dark->statusOnly" || pair === "statusOnly->execution"
    ? "release-v1"
    : "campaign-closure-v1";
  return Object.freeze({
    schemaVersion: 2,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-transition-source-evidence-v2",
    profile,
    accountIdSha256,
    transitionSourceManifestSha256: digest("transition-source-manifest"),
    phaseSourceManifestSha256: profile === "campaign-closure-v1"
      ? digest("phase-source-manifest")
      : null,
    sourceSignatureEnvelopeSha256: digest("source-signature"),
    sourceVerifierPolicySha256: digest("source-verifier-policy"),
    sourceVerifierIdentitySha256: digest("source-verifier-identity"),
    immutableSourceArchiveReceiptSha256: digest("source-archive-receipt"),
    artifactInventoryReadbackSha256,
    accountBindingInventorySha256: digest("account-binding-inventory"),
  });
}

export function buildArtifactInventoryReadback(
  campaignPlan,
  statePlan,
  accountIdSha256 = digest("cloudflare-account-staging"),
  observedAt = 1_785_999_880,
) {
  const artifacts = [];
  for (const [role, service] of Object.entries(statePlan.services)) {
    for (const [artifact, frozen] of Object.entries(service.artifacts)) {
      artifacts.push({
        role,
        artifact,
        serviceName: service.serviceName,
        entrypoint: service.entrypoint,
        deploymentState: frozen.deploymentState,
        versionId: frozen.versionId,
        configSha256: frozen.configSha256,
        gates: structuredClone(frozen.gates),
        privateRpcOnly: service.privateRpcOnly,
        workersDev: service.workersDev,
        previewUrls: service.previewUrls,
        bindingSetSha256: digest(`bindings:${role}:${artifact}`),
        routeSetSha256: sha256Canonical([]),
        secretNameSetSha256: digest(`secrets:${role}:${artifact}`),
        durableObjectMigrationSetSha256:
          digest(`migrations:${role}:${artifact}`),
      });
    }
  }
  artifacts.sort((left, right) =>
    `${left.role}:${left.artifact}`.localeCompare(
      `${right.role}:${right.artifact}`,
    ));
  const subject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1",
    kind: "container-runtime-json-compatibility-source-artifact-inventory",
    environment: "staging",
    accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    artifacts,
    artifactCount: artifacts.length,
    observedAt,
  };
  return {
    ...subject,
    artifactInventoryReadbackSha256: sha256Canonical(subject),
  };
}

export function buildExecutionAuthority(
  accountIdSha256 = digest("cloudflare-account-staging"),
  overrides = {},
) {
  const service = (
    key,
    serviceName,
    entrypoint,
    capability,
    credential = null,
  ) => {
    const value = {
      serviceName,
      entrypoint,
      versionId: `${key}-version-2026-08`,
      profileVersion: 1,
      privateRpcOnly: true,
      capability,
      credentialIdSha256: credential === null
        ? null
        : digest(`${credential}-credential-id`),
      ...(overrides[key] ?? {}),
    };
    const identitySha256 = key === "source-verifier"
      ? overrides[key]?.identitySha256 ?? digest("source-verifier-identity")
      : key === "readback" || key === "mutation"
        ? buildJsonCompatibilityDeploymentLeafServiceIdentity({
          accountIdSha256,
          ...value,
        }).identitySha256
        : digest(`${key}-identity`);
    return { ...value, identitySha256 };
  };
  return buildJsonCompatibilityDeploymentTransitionExecutionAuthority({
    accountIdSha256,
    coordinator: service(
      "coordinator",
      "cinatoken-container-runtime-json-compatibility-deployment-transition-staging",
      "JsonCompatibilityDeploymentTransitionEntrypoint",
      "coordinate-only",
    ),
    sourceVerifier: service(
      "source-verifier",
      "cinatoken-container-runtime-json-compatibility-source-verifier-staging",
      "JsonCompatibilitySourceVerifierEntrypoint",
      "source-verify-only",
    ),
    readback: service(
      "readback",
      "cinatoken-container-runtime-json-compatibility-deployment-readback-staging",
      "JsonCompatibilityDeploymentReadbackEntrypoint",
      "read-only",
      "readback",
    ),
    mutation: service(
      "mutation",
      "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging",
      "JsonCompatibilityDeploymentMutationEntrypoint",
      "mutation-only",
      "mutation",
    ),
  });
}

export async function createAuthorizedTransitionFixture({
  transitionId = TRANSITION_IDS[0],
  now = Math.floor(Date.now() / 1000),
  operationSeed = "runtime-worker-operation",
  includeApprovalPrivateKey = false,
} = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cinatoken-transition-worker-fixture-"),
  );
  let privateKeyBytes = null;
  try {
    const configPath = path.join(directory, "controller-execution.jsonc");
    await prepareJsonCompatibilityControllerConfig({ outPath: configPath });
    const controllerConfig = JSON.parse(await readFile(configPath, "utf8"));
    const keys = generateKeyPairSync("ed25519");
    privateKeyBytes = keys.privateKey.export({ format: "der", type: "pkcs8" });
    const approvalSpkiSha256 = createHash("sha256")
      .update(keys.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    const statePlan = buildStatePlan(sha256Canonical(controllerConfig));
    const campaignPlan = buildCampaignPlan(
      controllerConfig,
      statePlan,
      approvalSpkiSha256,
    );
    const transition = statePlan.transitions.find(
      (value) => value.id === transitionId,
    );
    if (transition === undefined) throw new Error("transition fixture is absent");
    const artifactInventoryReadback = buildArtifactInventoryReadback(
      campaignPlan,
      statePlan,
      digest("cloudflare-account-staging"),
      now - 120,
    );
    const authorizedTransition = signJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      transitionId,
      operationIdSha256: digest(operationSeed),
      priorStateEvidence: {
        state: transition.fromState,
        enteredAt: now - transition.minimumHoldSeconds,
        evidenceSha256: digest(`prior-state:${transitionId}`),
      },
      sourceEvidence: buildSourceEvidence(
        digest("cloudflare-account-staging"),
        transition,
        artifactInventoryReadback.artifactInventoryReadbackSha256,
      ),
      artifactInventoryReadback,
      executionAuthority: buildExecutionAuthority(),
      privateKeyBytes,
      now: new Date(now * 1000),
    });
    return {
      campaignPlan,
      statePlan,
      authorizedTransition,
      artifactInventoryReadback,
      ...(includeApprovalPrivateKey
        ? { approvalPrivateKeyBytes: Buffer.from(privateKeyBytes) }
        : {}),
    };
  } finally {
    privateKeyBytes?.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}

export function buildStatePlan(controllerExecutionConfigSha256) {
  const definitions = {
    controller: {
      serviceName: "cinatoken-container-controller-staging",
      entrypoint: "JsonCompatibilityProbeEntrypoint",
      states: ["dark", "execution"],
      gates: ["CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED"],
    },
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
      states: ["dark", "execution"],
      gates: ["JSON_COMPATIBILITY_EXECUTOR_ENABLED"],
    },
    permitIssuer: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
      entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
      states: ["dark", "execution"],
      gates: ["JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED"],
    },
    invoker: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
      states: ["dark", "statusOnly", "execution"],
      gates: [
        "JSON_COMPATIBILITY_INVOKER_ENABLED",
        "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
      ],
    },
    operator: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-operator-staging",
      entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
      states: ["dark", "statusOnly", "execution"],
      gates: [
        "JSON_COMPATIBILITY_OPERATOR_ENABLED",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
      ],
    },
    runner: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-runner-staging",
      entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
      states: ["dark", "statusOnly", "execution"],
      gates: [
        "JSON_COMPATIBILITY_RUNNER_ENABLED",
        "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
      ],
    },
    caller: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-caller-staging",
      entrypoint: "JsonCompatibilityCampaignCallerEntrypoint",
      states: ["dark", "statusOnly", "execution"],
      gates: [
        "JSON_COMPATIBILITY_CALLER_ENABLED",
        "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
      ],
    },
  };
  const services = {};
  for (const [role, definition] of Object.entries(definitions)) {
    const artifacts = {};
    for (const state of definition.states) {
      const externalState = state === "statusOnly" ? "status-only" : state;
      const gates = Object.fromEntries(definition.gates.map((gate) => [
        gate,
        gate.endsWith("STATUS_READ_ENABLED")
          ? state === "statusOnly" || state === "execution"
          : state === "execution",
      ]));
      artifacts[state] = {
        deploymentState: externalState,
        versionId: `${role}-${state}-version-2026-08`,
        configSha256: role === "controller" && state === "execution"
          ? controllerExecutionConfigSha256
          : digest(`config:${role}:${state}`),
        gates,
      };
    }
    services[role] = {
      serviceName: definition.serviceName,
      entrypoint: definition.entrypoint,
      privateRpcOnly: true,
      workersDev: false,
      previewUrls: false,
      artifacts,
    };
  }
  const states = {
    dark: {
      controller: "dark", executor: "dark", permitIssuer: "dark",
      invoker: "dark", operator: "dark", runner: "dark", caller: "dark",
    },
    statusOnly: {
      controller: "dark", executor: "dark", permitIssuer: "dark",
      invoker: "statusOnly", operator: "statusOnly", runner: "statusOnly",
      caller: "statusOnly",
    },
    execution: {
      controller: "execution", executor: "execution", permitIssuer: "execution",
      invoker: "execution", operator: "execution", runner: "execution",
      caller: "execution",
    },
  };
  const definitionsByTransition = [
    {
      id: TRANSITION_IDS[0], fromState: "dark", toState: "statusOnly",
      direction: "callee-to-caller", roles: EXPECTED_ROLE_ORDERS[0], hold: 0,
    },
    {
      id: TRANSITION_IDS[1], fromState: "statusOnly", toState: "execution",
      direction: "callee-to-caller", roles: EXPECTED_ROLE_ORDERS[1], hold: 0,
    },
    {
      id: TRANSITION_IDS[2], fromState: "execution", toState: "statusOnly",
      direction: "caller-to-callee", roles: EXPECTED_ROLE_ORDERS[2], hold: 0,
    },
    {
      id: TRANSITION_IDS[3], fromState: "statusOnly", toState: "dark",
      direction: "caller-to-callee", roles: EXPECTED_ROLE_ORDERS[3],
      hold: JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
    },
  ];
  const transitions = definitionsByTransition.map((transition, index) => ({
    ordinal: index + 1,
    id: transition.id,
    fromState: transition.fromState,
    toState: transition.toState,
    direction: transition.direction,
    minimumHoldSeconds: transition.hold,
    ownerApprovalRequired: true,
    automaticRetryAllowed: false,
    steps: transition.roles.map((role, stepIndex) => {
      const fromKey = states[transition.fromState][role];
      const toKey = states[transition.toState][role];
      const target = services[role].artifacts[toKey];
      return {
        ordinal: stepIndex + 1,
        role,
        fromArtifact: fromKey === "statusOnly" ? "status-only" : fromKey,
        toArtifact: toKey === "statusOnly" ? "status-only" : toKey,
        targetVersionId: target.versionId,
        targetConfigSha256: target.configSha256,
      };
    }),
  }));
  const subject = {
    schemaVersion: 2,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    kind: "container-runtime-json-compatibility-deployment-state-plan",
    mode: "offline-version-freeze",
    environment: "staging",
    services,
    states,
    transitions,
    constraints: {
      statusRecoveryWindowSeconds:
        JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
      executionRetryPermitted: false,
      directDarkToExecutionAllowed: false,
      directExecutionToDarkAllowed: false,
      automaticTransitionAllowed: false,
      ownerApprovalRequired: true,
      authenticatedRemoteReadbackRequired: true,
      sourceAuthenticationRequired: true,
      immutableArchiveRequired: true,
    },
    executionBoundary: {
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      deploymentMutationAuthorized: false,
      deploymentMutationPerformed: false,
      activationGateChangeAuthorized: false,
      remoteEvidenceCollected: false,
    },
  };
  const plan = { ...subject, planDigestSha256: sha256Canonical(subject) };
  return validateJsonCompatibilityDeploymentStatePlan(plan);
}

export function buildCampaignPlan(config, deploymentPlan, approvalSpkiSha256) {
  const execution = Object.fromEntries(
    Object.entries(deploymentPlan.services).map(([role, service]) => [
      role,
      service.artifacts.execution,
    ]),
  );
  return buildJsonCompatibilityCampaignPlan({
    config,
    campaignIdSha256: digest("campaign"),
    deploymentStatePlanDigestSha256: deploymentPlan.planDigestSha256,
    controllerVersionId: execution.controller.versionId,
    callerVersionId: execution.caller.versionId,
    callerConfigSha256: execution.caller.configSha256,
    runnerVersionId: execution.runner.versionId,
    runnerConfigSha256: execution.runner.configSha256,
    operatorVersionId: execution.operator.versionId,
    operatorConfigSha256: execution.operator.configSha256,
    operatorHmacKeyId: "operator-execution-2026-08",
    operatorHmacCredentialIdSha256: digest("operator-execution-credential"),
    operatorStatusHmacKeyId: "operator-status-2026-08",
    operatorStatusHmacCredentialIdSha256: digest("operator-status-credential"),
    operatorApprovalKeyId: "transition-owner-approval-2026-08",
    operatorApprovalSpkiSha256: approvalSpkiSha256,
    invokerVersionId: execution.invoker.versionId,
    invokerConfigSha256: execution.invoker.configSha256,
    permitIssuerVersionId: execution.permitIssuer.versionId,
    permitIssuerConfigSha256: execution.permitIssuer.configSha256,
    executorVersionId: execution.executor.versionId,
    executorConfigSha256: execution.executor.configSha256,
    runtimeNBuildIdSha256: digest("runtime-n"),
    runtimeNImageDigest: `sha256:${digest("runtime-n-image")}`,
    runtimeNMinusOneBuildIdSha256: digest("runtime-n-minus-one"),
    runtimeNMinusOneImageDigest:
      `sha256:${digest("runtime-n-minus-one-image")}`,
    candidateShardIndex: 3,
  });
}
