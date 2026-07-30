import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

const currentSecret = "registration-coordinator-current-runtime-secret-v1";
const previousSecret = "registration-coordinator-previous-runtime-secret-v0";
const currentKid = "registration-coordinator-runtime-v1";
const previousKid = "registration-coordinator-runtime-v0";
const currentCallerIdentity = "7a".repeat(32);
const authorityIssuer = "cinatoken-application-runtime-test";
const authorityAudience =
  "drain-source-registration-coordinator-runtime-test";
const authorityType =
  "CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR";
const authorityDomain =
  "cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:";
const objectNameDomain =
  "cinatoken:relay-container:drain-source-registration:coordinator-object:v1";
const stateKey = "drain_source_registration_coordinator_state_v1";
const eventPrefix = "event:v1:";
const replayPrefix = "request:v1:";

const identity = Object.freeze({
  authorization_id_sha256: digest("a"),
  contract_version: 1,
  environment: "local",
  operation_id_sha256: digest("b"),
  root_user_id: "42",
  scope_id_sha256: digest("c"),
  scope_kind: "global",
});

describe.sequential("drain-source registration coordinator Durable Object", () => {
  async function concurrencyScenario() {
    const objectName = await coordinatorObjectName(identity);
    expect(objectName).toBe(
      "drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce",
    );
    const stub = env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(
      objectName,
    );
    const begin = beginRequest(digest("3"), Date.now() + 60_000);
    const init = await signedRequestInit("/v1/begin", begin, objectName);
    const responses = await Promise.all(
      Array.from({ length: 32 }, () =>
        stub.fetch("https://registration-coordinator.internal/v1/begin", init),
      ),
    );
    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);
    expect(statuses.filter((status) => status === 200)).toHaveLength(31);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies.filter((body) => body.replayed)).toHaveLength(31);
    for (const body of bodies) {
      expect(body).toMatchObject({
        event_count: 1,
        generation: 1,
        operation_id_sha256: identity.operation_id_sha256,
        phase: "challenge_issued",
        terminal: false,
      });
    }

    const divergent = {
      ...begin,
      evidence: {
        ...begin.evidence,
        challenge_sha256: digest("4"),
      },
    };
    const conflict = await signedFetch(
      stub,
      "/v1/begin",
      divergent,
      objectName,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      code: "coordinator_state_conflict",
      contract_version: 1,
    });

    const statusRequest = {
      command: "status",
      identity,
      request_id_sha256: digest("5"),
    };
    const previousKeyStatus = await signedFetch(
      stub,
      "/v1/status",
      statusRequest,
      objectName,
      {
        kid: previousKid,
        secret: previousSecret,
      },
    );
    expect(previousKeyStatus.status).toBe(200);
    expect(await previousKeyStatus.json()).toMatchObject({
      generation: 1,
      phase: "challenge_issued",
    });

    const wrongObject = await signedFetch(
      stub,
      "/v1/status",
      { ...statusRequest, request_id_sha256: digest("6") },
      `drain-source-registration-coordinator-v1:${digest("f")}`,
    );
    await expectStatus(wrongObject, 403);

    await forceDeadlineIntoPast(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  }

  it("recovers a lost finish response across eviction without replaying work", async () => {
    const recoveryIdentity = {
      ...identity,
      operation_id_sha256: digest("4"),
    };
    const objectName = await coordinatorObjectName(recoveryIdentity);
    const stub = env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(
      objectName,
    );
    const finish = (command, generation, requestId, evidence) =>
      finishRequest(
        command,
        generation,
        requestId,
        evidence,
        recoveryIdentity,
      );
    const began = await signedFetch(
      stub,
      "/v1/begin",
      beginRequest(
        digest("0"),
        Date.now() + 60_000,
        recoveryIdentity,
      ),
      objectName,
    );
    await expectStatus(began, 201);

    const claim = finish(
      "claim_finish",
      1,
      digest("a"),
      {
        assertion_envelope_sha256: digest("5"),
        finish_claim_id_sha256: digest("6"),
      },
    );
    const claimInit = await signedRequestInit(
      "/v1/finish",
      claim,
      objectName,
    );
    const lostResponse = await stub.fetch(
      "https://registration-coordinator.internal/v1/finish",
      claimInit,
    );
    // Discard the result while draining the stream so eviction has no live I/O.
    await expectStatus(lostResponse, 200);

    const claimReplay = await stub.fetch(
      "https://registration-coordinator.internal/v1/finish",
      claimInit,
    );
    expect(claimReplay.status).toBe(200);
    expect(await claimReplay.json()).toMatchObject({
      generation: 2,
      phase: "finish_claimed",
      replayed: true,
    });

    await expectPhase(
      await signedFetch(
        stub,
        "/v1/finish",
        finish("record_proof", 2, digest("b"), {
          passkey_assertion_signature_sha256: digest("7"),
          passkey_state_transition_sha256: digest("8"),
          verified_passkey_proof_sha256: digest("9"),
        }),
        objectName,
      ),
      3,
      "proof_verified",
    );
    await expectPhase(
      await signedFetch(
        stub,
        "/v1/finish",
        finish("freeze_permit_request", 3, digest("c"), {
          issuer_auth_key_id_sha256: digest("0"),
          issuer_phase_proof_sha256: digest("a"),
          issuer_request_id_sha256: digest("b"),
          issuer_request_sha256: digest("c"),
        }),
        objectName,
      ),
      4,
      "permit_request_frozen",
    );
    await expectPhase(
      await signedFetch(
        stub,
        "/v1/finish",
        finish("record_permit", 4, digest("d"), {
          issuer_version_sha256: digest("d"),
          permit_id_sha256: digest("e"),
          permit_signature_envelope_sha256: digest("f"),
          permit_subject_sha256: digest("1"),
        }),
        objectName,
      ),
      5,
      "permit_verified",
    );
    await expectPhase(
      await signedFetch(
        stub,
        "/v1/finish",
        finish("record_commit_attempt", 5, digest("e"), {
          command_body_sha256: digest("2"),
          command_id_sha256: digest("3"),
          commit_phase_proof_sha256: digest("4"),
        }),
        objectName,
      ),
      6,
      "commit_attempted",
    );
    const unknown = await signedFetch(
      stub,
      "/v1/finish",
      finish("record_outcome", 6, digest("f"), {
        authoritative_readback_sha256: digest("5"),
        command_id_sha256: digest("3"),
        outcome: "outcome_unknown",
        winner_command_id_sha256: null,
      }),
      objectName,
    );
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toMatchObject({
      generation: 7,
      phase: "recovery_pending",
      terminal: false,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await evictDurableObject(stub);
    const afterEviction = await coordinatorStatus(
      stub,
      objectName,
      digest("2"),
      recoveryIdentity,
    );
    expect(afterEviction.status).toBe(200);
    expect(await afterEviction.json()).toMatchObject({
      event_count: 7,
      generation: 7,
      phase: "recovery_pending",
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const events = await state.storage.list({ prefix: eventPrefix });
      const requests = await state.storage.list({ prefix: replayPrefix });
      const stored = await state.storage.get(stateKey);
      expect(events.size).toBe(7);
      expect(requests.size).toBe(7);
      expect(JSON.stringify(stored)).not.toContain("raw-cookie");
      expect(JSON.stringify(stored)).not.toContain("raw-assertion");
      expect(JSON.stringify(stored)).not.toContain("private-key");
    });

    const recover = {
      command: "recover",
      evidence: {
        authoritative_readback_sha256: digest("6"),
        command_id_sha256: digest("3"),
        outcome: "fresh_applied",
        winner_command_id_sha256: digest("3"),
      },
      expected_generation: 7,
      identity: recoveryIdentity,
      request_id_sha256: digest("1"),
    };
    const recoverInit = await signedRequestInit(
      "/v1/recover",
      recover,
      objectName,
    );
    const recovered = await stub.fetch(
      "https://registration-coordinator.internal/v1/recover",
      recoverInit,
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      event_count: 8,
      generation: 8,
      phase: "applied",
      replayed: false,
      terminal: true,
    });
    const recoverReplay = await stub.fetch(
      "https://registration-coordinator.internal/v1/recover",
      recoverInit,
    );
    expect(recoverReplay.status).toBe(200);
    expect(await recoverReplay.json()).toMatchObject({
      generation: 8,
      phase: "applied",
      replayed: true,
    });

    await evictDurableObject(stub);
    const terminalStatus = await coordinatorStatus(
      stub,
      objectName,
      digest("4"),
      recoveryIdentity,
    );
    expect(await terminalStatus.json()).toMatchObject({
      event_count: 8,
      generation: 8,
      phase: "applied",
      terminal: true,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        (await state.storage.list({ prefix: eventPrefix })).size,
      ).toBe(8);
    });
  }, 60_000);

  it(
    "serializes concurrent begin, exact replay, and conflicting reuse",
    concurrencyScenario,
  );

  it("expires precommit work and converts an uncertain commit into recovery", async () => {
    const expiringIdentity = {
      ...identity,
      operation_id_sha256: digest("d"),
    };
    const expiringName = await coordinatorObjectName(expiringIdentity);
    const expiringStub =
      env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(expiringName);
    await expectStatus(
      await signedFetch(
        expiringStub,
        "/v1/begin",
        beginRequest(digest("0"), Date.now() + 60_000, expiringIdentity),
        expiringName,
      ),
      201,
    );
    await forceDeadlineIntoPast(expiringStub);
    expect(await runDurableObjectAlarm(expiringStub)).toBe(true);
    const expiredStatus = await coordinatorStatus(
      expiringStub,
      expiringName,
      digest("1"),
      expiringIdentity,
    );
    expect(await expiredStatus.json()).toMatchObject({
      event_count: 2,
      generation: 2,
      phase: "expired",
      terminal: true,
    });
    const rejectedFinish = await signedFetch(
      expiringStub,
      "/v1/finish",
      finishRequest(
        "claim_finish",
        1,
        digest("2"),
        {
          assertion_envelope_sha256: digest("3"),
          finish_claim_id_sha256: digest("4"),
        },
        expiringIdentity,
      ),
      expiringName,
    );
    await expectStatus(rejectedFinish, 410);

    const uncertainIdentity = {
      ...identity,
      operation_id_sha256: digest("e"),
    };
    const uncertainName = await coordinatorObjectName(uncertainIdentity);
    const uncertainStub =
      env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(uncertainName);
    await advanceThroughCommitAttempt(
      uncertainStub,
      uncertainName,
      uncertainIdentity,
    );
    await forceDeadlineIntoPast(uncertainStub);
    expect(await runDurableObjectAlarm(uncertainStub)).toBe(true);
    const pending = await coordinatorStatus(
      uncertainStub,
      uncertainName,
      digest("f"),
      uncertainIdentity,
    );
    expect(await pending.json()).toMatchObject({
      event_count: 7,
      generation: 7,
      outcome: {
        command_id_sha256: digest("3"),
        outcome: "outcome_unknown",
        winner_command_id_sha256: null,
      },
      phase: "recovery_pending",
      terminal: false,
    });
    const recovered = await signedFetch(
      uncertainStub,
      "/v1/recover",
      {
        command: "recover",
        evidence: {
          authoritative_readback_sha256: digest("5"),
          command_id_sha256: digest("3"),
          outcome: "exact_replay",
          winner_command_id_sha256: digest("3"),
        },
        expected_generation: 7,
        identity: uncertainIdentity,
        request_id_sha256: digest("f"),
      },
      uncertainName,
    );
    expect(await recovered.json()).toMatchObject({
      generation: 8,
      phase: "exact_replay",
      terminal: true,
    });
  });

  it("fails closed with a structured response for corrupt durable state", async () => {
    const corruptIdentity = {
      ...identity,
      operation_id_sha256: digest("6"),
    };
    const objectName = await coordinatorObjectName(corruptIdentity);
    const stub = env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(
      objectName,
    );
    await expectStatus(
      await signedFetch(
        stub,
        "/v1/begin",
        beginRequest(digest("7"), Date.now() + 60_000, corruptIdentity),
        objectName,
      ),
      201,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = await state.storage.get(stateKey);
      stored.contract_version = "corrupt";
      await state.storage.put(stateKey, stored);
    });

    const response = await coordinatorStatus(
      stub,
      objectName,
      digest("8"),
      corruptIdentity,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "coordinator_storage_unavailable",
      contract_version: 1,
    });
  });

  it("fails closed on stale authority, noncanonical JSON, and body limits", async () => {
    const validationIdentity = {
      ...identity,
      operation_id_sha256: digest("5"),
    };
    const objectName = await coordinatorObjectName(validationIdentity);
    const stub = env.DRAIN_SOURCE_REGISTRATION_COORDINATORS.getByName(
      objectName,
    );
    const begin = beginRequest(
      digest("0"),
      Date.now() + 60_000,
      validationIdentity,
    );
    const stale = await signedFetch(
      stub,
      "/v1/begin",
      begin,
      objectName,
      {
        expiresAt: Math.floor(Date.now() / 1_000) - 30,
        issuedAt: Math.floor(Date.now() / 1_000) - 60,
      },
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({
      code: "authority_time_window",
      contract_version: 1,
    });

    const noncanonicalBody = JSON.stringify(begin, null, 2);
    const noncanonical = await signedFetch(
      stub,
      "/v1/begin",
      begin,
      objectName,
      { body: noncanonicalBody },
    );
    expect(noncanonical.status).toBe(400);
    expect(await noncanonical.json()).toEqual({
      code: "invalid_canonical_json",
      contract_version: 1,
    });

    const oversized = await stub.fetch(
      "https://registration-coordinator.internal/v1/begin",
      {
        body: `"${"x".repeat(17 * 1024)}"`,
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    await expectStatus(oversized, 413);

    const wrongContentType = await stub.fetch(
      "https://registration-coordinator.internal/v1/begin",
      {
        body: canonicalJson(begin),
        headers: {
          "content-type": "text/plain",
        },
        method: "POST",
      },
    );
    await expectStatus(wrongContentType, 415);
  });
});

async function advanceThroughCommitAttempt(stub, objectName, targetIdentity) {
  await expectStatus(
    await signedFetch(
      stub,
      "/v1/begin",
      beginRequest(digest("0"), Date.now() + 60_000, targetIdentity),
      objectName,
    ),
    201,
  );
  const transitions = [
    [
      "claim_finish",
      {
        assertion_envelope_sha256: digest("5"),
        finish_claim_id_sha256: digest("6"),
      },
    ],
    [
      "record_proof",
      {
        passkey_assertion_signature_sha256: digest("7"),
        passkey_state_transition_sha256: digest("8"),
        verified_passkey_proof_sha256: digest("9"),
      },
    ],
    [
      "freeze_permit_request",
      {
        issuer_auth_key_id_sha256: digest("0"),
        issuer_phase_proof_sha256: digest("a"),
        issuer_request_id_sha256: digest("b"),
        issuer_request_sha256: digest("c"),
      },
    ],
    [
      "record_permit",
      {
        issuer_version_sha256: digest("d"),
        permit_id_sha256: digest("e"),
        permit_signature_envelope_sha256: digest("f"),
        permit_subject_sha256: digest("1"),
      },
    ],
    [
      "record_commit_attempt",
      {
        command_body_sha256: digest("2"),
        command_id_sha256: digest("3"),
        commit_phase_proof_sha256: digest("4"),
      },
    ],
  ];
  for (const [index, [command, evidence]] of transitions.entries()) {
    const response = await signedFetch(
      stub,
      "/v1/finish",
      finishRequest(
        command,
        index + 1,
        digest(String((index + 5) % 10)),
        evidence,
        targetIdentity,
      ),
      objectName,
    );
    await expectStatus(response, 200);
  }
}

async function forceDeadlineIntoPast(stub) {
  await runInDurableObject(stub, async (_instance, state) => {
    const stored = await state.storage.get(stateKey);
    stored.expires_at_ms = stored.created_at_ms + 1;
    await state.storage.put(stateKey, stored);
  });
  await delay(5);
}

function beginRequest(requestId, expiresAtMs, targetIdentity = identity) {
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
    identity: targetIdentity,
    request_id_sha256: requestId,
  };
}

function finishRequest(
  command,
  expectedGeneration,
  requestId,
  evidence,
  targetIdentity = identity,
) {
  return {
    command,
    evidence,
    expected_generation: expectedGeneration,
    identity: targetIdentity,
    request_id_sha256: requestId,
  };
}

async function coordinatorStatus(
  stub,
  objectName,
  requestId,
  targetIdentity = identity,
) {
  return signedFetch(
    stub,
    "/v1/status",
    {
      command: "status",
      identity: targetIdentity,
      request_id_sha256: requestId,
    },
    objectName,
  );
}

async function expectPhase(response, generation, phase) {
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    generation,
    phase,
    replayed: false,
  });
}

async function expectStatus(response, status) {
  expect(response.status).toBe(status);
  await response.arrayBuffer();
}

async function signedFetch(
  stub,
  path,
  payload,
  objectName,
  options = {},
) {
  const init = await signedRequestInit(path, payload, objectName, options);
  return stub.fetch(`https://registration-coordinator.internal${path}`, init);
}

async function signedRequestInit(
  path,
  payload,
  objectName,
  {
    body = canonicalJson(payload),
    callerIdentity = currentCallerIdentity,
    expiresAt,
    issuedAt,
    kid = currentKid,
    secret = currentSecret,
  } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
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
        audience: authorityAudience,
        body_sha256: await sha256Hex(new TextEncoder().encode(body)),
        caller_identity_sha256: callerIdentity,
        expires_at: expiresAt ?? now + 30,
        issued_at: issuedAt ?? now,
        issuer: authorityIssuer,
        method: "POST",
        object_name: objectName,
        path,
        request_id_sha256: payload.request_id_sha256,
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
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-cinatoken-drain-source-registration-coordinator-authority":
        `${headerPart}.${claimsPart}.${base64Url(signature)}`,
    },
    method: "POST",
  };
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
