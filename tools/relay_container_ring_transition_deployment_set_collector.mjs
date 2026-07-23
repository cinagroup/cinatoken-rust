import {
  RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
} from "./relay_container_ring_transition_authorization_contract.mjs";
import {
  verifyRingTransitionBundle,
} from "./relay_container_ring_transition_contract.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "./relay_container_p5_evidence_contract.mjs";

const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_TIMEOUT_MILLISECONDS = 10_000;
const accountIdPattern = /^[0-9a-f]{32}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const serviceNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const RING_TRANSITION_DEPLOYMENT_READBACK_TRANSPORT =
  "cloudflare-api";
export const MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS = 5;
export const MAX_DEPLOYMENT_READBACK_OBSERVATION_SECONDS = 120;

export async function collectRingTransitionDeploymentSetReadback({
  transitionManifestPath,
  transitionTrustPolicyPath,
  authorizationIdSha256,
  executionNonceSha256,
  readCredentialIdSha256,
  accountId,
  apiToken,
  observationSeconds = 5,
  now = new Date(),
  fetchImpl = fetch,
  sleepImpl = sleep,
  clockImpl = () => new Date(),
}) {
  requireDate(now, "[time] collector now");
  requireSha256(authorizationIdSha256, "[input] authorization ID");
  requireSha256(executionNonceSha256, "[input] execution nonce");
  requireSha256(readCredentialIdSha256, "[input] read credential ID");
  if (authorizationIdSha256 === executionNonceSha256) {
    throw new Error("[input] authorization ID and execution nonce must differ");
  }
  requireToken(accountId, accountIdPattern, "[input] account ID");
  requireSecret(apiToken, "[input] replacement read token");
  requireInteger(
    observationSeconds,
    MIN_DEPLOYMENT_READBACK_OBSERVATION_SECONDS,
    MAX_DEPLOYMENT_READBACK_OBSERVATION_SECONDS,
    "[input] observation seconds",
  );
  if (
    typeof fetchImpl !== "function" ||
    typeof sleepImpl !== "function" ||
    typeof clockImpl !== "function"
  ) {
    throw new Error("[input] collector transports must be functions");
  }

  const transition = await verifyRingTransitionBundle({
    manifestPath: transitionManifestPath,
    trustPolicyPath: transitionTrustPolicyPath,
    now,
  });
  const expected = {
    controller: {
      serviceName: transition.serviceIdentities.controllerWorker,
      deploymentSetSha256:
        transition.plan.controllerFirst.previousDeploymentSetSha256,
      activeVersionId:
        transition.plan.controllerFirst.expectedPreviousVersionId,
    },
    edge: {
      serviceName: transition.serviceIdentities.edgeWorker,
      deploymentSetSha256:
        transition.plan.edgeSecond.previousDeploymentSetSha256,
      activeVersionId: transition.plan.edgeSecond.expectedPreviousVersionId,
    },
  };
  const verifiedToken = normalizeAccountTokenVerifyResponse(
    await fetchBoundedJson(
      fetchImpl,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      apiToken,
      "replacement read token identity",
    ),
  );
  requireExact(
    sha256Hex(Buffer.from(verifiedToken.id, "utf8")),
    readCredentialIdSha256,
    "[credential] replacement read token identity",
  );

  const before = await captureSnapshot({
    accountId,
    apiToken,
    expected,
    fetchImpl,
  });
  const beforeObservedAt = clockImpl();
  requireDate(beforeObservedAt, "[time] before snapshot");
  const beforeAt = wholeSecondIso(beforeObservedAt);
  await sleepImpl(observationSeconds * 1000);
  const after = await captureSnapshot({
    accountId,
    apiToken,
    expected,
    fetchImpl,
  });
  const afterObservedAt = clockImpl();
  requireDate(afterObservedAt, "[time] after snapshot");
  const afterAt = wholeSecondIso(afterObservedAt);
  if (
    afterObservedAt.getTime() - beforeObservedAt.getTime() <
    observationSeconds * 1000
  ) {
    throw new Error("[time] deployment observation window was too short");
  }
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error("[deployment] deployment or version bindings drifted during observation");
  }
  const admissionStartedAt = new Date(
    transition.transition.admissionStartedAt,
  );
  const transitionExpiresAt = new Date(transition.expiresAt);
  const expiresAt = new Date(
    Math.min(admissionStartedAt.getTime(), transitionExpiresAt.getTime()),
  ).toISOString();

  return {
    schemaVersion: 1,
    contract: RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
    kind: "deployment-set-readback",
    environment: "staging",
    authorizationIdSha256,
    transitionSubjectDigestSha256: transition.subjectDigestSha256,
    capturedAt: afterAt,
    expiresAt,
    status: "pass",
    facts: {
      accountIdSha256: sha256Hex(Buffer.from(accountId, "utf8")),
      transport: RING_TRANSITION_DEPLOYMENT_READBACK_TRANSPORT,
      paginationComplete: true,
      observedBeforeAt: beforeAt,
      observedAfterAt: afterAt,
      stableBeforeAfter: true,
      mutationObserved: false,
      executionNonceSha256,
      readCredentialIdSha256,
      transitionPlanDigestSha256: transition.planDigestSha256,
      controller: before.controller,
      edge: before.edge,
    },
  };
}

export function deploymentSetDigestSha256({
  serviceName,
  deploymentId,
  strategy,
  versions,
}) {
  requireToken(serviceName, serviceNamePattern, "[deployment] service name");
  requireToken(deploymentId, opaqueIdPattern, "[deployment] deployment ID");
  if (strategy !== "percentage") {
    throw new Error("[deployment] strategy must be percentage");
  }
  const normalizedVersions = normalizeActiveVersions(versions);
  return sha256Hex(
    Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        serviceName,
        deploymentId,
        strategy,
        versions: normalizedVersions,
      }),
      "utf8",
    ),
  );
}

export function normalizeDeploymentApiResponse(payload, serviceName) {
  requireToken(serviceName, serviceNamePattern, "[deployment] service name");
  const envelope = requireObject(payload, "[deployment] API envelope");
  if (envelope.success !== true) {
    throw new Error("[deployment] API response was not successful");
  }
  const result = requireObject(envelope.result, "[deployment] API result");
  if (!Array.isArray(result.deployments) || result.deployments.length < 1) {
    throw new Error("[deployment] API result has no active deployment");
  }
  const deployment = requireObject(
    result.deployments[0],
    "[deployment] active deployment",
  );
  const deploymentId = requireToken(
    deployment.id,
    opaqueIdPattern,
    "[deployment] deployment ID",
  );
  if (deployment.strategy !== "percentage") {
    throw new Error("[deployment] active deployment strategy is unsupported");
  }
  const activeVersions = normalizeActiveVersions(deployment.versions);
  return {
    serviceName,
    deploymentSetSha256: deploymentSetDigestSha256({
      serviceName,
      deploymentId,
      strategy: deployment.strategy,
      versions: activeVersions,
    }),
    activeVersions,
    deploymentId,
  };
}

export function normalizeAccountTokenVerifyResponse(payload) {
  const envelope = requireObject(payload, "[credential] token API envelope");
  if (envelope.success !== true) {
    throw new Error("[credential] token verification was not successful");
  }
  const result = requireObject(
    envelope.result,
    "[credential] token verification result",
  );
  const id = requireToken(
    result.id,
    opaqueIdPattern,
    "[credential] verified token ID",
  );
  requireExact(result.status, "active", "[credential] verified token status");
  return { id, status: "active" };
}

async function captureSnapshot({
  accountId,
  apiToken,
  expected,
  fetchImpl,
}) {
  const controller = await captureService({
    accountId,
    apiToken,
    expected: expected.controller,
    fetchImpl,
  });
  const edge = await captureService({
    accountId,
    apiToken,
    expected: expected.edge,
    fetchImpl,
  });
  return { controller, edge };
}

async function captureService({
  accountId,
  apiToken,
  expected,
  fetchImpl,
}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(expected.serviceName)}`;
  const deploymentPayload = await fetchBoundedJson(
    fetchImpl,
    `${base}/deployments`,
    apiToken,
    `${expected.serviceName} deployments`,
  );
  const deployment = normalizeDeploymentApiResponse(
    deploymentPayload,
    expected.serviceName,
  );
  if (deployment.deploymentSetSha256 !== expected.deploymentSetSha256) {
    throw new Error(
      `[deployment] ${expected.serviceName} deployment set does not match the transition review`,
    );
  }
  if (
    deployment.activeVersions.length !== 1 ||
    deployment.activeVersions[0].versionId !== expected.activeVersionId ||
    deployment.activeVersions[0].percentage !== 100
  ) {
    throw new Error(
      `[deployment] ${expected.serviceName} active version does not match the transition review`,
    );
  }
  const versionPayload = await fetchBoundedJson(
    fetchImpl,
    `${base}/versions/${encodeURIComponent(expected.activeVersionId)}`,
    apiToken,
    `${expected.serviceName} active version`,
  );
  const versionEnvelope = requireObject(
    versionPayload,
    "[version] API envelope",
  );
  if (versionEnvelope.success !== true) {
    throw new Error(`[version] ${expected.serviceName} response was not successful`);
  }
  const version = requireObject(versionEnvelope.result, "[version] API result");
  requireExact(
    version.id,
    expected.activeVersionId,
    `[version] ${expected.serviceName} ID`,
  );
  return {
    serviceName: expected.serviceName,
    deploymentSetSha256: deployment.deploymentSetSha256,
    activeVersions: deployment.activeVersions,
    versionDetailSha256: sha256Hex(
      Buffer.from(canonicalApiJson(version), "utf8"),
    ),
  };
}

async function fetchBoundedJson(fetchImpl, url, apiToken, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MILLISECONDS),
    });
    if (!response || typeof response.body?.getReader !== "function") {
      throw new Error(`[network] ${label} returned an invalid response`);
    }
    const contentLength = response.headers?.get?.("content-length");
    if (
      contentLength !== null &&
      contentLength !== undefined &&
      (!/^[0-9]+$/.test(contentLength) ||
        Number(contentLength) > MAX_API_RESPONSE_BYTES)
    ) {
      throw new Error(`[network] ${label} response exceeds its byte bound`);
    }
    const bytes = await readBoundedResponseBody(response, label);
    let payload;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error(`[network] ${label} response is not valid UTF-8 JSON`);
    }
    if (!response.ok) {
      throw new Error(`[network] ${label} returned HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("[network]")
    ) {
      throw error;
    }
    throw new Error(`[network] ${label} readback failed`);
  }
}

async function readBoundedResponseBody(response, label) {
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(MAX_API_RESPONSE_BYTES);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`[network] ${label} returned an invalid body chunk`);
      }
      if (totalBytes + value.byteLength > MAX_API_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The byte-bound failure remains authoritative if cancellation fails.
        }
        throw new Error(`[network] ${label} response exceeds its byte bound`);
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(
        bytes,
        totalBytes,
      );
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes < 2) {
    throw new Error(`[network] ${label} response exceeds its byte bound`);
  }
  return bytes.subarray(0, totalBytes);
}

function normalizeActiveVersions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error("[deployment] active versions must contain one or two entries");
  }
  const versions = value.map((raw) => {
    const version = requireObject(raw, "[deployment] active version");
    const versionId = requireToken(
      version.version_id ?? version.versionId,
      opaqueIdPattern,
      "[deployment] active version ID",
    );
    const percentage = version.percentage;
    requireInteger(percentage, 0, 100, "[deployment] active percentage");
    if (percentage === 0) {
      throw new Error("[deployment] zero-percent versions are not active");
    }
    return { versionId, percentage };
  });
  versions.sort((left, right) => left.versionId.localeCompare(right.versionId));
  if (new Set(versions.map((item) => item.versionId)).size !== versions.length) {
    throw new Error("[deployment] active version IDs must be distinct");
  }
  if (versions.reduce((sum, item) => sum + item.percentage, 0) !== 100) {
    throw new Error("[deployment] active percentages must sum to 100");
  }
  return versions;
}

function canonicalApiJson(value) {
  return JSON.stringify(canonicalApiValue(value));
}

function canonicalApiValue(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("[version] API response contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalApiValue);
  if (typeof value !== "object") {
    throw new Error("[version] API response is not JSON-compatible");
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalApiValue(value[key]);
  }
  return result;
}

function wholeSecondIso(value) {
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
  return actual;
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  return requireToken(value, sha256Pattern, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function requireSecret(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function requireDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}
