import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
} from "./protocol";

export const CONTAINER_CONTROLLER_READINESS_REQUEST_CONTRACT =
  "cinatoken-shard-placement-operation-readiness-v1";
export const CONTAINER_CONTROLLER_READINESS_RESULT_CONTRACT =
  "cinatoken-shard-placement-operation-readiness-result-v1";
export const CONTAINER_CONTROLLER_READINESS_PROBE_PATH =
  "/internal/v1/shard-placement/readiness/probe";
export const CONTAINER_CONTROLLER_READINESS_READBACK_PATH =
  "/internal/v1/shard-placement/readiness/readback";

const INTERNAL_ORIGIN = "https://container-controller.internal";
const AUTHORITY_HEADER =
  "x-cinatoken-shard-placement-readiness-authority";
const AUTHORITY_DOMAIN =
  "cinatoken-shard-placement-readiness-authority:v1\0";
const AUTHORITY_TYPE =
  "CINATOKEN-SHARD-PLACEMENT-READINESS-AUTH";
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const AUTHORITY_LIFETIME_SECONDS = 60;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();

export type ContainerControllerReadinessRole =
  | "readiness_probe"
  | "readiness_readback";
export type ContainerControllerReadinessMode =
  | "wake_once"
  | "replay_only";
export type ReadinessCredentialGeneration = "current" | "previous";

export interface ContainerControllerReadinessServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerControllerReadinessClientEnv {
  CONTAINER_CONTROLLER: ContainerControllerReadinessServiceBinding;
  CONTAINER_CONTROLLER_READINESS_ISSUER: string;
  CONTAINER_CONTROLLER_READINESS_AUDIENCE: string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_KID: string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_SECRET?: string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_KID: string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_SECRET?: string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_KID: string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
    string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_SECRET?: string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_KID: string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
    string;
  CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_SECRET?: string;
}

export interface ContainerControllerReadinessInput {
  authorizationIdSha256: string;
  claimDigestSha256: string;
  executionPlanSha256: string;
  operationScheduleSha256: string;
  authorityLedgerIdentitySha256: string;
  authorityLedgerHeadSha256: string;
  predecessorReceiptSha256: string;
  operationOrdinal: number;
  operationIdSha256: string;
  probeIdSha256: string;
  shard: {
    contractVersion: 1;
    ringGeneration: number;
    shardCount: 8;
    shardIndex: number;
    instanceName: string;
  };
  campaignId: string;
  campaignNonce: string;
  expectedControllerServiceName: string;
  expectedControllerVersionId: string;
  expectedRuntimeBuildId: string;
  expectedActionGateInventorySha256: string;
  authorityVersionId: string;
  deadlineAtMs: number;
}

export interface ContainerControllerReadinessCallOptions {
  credentialGeneration?: ReadinessCredentialGeneration;
  now?: number;
}

export interface ContainerControllerReadinessEvidence {
  mode: ContainerControllerReadinessMode;
  replay: "fresh" | "exact_replay";
  controllerServiceName: string;
  controllerVersionId: string;
  actionGateInventorySha256: string;
  controllerExecutionEnabled: false;
  runtimeBuildId: string;
  processReady: true;
  executionReady: false;
  runtimeExecutionEnabled: false;
  containerState: "healthy";
  resultCode: "process_ready_execution_disabled";
  readinessResultSha256: string;
  journalGeneration: 1;
  journalStartedAtMs: number;
  journalDeadlineAtMs: number;
  journalCompletedAtMs: number;
  journalRetentionUntilMs: number;
  wakePerformed: boolean;
}

interface ResponseMetadata {
  httpStatus: number;
  responseBodySha256: string;
  responseBytes: number;
  readinessCredentialIdSha256: string;
  readinessRequestIdSha256: string;
}

export interface ContainerControllerReadinessEligibleResult
  extends ResponseMetadata {
  classification: "process_ready_execution_disabled";
  recoveryAction: "continue";
  evidence: ContainerControllerReadinessEvidence;
}

export interface ContainerControllerReadinessUnhealthyResult
  extends ResponseMetadata {
  classification: "explicitly_unhealthy";
  recoveryAction: "disable_required";
  reasonCode: string;
}

export interface ContainerControllerReadinessUnknownResult {
  classification: "outcome_unknown";
  recoveryAction: "readback_only" | "manual_intervention";
  code: string;
  mode: ContainerControllerReadinessMode;
  httpStatus: number | null;
  responseBodySha256: string | null;
  responseBytes: number | null;
}

export type ContainerControllerReadinessCallResult =
  | ContainerControllerReadinessEligibleResult
  | ContainerControllerReadinessUnhealthyResult
  | ContainerControllerReadinessUnknownResult;

interface Credential {
  role: ContainerControllerReadinessRole;
  generation: ReadinessCredentialGeneration;
  kid: string;
  credentialIdSha256: string;
  secret: string;
}

interface WireRequest {
  schema_version: 1;
  contract: typeof CONTAINER_CONTROLLER_READINESS_REQUEST_CONTRACT;
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
  mode: ContainerControllerReadinessMode;
  shard: {
    contract_version: 1;
    ring_generation: number;
    shard_count: 8;
    shard_index: number;
    instance_name: string;
  };
  activation_campaign: {
    contract_version: 1;
    campaign_id: string;
    nonce: string;
    confirm_consume: true;
  };
  expected_controller_service_name: string;
  expected_controller_version_id: string;
  expected_runtime_build_id: string;
  expected_action_gate_inventory_sha256: string;
  authority_version_id: string;
  deadline_at_ms: number;
}

export function validateContainerControllerReadinessClientConfig(
  env: ContainerControllerReadinessClientEnv,
): void {
  const credentials = [
    credentialFromEnv(env, "readiness_probe", "current"),
    credentialFromEnv(env, "readiness_probe", "previous"),
    credentialFromEnv(env, "readiness_readback", "current"),
    credentialFromEnv(env, "readiness_readback", "previous"),
  ];
  const current = credentials.filter(
    (credential) => credential.generation === "current",
  );
  const configured = credentials.filter(configuredCredential);
  if (
    typeof env.CONTAINER_CONTROLLER?.fetch !== "function"
    || !IDENTITY.test(env.CONTAINER_CONTROLLER_READINESS_ISSUER)
    || !IDENTITY.test(env.CONTAINER_CONTROLLER_READINESS_AUDIENCE)
    || env.CONTAINER_CONTROLLER_READINESS_ISSUER
      === env.CONTAINER_CONTROLLER_READINESS_AUDIENCE
    || current.some((credential) => !validCredential(credential))
    || credentials.some(
      (credential) =>
        credential.generation === "previous"
        && !emptyCredential(credential)
        && !validCredential(credential),
    )
    || new Set(configured.map((credential) => credential.kid)).size
      !== configured.length
    || new Set(
      configured.map((credential) => credential.credentialIdSha256),
    ).size !== configured.length
    || new Set(configured.map((credential) => credential.secret)).size
      !== configured.length
  ) {
    throw new ProtocolError(
      "container_controller_readiness_client_unavailable",
      503,
    );
  }
}

export async function probeContainerControllerReadinessOnce(
  env: ContainerControllerReadinessClientEnv,
  input: ContainerControllerReadinessInput,
  options: ContainerControllerReadinessCallOptions = {},
): Promise<ContainerControllerReadinessCallResult> {
  return callOnce(
    env,
    input,
    options,
    "readiness_probe",
    "wake_once",
    CONTAINER_CONTROLLER_READINESS_PROBE_PATH,
  );
}

export async function readbackContainerControllerReadinessOnce(
  env: ContainerControllerReadinessClientEnv,
  input: ContainerControllerReadinessInput,
  options: ContainerControllerReadinessCallOptions = {},
): Promise<ContainerControllerReadinessCallResult> {
  return callOnce(
    env,
    input,
    options,
    "readiness_readback",
    "replay_only",
    CONTAINER_CONTROLLER_READINESS_READBACK_PATH,
  );
}

export async function readinessCredentialIdSha256(
  role: ContainerControllerReadinessRole,
  kid: string,
): Promise<string> {
  return sha256Hex(encoder.encode(
    `cinatoken:shard-placement-readiness-credential:v1\0${role}\0${kid}`,
  ));
}

async function callOnce(
  env: ContainerControllerReadinessClientEnv,
  input: ContainerControllerReadinessInput,
  options: ContainerControllerReadinessCallOptions,
  role: ContainerControllerReadinessRole,
  mode: ContainerControllerReadinessMode,
  path: string,
): Promise<ContainerControllerReadinessCallResult> {
  validateContainerControllerReadinessClientConfig(env);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  requireInput(input, now);
  const credential = credentialFromEnv(
    env,
    role,
    options.credentialGeneration ?? "current",
  );
  if (!validCredential(credential)) {
    throw new ProtocolError(
      "container_controller_readiness_client_unavailable",
      503,
    );
  }
  if (
    credential.credentialIdSha256
      !== await readinessCredentialIdSha256(role, credential.kid)
  ) {
    throw new ProtocolError(
      "container_controller_readiness_credential_identity_mismatch",
      503,
    );
  }
  const payload = wireRequest(input, mode);
  const body = encoder.encode(canonicalJson(payload));
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new ProtocolError(
      "container_controller_readiness_request_too_large",
      413,
    );
  }
  const request = await signedRequest(
    env,
    credential,
    path,
    body,
    input.operationIdSha256,
    now,
  );
  return fetchOnce(
    env.CONTAINER_CONTROLLER,
    request,
    payload,
    input,
    credential,
  );
}

function wireRequest(
  input: ContainerControllerReadinessInput,
  mode: ContainerControllerReadinessMode,
): WireRequest {
  return {
    schema_version: 1,
    contract: CONTAINER_CONTROLLER_READINESS_REQUEST_CONTRACT,
    authorization_id_sha256: input.authorizationIdSha256,
    claim_digest_sha256: input.claimDigestSha256,
    execution_plan_sha256: input.executionPlanSha256,
    operation_schedule_sha256: input.operationScheduleSha256,
    authority_ledger_identity_sha256:
      input.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256: input.authorityLedgerHeadSha256,
    predecessor_receipt_sha256: input.predecessorReceiptSha256,
    operation_ordinal: input.operationOrdinal,
    operation_id_sha256: input.operationIdSha256,
    probe_id_sha256: input.probeIdSha256,
    attempt_generation: 1,
    mode,
    shard: {
      contract_version: 1,
      ring_generation: input.shard.ringGeneration,
      shard_count: 8,
      shard_index: input.shard.shardIndex,
      instance_name: input.shard.instanceName,
    },
    activation_campaign: {
      contract_version: 1,
      campaign_id: input.campaignId,
      nonce: input.campaignNonce,
      confirm_consume: true,
    },
    expected_controller_service_name:
      input.expectedControllerServiceName,
    expected_controller_version_id:
      input.expectedControllerVersionId,
    expected_runtime_build_id: input.expectedRuntimeBuildId,
    expected_action_gate_inventory_sha256:
      input.expectedActionGateInventorySha256,
    authority_version_id: input.authorityVersionId,
    deadline_at_ms: input.deadlineAtMs,
  };
}

function requireInput(
  input: ContainerControllerReadinessInput,
  now: number,
): void {
  const digests = [
    input.authorizationIdSha256,
    input.claimDigestSha256,
    input.executionPlanSha256,
    input.operationScheduleSha256,
    input.authorityLedgerIdentitySha256,
    input.authorityLedgerHeadSha256,
    input.predecessorReceiptSha256,
    input.operationIdSha256,
    input.probeIdSha256,
    input.campaignId,
    input.campaignNonce,
    input.expectedRuntimeBuildId,
    input.expectedActionGateInventorySha256,
  ];
  const expectedShardIndex = input.operationOrdinal - 6;
  if (
    !Number.isSafeInteger(now)
    || now <= 0
    || digests.some((value) => !SHA256.test(value))
    || !Number.isSafeInteger(input.operationOrdinal)
    || input.operationOrdinal < 6
    || input.operationOrdinal > 13
    || input.shard.contractVersion !== 1
    || !Number.isSafeInteger(input.shard.ringGeneration)
    || input.shard.ringGeneration < 1
    || input.shard.shardCount !== 8
    || input.shard.shardIndex !== expectedShardIndex
    || input.shard.instanceName !==
      `cinatoken-relay-shard-v1-${expectedShardIndex
        .toString().padStart(4, "0")}`
    || !IDENTITY.test(input.expectedControllerServiceName)
    || !IDENTITY.test(input.expectedControllerVersionId)
    || !IDENTITY.test(input.authorityVersionId)
    || !Number.isSafeInteger(input.deadlineAtMs)
    || input.deadlineAtMs <= now * 1_000
    || input.deadlineAtMs > (now + 60) * 1_000
  ) {
    throw new ProtocolError(
      "container_controller_readiness_request_invalid",
      400,
    );
  }
}

async function signedRequest(
  env: ContainerControllerReadinessClientEnv,
  credential: Credential,
  path: string,
  body: Uint8Array,
  requestIdSha256: string,
  now: number,
): Promise<Request> {
  const headerPart = base64Url(encoder.encode(canonicalJson({
    typ: AUTHORITY_TYPE,
    alg: "HS256",
    kid: credential.kid,
  })));
  const claimsPart = base64Url(encoder.encode(canonicalJson({
    authority_version: 1,
    issuer: env.CONTAINER_CONTROLLER_READINESS_ISSUER,
    audience: env.CONTAINER_CONTROLLER_READINESS_AUDIENCE,
    role: credential.role,
    credential_id_sha256: credential.credentialIdSha256,
    request_id_sha256: requestIdSha256,
    method: "POST",
    path_and_query: path,
    body_sha256: await sha256Hex(body),
    issued_at: now,
    expires_at: now + AUTHORITY_LIFETIME_SECONDS,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      `${AUTHORITY_DOMAIN}${credential.role}\0`
      + `${headerPart}.${claimsPart}`,
    ),
  ));
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json",
      [AUTHORITY_HEADER]:
        `${headerPart}.${claimsPart}.${base64Url(signature)}`,
    },
    body,
  });
}

async function fetchOnce(
  binding: ContainerControllerReadinessServiceBinding,
  request: Request,
  wire: WireRequest,
  input: ContainerControllerReadinessInput,
  credential: Credential,
): Promise<ContainerControllerReadinessCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("container_controller_readiness_timeout"),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await binding.fetch(
      new Request(request, { signal: controller.signal }),
    );
    if (invalidResponseMetadata(response)) {
      await response.body?.cancel(
        "container_controller_readiness_invalid_response",
      );
      return unknown(
        wire.mode,
        "container_controller_readiness_invalid_response",
        response.status,
      );
    }
    const bytes = await readBounded(response);
    const responseBodySha256 = await sha256Hex(bytes);
    const metadata: ResponseMetadata = {
      httpStatus: response.status,
      responseBodySha256,
      responseBytes: bytes.byteLength,
      readinessCredentialIdSha256: credential.credentialIdSha256,
      readinessRequestIdSha256: input.operationIdSha256,
    };
    if (response.status !== 200) {
      const code = parseError(bytes);
      if (code === null || outcomeUncertainCode(code)) {
        return {
          ...unknown(
            wire.mode,
            code ?? "container_controller_readiness_invalid_error",
            response.status,
          ),
          responseBodySha256,
          responseBytes: bytes.byteLength,
        };
      }
      return {
        classification: "explicitly_unhealthy",
        recoveryAction: "disable_required",
        reasonCode: code,
        ...metadata,
      };
    }
    const parsed = parseSuccess(bytes, wire, input);
    if (parsed === null) {
      return {
        ...unknown(
          wire.mode,
          "container_controller_readiness_invalid_response",
          response.status,
        ),
        responseBodySha256,
        responseBytes: bytes.byteLength,
      };
    }
    return {
      classification: "process_ready_execution_disabled",
      recoveryAction: "continue",
      evidence: parsed,
      ...metadata,
    };
  } catch (error) {
    return unknown(
      wire.mode,
      error instanceof ResponseTooLargeError
        ? "container_controller_readiness_response_too_large"
        : controller.signal.aborted
        ? "container_controller_readiness_timeout"
        : "container_controller_readiness_outcome_unknown",
      error instanceof ResponseTooLargeError
        ? error.status
        : controller.signal.aborted
        ? 504
        : null,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseSuccess(
  bytes: Uint8Array,
  request: WireRequest,
  input: ContainerControllerReadinessInput,
): ContainerControllerReadinessEvidence | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)) as unknown;
    if (
      !record(value)
      || !exactKeys(value, [
        "schema_version",
        "contract",
        "mode",
        "replay",
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
        "shard",
        "controller",
        "authority",
        "journal",
        "readiness",
      ])
      || value.schema_version !== 1
      || value.contract !== CONTAINER_CONTROLLER_READINESS_RESULT_CONTRACT
      || value.mode !== request.mode
      || (value.replay !== "fresh" && value.replay !== "exact_replay")
      || value.authorization_id_sha256 !== request.authorization_id_sha256
      || value.claim_digest_sha256 !== request.claim_digest_sha256
      || value.execution_plan_sha256 !== request.execution_plan_sha256
      || value.operation_schedule_sha256
        !== request.operation_schedule_sha256
      || value.authority_ledger_identity_sha256
        !== request.authority_ledger_identity_sha256
      || value.authority_ledger_head_sha256
        !== request.authority_ledger_head_sha256
      || value.predecessor_receipt_sha256
        !== request.predecessor_receipt_sha256
      || value.operation_ordinal !== request.operation_ordinal
      || value.operation_id_sha256 !== request.operation_id_sha256
      || value.probe_id_sha256 !== request.probe_id_sha256
      || value.attempt_generation !== 1
      || !sameShard(value.shard, request.shard)
      || !record(value.controller)
      || value.controller.service_name
        !== input.expectedControllerServiceName
      || value.controller.version_id !== input.expectedControllerVersionId
      || value.controller.action_gate_inventory_sha256
        !== input.expectedActionGateInventorySha256
      || value.controller.execution_enabled !== false
      || !record(value.authority)
      || value.authority.version_id !== input.authorityVersionId
      || !record(value.journal)
      || value.journal.state !== "complete"
      || value.journal.replay !== value.replay
      || value.journal.generation !== 1
      || !SHA256.test(stringValue(value.journal.result_sha256))
      || !positiveInteger(value.journal.started_at_ms)
      || !positiveInteger(value.journal.deadline_at_ms)
      || !positiveInteger(value.journal.completed_at_ms)
      || !positiveInteger(value.journal.retention_until_ms)
      || value.journal.wake_performed !== (value.replay === "fresh")
      || !record(value.readiness)
      || value.readiness.mode !== "live"
      || value.readiness.ready !== false
      || value.readiness.verdict !== "not_ready"
      || value.readiness.result_code
        !== "process_ready_execution_disabled"
      || !record(value.readiness.container_state)
      || value.readiness.container_state.status !== "healthy"
      || !record(value.readiness.runtime)
      || value.readiness.runtime.process_ready !== true
      || value.readiness.runtime.execution_ready !== false
      || value.readiness.runtime.execution_enabled !== false
      || value.readiness.runtime.runtime_build_id
        !== input.expectedRuntimeBuildId
    ) {
      return null;
    }
    const replay: "fresh" | "exact_replay" =
      value.replay === "fresh" ? "fresh" : "exact_replay";
    return {
      mode: request.mode,
      replay,
      controllerServiceName: input.expectedControllerServiceName,
      controllerVersionId: input.expectedControllerVersionId,
      actionGateInventorySha256:
        input.expectedActionGateInventorySha256,
      controllerExecutionEnabled: false,
      runtimeBuildId: input.expectedRuntimeBuildId,
      processReady: true,
      executionReady: false,
      runtimeExecutionEnabled: false,
      containerState: "healthy",
      resultCode: "process_ready_execution_disabled",
      readinessResultSha256: stringValue(
        value.journal.result_sha256,
      ),
      journalGeneration: 1,
      journalStartedAtMs: value.journal.started_at_ms,
      journalDeadlineAtMs: value.journal.deadline_at_ms,
      journalCompletedAtMs: value.journal.completed_at_ms,
      journalRetentionUntilMs: value.journal.retention_until_ms,
      wakePerformed: value.journal.wake_performed,
    };
  } catch {
    return null;
  }
}

function parseError(bytes: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)) as unknown;
    return record(value)
      && exactKeys(value, ["error"])
      && typeof value.error === "string"
      && /^[a-z0-9_]{1,128}$/.test(value.error)
      ? value.error
      : null;
  } catch {
    return null;
  }
}

function outcomeUncertainCode(code: string): boolean {
  return (
    code === "readiness_probe_journal_unavailable"
    || code.startsWith("readiness_probe_")
  );
}

function invalidResponseMetadata(response: Response): boolean {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const contentLength = response.headers.get("content-length");
  return (
    response.redirected
    || response.headers.has("content-encoding")
    || response.headers.has("location")
    || contentType !== "application/json"
    || !hasNoStore(response.headers.get("cache-control"))
    || (
      contentLength !== null
      && (
        !/^\d+$/.test(contentLength)
        || Number(contentLength) > MAX_RESPONSE_BYTES
      )
    )
  );
}

class ResponseTooLargeError extends Error {
  constructor(readonly status: number) {
    super("container_controller_readiness_response_too_large");
  }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error("missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel(
          "container_controller_readiness_response_too_large",
        );
        throw new ResponseTooLargeError(response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("missing_response_body");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function credentialFromEnv(
  env: ContainerControllerReadinessClientEnv,
  role: ContainerControllerReadinessRole,
  generation: ReadinessCredentialGeneration,
): Credential {
  if (role === "readiness_probe") {
    return generation === "current"
      ? {
        role,
        generation,
        kid: env.CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_KID,
        credentialIdSha256:
          env
            .CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_CURRENT_SECRET
          ?? "",
      }
      : {
        role,
        generation,
        kid: env.CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_KID,
        credentialIdSha256:
          env
            .CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
        secret:
          env.CONTAINER_CONTROLLER_READINESS_PROBE_HMAC_PREVIOUS_SECRET
          ?? "",
      };
  }
  return {
    role,
    generation,
    kid: generation === "current"
      ? env.CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_KID
      : env.CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_KID,
    credentialIdSha256: generation === "current"
      ? env
        .CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_CREDENTIAL_ID_SHA256
      : env
        .CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256,
    secret: (
      generation === "current"
        ? env.CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_CURRENT_SECRET
        : env.CONTAINER_CONTROLLER_READINESS_READBACK_HMAC_PREVIOUS_SECRET
    ) ?? "",
  };
}

function validCredential(credential: Credential): boolean {
  return (
    KEY_ID.test(credential.kid)
    && SHA256.test(credential.credentialIdSha256)
    && encoder.encode(credential.secret).byteLength >= 32
    && encoder.encode(credential.secret).byteLength <= 256
  );
}

function configuredCredential(credential: Credential): boolean {
  return !emptyCredential(credential);
}

function emptyCredential(credential: Credential): boolean {
  return (
    credential.kid.length === 0
    && credential.credentialIdSha256.length === 0
    && credential.secret.length === 0
  );
}

function unknown(
  mode: ContainerControllerReadinessMode,
  code: string,
  httpStatus: number | null,
): ContainerControllerReadinessUnknownResult {
  return {
    classification: "outcome_unknown",
    recoveryAction:
      mode === "wake_once" ? "readback_only" : "manual_intervention",
    code,
    mode,
    httpStatus,
    responseBodySha256: null,
    responseBytes: null,
  };
}

function sameShard(
  value: unknown,
  expected: WireRequest["shard"],
): boolean {
  return (
    record(value)
    && exactKeys(value, [
      "contract_version",
      "ring_generation",
      "shard_count",
      "shard_index",
      "instance_name",
    ])
    && value.contract_version === expected.contract_version
    && value.ring_generation === expected.ring_generation
    && value.shard_count === expected.shard_count
    && value.shard_index === expected.shard_index
    && value.instance_name === expected.instance_name
  );
}

function hasNoStore(value: string | null): boolean {
  return value !== null
    && value.split(",").some(
      (part) => part.trim().toLowerCase() === "no-store",
    );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
