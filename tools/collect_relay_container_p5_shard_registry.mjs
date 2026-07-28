#!/usr/bin/env bun

import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVATION_PAGE_SIZE,
  MAX_LEDGER_RECORDS,
  PLACEMENT_PAGE_SIZE,
  SHARD_REGISTRY_CAPTURE_CONTRACT,
  ShardRegistryError,
  buildActivationSnapshot,
  buildCampaignSnapshot,
  buildPlacementSnapshot,
  buildShardRegistryCapture,
  canonicalJson,
  validatePlacementPage,
  validateRegistryCandidate,
} from "./lib/relay_container_shard_registry.mjs";

export const SHARD_REGISTRY_REQUEST_CONTRACT =
  "cinatoken-relay-container-shard-registry-request-v1";
export const SHARD_REGISTRY_COOKIE_ENV = "CINATOKEN_P5_SHARD_REGISTRY_COOKIE";

const minObservationSeconds = 5 * 60;
const maxObservationSeconds = 2 * 60 * 60;
const maxRequestBytes = 256 * 1024;
const maxResponseBytes = 1024 * 1024;
const maxCampaignResponseBytes = 4 * 1024 * 1024;
const maxPages = Math.ceil(MAX_LEDGER_RECORDS / ACTIVATION_PAGE_SIZE) + 1;
const maxPlacementPages =
  Math.ceil(MAX_LEDGER_RECORDS / PLACEMENT_PAGE_SIZE) + 1;
const lowerSha256Pattern = /^[0-9a-f]{64}$/;

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
  return buildShardRegistryCapture({
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

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ShardRegistryError(`${label} fields are invalid`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !lowerSha256Pattern.test(value)) {
    throw new ShardRegistryError(`${label} is invalid`);
  }
}
