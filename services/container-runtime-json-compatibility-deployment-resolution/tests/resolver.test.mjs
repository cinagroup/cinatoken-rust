import { describe, expect, test } from "vitest";

import {
  buildJsonCompatibilityDeploymentExecutionDisabledEvidence,
  buildJsonCompatibilityDeploymentResolverIdentity,
  signJsonCompatibilityDeploymentResolution,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionMutationOutcome,
  buildJsonCompatibilityDeploymentTransitionReadback,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  canonicalJson,
} from "../../../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  createMutationEnvelopeFixture,
} from "../../container-runtime-json-compatibility-deployment-mutation/tests/fixtures/mutation-envelope.mjs";
import {
  digest,
} from "../../../tests/fixtures/container-runtime-json-compatibility-deployment-transition.mjs";
import {
  getDeploymentTransitionResolutionStatus,
  resolveDeploymentTransitionInflight,
} from "../src/resolver";
import { ResolutionRepositoryUnavailableError } from "../src/repository";
import { parseResolutionJournalCheckpoint } from "../src/protocol";

describe("physical Reader-only deployment resolver", () => {
  test("linearizes concurrent replay to one claim, two reads, and no mutation capability", async () => {
    const scenario = await createScenario();
    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          resolveDeploymentTransitionInflight(
            scenario.env,
            scenario.invocation,
            scenario.runtime,
          )),
      );
      const receipts = attempts.flatMap((attempt) =>
        attempt.status === "fulfilled" ? [attempt.value] : []);
      expect(receipts).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected"))
        .toHaveLength(19);
      expect(new Set(receipts.map((receipt) =>
        receipt.resolutionReceiptSha256)).size).toBe(1);
      expect(receipts[0]).toMatchObject({
        classification: "target_confirmed",
        reasonCode: "target_state_confirmed",
        mutationOutcomeEvidence: "missing",
        nextTransitionAllowed: false,
        mutationAttempts: 0,
        automaticRetries: 0,
        mutationCalled: false,
        executionRetryPermitted: false,
      });
      expect(scenario.repository.claimCalls).toBeGreaterThanOrEqual(1);
      expect(scenario.repository.createdClaims).toBe(1);
      expect(scenario.readbackCalls).toHaveLength(2);
      expect(scenario.repository.observations).toHaveLength(2);
      expect(scenario.repository.finalizeCalls).toBe(1);
      expect(Object.keys(scenario.env)).not.toContain(
        "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION",
      );
      expect(Object.keys(scenario.env)).not.toContain(
        "JSON_COMPATIBILITY_SOURCE_VERIFIER",
      );

      const replay = await resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      );
      expect(replay.resolutionReceiptSha256).toBe(
        receipts[0].resolutionReceiptSha256,
      );
      expect(scenario.readbackCalls).toHaveLength(2);

      const callsBeforeStatus = scenario.readbackCalls.length;
      const status = await getDeploymentTransitionResolutionStatus(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      );
      expect(status).toMatchObject({
        classification: "final_resolution",
        observationCount: 2,
        sourceVerifierCalled: false,
        deploymentReadbackCalled: false,
        deploymentMutationCalled: false,
        executionRetryPermitted: false,
        resolver: {
          mutationBindingPresent: false,
          sourceVerifierBindingPresent: false,
        },
      });
      expect(status.resolution?.resolutionReceiptSha256).toBe(
        receipts[0].resolutionReceiptSha256,
      );
      expect(scenario.readbackCalls).toHaveLength(callsBeforeStatus);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("rejects a wrong resolver version before D1 or Reader access", async () => {
    const scenario = await createScenario();
    try {
      const env = {
        ...scenario.env,
        CF_VERSION_METADATA: { id: "wrong-resolver-version" },
      };
      await expect(resolveDeploymentTransitionInflight(
        env,
        scenario.invocation,
        scenario.runtime,
      )).rejects.toThrow(/identity|authorized/);
      expect(scenario.repository.readCalls).toBe(0);
      expect(scenario.readbackCalls).toHaveLength(0);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("rejects every forbidden runtime capability before D1 or Reader access", async () => {
    const scenario = await createScenario();
    try {
      for (const binding of [
        "JSON_COMPATIBILITY_DEPLOYMENT_MUTATION",
        "JSON_COMPATIBILITY_SOURCE_VERIFIER",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN",
        "CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN",
      ]) {
        await expect(resolveDeploymentTransitionInflight(
          { ...scenario.env, [binding]: "forbidden-test-capability" },
          scenario.invocation,
          scenario.runtime,
        )).rejects.toThrow(/forbidden_capability_present/);
      }
      expect(scenario.repository.readCalls).toBe(0);
      expect(scenario.readbackCalls).toHaveLength(0);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("rejects contradictory or stale drain evidence before D1 or Reader access", async () => {
    const contradictory = await createScenario();
    const stale = await createScenario({
      executionDisabledEvidenceAgeSeconds: 30,
    });
    try {
      const contradictoryInvocation = structuredClone(
        contradictory.invocation,
      );
      contradictoryInvocation.executionDisabledEvidence.executionEnabled =
        true;
      await expect(resolveDeploymentTransitionInflight(
        contradictory.env,
        contradictoryInvocation,
        contradictory.runtime,
      )).rejects.toThrow(/execution-disabled evidence/);
      expect(contradictory.repository.readCalls).toBe(0);
      expect(contradictory.readbackCalls).toHaveLength(0);

      await stale.runtime.sleep(1_000);
      await expect(resolveDeploymentTransitionInflight(
        stale.env,
        stale.invocation,
        stale.runtime,
      )).rejects.toThrow(/execution_disabled_evidence_mismatch/);
      expect(stale.repository.readCalls).toBe(0);
      expect(stale.readbackCalls).toHaveLength(0);
    } finally {
      contradictory.approvalPrivateKeyBytes.fill(0);
      stale.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("rejects a substituted fresh source proof before D1 or Reader access", async () => {
    const scenario = await createScenario();
    try {
      const currentSourceAuthentication =
        scenario.invocation.sourceAuthentication;
      const substitutedSourceAuthentication =
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest: currentSourceAuthentication.request,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            scenario.invocation.authorizedTransition.request.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("resolver-substituted-source-proof"),
          verifiedAt: scenario.runtime.now(),
        });
      await expect(resolveDeploymentTransitionInflight(
        scenario.env,
        {
          ...scenario.invocation,
          sourceAuthentication: substitutedSourceAuthentication,
        },
        scenario.runtime,
      )).rejects.toThrow(/source authentication is not owner authorized/);
      expect(scenario.repository.readCalls).toBe(0);
      expect(scenario.readbackCalls).toHaveLength(0);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("rejects an unbound Reader identity before observation persistence", async () => {
    const scenario = await createScenario({
      readbackResponseIdentitySha256: digest("resolver-unbound-reader"),
    });
    try {
      await expect(resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      )).rejects.toThrow(/deployment_resolution_readback_identity_mismatch/);
      expect(scenario.readbackCalls).toHaveLength(1);
      expect(scenario.repository.observations).toHaveLength(0);
      expect(scenario.repository.finalizeCalls).toBe(0);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("requires a complete proof-bounded claim lease before D1 access", async () => {
    const scenario = await createScenario();
    try {
      await scenario.runtime.sleep(20_000);
      await expect(resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      )).rejects.toThrow(/lease window is incomplete/);
      expect(scenario.repository.readCalls).toBe(0);
      expect(scenario.readbackCalls).toHaveLength(0);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("reconciles final receipt response loss without another Reader call", async () => {
    const scenario = await createScenario();
    try {
      scenario.repository.failFinalizeAfterPersistOnce = true;
      await expect(resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      )).rejects.toBeInstanceOf(ResolutionRepositoryUnavailableError);
      expect(scenario.repository.outcome).not.toBeNull();
      expect(scenario.readbackCalls).toHaveLength(2);

      const replay = await resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      );
      expect(replay.resolutionReceiptSha256).toBe(
        scenario.repository.outcome.resolutionDigestSha256,
      );
      expect(scenario.readbackCalls).toHaveLength(2);
      expect(scenario.repository.createdClaims).toBe(1);
      expect(scenario.repository.finalizeCalls).toBe(1);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("allows a newly signed generation after an inconclusive attempt", async () => {
    const scenario = await createScenario({ claimGeneration: 2 });
    try {
      scenario.repository.outcome = {
        operationIdSha256:
          scenario.invocation.authorizedResolution.request.operation
            .operationIdSha256,
        generation: 1,
        claimDigestSha256: digest("resolver-inconclusive-claim"),
        classification: "readback_inconclusive",
        observationOneDigestSha256:
          digest("resolver-inconclusive-observation-one"),
        observationTwoDigestSha256:
          digest("resolver-inconclusive-observation-two"),
        resolutionDigestSha256: digest("resolver-inconclusive-resolution"),
        resolution: { contract: "prior-inconclusive-resolution" },
        resolvedAt: scenario.runtime.now() - 60,
      };

      const receipt = await resolveDeploymentTransitionInflight(
        scenario.env,
        scenario.invocation,
        scenario.runtime,
      );
      expect(receipt).toMatchObject({
        claimGeneration: 2,
        classification: "target_confirmed",
      });
      expect(scenario.repository.createdClaims).toBe(1);
      expect(scenario.readbackCalls).toHaveLength(2);
      expect(scenario.repository.outcome.generation).toBe(2);
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });

  test("reconstructs a pending checkpoint with a journaled mutation outcome", async () => {
    const scenario = await createScenario();
    try {
      const authorizedResolution = structuredClone(
        scenario.invocation.authorizedResolution,
      );
      const mutationIntent = JSON.parse(
        scenario.repository.seed.events[3].event_json,
      ).payload;
      const mutationOutcome =
        buildJsonCompatibilityDeploymentTransitionMutationOutcome({
          mutationIntent,
          mutationRpcRequestSha256: digest("resolver-journaled-rpc-request"),
          mutationServiceIdentitySha256:
            mutationIntent.mutationServiceIdentitySha256,
          authenticationIdentitySha256:
            mutationIntent.mutationCredentialIdSha256,
          mutationRequestSha256: digest("resolver-journaled-request"),
          mutationAnnotationSha256: digest("resolver-journaled-annotation"),
          endpointSha256: digest("resolver-journaled-endpoint"),
          sentAt: scenario.runtime.now(),
          classification: "accepted",
          httpStatus: 200,
          responseBodySha256: digest("resolver-journaled-response"),
          responseRequestIdSha256: digest("resolver-journaled-request-id"),
          responseBytes: 2,
        });
      const outcomeDigestSha256 = mutationOutcome.outcomeDigestSha256;
      const events = [
        ...scenario.repository.seed.events,
        eventRow(
          5,
          "mutation_outcome",
          outcomeDigestSha256,
          mutationOutcome,
          scenario.runtime.now(),
        ),
      ];
      authorizedResolution.request.journalHead = {
        ordinal: 5,
        digestSha256: outcomeDigestSha256,
      };

      const checkpoint = parseResolutionJournalCheckpoint(
        events,
        authorizedResolution,
      );
      expect(checkpoint.mutationOutcome).toEqual(mutationOutcome);
      expect(checkpoint.mutationIntent?.mutationIntentSha256).toBe(
        mutationIntent.mutationIntentSha256,
      );
    } finally {
      scenario.approvalPrivateKeyBytes.fill(0);
    }
  });
});

async function createScenario({
  claimGeneration = 1,
  readbackResponseIdentitySha256 = null,
  executionDisabledEvidenceAgeSeconds = 0,
} = {}) {
  const transitionNow = Math.floor(Date.now() / 1_000) - 1_500;
  const mutation = await createMutationEnvelopeFixture({
    now: transitionNow,
    operationSeed: "deployment-resolution-worker-operation",
    includeApprovalPrivateKey: true,
  });
  const {
    campaignPlan,
    statePlan,
    authorizedTransition,
    sourceAuthentication: originalSourceAuthentication,
    sourceReadbacks,
    mutationIntent,
  } = mutation.envelope;
  const approvalPrivateKeyBytes = mutation.approvalPrivateKeyBytes;
  const resolutionNow = transitionNow + 1_200;
  const operationCreatedAt = transitionNow + 1;
  const freshSourceAuthentication =
    buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest: originalSourceAuthentication.request,
      classification: "authenticated",
      reasonCode: null,
      verifierIdentitySha256:
        authorizedTransition.request.sourceEvidence.sourceVerifierIdentitySha256,
      evidenceSha256: digest("resolver-worker-fresh-source-proof"),
      verifiedAt: resolutionNow,
    });
  const resolverIdentity = buildJsonCompatibilityDeploymentResolverIdentity({
    accountIdSha256:
      authorizedTransition.request.executionAuthority.accountIdSha256,
    serviceName:
      "cinatoken-container-runtime-json-compatibility-deployment-resolution-staging",
    entrypoint:
      "JsonCompatibilityDeploymentTransitionResolutionEntrypoint",
    versionId: "deployment-resolution-runtime-version-001",
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
        digest("resolver-worker-coordinator-configuration"),
      callerTopologySha256: digest("resolver-worker-caller-topology"),
      executionDisabledAt:
        resolutionNow - executionDisabledEvidenceAgeSeconds - 30,
      maximumAdmittedRequestLifetimeSeconds: 10,
      propagationAllowanceSeconds: 10,
      clockSkewAllowanceSeconds: 10,
      observedAt: resolutionNow - executionDisabledEvidenceAgeSeconds,
    });
  const authorizedResolution = signJsonCompatibilityDeploymentResolution({
    campaignPlan,
    statePlan,
    authorizedTransition,
    operationCreatedAt,
    journalHeadOrdinal: 4,
    journalHeadDigestSha256: mutationIntent.mutationIntentSha256,
    pendingMutationIntentSha256: mutationIntent.mutationIntentSha256,
    claimGeneration,
    resolver: resolverIdentity,
    sourceAuthentication: freshSourceAuthentication,
    executionDisabledEvidence,
    privateKeyBytes: approvalPrivateKeyBytes,
    now: new Date(resolutionNow * 1_000),
  });
  const events = [
    eventRow(1, "source_authentication",
      originalSourceAuthentication.sourceAuthenticationDigestSha256,
      originalSourceAuthentication, transitionNow),
    eventRow(2, "source_readback", sourceReadbacks[0].observationDigestSha256,
      sourceReadbacks[0], transitionNow + 1),
    eventRow(3, "source_readback", sourceReadbacks[1].observationDigestSha256,
      sourceReadbacks[1], transitionNow + 6),
    eventRow(4, "mutation_intent", mutationIntent.mutationIntentSha256,
      mutationIntent, transitionNow + 7),
  ];
  const repository = new InMemoryResolutionRepository({
    operationIdSha256: mutationIntent.operationIdSha256,
    operationDigestSha256: mutationIntent.operationDigestSha256,
    executionAuthorityDigestSha256: mutationIntent.executionAuthoritySha256,
    readbackVersionId:
      authorizedTransition.request.executionAuthority.readback.versionId,
    readbackIdentitySha256:
      authorizedTransition.request.executionAuthority.readback.identitySha256,
    mutationIdentitySha256:
      authorizedTransition.request.executionAuthority.mutation.identitySha256,
    createdAt: operationCreatedAt,
    journal: {
      headOrdinal: 4,
      headDigestSha256: mutationIntent.mutationIntentSha256,
      pendingMutationIntentOrdinal: 4,
      pendingMutationIntentDigestSha256: mutationIntent.mutationIntentSha256,
    },
    events,
    databaseNow: resolutionNow,
  });
  let currentNow = resolutionNow;
  const readbackCalls = [];
  const env = {
    CF_VERSION_METADATA: { id: resolverIdentity.versionId },
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENABLED: "true",
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_EXECUTION_ENABLED: "true",
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_STATUS_READ_ENABLED: "true",
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_PROFILE_VERSION: "1",
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_SERVICE_NAME:
      resolverIdentity.serviceName,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ENTRYPOINT:
      resolverIdentity.entrypoint,
    JSON_COMPATIBILITY_DEPLOYMENT_RESOLUTION_ACCOUNT_ID_SHA256:
      resolverIdentity.accountIdSha256,
    JSON_COMPATIBILITY_DEPLOYMENT_READBACK_SERVICE_NAME:
      authorizedTransition.request.executionAuthority.readback.serviceName,
    JSON_COMPATIBILITY_DEPLOYMENT_READBACK_ENTRYPOINT:
      authorizedTransition.request.executionAuthority.readback.entrypoint,
    DB: { withSession: () => {
      throw new Error("in-memory repository must replace D1");
    } },
    JSON_COMPATIBILITY_DEPLOYMENT_READBACK: {
      readDeploymentStateForResolution: async (input) => {
        readbackCalls.push(input);
        const request = input.readbackRequest;
        const ordinal = request.observationOrdinal;
        return buildJsonCompatibilityDeploymentTransitionReadback({
          ...request.expected,
          readbackRequestSha256: request.readbackRequestSha256,
          readbackServiceIdentitySha256:
            readbackResponseIdentitySha256
            ?? authorizedTransition.request.executionAuthority.readback
              .identitySha256,
          classification: "observed",
          readbackRequestIdSha256: digest(`resolver-rpc-${ordinal}`),
          remoteEvidenceSha256: digest(`resolver-remote-${ordinal}`),
          authenticationEvidenceSha256: digest(`resolver-auth-${ordinal}`),
          observedAt: currentNow,
        });
      },
    },
  };
  const runtime = {
    now: () => currentNow,
    sleep: async (milliseconds) => {
      currentNow += Math.ceil(milliseconds / 1_000);
    },
    repository: () => repository,
  };
  return {
    env,
    invocation: {
      campaignPlan,
      statePlan,
      authorizedTransition,
      authorizedResolution,
      sourceAuthentication: freshSourceAuthentication,
      executionDisabledEvidence,
    },
    runtime,
    repository,
    readbackCalls,
    approvalPrivateKeyBytes,
  };
}

function eventRow(ordinal, kind, digestSha256, payload, recordedAt) {
  return {
    event_ordinal: ordinal,
    event_kind: kind,
    event_digest_sha256: digestSha256,
    event_json: canonicalJson({ kind, digestSha256, payload }),
    recorded_at: recordedAt,
  };
}

class InMemoryResolutionRepository {
  constructor(seed) {
    this.seed = seed;
  }

  readCalls = 0;
  claimCalls = 0;
  createdClaims = 0;
  finalizeCalls = 0;
  failFinalizeAfterPersistOnce = false;
  claimRecord = null;
  observations = [];
  outcome = null;

  async readSnapshot() {
    this.readCalls += 1;
    return {
      classification: this.outcome === null
        ? this.claimRecord === null ? "inflight" : "resolution_claimed"
        : this.outcome.classification === "readback_inconclusive"
          ? "readback_inconclusive"
          : "final_resolution",
      databaseNow: this.seed.databaseNow,
      operation: {
        operationIdSha256: this.seed.operationIdSha256,
        operationDigestSha256: this.seed.operationDigestSha256,
        executionAuthorityDigestSha256:
          this.seed.executionAuthorityDigestSha256,
        readbackVersionId: this.seed.readbackVersionId,
        readbackIdentitySha256: this.seed.readbackIdentitySha256,
        mutationIdentitySha256: this.seed.mutationIdentitySha256,
        createdAt: this.seed.createdAt,
      },
      journal: this.seed.journal,
      normalReceipt: null,
      claim: this.claimRecord,
      claimExpired: false,
      claimable: this.claimRecord === null,
      events: this.seed.events,
      observations: this.observations,
      outcome: this.outcome,
    };
  }

  async claim(input) {
    this.claimCalls += 1;
    if (this.claimRecord !== null) {
      return { classification: "exact_replay", claim: this.claimRecord };
    }
    this.createdClaims += 1;
    this.claimRecord = {
      ...input,
      executionDisabledEvidence: structuredClone(
        input.executionDisabledEvidence,
      ),
      claim: structuredClone(input.claim),
      leaseExpiresAt: this.seed.databaseNow + input.claimLeaseSeconds,
      claimedAt: this.seed.databaseNow,
    };
    return { classification: "created", claim: this.claimRecord };
  }

  async appendObservation(input) {
    const record = {
      ...input,
      request: structuredClone(input.request),
      observation: structuredClone(input.observation),
      observedAt: this.seed.databaseNow + (input.observationOrdinal - 1) * 6,
    };
    this.observations.push(record);
    return { classification: "appended", observation: record };
  }

  async finalize(input) {
    this.finalizeCalls += 1;
    this.outcome = {
      operationIdSha256: input.operationIdSha256,
      generation: input.generation,
      claimDigestSha256: input.claimDigestSha256,
      classification: input.classification,
      observationOneDigestSha256: input.observationOneDigestSha256,
      observationTwoDigestSha256: input.observationTwoDigestSha256,
      resolutionDigestSha256: input.resolutionDigestSha256,
      resolution: structuredClone(input.resolution),
      resolvedAt: this.seed.databaseNow + 6,
    };
    if (this.failFinalizeAfterPersistOnce) {
      this.failFinalizeAfterPersistOnce = false;
      throw new ResolutionRepositoryUnavailableError(true);
    }
    return { classification: "created", outcome: this.outcome };
  }
}
