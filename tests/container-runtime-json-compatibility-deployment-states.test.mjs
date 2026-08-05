import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_INVENTORY_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
  buildJsonCompatibilityDeploymentStatePlan,
  validateJsonCompatibilityDeploymentStateInventory,
  validateJsonCompatibilityDeploymentStatePlan,
} from "../tools/container_runtime_json_compatibility_deployment_states.mjs";
import {
  parseJsonCompatibilityDeploymentStatePlannerArgs,
  runJsonCompatibilityDeploymentStatePlanner,
} from "../tools/plan_container_runtime_json_compatibility_deployment_states.mjs";
import {
  runJsonCompatibilityCampaignPlanner,
} from "../tools/plan_container_runtime_json_compatibility_campaign.mjs";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";
import {
  prepareJsonCompatibilityExecutorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_executor_config.mjs";
import {
  prepareJsonCompatibilityPermitIssuerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_permit_issuer_config.mjs";
import {
  prepareJsonCompatibilityInvokerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_invoker_config.mjs";
import {
  prepareJsonCompatibilityOperatorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_operator_config.mjs";
import {
  prepareJsonCompatibilityRunnerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_runner_config.mjs";
import {
  prepareJsonCompatibilityCallerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_caller_config.mjs";

const DIGEST = (character) => character.repeat(64);
const STATUS_AUTHORITY = Object.freeze({
  statusOperatorCurrentKid: "operator-status-2026-08",
  statusOperatorCurrentCredentialIdSha256: DIGEST("2"),
});
const INVOKER_EXECUTION_AUTHORITY = Object.freeze({
  operatorCurrentKid: "operator-execution-2026-08",
  operatorCurrentCredentialIdSha256: DIGEST("1"),
  issuerHmacKid: "invoker-issuer-2026-08",
  issuerHmacCredentialIdSha256: DIGEST("3"),
  permitKeyId: "permit-ed25519-2026-08",
  permitSpkiSha256: DIGEST("4"),
});
const OPERATOR_STATUS_AUTHORITY = Object.freeze({
  statusCurrentKid: STATUS_AUTHORITY.statusOperatorCurrentKid,
  statusCurrentCredentialIdSha256:
    STATUS_AUTHORITY.statusOperatorCurrentCredentialIdSha256,
  approvalCurrentKid: "operator-approval-2026-08",
  approvalCurrentSpkiSha256: DIGEST("5"),
  invokerVersionId: "invoker-status-version-2026-08",
});
const OPERATOR_EXECUTION_AUTHORITY = Object.freeze({
  currentKid: INVOKER_EXECUTION_AUTHORITY.operatorCurrentKid,
  currentCredentialIdSha256:
    INVOKER_EXECUTION_AUTHORITY.operatorCurrentCredentialIdSha256,
});

let directory;
let fixture;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cinatoken-deployment-states-"));
  fixture = await buildFixture(directory);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("JSON compatibility deployment state plan", () => {
  test("freezes 18 exact version/config artifacts and four safe transitions", () => {
    const plan = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    expect(validateJsonCompatibilityDeploymentStatePlan(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
      mode: "offline-version-freeze",
      environment: "staging",
      constraints: {
        statusRecoveryWindowSeconds:
          JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
        executionRetryPermitted: false,
        directDarkToExecutionAllowed: false,
        directExecutionToDarkAllowed: false,
        automaticTransitionAllowed: false,
        ownerApprovalRequired: true,
        authenticatedRemoteReadbackRequired: true,
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
    });
    expect(Object.values(plan.services).reduce(
      (count, service) => count + Object.keys(service.artifacts).length,
      0,
    )).toBe(18);
    expect(plan.transitions.map((transition) => transition.id)).toEqual([
      "arm-status-callee-to-caller",
      "arm-execution-callee-to-caller",
      "disarm-execution-retain-status-caller-to-callee",
      "close-status-caller-to-callee",
    ]);
    expect(plan.transitions[0].steps.map((step) => step.role)).toEqual([
      "invoker", "operator", "runner", "caller",
    ]);
    expect(plan.transitions[1].steps.map((step) => step.role)).toEqual([
      "controller", "executor", "permitIssuer", "invoker", "operator",
      "runner", "caller",
    ]);
    expect(plan.transitions[2].steps.map((step) => step.role)).toEqual([
      "caller", "runner", "operator", "invoker", "permitIssuer", "executor",
      "controller",
    ]);
    expect(plan.transitions[3]).toMatchObject({
      fromState: "statusOnly",
      toState: "dark",
      minimumHoldSeconds: 86_400,
      automaticRetryAllowed: false,
    });
  });

  test("binds every transition step to its target immutable artifact", () => {
    const plan = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    for (const transition of plan.transitions) {
      for (const step of transition.steps) {
        const stateKey = step.toArtifact === "status-only"
          ? "statusOnly"
          : step.toArtifact;
        const artifact = plan.services[step.role].artifacts[stateKey];
        expect(step.targetVersionId).toBe(artifact.versionId);
        expect(step.targetConfigSha256).toBe(artifact.configSha256);
      }
    }
  });

  test("rejects gate drift in an actual config before freezing its digest", () => {
    const services = structuredClone(fixture.services);
    services.invoker.statusOnly.config.vars
      .JSON_COMPATIBILITY_INVOKER_ENABLED = "true";
    expect(() => buildJsonCompatibilityDeploymentStatePlan({ services }))
      .toThrow(/invoker vars|execution/i);
  });

  test("rejects public routes and reused version or config identities", () => {
    const routed = structuredClone(fixture.services);
    routed.runner.dark.config.routes = ["example.invalid/*"];
    expect(() => buildJsonCompatibilityDeploymentStatePlan({ services: routed }))
      .toThrow(/must not declare public routes/);

    const reusedVersion = structuredClone(fixture.services);
    reusedVersion.operator.statusOnly.versionId =
      reusedVersion.invoker.statusOnly.versionId;
    expect(() => buildJsonCompatibilityDeploymentStatePlan({
      services: reusedVersion,
    })).toThrow(/version ID is reused/);

    const reusedConfig = structuredClone(fixture.services);
    reusedConfig.runner.statusOnly.config = structuredClone(
      reusedConfig.runner.execution.config,
    );
    expect(() => buildJsonCompatibilityDeploymentStatePlan({
      services: reusedConfig,
    })).toThrow(/runner config digest is reused|runner vars/);
  });

  test("rejects resigned transition, constraint, and artifact tampering", () => {
    const transition = structuredClone(buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    }));
    transition.transitions[0].steps.reverse();
    expect(() => validateJsonCompatibilityDeploymentStatePlan(resign(transition)))
      .toThrow(/deployment transitions/);

    const direct = structuredClone(buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    }));
    direct.constraints.directDarkToExecutionAllowed = true;
    expect(() => validateJsonCompatibilityDeploymentStatePlan(resign(direct)))
      .toThrow(/constraints/);

    const gates = structuredClone(buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    }));
    gates.services.operator.statusOnly = undefined;
    expect(() => validateJsonCompatibilityDeploymentStatePlan(resign(gates)))
      .toThrow();
  });

  test("rejects an unresigned plan digest mutation", () => {
    const plan = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    plan.services.runner.artifacts.execution.versionId = "runner-tampered";
    expect(() => validateJsonCompatibilityDeploymentStatePlan(plan))
      .toThrow(/canonical digest/);
  });

  test("keeps the six-service deployment state plan v1 readable", () => {
    const plan = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    plan.schemaVersion = 1;
    plan.contract =
      "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v1";
    delete plan.services.caller;
    for (const state of Object.values(plan.states)) delete state.caller;
    for (const transition of plan.transitions) {
      transition.steps = transition.steps.filter((step) => step.role !== "caller");
      transition.steps.forEach((step, index) => {
        step.ordinal = index + 1;
      });
    }
    const historical = resign(plan);
    expect(validateJsonCompatibilityDeploymentStatePlan(historical)).toEqual(
      historical,
    );
  });
});

describe("JSON compatibility deployment state inventory planner", () => {
  test("strictly validates the path-only, non-secret inventory", () => {
    expect(validateJsonCompatibilityDeploymentStateInventory(fixture.inventory))
      .toEqual(fixture.inventory);
    const extra = structuredClone(fixture.inventory);
    extra.services.runner.dark.secret = "forbidden";
    expect(() => validateJsonCompatibilityDeploymentStateInventory(extra))
      .toThrow(/keys must be exactly/);
  });

  test("reads actual configs, removes local paths, and writes create-only", async () => {
    const inventoryPath = path.join(directory, "inventory.json");
    const outputPath = path.join(directory, "deployment-plan.json");
    await writeFile(inventoryPath, canonicalJson(fixture.inventory), "utf8");
    const plan = await runJsonCompatibilityDeploymentStatePlanner({
      inventoryPath,
      outPath: outputPath,
    });
    expect(validateJsonCompatibilityDeploymentStatePlan(plan)).toEqual(plan);
    const source = await readFile(outputPath, "utf8");
    expect(JSON.parse(source)).toEqual(plan);
    expect(source).not.toContain("configPath");
    expect(source).not.toContain(directory.replaceAll("\\", "/"));
    await expect(runJsonCompatibilityDeploymentStatePlanner({
      inventoryPath,
      outPath: outputPath,
    })).rejects.toThrow();
  });

  test("rejects reused paths and output replacement", async () => {
    const reused = structuredClone(fixture.inventory);
    reused.services.runner.statusOnly.configPath =
      reused.services.runner.execution.configPath;
    const inventoryPath = path.join(directory, "inventory-reused.json");
    await writeFile(inventoryPath, canonicalJson(reused), "utf8");
    await expect(runJsonCompatibilityDeploymentStatePlanner({
      inventoryPath,
      outPath: path.join(directory, "reused-output.json"),
    })).rejects.toThrow(/config path is reused/);
    await expect(runJsonCompatibilityDeploymentStatePlanner({
      inventoryPath,
      outPath: inventoryPath,
    })).rejects.toThrow(/must not replace --inventory/);
  });

  test("refuses to create a new state plan from a historical inventory", async () => {
    const historical = structuredClone(fixture.inventory);
    historical.schemaVersion = 1;
    historical.contract =
      "cinatoken-container-runtime-json-compatibility-deployment-state-inventory-v1";
    delete historical.services.caller;
    const inventoryPath = path.join(directory, "inventory-v1.json");
    await writeFile(inventoryPath, canonicalJson(historical), "utf8");

    await expect(runJsonCompatibilityDeploymentStatePlanner({
      inventoryPath,
      outPath: path.join(directory, "state-plan-from-v1.json"),
    })).rejects.toThrow(/current inventory contract/);
  });

  test("binds a campaign plan to the validated execution artifacts", async () => {
    const deploymentPlan = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    const deploymentPlanPath = path.join(directory, "state-plan-for-campaign.json");
    const controllerConfigPath = path.join(
      directory,
      "controller-execution-for-campaign.jsonc",
    );
    await writeFile(deploymentPlanPath, canonicalJson(deploymentPlan), "utf8");
    await writeFile(
      controllerConfigPath,
      canonicalJson(fixture.services.controller.execution.config),
      "utf8",
    );
    const options = campaignPlannerOptions(
      deploymentPlan,
      deploymentPlanPath,
      controllerConfigPath,
      path.join(directory, "campaign-plan-v5.json"),
    );
    const campaign = await runJsonCompatibilityCampaignPlanner(options);
    expect(campaign).toMatchObject({
      schemaVersion: 4,
      contract: "cinatoken-container-runtime-json-compatibility-plan-v5",
      deploymentStateBinding: {
        planDigestSha256: deploymentPlan.planDigestSha256,
        initialState: "dark",
        executionState: "execution",
        recoveryState: "statusOnly",
        finalState: "dark",
      },
    });
    expect(campaign.deploymentStateBinding.executionArtifacts.runner).toEqual({
      versionId: deploymentPlan.services.runner.artifacts.execution.versionId,
      configSha256:
        deploymentPlan.services.runner.artifacts.execution.configSha256,
    });
    expect(campaign.deploymentStateBinding.executionArtifacts.caller).toEqual({
      versionId: deploymentPlan.services.caller.artifacts.execution.versionId,
      configSha256:
        deploymentPlan.services.caller.artifacts.execution.configSha256,
    });
    await expect(runJsonCompatibilityCampaignPlanner(options)).rejects.toThrow();

    await expect(runJsonCompatibilityCampaignPlanner({
      ...options,
      outPath: path.join(directory, "campaign-plan-drift.json"),
      runnerVersionId: "runner-unapproved-version",
    })).rejects.toThrow(/runner execution version does not match/);
  });

  test("refuses to create a campaign from a historical state plan", async () => {
    const current = buildJsonCompatibilityDeploymentStatePlan({
      services: fixture.services,
    });
    const historical = structuredClone(current);
    historical.schemaVersion = 1;
    historical.contract =
      "cinatoken-container-runtime-json-compatibility-deployment-state-plan-v1";
    delete historical.services.caller;
    for (const state of Object.values(historical.states)) delete state.caller;
    for (const transition of historical.transitions) {
      transition.steps = transition.steps.filter((step) => step.role !== "caller");
      transition.steps.forEach((step, index) => {
        step.ordinal = index + 1;
      });
    }
    const historicalPlan = resign(historical);
    const deploymentPlanPath = path.join(directory, "state-plan-v1.json");
    const controllerConfigPath = path.join(directory, "controller-for-v1.jsonc");
    await writeFile(deploymentPlanPath, canonicalJson(historicalPlan), "utf8");
    await writeFile(
      controllerConfigPath,
      canonicalJson(fixture.services.controller.execution.config),
      "utf8",
    );
    const options = campaignPlannerOptions(
      current,
      deploymentPlanPath,
      controllerConfigPath,
      path.join(directory, "campaign-from-v1.json"),
    );

    await expect(runJsonCompatibilityCampaignPlanner(options))
      .rejects.toThrow(/current deployment state plan contract/);
  });

  test("parses a narrow CLI and rejects missing, duplicate, or unknown options", () => {
    expect(parseJsonCompatibilityDeploymentStatePlannerArgs([
      "--inventory", "inventory.json",
      "--out", "plan.json",
      "--json",
    ])).toEqual({
      inventoryPath: "inventory.json",
      outPath: "plan.json",
      json: true,
    });
    expect(parseJsonCompatibilityDeploymentStatePlannerArgs(["--help"]))
      .toEqual({ help: true });
    expect(() => parseJsonCompatibilityDeploymentStatePlannerArgs([
      "--inventory", "inventory.json",
    ])).toThrow(/--out is required/);
    expect(() => parseJsonCompatibilityDeploymentStatePlannerArgs([
      "--inventory", "one.json",
      "--inventory", "two.json",
      "--out", "plan.json",
    ])).toThrow(/must not be repeated/);
    expect(() => parseJsonCompatibilityDeploymentStatePlannerArgs([
      "--inventory", "inventory.json",
      "--out", "plan.json",
      "--secret", "no",
    ])).toThrow(/unknown option/);
  });
});

async function buildFixture(root) {
  const artifacts = {};
  artifacts.controller = {
    dark: await copyTrackedConfig(
      root,
      "controller-dark.jsonc",
      "services/container-controller/wrangler.staging.jsonc",
    ),
    execution: await prepareConfig(
      root,
      "controller-execution.jsonc",
      prepareJsonCompatibilityControllerConfig,
      {},
    ),
  };
  artifacts.executor = {
    dark: await copyTrackedConfig(
      root,
      "executor-dark.jsonc",
      "services/container-runtime-json-compatibility-executor/wrangler.staging.jsonc",
    ),
    execution: await prepareConfig(
      root,
      "executor-execution.jsonc",
      prepareJsonCompatibilityExecutorConfig,
      {
        permitKeyId: INVOKER_EXECUTION_AUTHORITY.permitKeyId,
        permitSpkiSha256: INVOKER_EXECUTION_AUTHORITY.permitSpkiSha256,
      },
    ),
  };
  artifacts.permitIssuer = {
    dark: await copyTrackedConfig(
      root,
      "permit-issuer-dark.jsonc",
      "services/container-runtime-json-compatibility-permit-issuer/wrangler.staging.jsonc",
    ),
    execution: await prepareConfig(
      root,
      "permit-issuer-execution.jsonc",
      prepareJsonCompatibilityPermitIssuerConfig,
      {
        authorityCurrentKid: INVOKER_EXECUTION_AUTHORITY.issuerHmacKid,
        authorityCurrentCredentialIdSha256:
          INVOKER_EXECUTION_AUTHORITY.issuerHmacCredentialIdSha256,
        permitKeyId: INVOKER_EXECUTION_AUTHORITY.permitKeyId,
        permitSpkiSha256: INVOKER_EXECUTION_AUTHORITY.permitSpkiSha256,
      },
    ),
  };
  artifacts.invoker = {
    dark: await prepareConfig(
      root,
      "invoker-dark.jsonc",
      prepareJsonCompatibilityInvokerConfig,
      { deploymentState: "dark" },
    ),
    statusOnly: await prepareConfig(
      root,
      "invoker-status.jsonc",
      prepareJsonCompatibilityInvokerConfig,
      { deploymentState: "status-only", ...STATUS_AUTHORITY },
    ),
    execution: await prepareConfig(
      root,
      "invoker-execution.jsonc",
      prepareJsonCompatibilityInvokerConfig,
      {
        deploymentState: "execution",
        ...STATUS_AUTHORITY,
        ...INVOKER_EXECUTION_AUTHORITY,
      },
    ),
  };
  artifacts.operator = {
    dark: await prepareConfig(
      root,
      "operator-dark.jsonc",
      prepareJsonCompatibilityOperatorConfig,
      { deploymentState: "dark" },
    ),
    statusOnly: await prepareConfig(
      root,
      "operator-status.jsonc",
      prepareJsonCompatibilityOperatorConfig,
      { deploymentState: "status-only", ...OPERATOR_STATUS_AUTHORITY },
    ),
    execution: await prepareConfig(
      root,
      "operator-execution.jsonc",
      prepareJsonCompatibilityOperatorConfig,
      {
        deploymentState: "execution",
        ...OPERATOR_STATUS_AUTHORITY,
        ...OPERATOR_EXECUTION_AUTHORITY,
      },
    ),
  };
  artifacts.runner = {
    dark: await prepareConfig(
      root,
      "runner-dark.jsonc",
      prepareJsonCompatibilityRunnerConfig,
      { deploymentState: "dark" },
    ),
    statusOnly: await prepareConfig(
      root,
      "runner-status.jsonc",
      prepareJsonCompatibilityRunnerConfig,
      {
        deploymentState: "status-only",
        operatorVersionId: "operator-status-version-2026-08",
      },
    ),
    execution: await prepareConfig(
      root,
      "runner-execution.jsonc",
      prepareJsonCompatibilityRunnerConfig,
      {
        deploymentState: "execution",
        operatorVersionId: "operator-execution-version-2026-08",
      },
    ),
  };
  artifacts.caller = {
    dark: await prepareConfig(
      root,
      "caller-dark.jsonc",
      prepareJsonCompatibilityCallerConfig,
      { deploymentState: "dark" },
    ),
    statusOnly: await prepareConfig(
      root,
      "caller-status.jsonc",
      prepareJsonCompatibilityCallerConfig,
      {
        deploymentState: "status-only",
        runnerVersionId: "runner-status-version-2026-08",
        runnerConfigSha256: DIGEST("a"),
      },
    ),
    execution: await prepareConfig(
      root,
      "caller-execution.jsonc",
      prepareJsonCompatibilityCallerConfig,
      {
        deploymentState: "execution",
        runnerVersionId: "runner-execution-version-2026-08",
        runnerConfigSha256: DIGEST("b"),
      },
    ),
  };

  const services = {};
  const inventoryServices = {};
  for (const [role, states] of Object.entries(artifacts)) {
    services[role] = {};
    inventoryServices[role] = {};
    for (const [state, artifact] of Object.entries(states)) {
      const versionId = `${role}-${state}-version-2026-08`;
      services[role][state] = {
        versionId,
        config: artifact.config,
      };
      inventoryServices[role][state] = {
        versionId,
        configPath: path.relative(root, artifact.path).replaceAll("\\", "/"),
      };
    }
  }
  return {
    services,
    inventory: {
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_INVENTORY_CONTRACT,
      environment: "staging",
      services: inventoryServices,
    },
  };
}

async function prepareConfig(root, name, prepare, options) {
  const outPath = path.join(root, name);
  await prepare({ outPath, ...options });
  return {
    path: outPath,
    config: JSON.parse(await readFile(outPath, "utf8")),
  };
}

async function copyTrackedConfig(root, name, sourcePath) {
  const config = JSON.parse(await readFile(path.resolve(sourcePath), "utf8"));
  const outPath = path.join(root, name);
  await writeFile(outPath, canonicalJson(config), "utf8");
  return { path: outPath, config };
}

function resign(plan) {
  const { planDigestSha256: _ignored, ...subject } = plan;
  return {
    ...subject,
    planDigestSha256: sha256Canonical(subject),
  };
}

function campaignPlannerOptions(
  deploymentPlan,
  deploymentStatePlanPath,
  configPath,
  outPath,
) {
  const execution = Object.fromEntries(
    Object.entries(deploymentPlan.services).map(([role, service]) => [
      role,
      service.artifacts.execution,
    ]),
  );
  return {
    configPath,
    deploymentStatePlanPath,
    outPath,
    campaignIdSha256: DIGEST("b"),
    controllerVersionId: execution.controller.versionId,
    callerVersionId: execution.caller.versionId,
    callerConfigSha256: execution.caller.configSha256,
    runnerVersionId: execution.runner.versionId,
    runnerConfigSha256: execution.runner.configSha256,
    operatorVersionId: execution.operator.versionId,
    operatorConfigSha256: execution.operator.configSha256,
    operatorHmacKeyId: OPERATOR_EXECUTION_AUTHORITY.currentKid,
    operatorHmacCredentialIdSha256:
      OPERATOR_EXECUTION_AUTHORITY.currentCredentialIdSha256,
    operatorStatusHmacKeyId: OPERATOR_STATUS_AUTHORITY.statusCurrentKid,
    operatorStatusHmacCredentialIdSha256:
      OPERATOR_STATUS_AUTHORITY.statusCurrentCredentialIdSha256,
    operatorApprovalKeyId: OPERATOR_STATUS_AUTHORITY.approvalCurrentKid,
    operatorApprovalSpkiSha256:
      OPERATOR_STATUS_AUTHORITY.approvalCurrentSpkiSha256,
    invokerVersionId: execution.invoker.versionId,
    invokerConfigSha256: execution.invoker.configSha256,
    permitIssuerVersionId: execution.permitIssuer.versionId,
    permitIssuerConfigSha256: execution.permitIssuer.configSha256,
    executorVersionId: execution.executor.versionId,
    executorConfigSha256: execution.executor.configSha256,
    runtimeNBuildIdSha256: DIGEST("6"),
    runtimeNImageDigest: `sha256:${DIGEST("7")}`,
    runtimeNMinusOneBuildIdSha256: DIGEST("8"),
    runtimeNMinusOneImageDigest: `sha256:${DIGEST("9")}`,
    candidateShardIndex: 3,
  };
}
