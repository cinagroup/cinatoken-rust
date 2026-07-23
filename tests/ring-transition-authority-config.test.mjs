import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUTHORITY_CONFIG_FILES,
  AUTHORITY_D1_DATABASES,
  AUTHORITY_MIGRATIONS_DIR,
  AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
  AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR,
  AUTHORITY_REQUIRED_DISABLED_GATES,
  AUTHORITY_REQUIRED_SECRET_BINDINGS,
  AUTHORITY_SERVICE_MIGRATION_SOURCES,
  AUTHORITY_STAGING_ROUTE,
  AUTHORITY_STAGING_ZONE,
  auditAuthorityConfig,
  auditAuthorityServiceMigrations,
  auditTrackedAuthorityConfigs,
  parseAuthorityWranglerJsonc,
} from "../tools/audit_ring_transition_authority_config.mjs";

const NONZERO_D1_ID = "11111111-2222-4333-8444-555555555555";
const PROHIBITED_BINDINGS = [
  "kv_namespaces",
  "r2_buckets",
  "durable_objects",
  "containers",
  "queues",
  "services",
  "assets",
  "ai",
  "vectorize",
  "browser",
];

function validConfig(environment) {
  const config = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: `cinatoken-ring-transition-authority-${environment}`,
    main: "src/index.ts",
    compatibility_date: "2026-07-23",
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ENVIRONMENT: environment,
      ...Object.fromEntries(
        AUTHORITY_REQUIRED_DISABLED_GATES.map((name) => [name, "false"]),
      ),
      RING_TRANSITION_HMAC_CURRENT_KID: "",
      RING_TRANSITION_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
      RING_TRANSITION_HMAC_PREVIOUS_KID: "",
      RING_TRANSITION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
      RING_TRANSITION_PERMIT_KEY_ID: "",
      [AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR]: "",
      RING_TRANSITION_AUTHORITY_ACTOR_ID_SHA256: "",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: AUTHORITY_D1_DATABASES[environment],
        database_id:
          environment === "local"
            ? "00000000-0000-0000-0000-000000000000"
            : NONZERO_D1_ID,
        migrations_dir: AUTHORITY_MIGRATIONS_DIR,
      },
    ],
  };
  if (environment === "staging") {
    config.routes = [
      {
        pattern: AUTHORITY_STAGING_ROUTE,
        zone_name: AUTHORITY_STAGING_ZONE,
        custom_domain: false,
      },
    ];
  }
  return config;
}

describe("ring transition Authority config audit", () => {
  test("accepts only the local and staging least-authority contracts", () => {
    for (const environment of ["local", "staging"]) {
      const report = auditAuthorityConfig(validConfig(environment), environment);
      expect(report).toMatchObject({
        ok: true,
        environment,
        workersDev: false,
        previewUrls: false,
        bindings: [
          "d1_databases.DB",
          "version_metadata.CF_VERSION_METADATA",
        ],
        gatesDefaultOff: true,
        remoteBindingValuesRead: false,
      });
      expect(report.requiredSecretBindings).toEqual(
        AUTHORITY_REQUIRED_SECRET_BINDINGS,
      );
      expect(report.permitPublicKeyBinding).toBe(
        AUTHORITY_PERMIT_PUBLIC_KEY_BINDING,
      );
      expect(report.database.id).toBe("redacted");
      expect(JSON.stringify(report)).not.toContain(NONZERO_D1_ID);
    }
  });

  test("parses JSONC comments and trailing commas without evaluating code", () => {
    const source = `{
      // Wrangler JSONC remains data only.
      "name": "example",
      "values": ["// inside a string",],
    }`;
    expect(parseAuthorityWranglerJsonc(source)).toEqual({
      name: "example",
      values: ["// inside a string"],
    });
    expect(() =>
      parseAuthorityWranglerJsonc('{"name": globalThis.process}'),
    ).toThrow(/valid JSONC/);
  });

  test("rejects every extra runtime binding family", () => {
    for (const binding of PROHIBITED_BINDINGS) {
      const config = validConfig("staging");
      config[binding] = binding === "durable_objects" ? { bindings: [] } : [];
      expect(() => auditAuthorityConfig(config, "staging")).toThrow(
        new RegExp(`prohibited binding: ${binding}`),
      );
    }
  });

  test("rejects public worker endpoints and malformed routes", () => {
    const workersDev = validConfig("staging");
    workersDev.workers_dev = true;
    expect(() => auditAuthorityConfig(workersDev, "staging")).toThrow(
      /workers_dev must be false/,
    );

    const preview = validConfig("staging");
    preview.preview_urls = true;
    expect(() => auditAuthorityConfig(preview, "staging")).toThrow(
      /preview_urls must be false/,
    );

    const wrongRoute = validConfig("staging");
    wrongRoute.routes[0].pattern = "other.example.com/*";
    expect(() => auditAuthorityConfig(wrongRoute, "staging")).toThrow(
      /staging route pattern/,
    );

    const customDomain = validConfig("staging");
    customDomain.routes[0].custom_domain = true;
    expect(() => auditAuthorityConfig(customDomain, "staging")).toThrow(
      /staging route custom_domain must be false/,
    );

    const wrongZone = validConfig("staging");
    wrongZone.routes[0].zone_name = "example.com";
    expect(() => auditAuthorityConfig(wrongZone, "staging")).toThrow(
      /staging route zone_name must be cinatoken.com/,
    );

    const localRoute = validConfig("local");
    localRoute.routes = [];
    expect(() => auditAuthorityConfig(localRoute, "local")).toThrow(
      /local config must not declare routes/,
    );
  });

  test("rejects the shared application D1 and non-dedicated migrations", () => {
    const sharedD1 = validConfig("staging");
    sharedD1.d1_databases[0].database_name = "cinatoken-rust-db-staging";
    expect(() => auditAuthorityConfig(sharedD1, "staging")).toThrow(
      /database_name must be cinatoken-ring-control-staging/,
    );

    const wrongMigrations = validConfig("staging");
    wrongMigrations.d1_databases[0].migrations_dir = "../../migrations/d1";
    expect(() => auditAuthorityConfig(wrongMigrations, "staging")).toThrow(
      /migrations_dir must be migrations/,
    );
  });

  test("rejects every enabled Authority mutation gate", () => {
    for (const gate of AUTHORITY_REQUIRED_DISABLED_GATES) {
      const config = validConfig("staging");
      config.vars[gate] = "true";
      expect(() => auditAuthorityConfig(config, "staging")).toThrow(
        new RegExp(`${gate} must be false`),
      );
    }
  });

  test("requires secret and permit bindings by name without tracked material", () => {
    for (const secretBinding of AUTHORITY_REQUIRED_SECRET_BINDINGS) {
      const config = validConfig("staging");
      config.vars[secretBinding] = "literal-secret-value";
      expect(() => auditAuthorityConfig(config, "staging")).toThrow(
        /remote binding name.*must not be stored in tracked vars/,
      );
    }

    const publicKey = validConfig("staging");
    publicKey.vars[AUTHORITY_PERMIT_PUBLIC_KEY_BINDING] =
      "MCowBQYDK2VwAyEAsecretmaterial";
    expect(() => auditAuthorityConfig(publicKey, "staging")).toThrow(
      /remote binding name.*must not be stored in tracked vars/,
    );

    const invalidFingerprint = validConfig("staging");
    invalidFingerprint.vars[AUTHORITY_PERMIT_PUBLIC_KEY_FINGERPRINT_VAR] =
      "not-a-sha256";
    expect(() =>
      auditAuthorityConfig(invalidFingerprint, "staging"),
    ).toThrow(
      /RING_TRANSITION_PERMIT_SPKI_SHA256 must be empty or a lowercase SHA-256/,
    );

    const token = validConfig("staging");
    token.vars.OPERATOR_TOKEN = "tracked-token-literal";
    expect(() => auditAuthorityConfig(token, "staging")).toThrow(
      /secret or token literal is forbidden/,
    );
  });

  test("rejects any tracked production Authority config", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cinatoken-authority-config-"),
    );
    try {
      await mkdir(root, { recursive: true });
      await Promise.all(
        Object.entries(AUTHORITY_CONFIG_FILES).map(([environment, filename]) =>
          writeFile(
            path.join(root, filename),
            `${JSON.stringify(validConfig(environment), null, 2)}\n`,
          ),
        ),
      );
      await writeFile(
        path.join(root, "wrangler.production.jsonc"),
        `${JSON.stringify(validConfig("staging"), null, 2)}\n`,
      );

      await expect(
        auditTrackedAuthorityConfigs({ serviceDir: root }),
      ).rejects.toThrow(/production Authority config is forbidden/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires exactly two byte-identical service migrations", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cinatoken-authority-migrations-"),
    );
    const serviceMigrationsDir = path.join(root, "service");
    const globalMigrationsDir = path.join(root, "global");
    const sourceBytes = {
      "0059_relay_container_ring_transition_claims.sql":
        "CREATE TABLE claims(id TEXT PRIMARY KEY);\n",
      "0060_relay_container_ring_transition_authority.sql":
        "CREATE TABLE authority(id TEXT PRIMARY KEY);\n",
    };
    try {
      await Promise.all([
        mkdir(serviceMigrationsDir, { recursive: true }),
        mkdir(globalMigrationsDir, { recursive: true }),
      ]);
      for (const [serviceName, globalName] of Object.entries(
        AUTHORITY_SERVICE_MIGRATION_SOURCES,
      )) {
        await Promise.all([
          writeFile(
            path.join(serviceMigrationsDir, serviceName),
            sourceBytes[globalName],
          ),
          writeFile(
            path.join(globalMigrationsDir, globalName),
            sourceBytes[globalName],
          ),
        ]);
      }

      const exact = await auditAuthorityServiceMigrations({
        serviceMigrationsDir,
        globalMigrationsDir,
      });
      expect(exact.exact).toBe(true);
      expect(exact.files.map((item) => item.serviceName)).toEqual([
        "0001_ring_transition_claims.sql",
        "0002_ring_transition_authority.sql",
      ]);

      const missingPath = path.join(
        serviceMigrationsDir,
        "0001_ring_transition_claims.sql",
      );
      await rm(missingPath);
      await expect(
        auditAuthorityServiceMigrations({
          serviceMigrationsDir,
          globalMigrationsDir,
        }),
      ).rejects.toThrow(/must contain exactly/);
      await writeFile(
        missingPath,
        sourceBytes["0059_relay_container_ring_transition_claims.sql"],
      );

      const extraPath = path.join(serviceMigrationsDir, "0003_extra.sql");
      await writeFile(extraPath, "SELECT 1;\n");
      await expect(
        auditAuthorityServiceMigrations({
          serviceMigrationsDir,
          globalMigrationsDir,
        }),
      ).rejects.toThrow(/must contain exactly/);
      await rm(extraPath);

      await writeFile(
        path.join(serviceMigrationsDir, "0002_ring_transition_authority.sql"),
        `${sourceBytes["0060_relay_container_ring_transition_authority.sql"]} `,
      );
      await expect(
        auditAuthorityServiceMigrations({
          serviceMigrationsDir,
          globalMigrationsDir,
        }),
      ).rejects.toThrow(/migration byte drift/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("audits a complete local/staging config and migration set together", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cinatoken-authority-complete-"),
    );
    const serviceDir = path.join(root, "service");
    const serviceMigrationsDir = path.join(serviceDir, AUTHORITY_MIGRATIONS_DIR);
    const globalMigrationsDir = path.join(root, "global");
    try {
      await Promise.all([
        mkdir(serviceMigrationsDir, { recursive: true }),
        mkdir(globalMigrationsDir, { recursive: true }),
      ]);
      await Promise.all(
        Object.entries(AUTHORITY_CONFIG_FILES).map(([environment, filename]) =>
          writeFile(
            path.join(serviceDir, filename),
            `${JSON.stringify(validConfig(environment), null, 2)}\n`,
          ),
        ),
      );
      for (const [serviceName, globalName] of Object.entries(
        AUTHORITY_SERVICE_MIGRATION_SOURCES,
      )) {
        const bytes = `-- exact ${globalName}\n`;
        await Promise.all([
          writeFile(path.join(serviceMigrationsDir, serviceName), bytes),
          writeFile(path.join(globalMigrationsDir, globalName), bytes),
        ]);
      }

      const report = await auditTrackedAuthorityConfigs({
        serviceDir,
        globalMigrationsDir,
      });
      expect(report.ok).toBe(true);
      expect(report.productionConfigAbsent).toBe(true);
      expect(report.migrations.exact).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
