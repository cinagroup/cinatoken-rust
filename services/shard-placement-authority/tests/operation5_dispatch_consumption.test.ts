import { describe, expect, it, vi } from "vitest";

import {
  applicationDispatchConsumptionDigest,
  validateApplicationDispatchConsumptionClientConfig,
  type ApplicationDispatchConsumptionClientEnv,
  type ApplicationDispatchConsumptionSnapshot,
} from "../src/application_dispatch_consumption_client";
import {
  CONSUME_ENABLE_DISPATCH_CONTRACT,
  consumeControllerEnableDispatch,
  parseConsumeEnableDispatchCommand,
  type ConsumeEnableDispatchCommand,
  type ConsumeEnableDispatchDependencies,
  type ConsumeEnableDispatchEnv,
} from "../src/consume_enable_dispatch";
import type {
  OperationFiveDispatchConsumptionReceiptRow,
} from "../src/execution_repository";
import { requestIdSha256 } from "../src/execution_protocol";
import {
  canonicalJson,
  type AuthenticatedRequest,
} from "../src/protocol";

const digest = (value: string): string => value.repeat(64);

function command(): ConsumeEnableDispatchCommand {
  return {
    schemaVersion: 1,
    contract: CONSUME_ENABLE_DISPATCH_CONTRACT,
    authorizationIdSha256: digest("1"),
    claimDigestSha256: digest("2"),
    claimOwnerSha256: digest("3"),
    dispatchClaimDigestSha256: digest("4"),
    dispatchConsumptionRequestIdSha256: digest("5"),
  };
}

function authentication(): AuthenticatedRequest {
  return {
    role: "send",
    credentialIdSha256: digest("6"),
    keyId: "send-hmac-v1",
    bodySha256: digest("7"),
    requestId: "operation-five-consumption-route-1",
  };
}

async function storedReceipt(
  input = command(),
  auth = authentication(),
): Promise<OperationFiveDispatchConsumptionReceiptRow> {
  return {
    authorization_id_sha256: input.authorizationIdSha256,
    contract_version: 1,
    receipt_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1",
    claim_digest_sha256: input.claimDigestSha256,
    application_ticket_id_sha256: digest("8"),
    campaign_id: digest("9"),
    application_database_identity_sha256: digest("a"),
    application_version_id: "application-version-1",
    application_grant_receipt_digest_sha256: digest("b"),
    application_grant_digest_sha256: digest("c"),
    authority_dispatch_outbox_digest_sha256: digest("d"),
    operation_five_start_receipt_sha256: digest("e"),
    authority_dispatch_claim_digest_sha256:
      input.dispatchClaimDigestSha256,
    authority_database_identity_sha256: digest("f"),
    authority_ledger_identity_sha256: digest("0"),
    authority_ledger_head_sha256: digest("e"),
    authority_version_id: "authority-version-1",
    dispatch_owner_sha256: input.claimOwnerSha256,
    lease_token_sha256: digest("1"),
    lease_generation: 1,
    lease_expires_at: 1_900_000_100,
    normal_deadline_at: 1_900_000_200,
    permit_expires_at: 1_900_000_300,
    dispatch_claim_credential_id_sha256: digest("2"),
    dispatch_claim_request_id_sha256: digest("3"),
    command_dispatch_claim_request_id_sha256: digest("4"),
    authority_dispatch_claimed_at: 1_900_000_000,
    controller_service_name: "container-controller-staging",
    controller_enable_operation_id_sha256: digest("5"),
    controller_baseline_version_id: "controller-baseline-v1",
    controller_enabled_version_id: "controller-enabled-v1",
    send_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    application_dispatch_consumption_digest_sha256: digest("7"),
    application_dispatch_consumption_credential_id_sha256: digest("8"),
    application_dispatch_consumption_request_id_sha256: digest("9"),
    command_dispatch_consumption_request_id_sha256:
      input.dispatchConsumptionRequestIdSha256,
    application_consumption_state: "consumed",
    application_consumed_at: 1_900_000_010,
    application_response_sha256: digest("a"),
    application_response_bytes: 4096,
    consume_credential_id_sha256: auth.credentialIdSha256,
    consume_request_id_sha256:
      await requestIdSha256(auth.requestId),
    command_consume_request_id_sha256:
      input.dispatchConsumptionRequestIdSha256,
    receipt_digest_sha256: digest("b"),
    recorded_at: 1_900_000_020,
  };
}

describe("operation-5 dispatch consumption", () => {
  it("parses only exact canonical commands", () => {
    const source = canonicalJson(command());
    expect(
      parseConsumeEnableDispatchCommand(
        new TextEncoder().encode(source),
      ),
    ).toEqual(command());
    expect(() =>
      parseConsumeEnableDispatchCommand(
        new TextEncoder().encode(` ${source}`),
      )
    ).toThrowError("noncanonical_json");
    expect(() =>
      parseConsumeEnableDispatchCommand(new TextEncoder().encode(
        canonicalJson({ ...command(), extra: true }),
      ))
    ).toThrowError("invalid_shape");
  });

  it("matches the Rust length-prefixed digest vector", async () => {
    const snapshot: ApplicationDispatchConsumptionSnapshot = {
      schemaVersion: 1,
      contract:
        "cinatoken-relay-container-shard-placement-dispatch-consumption-snapshot-v1",
      ticketIdSha256: "01".repeat(32),
      contractVersion: 1,
      consumptionContract:
        "cinatoken-relay-container-shard-placement-dispatch-consumption-v1",
      authorizationIdSha256: "02".repeat(32),
      campaignId: "14".repeat(32),
      applicationDatabaseIdentitySha256: "03".repeat(32),
      applicationVersionId: "application-version-1",
      applicationGrantDigestSha256: "04".repeat(32),
      authorityClaimDigestSha256: "05".repeat(32),
      authorityDispatchOutboxDigestSha256: "06".repeat(32),
      applicationGrantReceiptDigestSha256: "07".repeat(32),
      operationFiveStartReceiptSha256: "08".repeat(32),
      authorityDispatchClaimDigestSha256:
        "a5613effb227e283ff2a2c10cc6c8fa92a6ad5299aa496c95c26add4e87a90cc",
      authorityDatabaseIdentitySha256: "09".repeat(32),
      authorityLedgerIdentitySha256: "0a".repeat(32),
      authorityLedgerHeadSha256: "08".repeat(32),
      authorityVersionId: "authority-version-1",
      dispatchOwnerSha256: "0b".repeat(32),
      leaseTokenSha256: "0c".repeat(32),
      leaseGeneration: 1,
      leaseExpiresAt: 1_800_000_100,
      normalDeadlineAt: 1_800_000_200,
      permitExpiresAt: 1_800_000_300,
      dispatchClaimCredentialIdSha256: "0d".repeat(32),
      dispatchClaimRequestIdSha256: "0e".repeat(32),
      commandDispatchClaimRequestIdSha256: "0f".repeat(32),
      authorityDispatchClaimedAt: 1_800_000_000,
      controllerServiceName:
        "cinatoken-container-controller-staging",
      controllerEnableOperationIdSha256: "10".repeat(32),
      controllerBaselineVersionId: "controller-baseline-v1",
      controllerEnabledVersionId: "controller-enabled-v1",
      sendAttemptLimit: 1,
      retryLimit: 0,
      missingReadbackAllowsResend: 0,
      applicationDispatchConsumptionCredentialIdSha256:
        "12".repeat(32),
      applicationDispatchConsumptionRequestIdSha256:
        "13".repeat(32),
      commandDispatchConsumptionRequestIdSha256:
        "11".repeat(32),
      dispatchConsumptionDigestSha256: digest("0"),
      consumptionState: "consumed",
      consumedAt: 1_800_000_001,
    };
    expect(await applicationDispatchConsumptionDigest(snapshot)).toBe(
      "1b9f27aba0fe2d26ab23f04746ffcbe6f544e2893357d57e750c1f73a30aaabf",
    );
  });

  it("requires isolated all-or-none overlap credentials", () => {
    const base = {
      SHARD_PLACEMENT_APPLICATION: {
        fetch: vi.fn(),
      },
      SHARD_PLACEMENT_APPLICATION_ISSUER:
        "shard-placement-authority-staging",
      SHARD_PLACEMENT_APPLICATION_AUDIENCE:
        "cinatoken-rust-api-staging",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_KID:
        "consumption-current-v1",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_CREDENTIAL_ID_SHA256:
        digest("1"),
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_CURRENT_SECRET:
        "current-consumption-secret-000000000000000000000000",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID:
        "",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
        "",
      SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET:
        "",
    } as unknown as ApplicationDispatchConsumptionClientEnv;
    expect(() =>
      validateApplicationDispatchConsumptionClientConfig(base)
    ).not.toThrow();
    expect(() =>
      validateApplicationDispatchConsumptionClientConfig({
        ...base,
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID:
          "consumption-previous-v1",
      })
    ).toThrowError(
      "application_dispatch_consumption_client_unavailable",
    );
    expect(() =>
      validateApplicationDispatchConsumptionClientConfig({
        ...base,
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_KID:
          "consumption-previous-v1",
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_CREDENTIAL_ID_SHA256:
          digest("2"),
        SHARD_PLACEMENT_APPLICATION_DISPATCH_CONSUMPTION_HMAC_PREVIOUS_SECRET:
          "previous-consumption-secret-0000000000000000000000",
      })
    ).not.toThrow();
  });

  it("replays historical Authority evidence before any new call", async () => {
    const input = command();
    const auth = authentication();
    const receipt = await storedReceipt(input, auth);
    const readClaim = vi.fn();
    const readDispatchClaim = vi.fn();
    const createApplicationConsumption = vi.fn();
    const createReceipt = vi.fn();
    const dependencies = {
      readClaim,
      readDispatchClaim,
      readReceipt: vi.fn().mockResolvedValue(receipt),
      createApplicationConsumption,
      createReceipt,
    } as unknown as ConsumeEnableDispatchDependencies;
    const result = await consumeControllerEnableDispatch(
      {} as ConsumeEnableDispatchEnv,
      input,
      auth,
      dependencies,
    );
    expect(result).toMatchObject({
      result: "exact_replay",
      dispatchClaimDigestSha256: input.dispatchClaimDigestSha256,
      sendAttemptCreated: false,
      controllerRequestSent: false,
    });
    expect(readClaim).not.toHaveBeenCalled();
    expect(readDispatchClaim).not.toHaveBeenCalled();
    expect(createApplicationConsumption).not.toHaveBeenCalled();
    expect(createReceipt).not.toHaveBeenCalled();
  });
});
