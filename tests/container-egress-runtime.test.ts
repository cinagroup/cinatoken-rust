import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const protocolHeader = "x-cinatoken-provider-egress-protocol";
const profileHeader = "x-cinatoken-provider-egress-profile";
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
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ protocol_version: 1, profile, ready: true });
    expect(text).not.toContain("canary-runtime-model");
    expect(text).not.toContain("runtime-provider-secret");
  });

  test("fails closed for disabled or incomplete broker configuration", async () => {
    const cases = [
      ["disabled", "provider_egress_disabled"],
      ["missing-model", "provider_egress_configuration_unavailable"],
      ["missing-secret", "provider_egress_credential_unavailable"],
    ];
    for (const [path, error] of cases) {
      const response = await SELF.fetch(`https://harness.test/${path}`, { headers });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error });
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
