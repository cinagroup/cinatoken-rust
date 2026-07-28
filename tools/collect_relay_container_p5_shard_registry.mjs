#!/usr/bin/env bun

import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVATION_PAGE_SIZE,
  MAX_LEDGER_RECORDS,
  PLACEMENT_PAGE_SIZE,
  SHARD_REGISTRY_CAPTURE_CONTRACT as HISTORICAL_SHARD_REGISTRY_CAPTURE_CONTRACT,
  SHARD_REGISTRY_COLLECTOR_VERSION as HISTORICAL_SHARD_REGISTRY_COLLECTOR_VERSION,
  ShardRegistryError,
  buildActivationSnapshot,
  buildCampaignSnapshot,
  buildPlacementSnapshot,
  buildShardRegistryCapture,
  canonicalJson,
  sha256Canonical,
  validatePlacementPage,
  validateRegistryCandidate,
  validateShardRegistryCapture as validateHistoricalShardRegistryCapture,
} from "./lib/relay_container_shard_registry.mjs";

export const SHARD_REGISTRY_REQUEST_CONTRACT =
  "cinatoken-relay-container-shard-registry-request-v1";
export const SHARD_REGISTRY_CAPTURE_CONTRACT =
  "cinatoken-relay-container-shard-registry-capture-v4";
export const SHARD_REGISTRY_COLLECTOR_VERSION = 4;
export const PLACEMENT_MUTATION_AUTHORIZATION_EVIDENCE_CONTRACT =
  "cinatoken-relay-container-shard-placement-mutation-authorization-evidence-v1";
export const PLACEMENT_MUTATION_AUTHORIZATION_MIGRATION =
  "0063_relay_container_shard_placement_mutation_authorizations.sql";
export const SHARD_REGISTRY_COOKIE_ENV = "CINATOKEN_P5_SHARD_REGISTRY_COOKIE";

const minObservationSeconds = 5 * 60;
const maxObservationSeconds = 2 * 60 * 60;
const maxRequestBytes = 256 * 1024;
const maxResponseBytes = 1024 * 1024;
const maxCampaignResponseBytes = 4 * 1024 * 1024;
const maxAuthorizationResponseBytes = 128 * 1024;
const maxPages = Math.ceil(MAX_LEDGER_RECORDS / ACTIVATION_PAGE_SIZE) + 1;
const maxPlacementPages =
  Math.ceil(MAX_LEDGER_RECORDS / PLACEMENT_PAGE_SIZE) + 1;
const lowerSha256Pattern = /^[0-9a-f]{64}$/;
const issuerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const placementMutationAuthorizationRowKeys = Object.freeze([
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
]);

if (import.meta.main) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const request = validateCollectorRequest(
      JSON.parse(await readCanonicalRequest(options.requestPath)),
    );
    if (options.dryRun) {
      console.log(
        canonicalJson({
          schemaVersion: 1,
          contract: SHARD_REGISTRY_CAPTURE_CONTRACT,
          mode: "dry-run",
          ok: true,
          evidenceReady: false,
          environment: "staging",
          origin: request.origin,
          observationSeconds: request.observationSeconds,
          candidate: request.candidate,
          campaignId: request.campaignId,
          foundationManifestSha256: request.foundationManifestSha256,
          credentialConfigured: false,
          remoteMutationPerformed: false,
          shardDoOrContainerWakePerformed: false,
        }),
      );
    } else {
      requireLiveConfirmation(options);
      const cookie = requireCookie(process.env[SHARD_REGISTRY_COOKIE_ENV]);
      const capture = await collectShardRegistry(request, { cookie });
      console.log(canonicalJson(capture));
      if (!capture.evidenceReady) process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      canonicalJson({
        schemaVersion: 1,
        contract: SHARD_REGISTRY_CAPTURE_CONTRACT,
        ok: false,
        evidenceReady: false,
        productionEligible: false,
        error: error instanceof Error ? error.message : "shard registry collection failed",
      }),
    );
    process.exitCode = 1;
  }
}

export function parseCliArgs(argv) {
  let requestPath = null;
  let dryRun = false;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new ShardRegistryError("--dry-run must not be repeated");
      dryRun = true;
    } else if (argument === "--confirm-staging-readback") {
      if (confirmed) {
        throw new ShardRegistryError("--confirm-staging-readback must not be repeated");
      }
      confirmed = true;
    } else if (argument === "--request") {
      if (requestPath !== null) throw new ShardRegistryError("--request must not be repeated");
      requestPath = argv[++index] ?? null;
      if (!requestPath || requestPath.startsWith("--")) {
        throw new ShardRegistryError("--request requires a path");
      }
    } else {
      throw new ShardRegistryError(`unknown option: ${argument}`);
    }
  }
  if (requestPath === null) throw new ShardRegistryError("--request is required");
  if (dryRun && confirmed) throw new ShardRegistryError("dry-run does not accept live confirmation");
  return { requestPath, dryRun, confirmed };
}

export function validateCollectorRequest(value) {
  if (!isPlainObject(value)) throw new ShardRegistryError("collector request must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "contract",
      "environment",
      "origin",
      "observationSeconds",
      "candidate",
      "campaignId",
      "foundationManifestSha256",
    ],
    "collector request",
  );
  if (value.schemaVersion !== 1 || value.contract !== SHARD_REGISTRY_REQUEST_CONTRACT) {
    throw new ShardRegistryError("collector request contract is invalid");
  }
  if (value.environment !== "staging") {
    throw new ShardRegistryError("collector request must target staging");
  }
  if (
    !Number.isSafeInteger(value.observationSeconds) ||
    value.observationSeconds < minObservationSeconds ||
    value.observationSeconds > maxObservationSeconds
  ) {
    throw new ShardRegistryError("collector observation window is invalid");
  }
  const origin = validateStagingOrigin(value.origin);
  requireSha256(value.campaignId, "collector campaign ID");
  requireSha256(value.foundationManifestSha256, "collector foundation manifest digest");
  return { ...value, origin, candidate: validateRegistryCandidate(value.candidate) };
}

export async function collectCampaignSnapshot(
  { origin, candidate, campaignId, foundationManifestSha256, capturedAt },
  { cookie, fetchImpl = fetch } = {},
) {
  validateStagingOrigin(origin);
  candidate = validateRegistryCandidate(candidate);
  requireSha256(campaignId, "campaign ID");
  requireSha256(foundationManifestSha256, "campaign foundation manifest digest");
  requireCookie(cookie);
  if (typeof fetchImpl !== "function") throw new ShardRegistryError("fetch implementation is invalid");
  const url = new URL("/api/platform/container/shards/activation-campaigns", origin);
  url.searchParams.set("campaign_id", campaignId);
  const campaign = await fetchEnvelopeData(
    url,
    cookie,
    fetchImpl,
    maxCampaignResponseBytes,
    "campaign",
  );
  return buildCampaignSnapshot({
    capturedAt,
    campaign,
    expected: { ...candidate, campaignId, foundationManifestSha256 },
  });
}

export async function collectPlacementMutationAuthorizationSnapshot(
  { origin, candidate, campaign, capturedAt },
  { cookie, fetchImpl = fetch } = {},
) {
  validateStagingOrigin(origin);
  candidate = validateRegistryCandidate(candidate);
  campaign = requireObject(campaign, "placement authorization campaign");
  requireSha256(campaign.campaignId, "placement authorization campaign ID");
  requireCookie(cookie);
  if (typeof fetchImpl !== "function") {
    throw new ShardRegistryError("fetch implementation is invalid");
  }
  const url = new URL(
    "/api/platform/container/shards/placement-mutation-authorizations",
    origin,
  );
  url.searchParams.set("campaign_id", campaign.campaignId);
  const row = await fetchEnvelopeData(
    url,
    cookie,
    fetchImpl,
    maxAuthorizationResponseBytes,
    "placement mutation authorization",
  );
  return buildPlacementMutationAuthorizationSnapshot({
    capturedAt,
    row,
    expected: { candidate, campaign },
  });
}

export function buildPlacementMutationAuthorizationSnapshot({
  capturedAt,
  row,
  expected,
}) {
  capturedAt = timestamp(new Date(capturedAt), "placement authorization capturedAt");
  row = validatePlacementMutationAuthorizationRow(row, expected);
  return {
    capturedAt,
    row,
    rowSha256: sha256Canonical(row),
  };
}

export function validatePlacementMutationAuthorizationRow(
  value,
  { candidate, campaign },
) {
  const row = requireObject(value, "placement mutation authorization row");
  exactKeys(
    row,
    placementMutationAuthorizationRowKeys,
    "placement mutation authorization row",
  );
  for (const [field, label] of [
    ["authorization_id_sha256", "authorization ID"],
    ["execution_nonce_sha256", "execution nonce digest"],
    ["campaign_nonce_sha256", "campaign nonce digest"],
    ["subject_digest_sha256", "subject digest"],
    ["signer_spki_sha256", "signer SPKI digest"],
    ["action_gate_inventory_sha256", "action gate inventory digest"],
    ["foundation_manifest_sha256", "foundation manifest digest"],
    ["runtime_build_id", "runtime build ID"],
    ["campaign_id", "campaign ID"],
    ["campaign_digest_sha256", "campaign digest"],
  ]) {
    requireSha256(row[field], `placement authorization ${label}`);
  }
  if (
    new Set([
      row.authorization_id_sha256,
      row.execution_nonce_sha256,
      row.campaign_nonce_sha256,
    ]).size !== 3
  ) {
    throw new ShardRegistryError(
      "placement authorization identity digests must be distinct",
    );
  }
  requireExact(row.contract_version, 1, "placement authorization contract version");
  requireExact(
    row.authorization_contract,
    "cinatoken-relay-shard-placement-mutation-authorization-v1",
    "placement authorization contract",
  );
  requireToken(row.issuer, issuerPattern, "placement authorization issuer");
  requireToken(row.key_id, keyIdPattern, "placement authorization key ID");
  requireExact(row.environment, "staging", "placement authorization environment");
  requireExact(
    row.controller_service_name,
    "cinatoken-container-controller-staging",
    "placement authorization Controller service",
  );
  requireToken(
    row.controller_version_id,
    versionIdPattern,
    "placement authorization Controller version",
  );
  for (const [field, minimum, maximum, label] of [
    ["ring_generation", 1, 1_000_000, "ring generation"],
    ["shard_count", 1, 1_024, "shard count"],
    ["campaign_lifetime_seconds", 60, 3_600, "campaign lifetime"],
    ["permit_issued_at", 1, Number.MAX_SAFE_INTEGER, "permit issued timestamp"],
    ["permit_expires_at", 1, Number.MAX_SAFE_INTEGER, "permit expiry timestamp"],
    ["campaign_expires_at", 1, Number.MAX_SAFE_INTEGER, "campaign expiry timestamp"],
    ["consumed_by_admin_id", 1, Number.MAX_SAFE_INTEGER, "admin ID"],
    ["consumed_at", 1, Number.MAX_SAFE_INTEGER, "consumption timestamp"],
  ]) {
    requireInteger(
      row[field],
      minimum,
      maximum,
      `placement authorization ${label}`,
    );
  }
  if (
    row.permit_expires_at < row.permit_issued_at + 60 ||
    row.permit_expires_at > row.permit_issued_at + 600
  ) {
    throw new ShardRegistryError(
      "placement authorization permit window is invalid",
    );
  }
  candidate = validateRegistryCandidate(candidate);
  campaign = requireObject(campaign, "placement authorization campaign");
  for (const [actual, wanted, label] of [
    [row.controller_version_id, candidate.controllerVersionId, "Controller version"],
    [row.runtime_build_id, candidate.runtimeBuildId, "runtime build"],
    [row.ring_generation, candidate.ringGeneration, "ring generation"],
    [row.shard_count, candidate.shardCount, "shard count"],
    [row.campaign_id, campaign.campaignId, "campaign ID"],
    [row.campaign_digest_sha256, campaign.campaignDigestSha256, "campaign digest"],
    [
      row.action_gate_inventory_sha256,
      campaign.actionGateInventorySha256,
      "action gate inventory",
    ],
    [
      row.foundation_manifest_sha256,
      campaign.foundationManifestSha256,
      "foundation manifest",
    ],
    [row.campaign_expires_at, campaign.expiresAt, "campaign expiry"],
    [
      row.campaign_lifetime_seconds,
      campaign.expiresAt - campaign.createdAt,
      "campaign lifetime",
    ],
  ]) {
    requireExact(actual, wanted, `placement authorization ${label}`);
  }
  if (Math.abs(row.consumed_at - campaign.createdAt) > 5) {
    throw new ShardRegistryError(
      "placement authorization consumption does not match campaign creation",
    );
  }
  return row;
}

export async function collectActivationSnapshot(
  { origin, candidate, capturedAt },
  { cookie, fetchImpl = fetch } = {},
) {
  validateStagingOrigin(origin);
  candidate = validateRegistryCandidate(candidate);
  requireCookie(cookie);
  if (typeof fetchImpl !== "function") throw new ShardRegistryError("fetch implementation is invalid");
  const pages = [];
  const seenCursors = new Set();
  let highWatermark = null;
  let cursor = null;
  for (let index = 0; index < maxPages; index += 1) {
    const url = new URL("/api/platform/container/shards/activations", origin);
    url.searchParams.set("controller_version_id", candidate.controllerVersionId);
    url.searchParams.set("ring_generation", String(candidate.ringGeneration));
    url.searchParams.set("limit", String(ACTIVATION_PAGE_SIZE));
    if (highWatermark !== null && highWatermark > 0) {
      url.searchParams.set("high_watermark", String(highWatermark));
    }
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const page = await fetchEnvelopeData(
      url,
      cookie,
      fetchImpl,
      maxResponseBytes,
      "activation",
    );
    if (highWatermark === null) highWatermark = page.high_watermark;
    pages.push(page);
    if (page.pagination_complete) {
      return buildActivationSnapshot({ capturedAt, pages });
    }
    if (page.next_cursor === null || !seenCursors.add(page.next_cursor)) {
      throw new ShardRegistryError("activation pagination cursor is invalid");
    }
    cursor = page.next_cursor;
  }
  throw new ShardRegistryError("activation pagination exceeded its page bound");
}

export async function collectPlacementSnapshot(
  { origin, candidate, campaignId, capturedAt },
  { cookie, fetchImpl = fetch } = {},
) {
  validateStagingOrigin(origin);
  candidate = validateRegistryCandidate(candidate);
  requireSha256(campaignId, "placement campaign ID");
  requireCookie(cookie);
  if (typeof fetchImpl !== "function") {
    throw new ShardRegistryError("fetch implementation is invalid");
  }
  const pages = [];
  const seenCursors = new Set();
  let highWatermark = null;
  let totalRecords = null;
  let afterSequence = 0;
  let cursor = null;
  for (let index = 0; index < maxPlacementPages; index += 1) {
    const url = new URL("/api/platform/container/shards/placements", origin);
    url.searchParams.set("controller_version_id", candidate.controllerVersionId);
    url.searchParams.set("ring_generation", String(candidate.ringGeneration));
    url.searchParams.set("campaign_id", campaignId);
    url.searchParams.set("limit", String(PLACEMENT_PAGE_SIZE));
    if (highWatermark !== null && highWatermark > 0) {
      url.searchParams.set("high_watermark", String(highWatermark));
    }
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const page = validatePlacementPage(
      await fetchEnvelopeData(
        url,
        cookie,
        fetchImpl,
        maxResponseBytes,
        "placement",
      ),
      {
        controllerVersionId: candidate.controllerVersionId,
        ringGeneration: candidate.ringGeneration,
        campaignId,
        ...(highWatermark === null
          ? {}
          : { highWatermark, totalRecords }),
        afterSequence,
      },
    );
    if (highWatermark === null) {
      highWatermark = page.high_watermark;
      totalRecords = page.total_records;
    }
    pages.push(page);
    if (page.pagination_complete) {
      return buildPlacementSnapshot({ capturedAt, pages });
    }
    if (page.next_cursor === null || !seenCursors.add(page.next_cursor)) {
      throw new ShardRegistryError("placement pagination cursor is invalid");
    }
    cursor = page.next_cursor;
    afterSequence = page.records.at(-1).placement_event_sequence;
  }
  throw new ShardRegistryError("placement pagination exceeded its page bound");
}

export async function collectShardRegistry(
  request,
  { cookie, fetchImpl = fetch, now = () => new Date(), sleep = delay } = {},
) {
  request = validateCollectorRequest(request);
  requireCookie(cookie);
  const observationStartedAt = timestamp(now(), "observation start");
  const campaignBefore = await collectCampaignSnapshot(
    {
      origin: request.origin,
      candidate: request.candidate,
      campaignId: request.campaignId,
      foundationManifestSha256: request.foundationManifestSha256,
      capturedAt: observationStartedAt,
    },
    { cookie, fetchImpl },
  );
  const authorizationBefore =
    await collectPlacementMutationAuthorizationSnapshot(
      {
        origin: request.origin,
        candidate: request.candidate,
        campaign: campaignBefore,
        capturedAt: observationStartedAt,
      },
      { cookie, fetchImpl },
    );
  const before = await collectActivationSnapshot(
    { origin: request.origin, candidate: request.candidate, capturedAt: observationStartedAt },
    { cookie, fetchImpl },
  );
  const placementBefore = await collectPlacementSnapshot(
    {
      origin: request.origin,
      candidate: request.candidate,
      campaignId: request.campaignId,
      capturedAt: observationStartedAt,
    },
    { cookie, fetchImpl },
  );
  await sleep(request.observationSeconds * 1_000);
  const observationEndedAt = timestamp(now(), "observation end");
  const elapsed = (Date.parse(observationEndedAt) - Date.parse(observationStartedAt)) / 1_000;
  if (elapsed < request.observationSeconds || elapsed > maxObservationSeconds) {
    throw new ShardRegistryError("observed shard registry window is invalid");
  }
  const campaignAfter = await collectCampaignSnapshot(
    {
      origin: request.origin,
      candidate: request.candidate,
      campaignId: request.campaignId,
      foundationManifestSha256: request.foundationManifestSha256,
      capturedAt: observationEndedAt,
    },
    { cookie, fetchImpl },
  );
  const authorizationAfter =
    await collectPlacementMutationAuthorizationSnapshot(
      {
        origin: request.origin,
        candidate: request.candidate,
        campaign: campaignAfter,
        capturedAt: observationEndedAt,
      },
      { cookie, fetchImpl },
    );
  const after = await collectActivationSnapshot(
    { origin: request.origin, candidate: request.candidate, capturedAt: observationEndedAt },
    { cookie, fetchImpl },
  );
  const placementAfter = await collectPlacementSnapshot(
    {
      origin: request.origin,
      candidate: request.candidate,
      campaignId: request.campaignId,
      capturedAt: observationEndedAt,
    },
    { cookie, fetchImpl },
  );
  const registryCore = buildShardRegistryCapture({
    candidate: request.candidate,
    observationStartedAt,
    observationEndedAt,
    campaignBefore,
    campaignAfter,
    before,
    after,
    placementBefore,
    placementAfter,
  });
  return buildAuthorizedShardRegistryCapture({
    registryCore,
    authorizationBefore,
    authorizationAfter,
  });
}

export function buildAuthorizedShardRegistryCapture({
  registryCore,
  authorizationBefore,
  authorizationAfter,
}) {
  registryCore = validateHistoricalShardRegistryCapture(registryCore);
  authorizationBefore = validatePlacementMutationAuthorizationSnapshot(
    authorizationBefore,
    registryCore,
    "before",
  );
  authorizationAfter = validatePlacementMutationAuthorizationSnapshot(
    authorizationAfter,
    registryCore,
    "after",
  );
  const authorizationStable =
    authorizationBefore.rowSha256 === authorizationAfter.rowSha256;
  if (!authorizationStable) {
    throw new ShardRegistryError(
      "placement mutation authorization readback drifted",
    );
  }
  return {
    schemaVersion: 4,
    contract: SHARD_REGISTRY_CAPTURE_CONTRACT,
    environment: "staging",
    collectorVersion: SHARD_REGISTRY_COLLECTOR_VERSION,
    registryCore,
    placementMutationAuthorization: {
      schemaVersion: 1,
      contract: PLACEMENT_MUTATION_AUTHORIZATION_EVIDENCE_CONTRACT,
      migration: PLACEMENT_MUTATION_AUTHORIZATION_MIGRATION,
      row: authorizationBefore.row,
      rowSha256: authorizationBefore.rowSha256,
      readback: {
        beforeCapturedAt: authorizationBefore.capturedAt,
        afterCapturedAt: authorizationAfter.capturedAt,
        beforeRowSha256: authorizationBefore.rowSha256,
        afterRowSha256: authorizationAfter.rowSha256,
        stable: authorizationStable,
      },
    },
    paginationComplete: registryCore.paginationComplete,
    evidenceReady: registryCore.evidenceReady,
    blockers: registryCore.blockers,
    safetyBoundary: registryCore.safetyBoundary,
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
      "registryCore",
      "placementMutationAuthorization",
      "paginationComplete",
      "evidenceReady",
      "blockers",
      "safetyBoundary",
    ],
    "shard registry capture",
  );
  requireExact(capture.schemaVersion, 4, "shard registry capture schemaVersion");
  requireExact(
    capture.contract,
    SHARD_REGISTRY_CAPTURE_CONTRACT,
    "shard registry capture contract",
  );
  requireExact(capture.environment, "staging", "shard registry capture environment");
  requireExact(
    capture.collectorVersion,
    SHARD_REGISTRY_COLLECTOR_VERSION,
    "shard registry collector version",
  );
  const registryCore = validateHistoricalShardRegistryCapture(
    capture.registryCore,
    expectedCandidate,
  );
  requireExact(
    registryCore.schemaVersion,
    3,
    "historical shard registry core schemaVersion",
  );
  requireExact(
    registryCore.contract,
    HISTORICAL_SHARD_REGISTRY_CAPTURE_CONTRACT,
    "historical shard registry core contract",
  );
  requireExact(
    registryCore.collectorVersion,
    HISTORICAL_SHARD_REGISTRY_COLLECTOR_VERSION,
    "historical shard registry core collector version",
  );
  const authorization = validatePlacementMutationAuthorizationEvidence(
    capture.placementMutationAuthorization,
    registryCore,
  );
  const rebuilt = buildAuthorizedShardRegistryCapture({
    registryCore,
    authorizationBefore: {
      capturedAt: authorization.readback.beforeCapturedAt,
      row: authorization.row,
      rowSha256: authorization.readback.beforeRowSha256,
    },
    authorizationAfter: {
      capturedAt: authorization.readback.afterCapturedAt,
      row: authorization.row,
      rowSha256: authorization.readback.afterRowSha256,
    },
  });
  if (canonicalJson(capture) !== canonicalJson(rebuilt)) {
    throw new ShardRegistryError(
      "shard registry capture contains derived-field drift",
    );
  }
  return rebuilt;
}

function validatePlacementMutationAuthorizationSnapshot(
  value,
  registryCore,
  label,
) {
  const snapshot = requireObject(
    value,
    `${label} placement mutation authorization snapshot`,
  );
  exactKeys(
    snapshot,
    ["capturedAt", "row", "rowSha256"],
    `${label} placement mutation authorization snapshot`,
  );
  const capturedAt = timestamp(
    new Date(snapshot.capturedAt),
    `${label} placement authorization capturedAt`,
  );
  requireExact(
    capturedAt,
    label === "before"
      ? registryCore.observationStartedAt
      : registryCore.observationEndedAt,
    `${label} placement authorization observation boundary`,
  );
  const row = validatePlacementMutationAuthorizationRow(snapshot.row, {
    candidate: registryCore.candidate,
    campaign: registryCore.campaign,
  });
  requireExact(
    snapshot.rowSha256,
    sha256Canonical(row),
    `${label} placement authorization row digest`,
  );
  if (row.consumed_at > Math.floor(Date.parse(capturedAt) / 1_000)) {
    throw new ShardRegistryError(
      `${label} placement authorization was consumed after capture`,
    );
  }
  return { capturedAt, row, rowSha256: snapshot.rowSha256 };
}

function validatePlacementMutationAuthorizationEvidence(value, registryCore) {
  const evidence = requireObject(
    value,
    "placement mutation authorization evidence",
  );
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "contract",
      "migration",
      "row",
      "rowSha256",
      "readback",
    ],
    "placement mutation authorization evidence",
  );
  requireExact(
    evidence.schemaVersion,
    1,
    "placement mutation authorization evidence schemaVersion",
  );
  requireExact(
    evidence.contract,
    PLACEMENT_MUTATION_AUTHORIZATION_EVIDENCE_CONTRACT,
    "placement mutation authorization evidence contract",
  );
  requireExact(
    evidence.migration,
    PLACEMENT_MUTATION_AUTHORIZATION_MIGRATION,
    "placement mutation authorization evidence migration",
  );
  const row = validatePlacementMutationAuthorizationRow(evidence.row, {
    candidate: registryCore.candidate,
    campaign: registryCore.campaign,
  });
  requireExact(
    evidence.rowSha256,
    sha256Canonical(row),
    "placement mutation authorization evidence row digest",
  );
  const readback = requireObject(
    evidence.readback,
    "placement mutation authorization readback",
  );
  exactKeys(
    readback,
    [
      "beforeCapturedAt",
      "afterCapturedAt",
      "beforeRowSha256",
      "afterRowSha256",
      "stable",
    ],
    "placement mutation authorization readback",
  );
  requireExact(
    readback.beforeCapturedAt,
    registryCore.observationStartedAt,
    "placement authorization before observation boundary",
  );
  requireExact(
    readback.afterCapturedAt,
    registryCore.observationEndedAt,
    "placement authorization after observation boundary",
  );
  requireExact(
    readback.beforeRowSha256,
    evidence.rowSha256,
    "placement authorization before row digest",
  );
  requireExact(
    readback.afterRowSha256,
    evidence.rowSha256,
    "placement authorization after row digest",
  );
  requireExact(
    readback.stable,
    true,
    "placement mutation authorization readback stability",
  );
  return { ...evidence, row, readback };
}

async function fetchEnvelopeData(url, cookie, fetchImpl, maximumBytes, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", cookie },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ShardRegistryError(`${label} readback request failed`);
  }
  if (!response || response.status !== 200) {
    throw new ShardRegistryError(`${label} readback did not return 200`);
  }
  if (response.headers.get("cache-control") !== "no-store") {
    throw new ShardRegistryError(`${label} readback is missing no-store`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ShardRegistryError(`${label} readback content type is invalid`);
  }
  const bytes = await readBoundedResponse(response, maximumBytes, label);
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ShardRegistryError(`${label} readback body is invalid JSON`);
  }
  if (!isPlainObject(envelope)) throw new ShardRegistryError(`${label} envelope is invalid`);
  exactKeys(envelope, ["success", "message", "data"], `${label} envelope`);
  if (envelope.success !== true || envelope.message !== "") {
    throw new ShardRegistryError(`${label} envelope did not report success`);
  }
  return envelope.data;
}

async function readCanonicalRequest(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new ShardRegistryError("collector request path is required");
  }
  const resolved = path.resolve(file);
  const initial = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size <= 0n ||
    initial.size > BigInt(maxRequestBytes)
  ) {
    throw new ShardRegistryError("collector request is outside its byte bound");
  }
  const handle = await open(resolved, "r").catch(() => null);
  if (!handle) throw new ShardRegistryError("collector request could not be opened");
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    const actualPath = await realpath(resolved);
    if (!sameSnapshot(initial, opened) || !samePath(resolved, actualPath)) {
      throw new ShardRegistryError("collector request changed before read");
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) throw new ShardRegistryError("collector request changed while read");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(resolved, { bigint: true }).catch(() => null);
    const finalPath = await realpath(resolved).catch(() => null);
    if (
      !final ||
      final.isSymbolicLink() ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(opened, final) ||
      finalPath === null ||
      !samePath(resolved, finalPath)
    ) {
      throw new ShardRegistryError("collector request changed while read");
    }
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ShardRegistryError("collector request must be UTF-8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ShardRegistryError("collector request must be JSON");
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw new ShardRegistryError("collector request must be canonical JSON plus one newline");
  }
  return text;
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    right.nlink === 1n
  );
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function validateStagingOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ShardRegistryError("collector origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname !== "staging.cinatoken.com"
  ) {
    throw new ShardRegistryError("collector origin must be an HTTPS staging origin");
  }
  return url.origin;
}

async function readBoundedResponse(response, maximumBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new ShardRegistryError(`${label} readback content length is invalid`);
    }
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 1 ||
      parsedLength > maximumBytes
    ) {
      throw new ShardRegistryError(`${label} readback body is outside its bound`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ShardRegistryError(`${label} readback body is unavailable`);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new ShardRegistryError(`${label} readback body chunk is invalid`);
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new ShardRegistryError(`${label} readback body is outside its bound`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (total === 0 || (declaredLength !== null && total !== Number(declaredLength))) {
    throw new ShardRegistryError(`${label} readback body is outside its bound`);
  }
  return Buffer.concat(chunks, total);
}

function requireCookie(value) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 4_096 ||
    /[^\x21-\x7e]/.test(value) ||
    !/(?:^|;)\s*session=[^;]+/.test(value)
  ) {
    throw new ShardRegistryError(`${SHARD_REGISTRY_COOKIE_ENV} is invalid`);
  }
  return value;
}

function requireLiveConfirmation(options) {
  if (!options.confirmed) {
    throw new ShardRegistryError("live collection requires --confirm-staging-readback");
  }
}

function timestamp(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
  return value.toISOString();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new ShardRegistryError(`${label} must be an object`);
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
  if (actual !== expected) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !lowerSha256Pattern.test(value)) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}
