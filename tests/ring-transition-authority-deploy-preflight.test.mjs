import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUTHORITY_D1_DATABASES,
  AUTHORITY_MIGRATIONS_DIR,
  AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
  AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
  AUTHORITY_REQUIRED_DISABLED_GATES,
  AUTHORITY_REQUIRED_SECRET_BINDINGS,
  AUTHORITY_STAGING_ROUTE,
  AUTHORITY_STAGING_ZONE,
} from "../tools/audit_ring_transition_authority_config.mjs";
import {
  AUTHORITY_DEPLOY_EVIDENCE_CONTRACT,
  AUTHORITY_REQUIRED_CONFIRMATIONS,
  buildAuthorityDeployNoGoReport,
  databaseIdEvidenceSha256,
  digestAuthorityConfig,
  parseAuthorityDeployCliArguments,
  runAuthorityDeployPreflight,
  validateAuthorityDeployEvidence,
} from "../tools/preflight_ring_transition_authority_deploy.mjs";

const NONZERO_D1_ID = "11111111-2222-4333-8444-555555555555";

function validConfig() {
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: "cinatoken-ring-transition-authority-staging",
    main: "src/index.ts",
    compatibility_date: "2026-07-23",
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ENVIRONMENT: "staging",
      ...Object.fromEntries(
        AUTHORITY_REQUIRED_DISABLED_GATES.map((name) => [name, "false"]),
      ),
      RING_TRANSITION_HMAC_CURRENT_KID: "hmac-current-v1",
      RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "1".repeat(64),
      RING_TRANSITION_HMAC_PREVIOUS_KID: "",
      RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
      RING_TRANSITION_PERMIT_KEY_ID: "permit-current-v1",
      [AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR]: "2".repeat(64),
      RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256: "3".repeat(64),
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: AUTHORITY_D1_DATABASES.staging,
        database_id: NONZERO_D1_ID,
        migrations_dir: AUTHORITY_MIGRATIONS_DIR,
      },
    ],
    routes: [
      {
        pattern: AUTHORITY_STAGING_ROUTE,
        zone_name: AUTHORITY_STAGING_ZONE,
        custom_domain: false,
      },
    ],
  };
}

function validEvidence(config) {
  return {
    contract: AUTHORITY_DEPLOY_EVIDENCE_CONTRACT,
    environment: "staging",
    candidateConfigSha256: digestAuthorityConfig(config),
    databaseIdSha256: databaseIdEvidenceSha256(
      config.d1_databases[0].database_id,
    ),
    routePattern: AUTHORITY_STAGING_ROUTE,
    routeZoneName: AUTHORITY_STAGING_ZONE,
    routeCustomDomain: false,
    hmacSecretBindings: [...AUTHORITY_REQUIRED_SECRET_BINDINGS],
    permitPublicKeyBinding: AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
    confirmations: Object.fromEntries(
      AUTHORITY_REQUIRED_CONFIRMATIONS.map((name) => [name, true]),
    ),
    evidenceDigests: Object.fromEntries(
      AUTHORITY_REQUIRED_CONFIRMATIONS.map((name) => [
        name,
        createHash("sha256").update(`evidence:${name}`).digest("hex"),
      ]),
    ),
  };
}

describe("ring transition Authority static deploy preflight", () => {
  test("is NO-GO by default and rejects missing evidence", () => {
    expect(buildAuthorityDeployNoGoReport()).toMatchObject({
      ok: false,
      decision: "NO-GO",
      readyForDeploy: false,
      staticOnly: true,
      networkUsed: false,
      credentialsRead: false,
      deployed: false,
    });
    expect(() =>
      validateAuthorityDeployEvidence(validConfig(), undefined),
    ).toThrow(/deployment evidence is required.*NO-GO/);
  });

  test("accepts a fully bound local evidence packet without exposing resource IDs", () => {
    const config = validConfig();
    const report = validateAuthorityDeployEvidence(
      config,
      validEvidence(config),
    );

    expect(report).toMatchObject({
      ok: true,
      decision: "GO",
      readyForDeploy: true,
      environment: "staging",
      mode: "static-local-evidence-gate",
      staticOnly: true,
      networkUsed: false,
      credentialsRead: false,
      deployed: false,
      database: {
        binding: "DB",
        databaseName: "cinatoken-ring-control-staging",
        id: "redacted",
      },
    });
    expect(JSON.stringify(report)).not.toContain(NONZERO_D1_ID);
  });

  test("rejects zero and REPLACE_WITH database_id placeholders", () => {
    for (const databaseId of [
      "00000000-0000-0000-0000-000000000000",
      "REPLACE_WITH_RING_CONTROL_STAGING_D1_ID",
    ]) {
      const config = validConfig();
      config.d1_databases[0].database_id = databaseId;
      expect(() =>
        validateAuthorityDeployEvidence(config, validEvidence(config)),
      ).toThrow(/database_id must not be a placeholder/);
    }
  });

  test("rejects empty current key, credential, permit, actor, or public-key identity", () => {
    const cases = [
      ["RING_TRANSITION_HMAC_CURRENT_KID", /must be a non-empty key identifier/],
      [
        "RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256",
        /must be a lowercase SHA-256 digest/,
      ],
      ["RING_TRANSITION_PERMIT_KEY_ID", /must be a non-empty key identifier/],
      [
        "RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256",
        /must be a lowercase SHA-256 digest/,
      ],
      [
        AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
        /must be a lowercase SHA-256 digest/,
      ],
    ];
    for (const [name, expected] of cases) {
      const config = validConfig();
      config.vars[name] = "";
      expect(() =>
        validateAuthorityDeployEvidence(config, validEvidence(config)),
      ).toThrow(expected);
    }
  });

  test("requires the previous HMAC kid and credential identity as an atomic pair", () => {
    const kidOnly = validConfig();
    kidOnly.vars.RING_TRANSITION_HMAC_PREVIOUS_KID = "hmac-previous-v1";
    expect(() =>
      validateAuthorityDeployEvidence(kidOnly, validEvidence(kidOnly)),
    ).toThrow(/previous HMAC kid and credential id must be both empty or both valid/);

    const credentialOnly = validConfig();
    credentialOnly.vars.RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256 =
      "4".repeat(64);
    expect(() =>
      validateAuthorityDeployEvidence(
        credentialOnly,
        validEvidence(credentialOnly),
      ),
    ).toThrow(/previous HMAC kid and credential id must be both empty or both valid/);

    const completePair = validConfig();
    completePair.vars.RING_TRANSITION_HMAC_PREVIOUS_KID =
      "hmac-previous-v1";
    completePair.vars.RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256 =
      "4".repeat(64);
    expect(
      validateAuthorityDeployEvidence(
        completePair,
        validEvidence(completePair),
      ).decision,
    ).toBe("GO");
  });

  test("rejects every unconfirmed Access, route, readback, and revocation fact", () => {
    for (const confirmation of AUTHORITY_REQUIRED_CONFIRMATIONS) {
      const config = validConfig();
      const evidence = validEvidence(config);
      evidence.confirmations[confirmation] = false;
      expect(() =>
        validateAuthorityDeployEvidence(config, evidence),
      ).toThrow(new RegExp(`confirmation ${confirmation} must be true`));
    }
  });

  test("rejects missing or malformed evidence digests", () => {
    const config = validConfig();
    const missing = validEvidence(config);
    delete missing.evidenceDigests.routeReadbackConfirmed;
    expect(() => validateAuthorityDeployEvidence(config, missing)).toThrow(
      /evidence digests must contain exactly/,
    );

    const malformed = validEvidence(config);
    malformed.evidenceDigests.credentialRevocationConfirmed = "confirmed";
    expect(() => validateAuthorityDeployEvidence(config, malformed)).toThrow(
      /must be a lowercase SHA-256 digest/,
    );
  });

  test("rejects evidence bound to another config, D1, route, or key inventory", () => {
    const cases = [
      [
        "candidateConfigSha256",
        (evidence) => {
          evidence.candidateConfigSha256 = "a".repeat(64);
        },
      ],
      [
        "databaseIdSha256",
        (evidence) => {
          evidence.databaseIdSha256 = "b".repeat(64);
        },
      ],
      [
        "routePattern",
        (evidence) => {
          evidence.routePattern = "other.example.com/*";
        },
      ],
      [
        "routeZoneName",
        (evidence) => {
          evidence.routeZoneName = "example.com";
        },
      ],
      [
        "hmacSecretBindings",
        (evidence) => {
          evidence.hmacSecretBindings = ["RING_TRANSITION_HMAC_CURRENT_SECRET"];
        },
      ],
      [
        "permitPublicKeyBinding",
        (evidence) => {
          evidence.permitPublicKeyBinding = "OTHER_PUBLIC_KEY";
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const config = validConfig();
      const evidence = validEvidence(config);
      mutate(evidence);
      expect(() =>
        validateAuthorityDeployEvidence(config, evidence),
      ).toThrow(label);
    }
  });

  test("rejects production config before reading an evidence packet", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cinatoken-authority-preflight-production-"),
    );
    try {
      const configPath = path.join(root, "wrangler.staging.jsonc");
      const productionConfigPath = path.join(root, "wrangler.production.jsonc");
      await mkdir(root, { recursive: true });
      await Promise.all([
        writeFile(configPath, `${JSON.stringify(validConfig(), null, 2)}\n`),
        writeFile(productionConfigPath, "{}\n"),
      ]);

      await expect(
        runAuthorityDeployPreflight({
          configPath,
          productionConfigPath,
          evidencePath: path.join(root, "missing-evidence.json"),
        }),
      ).rejects.toThrow(/production Authority config is forbidden/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs only against explicit local files and stays default NO-GO without one", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cinatoken-authority-preflight-local-"),
    );
    try {
      const config = validConfig();
      const configPath = path.join(root, "wrangler.staging.jsonc");
      const evidencePath = path.join(root, "evidence.json");
      const productionConfigPath = path.join(root, "wrangler.production.jsonc");
      await Promise.all([
        writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
        writeFile(
          evidencePath,
          `${JSON.stringify(validEvidence(config), null, 2)}\n`,
        ),
      ]);

      await expect(
        runAuthorityDeployPreflight({
          configPath,
          productionConfigPath,
        }),
      ).rejects.toThrow(/local --evidence file is required.*NO-GO/);

      const report = await runAuthorityDeployPreflight({
        configPath,
        evidencePath,
        productionConfigPath,
      });
      expect(report.decision).toBe("GO");
      expect(report.networkUsed).toBe(false);
      expect(report.credentialsRead).toBe(false);
      expect(report.deployed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI accepts only local config/evidence paths and output flags", () => {
    expect(
      parseAuthorityDeployCliArguments([
        "--config",
        "candidate.jsonc",
        "--evidence",
        "evidence.json",
        "--json",
      ]),
    ).toMatchObject({
      configPath: "candidate.jsonc",
      evidencePath: "evidence.json",
      json: true,
    });
    expect(() =>
      parseAuthorityDeployCliArguments(["--token", "forbidden"]),
    ).toThrow(/unknown option: --token/);
  });

  test("implementation has no credential, network, subprocess, or deploy primitive", async () => {
    const source = await readFile(
      new URL(
        "../tools/preflight_ring_transition_authority_deploy.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/node:child_process|runBoundedSubprocess/);
    expect(source).not.toMatch(/\bwrangler\s+deploy\b/i);
  });
});
