import { describe, expect, test } from "bun:test";

import type {
  DispatchProviderAttemptOutcome,
  ProviderEgressIdentity,
  ProviderAttemptStatus,
  ProviderAttemptTerminal,
  RecordProviderAttemptOutcome,
  StorageAccessGrant,
  StorageResultRecord,
} from "../src/ledger";
import {
  CLOUDFLARE_WORKERS_VERSION_KEY_HEADER,
  MAX_PROVIDER_EGRESS_BODY_BYTES,
  PROVIDER_EGRESS_HOST,
  PROVIDER_EGRESS_EXPECTED_WORKER_VERSION_HEADER,
  PROVIDER_EGRESS_PATH,
  PROVIDER_EGRESS_PROFILE,
  PROVIDER_EGRESS_PROFILE_HEADER,
  PROVIDER_EGRESS_PROTOCOL_HEADER,
  PROVIDER_EGRESS_READINESS_SERVICE_PATH,
  PROVIDER_EGRESS_WORKER_VERSION_HEADER,
  handleProviderEgressGatewayRequest,
  type ProviderEgressGatewayEnvironment,
  type ProviderEgressGatewayPort,
} from "../src/provider_egress_gateway";
import {
  CONTENT_SHA256_HEADER,
  OPERATION_ID_HEADER,
  OWNER_GENERATION_HEADER,
  PROVIDER_ATTEMPT_GENERATION_HEADER,
} from "../src/storage_gateway";

const identity = { operationId: "operation-1", ownerGeneration: 2 };
const requestBody = new TextEncoder().encode(
  JSON.stringify({ model: "canary-model", messages: [], stream: false }),
);
const providerBody = new TextEncoder().encode(
  JSON.stringify({ id: "response-1", choices: [] }),
);
const workerVersionId = "worker-version-1";

class FakePort implements ProviderEgressGatewayPort {
  grant: StorageAccessGrant;
  dispatches = 0;
  terminal: ProviderAttemptTerminal | null = null;
  failStorageAttach = false;
  failDispatchTransport = false;
  corruptDispatchIdentity = false;
  loseTerminalResponseOnce = false;

  constructor(status: ProviderAttemptStatus = "prepared") {
    const now = Math.floor(Date.now() / 1000);
    this.grant = {
      protocol_version: 1,
      operation_id: identity.operationId,
      owner_generation: identity.ownerGeneration,
      owner_lease_expires_at: now + 180,
      operation_kind: "chat_completions_canary",
      provider_operation_id: "provider-operation-1",
      admission_sha256: "a".repeat(64),
      deadline_at: now + 120,
      input: {
        mode: "r2",
        sha256: "",
        size: requestBody.byteLength,
        content_type: "application/json",
        request_object_key: "container-inputs/v1/operation-1/input.json",
        object_version: "input-version-1",
      },
      shard: {
        contract_version: 1,
        ring_generation: 1,
        shard_count: 8,
        shard_index: 3,
        instance_name: "cinatoken-relay-shard-v1-0003",
      },
      trace_id: "trace-1",
      result: null,
      provider_attempt: {
        attempt_generation: 1,
        provider_operation_id: "provider-operation-1",
        admission_sha256: "a".repeat(64),
        request_sha256: "",
        egress_profile: null,
        egress_worker_version_id: null,
        status,
      },
    };
  }

  async authorizeStorageAccess() {
    return { ok: true as const, grant: this.grant };
  }

  async dispatchProviderAttemptV2(
    _operationId: string,
    _ownerGeneration: number,
    _attemptGeneration: number,
    egressIdentity: ProviderEgressIdentity,
  ): Promise<{
    ok: true;
    result: DispatchProviderAttemptOutcome;
  }> {
    if (this.failDispatchTransport) throw new Error("legacy DO method unavailable");
    this.dispatches += 1;
    this.grant.provider_attempt!.status = "dispatched";
    this.grant.provider_attempt!.egress_profile = egressIdentity.profile;
    this.grant.provider_attempt!.egress_worker_version_id = egressIdentity.worker_version_id;
    const row = attemptRow("dispatched", this.grant);
    if (this.corruptDispatchIdentity) row.egress_worker_version_id = "different-worker-version";
    return {
      ok: true,
      result: {
        kind: "dispatched",
        row,
      },
    };
  }

  async recordStorageResult(
    _operationId: string,
    _ownerGeneration: number,
    result: StorageResultRecord,
  ): Promise<
    | { ok: true; result: "recorded" }
    | { ok: false; error: { code: string; status: number } }
  > {
    if (this.failStorageAttach) {
      return {
        ok: false,
        error: { code: "storage_result_unavailable", status: 503 },
      };
    }
    this.grant.result = result;
    return { ok: true as const, result: "recorded" as const };
  }

  async recordProviderAttemptOutcome(
    _operationId: string,
    _ownerGeneration: number,
    _attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
  ): Promise<
    | { ok: true; result: RecordProviderAttemptOutcome }
    | { ok: false; error: { code: string; status: number } }
  > {
    this.terminal = terminal;
    this.grant.provider_attempt!.status = terminal.status;
    if (this.loseTerminalResponseOnce) {
      this.loseTerminalResponseOnce = false;
      return {
        ok: false,
        error: { code: "provider_attempt_unavailable", status: 503 },
      };
    }
    return {
      ok: true,
      result: {
        kind: "recorded",
        row: attemptRow(terminal.status, this.grant, terminal),
      },
    };
  }
}

describe("provider egress gateway", () => {
  test("consumes dispatch once, persists the provider response, then records success", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    let readinessCalls = 0;
    let r2Puts = 0;
    const env = gatewayEnv(port.grant, {
      readiness: async (request) => {
        readinessCalls += 1;
        expect(new URL(request.url).pathname).toBe(PROVIDER_EGRESS_READINESS_SERVICE_PATH);
        expect(request.headers.get(PROVIDER_EGRESS_PROTOCOL_HEADER)).toBe("1");
        expect(request.headers.get(PROVIDER_EGRESS_PROFILE_HEADER)).toBe(PROVIDER_EGRESS_PROFILE);
        expect(request.headers.get(CLOUDFLARE_WORKERS_VERSION_KEY_HEADER)).toBe(
          port.grant.provider_operation_id,
        );
        return providerReadinessResponse();
      },
      broker: async (request) => {
        brokerCalls += 1;
        expect(new URL(request.url).pathname).toBe("/internal/v1/provider-attempts/execute");
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get(CONTENT_SHA256_HEADER)).toBe(requestSha256);
        expect(request.headers.get(CLOUDFLARE_WORKERS_VERSION_KEY_HEADER)).toBe(
          port.grant.provider_operation_id,
        );
        expect(request.headers.get(PROVIDER_EGRESS_PROTOCOL_HEADER)).toBe("2");
        expect(request.headers.get(PROVIDER_EGRESS_EXPECTED_WORKER_VERSION_HEADER)).toBe(
          workerVersionId,
        );
        return providerResponse();
      },
      r2Put: async (key, _value, options) => {
        r2Puts += 1;
        expect(options.sha256).toBe(providerSha256);
        expect(options.customMetadata).toMatchObject({
          gateway_version: "3",
          egress_profile: PROVIDER_EGRESS_PROFILE,
          egress_worker_version_id: workerVersionId,
        });
        return r2Object(
          key,
          "result-version-1",
          providerBody.byteLength,
          providerSha256,
          options.customMetadata,
        );
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: 1,
      operation_id: identity.operationId,
      owner_generation: identity.ownerGeneration,
      attempt_generation: 1,
      status: "succeeded",
      provider_status: 200,
      result: {
        object_version: "result-version-1",
        sha256: providerSha256,
        size: providerBody.byteLength,
      },
    });
    expect(brokerCalls).toBe(1);
    expect(readinessCalls).toBe(1);
    expect(r2Puts).toBe(1);
    expect(port.dispatches).toBe(1);
    expect(port.grant.provider_attempt).toMatchObject({
      egress_profile: PROVIDER_EGRESS_PROFILE,
      egress_worker_version_id: workerVersionId,
    });
    expect(port.terminal).toEqual({
      status: "succeeded",
      response_status: 200,
      response_code: null,
    });
  });

  test("requires exact broker readiness before dispatch", async () => {
    const requestSha256 = await sha256(requestBody);
    const readinessResponses = [
      async () => new Response(JSON.stringify({ error: "disabled" }), { status: 503 }),
      async () =>
        providerReadinessResponse({
          protocol_version: 1,
          profile: "wrong-profile",
          ready: true,
        }),
      async () =>
        providerReadinessResponse({
          protocol_version: 1,
          profile: PROVIDER_EGRESS_PROFILE,
          ready: true,
          extra: true,
        }),
      async () =>
        providerReadinessResponse({
          protocol_version: 1,
          profile: PROVIDER_EGRESS_PROFILE,
          ready: true,
          worker_version_id: "different-worker-version",
        }),
      async () => providerReadinessResponse(undefined, null),
      async () => providerReadinessResponse({ padding: "x".repeat(1024) }),
    ];
    for (const readiness of readinessResponses) {
      const port = new FakePort();
      applyRequestSha(port.grant, requestSha256);
      let brokerCalls = 0;
      const response = await handleProviderEgressGatewayRequest(
        await providerRequest(requestSha256),
        gatewayEnv(port.grant, {
          readiness,
          broker: async () => {
            brokerCalls += 1;
            return new Response(providerBody);
          },
        }),
        port,
        identity,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "provider_egress_not_ready" });
      expect(port.dispatches).toBe(0);
      expect(brokerCalls).toBe(0);
    }
  });

  test("turns every post-dispatch broker failure into recovery without a retry", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    const env = gatewayEnv(port.grant, {
      broker: async () => {
        brokerCalls += 1;
        throw new Error("connection lost");
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "ambiguous",
      code: "provider_egress_transport_ambiguous",
    });
    expect(brokerCalls).toBe(1);
    expect(port.dispatches).toBe(1);
    expect(port.terminal?.status).toBe("ambiguous");
  });

  test("treats a post-dispatch Worker version mismatch as ambiguous without persisting", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    let r2Puts = 0;
    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(port.grant, {
        broker: async () => {
          brokerCalls += 1;
          return providerResponse(providerBody, "different-worker-version");
        },
        r2Put: async () => {
          r2Puts += 1;
          return null;
        },
      }),
      port,
      identity,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "ambiguous",
      code: "provider_egress_version_ambiguous",
    });
    expect(port.dispatches).toBe(1);
    expect(brokerCalls).toBe(1);
    expect(r2Puts).toBe(0);
    expect(port.terminal?.status).toBe("ambiguous");
  });

  test("fails safely when the V2 dispatch RPC is unavailable before provider send", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    port.failDispatchTransport = true;
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(port.grant, {
        broker: async () => {
          brokerCalls += 1;
          return providerResponse();
        },
      }),
      port,
      identity,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider_egress_dispatch_unavailable",
    });
    expect(port.dispatches).toBe(0);
    expect(brokerCalls).toBe(0);
  });

  test("does not send when the durable dispatch readback identity is corrupt", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    port.corruptDispatchIdentity = true;
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(port.grant, {
        broker: async () => {
          brokerCalls += 1;
          return providerResponse();
        },
      }),
      port,
      identity,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_egress_identity_ambiguous",
    });
    expect(port.dispatches).toBe(1);
    expect(brokerCalls).toBe(0);
    expect(port.terminal?.status).toBe("ambiguous");
  });

  test("never calls the broker again for a dispatched replay", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort("dispatched");
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    const env = gatewayEnv(port.grant, {
      broker: async () => {
        brokerCalls += 1;
        return new Response(providerBody);
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(202);
    expect(brokerCalls).toBe(0);
    expect(port.dispatches).toBe(0);
    expect(port.terminal?.status).toBe("ambiguous");
  });

  test("finishes from an attached result without another provider send", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const port = new FakePort("dispatched");
    applyRequestSha(port.grant, requestSha256);
    port.grant.result = {
      object_key: `container-results/v1/${identity.operationId}/${identity.ownerGeneration}/${providerSha256}`,
      object_version: "result-version-replay",
      sha256: providerSha256,
      size: providerBody.byteLength,
      content_type: "application/json",
    };
    let brokerCalls = 0;
    const env = gatewayEnv(port.grant, {
      broker: async () => {
        brokerCalls += 1;
        return new Response(providerBody);
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(200);
    expect(brokerCalls).toBe(0);
    expect(port.dispatches).toBe(0);
    expect(port.terminal?.status).toBe("succeeded");
  });

  test("marks R2-to-DO attach uncertainty ambiguous without another provider call", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const port = new FakePort();
    port.failStorageAttach = true;
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    let r2Puts = 0;
    const env = gatewayEnv(port.grant, {
      broker: async () => {
        brokerCalls += 1;
        return providerResponse();
      },
      r2Put: async (key, _value, options) => {
        r2Puts += 1;
        return r2Object(
          key,
          "result-version-attach-uncertain",
          providerBody.byteLength,
          providerSha256,
          options.customMetadata,
        );
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(202);
    expect(brokerCalls).toBe(1);
    expect(r2Puts).toBe(1);
    expect(port.terminal).toEqual({
      status: "ambiguous",
      response_status: 202,
      response_code: "provider_result_persistence_ambiguous",
    });
  });

  test("reads canonical DO state after a lost terminal RPC response", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const port = new FakePort();
    port.loseTerminalResponseOnce = true;
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    const env = gatewayEnv(port.grant, {
      broker: async () => {
        brokerCalls += 1;
        return providerResponse();
      },
      r2Put: async (key, _value, options) =>
        r2Object(
          key,
          "result-version-terminal-uncertain",
          providerBody.byteLength,
          providerSha256,
          options.customMetadata,
        ),
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(200);
    expect(brokerCalls).toBe(1);
    expect(port.grant.provider_attempt?.status).toBe("succeeded");
  });

  test("fails before dispatch for disabled, malformed, and non-dispatched D1 admission", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    const disabled = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      {},
      port,
      identity,
    );
    expect(disabled.status).toBe(503);

    const oversized = await providerRequest(requestSha256, {
      "content-length": String(MAX_PROVIDER_EGRESS_BODY_BYTES + 1),
    });
    const rejected = await handleProviderEgressGatewayRequest(
      oversized,
      { CONTAINER_PROVIDER_EGRESS_ENABLED: "true" },
      port,
      identity,
    );
    expect(rejected.status).toBe(413);

    const env = gatewayEnv(port.grant, { d1OperationStatus: "prepared" });
    const admission = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(admission.status).toBe(409);
    await expect(admission.json()).resolves.toEqual({ error: "provider_egress_not_dispatched" });
    expect(port.dispatches).toBe(0);

    const invalidDeadlinePort = new FakePort();
    applyRequestSha(invalidDeadlinePort.grant, requestSha256);
    invalidDeadlinePort.grant.deadline_at = Math.floor(Date.now() / 1000) + 301;
    const invalidDeadline = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(invalidDeadlinePort.grant),
      invalidDeadlinePort,
      identity,
    );
    expect(invalidDeadline.status).toBe(403);
    expect(invalidDeadlinePort.dispatches).toBe(0);

    const missingBindingPort = new FakePort();
    applyRequestSha(missingBindingPort.grant, requestSha256);
    const missingBindingEnv = gatewayEnv(missingBindingPort.grant);
    delete missingBindingEnv.PROVIDER_EGRESS;
    const missingBinding = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      missingBindingEnv,
      missingBindingPort,
      identity,
    );
    expect(missingBinding.status).toBe(503);
    await expect(missingBinding.json()).resolves.toEqual({
      error: "provider_egress_binding_unavailable",
    });
    expect(missingBindingPort.dispatches).toBe(0);
  });
});

function gatewayEnv(
  grant: StorageAccessGrant,
  options: {
    readiness?: (request: Request) => Promise<Response>;
    broker?: (request: Request) => Promise<Response>;
    r2Put?: (
      key: string,
      value: unknown,
      options: R2PutOptions,
    ) => Promise<R2Object | null>;
    d1OperationStatus?: string;
  } = {},
): ProviderEgressGatewayEnvironment {
  const database = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return admissionRow(grant, options.d1OperationStatus ?? "dispatched");
            },
          };
        },
      };
    },
  } as unknown as Pick<D1Database, "prepare">;
  const bucket = {
    put: options.r2Put ?? (async () => null),
    async head() {
      return null;
    },
  } as unknown as Pick<R2Bucket, "put" | "head">;
  const broker = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === PROVIDER_EGRESS_READINESS_SERVICE_PATH) {
        return options.readiness?.(request) ?? providerReadinessResponse();
      }
      return (
        options.broker?.(request) ??
        providerResponse()
      );
    },
  } as Pick<Fetcher, "fetch">;
  return {
    CONTAINER_PROVIDER_EGRESS_ENABLED: "true",
    CONTAINER_STORAGE_GATEWAY_ENABLED: "true",
    CONTAINER_STORAGE_ADMISSION_DB: database,
    CONTAINER_STORAGE_RESULT_R2: bucket,
    PROVIDER_EGRESS: broker,
  };
}

function providerReadinessResponse(
  body: Record<string, unknown> = {
    protocol_version: 1,
    profile: PROVIDER_EGRESS_PROFILE,
    ready: true,
  },
  version: string | null = workerVersionId,
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [PROVIDER_EGRESS_PROTOCOL_HEADER]: "1",
      [PROVIDER_EGRESS_PROFILE_HEADER]: PROVIDER_EGRESS_PROFILE,
      ...(version === null ? {} : { [PROVIDER_EGRESS_WORKER_VERSION_HEADER]: version }),
    },
  });
}

function admissionRow(grant: StorageAccessGrant, operationStatus: string) {
  return {
    reservation_key: "reservation-1",
    operation_reservation_key: "reservation-1",
    reservation_status: "reserved",
    lease_expires_at: grant.owner_lease_expires_at + 30,
    owner_deadline_at: grant.deadline_at + 10,
    reservation_owner_generation: grant.owner_generation,
    reservation_channel_id: 11,
    reservation_selected_group: "canary",
    operation_id: grant.operation_id,
    owner_generation: grant.owner_generation,
    owner_lease_expires_at: grant.owner_lease_expires_at,
    channel_id: 11,
    selected_group: "canary",
    operation_kind: grant.operation_kind,
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    protocol_version: grant.protocol_version,
    shard_contract_version: grant.shard.contract_version,
    ring_generation: grant.shard.ring_generation,
    shard_count: grant.shard.shard_count,
    shard_index: grant.shard.shard_index,
    instance_name: grant.shard.instance_name,
    execution_deadline_at: grant.deadline_at,
    input_mode: grant.input.mode,
    input_object_key: grant.input.request_object_key,
    input_object_version: grant.input.object_version,
    input_sha256: grant.input.sha256,
    input_size: grant.input.size,
    input_content_type: grant.input.content_type,
    trace_id: grant.trace_id,
    operation_status: operationStatus,
  };
}

async function providerRequest(
  bodySha256: string,
  overrides: Record<string, string> = {},
): Promise<Request> {
  return new Request(`http://${PROVIDER_EGRESS_HOST}${PROVIDER_EGRESS_PATH}`, {
    method: "POST",
    headers: {
      "content-length": String(requestBody.byteLength),
      "content-type": "application/json",
      [OPERATION_ID_HEADER]: identity.operationId,
      [OWNER_GENERATION_HEADER]: String(identity.ownerGeneration),
      [PROVIDER_ATTEMPT_GENERATION_HEADER]: "1",
      [CONTENT_SHA256_HEADER]: bodySha256,
      ...overrides,
    },
    body: requestBody,
  });
}

function applyRequestSha(grant: StorageAccessGrant, sha256: string): void {
  grant.input.sha256 = sha256;
  grant.provider_attempt!.request_sha256 = sha256;
}

function attemptRow(
  status: ProviderAttemptStatus,
  grant: StorageAccessGrant,
  terminal?: ProviderAttemptTerminal,
) {
  return {
    operation_id: grant.operation_id,
    owner_generation: grant.owner_generation,
    attempt_generation: 1,
    provider_operation_id: grant.provider_operation_id,
    admission_sha256: grant.admission_sha256,
    request_sha256: grant.input.sha256,
    egress_profile: grant.provider_attempt?.egress_profile ?? null,
    egress_worker_version_id: grant.provider_attempt?.egress_worker_version_id ?? null,
    status,
    response_status: terminal?.response_status ?? null,
    response_code: terminal?.response_code ?? null,
    result_object_key: grant.result?.object_key ?? null,
    result_object_version: grant.result?.object_version ?? null,
    result_sha256: grant.result?.sha256 ?? null,
    result_size: grant.result?.size ?? null,
    result_content_type: grant.result?.content_type ?? null,
    prepared_at: 100,
    dispatched_at: status === "prepared" ? null : 101,
    terminal_at: ["succeeded", "definite_reject", "ambiguous", "cancelled"].includes(status)
      ? 102
      : null,
    updated_at: status === "prepared" ? 100 : 101,
  };
}

function providerResponse(
  body: Uint8Array = providerBody,
  version: string = workerVersionId,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      [PROVIDER_EGRESS_WORKER_VERSION_HEADER]: version,
    },
  });
}

function r2Object(
  key: string,
  version: string,
  size: number,
  sha256: string,
  customMetadata?: Record<string, string>,
): R2Object {
  return {
    key,
    version,
    size,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    uploaded: new Date(0),
    storageClass: "Standard",
    httpMetadata: { contentType: "application/json" },
    customMetadata,
    checksums: {
      sha256: hexBuffer(sha256),
      toJSON: () => ({ sha256 }),
    },
    writeHttpMetadata: () => undefined,
  } as unknown as R2Object;
}

function hexBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
