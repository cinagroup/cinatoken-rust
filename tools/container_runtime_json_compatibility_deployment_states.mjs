import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateControllerConfig,
} from "./preflight_container_controller_deploy.mjs";
import {
  validateJsonCompatibilityExecutorConfig,
} from "./prepare_container_runtime_json_compatibility_executor_config.mjs";
import {
  validateJsonCompatibilityPermitIssuerConfig,
} from "./prepare_container_runtime_json_compatibility_permit_issuer_config.mjs";
import {
  validateJsonCompatibilityInvokerConfig,
} from "./prepare_container_runtime_json_compatibility_invoker_config.mjs";
import {
  validateJsonCompatibilityOperatorConfig,
} from "./prepare_container_runtime_json_compatibility_operator_config.mjs";
import {
  validateJsonCompatibilityRunnerConfig,
} from "./prepare_container_runtime_json_compatibility_runner_config.mjs";

export const JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_STATE_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-deployment-state-inventory-v1";
export const JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS = 86_400;

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLE_ORDER = Object.freeze([
  "controller",
  "executor",
  "permitIssuer",
  "invoker",
  "operator",
  "runner",
]);
const SERVICE_DEFINITIONS = Object.freeze({
  controller: Object.freeze({
    serviceName: "cinatoken-container-controller-staging",
    entrypoint: "JsonCompatibilityProbeEntrypoint",
    artifactStates: Object.freeze(["dark", "execution"]),
    gateNames: Object.freeze(["CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED"]),
  }),
  executor: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
    artifactStates: Object.freeze(["dark", "execution"]),
    gateNames: Object.freeze(["JSON_COMPATIBILITY_EXECUTOR_ENABLED"]),
  }),
  permitIssuer: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
    artifactStates: Object.freeze(["dark", "execution"]),
    gateNames: Object.freeze(["JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED"]),
  }),
  invoker: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
    artifactStates: Object.freeze(["dark", "statusOnly", "execution"]),
    gateNames: Object.freeze([
      "JSON_COMPATIBILITY_INVOKER_ENABLED",
      "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
    ]),
  }),
  operator: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-operator-staging",
    entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
    artifactStates: Object.freeze(["dark", "statusOnly", "execution"]),
    gateNames: Object.freeze([
      "JSON_COMPATIBILITY_OPERATOR_ENABLED",
      "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
    ]),
  }),
  runner: Object.freeze({
    serviceName:
      "cinatoken-container-runtime-json-compatibility-runner-staging",
    entrypoint: "JsonCompatibilityCampaignRunnerEntrypoint",
    artifactStates: Object.freeze(["dark", "statusOnly", "execution"]),
    gateNames: Object.freeze([
      "JSON_COMPATIBILITY_RUNNER_ENABLED",
      "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
    ]),
  }),
});
const GLOBAL_STATES = Object.freeze({
  dark: Object.freeze({
    controller: "dark",
    executor: "dark",
    permitIssuer: "dark",
    invoker: "dark",
    operator: "dark",
    runner: "dark",
  }),
  statusOnly: Object.freeze({
    controller: "dark",
    executor: "dark",
    permitIssuer: "dark",
    invoker: "statusOnly",
    operator: "statusOnly",
    runner: "statusOnly",
  }),
  execution: Object.freeze({
    controller: "execution",
    executor: "execution",
    permitIssuer: "execution",
    invoker: "execution",
    operator: "execution",
    runner: "execution",
  }),
});
const TRANSITION_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "arm-status-callee-to-caller",
    fromState: "dark",
    toState: "statusOnly",
    direction: "callee-to-caller",
    roles: Object.freeze(["invoker", "operator", "runner"]),
    minimumHoldSeconds: 0,
  }),
  Object.freeze({
    id: "arm-execution-callee-to-caller",
    fromState: "statusOnly",
    toState: "execution",
    direction: "callee-to-caller",
    roles: ROLE_ORDER,
    minimumHoldSeconds: 0,
  }),
  Object.freeze({
    id: "disarm-execution-retain-status-caller-to-callee",
    fromState: "execution",
    toState: "statusOnly",
    direction: "caller-to-callee",
    roles: Object.freeze([
      "runner",
      "operator",
      "invoker",
      "permitIssuer",
      "executor",
      "controller",
    ]),
    minimumHoldSeconds: 0,
  }),
  Object.freeze({
    id: "close-status-caller-to-callee",
    fromState: "statusOnly",
    toState: "dark",
    direction: "caller-to-callee",
    roles: Object.freeze(["runner", "operator", "invoker"]),
    minimumHoldSeconds: JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
  }),
]);

export function buildJsonCompatibilityDeploymentStatePlan(input) {
  const source = record(input, "deployment state plan input");
  exactKeys(source, ["services"], "deployment state plan input");
  const inputServices = record(source.services, "deployment state input services");
  exactKeys(inputServices, ROLE_ORDER, "deployment state input services");

  const seenVersionIds = new Set();
  const services = {};
  for (const role of ROLE_ORDER) {
    const definition = SERVICE_DEFINITIONS[role];
    const inputArtifacts = record(
      inputServices[role],
      `deployment state ${role} artifacts`,
    );
    exactKeys(
      inputArtifacts,
      definition.artifactStates,
      `deployment state ${role} artifacts`,
    );
    const artifacts = {};
    const roleConfigDigests = new Set();
    for (const state of definition.artifactStates) {
      const candidate = record(
        inputArtifacts[state],
        `deployment state ${role} ${state} artifact`,
      );
      exactKeys(
        candidate,
        ["versionId", "config"],
        `deployment state ${role} ${state} artifact`,
      );
      token(candidate.versionId, `deployment state ${role} ${state} version ID`);
      if (seenVersionIds.has(candidate.versionId)) {
        throw new JsonCompatibilityCampaignError(
          `deployment state version ID is reused: ${candidate.versionId}`,
        );
      }
      seenVersionIds.add(candidate.versionId);
      const config = record(
        candidate.config,
        `deployment state ${role} ${state} config`,
      );
      validateConfigForState(role, state, config);
      const configSha256 = sha256Canonical(config);
      if (roleConfigDigests.has(configSha256)) {
        throw new JsonCompatibilityCampaignError(
          `deployment state ${role} config digest is reused across states`,
        );
      }
      roleConfigDigests.add(configSha256);
      artifacts[state] = {
        deploymentState: externalStateName(state),
        versionId: candidate.versionId,
        configSha256,
        gates: expectedGates(role, state),
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

  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    kind: "container-runtime-json-compatibility-deployment-state-plan",
    mode: "offline-version-freeze",
    environment: "staging",
    services,
    states: cloneJson(GLOBAL_STATES),
    transitions: buildTransitions(services),
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
  return {
    ...subject,
    planDigestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityDeploymentStatePlan(input) {
  const plan = record(input, "deployment state plan");
  exactKeys(plan, [
    "schemaVersion",
    "contract",
    "kind",
    "mode",
    "environment",
    "services",
    "states",
    "transitions",
    "constraints",
    "executionBoundary",
    "planDigestSha256",
  ], "deployment state plan");
  equal(plan.schemaVersion, 1, "deployment state plan schema version");
  equal(
    plan.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
    "deployment state plan contract",
  );
  equal(
    plan.kind,
    "container-runtime-json-compatibility-deployment-state-plan",
    "deployment state plan kind",
  );
  equal(plan.mode, "offline-version-freeze", "deployment state plan mode");
  equal(plan.environment, "staging", "deployment state plan environment");
  sha256(plan.planDigestSha256, "deployment state plan digest");
  const { planDigestSha256, ...subject } = plan;
  equal(
    sha256Canonical(subject),
    planDigestSha256,
    "deployment state plan canonical digest",
  );

  const services = record(plan.services, "deployment state plan services");
  exactKeys(services, ROLE_ORDER, "deployment state plan services");
  const seenVersionIds = new Set();
  for (const role of ROLE_ORDER) {
    validatePlannedService(role, services[role], seenVersionIds);
  }
  canonicalEqual(plan.states, GLOBAL_STATES, "deployment global states");
  canonicalEqual(
    plan.transitions,
    buildTransitions(services),
    "deployment transitions",
  );
  canonicalEqual(plan.constraints, {
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
  }, "deployment state constraints");
  canonicalEqual(plan.executionBoundary, {
    credentialsRead: false,
    networkRequestsPerformed: false,
    filesWritten: false,
    deploymentMutationAuthorized: false,
    deploymentMutationPerformed: false,
    activationGateChangeAuthorized: false,
    remoteEvidenceCollected: false,
  }, "deployment state execution boundary");
  return plan;
}

export function validateJsonCompatibilityDeploymentStateInventory(input) {
  const inventory = record(input, "deployment state inventory");
  exactKeys(inventory, [
    "schemaVersion",
    "contract",
    "environment",
    "services",
  ], "deployment state inventory");
  equal(inventory.schemaVersion, 1, "deployment state inventory schema version");
  equal(
    inventory.contract,
    JSON_COMPATIBILITY_DEPLOYMENT_STATE_INVENTORY_CONTRACT,
    "deployment state inventory contract",
  );
  equal(inventory.environment, "staging", "deployment state inventory environment");
  const services = record(inventory.services, "deployment state inventory services");
  exactKeys(services, ROLE_ORDER, "deployment state inventory services");
  for (const role of ROLE_ORDER) {
    const definition = SERVICE_DEFINITIONS[role];
    const artifacts = record(
      services[role],
      `deployment state inventory ${role}`,
    );
    exactKeys(
      artifacts,
      definition.artifactStates,
      `deployment state inventory ${role}`,
    );
    for (const state of definition.artifactStates) {
      const artifact = record(
        artifacts[state],
        `deployment state inventory ${role} ${state}`,
      );
      exactKeys(
        artifact,
        ["versionId", "configPath"],
        `deployment state inventory ${role} ${state}`,
      );
      token(
        artifact.versionId,
        `deployment state inventory ${role} ${state} version ID`,
      );
      nonemptyString(
        artifact.configPath,
        `deployment state inventory ${role} ${state} config path`,
      );
    }
  }
  return inventory;
}

function validateConfigForState(role, state, config) {
  rejectPublicRoutes(config, `deployment state ${role} ${state} config`);
  const vars = record(config.vars, `deployment state ${role} ${state} vars`);
  if (role === "controller") {
    validateControllerConfig(
      config,
      "staging",
      state === "execution" ? { jsonCompatibilityCampaign: true } : undefined,
    );
    return;
  }
  if (role === "executor") {
    validateJsonCompatibilityExecutorConfig(
      config,
      state === "execution"
        ? {
            campaign: true,
            permitKeyId: vars.JSON_COMPATIBILITY_PERMIT_KEY_ID,
            permitSpkiSha256:
              vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256,
          }
        : undefined,
    );
    return;
  }
  if (role === "permitIssuer") {
    validateJsonCompatibilityPermitIssuerConfig(
      config,
      state === "execution"
        ? {
            authorityCurrentKid:
              vars.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID,
            authorityCurrentCredentialIdSha256:
              vars.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256,
            permitKeyId: vars.JSON_COMPATIBILITY_PERMIT_KEY_ID,
            permitSpkiSha256:
              vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256,
          }
        : null,
    );
    return;
  }
  if (role === "invoker") {
    validateJsonCompatibilityInvokerConfig(
      config,
      invokerValidationInput(state, vars),
    );
    return;
  }
  if (role === "operator") {
    validateJsonCompatibilityOperatorConfig(
      config,
      operatorValidationInput(state, vars),
    );
    return;
  }
  validateJsonCompatibilityRunnerConfig(
    config,
    runnerValidationInput(state, vars),
  );
}

function invokerValidationInput(state, vars) {
  if (state === "dark") return { deploymentState: "dark" };
  const input = {
    deploymentState: externalStateName(state),
    statusOperatorCurrentKid:
      vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID,
    statusOperatorCurrentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
  };
  if (state === "statusOnly") return input;
  return {
    ...input,
    operatorCurrentKid:
      vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID,
    operatorCurrentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    issuerHmacKid: vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID,
    issuerHmacCredentialIdSha256:
      vars.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256,
    permitKeyId: vars.JSON_COMPATIBILITY_PERMIT_KEY_ID,
    permitSpkiSha256: vars.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256,
  };
}

function operatorValidationInput(state, vars) {
  if (state === "dark") return { deploymentState: "dark" };
  const input = {
    deploymentState: externalStateName(state),
    statusCurrentKid:
      vars.JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID,
    statusCurrentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256,
    approvalCurrentKid:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID,
    approvalCurrentSpkiSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256,
    approvalPreviousKid:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID,
    approvalPreviousSpkiSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256,
    invokerVersionId:
      vars.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID,
  };
  if (state === "statusOnly") return input;
  return {
    ...input,
    currentKid: vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_KID,
    currentCredentialIdSha256:
      vars.JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
  };
}

function runnerValidationInput(state, vars) {
  if (state === "dark") return { deploymentState: "dark" };
  return {
    deploymentState: externalStateName(state),
    operatorVersionId:
      vars.JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID,
  };
}

function validatePlannedService(role, input, seenVersionIds) {
  const definition = SERVICE_DEFINITIONS[role];
  const service = record(input, `deployment state plan ${role}`);
  exactKeys(service, [
    "serviceName",
    "entrypoint",
    "privateRpcOnly",
    "workersDev",
    "previewUrls",
    "artifacts",
  ], `deployment state plan ${role}`);
  equal(service.serviceName, definition.serviceName, `${role} service name`);
  equal(service.entrypoint, definition.entrypoint, `${role} entrypoint`);
  equal(service.privateRpcOnly, true, `${role} private RPC requirement`);
  equal(service.workersDev, false, `${role} workers_dev`);
  equal(service.previewUrls, false, `${role} preview URLs`);
  const artifacts = record(service.artifacts, `${role} deployment artifacts`);
  exactKeys(artifacts, definition.artifactStates, `${role} deployment artifacts`);
  const digests = new Set();
  for (const state of definition.artifactStates) {
    const artifact = record(artifacts[state], `${role} ${state} artifact`);
    exactKeys(artifact, [
      "deploymentState",
      "versionId",
      "configSha256",
      "gates",
    ], `${role} ${state} artifact`);
    equal(
      artifact.deploymentState,
      externalStateName(state),
      `${role} ${state} deployment state`,
    );
    token(artifact.versionId, `${role} ${state} version ID`);
    if (seenVersionIds.has(artifact.versionId)) {
      throw new JsonCompatibilityCampaignError(
        `deployment state version ID is reused: ${artifact.versionId}`,
      );
    }
    seenVersionIds.add(artifact.versionId);
    sha256(artifact.configSha256, `${role} ${state} config digest`);
    if (digests.has(artifact.configSha256)) {
      throw new JsonCompatibilityCampaignError(
        `deployment state ${role} config digest is reused across states`,
      );
    }
    digests.add(artifact.configSha256);
    canonicalEqual(
      artifact.gates,
      expectedGates(role, state),
      `${role} ${state} gates`,
    );
  }
}

function expectedGates(role, state) {
  const definition = SERVICE_DEFINITIONS[role];
  const executionEnabled = state === "execution";
  const statusEnabled = state === "statusOnly" || state === "execution";
  const gates = {};
  for (const gateName of definition.gateNames) {
    gates[gateName] = gateName.endsWith("STATUS_READ_ENABLED")
      ? statusEnabled
      : executionEnabled;
  }
  return gates;
}

function buildTransitions(services) {
  return TRANSITION_DEFINITIONS.map((definition, index) => ({
    ordinal: index + 1,
    id: definition.id,
    fromState: definition.fromState,
    toState: definition.toState,
    direction: definition.direction,
    minimumHoldSeconds: definition.minimumHoldSeconds,
    ownerApprovalRequired: true,
    automaticRetryAllowed: false,
    steps: definition.roles.map((role, stepIndex) => {
      const fromArtifact = GLOBAL_STATES[definition.fromState][role];
      const toArtifact = GLOBAL_STATES[definition.toState][role];
      const target = services[role].artifacts[toArtifact];
      return {
        ordinal: stepIndex + 1,
        role,
        fromArtifact: externalStateName(fromArtifact),
        toArtifact: externalStateName(toArtifact),
        targetVersionId: target.versionId,
        targetConfigSha256: target.configSha256,
      };
    }),
  }));
}

function rejectPublicRoutes(config, label) {
  if (Object.hasOwn(config, "route") || Object.hasOwn(config, "routes")) {
    throw new JsonCompatibilityCampaignError(
      `${label} must not declare public routes`,
    );
  }
}

function externalStateName(state) {
  return state === "statusOnly" ? "status-only" : state;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new JsonCompatibilityCampaignError(
      `${label} keys must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new JsonCompatibilityCampaignError(`${label} does not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new JsonCompatibilityCampaignError(`${label} does not match`);
  }
}

function token(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a safe token`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a SHA-256 digest`);
  }
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new JsonCompatibilityCampaignError(`${label} must be a nonempty string`);
  }
}
