import { describe, expect, it } from "vitest";

import {
  controllerDisableAttestationCredentialIdSha256,
  readControllerDisableAttestation,
  validateControllerDisableAttestationClientConfig,
  type ControllerDisableAttestationClientEnv,
} from "../src/controller_disable_attestation_client";
import {
  handleControllerDisableAttestationRequest,
  type ControllerDisableAttestationEnvironment,
} from "../../container-controller/src/controller_disable_attestation";
import {
  campaignActionGateInventory,
  SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES,
} from "../../container-controller/src/shard_activation_campaign";

const NOW = 1_900_000_000;
const SECRET =
  "controller-disable-attestation-secret-0123456789abcdef0123456789";
const KID = "disable-attestation-v1";
const SERVICE = "cinatoken-container-controller-staging";
const VERSION = "controller-baseline-version";

describe("Controller disable attestation client", () => {
  it("is accepted by the Controller and binds the complete closed-gate inventory", async () => {
    const controller = controllerEnv();
    const inventory = await campaignActionGateInventory(controller);
    const env = clientEnv(async (request) =>
      handleControllerDisableAttestationRequest(request, controller, NOW)
    );

    const evidence = await readControllerDisableAttestation(
      env,
      {
        controllerServiceName: SERVICE,
        controllerVersionId: VERSION,
        actionGateInventorySha256: inventory.digestSha256,
        actionGateCount: inventory.count,
      },
      {
        requestId: "operation-14-controller-attestation",
        now: NOW,
      },
    );

    expect(evidence.credentialIdSha256).toBe(
      await controllerDisableAttestationCredentialIdSha256(KID),
    );
    expect(evidence.value).toMatchObject({
      controllerServiceName: SERVICE,
      controllerVersionId: VERSION,
      controllerEnabled: false,
      executionEnabled: false,
      allActionGatesFalse: true,
      actionGates: {
        allActionGatesFalse: true,
        count: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
        digestSha256: inventory.digestSha256,
      },
    });
    expect(evidence.value.actionGates.inventory).toHaveLength(
      SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
    );
    expect(evidence.responseBytes).toBeGreaterThan(0);
  });

  it("fails closed when the expected Controller version or gate digest drifts", async () => {
    const controller = controllerEnv();
    const inventory = await campaignActionGateInventory(controller);
    const env = clientEnv(async (request) =>
      handleControllerDisableAttestationRequest(request, controller, NOW)
    );

    await expect(readControllerDisableAttestation(
      env,
      {
        controllerServiceName: SERVICE,
        controllerVersionId: "different-controller-version",
        actionGateInventorySha256: inventory.digestSha256,
        actionGateCount: inventory.count,
      },
      { requestId: "operation-14-version-drift", now: NOW },
    )).rejects.toMatchObject({
      code: "controller_disable_attestation_invalid_response",
      classification: "attestation_invalid",
    });

    await expect(readControllerDisableAttestation(
      env,
      {
        controllerServiceName: SERVICE,
        controllerVersionId: VERSION,
        actionGateInventorySha256: "f".repeat(64),
        actionGateCount: inventory.count,
      },
      { requestId: "operation-14-gate-drift", now: NOW },
    )).rejects.toMatchObject({
      code: "controller_disable_attestation_invalid_response",
      classification: "attestation_invalid",
    });
  });

  it("rejects attestation while any execution-capable action gate is open", async () => {
    const controller = {
      ...controllerEnv(),
      CONTAINER_PROVIDER_EGRESS_ENABLED: "true",
    };
    const inventory = await campaignActionGateInventory(controller);
    const env = clientEnv(async (request) =>
      handleControllerDisableAttestationRequest(request, controller, NOW)
    );

    await expect(readControllerDisableAttestation(
      env,
      {
        controllerServiceName: SERVICE,
        controllerVersionId: VERSION,
        actionGateInventorySha256: inventory.digestSha256,
        actionGateCount: inventory.count,
      },
      { requestId: "operation-14-open-gate", now: NOW },
    )).rejects.toMatchObject({
      code: "controller_disable_attestation_invalid_response",
      classification: "attestation_invalid",
    });
  });

  it("rejects a reused current and previous credential identity", () => {
    const env = {
      ...clientEnv(async () => new Response(null, { status: 503 })),
      CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: KID,
      CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET: SECRET,
    };
    expect(() =>
      validateControllerDisableAttestationClientConfig(env)
    ).toThrow(expect.objectContaining({
      code: "controller_disable_attestation_client_config_invalid",
    }));
  });
});

function controllerEnv(): ControllerDisableAttestationEnvironment {
  return {
    ...Object.fromEntries(
      SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.map((name) => [name, "false"]),
    ) as Pick<
      ControllerDisableAttestationEnvironment,
      (typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number]
    >,
    CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER:
      "cinatoken-shard-placement-authority-staging",
    CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE:
      "cinatoken-container-controller-staging",
    CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: KID,
    CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: "",
    CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: SECRET,
    CONTAINER_CONTROLLER_SERVICE_NAME: SERVICE,
    CF_VERSION_METADATA: { id: VERSION },
  };
}

function clientEnv(
  fetch: ControllerDisableAttestationClientEnv[
    "CONTAINER_CONTROLLER"
  ]["fetch"],
): ControllerDisableAttestationClientEnv {
  return {
    CONTAINER_CONTROLLER: { fetch },
    CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER:
      "cinatoken-shard-placement-authority-staging",
    CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE:
      "cinatoken-container-controller-staging",
    CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: KID,
    CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: SECRET,
    CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: "",
    CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET: "",
  };
}
