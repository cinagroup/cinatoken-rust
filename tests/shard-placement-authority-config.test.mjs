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
      "0003_shard_placement_dispatch_consumptions.sql",
      "0004_shard_placement_dispatch_consumption_recoveries.sql",
      "0005_operation_five_send_attempts.sql",
      "0006_operation_five_gateway_events.sql",
      "0007_operation_five_terminal_receipts.sql",
      "0008_operation_readiness_receipts.sql",
      "0009_operation_fourteen_disable_receipts.sql",
    ]);
    for (const environment of ["local", "staging"]) {
      expect(report.environments[environment]).toMatchObject({
        bindings: [
          "d1_databases.DB",
          "version_metadata.CF_VERSION_METADATA",
          "services.SHARD_PLACEMENT_APPLICATION",
          "services.CONTROLLER_DEPLOYMENT_GATEWAY",
          "services.CONTAINER_CONTROLLER",
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
      services: [
        {
          binding: "SHARD_PLACEMENT_APPLICATION",
          service: "cinatoken-rust-api-local",
        },
        {
          binding: "CONTROLLER_DEPLOYMENT_GATEWAY",
          service: "cinatoken-controller-deployment-gateway-local",
        },
        {
          binding: "CONTAINER_CONTROLLER",
          service: "cinatoken-container-controller-local",
        },
      ],
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
        SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_PRE_DISPATCH_READ_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_OUTBOX_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_RECEIPT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CLAIM_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECEIPT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECOVERY_READ_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECOVERY_RECEIPT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_READINESS_PROBE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_READINESS_READBACK_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_READINESS_ATTEMPT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_READINESS_TERMINAL_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_DISABLE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_READBACK_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_ATTEMPT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_TERMINAL_WRITE_ENABLED:
          "false",
        SHARD_PLACEMENT_AUTHORITY_EXPECTED_CONTROLLER_DEPLOYMENT_GATEWAY_VERSION_ID:
          "",
        SHARD_PLACEMENT_AUTHORITY_GATEWAY_CREATE_ENABLED: "false",
        SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED: "false",
        CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER:
          "cinatoken-shard-placement-authority-local",
        CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE:
          "cinatoken-controller-deployment-gateway-local",
        CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID: "",
        CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: "",
        CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID: "",
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: "",
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID:
          "",
        CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER:
          "cinatoken-shard-placement-authority-local",
        CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE:
          "cinatoken-container-controller-local",
        CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: "",
        CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: "",
        CONTAINER_CONTROLLER_READINESS_ISSUER:
          "cinatoken-shard-placement-authority-local",
        CONTAINER_CONTROLLER_READINESS_AUDIENCE:
          "cinatoken-container-controller-local",
        CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_KID: "",
        CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_KID: "",
        CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_KID: "",
        CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_KID: "",
        CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_ISSUER:
          "cinatoken-shard-placement-authority-local",
        SHARD_PLACEMENT_APPLICATION_AUDIENCE:
          "cinatoken-rust-api-local",
        SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_APPLICATION_ACTIVATION_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_KID:
          "",
        SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_KID:
          "",
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
          "",
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID:
          "",
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
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
        SHARD_PLACEMENT_ACTIVATE_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_ACTIVATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_ACTIVATE_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_ACTIVATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_ENABLE_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_ENABLE_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_ENABLE_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_ENABLE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_DISPATCH_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_DISPATCH_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_DISPATCH_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_DISPATCH_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_GRANT_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_GRANT_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_GRANT_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_SEND_HMAC_CURRENT_KID: "",
        SHARD_PLACEMENT_SEND_HMAC_CURRENT_CREDENTIAL_ID_SHA256: "",
        SHARD_PLACEMENT_SEND_HMAC_PREVIOUS_KID: "",
        SHARD_PLACEMENT_SEND_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
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
    const varsWithoutTerminalWriteGate = { ...base.vars };
    delete varsWithoutTerminalWriteGate
      .SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED;
    expect(() => auditConfig({
      ...base,
      vars: varsWithoutTerminalWriteGate,
    }, "local")).toThrow(ShardPlacementAuthorityConfigAuditError);
    expect(() => auditConfig({
      ...base,
      vars: {
        ...base.vars,
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED:
          "true",
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
