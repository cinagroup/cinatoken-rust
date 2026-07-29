import { ProtocolError } from "./protocol";
import type { ShardDrainSnapshot as LedgerShardDrainSnapshot } from "./ledger";

export const CONTROLLER_DRAIN_ATTESTATION_PATH =
  "/internal/v1/shard-placement/drain-attestation";
export const CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_HEADER =
  "x-cinatoken-controller-drain-attestation-authority";
export const CONTROLLER_DRAIN_ATTESTATION_CONTRACT =
  "cinatoken-container-controller-drain-attestation-v1";
export const CONTROLLER_DRAIN_ATTESTATION_ROLE = "drain_attestation";
export const CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT = 8;

const AUTHORITY_DOMAIN =
  "cinatoken:container-controller:drain-attestation-authority:v1\0";
const CREDENTIAL_DOMAIN =
  "cinatoken:container-controller:drain-attestation-credential:v1\0";
const STATE_DIGEST_DOMAIN =
  "cinatoken:container-controller:drain-attestation-state:v1\0";
const AUTHORITY_TYPE = "CINATOKEN-CONTROLLER-DRAIN-ATTESTATION-AUTH";
const MAX_AUTHORITY_TOKEN_BYTES = 4_096;
const MAX_AUTHORITY_JSON_SEGMENT_BYTES = 2_048;
const MAX_AUTHORITY_LIFETIME_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5;
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SNAPSHOT_KEYS = [
  "active_claimed_operations",
  "active_provider_retries",
  "active_running_operations",
  "accepted_work_drained",
  "ambiguous_provider_attempts",
  "claimed_operations",
  "completed_operations_missing_final_ack",
  "contract_version",
  "dispatched_provider_attempts",
  "execution_stop_eligible",
  "expired_claimed_operations",
  "expired_running_operations",
  "failed_operations_missing_final_ack",
  "initialized",
  "instance_name",
  "lifecycle_detail",
  "lifecycle_state",
  "lifecycle_updated_at",
  "pending_alarm_intents",
  "prepared_provider_attempts",
  "recovery_required_operations",
  "ring_generation",
  "running_operations",
  "shard_count",
  "shard_index",
  "unclassified_operations",
  "waiting_provider_retries",
] as const;
const encoder = new TextEncoder();

export interface ControllerDrainAttestationEnvironment {
  CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_ISSUER: string;
  CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_AUDIENCE: string;
  CONTROLLER_DRAIN_ATTESTATION_CURRENT_KID: string;
  CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_KID: string;
  CONTROLLER_DRAIN_ATTESTATION_CURRENT_SECRET: string;
  CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_SECRET?: string;
  CONTAINER_CONTROLLER_SERVICE_NAME: string;
  CF_VERSION_METADATA: { id: string };
}

interface ControllerDrainAttestationAuthorityHeader {
  alg: "HS256";
  kid: string;
  typ: typeof AUTHORITY_TYPE;
}

export interface ControllerDrainAttestationAuthorityClaims {
  audience: string;
  authority_version: 1;
  body_sha256: string;
  credential_id_sha256: string;
  expires_at: number;
  issued_at: number;
  issuer: string;
  method: "POST";
  path_and_query: typeof CONTROLLER_DRAIN_ATTESTATION_PATH;
  request_id_sha256: string;
  role: typeof CONTROLLER_DRAIN_ATTESTATION_ROLE;
}

export interface VerifiedControllerDrainAttestationRequest {
  claims: ControllerDrainAttestationAuthorityClaims;
}

export interface ShardDrainSnapshot extends LedgerShardDrainSnapshot {
  contract_version: 1;
  instance_name: string;
  ring_generation: number;
  shard_count: typeof CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT;
  shard_index: number;
}

export async function handleControllerDrainAttestationRequest(
  request: Request,
  env: ControllerDrainAttestationEnvironment,
  snapshots: readonly ShardDrainSnapshot[],
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  try {
    const verified = await verifyControllerDrainAttestationRequest(
      request,
      env,
      now,
    );
    return await controllerDrainAttestationResponse(
      verified,
      env,
      snapshots,
    );
  } catch (error) {
    if (error instanceof ProtocolError) {
      return secureJsonResponse({ error: error.code }, error.status);
    }
    return secureJsonResponse(
      { error: "controller_drain_attestation_failure" },
      503,
    );
  }
}

export async function verifyControllerDrainAttestationRequest(
  request: Request,
  env: ControllerDrainAttestationEnvironment,
  now = Math.floor(Date.now() / 1_000),
): Promise<VerifiedControllerDrainAttestationRequest> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== CONTROLLER_DRAIN_ATTESTATION_PATH ||
    url.search.length !== 0
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  await requireStrictEmptyBody(request);
  const claims = await verifyDrainAttestationAuthority(
    requiredAuthority(request),
    env,
    now,
  );
  return { claims };
}

export async function controllerDrainAttestationResponse(
  verified: VerifiedControllerDrainAttestationRequest,
  env: ControllerDrainAttestationEnvironment,
  snapshots: readonly ShardDrainSnapshot[],
): Promise<Response> {
  const serviceName = env.CONTAINER_CONTROLLER_SERVICE_NAME;
  const versionId = env.CF_VERSION_METADATA?.id;
  if (
    typeof serviceName !== "string" ||
    !SERVICE_NAME.test(serviceName) ||
    typeof versionId !== "string" ||
    !VERSION_ID.test(versionId)
  ) {
    throw new ProtocolError(
      "controller_drain_attestation_identity_unavailable",
      503,
    );
  }

  const normalizedSnapshots = normalizeShardDrainSnapshots(snapshots);
  const ringGeneration = normalizedSnapshots[0].ring_generation;
  const executionStopEligibleAll = normalizedSnapshots.every(
    (snapshot) => snapshot.execution_stop_eligible,
  );
  const acceptedWorkDrainedAll = normalizedSnapshots.every(
    (snapshot) => snapshot.accepted_work_drained,
  );
  const state = {
    accepted_work_drained_all: acceptedWorkDrainedAll,
    contract: CONTROLLER_DRAIN_ATTESTATION_CONTRACT,
    controller_service_name: serviceName,
    controller_version_id: versionId,
    execution_stop_eligible_all: executionStopEligibleAll,
    ring_generation: ringGeneration,
    schema_version: 1,
    shard_count: CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT,
    snapshots: normalizedSnapshots,
    traffic_return_authorized: false,
  };
  const stateDigestSha256 = await sha256Hex(
    encoder.encode(
      `${STATE_DIGEST_DOMAIN}${canonicalJsonStringify(state)}`,
    ),
  );

  return secureJsonResponse({
    ...state,
    request_id_sha256: verified.claims.request_id_sha256,
    state_digest_sha256: stateDigestSha256,
  });
}

export function normalizeShardDrainSnapshots(
  snapshots: readonly ShardDrainSnapshot[],
): readonly ShardDrainSnapshot[] {
  if (
    !Array.isArray(snapshots) ||
    snapshots.length !== CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT
  ) {
    throw new ProtocolError(
      "controller_drain_attestation_shard_set_invalid",
      409,
    );
  }

  const normalized = snapshots.map((snapshot) =>
    normalizeShardDrainSnapshot(snapshot),
  );
  normalized.sort((left, right) => left.shard_index - right.shard_index);

  const ringGeneration = normalized[0].ring_generation;
  for (
    let shardIndex = 0;
    shardIndex < CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT;
    shardIndex += 1
  ) {
    const snapshot = normalized[shardIndex];
    if (
      snapshot.shard_index !== shardIndex ||
      snapshot.ring_generation !== ringGeneration
    ) {
      throw new ProtocolError(
        "controller_drain_attestation_shard_set_invalid",
        409,
      );
    }
  }
  return normalized;
}

export async function createControllerDrainAttestationAuthorityTokenForTest(
  secret: string,
  kid: string,
  claims: ControllerDrainAttestationAuthorityClaims,
  canonical = true,
): Promise<string> {
  const header: ControllerDrainAttestationAuthorityHeader = canonical
    ? {
        alg: "HS256",
        kid,
        typ: AUTHORITY_TYPE,
      }
    : {
        typ: AUTHORITY_TYPE,
        alg: "HS256",
        kid,
      };
  const serialize = canonical
    ? canonicalJsonStringify
    : (value: unknown): string => JSON.stringify(value);
  const headerPart = encodeBase64Url(encoder.encode(serialize(header)));
  const claimsPart = encodeBase64Url(encoder.encode(serialize(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(
    `${AUTHORITY_DOMAIN}${CONTROLLER_DRAIN_ATTESTATION_ROLE}\0${headerPart}.${claimsPart}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, copyArrayBuffer(signed)),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export async function controllerDrainAttestationCredentialIdSha256(
  kid: string,
): Promise<string> {
  return sha256Hex(
    encoder.encode(
      `${CREDENTIAL_DOMAIN}${CONTROLLER_DRAIN_ATTESTATION_ROLE}\0${kid}`,
    ),
  );
}

function normalizeShardDrainSnapshot(
  value: unknown,
): ShardDrainSnapshot {
  if (!isRecord(value)) {
    throw invalidSnapshot();
  }
  assertExactKeys(
    value,
    SNAPSHOT_KEYS,
    "controller_drain_attestation_snapshot_invalid",
  );

  const contractVersion = readSnapshotInteger(
    value,
    "contract_version",
  );
  const ringGeneration = readSnapshotInteger(
    value,
    "ring_generation",
  );
  const shardCount = readSnapshotInteger(value, "shard_count");
  const shardIndex = readSnapshotInteger(value, "shard_index", 0);
  const instanceName = readSnapshotString(value, "instance_name");
  const initialized = readSnapshotBoolean(value, "initialized");
  const lifecycleState = value.lifecycle_state;
  const lifecycleDetail = value.lifecycle_detail;
  const lifecycleUpdatedAt = readSnapshotInteger(
    value,
    "lifecycle_updated_at",
  );
  if (
    contractVersion !== 1 ||
    ringGeneration < 1 ||
    shardCount !== CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT ||
    shardIndex >= CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT ||
    instanceName !== expectedInstanceName(shardIndex) ||
    initialized !== true ||
    !["idle", "running", "draining", "stopped", "error"].includes(
      String(lifecycleState),
    ) ||
    (lifecycleDetail !== null &&
      (typeof lifecycleDetail !== "string" ||
        encoder.encode(lifecycleDetail).byteLength > 256))
  ) {
    throw invalidSnapshot();
  }

  const claimedOperations = readSnapshotInteger(
    value,
    "claimed_operations",
    0,
  );
  const unclassifiedOperations = readSnapshotInteger(
    value,
    "unclassified_operations",
    0,
  );
  const activeClaimedOperations = readSnapshotInteger(
    value,
    "active_claimed_operations",
    0,
  );
  const expiredClaimedOperations = readSnapshotInteger(
    value,
    "expired_claimed_operations",
    0,
  );
  const runningOperations = readSnapshotInteger(
    value,
    "running_operations",
    0,
  );
  const activeRunningOperations = readSnapshotInteger(
    value,
    "active_running_operations",
    0,
  );
  const expiredRunningOperations = readSnapshotInteger(
    value,
    "expired_running_operations",
    0,
  );
  const preparedProviderAttempts = readSnapshotInteger(
    value,
    "prepared_provider_attempts",
    0,
  );
  const dispatchedProviderAttempts = readSnapshotInteger(
    value,
    "dispatched_provider_attempts",
    0,
  );
  const ambiguousProviderAttempts = readSnapshotInteger(
    value,
    "ambiguous_provider_attempts",
    0,
  );
  const activeProviderRetries = readSnapshotInteger(
    value,
    "active_provider_retries",
    0,
  );
  const waitingProviderRetries = readSnapshotInteger(
    value,
    "waiting_provider_retries",
    0,
  );
  const pendingAlarmIntents = readSnapshotInteger(
    value,
    "pending_alarm_intents",
    0,
  );
  const recoveryRequiredOperations = readSnapshotInteger(
    value,
    "recovery_required_operations",
    0,
  );
  const completedOperationsMissingFinalAck = readSnapshotInteger(
    value,
    "completed_operations_missing_final_ack",
    0,
  );
  const failedOperationsMissingFinalAck = readSnapshotInteger(
    value,
    "failed_operations_missing_final_ack",
    0,
  );
  const executionStopEligible = readSnapshotBoolean(
    value,
    "execution_stop_eligible",
  );
  const acceptedWorkDrained = readSnapshotBoolean(
    value,
    "accepted_work_drained",
  );

  const expectedExecutionStopEligible =
    unclassifiedOperations === 0 &&
    claimedOperations === 0 &&
    runningOperations === 0 &&
    preparedProviderAttempts === 0 &&
    dispatchedProviderAttempts === 0 &&
    activeProviderRetries === 0 &&
    waitingProviderRetries === 0 &&
    pendingAlarmIntents === 0;
  const expectedAcceptedWorkDrained =
    initialized &&
    expectedExecutionStopEligible &&
    recoveryRequiredOperations === 0 &&
    ambiguousProviderAttempts === 0 &&
    completedOperationsMissingFinalAck === 0 &&
    failedOperationsMissingFinalAck === 0;
  const activeProviderAttempts = safeCountSum([
    preparedProviderAttempts,
    dispatchedProviderAttempts,
  ]);

  if (
    safeCountSum([
      activeClaimedOperations,
      expiredClaimedOperations,
    ]) !== claimedOperations ||
    safeCountSum([
      activeRunningOperations,
      expiredRunningOperations,
    ]) !== runningOperations ||
    activeProviderAttempts > runningOperations ||
    ambiguousProviderAttempts > recoveryRequiredOperations ||
    executionStopEligible !== expectedExecutionStopEligible ||
    acceptedWorkDrained !== expectedAcceptedWorkDrained
  ) {
    throw invalidSnapshot();
  }

  return {
    active_claimed_operations: activeClaimedOperations,
    active_provider_retries: activeProviderRetries,
    active_running_operations: activeRunningOperations,
    accepted_work_drained: acceptedWorkDrained,
    ambiguous_provider_attempts: ambiguousProviderAttempts,
    claimed_operations: claimedOperations,
    completed_operations_missing_final_ack:
      completedOperationsMissingFinalAck,
    contract_version: 1,
    dispatched_provider_attempts: dispatchedProviderAttempts,
    execution_stop_eligible: executionStopEligible,
    expired_claimed_operations: expiredClaimedOperations,
    expired_running_operations: expiredRunningOperations,
    failed_operations_missing_final_ack:
      failedOperationsMissingFinalAck,
    initialized: true,
    instance_name: instanceName,
    lifecycle_detail: lifecycleDetail,
    lifecycle_state: lifecycleState as string,
    lifecycle_updated_at: lifecycleUpdatedAt,
    pending_alarm_intents: pendingAlarmIntents,
    prepared_provider_attempts: preparedProviderAttempts,
    recovery_required_operations: recoveryRequiredOperations,
    ring_generation: ringGeneration,
    running_operations: runningOperations,
    shard_count: CONTROLLER_DRAIN_ATTESTATION_SHARD_COUNT,
    shard_index: shardIndex,
    unclassified_operations: unclassifiedOperations,
    waiting_provider_retries: waitingProviderRetries,
  };
}

async function verifyDrainAttestationAuthority(
  token: string,
  env: ControllerDrainAttestationEnvironment,
  now: number,
): Promise<ControllerDrainAttestationAuthorityClaims> {
  validateKeyring(env);
  if (
    token.length === 0 ||
    encoder.encode(token).byteLength > MAX_AUTHORITY_TOKEN_BYTES
  ) {
    throw invalidAuthority();
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw invalidAuthority();
  }
  const [headerPart, claimsPart, signaturePart] = parts;
  const header = parseCanonicalJsonObject(
    decodeBase64Url(headerPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
  );
  assertExactKeys(
    header,
    ["alg", "kid", "typ"],
    "invalid_controller_drain_attestation_authority",
  );
  const kid = readString(header, "kid", 1, 32, KEY_ID);
  if (header.alg !== "HS256" || header.typ !== AUTHORITY_TYPE) {
    throw invalidAuthority();
  }

  const signature = decodeBase64Url(signaturePart, 32);
  if (signature.byteLength !== 32) {
    throw invalidAuthority();
  }
  const secret = selectSecret(env, kid);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(
    `${AUTHORITY_DOMAIN}${CONTROLLER_DRAIN_ATTESTATION_ROLE}\0${headerPart}.${claimsPart}`,
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      copyArrayBuffer(signature),
      copyArrayBuffer(signed),
    ))
  ) {
    throw invalidAuthority();
  }

  const value = parseCanonicalJsonObject(
    decodeBase64Url(claimsPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
  );
  assertExactKeys(
    value,
    [
      "audience",
      "authority_version",
      "body_sha256",
      "credential_id_sha256",
      "expires_at",
      "issued_at",
      "issuer",
      "method",
      "path_and_query",
      "request_id_sha256",
      "role",
    ],
    "invalid_controller_drain_attestation_authority",
  );
  const claims: ControllerDrainAttestationAuthorityClaims = {
    audience: readString(value, "audience", 1, 128, IDENTIFIER),
    authority_version: readInteger(value, "authority_version", 1, 1) as 1,
    body_sha256: readHex(value, "body_sha256"),
    credential_id_sha256: readHex(
      value,
      "credential_id_sha256",
    ),
    expires_at: readInteger(
      value,
      "expires_at",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    issued_at: readInteger(
      value,
      "issued_at",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    issuer: readString(value, "issuer", 1, 128, IDENTIFIER),
    method: readLiteral(value, "method", "POST"),
    path_and_query: readLiteral(
      value,
      "path_and_query",
      CONTROLLER_DRAIN_ATTESTATION_PATH,
    ),
    request_id_sha256: readHex(value, "request_id_sha256"),
    role: readLiteral(
      value,
      "role",
      CONTROLLER_DRAIN_ATTESTATION_ROLE,
    ),
  };

  if (
    claims.issuer !==
      env.CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_ISSUER ||
    claims.audience !==
      env.CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_AUDIENCE ||
    claims.body_sha256 !== EMPTY_BODY_SHA256 ||
    claims.credential_id_sha256 !==
      (await controllerDrainAttestationCredentialIdSha256(kid))
  ) {
    throw new ProtocolError(
      "controller_drain_attestation_authority_claim_mismatch",
      403,
    );
  }
  if (claims.expires_at <= now) {
    throw new ProtocolError(
      "controller_drain_attestation_authority_expired",
      409,
    );
  }
  if (
    claims.issued_at > now + MAX_CLOCK_SKEW_SECONDS ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at >
      MAX_AUTHORITY_LIFETIME_SECONDS ||
    now - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS
  ) {
    throw new ProtocolError(
      "controller_drain_attestation_authority_time_window",
      403,
    );
  }
  return claims;
}

async function requireStrictEmptyBody(request: Request): Promise<void> {
  for (const header of [
    "content-encoding",
    "content-range",
    "content-type",
    "expect",
    "location",
    "trailer",
    "transfer-encoding",
  ]) {
    if (request.headers.has(header)) {
      throw new ProtocolError(
        "invalid_controller_drain_attestation_transport",
        400,
      );
    }
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength !== "0") {
    throw new ProtocolError(
      "controller_drain_attestation_body_not_empty",
      400,
    );
  }
  if (request.body === null) return;

  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done && first.value.byteLength > 0) {
      await reader.cancel("controller_drain_attestation_body_not_empty");
      throw new ProtocolError(
        "controller_drain_attestation_body_not_empty",
        400,
      );
    }
    if (!first.done) {
      const second = await reader.read();
      if (!second.done) {
        await reader.cancel(
          "controller_drain_attestation_body_not_empty",
        );
        throw new ProtocolError(
          "controller_drain_attestation_body_not_empty",
          400,
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function requiredAuthority(request: Request): string {
  const value = request.headers.get(
    CONTROLLER_DRAIN_ATTESTATION_AUTHORITY_HEADER,
  );
  if (value === null) throw invalidAuthority();
  return value;
}

function validateKeyring(
  env: ControllerDrainAttestationEnvironment,
): void {
  const currentKid =
    env.CONTROLLER_DRAIN_ATTESTATION_CURRENT_KID;
  const currentSecret =
    env.CONTROLLER_DRAIN_ATTESTATION_CURRENT_SECRET;
  const previousKid =
    env.CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_KID;
  const previousSecret =
    env.CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_SECRET;
  const currentValid =
    typeof currentKid === "string" &&
    KEY_ID.test(currentKid) &&
    typeof currentSecret === "string" &&
    encoder.encode(currentSecret).byteLength >= 32;
  const previousKidConfigured =
    typeof previousKid === "string" && previousKid.length > 0;
  const previousSecretConfigured =
    typeof previousSecret === "string" && previousSecret.length > 0;
  const previousValid =
    previousKidConfigured === previousSecretConfigured &&
    (!previousKidConfigured ||
      (KEY_ID.test(previousKid) &&
        previousKid !== currentKid &&
        encoder.encode(previousSecret ?? "").byteLength >= 32));
  if (!currentValid || !previousValid) {
    throw new ProtocolError(
      "controller_drain_attestation_authority_unavailable",
      503,
    );
  }
}

function selectSecret(
  env: ControllerDrainAttestationEnvironment,
  kid: string,
): string {
  if (kid === env.CONTROLLER_DRAIN_ATTESTATION_CURRENT_KID) {
    return env.CONTROLLER_DRAIN_ATTESTATION_CURRENT_SECRET;
  }
  if (
    kid === env.CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_KID &&
    env.CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_SECRET !== undefined
  ) {
    return env.CONTROLLER_DRAIN_ATTESTATION_PREVIOUS_SECRET;
  }
  throw invalidAuthority();
}

function secureJsonResponse(
  value: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(canonicalJsonStringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseCanonicalJsonObject(
  bytes: Uint8Array,
): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      canonicalJsonStringify(value) !== text
    ) {
      throw new Error("canonical object required");
    }
    return value;
  } catch {
    throw invalidAuthority();
  }
}

function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("integer required");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) throw new Error("JSON value required");

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalJsonValue(value[key]);
  }
  return result;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    throw new ProtocolError(code, code.includes("snapshot") ? 409 : 403);
  }
}

function readString(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  pattern: RegExp,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length < min ||
    candidate.length > max ||
    !pattern.test(candidate)
  ) {
    throw invalidAuthority();
  }
  return candidate;
}

function readHex(
  value: Record<string, unknown>,
  key: string,
): string {
  return readString(value, key, 64, 64, LOWER_HEX_64);
}

function readInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const candidate = value[key];
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < min ||
    (candidate as number) > max
  ) {
    throw invalidAuthority();
  }
  return candidate as number;
}

function readLiteral<T extends string>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) throw invalidAuthority();
  return expected;
}

function readSnapshotInteger(
  value: Record<string, unknown>,
  key: string,
  min = 1,
): number {
  const candidate = value[key];
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < min
  ) {
    throw invalidSnapshot();
  }
  return candidate as number;
}

function readSnapshotString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw invalidSnapshot();
  return candidate;
}

function readSnapshotBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw invalidSnapshot();
  return candidate;
}

function safeCountSum(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) throw invalidSnapshot();
  }
  return result;
}

function expectedInstanceName(shardIndex: number): string {
  return `cinatoken-relay-shard-v1-${shardIndex
    .toString()
    .padStart(4, "0")}`;
}

function invalidAuthority(): ProtocolError {
  return new ProtocolError(
    "invalid_controller_drain_attestation_authority",
    403,
  );
}

function invalidSnapshot(): ProtocolError {
  return new ProtocolError(
    "controller_drain_attestation_snapshot_invalid",
    409,
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      copyArrayBuffer(value),
    ),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64Url(
  value: string,
  maxBytes: number,
): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidAuthority();
  }
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
    if (
      decoded.byteLength > maxBytes ||
      encodeBase64Url(decoded) !== value
    ) {
      throw new Error("noncanonical base64url");
    }
    return decoded;
  } catch {
    throw invalidAuthority();
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
