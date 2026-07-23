#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOUNDATION_CAPTURE_CONTRACT,
  FOUNDATION_COLLECTOR_VERSION,
  canonicalJson,
  p5CandidateDigestSha256,
  validateFoundationReadback,
  validateP5Candidate,
} from "./relay_container_p5_evidence_contract.mjs";
import {
  CLOUDFLARE_READBACK_REQUEST_KEYS,
  assertReadOnlyCloudflareRequest,
  buildCloudflareReadbackPlan,
  executeCloudflareReadback,
  sha256,
} from "./lib/cloudflare_readback.mjs";
import {
  SHARD_REGISTRY_CAPTURE_CONTRACT,
  sha256Canonical,
  validateShardRegistryCapture,
} from "./lib/relay_container_shard_registry.mjs";

export const FOUNDATION_REQUEST_CONTRACT =
  "cinatoken-relay-container-p5-foundation-request-v1";
export const FOUNDATION_SOURCES_CONTRACT =
  "cinatoken-relay-container-p5-foundation-sources-v3";
export const REPLACEMENT_TOKEN_ENV = "CINATOKEN_P5_READBACK_TOKEN";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FOUNDATION_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const minObservationSeconds = 5 * 60;
const maxObservationSeconds = 2 * 60 * 60;
const sourceClockSkewMs = 60_000;
const accountIdPattern = /^[0-9a-f]{32}$/;
const kvIdPattern = /^[0-9a-f]{32}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/;
const collectorVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export class P5FoundationCollectorError extends Error {}

if (import.meta.main) {
  let jsonRequested = false;
  try {
    const options = parseCliArgs(process.argv.slice(2));
    jsonRequested = true;
    let report;
    if (options.mode === "self-test") {
      report = await runSelfTest();
    } else {
      const requestFile = await readCanonicalJsonFile(
        options.requestPath,
        "foundation request",
      );
      const request = validateFoundationRequest(requestFile.value);
      const requestDigestSha256 = digestCanonical(request);
      if (options.mode === "dry-run") {
        report = await buildFoundationDryRun({
          request,
          requestDigestSha256,
          sourceBundleProvided: options.sourceBundlePath !== null,
        });
      } else {
        requireLiveConfirmations(options);
        const apiToken = requireReplacementToken(process.env[REPLACEMENT_TOKEN_ENV]);
        report = await collectP5Foundation({
          request,
          requestDigestSha256,
          sourceBundlePath: options.sourceBundlePath,
          apiToken,
        });
        if (!report.subject.foundationEvidenceReady) process.exitCode = 1;
      }
    }
    console.log(canonicalJson(report));
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      contract: FOUNDATION_CAPTURE_CONTRACT,
      ok: false,
      decision: "not-proven",
      p5Eligible: false,
      productionEligible: false,
      customerTrafficEligible: false,
      error:
        error instanceof Error ? error.message : "foundation collection failed",
    };
    if (jsonRequested) console.error(canonicalJson(failure));
    else console.error(failure.error);
    process.exitCode = 1;
  }
}

export function parseCliArgs(argv) {
  let requestPath = null;
  let sourceBundlePath = null;
  let dryRun = false;
  let selfTest = false;
  const confirmations = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage(0);
    if (argument === "--dry-run") {
      if (dryRun) throw new P5FoundationCollectorError("--dry-run must not be repeated");
      dryRun = true;
      continue;
    }
    if (argument === "--self-test") {
      if (selfTest) throw new P5FoundationCollectorError("--self-test must not be repeated");
      selfTest = true;
      continue;
    }
    if ([
      "--confirm-staging-readback",
      "--confirm-replacement-token",
      "--confirm-observation-window",
    ].includes(argument)) {
      if (confirmations.has(argument)) {
        throw new P5FoundationCollectorError(`${argument} must not be repeated`);
      }
      confirmations.add(argument);
      continue;
    }
    if (argument !== "--request" && argument !== "--source-bundle") {
      throw new P5FoundationCollectorError(`[input] unknown option: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new P5FoundationCollectorError(`${argument} requires a path`);
    }
    if (argument === "--request") {
      if (requestPath !== null) throw new P5FoundationCollectorError("--request must not be repeated");
      requestPath = value;
    } else {
      if (sourceBundlePath !== null) {
        throw new P5FoundationCollectorError("--source-bundle must not be repeated");
      }
      sourceBundlePath = value;
    }
  }
  if (selfTest) {
    if (argv.length !== 1) {
      throw new P5FoundationCollectorError("--self-test does not accept other options");
    }
    return { mode: "self-test" };
  }
  if (requestPath === null) throw new P5FoundationCollectorError("--request is required");
  if (dryRun && confirmations.size > 0) {
    throw new P5FoundationCollectorError("dry-run does not accept live confirmations");
  }
  return {
    mode: dryRun ? "dry-run" : "live",
    requestPath,
    sourceBundlePath,
    confirmations,
  };
}

export function validateFoundationRequest(value) {
  const request = requireObject(value, "foundation request");
  exactKeys(
    request,
    [
      "schemaVersion",
      "contract",
      "environment",
      "observationSeconds",
      "accountId",
      "configKvNamespaceId",
      "containerApplicationId",
      "candidate",
    ],
    "foundation request",
  );
  requireExact(request.schemaVersion, 1, "request schemaVersion");
  requireExact(request.contract, FOUNDATION_REQUEST_CONTRACT, "request contract");
  requireExact(request.environment, "staging", "request environment");
  requireToken(request.accountId, accountIdPattern, "request accountId");
  requireToken(
    request.configKvNamespaceId,
    kvIdPattern,
    "request configKvNamespaceId",
  );
  requireToken(
    request.containerApplicationId,
    opaqueIdPattern,
    "request containerApplicationId",
  );
  requireInteger(
    request.observationSeconds,
    minObservationSeconds,
    maxObservationSeconds,
    "request observationSeconds",
  );
  const candidate = validateP5Candidate(request.candidate);
  requireExact(
    candidate.controllerServiceName,
    "cinatoken-container-controller-staging",
    "candidate Controller service",
  );
  requireExact(
    candidate.providerEgressServiceName,
    "cinatoken-container-egress-staging",
    "candidate provider-egress service",
  );
  requireExact(
    candidate.d1DatabaseName,
    "cinatoken-rust-db-staging",
    "candidate D1 name",
  );
  requireExact(
    candidate.r2BucketName,
    "cinatoken-rust-files-staging",
    "candidate R2 bucket",
  );
  requireExact(
    sha256(request.configKvNamespaceId),
    candidate.configKvNamespaceIdSha256,
    "candidate CONFIG_KV namespace digest",
  );
  assertNoCredentialValues(request, "foundation request");
  return { ...request, candidate };
}

export function validateFoundationSources(value, candidateDigestSha256, candidate) {
  const bundle = requireObject(value, "foundation sources");
  exactKeys(
    bundle,
    [
      "schemaVersion",
      "contract",
      "environment",
      "candidateDigestSha256",
      "capturedAt",
      "accountIdSha256",
      "paginationComplete",
      "sources",
    ],
    "foundation sources",
  );
  requireExact(bundle.schemaVersion, 3, "source schemaVersion");
  requireExact(bundle.contract, FOUNDATION_SOURCES_CONTRACT, "source contract");
  requireExact(bundle.environment, "staging", "source environment");
  requireExact(
    bundle.candidateDigestSha256,
    candidateDigestSha256,
    "source candidate digest",
  );
  requireTimestamp(bundle.capturedAt, "source capturedAt");
  requireSha256(bundle.accountIdSha256, "source account ID digest");
  requireBoolean(bundle.paginationComplete, "source paginationComplete");
  const sources = requireObject(bundle.sources, "foundation source inventory");
  exactKeys(
    sources,
    ["actionGates", "sbom", "shardRegistry", "r2Inventory", "traffic"],
    "foundation source inventory",
  );
  validateActionGates(sources.actionGates);
  validateSbom(sources.sbom);
  validateShardRegistry(sources.shardRegistry, candidate);
  validateR2Inventory(sources.r2Inventory);
  validateTraffic(sources.traffic);
  assertNoCredentialValues(bundle, "foundation sources");
  return { ...bundle, sources };
}

export async function buildFoundationDryRun({
  request,
  requestDigestSha256 = digestCanonical(request),
  sourceBundleProvided = false,
  dependencies = {},
}) {
  request = validateFoundationRequest(request);
  requireExact(
    requestDigestSha256,
    digestCanonical(request),
    "request digest",
  );
  const plan = buildCloudflareReadbackPlan(request);
  const foundationCollectorSha256 =
    dependencies.collectorArtifactDigest ?? (await collectorArtifactDigest());
  return {
    schemaVersion: 1,
    contract: FOUNDATION_CAPTURE_CONTRACT,
    mode: "dry-run",
    ok: true,
    decision: "not-proven",
    p5Eligible: false,
    productionEligible: false,
    customerTrafficEligible: false,
    environment: "staging",
    requestDigestSha256,
    candidateDigestSha256: p5CandidateDigestSha256(request.candidate),
    foundationCollectorVersion: FOUNDATION_COLLECTOR_VERSION,
    foundationCollectorSha256,
    sourceBundleProvided,
    observationSeconds: request.observationSeconds,
    requestKeys: plan.plan.map((item) => item.key),
    safetyBoundary: safetyBoundary({
      credentialsRead: false,
      networkReadbackPerformed: false,
    }),
  };
}

export async function collectP5Foundation(
  {
    request,
    requestDigestSha256 = digestCanonical(request),
    sourceBundlePath = null,
    sourceBundle = undefined,
    apiToken,
  },
  dependencies = {},
) {
  request = validateFoundationRequest(request);
  requireExact(
    requestDigestSha256,
    digestCanonical(request),
    "request digest",
  );
  const candidateDigestSha256 = p5CandidateDigestSha256(request.candidate);
  const plan = buildCloudflareReadbackPlan(request);
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readback = dependencies.executeReadback ?? executeCloudflareReadback;
  const collectorDigestBefore =
    dependencies.collectorArtifactDigest ?? (await collectorArtifactDigest());
  const before = await readback(plan, {
    apiToken,
    fetchImpl: dependencies.fetchImpl,
  });
  validateFoundationReadback(before, "before");
  const observationStartedAt = canonicalTimestamp(now(), "observation start");
  await sleep(request.observationSeconds * 1000);
  const observationEndedAt = canonicalTimestamp(now(), "observation end");
  const after = await readback(plan, {
    apiToken,
    fetchImpl: dependencies.fetchImpl,
  });
  validateFoundationReadback(after, "after");
  const collectorDigestAfter =
    dependencies.collectorArtifactDigest ?? (await collectorArtifactDigest());
  const durationSeconds =
    (new Date(observationEndedAt).getTime() -
      new Date(observationStartedAt).getTime()) /
    1000;
  if (
    durationSeconds < minObservationSeconds ||
    durationSeconds > maxObservationSeconds
  ) {
    throw new P5FoundationCollectorError("observed foundation window is invalid");
  }

  let validatedSources = null;
  let sourceBundleDigestSha256 = null;
  if (sourceBundle !== undefined) {
    validatedSources = validateFoundationSources(
      sourceBundle,
      candidateDigestSha256,
      request.candidate,
    );
    sourceBundleDigestSha256 = digestCanonical(validatedSources);
  } else if (sourceBundlePath !== null) {
    const sourceFile = await (dependencies.readCanonicalFile ?? readCanonicalJsonFile)(
      sourceBundlePath,
      "foundation sources",
    );
    validatedSources = validateFoundationSources(
      sourceFile.value,
      candidateDigestSha256,
      request.candidate,
    );
    sourceBundleDigestSha256 = digestCanonical(validatedSources);
  }

  const blockers = collectBlockers({
    before,
    after,
    sources: validatedSources,
    request,
    observationStartedAt,
    observationEndedAt,
    collectorDigestBefore,
    collectorDigestAfter,
  });
  const foundationEvidenceReady = blockers.length === 0;
  const paginationComplete =
    before.paginationComplete === true &&
    after.paginationComplete === true &&
    validatedSources?.paginationComplete === true;
  const foundationCollectorSha256 = collectorDigestAfter;
  const artifactInventorySha256 = digestCanonical({
    candidateDigestSha256,
    beforeDigestSha256: before.digestSha256,
    afterDigestSha256: after.digestSha256,
    sourceBundleDigestSha256,
    foundationCollectorSha256,
  });
  const bindingBase = {
    foundationCaptureContract: FOUNDATION_CAPTURE_CONTRACT,
    foundationCollectorVersion: FOUNDATION_COLLECTOR_VERSION,
    foundationCollectorSha256,
    observationStartedAt,
    observationEndedAt,
    paginationComplete,
  };
  const evidenceFacts = foundationEvidenceReady
    ? buildEvidenceFacts({
      request,
      sources: validatedSources,
      artifactInventorySha256,
    })
    : null;
  const subject = {
    mode: "live-readback",
    environment: "staging",
    decision: "not-proven",
    p5Eligible: false,
    productionEligible: false,
    customerTrafficEligible: false,
    foundationEvidenceReady,
    requestDigestSha256,
    candidateDigestSha256,
    candidate: request.candidate,
    observationStartedAt,
    observationEndedAt,
    observationSeconds: Math.floor(durationSeconds),
    paginationComplete,
    readbackStable: before.digestSha256 === after.digestSha256,
    before: publicReadback(before),
    after: publicReadback(after),
    sourceBundleDigestSha256,
    sources: publicSources(validatedSources),
    artifactInventorySha256,
    blockers,
    evidenceFacts,
    safetyBoundary: safetyBoundary({
      credentialsRead: true,
      networkReadbackPerformed: true,
    }),
  };
  const foundationCaptureSha256 = digestCanonical(subject);
  const binding = {
    ...bindingBase,
    foundationCaptureSha256,
  };
  const report = {
    schemaVersion: 1,
    contract: FOUNDATION_CAPTURE_CONTRACT,
    foundationCollectorVersion: FOUNDATION_COLLECTOR_VERSION,
    foundationCollectorSha256,
    foundationCaptureSha256,
    binding,
    subject,
  };
  const serialized = canonicalJson(report);
  for (const sensitive of [
    apiToken,
    request.accountId,
    request.configKvNamespaceId,
    request.containerApplicationId,
  ]) {
    if (typeof sensitive === "string" && serialized.includes(sensitive)) {
      throw new P5FoundationCollectorError("foundation capture contained a private input");
    }
  }
  return report;
}

export async function runSelfTest() {
  const request = validateFoundationRequest(selfTestRequest());
  const plan = buildCloudflareReadbackPlan(request);
  for (const item of plan.plan) assertReadOnlyCloudflareRequest(item);
  let rejectedMutation = false;
  try {
    assertReadOnlyCloudflareRequest({
      ...plan.plan[0],
      method: "POST",
    });
  } catch {
    rejectedMutation = true;
  }
  if (!rejectedMutation) {
    throw new P5FoundationCollectorError("self-test accepted a mutating API request");
  }
  const dryRun = await buildFoundationDryRun({
    request,
    dependencies: { collectorArtifactDigest: "f".repeat(64) },
  });
  if (
    dryRun.requestKeys.length !== CLOUDFLARE_READBACK_REQUEST_KEYS.length ||
    dryRun.p5Eligible !== false ||
    dryRun.safetyBoundary.credentialsRead !== false
  ) {
    throw new P5FoundationCollectorError("self-test dry-run contract failed");
  }
  return {
    schemaVersion: 1,
    contract: FOUNDATION_CAPTURE_CONTRACT,
    mode: "self-test",
    ok: true,
    decision: "not-proven",
    p5Eligible: false,
    productionEligible: false,
    customerTrafficEligible: false,
    requestCount: plan.plan.length,
    nonGetRequestRejected: true,
    credentialsRead: false,
    networkReadbackPerformed: false,
    writesFiles: false,
  };
}

function collectBlockers({
  before,
  after,
  sources,
  request,
  observationStartedAt,
  observationEndedAt,
  collectorDigestBefore,
  collectorDigestAfter,
}) {
  const blockers = [];
  if (collectorDigestBefore !== collectorDigestAfter) {
    blockers.push("collector-artifact-drift");
  }
  if (before.complete !== true) blockers.push("before-readback-incomplete");
  if (after.complete !== true) blockers.push("after-readback-incomplete");
  if (before.paginationComplete !== true || after.paginationComplete !== true) {
    blockers.push("cloudflare-pagination-not-proven");
  }
  if (before.stderrEmpty !== true || after.stderrEmpty !== true) {
    blockers.push("cloudflare-readback-diagnostics-not-empty");
  }
  if (before.digestSha256 !== after.digestSha256) {
    blockers.push("cloudflare-readback-drift");
  }
  if (sources === null) {
    blockers.push(
      "action-gate-source-absent",
      "r2-inventory-source-absent",
      "sbom-source-absent",
      "shard-registry-source-absent",
      "traffic-source-absent",
    );
    return blockers.sort();
  }
  if (sources.accountIdSha256 !== sha256(request.accountId)) {
    blockers.push("source-account-mismatch");
  }
  if (sources.paginationComplete !== true) blockers.push("source-pagination-not-proven");
  const capturedAt = new Date(sources.capturedAt).getTime();
  const startedAt = new Date(observationStartedAt).getTime();
  const endedAt = new Date(observationEndedAt).getTime();
  if (
    capturedAt < startedAt - sourceClockSkewMs ||
    capturedAt > endedAt + sourceClockSkewMs
  ) {
    blockers.push("source-capture-outside-observation-window");
  }
  for (const [name, source] of Object.entries(sources.sources)) {
    if (source.status !== "pass") blockers.push(`${name}-source-not-pass`);
  }
  const { actionGates, sbom, shardRegistry, r2Inventory, traffic } = sources.sources;
  const shardObservationStartedAt = new Date(
    shardRegistry.capture.observationStartedAt,
  ).getTime();
  const shardObservationEndedAt = new Date(
    shardRegistry.capture.observationEndedAt,
  ).getTime();
  if (
    shardObservationStartedAt > startedAt + sourceClockSkewMs ||
    shardObservationEndedAt < endedAt - sourceClockSkewMs
  ) {
    blockers.push("shard-registry-window-does-not-cover-foundation");
  }
  if (capturedAt < shardObservationEndedAt) {
    blockers.push("source-capture-precedes-shard-registry");
  }
  if (
    actionGates.controllerVersionId !==
    request.candidate.controllerWorkerVersionId
  ) {
    blockers.push("action-gates-controller-version-mismatch");
  }
  if (actionGates.allActionGatesFalse !== true) blockers.push("action-gates-not-false");
  if (
    actionGates.actionGateInventorySha256 !==
      shardRegistry.capture.campaign.actionGateInventorySha256 ||
    actionGates.actionGateCount !== shardRegistry.capture.campaign.actionGateCount ||
    actionGates.allActionGatesFalse !==
      shardRegistry.capture.campaign.allActionGatesFalse ||
    actionGates.controllerVersionId !==
      shardRegistry.capture.campaign.controllerVersionId
  ) {
    blockers.push("action-gates-campaign-mismatch");
  }
  if (
    sbom.containerImageDigest !== request.candidate.containerImageDigest ||
    sbom.containerRuntimeBuildId !== request.candidate.containerRuntimeBuildId ||
    sbom.containerImageProvenanceSha256 !==
      request.candidate.containerImageProvenanceSha256 ||
    sbom.containerSbomSha256 !== request.candidate.containerSbomSha256
  ) {
    blockers.push("sbom-candidate-mismatch");
  }
  if (
    sbom.containerSignatureVerified !== true ||
    sbom.runtimeImageProvenanceVerified !== true ||
    sbom.unapprovedCriticalVulnerabilities !== 0 ||
    sbom.unapprovedHighVulnerabilities !== 0
  ) {
    blockers.push("sbom-security-not-proven");
  }
  if (
    shardRegistry.doNamespaceIdSha256 !== request.candidate.doNamespaceIdSha256 ||
    shardRegistry.capture.candidate.controllerVersionId !==
      request.candidate.controllerWorkerVersionId ||
    shardRegistry.capture.candidate.runtimeBuildId !==
      request.candidate.containerRuntimeBuildId ||
    shardRegistry.capture.candidate.containerImageDigest !==
      request.candidate.containerImageDigest ||
    shardRegistry.capture.candidate.imageProvenanceSha256 !==
      request.candidate.containerImageProvenanceSha256 ||
    shardRegistry.capture.candidate.ringGeneration !== request.candidate.ringGeneration ||
    shardRegistry.capture.candidate.shardCount !== request.candidate.shardCount ||
    shardRegistry.capture.verifiedShardCount !== request.candidate.shardCount ||
    shardRegistry.capture.evidenceReady !== true
  ) {
    blockers.push("shard-registry-incomplete");
  }
  if (r2Inventory.unknownWriterCount !== 0) blockers.push("unknown-r2-writers");
  if (r2Inventory.unknownObjectCount !== 0) blockers.push("unknown-r2-objects");
  if (traffic.customerTrafficCount !== 0) blockers.push("customer-traffic-present");
  if (traffic.environmentIsolationVerified !== true) {
    blockers.push("environment-isolation-not-proven");
  }
  return [...new Set(blockers)].sort();
}

function buildEvidenceFacts({ request, sources, artifactInventorySha256 }) {
  const { actionGates, sbom, shardRegistry, r2Inventory, traffic } = sources.sources;
  const shardActivationCampaign = campaignEvidenceFromCapture(
    shardRegistry.capture,
  );
  return {
    candidateFreeze: {
      repositoryCommit: request.candidate.commitSha,
      goSourceCommit: request.candidate.goSourceCommit,
      vibeSourceCommit: request.candidate.vibeSourceCommit,
      edgeWorkerVersionId: request.candidate.edgeWorkerVersionId,
      controllerWorkerVersionId: request.candidate.controllerWorkerVersionId,
      providerEgressWorkerVersionId: request.candidate.providerEgressWorkerVersionId,
      containerImageDigest: request.candidate.containerImageDigest,
      containerRuntimeBuildId: request.candidate.containerRuntimeBuildId,
      containerImageProvenanceSha256:
        request.candidate.containerImageProvenanceSha256,
      containerSbomSha256: request.candidate.containerSbomSha256,
      containerSignatureVerified: sbom.containerSignatureVerified,
      runtimeImageProvenanceVerified:
        sbom.runtimeImageProvenanceVerified,
      unapprovedCriticalVulnerabilities: sbom.unapprovedCriticalVulnerabilities,
      unapprovedHighVulnerabilities: sbom.unapprovedHighVulnerabilities,
      allActionGatesFalse: actionGates.allActionGatesFalse,
      shardActivationCampaign,
      artifactInventorySha256,
    },
    remoteInventory: {
      accountIdSha256: sources.accountIdSha256,
      d1DatabaseName: request.candidate.d1DatabaseName,
      d1DatabaseId: request.candidate.d1DatabaseId,
      r2BucketName: request.candidate.r2BucketName,
      configKvNamespaceIdSha256: request.candidate.configKvNamespaceIdSha256,
      controllerServiceName: request.candidate.controllerServiceName,
      providerEgressServiceName: request.candidate.providerEgressServiceName,
      doNamespaceIdSha256: shardRegistry.doNamespaceIdSha256,
      doBinding: request.candidate.doBinding,
      doClass: request.candidate.doClass,
      containerClass: request.candidate.containerClass,
      containerRuntimeBuildId:
        shardRegistry.capture.candidate.runtimeBuildId,
      containerImageProvenanceSha256:
        shardRegistry.capture.candidate.imageProvenanceSha256,
      ringGeneration: request.candidate.ringGeneration,
      shardCount: request.candidate.shardCount,
      verifiedShardCount: shardRegistry.capture.verifiedShardCount,
      shardActivationCampaign,
      unknownWriterCount: r2Inventory.unknownWriterCount,
      unknownObjectCount: r2Inventory.unknownObjectCount,
      customerTrafficCount: traffic.customerTrafficCount,
      environmentIsolationVerified: traffic.environmentIsolationVerified,
    },
  };
}

function campaignEvidenceFromCapture(capture) {
  const campaign = capture.campaign;
  return {
    campaignContract: campaign.campaignContract,
    state: campaign.state,
    campaignId: campaign.campaignId,
    campaignDigestSha256: campaign.campaignDigestSha256,
    controllerVersionId: campaign.controllerVersionId,
    actionGateInventorySha256: campaign.actionGateInventorySha256,
    actionGateCount: campaign.actionGateCount,
    allActionGatesFalse: campaign.allActionGatesFalse,
    foundationManifestSha256: campaign.foundationManifestSha256,
    runtimeBuildId: campaign.runtimeBuildId,
    ringGeneration: campaign.ringGeneration,
    shardCount: campaign.shardCount,
    shardContractVersion: campaign.shardContractVersion,
    runtimeProtocolVersion: campaign.runtimeProtocolVersion,
    runtimeContractVersion: campaign.runtimeContractVersion,
    activationGeneration: campaign.activationGeneration,
    environment: campaign.environment,
    claimedShardCount: campaign.claimedShardCount,
    consumedShardCount: campaign.consumedShardCount,
    sealReason: campaign.sealReason,
    sealDetailCode: campaign.sealDetailCode,
    lastConsumptionDigestSha256: campaign.lastConsumptionDigestSha256,
    sealedAt: campaign.sealedAt,
    receiptCount: campaign.receiptCount,
    receiptSetSha256: campaign.receiptSetSha256,
  };
}

function publicReadback(readback) {
  return {
    digestSha256: readback.digestSha256,
    complete: readback.complete,
    paginationComplete: readback.paginationComplete,
    stderrEmpty: readback.stderrEmpty,
    commands: readback.commands,
  };
}

function publicSources(bundle) {
  if (bundle === null) {
    return {
      status: "absent",
      paginationComplete: false,
      actionGates: "unknown",
      r2Inventory: "unknown",
      sbom: "unknown",
      shardRegistry: "unknown",
      traffic: "unknown",
    };
  }
  return {
    status: "provided",
    capturedAt: bundle.capturedAt,
    paginationComplete: bundle.paginationComplete,
    actionGates: bundle.sources.actionGates.status,
    r2Inventory: bundle.sources.r2Inventory.status,
    sbom: bundle.sources.sbom.status,
    shardRegistry: bundle.sources.shardRegistry.status,
    traffic: bundle.sources.traffic.status,
  };
}

function validateActionGates(value) {
  validateSourceBase(value, "actionGates", [
    "controllerVersionId",
    "actionGateInventorySha256",
    "actionGateCount",
    "allActionGatesFalse",
  ]);
  requireToken(
    value.controllerVersionId,
    opaqueIdPattern,
    "actionGates Controller version ID",
  );
  requireSha256(
    value.actionGateInventorySha256,
    "actionGates inventory digest",
  );
  requireExact(value.actionGateCount, 22, "actionGates inventory count");
  requireBoolean(value.allActionGatesFalse, "actionGates allActionGatesFalse");
  validateSourceRecordDigest(value, "actionGates");
}

function validateSbom(value) {
  validateSourceBase(value, "sbom", [
    "containerImageDigest",
    "containerRuntimeBuildId",
    "containerImageProvenanceSha256",
    "containerSbomSha256",
    "containerSignatureVerified",
    "runtimeImageProvenanceVerified",
    "unapprovedCriticalVulnerabilities",
    "unapprovedHighVulnerabilities",
  ]);
  requireToken(value.containerImageDigest, /^sha256:[0-9a-f]{64}$/, "SBOM image digest");
  requireSha256(value.containerRuntimeBuildId, "SBOM runtime build ID");
  requireSha256(value.containerImageProvenanceSha256, "SBOM image provenance digest");
  requireSha256(value.containerSbomSha256, "SBOM digest");
  requireBoolean(value.containerSignatureVerified, "SBOM signature status");
  requireBoolean(
    value.runtimeImageProvenanceVerified,
    "SBOM runtime/image provenance status",
  );
  requireInteger(value.unapprovedCriticalVulnerabilities, 0, 1_000_000, "SBOM critical count");
  requireInteger(value.unapprovedHighVulnerabilities, 0, 1_000_000, "SBOM high count");
  validateSourceRecordDigest(value, "sbom");
}

function validateShardRegistry(value, candidate) {
  validateSourceBase(value, "shardRegistry", [
    "doNamespaceIdSha256",
    "capture",
  ]);
  requireSha256(value.doNamespaceIdSha256, "shard registry namespace digest");
  if (candidate === undefined) {
    throw new P5FoundationCollectorError("shard registry P5 candidate is required");
  }
  const capture = validateShardRegistryCapture(value.capture, {
    controllerVersionId: candidate.controllerWorkerVersionId,
    runtimeBuildId: candidate.containerRuntimeBuildId,
    containerImageDigest: candidate.containerImageDigest,
    imageProvenanceSha256: candidate.containerImageProvenanceSha256,
    ringGeneration: candidate.ringGeneration,
    shardCount: candidate.shardCount,
  });
  requireExact(
    value.sourceArtifactSha256,
    sha256Canonical(capture),
    "shard registry source artifact digest",
  );
  requireExact(capture.contract, SHARD_REGISTRY_CAPTURE_CONTRACT, "shard registry capture contract");
  if (value.status === "pass") requireExact(capture.evidenceReady, true, "shard registry readiness");
}

function validateR2Inventory(value) {
  validateSourceBase(value, "r2Inventory", ["unknownWriterCount", "unknownObjectCount"]);
  requireInteger(value.unknownWriterCount, 0, Number.MAX_SAFE_INTEGER, "R2 unknown writer count");
  requireInteger(value.unknownObjectCount, 0, Number.MAX_SAFE_INTEGER, "R2 unknown object count");
  validateSourceRecordDigest(value, "r2Inventory");
}

function validateTraffic(value) {
  validateSourceBase(value, "traffic", ["customerTrafficCount", "environmentIsolationVerified"]);
  requireInteger(value.customerTrafficCount, 0, Number.MAX_SAFE_INTEGER, "traffic count");
  requireBoolean(value.environmentIsolationVerified, "traffic isolation status");
  validateSourceRecordDigest(value, "traffic");
}

function validateSourceRecordDigest(source, label) {
  const digestInput = { ...source };
  delete digestInput.sourceArtifactSha256;
  requireExact(
    source.sourceArtifactSha256,
    sha256Canonical(digestInput),
    `${label} source artifact digest`,
  );
}

function validateSourceBase(value, label, extraKeys) {
  const source = requireObject(value, `${label} source`);
  exactKeys(
    source,
    [
      "status",
      "collectorId",
      "collectorVersion",
      "sourceArtifactSha256",
      ...extraKeys,
    ],
    `${label} source`,
  );
  requireEnum(source.status, ["pass", "fail", "unknown"], `${label} status`);
  requireToken(source.collectorId, opaqueIdPattern, `${label} collectorId`);
  requireToken(
    source.collectorVersion,
    collectorVersionPattern,
    `${label} collectorVersion`,
  );
  requireSha256(source.sourceArtifactSha256, `${label} source artifact digest`);
}

async function collectorArtifactDigest() {
  const files = [
    path.join(repoRoot, "tools", "collect_relay_container_p5_foundation.mjs"),
    path.join(
      repoRoot,
      "tools",
      "collect_relay_container_p5_shard_registry.mjs",
    ),
    path.join(repoRoot, "tools", "lib", "cloudflare_readback.mjs"),
    path.join(
      repoRoot,
      "tools",
      "lib",
      "relay_container_shard_registry.mjs",
    ),
    path.join(repoRoot, "tools", "relay_container_p5_evidence_contract.mjs"),
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "bun.lock"),
  ];
  const artifacts = [];
  for (const file of files) {
    const bytes = await readFile(file);
    artifacts.push({
      path: path.relative(repoRoot, file).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return digestCanonical(artifacts);
}

async function readCanonicalJsonFile(file, label) {
  if (typeof file !== "string" || file.length === 0) {
    throw new P5FoundationCollectorError(`${label} path is required`);
  }
  const resolved = path.resolve(file);
  const initial = await lstat(resolved, { bigint: true }).catch(() => null);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size <= 0n ||
    initial.size > BigInt(FOUNDATION_MAX_INPUT_BYTES)
  ) {
    throw new P5FoundationCollectorError(`${label} must be a bounded regular single-link file`);
  }
  const handle = await open(resolved, "r").catch(() => null);
  if (!handle) throw new P5FoundationCollectorError(`${label} could not be opened`);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameSnapshot(initial, opened)) {
      throw new P5FoundationCollectorError(`${label} changed before read`);
    }
    const actualPath = await realpath(resolved);
    if (!samePath(resolved, actualPath)) {
      throw new P5FoundationCollectorError(`${label} must not traverse a symbolic link`);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new P5FoundationCollectorError(`${label} changed while read`);
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(opened, after)) {
      throw new P5FoundationCollectorError(`${label} changed while read`);
    }
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new P5FoundationCollectorError(`${label} must be valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new P5FoundationCollectorError(`${label} must be valid JSON`);
  }
  const expected = `${canonicalJson(value)}\n`;
  if (text !== expected) {
    throw new P5FoundationCollectorError(`${label} must use canonical JSON plus one newline`);
  }
  return { value, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function safetyBoundary({ credentialsRead, networkReadbackPerformed }) {
  return {
    credentialsRead,
    credentialValuesEmitted: false,
    customerTrafficEligible: false,
    deployOrRollbackExecuted: false,
    networkReadbackPerformed,
    p5Eligible: false,
    productionEligible: false,
    providerRequestPerformed: false,
    remoteMutationPerformed: false,
    shellExecuted: false,
    sshOrContainerWakeExecuted: false,
    writesFiles: false,
  };
}

function requireLiveConfirmations(options) {
  for (const flag of [
    "--confirm-staging-readback",
    "--confirm-replacement-token",
    "--confirm-observation-window",
  ]) {
    if (!options.confirmations.has(flag)) {
      throw new P5FoundationCollectorError(`live collection requires ${flag}`);
    }
  }
}

function requireReplacementToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 4096 ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new P5FoundationCollectorError(
      `${REPLACEMENT_TOKEN_ENV} must contain a rotated replacement token`,
    );
  }
  return value;
}

function usage(exitCode) {
  console.error(
    [
      "Usage:",
      "  bun tools/collect_relay_container_p5_foundation.mjs --request <canonical.json> --dry-run [--source-bundle <canonical.json>]",
      "  bun tools/collect_relay_container_p5_foundation.mjs --request <canonical.json> [--source-bundle <canonical.json>] --confirm-staging-readback --confirm-replacement-token --confirm-observation-window",
      "  bun tools/collect_relay_container_p5_foundation.mjs --self-test",
      "",
      `Live mode reads only ${REPLACEMENT_TOKEN_ENV} and injects it only into in-memory Cloudflare API Authorization headers.`,
      "The command is staging-only, performs fixed read-only HTTPS GET requests, writes no files, and never authorizes P5 or production traffic.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function selfTestRequest() {
  const configKvNamespaceId = "a".repeat(32);
  return {
    schemaVersion: 1,
    contract: FOUNDATION_REQUEST_CONTRACT,
    environment: "staging",
    observationSeconds: 300,
    accountId: "b".repeat(32),
    configKvNamespaceId,
    containerApplicationId: "container-app-staging-001",
    candidate: {
      repository: "cinagroup/cinatoken-rust",
      commitSha: "404ae9ad3d217194922692b585c967fe2ba2a086",
      goSourceCommit: "73652508abc5cb09214dde02d51d69d1d1ccc703",
      vibeSourceCommit: "918e97480ee44e357abe99bf33c27259d6ac7ebd",
      edgeWorkerVersionId: "edge-version-001",
      controllerWorkerVersionId: "controller-version-001",
      providerEgressWorkerVersionId: "egress-version-001",
      containerImageDigest: `sha256:${"4".repeat(64)}`,
      containerRuntimeBuildId: "a".repeat(64),
      containerImageProvenanceSha256: "b".repeat(64),
      containerSbomSha256: "5".repeat(64),
      d1DatabaseName: "cinatoken-rust-db-staging",
      d1DatabaseId: "c285553f-7f98-4ec2-b4d6-f84a3b409f3e",
      r2BucketName: "cinatoken-rust-files-staging",
      configKvNamespaceIdSha256: sha256(configKvNamespaceId),
      controllerServiceName: "cinatoken-container-controller-staging",
      providerEgressServiceName: "cinatoken-container-egress-staging",
      doNamespaceIdSha256: "7".repeat(64),
      doBinding: "RELAY_SHARDS",
      doClass: "RelayShardContainer",
      containerClass: "RelayShardContainer",
      ringGeneration: 1,
      shardCount: 8,
      migrationHead: "0060_relay_container_ring_transition_authority.sql",
      migrationCount: 60,
      responseProtocolVersion: 3,
      statusContractVersion: 4,
      financialTerminalContractVersion: 2,
      terminalAckContractVersion: 3,
    },
  };
}

function digestCanonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalTimestamp(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new P5FoundationCollectorError(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") throw new P5FoundationCollectorError(`${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new P5FoundationCollectorError(`${label} is invalid`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new P5FoundationCollectorError(`${label} has unknown or missing fields`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new P5FoundationCollectorError(`${label} must be an object`);
  }
  return value;
}

function requireToken(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new P5FoundationCollectorError(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  return requireToken(value, sha256Pattern, label);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new P5FoundationCollectorError(`${label} is out of range`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new P5FoundationCollectorError(`${label} is invalid`);
  return value;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new P5FoundationCollectorError(`${label} is invalid`);
  return value;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) throw new P5FoundationCollectorError(`${label} mismatch`);
  return actual;
}

function assertNoCredentialValues(root, label) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (
        /^Bearer\s+/i.test(value) ||
        /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----$/.test(value) ||
        /^(?:sk|rk)-[A-Za-z0-9_-]{16,}$/.test(value) ||
        /^(?:cfut_|ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}$/.test(value) ||
        /^AKIA[0-9A-Z]{16}$/.test(value) ||
        /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
      ) {
        throw new P5FoundationCollectorError(`${label} contains a credential-shaped value`);
      }
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (value && typeof value === "object") {
      stack.push(...Object.values(value));
    }
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
