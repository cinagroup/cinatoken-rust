import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEGIN_ENABLE_CONTRACT,
  beginControllerEnable,
  parseBeginEnableCommand,
  type BeginEnableCommand,
  type BeginEnableDependencies,
  type BeginEnableEnv,
} from "../src/begin_enable";
import {
  applicationAuthorityAcknowledgementDigest,
  readExactApplicationAuthorityAck,
  type ApplicationAuthorityAckClientEnv,
  type ApplicationAuthorityAckSnapshot,
} from "../src/application_ack_client";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveAdmissionRow,
  OperationFiveAdmission,
} from "../src/execution_repository";
import { canonicalJson } from "../src/protocol";

const digest = (value: string): string => value.repeat(64);

function admissionRow(
  value: OperationFiveAdmission,
): OperationFiveAdmissionRow {
  return {
    authorization_id_sha256: value.authorizationIdSha256,
    contract_version: 1,
    confirmation_contract: value.confirmationContract,
    claim_digest_sha256: value.claimDigestSha256,
    application_ticket_id_sha256: value.applicationTicketIdSha256,
    application_ticket_digest_sha256:
      value.applicationTicketDigestSha256,
    application_database_identity_sha256:
      value.applicationDatabaseIdentitySha256,
    application_activation_digest_sha256:
      value.applicationActivationDigestSha256,
    authority_activation_terminal_receipt_sha256:
      value.authorityActivationTerminalReceiptSha256,
    authority_ledger_head_sha256: value.authorityLedgerHeadSha256,
    authority_database_identity_sha256:
      value.authorityDatabaseIdentitySha256,
    authority_version_id: value.authorityVersionId,
    application_acknowledgement_digest_sha256:
      value.applicationAcknowledgementDigestSha256,
    application_version_id: value.applicationVersionId,
    application_read_credential_id_sha256:
      value.applicationReadCredentialIdSha256,
    application_read_request_id_sha256:
      value.applicationReadRequestIdSha256,
    application_response_sha256: value.applicationResponseSha256,
    application_response_bytes: value.applicationResponseBytes,
    enable_credential_id_sha256: value.enableCredentialIdSha256,
    enable_request_id_sha256: value.enableRequestIdSha256,
    command_enable_request_id_sha256:
      value.commandEnableRequestIdSha256,
    enable_operation_request_sha256:
      value.enableOperationRequestSha256,
    confirmation_digest_sha256: value.confirmationDigestSha256,
    operation_start_receipt_digest_sha256:
      value.operationStartReceiptDigestSha256,
    confirmed_at: 1_750_000_000,
  };
}

function readySnapshot(): ExecutionClaimSnapshot {
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
    status: "running",
    ledger_version: 3,
    ledger_head_sha256: digest("d"),
    last_completed_ordinal: 4,
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
    application_activation_digest_sha256: digest("e"),
    ticket_activation_confirmed: 1,
    renewal_count: 0,
    takeover_count: 0,
    generated_at: 1_749_999_990,
    claimed_at: 1_750_000_000,
    updated_at: 1_750_000_003,
    terminal_at: null,
  } satisfies ExecutionClaimRow;
  const receipt = (
    sequence: number,
    eventKind: string,
    operationOrdinal: number,
    receiptDigest: string,
    predecessor: string,
  ): ExecutionReceiptRow => ({
    authorization_id_sha256: claim.authorization_id_sha256,
    sequence,
    event_kind: eventKind,
    claim_digest_sha256: claim.claim_digest_sha256,
    execution_plan_sha256: claim.execution_plan_sha256,
    ledger_identity_sha256: claim.ledger_identity_sha256,
    operation_ordinal: operationOrdinal,
    operation_id_sha256:
      operationOrdinal === 4 ? digest("b") : claim.claim_operation_id_sha256,
    operation_kind: operationOrdinal === 4
      ? "activate_execution_ticket"
      : "create_authority_claim",
    shard_index: null,
    predecessor_receipt_sha256: predecessor,
    request_sha256: digest("c"),
    response_sha256:
      eventKind === "operation_terminal" ? digest("f") : null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: operationOrdinal === 4
      ? digest("e")
      : claim.claim_digest_sha256,
    safety_reason: null,
    outcome: eventKind === "operation_started"
      ? "pending"
      : "exact_success",
    lease_owner_sha256: claim.lease_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: 1,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: digest("0"),
    request_id_sha256: digest("1"),
    receipt_digest_sha256: receiptDigest,
    recorded_at: 1_750_000_000 + sequence,
  });
  return {
    claim,
    operations: [{
      authorization_id_sha256: claim.authorization_id_sha256,
      ordinal: 5,
      operation_id_sha256: digest("2"),
      kind: "enable_controller_deployment",
      shard_index: null,
    }],
    receipts: [
      receipt(
        1,
        "claim_acquired",
        3,
        claim.claim_acquired_receipt_digest_sha256,
        claim.baseline_terminal_digest_sha256,
      ),
      receipt(
        2,
        "operation_started",
        4,
        digest("c"),
        claim.claim_acquired_receipt_digest_sha256,
      ),
      receipt(3, "operation_terminal", 4, digest("d"), digest("c")),
    ],
  };
}

describe("Authority operation 5 admission", () => {
  afterEach(() => vi.useRealTimers());

  it("reads ACK, rereads Authority, then atomically admits and starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_750_000_000_000));
    let snapshot = readySnapshot();
    const calls: string[] = [];
    const dependencies: BeginEnableDependencies = {
      async readClaim() {
        calls.push("read_claim");
        return snapshot;
      },
      async readAdmission() {
        calls.push("read_admission");
        return null;
      },
      async readAcknowledgement() {
        calls.push("read_application_ack");
        return {
          acknowledgement: {} as never,
          applicationVersionId: "application-version-1",
          responseSha256: digest("3"),
          responseBytes: 1024,
          credentialIdSha256: digest("4"),
          requestIdSha256: digest("5"),
        };
      },
      async admitAndStart(_database, admission, receipt) {
        calls.push("batch_admission_and_start");
        const row: ExecutionReceiptRow = {
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
          predecessor_receipt_sha256:
            receipt.predecessorReceiptSha256,
          request_sha256: receipt.requestSha256,
          response_sha256: receipt.responseSha256,
          cloudflare_request_id_sha256:
            receipt.cloudflareRequestIdSha256,
          evidence_sha256: receipt.evidenceSha256,
          safety_reason: receipt.safetyReason,
          outcome: receipt.outcome,
          lease_owner_sha256: receipt.actorOwnerSha256,
          lease_token_sha256: receipt.leaseTokenSha256,
          lease_generation: receipt.leaseGeneration,
          lease_expires_at: snapshot.claim.lease_expires_at,
          receipt_credential_id_sha256:
            receipt.actorCredentialIdSha256,
          request_id_sha256: receipt.requestIdSha256,
          receipt_digest_sha256: receipt.receiptDigestSha256,
          recorded_at: 1_750_000_000,
        };
        snapshot = {
          ...snapshot,
          claim: {
            ...snapshot.claim,
            ledger_version: 4,
            ledger_head_sha256: receipt.receiptDigestSha256,
            inflight_operation_ordinal: 5,
            inflight_operation_id_sha256: receipt.operationIdSha256,
            inflight_request_sha256: receipt.requestSha256,
            inflight_started_generation: 1,
            inflight_started_owner_sha256: receipt.actorOwnerSha256,
            inflight_started_lease_token_sha256:
              receipt.leaseTokenSha256,
            enable_intent_seen: 1,
            disable_confirmed: 0,
          },
          receipts: [...snapshot.receipts, row],
        };
        return {
          classification: "admitted" as const,
          admission: admissionRow(admission),
          claim: snapshot.claim,
          receipt: row,
        };
      },
    };
    const command: BeginEnableCommand = {
      schemaVersion: 1,
      contract: BEGIN_ENABLE_CONTRACT,
      authorizationIdSha256: snapshot.claim.authorization_id_sha256,
      claimDigestSha256: snapshot.claim.claim_digest_sha256,
      claimOwnerSha256: snapshot.claim.claim_owner_sha256,
      applicationAcknowledgementDigestSha256: digest("6"),
      enableRequestIdSha256: digest("7"),
    };
    const result = await beginControllerEnable(
      {
        DB: {} as D1Database,
        CF_VERSION_METADATA: { id: "authority-version-1" },
        SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_READ_ENABLED: "true",
        SHARD_PLACEMENT_AUTHORITY_ENABLE_INTENT_WRITE_ENABLED: "true",
      } as BeginEnableEnv,
      command,
      {
        role: "enable",
        credentialIdSha256: digest("8"),
        keyId: "enable-current-v1",
        bodySha256: digest("9"),
        requestId: "operation5-enable-request-1",
      },
      dependencies,
    );
    expect(calls).toEqual([
      "read_claim",
      "read_admission",
      "read_application_ack",
      "read_claim",
      "batch_admission_and_start",
    ]);
    expect(result).toMatchObject({
      result: "enable_intent_recorded",
      applicationAcknowledgementDigestSha256: digest("6"),
      receiptCount: 4,
    });
  });

  it("rejects noncanonical or unknown command fields", () => {
    const value = {
      schemaVersion: 1,
      contract: BEGIN_ENABLE_CONTRACT,
      authorizationIdSha256: digest("1"),
      claimDigestSha256: digest("2"),
      claimOwnerSha256: digest("3"),
      applicationAcknowledgementDigestSha256: digest("4"),
      enableRequestIdSha256: digest("5"),
    };
    expect(parseBeginEnableCommand(
      new TextEncoder().encode(canonicalJson(value)),
    )).toEqual(value);
    expect(() => parseBeginEnableCommand(
      new TextEncoder().encode(JSON.stringify({ ...value, extra: true })),
    )).toThrow();
  });

  it("matches the Rust ACK digest fixed vector", async () => {
    const value = {
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-shard-placement-authority-ack-snapshot-v1",
      ticketIdSha256: digest("1"),
      ticketDigestSha256: digest("2"),
      authorizationIdSha256: digest("3"),
      campaignId: digest("4"),
      applicationDatabaseIdentitySha256: digest("5"),
      authorityDatabaseIdentitySha256: digest("6"),
      authorityLedgerIdentitySha256: digest("7"),
      operationScheduleSha256: digest("8"),
      controllerServiceName: "controller-staging",
      controllerBaselineVersionId: "controller-baseline",
      controllerEnabledVersionId: "controller-enabled",
      controllerEnableOperationIdSha256: digest("2"),
      authorityClaimDigestSha256: digest("9"),
      authorityClaimAcquiredReceiptSha256: digest("a"),
      authorityClaimOperationIdSha256: digest("b"),
      authorityActivationOperationIdSha256: digest("c"),
      applicationActivationDigestSha256: digest("d"),
      authorityActivationTerminalReceiptSha256: digest("e"),
      authorityLedgerHeadSha256: digest("e"),
      authorityVersionId: "authority-version-1",
      authorityReadCredentialIdSha256: digest("f"),
      authorityReadRequestIdSha256: digest("0"),
      acknowledgementDigestSha256: digest("1"),
      acknowledgedByAdminId: 7,
      preparedAt: 1,
      activatedAt: 2,
      acknowledgedAt: 3,
      activationDeadlineAt: 4,
      executionDeadlineAt: 5,
      permitExpiresAt: 5,
      campaignExpiresAt: 5,
      campaignSealedAt: null,
      databaseNow: 3,
    } satisfies ApplicationAuthorityAckSnapshot;
    await expect(
      applicationAuthorityAcknowledgementDigest(value),
    ).resolves.toBe(
      "afd96cd6232295c41963fb3c9f88916aa3a131ab7a66d027b3dfed85665be02c",
    );
  });

  it.each([
    {
      name: "encoded response",
      headers: {
        "cache-control": "no-store",
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
    },
    {
      name: "oversize declared response",
      headers: {
        "cache-control": "no-store",
        "content-length": String(64 * 1024 + 1),
        "content-type": "application/json",
      },
    },
  ])("rejects $name before parsing bytes", async ({ headers }) => {
    const snapshot = readySnapshot();
    const env = {
      SHARD_PLACEMENT_APPLICATION: {
        async fetch() {
          return new Response("{}", { status: 200, headers });
        },
      } as Fetcher,
      SHARD_PLACEMENT_APPLICATION_ISSUER: "authority-test",
      SHARD_PLACEMENT_APPLICATION_AUDIENCE: "application-test",
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID:
        "ack-current-v1",
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        digest("1"),
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET:
        "ack-reader-secret-00000000000000000000000000000000",
    } satisfies ApplicationAuthorityAckClientEnv;
    await expect(readExactApplicationAuthorityAck(
      env,
      snapshot,
      {
        applicationAcknowledgementDigestSha256: digest("2"),
        callerRequestIdSha256: digest("3"),
        requestDomain: "op5",
      },
      "authority-version-1",
      1_750_000_000,
    )).rejects.toMatchObject({
      code: "application_authority_ack_invalid_response",
      status: 502,
    });
  });

  it("keeps the timeout active while response bytes are streaming", async () => {
    vi.useFakeTimers();
    const snapshot = readySnapshot();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const env = {
      SHARD_PLACEMENT_APPLICATION: {
        async fetch(request: Request) {
          markFetchStarted();
          return new Response(new ReadableStream({
            start(controller) {
              request.signal.addEventListener("abort", () => {
                controller.error(new Error("aborted"));
              });
            },
          }), {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          });
        },
      } as Fetcher,
      SHARD_PLACEMENT_APPLICATION_ISSUER: "authority-test",
      SHARD_PLACEMENT_APPLICATION_AUDIENCE: "application-test",
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_KID:
        "ack-current-v1",
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        digest("1"),
      SHARD_PLACEMENT_APPLICATION_ACK_READ_HMAC_CURRENT_SECRET:
        "ack-reader-secret-00000000000000000000000000000000",
    } satisfies ApplicationAuthorityAckClientEnv;
    const pending = readExactApplicationAuthorityAck(
      env,
      snapshot,
      {
        applicationAcknowledgementDigestSha256: digest("2"),
        callerRequestIdSha256: digest("3"),
        requestDomain: "op5",
      },
      "authority-version-1",
      1_750_000_000,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "application_authority_ack_timeout",
      status: 504,
    });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(3_001);
    await assertion;
  });
});
