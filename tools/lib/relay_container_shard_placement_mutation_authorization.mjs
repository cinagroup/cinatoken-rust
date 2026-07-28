import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT =
  "cinatoken-relay-shard-placement-mutation-authorization-v1";
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SCHEMA_VERSION = 1;
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_ENVIRONMENT =
  "staging";
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MIN_LIFETIME_SECONDS =
  60;
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MAX_LIFETIME_SECONDS =
  600;
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CLOCK_SKEW_SECONDS =
  120;
export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MIN_REMAINING_SECONDS =
  60;

export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_FIELDS =
  Object.freeze([
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

export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS =
  Object.freeze(
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_FIELDS.slice(0, -1),
  );

export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS =
  Object.freeze([
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
  ]);

export const RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_TRUST_POLICY_FIELDS =
  Object.freeze([
    "issuer",
    "key_id",
    "spki_base64url",
    "spki_sha256",
  ]);

const DOMAIN = Buffer.from(
  RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT,
  "utf8",
);
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const ISSUER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROLLER_SERVICE_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_RING_GENERATION = 1_000_000;
const MAX_SHARD_COUNT = 1_024;
const MIN_CAMPAIGN_LIFETIME_SECONDS = 60;
const MAX_CAMPAIGN_LIFETIME_SECONDS = 3_600;

export function encodeRelayContainerShardPlacementMutationAuthorizationMessage(
  unsignedPermit,
) {
  const parsed = validateUnsignedPermit(unsignedPermit);
  const parts = [DOMAIN];
  for (
    const field
    of RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS
  ) {
    const bytes = Buffer.from(String(parsed[field]), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

export function relayContainerShardPlacementMutationAuthorizationSubjectDigestSha256(
  unsignedPermit,
) {
  return sha256Hex(
    encodeRelayContainerShardPlacementMutationAuthorizationMessage(
      unsignedPermit,
    ),
  );
}

export function verifyRelayContainerShardPlacementMutationAuthorization({
  permit,
  trustPolicy,
  expectedCandidate,
  now = Math.floor(Date.now() / 1_000),
}) {
  const parsedPermit = validatePermit(permit);
  const parsedTrustPolicy = validateTrustPolicy(trustPolicy);
  const parsedCandidate = validateExpectedCandidate(expectedCandidate);
  const verifierNow = requireInteger(
    normalizeNow(now),
    1,
    Number.MAX_SAFE_INTEGER,
    "[time] verifier now",
  );

  if (
    parsedPermit.issuer !== parsedTrustPolicy.issuer
    || parsedPermit.key_id !== parsedTrustPolicy.key_id
  ) {
    throw new Error("[trust] permit issuer or key ID mismatch");
  }
  for (
    const field
    of RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS
  ) {
    if (parsedPermit[field] !== parsedCandidate[field]) {
      throw new Error(`[candidate] ${field} mismatch`);
    }
  }

  validateTimeWindow(parsedPermit, verifierNow);
  const spki = decodeCanonicalBase64Url(
    parsedTrustPolicy.spki_base64url,
    "[trust] Ed25519 SPKI",
    44,
  );
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + 32
    || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("[trust] public key must use the exact Ed25519 SPKI format");
  }
  const actualSpkiSha256 = Buffer.from(sha256Hex(spki), "hex");
  const expectedSpkiSha256 = Buffer.from(
    parsedTrustPolicy.spki_sha256,
    "hex",
  );
  if (!timingSafeEqual(actualSpkiSha256, expectedSpkiSha256)) {
    throw new Error("[trust] Ed25519 SPKI fingerprint mismatch");
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("[trust] invalid Ed25519 SPKI");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !Buffer.from(
      publicKey.export({
        format: "der",
        type: "spki",
      }),
    ).equals(spki)
  ) {
    throw new Error("[trust] public key must be canonical Ed25519 SPKI");
  }

  const signature = decodeCanonicalBase64Url(
    parsedPermit.signature_base64url,
    "[permit] Ed25519 signature",
    64,
  );
  const unsignedPermit = selectFields(
    parsedPermit,
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS,
  );
  const message =
    encodeRelayContainerShardPlacementMutationAuthorizationMessage(
      unsignedPermit,
    );
  if (!verifySignature(null, message, publicKey, signature)) {
    throw new Error("[signature] Ed25519 verification failed");
  }

  return {
    schemaVersion: parsedPermit.schema_version,
    contract: parsedPermit.contract,
    issuer: parsedPermit.issuer,
    keyId: parsedPermit.key_id,
    environment: parsedPermit.environment,
    authorizationIdSha256: parsedPermit.authorization_id_sha256,
    executionNonceSha256: parsedPermit.execution_nonce_sha256,
    campaignId: parsedPermit.campaign_id,
    campaignNonceSha256: parsedPermit.campaign_nonce_sha256,
    controllerServiceName: parsedPermit.controller_service_name,
    controllerVersionId: parsedPermit.controller_version_id,
    actionGateInventorySha256:
      parsedPermit.action_gate_inventory_sha256,
    foundationManifestSha256: parsedPermit.foundation_manifest_sha256,
    runtimeBuildId: parsedPermit.runtime_build_id,
    ringGeneration: parsedPermit.ring_generation,
    shardCount: parsedPermit.shard_count,
    campaignLifetimeSeconds: parsedPermit.campaign_lifetime_seconds,
    issuedAt: parsedPermit.issued_at,
    expiresAt: parsedPermit.expires_at,
    subjectDigestSha256: sha256Hex(message),
  };
}

function validatePermit(value) {
  const permit = requireExactObject(
    value,
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_FIELDS,
    "[permit]",
  );
  const parsed = validateUnsignedPermit(
    selectFields(
      permit,
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS,
    ),
  );
  return {
    ...parsed,
    signature_base64url: requireCanonicalBase64Url(
      permit.signature_base64url,
      "[permit] signature_base64url",
      64,
    ),
  };
}

function validateUnsignedPermit(value) {
  const permit = requireExactObject(
    value,
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SIGNED_FIELDS,
    "[permit subject]",
  );
  const parsed = {
    schema_version: requireExact(
      permit.schema_version,
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_SCHEMA_VERSION,
      "[permit] schema_version",
    ),
    contract: requireExact(
      permit.contract,
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT,
      "[permit] contract",
    ),
    issuer: requirePattern(permit.issuer, ISSUER, "[permit] issuer"),
    key_id: requirePattern(permit.key_id, KEY_ID, "[permit] key_id"),
    environment: requireExact(
      permit.environment,
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_ENVIRONMENT,
      "[permit] environment",
    ),
    authorization_id_sha256: requireSha256(
      permit.authorization_id_sha256,
      "[permit] authorization_id_sha256",
    ),
    execution_nonce_sha256: requireSha256(
      permit.execution_nonce_sha256,
      "[permit] execution_nonce_sha256",
    ),
    campaign_id: requireSha256(
      permit.campaign_id,
      "[permit] campaign_id",
    ),
    campaign_nonce_sha256: requireSha256(
      permit.campaign_nonce_sha256,
      "[permit] campaign_nonce_sha256",
    ),
    controller_service_name: requirePattern(
      permit.controller_service_name,
      CONTROLLER_SERVICE_NAME,
      "[permit] controller_service_name",
    ),
    controller_version_id: requirePattern(
      permit.controller_version_id,
      VERSION_ID,
      "[permit] controller_version_id",
    ),
    action_gate_inventory_sha256: requireSha256(
      permit.action_gate_inventory_sha256,
      "[permit] action_gate_inventory_sha256",
    ),
    foundation_manifest_sha256: requireSha256(
      permit.foundation_manifest_sha256,
      "[permit] foundation_manifest_sha256",
    ),
    runtime_build_id: requireSha256(
      permit.runtime_build_id,
      "[permit] runtime_build_id",
    ),
    ring_generation: requireInteger(
      permit.ring_generation,
      1,
      MAX_RING_GENERATION,
      "[permit] ring_generation",
    ),
    shard_count: requireInteger(
      permit.shard_count,
      1,
      MAX_SHARD_COUNT,
      "[permit] shard_count",
    ),
    campaign_lifetime_seconds: requireInteger(
      permit.campaign_lifetime_seconds,
      MIN_CAMPAIGN_LIFETIME_SECONDS,
      MAX_CAMPAIGN_LIFETIME_SECONDS,
      "[permit] campaign_lifetime_seconds",
    ),
    issued_at: requireInteger(
      permit.issued_at,
      1,
      Number.MAX_SAFE_INTEGER,
      "[permit] issued_at",
    ),
    expires_at: requireInteger(
      permit.expires_at,
      1,
      Number.MAX_SAFE_INTEGER,
      "[permit] expires_at",
    ),
  };
  if (
    parsed.authorization_id_sha256 === parsed.execution_nonce_sha256
  ) {
    throw new Error(
      "[permit] authorization_id_sha256 and execution_nonce_sha256 must differ",
    );
  }
  return parsed;
}

function validateTrustPolicy(value) {
  const policy = requireExactObject(
    value,
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_TRUST_POLICY_FIELDS,
    "[trust policy]",
  );
  return {
    issuer: requirePattern(policy.issuer, ISSUER, "[trust] issuer"),
    key_id: requirePattern(policy.key_id, KEY_ID, "[trust] key_id"),
    spki_base64url: requireCanonicalBase64Url(
      policy.spki_base64url,
      "[trust] spki_base64url",
      44,
    ),
    spki_sha256: requireSha256(
      policy.spki_sha256,
      "[trust] spki_sha256",
    ),
  };
}

function validateExpectedCandidate(value) {
  const candidate = requireExactObject(
    value,
    RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CANDIDATE_FIELDS,
    "[expected candidate]",
  );
  return {
    environment: requireExact(
      candidate.environment,
      RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_ENVIRONMENT,
      "[candidate] environment",
    ),
    authorization_id_sha256: requireSha256(
      candidate.authorization_id_sha256,
      "[candidate] authorization_id_sha256",
    ),
    execution_nonce_sha256: requireSha256(
      candidate.execution_nonce_sha256,
      "[candidate] execution_nonce_sha256",
    ),
    campaign_id: requireSha256(
      candidate.campaign_id,
      "[candidate] campaign_id",
    ),
    campaign_nonce_sha256: requireSha256(
      candidate.campaign_nonce_sha256,
      "[candidate] campaign_nonce_sha256",
    ),
    controller_service_name: requirePattern(
      candidate.controller_service_name,
      CONTROLLER_SERVICE_NAME,
      "[candidate] controller_service_name",
    ),
    controller_version_id: requirePattern(
      candidate.controller_version_id,
      VERSION_ID,
      "[candidate] controller_version_id",
    ),
    action_gate_inventory_sha256: requireSha256(
      candidate.action_gate_inventory_sha256,
      "[candidate] action_gate_inventory_sha256",
    ),
    foundation_manifest_sha256: requireSha256(
      candidate.foundation_manifest_sha256,
      "[candidate] foundation_manifest_sha256",
    ),
    runtime_build_id: requireSha256(
      candidate.runtime_build_id,
      "[candidate] runtime_build_id",
    ),
    ring_generation: requireInteger(
      candidate.ring_generation,
      1,
      MAX_RING_GENERATION,
      "[candidate] ring_generation",
    ),
    shard_count: requireInteger(
      candidate.shard_count,
      1,
      MAX_SHARD_COUNT,
      "[candidate] shard_count",
    ),
    campaign_lifetime_seconds: requireInteger(
      candidate.campaign_lifetime_seconds,
      MIN_CAMPAIGN_LIFETIME_SECONDS,
      MAX_CAMPAIGN_LIFETIME_SECONDS,
      "[candidate] campaign_lifetime_seconds",
    ),
  };
}

function validateTimeWindow(permit, now) {
  const lifetime = permit.expires_at - permit.issued_at;
  if (
    lifetime
      < RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MIN_LIFETIME_SECONDS
    || lifetime
      > RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MAX_LIFETIME_SECONDS
  ) {
    throw new Error("[time] permit lifetime must be between 60 and 600 seconds");
  }
  if (
    permit.issued_at
      > now
        + RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("[time] permit issued_at exceeds the clock-skew allowance");
  }
  if (
    permit.expires_at - now
      < RELAY_CONTAINER_SHARD_PLACEMENT_MUTATION_AUTHORIZATION_MIN_REMAINING_SECONDS
  ) {
    throw new Error("[time] permit has less than 60 seconds remaining");
  }
}

function normalizeNow(value) {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new Error("[time] verifier now must be a valid Date");
    }
    return Math.floor(milliseconds / 1_000);
  }
  return value;
}

function requireExactObject(value, expectedKeys, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length
    || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} must contain only the exact required fields`);
  }
  return value;
}

function selectFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must equal ${String(expected)}`);
  }
  return value;
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has invalid format`);
  }
  return value;
}

function requireSha256(value, label) {
  return requirePattern(value, LOWER_SHA256, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requireCanonicalBase64Url(value, label, expectedBytes) {
  if (
    typeof value !== "string"
    || !BASE64URL.test(value)
  ) {
    throw new Error(`${label} must be canonical unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length !== expectedBytes
    || bytes.toString("base64url") !== value
  ) {
    throw new Error(
      `${label} must encode exactly ${expectedBytes} bytes`,
    );
  }
  return value;
}

function decodeCanonicalBase64Url(value, label, expectedBytes) {
  requireCanonicalBase64Url(value, label, expectedBytes);
  return Buffer.from(value, "base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
