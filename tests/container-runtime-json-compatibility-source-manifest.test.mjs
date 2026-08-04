import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildJsonCompatibilityCampaignPlan,
  canonicalJson,
  createJsonHealthProbeDigestRecord,
  sha256Canonical,
  verifyJsonCompatibilityCampaignEvidence,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
  JSON_COMPATIBILITY_SOURCE_MANIFEST_CONTRACT,
  buildJsonCompatibilityEvidenceFromSourceManifest,
  buildJsonCompatibilitySourceManifest,
  createSyntheticJsonCompatibilitySourceManifest,
  validateJsonCompatibilitySourceManifest,
  verifyJsonCompatibilityEvidenceSourceManifestBinding,
} from "../tools/container_runtime_json_compatibility_source_manifest.mjs";
import {
  parseJsonCompatibilitySourceManifestArgs,
  runJsonCompatibilitySourceManifestCollector,
} from "../tools/collect_container_runtime_json_compatibility_source_manifest.mjs";
import {
  runJsonCompatibilityEvidenceProjector,
} from "../tools/project_container_runtime_json_compatibility_evidence.mjs";

const config = JSON.parse(
  await Bun.file(
    new URL(
      "../services/container-controller/wrangler.staging.jsonc",
      import.meta.url,
    ),
  ).text(),
);
config.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function buildPlan() {
  return buildJsonCompatibilityCampaignPlan({
    config: structuredClone(config),
    campaignIdSha256: "11".repeat(32),
    controllerVersionId: "controller-version-source-manifest-001",
    operatorVersionId: "operator-version-source-manifest-001",
    operatorConfigSha256: "b1".repeat(32),
    invokerVersionId: "invoker-version-001",
    invokerConfigSha256: "b2".repeat(32),
    permitIssuerVersionId: "permit-issuer-version-001",
    permitIssuerConfigSha256: "b3".repeat(32),
    executorVersionId: "executor-version-001",
    executorConfigSha256: "b4".repeat(32),
    runtimeNBuildIdSha256: "22".repeat(32),
    runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
    runtimeNMinusOneBuildIdSha256: "44".repeat(32),
    runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
    candidateShardIndex: 3,
  });
}

function buildPhasePackets(plan) {
  const syntheticPhases =
    createSyntheticJsonCompatibilitySourceManifest(plan).phases;
  const controllerDeploymentSetSha256 = sha256Canonical({
    deployment: "controller-staging-fixed",
  });
  return plan.phases.map((phase, phaseIndex) => {
    const shards = Array.from({ length: 8 }, (_, shardIndex) => {
      const override = phase.topology.overrides.find(
        (entry) => entry.shardIndex === shardIndex,
      );
      const runtimeGeneration = override?.runtime ?? phase.topology.defaultRuntime;
      const runtime =
        runtimeGeneration === "n" ? plan.runtimes.n : plan.runtimes.nMinusOne;
      const operationId = `json-source-${phaseIndex}-${shardIndex}`;
      const traceId = `json-source-trace-${phaseIndex}-${shardIndex}`;
      const rawRequest = JSON.stringify({
        protocol_version: 1,
        operation_id: operationId,
        operation_kind: "health_probe",
        owner_generation: phaseIndex + 1,
        owner_lease_expires_at: 1_800_000_120 + phaseIndex,
        execution_deadline_at: 1_800_000_060 + phaseIndex,
        provider_operation_id: `json-source-provider-${phaseIndex}-${shardIndex}`,
        admission_sha256: sha256Canonical({ phaseIndex, shardIndex }),
        input: {
          mode: "inline",
          sha256: "aa".repeat(32),
          size: 0,
          content_type: "application/json",
        },
        shard: {
          contract_version: 1,
          ring_generation: plan.ring.generation,
          shard_count: plan.ring.shardCount,
          shard_index: shardIndex,
          instance_name: `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
        },
        trace_id: traceId,
      });
      const rawResponse = JSON.stringify({
        protocol_version: 1,
        operation_id: operationId,
        status: "completed",
        trace_id: traceId,
      });
      const digests = createJsonHealthProbeDigestRecord(rawRequest, rawResponse);
      const readinessRawJson = JSON.stringify({
        status: "ready",
        protocol_version: 1,
        runtime_build_id: runtime.buildIdSha256,
        shard_contract_version: 1,
        execution_enabled: false,
      });
      const readinessFacts = {
        statusCode: 200,
        contentType: "application/json",
        rawJson: readinessRawJson,
        rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
        rawSha256: createHash("sha256").update(readinessRawJson).digest("hex"),
        runtimeBuildIdSha256: runtime.buildIdSha256,
        protocolVersion: 1,
        shardContractVersion: 1,
        executionEnabled: false,
      };
      return {
        shardIndex,
        runtimeGeneration,
        runtimeBuildIdSha256: runtime.buildIdSha256,
        readiness: {
          ...readinessFacts,
          evidenceSha256: sha256Canonical(readinessFacts),
        },
        rawRequest,
        rawResponse,
        rawRequestSha256: digests.requestSha256,
        rawResponseSha256: digests.responseSha256,
        normalizedDigests: {
          requestCompatibilitySha256: digests.requestCompatibilitySha256,
          responseCompatibilitySha256: digests.responseCompatibilitySha256,
        },
        transportFacts: {
          operationKind: "health_probe",
          statusCode: 200,
          requestContentType: "application/json",
          responseContentType: "application/json",
          selectedTransport: "json",
          effectiveTransport: "json",
          attemptCount: 1,
          protobufAttemptCount: 0,
          legacyJsonFallbackCount: 0,
          outcome: "completed",
          recoveryRequired: false,
        },
      };
    });
    const transportFacts = {
      eventsObserved: 8,
      selectedJsonCount: 8,
      effectiveJsonCount: 8,
      protobufAttemptCount: 0,
      legacyJsonFallbackCount: 0,
      recoveryRequiredCount: 0,
    };
    const unchangedProviderSha256 = sha256Canonical({ phaseIndex, type: "provider" });
    const unchangedBillingSha256 = sha256Canonical({ phaseIndex, type: "billing" });
    const unchangedStorageGatewaySha256 = sha256Canonical({
      phaseIndex,
      type: "storage-gateway",
    });
    const unchangedTrafficSha256 = sha256Canonical({ phaseIndex, type: "traffic" });
    const noMutationProof = {
      providerBeforeSha256: unchangedProviderSha256,
      providerAfterSha256: unchangedProviderSha256,
      billingBeforeSha256: unchangedBillingSha256,
      billingAfterSha256: unchangedBillingSha256,
      storageGatewayBeforeSha256: unchangedStorageGatewaySha256,
      storageGatewayAfterSha256: unchangedStorageGatewaySha256,
      productionTrafficBeforeSha256: unchangedTrafficSha256,
      productionTrafficAfterSha256: unchangedTrafficSha256,
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
    };
    const executorBoundary = {
      credentialsRead: false,
      filesWritten: false,
      deploymentMutationAuthorized: false,
      deploymentMutationPerformed: false,
      cloudflareRestRequestCount: 0,
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
    };
    const receiptSha256 = sha256Canonical({
      phaseIndex,
      type: "executor-receipt",
    });
    const permitSubject = {
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-phase-permit-subject-v1",
      issuer: "cinatoken-json-compatibility-permit-issuer-staging",
      audience:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      keyId: "source-manifest-test-key",
      permitIdSha256: sha256Canonical({ phaseIndex, type: "permit" }),
      campaignIdSha256: plan.campaignIdSha256,
      planDigestSha256: plan.planDigestSha256,
      phaseExecutionId: `phase-execution-${phaseIndex + 1}`,
      controller: {
        serviceName: plan.controller.serviceName,
        versionId: plan.controller.versionId,
        configSha256: plan.controller.configSha256,
      },
      executor: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        versionId: "executor-version-001",
      },
      runtimes: structuredClone(plan.runtimes),
      ring: structuredClone(plan.ring),
      phase: {
        ordinal: phase.ordinal,
        id: phase.id,
        topology: structuredClone(phase.topology),
      },
      issuedAt: 1_800_000_000 + phaseIndex * 120,
      notBefore: 1_800_000_005 + phaseIndex * 120,
      expiresAt: 1_800_000_300 + phaseIndex * 120,
    };
    const permitEnvelope = {
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-phase-permit-envelope-v1",
      algorithm: "Ed25519",
      subject: permitSubject,
      subjectSha256: sha256Canonical(permitSubject),
      signatureBase64url: "A".repeat(86),
    };
    const authorization = {
      kind: "ed25519-signed-single-use-phase-permit",
      algorithm: "Ed25519",
      permitIdSha256: permitSubject.permitIdSha256,
      permitSubjectSha256: permitEnvelope.subjectSha256,
      permitEnvelopeSha256: sha256Canonical(permitEnvelope),
      permitEnvelope,
      issuer: permitSubject.issuer,
      audience: permitSubject.audience,
      keyId: permitSubject.keyId,
      signerSpkiSha256: sha256Canonical({ type: "permit-spki" }),
      issuedAt: permitSubject.issuedAt,
      notBefore: permitSubject.notBefore,
      expiresAt: permitSubject.expiresAt,
      campaignAuthority: {
        kind: "campaign-scoped-sqlite-durable-object",
        binding: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        objectNameSha256: plan.campaignIdSha256,
        campaignBindingSha256: sha256Canonical({ type: "campaign-binding" }),
        leaseIdSha256: sha256Canonical({ phaseIndex, type: "lease" }),
        leaseReceiptSha256: sha256Canonical({
          phaseIndex,
          type: "lease-receipt",
        }),
        singleUsePermitPersisted: true,
        phaseOrderEnforced: true,
        concurrentPhaseRejected: true,
      },
    };
    const packetSubject = {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-source-packet",
      environment: "staging",
      campaignIdSha256: plan.campaignIdSha256,
      planDigestSha256: plan.planDigestSha256,
      activity: {
        ordinal: phase.ordinal,
        id: phase.id,
        status: "pass",
        startedAt: `2026-08-04T00:0${phaseIndex * 2}:00Z`,
        completedAt: `2026-08-04T00:0${phaseIndex * 2 + 1}:00Z`,
        deploymentReadbackStable: true,
        ledgerConverged: true,
      },
      controller: {
        ...structuredClone(plan.controller),
        deploymentSetSha256: controllerDeploymentSetSha256,
      },
      runtimes: structuredClone(plan.runtimes),
      ring: structuredClone(plan.ring),
      topology: structuredClone(phase.topology),
      containerDeploymentSetSha256: sha256Canonical({
        phaseIndex,
        deployment: "container",
      }),
      operatorInvocation: {
        ...structuredClone(syntheticPhases[phaseIndex].operatorInvocation),
        phaseExecutionId: `phase-execution-${phaseIndex + 1}`,
        startedAt: `2026-08-04T00:0${phaseIndex * 2}:00Z`,
        completedAt: `2026-08-04T00:0${phaseIndex * 2 + 1}:00Z`,
      },
      privateInvocation: {
        ...structuredClone(syntheticPhases[phaseIndex].privateInvocation),
        phaseExecutionId: `phase-execution-${phaseIndex + 1}`,
        executorReceiptSha256: receiptSha256,
        startedAt: `2026-08-04T00:0${phaseIndex * 2}:00Z`,
        completedAt: `2026-08-04T00:0${phaseIndex * 2 + 1}:00Z`,
      },
      executorReceipt: {
        contract:
          "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2",
        receiptSha256,
        campaignIdSha256: plan.campaignIdSha256,
        planDigestSha256: plan.planDigestSha256,
        phaseOrdinal: phase.ordinal,
        phaseId: phase.id,
        phaseExecutionId: `phase-execution-${phaseIndex + 1}`,
        executorServiceName:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        executorVersionId: "executor-version-001",
        startedAt: `2026-08-04T00:0${phaseIndex * 2}:00Z`,
        completedAt: `2026-08-04T00:0${phaseIndex * 2 + 1}:00Z`,
        targetService: "cinatoken-container-controller-staging",
        targetEntrypoint: "JsonCompatibilityProbeEntrypoint",
        privateServiceBindingRpcCount: 8,
        publicUrlUsed: false,
        cloudflareRestUsed: false,
        executionBoundarySha256: sha256Canonical(executorBoundary),
        authorization,
      },
      sourceContext: {
        contract:
          "cinatoken-container-runtime-json-compatibility-phase-source-context-v1",
        contextSha256: sha256Canonical({
          phaseIndex,
          receiptSha256,
          type: "source-context",
        }),
        receiptSha256,
      },
      shards,
      transportTotals: {
        ...transportFacts,
        evidenceSha256: sha256Canonical(transportFacts),
      },
      noMutationFacts: {
        ...noMutationProof,
        evidenceSha256: sha256Canonical(noMutationProof),
      },
    };
    return {
      ...packetSubject,
      packetSha256: sha256Canonical(packetSubject),
    };
  });
}

function resealPacket(packet) {
  const { packetSha256: _ignored, ...subject } = packet;
  packet.packetSha256 = sha256Canonical(subject);
  return packet;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

async function makeTempDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-source-manifest-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("container runtime JSON compatibility source manifest", () => {
  test("builds and validates a complete four-phase source manifest", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    const manifest = buildJsonCompatibilitySourceManifest(plan, packets);

    expect(validateJsonCompatibilitySourceManifest(plan, manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_SOURCE_MANIFEST_CONTRACT,
      environment: "staging",
      campaignIdSha256: plan.campaignIdSha256,
      planDigestSha256: plan.planDigestSha256,
      aggregate: {
        phaseCount: 4,
        shardCount: 8,
        observationCount: 32,
        protobufAttemptCount: 0,
        providerRequestCount: 0,
        billingMutationCount: 0,
        storageGatewayMutationCount: 0,
        productionTrafficRequestCount: 0,
        publicProbeRequestCount: 0,
        jsonByteCompatibilityPassed: true,
        rollbackLedgerConverged: true,
      },
    });
    expect(manifest.phases[2].shards[5].rawRequest).toBe(
      packets[2].shards[5].rawRequest,
    );
    expect(manifest.sourceManifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects phase packets outside the fixed four-phase order", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    [packets[0], packets[1]] = [packets[1], packets[0]];

    expect(() => buildJsonCompatibilitySourceManifest(plan, packets)).toThrow(
      /baseline-n-minus-one.*ordinal|baseline-n-minus-one.*phase ID/,
    );
  });

  test("rejects a phase with a missing shard", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    packets[1].shards.pop();

    expect(() => buildJsonCompatibilitySourceManifest(plan, packets)).toThrow(
      /exactly 8 shard records/,
    );
  });

  test("rejects a resealed outer receipt detached from its private receipt", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    packets[0].operatorInvocation.privateInvocationReceiptSha256 =
      "aa".repeat(32);
    resealPacket(packets[0]);

    expect(() => buildJsonCompatibilitySourceManifest(plan, packets)).toThrow(
      /operator\/private raw receipt binding/,
    );
  });

  test("rejects raw and normalized digest mismatches", () => {
    const plan = buildPlan();
    const rawDigestMismatch = buildPhasePackets(plan);
    rawDigestMismatch[2].shards[4].rawRequestSha256 = "ff".repeat(32);
    expect(() =>
      buildJsonCompatibilitySourceManifest(plan, rawDigestMismatch),
    ).toThrow(/raw request digest/);

    const normalizedMismatch = buildPhasePackets(plan);
    normalizedMismatch[2].shards[4].normalizedDigests.requestCompatibilitySha256 =
      "ee".repeat(32);
    expect(() =>
      buildJsonCompatibilitySourceManifest(plan, normalizedMismatch),
    ).toThrow(/requestCompatibilitySha256/);
  });

  test("rejects mutation facts even when their nested and packet digests are resealed", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    const facts = packets[0].noMutationFacts;
    facts.providerRequestCount = 1;
    const { evidenceSha256: _ignored, ...proof } = facts;
    facts.evidenceSha256 = sha256Canonical(proof);
    resealPacket(packets[0]);

    expect(() => buildJsonCompatibilitySourceManifest(plan, packets)).toThrow(
      /providerRequestCount/,
    );
  });

  test("is deterministic across input object key order", () => {
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    const first = buildJsonCompatibilitySourceManifest(plan, packets);
    const second = buildJsonCompatibilitySourceManifest(
      reverseObjectKeys(plan),
      reverseObjectKeys(packets),
    );

    expect(second.sourceManifestSha256).toBe(first.sourceManifestSha256);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  test("projects evidence exactly from the validated source manifest", () => {
    const plan = buildPlan();
    const manifest = buildJsonCompatibilitySourceManifest(
      plan,
      buildPhasePackets(plan),
    );
    const evidence = buildJsonCompatibilityEvidenceFromSourceManifest(
      plan,
      manifest,
      {
        capturedAt: "2026-08-04T00:08:00Z",
        evidenceSource: "remote-staging",
      },
    );

    expect(
      verifyJsonCompatibilityEvidenceSourceManifestBinding(
        plan,
        manifest,
        evidence,
      ),
    ).toEqual(evidence);
    expect(verifyJsonCompatibilityCampaignEvidence(plan, evidence)).toMatchObject({
      ok: true,
      evidenceSource: "remote-staging",
      observationCount: 32,
    });
  });

  test("writes the exact remote evidence projection create-only", async () => {
    const directory = await makeTempDirectory();
    const plan = buildPlan();
    const manifest = buildJsonCompatibilitySourceManifest(
      plan,
      buildPhasePackets(plan),
    );
    const planPath = path.join(directory, "plan.json");
    const manifestPath = path.join(directory, "manifest.json");
    const evidencePath = path.join(directory, "evidence.json");
    await Promise.all([
      writeFile(planPath, JSON.stringify(plan), "utf8"),
      writeFile(manifestPath, JSON.stringify(manifest), "utf8"),
    ]);
    const options = {
      planPath,
      sourceManifestPath: manifestPath,
      capturedAt: "2026-08-04T00:08:00Z",
      outPath: evidencePath,
    };

    const result = await runJsonCompatibilityEvidenceProjector(options);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(result).toMatchObject({
      ok: true,
      mode: "offline-evidence-projection",
      evidenceSource: "remote-staging",
      phaseCount: 4,
      observationCount: 32,
      filesWritten: true,
    });
    expect(
      verifyJsonCompatibilityEvidenceSourceManifestBinding(
        plan,
        manifest,
        evidence,
      ),
    ).toEqual(evidence);
    await expect(runJsonCompatibilityEvidenceProjector(options)).rejects.toThrow();
  });

  test("rejects evidence that names the manifest but changes its projection", () => {
    const plan = buildPlan();
    const manifest = buildJsonCompatibilitySourceManifest(
      plan,
      buildPhasePackets(plan),
    );
    const evidence = buildJsonCompatibilityEvidenceFromSourceManifest(
      plan,
      manifest,
      {
        capturedAt: "2026-08-04T00:08:00Z",
        evidenceSource: "remote-staging",
      },
    );
    evidence.phases[1].observations[3].readiness.evidenceSha256 = "aa".repeat(32);

    expect(() =>
      verifyJsonCompatibilityEvidenceSourceManifestBinding(
        plan,
        manifest,
        evidence,
      ),
    ).toThrow(/evidence projection/);
  });

  test("builds a complete fixture-only source chain for verifier self-tests", () => {
    const plan = buildPlan();
    const manifest = createSyntheticJsonCompatibilitySourceManifest(plan);
    expect(validateJsonCompatibilitySourceManifest(plan, manifest)).toEqual(manifest);
    expect(manifest.aggregate).toMatchObject({
      phaseCount: 4,
      shardCount: 8,
      observationCount: 32,
    });
  });
});

describe("offline source-manifest collector", () => {
  test("accepts exactly four ordered --phase arguments and no key options", () => {
    expect(
      parseJsonCompatibilitySourceManifestArgs([
        "--plan",
        "plan.json",
        "--phase",
        "1.json",
        "--phase",
        "2.json",
        "--phase",
        "3.json",
        "--phase",
        "4.json",
        "--out",
        "manifest.json",
      ]).phasePaths,
    ).toEqual(["1.json", "2.json", "3.json", "4.json"]);
    expect(() =>
      parseJsonCompatibilitySourceManifestArgs([
        "--plan",
        "plan.json",
        "--key",
        "sensitive",
      ]),
    ).toThrow(/unknown option/);
  });

  test("writes canonical JSON only after every packet validates", async () => {
    const directory = await makeTempDirectory();
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    const planPath = path.join(directory, "plan.json");
    const phasePaths = packets.map((_, index) =>
      path.join(directory, `phase-${index + 1}.json`),
    );
    const outPath = path.join(directory, "source-manifest.json");
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    await Promise.all(
      phasePaths.map((phasePath, index) =>
        writeFile(phasePath, JSON.stringify(packets[index]), "utf8"),
      ),
    );

    const result = await runJsonCompatibilitySourceManifestCollector({
      planPath,
      phasePaths,
      outPath,
    });
    const output = await readFile(outPath, "utf8");
    const manifest = JSON.parse(output);
    expect(output).toBe(canonicalJson(manifest));
    expect(result).toMatchObject({
      ok: true,
      phaseCount: 4,
      shardCount: 8,
      observationCount: 32,
      credentialsRead: false,
      networkRequestsPerformed: false,
      sensitiveValuesPrinted: false,
    });
    expect(result.sourceManifestSha256).toBe(manifest.sourceManifestSha256);
  });

  test("does not create the output when validation fails", async () => {
    const directory = await makeTempDirectory();
    const plan = buildPlan();
    const packets = buildPhasePackets(plan);
    packets[3].shards.pop();
    const planPath = path.join(directory, "plan.json");
    const phasePaths = packets.map((_, index) =>
      path.join(directory, `phase-${index + 1}.json`),
    );
    const outPath = path.join(directory, "source-manifest.json");
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    await Promise.all(
      phasePaths.map((phasePath, index) =>
        writeFile(phasePath, JSON.stringify(packets[index]), "utf8"),
      ),
    );

    await expect(
      runJsonCompatibilitySourceManifestCollector({
        planPath,
        phasePaths,
        outPath,
      }),
    ).rejects.toThrow(/exactly 8 shard records/);
    expect(await Bun.file(outPath).exists()).toBe(false);
  });
});
