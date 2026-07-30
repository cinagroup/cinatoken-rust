import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ISSUER_CONFIG_FILES,
  ISSUER_SECRET_BINDINGS,
  ISSUER_VAR_ALLOWLIST,
  auditIssuerConfig,
  auditRootProductionOmission,
  auditTrackedIssuerConfigs,
  parseIssuerWranglerJsonc,
} from "../tools/audit_drain_source_registration_permit_issuer_config.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const toolPath = path.join(
  repoRoot,
  "tools",
  "audit_drain_source_registration_permit_issuer_config.mjs",
);
const SHA256 = "a".repeat(64);
const PROHIBITED_BINDINGS = [
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "queues",
  "services",
  "assets",
  "containers",
  "ai",
  "vectorize",
  "browser",
  "dispatch_namespaces",
  "unsafe",
  "ratelimits",
  "hyperdrive",
  "analytics_engine_datasets",
  "mtls_certificates",
  "pipelines",
  "send_email",
  "email",
  "workflows",
  "images",
  "logfwdr",
  "tail_consumers",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
];

function validConfig(environment) {
  const workerName =
    `cinatoken-drain-source-registration-permit-issuer-${environment}`;
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "src/index.ts",
    compatibility_date: "2026-07-15",
    workers_dev: false,
    preview_urls: false,
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    version_metadata: {
      binding: "CF_VERSION_METADATA",
    },
    vars: {
      ENVIRONMENT: environment,
      DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED: "false",
      DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER:
        `cinatoken-relay-application-${environment}`,
      DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE: workerName,
      DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID: "",
      DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
      DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID: "",
      DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
      DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER: workerName,
      DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE:
        `cinatoken-relay-application:${environment}:drain-source-registration:v1`,
      DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID: "",
      DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256: "",
      DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256: "",
    },
  };
}

function rootWrangler({
  stagingLines = [],
  productionLines = [],
} = {}) {
  return [
    "[env.staging]",
    'name = "cinatoken-rust-api-staging"',
    ...stagingLines,
    "",
    "[env.production]",
    'name = "cinatoken-rust-api"',
    ...productionLines,
    "",
    "[unrelated]",
    'value = "DRAIN_SOURCE_REGISTRATION_OUTSIDE_PRODUCTION"',
    "",
  ].join("\n");
}

async function createTrackedFixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "cinatoken-drain-issuer-config-"),
  );
  const serviceDir = path.join(root, "service");
  const rootWranglerPath = path.join(root, "wrangler.toml");
  await mkdir(serviceDir, { recursive: true });
  await Promise.all(
    Object.entries(ISSUER_CONFIG_FILES).map(([environment, filename]) =>
      writeFile(
        path.join(serviceDir, filename),
        `${JSON.stringify(validConfig(environment), null, 2)}\n`,
      ),
    ),
  );
  await writeFile(rootWranglerPath, rootWrangler());
  return { root, serviceDir, rootWranglerPath };
}

describe("drain-source registration permit issuer config isolation", () => {
  test("accepts exact local and staging least-authority configs", () => {
    for (const environment of ["local", "staging"]) {
      const report = auditIssuerConfig(validConfig(environment), environment);
      expect(report).toMatchObject({
        ok: true,
        environment,
        compatibilityDate: "2026-07-15",
        workersDev: false,
        previewUrls: false,
        publicRoutesAbsent: true,
        runtimeBindings: ["version_metadata.CF_VERSION_METADATA"],
        gatesDefaultOff: true,
        varsExact: true,
        trackedSecretMaterialAbsent: true,
        authorityPermitIdentitiesSeparated: true,
      });
      expect(report.requiredSecretBindings).toEqual(ISSUER_SECRET_BINDINGS);
    }
  });

  test("parses JSONC as data without evaluation or duplicate-key ambiguity", () => {
    const source = `{
      // Comments and trailing commas are accepted.
      "name": "issuer // literal",
      "nested": {
        "value": "/* literal */",
      },
      "values": [1, 2,],
    }`;
    expect(parseIssuerWranglerJsonc(source)).toEqual({
      name: "issuer // literal",
      nested: { value: "/* literal */" },
      values: [1, 2],
    });
    expect(() =>
      parseIssuerWranglerJsonc('{"name": globalThis.process}'),
    ).toThrow(/valid JSONC/);
    expect(() =>
      parseIssuerWranglerJsonc('{"name":"first","name":"second"}'),
    ).toThrow(/duplicate object key "name"/);
    expect(() =>
      parseIssuerWranglerJsonc('{"name":"issuer" /* unterminated'),
    ).toThrow(/unterminated JSONC block comment/);
  });

  test("rejects public exposure and every extra top-level capability", () => {
    const workersDev = validConfig("staging");
    workersDev.workers_dev = true;
    expect(() => auditIssuerConfig(workersDev, "staging")).toThrow(
      /workers_dev must be false/,
    );

    const preview = validConfig("staging");
    preview.preview_urls = true;
    expect(() => auditIssuerConfig(preview, "staging")).toThrow(
      /preview_urls must be false/,
    );

    for (const publicKey of ["route", "routes"]) {
      const config = validConfig("staging");
      config[publicKey] = [];
      expect(() => auditIssuerConfig(config, "staging")).toThrow(
        new RegExp(`public routes are forbidden: ${publicKey}`),
      );
    }

    const unexpected = validConfig("staging");
    unexpected.compatibility_flags = ["nodejs_compat"];
    expect(() => auditIssuerConfig(unexpected, "staging")).toThrow(
      /unexpected top-level capability: compatibility_flags/,
    );
  });

  test("rejects every Cloudflare runtime binding family", () => {
    for (const binding of PROHIBITED_BINDINGS) {
      const config = validConfig("staging");
      config[binding] =
        binding === "durable_objects" ? { bindings: [] } : [];
      expect(() => auditIssuerConfig(config, "staging")).toThrow(
        new RegExp(`prohibited runtime binding: ${binding}`),
      );
    }
  });

  test("allows only the CF_VERSION_METADATA runtime binding", () => {
    const wrong = validConfig("staging");
    wrong.version_metadata.binding = "OTHER_VERSION";
    expect(() => auditIssuerConfig(wrong, "staging")).toThrow(
      /version_metadata.binding must be CF_VERSION_METADATA/,
    );

    const extra = validConfig("staging");
    extra.version_metadata.extra = true;
    expect(() => auditIssuerConfig(extra, "staging")).toThrow(
      /version_metadata must contain exactly binding/,
    );
  });

  test("requires the exact vars allowlist and a disabled string gate", () => {
    const missing = validConfig("staging");
    delete missing.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID;
    expect(() => auditIssuerConfig(missing, "staging")).toThrow(
      /vars must contain exactly/,
    );

    const extra = validConfig("staging");
    extra.vars.UNREVIEWED_FLAG = "false";
    expect(() => auditIssuerConfig(extra, "staging")).toThrow(
      /vars must contain exactly/,
    );

    const enabled = validConfig("staging");
    enabled.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = "true";
    expect(() => auditIssuerConfig(enabled, "staging")).toThrow(
      /issuance gate must be false/,
    );

    const booleanGate = validConfig("staging");
    booleanGate.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = false;
    expect(() => auditIssuerConfig(booleanGate, "staging")).toThrow(
      /issuance gate must be false/,
    );

    expect(Object.keys(validConfig("staging").vars).sort()).toEqual(
      [...ISSUER_VAR_ALLOWLIST].sort(),
    );
  });

  test("keeps all four secret binding names and common secret literals out of vars", () => {
    for (const binding of ISSUER_SECRET_BINDINGS) {
      const config = validConfig("staging");
      config.vars[binding] = "tracked-material";
      expect(() => auditIssuerConfig(config, "staging")).toThrow(
        new RegExp(`${binding} is a secret binding name`),
      );
    }

    for (const literal of [
      "sk-abcdefghijklmnopqrstuvwx",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
    ]) {
      const config = validConfig("staging");
      config.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID = literal;
      expect(() => auditIssuerConfig(config, "staging")).toThrow(
        /common secret literal is forbidden/,
      );
    }
  });

  test("pins exact environment, issuer, and audience identities without reuse", () => {
    const wrongEnvironment = validConfig("staging");
    wrongEnvironment.vars.ENVIRONMENT = "production";
    expect(() => auditIssuerConfig(wrongEnvironment, "staging")).toThrow(
      /ENVIRONMENT must be staging/,
    );

    const wrongName = validConfig("staging");
    wrongName.name = "cinatoken-drain-source-registration-permit-issuer";
    expect(() => auditIssuerConfig(wrongName, "staging")).toThrow(
      /Worker name must be cinatoken-drain-source-registration-permit-issuer-staging/,
    );

    for (const [name, value, message] of [
      [
        "DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER",
        "other-authority",
        "authority issuer",
      ],
      [
        "DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE",
        "other-audience",
        "authority audience",
      ],
      [
        "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER",
        "other-issuer",
        "permit issuer",
      ],
      [
        "DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE",
        "other-audience",
        "permit audience",
      ],
    ]) {
      const config = validConfig("staging");
      config.vars[name] = value;
      expect(() => auditIssuerConfig(config, "staging")).toThrow(
        new RegExp(message),
      );
    }

    const reusedIssuer = validConfig("staging");
    reusedIssuer.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER =
      reusedIssuer.vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_ISSUER;
    expect(() => auditIssuerConfig(reusedIssuer, "staging")).toThrow(
      /identities must not be reused/,
    );

    const reusedAudience = validConfig("staging");
    reusedAudience.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE =
      reusedAudience.vars.DRAIN_SOURCE_REGISTRATION_AUTHORITY_AUDIENCE;
    expect(() => auditIssuerConfig(reusedAudience, "staging")).toThrow(
      /identities must not be reused/,
    );
  });

  test("validates non-secret key metadata without reading binding values", () => {
    const valid = validConfig("staging");
    valid.vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID = "staging-hmac-v1";
    valid.vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256 =
      SHA256;
    valid.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID = "staging-permit-v1";
    valid.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256 =
      "b".repeat(64);
    valid.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256 = SHA256;
    expect(auditIssuerConfig(valid, "staging").ok).toBe(true);

    const halfPair = validConfig("staging");
    halfPair.vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID = "staging-v1";
    expect(() => auditIssuerConfig(halfPair, "staging")).toThrow(
      /must both be empty or both be set/,
    );

    const invalidDigest = validConfig("staging");
    invalidDigest.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256 =
      "not-a-digest";
    expect(() => auditIssuerConfig(invalidDigest, "staging")).toThrow(
      /lowercase SHA-256 digest/,
    );

    const uppercaseKey = validConfig("staging");
    uppercaseKey.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID =
      "Uppercase-Key";
    expect(() => auditIssuerConfig(uppercaseKey, "staging")).toThrow(
      /lowercase key ID/,
    );

    const reusedSignerDigest = validConfig("staging");
    reusedSignerDigest.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SIGNER_IDENTITY_SHA256 =
      SHA256;
    reusedSignerDigest.vars.DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256 =
      SHA256;
    expect(() => auditIssuerConfig(reusedSignerDigest, "staging")).toThrow(
      /signer identity and SPKI digests must differ/,
    );

    const reusedHmacCredential = validConfig("staging");
    reusedHmacCredential.vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_KID =
      "current-v1";
    reusedHmacCredential.vars.DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_CREDENTIAL_ID_SHA256 =
      SHA256;
    reusedHmacCredential.vars.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_KID =
      "previous-v1";
    reusedHmacCredential.vars.DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256 =
      SHA256;
    expect(() =>
      auditIssuerConfig(reusedHmacCredential, "staging"),
    ).toThrow(/HMAC credential digests must differ/);
  });

  test("allows exactly two issuer Wrangler JSONC files and forbids production configs", async () => {
    const fixture = await createTrackedFixture();
    try {
      const baseline = await auditTrackedIssuerConfigs(fixture);
      expect(baseline).toMatchObject({
        ok: true,
        productionIssuerConfigAbsent: true,
        onlyLocalAndStagingConfigs: true,
        secretFilesAndCommonLiteralsAbsent: true,
      });

      const stagingConfigPath = path.join(
        fixture.serviceDir,
        ISSUER_CONFIG_FILES.staging,
      );
      const stagingConfig = validConfig("staging");
      stagingConfig.compatibility_date = "2026-07-14";
      await writeFile(
        stagingConfigPath,
        `${JSON.stringify(stagingConfig, null, 2)}\n`,
      );
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /compatibility dates must match/,
      );
      await writeFile(
        stagingConfigPath,
        `${JSON.stringify(validConfig("staging"), null, 2)}\n`,
      );

      const devVarsPath = path.join(fixture.serviceDir, ".dev.vars");
      await writeFile(devVarsPath, "SECRET=forbidden\n");
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /secret-bearing issuer filenames are forbidden/,
      );
      await unlink(devVarsPath);

      const disguisedPemPath = path.join(fixture.serviceDir, "notes.txt");
      await writeFile(
        disguisedPemPath,
        "-----BEGIN PRIVATE KEY-----\nforbidden\n",
      );
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /common secret literal is forbidden in issuer file notes\.txt/,
      );
      await unlink(disguisedPemPath);

      const productionPath = path.join(
        fixture.serviceDir,
        "wrangler.production.jsonc",
      );
      await writeFile(
        productionPath,
        `${JSON.stringify(validConfig("staging"))}\n`,
      );
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /production issuer config is forbidden/,
      );
      await unlink(productionPath);

      const nestedProductionDir = path.join(fixture.serviceDir, "config");
      await mkdir(nestedProductionDir);
      const nestedProductionPath = path.join(
        nestedProductionDir,
        "issuer.prod.toml",
      );
      await writeFile(nestedProductionPath, 'name = "forbidden"\n');
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /production issuer config is forbidden/,
      );
      await unlink(nestedProductionPath);
      await rm(nestedProductionDir, { recursive: true });

      const extraPath = path.join(fixture.serviceDir, "wrangler.dev.jsonc");
      await writeFile(extraPath, "{}\n");
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /must contain exactly wrangler.jsonc, wrangler.staging.jsonc/,
      );
      await unlink(extraPath);

      await unlink(
        path.join(fixture.serviceDir, ISSUER_CONFIG_FILES.staging),
      );
      await expect(auditTrackedIssuerConfigs(fixture)).rejects.toThrow(
        /must contain exactly wrangler.jsonc, wrangler.staging.jsonc/,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires production Application omission without requiring staging connection", () => {
    const report = auditRootProductionOmission(
      rootWrangler({
        stagingLines: [
          "[[env.staging.services]]",
          'binding = "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER"',
          'service = "cinatoken-drain-source-registration-permit-issuer-staging"',
          "[env.staging.vars]",
          'DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = "false"',
        ],
        productionLines: [
          "# DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET is intentionally absent.",
          'ordinary_value = "value # not a comment"',
        ],
      }),
    );
    expect(report).toEqual({
      ok: true,
      environment: "production",
      capabilityPrefix: "DRAIN_SOURCE_REGISTRATION_",
      issuanceGateAbsent: true,
      issuerServiceBindingAbsent: true,
      rateLimiterAbsent: true,
      hmacBindingsAbsent: true,
      permitTrustAndPrivateKeyBindingsAbsent: true,
    });
  });

  test("rejects every drain-source registration capability class in production", () => {
    for (const capability of [
      "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED",
      "DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER",
      "DRAIN_SOURCE_REGISTRATION_RATE_LIMITER",
      "DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET",
      "DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET",
      "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL",
      "DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256",
      "DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL",
    ]) {
      expect(() =>
        auditRootProductionOmission(
          rootWrangler({
            productionLines: [`${capability} = "false"`],
          }),
        ),
      ).toThrow(new RegExp(capability));
    }

    expect(() =>
      auditRootProductionOmission(
        rootWrangler({
          productionLines: [
            "[[env.production.services]]",
            'binding = "REGISTRATION_ISSUER"',
            'service = "cinatoken-drain-source-registration-permit-issuer-production"',
          ],
        }),
      ),
    ).toThrow(/must omit the drain-source registration issuer service/);
  });

  test("requires an explicit production slice and ignores comments", () => {
    expect(() =>
      auditRootProductionOmission(
        '[env.staging]\nDRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = "false"\n',
      ),
    ).toThrow(/must contain \[env.production\]/);

    expect(() =>
      auditRootProductionOmission(
        [
          "[env.production]",
          "# DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL = \"secret\"",
          'name = "cinatoken-rust-api"',
          "",
        ].join("\n"),
      ),
    ).not.toThrow();

    expect(() =>
      auditRootProductionOmission(
        [
          "[env.production]",
          'name = "cinatoken-rust-api"',
          "",
          "[env.staging.vars]",
          'DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = "false"',
          "",
          "[env.production.vars]",
          'DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED = "false"',
          "",
        ].join("\n"),
      ),
    ).toThrow(/DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_ENABLED/);
  });

  test("audits the tracked issuer configs and root production omission together", async () => {
    const report = await auditTrackedIssuerConfigs();
    expect(report).toMatchObject({
      ok: true,
      productionIssuerConfigAbsent: true,
      onlyLocalAndStagingConfigs: true,
      secretFilesAndCommonLiteralsAbsent: true,
      applicationProduction: {
        ok: true,
        environment: "production",
        issuanceGateAbsent: true,
        issuerServiceBindingAbsent: true,
      },
    });
  });

  test("supports a redacted --json CLI report", async () => {
    const child = Bun.spawn([process.execPath, toolPath, "--json"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.productionIssuerConfigAbsent).toBe(true);
    expect(report.secretFilesAndCommonLiteralsAbsent).toBe(true);
    expect(report.candidateFileCount).toBeGreaterThan(0);
    expect(stdout).not.toContain("tracked-material");
    for (const secretBinding of ISSUER_SECRET_BINDINGS) {
      expect(report.environments.local.requiredSecretBindings).toContain(
        secretBinding,
      );
    }
  });
});
