import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  canonicalJson,
  sha256Canonical,
} from "../container_runtime_json_compatibility_campaign.mjs";
import {
  buildJsonCompatibilitySourceAccountBindingInventory,
} from "../container_runtime_json_compatibility_source_authentication.mjs";
import {
  accountBindingInventoryInputFromEvidence,
  buildJsonCompatibilityAccountBindingAuthenticationIdentity,
  buildJsonCompatibilityAccountBindingCollectionArtifact,
  buildJsonCompatibilityAccountBindingEvidence,
  buildJsonCompatibilityAccountBindingPageReceipt,
  buildJsonCompatibilityAccountBindingSnapshot,
  validateJsonCompatibilityAccountBindingCollectionArtifact,
  validateJsonCompatibilityAccountBindingCollectionProfile,
  validateJsonCompatibilityAccountBindingCollectorIdentity,
} from "../container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  verifyJsonCompatibilityAccountBindingCredentialProvenance,
} from "./container_runtime_json_compatibility_account_binding_credentials.mjs";

const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const PAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const AGGREGATE_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const COLLECTION_TIMEOUT_MS = 5 * 60_000;
const MAX_SERVICES = 2_000;
const MAX_ZONES = 5_000;
const MAX_PAGES = 1_024;
const ZONE_PAGE_SIZE = 50;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NON_CROSS_SCRIPT_BINDING_TYPES = new Set([
  "ai",
  "ai_search",
  "ai_search_namespace",
  "agent_memory",
  "analytics_engine",
  "artifacts",
  "assets",
  "browser",
  "data_blob",
  "d1",
  "hyperdrive",
  "images",
  "json",
  "kv_namespace",
  "logfwdr",
  "mtls_certificate",
  "media",
  "pipeline",
  "plain_text",
  "queue",
  "r2_bucket",
  "ratelimit",
  "secret_store",
  "secret_text",
  "secrets_store_secret",
  "send_email",
  "stream",
  "text_blob",
  "unsafe_hello_world",
  "vectorize",
  "version_metadata",
  "vpc_network",
  "vpc_service",
  "wasm_module",
  "websearch",
]);

export class JsonCompatibilityAccountBindingCollectorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityAccountBindingCollectorError";
    this.code = code;
  }
}

export async function collectJsonCompatibilityAccountBindingArtifact({
  campaignPlan,
  statePlan,
  collectionProfile: profileInput,
  collectorIdentity: collectorIdentityInput,
  mode,
  accountId,
  apiToken,
  expectedTrustPolicySha256,
  expectedRevocationStateSha256,
  minimumRevocationSequence,
  rawPageSink,
  fetchImpl = globalThis.fetch,
  clock = () => Math.floor(Date.now() / 1000),
  monotonicClock = () => globalThis.performance.now(),
}) {
  oneOf(mode, ["collection", "independent-readback"], "collection mode");
  token(accountId, ACCOUNT_ID, "Cloudflare account ID");
  secret(apiToken);
  if (
    typeof rawPageSink !== "function" || typeof fetchImpl !== "function"
    || typeof clock !== "function" || typeof monotonicClock !== "function"
  ) fail("collector_dependency_invalid");
  const profile = validateJsonCompatibilityAccountBindingCollectionProfile(
    campaignPlan,
    statePlan,
    profileInput,
  );
  const collectorIdentity =
    validateJsonCompatibilityAccountBindingCollectorIdentity(
      collectorIdentityInput,
    );
  const credentialProvenanceVerifiedAt = integer(
    clock(),
    "credential provenance verification time",
  );
  const credentialProvenance =
    verifyJsonCompatibilityAccountBindingCredentialProvenance(
      profile.credentialProvenance,
      {
        now: credentialProvenanceVerifiedAt,
        expectedTrustPolicySha256,
        expectedRevocationStateSha256,
        minimumRevocationSequence,
      },
    );
  const credentialReceipt = mode === "collection"
    ? credentialProvenance.collectionReceipt.subject
    : credentialProvenance.readbackReceipt.subject;
  const accountIdSha256 = sha256Text(accountId);
  const accountResourceIdentitySha256 = sha256Canonical({ accountIdSha256 });
  equal(accountIdSha256, profile.accountIdSha256, "collector account identity");
  equal(
    collectorIdentity.collectorIdentitySha256,
    profile.collectorIdentitySha256,
    "collector build identity",
  );

  const started = monotonicClock();
  if (!Number.isFinite(started)) fail("collector_monotonic_clock_invalid");
  const state = {
    accountId,
    apiToken,
    rawPageSink,
    fetchImpl,
    clock,
    monotonicClock,
    deadline: started + COLLECTION_TIMEOUT_MS,
    aggregateBytes: 0,
    receipts: [],
    accountResourceIdentitySha256,
    credentialRepresentations: credentialRepresentations(apiToken),
  };

  const credentialVerification = await apiGet(state, {
      family: "credential-verification",
      url: accountUrl(accountId, "tokens", "verify"),
      pagination: "none",
      resourceIdentitySha256: accountResourceIdentitySha256,
    });
  const verified = normalizeTokenVerification(credentialVerification.result);
  const credentialIdSha256 = sha256Text(verified.id);
  equal(
    credentialIdSha256,
    credentialReceipt.credentialIdSha256,
    "verified credential receipt identity",
  );
  const permissionSetSha256 = mode === "collection"
    ? profile.collectionPermissionSetSha256
    : profile.readbackPermissionSetSha256;
  const verifiedAt = integer(clock(), "credential verification time");
  const authenticationIdentity =
    buildJsonCompatibilityAccountBindingAuthenticationIdentity({
      accountIdSha256,
      credentialIdSha256,
      permissionSetSha256,
      credentialVerificationPageReceiptSha256:
        credentialVerification.receipt.pageReceiptSha256,
      credentialVerificationResponseBodySha256:
        credentialVerification.receipt.responseBodySha256,
      credentialReceiptSha256: mode === "collection"
        ? profile.collectionCredentialReceiptSha256
        : profile.readbackCredentialReceiptSha256,
      custodianIdentitySha256: mode === "collection"
        ? profile.collectionCustodianIdentitySha256
        : profile.readbackCustodianIdentitySha256,
      credentialTrustPolicySha256: profile.credentialTrustPolicySha256,
      credentialRevocationStateSha256:
        profile.credentialRevocationStateSha256,
      credentialProvenanceSha256: profile.credentialProvenanceSha256,
      verifiedAt,
    });

  const scriptResponse = await apiGet(state, {
    family: "workers-scripts",
    url: accountUrl(accountId, "workers", "scripts"),
    pagination: "none",
    resourceIdentitySha256: accountResourceIdentitySha256,
  });
  const serviceNames = normalizeScriptList(scriptResponse.result);
  const serviceRecords = [];
  const bindingEdges = [];
  const deploymentsByService = new Map();
  for (const serviceName of serviceNames) {
    const deployments = normalizeDeployments(
      (await apiGet(state, {
        family: "worker-deployments",
        url: accountUrl(
          accountId,
          "workers",
          "scripts",
          serviceName,
          "deployments",
        ),
        pagination: "none",
        resourceIdentitySha256: serviceResourceIdentity(serviceName),
      })).result,
      serviceName,
    );
    deploymentsByService.set(serviceName, deployments);
  }
  const bindingEdgesByService = new Map();
  for (const serviceName of serviceNames) {
    const deployments = deploymentsByService.get(serviceName);
    const serviceEdges = [];
    for (const versionId of deployments.activeVersionIds) {
      const version = normalizeVersionDetail(
        (await apiGet(state, {
          family: "worker-version",
          url: accountUrl(
            accountId,
            "workers",
            "scripts",
            serviceName,
            "versions",
            versionId,
          ),
          pagination: "none",
          resourceIdentitySha256: versionResourceIdentity(
            serviceName,
            versionId,
          ),
        })).result,
        serviceName,
        versionId,
      );
      serviceEdges.push(...version.serviceBindingEdges);
    }
    bindingEdgesByService.set(serviceName, serviceEdges);
    bindingEdges.push(...serviceEdges);
  }
  for (const serviceName of serviceNames) {
    const deployments = deploymentsByService.get(serviceName);
    const serviceEdges = bindingEdgesByService.get(serviceName);
    const subdomain = normalizeSubdomain(
      (await apiGet(state, {
        family: "worker-subdomain",
        url: accountUrl(
          accountId,
          "workers",
          "scripts",
          serviceName,
          "subdomain",
        ),
        pagination: "none",
        resourceIdentitySha256: serviceResourceIdentity(serviceName),
      })).result,
    );
    serviceRecords.push({
      serviceName,
      activeVersionIds: deployments.activeVersionIds,
      workersDev: subdomain.enabled,
      previewUrls: subdomain.previewsEnabled,
      deploymentSetSha256: deployments.deploymentSetSha256,
      versionBindingSetSha256: sha256Canonical(serviceEdges),
    });
  }

  const domainsResponse = await apiGet(state, {
    family: "account-worker-domains",
    url: accountUrl(accountId, "workers", "domains"),
    pagination: "optional-single",
    resourceIdentitySha256: accountResourceIdentitySha256,
  });
  const routes = normalizeCustomDomains(domainsResponse.result);
  const zones = await collectZones(state);
  for (const zone of zones) {
    const zoneRoutes = normalizeZoneRoutes(
      (await apiGet(state, {
        family: "zone-worker-routes",
        url: zoneUrl(zone.id, "workers", "routes"),
        pagination: "none",
        resourceIdentitySha256: zoneResourceIdentity(zone.id),
      })).result,
      zone.id,
    );
    routes.push(...zoneRoutes);
  }

  const observedAt = integer(clock(), "account inventory observation time");
  const snapshot = buildJsonCompatibilityAccountBindingSnapshot({
    accountIdSha256,
    services: serviceRecords,
    zoneIdSha256s: zones.map((zone) => sha256Text(zone.id)),
    routes,
    serviceBindingEdges: bindingEdges,
    pageReceipts: state.receipts,
    observedAt,
  });
  return buildJsonCompatibilityAccountBindingCollectionArtifact({
    campaignPlan,
    statePlan,
    collectionProfile: profile,
    mode,
    collectorIdentity,
    authenticationIdentity,
    snapshot,
  });
}

export function finalizeJsonCompatibilityAccountBindingEvidence({
  campaignPlan,
  statePlan,
  collectionProfile,
  collection: collectionInput,
  independentReadback: readbackInput,
}) {
  const collection =
    validateJsonCompatibilityAccountBindingCollectionArtifact(
      campaignPlan,
      statePlan,
      collectionProfile,
      collectionInput,
    );
  const independentReadback =
    validateJsonCompatibilityAccountBindingCollectionArtifact(
      campaignPlan,
      statePlan,
      collectionProfile,
      readbackInput,
    );
  const evidence = buildJsonCompatibilityAccountBindingEvidence({
    campaignPlan,
    statePlan,
    collectionProfile,
    collection,
    independentReadback,
  });
  const inventory = buildJsonCompatibilitySourceAccountBindingInventory({
    campaignPlan,
    statePlan,
    ...accountBindingInventoryInputFromEvidence(evidence),
  });
  return { evidence, inventory };
}

export function normalizeTokenVerification(input) {
  const value = object(input, "token verification");
  const id = token(value.id, SAFE_TOKEN, "verified token ID");
  equal(value.status, "active", "verified token status");
  return { id, status: "active" };
}

export function normalizeScriptList(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SERVICES) {
    fail("worker_script_inventory_invalid");
  }
  const names = input.map((entry) => {
    const value = object(entry, "Worker script");
    return token(value.id, SERVICE_NAME, "Worker script name");
  }).sort(compareAscii);
  rejectDuplicates(names, (value) => value, "Worker script");
  return names;
}

export function normalizeDeployments(input, serviceName) {
  token(serviceName, SERVICE_NAME, "deployment service name");
  const value = object(input, "Worker deployments");
  if (!Array.isArray(value.deployments)) fail("worker_deployment_set_invalid");
  if (value.deployments.length === 0) {
    const empty = { serviceName, activeDeploymentId: null, strategy: null,
      activeVersions: [] };
    return {
      activeVersionIds: [],
      deploymentSetSha256: sha256Canonical(empty),
    };
  }
  const deployment = object(value.deployments[0], "active Worker deployment");
  const activeDeploymentId = token(
    deployment.id,
    SAFE_TOKEN,
    "active deployment ID",
  );
  equal(deployment.strategy, "percentage", "active deployment strategy");
  if (
    !Array.isArray(deployment.versions) || deployment.versions.length < 1
    || deployment.versions.length > 2
  ) fail("active_deployment_version_set_invalid");
  const activeVersions = deployment.versions.map((entry) => {
    const version = object(entry, "active deployment version");
    const versionId = token(
      version.version_id,
      SAFE_TOKEN,
      "active Worker version ID",
    );
    if (
      !Number.isSafeInteger(version.percentage) || version.percentage <= 0
      || version.percentage > 100
    ) fail("active_version_percentage_invalid");
    return { versionId, percentage: version.percentage };
  }).sort((left, right) => compareAscii(left.versionId, right.versionId));
  rejectDuplicates(activeVersions, (entry) => entry.versionId, "active version");
  if (activeVersions.reduce((sum, entry) => sum + entry.percentage, 0) !== 100) {
    fail("active_version_percentage_total_invalid");
  }
  const normalized = {
    serviceName,
    activeDeploymentId,
    strategy: "percentage",
    activeVersions,
  };
  return {
    activeVersionIds: activeVersions.map((entry) => entry.versionId),
    deploymentSetSha256: sha256Canonical(normalized),
  };
}

export function normalizeVersionDetail(input, serviceName, versionId) {
  token(serviceName, SERVICE_NAME, "Worker version service name");
  token(versionId, SAFE_TOKEN, "Worker version ID");
  const value = object(input, "Worker version detail");
  equal(value.id, versionId, "Worker version detail ID");
  const resources = object(value.resources, "Worker version resources");
  const bindings = resources.bindings ?? [];
  if (!Array.isArray(bindings)) fail("Worker_version_binding_set_invalid");
  const serviceBindingEdges = [];
  for (const entry of bindings) {
    const binding = object(entry, "Worker version binding");
    if (binding.type === "inherit") fail("inherited_binding_not_resolved");
    if (typeof binding.type !== "string") fail("Worker_version_binding_type_invalid");
    const name = token(binding.name, BINDING_NAME, "service binding name");
    const target = normalizeCrossScriptBinding(binding);
    if (target === null) continue;
    serviceBindingEdges.push({
      bindingType: target.bindingType,
      callerServiceName: serviceName,
      callerVersionId: versionId,
      bindingName: name,
      targetServiceName: target.targetServiceName,
      targetEnvironment: target.targetEnvironment,
      targetEntrypoint: target.targetEntrypoint,
    });
  }
  serviceBindingEdges.sort((left, right) =>
    compareAscii(canonicalJson(left), canonicalJson(right)));
  rejectDuplicates(
    serviceBindingEdges,
    (entry) => canonicalJson(entry),
    "service binding edge",
  );
  return { serviceBindingEdges };
}

function normalizeCrossScriptBinding(binding) {
  if (binding.type === "service") {
    return crossScriptTarget({
      bindingType: "service",
      service: binding.service,
      environment: binding.environment,
      entrypoint: binding.entrypoint,
      label: "service binding",
    });
  }
  if (binding.type === "durable_object_namespace") {
    if (binding.script_name === undefined && binding.service === undefined) {
      return null;
    }
    return crossScriptTarget({
      bindingType: "durable-object",
      service: binding.script_name ?? binding.service,
      environment: binding.environment,
      entrypoint: binding.class_name,
      label: "Durable Object binding",
    });
  }
  if (binding.type === "dispatch_namespace") {
    if (binding.outbound === undefined || binding.outbound === null) return null;
    const outbound = object(binding.outbound, "dispatch namespace outbound");
    const worker = object(outbound.worker, "dispatch namespace outbound Worker");
    return crossScriptTarget({
      bindingType: "dispatch-outbound",
      service: worker.service,
      environment: worker.environment,
      entrypoint: worker.entrypoint,
      label: "dispatch namespace outbound Worker",
    });
  }
  if (binding.type === "workflow") {
    if (binding.script_name === undefined) return null;
    return crossScriptTarget({
      bindingType: "workflow",
      service: binding.script_name,
      environment: binding.environment,
      entrypoint: binding.class_name,
      label: "workflow binding",
    });
  }
  if (NON_CROSS_SCRIPT_BINDING_TYPES.has(binding.type)) return null;
  fail("unknown_binding_type_not_proven_non_cross_script");
}

function crossScriptTarget({
  bindingType,
  service,
  environment,
  entrypoint,
  label,
}) {
  return {
    bindingType,
    targetServiceName: token(service, SERVICE_NAME, `${label} target`),
    targetEnvironment: optionalToken(
      environment,
      SAFE_TOKEN,
      `${label} environment`,
    ),
    targetEntrypoint: optionalToken(
      entrypoint,
      SAFE_TOKEN,
      `${label} entrypoint`,
    ),
  };
}

export function normalizeSubdomain(input) {
  const value = object(input, "Worker subdomain");
  if (
    typeof value.enabled !== "boolean"
    || typeof value.previews_enabled !== "boolean"
  ) fail("worker_subdomain_status_invalid");
  return {
    enabled: value.enabled,
    previewsEnabled: value.previews_enabled,
  };
}

export function normalizeCustomDomains(input) {
  if (!Array.isArray(input)) fail("custom_domain_inventory_invalid");
  return input.map((entry) => {
    const value = object(entry, "custom domain");
    token(value.id, SAFE_TOKEN, "custom domain ID");
    const zoneId = token(value.zone_id, SAFE_TOKEN, "custom domain zone ID");
    return {
      kind: "custom-domain",
      zoneIdSha256: sha256Text(zoneId),
      hostname: hostname(value.hostname),
      serviceName: token(value.service, SERVICE_NAME, "custom domain service"),
      environment: optionalToken(
        value.environment,
        SAFE_TOKEN,
        "custom domain environment",
      ),
    };
  });
}

export function normalizeZoneRoutes(input, zoneId) {
  if (!Array.isArray(input)) fail("zone_route_inventory_invalid");
  return input.map((entry) => {
    const value = object(entry, "zone Worker route");
    token(value.id, SAFE_TOKEN, "zone Worker route ID");
    return {
      kind: "zone-route",
      zoneIdSha256: sha256Text(zoneId),
      pattern: visibleString(value.pattern, 1, 2_048, "zone route pattern"),
      serviceName: value.script === undefined || value.script === null
        ? null
        : token(value.script, SERVICE_NAME, "zone route service"),
    };
  });
}

async function collectZones(state) {
  const zones = [];
  const seen = new Set();
  let totalPages = null;
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${API_ORIGIN}${API_PREFIX}/zones`);
    url.searchParams.set("account.id", state.accountId);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(ZONE_PAGE_SIZE));
    url.searchParams.set("order", "name");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("match", "all");
    const response = await apiGet(state, {
      family: "account-zones",
      url: url.href,
      pagination: "numbered",
      requestedPage: page,
      resourceIdentitySha256: state.accountResourceIdentitySha256,
    });
    if (totalPages === null) {
      totalPages = response.page.totalPages;
      totalCount = response.page.totalCount;
      if (totalCount > MAX_ZONES) fail("zone_inventory_limit_exceeded");
    } else if (
      totalPages !== response.page.totalPages
      || totalCount !== response.page.totalCount
    ) fail("zone_pagination_snapshot_drift");
    for (const entry of response.result) {
      const value = object(entry, "Cloudflare zone");
      const id = token(value.id, SAFE_TOKEN, "Cloudflare zone ID");
      const account = object(value.account, "Cloudflare zone account");
      equal(account.id, state.accountId, "Cloudflare zone account ID");
      if (!seen.add(id)) fail("Cloudflare_zone_duplicate");
      zones.push({ id });
    }
    if (page === totalPages) {
      if (zones.length !== totalCount) fail("zone_pagination_total_mismatch");
      return zones.sort((left, right) => compareAscii(left.id, right.id));
    }
  }
  fail("zone_pagination_limit_exceeded");
}

async function apiGet(state, options) {
  token(
    options.resourceIdentitySha256,
    SHA256,
    "Cloudflare resource identity digest",
  );
  const url = assertAllowedUrl(state.accountId, options);
  const remaining = state.deadline - state.monotonicClock();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    fail("account_binding_collection_timeout");
  }
  const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
  let response;
  try {
    response = await state.fetchImpl(url.href, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${state.apiToken}`,
        "User-Agent": "cinatoken-json-compatibility-account-inventory/1",
      },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    fail("cloudflare_api_network_error");
  }
  if (
    !response || response.redirected === true || response.ok !== true
    || response.status !== 200
  ) {
    await cancelBody(response);
    fail("cloudflare_api_http_error");
  }
  if (
    typeof response.url === "string" && response.url.length > 0
    && response.url !== url.href
  ) {
    await cancelBody(response);
    fail("cloudflare_api_response_url_mismatch");
  }
  const contentType = response.headers?.get?.("content-type");
  if (
    typeof contentType !== "string"
    || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  ) {
    await cancelBody(response);
    fail("cloudflare_api_content_type_invalid");
  }
  const contentEncoding = response.headers?.get?.("content-encoding");
  if (
    contentEncoding !== null && contentEncoding !== undefined
    && contentEncoding.trim().toLowerCase() !== "identity"
  ) {
    await cancelBody(response);
    fail("cloudflare_api_content_encoding_invalid");
  }
  const bytes = await readBoundedBody(response);
  state.aggregateBytes += bytes.byteLength;
  if (state.aggregateBytes > AGGREGATE_RESPONSE_MAX_BYTES) {
    fail("cloudflare_api_aggregate_limit_exceeded");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("cloudflare_api_utf8_invalid");
  }
  if (state.credentialRepresentations.some((value) => text.includes(value))) {
    fail("cloudflare_api_credential_reflected");
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail("cloudflare_api_json_invalid");
  }
  assertBoundedJson(envelope);
  if (jsonContainsAny(envelope, state.credentialRepresentations)) {
    fail("cloudflare_api_credential_reflected");
  }
  const value = object(envelope, "Cloudflare API envelope");
  if (
    value.success !== true || !Array.isArray(value.errors)
    || value.errors.length !== 0 || !Array.isArray(value.messages)
    || !Object.hasOwn(value, "result")
  ) fail("cloudflare_api_envelope_failed");
  const resultCount = countResult(value.result);
  const page = validatePagination(
    options.pagination,
    options.requestedPage,
    value.result_info,
    resultCount,
  );
  const requestId = response.headers?.get?.("cf-ray");
  token(requestId, SAFE_TOKEN, "Cloudflare request ID");
  const observedAt = integer(state.clock(), "Cloudflare page observation time");
  const predecessorSha256 = state.receipts.length === 0
    ? null
    : state.receipts[state.receipts.length - 1].pageReceiptSha256;
  const receipt = buildJsonCompatibilityAccountBindingPageReceipt({
    sequence: state.receipts.length + 1,
    resourceFamily: options.family,
    resourceIdentitySha256: options.resourceIdentitySha256,
    requestPathSha256: sha256Text(`${url.pathname}${url.search}`),
    responseBodySha256: sha256Bytes(bytes),
    responseByteLength: bytes.byteLength,
    resultCount,
    pageNumber: page.pageNumber,
    totalPages: page.totalPages,
    requestIdSha256: sha256Text(requestId),
    predecessorSha256,
    observedAt,
  });
  await state.rawPageSink({
    sequence: receipt.sequence,
    resourceFamily: receipt.resourceFamily,
    requestPathSha256: receipt.requestPathSha256,
    responseBodySha256: receipt.responseBodySha256,
    body: bytes.slice(),
    receipt,
  });
  state.receipts.push(receipt);
  return { result: value.result, page, receipt };
}

function validatePagination(mode, requestedPage, input, resultCount) {
  if (mode === "none") {
    if (input !== undefined && input !== null) fail("unexpected_pagination_metadata");
    return { pageNumber: null, totalPages: null, totalCount: null };
  }
  if (mode === "optional-single") {
    if (input === undefined || input === null) {
      return { pageNumber: null, totalPages: null, totalCount: resultCount };
    }
    const info = paginationInfo(input);
    if (
      info.page !== 1 || info.totalPages !== 1
      || info.count !== resultCount || info.totalCount !== resultCount
    ) fail("single_response_pagination_incomplete");
    return {
      pageNumber: info.page,
      totalPages: info.totalPages,
      totalCount: info.totalCount,
    };
  }
  if (mode === "numbered") {
    const info = paginationInfo(input);
    if (
      info.page !== requestedPage || info.perPage !== ZONE_PAGE_SIZE
      || info.count !== resultCount
      || info.totalPages !== Math.max(1, Math.ceil(info.totalCount / info.perPage))
    ) fail("numbered_pagination_metadata_invalid");
    return {
      pageNumber: info.page,
      totalPages: info.totalPages,
      totalCount: info.totalCount,
    };
  }
  fail("pagination_mode_invalid");
}

function paginationInfo(input) {
  const value = object(input, "pagination result info");
  return {
    page: boundedInteger(value.page, 1, MAX_PAGES, "pagination page"),
    perPage: boundedInteger(
      value.per_page,
      1,
      ZONE_PAGE_SIZE,
      "pagination per page",
    ),
    count: boundedInteger(value.count, 0, MAX_SERVICES, "pagination count"),
    totalCount: boundedInteger(
      value.total_count,
      0,
      MAX_ZONES,
      "pagination total count",
    ),
    totalPages: boundedInteger(
      value.total_pages,
      1,
      MAX_PAGES,
      "pagination total pages",
    ),
  };
}

function assertAllowedUrl(accountId, { family, url }) {
  let value;
  try {
    value = new URL(url);
  } catch {
    fail("cloudflare_api_url_invalid");
  }
  if (
    value.origin !== API_ORIGIN || value.protocol !== "https:"
    || value.username !== "" || value.password !== "" || value.hash !== ""
  ) fail("cloudflare_api_origin_invalid");
  const accountBase = `${API_PREFIX}/accounts/${accountId}`;
  const patterns = {
    "credential-verification": new RegExp(`^${escapeRegex(accountBase)}/tokens/verify$`),
    "workers-scripts": new RegExp(`^${escapeRegex(accountBase)}/workers/scripts$`),
    "worker-deployments": new RegExp(`^${escapeRegex(accountBase)}/workers/scripts/[a-z0-9-]{1,128}/deployments$`),
    "worker-version": new RegExp(`^${escapeRegex(accountBase)}/workers/scripts/[a-z0-9-]{1,128}/versions/[A-Za-z0-9._:-]{1,128}$`),
    "worker-subdomain": new RegExp(`^${escapeRegex(accountBase)}/workers/scripts/[a-z0-9-]{1,128}/subdomain$`),
    "account-worker-domains": new RegExp(`^${escapeRegex(accountBase)}/workers/domains$`),
    "account-zones": new RegExp(`^${escapeRegex(API_PREFIX)}/zones$`),
    "zone-worker-routes": new RegExp(`^${escapeRegex(API_PREFIX)}/zones/[A-Za-z0-9._:-]{1,128}/workers/routes$`),
  };
  const pattern = patterns[family];
  if (!pattern || !pattern.test(value.pathname)) fail("cloudflare_api_path_not_allowlisted");
  if (family === "account-zones") {
    const expected = new Map([
      ["account.id", accountId],
      ["page", value.searchParams.get("page")],
      ["per_page", String(ZONE_PAGE_SIZE)],
      ["order", "name"],
      ["direction", "asc"],
      ["match", "all"],
    ]);
    if (value.searchParams.size !== expected.size) fail("zone_query_invalid");
    for (const [key, expectedValue] of expected) {
      if (expectedValue === null || value.searchParams.get(key) !== expectedValue) {
        fail("zone_query_invalid");
      }
    }
  } else if (value.search !== "") {
    fail("cloudflare_api_query_not_allowlisted");
  }
  return value;
}

async function readBoundedBody(response) {
  const contentLength = response.headers?.get?.("content-length");
  let declaredLength = null;
  if (
    contentLength !== null && contentLength !== undefined
    && (!/^(0|[1-9][0-9]*)$/.test(contentLength)
      || Number(contentLength) > PAGE_RESPONSE_MAX_BYTES)
  ) {
    await cancelBody(response);
    fail("cloudflare_api_response_size_invalid");
  }
  if (contentLength !== null && contentLength !== undefined) {
    declaredLength = Number(contentLength);
  }
  if (typeof response.body?.getReader !== "function") {
    fail("cloudflare_api_response_body_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("cloudflare_api_response_chunk_invalid");
      total += value.byteLength;
      if (total > PAGE_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        fail("cloudflare_api_response_size_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total === 0) fail("cloudflare_api_response_empty");
  if (declaredLength !== null && total !== declaredLength) {
    fail("cloudflare_api_content_length_mismatch");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already unusable.
  }
}

function countResult(result) {
  if (Array.isArray(result)) return result.length;
  if (result === null || typeof result !== "object") return 0;
  if (Array.isArray(result.deployments)) return result.deployments.length;
  return 1;
}

function accountUrl(accountId, ...segments) {
  return `${API_ORIGIN}${API_PREFIX}/accounts/${accountId}/${
    segments.map(encodeURIComponent).join("/")
  }`;
}

function serviceResourceIdentity(serviceName) {
  return sha256Canonical({ serviceName });
}

function versionResourceIdentity(serviceName, versionId) {
  return sha256Canonical({ serviceName, versionId });
}

function zoneResourceIdentity(zoneId) {
  return sha256Canonical({ zoneIdSha256: sha256Text(zoneId) });
}

function zoneUrl(zoneId, ...segments) {
  return `${API_ORIGIN}${API_PREFIX}/zones/${encodeURIComponent(zoneId)}/${
    segments.map(encodeURIComponent).join("/")
  }`;
}

function assertBoundedJson(root) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 100_000 || depth > 24) fail("cloudflare_api_json_shape_limit");
    if (typeof value === "string") {
      if (value.length > 64 * 1024 || value.includes("\0")) {
        fail("cloudflare_api_json_string_invalid");
      }
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.length > 1_024 || key.includes("\0")) {
          fail("cloudflare_api_json_key_invalid");
        }
        stack.push({ value: child, depth: depth + 1 });
      }
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      fail("cloudflare_api_json_number_invalid");
    }
  }
}

function jsonContainsAny(root, needles) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (needles.some((needle) => value.includes(needle))) return true;
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (needles.some((needle) => key.includes(needle))) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function credentialRepresentations(value) {
  const escaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([
    value,
    escaped,
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
  ].filter((entry) => entry.length >= 8))];
}

function object(value, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function secret(value) {
  if (
    typeof value !== "string" || value.length < 20 || value.length > 4_096
    || /\s/.test(value)
  ) fail("Cloudflare_api_token_invalid");
  return value;
}

function token(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function optionalToken(value, pattern, label) {
  if (value === undefined || value === null) return null;
  return token(value, pattern, label);
}

function hostname(value) {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 253
    || value !== value.toLowerCase()
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
  ) fail("custom_domain_hostname_invalid");
  return value;
}

function visibleString(value, minimum, maximum, label) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum
    || /[^\x20-\x7e]/.test(value)
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) fail(`${label.replaceAll(" ", "_")}_invalid`);
}

function equal(actual, expected, label) {
  if (actual !== expected) fail(`${label.replaceAll(" ", "_")}_mismatch`);
}

function rejectDuplicates(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    if (!seen.add(key(value))) fail(`${label.replaceAll(" ", "_")}_duplicate`);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingCollectorError(code);
}
