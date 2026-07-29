import { describe, expect, it } from "vitest";

import {
  COMPLETE_ENABLE_DISPATCH_CONTRACT,
  completeControllerEnableDispatch,
  parseCompleteEnableDispatchCommand,
  type CompleteEnableDispatchCommand,
  type CompleteEnableDispatchDependencies,
  type CompleteEnableDispatchEnv,
} from "../src/complete_enable_dispatch";
import {
  type ExecutionClaimSnapshot,
  type ExecutionReceiptRow,
  type OperationFiveGatewayEventRow,
  type OperationFiveSendAttemptPair,
  type OperationFiveTerminal,
  type OperationFiveTerminalRow,
} from "../src/execution_repository";
import {
  authorityRoutingForTest,
  type AuthorityEnv,
} from "../src/index";
import { canonicalJson, type AuthenticatedRequest } from "../src/protocol";

const now = Math.floor(Date.now() / 1_000);
const authorizationId = hex("a");
const claimDigest = hex("b");
const claimOwner = hex("c");
const attemptDigest = hex("d");
const stableDigest = hex("e");
const operationFiveId = hex("5");
const operationSixId = hex("6");
const operationStartReceipt = hex("4");
const observationDigest = hex("7");
const authorityVersion = "authority-version-v1";
const gatewayVersion = "gateway-version-v1";

const command: CompleteEnableDispatchCommand = {
  schemaVersion: 1,
  contract: COMPLETE_ENABLE_DISPATCH_CONTRACT,
  authorizationIdSha256: authorizationId,
  claimDigestSha256: claimDigest,
  claimOwnerSha256: claimOwner,
  attemptDigestSha256: attemptDigest,
  stableGatewayEventDigestSha256: stableDigest,
  terminalRequestIdSha256: hex("8"),
};

const authentication: AuthenticatedRequest = {
  role: "receipt",
  credentialIdSha256: hex("9"),
  keyId: "receipt-v1",
  bodySha256: hex("0"),
  requestId: "operation-five-terminal-request",
};

describe("operation-five terminalizer", () => {
  it("parses only the exact canonical command", () => {
    const encoded = new TextEncoder().encode(canonicalJson(command));
    expect(parseCompleteEnableDispatchCommand(encoded)).toEqual(command);
    expect(() => parseCompleteEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson({
        ...command,
        unexpected: true,
      })),
    )).toThrowError("invalid_shape");
    expect(() => parseCompleteEnableDispatchCommand(
      new TextEncoder().encode(`${canonicalJson(command)}\n`),
    )).toThrowError("noncanonical_json");
  });

  it("records one terminal and exact-replays without another source read", async () => {
    let createdTerminal: OperationFiveTerminal | null = null;
    let persistedTerminal: OperationFiveTerminalRow | null = null;
    let createCalls = 0;
    const dependencies = dependenciesFixture({
      async readTerminal() {
        return persistedTerminal;
      },
      async createTerminal(_database, terminal) {
        createCalls += 1;
        createdTerminal = terminal;
        persistedTerminal = terminalRow(terminal);
        return {
          classification: "created",
          terminal: persistedTerminal,
          claim: {
            ...snapshotFixture().claim,
            ledger_version: 5,
            ledger_head_sha256:
              terminal.genericTerminalReceiptDigestSha256,
            last_completed_ordinal: 5,
            inflight_operation_ordinal: null,
            inflight_operation_id_sha256: null,
            inflight_request_sha256: null,
            inflight_started_generation: null,
            inflight_started_owner_sha256: null,
            inflight_started_lease_token_sha256: null,
          },
          receipt: terminalReceiptRow(terminal),
        };
      },
    });

    const first = await completeControllerEnableDispatch(
      envFixture(),
      command,
      authentication,
      dependencies,
    );
    expect(first).toMatchObject({
      result: "terminal_recorded",
      receiptCount: 5,
      lastCompletedOrdinal: 5,
      nextOperationOrdinal: 6,
      nextOperationIdSha256: operationSixId,
      gatewayVersionId: gatewayVersion,
      terminalAuthorityVersionId: authorityVersion,
    });
    expect(createdTerminal).not.toBeNull();
    expect(createdTerminal!.terminalEvidenceManifestSha256)
      .not.toBe(createdTerminal!.genericTerminalReceiptDigestSha256);
    expect(createdTerminal!.controllerEnabledVersionId)
      .not.toBe(createdTerminal!.targetVersionSha256);
    expect(createCalls).toBe(1);

    const replayDependencies = dependenciesFixture({
      async readTerminal() {
        return persistedTerminal;
      },
      async readClaim() {
        throw new Error("replay must not read the claim");
      },
      async readAttempt() {
        throw new Error("replay must not read the attempt");
      },
      async readGatewayChain() {
        throw new Error("replay must not read Gateway evidence");
      },
      async createTerminal() {
        throw new Error("replay must not write");
      },
    });
    const replay = await completeControllerEnableDispatch(
      envFixture({ CF_VERSION_METADATA: { id: "rolled-version" } }),
      command,
      authentication,
      replayDependencies,
    );
    expect(replay).toEqual({
      ...first,
      result: "exact_replay",
    });
    expect(createCalls).toBe(1);
  });

  it("fails closed on Authority version drift before writing", async () => {
    let createCalls = 0;
    await expect(completeControllerEnableDispatch(
      envFixture({ CF_VERSION_METADATA: { id: "authority-version-v2" } }),
      command,
      authentication,
      dependenciesFixture({
        async createTerminal() {
          createCalls += 1;
          throw new Error("must not write");
        },
      }),
    )).rejects.toThrowError("operation_five_terminal_source_mismatch");
    expect(createCalls).toBe(0);
  });

  it("rejects a stable event that is no longer the chain head", async () => {
    const chain = gatewayChainFixture();
    chain.push(gatewayEvent({
      event_sequence: 6,
      event_kind: "gateway_status_drift",
      predecessor_event_digest_sha256: stableDigest,
      event_digest_sha256: hex("f"),
      status_classification: "deployment_drift",
      target_stable: 0,
    }));
    await expect(completeControllerEnableDispatch(
      envFixture(),
      command,
      authentication,
      dependenciesFixture({
        async readGatewayChain() {
          return chain;
        },
      }),
    )).rejects.toThrowError(
      "operation_five_terminal_stable_evidence_mismatch",
    );
  });

  it("routes the dedicated command through receipt credentials", () => {
    const route = authorityRoutingForTest.match(new Request(
      `https://authority.invalid/internal/v1/shard-placement/execution-claims/${authorizationId}/complete-enable-dispatch`,
      { method: "POST" },
    ));
    expect(route).toEqual({
      kind: "execution_complete_enable_dispatch",
      role: "receipt",
    });
    expect(() => authorityRoutingForTest.requireGate(
      route.kind,
      {
        SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED:
          "false",
      } as AuthorityEnv,
    )).toThrowError(
      "authority_operation_five_terminal_write_disabled",
    );
  });
});

function dependenciesFixture(
  overrides: Partial<CompleteEnableDispatchDependencies> = {},
): CompleteEnableDispatchDependencies {
  return {
    async readTerminal() {
      return null;
    },
    async readClaim() {
      return snapshotFixture();
    },
    async readAttempt() {
      return attemptPairFixture();
    },
    async readGatewayChain() {
      return gatewayChainFixture();
    },
    async createTerminal(_database, terminal) {
      return {
        classification: "created",
        terminal: terminalRow(terminal),
        claim: {
          ...snapshotFixture().claim,
          ledger_version: 5,
          ledger_head_sha256:
            terminal.genericTerminalReceiptDigestSha256,
          last_completed_ordinal: 5,
          inflight_operation_ordinal: null,
          inflight_operation_id_sha256: null,
          inflight_request_sha256: null,
          inflight_started_generation: null,
          inflight_started_owner_sha256: null,
          inflight_started_lease_token_sha256: null,
        },
        receipt: terminalReceiptRow(terminal),
      };
    },
    ...overrides,
  };
}

function envFixture(
  overrides: Partial<CompleteEnableDispatchEnv> = {},
): CompleteEnableDispatchEnv {
  return {
    DB: {} as D1Database,
    CF_VERSION_METADATA: { id: authorityVersion },
    SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED:
      "true",
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: hex("1"),
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: hex("2"),
    ...overrides,
  };
}

function snapshotFixture(): ExecutionClaimSnapshot {
  const start = executionReceipt({
    sequence: 4,
    event_kind: "operation_started",
    operation_ordinal: 5,
    operation_id_sha256: operationFiveId,
    operation_kind: "enable_controller_deployment",
    predecessor_receipt_sha256: hex("3"),
    request_sha256: hex("4"),
    response_sha256: null,
    evidence_sha256: hex("5"),
    outcome: "pending",
    receipt_credential_id_sha256: hex("6"),
    request_id_sha256: hex("7"),
    receipt_digest_sha256: operationStartReceipt,
  });
  return {
    claim: {
      authorization_id_sha256: authorizationId,
      permit_subject_digest_sha256: hex("0"),
      execution_nonce_sha256: hex("1"),
      application_ticket_id_sha256: hex("2"),
      application_ticket_digest_sha256: hex("3"),
      application_database_identity_sha256: hex("4"),
      authority_database_identity_sha256: hex("1"),
      campaign_id: "campaign-v1",
      campaign_nonce_sha256: hex("5"),
      claim_scope: "placement",
      execution_plan_sha256: hex("6"),
      release_sha256: hex("7"),
      publication_sha256: hex("8"),
      execution_activation_sha256: hex("9"),
      runner_build_sha256: hex("a"),
      claim_owner_sha256: claimOwner,
      lease_owner_sha256: claimOwner,
      ledger_identity_sha256: hex("2"),
      lease_token_sha256: hex("b"),
      lease_generation: 1,
      lease_expires_at: now + 600,
      baseline_operation_id_sha256: hex("c"),
      baseline_terminal_digest_sha256: hex("d"),
      preparation_operation_id_sha256: hex("e"),
      claim_operation_id_sha256: hex("f"),
      operation_schedule_sha256: hex("0"),
      claim_credential_id_sha256: hex("1"),
      claim_request_id_sha256: hex("2"),
      claim_digest_sha256: claimDigest,
      claim_acquired_receipt_digest_sha256: hex("3"),
      permit_expires_at: now + 600,
      normal_deadline_at: now + 600,
      recovery_deadline_at: now + 1_200,
      status: "running",
      ledger_version: 4,
      ledger_head_sha256: operationStartReceipt,
      last_completed_ordinal: 4,
      inflight_operation_ordinal: 5,
      inflight_operation_id_sha256: operationFiveId,
      inflight_request_sha256: start.request_sha256,
      inflight_cloudflare_request_id_sha256: null,
      inflight_started_generation: 1,
      inflight_started_owner_sha256: claimOwner,
      inflight_started_lease_token_sha256: hex("b"),
      inflight_readback_only: 0,
      enable_intent_seen: 1,
      disable_confirmed: 0,
      application_activation_digest_sha256: hex("4"),
      ticket_activation_confirmed: 1,
      renewal_count: 0,
      takeover_count: 0,
      generated_at: now - 30,
      claimed_at: now - 20,
      updated_at: now - 10,
      terminal_at: null,
    },
    operations: [
      {
        authorization_id_sha256: authorizationId,
        ordinal: 5,
        operation_id_sha256: operationFiveId,
        kind: "enable_controller_deployment",
        shard_index: null,
      },
      {
        authorization_id_sha256: authorizationId,
        ordinal: 6,
        operation_id_sha256: operationSixId,
        kind: "probe_shard_readiness",
        shard_index: 0,
      },
    ],
    receipts: [
      executionReceipt({ sequence: 1 }),
      executionReceipt({ sequence: 2 }),
      executionReceipt({ sequence: 3 }),
      start,
    ],
  };
}

function attemptPairFixture(): OperationFiveSendAttemptPair {
  return {
    attempt: {
      authorization_id_sha256: authorizationId,
      contract_version: 1,
      attempt_contract:
        "cinatoken-shard-placement-authority-operation-five-send-attempt-v1",
      attempt_generation: 1,
      retry_count: 0,
      retry_limit: 0,
      send_attempt_limit: 1,
      send_authority_state: "granted",
      claim_digest_sha256: claimDigest,
      authority_dispatch_claim_digest_sha256: hex("0"),
      dispatch_consumption_receipt_digest_sha256: hex("1"),
      application_dispatch_consumption_digest_sha256: hex("2"),
      application_ticket_id_sha256: hex("2"),
      campaign_id: "campaign-v1",
      application_database_identity_sha256: hex("4"),
      application_version_id: "application-version-v1",
      authority_database_identity_sha256: hex("1"),
      authority_ledger_identity_sha256: hex("2"),
      authority_ledger_head_sha256: operationStartReceipt,
      authority_version_id: authorityVersion,
      dispatch_owner_sha256: claimOwner,
      lease_token_sha256: hex("b"),
      lease_generation: 1,
      controller_service_name: "cinatoken-controller",
      controller_enable_operation_id_sha256: operationFiveId,
      controller_baseline_version_id: "controller-baseline-v1",
      controller_enabled_version_id: "controller-enabled-v1",
      controller_command_contract:
        "cinatoken-controller-deployment-gateway-enable-command-v1",
      controller_command_digest_sha256: hex("3"),
      gateway_idempotency_contract:
        "cinatoken-controller-deployment-gateway-idempotency-v1",
      gateway_idempotency_key_sha256: hex("4"),
      send_credential_id_sha256: hex("5"),
      send_request_id_sha256: hex("6"),
      command_send_attempt_request_id_sha256: hex("7"),
      controller_request_sent: 0,
      gateway_request_sent: 0,
      attempt_digest_sha256: attemptDigest,
      created_at: now - 20,
    },
    event: {
      authorization_id_sha256: authorizationId,
      attempt_digest_sha256: attemptDigest,
      event_sequence: 1,
      contract_version: 1,
      event_contract:
        "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1",
      event_kind: "send_started",
      from_state: "consumption_receipted",
      to_state: "send_started",
      event_semantics:
        "unique_send_authority_persisted_network_may_not_have_occurred",
      predecessor_event_digest_sha256: hex("0"),
      dispatch_consumption_receipt_digest_sha256: hex("1"),
      controller_command_digest_sha256: hex("3"),
      gateway_idempotency_key_sha256: hex("4"),
      controller_request_sent: 0,
      gateway_request_sent: 0,
      event_digest_sha256: hex("2"),
      recorded_at: now - 20,
    },
  };
}

function gatewayChainFixture(): OperationFiveGatewayEventRow[] {
  return [
    gatewayEvent({
      event_sequence: 2,
      event_kind: "gateway_create_dispatched",
      predecessor_event_digest_sha256: hex("2"),
      event_digest_sha256: hex("3"),
    }),
    gatewayEvent({
      event_sequence: 3,
      event_kind: "gateway_create_accepted",
      predecessor_event_digest_sha256: hex("3"),
      event_digest_sha256: hex("4"),
    }),
    gatewayEvent({
      event_sequence: 4,
      event_kind: "gateway_status_target",
      predecessor_event_digest_sha256: hex("4"),
      event_digest_sha256: hex("5"),
      gateway_request_id_sha256: hex("6"),
      status_response_request_id_sha256: hex("7"),
      gateway_recorded_at: now - 10,
    }),
    gatewayEvent({
      event_sequence: 5,
      event_kind: "gateway_status_stable",
      predecessor_event_digest_sha256: hex("5"),
      event_digest_sha256: stableDigest,
      gateway_request_id_sha256: hex("8"),
      status_response_request_id_sha256: hex("9"),
      gateway_recorded_at: now - 5,
      target_stable: 1,
      stability_predecessor_observation_digest_sha256:
        observationDigest,
      stability_predecessor_recorded_at: now - 10,
    }),
  ];
}

function gatewayEvent(
  overrides: Partial<OperationFiveGatewayEventRow>,
): OperationFiveGatewayEventRow {
  return {
    authorization_id_sha256: authorizationId,
    attempt_digest_sha256: attemptDigest,
    send_started_event_digest_sha256: hex("2"),
    event_sequence: 2,
    contract_version: 1,
    event_contract:
      "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
    event_kind: "gateway_create_dispatched",
    predecessor_event_digest_sha256: hex("2"),
    gateway_idempotency_key_sha256: hex("4"),
    controller_command_digest_sha256: hex("3"),
    gateway_credential_role: "status",
    gateway_credential_id_sha256: hex("5"),
    gateway_request_id_sha256: hex("6"),
    gateway_response_sha256: hex("7"),
    gateway_response_bytes: 1024,
    gateway_version_id: gatewayVersion,
    mutation_request_sha256: null,
    result_classification: null,
    result_http_status: null,
    result_response_body_sha256: null,
    result_response_request_id_sha256: null,
    result_response_bytes: null,
    status_classification: "target_observed",
    deployments_http_status: 200,
    version_http_status: 200,
    deployment_set_sha256: hex("a"),
    target_version_sha256: hex("b"),
    status_response_request_id_sha256: hex("7"),
    observation_digest_sha256: observationDigest,
    gateway_recorded_at: now - 10,
    target_stable: 0,
    required_matching_observations: 2,
    stability_minimum_seconds: 5,
    stability_predecessor_observation_digest_sha256: null,
    stability_predecessor_recorded_at: null,
    event_digest_sha256: hex("3"),
    recorded_at: now - 10,
    ...overrides,
  };
}

function terminalRow(
  terminal: OperationFiveTerminal,
): OperationFiveTerminalRow {
  return {
    authorization_id_sha256: terminal.authorizationIdSha256,
    contract_version: 1,
    terminal_contract: terminal.terminalContract,
    claim_digest_sha256: terminal.claimDigestSha256,
    claim_owner_sha256: terminal.claimOwnerSha256,
    lease_owner_sha256: terminal.leaseOwnerSha256,
    lease_token_sha256: terminal.leaseTokenSha256,
    lease_generation: 1,
    attempt_digest_sha256: terminal.attemptDigestSha256,
    send_started_event_digest_sha256:
      terminal.sendStartedEventDigestSha256,
    stable_gateway_event_sequence:
      terminal.stableGatewayEventSequence,
    stable_gateway_event_digest_sha256:
      terminal.stableGatewayEventDigestSha256,
    stable_gateway_predecessor_event_digest_sha256:
      terminal.stableGatewayPredecessorEventDigestSha256,
    stable_gateway_request_id_sha256:
      terminal.stableGatewayRequestIdSha256,
    stable_gateway_response_sha256:
      terminal.stableGatewayResponseSha256,
    stable_gateway_response_bytes:
      terminal.stableGatewayResponseBytes,
    stable_observation_digest_sha256:
      terminal.stableObservationDigestSha256,
    stable_status_response_request_id_sha256:
      terminal.stableStatusResponseRequestIdSha256,
    stable_gateway_recorded_at: terminal.stableGatewayRecordedAt,
    deployment_set_sha256: terminal.deploymentSetSha256,
    target_version_sha256: terminal.targetVersionSha256,
    gateway_version_id: terminal.gatewayVersionId,
    controller_service_name: terminal.controllerServiceName,
    controller_enabled_version_id:
      terminal.controllerEnabledVersionId,
    controller_command_digest_sha256:
      terminal.controllerCommandDigestSha256,
    gateway_idempotency_key_sha256:
      terminal.gatewayIdempotencyKeySha256,
    authority_database_identity_sha256:
      terminal.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      terminal.authorityLedgerIdentitySha256,
    authority_dispatch_version_id:
      terminal.authorityDispatchVersionId,
    authority_terminal_version_id:
      terminal.authorityTerminalVersionId,
    operation_five_id_sha256: terminal.operationFiveIdSha256,
    operation_five_request_sha256:
      terminal.operationFiveRequestSha256,
    operation_start_receipt_digest_sha256:
      terminal.operationStartReceiptDigestSha256,
    operation_start_credential_id_sha256:
      terminal.operationStartCredentialIdSha256,
    operation_start_request_id_sha256:
      terminal.operationStartRequestIdSha256,
    admission_confirmation_digest_sha256:
      terminal.admissionConfirmationDigestSha256,
    terminal_writer_credential_id_sha256:
      terminal.terminalWriterCredentialIdSha256,
    terminal_writer_request_id_sha256:
      terminal.terminalWriterRequestIdSha256,
    terminal_command_digest_sha256:
      terminal.terminalCommandDigestSha256,
    ledger_head_before_sha256: terminal.ledgerHeadBeforeSha256,
    ledger_head_after_sha256: terminal.ledgerHeadAfterSha256,
    terminal_evidence_manifest_sha256:
      terminal.terminalEvidenceManifestSha256,
    generic_receipt_sequence: 5,
    generic_terminal_receipt_digest_sha256:
      terminal.genericTerminalReceiptDigestSha256,
    next_operation_ordinal: 6,
    next_operation_id_sha256: terminal.nextOperationIdSha256,
    recorded_at: now,
  };
}

function terminalReceiptRow(
  terminal: OperationFiveTerminal,
): ExecutionReceiptRow {
  return executionReceipt({
    sequence: 5,
    event_kind: "operation_terminal",
    operation_ordinal: 5,
    operation_id_sha256: terminal.operationFiveIdSha256,
    operation_kind: "enable_controller_deployment",
    predecessor_receipt_sha256: terminal.ledgerHeadBeforeSha256,
    request_sha256: terminal.operationFiveRequestSha256,
    response_sha256: terminal.terminalEvidenceManifestSha256,
    cloudflare_request_id_sha256:
      terminal.stableStatusResponseRequestIdSha256,
    evidence_sha256: terminal.admissionConfirmationDigestSha256,
    outcome: "exact_success",
    receipt_credential_id_sha256:
      terminal.operationStartCredentialIdSha256,
    request_id_sha256: terminal.operationStartRequestIdSha256,
    receipt_digest_sha256:
      terminal.genericTerminalReceiptDigestSha256,
  });
}

function executionReceipt(
  overrides: Partial<ExecutionReceiptRow>,
): ExecutionReceiptRow {
  return {
    authorization_id_sha256: authorizationId,
    sequence: 1,
    event_kind: "claim_acquired",
    claim_digest_sha256: claimDigest,
    execution_plan_sha256: hex("6"),
    ledger_identity_sha256: hex("2"),
    operation_ordinal: 3,
    operation_id_sha256: hex("3"),
    operation_kind: "create_authority_claim",
    shard_index: null,
    predecessor_receipt_sha256: hex("0"),
    request_sha256: hex("1"),
    response_sha256: null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: hex("2"),
    safety_reason: null,
    outcome: "exact_success",
    lease_owner_sha256: claimOwner,
    lease_token_sha256: hex("b"),
    lease_generation: 1,
    lease_expires_at: now + 600,
    receipt_credential_id_sha256: hex("3"),
    request_id_sha256: hex("4"),
    receipt_digest_sha256: hex("5"),
    recorded_at: now - 10,
    ...overrides,
  };
}

function hex(value: string): string {
  return value.repeat(64);
}
