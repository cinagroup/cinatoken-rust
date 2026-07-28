import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVATE_TICKET_CONTRACT,
  activateExecutionTicket,
  parseActivateTicketCommand,
  type ActivateTicketCommand,
  type ActivateTicketDependencies,
  type ActivateTicketEnv,
} from "../src/activate_ticket";
import { applicationActivationDigest } from "../src/application_activation_client";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
} from "../src/execution_repository";
import type { ExecutionReceipt } from "../src/execution_protocol";
import { canonicalJson } from "../src/protocol";

const digest = (value: string): string => value.repeat(64);

function receiptRow(receipt: ExecutionReceipt): ExecutionReceiptRow {
  return {
    authorization_id_sha256: receipt.authorizationIdSha256,
    sequence: receipt.sequence,
    event_kind: receipt.eventKind,
    claim_digest_sha256: receipt.claimDigestSha256,
    execution_plan_sha256: receipt.executionPlanSha256,
    ledger_identity_sha256: receipt.ledgerIdentitySha256,
    operation_ordinal: receipt.operationOrdinal,
    operation_id_sha256: receipt.operationIdSha256,
    operation_kind: receipt.operationKind,
    shard_index: receipt.shardIndex,
    predecessor_receipt_sha256: receipt.predecessorReceiptSha256,
    request_sha256: receipt.requestSha256,
    response_sha256: receipt.responseSha256,
    cloudflare_request_id_sha256: receipt.cloudflareRequestIdSha256,
    evidence_sha256: receipt.evidenceSha256,
    safety_reason: receipt.safetyReason,
    outcome: receipt.outcome,
    lease_owner_sha256: receipt.actorOwnerSha256,
    lease_token_sha256: receipt.leaseTokenSha256,
    lease_generation: receipt.leaseGeneration,
    lease_expires_at: 1_750_000_100,
    receipt_credential_id_sha256: receipt.actorCredentialIdSha256,
    request_id_sha256: receipt.requestIdSha256,
    receipt_digest_sha256: receipt.receiptDigestSha256,
    recorded_at: 1_750_000_001 + receipt.sequence,
  };
}

function pristineSnapshot(): ExecutionClaimSnapshot {
  const claim = {
    authorization_id_sha256: digest("1"),
    permit_subject_digest_sha256: digest("2"),
    execution_nonce_sha256: digest("3"),
    application_ticket_id_sha256: digest("4"),
    application_ticket_digest_sha256: digest("5"),
    application_database_identity_sha256: digest("6"),
    authority_database_identity_sha256: digest("7"),
    campaign_id: digest("8"),
    campaign_nonce_sha256: digest("9"),
    claim_scope: "staging-controller-placement-v1",
    execution_plan_sha256: digest("a"),
    release_sha256: digest("b"),
    publication_sha256: digest("c"),
    execution_activation_sha256: digest("d"),
    runner_build_sha256: digest("e"),
    claim_owner_sha256: digest("f"),
    lease_owner_sha256: digest("f"),
    ledger_identity_sha256: digest("0"),
    lease_token_sha256: digest("1"),
    lease_generation: 1,
    lease_expires_at: 1_750_000_100,
    baseline_operation_id_sha256: digest("2"),
    baseline_terminal_digest_sha256: digest("3"),
    preparation_operation_id_sha256: digest("4"),
    claim_operation_id_sha256: digest("5"),
    operation_schedule_sha256: digest("6"),
    claim_credential_id_sha256: digest("7"),
    claim_request_id_sha256: digest("8"),
    claim_digest_sha256: digest("9"),
    claim_acquired_receipt_digest_sha256: digest("a"),
    permit_expires_at: 1_750_000_500,
    normal_deadline_at: 1_750_000_500,
    recovery_deadline_at: 1_750_001_100,
    status: "claimed",
    ledger_version: 1,
    ledger_head_sha256: digest("a"),
    last_completed_ordinal: 3,
    inflight_operation_ordinal: null,
    inflight_operation_id_sha256: null,
    inflight_request_sha256: null,
    inflight_cloudflare_request_id_sha256: null,
    inflight_started_generation: null,
    inflight_started_owner_sha256: null,
    inflight_started_lease_token_sha256: null,
    inflight_readback_only: 0,
    enable_intent_seen: 0,
    disable_confirmed: 1,
    application_activation_digest_sha256: null,
    ticket_activation_confirmed: 0,
    renewal_count: 0,
    takeover_count: 0,
    generated_at: 1_749_999_990,
    claimed_at: 1_750_000_000,
    updated_at: 1_750_000_000,
    terminal_at: null,
  } satisfies ExecutionClaimRow;
  const acquired = {
    authorization_id_sha256: claim.authorization_id_sha256,
    sequence: 1,
    event_kind: "claim_acquired",
    claim_digest_sha256: claim.claim_digest_sha256,
    execution_plan_sha256: claim.execution_plan_sha256,
    ledger_identity_sha256: claim.ledger_identity_sha256,
    operation_ordinal: 3,
    operation_id_sha256: claim.claim_operation_id_sha256,
    operation_kind: "create_authority_claim",
    shard_index: null,
    predecessor_receipt_sha256: claim.baseline_terminal_digest_sha256,
    request_sha256: claim.claim_digest_sha256,
    response_sha256: null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: claim.claim_digest_sha256,
    safety_reason: null,
    outcome: "exact_success",
    lease_owner_sha256: claim.claim_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: 1,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: claim.claim_credential_id_sha256,
    request_id_sha256: claim.claim_request_id_sha256,
    receipt_digest_sha256: claim.claim_acquired_receipt_digest_sha256,
    recorded_at: claim.claimed_at,
  } satisfies ExecutionReceiptRow;
  return {
    claim,
    operations: [{
      authorization_id_sha256: claim.authorization_id_sha256,
      ordinal: 4,
      operation_id_sha256: digest("b"),
      kind: "activate_execution_ticket",
      shard_index: null,
    }],
    receipts: [acquired],
  };
}

describe("Authority operation 4", () => {
  afterEach(() => vi.useRealTimers());

  it("persists start before application read and then appends terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_750_000_000_000));
    let snapshot = pristineSnapshot();
    const calls: string[] = [];
    const dependencies: ActivateTicketDependencies = {
      async readClaim() {
        return snapshot;
      },
      async readActivation() {
        calls.push("application_read");
        return {
          activation: {} as never,
          responseSha256: digest("c"),
          credentialIdSha256: digest("d"),
        };
      },
      async appendReceipt(_database, _authorization, receipt) {
        calls.push(`append_${receipt.eventKind}`);
        const row = receiptRow(receipt);
        if (receipt.eventKind === "operation_started") {
          snapshot = {
            ...snapshot,
            claim: {
              ...snapshot.claim,
              status: "running",
              ledger_version: 2,
              ledger_head_sha256: row.receipt_digest_sha256,
              inflight_operation_ordinal: 4,
              inflight_operation_id_sha256: row.operation_id_sha256,
              inflight_request_sha256: row.request_sha256,
              inflight_started_generation: 1,
              inflight_started_owner_sha256: row.lease_owner_sha256,
              inflight_started_lease_token_sha256: row.lease_token_sha256,
            },
            receipts: [...snapshot.receipts, row],
          };
        } else {
          snapshot = {
            ...snapshot,
            claim: {
              ...snapshot.claim,
              ledger_version: 3,
              ledger_head_sha256: row.receipt_digest_sha256,
              last_completed_ordinal: 4,
              inflight_operation_ordinal: null,
              inflight_operation_id_sha256: null,
              inflight_request_sha256: null,
              application_activation_digest_sha256: digest("e"),
              ticket_activation_confirmed: 1,
            },
            receipts: [...snapshot.receipts, row],
          };
        }
        return {
          classification: "receipt_appended" as const,
          claim: snapshot.claim,
          receipt: row,
        };
      },
    };
    const command: ActivateTicketCommand = {
      schemaVersion: 1,
      contract: ACTIVATE_TICKET_CONTRACT,
      authorizationIdSha256: snapshot.claim.authorization_id_sha256,
      claimDigestSha256: snapshot.claim.claim_digest_sha256,
      claimOwnerSha256: snapshot.claim.claim_owner_sha256,
      applicationActivationDigestSha256: digest("e"),
      activationRequestIdSha256: digest("f"),
    };
    const result = await activateExecutionTicket(
      {
        DB: {} as D1Database,
        CF_VERSION_METADATA: { id: "authority-version-1" },
        SHARD_PLACEMENT_AUTHORITY_ACTIVATION_WRITE_ENABLED: "true",
      } as ActivateTicketEnv,
      command,
      {
        role: "receipt",
        credentialIdSha256: digest("0"),
        keyId: "receipt-current-v1",
        bodySha256: digest("1"),
        requestId: "operation4-request-1",
      },
      dependencies,
    );
    expect(calls).toEqual([
      "append_operation_started",
      "application_read",
      "append_operation_terminal",
    ]);
    expect(result).toMatchObject({
      result: "activated",
      applicationActivationDigestSha256: digest("e"),
      receiptCount: 3,
    });
  });

  it("rejects noncanonical or unknown command fields", () => {
    const value = {
      schemaVersion: 1,
      contract: ACTIVATE_TICKET_CONTRACT,
      authorizationIdSha256: digest("1"),
      claimDigestSha256: digest("2"),
      claimOwnerSha256: digest("3"),
      applicationActivationDigestSha256: digest("4"),
      activationRequestIdSha256: digest("5"),
    };
    expect(parseActivateTicketCommand(
      new TextEncoder().encode(canonicalJson(value)),
    )).toEqual(value);
    expect(() => parseActivateTicketCommand(
      new TextEncoder().encode(JSON.stringify({ ...value, extra: true })),
    )).toThrow();
  });

  it("matches the Rust application activation digest fixed vector", async () => {
    await expect(applicationActivationDigest({
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-shard-placement-execution-ticket-activation-snapshot-v1",
      ticketIdSha256: digest("1"),
      ticketDigestSha256: digest("2"),
      authorizationIdSha256: digest("3"),
      campaignId: digest("4"),
      applicationDatabaseIdentitySha256: digest("5"),
      authorityDatabaseIdentitySha256: digest("6"),
      authorityLedgerIdentitySha256: digest("7"),
      operationScheduleSha256: digest("8"),
      authorityClaimDigestSha256: digest("9"),
      authorityClaimAcquiredReceiptSha256: digest("a"),
      authorityClaimOperationIdSha256: digest("b"),
      authorityActivationOperationIdSha256: digest("c"),
      authorityVersionId: "authority-version-1",
      activationCredentialIdSha256: digest("d"),
      activationRequestIdSha256: digest("e"),
      activationDigestSha256: digest("f"),
      activatedByAdminId: 7,
      preparedAt: 1,
      activatedAt: 2,
      activationDeadlineAt: 3,
      executionDeadlineAt: 4,
      permitExpiresAt: 4,
      campaignExpiresAt: 4,
      campaignSealedAt: null,
      databaseNow: 2,
    })).resolves.toBe(
      "1eb4e9925af7fd7c6f8dae9be6a17720cbfdd67363600f3baa567c73b1173d9c",
    );
  });
});
