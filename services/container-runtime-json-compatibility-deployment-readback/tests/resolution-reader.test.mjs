import { describe, expect, test, vi } from "vitest";

import {
  buildJsonCompatibilityDeploymentExecutionDisabledEvidence,
  buildJsonCompatibilityDeploymentResolverIdentity,
  signJsonCompatibilityDeploymentResolution,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  createMutationEnvelopeFixture,
} from "../../container-runtime-json-compatibility-deployment-mutation/tests/fixtures/mutation-envelope.mjs";
import {
  digest,
} from "../../../tests/fixtures/container-runtime-json-compatibility-deployment-transition.mjs";
import {
  READBACK_ENTRYPOINT,
  READBACK_SERVICE_NAME,
} from "../src/protocol";
import { readDeploymentStateForResolution } from "../src/reader";

describe("deployment Reader recovery RPC", () => {
  test("verifies the independent recovery signature before token or network access", async () => {
    const transitionNow = Math.floor(Date.now() / 1_000) - 1_500;
    const fixture = await createMutationEnvelopeFixture({
      now: transitionNow,
      operationSeed: "deployment-resolution-reader-operation",
      includeApprovalPrivateKey: true,
    });
    const privateKey = fixture.approvalPrivateKeyBytes;
    try {
      const resolutionNow = transitionNow + 1_200;
      const envelope = fixture.envelope;
      const authority =
        envelope.authorizedTransition.request.executionAuthority;
      const sourceAuthentication =
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest: envelope.sourceAuthentication.request,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            envelope.authorizedTransition.request.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("resolution-reader-fresh-source"),
          verifiedAt: resolutionNow,
        });
      const resolver = buildJsonCompatibilityDeploymentResolverIdentity({
        accountIdSha256: authority.accountIdSha256,
        serviceName:
          "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging",
        entrypoint:
          "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
        versionId: "resolution-reader-test-version-001",
        profileVersion: 1,
        privateRpcOnly: true,
        capability: "resolve-readback-only",
      });
      const executionDisabledEvidence =
        buildJsonCompatibilityDeploymentExecutionDisabledEvidence({
          accountIdSha256: authority.accountIdSha256,
          coordinatorServiceName: authority.coordinator.serviceName,
          coordinatorEntrypoint: authority.coordinator.entrypoint,
          coordinatorVersionId: authority.coordinator.versionId,
          coordinatorIdentitySha256: authority.coordinator.identitySha256,
          coordinatorConfigurationSha256:
            digest("resolution-reader-coordinator-configuration"),
          callerTopologySha256:
            digest("resolution-reader-caller-topology"),
          executionDisabledAt: resolutionNow - 30,
          maximumAdmittedRequestLifetimeSeconds: 10,
          propagationAllowanceSeconds: 10,
          clockSkewAllowanceSeconds: 10,
          observedAt: resolutionNow,
        });
      const authorizedResolution = signJsonCompatibilityDeploymentResolution({
        campaignPlan: envelope.campaignPlan,
        statePlan: envelope.statePlan,
        authorizedTransition: envelope.authorizedTransition,
        operationCreatedAt: transitionNow + 1,
        journalHeadOrdinal: 4,
        journalHeadDigestSha256:
          envelope.mutationIntent.mutationIntentSha256,
        pendingMutationIntentSha256:
          envelope.mutationIntent.mutationIntentSha256,
        claimGeneration: 1,
        resolver,
        sourceAuthentication,
        executionDisabledEvidence,
        privateKeyBytes: privateKey,
        now: new Date(resolutionNow * 1_000),
      });
      const readbackRequest =
        buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
          campaignPlan: envelope.campaignPlan,
          statePlan: envelope.statePlan,
          authorizedTransition: envelope.authorizedTransition,
          sourceAuthentication,
          originalSourceAuthentication: envelope.sourceAuthentication,
          mutationIntent: envelope.mutationIntent,
          sourceReadbacks: envelope.sourceReadbacks,
          observationOrdinal: 1,
        }, { now: new Date(resolutionNow * 1_000) });
      const tamperedResolution = structuredClone(authorizedResolution);
      tamperedResolution.request.resolver.versionId = "substituted-version";
      const tokenRead = vi.fn(() => {
        throw new Error("token must not be read");
      });
      const env = {
        CF_VERSION_METADATA: { id: authority.readback.versionId },
        ENVIRONMENT: "staging",
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENABLED: "true",
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_PROFILE_VERSION: "1",
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME:
          READBACK_SERVICE_NAME,
        JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT:
          READBACK_ENTRYPOINT,
        CLOUDFLARE_ACCOUNT_ID: "cloudflare-account-staging",
        CLOUDFLARE_ACCOUNT_ID_SHA256: authority.accountIdSha256,
        CLOUDFLARE_DEPLOYMENT_READ_CREDENTIAL_ID_SHA256:
          authority.readback.credentialIdSha256,
      };
      Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN", {
        get: tokenRead,
        configurable: true,
      });
      const fetchImpl = vi.fn(async () => {
        throw new Error("network must not be reached");
      });
      await expect(readDeploymentStateForResolution(env, {
        campaignPlan: envelope.campaignPlan,
        statePlan: envelope.statePlan,
        authorizedTransition: envelope.authorizedTransition,
        authorizedResolution: tamperedResolution,
        sourceAuthentication,
        originalSourceAuthentication: envelope.sourceAuthentication,
        mutationIntent: envelope.mutationIntent,
        sourceReadbacks: envelope.sourceReadbacks,
        readbackRequest,
      }, {
        fetch: fetchImpl,
        nowMilliseconds: () => resolutionNow * 1_000,
      })).rejects.toThrow(/resolution|resolver identity/);
      expect(tokenRead).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();

      const substitutedSourceAuthentication =
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest: envelope.sourceAuthentication.request,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            envelope.authorizedTransition.request.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("resolution-reader-substituted-fresh-source"),
          verifiedAt: resolutionNow,
        });
      const substitutedReadbackRequest =
        buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
          campaignPlan: envelope.campaignPlan,
          statePlan: envelope.statePlan,
          authorizedTransition: envelope.authorizedTransition,
          sourceAuthentication: substitutedSourceAuthentication,
          originalSourceAuthentication: envelope.sourceAuthentication,
          mutationIntent: envelope.mutationIntent,
          sourceReadbacks: envelope.sourceReadbacks,
          observationOrdinal: 1,
        }, { now: new Date(resolutionNow * 1_000) });
      await expect(readDeploymentStateForResolution(env, {
        campaignPlan: envelope.campaignPlan,
        statePlan: envelope.statePlan,
        authorizedTransition: envelope.authorizedTransition,
        authorizedResolution,
        sourceAuthentication: substitutedSourceAuthentication,
        originalSourceAuthentication: envelope.sourceAuthentication,
        mutationIntent: envelope.mutationIntent,
        sourceReadbacks: envelope.sourceReadbacks,
        readbackRequest: substitutedReadbackRequest,
      }, {
        fetch: fetchImpl,
        nowMilliseconds: () => resolutionNow * 1_000,
      })).rejects.toThrow(/source authentication is not owner authorized/);
      expect(tokenRead).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();

      Object.defineProperty(env, "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN", {
        value: "resolution-reader-test-token",
        configurable: true,
      });
      const accepted = await readDeploymentStateForResolution(env, {
        campaignPlan: envelope.campaignPlan,
        statePlan: envelope.statePlan,
        authorizedTransition: envelope.authorizedTransition,
        authorizedResolution,
        sourceAuthentication,
        originalSourceAuthentication: envelope.sourceAuthentication,
        mutationIntent: envelope.mutationIntent,
        sourceReadbacks: envelope.sourceReadbacks,
        readbackRequest,
      }, {
        fetch: fetchImpl,
        nowMilliseconds: () => resolutionNow * 1_000,
      });
      expect(accepted).toMatchObject({
        classification: "ambiguous",
        readbackRequestSha256: readbackRequest.readbackRequestSha256,
        readbackServiceIdentitySha256: authority.readback.identitySha256,
      });
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      privateKey.fill(0);
    }
  });
});
