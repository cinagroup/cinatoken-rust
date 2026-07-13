import {
  env,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const authoritySecret = "0123456789abcdef0123456789abcdef";
const authorityDomain = new Uint8Array([
  ...new TextEncoder().encode("cinatoken-wfp-authority-key:v1"),
  0,
]);
const workerName = "tenant-runtime-test";
const taskRunnerRecordKey = "task_runner_record_v1";
const wfpRouteHeader = "x-cinatoken-wfp-route";
const wfpWorkerHeader = "x-cinatoken-wfp-worker";

afterEach(async () => {
  await reset();
});

describe("Rust Durable Object lifecycle contracts", () => {
  it("allows exactly one concurrent authority replay winner", async () => {
    const authority = await signedAuthority({ requestId: "runtime-concurrent" });
    const stub = replayStub(authority.issuedAt);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => consumeAuthority(stub, authority.token)),
    );
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    await runInDurableObject(stub, async (_instance, state) => {
      const entries = await state.storage.list({ prefix: "used:" });
      expect(entries.size).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      return new Response(null);
    });
  });

  it("preserves consumed authority across Durable Object eviction", async () => {
    const authority = await signedAuthority({ requestId: "runtime-eviction" });
    const stub = replayStub(authority.issuedAt);

    expect((await consumeAuthority(stub, authority.token)).status).toBe(200);
    await evictDurableObject(stub);
    expect((await consumeAuthority(stub, authority.token)).status).toBe(409);
  });

  it("rejects tampered authority and a non-canonical replay shard", async () => {
    const authority = await signedAuthority({ requestId: "runtime-negative" });
    const canonical = replayStub(authority.issuedAt);
    const tampered = `${authority.token.slice(0, -1)}${
      authority.token.endsWith("A") ? "B" : "A"
    }`;

    expect((await consumeAuthority(canonical, tampered)).status).toBe(403);

    const wrong = env.WFP_AUTHORITY_REPLAY.getByName("wrong-runtime-shard");
    expect((await consumeAuthority(wrong, authority.token)).status).toBe(403);
  });

  it("reports a paid-capable Rust tenant without a tenant Cloudflare bearer", async () => {
    const response = await env.WFP_TENANT_RUNTIME.fetch(
      "https://tenant-runtime/__cinatoken/tenant/status",
      {
        headers: {
          [wfpRouteHeader]: "internal-path",
          [wfpWorkerHeader]: workerName,
        },
      },
    );
    const status = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-cinatoken-wfp-runtime")).toBe("rust-wasm");
    expect(status.runtime).toBe("rust-wasm");
    expect(status.paid_ai_capable).toBe(true);
    expect(status.authority_replay_binding_configured).toBe(true);
    expect(status.outbound_auth_mode).toBe("platform-outbound-v1");
    expect(status.tenant_cloudflare_token_bound).toBe(false);
  });

  it("allows one concurrent provider egress for one signed authority", async () => {
    await env.WFP_PROVIDER_MOCK.fetch("https://wfp-provider-mock/__mock/reset", {
      method: "POST",
    });
    const body = new TextEncoder().encode(
      JSON.stringify({ model: "openai/gpt-4.1-mini", input: "runtime probe" }),
    );
    const authority = await signedAuthority({
      requestId: "runtime-cross-worker",
      path: "/v1/responses",
      body,
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => tenantRequest(authority.token, body)),
    );
    const statuses = responses.map((response) => response.status).sort();
    const success = responses.find((response) => response.status === 200);
    const diagnostics = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.clone().text(),
      })),
    );
    const stateResponse = await env.WFP_PROVIDER_MOCK.fetch(
      "https://wfp-provider-mock/__mock/state",
    );
    const state = await stateResponse.json();

    expect(statuses, JSON.stringify({ diagnostics, state })).toEqual([
      200, 409, 409, 409, 409, 409, 409, 409,
    ]);
    expect(success).toBeDefined();
    expect(success.headers.get("x-request-id")).toBe("mock-provider-request");
    expect(success.headers.get("authorization")).toBeNull();
    expect(success.headers.get("set-cookie")).toBeNull();
    expect(success.headers.get("cf-aig-log-id")).toBeNull();

    expect(state).toMatchObject({
      count: 1,
      method: "POST",
      path: "/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/responses",
      authorizationPresent: true,
      authorizationScheme: "Bearer",
      cookiePresent: false,
      contentType: "application/json",
    });
  });

  it("propagates malformed TaskRunner storage so the alarm remains retryable", async () => {
    const stub = env.TASK_RUNNER.getByName("task:runtime-malformed-record");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(taskRunnerRecordKey, {
        task_id: 42,
        status: "armed",
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      return new Response(null);
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      /failed to decode TaskRunner storage/,
    );
    await expect(stub.fetch("https://task-runner/status")).rejects.toThrow(
      /failed to decode TaskRunner storage/,
    );
  });

  it("keeps a genuinely missing TaskRunner record as a successful no-op", async () => {
    const stub = env.TASK_RUNNER.getByName("task:runtime-missing-record");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
      return new Response(null);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
  });
});

function replayStub(issuedAt) {
  const bucket = `${workerName}:${Math.floor(issuedAt / 60)}`;
  return env.WFP_AUTHORITY_REPLAY.getByName(bucket);
}

function consumeAuthority(stub, token) {
  return stub.fetch("https://wfp-authority-replay.internal/consume", {
    method: "POST",
    headers: {
      "x-cinatoken-wfp-authority": token,
      "x-cinatoken-wfp-worker": workerName,
    },
  });
}

function tenantRequest(token, body) {
  return env.WFP_TENANT_RUNTIME.fetch("https://tenant-runtime/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-wfp-authority": token,
      [wfpRouteHeader]: "relay-authority",
      [wfpWorkerHeader]: workerName,
    },
    body,
  });
}

async function signedAuthority({ requestId, path = "/v1/responses", body = new Uint8Array() }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    version: 1,
    worker: workerName,
    method: "POST",
    path,
    body_sha256: await sha256Hex(body),
    request_id: requestId,
    channel_id: 42,
    issued_at: issuedAt,
    expires_at: issuedAt + 30,
  };
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const workerKey = await hmac(
    new TextEncoder().encode(authoritySecret),
    concatBytes(authorityDomain, new TextEncoder().encode(workerName)),
  );
  const signature = await hmac(workerKey, payload);
  return {
    issuedAt,
    token: `${base64Url(payload)}.${base64Url(signature)}`,
  };
}

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function base64Url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
