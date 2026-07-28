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
const EXPECTED_AUTHORIZATION_COLUMNS = [
  "authorization_id_sha256",
  "execution_nonce_sha256",
  "campaign_nonce_sha256",
  "subject_digest_sha256",
  "contract_version",
  "authorization_contract",
  "issuer",
  "key_id",
  "signer_spki_sha256",
  "environment",
  "controller_service_name",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "campaign_lifetime_seconds",
  "permit_issued_at",
  "permit_expires_at",
  "campaign_id",
  "campaign_digest_sha256",
  "campaign_expires_at",
  "consumed_by_admin_id",
  "consumed_at",
].join(",");
const EXPECTED_TICKET_COLUMNS = [
  "ticket_id_sha256",
  "contract_version",
  "ticket_contract",
  "authorization_id_sha256",
  "campaign_id",
  "campaign_digest_sha256",
  "execution_nonce_sha256",
  "permit_subject_digest_sha256",
  "application_database_identity_sha256",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "execution_plan_sha256",
  "operation_schedule_sha256",
  "preparation_operation_id_sha256",
  "claim_operation_id_sha256",
  "activation_operation_id_sha256",
  "controller_enable_operation_id_sha256",
  "controller_disable_operation_id_sha256",
  "release_sha256",
  "publication_sha256",
  "execution_activation_sha256",
  "runner_build_sha256",
  "controller_service_name",
  "controller_baseline_version_id",
  "controller_enabled_version_id",
  "controller_disabled_version_id",
  "edge_baseline_version_id",
  "action_gate_inventory_sha256",
  "action_gate_count",
  "all_action_gates_false",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "environment",
  "prepared_by_admin_id",
  "activation_deadline_at",
  "execution_deadline_at",
  "ticket_digest_sha256",
  "prepared_at",
].join(",");
const EXPECTED_TICKET_ACTIVATION_COLUMNS = [
  "ticket_id_sha256",
  "contract_version",
  "activation_contract",
  "authority_claim_digest_sha256",
  "authority_claim_acquired_receipt_sha256",
  "authority_claim_operation_id_sha256",
  "authority_activation_operation_id_sha256",
  "authority_database_identity_sha256",
  "authority_ledger_identity_sha256",
  "authority_version_id",
  "activation_credential_id_sha256",
  "activation_request_id_sha256",
  "activation_digest_sha256",
  "activated_by_admin_id",
  "activated_at",
].join(",");
const EXPECTED_TICKET_AUTHORITY_ACK_COLUMNS = [
  "ticket_id_sha256",
  "contract_version",
  "acknowledgement_contract",
  "application_ticket_digest_sha256",
  "authority_claim_digest_sha256",
  "application_activation_digest_sha256",
  "authority_activation_terminal_receipt_sha256",
  "authority_ledger_head_sha256",
  "authority_database_identity_sha256",
  "authority_version_id",
  "authority_read_credential_id_sha256",
  "authority_read_request_id_sha256",
  "acknowledgement_digest_sha256",
  "acknowledged_by_admin_id",
  "acknowledged_at",
].join(",");
const EXPECTED_SCHEMA_OBJECTS = [
  "index:idx_relay_container_shard_placement_attestations_candidate",
  "index:idx_relay_container_shard_placement_attestations_object",
  "index:idx_relay_container_shard_placement_authorizations_candidate",
  "index:idx_relay_container_shard_placement_events_candidate",
  "index:idx_relay_container_shard_placement_execution_ticket_activations_claim",
  "index:idx_relay_container_shard_placement_execution_ticket_authority_acks_claim",
  "index:idx_relay_container_shard_placement_execution_tickets_candidate",
  "index:idx_relay_container_shard_placement_execution_tickets_plan",
  "table:relay_container_shard_placement_attestations",
  "table:relay_container_shard_placement_events",
  "table:relay_container_shard_placement_execution_ticket_activations",
  "table:relay_container_shard_placement_execution_ticket_authority_acks",
  "table:relay_container_shard_placement_execution_tickets",
  "table:relay_container_shard_placement_mutation_authorizations",
  "trigger:relay_container_shard_activation_campaign_authorization_guard",
  "trigger:relay_container_shard_activation_campaign_claim_execution_ticket_guard",
  "trigger:relay_container_shard_placement_attestation_delete_guard",
  "trigger:relay_container_shard_placement_attestation_event_append",
  "trigger:relay_container_shard_placement_attestation_insert_guard",
  "trigger:relay_container_shard_placement_attestation_update_guard",
  "trigger:relay_container_shard_placement_authorization_delete_guard",
  "trigger:relay_container_shard_placement_authorization_insert_guard",
  "trigger:relay_container_shard_placement_authorization_update_guard",
  "trigger:relay_container_shard_placement_event_delete_guard",
  "trigger:relay_container_shard_placement_event_insert_guard",
  "trigger:relay_container_shard_placement_event_update_guard",
  "trigger:relay_container_shard_placement_execution_ticket_activation_delete_guard",
  "trigger:relay_container_shard_placement_execution_ticket_activation_insert_guard",
  "trigger:relay_container_shard_placement_execution_ticket_activation_update_guard",
  "trigger:relay_container_shard_placement_execution_ticket_authority_ack_delete_guard",
  "trigger:relay_container_shard_placement_execution_ticket_authority_ack_insert_guard",
  "trigger:relay_container_shard_placement_execution_ticket_authority_ack_update_guard",
  "trigger:relay_container_shard_placement_execution_ticket_delete_guard",
  "trigger:relay_container_shard_placement_execution_ticket_insert_guard",
  "trigger:relay_container_shard_placement_execution_ticket_update_guard",
].join("|");

const SCHEMA_READINESS_SQL = `
SELECT
  (SELECT COUNT(1) FROM d1_migrations
   WHERE name IN (
     '0061_relay_container_shard_placement_attestations.sql',
     '0062_relay_container_shard_placement_events.sql',
     '0063_relay_container_shard_placement_mutation_authorizations.sql',
     '0064_relay_container_shard_placement_execution_tickets.sql',
     '0065_relay_container_shard_placement_pre_enable_grants.sql',
     '0066_relay_container_shard_placement_dispatch_consumptions.sql'
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
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info(
       'relay_container_shard_placement_mutation_authorizations'
     )
     ORDER BY cid
   )) AS authorization_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info(
       'relay_container_shard_placement_execution_tickets'
     )
     ORDER BY cid
   )) AS ticket_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info(
       'relay_container_shard_placement_execution_ticket_activations'
     )
     ORDER BY cid
   )) AS ticket_activation_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name
     FROM pragma_table_info(
       'relay_container_shard_placement_execution_ticket_authority_acks'
     )
     ORDER BY cid
   )) AS ticket_authority_ack_columns,
  (SELECT group_concat(type || ':' || name, '|') FROM (
     SELECT type, name
     FROM sqlite_master
     WHERE (
       tbl_name IN (
         'relay_container_shard_placement_attestations',
         'relay_container_shard_placement_events',
         'relay_container_shard_placement_mutation_authorizations',
         'relay_container_shard_placement_execution_tickets',
         'relay_container_shard_placement_execution_ticket_activations',
         'relay_container_shard_placement_execution_ticket_authority_acks'
       )
       OR name IN (
            'relay_container_shard_activation_campaign_authorization_guard',
            'relay_container_shard_activation_campaign_claim_execution_ticket_guard'
       )
     )
       AND name NOT LIKE 'sqlite_autoindex_%'
     ORDER BY type || ':' || name
   )) AS schema_objects
`.trim();

const AUTHORIZATION_READBACK_SQL = `
SELECT
  authorization.authorization_id_sha256,
  authorization.subject_digest_sha256,
  ticket.ticket_id_sha256,
  ticket.ticket_digest_sha256,
  ticket.activation_deadline_at,
  ticket.execution_deadline_at,
  activation.authority_claim_digest_sha256,
  activation.authority_claim_acquired_receipt_sha256,
  activation.activation_digest_sha256,
  activation.activated_at,
  acknowledgement.authority_activation_terminal_receipt_sha256,
  acknowledgement.authority_ledger_head_sha256,
  acknowledgement.acknowledgement_digest_sha256,
  acknowledgement.acknowledged_at,
  authorization.consumed_at,
  authorization.campaign_expires_at,
  unixepoch() AS database_now
FROM relay_container_shard_placement_mutation_authorizations AS authorization
JOIN relay_container_shard_activation_campaigns AS campaign
  ON campaign.campaign_id = authorization.campaign_id
 AND campaign.campaign_digest_sha256 =
       authorization.campaign_digest_sha256
 AND campaign.controller_version_id =
       authorization.controller_version_id
 AND campaign.action_gate_inventory_sha256 =
       authorization.action_gate_inventory_sha256
 AND campaign.foundation_manifest_sha256 =
       authorization.foundation_manifest_sha256
 AND campaign.runtime_build_id = authorization.runtime_build_id
 AND campaign.ring_generation = authorization.ring_generation
 AND campaign.shard_count = authorization.shard_count
 AND campaign.environment = authorization.environment
 AND campaign.expires_at = authorization.campaign_expires_at
JOIN relay_container_shard_placement_execution_tickets AS ticket
  ON ticket.authorization_id_sha256 =
       authorization.authorization_id_sha256
 AND ticket.campaign_id = authorization.campaign_id
 AND ticket.campaign_digest_sha256 =
       authorization.campaign_digest_sha256
 AND ticket.execution_nonce_sha256 =
       authorization.execution_nonce_sha256
 AND ticket.permit_subject_digest_sha256 =
       authorization.subject_digest_sha256
 AND ticket.controller_enabled_version_id =
       authorization.controller_version_id
 AND ticket.action_gate_inventory_sha256 =
       authorization.action_gate_inventory_sha256
 AND ticket.foundation_manifest_sha256 =
       authorization.foundation_manifest_sha256
 AND ticket.runtime_build_id = authorization.runtime_build_id
 AND ticket.ring_generation = authorization.ring_generation
 AND ticket.shard_count = authorization.shard_count
 AND ticket.environment = authorization.environment
JOIN relay_container_shard_placement_execution_ticket_activations AS activation
  ON activation.ticket_id_sha256 = ticket.ticket_id_sha256
 AND activation.authority_database_identity_sha256 =
       ticket.authority_database_identity_sha256
 AND activation.authority_claim_operation_id_sha256 =
       ticket.claim_operation_id_sha256
 AND activation.authority_activation_operation_id_sha256 =
       ticket.activation_operation_id_sha256
JOIN relay_container_shard_placement_execution_ticket_authority_acks AS acknowledgement
  ON acknowledgement.ticket_id_sha256 = ticket.ticket_id_sha256
 AND acknowledgement.authority_claim_digest_sha256 =
       activation.authority_claim_digest_sha256
 AND acknowledgement.application_ticket_digest_sha256 =
       ticket.ticket_digest_sha256
 AND acknowledgement.application_activation_digest_sha256 =
       activation.activation_digest_sha256
 AND acknowledgement.authority_database_identity_sha256 =
       activation.authority_database_identity_sha256
 AND acknowledgement.authority_version_id = activation.authority_version_id
WHERE authorization.campaign_id = ?1
  AND authorization.controller_version_id = ?2
  AND authorization.action_gate_inventory_sha256 = ?3
  AND authorization.ring_generation = ?4
  AND authorization.shard_count = ?5
  AND authorization.environment = ?6
  AND authorization.consumed_at <= unixepoch()
  AND ticket.prepared_at <= unixepoch()
  AND activation.activated_at <= unixepoch()
  AND acknowledgement.acknowledged_at <= unixepoch()
  AND unixepoch() < ticket.execution_deadline_at
  AND unixepoch() < authorization.campaign_expires_at
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_shard_activation_campaign_seals AS seal
    WHERE seal.campaign_id = authorization.campaign_id
  )
LIMIT 1
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

export interface ShardPlacementMutationAuthorizationCandidate {
  campaignId: string;
  controllerVersionId: string;
  actionGateInventorySha256: string;
  ringGeneration: number;
  shardCount: number;
  environment: string;
}

interface PlacementAuthorizationRow extends Record<string, unknown> {
  authorization_id_sha256: string;
  subject_digest_sha256: string;
  ticket_id_sha256: string;
  ticket_digest_sha256: string;
  activation_deadline_at: number;
  execution_deadline_at: number;
  authority_claim_digest_sha256: string;
  authority_claim_acquired_receipt_sha256: string;
  activation_digest_sha256: string;
  activated_at: number;
  authority_activation_terminal_receipt_sha256: string;
  authority_ledger_head_sha256: string;
  acknowledgement_digest_sha256: string;
  acknowledged_at: number;
  consumed_at: number;
  campaign_expires_at: number;
  database_now: number;
}

export async function requireShardPlacementMutationAuthorization(
  database: PlacementDatabase,
  candidate: ShardPlacementMutationAuthorizationCandidate,
): Promise<void> {
  if (
    !LOWER_HEX_64.test(candidate.campaignId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      candidate.controllerVersionId,
    ) ||
    !LOWER_HEX_64.test(candidate.actionGateInventorySha256) ||
    !Number.isSafeInteger(candidate.ringGeneration) ||
    candidate.ringGeneration < 1 ||
    candidate.ringGeneration > 1_000_000 ||
    !Number.isSafeInteger(candidate.shardCount) ||
    candidate.shardCount < 1 ||
    candidate.shardCount > 1_024 ||
    candidate.environment !== "staging"
  ) {
    throw new ProtocolError(
      "invalid_shard_placement_mutation_authorization",
      400,
    );
  }
  const session = await placementSession(database);
  let value: Record<string, unknown> | null;
  try {
    value = await session
      .prepare(AUTHORIZATION_READBACK_SQL)
      .bind(
        candidate.campaignId,
        candidate.controllerVersionId,
        candidate.actionGateInventorySha256,
        candidate.ringGeneration,
        candidate.shardCount,
        candidate.environment,
      )
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError(
      "shard_placement_mutation_authorization_readback_unavailable",
      503,
    );
  }
  if (!isPlacementAuthorizationRow(value)) {
    throw new ProtocolError(
      "shard_placement_mutation_authorization_required",
      403,
    );
  }
  if (
    value.consumed_at > value.database_now ||
    value.activated_at > value.database_now ||
    value.acknowledged_at > value.database_now ||
    value.database_now >= value.execution_deadline_at ||
    value.database_now >= value.campaign_expires_at
  ) {
    throw new ProtocolError(
      "shard_placement_mutation_authorization_readback_invalid",
      502,
    );
  }
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
      Object.keys(schema).length !== 8 ||
      schema.migration_count !== 6 ||
      schema.placement_columns !== EXPECTED_COLUMNS ||
      schema.event_columns !== EXPECTED_EVENT_COLUMNS ||
      schema.authorization_columns !== EXPECTED_AUTHORIZATION_COLUMNS ||
      schema.ticket_columns !== EXPECTED_TICKET_COLUMNS ||
      schema.ticket_activation_columns !== EXPECTED_TICKET_ACTIVATION_COLUMNS ||
      schema.ticket_authority_ack_columns !==
        EXPECTED_TICKET_AUTHORITY_ACK_COLUMNS ||
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

function isPlacementAuthorizationRow(
  value: Record<string, unknown> | null,
): value is PlacementAuthorizationRow {
  return (
    value !== null &&
    Object.keys(value).length === 17 &&
    typeof value.authorization_id_sha256 === "string" &&
    LOWER_HEX_64.test(value.authorization_id_sha256) &&
    typeof value.subject_digest_sha256 === "string" &&
    LOWER_HEX_64.test(value.subject_digest_sha256) &&
    typeof value.ticket_id_sha256 === "string" &&
    LOWER_HEX_64.test(value.ticket_id_sha256) &&
    typeof value.ticket_digest_sha256 === "string" &&
    LOWER_HEX_64.test(value.ticket_digest_sha256) &&
    typeof value.authority_claim_digest_sha256 === "string" &&
    LOWER_HEX_64.test(value.authority_claim_digest_sha256) &&
    typeof value.authority_claim_acquired_receipt_sha256 === "string" &&
    LOWER_HEX_64.test(value.authority_claim_acquired_receipt_sha256) &&
    typeof value.activation_digest_sha256 === "string" &&
    LOWER_HEX_64.test(value.activation_digest_sha256) &&
    typeof value.authority_activation_terminal_receipt_sha256 === "string" &&
    LOWER_HEX_64.test(
      value.authority_activation_terminal_receipt_sha256,
    ) &&
    typeof value.authority_ledger_head_sha256 === "string" &&
    LOWER_HEX_64.test(value.authority_ledger_head_sha256) &&
    typeof value.acknowledgement_digest_sha256 === "string" &&
    LOWER_HEX_64.test(value.acknowledgement_digest_sha256) &&
    Number.isSafeInteger(value.activation_deadline_at) &&
    (value.activation_deadline_at as number) > 0 &&
    Number.isSafeInteger(value.execution_deadline_at) &&
    (value.execution_deadline_at as number) >
      (value.activation_deadline_at as number) &&
    Number.isSafeInteger(value.activated_at) &&
    (value.activated_at as number) > 0 &&
    Number.isSafeInteger(value.acknowledged_at) &&
    (value.acknowledged_at as number) > 0 &&
    Number.isSafeInteger(value.consumed_at) &&
    (value.consumed_at as number) > 0 &&
    Number.isSafeInteger(value.campaign_expires_at) &&
    (value.campaign_expires_at as number) > 0 &&
    Number.isSafeInteger(value.database_now) &&
    (value.database_now as number) > 0
  );
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
