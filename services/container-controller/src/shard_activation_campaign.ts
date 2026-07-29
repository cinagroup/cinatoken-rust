import {
  shardActivationDigest,
  validateShardActivationInput,
  type ShardActivationInput,
} from "./shard_activation";
import {
  ProtocolError,
  type OperationShard,
  type ShardActivationCampaignCredential,
} from "./protocol";

export const SHARD_ACTIVATION_CAMPAIGN_CONTRACT =
  "cinatoken-relay-container-shard-activation-campaign-v1";

const CAMPAIGN_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken:relay-container-shard-activation-campaign:v1\0",
);
const CLAIM_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken:relay-container-shard-activation-campaign-claim:v1\0",
);
const CONSUMPTION_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken:relay-container-shard-activation-campaign-consumption:v1\0",
);
const ACTION_GATE_INVENTORY_DIGEST_DOMAIN = new TextEncoder().encode(
  "cinatoken:container-controller:action-gate-inventory:v1\0",
);
const ACTIVATION_PROBE_ID_DOMAIN =
  "cinatoken:relay-container-shard-activation-probe:v1\0";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES = [
  "CONTAINER_CONTROLLER_ENABLED",
  "CONTAINER_EXECUTION_ENABLED",
  "CONTAINER_READINESS_PROBE_ENABLED",
  "CONTAINER_READINESS_WAKE_ENABLED",
  "CONTAINER_STORAGE_R2_READ_ENABLED",
  "CONTAINER_STORAGE_R2_WRITE_ENABLED",
  "CONTAINER_STORAGE_KV_READ_ENABLED",
  "CONTAINER_STORAGE_D1_READ_ENABLED",
  "CONTAINER_PROVIDER_ATTEMPT_JOURNAL_ENABLED",
  "CONTAINER_PROVIDER_CLIENT_ENABLED",
  "CONTAINER_PROVIDER_EGRESS_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED",
  "CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED",
  "CONTAINER_PROVIDER_RETRY_ENABLED",
  "CONTAINER_PROVIDER_ATTEMPT_STAGING_VERIFIED",
  "CONTAINER_GLOBAL_TERMINAL_ACK_ENABLED",
  "CONTAINER_GLOBAL_TERMINAL_COMPACTION_ENABLED",
  "CONTAINER_OPERATION_RECOVERY_INTENT_V1_ENABLED",
  "CONTAINER_OPERATION_RECOVERY_INTENT_V1_STAGING_VERIFIED",
  "CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED",
] as const;

export type CampaignActionGateName =
  (typeof SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES)[number];
export type CampaignActionGateEnvironment = {
  [K in CampaignActionGateName]: string;
};
type CampaignDatabase = Pick<D1Database, "withSession">;
type CampaignSession = ReturnType<CampaignDatabase["withSession"]>;

export interface CampaignActionGateInventory {
  allActionGatesFalse: boolean;
  count: number;
  digestSha256: string;
  gates: readonly {
    enabled: boolean;
    name: CampaignActionGateName;
  }[];
}

export interface ShardActivationCampaignClaimInput {
  credential: ShardActivationCampaignCredential;
  controllerVersionId: string;
  actionGateInventory: CampaignActionGateInventory;
  shard: OperationShard;
  runtimeProtocolVersion: number;
  environment: "staging" | "production";
  probeId: string;
}

export interface ShardActivationCampaignClaim {
  campaignId: string;
  campaignDigestSha256: string;
  claimDigestSha256: string;
  controllerVersionId: string;
  actionGateInventorySha256: string;
  actionGateCount: number;
  foundationManifestSha256: string;
  runtimeBuildId: string;
  shard: OperationShard;
  runtimeProtocolVersion: number;
  runtimeContractVersion: number;
  activationGeneration: number;
  probeId: string;
  environment: "staging" | "production";
  claimedAt: number;
  recovered: boolean;
}

export type ShardActivationCampaignAcquire =
  | { kind: "claimed"; claim: ShardActivationCampaignClaim }
  | {
      kind: "completed";
      claim: ShardActivationCampaignClaim;
      readinessResultSha256: string;
    };

export interface ShardActivationCampaignConsumptionResult {
  campaignId: string;
  campaignDigestSha256: string;
  claimDigestSha256: string;
  activationDigestSha256: string;
  consumptionDigestSha256: string;
  claimedShardCount: number;
  consumedShardCount: number;
  shardCount: number;
  sealed: boolean;
}

interface CampaignStoredRow extends Record<string, unknown> {
  campaign_id: string;
  campaign_nonce_sha256: string;
  controller_version_id: string;
  action_gate_inventory_sha256: string;
  action_gate_count: number;
  all_action_gates_false: number;
  foundation_manifest_sha256: string;
  runtime_build_id: string;
  ring_generation: number;
  shard_count: number;
  shard_contract_version: number;
  runtime_protocol_version: number;
  runtime_contract_version: number;
  activation_generation: number;
  environment: string;
  created_by_admin_id: number;
  campaign_digest_sha256: string;
  created_at: number;
  expires_at: number;
  claimed_shard_count: number;
  consumed_shard_count: number;
  seal_reason: string | null;
  seal_detail_code: string | null;
  last_consumption_digest_sha256: string | null;
  sealed_at: number | null;
  database_now: number;
}

interface ClaimStoredRow extends Record<string, unknown> {
  campaign_id: string;
  shard_index: number;
  presented_nonce_sha256: string;
  campaign_digest_sha256: string;
  controller_version_id: string;
  action_gate_inventory_sha256: string;
  action_gate_count: number;
  all_action_gates_false: number;
  foundation_manifest_sha256: string;
  runtime_build_id: string;
  ring_generation: number;
  shard_count: number;
  instance_name: string;
  shard_contract_version: number;
  runtime_protocol_version: number;
  runtime_contract_version: number;
  activation_generation: number;
  probe_id: string;
  claim_digest_sha256: string;
  environment: string;
  claimed_at: number;
  consumed: number;
}

interface ConsumptionReadbackRow extends Record<string, unknown> {
  campaign_id: string;
  shard_index: number;
  claim_digest_sha256: string;
  probe_id: string;
  campaign_digest_sha256: string;
  controller_version_id: string;
  action_gate_inventory_sha256: string;
  action_gate_count: number;
  all_action_gates_false: number;
  foundation_manifest_sha256: string;
  ring_generation: number;
  shard_count: number;
  instance_name: string;
  shard_contract_version: number;
  runtime_protocol_version: number;
  runtime_contract_version: number;
  runtime_build_id: string;
  activation_generation: number;
  activation_probe_generation: number;
  environment: string;
  container_status: string;
  readiness_result_code: string;
  readiness_result_sha256: string;
  process_ready: number;
  runtime_execution_enabled: number;
  controller_execution_enabled: number;
  activation_digest_sha256: string;
  consumption_digest_sha256: string;
  readiness_checked_at: number;
  consumed_at: number;
  activation_id: number;
}

const CAMPAIGN_COLUMNS = [
  "campaign_id",
  "campaign_nonce_sha256",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "action_gate_count",
  "all_action_gates_false",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "shard_contract_version",
  "runtime_protocol_version",
  "runtime_contract_version",
  "activation_generation",
  "environment",
  "created_by_admin_id",
  "campaign_digest_sha256",
  "created_at",
  "expires_at",
].join(",");
const CLAIM_COLUMNS = [
  "campaign_id",
  "shard_index",
  "presented_nonce_sha256",
  "campaign_digest_sha256",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "action_gate_count",
  "all_action_gates_false",
  "foundation_manifest_sha256",
  "runtime_build_id",
  "ring_generation",
  "shard_count",
  "instance_name",
  "shard_contract_version",
  "runtime_protocol_version",
  "runtime_contract_version",
  "activation_generation",
  "probe_id",
  "claim_digest_sha256",
  "environment",
  "claimed_at",
].join(",");
const CONSUMPTION_COLUMNS = [
  "campaign_id",
  "shard_index",
  "claim_digest_sha256",
  "probe_id",
  "campaign_digest_sha256",
  "controller_version_id",
  "action_gate_inventory_sha256",
  "action_gate_count",
  "all_action_gates_false",
  "foundation_manifest_sha256",
  "ring_generation",
  "shard_count",
  "instance_name",
  "shard_contract_version",
  "runtime_protocol_version",
  "runtime_contract_version",
  "runtime_build_id",
  "activation_generation",
  "activation_probe_generation",
  "environment",
  "container_status",
  "readiness_result_code",
  "readiness_result_sha256",
  "process_ready",
  "runtime_execution_enabled",
  "controller_execution_enabled",
  "activation_digest_sha256",
  "consumption_digest_sha256",
  "readiness_checked_at",
  "consumed_at",
].join(",");
const SEAL_COLUMNS = [
  "campaign_id",
  "campaign_digest_sha256",
  "consumed_shard_count",
  "seal_reason",
  "seal_detail_code",
  "last_consumption_digest_sha256",
  "sealed_at",
].join(",");

const EXPECTED_SCHEMA_OBJECTS = [
  "table:relay_container_shard_activation_campaigns",
  "table:relay_container_shard_activation_campaign_claims",
  "table:relay_container_shard_activation_campaign_consumptions",
  "table:relay_container_shard_activation_campaign_seals",
  "view:relay_container_shard_activation_campaign_expiry_candidates",
  "index:idx_relay_container_shard_activation_campaigns_nonce",
  "index:idx_relay_container_shard_activation_campaigns_candidate",
  "index:idx_relay_container_shard_activation_campaign_claims_probe",
  "index:idx_relay_container_shard_activation_campaign_claims_digest",
  "index:idx_relay_container_shard_activation_campaign_claims_instance",
  "index:idx_relay_container_shard_activation_campaign_consumptions_activation",
  "index:idx_relay_container_shard_activation_campaign_consumptions_consumption",
  "index:idx_relay_container_shard_activation_campaign_consumptions_instance",
  "trigger:relay_container_shard_activation_campaign_insert_guard",
  "trigger:relay_container_shard_activation_campaign_update_guard",
  "trigger:relay_container_shard_activation_campaign_delete_guard",
  "trigger:relay_container_shard_activation_campaign_claim_insert_guard",
  "trigger:relay_container_shard_activation_campaign_claim_update_guard",
  "trigger:relay_container_shard_activation_campaign_claim_delete_guard",
  "trigger:relay_container_shard_activation_campaign_consumption_insert_guard",
  "trigger:relay_container_shard_activation_campaign_consumption_apply",
  "trigger:relay_container_shard_activation_campaign_consumption_update_guard",
  "trigger:relay_container_shard_activation_campaign_consumption_delete_guard",
  "trigger:relay_container_shard_activation_campaign_seal_insert_guard",
  "trigger:relay_container_shard_activation_campaign_seal_update_guard",
  "trigger:relay_container_shard_activation_campaign_seal_delete_guard",
  "trigger:relay_container_shard_activation_campaign_authority_guard",
].sort();

const SCHEMA_READINESS_SQL = `
SELECT
  (SELECT COUNT(1) FROM d1_migrations
   WHERE name = '0055_relay_container_shard_activation_campaigns.sql') AS migration_count,
  (SELECT group_concat(name, ',') FROM (
     SELECT name FROM pragma_table_info('relay_container_shard_activation_campaigns') ORDER BY cid
   )) AS campaign_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name FROM pragma_table_info('relay_container_shard_activation_campaign_claims') ORDER BY cid
   )) AS claim_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name FROM pragma_table_info('relay_container_shard_activation_campaign_consumptions') ORDER BY cid
   )) AS consumption_columns,
  (SELECT group_concat(name, ',') FROM (
     SELECT name FROM pragma_table_info('relay_container_shard_activation_campaign_seals') ORDER BY cid
   )) AS seal_columns,
  (SELECT group_concat(type || ':' || name, '|') FROM (
     SELECT type, name FROM sqlite_master
     WHERE name LIKE 'relay_container_shard_activation_campaign%'
        OR name LIKE 'idx_relay_container_shard_activation_campaign%'
     ORDER BY type || ':' || name
   )) AS schema_objects
`.trim();

const CAMPAIGN_STATE_SQL = `
SELECT
  campaign.*,
  (SELECT COUNT(1) FROM relay_container_shard_activation_campaign_claims AS claim
   WHERE claim.campaign_id = campaign.campaign_id) AS claimed_shard_count,
  (SELECT COUNT(1) FROM relay_container_shard_activation_campaign_consumptions AS consumption
   WHERE consumption.campaign_id = campaign.campaign_id) AS consumed_shard_count,
  seal.seal_reason,
  seal.seal_detail_code,
  seal.last_consumption_digest_sha256,
  seal.sealed_at,
  unixepoch() AS database_now
FROM relay_container_shard_activation_campaigns AS campaign
LEFT JOIN relay_container_shard_activation_campaign_seals AS seal
  ON seal.campaign_id = campaign.campaign_id
WHERE campaign.campaign_id = ?1
LIMIT 1
`.trim();

const INSERT_CLAIM_SQL = `
INSERT INTO relay_container_shard_activation_campaign_claims (
  campaign_id, shard_index, presented_nonce_sha256, campaign_digest_sha256,
  controller_version_id, action_gate_inventory_sha256, action_gate_count,
  all_action_gates_false, foundation_manifest_sha256, runtime_build_id,
  ring_generation, shard_count, instance_name, shard_contract_version,
  runtime_protocol_version, runtime_contract_version, activation_generation,
  probe_id, claim_digest_sha256, environment
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
  ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
)
`.trim();

const CLAIM_READBACK_SQL = `
SELECT claim.*,
  EXISTS(
    SELECT 1 FROM relay_container_shard_activation_campaign_consumptions AS consumption
    WHERE consumption.campaign_id = claim.campaign_id
      AND consumption.shard_index = claim.shard_index
  ) AS consumed
FROM relay_container_shard_activation_campaign_claims AS claim
WHERE claim.campaign_id = ?1 AND claim.shard_index = ?2
LIMIT 1
`.trim();

const INSERT_CONSUMPTION_SQL = `
INSERT INTO relay_container_shard_activation_campaign_consumptions (
  campaign_id, shard_index, claim_digest_sha256, probe_id,
  campaign_digest_sha256, controller_version_id,
  action_gate_inventory_sha256, action_gate_count, all_action_gates_false,
  foundation_manifest_sha256, ring_generation, shard_count, instance_name,
  shard_contract_version, runtime_protocol_version, runtime_contract_version,
  runtime_build_id, activation_generation, activation_probe_generation,
  environment, container_status, readiness_result_code, readiness_result_sha256,
  process_ready, runtime_execution_enabled, controller_execution_enabled,
  activation_digest_sha256, consumption_digest_sha256, readiness_checked_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
  ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
  ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
)
`.trim();

const CONSUMPTION_READBACK_SQL = `
SELECT consumption.*, activation.activation_id
FROM relay_container_shard_activation_campaign_consumptions AS consumption
JOIN relay_container_shard_activations AS activation
  ON activation.controller_version_id = consumption.controller_version_id
 AND activation.runtime_build_id = consumption.runtime_build_id
 AND activation.ring_generation = consumption.ring_generation
 AND activation.shard_index = consumption.shard_index
 AND activation.activation_digest_sha256 = consumption.activation_digest_sha256
WHERE consumption.campaign_id = ?1 AND consumption.shard_index = ?2
LIMIT 1
`.trim();

const MATERIALIZE_EXPIRY_SQL = `
INSERT OR IGNORE INTO relay_container_shard_activation_campaign_seals (
  campaign_id, campaign_digest_sha256, consumed_shard_count, seal_reason,
  seal_detail_code, last_consumption_digest_sha256
)
SELECT campaign_id, campaign_digest_sha256, consumed_shard_count, 'expired',
       'campaign_expired', last_consumption_digest_sha256
FROM relay_container_shard_activation_campaign_expiry_candidates
WHERE campaign_id = ?1
`.trim();

const INSERT_FAILED_SEAL_SQL = `
INSERT OR IGNORE INTO relay_container_shard_activation_campaign_seals (
  campaign_id, campaign_digest_sha256, consumed_shard_count, seal_reason,
  seal_detail_code, last_consumption_digest_sha256
)
SELECT campaign.campaign_id, campaign.campaign_digest_sha256,
  (SELECT COUNT(1) FROM relay_container_shard_activation_campaign_consumptions AS consumption
   WHERE consumption.campaign_id = campaign.campaign_id),
  'failed', ?2,
  (SELECT consumption.consumption_digest_sha256
   FROM relay_container_shard_activation_campaign_consumptions AS consumption
   WHERE consumption.campaign_id = campaign.campaign_id
   ORDER BY consumption.consumed_at DESC, consumption.shard_index DESC LIMIT 1)
FROM relay_container_shard_activation_campaigns AS campaign
WHERE campaign.campaign_id = ?1
`.trim();

export async function campaignActionGateInventory(
  env: CampaignActionGateEnvironment,
): Promise<CampaignActionGateInventory> {
  const parts: string[] = [];
  const gates: {
    enabled: boolean;
    name: CampaignActionGateName;
  }[] = [];
  let allActionGatesFalse = true;
  for (const name of SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES) {
    const value = env[name];
    parts.push(name, value);
    gates.push({ enabled: value === "true", name });
    allActionGatesFalse &&= value === "false";
  }
  return {
    allActionGatesFalse,
    count: SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length,
    digestSha256: await digestParts(ACTION_GATE_INVENTORY_DIGEST_DOMAIN, parts),
    gates,
  };
}

export async function activationCampaignProbeId(
  campaignId: string,
  shardIndex: number,
): Promise<string> {
  if (!LOWER_HEX_64.test(campaignId) || !integerInRange(shardIndex, 0, 1_023)) {
    throw new ProtocolError("invalid_shard_activation_campaign", 400);
  }
  return sha256Hex(`${ACTIVATION_PROBE_ID_DOMAIN}${campaignId}\0${shardIndex}`);
}

export async function claimShardActivationCampaign(
  database: CampaignDatabase,
  input: ShardActivationCampaignClaimInput,
): Promise<ShardActivationCampaignAcquire> {
  validateClaimInput(input);
  const expectedProbeId = await activationCampaignProbeId(
    input.credential.campaign_id,
    input.shard.shard_index,
  );
  if (input.probeId !== expectedProbeId) {
    throw new ProtocolError("shard_activation_campaign_probe_identity_mismatch", 409);
  }
  const session = await campaignSession(database);
  const campaign = await readCampaign(session, input.credential.campaign_id);
  if (!isCampaignStoredRow(campaign)) {
    throw new ProtocolError("shard_activation_campaign_not_found", 409);
  }
  await validateCampaignDigest(campaign);
  const presentedNonceSha256 = await sha256Hex(input.credential.nonce);
  if (campaign.campaign_nonce_sha256 !== presentedNonceSha256) {
    throw new ProtocolError("shard_activation_campaign_nonce_invalid", 403);
  }
  if (!campaignMatchesClaimInput(campaign, input)) {
    throw new ProtocolError("shard_activation_campaign_candidate_mismatch", 409);
  }
  const claimDigestSha256 = await claimDigest(
    campaign,
    input.shard,
    input.probeId,
    presentedNonceSha256,
  );
  const bindings = claimBindings(
    campaign,
    input.shard,
    input.probeId,
    presentedNonceSha256,
    claimDigestSha256,
  );

  const existingBeforeClaim = await readClaim(
    session,
    input.credential.campaign_id,
    input.shard.shard_index,
  );
  if (existingBeforeClaim !== null) {
    if (!isClaimStoredRow(existingBeforeClaim) || !claimMatches(existingBeforeClaim, bindings)) {
      throw new ProtocolError("shard_activation_campaign_replayed", 409);
    }
    const claim = claimResult(existingBeforeClaim, true);
    if (existingBeforeClaim.consumed === 1) {
      const consumption = await readConsumption(
        session,
        input.credential.campaign_id,
        input.shard.shard_index,
      );
      if (
        !isConsumptionReadbackRow(consumption) ||
        !consumptionMatchesClaim(consumption, existingBeforeClaim)
      ) {
        throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
      }
      return {
        kind: "completed",
        claim,
        readinessResultSha256: consumption.readiness_result_sha256,
      };
    }
    await materializeExpiredCampaign(session, input.credential.campaign_id);
    classifyCampaignTerminal(await readCampaign(session, input.credential.campaign_id));
    return { kind: "claimed", claim };
  }

  await materializeExpiredCampaign(session, input.credential.campaign_id);
  assertCampaignClaimEligible(
    requireCampaignRow(await readCampaign(session, input.credential.campaign_id)),
    input,
    presentedNonceSha256,
  );

  let recovered = false;
  try {
    const result = await session.prepare(INSERT_CLAIM_SQL).bind(...bindings).run();
    if (result?.success !== true || result.meta?.changes !== 1) {
      throw new Error("campaign claim did not insert exactly one row");
    }
  } catch {
    const existing = await readClaim(
      session,
      input.credential.campaign_id,
      input.shard.shard_index,
    );
    if (
      isClaimStoredRow(existing) &&
      claimMatches(existing, bindings)
    ) {
      if (existing.consumed === 1) {
        const consumption = await readConsumption(
          session,
          input.credential.campaign_id,
          input.shard.shard_index,
        );
        if (
          !isConsumptionReadbackRow(consumption) ||
          !consumptionMatchesClaim(consumption, existing)
        ) {
          throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
        }
        return {
          kind: "completed",
          claim: claimResult(existing, true),
          readinessResultSha256: consumption.readiness_result_sha256,
        };
      }
      const current = await readCampaign(session, input.credential.campaign_id);
      classifyCampaignTerminal(current);
      recovered = true;
    } else {
      await classifyClaimFailure(
        session,
        input,
        presentedNonceSha256,
        existing,
      );
    }
  }

  const stored = await readClaim(
    session,
    input.credential.campaign_id,
    input.shard.shard_index,
  );
  if (!isClaimStoredRow(stored) || !claimMatches(stored, bindings)) {
    throw new ProtocolError("shard_activation_campaign_claim_readback_invalid", 502);
  }
  if (stored.consumed === 1) {
    const consumption = await readConsumption(
      session,
      input.credential.campaign_id,
      input.shard.shard_index,
    );
    if (!isConsumptionReadbackRow(consumption) || !consumptionMatchesClaim(consumption, stored)) {
      throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
    }
    return {
      kind: "completed",
      claim: claimResult(stored, true),
      readinessResultSha256: consumption.readiness_result_sha256,
    };
  }
  return { kind: "claimed", claim: claimResult(stored, recovered) };
}

export async function readExistingShardActivationCampaignClaim(
  database: CampaignDatabase,
  input: ShardActivationCampaignClaimInput,
): Promise<ShardActivationCampaignAcquire> {
  validateClaimInput(input);
  const expectedProbeId = await activationCampaignProbeId(
    input.credential.campaign_id,
    input.shard.shard_index,
  );
  if (input.probeId !== expectedProbeId) {
    throw new ProtocolError("shard_activation_campaign_probe_identity_mismatch", 409);
  }
  const session = await campaignSession(database);
  const campaign = await readCampaign(session, input.credential.campaign_id);
  if (!isCampaignStoredRow(campaign)) {
    throw new ProtocolError("shard_activation_campaign_not_found", 409);
  }
  await validateCampaignDigest(campaign);
  const presentedNonceSha256 = await sha256Hex(input.credential.nonce);
  if (campaign.campaign_nonce_sha256 !== presentedNonceSha256) {
    throw new ProtocolError("shard_activation_campaign_nonce_invalid", 403);
  }
  if (!campaignMatchesClaimInput(campaign, input)) {
    throw new ProtocolError("shard_activation_campaign_candidate_mismatch", 409);
  }
  const expectedClaimDigestSha256 = await claimDigest(
    campaign,
    input.shard,
    input.probeId,
    presentedNonceSha256,
  );
  const bindings = claimBindings(
    campaign,
    input.shard,
    input.probeId,
    presentedNonceSha256,
    expectedClaimDigestSha256,
  );
  const stored = await readClaim(
    session,
    input.credential.campaign_id,
    input.shard.shard_index,
  );
  if (stored === null) {
    throw new ProtocolError("shard_activation_campaign_claim_missing", 409);
  }
  if (!isClaimStoredRow(stored) || !claimMatches(stored, bindings)) {
    throw new ProtocolError("shard_activation_campaign_replayed", 409);
  }
  const claim = claimResult(stored, true);
  if (stored.consumed === 1) {
    const consumption = await readConsumption(
      session,
      input.credential.campaign_id,
      input.shard.shard_index,
    );
    if (
      !isConsumptionReadbackRow(consumption) ||
      !consumptionMatchesClaim(consumption, stored)
    ) {
      throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
    }
    return {
      kind: "completed",
      claim,
      readinessResultSha256: consumption.readiness_result_sha256,
    };
  }
  classifyCampaignTerminal(campaign);
  return { kind: "claimed", claim };
}

export async function finalizeShardActivationCampaign(
  database: CampaignDatabase,
  claim: ShardActivationCampaignClaim,
  activation: ShardActivationInput,
  readinessResultSha256: string,
): Promise<ShardActivationCampaignConsumptionResult> {
  validateShardActivationInput(activation);
  if (
    !LOWER_HEX_64.test(readinessResultSha256) ||
    activation.readinessResultCode !== "process_ready_execution_disabled" ||
    !activation.processReady ||
    activation.runtimeExecutionEnabled ||
    activation.controllerExecutionEnabled ||
    activation.containerStatus !== "healthy" ||
    !claimMatchesActivation(claim, activation)
  ) {
    throw new ProtocolError("shard_activation_campaign_readiness_ineligible", 409);
  }
  const session = await campaignSession(database);
  await materializeExpiredCampaign(session, claim.campaignId);
  const activationDigestSha256 = await shardActivationDigest(activation);
  const consumptionDigestSha256 = await digestParts(CONSUMPTION_DIGEST_DOMAIN, [
    claim.campaignId,
    claim.campaignDigestSha256,
    claim.claimDigestSha256,
    activationDigestSha256,
    readinessResultSha256,
    activation.activatedAt.toString(),
  ]);
  const bindings = consumptionBindings(
    claim,
    activation,
    readinessResultSha256,
    activationDigestSha256,
    consumptionDigestSha256,
  );
  try {
    const result = await session.prepare(INSERT_CONSUMPTION_SQL).bind(...bindings).run();
    const changes = result?.meta?.changes;
    if (
      result?.success !== true ||
      typeof changes !== "number" ||
      !Number.isSafeInteger(changes) ||
      changes < 1 ||
      changes > 3
    ) {
      throw new Error("campaign finalization did not apply its activation");
    }
  } catch {
    const existing = await readConsumption(
      session,
      claim.campaignId,
      activation.shard.shard_index,
    );
    if (!isConsumptionReadbackRow(existing) || !consumptionMatches(existing, bindings)) {
      await classifyFinalizationFailure(session, claim, activation);
    }
  }

  const [campaignValue, consumptionValue] = await Promise.all([
    readCampaign(session, claim.campaignId),
    readConsumption(session, claim.campaignId, activation.shard.shard_index),
  ]);
  if (
    !isCampaignStoredRow(campaignValue) ||
    !isConsumptionReadbackRow(consumptionValue) ||
    !consumptionMatches(consumptionValue, bindings)
  ) {
    throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
  }
  await validateCampaignDigest(campaignValue);
  if (
    campaignValue.claimed_shard_count < campaignValue.consumed_shard_count ||
    campaignValue.claimed_shard_count > campaignValue.shard_count ||
    campaignValue.consumed_shard_count < 1 ||
    campaignValue.consumed_shard_count > campaignValue.shard_count ||
    (campaignValue.consumed_shard_count === campaignValue.shard_count) !==
      (campaignValue.seal_reason === "complete") ||
    (campaignValue.seal_reason !== null && campaignValue.seal_reason !== "complete") ||
    (campaignValue.seal_reason === "complete" &&
      (campaignValue.seal_detail_code !== "all_shards_consumed" ||
        !LOWER_HEX_64.test(campaignValue.last_consumption_digest_sha256 ?? "") ||
        campaignValue.sealed_at === null))
  ) {
    throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
  }
  return {
    campaignId: campaignValue.campaign_id,
    campaignDigestSha256: campaignValue.campaign_digest_sha256,
    claimDigestSha256: claim.claimDigestSha256,
    activationDigestSha256,
    consumptionDigestSha256,
    claimedShardCount: campaignValue.claimed_shard_count,
    consumedShardCount: campaignValue.consumed_shard_count,
    shardCount: campaignValue.shard_count,
    sealed: campaignValue.seal_reason === "complete",
  };
}

export async function sealShardActivationCampaignFailure(
  database: CampaignDatabase,
  campaignId: string,
  detailCode: "claim_execution_failed" | "readiness_rejected",
): Promise<void> {
  if (!LOWER_HEX_64.test(campaignId)) {
    throw new ProtocolError("invalid_shard_activation_campaign", 400);
  }
  const session = await campaignSession(database);
  try {
    await session.prepare(INSERT_FAILED_SEAL_SQL).bind(campaignId, detailCode).run();
  } catch {
    // The authoritative readback below distinguishes an exact prior seal from failure.
  }
  const campaign = await readCampaign(session, campaignId);
  if (
    !isCampaignStoredRow(campaign) ||
    campaign.seal_reason !== "failed" ||
    campaign.seal_detail_code !== detailCode ||
    campaign.sealed_at === null
  ) {
    throw new ProtocolError("shard_activation_campaign_failure_seal_unavailable", 503);
  }
}

export async function campaignDigest(row: CampaignStoredRow): Promise<string> {
  return digestParts(CAMPAIGN_DIGEST_DOMAIN, [
    row.campaign_id,
    row.campaign_nonce_sha256,
    row.controller_version_id,
    row.action_gate_inventory_sha256,
    row.action_gate_count.toString(),
    row.all_action_gates_false === 1 ? "true" : "false",
    row.foundation_manifest_sha256,
    row.runtime_build_id,
    row.ring_generation.toString(),
    row.shard_count.toString(),
    row.shard_contract_version.toString(),
    row.runtime_protocol_version.toString(),
    row.runtime_contract_version.toString(),
    row.activation_generation.toString(),
    row.environment,
    row.created_by_admin_id.toString(),
    row.created_at.toString(),
    row.expires_at.toString(),
  ]);
}

async function campaignSession(database: CampaignDatabase): Promise<CampaignSession> {
  try {
    const session = database.withSession("first-primary");
    const schema = await session.prepare(SCHEMA_READINESS_SQL).first<Record<string, unknown>>();
    if (!campaignSchemaReady(schema)) {
      throw new ProtocolError("shard_activation_campaign_schema_unavailable", 503);
    }
    return session;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("shard_activation_campaign_schema_unavailable", 503);
  }
}

async function materializeExpiredCampaign(
  session: CampaignSession,
  campaignId: string,
): Promise<void> {
  try {
    await session.prepare(MATERIALIZE_EXPIRY_SQL).bind(campaignId).run();
  } catch {
    throw new ProtocolError("shard_activation_campaign_expiry_unavailable", 503);
  }
}

async function readCampaign(
  session: CampaignSession,
  campaignId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await session.prepare(CAMPAIGN_STATE_SQL).bind(campaignId).first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("shard_activation_campaign_readback_unavailable", 503);
  }
}

function requireCampaignRow(value: Record<string, unknown> | null): CampaignStoredRow {
  if (!isCampaignStoredRow(value)) {
    throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
  }
  return value;
}

async function readClaim(
  session: CampaignSession,
  campaignId: string,
  shardIndex: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await session
      .prepare(CLAIM_READBACK_SQL)
      .bind(campaignId, shardIndex)
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("shard_activation_campaign_readback_unavailable", 503);
  }
}

async function readConsumption(
  session: CampaignSession,
  campaignId: string,
  shardIndex: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await session
      .prepare(CONSUMPTION_READBACK_SQL)
      .bind(campaignId, shardIndex)
      .first<Record<string, unknown>>();
  } catch {
    throw new ProtocolError("shard_activation_campaign_readback_unavailable", 503);
  }
}

async function classifyClaimFailure(
  session: CampaignSession,
  input: ShardActivationCampaignClaimInput,
  presentedNonceSha256: string,
  claim: Record<string, unknown> | null,
): Promise<never> {
  const campaign = await readCampaign(session, input.credential.campaign_id);
  if (!isCampaignStoredRow(campaign)) {
    throw new ProtocolError("shard_activation_campaign_not_found", 409);
  }
  await validateCampaignDigest(campaign);
  if (campaign.campaign_nonce_sha256 !== presentedNonceSha256) {
    throw new ProtocolError("shard_activation_campaign_nonce_invalid", 403);
  }
  classifyCampaignTerminal(campaign);
  if (claim !== null) {
    throw new ProtocolError("shard_activation_campaign_replayed", 409);
  }
  if (!campaignMatchesClaimInput(campaign, input)) {
    throw new ProtocolError("shard_activation_campaign_candidate_mismatch", 409);
  }
  throw new ProtocolError("shard_activation_campaign_conflict", 409);
}

async function classifyFinalizationFailure(
  session: CampaignSession,
  claim: ShardActivationCampaignClaim,
  activation: ShardActivationInput,
): Promise<never> {
  const campaign = await readCampaign(session, claim.campaignId);
  if (!isCampaignStoredRow(campaign)) {
    throw new ProtocolError("shard_activation_campaign_not_found", 409);
  }
  await validateCampaignDigest(campaign);
  classifyCampaignTerminal(campaign);
  const storedClaim = await readClaim(session, claim.campaignId, activation.shard.shard_index);
  if (!isClaimStoredRow(storedClaim)) {
    throw new ProtocolError("shard_activation_campaign_claim_missing", 409);
  }
  if (storedClaim.consumed === 1) {
    throw new ProtocolError("shard_activation_campaign_replayed", 409);
  }
  if (!claimMatchesActivation(claim, activation)) {
    throw new ProtocolError("shard_activation_campaign_candidate_mismatch", 409);
  }
  throw new ProtocolError("shard_activation_campaign_conflict", 409);
}

function classifyCampaignTerminal(value: Record<string, unknown> | null): void {
  if (!isCampaignStoredRow(value)) {
    throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
  }
  if (value.seal_reason === "expired" || value.database_now >= value.expires_at) {
    throw new ProtocolError("shard_activation_campaign_expired", 409);
  }
  if (value.seal_reason !== null) {
    throw new ProtocolError("shard_activation_campaign_sealed", 409);
  }
  if (value.database_now < value.created_at) {
    throw new ProtocolError("shard_activation_campaign_not_started", 409);
  }
}

function validateClaimInput(input: ShardActivationCampaignClaimInput): void {
  validateCredential(input.credential);
  if (
    !VERSION_ID.test(input.controllerVersionId) ||
    !LOWER_HEX_64.test(input.actionGateInventory.digestSha256) ||
    input.actionGateInventory.count !== SHARD_ACTIVATION_CAMPAIGN_ACTION_GATES.length ||
    !input.actionGateInventory.allActionGatesFalse ||
    !LOWER_HEX_64.test(input.probeId) ||
    !integerInRange(input.runtimeProtocolVersion, 1, 1_000_000) ||
    !["staging", "production"].includes(input.environment) ||
    !validShard(input.shard)
  ) {
    throw new ProtocolError("invalid_shard_activation_campaign", 400);
  }
}

function validateCredential(credential: ShardActivationCampaignCredential): void {
  if (
    credential.contract_version !== 1 ||
    !LOWER_HEX_64.test(credential.campaign_id) ||
    !LOWER_HEX_64.test(credential.nonce) ||
    credential.confirm_consume !== true
  ) {
    throw new ProtocolError("invalid_shard_activation_campaign", 400);
  }
}

function assertCampaignClaimEligible(
  campaign: CampaignStoredRow,
  input: ShardActivationCampaignClaimInput,
  presentedNonceSha256: string,
): void {
  if (campaign.campaign_nonce_sha256 !== presentedNonceSha256) {
    throw new ProtocolError("shard_activation_campaign_nonce_invalid", 403);
  }
  classifyCampaignTerminal(campaign);
  if (!campaignMatchesClaimInput(campaign, input)) {
    throw new ProtocolError("shard_activation_campaign_candidate_mismatch", 409);
  }
}

function campaignMatchesClaimInput(
  campaign: CampaignStoredRow,
  input: ShardActivationCampaignClaimInput,
): boolean {
  return (
    campaign.controller_version_id === input.controllerVersionId &&
    campaign.action_gate_inventory_sha256 === input.actionGateInventory.digestSha256 &&
    campaign.action_gate_count === input.actionGateInventory.count &&
    campaign.all_action_gates_false === 1 &&
    campaign.ring_generation === input.shard.ring_generation &&
    campaign.shard_count === input.shard.shard_count &&
    campaign.shard_contract_version === input.shard.contract_version &&
    campaign.runtime_protocol_version === input.runtimeProtocolVersion &&
    campaign.environment === input.environment &&
    input.shard.shard_index >= 0 &&
    input.shard.shard_index < campaign.shard_count &&
    input.shard.instance_name ===
      `cinatoken-relay-shard-v1-${input.shard.shard_index.toString().padStart(4, "0")}`
  );
}

async function validateCampaignDigest(campaign: CampaignStoredRow): Promise<void> {
  if (campaign.campaign_digest_sha256 !== (await campaignDigest(campaign))) {
    throw new ProtocolError("shard_activation_campaign_readback_invalid", 502);
  }
}

async function claimDigest(
  campaign: CampaignStoredRow,
  shard: OperationShard,
  probeId: string,
  presentedNonceSha256: string,
): Promise<string> {
  return digestParts(CLAIM_DIGEST_DOMAIN, [
    campaign.campaign_id,
    presentedNonceSha256,
    campaign.campaign_digest_sha256,
    campaign.controller_version_id,
    campaign.action_gate_inventory_sha256,
    campaign.action_gate_count.toString(),
    campaign.foundation_manifest_sha256,
    campaign.runtime_build_id,
    shard.ring_generation.toString(),
    shard.shard_count.toString(),
    shard.shard_index.toString(),
    shard.instance_name,
    shard.contract_version.toString(),
    campaign.runtime_protocol_version.toString(),
    campaign.runtime_contract_version.toString(),
    campaign.activation_generation.toString(),
    probeId,
    campaign.environment,
  ]);
}

function claimBindings(
  campaign: CampaignStoredRow,
  shard: OperationShard,
  probeId: string,
  presentedNonceSha256: string,
  claimDigestSha256: string,
): unknown[] {
  return [
    campaign.campaign_id,
    shard.shard_index,
    presentedNonceSha256,
    campaign.campaign_digest_sha256,
    campaign.controller_version_id,
    campaign.action_gate_inventory_sha256,
    campaign.action_gate_count,
    1,
    campaign.foundation_manifest_sha256,
    campaign.runtime_build_id,
    shard.ring_generation,
    shard.shard_count,
    shard.instance_name,
    shard.contract_version,
    campaign.runtime_protocol_version,
    campaign.runtime_contract_version,
    campaign.activation_generation,
    probeId,
    claimDigestSha256,
    campaign.environment,
  ];
}

function claimMatches(row: ClaimStoredRow, expected: unknown[]): boolean {
  const actual = [
    row.campaign_id,
    row.shard_index,
    row.presented_nonce_sha256,
    row.campaign_digest_sha256,
    row.controller_version_id,
    row.action_gate_inventory_sha256,
    row.action_gate_count,
    row.all_action_gates_false,
    row.foundation_manifest_sha256,
    row.runtime_build_id,
    row.ring_generation,
    row.shard_count,
    row.instance_name,
    row.shard_contract_version,
    row.runtime_protocol_version,
    row.runtime_contract_version,
    row.activation_generation,
    row.probe_id,
    row.claim_digest_sha256,
    row.environment,
  ];
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function claimResult(row: ClaimStoredRow, recovered: boolean): ShardActivationCampaignClaim {
  return {
    campaignId: row.campaign_id,
    campaignDigestSha256: row.campaign_digest_sha256,
    claimDigestSha256: row.claim_digest_sha256,
    controllerVersionId: row.controller_version_id,
    actionGateInventorySha256: row.action_gate_inventory_sha256,
    actionGateCount: row.action_gate_count,
    foundationManifestSha256: row.foundation_manifest_sha256,
    runtimeBuildId: row.runtime_build_id,
    shard: {
      contract_version: row.shard_contract_version,
      ring_generation: row.ring_generation,
      shard_count: row.shard_count,
      shard_index: row.shard_index,
      instance_name: row.instance_name,
    },
    runtimeProtocolVersion: row.runtime_protocol_version,
    runtimeContractVersion: row.runtime_contract_version,
    activationGeneration: row.activation_generation,
    probeId: row.probe_id,
    environment: row.environment as "staging" | "production",
    claimedAt: row.claimed_at,
    recovered,
  };
}

function claimMatchesActivation(
  claim: ShardActivationCampaignClaim,
  activation: ShardActivationInput,
): boolean {
  return (
    claim.controllerVersionId === activation.controllerVersionId &&
    claim.runtimeBuildId === activation.runtimeBuildId &&
    claim.shard.contract_version === activation.shard.contract_version &&
    claim.shard.ring_generation === activation.shard.ring_generation &&
    claim.shard.shard_count === activation.shard.shard_count &&
    claim.shard.shard_index === activation.shard.shard_index &&
    claim.shard.instance_name === activation.shard.instance_name &&
    claim.runtimeProtocolVersion === activation.runtimeProtocolVersion &&
    claim.runtimeContractVersion === activation.runtimeContractVersion &&
    claim.activationGeneration === activation.activationGeneration &&
    claim.environment === activation.environment &&
    activation.activatedAt >= claim.claimedAt
  );
}

function consumptionBindings(
  claim: ShardActivationCampaignClaim,
  input: ShardActivationInput,
  readinessResultSha256: string,
  activationDigestSha256: string,
  consumptionDigestSha256: string,
): unknown[] {
  return [
    claim.campaignId,
    input.shard.shard_index,
    claim.claimDigestSha256,
    claim.probeId,
    claim.campaignDigestSha256,
    claim.controllerVersionId,
    claim.actionGateInventorySha256,
    claim.actionGateCount,
    1,
    claim.foundationManifestSha256,
    input.shard.ring_generation,
    input.shard.shard_count,
    input.shard.instance_name,
    input.shard.contract_version,
    input.runtimeProtocolVersion,
    input.runtimeContractVersion,
    input.runtimeBuildId,
    input.activationGeneration,
    input.activationProbeGeneration,
    input.environment,
    input.containerStatus,
    input.readinessResultCode,
    readinessResultSha256,
    1,
    input.runtimeExecutionEnabled ? 1 : 0,
    input.controllerExecutionEnabled ? 1 : 0,
    activationDigestSha256,
    consumptionDigestSha256,
    input.activatedAt,
  ];
}

function consumptionMatches(row: ConsumptionReadbackRow, expected: unknown[]): boolean {
  const actual = [
    row.campaign_id,
    row.shard_index,
    row.claim_digest_sha256,
    row.probe_id,
    row.campaign_digest_sha256,
    row.controller_version_id,
    row.action_gate_inventory_sha256,
    row.action_gate_count,
    row.all_action_gates_false,
    row.foundation_manifest_sha256,
    row.ring_generation,
    row.shard_count,
    row.instance_name,
    row.shard_contract_version,
    row.runtime_protocol_version,
    row.runtime_contract_version,
    row.runtime_build_id,
    row.activation_generation,
    row.activation_probe_generation,
    row.environment,
    row.container_status,
    row.readiness_result_code,
    row.readiness_result_sha256,
    row.process_ready,
    row.runtime_execution_enabled,
    row.controller_execution_enabled,
    row.activation_digest_sha256,
    row.consumption_digest_sha256,
    row.readiness_checked_at,
  ];
  return (
    row.activation_id > 0 &&
    row.consumed_at >= row.readiness_checked_at &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function consumptionMatchesClaim(
  consumption: ConsumptionReadbackRow,
  claim: ClaimStoredRow,
): boolean {
  return (
    consumption.campaign_id === claim.campaign_id &&
    consumption.shard_index === claim.shard_index &&
    consumption.claim_digest_sha256 === claim.claim_digest_sha256 &&
    consumption.probe_id === claim.probe_id &&
    consumption.campaign_digest_sha256 === claim.campaign_digest_sha256 &&
    consumption.controller_version_id === claim.controller_version_id &&
    consumption.action_gate_inventory_sha256 === claim.action_gate_inventory_sha256 &&
    consumption.action_gate_count === claim.action_gate_count &&
    consumption.all_action_gates_false === claim.all_action_gates_false &&
    consumption.foundation_manifest_sha256 === claim.foundation_manifest_sha256 &&
    consumption.runtime_build_id === claim.runtime_build_id &&
    consumption.ring_generation === claim.ring_generation &&
    consumption.shard_count === claim.shard_count &&
    consumption.instance_name === claim.instance_name &&
    consumption.shard_contract_version === claim.shard_contract_version &&
    consumption.runtime_protocol_version === claim.runtime_protocol_version &&
    consumption.runtime_contract_version === claim.runtime_contract_version &&
    consumption.activation_generation === claim.activation_generation &&
    consumption.environment === claim.environment
  );
}

function campaignSchemaReady(value: Record<string, unknown> | null): boolean {
  if (value === null || Object.keys(value).length !== 6) return false;
  return (
    value.migration_count === 1 &&
    value.campaign_columns === CAMPAIGN_COLUMNS &&
    value.claim_columns === CLAIM_COLUMNS &&
    value.consumption_columns === CONSUMPTION_COLUMNS &&
    value.seal_columns === SEAL_COLUMNS &&
    value.schema_objects === EXPECTED_SCHEMA_OBJECTS.join("|")
  );
}

function isCampaignStoredRow(value: unknown): value is CampaignStoredRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 26 &&
    LOWER_HEX_64.test(asString(row.campaign_id)) &&
    LOWER_HEX_64.test(asString(row.campaign_nonce_sha256)) &&
    VERSION_ID.test(asString(row.controller_version_id)) &&
    LOWER_HEX_64.test(asString(row.action_gate_inventory_sha256)) &&
    row.action_gate_count === 22 &&
    row.all_action_gates_false === 1 &&
    LOWER_HEX_64.test(asString(row.foundation_manifest_sha256)) &&
    LOWER_HEX_64.test(asString(row.runtime_build_id)) &&
    integerInRange(row.ring_generation, 1, 1_000_000) &&
    integerInRange(row.shard_count, 1, 1_024) &&
    integerInRange(row.shard_contract_version, 1, 1_000_000) &&
    integerInRange(row.runtime_protocol_version, 1, 1_000_000) &&
    integerInRange(row.runtime_contract_version, 1, 1_000_000) &&
    integerInRange(row.activation_generation, 1, 1_000_000) &&
    ["staging", "production"].includes(asString(row.environment)) &&
    integerInRange(row.created_by_admin_id, 1, Number.MAX_SAFE_INTEGER) &&
    LOWER_HEX_64.test(asString(row.campaign_digest_sha256)) &&
    integerInRange(row.created_at, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(row.expires_at, 1, Number.MAX_SAFE_INTEGER) &&
    (row.expires_at as number) > (row.created_at as number) &&
    (row.expires_at as number) <= (row.created_at as number) + 3_600 &&
    integerInRange(row.claimed_shard_count, 0, row.shard_count as number) &&
    integerInRange(row.consumed_shard_count, 0, row.claimed_shard_count as number) &&
    integerInRange(row.database_now, 1, Number.MAX_SAFE_INTEGER) &&
    validSealProjection(row)
  );
}

function validSealProjection(row: Record<string, unknown>): boolean {
  if (row.seal_reason === null) {
    return (
      row.seal_detail_code === null &&
      row.last_consumption_digest_sha256 === null &&
      row.sealed_at === null
    );
  }
  if (
    !["complete", "failed", "expired", "aborted"].includes(asString(row.seal_reason)) ||
    !integerInRange(row.sealed_at, 1, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  const consumed = row.consumed_shard_count as number;
  if ((consumed === 0) !== (row.last_consumption_digest_sha256 === null)) return false;
  if (consumed > 0 && !LOWER_HEX_64.test(asString(row.last_consumption_digest_sha256))) {
    return false;
  }
  return true;
}

function isClaimStoredRow(value: unknown): value is ClaimStoredRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 22 &&
    LOWER_HEX_64.test(asString(row.campaign_id)) &&
    integerInRange(row.shard_index, 0, 1_023) &&
    LOWER_HEX_64.test(asString(row.presented_nonce_sha256)) &&
    LOWER_HEX_64.test(asString(row.campaign_digest_sha256)) &&
    VERSION_ID.test(asString(row.controller_version_id)) &&
    LOWER_HEX_64.test(asString(row.action_gate_inventory_sha256)) &&
    row.action_gate_count === 22 &&
    row.all_action_gates_false === 1 &&
    LOWER_HEX_64.test(asString(row.foundation_manifest_sha256)) &&
    LOWER_HEX_64.test(asString(row.runtime_build_id)) &&
    integerInRange(row.ring_generation, 1, 1_000_000) &&
    integerInRange(row.shard_count, 1, 1_024) &&
    typeof row.instance_name === "string" &&
    integerInRange(row.shard_contract_version, 1, 1_000_000) &&
    integerInRange(row.runtime_protocol_version, 1, 1_000_000) &&
    integerInRange(row.runtime_contract_version, 1, 1_000_000) &&
    integerInRange(row.activation_generation, 1, 1_000_000) &&
    LOWER_HEX_64.test(asString(row.probe_id)) &&
    LOWER_HEX_64.test(asString(row.claim_digest_sha256)) &&
    ["staging", "production"].includes(asString(row.environment)) &&
    integerInRange(row.claimed_at, 1, Number.MAX_SAFE_INTEGER) &&
    (row.consumed === 0 || row.consumed === 1)
  );
}

function isConsumptionReadbackRow(value: unknown): value is ConsumptionReadbackRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 31 &&
    LOWER_HEX_64.test(asString(row.campaign_id)) &&
    integerInRange(row.shard_index, 0, 1_023) &&
    LOWER_HEX_64.test(asString(row.claim_digest_sha256)) &&
    LOWER_HEX_64.test(asString(row.probe_id)) &&
    LOWER_HEX_64.test(asString(row.campaign_digest_sha256)) &&
    VERSION_ID.test(asString(row.controller_version_id)) &&
    LOWER_HEX_64.test(asString(row.action_gate_inventory_sha256)) &&
    row.action_gate_count === 22 &&
    row.all_action_gates_false === 1 &&
    LOWER_HEX_64.test(asString(row.foundation_manifest_sha256)) &&
    integerInRange(row.ring_generation, 1, 1_000_000) &&
    integerInRange(row.shard_count, 1, 1_024) &&
    typeof row.instance_name === "string" &&
    integerInRange(row.shard_contract_version, 1, 1_000_000) &&
    integerInRange(row.runtime_protocol_version, 1, 1_000_000) &&
    integerInRange(row.runtime_contract_version, 1, 1_000_000) &&
    LOWER_HEX_64.test(asString(row.runtime_build_id)) &&
    integerInRange(row.activation_generation, 1, 1_000_000) &&
    integerInRange(row.activation_probe_generation, 1, 1_000_000) &&
    ["staging", "production"].includes(asString(row.environment)) &&
    row.container_status === "healthy" &&
    row.readiness_result_code === "process_ready_execution_disabled" &&
    LOWER_HEX_64.test(asString(row.readiness_result_sha256)) &&
    row.process_ready === 1 &&
    row.runtime_execution_enabled === 0 &&
    row.controller_execution_enabled === 0 &&
    LOWER_HEX_64.test(asString(row.activation_digest_sha256)) &&
    LOWER_HEX_64.test(asString(row.consumption_digest_sha256)) &&
    integerInRange(row.readiness_checked_at, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(row.consumed_at, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(row.activation_id, 1, Number.MAX_SAFE_INTEGER)
  );
}

function validShard(shard: OperationShard): boolean {
  return (
    shard.contract_version === 1 &&
    integerInRange(shard.ring_generation, 1, Number.MAX_SAFE_INTEGER) &&
    integerInRange(shard.shard_count, 1, 1_024) &&
    integerInRange(shard.shard_index, 0, shard.shard_count - 1) &&
    shard.instance_name ===
      `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`
  );
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestParts(domain: Uint8Array, parts: string[]): Promise<string> {
  const encoded = parts.map((part) => new TextEncoder().encode(part));
  const byteLength = domain.length + encoded.reduce((total, part) => total + 4 + part.length, 0);
  const bytes = new Uint8Array(byteLength);
  bytes.set(domain, 0);
  let offset = domain.length;
  const view = new DataView(bytes.buffer);
  for (const part of encoded) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    bytes.set(part, offset);
    offset += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
