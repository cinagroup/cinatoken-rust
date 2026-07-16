import { describe, expect, test } from "bun:test";
import goldenVector from "../../../tests/fixtures/container-authority-v1.json";
import {
  AUTHORITY_HEADER,
  INTERNAL_OPERATION_PATH,
  INTERNAL_STATUS_PATH,
  MAX_EXECUTION_WINDOW_SECONDS,
  ProtocolError,
  createAuthorityTokenForTest,
  parseOperationEnvelope,
  sha256Hex,
  verifyOperationRequest,
  verifyStatusRequest,
  type AuthorityClaims,
  type AuthorityEnvironment,
  type OperationEnvelope,
} from "../src/protocol";

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
