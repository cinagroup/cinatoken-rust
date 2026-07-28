import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applicationPreEnableGrantDigest,
  createExactApplicationPreEnableGrant,
  type ApplicationPreEnableGrantReadback,
  type ApplicationPreEnableGrantClientEnv,
} from "../src/application_pre_enable_grant_client";
import {
  AUTHORIZE_ENABLE_DISPATCH_CONTRACT,
  authorizeControllerEnableDispatch,
  parseAuthorizeEnableDispatchCommand,
  type AuthorizeEnableDispatchCommand,
  type AuthorizeEnableDispatchEnv,
} from "../src/authorize_enable_dispatch";
import type {
  ExecutionClaimRow,
  ExecutionClaimSnapshot,
  ExecutionReceiptRow,
  OperationFiveApplicationGrantReceipt,
  OperationFiveApplicationGrantReceiptRow,
  OperationFiveDispatchOutboxRow,
} from "../src/execution_repository";
import { requestIdSha256 } from "../src/execution_protocol";
import {
  canonicalJson,
  sha256Hex,
  type AuthenticatedRequest,
} from "../src/protocol";

const digest = (value: string): string => value.repeat(64);
const now = 1_750_000_000;

function startedSnapshot(): ExecutionClaimSnapshot {
  const operationFiveId = digest("2");
  const operationFiveStart = digest("5");
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
    lease_expires_at: 2_100_000_100,
    baseline_operation_id_sha256: digest("2"),
    baseline_terminal_digest_sha256: digest("3"),
    preparation_operation_id_sha256: digest("4"),
    claim_operation_id_sha256: digest("5"),
    operation_schedule_sha256: digest("6"),
    claim_credential_id_sha256: digest("7"),
    claim_request_id_sha256: digest("8"),
    claim_digest_sha256: digest("9"),
    claim_acquired_receipt_digest_sha256: digest("a"),
    permit_expires_at: 2_100_000_500,
    normal_deadline_at: 2_100_000_500,
    recovery_deadline_at: 2_100_001_100,
    status: "running",
    ledger_version: 4,
    ledger_head_sha256: operationFiveStart,
    last_completed_ordinal: 4,
    inflight_operation_ordinal: 5,
    inflight_operation_id_sha256: operationFiveId,
    inflight_request_sha256: digest("3"),
    inflight_cloudflare_request_id_sha256: null,
    inflight_started_generation: 1,
    inflight_started_owner_sha256: digest("f"),
    inflight_started_lease_token_sha256: digest("1"),
    inflight_readback_only: 0,
    enable_intent_seen: 1,
    disable_confirmed: 0,
    application_activation_digest_sha256: digest("e"),
    ticket_activation_confirmed: 1,
    renewal_count: 0,
    takeover_count: 0,
    generated_at: now - 10,
    claimed_at: now,
    updated_at: now + 4,
    terminal_at: null,
  } satisfies ExecutionClaimRow;
  const receipt = (
    sequence: number,
    eventKind: string,
    operationOrdinal: number,
    operationIdSha256: string,
    receiptDigestSha256: string,
    predecessorReceiptSha256: string,
  ): ExecutionReceiptRow => ({
    authorization_id_sha256: claim.authorization_id_sha256,
    sequence,
    event_kind: eventKind,
    claim_digest_sha256: claim.claim_digest_sha256,
    execution_plan_sha256: claim.execution_plan_sha256,
    ledger_identity_sha256: claim.ledger_identity_sha256,
    operation_ordinal: operationOrdinal,
    operation_id_sha256: operationIdSha256,
    operation_kind: operationOrdinal === 5
      ? "enable_controller_deployment"
      : "activate_execution_ticket",
    shard_index: null,
    predecessor_receipt_sha256: predecessorReceiptSha256,
    request_sha256: operationOrdinal === 5
      ? claim.inflight_request_sha256
      : digest("c"),
    response_sha256: eventKind === "operation_terminal"
      ? digest("d")
      : null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: operationOrdinal === 5
      ? digest("4")
      : digest("e"),
    safety_reason: null,
    outcome: eventKind === "operation_started"
      ? "pending"
      : "exact_success",
    lease_owner_sha256: claim.lease_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: claim.lease_generation,
    lease_expires_at: claim.lease_expires_at,
    receipt_credential_id_sha256: digest("0"),
    request_id_sha256: digest("1"),
    receipt_digest_sha256: receiptDigestSha256,
    recorded_at: now + sequence,
  });
  return {
    claim,
    operations: [{
      authorization_id_sha256: claim.authorization_id_sha256,
      ordinal: 5,
      operation_id_sha256: operationFiveId,
      kind: "enable_controller_deployment",
      shard_index: null,
    }],
    receipts: [
      receipt(
        1,
        "claim_acquired",
        3,
        claim.claim_operation_id_sha256,
        claim.claim_acquired_receipt_digest_sha256,
        claim.baseline_terminal_digest_sha256,
      ),
      receipt(
        2,
        "operation_started",
        4,
        digest("b"),
        digest("b"),
        claim.claim_acquired_receipt_digest_sha256,
      ),
      receipt(
        3,
        "operation_terminal",
        4,
        digest("b"),
        digest("c"),
        digest("b"),
      ),
      receipt(
        4,
        "operation_started",
        5,
        operationFiveId,
        operationFiveStart,
        digest("c"),
      ),
    ],
  };
}

function outboxFor(
  snapshot: ExecutionClaimSnapshot,
): OperationFiveDispatchOutboxRow {
  return {
    authorization_id_sha256:
      snapshot.claim.authorization_id_sha256,
    contract_version: 1,
    dispatch_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1",
    claim_digest_sha256: snapshot.claim.claim_digest_sha256,
    application_ticket_id_sha256:
      snapshot.claim.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      snapshot.claim.application_ticket_digest_sha256,
    application_database_identity_sha256:
      snapshot.claim.application_database_identity_sha256,
    application_activation_digest_sha256:
      snapshot.claim.application_activation_digest_sha256!,
    application_acknowledgement_digest_sha256: digest("e"),
    operation_five_admission_digest_sha256:
      snapshot.receipts[3]!.evidence_sha256,
    operation_five_start_receipt_sha256:
      snapshot.receipts[3]!.receipt_digest_sha256,
    authority_database_identity_sha256:
      snapshot.claim.authority_database_identity_sha256,
    authority_version_id: "authority-grant-version",
    authority_ledger_head_sha256:
      snapshot.claim.ledger_head_sha256,
    application_version_id: "application-dispatch-version",
    application_read_credential_id_sha256: digest("b"),
    application_read_request_id_sha256: digest("c"),
    application_response_sha256: digest("d"),
    application_response_bytes: 2048,
    application_database_now: now,
    dispatch_credential_id_sha256: digest("e"),
    dispatch_request_id_sha256: digest("f"),
    command_dispatch_request_id_sha256: digest("0"),
    controller_service_name: "controller-service-from-ack",
    controller_enable_operation_id_sha256:
      snapshot.operations[0]!.operation_id_sha256,
    controller_baseline_version_id:
      "controller-baseline-from-ack",
    controller_enabled_version_id:
      "controller-enabled-from-ack",
    dispatch_request_sha256: digest("1"),
    outbox_digest_sha256: digest("2"),
    outbox_state: "prepared",
    prepared_at: now,
  };
}

function commandFor(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
): AuthorizeEnableDispatchCommand {
  return {
    schemaVersion: 1,
    contract: AUTHORIZE_ENABLE_DISPATCH_CONTRACT,
    authorizationIdSha256:
      snapshot.claim.authorization_id_sha256,
    claimDigestSha256: snapshot.claim.claim_digest_sha256,
    claimOwnerSha256: snapshot.claim.claim_owner_sha256,
    dispatchOutboxDigestSha256: outbox.outbox_digest_sha256,
    grantRequestIdSha256: digest("3"),
  };
}

function applicationGrantFor(
  snapshot: ExecutionClaimSnapshot,
  outbox: OperationFiveDispatchOutboxRow,
): ApplicationPreEnableGrantReadback {
  return {
    classification: "grant_created",
    grant: {
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-shard-placement-pre-enable-grant-snapshot-v1",
      ticketIdSha256: outbox.application_ticket_id_sha256,
      authorizationIdSha256: outbox.authorization_id_sha256,
      applicationTicketDigestSha256:
        outbox.application_ticket_digest_sha256,
      applicationDatabaseIdentitySha256:
        outbox.application_database_identity_sha256,
      authorityClaimDigestSha256: outbox.claim_digest_sha256,
      applicationActivationDigestSha256:
        outbox.application_activation_digest_sha256,
      applicationAcknowledgementDigestSha256:
        outbox.application_acknowledgement_digest_sha256,
      operationFiveAdmissionDigestSha256:
        outbox.operation_five_admission_digest_sha256,
      operationFiveStartReceiptSha256:
        outbox.operation_five_start_receipt_sha256,
      authorityDispatchOutboxDigestSha256:
        outbox.outbox_digest_sha256,
      authorityDatabaseIdentitySha256:
        outbox.authority_database_identity_sha256,
      authorityLedgerIdentitySha256:
        snapshot.claim.ledger_identity_sha256,
      authorityLedgerHeadSha256:
        outbox.authority_ledger_head_sha256,
      authorityVersionId: outbox.authority_version_id,
      controllerServiceName: outbox.controller_service_name,
      controllerEnableOperationIdSha256:
        outbox.controller_enable_operation_id_sha256,
      controllerBaselineVersionId:
        outbox.controller_baseline_version_id,
      controllerEnabledVersionId:
        outbox.controller_enabled_version_id,
      applicationGrantCredentialIdSha256: digest("4"),
      applicationGrantRequestIdSha256: digest("5"),
      grantDigestSha256: digest("6"),
      grantedAt: now,
      activationDeadlineAt: now + 200,
      executionDeadlineAt: now + 500,
      permitExpiresAt: now + 500,
      campaignExpiresAt: now + 500,
      campaignSealedAt: null,
      databaseNow: now,
    },
    applicationVersionId: "application-grant-version",
    responseSha256: digest("7"),
    responseBytes: 3072,
    credentialIdSha256: digest("4"),
    requestIdSha256: digest("5"),
  };
}

function receiptRow(
  receipt: OperationFiveApplicationGrantReceipt,
): OperationFiveApplicationGrantReceiptRow {
  return {
    authorization_id_sha256: receipt.authorizationIdSha256,
    contract_version: 1,
    receipt_contract: receipt.receiptContract,
    claim_digest_sha256: receipt.claimDigestSha256,
    application_ticket_id_sha256:
      receipt.applicationTicketIdSha256,
    application_ticket_digest_sha256:
      receipt.applicationTicketDigestSha256,
    application_database_identity_sha256:
      receipt.applicationDatabaseIdentitySha256,
    application_activation_digest_sha256:
      receipt.applicationActivationDigestSha256,
    application_acknowledgement_digest_sha256:
      receipt.applicationAcknowledgementDigestSha256,
    operation_five_admission_digest_sha256:
      receipt.operationFiveAdmissionDigestSha256,
    operation_five_start_receipt_sha256:
      receipt.operationFiveStartReceiptSha256,
    authority_dispatch_outbox_digest_sha256:
      receipt.authorityDispatchOutboxDigestSha256,
    application_grant_digest_sha256:
      receipt.applicationGrantDigestSha256,
    application_grant_credential_id_sha256:
      receipt.applicationGrantCredentialIdSha256,
    application_grant_request_id_sha256:
      receipt.applicationGrantRequestIdSha256,
    application_version_id: receipt.applicationVersionId,
    application_response_sha256:
      receipt.applicationResponseSha256,
    application_response_bytes: receipt.applicationResponseBytes,
    application_database_now: receipt.applicationDatabaseNow,
    application_granted_at: receipt.applicationGrantedAt,
    authority_database_identity_sha256:
      receipt.authorityDatabaseIdentitySha256,
    authority_ledger_identity_sha256:
      receipt.authorityLedgerIdentitySha256,
    authority_ledger_head_sha256:
      receipt.authorityLedgerHeadSha256,
    authority_version_id: receipt.authorityVersionId,
    grant_credential_id_sha256:
      receipt.grantCredentialIdSha256,
    grant_request_id_sha256: receipt.grantRequestIdSha256,
    command_grant_request_id_sha256:
      receipt.commandGrantRequestIdSha256,
    controller_service_name: receipt.controllerServiceName,
    controller_enable_operation_id_sha256:
      receipt.controllerEnableOperationIdSha256,
    controller_baseline_version_id:
      receipt.controllerBaselineVersionId,
    controller_enabled_version_id:
      receipt.controllerEnabledVersionId,
    receipt_digest_sha256: receipt.receiptDigestSha256,
    recorded_at: now,
  };
}

const env = {
  DB: {} as D1Database,
  CF_VERSION_METADATA: { id: "authority-grant-version" },
  SHARD_PLACEMENT_AUTHORITY_DATABASE_IDENTITY_SHA256: digest("7"),
  SHARD_PLACEMENT_AUTHORITY_LEDGER_IDENTITY_SHA256: digest("0"),
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_WRITE_ENABLED: "true",
  SHARD_PLACEMENT_AUTHORITY_PRE_ENABLE_GRANT_RECEIPT_WRITE_ENABLED:
    "true",
  SHARD_PLACEMENT_APPLICATION: {} as Fetcher,
} as AuthorizeEnableDispatchEnv;

const authentication = {
  role: "grant",
  credentialIdSha256: digest("8"),
  keyId: "grant-current-v1",
  bodySha256: digest("9"),
  requestId: "operation5-grant-route-request-1",
} satisfies AuthenticatedRequest;

describe("Authority operation 5 application grant", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts only an exact canonical command", () => {
    const snapshot = startedSnapshot();
    const command = commandFor(snapshot, outboxFor(snapshot));

    expect(parseAuthorizeEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson(command)),
    )).toEqual(command);
    expect(() => parseAuthorizeEnableDispatchCommand(
      new TextEncoder().encode(canonicalJson({
        ...command,
        extra: true,
      })),
    )).toThrowError(expect.objectContaining({
      code: "invalid_shape",
      status: 400,
    }));
    expect(() => parseAuthorizeEnableDispatchCommand(
      new TextEncoder().encode(JSON.stringify(command)),
    )).toThrowError(expect.objectContaining({
      code: "noncanonical_json",
      status: 400,
    }));
  });

  it("matches the Rust application grant digest fixed vector", async () => {
    await expect(applicationPreEnableGrantDigest({
      ticketIdSha256: digest("1"),
      authorizationIdSha256: digest("2"),
      applicationTicketDigestSha256: digest("3"),
      applicationDatabaseIdentitySha256: digest("4"),
      authorityClaimDigestSha256: digest("5"),
      applicationActivationDigestSha256: digest("6"),
      applicationAcknowledgementDigestSha256: digest("7"),
      operationFiveAdmissionDigestSha256: digest("8"),
      operationFiveStartReceiptSha256: digest("9"),
      authorityDispatchOutboxDigestSha256: digest("a"),
      authorityDatabaseIdentitySha256: digest("b"),
      authorityLedgerIdentitySha256: digest("c"),
      authorityLedgerHeadSha256: digest("9"),
      authorityVersionId: "authority-version-1",
      controllerServiceName: "controller-staging",
      controllerEnableOperationIdSha256: digest("d"),
      controllerBaselineVersionId: "controller-baseline",
      controllerEnabledVersionId: "controller-enabled",
      applicationGrantCredentialIdSha256: digest("e"),
      applicationGrantRequestIdSha256: digest("f"),
    })).resolves.toBe(
      "8ee874989d2ad6a1754062891241957beda37a82008d2ab62b6c81ba84092df7",
    );
  });

  it("binds POST path, canonical body, and grant role into the Application token", async () => {
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const callerRequestIdSha256 = digest("3");
    const expectedRequestId =
      `op5-grant-${callerRequestIdSha256.slice(0, 48)}`;
    const expectedRequestIdSha256 = await sha256Hex(
      new TextEncoder().encode(expectedRequestId),
    );
    let observed:
      | {
        method: string;
        path: string;
        body: Record<string, unknown>;
        claims: Record<string, unknown>;
      }
      | undefined;
    const clientEnv = {
      SHARD_PLACEMENT_APPLICATION: {
        async fetch(request: Request) {
          const bodyText = await request.text();
          const body = JSON.parse(bodyText) as Record<string, unknown>;
          const token = request.headers.get(
            "x-cinatoken-shard-placement-application",
          )!;
          const claims = decodeTokenPart(token.split(".")[1]!);
          observed = {
            method: request.method,
            path: new URL(request.url).pathname,
            body,
            claims,
          };
          expect(bodyText).toBe(canonicalJson(body));
          expect(claims.body_sha256).toBe(
            await sha256Hex(new TextEncoder().encode(bodyText)),
          );
          const responseBody = canonicalJson({
            result: "grant_created",
            requestId: expectedRequestId,
            credentialIdSha256: digest("e"),
            snapshot: {
              schemaVersion: 1,
              contract:
                "cinatoken-relay-container-shard-placement-pre-enable-grant-snapshot-v1",
              ticketIdSha256: body.ticketIdSha256,
              authorizationIdSha256: body.authorizationIdSha256,
              applicationTicketDigestSha256:
                body.applicationTicketDigestSha256,
              applicationDatabaseIdentitySha256:
                body.applicationDatabaseIdentitySha256,
              authorityClaimDigestSha256:
                body.authorityClaimDigestSha256,
              applicationActivationDigestSha256:
                body.applicationActivationDigestSha256,
              applicationAcknowledgementDigestSha256:
                body.applicationAcknowledgementDigestSha256,
              operationFiveAdmissionDigestSha256:
                body.operationFiveAdmissionDigestSha256,
              operationFiveStartReceiptSha256:
                body.operationFiveStartReceiptSha256,
              authorityDispatchOutboxDigestSha256:
                body.authorityDispatchOutboxDigestSha256,
              authorityDatabaseIdentitySha256:
                body.authorityDatabaseIdentitySha256,
              authorityLedgerIdentitySha256:
                body.authorityLedgerIdentitySha256,
              authorityLedgerHeadSha256:
                body.authorityLedgerHeadSha256,
              authorityVersionId: body.authorityVersionId,
              controllerServiceName: body.controllerServiceName,
              controllerEnableOperationIdSha256:
                body.controllerEnableOperationIdSha256,
              controllerBaselineVersionId:
                body.controllerBaselineVersionId,
              controllerEnabledVersionId:
                body.controllerEnabledVersionId,
              applicationGrantCredentialIdSha256: digest("e"),
              applicationGrantRequestIdSha256:
                expectedRequestIdSha256,
              grantDigestSha256: body.grantDigestSha256,
              grantedAt: now,
              activationDeadlineAt: now + 200,
              executionDeadlineAt: now + 500,
              permitExpiresAt: now + 500,
              campaignExpiresAt: now + 500,
              campaignSealedAt: null,
              databaseNow: now,
            },
            applicationVersionId: "application-grant-version",
          });
          return new Response(responseBody, {
            status: 201,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          });
        },
      } as Fetcher,
      SHARD_PLACEMENT_APPLICATION_ISSUER: "authority-test",
      SHARD_PLACEMENT_APPLICATION_AUDIENCE: "application-test",
      SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_KID:
        "application-grant-current-v1",
      SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        digest("e"),
      SHARD_PLACEMENT_APPLICATION_PRE_ENABLE_GRANT_HMAC_CURRENT_SECRET:
        "application-grant-secret-0000000000000000000000000000",
    } satisfies ApplicationPreEnableGrantClientEnv;

    const result = await createExactApplicationPreEnableGrant(
      clientEnv,
      outbox,
      {
        callerRequestIdSha256,
        authorityLedgerIdentitySha256:
          snapshot.claim.ledger_identity_sha256,
      },
      now,
    );

    expect(observed).toMatchObject({
      method: "POST",
      path:
        `/internal/v1/shard-placement/pre-enable-grants/${outbox.application_ticket_id_sha256}`,
      claims: {
        role: "pre_enable_grant",
        request_id: expectedRequestId,
        method: "POST",
      },
    });
    expect(result).toMatchObject({
      classification: "grant_created",
      credentialIdSha256: digest("e"),
      requestIdSha256: expectedRequestIdSha256,
      applicationVersionId: "application-grant-version",
    });
  });

  it("creates the Application grant, rereads the fence, and records it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const command = commandFor(snapshot, outbox);
    const applicationGrant = applicationGrantFor(snapshot, outbox);
    const calls: string[] = [];
    let claimReads = 0;
    let createdReceipt:
      | OperationFiveApplicationGrantReceipt
      | undefined;

    const result = await authorizeControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          calls.push("read_claim");
          claimReads += 1;
          return snapshot;
        },
        async readOutbox() {
          calls.push("read_outbox");
          return outbox;
        },
        async readGrantReceipt() {
          calls.push("read_grant_receipt");
          return null;
        },
        async createApplicationGrant(
          _clientEnv,
          clientOutbox,
          clientCommand,
        ) {
          calls.push("create_application_grant");
          expect(clientOutbox).toBe(outbox);
          expect(clientCommand).toEqual({
            callerRequestIdSha256: command.grantRequestIdSha256,
            authorityLedgerIdentitySha256:
              snapshot.claim.ledger_identity_sha256,
          });
          return applicationGrant;
        },
        async createGrantReceipt(_database, receipt) {
          calls.push("create_grant_receipt");
          createdReceipt = receipt;
          return {
            classification: "recorded" as const,
            receipt: receiptRow(receipt),
            claim: snapshot.claim,
          };
        },
      },
    );

    expect(claimReads).toBe(2);
    expect(calls).toEqual([
      "read_claim",
      "read_outbox",
      "read_grant_receipt",
      "create_application_grant",
      "read_claim",
      "create_grant_receipt",
    ]);
    expect(createdReceipt).toMatchObject({
      applicationGrantDigestSha256:
        applicationGrant.grant.grantDigestSha256,
      authorityDispatchOutboxDigestSha256:
        outbox.outbox_digest_sha256,
      authorityLedgerIdentitySha256:
        snapshot.claim.ledger_identity_sha256,
      grantCredentialIdSha256:
        authentication.credentialIdSha256,
      commandGrantRequestIdSha256:
        command.grantRequestIdSha256,
    });
    expect(result).toMatchObject({
      result: "application_grant_recorded",
      applicationGrantDigestSha256:
        applicationGrant.grant.grantDigestSha256,
      receiptCount: 4,
      receiptHeadSha256: snapshot.claim.ledger_head_sha256,
      authorityVersionId: env.CF_VERSION_METADATA.id,
    });
  });

  it("returns exact replay without calling Application or writing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = startedSnapshot();
    const outbox = outboxFor(snapshot);
    const command = commandFor(snapshot, outbox);
    const routeRequestId = await requestIdSha256(
      authentication.requestId,
    );
    const stored = receiptRow({
      authorizationIdSha256: command.authorizationIdSha256,
      receiptContract:
        "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1",
      claimDigestSha256: command.claimDigestSha256,
      applicationTicketIdSha256:
        outbox.application_ticket_id_sha256,
      applicationTicketDigestSha256:
        outbox.application_ticket_digest_sha256,
      applicationDatabaseIdentitySha256:
        outbox.application_database_identity_sha256,
      applicationActivationDigestSha256:
        outbox.application_activation_digest_sha256,
      applicationAcknowledgementDigestSha256:
        outbox.application_acknowledgement_digest_sha256,
      operationFiveAdmissionDigestSha256:
        outbox.operation_five_admission_digest_sha256,
      operationFiveStartReceiptSha256:
        outbox.operation_five_start_receipt_sha256,
      authorityDispatchOutboxDigestSha256:
        outbox.outbox_digest_sha256,
      applicationGrantDigestSha256: digest("6"),
      applicationGrantCredentialIdSha256: digest("4"),
      applicationGrantRequestIdSha256: digest("5"),
      applicationVersionId: "application-grant-version",
      applicationResponseSha256: digest("7"),
      applicationResponseBytes: 3072,
      applicationDatabaseNow: now,
      applicationGrantedAt: now,
      authorityDatabaseIdentitySha256:
        snapshot.claim.authority_database_identity_sha256,
      authorityLedgerIdentitySha256:
        snapshot.claim.ledger_identity_sha256,
      authorityLedgerHeadSha256:
        outbox.authority_ledger_head_sha256,
      authorityVersionId: outbox.authority_version_id,
      grantCredentialIdSha256:
        authentication.credentialIdSha256,
      grantRequestIdSha256: routeRequestId,
      commandGrantRequestIdSha256:
        command.grantRequestIdSha256,
      controllerServiceName: outbox.controller_service_name,
      controllerEnableOperationIdSha256:
        outbox.controller_enable_operation_id_sha256,
      controllerBaselineVersionId:
        outbox.controller_baseline_version_id,
      controllerEnabledVersionId:
        outbox.controller_enabled_version_id,
      receiptDigestSha256: digest("a"),
    });
    const createApplicationGrant = vi.fn();
    const createGrantReceipt = vi.fn();

    const result = await authorizeControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          return snapshot;
        },
        async readOutbox() {
          return outbox;
        },
        async readGrantReceipt() {
          return stored;
        },
        createApplicationGrant,
        createGrantReceipt,
      },
    );

    expect(createApplicationGrant).not.toHaveBeenCalled();
    expect(createGrantReceipt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "exact_replay",
      applicationGrantReceiptDigestSha256:
        stored.receipt_digest_sha256,
    });
  });

  it("rejects a changed fence after Application grants", async () => {
    const snapshot = startedSnapshot();
    const changed = {
      ...snapshot,
      claim: {
        ...snapshot.claim,
        lease_expires_at: snapshot.claim.lease_expires_at + 1,
      },
    } satisfies ExecutionClaimSnapshot;
    const outbox = outboxFor(snapshot);
    const command = commandFor(snapshot, outbox);
    let claimReads = 0;
    const createGrantReceipt = vi.fn();

    await expect(authorizeControllerEnableDispatch(
      env,
      command,
      authentication,
      {
        async readClaim() {
          claimReads += 1;
          return claimReads === 1 ? snapshot : changed;
        },
        async readOutbox() {
          return outbox;
        },
        async readGrantReceipt() {
          return null;
        },
        async createApplicationGrant() {
          return applicationGrantFor(snapshot, outbox);
        },
        createGrantReceipt,
      },
    )).rejects.toMatchObject({
      code: "operation_five_application_grant_fence_changed",
      status: 409,
    });
    expect(createGrantReceipt).not.toHaveBeenCalled();
  });
});

function decodeTokenPart(value: string): Record<string, unknown> {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}
