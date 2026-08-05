import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseJsonCompatibilityOperatorConfigArgs,
  prepareJsonCompatibilityOperatorConfig,
  validateJsonCompatibilityOperatorConfig,
} from "../tools/prepare_container_runtime_json_compatibility_operator_config.mjs";

const SERVICE_DIR = path.resolve(
  "services/container-runtime-json-compatibility-operator",
);
const CONFIG_FILES = {
  local: "wrangler.jsonc",
  staging: "wrangler.staging.jsonc",
};
const COMPATIBILITY_DATE = "2026-08-04";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging";
const OPERATOR_STATUS_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-status-staging";
const OPERATOR_APPROVAL_ISSUER =
  "cinatoken-json-compatibility-campaign-approval-authority-staging";
const DIGEST = (character) => character.repeat(64);
const TEMPORARY_DIRECTORIES = [];
const IDENTITY_VARS = [
  "JSON_COMPATIBILITY_OPERATOR_CURRENT_KID",
  "JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
  "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID",
  "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256",
  "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID",
  "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256",
  "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID",
  "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256",
  "JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID",
];

afterEach(async () => {
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JSON compatibility private operator Wrangler config", () => {
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
        `cinatoken-container-runtime-json-compatibility-operator-${environment}`;

      expect(Object.keys(config).sort()).toEqual([
        "$schema",
        "compatibility_date",
        "main",
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
      expect(config.services).toEqual([{
        binding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
        service: INVOKER_SERVICE,
        entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
      }]);
      expect(config.vars).toEqual({
        ENVIRONMENT: environment,
        JSON_COMPATIBILITY_OPERATOR_ENABLED: "false",
        JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED: "false",
        JSON_COMPATIBILITY_OPERATOR_ISSUER: OPERATOR_ISSUER,
        JSON_COMPATIBILITY_OPERATOR_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER:
          OPERATOR_APPROVAL_ISSUER,
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE: workerName.replace(
          /-(?:local|staging)$/u,
          "-staging",
        ),
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID: "",
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256: "",
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256: "",
        JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: "",
        JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_OPERATOR_STATUS_ISSUER: OPERATOR_STATUS_ISSUER,
        JSON_COMPATIBILITY_OPERATOR_STATUS_AUDIENCE: INVOKER_SERVICE,
        JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID: "",
        JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID: "",
      });
      expect(config.vars).not.toHaveProperty(
        "JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET",
      );
      expect(config.vars).not.toHaveProperty(
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_SECRET",
      );
    });
  }
});

async function trackedConfig(environment) {
  const filename = CONFIG_FILES[environment];
  return JSON.parse(await readFile(path.join(SERVICE_DIR, filename), "utf8"));
}

describe("JSON compatibility operator deployable state profiles", () => {
  test("prepares dark, status-only, and backward-compatible execution configs", async () => {
    const darkOutPath = await temporaryPath("operator-dark.jsonc");
    const darkResult = await prepareJsonCompatibilityOperatorConfig({
      outPath: darkOutPath,
      deploymentState: "dark",
    });
    const darkConfig = await preparedConfig(darkOutPath);
    expect(darkResult).toMatchObject({
      deploymentState: "dark",
      executionEnabled: false,
      statusReadEnabled: false,
      changedVars: [],
      secretsRequired: [],
    });
    expect(validateJsonCompatibilityOperatorConfig(darkConfig, {
      deploymentState: "dark",
    })).toMatchObject({
      deploymentState: "dark",
      executionEnabled: false,
      statusReadEnabled: false,
    });
    expect(darkConfig.vars.JSON_COMPATIBILITY_OPERATOR_ENABLED).toBe("false");
    expect(
      darkConfig.vars.JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED,
    ).toBe("false");
    for (const name of IDENTITY_VARS) expect(darkConfig.vars[name]).toBe("");

    const statusOutPath = await temporaryPath("operator-status-only.jsonc");
    const statusOptions = {
      ...statusIdentityOptions(),
      outPath: statusOutPath,
      deploymentState: "status-only",
      approvalPreviousKid: "operator-approval-2026-07",
      approvalPreviousSpkiSha256: DIGEST("7"),
    };
    const statusResult = await prepareJsonCompatibilityOperatorConfig(
      statusOptions,
    );
    const statusConfig = await preparedConfig(statusOutPath);
    expect(statusResult).toMatchObject({
      deploymentState: "status-only",
      executionEnabled: false,
      statusReadEnabled: true,
      changedVars: [
        "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256",
        "JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID",
      ],
      secretsRequired: [
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_SECRET",
      ],
    });
    expect(validateJsonCompatibilityOperatorConfig(
      statusConfig,
      statusOptions,
    )).toMatchObject({
      deploymentState: "status-only",
      executionEnabled: false,
      statusReadEnabled: true,
    });
    expect(statusConfig.vars).toMatchObject({
      JSON_COMPATIBILITY_OPERATOR_ENABLED: "false",
      JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED: "true",
      JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: "",
      JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256: "",
      JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID:
        statusOptions.statusCurrentKid,
      JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256:
        statusOptions.statusCurrentCredentialIdSha256,
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID:
        statusOptions.approvalCurrentKid,
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256:
        statusOptions.approvalCurrentSpkiSha256,
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID:
        statusOptions.approvalPreviousKid,
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256:
        statusOptions.approvalPreviousSpkiSha256,
      JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID:
        statusOptions.invokerVersionId,
    });

    const executionOutPath = await temporaryPath("operator-execution.jsonc");
    const executionOptions = {
      ...statusIdentityOptions(),
      outPath: executionOutPath,
      currentKid: "operator-2026-08",
      currentCredentialIdSha256: DIGEST("5"),
    };
    const executionResult = await prepareJsonCompatibilityOperatorConfig(
      executionOptions,
    );
    const executionConfig = await preparedConfig(executionOutPath);
    expect(executionResult).toMatchObject({
      deploymentState: "execution",
      executionEnabled: true,
      statusReadEnabled: true,
      changedVars: [
        "JSON_COMPATIBILITY_OPERATOR_ENABLED",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID",
        "JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256",
        "JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID",
        "JSON_COMPATIBILITY_OPERATOR_CURRENT_KID",
        "JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256",
      ],
      secretsRequired: [
        "JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET",
        "JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_SECRET",
      ],
    });
    expect(validateJsonCompatibilityOperatorConfig(
      executionConfig,
      executionOptions,
    )).toMatchObject({
      enabled: true,
      deploymentState: "execution",
      executionEnabled: true,
      statusReadEnabled: true,
    });
    expect(executionConfig.vars).toMatchObject({
      JSON_COMPATIBILITY_OPERATOR_ENABLED: "true",
      JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED: "true",
      JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: executionOptions.currentKid,
      JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
        executionOptions.currentCredentialIdSha256,
    });
    for (const config of [darkConfig, statusConfig, executionConfig]) {
      expect(Object.keys(config.vars).filter((name) => name.includes("SECRET")))
        .toEqual([]);
    }
  });

  test("parses explicit profiles and defaults omitted state to execution", () => {
    const dark = parseJsonCompatibilityOperatorConfigArgs([
      "--out", "dark.jsonc",
      "--deployment-state", "dark",
    ]);
    expect(dark).toMatchObject({
      outPath: "dark.jsonc",
      deploymentState: "dark",
    });

    const statusOnly = parseJsonCompatibilityOperatorConfigArgs([
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliArgs(),
    ]);
    expect(statusOnly).toMatchObject({
      deploymentState: "status-only",
      currentKid: undefined,
      statusCurrentKid: "operator-status-2026-08",
      invokerVersionId: "invoker-version-001",
    });

    const execution = parseJsonCompatibilityOperatorConfigArgs([
      "--out", "execution.jsonc",
      "--hmac-kid", "operator-2026-08",
      "--hmac-credential-id-sha256", DIGEST("5"),
      ...statusCliArgs(),
    ]);
    expect(execution).toMatchObject({
      deploymentState: "execution",
      currentKid: "operator-2026-08",
      statusCurrentKid: "operator-status-2026-08",
    });
  });

  test("rejects invalid states and identity flags irrelevant to a profile", async () => {
    expect(() => parseJsonCompatibilityOperatorConfigArgs([
      "--out", "invalid.jsonc",
      "--deployment-state", "Status-Only",
    ])).toThrow(/must be one of: dark, status-only, execution/u);
    await expect(prepareJsonCompatibilityOperatorConfig({
      outPath: await temporaryPath("invalid-api.jsonc"),
      deploymentState: "disabled",
    })).rejects.toThrow(/must be one of: dark, status-only, execution/u);
    await expect(prepareJsonCompatibilityOperatorConfig({
      outPath: await temporaryPath("invalid-null-api.jsonc"),
      deploymentState: null,
    })).rejects.toThrow(/must be one of: dark, status-only, execution/u);

    for (const [flag, value] of allIdentityCliFlags()) {
      expect(() => parseJsonCompatibilityOperatorConfigArgs([
        "--out", "dark.jsonc",
        "--deployment-state", "dark",
        flag, value,
      ])).toThrow(/forbidden for deployment state dark/u);
    }
    for (const [flag, value] of [
      ["--hmac-kid", "operator-2026-08"],
      ["--hmac-credential-id-sha256", DIGEST("5")],
    ]) {
      expect(() => parseJsonCompatibilityOperatorConfigArgs([
        "--out", "status.jsonc",
        "--deployment-state", "status-only",
        flag, value,
        ...statusCliArgs(),
      ])).toThrow(/forbidden for deployment state status-only/u);
    }

    await expect(prepareJsonCompatibilityOperatorConfig({
      outPath: await temporaryPath("dark-forbidden.jsonc"),
      deploymentState: "dark",
      statusCurrentKid: "operator-status-2026-08",
    })).rejects.toThrow(/forbidden for deployment state dark/u);
    await expect(prepareJsonCompatibilityOperatorConfig({
      ...statusIdentityOptions(),
      outPath: await temporaryPath("status-forbidden.jsonc"),
      deploymentState: "status-only",
      currentKid: "operator-2026-08",
    })).rejects.toThrow(/forbidden for deployment state status-only/u);
  });

  test("requires every identity used by status-only and execution", () => {
    const statusArguments = [
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliArgs(),
    ];
    for (const flag of [
      "--status-hmac-kid",
      "--status-hmac-credential-id-sha256",
      "--approval-current-kid",
      "--approval-current-spki-sha256",
      "--invoker-version-id",
    ]) {
      expect(() => parseJsonCompatibilityOperatorConfigArgs(
        withoutFlag(statusArguments, flag),
      )).toThrow(`${flag} is required`);
    }

    const executionArguments = [
      "--out", "execution.jsonc",
      "--hmac-kid", "operator-2026-08",
      "--hmac-credential-id-sha256", DIGEST("5"),
      ...statusCliArgs(),
    ];
    for (const flag of [
      "--hmac-kid",
      "--hmac-credential-id-sha256",
      "--status-hmac-kid",
      "--status-hmac-credential-id-sha256",
      "--approval-current-kid",
      "--approval-current-spki-sha256",
      "--invoker-version-id",
    ]) {
      expect(() => parseJsonCompatibilityOperatorConfigArgs(
        withoutFlag(executionArguments, flag),
      )).toThrow(`${flag} is required`);
    }
  });

  test("enforces paired and distinct previous approval keys", async () => {
    expect(() => parseJsonCompatibilityOperatorConfigArgs([
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliArgs(),
      "--approval-previous-kid", "operator-approval-2026-07",
    ])).toThrow(/previous KID and SPKI digest must be paired/u);
    expect(() => parseJsonCompatibilityOperatorConfigArgs([
      "--out", "status.jsonc",
      "--deployment-state", "status-only",
      ...statusCliArgs(),
      "--approval-previous-kid", "operator-approval-2026-08",
      "--approval-previous-spki-sha256", DIGEST("7"),
    ])).toThrow(/current and previous keys must differ/u);

    await expect(prepareJsonCompatibilityOperatorConfig({
      ...statusIdentityOptions(),
      outPath: await temporaryPath("partial-previous.jsonc"),
      deploymentState: "status-only",
      approvalPreviousKid: "operator-approval-2026-07",
    })).rejects.toThrow(/previous KID and SPKI digest must be paired/u);
  });

  test("preserves strict base validation, create-only output, and no-secret CLI", async () => {
    const existingOutPath = await temporaryPath("existing.jsonc");
    await writeFile(existingOutPath, "sentinel", "utf8");
    await expect(prepareJsonCompatibilityOperatorConfig({
      outPath: existingOutPath,
      deploymentState: "dark",
    })).rejects.toThrow();
    expect(await readFile(existingOutPath, "utf8")).toBe("sentinel");

    const invalidBase = await trackedConfig("staging");
    invalidBase.vars.UNEXPECTED_VAR = "not-allowed";
    const invalidBasePath = await temporaryPath("invalid-base.jsonc");
    await writeFile(invalidBasePath, JSON.stringify(invalidBase), "utf8");
    await expect(prepareJsonCompatibilityOperatorConfig({
      basePath: invalidBasePath,
      outPath: await temporaryPath("invalid-base-output.jsonc"),
      deploymentState: "dark",
    })).rejects.toThrow(/operator vars does not match/u);

    expect(() => parseJsonCompatibilityOperatorConfigArgs([
      "--status-hmac-secret", "not-accepted",
    ])).toThrow(/unknown option/u);
  });

  test("documents all deployment states and the execution default", async () => {
    const child = Bun.spawn([
      process.execPath,
      "tools/prepare_container_runtime_json_compatibility_operator_config.mjs",
      "--help",
    ], {
      cwd: path.resolve("."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--deployment-state dark");
    expect(stdout).toContain("--deployment-state status-only");
    expect(stdout).toContain("[--deployment-state execution]");
    expect(stdout).toContain("omitting --deployment-state preserves the execution default");
  });
});

function statusIdentityOptions() {
  return {
    statusCurrentKid: "operator-status-2026-08",
    statusCurrentCredentialIdSha256: DIGEST("8"),
    approvalCurrentKid: "operator-approval-2026-08",
    approvalCurrentSpkiSha256: DIGEST("6"),
    invokerVersionId: "invoker-version-001",
  };
}

function statusCliArgs() {
  return [
    "--status-hmac-kid", "operator-status-2026-08",
    "--status-hmac-credential-id-sha256", DIGEST("8"),
    "--approval-current-kid", "operator-approval-2026-08",
    "--approval-current-spki-sha256", DIGEST("6"),
    "--invoker-version-id", "invoker-version-001",
  ];
}

function allIdentityCliFlags() {
  return [
    ["--hmac-kid", "operator-2026-08"],
    ["--hmac-credential-id-sha256", DIGEST("5")],
    ["--status-hmac-kid", "operator-status-2026-08"],
    ["--status-hmac-credential-id-sha256", DIGEST("8")],
    ["--approval-current-kid", "operator-approval-2026-08"],
    ["--approval-current-spki-sha256", DIGEST("6")],
    ["--approval-previous-kid", "operator-approval-2026-07"],
    ["--approval-previous-spki-sha256", DIGEST("7")],
    ["--invoker-version-id", "invoker-version-001"],
  ];
}

function withoutFlag(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  return [
    ...arguments_.slice(0, index),
    ...arguments_.slice(index + 2),
  ];
}

async function temporaryPath(filename) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-operator-config-"),
  );
  TEMPORARY_DIRECTORIES.push(directory);
  return path.join(directory, filename);
}

async function preparedConfig(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}
