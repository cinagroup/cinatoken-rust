import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  jsonCompatibilityPermitSigningPayload,
} from "../services/container-runtime-json-compatibility-executor/src/authorization.ts";
import {
  executeJsonCompatibilityPhase,
} from "../services/container-runtime-json-compatibility-executor/src/executor.ts";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
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
const permitKeyPair = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);
const permitSpki = new Uint8Array(
  await crypto.subtle.exportKey("spki", permitKeyPair.publicKey),
);
const permitSpkiBase64url = Buffer.from(permitSpki).toString("base64url");
const permitSpkiSha256 = await sha256Hex(permitSpki);
const permitIssuer = "cinatoken-json-compatibility-permit-issuer-staging";
const permitAudience =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const permitKeyId = "phase-source-test-key";

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

class CampaignAuthorityBinding {
  getByName() {
    return {
      async beginPhase(input) {
        const receiptSubject = {
          schemaVersion: 1,
          contract:
            "cinatoken-container-runtime-json-compatibility-campaign-lease-receipt-v1",
          status: "phase_lease_acquired",
          campaignIdSha256: input.campaignIdSha256,
          campaignBindingSha256: input.campaignBindingSha256,
          planDigestSha256: input.planDigestSha256,
          permitIdSha256: input.permitIdSha256,
          permitSubjectSha256: input.permitSubjectSha256,
          permitEnvelopeSha256: input.permitEnvelopeSha256,
          phaseOrdinal: input.phaseOrdinal,
          phaseId: input.phaseId,
          phaseExecutionId: input.phaseExecutionId,
          leaseIdSha256: input.leaseIdSha256,
          executorVersionId: input.executorVersionId,
          acquiredAt: input.acquiredAt,
          permitExpiresAt: input.permitExpiresAt,
          singleUsePermitPersisted: true,
          phaseOrderEnforced: true,
          concurrentPhaseRejected: true,
        };
        return {
          ok: true,
          receipt: {
            ...receiptSubject,
            leaseReceiptSha256: sha256Canonical(receiptSubject),
          },
        };
      },
      async completePhase(input) {
        return {
          ok: true,
          status: input.phaseOrdinal === 4
            ? "campaign_completed"
            : "phase_completed",
        };
      },
      async failPhase() {
        return { ok: true, status: "campaign_failed" };
      },
    };
  }
}

async function buildReceipt(plan, phaseIndex) {
  const phase = plan.phases[phaseIndex];
  const nowMs = Date.parse(`2026-08-04T00:0${phaseIndex * 2}:00Z`);
  const request = {
    schemaVersion: 2,
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
  };
  const nowSeconds = Math.floor(nowMs / 1000);
  const permitSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    issuer: permitIssuer,
    audience: permitAudience,
    keyId: permitKeyId,
    permitIdSha256: sha256Canonical({ phaseIndex, kind: "phase-permit" }),
    campaignIdSha256: request.campaignIdSha256,
    planDigestSha256: request.planDigestSha256,
    phaseExecutionId: request.phaseExecutionId,
    controller: request.controller,
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      versionId: "executor-version-001",
    },
    runtimes: request.runtimes,
    ring: request.ring,
    phase: request.phase,
    issuedAt: nowSeconds - 10,
    notBefore: nowSeconds - 5,
    expiresAt: nowSeconds + 300,
  };
  const authorization = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject: permitSubject,
    subjectSha256: sha256Canonical(permitSubject),
    signatureBase64url: "",
  };
  authorization.signatureBase64url = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      permitKeyPair.privateKey,
      jsonCompatibilityPermitSigningPayload(authorization),
    ),
  ).toString("base64url");
  return executeJsonCompatibilityPhase(
    {
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_EXECUTOR_ENABLED: "true",
      CF_VERSION_METADATA: { id: "executor-version-001" },
      CONTAINER_CONTROLLER_JSON_PROBE: new ProbeBinding(),
      JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY: new CampaignAuthorityBinding(),
      JSON_COMPATIBILITY_PERMIT_ISSUER: permitIssuer,
      JSON_COMPATIBILITY_PERMIT_AUDIENCE: permitAudience,
      JSON_COMPATIBILITY_PERMIT_KEY_ID: permitKeyId,
      JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: permitSpkiSha256,
      JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: permitSpkiBase64url,
    },
    { ...request, authorization },
    deterministicRuntime(nowMs),
  );
}

async function buildPrivateInvocationReceipt(plan, executorReceipt, phaseIndex) {
  const invokerVersionId = "invoker-version-001";
  const issuerVersionId = "permit-issuer-version-001";
  const startedAt = executorReceipt.startedAt;
  const completedAt = executorReceipt.completedAt;
  const startedAtSeconds = Math.floor(Date.parse(startedAt) / 1000);
  const permit = executorReceipt.authorization.permitEnvelope;
  const commandIdSha256 = sha256Canonical({ phaseIndex, kind: "invoke-command" });
  const issueIntent = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issue-intent-v1",
    execution: {
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-execution",
      environment: "staging",
      campaignIdSha256: executorReceipt.campaignIdSha256,
      planDigestSha256: executorReceipt.planDigestSha256,
      phaseExecutionId: executorReceipt.phaseExecutionId,
      controller: structuredClone(executorReceipt.controller),
      runtimes: structuredClone(executorReceipt.runtimes),
      ring: structuredClone(executorReceipt.ring),
      phase: structuredClone(executorReceipt.phase),
    },
    executor: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      versionId: executorReceipt.executor.versionId,
    },
    invoker: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      versionId: invokerVersionId,
    },
    authorizationIdSha256: commandIdSha256,
    topologyReadbackSha256: sha256Canonical({ phaseIndex, kind: "topology" }),
    beforeContextSha256: sha256Canonical({ phaseIndex, kind: "before-context" }),
    issuedAt: permit.subject.issuedAt,
    notBefore: permit.subject.notBefore,
    expiresAt: permit.subject.expiresAt,
  };
  const commandSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invoke-command-subject-v1",
    commandIdSha256,
    issueIntent,
  };
  const commandClaims = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invoke-authority-claims-v1",
    issuer: "cinatoken-json-compatibility-campaign-operator-staging",
    audience:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    credentialIdSha256: sha256Canonical({ phaseIndex, kind: "operator-key" }),
    commandIdSha256,
    commandSubjectSha256: sha256Canonical(commandSubject),
    issuedAt: startedAtSeconds - 1,
    expiresAt: startedAtSeconds + 59,
  };
  const commandAuthority = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invoke-authority-envelope-v1",
    algorithm: "HMAC-SHA-256",
    keyId: "phase-source-operator-key",
    claims: commandClaims,
    claimsSha256: sha256Canonical(commandClaims),
    signatureBase64url: "A".repeat(43),
  };
  const command = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invoke-command-v1",
    subject: commandSubject,
    authority: commandAuthority,
  };
  const verifiedCommandAuthority = {
    issuer: commandClaims.issuer,
    audience: commandClaims.audience,
    keyId: commandAuthority.keyId,
    credentialIdSha256: commandClaims.credentialIdSha256,
    commandIdSha256,
    commandSubjectSha256: commandClaims.commandSubjectSha256,
    claimsSha256: commandAuthority.claimsSha256,
    authorityEnvelopeSha256: sha256Canonical(commandAuthority),
    issuedAt: commandClaims.issuedAt,
    expiresAt: commandClaims.expiresAt,
  };
  const issueIntentSha256 = sha256Canonical(issueIntent);
  const campaignBindingSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-issuer-campaign-binding-v1",
    environment: issueIntent.execution.environment,
    campaignIdSha256: issueIntent.execution.campaignIdSha256,
    planDigestSha256: issueIntent.execution.planDigestSha256,
    controller: issueIntent.execution.controller,
    executor: issueIntent.executor,
    invoker: issueIntent.invoker,
    runtimes: issueIntent.execution.runtimes,
    ring: issueIntent.execution.ring,
  });
  const attemptIdSha256 = createHash("sha256")
    .update(
      `cinatoken-container-runtime-json-compatibility-invocation-attempt-id-v1\n${commandIdSha256}\n${issueIntentSha256}\n${invokerVersionId}`,
      "utf8",
    )
    .digest("hex");
  const attemptSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1",
    status: "invocation_attempt_recorded",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: executorReceipt.planDigestSha256,
    phaseOrdinal: executorReceipt.phase.ordinal,
    phaseId: executorReceipt.phase.id,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    commandIdSha256,
    commandSubjectSha256: verifiedCommandAuthority.commandSubjectSha256,
    commandAuthorityEnvelopeSha256:
      verifiedCommandAuthority.authorityEnvelopeSha256,
    issueIntentSha256,
    topologyReadbackSha256: issueIntent.topologyReadbackSha256,
    beforeContextSha256: issueIntent.beforeContextSha256,
    attemptIdSha256,
    invokerVersionId,
    startedAt: startedAtSeconds,
    oneAttemptPerPhasePersisted: true,
    phaseOrderEnforced: true,
    ambiguousRetryRejected: true,
  };
  const attempt = {
    ...attemptSubject,
    receiptSha256: sha256Canonical(attemptSubject),
  };
  const authorityRequestIdSha256 = sha256Canonical({
    phaseIndex,
    kind: "issuer-request",
  });
  const permitEnvelopeSha256 = sha256Canonical(permit);
  const issuanceSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1",
    status: "permit_issuance_recorded",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: executorReceipt.planDigestSha256,
    phaseOrdinal: executorReceipt.phase.ordinal,
    phaseId: executorReceipt.phase.id,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    issueIntentSha256,
    authorityRequestIdSha256,
    permitIdSha256: permit.subject.permitIdSha256,
    permitSubjectSha256: permit.subjectSha256,
    permitEnvelopeSha256,
    issuerVersionId,
    issuedAt: issueIntent.issuedAt,
    expiresAt: issueIntent.expiresAt,
    onePermitPerPhasePersisted: true,
    phaseIssuanceOrderEnforced: true,
    ambiguousRetryRejected: true,
  };
  const issuanceAuthority = {
    ...issuanceSubject,
    receiptSha256: sha256Canonical(issuanceSubject),
  };
  const permitIssueSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issue-receipt-v1",
    status: "phase_permit_issued",
    environment: "staging",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    phaseOrdinal: executorReceipt.phase.ordinal,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    issuer: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
      versionId: issuerVersionId,
      keyId: permit.subject.keyId,
      signerSpkiSha256: executorReceipt.authorization.signerSpkiSha256,
    },
    authority: {
      issuer:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      audience:
        "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
      keyId: "phase-source-invoker-issuer-key",
      credentialIdSha256: sha256Canonical({ phaseIndex, kind: "issuer-key" }),
      requestIdSha256: authorityRequestIdSha256,
      claimsSha256: sha256Canonical({ phaseIndex, kind: "issuer-claims" }),
    },
    issueIntent,
    issueIntentSha256,
    permitEnvelope: structuredClone(permit),
    permitEnvelopeSha256,
    issuanceAuthority,
  };
  const permitIssueReceipt = {
    ...permitIssueSubject,
    receiptSha256: sha256Canonical(permitIssueSubject),
  };
  const receiptBody = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1",
    status: "private_phase_invocation_completed",
    environment: "staging",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    planDigestSha256: executorReceipt.planDigestSha256,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    phaseOrdinal: executorReceipt.phase.ordinal,
    phaseId: executorReceipt.phase.id,
    command,
    commandAuthority: verifiedCommandAuthority,
    invoker: {
      serviceName:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      versionId: invokerVersionId,
      gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED",
    },
    privateTransport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      permitIssuerBinding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
    },
    invocationAuthority: { attempt },
    permitIssueReceipt,
    executorReceipt,
    startedAt,
    completedAt,
  };
  const invocationBodySha256 = sha256Canonical(receiptBody);
  const completionSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-completion-receipt-v1",
    status: executorReceipt.phase.ordinal === 4
      ? "invocation_campaign_completed"
      : "invocation_phase_completed",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    phaseOrdinal: executorReceipt.phase.ordinal,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    commandIdSha256,
    attemptIdSha256,
    permitIdSha256: permit.subject.permitIdSha256,
    permitIssueReceiptSha256: permitIssueReceipt.receiptSha256,
    executorReceiptSha256: executorReceipt.receiptSha256,
    invocationBodySha256,
    completedAt: Math.floor(Date.parse(completedAt) / 1000),
    attemptCompletionPersisted: true,
    phaseOrderAdvanced: true,
    campaignTerminal: executorReceipt.phase.ordinal === 4,
  };
  const completion = {
    ...completionSubject,
    receiptSha256: sha256Canonical(completionSubject),
  };
  const receiptSubject = {
    ...receiptBody,
    invocationAuthority: { attempt, completion },
    invocationBodySha256,
  };
  return {
    ...receiptSubject,
    receiptSha256: sha256Canonical(receiptSubject),
  };
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

function resealPrivateInvocation(receipt) {
  receipt.invocationAuthority.completion.executorReceiptSha256 =
    receipt.executorReceipt.receiptSha256;
  const receiptBody = {
    schemaVersion: receipt.schemaVersion,
    contract: receipt.contract,
    status: receipt.status,
    environment: receipt.environment,
    campaignIdSha256: receipt.campaignIdSha256,
    planDigestSha256: receipt.planDigestSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    command: receipt.command,
    commandAuthority: receipt.commandAuthority,
    invoker: receipt.invoker,
    privateTransport: receipt.privateTransport,
    invocationAuthority: { attempt: receipt.invocationAuthority.attempt },
    permitIssueReceipt: receipt.permitIssueReceipt,
    executorReceipt: receipt.executorReceipt,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
  receipt.invocationBodySha256 = sha256Canonical(receiptBody);
  receipt.invocationAuthority.completion.invocationBodySha256 =
    receipt.invocationBodySha256;
  const { receiptSha256: _completionDigest, ...completionSubject } =
    receipt.invocationAuthority.completion;
  receipt.invocationAuthority.completion.receiptSha256 =
    sha256Canonical(completionSubject);
  const { receiptSha256: _receiptDigest, ...receiptSubject } = receipt;
  receipt.receiptSha256 = sha256Canonical(receiptSubject);
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
      const executorReceipt = await buildReceipt(plan, phaseIndex);
      const receipt = await buildPrivateInvocationReceipt(
        plan,
        executorReceipt,
        phaseIndex,
      );
      const context = buildContext(plan, executorReceipt, phaseIndex);
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
    const executorReceipt = await buildReceipt(plan, 0);
    const receipt = await buildPrivateInvocationReceipt(plan, executorReceipt, 0);
    receipt.executorReceipt.observations[0].probeRequestCanonicalSha256 =
      "aa".repeat(32);
    resealReceipt(receipt.executorReceipt);
    resealPrivateInvocation(receipt);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(
        plan,
        receipt,
        buildContext(plan, receipt.executorReceipt, 0),
      ),
    ).rejects.toThrow(/request canonical digest/);
  });

  test("rejects a direct executor receipt without the authenticated private chain", async () => {
    const plan = buildPlan();
    const executorReceipt = await buildReceipt(plan, 0);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(
        plan,
        executorReceipt,
        buildContext(plan, executorReceipt, 0),
      ),
    ).rejects.toThrow(/private-invocation/);
  });

  test("rejects a resealed completion receipt that is detached from its attempt", async () => {
    const plan = buildPlan();
    const executorReceipt = await buildReceipt(plan, 0);
    const receipt = await buildPrivateInvocationReceipt(plan, executorReceipt, 0);
    receipt.invocationAuthority.completion.attemptIdSha256 = "aa".repeat(32);
    const { receiptSha256: _completionDigest, ...completionSubject } =
      receipt.invocationAuthority.completion;
    receipt.invocationAuthority.completion.receiptSha256 =
      sha256Canonical(completionSubject);
    const { receiptSha256: _receiptDigest, ...receiptSubject } = receipt;
    receipt.receiptSha256 = sha256Canonical(receiptSubject);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(
        plan,
        receipt,
        buildContext(plan, executorReceipt, 0),
      ),
    ).rejects.toThrow(/completion attempt ID/);
  });

  test("rejects drifting external snapshots even when context digests are resealed", async () => {
    const plan = buildPlan();
    const executorReceipt = await buildReceipt(plan, 1);
    const receipt = await buildPrivateInvocationReceipt(plan, executorReceipt, 1);
    const context = buildContext(plan, executorReceipt, 1);
    context.noMutationFacts.providerAfterSha256 = "aa".repeat(32);
    const { evidenceSha256: _ignored, ...proof } = context.noMutationFacts;
    context.noMutationFacts.evidenceSha256 = sha256Canonical(proof);
    resealContext(context);

    await expect(
      buildJsonCompatibilityPhaseSourcePacket(plan, receipt, context),
    ).rejects.toThrow(/provider snapshot/);

    const storageContext = buildContext(plan, executorReceipt, 1);
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
    const executorReceipt = await buildReceipt(plan, 2);
    const receipt = await buildPrivateInvocationReceipt(plan, executorReceipt, 2);
    const context = buildContext(plan, executorReceipt, 2);
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
