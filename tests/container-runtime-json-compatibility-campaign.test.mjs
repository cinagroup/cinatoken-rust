import { describe, expect, test } from "bun:test";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  buildJsonCompatibilityCampaignPlan,
  createJsonHealthProbeDigestRecord,
  createSyntheticJsonCompatibilityEvidence,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
  verifyJsonCompatibilityCampaignEvidence,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";

const config = JSON.parse(
  await Bun.file(
    new URL(
      "../services/container-controller/wrangler.staging.jsonc",
      import.meta.url,
    ),
  ).text(),
);
config.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";

const validInputs = Object.freeze({
  campaignIdSha256: "11".repeat(32),
  controllerVersionId: "controller-version-001",
  operatorVersionId: "operator-version-001",
  operatorConfigSha256: "66".repeat(32),
  invokerVersionId: "invoker-version-001",
  invokerConfigSha256: "77".repeat(32),
  permitIssuerVersionId: "permit-issuer-version-001",
  permitIssuerConfigSha256: "88".repeat(32),
  executorVersionId: "executor-version-001",
  executorConfigSha256: "99".repeat(32),
  runtimeNBuildIdSha256: "22".repeat(32),
  runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
  runtimeNMinusOneBuildIdSha256: "44".repeat(32),
  runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
  candidateShardIndex: 3,
});

function buildPlan(overrides = {}, configOverride = config) {
  return buildJsonCompatibilityCampaignPlan({
    config: structuredClone(configOverride),
    ...validInputs,
    ...overrides,
  });
}

function remoteEvidence(plan) {
  const evidence = createSyntheticJsonCompatibilityEvidence(plan);
  evidence.evidenceSource = "remote-staging";
  return evidence;
}

function resignPlan(plan) {
  const subject = structuredClone(plan);
  delete subject.planDigestSha256;
  plan.planDigestSha256 = sha256Canonical(subject);
  return plan;
}

function probeWire(identity, inputSha256 = "aa".repeat(32)) {
  const operationId = `operation-${identity}`;
  const traceId = `trace-${identity}`;
  return {
    request: JSON.stringify({
      protocol_version: 1,
      operation_id: operationId,
      operation_kind: "health_probe",
      owner_generation: identity + 1,
      owner_lease_expires_at: 1_800_000_120 + identity,
      execution_deadline_at: 1_800_000_060 + identity,
      provider_operation_id: `provider-operation-${identity}`,
      admission_sha256: String(identity).padStart(64, "0"),
      input: {
        mode: "inline",
        sha256: inputSha256,
        size: 0,
        content_type: "application/json",
      },
      shard: {
        contract_version: 1,
        ring_generation: 1,
        shard_count: 8,
        shard_index: 3,
        instance_name: "cinatoken-relay-shard-v1-0003",
      },
      trace_id: traceId,
    }),
    response: JSON.stringify({
      protocol_version: 1,
      operation_id: operationId,
      status: "completed",
      trace_id: traceId,
    }),
  };
}

test("health-probe projection removes only volatile execution identity", () => {
  const firstWire = probeWire(1);
  const secondWire = probeWire(2);
  const first = createJsonHealthProbeDigestRecord(
    firstWire.request,
    firstWire.response,
  );
  const second = createJsonHealthProbeDigestRecord(
    secondWire.request,
    secondWire.response,
  );

  expect(first.requestSha256).not.toBe(second.requestSha256);
  expect(first.responseSha256).not.toBe(second.responseSha256);
  expect(first.requestCompatibilitySha256).toBe(
    second.requestCompatibilitySha256,
  );
  expect(first.responseCompatibilitySha256).toBe(
    second.responseCompatibilitySha256,
  );

  const semanticDrift = probeWire(2, "bb".repeat(32));
  expect(
    createJsonHealthProbeDigestRecord(
      semanticDrift.request,
      semanticDrift.response,
    ).requestCompatibilitySha256,
  ).not.toBe(first.requestCompatibilitySha256);

  const mismatchedResponse = JSON.parse(secondWire.response);
  mismatchedResponse.operation_id = "operation-other";
  expect(() =>
    createJsonHealthProbeDigestRecord(
      secondWire.request,
      JSON.stringify(mismatchedResponse),
    ),
  ).toThrow(/response operation ID/);
});

describe("container runtime JSON compatibility campaign plan", () => {
  test("builds a deterministic, private, isolated-gate four-phase plan", () => {
    const plan = buildPlan();

    expect(validateJsonCompatibilityCampaignPlan(plan)).toEqual(plan);
    expect(plan.environment).toBe("staging");
    expect(plan.controller).toMatchObject({
      serviceName: "cinatoken-container-controller-staging",
      privateProbeTransport: "service-binding",
      jsonCompatibilityProbeEnabled: true,
      workersDev: false,
      previewUrls: false,
      observabilitySamplingRate: 1,
      protobufTransportEnabled: false,
      protobufTransportStagingVerified: false,
      allActionGatesDisabled: true,
    });
    expect(plan.privateServices).toEqual({
      operator: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-operator-staging",
        entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint",
        versionId: "operator-version-001",
        configSha256: "66".repeat(32),
        gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED",
        privateRpcOnly: true,
      },
      invoker: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-invoker-staging",
        entrypoint: "JsonCompatibilityCampaignInvokerEntrypoint",
        versionId: "invoker-version-001",
        configSha256: "77".repeat(32),
        gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED",
        privateRpcOnly: true,
      },
      permitIssuer: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
        entrypoint: "JsonCompatibilityPermitIssuerEntrypoint",
        versionId: "permit-issuer-version-001",
        configSha256: "88".repeat(32),
        gateName: "JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED",
        privateRpcOnly: true,
      },
      executor: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        entrypoint: "JsonCompatibilityCampaignExecutorEntrypoint",
        versionId: "executor-version-001",
        configSha256: "99".repeat(32),
        gateName: "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
        privateRpcOnly: true,
      },
    });
    expect(plan.ring).toEqual({
      generation: 1,
      shardCount: 8,
      candidateShardIndex: 3,
    });
    expect(plan.phases.map((phase) => phase.id)).toEqual(
      JSON_COMPATIBILITY_PHASE_IDS,
    );
    expect(plan.phases[1].topology).toEqual({
      defaultRuntime: "n-minus-one",
      overrides: [{ shardIndex: 3, runtime: "n" }],
    });
    expect(plan.executionBoundary).toEqual({
      credentialsRead: false,
      networkRequestsPerformed: false,
      filesWritten: false,
      deploymentMutationAuthorized: false,
      deploymentMutationPerformed: false,
      activationGateChangeAuthorized: false,
      remoteEvidenceCollected: false,
      privateProbeExecutorRequired: true,
      publicUrlAllowed: false,
    });
  });

  test("derives a bounded candidate shard when none is supplied", () => {
    const plan = buildPlan({ candidateShardIndex: undefined });
    expect(plan.ring.candidateShardIndex).toBeGreaterThanOrEqual(0);
    expect(plan.ring.candidateShardIndex).toBeLessThan(plan.ring.shardCount);
    expect(buildPlan({ candidateShardIndex: undefined }).planDigestSha256).toBe(
      plan.planDigestSha256,
    );
  });

  test("rejects public Controller exposure, partial Protobuf activation, or sampled staging telemetry", () => {
    const publicConfig = structuredClone(config);
    publicConfig.workers_dev = true;
    expect(() => buildPlan({}, publicConfig)).toThrow(/workers_dev/);

    const protobufConfig = structuredClone(config);
    protobufConfig.vars.CONTAINER_PROTOBUF_TRANSPORT_ENABLED = "true";
    expect(() => buildPlan({}, protobufConfig)).toThrow(
      /CONTAINER_PROTOBUF_TRANSPORT_ENABLED/,
    );

    const sampledConfig = structuredClone(config);
    sampledConfig.observability.head_sampling_rate = 0.1;
    expect(() => buildPlan({}, sampledConfig)).toThrow(/sampling rate/);
  });

  test("rejects indistinguishable runtime generations and invalid candidate shards", () => {
    expect(() =>
      buildPlan({
        runtimeNMinusOneBuildIdSha256: validInputs.runtimeNBuildIdSha256,
      }),
    ).toThrow(/build IDs must differ/);
    expect(() =>
      buildPlan({
        runtimeNMinusOneImageDigest: validInputs.runtimeNImageDigest,
      }),
    ).toThrow(/image digests must differ/);
    expect(() => buildPlan({ candidateShardIndex: 8 })).toThrow(
      /candidate shard index/,
    );

    const wrongShardCount = structuredClone(config);
    wrongShardCount.vars.CONTAINER_SHARD_COUNT = "4";
    expect(() => buildPlan({}, wrongShardCount)).toThrow(
      /JSON compatibility shard count/,
    );
  });

  test("requires strict version and config identities for every private service", () => {
    const missingInputs = [
      ["operatorVersionId", /operator version ID/],
      ["operatorConfigSha256", /operator config digest/],
      ["invokerVersionId", /invoker version ID/],
      ["invokerConfigSha256", /invoker config digest/],
      ["permitIssuerVersionId", /permit issuer version ID/],
      ["permitIssuerConfigSha256", /permit issuer config digest/],
      ["executorVersionId", /executor version ID/],
      ["executorConfigSha256", /executor config digest/],
    ];
    for (const [input, expected] of missingInputs) {
      expect(() => buildPlan({ [input]: undefined })).toThrow(expected);
    }

    expect(() => buildPlan({ operatorVersionId: "operator version" })).toThrow(
      /operator version ID/,
    );
    expect(() => buildPlan({ executorConfigSha256: "AA".repeat(32) })).toThrow(
      /executor config digest/,
    );
  });

  test("rejects private service name, entrypoint, gate, or public RPC drift", () => {
    const drifts = [
      [
        "operator",
        "serviceName",
        "cinatoken-container-runtime-json-compatibility-operator-other",
        /operator service name/,
      ],
      [
        "invoker",
        "entrypoint",
        "JsonCompatibilityCampaignInvokerOtherEntrypoint",
        /invoker entrypoint/,
      ],
      [
        "permitIssuer",
        "gateName",
        "JSON_COMPATIBILITY_PERMIT_ISSUER_PUBLIC_ENABLED",
        /permitIssuer gate name/,
      ],
      ["executor", "privateRpcOnly", false, /executor private RPC requirement/],
    ];
    for (const [role, field, value, expected] of drifts) {
      const plan = structuredClone(buildPlan());
      plan.privateServices[role][field] = value;
      expect(() => validateJsonCompatibilityCampaignPlan(resignPlan(plan))).toThrow(
        expected,
      );
    }
  });

  test("detects plan tampering through the canonical digest", () => {
    const plan = structuredClone(buildPlan());
    plan.ring.candidateShardIndex = 4;
    expect(() => validateJsonCompatibilityCampaignPlan(plan)).toThrow(
      /canonical digest/,
    );

    const versionTamper = structuredClone(buildPlan());
    versionTamper.privateServices.invoker.versionId = "invoker-version-tampered";
    expect(() => validateJsonCompatibilityCampaignPlan(versionTamper)).toThrow(
      /canonical digest/,
    );

    const configTamper = structuredClone(buildPlan());
    configTamper.privateServices.executor.configSha256 = "aa".repeat(32);
    expect(() => validateJsonCompatibilityCampaignPlan(configTamper)).toThrow(
      /canonical digest/,
    );
  });
});

describe("container runtime JSON compatibility evidence", () => {
  test("verifies all four topologies, every shard, byte parity, and zero-mutation totals", () => {
    const plan = buildPlan();
    const evidence = remoteEvidence(plan);

    const result = verifyJsonCompatibilityCampaignEvidence(plan, evidence);

    expect(result).toMatchObject({
      ok: true,
      mode: "offline-verification",
      evidenceSource: "remote-staging",
      phaseCount: 4,
      shardCount: 8,
      observationCount: 32,
      jsonByteCompatibilityPassed: true,
      rollbackLedgerConverged: true,
      protobufAttemptCount: 0,
      legacyJsonFallbackCount: 0,
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
      networkRequestsPerformed: false,
      deploymentMutationPerformed: false,
    });
  });

  test("rejects synthetic evidence unless explicitly running a self-test", () => {
    const plan = buildPlan();
    const evidence = createSyntheticJsonCompatibilityEvidence(plan);

    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, evidence)).toThrow(
      /source must be remote-staging/,
    );
    expect(
      verifyJsonCompatibilityCampaignEvidence(plan, evidence, {
        allowSynthetic: true,
      }).evidenceSource,
    ).toBe("synthetic-self-test");
  });

  test("binds evidence to the complete private service identity plan", () => {
    const approvedPlan = buildPlan();
    const evidence = remoteEvidence(approvedPlan);
    const driftedPlan = buildPlan({
      permitIssuerVersionId: "permit-issuer-version-002",
    });

    expect(() =>
      verifyJsonCompatibilityCampaignEvidence(driftedPlan, evidence),
    ).toThrow(/plan digest/);
  });

  test("rejects a missing, duplicate, reordered, or wrong-build shard observation", () => {
    const plan = buildPlan();

    const missing = remoteEvidence(plan);
    missing.phases[1].observations.pop();
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, missing)).toThrow(
      /exactly 8 shard observations/,
    );

    const reordered = remoteEvidence(plan);
    [reordered.phases[1].observations[0], reordered.phases[1].observations[1]] = [
      reordered.phases[1].observations[1],
      reordered.phases[1].observations[0],
    ];
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, reordered)).toThrow(
      /shard 0 index/,
    );

    const wrongBuild = remoteEvidence(plan);
    wrongBuild.phases[1].observations[3].runtimeBuildIdSha256 = "66".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, wrongBuild)).toThrow(
      /runtime build ID/,
    );
  });

  test("rejects Protobuf selection, fallback, recovery, or incomplete telemetry", () => {
    const plan = buildPlan();

    const protobuf = remoteEvidence(plan);
    protobuf.phases[2].observations[0].healthProbe.selectedTransport = "protobuf";
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, protobuf)).toThrow(
      /selected transport/,
    );

    const fallback = remoteEvidence(plan);
    fallback.phases[2].transportTotals.legacyJsonFallbackCount = 1;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, fallback)).toThrow(
      /legacyJsonFallbackCount/,
    );

    const recovery = remoteEvidence(plan);
    recovery.phases[2].transportTotals.recoveryRequiredCount = 1;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, recovery)).toThrow(
      /recoveryRequiredCount/,
    );

    const incomplete = remoteEvidence(plan);
    incomplete.phases[2].transportTotals.eventsObserved = 7;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, incomplete)).toThrow(
      /eventsObserved/,
    );
  });

  test("binds raw wire digests but compares normalized JSON projections across N/N-1", () => {
    const plan = buildPlan();
    const requestDrift = remoteEvidence(plan);
    expect(
      requestDrift.phases[0].observations[3].healthProbe.requestSha256,
    ).not.toBe(requestDrift.phases[1].observations[3].healthProbe.requestSha256);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, requestDrift)).not.toThrow();

    requestDrift.phases[1].observations[3].healthProbe.requestCompatibilitySha256 =
      "66".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, requestDrift)).toThrow(
      /compatibility projection drifted/,
    );

    const responseDrift = remoteEvidence(plan);
    responseDrift.phases[2].observations[5].healthProbe.responseCompatibilitySha256 =
      "77".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, responseDrift)).toThrow(
      /compatibility projection drifted/,
    );

    const replayed = remoteEvidence(plan);
    replayed.phases[1].observations[3].healthProbe.requestSha256 =
      replayed.phases[0].observations[3].healthProbe.requestSha256;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, replayed)).toThrow(
      /raw request digest was reused/,
    );
  });

  test("rejects provider, billing, storage, production traffic, or public probe mutations", () => {
    const plan = buildPlan();

    const provider = remoteEvidence(plan);
    provider.phases[0].zeroMutationProof.providerRequestCount = 1;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, provider)).toThrow(
      /providerRequestCount/,
    );

    const billing = remoteEvidence(plan);
    billing.phases[0].zeroMutationProof.billingAfterSha256 = "88".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, billing)).toThrow(
      /billing snapshot/,
    );

    const storage = remoteEvidence(plan);
    storage.phases[0].zeroMutationProof.storageGatewayAfterSha256 = "99".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, storage)).toThrow(
      /storage gateway snapshot/,
    );

    const traffic = remoteEvidence(plan);
    traffic.phases[0].zeroMutationProof.productionTrafficRequestCount = 1;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, traffic)).toThrow(
      /productionTrafficRequestCount/,
    );

    const publicProbe = remoteEvidence(plan);
    publicProbe.phases[0].zeroMutationProof.publicProbeRequestCount = 1;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, publicProbe)).toThrow(
      /publicProbeRequestCount/,
    );
  });

  test("rejects Controller deployment drift, phase overlap, or rollback non-convergence", () => {
    const plan = buildPlan();

    const controllerDrift = remoteEvidence(plan);
    controllerDrift.phases[2].controllerDeploymentSetSha256 = "99".repeat(32);
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, controllerDrift)).toThrow(
      /Controller deployment drifted/,
    );

    const overlap = remoteEvidence(plan);
    overlap.phases[1].startedAt = "2026-08-03T00:00:30Z";
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, overlap)).toThrow(
      /overlaps the previous phase/,
    );

    const rollback = remoteEvidence(plan);
    rollback.phases[3].ledgerConverged = false;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, rollback)).toThrow(
      /ledger convergence/,
    );
  });

  test("rejects Controller identity or aggregate claims that do not match the plan", () => {
    const plan = buildPlan();

    const identity = remoteEvidence(plan);
    identity.controller.privateProbeTransport = "public-url";
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, identity)).toThrow(
      /Controller identity/,
    );

    const aggregate = remoteEvidence(plan);
    aggregate.aggregate.observationCount = 31;
    expect(() => verifyJsonCompatibilityCampaignEvidence(plan, aggregate)).toThrow(
      /observation count/,
    );
  });
});

test("package scripts keep the planner and verifier in the repository gate", async () => {
  const packageJson = JSON.parse(
    await Bun.file(new URL("../package.json", import.meta.url)).text(),
  );
  expect(packageJson.scripts["check:container-runtime:json-compatibility-campaign"]).toContain(
    "container-runtime-json-compatibility-campaign.test.mjs",
  );
  expect(packageJson.scripts["check:container-runtime:json-compatibility-campaign"]).toContain(
    "plan_container_runtime_json_compatibility_campaign.mjs --self-test",
  );
  expect(packageJson.scripts["check:container-runtime:json-compatibility-campaign"]).toContain(
    "verify_container_runtime_json_compatibility_evidence.mjs --self-test",
  );
  expect(packageJson.scripts["check:container-runtime:json-compatibility-campaign"]).toContain(
    "prepare_container_runtime_json_compatibility_operator_config.mjs --help",
  );
  expect(packageJson.scripts["check:container-runtime:json-compatibility-operator"]).toContain(
    "build:container-runtime:json-compatibility-operator",
  );
  expect(packageJson.scripts.check).toContain(
    "check:container-runtime:json-compatibility-campaign",
  );
  expect(packageJson.scripts.check).toContain(
    "check:container-runtime:json-compatibility-operator",
  );
});
