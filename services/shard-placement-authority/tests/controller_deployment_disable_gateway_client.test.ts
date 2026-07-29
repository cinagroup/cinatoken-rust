import { describe, expect, it } from "vitest";

import {
  CONTROLLER_DISABLE_COMMAND_CONTRACT,
  controllerDisableCommandDigestSha256,
  controllerDisableIdempotencyKeySha256,
  controllerDisableMutationRequestSha256,
  createControllerDisableOnceWithEvidence,
  readControllerDisableStatusWithEvidence,
  validateControllerDeploymentDisableGatewayClientConfig,
  type ControllerDeploymentDisableGatewayClientEnv,
  type ControllerDisableCreateInput,
  type FrozenControllerDisableCommand,
} from "../src/controller_deployment_disable_gateway_client";
import {
  parseDisableCreateRequest,
  verifyDisableHmacRequest,
  type DisableGatewaySecurityEnv,
} from "../../controller-deployment-gateway/src/disable_protocol";
import { canonicalJson } from "../src/protocol";

const NOW = 1_900_000_000;
const CREATE_KID = "disable-create-v1";
const STATUS_KID = "disable-status-v1";
const CREATE_CREDENTIAL_ID = "c".repeat(64);
const STATUS_CREDENTIAL_ID = "d".repeat(64);
const CREATE_SECRET =
  "disable-create-authority-secret-0123456789abcdef0123456789";
const STATUS_SECRET =
  "disable-status-authority-secret-0123456789abcdef0123456789";
const GATEWAY_VERSION = "controller-deployment-gateway-version-14";
const digest = (value: string): string => value.repeat(64);

describe("Controller deployment disable Gateway client", () => {
  it("produces create and status HMACs accepted by the Gateway verifier", async () => {
    const input = await createInput();
    const roles: string[] = [];
    const env = clientEnv(async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      const role = new URL(request.url).pathname.endsWith("/create-once")
        ? "disable_create"
        : "disable_status";
      const verified = await verifyDisableHmacRequest(
        request,
        body,
        role,
        gatewaySecurityEnv(),
        NOW,
      );
      roles.push(verified.role);
      if (role === "disable_create") {
        const parsed = await parseDisableCreateRequest(body);
        return secureCanonicalResponse({
          controllerDisableCommandDigestSha256:
            parsed.controllerDisableCommandDigestSha256,
          gatewayDisableIdempotencyKeySha256:
            parsed.gatewayDisableIdempotencyKeySha256,
          gatewayVersionId: GATEWAY_VERSION,
          mutationRequestSha256:
            await controllerDisableMutationRequestSha256(parsed.command),
          networkRequestSent: true,
          outcome: {
            classification: "accepted",
            httpStatus: 200,
            recordedAt: NOW,
            responseBodySha256: digest("a"),
            responseBytes: 128,
            responseRequestIdSha256: digest("b"),
          },
          recoveryAction: "status_only",
          requestId: verified.requestId,
          result: "disable_mutation_attempt_recorded",
        }, 201);
      }
      return secureCanonicalResponse({
        controllerDisableCommandDigestSha256:
          input.controllerDisableCommandDigestSha256,
        gatewayDisableIdempotencyKeySha256:
          input.gatewayDisableIdempotencyKeySha256,
        gatewayVersionId: GATEWAY_VERSION,
        observation: {
          baselineVersionHttpStatus: 200,
          baselineVersionSha256: digest("1"),
          classification: "exact_disable_observed",
          deploymentsHttpStatus: 200,
          deploymentSetSha256: digest("2"),
          observationDigestSha256: digest("3"),
          recordedAt: NOW,
          responseRequestIdSha256: digest("4"),
          stateDigestSha256: digest("5"),
        },
        remoteMutationSent: false,
        remoteReadSent: true,
        requestId: verified.requestId,
        requiredMatchingObservations: 2,
        result: "disable_status_observation_recorded",
        stabilityMinimumSeconds: 5,
        targetStable: true,
      }, 201);
    });

    const created = await createControllerDisableOnceWithEvidence(
      env,
      input,
      { requestId: "operation-14-disable-create", now: NOW },
    );
    const status = await readControllerDisableStatusWithEvidence(
      env,
      {
        gatewayDisableIdempotencyKeySha256:
          input.gatewayDisableIdempotencyKeySha256,
        controllerDisableCommandDigestSha256:
          input.controllerDisableCommandDigestSha256,
      },
      { requestId: "operation-14-disable-status", now: NOW },
    );

    expect(roles).toEqual(["disable_create", "disable_status"]);
    expect(created.value).toMatchObject({
      result: "disable_mutation_attempt_recorded",
      networkRequestSent: true,
      recoveryAction: "status_only",
      gatewayVersionId: GATEWAY_VERSION,
    });
    expect(status.value).toMatchObject({
      remoteMutationSent: false,
      remoteReadSent: true,
      targetStable: true,
      observation: { classification: "exact_disable_observed" },
    });
    expect(created.gatewayCredentialIdSha256).toBe(CREATE_CREDENTIAL_ID);
    expect(status.gatewayCredentialIdSha256).toBe(STATUS_CREDENTIAL_ID);
  });

  it("classifies an unknown create outcome as status-only recovery", async () => {
    const input = await createInput();
    const env = clientEnv(async () => {
      throw new Error("service binding unavailable");
    });

    await expect(createControllerDisableOnceWithEvidence(
      env,
      input,
      { requestId: "operation-14-disable-unknown", now: NOW },
    )).rejects.toMatchObject({
      code: "controller_disable_gateway_create_outcome_unknown",
      classification: "create_outcome_unknown",
      recoveryAction: "status_only",
    });
  });

  it("rejects a stable response that does not prove exact disable", async () => {
    const input = await createInput();
    const env = clientEnv(async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      const verified = await verifyDisableHmacRequest(
        request,
        body,
        "disable_status",
        gatewaySecurityEnv(),
        NOW,
      );
      return secureCanonicalResponse({
        controllerDisableCommandDigestSha256:
          input.controllerDisableCommandDigestSha256,
        gatewayDisableIdempotencyKeySha256:
          input.gatewayDisableIdempotencyKeySha256,
        gatewayVersionId: GATEWAY_VERSION,
        observation: {
          baselineVersionHttpStatus: 200,
          baselineVersionSha256: digest("1"),
          classification: "deployment_drift",
          deploymentsHttpStatus: 200,
          deploymentSetSha256: digest("2"),
          observationDigestSha256: digest("3"),
          recordedAt: NOW,
          responseRequestIdSha256: digest("4"),
          stateDigestSha256: digest("5"),
        },
        remoteMutationSent: false,
        remoteReadSent: true,
        requestId: verified.requestId,
        requiredMatchingObservations: 2,
        result: "disable_status_observation_recorded",
        stabilityMinimumSeconds: 5,
        targetStable: true,
      }, 201);
    });

    await expect(readControllerDisableStatusWithEvidence(
      env,
      {
        gatewayDisableIdempotencyKeySha256:
          input.gatewayDisableIdempotencyKeySha256,
        controllerDisableCommandDigestSha256:
          input.controllerDisableCommandDigestSha256,
      },
      { requestId: "operation-14-disable-drift", now: NOW },
    )).rejects.toMatchObject({
      code: "controller_disable_gateway_invalid_response",
      classification: "invalid_response",
      recoveryAction: "status_only",
    });
  });

  it("requires isolated create and status credential identities", () => {
    const env = {
      ...clientEnv(async () => new Response(null, { status: 503 })),
      CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID:
        CREATE_KID,
      CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        CREATE_CREDENTIAL_ID,
      CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET:
        CREATE_SECRET,
    };
    expect(() =>
      validateControllerDeploymentDisableGatewayClientConfig(env)
    ).toThrow(expect.objectContaining({
      code: "controller_disable_gateway_client_config_invalid",
    }));
  });
});

async function createInput(): Promise<ControllerDisableCreateInput> {
  const command = disableCommand();
  return {
    command,
    controllerDisableCommandDigestSha256:
      await controllerDisableCommandDigestSha256(command),
    gatewayDisableIdempotencyKeySha256:
      await controllerDisableIdempotencyKeySha256(command),
    authorityAttemptDigestSha256: digest("9"),
    sendStartedEventDigestSha256: digest("0"),
  };
}

function disableCommand(): FrozenControllerDisableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    operation14IdSha256: digest("3"),
    authorityDatabaseIdentitySha256: digest("4"),
    authorityLedgerIdentitySha256: digest("5"),
    authorityLedgerHeadSha256: digest("6"),
    authorityVersionId: "authority-version-14",
    leaseOwnerSha256: digest("7"),
    leaseTokenSha256: digest("8"),
    leaseGeneration: 4,
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerEnabledSourceVersionId: "controller-enabled-version",
    controllerBaselineTargetVersionId: "controller-baseline-version",
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

function clientEnv(
  fetch: ControllerDeploymentDisableGatewayClientEnv[
    "CONTROLLER_DEPLOYMENT_GATEWAY"
  ]["fetch"],
): ControllerDeploymentDisableGatewayClientEnv {
  return {
    CONTROLLER_DEPLOYMENT_GATEWAY: { fetch },
    ...gatewaySecurityEnv(),
  };
}

function gatewaySecurityEnv(): DisableGatewaySecurityEnv {
  return {
    CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER:
      "cinatoken-shard-placement-authority-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE:
      "cinatoken-controller-deployment-gateway-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_KID:
      CREATE_KID,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      CREATE_CREDENTIAL_ID,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_SECRET:
      CREATE_SECRET,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_KID: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_PREVIOUS_SECRET: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_KID:
      STATUS_KID,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      STATUS_CREDENTIAL_ID,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_SECRET:
      STATUS_SECRET,
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_KID: "",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_PREVIOUS_SECRET: "",
  };
}

function secureCanonicalResponse(
  value: Record<string, unknown>,
  status: number,
): Response {
  return new Response(canonicalJson(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
