import {
  activationCampaignProbeId,
  type CampaignActionGateInventory,
  type ShardActivationCampaignClaim,
} from "./shard_activation_campaign";
import {
  ProtocolError,
  requireOperationShardContractVersion,
  type OperationShard,
  type ShardActivationCampaignCredential,
} from "./protocol";

export const SHARD_PLACEMENT_READINESS_AUTHORITY_HEADER =
  "x-cinatoken-shard-placement-readiness-authority";
export const SHARD_PLACEMENT_READINESS_PROBE_PATH =
  "/internal/v1/shard-placement/readiness/probe";
export const SHARD_PLACEMENT_READINESS_READBACK_PATH =
  "/internal/v1/shard-placement/readiness/readback";
export const SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT =
  "cinatoken-shard-placement-operation-readiness-v1";
export const SHARD_PLACEMENT_READINESS_RESPONSE_CONTRACT =
  "cinatoken-shard-placement-operation-readiness-result-v1";
export const MAX_SHARD_PLACEMENT_READINESS_BODY_BYTES = 4 * 1024;
export const MAX_SHARD_PLACEMENT_READINESS_RESPONSE_BYTES = 16 * 1024;

const AUTHORITY_DOMAIN =
  "cinatoken-shard-placement-readiness-authority:v1\0";
const MAX_AUTHORITY_TOKEN_BYTES = 4_096;
const MAX_AUTHORITY_JSON_SEGMENT_BYTES = 2_048;
const MAX_AUTHORITY_LIFETIME_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_OPERATION_DEADLINE_MILLISECONDS = 5 * 60 * 1_000;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANCE_NAME = /^[a-z0-9-]+$/;
const encoder = new TextEncoder();

export type ShardPlacementReadinessRole =
  | "readiness_probe"
  | "readiness_readback";
export type ShardPlacementReadinessMode = "wake_once" | "replay_only";

export interface ShardPlacementReadinessEnvironment {
  SHARD_PLACEMENT_READINESS_AUTHORITY_ISSUER: string;
  SHARD_PLACEMENT_READINESS_AUTHORITY_AUDIENCE: string;
  SHARD_PLACEMENT_READINESS_PROBE_CURRENT_KID: string;
  SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_KID: string;
  SHARD_PLACEMENT_READINESS_PROBE_CURRENT_SECRET: string;
  SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_SECRET?: string;
  SHARD_PLACEMENT_READINESS_READBACK_CURRENT_KID: string;
  SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_KID: string;
  SHARD_PLACEMENT_READINESS_READBACK_CURRENT_SECRET: string;
  SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_SECRET?: string;
  CONTAINER_CONTROLLER_SERVICE_NAME: string;
  CONTAINER_EXECUTION_ENABLED: string;
  CF_VERSION_METADATA: { id: string };
}

interface ShardPlacementReadinessAuthorityHeader {
  typ: "CINATOKEN-SHARD-PLACEMENT-READINESS-AUTH";
  alg: "HS256";
  kid: string;
}

export interface ShardPlacementReadinessAuthorityClaims {
  authority_version: 1;
  issuer: string;
  audience: string;
  role: ShardPlacementReadinessRole;
  credential_id_sha256: string;
  request_id_sha256: string;
  method: "POST";
  path_and_query: string;
  body_sha256: string;
  issued_at: number;
  expires_at: number;
}

export interface ShardPlacementReadinessRequest {
  schema_version: 1;
  contract: typeof SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT;
  authorization_id_sha256: string;
  claim_digest_sha256: string;
  execution_plan_sha256: string;
  operation_schedule_sha256: string;
  authority_ledger_identity_sha256: string;
  authority_ledger_head_sha256: string;
  predecessor_receipt_sha256: string;
  operation_ordinal: number;
  operation_id_sha256: string;
  probe_id_sha256: string;
  attempt_generation: 1;
  mode: ShardPlacementReadinessMode;
  shard: OperationShard;
  activation_campaign: ShardActivationCampaignCredential;
  expected_controller_service_name: string;
  expected_controller_version_id: string;
  expected_runtime_build_id: string;
  expected_action_gate_inventory_sha256: string;
  authority_version_id: string;
  deadline_at_ms: number;
}

export interface VerifiedShardPlacementReadinessRequest {
  request: ShardPlacementReadinessRequest;
  claims: ShardPlacementReadinessAuthorityClaims;
  body: Uint8Array;
  role: ShardPlacementReadinessRole;
}

export interface ShardPlacementReadinessJournalEvidence {
  replay: "fresh" | "exact_replay";
  generation: number;
  started_at_ms: number;
  deadline_at_ms: number;
  retention_until_ms: number;
  completed_at_ms: number;
}

export interface ShardPlacementReadinessRpcSuccess {
  ok: true;
  result: unknown;
  result_sha256: string;
  journal: ShardPlacementReadinessJournalEvidence;
}

export async function verifyShardPlacementReadinessRequest(
  request: Request,
  env: ShardPlacementReadinessEnvironment,
  role: ShardPlacementReadinessRole,
  now = Math.floor(Date.now() / 1_000),
): Promise<VerifiedShardPlacementReadinessRequest> {
  const expectedPath =
    role === "readiness_probe"
      ? SHARD_PLACEMENT_READINESS_PROBE_PATH
      : SHARD_PLACEMENT_READINESS_READBACK_PATH;
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== expectedPath ||
    url.search.length !== 0
  ) {
    throw new ProtocolError("route_not_found", 404);
  }
  if (
    request.headers.has("content-encoding") ||
    request.headers.has("content-range") ||
    request.headers.has("location")
  ) {
    throw new ProtocolError("invalid_shard_placement_readiness_transport", 400);
  }
  const body = await readBoundedJsonBody(request);
  const claims = await verifyReadinessAuthority(
    requiredReadinessAuthority(request),
    role,
    expectedPath,
    body,
    env,
    now,
  );
  const parsed = await parseShardPlacementReadinessRequest(body, role, now * 1_000);
  if (claims.request_id_sha256 !== parsed.operation_id_sha256) {
    throw new ProtocolError(
      "shard_placement_readiness_authority_claim_mismatch",
      403,
    );
  }
  return { request: parsed, claims, body, role };
}

export async function parseShardPlacementReadinessRequest(
  body: Uint8Array,
  role: ShardPlacementReadinessRole,
  nowMs = Date.now(),
): Promise<ShardPlacementReadinessRequest> {
  const code = "invalid_shard_placement_readiness_request";
  const value = parseCanonicalJsonObject(body, code);
  assertExactKeys(value, [
    "schema_version",
    "contract",
    "authorization_id_sha256",
    "claim_digest_sha256",
    "execution_plan_sha256",
    "operation_schedule_sha256",
    "authority_ledger_identity_sha256",
    "authority_ledger_head_sha256",
    "predecessor_receipt_sha256",
    "operation_ordinal",
    "operation_id_sha256",
    "probe_id_sha256",
    "attempt_generation",
    "mode",
    "shard",
    "activation_campaign",
    "expected_controller_service_name",
    "expected_controller_version_id",
    "expected_runtime_build_id",
    "expected_action_gate_inventory_sha256",
    "authority_version_id",
    "deadline_at_ms",
  ], code);

  const shardValue = readObject(value, "shard", code);
  assertExactKeys(shardValue, [
    "contract_version",
    "ring_generation",
    "shard_count",
    "shard_index",
    "instance_name",
  ], code);
  const shard: OperationShard = {
    contract_version: requireOperationShardContractVersion(
      readInteger(shardValue, "contract_version", 1, 1, code),
      code,
      400,
    ),
    ring_generation: readInteger(
      shardValue,
      "ring_generation",
      1,
      Number.MAX_SAFE_INTEGER,
      code,
    ),
    shard_count: readInteger(shardValue, "shard_count", 8, 8, code),
    shard_index: readInteger(shardValue, "shard_index", 0, 7, code),
    instance_name: readString(
      shardValue,
      "instance_name",
      29,
      64,
      INSTANCE_NAME,
      code,
    ),
  };
  const operationOrdinal = readInteger(
    value,
    "operation_ordinal",
    6,
    13,
    code,
  );
  if (
    operationOrdinal !== shard.shard_index + 6 ||
    shard.instance_name !==
      `cinatoken-relay-shard-v1-${shard.shard_index.toString().padStart(4, "0")}`
  ) {
    throw new ProtocolError(code, 400);
  }

  const campaignValue = readObject(value, "activation_campaign", code);
  assertExactKeys(campaignValue, [
    "contract_version",
    "campaign_id",
    "nonce",
    "confirm_consume",
  ], code);
  const activationCampaign: ShardActivationCampaignCredential = {
    contract_version: readInteger(
      campaignValue,
      "contract_version",
      1,
      1,
      code,
    ) as 1,
    campaign_id: readString(
      campaignValue,
      "campaign_id",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
    nonce: readString(
      campaignValue,
      "nonce",
      64,
      64,
      LOWER_HEX_64,
      code,
    ),
    confirm_consume: readBoolean(campaignValue, "confirm_consume", code) as true,
  };
  if (!activationCampaign.confirm_consume) {
    throw new ProtocolError(code, 400);
  }

  const mode = readString(
    value,
    "mode",
    9,
    11,
    /^(wake_once|replay_only)$/,
    code,
  ) as ShardPlacementReadinessMode;
  const expectedMode =
    role === "readiness_probe" ? "wake_once" : "replay_only";
  if (mode !== expectedMode) {
    throw new ProtocolError(
      "shard_placement_readiness_role_mismatch",
      403,
    );
  }
  const deadlineAtMs = readInteger(
    value,
    "deadline_at_ms",
    1,
    Number.MAX_SAFE_INTEGER,
    code,
  );
  if (
    deadlineAtMs <= nowMs ||
    deadlineAtMs - nowMs > MAX_OPERATION_DEADLINE_MILLISECONDS
  ) {
    throw new ProtocolError("shard_placement_readiness_deadline_invalid", 409);
  }

  const probeIdSha256 = readHex(value, "probe_id_sha256", code);
  if (
    probeIdSha256 !==
    (await activationCampaignProbeId(
      activationCampaign.campaign_id,
      shard.shard_index,
    ))
  ) {
    throw new ProtocolError(
      "shard_placement_readiness_probe_identity_mismatch",
      409,
    );
  }

  return {
    schema_version: readInteger(value, "schema_version", 1, 1, code) as 1,
    contract: readLiteral(
      value,
      "contract",
      SHARD_PLACEMENT_READINESS_REQUEST_CONTRACT,
      code,
    ),
    authorization_id_sha256: readHex(
      value,
      "authorization_id_sha256",
      code,
    ),
    claim_digest_sha256: readHex(value, "claim_digest_sha256", code),
    execution_plan_sha256: readHex(value, "execution_plan_sha256", code),
    operation_schedule_sha256: readHex(
      value,
      "operation_schedule_sha256",
      code,
    ),
    authority_ledger_identity_sha256: readHex(
      value,
      "authority_ledger_identity_sha256",
      code,
    ),
    authority_ledger_head_sha256: readHex(
      value,
      "authority_ledger_head_sha256",
      code,
    ),
    predecessor_receipt_sha256: readHex(
      value,
      "predecessor_receipt_sha256",
      code,
    ),
    operation_ordinal: operationOrdinal,
    operation_id_sha256: readHex(value, "operation_id_sha256", code),
    probe_id_sha256: probeIdSha256,
    attempt_generation: readInteger(
      value,
      "attempt_generation",
      1,
      1,
      code,
    ) as 1,
    mode,
    shard,
    activation_campaign: activationCampaign,
    expected_controller_service_name: readString(
      value,
      "expected_controller_service_name",
      1,
      128,
      IDENTIFIER,
      code,
    ),
    expected_controller_version_id: readString(
      value,
      "expected_controller_version_id",
      1,
      128,
      IDENTIFIER,
      code,
    ),
    expected_runtime_build_id: readHex(
      value,
      "expected_runtime_build_id",
      code,
    ),
    expected_action_gate_inventory_sha256: readHex(
      value,
      "expected_action_gate_inventory_sha256",
      code,
    ),
    authority_version_id: readString(
      value,
      "authority_version_id",
      1,
      128,
      IDENTIFIER,
      code,
    ),
    deadline_at_ms: deadlineAtMs,
  };
}

export function assertShardPlacementReadinessContext(
  request: ShardPlacementReadinessRequest,
  claim: ShardActivationCampaignClaim,
  actionGates: CampaignActionGateInventory,
  env: Pick<
    ShardPlacementReadinessEnvironment,
    | "CONTAINER_CONTROLLER_SERVICE_NAME"
    | "CONTAINER_EXECUTION_ENABLED"
    | "CF_VERSION_METADATA"
  >,
): void {
  assertShardPlacementReadinessControllerIdentity(request, env);
  if (
    !actionGates.allActionGatesFalse ||
    request.expected_action_gate_inventory_sha256 !==
      actionGates.digestSha256 ||
    request.claim_digest_sha256 !== claim.claimDigestSha256 ||
    request.probe_id_sha256 !== claim.probeId ||
    request.expected_controller_version_id !== claim.controllerVersionId ||
    request.expected_runtime_build_id !== claim.runtimeBuildId ||
    request.expected_action_gate_inventory_sha256 !==
      claim.actionGateInventorySha256 ||
    !operationShardEquals(request.shard, claim.shard)
  ) {
    throw new ProtocolError("shard_placement_readiness_context_mismatch", 409);
  }
}

export function assertShardPlacementReadinessControllerIdentity(
  request: ShardPlacementReadinessRequest,
  env: Pick<
    ShardPlacementReadinessEnvironment,
    | "CONTAINER_CONTROLLER_SERVICE_NAME"
    | "CONTAINER_EXECUTION_ENABLED"
    | "CF_VERSION_METADATA"
  >,
): void {
  if (
    request.expected_controller_service_name !==
      env.CONTAINER_CONTROLLER_SERVICE_NAME ||
    request.expected_controller_version_id !== env.CF_VERSION_METADATA.id ||
    env.CONTAINER_EXECUTION_ENABLED !== "false"
  ) {
    throw new ProtocolError("shard_placement_readiness_controller_drift", 409);
  }
}

export function shardPlacementReadinessResponse(
  verified: VerifiedShardPlacementReadinessRequest,
  claim: ShardActivationCampaignClaim,
  actionGates: CampaignActionGateInventory,
  outcome: ShardPlacementReadinessRpcSuccess,
  env: Pick<
    ShardPlacementReadinessEnvironment,
    | "CONTAINER_CONTROLLER_SERVICE_NAME"
    | "CONTAINER_EXECUTION_ENABLED"
    | "CF_VERSION_METADATA"
  >,
): Response {
  assertShardPlacementReadinessContext(
    verified.request,
    claim,
    actionGates,
    env,
  );
  assertHealthyShardPlacementReadinessResult(
    outcome,
    verified.request,
    claim,
  );
  const body = JSON.stringify({
    schema_version: 1,
    contract: SHARD_PLACEMENT_READINESS_RESPONSE_CONTRACT,
    mode: verified.request.mode,
    replay: outcome.journal.replay,
    authorization_id_sha256:
      verified.request.authorization_id_sha256,
    claim_digest_sha256: verified.request.claim_digest_sha256,
    execution_plan_sha256: verified.request.execution_plan_sha256,
    operation_schedule_sha256:
      verified.request.operation_schedule_sha256,
    authority_ledger_identity_sha256:
      verified.request.authority_ledger_identity_sha256,
    authority_ledger_head_sha256:
      verified.request.authority_ledger_head_sha256,
    predecessor_receipt_sha256:
      verified.request.predecessor_receipt_sha256,
    operation_ordinal: verified.request.operation_ordinal,
    operation_id_sha256: verified.request.operation_id_sha256,
    probe_id_sha256: verified.request.probe_id_sha256,
    attempt_generation: verified.request.attempt_generation,
    shard: verified.request.shard,
    controller: {
      service_name: env.CONTAINER_CONTROLLER_SERVICE_NAME,
      version_id: env.CF_VERSION_METADATA.id,
      action_gate_inventory_sha256: actionGates.digestSha256,
      execution_enabled: false,
    },
    authority: {
      version_id: verified.request.authority_version_id,
    },
    journal: {
      state: "complete",
      replay: outcome.journal.replay,
      wake_performed: outcome.journal.replay === "fresh",
      generation: outcome.journal.generation,
      started_at_ms: outcome.journal.started_at_ms,
      deadline_at_ms: outcome.journal.deadline_at_ms,
      retention_until_ms: outcome.journal.retention_until_ms,
      completed_at_ms: outcome.journal.completed_at_ms,
      result_sha256: outcome.result_sha256,
    },
    readiness: outcome.result,
  });
  if (encoder.encode(body).byteLength > MAX_SHARD_PLACEMENT_READINESS_RESPONSE_BYTES) {
    throw new ProtocolError(
      "shard_placement_readiness_response_too_large",
      502,
    );
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function createShardPlacementReadinessAuthorityTokenForTest(
  secret: string,
  kid: string,
  role: ShardPlacementReadinessRole,
  claims: ShardPlacementReadinessAuthorityClaims,
): Promise<string> {
  const header: ShardPlacementReadinessAuthorityHeader = {
    typ: "CINATOKEN-SHARD-PLACEMENT-READINESS-AUTH",
    alg: "HS256",
    kid,
  };
  const headerPart = encodeBase64Url(
    encoder.encode(JSON.stringify(header)),
  );
  const claimsPart = encodeBase64Url(
    encoder.encode(JSON.stringify(claims)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(
    `${authorityDomain(role)}${headerPart}.${claimsPart}`,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, copyArrayBuffer(signed)),
  );
  return `${headerPart}.${claimsPart}.${encodeBase64Url(signature)}`;
}

export async function shardPlacementReadinessCredentialIdSha256(
  role: ShardPlacementReadinessRole,
  kid: string,
): Promise<string> {
  return sha256Hex(
    encoder.encode(
      `cinatoken:shard-placement-readiness-credential:v1\0${role}\0${kid}`,
    ),
  );
}

async function verifyReadinessAuthority(
  token: string,
  role: ShardPlacementReadinessRole,
  path: string,
  body: Uint8Array,
  env: ShardPlacementReadinessEnvironment,
  now: number,
): Promise<ShardPlacementReadinessAuthorityClaims> {
  validateReadinessKeyring(env, role);
  if (token.length === 0 || token.length > MAX_AUTHORITY_TOKEN_BYTES) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
  const [headerPart, claimsPart, signaturePart] = parts;
  const headerValue = parseJsonObject(
    decodeBase64Url(headerPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
    "invalid_shard_placement_readiness_authority",
    403,
  );
  assertExactKeys(
    headerValue,
    ["typ", "alg", "kid"],
    "invalid_shard_placement_readiness_authority",
    403,
  );
  const kid = readString(
    headerValue,
    "kid",
    1,
    32,
    KEY_ID,
    "invalid_shard_placement_readiness_authority",
    403,
  );
  if (
    headerValue.typ !==
      "CINATOKEN-SHARD-PLACEMENT-READINESS-AUTH" ||
    headerValue.alg !== "HS256"
  ) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
  const signature = decodeBase64Url(signaturePart, 32);
  if (signature.byteLength !== 32) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
  const secret = selectReadinessSecret(env, role, kid);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(
    `${authorityDomain(role)}${headerPart}.${claimsPart}`,
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      copyArrayBuffer(signature),
      copyArrayBuffer(signed),
    ))
  ) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }

  const value = parseJsonObject(
    decodeBase64Url(claimsPart, MAX_AUTHORITY_JSON_SEGMENT_BYTES),
    "invalid_shard_placement_readiness_authority",
    403,
  );
  assertExactKeys(value, [
    "authority_version",
    "issuer",
    "audience",
    "role",
    "credential_id_sha256",
    "request_id_sha256",
    "method",
    "path_and_query",
    "body_sha256",
    "issued_at",
    "expires_at",
  ], "invalid_shard_placement_readiness_authority", 403);
  const claims: ShardPlacementReadinessAuthorityClaims = {
    authority_version: readInteger(
      value,
      "authority_version",
      1,
      1,
      "invalid_shard_placement_readiness_authority",
      403,
    ) as 1,
    issuer: readString(
      value,
      "issuer",
      1,
      128,
      IDENTIFIER,
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    audience: readString(
      value,
      "audience",
      1,
      128,
      IDENTIFIER,
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    role: readString(
      value,
      "role",
      15,
      18,
      /^(readiness_probe|readiness_readback)$/,
      "invalid_shard_placement_readiness_authority",
      403,
    ) as ShardPlacementReadinessRole,
    credential_id_sha256: readHex(
      value,
      "credential_id_sha256",
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    request_id_sha256: readHex(
      value,
      "request_id_sha256",
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    method: readLiteral(
      value,
      "method",
      "POST",
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    path_and_query: readLiteral(
      value,
      "path_and_query",
      path,
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    body_sha256: readHex(
      value,
      "body_sha256",
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    issued_at: readInteger(
      value,
      "issued_at",
      1,
      Number.MAX_SAFE_INTEGER,
      "invalid_shard_placement_readiness_authority",
      403,
    ),
    expires_at: readInteger(
      value,
      "expires_at",
      1,
      Number.MAX_SAFE_INTEGER,
      "invalid_shard_placement_readiness_authority",
      403,
    ),
  };
  const expectedCredentialId = await shardPlacementReadinessCredentialIdSha256(
    role,
    kid,
  );
  if (
    claims.issuer !== env.SHARD_PLACEMENT_READINESS_AUTHORITY_ISSUER ||
    claims.audience !== env.SHARD_PLACEMENT_READINESS_AUTHORITY_AUDIENCE ||
    claims.role !== role ||
    claims.credential_id_sha256 !== expectedCredentialId ||
    claims.body_sha256 !== (await sha256Hex(body))
  ) {
    throw new ProtocolError(
      "shard_placement_readiness_authority_claim_mismatch",
      403,
    );
  }
  if (claims.expires_at <= now) {
    throw new ProtocolError(
      "shard_placement_readiness_authority_expired",
      409,
    );
  }
  if (
    claims.issued_at > now + MAX_CLOCK_SKEW_SECONDS ||
    claims.expires_at <= claims.issued_at ||
    claims.expires_at - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS ||
    now - claims.issued_at > MAX_AUTHORITY_LIFETIME_SECONDS
  ) {
    throw new ProtocolError(
      "shard_placement_readiness_authority_time_window",
      403,
    );
  }
  return claims;
}

function assertHealthyShardPlacementReadinessResult(
  outcome: ShardPlacementReadinessRpcSuccess,
  request: ShardPlacementReadinessRequest,
  claim: ShardActivationCampaignClaim,
): void {
  if (
    !LOWER_HEX_64.test(outcome.result_sha256) ||
    !isRecord(outcome.result) ||
    outcome.result.mode !== "live" ||
    outcome.result.ready !== false ||
    outcome.result.verdict !== "not_ready" ||
    outcome.result.result_code !== "process_ready_execution_disabled" ||
    outcome.result.wake_requested !== true ||
    !operationShardEquals(outcome.result.shard, request.shard) ||
    !isRecord(outcome.result.container_state) ||
    outcome.result.container_state.status !== "healthy" ||
    !isRecord(outcome.result.runtime) ||
    outcome.result.runtime.process_ready !== true ||
    outcome.result.runtime.execution_ready !== false ||
    outcome.result.runtime.execution_enabled !== false ||
    outcome.result.runtime.protocol_version !== claim.runtimeProtocolVersion ||
    outcome.result.runtime.shard_contract_version !==
      claim.runtimeContractVersion ||
    outcome.result.runtime.runtime_build_id !==
      request.expected_runtime_build_id ||
    !isRecord(outcome.result.ledger) ||
    !isRecord(outcome.result.ledger.readiness) ||
    outcome.result.ledger.readiness.phase !== "complete" ||
    outcome.result.ledger.readiness.last_probe_id !==
      request.probe_id_sha256 ||
    outcome.result.ledger.readiness.result_code !==
      "process_ready_execution_disabled" ||
    outcome.result.ledger.readiness.generation !==
      outcome.journal.generation ||
    outcome.result.ledger.readiness.started_at_ms !==
      outcome.journal.started_at_ms ||
    outcome.result.ledger.readiness.deadline_at_ms !==
      outcome.journal.deadline_at_ms ||
    outcome.result.ledger.readiness.completed_at_ms !==
      outcome.journal.completed_at_ms ||
    outcome.journal.started_at_ms >= outcome.journal.deadline_at_ms ||
    outcome.journal.completed_at_ms < outcome.journal.started_at_ms ||
    outcome.journal.completed_at_ms > outcome.journal.deadline_at_ms ||
    outcome.journal.retention_until_ms < outcome.journal.deadline_at_ms
  ) {
    throw new ProtocolError(
      "shard_placement_readiness_health_ineligible",
      409,
    );
  }
}

async function readBoundedJsonBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError("invalid_content_type", 415);
  }
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) ||
      Number(length) > MAX_SHARD_PLACEMENT_READINESS_BODY_BYTES)
  ) {
    throw new ProtocolError(
      "shard_placement_readiness_request_too_large",
      413,
    );
  }
  if (request.body === null) {
    throw new ProtocolError("invalid_shard_placement_readiness_request", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_SHARD_PLACEMENT_READINESS_BODY_BYTES) {
        await reader.cancel("shard_placement_readiness_request_too_large");
        throw new ProtocolError(
          "shard_placement_readiness_request_too_large",
          413,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new ProtocolError("invalid_shard_placement_readiness_request", 400);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requiredReadinessAuthority(request: Request): string {
  const value = request.headers.get(
    SHARD_PLACEMENT_READINESS_AUTHORITY_HEADER,
  );
  if (value === null) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
  return value;
}

function validateReadinessKeyring(
  env: ShardPlacementReadinessEnvironment,
  role: ShardPlacementReadinessRole,
): void {
  const keyring = readinessKeyring(env, role);
  const currentValid =
    KEY_ID.test(keyring.currentKid) &&
    encoder.encode(keyring.currentSecret).byteLength >= 32;
  const previousKidConfigured = keyring.previousKid.length > 0;
  const previousSecretConfigured =
    keyring.previousSecret !== undefined &&
    keyring.previousSecret.length > 0;
  const previousValid =
    previousKidConfigured === previousSecretConfigured &&
    (!previousKidConfigured ||
      (KEY_ID.test(keyring.previousKid) &&
        keyring.previousKid !== keyring.currentKid &&
        encoder.encode(keyring.previousSecret ?? "").byteLength >= 32));
  if (!currentValid || !previousValid) {
    throw new ProtocolError(
      "shard_placement_readiness_authority_unavailable",
      503,
    );
  }
}

function selectReadinessSecret(
  env: ShardPlacementReadinessEnvironment,
  role: ShardPlacementReadinessRole,
  kid: string,
): string {
  const keyring = readinessKeyring(env, role);
  if (kid === keyring.currentKid) return keyring.currentSecret;
  if (
    keyring.previousKid.length > 0 &&
    kid === keyring.previousKid &&
    keyring.previousSecret !== undefined
  ) {
    return keyring.previousSecret;
  }
  throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
}

function readinessKeyring(
  env: ShardPlacementReadinessEnvironment,
  role: ShardPlacementReadinessRole,
): {
  currentKid: string;
  previousKid: string;
  currentSecret: string;
  previousSecret?: string;
} {
  return role === "readiness_probe"
    ? {
        currentKid: env.SHARD_PLACEMENT_READINESS_PROBE_CURRENT_KID,
        previousKid: env.SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_KID,
        currentSecret: env.SHARD_PLACEMENT_READINESS_PROBE_CURRENT_SECRET,
        previousSecret:
          env.SHARD_PLACEMENT_READINESS_PROBE_PREVIOUS_SECRET,
      }
    : {
        currentKid: env.SHARD_PLACEMENT_READINESS_READBACK_CURRENT_KID,
        previousKid: env.SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_KID,
        currentSecret: env.SHARD_PLACEMENT_READINESS_READBACK_CURRENT_SECRET,
        previousSecret:
          env.SHARD_PLACEMENT_READINESS_READBACK_PREVIOUS_SECRET,
      };
}

function authorityDomain(role: ShardPlacementReadinessRole): string {
  return `${AUTHORITY_DOMAIN}${role}\0`;
}

function operationShardEquals(left: unknown, right: OperationShard): boolean {
  return (
    isRecord(left) &&
    left.contract_version === right.contract_version &&
    left.ring_generation === right.ring_generation &&
    left.shard_count === right.shard_count &&
    left.shard_index === right.shard_index &&
    left.instance_name === right.instance_name
  );
}

function parseJsonObject(
  bytes: Uint8Array,
  code: string,
  status = 400,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes),
    );
    if (!isRecord(value)) throw new Error("object required");
    return value;
  } catch {
    throw new ProtocolError(code, status);
  }
}

function parseCanonicalJsonObject(
  bytes: Uint8Array,
  code: string,
): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value)
      || JSON.stringify(canonicalJsonValue(value)) !== text
    ) {
      throw new Error("canonical object required");
    }
    return value;
  } catch {
    throw new ProtocolError(code, 400);
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("integer required");
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
  status = 400,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new ProtocolError(code, status);
  }
}

function readObject(
  value: Record<string, unknown>,
  key: string,
  code: string,
): Record<string, unknown> {
  const candidate = value[key];
  if (!isRecord(candidate)) throw new ProtocolError(code, 400);
  return candidate;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  pattern: RegExp,
  code: string,
  status = 400,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length < min ||
    candidate.length > max ||
    !pattern.test(candidate)
  ) {
    throw new ProtocolError(code, status);
  }
  return candidate;
}

function readHex(
  value: Record<string, unknown>,
  key: string,
  code: string,
  status = 400,
): string {
  return readString(value, key, 64, 64, LOWER_HEX_64, code, status);
}

function readInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  code: string,
  status = 400,
): number {
  const candidate = value[key];
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < min ||
    (candidate as number) > max
  ) {
    throw new ProtocolError(code, status);
  }
  return candidate as number;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
  code: string,
): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw new ProtocolError(code, 400);
  return candidate;
}

function readLiteral<T extends string>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
  code: string,
  status = 400,
): T {
  if (value[key] !== expected) throw new ProtocolError(code, status);
  return expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copyArrayBuffer(bytes),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
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
    if (decoded.byteLength > maxBytes) throw new Error("segment too large");
    return decoded;
  } catch {
    throw new ProtocolError("invalid_shard_placement_readiness_authority", 403);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
