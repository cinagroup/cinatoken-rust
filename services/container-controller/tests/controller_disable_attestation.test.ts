import { describe, expect, test } from "bun:test";

import {
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER,
  CONTROLLER_DISABLE_ATTESTATION_CONTRACT,
  CONTROLLER_DISABLE_ATTESTATION_PATH,
  CONTROLLER_DISABLE_ATTESTATION_ROLE,
  controllerDisableAttestationCredentialIdSha256,
  createControllerDisableAttestationAuthorityTokenForTest,
  handleControllerDisableAttestationRequest,
  verifyControllerDisableAttestationRequest,
  type ControllerDisableAttestationAuthorityClaims,
  type ControllerDisableAttestationEnvironment,
} from "../src/controller_disable_attestation";
import {
  SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES,
  campaignActionGateInventory,
} from "../src/shard_activation_campaign";

const NOW = 1_900_000_000;
const CURRENT_KID = "disable-attestation-v1";
const CURRENT_SECRET =
  "disable-attestation-current-secret-0123456789abcdef";
const PREVIOUS_KID = "disable-attestation-v0";
const PREVIOUS_SECRET =
  "disable-attestation-previous-secret-0123456789abcdef";
const REQUEST_ID = "a".repeat(64);
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const baseEnv = {
  ...disabledActionGates(),
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER:
    "cinatoken-shard-placement-authority-test",
  CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE:
    "cinatoken-container-controller-test",
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_KID: CURRENT_KID,
  CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: "",
  CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: CURRENT_SECRET,
  CONTAINER_CONTROLLER_SERVICE_NAME:
    "cinatoken-container-controller-test",
  CF_VERSION_METADATA: { id: "controller-version-55" },
} satisfies ControllerDisableAttestationEnvironment;

describe("operation-14 Controller disable attestation", () => {
  test("returns the exact canonical disabled contract and complete shared action-gate inventory", async () => {
    const accessed = new Set<PropertyKey>();
    const env = new Proxy(baseEnv, {
      get(target, property, receiver) {
        accessed.add(property);
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await handleControllerDisableAttestationRequest(
      await signedRequest(),
      env,
      NOW,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("location")).toBeNull();

    const text = await response.text();
    const body = JSON.parse(text);
    const expectedInventory = await campaignActionGateInventory(baseEnv);
    expect(text).toBe(canonicalJson(body));
    expect(body).toEqual({
      action_gates: {
        all_action_gates_false: true,
        count: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
        digest_sha256: expectedInventory.digestSha256,
        inventory: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.map(
          (name) => ({ enabled: false, name }),
        ),
      },
      all_action_gates_false: true,
      contract: CONTROLLER_DISABLE_ATTESTATION_CONTRACT,
      controller_enabled: false,
      controller_service_name:
        baseEnv.CONTAINER_CONTROLLER_SERVICE_NAME,
      controller_version_id: baseEnv.CF_VERSION_METADATA.id,
      execution_enabled: false,
      request_id_sha256: REQUEST_ID,
      schema_version: 1,
    });
    expect(
      [...accessed].map(String),
    ).not.toEqual(
      expect.arrayContaining([
        "DB",
        "RELAY_SHARDS",
        "CONFIG_KV",
        "FILE_BUCKET",
        "PROVIDER_EGRESS",
      ]),
    );
  });

  test("accepts a separately configured previous key without reusing readiness or Edge headers", async () => {
    const env: ControllerDisableAttestationEnvironment = {
      ...baseEnv,
      CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: PREVIOUS_KID,
      CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET: PREVIOUS_SECRET,
    };
    const previousClaims = await claims(PREVIOUS_KID);
    const previousToken =
      await createControllerDisableAttestationAuthorityTokenForTest(
        PREVIOUS_SECRET,
        PREVIOUS_KID,
        previousClaims,
      );
    const accepted = await handleControllerDisableAttestationRequest(
      requestWithToken(previousToken),
      env,
      NOW,
    );
    expect(accepted.status).toBe(200);

    const wrongHeader = new Request(
      `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
      {
        method: "POST",
        headers: {
          "x-cinatoken-shard-placement-readiness-authority":
            previousToken,
        },
      },
    );
    const rejected = await handleControllerDisableAttestationRequest(
      wrongHeader,
      env,
      NOW,
    );
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({
      error: "invalid_controller_disable_attestation_authority",
    });
  });

  test("binds canonical claims to POST, the exact private path, and the empty-body hash", async () => {
    const verified = await verifyControllerDisableAttestationRequest(
      await signedRequest(),
      baseEnv,
      NOW,
    );
    expect(verified.claims).toEqual(await claims(CURRENT_KID));

    for (const request of [
      new Request(
        `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
        {
          method: "GET",
          headers: {
            [CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER]:
              await token(),
          },
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}?x=1`,
        {
          method: "POST",
          headers: {
            [CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER]:
              await token(),
          },
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
        {
          method: "POST",
          headers: {
            [CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER]:
              await token(),
            "content-type": "application/json",
          },
        },
      ),
      new Request(
        `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
        {
          method: "POST",
          headers: {
            [CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER]:
              await token(),
          },
          body: new Uint8Array([1]),
        },
      ),
    ]) {
      const response = await handleControllerDisableAttestationRequest(
        request,
        baseEnv,
        NOW,
      );
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
    }
  });

  test("rejects validly signed noncanonical header and claims JSON", async () => {
    const noncanonical =
      await createControllerDisableAttestationAuthorityTokenForTest(
        CURRENT_SECRET,
        CURRENT_KID,
        await claims(CURRENT_KID),
        false,
      );
    const response = await handleControllerDisableAttestationRequest(
      requestWithToken(noncanonical),
      baseEnv,
      NOW,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "invalid_controller_disable_attestation_authority",
    });
  });

  test("rejects issuer, audience, role, credential, body, request, and time claim drift", async () => {
    const variants: ControllerDisableAttestationAuthorityClaims[] = [
      { ...(await claims(CURRENT_KID)), issuer: "other-issuer" },
      { ...(await claims(CURRENT_KID)), audience: "other-audience" },
      {
        ...(await claims(CURRENT_KID)),
        credential_id_sha256: "b".repeat(64),
      },
      {
        ...(await claims(CURRENT_KID)),
        body_sha256: "c".repeat(64),
      },
      {
        ...(await claims(CURRENT_KID)),
        expires_at: NOW,
      },
      {
        ...(await claims(CURRENT_KID)),
        issued_at: NOW + 6,
        expires_at: NOW + 20,
      },
      {
        ...(await claims(CURRENT_KID)),
        issued_at: NOW - 31,
        expires_at: NOW + 1,
      },
    ];

    for (const variant of variants) {
      const response = await handleControllerDisableAttestationRequest(
        requestWithToken(
          await createControllerDisableAttestationAuthorityTokenForTest(
            CURRENT_SECRET,
            CURRENT_KID,
            variant,
          ),
        ),
        baseEnv,
        NOW,
      );
      expect([403, 409]).toContain(response.status);
    }
  });

  test("fails closed for missing, short, duplicate, or half-configured keyrings", async () => {
    const invalidEnvironments: ControllerDisableAttestationEnvironment[] =
      [
        {
          ...baseEnv,
          CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: "",
        },
        {
          ...baseEnv,
          CONTROLLER_DISABLE_ATTESTATION_CURRENT_SECRET: "short",
        },
        {
          ...baseEnv,
          CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID: CURRENT_KID,
          CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_SECRET:
            PREVIOUS_SECRET,
        },
        {
          ...baseEnv,
          CONTROLLER_DISABLE_ATTESTATION_PREVIOUS_KID:
            PREVIOUS_KID,
        },
      ];
    for (const env of invalidEnvironments) {
      const response = await handleControllerDisableAttestationRequest(
        await signedRequest(),
        env,
        NOW,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:
          "controller_disable_attestation_authority_unavailable",
      });
    }
  });

  test("fails closed when any action gate is true or malformed", async () => {
    for (const value of ["true", "TRUE", "", "0"]) {
      const response = await handleControllerDisableAttestationRequest(
        await signedRequest(),
        {
          ...baseEnv,
          CONTAINER_PROVIDER_EGRESS_ENABLED: value,
        },
        NOW,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "controller_disable_attestation_action_gate_open",
      });
    }
  });

  test("fails closed when Controller version metadata or service identity is invalid", async () => {
    const environments: ControllerDisableAttestationEnvironment[] = [
      {
        ...baseEnv,
        CF_VERSION_METADATA: { id: "" },
      },
      {
        ...baseEnv,
        CF_VERSION_METADATA: { id: "version with spaces" },
      },
      {
        ...baseEnv,
        CONTAINER_CONTROLLER_SERVICE_NAME: "Invalid_Service",
      },
    ];
    for (const env of environments) {
      const response = await handleControllerDisableAttestationRequest(
        await signedRequest(),
        env,
        NOW,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:
          "controller_disable_attestation_identity_unavailable",
      });
    }
  });

  test("bounds the authority token before parsing", async () => {
    const response = await handleControllerDisableAttestationRequest(
      requestWithToken("a".repeat(4_097)),
      baseEnv,
      NOW,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "invalid_controller_disable_attestation_authority",
    });
  });
});

async function signedRequest(): Promise<Request> {
  return requestWithToken(await token());
}

function requestWithToken(value: string): Request {
  return new Request(
    `https://controller.internal${CONTROLLER_DISABLE_ATTESTATION_PATH}`,
    {
      method: "POST",
      headers: {
        [CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_HEADER]: value,
      },
    },
  );
}

async function token(): Promise<string> {
  return createControllerDisableAttestationAuthorityTokenForTest(
    CURRENT_SECRET,
    CURRENT_KID,
    await claims(CURRENT_KID),
  );
}

async function claims(
  kid: string,
): Promise<ControllerDisableAttestationAuthorityClaims> {
  return {
    authority_version: 1,
    issuer:
      baseEnv.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_ISSUER,
    audience:
      baseEnv.CONTROLLER_DISABLE_ATTESTATION_AUTHORITY_AUDIENCE,
    role: CONTROLLER_DISABLE_ATTESTATION_ROLE,
    credential_id_sha256:
      await controllerDisableAttestationCredentialIdSha256(kid),
    request_id_sha256: REQUEST_ID,
    method: "POST",
    path_and_query: CONTROLLER_DISABLE_ATTESTATION_PATH,
    body_sha256: EMPTY_BODY_SHA256,
    issued_at: NOW,
    expires_at: NOW + 30,
  };
}

function disabledActionGates(): Record<
  (typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number],
  string
> {
  return Object.fromEntries(
    SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.map((name) => [
      name,
      "false",
    ]),
  ) as Record<
    (typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number],
    string
  >;
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
