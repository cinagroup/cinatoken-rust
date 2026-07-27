import { createHash } from "node:crypto";

export const WORM_STAGING_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-worm-staging-phase-receipt-v2";
export const WORM_STAGING_SCHEMA_VERSION = 2;
export const WORM_POLICY_CONTRACT =
  "cinatoken-container-runtime-worm-retention-protocol-policy-v2";

export const PUBLISHER_ACCESS_KEY_ENV =
  "CINATOKEN_WORM_PUBLISHER_R2_ACCESS_KEY_ID";
export const PUBLISHER_SECRET_KEY_ENV =
  "CINATOKEN_WORM_PUBLISHER_R2_SECRET_ACCESS_KEY";
export const LOCK_OPERATOR_TOKEN_ENV =
  "CINATOKEN_WORM_LOCK_OPERATOR_API_TOKEN";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUCKET_PATTERN =
  /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const CF_RAY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_TYPE_PATTERN = /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i;
const MAX_LIST_PAGES = 1_000;
const MAX_LIST_ITEMS = 10_000;
const MAX_LOCK_RULES = 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS = 3_600;
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const REQUIRED_AUTHORITY_ROLES = [
  "publisher",
  "lock-operator",
  "object-verifier",
  "lock-verifier",
  "lifecycle-operator",
  "lifecycle-verifier",
];
const REQUIRED_REVOCATION_TARGET_ROLES = [
  "lock-operator",
  "publisher",
];
const REQUIRED_EVIDENCE_KINDS = [
  "authority-boundary",
  "lock-operator-revocation",
  "object-readback",
  "enforcement-probes",
  "publisher-revocation",
  "lock-readback",
];

export class WormStagingCollectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "WormStagingCollectorError";
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new WormStagingCollectorError(
    "[canonical] value must be JSON-compatible",
  );
}

export function normalizeWormPolicy(value) {
  const policy = requireObject(value, "[policy] policy");
  exactKeys(
    policy,
    [
      "cloudflareBucketLockDocs",
      "cloudflareR2TokenDocs",
      "cloudflareS3ApiDocs",
      "contract",
      "cosignLinuxAmd64Sha256",
      "cosignVersion",
      "environment",
      "enforcementProbePolicy",
      "maximumClockSkewSeconds",
      "maximumEvidenceAgeSeconds",
      "maximumCredentialRemainingSeconds",
      "maximumManifestLifetimeSeconds",
      "minimumRetentionSeconds",
      "prefixRoot",
      "provenanceBuilderId",
      "provenanceCertificateIdentity",
      "provenanceOidcIssuer",
      "provenanceWorkflow",
      "provider",
      "repository",
      "requiredApprovalRoles",
      "requiredAuthorityRoles",
      "requiredEvidenceKinds",
      "requiredObjectKinds",
      "requiredRevocationTargetRoles",
      "schemaVersion",
      "sourceWorkflow",
      "supportedJurisdictions",
    ],
    "[policy] policy",
  );
  requireCondition(
    policy.schemaVersion === 2 &&
      policy.contract === WORM_POLICY_CONTRACT &&
      policy.repository === "cinagroup/cinatoken-rust" &&
      policy.environment === "staging" &&
      policy.provider === "cloudflare-r2" &&
      policy.prefixRoot === "container-runtime/s3/v1/" &&
      validEnforcementProbePolicy(policy.enforcementProbePolicy) &&
      Number.isSafeInteger(policy.minimumRetentionSeconds) &&
      policy.minimumRetentionSeconds >= 365 * 24 * 60 * 60 &&
      policy.maximumCredentialRemainingSeconds ===
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS &&
      sameJson(
        policy.requiredAuthorityRoles,
        REQUIRED_AUTHORITY_ROLES,
      ) &&
      sameJson(policy.requiredEvidenceKinds, REQUIRED_EVIDENCE_KINDS) &&
      sameJson(
        policy.requiredRevocationTargetRoles,
        REQUIRED_REVOCATION_TARGET_ROLES,
      ) &&
      sameJson(policy.supportedJurisdictions, [
        "default",
        "eu",
        "fedramp",
      ]),
    "[policy] WORM protocol policy drifted",
  );
  return policy;
}

function validEnforcementProbePolicy(value) {
  if (!isObject(value)) return false;
  try {
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
        `[policy] ${name} probe tuple`,
      );
      exactKeys(
        tuple,
        ["httpStatus", "errorCodes"],
        `[policy] ${name} probe tuple`,
      );
      if (
        tuple.httpStatus !== status ||
        !sameJson(tuple.errorCodes, [code])
      ) {
        return false;
      }
    }
    return (
      sameJson(value.responseContentTypes, ["application/xml"]) &&
      sameJson(value.requestIdSources, [
        "cf-ray",
        "x-amz-request-id",
      ])
    );
  } catch {
    return false;
  }
}

export function normalizeTarget(input, rawPolicy) {
  const policy = normalizeWormPolicy(rawPolicy);
  const accountId = requirePattern(
    input.accountId,
    ACCOUNT_ID_PATTERN,
    "[target] account ID",
  );
  const bucketName = requirePattern(
    input.bucketName,
    BUCKET_PATTERN,
    "[target] bucket name",
  );
  const jurisdiction = requireString(
    input.jurisdiction,
    "[target] jurisdiction",
  );
  requireCondition(
    policy.supportedJurisdictions.includes(jurisdiction),
    "[target] jurisdiction is unsupported",
  );
  const statementSha256 = requirePattern(
    input.statementSha256,
    SHA256_PATTERN,
    "[target] statement SHA-256",
  );
  return {
    accountId,
    accountIdSha256: sha256(accountId),
    bucketName,
    jurisdiction,
    statementSha256,
    prefix: `${policy.prefixRoot}${statementSha256}/`,
    policy,
  };
}

export function publicTarget(target) {
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
  };
}

export function r2S3Endpoint(target) {
  const jurisdictionSegment =
    target.jurisdiction === "default" ? "" : `.${target.jurisdiction}`;
  return `https://${target.accountId}${jurisdictionSegment}.r2.cloudflarestorage.com`;
}

export function readPhaseCredentials(phase, env) {
  if (phase === "baseline") {
    const accessKeyId = requireCredential(
      env[PUBLISHER_ACCESS_KEY_ENV],
      PUBLISHER_ACCESS_KEY_ENV,
    );
    const secretAccessKey = requireCredential(
      env[PUBLISHER_SECRET_KEY_ENV],
      PUBLISHER_SECRET_KEY_ENV,
    );
    requireCondition(
      accessKeyId !== secretAccessKey,
      "[credentials] publisher credential values must be distinct",
    );
    return {
      accessKeyId,
      secretAccessKey,
      credentialIdSha256: sha256(accessKeyId),
    };
  }
  if (phase === "lock") {
    const apiToken = requireCredential(
      env[LOCK_OPERATOR_TOKEN_ENV],
      LOCK_OPERATOR_TOKEN_ENV,
    );
    return { apiToken };
  }
  throw new WormStagingCollectorError(
    "[credentials] unsupported collector phase",
  );
}

export function describeCollector() {
  return {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    defaultMode: "dry-run",
    writesFiles: false,
    phases: [
      {
        phase: "baseline",
        mutation: false,
        credentialRole: "publisher",
        credentialEnvironment: [
          PUBLISHER_ACCESS_KEY_ENV,
          PUBLISHER_SECRET_KEY_ENV,
        ],
        requests: ["ListObjectsV2", "ListMultipartUploads"],
      },
      {
        phase: "lock",
        mutation: true,
        credentialRole: "lock-operator",
        credentialEnvironment: [LOCK_OPERATOR_TOKEN_ENV],
        requests: [
          "GET token-verify",
          "GET lock-before",
          "PUT lock",
          "GET lock-after",
        ],
      },
    ],
    downstreamAuthority: downstreamAuthority(),
  };
}

export function buildDryRunReceipt(phase, target) {
  requirePhase(phase);
  return {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase,
    mode: "dry-run",
    ok: true,
    capturedAt: null,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target: publicTarget(target),
    requestPlan:
      phase === "baseline"
        ? ["ListObjectsV2", "ListMultipartUploads"]
        : [
            "GET token-verify",
            "GET lock-before",
            "PUT lock",
            "GET lock-after",
          ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

export async function collectEmptyBaseline(options) {
  const { target, credentials, s3, now = () => new Date() } = options;
  requireCondition(
    s3 &&
      typeof s3.listObjectsV2 === "function" &&
      typeof s3.listMultipartUploads === "function",
    "[baseline] S3 adapter is incomplete",
  );
  const objectInventory = await collectObjectPages(target, s3);
  const multipartInventory = await collectMultipartPages(target, s3);
  requireCondition(
    objectInventory.itemCount === 0,
    `[baseline] prefix is not empty (${objectInventory.itemCount} objects)`,
  );
  requireCondition(
    multipartInventory.itemCount === 0,
    `[baseline] prefix has ${multipartInventory.itemCount} multipart uploads`,
  );
  const capturedAt = requireTimestamp(now(), "[baseline] capture time");
  const receipt = {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "baseline",
    mode: "live",
    ok: true,
    capturedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target: publicTarget(target),
    credential: {
      role: "publisher",
      credentialType: "r2-object-read-write-api-token",
      credentialIdSha256: credentials.credentialIdSha256,
    },
    facts: {
      baselineObservedAt: capturedAt,
      baselinePaginationComplete: true,
      preexistingObjectCount: 0,
      multipartUploadCount: 0,
      objectPages: objectInventory.pageCount,
      multipartPages: multipartInventory.pageCount,
      providerRequestIdsComplete:
        objectInventory.providerRequestIdsComplete &&
        multipartInventory.providerRequestIdsComplete,
    },
    providerOperations: [
      ...objectInventory.operations,
      ...multipartInventory.operations,
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

async function collectObjectPages(target, s3) {
  const operations = [];
  const seenTokens = new Set();
  let continuationToken;
  let pageCount = 0;
  let itemCount = 0;
  while (true) {
    pageCount += 1;
    requireCondition(
      pageCount <= MAX_LIST_PAGES,
      "[baseline] object pagination exceeded its page bound",
    );
    const response = await invokeAdapter(
      (abortSignal) =>
        s3.listObjectsV2({
          Bucket: target.bucketName,
          Prefix: target.prefix,
          MaxKeys: 1_000,
          ContinuationToken: continuationToken,
        }, abortSignal),
      `ListObjectsV2 page ${pageCount}`,
    );
    const metadata = requireS3Metadata(
      response,
      `ListObjectsV2 page ${pageCount}`,
    );
    requireCondition(
      response.Name === target.bucketName &&
        response.Prefix === target.prefix,
      "[baseline] object listing bucket or prefix drifted",
    );
    const contents = optionalArray(
      response.Contents,
      "[baseline] object contents",
    );
    const commonPrefixes = optionalArray(
      response.CommonPrefixes,
      "[baseline] object common prefixes",
    );
    requireCondition(
      commonPrefixes.length === 0,
      "[baseline] object listing returned unexpected common prefixes",
    );
    requireCondition(
      contents.length <= 1_000 &&
        (response.MaxKeys === undefined ||
          (Number.isSafeInteger(response.MaxKeys) &&
            response.MaxKeys > 0 &&
            response.MaxKeys <= 1_000)),
      "[baseline] object page exceeded its requested bound",
    );
    for (const item of contents) {
      const record = requireObject(item, "[baseline] listed object");
      requireCondition(
        typeof record.Key === "string" &&
          record.Key.startsWith(target.prefix) &&
          record.Key.length <= 1024,
        "[baseline] object listing escaped the requested prefix",
      );
    }
    itemCount += contents.length;
    requireCondition(
      itemCount <= MAX_LIST_ITEMS,
      "[baseline] object inventory exceeded its item bound",
    );
    if (response.KeyCount !== undefined) {
      requireCondition(
        Number.isSafeInteger(response.KeyCount) &&
          response.KeyCount === contents.length,
        "[baseline] object KeyCount drifted",
      );
    }
    operations.push({
      operation: "ListObjectsV2",
      page: pageCount,
      httpStatus: metadata.httpStatus,
      providerRequestId: metadata.providerRequestId,
    });
    const truncated = requireBoolean(
      response.IsTruncated,
      "[baseline] object IsTruncated",
    );
    const nextToken = optionalNonEmptyString(response.NextContinuationToken);
    if (!truncated) {
      requireCondition(
        nextToken === null,
        "[baseline] completed object listing included a continuation token",
      );
      break;
    }
    requireCondition(
      nextToken !== null && !seenTokens.has(nextToken),
      "[baseline] object continuation token was absent or repeated",
    );
    seenTokens.add(nextToken);
    continuationToken = nextToken;
  }
  return inventoryResult(pageCount, itemCount, operations);
}

async function collectMultipartPages(target, s3) {
  const operations = [];
  const seenMarkers = new Set();
  let keyMarker;
  let uploadIdMarker;
  let pageCount = 0;
  let itemCount = 0;
  while (true) {
    pageCount += 1;
    requireCondition(
      pageCount <= MAX_LIST_PAGES,
      "[baseline] multipart pagination exceeded its page bound",
    );
    const response = await invokeAdapter(
      (abortSignal) =>
        s3.listMultipartUploads({
          Bucket: target.bucketName,
          Prefix: target.prefix,
          MaxUploads: 1_000,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }, abortSignal),
      `ListMultipartUploads page ${pageCount}`,
    );
    const metadata = requireS3Metadata(
      response,
      `ListMultipartUploads page ${pageCount}`,
    );
    requireCondition(
      response.Bucket === target.bucketName &&
        response.Prefix === target.prefix,
      "[baseline] multipart listing bucket or prefix drifted",
    );
    const uploads = optionalArray(
      response.Uploads,
      "[baseline] multipart uploads",
    );
    const commonPrefixes = optionalArray(
      response.CommonPrefixes,
      "[baseline] multipart common prefixes",
    );
    requireCondition(
      commonPrefixes.length === 0,
      "[baseline] multipart listing returned unexpected common prefixes",
    );
    requireCondition(
      uploads.length <= 1_000 &&
        (response.MaxUploads === undefined ||
          (Number.isSafeInteger(response.MaxUploads) &&
            response.MaxUploads > 0 &&
            response.MaxUploads <= 1_000)),
      "[baseline] multipart page exceeded its requested bound",
    );
    for (const item of uploads) {
      const upload = requireObject(item, "[baseline] multipart upload");
      requireCondition(
        typeof upload.Key === "string" &&
          upload.Key.startsWith(target.prefix) &&
          upload.Key.length <= 1024 &&
          typeof upload.UploadId === "string" &&
          upload.UploadId.length > 0 &&
          upload.UploadId.length <= 1024,
        "[baseline] multipart listing escaped the requested prefix",
      );
    }
    itemCount += uploads.length;
    requireCondition(
      itemCount <= MAX_LIST_ITEMS,
      "[baseline] multipart inventory exceeded its item bound",
    );
    operations.push({
      operation: "ListMultipartUploads",
      page: pageCount,
      httpStatus: metadata.httpStatus,
      providerRequestId: metadata.providerRequestId,
    });
    const truncated = requireBoolean(
      response.IsTruncated,
      "[baseline] multipart IsTruncated",
    );
    const nextKeyMarker = optionalNonEmptyString(response.NextKeyMarker);
    const nextUploadIdMarker = optionalNonEmptyString(
      response.NextUploadIdMarker,
    );
    if (!truncated) {
      requireCondition(
        nextKeyMarker === null && nextUploadIdMarker === null,
        "[baseline] completed multipart listing included next markers",
      );
      break;
    }
    requireCondition(
      nextKeyMarker !== null,
      "[baseline] multipart next key marker was absent",
    );
    const marker = `${nextKeyMarker}\u0000${nextUploadIdMarker || ""}`;
    requireCondition(
      !seenMarkers.has(marker),
      "[baseline] multipart continuation marker repeated",
    );
    seenMarkers.add(marker);
    keyMarker = nextKeyMarker;
    uploadIdMarker = nextUploadIdMarker || undefined;
  }
  return inventoryResult(pageCount, itemCount, operations);
}

function inventoryResult(pageCount, itemCount, operations) {
  return {
    pageCount,
    itemCount,
    operations,
    providerRequestIdsComplete: operations.every(
      (operation) => operation.providerRequestId !== null,
    ),
  };
}

export function expectedLockRule(target) {
  return {
    id: `cinatoken-s3-${target.statementSha256.slice(0, 24)}`,
    condition: {
      type: "Age",
      maxAgeSeconds: target.policy.minimumRetentionSeconds,
    },
    enabled: true,
    prefix: target.prefix,
  };
}

export async function collectAndConfigureLock(options) {
  const {
    target,
    credentials,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = options;
  requireCondition(
    typeof fetchImpl === "function",
    "[lock] fetch implementation is unavailable",
  );
  const wanted = expectedLockRule(target);
  const credentialPreflight = await fetchCloudflareJson({
    url: tokenVerificationUrl(target),
    token: credentials.apiToken,
    method: "GET",
    label: "credential-preflight",
    fetchImpl,
  });
  const credentialVerifiedAt = requireTimestamp(
    now(),
    "[credential-preflight] observed time",
  );
  const credentialIdentity = validateTokenVerification(
    credentialPreflight.result,
    credentialVerifiedAt,
  );
  const url = lockConfigurationUrl(target);
  const before = await fetchCloudflareJson({
    url,
    token: credentials.apiToken,
    method: "GET",
    label: "lock-before",
    fetchImpl,
  });
  const beforeRules = validateLockConfiguration(
    before.result,
    "lock-before",
  );
  requireCondition(
    beforeRules.length < MAX_LOCK_RULES,
    "[lock] lock configuration is at its rule bound",
  );
  requireCondition(
    !beforeRules.some((rule) => rule.id === wanted.id),
    "[lock] selected rule already exists; refusing an ambiguous rerun",
  );
  const desiredRules = [...beforeRules, wanted];
  const configured = await fetchCloudflareJson({
    url,
    token: credentials.apiToken,
    method: "PUT",
    label: "lock-configure",
    body: canonicalJson({ rules: desiredRules }),
    fetchImpl,
  });
  const configuredAt = requireTimestamp(now(), "[lock] configured time");
  const configuredRules = validateLockConfiguration(
    configured.result,
    "lock-configure",
  );
  requireRuleSet(desiredRules, configuredRules, "lock-configure");
  const readback = await fetchCloudflareJson({
    url,
    token: credentials.apiToken,
    method: "GET",
    label: "lock-after",
    fetchImpl,
  });
  const observedAt = requireTimestamp(now(), "[lock] observed time");
  const readbackRules = validateLockConfiguration(
    readback.result,
    "lock-after",
  );
  requireRuleSet(desiredRules, readbackRules, "lock-after");
  const selected = readbackRules.find((rule) => rule.id === wanted.id);
  requireCondition(
    selected !== undefined &&
      canonicalJson(selected) === canonicalJson(wanted),
    "[lock] selected rule readback drifted",
  );
  const receipt = {
    schemaVersion: WORM_STAGING_SCHEMA_VERSION,
    contract: WORM_STAGING_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "lock",
    mode: "live",
    ok: true,
    capturedAt: observedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target: publicTarget(target),
    credential: {
      role: "lock-operator",
      credentialType: "cloudflare-r2-admin-read-write-api-token",
      credentialIdSha256: credentialIdentity.credentialIdSha256,
      selfVerifiedAt: credentialVerifiedAt,
      expiresAt: credentialIdentity.expiresAt,
      remainingLifetimeSeconds:
        credentialIdentity.remainingLifetimeSeconds,
    },
    facts: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      awsS3ObjectLockHeadersUsed: false,
      configuredAt,
      configurationRequestId: configured.providerRequestId,
      observedAt,
      readbackRequestId: readback.providerRequestId,
      httpStatus: readback.httpStatus,
      selectedRuleId: wanted.id,
      rules: readbackRules,
      preconfigurationRequestId: before.providerRequestId,
      preexistingRuleCount: beforeRules.length,
      unrelatedRulesPreserved: true,
    },
    providerOperations: [
      operationReceipt(
        "GET",
        "credential-preflight",
        credentialPreflight,
      ),
      operationReceipt("GET", "lock-before", before),
      operationReceipt("PUT", "lock-configure", configured),
      operationReceipt("GET", "lock-after", readback),
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

function operationReceipt(method, operation, result) {
  return {
    method,
    operation,
    httpStatus: result.httpStatus,
    providerRequestId: result.providerRequestId,
  };
}

function lockConfigurationUrl(target) {
  const url = new URL(
    `${CLOUDFLARE_API_BASE}/accounts/${target.accountId}/r2/buckets/${encodeURIComponent(target.bucketName)}/lock`,
  );
  if (target.jurisdiction !== "default") {
    url.searchParams.set("jurisdiction", target.jurisdiction);
  }
  return url.toString();
}

function tokenVerificationUrl(target) {
  return `${CLOUDFLARE_API_BASE}/accounts/${target.accountId}/tokens/verify`;
}

async function fetchCloudflareJson(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "cinatoken-rust-worm-staging-collector/1",
      },
      body: options.body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === "AbortError") {
      throw new WormStagingCollectorError(
        `[${options.label}] request timed out`,
      );
    }
    throw new WormStagingCollectorError(
      `[${options.label}] provider request failed`,
    );
  }
  try {
    requireCondition(
      response &&
        response.redirected === false &&
        (!response.url || response.url === options.url),
      `[${options.label}] redirects are forbidden`,
    );
    requireCondition(
      Number.isSafeInteger(response.status) &&
        response.status >= 200 &&
        response.status <= 299,
      `[${options.label}] provider returned a non-success status`,
    );
    const contentType = response.headers?.get?.("content-type");
    requireCondition(
      typeof contentType === "string" &&
        CONTENT_TYPE_PATTERN.test(contentType),
      `[${options.label}] provider response was not JSON`,
    );
    const providerRequestId = response.headers?.get?.("cf-ray");
    requireCondition(
      typeof providerRequestId === "string" &&
        CF_RAY_PATTERN.test(providerRequestId),
      `[${options.label}] provider correlation ID is absent or invalid`,
    );
    let bytes;
    try {
      bytes = await readBoundedResponse(response, options.label);
    } catch (error) {
      if (error instanceof WormStagingCollectorError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new WormStagingCollectorError(
          `[${options.label}] response body timed out`,
        );
      }
      throw new WormStagingCollectorError(
        `[${options.label}] response body read failed`,
      );
    }
    requireCondition(
      !bytes.includes(Buffer.from(options.token, "utf8")),
      `[${options.label}] provider reflected the credential`,
    );
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new WormStagingCollectorError(
        `[${options.label}] provider response was invalid JSON`,
      );
    }
    const result = validateCloudflareEnvelope(envelope, options.label);
    return {
      result,
      httpStatus: response.status,
      providerRequestId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateTokenVerification(value, observedAt) {
  const verification = requireObject(
    value,
    "[credential-preflight] token verification",
  );
  allowedKeys(
    verification,
    ["expires_on", "id", "not_before", "status"],
    "[credential-preflight] token verification",
  );
  requireCondition(
    TOKEN_ID_PATTERN.test(verification.id) &&
      verification.status === "active" &&
      typeof verification.expires_on === "string",
    "[credential-preflight] token identity, status, or expiry is invalid",
  );
  const observedMs = Date.parse(observedAt);
  const expiresAt = requireTimestamp(
    verification.expires_on,
    "[credential-preflight] token expiry",
  );
  const expiresMs = Date.parse(expiresAt);
  const remainingLifetimeMs = expiresMs - observedMs;
  requireCondition(
    remainingLifetimeMs >= 1_000 &&
      remainingLifetimeMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000,
    "[credential-preflight] mutable credential lifetime is outside the bound",
  );
  const remainingLifetimeSeconds = Math.floor(
    remainingLifetimeMs / 1_000,
  );
  if (verification.not_before !== undefined) {
    const notBefore = requireTimestamp(
      verification.not_before,
      "[credential-preflight] token not-before",
    );
    requireCondition(
      Date.parse(notBefore) <= observedMs,
      "[credential-preflight] token is not active yet",
    );
  }
  return {
    credentialIdSha256: sha256(verification.id),
    expiresAt,
    remainingLifetimeSeconds,
  };
}

async function readBoundedResponse(response, label) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsed = Number(contentLength);
    requireCondition(
      Number.isSafeInteger(parsed) &&
        parsed >= 0 &&
        parsed <= MAX_RESPONSE_BYTES,
      `[${label}] response Content-Length exceeded its bound`,
    );
  }
  requireCondition(response.body, `[${label}] response body was absent`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    requireCondition(
      total <= MAX_RESPONSE_BYTES,
      `[${label}] response body exceeded its bound`,
    );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function validateCloudflareEnvelope(value, label) {
  const envelope = requireObject(value, `[${label}] envelope`);
  exactKeys(
    envelope,
    ["errors", "messages", "result", "success"],
    `[${label}] envelope`,
  );
  requireCondition(
    envelope.success === true &&
      Array.isArray(envelope.errors) &&
      envelope.errors.length === 0 &&
      Array.isArray(envelope.messages) &&
      envelope.messages.length === 0,
    `[${label}] provider envelope reported failure`,
  );
  return requireObject(envelope.result, `[${label}] result`);
}

function validateLockConfiguration(value, label) {
  exactKeys(value, ["rules"], `[${label}] lock configuration`);
  requireCondition(
    Array.isArray(value.rules) && value.rules.length <= MAX_LOCK_RULES,
    `[${label}] lock rule collection is invalid`,
  );
  const ids = new Set();
  const rules = value.rules.map((rule) => validateLockRule(rule, label));
  for (const rule of rules) {
    requireCondition(
      !ids.has(rule.id),
      `[${label}] lock rule ID is duplicated`,
    );
    ids.add(rule.id);
  }
  return rules;
}

function validateLockRule(value, label) {
  const rule = requireObject(value, `[${label}] lock rule`);
  exactKeys(
    rule,
    ["condition", "enabled", "id", "prefix"],
    `[${label}] lock rule`,
  );
  requireCondition(
    RULE_ID_PATTERN.test(rule.id) &&
      typeof rule.enabled === "boolean" &&
      typeof rule.prefix === "string" &&
      rule.prefix.length <= 512,
    `[${label}] lock rule identity is invalid`,
  );
  const condition = requireObject(
    rule.condition,
    `[${label}] lock condition`,
  );
  if (condition.type === "Age") {
    exactKeys(
      condition,
      ["maxAgeSeconds", "type"],
      `[${label}] age lock condition`,
    );
    requireCondition(
      Number.isSafeInteger(condition.maxAgeSeconds) &&
        condition.maxAgeSeconds > 0,
      `[${label}] age lock duration is invalid`,
    );
  } else if (condition.type === "Date") {
    exactKeys(
      condition,
      ["date", "type"],
      `[${label}] date lock condition`,
    );
    requireTimestamp(condition.date, `[${label}] date lock condition`);
  } else if (condition.type === "Indefinite") {
    exactKeys(
      condition,
      ["type"],
      `[${label}] indefinite lock condition`,
    );
  } else {
    throw new WormStagingCollectorError(
      `[${label}] lock condition type is unsupported`,
    );
  }
  return rule;
}

function requireRuleSet(expected, actual, label) {
  const sortRules = (rules) =>
    [...rules].sort((left, right) => left.id.localeCompare(right.id));
  requireCondition(
    canonicalJson(sortRules(expected)) === canonicalJson(sortRules(actual)),
    `[${label}] provider lock rule set drifted`,
  );
}

function requireS3Metadata(response, label) {
  const value = requireObject(response, `[${label}] response`);
  const metadata = requireObject(value.$metadata, `[${label}] metadata`);
  requireCondition(
    metadata.httpStatusCode === 200,
    `[${label}] provider returned a non-success status`,
  );
  let providerRequestId = null;
  if (metadata.requestId !== undefined) {
    providerRequestId = requireString(
      metadata.requestId,
      `[${label}] request ID`,
    );
    requireCondition(
      providerRequestId.length <= 256,
      `[${label}] request ID is too long`,
    );
  }
  return { httpStatus: metadata.httpStatusCode, providerRequestId };
}

async function invokeAdapter(call, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const value = await call(controller.signal);
    return requireObject(value, `[${label}] response`);
  } catch (error) {
    if (error instanceof WormStagingCollectorError) throw error;
    if (error?.name === "AbortError") {
      throw new WormStagingCollectorError(`[${label}] request timed out`);
    }
    throw new WormStagingCollectorError(
      `[${label}] provider request failed`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function collectorLimits() {
  return {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    responseBytes: MAX_RESPONSE_BYTES,
    mutableCredentialRemainingSeconds:
      MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS,
    listPages: MAX_LIST_PAGES,
    listItems: MAX_LIST_ITEMS,
    lockRules: MAX_LOCK_RULES,
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

function assertSensitiveValuesAbsent(value, sensitiveValues) {
  const serialized = canonicalJson(value);
  for (const sensitive of sensitiveValues) {
    if (
      typeof sensitive === "string" &&
      sensitive.length > 0 &&
      serialized.includes(sensitive)
    ) {
      throw new WormStagingCollectorError(
        "[redaction] receipt contained sensitive input",
      );
    }
  }
}

function requireCredential(value, envName) {
  requireCondition(
    typeof value === "string" &&
      value.length >= 20 &&
      value.length <= 4096 &&
      !/[^\x21-\x7e]/.test(value),
    `[credentials] ${envName} is absent or invalid`,
  );
  return value;
}

function requirePhase(value) {
  requireCondition(
    value === "baseline" || value === "lock",
    "[input] phase must be baseline or lock",
  );
  return value;
}

function requireTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  requireCondition(
    !Number.isNaN(date.getTime()),
    `${label} is not a timestamp`,
  );
  return date.toISOString();
}

function optionalArray(value, label) {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value), `${label} must be an array`);
  return value;
}

function optionalNonEmptyString(value) {
  if (value === undefined || value === null) return null;
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= 4096,
    "[pagination] continuation value is invalid",
  );
  return value;
}

function requireBoolean(value, label) {
  requireCondition(typeof value === "boolean", `${label} must be boolean`);
  return value;
}

function requirePattern(value, pattern, label) {
  const text = requireString(value, label);
  requireCondition(pattern.test(text), `${label} is invalid`);
  return text;
}

function requireString(value, label) {
  requireCondition(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string`,
  );
  return value;
}

function requireObject(value, label) {
  requireCondition(isObject(value), `${label} must be an object`);
  return value;
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(requireObject(value, label)).sort();
  const expected = [...keys].sort();
  requireCondition(
    sameJson(actual, expected),
    `${label} fields drifted`,
  );
}

function allowedKeys(value, keys, label) {
  const allowed = new Set(keys);
  requireCondition(
    Object.keys(requireObject(value, label)).every((key) =>
      allowed.has(key),
    ),
    `${label} fields drifted`,
  );
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireCondition(condition, message) {
  if (!condition) throw new WormStagingCollectorError(message);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
