import {
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  projectJsonCompatibilityOperatorInvocation,
  projectJsonCompatibilityOperatorStatus,
  validateJsonCompatibilityOperatorInvocationReceipt,
  validateJsonCompatibilityOperatorStatusReceipt,
} from "./container_runtime_json_compatibility_operator_invocation.mjs";

export const JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-runner-invocation-receipt-v1";
export const JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-runner-status-receipt-v1";

const RUNNER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-runner-staging";
const RUNNER_ENTRYPOINT = "JsonCompatibilityCampaignRunnerEntrypoint";
const OPERATOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-operator-staging";
const OPERATOR_ENTRYPOINT = "JsonCompatibilityCampaignOperatorEntrypoint";
const SHA256 = /^[0-9a-f]{64}$/u;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const CLOCK_SKEW_MS = 5_000;

export function validateJsonCompatibilityRunnerInvocationReceipt(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const label = "[runner-invocation] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "runner", "operator",
    "authorizedPhaseRequest", "authorizedPhaseRequestSha256",
    "privateTransport", "operatorReceipt", "operatorReceiptSha256",
    "startedAt", "completedAt", "runnerBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "runner_phase_invocation_completed", `${label} status`);
  const common = validateRunnerCommon(
    validatedPlan,
    value,
    "JSON_COMPATIBILITY_RUNNER_ENABLED",
    "invokePhase",
    label,
  );
  const operatorReceipt = validateJsonCompatibilityOperatorInvocationReceipt(
    validatedPlan,
    value.operatorReceipt,
  );
  bindRunnerToOperator(value, operatorReceipt, common, label, "direct");
  validateRunnerDigests(value, label);
  return value;
}

export function validateJsonCompatibilityRunnerStatusReceipt(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const label = "[runner-status] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "runner", "operator",
    "authorizedPhaseRequest", "authorizedPhaseRequestSha256",
    "privateTransport", "operatorStatusReceipt",
    "operatorStatusReceiptSha256", "recovery", "startedAt", "completedAt",
    "runnerBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "runner_phase_status_observed", `${label} status`);
  equal(value.phaseStatus, "completed", `${label} completed status`);
  const common = validateRunnerCommon(
    validatedPlan,
    value,
    "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
    "getPhaseStatus",
    label,
  );
  const operatorReceipt = validateJsonCompatibilityOperatorStatusReceipt(
    validatedPlan,
    value.operatorStatusReceipt,
  );
  equal(
    value.phaseStatus,
    operatorReceipt.phaseStatus,
    `${label} nested phase status`,
  );
  bindRunnerToOperator(value, operatorReceipt, common, label, "status");
  const recovery = record(value.recovery, `${label} recovery`);
  exactKeys(recovery, [
    "mode", "executionRetryPermitted", "operatorInvokePhaseCalled",
    "originalRunnerReceiptReconstructed",
  ], `${label} recovery`);
  equal(recovery.mode, "read-only-status-recovery", `${label} recovery mode`);
  equal(recovery.executionRetryPermitted, false, `${label} retry permission`);
  equal(recovery.operatorInvokePhaseCalled, false, `${label} invoke call`);
  equal(
    recovery.originalRunnerReceiptReconstructed,
    false,
    `${label} original receipt reconstruction`,
  );
  validateRunnerDigests(value, label);
  return value;
}

export function resolveJsonCompatibilityRunnerCompletion(plan, input) {
  const value = record(input, "[runner] receipt");
  if (value.contract === JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT) {
    const runnerReceipt = validateJsonCompatibilityRunnerInvocationReceipt(
      plan,
      value,
    );
    const operatorReceipt = validateJsonCompatibilityOperatorInvocationReceipt(
      plan,
      runnerReceipt.operatorReceipt,
    );
    return {
      mode: "direct",
      runnerReceipt,
      operatorReceipt,
      privateInvocationReceipt: operatorReceipt.privateInvocationReceipt,
    };
  }
  if (value.contract === JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT) {
    const runnerReceipt = validateJsonCompatibilityRunnerStatusReceipt(
      plan,
      value,
    );
    const operatorReceipt = validateJsonCompatibilityOperatorStatusReceipt(
      plan,
      runnerReceipt.operatorStatusReceipt,
    );
    return {
      mode: "recovered-status",
      runnerReceipt,
      operatorReceipt,
      privateInvocationReceipt:
        operatorReceipt.privateInvocationStatusReceipt.result
          .privateInvocationReceipt,
    };
  }
  failure("[runner] receipt contract is unsupported");
}

export function projectJsonCompatibilityRunnerCompletion(resolved) {
  const receipt = resolved.runnerReceipt;
  const operator = resolved.operatorReceipt;
  return {
    contract: receipt.contract,
    mode: resolved.mode,
    receiptSha256: receipt.receiptSha256,
    runnerBodySha256: receipt.runnerBodySha256,
    operatorReceiptSha256: resolved.mode === "direct"
      ? receipt.operatorReceiptSha256
      : receipt.operatorStatusReceiptSha256,
    recoveredPrivateInvocationReceiptSha256: resolved.mode === "direct"
      ? operator.privateInvocationReceiptSha256
      : operator.privateInvocationStatusReceipt.result
        .privateInvocationReceiptSha256,
    authorizedPhaseRequestSha256: receipt.authorizedPhaseRequestSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    phaseStatus: resolved.mode === "direct" ? "completed" : receipt.phaseStatus,
    runner: clone(receipt.runner),
    operator: clone(receipt.operator),
    privateTransport: clone(receipt.privateTransport),
    completion: {
      mode: resolved.mode,
      executionRetryPermitted: false,
      operatorInvokePhaseCalled: resolved.mode === "direct",
      originalRunnerReceiptAvailable: resolved.mode === "direct",
    },
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

export function projectJsonCompatibilityResolvedOperator(resolved) {
  return resolved.mode === "direct"
    ? projectJsonCompatibilityOperatorInvocation(resolved.operatorReceipt)
    : projectJsonCompatibilityOperatorStatus(resolved.operatorReceipt);
}

function validateRunnerCommon(plan, value, gateName, rpcMethod, label) {
  equal(value.environment, "staging", `${label} environment`);
  equal(value.campaignIdSha256, plan.campaignIdSha256, `${label} campaign ID`);
  equal(value.planDigestSha256, plan.planDigestSha256, `${label} plan digest`);
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4, `${label} phase ordinal`);
  const phase = plan.phases[phaseOrdinal - 1];
  equal(value.phaseId, phase.id, `${label} phase ID`);
  if (typeof value.phaseExecutionId !== "string" || value.phaseExecutionId.length === 0) {
    failure(`${label} phase execution ID is invalid`);
  }
  const plannedRunner = record(plan.privateServices?.runner, `${label} planned runner`);
  const runner = record(value.runner, `${label} runner`);
  exactKeys(runner, [
    "serviceName", "entrypoint", "versionId", "configSha256", "gateName",
    "privateRpcOnly",
  ], `${label} runner`);
  for (const [name, expected] of [
    ["serviceName", RUNNER_SERVICE],
    ["entrypoint", RUNNER_ENTRYPOINT],
    ["versionId", plannedRunner.versionId],
    ["configSha256", plannedRunner.configSha256],
    ["gateName", gateName],
    ["privateRpcOnly", true],
  ]) equal(runner[name], expected, `${label} runner ${name}`);
  const operator = record(value.operator, `${label} operator`);
  exactKeys(
    operator,
    ["serviceName", "entrypoint", "versionId"],
    `${label} operator`,
  );
  const plannedOperator = record(
    plan.privateServices?.operator,
    `${label} planned operator`,
  );
  for (const [name, expected] of [
    ["serviceName", OPERATOR_SERVICE],
    ["entrypoint", OPERATOR_ENTRYPOINT],
    ["versionId", plannedOperator.versionId],
  ]) equal(operator[name], expected, `${label} operator ${name}`);
  sha256(value.authorizedPhaseRequestSha256, `${label} authorized request digest`);
  equal(
    value.authorizedPhaseRequestSha256,
    sha256Canonical(value.authorizedPhaseRequest),
    `${label} authorized request digest`,
  );
  const transport = record(value.privateTransport, `${label} transport`);
  exactKeys(transport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "operatorBinding",
    "rpcMethod",
  ], `${label} transport`);
  for (const [name, expected] of [
    ["kind", "service-binding-rpc"],
    ["publicUrlUsed", false],
    ["cloudflareRestUsed", false],
    ["operatorBinding", "JSON_COMPATIBILITY_OPERATOR_SERVICE"],
    ["rpcMethod", rpcMethod],
  ]) equal(transport[name], expected, `${label} transport ${name}`);
  const startedAt = wholeSecond(value.startedAt, `${label} start`);
  const completedAt = wholeSecond(value.completedAt, `${label} completion`);
  if (completedAt < startedAt) failure(`${label} completion precedes start`);
  return { startedAt, completedAt };
}

function bindRunnerToOperator(value, operator, common, label, mode) {
  const authorized = record(
    value.authorizedPhaseRequest,
    `${label} authorized request`,
  );
  exactKeys(
    authorized,
    ["schemaVersion", "contract", "request", "approval"],
    `${label} authorized request`,
  );
  canonicalEqual(authorized.request, operator.request, `${label} operator request`);
  canonicalEqual(
    authorized.approval,
    operator.authorization.approvalEnvelope,
    `${label} approval envelope`,
  );
  const nestedField = mode === "direct"
    ? "operatorReceipt"
    : "operatorStatusReceipt";
  const digestField = mode === "direct"
    ? "operatorReceiptSha256"
    : "operatorStatusReceiptSha256";
  sha256(value[digestField], `${label} nested receipt digest`);
  equal(
    value[digestField],
    sha256Canonical(value[nestedField]),
    `${label} nested receipt digest`,
  );
  for (const name of [
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId",
  ]) equal(value[name], operator[name], `${label} nested ${name}`);
  const operatorStart = wholeSecond(
    mode === "direct" ? operator.startedAt : operator.queryStartedAt,
    `${label} nested start`,
  );
  const operatorCompleted = wholeSecond(
    mode === "direct" ? operator.completedAt : operator.queryCompletedAt,
    `${label} nested completion`,
  );
  if (
    common.startedAt > operatorStart + CLOCK_SKEW_MS
    || common.completedAt + CLOCK_SKEW_MS < operatorCompleted
  ) failure(`${label} must enclose the Operator RPC`);
}

function validateRunnerDigests(value, label) {
  sha256(value.runnerBodySha256, `${label} body digest`);
  sha256(value.receiptSha256, `${label} receipt digest`);
  const { runnerBodySha256, receiptSha256, ...body } = value;
  equal(runnerBodySha256, sha256Canonical(body), `${label} body digest`);
  equal(
    receiptSha256,
    sha256Canonical({ ...body, runnerBodySha256 }),
    `${label} receipt digest`,
  );
}

function wholeSecond(value, label) {
  if (
    typeof value !== "string"
    || !WHOLE_SECOND_UTC.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) failure(`${label} must be a whole-second UTC timestamp`);
  return Date.parse(value);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failure(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    failure(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    failure(`${label} does not match`);
  }
}

function exactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) failure(`${label} fields are invalid`);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failure(`${label} must be an object`);
  }
  return value;
}

function equal(actual, expected, label) {
  if (!Object.is(actual, expected)) failure(`${label} does not match`);
}

function clone(value) {
  return structuredClone(value);
}

function failure(message) {
  throw new Error(message);
}
