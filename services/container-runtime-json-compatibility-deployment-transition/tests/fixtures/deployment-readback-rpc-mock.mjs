import { WorkerEntrypoint } from "cloudflare:workers";

import {
  buildJsonCompatibilityDeploymentTransitionReadback,
  validateJsonCompatibilityDeploymentTransitionReadbackExecution,
} from "../../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  sha256Canonical,
} from "../../../../tools/container_runtime_json_compatibility_campaign.mjs";

let readbackCalls = 0;
const observationBases = new Map();

export class JsonCompatibilityDeploymentReadbackEntrypoint
  extends WorkerEntrypoint {
  async readDeploymentState(input) {
    const execution =
      validateJsonCompatibilityDeploymentTransitionReadbackExecution(input);
    readbackCalls += 1;
    const request = execution.readbackRequest;
    const expected = execution.expected;
    const authority =
      execution.authorizedTransition.request.executionAuthority.readback;
    const observationKey = [
      request.operation.operationIdSha256,
      request.step.ordinal,
      request.phase,
    ].join(":");
    if (!observationBases.has(observationKey)) {
      observationBases.set(observationKey, Math.floor(Date.now() / 1000));
    }
    const observedAt = observationBases.get(observationKey)
      + (request.observationOrdinal - 1) * 5;
    return buildJsonCompatibilityDeploymentTransitionReadback({
      readbackRequestSha256: request.readbackRequestSha256,
      readbackServiceIdentitySha256: authority.identitySha256,
      classification: "observed",
      ...expected,
      authenticationIdentitySha256: authority.credentialIdSha256,
      readbackRequestIdSha256: sha256Canonical({
        readbackRequestSha256: request.readbackRequestSha256,
        readbackCalls,
      }),
      remoteEvidenceSha256: sha256Canonical({
        readbackRequestSha256: request.readbackRequestSha256,
        expected,
        readbackCalls,
      }),
      authenticationEvidenceSha256: sha256Canonical({
        authenticationIdentitySha256: authority.credentialIdSha256,
        readbackCalls,
      }),
      observedAt,
    });
  }
}

export class JsonCompatibilityDeploymentReadbackMockControlEntrypoint
  extends WorkerEntrypoint {
  reset() {
    readbackCalls = 0;
    observationBases.clear();
  }

  getCallCount() {
    return readbackCalls;
  }
}

export default class JsonCompatibilityDeploymentReadbackMockDefaultEntrypoint
  extends WorkerEntrypoint {}
