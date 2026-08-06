import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  JSON_COMPATIBILITY_PLAN_CONTRACT,
  canonicalJson,
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
} from "../tools/container_runtime_json_compatibility_deployment_states.mjs";
import {
  JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_AUDIENCE,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT,
  JsonCompatibilityDeploymentTransitionUncertainError,
  buildJsonCompatibilityDeploymentTransitionMutationOutcome,
  buildJsonCompatibilityDeploymentTransitionReadback,
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
  buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
  executeJsonCompatibilityDeploymentTransition,
  signJsonCompatibilityDeploymentTransition,
  validateJsonCompatibilityDeploymentTransitionAuthorization,
  validateJsonCompatibilityDeploymentTransitionReceipt,
} from "../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";
import {
  EXPECTED_ROLE_ORDERS,
  TRANSITION_IDS,
  buildArtifactInventoryReadback,
  buildCampaignPlan,
  buildExecutionAuthority,
  buildSourceEvidence,
  buildStatePlan,
  digest,
} from "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

const NOW = 1_786_000_000;
const ACCOUNT_ID_SHA256 = digest("cloudflare-account-staging");

let directory;
let privateKeyBytes;
let campaignPlan;
let statePlan;
let artifactInventoryReadback;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cinatoken-transition-executor-"));
  const configPath = path.join(directory, "controller-execution.jsonc");
  await prepareJsonCompatibilityControllerConfig({ outPath: configPath });
  const controllerConfig = JSON.parse(await readFile(configPath, "utf8"));
  const keys = generateKeyPairSync("ed25519");
  privateKeyBytes = keys.privateKey.export({ format: "der", type: "pkcs8" });
  const approvalSpkiSha256 = createHash("sha256")
    .update(keys.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  statePlan = buildStatePlan(sha256Canonical(controllerConfig));
  campaignPlan = buildCampaignPlan(
    controllerConfig,
    statePlan,
    approvalSpkiSha256,
  );
  artifactInventoryReadback = buildArtifactInventoryReadback(
    campaignPlan,
    statePlan,
    ACCOUNT_ID_SHA256,
    NOW - 120,
  );
});

afterAll(async () => {
  privateKeyBytes.fill(0);
  await rm(directory, { recursive: true, force: true });
});

describe("JSON compatibility deployment transition authorization", () => {
  test("binds Plan v5, state-plan v2, exact frozen steps, source, authority, and a dedicated signature domain", () => {
    const authorized = authorize(TRANSITION_IDS[1]);
    expect(validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      authorized,
    )).toEqual(authorized);
    expect(authorized).toMatchObject({
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_AUTHORIZED_DEPLOYMENT_TRANSITION_CONTRACT,
      request: {
        mode: "remote-create-once",
        campaignPlan: {
          schemaVersion: 4,
          contract: JSON_COMPATIBILITY_PLAN_CONTRACT,
          planDigestSha256: campaignPlan.planDigestSha256,
        },
        statePlan: {
          schemaVersion: 2,
          contract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
          planDigestSha256: statePlan.planDigestSha256,
        },
        transition: {
          id: TRANSITION_IDS[1],
          steps: EXPECTED_ROLE_ORDERS[1].map((role) => ({ role })),
        },
        sourceEvidence: buildSourceEvidence(
          ACCOUNT_ID_SHA256,
          statePlan.transitions[1],
          artifactInventoryReadback.artifactInventoryReadbackSha256,
        ),
        artifactInventoryReadback,
        executionAuthority: {
          accountIdSha256: ACCOUNT_ID_SHA256,
          coordinator: { capability: "coordinate-only" },
          sourceVerifier: { capability: "source-verify-only" },
          readback: { capability: "read-only" },
          mutation: { capability: "mutation-only" },
        },
      },
      approval: {
        contract:
          JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_ENVELOPE_CONTRACT,
        subject: {
          contract:
            JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_SUBJECT_CONTRACT,
          audience: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_APPROVAL_AUDIENCE,
          campaignPlanContract: JSON_COMPATIBILITY_PLAN_CONTRACT,
          campaignPlanSchemaVersion: 4,
          statePlanContract: JSON_COMPATIBILITY_DEPLOYMENT_STATE_PLAN_CONTRACT,
          statePlanSchemaVersion: 2,
          executionAuthoritySha256:
            authorized.request.executionAuthority.authorityDigestSha256,
        },
      },
    });
    expect(Object.values(statePlan.services).reduce(
      (count, service) => count + Object.keys(service.artifacts).length,
      0,
    )).toBe(18);
  });

  test("rejects phase-approval substitution and request tampering before dependencies", () => {
    const substituted = structuredClone(authorize(TRANSITION_IDS[0]));
    substituted.contract =
      "cinatoken-container-runtime-json-compatibility-operator-authorized-phase-request-v1";
    expect(() => validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      substituted,
    )).toThrow(/authorized transition contract/);

    const tampered = structuredClone(authorize(TRANSITION_IDS[0]));
    tampered.request.transition.steps.reverse();
    expect(() => validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      tampered,
    )).toThrow(/request transition|request digest/);

    const sourceDrift = structuredClone(authorize(TRANSITION_IDS[0]));
    sourceDrift.request.sourceEvidence.immutableSourceArchiveReceiptSha256 =
      digest("other");
    expect(() => validateJsonCompatibilityDeploymentTransitionAuthorization(
      campaignPlan,
      statePlan,
      sourceDrift,
    )).toThrow(/request digest|signature/);
  });

  test("enforces the status-only hold at the exact 86,400-second boundary", () => {
    expect(() => authorize(TRANSITION_IDS[3], {
      enteredAt: NOW - JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS + 1,
    })).toThrow(/minimum state hold/);
    expect(() => authorize(TRANSITION_IDS[3], {
      enteredAt: NOW - JSON_COMPATIBILITY_DEPLOYMENT_STATUS_HOLD_SECONDS,
    })).not.toThrow();
  });
});

describe("JSON compatibility deterministic deployment transition executor", () => {
  test("executes all four frozen transitions in exact order with one mutation per step", async () => {
    const originalFetch = globalThis.fetch;
    let implicitFetches = 0;
    globalThis.fetch = async () => {
      implicitFetches += 1;
      throw new Error("implicit network access is forbidden");
    };
    try {
      for (let index = 0; index < TRANSITION_IDS.length; index += 1) {
        const authorized = authorize(TRANSITION_IDS[index]);
        const harness = createHarness(authorized);
        const receipt = await executeJsonCompatibilityDeploymentTransition({
          campaignPlan,
          statePlan,
          authorizedTransition: authorized,
          dependencies: harness.dependencies,
        });
        expect(receipt.contract)
          .toBe(JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_RECEIPT_CONTRACT);
        expect(receipt.result).toBe("completed");
        expect(receipt.nextTransitionAllowed).toBe(true);
        expect(receipt.automaticRetries).toBe(0);
        expect(receipt.mutationAttempts).toBe(EXPECTED_ROLE_ORDERS[index].length);
        expect(receipt.readbackAttempts)
          .toBe(EXPECTED_ROLE_ORDERS[index].length * 4);
        expect(harness.mutations.map((value) => value.role))
          .toEqual(EXPECTED_ROLE_ORDERS[index]);
        expect(receipt.steps.map((value) => value.role))
          .toEqual(EXPECTED_ROLE_ORDERS[index]);
        expect(validateJsonCompatibilityDeploymentTransitionReceipt(
          campaignPlan,
          statePlan,
          authorized,
          receipt,
        )).toEqual(receipt);
        for (const mutation of harness.mutations) {
          const intentIndex = harness.events.findIndex(
            (event) => event.kind === "mutation_intent"
              && event.payload.mutationIntentSha256
                === mutation.mutationIntentSha256,
          );
          const networkIndex = harness.timeline.indexOf(
            `mutate:${mutation.mutationIntentSha256}`,
          );
          expect(intentIndex).toBeGreaterThanOrEqual(0);
          expect(networkIndex).toBeGreaterThanOrEqual(0);
          expect(harness.timeline.indexOf(
            `append:${mutation.mutationIntentSha256}`,
          )).toBeLessThan(networkIndex);
        }
      }
      expect(implicitFetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("confirms an ambiguous mutation only through two stable target readbacks", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const harness = createHarness(authorized, {
      mutationClassification: ({ role }) => role === "invoker"
        ? "ambiguous"
        : "accepted",
    });
    const receipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: harness.dependencies,
    });
    expect(receipt.result).toBe("completed");
    expect(receipt.steps[0].result)
      .toBe("completed_after_ambiguous_mutation");
    expect(harness.mutations.filter((value) => value.role === "invoker"))
      .toHaveLength(1);
    expect(receipt.automaticRetries).toBe(0);
  });

  test("stops after a rejected mutation and never touches later roles", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const harness = createHarness(authorized, {
      mutationClassification: ({ role }) => role === "operator"
        ? "rejected"
        : "accepted",
    });
    const receipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: harness.dependencies,
    });
    expect(receipt).toMatchObject({
      result: "stopped",
      stopReason: "mutation_rejected",
      nextTransitionAllowed: false,
      mutationAttempts: 2,
      automaticRetries: 0,
    });
    expect(harness.mutations.map((value) => value.role))
      .toEqual(["invoker", "operator"]);
    expect(receipt.steps.at(-1).targetReadbacks).toEqual([]);
  });

  test("fails before mutation on source drift and after mutation on unstable target readback", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const sourceDrift = createHarness(authorized, {
      readbackOverride: ({ phase, step, value }) => (
        phase === "source" && step.role === "invoker"
          ? { ...value, versionId: "unexpected-version" }
          : value
      ),
    });
    const sourceReceipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: sourceDrift.dependencies,
    });
    expect(sourceReceipt.stopReason).toBe("source_state_drift");
    expect(sourceDrift.mutations).toHaveLength(0);

    const unstable = createHarness(authorized, {
      readbackOverride: ({ phase, observationOrdinal, step, value }) => (
        phase === "target"
          && step.role === "invoker"
          && observationOrdinal === 2
          ? { ...value, observedAt: value.observedAt - 4 }
          : value
      ),
    });
    const targetReceipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: unstable.dependencies,
    });
    expect(targetReceipt.stopReason).toBe("target_state_unstable");
    expect(unstable.mutations).toHaveLength(1);
    expect(unstable.mutations[0].role).toBe("invoker");
  });

  test("rejects a substituted Reader identity before the first mutation", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const substitutedService = createHarness(authorized, {
      readbackOverride: ({ phase, step, value }) => (
        phase === "source" && step.role === "invoker"
          ? {
              ...value,
              readbackServiceIdentitySha256:
                digest("substituted-readback-service"),
            }
          : value
      ),
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: substitutedService.dependencies,
    })).rejects.toThrow(/readback observation service identity/);
    expect(substitutedService.mutations).toHaveLength(0);

    const substitutedCredential = createHarness(authorized, {
      readbackOverride: ({ phase, step, value }) => (
        phase === "source" && step.role === "invoker"
          ? {
              ...value,
              authenticationIdentitySha256:
                digest("substituted-readback-credential"),
            }
          : value
      ),
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: substitutedCredential.dependencies,
    })).rejects.toThrow(/readback observation credential identity/);
    expect(substitutedCredential.mutations).toHaveLength(0);
  });

  test("requires distinct, time-separated readbacks and rechecks approval immediately before mutation", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const repeatedRequest = createHarness(authorized, {
      readbackOverride: ({ phase, observationOrdinal, step, value }) => (
        phase === "source"
          && step.role === "invoker"
          && observationOrdinal === 2
          ? {
              ...value,
              readbackRequestIdSha256: digest("readback-request:1"),
            }
          : value
      ),
    });
    const unstableReceipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: repeatedRequest.dependencies,
    });
    expect(unstableReceipt.stopReason).toBe("source_state_unstable");
    expect(repeatedRequest.mutations).toHaveLength(0);

    const clock = [NOW, NOW, NOW, NOW, NOW + 596, NOW + 596];
    const expiring = createHarness(authorized, {
      now: () => clock.shift() ?? NOW + 596,
    });
    const expiredReceipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: expiring.dependencies,
    });
    expect(expiredReceipt).toMatchObject({
      result: "stopped",
      stopReason: "approval_expired",
      mutationAttempts: 0,
      automaticRetries: 0,
    });
    expect(expiredReceipt.steps[0].mutationIntent).not.toBeNull();
    expect(expiredReceipt.steps[0].mutationOutcome).toBeNull();
    expect(expiring.mutations).toHaveLength(0);
  });

  test("source rejection seals a zero-mutation receipt", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const harness = createHarness(authorized, {
      sourceClassification: "rejected",
    });
    const receipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: harness.dependencies,
    });
    expect(receipt).toMatchObject({
      result: "stopped",
      stopReason: "source_authentication_rejected",
      nextTransitionAllowed: false,
      steps: [],
      mutationAttempts: 0,
      readbackAttempts: 0,
    });
    expect(harness.mutations).toHaveLength(0);
    expect(harness.readbacks).toHaveLength(0);
  });

  test("cross-binds source authentication to the exact operation and plans", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const harness = createHarness(authorized);
    await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: harness.dependencies,
    });
    expect(harness.sourceAuthenticationRequests).toHaveLength(1);
    expect(harness.sourceAuthenticationRequests[0]).toMatchObject({
      schemaVersion: 2,
      environment: "staging",
      profile: "release-v1",
      operationIdSha256: authorized.request.operationIdSha256,
      campaignPlanDigestSha256: campaignPlan.planDigestSha256,
      statePlanDigestSha256: statePlan.planDigestSha256,
      transition: {
        id: authorized.request.transition.id,
        ordinal: authorized.request.transition.ordinal,
        fromState: authorized.request.transition.fromState,
        toState: authorized.request.transition.toState,
      },
      sourceEvidence: authorized.request.sourceEvidence,
    });

    const substituted = createHarness(authorized, {
      sourceAuthenticationOverride: ({ sourceAuthenticationRequest }) => {
        const detachedRequest =
          buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
            ...sourceAuthenticationRequest,
            operationIdSha256: digest("detached-operation"),
          });
        return buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest: detachedRequest,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            sourceAuthenticationRequest.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("source-authentication-evidence"),
          verifiedAt: NOW,
        });
      },
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: substituted.dependencies,
    })).rejects.toThrow(/authenticated source request/);
    expect(substituted.mutations).toHaveLength(0);
    expect(substituted.readbacks).toHaveLength(0);

    const wrongVerifier = createHarness(authorized, {
      sourceAuthenticationOverride: ({ sourceAuthenticationRequest }) =>
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256: digest("detached-source-verifier"),
          evidenceSha256: digest("detached-verifier-evidence"),
          verifiedAt: NOW,
        }),
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: wrongVerifier.dependencies,
    })).rejects.toThrow(/source verifier identity/);
    expect(wrongVerifier.mutations).toHaveLength(0);
    expect(wrongVerifier.readbacks).toHaveLength(0);

    const stale = createHarness(authorized, {
      sourceAuthenticationOverride: ({ sourceAuthenticationRequest }) =>
        buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
          sourceAuthenticationRequest,
          classification: "authenticated",
          reasonCode: null,
          verifierIdentitySha256:
            sourceAuthenticationRequest.sourceEvidence
              .sourceVerifierIdentitySha256,
          evidenceSha256: digest("stale-source-authentication-evidence"),
          verifiedAt: NOW - 60,
        }),
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: stale.dependencies,
    })).rejects.toThrow(/source authentication proof time/);
    expect(stale.mutations).toHaveLength(0);
    expect(stale.readbacks).toHaveLength(0);
  });

  test("returns an exact archived replay without source, readback, or mutation effects", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const first = createHarness(authorized);
    const receipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: first.dependencies,
    });
    const replay = createHarness(authorized, {
      reservation: { classification: "exact_replay", receipt },
      failOnSideEffect: true,
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: replay.dependencies,
    })).resolves.toEqual(receipt);
    expect(replay.mutations).toHaveLength(0);
    expect(replay.readbacks).toHaveLength(0);
  });

  test("rejects a fully resealed receipt whose mutation intent is detached from its step", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const harness = createHarness(authorized);
    const receipt = await executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: harness.dependencies,
    });
    const detached = structuredClone(receipt);
    detached.steps[0].mutationIntent.role = "caller";
    resealReceipt(detached);
    expect(() => validateJsonCompatibilityDeploymentTransitionReceipt(
      campaignPlan,
      statePlan,
      authorized,
      detached,
    )).toThrow(/mutation intent role/);
  });

  test("treats inflight reservation and journal/archive ambiguity as uncertain without retry", async () => {
    const authorized = authorize(TRANSITION_IDS[0]);
    const inflight = createHarness(authorized, {
      reservation: { classification: "inflight", receipt: null },
      failOnSideEffect: true,
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: inflight.dependencies,
    })).rejects.toMatchObject({
      name: "JsonCompatibilityDeploymentTransitionUncertainError",
      code: "operation_inflight",
    });
    expect(inflight.mutations).toHaveLength(0);

    const journalConflict = createHarness(authorized, {
      appendClassification: ({ event }) => event.kind === "mutation_intent"
        ? "conflict"
        : "appended",
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: journalConflict.dependencies,
    })).rejects.toBeInstanceOf(
      JsonCompatibilityDeploymentTransitionUncertainError,
    );
    expect(journalConflict.mutations).toHaveLength(0);

    const archiveAmbiguous = createHarness(authorized, {
      finalizeClassification: "ambiguous",
    });
    await expect(executeJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      authorizedTransition: authorized,
      dependencies: archiveAmbiguous.dependencies,
    })).rejects.toMatchObject({ code: "receipt_ambiguous" });
    expect(archiveAmbiguous.mutations).toHaveLength(4);
  });
});

function authorize(transitionId, { enteredAt = null } = {}) {
  const transition = statePlan.transitions.find((value) => value.id === transitionId);
  return signJsonCompatibilityDeploymentTransition({
    campaignPlan,
    statePlan,
    transitionId,
    operationIdSha256: digest(`operation:${transitionId}:${enteredAt ?? "default"}`),
    priorStateEvidence: {
      state: transition.fromState,
      enteredAt: enteredAt
        ?? NOW - transition.minimumHoldSeconds,
      evidenceSha256: digest(`prior-state:${transitionId}`),
    },
    sourceEvidence: buildSourceEvidence(
      ACCOUNT_ID_SHA256,
      transition,
      artifactInventoryReadback.artifactInventoryReadbackSha256,
    ),
    artifactInventoryReadback,
    executionAuthority: buildExecutionAuthority(ACCOUNT_ID_SHA256),
    privateKeyBytes,
    now: new Date(NOW * 1000),
  });
}

function createHarness(authorized, options = {}) {
  const events = [];
  const timeline = [];
  const mutations = [];
  const readbacks = [];
  const sourceAuthenticationRequests = [];
  let readbackSequence = 0;
  const sideEffectFailure = () => {
    if (options.failOnSideEffect) throw new Error("unexpected side effect");
  };
  const dependencies = {
    now: options.now ?? (() => NOW),
    authenticateSource: async (sourceAuthenticationRequest) => {
      sideEffectFailure();
      sourceAuthenticationRequests.push(sourceAuthenticationRequest);
      const proof = buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
        sourceAuthenticationRequest,
        classification: options.sourceClassification ?? "authenticated",
        reasonCode: options.sourceClassification === undefined
            || options.sourceClassification === "authenticated"
          ? null
          : `source_fixture_${options.sourceClassification}`,
        verifierIdentitySha256:
          sourceAuthenticationRequest.sourceEvidence
            .sourceVerifierIdentitySha256,
        evidenceSha256: digest("source-authentication-evidence"),
        verifiedAt: NOW,
      });
      return options.sourceAuthenticationOverride === undefined
        ? proof
        : options.sourceAuthenticationOverride({
          sourceAuthenticationRequest,
          proof,
        });
    },
    readback: async (context) => {
      sideEffectFailure();
      readbacks.push(context);
      readbackSequence += 1;
      let value = {
        ...context.expected,
        readbackRequestSha256: context.readbackRequestSha256,
        readbackServiceIdentitySha256:
          authorized.request.executionAuthority.readback.identitySha256,
        classification: "observed",
        authenticationIdentitySha256:
          authorized.request.executionAuthority.readback.credentialIdSha256,
        readbackRequestIdSha256: digest(`readback-request:${readbackSequence}`),
        remoteEvidenceSha256: digest(`remote:${readbackSequence}`),
        authenticationEvidenceSha256: digest(`auth:${readbackSequence}`),
        observedAt: NOW + readbackSequence * 5,
      };
      if (options.readbackOverride !== undefined) {
        value = options.readbackOverride({ ...context, value });
      }
      return buildJsonCompatibilityDeploymentTransitionReadback(value);
    },
    mutateOnce: async ({ mutationIntent: intent }) => {
      sideEffectFailure();
      mutations.push(intent);
      timeline.push(`mutate:${intent.mutationIntentSha256}`);
      const classification = options.mutationClassification?.(intent)
        ?? "accepted";
      return buildJsonCompatibilityDeploymentTransitionMutationOutcome({
        mutationIntent: intent,
        mutationRpcRequestSha256: digest(`mutation-rpc:${intent.role}`),
        mutationServiceIdentitySha256:
          authorized.request.executionAuthority.mutation.identitySha256,
        authenticationIdentitySha256:
          authorized.request.executionAuthority.mutation.credentialIdSha256,
        mutationRequestSha256: digest(`mutation-request:${intent.role}`),
        mutationAnnotationSha256: digest(`mutation-annotation:${intent.role}`),
        endpointSha256: digest(`mutation-endpoint:${intent.role}`),
        sentAt: NOW + readbackSequence * 5 + 1,
        classification,
        httpStatus: classification === "ambiguous"
          ? null
          : classification === "rejected" ? 400 : 200,
        responseBodySha256: classification === "ambiguous"
          ? null
          : digest(`response:${intent.role}`),
        responseRequestIdSha256: classification === "ambiguous"
          ? null
          : digest(`request:${intent.role}`),
        responseBytes: classification === "ambiguous" ? null : 128,
      });
    },
    journal: {
      reserve: async () => options.reservation
        ?? { classification: "reserved", receipt: null },
      append: async (event) => {
        sideEffectFailure();
        events.push(event);
        timeline.push(`append:${event.digestSha256}`);
        return {
          classification: options.appendClassification?.({ event })
            ?? "appended",
        };
      },
      finalize: async (receipt) => {
        sideEffectFailure();
        return {
          classification: options.finalizeClassification ?? "created",
          receipt,
        };
      },
    },
  };
  return {
    dependencies,
    events,
    timeline,
    mutations,
    readbacks,
    sourceAuthenticationRequests,
  };
}

function resealReceipt(receipt) {
  let previousStepReceiptSha256 = null;
  for (const step of receipt.steps) {
    step.previousStepReceiptSha256 = previousStepReceiptSha256;
    if (step.mutationIntent !== null) {
      const { mutationIntentSha256: _intentDigest, ...intentSubject } =
        step.mutationIntent;
      step.mutationIntent.mutationIntentSha256 = sha256Canonical(intentSubject);
    }
    if (step.mutationOutcome !== null) {
      step.mutationOutcome.mutationIntentSha256 =
        step.mutationIntent.mutationIntentSha256;
      const { outcomeDigestSha256: _outcomeDigest, ...outcomeSubject } =
        step.mutationOutcome;
      step.mutationOutcome.outcomeDigestSha256 = sha256Canonical(outcomeSubject);
    }
    const { stepReceiptDigestSha256: _stepDigest, ...stepSubject } = step;
    step.stepReceiptDigestSha256 = sha256Canonical(stepSubject);
    previousStepReceiptSha256 = step.stepReceiptDigestSha256;
  }
  receipt.stepChainHeadSha256 = previousStepReceiptSha256;
  const { receiptDigestSha256: _receiptDigest, ...receiptSubject } = receipt;
  receipt.receiptDigestSha256 = sha256Canonical(receiptSubject);
  return receipt;
}
