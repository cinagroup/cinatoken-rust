import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  CONTROLLER_DEPLOY_ENVIRONMENTS,
  REQUIRED_CONTROLLER_SECRET,
  REQUIRED_DISABLED_CONTROLLER_VARS,
  REQUIRED_DISABLED_RING_TRANSITION_VARS,
  REQUIRED_PROVIDER_EGRESS_SECRET,
  buildWranglerSecretInventoryCommands,
  parseCliArguments,
  parseControllerWranglerJsonc,
  parseWranglerSecretInventory,
  requireSecretNames,
  runContainerControllerDeployPreflight,
  validateControllerConfig,
  validateSecretInventoryResult,
} from "../tools/preflight_container_controller_deploy.mjs";

const NONZERO_D1_ID = "11111111-2222-4333-8444-555555555555";
const NONZERO_KV_ID = "11111111222233334444555555555555";

function validConfig(environment) {
  const contract = CONTROLLER_DEPLOY_ENVIRONMENTS[environment];
  return {
    name: contract.controllerName,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ENVIRONMENT: environment,
      CONTAINER_CONTROLLER_SERVICE_NAME: contract.controllerName,
      ...Object.fromEntries(
        REQUIRED_DISABLED_CONTROLLER_VARS.map((name) => [name, "false"]),
      ),
      ...Object.fromEntries(
        REQUIRED_DISABLED_RING_TRANSITION_VARS.map((name) => [name, "0"]),
      ),
      CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED: "false",
      CONTAINER_DURABLE_OBJECT_JURISDICTION: "default",
      CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID: "",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: contract.databaseName,
        database_id: NONZERO_D1_ID,
      },
    ],
    kv_namespaces: [{ binding: "CONFIG_KV", id: NONZERO_KV_ID }],
    r2_buckets: [
      { binding: "FILE_BUCKET", bucket_name: contract.r2BucketName },
    ],
    services: [
      {
        binding: "PROVIDER_EGRESS",
        service: contract.providerEgressService,
      },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

describe("Container Controller deploy config validation", () => {
  for (const environment of ["staging", "production"]) {
    test(`accepts a complete ${environment} identity contract`, () => {
      const report = validateControllerConfig(
        validConfig(environment),
        environment,
      );

      expect(report).toMatchObject({
        environment,
        controllerName:
          CONTROLLER_DEPLOY_ENVIRONMENTS[environment].controllerName,
        providerEgressWorker:
          CONTROLLER_DEPLOY_ENVIRONMENTS[environment].providerEgressService,
        identities: {
          durableObject: {
            binding: "RELAY_SHARDS",
            jurisdiction: "default",
          },
          database: { binding: "DB", id: "validated" },
          kvNamespace: { binding: "CONFIG_KV", id: "validated" },
          r2Bucket: { binding: "FILE_BUCKET" },
          providerEgress: { binding: "PROVIDER_EGRESS" },
        },
      });
      expect(JSON.stringify(report)).not.toContain(NONZERO_D1_ID);
      expect(JSON.stringify(report)).not.toContain(NONZERO_KV_ID);
    });
  }

  test("parses the tracked strict-JSON flavor and rejects JSONC extensions", () => {
    expect(
      parseControllerWranglerJsonc(JSON.stringify(validConfig("staging"))),
    ).toEqual(validConfig("staging"));
    expect(() =>
      parseControllerWranglerJsonc('{"name":"controller",}'),
    ).toThrow(/valid strict JSON/);
    expect(() =>
      parseControllerWranglerJsonc('{/* comment */"name":"controller"}'),
    ).toThrow(/valid strict JSON/);
  });

  test("requires an explicit deploy environment and exact Controller name", () => {
    expect(() => validateControllerConfig(validConfig("staging"), "local")).toThrow(
      /exactly staging or production/,
    );

    const config = validConfig("staging");
    config.name = CONTROLLER_DEPLOY_ENVIRONMENTS.production.controllerName;
    expect(() => validateControllerConfig(config, "staging")).toThrow(
      /Controller name for staging/,
    );
  });

  test("requires private entrypoints, observability, and every action gate false", () => {
    for (const mutate of [
      (config) => {
        config.workers_dev = true;
      },
      (config) => {
        config.preview_urls = true;
      },
      (config) => {
        config.observability.enabled = false;
      },
      (config) => {
        config.vars.CONTAINER_EXECUTION_ENABLED = "true";
      },
      (config) => {
        delete config.vars.CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED;
      },
    ]) {
      const config = validConfig("staging");
      mutate(config);
      expect(() => validateControllerConfig(config, "staging")).toThrow();
    }

    const futureGate = validConfig("staging");
    futureGate.vars.CONTAINER_FUTURE_ACTION_ENABLED = "true";
    expect(() => validateControllerConfig(futureGate, "staging")).toThrow(
      /action gate.*must remain false/,
    );
  });

  test("allows only the isolated JSON probe gate in explicit staging campaign mode", () => {
    const campaign = validConfig("staging");
    campaign.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
    expect(
      validateControllerConfig(campaign, "staging", {
        jsonCompatibilityCampaign: true,
      }),
    ).toMatchObject({
      environment: "staging",
      jsonCompatibilityCampaign: true,
      jsonCompatibilityProbeEnabled: true,
    });
    expect(() => validateControllerConfig(campaign, "staging")).toThrow(
      /CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED/,
    );

    const unarmed = validConfig("staging");
    expect(() =>
      validateControllerConfig(unarmed, "staging", {
        jsonCompatibilityCampaign: true,
      }),
    ).toThrow(/CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED/);

    const unsafe = structuredClone(campaign);
    unsafe.vars.CONTAINER_EXECUTION_ENABLED = "true";
    expect(() =>
      validateControllerConfig(unsafe, "staging", {
        jsonCompatibilityCampaign: true,
      }),
    ).toThrow(/CONTAINER_EXECUTION_ENABLED/);

    const production = validConfig("production");
    production.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
    expect(() =>
      validateControllerConfig(production, "production", {
        jsonCompatibilityCampaign: true,
      }),
    ).toThrow(/staging-only/);
  });

  test("pins deployment preflight to the default Durable Object jurisdiction", () => {
    for (const value of ["eu", "us", "fedramp", "fedramp-high", "", "DEFAULT"]) {
      const config = validConfig("staging");
      config.vars.CONTAINER_DURABLE_OBJECT_JURISDICTION = value;
      expect(() => validateControllerConfig(config, "staging")).toThrow(
        /CONTAINER_DURABLE_OBJECT_JURISDICTION/,
      );
    }
  });

  test("rejects REPLACE_WITH_* placeholders anywhere in the supplied config", () => {
    const config = validConfig("production");
    config.d1_databases[0].database_id =
      "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID";
    expect(() => validateControllerConfig(config, "production")).toThrow(
      /unsafe REPLACE_WITH_\* placeholder.*database_id/,
    );
  });

  test("rejects zero D1 and KV identifier placeholders", () => {
    const zeroD1 = validConfig("staging");
    zeroD1.d1_databases[0].database_id =
      "00000000-0000-0000-0000-000000000000";
    expect(() => validateControllerConfig(zeroD1, "staging")).toThrow(
      /zero identifier placeholder.*database_id/,
    );

    const zeroKv = validConfig("staging");
    zeroKv.kv_namespaces[0].id = "00000000000000000000000000000000";
    expect(() => validateControllerConfig(zeroKv, "staging")).toThrow(
      /zero identifier placeholder.*kv_namespaces\[0\]\.id/,
    );
  });

  test("rejects malformed non-placeholder resource IDs", () => {
    const badD1 = validConfig("staging");
    badD1.d1_databases[0].database_id = "not-a-d1-id";
    expect(() => validateControllerConfig(badD1, "staging")).toThrow(
      /DB database_id has an invalid format/,
    );

    const badKv = validConfig("staging");
    badKv.kv_namespaces[0].id = "abc123";
    expect(() => validateControllerConfig(badKv, "staging")).toThrow(
      /CONFIG_KV id has an invalid format/,
    );
  });

  test("requires exact DB, KV, R2, and provider-egress identities", () => {
    const cases = [
      [
        "DB",
        (config) => {
          config.d1_databases[0].database_name = "wrong-db";
        },
      ],
      [
        "CONFIG_KV",
        (config) => {
          config.kv_namespaces[0].binding = "OTHER_KV";
        },
      ],
      [
        "FILE_BUCKET",
        (config) => {
          config.r2_buckets[0].bucket_name = "wrong-bucket";
        },
      ],
      [
        "PROVIDER_EGRESS",
        (config) => {
          config.services[0].service = "wrong-service";
        },
      ],
    ];

    for (const [expectedMessage, mutate] of cases) {
      const config = validConfig("staging");
      mutate(config);
      expect(() => validateControllerConfig(config, "staging")).toThrow(
        expectedMessage,
      );
    }
  });

  test("fails closed on duplicate or unexpected additional bindings", () => {
    const config = validConfig("staging");
    config.services.push(clone(config.services[0]));
    expect(() => validateControllerConfig(config, "staging")).toThrow(
      /only the required binding PROVIDER_EGRESS/,
    );

    const extraService = validConfig("staging");
    extraService.services.push({ binding: "UNEXPECTED", service: "other-worker" });
    expect(() => validateControllerConfig(extraService, "staging")).toThrow(
      /only the required binding PROVIDER_EGRESS/,
    );
  });
});

describe("Wrangler secret inventory validation", () => {
  test("keeps only secret names and never returns inventory values", () => {
    const rawValue = "controller-secret-value-that-must-not-escape";
    const names = parseWranglerSecretInventory(
      JSON.stringify([
        { name: REQUIRED_CONTROLLER_SECRET, type: "secret_text", value: rawValue },
      ]),
      "Controller",
    );

    expect(names).toEqual([REQUIRED_CONTROLLER_SECRET]);
    expect(JSON.stringify(names)).not.toContain(rawValue);
    expect(
      requireSecretNames(names, [REQUIRED_CONTROLLER_SECRET], "Controller"),
    ).toEqual([REQUIRED_CONTROLLER_SECRET]);
    expect(() =>
      requireSecretNames(
        [REQUIRED_CONTROLLER_SECRET, "UNRELATED_SECRET"],
        [REQUIRED_CONTROLLER_SECRET],
        "Controller",
      ),
    ).toThrow(/unexpected secret name/);
  });

  test("rejects missing names, malformed output, and command failures", () => {
    expect(() =>
      validateSecretInventoryResult(
        { exitCode: 0, stdout: "[]" },
        {
          workerLabel: "Controller",
          requiredNames: [REQUIRED_CONTROLLER_SECRET],
        },
      ),
    ).toThrow(REQUIRED_CONTROLLER_SECRET);
    expect(() =>
      validateSecretInventoryResult(
        { exitCode: 0, stdout: "not-json" },
        {
          workerLabel: "Controller",
          requiredNames: [REQUIRED_CONTROLLER_SECRET],
        },
      ),
    ).toThrow(/not valid JSON/);
    expect(() =>
      validateSecretInventoryResult(
        { exitCode: 1, stdout: "sensitive output", stderr: "sensitive error" },
        {
          workerLabel: "Controller",
          requiredNames: [REQUIRED_CONTROLLER_SECRET],
        },
      ),
    ).toThrow("Controller secret inventory command failed");
    expect(() =>
      validateSecretInventoryResult(
        { exitCode: null, stdout: "", timedOut: true },
        {
          workerLabel: "Controller",
          requiredNames: [REQUIRED_CONTROLLER_SECRET],
        },
      ),
    ).toThrow(/did not complete safely/);
    expect(() =>
      validateSecretInventoryResult(
        { exitCode: 0, stdout: "", invalidUtf8: true },
        {
          workerLabel: "Controller",
          requiredNames: [REQUIRED_CONTROLLER_SECRET],
        },
      ),
    ).toThrow(/did not complete safely/);
  });
});

describe("Container Controller deploy preflight orchestration", () => {
  test("tracked deploy scripts cannot bypass preflight and production remains blocked", async () => {
    const packageJson = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    expect(packageJson.scripts["deploy:container-controller:staging"]).toStartWith(
      "bun run preflight:container-controller:staging && ",
    );
    expect(packageJson.scripts["deploy:container-controller:production"]).toStartWith(
      "bun run preflight:container-controller:production && ",
    );
    expect(packageJson.scripts.check).toContain(
      "bun run check:container-controller:deploy-preflight",
    );

    const productionConfig = parseControllerWranglerJsonc(
      await Bun.file(
        new URL(
          "../services/container-controller/wrangler.production.jsonc",
          import.meta.url,
        ),
      ).text(),
    );
    expect(() => validateControllerConfig(productionConfig, "production")).toThrow(
      /REPLACE_WITH_\* placeholder/,
    );
  });

  test("plans only argument-array Wrangler secret list commands", () => {
    const cwd = path.resolve("repo path with spaces");
    const commands = buildWranglerSecretInventoryCommands({
      environment: "staging",
      controllerConfigPath: "controller config.jsonc",
      providerEgressConfigPath: "provider egress.toml",
      runtimeExecutable: "runtime-executable",
      wranglerCliPath: "wrangler cli.js",
      cwd,
    });

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.command).toBe("runtime-executable");
      expect(Array.isArray(command.args)).toBe(true);
      expect(command.args.slice(1, 3)).toEqual(["secret", "list"]);
      expect(command.args).not.toContain("deploy");
      expect(command.args).not.toContain("put");
      expect(command.args).not.toContain("delete");
      expect(command.args).toContain("--format");
      expect(command.args).toContain("json");
    }
    expect(commands[0].args).not.toContain("--env");
    expect(commands[1].args).toContain("--env");
    expect(commands[1].args).toContain("staging");
    expect(commands[0].args).toContain(
      path.join(cwd, "controller config.jsonc"),
    );
  });

  test("offline and self-test modes never invoke a subprocess", async () => {
    for (const mode of [{ offline: true }, { selfTest: true }]) {
      let commandCalls = 0;
      const report = await runContainerControllerDeployPreflight(
        {
          ...mode,
          environment: "staging",
          controllerConfigSource: JSON.stringify(validConfig("staging")),
        },
        {
          runCommand: async () => {
            commandCalls += 1;
            throw new Error("must not run");
          },
        },
      );

      expect(commandCalls).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.readyForDeploy).toBe(false);
      expect(report.secretInventories.status).toBe("skipped");
    }
  });

  test("live mode verifies both injected inventories and drops values", async () => {
    const controllerValue = "controller-value-must-not-escape";
    const providerValue = "provider-value-must-not-escape";
    const results = [
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: REQUIRED_CONTROLLER_SECRET, value: controllerValue },
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { name: REQUIRED_PROVIDER_EGRESS_SECRET, value: providerValue },
        ]),
      },
    ];
    const calls = [];

    const report = await runContainerControllerDeployPreflight(
      {
        environment: "production",
        controllerConfigPath: "controller production.jsonc",
        controllerConfigSource: JSON.stringify(validConfig("production")),
        providerEgressConfigPath: "provider egress.toml",
        runtimeExecutable: "runtime-executable",
        wranglerCliPath: "wrangler cli.js",
      },
      {
        runCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          return results.shift();
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => Array.isArray(call.args))).toBe(true);
    expect(report.readyForDeploy).toBe(true);
    expect(report.secretInventories.status).toBe("verified");
    expect(JSON.stringify(report)).not.toContain(controllerValue);
    expect(JSON.stringify(report)).not.toContain(providerValue);
  });

  test("live mode fails when the provider-egress inventory lacks its secret", async () => {
    const results = [
      {
        exitCode: 0,
        stdout: JSON.stringify([{ name: REQUIRED_CONTROLLER_SECRET }]),
      },
      { exitCode: 0, stdout: "[]" },
    ];

    await expect(
      runContainerControllerDeployPreflight(
        {
          environment: "staging",
          controllerConfigPath: "controller staging.jsonc",
          controllerConfigSource: JSON.stringify(validConfig("staging")),
        },
        {
          runCommand: async () => results.shift(),
        },
      ),
    ).rejects.toThrow(REQUIRED_PROVIDER_EGRESS_SECRET);
  });

  test("CLI parsing requires a supplied production/staging config", () => {
    expect(
      parseCliArguments([
        "--environment=staging",
        "--config",
        "services/container-controller/wrangler.staging.jsonc",
        "--offline",
      ]),
    ).toMatchObject({
      environment: "staging",
      controllerConfigPath:
        "services/container-controller/wrangler.staging.jsonc",
      offline: true,
      jsonCompatibilityCampaign: false,
    });
    expect(
      parseCliArguments([
        "--environment",
        "staging",
        "--config",
        "campaign.jsonc",
        "--json-compatibility-campaign",
      ]),
    ).toMatchObject({ jsonCompatibilityCampaign: true });
    expect(() => parseCliArguments(["--environment", "staging"])).toThrow(
      /--config/,
    );
    expect(() =>
      parseCliArguments(["--environment", "local", "--config", "x.jsonc"]),
    ).toThrow(/exactly staging or production/);
  });
});
