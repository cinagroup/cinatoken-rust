import { describe, expect, it, vi } from "vitest";

import {
  applicationDispatchConsumptionDigest,
  type ApplicationDispatchConsumptionSnapshot,
} from "../src/application_dispatch_consumption_client";
import {
  readHistoricalApplicationDispatchConsumption,
  validateApplicationDispatchConsumptionHistoryClientConfig,
  type ApplicationDispatchConsumptionHistoryClientEnv,
  type HistoricalApplicationDispatchConsumptionReadback,
} from "../src/application_dispatch_consumption_history_client";
import { operationFiveDispatchClaimDigest } from "../src/claim_enable_dispatch";
import {
  operationFiveDispatchConsumptionReceiptDigest,
} from "../src/consume_enable_dispatch";
import type {
  OperationFiveDispatchClaim,
  OperationFiveDispatchClaimRow,
  OperationFiveDispatchConsumptionReceipt,
  OperationFiveDispatchConsumptionReceiptRow,
} from "../src/execution_repository";
import {
  authorityRoutingForTest,
  type AuthorityEnv,
} from "../src/index";
import {
  RECOVER_ENABLE_DISPATCH_CONSUMPTION_CONTRACT,
  parseRecoverEnableDispatchConsumptionCommand,
  recoverControllerEnableDispatchConsumption,
  type RecoverEnableDispatchConsumptionCommand,
  type RecoverEnableDispatchConsumptionDependencies,
  type RecoverEnableDispatchConsumptionEnv,
} from "../src/recover_enable_dispatch_consumption";
import {
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";

const digest = (value: string): string => value.repeat(64);

function command(): RecoverEnableDispatchConsumptionCommand {
  return {
    schemaVersion: 1,
    contract: RECOVER_ENABLE_DISPATCH_CONSUMPTION_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    dispatchClaimDigestSha256: digest("0"),
    dispatchConsumptionRequestIdSha256: digest("3"),
    recoveryRequestIdSha256: digest("4"),
  };
}

function authentication(): AuthenticatedRequest {
  return {
    role: "recovery",
    credentialIdSha256: digest("5"),
    keyId: "recovery-hmac-v1",
    bodySha256: digest("6"),
    requestId: "operation-five-consumption-recovery-route-1",
  };
}

async function dispatchClaim(
  now: number,
): Promise<OperationFiveDispatchClaimRow> {
  const input = command();
  const candidate: Omit<
    OperationFiveDispatchClaim,
    "dispatchClaimDigestSha256"
  > = {
    authorizationIdSha256: input.authorizationIdSha256,
    claimContract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1",
    claimDigestSha256: input.claimDigestSha256,
    applicationTicketIdSha256: digest("7"),
    applicationDatabaseIdentitySha256: digest("8"),
    authorityDispatchOutboxDigestSha256: digest("9"),
    applicationGrantReceiptDigestSha256: digest("a"),
    applicationGrantDigestSha256: digest("b"),
    operationFiveStartReceiptSha256: digest("c"),
    authorityDatabaseIdentitySha256: digest("d"),
    authorityLedgerIdentitySha256: digest("e"),
    authorityLedgerHeadSha256: digest("c"),
    authorityVersionId: "historical-authority-version",
    applicationVersionId: "historical-application-version",
    dispatchOwnerSha256: digest("f"),
    leaseTokenSha256: digest("1"),
    leaseGeneration: 1,
    leaseExpiresAt: now - 60,
    normalDeadlineAt: now - 50,
    permitExpiresAt: now - 40,
    dispatchClaimCredentialIdSha256: digest("2"),
    dispatchClaimRequestIdSha256: digest("3"),
    commandDispatchClaimRequestIdSha256: digest("4"),
    controllerServiceName: "container-controller-staging",
    controllerEnableOperationIdSha256: digest("5"),
    controllerBaselineVersionId: "controller-baseline-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    claimState: "claimed",
  };
  const dispatchClaimDigestSha256 =
    await operationFiveDispatchClaimDigest(candidate);
  input.dispatchClaimDigestSha256 = dispatchClaimDigestSha256;
  return {
    authorization_id_sha256: candidate.authorizationIdSha256,
    contract_version: 1,
    claim_contract: candidate.claimContract,
    claim_digest_sha256: candidate.claimDigestSha256,
    application_ticket_id_sha256: candidate.applicationTicketIdSha256,
    application_database_identity_sha256:
      candidate.applicationDatabaseIdentitySha256,
    authority_dispatch_outbox_digest_sha256:
      candidate.authorityDispatchOutboxDigestSha256,
    application_grant_receipt_digest_sha256:
      candidate.applicationGrantReceiptDigestSha256,
    application_grant_digest_sha256:
      candidate.applicationGrantDigestSha256,
    operation_five_start_receipt_sha256:
      candidate.operationFiveStartReceiptSha256,
    authority_database_identity_sha256:
      candidate.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      candidate.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256:
      candidate.authorityLedgerHeadSha256,
    authority_version_id: candidate.authorityVersionId,
    application_version_id: candidate.applicationVersionId,
    dispatch_owner_sha256: candidate.dispatchOwnerSha256,
    lease_token_sha256: candidate.leaseTokenSha256,
    lease_generation: 1,
    lease_expires_at: candidate.leaseExpiresAt,
    normal_deadline_at: candidate.normalDeadlineAt,
    permit_expires_at: candidate.permitExpiresAt,
    dispatch_claim_credential_id_sha256:
      candidate.dispatchClaimCredentialIdSha256,
    dispatch_claim_request_id_sha256:
      candidate.dispatchClaimRequestIdSha256,
    command_dispatch_claim_request_id_sha256:
      candidate.commandDispatchClaimRequestIdSha256,
    controller_service_name: candidate.controllerServiceName,
    controller_enable_operation_id_sha256:
      candidate.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      candidate.controllerBaselineVersionId,
    controller_enabled_version_id:
      candidate.controllerEnabledVersionId,
    send_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    dispatch_claim_digest_sha256: dispatchClaimDigestSha256,
    claim_state: "claimed",
    claimed_at: now - 120,
  };
}

async function consumptionSnapshot(
  row: OperationFiveDispatchClaimRow,
  now: number,
): Promise<ApplicationDispatchConsumptionSnapshot> {
  const snapshot: ApplicationDispatchConsumptionSnapshot = {
    schemaVersion: 1,
    contract:
      "cinatoken-relay-container-shard-placement-dispatch-consumption-snapshot-v1",
    ticketIdSha256: row.application_ticket_id_sha256,
    contractVersion: 1,
    consumptionContract:
      "cinatoken-relay-container-shard-placement-dispatch-consumption-v1",
    authorizationIdSha256: row.authorization_id_sha256,
    campaignId: digest("6"),
    applicationDatabaseIdentitySha256:
      row.application_database_identity_sha256,
    applicationVersionId: row.application_version_id,
    applicationGrantDigestSha256:
      row.application_grant_digest_sha256,
    authorityClaimDigestSha256: row.claim_digest_sha256,
    authorityDispatchOutboxDigestSha256:
      row.authority_dispatch_outbox_digest_sha256,
    applicationGrantReceiptDigestSha256:
      row.application_grant_receipt_digest_sha256,
    operationFiveStartReceiptSha256:
      row.operation_five_start_receipt_sha256,
    authorityDispatchClaimDigestSha256:
      row.dispatch_claim_digest_sha256,
    authorityDatabaseIdentitySha256:
      row.authority_database_identity_sha256,
    authorityLedgerIdentitySha256:
      row.authority_ledger_identity_sha256,
    authorityLedgerHeadSha256: row.authority_ledger_head_sha256,
    authorityVersionId: row.authority_version_id,
    dispatchOwnerSha256: row.dispatch_owner_sha256,
    leaseTokenSha256: row.lease_token_sha256,
    leaseGeneration: 1,
    leaseExpiresAt: row.lease_expires_at,
    normalDeadlineAt: row.normal_deadline_at,
    permitExpiresAt: row.permit_expires_at,
    dispatchClaimCredentialIdSha256:
      row.dispatch_claim_credential_id_sha256,
    dispatchClaimRequestIdSha256:
      row.dispatch_claim_request_id_sha256,
    commandDispatchClaimRequestIdSha256:
      row.command_dispatch_claim_request_id_sha256,
    authorityDispatchClaimedAt: row.claimed_at,
    controllerServiceName: row.controller_service_name,
    controllerEnableOperationIdSha256:
      row.controller_enable_operation_id_sha256,
    controllerBaselineVersionId: row.controller_baseline_version_id,
    controllerEnabledVersionId: row.controller_enabled_version_id,
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    applicationDispatchConsumptionCredentialIdSha256: digest("7"),
    applicationDispatchConsumptionRequestIdSha256: digest("8"),
    commandDispatchConsumptionRequestIdSha256:
      command().dispatchConsumptionRequestIdSha256,
    dispatchConsumptionDigestSha256: digest("0"),
    consumptionState: "consumed",
    consumedAt: now - 100,
  };
  snapshot.dispatchConsumptionDigestSha256 =
    await applicationDispatchConsumptionDigest(snapshot);
  return snapshot;
}

async function historyReadback(
  row: OperationFiveDispatchClaimRow,
  now: number,
): Promise<HistoricalApplicationDispatchConsumptionReadback> {
  const consumption = await consumptionSnapshot(row, now);
  return {
    consumption,
    applicationDatabaseNow: now,
    retentionDeadlineAt: consumption.consumedAt + 2_592_000,
    responseSha256: digest("9"),
    responseBytes: 4096,
    readCredentialIdSha256: digest("a"),
    readRequestIdSha256: digest("b"),
  };
}

function receiptRow(
  receipt: OperationFiveDispatchConsumptionReceipt,
): OperationFiveDispatchConsumptionReceiptRow {
  return {
    authorization_id_sha256: receipt.authorizationIdSha256,
    contract_version: 1,
    receipt_contract: receipt.receiptContract,
    claim_digest_sha256: receipt.claimDigestSha256,
    application_ticket_id_sha256: receipt.applicationTicketIdSha256,
    campaign_id: receipt.campaignId,
    application_database_identity_sha256:
      receipt.applicationDatabaseIdentitySha256,
    application_version_id: receipt.applicationVersionId,
    application_grant_receipt_digest_sha256:
      receipt.applicationGrantReceiptDigestSha256,
    application_grant_digest_sha256:
      receipt.applicationGrantDigestSha256,
    authority_dispatch_outbox_digest_sha256:
      receipt.authorityDispatchOutboxDigestSha256,
    operation_five_start_receipt_sha256:
      receipt.operationFiveStartReceiptSha256,
    authority_dispatch_claim_digest_sha256:
      receipt.authorityDispatchClaimDigestSha256,
    authority_database_identity_sha256:
      receipt.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      receipt.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256: receipt.authorityLedgerHeadSha256,
    authority_version_id: receipt.authorityVersionId,
    dispatch_owner_sha256: receipt.dispatchOwnerSha256,
    lease_token_sha256: receipt.leaseTokenSha256,
    lease_generation: 1,
    lease_expires_at: receipt.leaseExpiresAt,
    normal_deadline_at: receipt.normalDeadlineAt,
    permit_expires_at: receipt.permitExpiresAt,
    dispatch_claim_credential_id_sha256:
      receipt.dispatchClaimCredentialIdSha256,
    dispatch_claim_request_id_sha256:
      receipt.dispatchClaimRequestIdSha256,
    command_dispatch_claim_request_id_sha256:
      receipt.commandDispatchClaimRequestIdSha256,
    authority_dispatch_claimed_at: receipt.authorityDispatchClaimedAt,
    controller_service_name: receipt.controllerServiceName,
    controller_enable_operation_id_sha256:
      receipt.controllerEnableOperationIdSha256,
    controller_baseline_version_id: receipt.controllerBaselineVersionId,
    controller_enabled_version_id: receipt.controllerEnabledVersionId,
    send_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    application_dispatch_consumption_digest_sha256:
      receipt.applicationDispatchConsumptionDigestSha256,
    application_dispatch_consumption_credential_id_sha256:
      receipt.applicationDispatchConsumptionCredentialIdSha256,
    application_dispatch_consumption_request_id_sha256:
      receipt.applicationDispatchConsumptionRequestIdSha256,
    command_dispatch_consumption_request_id_sha256:
      receipt.commandDispatchConsumptionRequestIdSha256,
    application_consumption_state: "consumed",
    application_consumed_at: receipt.applicationConsumedAt,
    application_response_sha256: receipt.applicationResponseSha256,
    application_response_bytes: receipt.applicationResponseBytes,
    consume_credential_id_sha256: receipt.consumeCredentialIdSha256,
    consume_request_id_sha256: receipt.consumeRequestIdSha256,
    command_consume_request_id_sha256:
      receipt.commandConsumeRequestIdSha256,
    receipt_digest_sha256: receipt.receiptDigestSha256,
    recorded_at: Math.floor(Date.now() / 1_000),
  };
}

function recoveryEnv(
  row: OperationFiveDispatchClaimRow,
): RecoverEnableDispatchConsumptionEnv {
  return {
    DB: {} as D1Database,
    SHARD_PLACEMENT_APPLICATION_DATABASE_IDENTITY_SHA256:
      row.application_database_identity_sha256,
    SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256:
      row.authority_database_identity_sha256,
    SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256:
      row.authority_ledger_identity_sha256,
  } as RecoverEnableDispatchConsumptionEnv;
}

function historyClientEnv(
  fetch: ReturnType<typeof vi.fn>,
): ApplicationDispatchConsumptionHistoryClientEnv {
  return {
    SHARD_PLACEMENT_APPLICATION: { fetch },
    SHARD_PLACEMENT_APPLICATION_ISSUER:
      "shard-placement-authority-staging",
    SHARD_PLACEMENT_APPLICATION_AUDIENCE:
      "cinatoken-rust-api-staging",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_KID:
      "history-current-v1",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
      digest("c"),
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_CURRENT_SECRET:
      "history-current-secret-000000000000000000000000000",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_KID:
      "",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
      "",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_SECRET:
      "",
    SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_RETENTION_SECONDS:
      "2592000",
  };
}

describe("operation-5 historical dispatch consumption recovery", () => {
  it("parses only canonical commands within the dedicated 4 KiB limit", () => {
    const source = canonicalJson(command());
    expect(
      parseRecoverEnableDispatchConsumptionCommand(
        new TextEncoder().encode(source),
      ),
    ).toEqual(command());
    expect(() =>
      parseRecoverEnableDispatchConsumptionCommand(
        new TextEncoder().encode(` ${source}`),
      )
    ).toThrowError("noncanonical_json");
    expect(() =>
      parseRecoverEnableDispatchConsumptionCommand(
        new Uint8Array(4097),
      )
    ).toThrowError(
      "operation_five_dispatch_consumption_recovery_command_too_large",
    );
  });

  it("uses the independent recovery role and independent gates", () => {
    const id = digest("1");
    const route = authorityRoutingForTest.match(new Request(
      `https://authority.invalid/internal/v1/shard-placement/execution-claims/${id}/recover-enable-dispatch-consumption`,
      { method: "POST" },
    ));
    expect(route).toEqual({
      kind: "execution_recover_enable_dispatch_consumption",
      role: "recovery",
    });
    const env = {
      SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_WRITE_ENABLED:
        "false",
      SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECEIPT_WRITE_ENABLED:
        "false",
      SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECOVERY_READ_ENABLED:
        "true",
      SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECOVERY_RECEIPT_WRITE_ENABLED:
        "true",
    } as AuthorityEnv;
    expect(() =>
      authorityRoutingForTest.requireGate(route.kind, env)
    ).not.toThrow();
    expect(() =>
      authorityRoutingForTest.requireGate(route.kind, {
        ...env,
        SHARD_PLACEMENT_AUTHORITY_DISPATCH_CONSUMPTION_RECOVERY_READ_ENABLED:
          "false",
      })
    ).toThrowError(
      "authority_dispatch_consumption_recovery_reads_disabled",
    );
  });

  it("recovers after live lease deadlines and replays before any readback", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const input = {
      ...command(),
      dispatchClaimDigestSha256: row.dispatch_claim_digest_sha256,
    };
    const application = await historyReadback(row, now);
    let stored: OperationFiveDispatchConsumptionReceiptRow | null = null;
    const readApplicationHistory = vi.fn().mockResolvedValue(application);
    const createRecoveredReceipt = vi.fn(
      async (
        _database: D1Database,
        receipt: OperationFiveDispatchConsumptionReceipt,
        recovery: {
          recoveryEvidenceDigestSha256: string;
          retentionDeadlineAt: number;
        },
      ) => {
        stored = receiptRow(receipt);
        return {
          classification: "recorded" as const,
          receipt: stored,
          recovery: {
            recovery_evidence_digest_sha256:
              recovery.recoveryEvidenceDigestSha256,
            retention_deadline_at: recovery.retentionDeadlineAt,
          },
        };
      },
    );
    const dependencies = {
      readReceipt: vi.fn().mockResolvedValue(null),
      readDispatchClaim: vi.fn().mockResolvedValue(row),
      readApplicationHistory,
      createRecoveredReceipt,
    } as RecoverEnableDispatchConsumptionDependencies;
    const result = await recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      dependencies,
    );
    expect(row.lease_expires_at).toBeLessThan(now);
    expect(result).toMatchObject({
      result: "dispatch_consumption_receipt_recovered",
      retentionDeadlineAt: application.retentionDeadlineAt,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    expect(readApplicationHistory).toHaveBeenCalledTimes(1);
    expect(createRecoveredReceipt).toHaveBeenCalledTimes(1);

    const noFurtherRead = vi.fn();
    const replay = await recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      {
        readReceipt: vi.fn().mockResolvedValue(stored),
        readDispatchClaim: noFurtherRead,
        readApplicationHistory: noFurtherRead,
        createRecoveredReceipt: noFurtherRead,
      } as unknown as RecoverEnableDispatchConsumptionDependencies,
    );
    expect(replay).toMatchObject({
      result: "exact_replay",
      recoveryEvidenceDigestSha256: null,
      retentionDeadlineAt: null,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    expect(noFurtherRead).not.toHaveBeenCalled();
  });

  it("accepts a concurrent exact live receipt but rejects immutable source drift", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const input = {
      ...command(),
      dispatchClaimDigestSha256: row.dispatch_claim_digest_sha256,
    };
    const application = await historyReadback(row, now);
    let drift = false;
    const createRecoveredReceipt = vi.fn(
      async (
        _database: D1Database,
        recoveryReceipt: OperationFiveDispatchConsumptionReceipt,
      ) => {
        const liveWithoutDigest = {
          ...recoveryReceipt,
          applicationDispatchConsumptionDigestSha256:
            drift
              ? digest("f")
              : recoveryReceipt
                .applicationDispatchConsumptionDigestSha256,
          applicationResponseSha256: digest("0"),
          applicationResponseBytes: 2048,
          consumeCredentialIdSha256: digest("1"),
          consumeRequestIdSha256: digest("2"),
          commandConsumeRequestIdSha256:
            recoveryReceipt.commandDispatchConsumptionRequestIdSha256,
        };
        const {
          receiptDigestSha256: _ignored,
          ...liveDigestInput
        } = liveWithoutDigest;
        const liveReceipt = {
          ...liveWithoutDigest,
          receiptDigestSha256:
            await operationFiveDispatchConsumptionReceiptDigest(
              liveDigestInput,
            ),
        };
        return {
          classification: "exact_replay" as const,
          receipt: receiptRow(liveReceipt),
          recovery: null,
        };
      },
    );
    const dependencies = {
      readReceipt: vi.fn().mockResolvedValue(null),
      readDispatchClaim: vi.fn().mockResolvedValue(row),
      readApplicationHistory: vi.fn().mockResolvedValue(application),
      createRecoveredReceipt,
    } as RecoverEnableDispatchConsumptionDependencies;
    await expect(recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      dependencies,
    )).resolves.toMatchObject({
      result: "exact_replay",
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });

    drift = true;
    await expect(recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      dependencies,
    )).rejects.toThrowError(
      "operation_five_dispatch_consumption_recovery_source_drift",
    );
  });

  it("fails closed on the wrong role or existing receipt drift", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const input = {
      ...command(),
      dispatchClaimDigestSha256: row.dispatch_claim_digest_sha256,
    };
    const dependencies = {
      readReceipt: vi.fn().mockResolvedValue(null),
      readDispatchClaim: vi.fn(),
      readApplicationHistory: vi.fn(),
      createRecoveredReceipt: vi.fn(),
    } as RecoverEnableDispatchConsumptionDependencies;
    await expect(recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      { ...authentication(), role: "send" },
      dependencies,
    )).rejects.toThrowError(
      "operation_five_dispatch_consumption_recovery_role_mismatch",
    );
    expect(dependencies.readReceipt).not.toHaveBeenCalled();

    const application = await historyReadback(row, now);
    let recovered: OperationFiveDispatchConsumptionReceiptRow | null = null;
    await recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      {
        readReceipt: vi.fn().mockResolvedValue(null),
        readDispatchClaim: vi.fn().mockResolvedValue(row),
        readApplicationHistory: vi.fn().mockResolvedValue(application),
        createRecoveredReceipt: vi.fn(async (_db, receipt) => {
          recovered = receiptRow(receipt);
          return {
            classification: "recorded" as const,
            receipt: recovered,
            recovery: null,
          };
        }),
      },
    );
    const drifted = {
      ...recovered!,
      application_version_id: "drifted-version",
    };
    await expect(recoverControllerEnableDispatchConsumption(
      recoveryEnv(row),
      input,
      authentication(),
      {
        ...dependencies,
        readReceipt: vi.fn().mockResolvedValue(drifted),
      },
    )).rejects.toThrowError(
      "operation_five_dispatch_consumption_receipt_digest_mismatch",
    );
  });

  it("validates isolated recovery-read credentials and retention", () => {
    const env = historyClientEnv(vi.fn());
    expect(() =>
      validateApplicationDispatchConsumptionHistoryClientConfig(env)
    ).not.toThrow();
    expect(() =>
      validateApplicationDispatchConsumptionHistoryClientConfig({
        ...env,
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_RETENTION_SECONDS:
          "30",
      })
    ).toThrowError(
      "application_dispatch_consumption_history_client_unavailable",
    );
    expect(() =>
      validateApplicationDispatchConsumptionHistoryClientConfig({
        ...env,
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_KID:
          "history-previous-v1",
      })
    ).toThrowError(
      "application_dispatch_consumption_history_client_unavailable",
    );
  });

  it("binds the future Service Binding request to recovery-read and exact retention", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const snapshot = await consumptionSnapshot(row, now);
    const responseBody = canonicalJson({
      contract:
        "cinatoken-relay-container-shard-placement-dispatch-consumption-history-read-result-v1",
      result: "historical_dispatch_consumption_found",
      snapshot,
      applicationDatabaseNow: now,
      retentionDeadlineAt: snapshot.consumedAt + 2_592_000,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        `/internal/v1/shard-placement/dispatch-consumptions/${row.application_ticket_id_sha256}/historical-readback`,
      );
      const token = request.headers.get(
        "x-cinatoken-shard-placement-application",
      )!;
      const claims = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
            (character) => character.charCodeAt(0),
          ),
        ),
      ) as Record<string, unknown>;
      expect(claims.role).toBe("dispatch_consumption_recovery_read");
      expect(claims.method).toBe("POST");
      expect((await request.arrayBuffer()).byteLength)
        .toBeLessThanOrEqual(4096);
      return new Response(responseBody, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(
            new TextEncoder().encode(responseBody).byteLength,
          ),
          "content-type": "application/json",
        },
      });
    });
    const result = await readHistoricalApplicationDispatchConsumption(
      historyClientEnv(fetch),
      row,
      command().dispatchConsumptionRequestIdSha256,
      command().recoveryRequestIdSha256,
      now,
    );
    expect(result).toMatchObject({
      consumption: snapshot,
      applicationDatabaseNow: now,
      retentionDeadlineAt: snapshot.consumedAt + 2_592_000,
      responseBytes: new TextEncoder().encode(responseBody).byteLength,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the previous recovery-read credential only after current 409", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const snapshot = await consumptionSnapshot(row, now);
    const responseBody = canonicalJson({
      contract:
        "cinatoken-relay-container-shard-placement-dispatch-consumption-history-read-result-v1",
      result: "historical_dispatch_consumption_found",
      snapshot,
      applicationDatabaseNow: now,
      retentionDeadlineAt: snapshot.consumedAt + 2_592_000,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    const kids: string[] = [];
    const bodies: string[] = [];
    const fetch = vi.fn(async (request: Request) => {
      const token = request.headers.get(
        "x-cinatoken-shard-placement-application",
      )!;
      const encoded = token.split(".")[0]!;
      const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      kids.push(JSON.parse(atob(padded)).kid as string);
      bodies.push(await request.text());
      if (kids.length === 1) {
        return new Response(null, { status: 409 });
      }
      return new Response(responseBody, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    });
    const env = {
      ...historyClientEnv(fetch),
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_KID:
        "history-previous-v1",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
        digest("d"),
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_RECOVERY_READ_HMAC_PREVIOUS_SECRET:
        "history-previous-secret-00000000000000000000000000",
    };
    const result = await readHistoricalApplicationDispatchConsumption(
      env,
      row,
      command().dispatchConsumptionRequestIdSha256,
      command().recoveryRequestIdSha256,
      now,
    );
    expect(kids).toEqual([
      "history-current-v1",
      "history-previous-v1",
    ]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(result.readCredentialIdSha256).toBe(digest("d"));
  });

  it("rejects historical response drift and declared oversize", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const row = await dispatchClaim(now);
    const snapshot = await consumptionSnapshot(row, now);
    const driftedBody = canonicalJson({
      contract:
        "cinatoken-relay-container-shard-placement-dispatch-consumption-history-read-result-v1",
      result: "historical_dispatch_consumption_found",
      snapshot: {
        ...snapshot,
        applicationVersionId: "drifted-version",
      },
      applicationDatabaseNow: now,
      retentionDeadlineAt: snapshot.consumedAt + 2_592_000,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    await expect(readHistoricalApplicationDispatchConsumption(
      historyClientEnv(vi.fn().mockResolvedValue(new Response(
        driftedBody,
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        },
      ))),
      row,
      command().dispatchConsumptionRequestIdSha256,
      command().recoveryRequestIdSha256,
      now,
    )).rejects.toThrowError(
      "application_dispatch_consumption_mismatch",
    );
    await expect(readHistoricalApplicationDispatchConsumption(
      historyClientEnv(vi.fn().mockResolvedValue(new Response("{}", {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-length": String(65_537),
          "content-type": "application/json",
        },
      }))),
      row,
      command().dispatchConsumptionRequestIdSha256,
      command().recoveryRequestIdSha256,
      now,
    )).rejects.toThrowError(
      "application_dispatch_consumption_history_invalid_response",
    );
  });
});
