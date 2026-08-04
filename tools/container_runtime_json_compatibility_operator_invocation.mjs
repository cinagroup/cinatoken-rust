import { createHash } from "node:crypto";

import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  sha256Canonical,
  validateJsonCompatibilityCampaignPlan,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityPrivateInvocationReceipt,
} from "./container_runtime_json_compatibility_private_invocation.mjs";

export const JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-phase-request-v1";
export const JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-operator-invocation-receipt-v1";

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

export function deriveJsonCompatibilityOperatorCommandIdSha256(
  request,
  operatorVersionId,
) {
  safeToken(operatorVersionId, "[operator-invocation] operator version");
  return createHash("sha256")
    .update(`${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${operatorVersionId}`, "utf8")
    .digest("hex");
}

export function validateJsonCompatibilityOperatorInvocationReceipt(plan, input) {
  const validatedPlan = validateJsonCompatibilityCampaignPlan(plan);
  const label = "[operator-invocation] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "request", "requestSha256",
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

  const startedAt = wholeSecond(value.startedAt, `${label} start`);
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
    operatorBodySha256: receipt.operatorBodySha256,
    privateInvocationReceiptSha256:
      receipt.privateInvocationReceiptSha256,
    requestSha256: receipt.requestSha256,
    commandIdSha256: receipt.commandIdSha256,
    phaseExecutionId: receipt.phaseExecutionId,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    operator: structuredClone(receipt.operator),
    privateTransport: structuredClone(receipt.privateTransport),
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

function validateOperator(input, plan, label) {
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
    "JSON_COMPATIBILITY_OPERATOR_ENABLED",
    `${label} operator gate`,
  );
  const planned = record(
    plan.privateServices?.operator,
    `${label} planned operator`,
  );
  equal(planned.serviceName, OPERATOR_SERVICE, `${label} planned operator service`);
  equal(planned.entrypoint, OPERATOR_ENTRYPOINT, `${label} planned operator entrypoint`);
  equal(value.versionId, planned.versionId, `${label} operator version`);
  equal(value.gateName, planned.gateName, `${label} operator gate`);
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

function failure(message) {
  throw new JsonCompatibilityCampaignError(message);
}
