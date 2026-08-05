import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseJsonCompatibilityInvokerConfigArgs,
  prepareJsonCompatibilityInvokerConfig,
  validateJsonCompatibilityInvokerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_invoker_config.mjs";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-invoker",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};
const COMPATIBILITY_DATE = "2026-08-04";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const ISSUER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const PERMIT_ISSUER = "cinatoken-json-compatibility-permit-issuer-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
const STATUS_OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-status-staging";
const SECRET_BINDINGS = [
  "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
  "JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET",
  "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET",
  "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_SECRET",
  "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
  "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
];
const temporaryDirectories = [];
const digest = (byte) => byte.repeat(64);
const STATUS_IDENTITIES = {
  statusOperatorCurrentKid: "operator-status-2026-08",
  statusOperatorCurrentCredentialIdSha256: digest("8"),
};
const EXECUTION_IDENTITIES = {
  operatorCurrentKid: "operator-2026-08",
  operatorCurrentCredentialIdSha256: digest("3"),
  ...STATUS_IDENTITIES,
  issuerHmacKid: "invoker-issuer-2026-08",
  issuerHmacCredentialIdSha256: digest("4"),
  permitKeyId: "permit-ed25519-2026-08",
  permitSpkiSha256: digest("2"),
};
const IDENTITY_VARS = {
  JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: "operatorCurrentKid",
  JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
    "operatorCurrentCredentialIdSha256",
  JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: null,
  JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: null,
  JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID:
    "statusOperatorCurrentKid",
  JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
    "statusOperatorCurrentCredentialIdSha256",
  JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: null,
  JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
    null,
  JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID: "issuerHmacKid",
  JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256:
    "issuerHmacCredentialIdSha256",
  JSON_COMPATIBILITY_PERMIT_KEY_ID: "permitKeyId",
  JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: "permitSpkiSha256",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JSON compatibility private invoker Wrangler config", () => {
  test("keeps exactly local and staging configs and omits production", async () => {
    const filenames = (await readdir(SERVICE_DIR))
      .filter((name) => /^wrangler(?:\.[^.]+)?\.(?:jsonc|json|toml)$/.test(name))
      .sort();

    expect(filenames).toEqual(Object.values(CONFIG_FILES).sort());
  });

  for (const environment of Object.keys(CONFIG_FILES)) {
    test(`${environment} is private, disabled, and RPC-only`, async () => {
      const config = await trackedConfig(environment);
      const workerName =
        `cinatoken-container-runtime-json-compatibility-invoker-${environment}`;

      expect(commonTopLevelKeys(config)).toEqual([
        "$schema",
        "compatibility_date",
        "durable_objects",
        "main",
        "migrations",
        "name",
        "observability",
        "preview_urls",
        "services",
        "vars",
        "version_metadata",
        "workers_dev",
      ]);
      expect(config).toMatchObject({
        name: workerName,
        main: "src/index.ts",
        compatibility_date: COMPATIBILITY_DATE,
        workers_dev: false,
        preview_urls: false,
        observability: { enabled: true, head_sampling_rate: 1 },
        version_metadata: { binding: "CF_VERSION_METADATA" },
      });
      expectOptionalNodeCompatibility(config);
      expect(config.services).toEqual([
        {
          binding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
          service: ISSUER_SERVICE,
          entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
        },
        {
          binding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
          service: EXECUTOR_SERVICE,
          entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
        },
      ]);
      expect(config.durable_objects).toEqual({
        bindings: [
          {
            name: "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
            class_name: "JsonCompatibilityInvocationAuthority",
          },
        ],
      });
      expect(config.migrations).toEqual([
        {
          tag: "v1",
          new_sqlite_classes: ["JsonCompatibilityInvocationAuthority"],
        },
      ]);
      expect(config.vars).toEqual({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_INVOKER_ENABLED: "false",
        JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED: "false",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_ISSUER:
          STATUS_OPERATOR_ISSUER,
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID: "",
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER: INVOKER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE: ISSUER_SERVICE,
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID: "",
        JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_PERMIT_ISSUER: PERMIT_ISSUER,
        JSON_COMPATIBILITY_PERMIT_AUDIENCE: EXECUTOR_SERVICE,
        JSON_COMPATIBILITY_PERMIT_KEY_ID: "",
        JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: "",
      });
      for (const binding of SECRET_BINDINGS) {
        expect(config.vars).not.toHaveProperty(binding);
      }
    });
  }
});

describe("JSON compatibility private invoker deployment state preparer", () => {
  const profiles = [
    {
      deploymentState: "dark",
      identities: {},
      executionEnabled: false,
      statusReadEnabled: false,
      changedVars: [],
      secretsRequired: [],
    },
    {
      deploymentState: "status-only",
      identities: STATUS_IDENTITIES,
      executionEnabled: false,
      statusReadEnabled: true,
      changedVars: [
        "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID",
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
      ],
      secretsRequired: [
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET",
      ],
    },
    {
      deploymentState: "execution",
      identities: EXECUTION_IDENTITIES,
      executionEnabled: true,
      statusReadEnabled: true,
      changedVars: [
        "JSON_COMPATIBILITY_INVOKER_ENABLED",
        "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_KID",
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
        "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID",
        "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
        "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID",
        "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256",
        "JSON_COMPATIBILITY_PERMIT_KEY_ID",
        "JSON_COMPATIBILITY_PERMIT_SPKI_SHA256",
      ],
      secretsRequired: [
        "JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET",
        "JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET",
        "JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET",
        "JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL",
      ],
    },
  ];

  for (const profile of profiles) {
    test(`prepares the ${profile.deploymentState} deployment state`, async () => {
      const outPath = await temporaryFile(`${profile.deploymentState}.jsonc`);
      const options = {
        outPath,
        deploymentState: profile.deploymentState,
        ...profile.identities,
      };
      const result = await prepareJsonCompatibilityInvokerConfig(options);
      const source = await readFile(outPath, "utf8");
      const config = JSON.parse(source);

      expect(config.vars.JSON_COMPATIBILITY_INVOKER_ENABLED).toBe(
        profile.executionEnabled ? "true" : "false",
      );
      expect(config.vars.JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED).toBe(
        profile.statusReadEnabled ? "true" : "false",
      );
      expect(identityVars(config.vars)).toEqual(
        expectedIdentityVars(profile.identities),
      );
      expect(validateJsonCompatibilityInvokerConfig(config, options)).toMatchObject({
        deploymentState: profile.deploymentState,
        enabled: profile.executionEnabled,
        executionEnabled: profile.executionEnabled,
        statusReadEnabled: profile.statusReadEnabled,
        privateServiceBindings: true,
      });
      expect(result).toMatchObject({
        ok: true,
        deploymentState: profile.deploymentState,
        executionEnabled: profile.executionEnabled,
        statusReadEnabled: profile.statusReadEnabled,
        changedVars: profile.changedVars,
        secretsRequired: profile.secretsRequired,
        credentialsRead: false,
        networkRequestsPerformed: false,
        deploymentMutationPerformed: false,
      });
      expect(source).not.toContain("SECRET");
      expect(source).not.toContain("PKCS8");
    });
  }

  test("defaults omitted CLI and API deployment state to execution", async () => {
    const parsed = parseJsonCompatibilityInvokerConfigArgs([
      "--out", "execution.jsonc",
      ...executionCliIdentityArgs(),
    ]);
    expect(parsed.deploymentState).toBe("execution");

    const outPath = await temporaryFile("default-execution.jsonc");
    const result = await prepareJsonCompatibilityInvokerConfig({
      outPath,
      ...EXECUTION_IDENTITIES,
    });
    expect(result).toMatchObject({
      deploymentState: "execution",
      executionEnabled: true,
      statusReadEnabled: true,
    });
  });

  test("parses exactly the three explicit deployment states", () => {
    expect(parseJsonCompatibilityInvokerConfigArgs([
      "--out", "dark.jsonc",
      "--deployment-state", "dark",
    ])).toMatchObject({ deploymentState: "dark" });
    expect(parseJsonCompatibilityInvokerConfigArgs([
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliIdentityArgs(),
    ])).toMatchObject({
      deploymentState: "status-only",
      ...STATUS_IDENTITIES,
    });
    expect(parseJsonCompatibilityInvokerConfigArgs([
      "--out", "execution.jsonc",
      "--deployment-state", "execution",
      ...executionCliIdentityArgs(),
    ])).toMatchObject({
      deploymentState: "execution",
      ...EXECUTION_IDENTITIES,
    });
  });

  test("requires every identity selected by status-only and execution", async () => {
    for (const missing of Object.keys(STATUS_IDENTITIES)) {
      const identities = { ...STATUS_IDENTITIES };
      delete identities[missing];
      await expect(prepareJsonCompatibilityInvokerConfig({
        outPath: await temporaryFile(`status-missing-${missing}.jsonc`),
        deploymentState: "status-only",
        ...identities,
      })).rejects.toThrow();
    }
    for (const missing of Object.keys(EXECUTION_IDENTITIES)) {
      const identities = { ...EXECUTION_IDENTITIES };
      delete identities[missing];
      await expect(prepareJsonCompatibilityInvokerConfig({
        outPath: await temporaryFile(`execution-missing-${missing}.jsonc`),
        deploymentState: "execution",
        ...identities,
      })).rejects.toThrow();
    }
  });

  test("forbids every identity in dark and execution identities in status-only", async () => {
    for (const [name, value] of Object.entries(EXECUTION_IDENTITIES)) {
      await expect(prepareJsonCompatibilityInvokerConfig({
        outPath: await temporaryFile(`dark-forbidden-${name}.jsonc`),
        deploymentState: "dark",
        [name]: value,
      })).rejects.toThrow(/forbidden for deployment state dark/u);
    }
    const executionOnlyIdentities = Object.fromEntries(
      Object.entries(EXECUTION_IDENTITIES)
        .filter(([name]) => !(name in STATUS_IDENTITIES)),
    );
    for (const [name, value] of Object.entries(executionOnlyIdentities)) {
      await expect(prepareJsonCompatibilityInvokerConfig({
        outPath: await temporaryFile(`status-forbidden-${name}.jsonc`),
        deploymentState: "status-only",
        ...STATUS_IDENTITIES,
        [name]: value,
      })).rejects.toThrow(/forbidden for deployment state status-only/u);
    }
  });

  test("rejects invalid states and state-forbidden CLI inputs", () => {
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--out", "invalid.jsonc",
      "--deployment-state", "disabled",
    ])).toThrow(/must be one of: dark, status-only, execution/u);
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--out", "dark.jsonc",
      "--deployment-state", "dark",
      "--status-operator-current-kid", STATUS_IDENTITIES.statusOperatorCurrentKid,
    ])).toThrow(/forbidden for deployment state dark/u);
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliIdentityArgs(),
      "--permit-key-id", EXECUTION_IDENTITIES.permitKeyId,
    ])).toThrow(/forbidden for deployment state status-only/u);
  });

  test("rejects invalid API state before creating output", async () => {
    const outPath = await temporaryFile("invalid-api-state.jsonc");
    await expect(prepareJsonCompatibilityInvokerConfig({
      outPath,
      deploymentState: "disabled",
    })).rejects.toThrow(/must be one of: dark, status-only, execution/u);
    await expect(readFile(outPath, "utf8")).rejects.toThrow();
  });

  test("retains strict CLI rejection for unknown and repeated arguments", () => {
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--out", "dark.jsonc",
      "--deployment-state", "dark",
      "--unexpected", "value",
    ])).toThrow(/unknown option/u);
    expect(() => parseJsonCompatibilityInvokerConfigArgs([
      "--out", "dark.jsonc",
      "--deployment-state", "dark",
      "--deployment-state", "dark",
    ])).toThrow(/must not be repeated/u);
  });

  test("retains create-only output and fail-closed base validation", async () => {
    const existingOutPath = await temporaryFile("existing.jsonc");
    await writeFile(existingOutPath, "sentinel", "utf8");
    await expect(prepareJsonCompatibilityInvokerConfig({
      outPath: existingOutPath,
      deploymentState: "dark",
    })).rejects.toThrow();
    expect(await readFile(existingOutPath, "utf8")).toBe("sentinel");

    const unsafeBase = await trackedConfig("staging");
    unsafeBase.vars.JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED = "true";
    const unsafeBasePath = await temporaryFile("unsafe-base.jsonc");
    await writeFile(unsafeBasePath, JSON.stringify(unsafeBase), "utf8");
    await expect(prepareJsonCompatibilityInvokerConfig({
      basePath: unsafeBasePath,
      outPath: await temporaryFile("unsafe-base-output.jsonc"),
      deploymentState: "dark",
    })).rejects.toThrow(/invoker vars does not match/u);
  });
});

async function trackedConfig(environment) {
  const filename = CONFIG_FILES[environment];
  return JSON.parse(await readFile(path.join(SERVICE_DIR, filename), "utf8"));
}

function commonTopLevelKeys(config) {
  return Object.keys(config)
    .filter((key) => key !== "compatibility_flags")
    .sort();
}

function expectOptionalNodeCompatibility(config) {
  if ("compatibility_flags" in config) {
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
  }
}

async function temporaryFile(name) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-invoker-config-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

function identityVars(vars) {
  return Object.fromEntries(
    Object.keys(IDENTITY_VARS).map((name) => [name, vars[name]]),
  );
}

function expectedIdentityVars(identities) {
  return Object.fromEntries(
    Object.entries(IDENTITY_VARS).map(([name, identity]) => [
      name,
      identity === null ? "" : identities[identity] ?? "",
    ]),
  );
}

function statusCliIdentityArgs() {
  return [
    "--status-operator-current-kid",
    STATUS_IDENTITIES.statusOperatorCurrentKid,
    "--status-operator-current-credential-id-sha256",
    STATUS_IDENTITIES.statusOperatorCurrentCredentialIdSha256,
  ];
}

function executionCliIdentityArgs() {
  return [
    "--operator-current-kid",
    EXECUTION_IDENTITIES.operatorCurrentKid,
    "--operator-current-credential-id-sha256",
    EXECUTION_IDENTITIES.operatorCurrentCredentialIdSha256,
    ...statusCliIdentityArgs(),
    "--issuer-hmac-kid",
    EXECUTION_IDENTITIES.issuerHmacKid,
    "--issuer-hmac-credential-id-sha256",
    EXECUTION_IDENTITIES.issuerHmacCredentialIdSha256,
    "--permit-key-id",
    EXECUTION_IDENTITIES.permitKeyId,
    "--permit-spki-sha256",
    EXECUTION_IDENTITIES.permitSpkiSha256,
  ];
}
