import { describe, expect, it } from "vitest";

import type {
  ExecutionClaimRow,
  ExecutionReceiptRow,
} from "../src/execution_repository";
import {
  OPERATION_FOURTEEN_ATTEMPT_CONTRACT,
  OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
  OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
  appendOperationFourteenGatewayEvent,
  createOperationFourteenAttemptTriple,
  operationFourteenRepositorySqlForTest,
  type OperationFourteenAttempt,
  type OperationFourteenAttemptRow,
  type OperationFourteenGatewayEvent,
  type OperationFourteenGatewayEventRow,
} from "../src/operation_fourteen_repository";
import {
  EXECUTION_RECEIPT_CONTRACT,
  type ExecutionReceipt,
} from "../src/execution_protocol";
import {
  RepositoryConflictError,
  RepositoryUnavailableError,
} from "../src/repository";

describe("operation fourteen repository", () => {
  it("creates the attempt, start receipt, and dispatch evidence atomically", async () => {
    const fixture = repositoryFixture("created");

    const result = await createOperationFourteenAttemptTriple(
      fixture.database,
      fixture.attempt,
      fixture.receipt,
      fixture.dispatch,
    );

    expect(result.classification).toBe("created");
    expect(result.claim).toMatchObject({
      ledger_version: 22,
      inflight_operation_ordinal: 14,
      inflight_operation_id_sha256:
        fixture.attempt.operationIdSha256,
    });
    expect(fixture.sessionBookmarks).toEqual(["first-primary"]);
    expect(fixture.batchSql).toEqual([
      operationFourteenRepositorySqlForTest.insertAttempt,
      operationFourteenRepositorySqlForTest.insertReceipt,
      operationFourteenRepositorySqlForTest.insertGatewayEvent,
    ]);
  });

  it("classifies an exact persisted triple as replay after a rejected batch", async () => {
    const fixture = repositoryFixture("throw", true);

    const result = await createOperationFourteenAttemptTriple(
      fixture.database,
      fixture.attempt,
      fixture.receipt,
      fixture.dispatch,
    );

    expect(result.classification).toBe("exact_replay");
    expect(result.dispatchEvent.event_kind).toBe("disable_dispatched");
  });

  it("rejects a non-exact persisted triple as conflict", async () => {
    const fixture = repositoryFixture("throw", true);
    fixture.rows.attempt = {
      ...fixture.rows.attempt!,
      controller_service_name: "different-controller",
    };

    await expect(createOperationFourteenAttemptTriple(
      fixture.database,
      fixture.attempt,
      fixture.receipt,
      fixture.dispatch,
    )).rejects.toEqual(expect.objectContaining({
      name: RepositoryConflictError.name,
      code: "operation_fourteen_attempt_conflict",
    }));
  });

  it("reports an unknown batch outcome when exact evidence is absent", async () => {
    const fixture = repositoryFixture("unknown");

    await expect(createOperationFourteenAttemptTriple(
      fixture.database,
      fixture.attempt,
      fixture.receipt,
      fixture.dispatch,
    )).rejects.toEqual(expect.objectContaining({
      name: RepositoryUnavailableError.name,
      outcomeUnknown: true,
    }));
  });

  it("appends later gateway evidence and replays it exactly", async () => {
    const fixture = repositoryFixture("throw", true);
    const accepted: OperationFourteenGatewayEvent = {
      ...fixture.dispatch,
      eventSequence: 2,
      eventKind: "mutation_unknown",
      requestIdSha256: digest("e"),
      predecessorEventDigestSha256:
        fixture.dispatch.eventDigestSha256,
      eventDigestSha256: digest("f"),
    };
    fixture.rows.gatewayEvents.set(2, gatewayEventRow(accepted));

    const result = await appendOperationFourteenGatewayEvent(
      fixture.database,
      accepted,
    );

    expect(result).toMatchObject({
      classification: "exact_replay",
      event: {
        event_sequence: 2,
        event_kind: "mutation_unknown",
      },
    });
  });
});

function repositoryFixture(
  mode: "created" | "throw" | "unknown",
  preseed = false,
) {
  const attempt = operationFourteenAttempt();
  const receipt = operationFourteenStartReceipt(attempt);
  const dispatch = disableDispatchedEvent(attempt);
  const rows: FakeRows = {
    attempt: preseed ? attemptRow(attempt) : null,
    receipts: new Map(
      preseed ? [[receipt.sequence, receiptRow(receipt)]] : [],
    ),
    gatewayEvents: new Map(
      preseed ? [[1, gatewayEventRow(dispatch)]] : [],
    ),
    claim: startedClaim(attempt, receipt),
  };
  const sessionBookmarks: string[] = [];
  const batchSql: string[] = [];
  const fake = new FakeD1(
    mode,
    rows,
    sessionBookmarks,
    batchSql,
    () => {
      rows.attempt = attemptRow(attempt);
      rows.receipts.set(receipt.sequence, receiptRow(receipt));
      rows.gatewayEvents.set(1, gatewayEventRow(dispatch));
    },
  );
  return {
    attempt,
    receipt,
    dispatch,
    rows,
    sessionBookmarks,
    batchSql,
    database: fake as unknown as D1Database,
  };
}

function operationFourteenAttempt(): OperationFourteenAttempt {
  return {
    authorizationIdSha256: digest("1"),
    attemptContract: OPERATION_FOURTEEN_ATTEMPT_CONTRACT,
    claimDigestSha256: digest("2"),
    claimOwnerSha256: digest("3"),
    leaseOwnerSha256: digest("4"),
    leaseTokenSha256: digest("5"),
    leaseGeneration: 1,
    executionPlanSha256: digest("6"),
    operationScheduleSha256: digest("7"),
    authorityDatabaseIdentitySha256: digest("8"),
    authorityLedgerIdentitySha256: digest("9"),
    ledgerVersionBefore: 21,
    ledgerHeadBeforeSha256: digest("a"),
    operationStartSequence: 22,
    operationFiveTerminalReceiptSha256: digest("b"),
    operationFiveSendAttemptDigestSha256: digest("c"),
    operationIdSha256: digest("d"),
    operationRequestSha256: digest("e"),
    controllerServiceName: "controller-staging",
    controllerEnabledSourceVersionId: "controller-enabled-v1",
    controllerBaselineTargetVersionId: "controller-disabled-v1",
    authorityCommandContract:
      "cinatoken-shard-placement-authority-disable-command-v1",
    authorityCommandDigestSha256: digest("f"),
    gatewayCommandContract:
      "cinatoken-controller-deployment-gateway-disable-command-v1",
    gatewayCommandDigestSha256: digest("0"),
    gatewayIdempotencyContract:
      "cinatoken-controller-deployment-gateway-disable-idempotency-v1",
    gatewayIdempotencyKeySha256: digest("1"),
    gatewayCreateCredentialIdSha256: digest("2"),
    gatewayCreateRequestIdSha256: digest("3"),
    gatewayStatusCredentialIdSha256: digest("4"),
    gatewayStatusRequestIdSha256: digest("5"),
    authorityVersionId: "authority-v1",
    expectedGatewayVersionId: "gateway-v1",
    disableDeadlineAt: 1_750_000_600,
    attemptDigestSha256: digest("6"),
    operationStartReceiptDigestSha256: digest("7"),
    disableDispatchedEventDigestSha256: digest("8"),
  };
}

function operationFourteenStartReceipt(
  attempt: OperationFourteenAttempt,
): ExecutionReceipt {
  return {
    schemaVersion: 1,
    contract: EXECUTION_RECEIPT_CONTRACT,
    eventKind: "operation_started",
    authorizationIdSha256: attempt.authorizationIdSha256,
    claimDigestSha256: attempt.claimDigestSha256,
    executionPlanSha256: attempt.executionPlanSha256,
    ledgerIdentitySha256: attempt.authorityLedgerIdentitySha256,
    sequence: attempt.operationStartSequence,
    predecessorReceiptSha256: attempt.ledgerHeadBeforeSha256,
    leaseGeneration: attempt.leaseGeneration,
    leaseTokenSha256: attempt.leaseTokenSha256,
    leaseDurationSeconds: null,
    actorOwnerSha256: attempt.leaseOwnerSha256,
    actorCredentialIdSha256:
      attempt.gatewayCreateCredentialIdSha256,
    requestIdSha256: attempt.gatewayCreateRequestIdSha256,
    operationOrdinal: 14,
    operationIdSha256: attempt.operationIdSha256,
    operationKind: "disable_controller_deployment",
    shardIndex: null,
    outcome: "pending",
    requestSha256: attempt.operationRequestSha256,
    responseSha256: null,
    evidenceSha256: attempt.attemptDigestSha256,
    cloudflareRequestIdSha256: null,
    safetyReason: null,
    receiptDigestSha256:
      attempt.operationStartReceiptDigestSha256,
  };
}

function disableDispatchedEvent(
  attempt: OperationFourteenAttempt,
): OperationFourteenGatewayEvent {
  return {
    authorizationIdSha256: attempt.authorizationIdSha256,
    attemptDigestSha256: attempt.attemptDigestSha256,
    eventSequence: 1,
    eventContract: OPERATION_FOURTEEN_GATEWAY_EVENT_CONTRACT,
    eventKind: "disable_dispatched",
    dispatchSemantics: OPERATION_FOURTEEN_DISPATCH_SEMANTICS,
    credentialRole: "disable_create",
    credentialIdSha256:
      attempt.gatewayCreateCredentialIdSha256,
    requestIdSha256: attempt.gatewayCreateRequestIdSha256,
    authorityCommandDigestSha256:
      attempt.authorityCommandDigestSha256,
    gatewayCommandDigestSha256: attempt.gatewayCommandDigestSha256,
    gatewayIdempotencyKeySha256:
      attempt.gatewayIdempotencyKeySha256,
    controllerServiceName: attempt.controllerServiceName,
    controllerBaselineTargetVersionId:
      attempt.controllerBaselineTargetVersionId,
    expectedGatewayVersionId: attempt.expectedGatewayVersionId,
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
    predecessorEventDigestSha256: attempt.attemptDigestSha256,
    eventDigestSha256: digest("8"),
  };
}

function attemptRow(
  value: OperationFourteenAttempt,
): OperationFourteenAttemptRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    operation_ordinal: 14,
    contract_version: 1,
    attempt_contract: value.attemptContract,
    claim_digest_sha256: value.claimDigestSha256,
    claim_owner_sha256: value.claimOwnerSha256,
    lease_owner_sha256: value.leaseOwnerSha256,
    lease_token_sha256: value.leaseTokenSha256,
    lease_generation: value.leaseGeneration,
    execution_plan_sha256: value.executionPlanSha256,
    operation_schedule_sha256: value.operationScheduleSha256,
    authority_database_identity_sha256:
      value.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      value.authorityLedgerIdentitySha256,
    ledger_version_before: value.ledgerVersionBefore,
    ledger_head_before_sha256: value.ledgerHeadBeforeSha256,
    operation_start_sequence: value.operationStartSequence,
    operation_five_terminal_receipt_sha256:
      value.operationFiveTerminalReceiptSha256,
    operation_five_send_attempt_digest_sha256:
      value.operationFiveSendAttemptDigestSha256,
    operation_id_sha256: value.operationIdSha256,
    operation_request_sha256: value.operationRequestSha256,
    controller_service_name: value.controllerServiceName,
    controller_enabled_source_version_id:
      value.controllerEnabledSourceVersionId,
    controller_baseline_target_version_id:
      value.controllerBaselineTargetVersionId,
    authority_command_contract: value.authorityCommandContract,
    authority_command_digest_sha256:
      value.authorityCommandDigestSha256,
    gateway_command_contract: value.gatewayCommandContract,
    gateway_command_digest_sha256: value.gatewayCommandDigestSha256,
    gateway_idempotency_contract: value.gatewayIdempotencyContract,
    gateway_idempotency_key_sha256:
      value.gatewayIdempotencyKeySha256,
    gateway_create_credential_id_sha256:
      value.gatewayCreateCredentialIdSha256,
    gateway_create_request_id_sha256:
      value.gatewayCreateRequestIdSha256,
    gateway_status_credential_id_sha256:
      value.gatewayStatusCredentialIdSha256,
    gateway_status_request_id_sha256:
      value.gatewayStatusRequestIdSha256,
    authority_version_id: value.authorityVersionId,
    expected_gateway_version_id: value.expectedGatewayVersionId,
    disable_deadline_at: value.disableDeadlineAt,
    mutation_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    attempt_digest_sha256: value.attemptDigestSha256,
    operation_start_receipt_digest_sha256:
      value.operationStartReceiptDigestSha256,
    disable_dispatched_event_digest_sha256:
      value.disableDispatchedEventDigestSha256,
    recorded_at: 1_750_000_000,
  };
}

function gatewayEventRow(
  value: OperationFourteenGatewayEvent,
): OperationFourteenGatewayEventRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    attempt_digest_sha256: value.attemptDigestSha256,
    event_sequence: value.eventSequence,
    contract_version: 1,
    event_contract: value.eventContract,
    event_kind: value.eventKind,
    dispatch_semantics: value.dispatchSemantics,
    credential_role: value.credentialRole,
    credential_id_sha256: value.credentialIdSha256,
    request_id_sha256: value.requestIdSha256,
    authority_command_digest_sha256:
      value.authorityCommandDigestSha256,
    gateway_command_digest_sha256: value.gatewayCommandDigestSha256,
    gateway_idempotency_key_sha256:
      value.gatewayIdempotencyKeySha256,
    controller_service_name: value.controllerServiceName,
    controller_baseline_target_version_id:
      value.controllerBaselineTargetVersionId,
    expected_gateway_version_id: value.expectedGatewayVersionId,
    observed_gateway_version_id: value.observedGatewayVersionId,
    observed_controller_version_id:
      value.observedControllerVersionId,
    status_classification: value.statusClassification,
    gateway_http_status: value.gatewayHttpStatus,
    gateway_response_sha256: value.gatewayResponseSha256,
    gateway_response_bytes: value.gatewayResponseBytes,
    cloudflare_request_id_sha256:
      value.cloudflareRequestIdSha256,
    deployment_set_sha256: value.deploymentSetSha256,
    observation_digest_sha256: value.observationDigestSha256,
    stability_minimum_seconds: value.stabilityMinimumSeconds,
    predecessor_event_digest_sha256:
      value.predecessorEventDigestSha256,
    event_digest_sha256: value.eventDigestSha256,
    recorded_at: 1_750_000_000,
  };
}

function receiptRow(value: ExecutionReceipt): ExecutionReceiptRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    sequence: value.sequence,
    event_kind: value.eventKind,
    claim_digest_sha256: value.claimDigestSha256,
    execution_plan_sha256: value.executionPlanSha256,
    ledger_identity_sha256: value.ledgerIdentitySha256,
    operation_ordinal: value.operationOrdinal,
    operation_id_sha256: value.operationIdSha256,
    operation_kind: value.operationKind,
    shard_index: value.shardIndex,
    predecessor_receipt_sha256: value.predecessorReceiptSha256,
    request_sha256: value.requestSha256,
    response_sha256: value.responseSha256,
    cloudflare_request_id_sha256:
      value.cloudflareRequestIdSha256,
    evidence_sha256: value.evidenceSha256,
    safety_reason: value.safetyReason,
    outcome: value.outcome,
    lease_owner_sha256: value.actorOwnerSha256,
    lease_token_sha256: value.leaseTokenSha256,
    lease_generation: value.leaseGeneration,
    lease_expires_at: 1_750_000_600,
    receipt_credential_id_sha256: value.actorCredentialIdSha256,
    request_id_sha256: value.requestIdSha256,
    receipt_digest_sha256: value.receiptDigestSha256,
    recorded_at: 1_750_000_000,
  };
}

function startedClaim(
  attempt: OperationFourteenAttempt,
  receipt: ExecutionReceipt,
): ExecutionClaimRow {
  return {
    authorization_id_sha256: attempt.authorizationIdSha256,
    claim_digest_sha256: attempt.claimDigestSha256,
    claim_owner_sha256: attempt.claimOwnerSha256,
    ledger_version: receipt.sequence,
    ledger_head_sha256: receipt.receiptDigestSha256,
    inflight_operation_ordinal: 14,
    inflight_operation_id_sha256: attempt.operationIdSha256,
    inflight_request_sha256: attempt.operationRequestSha256,
  } as ExecutionClaimRow;
}

interface FakeRows {
  attempt: OperationFourteenAttemptRow | null;
  receipts: Map<number, ExecutionReceiptRow>;
  gatewayEvents: Map<number, OperationFourteenGatewayEventRow>;
  claim: ExecutionClaimRow;
}

class FakeD1 {
  constructor(
    private readonly mode: "created" | "throw" | "unknown",
    private readonly rows: FakeRows,
    private readonly bookmarks: string[],
    private readonly batchSql: string[],
    private readonly applyBatch: () => void,
  ) {}

  withSession(bookmark: string): FakeSession {
    this.bookmarks.push(bookmark);
    return new FakeSession(this);
  }

  async runBatch(
    statements: FakeStatement[],
  ): Promise<D1Result<unknown>[]> {
    this.batchSql.splice(
      0,
      this.batchSql.length,
      ...statements.map((statement) => statement.sql),
    );
    if (this.mode === "throw") {
      throw new Error("batch_rejected");
    }
    if (this.mode === "unknown") {
      return statements.map(() => ({
        success: true,
        meta: { changes: 0 },
        results: [],
      })) as D1Result<unknown>[];
    }
    this.applyBatch();
    return statements.map(() => ({
      success: true,
      meta: { changes: 1 },
      results: [],
    })) as D1Result<unknown>[];
  }

  read(sql: string, bindings: unknown[]): unknown {
    const repositorySql = operationFourteenRepositorySqlForTest;
    if (sql === repositorySql.selectAttempt) {
      return this.rows.attempt;
    }
    if (sql === repositorySql.selectReceipt) {
      return this.rows.receipts.get(bindings[1] as number) ?? null;
    }
    if (sql === repositorySql.selectGatewayEvent) {
      return this.rows.gatewayEvents.get(bindings[1] as number) ?? null;
    }
    if (sql === repositorySql.selectClaim) {
      return this.rows.claim;
    }
    return null;
  }
}

class FakeSession {
  constructor(private readonly database: FakeD1) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.database, sql);
  }

  batch(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<unknown>[]> {
    return this.database.runBatch(
      statements as unknown as FakeStatement[],
    );
  }
}

class FakeStatement {
  constructor(
    private readonly database: FakeD1,
    readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return this.database.read(this.sql, this.bindings) as T | null;
  }
}

function digest(value: string): string {
  return value.repeat(64);
}
