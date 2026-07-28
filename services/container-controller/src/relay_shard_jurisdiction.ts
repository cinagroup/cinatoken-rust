import { ProtocolError } from "./protocol";

export const RELAY_SHARD_DEFAULT_JURISDICTION = "default" as const;
export const RELAY_SHARD_RESTRICTED_JURISDICTIONS = [
  "eu",
  "us",
  "fedramp",
  "fedramp-high",
] as const;

export type RelayShardRestrictedJurisdiction =
  (typeof RELAY_SHARD_RESTRICTED_JURISDICTIONS)[number];
export type RelayShardJurisdiction =
  | typeof RELAY_SHARD_DEFAULT_JURISDICTION
  | RelayShardRestrictedJurisdiction;

export interface RelayShardJurisdictionEnvironment {
  CONTAINER_DURABLE_OBJECT_JURISDICTION: string;
  CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED: string;
  CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED: string;
}

export interface RelayShardNamespaceLike<Stub = unknown> {
  getByName(name: string): Stub;
  jurisdiction?(
    jurisdiction: RelayShardRestrictedJurisdiction,
  ): RelayShardNamespaceLike<Stub>;
}

export interface RelayShardJurisdictionPolicy {
  jurisdiction: RelayShardJurisdiction;
  restricted: boolean;
}

export function relayShardJurisdictionPolicy(
  env: RelayShardJurisdictionEnvironment,
): RelayShardJurisdictionPolicy {
  const jurisdiction = parseJurisdiction(
    env.CONTAINER_DURABLE_OBJECT_JURISDICTION,
  );
  const enabled = parseGate(
    env.CONTAINER_DURABLE_OBJECT_JURISDICTION_ENABLED,
  );
  const stagingVerified = parseGate(
    env.CONTAINER_DURABLE_OBJECT_JURISDICTION_STAGING_VERIFIED,
  );
  const restricted = jurisdiction !== RELAY_SHARD_DEFAULT_JURISDICTION;

  if (restricted !== (enabled && stagingVerified)) {
    throw new ProtocolError(
      "container_durable_object_jurisdiction_gate_mismatch",
      503,
    );
  }
  if (!restricted && (enabled || stagingVerified)) {
    throw new ProtocolError(
      "container_durable_object_jurisdiction_gate_mismatch",
      503,
    );
  }

  return { jurisdiction, restricted };
}

export function selectRelayShardNamespace<
  Namespace extends RelayShardNamespaceLike,
>(
  env: RelayShardJurisdictionEnvironment & { RELAY_SHARDS: Namespace },
): Namespace {
  const policy = relayShardJurisdictionPolicy(env);
  if (!policy.restricted) return env.RELAY_SHARDS;

  const jurisdiction = env.RELAY_SHARDS.jurisdiction;
  if (typeof jurisdiction !== "function") {
    throw new ProtocolError(
      "container_durable_object_jurisdiction_unavailable",
      503,
    );
  }
  return jurisdiction.call(
    env.RELAY_SHARDS,
    policy.jurisdiction as RelayShardRestrictedJurisdiction,
  ) as Namespace;
}

export function assertRelayShardObjectJurisdiction(
  env: RelayShardJurisdictionEnvironment,
  actualJurisdiction: string | undefined,
): RelayShardJurisdictionPolicy {
  const policy = relayShardJurisdictionPolicy(env);
  const expectedJurisdiction = policy.restricted
    ? policy.jurisdiction
    : undefined;
  if (actualJurisdiction !== expectedJurisdiction) {
    throw new ProtocolError(
      "container_durable_object_jurisdiction_mismatch",
      503,
    );
  }
  return policy;
}

function parseJurisdiction(value: string): RelayShardJurisdiction {
  if (
    value === RELAY_SHARD_DEFAULT_JURISDICTION ||
    RELAY_SHARD_RESTRICTED_JURISDICTIONS.some(
      (jurisdiction) => jurisdiction === value,
    )
  ) {
    return value as RelayShardJurisdiction;
  }
  throw new ProtocolError(
    "container_durable_object_jurisdiction_invalid",
    503,
  );
}

function parseGate(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ProtocolError(
    "container_durable_object_jurisdiction_gate_invalid",
    503,
  );
}
