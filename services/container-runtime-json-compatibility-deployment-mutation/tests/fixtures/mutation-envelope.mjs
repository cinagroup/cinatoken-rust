import {
  buildJsonCompatibilityDeploymentTransitionMutationIntent,
  buildJsonCompatibilityDeploymentTransitionOperation,
  buildJsonCompatibilityDeploymentTransitionReadback,
  buildJsonCompatibilityDeploymentTransitionReadbackRequest,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
  buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
} from "../../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  sha256Canonical,
} from "../../../../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  createAuthorizedTransitionFixture,
  digest,
} from "../../../../tests/fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

export async function createMutationEnvelopeFixture({
  now = Math.floor(Date.now() / 1000),
  operationSeed = "deployment-mutation-operation",
  includeApprovalPrivateKey = false,
} = {}) {
  const fixture = await createAuthorizedTransitionFixture({
    now,
    operationSeed,
    includeApprovalPrivateKey,
  });
  const { campaignPlan, statePlan, authorizedTransition } = fixture;
  const transition = authorizedTransition.request.transition;
  const operation = buildJsonCompatibilityDeploymentTransitionOperation({
    campaignPlan,
    statePlan,
    authorizedTransition,
  });
  const sourceAuthenticationRequest =
    buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
      operationIdSha256: operation.operationIdSha256,
      operationDigestSha256: operation.operationDigestSha256,
      authorizedTransitionSha256: sha256Canonical(authorizedTransition),
      campaignPlanDigestSha256: campaignPlan.planDigestSha256,
      statePlanDigestSha256: statePlan.planDigestSha256,
      transition: {
        id: transition.id,
        ordinal: transition.ordinal,
        fromState: transition.fromState,
        toState: transition.toState,
        transitionSha256: sha256Canonical(transition),
      },
      sourceEvidence: authorizedTransition.request.sourceEvidence,
    });
  const sourceAuthentication =
    buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest,
      classification: "authenticated",
      reasonCode: null,
      verifierIdentitySha256:
        authorizedTransition.request.sourceEvidence.sourceVerifierIdentitySha256,
      evidenceSha256: digest(`source-authentication:${operationSeed}`),
      verifiedAt: now,
    });
  const step = transition.steps[0];
  const service = statePlan.services[step.role];
  const sourceArtifactKey = step.fromArtifact === "status-only"
    ? "statusOnly"
    : step.fromArtifact;
  const targetArtifactKey = step.toArtifact === "status-only"
    ? "statusOnly"
    : step.toArtifact;
  const sourceArtifact = service.artifacts[sourceArtifactKey];
  const targetArtifact = service.artifacts[targetArtifactKey];
  const inventoryArtifact = fixture.artifactInventoryReadback.artifacts.find(
    (value) => value.role === step.role && value.artifact === sourceArtifactKey,
  );
  const targetInventoryArtifact = fixture.artifactInventoryReadback.artifacts.find(
    (value) => value.role === step.role && value.artifact === targetArtifactKey,
  );
  if (inventoryArtifact === undefined || targetInventoryArtifact === undefined) {
    throw new Error("deployment inventory fixture is absent");
  }
  const expectedSource = expectedReadback(
    authorizedTransition.request.sourceEvidence.accountIdSha256,
    service,
    sourceArtifact,
    inventoryArtifact,
    authorizedTransition.request.executionAuthority.readback
      .credentialIdSha256,
  );
  const expectedTarget = expectedReadback(
    authorizedTransition.request.sourceEvidence.accountIdSha256,
    service,
    targetArtifact,
    targetInventoryArtifact,
    authorizedTransition.request.executionAuthority.readback
      .credentialIdSha256,
  );
  const sourceReadbacks = [1, 2].map((observationOrdinal) => {
    const request = buildJsonCompatibilityDeploymentTransitionReadbackRequest({
      operation,
      sourceAuthenticationDigestSha256:
        sourceAuthentication.sourceAuthenticationDigestSha256,
      transition: { id: transition.id, ordinal: transition.ordinal },
      step,
      phase: "source",
      observationOrdinal,
      expected: expectedSource,
    });
    return buildJsonCompatibilityDeploymentTransitionReadback({
      readbackRequestSha256: request.readbackRequestSha256,
      readbackServiceIdentitySha256:
        authorizedTransition.request.executionAuthority.readback.identitySha256,
      classification: "observed",
      ...expectedSource,
      readbackRequestIdSha256:
        digest(`readback-request:${operationSeed}:${observationOrdinal}`),
      remoteEvidenceSha256: digest(`remote-evidence:${operationSeed}`),
      authenticationEvidenceSha256:
        digest(`readback-authentication:${operationSeed}`),
      observedAt: now + (observationOrdinal - 1) * 5,
    });
  });
  const mutationIntent =
    buildJsonCompatibilityDeploymentTransitionMutationIntent(
      authorizedTransition,
      operation,
      sourceAuthentication,
      step,
      expectedTarget,
      sourceReadbacks,
    );
  return {
    now: now + 5,
    accountId: "cloudflare-account-staging",
    accountIdSha256:
      authorizedTransition.request.executionAuthority.accountIdSha256,
    credentialIdSha256:
      authorizedTransition.request.executionAuthority.mutation
        .credentialIdSha256,
    versionId:
      authorizedTransition.request.executionAuthority.mutation.versionId,
    envelope: {
      campaignPlan,
      statePlan,
      authorizedTransition,
      sourceAuthentication,
      mutationIntent,
      sourceReadbacks,
    },
    ...(includeApprovalPrivateKey
      ? { approvalPrivateKeyBytes: fixture.approvalPrivateKeyBytes }
      : {}),
  };
}

export function acceptedCloudflareResponse(mutation) {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: {
      id: "deployment-created-once",
      strategy: "percentage",
      annotations: {
        "workers/message": mutation.mutationAnnotation,
      },
      versions: [
        { version_id: mutation.targetVersionId, percentage: 100 },
      ],
    },
  }), {
    status: 201,
    headers: {
      "content-type": "application/json",
      "cf-ray": "mutation-test-ray",
    },
  });
}

function expectedReadback(
  accountIdSha256,
  service,
  artifact,
  inventoryArtifact,
  authenticationIdentitySha256,
) {
  return {
    environment: "staging",
    accountIdSha256,
    serviceName: service.serviceName,
    entrypoint: service.entrypoint,
    versionId: artifact.versionId,
    configSha256: artifact.configSha256,
    deploymentState: artifact.deploymentState,
    gates: structuredClone(artifact.gates),
    privateRpcOnly: service.privateRpcOnly,
    workersDev: service.workersDev,
    previewUrls: service.previewUrls,
    bindingSetSha256: inventoryArtifact.bindingSetSha256,
    routeSetSha256: inventoryArtifact.routeSetSha256,
    secretNameSetSha256: inventoryArtifact.secretNameSetSha256,
    durableObjectMigrationSetSha256:
      inventoryArtifact.durableObjectMigrationSetSha256,
    authenticationIdentitySha256,
  };
}
