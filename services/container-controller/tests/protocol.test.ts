import { describe, expect, test } from "bun:test";
import goldenVector from "../../../tests/fixtures/container-authority-v1.json";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
  INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH,
  INTERNAL_OPERATION_STATUS_PATH,
  INTERNAL_OPERATION_STATUS_V2_PATH,
  INTERNAL_OPERATION_STATUS_V3_PATH,
  INTERNAL_OPERATION_STATUS_V4_PATH,
  INTERNAL_READINESS_PATH,
  INTERNAL_STATUS_PATH,
  MAX_OPERATION_STATUS_BODY_BYTES,
  MAX_STORAGE_OBJECT_VERSION_BYTES,
  MAX_TERMINAL_ACK_BODY_BYTES,
  MAX_READINESS_BODY_BYTES,
  MAX_EXECUTION_WINDOW_SECONDS,
  OPERATION_STATUS_V3_AUTHORITY_DOMAIN,
  OPERATION_STATUS_V4_AUTHORITY_DOMAIN,
  ProtocolError,
  TERMINAL_ACK_V2_AUTHORITY_DOMAIN,
  TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
  createAuthorityTokenForTest,
  parseOperationEnvelope,
  sha256Hex,
  verifyOperationRequest,
  verifyOperationStatusRequest,
  verifyOperationStatusV2Request,
  verifyOperationStatusV3Request,
  verifyOperationStatusV4Request,
  verifyReadinessRequest,
  verifyStatusRequest,
  verifyTerminalAckRequest,
  verifyTerminalAckV2Request,
  verifyTerminalAckV3Request,
  type AuthorityClaims,
  type AuthorityEnvironment,
  type OperationEnvelope,
  type OperationStatusQuery,
  type TerminalAckRequestV1,
  type TerminalAckRequestV2,
  type TerminalAckRequestV3,
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
  handleOperationStatusV4Request,
  type OperationStatusEnvironment,
  type OperationStatusV4Environment,
} from "../src/operation_status";
import type { RelayShardJurisdictionEnvironment } from "../src/relay_shard_jurisdiction";

const secret = "0123456789abcdef0123456789abcdef";
const now = 1_800_000_000;
const env: AuthorityEnvironment & RelayShardJurisdictionEnvironment = {
  CONTAINER_AUTHORITY_ISSUER: "cinatoken-edge-test",
  CONTAINER_AUTHORITY_AUDIENCE: "cinatoken-container-controller-test",
  CONTAINER_AUTHORITY_CURRENT_KID: "test-v1",
  CONTAINER_AUTHORITY_PREVIOUS_KID: "test-v0",
  CONTAINER_AUTHORITY_CURRENT_SECRET: secret,
  CONTAINER_AUTHORITY_PREVIOUS_SECRET: "abcdef0123456789abcdef0123456789",
  CONTAINER_PROTOCOL_VERSION: "1",
  CONTAINER_RING_GENERATION: "1",
  CONTAINER_SHARD_COUNT: "8",
  CONTAINER_PREVIOUS_RING_GENERATION: "0",
  CONTAINER_PREVIOUS_SHARD_COUNT: "0",
  CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: "0",
  CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: "0",
  CONTAINER_DURABLE_OBJECT_JURISDICTION: "default",
  CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED: "false",
  CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED: "false",
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

function terminalAckV3(
  overrides: Partial<TerminalAckRequestV3> = {},
): TerminalAckRequestV3 {
  const operation = envelope();
  const resultSha256 = "c".repeat(64);
  const result = {
    ...terminalAck().result!,
    object_key:
      `container-results/v1/${operation.operation_id}/2/${resultSha256}`,
  };
  return {
    ...terminalAckV2({
      owner_generation: 2,
      result,
      provider_usage_binding: {
        attempt_generation: 1,
        receipt_sha256: "9".repeat(64),
        result_sha256: result.sha256,
      },
    }),
    terminal_ack_contract_version: 3,
    financial_terminal_contract_version: 2,
    provider_response_binding: {
      attempt_generation: 1,
      status: "succeeded",
      response_class: "success",
      provider_status: 200,
      client_status: 200,
      response_code: null,
      provider_response_evidence_sha256: "7".repeat(64),
      client_response_artifact_sha256: "8".repeat(64),
    },
    ...overrides,
  };
}

function terminalAckV3Reject(
  responseClass: "typed_error" | "http_error" | "invalid_body",
  providerStatus: number,
  clientStatus: number,
): TerminalAckRequestV3 {
  const responseCode = `provider_${responseClass}`;
  return terminalAckV3({
    operation_status: "failed",
    response_status: 422,
    response_code: responseCode,
    result: null,
    provider_usage_binding: null,
    provider_response_binding: {
      attempt_generation: 1,
      status: "interpreted_reject",
      response_class: responseClass,
      provider_status: providerStatus,
      client_status: clientStatus,
      response_code: responseCode,
      provider_response_evidence_sha256: "7".repeat(64),
      client_response_artifact_sha256: "8".repeat(64),
    },
  });
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

async function signedOperationStatusV4Request(
  value = operationStatusQuery(),
  overrides: Partial<AuthorityClaims> = {},
  authorityDomain = OPERATION_STATUS_V4_AUTHORITY_DOMAIN,
): Promise<Request> {
  return signedOperationStatusRequest(
    value,
    overrides,
    INTERNAL_OPERATION_STATUS_V4_PATH,
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

async function signedTerminalAckV3Request(
  value: unknown = terminalAckV3(),
  overrides: Partial<AuthorityClaims> = {},
  authorityDomain = TERMINAL_ACK_V3_AUTHORITY_DOMAIN,
): Promise<Request> {
  return signedTerminalAckRequest(
    value,
    overrides,
    INTERNAL_OPERATION_TERMINAL_ACK_V3_PATH,
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
    expect(verified.ring_admission).toEqual({ role: "current", transition: null });
  });

  test("bounds previous-ring admission and keeps exact replay routing after cutoff", async () => {
    const transitionEnv: AuthorityEnvironment = {
      ...env,
      CONTAINER_RING_GENERATION: "2",
      CONTAINER_SHARD_COUNT: "16",
      CONTAINER_PREVIOUS_RING_GENERATION: "1",
      CONTAINER_PREVIOUS_SHARD_COUNT: "8",
      CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: String(now - 1),
      CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: String(now + 5),
    };
    const admitted = await verifyOperationRequest(
      await signedRequest(),
      transitionEnv,
      now + 1,
    );
    expect(admitted.ring_admission.role).toBe("previous_admit");
    expect(admitted.ring_admission.transition).toMatchObject({
      current_ring_generation: 2,
      current_shard_count: 16,
      previous_ring_generation: 1,
      previous_shard_count: 8,
      admission_open: true,
    });

    const replayOnly = await verifyOperationRequest(
      await signedRequest(),
      transitionEnv,
      now + 6,
    );
    expect(replayOnly.ring_admission).toMatchObject({
      role: "previous_replay_only",
      transition: { admission_open: false },
    });

    const current = envelope();
    current.shard = {
      ...current.shard,
      ring_generation: 2,
      shard_count: 16,
    };
    await expect(
      verifyOperationRequest(await signedRequest(current), transitionEnv, now + 6),
    ).resolves.toMatchObject({ ring_admission: { role: "current" } });
  });

  test("fails closed on partial, non-adjacent, and overlong ring transitions", async () => {
    const baseTransition = {
      ...env,
      CONTAINER_RING_GENERATION: "2",
      CONTAINER_SHARD_COUNT: "16",
      CONTAINER_PREVIOUS_RING_GENERATION: "1",
      CONTAINER_PREVIOUS_SHARD_COUNT: "8",
      CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: String(now),
      CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: String(now + 60),
    } satisfies AuthorityEnvironment;
    for (const invalidEnv of [
      { ...baseTransition, CONTAINER_PREVIOUS_SHARD_COUNT: "0" },
      { ...baseTransition, CONTAINER_PREVIOUS_RING_GENERATION: "7" },
      {
        ...baseTransition,
        CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: String(now + 15 * 60 + 1),
      },
    ]) {
      await expect(
        verifyOperationRequest(await signedRequest(), invalidEnv, now + 1),
      ).rejects.toMatchObject({ code: "ring_transition_misconfigured", status: 503 });
    }
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

  test("isolates the signed status v4 contract from every earlier path and domain", async () => {
    const query = operationStatusQuery();
    const verified = await verifyOperationStatusV4Request(
      await signedOperationStatusV4Request(query),
      env,
      now + 1,
    );
    expect(verified.query).toEqual(query);
    expect(verified.query.protocol_version).toBe(1);

    for (const authorityDomain of [undefined, OPERATION_STATUS_V3_AUTHORITY_DOMAIN]) {
      await expect(
        verifyOperationStatusV4Request(
          await signedOperationStatusRequest(
            query,
            {},
            INTERNAL_OPERATION_STATUS_V4_PATH,
            authorityDomain,
          ),
          env,
          now + 1,
        ),
      ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
    }
    await expect(
      verifyOperationStatusV4Request(
        await signedOperationStatusV4Request(query, {
          path: INTERNAL_OPERATION_STATUS_V3_PATH,
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });
    await expect(
      verifyOperationStatusV3Request(
        await signedOperationStatusV4Request(query),
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

  test("terminal ack v3 has an isolated path, authority domain, and exact binding", async () => {
    const ack = terminalAckV3();
    const verified = await verifyTerminalAckV3Request(
      await signedTerminalAckV3Request(ack),
      env,
      now + 1,
    );
    expect(verified.ack).toEqual(ack);

    await expect(
      verifyTerminalAckV3Request(
        await signedTerminalAckV3Request(ack, {}, TERMINAL_ACK_V2_AUTHORITY_DOMAIN),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "invalid_authority", status: 403 });
    await expect(
      verifyTerminalAckV3Request(
        await signedTerminalAckV3Request(ack, {
          path: INTERNAL_OPERATION_TERMINAL_ACK_V2_PATH,
        }),
        env,
        now + 1,
      ),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });
    await expect(
      verifyTerminalAckV2Request(await signedTerminalAckV3Request(ack), env, now + 1),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
    await expect(
      verifyTerminalAckV3Request(await signedTerminalAckV2Request(), env, now + 1),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });

    const signed = await signedTerminalAckV3Request(ack);
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: (await signed.text()).replace(`"${"7".repeat(64)}"`, `"${"6".repeat(64)}"`),
    });
    await expect(
      verifyTerminalAckV3Request(tampered, env, now + 1),
    ).rejects.toMatchObject({ code: "authority_claim_mismatch", status: 403 });

    const invalidValues: unknown[] = [
      { ...ack, terminal_ack_contract_version: 2 },
      { ...ack, financial_terminal_contract_version: 1 },
      { ...ack, owner_generation: 1 },
      { ...ack, provider_response_binding: null },
      {
        ...ack,
        provider_response_binding: { ...ack.provider_response_binding, unexpected: true },
      },
      {
        ...ack,
        provider_response_binding: {
          ...ack.provider_response_binding,
          client_response_artifact_sha256: "A".repeat(64),
        },
      },
      {
        ...ack,
        provider_usage_binding: {
          ...ack.provider_usage_binding!,
          attempt_generation: 2,
        },
      },
      {
        ...ack,
        provider_response_binding: {
          ...ack.provider_response_binding,
          status: "interpreted_reject",
        },
      },
    ];
    for (const value of invalidValues) {
      await expect(
        verifyTerminalAckV3Request(
          await signedTerminalAckV3Request(value),
          env,
          now + 1,
        ),
      ).rejects.toMatchObject({ code: "invalid_terminal_ack", status: 400 });
    }
  });

  test("terminal ack v3 accepts exact success and all interpreted rejection classes", async () => {
    await expect(
      verifyTerminalAckV3Request(
        await signedTerminalAckV3Request(terminalAckV3()),
        env,
        now + 1,
      ),
    ).resolves.toMatchObject({
      ack: {
        terminal_ack_contract_version: 3,
        financial_terminal_contract_version: 2,
        operation_status: "completed",
        response_status: 200,
        provider_response_binding: {
          status: "succeeded",
          response_class: "success",
          provider_status: 200,
          client_status: 200,
        },
      },
    });

    const rejects = [
      terminalAckV3Reject("typed_error", 200, 200),
      terminalAckV3Reject("http_error", 202, 202),
      terminalAckV3Reject("invalid_body", 200, 500),
    ];
    for (const ack of rejects) {
      await expect(
        verifyTerminalAckV3Request(
          await signedTerminalAckV3Request(ack),
          env,
          now + 1,
        ),
      ).resolves.toMatchObject({ ack });
    }

    for (const providerStatus of [201, 202, 204, 302, 404, 503]) {
      await expect(
        verifyTerminalAckV3Request(
          await signedTerminalAckV3Request(
            terminalAckV3Reject("http_error", providerStatus, providerStatus),
          ),
          env,
          now + 1,
        ),
      ).resolves.toBeDefined();
    }

    const invalidRejects: unknown[] = [
      terminalAckV3({
        operation_status: "recovery_required",
        response_status: 202,
        response_code: "container_execution_ambiguous",
      }),
      terminalAckV3Reject("http_error", 200, 200),
      terminalAckV3Reject("typed_error", 200, 500),
      terminalAckV3Reject("invalid_body", 200, 200),
      {
        ...terminalAckV3Reject("typed_error", 200, 200),
        response_status: 200,
      },
      {
        ...terminalAckV3Reject("typed_error", 200, 200),
        result: terminalAckV3().result,
      },
      {
        ...terminalAckV3Reject("typed_error", 200, 200),
        provider_usage_binding: terminalAckV3().provider_usage_binding,
      },
    ];
    for (const value of invalidRejects) {
      await expect(
        verifyTerminalAckV3Request(
          await signedTerminalAckV3Request(value),
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
    const seenV4: OperationStatusQuery[] = [];
    let forbiddenCalls = 0;
    const routeEnv: OperationStatusEnvironment & OperationStatusV4Environment & {
      DB: { prepare(): never };
      CONTAINER_CONTROLLER_ENABLED: string;
      CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED: string;
      CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED: string;
      CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED: string;
      CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED: string;
    } = {
      ...env,
      CONTAINER_CONTROLLER_ENABLED: "false",
      CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED: "false",
      CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED: "false",
      CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED: "false",
      CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED: "false",
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
            async readOperationStatusV4(query: OperationStatusQuery) {
              seenV4.push(query);
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
                  provider_response_artifacts: null,
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
    const v4First = await handleOperationStatusV4Request(
      await signedOperationStatusV4Request(),
      routeEnv,
      now + 1,
    );
    const v4Replay = await handleOperationStatusV4Request(
      await signedOperationStatusV4Request(),
      routeEnv,
      now + 1,
    );
    expect(v4First.status).toBe(202);
    const v4Body = await v4First.text();
    expect(await v4Replay.text()).toBe(v4Body);
    expect(JSON.parse(v4Body)).toMatchObject({
      status_contract_version: 4,
      provider_usage_receipt_sha256: null,
      provider_response_artifacts: null,
    });
    expect(seen).toEqual([operationStatusQuery(), operationStatusQuery()]);
    expect(seenV2).toEqual([operationStatusQuery()]);
    expect(seenV3).toEqual([operationStatusQuery()]);
    expect(seenV4).toEqual([operationStatusQuery(), operationStatusQuery()]);
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

    const campaign = await verifyReadinessRequest(
      await signedReadinessRequest({
        ...readinessProbe(true),
        activation_campaign: {
          contract_version: 1,
          campaign_id: "a".repeat(64),
          nonce: "b".repeat(64),
          confirm_consume: true,
        },
      }),
      env,
      now + 1,
    );
    expect(campaign.probe.activation_campaign).toEqual({
      contract_version: 1,
      campaign_id: "a".repeat(64),
      nonce: "b".repeat(64),
      confirm_consume: true,
    });
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
    for (const invalidCampaignProbe of [
      {
        ...readinessProbe(false),
        activation_campaign: {
          contract_version: 1,
          campaign_id: "a".repeat(64),
          nonce: "b".repeat(64),
          confirm_consume: true,
        },
      },
      {
        ...readinessProbe(true),
        activation_campaign: {
          contract_version: 1,
          campaign_id: "a".repeat(63),
          nonce: "b".repeat(64),
          confirm_consume: true,
        },
      },
      {
        ...readinessProbe(true),
        activation_campaign: {
          contract_version: 1,
          campaign_id: "a".repeat(64),
          nonce: "b".repeat(64),
          confirm_consume: false,
        },
      },
    ]) {
      await expect(
        verifyReadinessRequest(
          await signedReadinessRequest(invalidCampaignProbe),
          env,
          now + 1,
        ),
      ).rejects.toMatchObject({ code: "invalid_readiness_probe", status: 400 });
    }
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
