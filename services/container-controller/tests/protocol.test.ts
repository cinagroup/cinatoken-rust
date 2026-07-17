import { describe, expect, test } from "bun:test";
import goldenVector from "../../../tests/fixtures/container-authority-v1.json";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
  INTERNAL_OPERATION_STATUS_PATH,
  INTERNAL_OPERATION_STATUS_V2_PATH,
  INTERNAL_OPERATION_STATUS_V3_PATH,
  INTERNAL_READINESS_PATH,
  INTERNAL_STATUS_PATH,
  MAX_OPERATION_STATUS_BODY_BYTES,
  MAX_STORAGE_OBJECT_VERSION_BYTES,
  MAX_TERMINAL_ACK_BODY_BYTES,
  MAX_READINESS_BODY_BYTES,
  MAX_EXECUTION_WINDOW_SECONDS,
  OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
  ProtocolError,
  TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
  createAuthorityTokenForTest,
  parseOperationEnvelope,
  sha256Hex,
  verifyOperationRequest,
  verifyOperationStatusRequest,
  verifyOperationStatusV2Request,
  verifyOperationStatusV3Request,
  verifyReadinessRequest,
  verifyStatusRequest,
  verifyTerminalAckRequest,
  verifyTerminalAckV2Request,
  type AuthorityClaims,
  type AuthorityEnvironment,
  type OperationEnvelope,
  type OperationStatusQuery,
  type TerminalAckRequestV1,
  type TerminalAckRequestV2,
} from "../src/protocol";
import {
  handleTerminalAckRequest,
  handleTerminalAckV2Request,
  type TerminalAckEnvironment,
  type TerminalAckRequest,
} from "../src/terminal_ack";
import {
  handleOperationStatusRequest,
  handleOperationStatusV2Request,
  handleOperationStatusV3Request,
  type OperationStatusEnvironment,
} from "../src/operation_status";

const secret = "0123456789abcdef0123456789abcdef";
const now = 1_800_000_000;
const env: AuthorityEnvironment = {
  CONTAINER_AUTHORITY_ISSUER: "cinatoken-edge-test",
  CONTAINER_AUTHORITY_AUDIENCE: "cinatoken-container-controller-test",
  CONTAINER_AUTHORITY_CURRENT_KID: "test-v1",
  CONTAINER_AUTHORITY_PREVIOUS_KID: "test-v0",
  CONTAINER_AUTHORITY_CURRENT_SECRET: secret,
  CONTAINER_AUTHORITY_PREVIOUS_SECRET: "abcdef0123456789abcdef0123456789",
  CONTAINER_PROTOCOL_VERSION: "1",
  CONTAINER_RING_GENERATION: "1",
  CONTAINER_SHARD_COUNT: "8",
};

function envelope(): OperationEnvelope {
  return {
    protocol_version: 1,
    operation_id: "op-test-1",
    operation_kind: "health_probe",
    owner_generation: 1,
    owner_lease_expires_at: now + 120,
    execution_deadline_at: now + 60,
    provider_operation_id: "provider-op-test-1",
    admission_sha256: "a".repeat(64),
    input: {
      mode: "inline",
      sha256: "b".repeat(64),
      size: 0,
      content_type: "application/json",
    },
    shard: {
      contract_version: 1,
      ring_generation: 1,
      shard_count: 8,
      shard_index: 3,
      instance_name: "cinatoken-relay-shard-v1-0003",
    },
    trace_id: "trace-test-1",
  };
}

function readinessProbe(wakeContainer = false) {
  return {
    protocol_version: 1,
    shard: envelope().shard,
    wake_container: wakeContainer,
  };
}

function operationStatusQuery(
  overrides: Partial<OperationStatusQuery> = {},
): OperationStatusQuery {
  const operation = envelope();
  return {
    protocol_version: operation.protocol_version,
    operation_id: operation.operation_id,
    owner_generation: operation.owner_generation,
    shard: operation.shard,
    trace_id: operation.trace_id,
    ...overrides,
  };
}

function terminalAck(
  overrides: Partial<TerminalAckRequestV1> = {},
): TerminalAckRequestV1 {
  const operation = envelope();
  const resultSha256 = "c".repeat(64);
  return {
    protocol_version: 1,
    billing_event_id: "d".repeat(64),
    terminal_contract_sha256: "e".repeat(64),
    reconciliation_id: "f".repeat(64),
    reconciliation_revision: 1,
    predecessor_billing_event_id: null,
    operation_id: operation.operation_id,
    owner_generation: operation.owner_generation,
    operation_from_status: "dispatched",
    operation_status: "completed",
    response_status: 200,
    response_code: null,
    result: {
      object_key:
        `container-results/v1/${operation.operation_id}/${operation.owner_generation}/${resultSha256}`,
      object_version: "result-version-1",
      sha256: resultSha256,
      size: 2,
      content_type: "application/json",
    },
    shard: operation.shard,
    trace_id: operation.trace_id,
    ...overrides,
  };
}

function terminalAckV2(
  overrides: Partial<TerminalAckRequestV2> = {},
): TerminalAckRequestV2 {
  const ack = terminalAck();
  return {
    ...ack,
    provider_usage_binding: {
      attempt_generation: 1,
      receipt_sha256: "9".repeat(64),
      result_sha256: ack.result!.sha256,
    },
    ...overrides,
  };
}

async function signedReadinessRequest(
  value = readinessProbe(),
  overrides: Partial<AuthorityClaims> = {},
): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const claims: AuthorityClaims = {
    authority_version: 1,
    issuer: env.CONTAINER_AUTHORITY_ISSUER,
    audience: env.CONTAINER_AUTHORITY_AUDIENCE,
    protocol_version: 1,
    dispatch_id: "readiness-test-1",
    method: "POST",
    path: INTERNAL_READINESS_PATH,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
    ...overrides,
  };
  const token = await createAuthorityTokenForTest(
    secret,
    env.CONTAINER_AUTHORITY_CURRENT_KID,
    claims,
  );
  return new Request(`https://controller.internal${INTERNAL_READINESS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [AUTHORITY_HEADER]: token },
    body,
  });
}

async function signedOperationStatusRequest(
  value = operationStatusQuery(),
  overrides: Partial<AuthorityClaims> = {},
  path = INTERNAL_OPERATION_STATUS_PATH,
  authorityDomain?: string,
): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const claims: AuthorityClaims = {
    authority_version: 1,
    issuer: env.CONTAINER_AUTHORITY_ISSUER,
    audience: env.CONTAINER_AUTHORITY_AUDIENCE,
    protocol_version: 1,
    dispatch_id: "operation-status-test-1",
    method: "POST",
    path,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
    ...overrides,
  };
  const token = await createAuthorityTokenForTest(
    secret,
    env.CONTAINER_AUTHORITY_CURRENT_KID,
    claims,
    authorityDomain,
  );
  return new Request(`https://controller.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [AUTHORITY_HEADER]: token },
    body,
  });
}

async function signedOperationStatusV2Request(
  value = operationStatusQuery(),
  overrides: Partial<AuthorityClaims> = {},
): Promise<Request> {
  return signedOperationStatusRequest(value, overrides, INTERNAL_OPERATION_STATUS_V2_PATH);
}

async function signedOperationStatusV3Request(
  value = operationStatusQuery(),
  overrides: Partial<AuthorityClaims> = {},
  authorityDomain = OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
): Promise<Request> {
  return signedOperationStatusRequest(
    value,
    overrides,
    INTERNAL_OPERATION_STATUS_V3_PATH,
    authorityDomain,
  );
}

async function signedTerminalAckRequest(
  value: unknown = terminalAck(),
  overrides: Partial<AuthorityClaims> = {},
  path = INTERNAL_OPERATION_TERMINAL_ACK_PATH,
  authorityDomain?: string,
): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const claims: AuthorityClaims = {
    authority_version: 1,
    issuer: env.CONTAINER_AUTHORITY_ISSUER,
    audience: env.CONTAINER_AUTHORITY_AUDIENCE,
    protocol_version: 1,
    dispatch_id: "terminal-ack-test-1",
    method: "POST",
    path,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
    ...overrides,
  };
  const token = await createAuthorityTokenForTest(
    secret,
    env.CONTAINER_AUTHORITY_CURRENT_KID,
    claims,
    authorityDomain,
  );
  return new Request(`https://controller.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [AUTHORITY_HEADER]: token },
    body,
  });
}

async function signedTerminalAckV2Request(
  value: unknown = terminalAckV2(),
  overrides: Partial<AuthorityClaims> = {},
  authorityDomain = TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
): Promise<Request> {
  return signedTerminalAckRequest(
    value,
    overrides,
    INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
    authorityDomain,
  );
}

async function signedRequest(value = envelope(), overrides: Partial<AuthorityClaims> = {}): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const claims: AuthorityClaims = {
    authority_version: 1,
    issuer: env.CONTAINER_AUTHORITY_ISSUER,
    audience: env.CONTAINER_AUTHORITY_AUDIENCE,
    protocol_version: 1,
    dispatch_id: "dispatch-test-1",
    method: "POST",
    path: INTERNAL_OPERATION_PATH,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + 30,
    ...overrides,
  };
  const token = await createAuthorityTokenForTest(secret, env.CONTAINER_AUTHORITY_CURRENT_KID, claims);
  return new Request(`https://controller.internal${INTERNAL_OPERATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [AUTHORITY_HEADER]: token },
    body,
  });
}

describe("container controller private protocol", () => {
  test("verifies the Rust authority golden vector", async () => {
    const vector = goldenVector;
    const goldenEnv: AuthorityEnvironment = {
      ...env,
      CONTAINER_AUTHORITY_ISSUER: vector.issuer,
      CONTAINER_AUTHORITY_AUDIENCE: vector.audience,
      CONTAINER_AUTHORITY_CURRENT_KID: vector.kid,
      CONTAINER_AUTHORITY_CURRENT_SECRET: vector.secret,
    };
    const claims = await verifyStatusRequest(
      new Request(`https://controller.internal${INTERNAL_STATUS_PATH}`, {
        headers: { [AUTHORITY_HEADER]: vector.token },
      }),
      goldenEnv,
      vector.issued_at + 1,
    );
    expect(claims.dispatch_id).toBe(vector.dispatch_id);
    expect(claims.expires_at).toBe(vector.expires_at);
  });

  test("status probe rejects bodies, missing authority, and wrong routes", async () => {
    const vector = goldenVector;
    const goldenEnv: AuthorityEnvironment = {
      ...env,
      CONTAINER_AUTHORITY_ISSUER: vector.issuer,
      CONTAINER_AUTHORITY_AUDIENCE: vector.audience,
      CONTAINER_AUTHORITY_CURRENT_KID: vector.kid,
      CONTAINER_AUTHORITY_CURRENT_SECRET: vector.secret,
      CONTAINER_AUTHORITY_PREVIOUS_KID: "",
      CONTAINER_AUTHORITY_PREVIOUS_SECRET: undefined,
    };
    await expect(
      verifyStatusRequest(
        new Request(`https://controller.internal${INTERNAL_STATUS_PATH}`, {
          headers: {
            [AUTHORITY_HEADER]: vector.token,
            "content-length": "1",
          },
        }),
        goldenEnv,
        vector.issued_at + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_status_body", status: 400 });
    await expect(
      verifyStatusRequest(
        new Request(`https://controller.internal${INTERNAL_STATUS_PATH}`),
        goldenEnv,
        vector.issued_at + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
    await expect(
      verifyStatusRequest(
        new Request("https://controller.internal/internal/v1/wrong", {
          headers: { [AUTHORITY_HEADER]: vector.token },
        }),
        goldenEnv,
        vector.issued_at + 1,
      ),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
  });

  test("accepts a bounded signed operation with a canonical shard fence", async () => {
    const verified = await verifyOperationRequest(await signedRequest(), env, now + 1);
    expect(verified.envelope.operation_id).toBe("op-test-1");
    expect(verified.envelope.shard.instance_name).toBe("cinatoken-relay-shard-v1-0003");
    expect(verified.claims.dispatch_id).toBe("dispatch-test-1");
  });

  test("verifies a signed status query without applying the operation deadline", async () => {
    const historicalQuery = operationStatusQuery({
      shard: {
        ...operationStatusQuery().shard,
        ring_generation: 7,
        shard_count: 16,
      },
    });
    const verified = await verifyOperationStatusRequest(
      await signedOperationStatusRequest(historicalQuery),
      env,
      now + 1,
    );
    expect(verified.query).toEqual(historicalQuery);
    expect(verified.claims.dispatch_id).toBe("operation-status-test-1");

    const verifiedV2 = await verifyOperationStatusV2Request(
      await signedOperationStatusV2Request(historicalQuery),
      env,
      now + 1,
    );
    expect(verifiedV2.query).toEqual(historicalQuery);
    await expect(
      verifyOperationStatusRequest(await signedOperationStatusV2Request(), env, now + 1),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });

    const signed = await signedOperationStatusRequest();
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(operationStatusQuery({ owner_generation: 2 })),
    });
    await expect(
      verifyOperationStatusRequest(tampered, env, now + 1),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });
  });

  test("isolates the signed status v3 contract by domain and path", async () => {
    const query = operationStatusQuery();
    const verified = await verifyOperationStatusV3Request(
      await signedOperationStatusV3Request(query),
      env,
      now + 1,
    );
    expect(verified.query).toEqual(query);

    await expect(
      verifyOperationStatusV3Request(
        await signedOperationStatusRequest(
          query,
          {},
          INTERNAL_OPERATION_STATUS_V3_PATH,
        ),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
    await expect(
      verifyOperationStatusV3Request(
        await signedOperationStatusV3Request(query, {
          path: INTERNAL_OPERATION_STATUS_V2_PATH,
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });
    await expect(
      verifyOperationStatusV2Request(
        await signedOperationStatusV3Request(query),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
  });

  test("status query rejects malformed fences and oversized bodies", async () => {
    await expect(
      verifyOperationStatusRequest(
        await signedOperationStatusRequest({
          ...operationStatusQuery(),
          shard: {
            ...operationStatusQuery().shard,
            instance_name: "cinatoken-relay-shard-v1-0004",
          },
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_operation_status_query", status: 400 });

    const oversized = new Request(
      `https://controller.internal${INTERNAL_OPERATION_STATUS_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", [AUTHORITY_HEADER]: "not-used" },
        body: "x".repeat(MAX_OPERATION_STATUS_BODY_BYTES + 1),
      },
    );
    await expect(
      verifyOperationStatusRequest(oversized, env, now),
    ).rejects.toMatchObject({ code: "operation_status_query_too_large", status: 413 });
  });

  test("terminal ack is flat, body-bound, strict, and accepts recovery results", async () => {
    const verified = await verifyTerminalAckRequest(
      await signedTerminalAckRequest(),
      env,
      now + 1,
    );
    expect(verified.ack).toEqual(terminalAck());
    expect(verified.claims.dispatch_id).toBe("terminal-ack-test-1");

    const signed = await signedTerminalAckRequest();
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: (await signed.text()).replace('"response_status":200', '"response_status":201'),
    });
    await expect(verifyTerminalAckRequest(tampered, env, now + 1)).rejects.toMatchObject({
      code: "authority_claim_mismatch",
      status: 403,
    });
    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest({ ...terminalAck(), audit_payload: {} }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });
    const recovery = terminalAck({
      operation_status: "recovery_required",
      response_status: 202,
      response_code: "container_execution_ambiguous",
    });
    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest(recovery),
        env,
        now + 1,
      ),
    ).resolves.toMatchObject({ ack: recovery });

    const healthProbe = terminalAck({ result: null });
    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest(healthProbe),
        env,
        now + 1,
      ),
    ).resolves.toMatchObject({ ack: healthProbe });

    const maxVersion = terminalAck();
    maxVersion.result!.object_version = "v".repeat(MAX_STORAGE_OBJECT_VERSION_BYTES);
    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest(maxVersion),
        env,
        now + 1,
      ),
    ).resolves.toMatchObject({ ack: maxVersion });
    const oversizedVersion = terminalAck();
    oversizedVersion.result!.object_version = "v".repeat(
      MAX_STORAGE_OBJECT_VERSION_BYTES + 1,
    );
    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest(oversizedVersion),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });

    const oversized = new Request(
      `https://controller.internal${INTERNAL_OPERATION_TERMINAL_ACK_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", [AUTHORITY_HEADER]: "not-used" },
        body: "x".repeat(MAX_TERMINAL_ACK_BODY_BYTES + 1),
      },
    );
    await expect(verifyTerminalAckRequest(oversized, env, now)).rejects.toMatchObject({
      code: "terminal_ack_too_large",
      status: 413,
    });
  });

  test("terminal ack v2 is body-bound, exact, and isolates provider usage binding", async () => {
    const ack = terminalAckV2();
    const verified = await verifyTerminalAckV2Request(
      await signedTerminalAckV2Request(ack),
      env,
      now + 1,
    );
    expect(verified.ack).toEqual(ack);

    const historical = terminalAckV2({ provider_usage_binding: null });
    await expect(
      verifyTerminalAckV2Request(
        await signedTerminalAckV2Request(historical),
        env,
        now + 1,
      ),
    ).resolves.toMatchObject({ ack: historical });

    await expect(
      verifyTerminalAckRequest(
        await signedTerminalAckRequest(ack),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });
    await expect(
      verifyTerminalAckV2Request(
        await signedTerminalAckV2Request(terminalAck()),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });

    await expect(
      verifyTerminalAckV2Request(
        await signedTerminalAckRequest(
          ack,
          {},
          INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
        ),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
    await expect(
      verifyTerminalAckV2Request(
        await signedTerminalAckV2Request(ack, {
          path: INTERNAL_OPERATION_TERMINAL_ACK_PATH,
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });

    const signed = await signedTerminalAckV2Request();
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: (await signed.text()).replace(
        `"receipt_sha256":"${"9".repeat(64)}"`,
        `"receipt_sha256":"${"8".repeat(64)}"`,
      ),
    });
    await expect(
      verifyTerminalAckV2Request(tampered, env, now + 1),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });
  });

  test("terminal ack v2 rejects invalid provider usage binding combinations", async () => {
    const invalidValues: unknown[] = [
      { ...terminalAckV2(), unexpected: true },
      {
        ...terminalAckV2(),
        provider_usage_binding: {
          ...terminalAckV2().provider_usage_binding!,
          unexpected: true,
        },
      },
      terminalAckV2({
        provider_usage_binding: {
          ...terminalAckV2().provider_usage_binding!,
          result_sha256: "8".repeat(64),
        },
      }),
      terminalAckV2({
        result: null,
        provider_usage_binding: terminalAckV2().provider_usage_binding,
      }),
      terminalAckV2({
        provider_usage_binding: {
          ...terminalAckV2().provider_usage_binding!,
          attempt_generation: 0,
        },
      }),
      terminalAckV2({
        provider_usage_binding: {
          ...terminalAckV2().provider_usage_binding!,
          receipt_sha256: "A".repeat(64),
        },
      }),
    ];
    for (const value of invalidValues) {
      await expect(
        verifyTerminalAckV2Request(
          await signedTerminalAckV2Request(value),
          env,
          now + 1,
        ),
      ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });
    }
  });

  test("terminal ack handler is default-off and returns the exact no-store response", async () => {
    let calls = 0;
    const routeEnv: TerminalAckEnvironment = {
      ...env,
      CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED: "true",
      RELAY_SHARDS: {
        getByName(name: string) {
          expect(name).toBe(terminalAck().shard.instance_name);
          return {
            async acknowledgeGlobalTerminal(value: TerminalAckRequest) {
              calls += 1;
              expect(value).toEqual(terminalAck());
              return {
                ok: true as const,
                result: {
                  kind: "acknowledged" as const,
                  finalAck: true,
                  acknowledgedAt: now + 1,
                },
              };
            },
          };
        },
      },
    };
    const response = await handleTerminalAckRequest(
      await signedTerminalAckRequest(),
      routeEnv,
      now + 1,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      protocol_version: 1,
      billing_event_id: terminalAck().billing_event_id,
      operation_id: terminalAck().operation_id,
      reconciliation_revision: 1,
      status: "acknowledged",
      final_ack: true,
      acknowledged_at: now + 1,
    });

    const disabled = await handleTerminalAckRequest(
      await signedTerminalAckRequest(),
      { ...routeEnv, CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED: "false" },
      now + 1,
    );
    expect(disabled.status).toBe(503);
    expect(disabled.headers.get("cache-control")).toBe("no-store");
    expect(await disabled.json()).toEqual({ error: "container_global_terminal_ack_disabled" });
    expect(calls).toBe(1);
  });

  test("terminal ack v2 handler preserves the provider usage binding through RPC", async () => {
    const ack = terminalAckV2();
    let seen: TerminalAckRequest | null = null;
    const routeEnv: TerminalAckEnvironment = {
      ...env,
      CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED: "true",
      RELAY_SHARDS: {
        getByName(name: string) {
          expect(name).toBe(ack.shard.instance_name);
          return {
            async acknowledgeGlobalTerminal(value: TerminalAckRequest) {
              seen = value;
              return {
                ok: true as const,
                result: {
                  kind: "duplicate" as const,
                  finalAck: true,
                  acknowledgedAt: now + 2,
                },
              };
            },
          };
        },
      },
    };
    const response = await handleTerminalAckV2Request(
      await signedTerminalAckV2Request(ack),
      routeEnv,
      now + 1,
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(ack);
    expect(await response.json()).toEqual({
      protocol_version: 1,
      billing_event_id: ack.billing_event_id,
      operation_id: ack.operation_id,
      reconciliation_revision: 1,
      status: "duplicate",
      final_ack: true,
      acknowledged_at: now + 2,
    });
  });

  test("status replays use only the ledger RPC and return the existing bounded outcome", async () => {
    const seen: OperationStatusQuery[] = [];
    const seenV2: OperationStatusQuery[] = [];
    const seenV3: OperationStatusQuery[] = [];
    let forbiddenCalls = 0;
    const routeEnv: OperationStatusEnvironment & { DB: { prepare(): never } } = {
      ...env,
      DB: {
        prepare(): never {
          forbiddenCalls += 1;
          throw new Error("D1 admission must not run");
        },
      },
      RELAY_SHARDS: {
        getByName(name: string) {
          expect(name).toBe(operationStatusQuery().shard.instance_name);
          return {
            async readOperationStatus(query: OperationStatusQuery) {
              seen.push(query);
              return {
                ok: true as const,
                row: {
                  operation_id: query.operation_id,
                  owner_generation: query.owner_generation,
                  operation_kind: "health_probe",
                  trace_id: query.trace_id,
                  envelope_sha256: "a".repeat(64),
                  status: "running" as const,
                  response_status: null,
                  response_code: null,
                  result_object_key: null,
                  result_object_version: null,
                  result_sha256: null,
                  result_size: null,
                  result_content_type: null,
                  provider_usage_receipt_sha256: null,
                },
              };
            },
            async readOperationStatusV2(query: OperationStatusQuery) {
              seenV2.push(query);
              return {
                ok: true as const,
                snapshot: {
                  operation: {
                    operation_id: query.operation_id,
                    owner_generation: query.owner_generation,
                    operation_kind: "health_probe",
                    trace_id: query.trace_id,
                    envelope_sha256: "a".repeat(64),
                    status: "running" as const,
                    response_status: null,
                    response_code: null,
                    result_object_key: null,
                    result_object_version: null,
                    result_sha256: null,
                    result_size: null,
                    result_content_type: null,
                    provider_usage_receipt_sha256: null,
                  },
                  provider_attempt: {
                    operation_id: query.operation_id,
                    owner_generation: query.owner_generation,
                    attempt_generation: 1,
                    provider_operation_id: envelope().provider_operation_id,
                    admission_sha256: envelope().admission_sha256,
                    request_sha256: envelope().input.sha256,
                    egress_profile: null,
                    egress_worker_version_id: null,
                    status: "dispatched" as const,
                    response_status: null,
                    response_code: null,
                    result_object_key: null,
                    result_object_version: null,
                    result_sha256: null,
                    result_size: null,
                    result_content_type: null,
                    provider_usage_receipt_sha256: null,
                    provider_usage_receipt_attached_at: null,
                    prepared_at: now + 1,
                    dispatched_at: now + 2,
                    terminal_at: null,
                    updated_at: now + 2,
                  },
                },
              };
            },
            async readOperationStatusV3(query: OperationStatusQuery) {
              seenV3.push(query);
              return {
                ok: true as const,
                snapshot: {
                  operation: {
                    operation_id: query.operation_id,
                    owner_generation: query.owner_generation,
                    operation_kind: "health_probe",
                    trace_id: query.trace_id,
                    envelope_sha256: "a".repeat(64),
                    status: "running" as const,
                    response_status: null,
                    response_code: null,
                    result_object_key: null,
                    result_object_version: null,
                    result_sha256: null,
                    result_size: null,
                    result_content_type: null,
                    provider_usage_receipt_sha256: null,
                  },
                  provider_attempt: {
                    operation_id: query.operation_id,
                    owner_generation: query.owner_generation,
                    attempt_generation: 1,
                    provider_operation_id: envelope().provider_operation_id,
                    admission_sha256: envelope().admission_sha256,
                    request_sha256: envelope().input.sha256,
                    egress_profile: null,
                    egress_worker_version_id: null,
                    status: "dispatched" as const,
                    response_status: null,
                    response_code: null,
                    result_object_key: null,
                    result_object_version: null,
                    result_sha256: null,
                    result_size: null,
                    result_content_type: null,
                    provider_usage_receipt_sha256: null,
                    provider_usage_receipt_attached_at: null,
                    prepared_at: now + 1,
                    dispatched_at: now + 2,
                    terminal_at: null,
                    updated_at: now + 2,
                  },
                },
              };
            },
            async fetch(): Promise<never> {
              forbiddenCalls += 1;
              throw new Error("Container fetch must not run");
            },
            async containerFetch(): Promise<never> {
              forbiddenCalls += 1;
              throw new Error("containerFetch must not run");
            },
          };
        },
      },
    };

    const first = await handleOperationStatusRequest(
      await signedOperationStatusRequest(),
      routeEnv,
      now + 1,
    );
    const replay = await handleOperationStatusRequest(
      await signedOperationStatusRequest(),
      routeEnv,
      now + 1,
    );
    expect(first.status).toBe(202);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstPayload = (await first.json()) as Record<string, unknown>;
    expect(firstPayload).toEqual(await replay.json());
    expect("provider_attempt" in firstPayload).toBe(false);

    const v2 = await handleOperationStatusV2Request(
      await signedOperationStatusV2Request(),
      routeEnv,
      now + 1,
    );
    expect(v2.status).toBe(202);
    expect(await v2.json()).toMatchObject({
      provider_attempt: { attempt_generation: 1, status: "dispatched" },
    });
    const v3 = await handleOperationStatusV3Request(
      await signedOperationStatusV3Request(),
      routeEnv,
      now + 1,
    );
    expect(v3.status).toBe(202);
    expect(await v3.json()).toMatchObject({
      status_contract_version: 3,
      provider_usage_receipt_sha256: null,
      provider_attempt: {
        attempt_generation: 1,
        provider_usage_receipt_sha256: null,
        provider_usage_receipt_attached_at: null,
      },
    });
    expect(seen).toEqual([operationStatusQuery(), operationStatusQuery()]);
    expect(seenV2).toEqual([operationStatusQuery()]);
    expect(seenV3).toEqual([operationStatusQuery()]);
    expect(forbiddenCalls).toBe(0);
  });

  test("verifies signed ledger and live readiness probes", async () => {
    const ledger = await verifyReadinessRequest(await signedReadinessRequest(), env, now + 1);
    expect(ledger.probe.wake_container).toBe(false);
    expect(ledger.claims.dispatch_id).toBe("readiness-test-1");

    const live = await verifyReadinessRequest(
      await signedReadinessRequest(readinessProbe(true), { dispatch_id: "readiness-live-1" }),
      env,
      now + 1,
    );
    expect(live.probe.wake_container).toBe(true);
    expect(live.probe.shard.instance_name).toBe("cinatoken-relay-shard-v1-0003");
  });

  test("readiness rejects body tampering, unknown fields, stale fences, and oversized bodies", async () => {
    const signed = await signedReadinessRequest();
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: (await signed.text()).replace("false", "true"),
    });
    await expect(verifyReadinessRequest(tampered, env, now + 1)).rejects.toMatchObject({
      code: "authority_claim_mismatch",
      status: 403,
    });
    await expect(
      verifyReadinessRequest(
        await signedReadinessRequest({ ...readinessProbe(), unexpected: true }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_readiness_probe", status: 400 });
    await expect(
      verifyReadinessRequest(
        await signedReadinessRequest({
          ...readinessProbe(),
          shard: { ...readinessProbe().shard, ring_generation: 2 },
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "stale_shard_fence", status: 409 });
    const oversized = new Request(`https://controller.internal${INTERNAL_READINESS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORITY_HEADER]: "not-used" },
      body: "x".repeat(MAX_READINESS_BODY_BYTES + 1),
    });
    await expect(verifyReadinessRequest(oversized, env, now)).rejects.toMatchObject({
      code: "readiness_probe_too_large",
      status: 413,
    });
  });

  test("rejects signature, body, audience, and expiry violations", async () => {
    const tampered = await signedRequest();
    const tamperedBody = await tampered.text();
    const badBody = new Request(tampered.url, {
      method: "POST",
      headers: tampered.headers,
      body: tamperedBody.replace("health_probe", "health_probx"),
    });
    await expect(verifyOperationRequest(badBody, env, now + 1)).rejects.toMatchObject({ code: "authority_claim_mismatch" });
    await expect(
      verifyOperationRequest(await signedRequest(envelope(), { audience: "wrong-audience" }), env, now + 1),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch" });
    await expect(
      verifyOperationRequest(await signedRequest(envelope(), { expires_at: now + 1 }), env, now + 1),
    ).rejects.toMatchObject({ code: "authority_expired" });
  });

  test("rejects stale topology, unknown fields, and invalid owner deadlines", () => {
    expect(() =>
      parseOperationEnvelope(
        new TextEncoder().encode(JSON.stringify({ ...envelope(), extra: true })),
        env,
        now,
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      parseOperationEnvelope(
        new TextEncoder().encode(
          JSON.stringify({ ...envelope(), shard: { ...envelope().shard, instance_name: "cinatoken-relay-shard-v1-0004" } }),
        ),
        env,
        now,
      ),
    ).toThrow("stale_shard_fence");
    expect(() =>
      parseOperationEnvelope(
        new TextEncoder().encode(
          JSON.stringify({
            ...envelope(),
            owner_lease_expires_at: now + MAX_EXECUTION_WINDOW_SECONDS + 1,
            execution_deadline_at: now + MAX_EXECUTION_WINDOW_SECONDS + 1,
          }),
        ),
        env,
        now,
      ),
    ).toThrow("invalid_operation_deadline");
  });

  test("rejects oversized or non-JSON operation bodies before parsing", async () => {
    const oversized = new Request(`https://controller.internal${INTERNAL_OPERATION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTHORITY_HEADER]: "not-used",
      },
      body: "x".repeat(64 * 1024 + 1),
    });
    await expect(verifyOperationRequest(oversized, env, now)).rejects.toMatchObject({
      code: "operation_too_large",
      status: 413,
    });
    const nonJson = await signedRequest();
    const request = new Request(nonJson.url, {
      method: "POST",
      headers: { ...Object.fromEntries(nonJson.headers), "content-type": "text/plain" },
      body: await nonJson.arrayBuffer(),
    });
    await expect(verifyOperationRequest(request, env, now)).rejects.toMatchObject({
      code: "invalid_content_type",
      status: 415,
    });
  });

  test("requires versioned R2 references and accepts the previous authority key", async () => {
    const r2 = envelope();
    r2.input = {
      mode: "r2",
      sha256: "c".repeat(64),
      size: 4096,
      content_type: "application/octet-stream",
      request_object_key: "requests/sha256/" + "c".repeat(64),
      object_version: "etag-1",
    };
    expect(parseOperationEnvelope(new TextEncoder().encode(JSON.stringify(r2)), env, now).input.mode).toBe("r2");

    const request = await signedRequest();
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const claims: AuthorityClaims = {
      authority_version: 1,
      issuer: env.CONTAINER_AUTHORITY_ISSUER,
      audience: env.CONTAINER_AUTHORITY_AUDIENCE,
      protocol_version: 1,
      dispatch_id: "dispatch-previous",
      method: "POST",
      path: INTERNAL_OPERATION_PATH,
      body_sha256: await sha256Hex(body),
      issued_at: now,
      expires_at: now + 30,
    };
    const token = await createAuthorityTokenForTest(
      env.CONTAINER_AUTHORITY_PREVIOUS_SECRET!,
      env.CONTAINER_AUTHORITY_PREVIOUS_KID,
      claims,
    );
    const previous = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", [AUTHORITY_HEADER]: token },
      body,
    });
    expect((await verifyOperationRequest(previous, env, now + 1)).claims.dispatch_id).toBe("dispatch-previous");
  });

  test("fails closed when the authority rotation keyring is inconsistent", async () => {
    const request = await signedRequest();
    await expect(
      verifyOperationRequest(
        request,
        {
          ...env,
          CONTAINER_AUTHORITY_PREVIOUS_KID: env.CONTAINER_AUTHORITY_CURRENT_KID,
        },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "authority_unavailable", status: 503 });
  });
});
