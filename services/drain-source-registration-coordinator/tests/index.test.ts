import { describe, expect, it, vi } from "vitest";

import coordinatorWorker from "../src/adapter.mjs";

const currentKid = "coordinator-adapter-v1";
const currentSecret = "coordinator-adapter-current-secret-v1";
const previousKid = "coordinator-adapter-v0";
const previousSecret = "coordinator-adapter-previous-secret-v0";
const callerIdentity = "7a".repeat(32);
const issuer = "cinatoken-adapter-test-caller";
const audience = "cinatoken-adapter-test-coordinator";
const objectName =
  "drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce";
const authorityType =
  "CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR";
const authorityDomain =
  "cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:";

const identity = Object.freeze({
  authorization_id_sha256: digest("a"),
  contract_version: 1,
  environment: "local",
  operation_id_sha256: digest("b"),
  root_user_id: "42",
  scope_id_sha256: digest("c"),
  scope_kind: "global",
});

describe("drain-source registration coordinator service adapter", () => {
  it("is disabled before reading authority or body", async () => {
    const response = await coordinatorWorker.fetch(
      rawRequest("/v1/status", '{"not":"canonical"}', "invalid"),
      environment(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "coordinator_disabled",
      contract_version: 1,
    });
  });

  it("rejects non-contract routes and ambient authority headers", async () => {
    const route = await coordinatorWorker.fetch(
      rawRequest("/v1/other", "{}", "invalid"),
      environment({ enabled: true }),
    );
    expect(route.status).toBe(404);

    const ambientHeaders: Record<string, string>[] = [
      { authorization: "Bearer forbidden" },
      { cookie: "session=forbidden" },
      { origin: "https://example.com" },
      { "content-encoding": "gzip" },
    ];
    for (const headers of ambientHeaders) {
      const response = await coordinatorWorker.fetch(
        rawRequest("/v1/status", "{}", "invalid", headers),
        environment({ enabled: true }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "forbidden_request_header",
      });
    }
  });

  it("bounds and canonicalizes the body before authentication", async () => {
    const invalidMedia = new Request("https://caller.internal/v1/status", {
      body: "{}",
      headers: {
        "content-type": "text/plain",
        "x-cinatoken-drain-source-registration-coordinator-authority":
          "invalid",
      },
      method: "POST",
    });
    const mediaResponse = await coordinatorWorker.fetch(
      invalidMedia,
      environment({ enabled: true }),
    );
    expect(mediaResponse.status).toBe(415);

    const nonCanonical = await coordinatorWorker.fetch(
      rawRequest("/v1/status", '{ "command": "status" }', "invalid"),
      environment({ enabled: true }),
    );
    expect(nonCanonical.status).toBe(400);
    expect(await nonCanonical.json()).toMatchObject({
      code: "invalid_canonical_json",
    });

    const tooLarge = await coordinatorWorker.fetch(
      rawRequest("/v1/status", `"${"x".repeat(16 * 1024)}"`, "invalid"),
      environment({ enabled: true }),
    );
    expect(tooLarge.status).toBe(413);
  });

  it("rejects malformed authority before selecting a Durable Object", async () => {
    const getByName = vi.fn();
    for (const authority of ["invalid", "a.b.c=", "a..c"]) {
      const response = await coordinatorWorker.fetch(
        rawRequest(
          "/v1/status",
          canonicalJson(statusRequest(digest("1"))),
          authority,
        ),
        environment({ enabled: true, getByName }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "invalid_authority",
      });
    }
    expect(getByName).not.toHaveBeenCalled();
  });

  it("verifies HMAC, body binding, and object derivation before lookup", async () => {
    const getByName = vi.fn();
    const body = canonicalJson(statusRequest(digest("2")));
    const wrongSecret = await signedAuthority("/v1/status", body, {
      secret: "wrong-coordinator-adapter-secret-v1",
    });

    const response = await coordinatorWorker.fetch(
      rawRequest("/v1/status", body, wrongSecret),
      environment({ enabled: true, getByName }),
    );

    expect(response.status).toBe(403);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("accepts both current and previous keys and forwards only exact protocol bytes", async () => {
    for (const key of [
      { kid: currentKid, secret: currentSecret },
      { kid: previousKid, secret: previousSecret },
    ]) {
      const body = canonicalJson(statusRequest(digest(key.kid === currentKid ? "3" : "4")));
      const authority = await signedAuthority("/v1/status", body, key);
      const fetch = vi.fn(async (forwarded: Request) => {
        expect(forwarded.url).toBe(
          "https://registration-coordinator.internal/v1/status",
        );
        expect(await forwarded.text()).toBe(body);
        expect([...forwarded.headers.keys()].sort()).toEqual([
          "content-type",
          "x-cinatoken-drain-source-registration-coordinator-authority",
        ]);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const getByName = vi.fn(() => ({ fetch }));

      const response = await coordinatorWorker.fetch(
        rawRequest("/v1/status", body, authority),
        environment({ enabled: true, getByName }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(getByName).toHaveBeenCalledExactlyOnceWith(objectName);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed after authentication when the namespace is unavailable", async () => {
    const body = canonicalJson(statusRequest(digest("5")));
    const authority = await signedAuthority("/v1/status", body);
    const response = await coordinatorWorker.fetch(
      rawRequest("/v1/status", body, authority),
      {
        ...environment({ enabled: true }),
        DRAIN_SOURCE_REGISTRATION_COORDINATORS: undefined,
      } as unknown as DrainSourceRegistrationCoordinatorRuntimeEnv,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "coordinator_unavailable",
      contract_version: 1,
    });
  });
});

function statusRequest(requestId: string) {
  return {
    command: "status",
    identity,
    request_id_sha256: requestId,
  };
}

function rawRequest(
  path: string,
  body: string,
  authority: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://caller.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-coordinator-authority": authority,
      ...headers,
    },
    body,
  });
}

function environment({
  enabled = false,
  getByName = () => ({ fetch: vi.fn() }),
}: {
  enabled?: boolean;
  getByName?: (name: string) => unknown;
} = {}): DrainSourceRegistrationCoordinatorRuntimeEnv {
  return {
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT: "local",
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENABLED: String(enabled),
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER: issuer,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE: audience,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256:
      callerIdentity,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID: currentKid,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET: currentSecret,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_KID: previousKid,
    DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_SECRET: previousSecret,
    DRAIN_SOURCE_REGISTRATION_COORDINATORS: {
      getByName,
    } as unknown as DurableObjectNamespace,
  };
}

async function signedAuthority(
  path: string,
  body: string,
  {
    kid = currentKid,
    secret = currentSecret,
  }: { kid?: string; secret?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const headerPart = base64Url(
    new TextEncoder().encode(
      canonicalJson({
        alg: "HS256",
        kid,
        typ: authorityType,
      }),
    ),
  );
  const claimsPart = base64Url(
    new TextEncoder().encode(
      canonicalJson({
        audience,
        body_sha256: await sha256Hex(new TextEncoder().encode(body)),
        caller_identity_sha256: callerIdentity,
        expires_at: now + 30,
        issued_at: now,
        issuer,
        method: "POST",
        object_name: objectName,
        path,
        request_id_sha256: JSON.parse(body).request_id_sha256,
      }),
    ),
  );
  const signature = await hmac(
    new TextEncoder().encode(secret),
    concatBytes(
      new TextEncoder().encode(authorityDomain),
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ),
  );
  return `${headerPart}.${claimsPart}.${base64Url(signature)}`;
}

async function hmac(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalValue((value as Record<string, unknown>)[key]),
      ]),
  );
}

function digest(character: string): string {
  return character.repeat(64);
}
