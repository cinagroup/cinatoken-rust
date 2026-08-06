import {
  canonicalJson,
  sha256Canonical,
} from "./shared_protocol_adapter.mjs";
import type { ExpectedReadback } from "./protocol";

const API_ORIGIN = "https://api.cloudflare.com";
const API_PREFIX = "/client/v4";
const TOTAL_DEADLINE_MILLISECONDS = 10_000;
const MAX_TOTAL_RESPONSE_BYTES = 64 * 1024;
const MAX_DEPLOYMENTS = 100;
const MAX_VERSION_BINDINGS = 512;
const MAX_ZONE_PAGES = 8;
const MAX_ZONES = 128;
const ZONE_PAGE_SIZE = 50;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VISIBLE_HEADER = /^[\x21-\x7e]{1,256}$/;

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface CloudflareReadbackDependencies {
  readonly fetch?: FetchLike;
  readonly nowMilliseconds?: () => number;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export interface CloudflareReadbackObservation {
  readonly workersDev: boolean;
  readonly previewUrls: boolean;
  readonly routeSetSha256: string;
  readonly readbackRequestIdSha256: string;
  readonly remoteEvidenceSha256: string;
  readonly authenticationEvidenceSha256: string;
  readonly observedAt: number;
}

export interface CloudflareReadbackInput {
  readonly accountId: string;
  readonly apiToken: string;
  readonly credentialIdSha256: string;
  readonly readbackRequestSha256: string;
  readonly expected: ExpectedReadback;
}

interface ResponseReceipt {
  readonly method: "GET";
  readonly endpointPath: string;
  readonly httpStatus: number;
  readonly responseBytes: number;
  readonly responseBodySha256: string;
  readonly responseRequestIdSha256: string;
}

interface BoundedJsonResult {
  readonly result: unknown;
  readonly resultInfo: unknown;
  readonly receipt: ResponseReceipt;
}

export class RemoteReadbackAmbiguity extends Error {
  readonly code: string;
  readonly endpointPath?: string;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly responseRequestIdSha256?: string;

  constructor(
    code: string,
    evidence: {
      readonly endpointPath?: string;
      readonly httpStatus?: number;
      readonly responseBytes?: number;
      readonly responseRequestIdSha256?: string;
    } = {},
  ) {
    super(code);
    this.name = "RemoteReadbackAmbiguity";
    this.code = code;
    this.endpointPath = evidence.endpointPath;
    this.httpStatus = evidence.httpStatus;
    this.responseBytes = evidence.responseBytes;
    this.responseRequestIdSha256 = evidence.responseRequestIdSha256;
  }
}

export async function readCloudflareDeploymentState(
  input: CloudflareReadbackInput,
  dependencies: CloudflareReadbackDependencies = {},
): Promise<CloudflareReadbackObservation> {
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const timeoutSignal = dependencies.timeoutSignal
    ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
  const deadlineAt = nowMilliseconds() + TOTAL_DEADLINE_MILLISECONDS;
  const budget = { remaining: MAX_TOTAL_RESPONSE_BYTES };
  const receipts: ResponseReceipt[] = [];

  const basePath = `${API_PREFIX}/accounts/${encodeURIComponent(input.accountId)}`
    + `/workers/scripts/${encodeURIComponent(input.expected.serviceName)}`;
  const deployments = await boundedGetJson(
    `${basePath}/deployments`,
    input.apiToken,
    fetchImpl,
    timeoutSignal,
    nowMilliseconds,
    deadlineAt,
    budget,
  );
  receipts.push(deployments.receipt);
  assertExactActiveDeployment(deployments.result, input.expected.versionId);

  const version = await boundedGetJson(
    `${basePath}/versions/${encodeURIComponent(input.expected.versionId)}`,
    input.apiToken,
    fetchImpl,
    timeoutSignal,
    nowMilliseconds,
    deadlineAt,
    budget,
  );
  receipts.push(version.receipt);
  assertExactVersion(version.result, input.expected.versionId);

  const subdomain = await boundedGetJson(
    `${basePath}/subdomain`,
    input.apiToken,
    fetchImpl,
    timeoutSignal,
    nowMilliseconds,
    deadlineAt,
    budget,
  );
  receipts.push(subdomain.receipt);
  const subdomainState = normalizeSubdomain(subdomain.result);
  const routeSetSha256 = await collectRouteSetSha256(
    input,
    fetchImpl,
    timeoutSignal,
    nowMilliseconds,
    deadlineAt,
    budget,
    receipts,
  );
  ensureBeforeDeadline(nowMilliseconds, deadlineAt, subdomain.receipt.endpointPath);

  const readbackRequestIdSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-request-id-set-v1",
    readbackRequestSha256: input.readbackRequestSha256,
    responseRequestIdSha256s:
      receipts.map((receipt) => receipt.responseRequestIdSha256),
  });
  const remoteEvidenceSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-cloudflare-evidence-v1",
    readbackRequestSha256: input.readbackRequestSha256,
    receipts,
  });
  const authenticationEvidenceSha256 = sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-deployment-readback-authentication-evidence-v1",
    credentialIdSha256: input.credentialIdSha256,
    requests: receipts.map((receipt) => ({
      method: receipt.method,
      endpointPath: receipt.endpointPath,
      authorizationScheme: "Bearer",
    })),
  });

  return {
    workersDev: subdomainState.enabled,
    previewUrls: subdomainState.previewsEnabled,
    routeSetSha256,
    readbackRequestIdSha256,
    remoteEvidenceSha256,
    authenticationEvidenceSha256,
    observedAt: Math.floor(nowMilliseconds() / 1000),
  };
}

async function boundedGetJson(
  endpointPath: string,
  apiToken: string,
  fetchImpl: FetchLike,
  timeoutSignal: (milliseconds: number) => AbortSignal,
  nowMilliseconds: () => number,
  deadlineAt: number,
  budget: { remaining: number },
): Promise<BoundedJsonResult> {
  const url = allowlistedUrl(endpointPath);
  const remainingMilliseconds = remainingDeadline(
    nowMilliseconds,
    deadlineAt,
    endpointPath,
  );
  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "manual",
      signal: timeoutSignal(remainingMilliseconds),
    });
  } catch {
    throw new RemoteReadbackAmbiguity("network_or_deadline_failure", {
      endpointPath,
    });
  }

  const responseRequestIdSha256 = responseRequestId(response.headers);
  const baseEvidence = {
    endpointPath,
    httpStatus: response.status,
    responseRequestIdSha256,
  };
  if (response.status >= 300 && response.status <= 399) {
    throw new RemoteReadbackAmbiguity("redirect_response", baseEvidence);
  }
  if (!response.ok) {
    throw new RemoteReadbackAmbiguity("non_success_response", baseEvidence);
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new RemoteReadbackAmbiguity("encoded_response", baseEvidence);
  }
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType === undefined
    || (contentType !== "application/json" && !contentType.endsWith("+json"))
  ) {
    throw new RemoteReadbackAmbiguity("non_json_response", baseEvidence);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new RemoteReadbackAmbiguity("invalid_content_length", baseEvidence);
    }
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > budget.remaining) {
      throw new RemoteReadbackAmbiguity("response_too_large", {
        ...baseEvidence,
        responseBytes: bytes,
      });
    }
  }

  const body = await readBoundedBody(response, budget.remaining, baseEvidence);
  budget.remaining -= body.byteLength;
  ensureBeforeDeadline(nowMilliseconds, deadlineAt, endpointPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body));
  } catch {
    throw new RemoteReadbackAmbiguity("invalid_json_response", {
      ...baseEvidence,
      responseBytes: body.byteLength,
    });
  }
  const envelope = record(parsed, "Cloudflare API envelope", endpointPath);
  if (envelope.success !== true || !("result" in envelope)) {
    throw new RemoteReadbackAmbiguity("unsuccessful_api_envelope", {
      ...baseEvidence,
      responseBytes: body.byteLength,
    });
  }
  if (envelope.errors !== undefined) {
    if (!Array.isArray(envelope.errors) || envelope.errors.length !== 0) {
      throw new RemoteReadbackAmbiguity("api_error_envelope", {
        ...baseEvidence,
        responseBytes: body.byteLength,
      });
    }
  }
  return {
    result: envelope.result,
    resultInfo: envelope.result_info ?? null,
    receipt: {
      method: "GET",
      endpointPath,
      httpStatus: response.status,
      responseBytes: body.byteLength,
      responseBodySha256: await sha256Bytes(body),
      responseRequestIdSha256,
    },
  };
}

async function collectRouteSetSha256(
  input: CloudflareReadbackInput,
  fetchImpl: FetchLike,
  timeoutSignal: (milliseconds: number) => AbortSignal,
  nowMilliseconds: () => number,
  deadlineAt: number,
  budget: { remaining: number },
  receipts: ResponseReceipt[],
): Promise<string> {
  const routes: Record<string, unknown>[] = [];
  const domains = await boundedGetJson(
    `${API_PREFIX}/accounts/${encodeURIComponent(input.accountId)}`
      + "/workers/domains",
    input.apiToken,
    fetchImpl,
    timeoutSignal,
    nowMilliseconds,
    deadlineAt,
    budget,
  );
  receipts.push(domains.receipt);
  const domainValues = array(domains.result, "Worker custom domains", "domains");
  validateOptionalSinglePage(domains.resultInfo, domainValues.length, "domains");
  for (const entry of domainValues) {
    const domain = record(entry, "Worker custom domain", "domains");
    const id = safeToken(domain.id, "custom domain ID", "domains");
    const zoneId = safeToken(domain.zone_id, "custom domain zone ID", "domains");
    const service = safeToken(domain.service, "custom domain service", "domains");
    if (
      typeof domain.hostname !== "string"
      || domain.hostname.length < 1
      || domain.hostname.length > 253
      || /\s/.test(domain.hostname)
      || (
        domain.environment !== undefined
        && domain.environment !== null
        && (
          typeof domain.environment !== "string"
          || !SAFE_TOKEN.test(domain.environment)
        )
      )
    ) {
      throw new RemoteReadbackAmbiguity("custom_domain_shape_drift");
    }
    if (service === input.expected.serviceName) {
      routes.push({
        kind: "custom-domain",
        idSha256: sha256Canonical({ id }),
        zoneIdSha256: sha256Canonical({ zoneId }),
        hostnameSha256: sha256Canonical({ hostname: domain.hostname }),
        environment: domain.environment ?? null,
      });
    }
  }

  const zoneIds: string[] = [];
  let totalPages: number | null = null;
  let totalCount: number | null = null;
  for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
    const query = new URLSearchParams({
      "account.id": input.accountId,
      page: String(page),
      per_page: String(ZONE_PAGE_SIZE),
      order: "name",
      direction: "asc",
      match: "all",
    });
    const zones = await boundedGetJson(
      `${API_PREFIX}/zones?${query.toString()}`,
      input.apiToken,
      fetchImpl,
      timeoutSignal,
      nowMilliseconds,
      deadlineAt,
      budget,
    );
    receipts.push(zones.receipt);
    const zoneValues = array(zones.result, "account zones", "zones");
    const info = numberedPage(zones.resultInfo, page, zoneValues.length);
    if (totalPages === null) {
      totalPages = info.totalPages;
      totalCount = info.totalCount;
      if (totalPages > MAX_ZONE_PAGES || totalCount > MAX_ZONES) {
        throw new RemoteReadbackAmbiguity("zone_inventory_limit_exceeded");
      }
    } else if (
      totalPages !== info.totalPages
      || totalCount !== info.totalCount
    ) {
      throw new RemoteReadbackAmbiguity("zone_pagination_snapshot_drift");
    }
    for (const entry of zoneValues) {
      const zone = record(entry, "Cloudflare zone", "zones");
      const id = safeToken(zone.id, "zone ID", "zones");
      const account = record(zone.account, "zone account", "zones");
      if (account.id !== input.accountId || zoneIds.includes(id)) {
        throw new RemoteReadbackAmbiguity("zone_inventory_shape_drift");
      }
      zoneIds.push(id);
    }
    if (page === totalPages) break;
  }
  if (
    totalPages === null
    || totalCount === null
    || zoneIds.length !== totalCount
  ) {
    throw new RemoteReadbackAmbiguity("zone_pagination_incomplete");
  }

  for (const zoneId of zoneIds) {
    const zoneRoutes = await boundedGetJson(
      `${API_PREFIX}/zones/${encodeURIComponent(zoneId)}/workers/routes`,
      input.apiToken,
      fetchImpl,
      timeoutSignal,
      nowMilliseconds,
      deadlineAt,
      budget,
    );
    receipts.push(zoneRoutes.receipt);
    const routeValues = array(zoneRoutes.result, "zone Worker routes", "routes");
    for (const entry of routeValues) {
      const route = record(entry, "zone Worker route", "routes");
      const id = safeToken(route.id, "route ID", "routes");
      if (
        typeof route.pattern !== "string"
        || route.pattern.length < 1
        || route.pattern.length > 2048
      ) {
        throw new RemoteReadbackAmbiguity("zone_route_shape_drift");
      }
      if (
        route.script !== undefined
        && route.script !== null
        && typeof route.script !== "string"
      ) {
        throw new RemoteReadbackAmbiguity("zone_route_shape_drift");
      }
      if (route.script === input.expected.serviceName) {
        routes.push({
          kind: "zone-route",
          idSha256: sha256Canonical({ id }),
          zoneIdSha256: sha256Canonical({ zoneId }),
          patternSha256: sha256Canonical({ pattern: route.pattern }),
        });
      }
    }
  }
  routes.sort((left, right) => {
    const leftKey = canonicalJson(left);
    const rightKey = canonicalJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return sha256Canonical(routes);
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  evidence: {
    readonly endpointPath: string;
    readonly httpStatus: number;
    readonly responseRequestIdSha256: string;
  },
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new RemoteReadbackAmbiguity("response_body_absent", evidence);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RemoteReadbackAmbiguity("response_too_large", {
          ...evidence,
          responseBytes: total,
        });
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof RemoteReadbackAmbiguity) throw error;
    throw new RemoteReadbackAmbiguity("response_body_failure", {
      ...evidence,
      responseBytes: total,
    });
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function assertExactActiveDeployment(result: unknown, versionId: string): void {
  const value = record(result, "Worker deployments", "deployments");
  if (
    !Array.isArray(value.deployments)
    || value.deployments.length === 0
    || value.deployments.length > MAX_DEPLOYMENTS
  ) {
    throw new RemoteReadbackAmbiguity("deployment_set_shape_drift");
  }
  const deployments = value.deployments.map((entry) => normalizeDeployment(entry));
  deployments.sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  if (
    deployments.length > 1
    && deployments[0]?.createdOn === deployments[1]?.createdOn
  ) {
    throw new RemoteReadbackAmbiguity("deployment_order_ambiguous");
  }
  const active = deployments[0];
  if (
    active === undefined
    || active.versions.length !== 1
    || active.versions[0]?.versionId !== versionId
    || active.versions[0]?.percentage !== 100
  ) {
    throw new RemoteReadbackAmbiguity("active_deployment_drift");
  }
}

function normalizeDeployment(input: unknown): {
  readonly createdOn: string;
  readonly versions: readonly {
    readonly versionId: string;
    readonly percentage: number;
  }[];
} {
  const value = record(input, "Worker deployment", "deployments");
  if (
    !SAFE_TOKEN.test(String(value.id ?? ""))
    || value.strategy !== "percentage"
    || typeof value.created_on !== "string"
    || !Number.isFinite(Date.parse(value.created_on))
    || !Array.isArray(value.versions)
    || value.versions.length < 1
    || value.versions.length > 2
  ) {
    throw new RemoteReadbackAmbiguity("deployment_shape_drift");
  }
  const versions = value.versions.map((entry) => {
    const version = record(entry, "Worker deployment version", "deployments");
    if (
      typeof version.version_id !== "string"
      || !SAFE_TOKEN.test(version.version_id)
      || !Number.isSafeInteger(version.percentage)
      || Number(version.percentage) <= 0
      || Number(version.percentage) > 100
    ) {
      throw new RemoteReadbackAmbiguity("deployment_version_shape_drift");
    }
    return {
      versionId: version.version_id,
      percentage: Number(version.percentage),
    };
  });
  const versionIds = new Set(versions.map((entry) => entry.versionId));
  const total = versions.reduce((sum, entry) => sum + entry.percentage, 0);
  if (versionIds.size !== versions.length || total !== 100) {
    throw new RemoteReadbackAmbiguity("deployment_version_set_drift");
  }
  return { createdOn: value.created_on, versions };
}

function assertExactVersion(result: unknown, versionId: string): void {
  const value = record(result, "Worker version", "version");
  if (value.id !== versionId) {
    throw new RemoteReadbackAmbiguity("exact_version_drift");
  }
  const resources = record(value.resources, "Worker version resources", "version");
  const bindings = resources.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > MAX_VERSION_BINDINGS) {
    throw new RemoteReadbackAmbiguity("version_binding_shape_drift");
  }
  for (const entry of bindings) {
    const binding = record(entry, "Worker version binding", "version");
    if (
      typeof binding.name !== "string"
      || !BINDING_NAME.test(binding.name)
      || typeof binding.type !== "string"
      || !SAFE_TOKEN.test(binding.type)
      || binding.type === "inherit"
    ) {
      throw new RemoteReadbackAmbiguity("version_binding_shape_drift");
    }
  }
}

function normalizeSubdomain(result: unknown): {
  readonly enabled: boolean;
  readonly previewsEnabled: boolean;
} {
  const value = record(result, "Worker subdomain", "subdomain");
  if (
    typeof value.enabled !== "boolean"
    || typeof value.previews_enabled !== "boolean"
  ) {
    throw new RemoteReadbackAmbiguity("subdomain_shape_drift");
  }
  return {
    enabled: value.enabled,
    previewsEnabled: value.previews_enabled,
  };
}

function validateOptionalSinglePage(
  input: unknown,
  resultCount: number,
  label: string,
): void {
  if (input === null) return;
  const info = record(input, `${label} pagination`, label);
  const page = nonnegativeInteger(info.page, `${label} page`);
  const totalPages = nonnegativeInteger(
    info.total_pages,
    `${label} total pages`,
  );
  const count = nonnegativeInteger(info.count, `${label} count`);
  const totalCount = nonnegativeInteger(
    info.total_count,
    `${label} total count`,
  );
  if (
    page !== 1
    || totalPages !== 1
    || count !== resultCount
    || totalCount !== resultCount
  ) {
    throw new RemoteReadbackAmbiguity("custom_domain_pagination_incomplete");
  }
}

function numberedPage(
  input: unknown,
  requestedPage: number,
  resultCount: number,
): { readonly totalPages: number; readonly totalCount: number } {
  const info = record(input, "zone pagination", "zones");
  const page = nonnegativeInteger(info.page, "zone page");
  const perPage = nonnegativeInteger(info.per_page, "zone per-page count");
  const count = nonnegativeInteger(info.count, "zone page count");
  const totalPages = nonnegativeInteger(
    info.total_pages,
    "zone total pages",
  );
  const totalCount = nonnegativeInteger(
    info.total_count,
    "zone total count",
  );
  if (
    page !== requestedPage
    || perPage !== ZONE_PAGE_SIZE
    || count !== resultCount
    || totalPages < 1
    || requestedPage > totalPages
    || totalCount < resultCount
  ) {
    throw new RemoteReadbackAmbiguity("zone_pagination_shape_drift");
  }
  return { totalPages, totalCount };
}

function allowlistedUrl(endpointPath: string): URL {
  const value = new URL(endpointPath, API_ORIGIN);
  const canonicalPath = `${value.pathname}${value.search}`;
  if (
    value.origin !== API_ORIGIN
    || value.protocol !== "https:"
    || value.username !== ""
    || value.password !== ""
    || value.hash !== ""
    || canonicalPath !== endpointPath
    || !value.pathname.startsWith(`${API_PREFIX}/`)
  ) {
    throw new RemoteReadbackAmbiguity("endpoint_not_allowlisted", {
      endpointPath,
    });
  }
  if (value.search !== "") validateZoneQuery(value, endpointPath);
  return value;
}

function validateZoneQuery(value: URL, endpointPath: string): void {
  const allowed = new Set([
    "account.id",
    "page",
    "per_page",
    "order",
    "direction",
    "match",
  ]);
  if (
    value.pathname !== `${API_PREFIX}/zones`
    || [...value.searchParams.keys()].some((key) => !allowed.has(key))
    || [...allowed].some((key) => value.searchParams.getAll(key).length !== 1)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(
      value.searchParams.get("account.id") ?? "",
    )
    || !/^[1-9][0-9]*$/.test(value.searchParams.get("page") ?? "")
    || value.searchParams.get("per_page") !== String(ZONE_PAGE_SIZE)
    || value.searchParams.get("order") !== "name"
    || value.searchParams.get("direction") !== "asc"
    || value.searchParams.get("match") !== "all"
  ) {
    throw new RemoteReadbackAmbiguity("endpoint_not_allowlisted", {
      endpointPath,
    });
  }
}

function responseRequestId(headers: Headers): string {
  for (const header of ["cf-ray", "cf-request-id", "x-request-id"]) {
    const value = headers.get(header);
    if (value === null) continue;
    if (!VISIBLE_HEADER.test(value)) {
      throw new RemoteReadbackAmbiguity("response_request_id_invalid");
    }
    return sha256Canonical({ header, value });
  }
  throw new RemoteReadbackAmbiguity("response_request_id_absent");
}

function remainingDeadline(
  nowMilliseconds: () => number,
  deadlineAt: number,
  endpointPath: string,
): number {
  const remaining = Math.floor(deadlineAt - nowMilliseconds());
  if (remaining <= 0) {
    throw new RemoteReadbackAmbiguity("total_deadline_exceeded", {
      endpointPath,
    });
  }
  return remaining;
}

function ensureBeforeDeadline(
  nowMilliseconds: () => number,
  deadlineAt: number,
  endpointPath: string,
): void {
  remainingDeadline(nowMilliseconds, deadlineAt, endpointPath);
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((entry) => entry.toString(16).padStart(2, "0"))
    .join("");
}

function record(
  value: unknown,
  _label: string,
  endpointPath: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteReadbackAmbiguity("api_shape_drift", { endpointPath });
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, _label: string, endpointPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RemoteReadbackAmbiguity("api_shape_drift", { endpointPath });
  }
  return value;
}

function safeToken(
  value: unknown,
  _label: string,
  endpointPath: string,
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new RemoteReadbackAmbiguity("api_shape_drift", { endpointPath });
  }
  return value;
}

function nonnegativeInteger(value: unknown, _label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RemoteReadbackAmbiguity("pagination_shape_drift");
  }
  return Number(value);
}
