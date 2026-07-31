import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const currentSecret = "registration-coordinator-service-runtime-secret-v1";
const currentKid = "registration-coordinator-service-runtime-v1";
const callerIdentity = "8a".repeat(32);
const authorityIssuer = "cinatoken-application-service-runtime-test";
const authorityAudience =
  "drain-source-registration-coordinator-service-runtime-test";
const authorityType =
  "CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR";
const authorityDomain =
  "cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:";
const objectNameDomain =
  "cinatoken:relay-container:drain-source-registration:coordinator-object:v1";

const identity = Object.freeze({
  authorization_id_sha256: digest("a"),
  contract_version: 1,
  environment: "local",
  operation_id_sha256: digest("b"),
  root_user_id: "42",
  scope_id_sha256: digest("c"),
  scope_kind: "global",
});

describe.sequential(
  "drain-source registration coordinator Service Binding runtime",
  () => {
    it("reaches the isolated SQLite Durable Object through the caller binding", async () => {
      const objectName = await coordinatorObjectName(identity);
      expect(objectName).toBe(
        "drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce",
      );
      const payload = beginRequest(digest("3"), Date.now() + 60_000);
      const request = await signedRequest("/v1/begin", payload, objectName);

      const created = await SELF.fetch(request);
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        event_count: 1,
        generation: 1,
        operation_id_sha256: identity.operation_id_sha256,
        phase: "challenge_issued",
        replayed: false,
        terminal: false,
      });

      const replay = await SELF.fetch(
        await signedRequest("/v1/begin", payload, objectName),
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        event_count: 1,
        generation: 1,
        phase: "challenge_issued",
        replayed: true,
      });
    });

    it("fails closed when signed routing and body identity select different objects", async () => {
      const expectedObjectName = await coordinatorObjectName(identity);
      const wrongObjectName =
        "drain-source-registration-coordinator-v1:" + digest("9");
      expect(wrongObjectName).not.toBe(expectedObjectName);
      const payload = beginRequest(digest("4"), Date.now() + 60_000);

      const response = await SELF.fetch(
        await signedRequest("/v1/begin", payload, wrongObjectName),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        code: "invalid_authority",
        contract_version: 1,
      });
    });

    it("keeps non-contract paths outside the Durable Object", async () => {
      const objectName = await coordinatorObjectName(identity);
      const payload = beginRequest(digest("5"), Date.now() + 60_000);
      const response = await SELF.fetch(
        await signedRequest("/v1/not-found", payload, objectName),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: "not_found",
        contract_version: 1,
      });
    });
  },
);

function beginRequest(requestId, expiresAtMs) {
  return {
    command: "begin",
    evidence: {
      authority_fingerprint_sha256: digest("d"),
      begin_intent_sha256: digest("e"),
      ceremony_id_sha256: digest("f"),
      challenge_phase_proof_sha256: digest("1"),
      challenge_sha256: digest("2"),
    },
    expected_generation: 0,
    expires_at_ms: expiresAtMs,
    identity,
    request_id_sha256: requestId,
  };
}

async function signedRequest(path, payload, objectName) {
  const body = canonicalJson(payload);
  const now = Math.floor(Date.now() / 1_000);
  const headerPart = base64Url(
    new TextEncoder().encode(
      canonicalJson({
        alg: "HS256",
        kid: currentKid,
        typ: authorityType,
      }),
    ),
  );
  const claimsPart = base64Url(
    new TextEncoder().encode(
      canonicalJson({
        audience: authorityAudience,
        body_sha256: await sha256Hex(new TextEncoder().encode(body)),
        caller_identity_sha256: callerIdentity,
        expires_at: now + 30,
        issued_at: now,
        issuer: authorityIssuer,
        method: "POST",
        object_name: objectName,
        path,
        request_id_sha256: payload.request_id_sha256,
      }),
    ),
  );
  const signature = await hmac(
    new TextEncoder().encode(currentSecret),
    concatBytes(
      new TextEncoder().encode(authorityDomain),
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ),
  );
  return new Request(`https://application.internal${path}`, {
    body,
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-coordinator-authority":
        `${headerPart}.${claimsPart}.${base64Url(signature)}`,
    },
    method: "POST",
  });
}

async function coordinatorObjectName(targetIdentity) {
  const value = await lengthPrefixedSha256(objectNameDomain, [
    targetIdentity.environment,
    targetIdentity.root_user_id,
    targetIdentity.scope_kind,
    targetIdentity.scope_id_sha256,
    targetIdentity.operation_id_sha256,
  ]);
  return `drain-source-registration-coordinator-v1:${value}`;
}

async function lengthPrefixedSha256(domain, values) {
  const encoder = new TextEncoder();
  const parts = [encoder.encode(domain)];
  for (const value of values) {
    const bytes = encoder.encode(value);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
    parts.push(length, bytes);
  }
  return sha256Hex(concatBytes(...parts));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

async function sha256Hex(bytes) {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatBytes(...parts) {
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

function base64Url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function digest(character) {
  return character.repeat(64);
}
