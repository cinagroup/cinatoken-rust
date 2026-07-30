import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SIGNATURE_DOMAIN = new TextEncoder().encode(
  "cinatoken-root-session-phase-proof:v1\0",
);
const TOKEN_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken-root-session-phase-proof:token:v1\0",
);
const FIXTURE_URL = new URL(
  "./fixtures/root-session-phase-proof-v1.json",
  import.meta.url,
);

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function encodeJson(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function u64be(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function lengthPrefixed(domain, ...segments) {
  const parts = [domain, ...segments.flatMap((segment) => [u64be(segment.length), segment])];
  const byteLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

describe("RootSessionPhaseProofV1 fixed vector", () => {
  test("matches an independent WebCrypto implementation byte for byte", async () => {
    const fixture = await loadFixture();
    const protectedBytes = encodeJson(fixture.protected);
    const claimsBytes = encodeJson(fixture.claims);
    const protectedBase64url = base64url(protectedBytes);
    const claimsBase64url = base64url(claimsBytes);
    const protectedSegment = new TextEncoder().encode(protectedBase64url);
    const claimsSegment = new TextEncoder().encode(claimsBase64url);
    const signingInput = lengthPrefixed(
      SIGNATURE_DOMAIN,
      protectedSegment,
      claimsSegment,
    );
    const secret = Buffer.from(fixture.secret_hex, "hex");
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, signingInput),
    );
    const signatureBase64url = base64url(signature);
    const token = `${protectedBase64url}.${claimsBase64url}.${signatureBase64url}`;

    expect(signatureBase64url).toBe(fixture.signature_base64url);
    expect(JSON.parse(Buffer.from(protectedBase64url, "base64url"))).toEqual(
      fixture.protected,
    );
    expect(JSON.parse(Buffer.from(claimsBase64url, "base64url"))).toEqual(
      fixture.claims,
    );
    expect(base64url(Buffer.from(protectedBase64url, "base64url"))).toBe(
      protectedBase64url,
    );
    expect(base64url(Buffer.from(claimsBase64url, "base64url"))).toBe(
      claimsBase64url,
    );
    expect(
      await crypto.subtle.verify("HMAC", key, signature, signingInput),
    ).toBe(true);

    const tokenBytes = new TextEncoder().encode(token);
    const digestInput = lengthPrefixed(TOKEN_DIGEST_DOMAIN, tokenBytes);
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", digestInput),
    ).toString("hex");
    expect(digest).toBe(fixture.token_sha256);

    const tamperedSignature = signature.slice();
    tamperedSignature[0] ^= 0x01;
    expect(
      await crypto.subtle.verify("HMAC", key, tamperedSignature, signingInput),
    ).toBe(false);
  });
});
