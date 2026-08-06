import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { canonicalJson, sha256Text } from
  "../../container-runtime-json-compatibility-deployment-transition/src/canonical";
import {
  buildJsonCompatibilityDeploymentExecutionDisabledEvidence,
} from "../../../tools/container_runtime_json_compatibility_deployment_resolution.mjs";
import {
  buildJsonCompatibilityDeploymentTransitionReadback,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  D1ResolutionRepository,
  type ResolutionClaimInput,
  type ResolutionFinalizeInput,
  type ResolutionObservationInput,
} from "../src/repository";

interface RuntimeEnv {
  readonly DB: D1Database;
  readonly TEST_D1_MIGRATIONS: D1Migration[];
}

const runtimeEnv = env as unknown as RuntimeEnv;

beforeEach(async () => {
  await applyD1Migrations(
    runtimeEnv.DB,
    runtimeEnv.TEST_D1_MIGRATIONS,
  );
});

afterEach(async () => {
  await reset();
});

describe("deployment resolution append-only D1 repository", () => {
  test("linearizes claim/replay, enforces stable reads, and fences execution", async () => {
    const fixture = await seedInflightOperation(runtimeEnv.DB);
    const repository = new D1ResolutionRepository(runtimeEnv.DB);
    const initial = await repository.readSnapshot(
      fixture.operationIdSha256,
      fixture.operationDigestSha256,
    );
    expect(initial).toMatchObject({
      classification: "inflight",
      claimable: true,
      journal: {
        headOrdinal: 1,
        headDigestSha256: fixture.intentDigestSha256,
        pendingMutationIntentOrdinal: 1,
        pendingMutationIntentDigestSha256: fixture.intentDigestSha256,
      },
    });
    expect(initial.events).toHaveLength(1);

    const claimInput = await resolutionClaimInput(
      fixture,
      initial.databaseNow,
      "primary",
    );
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => repository.claim(claimInput)),
    );
    expect(claims.filter((claim) => claim.classification === "created"))
      .toHaveLength(1);
    expect(claims.filter((claim) => claim.classification === "exact_replay"))
      .toHaveLength(19);
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_claims",
    )).toBe(1);
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_claim_identities",
    )).toBe(1);

    const wrongOperationDigestSha256 = await sha256Text(
      "resolution-wrong-operation-digest",
    );
    expect((await repository.claim({
      ...claimInput,
      operationDigestSha256: wrongOperationDigestSha256,
    })).classification).toBe("conflict");

    await runtimeEnv.DB.exec("PRAGMA recursive_triggers = OFF");
    await expectReplaceRejected(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_claims",
      "operation_id_sha256 = ?1 AND generation = ?2",
      [fixture.operationIdSha256, 1],
    );

    const first = await observationInput(fixture, claimInput, 1);
    const prematureSecond = await observationInput(fixture, claimInput, 2);
    const prematureFinalize = await resolutionFinalizeInput(
      fixture,
      claimInput,
      first,
      prematureSecond,
      "target_confirmed",
    );
    expect((await repository.finalize(prematureFinalize)).classification)
      .toBe("conflict");

    const firstAppend = await repository.appendObservation(first);
    expect(firstAppend.classification).toBe("appended");
    expect((await repository.appendObservation(first)).classification)
      .toBe("exact_replay");
    expect((await repository.appendObservation({
      ...first,
      operationDigestSha256: wrongOperationDigestSha256,
    })).classification).toBe("conflict");
    expect((await repository.finalize(prematureFinalize)).classification)
      .toBe("conflict");
    expect((await repository.appendObservation(prematureSecond)).classification)
      .toBe("conflict");
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_observation_identities",
    )).toBe(1);
    await expectReplaceRejected(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_observations",
      "operation_id_sha256 = ?1 AND generation = ?2 AND observation_ordinal = ?3",
      [fixture.operationIdSha256, 1, 1],
    );

    await scheduler.wait(6_000);
    const second = await observationInput(fixture, claimInput, 2);
    const secondAppend = await repository.appendObservation(second);
    expect(secondAppend.classification).toBe("appended");
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_observation_identities",
    )).toBe(2);

    for (const classification of [
      "manual_review_required",
      "readback_inconclusive",
    ] as const) {
      const contradictorySubject = {
        contract: "deployment-resolution-receipt-v1",
        operationIdSha256: fixture.operationIdSha256,
        operationDigestSha256: fixture.operationDigestSha256,
        claimGeneration: 1,
        classification,
        targetReadbacks: [first.observation, second.observation],
      };
      const contradictoryDigest = await sha256Text(
        canonicalJson(contradictorySubject),
      );
      const contradictoryResolution = {
        ...contradictorySubject,
        resolutionReceiptSha256: contradictoryDigest,
      };
      expect((await repository.finalize({
        operationIdSha256: fixture.operationIdSha256,
        operationDigestSha256: fixture.operationDigestSha256,
        generation: 1,
        claimDigestSha256: claimInput.claimDigestSha256,
        classification,
        observationOneDigestSha256: first.observationDigestSha256,
        observationTwoDigestSha256: second.observationDigestSha256,
        resolutionDigestSha256: contradictoryDigest,
        resolution: contradictoryResolution,
      })).classification).toBe("conflict");
    }

    const resolutionSubject = {
      schemaVersion: 1,
      contract: "deployment-resolution-receipt-v1",
      operationIdSha256: fixture.operationIdSha256,
      operationDigestSha256: fixture.operationDigestSha256,
      claimGeneration: 1,
      classification: "target_confirmed",
      targetReadbacks: [first.observation, second.observation],
      nextTransitionAllowed: false,
      mutationCalled: false,
    };
    const resolutionDigestSha256 = await sha256Text(
      canonicalJson(resolutionSubject),
    );
    const resolution = {
      ...resolutionSubject,
      resolutionReceiptSha256: resolutionDigestSha256,
    };
    const outcome = await repository.finalize({
      operationIdSha256: fixture.operationIdSha256,
      operationDigestSha256: fixture.operationDigestSha256,
      generation: 1,
      claimDigestSha256: claimInput.claimDigestSha256,
      classification: "target_confirmed",
      observationOneDigestSha256: first.observationDigestSha256,
      observationTwoDigestSha256: second.observationDigestSha256,
      resolutionDigestSha256,
      resolution,
    });
    expect(outcome.classification).toBe("created");
    expect((await repository.finalize({
      operationIdSha256: fixture.operationIdSha256,
      operationDigestSha256: fixture.operationDigestSha256,
      generation: 1,
      claimDigestSha256: claimInput.claimDigestSha256,
      classification: "target_confirmed",
      observationOneDigestSha256: first.observationDigestSha256,
      observationTwoDigestSha256: second.observationDigestSha256,
      resolutionDigestSha256,
      resolution,
    })).classification).toBe("exact_replay");
    expect((await repository.finalize({
      operationIdSha256: fixture.operationIdSha256,
      operationDigestSha256: wrongOperationDigestSha256,
      generation: 1,
      claimDigestSha256: claimInput.claimDigestSha256,
      classification: "target_confirmed",
      observationOneDigestSha256: first.observationDigestSha256,
      observationTwoDigestSha256: second.observationDigestSha256,
      resolutionDigestSha256,
      resolution: {
        ...resolution,
        operationDigestSha256: wrongOperationDigestSha256,
      },
    })).classification).toBe("conflict");
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_outcome_identities",
    )).toBe(1);
    await expectReplaceRejected(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_outcomes",
      "operation_id_sha256 = ?1 AND generation = ?2",
      [fixture.operationIdSha256, 1],
    );

    const terminal = await repository.readSnapshot(
      fixture.operationIdSha256,
      fixture.operationDigestSha256,
    );
    expect(terminal).toMatchObject({
      classification: "final_resolution",
      claimable: false,
      outcome: {
        classification: "target_confirmed",
        resolutionDigestSha256,
      },
    });

    await expect(runtimeEnv.DB.prepare(
      `INSERT INTO json_compatibility_deployment_transition_events (
         operation_id_sha256, event_ordinal, event_kind,
         event_digest_sha256, event_json, recorded_at
       ) VALUES (?1, 2, 'target_readback', ?2, ?3, unixepoch())`,
    ).bind(
      fixture.operationIdSha256,
      await sha256Text("late-event"),
      canonicalJson({ late: true }),
    ).run()).rejects.toThrow();
    await expect(runtimeEnv.DB.prepare(
      `INSERT INTO json_compatibility_deployment_transition_receipts (
         operation_id_sha256, receipt_digest_sha256, result,
         receipt_json, archived_at
       ) VALUES (?1, ?2, 'stopped', ?3, unixepoch())`,
    ).bind(
      fixture.operationIdSha256,
      await sha256Text("late-receipt"),
      canonicalJson({ result: "stopped" }),
    ).run()).rejects.toThrow();

    for (const table of [
      "claims",
      "observations",
      "outcomes",
    ]) {
      const qualified =
        `json_compatibility_deployment_transition_resolution_${table}`;
      await expect(runtimeEnv.DB.prepare(
        `UPDATE ${qualified} SET operation_id_sha256 = operation_id_sha256`,
      ).run()).rejects.toThrow();
      await expect(runtimeEnv.DB.prepare(
        `DELETE FROM ${qualified}`,
      ).run()).rejects.toThrow();
    }
  });

  test("claims an inflight checkpoint after a journaled mutation outcome", async () => {
    const fixture = await seedInflightOperation(runtimeEnv.DB);
    const outcomeDigestSha256 = await sha256Text("journaled-mutation-outcome");
    const outcome = {
      mutationIntentSha256: fixture.intentDigestSha256,
      outcomeDigestSha256,
      classification: "accepted",
    };
    await runtimeEnv.DB.prepare(
      `INSERT INTO json_compatibility_deployment_transition_events (
         operation_id_sha256, event_ordinal, event_kind,
         event_digest_sha256, event_json, recorded_at
       ) VALUES (?1, 2, 'mutation_outcome', ?2, ?3, unixepoch())`,
    ).bind(
      fixture.operationIdSha256,
      outcomeDigestSha256,
      canonicalJson({
        kind: "mutation_outcome",
        digestSha256: outcomeDigestSha256,
        payload: outcome,
      }),
    ).run();

    const repository = new D1ResolutionRepository(runtimeEnv.DB);
    const snapshot = await repository.readSnapshot(
      fixture.operationIdSha256,
      fixture.operationDigestSha256,
    );
    expect(snapshot).toMatchObject({
      classification: "inflight",
      claimable: true,
      journal: {
        headOrdinal: 2,
        headDigestSha256: outcomeDigestSha256,
        pendingMutationIntentOrdinal: 1,
        pendingMutationIntentDigestSha256: fixture.intentDigestSha256,
      },
    });

    const claimInput = await resolutionClaimInput(
      fixture,
      snapshot.databaseNow,
      "outcome-checkpoint",
      {
        journalHeadOrdinal: 2,
        journalHeadDigestSha256: outcomeDigestSha256,
      },
    );
    const claim = await repository.claim(claimInput);
    expect(claim.classification).toBe("created");
  });

  test("classifies stable and unstable Reader evidence in D1", async () => {
    const cases = [
      {
        seed: "duplicate-request-id",
        firstVersionId: "target-version-001",
        secondVersionId: "target-version-001",
        sharedRequestIdSeed: "duplicate-request-id",
        classification: "readback_inconclusive",
      },
      {
        seed: "target-plus-drift",
        firstVersionId: "target-version-001",
        secondVersionId: "drift-version-001",
        sharedRequestIdSeed: undefined,
        classification: "readback_inconclusive",
      },
      {
        seed: "different-drift-states",
        firstVersionId: "drift-version-001",
        secondVersionId: "drift-version-002",
        sharedRequestIdSeed: undefined,
        classification: "readback_inconclusive",
      },
      {
        seed: "stable-non-target",
        firstVersionId: "stable-drift-version",
        secondVersionId: "stable-drift-version",
        sharedRequestIdSeed: undefined,
        classification: "manual_review_required",
      },
    ] as const;
    const attempts = [];

    for (const scenario of cases) {
      const fixture = await seedInflightOperation(runtimeEnv.DB, scenario.seed);
      const repository = new D1ResolutionRepository(runtimeEnv.DB);
      const snapshot = await repository.readSnapshot(
        fixture.operationIdSha256,
        fixture.operationDigestSha256,
      );
      const claimInput = await resolutionClaimInput(
        fixture,
        snapshot.databaseNow,
        scenario.seed,
      );
      expect((await repository.claim(claimInput)).classification).toBe("created");
      const first = await observationInput(fixture, claimInput, 1, {
        versionId: scenario.firstVersionId,
        ...(scenario.sharedRequestIdSeed === undefined
          ? {}
          : { requestIdSeed: scenario.sharedRequestIdSeed }),
      });
      const second = await observationInput(fixture, claimInput, 2, {
        versionId: scenario.secondVersionId,
        ...(scenario.sharedRequestIdSeed === undefined
          ? {}
          : { requestIdSeed: scenario.sharedRequestIdSeed }),
      });
      expect((await repository.appendObservation(first)).classification)
        .toBe("appended");
      attempts.push({
        scenario,
        fixture,
        repository,
        claimInput,
        first,
        second,
      });
    }

    await scheduler.wait(6_000);
    for (const attempt of attempts) {
      expect((await attempt.repository.appendObservation(attempt.second))
        .classification).toBe("appended");
      const finalizeInput = await resolutionFinalizeInput(
        attempt.fixture,
        attempt.claimInput,
        attempt.first,
        attempt.second,
        attempt.scenario.classification,
      );
      expect((await attempt.repository.finalize(finalizeInput)).classification)
        .toBe("created");
      const snapshot = await attempt.repository.readSnapshot(
        attempt.fixture.operationIdSha256,
        attempt.fixture.operationDigestSha256,
      );
      expect(snapshot.outcome?.classification)
        .toBe(attempt.scenario.classification);
    }
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_outcome_identities",
    )).toBe(cases.length);
  });

  test("rejects a target-readback checkpoint without a mutation outcome", async () => {
    const fixture = await seedInflightOperation(
      runtimeEnv.DB,
      "malformed-target-checkpoint",
    );
    const targetReadbackDigestSha256 = await sha256Text(
      "malformed-target-checkpoint-readback",
    );
    await runtimeEnv.DB.prepare(
      `INSERT INTO json_compatibility_deployment_transition_events (
         operation_id_sha256, event_ordinal, event_kind,
         event_digest_sha256, event_json, recorded_at
       ) VALUES (?1, 2, 'target_readback', ?2, ?3, unixepoch())`,
    ).bind(
      fixture.operationIdSha256,
      targetReadbackDigestSha256,
      canonicalJson({
        kind: "target_readback",
        digestSha256: targetReadbackDigestSha256,
        payload: { classification: "observed" },
      }),
    ).run();

    const repository = new D1ResolutionRepository(runtimeEnv.DB);
    const snapshot = await repository.readSnapshot(
      fixture.operationIdSha256,
      fixture.operationDigestSha256,
    );
    const claimInput = await resolutionClaimInput(
      fixture,
      snapshot.databaseNow,
      "malformed-target-checkpoint",
      {
        journalHeadOrdinal: 2,
        journalHeadDigestSha256: targetReadbackDigestSha256,
      },
    );
    expect((await repository.claim(claimInput)).classification).toBe("conflict");
    expect(await rowCount(
      runtimeEnv.DB,
      "json_compatibility_deployment_transition_resolution_claims",
    )).toBe(0);
  });
});

async function seedInflightOperation(database: D1Database, seed = "primary") {
  const operationIdSha256 = await sha256Text(`resolution-operation-${seed}`);
  const operationDigestSha256 =
    await sha256Text(`resolution-operation-digest-${seed}`);
  const authorizedRequestSha256 =
    await sha256Text(`resolution-authorized-${seed}`);
  const campaignPlanDigestSha256 =
    await sha256Text(`resolution-campaign-${seed}`);
  const statePlanDigestSha256 =
    await sha256Text(`resolution-state-plan-${seed}`);
  const authorityDigestSha256 =
    await sha256Text(`resolution-authority-${seed}`);
  const accountIdSha256 = await sha256Text(`resolution-account-${seed}`);
  const coordinatorIdentitySha256 =
    await sha256Text(`coordinator-identity-${seed}`);
  const readbackIdentitySha256 =
    await sha256Text(`resolution-reader-${seed}`);
  const readbackCredentialIdSha256 =
    await sha256Text(`readback-credential-${seed}`);
  const mutationIdentitySha256 =
    await sha256Text(`resolution-mutator-${seed}`);
  const mutationCredentialIdSha256 =
    await sha256Text(`mutation-credential-${seed}`);
  const intentDigestSha256 = await sha256Text(`resolution-intent-${seed}`);
  const operation = {
    operationIdSha256,
    operationDigestSha256,
    authorizedRequestSha256,
  };
  const authority = {
    authorityDigestSha256,
    readbackIdentitySha256,
    mutationIdentitySha256,
  };
  const event = {
    kind: "mutation_intent",
    digestSha256: intentDigestSha256,
    payload: { mutationIntentSha256: intentDigestSha256 },
  };
  await database.batch([
    database.prepare(
      `INSERT INTO json_compatibility_deployment_transition_operations (
         operation_id_sha256, operation_digest_sha256,
         authorized_request_sha256, campaign_plan_digest_sha256,
         state_plan_digest_sha256, transition_id, operation_json,
         coordinator_version_id, coordinator_profile_version,
         deployment_leaf_service_name, source_verifier_service_name,
         created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'dark-to-status', ?6,
         'coordinator-version-001', 1,
         'cinatoken-deployment-readback', 'cinatoken-source-verifier',
         unixepoch())`,
    ).bind(
      operationIdSha256,
      operationDigestSha256,
      authorizedRequestSha256,
      campaignPlanDigestSha256,
      statePlanDigestSha256,
      canonicalJson(operation),
    ),
    database.prepare(
      `INSERT INTO json_compatibility_deployment_transition_authorities (
         operation_id_sha256, authority_digest_sha256, authority_json,
         coordinator_service_name, coordinator_version_id,
         coordinator_identity_sha256, source_verifier_service_name,
         source_verifier_version_id, source_verifier_identity_sha256,
         readback_service_name, readback_version_id,
         readback_identity_sha256, readback_credential_id_sha256,
         mutation_service_name, mutation_version_id,
         mutation_identity_sha256, mutation_credential_id_sha256,
         created_at
       ) VALUES (?1, ?2, ?3, 'cinatoken-coordinator',
         'coordinator-version-001', ?4, 'cinatoken-source-verifier',
         'source-verifier-version-001', ?5,
         'cinatoken-deployment-readback', 'readback-version-001', ?6, ?7,
         'cinatoken-deployment-mutation', 'mutation-version-001', ?8, ?9,
         unixepoch())`,
    ).bind(
      operationIdSha256,
      authorityDigestSha256,
      canonicalJson(authority),
      coordinatorIdentitySha256,
      await sha256Text("source-verifier-identity"),
      readbackIdentitySha256,
      readbackCredentialIdSha256,
      mutationIdentitySha256,
      mutationCredentialIdSha256,
    ),
  ]);
  await database.prepare(
    `INSERT INTO json_compatibility_deployment_transition_events (
       operation_id_sha256, event_ordinal, event_kind,
       event_digest_sha256, event_json, recorded_at
     ) VALUES (?1, 1, 'mutation_intent', ?2, ?3, unixepoch())`,
  ).bind(
    operationIdSha256,
    intentDigestSha256,
    canonicalJson(event),
  ).run();
  return {
    operationIdSha256,
    operationDigestSha256,
    intentDigestSha256,
    accountIdSha256,
    coordinatorServiceName: "cinatoken-coordinator",
    coordinatorEntrypoint: "JsonCompatibilityDeploymentTransitionEntrypoint",
    coordinatorVersionId: "coordinator-version-001",
    coordinatorIdentitySha256,
    readbackIdentitySha256,
    readbackCredentialIdSha256,
    readbackVersionId: "readback-version-001",
  };
}

async function observationInput(
  fixture: Awaited<ReturnType<typeof seedInflightOperation>>,
  claim: ResolutionClaimInput,
  ordinal: 1 | 2,
  options: {
    readonly versionId?: string;
    readonly requestIdSeed?: string;
  } = {},
): Promise<ResolutionObservationInput> {
  const requestDigestSha256 = await sha256Text(
    `${claim.claimDigestSha256}-resolution-request-${ordinal}`,
  );
  const observation =
    await buildObservedReadback(fixture, claim, ordinal, requestDigestSha256, options);
  return {
    operationIdSha256: fixture.operationIdSha256,
    operationDigestSha256: fixture.operationDigestSha256,
    generation: claim.generation,
    claimDigestSha256: claim.claimDigestSha256,
    observationOrdinal: ordinal,
    requestDigestSha256,
    request: {
      phase: "target",
      observationOrdinal: ordinal,
      readbackRequestSha256: requestDigestSha256,
    },
    observationDigestSha256: observation.observationDigestSha256,
    observation,
    observedStateSha256:
      observation.remoteStateSha256 ?? observation.observationDigestSha256,
    readbackVersionId: fixture.readbackVersionId,
    readbackIdentitySha256: fixture.readbackIdentitySha256,
  };
}

async function resolutionClaimInput(
  fixture: Awaited<ReturnType<typeof seedInflightOperation>>,
  databaseNow: number,
  seed: string,
  journal: {
    readonly journalHeadOrdinal?: number;
    readonly journalHeadDigestSha256?: string;
  } = {},
): Promise<ResolutionClaimInput> {
  const executionDisabledEvidence =
    buildJsonCompatibilityDeploymentExecutionDisabledEvidence({
      accountIdSha256: fixture.accountIdSha256,
      coordinatorServiceName: fixture.coordinatorServiceName,
      coordinatorEntrypoint: fixture.coordinatorEntrypoint,
      coordinatorVersionId: fixture.coordinatorVersionId,
      coordinatorIdentitySha256: fixture.coordinatorIdentitySha256,
      coordinatorConfigurationSha256:
        await sha256Text(`${seed}-coordinator-configuration`),
      callerTopologySha256: await sha256Text(`${seed}-caller-topology`),
      executionDisabledAt: databaseNow - 30,
      maximumAdmittedRequestLifetimeSeconds: 10,
      propagationAllowanceSeconds: 10,
      clockSkewAllowanceSeconds: 10,
      observedAt: databaseNow,
    });
  const provisional: ResolutionClaimInput = {
    operationIdSha256: fixture.operationIdSha256,
    operationDigestSha256: fixture.operationDigestSha256,
    generation: 1,
    claimDigestSha256: await sha256Text(`${seed}-resolution-claim`),
    authorizationDigestSha256:
      await sha256Text(`${seed}-resolution-authorization`),
    resolverIdentitySha256: await sha256Text(`${seed}-resolution-resolver`),
    journalHeadOrdinal: journal.journalHeadOrdinal ?? 1,
    journalHeadDigestSha256:
      journal.journalHeadDigestSha256 ?? fixture.intentDigestSha256,
    pendingMutationIntentOrdinal: 1,
    pendingMutationIntentDigestSha256: fixture.intentDigestSha256,
    expectedTargetStateSha256: await sha256Text(`${seed}-target-placeholder`),
    executionDisabledEvidenceDigestSha256:
      executionDisabledEvidence.evidenceSha256,
    executionDisabledEvidence,
    claim: { contract: "deployment-resolution-claim-v1", seed },
    quiescedAt: executionDisabledEvidence.executionDisabledAt,
    settleNotBefore: executionDisabledEvidence.quiescenceSatisfiedAt,
    sourceAuthenticationExpiresAt: databaseNow + 60,
    authorizationExpiresAt: databaseNow + 60,
    claimLeaseSeconds: 45,
  };
  const target = await buildObservedReadback(
    fixture,
    provisional,
    1,
    await sha256Text(`${seed}-target-probe-request`),
  );
  if (target.remoteStateSha256 === null) {
    throw new Error("target readback did not produce a remote-state digest");
  }
  return { ...provisional, expectedTargetStateSha256: target.remoteStateSha256 };
}

async function buildObservedReadback(
  fixture: Awaited<ReturnType<typeof seedInflightOperation>>,
  claim: ResolutionClaimInput,
  ordinal: 1 | 2,
  requestDigestSha256: string,
  options: {
    readonly versionId?: string;
    readonly requestIdSeed?: string;
  } = {},
) {
  const versionId = options.versionId ?? "target-version-001";
  return buildJsonCompatibilityDeploymentTransitionReadback({
    readbackRequestSha256: requestDigestSha256,
    readbackServiceIdentitySha256: fixture.readbackIdentitySha256,
    classification: "observed",
    accountIdSha256: fixture.accountIdSha256,
    serviceName: "cinatoken-target-service",
    entrypoint: "TargetEntrypoint",
    versionId,
    configSha256: await sha256Text(`target-config-${versionId}`),
    deploymentState: "status-only",
    gates: { executionEnabled: false, statusReadEnabled: true },
    privateRpcOnly: true,
    workersDev: false,
    previewUrls: false,
    bindingSetSha256: await sha256Text("target-binding-set"),
    routeSetSha256: await sha256Text("target-route-set"),
    secretNameSetSha256: await sha256Text("target-secret-name-set"),
    durableObjectMigrationSetSha256:
      await sha256Text("target-durable-object-migrations"),
    authenticationIdentitySha256: fixture.readbackCredentialIdSha256,
    readbackRequestIdSha256: await sha256Text(
      options.requestIdSeed ?? `${claim.claimDigestSha256}-rpc-${ordinal}`,
    ),
    remoteEvidenceSha256:
      await sha256Text(`${claim.claimDigestSha256}-remote-${ordinal}`),
    authenticationEvidenceSha256:
      await sha256Text(`${claim.claimDigestSha256}-auth-${ordinal}`),
    observedAt: claim.settleNotBefore + (ordinal - 1) * 6,
  });
}

async function resolutionFinalizeInput(
  fixture: Awaited<ReturnType<typeof seedInflightOperation>>,
  claim: ResolutionClaimInput,
  first: ResolutionObservationInput,
  second: ResolutionObservationInput,
  classification: ResolutionFinalizeInput["classification"],
): Promise<ResolutionFinalizeInput> {
  const subject = {
    schemaVersion: 1,
    contract: "deployment-resolution-receipt-v1",
    operationIdSha256: fixture.operationIdSha256,
    operationDigestSha256: fixture.operationDigestSha256,
    claimGeneration: claim.generation,
    classification,
    targetReadbacks: [first.observation, second.observation],
    nextTransitionAllowed: false,
    mutationCalled: false,
  };
  const resolutionDigestSha256 = await sha256Text(canonicalJson(subject));
  return {
    operationIdSha256: fixture.operationIdSha256,
    operationDigestSha256: fixture.operationDigestSha256,
    generation: claim.generation,
    claimDigestSha256: claim.claimDigestSha256,
    classification,
    observationOneDigestSha256: first.observationDigestSha256,
    observationTwoDigestSha256: second.observationDigestSha256,
    resolutionDigestSha256,
    resolution: {
      ...subject,
      resolutionReceiptSha256: resolutionDigestSha256,
    },
  };
}

async function expectReplaceRejected(
  database: D1Database,
  table: string,
  whereClause: string,
  bindings: unknown[],
): Promise<void> {
  const before = await database.prepare(
    `SELECT * FROM ${table} WHERE ${whereClause}`,
  ).bind(...bindings).first<Record<string, unknown>>();
  expect(before).not.toBeNull();
  await expect(database.prepare(
    `INSERT OR REPLACE INTO ${table}
     SELECT * FROM ${table} WHERE ${whereClause}`,
  ).bind(...bindings).run()).rejects.toThrow();
  const after = await database.prepare(
    `SELECT * FROM ${table} WHERE ${whereClause}`,
  ).bind(...bindings).first<Record<string, unknown>>();
  expect(after).toEqual(before);
}

async function rowCount(database: D1Database, table: string): Promise<number> {
  const row = await database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ readonly count: number }>();
  return row?.count ?? -1;
}
