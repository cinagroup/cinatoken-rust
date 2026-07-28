import { ProtocolError } from "./protocol";
import type { ShardActivationCampaignClaim } from "./shard_activation_campaign";
import {
  parseShardPlacementAttestationV1,
  shardPlacementAttestationDigest,
  type VerifiedShardPlacementAttestationV1,
} from "./shard_placement_attestation";

type PlacementDatabase = Pick<D1Database, "withSession">;
type PlacementSession = ReturnType<PlacementDatabase["withSession"]>;

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const EXPECTED_COLUMNS = [
  "placement_attestation_digest_sha256",
  "contract_version",
  "environment",
  "controller_service_name",
  "controller_version_id",
  "durable_object_namespace_binding",
  "durable_object_class",
  "jurisdiction",
  "canonical_name_sha256",
  "object_id_sha256",
  "shard_contract_version",
  "ring_generation",
  "shard_count",
  "shard_index",
  "instance_name",
  "activation_id",
  "campaign_id",
  "claim_digest_sha256",
  "readiness_result_sha256",
  "activation_digest_sha256",
  "consumption_digest_sha256",
  "recorded_at",
].join(",");
const EXPECTED_EVENT_COLUMNS = [
  "placement_event_sequence",
  "placement_attestation_digest_sha256",
  "controller_version_id",
  "ring_generation",
  "campaign_id",
  "activation_id",
].join(",");
const EXPECTED_SCHEMA_OBJECTS = [
  "index:idx_relay_container_shard_placement_attestations_candidate",
  "index:idx_relay_container_shard_placement_attestations_object",
  "index:idx_relay_container_shard_placement_events_candidate",
  "table:relay_container_shard_placement_attestations",
  "table:relay_container_shard_placement_events",
  "trigger:relay_container_shard_placement_attestation_delete_guard",
  "trigger:relay_container_shard_placement_attestation_event_append",
  "trigger:relay_container_shard_placement_attestation_insert_guard",
  "trigger:relay_container_shard_placement_attestation_update_guard",
  "trigger:relay_container_shard_placement_event_delete_guard",
  "trigger:relay_container_shard_placement_event_insert_guard",
  "trigger:relay_container_shard_placement_event_update_guard",
].join("|");

const SCHEMA_READINESS_SQL = `
SELECT
  (SELECT COUNT(1) FROM d1_migrations
   WHERE name IN (
     '0061_relay_container_shard_placement_attestations.sql',
     '0062_relay_container_shard_placement_events.sql'
   ))
    AS migration_count,
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info('relay_container_shard_placement_attestations')
     ORDER BY cid
   )) AS placement_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info('relay_container_shard_placement_events')
     ORDER BY cid
   )) AS event_columns,
  (SELECT group_concat(type || ':' || name, '|') FROM (
     SELECT type, name
     FROM sqlite_master
     WHERE tbl_name IN (
       'relay_container_shard_placement_attestations',
       'relay_container_shard_placement_events'
     )
       AND name NOT LIKE 'sqlite_autoindex_%'
     ORDER BY type || ':' || name
   )) AS schema_objects
`.trim();

const INSERT_SQL = `
INSERT INTO relay_container_shard_placement_attestations (
  placement_attestation_digest_sha256, contract_version, environment,
  controller_service_name, controller_version_id,
  durable_object_namespace_binding, durable_object_class, jurisdiction,
  canonical_name_sha256, object_id_sha256, shard_contract_version,
  ring_generation, shard_count, shard_index, instance_name, activation_id,
  campaign_id, claim_digest_sha256, readiness_result_sha256,
  activation_digest_sha256, consumption_digest_sha256
)
SELECT
  ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
  activation.activation_id, consumption.campaign_id,
  consumption.claim_digest_sha256, consumption.readiness_result_sha256,
  consumption.activation_digest_sha256, consumption.consumption_digest_sha256
FROM relay_container_shard_activation_campaign_consumptions AS consumption
JOIN relay_container_shard_activations AS activation
  ON activation.controller_version_id = consumption.controller_version_id
 AND activation.runtime_build_id = consumption.runtime_build_id
 AND activation.ring_generation = consumption.ring_generation
 AND activation.shard_index = consumption.shard_index
 AND activation.activation_digest_sha256 = consumption.activation_digest_sha256
WHERE consumption.campaign_id = ?15
  AND consumption.shard_index = ?13
  AND consumption.claim_digest_sha256 = ?16
  AND consumption.readiness_result_sha256 = ?17
  AND consumption.environment = ?2
  AND consumption.controller_version_id = ?4
  AND consumption.shard_contract_version = ?10
  AND consumption.ring_generation = ?11
  AND consumption.shard_count = ?12
  AND consumption.instance_name = ?14
`.trim();

const READBACK_SQL = `
SELECT
  event.placement_event_sequence,
  placement.placement_attestation_digest_sha256,
  placement.contract_version, placement.environment,
  placement.controller_service_name, placement.controller_version_id,
  placement.durable_object_namespace_binding,
  placement.durable_object_class, placement.jurisdiction,
  placement.canonical_name_sha256, placement.object_id_sha256,
  placement.shard_contract_version, placement.ring_generation,
  placement.shard_count, placement.shard_index, placement.instance_name,
  placement.activation_id, placement.campaign_id,
  placement.claim_digest_sha256, placement.readiness_result_sha256,
  placement.activation_digest_sha256, placement.consumption_digest_sha256,
  placement.recorded_at
FROM relay_container_shard_placement_attestations AS placement
JOIN relay_container_shard_placement_events AS event
  ON event.placement_attestation_digest_sha256 =
       placement.placement_attestation_digest_sha256
 AND event.controller_version_id = placement.controller_version_id
 AND event.ring_generation = placement.ring_generation
 AND event.campaign_id = placement.campaign_id
 AND event.activation_id = placement.activation_id
WHERE placement.campaign_id = ?1 AND placement.shard_index = ?2
LIMIT 1
`.trim();

interface PlacementStoredRow extends Record<string, unknown> {
  placement_event_sequence: number;
  placement_attestation_digest_sha256: string;
  contract_version: number;
  environment: string;
  controller_service_name: string;
  controller_version_id: string;
  durable_object_namespace_binding: string;
  durable_object_class: string;
  jurisdiction: string;
  canonical_name_sha256: string;
  object_id_sha256: string;
  shard_contract_version: number;
  ring_generation: number;
  shard_count: number;
  shard_index: number;
  instance_name: string;
  activation_id: number;
  campaign_id: string;
  claim_digest_sha256: string;
  readiness_result_sha256: string;
  activation_digest_sha256: string;
  consumption_digest_sha256: string;
  recorded_at: number;
}

export interface RecordShardPlacementAttestationResult {
  placementEventSequence: number;
  activationId: number;
  activationDigestSha256: string;
  consumptionDigestSha256: string;
  recordedAt: number;
  duplicate: boolean;
}

export async function recordShardPlacementAttestation(
  database: PlacementDatabase,
  claim: ShardActivationCampaignClaim,
  readinessResultSha256: string,
  verified: VerifiedShardPlacementAttestationV1,
): Promise<RecordShardPlacementAttestationResult> {
  if (!LOWER_HEX_64.test(readinessResultSha256)) {
    throw new ProtocolError("invalid_shard_placement_attestation", 400);
  }
  const session = await placementSession(database);
  const bindings = insertBindings(claim, readinessResultSha256, verified);
  let inserted = false;
  let writeFailed = false;
  let missingActivation = false;
  try {
    const result = await session
      .prepare(INSERT_SQL)
      .bind(...bindings)
      .run();
    const changes = result?.meta?.changes;
    if (
      result?.success !== true ||
      typeof changes !== "number" ||
      changes < 1 ||
      changes > 2
    ) {
      missingActivation = result?.success === true && changes === 0;
      throw new Error("placement insert did not append its attestation event pair");
    }
    inserted = true;
  } catch {
    writeFailed = true;
  }

  const row = await readPlacement(session, claim.campaignId, claim.shard.shard_index);
  if (row === null) {
    if (inserted) {
      throw new ProtocolError("shard_placement_attestation_readback_invalid", 502);
    }
    if (missingActivation) {
      throw new ProtocolError("shard_placement_attestation_activation_missing", 409);
    }
    throw new ProtocolError("shard_placement_attestation_write_unavailable", 503);
  }
  const matches = await placementMatches(row, claim, readinessResultSha256, verified);
  if (!matches) {
    throw new ProtocolError(
      writeFailed
        ? "shard_placement_attestation_conflict"
        : "shard_placement_attestation_readback_invalid",
      writeFailed ? 409 : 502,
    );
  }
  return {
    placementEventSequence: row.placement_event_sequence,
    activationId: row.activation_id,
    activationDigestSha256: row.activation_digest_sha256,
    consumptionDigestSha256: row.consumption_digest_sha256,
    recordedAt: row.recorded_at,
    duplicate: !inserted,
  };
}

async function placementSession(database: PlacementDatabase): Promise<PlacementSession> {
  try {
    const session = database.withSession("first-primary");
    const schema = await session.prepare(SCHEMA_READINESS_SQL).first<Record<string, unknown>>();
    if (
      schema === null ||
      Object.keys(schema).length !== 4 ||
      schema.migration_count !== 2 ||
      schema.placement_columns !== EXPECTED_COLUMNS ||
      schema.event_columns !== EXPECTED_EVENT_COLUMNS ||
      schema.schema_objects !== EXPECTED_SCHEMA_OBJECTS
    ) {
      throw new ProtocolError("shard_placement_attestation_schema_unavailable", 503);
    }
    return session;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("shard_placement_attestation_schema_unavailable", 503);
  }
}

async function readPlacement(
  session: PlacementSession,
  campaignId: string,
  shardIndex: number,
): Promise<PlacementStoredRow | null> {
  try {
    const row = await session
      .prepare(READBACK_SQL)
      .bind(campaignId, shardIndex)
      .first<Record<string, unknown>>();
    return isPlacementStoredRow(row) ? row : null;
  } catch {
    throw new ProtocolError("shard_placement_attestation_readback_unavailable", 503);
  }
}

function insertBindings(
  claim: ShardActivationCampaignClaim,
  readinessResultSha256: string,
  verified: VerifiedShardPlacementAttestationV1,
): unknown[] {
  const attestation = verified.attestation;
  return [
    verified.attestationDigestSha256,
    attestation.environment,
    attestation.controller_service_name,
    attestation.controller_version_id,
    attestation.durable_object_namespace_binding,
    attestation.durable_object_class,
    attestation.jurisdiction,
    attestation.canonical_name_sha256,
    attestation.object_id_sha256,
    attestation.shard.contract_version,
    attestation.shard.ring_generation,
    attestation.shard.shard_count,
    attestation.shard.shard_index,
    attestation.shard.instance_name,
    claim.campaignId,
    claim.claimDigestSha256,
    readinessResultSha256,
  ];
}

async function placementMatches(
  row: PlacementStoredRow,
  claim: ShardActivationCampaignClaim,
  readinessResultSha256: string,
  verified: VerifiedShardPlacementAttestationV1,
): Promise<boolean> {
  if (
    row.activation_id < 1 ||
    row.placement_event_sequence < 1 ||
    row.recorded_at < 1 ||
    row.campaign_id !== claim.campaignId ||
    row.claim_digest_sha256 !== claim.claimDigestSha256 ||
    row.readiness_result_sha256 !== readinessResultSha256 ||
    !LOWER_HEX_64.test(row.activation_digest_sha256) ||
    !LOWER_HEX_64.test(row.consumption_digest_sha256)
  ) {
    return false;
  }
  try {
    const attestation = await parseShardPlacementAttestationV1({
      contract_version: row.contract_version,
      environment: row.environment,
      controller_service_name: row.controller_service_name,
      controller_version_id: row.controller_version_id,
      durable_object_namespace_binding: row.durable_object_namespace_binding,
      durable_object_class: row.durable_object_class,
      jurisdiction: row.jurisdiction,
      canonical_name_sha256: row.canonical_name_sha256,
      object_id_sha256: row.object_id_sha256,
      shard: {
        contract_version: row.shard_contract_version,
        ring_generation: row.ring_generation,
        shard_count: row.shard_count,
        shard_index: row.shard_index,
        instance_name: row.instance_name,
      },
    });
    return (
      JSON.stringify(attestation) === JSON.stringify(verified.attestation) &&
      row.placement_attestation_digest_sha256 === verified.attestationDigestSha256 &&
      (await shardPlacementAttestationDigest(attestation)) === verified.attestationDigestSha256
    );
  } catch {
    return false;
  }
}

function isPlacementStoredRow(value: Record<string, unknown> | null): value is PlacementStoredRow {
  if (value === null || Object.keys(value).length !== 23) return false;
  return (
    Number.isSafeInteger(value.placement_event_sequence) &&
    typeof value.placement_attestation_digest_sha256 === "string" &&
    typeof value.contract_version === "number" &&
    typeof value.environment === "string" &&
    typeof value.controller_service_name === "string" &&
    typeof value.controller_version_id === "string" &&
    typeof value.durable_object_namespace_binding === "string" &&
    typeof value.durable_object_class === "string" &&
    typeof value.jurisdiction === "string" &&
    typeof value.canonical_name_sha256 === "string" &&
    typeof value.object_id_sha256 === "string" &&
    typeof value.shard_contract_version === "number" &&
    typeof value.ring_generation === "number" &&
    typeof value.shard_count === "number" &&
    typeof value.shard_index === "number" &&
    typeof value.instance_name === "string" &&
    Number.isSafeInteger(value.activation_id) &&
    typeof value.campaign_id === "string" &&
    typeof value.claim_digest_sha256 === "string" &&
    typeof value.readiness_result_sha256 === "string" &&
    typeof value.activation_digest_sha256 === "string" &&
    typeof value.consumption_digest_sha256 === "string" &&
    Number.isSafeInteger(value.recorded_at)
  );
}
