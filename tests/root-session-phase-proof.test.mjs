import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SIGNATURE_DOMAIN = new TextEncoder().encode(
  "cinatoken-root-session-phase-proof:v1\0",
);
const TOKEN_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken-root-session-phase-proof:token:v1\0",
);
const PHASE_BINDING_DOMAIN = new TextEncoder().encode(
  "cinatoken-root-session-phase-proof:phase-binding:v1\0",
);
const BEGIN_INTENT_DOMAIN = new TextEncoder().encode(
  "cinatoken-relay-container-drain-source-registration-begin-intent-v1",
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

function u32be(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64be(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function lengthPrefixedU32(domain, ...segments) {
  const parts = [
    domain,
    ...segments.flatMap((segment) => [u32be(segment.length), segment]),
  ];
  const byteLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function lengthPrefixedU64(domain, ...segments) {
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

function commonPhaseSubject(fixture, contract, phase) {
  return {
    schema_version: 1,
    contract,
    phase,
    environment: fixture.claims.environment,
    operation_id_sha256: fixture.claims.operation_id_sha256,
    scope_kind: fixture.claims.scope_kind,
    scope_id_sha256: fixture.claims.scope_id_sha256,
    authorization_id_sha256: fixture.claims.authorization_id_sha256,
    ceremony_id_sha256: fixture.claims.ceremony_id_sha256,
    request_intent_sha256: fixture.claims.request_intent_sha256,
    semantic_authority_fingerprint_sha256:
      fixture.claims.semantic_authority_fingerprint_sha256,
  };
}

async function phaseBindingSha256(phase, canonicalJson) {
  const digestInput = lengthPrefixedU64(
    PHASE_BINDING_DOMAIN,
    new TextEncoder().encode(phase),
    new TextEncoder().encode(canonicalJson),
  );
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", digestInput),
  ).toString("hex");
}

describe("RootSessionPhaseProofV1 fixed vector", () => {
  test("derives the typed begin intent with explicit u32be framing", async () => {
    const fixture = await loadFixture();
    const vector = fixture.begin_intent;
    const fields = vector.fields;
    const expectedFieldOrder = [
      "contract",
      "action",
      "environment",
      "operation_id_sha256",
      "authorization_id_sha256",
      "ceremony_id_sha256",
      "request_intent_sha256",
      "rp_id",
      "origin",
      "issued_at",
      "action_digest_sha256",
      "registration_request_sha256",
      "admin_audit_digest_sha256",
      "admin_network_identity_hmac_sha256",
      "change_ticket_sha256",
      "reason_code",
      "verification_expires_at",
      "registered_by_service_name",
      "registered_by_version_id",
      "registration_execution_id_sha256",
      "registration_credential_id_sha256",
      "ceremony_nonce_sha256",
    ];
    const orderedFields = [
      fields.contract,
      fields.action,
      fields.environment,
      fields.operation_id_sha256,
      fields.authorization_id_sha256,
      fields.ceremony_id_sha256,
      fields.request_intent_sha256,
      fields.rp_id,
      fields.origin,
      String(fields.issued_at),
      fields.action_digest_sha256,
      fields.registration_request_sha256,
      fields.admin_audit_digest_sha256,
      fields.admin_network_identity_hmac_sha256,
      fields.change_ticket_sha256,
      fields.reason_code,
      String(fields.verification_expires_at),
      fields.registered_by_service_name,
      fields.registered_by_version_id,
      fields.registration_execution_id_sha256,
      fields.registration_credential_id_sha256,
      fields.ceremony_nonce_sha256,
    ].map((field) => new TextEncoder().encode(field));

    expect(vector.domain).toBe(
      "cinatoken-relay-container-drain-source-registration-begin-intent-v1",
    );
    expect(vector.length_prefix).toBe("u32be");
    expect(vector.field_order).toEqual(expectedFieldOrder);
    const message = lengthPrefixedU32(BEGIN_INTENT_DOMAIN, ...orderedFields);
    expect(message.length).toBe(vector.message_byte_length);
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", message),
    ).toString("hex");
    expect(digest).toBe(vector.sha256);
    expect(digest).toBe(fixture.before_challenge_subject.begin_intent_sha256);
  });

  test("derives the typed before-challenge subject independently", async () => {
    const fixture = await loadFixture();
    const vector = fixture.before_challenge_subject;
    const subject = {
      ...commonPhaseSubject(
        fixture,
        "relay-container-drain-source-registration-before-challenge-subject-v1",
        "before_challenge",
      ),
      begin_intent_sha256: vector.begin_intent_sha256,
      authorization_subject_sha256: vector.authorization_subject_sha256,
      authorization_signature_envelope_sha256:
        vector.authorization_signature_envelope_sha256,
    };
    const canonicalJson = JSON.stringify(subject);

    expect(canonicalJson).toBe(vector.canonical_json);
    expect(
      await phaseBindingSha256("before_challenge", canonicalJson),
    ).toBe(vector.phase_binding_sha256);
  });

  test("derives the typed before-issuer subject independently", async () => {
    const fixture = await loadFixture();
    const vector = fixture.before_issuer_subject;
    const subject = {
      ...commonPhaseSubject(
        fixture,
        "relay-container-drain-source-registration-before-issuer-subject-v1",
        "before_issuer",
      ),
      secure_verification_challenge_sha256:
        vector.secure_verification_challenge_sha256,
      action_subject_sha256: vector.action_subject_sha256,
      permit_issue_request_sha256: vector.permit_issue_request_sha256,
    };
    const canonicalJson = JSON.stringify(subject);

    expect(canonicalJson).toBe(vector.canonical_json);
    expect(await phaseBindingSha256("before_issuer", canonicalJson)).toBe(
      vector.phase_binding_sha256,
    );
  });

  test("derives the typed before-commit subject independently", async () => {
    const fixture = await loadFixture();
    const subject = {
      ...commonPhaseSubject(
        fixture,
        "relay-container-drain-source-registration-before-commit-subject-v1",
        "before_commit",
      ),
      action_subject_sha256:
        fixture.before_commit_subject.action_subject_sha256,
      issuer_request_sha256:
        fixture.before_commit_subject.issuer_request_sha256,
      authenticated_issuer_request_id_sha256:
        fixture.before_commit_subject.authenticated_issuer_request_id_sha256,
      issuer_version_id: fixture.before_commit_subject.issuer_version_id,
      permit_id_sha256: fixture.before_commit_subject.permit_id_sha256,
      permit_subject_sha256:
        fixture.before_commit_subject.permit_subject_sha256,
      permit_signature_envelope_sha256:
        fixture.before_commit_subject.permit_signature_envelope_sha256,
    };
    const canonicalJson = JSON.stringify(subject);
    expect(canonicalJson).toBe(
      fixture.before_commit_subject.canonical_json,
    );
    const digest = await phaseBindingSha256("before_commit", canonicalJson);
    expect(digest).toBe(fixture.claims.phase_binding_sha256);
  });

  test("matches an independent WebCrypto implementation byte for byte", async () => {
    const fixture = await loadFixture();
    const protectedBytes = encodeJson(fixture.protected);
    const claimsBytes = encodeJson(fixture.claims);
    const protectedBase64url = base64url(protectedBytes);
    const claimsBase64url = base64url(claimsBytes);
    const protectedSegment = new TextEncoder().encode(protectedBase64url);
    const claimsSegment = new TextEncoder().encode(claimsBase64url);
    const signingInput = lengthPrefixedU64(
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
    const digestInput = lengthPrefixedU64(TOKEN_DIGEST_DOMAIN, tokenBytes);
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
