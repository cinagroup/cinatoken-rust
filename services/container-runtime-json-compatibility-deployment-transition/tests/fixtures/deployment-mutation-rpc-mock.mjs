import { WorkerEntrypoint } from "cloudflare:workers";

import {
  buildJsonCompatibilityDeploymentTransitionMutationOutcome,
  validateJsonCompatibilityDeploymentTransitionMutationExecution,
} from "../../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  sha256Canonical,
} from "../../../../tools/container_runtime_json_compatibility_campaign.mjs";

let mutationCalls = 0;

export class JsonCompatibilityDeploymentMutationEntrypoint
  extends WorkerEntrypoint {
  async mutateDeploymentOnce(input) {
    const execution =
      validateJsonCompatibilityDeploymentTransitionMutationExecution(input);
    mutationCalls += 1;
    const intent = execution.mutationIntent;
    const authority =
      execution.authorizedTransition.request.executionAuthority.mutation;
    const mutationRpcRequestSha256 = sha256Canonical(input);
    return buildJsonCompatibilityDeploymentTransitionMutationOutcome({
      mutationIntent: intent,
      mutationRpcRequestSha256,
      mutationServiceIdentitySha256: authority.identitySha256,
      authenticationIdentitySha256: authority.credentialIdSha256,
      mutationRequestSha256: sha256Canonical({
        method: "POST",
        percentage: 100,
        targetVersionId: intent.targetVersionId,
        mutationIntentSha256: intent.mutationIntentSha256,
      }),
      mutationAnnotationSha256: sha256Canonical({
        operationIdSha256: intent.operationIdSha256,
        transitionId: intent.transitionId,
        stepOrdinal: intent.stepOrdinal,
        mutationIntentSha256: intent.mutationIntentSha256,
      }),
      endpointSha256: sha256Canonical({
        accountIdSha256: execution.expectedTarget.accountIdSha256,
        serviceName: intent.serviceName,
        endpoint: "deployments",
      }),
      sentAt: Math.floor(Date.now() / 1000),
      classification: "accepted",
      httpStatus: 200,
      responseBodySha256: sha256Canonical({
        mutationIntentSha256: intent.mutationIntentSha256,
        mutationCalls,
      }),
      responseRequestIdSha256: sha256Canonical({
        mutationRpcRequestSha256,
        mutationCalls,
      }),
      responseBytes: 128,
    });
  }
}

export class JsonCompatibilityDeploymentMutationMockControlEntrypoint
  extends WorkerEntrypoint {
  reset() {
    mutationCalls = 0;
  }

  getCallCount() {
    return mutationCalls;
  }
}

export default class JsonCompatibilityDeploymentMutationMockDefaultEntrypoint
  extends WorkerEntrypoint {}
