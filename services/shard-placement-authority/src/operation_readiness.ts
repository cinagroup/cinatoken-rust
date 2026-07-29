import {
  probeContainerControllerReadinessOnce,
  readbackContainerControllerReadinessOnce,
  type ContainerControllerReadinessCallResult,
  type ContainerControllerReadinessClientEnv,
  type ContainerControllerReadinessInput,
} from "./container_controller_readiness_client";
import {
  EXECUTION_RECEIPT_CONTRACT,
  requestIdSha256,
  type ExecutionReceipt,
} from "./execution_protocol";
import {
  readExactExecutionClaim,
  readExactOperationFiveTerminal,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type OperationFiveTerminalRow,
} from "./execution_repository";
import {
  OPERATION_READINESS_ATTEMPT_CONTRACT,
  OPERATION_READINESS_TERMINAL_CONTRACT,
  createOperationReadinessAttempt,
  createOperationReadinessTerminal,
  readOperationReadinessDatabaseNow,
  readOperationReadinessEvidence,
  type OperationReadinessAttempt,
  type OperationReadinessAttemptRow,
  type OperationReadinessTerminal,
  type OperationReadinessTerminalRow,
} from "./operation_readiness_repository";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";
import {
  readExactIssuance,
  type IssuanceRow,
} from "./repository";

export const OPERATION_READINESS_COMMAND_CONTRACT =
  "cinatoken-shard-placement-authority-operation-readiness-command-v1";
export const OPERATION_READINESS_RESULT_CONTRACT =
  "cinatoken-shard-placement-authority-operation-readiness-result-v1";

const ACTIVATION_PROBE_ID_DOMAIN =
  "cinatoken:relay-container-shard-activation-probe:v1\0";
const MAX_COMMAND_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "operationOrdinal",
  "operationIdSha256",
  "campaignNonce",
  "operationRequestIdSha256",
] as const;
const encoder = new TextEncoder();

export interface OperationReadinessCommand {
  schemaVersion: 1;
  contract: typeof OPERATION_READINESS_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  operationOrdinal: number;
  operationIdSha256: string;
  campaignNonce: string;
  operationRequestIdSha256: string;
}

export interface OperationReadinessEnv
  extends ContainerControllerReadinessClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_READINESS_ATTEMPT_WRITE_ENABLED: string;
  SHARD_PLACEMENT_AUTHORITY_READINESS_TERMINAL_WRITE_ENABLED: string;
}

export interface OperationReadinessResult {
  contract: typeof OPERATION_READINESS_RESULT_CONTRACT;
  result:
    | "readiness_recorded"
    | "ambiguous_recovered"
    | "disable_required"
    | "probe_outcome_unknown"
    | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  operationOrdinal: number;
  operationIdSha256: string;
  shardIndex: number;
  probeIdSha256: string;
  attemptDigestSha256: string;
  operationStartedReceiptSha256: string;
  operationTerminalReceiptSha256: string | null;
  controllerServiceName: string;
  controllerEnabledVersionId: string;
  runtimeBuildId: string;
  status: string;
  receiptCount: number;
  receiptHeadSha256: string;
  lastCompletedOrdinal: number;
  nextOperationOrdinal: number;
  recoveryAction: "none" | "readback_only" | "operation_14";
  authorityVersionId: string;
}

export interface OperationReadinessDependencies {
  readClaim: typeof readExactExecutionClaim;
  readIssuance: typeof readExactIssuance;
  readOperationFiveTerminal: typeof readExactOperationFiveTerminal;
  readEvidence: typeof readOperationReadinessEvidence;
  readDatabaseNow: typeof readOperationReadinessDatabaseNow;
  createAttempt: typeof createOperationReadinessAttempt;
  createTerminal: typeof createOperationReadinessTerminal;
  probe: typeof probeContainerControllerReadinessOnce;
  readback: typeof readbackContainerControllerReadinessOnce;
}

const DEFAULT_DEPENDENCIES: OperationReadinessDependencies = {
  readClaim: readExactExecutionClaim,
  readIssuance: readExactIssuance,
  readOperationFiveTerminal: readExactOperationFiveTerminal,
  readEvidence: readOperationReadinessEvidence,
  readDatabaseNow: readOperationReadinessDatabaseNow,
  createAttempt: createOperationReadinessAttempt,
  createTerminal: createOperationReadinessTerminal,
  probe: probeContainerControllerReadinessOnce,
  readback: readbackContainerControllerReadinessOnce,
};

export function parseOperationReadinessCommand(
  body: Uint8Array,
): OperationReadinessCommand {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    throw new ProtocolError("operation_readiness_command_too_large", 413);
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) {
      throw new ProtocolError("noncanonical_json", 400);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("invalid_json", 400);
  }
  if (!plainObject(value) || !exactKeys(value, COMMAND_FIELDS)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  const command: OperationReadinessCommand = {
    schemaVersion: literal(value.schemaVersion, 1),
    contract: literal(
      value.contract,
      OPERATION_READINESS_COMMAND_CONTRACT,
    ),
    authorizationIdSha256: digest(value.authorizationIdSha256),
    claimDigestSha256: digest(value.claimDigestSha256),
    claimOwnerSha256: digest(value.claimOwnerSha256),
    operationOrdinal: integer(value.operationOrdinal, 6, 13),
    operationIdSha256: digest(value.operationIdSha256),
    campaignNonce: digest(value.campaignNonce),
    operationRequestIdSha256:
      digest(value.operationRequestIdSha256),
  };
  return command;
}

export async function executeOperationReadiness(
  env: OperationReadinessEnv,
  command: OperationReadinessCommand,
  authentication: AuthenticatedRequest,
  requestedMode: "probe" | "readback",
  dependencies: OperationReadinessDependencies = DEFAULT_DEPENDENCIES,
): Promise<OperationReadinessResult> {
  requireIncomingRole(authentication, requestedMode);
  const actorRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  if (
    requestedMode === "probe"
    && actorRequestIdSha256 !== command.operationRequestIdSha256
  ) {
    throw new ProtocolError(
      "operation_readiness_request_identity_mismatch",
      403,
    );
  }

  const persisted = await dependencies.readEvidence(
    env.DB,
    command.authorizationIdSha256,
    command.operationOrdinal,
  );
  if (persisted.terminal !== null) {
    if (persisted.attempt === null) {
      throw new ProtocolError(
        "operation_readiness_terminal_attempt_missing",
        409,
      );
    }
    requireCommandMatchesAttempt(command, persisted.attempt);
    requireCommandMatchesTerminal(command, persisted.terminal);
    return resultFromTerminal(
      "exact_replay",
      persisted.terminal,
      env.CF_VERSION_METADATA.id,
    );
  }

  let snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const operation = requireOperation(snapshot, command);
  const issuance = await dependencies.readIssuance(
    env.DB,
    command.authorizationIdSha256,
    snapshot.claim.permit_subject_digest_sha256,
    snapshot.claim.campaign_id,
  );
  const operationFiveTerminal =
    await dependencies.readOperationFiveTerminal(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
    );
  if (operationFiveTerminal === null) {
    throw new ProtocolError(
      "operation_readiness_operation_five_terminal_missing",
      409,
    );
  }
  let attempt = persisted.attempt;
  let callMode: "probe" | "readback" = requestedMode;
  if (attempt === null) {
    await requireSource(
      env,
      command,
      snapshot,
      operation,
      issuance,
      operationFiveTerminal,
    );
    if (requestedMode !== "probe") {
      throw new ProtocolError(
        "operation_readiness_attempt_missing",
        409,
      );
    }
    if (
      env.SHARD_PLACEMENT_AUTHORITY_READINESS_ATTEMPT_WRITE_ENABLED
        !== "true"
    ) {
      throw new ProtocolError(
        "authority_operation_readiness_attempt_write_disabled",
        503,
      );
    }
    const built = await buildAttempt(
      env,
      command,
      snapshot,
      operation,
      issuance,
      operationFiveTerminal,
      authentication,
      actorRequestIdSha256,
    );
    const created = await dependencies.createAttempt(
      env.DB,
      built.attempt,
      built.receipt,
    );
    attempt = created.attempt;
    snapshot = await dependencies.readClaim(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
      command.claimOwnerSha256,
    );
    if (created.classification === "exact_replay") {
      callMode = "readback";
    }
  } else {
    requireCommandMatchesAttempt(command, attempt);
    callMode = "readback";
  }

  if (callMode === "readback") {
    await requireExistingAttemptSource(
      env,
      command,
      snapshot,
      operation,
      issuance,
      operationFiveTerminal,
      attempt,
    );
  }
  const callDeadlineAtMs = callMode === "probe"
    ? attempt.probe_deadline_at_ms
    : readbackDeadlineAtMs(snapshot.claim, issuance.database_now);
  const clientInput = controllerInput(
    attempt,
    command.campaignNonce,
    issuance.action_gate_inventory_sha256,
    callDeadlineAtMs,
  );
  const controllerResult = callMode === "probe"
    ? await dependencies.probe(env, clientInput, {
      now: issuance.database_now,
    })
    : await dependencies.readback(env, clientInput, {
      now: issuance.database_now,
    });

  if (
    controllerResult.classification === "outcome_unknown"
    && callMode === "probe"
  ) {
    return {
      contract: OPERATION_READINESS_RESULT_CONTRACT,
      result: "probe_outcome_unknown",
      authorizationIdSha256: attempt.authorization_id_sha256,
      claimDigestSha256: attempt.claim_digest_sha256,
      operationOrdinal: attempt.operation_ordinal,
      operationIdSha256: attempt.operation_id_sha256,
      shardIndex: attempt.shard_index,
      probeIdSha256: attempt.probe_id_sha256,
      attemptDigestSha256: attempt.attempt_digest_sha256,
      operationStartedReceiptSha256:
        attempt.operation_start_receipt_digest_sha256,
      operationTerminalReceiptSha256: null,
      controllerServiceName: attempt.controller_service_name,
      controllerEnabledVersionId:
        attempt.controller_enabled_version_id,
      runtimeBuildId: attempt.runtime_build_id,
      status: snapshot.claim.status,
      receiptCount: snapshot.claim.ledger_version,
      receiptHeadSha256: snapshot.claim.ledger_head_sha256,
      lastCompletedOrdinal: snapshot.claim.last_completed_ordinal,
      nextOperationOrdinal: attempt.operation_ordinal,
      recoveryAction: "readback_only",
      authorityVersionId: env.CF_VERSION_METADATA.id,
    };
  }

  if (
    env.SHARD_PLACEMENT_AUTHORITY_READINESS_TERMINAL_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_operation_readiness_terminal_write_disabled",
      503,
    );
  }
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const databaseNow = await dependencies.readDatabaseNow(env.DB);
  requireInflight(snapshot, attempt, databaseNow);
  const builtTerminal = await buildTerminal(
    env,
    snapshot,
    attempt,
    controllerResult,
    callMode,
    authentication,
    actorRequestIdSha256,
  );
  const createdTerminal = await dependencies.createTerminal(
    env.DB,
    builtTerminal.terminal,
    builtTerminal.receipt,
    command.claimOwnerSha256,
  );
  const result = terminalResult(controllerResult, callMode);
  return resultFromTerminal(
    createdTerminal.classification === "exact_replay"
      ? "exact_replay"
      : result,
    createdTerminal.terminal,
    env.CF_VERSION_METADATA.id,
    createdTerminal.claim,
  );
}

async function buildAttempt(
  env: OperationReadinessEnv,
  command: OperationReadinessCommand,
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  issuance: IssuanceRow,
  operationFiveTerminal: OperationFiveTerminalRow,
  authentication: AuthenticatedRequest,
  actorRequestIdSha256: string,
): Promise<{
  attempt: OperationReadinessAttempt;
  receipt: ExecutionReceipt;
}> {
  const claim = snapshot.claim;
  const shardIndex = command.operationOrdinal - 6;
  const probeIdSha256 = await activationProbeId(
    claim.campaign_id,
    shardIndex,
  );
  const operationRequestSha256 = await sha256Canonical({
    schemaVersion: 1,
    contract: OPERATION_READINESS_COMMAND_CONTRACT,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    operationOrdinal: command.operationOrdinal,
    operationIdSha256: command.operationIdSha256,
    operationRequestIdSha256: command.operationRequestIdSha256,
    campaignId: claim.campaign_id,
    campaignNonceSha256: claim.campaign_nonce_sha256,
    executionPlanSha256: claim.execution_plan_sha256,
    operationScheduleSha256: claim.operation_schedule_sha256,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    controllerServiceName:
      operationFiveTerminal.controller_service_name,
    controllerEnabledVersionId:
      operationFiveTerminal.controller_enabled_version_id,
    runtimeBuildId: issuance.runtime_build_id,
    ringGeneration: issuance.ring_generation,
    shardCount: issuance.shard_count,
    shardIndex,
    probeIdSha256,
  });
  const deadlineSeconds = Math.min(
    issuance.database_now + 45,
    claim.lease_expires_at - 1,
    claim.normal_deadline_at - 1,
    claim.permit_expires_at - 1,
  );
  if (deadlineSeconds <= issuance.database_now) {
    throw new ProtocolError(
      "operation_readiness_deadline_unavailable",
      409,
    );
  }
  const attemptBase = {
    schemaVersion: 1,
    contract: OPERATION_READINESS_ATTEMPT_CONTRACT,
    authorizationIdSha256: claim.authorization_id_sha256,
    operationOrdinal: command.operationOrdinal,
    shardIndex,
    claimDigestSha256: claim.claim_digest_sha256,
    claimOwnerSha256: claim.claim_owner_sha256,
    leaseOwnerSha256: claim.lease_owner_sha256,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseGeneration: 1 as const,
    executionPlanSha256: claim.execution_plan_sha256,
    operationScheduleSha256: claim.operation_schedule_sha256,
    authorityDatabaseIdentitySha256:
      claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256: claim.ledger_identity_sha256,
    ledgerHeadBeforeSha256: claim.ledger_head_sha256,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    operationFiveTerminalReceiptSha256:
      operationFiveTerminal.generic_terminal_receipt_digest_sha256,
    operationIdSha256: operation.operation_id_sha256,
    operationRequestSha256,
    campaignId: claim.campaign_id,
    campaignNonceSha256: claim.campaign_nonce_sha256,
    ringGeneration: issuance.ring_generation,
    shardCount: 8 as const,
    instanceName:
      `cinatoken-relay-shard-v1-${shardIndex
        .toString().padStart(4, "0")}`,
    controllerServiceName:
      operationFiveTerminal.controller_service_name,
    controllerEnabledVersionId:
      operationFiveTerminal.controller_enabled_version_id,
    runtimeBuildId: issuance.runtime_build_id,
    probeIdSha256,
    probeDeadlineAtMs: deadlineSeconds * 1_000,
    authorityVersionId: env.CF_VERSION_METADATA.id,
    sendCredentialIdSha256: authentication.credentialIdSha256,
    sendRequestIdSha256: actorRequestIdSha256,
  };
  const attemptDigestSha256 = await sha256Canonical(attemptBase);
  const unsignedReceipt: Omit<
    ExecutionReceipt,
    "receiptDigestSha256"
  > = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_started",
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    executionPlanSha256: claim.execution_plan_sha256,
    ledgerIdentitySha256: claim.ledger_identity_sha256,
    sequence: claim.ledger_version + 1,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    leaseGeneration: claim.lease_generation,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: claim.lease_owner_sha256,
    actorCredentialIdSha256: authentication.credentialIdSha256,
    requestIdSha256: actorRequestIdSha256,
    operationOrdinal: command.operationOrdinal,
    operationIdSha256: operation.operation_id_sha256,
    operationKind: "probe_shard_readiness",
    shardIndex,
    outcome: "pending",
    requestSha256: operationRequestSha256,
    responseSha256: null,
    evidenceSha256: attemptDigestSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
  };
  const receipt: ExecutionReceipt = {
    ...unsignedReceipt,
    receiptDigestSha256: await sha256Canonical(unsignedReceipt),
  };
  return {
    attempt: {
      ...attemptBase,
      attemptContract: OPERATION_READINESS_ATTEMPT_CONTRACT,
      attemptDigestSha256,
      operationStartReceiptDigestSha256:
        receipt.receiptDigestSha256,
    },
    receipt,
  };
}

async function buildTerminal(
  env: OperationReadinessEnv,
  snapshot: ExecutionClaimSnapshot,
  attempt: OperationReadinessAttemptRow,
  controllerResult: ContainerControllerReadinessCallResult,
  callMode: "probe" | "readback",
  authentication: AuthenticatedRequest,
  actorRequestIdSha256: string,
): Promise<{
  terminal: OperationReadinessTerminal;
  receipt: ExecutionReceipt;
}> {
  const claim = snapshot.claim;
  const observation = await terminalObservation(controllerResult);
  let resultOutcome: OperationReadinessTerminal["resultOutcome"];
  if (
    controllerResult.classification
      === "process_ready_execution_disabled"
  ) {
    resultOutcome =
      callMode === "probe" ? "exact_success" : "ambiguous_recovered";
  } else if (controllerResult.classification === "explicitly_unhealthy") {
    resultOutcome =
      claim.inflight_readback_only === 1 ? "unresolved" : "rejected";
  } else {
    resultOutcome = "unresolved";
  }
  const terminalEvidence = {
    schemaVersion: 1,
    contract: OPERATION_READINESS_TERMINAL_CONTRACT,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    operationOrdinal: attempt.operation_ordinal,
    operationIdSha256: attempt.operation_id_sha256,
    probeIdSha256: attempt.probe_id_sha256,
    operationRequestSha256: attempt.operation_request_sha256,
    operationStartReceiptDigestSha256:
      attempt.operation_start_receipt_digest_sha256,
    resultOutcome,
    recoveryMode:
      callMode === "probe" ? "fresh" : "readback_only",
    controllerServiceName: attempt.controller_service_name,
    expectedControllerVersionId:
      attempt.controller_enabled_version_id,
    expectedRuntimeBuildId: attempt.runtime_build_id,
    observation,
    terminalWriterCredentialIdSha256:
      authentication.credentialIdSha256,
    terminalWriterRequestIdSha256: actorRequestIdSha256,
    terminalAuthorityVersionId: env.CF_VERSION_METADATA.id,
    ledgerHeadBeforeSha256: claim.ledger_head_sha256,
  };
  const terminalEvidenceSha256 =
    await sha256Canonical(terminalEvidence);
  const unsignedReceipt: Omit<
    ExecutionReceipt,
    "receiptDigestSha256"
  > = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_terminal",
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    executionPlanSha256: claim.execution_plan_sha256,
    ledgerIdentitySha256: claim.ledger_identity_sha256,
    sequence: claim.ledger_version + 1,
    predecessorReceiptSha256:
      attempt.operation_start_receipt_digest_sha256,
    leaseGeneration: claim.lease_generation,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: claim.lease_owner_sha256,
    actorCredentialIdSha256: authentication.credentialIdSha256,
    requestIdSha256: actorRequestIdSha256,
    operationOrdinal: attempt.operation_ordinal,
    operationIdSha256: attempt.operation_id_sha256,
    operationKind: "probe_shard_readiness",
    shardIndex: attempt.shard_index,
    outcome: resultOutcome,
    requestSha256: attempt.operation_request_sha256,
    responseSha256: observation.responseSha256,
    evidenceSha256: terminalEvidenceSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
  };
  const receipt: ExecutionReceipt = {
    ...unsignedReceipt,
    receiptDigestSha256: await sha256Canonical(unsignedReceipt),
  };
  const healthy =
    controllerResult.classification
      === "process_ready_execution_disabled"
      ? controllerResult.evidence
      : null;
  return {
    terminal: {
      authorizationIdSha256: attempt.authorization_id_sha256,
      operationOrdinal: attempt.operation_ordinal,
      shardIndex: attempt.shard_index,
      terminalContract: OPERATION_READINESS_TERMINAL_CONTRACT,
      claimDigestSha256: attempt.claim_digest_sha256,
      attemptDigestSha256: attempt.attempt_digest_sha256,
      operationIdSha256: attempt.operation_id_sha256,
      probeIdSha256: attempt.probe_id_sha256,
      operationRequestSha256: attempt.operation_request_sha256,
      operationStartReceiptDigestSha256:
        attempt.operation_start_receipt_digest_sha256,
      resultOutcome,
      recoveryMode:
        callMode === "probe" ? "fresh" : "readback_only",
      controllerServiceName: attempt.controller_service_name,
      expectedControllerVersionId:
        attempt.controller_enabled_version_id,
      observedControllerVersionId:
        healthy?.controllerVersionId ?? null,
      expectedRuntimeBuildId: attempt.runtime_build_id,
      observedRuntimeBuildId: healthy?.runtimeBuildId ?? null,
      readinessResultCode: healthy?.resultCode ?? null,
      processReady: healthy?.processReady ?? null,
      executionReady: healthy?.executionReady ?? null,
      runtimeExecutionEnabled:
        healthy?.runtimeExecutionEnabled ?? null,
      controllerExecutionEnabled:
        healthy?.controllerExecutionEnabled ?? null,
      containerState: healthy?.containerState ?? null,
      readinessResultSha256:
        healthy?.readinessResultSha256 ?? null,
      controllerResponseSha256: observation.responseSha256,
      controllerResponseBytes: observation.responseBytes,
      controllerRequestIdSha256: attempt.operation_id_sha256,
      terminalWriterCredentialIdSha256:
        authentication.credentialIdSha256,
      terminalWriterRequestIdSha256: actorRequestIdSha256,
      terminalAuthorityVersionId: env.CF_VERSION_METADATA.id,
      terminalEvidenceSha256,
      genericTerminalReceiptDigestSha256:
        receipt.receiptDigestSha256,
    },
    receipt,
  };
}

async function terminalObservation(
  result: ContainerControllerReadinessCallResult,
): Promise<{
  classification: string;
  code: string | null;
  httpStatus: number | null;
  responseSha256: string;
  responseBytes: number;
}> {
  if (result.classification !== "outcome_unknown") {
    return {
      classification: result.classification,
      code: result.classification === "explicitly_unhealthy"
        ? result.reasonCode
        : null,
      httpStatus: result.httpStatus,
      responseSha256: result.responseBodySha256,
      responseBytes: result.responseBytes,
    };
  }
  if (
    result.responseBodySha256 !== null
    && result.responseBytes !== null
    && result.responseBytes > 0
  ) {
    return {
      classification: result.classification,
      code: result.code,
      httpStatus: result.httpStatus,
      responseSha256: result.responseBodySha256,
      responseBytes: result.responseBytes,
    };
  }
  const body = encoder.encode(canonicalJson({
    schemaVersion: 1,
    contract:
      "cinatoken-shard-placement-authority-readiness-unknown-v1",
    classification: result.classification,
    code: result.code,
    mode: result.mode,
    httpStatus: result.httpStatus,
  }));
  return {
    classification: result.classification,
    code: result.code,
    httpStatus: result.httpStatus,
    responseSha256: await sha256Hex(body),
    responseBytes: body.byteLength,
  };
}

function controllerInput(
  attempt: OperationReadinessAttemptRow,
  campaignNonce: string,
  actionGateInventorySha256: string,
  deadlineAtMs: number,
): ContainerControllerReadinessInput {
  return {
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    executionPlanSha256: attempt.execution_plan_sha256,
    operationScheduleSha256: attempt.operation_schedule_sha256,
    authorityLedgerIdentitySha256:
      attempt.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256: attempt.ledger_head_before_sha256,
    predecessorReceiptSha256:
      attempt.predecessor_receipt_sha256,
    operationOrdinal: attempt.operation_ordinal,
    operationIdSha256: attempt.operation_id_sha256,
    probeIdSha256: attempt.probe_id_sha256,
    shard: {
      contractVersion: 1,
      ringGeneration: attempt.ring_generation,
      shardCount: 8,
      shardIndex: attempt.shard_index,
      instanceName: attempt.instance_name,
    },
    campaignId: attempt.campaign_id,
    campaignNonce,
    expectedControllerServiceName:
      attempt.controller_service_name,
    expectedControllerVersionId:
      attempt.controller_enabled_version_id,
    expectedRuntimeBuildId: attempt.runtime_build_id,
    expectedActionGateInventorySha256:
      actionGateInventorySha256,
    authorityVersionId: attempt.authority_version_id,
    deadlineAtMs,
  };
}

async function requireSource(
  env: OperationReadinessEnv,
  command: OperationReadinessCommand,
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  issuance: IssuanceRow,
  operationFiveTerminal: OperationFiveTerminalRow,
): Promise<void> {
  const claim = snapshot.claim;
  const now = issuance.database_now;
  const nonceSha256 = await sha256Hex(
    encoder.encode(command.campaignNonce),
  );
  if (
    operation.operation_id_sha256 !== command.operationIdSha256
    || operation.kind !== "probe_shard_readiness"
    || operation.shard_index !== command.operationOrdinal - 6
    || claim.status !== "running"
    || claim.ledger_version !== (2 * command.operationOrdinal) - 7
    || claim.last_completed_ordinal !== command.operationOrdinal - 1
    || claim.inflight_operation_ordinal !== null
    || claim.inflight_readback_only !== 0
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || claim.ticket_activation_confirmed !== 1
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || claim.ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || claim.campaign_id !== issuance.campaign_id
    || claim.campaign_nonce_sha256 !== nonceSha256
    || issuance.campaign_nonce_sha256 !== nonceSha256
    || issuance.revoked_at !== null
    || issuance.shard_count !== 8
    || issuance.controller_service_name
      !== operationFiveTerminal.controller_service_name
    || issuance.controller_version_id
      !== operationFiveTerminal.controller_enabled_version_id
    || operationFiveTerminal.generic_receipt_sequence !== 5
    || operationFiveTerminal.next_operation_ordinal !== 6
    || env.CF_VERSION_METADATA.id
      !== operationFiveTerminal.authority_terminal_version_id
    || now + 2 >= claim.lease_expires_at
    || now + 2 >= claim.normal_deadline_at
    || now + 2 >= claim.permit_expires_at
  ) {
    throw new ProtocolError(
      "operation_readiness_source_mismatch",
      409,
    );
  }
}

async function requireExistingAttemptSource(
  env: OperationReadinessEnv,
  command: OperationReadinessCommand,
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  issuance: IssuanceRow,
  operationFiveTerminal: OperationFiveTerminalRow,
  attempt: OperationReadinessAttemptRow,
): Promise<void> {
  const claim = snapshot.claim;
  const nonceSha256 = await sha256Hex(
    encoder.encode(command.campaignNonce),
  );
  requireInflight(snapshot, attempt, issuance.database_now);
  if (
    operation.operation_id_sha256 !== attempt.operation_id_sha256
    || operation.kind !== "probe_shard_readiness"
    || operation.shard_index !== attempt.shard_index
    || attempt.operation_ordinal !== command.operationOrdinal
    || attempt.shard_index !== command.operationOrdinal - 6
    || attempt.claim_digest_sha256 !== claim.claim_digest_sha256
    || attempt.claim_owner_sha256 !== claim.claim_owner_sha256
    || attempt.lease_owner_sha256 !== claim.lease_owner_sha256
    || attempt.lease_token_sha256 !== claim.lease_token_sha256
    || attempt.lease_generation !== claim.lease_generation
    || attempt.execution_plan_sha256 !== claim.execution_plan_sha256
    || attempt.operation_schedule_sha256
      !== claim.operation_schedule_sha256
    || attempt.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || attempt.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || attempt.ledger_head_before_sha256
      !== attempt.predecessor_receipt_sha256
    || claim.ledger_head_sha256
      !== attempt.operation_start_receipt_digest_sha256
    || attempt.operation_five_terminal_receipt_sha256
      !== operationFiveTerminal.generic_terminal_receipt_digest_sha256
    || attempt.campaign_id !== claim.campaign_id
    || attempt.campaign_id !== issuance.campaign_id
    || attempt.campaign_nonce_sha256 !== nonceSha256
    || claim.campaign_nonce_sha256 !== nonceSha256
    || issuance.campaign_nonce_sha256 !== nonceSha256
    || attempt.ring_generation !== issuance.ring_generation
    || attempt.shard_count !== 8
    || issuance.shard_count !== 8
    || attempt.instance_name !==
      `cinatoken-relay-shard-v1-${attempt.shard_index
        .toString().padStart(4, "0")}`
    || attempt.controller_service_name
      !== operationFiveTerminal.controller_service_name
    || attempt.controller_service_name
      !== issuance.controller_service_name
    || attempt.controller_enabled_version_id
      !== operationFiveTerminal.controller_enabled_version_id
    || attempt.controller_enabled_version_id
      !== issuance.controller_version_id
    || attempt.runtime_build_id !== issuance.runtime_build_id
    || attempt.authority_version_id !== env.CF_VERSION_METADATA.id
    || operationFiveTerminal.authority_terminal_version_id
      !== env.CF_VERSION_METADATA.id
    || operationFiveTerminal.generic_receipt_sequence !== 5
    || operationFiveTerminal.next_operation_ordinal !== 6
    || issuance.revoked_at !== null
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || issuance.database_now >= claim.permit_expires_at
  ) {
    throw new ProtocolError(
      "operation_readiness_existing_source_mismatch",
      409,
    );
  }
}

function readbackDeadlineAtMs(
  claim: ExecutionClaimSnapshot["claim"],
  databaseNow: number,
): number {
  const deadlineSeconds = Math.min(
    databaseNow + 45,
    claim.lease_expires_at - 1,
    claim.recovery_deadline_at - 1,
    claim.permit_expires_at - 1,
  );
  if (deadlineSeconds <= databaseNow) {
    throw new ProtocolError(
      "operation_readiness_readback_deadline_unavailable",
      409,
    );
  }
  return deadlineSeconds * 1_000;
}

function requireInflight(
  snapshot: ExecutionClaimSnapshot,
  attempt: OperationReadinessAttemptRow,
  databaseNow: number,
): void {
  const claim = snapshot.claim;
  if (
    !Number.isSafeInteger(databaseNow)
    || databaseNow <= 0
    || (
      !(
        claim.status === "running"
        && claim.inflight_readback_only === 0
      )
      && !(
        claim.status === "disable_required"
        && claim.inflight_readback_only === 1
      )
    )
    || claim.ledger_version !== (2 * attempt.operation_ordinal) - 6
    || claim.last_completed_ordinal !== attempt.operation_ordinal - 1
    || claim.inflight_operation_ordinal !== attempt.operation_ordinal
    || claim.inflight_operation_id_sha256
      !== attempt.operation_id_sha256
    || claim.inflight_request_sha256
      !== attempt.operation_request_sha256
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || databaseNow >= claim.lease_expires_at
    || databaseNow >= claim.recovery_deadline_at
  ) {
    throw new ProtocolError(
      "operation_readiness_inflight_mismatch",
      409,
    );
  }
}

function requireOperation(
  snapshot: ExecutionClaimSnapshot,
  command: OperationReadinessCommand,
): ExecutionOperationRow {
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === command.operationOrdinal,
  );
  if (
    operation === undefined
    || operation.operation_id_sha256 !== command.operationIdSha256
    || operation.kind !== "probe_shard_readiness"
    || operation.shard_index !== command.operationOrdinal - 6
  ) {
    throw new ProtocolError(
      "operation_readiness_schedule_mismatch",
      409,
    );
  }
  return operation;
}

function requireCommandMatchesAttempt(
  command: OperationReadinessCommand,
  attempt: OperationReadinessAttemptRow,
): void {
  if (
    attempt.authorization_id_sha256 !== command.authorizationIdSha256
    || attempt.claim_digest_sha256 !== command.claimDigestSha256
    || attempt.claim_owner_sha256 !== command.claimOwnerSha256
    || attempt.operation_ordinal !== command.operationOrdinal
    || attempt.operation_id_sha256 !== command.operationIdSha256
    || attempt.send_request_id_sha256
      !== command.operationRequestIdSha256
  ) {
    throw new ProtocolError(
      "operation_readiness_attempt_replay_mismatch",
      409,
    );
  }
}

function requireCommandMatchesTerminal(
  command: OperationReadinessCommand,
  terminal: OperationReadinessTerminalRow,
): void {
  if (
    terminal.authorization_id_sha256
      !== command.authorizationIdSha256
    || terminal.claim_digest_sha256 !== command.claimDigestSha256
    || terminal.operation_ordinal !== command.operationOrdinal
    || terminal.operation_id_sha256 !== command.operationIdSha256
  ) {
    throw new ProtocolError(
      "operation_readiness_terminal_replay_mismatch",
      409,
    );
  }
}

function resultFromTerminal(
  result: OperationReadinessResult["result"],
  terminal: OperationReadinessTerminalRow,
  authorityVersionId: string,
  claim?: ExecutionClaimSnapshot["claim"],
): OperationReadinessResult {
  const success = [
    "exact_success",
    "ambiguous_recovered",
  ].includes(terminal.result_outcome);
  const receiptCount =
    claim?.ledger_version ?? (2 * terminal.operation_ordinal) - 5;
  return {
    contract: OPERATION_READINESS_RESULT_CONTRACT,
    result,
    authorizationIdSha256: terminal.authorization_id_sha256,
    claimDigestSha256: terminal.claim_digest_sha256,
    operationOrdinal: terminal.operation_ordinal,
    operationIdSha256: terminal.operation_id_sha256,
    shardIndex: terminal.shard_index,
    probeIdSha256: terminal.probe_id_sha256,
    attemptDigestSha256: terminal.attempt_digest_sha256,
    operationStartedReceiptSha256:
      terminal.operation_start_receipt_digest_sha256,
    operationTerminalReceiptSha256:
      terminal.generic_terminal_receipt_digest_sha256,
    controllerServiceName: terminal.controller_service_name,
    controllerEnabledVersionId:
      terminal.expected_controller_version_id,
    runtimeBuildId: terminal.expected_runtime_build_id,
    status: claim?.status ?? (success ? "running" : "disable_required"),
    receiptCount,
    receiptHeadSha256:
      claim?.ledger_head_sha256
      ?? terminal.generic_terminal_receipt_digest_sha256,
    lastCompletedOrdinal:
      claim?.last_completed_ordinal
      ?? (success
        ? terminal.operation_ordinal
        : terminal.operation_ordinal - 1),
    nextOperationOrdinal:
      success
        ? terminal.operation_ordinal + 1
        : 14,
    recoveryAction: success ? "none" : "operation_14",
    authorityVersionId,
  };
}

function terminalResult(
  result: ContainerControllerReadinessCallResult,
  mode: "probe" | "readback",
): OperationReadinessResult["result"] {
  if (
    result.classification === "process_ready_execution_disabled"
  ) {
    return mode === "probe"
      ? "readiness_recorded"
      : "ambiguous_recovered";
  }
  return "disable_required";
}

async function activationProbeId(
  campaignId: string,
  shardIndex: number,
): Promise<string> {
  return sha256Hex(encoder.encode(
    `${ACTIVATION_PROBE_ID_DOMAIN}${campaignId}\0${shardIndex}`,
  ));
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Hex(encoder.encode(canonicalJson(value)));
}

function requireIncomingRole(
  authentication: AuthenticatedRequest,
  mode: "probe" | "readback",
): void {
  const expected = mode === "probe" ? "send" : "recovery";
  if (authentication.role !== expected) {
    throw new ProtocolError(
      "operation_readiness_role_mismatch",
      403,
    );
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value as number;
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return expected;
}
