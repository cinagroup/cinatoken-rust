import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildJsonCompatibilityCampaignPlan,
  canonicalJson,
  sha256Canonical,
  verifyJsonCompatibilityCampaignEvidence,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilityEvidenceFromSourceManifest,
  buildJsonCompatibilitySourceManifest,
  validateJsonCompatibilitySourceManifest,
  verifyJsonCompatibilityEvidenceSourceManifestBinding,
} from "../tools/container_runtime_json_compatibility_source_manifest.mjs";
import {
  JSON_COMPATIBILITY_PHASE_SOURCE_CONTEXT_CONTRACT,
  buildJsonCompatibilityPhaseSourcePacket,
} from "../tools/container_runtime_json_compatibility_phase_source.mjs";
import {
  runJsonCompatibilityPhaseSourceAssembler,
} from "../tools/assemble_container_runtime_json_compatibility_phase_source.mjs";
import {
  executeJsonCompatibilityPhase,
} from "../services/container-runtime-json-compatibility-executor/src/executor.ts";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
} from "../services/container-runtime-json-compatibility-executor/src/protocol.ts";
import {
  createJsonHealthProbeDigestRecord,
  serializeJsonHealthProbeWireRequest,
  sha256Hex,
} from "../services/container-controller/src/json_compatibility_probe.ts";

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
    controllerVersionId: "controller-version-phase-source-001",
    runtimeNBuildIdSha256: "22".repeat(32),
    runtimeNImageDigest: `sha256:${"33".repeat(32)}`,
    runtimeNMinusOneBuildIdSha256: "44".repeat(32),
    runtimeNMinusOneImageDigest: `sha256:${"55".repeat(32)}`,
    candidateShardIndex: 3,
  });
}

class ProbeBinding {
  async probeShard(request) {
    const requestRawJson = serializeJsonHealthProbeWireRequest(request);
    const responseRawJson = JSON.stringify({
      protocol_version: 1,
      operation_id: request.operation.operationId,
      status: "completed",
      trace_id: request.operation.traceId,
    });
    const readinessRawJson = JSON.stringify({
      status: "ready",
      protocol_version: 1,
      runtime_build_id: request.expectedRuntimeBuildIdSha256,
      shard_contract_version: 1,
      execution_enabled: false,
    });
    const digests = await createJsonHealthProbeDigestRecord(
      requestRawJson,
      responseRawJson,
    );
    return {
      schemaVersion: 1,
      contract: "cinatoken-container-runtime-json-probe-result-v1",
      request,
      startedAt: request.requestedAt,
      completedAt: request.requestedAt,
      readiness: {
        statusCode: 200,
        contentType: "application/json",
        rawJson: readinessRawJson,
        rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
        rawSha256: await sha256Hex(readinessRawJson),
        runtimeBuildIdSha256: request.expectedRuntimeBuildIdSha256,
        protocolVersion: 1,
        shardContractVersion: 1,
        executionEnabled: false,
      },
      healthProbe: {
        operationKind: "health_probe",
        statusCode: 200,
        requestContentType: "application/json",
        responseContentType: "application/json",
        requestRawJson,
        responseRawJson,
        ...digests,
        selectedTransport: "json",
        effectiveTransport: "json",
        attemptCount: 1,
        legacyJsonFallbackCount: 0,
        outcome: "completed",
        recoveryRequired: false,
      },
      sideEffects: {
        providerRequestCount: 0,
        billingMutationCount: 0,
        storageGatewayMutationCount: 0,
        productionTrafficRequestCount: 0,
        publicProbeRequestCount: 0,
      },
    };
  }
}

function deterministicRuntime(nowMs) {
  let sequence = 0;
  return {
    now: () => nowMs,
    randomUUID: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
    },
  };
}

async function buildReceipt(plan, phaseIndex) {
  const phase = plan.phases[phaseIndex];
  return executeJsonCompatibilityPhase(
    {
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_EXECUTOR_ENABLED: "true",
      CF_VERSION_METADATA: { id: "executor-version-001" },
      CONTAINER_CONTROLLER_JSON_PROBE: new ProbeBinding(),
    },
    {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-execution",
      environment: "staging",
      campaignIdSha256: plan.campaignIdSha256,
      planDigestSha256: plan.planDigestSha256,
      phaseExecutionId: `phase-execution-${phaseIndex + 1}`,
      controller: {
        serviceName: plan.controller.serviceName,
        versionId: plan.controller.versionId,
        configSha256: plan.controller.configSha256,
      },
      runtimes: structuredClone(plan.runtimes),
      ring: structuredClone(plan.ring),
      phase: {
        ordinal: phase.ordinal,
        id: phase.id,
        topology: structuredClone(phase.topology),
      },
    },
    deterministicRuntime(Date.parse(`2026-08-04T00:0${phaseIndex * 2}:00Z`)),
  );
}

function buildContext(plan, receipt, phaseIndex) {
  const providerSnapshot = sha256Canonical({ phaseIndex, source: "provider" });
  const billingSnapshot = sha256Canonical({ phaseIndex, source: "billing" });
  const storageGatewaySnapshot = sha256Canonical({
    phaseIndex,
    source: "storage-gateway",
  });
  const trafficSnapshot = sha256Canonical({ phaseIndex, source: "traffic" });
  const mutationFacts = {
    providerBeforeSha256: providerSnapshot,
    providerAfterSha256: providerSnapshot,
    billingBeforeSha256: billingSnapshot,
    billingAfterSha256: billingSnapshot,
    storageGatewayBeforeSha256: storageGatewaySnapshot,
    storageGatewayAfterSha256: storageGatewaySnapshot,
    productionTrafficBeforeSha256: trafficSnapshot,
    productionTrafficAfterSha256: trafficSnapshot,
    providerRequestCount: 0,
    billingMutationCount: 0,
    storageGatewayMutationCount: 0,
    productionTrafficRequestCount: 0,
    publicProbeRequestCount: 0,
  };
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_SOURCE_CONTEXT_CONTRACT,
    kind: "container-runtime-json-compatibility-phase-source-context",
    environment: "staging",
    campaignIdSha256: plan.campaignIdSha256,
    planDigestSha256: plan.planDigestSha256,
    phaseOrdinal: receipt.phase.ordinal,
    phaseId: receipt.phase.id,
    receiptSha256: receipt.receiptSha256,
    activity: {
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      deploymentReadbackStable: true,
      ledgerConverged: true,
    },
    controller: {
      ...structuredClone(plan.controller),
      deploymentSetSha256: sha256Canonical({ source: "controller-deployment" }),
    },
    containerDeploymentSetSha256: sha256Canonical({
      phaseIndex,
      source: "container-deployment",
    }),
    noMutationFacts: {
      ...mutationFacts,
      evidenceSha256: sha256Canonical(mutationFacts),
    },
  };
  return { ...subject, contextSha256: sha256Canonical(subject) };
}

function resealReceipt(receipt) {
  const { receiptSha256: _ignored, ...subject } = receipt;
  receipt.receiptSha256 = sha256Canonical(subject);
}

function resealContext(context) {
  const { contextSha256: _ignored, ...subject } = context;
  context.contextSha256 = sha256Canonical(subject);
}

async function makeTempDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-phase-source-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("container runtime JSON compatibility phase source assembly", () => {
  test("binds four private executor receipts into a complete manifest and evidence", async () => {
    const plan = buildPlan();
    const packets = [];
    const contexts = [];
    for (let phaseIndex = 0; phaseIndex < 4; phaseIndex += 1) {
      const receipt = await buildReceipt(plan, phaseIndex);
      const context = buildContext(plan, receipt, phaseIndex);
      contexts.push(context);
      packets.push(
        await buildJsonCompatibilityPhaseSourcePacket(
          plan,
          receipt,
          context,
        ),
      );
    }
    const manifest = buildJsonCompatibilitySourceManifest(plan, packets);
    expect(validateJsonCompatibilitySourceManifest(plan, manifest)).toEqual(manifest);
    expect(manifest.phases.map((phase) => phase.executorReceipt.receiptSha256)).toEqual(
      packets.map((phase) => phase.executorReceipt.receiptSha256),
    );
    expect(manifest.phases.map((phase) => phase.sourceContext.contextSha256)).toEqual(
      contexts.map((context) => context.contextSha256),
    );
    expect(manifest.phases.flatMap((phase) => phase.shards)).toHaveLength(32);
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
      observationCount: 32,
    });
  });

  test("rejects nested receipt tampering even when the outer receipt is resealed", async () => {
    const plan = buildPlan();
    const receipt = await buildReceipt(plan, 0);
    receipt.observations[0].probeRequestCanonicalSha256 = "aa".repeat(32);
    resealReceipt(receipt);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(
        plan,
        receipt,
        buildContext(plan, receipt, 0),
      ),
    ).rejects.toThrow(/request canonical digest/);
  });

  test("rejects drifting external snapshots even when context digests are resealed", async () => {
    const plan = buildPlan();
    const receipt = await buildReceipt(plan, 1);
    const context = buildContext(plan, receipt, 1);
    context.noMutationFacts.providerAfterSha256 = "aa".repeat(32);
    const { evidenceSha256: _ignored, ...proof } = context.noMutationFacts;
    context.noMutationFacts.evidenceSha256 = sha256Canonical(proof);
    resealContext(context);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(plan, receipt, context),
    ).rejects.toThrow(/provider snapshot/);

    const storageContext = buildContext(plan, receipt, 1);
    storageContext.noMutationFacts.storageGatewayAfterSha256 = "bb".repeat(32);
    const { evidenceSha256: _storageIgnored, ...storageProof } =
      storageContext.noMutationFacts;
    storageContext.noMutationFacts.evidenceSha256 = sha256Canonical(storageProof);
    resealContext(storageContext);
    await expect(
      buildJsonCompatibilityPhaseSourcePacket(plan, receipt, storageContext),
    ).rejects.toThrow(/storage gateway snapshot/);
  });

  test("writes canonical phase source only after receipt and context validation", async () => {
    const directory = await makeTempDirectory();
    const plan = buildPlan();
    const receipt = await buildReceipt(plan, 2);
    const context = buildContext(plan, receipt, 2);
    const planPath = path.join(directory, "plan.json");
    const receiptPath = path.join(directory, "receipt.json");
    const contextPath = path.join(directory, "context.json");
    const outPath = path.join(directory, "phase-source.json");
    await Promise.all([
      writeFile(planPath, JSON.stringify(plan), "utf8"),
      writeFile(receiptPath, JSON.stringify(receipt), "utf8"),
      writeFile(contextPath, JSON.stringify(context), "utf8"),
    ]);

    const result = await runJsonCompatibilityPhaseSourceAssembler({
      planPath,
      receiptPath,
      contextPath,
      outPath,
    });
    const source = await readFile(outPath, "utf8");
    const packet = JSON.parse(source);
    expect(source).toBe(canonicalJson(packet));
    expect(result).toMatchObject({
      ok: true,
      phaseId: "candidate-n",
      phaseOrdinal: 3,
      shardCount: 8,
      credentialsRead: false,
      networkRequestsPerformed: false,
    });
  });
});
