import {
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityDeploymentStatePlan,
} from "./container_runtime_json_compatibility_deployment_states.mjs";
import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS,
  validateJsonCompatibilityAccountBindingCredentialProvenance,
} from "./container_runtime_json_compatibility_account_binding_credentials.mjs";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTOR_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-collector-identity-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_PROFILE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-collection-profile-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_AUTHENTICATION_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-authentication-identity-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_PAGE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-page-receipt-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_SNAPSHOT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-snapshot-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_ARTIFACT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-collection-artifact-v1";
export const JSON_COMPATIBILITY_ACCOUNT_BINDING_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-evidence-v1";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES =
  Object.freeze([
    "credential-verification",
    "workers-scripts",
    "worker-deployments",
    "worker-version",
    "worker-subdomain",
    "account-worker-domains",
    "account-zones",
    "zone-worker-routes",
  ]);

const SCHEMA_VERSION = 1;
const CAMPAIGN_PLAN_SCHEMA_VERSION = 4;
const STATE_PLAN_SCHEMA_VERSION = 2;
const MIN_INDEPENDENT_READBACK_DELAY_SECONDS = 5;
const MAX_INDEPENDENT_READBACK_DELAY_SECONDS = 15 * 60;
const SHA256 = /^[0-9a-f]{64}$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const RESOURCE_FAMILY_SET = new Set(
  JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES,
);

export class JsonCompatibilityAccountBindingEvidenceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityAccountBindingEvidenceError";
    this.code = code;
  }
}

export function buildJsonCompatibilityAccountBindingCollectorIdentity({
  sourceRevisionSha256,
  sourceTreeSha256,
  executableSha256,
  dependencyLockSha256,
}) {
  for (const [label, value] of [
    ["source revision", sourceRevisionSha256],
    ["source tree", sourceTreeSha256],
    ["collector executable", executableSha256],
    ["dependency lock", dependencyLockSha256],
  ]) sha256(value, label);
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTOR_IDENTITY_CONTRACT,
    implementation:
      "tools/collect_container_runtime_json_compatibility_account_bindings.mjs",
    runtime: "bun",
    sourceRevisionSha256,
    sourceTreeSha256,
    executableSha256,
    dependencyLockSha256,
  };
  return {
    ...subject,
    collectorIdentitySha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCollectorIdentity(input) {
  const value = record(input, "collector identity");
  exactKeys(value, [
    "schemaVersion", "contract", "implementation", "runtime",
    "sourceRevisionSha256", "sourceTreeSha256", "executableSha256",
    "dependencyLockSha256", "collectorIdentitySha256",
  ], "collector identity");
  const rebuilt = buildJsonCompatibilityAccountBindingCollectorIdentity(value);
  canonicalEqual(rebuilt, value, "collector identity");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCollectionProfile({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  accountIdSha256,
  collectorIdentitySha256,
  credentialProvenance: credentialProvenanceInput,
  credentialProvenanceApprovedAt,
  allowedCampaignBindingEdges: edgeInput,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  for (const [label, value] of [
    ["account ID", accountIdSha256],
    ["collector identity", collectorIdentitySha256],
  ]) sha256(value, `collection profile ${label}`);
  const credentialProvenance =
    validateJsonCompatibilityAccountBindingCredentialProvenance(
      credentialProvenanceInput,
    );
  equal(
    credentialProvenance.accountIdSha256,
    accountIdSha256,
    "collection profile credential account",
  );
  integer(
    credentialProvenanceApprovedAt,
    "collection profile credential approval time",
  );
  if (
    credentialProvenance.revocation.subject.issuedAt
      > credentialProvenanceApprovedAt
    || credentialProvenance.revocation.subject.expiresAt
      < credentialProvenanceApprovedAt
    || [
      credentialProvenance.collectionReceipt.subject,
      credentialProvenance.readbackReceipt.subject,
    ].some((receipt) =>
      receipt.createdAt > credentialProvenanceApprovedAt
      || receipt.expiresAt - credentialProvenanceApprovedAt
        < JSON_COMPATIBILITY_ACCOUNT_BINDING_CREDENTIAL_MIN_REMAINING_SECONDS)
  ) fail("collection_profile_credential_provenance_not_current");
  const campaignServices = Object.entries(statePlan.services)
    .map(([role, service]) => ({
      role,
      serviceName: service.serviceName,
      entrypoint: service.entrypoint,
    }))
    .sort((left, right) => compareAscii(left.role, right.role));
  const campaignNames = new Set(campaignServices.map((value) => value.serviceName));
  const allowedCampaignBindingEdges = normalizeLogicalBindingEdges(
    edgeInput,
    "collection profile campaign edge",
  );
  for (const edge of allowedCampaignBindingEdges) {
    if (
      !campaignNames.has(edge.callerServiceName)
      && !campaignNames.has(edge.targetServiceName)
    ) {
      fail("profile_edge_not_adjacent_to_campaign_service");
    }
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_PROFILE_CONTRACT,
    environment: "staging",
    accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    collectorIdentitySha256,
    credentialProvenance,
    credentialProvenanceApprovedAt,
    credentialProvenanceSha256:
      credentialProvenance.credentialProvenanceSha256,
    credentialTrustPolicySha256:
      credentialProvenance.credentialTrustPolicySha256,
    credentialRevocationStateSha256:
      credentialProvenance.credentialRevocationStateSha256,
    collectionCredentialIdSha256:
      credentialProvenance.collectionCredentialIdSha256,
    readbackCredentialIdSha256:
      credentialProvenance.readbackCredentialIdSha256,
    collectionCredentialReceiptSha256:
      credentialProvenance.collectionCredentialReceiptSha256,
    readbackCredentialReceiptSha256:
      credentialProvenance.readbackCredentialReceiptSha256,
    collectionPermissionSetSha256:
      credentialProvenance.collectionPermissionSetSha256,
    readbackPermissionSetSha256:
      credentialProvenance.readbackPermissionSetSha256,
    collectionCustodianIdentitySha256:
      credentialProvenance.collectionCustodianIdentitySha256,
    readbackCustodianIdentitySha256:
      credentialProvenance.readbackCustodianIdentitySha256,
    requiredResourceFamilies: [
      ...JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES,
    ],
    campaignServices,
    allowedCampaignBindingEdges,
    minimumIndependentReadbackDelaySeconds:
      MIN_INDEPENDENT_READBACK_DELAY_SECONDS,
    maximumIndependentReadbackDelaySeconds:
      MAX_INDEPENDENT_READBACK_DELAY_SECONDS,
  };
  return {
    ...subject,
    collectionProfileSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCollectionProfile(
  campaignPlan,
  statePlan,
  input,
) {
  const value = record(input, "account binding collection profile");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256",
    "collectorIdentitySha256", "credentialProvenance",
    "credentialProvenanceApprovedAt",
    "credentialProvenanceSha256", "credentialTrustPolicySha256",
    "credentialRevocationStateSha256",
    "collectionCredentialIdSha256", "readbackCredentialIdSha256",
    "collectionCredentialReceiptSha256",
    "readbackCredentialReceiptSha256", "collectionPermissionSetSha256",
    "readbackPermissionSetSha256", "collectionCustodianIdentitySha256",
    "readbackCustodianIdentitySha256", "requiredResourceFamilies",
    "campaignServices", "allowedCampaignBindingEdges",
    "minimumIndependentReadbackDelaySeconds",
    "maximumIndependentReadbackDelaySeconds", "collectionProfileSha256",
  ], "account binding collection profile");
  const rebuilt = buildJsonCompatibilityAccountBindingCollectionProfile({
    campaignPlan,
    statePlan,
    accountIdSha256: value.accountIdSha256,
    collectorIdentitySha256: value.collectorIdentitySha256,
    credentialProvenance: value.credentialProvenance,
    credentialProvenanceApprovedAt: value.credentialProvenanceApprovedAt,
    allowedCampaignBindingEdges: value.allowedCampaignBindingEdges,
  });
  canonicalEqual(rebuilt, value, "account binding collection profile");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingAuthenticationIdentity({
  accountIdSha256,
  credentialIdSha256,
  permissionSetSha256,
  credentialVerificationPageReceiptSha256,
  credentialVerificationResponseBodySha256,
  credentialReceiptSha256,
  custodianIdentitySha256,
  credentialTrustPolicySha256,
  credentialRevocationStateSha256,
  credentialProvenanceSha256,
  verifiedAt,
}) {
  for (const [label, value] of [
    ["account ID", accountIdSha256],
    ["credential ID", credentialIdSha256],
    ["permission set", permissionSetSha256],
    ["credential verification page receipt",
      credentialVerificationPageReceiptSha256],
    ["credential verification response body",
      credentialVerificationResponseBodySha256],
    ["credential receipt", credentialReceiptSha256],
    ["custodian identity", custodianIdentitySha256],
    ["credential trust policy", credentialTrustPolicySha256],
    ["credential revocation state", credentialRevocationStateSha256],
    ["credential provenance", credentialProvenanceSha256],
  ]) sha256(value, `authentication identity ${label}`);
  integer(verifiedAt, "authentication identity verification time");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_AUTHENTICATION_IDENTITY_CONTRACT,
    environment: "staging",
    accountIdSha256,
    credentialIdSha256,
    permissionSetSha256,
    credentialVerificationPageReceiptSha256,
    credentialVerificationResponseBodySha256,
    credentialReceiptSha256,
    custodianIdentitySha256,
    credentialTrustPolicySha256,
    credentialRevocationStateSha256,
    credentialProvenanceSha256,
    active: true,
    readOnly: true,
    verifiedAt,
  };
  return {
    ...subject,
    authenticationIdentitySha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingAuthenticationIdentity(
  input,
) {
  const value = record(input, "account binding authentication identity");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "credentialIdSha256", "permissionSetSha256",
    "credentialVerificationPageReceiptSha256",
    "credentialVerificationResponseBodySha256", "credentialReceiptSha256",
    "custodianIdentitySha256", "credentialTrustPolicySha256",
    "credentialRevocationStateSha256", "credentialProvenanceSha256",
    "active", "readOnly", "verifiedAt", "authenticationIdentitySha256",
  ], "account binding authentication identity");
  const rebuilt = buildJsonCompatibilityAccountBindingAuthenticationIdentity(
    value,
  );
  canonicalEqual(rebuilt, value, "account binding authentication identity");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingPageReceipt({
  sequence,
  resourceFamily,
  resourceIdentitySha256,
  requestPathSha256,
  responseBodySha256,
  responseByteLength,
  resultCount,
  pageNumber,
  totalPages,
  requestIdSha256,
  predecessorSha256,
  observedAt,
}) {
  positiveInteger(sequence, "page receipt sequence");
  if (!RESOURCE_FAMILY_SET.has(resourceFamily)) {
    fail("unknown_account_binding_resource_family");
  }
  for (const [label, value] of [
    ["resource identity", resourceIdentitySha256],
    ["request path", requestPathSha256],
    ["response body", responseBodySha256],
    ["request ID", requestIdSha256],
  ]) sha256(value, `page receipt ${label}`);
  positiveInteger(responseByteLength, "page response byte length");
  nonnegativeInteger(resultCount, "page result count");
  nullablePositiveInteger(pageNumber, "page number");
  nullablePositiveInteger(totalPages, "total pages");
  if ((pageNumber === null) !== (totalPages === null)) {
    fail("page_number_metadata_incomplete");
  }
  if (pageNumber !== null && pageNumber > totalPages) {
    fail("page_number_exceeds_total");
  }
  if (sequence === 1) {
    equal(predecessorSha256, null, "first page predecessor");
  } else {
    sha256(predecessorSha256, "page predecessor");
  }
  integer(observedAt, "page observation time");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_PAGE_RECEIPT_CONTRACT,
    environment: "staging",
    sequence,
    resourceFamily,
    resourceIdentitySha256,
    method: "GET",
    requestPathSha256,
    responseBodySha256,
    responseByteLength,
    resultCount,
    pageNumber,
    totalPages,
    requestIdSha256,
    predecessorSha256,
    observedAt,
  };
  return { ...subject, pageReceiptSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilityAccountBindingPageReceipt(input) {
  const value = record(input, "account binding page receipt");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "sequence",
    "resourceFamily", "resourceIdentitySha256", "method",
    "requestPathSha256", "responseBodySha256",
    "responseByteLength", "resultCount", "pageNumber", "totalPages",
    "requestIdSha256", "predecessorSha256", "observedAt",
    "pageReceiptSha256",
  ], "account binding page receipt");
  equal(value.method, "GET", "page receipt method");
  const rebuilt = buildJsonCompatibilityAccountBindingPageReceipt(value);
  canonicalEqual(rebuilt, value, "account binding page receipt");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingSnapshot({
  accountIdSha256,
  services: servicesInput,
  zoneIdSha256s: zoneInput,
  routes: routesInput,
  serviceBindingEdges: edgeInput,
  pageReceipts: pageInput,
  observedAt,
}) {
  sha256(accountIdSha256, "account binding snapshot account ID");
  integer(observedAt, "account binding snapshot observation time");
  const services = normalizeServices(servicesInput);
  const serviceNames = services.map((value) => value.serviceName);
  const serviceNameSet = new Set(serviceNames);
  const serviceMap = new Map(
    services.map((value) => [value.serviceName, value]),
  );
  const zoneIdSha256s = normalizeZoneIdentities(zoneInput);
  const zoneIdentitySet = new Set(zoneIdSha256s);
  const routes = normalizeRoutes(
    routesInput,
    services,
    serviceNameSet,
    zoneIdentitySet,
  );
  const serviceBindingEdges = normalizeVersionedBindingEdges(
    edgeInput,
    serviceMap,
  );
  for (const service of services) {
    equal(
      service.versionBindingSetSha256,
      sha256Canonical(serviceBindingEdges.filter(
        (edge) => edge.callerServiceName === service.serviceName,
      )),
      `service binding set ${service.serviceName}`,
    );
  }
  const pageReceipts = validatePageChain({
    input: pageInput,
    snapshotObservedAt: observedAt,
    accountIdSha256,
    services,
    zoneIdSha256s,
    routes,
  });
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_SNAPSHOT_CONTRACT,
    environment: "staging",
    accountIdSha256,
    services,
    zoneIdSha256s,
    zoneIdSetSha256: sha256Canonical(zoneIdSha256s),
    zoneCount: zoneIdSha256s.length,
    routes,
    serviceBindingEdges,
    accountServiceNameSetSha256: sha256Canonical(serviceNames),
    accountRouteSetSha256: sha256Canonical(routes),
    accountServiceBindingEdgeSetSha256:
      sha256Canonical(serviceBindingEdges),
    accountServiceCount: services.length,
    accountRouteCount: routes.length,
    accountServiceBindingEdgeCount: serviceBindingEdges.length,
    cloudflareApiRequestCount: pageReceipts.length,
    cloudflareApiPageCount: pageReceipts.length,
    paginationComplete: true,
    pageReceipts,
    pageChainHeadSha256:
      pageReceipts[pageReceipts.length - 1].pageReceiptSha256,
    observedAt,
  };
  return { ...subject, snapshotSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilityAccountBindingSnapshot(input) {
  const value = record(input, "account binding snapshot");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "accountIdSha256",
    "services", "zoneIdSha256s", "zoneIdSetSha256", "zoneCount",
    "routes", "serviceBindingEdges",
    "accountServiceNameSetSha256", "accountRouteSetSha256",
    "accountServiceBindingEdgeSetSha256", "accountServiceCount",
    "accountRouteCount", "accountServiceBindingEdgeCount",
    "cloudflareApiRequestCount", "cloudflareApiPageCount",
    "paginationComplete", "pageReceipts", "pageChainHeadSha256",
    "observedAt", "snapshotSha256",
  ], "account binding snapshot");
  const rebuilt = buildJsonCompatibilityAccountBindingSnapshot({
    accountIdSha256: value.accountIdSha256,
    services: value.services,
    zoneIdSha256s: value.zoneIdSha256s,
    routes: value.routes,
    serviceBindingEdges: value.serviceBindingEdges,
    pageReceipts: value.pageReceipts,
    observedAt: value.observedAt,
  });
  canonicalEqual(rebuilt, value, "account binding snapshot");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingCollectionArtifact({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  collectionProfile: profileInput,
  mode,
  collectorIdentity: collectorIdentityInput,
  authenticationIdentity: authenticationIdentityInput,
  snapshot: snapshotInput,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  oneOf(mode, ["collection", "independent-readback"], "collection mode");
  const profile = validateJsonCompatibilityAccountBindingCollectionProfile(
    campaignPlan,
    statePlan,
    profileInput,
  );
  const collectorIdentity =
    validateJsonCompatibilityAccountBindingCollectorIdentity(
      collectorIdentityInput,
    );
  const authenticationIdentity =
    validateJsonCompatibilityAccountBindingAuthenticationIdentity(
      authenticationIdentityInput,
    );
  const snapshot = validateJsonCompatibilityAccountBindingSnapshot(
    snapshotInput,
  );
  const credentialVerificationPage = snapshot.pageReceipts.find(
    (page) => page.resourceFamily === "credential-verification",
  );
  for (const [label, actual, expected] of [
    ["profile account", profile.accountIdSha256, snapshot.accountIdSha256],
    ["authentication account", authenticationIdentity.accountIdSha256,
      snapshot.accountIdSha256],
    ["collector identity", collectorIdentity.collectorIdentitySha256,
      profile.collectorIdentitySha256],
    ["permission set", authenticationIdentity.permissionSetSha256,
      mode === "collection"
        ? profile.collectionPermissionSetSha256
        : profile.readbackPermissionSetSha256],
    ["credential ID", authenticationIdentity.credentialIdSha256,
      mode === "collection"
        ? profile.collectionCredentialIdSha256
        : profile.readbackCredentialIdSha256],
    ["credential receipt", authenticationIdentity.credentialReceiptSha256,
      mode === "collection"
        ? profile.collectionCredentialReceiptSha256
        : profile.readbackCredentialReceiptSha256],
    ["credential custodian", authenticationIdentity.custodianIdentitySha256,
      mode === "collection"
        ? profile.collectionCustodianIdentitySha256
        : profile.readbackCustodianIdentitySha256],
    ["credential trust policy",
      authenticationIdentity.credentialTrustPolicySha256,
      profile.credentialTrustPolicySha256],
    ["credential revocation state",
      authenticationIdentity.credentialRevocationStateSha256,
      profile.credentialRevocationStateSha256],
    ["credential provenance",
      authenticationIdentity.credentialProvenanceSha256,
      profile.credentialProvenanceSha256],
    ["credential verification page receipt",
      authenticationIdentity.credentialVerificationPageReceiptSha256,
      credentialVerificationPage.pageReceiptSha256],
    ["credential verification response body",
      authenticationIdentity.credentialVerificationResponseBodySha256,
      credentialVerificationPage.responseBodySha256],
  ]) equal(actual, expected, `account binding artifact ${label}`);
  const credentialReceipt = mode === "collection"
    ? profile.credentialProvenance.collectionReceipt.subject
    : profile.credentialProvenance.readbackReceipt.subject;
  const revocation = profile.credentialProvenance.revocation.subject;
  if (
    authenticationIdentity.verifiedAt
      < profile.credentialProvenanceApprovedAt
    || credentialReceipt.createdAt > authenticationIdentity.verifiedAt
    || credentialReceipt.expiresAt <= authenticationIdentity.verifiedAt
    || revocation.issuedAt > authenticationIdentity.verifiedAt
    || revocation.expiresAt <= authenticationIdentity.verifiedAt
    || credentialVerificationPage.observedAt
      > authenticationIdentity.verifiedAt
    || (
      credentialReceipt.keyId === profile.credentialProvenance.trustPolicy
        .previous?.keyId
      && authenticationIdentity.verifiedAt
        > profile.credentialProvenance.trustPolicy.previous.acceptUntil
    )
  ) fail("authentication_credential_not_current");
  if (authenticationIdentity.verifiedAt > snapshot.observedAt) {
    fail("authentication_verified_after_snapshot");
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_ACCOUNT_BINDING_COLLECTION_ARTIFACT_CONTRACT,
    kind: "container-runtime-json-compatibility-account-binding-collection",
    environment: "staging",
    mode,
    accountIdSha256: snapshot.accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    collectionProfileSha256: profile.collectionProfileSha256,
    collectorIdentity,
    authenticationIdentity,
    snapshot,
    observedAt: snapshot.observedAt,
  };
  return {
    ...subject,
    collectionArtifactSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingCollectionArtifact(
  campaignPlan,
  statePlan,
  collectionProfile,
  input,
) {
  const value = record(input, "account binding collection artifact");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "mode",
    "accountIdSha256", "campaignPlanDigestSha256",
    "statePlanDigestSha256", "collectionProfileSha256",
    "collectorIdentity", "authenticationIdentity", "snapshot", "observedAt",
    "collectionArtifactSha256",
  ], "account binding collection artifact");
  const rebuilt = buildJsonCompatibilityAccountBindingCollectionArtifact({
    campaignPlan,
    statePlan,
    collectionProfile,
    mode: value.mode,
    collectorIdentity: value.collectorIdentity,
    authenticationIdentity: value.authenticationIdentity,
    snapshot: value.snapshot,
  });
  canonicalEqual(rebuilt, value, "account binding collection artifact");
  return cloneJson(value);
}

export function buildJsonCompatibilityAccountBindingEvidence({
  campaignPlan: campaignPlanInput,
  statePlan: statePlanInput,
  collectionProfile: profileInput,
  collection: collectionInput,
  independentReadback: readbackInput,
}) {
  const { campaignPlan, statePlan } = validateCurrentPlanPair(
    campaignPlanInput,
    statePlanInput,
  );
  const profile = validateJsonCompatibilityAccountBindingCollectionProfile(
    campaignPlan,
    statePlan,
    profileInput,
  );
  const collection =
    validateJsonCompatibilityAccountBindingCollectionArtifact(
      campaignPlan,
      statePlan,
      profile,
      collectionInput,
    );
  const independentReadback =
    validateJsonCompatibilityAccountBindingCollectionArtifact(
      campaignPlan,
      statePlan,
      profile,
      readbackInput,
    );
  equal(collection.mode, "collection", "first account binding collection mode");
  equal(
    independentReadback.mode,
    "independent-readback",
    "second account binding collection mode",
  );
  if (
    collection.authenticationIdentity.credentialIdSha256 ===
      independentReadback.authenticationIdentity.credentialIdSha256
  ) fail("independent_readback_credential_reused");
  const delay = independentReadback.observedAt - collection.observedAt;
  if (
    delay < profile.minimumIndependentReadbackDelaySeconds
    || delay > profile.maximumIndependentReadbackDelaySeconds
  ) fail("independent_readback_delay_invalid");
  const first = collection.snapshot;
  const second = independentReadback.snapshot;
  for (const [label, left, right] of [
    ["service inventory", sha256Canonical(first.services),
      sha256Canonical(second.services)],
    ["zone identities", first.zoneIdSetSha256, second.zoneIdSetSha256],
    ["zone count", first.zoneCount, second.zoneCount],
    ["service names", first.accountServiceNameSetSha256,
      second.accountServiceNameSetSha256],
    ["routes", first.accountRouteSetSha256, second.accountRouteSetSha256],
    ["service binding edges", first.accountServiceBindingEdgeSetSha256,
      second.accountServiceBindingEdgeSetSha256],
    ["service count", first.accountServiceCount, second.accountServiceCount],
    ["route count", first.accountRouteCount, second.accountRouteCount],
    ["binding edge count", first.accountServiceBindingEdgeCount,
      second.accountServiceBindingEdgeCount],
  ]) equal(left, right, `independent account binding ${label}`);
  const assertions = deriveCampaignAssertions(profile, second);
  const authenticationIdentitySha256 = sha256Canonical({
    collection: collection.authenticationIdentity.authenticationIdentitySha256,
    independentReadback:
      independentReadback.authenticationIdentity.authenticationIdentitySha256,
  });
  const pageChainHeadSha256 = sha256Canonical({
    collection: first.pageChainHeadSha256,
    independentReadback: second.pageChainHeadSha256,
  });
  const readbackSubject = {
    collectionArtifactSha256: collection.collectionArtifactSha256,
    independentReadbackArtifactSha256:
      independentReadback.collectionArtifactSha256,
    collectionSnapshotSha256: first.snapshotSha256,
    independentReadbackSnapshotSha256: second.snapshotSha256,
    authenticationIdentitySha256,
    pageChainHeadSha256,
    stableSemanticInventory: true,
  };
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_ACCOUNT_BINDING_EVIDENCE_CONTRACT,
    kind: "container-runtime-json-compatibility-account-binding-evidence",
    environment: "staging",
    accountIdSha256: second.accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    collectionProfile: profile,
    collection,
    independentReadback,
    stableSemanticInventory: true,
    ...assertions,
    accountServiceNameSetSha256: second.accountServiceNameSetSha256,
    zoneIdSetSha256: second.zoneIdSetSha256,
    zoneCount: second.zoneCount,
    accountRouteSetSha256: second.accountRouteSetSha256,
    accountServiceBindingEdgeSetSha256:
      second.accountServiceBindingEdgeSetSha256,
    accountServiceCount: second.accountServiceCount,
    accountRouteCount: second.accountRouteCount,
    accountServiceBindingEdgeCount: second.accountServiceBindingEdgeCount,
    cloudflareApiRequestCount:
      first.cloudflareApiRequestCount + second.cloudflareApiRequestCount,
    cloudflareApiPageCount:
      first.cloudflareApiPageCount + second.cloudflareApiPageCount,
    paginationComplete: true,
    collectorIdentitySha256: profile.collectorIdentitySha256,
    authenticationIdentitySha256,
    pageChainHeadSha256,
    readbackEvidenceSha256: sha256Canonical(readbackSubject),
    observedAt: second.observedAt,
  };
  return {
    ...subject,
    accountBindingEvidenceSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityAccountBindingEvidence(
  campaignPlan,
  statePlan,
  input,
) {
  const value = record(input, "account binding evidence");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "accountIdSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256", "collectionProfile",
    "collection", "independentReadback", "stableSemanticInventory",
    "campaignServiceNames", "campaignPrivateRpcOnly",
    "campaignPublicRouteCount", "campaignWorkersDevEnabledCount",
    "campaignPreviewUrlEnabledCount", "campaignUnexpectedCallerBindingCount",
    "accountServiceNameSetSha256", "zoneIdSetSha256", "zoneCount",
    "accountRouteSetSha256",
    "accountServiceBindingEdgeSetSha256", "accountServiceCount",
    "accountRouteCount", "accountServiceBindingEdgeCount",
    "cloudflareApiRequestCount", "cloudflareApiPageCount",
    "paginationComplete", "collectorIdentitySha256",
    "authenticationIdentitySha256", "pageChainHeadSha256",
    "readbackEvidenceSha256", "observedAt",
    "accountBindingEvidenceSha256",
  ], "account binding evidence");
  const rebuilt = buildJsonCompatibilityAccountBindingEvidence({
    campaignPlan,
    statePlan,
    collectionProfile: value.collectionProfile,
    collection: value.collection,
    independentReadback: value.independentReadback,
  });
  canonicalEqual(rebuilt, value, "account binding evidence");
  return cloneJson(value);
}

export function accountBindingInventoryInputFromEvidence(input) {
  const value = record(input, "account binding evidence projection");
  return cloneJson({
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
}

function deriveCampaignAssertions(profile, snapshot) {
  const campaignServiceNames = profile.campaignServices
    .map((value) => value.serviceName)
    .sort(compareAscii);
  const campaignSet = new Set(campaignServiceNames);
  const serviceMap = new Map(
    snapshot.services.map((value) => [value.serviceName, value]),
  );
  for (const name of campaignServiceNames) {
    const service = serviceMap.get(name);
    if (service === undefined) fail("campaign_service_missing_from_account");
    if (service.activeVersionIds.length === 0) {
      fail("campaign_service_has_no_active_version");
    }
  }
  const campaignPublicRouteCount = snapshot.routes.filter(
    (route) => route.serviceName !== null && campaignSet.has(route.serviceName),
  ).length;
  const campaignWorkersDevEnabledCount = campaignServiceNames.filter(
    (name) => serviceMap.get(name).workersDev,
  ).length;
  const campaignPreviewUrlEnabledCount = campaignServiceNames.filter(
    (name) => serviceMap.get(name).previewUrls,
  ).length;
  const actualLogical = normalizeLogicalBindingEdges(
    snapshot.serviceBindingEdges
      .filter((edge) =>
        campaignSet.has(edge.callerServiceName)
        || campaignSet.has(edge.targetServiceName))
      .map(({ callerVersionId: _ignored, ...edge }) => edge),
    "account campaign binding edge",
    true,
  );
  const allowedKeys = new Set(
    profile.allowedCampaignBindingEdges.map(logicalEdgeKey),
  );
  const actualKeys = new Set(actualLogical.map(logicalEdgeKey));
  const campaignUnexpectedCallerBindingCount = actualLogical.filter(
    (edge) => !allowedKeys.has(logicalEdgeKey(edge)),
  ).length;
  for (const allowed of allowedKeys) {
    if (!actualKeys.has(allowed)) fail("expected_campaign_caller_binding_missing");
  }
  if (
    campaignPublicRouteCount !== 0
    || campaignWorkersDevEnabledCount !== 0
    || campaignPreviewUrlEnabledCount !== 0
    || campaignUnexpectedCallerBindingCount !== 0
  ) fail("campaign_private_rpc_boundary_not_proven");
  return {
    campaignServiceNames,
    campaignPrivateRpcOnly: true,
    campaignPublicRouteCount,
    campaignWorkersDevEnabledCount,
    campaignPreviewUrlEnabledCount,
    campaignUnexpectedCallerBindingCount,
  };
}

function normalizeServices(input) {
  if (!Array.isArray(input) || input.length === 0) {
    fail("account_service_inventory_empty");
  }
  const values = input.map((entry) => {
    const value = record(entry, "account service");
    exactKeys(value, [
      "serviceName", "activeVersionIds", "workersDev", "previewUrls",
      "deploymentSetSha256", "versionBindingSetSha256",
    ], "account service");
    serviceName(value.serviceName, "account service name");
    if (!Array.isArray(value.activeVersionIds)) {
      fail("account_service_active_versions_invalid");
    }
    const activeVersionIds = [...value.activeVersionIds];
    for (const version of activeVersionIds) safeToken(version, "active version ID");
    activeVersionIds.sort(compareAscii);
    rejectDuplicates(activeVersionIds, (item) => item, "active version");
    boolean(value.workersDev, "workers.dev status");
    boolean(value.previewUrls, "preview URL status");
    sha256(value.deploymentSetSha256, "deployment set");
    sha256(value.versionBindingSetSha256, "version binding set");
    return {
      serviceName: value.serviceName,
      activeVersionIds,
      workersDev: value.workersDev,
      previewUrls: value.previewUrls,
      deploymentSetSha256: value.deploymentSetSha256,
      versionBindingSetSha256: value.versionBindingSetSha256,
    };
  }).sort((left, right) => compareAscii(left.serviceName, right.serviceName));
  rejectDuplicates(values, (item) => item.serviceName, "account service");
  return values;
}

function normalizeZoneIdentities(input) {
  if (!Array.isArray(input) || input.length === 0) {
    fail("account_zone_inventory_empty");
  }
  const values = [...input];
  for (const value of values) sha256(value, "account zone identity");
  values.sort(compareAscii);
  rejectDuplicates(values, (value) => value, "account zone identity");
  return values;
}

function normalizeRoutes(input, services, serviceNames, zoneIdentities) {
  if (!Array.isArray(input)) fail("account_route_inventory_invalid");
  const values = input.map((entry) =>
    normalizeRoute(entry, serviceNames, zoneIdentities));
  for (const service of services) {
    const workersDevPresent = values.some(
      (route) => route.kind === "workers-dev"
        && route.serviceName === service.serviceName,
    );
    const previewPresent = values.some(
      (route) => route.kind === "preview-url"
        && route.serviceName === service.serviceName,
    );
    if (workersDevPresent !== service.workersDev) {
      if (workersDevPresent) fail("workers_dev_route_status_mismatch");
      values.push({ kind: "workers-dev", serviceName: service.serviceName });
    }
    if (previewPresent !== service.previewUrls) {
      if (previewPresent) fail("preview_url_route_status_mismatch");
      values.push({ kind: "preview-url", serviceName: service.serviceName });
    }
  }
  values.sort((left, right) => compareAscii(routeKey(left), routeKey(right)));
  rejectDuplicates(values, routeKey, "account route");
  return values;
}

function normalizeRoute(input, serviceNames, zoneIdentities) {
  const value = record(input, "account route");
  if (value.kind === "zone-route") {
    exactKeys(value, [
      "kind", "zoneIdSha256", "pattern", "serviceName",
    ], "zone route");
    sha256(value.zoneIdSha256, "zone route zone ID");
    if (!zoneIdentities.has(value.zoneIdSha256)) {
      fail("zone_route_zone_not_in_account_inventory");
    }
    visibleString(value.pattern, 1, 2_048, "zone route pattern");
    nullableServiceName(value.serviceName, "zone route service name");
    if (value.serviceName !== null && !serviceNames.has(value.serviceName)) {
      fail("zone_route_service_not_in_account_inventory");
    }
    return cloneJson(value);
  }
  if (value.kind === "custom-domain") {
    exactKeys(value, [
      "kind", "zoneIdSha256", "hostname", "serviceName", "environment",
    ], "custom domain route");
    sha256(value.zoneIdSha256, "custom domain zone ID");
    if (!zoneIdentities.has(value.zoneIdSha256)) {
      fail("custom_domain_zone_not_in_account_inventory");
    }
    if (typeof value.hostname !== "string" || !HOSTNAME.test(value.hostname)) {
      fail("invalid_custom_domain_hostname");
    }
    serviceName(value.serviceName, "custom domain service name");
    if (!serviceNames.has(value.serviceName)) {
      fail("custom_domain_service_not_in_account_inventory");
    }
    nullableSafeToken(value.environment, "custom domain environment");
    return cloneJson(value);
  }
  if (value.kind === "workers-dev" || value.kind === "preview-url") {
    exactKeys(value, ["kind", "serviceName"], "synthetic public route");
    serviceName(value.serviceName, "synthetic public route service name");
    if (!serviceNames.has(value.serviceName)) {
      fail("synthetic_public_route_service_not_in_account_inventory");
    }
    return cloneJson(value);
  }
  fail("unsupported_account_route_kind");
}

function normalizeVersionedBindingEdges(input, serviceMap) {
  if (!Array.isArray(input)) fail("account_binding_edge_inventory_invalid");
  const values = input.map((entry) => {
    const value = record(entry, "account service binding edge");
    exactKeys(value, [
      "bindingType", "callerServiceName", "callerVersionId", "bindingName",
      "targetServiceName", "targetEnvironment", "targetEntrypoint",
    ], "account service binding edge");
    oneOf(
      value.bindingType,
      ["service", "durable-object", "dispatch-outbound", "workflow"],
      "binding edge type",
    );
    serviceName(value.callerServiceName, "binding caller service");
    const callerService = serviceMap.get(value.callerServiceName);
    if (callerService === undefined) {
      fail("binding_caller_not_in_account_inventory");
    }
    safeToken(value.callerVersionId, "binding caller version");
    if (!callerService.activeVersionIds.includes(value.callerVersionId)) {
      fail("binding_caller_version_not_active");
    }
    bindingName(value.bindingName);
    serviceName(value.targetServiceName, "binding target service");
    if (!serviceMap.has(value.targetServiceName)) {
      fail("binding_target_not_in_account_inventory");
    }
    nullableSafeToken(value.targetEnvironment, "binding target environment");
    nullableSafeToken(value.targetEntrypoint, "binding target entrypoint");
    return cloneJson(value);
  }).sort((left, right) => compareAscii(versionedEdgeKey(left), versionedEdgeKey(right)));
  rejectDuplicates(values, versionedEdgeKey, "account service binding edge");
  return values;
}

function normalizeLogicalBindingEdges(input, label, deduplicate = false) {
  if (!Array.isArray(input)) fail("logical_binding_edge_set_invalid");
  const values = input.map((entry) => {
    const value = record(entry, label);
    exactKeys(value, [
      "bindingType", "callerServiceName", "bindingName", "targetServiceName",
      "targetEnvironment", "targetEntrypoint",
    ], label);
    oneOf(
      value.bindingType,
      ["service", "durable-object", "dispatch-outbound", "workflow"],
      `${label} type`,
    );
    serviceName(value.callerServiceName, `${label} caller service`);
    bindingName(value.bindingName);
    serviceName(value.targetServiceName, `${label} target service`);
    nullableSafeToken(value.targetEnvironment, `${label} target environment`);
    nullableSafeToken(value.targetEntrypoint, `${label} target entrypoint`);
    return cloneJson(value);
  }).sort((left, right) => compareAscii(logicalEdgeKey(left), logicalEdgeKey(right)));
  if (deduplicate) {
    return values.filter(
      (value, index) => index === 0 || logicalEdgeKey(value) !== logicalEdgeKey(values[index - 1]),
    );
  }
  rejectDuplicates(values, logicalEdgeKey, label);
  return values;
}

function validatePageChain({
  input,
  snapshotObservedAt,
  accountIdSha256,
  services,
  zoneIdSha256s,
  routes,
}) {
  if (!Array.isArray(input) || input.length === 0) {
    fail("account_binding_page_chain_empty");
  }
  const pages = input.map(
    validateJsonCompatibilityAccountBindingPageReceipt,
  );
  const families = new Set();
  const requestIds = new Set();
  const familyOrder = new Map([
    ["credential-verification", 0],
    ["workers-scripts", 1],
    ["worker-deployments", 2],
    ["worker-version", 3],
    ["worker-subdomain", 4],
    ["account-worker-domains", 5],
    ["account-zones", 6],
    ["zone-worker-routes", 7],
  ]);
  let previousFamilyOrder = -1;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    equal(page.sequence, index + 1, "page receipt sequence");
    equal(
      page.predecessorSha256,
      index === 0 ? null : pages[index - 1].pageReceiptSha256,
      "page receipt predecessor",
    );
    if (page.observedAt > snapshotObservedAt) {
      fail("page_observed_after_snapshot");
    }
    if (!requestIds.add(page.requestIdSha256)) {
      fail("account_binding_request_id_duplicate");
    }
    const currentFamilyOrder = familyOrder.get(page.resourceFamily);
    if (currentFamilyOrder < previousFamilyOrder) {
      fail("account_binding_request_schedule_order_invalid");
    }
    previousFamilyOrder = currentFamilyOrder;
    families.add(page.resourceFamily);
  }
  for (const family of JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES) {
    if (!families.has(family)) fail("account_binding_resource_family_missing");
  }
  const accountIdentity = sha256Canonical({ accountIdSha256 });
  const expected = new Map([
    ["credential-verification", [accountIdentity]],
    ["workers-scripts", [accountIdentity]],
    ["worker-deployments", services.map((service) =>
      sha256Canonical({ serviceName: service.serviceName }))],
    ["worker-version", services.flatMap((service) =>
      service.activeVersionIds.map((versionId) => sha256Canonical({
        serviceName: service.serviceName,
        versionId,
      })))],
    ["worker-subdomain", services.map((service) =>
      sha256Canonical({ serviceName: service.serviceName }))],
    ["account-worker-domains", [accountIdentity]],
    ["zone-worker-routes", zoneIdSha256s.map((zoneIdSha256) =>
      sha256Canonical({ zoneIdSha256 }))],
  ]);
  for (const [family, expectedIdentities] of expected) {
    const actualIdentities = pages
      .filter((page) => page.resourceFamily === family)
      .map((page) => page.resourceIdentitySha256)
      .sort(compareAscii);
    const normalizedExpected = [...expectedIdentities].sort(compareAscii);
    if (canonicalJson(actualIdentities) !== canonicalJson(normalizedExpected)) {
      fail("account_binding_request_schedule_incomplete");
    }
  }
  const pageFor = (family, identity) => pages.find(
    (page) => page.resourceFamily === family
      && page.resourceIdentitySha256 === identity,
  );
  if (
    pageFor("credential-verification", accountIdentity).resultCount !== 1
    || pageFor("workers-scripts", accountIdentity).resultCount
      !== services.length
  ) fail("account_binding_page_result_count_mismatch");
  for (const service of services) {
    const serviceIdentity = sha256Canonical({
      serviceName: service.serviceName,
    });
    if (
      pageFor("worker-subdomain", serviceIdentity).resultCount !== 1
      || (
        service.activeVersionIds.length > 0
        && pageFor("worker-deployments", serviceIdentity).resultCount === 0
      )
    ) fail("account_binding_page_result_count_mismatch");
    for (const versionId of service.activeVersionIds) {
      if (pageFor("worker-version", sha256Canonical({
        serviceName: service.serviceName,
        versionId,
      })).resultCount !== 1) {
        fail("account_binding_page_result_count_mismatch");
      }
    }
  }
  const customDomainCount = routes.filter(
    (route) => route.kind === "custom-domain",
  ).length;
  if (
    pageFor("account-worker-domains", accountIdentity).resultCount
      !== customDomainCount
  ) fail("account_binding_page_result_count_mismatch");
  for (const zoneIdSha256 of zoneIdSha256s) {
    const zoneRouteCount = routes.filter(
      (route) => route.kind === "zone-route"
        && route.zoneIdSha256 === zoneIdSha256,
    ).length;
    if (pageFor(
      "zone-worker-routes",
      sha256Canonical({ zoneIdSha256 }),
    ).resultCount !== zoneRouteCount) {
      fail("account_binding_page_result_count_mismatch");
    }
  }
  const zonePages = pages.filter(
    (page) => page.resourceFamily === "account-zones",
  );
  const totalZonePages = zonePages[0].totalPages;
  if (
    totalZonePages === null || zonePages.length !== totalZonePages
    || zonePages.some((page, index) =>
      page.resourceIdentitySha256 !== accountIdentity
      || page.pageNumber !== index + 1
      || page.totalPages !== totalZonePages)
    || zonePages.reduce((sum, page) => sum + page.resultCount, 0)
      !== zoneIdSha256s.length
  ) fail("account_zone_pagination_chain_incomplete");
  for (const page of pages) {
    if (
      page.resourceFamily !== "account-zones"
      && page.resourceFamily !== "account-worker-domains"
      && (page.pageNumber !== null || page.totalPages !== null)
    ) fail("unexpected_resource_pagination_metadata");
    if (
      page.resourceFamily === "account-worker-domains"
      && page.pageNumber !== null
      && (page.pageNumber !== 1 || page.totalPages !== 1)
    ) fail("account_domain_pagination_chain_incomplete");
  }
  return pages;
}

function validateCurrentPlanPair(campaignInput, stateInput) {
  const campaignPlan = validateJsonCompatibilityCampaignPlan(campaignInput);
  const statePlan = validateJsonCompatibilityDeploymentStatePlan(stateInput);
  equal(
    campaignPlan.schemaVersion,
    CAMPAIGN_PLAN_SCHEMA_VERSION,
    "account binding campaign plan schema",
  );
  equal(
    statePlan.schemaVersion,
    STATE_PLAN_SCHEMA_VERSION,
    "account binding state plan schema",
  );
  equal(
    campaignPlan.deploymentStateBinding.planDigestSha256,
    statePlan.planDigestSha256,
    "account binding deployment-state plan",
  );
  return { campaignPlan, statePlan };
}

function routeKey(route) {
  if (route.kind === "zone-route") {
    return `zone-route\0${route.zoneIdSha256}\0${route.pattern}\0${route.serviceName ?? ""}`;
  }
  if (route.kind === "custom-domain") {
    return `custom-domain\0${route.zoneIdSha256}\0${route.hostname}\0${route.serviceName}\0${route.environment ?? ""}`;
  }
  return `${route.kind}\0${route.serviceName}`;
}

function logicalEdgeKey(edge) {
  return [
    edge.bindingType,
    edge.callerServiceName,
    edge.bindingName,
    edge.targetServiceName,
    edge.targetEnvironment ?? "",
    edge.targetEntrypoint ?? "",
  ].join("\0");
}

function versionedEdgeKey(edge) {
  return `${edge.callerServiceName}\0${edge.callerVersionId}\0${logicalEdgeKey(edge)}`;
}

function rejectDuplicates(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (!seen.add(identity)) fail(`${label.replaceAll(" ", "_")}_duplicate`);
  }
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...keys].sort(compareAscii);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label.replaceAll(" ", "_")}_shape_invalid`);
  }
}

function record(value, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label.replaceAll(" ", "_")}_mismatch`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function serviceName(value, label) {
  if (typeof value !== "string" || !SERVICE_NAME.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function nullableServiceName(value, label) {
  if (value !== null) serviceName(value, label);
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function nullableSafeToken(value, label) {
  if (value !== null) safeToken(value, label);
  return value;
}

function bindingName(value) {
  if (typeof value !== "string" || !BINDING_NAME.test(value)) {
    fail("binding_name_invalid");
  }
  return value;
}

function visibleString(value, minimum, maximum, label) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum
    || /[^\x20-\x7e]/.test(value)
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  integer(value, label);
  if (value === 0) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function nonnegativeInteger(value, label) {
  return integer(value, label);
}

function nullablePositiveInteger(value, label) {
  if (value !== null) positiveInteger(value, label);
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label.replaceAll(" ", "_")}_mismatch`);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingEvidenceError(code);
}
