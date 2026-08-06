import { describe, expect, test } from "bun:test";

import {
  buildJsonCompatibilityDeploymentResolutionReceipt,
  buildJsonCompatibilityDeploymentResolverIdentity,
  buildJsonCompatibilityDeploymentExecutionDisabledEvidence,
  signJsonCompatibilityDeploymentResolution,
  validateJsonCompatibilityDeploymentExecutionDisabledEvidence,
  validateJsonCompatibilityDeploymentResolutionAuthorization,
  validateJsonCompatibilityDeploymentResolutionReceipt,
} from "../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionReadback,
  buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
  validateJsonCompatibilityDeploymentTransitionRecoveryReadbackExecution,
} from "../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  createMutationEnvelopeFixture,
} from "../services/container-runtime-json-compatibility-deployment-mutation/tests/fixtures/mutation-envelope.mjs";
import {
  digest,
} from "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";
import {
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";

describe("JSON compatibility deployment inflight resolution", () => {
  test("requires a separately signed, quiesced, Reader-only recovery authority", async () => {
    const fixture = await resolutionFixture();
    try {
      const validated =
        validateJsonCompatibilityDeploymentResolutionAuthorization(
          fixture.campaignPlan,
          fixture.statePlan,
          fixture.authorizedTransition,
          fixture.authorizedResolution,
          { now: new Date(fixture.resolutionNow * 1000), requireUsableWindow: true },
        );
      expect(validated.request).toMatchObject({
        claimGeneration: 1,
        mutationPermitted: false,
        readbackLimit: 2,
        claimLeaseSeconds: 45,
        nextTransitionAllowed: false,
        executionRetryPermitted: false,
        sourceAuthenticationDigestSha256:
          fixture.freshSourceAuthentication
            .sourceAuthenticationDigestSha256,
        sourceAuthenticationVerifiedAt: fixture.resolutionNow,
        sourceAuthenticationExpiresAt: fixture.resolutionNow + 60,
        resolver: {
          capability: "resolve-readback-only",
          cloudflareApiCredentialPresent: false,
          mutationBindingPresent: false,
          sourceVerifierBindingPresent: false,
        },
      });
      expect(fixture.resolutionNow).toBeGreaterThan(
        fixture.authorizedTransition.approval.subject.expiresAt,
      );

      const tampered = structuredClone(fixture.authorizedResolution);
      tampered.request.resolver.versionId = "wrong-resolver-version";
      expect(() => validateJsonCompatibilityDeploymentResolutionAuthorization(
        fixture.campaignPlan,
        fixture.statePlan,
        fixture.authorizedTransition,
        tampered,
      )).toThrow(/resolver identity|resolution request/);

      const incompleteDrainEvidence =
        buildJsonCompatibilityDeploymentExecutionDisabledEvidence({
          ...fixture.executionDisabledEvidence,
          executionDisabledAt: fixture.resolutionNow,
          quiescenceSatisfiedAt: fixture.resolutionNow + 30,
          observedAt: fixture.resolutionNow + 30,
        });
      expect(() => signJsonCompatibilityDeploymentResolution({
        ...fixture.signingInput,
        executionDisabledEvidence: incompleteDrainEvidence,
        privateKeyBytes: fixture.approvalPrivateKeyBytes,
        now: new Date(fixture.resolutionNow * 1000),
      })).toThrow(/stale or from the future/);

      const {
        evidenceSha256: _evidenceSha256,
        ...contradictoryEvidenceSubject
      } = structuredClone(fixture.executionDisabledEvidence);
      contradictoryEvidenceSubject.executionEnabled = true;
      const contradictoryEvidence = {
        ...contradictoryEvidenceSubject,
        evidenceSha256: sha256Canonical(contradictoryEvidenceSubject),
      };
      expect(() =>
        validateJsonCompatibilityDeploymentExecutionDisabledEvidence(
          contradictoryEvidence,
        )).toThrow(/execution-disabled evidence/);

      const agedSourceAuthentication =
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest:
            fixture.freshSourceAuthentication.request,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            fixture.authorizedTransition.request.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("deployment-resolution-aged-source-proof"),
          verifiedAt: fixture.resolutionNow - 30,
        });
      expect(() => signJsonCompatibilityDeploymentResolution({
        ...fixture.signingInput,
        sourceAuthentication: agedSourceAuthentication,
        privateKeyBytes: fixture.approvalPrivateKeyBytes,
        now: new Date(fixture.resolutionNow * 1000),
      })).toThrow(/complete claim lease/);
    } finally {
      fixture.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("uses a fresh source proof for target-only recovery without changing the original intent", async () => {
    const fixture = await resolutionFixture();
    try {
      const requests = [1, 2].map((observationOrdinal) =>
        buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
          campaignPlan: fixture.campaignPlan,
          statePlan: fixture.statePlan,
          authorizedTransition: fixture.authorizedTransition,
          sourceAuthentication: fixture.freshSourceAuthentication,
          originalSourceAuthentication: fixture.originalSourceAuthentication,
          mutationIntent: fixture.mutationIntent,
          sourceReadbacks: fixture.sourceReadbacks,
          observationOrdinal,
        }, { now: new Date(fixture.resolutionNow * 1000) }));

      expect(requests.map((request) => request.phase))
        .toEqual(["target", "target"]);
      expect(requests[0].sourceAuthenticationDigestSha256).toBe(
        fixture.freshSourceAuthentication.sourceAuthenticationDigestSha256,
      );
      expect(fixture.mutationIntent.sourceAuthenticationDigestSha256).toBe(
        fixture.originalSourceAuthentication
          .sourceAuthenticationDigestSha256,
      );
      expect(requests[0].sourceAuthenticationDigestSha256).not.toBe(
        fixture.mutationIntent.sourceAuthenticationDigestSha256,
      );

      expect(() => validateJsonCompatibilityDeploymentTransitionRecoveryReadbackExecution({
        campaignPlan: fixture.campaignPlan,
        statePlan: fixture.statePlan,
        authorizedTransition: fixture.authorizedTransition,
        sourceAuthentication: fixture.freshSourceAuthentication,
        originalSourceAuthentication: fixture.originalSourceAuthentication,
        mutationIntent: fixture.mutationIntent,
        sourceReadbacks: fixture.sourceReadbacks,
        readbackRequest: requests[0],
      }, { now: new Date(fixture.resolutionNow * 1000) })).not.toThrow();
    } finally {
      fixture.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("seals a separate non-progressing receipt from two stable target readbacks", async () => {
    const fixture = await resolutionFixture();
    try {
      const targetReadbackRequests = [1, 2].map((observationOrdinal) =>
        buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
            campaignPlan: fixture.campaignPlan,
            statePlan: fixture.statePlan,
            authorizedTransition: fixture.authorizedTransition,
            sourceAuthentication: fixture.freshSourceAuthentication,
            originalSourceAuthentication: fixture.originalSourceAuthentication,
            mutationIntent: fixture.mutationIntent,
            sourceReadbacks: fixture.sourceReadbacks,
            observationOrdinal,
          }, { now: new Date(fixture.resolutionNow * 1000) }));
      const targetReadbacks = targetReadbackRequests.map((request) => {
        const observationOrdinal = request.observationOrdinal;
        return buildJsonCompatibilityDeploymentTransitionReadback({
          ...request.expected,
          readbackRequestSha256: request.readbackRequestSha256,
          readbackServiceIdentitySha256:
            fixture.authorizedTransition.request.executionAuthority.readback
              .identitySha256,
          classification: "observed",
          readbackRequestIdSha256:
            digest(`resolution-readback-${observationOrdinal}`),
          remoteEvidenceSha256:
            digest(`resolution-remote-${observationOrdinal}`),
          authenticationEvidenceSha256:
            digest(`resolution-auth-${observationOrdinal}`),
          observedAt: fixture.resolutionNow + (observationOrdinal - 1) * 5,
        });
      });
      const receipt = buildJsonCompatibilityDeploymentResolutionReceipt({
        campaignPlan: fixture.campaignPlan,
        statePlan: fixture.statePlan,
        authorizedTransition: fixture.authorizedTransition,
        authorizedResolution: fixture.authorizedResolution,
        sourceAuthentication: fixture.freshSourceAuthentication,
        originalSourceAuthentication: fixture.originalSourceAuthentication,
        sourceReadbacks: fixture.sourceReadbacks,
        mutationIntent: fixture.mutationIntent,
        mutationOutcome: null,
        targetReadbackRequests,
        targetReadbacks,
        startedAt: fixture.resolutionNow,
        finishedAt: fixture.resolutionNow + 5,
        classification: "target_confirmed",
        reasonCode: "target_state_confirmed",
      });
      expect(validateJsonCompatibilityDeploymentResolutionReceipt(receipt))
        .toMatchObject({
          classification: "target_confirmed",
          mutationOutcomeEvidence: "missing",
          nextTransitionAllowed: false,
          mutationAttempts: 0,
          automaticRetries: 0,
          mutationCalled: false,
          executionRetryPermitted: false,
        });

      const swappedRequests = structuredClone(receipt);
      swappedRequests.targetReadbackRequests.reverse();
      expect(() => validateJsonCompatibilityDeploymentResolutionReceipt(
        resealResolutionReceipt(swappedRequests),
      )).toThrow(/target readback ordinal/);

      const substitutedReader = structuredClone(receipt);
      substitutedReader.readbackIdentitySha256 =
        digest("resolution-substituted-reader");
      expect(() => validateJsonCompatibilityDeploymentResolutionReceipt(
        resealResolutionReceipt(substitutedReader),
      )).toThrow(/Reader identity binding/);

      const reclassified = structuredClone(receipt);
      reclassified.classification = "manual_review_required";
      reclassified.reasonCode = "target_state_drift";
      expect(() => validateJsonCompatibilityDeploymentResolutionReceipt(
        resealResolutionReceipt(reclassified),
      )).toThrow(/evidence contradicts classification/);
    } finally {
      fixture.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("separates stable non-target evidence from unstable evidence", async () => {
    const fixture = await resolutionFixture();
    try {
      const requests = [1, 2].map((observationOrdinal) =>
        buildJsonCompatibilityDeploymentTransitionRecoveryReadbackRequest({
          campaignPlan: fixture.campaignPlan,
          statePlan: fixture.statePlan,
          authorizedTransition: fixture.authorizedTransition,
          sourceAuthentication: fixture.freshSourceAuthentication,
          originalSourceAuthentication: fixture.originalSourceAuthentication,
          mutationIntent: fixture.mutationIntent,
          sourceReadbacks: fixture.sourceReadbacks,
          observationOrdinal,
        }, { now: new Date(fixture.resolutionNow * 1000) }));
      const observation = (request, label, versionId) =>
        buildJsonCompatibilityDeploymentTransitionReadback({
          ...request.expected,
          versionId,
          readbackRequestSha256: request.readbackRequestSha256,
          readbackServiceIdentitySha256:
            fixture.authorizedTransition.request.executionAuthority.readback
              .identitySha256,
          classification: "observed",
          readbackRequestIdSha256: digest(`resolution-${label}-request`),
          remoteEvidenceSha256: digest(`resolution-${label}-remote`),
          authenticationEvidenceSha256: digest(`resolution-${label}-auth`),
          observedAt: fixture.resolutionNow + request.observationOrdinal * 5,
        });
      const targetVersionId = requests[0].expected.versionId;
      const driftVersionId = "stable-non-target-version";
      const driftReadbacks = requests.map((request, index) =>
        observation(request, `drift-${index}`, driftVersionId));
      const manual = buildJsonCompatibilityDeploymentResolutionReceipt({
        campaignPlan: fixture.campaignPlan,
        statePlan: fixture.statePlan,
        authorizedTransition: fixture.authorizedTransition,
        authorizedResolution: fixture.authorizedResolution,
        sourceAuthentication: fixture.freshSourceAuthentication,
        originalSourceAuthentication: fixture.originalSourceAuthentication,
        sourceReadbacks: fixture.sourceReadbacks,
        mutationIntent: fixture.mutationIntent,
        mutationOutcome: null,
        targetReadbackRequests: requests,
        targetReadbacks: driftReadbacks,
        startedAt: fixture.resolutionNow,
        finishedAt: fixture.resolutionNow + 10,
        classification: "manual_review_required",
        reasonCode: "target_state_drift",
      });
      expect(validateJsonCompatibilityDeploymentResolutionReceipt(manual)
        .classification).toBe("manual_review_required");

      const unstableReadbacks = [
        observation(requests[0], "unstable-shared", targetVersionId),
        observation(requests[1], "unstable-shared", targetVersionId),
      ];
      const inconclusive = buildJsonCompatibilityDeploymentResolutionReceipt({
        campaignPlan: fixture.campaignPlan,
        statePlan: fixture.statePlan,
        authorizedTransition: fixture.authorizedTransition,
        authorizedResolution: fixture.authorizedResolution,
        sourceAuthentication: fixture.freshSourceAuthentication,
        originalSourceAuthentication: fixture.originalSourceAuthentication,
        sourceReadbacks: fixture.sourceReadbacks,
        mutationIntent: fixture.mutationIntent,
        mutationOutcome: null,
        targetReadbackRequests: requests,
        targetReadbacks: unstableReadbacks,
        startedAt: fixture.resolutionNow,
        finishedAt: fixture.resolutionNow + 10,
        classification: "readback_inconclusive",
        reasonCode: "target_state_unstable",
      });
      expect(validateJsonCompatibilityDeploymentResolutionReceipt(inconclusive)
        .classification).toBe("readback_inconclusive");
    } finally {
      fixture.approvalPrivateKeyBytes.fill(0);
    }
  });
});

function resealResolutionReceipt(receipt) {
  const { resolutionReceiptSha256: _resolutionReceiptSha256, ...subject } =
    receipt;
  return {
    ...subject,
    resolutionReceiptSha256: sha256Canonical(subject),
  };
}

async function resolutionFixture() {
  const now = Math.floor(Date.now() / 1000) - 120;
  const mutation = await createMutationEnvelopeFixture({
    now,
    operationSeed: "deployment-resolution-operation",
    includeApprovalPrivateKey: true,
  });
  const {
    campaignPlan,
    statePlan,
    authorizedTransition,
    sourceAuthentication: originalSourceAuthentication,
    mutationIntent,
    sourceReadbacks,
  } = mutation.envelope;
  const approvalPrivateKeyBytes = mutation.approvalPrivateKeyBytes;
  const resolutionNow = now + 1_200;
  const freshSourceAuthentication =
    buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest: originalSourceAuthentication.request,
      classification: "authenticated",
      reasonCode: null,
      verifierIdentitySha256:
        authorizedTransition.request.sourceEvidence.sourceVerifierIdentitySha256,
      evidenceSha256: digest("deployment-resolution-fresh-source-proof"),
      verifiedAt: resolutionNow,
    });
  const resolver = buildJsonCompatibilityDeploymentResolverIdentity({
    accountIdSha256:
      authorizedTransition.request.executionAuthority.accountIdSha256,
    serviceName:
      "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging",
    entrypoint:
      "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
    versionId: "deployment-resolution-version-001",
    profileVersion: 1,
    privateRpcOnly: true,
    capability: "resolve-readback-only",
  });
  const authority = authorizedTransition.request.executionAuthority;
  const executionDisabledEvidence =
    buildJsonCompatibilityDeploymentExecutionDisabledEvidence({
      accountIdSha256: authority.accountIdSha256,
      coordinatorServiceName: authority.coordinator.serviceName,
      coordinatorEntrypoint: authority.coordinator.entrypoint,
      coordinatorVersionId: authority.coordinator.versionId,
      coordinatorIdentitySha256: authority.coordinator.identitySha256,
      coordinatorConfigurationSha256:
        digest("deployment-resolution-coordinator-configuration"),
      callerTopologySha256:
        digest("deployment-resolution-caller-topology"),
      executionDisabledAt: resolutionNow - 30,
      maximumAdmittedRequestLifetimeSeconds: 10,
      propagationAllowanceSeconds: 10,
      clockSkewAllowanceSeconds: 10,
      observedAt: resolutionNow,
    });
  const signingInput = {
    campaignPlan,
    statePlan,
    authorizedTransition,
    operationCreatedAt: now + 1,
    journalHeadOrdinal: 4,
    journalHeadDigestSha256: mutationIntent.mutationIntentSha256,
    pendingMutationIntentSha256: mutationIntent.mutationIntentSha256,
    claimGeneration: 1,
    resolver,
    sourceAuthentication: freshSourceAuthentication,
    executionDisabledEvidence,
  };
  const authorizedResolution = signJsonCompatibilityDeploymentResolution({
    ...signingInput,
    privateKeyBytes: approvalPrivateKeyBytes,
    now: new Date(resolutionNow * 1000),
  });
  return {
    campaignPlan,
    statePlan,
    authorizedTransition,
    authorizedResolution,
    originalSourceAuthentication,
    freshSourceAuthentication,
    mutationIntent,
    sourceReadbacks,
    approvalPrivateKeyBytes,
    resolutionNow,
    executionDisabledEvidence,
    signingInput,
  };
}
