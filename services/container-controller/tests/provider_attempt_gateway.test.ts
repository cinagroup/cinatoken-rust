import { describe, expect, test } from "bun:test";

import type {
  DispatchProviderAttemptOutcome,
  ProviderAttemptRow,
  ProviderAttemptTerminal,
  RecordProviderAttemptOutcome,
} from "../src/ledger";
import {
  PROVIDER_ATTEMPT_DISPATCH_PATH,
  PROVIDER_ATTEMPT_TERMINAL_PATH,
  handleProviderAttemptGatewayRequest,
  type ProviderAttemptGatewayPort,
} from "../src/provider_attempt_gateway";

const identity = { operationId: "operation-1", ownerGeneration: 2 };

class FakePort implements ProviderAttemptGatewayPort {
  dispatches = 0;
  terminals: ProviderAttemptTerminal[] = [];

  async dispatchProviderAttempt(): Promise<{
    ok: true;
    result: DispatchProviderAttemptOutcome;
  }> {
    this.dispatches += 1;
    const kind = this.dispatches === 1 ? "dispatched" : "existing";
    return { ok: true, result: { kind, row: attemptRow("dispatched") } };
  }

  async recordProviderAttemptOutcome(
    _operationId: string,
    _ownerGeneration: number,
    _attemptGeneration: number,
    terminal: ProviderAttemptTerminal,
  ): Promise<{ ok: true; result: RecordProviderAttemptOutcome }> {
    this.terminals.push(terminal);
    return {
      ok: true,
      result: {
        kind: this.terminals.length === 1 ? "recorded" : "duplicate",
        row: attemptRow(terminal.status, terminal),
      },
    };
  }
}

describe("provider attempt outbound gateway", () => {
  test("grants dispatch authority exactly once", async () => {
    const port = new FakePort();
    const first = await invoke(
      PROVIDER_ATTEMPT_DISPATCH_PATH,
      { attempt_generation: 1 },
      port,
    );
    const replay = await invoke(
      PROVIDER_ATTEMPT_DISPATCH_PATH,
      { attempt_generation: 1 },
      port,
    );
    await expect(first.json()).resolves.toMatchObject({
      outcome: "dispatched",
      send_authorized: true,
    });
    await expect(replay.json()).resolves.toMatchObject({
      outcome: "existing",
      send_authorized: false,
    });
  });

  test("records only strict terminal classifications", async () => {
    const port = new FakePort();
    const accepted = await invoke(
      PROVIDER_ATTEMPT_TERMINAL_PATH,
      {
        attempt_generation: 1,
        status: "ambiguous",
        response_status: 202,
        response_code: "provider_response_unknown",
      },
      port,
    );
    expect(accepted.status).toBe(200);
    expect(port.terminals).toEqual([
      {
        status: "ambiguous",
        response_status: 202,
        response_code: "provider_response_unknown",
      },
    ]);

    const rejected = await invoke(
      PROVIDER_ATTEMPT_TERMINAL_PATH,
      {
        attempt_generation: 1,
        status: "succeeded",
        response_status: 200,
        response_code: "must_be_null",
      },
      port,
    );
    expect(rejected.status).toBe(400);
    expect(port.terminals).toHaveLength(1);
  });

  test("rejects unknown fields, methods, content types, and oversized bodies", async () => {
    expect(
      (await invoke(PROVIDER_ATTEMPT_DISPATCH_PATH, { attempt_generation: 1, unexpected: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await handleProviderAttemptGatewayRequest(
          new Request(`https://provider-attempt.cinatoken.internal${PROVIDER_ATTEMPT_DISPATCH_PATH}`, {
            method: "GET",
          }),
          new FakePort(),
          identity,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleProviderAttemptGatewayRequest(
          new Request(`https://provider-attempt.cinatoken.internal${PROVIDER_ATTEMPT_DISPATCH_PATH}`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          }),
          new FakePort(),
          identity,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleProviderAttemptGatewayRequest(
          new Request(`https://provider-attempt.cinatoken.internal${PROVIDER_ATTEMPT_DISPATCH_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "1025",
            },
            body: "{}",
          }),
          new FakePort(),
          identity,
        )
      ).status,
    ).toBe(413);

    const port = new FakePort();
    const wrongRoute = await handleProviderAttemptGatewayRequest(
      new Request(
        `https://provider-attempt.cinatoken.internal${PROVIDER_ATTEMPT_DISPATCH_PATH}?attempt_generation=1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attempt_generation: 1 }),
        },
      ),
      port,
      identity,
    );
    expect(wrongRoute.status).toBe(404);
    await expect(wrongRoute.json()).resolves.toEqual({
      error: "provider_attempt_route_not_found",
    });
    expect(port.dispatches).toBe(0);
  });
});

async function invoke(
  path: string,
  body: Record<string, unknown>,
  port: ProviderAttemptGatewayPort = new FakePort(),
): Promise<Response> {
  return handleProviderAttemptGatewayRequest(
    new Request(`https://provider-attempt.cinatoken.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    port,
    identity,
  );
}

function attemptRow(
  status: ProviderAttemptRow["status"],
  terminal?: ProviderAttemptTerminal,
): ProviderAttemptRow {
  const dispatched = status !== "prepared";
  const terminalState = !["prepared", "dispatched"].includes(status);
  return {
    operation_id: identity.operationId,
    owner_generation: identity.ownerGeneration,
    attempt_generation: 1,
    provider_operation_id: "provider-operation-1",
    admission_sha256: "a".repeat(64),
    request_sha256: "b".repeat(64),
    status,
    response_status: terminal?.response_status ?? null,
    response_code: terminal?.response_code ?? null,
    result_object_key: null,
    result_object_version: null,
    result_sha256: null,
    result_size: null,
    result_content_type: null,
    prepared_at: 100,
    dispatched_at: dispatched ? 101 : null,
    terminal_at: terminalState ? 102 : null,
    updated_at: terminalState ? 102 : dispatched ? 101 : 100,
  };
}
