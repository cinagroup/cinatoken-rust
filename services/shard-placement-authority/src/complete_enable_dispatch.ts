import {
  EXECUTION_RECEIPT_CONTRACT,
  requestIdSha256,
  type ExecutionReceipt,
} from "./execution_protocol";
import {
  createOperationFiveTerminal,
  readExactExecutionClaim,
  readExactOperationFiveSendAttemptPair,
  readExactOperationFiveTerminal,
  readOperationFiveGatewayEventChain,
  type ExecutionClaimSnapshot,
  type ExecutionOperationRow,
  type ExecutionReceiptRow,
  type OperationFiveGatewayEventRow,
  type OperationFiveSendAttemptPair,
  type OperationFiveTerminal,
  type OperationFiveTerminalRow,
} from "./execution_repository";
import {
  ProtocolError,
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "./protocol";

export const COMPLETE_ENABLE_DISPATCH_CONTRACT =
  "cinatoken-shard-placement-authority-complete-enable-dispatch-v1";
export const OPERATION_FIVE_TERMINAL_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-terminal-v1";
export const OPERATION_FIVE_TERMINAL_EVIDENCE_CONTRACT =
  "cinatoken-shard-placement-authority-operation-five-terminal-evidence-v1";

const MAX_COMMAND_BYTES = 4 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_FIELDS = [
  "schemaVersion",
  "contract",
  "authorizationIdSha256",
  "claimDigestSha256",
  "claimOwnerSha256",
  "attemptDigestSha256",
  "stableGatewayEventDigestSha256",
  "terminalRequestIdSha256",
] as const;

export interface CompleteEnableDispatchCommand {
  schemaVersion: 1;
  contract: typeof COMPLETE_ENABLE_DISPATCH_CONTRACT;
  authorizationIdSha256: string;
  claimDigestSha256: string;
  claimOwnerSha256: string;
  attemptDigestSha256: string;
  stableGatewayEventDigestSha256: string;
  terminalRequestIdSha256: string;
}

export interface CompleteEnableDispatchEnv {
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED:
    string;
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: string;
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: string;
}

export interface CompleteEnableDispatchResult {
  result: "terminal_recorded" | "exact_replay";
  authorizationIdSha256: string;
  claimDigestSha256: string;
  attemptDigestSha256: string;
  stableGatewayEventSequence: number;
  stableGatewayEventDigestSha256: string;
  observationDigestSha256: string;
  operationFiveStartReceiptSha256: string;
  operationFiveTerminalReceiptSha256: string;
  terminalEvidenceManifestSha256: string;
  controllerServiceName: string;
  controllerEnabledVersionId: string;
  dispatchAuthorityVersionId: string;
  terminalAuthorityVersionId: string;
  gatewayVersionId: string;
  receiptCount: 5;
  receiptHeadSha256: string;
  lastCompletedOrdinal: 5;
  nextOperationOrdinal: 6;
  nextOperationIdSha256: string;
}

export interface CompleteEnableDispatchDependencies {
  readTerminal(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveTerminalRow | null>;
  readClaim(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
    claimOwnerSha256: string,
  ): Promise<ExecutionClaimSnapshot>;
  readAttempt(
    database: D1Database,
    authorizationIdSha256: string,
    claimDigestSha256: string,
  ): Promise<OperationFiveSendAttemptPair | null>;
  readGatewayChain(
    database: D1Database,
    authorizationIdSha256: string,
    attemptDigestSha256: string,
  ): Promise<OperationFiveGatewayEventRow[]>;
  createTerminal(
    database: D1Database,
    terminal: OperationFiveTerminal,
  ): Promise<{
    classification: "created" | "exact_replay";
    terminal: OperationFiveTerminalRow;
    claim: ExecutionClaimSnapshot["claim"];
    receipt: ExecutionReceiptRow;
  }>;
}

const DEFAULT_DEPENDENCIES: CompleteEnableDispatchDependencies = {
  readTerminal: readExactOperationFiveTerminal,
  readClaim: readExactExecutionClaim,
  readAttempt: readExactOperationFiveSendAttemptPair,
  readGatewayChain: readOperationFiveGatewayEventChain,
  createTerminal: createOperationFiveTerminal,
};

export function parseCompleteEnableDispatchCommand(
  body: Uint8Array,
): CompleteEnableDispatchCommand {
  if (body.byteLength > MAX_COMMAND_BYTES) {
    throw new ProtocolError(
      "operation_five_terminal_command_too_large",
      413,
    );
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
  if (!plainObject(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...COMMAND_FIELDS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return {
    schemaVersion: requireLiteral(value.schemaVersion, 1),
    contract: requireLiteral(
      value.contract,
      COMPLETE_ENABLE_DISPATCH_CONTRACT,
    ),
    authorizationIdSha256:
      requireSha256(value.authorizationIdSha256),
    claimDigestSha256: requireSha256(value.claimDigestSha256),
    claimOwnerSha256: requireSha256(value.claimOwnerSha256),
    attemptDigestSha256: requireSha256(value.attemptDigestSha256),
    stableGatewayEventDigestSha256:
      requireSha256(value.stableGatewayEventDigestSha256),
    terminalRequestIdSha256:
      requireSha256(value.terminalRequestIdSha256),
  };
}

export async function completeControllerEnableDispatch(
  env: CompleteEnableDispatchEnv,
  command: CompleteEnableDispatchCommand,
  authentication: AuthenticatedRequest,
  dependencies: CompleteEnableDispatchDependencies =
    DEFAULT_DEPENDENCIES,
): Promise<CompleteEnableDispatchResult> {
  if (authentication.role !== "receipt") {
    throw new ProtocolError(
      "operation_five_terminal_role_mismatch",
      403,
    );
  }
  const terminalRequestIdSha256 =
    await requestIdSha256(authentication.requestId);
  const terminalCommandDigestSha256 =
    await operationFiveTerminalCommandDigest(command);
  const persisted = await dependencies.readTerminal(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (persisted !== null) {
    requireExactReplay(
      persisted,
      command,
      authentication.credentialIdSha256,
      terminalRequestIdSha256,
      terminalCommandDigestSha256,
    );
    return resultFromRow("exact_replay", persisted);
  }
  if (
    env.SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED
      !== "true"
  ) {
    throw new ProtocolError(
      "authority_operation_five_terminal_write_disabled",
      503,
    );
  }

  const snapshot = await dependencies.readClaim(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
    command.claimOwnerSha256,
  );
  const operationFive = requireOperation(snapshot, 5);
  const operationSix = requireOperation(snapshot, 6);
  const started = requireTerminalizableClaim(
    snapshot,
    operationFive,
  );
  const pair = await dependencies.readAttempt(
    env.DB,
    command.authorizationIdSha256,
    command.claimDigestSha256,
  );
  if (pair === null) {
    throw new ProtocolError(
      "operation_five_terminal_attempt_missing",
      409,
    );
  }
  const chain = await dependencies.readGatewayChain(
    env.DB,
    command.authorizationIdSha256,
    command.attemptDigestSha256,
  );
  const stable = requireStableChainHead(command, pair, chain);
  requireTerminalSource(
    env,
    command,
    snapshot,
    operationFive,
    operationSix,
    pair,
    stable,
  );

  const evidence = terminalEvidence(
    command,
    snapshot,
    operationFive,
    operationSix,
    started,
    pair,
    stable,
    authentication.credentialIdSha256,
    terminalRequestIdSha256,
    terminalCommandDigestSha256,
    env.CF_VERSION_METADATA.id,
  );
  const terminalEvidenceManifestSha256 =
    await operationFiveTerminalEvidenceDigest(evidence);
  const executionReceipt =
    await operationFiveTerminalExecutionReceipt(
      snapshot,
      operationFive,
      started,
      stable,
      terminalEvidenceManifestSha256,
    );
  const terminal: OperationFiveTerminal = {
    authorizationIdSha256: command.authorizationIdSha256,
    terminalContract: OPERATION_FIVE_TERMINAL_CONTRACT,
    claimDigestSha256: command.claimDigestSha256,
    claimOwnerSha256: command.claimOwnerSha256,
    leaseOwnerSha256: snapshot.claim.lease_owner_sha256,
    leaseTokenSha256: snapshot.claim.lease_token_sha256,
    leaseGeneration: 1,
    attemptDigestSha256: command.attemptDigestSha256,
    sendStartedEventDigestSha256:
      pair.event.event_digest_sha256,
    stableGatewayEventSequence: stable.event_sequence,
    stableGatewayEventDigestSha256: stable.event_digest_sha256,
    stableGatewayPredecessorEventDigestSha256:
      stable.predecessor_event_digest_sha256,
    stableGatewayRequestIdSha256:
      stable.gateway_request_id_sha256,
    stableGatewayResponseSha256:
      stable.gateway_response_sha256!,
    stableGatewayResponseBytes: stable.gateway_response_bytes!,
    stableObservationDigestSha256:
      stable.observation_digest_sha256!,
    stableStatusResponseRequestIdSha256:
      stable.status_response_request_id_sha256!,
    stableGatewayRecordedAt: stable.gateway_recorded_at!,
    gatewayVersionId: stable.gateway_version_id!,
    deploymentSetSha256: stable.deployment_set_sha256!,
    targetVersionSha256: stable.target_version_sha256!,
    controllerServiceName: pair.attempt.controller_service_name,
    controllerEnabledVersionId:
      pair.attempt.controller_enabled_version_id,
    controllerCommandDigestSha256:
      pair.attempt.controller_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      pair.attempt.gateway_idempotency_key_sha256,
    authorityDatabaseIdentitySha256:
      snapshot.claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      snapshot.claim.ledger_identity_sha256,
    authorityDispatchVersionId: pair.attempt.authority_version_id,
    authorityTerminalVersionId: env.CF_VERSION_METADATA.id,
    operationFiveIdSha256:
      operationFive.operation_id_sha256,
    operationFiveRequestSha256: started.request_sha256,
    operationStartReceiptDigestSha256:
      started.receipt_digest_sha256,
    operationStartCredentialIdSha256:
      started.receipt_credential_id_sha256,
    operationStartRequestIdSha256: started.request_id_sha256,
    admissionConfirmationDigestSha256:
      started.evidence_sha256,
    terminalWriterCredentialIdSha256:
      authentication.credentialIdSha256,
    terminalWriterRequestIdSha256: terminalRequestIdSha256,
    terminalCommandDigestSha256,
    ledgerHeadBeforeSha256: snapshot.claim.ledger_head_sha256,
    ledgerHeadAfterSha256: executionReceipt.receiptDigestSha256,
    terminalEvidenceManifestSha256,
    genericTerminalReceiptDigestSha256:
      executionReceipt.receiptDigestSha256,
    nextOperationOrdinal: 6,
    nextOperationIdSha256: operationSix.operation_id_sha256,
  };
  const created = await dependencies.createTerminal(env.DB, terminal);
  requireTerminalReadback(created, terminal);
  return resultFromRow(created.classification, created.terminal);
}

export async function operationFiveTerminalEvidenceDigest(
  evidence: ReturnType<typeof terminalEvidence>,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(evidence)),
  );
}

export async function operationFiveTerminalCommandDigest(
  command: CompleteEnableDispatchCommand,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(command)),
  );
}

async function operationFiveTerminalExecutionReceipt(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
  started: ExecutionReceiptRow,
  stable: OperationFiveGatewayEventRow,
  terminalEvidenceManifestSha256: string,
): Promise<ExecutionReceipt> {
  const receipt: Omit<ExecutionReceipt, "receiptDigestSha256"> = {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_terminal",
    authorizationIdSha256:
      snapshot.claim.authorization_id_sha256,
    claimDigestSha256: snapshot.claim.claim_digest_sha256,
    executionPlanSha256:
      snapshot.claim.execution_plan_sha256,
    ledgerIdentitySha256: snapshot.claim.ledger_identity_sha256,
    sequence: 5,
    predecessorReceiptSha256: started.receipt_digest_sha256,
    leaseGeneration: snapshot.claim.lease_generation,
    leaseTokenSha256: snapshot.claim.lease_token_sha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: started.lease_owner_sha256,
    actorCredentialIdSha256:
      started.receipt_credential_id_sha256,
    requestIdSha256: started.request_id_sha256,
    operationOrdinal: 5,
    operationIdSha256: operation.operation_id_sha256,
    operationKind: "enable_controller_deployment",
    shardIndex: null,
    outcome: "exact_success",
    requestSha256: started.request_sha256,
    responseSha256: terminalEvidenceManifestSha256,
    evidenceSha256: started.evidence_sha256,
    cloudflareRequestIdSha256:
      stable.status_response_request_id_sha256,
    safetyReason: null,
  };
  return {
    ...receipt,
    receiptDigestSha256: await sha256Hex(
      new TextEncoder().encode(canonicalJson(receipt)),
    ),
  };
}

function terminalEvidence(
  command: CompleteEnableDispatchCommand,
  snapshot: ExecutionClaimSnapshot,
  operationFive: ExecutionOperationRow,
  operationSix: ExecutionOperationRow,
  started: ExecutionReceiptRow,
  pair: OperationFiveSendAttemptPair,
  stable: OperationFiveGatewayEventRow,
  terminalCredentialIdSha256: string,
  terminalRequestIdSha256: string,
  terminalCommandDigestSha256: string,
  terminalAuthorityVersionId: string,
) {
  return {
    schemaVersion: 1,
    contract: OPERATION_FIVE_TERMINAL_EVIDENCE_CONTRACT,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    claimOwnerSha256: command.claimOwnerSha256,
    authorityDatabaseIdentitySha256:
      snapshot.claim.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      snapshot.claim.ledger_identity_sha256,
    authorityLedgerHeadBeforeSha256:
      snapshot.claim.ledger_head_sha256,
    operationFiveOperationIdSha256:
      operationFive.operation_id_sha256,
    operationFiveStartReceiptSha256:
      started.receipt_digest_sha256,
    operationFiveRequestSha256: started.request_sha256,
    operationFiveEvidenceSha256: started.evidence_sha256,
    attemptDigestSha256: pair.attempt.attempt_digest_sha256,
    sendStartedEventDigestSha256:
      pair.event.event_digest_sha256,
    stableGatewayEventSequence: stable.event_sequence,
    stableGatewayEventDigestSha256: stable.event_digest_sha256,
    stableGatewayPredecessorEventDigestSha256:
      stable.predecessor_event_digest_sha256,
    gatewayResponseSha256: stable.gateway_response_sha256,
    gatewayResponseBytes: stable.gateway_response_bytes,
    gatewayVersionId: stable.gateway_version_id,
    statusClassification: stable.status_classification,
    deploymentsHttpStatus: stable.deployments_http_status,
    versionHttpStatus: stable.version_http_status,
    deploymentSetSha256: stable.deployment_set_sha256,
    targetVersionSha256: stable.target_version_sha256,
    statusResponseRequestIdSha256:
      stable.status_response_request_id_sha256,
    observationDigestSha256: stable.observation_digest_sha256,
    gatewayRecordedAt: stable.gateway_recorded_at,
    requiredMatchingObservations:
      stable.required_matching_observations,
    stabilityMinimumSeconds: stable.stability_minimum_seconds,
    stabilityPredecessorObservationDigestSha256:
      stable.stability_predecessor_observation_digest_sha256,
    stabilityPredecessorRecordedAt:
      stable.stability_predecessor_recorded_at,
    controllerServiceName: pair.attempt.controller_service_name,
    controllerEnabledVersionId:
      pair.attempt.controller_enabled_version_id,
    controllerCommandDigestSha256:
      pair.attempt.controller_command_digest_sha256,
    gatewayIdempotencyKeySha256:
      pair.attempt.gateway_idempotency_key_sha256,
    dispatchAuthorityVersionId: pair.attempt.authority_version_id,
    terminalAuthorityVersionId,
    terminalCredentialIdSha256,
    terminalRequestIdSha256,
    commandTerminalRequestIdSha256:
      command.terminalRequestIdSha256,
    terminalCommandDigestSha256,
    nextOperationOrdinal: 6,
    nextOperationIdSha256: operationSix.operation_id_sha256,
  } as const;
}

function requireOperation(
  snapshot: ExecutionClaimSnapshot,
  ordinal: 5 | 6,
): ExecutionOperationRow {
  const operation = snapshot.operations.find(
    (candidate) => candidate.ordinal === ordinal,
  );
  const expectedKind = ordinal === 5
    ? "enable_controller_deployment"
    : "probe_shard_readiness";
  if (
    operation === undefined
    || operation.kind !== expectedKind
    || (ordinal === 5
      ? operation.shard_index !== null
      : operation.shard_index !== 0)
  ) {
    throw new ProtocolError(
      "operation_five_terminal_schedule_mismatch",
      409,
    );
  }
  return operation;
}

function requireTerminalizableClaim(
  snapshot: ExecutionClaimSnapshot,
  operation: ExecutionOperationRow,
): ExecutionReceiptRow {
  const claim = snapshot.claim;
  const now = Math.floor(Date.now() / 1_000);
  const started = snapshot.receipts.find(
    (candidate) =>
      candidate.event_kind === "operation_started"
      && candidate.operation_ordinal === 5,
  );
  if (
    claim.status !== "running"
    || claim.ledger_version !== 4
    || claim.ledger_head_sha256
      !== started?.receipt_digest_sha256
    || claim.last_completed_ordinal !== 4
    || claim.inflight_operation_ordinal !== 5
    || claim.inflight_operation_id_sha256
      !== operation.operation_id_sha256
    || claim.inflight_request_sha256 !== started?.request_sha256
    || claim.inflight_readback_only !== 0
    || claim.lease_generation !== 1
    || claim.lease_owner_sha256 !== claim.claim_owner_sha256
    || claim.renewal_count !== 0
    || claim.takeover_count !== 0
    || claim.enable_intent_seen !== 1
    || claim.disable_confirmed !== 0
    || claim.ticket_activation_confirmed !== 1
    || claim.application_activation_digest_sha256 === null
    || claim.lease_expires_at <= now
    || claim.normal_deadline_at <= now
    || claim.recovery_deadline_at <= now
    || claim.permit_expires_at <= now
    || snapshot.receipts.length !== 4
    || started === undefined
    || started.sequence !== 4
    || started.operation_id_sha256 !== operation.operation_id_sha256
    || started.operation_kind !== "enable_controller_deployment"
    || started.shard_index !== null
    || started.response_sha256 !== null
    || started.cloudflare_request_id_sha256 !== null
    || started.safety_reason !== null
    || started.outcome !== "pending"
  ) {
    throw new ProtocolError(
      "operation_five_terminal_claim_not_ready",
      409,
    );
  }
  return started;
}

function requireStableChainHead(
  command: CompleteEnableDispatchCommand,
  pair: OperationFiveSendAttemptPair,
  chain: OperationFiveGatewayEventRow[],
): OperationFiveGatewayEventRow {
  if (
    chain.length < 3
    || chain[0]?.event_sequence !== 2
    || chain[0].event_kind !== "gateway_create_dispatched"
    || chain[0].predecessor_event_digest_sha256
      !== pair.event.event_digest_sha256
    || chain.some(
      (event, index) =>
        event.event_sequence !== index + 2
        || (
          index > 0
          && event.predecessor_event_digest_sha256
            !== chain[index - 1]?.event_digest_sha256
        ),
    )
  ) {
    throw new ProtocolError(
      "operation_five_terminal_gateway_chain_unavailable",
      503,
    );
  }
  const stable = chain.at(-1)!;
  const predecessor = chain.at(-2)!;
  if (
    stable.event_kind !== "gateway_status_stable"
    || stable.event_digest_sha256
      !== command.stableGatewayEventDigestSha256
    || stable.status_classification !== "target_observed"
    || stable.target_stable !== 1
    || stable.required_matching_observations !== 2
    || stable.stability_minimum_seconds === null
    || stable.stability_minimum_seconds < 5
    || stable.stability_minimum_seconds > 120
    || stable.observation_digest_sha256 === null
    || stable.stability_predecessor_observation_digest_sha256
      !== predecessor.observation_digest_sha256
    || stable.observation_digest_sha256
      !== predecessor.observation_digest_sha256
    || stable.stability_predecessor_recorded_at
      !== predecessor.gateway_recorded_at
    || stable.gateway_recorded_at === null
    || predecessor.gateway_recorded_at === null
    || stable.gateway_recorded_at - predecessor.gateway_recorded_at
      < stable.stability_minimum_seconds
    || predecessor.status_classification !== "target_observed"
    || predecessor.gateway_credential_role !== "status"
    || stable.gateway_credential_role !== "status"
    || predecessor.gateway_request_id_sha256
      === stable.gateway_request_id_sha256
    || predecessor.status_response_request_id_sha256
      === stable.status_response_request_id_sha256
  ) {
    throw new ProtocolError(
      "operation_five_terminal_stable_evidence_mismatch",
      409,
    );
  }
  return stable;
}

function requireTerminalSource(
  env: CompleteEnableDispatchEnv,
  command: CompleteEnableDispatchCommand,
  snapshot: ExecutionClaimSnapshot,
  operationFive: ExecutionOperationRow,
  operationSix: ExecutionOperationRow,
  pair: OperationFiveSendAttemptPair,
  stable: OperationFiveGatewayEventRow,
): void {
  const attempt = pair.attempt;
  if (
    attempt.authorization_id_sha256
      !== command.authorizationIdSha256
    || attempt.claim_digest_sha256 !== command.claimDigestSha256
    || attempt.dispatch_owner_sha256 !== command.claimOwnerSha256
    || attempt.attempt_digest_sha256 !== command.attemptDigestSha256
    || pair.event.authorization_id_sha256
      !== command.authorizationIdSha256
    || pair.event.attempt_digest_sha256
      !== command.attemptDigestSha256
    || stable.authorization_id_sha256
      !== command.authorizationIdSha256
    || stable.attempt_digest_sha256
      !== command.attemptDigestSha256
    || stable.send_started_event_digest_sha256
      !== pair.event.event_digest_sha256
    || stable.gateway_idempotency_key_sha256
      !== attempt.gateway_idempotency_key_sha256
    || stable.controller_command_digest_sha256
      !== attempt.controller_command_digest_sha256
    || stable.gateway_response_sha256 === null
    || stable.gateway_response_bytes === null
    || stable.gateway_response_bytes <= 0
    || stable.gateway_version_id === null
    || stable.deployments_http_status === null
    || stable.deployments_http_status < 200
    || stable.deployments_http_status > 299
    || stable.version_http_status === null
    || stable.version_http_status < 200
    || stable.version_http_status > 299
    || stable.deployment_set_sha256 === null
    || stable.target_version_sha256 === null
    || stable.status_response_request_id_sha256 === null
    || attempt.controller_service_name.length === 0
    || attempt.controller_enabled_version_id.length === 0
    || attempt.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || attempt.authority_ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || snapshot.claim.authority_database_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256
    || snapshot.claim.ledger_identity_sha256
      !== env.SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256
    || attempt.authority_ledger_head_sha256
      !== snapshot.claim.ledger_head_sha256
    || attempt.controller_enable_operation_id_sha256
      !== operationFive.operation_id_sha256
    || operationSix.ordinal !== 6
    || attempt.authority_version_id
      !== env.CF_VERSION_METADATA.id
  ) {
    throw new ProtocolError(
      "operation_five_terminal_source_mismatch",
      409,
    );
  }
}

function requireExactReplay(
  row: OperationFiveTerminalRow,
  command: CompleteEnableDispatchCommand,
  credentialIdSha256: string,
  terminalRequestIdSha256: string,
  terminalCommandDigestSha256: string,
): void {
  if (
    row.contract_version !== 1
    || row.terminal_contract !== OPERATION_FIVE_TERMINAL_CONTRACT
    || row.authorization_id_sha256
      !== command.authorizationIdSha256
    || row.claim_digest_sha256 !== command.claimDigestSha256
    || row.claim_owner_sha256 !== command.claimOwnerSha256
    || row.attempt_digest_sha256 !== command.attemptDigestSha256
    || row.stable_gateway_event_digest_sha256
      !== command.stableGatewayEventDigestSha256
    || row.terminal_writer_credential_id_sha256
      !== credentialIdSha256
    || row.terminal_writer_request_id_sha256
      !== terminalRequestIdSha256
    || row.terminal_command_digest_sha256
      !== terminalCommandDigestSha256
  ) {
    throw new ProtocolError(
      "operation_five_terminal_replay_mismatch",
      409,
    );
  }
}

function requireTerminalReadback(
  result: Awaited<
    ReturnType<CompleteEnableDispatchDependencies["createTerminal"]>
  >,
  terminal: OperationFiveTerminal,
): void {
  if (
    result.terminal.generic_terminal_receipt_digest_sha256
      !== terminal.genericTerminalReceiptDigestSha256
    || result.terminal.ledger_head_after_sha256
      !== terminal.ledgerHeadAfterSha256
    || result.claim.status !== "running"
    || result.claim.ledger_version !== 5
    || result.claim.ledger_head_sha256
      !== terminal.genericTerminalReceiptDigestSha256
    || result.claim.last_completed_ordinal !== 5
    || result.claim.inflight_operation_ordinal !== null
    || result.receipt.sequence !== 5
    || result.receipt.receipt_digest_sha256
      !== terminal.genericTerminalReceiptDigestSha256
  ) {
    throw new ProtocolError(
      "operation_five_terminal_readback_mismatch",
      503,
    );
  }
}

function resultFromRow(
  classification: "created" | "exact_replay",
  row: OperationFiveTerminalRow,
): CompleteEnableDispatchResult {
  return {
    result: classification === "created"
      ? "terminal_recorded"
      : "exact_replay",
    authorizationIdSha256: row.authorization_id_sha256,
    claimDigestSha256: row.claim_digest_sha256,
    attemptDigestSha256: row.attempt_digest_sha256,
    stableGatewayEventSequence:
      row.stable_gateway_event_sequence,
    stableGatewayEventDigestSha256:
      row.stable_gateway_event_digest_sha256,
    observationDigestSha256:
      row.stable_observation_digest_sha256,
    operationFiveStartReceiptSha256:
      row.operation_start_receipt_digest_sha256,
    operationFiveTerminalReceiptSha256:
      row.generic_terminal_receipt_digest_sha256,
    terminalEvidenceManifestSha256:
      row.terminal_evidence_manifest_sha256,
    controllerServiceName: row.controller_service_name,
    controllerEnabledVersionId:
      row.controller_enabled_version_id,
    dispatchAuthorityVersionId:
      row.authority_dispatch_version_id,
    terminalAuthorityVersionId:
      row.authority_terminal_version_id,
    gatewayVersionId: row.gateway_version_id,
    receiptCount: 5,
    receiptHeadSha256:
      row.generic_terminal_receipt_digest_sha256,
    lastCompletedOrdinal: 5,
    nextOperationOrdinal: 6,
    nextOperationIdSha256: row.next_operation_id_sha256,
  };
}

function plainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
): T {
  if (value !== expected) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return expected;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ProtocolError("invalid_shape", 400);
  }
  return value;
}
