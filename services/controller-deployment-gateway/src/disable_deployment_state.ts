import { sha256Canonical } from "./protocol";
import type { FrozenControllerDisableCommand } from "./disable_protocol";

export const DISABLE_DEPLOYMENT_STATE_CONTRACT =
  "cinatoken-controller-deployment-gateway-disable-state-v1";

export interface DisableStateObservation {
  classification: string;
  deploymentsHttpStatus: number | null;
  baselineVersionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  baselineVersionSha256: string | null;
}

export interface StableDisableObservation {
  classification: string;
  statusRequestIdSha256: string;
  recordedAt: number;
  stateDigestSha256: string;
}

export async function disableDeploymentStateDigest(
  gatewayDisableIdempotencyKeySha256: string,
  controllerDisableCommandDigestSha256: string,
  command: FrozenControllerDisableCommand,
  observation: DisableStateObservation,
): Promise<string> {
  return sha256Canonical({
    schemaVersion: 1,
    contract: DISABLE_DEPLOYMENT_STATE_CONTRACT,
    gatewayDisableIdempotencyKeySha256,
    controllerDisableCommandDigestSha256,
    authorizationIdSha256: command.authorizationIdSha256,
    claimDigestSha256: command.claimDigestSha256,
    operation14IdSha256: command.operation14IdSha256,
    controllerServiceName: command.controllerServiceName,
    controllerEnabledSourceVersionId:
      command.controllerEnabledSourceVersionId,
    controllerBaselineTargetVersionId:
      command.controllerBaselineTargetVersionId,
    classification: observation.classification,
    deploymentsHttpStatus: observation.deploymentsHttpStatus,
    baselineVersionHttpStatus: observation.baselineVersionHttpStatus,
    deploymentSetSha256: observation.deploymentSetSha256,
    baselineVersionSha256: observation.baselineVersionSha256,
  });
}

export function isDisableTargetStable(
  current: StableDisableObservation,
  previous: StableDisableObservation | null,
  stabilityMinimumSeconds: number,
): boolean {
  return current.classification === "exact_disable_observed"
    && previous?.classification === "exact_disable_observed"
    && previous.statusRequestIdSha256 !== current.statusRequestIdSha256
    && current.recordedAt - previous.recordedAt >= stabilityMinimumSeconds
    && previous.stateDigestSha256 === current.stateDigestSha256;
}
