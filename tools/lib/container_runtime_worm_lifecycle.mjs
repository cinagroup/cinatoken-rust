import { createHash } from "node:crypto";
import {
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  canonicalJson,
} from "./container_runtime_worm_staging.mjs";

export const WORM_LIFECYCLE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-worm-lock-revocation-phase-receipt-v1";
export const WORM_LIFECYCLE_SCHEMA_VERSION = 1;
export const LIFECYCLE_OPERATOR_TOKEN_ENV =
  "CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN";
export const LIFECYCLE_VERIFIER_TOKEN_ENV =
  "CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN";
export const LIFECYCLE_TARGET_TOKEN_ID_ENV =
  "CINATOKEN_WORM_LIFECYCLE_TARGET_API_TOKEN_ID";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const CF_RAY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_TYPE_PATTERN =
  /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS = 3_600;
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export class WormLifecycleCollectorError extends Error {}

export function describeLifecycleCollector() {
  return {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    defaultMode: "dry-run",
    writesFiles: false,
    phases: [
      {
        phase: "revoke",
        mutation: true,
        credentialRole: "lifecycle-operator",
        credentialEnvironment: [
          LIFECYCLE_OPERATOR_TOKEN_ENV,
          LIFECYCLE_TARGET_TOKEN_ID_ENV,
        ],
        predecessorContract: WORM_STAGING_RECEIPT_CONTRACT,
        requests: [
          "GET lifecycle-operator-token-verify",
          "DELETE lock-operator-token",
          "GET lock-operator-token operator-readback",
        ],
      },
      {
        phase: "verify",
        mutation: false,
        credentialRole: "lifecycle-verifier",
        credentialEnvironment: [
          LIFECYCLE_VERIFIER_TOKEN_ENV,
          LIFECYCLE_TARGET_TOKEN_ID_ENV,
        ],
        predecessorContract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
        requests: [
          "GET lifecycle-verifier-token-verify",
          "GET lock-operator-token independent-readback",
        ],
      },
    ],
    downstreamAuthority: downstreamAuthority(),
  };
}

export function readLifecycleCredentials(phase, env) {
  const targetTokenId = requirePattern(
    env[LIFECYCLE_TARGET_TOKEN_ID_ENV],
    TOKEN_ID_PATTERN,
    `[credentials] ${LIFECYCLE_TARGET_TOKEN_ID_ENV}`,
  );
  if (phase === "revoke") {
    const apiToken = requireCredential(
      env[LIFECYCLE_OPERATOR_TOKEN_ENV],
      LIFECYCLE_OPERATOR_TOKEN_ENV,
    );
    requireCondition(
      apiToken !== targetTokenId,
      "[credentials] lifecycle operator token and target ID must differ",
    );
    return { apiToken, targetTokenId };
  }
  if (phase === "verify") {
    const apiToken = requireCredential(
      env[LIFECYCLE_VERIFIER_TOKEN_ENV],
      LIFECYCLE_VERIFIER_TOKEN_ENV,
    );
    requireCondition(
      apiToken !== targetTokenId,
      "[credentials] lifecycle verifier token and target ID must differ",
    );
    return { apiToken, targetTokenId };
  }
  throw new WormLifecycleCollectorError(
    "[credentials] unsupported lifecycle phase",
  );
}

export function normalizeLockPredecessor(options) {
  const accountId = requirePattern(
    options.accountId,
    ACCOUNT_ID_PATTERN,
    "[input] account ID",
  );
  const receiptText = requireCanonicalReceipt(
    options.receipt,
    options.receiptText,
    "lock predecessor",
  );
  const receipt = requireObject(options.receipt, "[predecessor] lock receipt");
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
      "phaseMutationConfirmed",
      "mutationPerformed",
      "target",
      "credential",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] lock receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_STAGING_SCHEMA_VERSION &&
      receipt.contract === WORM_STAGING_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-staging-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "lock" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.phaseMutationConfirmed === true &&
      receipt.mutationPerformed === true,
    "[predecessor] lock receipt authority is invalid",
  );
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] lock capture time",
  );
  const target = validateLockTarget(receipt.target, accountId);
  const credential = validateLockCredential(receipt.credential);
  requireCondition(
    credential.selfVerifiedAt <= capturedAt &&
      capturedAt < credential.expiresAt,
    "[predecessor] lock credential chronology is invalid",
  );
  const facts = validateLockFacts(
    receipt.facts,
    target,
    capturedAt,
    credential,
  );
  validateLockOperations(receipt.providerOperations, facts);
  validateStagingLimits(receipt.limits);
  requireAllDownstreamFalse(receipt.downstreamAuthority, "lock");
  return {
    accountId,
    ...target,
    targetRole: "lock-operator",
    targetCredentialIdSha256: credential.credentialIdSha256,
    lockReceiptSha256: sha256(receiptText),
    lockCapturedAt: capturedAt,
    lockConfiguredAt: facts.configuredAt,
    lockConfigurationRequestId: facts.configurationRequestId,
    lockSelectedRuleId: facts.selectedRuleId,
    lockRules: facts.rules,
  };
}

export function normalizeRevokePredecessor(options) {
  const accountId = requirePattern(
    options.accountId,
    ACCOUNT_ID_PATTERN,
    "[input] account ID",
  );
  const receiptText = requireCanonicalReceipt(
    options.receipt,
    options.receiptText,
    "revoke predecessor",
  );
  const receipt = requireObject(
    options.receipt,
    "[predecessor] revoke receipt",
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
      "phaseMutationConfirmed",
      "mutationPerformed",
      "target",
      "authority",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] revoke receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_LIFECYCLE_SCHEMA_VERSION &&
      receipt.contract === WORM_LIFECYCLE_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-lifecycle-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "revoke" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.phaseMutationConfirmed === true &&
      receipt.mutationPerformed === true,
    "[predecessor] revoke receipt authority is invalid",
  );
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] revoke capture time",
  );
  const target = validateLifecycleTarget(receipt.target, accountId);
  const authority = validateLifecycleAuthority(
    receipt.authority,
    "lifecycle-operator",
    "cloudflare-account-api-token-read-edit",
  );
  requireCondition(
    authority.credentialIdSha256 !== target.targetCredentialIdSha256,
    "[predecessor] lifecycle operator and target identities overlap",
  );
  const facts = requireObject(receipt.facts, "[predecessor] revoke facts");
  exactKeys(
    facts,
    [
      "apiSurface",
      "deletedAt",
      "deletionHttpStatus",
      "deletionRequestId",
      "deletionResultIdSha256",
      "operatorReadbackAt",
      "operatorReadbackErrorCodes",
      "operatorReadbackHttpStatus",
      "operatorReadbackRequestId",
      "operatorReadbackResponseBodySha256",
      "targetAbsentAfterDelete",
    ],
    "[predecessor] revoke facts",
  );
  const deletedAt = requireCanonicalTimestamp(
    facts.deletedAt,
    "[predecessor] revoke deletion time",
  );
  const operatorReadbackAt = requireCanonicalTimestamp(
    facts.operatorReadbackAt,
    "[predecessor] revoke readback time",
  );
  requireCondition(
    facts.apiSurface === "cloudflare-account-token-api" &&
      target.lockCapturedAt < authority.selfVerifiedAt &&
      authority.selfVerifiedAt < deletedAt &&
      deletedAt < operatorReadbackAt &&
      operatorReadbackAt === capturedAt &&
      capturedAt < authority.expiresAt &&
      facts.deletionHttpStatus === 200 &&
      CF_RAY_PATTERN.test(facts.deletionRequestId) &&
      facts.deletionResultIdSha256 ===
        target.targetCredentialIdSha256 &&
      facts.operatorReadbackHttpStatus === 404 &&
      CF_RAY_PATTERN.test(facts.operatorReadbackRequestId) &&
      SHA256_PATTERN.test(facts.operatorReadbackResponseBodySha256) &&
      validErrorCodes(facts.operatorReadbackErrorCodes) &&
      facts.targetAbsentAfterDelete === true,
    "[predecessor] revoke facts are invalid",
  );
  validateRevokeOperations(receipt.providerOperations, facts);
  validateLifecycleLimits(receipt.limits);
  requireAllDownstreamFalse(receipt.downstreamAuthority, "revoke");
  return {
    accountId,
    ...target,
    lifecycleOperatorCredentialIdSha256:
      authority.credentialIdSha256,
    operatorReadbackErrorCodes: facts.operatorReadbackErrorCodes,
    revokeReceiptSha256: sha256(receiptText),
    revokeCapturedAt: capturedAt,
  };
}

export function buildLifecycleDryRunReceipt(phase, target) {
  requirePhase(phase);
  return {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
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
    target: publicLifecycleTarget(target),
    requestPlan:
      phase === "revoke"
        ? [
            "GET lifecycle-operator-token-verify",
            "DELETE lock-operator-token",
            "GET lock-operator-token operator-readback",
          ]
        : [
            "GET lifecycle-verifier-token-verify",
            "GET lock-operator-token independent-readback",
          ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

export async function revokeLockOperator(options) {
  const {
    target,
    credentials,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = options;
  requireCondition(
    typeof fetchImpl === "function",
    "[revoke] fetch implementation is unavailable",
  );
  requireTargetCredential(target, credentials.targetTokenId);
  const preflight = await requestCloudflareJson({
    url: tokenVerificationUrl(target.accountId),
    apiToken: credentials.apiToken,
    sensitiveValues: [
      credentials.apiToken,
      target.accountId,
    ],
    method: "GET",
    label: "lifecycle-operator-preflight",
    expectedStatus: 200,
    fetchImpl,
  });
  const selfVerifiedAt = requireTimestamp(
    now(),
    "[revoke] operator verification time",
  );
  const authorityIdentity = validateTokenVerification(
    preflight.result,
    selfVerifiedAt,
    "lifecycle-operator-preflight",
  );
  requireCondition(
    authorityIdentity.credentialIdSha256 !==
      target.targetCredentialIdSha256,
    "[revoke] lifecycle operator and target identities must differ",
  );
  const deletion = await requestCloudflareJson({
    url: tokenResourceUrl(target.accountId, credentials.targetTokenId),
    apiToken: credentials.apiToken,
    sensitiveValues: [
      credentials.apiToken,
      target.accountId,
    ],
    method: "DELETE",
    label: "lock-operator-delete",
    expectedStatus: 200,
    fetchImpl,
  });
  validateDeletionResult(deletion.result, credentials.targetTokenId);
  const deletedAt = requireTimestamp(now(), "[revoke] deletion time");
  const operatorReadback = await requestCloudflareJson({
    url: tokenResourceUrl(target.accountId, credentials.targetTokenId),
    apiToken: credentials.apiToken,
    sensitiveValues: [
      credentials.apiToken,
      credentials.targetTokenId,
      target.accountId,
    ],
    method: "GET",
    label: "operator-revocation-readback",
    expectedStatus: 404,
    fetchImpl,
  });
  const operatorReadbackAt = requireTimestamp(
    now(),
    "[revoke] operator readback time",
  );
  requireCondition(
    target.lockCapturedAt < selfVerifiedAt &&
      selfVerifiedAt < deletedAt &&
      deletedAt < operatorReadbackAt &&
      operatorReadbackAt < authorityIdentity.expiresAt,
    "[revoke] lifecycle chronology is invalid",
  );
  const receipt = {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    phase: "revoke",
    mode: "live",
    ok: true,
    capturedAt: operatorReadbackAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target: publicLifecycleTarget(target),
    authority: authorityReceipt(
      "lifecycle-operator",
      "cloudflare-account-api-token-read-edit",
      authorityIdentity,
      selfVerifiedAt,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      deletedAt,
      deletionHttpStatus: deletion.httpStatus,
      deletionRequestId: deletion.providerRequestId,
      deletionResultIdSha256: sha256(credentials.targetTokenId),
      operatorReadbackAt,
      operatorReadbackErrorCodes: operatorReadback.errorCodes,
      operatorReadbackHttpStatus: operatorReadback.httpStatus,
      operatorReadbackRequestId: operatorReadback.providerRequestId,
      operatorReadbackResponseBodySha256:
        operatorReadback.responseBodySha256,
      targetAbsentAfterDelete: true,
    },
    providerOperations: [
      operationReceipt(
        "GET",
        "lifecycle-operator-preflight",
        preflight,
      ),
      operationReceipt("DELETE", "lock-operator-delete", deletion),
      operationReceipt(
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

export async function verifyLockOperatorRevocation(options) {
  const {
    target,
    credentials,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = options;
  requireCondition(
    typeof fetchImpl === "function",
    "[verify] fetch implementation is unavailable",
  );
  requireTargetCredential(target, credentials.targetTokenId);
  const preflight = await requestCloudflareJson({
    url: tokenVerificationUrl(target.accountId),
    apiToken: credentials.apiToken,
    sensitiveValues: [
      credentials.apiToken,
      target.accountId,
    ],
    method: "GET",
    label: "lifecycle-verifier-preflight",
    expectedStatus: 200,
    fetchImpl,
  });
  const selfVerifiedAt = requireTimestamp(
    now(),
    "[verify] verifier verification time",
  );
  const authorityIdentity = validateTokenVerification(
    preflight.result,
    selfVerifiedAt,
    "lifecycle-verifier-preflight",
  );
  requireCondition(
    authorityIdentity.credentialIdSha256 !==
        target.targetCredentialIdSha256 &&
      authorityIdentity.credentialIdSha256 !==
        target.lifecycleOperatorCredentialIdSha256,
    "[verify] lifecycle verifier identity is not independent",
  );
  const independentReadback = await requestCloudflareJson({
    url: tokenResourceUrl(target.accountId, credentials.targetTokenId),
    apiToken: credentials.apiToken,
    sensitiveValues: [
      credentials.apiToken,
      credentials.targetTokenId,
      target.accountId,
    ],
    method: "GET",
    label: "independent-revocation-readback",
    expectedStatus: 404,
    fetchImpl,
  });
  const independentReadbackAt = requireTimestamp(
    now(),
    "[verify] independent readback time",
  );
  requireCondition(
    target.revokeCapturedAt < selfVerifiedAt &&
      selfVerifiedAt < independentReadbackAt &&
      independentReadbackAt < authorityIdentity.expiresAt,
    "[verify] lifecycle chronology is invalid",
  );
  requireCondition(
    canonicalJson(independentReadback.errorCodes) ===
      canonicalJson(target.operatorReadbackErrorCodes),
    "[verify] independent absence error codes drifted",
  );
  const receipt = {
    schemaVersion: WORM_LIFECYCLE_SCHEMA_VERSION,
    contract: WORM_LIFECYCLE_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    phase: "verify",
    mode: "live",
    ok: true,
    capturedAt: independentReadbackAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target: publicLifecycleTarget(target),
    authority: authorityReceipt(
      "lifecycle-verifier",
      "cloudflare-account-api-token-read",
      authorityIdentity,
      selfVerifiedAt,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      independentReadbackAt,
      independentReadbackErrorCodes: independentReadback.errorCodes,
      independentReadbackHttpStatus: independentReadback.httpStatus,
      independentReadbackRequestId:
        independentReadback.providerRequestId,
      independentReadbackResponseBodySha256:
        independentReadback.responseBodySha256,
      operatorAndVerifierCredentialIdsDistinct: true,
      targetAbsenceIndependentlyObserved: true,
    },
    providerOperations: [
      operationReceipt(
        "GET",
        "lifecycle-verifier-preflight",
        preflight,
      ),
      operationReceipt(
        "GET",
        "independent-revocation-readback",
        independentReadback,
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

function validateLockTarget(value, accountId) {
  const target = requireObject(value, "[predecessor] lock target");
  exactKeys(
    target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
    ],
    "[predecessor] lock target",
  );
  requireCondition(
    target.accountIdSha256 === sha256(accountId) &&
      typeof target.bucketName === "string" &&
      target.bucketName.length > 0 &&
      typeof target.jurisdiction === "string" &&
      target.jurisdiction.length > 0 &&
      typeof target.prefix === "string" &&
      target.prefix.length > 0 &&
      SHA256_PATTERN.test(target.statementSha256),
    "[predecessor] lock target drifted",
  );
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
  };
}

function validateLockCredential(value) {
  const credential = requireObject(
    value,
    "[predecessor] lock credential",
  );
  exactKeys(
    credential,
    [
      "role",
      "credentialType",
      "credentialIdSha256",
      "selfVerifiedAt",
      "expiresAt",
      "remainingLifetimeSeconds",
    ],
    "[predecessor] lock credential",
  );
  const selfVerifiedAt = requireCanonicalTimestamp(
    credential.selfVerifiedAt,
    "[predecessor] lock credential verification time",
  );
  const expiresAt = requireCanonicalTimestamp(
    credential.expiresAt,
    "[predecessor] lock credential expiry",
  );
  const remainingLifetimeMs =
    Date.parse(expiresAt) - Date.parse(selfVerifiedAt);
  requireCondition(
    credential.role === "lock-operator" &&
      credential.credentialType ===
        "cloudflare-r2-admin-read-write-api-token" &&
      SHA256_PATTERN.test(credential.credentialIdSha256) &&
      remainingLifetimeMs >= 1_000 &&
      remainingLifetimeMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000 &&
      Number.isSafeInteger(credential.remainingLifetimeSeconds) &&
      credential.remainingLifetimeSeconds ===
        Math.floor(remainingLifetimeMs / 1_000),
    "[predecessor] lock credential is invalid",
  );
  return {
    ...credential,
    selfVerifiedAt,
    expiresAt,
  };
}

function validateLockFacts(
  value,
  target,
  capturedAt,
  credential,
) {
  const facts = requireObject(value, "[predecessor] lock facts");
  exactKeys(
    facts,
    [
      "mechanism",
      "awsS3ObjectLockHeadersUsed",
      "configuredAt",
      "configurationRequestId",
      "observedAt",
      "readbackRequestId",
      "httpStatus",
      "selectedRuleId",
      "rules",
      "preconfigurationRequestId",
      "preexistingRuleCount",
      "unrelatedRulesPreserved",
    ],
    "[predecessor] lock facts",
  );
  const configuredAt = requireCanonicalTimestamp(
    facts.configuredAt,
    "[predecessor] lock configured time",
  );
  const observedAt = requireCanonicalTimestamp(
    facts.observedAt,
    "[predecessor] lock observed time",
  );
  requireCondition(
    facts.mechanism === "cloudflare-r2-bucket-lock-api" &&
      facts.awsS3ObjectLockHeadersUsed === false &&
      credential.selfVerifiedAt <= configuredAt &&
      configuredAt <= observedAt &&
      observedAt === capturedAt &&
      capturedAt < credential.expiresAt &&
      facts.httpStatus === 200 &&
      CF_RAY_PATTERN.test(facts.configurationRequestId) &&
      CF_RAY_PATTERN.test(facts.readbackRequestId) &&
      CF_RAY_PATTERN.test(facts.preconfigurationRequestId) &&
      Number.isSafeInteger(facts.preexistingRuleCount) &&
      facts.preexistingRuleCount >= 0 &&
      facts.preexistingRuleCount < 1_000 &&
      facts.unrelatedRulesPreserved === true &&
      Array.isArray(facts.rules) &&
      facts.rules.length === facts.preexistingRuleCount + 1 &&
      facts.rules.length <= 1_000,
    "[predecessor] lock facts are invalid",
  );
  const ids = new Set();
  const rules = facts.rules.map((rule) =>
    validateLockRule(rule, "[predecessor] lock"),
  );
  for (const rule of rules) {
    requireCondition(
      !ids.has(rule.id),
      "[predecessor] lock rule ID is duplicated",
    );
    ids.add(rule.id);
  }
  const expectedRuleId = `cinatoken-s3-${target.statementSha256.slice(0, 24)}`;
  const selected = rules.find((rule) => rule.id === facts.selectedRuleId);
  requireCondition(
    facts.selectedRuleId === expectedRuleId &&
      selected !== undefined &&
      selected.enabled === true &&
      selected.prefix === target.prefix &&
      selected.condition.type === "Age" &&
      selected.condition.maxAgeSeconds >= 31_536_000,
    "[predecessor] selected lock rule drifted",
  );
  return {
    ...facts,
    configuredAt,
    observedAt,
    rules,
  };
}

function validateLockRule(value, label) {
  const rule = requireObject(value, `${label} rule`);
  exactKeys(
    rule,
    ["condition", "enabled", "id", "prefix"],
    `${label} rule`,
  );
  requireCondition(
    RULE_ID_PATTERN.test(rule.id) &&
      typeof rule.enabled === "boolean" &&
      typeof rule.prefix === "string" &&
      rule.prefix.length <= 512,
    `${label} rule identity is invalid`,
  );
  const condition = requireObject(rule.condition, `${label} condition`);
  if (condition.type === "Age") {
    exactKeys(
      condition,
      ["maxAgeSeconds", "type"],
      `${label} age condition`,
    );
    requireCondition(
      Number.isSafeInteger(condition.maxAgeSeconds) &&
        condition.maxAgeSeconds > 0,
      `${label} age duration is invalid`,
    );
  } else if (condition.type === "Date") {
    exactKeys(condition, ["date", "type"], `${label} date condition`);
    requireCanonicalTimestamp(condition.date, `${label} date condition`);
  } else if (condition.type === "Indefinite") {
    exactKeys(condition, ["type"], `${label} indefinite condition`);
  } else {
    throw new WormLifecycleCollectorError(
      `${label} condition type is unsupported`,
    );
  }
  return rule;
}

function validateLockOperations(value, facts) {
  requireCondition(
    Array.isArray(value) && value.length === 4,
    "[predecessor] lock operations are incomplete",
  );
  const expected = [
    ["GET", "credential-preflight", null],
    ["GET", "lock-before", facts.preconfigurationRequestId],
    ["PUT", "lock-configure", facts.configurationRequestId],
    ["GET", "lock-after", facts.readbackRequestId],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const operation = validateStagingOperation(
      value[index],
      `[predecessor] lock operation ${index}`,
    );
    const [method, name, requestId] = expected[index];
    requireCondition(
      operation.method === method &&
        operation.operation === name &&
        operation.httpStatus === 200 &&
        (requestId === null ||
          operation.providerRequestId === requestId),
      "[predecessor] lock operation drifted",
    );
  }
}

function validateStagingOperation(value, label) {
  const operation = requireObject(value, label);
  exactKeys(
    operation,
    ["method", "operation", "httpStatus", "providerRequestId"],
    label,
  );
  requireCondition(
    typeof operation.method === "string" &&
      typeof operation.operation === "string" &&
      operation.httpStatus === 200 &&
      CF_RAY_PATTERN.test(operation.providerRequestId),
    `${label} is invalid`,
  );
  return operation;
}

function validateStagingLimits(value) {
  const limits = requireObject(value, "[predecessor] lock limits");
  exactKeys(
    limits,
    [
      "requestTimeoutMs",
      "responseBytes",
      "mutableCredentialRemainingSeconds",
      "listPages",
      "listItems",
      "lockRules",
    ],
    "[predecessor] lock limits",
  );
  requireCondition(
    limits.requestTimeoutMs === REQUEST_TIMEOUT_MS &&
      limits.responseBytes === MAX_RESPONSE_BYTES &&
      limits.mutableCredentialRemainingSeconds ===
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS &&
      limits.listPages === 1_000 &&
      limits.listItems === 10_000 &&
      limits.lockRules === 1_000,
    "[predecessor] lock limits drifted",
  );
}

function validateRevokeOperations(value, facts) {
  requireCondition(
    Array.isArray(value) && value.length === 3,
    "[predecessor] revoke operations are incomplete",
  );
  const expected = [
    ["GET", "lifecycle-operator-preflight", 200, null, null],
    [
      "DELETE",
      "lock-operator-delete",
      200,
      facts.deletionRequestId,
      null,
    ],
    [
      "GET",
      "operator-revocation-readback",
      404,
      facts.operatorReadbackRequestId,
      facts.operatorReadbackResponseBodySha256,
    ],
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const operation = requireObject(
      value[index],
      `[predecessor] revoke operation ${index}`,
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
      `[predecessor] revoke operation ${index}`,
    );
    const [method, name, status, requestId, bodySha256] = expected[index];
    requireCondition(
      operation.method === method &&
        operation.operation === name &&
        operation.httpStatus === status &&
        CF_RAY_PATTERN.test(operation.providerRequestId) &&
        SHA256_PATTERN.test(operation.responseBodySha256) &&
        (requestId === null ||
          operation.providerRequestId === requestId) &&
        (bodySha256 === null ||
          operation.responseBodySha256 === bodySha256),
      "[predecessor] revoke operation drifted",
    );
  }
}

function validateLifecycleLimits(value) {
  const limits = requireObject(value, "[predecessor] revoke limits");
  exactKeys(
    limits,
    [
      "requestTimeoutMs",
      "responseBytes",
      "predecessorReceiptBytes",
      "mutableCredentialRemainingSeconds",
    ],
    "[predecessor] revoke limits",
  );
  requireCondition(
    limits.requestTimeoutMs === REQUEST_TIMEOUT_MS &&
      limits.responseBytes === MAX_RESPONSE_BYTES &&
      limits.predecessorReceiptBytes === MAX_RECEIPT_BYTES &&
      limits.mutableCredentialRemainingSeconds ===
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS,
    "[predecessor] revoke limits drifted",
  );
}

function validateLifecycleTarget(value, accountId) {
  const target = requireObject(value, "[predecessor] lifecycle target");
  exactKeys(
    target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
      "targetRole",
      "targetCredentialIdSha256",
      "lockReceiptSha256",
      "lockCapturedAt",
    ],
    "[predecessor] lifecycle target",
  );
  requireCondition(
    target.accountIdSha256 === sha256(accountId) &&
      target.targetRole === "lock-operator" &&
      SHA256_PATTERN.test(target.targetCredentialIdSha256) &&
      SHA256_PATTERN.test(target.lockReceiptSha256) &&
      typeof target.bucketName === "string" &&
      target.bucketName.length > 0 &&
      typeof target.jurisdiction === "string" &&
      target.jurisdiction.length > 0 &&
      typeof target.prefix === "string" &&
      target.prefix.length > 0 &&
      SHA256_PATTERN.test(target.statementSha256),
    "[predecessor] lifecycle target drifted",
  );
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
    targetRole: target.targetRole,
    targetCredentialIdSha256: target.targetCredentialIdSha256,
    lockReceiptSha256: target.lockReceiptSha256,
    lockCapturedAt: requireCanonicalTimestamp(
      target.lockCapturedAt,
      "[predecessor] lock capture time",
    ),
  };
}

function validateLifecycleAuthority(value, role, credentialType) {
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
    "[predecessor] authority verification time",
  );
  const expiresAt = requireCanonicalTimestamp(
    authority.expiresAt,
    "[predecessor] authority expiry",
  );
  const remainingLifetimeMs =
    Date.parse(expiresAt) - Date.parse(selfVerifiedAt);
  requireCondition(
    authority.role === role &&
      authority.credentialType === credentialType &&
      SHA256_PATTERN.test(authority.credentialIdSha256) &&
      remainingLifetimeMs >= 1_000 &&
      remainingLifetimeMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000 &&
      Number.isSafeInteger(authority.remainingLifetimeSeconds) &&
      authority.remainingLifetimeSeconds ===
        Math.floor(remainingLifetimeMs / 1_000),
    "[predecessor] lifecycle authority drifted",
  );
  return {
    ...authority,
    selfVerifiedAt,
    expiresAt,
  };
}

function requireCanonicalReceipt(value, text, label) {
  requireCondition(
    typeof text === "string" &&
      Buffer.byteLength(text, "utf8") >= 2 &&
      Buffer.byteLength(text, "utf8") <= MAX_RECEIPT_BYTES,
    `[predecessor] ${label} is outside its byte bound`,
  );
  requireCondition(
    text === `${canonicalJson(value)}\n`,
    `[predecessor] ${label} must be canonical JSON plus one newline`,
  );
  return text;
}

function requireAllDownstreamFalse(value, label) {
  const authority = requireObject(
    value,
    `[predecessor] ${label} downstream authority`,
  );
  exactKeys(
    authority,
    [
      "lockOperatorRevocationVerified",
      "publisherRevocationVerified",
      "wormRetentionVerified",
      "s3Complete",
      "formalP5Evidence",
      "customerTrafficAuthorized",
      "productionCutoverAuthorized",
    ],
    `[predecessor] ${label} downstream authority`,
  );
  requireCondition(
    Object.values(authority).every((entry) => entry === false),
    `[predecessor] ${label} overclaimed downstream authority`,
  );
}

function requireTargetCredential(target, targetTokenId) {
  requireCondition(
    TOKEN_ID_PATTERN.test(targetTokenId) &&
      sha256(targetTokenId) === target.targetCredentialIdSha256,
    "[credentials] target token ID does not match the predecessor",
  );
}

function authorityReceipt(role, credentialType, identity, selfVerifiedAt) {
  return {
    role,
    credentialType,
    credentialIdSha256: identity.credentialIdSha256,
    selfVerifiedAt,
    expiresAt: identity.expiresAt,
    remainingLifetimeSeconds: identity.remainingLifetimeSeconds,
  };
}

function publicLifecycleTarget(target) {
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
    targetRole: target.targetRole,
    targetCredentialIdSha256: target.targetCredentialIdSha256,
    lockReceiptSha256: target.lockReceiptSha256,
    lockCapturedAt: target.lockCapturedAt,
    ...(target.revokeReceiptSha256
      ? { revokeReceiptSha256: target.revokeReceiptSha256 }
      : {}),
    ...(target.revokeCapturedAt
      ? { revokeCapturedAt: target.revokeCapturedAt }
      : {}),
    ...(target.lifecycleOperatorCredentialIdSha256
      ? {
          lifecycleOperatorCredentialIdSha256:
            target.lifecycleOperatorCredentialIdSha256,
        }
      : {}),
    ...(target.operatorReadbackErrorCodes
      ? {
          operatorReadbackErrorCodes:
            target.operatorReadbackErrorCodes,
        }
      : {}),
  };
}

function operationReceipt(method, operation, response) {
  return {
    method,
    operation,
    httpStatus: response.httpStatus,
    providerRequestId: response.providerRequestId,
    responseBodySha256: response.responseBodySha256,
  };
}

function tokenVerificationUrl(accountId) {
  return `${CLOUDFLARE_API_BASE}/accounts/${accountId}/tokens/verify`;
}

function tokenResourceUrl(accountId, tokenId) {
  return `${CLOUDFLARE_API_BASE}/accounts/${accountId}/tokens/${tokenId}`;
}

async function requestCloudflareJson(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiToken}`,
        "User-Agent": "cinatoken-rust-worm-lifecycle-collector/1",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === "AbortError") {
      throw new WormLifecycleCollectorError(
        `[${options.label}] request timed out`,
      );
    }
    throw new WormLifecycleCollectorError(
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
        response.status === options.expectedStatus,
      `[${options.label}] provider status is not the expected result`,
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
    const bytes = await readBoundedResponse(
      response,
      options.label,
      controller,
    );
    for (const sensitive of options.sensitiveValues) {
      requireCondition(
        !bytes.includes(Buffer.from(sensitive, "utf8")),
        `[${options.label}] provider reflected sensitive input`,
      );
    }
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new WormLifecycleCollectorError(
        `[${options.label}] provider response was invalid JSON`,
      );
    }
    const validated =
      options.expectedStatus === 200
        ? validateSuccessEnvelope(envelope, options.label)
        : validateAbsenceEnvelope(envelope, options.label);
    return {
      ...validated,
      httpStatus: response.status,
      providerRequestId,
      responseBodySha256: sha256(bytes),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response, label, controller) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const length = Number(contentLength);
    requireCondition(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= MAX_RESPONSE_BYTES,
      `[${label}] response content length is invalid`,
    );
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      requireCondition(
        total <= MAX_RESPONSE_BYTES,
        `[${label}] response body exceeded its bound`,
      );
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof WormLifecycleCollectorError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new WormLifecycleCollectorError(
        `[${label}] response body timed out`,
      );
    }
    throw new WormLifecycleCollectorError(
      `[${label}] response body read failed`,
    );
  }
  return Buffer.concat(chunks, total);
}

function validateSuccessEnvelope(value, label) {
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
  return {
    result: requireObject(envelope.result, `[${label}] result`),
    errorCodes: [],
  };
}

function validateAbsenceEnvelope(value, label) {
  const envelope = requireObject(value, `[${label}] envelope`);
  exactKeys(
    envelope,
    ["errors", "messages", "result", "success"],
    `[${label}] envelope`,
  );
  requireCondition(
    envelope.success === false &&
      envelope.result === null &&
      Array.isArray(envelope.errors) &&
      envelope.errors.length === 1 &&
      Array.isArray(envelope.messages) &&
      envelope.messages.length === 0,
    `[${label}] absence envelope is invalid`,
  );
  const errorCodes = envelope.errors.map((entry) => {
    const error = requireObject(entry, `[${label}] provider error`);
    exactKeys(
      error,
      ["code", "message"],
      `[${label}] provider error`,
    );
    requireCondition(
      Number.isSafeInteger(error.code) &&
        typeof error.message === "string" &&
        error.message.length > 0 &&
        error.message.length <= 4096,
      `[${label}] provider error is invalid`,
    );
    return error.code;
  });
  requireCondition(
    validErrorCodes(errorCodes),
    `[${label}] provider error codes are invalid`,
  );
  return { result: null, errorCodes };
}

function validateTokenVerification(value, observedAt, label) {
  const verification = requireObject(value, `[${label}] token verification`);
  allowedKeys(
    verification,
    ["expires_on", "id", "not_before", "status"],
    `[${label}] token verification`,
  );
  requireCondition(
    TOKEN_ID_PATTERN.test(verification.id) &&
      verification.status === "active" &&
      typeof verification.expires_on === "string",
    `[${label}] token identity, status, or expiry is invalid`,
  );
  const observedMs = Date.parse(observedAt);
  const expiresAt = requireTimestamp(
    verification.expires_on,
    `[${label}] token expiry`,
  );
  const remainingLifetimeMs = Date.parse(expiresAt) - observedMs;
  requireCondition(
    remainingLifetimeMs >= 1_000 &&
      remainingLifetimeMs <=
        MAX_MUTABLE_CREDENTIAL_REMAINING_SECONDS * 1_000,
    `[${label}] credential lifetime is outside the bound`,
  );
  if (verification.not_before !== undefined) {
    const notBefore = requireTimestamp(
      verification.not_before,
      `[${label}] token not-before`,
    );
    requireCondition(
      Date.parse(notBefore) <= observedMs,
      `[${label}] token is not active yet`,
    );
  }
  return {
    credentialIdSha256: sha256(verification.id),
    expiresAt,
    remainingLifetimeSeconds: Math.floor(
      remainingLifetimeMs / 1_000,
    ),
  };
}

function validateDeletionResult(value, targetTokenId) {
  const result = requireObject(value, "[lock-operator-delete] result");
  exactKeys(result, ["id"], "[lock-operator-delete] result");
  requireCondition(
    result.id === targetTokenId,
    "[lock-operator-delete] provider deleted an unexpected token",
  );
}

function validErrorCodes(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every((entry) => Number.isSafeInteger(entry) && entry >= 0) &&
    new Set(value).size === value.length
  );
}

function collectorLimits() {
  return {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    responseBytes: MAX_RESPONSE_BYTES,
    predecessorReceiptBytes: MAX_RECEIPT_BYTES,
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

function assertSensitiveValuesAbsent(value, sensitiveValues) {
  const serialized = canonicalJson(value);
  for (const sensitive of sensitiveValues) {
    if (
      typeof sensitive === "string" &&
      sensitive.length > 0 &&
      serialized.includes(sensitive)
    ) {
      throw new WormLifecycleCollectorError(
        "[redaction] lifecycle receipt contained sensitive input",
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
    value === "revoke" || value === "verify",
    "[input] lifecycle phase must be revoke or verify",
  );
}

function requireTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  requireCondition(
    !Number.isNaN(date.getTime()),
    `${label} is not a timestamp`,
  );
  return date.toISOString();
}

function requireCanonicalTimestamp(value, label) {
  const normalized = requireTimestamp(value, label);
  requireCondition(
    typeof value === "string" && value === normalized,
    `${label} must be canonical UTC`,
  );
  return normalized;
}

function requirePattern(value, pattern, label) {
  requireCondition(
    typeof value === "string" && pattern.test(value),
    `${label} is invalid`,
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
    canonicalJson(actual) === canonicalJson(expected),
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

function requireCondition(condition, message) {
  if (!condition) throw new WormLifecycleCollectorError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
