import { createHash } from "node:crypto";

export const SHARD_REGISTRY_CAPTURE_CONTRACT =
  "cinatoken-relay-container-shard-registry-capture-v3";
export const SHARD_ACTIVATION_LEDGER_CONTRACT =
  "cinatoken-relay-container-shard-activation-v1";
export const SHARD_ACTIVATION_CAMPAIGN_CONTRACT =
  "cinatoken-relay-container-shard-activation-campaign-v1";
export const SHARD_PLACEMENT_ATTESTATION_CONTRACT =
  "cinatoken-relay-shard-placement-attestation-v1";
export const SHARD_REGISTRY_COLLECTOR_VERSION = 3;

export const MAX_SHARD_COUNT = 1_024;
export const MAX_LEDGER_RECORDS = 4_096;
export const ACTIVATION_PAGE_SIZE = 64;
export const PLACEMENT_PAGE_SIZE = 64;

const MIN_OBSERVATION_SECONDS = 5 * 60;
const MAX_OBSERVATION_SECONDS = 2 * 60 * 60;

const activationDigestDomain = Buffer.from(
  "cinatoken:relay-container-shard-activation:v1\0",
  "utf8",
);
const consumptionDigestDomain = Buffer.from(
  "cinatoken:relay-container-shard-activation-campaign-consumption:v1\0",
  "utf8",
);
const placementAttestationDigestDomain = Buffer.from(
  SHARD_PLACEMENT_ATTESTATION_CONTRACT,
  "utf8",
);
const lowerSha256Pattern = /^[0-9a-f]{64}$/;
const versionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
const controllerServiceNamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

const activationRecordKeys = Object.freeze([
  "registry_event_sequence",
  "shard_count",
  "shard_index",
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
  "process_ready",
  "runtime_execution_enabled",
  "controller_execution_enabled",
  "activation_digest_sha256",
  "activated_at",
]);

const placementRecordKeys = Object.freeze([
  "placement_event_sequence",
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
]);

const campaignReadbackKeys = Object.freeze([
  "contract_version",
  "campaign_contract",
  "state",
  "campaign_id",
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
  "campaign_digest_sha256",
  "created_at",
  "expires_at",
  "claimed_shard_count",
  "consumed_shard_count",
  "seal_reason",
  "seal_detail_code",
  "last_consumption_digest_sha256",
  "sealed_at",
  "receipts",
]);

const campaignReceiptKeys = Object.freeze([
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
]);

const campaignSnapshotKeys = Object.freeze([
  "capturedAt",
  "contractVersion",
  "campaignContract",
  "state",
  "campaignId",
  "controllerVersionId",
  "actionGateInventorySha256",
  "actionGateCount",
  "allActionGatesFalse",
  "foundationManifestSha256",
  "runtimeBuildId",
  "ringGeneration",
  "shardCount",
  "shardContractVersion",
  "runtimeProtocolVersion",
  "runtimeContractVersion",
  "activationGeneration",
  "environment",
  "campaignDigestSha256",
  "createdAt",
  "expiresAt",
  "claimedShardCount",
  "consumedShardCount",
  "sealReason",
  "sealDetailCode",
  "lastConsumptionDigestSha256",
  "sealedAt",
  "receiptCount",
  "receiptSetSha256",
  "snapshotSha256",
  "receipts",
]);

export class ShardRegistryError extends Error {}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function activationDigestSha256({ controllerVersionId, ringGeneration, record }) {
  requireToken(controllerVersionId, versionIdPattern, "Controller version ID");
  requireInteger(ringGeneration, 1, 1_000_000, "ring generation");
  validateActivationRecordShape(record);
  return digestParts(activationDigestDomain, [
    controllerVersionId,
    ringGeneration,
    record.shard_count,
    record.shard_index,
    record.instance_name,
    record.shard_contract_version,
    record.runtime_protocol_version,
    record.runtime_contract_version,
    record.runtime_build_id,
    record.activation_generation,
    record.activation_probe_generation,
    record.environment,
    record.container_status,
    record.readiness_result_code,
    Number(record.process_ready),
    Number(record.runtime_execution_enabled),
    Number(record.controller_execution_enabled),
    record.activated_at,
  ]);
}

export function campaignConsumptionDigestSha256(receipt) {
  receipt = requireObject(receipt, "campaign consumption receipt");
  for (const field of [
    "campaign_id",
    "campaign_digest_sha256",
    "claim_digest_sha256",
    "activation_digest_sha256",
    "readiness_result_sha256",
  ]) {
    requireToken(receipt[field], lowerSha256Pattern, `campaign receipt ${field}`);
  }
  requireInteger(
    receipt.readiness_checked_at,
    1,
    Number.MAX_SAFE_INTEGER,
    "campaign receipt readiness timestamp",
  );
  return digestParts(consumptionDigestDomain, [
    receipt.campaign_id,
    receipt.campaign_digest_sha256,
    receipt.claim_digest_sha256,
    receipt.activation_digest_sha256,
    receipt.readiness_result_sha256,
    receipt.readiness_checked_at,
  ]);
}

export function buildCampaignSnapshot({ capturedAt, campaign, expected = {} }) {
  requireTimestamp(capturedAt, "campaign snapshot capturedAt");
  campaign = validateCampaignReadback(campaign, expected);
  const receiptSetSha256 = sha256Canonical(campaign.receipts);
  const snapshot = {
    capturedAt,
    contractVersion: campaign.contract_version,
    campaignContract: campaign.campaign_contract,
    state: campaign.state,
    campaignId: campaign.campaign_id,
    controllerVersionId: campaign.controller_version_id,
    actionGateInventorySha256: campaign.action_gate_inventory_sha256,
    actionGateCount: campaign.action_gate_count,
    allActionGatesFalse: campaign.all_action_gates_false,
    foundationManifestSha256: campaign.foundation_manifest_sha256,
    runtimeBuildId: campaign.runtime_build_id,
    ringGeneration: campaign.ring_generation,
    shardCount: campaign.shard_count,
    shardContractVersion: campaign.shard_contract_version,
    runtimeProtocolVersion: campaign.runtime_protocol_version,
    runtimeContractVersion: campaign.runtime_contract_version,
    activationGeneration: campaign.activation_generation,
    environment: campaign.environment,
    campaignDigestSha256: campaign.campaign_digest_sha256,
    createdAt: campaign.created_at,
    expiresAt: campaign.expires_at,
    claimedShardCount: campaign.claimed_shard_count,
    consumedShardCount: campaign.consumed_shard_count,
    sealReason: campaign.seal_reason,
    sealDetailCode: campaign.seal_detail_code,
    lastConsumptionDigestSha256: campaign.last_consumption_digest_sha256,
    sealedAt: campaign.sealed_at,
    receiptCount: campaign.receipts.length,
    receiptSetSha256,
    snapshotSha256: "",
    receipts: campaign.receipts,
  };
  snapshot.snapshotSha256 = campaignSnapshotDigest(snapshot);
  return snapshot;
}

export function validateCampaignSnapshot(value, expected = {}) {
  const snapshot = requireObject(value, "campaign snapshot");
  exactKeys(snapshot, campaignSnapshotKeys, "campaign snapshot");
  requireTimestamp(snapshot.capturedAt, "campaign snapshot capturedAt");
  const rebuilt = buildCampaignSnapshot({
    capturedAt: snapshot.capturedAt,
    campaign: campaignReadbackFromSnapshot(snapshot),
    expected,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(snapshot)) {
    throw new ShardRegistryError("campaign snapshot contains derived-field drift");
  }
  return rebuilt;
}

export function validateActivationPage(value, expected = {}) {
  const page = requireObject(value, "activation page");
  exactKeys(
    page,
    [
      "contract_version",
      "ledger_contract",
      "controller_version_id",
      "ring_generation",
      "high_watermark",
      "total_records",
      "count",
      "next_cursor",
      "pagination_complete",
      "records",
    ],
    "activation page",
  );
  requireExact(page.contract_version, 1, "activation page contract version");
  requireExact(page.ledger_contract, SHARD_ACTIVATION_LEDGER_CONTRACT, "activation ledger");
  requireToken(page.controller_version_id, versionIdPattern, "activation Controller version ID");
  requireInteger(page.ring_generation, 1, 1_000_000, "activation ring generation");
  requireInteger(page.high_watermark, 0, Number.MAX_SAFE_INTEGER, "activation high watermark");
  requireInteger(page.total_records, 0, MAX_LEDGER_RECORDS, "activation total records");
  requireInteger(page.count, 0, ACTIVATION_PAGE_SIZE, "activation page count");
  requireBoolean(page.pagination_complete, "activation pagination status");
  if (page.next_cursor !== null) {
    requireToken(page.next_cursor, /^[1-9][0-9]{0,15}$/, "activation next cursor");
  }
  if (!Array.isArray(page.records) || page.records.length !== page.count) {
    throw new ShardRegistryError("activation page count does not match records");
  }
  if (page.pagination_complete !== (page.next_cursor === null)) {
    throw new ShardRegistryError("activation page terminal cursor is inconsistent");
  }
  if (expected.controllerVersionId !== undefined) {
    requireExact(
      page.controller_version_id,
      expected.controllerVersionId,
      "activation Controller version ID",
    );
  }
  if (expected.ringGeneration !== undefined) {
    requireExact(page.ring_generation, expected.ringGeneration, "activation ring generation");
  }
  if (expected.highWatermark !== undefined) {
    requireExact(page.high_watermark, expected.highWatermark, "activation high watermark");
  }
  if (expected.totalRecords !== undefined) {
    requireExact(page.total_records, expected.totalRecords, "activation total records");
  }

  let previousSequence = expected.afterSequence ?? 0;
  const records = page.records.map((record) => {
    validateActivationRecord(record, {
      controllerVersionId: page.controller_version_id,
      ringGeneration: page.ring_generation,
      highWatermark: page.high_watermark,
    });
    if (record.registry_event_sequence <= previousSequence) {
      throw new ShardRegistryError("activation records are not strictly ordered");
    }
    previousSequence = record.registry_event_sequence;
    return record;
  });
  if (page.next_cursor !== null) {
    if (records.length === 0 || page.next_cursor !== String(previousSequence)) {
      throw new ShardRegistryError("activation next cursor does not match the last record");
    }
  }
  return { ...page, records };
}

export function buildActivationSnapshot({ capturedAt, pages }) {
  requireTimestamp(capturedAt, "activation snapshot capturedAt");
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 65) {
    throw new ShardRegistryError("activation snapshot page inventory is invalid");
  }
  const normalizedPages = [];
  const seenCursors = new Set();
  let controllerVersionId;
  let ringGeneration;
  let highWatermark;
  let totalRecords;
  let afterSequence = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = validateActivationPage(pages[index], {
      ...(index === 0
        ? {}
        : { controllerVersionId, ringGeneration, highWatermark, totalRecords }),
      afterSequence,
    });
    if (index === 0) {
      controllerVersionId = page.controller_version_id;
      ringGeneration = page.ring_generation;
      highWatermark = page.high_watermark;
      totalRecords = page.total_records;
    }
    if (index + 1 < pages.length && page.pagination_complete) {
      throw new ShardRegistryError("activation pagination ended before the final page");
    }
    if (index + 1 === pages.length && !page.pagination_complete) {
      throw new ShardRegistryError("activation pagination did not reach a terminal page");
    }
    if (page.next_cursor !== null && !seenCursors.add(page.next_cursor)) {
      throw new ShardRegistryError("activation pagination repeated a cursor");
    }
    if (page.records.length > 0) {
      afterSequence = page.records.at(-1).registry_event_sequence;
    }
    normalizedPages.push(page);
  }
  const records = normalizedPages.flatMap((page) => page.records);
  if (records.length !== totalRecords) {
    throw new ShardRegistryError("activation snapshot did not enumerate every record");
  }
  if ((records.at(-1)?.registry_event_sequence ?? 0) !== highWatermark) {
    throw new ShardRegistryError("activation snapshot did not reach the frozen high watermark");
  }
  return {
    capturedAt,
    controllerVersionId,
    ringGeneration,
    highWatermark,
    totalRecords,
    pageCount: normalizedPages.length,
    paginationComplete: true,
    entriesSha256: sha256Canonical(records),
    records,
  };
}

export function placementAttestationDigestSha256(record) {
  validatePlacementAttestationFields(record);
  return digestParts(placementAttestationDigestDomain, [
    record.contract_version,
    record.environment,
    record.controller_service_name,
    record.controller_version_id,
    record.durable_object_namespace_binding,
    record.durable_object_class,
    record.jurisdiction,
    record.canonical_name_sha256,
    record.object_id_sha256,
    record.shard_contract_version,
    record.ring_generation,
    record.shard_count,
    record.shard_index,
    record.instance_name,
  ]);
}

export function validatePlacementPage(value, expected = {}) {
  const page = requireObject(value, "placement page");
  exactKeys(
    page,
    [
      "contract_version",
      "placement_contract",
      "controller_version_id",
      "ring_generation",
      "campaign_id",
      "high_watermark",
      "total_records",
      "count",
      "next_cursor",
      "pagination_complete",
      "records",
    ],
    "placement page",
  );
  requireExact(page.contract_version, 1, "placement page contract version");
  requireExact(
    page.placement_contract,
    SHARD_PLACEMENT_ATTESTATION_CONTRACT,
    "placement attestation contract",
  );
  requireToken(page.controller_version_id, versionIdPattern, "placement Controller version ID");
  requireInteger(page.ring_generation, 1, 1_000_000, "placement ring generation");
  requireToken(page.campaign_id, lowerSha256Pattern, "placement campaign ID");
  requireInteger(page.high_watermark, 0, Number.MAX_SAFE_INTEGER, "placement high watermark");
  requireInteger(page.total_records, 0, MAX_LEDGER_RECORDS, "placement total records");
  requireInteger(page.count, 0, PLACEMENT_PAGE_SIZE, "placement page count");
  requireBoolean(page.pagination_complete, "placement pagination status");
  if (page.next_cursor !== null) {
    requireToken(page.next_cursor, /^[1-9][0-9]{0,15}$/, "placement next cursor");
  }
  if (!Array.isArray(page.records) || page.records.length !== page.count) {
    throw new ShardRegistryError("placement page count does not match records");
  }
  if (page.pagination_complete !== (page.next_cursor === null)) {
    throw new ShardRegistryError("placement page terminal cursor is inconsistent");
  }
  if (expected.controllerVersionId !== undefined) {
    requireExact(
      page.controller_version_id,
      expected.controllerVersionId,
      "placement Controller version ID",
    );
  }
  if (expected.ringGeneration !== undefined) {
    requireExact(page.ring_generation, expected.ringGeneration, "placement ring generation");
  }
  if (expected.campaignId !== undefined) {
    requireExact(page.campaign_id, expected.campaignId, "placement campaign ID");
  }
  if (expected.highWatermark !== undefined) {
    requireExact(page.high_watermark, expected.highWatermark, "placement high watermark");
  }
  if (expected.totalRecords !== undefined) {
    requireExact(page.total_records, expected.totalRecords, "placement total records");
  }

  let previousSequence = expected.afterSequence ?? 0;
  const records = page.records.map((record) => {
    validatePlacementRecord(record, {
      controllerVersionId: page.controller_version_id,
      ringGeneration: page.ring_generation,
      campaignId: page.campaign_id,
      highWatermark: page.high_watermark,
    });
    if (record.placement_event_sequence <= previousSequence) {
      throw new ShardRegistryError("placement records are not strictly ordered");
    }
    previousSequence = record.placement_event_sequence;
    return record;
  });
  if (page.next_cursor !== null) {
    if (records.length === 0 || page.next_cursor !== String(previousSequence)) {
      throw new ShardRegistryError("placement next cursor does not match the last record");
    }
  }
  return { ...page, records };
}

export function buildPlacementSnapshot({ capturedAt, pages }) {
  requireTimestamp(capturedAt, "placement snapshot capturedAt");
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 65) {
    throw new ShardRegistryError("placement snapshot page inventory is invalid");
  }
  const normalizedPages = [];
  const seenCursors = new Set();
  let controllerVersionId;
  let ringGeneration;
  let campaignId;
  let highWatermark;
  let totalRecords;
  let afterSequence = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = validatePlacementPage(pages[index], {
      ...(index === 0
        ? {}
        : {
            controllerVersionId,
            ringGeneration,
            campaignId,
            highWatermark,
            totalRecords,
          }),
      afterSequence,
    });
    if (index === 0) {
      controllerVersionId = page.controller_version_id;
      ringGeneration = page.ring_generation;
      campaignId = page.campaign_id;
      highWatermark = page.high_watermark;
      totalRecords = page.total_records;
    }
    if (index + 1 < pages.length && page.pagination_complete) {
      throw new ShardRegistryError("placement pagination ended before the final page");
    }
    if (index + 1 === pages.length && !page.pagination_complete) {
      throw new ShardRegistryError("placement pagination did not reach a terminal page");
    }
    if (page.next_cursor !== null && !seenCursors.add(page.next_cursor)) {
      throw new ShardRegistryError("placement pagination repeated a cursor");
    }
    if (page.records.length > 0) {
      afterSequence = page.records.at(-1).placement_event_sequence;
    }
    normalizedPages.push(page);
  }
  const records = normalizedPages.flatMap((page) => page.records);
  if (records.length !== totalRecords) {
    throw new ShardRegistryError("placement snapshot did not enumerate every record");
  }
  if ((records.at(-1)?.placement_event_sequence ?? 0) !== highWatermark) {
    throw new ShardRegistryError("placement snapshot did not reach the frozen high watermark");
  }
  validatePlacementRecordUniqueness(records);
  return {
    capturedAt,
    controllerVersionId,
    ringGeneration,
    campaignId,
    highWatermark,
    totalRecords,
    pageCount: normalizedPages.length,
    paginationComplete: true,
    entriesSha256: sha256Canonical(records),
    records,
  };
}

export function buildShardRegistryCapture({
  candidate,
  observationStartedAt,
  observationEndedAt,
  campaignBefore,
  campaignAfter,
  before,
  after,
  placementBefore,
  placementAfter,
}) {
  candidate = validateRegistryCandidate(candidate);
  requireTimestamp(observationStartedAt, "registry observation start");
  requireTimestamp(observationEndedAt, "registry observation end");
  const observationSeconds =
    (Date.parse(observationEndedAt) - Date.parse(observationStartedAt)) / 1_000;
  if (
    observationSeconds < MIN_OBSERVATION_SECONDS ||
    observationSeconds > MAX_OBSERVATION_SECONDS
  ) {
    throw new ShardRegistryError("registry observation window is invalid");
  }
  campaignBefore = validateCampaignSnapshot(campaignBefore, candidate);
  campaignAfter = validateCampaignSnapshot(campaignAfter, candidate);
  before = validateSnapshot(before, candidate, "before");
  after = validateSnapshot(after, candidate, "after");
  placementBefore = validatePlacementSnapshot(
    placementBefore,
    candidate,
    campaignBefore.campaignId,
    "before",
  );
  placementAfter = validatePlacementSnapshot(
    placementAfter,
    candidate,
    campaignAfter.campaignId,
    "after",
  );
  requireExact(
    campaignBefore.capturedAt,
    observationStartedAt,
    "before campaign observation boundary",
  );
  requireExact(
    campaignAfter.capturedAt,
    observationEndedAt,
    "after campaign observation boundary",
  );
  requireExact(
    before.capturedAt,
    observationStartedAt,
    "before activation observation boundary",
  );
  requireExact(
    after.capturedAt,
    observationEndedAt,
    "after activation observation boundary",
  );
  requireExact(
    placementBefore.capturedAt,
    observationStartedAt,
    "before placement observation boundary",
  );
  requireExact(
    placementAfter.capturedAt,
    observationEndedAt,
    "after placement observation boundary",
  );

  if (campaignBefore.snapshotSha256 !== campaignAfter.snapshotSha256) {
    throw new ShardRegistryError("activation campaign readback drifted");
  }
  const blockers = [];
  if (before.highWatermark !== after.highWatermark) blockers.push("activation-high-watermark-drift");
  if (before.totalRecords !== after.totalRecords) blockers.push("activation-record-count-drift");
  if (before.entriesSha256 !== after.entriesSha256) blockers.push("activation-entry-drift");
  if (canonicalJson(before.records) !== canonicalJson(after.records)) {
    blockers.push("activation-record-drift");
  }
  if (placementBefore.highWatermark !== placementAfter.highWatermark) {
    blockers.push("placement-high-watermark-drift");
  }
  if (placementBefore.totalRecords !== placementAfter.totalRecords) {
    blockers.push("placement-record-count-drift");
  }
  if (placementBefore.entriesSha256 !== placementAfter.entriesSha256) {
    blockers.push("placement-entry-drift");
  }
  if (canonicalJson(placementBefore.records) !== canonicalJson(placementAfter.records)) {
    blockers.push("placement-record-drift");
  }

  const assessment = assessCampaignReceipts(
    after.records,
    campaignAfter.receipts,
    candidate,
  );
  blockers.push(...assessment.blockers);
  const placementAssessment = assessPlacements(
    placementAfter.records,
    after.records,
    campaignAfter.receipts,
    candidate,
    campaignAfter.campaignId,
  );
  blockers.push(...placementAssessment.blockers);
  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    schemaVersion: 3,
    contract: SHARD_REGISTRY_CAPTURE_CONTRACT,
    environment: "staging",
    collectorVersion: SHARD_REGISTRY_COLLECTOR_VERSION,
    candidate,
    campaign: campaignBefore,
    campaignReadback: {
      beforeCapturedAt: campaignBefore.capturedAt,
      afterCapturedAt: campaignAfter.capturedAt,
      beforeSnapshotSha256: campaignBefore.snapshotSha256,
      afterSnapshotSha256: campaignAfter.snapshotSha256,
      stable: campaignBefore.snapshotSha256 === campaignAfter.snapshotSha256,
    },
    observationStartedAt,
    observationEndedAt,
    before,
    after,
    placementBefore,
    placementAfter,
    stableCampaignSha256: campaignBefore.snapshotSha256,
    stableEntriesSha256: before.entriesSha256,
    stablePlacementEntriesSha256: placementBefore.entriesSha256,
    verifiedShardCount: assessment.verifiedShardCount,
    verifiedReceiptCount: assessment.verifiedReceiptCount,
    missingShardCount: assessment.missingShardCount,
    duplicateShardCount: assessment.duplicateShardCount,
    unknownShardCount: assessment.unknownShardCount,
    verifiedPlacementCount: placementAssessment.verifiedPlacementCount,
    missingPlacementCount: placementAssessment.missingPlacementCount,
    duplicatePlacementCount: placementAssessment.duplicatePlacementCount,
    unknownPlacementCount: placementAssessment.unknownPlacementCount,
    paginationComplete: true,
    evidenceReady: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    safetyBoundary: {
      customerTrafficEligible: false,
      deployOrRollbackExecuted: false,
      providerRequestPerformed: false,
      remoteMutationPerformed: false,
      shardDoOrContainerWakePerformed: false,
    },
  };
}

export function validateShardRegistryCapture(value, expectedCandidate = undefined) {
  const capture = requireObject(value, "shard registry capture");
  exactKeys(
    capture,
    [
      "schemaVersion",
      "contract",
      "environment",
      "collectorVersion",
      "candidate",
      "campaign",
      "campaignReadback",
      "observationStartedAt",
      "observationEndedAt",
      "before",
      "after",
      "placementBefore",
      "placementAfter",
      "stableCampaignSha256",
      "stableEntriesSha256",
      "stablePlacementEntriesSha256",
      "verifiedShardCount",
      "verifiedReceiptCount",
      "missingShardCount",
      "duplicateShardCount",
      "unknownShardCount",
      "verifiedPlacementCount",
      "missingPlacementCount",
      "duplicatePlacementCount",
      "unknownPlacementCount",
      "paginationComplete",
      "evidenceReady",
      "blockers",
      "safetyBoundary",
    ],
    "shard registry capture",
  );
  const readback = requireObject(capture.campaignReadback, "campaign readback summary");
  exactKeys(
    readback,
    [
      "beforeCapturedAt",
      "afterCapturedAt",
      "beforeSnapshotSha256",
      "afterSnapshotSha256",
      "stable",
    ],
    "campaign readback summary",
  );
  const campaignAfter = {
    ...capture.campaign,
    capturedAt: readback.afterCapturedAt,
    snapshotSha256: readback.afterSnapshotSha256,
  };
  const rebuilt = buildShardRegistryCapture({
    candidate: capture.candidate,
    observationStartedAt: capture.observationStartedAt,
    observationEndedAt: capture.observationEndedAt,
    campaignBefore: capture.campaign,
    campaignAfter,
    before: capture.before,
    after: capture.after,
    placementBefore: capture.placementBefore,
    placementAfter: capture.placementAfter,
  });
  if (canonicalJson(capture) !== canonicalJson(rebuilt)) {
    throw new ShardRegistryError("shard registry capture contains derived-field drift");
  }
  if (expectedCandidate !== undefined) {
    const expected = validateRegistryCandidate(expectedCandidate);
    if (canonicalJson(rebuilt.candidate) !== canonicalJson(expected)) {
      throw new ShardRegistryError("shard registry candidate does not match P5 candidate");
    }
  }
  return rebuilt;
}

export function validateRegistryCandidate(value) {
  const candidate = requireObject(value, "shard registry candidate");
  exactKeys(
    candidate,
    [
      "controllerVersionId",
      "runtimeBuildId",
      "containerImageDigest",
      "imageProvenanceSha256",
      "ringGeneration",
      "shardCount",
    ],
    "shard registry candidate",
  );
  requireToken(candidate.controllerVersionId, versionIdPattern, "candidate Controller version ID");
  requireToken(candidate.runtimeBuildId, lowerSha256Pattern, "candidate runtime build ID");
  requireToken(candidate.containerImageDigest, imageDigestPattern, "candidate Container image digest");
  requireToken(candidate.imageProvenanceSha256, lowerSha256Pattern, "candidate image provenance digest");
  requireInteger(candidate.ringGeneration, 1, 1_000_000, "candidate ring generation");
  requireInteger(candidate.shardCount, 1, MAX_SHARD_COUNT, "candidate shard count");
  return { ...candidate };
}

function validateCampaignReadback(value, expected) {
  const campaign = requireObject(value, "activation campaign readback");
  exactKeys(campaign, campaignReadbackKeys, "activation campaign readback");
  requireExact(campaign.contract_version, 1, "campaign contract version");
  requireExact(campaign.campaign_contract, SHARD_ACTIVATION_CAMPAIGN_CONTRACT, "campaign contract");
  requireExact(campaign.state, "sealed_complete", "campaign state");
  requireToken(campaign.campaign_id, lowerSha256Pattern, "campaign ID");
  requireToken(campaign.controller_version_id, versionIdPattern, "campaign Controller version ID");
  requireToken(campaign.action_gate_inventory_sha256, lowerSha256Pattern, "campaign action gate digest");
  requireExact(campaign.action_gate_count, 22, "campaign action gate count");
  requireExact(campaign.all_action_gates_false, true, "campaign action gate state");
  requireToken(campaign.foundation_manifest_sha256, lowerSha256Pattern, "campaign foundation manifest digest");
  requireToken(campaign.runtime_build_id, lowerSha256Pattern, "campaign runtime build ID");
  requireInteger(campaign.ring_generation, 1, 1_000_000, "campaign ring generation");
  requireInteger(campaign.shard_count, 1, MAX_SHARD_COUNT, "campaign shard count");
  requireExact(campaign.shard_contract_version, 1, "campaign shard contract version");
  requireExact(campaign.runtime_protocol_version, 1, "campaign runtime protocol version");
  requireExact(campaign.runtime_contract_version, 1, "campaign runtime contract version");
  requireExact(campaign.activation_generation, 1, "campaign activation generation");
  requireExact(campaign.environment, "staging", "campaign environment");
  requireToken(campaign.campaign_digest_sha256, lowerSha256Pattern, "campaign digest");
  requireInteger(campaign.created_at, 1, Number.MAX_SAFE_INTEGER, "campaign creation timestamp");
  requireInteger(campaign.expires_at, campaign.created_at + 1, Number.MAX_SAFE_INTEGER, "campaign expiry timestamp");
  if (campaign.expires_at > campaign.created_at + 3_600) {
    throw new ShardRegistryError("campaign expiry window is invalid");
  }
  requireExact(campaign.claimed_shard_count, campaign.shard_count, "campaign claimed shard count");
  requireExact(campaign.consumed_shard_count, campaign.shard_count, "campaign consumed shard count");
  requireExact(campaign.seal_reason, "complete", "campaign seal reason");
  requireExact(campaign.seal_detail_code, "all_shards_consumed", "campaign seal detail");
  requireToken(campaign.last_consumption_digest_sha256, lowerSha256Pattern, "campaign last consumption digest");
  requireInteger(campaign.sealed_at, campaign.created_at, campaign.expires_at, "campaign seal timestamp");
  if (!Array.isArray(campaign.receipts) || campaign.receipts.length !== campaign.shard_count) {
    throw new ShardRegistryError("campaign receipts do not cover every shard");
  }
  const seenClaimDigests = new Set();
  const seenProbeIds = new Set();
  const seenActivationDigests = new Set();
  const seenConsumptionDigests = new Set();
  let lastReceiptFound = false;
  const receipts = campaign.receipts.map((receipt, shardIndex) => {
    validateCampaignReceipt(receipt, campaign, shardIndex);
    requireUnique(seenClaimDigests, receipt.claim_digest_sha256, "campaign receipt claim digest");
    requireUnique(seenProbeIds, receipt.probe_id, "campaign receipt probe ID");
    requireUnique(
      seenActivationDigests,
      receipt.activation_digest_sha256,
      "campaign receipt activation digest",
    );
    requireUnique(
      seenConsumptionDigests,
      receipt.consumption_digest_sha256,
      "campaign receipt consumption digest",
    );
    if (receipt.consumption_digest_sha256 === campaign.last_consumption_digest_sha256) {
      if (receipt.consumed_at !== campaign.sealed_at) {
        throw new ShardRegistryError("campaign final receipt does not match the seal timestamp");
      }
      lastReceiptFound = true;
    }
    return receipt;
  });
  if (!lastReceiptFound) {
    throw new ShardRegistryError("campaign seal does not reference a consumption receipt");
  }
  if (expected.campaignId !== undefined) {
    requireExact(campaign.campaign_id, expected.campaignId, "campaign ID");
  }
  if (expected.foundationManifestSha256 !== undefined) {
    requireExact(
      campaign.foundation_manifest_sha256,
      expected.foundationManifestSha256,
      "campaign foundation manifest digest",
    );
  }
  if (expected.controllerVersionId !== undefined) {
    requireExact(campaign.controller_version_id, expected.controllerVersionId, "campaign Controller version ID");
  }
  if (expected.runtimeBuildId !== undefined) {
    requireExact(campaign.runtime_build_id, expected.runtimeBuildId, "campaign runtime build ID");
  }
  if (expected.ringGeneration !== undefined) {
    requireExact(campaign.ring_generation, expected.ringGeneration, "campaign ring generation");
  }
  if (expected.shardCount !== undefined) {
    requireExact(campaign.shard_count, expected.shardCount, "campaign shard count");
  }
  return { ...campaign, receipts };
}

function validateCampaignReceipt(receipt, campaign, expectedShardIndex) {
  receipt = requireObject(receipt, "campaign consumption receipt");
  exactKeys(receipt, campaignReceiptKeys, "campaign consumption receipt");
  requireExact(receipt.campaign_id, campaign.campaign_id, "receipt campaign ID");
  requireExact(receipt.shard_index, expectedShardIndex, "receipt shard coverage");
  requireToken(receipt.claim_digest_sha256, lowerSha256Pattern, "receipt claim digest");
  requireToken(receipt.probe_id, lowerSha256Pattern, "receipt probe ID");
  requireExact(receipt.campaign_digest_sha256, campaign.campaign_digest_sha256, "receipt campaign digest");
  requireExact(receipt.controller_version_id, campaign.controller_version_id, "receipt Controller version ID");
  requireExact(
    receipt.action_gate_inventory_sha256,
    campaign.action_gate_inventory_sha256,
    "receipt action gate digest",
  );
  requireExact(receipt.action_gate_count, 22, "receipt action gate count");
  requireExact(receipt.all_action_gates_false, true, "receipt action gate state");
  requireExact(
    receipt.foundation_manifest_sha256,
    campaign.foundation_manifest_sha256,
    "receipt foundation manifest digest",
  );
  requireExact(receipt.ring_generation, campaign.ring_generation, "receipt ring generation");
  requireExact(receipt.shard_count, campaign.shard_count, "receipt shard count");
  requireExact(
    receipt.instance_name,
    `cinatoken-relay-shard-v1-${String(expectedShardIndex).padStart(4, "0")}`,
    "receipt instance name",
  );
  requireExact(receipt.shard_contract_version, campaign.shard_contract_version, "receipt shard contract");
  requireExact(receipt.runtime_protocol_version, campaign.runtime_protocol_version, "receipt runtime protocol");
  requireExact(receipt.runtime_contract_version, campaign.runtime_contract_version, "receipt runtime contract");
  requireExact(receipt.runtime_build_id, campaign.runtime_build_id, "receipt runtime build ID");
  requireExact(receipt.activation_generation, campaign.activation_generation, "receipt activation generation");
  requireInteger(receipt.activation_probe_generation, 1, 1_000_000, "receipt activation probe generation");
  requireExact(receipt.environment, campaign.environment, "receipt environment");
  requireExact(receipt.container_status, "healthy", "receipt Container status");
  requireExact(
    receipt.readiness_result_code,
    "process_ready_execution_disabled",
    "receipt readiness result",
  );
  requireToken(receipt.readiness_result_sha256, lowerSha256Pattern, "receipt readiness result digest");
  requireExact(receipt.process_ready, true, "receipt process readiness");
  requireExact(receipt.runtime_execution_enabled, false, "receipt runtime execution gate");
  requireExact(receipt.controller_execution_enabled, false, "receipt Controller execution gate");
  requireToken(receipt.activation_digest_sha256, lowerSha256Pattern, "receipt activation digest");
  requireToken(receipt.consumption_digest_sha256, lowerSha256Pattern, "receipt consumption digest");
  requireInteger(
    receipt.readiness_checked_at,
    campaign.created_at,
    campaign.expires_at,
    "receipt readiness timestamp",
  );
  requireInteger(
    receipt.consumed_at,
    receipt.readiness_checked_at,
    campaign.expires_at,
    "receipt consumption timestamp",
  );
  const activationRecord = activationRecordFromReceipt(receipt, 1);
  requireExact(
    receipt.activation_digest_sha256,
    activationDigestSha256({
      controllerVersionId: campaign.controller_version_id,
      ringGeneration: campaign.ring_generation,
      record: activationRecord,
    }),
    "receipt activation digest",
  );
  requireExact(
    receipt.consumption_digest_sha256,
    campaignConsumptionDigestSha256(receipt),
    "receipt consumption digest",
  );
}

function validateSnapshot(snapshot, candidate, label) {
  snapshot = requireObject(snapshot, `${label} activation snapshot`);
  exactKeys(
    snapshot,
    [
      "capturedAt",
      "controllerVersionId",
      "ringGeneration",
      "highWatermark",
      "totalRecords",
      "pageCount",
      "paginationComplete",
      "entriesSha256",
      "records",
    ],
    `${label} activation snapshot`,
  );
  requireTimestamp(snapshot.capturedAt, `${label} activation capturedAt`);
  requireExact(snapshot.controllerVersionId, candidate.controllerVersionId, `${label} Controller version`);
  requireExact(snapshot.ringGeneration, candidate.ringGeneration, `${label} ring generation`);
  requireInteger(snapshot.highWatermark, 0, Number.MAX_SAFE_INTEGER, `${label} high watermark`);
  requireInteger(snapshot.totalRecords, 0, MAX_LEDGER_RECORDS, `${label} total records`);
  requireInteger(snapshot.pageCount, 1, 65, `${label} page count`);
  requireExact(snapshot.paginationComplete, true, `${label} pagination complete`);
  requireToken(snapshot.entriesSha256, lowerSha256Pattern, `${label} entries digest`);
  if (!Array.isArray(snapshot.records) || snapshot.records.length !== snapshot.totalRecords) {
    throw new ShardRegistryError(`${label} activation record count is invalid`);
  }
  let previous = 0;
  for (const record of snapshot.records) {
    validateActivationRecord(record, {
      controllerVersionId: candidate.controllerVersionId,
      ringGeneration: candidate.ringGeneration,
      highWatermark: snapshot.highWatermark,
    });
    if (record.registry_event_sequence <= previous) {
      throw new ShardRegistryError(`${label} activation records are not strictly ordered`);
    }
    previous = record.registry_event_sequence;
  }
  requireExact(previous, snapshot.highWatermark, `${label} frozen high watermark`);
  requireExact(snapshot.entriesSha256, sha256Canonical(snapshot.records), `${label} entries digest`);
  return snapshot;
}

function validatePlacementSnapshot(snapshot, candidate, campaignId, label) {
  snapshot = requireObject(snapshot, `${label} placement snapshot`);
  exactKeys(
    snapshot,
    [
      "capturedAt",
      "controllerVersionId",
      "ringGeneration",
      "campaignId",
      "highWatermark",
      "totalRecords",
      "pageCount",
      "paginationComplete",
      "entriesSha256",
      "records",
    ],
    `${label} placement snapshot`,
  );
  requireTimestamp(snapshot.capturedAt, `${label} placement capturedAt`);
  requireExact(
    snapshot.controllerVersionId,
    candidate.controllerVersionId,
    `${label} placement Controller version`,
  );
  requireExact(
    snapshot.ringGeneration,
    candidate.ringGeneration,
    `${label} placement ring generation`,
  );
  requireExact(snapshot.campaignId, campaignId, `${label} placement campaign ID`);
  requireInteger(
    snapshot.highWatermark,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label} placement high watermark`,
  );
  requireInteger(
    snapshot.totalRecords,
    0,
    MAX_LEDGER_RECORDS,
    `${label} placement total records`,
  );
  requireInteger(snapshot.pageCount, 1, 65, `${label} placement page count`);
  requireExact(
    snapshot.paginationComplete,
    true,
    `${label} placement pagination complete`,
  );
  requireToken(
    snapshot.entriesSha256,
    lowerSha256Pattern,
    `${label} placement entries digest`,
  );
  if (!Array.isArray(snapshot.records) || snapshot.records.length !== snapshot.totalRecords) {
    throw new ShardRegistryError(`${label} placement record count is invalid`);
  }
  let previousSequence = 0;
  for (const record of snapshot.records) {
    validatePlacementRecord(record, {
      controllerVersionId: candidate.controllerVersionId,
      ringGeneration: candidate.ringGeneration,
      campaignId,
      highWatermark: snapshot.highWatermark,
    });
    requireExact(record.environment, "staging", `${label} placement environment`);
    requireExact(record.shard_count, candidate.shardCount, `${label} placement shard count`);
    if (record.placement_event_sequence <= previousSequence) {
      throw new ShardRegistryError(`${label} placement records are not strictly ordered`);
    }
    previousSequence = record.placement_event_sequence;
  }
  requireExact(
    previousSequence,
    snapshot.highWatermark,
    `${label} placement frozen high watermark`,
  );
  validatePlacementRecordUniqueness(snapshot.records);
  requireExact(
    snapshot.entriesSha256,
    sha256Canonical(snapshot.records),
    `${label} placement entries digest`,
  );
  return snapshot;
}

function assessPlacements(placements, activationRecords, receipts, candidate, campaignId) {
  const receiptByShard = new Map(receipts.map((receipt) => [receipt.shard_index, receipt]));
  const activationById = new Map(
    activationRecords.map((record) => [record.registry_event_sequence, record]),
  );
  const associatedByShard = new Map();
  const controllerServiceNames = new Set();
  let unknownPlacementCount = 0;
  for (const placement of placements) {
    const receipt = receiptByShard.get(placement.shard_index);
    const activation = activationById.get(placement.activation_id);
    if (
      !receipt ||
      !activation ||
      !placementMatchesEvidence(
        placement,
        activation,
        receipt,
        candidate,
        campaignId,
      )
    ) {
      unknownPlacementCount += 1;
      continue;
    }
    controllerServiceNames.add(placement.controller_service_name);
    const rows = associatedByShard.get(placement.shard_index) ?? [];
    rows.push(placement);
    associatedByShard.set(placement.shard_index, rows);
  }

  let verifiedPlacementCount = 0;
  let missingPlacementCount = 0;
  let duplicatePlacementCount = 0;
  for (let shardIndex = 0; shardIndex < candidate.shardCount; shardIndex += 1) {
    const rows = associatedByShard.get(shardIndex) ?? [];
    if (rows.length === 0) missingPlacementCount += 1;
    else if (rows.length === 1) verifiedPlacementCount += 1;
    else duplicatePlacementCount += rows.length - 1;
  }

  const blockers = [];
  if (verifiedPlacementCount !== candidate.shardCount) {
    blockers.push("campaign-receipt-placements-incomplete");
  }
  if (missingPlacementCount !== 0) {
    blockers.push("campaign-receipt-placements-missing");
  }
  if (duplicatePlacementCount !== 0) {
    blockers.push("campaign-receipt-placements-duplicated");
  }
  if (unknownPlacementCount !== 0) {
    blockers.push("unknown-shard-placements-present");
  }
  if (controllerServiceNames.size > 1) {
    blockers.push("placement-controller-service-drift");
  }
  return {
    verifiedPlacementCount,
    missingPlacementCount,
    duplicatePlacementCount,
    unknownPlacementCount,
    blockers,
  };
}

function placementMatchesEvidence(
  placement,
  activation,
  receipt,
  candidate,
  campaignId,
) {
  return (
    placement.environment === "staging" &&
    placement.controller_version_id === candidate.controllerVersionId &&
    placement.ring_generation === candidate.ringGeneration &&
    placement.shard_count === candidate.shardCount &&
    placement.campaign_id === campaignId &&
    placement.shard_index === receipt.shard_index &&
    placement.shard_contract_version === receipt.shard_contract_version &&
    placement.instance_name === receipt.instance_name &&
    placement.claim_digest_sha256 === receipt.claim_digest_sha256 &&
    placement.readiness_result_sha256 === receipt.readiness_result_sha256 &&
    placement.activation_digest_sha256 === receipt.activation_digest_sha256 &&
    placement.consumption_digest_sha256 === receipt.consumption_digest_sha256 &&
    placement.activation_id === activation.registry_event_sequence &&
    placement.activation_digest_sha256 === activation.activation_digest_sha256 &&
    placement.shard_count === activation.shard_count &&
    placement.shard_index === activation.shard_index &&
    placement.instance_name === activation.instance_name &&
    placement.shard_contract_version === activation.shard_contract_version &&
    placement.environment === activation.environment &&
    placement.recorded_at >= receipt.consumed_at &&
    activationMatchesReceipt(activation, receipt, candidate)
  );
}

function assessCampaignReceipts(records, receipts, candidate) {
  const receiptByDigest = new Map(
    receipts.map((receipt) => [receipt.activation_digest_sha256, receipt]),
  );
  const associatedByShard = new Map();
  let unknownShardCount = 0;
  for (const record of records) {
    const receipt = receiptByDigest.get(record.activation_digest_sha256);
    if (!receipt || !activationMatchesReceipt(record, receipt, candidate)) {
      unknownShardCount += 1;
      continue;
    }
    const rows = associatedByShard.get(receipt.shard_index) ?? [];
    rows.push(record);
    associatedByShard.set(receipt.shard_index, rows);
  }
  let verifiedShardCount = 0;
  let missingShardCount = 0;
  let duplicateShardCount = 0;
  for (let shardIndex = 0; shardIndex < candidate.shardCount; shardIndex += 1) {
    const rows = associatedByShard.get(shardIndex) ?? [];
    if (rows.length === 0) missingShardCount += 1;
    else if (rows.length === 1) verifiedShardCount += 1;
    else duplicateShardCount += rows.length - 1;
  }
  const blockers = [];
  if (verifiedShardCount !== candidate.shardCount) blockers.push("campaign-receipt-activations-incomplete");
  if (missingShardCount !== 0) blockers.push("campaign-receipt-activations-missing");
  if (duplicateShardCount !== 0) blockers.push("campaign-receipt-activations-duplicated");
  if (unknownShardCount !== 0) blockers.push("unknown-shard-activations-present");
  return {
    verifiedShardCount,
    verifiedReceiptCount: verifiedShardCount,
    missingShardCount,
    duplicateShardCount,
    unknownShardCount,
    blockers,
  };
}

function validatePlacementRecord(
  record,
  { controllerVersionId, ringGeneration, campaignId, highWatermark },
) {
  validatePlacementAttestationFields(record);
  requireExact(
    record.controller_version_id,
    controllerVersionId,
    "placement Controller version ID",
  );
  requireExact(record.ring_generation, ringGeneration, "placement ring generation");
  requireExact(record.campaign_id, campaignId, "placement campaign ID");
  requireInteger(
    record.placement_event_sequence,
    1,
    highWatermark,
    "placement event sequence",
  );
  requireExact(
    record.placement_attestation_digest_sha256,
    placementAttestationDigestSha256(record),
    "placement attestation digest",
  );
}

function validatePlacementAttestationFields(record) {
  record = requireObject(record, "placement record");
  exactKeys(record, placementRecordKeys, "placement record");
  requireInteger(
    record.placement_event_sequence,
    1,
    Number.MAX_SAFE_INTEGER,
    "placement event sequence",
  );
  requireToken(
    record.placement_attestation_digest_sha256,
    lowerSha256Pattern,
    "placement attestation digest",
  );
  requireExact(record.contract_version, 1, "placement contract version");
  if (!["staging", "production"].includes(record.environment)) {
    throw new ShardRegistryError("placement environment is invalid");
  }
  requireToken(
    record.controller_service_name,
    controllerServiceNamePattern,
    "placement Controller service name",
  );
  requireToken(
    record.controller_version_id,
    versionIdPattern,
    "placement Controller version ID",
  );
  requireExact(
    record.durable_object_namespace_binding,
    "RELAY_SHARDS",
    "placement Durable Object namespace binding",
  );
  requireExact(
    record.durable_object_class,
    "RelayShardContainer",
    "placement Durable Object class",
  );
  requireExact(record.jurisdiction, "default", "placement jurisdiction");
  requireToken(
    record.canonical_name_sha256,
    lowerSha256Pattern,
    "placement canonical name digest",
  );
  requireToken(record.object_id_sha256, lowerSha256Pattern, "placement object ID digest");
  requireExact(record.shard_contract_version, 1, "placement shard contract");
  requireInteger(record.ring_generation, 1, 1_000_000, "placement ring generation");
  requireInteger(record.shard_count, 1, MAX_SHARD_COUNT, "placement shard count");
  requireInteger(record.shard_index, 0, record.shard_count - 1, "placement shard index");
  requireExact(
    record.instance_name,
    `cinatoken-relay-shard-v1-${String(record.shard_index).padStart(4, "0")}`,
    "placement instance name",
  );
  requireExact(
    record.canonical_name_sha256,
    createHash("sha256").update(record.instance_name, "utf8").digest("hex"),
    "placement canonical name digest",
  );
  requireInteger(record.activation_id, 1, Number.MAX_SAFE_INTEGER, "placement activation ID");
  for (const [field, label] of [
    ["campaign_id", "placement campaign ID"],
    ["claim_digest_sha256", "placement claim digest"],
    ["readiness_result_sha256", "placement readiness result digest"],
    ["activation_digest_sha256", "placement activation digest"],
    ["consumption_digest_sha256", "placement consumption digest"],
  ]) {
    requireToken(record[field], lowerSha256Pattern, label);
  }
  requireInteger(record.recorded_at, 1, Number.MAX_SAFE_INTEGER, "placement timestamp");
}

function validatePlacementRecordUniqueness(records) {
  const attestationDigests = new Set();
  const activationIds = new Set();
  const canonicalNames = new Set();
  const objectIds = new Set();
  const placementSequences = new Set();
  for (const record of records) {
    requireUnique(
      placementSequences,
      record.placement_event_sequence,
      "placement event sequence",
    );
    requireUnique(
      attestationDigests,
      record.placement_attestation_digest_sha256,
      "placement attestation digest",
    );
    requireUnique(activationIds, record.activation_id, "placement activation ID");
    requireUnique(
      canonicalNames,
      record.canonical_name_sha256,
      "placement canonical name digest",
    );
    requireUnique(objectIds, record.object_id_sha256, "placement object ID digest");
  }
}

function activationMatchesReceipt(record, receipt, candidate) {
  return (
    record.shard_count === receipt.shard_count &&
    record.shard_count === candidate.shardCount &&
    record.shard_index === receipt.shard_index &&
    record.instance_name === receipt.instance_name &&
    record.shard_contract_version === receipt.shard_contract_version &&
    record.runtime_protocol_version === receipt.runtime_protocol_version &&
    record.runtime_contract_version === receipt.runtime_contract_version &&
    record.runtime_build_id === receipt.runtime_build_id &&
    record.runtime_build_id === candidate.runtimeBuildId &&
    record.activation_generation === receipt.activation_generation &&
    record.activation_probe_generation === receipt.activation_probe_generation &&
    record.environment === receipt.environment &&
    record.container_status === receipt.container_status &&
    record.readiness_result_code === receipt.readiness_result_code &&
    record.process_ready === receipt.process_ready &&
    record.runtime_execution_enabled === receipt.runtime_execution_enabled &&
    record.controller_execution_enabled === receipt.controller_execution_enabled &&
    record.activation_digest_sha256 === receipt.activation_digest_sha256 &&
    record.activated_at === receipt.readiness_checked_at
  );
}

function validateActivationRecord(record, { controllerVersionId, ringGeneration, highWatermark }) {
  validateActivationRecordShape(record);
  requireInteger(record.registry_event_sequence, 1, highWatermark, "activation event sequence");
  requireInteger(record.shard_count, 1, MAX_SHARD_COUNT, "activation shard count");
  requireInteger(record.shard_index, 0, record.shard_count - 1, "activation shard index");
  requireExact(
    record.instance_name,
    `cinatoken-relay-shard-v1-${String(record.shard_index).padStart(4, "0")}`,
    "activation instance name",
  );
  for (const [field, label] of [
    ["shard_contract_version", "activation shard contract"],
    ["runtime_protocol_version", "activation runtime protocol"],
    ["runtime_contract_version", "activation runtime contract"],
    ["activation_generation", "activation generation"],
    ["activation_probe_generation", "activation probe generation"],
  ]) {
    requireInteger(record[field], 1, 1_000_000, label);
  }
  requireToken(record.runtime_build_id, lowerSha256Pattern, "activation runtime build ID");
  requireExact(record.environment, "staging", "activation environment");
  requireExact(record.container_status, "healthy", "activation Container status");
  if (!["process_ready_execution_disabled", "execution_ready"].includes(record.readiness_result_code)) {
    throw new ShardRegistryError("activation readiness result is invalid");
  }
  requireBoolean(record.process_ready, "activation process readiness");
  requireBoolean(record.runtime_execution_enabled, "activation runtime execution gate");
  requireBoolean(record.controller_execution_enabled, "activation Controller execution gate");
  requireExact(record.process_ready, true, "activation process readiness");
  if (
    record.readiness_result_code === "execution_ready" &&
    (!record.runtime_execution_enabled || !record.controller_execution_enabled)
  ) {
    throw new ShardRegistryError("execution-ready activation has a disabled gate");
  }
  if (
    record.readiness_result_code === "process_ready_execution_disabled" &&
    record.runtime_execution_enabled &&
    record.controller_execution_enabled
  ) {
    throw new ShardRegistryError("disabled activation has no disabled gate");
  }
  requireToken(record.activation_digest_sha256, lowerSha256Pattern, "activation digest");
  requireInteger(record.activated_at, 1, Number.MAX_SAFE_INTEGER, "activation timestamp");
  requireExact(
    record.activation_digest_sha256,
    activationDigestSha256({ controllerVersionId, ringGeneration, record }),
    "activation digest",
  );
}

function validateActivationRecordShape(record) {
  record = requireObject(record, "activation record");
  exactKeys(record, activationRecordKeys, "activation record");
}

function activationRecordFromReceipt(receipt, registryEventSequence) {
  return {
    registry_event_sequence: registryEventSequence,
    shard_count: receipt.shard_count,
    shard_index: receipt.shard_index,
    instance_name: receipt.instance_name,
    shard_contract_version: receipt.shard_contract_version,
    runtime_protocol_version: receipt.runtime_protocol_version,
    runtime_contract_version: receipt.runtime_contract_version,
    runtime_build_id: receipt.runtime_build_id,
    activation_generation: receipt.activation_generation,
    activation_probe_generation: receipt.activation_probe_generation,
    environment: receipt.environment,
    container_status: receipt.container_status,
    readiness_result_code: receipt.readiness_result_code,
    process_ready: receipt.process_ready,
    runtime_execution_enabled: receipt.runtime_execution_enabled,
    controller_execution_enabled: receipt.controller_execution_enabled,
    activation_digest_sha256: receipt.activation_digest_sha256,
    activated_at: receipt.readiness_checked_at,
  };
}

function campaignSnapshotDigest(snapshot) {
  const digestInput = { ...snapshot };
  delete digestInput.capturedAt;
  delete digestInput.snapshotSha256;
  return sha256Canonical(digestInput);
}

function campaignReadbackFromSnapshot(snapshot) {
  return {
    contract_version: snapshot.contractVersion,
    campaign_contract: snapshot.campaignContract,
    state: snapshot.state,
    campaign_id: snapshot.campaignId,
    controller_version_id: snapshot.controllerVersionId,
    action_gate_inventory_sha256: snapshot.actionGateInventorySha256,
    action_gate_count: snapshot.actionGateCount,
    all_action_gates_false: snapshot.allActionGatesFalse,
    foundation_manifest_sha256: snapshot.foundationManifestSha256,
    runtime_build_id: snapshot.runtimeBuildId,
    ring_generation: snapshot.ringGeneration,
    shard_count: snapshot.shardCount,
    shard_contract_version: snapshot.shardContractVersion,
    runtime_protocol_version: snapshot.runtimeProtocolVersion,
    runtime_contract_version: snapshot.runtimeContractVersion,
    activation_generation: snapshot.activationGeneration,
    environment: snapshot.environment,
    campaign_digest_sha256: snapshot.campaignDigestSha256,
    created_at: snapshot.createdAt,
    expires_at: snapshot.expiresAt,
    claimed_shard_count: snapshot.claimedShardCount,
    consumed_shard_count: snapshot.consumedShardCount,
    seal_reason: snapshot.sealReason,
    seal_detail_code: snapshot.sealDetailCode,
    last_consumption_digest_sha256: snapshot.lastConsumptionDigestSha256,
    sealed_at: snapshot.sealedAt,
    receipts: snapshot.receipts,
  };
}

function digestParts(domain, values) {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const value of values) {
    const bytes = Buffer.from(String(value), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ShardRegistryError("canonical numbers must be safe integers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const object = requireObject(value, "canonical object");
  const result = Object.create(null);
  for (const key of Object.keys(object).sort()) result[key] = canonicalValue(object[key]);
  return result;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShardRegistryError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ShardRegistryError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ShardRegistryError(`${label} fields are invalid`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new ShardRegistryError(`${label} is invalid`);
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new ShardRegistryError(`${label} is invalid`);
}

function requireUnique(seen, value, label) {
  if (!seen.add(value)) throw new ShardRegistryError(`${label} is duplicated`);
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}
