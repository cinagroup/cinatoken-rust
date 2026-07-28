import { ProtocolError, type OperationShard } from "./protocol";
import {
  RELAY_SHARD_DEFAULT_JURISDICTION,
  RELAY_SHARD_RESTRICTED_JURISDICTIONS,
  type RelayShardJurisdiction,
} from "./relay_shard_jurisdiction";

export const SHARD_PLACEMENT_ATTESTATION_CONTRACT =
  "cinatoken-relay-shard-placement-attestation-v1" as const;
export const SHARD_PLACEMENT_ATTESTATION_CONTRACT_VERSION = 1 as const;
export const SHARD_PLACEMENT_ATTESTATION_DIGEST_DOMAIN =
  "cinatoken-relay-shard-placement-attestation-v1";
export const RELAY_SHARD_NAMESPACE_BINDING = "RELAY_SHARDS" as const;
export const RELAY_SHARD_DURABLE_OBJECT_CLASS = "RelayShardContainer" as const;

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const CONTROLLER_SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const CONTROLLER_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DURABLE_OBJECT_ID = /^[A-Za-z0-9._:-]{1,512}$/;
const encoder = new TextEncoder();
const digestDomain = encoder.encode(SHARD_PLACEMENT_ATTESTATION_DIGEST_DOMAIN);

export type ShardPlacementEnvironment = "staging" | "production";

export interface ShardPlacementAttestationV1 {
  contract_version: typeof SHARD_PLACEMENT_ATTESTATION_CONTRACT_VERSION;
  environment: ShardPlacementEnvironment;
  controller_service_name: string;
  controller_version_id: string;
  durable_object_namespace_binding: typeof RELAY_SHARD_NAMESPACE_BINDING;
  durable_object_class: typeof RELAY_SHARD_DURABLE_OBJECT_CLASS;
  jurisdiction: RelayShardJurisdiction;
  canonical_name_sha256: string;
  object_id_sha256: string;
  shard: OperationShard;
}

export interface CreateShardPlacementAttestationV1Input {
  environment: ShardPlacementEnvironment;
  controllerServiceName: string;
  controllerVersionId: string;
  jurisdiction: RelayShardJurisdiction;
  durableObjectId: string;
  shard: OperationShard;
}

export interface ShardPlacementAttestationWriterEnvironment {
  CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED: string;
  CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED: string;
}

export interface ShardPlacementAttestationWriterPolicy {
  enabled: boolean;
  staging_verified: boolean;
}

export type ShardPlacementAttestationRpcResultV1 =
  | {
      ok: true;
      attestation: ShardPlacementAttestationV1;
      attestation_digest_sha256: string;
    }
  | { ok: false; error: { code: string; status: number } };

export interface VerifiedShardPlacementAttestationV1 {
  attestation: ShardPlacementAttestationV1;
  attestationDigestSha256: string;
}

export function shardPlacementAttestationWriterPolicy(
  env: ShardPlacementAttestationWriterEnvironment,
): ShardPlacementAttestationWriterPolicy {
  const enabled = parseGate(
    env.CONTAINER_SHARD_PLACEMENT_ATTESTATION_WRITE_ENABLED,
  );
  const stagingVerified = parseGate(
    env.CONTAINER_SHARD_PLACEMENT_ATTESTATION_STAGING_VERIFIED,
  );
  if (enabled !== stagingVerified) {
    throw new ProtocolError(
      "shard_placement_attestation_gate_mismatch",
      503,
    );
  }
  return { enabled, staging_verified: stagingVerified };
}

export async function createShardPlacementAttestationV1(
  input: CreateShardPlacementAttestationV1Input,
): Promise<ShardPlacementAttestationV1> {
  if (!DURABLE_OBJECT_ID.test(input.durableObjectId)) invalid();
  const attestation: ShardPlacementAttestationV1 = {
    contract_version: SHARD_PLACEMENT_ATTESTATION_CONTRACT_VERSION,
    environment: input.environment,
    controller_service_name: input.controllerServiceName,
    controller_version_id: input.controllerVersionId,
    durable_object_namespace_binding: RELAY_SHARD_NAMESPACE_BINDING,
    durable_object_class: RELAY_SHARD_DURABLE_OBJECT_CLASS,
    jurisdiction: input.jurisdiction,
    canonical_name_sha256: await sha256Hex(input.shard.instance_name),
    object_id_sha256: await sha256Hex(input.durableObjectId),
    shard: { ...input.shard },
  };
  await validateShardPlacementAttestationV1(attestation);
  return attestation;
}

export async function parseShardPlacementAttestationV1(
  value: unknown,
): Promise<ShardPlacementAttestationV1> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract_version",
      "environment",
      "controller_service_name",
      "controller_version_id",
      "durable_object_namespace_binding",
      "durable_object_class",
      "jurisdiction",
      "canonical_name_sha256",
      "object_id_sha256",
      "shard",
    ])
  ) {
    invalid();
  }
  if (
    value.contract_version !==
      SHARD_PLACEMENT_ATTESTATION_CONTRACT_VERSION ||
    !isEnvironment(value.environment) ||
    typeof value.controller_service_name !== "string" ||
    typeof value.controller_version_id !== "string" ||
    value.durable_object_namespace_binding !==
      RELAY_SHARD_NAMESPACE_BINDING ||
    value.durable_object_class !== RELAY_SHARD_DURABLE_OBJECT_CLASS ||
    !isJurisdiction(value.jurisdiction) ||
    typeof value.canonical_name_sha256 !== "string" ||
    typeof value.object_id_sha256 !== "string" ||
    !isCanonicalShard(value.shard)
  ) {
    invalid();
  }
  const attestation: ShardPlacementAttestationV1 = {
    contract_version: value.contract_version,
    environment: value.environment,
    controller_service_name: value.controller_service_name,
    controller_version_id: value.controller_version_id,
    durable_object_namespace_binding: value.durable_object_namespace_binding,
    durable_object_class: value.durable_object_class,
    jurisdiction: value.jurisdiction,
    canonical_name_sha256: value.canonical_name_sha256,
    object_id_sha256: value.object_id_sha256,
    shard: value.shard,
  };
  await validateShardPlacementAttestationV1(attestation);
  return attestation;
}

export async function validateShardPlacementAttestationV1(
  attestation: ShardPlacementAttestationV1,
): Promise<void> {
  if (
    attestation.contract_version !==
      SHARD_PLACEMENT_ATTESTATION_CONTRACT_VERSION ||
    !["staging", "production"].includes(attestation.environment) ||
    !CONTROLLER_SERVICE_NAME.test(attestation.controller_service_name) ||
    !CONTROLLER_VERSION_ID.test(attestation.controller_version_id) ||
    attestation.durable_object_namespace_binding !==
      RELAY_SHARD_NAMESPACE_BINDING ||
    attestation.durable_object_class !== RELAY_SHARD_DURABLE_OBJECT_CLASS ||
    !isJurisdiction(attestation.jurisdiction) ||
    !LOWER_HEX_64.test(attestation.canonical_name_sha256) ||
    !LOWER_HEX_64.test(attestation.object_id_sha256) ||
    !isCanonicalShard(attestation.shard) ||
    attestation.canonical_name_sha256 !==
      (await sha256Hex(attestation.shard.instance_name))
  ) {
    invalid();
  }
}

export async function shardPlacementAttestationDigest(
  attestation: ShardPlacementAttestationV1,
): Promise<string> {
  await validateShardPlacementAttestationV1(attestation);
  return digestParts([
    attestation.contract_version.toString(),
    attestation.environment,
    attestation.controller_service_name,
    attestation.controller_version_id,
    attestation.durable_object_namespace_binding,
    attestation.durable_object_class,
    attestation.jurisdiction,
    attestation.canonical_name_sha256,
    attestation.object_id_sha256,
    attestation.shard.contract_version.toString(),
    attestation.shard.ring_generation.toString(),
    attestation.shard.shard_count.toString(),
    attestation.shard.shard_index.toString(),
    attestation.shard.instance_name,
  ]);
}

export async function verifyShardPlacementAttestationRpcV1(
  value: unknown,
  expectedInput: CreateShardPlacementAttestationV1Input,
): Promise<VerifiedShardPlacementAttestationV1> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ok",
      "attestation",
      "attestation_digest_sha256",
    ]) ||
    value.ok !== true ||
    typeof value.attestation_digest_sha256 !== "string" ||
    !LOWER_HEX_64.test(value.attestation_digest_sha256)
  ) {
    invalidRpc();
  }
  let attestation: ShardPlacementAttestationV1;
  try {
    attestation = await parseShardPlacementAttestationV1(value.attestation);
  } catch {
    invalidRpc();
  }
  const expected = await createShardPlacementAttestationV1(expectedInput);
  const [actualDigest, expectedDigest] = await Promise.all([
    shardPlacementAttestationDigest(attestation),
    shardPlacementAttestationDigest(expected),
  ]);
  if (
    value.attestation_digest_sha256 !== actualDigest ||
    actualDigest !== expectedDigest ||
    JSON.stringify(attestation) !== JSON.stringify(expected)
  ) {
    throw new ProtocolError("shard_placement_attestation_mismatch", 502);
  }
  return { attestation, attestationDigestSha256: actualDigest };
}

function isCanonicalShard(value: unknown): value is OperationShard {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract_version",
      "ring_generation",
      "shard_count",
      "shard_index",
      "instance_name",
    ]) ||
    value.contract_version !== 1 ||
    !integerInRange(value.ring_generation, 1, 1_000_000) ||
    !integerInRange(value.shard_count, 1, 1_024) ||
    !integerInRange(value.shard_index, 0, (value.shard_count as number) - 1)
  ) {
    return false;
  }
  return (
    value.instance_name ===
    `cinatoken-relay-shard-v1-${(value.shard_index as number)
      .toString()
      .padStart(4, "0")}`
  );
}

function isEnvironment(value: unknown): value is ShardPlacementEnvironment {
  return value === "staging" || value === "production";
}

function isJurisdiction(value: unknown): value is RelayShardJurisdiction {
  return (
    value === RELAY_SHARD_DEFAULT_JURISDICTION ||
    RELAY_SHARD_RESTRICTED_JURISDICTIONS.some(
      (jurisdiction) => jurisdiction === value,
    )
  );
}

function parseGate(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ProtocolError("shard_placement_attestation_gate_invalid", 503);
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function digestParts(parts: string[]): Promise<string> {
  const encoded = parts.map((part) => encoder.encode(part));
  const byteLength =
    digestDomain.length +
    encoded.reduce((total, part) => total + 4 + part.length, 0);
  const bytes = new Uint8Array(byteLength);
  bytes.set(digestDomain);
  const view = new DataView(bytes.buffer);
  let offset = digestDomain.length;
  for (const part of encoded) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    bytes.set(part, offset);
    offset += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function invalid(): never {
  throw new ProtocolError("invalid_shard_placement_attestation", 400);
}

function invalidRpc(): never {
  throw new ProtocolError("shard_placement_attestation_rpc_invalid", 502);
}
