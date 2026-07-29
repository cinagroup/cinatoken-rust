import { describe, expect, test } from "bun:test";

import {
  CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_HEADER,
  CONTROLLER_DRAIN_ATTESTATION_CONTRACT,
  CONTROLLER_DRAIN_ATTESTATION_PATH,
  CONTROLLER_DRAIN_ATTESTATION_ROLE,
  CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT,
  controllerDrainAttestationCredentialIdSha256,
  createControllerDrainAttestationAuthorityTokenForTest,
  handleControllerDrainAttestationRequest,
  verifyControllerDrainAttestationRequest,
  type ControllerDrainAttestationAuthorityClaims,
  type ControllerDrainAttestationEnvironment,
  type ShardDrainSnapshot,
} from "../src/container_drain_attestation";

const NOW = 1_900_000_000;
const CURRENT_KID = "drain-attestation-v1";
const PREVIOUS_KID = "drain-attestation-v0";
const CURRENT_SIGNING_MATERIAL = "c".repeat(48);
const PREVIOUS_SIGNING_MATERIAL = "p".repeat(48);
const REQUEST_ID = "1".repeat(64);
const OTHER_REQUEST_ID = "2".repeat(64);
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DRAIN_AUTHORITY_DOMAIN =
  "cinatoken:container-controller:drain-attestation-authority:v1\0";
const DISABLE_AUTHORITY_DOMAIN =
  "cinatoken:container-controller:disable-attestation-authority:v1\0";

const baseEnv = {
  CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_ISSUER:
    "cinatoken-drain-authority-test",
  CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_AUDIENCE:
    "cinatoken-container-controller-drain-test",
  CONTROLLER_DRAIN_ATTESTATION_CURRENT_KID: CURRENT_KID,
  CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_KID: "",
  CONTROLLER_DRAIN_ATTESTATION_CURRENT_SECRET:
    CURRENT_SIGNING_MATERIAL,
  CONTAINER_CONTROLLER_SERVICE_NAME:
    "cinatoken-container-controller-test",
  CF_VERSION_METADATA: { id: "controller-version-drain-1" },
} satisfies ControllerDrainAttestationEnvironment;

describe("Controller accepted-work drain attestation", () => {
  test("accepts current and previous keys from the independent drain keyring", async () => {
    const current = await handleControllerDrainAttestationRequest(
      await signedRequest(),
      baseEnv,
      drainedSnapshots(),
      NOW,
    );
    expect(current.status).toBe(200);

    const previousEnv: ControllerDrainAttestationEnvironment = {
      ...baseEnv,
      CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_KID: PREVIOUS_KID,
      CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_SECRET:
        PREVIOUS_SIGNING_MATERIAL,
    };
    const previous = await handleControllerDrainAttestationRequest(
      requestWithToken(
        await token(
          PREVIOUS_KID,
          PREVIOUS_SIGNING_MATERIAL,
        ),
      ),
      previousEnv,
      drainedSnapshots(),
      NOW,
    );
    expect(previous.status).toBe(200);
    expect(await previous.json()).toMatchObject({
      contract: CONTROLLER_DRAIN_ATTESTATION_CONTRACT,
      request_id_sha256: REQUEST_ID,
    });
  });

  test("rejects signatures from the disable domain or another role even with identical key material", async () => {
    const valid = await token();
    const wrongDomain = await resignToken(
      valid,
      DISABLE_AUTHORITY_DOMAIN,
      CONTROLLER_DRAIN_ATTESTATION_ROLE,
      CURRENT_SIGNING_MATERIAL,
    );
    const wrongRole = await resignToken(
      valid,
      DRAIN_AUTHORITY_DOMAIN,
      "disable_attestation",
      CURRENT_SIGNING_MATERIAL,
    );

    for (const candidate of [wrongDomain, wrongRole]) {
      const response = await handleControllerDrainAttestationRequest(
        requestWithToken(candidate),
        baseEnv,
        drainedSnapshots(),
        NOW,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "invalid_controller_drain_attestation_authority",
      });
    }
  });

  test("binds canonical claims to POST, the exact private path, and a strict empty transport", async () => {
    const verified = await verifyControllerDrainAttestationRequest(
      await signedRequest(),
      baseEnv,
      NOW,
    );
    expect(verified.claims).toEqual(await claims(CURRENT_KID));

    const invalidRequests = [
      new Request(
        `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}`,
        {
          method: "GET",
          headers: authHeaders(await token()),
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}?probe=1`,
        {
          method: "POST",
          headers: authHeaders(await token()),
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}`,
        {
          method: "POST",
          headers: {
            ...authHeaders(await token()),
            "content-type": "application/json",
          },
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}`,
        {
          method: "POST",
          headers: authHeaders(await token()),
          body: new Uint8Array([1]),
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}`,
        {
          method: "POST",
          headers: {
            ...authHeaders(await token()),
            "content-length": "1",
          },
        },
      ),
    ];

    for (const request of invalidRequests) {
      const response = await handleControllerDrainAttestationRequest(
        request,
        baseEnv,
        drainedSnapshots(),
        NOW,
      );
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
    }
  });

  test("rejects expired and overlong authority windows", async () => {
    const expiredClaims = {
      ...(await claims(CURRENT_KID)),
      expires_at: NOW,
    };
    const expired = await handleControllerDrainAttestationRequest(
      requestWithToken(
        await createControllerDrainAttestationAuthorityTokenForTest(
          CURRENT_SIGNING_MATERIAL,
          CURRENT_KID,
          expiredClaims,
        ),
      ),
      baseEnv,
      drainedSnapshots(),
      NOW,
    );
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({
      error: "controller_drain_attestation_authority_expired",
    });

    const overlongClaims = {
      ...(await claims(CURRENT_KID)),
      expires_at: NOW + 31,
    };
    const overlong = await handleControllerDrainAttestationRequest(
      requestWithToken(
        await createControllerDrainAttestationAuthorityTokenForTest(
          CURRENT_SIGNING_MATERIAL,
          CURRENT_KID,
          overlongClaims,
        ),
      ),
      baseEnv,
      drainedSnapshots(),
      NOW,
    );
    expect(overlong.status).toBe(403);
    expect(await overlong.json()).toEqual({
      error:
        "controller_drain_attestation_authority_time_window",
    });
  });

  test("rejects noncanonical JWT JSON and signature tampering", async () => {
    const noncanonical =
      await createControllerDrainAttestationAuthorityTokenForTest(
        CURRENT_SIGNING_MATERIAL,
        CURRENT_KID,
        await claims(CURRENT_KID),
        false,
      );
    const valid = await token();
    const [headerPart, claimsPart, signaturePart] = valid.split(".");
    const tamperedSignature = `${
      signaturePart[0] === "A" ? "B" : "A"
    }${signaturePart.slice(1)}`;
    const tampered = `${headerPart}.${claimsPart}.${tamperedSignature}`;

    for (const candidate of [noncanonical, tampered]) {
      const response = await handleControllerDrainAttestationRequest(
        requestWithToken(candidate),
        baseEnv,
        drainedSnapshots(),
        NOW,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "invalid_controller_drain_attestation_authority",
      });
    }
  });

  test("fails closed for missing, duplicate, divergent, wrong, or uninitialized shards", async () => {
    const missing = drainedSnapshots().slice(0, 7);

    const duplicate = drainedSnapshots();
    duplicate[7] = {
      ...duplicate[7],
      shard_index: 6,
      instance_name: instanceName(6),
    };

    const divergent = drainedSnapshots();
    divergent[4] = {
      ...divergent[4],
      ring_generation: 8,
    };

    const wrong = drainedSnapshots();
    wrong[3] = {
      ...wrong[3],
      instance_name: instanceName(2),
    };

    const uninitialized = drainedSnapshots();
    uninitialized[1] = {
      ...uninitialized[1],
      initialized: false,
    };

    for (const snapshots of [
      missing,
      duplicate,
      divergent,
      wrong,
      uninitialized,
    ]) {
      const response = await handleControllerDrainAttestationRequest(
        await signedRequest(),
        baseEnv,
        snapshots,
        NOW,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(
          /^controller_drain_attestation_(?:shard_set|snapshot)_invalid$/,
        ),
      });
    }
  });

  test("fails closed when count partitions, relationships, or supplied booleans disagree", async () => {
    const countMismatch = drainedSnapshots();
    countMismatch[0] = {
      ...countMismatch[0],
      claimed_operations: 1,
    };

    const stopBooleanMismatch = drainedSnapshots();
    stopBooleanMismatch[1] = {
      ...stopBooleanMismatch[1],
      execution_stop_eligible: false,
    };

    const drainBooleanMismatch = drainedSnapshots();
    drainBooleanMismatch[2] = {
      ...drainBooleanMismatch[2],
      accepted_work_drained: false,
    };

    const partitionMismatch = drainedSnapshots();
    partitionMismatch[3] = {
      ...partitionMismatch[3],
      expired_running_operations: 1,
    };

    const orphanAttempt = drainedSnapshots();
    orphanAttempt[4] = {
      ...orphanAttempt[4],
      accepted_work_drained: false,
      execution_stop_eligible: false,
      prepared_provider_attempts: 1,
    };

    const unknownOperation = drainedSnapshots();
    unknownOperation[5] = {
      ...unknownOperation[5],
      unclassified_operations: 1,
    };

    for (const snapshots of [
      countMismatch,
      stopBooleanMismatch,
      drainBooleanMismatch,
      partitionMismatch,
      orphanAttempt,
      unknownOperation,
    ]) {
      const response = await handleControllerDrainAttestationRequest(
        await signedRequest(),
        baseEnv,
        snapshots,
        NOW,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "controller_drain_attestation_snapshot_invalid",
      });
    }
  });

  test("reports every shard stop-eligible while refusing a false accepted-work drain claim", async () => {
    const snapshots = drainedSnapshots();
    snapshots[5] = {
      ...snapshots[5],
      accepted_work_drained: false,
      ambiguous_provider_attempts: 1,
      recovery_required_operations: 1,
    };

    const response = await handleControllerDrainAttestationRequest(
      await signedRequest(),
      baseEnv,
      snapshots,
      NOW,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.execution_stop_eligible_all).toBe(true);
    expect(body.accepted_work_drained_all).toBe(false);
    expect(body.traffic_return_authorized).toBe(false);
    expect(body.snapshots[5]).toMatchObject({
      accepted_work_drained: false,
      execution_stop_eligible: true,
      recovery_required_operations: 1,
      ambiguous_provider_attempts: 1,
    });
  });

  test("returns a canonical all-drained response with sorted shards and a request-independent state digest", async () => {
    const accessed = new Set<PropertyKey>();
    const env = new Proxy(baseEnv, {
      get(target, property, receiver) {
        accessed.add(property);
        return Reflect.get(target, property, receiver);
      },
    });
    const reversed = drainedSnapshots().reverse();
    const first = await handleControllerDrainAttestationRequest(
      await signedRequest(),
      env,
      reversed,
      NOW,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    const firstText = await first.text();
    const firstBody = JSON.parse(firstText);

    const second = await handleControllerDrainAttestationRequest(
      requestWithToken(
        await token(
          CURRENT_KID,
          CURRENT_SIGNING_MATERIAL,
          OTHER_REQUEST_ID,
        ),
      ),
      env,
      drainedSnapshots(),
      NOW,
    );
    const secondBody = await second.json();
    const firstStateDigest = firstBody.state_digest_sha256;

    expect(firstText).toBe(canonicalJson(firstBody));
    expect(firstStateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(firstBody).toMatchObject({
      accepted_work_drained_all: true,
      contract: CONTROLLER_DRAIN_ATTESTATION_CONTRACT,
      controller_service_name:
        baseEnv.CONTAINER_CONTROLLER_SERVICE_NAME,
      controller_version_id: baseEnv.CF_VERSION_METADATA.id,
      execution_stop_eligible_all: true,
      request_id_sha256: REQUEST_ID,
      ring_generation: 7,
      schema_version: 1,
      shard_count: CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT,
      traffic_return_authorized: false,
    });
    expect(
      firstBody.snapshots.map(
        (snapshot: ShardDrainSnapshot) => snapshot.shard_index,
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(secondBody.request_id_sha256).toBe(OTHER_REQUEST_ID);
    expect(secondBody.state_digest_sha256).toBe(
      firstStateDigest,
    );
    expect(firstBody).not.toHaveProperty("action_gates");
    expect(firstBody).not.toHaveProperty("authorized");
    expect([...accessed].map(String)).not.toEqual(
      expect.arrayContaining([
        "DB",
        "RELAY_SHARDS",
        "CONFIG_KV",
        "FILE_BUCKET",
        "PROVIDER_EGRESS",
        "CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED",
      ]),
    );
  });
});

async function signedRequest(): Promise<Request> {
  return requestWithToken(await token());
}

function requestWithToken(value: string): Request {
  return new Request(
    `https://controller.internal${CONTROLLER_DRAIN_ATTESTATION_PATH}`,
    {
      method: "POST",
      headers: authHeaders(value),
    },
  );
}

function authHeaders(value: string): Record<string, string> {
  return {
    [CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_HEADER]: value,
  };
}

async function token(
  kid = CURRENT_KID,
  signingMaterial = CURRENT_SIGNING_MATERIAL,
  requestIdSha256 = REQUEST_ID,
): Promise<string> {
  return createControllerDrainAttestationAuthorityTokenForTest(
    signingMaterial,
    kid,
    await claims(kid, requestIdSha256),
  );
}

async function claims(
  kid: string,
  requestIdSha256 = REQUEST_ID,
): Promise<ControllerDrainAttestationAuthorityClaims> {
  return {
    audience:
      baseEnv.CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_AUDIENCE,
    authority_version: 1,
    body_sha256: EMPTY_SHA256,
    credential_id_sha256:
      await controllerDrainAttestationCredentialIdSha256(kid),
    expires_at: NOW + 30,
    issued_at: NOW,
    issuer:
      baseEnv.CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_ISSUER,
    method: "POST",
    path_and_query: CONTROLLER_DRAIN_ATTESTATION_PATH,
    request_id_sha256: requestIdSha256,
    role: CONTROLLER_DRAIN_ATTESTATION_ROLE,
  };
}

function drainedSnapshots(): ShardDrainSnapshot[] {
  return Array.from(
    { length: CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT },
    (_, shardIndex) => drainedSnapshot(shardIndex),
  );
}

function drainedSnapshot(shardIndex: number): ShardDrainSnapshot {
  return {
    active_claimed_operations: 0,
    active_provider_retries: 0,
    active_running_operations: 0,
    accepted_work_drained: true,
    ambiguous_provider_attempts: 0,
    claimed_operations: 0,
    completed_operations_missing_final_ack: 0,
    contract_version: 1,
    dispatched_provider_attempts: 0,
    execution_stop_eligible: true,
    expired_claimed_operations: 0,
    expired_running_operations: 0,
    failed_operations_missing_final_ack: 0,
    initialized: true,
    instance_name: instanceName(shardIndex),
    lifecycle_detail: null,
    lifecycle_state: "draining",
    lifecycle_updated_at: NOW - 1,
    pending_alarm_intents: 0,
    prepared_provider_attempts: 0,
    recovery_required_operations: 0,
    ring_generation: 7,
    running_operations: 0,
    shard_count: CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT,
    shard_index: shardIndex,
    unclassified_operations: 0,
    waiting_provider_retries: 0,
  };
}

function instanceName(shardIndex: number): string {
  return `cinatoken-relay-shard-v1-${shardIndex
    .toString()
    .padStart(4, "0")}`;
}

async function resignToken(
  tokenValue: string,
  domain: string,
  role: string,
  signingMaterial: string,
): Promise<string> {
  const [headerPart, claimsPart] = tokenValue.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new TextEncoder().encode(
    `${domain}${role}\0${headerPart}.${claimsPart}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signed),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalValue(record[key])]),
  );
}
