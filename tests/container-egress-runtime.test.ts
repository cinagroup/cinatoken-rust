import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  PROVIDER_RESPONSE_V3_CONTENT_TYPE,
  readProviderResponseV3,
} from "../services/container-controller/src/provider_response_v3";

const protocolHeader = "x-cinatoken-provider-egress-protocol";
const profileHeader = "x-cinatoken-provider-egress-profile";
const workerVersionHeader = "x-cinatoken-provider-egress-worker-version";
const expectedWorkerVersionHeader = "x-cinatoken-provider-egress-expected-worker-version";
const profile = "openai-chat-completions-canary-v1";
const headers = {
  [protocolHeader]: "1",
  [profileHeader]: profile,
};

describe("container provider egress readiness Worker", () => {
  test("returns an exact secret-free readiness contract", async () => {
    const response = await SELF.fetch("https://harness.test/ready", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(protocolHeader)).toBe("1");
    expect(response.headers.get(profileHeader)).toBe(profile);
    const workerVersionId = response.headers.get(workerVersionHeader);
    expect(workerVersionId).toMatch(/^[A-Za-z0-9._:/@-]{1,128}$/);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      protocol_version: 1,
      profile,
      ready: true,
    });
    expect(text).not.toContain("canary-runtime-model");
    expect(text).not.toContain("runtime-provider-secret");
  });

  test("fails closed for disabled or incomplete broker configuration", async () => {
    const cases = [
      ["disabled", "provider_egress_disabled"],
      ["missing-model", "provider_egress_configuration_unavailable"],
      ["missing-secret", "provider_egress_credential_unavailable"],
      ["missing-version", "provider_egress_configuration_unavailable"],
    ];
    for (const [path, error] of cases) {
      const response = await SELF.fetch(`https://harness.test/${path}`, { headers });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  test("rejects an execution version mismatch before provider I/O", async () => {
    const readiness = await SELF.fetch("https://harness.test/ready", { headers });
    const workerVersionId = readiness.headers.get(workerVersionHeader);
    expect(workerVersionId).toMatch(/^[A-Za-z0-9._:/@-]{1,128}$/);

    const body = JSON.stringify({
      model: "canary-runtime-model",
      messages: [],
      stream: false,
    });
    const bodyBytes = new TextEncoder().encode(body);
    const executeHeaders = {
      "accept": "application/json",
      "content-length": String(bodyBytes.byteLength),
      "content-type": "application/json",
      [protocolHeader]: "2",
      [profileHeader]: profile,
      [expectedWorkerVersionHeader]: workerVersionId!,
      "x-cinatoken-operation-id": "operation-runtime-version-check",
      "x-cinatoken-owner-generation": "1",
      "x-cinatoken-provider-attempt-generation": "1",
      "x-cinatoken-provider-operation-id": "provider-operation-runtime-version-check",
      "x-cinatoken-provider-deadline": String(Math.floor(Date.now() / 1000) + 60),
      "x-cinatoken-content-sha256": await sha256Hex(bodyBytes),
    };

    const matching = await SELF.fetch("https://harness.test/execute", {
      method: "POST",
      headers: executeHeaders,
      body,
    });
    expect(matching.status).toBe(200);
    expect(matching.headers.get(workerVersionHeader)).toBe(workerVersionId);
    expect(matching.headers.get("x-request-id")).toBe("provider-mock-call");

    const mismatched = await SELF.fetch("https://harness.test/execute", {
      method: "POST",
      headers: {
        ...executeHeaders,
        [expectedWorkerVersionHeader]: "different-worker-version",
      },
      body,
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.headers.get(workerVersionHeader)).toBe(workerVersionId);
    expect(mismatched.headers.get("x-request-id")).toBeNull();
    await expect(mismatched.json()).resolves.toEqual({
      error: "provider_egress_worker_version_mismatch",
    });
  });

  test("emits canonical v3 envelopes for success and every interpreted rejection class", async () => {
    const readiness = await SELF.fetch("https://harness.test/ready", { headers });
    const workerVersionId = readiness.headers.get(workerVersionHeader);
    expect(workerVersionId).toMatch(/^[A-Za-z0-9._:/@-]{1,128}$/);

    const scenarios = [
      { name: "success", responseClass: "success", providerStatus: 200, clientStatus: 200 },
      { name: "typed_200", responseClass: "typed_error", providerStatus: 200, clientStatus: 200 },
      { name: "http_202", responseClass: "http_error", providerStatus: 202, clientStatus: 202 },
      { name: "invalid_body", responseClass: "invalid_body", providerStatus: 200, clientStatus: 500 },
    ] as const;

    for (const scenario of scenarios) {
      const body = JSON.stringify({
        model: "canary-runtime-model",
        messages: [],
        stream: false,
        mock_case: scenario.name,
      });
      const bodyBytes = new TextEncoder().encode(body);
      const operationId = `operation-runtime-v3-${scenario.name.replace("_", "-")}`;
      const response = await SELF.fetch("https://harness.test/execute-v3", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-length": String(bodyBytes.byteLength),
          "content-type": "application/json",
          [protocolHeader]: "3",
          [profileHeader]: profile,
          [expectedWorkerVersionHeader]: workerVersionId!,
          "x-cinatoken-operation-id": operationId,
          "x-cinatoken-owner-generation": "2",
          "x-cinatoken-provider-attempt-generation": "1",
          "x-cinatoken-provider-operation-id": `provider-${operationId}`,
          "x-cinatoken-provider-deadline": String(Math.floor(Date.now() / 1000) + 60),
          "x-cinatoken-content-sha256": await sha256Hex(bodyBytes),
        },
        body,
      });
      expect(response.status, scenario.name).toBe(200);
      expect(response.headers.get("content-type"), scenario.name).toBe(
        PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      );
      expect(response.headers.get(protocolHeader), scenario.name).toBe("3");
      expect(response.headers.get(workerVersionHeader), scenario.name).toBe(workerVersionId);
      expect(Number(response.headers.get("content-length")), scenario.name).toBeGreaterThan(0);

      const verified = await readProviderResponseV3(response);
      expect(verified.envelope.identity, scenario.name).toMatchObject({
        operation_id: operationId,
        owner_generation: 2,
        attempt_generation: 1,
        egress_profile: profile,
        egress_worker_version_id: workerVersionId,
      });
      expect(verified.envelope.interpretation, scenario.name).toMatchObject({
        response_class: scenario.responseClass,
        provider_status: scenario.providerStatus,
        client_status: scenario.clientStatus,
      });
      expect(verified.envelope.usage_receipt === null, scenario.name).toBe(
        scenario.name !== "success",
      );
      expect(verified.raw_body.byteLength, scenario.name).toBe(
        verified.envelope.raw.body_length,
      );
      expect(verified.client_body.byteLength, scenario.name).toBe(
        verified.envelope.client.body_length,
      );
    }
  });

  test("rejects the wrong method or profile before configuration readback", async () => {
    const wrongMethod = await SELF.fetch("https://harness.test/ready", {
      method: "POST",
      headers,
    });
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toEqual({
      error: "provider_egress_method_not_allowed",
    });

    const wrongProfile = await SELF.fetch("https://harness.test/ready", {
      headers: { ...headers, [profileHeader]: "wrong-profile" },
    });
    expect(wrongProfile.status).toBe(403);
    await expect(wrongProfile.json()).resolves.toEqual({
      error: "provider_egress_access_denied",
    });
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
