import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";

import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS,
  RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT,
  RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_FIELDS,
  RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS,
  encodeRelayContainerShardPlacementMutationAuthorizationMessage,
  relayContainerShardPlacementMutationAuthorizationSubjectDigestSha256,
  verifyRelayContainerShardPlacementMutationAuthorization,
} from "../tools/lib/relay_container_shard_placement_mutation_authorization.mjs";

const DOMAIN = Buffer.from(
  "cinatoken-relay-shard-placement-mutation-authorization-v1",
  "utf8",
);
const NOW = 1_800_000_000;
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const CANARY_SEED = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "hex",
);
const CANARY_PUBLIC_KEY = Buffer.from(
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
);
const OTHER_PUBLIC_KEY = Buffer.from(
  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  "hex",
);
const CANARY_PRIVATE_KEY = privateKeyFromSeed(CANARY_SEED);
const CANARY_SPKI = spkiFromPublicKey(CANARY_PUBLIC_KEY);
const OTHER_SPKI = spkiFromPublicKey(OTHER_PUBLIC_KEY);
const CANARY_SPKI_BASE64URL =
  "MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const CANARY_SPKI_SHA256 =
  "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9";
const CANARY_SUBJECT_SHA256 =
  "c3a518c5bb3e2d41f38e78eb121fb8ccb9b501ac9d95252c1a045f91cf334c02";
const CANARY_SIGNATURE_BASE64URL =
  "wn6VVjgSSIc-XKjixmNzuCdyrtFYoGV83p9VdiYhMXOhp3xC3eSnFHJoDh8M88U_lD__vbxCkfzZRzzJmYsuCg";

const BASE_SUBJECT = Object.freeze({
  schema_version: 1,
  contract:
    "cinatoken-relay-shard-placement-mutation-authorization-v1",
  issuer: "cinatoken-placement-authority-staging",
  key_id: "placement-authority-2026-07",
  environment: "staging",
  authorization_id_sha256: "1".repeat(64),
  execution_nonce_sha256: "2".repeat(64),
  campaign_id: "3".repeat(64),
  campaign_nonce_sha256: "4".repeat(64),
  controller_service_name: "cinatoken-container-controller-staging",
  controller_version_id: "controller-version-2026-07-28-001",
  action_gate_inventory_sha256: "5".repeat(64),
  foundation_manifest_sha256: "6".repeat(64),
  runtime_build_id: "7".repeat(64),
  ring_generation: 7,
  shard_count: 32,
  campaign_lifetime_seconds: 600,
  issued_at: NOW,
  expires_at: NOW + 600,
});

const TRUST_POLICY = Object.freeze({
  issuer: BASE_SUBJECT.issuer,
  key_id: BASE_SUBJECT.key_id,
  spki_base64url: CANARY_SPKI_BASE64URL,
  spki_sha256: CANARY_SPKI_SHA256,
});

describe("relay container shard placement mutation authorization", () => {
  test("matches the fixed cross-language canary vector byte for byte", () => {
    const message =
      encodeRelayContainerShardPlacementMutationAuthorizationMessage(
        BASE_SUBJECT,
      );
    const permit = signPermit();
    const decodedFields = decodeSubjectFields(message);

    expect(
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT,
    ).toBe(BASE_SUBJECT.contract);
    expect(
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_FIELDS,
    ).toEqual([
      "schema_version",
      "contract",
      "issuer",
      "key_id",
      "environment",
      "authorization_id_sha256",
      "execution_nonce_sha256",
      "campaign_id",
      "campaign_nonce_sha256",
      "controller_service_name",
      "controller_version_id",
      "action_gate_inventory_sha256",
      "foundation_manifest_sha256",
      "runtime_build_id",
      "ring_generation",
      "shard_count",
      "campaign_lifetime_seconds",
      "issued_at",
      "expires_at",
      "signature_base64url",
    ]);
    expect(message.subarray(0, DOMAIN.length)).toEqual(DOMAIN);
    expect(message.length).toBe(807);
    expect(decodedFields).toEqual(
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS
        .map((field) => String(BASE_SUBJECT[field])),
    );
    expect(CANARY_SPKI.toString("base64url")).toBe(
      CANARY_SPKI_BASE64URL,
    );
    expect(sha256Hex(CANARY_SPKI)).toBe(CANARY_SPKI_SHA256);
    expect(
      relayContainerShardPlacementMutationAuthorizationSubjectDigestSha256(
        BASE_SUBJECT,
      ),
    ).toBe(CANARY_SUBJECT_SHA256);
    expect(permit.signature_base64url).toBe(
      CANARY_SIGNATURE_BASE64URL,
    );

    const result = verifyPermit(permit);
    expect(result).toEqual({
      schemaVersion: 1,
      contract: BASE_SUBJECT.contract,
      issuer: BASE_SUBJECT.issuer,
      keyId: BASE_SUBJECT.key_id,
      environment: "staging",
      authorizationIdSha256: BASE_SUBJECT.authorization_id_sha256,
      executionNonceSha256: BASE_SUBJECT.execution_nonce_sha256,
      campaignId: BASE_SUBJECT.campaign_id,
      campaignNonceSha256: BASE_SUBJECT.campaign_nonce_sha256,
      controllerServiceName: BASE_SUBJECT.controller_service_name,
      controllerVersionId: BASE_SUBJECT.controller_version_id,
      actionGateInventorySha256:
        BASE_SUBJECT.action_gate_inventory_sha256,
      foundationManifestSha256:
        BASE_SUBJECT.foundation_manifest_sha256,
      runtimeBuildId: BASE_SUBJECT.runtime_build_id,
      ringGeneration: BASE_SUBJECT.ring_generation,
      shardCount: BASE_SUBJECT.shard_count,
      campaignLifetimeSeconds:
        BASE_SUBJECT.campaign_lifetime_seconds,
      issuedAt: BASE_SUBJECT.issued_at,
      expiresAt: BASE_SUBJECT.expires_at,
      subjectDigestSha256: CANARY_SUBJECT_SHA256,
    });
    expect(result).not.toHaveProperty("signature_base64url");
    expect(result).not.toHaveProperty("signatureBase64url");
    expect(result).not.toHaveProperty("spki_base64url");
    expect(result).not.toHaveProperty("spkiBase64url");
    expect(result).not.toHaveProperty("spki_sha256");
    expect(result).not.toHaveProperty("spkiSha256");
  });

  test("rejects signed-field tampering and a forged signature", () => {
    const permit = signPermit();
    const tampered = {
      ...permit,
      foundation_manifest_sha256: "8".repeat(64),
    };
    expect(() =>
      verifyPermit(tampered, {
        expectedCandidate: candidateFrom(tampered),
      })
    ).toThrow(
      /Ed25519 verification failed/,
    );

    const signature = Buffer.from(
      permit.signature_base64url,
      "base64url",
    );
    signature[0] ^= 0x80;
    expect(() =>
      verifyPermit({
        ...permit,
        signature_base64url: signature.toString("base64url"),
      })
    ).toThrow(/Ed25519 verification failed/);
  });

  test("binds every expected candidate field exactly", () => {
    const permit = signPermit();
    const expectedCandidate = candidateFrom(permit);

    for (
      const field
      of RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS
    ) {
      if (field === "environment") continue;
      const changed = {
        ...expectedCandidate,
        [field]: differentCandidateValue(
          field,
          expectedCandidate[field],
        ),
      };
      expect(() =>
        verifyPermit(permit, {
          expectedCandidate: changed,
        })
      ).toThrow(new RegExp(`\\[candidate\\] ${field} mismatch`));
    }
  });

  test("rejects campaign ID and campaign nonce hash tampering", () => {
    for (
      const [field, replacement]
      of [
        ["campaign_id", "8".repeat(64)],
        ["campaign_nonce_sha256", "9".repeat(64)],
      ]
    ) {
      const changedPermit = signPermit({
        [field]: replacement,
      });
      expect(() => verifyPermit(changedPermit)).toThrow(
        new RegExp(`\\[candidate\\] ${field} mismatch`),
      );

      const unsignedTamper = {
        ...signPermit(),
        [field]: replacement,
      };
      expect(() =>
        verifyPermit(unsignedTamper, {
          expectedCandidate: candidateFrom(unsignedTamper),
        })
      ).toThrow(/Ed25519 verification failed/);
    }
  });

  test("rejects a wrong environment in the permit or candidate", () => {
    expect(() =>
      verifyPermit({
        ...signPermit(),
        environment: "production",
      })
    ).toThrow(/\[permit\] environment must equal staging/);
    expect(() =>
      verifyPermit(signPermit(), {
        expectedCandidate: {
          ...candidateFrom(BASE_SUBJECT),
          environment: "production",
        },
      })
    ).toThrow(/\[candidate\] environment must equal staging/);
  });

  test("pins the exact issuer, key ID, SPKI and SPKI fingerprint", () => {
    const permit = signPermit();
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: {
          ...TRUST_POLICY,
          issuer: "other-placement-authority",
        },
      })
    ).toThrow(/issuer or key ID mismatch/);
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: {
          ...TRUST_POLICY,
          key_id: "other-placement-key",
        },
      })
    ).toThrow(/issuer or key ID mismatch/);
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: {
          ...TRUST_POLICY,
          spki_sha256: "0".repeat(64),
        },
      })
    ).toThrow(/SPKI fingerprint mismatch/);

    const otherTrust = trustPolicyForSpki(OTHER_SPKI);
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: otherTrust,
      })
    ).toThrow(/Ed25519 verification failed/);
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: {
          ...TRUST_POLICY,
          spki_base64url: Buffer.alloc(44, 0).toString("base64url"),
          spki_sha256: sha256Hex(Buffer.alloc(44, 0)),
        },
      })
    ).toThrow(/exact Ed25519 SPKI format/);
  });

  test("requires canonical base64url signature and Ed25519 SPKI formats", () => {
    const permit = signPermit();
    expect(() =>
      verifyPermit({
        ...permit,
        signature_base64url: `${permit.signature_base64url}=`,
      })
    ).toThrow(/canonical unpadded base64url/);
    expect(() =>
      verifyPermit({
        ...permit,
        signature_base64url: Buffer.alloc(63).toString("base64url"),
      })
    ).toThrow(/exactly 64 bytes/);
    expect(() =>
      verifyPermit(permit, {
        trustPolicy: {
          ...TRUST_POLICY,
          spki_base64url: `${TRUST_POLICY.spki_base64url}=`,
        },
      })
    ).toThrow(/canonical unpadded base64url/);
  });

  test("enforces 60-600 second validity, 120 second skew and 60 second remaining", () => {
    expect(() =>
      verifyPermit(signPermit({
        expires_at: NOW + 59,
      }))
    ).toThrow(/between 60 and 600 seconds/);
    expect(() =>
      verifyPermit(signPermit({
        expires_at: NOW + 601,
      }))
    ).toThrow(/between 60 and 600 seconds/);
    expect(() =>
      verifyPermit(signPermit({
        issued_at: NOW + 121,
        expires_at: NOW + 181,
      }))
    ).toThrow(/clock-skew allowance/);
    expect(() =>
      verifyPermit(signPermit({
        issued_at: NOW - 541,
        expires_at: NOW + 59,
      }))
    ).toThrow(/less than 60 seconds remaining/);

    expect(
      verifyPermit(signPermit({
        issued_at: NOW + 120,
        expires_at: NOW + 180,
      })).subjectDigestSha256,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyPermit(signPermit({
        expires_at: NOW + 60,
      })).subjectDigestSha256,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects malformed or replay-colliding authorization identities", () => {
    expect(() =>
      verifyPermit({
        ...signPermit(),
        authorization_id_sha256: "A".repeat(64),
      })
    ).toThrow(/authorization_id_sha256 has invalid format/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        execution_nonce_sha256: "a".repeat(63),
      })
    ).toThrow(/execution_nonce_sha256 has invalid format/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        execution_nonce_sha256:
          BASE_SUBJECT.authorization_id_sha256,
      })
    ).toThrow(/authorization_id_sha256 and execution_nonce_sha256 must differ/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        campaign_id: "not-a-campaign-id",
      })
    ).toThrow(/campaign_id has invalid format/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        campaign_nonce_sha256: "A".repeat(64),
      })
    ).toThrow(/campaign_nonce_sha256 has invalid format/);
  });

  test("rejects unknown or missing permit, policy and candidate fields", () => {
    expect(() =>
      verifyPermit({
        ...signPermit(),
        approved_by: "external-authority",
      })
    ).toThrow(/\[permit\] must contain only the exact required fields/);

    const permitWithoutCampaign = signPermit();
    delete permitWithoutCampaign.campaign_id;
    expect(() => verifyPermit(permitWithoutCampaign)).toThrow(
      /\[permit\] must contain only the exact required fields/,
    );

    expect(() =>
      verifyPermit(signPermit(), {
        trustPolicy: {
          ...TRUST_POLICY,
          algorithm: "Ed25519",
        },
      })
    ).toThrow(
      /\[trust policy\] must contain only the exact required fields/,
    );
    expect(() =>
      verifyPermit(signPermit(), {
        expectedCandidate: {
          ...candidateFrom(BASE_SUBJECT),
          writer_gate_enabled: true,
        },
      })
    ).toThrow(
      /\[expected candidate\] must contain only the exact required fields/,
    );
  });

  test("rejects non-canonical scalar formats before signature verification", () => {
    expect(() =>
      verifyPermit({
        ...signPermit(),
        ring_generation: "7",
      })
    ).toThrow(/ring_generation must be an integer/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        shard_count: 0,
      })
    ).toThrow(/shard_count must be an integer/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        controller_service_name: "Cinatoken Controller",
      })
    ).toThrow(/controller_service_name has invalid format/);
    expect(() =>
      verifyPermit({
        ...signPermit(),
        runtime_build_id: `sha256:${"7".repeat(64)}`,
      })
    ).toThrow(/runtime_build_id has invalid format/);
  });
});

function signPermit(overrides = {}, privateKey = CANARY_PRIVATE_KEY) {
  const subject = {
    ...BASE_SUBJECT,
    ...overrides,
  };
  const message =
    encodeRelayContainerShardPlacementMutationAuthorizationMessage(
      subject,
    );
  return {
    ...subject,
    signature_base64url: sign(
      null,
      message,
      privateKey,
    ).toString("base64url"),
  };
}

function verifyPermit(
  permit,
  {
    trustPolicy = TRUST_POLICY,
    expectedCandidate = candidateFrom(BASE_SUBJECT),
    now = NOW,
  } = {},
) {
  return verifyRelayContainerShardPlacementMutationAuthorization({
    permit,
    trustPolicy,
    expectedCandidate,
    now,
  });
}

function candidateFrom(value) {
  return Object.fromEntries(
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS
      .map((field) => [field, value[field]]),
  );
}

function differentCandidateValue(field, value) {
  if (
    field === "ring_generation"
    || field === "shard_count"
    || field === "campaign_lifetime_seconds"
  ) {
    return value + 1;
  }
  if (
    field.endsWith("_sha256")
    || field === "campaign_id"
    || field === "runtime_build_id"
  ) {
    return value === "8".repeat(64)
      ? "9".repeat(64)
      : "8".repeat(64);
  }
  return `${value}-other`;
}

function decodeSubjectFields(message) {
  expect(message.subarray(0, DOMAIN.length)).toEqual(DOMAIN);
  const values = [];
  let offset = DOMAIN.length;
  for (
    const _field
    of RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS
  ) {
    expect(offset + 4).toBeLessThanOrEqual(message.length);
    const length = message.readUInt32BE(offset);
    offset += 4;
    expect(offset + length).toBeLessThanOrEqual(message.length);
    values.push(
      message.subarray(offset, offset + length).toString("utf8"),
    );
    offset += length;
  }
  expect(offset).toBe(message.length);
  return values;
}

function privateKeyFromSeed(seed) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function spkiFromPublicKey(publicKey) {
  return Buffer.concat([ED25519_SPKI_PREFIX, publicKey]);
}

function trustPolicyForSpki(spki) {
  return {
    ...TRUST_POLICY,
    spki_base64url: spki.toString("base64url"),
    spki_sha256: sha256Hex(spki),
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
