import {
  CONTROLLER_DISABLE_COMMAND_CONTRACT,
  DISABLE_CREATE_REQUEST_CONTRACT,
  DISABLE_IDEMPOTENCY_CONTRACT,
  type DisableCreateRequest,
  type FrozenControllerDisableCommand,
} from "../src/disable_protocol";
import { canonicalJson, sha256Canonical } from "../src/protocol";

export const disableCreateCredentialIdSha256 = "c".repeat(64);
export const disableStatusCredentialIdSha256 = "d".repeat(64);
export const disableCreateSecret =
  "disable-create-test-secret-0000000000000000000000000000";
export const disableStatusSecret =
  "disable-status-test-secret-0000000000000000000000000000";

export function disableCommandFixture(
  overrides: Partial<FrozenControllerDisableCommand> = {},
): FrozenControllerDisableCommand {
  return {
    schemaVersion: 1,
    contract: CONTROLLER_DISABLE_COMMAND_CONTRACT,
    authorizationIdSha256: "1".repeat(64),
    claimDigestSha256: "2".repeat(64),
    operation14IdSha256: "3".repeat(64),
    authorityDatabaseIdentitySha256: "4".repeat(64),
    authorityLedgerIdentitySha256: "5".repeat(64),
    authorityLedgerHeadSha256: "6".repeat(64),
    authorityVersionId: "authority-version-14",
    leaseOwnerSha256: "7".repeat(64),
    leaseTokenSha256: "8".repeat(64),
    leaseGeneration: 4,
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerEnabledSourceVersionId: "controller-enabled-version",
    controllerBaselineTargetVersionId: "controller-baseline-version",
    sendAttemptLimit: 1,
    retryLimit: 0,
    ...overrides,
  };
}

export async function disableCreateRequestFixture(
  command = disableCommandFixture(),
): Promise<DisableCreateRequest> {
  const controllerDisableCommandDigestSha256 =
    await sha256Canonical(command);
  const gatewayDisableIdempotencyKeySha256 = await sha256Canonical({
    schemaVersion: 1,
    contract: DISABLE_IDEMPOTENCY_CONTRACT,
    attemptGeneration: 1,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    controllerDisableCommandDigestSha256,
    operation14IdSha256: command.operation14IdSha256,
  });
  return {
    schemaVersion: 1,
    contract: DISABLE_CREATE_REQUEST_CONTRACT,
    command,
    controllerDisableCommandDigestSha256,
    gatewayDisableIdempotencyKeySha256,
    authorityAttemptDigestSha256: "9".repeat(64),
    sendStartedEventDigestSha256: "a".repeat(64),
  };
}

export async function disableCreateRequestBody(
  command = disableCommandFixture(),
): Promise<string> {
  return canonicalJson(await disableCreateRequestFixture(command));
}
