import {
  sha256Canonical,
  type FrozenControllerEnableCommand,
} from "./protocol";

export const DEPLOYMENT_STATE_CONTRACT =
  "cinatoken-controller-deployment-gateway-deployment-state-v1";

export interface DeploymentStateObservation {
  classification: string;
  deploymentsHttpStatus: number | null;
  versionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  targetVersionSha256: string | null;
}

export interface StableObservation {
  classification: string;
  statusRequestIdSha256: string;
  recordedAt: number;
  deploymentStateDigestSha256: string;
}

export async function deploymentStateDigest(
  gatewayIdempotencyKeySha256: string,
  controllerCommandDigestSha256: string,
  command: FrozenControllerEnableCommand,
  observation: DeploymentStateObservation,
): Promise<string> {
  return sha256Canonical({
    schemaVersion: 1,
    contract: DEPLOYMENT_STATE_CONTRACT,
    gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256,
    authorizationIdSha256: command.authorizationIdSha256,
    controllerEnableOperationIdSha256:
      command.controllerEnableOperationIdSha256,
    controllerServiceName: command.controllerServiceName,
    controllerEnabledVersionId: command.controllerEnabledVersionId,
    classification: observation.classification,
    deploymentsHttpStatus: observation.deploymentsHttpStatus,
    versionHttpStatus: observation.versionHttpStatus,
    deploymentSetSha256: observation.deploymentSetSha256,
    targetVersionSha256: observation.targetVersionSha256,
  });
}

export function isTargetStable(
  current: StableObservation,
  previous: StableObservation | null,
  stabilityMinimumSeconds: number,
): boolean {
  return current.classification === "target_observed"
    && previous?.classification === "target_observed"
    && previous.statusRequestIdSha256 !== current.statusRequestIdSha256
    && current.recordedAt - previous.recordedAt >= stabilityMinimumSeconds
    && previous.deploymentStateDigestSha256
      === current.deploymentStateDigestSha256;
}
