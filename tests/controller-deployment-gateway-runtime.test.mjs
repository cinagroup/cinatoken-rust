import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import gatewayWorker from "../services/controller-deployment-gateway/src/index.ts";
import {
  canonicalJson,
  createHmacTokenForTest,
  sha256Hex,
} from "../services/controller-deployment-gateway/src/protocol.ts";
import {
  createRequestFixture,
} from "../services/controller-deployment-gateway/tests/fixtures.ts";
import {
  createDisableHmacTokenForTest,
} from "../services/controller-deployment-gateway/src/disable_protocol.ts";
import {
  disableCreateRequestFixture,
} from "../services/controller-deployment-gateway/tests/disable_fixtures.ts";

const origin = "https://controller-deployment-gateway-runtime.test";
const createSecret =
  "create-runtime-secret-00000000000000000000000000000000";
const statusSecret =
  "status-runtime-secret-00000000000000000000000000000000";
const disableCreateSecret =
  "disable-create-runtime-secret-000000000000000000000000";
const disableStatusSecret =
  "disable-status-runtime-secret-000000000000000000000000";
const stabilityProofWaitMs = 10_100;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

describe("controller deployment gateway Workerd runtime", () => {
  it("linearizes one mutation and makes every exact replay status-only", async () => {
    const create = await createRequestFixture();
    const body = canonicalJson(create);
    const path =
      `/internal/v1/controller-deployments/` +
      `${create.gatewayIdempotencyKeySha256}/create-once`;
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        gatewayFetch("POST", path, {
          role: "create",
          body,
          requestId: `create-runtime-${index + 1}`,
        })),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const payloads = await Promise.all(
      concurrent.map((response) => response.json()),
    );
    const sent = payloads.filter((payload) => payload.networkRequestSent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      result: "mutation_attempt_recorded",
      recoveryAction: "status_readback",
      outcome: { classification: "accepted", httpStatus: 200 },
    });
    const replay = payloads.find((payload) => !payload.networkRequestSent);
    expect(replay).toMatchObject({
      result: "exact_replay",
      recoveryAction: "status_only",
    });

    const laterReplay = await gatewayFetch("POST", path, {
      role: "create",
      body,
      requestId: "create-runtime-3",
    });
    expect(laterReplay.status).toBe(200);
    expect(await laterReplay.json()).toMatchObject({
      result: "exact_replay",
      networkRequestSent: false,
      recoveryAction: "status_only",
    });

    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM controller_deployment_gateway_operations)
          AS operations,
        (SELECT COUNT(*) FROM controller_deployment_gateway_dispatches)
          AS dispatches,
        (SELECT COUNT(*) FROM controller_deployment_gateway_outcomes)
          AS outcomes`,
    ).first();
    expect(counts).toEqual({
      operations: 1,
      dispatches: 1,
      outcomes: 1,
    });
  });

  it("performs repeatable status-only readback without mutation", async () => {
    const create = await createRequestFixture();
    const createBody = canonicalJson(create);
    const createPath =
      `/internal/v1/controller-deployments/` +
      `${create.gatewayIdempotencyKeySha256}/create-once`;
    const created = await gatewayFetch("POST", createPath, {
      role: "create",
      body: createBody,
      requestId: "status-setup-create",
    });
    expect(created.status).toBe(201);

    const statusPath =
      `/internal/v1/controller-deployments/` +
      `${create.gatewayIdempotencyKeySha256}/status-readback` +
      `?commandDigestSha256=${create.controllerCommandDigestSha256}`;
    const first = await gatewayFetch("POST", statusPath, {
      role: "status",
      requestId: "status-runtime-1",
    });
    expect(first.status).toBe(201);
    const firstPayload = await first.json();
    expect(firstPayload).toMatchObject({
      result: "status_observation_recorded",
      remoteMutationSent: false,
      statusRequestCount: 2,
      targetStable: false,
      observation: { classification: "target_observed" },
    });

    const exactReplay = await gatewayFetch("POST", statusPath, {
      role: "status",
      requestId: "status-runtime-1",
    });
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toMatchObject({
      result: "status_observation_replayed",
      remoteMutationSent: false,
      observation: { classification: "target_observed" },
    });
    await new Promise((resolve) => setTimeout(resolve, stabilityProofWaitMs));
    const stable = await gatewayFetch("POST", statusPath, {
      role: "status",
      requestId: "status-runtime-2",
    });
    expect(stable.status).toBe(201);
    const stablePayload = await stable.json();
    expect(stablePayload).toMatchObject({
      result: "status_observation_recorded",
      remoteMutationSent: false,
      targetStable: true,
      observation: { classification: "target_observed" },
    });
    expect(stablePayload.observation.observationDigestSha256)
      .toBe(firstPayload.observation.observationDigestSha256);
    const stableReplay = await gatewayFetch("POST", statusPath, {
      role: "status",
      requestId: "status-runtime-2",
    });
    expect(stableReplay.status).toBe(200);
    const stableReplayPayload = await stableReplay.json();
    expect(stableReplayPayload).toMatchObject({
      result: "status_observation_replayed",
      remoteMutationSent: false,
      targetStable: true,
      observation: { classification: "target_observed" },
    });
    expect(stableReplayPayload.observation.observationDigestSha256)
      .toBe(stablePayload.observation.observationDigestSha256);
    const observationCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM controller_deployment_gateway_observations`,
    ).first();
    expect(observationCount).toEqual({ count: 2 });
  });

  it("linearizes operation-14 disable and proves stable baseline readback", async () => {
    const create = await disableCreateRequestFixture();
    const body = canonicalJson(create);
    const path =
      `/internal/v1/controller-deployment-disables/`
      + `${create.gatewayDisableIdempotencyKeySha256}/create-once`;
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        disableGatewayFetch("POST", path, {
          role: "disable_create",
          body,
          requestId: `disable-create-runtime-${index + 1}`,
        })),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 200, 201,
    ]);
    const payloads = await Promise.all(
      concurrent.map((response) => response.json()),
    );
    expect(
      payloads.filter((payload) => payload.networkRequestSent),
    ).toHaveLength(1);
    expect(payloads.find((payload) => payload.networkRequestSent))
      .toMatchObject({
        result: "disable_mutation_attempt_recorded",
        recoveryAction: "status_only",
        outcome: { classification: "accepted", httpStatus: 200 },
      });
    expect(payloads.filter((payload) => !payload.networkRequestSent))
      .toHaveLength(5);

    const statusPath =
      `/internal/v1/controller-deployment-disables/`
      + `${create.gatewayDisableIdempotencyKeySha256}/status-readback`
      + `?commandDigestSha256=`
      + create.controllerDisableCommandDigestSha256;
    const first = await disableGatewayFetch("POST", statusPath, {
      role: "disable_status",
      requestId: "disable-status-runtime-1",
    });
    expect(first.status).toBe(201);
    const firstPayload = await first.json();
    expect(firstPayload).toMatchObject({
      result: "disable_status_observation_recorded",
      remoteMutationSent: false,
      remoteReadSent: true,
      targetStable: false,
      observation: { classification: "exact_disable_observed" },
    });

    await new Promise((resolve) => setTimeout(resolve, stabilityProofWaitMs));
    const stable = await disableGatewayFetch("POST", statusPath, {
      role: "disable_status",
      requestId: "disable-status-runtime-2",
    });
    expect(stable.status).toBe(201);
    const stablePayload = await stable.json();
    expect(stablePayload).toMatchObject({
      result: "disable_status_observation_recorded",
      remoteMutationSent: false,
      remoteReadSent: true,
      targetStable: true,
      observation: { classification: "exact_disable_observed" },
    });
    expect(stablePayload.observation.stateDigestSha256)
      .toBe(firstPayload.observation.stateDigestSha256);
    expect(stablePayload.observation.observationDigestSha256)
      .not.toBe(firstPayload.observation.observationDigestSha256);

    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*)
         FROM controller_deployment_gateway_disable_operations)
          AS operations,
        (SELECT COUNT(*)
         FROM controller_deployment_gateway_disable_dispatches)
          AS dispatches,
        (SELECT COUNT(*)
         FROM controller_deployment_gateway_disable_outcomes)
          AS outcomes,
        (SELECT COUNT(*)
         FROM controller_deployment_gateway_disable_observations)
          AS observations`,
    ).first();
    expect(counts).toEqual({
      operations: 1,
      dispatches: 1,
      outcomes: 1,
      observations: 2,
    });
  });

  it("fails closed before D1 or network when gates or roles are wrong", async () => {
    const preflightPath =
      "/internal/v1/controller-deployments/preflight";
    const disabled = await gatewayWorker.fetch(
      new Request(`${origin}${preflightPath}`),
      {
        ...env,
        CONTROLLER_DEPLOYMENT_GATEWAY_ENABLED: "false",
      },
    );
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "gateway_disabled" });

    const create = await createRequestFixture();
    const createBody = canonicalJson(create);
    const createPath =
      `/internal/v1/controller-deployments/` +
      `${create.gatewayIdempotencyKeySha256}/create-once`;
    const wrongRole = await gatewayFetch("POST", createPath, {
      role: "status",
      body: createBody,
      requestId: "wrong-role",
    });
    expect(wrongRole.status).toBe(403);
    expect(await wrongRole.json()).toEqual({ error: "invalid_authority" });
    const operationCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM controller_deployment_gateway_operations`,
    ).first();
    expect(operationCount).toEqual({ count: 0 });
  });
});

async function gatewayFetch(method, pathAndQuery, options) {
  const body = options.body ?? "";
  const bytes = new TextEncoder().encode(body);
  const now = Math.floor(Date.now() / 1000);
  const role = options.role;
  const credentialIdSha256 =
    role === "create" ? "a".repeat(64) : "b".repeat(64);
  const secret = role === "create" ? createSecret : statusSecret;
  const keyId = role === "create" ? "create-runtime-v1" : "status-runtime-v1";
  const token = await createHmacTokenForTest(secret, keyId, {
    issuer: "cinatoken-shard-placement-authority-runtime-test",
    audience: "cinatoken-controller-deployment-gateway-runtime-test",
    role,
    credential_id_sha256: credentialIdSha256,
    request_id: options.requestId,
    method,
    path_and_query: pathAndQuery,
    body_sha256: await sha256Hex(bytes),
    issued_at: now - 1,
    expires_at: now + 30,
  });
  const headers = {
    "x-cinatoken-controller-deployment-gateway": token,
  };
  if (body.length > 0) headers["content-type"] = "application/json";
  return SELF.fetch(`${origin}${pathAndQuery}`, {
    method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
}

async function disableGatewayFetch(method, pathAndQuery, options) {
  const body = options.body ?? "";
  const bytes = new TextEncoder().encode(body);
  const now = Math.floor(Date.now() / 1000);
  const create = options.role === "disable_create";
  const credentialIdSha256 =
    create ? "c".repeat(64) : "d".repeat(64);
  const secret = create ? disableCreateSecret : disableStatusSecret;
  const keyId = create
    ? "disable-create-runtime-v1"
    : "disable-status-runtime-v1";
  const token = await createDisableHmacTokenForTest(
    secret,
    keyId,
    {
      issuer: "cinatoken-shard-placement-authority-runtime-test",
      audience:
        "cinatoken-controller-deployment-gateway-runtime-test",
      role: options.role,
      credential_id_sha256: credentialIdSha256,
      request_id: options.requestId,
      method,
      path_and_query: pathAndQuery,
      body_sha256: await sha256Hex(bytes),
      issued_at: now - 1,
      expires_at: now + 30,
    },
  );
  const headers = {
    "x-cinatoken-controller-deployment-gateway-disable": token,
  };
  if (body.length > 0) headers["content-type"] = "application/json";
  return SELF.fetch(`${origin}${pathAndQuery}`, {
    method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
}
