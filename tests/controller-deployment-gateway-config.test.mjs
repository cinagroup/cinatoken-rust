import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  GATEWAY_CONFIG_FILES,
  GATEWAY_REQUIRED_DISABLED_GATES,
  GATEWAY_REQUIRED_EMPTY_DISABLE_IDENTITIES,
  GATEWAY_REQUIRED_SECRET_BINDINGS,
  GATEWAY_SERVICE_DIR,
  auditGatewayConfig,
  auditTrackedGatewayConfigs,
  parseGatewayWranglerJsonc,
} from "../tools/audit_controller_deployment_gateway_config.mjs";

describe("controller deployment Gateway config audit", () => {
  test("accepts the tracked private local and staging fail-closed configs", async () => {
    const report = await auditTrackedGatewayConfigs();
    expect(report).toMatchObject({
      ok: true,
      productionConfigAbsent: true,
      migrations: [
        "0001_controller_deployment_gateway.sql",
        "0002_controller_deployment_gateway_disable.sql",
      ],
      environments: {
        local: {
          publicIngressAbsent: true,
          gatesDefaultOff: true,
          remoteBindingValuesRead: false,
        },
        staging: {
          publicIngressAbsent: true,
          gatesDefaultOff: true,
          remoteBindingValuesRead: false,
        },
      },
    });
    expect(report.environments.staging.requiredSecretBindings).toEqual(
      GATEWAY_REQUIRED_SECRET_BINDINGS,
    );
    expect(JSON.stringify(report)).not.toContain("account-placeholder");
  });

  test("rejects public ingress and every enabled mutation or read gate", async () => {
    const config = await trackedConfig("staging");
    for (const gate of GATEWAY_REQUIRED_DISABLED_GATES) {
      const enabled = structuredClone(config);
      enabled.vars[gate] = "true";
      expect(() => auditGatewayConfig(enabled, "staging")).toThrow(
        new RegExp(`${gate} must be false`),
      );
    }
    for (const capability of ["routes", "services", "durable_objects"]) {
      const exposed = structuredClone(config);
      exposed[capability] = [];
      expect(() => auditGatewayConfig(exposed, "staging")).toThrow(
        new RegExp(`prohibited capability: ${capability}`),
      );
    }
  });

  test("keeps all remote-only credentials out of tracked vars", async () => {
    const config = await trackedConfig("staging");
    for (const binding of GATEWAY_REQUIRED_SECRET_BINDINGS) {
      const leaked = structuredClone(config);
      leaked.vars[binding] = "tracked-secret-material";
      expect(() => auditGatewayConfig(leaked, "staging")).toThrow(
        /untracked Worker secret|tracked secret-like var/,
      );
    }
  });

  test("keeps every local and staging disable identity empty", async () => {
    for (const environment of ["local", "staging"]) {
      const config = await trackedConfig(environment);
      for (const identity of GATEWAY_REQUIRED_EMPTY_DISABLE_IDENTITIES) {
        expect(config.vars[identity]).toBe("");
      }
      const configured = structuredClone(config);
      configured.vars[
        "CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID"
      ] = "tracked-disable-create-v1";
      expect(() => auditGatewayConfig(configured, environment)).toThrow(
        /DISABLE_CREATE_HMAC_CURRENT_KID must be/,
      );
    }
  });

  test("binds the fixed account digest and isolates create/status identities", async () => {
    const config = await trackedConfig("staging");
    const wrongAccount = structuredClone(config);
    wrongAccount.vars.CLOUDFLARE_ACCOUNT_ID = "other-account";
    expect(() => auditGatewayConfig(wrongAccount, "staging")).toThrow(
      /account identity and digest must match/,
    );

    const collision = structuredClone(config);
    collision.vars.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID =
      "shared-v1";
    collision.vars.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID =
      "shared-v1";
    expect(() => auditGatewayConfig(collision, "staging")).toThrow(
      /HMAC identities must be isolated/,
    );

    const disableCollision = structuredClone(config);
    disableCollision.vars.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID =
      "shared-disable-v1";
    disableCollision.vars
      .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID =
      "shared-disable-v1";
    expect(() => auditGatewayConfig(disableCollision, "staging")).toThrow(
      /HMAC identities must be isolated/,
    );

    const configured = structuredClone(config);
    configured.vars.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID =
      "create-v1";
    configured.vars
      .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256 =
      digest("create-credential");
    configured.vars.CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID =
      "status-v1";
    configured.vars
      .CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256 =
      digest("status-credential");
    expect(auditGatewayConfig(configured, "staging").ok).toBe(true);
  });

  test("parses comments as data and rejects executable JSONC", () => {
    expect(parseGatewayWranglerJsonc(`{
      // data-only comment
      "value": ["// remains a string",],
    }`)).toEqual({ value: ["// remains a string"] });
    expect(() =>
      parseGatewayWranglerJsonc('{"value": globalThis.process}'),
    ).toThrow(/valid JSONC/);
  });
});

async function trackedConfig(environment) {
  const filename = GATEWAY_CONFIG_FILES[environment];
  return parseGatewayWranglerJsonc(
    await readFile(path.join(GATEWAY_SERVICE_DIR, filename), "utf8"),
    filename,
  );
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
