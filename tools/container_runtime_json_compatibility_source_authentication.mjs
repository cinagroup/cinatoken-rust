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

export const JSON_COMPATIBILITY_SOURCE_ARTIFACT_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-artifact-inventory-readback-v1";
export const JSON_COMPATIBILITY_TRANSITION_SOURCE_MANIFEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-transition-source-manifest-v1";
export const JSON_COMPATIBILITY_SOURCE_ACCOUNT_BINDING_INVENTORY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-account-binding-inventory-v1";
export const JSON_COMPATIBILITY_SOURCE_ARCHIVE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-immutable-archive-receipt-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-signature-subject-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-signature-envelope-v1";
export const JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v1";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-source-signature-v1\n";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER =
  "cinatoken-json-compatibility-source-archive-authority-staging";
export const JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE =
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
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
      "cinatoken-container-runtime-json-compatibility-source-verifier-policy-v1",
    environment: "staging",
    serviceName,
    profileVersion,
    keyPrefix,
    issuer,
    audience,
    current,
    previous,
  };
  return { ...subject, sourceVerifierPolicySha256: sha256Canonical(subject) };
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
  accountIdSha256,
  transitionSourceManifestSha256,
  phaseSourceManifestSha256,
  artifactInventoryReadbackSha256,
  accountBindingInventorySha256,
  immutableSourceArchiveSha256,
  archiveObjectVersionSha256,
  archiveObjectEtagSha256,
  archiveByteLength,
  lockedAt,
  retainUntil,
  independentlyReadBackAt,
  retentionEvidenceSha256,
}) {
  for (const [label, value] of [
    ["account ID", accountIdSha256],
    ["transition source manifest", transitionSourceManifestSha256],
    ["artifact inventory", artifactInventoryReadbackSha256],
    ["account binding inventory", accountBindingInventorySha256],
    ["immutable source archive", immutableSourceArchiveSha256],
    ["archive object version", archiveObjectVersionSha256],
    ["archive object ETag", archiveObjectEtagSha256],
    ["retention evidence", retentionEvidenceSha256],
  ]) sha256(value, `source archive ${label}`);
  if (phaseSourceManifestSha256 !== null) {
    sha256(phaseSourceManifestSha256, "source archive phase source manifest");
  }
  positiveInteger(archiveByteLength, "source archive byte length");
  integer(lockedAt, "source archive lock time");
  integer(retainUntil, "source archive retention time");
  integer(independentlyReadBackAt, "source archive readback time");
  if (
    independentlyReadBackAt < lockedAt
    || retainUntil - lockedAt
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
    accountIdSha256,
    transitionSourceManifestSha256,
    phaseSourceManifestSha256,
    artifactInventoryReadbackSha256,
    accountBindingInventorySha256,
    immutableSourceArchiveSha256,
    archiveObjectVersionSha256,
    archiveObjectEtagSha256,
    archiveByteLength,
    lockedAt,
    retainUntil,
    independentlyReadBackAt,
    retentionEvidenceSha256,
  };
  return {
    ...subject,
    immutableSourceArchiveReceiptSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilitySourceImmutableArchiveReceipt(input) {
  const value = record(input, "source immutable archive receipt");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "archiveBackend",
    "retentionMode", "accountIdSha256", "transitionSourceManifestSha256",
    "phaseSourceManifestSha256",
    "artifactInventoryReadbackSha256", "accountBindingInventorySha256",
    "immutableSourceArchiveSha256", "archiveObjectVersionSha256",
    "archiveObjectEtagSha256", "archiveByteLength", "lockedAt",
    "retainUntil", "independentlyReadBackAt", "retentionEvidenceSha256",
    "immutableSourceArchiveReceiptSha256",
  ], "source immutable archive receipt");
  const rebuilt = buildJsonCompatibilitySourceImmutableArchiveReceipt(value);
  canonicalEqual(rebuilt, value, "source immutable archive receipt");
  return cloneJson(value);
}

export function buildJsonCompatibilitySourceSignatureSubject({
  sourceAuthenticationRequest: requestInput,
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
    transitionSourceManifestSha256:
      source.transitionSourceManifestSha256,
    phaseSourceManifestSha256: source.phaseSourceManifestSha256,
    artifactInventoryReadbackSha256:
      source.artifactInventoryReadbackSha256,
    accountBindingInventorySha256: source.accountBindingInventorySha256,
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
  accountBindingInventory,
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
    accountBindingInventory,
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
    "accountBindingInventory", "immutableSourceArchiveReceipt",
    "sourceSignatureEnvelope", "bundleSha256",
  ], "source authentication bundle");
  const rebuilt = buildJsonCompatibilitySourceAuthenticationBundle({
    sourceAuthenticationRequest,
    campaignPlan: value.campaignPlan,
    statePlan: value.statePlan,
    transitionSourceManifest: value.transitionSourceManifest,
    phaseSourceManifest: value.phaseSourceManifest,
    artifactInventoryReadback: value.artifactInventoryReadback,
    accountBindingInventory: value.accountBindingInventory,
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
  prefix = "container-runtime/json-compatibility/source-authentication/v2/sha256",
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
  prefix = "container-runtime/json-compatibility/source-authentication/v2/sha256",
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
  const accountBindingInventory =
    validateJsonCompatibilitySourceAccountBindingInventory(
      campaignPlan,
      statePlan,
      input.accountBindingInventory,
    );
  const archiveReceipt =
    validateJsonCompatibilitySourceImmutableArchiveReceipt(
      input.immutableSourceArchiveReceipt,
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
    ["archive account inventory",
      archiveReceipt.accountBindingInventorySha256,
      source.accountBindingInventorySha256],
  ]) equal(actual, expected, `source bundle ${label}`);
  const expectedSubject = buildJsonCompatibilitySourceSignatureSubject({
    sourceAuthenticationRequest: request,
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
    accountBindingInventory: cloneJson(accountBindingInventory),
    immutableSourceArchiveReceipt: cloneJson(archiveReceipt),
    sourceSignatureEnvelope: cloneJson(envelope),
  };
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
    "sourceVerifierPolicySha256",
    "artifactInventoryReadbackSha256", "accountBindingInventorySha256",
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
    ["transition source manifest", value.transitionSourceManifestSha256],
    ["artifact inventory", value.artifactInventoryReadbackSha256],
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
