import { createHash } from "node:crypto";

import {
  normalizeEnforcementPredecessors,
} from "./container_runtime_worm_data.mjs";
import {
  normalizeLockPredecessor,
} from "./container_runtime_worm_lifecycle.mjs";
import {
  canonicalJson,
} from "./container_runtime_worm_staging.mjs";

export const WORM_ENFORCEMENT_SCHEMA_VERSION = 1;
export const WORM_ENFORCEMENT_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-worm-enforcement-phase-receipt-v1";
export const LOCK_VERIFIER_TOKEN_ENV =
  "CINATOKEN_WORM_LOCK_VERIFIER_API_TOKEN";

const SOURCE =
  "cinatoken-container-runtime-worm-enforcement-collector";
const PHASES = Object.freeze([
  "probe",
  "revoke",
  "verify-revocation",
  "object-readback",
  "lock-readback",
  "emergency-revoke",
  "emergency-verify",
]);
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const E_TAG_PATTERN = /^.{1,256}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS = 3_600;
const REQUEST_TIMEOUT_MS = 30_000;

const PUBLISHER_ACCESS_KEY_ENV =
  "CINATOKEN_WORM_PUBLISHER_R2_ACCESS_KEY_ID";
const PUBLISHER_SECRET_KEY_ENV =
  "CINATOKEN_WORM_PUBLISHER_R2_SECRET_ACCESS_KEY";
const OBJECT_VERIFIER_ACCESS_KEY_ENV =
  "CINATOKEN_WORM_OBJECT_VERIFIER_R2_ACCESS_KEY_ID";
const OBJECT_VERIFIER_SECRET_KEY_ENV =
  "CINATOKEN_WORM_OBJECT_VERIFIER_R2_SECRET_ACCESS_KEY";
const LIFECYCLE_OPERATOR_TOKEN_ENV =
  "CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN";
const LIFECYCLE_VERIFIER_TOKEN_ENV =
  "CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN";
const LIFECYCLE_TARGET_TOKEN_ID_ENV =
  "CINATOKEN_WORM_LIFECYCLE_TARGET_TOKEN_ID";

export function describeEnforcementCollector() {
  return {
    schemaVersion: WORM_ENFORCEMENT_SCHEMA_VERSION,
    contract: WORM_ENFORCEMENT_RECEIPT_CONTRACT,
    source: SOURCE,
    environment: "staging",
    defaultMode: "dry-run",
    phases: [
      {
        phase: "probe",
        credentialRole: "publisher",
        providerMutation: true,
        requests: [
          "PutObject If-None-Match:* publisher-preflight",
          "PutObject unconditional-overwrite",
          "DeleteObject unconditional",
        ],
      },
      {
        phase: "revoke",
        credentialRole: "lifecycle-operator",
        providerMutation: true,
        requests: [
          "GET token-verify",
          "DELETE publisher-token",
          "GET publisher-token operator-readback",
        ],
      },
      {
        phase: "verify-revocation",
        credentialRole: "lifecycle-verifier",
        providerMutation: false,
        requests: [
          "GET token-verify",
          "GET publisher-token independent-readback",
        ],
      },
      {
        phase: "object-readback",
        credentialRole: "object-verifier",
        providerMutation: false,
        requests: ["GetObject If-Match"],
      },
      {
        phase: "lock-readback",
        credentialRole: "lock-verifier",
        providerMutation: false,
        requests: ["GET token-verify", "GET bucket-lock"],
      },
      {
        phase: "emergency-revoke",
        credentialRole: "lifecycle-operator",
        providerMutation: true,
        positiveEvidenceEligible: false,
        requests: [
          "GET token-verify",
          "DELETE publisher-token",
          "GET publisher-token operator-readback",
        ],
      },
      {
        phase: "emergency-verify",
        credentialRole: "lifecycle-verifier",
        providerMutation: false,
        positiveEvidenceEligible: false,
        requests: [
          "GET token-verify",
          "GET publisher-token independent-readback",
        ],
      },
    ],
    downstreamAuthority: downstreamAuthority(),
  };
}

export function readEnforcementCredentials(phase, env) {
  requirePhase(phase);
  if (phase === "probe") {
    return readKeyPair(
      env,
      PUBLISHER_ACCESS_KEY_ENV,
      PUBLISHER_SECRET_KEY_ENV,
    );
  }
  if (phase === "object-readback") {
    return readKeyPair(
      env,
      OBJECT_VERIFIER_ACCESS_KEY_ENV,
      OBJECT_VERIFIER_SECRET_KEY_ENV,
    );
  }
  if (
    phase === "revoke" ||
    phase === "verify-revocation" ||
    phase === "emergency-revoke" ||
    phase === "emergency-verify"
  ) {
    const tokenName =
      phase === "revoke" || phase === "emergency-revoke"
        ? LIFECYCLE_OPERATOR_TOKEN_ENV
        : LIFECYCLE_VERIFIER_TOKEN_ENV;
    return {
      apiToken: requireCredential(env[tokenName], tokenName),
      targetTokenId: requirePattern(
        env[LIFECYCLE_TARGET_TOKEN_ID_ENV],
        TOKEN_ID_PATTERN,
        `[credentials] ${LIFECYCLE_TARGET_TOKEN_ID_ENV}`,
      ),
    };
  }
  return {
    apiToken: requireCredential(
      env[LOCK_VERIFIER_TOKEN_ENV],
      LOCK_VERIFIER_TOKEN_ENV,
    ),
  };
}

export function normalizeProbePredecessors(options) {
  const target = normalizeEnforcementPredecessors(options);
  const enforcementProbePolicy = normalizeEnforcementProbePolicy(
    options.policy?.enforcementProbePolicy,
  );
  const probeObject = target.objects.find(
    (value) => value.kind === "provenance-evidence-packet",
  );
  requireCondition(
    probeObject !== undefined,
    "[predecessor] enforcement probe object is absent",
  );
  return { ...target, probeObject, enforcementProbePolicy };
}

export function buildEnforcementDryRunReceipt(phase, target) {
  requirePhase(phase);
  return {
    schemaVersion: WORM_ENFORCEMENT_SCHEMA_VERSION,
    contract: WORM_ENFORCEMENT_RECEIPT_CONTRACT,
    source: SOURCE,
    environment: "staging",
    phase,
    mode: "dry-run",
    ok: true,
    capturedAt: null,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    providerMutationConfirmed: false,
    mutationPerformed: false,
    target: publicTarget(target),
    ...(phase === "emergency-revoke"
      ? {
          incidentSha256: target.incidentSha256,
          positiveEvidenceEligible: false,
        }
      : phase === "emergency-verify"
        ? { positiveEvidenceEligible: false }
        : {}),
    requestPlan: describeEnforcementCollector().phases.find(
      (value) => value.phase === phase,
    ).requests,
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

export async function collectEnforcementProbes(options) {
  const {
    target,
    credentials,
    probe,
    now = () => new Date(),
  } = options;
  requireCondition(
    probe &&
      typeof probe.putObject === "function" &&
      typeof probe.deleteObject === "function",
    "[probe] raw S3 probe adapter is incomplete",
  );
  requireCondition(
    credentials.credentialIdSha256 ===
      target.publisherCredentialIdSha256,
    "[probe] publisher credential does not match B4",
  );
  const overwriteBody = Buffer.from(
    `${canonicalJson({
      contract: WORM_ENFORCEMENT_RECEIPT_CONTRACT,
      operation: "retention-overwrite-probe",
      statementSha256: target.statementSha256,
    })}\n`,
    "utf8",
  );
  const overwriteSha256 = sha256(overwriteBody);
  requireCondition(
    overwriteSha256 !== target.probeObject.sha256,
    "[probe] overwrite content unexpectedly matches the original",
  );
  const preflightAt = requireTimestamp(
    now(),
    "[probe] publisher preflight attempt time",
  );
  requireCondition(
    target.objectReadbackCapturedAt < preflightAt,
    "[probe] publisher preflight did not follow B4 readback",
  );
  const preflightResponse = await invokeProbe(
    () =>
      probe.putObject({
        bucketName: target.bucketName,
        key: target.probeObject.key,
        body: overwriteBody,
        contentType: "application/octet-stream",
        ifNoneMatch: "*",
      }),
    "publisher-preflight",
  );
  const preflightCompletedAt = requireTimestamp(
    now(),
    "[probe] publisher preflight completion time",
  );
  const publisherPreflight = normalizeProbeResult(
    preflightResponse,
    "put-object-create-only-preflight",
    preflightAt,
    preflightCompletedAt,
    overwriteBody.length,
    overwriteSha256,
    target.enforcementProbePolicy.publisherPreflight,
    "If-None-Match:*",
    target.enforcementProbePolicy,
  );
  const overwriteAt = requireTimestamp(
    now(),
    "[probe] overwrite attempt time",
  );
  requireCondition(
    preflightCompletedAt < overwriteAt,
    "[probe] overwrite began before publisher preflight completed",
  );
  const overwriteResponse = await invokeProbe(
    () =>
      probe.putObject({
        bucketName: target.bucketName,
        key: target.probeObject.key,
        body: overwriteBody,
        contentType: "application/octet-stream",
      }),
    "overwrite",
  );
  const overwriteCompletedAt = requireTimestamp(
    now(),
    "[probe] overwrite completion time",
  );
  const overwrite = normalizeProbeResult(
    overwriteResponse,
    "put-object",
    overwriteAt,
    overwriteCompletedAt,
    overwriteBody.length,
    overwriteSha256,
    target.enforcementProbePolicy.overwrite,
    null,
    target.enforcementProbePolicy,
  );
  const deleteAt = requireTimestamp(
    now(),
    "[probe] delete attempt time",
  );
  requireCondition(
    overwriteCompletedAt < deleteAt,
    "[probe] delete began before overwrite completed",
  );
  const deleteResponse = await invokeProbe(
    () =>
      probe.deleteObject({
        bucketName: target.bucketName,
        key: target.probeObject.key,
      }),
    "delete",
  );
  const deleteCompletedAt = requireTimestamp(
    now(),
    "[probe] delete completion time",
  );
  const deletion = normalizeProbeResult(
    deleteResponse,
    "delete-object",
    deleteAt,
    deleteCompletedAt,
    0,
    target.probeObject.sha256,
    target.enforcementProbePolicy.delete,
    null,
    target.enforcementProbePolicy,
  );
  requireDistinctProviderIds([
    publisherPreflight.providerRequestId,
    overwrite.providerRequestId,
    deletion.providerRequestId,
  ], "[probe] provider request IDs");
  const capturedAt = requireTimestamp(
    now(),
    "[probe] capture time",
  );
  requireCondition(
    deleteCompletedAt < capturedAt,
    "[probe] capture did not follow provider responses",
  );
  const receipt = {
    ...liveEnvelope("probe", capturedAt, true),
    target: publicTarget(target),
    predecessors: {
      lockRevocationReceiptSha256:
        target.lockRevocationReceiptSha256,
      publishReceiptSha256: target.publishReceiptSha256,
      objectReadbackReceiptSha256:
        target.objectReadbackReceiptSha256,
      objectReadbackObservedAt: target.objectReadbackCapturedAt,
    },
    credential: credentialReceipt(
      "publisher",
      "r2-object-read-write-api-token",
      credentials.credentialIdSha256,
    ),
    facts: {
      accountIdSha256: target.accountIdSha256,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
      prefix: target.prefix,
      publisherCredentialIdSha256:
        target.publisherCredentialIdSha256,
      objectVerifierCredentialIdSha256:
        target.objectVerifierCredentialIdSha256,
      targetObjectKind: target.probeObject.kind,
      targetKey: target.probeObject.key,
      originalSha256: target.probeObject.sha256,
      originalBytes: target.probeObject.bytes,
      originalEtag: target.probeObject.etag,
      publisherPreflight,
      overwrite,
      delete: deletion,
    },
    providerOperations: [
      providerProbeOperation(publisherPreflight),
      providerProbeOperation(overwrite),
      providerProbeOperation(deletion),
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    target.accountId,
  ]);
  return receipt;
}

export function normalizeProbeReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "probe",
    true,
  );
  requirePublicTarget(parsed.receipt.target, target, "probe");
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] probe predecessors",
  );
  exactKeys(
    predecessors,
    [
      "lockRevocationReceiptSha256",
      "publishReceiptSha256",
      "objectReadbackReceiptSha256",
      "objectReadbackObservedAt",
    ],
    "[predecessor] probe predecessors",
  );
  requireCondition(
    predecessors.lockRevocationReceiptSha256 ===
        target.lockRevocationReceiptSha256 &&
      predecessors.publishReceiptSha256 ===
        target.publishReceiptSha256 &&
      predecessors.objectReadbackReceiptSha256 ===
        target.objectReadbackReceiptSha256 &&
      predecessors.objectReadbackObservedAt ===
        target.objectReadbackCapturedAt &&
      target.objectReadbackCapturedAt < parsed.capturedAt,
    "[predecessor] probe receipt chain drifted",
  );
  requireCredentialReceipt(
    parsed.receipt.credential,
    "publisher",
    "r2-object-read-write-api-token",
    target.publisherCredentialIdSha256,
  );
  const facts = normalizeProbeFacts(parsed.receipt.facts, target);
  requireCondition(
    facts.delete.attemptedAt < parsed.capturedAt,
    "[predecessor] probe capture chronology drifted",
  );
  validateProbeOperations(parsed.receipt.providerOperations, facts);
  validateLimitsAndAuthority(parsed.receipt, "probe");
  return {
    ...target,
    probeReceiptSha256: parsed.receiptSha256,
    probeCapturedAt: parsed.capturedAt,
    publisherPreflight: facts.publisherPreflight,
    overwriteProbe: facts.overwrite,
    deleteProbe: facts.delete,
  };
}

export async function revokePublisherEmergency(options) {
  const {
    target,
    credentials,
    lifecycle,
    incidentSha256,
    now = () => new Date(),
  } = options;
  requireLifecycleAdapter(lifecycle, "emergency-revoke");
  requireTargetToken(target, credentials.targetTokenId);
  requireCondition(
    SHA256_PATTERN.test(incidentSha256),
    "[emergency-revoke] incident digest is invalid",
  );
  const self = normalizeTokenVerification(
    await lifecycle.verifySelf({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      role: "lifecycle-operator",
    }),
    requireTimestamp(
      now(),
      "[emergency-revoke] operator verification time",
    ),
    "lifecycle-operator",
  );
  requireCondition(
    self.credentialIdSha256 ===
        target.lifecycleOperatorCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.publisherCredentialIdSha256,
    "[emergency-revoke] lifecycle operator identity drifted",
  );
  requireCondition(
    target.objectReadbackCapturedAt < self.selfVerifiedAt,
    "[emergency-revoke] operator verification predates B4 readback",
  );
  const deletionResponse = normalizeDeletion(
    await lifecycle.deleteToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
    }),
    credentials.targetTokenId,
  );
  const deletedAt = requireTimestamp(
    now(),
    "[emergency-revoke] deletion time",
  );
  const operatorReadback = normalizeAbsence(
    await lifecycle.readToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
      role: "lifecycle-operator",
    }),
    "operator",
  );
  const operatorReadbackAt = requireTimestamp(
    now(),
    "[emergency-revoke] operator readback time",
  );
  requireCondition(
    self.selfVerifiedAt < deletedAt &&
      deletedAt < operatorReadbackAt &&
      operatorReadbackAt < self.expiresAt,
    "[emergency-revoke] publisher lifecycle chronology is invalid",
  );
  requireDistinctProviderIds([
    self.providerRequestId,
    deletionResponse.providerRequestId,
    operatorReadback.providerRequestId,
  ], "[emergency-revoke] provider request IDs");
  const receipt = {
    ...liveEnvelope("emergency-revoke", operatorReadbackAt, true),
    target: publicTarget(target),
    predecessors: {
      lockRevocationReceiptSha256:
        target.lockRevocationReceiptSha256,
      publishReceiptSha256: target.publishReceiptSha256,
      objectReadbackReceiptSha256:
        target.objectReadbackReceiptSha256,
      objectReadbackObservedAt: target.objectReadbackCapturedAt,
      incidentSha256,
    },
    authority: authorityReceipt(
      "lifecycle-operator",
      "cloudflare-account-api-token-read-edit",
      self,
    ),
    facts: {
      ...revokeFacts(
        target,
        deletionResponse,
        deletedAt,
        operatorReadback,
        operatorReadbackAt,
      ),
      emergency: true,
      positiveEvidenceEligible: false,
      incidentSha256,
    },
    providerOperations: revokeOperations(
      self,
      deletionResponse,
      operatorReadback,
    ),
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.apiToken,
    credentials.targetTokenId,
    target.accountId,
  ]);
  return receipt;
}

export function normalizeEmergencyRevokeReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "emergency-revoke",
    true,
  );
  requirePublicTarget(
    parsed.receipt.target,
    target,
    "emergency-revoke",
  );
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] emergency revoke predecessors",
  );
  exactKeys(
    predecessors,
    [
      "lockRevocationReceiptSha256",
      "publishReceiptSha256",
      "objectReadbackReceiptSha256",
      "objectReadbackObservedAt",
      "incidentSha256",
    ],
    "[predecessor] emergency revoke predecessors",
  );
  requireCondition(
    predecessors.lockRevocationReceiptSha256 ===
        target.lockRevocationReceiptSha256 &&
      predecessors.publishReceiptSha256 ===
        target.publishReceiptSha256 &&
      predecessors.objectReadbackReceiptSha256 ===
        target.objectReadbackReceiptSha256 &&
      predecessors.objectReadbackObservedAt ===
        target.objectReadbackCapturedAt &&
      SHA256_PATTERN.test(predecessors.incidentSha256),
    "[predecessor] emergency revoke chain drifted",
  );
  const authority = normalizeAuthorityReceipt(
    parsed.receipt.authority,
    "lifecycle-operator",
    "cloudflare-account-api-token-read-edit",
    target.lifecycleOperatorCredentialIdSha256,
  );
  const facts = normalizeEmergencyRevokeFacts(
    parsed.receipt.facts,
    target,
    predecessors.incidentSha256,
  );
  requireCondition(
    target.objectReadbackCapturedAt < authority.selfVerifiedAt &&
      authority.selfVerifiedAt < facts.deletedAt &&
      facts.deletedAt < facts.operatorReadbackAt &&
      facts.operatorReadbackAt === parsed.capturedAt &&
      parsed.capturedAt < authority.expiresAt,
    "[predecessor] emergency revoke chronology drifted",
  );
  validateRevokeOperations(
    parsed.receipt.providerOperations,
    authority,
    facts,
  );
  validateLimitsAndAuthority(
    parsed.receipt,
    "emergency-revoke",
  );
  return {
    ...target,
    incidentSha256: predecessors.incidentSha256,
    emergencyRevokeReceiptSha256: parsed.receiptSha256,
    emergencyRevokeCapturedAt: parsed.capturedAt,
    emergencyOperatorReadbackErrorCodes:
      facts.operatorReadbackErrorCodes,
    emergencyDeletion: {
      at: facts.deletedAt,
      httpStatus: facts.deletionHttpStatus,
      providerRequestId: facts.deletionRequestId,
      responseBodySha256: facts.deletionResponseBodySha256,
      resultIdSha256: facts.deletionResultIdSha256,
    },
    emergencyOperatorReadback: {
      at: facts.operatorReadbackAt,
      httpStatus: facts.operatorReadbackHttpStatus,
      providerRequestId: facts.operatorReadbackRequestId,
      responseBodySha256:
        facts.operatorReadbackResponseBodySha256,
      errorCodes: facts.operatorReadbackErrorCodes,
    },
  };
}

export async function verifyEmergencyRevocation(options) {
  const {
    target,
    credentials,
    lifecycle,
    now = () => new Date(),
  } = options;
  requireLifecycleAdapter(lifecycle, "emergency-verify");
  requireTargetToken(target, credentials.targetTokenId);
  const self = normalizeTokenVerification(
    await lifecycle.verifySelf({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      role: "lifecycle-verifier",
    }),
    requireTimestamp(
      now(),
      "[emergency-verify] verifier verification time",
    ),
    "lifecycle-verifier",
  );
  requireCondition(
    self.credentialIdSha256 ===
        target.lifecycleVerifierCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.publisherCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.lifecycleOperatorCredentialIdSha256,
    "[emergency-verify] lifecycle verifier identity drifted",
  );
  const independent = normalizeAbsence(
    await lifecycle.readToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
      role: "lifecycle-verifier",
    }),
    "independent",
  );
  const independentReadbackAt = requireTimestamp(
    now(),
    "[emergency-verify] independent readback time",
  );
  requireCondition(
    target.emergencyRevokeCapturedAt < self.selfVerifiedAt &&
      self.selfVerifiedAt < independentReadbackAt &&
      independentReadbackAt < self.expiresAt,
    "[emergency-verify] publisher lifecycle chronology is invalid",
  );
  requireCondition(
    canonicalJson(independent.errorCodes) ===
      canonicalJson(target.emergencyOperatorReadbackErrorCodes),
    "[emergency-verify] independent absence error codes drifted",
  );
  requireDistinctProviderIds([
    target.emergencyDeletion.providerRequestId,
    target.emergencyOperatorReadback.providerRequestId,
    self.providerRequestId,
    independent.providerRequestId,
  ], "[emergency-verify] lifecycle provider request IDs");
  const receipt = {
    ...liveEnvelope(
      "emergency-verify",
      independentReadbackAt,
      false,
    ),
    target: publicTarget(target),
    predecessors: {
      emergencyRevokeReceiptSha256:
        target.emergencyRevokeReceiptSha256,
      emergencyRevokeObservedAt:
        target.emergencyRevokeCapturedAt,
      incidentSha256: target.incidentSha256,
    },
    authority: authorityReceipt(
      "lifecycle-verifier",
      "cloudflare-account-api-token-read",
      self,
    ),
    facts: {
      ...verifyFacts(target, independent, independentReadbackAt),
      emergency: true,
      positiveEvidenceEligible: false,
      incidentSha256: target.incidentSha256,
    },
    providerOperations: verifyOperations(self, independent),
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.apiToken,
    credentials.targetTokenId,
    target.accountId,
  ]);
  return receipt;
}

export function normalizeEmergencyVerifyReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "emergency-verify",
    false,
  );
  requirePublicTarget(
    parsed.receipt.target,
    target,
    "emergency-verify",
  );
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] emergency verify predecessors",
  );
  exactKeys(
    predecessors,
    [
      "emergencyRevokeReceiptSha256",
      "emergencyRevokeObservedAt",
      "incidentSha256",
    ],
    "[predecessor] emergency verify predecessors",
  );
  requireCondition(
    predecessors.emergencyRevokeReceiptSha256 ===
        target.emergencyRevokeReceiptSha256 &&
      predecessors.emergencyRevokeObservedAt ===
        target.emergencyRevokeCapturedAt &&
      predecessors.incidentSha256 === target.incidentSha256,
    "[predecessor] emergency verify chain drifted",
  );
  const authority = normalizeAuthorityReceipt(
    parsed.receipt.authority,
    "lifecycle-verifier",
    "cloudflare-account-api-token-read",
    target.lifecycleVerifierCredentialIdSha256,
  );
  const facts = normalizeEmergencyVerifyFacts(
    parsed.receipt.facts,
    target,
  );
  requireCondition(
    target.emergencyRevokeCapturedAt <
        authority.selfVerifiedAt &&
      authority.selfVerifiedAt < facts.independentReadbackAt &&
      facts.independentReadbackAt === parsed.capturedAt &&
      parsed.capturedAt < authority.expiresAt,
    "[predecessor] emergency verify chronology drifted",
  );
  validateVerifyOperations(
    parsed.receipt.providerOperations,
    authority,
    facts,
    {
      deletion: target.emergencyDeletion,
      operatorReadback: target.emergencyOperatorReadback,
    },
  );
  validateLimitsAndAuthority(
    parsed.receipt,
    "emergency-verify",
  );
  return {
    ...target,
    emergencyVerifyReceiptSha256: parsed.receiptSha256,
    emergencyVerifyCapturedAt: parsed.capturedAt,
    emergencyRevocationIndependentlyVerified: true,
    positiveEvidenceEligible: false,
  };
}

export async function revokePublisher(options) {
  const {
    target,
    credentials,
    lifecycle,
    now = () => new Date(),
  } = options;
  requireLifecycleAdapter(lifecycle, "revoke");
  requireTargetToken(target, credentials.targetTokenId);
  const self = normalizeTokenVerification(
    await lifecycle.verifySelf({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      role: "lifecycle-operator",
    }),
    requireTimestamp(now(), "[revoke] operator verification time"),
    "lifecycle-operator",
  );
  requireCondition(
    self.credentialIdSha256 ===
        target.lifecycleOperatorCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.publisherCredentialIdSha256,
    "[revoke] lifecycle operator identity drifted",
  );
  requireCondition(
    target.probeCapturedAt < self.selfVerifiedAt,
    "[revoke] operator verification did not follow both probes",
  );
  const deletionResponse = normalizeDeletion(
    await lifecycle.deleteToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
    }),
    credentials.targetTokenId,
  );
  const deletedAt = requireTimestamp(
    now(),
    "[revoke] deletion time",
  );
  const operatorReadback = normalizeAbsence(
    await lifecycle.readToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
      role: "lifecycle-operator",
    }),
    "operator",
  );
  const operatorReadbackAt = requireTimestamp(
    now(),
    "[revoke] operator readback time",
  );
  requireCondition(
    self.selfVerifiedAt < deletedAt &&
      deletedAt < operatorReadbackAt &&
      operatorReadbackAt < self.expiresAt,
    "[revoke] publisher lifecycle chronology is invalid",
  );
  requireDistinctProviderIds([
    self.providerRequestId,
    deletionResponse.providerRequestId,
    operatorReadback.providerRequestId,
  ], "[revoke] provider request IDs");
  const receipt = {
    ...liveEnvelope("revoke", operatorReadbackAt, true),
    target: publicTarget(target),
    predecessors: {
      probeReceiptSha256: target.probeReceiptSha256,
      probeObservedAt: target.probeCapturedAt,
    },
    authority: authorityReceipt(
      "lifecycle-operator",
      "cloudflare-account-api-token-read-edit",
      self,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      targetRole: "publisher",
      targetCredentialIdSha256:
        target.publisherCredentialIdSha256,
      deletedAt,
      deletionHttpStatus: deletionResponse.httpStatus,
      deletionRequestId: deletionResponse.providerRequestId,
      deletionResponseBodySha256:
        deletionResponse.responseBodySha256,
      deletionResultIdSha256:
        deletionResponse.resultIdSha256,
      operatorReadbackAt,
      operatorReadbackErrorCodes: operatorReadback.errorCodes,
      operatorReadbackHttpStatus: operatorReadback.httpStatus,
      operatorReadbackRequestId:
        operatorReadback.providerRequestId,
      operatorReadbackResponseBodySha256:
        operatorReadback.responseBodySha256,
      targetAbsentAfterDelete: true,
    },
    providerOperations: [
      lifecycleOperation("GET", "lifecycle-operator-preflight", self),
      lifecycleOperation(
        "DELETE",
        "publisher-delete",
        deletionResponse,
      ),
      lifecycleOperation(
        "GET",
        "operator-revocation-readback",
        operatorReadback,
      ),
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.apiToken,
    credentials.targetTokenId,
    target.accountId,
  ]);
  return receipt;
}

export function normalizePublisherRevokeReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "revoke",
    true,
  );
  requirePublicTarget(parsed.receipt.target, target, "revoke");
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] publisher revoke predecessors",
  );
  exactKeys(
    predecessors,
    ["probeReceiptSha256", "probeObservedAt"],
    "[predecessor] publisher revoke predecessors",
  );
  requireCondition(
    predecessors.probeReceiptSha256 === target.probeReceiptSha256 &&
      predecessors.probeObservedAt === target.probeCapturedAt,
    "[predecessor] publisher revoke chain drifted",
  );
  const authority = normalizeAuthorityReceipt(
    parsed.receipt.authority,
    "lifecycle-operator",
    "cloudflare-account-api-token-read-edit",
    target.lifecycleOperatorCredentialIdSha256,
  );
  const facts = normalizeRevokeFacts(parsed.receipt.facts, target);
  requireCondition(
    target.probeCapturedAt < authority.selfVerifiedAt &&
      authority.selfVerifiedAt < facts.deletedAt &&
      facts.deletedAt < facts.operatorReadbackAt &&
      facts.operatorReadbackAt === parsed.capturedAt &&
      parsed.capturedAt < authority.expiresAt,
    "[predecessor] publisher revoke chronology drifted",
  );
  validateRevokeOperations(
    parsed.receipt.providerOperations,
    authority,
    facts,
  );
  validateLimitsAndAuthority(parsed.receipt, "revoke");
  return {
    ...target,
    revokeReceiptSha256: parsed.receiptSha256,
    revokeCapturedAt: parsed.capturedAt,
    lifecycleOperatorSelfVerifiedAt: authority.selfVerifiedAt,
    deletedAt: facts.deletedAt,
    operatorReadbackAt: facts.operatorReadbackAt,
    operatorReadbackErrorCodes: facts.operatorReadbackErrorCodes,
    deletion: {
      at: facts.deletedAt,
      httpStatus: facts.deletionHttpStatus,
      providerRequestId: facts.deletionRequestId,
      responseBodySha256: facts.deletionResponseBodySha256,
      resultIdSha256: facts.deletionResultIdSha256,
    },
    operatorReadback: {
      at: facts.operatorReadbackAt,
      httpStatus: facts.operatorReadbackHttpStatus,
      providerRequestId: facts.operatorReadbackRequestId,
      responseBodySha256:
        facts.operatorReadbackResponseBodySha256,
      errorCodes: facts.operatorReadbackErrorCodes,
    },
  };
}

export async function verifyPublisherRevocation(options) {
  const {
    target,
    credentials,
    lifecycle,
    now = () => new Date(),
  } = options;
  requireLifecycleAdapter(lifecycle, "verify-revocation");
  requireTargetToken(target, credentials.targetTokenId);
  const self = normalizeTokenVerification(
    await lifecycle.verifySelf({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      role: "lifecycle-verifier",
    }),
    requireTimestamp(now(), "[verify] verifier verification time"),
    "lifecycle-verifier",
  );
  requireCondition(
    self.credentialIdSha256 ===
        target.lifecycleVerifierCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.publisherCredentialIdSha256 &&
      self.credentialIdSha256 !==
        target.lifecycleOperatorCredentialIdSha256,
    "[verify] lifecycle verifier identity drifted",
  );
  const independent = normalizeAbsence(
    await lifecycle.readToken({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      targetTokenId: credentials.targetTokenId,
      role: "lifecycle-verifier",
    }),
    "independent",
  );
  const independentReadbackAt = requireTimestamp(
    now(),
    "[verify] independent readback time",
  );
  requireCondition(
    target.revokeCapturedAt < self.selfVerifiedAt &&
      self.selfVerifiedAt < independentReadbackAt &&
      independentReadbackAt < self.expiresAt,
    "[verify] publisher lifecycle chronology is invalid",
  );
  requireCondition(
    canonicalJson(independent.errorCodes) ===
      canonicalJson(target.operatorReadbackErrorCodes),
    "[verify] independent absence error codes drifted",
  );
  requireDistinctProviderIds([
    target.deletion.providerRequestId,
    target.operatorReadback.providerRequestId,
    self.providerRequestId,
    independent.providerRequestId,
  ], "[verify] lifecycle provider request IDs");
  const receipt = {
    ...liveEnvelope(
      "verify-revocation",
      independentReadbackAt,
      false,
    ),
    target: publicTarget(target),
    predecessors: {
      probeReceiptSha256: target.probeReceiptSha256,
      revokeReceiptSha256: target.revokeReceiptSha256,
      revokeObservedAt: target.revokeCapturedAt,
    },
    authority: authorityReceipt(
      "lifecycle-verifier",
      "cloudflare-account-api-token-read",
      self,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      targetRole: "publisher",
      targetCredentialIdSha256:
        target.publisherCredentialIdSha256,
      independentReadbackAt,
      independentReadbackErrorCodes: independent.errorCodes,
      independentReadbackHttpStatus: independent.httpStatus,
      independentReadbackRequestId: independent.providerRequestId,
      independentReadbackResponseBodySha256:
        independent.responseBodySha256,
      targetAbsenceIndependentlyObserved: true,
    },
    providerOperations: [
      lifecycleOperation(
        "GET",
        "lifecycle-verifier-preflight",
        self,
      ),
      lifecycleOperation(
        "GET",
        "independent-revocation-readback",
        independent,
      ),
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.apiToken,
    credentials.targetTokenId,
    target.accountId,
  ]);
  return receipt;
}

export function normalizePublisherVerifyReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "verify-revocation",
    false,
  );
  requirePublicTarget(
    parsed.receipt.target,
    target,
    "verify-revocation",
  );
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] publisher verify predecessors",
  );
  exactKeys(
    predecessors,
    [
      "probeReceiptSha256",
      "revokeReceiptSha256",
      "revokeObservedAt",
    ],
    "[predecessor] publisher verify predecessors",
  );
  requireCondition(
    predecessors.probeReceiptSha256 === target.probeReceiptSha256 &&
      predecessors.revokeReceiptSha256 ===
        target.revokeReceiptSha256 &&
      predecessors.revokeObservedAt === target.revokeCapturedAt,
    "[predecessor] publisher verify chain drifted",
  );
  const authority = normalizeAuthorityReceipt(
    parsed.receipt.authority,
    "lifecycle-verifier",
    "cloudflare-account-api-token-read",
    target.lifecycleVerifierCredentialIdSha256,
  );
  const facts = normalizeVerifyFacts(parsed.receipt.facts, target);
  requireCondition(
    target.revokeCapturedAt < authority.selfVerifiedAt &&
      authority.selfVerifiedAt < facts.independentReadbackAt &&
      facts.independentReadbackAt === parsed.capturedAt &&
      parsed.capturedAt < authority.expiresAt,
    "[predecessor] publisher verify chronology drifted",
  );
  validateVerifyOperations(
    parsed.receipt.providerOperations,
    authority,
    facts,
    target,
  );
  validateLimitsAndAuthority(
    parsed.receipt,
    "verify-revocation",
  );
  return {
    ...target,
    verifyReceiptSha256: parsed.receiptSha256,
    verifyCapturedAt: parsed.capturedAt,
    lifecycleVerifierSelfVerifiedAt: authority.selfVerifiedAt,
    independentReadback: {
      at: facts.independentReadbackAt,
      httpStatus: facts.independentReadbackHttpStatus,
      providerRequestId: facts.independentReadbackRequestId,
      responseBodySha256:
        facts.independentReadbackResponseBodySha256,
      errorCodes: facts.independentReadbackErrorCodes,
    },
  };
}

export async function collectPostProbeReadback(options) {
  const {
    target,
    credentials,
    s3,
    now = () => new Date(),
  } = options;
  requireCondition(
    s3 && typeof s3.getObject === "function",
    "[object-readback] S3 adapter is incomplete",
  );
  requireCondition(
    credentials.credentialIdSha256 ===
      target.objectVerifierCredentialIdSha256,
    "[object-readback] object verifier credential drifted",
  );
  const response = await invokeObjectReadback(
    s3,
    target,
    target.probeObject,
  );
  const metadata = normalizeObjectResponse(
    response,
    target.probeObject,
  );
  const body = await hashBoundedBody(
    response.Body,
    target.probeObject.bytes,
    target.probeObject.sha256,
  );
  const readBackAt = requireTimestamp(
    now(),
    "[object-readback] readback time",
  );
  requireCondition(
    target.verifyCapturedAt < readBackAt &&
      target.overwriteProbe.completedAt < readBackAt &&
      target.deleteProbe.completedAt < readBackAt,
    "[object-readback] readback chronology is invalid",
  );
  const finalReadback = {
    readBackAt,
    httpStatus: metadata.httpStatus,
    providerRequestId: metadata.providerRequestId,
    bytes: body.bytes,
    sha256: body.sha256,
    etag: target.probeObject.etag,
  };
  requireDistinctProviderIds([
    target.publisherPreflight.providerRequestId,
    target.overwriteProbe.providerRequestId,
    target.deleteProbe.providerRequestId,
    finalReadback.providerRequestId,
  ], "[object-readback] provider request IDs");
  const receipt = {
    ...liveEnvelope("object-readback", readBackAt, false),
    target: publicTarget(target),
    predecessors: {
      objectReadbackReceiptSha256:
        target.objectReadbackReceiptSha256,
      probeReceiptSha256: target.probeReceiptSha256,
      revokeReceiptSha256: target.revokeReceiptSha256,
      verifyReceiptSha256: target.verifyReceiptSha256,
    },
    credential: credentialReceipt(
      "object-verifier",
      "r2-object-read-api-token",
      credentials.credentialIdSha256,
    ),
    facts: {
      accountIdSha256: target.accountIdSha256,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
      prefix: target.prefix,
      publisherCredentialIdSha256:
        target.publisherCredentialIdSha256,
      objectVerifierCredentialIdSha256:
        target.objectVerifierCredentialIdSha256,
      targetObjectKind: target.probeObject.kind,
      targetKey: target.probeObject.key,
      originalSha256: target.probeObject.sha256,
      originalBytes: target.probeObject.bytes,
      publisherPreflight: target.publisherPreflight,
      overwrite: target.overwriteProbe,
      delete: target.deleteProbe,
      finalReadback,
    },
    providerOperations: [
      {
        method: "GET",
        operation: "GetObject",
        condition: "If-Match",
        key: target.probeObject.key,
        httpStatus: metadata.httpStatus,
        providerRequestId: metadata.providerRequestId,
        etag: target.probeObject.etag,
        bytes: body.bytes,
        sha256: body.sha256,
      },
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    target.accountId,
  ]);
  return receipt;
}

export function normalizePostReadbackReceipt(options) {
  const target = options.target;
  const parsed = requireLiveReceipt(
    options.receipt,
    options.receiptText,
    "object-readback",
    false,
  );
  requirePublicTarget(
    parsed.receipt.target,
    target,
    "object-readback",
  );
  const predecessors = requireObject(
    parsed.receipt.predecessors,
    "[predecessor] post-readback predecessors",
  );
  exactKeys(
    predecessors,
    [
      "objectReadbackReceiptSha256",
      "probeReceiptSha256",
      "revokeReceiptSha256",
      "verifyReceiptSha256",
    ],
    "[predecessor] post-readback predecessors",
  );
  requireCondition(
    predecessors.objectReadbackReceiptSha256 ===
        target.objectReadbackReceiptSha256 &&
      predecessors.probeReceiptSha256 === target.probeReceiptSha256 &&
      predecessors.revokeReceiptSha256 ===
        target.revokeReceiptSha256 &&
      predecessors.verifyReceiptSha256 ===
        target.verifyReceiptSha256,
    "[predecessor] post-readback receipt chain drifted",
  );
  requireCredentialReceipt(
    parsed.receipt.credential,
    "object-verifier",
    "r2-object-read-api-token",
    target.objectVerifierCredentialIdSha256,
  );
  const facts = normalizePostReadbackFacts(
    parsed.receipt.facts,
    target,
  );
  requireCondition(
    target.verifyCapturedAt < facts.finalReadback.readBackAt &&
      facts.finalReadback.readBackAt === parsed.capturedAt,
    "[predecessor] post-readback chronology drifted",
  );
  validatePostReadbackOperations(
    parsed.receipt.providerOperations,
    target,
    facts.finalReadback,
  );
  validateLimitsAndAuthority(
    parsed.receipt,
    "object-readback",
  );
  return {
    ...target,
    postReadbackReceiptSha256: parsed.receiptSha256,
    postReadbackCapturedAt: parsed.capturedAt,
    finalReadback: facts.finalReadback,
  };
}

export function normalizeFinalLockPredecessors(options) {
  const target = options.target;
  const lock = normalizeLockPredecessor({
    accountId: target.accountId,
    receipt: options.lockReceipt,
    receiptText: options.lockReceiptText,
  });
  requireCondition(
    sameTarget(target, lock) &&
      lock.targetCredentialIdSha256 ===
        target.lockOperatorCredentialIdSha256 &&
      lock.lockReceiptSha256 === target.lockReceiptSha256,
    "[predecessor] final lock receipt chain drifted",
  );
  return {
    ...target,
    lockConfiguredAt: lock.lockConfiguredAt,
    lockConfigurationRequestId:
      lock.lockConfigurationRequestId,
    lockSelectedRuleId: lock.lockSelectedRuleId,
    lockRules: lock.lockRules,
  };
}

export async function collectFinalLockReadback(options) {
  const {
    target,
    credentials,
    lockApi,
    now = () => new Date(),
  } = options;
  requireCondition(
    lockApi &&
      typeof lockApi.verifySelf === "function" &&
      typeof lockApi.readLock === "function",
    "[lock-readback] lock API adapter is incomplete",
  );
  const self = normalizeTokenVerification(
    await lockApi.verifySelf({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      role: "lock-verifier",
    }),
    requireTimestamp(
      now(),
      "[lock-readback] verifier verification time",
    ),
    "lock-verifier",
  );
  requireCondition(
    !identityDigests(target).includes(self.credentialIdSha256),
    "[lock-readback] lock verifier identity is not independent",
  );
  requireCondition(
    target.postReadbackCapturedAt < self.selfVerifiedAt,
    "[lock-readback] verifier preflight predates object readback",
  );
  const readback = normalizeLockResponse(
    await lockApi.readLock({
      accountId: target.accountId,
      apiToken: credentials.apiToken,
      bucketName: target.bucketName,
    }),
  );
  const observedAt = requireTimestamp(
    now(),
    "[lock-readback] observed time",
  );
  requireCondition(
    self.selfVerifiedAt < observedAt &&
      observedAt < self.expiresAt &&
      canonicalJson(readback.rules) ===
        canonicalJson(target.lockRules),
    "[lock-readback] lock rules or chronology drifted",
  );
  requireCondition(
    readback.rules.some(
      (rule) =>
        rule.id === target.lockSelectedRuleId &&
        rule.enabled === true &&
        rule.prefix === target.prefix,
    ),
    "[lock-readback] selected lock rule is absent",
  );
  requireDistinctProviderIds([
    target.lockConfigurationRequestId,
    self.providerRequestId,
    readback.providerRequestId,
  ], "[lock-readback] provider request IDs");
  const receipt = {
    ...liveEnvelope("lock-readback", observedAt, false),
    target: publicTarget(target),
    predecessors: {
      lockReceiptSha256: target.lockReceiptSha256,
      postReadbackReceiptSha256:
        target.postReadbackReceiptSha256,
      verifyReceiptSha256: target.verifyReceiptSha256,
    },
    credential: {
      ...credentialReceipt(
        "lock-verifier",
        "cloudflare-r2-admin-read-api-token",
        self.credentialIdSha256,
      ),
      selfVerifiedAt: self.selfVerifiedAt,
      expiresAt: self.expiresAt,
      remainingLifetimeSeconds: self.remainingLifetimeSeconds,
    },
    facts: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      awsS3ObjectLockHeadersUsed: false,
      accountIdSha256: target.accountIdSha256,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
      prefix: target.prefix,
      lockVerifierCredentialIdSha256:
        self.credentialIdSha256,
      configuredAt: target.lockConfiguredAt,
      configurationRequestId:
        target.lockConfigurationRequestId,
      observedAt,
      readbackRequestId: readback.providerRequestId,
      httpStatus: readback.httpStatus,
      selectedRuleId: target.lockSelectedRuleId,
      rules: readback.rules,
    },
    providerOperations: [
      lifecycleOperation(
        "GET",
        "lock-verifier-preflight",
        self,
      ),
      {
        method: "GET",
        operation: "lock-final-readback",
        httpStatus: readback.httpStatus,
        providerRequestId: readback.providerRequestId,
        responseBodySha256: readback.responseBodySha256,
      },
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.apiToken,
    target.accountId,
  ]);
  return receipt;
}

function normalizeProbeFacts(value, target) {
  const facts = requireObject(value, "[predecessor] probe facts");
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "publisherCredentialIdSha256",
      "objectVerifierCredentialIdSha256",
      "targetObjectKind",
      "targetKey",
      "originalSha256",
      "originalBytes",
      "originalEtag",
      "publisherPreflight",
      "overwrite",
      "delete",
    ],
    "[predecessor] probe facts",
  );
  requireFactsTarget(facts, target, "probe");
  requireCondition(
    facts.publisherCredentialIdSha256 ===
        target.publisherCredentialIdSha256 &&
      facts.objectVerifierCredentialIdSha256 ===
        target.objectVerifierCredentialIdSha256 &&
      facts.targetObjectKind === target.probeObject.kind &&
      facts.targetKey === target.probeObject.key &&
      facts.originalSha256 === target.probeObject.sha256 &&
      facts.originalBytes === target.probeObject.bytes &&
      facts.originalEtag === target.probeObject.etag,
    "[predecessor] probe target drifted",
  );
  const publisherPreflight = normalizeProbeEvidence(
    facts.publisherPreflight,
    "put-object-create-only-preflight",
    target.enforcementProbePolicy.publisherPreflight,
    "If-None-Match:*",
    target.enforcementProbePolicy,
  );
  const overwrite = normalizeProbeEvidence(
    facts.overwrite,
    "put-object",
    target.enforcementProbePolicy.overwrite,
    null,
    target.enforcementProbePolicy,
  );
  const deletion = normalizeProbeEvidence(
    facts.delete,
    "delete-object",
    target.enforcementProbePolicy.delete,
    null,
    target.enforcementProbePolicy,
  );
  requireCondition(
    target.objectReadbackCapturedAt <
        publisherPreflight.attemptedAt &&
      publisherPreflight.completedAt < overwrite.attemptedAt &&
      overwrite.completedAt < deletion.attemptedAt &&
      overwrite.attemptedBytes > 0 &&
      overwrite.attemptedSha256 !== target.probeObject.sha256 &&
      deletion.attemptedBytes === 0 &&
      deletion.attemptedSha256 === target.probeObject.sha256 &&
      new Set([
        publisherPreflight.providerRequestId,
        overwrite.providerRequestId,
        deletion.providerRequestId,
      ]).size === 3,
    "[predecessor] probe evidence is invalid",
  );
  return {
    ...facts,
    publisherPreflight,
    overwrite,
    delete: deletion,
  };
}

function normalizeRevokeFacts(value, target) {
  const facts = requireObject(
    value,
    "[predecessor] publisher revoke facts",
  );
  exactKeys(
    facts,
    [
      "apiSurface",
      "targetRole",
      "targetCredentialIdSha256",
      "deletedAt",
      "deletionHttpStatus",
      "deletionRequestId",
      "deletionResponseBodySha256",
      "deletionResultIdSha256",
      "operatorReadbackAt",
      "operatorReadbackErrorCodes",
      "operatorReadbackHttpStatus",
      "operatorReadbackRequestId",
      "operatorReadbackResponseBodySha256",
      "targetAbsentAfterDelete",
    ],
    "[predecessor] publisher revoke facts",
  );
  const deletedAt = requireCanonicalTimestamp(
    facts.deletedAt,
    "[predecessor] publisher deletion time",
  );
  const operatorReadbackAt = requireCanonicalTimestamp(
    facts.operatorReadbackAt,
    "[predecessor] publisher operator readback time",
  );
  requireCondition(
    facts.apiSurface === "cloudflare-account-token-api" &&
      facts.targetRole === "publisher" &&
      facts.targetCredentialIdSha256 ===
        target.publisherCredentialIdSha256 &&
      facts.deletionHttpStatus === 200 &&
      validProviderId(facts.deletionRequestId) &&
      SHA256_PATTERN.test(facts.deletionResponseBodySha256) &&
      facts.deletionResultIdSha256 ===
        target.publisherCredentialIdSha256 &&
      facts.operatorReadbackHttpStatus === 404 &&
      validProviderId(facts.operatorReadbackRequestId) &&
      SHA256_PATTERN.test(
        facts.operatorReadbackResponseBodySha256,
      ) &&
      validErrorCodes(facts.operatorReadbackErrorCodes) &&
      facts.targetAbsentAfterDelete === true,
    "[predecessor] publisher revoke facts drifted",
  );
  return { ...facts, deletedAt, operatorReadbackAt };
}

function normalizeVerifyFacts(value, target) {
  const facts = requireObject(
    value,
    "[predecessor] publisher verify facts",
  );
  exactKeys(
    facts,
    [
      "apiSurface",
      "targetRole",
      "targetCredentialIdSha256",
      "independentReadbackAt",
      "independentReadbackErrorCodes",
      "independentReadbackHttpStatus",
      "independentReadbackRequestId",
      "independentReadbackResponseBodySha256",
      "targetAbsenceIndependentlyObserved",
    ],
    "[predecessor] publisher verify facts",
  );
  const independentReadbackAt = requireCanonicalTimestamp(
    facts.independentReadbackAt,
    "[predecessor] publisher independent readback time",
  );
  requireCondition(
    facts.apiSurface === "cloudflare-account-token-api" &&
      facts.targetRole === "publisher" &&
      facts.targetCredentialIdSha256 ===
        target.publisherCredentialIdSha256 &&
      facts.independentReadbackHttpStatus === 404 &&
      validProviderId(facts.independentReadbackRequestId) &&
      SHA256_PATTERN.test(
        facts.independentReadbackResponseBodySha256,
      ) &&
      validErrorCodes(facts.independentReadbackErrorCodes) &&
      canonicalJson(facts.independentReadbackErrorCodes) ===
        canonicalJson(target.operatorReadbackErrorCodes) &&
      facts.targetAbsenceIndependentlyObserved === true,
    "[predecessor] publisher verify facts drifted",
  );
  return { ...facts, independentReadbackAt };
}

function normalizeEmergencyRevokeFacts(
  value,
  target,
  incidentSha256,
) {
  const facts = requireObject(
    value,
    "[predecessor] emergency revoke facts",
  );
  exactKeys(
    facts,
    [
      "apiSurface",
      "targetRole",
      "targetCredentialIdSha256",
      "deletedAt",
      "deletionHttpStatus",
      "deletionRequestId",
      "deletionResponseBodySha256",
      "deletionResultIdSha256",
      "operatorReadbackAt",
      "operatorReadbackErrorCodes",
      "operatorReadbackHttpStatus",
      "operatorReadbackRequestId",
      "operatorReadbackResponseBodySha256",
      "targetAbsentAfterDelete",
      "emergency",
      "positiveEvidenceEligible",
      "incidentSha256",
    ],
    "[predecessor] emergency revoke facts",
  );
  const {
    emergency,
    positiveEvidenceEligible,
    incidentSha256: factsIncidentSha256,
    ...base
  } = facts;
  const normalized = normalizeRevokeFacts(base, target);
  requireCondition(
    emergency === true &&
      positiveEvidenceEligible === false &&
      factsIncidentSha256 === incidentSha256,
    "[predecessor] emergency revoke authority drifted",
  );
  return {
    ...normalized,
    emergency,
    positiveEvidenceEligible,
    incidentSha256: factsIncidentSha256,
  };
}

function normalizeEmergencyVerifyFacts(value, target) {
  const facts = requireObject(
    value,
    "[predecessor] emergency verify facts",
  );
  exactKeys(
    facts,
    [
      "apiSurface",
      "targetRole",
      "targetCredentialIdSha256",
      "independentReadbackAt",
      "independentReadbackErrorCodes",
      "independentReadbackHttpStatus",
      "independentReadbackRequestId",
      "independentReadbackResponseBodySha256",
      "targetAbsenceIndependentlyObserved",
      "emergency",
      "positiveEvidenceEligible",
      "incidentSha256",
    ],
    "[predecessor] emergency verify facts",
  );
  const {
    emergency,
    positiveEvidenceEligible,
    incidentSha256,
    ...base
  } = facts;
  const normalized = normalizeVerifyFacts(base, {
    ...target,
    operatorReadbackErrorCodes:
      target.emergencyOperatorReadbackErrorCodes,
  });
  requireCondition(
    emergency === true &&
      positiveEvidenceEligible === false &&
      incidentSha256 === target.incidentSha256,
    "[predecessor] emergency verify authority drifted",
  );
  return {
    ...normalized,
    emergency,
    positiveEvidenceEligible,
    incidentSha256,
  };
}

function normalizePostReadbackFacts(value, target) {
  const facts = requireObject(
    value,
    "[predecessor] post-readback facts",
  );
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "publisherCredentialIdSha256",
      "objectVerifierCredentialIdSha256",
      "targetObjectKind",
      "targetKey",
      "originalSha256",
      "originalBytes",
      "publisherPreflight",
      "overwrite",
      "delete",
      "finalReadback",
    ],
    "[predecessor] post-readback facts",
  );
  requireFactsTarget(facts, target, "post-readback");
  requireCondition(
    facts.publisherCredentialIdSha256 ===
        target.publisherCredentialIdSha256 &&
      facts.objectVerifierCredentialIdSha256 ===
        target.objectVerifierCredentialIdSha256 &&
      facts.targetObjectKind === target.probeObject.kind &&
      facts.targetKey === target.probeObject.key &&
      facts.originalSha256 === target.probeObject.sha256 &&
      facts.originalBytes === target.probeObject.bytes,
    "[predecessor] post-readback target drifted",
  );
  const publisherPreflight = normalizeProbeEvidence(
    facts.publisherPreflight,
    "put-object-create-only-preflight",
    target.enforcementProbePolicy.publisherPreflight,
    "If-None-Match:*",
    target.enforcementProbePolicy,
  );
  const overwrite = normalizeProbeEvidence(
    facts.overwrite,
    "put-object",
    target.enforcementProbePolicy.overwrite,
    null,
    target.enforcementProbePolicy,
  );
  const deletion = normalizeProbeEvidence(
    facts.delete,
    "delete-object",
    target.enforcementProbePolicy.delete,
    null,
    target.enforcementProbePolicy,
  );
  requireCondition(
    canonicalJson(publisherPreflight) ===
        canonicalJson(target.publisherPreflight) &&
      canonicalJson(overwrite) === canonicalJson(target.overwriteProbe) &&
      canonicalJson(deletion) === canonicalJson(target.deleteProbe),
    "[predecessor] post-readback probe evidence drifted",
  );
  const finalReadback = requireObject(
    facts.finalReadback,
    "[predecessor] final object readback",
  );
  exactKeys(
    finalReadback,
    [
      "readBackAt",
      "httpStatus",
      "providerRequestId",
      "bytes",
      "sha256",
      "etag",
    ],
    "[predecessor] final object readback",
  );
  const readBackAt = requireCanonicalTimestamp(
    finalReadback.readBackAt,
    "[predecessor] final object readback time",
  );
  requireCondition(
    finalReadback.httpStatus === 200 &&
      validProviderId(finalReadback.providerRequestId) &&
      finalReadback.bytes === target.probeObject.bytes &&
      finalReadback.sha256 === target.probeObject.sha256 &&
      finalReadback.etag === target.probeObject.etag &&
      target.overwriteProbe.completedAt < readBackAt &&
      target.deleteProbe.completedAt < readBackAt,
    "[predecessor] final object readback drifted",
  );
  requireDistinctProviderIds([
    publisherPreflight.providerRequestId,
    overwrite.providerRequestId,
    deletion.providerRequestId,
    finalReadback.providerRequestId,
  ], "[predecessor] enforcement request IDs");
  return {
    ...facts,
    publisherPreflight,
    overwrite,
    delete: deletion,
    finalReadback: { ...finalReadback, readBackAt },
  };
}

function normalizeProbeEvidence(
  value,
  operation,
  rejectionPolicy,
  condition,
  policy,
) {
  const probe = requireObject(value, `[predecessor] ${operation}`);
  exactKeys(
    probe,
    [
      "operation",
      ...(condition === null ? [] : ["condition"]),
      "attemptedAt",
      "completedAt",
      "attemptedBytes",
      "attemptedSha256",
      "transportCompleted",
      "timedOut",
      "clientSideOnly",
      "providerRejected",
      "httpStatus",
      "errorCode",
      "providerRequestId",
      "requestIdSource",
      "responseContentType",
      "responseBytes",
      "responseBodySha256",
    ],
    `[predecessor] ${operation}`,
  );
  const attemptedAt = requireCanonicalTimestamp(
    probe.attemptedAt,
    `[predecessor] ${operation} time`,
  );
  const completedAt = requireCanonicalTimestamp(
    probe.completedAt,
    `[predecessor] ${operation} completion time`,
  );
  requireCondition(
    probe.operation === operation &&
      (condition === null || probe.condition === condition) &&
      Number.isSafeInteger(probe.attemptedBytes) &&
      probe.attemptedBytes >= 0 &&
      SHA256_PATTERN.test(probe.attemptedSha256) &&
      attemptedAt < completedAt &&
      probe.transportCompleted === true &&
      probe.timedOut === false &&
      probe.clientSideOnly === false &&
      probe.providerRejected === true &&
      probe.httpStatus === rejectionPolicy.httpStatus &&
      rejectionPolicy.errorCodes.includes(probe.errorCode) &&
      validProviderId(probe.providerRequestId) &&
      policy.requestIdSources.includes(probe.requestIdSource) &&
      policy.responseContentTypes.includes(
        probe.responseContentType,
      ) &&
      Number.isSafeInteger(probe.responseBytes) &&
      probe.responseBytes > 0 &&
      probe.responseBytes <= MAX_RESPONSE_BYTES &&
      SHA256_PATTERN.test(probe.responseBodySha256),
    `[predecessor] ${operation} is ambiguous`,
  );
  return { ...probe, attemptedAt, completedAt };
}

function normalizeProbeResult(
  value,
  operation,
  attemptedAt,
  completedAt,
  attemptedBytes,
  attemptedSha256,
  rejectionPolicy,
  condition,
  policy,
) {
  value = requireObject(value, `[probe] ${operation} response`);
  exactKeys(
    value,
    [
      "transportCompleted",
      "timedOut",
      "clientSideOnly",
      "providerRejected",
      "httpStatus",
      "errorCode",
      "providerRequestId",
      "requestIdSource",
      "responseContentType",
      "responseBytes",
      "responseBodySha256",
    ],
    `[probe] ${operation} response`,
  );
  requireCondition(
    value.transportCompleted === true &&
      value.timedOut === false &&
      value.clientSideOnly === false &&
      value.providerRejected === true &&
      attemptedAt < completedAt &&
      value.httpStatus === rejectionPolicy.httpStatus &&
      rejectionPolicy.errorCodes.includes(value.errorCode) &&
      validProviderId(value.providerRequestId) &&
      policy.requestIdSources.includes(value.requestIdSource) &&
      policy.responseContentTypes.includes(value.responseContentType) &&
      Number.isSafeInteger(value.responseBytes) &&
      value.responseBytes > 0 &&
      value.responseBytes <= MAX_RESPONSE_BYTES &&
      SHA256_PATTERN.test(value.responseBodySha256),
    `[probe] ${operation} was not an unambiguous provider rejection`,
  );
  return {
    operation,
    ...(condition === null ? {} : { condition }),
    attemptedAt,
    completedAt,
    attemptedBytes,
    attemptedSha256,
    ...value,
  };
}

function normalizeTokenVerification(value, selfVerifiedAt, role) {
  value = requireObject(value, `[${role}] verification response`);
  exactKeys(
    value,
    [
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "credentialId",
      "status",
      "expiresAt",
      "notBefore",
    ],
    `[${role}] verification response`,
  );
  const expiresAt = requireCanonicalTimestamp(
    value.expiresAt,
    `[${role}] expiry`,
  );
  const notBefore =
    value.notBefore === null
      ? null
      : requireCanonicalTimestamp(
          value.notBefore,
          `[${role}] not-before`,
        );
  const remainingMs =
    Date.parse(expiresAt) - Date.parse(selfVerifiedAt);
  requireCondition(
    value.httpStatus === 200 &&
      validProviderId(value.providerRequestId) &&
      SHA256_PATTERN.test(value.responseBodySha256) &&
      TOKEN_ID_PATTERN.test(value.credentialId) &&
      value.status === "active" &&
      (notBefore === null || notBefore <= selfVerifiedAt) &&
      remainingMs >= 1_000 &&
      remainingMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000,
    `[${role}] identity, status, or lifetime is invalid`,
  );
  return {
    httpStatus: value.httpStatus,
    providerRequestId: value.providerRequestId,
    responseBodySha256: value.responseBodySha256,
    credentialIdSha256: sha256Text(value.credentialId),
    selfVerifiedAt,
    expiresAt,
    remainingLifetimeSeconds: Math.floor(remainingMs / 1_000),
  };
}

function normalizeDeletion(value, targetTokenId) {
  value = requireObject(value, "[revoke] deletion response");
  exactKeys(
    value,
    [
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "resultId",
    ],
    "[revoke] deletion response",
  );
  requireCondition(
    value.httpStatus === 200 &&
      validProviderId(value.providerRequestId) &&
      SHA256_PATTERN.test(value.responseBodySha256) &&
      value.resultId === targetTokenId,
    "[revoke] provider deleted an unexpected token",
  );
  return {
    ...value,
    resultIdSha256: sha256Text(value.resultId),
  };
}

function normalizeAbsence(value, label) {
  value = requireObject(value, `[${label}] absence response`);
  exactKeys(
    value,
    [
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "errorCodes",
    ],
    `[${label}] absence response`,
  );
  requireCondition(
    value.httpStatus === 404 &&
      validProviderId(value.providerRequestId) &&
      SHA256_PATTERN.test(value.responseBodySha256) &&
      validErrorCodes(value.errorCodes),
    `[${label}] absence response is ambiguous`,
  );
  return value;
}

function normalizeObjectResponse(response, object) {
  response = requireObject(response, "[object-readback] response");
  const metadata = requireObject(
    response.$metadata,
    "[object-readback] response metadata",
  );
  const customMetadata = requireObject(
    response.Metadata,
    "[object-readback] custom metadata",
  );
  exactKeys(
    customMetadata,
    ["contract", "repositorycommit", "sha256"],
    "[object-readback] custom metadata",
  );
  requireCondition(
    metadata.httpStatusCode === 200 &&
      validProviderId(metadata.requestId) &&
      response.ContentLength === object.bytes &&
      response.ETag === object.etag &&
      response.ContentType === object.contentType &&
      customMetadata.contract === object.customMetadata.contract &&
      customMetadata.repositorycommit ===
        object.customMetadata.repositoryCommit &&
      customMetadata.sha256 === object.sha256,
    "[object-readback] response headers drifted",
  );
  return {
    httpStatus: metadata.httpStatusCode,
    providerRequestId: metadata.requestId,
  };
}

function normalizeLockResponse(value) {
  value = requireObject(value, "[lock-readback] provider response");
  exactKeys(
    value,
    [
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
      "rules",
    ],
    "[lock-readback] provider response",
  );
  requireCondition(
    value.httpStatus === 200 &&
      validProviderId(value.providerRequestId) &&
      SHA256_PATTERN.test(value.responseBodySha256) &&
      Array.isArray(value.rules) &&
      value.rules.length > 0 &&
      value.rules.length <= 1_000,
    "[lock-readback] provider response is invalid",
  );
  return value;
}

function normalizeAuthorityReceipt(
  value,
  role,
  credentialType,
  expectedCredentialIdSha256,
) {
  const authority = requireObject(
    value,
    "[predecessor] lifecycle authority",
  );
  exactKeys(
    authority,
    [
      "role",
      "credentialType",
      "credentialIdSha256",
      "selfVerifiedAt",
      "expiresAt",
      "remainingLifetimeSeconds",
    ],
    "[predecessor] lifecycle authority",
  );
  const selfVerifiedAt = requireCanonicalTimestamp(
    authority.selfVerifiedAt,
    "[predecessor] lifecycle self-verification time",
  );
  const expiresAt = requireCanonicalTimestamp(
    authority.expiresAt,
    "[predecessor] lifecycle expiry",
  );
  const remainingMs =
    Date.parse(expiresAt) - Date.parse(selfVerifiedAt);
  requireCondition(
    authority.role === role &&
      authority.credentialType === credentialType &&
      authority.credentialIdSha256 === expectedCredentialIdSha256 &&
      remainingMs >= 1_000 &&
      remainingMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000 &&
      authority.remainingLifetimeSeconds ===
        Math.floor(remainingMs / 1_000),
    "[predecessor] lifecycle authority drifted",
  );
  return { ...authority, selfVerifiedAt, expiresAt };
}

function validateProbeOperations(values, facts) {
  requireCondition(
    Array.isArray(values) && values.length === 3,
    "[predecessor] probe operations are incomplete",
  );
  for (const [index, expected] of [
    facts.publisherPreflight,
    facts.overwrite,
    facts.delete,
  ].entries()) {
    const operation = requireObject(
      values[index],
      "[predecessor] probe operation",
    );
    exactKeys(
      operation,
      [
        "method",
        "operation",
        ...(expected.condition ? ["condition"] : []),
        "attemptedAt",
        "completedAt",
        "httpStatus",
        "errorCode",
        "providerRequestId",
        "responseBodySha256",
      ],
      "[predecessor] probe operation",
    );
    requireCondition(
      operation.method ===
          (expected.operation.startsWith("put-object")
            ? "PUT"
            : "DELETE") &&
        operation.operation === expected.operation &&
        (!expected.condition ||
          operation.condition === expected.condition) &&
        operation.attemptedAt === expected.attemptedAt &&
        operation.completedAt === expected.completedAt &&
        operation.httpStatus === expected.httpStatus &&
        operation.errorCode === expected.errorCode &&
        operation.providerRequestId === expected.providerRequestId &&
        operation.responseBodySha256 ===
          expected.responseBodySha256,
      "[predecessor] probe operation drifted",
    );
  }
}

function validateRevokeOperations(values, authority, facts) {
  requireCondition(
    Array.isArray(values) && values.length === 3,
    "[predecessor] revoke operations are incomplete",
  );
  const expected = [
    ["GET", "lifecycle-operator-preflight", 200, null],
    [
      "DELETE",
      "publisher-delete",
      200,
      {
        providerRequestId: facts.deletionRequestId,
        responseBodySha256: facts.deletionResponseBodySha256,
      },
    ],
    [
      "GET",
      "operator-revocation-readback",
      404,
      {
        providerRequestId: facts.operatorReadbackRequestId,
        responseBodySha256:
          facts.operatorReadbackResponseBodySha256,
      },
    ],
  ];
  validateLifecycleOperations(values, expected);
  requireDistinctProviderIds(
    values.map((value) => value.providerRequestId),
    "[predecessor] revoke request IDs",
  );
}

function validateVerifyOperations(values, authority, facts, target) {
  requireCondition(
    Array.isArray(values) && values.length === 2,
    "[predecessor] verify operations are incomplete",
  );
  validateLifecycleOperations(values, [
    ["GET", "lifecycle-verifier-preflight", 200, null],
    [
      "GET",
      "independent-revocation-readback",
      404,
      {
        providerRequestId: facts.independentReadbackRequestId,
        responseBodySha256:
          facts.independentReadbackResponseBodySha256,
      },
    ],
  ]);
  requireDistinctProviderIds([
    target.deletion.providerRequestId,
    target.operatorReadback.providerRequestId,
    values[0].providerRequestId,
    values[1].providerRequestId,
  ], "[predecessor] lifecycle request IDs");
}

function validateLifecycleOperations(values, expected) {
  for (let index = 0; index < expected.length; index += 1) {
    const operation = requireObject(
      values[index],
      "[predecessor] lifecycle operation",
    );
    exactKeys(
      operation,
      [
        "method",
        "operation",
        "httpStatus",
        "providerRequestId",
        "responseBodySha256",
      ],
      "[predecessor] lifecycle operation",
    );
    const [method, name, status, source] = expected[index];
    requireCondition(
      operation.method === method &&
        operation.operation === name &&
        operation.httpStatus === status &&
        validProviderId(operation.providerRequestId) &&
        SHA256_PATTERN.test(operation.responseBodySha256) &&
        (source === null ||
          (operation.providerRequestId === source.providerRequestId &&
            operation.responseBodySha256 ===
              source.responseBodySha256)),
      "[predecessor] lifecycle operation drifted",
    );
  }
}

function validatePostReadbackOperations(values, target, finalReadback) {
  requireCondition(
    Array.isArray(values) && values.length === 1,
    "[predecessor] post-readback operations are incomplete",
  );
  const operation = requireObject(
    values[0],
    "[predecessor] post-readback operation",
  );
  exactKeys(
    operation,
    [
      "method",
      "operation",
      "condition",
      "key",
      "httpStatus",
      "providerRequestId",
      "etag",
      "bytes",
      "sha256",
    ],
    "[predecessor] post-readback operation",
  );
  requireCondition(
    operation.method === "GET" &&
      operation.operation === "GetObject" &&
      operation.condition === "If-Match" &&
      operation.key === target.probeObject.key &&
      operation.httpStatus === finalReadback.httpStatus &&
      operation.providerRequestId ===
        finalReadback.providerRequestId &&
      operation.etag === finalReadback.etag &&
      operation.bytes === finalReadback.bytes &&
      operation.sha256 === finalReadback.sha256,
    "[predecessor] post-readback operation drifted",
  );
}

async function hashBoundedBody(body, expectedBytes, expectedSha256) {
  requireCondition(
    body && typeof body[Symbol.asyncIterator] === "function",
    "[object-readback] response body is not streamable",
  );
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of body) {
    const chunk =
      Buffer.isBuffer(rawChunk)
        ? rawChunk
        : rawChunk instanceof Uint8Array
          ? Buffer.from(
              rawChunk.buffer,
              rawChunk.byteOffset,
              rawChunk.byteLength,
            )
          : null;
    requireCondition(
      chunk !== null && chunk.length > 0,
      "[object-readback] response body chunk is invalid",
    );
    bytes += chunk.length;
    requireCondition(
      bytes <= expectedBytes && bytes <= MAX_OBJECT_BYTES,
      "[object-readback] response body exceeded its bound",
    );
    digest.update(chunk);
  }
  const sha256Value = digest.digest("hex");
  requireCondition(
    bytes === expectedBytes && sha256Value === expectedSha256,
    "[object-readback] response body digest or size drifted",
  );
  return { bytes, sha256: sha256Value };
}

async function invokeObjectReadback(s3, target, object) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await s3.getObject(
      {
        Bucket: target.bucketName,
        Key: object.key,
        IfMatch: object.etag,
      },
      controller.signal,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new WormEnforcementCollectorError(
        "[object-readback] provider request timed out",
      );
    }
    throw new WormEnforcementCollectorError(
      "[object-readback] provider request failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeProbe(call, label) {
  try {
    return await call();
  } catch {
    throw new WormEnforcementCollectorError(
      `[probe] ${label} provider request failed`,
    );
  }
}

function requireLiveReceipt(receipt, text, phase, mutation) {
  receipt = requireObject(
    receipt,
    `[predecessor] ${phase} receipt`,
  );
  const receiptText = requireCanonicalReceipt(
    receipt,
    text,
    `${phase} receipt`,
  );
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "contract",
      "source",
      "environment",
      "phase",
      "mode",
      "ok",
      "capturedAt",
      "networkRequests",
      "credentialsRead",
      "writesFiles",
      "providerMutationConfirmed",
      "mutationPerformed",
      "target",
      "predecessors",
      ...([
        "revoke",
        "verify-revocation",
        "emergency-revoke",
        "emergency-verify",
      ].includes(phase)
        ? ["authority"]
        : ["credential"]),
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    `[predecessor] ${phase} receipt`,
  );
  requireCondition(
    receipt.schemaVersion === WORM_ENFORCEMENT_SCHEMA_VERSION &&
      receipt.contract === WORM_ENFORCEMENT_RECEIPT_CONTRACT &&
      receipt.source === SOURCE &&
      receipt.environment === "staging" &&
      receipt.phase === phase &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.providerMutationConfirmed === mutation &&
      receipt.mutationPerformed === mutation,
    `[predecessor] ${phase} receipt authority is invalid`,
  );
  return {
    receipt,
    capturedAt: requireCanonicalTimestamp(
      receipt.capturedAt,
      `[predecessor] ${phase} capture time`,
    ),
    receiptSha256: sha256Text(receiptText),
  };
}

function liveEnvelope(phase, capturedAt, mutation) {
  return {
    schemaVersion: WORM_ENFORCEMENT_SCHEMA_VERSION,
    contract: WORM_ENFORCEMENT_RECEIPT_CONTRACT,
    source: SOURCE,
    environment: "staging",
    phase,
    mode: "live",
    ok: true,
    capturedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    providerMutationConfirmed: mutation,
    mutationPerformed: mutation,
  };
}

function publicTarget(target) {
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
    publisherCredentialIdSha256:
      target.publisherCredentialIdSha256,
    lockOperatorCredentialIdSha256:
      target.lockOperatorCredentialIdSha256,
    objectVerifierCredentialIdSha256:
      target.objectVerifierCredentialIdSha256,
    lifecycleOperatorCredentialIdSha256:
      target.lifecycleOperatorCredentialIdSha256,
    lifecycleVerifierCredentialIdSha256:
      target.lifecycleVerifierCredentialIdSha256,
  };
}

function requirePublicTarget(value, target, label) {
  value = requireObject(value, `[predecessor] ${label} target`);
  exactKeys(
    value,
    Object.keys(publicTarget(target)),
    `[predecessor] ${label} target`,
  );
  requireCondition(
    canonicalJson(value) === canonicalJson(publicTarget(target)),
    `[predecessor] ${label} target drifted`,
  );
}

function requireFactsTarget(facts, target, label) {
  requireCondition(
    facts.accountIdSha256 === target.accountIdSha256 &&
      facts.bucketName === target.bucketName &&
      facts.jurisdiction === target.jurisdiction &&
      facts.prefix === target.prefix,
    `[predecessor] ${label} provider target drifted`,
  );
}

function sameTarget(left, right) {
  return (
    left.accountIdSha256 === right.accountIdSha256 &&
    left.bucketName === right.bucketName &&
    left.jurisdiction === right.jurisdiction &&
    left.prefix === right.prefix &&
    left.statementSha256 === right.statementSha256
  );
}

function identityDigests(target) {
  return [
    target.publisherCredentialIdSha256,
    target.lockOperatorCredentialIdSha256,
    target.objectVerifierCredentialIdSha256,
    target.lifecycleOperatorCredentialIdSha256,
    target.lifecycleVerifierCredentialIdSha256,
  ];
}

function credentialReceipt(role, credentialType, credentialIdSha256) {
  return { role, credentialType, credentialIdSha256 };
}

function requireCredentialReceipt(
  value,
  role,
  credentialType,
  credentialIdSha256,
) {
  value = requireObject(value, "[predecessor] credential");
  exactKeys(
    value,
    ["role", "credentialType", "credentialIdSha256"],
    "[predecessor] credential",
  );
  requireCondition(
    value.role === role &&
      value.credentialType === credentialType &&
      value.credentialIdSha256 === credentialIdSha256,
    "[predecessor] credential binding drifted",
  );
}

function authorityReceipt(role, credentialType, identity) {
  return {
    role,
    credentialType,
    credentialIdSha256: identity.credentialIdSha256,
    selfVerifiedAt: identity.selfVerifiedAt,
    expiresAt: identity.expiresAt,
    remainingLifetimeSeconds: identity.remainingLifetimeSeconds,
  };
}

function revokeFacts(
  target,
  deletionResponse,
  deletedAt,
  operatorReadback,
  operatorReadbackAt,
) {
  return {
    apiSurface: "cloudflare-account-token-api",
    targetRole: "publisher",
    targetCredentialIdSha256:
      target.publisherCredentialIdSha256,
    deletedAt,
    deletionHttpStatus: deletionResponse.httpStatus,
    deletionRequestId: deletionResponse.providerRequestId,
    deletionResponseBodySha256:
      deletionResponse.responseBodySha256,
    deletionResultIdSha256: deletionResponse.resultIdSha256,
    operatorReadbackAt,
    operatorReadbackErrorCodes: operatorReadback.errorCodes,
    operatorReadbackHttpStatus: operatorReadback.httpStatus,
    operatorReadbackRequestId: operatorReadback.providerRequestId,
    operatorReadbackResponseBodySha256:
      operatorReadback.responseBodySha256,
    targetAbsentAfterDelete: true,
  };
}

function revokeOperations(self, deletionResponse, operatorReadback) {
  return [
    lifecycleOperation("GET", "lifecycle-operator-preflight", self),
    lifecycleOperation(
      "DELETE",
      "publisher-delete",
      deletionResponse,
    ),
    lifecycleOperation(
      "GET",
      "operator-revocation-readback",
      operatorReadback,
    ),
  ];
}

function verifyFacts(target, independent, independentReadbackAt) {
  return {
    apiSurface: "cloudflare-account-token-api",
    targetRole: "publisher",
    targetCredentialIdSha256:
      target.publisherCredentialIdSha256,
    independentReadbackAt,
    independentReadbackErrorCodes: independent.errorCodes,
    independentReadbackHttpStatus: independent.httpStatus,
    independentReadbackRequestId: independent.providerRequestId,
    independentReadbackResponseBodySha256:
      independent.responseBodySha256,
    targetAbsenceIndependentlyObserved: true,
  };
}

function verifyOperations(self, independent) {
  return [
    lifecycleOperation(
      "GET",
      "lifecycle-verifier-preflight",
      self,
    ),
    lifecycleOperation(
      "GET",
      "independent-revocation-readback",
      independent,
    ),
  ];
}

function lifecycleOperation(method, operation, response) {
  return {
    method,
    operation,
    httpStatus: response.httpStatus,
    providerRequestId: response.providerRequestId,
    responseBodySha256: response.responseBodySha256,
  };
}

function providerProbeOperation(probe) {
  return {
    method: probe.operation.startsWith("put-object") ? "PUT" : "DELETE",
    operation: probe.operation,
    ...(probe.condition ? { condition: probe.condition } : {}),
    attemptedAt: probe.attemptedAt,
    completedAt: probe.completedAt,
    httpStatus: probe.httpStatus,
    errorCode: probe.errorCode,
    providerRequestId: probe.providerRequestId,
    responseBodySha256: probe.responseBodySha256,
  };
}

function validateLimitsAndAuthority(receipt, label) {
  requireCondition(
    canonicalJson(receipt.limits) ===
      canonicalJson(collectorLimits()),
    `[predecessor] ${label} limits drifted`,
  );
  requireAllDownstreamFalse(
    receipt.downstreamAuthority,
    `[predecessor] ${label} downstream authority`,
  );
}

function collectorLimits() {
  return {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    responseBytes: MAX_RESPONSE_BYTES,
    objectBytes: MAX_OBJECT_BYTES,
    mutableCredentialRemainingSeconds:
      MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS,
  };
}

function downstreamAuthority() {
  return {
    lockOperatorRevocationVerified: false,
    publisherRevocationVerified: false,
    wormRetentionVerified: false,
    s3Complete: false,
    formalP5Evidence: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

function normalizeEnforcementProbePolicy(value) {
  value = requireObject(value, "[policy] enforcement probe policy");
  exactKeys(
    value,
    [
      "publisherPreflight",
      "overwrite",
      "delete",
      "responseContentTypes",
      "requestIdSources",
    ],
    "[policy] enforcement probe policy",
  );
  for (const [name, status, code] of [
    ["publisherPreflight", 412, "PreconditionFailed"],
    ["overwrite", 403, "AccessDenied"],
    ["delete", 403, "AccessDenied"],
  ]) {
    const tuple = requireObject(
      value[name],
      `[policy] ${name} rejection tuple`,
    );
    exactKeys(
      tuple,
      ["httpStatus", "errorCodes"],
      `[policy] ${name} rejection tuple`,
    );
    requireCondition(
      tuple.httpStatus === status &&
        canonicalJson(tuple.errorCodes) === canonicalJson([code]),
      `[policy] ${name} rejection tuple drifted`,
    );
  }
  requireCondition(
    canonicalJson(value.responseContentTypes) ===
        canonicalJson(["application/xml"]) &&
      canonicalJson(value.requestIdSources) ===
        canonicalJson(["cf-ray", "x-amz-request-id"]),
    "[policy] enforcement response policy drifted",
  );
  return structuredClone(value);
}

function requireAllDownstreamFalse(value, label) {
  value = requireObject(value, label);
  requireCondition(
    canonicalJson(value) === canonicalJson(downstreamAuthority()),
    `${label} overclaimed authority`,
  );
}

function readKeyPair(env, accessName, secretName) {
  const accessKeyId = requireCredential(env[accessName], accessName);
  const secretAccessKey = requireCredential(env[secretName], secretName);
  requireCondition(
    accessKeyId !== secretAccessKey,
    "[credentials] access and secret values must differ",
  );
  return {
    accessKeyId,
    secretAccessKey,
    credentialIdSha256: sha256Text(accessKeyId),
  };
}

function requireTargetToken(target, targetTokenId) {
  requireCondition(
    TOKEN_ID_PATTERN.test(targetTokenId) &&
      sha256Text(targetTokenId) ===
        target.publisherCredentialIdSha256,
    "[credentials] publisher token ID does not match the B4 access key",
  );
}

function requireLifecycleAdapter(adapter, phase) {
  requireCondition(
    adapter &&
      typeof adapter.verifySelf === "function" &&
      typeof adapter.readToken === "function" &&
      (phase !== "revoke" ||
        typeof adapter.deleteToken === "function"),
    `[${phase}] lifecycle adapter is incomplete`,
  );
}

function validProviderId(value) {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function validErrorCodes(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0,
    ) &&
    new Set(value).size === value.length
  );
}

function requireDistinctProviderIds(values, label) {
  requireCondition(
    values.every(validProviderId) &&
      new Set(values).size === values.length,
    `${label} are absent or reused`,
  );
}

function requireCanonicalReceipt(value, text, label) {
  requireCondition(
    typeof text === "string" &&
      Buffer.byteLength(text, "utf8") >= 2 &&
      Buffer.byteLength(text, "utf8") <= MAX_RESPONSE_BYTES &&
      text === `${canonicalJson(value)}\n`,
    `[predecessor] ${label} must be bounded canonical JSON plus one newline`,
  );
  return text;
}

function requireCanonicalTimestamp(value, label) {
  requireCondition(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      new Date(value).toISOString() === value,
    `${label} must be canonical UTC`,
  );
  return value;
}

function requireTimestamp(value, label) {
  const timestamp =
    value instanceof Date ? value.toISOString() : value;
  return requireCanonicalTimestamp(timestamp, label);
}

function requireCredential(value, label) {
  requireCondition(
    typeof value === "string" &&
      value.length >= 16 &&
      value.length <= 4096 &&
      !/[\r\n\0]/.test(value),
    `[credentials] ${label} is absent or malformed`,
  );
  return value;
}

function requirePattern(value, pattern, label) {
  requireCondition(
    typeof value === "string" && pattern.test(value),
    `${label} is malformed`,
  );
  return value;
}

function requirePhase(value) {
  requireCondition(
    PHASES.includes(value),
    "[input] enforcement phase is unsupported",
  );
}

function requireObject(value, label) {
  requireCondition(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, keys, label) {
  requireCondition(
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...keys].sort()),
    `${label} fields drifted`,
  );
}

function requireCondition(condition, message) {
  if (!condition) throw new WormEnforcementCollectorError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256(Buffer.from(value, "utf8"));
}

function assertSensitiveValuesAbsent(value, sensitiveValues) {
  const serialized = canonicalJson(value);
  for (const sensitive of sensitiveValues) {
    requireCondition(
      typeof sensitive !== "string" ||
        sensitive.length === 0 ||
        !serialized.includes(sensitive),
      "[redaction] receipt reflected sensitive input",
    );
  }
}

export class WormEnforcementCollectorError extends Error {}
