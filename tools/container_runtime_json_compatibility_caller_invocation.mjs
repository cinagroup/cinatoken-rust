import {
  JSON_COMPATIBILITY_PLAN_CONTRACT,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  projectJsonCompatibilityRunnerCompletion,
  resolveJsonCompatibilityRunnerCompletion,
  validateJsonCompatibilityRunnerInvocationReceipt,
  validateJsonCompatibilityRunnerStatusReceipt,
} from "./container_runtime_json_compatibility_runner_invocation.mjs";

export const JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-invocation-receipt-v1";
export const JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-status-receipt-v1";

const CALLER_STATUS_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-phase-status-request-v1";
const CALLER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-caller-staging";
const CALLER_ENTRYPOINT = "JsonCompatibilityCampaignCallerEntrypoint";
const RUNNER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-runner-staging";
const RUNNER_ENTRYPOINT = "JsonCompatibilityCampaignRunnerEntrypoint";
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const CLOCK_SKEW_MS = 5_000;

export function validateJsonCompatibilityCallerInvocationReceipt(
  plan,
  input,
  expectedCaller,
) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  requireCurrentCallerPlan(validatedPlan);
  const label = "[caller-invocation] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "caller", "runner",
    "authorizedPhaseRequestSha256", "privateTransport", "runnerReceipt",
    "runnerReceiptSha256", "startedAt", "completedAt",
    "callerBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "caller_phase_invocation_completed", `${label} status`);
  const runnerReceipt = validateJsonCompatibilityRunnerInvocationReceipt(
    validatedPlan,
    value.runnerReceipt,
  );
  const common = validateCallerCommon(
    validatedPlan,
    value,
    expectedCaller,
    "JSON_COMPATIBILITY_CALLER_ENABLED",
    "invokePhase",
    label,
  );
  bindCallerToRunner(value, runnerReceipt, common, label, "direct");
  validateCallerDigests(value, label);
  return value;
}

export function validateJsonCompatibilityCallerStatusReceipt(
  plan,
  input,
  expectedCaller,
) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  requireCurrentCallerPlan(validatedPlan);
  const label = "[caller-status] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "caller", "runner",
    "callerStatusRequestSha256", "privateTransport", "runnerStatusReceipt",
    "runnerStatusReceiptSha256", "recovery", "startedAt", "completedAt",
    "callerBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(
    value.contract,
    JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
    `${label} contract`,
  );
  equal(value.status, "caller_phase_status_observed", `${label} status`);
  equal(value.phaseStatus, "completed", `${label} completed status`);
  const runnerReceipt = validateJsonCompatibilityRunnerStatusReceipt(
    validatedPlan,
    value.runnerStatusReceipt,
  );
  equal(
    value.phaseStatus,
    runnerReceipt.phaseStatus,
    `${label} nested phase status`,
  );
  const common = validateCallerCommon(
    validatedPlan,
    value,
    expectedCaller,
    "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
    "getPhaseStatus",
    label,
  );
  const recovery = record(value.recovery, `${label} recovery`);
  exactKeys(recovery, [
    "mode", "executionRetryPermitted", "runnerInvokePhaseCalled",
    "originalCallerReceiptReconstructed",
  ], `${label} recovery`);
  equal(recovery.mode, "read-only-status-recovery", `${label} recovery mode`);
  equal(
    recovery.executionRetryPermitted,
    false,
    `${label} retry permission`,
  );
  equal(
    recovery.runnerInvokePhaseCalled,
    false,
    `${label} execution call`,
  );
  equal(
    recovery.originalCallerReceiptReconstructed,
    false,
    `${label} original receipt reconstruction`,
  );
  bindCallerToRunner(value, runnerReceipt, common, label, "status");
  validateCallerDigests(value, label);
  return value;
}

export function resolveJsonCompatibilityCallerCompletion(
  plan,
  input,
  expectedCaller,
) {
  const value = record(input, "[caller] receipt");
  if (value.contract === JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT) {
    const callerReceipt = validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      value,
      expectedCaller,
    );
    const runnerCompletion = resolveJsonCompatibilityRunnerCompletion(
      plan,
      callerReceipt.runnerReceipt,
    );
    const callerPlanBinding = expectedCallerIdentity(
      validateJsonCompatibilityCampaignPlan(plan),
      expectedCaller,
      "[caller-invocation] receipt",
    );
    return {
      mode: "direct",
      callerReceipt,
      callerPlanBinding,
      runnerCompletion,
      runnerReceipt: runnerCompletion.runnerReceipt,
      operatorReceipt: runnerCompletion.operatorReceipt,
      privateInvocationReceipt: runnerCompletion.privateInvocationReceipt,
    };
  }
  if (value.contract === JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT) {
    const callerReceipt = validateJsonCompatibilityCallerStatusReceipt(
      plan,
      value,
      expectedCaller,
    );
    const runnerCompletion = resolveJsonCompatibilityRunnerCompletion(
      plan,
      callerReceipt.runnerStatusReceipt,
    );
    const callerPlanBinding = expectedCallerIdentity(
      validateJsonCompatibilityCampaignPlan(plan),
      expectedCaller,
      "[caller-status] receipt",
    );
    return {
      mode: "recovered-status",
      callerReceipt,
      callerPlanBinding,
      runnerCompletion,
      runnerReceipt: runnerCompletion.runnerReceipt,
      operatorReceipt: runnerCompletion.operatorReceipt,
      privateInvocationReceipt: runnerCompletion.privateInvocationReceipt,
    };
  }
  failure("[caller] receipt contract is unsupported");
}

export function projectJsonCompatibilityCallerCompletion(resolved) {
  const receipt = resolved.callerReceipt;
  const direct = resolved.mode === "direct";
  return {
    contract: receipt.contract,
    mode: resolved.mode,
    receiptSha256: receipt.receiptSha256,
    callerBodySha256: receipt.callerBodySha256,
    runnerRawReceiptSha256: direct
      ? receipt.runnerReceiptSha256
      : receipt.runnerStatusReceiptSha256,
    runnerClaimedReceiptSha256: resolved.runnerReceipt.receiptSha256,
    requestPayloadSha256: direct
      ? receipt.authorizedPhaseRequestSha256
      : receipt.callerStatusRequestSha256,
    campaignIdSha256: receipt.campaignIdSha256,
    planDigestSha256: receipt.planDigestSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    phaseStatus: direct ? "completed" : receipt.phaseStatus,
    caller: clone(receipt.caller),
    callerPlanBinding: clone(resolved.callerPlanBinding),
    runner: clone(receipt.runner),
    privateTransport: clone(receipt.privateTransport),
    completion: {
      mode: resolved.mode,
      executionRetryPermitted: false,
      runnerInvokePhaseCalled: direct,
      runnerGetPhaseStatusCalled: !direct,
      originalCallerReceiptAvailable: direct,
    },
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

export function projectJsonCompatibilityResolvedRunner(resolved) {
  return projectJsonCompatibilityRunnerCompletion(resolved.runnerCompletion);
}

function validateCallerCommon(
  plan,
  value,
  expectedCaller,
  gateName,
  rpcMethod,
  label,
) {
  equal(value.environment, "staging", `${label} environment`);
  equal(value.campaignIdSha256, plan.campaignIdSha256, `${label} campaign ID`);
  equal(value.planDigestSha256, plan.planDigestSha256, `${label} plan digest`);
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4, `${label} phase ordinal`);
  const phase = plan.phases[phaseOrdinal - 1];
  equal(value.phaseId, phase.id, `${label} phase ID`);
  if (typeof value.phaseExecutionId !== "string" || value.phaseExecutionId.length === 0) {
    failure(`${label} phase execution ID is invalid`);
  }

  const expected = expectedCallerIdentity(plan, expectedCaller, label);
  const caller = record(value.caller, `${label} caller`);
  exactKeys(caller, [
    "serviceName", "entrypoint", "versionId", "gateName", "privateRpcOnly",
  ], `${label} caller`);
  for (const [name, expectedValue] of [
    ["serviceName", CALLER_SERVICE],
    ["entrypoint", CALLER_ENTRYPOINT],
    ["versionId", expected.versionId],
    ["gateName", gateName],
    ["privateRpcOnly", true],
  ]) equal(caller[name], expectedValue, `${label} caller ${name}`);

  const plannedRunner = record(plan.privateServices?.runner, `${label} planned runner`);
  const runner = record(value.runner, `${label} runner`);
  exactKeys(
    runner,
    ["serviceName", "entrypoint", "versionId", "configSha256"],
    `${label} runner`,
  );
  for (const [name, expectedValue] of [
    ["serviceName", RUNNER_SERVICE],
    ["entrypoint", RUNNER_ENTRYPOINT],
    ["versionId", plannedRunner.versionId],
    ["configSha256", plannedRunner.configSha256],
  ]) equal(runner[name], expectedValue, `${label} runner ${name}`);

  const transport = record(value.privateTransport, `${label} transport`);
  exactKeys(transport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "runnerBinding",
    "rpcMethod",
  ], `${label} transport`);
  for (const [name, expectedValue] of [
    ["kind", "service-binding-rpc"],
    ["publicUrlUsed", false],
    ["cloudflareRestUsed", false],
    ["runnerBinding", "JSON_COMPATIBILITY_RUNNER_SERVICE"],
    ["rpcMethod", rpcMethod],
  ]) equal(transport[name], expectedValue, `${label} transport ${name}`);
  const startedAt = wholeSecond(value.startedAt, `${label} start`);
  const completedAt = wholeSecond(value.completedAt, `${label} completion`);
  if (completedAt < startedAt) failure(`${label} completion precedes start`);
  return { startedAt, completedAt };
}

function bindCallerToRunner(value, runnerReceipt, common, label, mode) {
  const payloadDigestField = mode === "direct"
    ? "authorizedPhaseRequestSha256"
    : "callerStatusRequestSha256";
  const expectedPayload = mode === "direct"
    ? runnerReceipt.authorizedPhaseRequest
    : {
        schemaVersion: 1,
        contract: CALLER_STATUS_REQUEST_CONTRACT,
        authorizedPhaseRequest: runnerReceipt.authorizedPhaseRequest,
      };
  sha256(value[payloadDigestField], `${label} request payload digest`);
  equal(
    value[payloadDigestField],
    sha256Canonical(expectedPayload),
    `${label} request payload digest`,
  );
  const nestedField = mode === "direct"
    ? "runnerReceipt"
    : "runnerStatusReceipt";
  const digestField = mode === "direct"
    ? "runnerReceiptSha256"
    : "runnerStatusReceiptSha256";
  sha256(value[digestField], `${label} nested receipt digest`);
  equal(
    value[digestField],
    sha256Canonical(value[nestedField]),
    `${label} nested receipt digest`,
  );
  for (const name of [
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId",
  ]) equal(value[name], runnerReceipt[name], `${label} nested ${name}`);
  for (const name of [
    "serviceName", "entrypoint", "versionId", "configSha256",
  ]) {
    equal(value.runner[name], runnerReceipt.runner[name], `${label} nested runner ${name}`);
  }
  const runnerStart = wholeSecond(
    runnerReceipt.startedAt,
    `${label} nested start`,
  );
  const runnerCompleted = wholeSecond(
    runnerReceipt.completedAt,
    `${label} nested completion`,
  );
  if (
    common.startedAt > runnerStart + CLOCK_SKEW_MS
    || common.completedAt + CLOCK_SKEW_MS < runnerCompleted
  ) failure(`${label} must enclose the Runner RPC`);
}

function validateCallerDigests(value, label) {
  sha256(value.callerBodySha256, `${label} body digest`);
  sha256(value.receiptSha256, `${label} receipt digest`);
  const { callerBodySha256, receiptSha256, ...body } = value;
  equal(callerBodySha256, sha256Canonical(body), `${label} body digest`);
  equal(
    receiptSha256,
    sha256Canonical({ ...body, callerBodySha256 }),
    `${label} receipt digest`,
  );
}

function expectedCallerIdentity(plan, expectedCaller, label) {
  const planned = record(
    plan.privateServices?.caller,
    `${label} planned caller`,
  );
  equal(planned.serviceName, CALLER_SERVICE, `${label} planned caller service`);
  equal(planned.entrypoint, CALLER_ENTRYPOINT, `${label} planned caller entrypoint`);
  safeToken(planned.versionId, `${label} planned caller version ID`);
  sha256(planned.configSha256, `${label} planned caller config digest`);
  if (expectedCaller !== undefined && expectedCaller !== null) {
    const expected = record(expectedCaller, `${label} expected caller`);
    exactKeys(
      expected,
      ["versionId", "configSha256"],
      `${label} expected caller`,
    );
    safeToken(expected.versionId, `${label} expected caller version ID`);
    sha256(expected.configSha256, `${label} expected caller config digest`);
    equal(
      expected.versionId,
      planned.versionId,
      `${label} expected caller version ID`,
    );
    equal(
      expected.configSha256,
      planned.configSha256,
      `${label} expected caller config digest`,
    );
  }
  return {
    versionId: planned.versionId,
    configSha256: planned.configSha256,
  };
}

function requireCurrentCallerPlan(plan) {
  if (
    plan.schemaVersion !== 4
    || plan.contract !== JSON_COMPATIBILITY_PLAN_CONTRACT
  ) {
    failure("[caller] completion requires the current Plan v5 contract");
  }
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

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    failure(`${label} must be a safe token`);
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
