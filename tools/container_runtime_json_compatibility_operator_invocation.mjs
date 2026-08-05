import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import {
  JsonCompatibilityCampaignError,
  JSON_COMPATIBILITY_PLAN_CONTRACT,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityPrivateInvocationReceipt,
} from "./container_runtime_json_compatibility_private_invocation.mjs";

export const JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-request-v1";
export const JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-authorized-phase-request-v1";
export const JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-subject-v1";
export const JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-envelope-v1";
export const JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v2";
export const JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-status-request-v1";
export const JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-status-receipt-v1";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-operator-phase-approval-v1\n";
export const JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER =
  "cinatoken-json-compatibility-campaign-approval-authority-staging";

const OPERATOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
const OPERATOR_ENTRYPOINT = "JsonCompatibilityCampaignOperatorEntrypoint";
const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const EXECUTE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-execute-phase-request-v2";
const COMMAND_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-operator-command-id-v1\n";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CLOCK_SKEW_MS = 5_000;
const APPROVAL_MAX_LIFETIME_SECONDS = 600;
const APPROVAL_MIN_REMAINING_SECONDS = 180;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function deriveJsonCompatibilityOperatorCommandIdSha256(
  request,
  operatorVersionId,
) {
  safeToken(operatorVersionId, "[operator-invocation] operator version");
  return createHash("sha256")
    .update(`${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${operatorVersionId}`, "utf8")
    .digest("hex");
}

export function validateJsonCompatibilityOperatorPhaseRequest(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const candidate = record(input, "[operator-invocation] request");
  const execution = record(
    candidate.execution,
    "[operator-invocation] request execution",
  );
  const phase = record(
    execution.phase,
    "[operator-invocation] request phase",
  );
  const ordinal = integer(
    phase.ordinal,
    1,
    validatedPlan.phases.length,
    "[operator-invocation] request phase ordinal",
  );
  return validateRequest(
    input,
    validatedPlan,
    validatedPlan.phases[ordinal - 1],
    "[operator-invocation]",
  );
}

export function validateJsonCompatibilityOperatorInvocationReceipt(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const label = "[operator-invocation] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "request", "requestSha256",
    "authorization",
    "commandIdSha256", "privateTransport", "privateInvocationReceipt",
    "privateInvocationReceiptSha256", "startedAt", "completedAt",
    "operatorBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "operator_phase_invocation_completed", `${label} status`);
  equal(value.environment, "staging", `${label} environment`);
  equal(value.campaignIdSha256, validatedPlan.campaignIdSha256, `${label} campaign ID`);
  equal(value.planDigestSha256, validatedPlan.planDigestSha256, `${label} plan digest`);
  sha256(value.campaignIdSha256, `${label} campaign ID`);
  sha256(value.planDigestSha256, `${label} plan digest`);
  safeToken(value.phaseExecutionId, `${label} phase execution ID`);
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4, `${label} phase ordinal`);
  const expectedPhase = validatedPlan.phases[phaseOrdinal - 1];
  equal(value.phaseId, expectedPhase?.id, `${label} phase ID`);

  const operator = validateOperator(value.operator, validatedPlan, label);
  const request = validateRequest(value.request, validatedPlan, expectedPhase, label);
  sha256(value.requestSha256, `${label} request digest`);
  equal(value.requestSha256, sha256Canonical(request), `${label} request digest`);
  sha256(value.commandIdSha256, `${label} command ID`);
  equal(
    value.commandIdSha256,
    deriveJsonCompatibilityOperatorCommandIdSha256(request, operator.versionId),
    `${label} command ID`,
  );
  const startedAt = wholeSecond(value.startedAt, `${label} start`);
  validateOperatorAuthorization(
    value.authorization,
    validatedPlan,
    request,
    operator,
    value.requestSha256,
    value.commandIdSha256,
    startedAt,
    label,
  );
  validatePrivateTransport(value.privateTransport, label);

  const privateInvocation = validateJsonCompatibilityPrivateInvocationReceipt(
    validatedPlan,
    value.privateInvocationReceipt,
  );
  sha256(
    value.privateInvocationReceiptSha256,
    `${label} private invocation raw digest`,
  );
  equal(
    value.privateInvocationReceiptSha256,
    sha256Canonical(privateInvocation),
    `${label} private invocation raw digest`,
  );
  bindRequestToPrivateInvocation(
    request,
    value,
    privateInvocation,
    validatedPlan,
    label,
  );

  const completedAt = wholeSecond(value.completedAt, `${label} completion`);
  const privateStartedAt = wholeSecond(
    privateInvocation.startedAt,
    `${label} private invocation start`,
  );
  const privateCompletedAt = wholeSecond(
    privateInvocation.completedAt,
    `${label} private invocation completion`,
  );
  if (
    completedAt < startedAt
    || startedAt > privateStartedAt + CLOCK_SKEW_MS
    || completedAt + CLOCK_SKEW_MS < privateCompletedAt
  ) {
    failure(`${label} must enclose the private invocation`);
  }

  sha256(value.operatorBodySha256, `${label} body digest`);
  sha256(value.receiptSha256, `${label} canonical digest`);
  const receiptBody = {
    schemaVersion: value.schemaVersion,
    contract: value.contract,
    status: value.status,
    environment: value.environment,
    campaignIdSha256: value.campaignIdSha256,
    planDigestSha256: value.planDigestSha256,
    phaseExecutionId: value.phaseExecutionId,
    phaseOrdinal: value.phaseOrdinal,
    phaseId: value.phaseId,
    operator: value.operator,
    authorization: value.authorization,
    request: value.request,
    requestSha256: value.requestSha256,
    commandIdSha256: value.commandIdSha256,
    privateTransport: value.privateTransport,
    privateInvocationReceipt: value.privateInvocationReceipt,
    privateInvocationReceiptSha256: value.privateInvocationReceiptSha256,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  };
  equal(
    value.operatorBodySha256,
    sha256Canonical(receiptBody),
    `${label} body digest`,
  );
  const { receiptSha256, ...receiptSubject } = value;
  equal(
    receiptSha256,
    sha256Canonical(receiptSubject),
    `${label} canonical digest`,
  );
  return value;
}

export function projectJsonCompatibilityOperatorInvocation(receipt) {
  return {
    contract: receipt.contract,
    receiptSha256: receipt.receiptSha256,
    rawReceiptSha256: sha256Canonical(receipt),
    operatorBodySha256: receipt.operatorBodySha256,
    privateInvocationReceiptSha256:
      receipt.privateInvocationReceiptSha256,
    requestSha256: receipt.requestSha256,
    commandIdSha256: receipt.commandIdSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    operator: structuredClone(receipt.operator),
    authorization: {
      contract: receipt.authorization.contract,
      approvalEnvelopeSha256:
        receipt.authorization.approvalEnvelopeSha256,
      approvalSubjectSha256:
        receipt.authorization.approvalSubjectSha256,
      issuer: receipt.authorization.issuer,
      audience: receipt.authorization.audience,
      keyId: receipt.authorization.keyId,
      signerSpkiSha256: receipt.authorization.signerSpkiSha256,
      caller: structuredClone(receipt.authorization.caller),
      issuedAt: receipt.authorization.issuedAt,
      notBefore: receipt.authorization.notBefore,
      expiresAt: receipt.authorization.expiresAt,
    },
    privateTransport: structuredClone(receipt.privateTransport),
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

export function validateJsonCompatibilityOperatorStatusReceipt(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  if (
    validatedPlan.contract !== JSON_COMPATIBILITY_PLAN_CONTRACT
    || validatedPlan.statusRecovery?.mode !== "read-only-status-recovery"
  ) {
    failure("[operator-status] plan does not authorize status recovery");
  }
  const recoveryPolicy = validatedPlan.statusRecovery;
  const label = "[operator-status] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "authorization", "request",
    "requestSha256", "commandIdSha256", "statusQuery", "statusQuerySha256",
    "privateTransport", "privateInvocationStatusReceipt",
    "privateInvocationStatusReceiptSha256", "recovery", "queryStartedAt",
    "queryCompletedAt", "operatorBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "operator_phase_status_observed", `${label} status`);
  equal(value.phaseStatus, "completed", `${label} completed status`);
  equal(value.environment, "staging", `${label} environment`);
  equal(value.campaignIdSha256, validatedPlan.campaignIdSha256, `${label} campaign ID`);
  equal(value.planDigestSha256, validatedPlan.planDigestSha256, `${label} plan digest`);
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4, `${label} phase ordinal`);
  const expectedPhase = validatedPlan.phases[phaseOrdinal - 1];
  equal(value.phaseId, expectedPhase.id, `${label} phase ID`);
  safeToken(value.phaseExecutionId, `${label} phase execution ID`);
  const operator = validateOperator(
    value.operator,
    validatedPlan,
    label,
    "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
  );
  const request = validateRequest(value.request, validatedPlan, expectedPhase, label);
  equal(value.phaseExecutionId, request.execution.phaseExecutionId, `${label} execution ID`);
  sha256(value.requestSha256, `${label} request digest`);
  equal(value.requestSha256, sha256Canonical(request), `${label} request digest`);
  sha256(value.commandIdSha256, `${label} command ID`);
  equal(
    value.commandIdSha256,
    deriveJsonCompatibilityOperatorCommandIdSha256(request, operator.versionId),
    `${label} command ID`,
  );
  const queryStartedAt = wholeSecond(value.queryStartedAt, `${label} query start`);
  const authorization = validateOperatorAuthorization(
    value.authorization,
    validatedPlan,
    request,
    operator,
    value.requestSha256,
    value.commandIdSha256,
    queryStartedAt,
    label,
    "status",
  );
  const query = validateStatusQuery(
    value.statusQuery,
    request,
    value.requestSha256,
    value.commandIdSha256,
    authorization.approvalEnvelopeSha256,
    operator.versionId,
    recoveryPolicy,
    label,
  );
  equal(value.statusQuerySha256, sha256Canonical(query), `${label} status query digest`);
  const transport = record(value.privateTransport, `${label} transport`);
  exactKeys(transport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "invokerBinding",
    "rpcMethod",
  ], `${label} transport`);
  equal(transport.kind, "service-binding-rpc", `${label} transport kind`);
  equal(transport.publicUrlUsed, false, `${label} public URL`);
  equal(transport.cloudflareRestUsed, false, `${label} REST use`);
  equal(transport.invokerBinding, "JSON_COMPATIBILITY_INVOKER_SERVICE", `${label} binding`);
  equal(transport.rpcMethod, "getPhaseStatus", `${label} RPC method`);

  const queryCompletedAt = wholeSecond(
    value.queryCompletedAt,
    `${label} query completion`,
  );
  if (queryCompletedAt < queryStartedAt) {
    failure(`${label} completion precedes start`);
  }

  const privateStatus = validatePrivateInvocationStatusReceipt(
    validatedPlan,
    value.privateInvocationStatusReceipt,
    query,
    request,
    value.commandIdSha256,
    queryStartedAt,
    queryCompletedAt,
    recoveryPolicy,
    label,
  );
  equal(
    value.privateInvocationStatusReceiptSha256,
    sha256Canonical(privateStatus),
    `${label} private status raw digest`,
  );
  const recovery = record(value.recovery, `${label} recovery`);
  exactKeys(recovery, [
    "mode", "executionRetryPermitted", "invokePhaseCalled",
    "permitIssuerCalled", "executorCalled", "originalOperatorReceiptReconstructed",
  ], `${label} recovery`);
  equal(recovery.mode, "read-only-status-recovery", `${label} recovery mode`);
  for (const name of [
    "executionRetryPermitted", "invokePhaseCalled", "permitIssuerCalled",
    "executorCalled", "originalOperatorReceiptReconstructed",
  ]) equal(recovery[name], false, `${label} recovery ${name}`);
  sha256(value.operatorBodySha256, `${label} body digest`);
  sha256(value.receiptSha256, `${label} receipt digest`);
  const { operatorBodySha256, receiptSha256, ...body } = value;
  equal(operatorBodySha256, sha256Canonical(body), `${label} body digest`);
  equal(
    receiptSha256,
    sha256Canonical({ ...body, operatorBodySha256 }),
    `${label} receipt digest`,
  );
  return value;
}

export function projectJsonCompatibilityOperatorStatus(receipt) {
  const result = receipt.privateInvocationStatusReceipt.result;
  return {
    contract: receipt.contract,
    receiptSha256: receipt.receiptSha256,
    rawReceiptSha256: sha256Canonical(receipt),
    operatorBodySha256: receipt.operatorBodySha256,
    privateInvocationStatusReceiptSha256:
      receipt.privateInvocationStatusReceiptSha256,
    recoveredPrivateInvocationReceiptSha256:
      result.privateInvocationReceiptSha256,
    requestSha256: receipt.requestSha256,
    commandIdSha256: receipt.commandIdSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    phaseStatus: receipt.phaseStatus,
    operator: structuredClone(receipt.operator),
    authorization: {
      contract: receipt.authorization.contract,
      approvalEnvelopeSha256: receipt.authorization.approvalEnvelopeSha256,
      approvalSubjectSha256: receipt.authorization.approvalSubjectSha256,
      issuer: receipt.authorization.issuer,
      audience: receipt.authorization.audience,
      keyId: receipt.authorization.keyId,
      signerSpkiSha256: receipt.authorization.signerSpkiSha256,
      caller: structuredClone(receipt.authorization.caller),
      issuedAt: receipt.authorization.issuedAt,
      notBefore: receipt.authorization.notBefore,
      expiresAt: receipt.authorization.expiresAt,
    },
    statusQuerySha256: receipt.statusQuerySha256,
    privateTransport: structuredClone(receipt.privateTransport),
    recovery: structuredClone(receipt.recovery),
    startedAt: receipt.queryStartedAt,
    completedAt: receipt.queryCompletedAt,
  };
}

function validateStatusQuery(
  input,
  request,
  requestSha256,
  commandIdSha256,
  approvalEnvelopeSha256,
  operatorVersionId,
  recoveryPolicy,
  label,
) {
  const query = record(input, `${label} status query`);
  exactKeys(query, ["schemaVersion", "contract", "subject", "authority"], `${label} status query`);
  equal(query.schemaVersion, 1, `${label} status query schema`);
  equal(
    query.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-status-query-v1",
    `${label} status query contract`,
  );
  const subject = record(query.subject, `${label} status query subject`);
  exactKeys(subject, [
    "schemaVersion", "contract", "statusQueryIdSha256", "target",
  ], `${label} status query subject`);
  equal(subject.schemaVersion, 1, `${label} status subject schema`);
  equal(
    subject.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-status-query-subject-v1",
    `${label} status subject contract`,
  );
  const target = record(subject.target, `${label} status target`);
  exactKeys(target, [
    "schemaVersion", "contract", "campaignIdSha256", "planDigestSha256",
    "phaseOrdinal", "phaseId", "phaseExecutionId", "commandIdSha256",
    "operatorRequestSha256", "approvalEnvelopeSha256", "operatorVersionId",
    "invokerVersionId",
  ], `${label} status target`);
  equal(target.schemaVersion, 1, `${label} status target schema`);
  equal(
    target.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-status-target-v1",
    `${label} status target contract`,
  );
  for (const [name, expected] of [
    ["campaignIdSha256", request.execution.campaignIdSha256],
    ["planDigestSha256", request.execution.planDigestSha256],
    ["phaseOrdinal", request.execution.phase.ordinal],
    ["phaseId", request.execution.phase.id],
    ["phaseExecutionId", request.execution.phaseExecutionId],
    ["commandIdSha256", commandIdSha256],
    ["operatorRequestSha256", requestSha256],
    ["approvalEnvelopeSha256", approvalEnvelopeSha256],
    ["operatorVersionId", operatorVersionId],
    ["invokerVersionId", request.invoker.versionId],
  ]) equal(target[name], expected, `${label} status target ${name}`);
  const authority = record(query.authority, `${label} status authority`);
  exactKeys(authority, [
    "schemaVersion", "contract", "algorithm", "keyId", "claims",
    "claimsSha256", "signatureBase64url",
  ], `${label} status authority`);
  equal(authority.schemaVersion, 1, `${label} status authority schema`);
  equal(
    authority.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-status-authority-envelope-v1",
    `${label} status authority contract`,
  );
  equal(authority.algorithm, "HMAC-SHA-256", `${label} status authority algorithm`);
  if (!KEY_ID.test(authority.keyId)) failure(`${label} status key ID is invalid`);
  equal(
    authority.keyId,
    recoveryPolicy.statusAuthority.status.keyId,
    `${label} planned status key ID`,
  );
  if (typeof authority.signatureBase64url !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(authority.signatureBase64url)) {
    failure(`${label} status signature is invalid`);
  }
  const claims = record(authority.claims, `${label} status claims`);
  exactKeys(claims, [
    "schemaVersion", "contract", "issuer", "audience", "credentialIdSha256",
    "statusQueryIdSha256", "statusQuerySubjectSha256", "issuedAt", "expiresAt",
  ], `${label} status claims`);
  equal(claims.schemaVersion, 1, `${label} status claims schema`);
  equal(
    claims.contract,
    "cinatoken-container-runtime-json-compatibility-invocation-status-authority-claims-v1",
    `${label} status claims contract`,
  );
  equal(
    claims.issuer,
    recoveryPolicy.statusAuthority.status.issuer,
    `${label} planned status issuer`,
  );
  equal(
    claims.audience,
    recoveryPolicy.statusAuthority.status.audience,
    `${label} planned status audience`,
  );
  sha256(claims.credentialIdSha256, `${label} status credential`);
  equal(
    claims.credentialIdSha256,
    recoveryPolicy.statusAuthority.status.credentialIdSha256,
    `${label} planned status credential digest`,
  );
  equal(claims.statusQueryIdSha256, subject.statusQueryIdSha256, `${label} status query ID`);
  equal(
    claims.statusQuerySubjectSha256,
    sha256Canonical(subject),
    `${label} status subject digest`,
  );
  equal(authority.claimsSha256, sha256Canonical(claims), `${label} status claims digest`);
  integer(claims.issuedAt, 1, Number.MAX_SAFE_INTEGER, `${label} status issued time`);
  equal(
    claims.expiresAt,
    claims.issuedAt + recoveryPolicy.statusQueryLifetimeSeconds,
    `${label} status expiry`,
  );
  const expectedQueryId = createHash("sha256")
    .update(
      `cinatoken-container-runtime-json-compatibility-invocation-status-query-id-v1\n${canonicalJson(target)}\n${claims.issuedAt}`,
      "utf8",
    )
    .digest("hex");
  equal(subject.statusQueryIdSha256, expectedQueryId, `${label} status query ID`);
  return query;
}

function validatePrivateInvocationStatusReceipt(
  plan,
  input,
  expectedQuery,
  request,
  commandIdSha256,
  queryStartedAt,
  queryCompletedAt,
  recoveryPolicy,
  label,
) {
  const value = record(input, `${label} private status receipt`);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment", "target", "query",
    "queryAuthority", "invoker", "privateTransport", "result", "queriedAt",
    "receiptSha256",
  ], `${label} private status receipt`);
  equal(value.schemaVersion, 1, `${label} private status schema`);
  equal(
    value.contract,
    "cinatoken-container-runtime-json-compatibility-private-invocation-status-receipt-v1",
    `${label} private status contract`,
  );
  equal(value.status, "private_invocation_status_resolved", `${label} private status`);
  equal(value.environment, "staging", `${label} private status environment`);
  canonicalEqual(value.target, expectedQuery.subject.target, `${label} private status target`);
  canonicalEqual(value.query, expectedQuery, `${label} private status query`);
  const queryAuthority = record(
    value.queryAuthority,
    `${label} private status authority`,
  );
  exactKeys(queryAuthority, [
    "issuer", "audience", "keyId", "credentialIdSha256",
    "statusQueryIdSha256", "statusQuerySubjectSha256", "claimsSha256",
    "authorityEnvelopeSha256", "issuedAt", "expiresAt",
  ], `${label} private status authority`);
  const claims = expectedQuery.authority.claims;
  for (const [name, expected] of [
    ["issuer", claims.issuer],
    ["audience", claims.audience],
    ["keyId", expectedQuery.authority.keyId],
    ["credentialIdSha256", claims.credentialIdSha256],
    ["statusQueryIdSha256", expectedQuery.subject.statusQueryIdSha256],
    ["statusQuerySubjectSha256", sha256Canonical(expectedQuery.subject)],
    ["claimsSha256", expectedQuery.authority.claimsSha256],
    ["authorityEnvelopeSha256", sha256Canonical(expectedQuery.authority)],
    ["issuedAt", claims.issuedAt],
    ["expiresAt", claims.expiresAt],
  ]) equal(queryAuthority[name], expected, `${label} private status authority ${name}`);
  const invoker = record(value.invoker, `${label} private status invoker`);
  exactKeys(invoker, ["serviceName", "versionId", "gateName"], `${label} private status invoker`);
  equal(invoker.serviceName, INVOKER_SERVICE, `${label} private status invoker service`);
  equal(invoker.versionId, request.invoker.versionId, `${label} private status invoker version`);
  equal(invoker.gateName, "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED", `${label} private status gate`);
  const privateTransport = record(
    value.privateTransport,
    `${label} private status transport`,
  );
  exactKeys(privateTransport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed",
    "invocationAuthorityBinding",
  ], `${label} private status transport`);
  equal(privateTransport.kind, "service-binding-rpc", `${label} private status transport kind`);
  equal(privateTransport.publicUrlUsed, false, `${label} private status public URL`);
  equal(privateTransport.cloudflareRestUsed, false, `${label} private status REST use`);
  equal(
    privateTransport.invocationAuthorityBinding,
    "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
    `${label} private status authority binding`,
  );
  const result = record(value.result, `${label} private status result`);
  exactKeys(result, [
    "status", "attempt", "completion", "privateInvocationReceipt",
    "privateInvocationReceiptSha256", "recoveredFromPersistedAuthority",
    "retryPermitted", "executionRpcRepeated",
  ], `${label} private status result`);
  equal(result.status, "completed", `${label} private status completion`);
  equal(result.recoveredFromPersistedAuthority, true, `${label} persisted recovery`);
  equal(result.retryPermitted, false, `${label} retry permission`);
  equal(result.executionRpcRepeated, false, `${label} execution repetition`);
  const privateInvocation = validateJsonCompatibilityPrivateInvocationReceipt(
    plan,
    result.privateInvocationReceipt,
  );
  equal(
    result.privateInvocationReceiptSha256,
    sha256Canonical(privateInvocation),
    `${label} recovered private digest`,
  );
  equal(privateInvocation.command.subject.commandIdSha256, commandIdSha256, `${label} recovered command`);
  canonicalEqual(result.attempt, privateInvocation.invocationAuthority.attempt, `${label} recovered attempt`);
  canonicalEqual(result.completion, privateInvocation.invocationAuthority.completion, `${label} recovered completion`);
  const queriedAt = wholeSecond(
    value.queriedAt,
    `${label} private status query time`,
  );
  const clockSkewMs = recoveryPolicy.clockSkewSeconds * 1000;
  if (
    queriedAt + clockSkewMs < queryStartedAt
    || queriedAt > queryCompletedAt + clockSkewMs
    || queriedAt + clockSkewMs < claims.issuedAt * 1000
    || queriedAt > claims.expiresAt * 1000 + clockSkewMs
  ) {
    failure(`${label} private status query time is outside the enclosing query`);
  }
  sha256(value.receiptSha256, `${label} private status receipt digest`);
  const { receiptSha256, ...subject } = value;
  equal(receiptSha256, sha256Canonical(subject), `${label} private status receipt digest`);
  return value;
}

function validateOperatorAuthorization(
  input,
  plan,
  request,
  operator,
  requestSha256,
  commandIdSha256,
  startedAtMs,
  label,
  purpose = "invoke",
) {
  const authorization = record(input, `${label} authorization`);
  exactKeys(authorization, [
    "contract",
    "approvalEnvelope",
    "approvalEnvelopeSha256",
    "approvalSubjectSha256",
    "issuer",
    "audience",
    "keyId",
    "signerSpkiSha256",
    "caller",
    "issuedAt",
    "notBefore",
    "expiresAt",
  ], `${label} authorization`);
  equal(
    authorization.contract,
    purpose === "status"
      ? JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT
      : JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    `${label} authorization contract`,
  );
  const envelope = record(
    authorization.approvalEnvelope,
    `${label} approval envelope`,
  );
  exactKeys(envelope, [
    "schemaVersion",
    "contract",
    "algorithm",
    "subject",
    "subjectSha256",
    "signerSpkiBase64url",
    "signatureBase64url",
  ], `${label} approval envelope`);
  equal(envelope.schemaVersion, 1, `${label} approval envelope schema`);
  equal(
    envelope.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
    `${label} approval envelope contract`,
  );
  equal(envelope.algorithm, "Ed25519", `${label} approval algorithm`);
  const subject = validateApprovalSubject(
    envelope.subject,
    plan,
    request,
    operator,
    requestSha256,
    commandIdSha256,
    label,
  );
  sha256(envelope.subjectSha256, `${label} approval subject digest`);
  equal(
    envelope.subjectSha256,
    sha256Canonical(subject),
    `${label} approval subject digest`,
  );
  const spki = base64urlBytes(
    envelope.signerSpkiBase64url,
    512,
    `${label} approval SPKI`,
  );
  const signature = base64urlBytes(
    envelope.signatureBase64url,
    64,
    `${label} approval signature`,
    64,
  );
  const signerSpkiSha256 = createHash("sha256").update(spki).digest("hex");
  equal(
    signerSpkiSha256,
    plan.operatorApproval.signerSpkiSha256,
    `${label} planned approval SPKI`,
  );
  let publicKey;
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    failure(`${label} approval SPKI is malformed`);
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || !verifySignature(
      null,
      Buffer.from(
        `${JSON_COMPATIBILITY_OPERATOR_APPROVAL_SIGNATURE_DOMAIN}${canonicalJson(subject)}`,
        "utf8",
      ),
      publicKey,
      signature,
    )
  ) {
    failure(`${label} approval signature is invalid`);
  }
  sha256(
    authorization.approvalEnvelopeSha256,
    `${label} approval envelope digest`,
  );
  equal(
    authorization.approvalEnvelopeSha256,
    sha256Canonical(envelope),
    `${label} approval envelope digest`,
  );
  for (const [name, expected] of [
    ["approvalSubjectSha256", envelope.subjectSha256],
    ["issuer", subject.issuer],
    ["audience", subject.audience],
    ["keyId", subject.keyId],
    ["signerSpkiSha256", signerSpkiSha256],
    ["issuedAt", subject.issuedAt],
    ["notBefore", subject.notBefore],
    ["expiresAt", subject.expiresAt],
  ]) equal(authorization[name], expected, `${label} authorization ${name}`);
  canonicalEqual(
    authorization.caller,
    subject.caller,
    `${label} authorization caller`,
  );
  const clockSkewSeconds = purpose === "status"
    ? plan.statusRecovery.clockSkewSeconds
    : CLOCK_SKEW_MS / 1000;
  const clockSkewMs = clockSkewSeconds * 1000;
  const approvalMaxLifetimeSeconds =
    plan.operatorApproval?.maxLifetimeSeconds ?? APPROVAL_MAX_LIFETIME_SECONDS;
  const approvalMinimumRemainingSeconds =
    plan.operatorApproval?.minimumRemainingLifetimeSeconds
    ?? APPROVAL_MIN_REMAINING_SECONDS;
  if (
    subject.issuedAt * 1000 > startedAtMs + clockSkewMs
    || subject.notBefore * 1000 > startedAtMs + clockSkewMs
    || subject.notBefore < subject.issuedAt - clockSkewSeconds
    || subject.expiresAt <= subject.notBefore
    || subject.expiresAt - subject.issuedAt > approvalMaxLifetimeSeconds
    || (purpose === "invoke" && subject.expiresAt * 1000 - startedAtMs
      < approvalMinimumRemainingSeconds * 1000)
    || (purpose === "status" && startedAtMs - subject.expiresAt * 1000
      > plan.statusRecovery.approvalRecoveryWindowSeconds * 1000)
  ) {
    failure(`${label} approval time window is invalid`);
  }
  return authorization;
}

function validateApprovalSubject(
  input,
  plan,
  request,
  operator,
  requestSha256,
  commandIdSha256,
  label,
) {
  const subject = record(input, `${label} approval subject`);
  exactKeys(subject, [
    "schemaVersion", "contract", "environment", "issuer", "audience",
    "keyId", "operator", "caller", "campaignIdSha256",
    "planDigestSha256", "phaseExecutionId", "phaseOrdinal", "phaseId",
    "requestSha256", "commandIdSha256", "topologyReadbackSha256",
    "beforeContextSha256", "issuedAt", "notBefore", "expiresAt",
  ], `${label} approval subject`);
  equal(subject.schemaVersion, 1, `${label} approval subject schema`);
  equal(
    subject.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
    `${label} approval subject contract`,
  );
  equal(subject.environment, "staging", `${label} approval environment`);
  equal(subject.issuer, plan.operatorApproval.issuer, `${label} approval issuer`);
  equal(subject.audience, plan.operatorApproval.audience, `${label} approval audience`);
  equal(subject.keyId, plan.operatorApproval.keyId, `${label} approval key ID`);
  if (!KEY_ID.test(subject.keyId)) failure(`${label} approval key ID is invalid`);
  canonicalEqual(subject.operator, {
    serviceName: OPERATOR_SERVICE,
    versionId: operator.versionId,
  }, `${label} approval operator`);
  canonicalEqual(
    subject.caller,
    plan.privateServices.runner,
    `${label} approval caller`,
  );
  for (const [name, expected] of [
    ["campaignIdSha256", request.execution.campaignIdSha256],
    ["planDigestSha256", request.execution.planDigestSha256],
    ["phaseExecutionId", request.execution.phaseExecutionId],
    ["phaseOrdinal", request.execution.phase.ordinal],
    ["phaseId", request.execution.phase.id],
    ["requestSha256", requestSha256],
    ["commandIdSha256", commandIdSha256],
    ["topologyReadbackSha256", request.topologyReadbackSha256],
    ["beforeContextSha256", request.beforeContextSha256],
  ]) equal(subject[name], expected, `${label} approval ${name}`);
  for (const name of ["issuedAt", "notBefore", "expiresAt"]) {
    integer(subject[name], 0, Number.MAX_SAFE_INTEGER, `${label} approval ${name}`);
  }
  return subject;
}

function validateOperator(
  input,
  plan,
  label,
  expectedGate = "JSON_COMPATIBILITY_OPERATOR_ENABLED",
) {
  const value = record(input, `${label} operator`);
  exactKeys(
    value,
    ["serviceName", "versionId", "gateName"],
    `${label} operator`,
  );
  equal(value.serviceName, OPERATOR_SERVICE, `${label} operator service`);
  safeToken(value.versionId, `${label} operator version`);
  equal(
    value.gateName,
    expectedGate,
    `${label} operator gate`,
  );
  const planned = record(
    plan.privateServices?.operator,
    `${label} planned operator`,
  );
  equal(planned.serviceName, OPERATOR_SERVICE, `${label} planned operator service`);
  equal(planned.entrypoint, OPERATOR_ENTRYPOINT, `${label} planned operator entrypoint`);
  equal(value.versionId, planned.versionId, `${label} operator version`);
  if (expectedGate === "JSON_COMPATIBILITY_OPERATOR_ENABLED") {
    equal(value.gateName, planned.gateName, `${label} operator gate`);
  }
  equal(planned.privateRpcOnly, true, `${label} operator private RPC`);
  return value;
}

function validateRequest(input, plan, expectedPhase, label) {
  const value = record(input, `${label} request`);
  exactKeys(value, [
    "schemaVersion", "contract", "execution", "executor", "invoker",
    "topologyReadbackSha256", "beforeContextSha256",
  ], `${label} request`);
  equal(value.schemaVersion, 1, `${label} request schema`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT,
    `${label} request contract`,
  );
  const execution = record(value.execution, `${label} request execution`);
  exactKeys(execution, [
    "schemaVersion", "contract", "kind", "environment", "campaignIdSha256",
    "planDigestSha256", "phaseExecutionId", "controller", "runtimes", "ring",
    "phase",
  ], `${label} request execution`);
  equal(execution.schemaVersion, 2, `${label} execution schema`);
  equal(execution.contract, EXECUTE_REQUEST_CONTRACT, `${label} execution contract`);
  equal(
    execution.kind,
    "container-runtime-json-compatibility-phase-execution",
    `${label} execution kind`,
  );
  equal(execution.environment, "staging", `${label} execution environment`);
  equal(execution.campaignIdSha256, plan.campaignIdSha256, `${label} execution campaign`);
  equal(execution.planDigestSha256, plan.planDigestSha256, `${label} execution plan`);
  safeToken(execution.phaseExecutionId, `${label} execution ID`);
  canonicalEqual(execution.controller, {
    serviceName: plan.controller.serviceName,
    versionId: plan.controller.versionId,
    configSha256: plan.controller.configSha256,
  }, `${label} Controller identity`);
  canonicalEqual(execution.runtimes, plan.runtimes, `${label} runtime identities`);
  canonicalEqual(execution.ring, plan.ring, `${label} ring`);
  canonicalEqual(execution.phase, {
    ordinal: expectedPhase.ordinal,
    id: expectedPhase.id,
    topology: expectedPhase.topology,
  }, `${label} phase`);

  const executor = validateServiceIdentity(
    value.executor,
    EXECUTOR_SERVICE,
    plan.privateServices?.executor,
    `${label} executor`,
  );
  const invoker = validateServiceIdentity(
    value.invoker,
    INVOKER_SERVICE,
    plan.privateServices?.invoker,
    `${label} invoker`,
  );
  sha256(value.topologyReadbackSha256, `${label} topology readback`);
  sha256(value.beforeContextSha256, `${label} before context`);
  return {
    schemaVersion: value.schemaVersion,
    contract: value.contract,
    execution,
    executor,
    invoker,
    topologyReadbackSha256: value.topologyReadbackSha256,
    beforeContextSha256: value.beforeContextSha256,
  };
}

function validateServiceIdentity(input, serviceName, plannedInput, label) {
  const value = record(input, label);
  exactKeys(value, ["serviceName", "versionId"], label);
  equal(value.serviceName, serviceName, `${label} service`);
  safeToken(value.versionId, `${label} version`);
  const planned = record(plannedInput, `${label} planned identity`);
  equal(value.serviceName, planned.serviceName, `${label} planned service`);
  equal(value.versionId, planned.versionId, `${label} planned version`);
  return value;
}

function validatePrivateTransport(input, label) {
  const value = record(input, `${label} private transport`);
  exactKeys(
    value,
    ["kind", "publicUrlUsed", "cloudflareRestUsed", "invokerBinding"],
    `${label} private transport`,
  );
  equal(value.kind, "service-binding-rpc", `${label} transport kind`);
  equal(value.publicUrlUsed, false, `${label} public URL`);
  equal(value.cloudflareRestUsed, false, `${label} Cloudflare REST`);
  equal(
    value.invokerBinding,
    "JSON_COMPATIBILITY_INVOKER_SERVICE",
    `${label} invoker binding`,
  );
}

function bindRequestToPrivateInvocation(
  request,
  operatorReceipt,
  invocation,
  plan,
  label,
) {
  const intent = invocation.command.subject.issueIntent;
  canonicalEqual(request.execution, intent.execution, `${label} execution binding`);
  canonicalEqual(request.executor, intent.executor, `${label} executor binding`);
  canonicalEqual(request.invoker, intent.invoker, `${label} invoker binding`);
  equal(
    request.topologyReadbackSha256,
    intent.topologyReadbackSha256,
    `${label} topology readback binding`,
  );
  equal(
    request.beforeContextSha256,
    intent.beforeContextSha256,
    `${label} before context binding`,
  );
  equal(
    operatorReceipt.commandIdSha256,
    invocation.command.subject.commandIdSha256,
    `${label} command binding`,
  );
  equal(
    intent.authorizationIdSha256,
    operatorReceipt.commandIdSha256,
    `${label} authorization binding`,
  );
  for (const name of [
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId",
  ]) {
    const invocationValue = name === "phaseOrdinal"
      ? invocation.phaseOrdinal
      : name === "phaseId"
        ? invocation.phaseId
        : invocation[name];
    equal(operatorReceipt[name], invocationValue, `${label} ${name} binding`);
  }
  equal(
    invocation.invoker.versionId,
    plan.privateServices.invoker.versionId,
    `${label} planned invoker version`,
  );
  equal(
    invocation.permitIssueReceipt.issuer.versionId,
    plan.privateServices.permitIssuer.versionId,
    `${label} planned permit issuer version`,
  );
  equal(
    invocation.executorReceipt.executor.versionId,
    plan.privateServices.executor.versionId,
    `${label} planned executor version`,
  );
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) failure(`${label} mismatch`);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failure(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length) failure(`${label} has unexpected fields`);
  for (let index = 0; index < wanted.length; index += 1) {
    if (actual[index] !== wanted[index]) failure(`${label} has unexpected fields`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) failure(`${label} mismatch`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    failure(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    failure(`${label} must be a safe token`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failure(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function wholeSecond(value, label) {
  if (typeof value !== "string" || !WHOLE_SECOND_UTC.test(value)) {
    failure(`${label} must be whole-second UTC`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    failure(`${label} must be canonical whole-second UTC`);
  }
  return parsed;
}

function base64urlBytes(value, maximumBytes, label, exactBytes = undefined) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    failure(`${label} must be canonical base64url`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    failure(`${label} must be canonical base64url`);
  }
  if (
    bytes.length === 0
    || bytes.length > maximumBytes
    || (exactBytes !== undefined && bytes.length !== exactBytes)
    || bytes.toString("base64url") !== value
  ) {
    failure(`${label} must be canonical bounded base64url`);
  }
  return bytes;
}

function failure(message) {
  throw new JsonCompatibilityCampaignError(message);
}
