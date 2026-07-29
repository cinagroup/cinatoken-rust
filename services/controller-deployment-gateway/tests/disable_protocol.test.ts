import { describe, expect, it } from "vitest";

import {
  createDisableHmacTokenForTest,
  disableHmacIdentityConfigValid,
  parseDisableCreateRequest,
  verifyDisableHmacRequest,
  type DisableGatewaySecurityEnv,
} from "../src/disable_protocol";
import { canonicalJson, sha256Hex } from "../src/protocol";
import {
  disableCommandFixture,
  disableCreateCredentialIdSha256,
  disableCreateRequestBody,
  disableCreateSecret,
  disableStatusCredentialIdSha256,
  disableStatusSecret,
} from "./disable_fixtures";

const securityEnv: DisableGatewaySecurityEnv = {
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: "authority-test",
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: "gateway-test",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID:
    "disable-create-v1",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    disableCreateCredentialIdSha256,
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET:
    disableCreateSecret,
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID: "",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    "",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID:
    "disable-status-v1",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    disableStatusCredentialIdSha256,
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET:
    disableStatusSecret,
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID: "",
  CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    "",
};

describe("controller deployment disable protocol", () => {
  it("accepts the exact frozen operation-14 identity", async () => {
    const parsed = await parseDisableCreateRequest(
      new TextEncoder().encode(await disableCreateRequestBody()),
    );
    expect(parsed.command).toMatchObject({
      leaseGeneration: 4,
      retryLimit: 0,
      sendAttemptLimit: 1,
      controllerEnabledSourceVersionId: "controller-enabled-version",
      controllerBaselineTargetVersionId: "controller-baseline-version",
    });
  });

  it("rejects equal source and baseline versions", async () => {
    const command = disableCommandFixture({
      controllerBaselineTargetVersionId: "controller-enabled-version",
    });
    await expect(
      parseDisableCreateRequest(
        new TextEncoder().encode(await disableCreateRequestBody(command)),
      ),
    ).rejects.toMatchObject({ code: "disable_versions_not_distinct" });
  });

  it("rejects a changed command digest and noncanonical bytes", async () => {
    const body = await disableCreateRequestBody();
    const value = JSON.parse(body) as Record<string, unknown>;
    value.controllerDisableCommandDigestSha256 = "f".repeat(64);
    await expect(
      parseDisableCreateRequest(
        new TextEncoder().encode(canonicalJson(value)),
      ),
    ).rejects.toMatchObject({ code: "disable_command_digest_mismatch" });
    await expect(
      parseDisableCreateRequest(new TextEncoder().encode(`${body}\n`)),
    ).rejects.toMatchObject({ code: "noncanonical_disable_json" });
  });

  it("binds the independent role, path, body, credential, and window", async () => {
    const body = await disableCreateRequestBody();
    const bytes = new TextEncoder().encode(body);
    const now = 2_000_000_000;
    const path =
      `/internal/v1/controller-deployment-disables/` +
      `${"1".repeat(64)}/create-once`;
    const token = await createDisableHmacTokenForTest(
      disableCreateSecret,
      "disable-create-v1",
      {
        issuer: "authority-test",
        audience: "gateway-test",
        role: "disable_create",
        credential_id_sha256: disableCreateCredentialIdSha256,
        request_id: "disable-create-request-1",
        method: "POST",
        path_and_query: path,
        body_sha256: await sha256Hex(bytes),
        issued_at: now - 1,
        expires_at: now + 30,
      },
    );
    const request = new Request(`https://gateway.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-controller-deployment-gateway-disable": token,
      },
      body,
    });
    await expect(
      verifyDisableHmacRequest(
        request,
        bytes,
        "disable_create",
        securityEnv,
        now,
      ),
    ).resolves.toMatchObject({
      role: "disable_create",
      requestId: "disable-create-request-1",
    });
    await expect(
      verifyDisableHmacRequest(
        request,
        bytes,
        "disable_status",
        securityEnv,
        now,
      ),
    ).rejects.toMatchObject({ code: "invalid_disable_authority" });
  });

  it("requires isolated, usable current identities and optional previous pairs", () => {
    expect(disableHmacIdentityConfigValid(securityEnv)).toBe(true);
    expect(disableHmacIdentityConfigValid({
      ...securityEnv,
      CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID:
        "disable-create-v1",
    })).toBe(false);
    expect(disableHmacIdentityConfigValid({
      ...securityEnv,
      CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET:
        "orphaned-secret-000000000000000000000000000000",
    })).toBe(false);
  });
});
