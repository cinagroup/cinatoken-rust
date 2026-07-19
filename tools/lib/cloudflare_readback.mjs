import { createHash } from "node:crypto";

const cloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4";
const maxPageResponseBytes = 4 * 1024 * 1024;
const maxAggregateOutputBytes = 16 * 1024 * 1024;
const maxPages = 1_024;
const maxItems = 100_000;
const pageSize = 100;
const requestTimeoutMs = 60_000;
const readbackTimeoutMs = 5 * 60_000;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/;
const pageTokenPattern = /^[\x21-\x7e]{1,1024}$/;
const singleResponseMode = "single-response";
const pageNumberMode = "page-number";
const pageTokenMode = "page-token";
const monotonicNow = () => globalThis.performance.now();

export const CLOUDFLARE_READBACK_REQUEST_KEYS = Object.freeze([
  "edge-version",
  "edge-deployments",
  "controller-version",
  "controller-deployments",
  "provider-egress-version",
  "provider-egress-deployments",
  "d1-info",
  "r2-info",
  "kv-namespaces",
  "container-applications",
  "container-info",
  "container-instances",
  "container-deployments",
]);

export class CloudflareReadbackError extends Error {}

class CloudflareReadbackRequestError extends CloudflareReadbackError {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

class CloudflareReadbackCredentialReflectionError extends CloudflareReadbackError {}

export function buildCloudflareReadbackPlan(request) {
  const candidate = requireObject(request?.candidate, "candidate");
  const accountId = requireSafeToken(request?.accountId, "account ID");
  const configKvNamespaceId = requireSafeToken(
    request?.configKvNamespaceId,
    "CONFIG_KV namespace ID",
  );
  const containerApplicationId = requireSafeToken(
    request?.containerApplicationId,
    "Container application ID",
  );

  const worker = (keyPrefix, name, versionId) => [
    apiRequest({
      key: `${keyPrefix}-version`,
      accountId,
      pathSegments: ["workers", "scripts", name, "versions", versionId],
      expectedValues: [versionId],
      paginationMode: singleResponseMode,
      resultShape: "worker-version",
    }),
    apiRequest({
      key: `${keyPrefix}-deployments`,
      accountId,
      pathSegments: ["workers", "scripts", name, "deployments"],
      expectedValues: [versionId],
      paginationMode: singleResponseMode,
      resultShape: "worker-deployments",
    }),
  ];

  const plan = [
    ...worker(
      "edge",
      "cinatoken-rust-api-staging",
      requireSafeToken(candidate.edgeWorkerVersionId, "edge Worker version ID"),
    ),
    ...worker(
      "controller",
      requireSafeToken(candidate.controllerServiceName, "Controller service name"),
      requireSafeToken(
        candidate.controllerWorkerVersionId,
        "Controller Worker version ID",
      ),
    ),
    ...worker(
      "provider-egress",
      requireSafeToken(
        candidate.providerEgressServiceName,
        "provider-egress service name",
      ),
      requireSafeToken(
        candidate.providerEgressWorkerVersionId,
        "provider-egress Worker version ID",
      ),
    ),
    apiRequest({
      key: "d1-info",
      accountId,
      pathSegments: [
        "d1",
        "database",
        requireSafeToken(candidate.d1DatabaseId, "D1 database ID"),
      ],
      expectedValues: [candidate.d1DatabaseName, candidate.d1DatabaseId],
      paginationMode: singleResponseMode,
      resultShape: "d1-info",
    }),
    apiRequest({
      key: "r2-info",
      accountId,
      pathSegments: [
        "r2",
        "buckets",
        requireSafeToken(candidate.r2BucketName, "R2 bucket name"),
      ],
      expectedValues: [candidate.r2BucketName],
      paginationMode: singleResponseMode,
      resultShape: "r2-info",
    }),
    apiRequest({
      key: "kv-namespaces",
      accountId,
      pathSegments: ["storage", "kv", "namespaces"],
      query: { page: "1", per_page: String(pageSize) },
      expectedValues: [configKvNamespaceId],
      paginationMode: pageNumberMode,
      resultShape: "kv-namespaces",
    }),
    apiRequest({
      key: "container-applications",
      accountId,
      pathSegments: ["containers", "dash", "applications"],
      query: { per_page: String(pageSize) },
      expectedValues: [containerApplicationId],
      paginationMode: pageTokenMode,
      resultShape: "container-applications",
    }),
    apiRequest({
      key: "container-info",
      accountId,
      pathSegments: ["containers", "applications", containerApplicationId],
      expectedValues: [containerApplicationId],
      expectedContainerImageDigest: candidate.containerImageDigest,
      paginationMode: singleResponseMode,
      resultShape: "container-info",
    }),
    apiRequest({
      key: "container-instances",
      accountId,
      pathSegments: [
        "containers",
        "dash",
        "applications",
        containerApplicationId,
        "instances",
      ],
      query: { per_page: String(pageSize) },
      expectedValues: [],
      paginationMode: pageTokenMode,
      resultShape: "container-instances",
    }),
    apiRequest({
      key: "container-deployments",
      accountId,
      pathSegments: [
        "containers",
        "applications",
        containerApplicationId,
        "deployments",
      ],
      expectedValues: [],
      expectedContainerImageDigest: candidate.containerImageDigest,
      paginationMode: singleResponseMode,
      resultShape: "container-deployments",
    }),
  ];

  if (
    plan.length !== CLOUDFLARE_READBACK_REQUEST_KEYS.length ||
    plan.some((item, index) => item.key !== CLOUDFLARE_READBACK_REQUEST_KEYS[index])
  ) {
    throw new CloudflareReadbackError("readback request inventory drifted");
  }
  for (const item of plan) assertReadOnlyCloudflareRequest(item);
  return { accountId, plan };
}

export function assertReadOnlyCloudflareRequest(item) {
  requireObject(item, "readback request");
  if (item.transport !== "cloudflare-api" || item.method !== "GET") {
    throw new CloudflareReadbackError("readback request must be a direct GET");
  }
  if (Object.hasOwn(item, "headers") || Object.hasOwn(item, "apiToken")) {
    throw new CloudflareReadbackError("readback plan must not contain credentials");
  }
  requireSafeToken(item.accountId, "readback account ID");
  const url = parseApiUrl(item.url);
  const prefix = `/client/v4/accounts/${encodeURIComponent(item.accountId)}/`;
  if (!url.pathname.startsWith(prefix)) {
    throw new CloudflareReadbackError("readback request escaped its account scope");
  }
  const classification = classifyApiRequest(url, item.key);
  if (
    classification === null ||
    classification.paginationMode !== item.paginationMode ||
    classification.resultShape !== item.resultShape
  ) {
    throw new CloudflareReadbackError("readback request is outside the fixed allowlist");
  }
  if (!Array.isArray(item.expectedValues)) {
    throw new CloudflareReadbackError("readback expected values are invalid");
  }
  for (const value of item.expectedValues) requireSafeToken(value, "expected value");
  if (
    item.expectedContainerImageDigest !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(item.expectedContainerImageDigest)
  ) {
    throw new CloudflareReadbackError("expected Container image digest is invalid");
  }
  assertExpectedPlanMetadata(item, url);
  return item;
}

export async function executeCloudflareReadback(
  { accountId, plan },
  { apiToken, fetchImpl = globalThis.fetch, now = monotonicNow } = {},
) {
  validateApiToken(apiToken);
  requireSafeToken(accountId, "account ID");
  if (
    !Array.isArray(plan) ||
    plan.length === 0 ||
    typeof fetchImpl !== "function" ||
    typeof now !== "function"
  ) {
    throw new CloudflareReadbackError("readback execution inputs are invalid");
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new CloudflareReadbackError("readback clock is invalid");
  }
  const deadlineMs = startedAt + readbackTimeoutMs;
  const commands = [];
  for (const item of plan) {
    assertReadOnlyCloudflareRequest(item);
    if (item.accountId !== accountId) {
      throw new CloudflareReadbackError("readback request account drifted");
    }
    try {
      commands.push(
        await executeOne(item, { apiToken, fetchImpl, deadlineMs, now }),
      );
    } catch (error) {
      if (error instanceof CloudflareReadbackCredentialReflectionError) throw error;
      commands.push(
        failedSummary(
          item,
          error instanceof CloudflareReadbackRequestError
            ? error.reason
            : "request-failed",
        ),
      );
    }
  }
  const digestSha256 = sha256(stableJson(commands));
  return {
    commands,
    digestSha256,
    complete: commands.every((item) => item.status === "pass"),
    paginationComplete: commands.every((item) => item.paginationComplete),
    stderrEmpty: true,
  };
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function executeOne(item, dependencies) {
  let collected;
  if (item.paginationMode === singleResponseMode) {
    collected = await collectSingleResponse(item, dependencies);
  } else if (item.paginationMode === pageNumberMode) {
    collected = await collectPageNumberResults(item, dependencies);
  } else if (item.paginationMode === pageTokenMode) {
    collected = await collectPageTokenResults(item, dependencies);
  } else {
    throw new CloudflareReadbackRequestError("pagination-mode-invalid");
  }

  const normalized = stableJson(collected.result);
  const outputBytes = Buffer.byteLength(normalized, "utf8");
  if (outputBytes > maxAggregateOutputBytes) {
    throw new CloudflareReadbackRequestError("aggregate-output-limit");
  }
  const expectedValuesPresent = validateExpectedIdentity(item, collected.result);
  const expectedContainerImageDigestPresent =
    item.expectedContainerImageDigest === null
      ? null
      : validateExpectedContainerImage(
          item,
          collected.result,
          item.expectedContainerImageDigest,
        );
  const paginationEvidence = {
    mode: item.paginationMode,
    pageCount: collected.pageCount,
    pageItemCounts: collected.pageItemCounts,
    serverTotalCount: collected.serverTotalCount,
    terminal: true,
  };
  return {
    key: item.key,
    status:
      expectedValuesPresent && expectedContainerImageDigestPresent !== false
        ? "pass"
        : "not-proven",
    transport: item.transport,
    requestSha256: sha256(`${item.method}\0${item.url}`),
    outputSha256: sha256(normalized),
    outputBytes,
    stderrSha256: null,
    stderrEmpty: true,
    expectedValuesPresent,
    expectedContainerImageDigestPresent,
    itemCount: collected.itemCount,
    paginationMode: item.paginationMode,
    pageCount: collected.pageCount,
    paginationEvidenceSha256: sha256(stableJson(paginationEvidence)),
    paginationComplete: true,
  };
}

async function collectSingleResponse(item, dependencies) {
  const envelope = await fetchEnvelope(item.url, dependencies);
  if (envelope.resultInfo !== undefined && envelope.resultInfo !== null) {
    throw new CloudflareReadbackRequestError("unexpected-pagination-metadata");
  }
  const itemCount = countResultItems(item.resultShape, envelope.result);
  return {
    result: envelope.result,
    itemCount,
    pageCount: 1,
    pageItemCounts: [itemCount],
    serverTotalCount: null,
  };
}

async function collectPageNumberResults(item, dependencies) {
  const results = [];
  const identities = new Set();
  const pageItemCounts = [];
  let totalPages = null;
  let totalCount = null;
  let aggregateBytes = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(item.url);
    url.searchParams.set("page", String(page));
    const envelope = await fetchEnvelope(url.href, dependencies);
    if (!Array.isArray(envelope.result)) {
      throw new CloudflareReadbackRequestError("page-result-shape-invalid");
    }
    const info = requireResultInfo(envelope.resultInfo);
    const actualPage = requireSafeInteger(info.page, "page", 1, maxPages);
    const actualPerPage = requireSafeInteger(
      info.per_page,
      "per_page",
      1,
      pageSize,
    );
    const actualCount = requireSafeInteger(
      info.count,
      "count",
      0,
      pageSize,
    );
    const actualTotalCount = requireSafeInteger(
      info.total_count,
      "total_count",
      0,
      maxItems,
    );
    const actualTotalPages = requireSafeInteger(
      info.total_pages,
      "total_pages",
      1,
      maxPages,
    );
    if (
      actualPage !== page ||
      actualPerPage !== pageSize ||
      actualCount !== envelope.result.length ||
      actualTotalPages !==
        Math.max(1, Math.ceil(actualTotalCount / actualPerPage))
    ) {
      throw new CloudflareReadbackRequestError("page-metadata-inconsistent");
    }
    if (totalPages === null) {
      totalPages = actualTotalPages;
      totalCount = actualTotalCount;
    } else if (
      totalPages !== actualTotalPages ||
      totalCount !== actualTotalCount
    ) {
      throw new CloudflareReadbackRequestError("page-snapshot-drift");
    }
    if (page > totalPages) {
      throw new CloudflareReadbackRequestError("page-terminal-overrun");
    }
    const expectedPageCount =
      page < totalPages
        ? actualPerPage
        : totalCount - actualPerPage * (totalPages - 1);
    if (actualCount !== expectedPageCount) {
      throw new CloudflareReadbackRequestError("page-metadata-inconsistent");
    }
    addPageIdentities(item, envelope.result, identities);
    results.push(...envelope.result);
    pageItemCounts.push(envelope.result.length);
    aggregateBytes += Buffer.byteLength(stableJson(envelope.result), "utf8");
    if (aggregateBytes > maxAggregateOutputBytes || results.length > maxItems) {
      throw new CloudflareReadbackRequestError("aggregate-output-limit");
    }
    if (page === totalPages) {
      if (results.length !== totalCount) {
        throw new CloudflareReadbackRequestError("page-total-count-mismatch");
      }
      return {
        result: sortPagedResult(item, results),
        itemCount: results.length,
        pageCount: page,
        pageItemCounts,
        serverTotalCount: totalCount,
      };
    }
  }
  throw new CloudflareReadbackRequestError("page-limit");
}

async function collectPageTokenResults(item, dependencies) {
  const pageResults = [];
  const identities = new Set();
  const seenTokens = new Set();
  const pageItemCounts = [];
  let pageToken = null;
  let aggregateBytes = 0;
  let itemCount = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(item.url);
    if (pageToken !== null) url.searchParams.set("page_token", pageToken);
    const envelope = await fetchEnvelope(url.href, dependencies);
    const count = countResultItems(item.resultShape, envelope.result);
    if (count > pageSize) {
      throw new CloudflareReadbackRequestError("page-item-limit");
    }
    addPageIdentities(item, envelope.result, identities);
    pageResults.push(envelope.result);
    pageItemCounts.push(count);
    itemCount += count;
    aggregateBytes += Buffer.byteLength(stableJson(envelope.result), "utf8");
    if (
      itemCount > maxItems ||
      aggregateBytes > maxAggregateOutputBytes
    ) {
      throw new CloudflareReadbackRequestError("aggregate-output-limit");
    }
    const info = requireResultInfo(envelope.resultInfo);
    if (!Object.hasOwn(info, "next_page_token")) {
      throw new CloudflareReadbackRequestError("page-token-terminal-missing");
    }
    const next = info.next_page_token;
    if (next === null) {
      return {
        result: normalizeTokenPagedResult(item, pageResults),
        itemCount,
        pageCount: page,
        pageItemCounts,
        serverTotalCount: null,
      };
    }
    if (
      typeof next !== "string" ||
      !pageTokenPattern.test(next) ||
      next === pageToken ||
      seenTokens.has(next)
    ) {
      throw new CloudflareReadbackRequestError("page-token-invalid");
    }
    if (count === 0) {
      throw new CloudflareReadbackRequestError("page-token-empty-nonterminal");
    }
    seenTokens.add(next);
    pageToken = next;
  }
  throw new CloudflareReadbackRequestError("page-limit");
}

async function fetchEnvelope(url, { apiToken, fetchImpl, deadlineMs, now }) {
  const remainingMs = deadlineMs - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new CloudflareReadbackRequestError("readback-timeout");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
  );
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        "User-Agent": "cinatoken-p5-readback/4",
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new CloudflareReadbackRequestError(
      controller.signal.aborted
        ? now() >= deadlineMs
          ? "readback-timeout"
          : "timeout"
        : "network-error",
    );
  }
  try {
    if (!response || typeof response !== "object") {
      throw new CloudflareReadbackRequestError("invalid-response");
    }
    if (response.redirected === true) {
      throw new CloudflareReadbackRequestError("redirect-rejected");
    }
    if (
      typeof response.url === "string" &&
      response.url.length > 0 &&
      response.url !== url
    ) {
      throw new CloudflareReadbackRequestError("response-url-mismatch");
    }
    if (response.status !== 200 || response.ok !== true) {
      await cancelResponseBody(response);
      throw new CloudflareReadbackRequestError("http-error");
    }
    const contentType = response.headers?.get?.("content-type");
    if (
      typeof contentType !== "string" ||
      contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    ) {
      await cancelResponseBody(response);
      throw new CloudflareReadbackRequestError("content-type-invalid");
    }
    const contentLength = response.headers?.get?.("content-length");
    if (
      contentLength !== null &&
      contentLength !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
        Number(contentLength) > maxPageResponseBytes)
    ) {
      await cancelResponseBody(response);
      throw new CloudflareReadbackRequestError("response-size-invalid");
    }
    let bytes;
    try {
      bytes = await readBoundedBody(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CloudflareReadbackRequestError(
          now() >= deadlineMs ? "readback-timeout" : "timeout",
        );
      }
      throw error;
    }
    if (now() > deadlineMs) {
      throw new CloudflareReadbackRequestError("readback-timeout");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CloudflareReadbackRequestError("invalid-utf8");
    }
    if (text.includes(apiToken)) {
      throw new CloudflareReadbackCredentialReflectionError(
        "Cloudflare response contained the readback credential",
      );
    }
    if (!isSafeOutput(text)) {
      throw new CloudflareReadbackRequestError("unsafe-output");
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareReadbackRequestError("invalid-json");
    }
    assertBoundedJson(envelope);
    if (jsonContainsCredential(envelope, apiToken)) {
      throw new CloudflareReadbackCredentialReflectionError(
        "Cloudflare response contained the readback credential",
      );
    }
    requireObjectForRequest(envelope, "API envelope");
    if (
      envelope.success !== true ||
      !Array.isArray(envelope.errors) ||
      envelope.errors.length !== 0 ||
      !Array.isArray(envelope.messages) ||
      !Object.hasOwn(envelope, "result")
    ) {
      throw new CloudflareReadbackRequestError("api-envelope-failed");
    }
    return {
      result: envelope.result,
      resultInfo: envelope.result_info,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new CloudflareReadbackRequestError("response-body-invalid");
        }
        total += value.byteLength;
        if (total > maxPageResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new CloudflareReadbackRequestError("response-size-invalid");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    if (total === 0) throw new CloudflareReadbackRequestError("response-empty");
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  if (typeof response.arrayBuffer !== "function") {
    throw new CloudflareReadbackRequestError("response-body-invalid");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxPageResponseBytes) {
    throw new CloudflareReadbackRequestError("response-size-invalid");
  }
  return bytes;
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function apiRequest({
  key,
  accountId,
  pathSegments,
  query = {},
  expectedValues,
  expectedContainerImageDigest = null,
  paginationMode,
  resultShape,
}) {
  const path = ["accounts", accountId, ...pathSegments]
    .map((segment) => encodeURIComponent(requireSafeToken(segment, `${key} path`)))
    .join("/");
  const url = new URL(`${cloudflareApiBaseUrl}/${path}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return {
    key,
    transport: "cloudflare-api",
    method: "GET",
    url: url.href,
    accountId,
    expectedValues: expectedValues.map((value) =>
      requireSafeToken(value, `${key} expected value`),
    ),
    expectedContainerImageDigest,
    paginationMode,
    resultShape,
  };
}

function classifyApiRequest(url, key) {
  const path = decodePath(url.pathname);
  if (path === null || path.length < 5) return null;
  const tail = path.slice(4);
  const noQuery = () => url.searchParams.size === 0;
  const pageNumberQuery = () =>
    exactQuery(url, { page: "1", per_page: String(pageSize) });
  const pageTokenQuery = () =>
    exactQuery(url, { per_page: String(pageSize) });
  const workerPrefix = ["workers", "scripts"];
  if (key.endsWith("-version")) {
    if (
      tail.length === 5 &&
      tail[0] === workerPrefix[0] &&
      tail[1] === workerPrefix[1] &&
      tail[3] === "versions" &&
      noQuery()
    ) {
      return {
        paginationMode: singleResponseMode,
        resultShape: "worker-version",
      };
    }
    return null;
  }
  if (key.endsWith("-deployments") && key !== "container-deployments") {
    if (
      tail.length === 4 &&
      tail[0] === workerPrefix[0] &&
      tail[1] === workerPrefix[1] &&
      tail[3] === "deployments" &&
      noQuery()
    ) {
      return {
        paginationMode: singleResponseMode,
        resultShape: "worker-deployments",
      };
    }
    return null;
  }
  const exactTail = (...segments) =>
    tail.length === segments.length &&
    segments.every((segment, index) => segment === "*" || tail[index] === segment);
  if (key === "d1-info" && exactTail("d1", "database", "*") && noQuery()) {
    return { paginationMode: singleResponseMode, resultShape: "d1-info" };
  }
  if (key === "r2-info" && exactTail("r2", "buckets", "*") && noQuery()) {
    return { paginationMode: singleResponseMode, resultShape: "r2-info" };
  }
  if (
    key === "kv-namespaces" &&
    exactTail("storage", "kv", "namespaces") &&
    pageNumberQuery()
  ) {
    return { paginationMode: pageNumberMode, resultShape: "kv-namespaces" };
  }
  if (
    key === "container-applications" &&
    exactTail("containers", "dash", "applications") &&
    pageTokenQuery()
  ) {
    return {
      paginationMode: pageTokenMode,
      resultShape: "container-applications",
    };
  }
  if (
    key === "container-info" &&
    exactTail("containers", "applications", "*") &&
    noQuery()
  ) {
    return {
      paginationMode: singleResponseMode,
      resultShape: "container-info",
    };
  }
  if (
    key === "container-instances" &&
    exactTail("containers", "dash", "applications", "*", "instances") &&
    pageTokenQuery()
  ) {
    return { paginationMode: pageTokenMode, resultShape: "container-instances" };
  }
  if (
    key === "container-deployments" &&
    exactTail("containers", "applications", "*", "deployments") &&
    noQuery()
  ) {
    return {
      paginationMode: singleResponseMode,
      resultShape: "container-deployments",
    };
  }
  return null;
}

function assertExpectedPlanMetadata(item, url) {
  const expectedCounts = {
    "worker-version": 1,
    "worker-deployments": 1,
    "d1-info": 2,
    "r2-info": 1,
    "kv-namespaces": 1,
    "container-applications": 1,
    "container-info": 1,
    "container-instances": 0,
    "container-deployments": 0,
  };
  if (item.expectedValues.length !== expectedCounts[item.resultShape]) {
    throw new CloudflareReadbackError("readback expected-value contract drifted");
  }
  const imageRequired =
    item.resultShape === "container-info" ||
    item.resultShape === "container-deployments";
  if ((item.expectedContainerImageDigest !== null) !== imageRequired) {
    throw new CloudflareReadbackError("readback image contract drifted");
  }
  const path = decodePath(url.pathname);
  if (path === null) {
    throw new CloudflareReadbackError("readback path encoding is invalid");
  }
  const tail = path.slice(4);
  if (
    item.resultShape === "worker-version" &&
    item.expectedValues[0] !== tail[4]
  ) {
    throw new CloudflareReadbackError("Worker version path drifted");
  }
  if (
    item.resultShape === "d1-info" &&
    item.expectedValues[1] !== tail[2]
  ) {
    throw new CloudflareReadbackError("D1 path drifted");
  }
  if (
    item.resultShape === "r2-info" &&
    item.expectedValues[0] !== tail[2]
  ) {
    throw new CloudflareReadbackError("R2 path drifted");
  }
  if (
    item.resultShape === "container-info" &&
    item.expectedValues[0] !== tail[2]
  ) {
    throw new CloudflareReadbackError("Container application path drifted");
  }
}

function countResultItems(resultShape, result) {
  if (resultShape === "container-applications" || resultShape === "kv-namespaces") {
    if (!Array.isArray(result)) {
      throw new CloudflareReadbackRequestError("page-result-shape-invalid");
    }
    return result.length;
  }
  if (resultShape === "container-instances") {
    const value = requireObjectForRequest(result, "Container instances result");
    if (!Array.isArray(value.instances)) {
      throw new CloudflareReadbackRequestError("page-result-shape-invalid");
    }
    if (
      value.durable_objects !== undefined &&
      !Array.isArray(value.durable_objects)
    ) {
      throw new CloudflareReadbackRequestError("page-result-shape-invalid");
    }
    return value.instances.length + (value.durable_objects?.length ?? 0);
  }
  if (resultShape === "worker-deployments") {
    return requireDeploymentArray(result, "Worker deployments", false).length;
  }
  if (resultShape === "container-deployments") {
    return requireDeploymentArray(result, "Container deployments", true).length;
  }
  if (
    resultShape === "worker-version" ||
    resultShape === "d1-info" ||
    resultShape === "r2-info" ||
    resultShape === "container-info"
  ) {
    requireObjectForRequest(result, `${resultShape} result`);
    return 1;
  }
  throw new CloudflareReadbackRequestError("result-shape-invalid");
}

function addPageIdentities(item, result, identities) {
  const entries = [];
  if (item.resultShape === "kv-namespaces") {
    for (const value of result) entries.push(["kv", value]);
  } else if (item.resultShape === "container-applications") {
    for (const value of result) entries.push(["application", value]);
  } else if (item.resultShape === "container-instances") {
    for (const value of result.instances) entries.push(["instance", value]);
    for (const value of result.durable_objects ?? []) {
      entries.push(["durable-object", value]);
    }
  }
  for (const [kind, value] of entries) {
    const object = requireObjectForRequest(value, `${kind} item`);
    const id = requireSafeTokenForRequest(object.id, `${kind} ID`);
    const identity = `${kind}:${id}`;
    if (identities.has(identity)) {
      throw new CloudflareReadbackRequestError("page-duplicate-item");
    }
    identities.add(identity);
  }
}

function sortPagedResult(item, result) {
  if (item.resultShape === "kv-namespaces") {
    return [...result].sort((left, right) => compareIds(left, right));
  }
  return result;
}

function normalizeTokenPagedResult(item, pages) {
  if (item.resultShape === "container-applications") {
    return pages.flat().sort((left, right) => compareIds(left, right));
  }
  if (item.resultShape === "container-instances") {
    const instances = [];
    const durableObjects = [];
    for (const page of pages) {
      instances.push(...page.instances);
      durableObjects.push(...(page.durable_objects ?? []));
    }
    instances.sort((left, right) => compareIds(left, right));
    durableObjects.sort((left, right) => compareIds(left, right));
    return { durable_objects: durableObjects, instances };
  }
  throw new CloudflareReadbackRequestError("page-result-shape-invalid");
}

function compareIds(left, right) {
  const leftId = requireSafeTokenForRequest(left?.id, "item ID");
  const rightId = requireSafeTokenForRequest(right?.id, "item ID");
  return leftId.localeCompare(rightId, "en");
}

function requireResultInfo(value) {
  return requireObjectForRequest(value, "pagination result_info");
}

function requireSafeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CloudflareReadbackRequestError(`${label}-invalid`);
  }
  return value;
}

function failedSummary(item, reason) {
  return {
    key: item.key,
    status: "not-proven",
    transport: item.transport,
    requestSha256: sha256(`${item.method}\0${item.url}`),
    outputSha256: null,
    outputBytes: 0,
    stderrSha256: null,
    stderrEmpty: true,
    expectedValuesPresent: false,
    expectedContainerImageDigestPresent:
      item.expectedContainerImageDigest === null ? null : false,
    itemCount: null,
    paginationMode: item.paginationMode,
    pageCount: null,
    paginationEvidenceSha256: null,
    paginationComplete: false,
    reason,
  };
}

function parseApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflareReadbackError("readback URL is invalid");
  }
  if (
    url.origin !== "https://api.cloudflare.com" ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new CloudflareReadbackError("readback URL must use the Cloudflare API origin");
  }
  return url;
}

function decodePath(pathname) {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function exactQuery(url, expected) {
  if (url.searchParams.size !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(
    ([name, value]) => url.searchParams.get(name) === value,
  );
}

function applicationImageMatchesDigest(value, expectedDigest) {
  const images = [value?.configuration?.image, value?.image];
  return images.some(
    (image) =>
      typeof image === "string" &&
      (image === expectedDigest || image.endsWith(`@${expectedDigest}`)),
  );
}

function validateExpectedIdentity(item, result) {
  if (item.resultShape === "worker-version") {
    const value = requireObjectForRequest(result, "Worker version result");
    return requireSafeTokenForRequest(value.id, "Worker version ID") ===
      item.expectedValues[0];
  }
  if (item.resultShape === "worker-deployments") {
    const deployments = requireDeploymentArray(
      result,
      "Worker deployments",
      false,
    );
    if (deployments.length === 0) return false;
    const latest = requireObjectForRequest(
      deployments[0],
      "active Worker deployment",
    );
    if (!Array.isArray(latest.versions) || latest.versions.length !== 1) {
      return false;
    }
    const version = requireObjectForRequest(
      latest.versions[0],
      "active Worker deployment version",
    );
    if (
      typeof version.percentage !== "number" ||
      !Number.isFinite(version.percentage)
    ) {
      throw new CloudflareReadbackRequestError("result-shape-invalid");
    }
    return (
      requireSafeTokenForRequest(version.version_id, "deployment version ID") ===
        item.expectedValues[0] && version.percentage === 100
    );
  }
  if (item.resultShape === "d1-info") {
    const value = requireObjectForRequest(result, "D1 result");
    return (
      requireSafeTokenForRequest(value.name, "D1 name") ===
        item.expectedValues[0] &&
      requireSafeTokenForRequest(value.uuid, "D1 UUID") ===
        item.expectedValues[1]
    );
  }
  if (item.resultShape === "r2-info") {
    const value = requireObjectForRequest(result, "R2 result");
    return (
      requireSafeTokenForRequest(value.name, "R2 name") ===
      item.expectedValues[0]
    );
  }
  if (
    item.resultShape === "kv-namespaces" ||
    item.resultShape === "container-applications"
  ) {
    const ids = new Set(
      result.map((value) =>
        requireSafeTokenForRequest(
          requireObjectForRequest(value, `${item.resultShape} item`).id,
          `${item.resultShape} ID`,
        ),
      ),
    );
    return item.expectedValues.every((expected) => ids.has(expected));
  }
  if (item.resultShape === "container-info") {
    const value = requireObjectForRequest(result, "Container application result");
    return (
      requireSafeTokenForRequest(value.id, "Container application ID") ===
      item.expectedValues[0]
    );
  }
  if (
    item.resultShape === "container-instances" ||
    item.resultShape === "container-deployments"
  ) {
    return item.expectedValues.length === 0;
  }
  throw new CloudflareReadbackRequestError("result-shape-invalid");
}

function validateExpectedContainerImage(item, result, expectedDigest) {
  if (item.resultShape === "container-info") {
    return applicationImageMatchesDigest(result, expectedDigest);
  }
  if (item.resultShape === "container-deployments") {
    const deployments = requireDeploymentArray(
      result,
      "Container deployments",
      true,
    );
    const active = [];
    for (const entry of deployments) {
      const deployment = requireObjectForRequest(entry, "Container deployment");
      requireSafeTokenForRequest(deployment.id, "Container deployment ID");
      if (
        typeof deployment.image !== "string" ||
        deployment.image.length === 0 ||
        deployment.image.length > 2_048 ||
        /[^\x21-\x7e]/.test(deployment.image)
      ) {
        throw new CloudflareReadbackRequestError("result-shape-invalid");
      }
      if (
        deployment.current_placement !== undefined &&
        deployment.current_placement !== null
      ) {
        requireObjectForRequest(
          deployment.current_placement,
          "Container current placement",
        );
        active.push(deployment);
      }
    }
    return (
      active.length > 0 &&
      active.every((deployment) =>
        applicationImageMatchesDigest(deployment, expectedDigest),
      )
    );
  }
  throw new CloudflareReadbackRequestError("result-shape-invalid");
}

function requireDeploymentArray(result, label, allowDirectArray) {
  if (allowDirectArray) {
    if (!Array.isArray(result)) {
      throw new CloudflareReadbackRequestError("result-shape-invalid");
    }
    return result;
  }
  const value = requireObjectForRequest(result, `${label} result`);
  if (!Array.isArray(value.deployments)) {
    throw new CloudflareReadbackRequestError("result-shape-invalid");
  }
  return value.deployments;
}

function isSafeOutput(value) {
  if (typeof value !== "string" || value.includes("\0")) return false;
  return !(
    /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----$/m.test(value) ||
    /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/\-]{16,}/i.test(value) ||
    /(?:sk|rk)-[A-Za-z0-9_-]{20,}/.test(value) ||
    /(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_-]{16,}/.test(value)
  );
}

function jsonContainsCredential(root, credential) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes(credential)) return true;
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes(credential)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

function assertBoundedJson(root) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 100_000 || depth > 24) {
      throw new CloudflareReadbackRequestError("json-shape-limit");
    }
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > 64 * 1024 || value.includes("\0")) {
        throw new CloudflareReadbackRequestError("json-string-invalid");
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) {
        throw new CloudflareReadbackRequestError("json-number-invalid");
      }
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.length === 0 || key.length > 256) {
          throw new CloudflareReadbackRequestError("json-field-invalid");
        }
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CloudflareReadbackError("non-finite number cannot be canonicalized");
  }
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudflareReadbackError(`${label} must be an object`);
  }
  return value;
}

function requireObjectForRequest(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudflareReadbackRequestError(`${label}-invalid`);
  }
  return value;
}

function requireSafeToken(value, label) {
  if (typeof value !== "string" || !safeTokenPattern.test(value)) {
    throw new CloudflareReadbackError(`${label} is invalid`);
  }
  return value;
}

function requireSafeTokenForRequest(value, label) {
  if (typeof value !== "string" || !safeTokenPattern.test(value)) {
    throw new CloudflareReadbackRequestError(`${label}-invalid`);
  }
  return value;
}

function validateApiToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 4096 ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new CloudflareReadbackError("replacement readback token is invalid");
  }
}
