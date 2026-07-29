import { describe, expect, it, vi } from "vitest";

import {
  CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_REQUEST_CONTRACT,
  CONTROLLER_DEPLOYMENT_GATEWAY_IDEMPOTENCY_CONTRACT,
  controllerDeploymentMutationRequestSha256,
  createControllerDeploymentOnce,
  readControllerDeploymentStatus,
  validateControllerDeploymentGatewayClientConfig,
  type ControllerDeploymentGatewayClientEnv,
  type ControllerDeploymentGatewayCreateInput,
  type ControllerDeploymentGatewayServiceBinding,
  type ControllerDeploymentGatewayStatusInput,
} from "../src/controller_deployment_gateway_client";
import {
  CONTROLLER_ENABLE_COMMAND_CONTRACT,
  type FrozenControllerEnableCommand,
} from "../src/start_enable_dispatch_send";
import {
  canonicalJson,
  sha256Hex,
} from "../src/protocol";

const HMAC_DOMAIN = "cinatoken-controller-deployment-gateway-v1\n";
const HMAC_HEADER = "x-cinatoken-controller-deployment-gateway";
const NOW = 1_900_000_000;
const digest = (value: string): string => value.repeat(64);

interface CapturedToken {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  headerPart: string;
  claimsPart: string;
  signature: Uint8Array;
}

function command(): FrozenControllerEnableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_ENABLE_COMMAND_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    dispatchClaimDigestSha256: digest("3"),
    dispatchConsumptionReceiptDigestSha256: digest("4"),
    applicationDispatchConsumptionDigestSha256: digest("5"),
    applicationTicketIdSha256: digest("6"),
    campaignId: digest("7"),
    applicationDatabaseIdentitySha256: digest("8"),
    applicationVersionId: "application-version-1",
    authorityDatabaseIdentitySha256: digest("9"),
    authorityLedgerIdentitySha256: digest("a"),
    authorityLedgerHeadSha256: digest("b"),
    authorityVersionId: "authority-version-1",
    dispatchOwnerSha256: digest("c"),
    leaseTokenSha256: digest("d"),
    leaseGeneration: 1,
    controllerServiceName: "container-controller-staging",
    controllerEnableOperationIdSha256: digest("e"),
    controllerBaselineVersionId: "controller-baseline-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

async function createInput(): Promise<
  ControllerDeploymentGatewayCreateInput
> {
  const frozen = command();
  const controllerCommandDigestSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(frozen)),
  );
  const gatewayIdempotencyKeySha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson({
      schemaVersion: 1,
      contract: CONTROLLER_DEPLOYMENT_GATEWAY_IDEMPOTENCY_CONTRACT,
      attemptGeneration: 1,
      authorizationIdSha256: frozen.authorizationIdSha256,
      dispatchConsumptionReceiptDigestSha256:
        frozen.dispatchConsumptionReceiptDigestSha256,
      controllerCommandDigestSha256,
      controllerEnableOperationIdSha256:
        frozen.controllerEnableOperationIdSha256,
    })),
  );
  return {
    command: frozen,
    controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256,
    authorityAttemptDigestSha256: digest("f"),
    sendStartedEventDigestSha256: digest("0"),
  };
}

function jsonResponse(
  value: Record<string, unknown>,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function mutationOutcome(
  classification: "accepted" | "rejected" | "ambiguous" = "accepted",
): Record<string, unknown> {
  return {
    classification,
    httpStatus: classification === "accepted"
      ? 200
      : classification === "rejected"
      ? 400
      : null,
    responseBodySha256:
      classification === "ambiguous" ? null : digest("a"),
    responseRequestIdSha256:
      classification === "ambiguous" ? null : digest("b"),
    responseBytes: classification === "ambiguous" ? null : 128,
    recordedAt: NOW,
  };
}

async function createResponse(
  input: ControllerDeploymentGatewayCreateInput,
  requestId: string,
): Promise<Response> {
  return jsonResponse({
    result: "mutation_attempt_recorded",
    requestId,
    gatewayIdempotencyKeySha256:
      input.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      input.controllerCommandDigestSha256,
    mutationRequestSha256:
      await controllerDeploymentMutationRequestSha256(input.command),
    networkRequestSent: true,
    recoveryAction: "status_readback",
    outcome: mutationOutcome(),
    gatewayVersionId: "gateway-version-1",
  }, 201);
}

function statusInput(
  input: ControllerDeploymentGatewayCreateInput,
): ControllerDeploymentGatewayStatusInput {
  return {
    gatewayIdempotencyKeySha256:
      input.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      input.controllerCommandDigestSha256,
  };
}

function statusResponse(
  input: ControllerDeploymentGatewayStatusInput,
  requestId: string,
): Response {
  return jsonResponse({
    result: "status_observation_recorded",
    requestId,
    gatewayIdempotencyKeySha256:
      input.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      input.controllerCommandDigestSha256,
    remoteMutationSent: false,
    statusRequestCount: 2,
    targetStable: true,
    requiredMatchingObservations: 2,
    stabilityMinimumSeconds: 5,
    observation: {
      classification: "target_observed",
      deploymentsHttpStatus: 200,
      versionHttpStatus: 200,
      deploymentSetSha256: digest("d"),
      targetVersionSha256: digest("e"),
      responseRequestIdSha256: digest("f"),
      observationDigestSha256: digest("0"),
      recordedAt: NOW,
    },
    gatewayVersionId: "gateway-version-1",
  }, 201);
}

function env(
  fetchImpl: ControllerDeploymentGatewayServiceBinding["fetch"],
): ControllerDeploymentGatewayClientEnv {
  return {
    CONTROLLER_DEPLOYMENT_GATEWAY: { fetch: fetchImpl },
    CONTROLLER_DEPLOYMENT_GATEWAY_ISSUER:
      "shard-placement-authority-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_AUDIENCE:
      "controller-deployment-gateway-staging",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID:
      "create-current-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("1"),
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET:
      "create-current-secret-000000000000000000000000",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_KID:
      "create-previous-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      digest("2"),
    CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_PREVIOUS_SECRET:
      "create-previous-secret-00000000000000000000000",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID:
      "status-current-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("3"),
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET:
      "status-current-secret-000000000000000000000000",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_KID:
      "status-previous-v1",
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      digest("4"),
    CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET:
      "status-previous-secret-00000000000000000000000",
  };
}

function decodeToken(token: string): CapturedToken {
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  if (
    headerPart === undefined
    || claimsPart === undefined
    || signaturePart === undefined
  ) {
    throw new Error("invalid test token");
  }
  return {
    header: JSON.parse(
      new TextDecoder().decode(decodeBase64Url(headerPart)),
    ) as Record<string, unknown>,
    claims: JSON.parse(
      new TextDecoder().decode(decodeBase64Url(claimsPart)),
    ) as Record<string, unknown>,
    headerPart,
    claimsPart,
    signature: decodeBase64Url(signaturePart),
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(
    atob(normalized),
    (character) => character.charCodeAt(0),
  );
}

async function validSignature(
  token: CapturedToken,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    token.signature,
    new TextEncoder().encode(
      `${HMAC_DOMAIN}${token.headerPart}.${token.claimsPart}`,
    ),
  );
}

describe("controller deployment gateway Authority client", () => {
  it("builds the exact canonical create POST and HMAC claims", async () => {
    const input = await createInput();
    const requestId = "op5-gateway-create-request-1";
    let captured: Request | null = null;
    const fetchBinding = vi.fn(async (request: Request) => {
      captured = request;
      return createResponse(input, requestId);
    });

    const result = await createControllerDeploymentOnce(
      env(fetchBinding),
      input,
      { requestId, now: NOW },
    );

    expect(fetchBinding).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "mutation_attempt_recorded",
      networkRequestSent: true,
      recoveryAction: "status_readback",
      gatewayIdempotencyKeySha256:
        input.gatewayIdempotencyKeySha256,
      controllerCommandDigestSha256:
        input.controllerCommandDigestSha256,
    });
    const request = captured as unknown as Request;
    const pathAndQuery =
      `/internal/v1/controller-deployments/${input.gatewayIdempotencyKeySha256}/create-once`;
    expect(request.url).toBe(
      `https://controller-deployment-gateway.internal${pathAndQuery}`,
    );
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(request.headers.has("cookie")).toBe(false);
    expect(request.headers.has("origin")).toBe(false);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const expectedBody = canonicalJson({
      schemaVersion: 1,
      contract: CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_REQUEST_CONTRACT,
      command: input.command,
      controllerCommandDigestSha256:
        input.controllerCommandDigestSha256,
      gatewayIdempotencyKeySha256:
        input.gatewayIdempotencyKeySha256,
      authorityAttemptDigestSha256:
        input.authorityAttemptDigestSha256,
      sendStartedEventDigestSha256:
        input.sendStartedEventDigestSha256,
    });
    expect(new TextDecoder().decode(body)).toBe(expectedBody);
    expect(body.byteLength).toBeLessThanOrEqual(4 * 1024);

    const token = decodeToken(request.headers.get(HMAC_HEADER)!);
    expect(token.header).toEqual({
      alg: "HS256",
      kid: "create-current-v1",
      typ: "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY",
    });
    expect(token.claims).toEqual({
      audience: "controller-deployment-gateway-staging",
      body_sha256: await sha256Hex(body),
      credential_id_sha256: digest("1"),
      expires_at: NOW + 60,
      issued_at: NOW,
      issuer: "shard-placement-authority-staging",
      method: "POST",
      path_and_query: pathAndQuery,
      request_id: requestId,
      role: "create",
    });
    expect(
      new TextDecoder().decode(decodeBase64Url(token.headerPart)),
    ).toBe(canonicalJson(token.header));
    expect(
      new TextDecoder().decode(decodeBase64Url(token.claimsPart)),
    ).toBe(canonicalJson(token.claims));
    expect(
      await validSignature(
        token,
        "create-current-secret-000000000000000000000000",
      ),
    ).toBe(true);
    expect(
      await validSignature(
        token,
        "status-current-secret-000000000000000000000000",
      ),
    ).toBe(false);
  });

  it("builds the exact empty-body status POST with status credentials", async () => {
    const create = await createInput();
    const input = statusInput(create);
    const requestId = "op5-gateway-status-request-1";
    let captured: Request | null = null;
    const fetchBinding = vi.fn(async (request: Request) => {
      captured = request;
      return statusResponse(input, requestId);
    });

    const result = await readControllerDeploymentStatus(
      env(fetchBinding),
      input,
      {
        requestId,
        credentialGeneration: "previous",
        now: NOW,
      },
    );

    expect(fetchBinding).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "status_observation_recorded",
      remoteMutationSent: false,
      targetStable: true,
      observation: { classification: "target_observed" },
    });
    const request = captured as unknown as Request;
    const pathAndQuery =
      `/internal/v1/controller-deployments/${input.gatewayIdempotencyKeySha256}`
      + "/status-readback"
      + `?commandDigestSha256=${input.controllerCommandDigestSha256}`;
    expect(request.url).toBe(
      `https://controller-deployment-gateway.internal${pathAndQuery}`,
    );
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.headers.has("content-type")).toBe(false);
    expect((await request.clone().arrayBuffer()).byteLength).toBe(0);

    const token = decodeToken(request.headers.get(HMAC_HEADER)!);
    expect(token.header).toEqual({
      alg: "HS256",
      kid: "status-previous-v1",
      typ: "CINATOKEN-CONTROLLER-DEPLOYMENT-GATEWAY",
    });
    expect(token.claims).toEqual({
      audience: "controller-deployment-gateway-staging",
      body_sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      credential_id_sha256: digest("4"),
      expires_at: NOW + 60,
      issued_at: NOW,
      issuer: "shard-placement-authority-staging",
      method: "POST",
      path_and_query: pathAndQuery,
      request_id: requestId,
      role: "status",
    });
    expect(
      new TextDecoder().decode(decodeBase64Url(token.headerPart)),
    ).toBe(canonicalJson(token.header));
    expect(
      new TextDecoder().decode(decodeBase64Url(token.claimsPart)),
    ).toBe(canonicalJson(token.claims));
    expect(
      await validSignature(
        token,
        "status-previous-secret-00000000000000000000000",
      ),
    ).toBe(true);
    expect(
      await validSignature(
        token,
        "create-previous-secret-00000000000000000000000",
      ),
    ).toBe(false);
  });

  it("supports explicit create overlap credentials without retrying", async () => {
    const input = await createInput();
    const requestId = "op5-gateway-create-previous";
    let token: CapturedToken | null = null;
    const fetchBinding = vi.fn(async (request: Request) => {
      token = decodeToken(request.headers.get(HMAC_HEADER)!);
      return createResponse(input, requestId);
    });
    await createControllerDeploymentOnce(
      env(fetchBinding),
      input,
      {
        requestId,
        credentialGeneration: "previous",
        now: NOW,
      },
    );
    expect(fetchBinding).toHaveBeenCalledOnce();
    expect((token as unknown as CapturedToken).claims).toMatchObject({
      role: "create",
      credential_id_sha256: digest("2"),
    });
    expect(
      await validSignature(
        token as unknown as CapturedToken,
        "create-previous-secret-00000000000000000000000",
      ),
    ).toBe(true);
  });

  it("rejects partial or cross-role credential identities before fetch", () => {
    const fetchBinding = vi.fn();
    const base = env(fetchBinding);
    expect(() =>
      validateControllerDeploymentGatewayClientConfig(base)
    ).not.toThrow();
    expect(() =>
      validateControllerDeploymentGatewayClientConfig({
        ...base,
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_PREVIOUS_SECRET:
          undefined,
      })
    ).toThrowError(
      "controller_deployment_gateway_client_unavailable",
    );
    expect(() =>
      validateControllerDeploymentGatewayClientConfig({
        ...base,
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_SECRET:
          base
            .CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_SECRET,
      })
    ).toThrowError(
      "controller_deployment_gateway_client_unavailable",
    );
    expect(() =>
      validateControllerDeploymentGatewayClientConfig({
        ...base,
        CONTROLLER_DEPLOYMENT_GATEWAY_STATUS_HMAC_CURRENT_KID:
          base.CONTROLLER_DEPLOYMENT_GATEWAY_CREATE_HMAC_CURRENT_KID,
      })
    ).toThrowError(
      "controller_deployment_gateway_client_unavailable",
    );
    expect(fetchBinding).not.toHaveBeenCalled();
  });

  it("enforces the canonical 4 KiB create bound before Service Binding", async () => {
    const input = await createInput();
    const fetchBinding = vi.fn();
    const oversized = {
      ...input,
      command: {
        ...input.command,
        applicationVersionId: "x".repeat(5_000),
      },
    } as ControllerDeploymentGatewayCreateInput;
    await expect(
      createControllerDeploymentOnce(
        env(fetchBinding),
        oversized,
        { requestId: "oversized-create", now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "controller_deployment_gateway_create_request_too_large",
      status: 413,
      classification: "request_invalid",
      recoveryAction: "none",
    });
    expect(fetchBinding).not.toHaveBeenCalled();
  });

  it("bounds create and status responses with fail-closed recovery", async () => {
    const create = await createInput();
    const oversized = "x".repeat(64 * 1024 + 1);
    const createFetch = vi.fn(async () =>
      new Response(oversized, {
        status: 201,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }));
    await expect(
      createControllerDeploymentOnce(
        env(createFetch),
        create,
        { requestId: "bounded-create", now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "controller_deployment_gateway_create_response_too_large",
      classification: "create_outcome_unknown",
      recoveryAction: "status_only",
    });
    expect(createFetch).toHaveBeenCalledOnce();

    const status = statusInput(create);
    const statusFetch = vi.fn(async () =>
      jsonResponse(
        { error: "not read" },
        201,
        { "content-length": String(64 * 1024 + 1) },
      ));
    await expect(
      readControllerDeploymentStatus(
        env(statusFetch),
        status,
        { requestId: "bounded-status", now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "controller_deployment_gateway_status_invalid_response",
      classification: "status_unavailable",
      recoveryAction: "retry_status_only",
    });
    expect(statusFetch).toHaveBeenCalledOnce();
  });

  it("never retries and strips transport errors and secrets", async () => {
    const input = await createInput();
    const createSecret =
      "create-current-secret-000000000000000000000000";
    const createFetch = vi.fn(async () => {
      throw new Error(`upstream failed with ${createSecret}`);
    });
    let createFailure: unknown;
    try {
      await createControllerDeploymentOnce(
        env(createFetch),
        input,
        { requestId: "failed-create", now: NOW },
      );
    } catch (error) {
      createFailure = error;
    }
    expect(createFailure).toMatchObject({
      code: "controller_deployment_gateway_create_outcome_unknown",
      status: 503,
      classification: "create_outcome_unknown",
      recoveryAction: "status_only",
    });
    expect(String(createFailure)).not.toContain(createSecret);
    expect(createFetch).toHaveBeenCalledOnce();

    const statusSecret =
      "status-current-secret-000000000000000000000000";
    const statusFetch = vi.fn(async () => {
      throw new Error(`upstream failed with ${statusSecret}`);
    });
    let statusFailure: unknown;
    try {
      await readControllerDeploymentStatus(
        env(statusFetch),
        statusInput(input),
        { requestId: "failed-status", now: NOW },
      );
    } catch (error) {
      statusFailure = error;
    }
    expect(statusFailure).toMatchObject({
      code: "controller_deployment_gateway_status_unavailable",
      status: 503,
      classification: "status_unavailable",
      recoveryAction: "retry_status_only",
    });
    expect(String(statusFailure)).not.toContain(statusSecret);
    expect(statusFetch).toHaveBeenCalledOnce();
  });

  it("rejects mismatched success envelopes with role-specific classification", async () => {
    const input = await createInput();
    const createFetch = vi.fn(async () =>
      jsonResponse({
        result: "exact_replay",
        requestId: "mismatch-create",
        gatewayIdempotencyKeySha256: digest("f"),
        controllerCommandDigestSha256:
          input.controllerCommandDigestSha256,
        mutationRequestSha256: digest("1"),
        networkRequestSent: false,
        recoveryAction: "status_only",
        outcome: null,
        gatewayVersionId: "gateway-version-1",
      }, 200));
    await expect(
      createControllerDeploymentOnce(
        env(createFetch),
        input,
        { requestId: "mismatch-create", now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "controller_deployment_gateway_create_response_mismatch",
      classification: "create_outcome_unknown",
      recoveryAction: "status_only",
    });

    const status = statusInput(input);
    const statusFetch = vi.fn(async () =>
      jsonResponse({
        result: "status_observation_recorded",
        requestId: "mismatch-status",
        gatewayIdempotencyKeySha256:
          status.gatewayIdempotencyKeySha256,
        controllerCommandDigestSha256:
          status.controllerCommandDigestSha256,
        remoteMutationSent: true,
        statusRequestCount: 2,
        targetStable: false,
        requiredMatchingObservations: 2,
        stabilityMinimumSeconds: 5,
        observation: {
          classification: "ambiguous",
          deploymentsHttpStatus: null,
          versionHttpStatus: null,
          deploymentSetSha256: null,
          targetVersionSha256: null,
          responseRequestIdSha256: null,
          observationDigestSha256: digest("1"),
          recordedAt: NOW,
        },
        gatewayVersionId: "gateway-version-1",
      }, 201));
    await expect(
      readControllerDeploymentStatus(
        env(statusFetch),
        status,
        { requestId: "mismatch-status", now: NOW },
      ),
    ).rejects.toMatchObject({
      code: "controller_deployment_gateway_status_invalid_response",
      classification: "status_unavailable",
      recoveryAction: "retry_status_only",
    });
  });
});
