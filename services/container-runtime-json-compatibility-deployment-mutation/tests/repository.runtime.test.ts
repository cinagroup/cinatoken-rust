import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { JsonCompatibilityDeploymentMutationEnv } from "../src/mutator";
import type { PreparedDeploymentMutation } from "../src/protocol";
import {
  D1MutationJournal,
  readMutationSnapshot,
} from "../src/repository";

interface RuntimeTestEnv extends JsonCompatibilityDeploymentMutationEnv {
  readonly TEST_D1_MIGRATIONS: D1Migration[];
}

const runtimeEnv = env as unknown as RuntimeTestEnv;

beforeEach(async () => {
  await applyD1Migrations(runtimeEnv.DB, runtimeEnv.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

describe("D1 deployment mutation create-once journal", () => {
  test("linearizes concurrent claims and preserves exact evidence", async () => {
    const mutation = preparedMutation();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        new D1MutationJournal(runtimeEnv.DB).reserve(mutation)),
    );
    expect(claims.filter((value) => value.classification === "fresh"))
      .toHaveLength(1);
    expect(claims.filter((value) => value.classification === "exact_replay"))
      .toHaveLength(7);
    const snapshot = await readMutationSnapshot(
      runtimeEnv.DB,
      mutation.mutationIntentSha256,
    );
    expect(snapshot.claim.canonical_intent).toBe(mutation.mutationIntentJson);
    expect(snapshot.claim.exact_request_body).toBe(mutation.requestBody);
    expect(snapshot.claim.endpoint_path).toBe(mutation.endpointPath);
    expect(snapshot.claim.mutation_service_identity_json)
      .toBe(mutation.mutationServiceIdentityJson);
    expect(snapshot.outcome).toBeNull();
  });

  test("stores one immutable canonical outcome", async () => {
    const mutation = preparedMutation();
    const journal = new D1MutationJournal(runtimeEnv.DB);
    await journal.reserve(mutation);
    const outcome = {
      schemaVersion: 2,
      contract:
        "cinatoken-container-runtime-json-compatibility-deployment-transition-mutation-outcome-v2",
      mutationIntentSha256: mutation.mutationIntentSha256,
      mutationRpcRequestSha256: mutation.mutationRpcRequestSha256,
      mutationServiceIdentitySha256: mutation.mutationServiceIdentitySha256,
      authenticationIdentitySha256: mutation.authenticationIdentitySha256,
      mutationRequestSha256: mutation.mutationRequestSha256,
      mutationAnnotationSha256: mutation.mutationAnnotationSha256,
      endpointSha256: mutation.endpointSha256,
      sentAt: 1_786_000_000,
      classification: "ambiguous",
      httpStatus: null,
      responseBodySha256: null,
      responseRequestIdSha256: null,
      responseBytes: null,
      outcomeDigestSha256: hex("e"),
    };
    await journal.recordOutcome(mutation.mutationIntentSha256, outcome);
    const replay = await journal.recordOutcome(
      mutation.mutationIntentSha256,
      outcome,
    );
    expect(replay.classification).toBe("ambiguous");
    await expect(runtimeEnv.DB.prepare(
      `UPDATE json_compatibility_deployment_mutation_claims
       SET target_version_id = 'changed'
       WHERE mutation_intent_sha256 = ?1`,
    ).bind(mutation.mutationIntentSha256).run()).rejects.toThrow();
  });
});

function preparedMutation(): PreparedDeploymentMutation {
  const mutationIntent = {
    mutationIntentSha256: hex("a"),
  };
  const mutationServiceIdentity = {
    identitySha256: hex("b"),
  };
  return {
    envelope: {
      campaignPlan: {},
      statePlan: {},
      authorizedTransition: {},
      sourceAuthentication: {},
      mutationIntent,
      sourceReadbacks: [],
    },
    mutationIntent,
    mutationIntentJson: JSON.stringify(mutationIntent),
    mutationIntentSha256: hex("a"),
    mutationRpcRequestSha256: hex("1"),
    operationIdSha256: hex("2"),
    operationDigestSha256: hex("3"),
    authorizedRequestSha256: hex("4"),
    campaignPlanDigestSha256: hex("5"),
    statePlanDigestSha256: hex("6"),
    executionAuthoritySha256: hex("7"),
    sourceAuthenticationDigestSha256: hex("8"),
    sourceReadbackSetSha256: hex("9"),
    role: "controller",
    targetServiceName: "cinatoken-container-controller-staging",
    targetEntrypoint: "JsonCompatibilityProbeEntrypoint",
    targetVersionId: "controller-version-target",
    targetConfigSha256: hex("c"),
    requestBody:
      '{"annotations":{"workers/message":"mutation"},"strategy":"percentage","versions":[{"percentage":100,"version_id":"controller-version-target"}]}',
    mutationRequestSha256: hex("d"),
    mutationAnnotation: "mutation",
    mutationAnnotationSha256: hex("e"),
    endpointPath:
      "/client/v4/accounts/account/workers/scripts/cinatoken-container-controller-staging/deployments",
    endpointSha256: hex("f"),
    mutationServiceIdentity,
    mutationServiceIdentityJson: JSON.stringify(mutationServiceIdentity),
    mutationServiceIdentitySha256: hex("b"),
    credentialIdSha256: hex("c"),
    authenticationIdentitySha256: hex("d"),
    accountIdSha256: hex("e"),
    mutatorServiceName:
      "cinatoken-container-runtime-json-compatibility-deployment-mutation-staging",
    mutatorEntrypoint: "JsonCompatibilityDeploymentMutationEntrypoint",
    mutatorVersionId: "mutation-version-2026-08",
    mutatorProfileVersion: 1,
  };
}

function hex(value: string): string {
  return value.repeat(64);
}
