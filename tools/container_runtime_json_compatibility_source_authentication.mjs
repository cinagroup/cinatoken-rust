import { createHash } from "node:crypto";

import {
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityDeploymentStatePlan,
} from "./container_runtime_json_compatibility_deployment_states.mjs";
import {
  validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";
import {
  validateJsonCompatibilitySourceManifest,
} from "./container_runtime_json_compatibility_source_manifest.mjs";
import {
  accountBindingInventoryInputFromEvidence,
  validateJsonCompatibilityAccountBindingEvidence,
} from "./container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  validateJsonCompatibilityExternalWormArchiveEvidence,
} from "./container_runtime_json_compatibility_external_worm_archive.mjs";
import {
  validateJsonCompatibilityAccountBindingRawCaptureTerminal,
} from "./container_runtime_json_compatibility_account_binding_raw_capture.mjs";

export const JSON_COMPATIBILITY_SOURCE_ARTIFACT_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
export const JSON_COMPATIBILITY_TRANSITION_SOURCE_MANIFEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-transition-source-manifest-v1";
export const JSON_COMPATIBILITY_SOURCE_ACCOUNT_BINDING_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-account-binding-inventory-v1";
export const JSON_COMPATIBILITY_SOURCE_ARCHIVE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-immutable-archive-receipt-v3";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-signature-subject-v2";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-signature-envelope-v2";
export const JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v3";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-source-signature-v2\n";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER =
  "cinatoken-json-compatibility-source-archive-authority-staging";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
export const JSON_COMPATIBILITY_SOURCE_VERIFIER_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-verifier-identity-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_MAX_LIFETIME_SECONDS =
  7 * 24 * 60 * 60;
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_MIN_REMAINING_SECONDS =
  15 * 60;
export const JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS = 60 * 60;
export const JSON_COMPATIBILITY_SOURCE_MIN_ARCHIVE_RETENTION_SECONDS =
  365 * 24 * 60 * 60;

const SCHEMA_VERSION = 1;
const CAMPAIGN_PLAN_SCHEMA_VERSION = 4;
const STATE_PLAN_SCHEMA_VERSION = 2;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMPTY_ROUTE_SET_SHA256 = sha256Canonical([]);
const EXTERNAL_WORM_S3_CLOSURE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-binding-closure-v1";
const EXTERNAL_WORM_S3_CLOSURE_DECISION_SCOPE =
  "amazon-s3-provider-observation-to-external-worm-c2-evidence-binding-only";

export class JsonCompatibilitySourceAuthenticationProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilitySourceAuthenticationProtocolError";
    this.code = code;
  }
}

export function buildJsonCompatibilitySourceVerifierPolicy({
  serviceName,
  profileVersion,
  keyPrefix,
  issuer,
  audience,
  externalWormArchivePolicySha256,
  current: currentInput,
  previous: previousInput,
}) {
  equal(
    serviceName,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    "source verifier policy service name",
  );
  equal(profileVersion, 1, "source verifier policy profile version");
  sourceAuthenticationBundleKey("0".repeat(64), keyPrefix);
  equal(issuer, JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER, "source policy issuer");
  equal(
    audience,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    "source policy audience",
  );
  sha256(
    externalWormArchivePolicySha256,
    "source policy external WORM archive policy",
  );
  const current = sourceVerifierTrustKey(currentInput, false);
  const previous = previousInput === null
    ? null
    : sourceVerifierTrustKey(previousInput, true);
  if (
    previous !== null
    && (
      previous.keyId === current.keyId
      || previous.spkiSha256 === current.spkiSha256
    )
  ) protocolError("source_verifier_policy_key_overlap");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      "cinatoken-container-runtime-json-compatibility-source-verifier-policy-v2",
    environment: "staging",
    serviceName,
    profileVersion,
    keyPrefix,
    issuer,
    audience,
    externalWormArchivePolicySha256,
    current,
    previous,
  };
  return { ...subject, sourceVerifierPolicySha256: sha256Canonical(subject) };
}

export function buildJsonCompatibilitySourceVerifierIdentity({
  versionId,
  sourceVerifierPolicySha256,
}) {
  safeToken(versionId, "source verifier version ID");
  sha256(sourceVerifierPolicySha256, "source verifier policy");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_VERIFIER_IDENTITY_CONTRACT,
    environment: "staging",
    serviceName: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    versionId,
    sourceVerifierPolicySha256,
  };
  return {
    ...subject,
    sourceVerifierIdentitySha256: sha256Canonical(subject),
  };
}

export function buildJsonCompatibilityTransitionSourceManifest({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  accountIdSha256,
  sourceRevisionSha256,
  sourceTreeSha256,
  workerBundleSetSha256,
  containerImageSetSha256,
  d1MigrationSetSha256,
  contractSetSha256,
  createdAt,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  for (const [label, digest] of [
    ["account ID", accountIdSha256],
    ["source revision", sourceRevisionSha256],
    ["source tree", sourceTreeSha256],
    ["Worker bundle set", workerBundleSetSha256],
    ["Container image set", containerImageSetSha256],
    ["D1 migration set", d1MigrationSetSha256],
    ["contract set", contractSetSha256],
  ]) sha256(digest, `transition source manifest ${label}`);
  integer(createdAt, "transition source manifest creation time");
  const artifacts = Object.entries(statePlan.services).flatMap(
    ([role, service]) => Object.entries(service.artifacts).map(
      ([artifact, frozen]) => ({
        role,
        artifact,
        serviceName: service.serviceName,
        entrypoint: service.entrypoint,
        deploymentState: frozen.deploymentState,
        versionId: frozen.versionId,
        configSha256: frozen.configSha256,
      }),
    ),
  ).sort((left, right) =>
    `${left.role}:${left.artifact}`.localeCompare(
      `${right.role}:${right.artifact}`,
    ));
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_TRANSITION_SOURCE_MANIFEST_CONTRACT,
    kind: "container-runtime-json-compatibility-transition-source-manifest",
    environment: "staging",
    accountIdSha256,
    campaignIdSha256: campaignPlan.campaignIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    sourceRevisionSha256,
    sourceTreeSha256,
    workerBundleSetSha256,
    containerImageSetSha256,
    d1MigrationSetSha256,
    contractSetSha256,
    serviceArtifactSetSha256: sha256Canonical(artifacts),
    serviceCount: Object.keys(statePlan.services).length,
    artifactCount: artifacts.length,
    createdAt,
  };
  return {
    ...subject,
    transitionSourceManifestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityTransitionSourceManifest(
  campaignPlan,
  statePlan,
  input,
) {
  const value = record(input, "transition source manifest");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "accountIdSha256",
    "campaignIdSha256", "campaignPlanDigestSha256", "statePlanDigestSha256",
    "sourceRevisionSha256", "sourceTreeSha256", "workerBundleSetSha256",
    "containerImageSetSha256", "d1MigrationSetSha256", "contractSetSha256",
    "serviceArtifactSetSha256", "serviceCount", "artifactCount", "createdAt",
    "transitionSourceManifestSha256",
  ], "transition source manifest");
  const rebuilt = buildJsonCompatibilityTransitionSourceManifest({
    campaignPlan,
    statePlan,
    accountIdSha256: value.accountIdSha256,
    sourceRevisionSha256: value.sourceRevisionSha256,
    sourceTreeSha256: value.sourceTreeSha256,
    workerBundleSetSha256: value.workerBundleSetSha256,
    containerImageSetSha256: value.containerImageSetSha256,
    d1MigrationSetSha256: value.d1MigrationSetSha256,
    contractSetSha256: value.contractSetSha256,
    createdAt: value.createdAt,
  });
  canonicalEqual(rebuilt, value, "transition source manifest");
  return cloneJson(value);
}

export function buildJsonCompatibilitySourceArtifactInventoryReadback({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  accountIdSha256,
  artifacts: artifactsInput,
  observedAt,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  sha256(accountIdSha256, "artifact inventory account ID");
  integer(observedAt, "artifact inventory observation time");
  const artifacts = validateArtifactSet(statePlan, artifactsInput);
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_ARTIFACT_INVENTORY_CONTRACT,
    kind: "container-runtime-json-compatibility-source-artifact-inventory",
    environment: "staging",
    accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    artifacts,
    artifactCount: artifacts.length,
    observedAt,
  };
  return {
    ...subject,
    artifactInventoryReadbackSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilitySourceArtifactInventoryReadback(
  campaignPlan,
  statePlan,
  input,
) {
  const value = record(input, "source artifact inventory");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "accountIdSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256", "artifacts",
    "artifactCount", "observedAt", "artifactInventoryReadbackSha256",
  ], "source artifact inventory");
  const rebuilt = buildJsonCompatibilitySourceArtifactInventoryReadback({
    campaignPlan,
    statePlan,
    accountIdSha256: value.accountIdSha256,
    artifacts: value.artifacts,
    observedAt: value.observedAt,
  });
  canonicalEqual(rebuilt, value, "source artifact inventory");
  return cloneJson(value);
}

export function buildJsonCompatibilitySourceAccountBindingInventory({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  accountIdSha256,
  accountServiceNameSetSha256,
  accountRouteSetSha256,
  accountServiceBindingEdgeSetSha256,
  accountServiceCount,
  accountRouteCount,
  accountServiceBindingEdgeCount,
  cloudflareApiRequestCount,
  cloudflareApiPageCount,
  paginationComplete,
  collectorIdentitySha256,
  authenticationIdentitySha256,
  pageChainHeadSha256,
  readbackEvidenceSha256,
  observedAt,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  sha256(accountIdSha256, "account binding inventory account ID");
  sha256(accountServiceNameSetSha256, "account service-name set");
  sha256(accountRouteSetSha256, "account route set");
  sha256(accountServiceBindingEdgeSetSha256, "account binding-edge set");
  nonnegativeInteger(accountServiceCount, "account service count");
  nonnegativeInteger(accountRouteCount, "account route count");
  nonnegativeInteger(
    accountServiceBindingEdgeCount,
    "account service-binding edge count",
  );
  positiveInteger(cloudflareApiRequestCount, "Cloudflare API request count");
  positiveInteger(cloudflareApiPageCount, "Cloudflare API page count");
  if (cloudflareApiRequestCount < cloudflareApiPageCount) {
    protocolError("cloudflare_api_request_count_incomplete");
  }
  if (paginationComplete !== true) {
    protocolError("cloudflare_api_pagination_incomplete");
  }
  sha256(collectorIdentitySha256, "account inventory collector identity");
  sha256(
    authenticationIdentitySha256,
    "account inventory authentication identity",
  );
  sha256(pageChainHeadSha256, "account inventory page-chain head");
  sha256(readbackEvidenceSha256, "account inventory readback evidence");
  integer(observedAt, "account binding inventory observation time");
  const campaignServiceNames = Object.values(statePlan.services)
    .map((service) => service.serviceName)
    .sort();
  if (new Set(campaignServiceNames).size !== campaignServiceNames.length) {
    protocolError("duplicate_campaign_service_name");
  }
  if (accountServiceCount < campaignServiceNames.length) {
    protocolError("account_service_count_incomplete");
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_ACCOUNT_BINDING_INVENTORY_CONTRACT,
    kind: "container-runtime-json-compatibility-source-account-binding-inventory",
    environment: "staging",
    scope: "account-wide-workers-bindings",
    accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    campaignServiceNames,
    campaignPrivateRpcOnly: true,
    campaignPublicRouteCount: 0,
    campaignWorkersDevEnabledCount: 0,
    campaignPreviewUrlEnabledCount: 0,
    campaignUnexpectedCallerBindingCount: 0,
    accountServiceNameSetSha256,
    accountRouteSetSha256,
    accountServiceBindingEdgeSetSha256,
    accountServiceCount,
    accountRouteCount,
    accountServiceBindingEdgeCount,
    cloudflareApiRequestCount,
    cloudflareApiPageCount,
    paginationComplete,
    collectorIdentitySha256,
    authenticationIdentitySha256,
    pageChainHeadSha256,
    readbackEvidenceSha256,
    observedAt,
  };
  return {
    ...subject,
    accountBindingInventorySha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilitySourceAccountBindingInventory(
  campaignPlan,
  statePlan,
  input,
) {
  const value = record(input, "source account binding inventory");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "scope",
    "accountIdSha256", "campaignPlanDigestSha256", "statePlanDigestSha256",
    "campaignServiceNames", "campaignPrivateRpcOnly",
    "campaignPublicRouteCount", "campaignWorkersDevEnabledCount",
    "campaignPreviewUrlEnabledCount", "campaignUnexpectedCallerBindingCount",
    "accountServiceNameSetSha256", "accountRouteSetSha256",
    "accountServiceBindingEdgeSetSha256", "accountServiceCount",
    "accountRouteCount", "accountServiceBindingEdgeCount",
    "cloudflareApiRequestCount", "cloudflareApiPageCount",
    "paginationComplete", "collectorIdentitySha256",
    "authenticationIdentitySha256", "pageChainHeadSha256",
    "readbackEvidenceSha256", "observedAt",
    "accountBindingInventorySha256",
  ], "source account binding inventory");
  const rebuilt = buildJsonCompatibilitySourceAccountBindingInventory({
    campaignPlan,
    statePlan,
    accountIdSha256: value.accountIdSha256,
    accountServiceNameSetSha256: value.accountServiceNameSetSha256,
    accountRouteSetSha256: value.accountRouteSetSha256,
    accountServiceBindingEdgeSetSha256:
      value.accountServiceBindingEdgeSetSha256,
    accountServiceCount: value.accountServiceCount,
    accountRouteCount: value.accountRouteCount,
    accountServiceBindingEdgeCount: value.accountServiceBindingEdgeCount,
    cloudflareApiRequestCount: value.cloudflareApiRequestCount,
    cloudflareApiPageCount: value.cloudflareApiPageCount,
    paginationComplete: value.paginationComplete,
    collectorIdentitySha256: value.collectorIdentitySha256,
    authenticationIdentitySha256: value.authenticationIdentitySha256,
    pageChainHeadSha256: value.pageChainHeadSha256,
    readbackEvidenceSha256: value.readbackEvidenceSha256,
    observedAt: value.observedAt,
  });
  canonicalEqual(rebuilt, value, "source account binding inventory");
  return cloneJson(value);
}

export function buildJsonCompatibilitySourceImmutableArchiveReceipt({
  externalWormArchiveEvidence: evidenceInput,
  externalWormS3Closure: closureInput,
  collectionCaptureTerminal: collectionTerminalInput,
  independentReadbackCaptureTerminal: readbackTerminalInput,
}) {
  const evidence =
    validateJsonCompatibilityExternalWormArchiveEvidence(evidenceInput);
  const externalWormS3Closure =
    validateSourceExternalWormS3ClosureBinding(evidence, closureInput);
  const { collectionCaptureTerminal, independentReadbackCaptureTerminal } =
    validateArchiveCaptureTerminals({
      externalWormArchiveEvidence: evidence,
      collectionCaptureTerminal: collectionTerminalInput,
      independentReadbackCaptureTerminal: readbackTerminalInput,
    });
  const manifest = evidence.archiveManifest;
  const write = evidence.writeObservationEnvelope.subject;
  const readback = evidence.independentReadbackEnvelope.subject;
  if (
    readback.completedAt < write.lockedAt
    || readback.retainUntil - write.lockedAt
      < JSON_COMPATIBILITY_SOURCE_MIN_ARCHIVE_RETENTION_SECONDS
  ) {
    protocolError("invalid_source_archive_retention_window");
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_ARCHIVE_RECEIPT_CONTRACT,
    kind: "container-runtime-json-compatibility-source-immutable-archive-receipt",
    environment: "staging",
    archiveBackend: "external-worm",
    retentionMode: "compliance",
    providerControl: evidence.archivePolicy.providerControl,
    r2BucketLockAccepted: evidence.archivePolicy.r2BucketLockAccepted,
    accountIdSha256: manifest.accountIdSha256,
    transitionSourceManifestSha256:
      manifest.transitionSourceManifestSha256,
    phaseSourceManifestSha256: manifest.phaseSourceManifestSha256,
    artifactInventoryReadbackSha256:
      manifest.artifactInventoryReadbackSha256,
    accountBindingEvidenceSha256: manifest.accountBindingEvidenceSha256,
    accountBindingInventorySha256:
      manifest.accountBindingInventorySha256,
    archivePolicySha256: evidence.archivePolicySha256,
    archiveManifestSha256: evidence.archiveManifestSha256,
    archiveEvidenceSha256: evidence.archiveEvidenceSha256,
    externalWormS3ClosureSha256: externalWormS3Closure.closureSha256,
    archiveObjectSetSha256: manifest.archiveObjectSetSha256,
    objectIdentitySetSha256: evidence.objectIdentitySetSha256,
    archiveObjectCount: manifest.archiveObjectCount,
    archiveTotalByteLength: manifest.archiveTotalByteLength,
    collectionCaptureTerminalSha256:
      collectionCaptureTerminal.captureTerminalSha256,
    independentReadbackCaptureTerminalSha256:
      independentReadbackCaptureTerminal.captureTerminalSha256,
    writeObservationEnvelopeSha256:
      evidence.writeObservationEnvelopeSha256,
    independentReadbackEnvelopeSha256:
      evidence.independentReadbackEnvelopeSha256,
    lockedAt: write.lockedAt,
    retainUntil: readback.retainUntil,
    independentlyReadBackAt: readback.completedAt,
    exactObjectReadback: evidence.exactObjectReadback,
    independentWriterAndReader: evidence.independentWriterAndReader,
    complianceRetentionVerified: evidence.complianceRetentionVerified,
  };
  return {
    ...subject,
    immutableSourceArchiveReceiptSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilitySourceImmutableArchiveReceipt(
  input,
  externalWormArchiveEvidence,
  externalWormS3Closure,
  collectionCaptureTerminal,
  independentReadbackCaptureTerminal,
) {
  const value = record(input, "source immutable archive receipt");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "archiveBackend",
    "retentionMode", "providerControl", "r2BucketLockAccepted",
    "accountIdSha256", "transitionSourceManifestSha256",
    "phaseSourceManifestSha256",
    "artifactInventoryReadbackSha256", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256",
    "archivePolicySha256", "archiveManifestSha256", "archiveEvidenceSha256",
    "externalWormS3ClosureSha256",
    "archiveObjectSetSha256", "objectIdentitySetSha256",
    "archiveObjectCount", "archiveTotalByteLength",
    "collectionCaptureTerminalSha256",
    "independentReadbackCaptureTerminalSha256",
    "writeObservationEnvelopeSha256", "independentReadbackEnvelopeSha256",
    "lockedAt", "retainUntil", "independentlyReadBackAt",
    "exactObjectReadback", "independentWriterAndReader",
    "complianceRetentionVerified",
    "immutableSourceArchiveReceiptSha256",
  ], "source immutable archive receipt");
  const rebuilt = buildJsonCompatibilitySourceImmutableArchiveReceipt({
    externalWormArchiveEvidence,
    externalWormS3Closure,
    collectionCaptureTerminal,
    independentReadbackCaptureTerminal,
  });
  canonicalEqual(rebuilt, value, "source immutable archive receipt");
  return cloneJson(value);
}

export function buildJsonCompatibilitySourceSignatureSubject({
  sourceAuthenticationRequest: requestInput,
  accountBindingEvidenceSha256,
  immutableSourceArchiveReceiptSha256,
  issuer = JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
  audience = JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
  keyId,
  issuedAt,
  notBefore,
  expiresAt,
}) {
  const request =
    validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      requestInput,
    );
  equal(issuer, JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER, "source issuer");
  equal(
    audience,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    "source audience",
  );
  safeToken(keyId, "source signature key ID");
  sha256(
    accountBindingEvidenceSha256,
    "source account binding evidence",
  );
  sha256(
    immutableSourceArchiveReceiptSha256,
    "source immutable archive receipt",
  );
  integer(issuedAt, "source signature issue time");
  integer(notBefore, "source signature not-before time");
  integer(expiresAt, "source signature expiry time");
  if (
    notBefore < issuedAt - 5
    || expiresAt <= notBefore
    || expiresAt - issuedAt
      > JSON_COMPATIBILITY_SOURCE_SIGNATURE_MAX_LIFETIME_SECONDS
  ) {
    protocolError("invalid_source_signature_window");
  }
  const source = request.sourceEvidence;
  return {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_SIGNATURE_SUBJECT_CONTRACT,
    environment: "staging",
    issuer,
    audience,
    keyId,
    profile: request.profile,
    operationIdSha256: request.operationIdSha256,
    campaignPlanDigestSha256: request.campaignPlanDigestSha256,
    statePlanDigestSha256: request.statePlanDigestSha256,
    transitionId: request.transition.id,
    transitionOrdinal: request.transition.ordinal,
    fromState: request.transition.fromState,
    toState: request.transition.toState,
    transitionSha256: request.transition.transitionSha256,
    accountIdSha256: source.accountIdSha256,
    sourceVerifierPolicySha256: source.sourceVerifierPolicySha256,
    sourceVerifierIdentitySha256: source.sourceVerifierIdentitySha256,
    transitionSourceManifestSha256:
      source.transitionSourceManifestSha256,
    phaseSourceManifestSha256: source.phaseSourceManifestSha256,
    artifactInventoryReadbackSha256:
      source.artifactInventoryReadbackSha256,
    accountBindingInventorySha256: source.accountBindingInventorySha256,
    accountBindingEvidenceSha256,
    immutableSourceArchiveReceiptSha256,
    issuedAt,
    notBefore,
    expiresAt,
  };
}

export function buildJsonCompatibilitySourceSignatureEnvelope({
  subject: subjectInput,
  signerSpkiBase64url,
  signatureBase64url,
}) {
  const subject = validateSignatureSubject(subjectInput);
  base64urlBytes(signerSpkiBase64url, "source signer SPKI", 1, 512);
  base64urlBytes(signatureBase64url, "source signature", 64, 64);
  return {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT,
    algorithm: "Ed25519",
    subject: cloneJson(subject),
    subjectSha256: sha256Canonical(subject),
    signerSpkiBase64url,
    signatureBase64url,
  };
}

export function validateJsonCompatibilitySourceSignatureEnvelope(input) {
  const value = record(input, "source signature envelope");
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "subject", "subjectSha256",
    "signerSpkiBase64url", "signatureBase64url",
  ], "source signature envelope");
  equal(value.schemaVersion, SCHEMA_VERSION, "source envelope schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT,
    "source envelope contract",
  );
  equal(value.algorithm, "Ed25519", "source envelope algorithm");
  const rebuilt = buildJsonCompatibilitySourceSignatureEnvelope({
    subject: value.subject,
    signerSpkiBase64url: value.signerSpkiBase64url,
    signatureBase64url: value.signatureBase64url,
  });
  canonicalEqual(rebuilt, value, "source signature envelope");
  return cloneJson(value);
}

export function sourceSignatureSigningPayload(subjectInput) {
  const subject = validateSignatureSubject(subjectInput);
  return new TextEncoder().encode(
    `${JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
  );
}

export function buildJsonCompatibilitySourceAuthenticationBundle({
  sourceAuthenticationRequest,
  campaignPlan,
  statePlan,
  transitionSourceManifest,
  phaseSourceManifest,
  artifactInventoryReadback,
  accountBindingEvidence,
  accountBindingInventory,
  externalWormArchiveEvidence,
  externalWormS3Closure,
  collectionCaptureTerminal,
  independentReadbackCaptureTerminal,
  immutableSourceArchiveReceipt,
  sourceSignatureEnvelope,
}) {
  const content = validateBundleContent({
    sourceAuthenticationRequest,
    campaignPlan,
    statePlan,
    transitionSourceManifest,
    phaseSourceManifest,
    artifactInventoryReadback,
    accountBindingEvidence,
    accountBindingInventory,
    externalWormArchiveEvidence,
    externalWormS3Closure,
    collectionCaptureTerminal,
    independentReadbackCaptureTerminal,
    immutableSourceArchiveReceipt,
    sourceSignatureEnvelope,
  });
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT,
    kind: "container-runtime-json-compatibility-source-authentication-bundle",
    environment: "staging",
    ...content,
  };
  return { ...subject, bundleSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilitySourceAuthenticationBundle(
  sourceAuthenticationRequest,
  input,
  { now, requireUsableWindow = true } = {},
) {
  const value = record(input, "source authentication bundle");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "campaignPlan",
    "statePlan", "transitionSourceManifest", "phaseSourceManifest",
    "artifactInventoryReadback",
    "accountBindingEvidence", "accountBindingInventory",
    "externalWormArchiveEvidence", "externalWormS3Closure",
    "collectionCaptureTerminal", "independentReadbackCaptureTerminal",
    "immutableSourceArchiveReceipt",
    "sourceSignatureEnvelope", "bundleSha256",
  ], "source authentication bundle");
  const rebuilt = buildJsonCompatibilitySourceAuthenticationBundle({
    sourceAuthenticationRequest,
    campaignPlan: value.campaignPlan,
    statePlan: value.statePlan,
    transitionSourceManifest: value.transitionSourceManifest,
    phaseSourceManifest: value.phaseSourceManifest,
    artifactInventoryReadback: value.artifactInventoryReadback,
    accountBindingEvidence: value.accountBindingEvidence,
    accountBindingInventory: value.accountBindingInventory,
    externalWormArchiveEvidence: value.externalWormArchiveEvidence,
    externalWormS3Closure: value.externalWormS3Closure,
    collectionCaptureTerminal: value.collectionCaptureTerminal,
    independentReadbackCaptureTerminal:
      value.independentReadbackCaptureTerminal,
    immutableSourceArchiveReceipt: value.immutableSourceArchiveReceipt,
    sourceSignatureEnvelope: value.sourceSignatureEnvelope,
  });
  canonicalEqual(rebuilt, value, "source authentication bundle");
  if (now !== undefined && now !== null) {
    integer(now, "source verification time");
    const subject = rebuilt.sourceSignatureEnvelope.subject;
    if (
      subject.notBefore > now + 5
      || subject.expiresAt <= now
      || (requireUsableWindow
        && subject.expiresAt - now
          < JSON_COMPATIBILITY_SOURCE_SIGNATURE_MIN_REMAINING_SECONDS)
    ) {
      protocolError("source_signature_time_window");
    }
  }
  return rebuilt;
}

export function sourceAuthenticationBundleKey(
  sourceSignatureEnvelopeSha256,
  prefix = "container-runtime/json-compatibility/source-authentication/v3/sha256",
) {
  sha256(sourceSignatureEnvelopeSha256, "source signature envelope");
  if (
    typeof prefix !== "string"
    || prefix.length < 1
    || prefix.length > 160
    || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.includes("..")
    || !/^[a-z0-9][a-z0-9/-]*$/.test(prefix)
  ) {
    protocolError("invalid_source_bundle_key_prefix");
  }
  return `${prefix}/bundles/${sourceSignatureEnvelopeSha256.slice(0, 2)}/${sourceSignatureEnvelopeSha256}.json`;
}

export function sourceAuthenticationRevocationKey(
  signerSpkiSha256,
  prefix = "container-runtime/json-compatibility/source-authentication/v3/sha256",
) {
  sourceAuthenticationBundleKey(signerSpkiSha256, prefix);
  return `${prefix}/revocations/${signerSpkiSha256.slice(0, 2)}/${signerSpkiSha256}.json`;
}

function validateBundleContent(input) {
  const request =
    validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      input.sourceAuthenticationRequest,
    );
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    input.campaignPlan,
    input.statePlan,
  );
  equal(
    campaignPlan.planDigestSha256,
    request.campaignPlanDigestSha256,
    "source bundle campaign plan digest",
  );
  equal(
    statePlan.planDigestSha256,
    request.statePlanDigestSha256,
    "source bundle state plan digest",
  );
  const transitionSourceManifest =
    validateJsonCompatibilityTransitionSourceManifest(
      campaignPlan,
      statePlan,
      input.transitionSourceManifest,
    );
  let phaseSourceManifest = null;
  if (request.profile === "campaign-closure-v1") {
    phaseSourceManifest = validateJsonCompatibilitySourceManifest(
      campaignPlan,
      input.phaseSourceManifest,
    );
  } else if (input.phaseSourceManifest !== null) {
    protocolError("release_phase_source_manifest_must_be_absent");
  }
  const artifactInventoryReadback =
    validateJsonCompatibilitySourceArtifactInventoryReadback(
      campaignPlan,
      statePlan,
      input.artifactInventoryReadback,
    );
  const accountBindingEvidence =
    validateJsonCompatibilityAccountBindingEvidence(
      campaignPlan,
      statePlan,
      input.accountBindingEvidence,
    );
  const accountBindingInventory =
    validateJsonCompatibilitySourceAccountBindingInventory(
      campaignPlan,
      statePlan,
      input.accountBindingInventory,
    );
  const projectedAccountBindingInventory =
    buildJsonCompatibilitySourceAccountBindingInventory({
      campaignPlan,
      statePlan,
      ...accountBindingInventoryInputFromEvidence(accountBindingEvidence),
    });
  canonicalEqual(
    projectedAccountBindingInventory,
    accountBindingInventory,
    "source account binding evidence projection",
  );
  const externalWormArchiveEvidence =
    validateJsonCompatibilityExternalWormArchiveEvidence(
      input.externalWormArchiveEvidence,
    );
  const externalWormS3Closure =
    validateSourceExternalWormS3ClosureBinding(
      externalWormArchiveEvidence,
      input.externalWormS3Closure,
    );
  const captureTerminals = validateArchiveCaptureTerminals({
    externalWormArchiveEvidence,
    collectionCaptureTerminal: input.collectionCaptureTerminal,
    independentReadbackCaptureTerminal:
      input.independentReadbackCaptureTerminal,
  });
  validateArchiveDocumentBindings({
    externalWormArchiveEvidence,
    collectionCaptureTerminal: captureTerminals.collectionCaptureTerminal,
    independentReadbackCaptureTerminal:
      captureTerminals.independentReadbackCaptureTerminal,
    campaignPlan,
    statePlan,
    transitionSourceManifest,
    phaseSourceManifest,
    artifactInventoryReadback,
    accountBindingEvidence,
    accountBindingInventory,
  });
  const archiveReceipt =
    validateJsonCompatibilitySourceImmutableArchiveReceipt(
      input.immutableSourceArchiveReceipt,
      externalWormArchiveEvidence,
      externalWormS3Closure,
      captureTerminals.collectionCaptureTerminal,
      captureTerminals.independentReadbackCaptureTerminal,
    );
  const envelope = validateJsonCompatibilitySourceSignatureEnvelope(
    input.sourceSignatureEnvelope,
  );
  const source = request.sourceEvidence;
  const envelopeSha256 = sha256Canonical(envelope);
  for (const [label, actual, expected] of [
    ["transition source manifest",
      transitionSourceManifest.transitionSourceManifestSha256,
      source.transitionSourceManifestSha256],
    ["phase source manifest",
      phaseSourceManifest?.sourceManifestSha256 ?? null,
      source.phaseSourceManifestSha256],
    ["artifact inventory",
      artifactInventoryReadback.artifactInventoryReadbackSha256,
      source.artifactInventoryReadbackSha256],
    ["account binding inventory",
      accountBindingInventory.accountBindingInventorySha256,
      source.accountBindingInventorySha256],
    ["immutable archive receipt",
      archiveReceipt.immutableSourceArchiveReceiptSha256,
      source.immutableSourceArchiveReceiptSha256],
    ["signature envelope", envelopeSha256,
      source.sourceSignatureEnvelopeSha256],
    ["artifact inventory account", artifactInventoryReadback.accountIdSha256,
      source.accountIdSha256],
    ["account inventory account", accountBindingInventory.accountIdSha256,
      source.accountIdSha256],
    ["account binding evidence account", accountBindingEvidence.accountIdSha256,
      source.accountIdSha256],
    ["archive account", archiveReceipt.accountIdSha256,
      source.accountIdSha256],
    ["transition manifest account", transitionSourceManifest.accountIdSha256,
      source.accountIdSha256],
    ["archive transition source manifest",
      archiveReceipt.transitionSourceManifestSha256,
      source.transitionSourceManifestSha256],
    ["archive phase source manifest",
      archiveReceipt.phaseSourceManifestSha256,
      source.phaseSourceManifestSha256],
    ["archive artifact inventory",
      archiveReceipt.artifactInventoryReadbackSha256,
      source.artifactInventoryReadbackSha256],
    ["archive account binding evidence",
      archiveReceipt.accountBindingEvidenceSha256,
      accountBindingEvidence.accountBindingEvidenceSha256],
    ["archive account inventory",
      archiveReceipt.accountBindingInventorySha256,
      source.accountBindingInventorySha256],
    ["archive policy receipt",
      archiveReceipt.archivePolicySha256,
      externalWormArchiveEvidence.archivePolicySha256],
    ["archive manifest receipt",
      archiveReceipt.archiveManifestSha256,
      externalWormArchiveEvidence.archiveManifestSha256],
    ["archive evidence receipt",
      archiveReceipt.archiveEvidenceSha256,
      externalWormArchiveEvidence.archiveEvidenceSha256],
    ["external WORM S3 closure receipt",
      archiveReceipt.externalWormS3ClosureSha256,
      externalWormS3Closure.closureSha256],
    ["archive manifest account",
      externalWormArchiveEvidence.archiveManifest.accountIdSha256,
      source.accountIdSha256],
    ["archive manifest campaign plan",
      externalWormArchiveEvidence.archiveManifest.campaignPlanDigestSha256,
      request.campaignPlanDigestSha256],
    ["archive manifest state plan",
      externalWormArchiveEvidence.archiveManifest.statePlanDigestSha256,
      request.statePlanDigestSha256],
    ["archive manifest collection profile",
      externalWormArchiveEvidence.archiveManifest.collectionProfileSha256,
      accountBindingEvidence.collectionProfile.collectionProfileSha256],
    ["archive manifest collector identity",
      externalWormArchiveEvidence.archiveManifest.collectorIdentitySha256,
      accountBindingEvidence.collectionProfile.collectorIdentitySha256],
    ["archive manifest transition source manifest",
      externalWormArchiveEvidence.archiveManifest
        .transitionSourceManifestSha256,
      source.transitionSourceManifestSha256],
    ["archive manifest phase source manifest",
      externalWormArchiveEvidence.archiveManifest.phaseSourceManifestSha256,
      source.phaseSourceManifestSha256],
    ["archive manifest artifact inventory",
      externalWormArchiveEvidence.archiveManifest
        .artifactInventoryReadbackSha256,
      source.artifactInventoryReadbackSha256],
    ["archive manifest account binding evidence",
      externalWormArchiveEvidence.archiveManifest
        .accountBindingEvidenceSha256,
      accountBindingEvidence.accountBindingEvidenceSha256],
    ["archive manifest account binding inventory",
      externalWormArchiveEvidence.archiveManifest
        .accountBindingInventorySha256,
      source.accountBindingInventorySha256],
  ]) equal(actual, expected, `source bundle ${label}`);
  const expectedSubject = buildJsonCompatibilitySourceSignatureSubject({
    sourceAuthenticationRequest: request,
    accountBindingEvidenceSha256:
      accountBindingEvidence.accountBindingEvidenceSha256,
    immutableSourceArchiveReceiptSha256:
      archiveReceipt.immutableSourceArchiveReceiptSha256,
    issuer: envelope.subject.issuer,
    audience: envelope.subject.audience,
    keyId: envelope.subject.keyId,
    issuedAt: envelope.subject.issuedAt,
    notBefore: envelope.subject.notBefore,
    expiresAt: envelope.subject.expiresAt,
  });
  canonicalEqual(expectedSubject, envelope.subject, "source signature subject");
  if (
    archiveReceipt.lockedAt < transitionSourceManifest.createdAt
    || archiveReceipt.lockedAt < artifactInventoryReadback.observedAt
    || archiveReceipt.lockedAt < accountBindingInventory.observedAt
  ) protocolError("source_archive_causal_order_mismatch");
  if (
    archiveReceipt.independentlyReadBackAt > envelope.subject.issuedAt
    || envelope.subject.issuedAt - archiveReceipt.independentlyReadBackAt
      > JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS
  ) protocolError("source_archive_readback_window_mismatch");
  if (
    transitionSourceManifest.createdAt > envelope.subject.issuedAt
    || artifactInventoryReadback.observedAt > envelope.subject.issuedAt
    || accountBindingInventory.observedAt > envelope.subject.issuedAt
    || envelope.subject.issuedAt - artifactInventoryReadback.observedAt
      > JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS
    || envelope.subject.issuedAt - transitionSourceManifest.createdAt
      > JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS
    || envelope.subject.issuedAt - accountBindingInventory.observedAt
      > JSON_COMPATIBILITY_SOURCE_MAX_OBSERVATION_AGE_SECONDS
  ) {
    protocolError("source_bundle_evidence_window_mismatch");
  }
  if (
    archiveReceipt.retainUntil - envelope.subject.issuedAt
      < JSON_COMPATIBILITY_SOURCE_MIN_ARCHIVE_RETENTION_SECONDS
    || archiveReceipt.retainUntil < envelope.subject.expiresAt
  ) protocolError("source_archive_remaining_retention_invalid");
  return {
    campaignPlan: cloneJson(campaignPlan),
    statePlan: cloneJson(statePlan),
    transitionSourceManifest: cloneJson(transitionSourceManifest),
    phaseSourceManifest: cloneJson(phaseSourceManifest),
    artifactInventoryReadback: cloneJson(artifactInventoryReadback),
    accountBindingEvidence: cloneJson(accountBindingEvidence),
    accountBindingInventory: cloneJson(accountBindingInventory),
    externalWormArchiveEvidence: cloneJson(externalWormArchiveEvidence),
    externalWormS3Closure: cloneJson(externalWormS3Closure),
    collectionCaptureTerminal:
      cloneJson(captureTerminals.collectionCaptureTerminal),
    independentReadbackCaptureTerminal:
      cloneJson(captureTerminals.independentReadbackCaptureTerminal),
    immutableSourceArchiveReceipt: cloneJson(archiveReceipt),
    sourceSignatureEnvelope: cloneJson(envelope),
  };
}

function validateSourceExternalWormS3ClosureBinding(
  externalWormArchiveEvidence,
  input,
) {
  const value = record(input, "source external WORM S3 closure");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "provider", "decisionScope",
    "authorizesC2Closure", "archiveEvidenceSha256",
    "archivePolicySha256", "archiveManifestSha256", "identity",
    "writerCredentialIdSha256", "readerCredentialIdSha256",
    "rawWriterObservations", "rawReadbackObservations",
    "writerObservationSetSha256", "readbackObservationSetSha256",
    "bindings", "objectBindingSetSha256", "objectKeySetSha256",
    "objectCount", "closureSha256",
  ], "source external WORM S3 closure");
  equal(value.schemaVersion, 1, "source external WORM S3 closure schema");
  equal(
    value.contract,
    EXTERNAL_WORM_S3_CLOSURE_CONTRACT,
    "source external WORM S3 closure contract",
  );
  equal(
    value.kind,
    "container-runtime-json-compatibility-external-worm-s3-c2-binding-closure",
    "source external WORM S3 closure kind",
  );
  equal(value.provider, "amazon-s3", "source external WORM S3 provider");
  equal(
    value.decisionScope,
    EXTERNAL_WORM_S3_CLOSURE_DECISION_SCOPE,
    "source external WORM S3 closure decision scope",
  );
  equal(
    value.authorizesC2Closure,
    false,
    "source external WORM S3 closure authority",
  );
  for (const [label, actual, expected] of [
    ["archive evidence", value.archiveEvidenceSha256,
      externalWormArchiveEvidence.archiveEvidenceSha256],
    ["archive policy", value.archivePolicySha256,
      externalWormArchiveEvidence.archivePolicySha256],
    ["archive manifest", value.archiveManifestSha256,
      externalWormArchiveEvidence.archiveManifestSha256],
  ]) {
    sha256(actual, `source external WORM S3 closure ${label}`);
    equal(actual, expected, `source external WORM S3 closure ${label}`);
  }
  for (const [label, digestValue] of [
    ["writer credential", value.writerCredentialIdSha256],
    ["reader credential", value.readerCredentialIdSha256],
    ["writer observation set", value.writerObservationSetSha256],
    ["readback observation set", value.readbackObservationSetSha256],
    ["object binding set", value.objectBindingSetSha256],
    ["object key set", value.objectKeySetSha256],
    ["closure", value.closureSha256],
  ]) sha256(digestValue, `source external WORM S3 closure ${label}`);
  const identity = record(
    value.identity,
    "source external WORM S3 closure identity",
  );
  integer(value.objectCount, "source external WORM S3 closure object count");
  equal(
    value.objectCount,
    externalWormArchiveEvidence.archiveManifest.archiveObjectCount,
    "source external WORM S3 closure object count",
  );
  equal(
    identity.objectCount,
    value.objectCount,
    "source external WORM S3 closure identity object count",
  );
  for (const [label, observations] of [
    ["writer observations", value.rawWriterObservations],
    ["readback observations", value.rawReadbackObservations],
    ["object bindings", value.bindings],
  ]) {
    if (!Array.isArray(observations)) {
      protocolError(
        "invalid_source_document",
        `source external WORM S3 closure ${label} must be an array`,
      );
    }
    equal(
      observations.length,
      value.objectCount,
      `source external WORM S3 closure ${label} count`,
    );
  }
  const { closureSha256: _closureSha256, ...subject } = value;
  equal(
    value.closureSha256,
    sha256Canonical(subject),
    "source external WORM S3 closure digest",
  );
  return cloneJson(value);
}

function validateArchiveCaptureTerminals({
  externalWormArchiveEvidence,
  collectionCaptureTerminal: collectionInput,
  independentReadbackCaptureTerminal: readbackInput,
}) {
  const evidence =
    validateJsonCompatibilityExternalWormArchiveEvidence(
      externalWormArchiveEvidence,
    );
  const collectionCaptureTerminal =
    validateSourceArchiveCaptureTerminal(collectionInput);
  const independentReadbackCaptureTerminal =
    validateSourceArchiveCaptureTerminal(readbackInput);
  const pairs = [
    [
      "collection",
      collectionCaptureTerminal,
      evidence.archiveManifest.collection,
    ],
    [
      "independent-readback",
      independentReadbackCaptureTerminal,
      evidence.archiveManifest.independentReadback,
    ],
  ];
  for (const [mode, terminal, pass] of pairs) {
    for (const [label, actual, expected] of [
      ["mode", terminal.mode, mode],
      ["account", terminal.accountIdSha256,
        evidence.archiveManifest.accountIdSha256],
      ["collection profile", terminal.collectionProfileSha256,
        evidence.archiveManifest.collectionProfileSha256],
      ["collector identity", terminal.collectorIdentitySha256,
        evidence.archiveManifest.collectorIdentitySha256],
      ["capture manifest", terminal.captureManifestSha256,
        pass.captureManifestSha256],
      ["capture terminal", terminal.captureTerminalSha256,
        pass.captureTerminalSha256],
      ["collection artifact", terminal.collectionArtifactSha256,
        pass.collectionArtifactSha256],
      ["page count", terminal.pageCount, pass.pageCount],
      ["page chain", terminal.pageChainHeadSha256,
        pass.pageChainHeadSha256],
    ]) archiveBinding(actual === expected, `terminal_${label}`);

    const captureManifest = captureManifestFromTerminal(terminal);
    assertArchiveDocumentDescriptor({
      objects: evidence.archiveManifest.objects,
      logicalRole: "capture-manifest",
      mode,
      document: captureManifest,
      contentIdentitySha256: terminal.captureManifestSha256,
    });
    assertArchiveDocumentDescriptor({
      objects: evidence.archiveManifest.objects,
      logicalRole: "capture-terminal",
      mode,
      document: terminal,
      contentIdentitySha256: terminal.captureTerminalSha256,
    });
    const artifactDescriptor = exactArchiveDescriptor(
      evidence.archiveManifest.objects,
      "collection-artifact",
      mode,
    );
    archiveBinding(
      artifactDescriptor.contentIdentitySha256
        === terminal.collectionArtifactSha256
      && artifactDescriptor.bodySha256
        === terminal.collectionArtifactFileSha256,
      "terminal_artifact",
    );
    assertTerminalPageProjection(
      evidence.archiveManifest.objects,
      terminal,
      pass,
    );
  }
  archiveBinding(
    collectionCaptureTerminal.captureTerminalSha256
      !== independentReadbackCaptureTerminal.captureTerminalSha256,
    "terminal_separation",
  );
  return {
    collectionCaptureTerminal,
    independentReadbackCaptureTerminal,
  };
}

function validateSourceArchiveCaptureTerminal(input) {
  try {
    return validateJsonCompatibilityAccountBindingRawCaptureTerminal(input);
  } catch {
    protocolError("source_archive_capture_terminal_invalid");
  }
}

function validateArchiveDocumentBindings({
  externalWormArchiveEvidence,
  collectionCaptureTerminal,
  independentReadbackCaptureTerminal,
  campaignPlan,
  statePlan,
  transitionSourceManifest,
  phaseSourceManifest,
  artifactInventoryReadback,
  accountBindingEvidence,
  accountBindingInventory,
}) {
  const objects = externalWormArchiveEvidence.archiveManifest.objects;
  const covered = new Set();
  const coverDocument = (
    logicalRole,
    mode,
    document,
    contentIdentitySha256,
  ) => {
    const descriptor = assertArchiveDocumentDescriptor({
      objects,
      logicalRole,
      mode,
      document,
      contentIdentitySha256,
    });
    covered.add(descriptor.objectDescriptorSha256);
  };
  for (const [logicalRole, document, identity] of [
    ["campaign-plan", campaignPlan, campaignPlan.planDigestSha256],
    ["state-plan", statePlan, statePlan.planDigestSha256],
    ["collector-identity", accountBindingEvidence.collection.collectorIdentity,
      accountBindingEvidence.collectionProfile.collectorIdentitySha256],
    ["collection-profile", accountBindingEvidence.collectionProfile,
      accountBindingEvidence.collectionProfile.collectionProfileSha256],
    ["account-binding-evidence", accountBindingEvidence,
      accountBindingEvidence.accountBindingEvidenceSha256],
    ["account-binding-inventory", accountBindingInventory,
      accountBindingInventory.accountBindingInventorySha256],
    ["transition-source-manifest", transitionSourceManifest,
      transitionSourceManifest.transitionSourceManifestSha256],
    ["artifact-inventory-readback", artifactInventoryReadback,
      artifactInventoryReadback.artifactInventoryReadbackSha256],
  ]) coverDocument(logicalRole, null, document, identity);
  if (phaseSourceManifest !== null) {
    coverDocument(
      "phase-source-manifest",
      null,
      phaseSourceManifest,
      phaseSourceManifest.sourceManifestSha256,
    );
  }
  for (const [mode, terminal, artifact] of [
    ["collection", collectionCaptureTerminal,
      accountBindingEvidence.collection],
    ["independent-readback", independentReadbackCaptureTerminal,
      accountBindingEvidence.independentReadback],
  ]) {
    coverDocument(
      "capture-manifest",
      mode,
      captureManifestFromTerminal(terminal),
      terminal.captureManifestSha256,
    );
    coverDocument(
      "capture-terminal",
      mode,
      terminal,
      terminal.captureTerminalSha256,
    );
    coverDocument(
      "collection-artifact",
      mode,
      artifact,
      artifact.collectionArtifactSha256,
    );
    archiveBinding(
      canonicalDocumentMetrics(artifact).bodySha256
        === terminal.collectionArtifactFileSha256,
      "terminal_artifact_body",
    );
    const rawByIdentity = new Map(
      terminal.rawObjects.map((value) => [
        `${value.sequence}:${value.objectKind}`,
        value,
      ]),
    );
    for (const receipt of artifact.snapshot.pageReceipts) {
      const body = rawByIdentity.get(`${receipt.sequence}:body`);
      const receiptObject = rawByIdentity.get(`${receipt.sequence}:receipt`);
      archiveBinding(
        body !== undefined
        && receiptObject !== undefined
        && body.resourceFamily === receipt.resourceFamily
        && receiptObject.resourceFamily === receipt.resourceFamily
        && body.pageReceiptSha256 === receipt.pageReceiptSha256
        && receiptObject.pageReceiptSha256 === receipt.pageReceiptSha256
        && body.requestPathSha256 === receipt.requestPathSha256
        && receiptObject.requestPathSha256 === receipt.requestPathSha256
        && body.responseBodySha256 === receipt.responseBodySha256
        && receiptObject.responseBodySha256 === receipt.responseBodySha256
        && body.contentSha256 === receipt.responseBodySha256
        && body.byteLength === receipt.responseByteLength,
        "terminal_receipt_projection",
      );
      const receiptMetrics = canonicalDocumentMetrics(receipt);
      archiveBinding(
        receiptObject.contentSha256 === receiptMetrics.bodySha256
        && receiptObject.byteLength === receiptMetrics.byteLength,
        "terminal_receipt_body",
      );
      const bodyDescriptor = exactArchivePageDescriptor(
        objects,
        "raw-response-body",
        mode,
        receipt.sequence,
      );
      const receiptDescriptor = exactArchivePageDescriptor(
        objects,
        "page-receipt",
        mode,
        receipt.sequence,
      );
      covered.add(bodyDescriptor.objectDescriptorSha256);
      covered.add(receiptDescriptor.objectDescriptorSha256);
    }
  }
  archiveBinding(covered.size === objects.length, "document_set");
}

function captureManifestFromTerminal(terminal) {
  const subject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
    environment: "staging",
    mode: terminal.mode,
    accountIdSha256: terminal.accountIdSha256,
    collectionProfileSha256: terminal.collectionProfileSha256,
    collectorIdentitySha256: terminal.collectorIdentitySha256,
  };
  archiveBinding(
    sha256Canonical(subject) === terminal.captureManifestSha256,
    "capture_manifest_identity",
  );
  return {
    ...subject,
    captureManifestSha256: terminal.captureManifestSha256,
  };
}

function assertTerminalPageProjection(objects, terminal, pass) {
  const pageDescriptors = objects.filter((value) =>
    value.mode === terminal.mode
    && (value.logicalRole === "raw-response-body"
      || value.logicalRole === "page-receipt"));
  archiveBinding(
    pageDescriptors.length === terminal.rawObjectCount,
    "terminal_object_count",
  );
  let rawResponseByteLength = 0;
  for (const rawObject of terminal.rawObjects) {
    const role = rawObject.objectKind === "body"
      ? "raw-response-body"
      : "page-receipt";
    const descriptor = exactArchivePageDescriptor(
      objects,
      role,
      terminal.mode,
      rawObject.sequence,
    );
    archiveBinding(
      descriptor.resourceFamily === rawObject.resourceFamily
      && descriptor.pageReceiptSha256 === rawObject.pageReceiptSha256
      && descriptor.byteLength === rawObject.byteLength
      && descriptor.bodySha256 === rawObject.contentSha256
      && descriptor.contentIdentitySha256 === (
        rawObject.objectKind === "body"
          ? rawObject.contentSha256
          : rawObject.pageReceiptSha256
      ),
      "terminal_object_projection",
    );
    if (rawObject.objectKind === "body") {
      rawResponseByteLength += rawObject.byteLength;
    }
  }
  archiveBinding(
    rawResponseByteLength === pass.rawResponseByteLength,
    "terminal_raw_response_bytes",
  );
}

function assertArchiveDocumentDescriptor({
  objects,
  logicalRole,
  mode,
  document,
  contentIdentitySha256,
}) {
  const descriptor = exactArchiveDescriptor(objects, logicalRole, mode);
  const metrics = canonicalDocumentMetrics(document);
  archiveBinding(
    descriptor.contentIdentitySha256 === contentIdentitySha256
    && descriptor.bodySha256 === metrics.bodySha256
    && descriptor.byteLength === metrics.byteLength,
    "document_body",
  );
  return descriptor;
}

function exactArchiveDescriptor(objects, logicalRole, mode) {
  const matches = objects.filter((value) =>
    value.logicalRole === logicalRole && value.mode === mode);
  archiveBinding(matches.length === 1, "descriptor_cardinality");
  return matches[0];
}

function exactArchivePageDescriptor(objects, logicalRole, mode, sequence) {
  const matches = objects.filter((value) =>
    value.logicalRole === logicalRole
    && value.mode === mode
    && value.sequence === sequence);
  archiveBinding(matches.length === 1, "page_descriptor_cardinality");
  return matches[0];
}

function canonicalDocumentMetrics(value) {
  const body = `${canonicalJson(value)}\n`;
  return {
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    byteLength: new TextEncoder().encode(body).byteLength,
  };
}

function archiveBinding(valid, suffix) {
  if (!valid) {
    protocolError(`source_archive_${suffix}_binding_mismatch`);
  }
}

function validateCurrentPlanPair(campaignInput, stateInput) {
  const campaignPlan = validateJsonCompatibilityCampaignPlan(campaignInput);
  const statePlan = validateJsonCompatibilityDeploymentStatePlan(stateInput);
  equal(
    campaignPlan.schemaVersion,
    CAMPAIGN_PLAN_SCHEMA_VERSION,
    "source campaign plan schema",
  );
  equal(
    statePlan.schemaVersion,
    STATE_PLAN_SCHEMA_VERSION,
    "source state plan schema",
  );
  equal(
    campaignPlan.deploymentStateBinding.planDigestSha256,
    statePlan.planDigestSha256,
    "source deployment-state plan binding",
  );
  return { campaignPlan, statePlan };
}

function validateArtifactSet(statePlan, input) {
  if (!Array.isArray(input)) protocolError("invalid_source_artifact_set");
  const expected = [];
  for (const [role, service] of Object.entries(statePlan.services)) {
    for (const [artifact, frozen] of Object.entries(service.artifacts)) {
      expected.push({ role, artifact, service, frozen });
    }
  }
  expected.sort((left, right) =>
    `${left.role}:${left.artifact}`.localeCompare(
      `${right.role}:${right.artifact}`,
    ));
  if (input.length !== expected.length) {
    protocolError("source_artifact_count_mismatch");
  }
  return expected.map((entry, index) => {
    const value = record(input[index], "source artifact observation");
    exactKeys(value, [
      "role", "artifact", "serviceName", "entrypoint", "deploymentState",
      "versionId", "configSha256", "gates", "privateRpcOnly", "workersDev",
      "previewUrls", "bindingSetSha256", "routeSetSha256",
      "secretNameSetSha256", "durableObjectMigrationSetSha256",
    ], "source artifact observation");
    for (const [label, actual, frozen] of [
      ["role", value.role, entry.role],
      ["artifact", value.artifact, entry.artifact],
      ["service name", value.serviceName, entry.service.serviceName],
      ["entrypoint", value.entrypoint, entry.service.entrypoint],
      ["deployment state", value.deploymentState,
        entry.frozen.deploymentState],
      ["version ID", value.versionId, entry.frozen.versionId],
      ["config digest", value.configSha256, entry.frozen.configSha256],
      ["private RPC", value.privateRpcOnly, entry.service.privateRpcOnly],
      ["workers.dev", value.workersDev, entry.service.workersDev],
      ["preview URLs", value.previewUrls, entry.service.previewUrls],
    ]) equal(actual, frozen, `source artifact ${label}`);
    canonicalEqual(value.gates, entry.frozen.gates, "source artifact gates");
    for (const [label, digest] of [
      ["binding set", value.bindingSetSha256],
      ["route set", value.routeSetSha256],
      ["secret-name set", value.secretNameSetSha256],
      ["Durable Object migration set",
        value.durableObjectMigrationSetSha256],
    ]) sha256(digest, `source artifact ${label}`);
    equal(
      value.routeSetSha256,
      EMPTY_ROUTE_SET_SHA256,
      "source artifact empty route set",
    );
    return cloneJson(value);
  });
}

function validateSignatureSubject(input) {
  const value = record(input, "source signature subject");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "profile", "operationIdSha256", "campaignPlanDigestSha256",
    "statePlanDigestSha256", "transitionId", "transitionOrdinal",
    "fromState", "toState", "transitionSha256", "accountIdSha256",
    "transitionSourceManifestSha256", "phaseSourceManifestSha256",
    "sourceVerifierPolicySha256", "sourceVerifierIdentitySha256",
    "artifactInventoryReadbackSha256", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256",
    "immutableSourceArchiveReceiptSha256", "issuedAt", "notBefore",
    "expiresAt",
  ], "source signature subject");
  equal(value.schemaVersion, SCHEMA_VERSION, "source subject schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_SUBJECT_CONTRACT,
    "source subject contract",
  );
  equal(value.environment, "staging", "source subject environment");
  return buildJsonCompatibilitySourceSignatureSubjectFromFields(value);
}

function buildJsonCompatibilitySourceSignatureSubjectFromFields(value) {
  equal(value.issuer, JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER, "source issuer");
  equal(
    value.audience,
    JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    "source audience",
  );
  safeToken(value.keyId, "source signature key ID");
  safeToken(value.transitionId, "source signature transition ID");
  positiveInteger(value.transitionOrdinal, "source signature transition ordinal");
  const pair = `${value.fromState}->${value.toState}`;
  const expectedProfile = pair === "dark->statusOnly"
      || pair === "statusOnly->execution"
    ? "release-v1"
    : pair === "execution->statusOnly" || pair === "statusOnly->dark"
      ? "campaign-closure-v1"
      : null;
  equal(value.profile, expectedProfile, "source signature profile");
  for (const [label, digest] of [
    ["operation ID", value.operationIdSha256],
    ["campaign plan", value.campaignPlanDigestSha256],
    ["state plan", value.statePlanDigestSha256],
    ["transition", value.transitionSha256],
    ["account ID", value.accountIdSha256],
    ["source verifier policy", value.sourceVerifierPolicySha256],
    ["source verifier identity", value.sourceVerifierIdentitySha256],
    ["transition source manifest", value.transitionSourceManifestSha256],
    ["artifact inventory", value.artifactInventoryReadbackSha256],
    ["account binding evidence", value.accountBindingEvidenceSha256],
    ["account binding inventory", value.accountBindingInventorySha256],
    ["archive receipt", value.immutableSourceArchiveReceiptSha256],
  ]) sha256(digest, `source signature ${label}`);
  if (value.profile === "release-v1") {
    equal(
      value.phaseSourceManifestSha256,
      null,
      "release signature phase source manifest",
    );
  } else {
    sha256(value.phaseSourceManifestSha256, "closure signature phase manifest");
  }
  integer(value.issuedAt, "source signature issue time");
  integer(value.notBefore, "source signature not-before time");
  integer(value.expiresAt, "source signature expiry time");
  if (
    value.notBefore < value.issuedAt - 5
    || value.expiresAt <= value.notBefore
    || value.expiresAt - value.issuedAt
      > JSON_COMPATIBILITY_SOURCE_SIGNATURE_MAX_LIFETIME_SECONDS
  ) protocolError("invalid_source_signature_window");
  return cloneJson(value);
}

function base64urlBytes(value, label, minimum, maximum) {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    protocolError("invalid_source_base64url", `${label} is invalid`);
  }
  let decoded;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(`${normalized}${padding}`);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    protocolError("invalid_source_base64url", `${label} is invalid`);
  }
  if (decoded.length < minimum || decoded.length > maximum) {
    protocolError("invalid_source_base64url_length", `${label} is invalid`);
  }
  return decoded;
}

function sourceVerifierTrustKey(input, requireAcceptUntil) {
  const value = record(input, "source verifier trust key");
  exactKeys(
    value,
    requireAcceptUntil
      ? ["keyId", "spkiSha256", "acceptUntil"]
      : ["keyId", "spkiSha256"],
    "source verifier trust key",
  );
  safeToken(value.keyId, "source verifier trust key ID");
  sha256(value.spkiSha256, "source verifier trust SPKI");
  if (requireAcceptUntil) {
    positiveInteger(value.acceptUntil, "source verifier previous accept time");
  }
  return cloneJson(value);
}

function record(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) protocolError("invalid_source_document", `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    protocolError("invalid_source_document_keys", `${label} has invalid keys`);
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    protocolError("source_binding_mismatch", `${label} does not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    protocolError("source_binding_mismatch", `${label} does not match`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    protocolError("invalid_source_sha256", `${label} must be SHA-256`);
  }
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    protocolError("invalid_source_token", `${label} is invalid`);
  }
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    protocolError("invalid_source_integer", `${label} must be an integer`);
  }
}

function nonnegativeInteger(value, label) {
  integer(value, label);
}

function positiveInteger(value, label) {
  integer(value, label);
  if (value < 1) {
    protocolError("invalid_source_integer", `${label} must be positive`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function protocolError(code, message = code) {
  throw new JsonCompatibilitySourceAuthenticationProtocolError(code, message);
}
