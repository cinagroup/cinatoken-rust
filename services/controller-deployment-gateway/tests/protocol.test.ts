import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  canonicalJson,
  createHmacTokenForTest,
  parseCreateDeploymentRequest,
  sha256Hex,
  verifyHmacRequest,
  type GatewaySecurityEnv,
} from "../src/protocol";
import {
  createCredentialIdSha256,
  createRequestBody,
  createSecret,
  statusCredentialIdSha256,
  statusSecret,
} from "./fixtures";

const securityEnv: GatewaySecurityEnv = {
  CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER: "authority-test",
  CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE: "gateway-test",
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID: "create-v1",
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    createCredentialIdSha256,
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET: createSecret,
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID: "",
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID: "status-v1",
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    statusCredentialIdSha256,
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET: statusSecret,
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID: "",
  CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256: "",
};

describe("controller deployment gateway protocol", () => {
  it("accepts the exact canonical frozen command and derived identities", async () => {
    const body = await createRequestBody();
    const parsed = await parseCreateDeploymentRequest(
      new TextEncoder().encode(body),
    );
    expect(parsed.command.controllerServiceName).toBe(
      "cinatoken-container-controller-staging",
    );
    expect(parsed.command.sendAttemptLimit).toBe(1);
    expect(parsed.command.retryLimit).toBe(0);
  });

  it("rejects noncanonical JSON and mismatched command identity", async () => {
    const body = await createRequestBody();
    await expect(
      parseCreateDeploymentRequest(
        new TextEncoder().encode(`${body}\n`),
      ),
    ).rejects.toMatchObject({ code: "noncanonical_json" });

    const value = JSON.parse(body) as Record<string, unknown>;
    value.controllerCommandDigestSha256 = "f".repeat(64);
    await expect(
      parseCreateDeploymentRequest(
        new TextEncoder().encode(canonicalJson(value)),
      ),
    ).rejects.toMatchObject({
      code: "controller_command_digest_mismatch",
    });
  });

  it("binds role, method, path, body, credential, and time window", async () => {
    const body = await createRequestBody();
    const bytes = new TextEncoder().encode(body);
    const now = 2_000_000_000;
    const path =
      `/internal/v1/controller-deployments/${"1".repeat(64)}/create-once`;
    const claims = {
      issuer: "authority-test",
      audience: "gateway-test",
      role: "create" as const,
      credential_id_sha256: createCredentialIdSha256,
      request_id: "create-request-1",
      method: "POST",
      path_and_query: path,
      body_sha256: await sha256Hex(bytes),
      issued_at: now - 1,
      expires_at: now + 30,
    };
    const token = await createHmacTokenForTest(
      createSecret,
      "create-v1",
      claims,
    );
    const request = new Request(`https://gateway.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatoken-controller-deployment-gateway": token,
      },
      body,
    });
    await expect(
      verifyHmacRequest(request, bytes, "create", securityEnv, now),
    ).resolves.toMatchObject({
      role: "create",
      requestId: "create-request-1",
      credentialIdSha256: createCredentialIdSha256,
    });
    await expect(
      verifyHmacRequest(request, bytes, "status", securityEnv, now),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      verifyHmacRequest(
        request,
        new TextEncoder().encode(`${body} `),
        "create",
        securityEnv,
        now,
      ),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch" });
  });
});
