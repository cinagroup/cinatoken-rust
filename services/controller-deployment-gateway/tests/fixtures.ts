import {
  CREATE_REQUEST_CONTRACT,
  GATEWAY_IDEMPOTENCY_CONTRACT,
  canonicalJson,
  sha256Canonical,
  type CreateDeploymentRequest,
  type FrozenControllerEnableCommand,
} from "../src/protocol";

export const createCredentialIdSha256 = "a".repeat(64);
export const statusCredentialIdSha256 = "b".repeat(64);
export const createSecret =
  "create-test-secret-000000000000000000000000000000000000";
export const statusSecret =
  "status-test-secret-000000000000000000000000000000000000";

export function commandFixture(
  overrides: Partial<FrozenControllerEnableCommand> = {},
): FrozenControllerEnableCommand {
  return {
    schemaVersion: 1,
    contract: "cinatoken-controller-deployment-gateway-enable-command-v1",
    authorizationIdSha256: "1".repeat(64),
    claimDigestSha256: "2".repeat(64),
    dispatchClaimDigestSha256: "3".repeat(64),
    dispatchConsumptionReceiptDigestSha256: "4".repeat(64),
    applicationDispatchConsumptionDigestSha256: "5".repeat(64),
    applicationTicketIdSha256: "6".repeat(64),
    campaignId: "7".repeat(64),
    applicationDatabaseIdentitySha256: "8".repeat(64),
    applicationVersionId: "application-version-1",
    authorityDatabaseIdentitySha256: "9".repeat(64),
    authorityLedgerIdentitySha256: "a".repeat(64),
    authorityLedgerHeadSha256: "b".repeat(64),
    authorityVersionId: "authority-version-1",
    dispatchOwnerSha256: "c".repeat(64),
    leaseTokenSha256: "d".repeat(64),
    leaseGeneration: 1,
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerEnableOperationIdSha256: "e".repeat(64),
    controllerBaselineVersionId: "controller-baseline-version",
    controllerEnabledVersionId: "controller-enabled-version",
    sendAttemptLimit: 1,
    retryLimit: 0,
    ...overrides,
  };
}

export async function createRequestFixture(
  command = commandFixture(),
): Promise<CreateDeploymentRequest> {
  const controllerCommandDigestSha256 = await sha256Canonical(command);
  const gatewayIdempotencyKeySha256 = await sha256Canonical({
    schemaVersion: 1,
    contract: GATEWAY_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    authorizationIdSha256: command.authorizationIdSha256,
    dispatchConsumptionReceiptDigestSha256:
      command.dispatchConsumptionReceiptDigestSha256,
    controllerCommandDigestSha256,
    controllerEnableOperationIdSha256:
      command.controllerEnableOperationIdSha256,
  });
  return {
    schemaVersion: 1,
    contract: CREATE_REQUEST_CONTRACT,
    command,
    controllerCommandDigestSha256,
    gatewayIdempotencyKeySha256,
    authorityAttemptDigestSha256: "f".repeat(64),
    sendStartedEventDigestSha256: "0".repeat(64),
  };
}

export async function createRequestBody(
  command = commandFixture(),
): Promise<string> {
  return canonicalJson(await createRequestFixture(command));
}
