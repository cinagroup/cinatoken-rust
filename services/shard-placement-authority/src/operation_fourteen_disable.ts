import {
  readControllerDisableAttestation,
  type ControllerDisableAttestationClientEnv,
  type ControllerDisableAttestationEvidence,
} from "./controller_disable_attestation_client";
import {
  CONTROLLER_DISABLE_COMMAND_CONTRACT,
  CONTROLLER_DISABLE_IDEMPOTENCY_CONTRACT,
  controllerDisableCommandDigestSha256,
  controllerDisableIdempotencyKeySha256,
  createControllerDisableOnceWithEvidence,
  readControllerDisableStatusWithEvidence,
  type ControllerDeploymentDisableGatewayClientEnv,
  type ControllerDisableGatewayCallEvidence,
  type ControllerDisableStatusResult,
  type FrozenControllerDisableCommand,
} from "./controller_deployment_disable_gateway_client";
import {
  EXECUTION_RECEIPT_CONTRACT,
  requestIdSha256,
  type ExecutionReceipt,
} from "./execution_protocol";
import {
  readExactExecutionClaim,
  readExactOperationFiveSendAttemptPair,
  readExactOperationFiveTerminal,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type OperationFiveSendAttemptPair,
  type OperationFiveTerminalRow,
} from "./execution_repository";
import {
  OPERATION_FOURTEEN_ATTEMPT_CONTRACT,
  OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
  OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
  OPERATION_FOURTEEN_TERMINAL_CONTRACT,
  appendOperationFourteenGatewayEvent,
  createOperationFourteenAttemptTriple,
  createOperationFourteenTerminal,
  readOperationFourteenDatabaseNow,
  readOperationFourteenEvidence,
  type OperationFourteenAttempt,
  type OperationFourteenAttemptRow,
  type OperationFourteenEvidence,
  type OperationFourteenGatewayEvent,
  type OperationFourteenGatewayEventKind,
  type OperationFourteenGatewayEventRow,
  type OperationFourteenTerminal,
  type OperationFourteenTerminalRow,
} from "./operation_fourteen_repository";
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

export const OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT =
  "cinatoken-shard-placement-authority-disable-command-v1";
export const OPERATION_FOURTEEN_DISABLE_RESULT_CONTRACT =
  "cinatoken-shard-placement-authority-disable-result-v1";

const MAX_COMMAND_BYTES = 4 * 1024;
const CONTROLLER_ACTION_GATE_COUNT = 22;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "operationIdSha256",
  "operationRequestIdSha256",
] as const;
const encoder = new TextEncoder();

export interface OperationFourteenDisableCommand {
  schemaVersion: 1;
  contract: typeof OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  operationIdSha256: string;
  operationRequestIdSha256: string;
}

export interface OperationFourteenDisableEnv
  extends
    ControllerDeploymentDisableGatewayClientEnv,
    ControllerDisableAttestationClientEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_EXPECTED_CONTROLLER_DEPLOYMENT_GATEWAY_VERSION_ID:
    string;
  SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_ATTEMPT_WRITE_ENABLED:
    string;
  SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED:
    string;
  SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_TERMINAL_WRITE_ENABLED:
    string;
}

export interface OperationFourteenDisableResult {
  contract: typeof OPERATION_FOURTEEN_DISABLE_RESULT_CONTRACT;
  result:
    | "disable_dispatched"
    | "disable_outcome_unknown"
    | "status_observation_recorded"
    | "controller_attestation_pending"
    | "terminal_recorded"
    | "recovery_required"
    | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  operationIdSha256: string;
  attemptDigestSha256: string;
  operationStartedReceiptSha256: string;
  operationTerminalReceiptSha256: string | null;
  controllerServiceName: string;
  controllerEnabledSourceVersionId: string;
  controllerBaselineTargetVersionId: string;
  gatewayEventCount: number;
  lastGatewayEventKind: OperationFourteenGatewayEventKind;
  status: string;
  receiptCount: number;
  receiptHeadSha256: string;
  disableConfirmed: boolean;
  recoveryAction:
    | "none"
    | "status_only"
    | "controller_attestation";
  authorityVersionId: string;
}

export interface OperationFourteenDisableDependencies {
  readClaim: typeof readExactExecutionClaim;
  readIssuance: typeof readExactIssuance;
  readOperationFiveTerminal: typeof readExactOperationFiveTerminal;
  readOperationFiveSendAttempt:
    typeof readExactOperationFiveSendAttemptPair;
  readEvidence: typeof readOperationFourteenEvidence;
  readDatabaseNow: typeof readOperationFourteenDatabaseNow;
  createAttempt: typeof createOperationFourteenAttemptTriple;
  appendEvent: typeof appendOperationFourteenGatewayEvent;
  createTerminal: typeof createOperationFourteenTerminal;
  createGateway: typeof createControllerDisableOnceWithEvidence;
  readGatewayStatus: typeof readControllerDisableStatusWithEvidence;
  readControllerAttestation: typeof readControllerDisableAttestation;
}

const DEFAULT_DEPENDENCIES: OperationFourteenDisableDependencies = {
  readClaim: readExactExecutionClaim,
  readIssuance: readExactIssuance,
  readOperationFiveTerminal: readExactOperationFiveTerminal,
  readOperationFiveSendAttempt: readExactOperationFiveSendAttemptPair,
  readEvidence: readOperationFourteenEvidence,
  readDatabaseNow: readOperationFourteenDatabaseNow,
  createAttempt: createOperationFourteenAttemptTriple,
  appendEvent: appendOperationFourteenGatewayEvent,
  createTerminal: createOperationFourteenTerminal,
  createGateway: createControllerDisableOnceWithEvidence,
  readGatewayStatus: readControllerDisableStatusWithEvidence,
  readControllerAttestation: readControllerDisableAttestation,
};

export function parseOperationFourteenDisableCommand(
  body: Uint8Array,
): OperationFourteenDisableCommand {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    throw new ProtocolError("operation_fourteen_command_too_large", 413);
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
  return {
    schemaVersion: literal(value.schemaVersion, 1),
    contract: literal(
      value.contract,
      OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
    ),
    authorizationIdSha256: digest(value.authorizationIdSha256),
    claimDigestSha256: digest(value.claimDigestSha256),
    claimOwnerSha256: digest(value.claimOwnerSha256),
    operationIdSha256: digest(value.operationIdSha256),
    operationRequestIdSha256: digest(value.operationRequestIdSha256),
  };
}

export async function executeOperationFourteenDisable(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  authentication: AuthenticatedRequest,
  requestedMode: "fresh" | "readback",
  dependencies: OperationFourteenDisableDependencies = DEFAULT_DEPENDENCIES,
): Promise<OperationFourteenDisableResult> {
  requireIncomingRole(authentication, requestedMode);
  const actorRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  if (
    requestedMode === "fresh"
    && actorRequestIdSha256 !== command.operationRequestIdSha256
  ) {
    throw new ProtocolError(
      "operation_fourteen_request_identity_mismatch",
      403,
    );
  }

  let evidence = await dependencies.readEvidence(
    env.DB,
    command.authorizationIdSha256,
  );
  if (evidence.terminal !== null) {
    if (evidence.attempt === null) {
      throw new ProtocolError(
        "operation_fourteen_terminal_attempt_missing",
        409,
      );
    }
    requireCommandMatchesAttempt(command, evidence.attempt);
    requireCommandMatchesTerminal(command, evidence.terminal);
    return resultFromTerminal(
      "exact_replay",
      evidence,
      evidence.terminal,
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
  const operationFiveSendAttempt =
    await dependencies.readOperationFiveSendAttempt(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
    );
  if (operationFiveTerminal === null || operationFiveSendAttempt === null) {
    throw new ProtocolError(
      "operation_fourteen_enable_evidence_missing",
      409,
    );
  }

  let attempt = evidence.attempt;
  let callMode: "fresh" | "readback" = requestedMode;
  if (attempt === null) {
    requireFreshSource(
      env,
      command,
      snapshot,
      operation,
      issuance,
      operationFiveTerminal,
      operationFiveSendAttempt,
    );
    if (requestedMode !== "fresh") {
      throw new ProtocolError("operation_fourteen_attempt_missing", 409);
    }
    if (
      env
        .SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_ATTEMPT_WRITE_ENABLED
        !== "true"
    ) {
      throw new ProtocolError(
        "authority_operation_fourteen_attempt_write_disabled",
        503,
      );
    }
    const built = await buildAttempt(
      env,
      command,
      snapshot,
      issuance,
      operation,
      operationFiveTerminal,
      operationFiveSendAttempt,
    );
    const created = await dependencies.createAttempt(
      env.DB,
      built.attempt,
      built.receipt,
      built.dispatchEvent,
    );
    attempt = created.attempt;
    callMode = created.classification === "created"
      ? "fresh"
      : "readback";
    snapshot = await dependencies.readClaim(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
      command.claimOwnerSha256,
    );
    evidence = await dependencies.readEvidence(
      env.DB,
      command.authorizationIdSha256,
    );
  } else {
    requireCommandMatchesAttempt(command, attempt);
    callMode = "readback";
  }

  requireExistingSource(
    env,
    snapshot,
    issuance,
    operation,
    operationFiveTerminal,
    operationFiveSendAttempt,
    attempt,
  );

  if (callMode === "fresh") {
    if (
      env
        .SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED
        !== "true"
    ) {
      throw new ProtocolError(
        "authority_operation_fourteen_event_write_disabled",
        503,
      );
    }
    const createRequestId = createGatewayRequestId(attempt);
    let createEvidence: Awaited<
      ReturnType<typeof createControllerDisableOnceWithEvidence>
    > | null = null;
    try {
      createEvidence = await dependencies.createGateway(
        env,
        {
          command: gatewayCommandFromAttempt(attempt),
          controllerDisableCommandDigestSha256:
            attempt.gateway_command_digest_sha256,
          gatewayDisableIdempotencyKeySha256:
            attempt.gateway_idempotency_key_sha256,
          authorityAttemptDigestSha256: attempt.attempt_digest_sha256,
          sendStartedEventDigestSha256:
            attempt.disable_dispatched_event_digest_sha256,
        },
        { requestId: createRequestId, now: issuance.database_now },
      );
    } catch {
      createEvidence = null;
    }
    const mutationEvent = await buildMutationEvent(
      attempt,
      evidence.gatewayEvents.at(-1)!,
      createEvidence,
    );
    await dependencies.appendEvent(env.DB, mutationEvent);
    evidence = await dependencies.readEvidence(
      env.DB,
      command.authorizationIdSha256,
    );
    if (mutationEvent.eventKind === "mutation_rejected") {
      return finalizeTerminal(
        env,
        command,
        authentication,
        actorRequestIdSha256,
        snapshot,
        evidence,
        mutationEvent,
        "rejected",
        "fresh",
        null,
        dependencies,
      );
    }
    if (mutationEvent.eventKind === "mutation_unknown") {
      return resultFromEvidence(
        "disable_outcome_unknown",
        evidence,
        snapshot,
        "status_only",
        env.CF_VERSION_METADATA.id,
      );
    }
  }

  evidence = await dependencies.readEvidence(
    env.DB,
    command.authorizationIdSha256,
  );
  const last = evidence.gatewayEvents.at(-1);
  if (last === undefined) {
    throw new ProtocolError(
      "operation_fourteen_gateway_evidence_missing",
      409,
    );
  }
  if (last.event_kind === "disable_dispatched") {
    const unknown = await buildUnknownMutationRecoveryEvent(
      attempt,
      last,
    );
    await dependencies.appendEvent(env.DB, unknown);
    evidence = await dependencies.readEvidence(
      env.DB,
      command.authorizationIdSha256,
    );
  }

  const currentLast = evidence.gatewayEvents.at(-1)!;
  if (currentLast.event_kind === "stable_disabled") {
    return attestAndFinalize(
      env,
      command,
      authentication,
      actorRequestIdSha256,
      snapshot,
      issuance,
      evidence,
      currentLast,
      dependencies,
    );
  }

  if (
    env.SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_EVENT_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_operation_fourteen_event_write_disabled",
      503,
    );
  }
  const databaseNow = await dependencies.readDatabaseNow(env.DB);
  if (databaseNow > attempt.disable_deadline_at) {
    return maybeFinalizeUnresolved(
      env,
      command,
      authentication,
      actorRequestIdSha256,
      snapshot,
      evidence,
      currentLast,
      dependencies,
    );
  }

  const statusRequestId = statusGatewayRequestId(
    attempt,
    currentLast.event_sequence + 1,
  );
  let statusEvidence: ControllerDisableGatewayCallEvidence<
    ControllerDisableStatusResult
  > | null = null;
  try {
    statusEvidence = await dependencies.readGatewayStatus(
      env,
      {
        gatewayDisableIdempotencyKeySha256:
          attempt.gateway_idempotency_key_sha256,
        controllerDisableCommandDigestSha256:
          attempt.gateway_command_digest_sha256,
      },
      { requestId: statusRequestId, now: databaseNow },
    );
  } catch {
    statusEvidence = null;
  }
  const statusEvent = await buildStatusEvent(
    attempt,
    currentLast,
    statusRequestId,
    statusEvidence,
  );
  await dependencies.appendEvent(env.DB, statusEvent);
  evidence = await dependencies.readEvidence(
    env.DB,
    command.authorizationIdSha256,
  );

  if (statusEvent.eventKind === "stable_disabled") {
    snapshot = await dependencies.readClaim(
      env.DB,
      command.authorizationIdSha256,
      command.claimDigestSha256,
      command.claimOwnerSha256,
    );
    return attestAndFinalize(
      env,
      command,
      authentication,
      actorRequestIdSha256,
      snapshot,
      issuance,
      evidence,
      evidence.gatewayEvents.at(-1)!,
      dependencies,
    );
  }
  return resultFromEvidence(
    statusEvent.eventKind === "status_unknown"
      ? "disable_outcome_unknown"
      : "status_observation_recorded",
    evidence,
    snapshot,
    "status_only",
    env.CF_VERSION_METADATA.id,
  );
}

async function buildAttempt(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  snapshot: ExecutionClaimSnapshot,
  issuance: IssuanceRow,
  operation: ExecutionOperationRow,
  operationFiveTerminal: OperationFiveTerminalRow,
  operationFiveSendAttempt: OperationFiveSendAttemptPair,
): Promise<{
  attempt: OperationFourteenAttempt;
  receipt: ExecutionReceipt;
  dispatchEvent: OperationFourteenGatewayEvent;
}> {
  const claim = snapshot.claim;
  const authorityCommandDigestSha256 = await sha256Canonical(command);
  const operationRequestSha256 = await sha256Canonical({
    ...command,
    executionPlanSha256: claim.execution_plan_sha256,
    operationScheduleSha256: claim.operation_schedule_sha256,
    predecessorReceiptSha256: claim.ledger_head_sha256,
    operationFiveTerminalReceiptSha256:
      operationFiveTerminal.generic_terminal_receipt_digest_sha256,
    operationFiveSendAttemptDigestSha256:
      operationFiveSendAttempt.attempt.attempt_digest_sha256,
    controllerServiceName: operationFiveTerminal.controller_service_name,
    controllerEnabledSourceVersionId:
      operationFiveTerminal.controller_enabled_version_id,
    controllerBaselineTargetVersionId:
      operationFiveSendAttempt.attempt.controller_baseline_version_id,
  });
  const gatewayCommand: FrozenControllerDisableCommand = {
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    operation14IdSha256: operation.operation_id_sha256,
    authorityDatabaseIdentitySha256:
      claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256: claim.ledger_identity_sha256,
    authorityLedgerHeadSha256: claim.ledger_head_sha256,
    authorityVersionId: env.CF_VERSION_METADATA.id,
    leaseOwnerSha256: claim.lease_owner_sha256,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseGeneration: claim.lease_generation,
    controllerServiceName: operationFiveTerminal.controller_service_name,
    controllerEnabledSourceVersionId:
      operationFiveTerminal.controller_enabled_version_id,
    controllerBaselineTargetVersionId:
      operationFiveSendAttempt.attempt.controller_baseline_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
  const gatewayCommandDigestSha256 =
    await controllerDisableCommandDigestSha256(gatewayCommand);
  const gatewayIdempotencyKeySha256 =
    await controllerDisableIdempotencyKeySha256(gatewayCommand);
  const createRequestId = createGatewayRequestIdFromOperation(
    operation.operation_id_sha256,
  );
  const statusRequestId = statusGatewayRequestIdFromOperation(
    operation.operation_id_sha256,
    3,
  );
  const disableDeadlineAt = Math.min(
    issuance.database_now + 60,
    claim.lease_expires_at - 5,
    claim.recovery_deadline_at - 5,
    claim.permit_expires_at - 5,
  );
  if (disableDeadlineAt <= issuance.database_now + 5) {
    throw new ProtocolError(
      "operation_fourteen_deadline_unavailable",
      409,
    );
  }
  const attemptBase = {
    schemaVersion: 1,
    contract: OPERATION_FOURTEEN_ATTEMPT_CONTRACT,
    authorizationIdSha256: claim.authorization_id_sha256,
    claimDigestSha256: claim.claim_digest_sha256,
    claimOwnerSha256: claim.claim_owner_sha256,
    leaseOwnerSha256: claim.lease_owner_sha256,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseGeneration: claim.lease_generation,
    executionPlanSha256: claim.execution_plan_sha256,
    operationScheduleSha256: claim.operation_schedule_sha256,
    authorityDatabaseIdentitySha256:
      claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256: claim.ledger_identity_sha256,
    ledgerVersionBefore: claim.ledger_version,
    ledgerHeadBeforeSha256: claim.ledger_head_sha256,
    operationStartSequence: claim.ledger_version + 1,
    operationFiveTerminalReceiptSha256:
      operationFiveTerminal.generic_terminal_receipt_digest_sha256,
    operationFiveSendAttemptDigestSha256:
      operationFiveSendAttempt.attempt.attempt_digest_sha256,
    operationIdSha256: operation.operation_id_sha256,
    operationRequestSha256,
    controllerServiceName: operationFiveTerminal.controller_service_name,
    controllerEnabledSourceVersionId:
      operationFiveTerminal.controller_enabled_version_id,
    controllerBaselineTargetVersionId:
      operationFiveSendAttempt.attempt.controller_baseline_version_id,
    authorityCommandContract:
      OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
    authorityCommandDigestSha256,
    gatewayCommandContract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
    gatewayCommandDigestSha256,
    gatewayIdempotencyContract: CONTROLLER_DISABLE_IDEMPOTENCY_CONTRACT,
    gatewayIdempotencyKeySha256,
    gatewayCreateCredentialIdSha256:
      env
        .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_CREATE_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    gatewayCreateRequestIdSha256:
      await requestIdSha256(createRequestId),
    gatewayStatusCredentialIdSha256:
      env
        .CONTROLLER_DEPLOYMENT_GATEWAY_DISABLE_STATUS_HMAC_CURRENT_CREDENTIAL_ID_SHA256,
    gatewayStatusRequestIdSha256:
      await requestIdSha256(statusRequestId),
    authorityVersionId: env.CF_VERSION_METADATA.id,
    expectedGatewayVersionId:
      env
        .SHARD_PLACEMENT_AUTHORITY_EXPECTED_CONTROLLER_DEPLOYMENT_GATEWAY_VERSION_ID,
    disableDeadlineAt,
    mutationAttemptLimit: 1 as const,
    retryLimit: 0 as const,
    missingReadbackAllowsResend: false as const,
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
    actorCredentialIdSha256:
      attemptBase.gatewayCreateCredentialIdSha256,
    requestIdSha256: attemptBase.gatewayCreateRequestIdSha256,
    operationOrdinal: 14,
    operationIdSha256: operation.operation_id_sha256,
    operationKind: "disable_controller_deployment",
    shardIndex: null,
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
  const dispatchBase: Omit<
    OperationFourteenGatewayEvent,
    "eventDigestSha256"
  > = {
    authorizationIdSha256: claim.authorization_id_sha256,
    attemptDigestSha256,
    eventSequence: 1,
    eventContract: OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
    eventKind: "disable_dispatched",
    dispatchSemantics: OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
    credentialRole: "disable_create",
    credentialIdSha256: attemptBase.gatewayCreateCredentialIdSha256,
    requestIdSha256: attemptBase.gatewayCreateRequestIdSha256,
    authorityCommandDigestSha256,
    gatewayCommandDigestSha256,
    gatewayIdempotencyKeySha256,
    controllerServiceName: attemptBase.controllerServiceName,
    controllerBaselineTargetVersionId:
      attemptBase.controllerBaselineTargetVersionId,
    expectedGatewayVersionId: attemptBase.expectedGatewayVersionId,
    observedGatewayVersionId: null,
    observedControllerVersionId: null,
    statusClassification: null,
    gatewayHttpStatus: null,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    cloudflareRequestIdSha256: null,
    deploymentSetSha256: null,
    observationDigestSha256: null,
    stabilityMinimumSeconds: null,
    predecessorEventDigestSha256: attemptDigestSha256,
  };
  const dispatchEvent = {
    ...dispatchBase,
    eventDigestSha256: await sha256Canonical(dispatchBase),
  };
  return {
    attempt: {
      authorizationIdSha256: attemptBase.authorizationIdSha256,
      attemptContract: OPERATION_FOURTEEN_ATTEMPT_CONTRACT,
      claimDigestSha256: attemptBase.claimDigestSha256,
      claimOwnerSha256: attemptBase.claimOwnerSha256,
      leaseOwnerSha256: attemptBase.leaseOwnerSha256,
      leaseTokenSha256: attemptBase.leaseTokenSha256,
      leaseGeneration: attemptBase.leaseGeneration,
      executionPlanSha256: attemptBase.executionPlanSha256,
      operationScheduleSha256: attemptBase.operationScheduleSha256,
      authorityDatabaseIdentitySha256:
        attemptBase.authorityDatabaseIdentitySha256,
      authorityLedgerIdentitySha256:
        attemptBase.authorityLedgerIdentitySha256,
      ledgerVersionBefore: attemptBase.ledgerVersionBefore,
      ledgerHeadBeforeSha256: attemptBase.ledgerHeadBeforeSha256,
      operationStartSequence: attemptBase.operationStartSequence,
      operationFiveTerminalReceiptSha256:
        attemptBase.operationFiveTerminalReceiptSha256,
      operationFiveSendAttemptDigestSha256:
        attemptBase.operationFiveSendAttemptDigestSha256,
      operationIdSha256: attemptBase.operationIdSha256,
      operationRequestSha256: attemptBase.operationRequestSha256,
      controllerServiceName: attemptBase.controllerServiceName,
      controllerEnabledSourceVersionId:
        attemptBase.controllerEnabledSourceVersionId,
      controllerBaselineTargetVersionId:
        attemptBase.controllerBaselineTargetVersionId,
      authorityCommandContract:
        OPERATION_FOURTEEN_DISABLE_COMMAND_CONTRACT,
      authorityCommandDigestSha256,
      gatewayCommandContract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
      gatewayCommandDigestSha256,
      gatewayIdempotencyContract: CONTROLLER_DISABLE_IDEMPOTENCY_CONTRACT,
      gatewayIdempotencyKeySha256,
      gatewayCreateCredentialIdSha256:
        attemptBase.gatewayCreateCredentialIdSha256,
      gatewayCreateRequestIdSha256:
        attemptBase.gatewayCreateRequestIdSha256,
      gatewayStatusCredentialIdSha256:
        attemptBase.gatewayStatusCredentialIdSha256,
      gatewayStatusRequestIdSha256:
        attemptBase.gatewayStatusRequestIdSha256,
      authorityVersionId: attemptBase.authorityVersionId,
      expectedGatewayVersionId: attemptBase.expectedGatewayVersionId,
      disableDeadlineAt,
      attemptDigestSha256,
      operationStartReceiptDigestSha256:
        receipt.receiptDigestSha256,
      disableDispatchedEventDigestSha256:
        dispatchEvent.eventDigestSha256,
    },
    receipt,
    dispatchEvent,
  };
}

async function buildMutationEvent(
  attempt: OperationFourteenAttemptRow,
  predecessor: OperationFourteenGatewayEventRow,
  evidence: Awaited<
    ReturnType<typeof createControllerDisableOnceWithEvidence>
  > | null,
): Promise<OperationFourteenGatewayEvent> {
  const value = evidence?.value;
  let eventKind: OperationFourteenGatewayEventKind = "mutation_unknown";
  if (
    value?.outcome?.classification === "accepted"
    && value.gatewayVersionId === attempt.expected_gateway_version_id
  ) {
    eventKind = "mutation_accepted";
  } else if (value?.outcome?.classification === "rejected") {
    eventKind = "mutation_rejected";
  }
  const eventBase = eventBaseFromAttempt(
    attempt,
    predecessor,
    2,
    eventKind,
    "disable_create",
    attempt.gateway_create_credential_id_sha256,
    await requestIdSha256(
      `${createGatewayRequestId(attempt)}-outcome`,
    ),
  );
  const complete = {
    ...eventBase,
    observedGatewayVersionId: value?.gatewayVersionId ?? null,
    gatewayHttpStatus:
      eventKind === "mutation_unknown"
        ? null
        : value?.outcome?.httpStatus ?? null,
    gatewayResponseSha256: evidence?.gatewayResponseSha256 ?? null,
    gatewayResponseBytes: evidence?.gatewayResponseBytes ?? null,
    cloudflareRequestIdSha256:
      value?.outcome?.responseRequestIdSha256 ?? null,
  };
  return {
    ...complete,
    eventDigestSha256: await sha256Canonical(complete),
  };
}

async function buildUnknownMutationRecoveryEvent(
  attempt: OperationFourteenAttemptRow,
  predecessor: OperationFourteenGatewayEventRow,
): Promise<OperationFourteenGatewayEvent> {
  const eventBase = eventBaseFromAttempt(
    attempt,
    predecessor,
    2,
    "mutation_unknown",
    "disable_create",
    attempt.gateway_create_credential_id_sha256,
    await requestIdSha256(
      `${createGatewayRequestId(attempt)}-recovered-unknown`,
    ),
  );
  return {
    ...eventBase,
    eventDigestSha256: await sha256Canonical(eventBase),
  };
}

async function buildStatusEvent(
  attempt: OperationFourteenAttemptRow,
  predecessor: OperationFourteenGatewayEventRow,
  requestId: string,
  evidence: ControllerDisableGatewayCallEvidence<
    ControllerDisableStatusResult
  > | null,
): Promise<OperationFourteenGatewayEvent> {
  const value = evidence?.value;
  const observation = value?.observation;
  const gatewayIdentityMatches =
    value?.gatewayVersionId === attempt.expected_gateway_version_id;
  const exactTarget =
    gatewayIdentityMatches
    && observation?.classification === "exact_disable_observed";
  const knownSource =
    observation?.classification === "enabled_source_observed";
  const previousTargetMatches =
    predecessor.event_kind === "status_target"
    && predecessor.status_classification === "target_observed"
    && predecessor.observed_gateway_version_id === value?.gatewayVersionId
    && predecessor.observed_controller_version_id
      === attempt.controller_baseline_target_version_id
    && predecessor.deployment_set_sha256
      === observation?.deploymentSetSha256
    && predecessor.observation_digest_sha256
      === observation?.stateDigestSha256;
  let eventKind: OperationFourteenGatewayEventKind;
  if (exactTarget && value.targetStable && previousTargetMatches) {
    eventKind = "stable_disabled";
  } else if (exactTarget) {
    eventKind = "status_target";
  } else if (
    (knownSource || !gatewayIdentityMatches)
    && observation?.deploymentSetSha256 !== null
    && observation?.deploymentSetSha256 !== undefined
  ) {
    eventKind = "status_drift";
  } else {
    eventKind = "status_unknown";
  }
  const eventBase = eventBaseFromAttempt(
    attempt,
    predecessor,
    predecessor.event_sequence + 1,
    eventKind,
    "disable_status",
    attempt.gateway_status_credential_id_sha256,
    await requestIdSha256(requestId),
  );
  const statusClassification:
    OperationFourteenGatewayEvent["statusClassification"] =
    eventKind === "status_target" || eventKind === "stable_disabled"
      ? "target_observed"
      : eventKind === "status_drift"
      ? "drift_observed"
      : "unknown";
  const observedControllerVersionId =
    eventKind === "status_target" || eventKind === "stable_disabled"
      ? attempt.controller_baseline_target_version_id
      : knownSource
      ? attempt.controller_enabled_source_version_id
      : !gatewayIdentityMatches && observation !== undefined
      ? attempt.controller_baseline_target_version_id
      : null;
  const complete = {
    ...eventBase,
    observedGatewayVersionId: value?.gatewayVersionId ?? null,
    observedControllerVersionId,
    statusClassification,
    gatewayHttpStatus: observation?.deploymentsHttpStatus ?? null,
    gatewayResponseSha256: evidence?.gatewayResponseSha256 ?? null,
    gatewayResponseBytes: evidence?.gatewayResponseBytes ?? null,
    cloudflareRequestIdSha256:
      observation?.responseRequestIdSha256 ?? null,
    deploymentSetSha256: observation?.deploymentSetSha256 ?? null,
    observationDigestSha256: observation?.stateDigestSha256 ?? null,
    stabilityMinimumSeconds:
      eventKind === "stable_disabled"
        ? value?.stabilityMinimumSeconds ?? null
        : null,
  };
  return {
    ...complete,
    eventDigestSha256: await sha256Canonical(complete),
  };
}

function eventBaseFromAttempt(
  attempt: OperationFourteenAttemptRow,
  predecessor: OperationFourteenGatewayEventRow,
  eventSequence: number,
  eventKind: OperationFourteenGatewayEventKind,
  credentialRole: "disable_create" | "disable_status",
  credentialIdSha256: string,
  requestIdSha256Value: string,
): Omit<OperationFourteenGatewayEvent, "eventDigestSha256"> {
  return {
    authorizationIdSha256: attempt.authorization_id_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    eventSequence,
    eventContract: OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
    eventKind,
    dispatchSemantics: OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
    credentialRole,
    credentialIdSha256,
    requestIdSha256: requestIdSha256Value,
    authorityCommandDigestSha256:
      attempt.authority_command_digest_sha256,
    gatewayCommandDigestSha256:
      attempt.gateway_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      attempt.gateway_idempotency_key_sha256,
    controllerServiceName: attempt.controller_service_name,
    controllerBaselineTargetVersionId:
      attempt.controller_baseline_target_version_id,
    expectedGatewayVersionId: attempt.expected_gateway_version_id,
    observedGatewayVersionId: null,
    observedControllerVersionId: null,
    statusClassification: null,
    gatewayHttpStatus: null,
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    cloudflareRequestIdSha256: null,
    deploymentSetSha256: null,
    observationDigestSha256: null,
    stabilityMinimumSeconds: null,
    predecessorEventDigestSha256: predecessor.event_digest_sha256,
  };
}

async function attestAndFinalize(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  authentication: AuthenticatedRequest,
  actorRequestIdSha256: string,
  snapshot: ExecutionClaimSnapshot,
  issuance: IssuanceRow,
  evidence: OperationFourteenEvidence,
  stableEvent: OperationFourteenGatewayEventRow,
  dependencies: OperationFourteenDisableDependencies,
): Promise<OperationFourteenDisableResult> {
  const attempt = requireAttempt(evidence);
  const requestId =
    `op14-attest-${attempt.operation_id_sha256.slice(0, 32)}`
    + `-${stableEvent.event_sequence}`;
  let attestation: ControllerDisableAttestationEvidence;
  try {
    attestation = await dependencies.readControllerAttestation(
      env,
      {
        controllerServiceName: attempt.controller_service_name,
        controllerVersionId:
          attempt.controller_baseline_target_version_id,
        actionGateInventorySha256:
          issuance.action_gate_inventory_sha256,
        actionGateCount: CONTROLLER_ACTION_GATE_COUNT,
      },
      { requestId, now: issuance.database_now },
    );
  } catch {
    return resultFromEvidence(
      "controller_attestation_pending",
      evidence,
      snapshot,
      "controller_attestation",
      env.CF_VERSION_METADATA.id,
    );
  }
  return finalizeTerminal(
    env,
    command,
    authentication,
    actorRequestIdSha256,
    snapshot,
    evidence,
    rowToEvent(stableEvent),
    "ambiguous_recovered",
    "readback_only",
    attestation,
    dependencies,
  );
}

async function maybeFinalizeUnresolved(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  authentication: AuthenticatedRequest,
  actorRequestIdSha256: string,
  snapshot: ExecutionClaimSnapshot,
  evidence: OperationFourteenEvidence,
  last: OperationFourteenGatewayEventRow,
  dependencies: OperationFourteenDisableDependencies,
): Promise<OperationFourteenDisableResult> {
  if (
    last.event_kind !== "mutation_unknown"
    && last.event_kind !== "status_drift"
    && last.event_kind !== "status_unknown"
  ) {
    return resultFromEvidence(
      "disable_outcome_unknown",
      evidence,
      snapshot,
      "status_only",
      env.CF_VERSION_METADATA.id,
    );
  }
  return finalizeTerminal(
    env,
    command,
    authentication,
    actorRequestIdSha256,
    snapshot,
    evidence,
    rowToEvent(last),
    last.event_kind === "status_drift" ? "rejected" : "unresolved",
    "readback_only",
    null,
    dependencies,
  );
}

async function finalizeTerminal(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  authentication: AuthenticatedRequest,
  actorRequestIdSha256: string,
  snapshot: ExecutionClaimSnapshot,
  evidence: OperationFourteenEvidence,
  terminalEvent: OperationFourteenGatewayEvent,
  resultOutcome: OperationFourteenTerminal["resultOutcome"],
  recoveryMode: OperationFourteenTerminal["recoveryMode"],
  attestation: ControllerDisableAttestationEvidence | null,
  dependencies: OperationFourteenDisableDependencies,
): Promise<OperationFourteenDisableResult> {
  if (
    env
      .SHARD_PLACEMENT_AUTHORITY_OPERATION_FOURTEEN_TERMINAL_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_operation_fourteen_terminal_write_disabled",
      503,
    );
  }
  const attempt = requireAttempt(evidence);
  snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const terminalEvidenceValue = {
    schemaVersion: 1,
    contract: OPERATION_FOURTEEN_TERMINAL_CONTRACT,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    operationIdSha256: attempt.operation_id_sha256,
    operationRequestSha256: attempt.operation_request_sha256,
    operationStartReceiptDigestSha256:
      attempt.operation_start_receipt_digest_sha256,
    resultOutcome,
    recoveryMode,
    terminalEvent: {
      eventSequence: terminalEvent.eventSequence,
      eventKind: terminalEvent.eventKind,
      eventDigestSha256: terminalEvent.eventDigestSha256,
      gatewayResponseSha256: terminalEvent.gatewayResponseSha256,
      observationStateDigestSha256:
        terminalEvent.observationDigestSha256,
      deploymentSetSha256: terminalEvent.deploymentSetSha256,
    },
    controllerAttestation: attestation === null
      ? null
      : {
          credentialIdSha256: attestation.credentialIdSha256,
          requestIdSha256: attestation.requestIdSha256,
          responseSha256: attestation.responseSha256,
          responseBytes: attestation.responseBytes,
          actionGateInventorySha256:
            attestation.value.actionGates.digestSha256,
          actionGateCount: attestation.value.actionGates.count,
          controllerVersionId: attestation.value.controllerVersionId,
        },
    terminalWriterCredentialIdSha256:
      authentication.credentialIdSha256,
    terminalWriterRequestIdSha256: actorRequestIdSha256,
    authorityTerminalVersionId: env.CF_VERSION_METADATA.id,
    ledgerHeadBeforeSha256: snapshot.claim.ledger_head_sha256,
  };
  const terminalEvidenceSha256 =
    await sha256Canonical(terminalEvidenceValue);
  const terminalResponseValue = {
    schemaVersion: 1,
    contract: OPERATION_FOURTEEN_DISABLE_RESULT_CONTRACT,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    operationIdSha256: attempt.operation_id_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    resultOutcome,
    recoveryMode,
    terminalEventDigestSha256: terminalEvent.eventDigestSha256,
    controllerAttestationResponseSha256:
      attestation?.responseSha256 ?? null,
  };
  const terminalResponseSha256 =
    await sha256Canonical(terminalResponseValue);
  const unsignedReceipt: Omit<
    ExecutionReceipt,
    "receiptDigestSha256"
  > = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_terminal",
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    executionPlanSha256: attempt.execution_plan_sha256,
    ledgerIdentitySha256: attempt.authority_ledger_identity_sha256,
    sequence: snapshot.claim.ledger_version + 1,
    predecessorReceiptSha256: snapshot.claim.ledger_head_sha256,
    leaseGeneration: snapshot.claim.lease_generation,
    leaseTokenSha256: snapshot.claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: snapshot.claim.lease_owner_sha256,
    actorCredentialIdSha256: authentication.credentialIdSha256,
    requestIdSha256: actorRequestIdSha256,
    operationOrdinal: 14,
    operationIdSha256: attempt.operation_id_sha256,
    operationKind: "disable_controller_deployment",
    shardIndex: null,
    outcome: resultOutcome,
    requestSha256: attempt.operation_request_sha256,
    responseSha256: terminalResponseSha256,
    evidenceSha256: terminalEvidenceSha256,
    cloudflareRequestIdSha256:
      terminalEvent.cloudflareRequestIdSha256,
    safetyReason: null,
  };
  const receipt: ExecutionReceipt = {
    ...unsignedReceipt,
    receiptDigestSha256: await sha256Canonical(unsignedReceipt),
  };
  const terminal: OperationFourteenTerminal = {
    authorizationIdSha256: attempt.authorization_id_sha256,
    terminalContract: OPERATION_FOURTEEN_TERMINAL_CONTRACT,
    claimDigestSha256: attempt.claim_digest_sha256,
    claimOwnerSha256: attempt.claim_owner_sha256,
    attemptLeaseOwnerSha256: attempt.lease_owner_sha256,
    attemptLeaseTokenSha256: attempt.lease_token_sha256,
    attemptLeaseGeneration: attempt.lease_generation,
    leaseOwnerSha256: snapshot.claim.lease_owner_sha256,
    leaseTokenSha256: snapshot.claim.lease_token_sha256,
    leaseGeneration: snapshot.claim.lease_generation,
    executionPlanSha256: attempt.execution_plan_sha256,
    operationScheduleSha256: attempt.operation_schedule_sha256,
    authorityDatabaseIdentitySha256:
      attempt.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      attempt.authority_ledger_identity_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    operationIdSha256: attempt.operation_id_sha256,
    operationRequestSha256: attempt.operation_request_sha256,
    operationStartReceiptDigestSha256:
      attempt.operation_start_receipt_digest_sha256,
    controllerServiceName: attempt.controller_service_name,
    controllerEnabledSourceVersionId:
      attempt.controller_enabled_source_version_id,
    controllerBaselineTargetVersionId:
      attempt.controller_baseline_target_version_id,
    authorityCommandDigestSha256:
      attempt.authority_command_digest_sha256,
    gatewayCommandDigestSha256: attempt.gateway_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      attempt.gateway_idempotency_key_sha256,
    terminalEventSequence: terminalEvent.eventSequence,
    terminalEventDigestSha256: terminalEvent.eventDigestSha256,
    terminalEventKind: terminalEvent.eventKind as
      OperationFourteenTerminal["terminalEventKind"],
    terminalEventResponseSha256:
      terminalEvent.gatewayResponseSha256,
    terminalEventRequestIdSha256: terminalEvent.requestIdSha256,
    terminalEventCloudflareRequestIdSha256:
      terminalEvent.cloudflareRequestIdSha256,
    terminalEventObservationDigestSha256:
      terminalEvent.observationDigestSha256,
    terminalEventDeploymentSetSha256:
      terminalEvent.deploymentSetSha256,
    resultOutcome,
    recoveryMode,
    terminalResponseSha256,
    terminalEvidenceSha256,
    authorityTerminalVersionId: env.CF_VERSION_METADATA.id,
    terminalWriterCredentialIdSha256:
      authentication.credentialIdSha256,
    terminalWriterRequestIdSha256: actorRequestIdSha256,
    ledgerVersionBefore: snapshot.claim.ledger_version,
    ledgerHeadBeforeSha256: snapshot.claim.ledger_head_sha256,
    genericReceiptSequence: receipt.sequence,
    genericTerminalReceiptDigestSha256: receipt.receiptDigestSha256,
  };
  const created = await dependencies.createTerminal(
    env.DB,
    terminal,
    receipt,
  );
  const updatedEvidence = await dependencies.readEvidence(
    env.DB,
    command.authorizationIdSha256,
  );
  return resultFromTerminal(
    created.classification === "exact_replay"
      ? "exact_replay"
      : resultOutcome === "exact_success"
        || resultOutcome === "ambiguous_recovered"
      ? "terminal_recorded"
      : "recovery_required",
    updatedEvidence,
    created.terminal,
    env.CF_VERSION_METADATA.id,
    created.claim,
  );
}

function requireFreshSource(
  env: OperationFourteenDisableEnv,
  command: OperationFourteenDisableCommand,
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  issuance: IssuanceRow,
  terminal: OperationFiveTerminalRow,
  sendAttempt: OperationFiveSendAttemptPair,
): void {
  const claim = snapshot.claim;
  if (
    claim.authorization_id_sha256 !== command.authorizationIdSha256
    || claim.claim_digest_sha256 !== command.claimDigestSha256
    || claim.claim_owner_sha256 !== command.claimOwnerSha256
    || claim.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || claim.ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || claim.ledger_version > 52
    || claim.inflight_operation_ordinal !== null
    || claim.inflight_operation_id_sha256 !== null
    || claim.inflight_request_sha256 !== null
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || !(
      (
        claim.status === "running"
        && claim.last_completed_ordinal === 13
      )
      || claim.status === "disable_required"
    )
    || issuance.database_now >= claim.lease_expires_at
    || issuance.database_now >= claim.recovery_deadline_at
    || issuance.database_now >= claim.permit_expires_at
    || issuance.revoked_at !== null
    || operation.ordinal !== 14
    || operation.kind !== "disable_controller_deployment"
    || operation.shard_index !== null
  ) {
    throw new ProtocolError("operation_fourteen_source_invalid", 409);
  }
  requireFrozenEnableEvidence(env, claim, issuance, terminal, sendAttempt);
}

function requireExistingSource(
  env: OperationFourteenDisableEnv,
  snapshot: ExecutionClaimSnapshot,
  issuance: IssuanceRow,
  operation: ExecutionOperationRow,
  terminal: OperationFiveTerminalRow,
  sendAttempt: OperationFiveSendAttemptPair,
  attempt: OperationFourteenAttemptRow,
): void {
  const claim = snapshot.claim;
  if (
    claim.inflight_operation_ordinal !== 14
    || claim.inflight_operation_id_sha256 !== attempt.operation_id_sha256
    || claim.inflight_request_sha256
      !== attempt.operation_request_sha256
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || (
      claim.status !== "running"
      && claim.status !== "disable_required"
    )
    || operation.operation_id_sha256 !== attempt.operation_id_sha256
    || attempt.claim_digest_sha256 !== claim.claim_digest_sha256
    || attempt.claim_owner_sha256 !== claim.claim_owner_sha256
    || attempt.execution_plan_sha256 !== claim.execution_plan_sha256
    || attempt.operation_schedule_sha256
      !== claim.operation_schedule_sha256
    || attempt.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || attempt.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
  ) {
    throw new ProtocolError("operation_fourteen_attempt_source_drift", 409);
  }
  requireFrozenEnableEvidence(env, claim, issuance, terminal, sendAttempt);
  if (
    attempt.operation_five_terminal_receipt_sha256
      !== terminal.generic_terminal_receipt_digest_sha256
    || attempt.operation_five_send_attempt_digest_sha256
      !== sendAttempt.attempt.attempt_digest_sha256
    || attempt.controller_service_name !== terminal.controller_service_name
    || attempt.controller_enabled_source_version_id
      !== terminal.controller_enabled_version_id
    || attempt.controller_baseline_target_version_id
      !== sendAttempt.attempt.controller_baseline_version_id
  ) {
    throw new ProtocolError(
      "operation_fourteen_frozen_source_drift",
      409,
    );
  }
}

function requireFrozenEnableEvidence(
  env: OperationFourteenDisableEnv,
  claim: ExecutionClaimSnapshot["claim"],
  issuance: IssuanceRow,
  terminal: OperationFiveTerminalRow,
  sendAttempt: OperationFiveSendAttemptPair,
): void {
  if (
    terminal.authorization_id_sha256 !== claim.authorization_id_sha256
    || terminal.claim_digest_sha256 !== claim.claim_digest_sha256
    || terminal.attempt_digest_sha256
      !== sendAttempt.attempt.attempt_digest_sha256
    || terminal.controller_service_name
      !== sendAttempt.attempt.controller_service_name
    || terminal.controller_enabled_version_id
      !== sendAttempt.attempt.controller_enabled_version_id
    || terminal.authority_database_identity_sha256
      !== claim.authority_database_identity_sha256
    || terminal.authority_ledger_identity_sha256
      !== claim.ledger_identity_sha256
    || sendAttempt.attempt.controller_baseline_version_id
      !== issuance.controller_version_id
    || terminal.controller_service_name
      !== issuance.controller_service_name
    || !VERSION_ID.test(
      env
        .SHARD_PLACEMENT_AUTHORITY_EXPECTED_CONTROLLER_DEPLOYMENT_GATEWAY_VERSION_ID,
    )
  ) {
    throw new ProtocolError(
      "operation_fourteen_enable_evidence_drift",
      409,
    );
  }
}

function requireOperation(
  snapshot: ExecutionClaimSnapshot,
  command: OperationFourteenDisableCommand,
): ExecutionOperationRow {
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === 14,
  );
  if (
    operation === undefined
    || operation.operation_id_sha256 !== command.operationIdSha256
    || operation.kind !== "disable_controller_deployment"
    || operation.shard_index !== null
  ) {
    throw new ProtocolError("operation_fourteen_operation_mismatch", 409);
  }
  return operation;
}

function requireCommandMatchesAttempt(
  command: OperationFourteenDisableCommand,
  attempt: OperationFourteenAttemptRow,
): void {
  if (
    command.authorizationIdSha256 !== attempt.authorization_id_sha256
    || command.claimDigestSha256 !== attempt.claim_digest_sha256
    || command.claimOwnerSha256 !== attempt.claim_owner_sha256
    || command.operationIdSha256 !== attempt.operation_id_sha256
  ) {
    throw new ProtocolError("operation_fourteen_command_conflict", 409);
  }
}

function requireCommandMatchesTerminal(
  command: OperationFourteenDisableCommand,
  terminal: OperationFourteenTerminalRow,
): void {
  if (
    command.authorizationIdSha256 !== terminal.authorization_id_sha256
    || command.claimDigestSha256 !== terminal.claim_digest_sha256
    || command.claimOwnerSha256 !== terminal.claim_owner_sha256
    || command.operationIdSha256 !== terminal.operation_id_sha256
  ) {
    throw new ProtocolError("operation_fourteen_command_conflict", 409);
  }
}

function requireIncomingRole(
  authentication: AuthenticatedRequest,
  mode: "fresh" | "readback",
): void {
  const expected = mode === "fresh" ? "send" : "recovery";
  if (authentication.role !== expected) {
    throw new ProtocolError("operation_fourteen_role_mismatch", 403);
  }
}

function gatewayCommandFromAttempt(
  attempt: OperationFourteenAttemptRow,
): FrozenControllerDisableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    operation14IdSha256: attempt.operation_id_sha256,
    authorityDatabaseIdentitySha256:
      attempt.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      attempt.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256: attempt.ledger_head_before_sha256,
    authorityVersionId: attempt.authority_version_id,
    leaseOwnerSha256: attempt.lease_owner_sha256,
    leaseTokenSha256: attempt.lease_token_sha256,
    leaseGeneration: attempt.lease_generation,
    controllerServiceName: attempt.controller_service_name,
    controllerEnabledSourceVersionId:
      attempt.controller_enabled_source_version_id,
    controllerBaselineTargetVersionId:
      attempt.controller_baseline_target_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
  };
}

function resultFromEvidence(
  result: OperationFourteenDisableResult["result"],
  evidence: OperationFourteenEvidence,
  snapshot: ExecutionClaimSnapshot,
  recoveryAction: OperationFourteenDisableResult["recoveryAction"],
  authorityVersionId: string,
): OperationFourteenDisableResult {
  const attempt = requireAttempt(evidence);
  const last = evidence.gatewayEvents.at(-1);
  if (last === undefined) {
    throw new ProtocolError(
      "operation_fourteen_gateway_evidence_missing",
      409,
    );
  }
  return {
    contract: OPERATION_FOURTEEN_DISABLE_RESULT_CONTRACT,
    result,
    authorizationIdSha256: attempt.authorization_id_sha256,
    claimDigestSha256: attempt.claim_digest_sha256,
    operationIdSha256: attempt.operation_id_sha256,
    attemptDigestSha256: attempt.attempt_digest_sha256,
    operationStartedReceiptSha256:
      attempt.operation_start_receipt_digest_sha256,
    operationTerminalReceiptSha256: null,
    controllerServiceName: attempt.controller_service_name,
    controllerEnabledSourceVersionId:
      attempt.controller_enabled_source_version_id,
    controllerBaselineTargetVersionId:
      attempt.controller_baseline_target_version_id,
    gatewayEventCount: evidence.gatewayEvents.length,
    lastGatewayEventKind:
      last.event_kind as OperationFourteenGatewayEventKind,
    status: snapshot.claim.status,
    receiptCount: snapshot.claim.ledger_version,
    receiptHeadSha256: snapshot.claim.ledger_head_sha256,
    disableConfirmed: snapshot.claim.disable_confirmed === 1,
    recoveryAction,
    authorityVersionId,
  };
}

function resultFromTerminal(
  result: OperationFourteenDisableResult["result"],
  evidence: OperationFourteenEvidence,
  terminal: OperationFourteenTerminalRow,
  authorityVersionId: string,
  claim?: ExecutionClaimSnapshot["claim"],
): OperationFourteenDisableResult {
  const attempt = requireAttempt(evidence);
  const last = evidence.gatewayEvents.at(-1);
  if (last === undefined) {
    throw new ProtocolError(
      "operation_fourteen_gateway_evidence_missing",
      409,
    );
  }
  const success =
    terminal.result_outcome === "exact_success"
    || terminal.result_outcome === "ambiguous_recovered";
  return {
    contract: OPERATION_FOURTEEN_DISABLE_RESULT_CONTRACT,
    result,
    authorizationIdSha256: terminal.authorization_id_sha256,
    claimDigestSha256: terminal.claim_digest_sha256,
    operationIdSha256: terminal.operation_id_sha256,
    attemptDigestSha256: terminal.attempt_digest_sha256,
    operationStartedReceiptSha256:
      terminal.operation_start_receipt_digest_sha256,
    operationTerminalReceiptSha256:
      terminal.generic_terminal_receipt_digest_sha256,
    controllerServiceName: terminal.controller_service_name,
    controllerEnabledSourceVersionId:
      terminal.controller_enabled_source_version_id,
    controllerBaselineTargetVersionId:
      terminal.controller_baseline_target_version_id,
    gatewayEventCount: evidence.gatewayEvents.length,
    lastGatewayEventKind:
      last.event_kind as OperationFourteenGatewayEventKind,
    status: claim?.status ?? (success ? "completed" : "recovery_required"),
    receiptCount:
      claim?.ledger_version ?? terminal.generic_receipt_sequence,
    receiptHeadSha256:
      claim?.ledger_head_sha256
      ?? terminal.generic_terminal_receipt_digest_sha256,
    disableConfirmed:
      claim?.disable_confirmed === 1 || (claim === undefined && success),
    recoveryAction: "none",
    authorityVersionId,
  };
}

function requireAttempt(
  evidence: OperationFourteenEvidence,
): OperationFourteenAttemptRow {
  if (evidence.attempt === null) {
    throw new ProtocolError("operation_fourteen_attempt_missing", 409);
  }
  return evidence.attempt;
}

function createGatewayRequestId(
  attempt: OperationFourteenAttemptRow,
): string {
  return createGatewayRequestIdFromOperation(
    attempt.operation_id_sha256,
  );
}

function createGatewayRequestIdFromOperation(operationId: string): string {
  return `op14-create-${operationId.slice(0, 40)}`;
}

function statusGatewayRequestId(
  attempt: OperationFourteenAttemptRow,
  eventSequence: number,
): string {
  return statusGatewayRequestIdFromOperation(
    attempt.operation_id_sha256,
    eventSequence,
  );
}

function statusGatewayRequestIdFromOperation(
  operationId: string,
  eventSequence: number,
): string {
  return `op14-status-${operationId.slice(0, 32)}-${eventSequence}`;
}

function rowToEvent(
  row: OperationFourteenGatewayEventRow,
): OperationFourteenGatewayEvent {
  return {
    authorizationIdSha256: row.authorization_id_sha256,
    attemptDigestSha256: row.attempt_digest_sha256,
    eventSequence: row.event_sequence,
    eventContract: OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
    eventKind: row.event_kind as OperationFourteenGatewayEventKind,
    dispatchSemantics: OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
    credentialRole: row.credential_role as
      "disable_create" | "disable_status",
    credentialIdSha256: row.credential_id_sha256,
    requestIdSha256: row.request_id_sha256,
    authorityCommandDigestSha256:
      row.authority_command_digest_sha256,
    gatewayCommandDigestSha256: row.gateway_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      row.gateway_idempotency_key_sha256,
    controllerServiceName: row.controller_service_name,
    controllerBaselineTargetVersionId:
      row.controller_baseline_target_version_id,
    expectedGatewayVersionId: row.expected_gateway_version_id,
    observedGatewayVersionId: row.observed_gateway_version_id,
    observedControllerVersionId: row.observed_controller_version_id,
    statusClassification: row.status_classification as
      "target_observed" | "drift_observed" | "unknown" | null,
    gatewayHttpStatus: row.gateway_http_status,
    gatewayResponseSha256: row.gateway_response_sha256,
    gatewayResponseBytes: row.gateway_response_bytes,
    cloudflareRequestIdSha256: row.cloudflare_request_id_sha256,
    deploymentSetSha256: row.deployment_set_sha256,
    observationDigestSha256: row.observation_digest_sha256,
    stabilityMinimumSeconds: row.stability_minimum_seconds,
    predecessorEventDigestSha256: row.predecessor_event_digest_sha256,
    eventDigestSha256: row.event_digest_sha256,
  };
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Hex(encoder.encode(canonicalJson(value)));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index])
  );
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_digest", 400);
  }
  return value;
}

function literal<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_value", 400);
  }
  return expected;
}
