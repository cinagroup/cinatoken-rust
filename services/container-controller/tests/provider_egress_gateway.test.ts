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
  PROVIDER_USAGE_RECEIPT_HEADER,
  PROVIDER_USAGE_RECEIPT_SHA256_HEADER,
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
  type D1AdmissionSnapshot,
  type ProviderUsageReceipt,
} from "../src/storage_gateway";

const identity = { operationId: "operation-1", ownerGeneration: 2 };
const requestBody = new TextEncoder().encode(
  JSON.stringify({ model: "canary-model", messages: [], stream: false }),
);
const providerBody = new TextEncoder().encode(
  JSON.stringify({ id: "response-1", choices: [] }),
);
const workerVersionId = "worker-version-1";
const billingSnapshotJson = '{"canary":"tiered"}';
const billingSnapshotSha256 =
  "df3029b0f9ad33604ca660838f1e38aae61983e81f4b3ad0a8ac19c1bb92f867";

class FakePort implements ProviderEgressGatewayPort {
  grant: StorageAccessGrant;
  dispatches = 0;
  terminal: ProviderAttemptTerminal | null = null;
  failStorageAttach = false;
  failDispatchTransport = false;
  corruptDispatchIdentity = false;
  loseTerminalResponseOnce = false;
  readonly events: string[];

  constructor(status: ProviderAttemptStatus = "prepared", events: string[] = []) {
    this.events = events;
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
        response_status: null,
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
    this.events.push("dispatch");
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
    this.events.push("do-storage-attach");
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
    this.grant.provider_attempt!.response_status = terminal.response_status;
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
    const events: string[] = [];
    const port = new FakePort("prepared", events);
    applyRequestSha(port.grant, requestSha256);
    let brokerCalls = 0;
    let readinessCalls = 0;
    let r2Puts = 0;
    let observedUsageReceiptSha256: string | null = null;
    let receiptWriteValues: unknown[] = [];
    const env = gatewayEnv(port.grant, {
      readiness: async (request) => {
        events.push("readiness");
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
        events.push("provider-send");
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
        const response = await providerResponse();
        observedUsageReceiptSha256 = response.headers.get(
          PROVIDER_USAGE_RECEIPT_SHA256_HEADER,
        );
        return response;
      },
      r2Put: async (key, _value, options) => {
        events.push("r2-put");
        r2Puts += 1;
        expect(options.sha256).toBe(providerSha256);
        expect(options.customMetadata).toMatchObject({
          gateway_version: "4",
          egress_profile: PROVIDER_EGRESS_PROFILE,
          egress_worker_version_id: workerVersionId,
          usage_receipt_sha256: observedUsageReceiptSha256,
        });
        return r2Object(
          key,
          "result-version-1",
          providerBody.byteLength,
          providerSha256,
          options.customMetadata,
        );
      },
      events,
      onReceiptWrite: (values) => {
        receiptWriteValues = values;
      },
    });

    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      env,
      port,
      identity,
    );
    expect(response.status).toBe(200);
    const responsePayload = (await response.json()) as Record<string, unknown>;
    expect(responsePayload).toMatchObject({
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
    expect(receiptWriteValues[24]).toBe(0);
    expect(receiptWriteValues[25]).toBe(0);
    expect(receiptWriteValues[26]).toBe(0);
    expect(responsePayload).not.toHaveProperty("settlement_authorized");
    expect(events).toEqual([
      "d1-admission",
      "d1-session:first-primary",
      "d1-schema-read",
      "readiness",
      "d1-session:first-primary",
      "d1-grant-write",
      "d1-grant-read",
      "dispatch",
      "provider-send",
      "r2-put",
      "d1-session:first-primary",
      "d1-receipt-write",
      "d1-receipt-read",
      "do-storage-attach",
    ]);
  });

  test("retains a provider 202 receipt but keeps the operation in recovery", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const events: string[] = [];
    const port = new FakePort("prepared", events);
    applyRequestSha(port.grant, requestSha256);
    let receiptWriteValues: unknown[] = [];
    const env = gatewayEnv(port.grant, {
      broker: async () =>
        providerResponse(providerBody, workerVersionId, {
          status: 202,
        }),
      r2Put: async (key, _value, options) =>
        r2Object(
          key,
          "result-version-202",
          providerBody.byteLength,
          providerSha256,
          options.customMetadata,
        ),
      events,
      onReceiptWrite: (values) => {
        receiptWriteValues = values;
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
      code: "provider_response_accepted_ambiguous",
    });
    expect(receiptWriteValues[12]).toBe(202);
    expect(port.grant.result?.object_version).toBe("result-version-202");
    expect(port.terminal).toEqual({
      status: "ambiguous",
      response_status: 202,
      response_code: "provider_response_accepted_ambiguous",
    });
    expect(events.indexOf("r2-put")).toBeLessThan(events.indexOf("d1-receipt-write"));
    expect(events.indexOf("d1-receipt-write")).toBeLessThan(
      events.indexOf("do-storage-attach"),
    );
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

  test("fails closed on an incomplete 0048 schema before readiness, dispatch, or provider send", async () => {
    const requestSha256 = await sha256(requestBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    let readinessCalls = 0;
    let providerCalls = 0;
    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(port.grant, {
        d1SchemaMode: "missing",
        readiness: async () => {
          readinessCalls += 1;
          return providerReadinessResponse();
        },
        broker: async () => {
          providerCalls += 1;
          return providerResponse();
        },
      }),
      port,
      identity,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider_usage_receipt_schema_unavailable",
    });
    expect(readinessCalls).toBe(0);
    expect(port.dispatches).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("fails every 0047 schema, write, read, and field conflict before dispatch and send", async () => {
    const requestSha256 = await sha256(requestBody);
    const scenarios: Array<{
      mode: D1GrantMode;
      status: number;
      error: string;
    }> = [
      { mode: "write_error", status: 503, error: "provider_egress_grant_unavailable" },
      { mode: "invalid_changes", status: 502, error: "provider_egress_grant_write_invalid" },
      { mode: "read_error", status: 503, error: "provider_egress_grant_unavailable" },
      { mode: "missing_readback", status: 409, error: "provider_egress_grant_conflict" },
      {
        mode: "malformed_readback",
        status: 502,
        error: "provider_egress_grant_readback_invalid",
      },
      { mode: "conflict", status: 409, error: "provider_egress_grant_conflict" },
    ];

    for (const scenario of scenarios) {
      const events: string[] = [];
      const port = new FakePort("prepared", events);
      applyRequestSha(port.grant, requestSha256);
      let readinessCalls = 0;
      let providerCalls = 0;
      const response = await handleProviderEgressGatewayRequest(
        await providerRequest(requestSha256),
        gatewayEnv(port.grant, {
          d1GrantMode: scenario.mode,
          events,
          readiness: async () => {
            events.push("readiness");
            readinessCalls += 1;
            return providerReadinessResponse();
          },
          broker: async () => {
            events.push("provider-send");
            providerCalls += 1;
            return providerResponse();
          },
        }),
        port,
        identity,
      );

      expect(response.status, scenario.mode).toBe(scenario.status);
      await expect(response.json()).resolves.toEqual({ error: scenario.error });
      expect(readinessCalls, scenario.mode).toBe(1);
      expect(port.dispatches, scenario.mode).toBe(0);
      expect(providerCalls, scenario.mode).toBe(0);
      expect(events, scenario.mode).not.toContain("dispatch");
      expect(events, scenario.mode).not.toContain("provider-send");
    }
  });

  test("continues through an exact 0047 grant replay", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    const port = new FakePort();
    applyRequestSha(port.grant, requestSha256);
    let providerCalls = 0;
    const response = await handleProviderEgressGatewayRequest(
      await providerRequest(requestSha256),
      gatewayEnv(port.grant, {
        d1GrantMode: "replayed",
        broker: async () => {
          providerCalls += 1;
          return providerResponse();
        },
        r2Put: async (key, _value, options) =>
          r2Object(
            key,
            "result-version-grant-replay",
            providerBody.byteLength,
            providerSha256,
            options.customMetadata,
          ),
      }),
      port,
      identity,
    );

    expect(response.status).toBe(200);
    expect(port.dispatches).toBe(1);
    expect(providerCalls).toBe(1);
  });

  test("accepts exact 0048 replay and makes D1 conflict or unavailability ambiguous before DO attach", async () => {
    const requestSha256 = await sha256(requestBody);
    const providerSha256 = await sha256(providerBody);
    for (const scenario of ["replayed", "conflict", "write_error"] as const) {
      const events: string[] = [];
      const port = new FakePort("prepared", events);
      applyRequestSha(port.grant, requestSha256);
      let r2Puts = 0;
      const response = await handleProviderEgressGatewayRequest(
        await providerRequest(requestSha256),
        gatewayEnv(port.grant, {
          d1ReceiptMode: scenario,
          events,
          r2Put: async (key, _value, options) => {
            events.push("r2-put");
            r2Puts += 1;
            return r2Object(
              key,
              `result-version-${scenario}`,
              providerBody.byteLength,
              providerSha256,
              options.customMetadata,
            );
          },
        }),
        port,
        identity,
      );

      expect(r2Puts, scenario).toBe(1);
      expect(events.indexOf("r2-put"), scenario).toBeLessThan(
        events.indexOf("d1-receipt-write"),
      );
      if (scenario === "replayed") {
        expect(response.status).toBe(200);
        expect(events.indexOf("d1-receipt-read")).toBeLessThan(
          events.indexOf("do-storage-attach"),
        );
      } else {
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
          status: "ambiguous",
          code: "provider_usage_receipt_persistence_ambiguous",
        });
        expect(events).not.toContain("do-storage-attach");
      }
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

  test("makes missing, tampered, noncanonical, and body-mismatched receipts ambiguous", async () => {
    const scenarios: Array<{ name: string; response: () => Promise<Response> }> = [
      {
        name: "missing receipt",
        response: async () => {
          const response = await providerResponse();
          response.headers.delete(PROVIDER_USAGE_RECEIPT_HEADER);
          return response;
        },
      },
      {
        name: "tampered receipt digest",
        response: async () => {
          const response = await providerResponse();
          response.headers.set(PROVIDER_USAGE_RECEIPT_SHA256_HEADER, "f".repeat(64));
          return response;
        },
      },
      {
        name: "noncanonical key order",
        response: () =>
          providerResponse(providerBody, workerVersionId, {
            receiptJson: (receipt) => {
              const { schema_version, ...rest } = receipt;
              return JSON.stringify({ ...rest, schema_version });
            },
          }),
      },
      {
        name: "provider body digest mismatch",
        response: () =>
          providerResponse(providerBody, workerVersionId, {
            receiptOverrides: { provider_response_sha256: "f".repeat(64) },
          }),
      },
      {
        name: "usage mask value mismatch",
        response: () =>
          providerResponse(providerBody, workerVersionId, {
            receiptOverrides: { prompt_tokens: 1 },
          }),
      },
    ];

    const requestSha256 = await sha256(requestBody);
    for (const scenario of scenarios) {
      const port = new FakePort();
      applyRequestSha(port.grant, requestSha256);
      let r2Puts = 0;
      const response = await handleProviderEgressGatewayRequest(
        await providerRequest(requestSha256),
        gatewayEnv(port.grant, {
          broker: scenario.response,
          r2Put: async () => {
            r2Puts += 1;
            return null;
          },
        }),
        port,
        identity,
      );

      expect(response.status, scenario.name).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        status: "ambiguous",
        code: "provider_usage_receipt_ambiguous",
      });
      expect(r2Puts, scenario.name).toBe(0);
      expect(port.grant.result, scenario.name).toBeNull();
      expect(port.terminal?.status, scenario.name).toBe("ambiguous");
    }
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

  test("keeps an attached result ambiguous without receipt-bound terminal evidence", async () => {
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
    expect(response.status).toBe(202);
    expect(brokerCalls).toBe(0);
    expect(port.dispatches).toBe(0);
    expect(port.terminal).toEqual({
      status: "ambiguous",
      response_status: 202,
      response_code: "provider_terminal_ambiguous",
    });
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
        return providerResponse(providerBody, workerVersionId, { status: 201 });
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
    await expect(response.json()).resolves.toMatchObject({ provider_status: 201 });
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

type D1GrantMode =
  | "created"
  | "replayed"
  | "write_error"
  | "invalid_changes"
  | "read_error"
  | "missing_readback"
  | "malformed_readback"
  | "conflict";

type D1SchemaMode = "ready" | "missing" | "read_error";
type D1ReceiptMode =
  | "created"
  | "replayed"
  | "write_error"
  | "invalid_changes"
  | "read_error"
  | "missing_readback"
  | "malformed_readback"
  | "conflict";

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
    d1GrantMode?: D1GrantMode;
    d1SchemaMode?: D1SchemaMode;
    d1ReceiptMode?: D1ReceiptMode;
    onReceiptWrite?: (values: unknown[]) => void;
    events?: string[];
  } = {},
): ProviderEgressGatewayEnvironment {
  const admission = admissionRow(grant, options.d1OperationStatus ?? "dispatched");
  const grantMode = options.d1GrantMode ?? "created";
  const schemaMode = options.d1SchemaMode ?? "ready";
  const receiptMode = options.d1ReceiptMode ?? "created";
  let storedGrant: Record<string, unknown> | null =
    grantMode === "replayed"
      ? providerGrantRow(admission, admission.operation_updated_at)
      : null;
  let storedReceipt: Record<string, unknown> | null = null;
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO relay_container_provider_usage_receipts")) {
          options.events?.push("d1-receipt-write");
          options.onReceiptWrite?.(values);
          if (receiptMode === "write_error") throw new Error("receipt write failed");
          if (receiptMode === "invalid_changes") {
            return { success: true, meta: { changes: 2 }, results: [] };
          }
          storedReceipt = providerUsageReceiptRow(values);
          if (receiptMode === "conflict") {
            storedReceipt.result_object_version = "different-result-version";
          }
          return {
            success: true,
            meta: { changes: receiptMode === "created" ? 1 : 0 },
            results: [],
          };
        }
        options.events?.push("d1-grant-write");
        if (grantMode === "write_error") throw new Error("no such table");
        if (grantMode === "invalid_changes") {
          return { success: true, meta: { changes: 2 }, results: [] };
        }
        if (grantMode === "created") {
          storedGrant = providerGrantRow(admission, values[6] as number);
          return { success: true, meta: { changes: 1 }, results: [] };
        }
        if (grantMode === "conflict") {
          storedGrant = providerGrantRow(admission, admission.operation_updated_at);
          storedGrant.egress_worker_version_id = "different-worker-version";
        }
        return { success: true, meta: { changes: 0 }, results: [] };
      },
      async first<T>() {
        if (sql.includes("FROM sqlite_master")) {
          options.events?.push("d1-schema-read");
          if (schemaMode === "read_error") throw new Error("schema read failed");
          return providerUsageSchemaReadiness(
            schemaMode === "missing" ? { identity_guard_count: 0 } : {},
          ) as T;
        }
        if (sql.includes("FROM relay_container_provider_usage_receipts")) {
          options.events?.push("d1-receipt-read");
          if (receiptMode === "read_error") throw new Error("receipt read failed");
          if (receiptMode === "missing_readback") return null;
          if (storedReceipt === null) return null;
          if (receiptMode === "malformed_readback") {
            return { ...storedReceipt, persisted_at: "invalid" } as T;
          }
          return { ...storedReceipt } as T;
        }
        if (!sql.includes("FROM relay_container_provider_egress_grants")) {
          options.events?.push("d1-admission");
          return { ...admission } as T;
        }
        options.events?.push("d1-grant-read");
        if (grantMode === "read_error") throw new Error("read failed");
        if (grantMode === "missing_readback") return null;
        const row = storedGrant ?? providerGrantRow(admission, admission.operation_updated_at);
        if (grantMode === "malformed_readback") {
          return { ...row, authorized_at: "invalid" } as T;
        }
        return { ...row } as T;
      },
    };
    return statement;
  };
  const database = {
    prepare,
    withSession(constraint: unknown) {
      options.events?.push(`d1-session:${String(constraint)}`);
      return { prepare };
    },
  } as unknown as D1Database;
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

function admissionRow(
  grant: StorageAccessGrant,
  operationStatus: string,
): D1AdmissionSnapshot {
  const operationCreatedAt = Math.floor(Date.now() / 1000) - 30;
  return {
    reservation_key: grant.operation_id,
    operation_reservation_key: grant.operation_id,
    reservation_status: "reserved",
    lease_expires_at: grant.owner_lease_expires_at + 30,
    owner_deadline_at: grant.deadline_at + 10,
    reservation_owner_generation: grant.owner_generation,
    reservation_channel_id: 11,
    reservation_selected_group: "canary",
    reservation_selected_at: operationCreatedAt - 1,
    model_name: "canary-model",
    endpoint_path: "chat/completions",
    billing_kind: "tiered_expr",
    billing_contract_hash: "c".repeat(64),
    billing_snapshot_json: billingSnapshotJson,
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
    operation_created_at: operationCreatedAt,
    operation_updated_at: operationCreatedAt + 1,
  };
}

function providerGrantRow(
  admission: D1AdmissionSnapshot,
  authorizedAt: number,
): Record<string, unknown> {
  return {
    operation_id: admission.operation_id,
    reservation_key: admission.reservation_key,
    owner_generation: admission.owner_generation,
    attempt_generation: 1,
    provider_operation_id: admission.provider_operation_id,
    admission_sha256: admission.admission_sha256,
    request_sha256: admission.input_sha256,
    egress_profile: PROVIDER_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
    channel_id: admission.channel_id,
    selected_group: admission.selected_group,
    model_name: admission.model_name,
    endpoint_path: admission.endpoint_path,
    input_mode: admission.input_mode,
    input_object_key: admission.input_object_key,
    input_object_version: admission.input_object_version,
    input_sha256: admission.input_sha256,
    input_size: admission.input_size,
    input_content_type: admission.input_content_type,
    billing_kind: admission.billing_kind,
    billing_contract_hash: admission.billing_contract_hash,
    billing_snapshot_sha256: billingSnapshotSha256,
    stream_policy: "non_streaming",
    operation_created_at: admission.operation_created_at,
    operation_dispatched_at: admission.operation_updated_at,
    authorized_at: authorizedAt,
    execution_deadline_at: admission.execution_deadline_at,
    owner_lease_expires_at: admission.owner_lease_expires_at,
    reservation_owner_deadline_at: admission.owner_deadline_at,
    reservation_lease_expires_at: admission.lease_expires_at,
  };
}

function providerUsageSchemaReadiness(
  overrides: Record<string, number> = {},
): Record<string, number> {
  return {
    table_count: 1,
    column_count: 30,
    required_column_count: 30,
    identity_table_count: 1,
    identity_column_count: 6,
    identity_required_column_count: 6,
    insert_guard_count: 1,
    update_guard_count: 1,
    delete_guard_count: 1,
    identity_guard_count: 1,
    identity_update_guard_count: 1,
    identity_delete_guard_count: 1,
    terminal_event_column_count: 3,
    terminal_event_guard_count: 1,
    operation_completion_guard_count: 1,
    ...overrides,
  };
}

function providerUsageReceiptRow(values: unknown[]): Record<string, unknown> {
  const names = [
    "operation_id",
    "reservation_key",
    "owner_generation",
    "attempt_generation",
    "provider_operation_id",
    "admission_sha256",
    "request_sha256",
    "egress_profile",
    "egress_worker_version_id",
    "billing_kind",
    "billing_contract_hash",
    "billing_snapshot_sha256",
    "provider_response_status",
    "provider_response_sha256",
    "provider_request_id",
    "provider_completed_at",
    "result_object_key",
    "result_object_version",
    "result_sha256",
    "result_size",
    "result_content_type",
    "usage_schema_version",
    "usage_parser_contract",
    "usage_normalization_contract",
    "usage_present",
    "reported_usage_fields",
    "usage_estimated",
    "usage_receipt_json",
    "usage_receipt_sha256",
    "persisted_at",
  ];
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
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
  grant.input.request_object_key =
    `container-inputs/v1/${grant.operation_id}/${grant.owner_generation}/${sha256}`;
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

async function providerResponse(
  body: Uint8Array = providerBody,
  version: string = workerVersionId,
  options: {
    status?: number;
    receiptOverrides?: Partial<ProviderUsageReceipt>;
    receiptJson?: (receipt: ProviderUsageReceipt) => string;
  } = {},
): Promise<Response> {
  const status = options.status ?? 200;
  const receipt: ProviderUsageReceipt = {
    schema_version: 1,
    parser_contract: "openai-chat-completions-usage-v1",
    normalization_contract: "billing-token-normalization-v1",
    source: "provider_response",
    estimated: false,
    operation_id: identity.operationId,
    owner_generation: identity.ownerGeneration,
    attempt_generation: 1,
    provider_operation_id: "provider-operation-1",
    request_sha256: await sha256(requestBody),
    egress_profile: PROVIDER_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
    provider_response_status: status,
    provider_response_sha256: await sha256(body),
    provider_request_id: "request-1",
    provider_completed_at: Date.now() - 1,
    usage_present: false,
    reported_usage_fields: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    cache_creation_tokens_5m: 0,
    cache_creation_tokens_1h: 0,
    image_input_tokens: 0,
    image_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    is_anthropic_usage_semantic: false,
    usage_semantic_source: "openai_default",
    provider_cost_usd: null,
    cache_creation_source: "none",
    responses_web_search_calls: 0,
    responses_file_search_calls: 0,
    claude_web_search_calls: 0,
    image_generation_quality: null,
    image_generation_size: null,
    ...options.receiptOverrides,
  };
  const receiptJson = options.receiptJson?.(receipt) ?? JSON.stringify(receipt);
  const receiptBytes = new TextEncoder().encode(receiptJson);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      [PROVIDER_EGRESS_WORKER_VERSION_HEADER]: version,
      [PROVIDER_USAGE_RECEIPT_HEADER]: base64UrlNoPad(receiptBytes),
      [PROVIDER_USAGE_RECEIPT_SHA256_HEADER]: await sha256(receiptBytes),
    },
  });
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
