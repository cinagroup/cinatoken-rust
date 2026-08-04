import { createHash } from "node:crypto";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  JSON_COMPATIBILITY_SHARD_COUNT,
  JsonCompatibilityCampaignError,
  canonicalJson,
  createJsonHealthProbeDigestRecord,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";

export const JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-phase-source-packet-v1";
export const JSON_COMPATIBILITY_SOURCE_MANIFEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-manifest-v1";

const EXPECTED_SHARD_COUNT = JSON_COMPATIBILITY_SHARD_COUNT;
const JSON_CONTENT_TYPE = "application/json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WHOLE_SECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RAW_READINESS_BYTES = 4 * 1024;
const MAX_RAW_REQUEST_BYTES = 8 * 1024;
const MAX_RAW_RESPONSE_BYTES = 4 * 1024;

export function buildJsonCompatibilitySourceManifest(plan, phasePackets) {
  const validatedPlan = validateManifestPlan(plan);
  const packets = validatePhasePacketSet(validatedPlan, phasePackets);
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_SOURCE_MANIFEST_CONTRACT,
    kind: "container-runtime-json-compatibility-source-manifest",
    environment: "staging",
    campaignIdSha256: validatedPlan.campaignIdSha256,
    planDigestSha256: validatedPlan.planDigestSha256,
    controller: cloneJson(validatedPlan.controller),
    runtimes: cloneJson(validatedPlan.runtimes),
    ring: cloneJson(validatedPlan.ring),
    phases: cloneJson(packets),
    aggregate: buildAggregate(packets),
  };
  const manifest = {
    ...subject,
    sourceManifestSha256: sha256Canonical(subject),
  };
  validateJsonCompatibilitySourceManifest(validatedPlan, manifest);
  return manifest;
}

export function validateJsonCompatibilitySourceManifest(plan, manifest) {
  const validatedPlan = validateManifestPlan(plan);
  const value = requireRecord(manifest, "[source-manifest] document");
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "controller",
    "runtimes",
    "ring",
    "phases",
    "aggregate",
    "sourceManifestSha256",
  ], "[source-manifest] document");
  requireEqual(value.schemaVersion, 1, "[source-manifest] schema version");
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_SOURCE_MANIFEST_CONTRACT,
    "[source-manifest] contract",
  );
  requireEqual(
    value.kind,
    "container-runtime-json-compatibility-source-manifest",
    "[source-manifest] kind",
  );
  requireEqual(value.environment, "staging", "[source-manifest] environment");
  requireEqual(
    value.campaignIdSha256,
    validatedPlan.campaignIdSha256,
    "[source-manifest] campaign ID",
  );
  requireEqual(
    value.planDigestSha256,
    validatedPlan.planDigestSha256,
    "[source-manifest] plan digest",
  );
  requireCanonicalEqual(
    value.controller,
    validatedPlan.controller,
    "[source-manifest] Controller identity",
  );
  requireCanonicalEqual(
    value.runtimes,
    validatedPlan.runtimes,
    "[source-manifest] runtime identities",
  );
  requireCanonicalEqual(
    value.ring,
    validatedPlan.ring,
    "[source-manifest] ring topology",
  );

  const packets = validatePhasePacketSet(validatedPlan, value.phases);
  requireCanonicalEqual(
    value.aggregate,
    buildAggregate(packets),
    "[source-manifest] aggregate",
  );
  requireSha256(value.sourceManifestSha256, "[source-manifest] digest");
  const { sourceManifestSha256, ...subject } = value;
  requireEqual(
    sourceManifestSha256,
    sha256Canonical(subject),
    "[source-manifest] canonical digest",
  );
  return value;
}

export function buildJsonCompatibilityEvidenceFromSourceManifest(
  plan,
  manifest,
  { capturedAt, evidenceSource },
) {
  const validatedPlan = validateManifestPlan(plan);
  const source = validateJsonCompatibilitySourceManifest(validatedPlan, manifest);
  parseWholeSecondUtc(capturedAt, "[source-manifest] evidence captured at");
  if (evidenceSource !== "remote-staging" && evidenceSource !== "synthetic-self-test") {
    throw new JsonCompatibilityCampaignError(
      "[source-manifest] evidence source is unsupported",
    );
  }
  const phases = source.phases.map((packet) => ({
    ordinal: packet.activity.ordinal,
    id: packet.activity.id,
    status: packet.activity.status,
    startedAt: packet.activity.startedAt,
    completedAt: packet.activity.completedAt,
    controllerVersionId: packet.controller.versionId,
    controllerDeploymentSetSha256: packet.controller.deploymentSetSha256,
    containerDeploymentSetSha256: packet.containerDeploymentSetSha256,
    topology: cloneJson(packet.topology),
    deploymentReadbackStable: packet.activity.deploymentReadbackStable,
    ledgerConverged: packet.activity.ledgerConverged,
    observations: packet.shards.map((shard) => ({
      shardIndex: shard.shardIndex,
      runtimeGeneration: shard.runtimeGeneration,
      runtimeBuildIdSha256: shard.runtimeBuildIdSha256,
      readiness: {
        statusCode: shard.readiness.statusCode,
        contentType: shard.readiness.contentType,
        runtimeBuildIdSha256: shard.readiness.runtimeBuildIdSha256,
        protocolVersion: shard.readiness.protocolVersion,
        shardContractVersion: shard.readiness.shardContractVersion,
        evidenceSha256: shard.readiness.evidenceSha256,
      },
      healthProbe: {
        operationKind: shard.transportFacts.operationKind,
        statusCode: shard.transportFacts.statusCode,
        requestContentType: shard.transportFacts.requestContentType,
        responseContentType: shard.transportFacts.responseContentType,
        requestSha256: shard.rawRequestSha256,
        responseSha256: shard.rawResponseSha256,
        requestCompatibilitySha256:
          shard.normalizedDigests.requestCompatibilitySha256,
        responseCompatibilitySha256:
          shard.normalizedDigests.responseCompatibilitySha256,
        selectedTransport: shard.transportFacts.selectedTransport,
        effectiveTransport: shard.transportFacts.effectiveTransport,
        attemptCount: shard.transportFacts.attemptCount,
        legacyJsonFallbackCount:
          shard.transportFacts.legacyJsonFallbackCount,
        outcome: shard.transportFacts.outcome,
        recoveryRequired: shard.transportFacts.recoveryRequired,
      },
    })),
    transportTotals: cloneJson(packet.transportTotals),
    zeroMutationProof: cloneJson(packet.noMutationFacts),
  }));
  const aggregate = source.aggregate;
  return {
    schemaVersion: 1,
    contract: "cinatoken-container-runtime-json-compatibility-evidence-v1",
    kind: "container-runtime-json-compatibility-evidence",
    environment: "staging",
    evidenceSource,
    campaignIdSha256: source.campaignIdSha256,
    planDigestSha256: source.planDigestSha256,
    sourceManifestSha256: source.sourceManifestSha256,
    status: "pass",
    capturedAt,
    controller: cloneJson(validatedPlan.controller),
    runtimes: cloneJson(validatedPlan.runtimes),
    phases,
    aggregate: {
      phaseCount: aggregate.phaseCount,
      observationCount: aggregate.observationCount,
      controllerVersionCount: aggregate.controllerVersionCount,
      runtimeBuildCount: aggregate.runtimeBuildCount,
      protobufAttemptCount: aggregate.protobufAttemptCount,
      legacyJsonFallbackCount: aggregate.legacyJsonFallbackCount,
      providerRequestCount: aggregate.providerRequestCount,
      billingMutationCount: aggregate.billingMutationCount,
      storageGatewayMutationCount: aggregate.storageGatewayMutationCount,
      productionTrafficRequestCount: aggregate.productionTrafficRequestCount,
      publicProbeRequestCount: aggregate.publicProbeRequestCount,
      allShardsObserved: aggregate.allShardsObserved,
      jsonByteCompatibilityPassed: aggregate.jsonByteCompatibilityPassed,
      rollbackLedgerConverged: aggregate.rollbackLedgerConverged,
    },
  };
}

export function verifyJsonCompatibilityEvidenceSourceManifestBinding(
  plan,
  manifest,
  evidence,
) {
  const value = requireRecord(evidence, "[source-manifest] evidence document");
  const expected = buildJsonCompatibilityEvidenceFromSourceManifest(
    plan,
    manifest,
    {
      capturedAt: value.capturedAt,
      evidenceSource: value.evidenceSource,
    },
  );
  requireCanonicalEqual(
    value,
    expected,
    "[source-manifest] evidence projection",
  );
  return expected;
}

export function createSyntheticJsonCompatibilitySourceManifest(plan) {
  const validatedPlan = validateManifestPlan(plan);
  const controllerDeploymentSetSha256 = sha256Canonical({
    domain: "synthetic-controller-deployment-set",
    versionId: validatedPlan.controller.versionId,
  });
  const packets = validatedPlan.phases.map((phase, phaseIndex) => {
    const startedAt = new Date(Date.UTC(2026, 7, 3, 0, phaseIndex * 2, 0));
    const completedAt = new Date(startedAt.getTime() + 60_000);
    const shards = Array.from({ length: EXPECTED_SHARD_COUNT }, (_, shardIndex) => {
      const runtimeGeneration = expectedRuntimeForShard(phase.topology, shardIndex);
      const runtime = runtimeForGeneration(validatedPlan.runtimes, runtimeGeneration);
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
        admission_sha256: sha256Canonical({
          domain: "synthetic-admission",
          phaseIndex,
          shardIndex,
        }),
        input: {
          mode: "inline",
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          size: 0,
          content_type: JSON_CONTENT_TYPE,
        },
        shard: {
          contract_version: 1,
          ring_generation: validatedPlan.ring.generation,
          shard_count: EXPECTED_SHARD_COUNT,
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
        contentType: JSON_CONTENT_TYPE,
        rawJson: readinessRawJson,
        rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
        rawSha256: sha256Utf8(readinessRawJson),
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
          requestContentType: JSON_CONTENT_TYPE,
          responseContentType: JSON_CONTENT_TYPE,
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
      eventsObserved: EXPECTED_SHARD_COUNT,
      selectedJsonCount: EXPECTED_SHARD_COUNT,
      effectiveJsonCount: EXPECTED_SHARD_COUNT,
      protobufAttemptCount: 0,
      legacyJsonFallbackCount: 0,
      recoveryRequiredCount: 0,
    };
    const providerSnapshot = sha256Canonical({ domain: "provider", phaseIndex });
    const billingSnapshot = sha256Canonical({ domain: "billing", phaseIndex });
    const storageGatewaySnapshot = sha256Canonical({
      domain: "storage-gateway",
      phaseIndex,
    });
    const trafficSnapshot = sha256Canonical({ domain: "traffic", phaseIndex });
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
      domain: "synthetic-executor-receipt",
      phaseIndex,
    });
    const permitSubject = {
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-phase-permit-subject-v1",
      issuer: "cinatoken-json-compatibility-permit-issuer-staging",
      audience:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      keyId: "synthetic-json-compatibility-key",
      permitIdSha256: sha256Canonical({ domain: "synthetic-permit", phaseIndex }),
      campaignIdSha256: validatedPlan.campaignIdSha256,
      planDigestSha256: validatedPlan.planDigestSha256,
      phaseExecutionId: `synthetic-phase-execution-${phaseIndex + 1}`,
      controller: {
        serviceName: validatedPlan.controller.serviceName,
        versionId: validatedPlan.controller.versionId,
        configSha256: validatedPlan.controller.configSha256,
      },
      executor: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        versionId: validatedPlan.privateServices.executor.versionId,
      },
      runtimes: cloneJson(validatedPlan.runtimes),
      ring: cloneJson(validatedPlan.ring),
      phase: {
        ordinal: phase.ordinal,
        id: phase.id,
        topology: cloneJson(phase.topology),
      },
      issuedAt: Math.floor(startedAt.getTime() / 1000) - 10,
      notBefore: Math.floor(startedAt.getTime() / 1000) - 5,
      expiresAt: Math.floor(startedAt.getTime() / 1000) + 300,
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
      signerSpkiSha256: sha256Canonical({
        domain: "synthetic-permit-spki",
      }),
      issuedAt: permitSubject.issuedAt,
      notBefore: permitSubject.notBefore,
      expiresAt: permitSubject.expiresAt,
      campaignAuthority: {
        kind: "campaign-scoped-sqlite-durable-object",
        binding: "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        objectNameSha256: validatedPlan.campaignIdSha256,
        campaignBindingSha256: sha256Canonical({
          domain: "synthetic-campaign-binding",
        }),
        leaseIdSha256: sha256Canonical({
          domain: "synthetic-campaign-lease",
          phaseIndex,
        }),
        leaseReceiptSha256: sha256Canonical({
          domain: "synthetic-campaign-lease-receipt",
          phaseIndex,
        }),
        singleUsePermitPersisted: true,
        phaseOrderEnforced: true,
        concurrentPhaseRejected: true,
      },
    };
    const operatorInvocation = createSyntheticOperatorInvocationReference({
      plan: validatedPlan,
      phase,
      phaseIndex,
      startedAt: startedAt.toISOString().replace(".000Z", "Z"),
      completedAt: completedAt.toISOString().replace(".000Z", "Z"),
    });
    const privateInvocation = createSyntheticPrivateInvocationReference({
      plan: validatedPlan,
      phase,
      phaseIndex,
      receiptSha256,
      rawReceiptSha256: operatorInvocation.privateInvocationReceiptSha256,
      commandIdSha256: operatorInvocation.commandIdSha256,
      startedAt: startedAt.toISOString().replace(".000Z", "Z"),
      completedAt: completedAt.toISOString().replace(".000Z", "Z"),
    });
    const packetSubject = {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-source-packet",
      environment: "staging",
      campaignIdSha256: validatedPlan.campaignIdSha256,
      planDigestSha256: validatedPlan.planDigestSha256,
      activity: {
        ordinal: phase.ordinal,
        id: phase.id,
        status: "pass",
        startedAt: startedAt.toISOString().replace(".000Z", "Z"),
        completedAt: completedAt.toISOString().replace(".000Z", "Z"),
        deploymentReadbackStable: true,
        ledgerConverged: true,
      },
      controller: {
        ...cloneJson(validatedPlan.controller),
        deploymentSetSha256: controllerDeploymentSetSha256,
      },
      runtimes: cloneJson(validatedPlan.runtimes),
      ring: cloneJson(validatedPlan.ring),
      topology: cloneJson(phase.topology),
      containerDeploymentSetSha256: sha256Canonical({
        domain: "synthetic-container-deployment-set",
        phaseIndex,
      }),
      operatorInvocation,
      privateInvocation,
      executorReceipt: {
        contract:
          "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2",
        receiptSha256,
        campaignIdSha256: validatedPlan.campaignIdSha256,
        planDigestSha256: validatedPlan.planDigestSha256,
        phaseOrdinal: phase.ordinal,
        phaseId: phase.id,
        phaseExecutionId: `synthetic-phase-execution-${phaseIndex + 1}`,
        executorServiceName:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        executorVersionId: validatedPlan.privateServices.executor.versionId,
        startedAt: startedAt.toISOString().replace(".000Z", "Z"),
        completedAt: completedAt.toISOString().replace(".000Z", "Z"),
        targetService: "cinatoken-container-controller-staging",
        targetEntrypoint: "JsonCompatibilityProbeEntrypoint",
        privateServiceBindingRpcCount: EXPECTED_SHARD_COUNT,
        publicUrlUsed: false,
        cloudflareRestUsed: false,
        executionBoundarySha256: sha256Canonical(executorBoundary),
        authorization,
      },
      sourceContext: {
        contract:
          "cinatoken-container-runtime-json-compatibility-phase-source-context-v1",
        contextSha256: sha256Canonical({
          domain: "synthetic-source-context",
          phaseIndex,
          receiptSha256,
        }),
        receiptSha256,
      },
      shards,
      transportTotals: {
        ...transportFacts,
        evidenceSha256: sha256Canonical(transportFacts),
      },
      noMutationFacts: {
        ...mutationFacts,
        evidenceSha256: sha256Canonical(mutationFacts),
      },
    };
    return {
      ...packetSubject,
      packetSha256: sha256Canonical(packetSubject),
    };
  });
  return buildJsonCompatibilitySourceManifest(validatedPlan, packets);
}

export function validateJsonCompatibilityPhaseSourcePacket(
  plan,
  packet,
  expectedOrdinal,
) {
  const validatedPlan = validateManifestPlan(plan);
  const ordinal = requireInteger(
    expectedOrdinal,
    1,
    JSON_COMPATIBILITY_PHASE_IDS.length,
    "[phase-source] expected ordinal",
  );
  return validatePhasePacket(validatedPlan, packet, ordinal, {
    baselineDigests: null,
    seenRawDigests: null,
  });
}

function validateManifestPlan(plan) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  requireEqual(
    validatedPlan.ring.shardCount,
    EXPECTED_SHARD_COUNT,
    "[source-manifest] plan shard count",
  );
  requireEqual(
    validatedPlan.constraints.exactProbeCountPerPhase,
    EXPECTED_SHARD_COUNT,
    "[source-manifest] probes per phase",
  );
  return validatedPlan;
}

function validatePhasePacketSet(plan, phasePackets) {
  if (!Array.isArray(phasePackets) || phasePackets.length !== JSON_COMPATIBILITY_PHASE_IDS.length) {
    throw new JsonCompatibilityCampaignError(
      `[source-manifest] phase packets must contain exactly ${JSON_COMPATIBILITY_PHASE_IDS.length} entries`,
    );
  }
  const baselineDigests = new Map();
  const seenRawDigests = new Map();
  let previousCompletedAtMs = null;
  let controllerDeploymentSetSha256 = null;
  const packets = [];
  for (let index = 0; index < phasePackets.length; index += 1) {
    const packet = validatePhasePacket(plan, phasePackets[index], index + 1, {
      baselineDigests,
      seenRawDigests,
    });
    const startedAtMs = parseWholeSecondUtc(
      packet.activity.startedAt,
      `[phase-source] ${packet.activity.id} start`,
    );
    const completedAtMs = parseWholeSecondUtc(
      packet.activity.completedAt,
      `[phase-source] ${packet.activity.id} completion`,
    );
    if (previousCompletedAtMs !== null && startedAtMs < previousCompletedAtMs) {
      throw new JsonCompatibilityCampaignError(
        `[phase-source] ${packet.activity.id} overlaps the previous phase`,
      );
    }
    if (
      controllerDeploymentSetSha256 !== null &&
      packet.controller.deploymentSetSha256 !== controllerDeploymentSetSha256
    ) {
      throw new JsonCompatibilityCampaignError(
        `[phase-source] ${packet.activity.id} Controller deployment drifted`,
      );
    }
    previousCompletedAtMs = completedAtMs;
    controllerDeploymentSetSha256 = packet.controller.deploymentSetSha256;
    packets.push(packet);
  }
  return packets;
}

function validatePhasePacket(plan, packet, expectedOrdinal, crossPhase) {
  const expectedPlanPhase = plan.phases[expectedOrdinal - 1];
  const expectedPhaseId = JSON_COMPATIBILITY_PHASE_IDS[expectedOrdinal - 1];
  const label = `[phase-source] ${expectedPhaseId}`;
  const value = requireRecord(packet, `${label} packet`);
  requireExactKeys(value, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "activity",
    "controller",
    "runtimes",
    "ring",
    "topology",
    "containerDeploymentSetSha256",
    "operatorInvocation",
    "privateInvocation",
    "executorReceipt",
    "sourceContext",
    "shards",
    "transportTotals",
    "noMutationFacts",
    "packetSha256",
  ], `${label} packet`);
  requireEqual(value.schemaVersion, 1, `${label} schema version`);
  requireEqual(
    value.contract,
    JSON_COMPATIBILITY_PHASE_SOURCE_PACKET_CONTRACT,
    `${label} contract`,
  );
  requireEqual(
    value.kind,
    "container-runtime-json-compatibility-phase-source-packet",
    `${label} kind`,
  );
  requireEqual(value.environment, "staging", `${label} environment`);
  requireEqual(value.campaignIdSha256, plan.campaignIdSha256, `${label} campaign ID`);
  requireEqual(value.planDigestSha256, plan.planDigestSha256, `${label} plan digest`);

  const activity = validateActivity(value.activity, expectedPlanPhase, label);
  validatePacketController(value.controller, plan.controller, label);
  requireCanonicalEqual(value.runtimes, plan.runtimes, `${label} runtime identities`);
  requireCanonicalEqual(value.ring, plan.ring, `${label} ring topology`);
  requireCanonicalEqual(value.topology, expectedPlanPhase.topology, `${label} topology`);
  requireSha256(value.containerDeploymentSetSha256, `${label} container deployment set`);
  validateOperatorInvocationReference(
    value.operatorInvocation,
    value.privateInvocation,
    expectedPlanPhase,
    plan,
    label,
  );
  validatePrivateInvocationReference(
    value.privateInvocation,
    value.executorReceipt,
    expectedPlanPhase,
    plan,
    label,
  );
  validateExecutorReceiptReference(
    value.executorReceipt,
    expectedPlanPhase,
    plan,
    value.campaignIdSha256,
    value.planDigestSha256,
    label,
  );
  validateSourceContextReference(
    value.sourceContext,
    value.executorReceipt.receiptSha256,
    label,
  );

  if (!Array.isArray(value.shards) || value.shards.length !== EXPECTED_SHARD_COUNT) {
    throw new JsonCompatibilityCampaignError(
      `${label} must contain exactly ${EXPECTED_SHARD_COUNT} shard records`,
    );
  }
  for (let shardIndex = 0; shardIndex < EXPECTED_SHARD_COUNT; shardIndex += 1) {
    validateShardRecord({
      record: value.shards[shardIndex],
      plan,
      topology: expectedPlanPhase.topology,
      phaseId: expectedPhaseId,
      shardIndex,
      baselineDigests: crossPhase.baselineDigests,
      seenRawDigests: crossPhase.seenRawDigests,
      isBaseline: expectedOrdinal === 1,
    });
  }
  validateTransportTotals(value.transportTotals, value.shards, label);
  validateNoMutationFacts(value.noMutationFacts, label);
  requireSha256(value.packetSha256, `${label} packet digest`);
  const { packetSha256, ...packetSubject } = value;
  requireEqual(
    packetSha256,
    sha256Canonical(packetSubject),
    `${label} canonical packet digest`,
  );
  return value;
}

function validateSourceContextReference(value, expectedReceiptSha256, label) {
  const reference = requireRecord(value, `${label} source context`);
  requireExactKeys(
    reference,
    ["contract", "contextSha256", "receiptSha256"],
    `${label} source context`,
  );
  requireEqual(
    reference.contract,
    "cinatoken-container-runtime-json-compatibility-phase-source-context-v1",
    `${label} source context contract`,
  );
  requireSha256(reference.contextSha256, `${label} source context digest`);
  requireEqual(
    reference.receiptSha256,
    expectedReceiptSha256,
    `${label} source context receipt digest`,
  );
}

function validateActivity(value, expectedPlanPhase, label) {
  const activity = requireRecord(value, `${label} activity`);
  requireExactKeys(activity, [
    "ordinal",
    "id",
    "status",
    "startedAt",
    "completedAt",
    "deploymentReadbackStable",
    "ledgerConverged",
  ], `${label} activity`);
  requireEqual(activity.ordinal, expectedPlanPhase.ordinal, `${label} ordinal`);
  requireEqual(activity.id, expectedPlanPhase.id, `${label} phase ID`);
  requireEqual(activity.status, "pass", `${label} status`);
  const startedAtMs = parseWholeSecondUtc(activity.startedAt, `${label} start`);
  const completedAtMs = parseWholeSecondUtc(activity.completedAt, `${label} completion`);
  if (completedAtMs < startedAtMs) {
    throw new JsonCompatibilityCampaignError(`${label} completion precedes start`);
  }
  requireEqual(activity.deploymentReadbackStable, true, `${label} deployment readback`);
  requireEqual(activity.ledgerConverged, true, `${label} ledger convergence`);
  return activity;
}

function validatePacketController(value, expected, label) {
  const controller = requireRecord(value, `${label} Controller`);
  requireExactKeys(
    controller,
    [...Object.keys(expected), "deploymentSetSha256"],
    `${label} Controller`,
  );
  const { deploymentSetSha256, ...identity } = controller;
  requireCanonicalEqual(identity, expected, `${label} Controller identity`);
  requireSha256(deploymentSetSha256, `${label} Controller deployment set`);
}

function createSyntheticOperatorInvocationReference({
  plan,
  phase,
  phaseIndex,
  startedAt,
  completedAt,
}) {
  const digest = (domain) => sha256Canonical({ domain, phaseIndex });
  return {
    contract:
      "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v1",
    receiptSha256: digest("synthetic-operator-invocation-receipt"),
    operatorBodySha256: digest("synthetic-operator-invocation-body"),
    privateInvocationReceiptSha256:
      digest("synthetic-private-invocation-raw-receipt"),
    requestSha256: digest("synthetic-operator-request"),
    commandIdSha256: digest("synthetic-private-command"),
    phaseExecutionId: `synthetic-phase-execution-${phaseIndex + 1}`,
    phaseOrdinal: phase.ordinal,
    phaseId: phase.id,
    operator: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-operator-staging",
      versionId: plan.privateServices.operator.versionId,
      gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED",
    },
    privateTransport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      invokerBinding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
    },
    startedAt,
    completedAt,
  };
}

function createSyntheticPrivateInvocationReference({
  plan,
  phase,
  phaseIndex,
  receiptSha256,
  rawReceiptSha256,
  commandIdSha256,
  startedAt,
  completedAt,
}) {
  const digest = (domain) => sha256Canonical({
    domain,
    phaseIndex,
  });
  return {
    contract:
      "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1",
    receiptSha256: digest("synthetic-private-invocation-receipt"),
    rawReceiptSha256,
    invocationBodySha256: digest("synthetic-private-invocation-body"),
    phaseExecutionId: `synthetic-phase-execution-${phaseIndex + 1}`,
    phaseOrdinal: phase.ordinal,
    phaseId: phase.id,
    commandIdSha256,
    operatorAuthority: {
      issuer: "cinatoken-json-compatibility-campaign-operator-staging",
      audience:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      keyId: "synthetic-operator-key",
      credentialIdSha256: digest("synthetic-operator-credential"),
      claimsSha256: digest("synthetic-operator-claims"),
      commandSubjectSha256: digest("synthetic-command-subject"),
      authorityEnvelopeSha256: digest("synthetic-command-envelope"),
      issuedAt: Math.floor(Date.parse(startedAt) / 1000),
      expiresAt: Math.floor(Date.parse(startedAt) / 1000) + 60,
    },
    invoker: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      versionId: plan.privateServices.invoker.versionId,
      gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED",
    },
    privateTransport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      permitIssuerBinding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
    },
    invocationAuthority: {
      attemptIdSha256: digest("synthetic-invocation-attempt"),
      attemptReceiptSha256: digest("synthetic-invocation-attempt-receipt"),
      completionReceiptSha256:
        digest("synthetic-invocation-completion-receipt"),
      oneAttemptPerPhasePersisted: true,
      phaseOrderEnforced: true,
      ambiguousRetryRejected: true,
      attemptCompletionPersisted: true,
      phaseOrderAdvanced: true,
      campaignTerminal: phase.ordinal === JSON_COMPATIBILITY_PHASE_IDS.length,
    },
    permitIssue: {
      contract:
        "cinatoken-container-runtime-json-compatibility-permit-issue-receipt-v1",
      receiptSha256: digest("synthetic-permit-issue-receipt"),
      issueIntentSha256: digest("synthetic-permit-issue-intent"),
      permitEnvelopeSha256: digest("synthetic-permit-envelope"),
      issuanceAuthorityReceiptSha256:
        digest("synthetic-permit-issuance-authority-receipt"),
      issuer: {
        serviceName:
          "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
        versionId: plan.privateServices.permitIssuer.versionId,
        keyId: "synthetic-permit-key",
        signerSpkiSha256: digest("synthetic-permit-spki"),
      },
      authority: {
        issuer:
          "cinatoken-container-runtime-json-compatibility-invoker-staging",
        audience:
          "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
        keyId: "synthetic-issuer-authority-key",
        credentialIdSha256: digest("synthetic-issuer-authority-credential"),
        requestIdSha256: digest("synthetic-issuer-request"),
        claimsSha256: digest("synthetic-issuer-claims"),
      },
    },
    executorReceiptSha256: receiptSha256,
    startedAt,
    completedAt,
  };
}

function validateOperatorInvocationReference(
  value,
  privateInvocationValue,
  expectedPhase,
  plan,
  label,
) {
  const invocation = requireRecord(value, `${label} operator invocation`);
  requireExactKeys(invocation, [
    "contract", "receiptSha256", "operatorBodySha256",
    "privateInvocationReceiptSha256", "requestSha256", "commandIdSha256",
    "phaseExecutionId", "phaseOrdinal", "phaseId", "operator",
    "privateTransport", "startedAt", "completedAt",
  ], `${label} operator invocation`);
  requireEqual(
    invocation.contract,
    "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v1",
    `${label} operator invocation contract`,
  );
  for (const name of [
    "receiptSha256", "operatorBodySha256", "privateInvocationReceiptSha256",
    "requestSha256", "commandIdSha256",
  ]) requireSha256(invocation[name], `${label} operator invocation ${name}`);
  requireSafeToken(
    invocation.phaseExecutionId,
    `${label} operator invocation execution ID`,
  );
  requireEqual(
    invocation.phaseOrdinal,
    expectedPhase.ordinal,
    `${label} operator invocation phase ordinal`,
  );
  requireEqual(
    invocation.phaseId,
    expectedPhase.id,
    `${label} operator invocation phase ID`,
  );

  const privateInvocation = requireRecord(
    privateInvocationValue,
    `${label} private invocation`,
  );
  requireEqual(
    invocation.phaseExecutionId,
    privateInvocation.phaseExecutionId,
    `${label} operator/private execution binding`,
  );
  requireEqual(
    invocation.commandIdSha256,
    privateInvocation.commandIdSha256,
    `${label} operator/private command binding`,
  );
  requireEqual(
    invocation.privateInvocationReceiptSha256,
    privateInvocation.rawReceiptSha256,
    `${label} operator/private raw receipt binding`,
  );
  const startedAtMs = parseWholeSecondUtc(
    invocation.startedAt,
    `${label} operator invocation start`,
  );
  const completedAtMs = parseWholeSecondUtc(
    invocation.completedAt,
    `${label} operator invocation completion`,
  );
  if (
    completedAtMs < startedAtMs
    || startedAtMs > Date.parse(privateInvocation.startedAt)
    || completedAtMs < Date.parse(privateInvocation.completedAt)
  ) {
    throw new JsonCompatibilityCampaignError(
      `${label} operator invocation must enclose the private invocation`,
    );
  }

  const operator = requireRecord(
    invocation.operator,
    `${label} operator identity`,
  );
  requireExactKeys(
    operator,
    ["serviceName", "versionId", "gateName"],
    `${label} operator identity`,
  );
  requireEqual(
    operator.serviceName,
    plan.privateServices.operator.serviceName,
    `${label} operator service`,
  );
  requireEqual(
    operator.versionId,
    plan.privateServices.operator.versionId,
    `${label} operator version`,
  );
  requireEqual(
    operator.gateName,
    plan.privateServices.operator.gateName,
    `${label} operator gate`,
  );

  const transport = requireRecord(
    invocation.privateTransport,
    `${label} operator private transport`,
  );
  requireExactKeys(transport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "invokerBinding",
  ], `${label} operator private transport`);
  requireEqual(transport.kind, "service-binding-rpc", `${label} operator transport`);
  requireEqual(transport.publicUrlUsed, false, `${label} operator public URL`);
  requireEqual(transport.cloudflareRestUsed, false, `${label} operator REST`);
  requireEqual(
    transport.invokerBinding,
    "JSON_COMPATIBILITY_INVOKER_SERVICE",
    `${label} operator invoker binding`,
  );
}

function validatePrivateInvocationReference(
  value,
  executorReceiptValue,
  expectedPhase,
  plan,
  label,
) {
  const invocation = requireRecord(value, `${label} private invocation`);
  requireExactKeys(invocation, [
    "contract", "receiptSha256", "rawReceiptSha256", "invocationBodySha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "commandIdSha256", "operatorAuthority",
    "invoker", "privateTransport", "invocationAuthority", "permitIssue",
    "executorReceiptSha256", "startedAt", "completedAt",
  ], `${label} private invocation`);
  requireEqual(
    invocation.contract,
    "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1",
    `${label} private invocation contract`,
  );
  for (const name of [
    "receiptSha256", "rawReceiptSha256", "invocationBodySha256", "commandIdSha256",
    "executorReceiptSha256",
  ]) requireSha256(invocation[name], `${label} private invocation ${name}`);
  requireSafeToken(
    invocation.phaseExecutionId,
    `${label} private invocation execution ID`,
  );
  requireEqual(
    invocation.phaseOrdinal,
    expectedPhase.ordinal,
    `${label} private invocation phase ordinal`,
  );
  requireEqual(
    invocation.phaseId,
    expectedPhase.id,
    `${label} private invocation phase ID`,
  );

  const executorReceipt = requireRecord(
    executorReceiptValue,
    `${label} executor receipt`,
  );
  requireEqual(
    invocation.phaseExecutionId,
    executorReceipt.phaseExecutionId,
    `${label} private invocation execution binding`,
  );
  requireEqual(
    invocation.executorReceiptSha256,
    executorReceipt.receiptSha256,
    `${label} private invocation executor digest`,
  );
  const startedAtMs = parseWholeSecondUtc(
    invocation.startedAt,
    `${label} private invocation start`,
  );
  const completedAtMs = parseWholeSecondUtc(
    invocation.completedAt,
    `${label} private invocation completion`,
  );
  if (
    completedAtMs < startedAtMs
    || startedAtMs > Date.parse(executorReceipt.startedAt)
    || completedAtMs < Date.parse(executorReceipt.completedAt)
  ) {
    throw new JsonCompatibilityCampaignError(
      `${label} private invocation must enclose the executor receipt`,
    );
  }

  const operator = requireRecord(
    invocation.operatorAuthority,
    `${label} operator authority`,
  );
  requireExactKeys(operator, [
    "issuer", "audience", "keyId", "credentialIdSha256", "claimsSha256",
    "commandSubjectSha256", "authorityEnvelopeSha256", "issuedAt", "expiresAt",
  ], `${label} operator authority`);
  requireSafeToken(operator.issuer, `${label} operator issuer`);
  requireEqual(
    operator.audience,
    "cinatoken-container-runtime-json-compatibility-invoker-staging",
    `${label} operator audience`,
  );
  requireSafeToken(operator.keyId, `${label} operator key ID`);
  for (const name of [
    "credentialIdSha256", "claimsSha256", "commandSubjectSha256",
    "authorityEnvelopeSha256",
  ]) requireSha256(operator[name], `${label} operator ${name}`);
  requireInteger(operator.issuedAt, 1, Number.MAX_SAFE_INTEGER, `${label} operator issuedAt`);
  requireInteger(operator.expiresAt, 1, Number.MAX_SAFE_INTEGER, `${label} operator expiresAt`);
  if (operator.expiresAt <= operator.issuedAt || operator.expiresAt - operator.issuedAt > 60) {
    throw new JsonCompatibilityCampaignError(`${label} operator time window is invalid`);
  }

  const invoker = requireRecord(invocation.invoker, `${label} invoker`);
  requireExactKeys(invoker, ["serviceName", "versionId", "gateName"], `${label} invoker`);
  requireEqual(
    invoker.serviceName,
    "cinatoken-container-runtime-json-compatibility-invoker-staging",
    `${label} invoker service`,
  );
  requireSafeToken(invoker.versionId, `${label} invoker version`);
  requireEqual(
    invoker.versionId,
    plan.privateServices.invoker.versionId,
    `${label} planned invoker version`,
  );
  requireEqual(invoker.gateName, "JSON_COMPATIBILITY_INVOKER_ENABLED", `${label} invoker gate`);

  const transport = requireRecord(
    invocation.privateTransport,
    `${label} private transport`,
  );
  requireExactKeys(transport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "permitIssuerBinding",
    "executorBinding",
  ], `${label} private transport`);
  requireEqual(transport.kind, "service-binding-rpc", `${label} private transport kind`);
  requireEqual(transport.publicUrlUsed, false, `${label} private public URL use`);
  requireEqual(transport.cloudflareRestUsed, false, `${label} private REST use`);
  requireEqual(transport.permitIssuerBinding, "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE", `${label} permit issuer binding`);
  requireEqual(transport.executorBinding, "JSON_COMPATIBILITY_EXECUTOR_SERVICE", `${label} executor binding`);

  const authority = requireRecord(
    invocation.invocationAuthority,
    `${label} invocation authority`,
  );
  requireExactKeys(authority, [
    "attemptIdSha256", "attemptReceiptSha256", "completionReceiptSha256",
    "oneAttemptPerPhasePersisted", "phaseOrderEnforced",
    "ambiguousRetryRejected", "attemptCompletionPersisted",
    "phaseOrderAdvanced", "campaignTerminal",
  ], `${label} invocation authority`);
  for (const name of ["attemptIdSha256", "attemptReceiptSha256", "completionReceiptSha256"]) {
    requireSha256(authority[name], `${label} invocation authority ${name}`);
  }
  for (const name of [
    "oneAttemptPerPhasePersisted", "phaseOrderEnforced",
    "ambiguousRetryRejected", "attemptCompletionPersisted", "phaseOrderAdvanced",
  ]) requireEqual(authority[name], true, `${label} invocation authority ${name}`);
  requireEqual(
    authority.campaignTerminal,
    expectedPhase.ordinal === JSON_COMPATIBILITY_PHASE_IDS.length,
    `${label} invocation campaign terminal flag`,
  );

  const permit = requireRecord(invocation.permitIssue, `${label} permit issue`);
  requireExactKeys(permit, [
    "contract", "receiptSha256", "issueIntentSha256", "permitEnvelopeSha256",
    "issuanceAuthorityReceiptSha256", "issuer", "authority",
  ], `${label} permit issue`);
  requireEqual(
    permit.contract,
    "cinatoken-container-runtime-json-compatibility-permit-issue-receipt-v1",
    `${label} permit issue contract`,
  );
  for (const name of [
    "receiptSha256", "issueIntentSha256", "permitEnvelopeSha256",
    "issuanceAuthorityReceiptSha256",
  ]) requireSha256(permit[name], `${label} permit issue ${name}`);
  const issuer = requireRecord(permit.issuer, `${label} permit issuer`);
  requireExactKeys(issuer, ["serviceName", "versionId", "keyId", "signerSpkiSha256"], `${label} permit issuer`);
  requireEqual(
    issuer.serviceName,
    "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    `${label} permit issuer service`,
  );
  requireSafeToken(issuer.versionId, `${label} permit issuer version`);
  requireEqual(
    issuer.versionId,
    plan.privateServices.permitIssuer.versionId,
    `${label} planned permit issuer version`,
  );
  requireSafeToken(issuer.keyId, `${label} permit key ID`);
  requireSha256(issuer.signerSpkiSha256, `${label} signer SPKI digest`);
  const permitAuthority = requireRecord(permit.authority, `${label} permit authority`);
  requireExactKeys(permitAuthority, [
    "issuer", "audience", "keyId", "credentialIdSha256", "requestIdSha256",
    "claimsSha256",
  ], `${label} permit authority`);
  requireEqual(permitAuthority.issuer, invoker.serviceName, `${label} permit authority issuer`);
  requireEqual(
    permitAuthority.audience,
    issuer.serviceName,
    `${label} permit authority audience`,
  );
  requireSafeToken(permitAuthority.keyId, `${label} permit authority key ID`);
  for (const name of ["credentialIdSha256", "requestIdSha256", "claimsSha256"]) {
    requireSha256(permitAuthority[name], `${label} permit authority ${name}`);
  }
}

function validateExecutorReceiptReference(
  value,
  expectedPhase,
  plan,
  campaignIdSha256,
  planDigestSha256,
  label,
) {
  const receipt = requireRecord(value, `${label} executor receipt`);
  requireExactKeys(receipt, [
    "contract",
    "receiptSha256",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseOrdinal",
    "phaseId",
    "phaseExecutionId",
    "executorServiceName",
    "executorVersionId",
    "startedAt",
    "completedAt",
    "targetService",
    "targetEntrypoint",
    "privateServiceBindingRpcCount",
    "publicUrlUsed",
    "cloudflareRestUsed",
    "executionBoundarySha256",
    "authorization",
  ], `${label} executor receipt`);
  requireEqual(
    receipt.contract,
    "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2",
    `${label} executor receipt contract`,
  );
  requireSha256(receipt.receiptSha256, `${label} executor receipt digest`);
  requireEqual(
    receipt.campaignIdSha256,
    campaignIdSha256,
    `${label} executor receipt campaign ID`,
  );
  requireEqual(
    receipt.planDigestSha256,
    planDigestSha256,
    `${label} executor receipt plan digest`,
  );
  requireEqual(
    receipt.phaseOrdinal,
    expectedPhase.ordinal,
    `${label} executor receipt phase ordinal`,
  );
  requireEqual(
    receipt.phaseId,
    expectedPhase.id,
    `${label} executor receipt phase ID`,
  );
  requireSafeToken(
    receipt.phaseExecutionId,
    `${label} executor receipt execution ID`,
  );
  requireEqual(
    receipt.executorServiceName,
    "cinatoken-container-runtime-json-compatibility-executor-staging",
    `${label} executor service name`,
  );
  requireSafeToken(
    receipt.executorVersionId,
    `${label} executor version ID`,
  );
  requireEqual(
    receipt.executorVersionId,
    plan.privateServices.executor.versionId,
    `${label} planned executor version ID`,
  );
  const startedAtMs = parseWholeSecondUtc(
    receipt.startedAt,
    `${label} executor receipt start`,
  );
  const completedAtMs = parseWholeSecondUtc(
    receipt.completedAt,
    `${label} executor receipt completion`,
  );
  if (completedAtMs < startedAtMs) {
    throw new JsonCompatibilityCampaignError(
      `${label} executor receipt completion precedes start`,
    );
  }
  requireEqual(
    receipt.targetService,
    "cinatoken-container-controller-staging",
    `${label} executor target service`,
  );
  requireEqual(
    receipt.targetEntrypoint,
    "JsonCompatibilityProbeEntrypoint",
    `${label} executor target entrypoint`,
  );
  requireEqual(
    receipt.privateServiceBindingRpcCount,
    EXPECTED_SHARD_COUNT,
    `${label} executor private RPC count`,
  );
  requireEqual(receipt.publicUrlUsed, false, `${label} executor public URL use`);
  requireEqual(
    receipt.cloudflareRestUsed,
    false,
    `${label} executor Cloudflare REST use`,
  );
  requireSha256(
    receipt.executionBoundarySha256,
    `${label} executor boundary digest`,
  );
  validateExecutorAuthorizationReference(
    receipt.authorization,
    expectedPhase,
    plan,
    campaignIdSha256,
    planDigestSha256,
    receipt.executorVersionId,
    label,
  );
}

function validateExecutorAuthorizationReference(
  value,
  expectedPhase,
  plan,
  campaignIdSha256,
  planDigestSha256,
  executorVersionId,
  label,
) {
  const authorization = requireRecord(
    value,
    `${label} executor authorization`,
  );
  requireExactKeys(authorization, [
    "kind",
    "algorithm",
    "permitIdSha256",
    "permitSubjectSha256",
    "permitEnvelopeSha256",
    "permitEnvelope",
    "issuer",
    "audience",
    "keyId",
    "signerSpkiSha256",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "campaignAuthority",
  ], `${label} executor authorization`);
  requireEqual(
    authorization.kind,
    "ed25519-signed-single-use-phase-permit",
    `${label} authorization kind`,
  );
  requireEqual(
    authorization.algorithm,
    "Ed25519",
    `${label} authorization algorithm`,
  );
  for (const name of [
    "permitIdSha256",
    "permitSubjectSha256",
    "permitEnvelopeSha256",
    "signerSpkiSha256",
  ]) {
    requireSha256(authorization[name], `${label} authorization ${name}`);
  }
  requireSafeToken(authorization.issuer, `${label} authorization issuer`);
  requireSafeToken(authorization.audience, `${label} authorization audience`);
  requireSafeToken(authorization.keyId, `${label} authorization key ID`);
  for (const name of ["issuedAt", "notBefore", "expiresAt"]) {
    requireInteger(
      authorization[name],
      1,
      Number.MAX_SAFE_INTEGER,
      `${label} authorization ${name}`,
    );
  }
  if (
    authorization.notBefore < authorization.issuedAt - 5
    || authorization.expiresAt <= authorization.notBefore
    || authorization.expiresAt - authorization.issuedAt > 600
  ) {
    throw new JsonCompatibilityCampaignError(
      `${label} authorization time window is invalid`,
    );
  }

  const envelope = requireRecord(
    authorization.permitEnvelope,
    `${label} permit envelope`,
  );
  requireExactKeys(envelope, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signatureBase64url",
  ], `${label} permit envelope`);
  requireEqual(envelope.schemaVersion, 1, `${label} permit envelope schema`);
  requireEqual(
    envelope.contract,
    "cinatoken-container-runtime-json-compatibility-phase-permit-envelope-v1",
    `${label} permit envelope contract`,
  );
  requireEqual(envelope.algorithm, "Ed25519", `${label} permit envelope algorithm`);
  requireEqual(
    envelope.subjectSha256,
    authorization.permitSubjectSha256,
    `${label} permit subject reference`,
  );
  requireEqual(
    sha256Canonical(envelope),
    authorization.permitEnvelopeSha256,
    `${label} permit envelope digest`,
  );
  if (
    typeof envelope.signatureBase64url !== "string"
    || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signatureBase64url)
  ) {
    throw new JsonCompatibilityCampaignError(
      `${label} permit signature is invalid`,
    );
  }
  const subject = requireRecord(envelope.subject, `${label} permit subject`);
  requireExactKeys(subject, [
    "schemaVersion",
    "contract",
    "issuer",
    "audience",
    "keyId",
    "permitIdSha256",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "executor",
    "runtimes",
    "ring",
    "phase",
    "issuedAt",
    "notBefore",
    "expiresAt",
  ], `${label} permit subject`);
  requireEqual(subject.schemaVersion, 1, `${label} permit subject schema`);
  requireEqual(
    subject.contract,
    "cinatoken-container-runtime-json-compatibility-phase-permit-subject-v1",
    `${label} permit subject contract`,
  );
  requireEqual(
    sha256Canonical(subject),
    authorization.permitSubjectSha256,
    `${label} permit subject digest`,
  );
  for (const name of ["issuer", "audience", "keyId", "permitIdSha256"]) {
    requireEqual(
      subject[name],
      authorization[name],
      `${label} permit ${name}`,
    );
  }
  requireEqual(subject.campaignIdSha256, campaignIdSha256, `${label} permit campaign`);
  requireEqual(subject.planDigestSha256, planDigestSha256, `${label} permit plan`);
  requireCanonicalEqual(subject.controller, {
    serviceName: plan.controller.serviceName,
    versionId: plan.controller.versionId,
    configSha256: plan.controller.configSha256,
  }, `${label} permit Controller`);
  requireCanonicalEqual(subject.runtimes, plan.runtimes, `${label} permit runtimes`);
  requireCanonicalEqual(subject.ring, plan.ring, `${label} permit ring`);
  requireCanonicalEqual(subject.phase, {
    ordinal: expectedPhase.ordinal,
    id: expectedPhase.id,
    topology: expectedPhase.topology,
  }, `${label} permit phase`);
  const executor = requireRecord(subject.executor, `${label} permit executor`);
  requireExactKeys(
    executor,
    ["serviceName", "versionId"],
    `${label} permit executor`,
  );
  requireEqual(
    executor.serviceName,
    "cinatoken-container-runtime-json-compatibility-executor-staging",
    `${label} permit executor service`,
  );
  requireEqual(executor.versionId, executorVersionId, `${label} permit executor version`);
  for (const name of ["issuedAt", "notBefore", "expiresAt"]) {
    requireEqual(subject[name], authorization[name], `${label} permit ${name}`);
  }

  const authority = requireRecord(
    authorization.campaignAuthority,
    `${label} campaign authority`,
  );
  requireExactKeys(authority, [
    "kind",
    "binding",
    "objectNameSha256",
    "campaignBindingSha256",
    "leaseIdSha256",
    "leaseReceiptSha256",
    "singleUsePermitPersisted",
    "phaseOrderEnforced",
    "concurrentPhaseRejected",
  ], `${label} campaign authority`);
  requireEqual(
    authority.kind,
    "campaign-scoped-sqlite-durable-object",
    `${label} campaign authority kind`,
  );
  requireEqual(
    authority.binding,
    "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
    `${label} campaign authority binding`,
  );
  requireEqual(
    authority.objectNameSha256,
    campaignIdSha256,
    `${label} campaign authority object name`,
  );
  for (const name of [
    "campaignBindingSha256",
    "leaseIdSha256",
    "leaseReceiptSha256",
  ]) {
    requireSha256(authority[name], `${label} campaign authority ${name}`);
  }
  for (const name of [
    "singleUsePermitPersisted",
    "phaseOrderEnforced",
    "concurrentPhaseRejected",
  ]) {
    requireEqual(authority[name], true, `${label} campaign authority ${name}`);
  }
}

function validateShardRecord({
  record,
  plan,
  topology,
  phaseId,
  shardIndex,
  baselineDigests,
  seenRawDigests,
  isBaseline,
}) {
  const label = `[phase-source] ${phaseId} shard ${shardIndex}`;
  const value = requireRecord(record, label);
  requireExactKeys(value, [
    "shardIndex",
    "runtimeGeneration",
    "runtimeBuildIdSha256",
    "readiness",
    "rawRequest",
    "rawResponse",
    "rawRequestSha256",
    "rawResponseSha256",
    "normalizedDigests",
    "transportFacts",
  ], label);
  requireEqual(value.shardIndex, shardIndex, `${label} index`);
  const expectedGeneration = expectedRuntimeForShard(topology, shardIndex);
  requireEqual(value.runtimeGeneration, expectedGeneration, `${label} runtime generation`);
  const runtime = runtimeForGeneration(plan.runtimes, expectedGeneration);
  requireEqual(
    value.runtimeBuildIdSha256,
    runtime.buildIdSha256,
    `${label} runtime build ID`,
  );
  validateReadiness(value.readiness, runtime.buildIdSha256, label);
  requireBoundedText(value.rawRequest, MAX_RAW_REQUEST_BYTES, `${label} raw request`);
  requireBoundedText(value.rawResponse, MAX_RAW_RESPONSE_BYTES, `${label} raw response`);

  const calculated = createJsonHealthProbeDigestRecord(
    value.rawRequest,
    value.rawResponse,
  );
  requireSha256(value.rawRequestSha256, `${label} raw request digest`);
  requireSha256(value.rawResponseSha256, `${label} raw response digest`);
  requireEqual(
    value.rawRequestSha256,
    calculated.requestSha256,
    `${label} raw request digest`,
  );
  requireEqual(
    value.rawResponseSha256,
    calculated.responseSha256,
    `${label} raw response digest`,
  );
  validateNormalizedDigests(value.normalizedDigests, calculated, label);
  validateRawRequestTopology(value.rawRequest, plan.ring, shardIndex, label);
  validateTransportFacts(value.transportFacts, label);

  if (seenRawDigests !== null) {
    const seen = seenRawDigests.get(shardIndex) ?? {
      request: new Set(),
      response: new Set(),
    };
    if (seen.request.has(value.rawRequestSha256)) {
      throw new JsonCompatibilityCampaignError(
        `${label} raw request digest was reused across phases`,
      );
    }
    if (seen.response.has(value.rawResponseSha256)) {
      throw new JsonCompatibilityCampaignError(
        `${label} raw response digest was reused across phases`,
      );
    }
    seen.request.add(value.rawRequestSha256);
    seen.response.add(value.rawResponseSha256);
    seenRawDigests.set(shardIndex, seen);
  }

  if (baselineDigests === null) return;
  if (isBaseline) {
    baselineDigests.set(shardIndex, cloneJson(value.normalizedDigests));
    return;
  }
  requireCanonicalEqual(
    value.normalizedDigests,
    baselineDigests.get(shardIndex),
    `${label} normalized JSON compatibility projection`,
  );
}

function validateReadiness(value, expectedBuildIdSha256, label) {
  const readiness = requireRecord(value, `${label} readiness`);
  requireExactKeys(readiness, [
    "statusCode",
    "contentType",
    "rawJson",
    "rawByteLength",
    "rawSha256",
    "runtimeBuildIdSha256",
    "protocolVersion",
    "shardContractVersion",
    "executionEnabled",
    "evidenceSha256",
  ], `${label} readiness`);
  requireEqual(readiness.statusCode, 200, `${label} readiness status`);
  requireEqual(readiness.contentType, JSON_CONTENT_TYPE, `${label} readiness content type`);
  requireEqual(
    readiness.runtimeBuildIdSha256,
    expectedBuildIdSha256,
    `${label} readiness build ID`,
  );
  requireEqual(readiness.protocolVersion, 1, `${label} readiness protocol version`);
  requireEqual(readiness.shardContractVersion, 1, `${label} readiness shard contract`);
  requireEqual(readiness.executionEnabled, false, `${label} readiness execution gate`);
  const rawJson = requireBoundedText(
    readiness.rawJson,
    MAX_RAW_READINESS_BYTES,
    `${label} readiness raw JSON`,
  );
  const rawByteLength = new TextEncoder().encode(rawJson).byteLength;
  requireEqual(
    readiness.rawByteLength,
    rawByteLength,
    `${label} readiness raw byte length`,
  );
  requireSha256(readiness.rawSha256, `${label} readiness raw digest`);
  requireEqual(
    readiness.rawSha256,
    sha256Utf8(rawJson),
    `${label} readiness raw digest`,
  );
  let wire;
  try {
    wire = JSON.parse(rawJson);
  } catch {
    throw new JsonCompatibilityCampaignError(
      `${label} readiness raw JSON must be valid JSON`,
    );
  }
  wire = requireRecord(wire, `${label} readiness wire body`);
  requireExactKeys(wire, [
    "status",
    "protocol_version",
    "runtime_build_id",
    "shard_contract_version",
    "execution_enabled",
  ], `${label} readiness wire body`);
  requireEqual(wire.status, "ready", `${label} readiness wire status`);
  requireEqual(wire.protocol_version, 1, `${label} readiness wire protocol`);
  requireEqual(
    wire.runtime_build_id,
    expectedBuildIdSha256,
    `${label} readiness wire build ID`,
  );
  requireEqual(
    wire.shard_contract_version,
    1,
    `${label} readiness wire shard contract`,
  );
  requireEqual(
    wire.execution_enabled,
    false,
    `${label} readiness wire execution gate`,
  );
  requireSha256(readiness.evidenceSha256, `${label} readiness evidence digest`);
  const { evidenceSha256, ...facts } = readiness;
  requireEqual(
    evidenceSha256,
    sha256Canonical(facts),
    `${label} readiness canonical digest`,
  );
}

function validateNormalizedDigests(value, calculated, label) {
  const digests = requireRecord(value, `${label} normalized digests`);
  requireExactKeys(digests, [
    "requestCompatibilitySha256",
    "responseCompatibilitySha256",
  ], `${label} normalized digests`);
  for (const name of [
    "requestCompatibilitySha256",
    "responseCompatibilitySha256",
  ]) {
    requireSha256(digests[name], `${label} ${name}`);
    requireEqual(digests[name], calculated[name], `${label} ${name}`);
  }
}

function validateRawRequestTopology(rawRequest, ring, shardIndex, label) {
  let request;
  try {
    request = JSON.parse(rawRequest);
  } catch {
    throw new JsonCompatibilityCampaignError(`${label} raw request must be valid JSON`);
  }
  const shard = requireRecord(request.shard, `${label} raw request shard`);
  requireEqual(shard.contract_version, 1, `${label} raw shard contract version`);
  requireEqual(shard.ring_generation, ring.generation, `${label} raw ring generation`);
  requireEqual(shard.shard_count, EXPECTED_SHARD_COUNT, `${label} raw shard count`);
  requireEqual(shard.shard_index, shardIndex, `${label} raw shard index`);
  requireEqual(
    shard.instance_name,
    `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`,
    `${label} raw shard instance name`,
  );
}

function validateTransportFacts(value, label) {
  const facts = requireRecord(value, `${label} transport facts`);
  requireExactKeys(facts, [
    "operationKind",
    "statusCode",
    "requestContentType",
    "responseContentType",
    "selectedTransport",
    "effectiveTransport",
    "attemptCount",
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "outcome",
    "recoveryRequired",
  ], `${label} transport facts`);
  requireEqual(facts.operationKind, "health_probe", `${label} operation kind`);
  requireEqual(facts.statusCode, 200, `${label} response status`);
  requireEqual(facts.requestContentType, JSON_CONTENT_TYPE, `${label} request content type`);
  requireEqual(facts.responseContentType, JSON_CONTENT_TYPE, `${label} response content type`);
  requireEqual(facts.selectedTransport, "json", `${label} selected transport`);
  requireEqual(facts.effectiveTransport, "json", `${label} effective transport`);
  requireEqual(facts.attemptCount, 1, `${label} attempt count`);
  requireEqual(facts.protobufAttemptCount, 0, `${label} Protobuf attempt count`);
  requireEqual(facts.legacyJsonFallbackCount, 0, `${label} legacy fallback count`);
  requireEqual(facts.outcome, "completed", `${label} outcome`);
  requireEqual(facts.recoveryRequired, false, `${label} recovery requirement`);
}

function validateTransportTotals(value, shards, label) {
  const totals = requireRecord(value, `${label} transport totals`);
  requireExactKeys(totals, [
    "evidenceSha256",
    "eventsObserved",
    "selectedJsonCount",
    "effectiveJsonCount",
    "protobufAttemptCount",
    "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ], `${label} transport totals`);
  const expectedFacts = {
    eventsObserved: shards.length,
    selectedJsonCount: countBy(shards, (shard) => shard.transportFacts.selectedTransport === "json"),
    effectiveJsonCount: countBy(shards, (shard) => shard.transportFacts.effectiveTransport === "json"),
    protobufAttemptCount: sumBy(shards, (shard) => shard.transportFacts.protobufAttemptCount),
    legacyJsonFallbackCount: sumBy(shards, (shard) => shard.transportFacts.legacyJsonFallbackCount),
    recoveryRequiredCount: countBy(shards, (shard) => shard.transportFacts.recoveryRequired),
  };
  const { evidenceSha256, ...facts } = totals;
  requireCanonicalEqual(facts, expectedFacts, `${label} transport totals`);
  requireSha256(evidenceSha256, `${label} transport evidence digest`);
  requireEqual(
    evidenceSha256,
    sha256Canonical(facts),
    `${label} transport canonical digest`,
  );
}

function validateNoMutationFacts(value, label) {
  const facts = requireRecord(value, `${label} no-mutation facts`);
  requireExactKeys(facts, [
    "evidenceSha256",
    "providerBeforeSha256",
    "providerAfterSha256",
    "billingBeforeSha256",
    "billingAfterSha256",
    "storageGatewayBeforeSha256",
    "storageGatewayAfterSha256",
    "productionTrafficBeforeSha256",
    "productionTrafficAfterSha256",
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ], `${label} no-mutation facts`);
  for (const name of [
    "evidenceSha256",
    "providerBeforeSha256",
    "providerAfterSha256",
    "billingBeforeSha256",
    "billingAfterSha256",
    "storageGatewayBeforeSha256",
    "storageGatewayAfterSha256",
    "productionTrafficBeforeSha256",
    "productionTrafficAfterSha256",
  ]) {
    requireSha256(facts[name], `${label} ${name}`);
  }
  requireEqual(
    facts.providerAfterSha256,
    facts.providerBeforeSha256,
    `${label} provider snapshot`,
  );
  requireEqual(
    facts.billingAfterSha256,
    facts.billingBeforeSha256,
    `${label} billing snapshot`,
  );
  requireEqual(
    facts.storageGatewayAfterSha256,
    facts.storageGatewayBeforeSha256,
    `${label} storage gateway snapshot`,
  );
  requireEqual(
    facts.productionTrafficAfterSha256,
    facts.productionTrafficBeforeSha256,
    `${label} production traffic snapshot`,
  );
  for (const name of [
    "providerRequestCount",
    "billingMutationCount",
    "storageGatewayMutationCount",
    "productionTrafficRequestCount",
    "publicProbeRequestCount",
  ]) {
    requireEqual(facts[name], 0, `${label} ${name}`);
  }
  const { evidenceSha256, ...proof } = facts;
  requireEqual(
    evidenceSha256,
    sha256Canonical(proof),
    `${label} no-mutation canonical digest`,
  );
}

function buildAggregate(packets) {
  const packetDigests = packets.map((packet) => packet.packetSha256);
  return {
    phaseCount: JSON_COMPATIBILITY_PHASE_IDS.length,
    shardCount: EXPECTED_SHARD_COUNT,
    observationCount: JSON_COMPATIBILITY_PHASE_IDS.length * EXPECTED_SHARD_COUNT,
    controllerVersionCount: 1,
    runtimeBuildCount: 2,
    packetSetSha256: sha256Canonical(packetDigests),
    protobufAttemptCount: sumBy(
      packets,
      (packet) => packet.transportTotals.protobufAttemptCount,
    ),
    legacyJsonFallbackCount: sumBy(
      packets,
      (packet) => packet.transportTotals.legacyJsonFallbackCount,
    ),
    providerRequestCount: sumBy(
      packets,
      (packet) => packet.noMutationFacts.providerRequestCount,
    ),
    billingMutationCount: sumBy(
      packets,
      (packet) => packet.noMutationFacts.billingMutationCount,
    ),
    storageGatewayMutationCount: sumBy(
      packets,
      (packet) => packet.noMutationFacts.storageGatewayMutationCount,
    ),
    productionTrafficRequestCount: sumBy(
      packets,
      (packet) => packet.noMutationFacts.productionTrafficRequestCount,
    ),
    publicProbeRequestCount: sumBy(
      packets,
      (packet) => packet.noMutationFacts.publicProbeRequestCount,
    ),
    allShardsObserved: true,
    jsonByteCompatibilityPassed: true,
    rollbackLedgerConverged: packets.at(-1).activity.ledgerConverged,
  };
}

function expectedRuntimeForShard(topology, shardIndex) {
  const override = topology.overrides.find((entry) => entry.shardIndex === shardIndex);
  return override?.runtime ?? topology.defaultRuntime;
}

function runtimeForGeneration(runtimes, generation) {
  if (generation === "n") return runtimes.n;
  if (generation === "n-minus-one") return runtimes.nMinusOne;
  throw new JsonCompatibilityCampaignError(
    "[phase-source] runtime generation is unsupported",
  );
}

function countBy(values, predicate) {
  let count = 0;
  for (const value of values) if (predicate(value)) count += 1;
  return count;
}

function sumBy(values, select) {
  let total = 0;
  for (const value of values) total += select(value);
  return total;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new JsonCompatibilityCampaignError(
      `${label} fields must be exactly ${wanted.join(", ")}`,
    );
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new JsonCompatibilityCampaignError(`${label} does not match the approved value`);
  }
  return actual;
}

function requireCanonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new JsonCompatibilityCampaignError(`${label} does not match the approved plan`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function requireSafeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(
      `${label} must be a safe opaque token`,
    );
  }
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JsonCompatibilityCampaignError(
      `${label} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function requireBoundedText(value, maximumBytes, label) {
  if (typeof value !== "string") {
    throw new JsonCompatibilityCampaignError(`${label} must be UTF-8 text`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new JsonCompatibilityCampaignError(
      `${label} exceeds the ${maximumBytes}-byte limit`,
    );
  }
  return value;
}

function parseWholeSecondUtc(value, label) {
  if (typeof value !== "string" || !WHOLE_SECOND_UTC_PATTERN.test(value)) {
    throw new JsonCompatibilityCampaignError(`${label} must be whole-second UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new JsonCompatibilityCampaignError(`${label} must be a valid timestamp`);
  }
  return milliseconds;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
