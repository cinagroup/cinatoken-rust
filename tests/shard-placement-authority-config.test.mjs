import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  REQUIRED_REMOTE_BINDINGS,
  ShardPlacementAuthorityConfigAuditError,
  auditConfig,
  auditTrackedConfigs,
  parseWranglerJsonc,
} from "../tools/audit_shard_placement_authority_config.mjs";

describe("shard placement Authority configuration", () => {
  test("is isolated, production-absent, default-off, and secret-free", async () => {
    const report = await auditTrackedConfigs();
    expect(report.ok).toBe(true);
    expect(report.productionConfigPresent).toBe(false);
    expect(report.migrationFiles).toEqual([
      "0001_shard_placement_authorizations.sql",
      "0002_shard_placement_execution_claims.sql",
    ]);
    for (const environment of ["local", "staging"]) {
      expect(report.environments[environment]).toMatchObject({
        bindings: [
          "d1_databases.DB",
          "version_metadata.CF_VERSION_METADATA",
          "services.SHARD_PLACEMENT_APPLICATION",
        ],
        gatesDefaultOff: true,
        ingress: "service_binding_only",
        route: null,
        remoteBindingsTracked: false,
      });
    }
  });

  test("rejects unexpected bindings, enabled gates, and tracked secrets", () => {
    const base = {
      name: "cinatoken-shard-placement-authority-local",
      main: "src/index.ts",
      compatibility_date: "2026-07-28",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: true, head_sampling_rate: 1 },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      services: [{
        binding: "SHARD_PLACEMENT_APPLICATION",
        service: "cinatoken-rust-api-local",
      }],
      vars: {
        ENVIRONMENT: "local",
        SHARD_PLACEMENT_AUTHORITY_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_READ_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_ISSUE_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_REVOKE_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_CLAIM_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_RECEIPT_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_RECOVERY_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_ACTIVATION_READ_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_APPLICATION_ISSUER:
          "cinatoken-shard-placement-authority-local",
        SHARD_PLACEMENT_APPLICATION_AUDIENCE:
          "cinatoken-rust-api-local",
        SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256: "",
        SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: "",
        SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: "",
        SHARD_PLACEMENT_AUTHORITY_POLICY_ID: "",
        SHARD_PLACEMENT_AUTHORITY_POLICY_SHA256: "",
        SHARD_PLACEMENT_PERMIT_KEY_ID: "",
        SHARD_PLACEMENT_PERMIT_SPKI_SHA256: "",
        SHARD_PLACEMENT_SECURITY_KEY_ID: "",
        SHARD_PLACEMENT_SECURITY_SPKI_SHA256: "",
        SHARD_PLACEMENT_OPERATIONS_KEY_ID: "",
        SHARD_PLACEMENT_OPERATIONS_SPKI_SHA256: "",
        SHARD_PLACEMENT_RELEASE_KEY_ID: "",
        SHARD_PLACEMENT_RELEASE_SPKI_SHA256: "",
        SHARD_PLACEMENT_ROLLBACK_KEY_ID: "",
        SHARD_PLACEMENT_ROLLBACK_SPKI_SHA256: "",
        SHARD_PLACEMENT_READ_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_ISSUE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_ISSUE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_REVOKE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_REVOKE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_CLAIM_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_CLAIM_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_RECEIPT_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_RECEIPT_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_RECOVERY_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_RECOVERY_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_AUTHORITY_ISSUER:
          "cinatoken-shard-placement-operator-local",
        SHARD_PLACEMENT_AUTHORITY_AUDIENCE:
          "cinatoken-shard-placement-authority-local",
        SHARD_PLACEMENT_PERMIT_ISSUER:
          "cinatoken-shard-placement-permit-issuer-local",
      },
      d1_databases: [{
        binding: "DB",
        database_name: "cinatoken-shard-placement-control-local",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations",
      }],
    };

    expect(() => auditConfig({
      ...base,
      kv_namespaces: [],
    }, "local")).toThrow(ShardPlacementAuthorityConfigAuditError);
    expect(() => auditConfig({
      ...base,
      routes: [{
        pattern: "authority.example.test/*",
        zone_name: "example.test",
      }],
    }, "local")).toThrow(ShardPlacementAuthorityConfigAuditError);
    expect(() => auditConfig({
      ...base,
      vars: {
        ...base.vars,
        SHARD_PLACEMENT_AUTHORITY_ENABLED: "true",
      },
    }, "local")).toThrow(ShardPlacementAuthorityConfigAuditError);
    expect(() => auditConfig({
      ...base,
      vars: {
        ...base.vars,
        [REQUIRED_REMOTE_BINDINGS[0]]: "tracked-public-key",
      },
    }, "local")).toThrow(ShardPlacementAuthorityConfigAuditError);
  });

  test("parses JSONC but rejects a non-object", () => {
    expect(parseWranglerJsonc('{"workers_dev": false,}')).toEqual({
      workers_dev: false,
    });
    expect(() => parseWranglerJsonc("[]")).toThrow(
      ShardPlacementAuthorityConfigAuditError,
    );
  });
});
