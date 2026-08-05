import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
  JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
  JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
  parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
} from "../../container-runtime-json-compatibility-operator/src/protocol";
import {
  JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_RECEIPT_CONTRACT,
  deriveJsonCompatibilityOperatorCommandId,
  validateJsonCompatibilityPrivateInvocationReceiptForRunner,
  validateJsonCompatibilityPrivateInvocationStatusReceiptForRunner,
} from "../../container-runtime-json-compatibility-operator/src/operator";
import {
  operatorStatusRequest,
  parseJsonCompatibilityRunnerPhaseStatusRequestV1,
} from "./protocol";

export const JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-runner-invocation-receipt-v1" as const;
export const JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-runner-status-receipt-v1" as const;

const MAX_RUNNER_REQUEST_BYTES = 512 * 1024;
const MAX_OPERATOR_RECEIPT_BYTES = 1856 * 1024;
const MAX_RUNNER_RECEIPT_BYTES = 1984 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityOperatorServiceBinding {
  invokePhase(input: unknown): Promise<unknown>;
  getPhaseStatus(input: unknown): Promise<unknown>;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type JsonCompatibilityRunnerEnv = Omit<
  WidenGeneratedStringBindings<JsonCompatibilityRunnerGeneratedEnv>,
  "CF_VERSION_METADATA" | "JSON_COMPATIBILITY_OPERATOR_SERVICE"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_OPERATOR_SERVICE:
    JsonCompatibilityOperatorServiceBinding;
};

export interface JsonCompatibilityRunnerRuntime {
  now(): number;
}

export interface JsonCompatibilityRunnerInvocationReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT;
  readonly status: "runner_phase_invocation_completed";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly runner: RunnerIdentity;
  readonly operator: OperatorTarget;
  readonly authorizedPhaseRequest: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  readonly authorizedPhaseRequestSha256: string;
  readonly privateTransport: RunnerTransport;
  readonly operatorReceipt: Readonly<Record<string, unknown>>;
  readonly operatorReceiptSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly runnerBodySha256: string;
  readonly receiptSha256: string;
}

export interface JsonCompatibilityRunnerStatusReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT;
  readonly status: "runner_phase_status_observed";
  readonly phaseStatus: string;
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly runner: RunnerIdentity;
  readonly operator: OperatorTarget;
  readonly authorizedPhaseRequest: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  readonly authorizedPhaseRequestSha256: string;
  readonly privateTransport: RunnerTransport & { readonly rpcMethod: "getPhaseStatus" };
  readonly operatorStatusReceipt: Readonly<Record<string, unknown>>;
  readonly operatorStatusReceiptSha256: string;
  readonly recovery: {
    readonly mode: "read-only-status-recovery";
    readonly executionRetryPermitted: false;
    readonly operatorInvokePhaseCalled: false;
    readonly originalRunnerReceiptReconstructed: false;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly runnerBodySha256: string;
  readonly receiptSha256: string;
}

interface RunnerIdentity {
  readonly serviceName: typeof JSON_COMPATIBILITY_RUNNER_SERVICE_NAME;
  readonly entrypoint: typeof JSON_COMPATIBILITY_RUNNER_ENTRYPOINT;
  readonly versionId: string;
  readonly configSha256: string;
  readonly gateName:
    | "JSON_COMPATIBILITY_RUNNER_ENABLED"
    | "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED";
  readonly privateRpcOnly: true;
}

interface OperatorTarget {
  readonly serviceName: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
  readonly entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint";
  readonly versionId: string;
}

interface RunnerTransport {
  readonly kind: "service-binding-rpc";
  readonly publicUrlUsed: false;
  readonly cloudflareRestUsed: false;
  readonly operatorBinding: "JSON_COMPATIBILITY_OPERATOR_SERVICE";
  readonly rpcMethod: "invokePhase" | "getPhaseStatus";
}

interface RunnerConfiguration {
  readonly versionId: string;
  readonly operatorVersionId: string;
}

interface ValidatedOperatorReceipt {
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly phaseStatus?: string;
}

export class JsonCompatibilityRunnerError extends Error {
  constructor(
    readonly code:
      | "runner_disabled"
      | "runner_status_disabled"
      | "runner_configuration_error"
      | "invalid_runner_request"
      | "runner_caller_binding_mismatch"
      | "operator_unavailable"
      | "invalid_operator_receipt"
      | "runner_receipt_too_large",
  ) {
    super(code);
    this.name = "JsonCompatibilityRunnerError";
  }
}

export async function invokeJsonCompatibilityRunnerPhase(
  env: JsonCompatibilityRunnerEnv,
  input: unknown,
  runtime: JsonCompatibilityRunnerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityRunnerInvocationReceiptV1> {
  const configuration = requireRunnerEnvironment(env, "invoke");
  const startedAtMs = runtimeNow(runtime);
  assertBoundedJson(input, MAX_RUNNER_REQUEST_BYTES, "invalid_runner_request");
  let authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  try {
    authorized = parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(input);
  } catch {
    throw runnerError("invalid_runner_request");
  }
  const requestBinding = await validateRunnerRequest(
    authorized,
    configuration,
  );
  let rawOperatorReceipt: unknown;
  try {
    rawOperatorReceipt = await env.JSON_COMPATIBILITY_OPERATOR_SERVICE
      .invokePhase(authorized);
  } catch {
    throw runnerError("operator_unavailable");
  }
  const completedAtMs = runtimeNow(runtime);
  if (completedAtMs < startedAtMs) {
    throw runnerError("runner_configuration_error");
  }
  const operatorReceipt = normalizeRpcJson(
    rawOperatorReceipt,
    "invalid_operator_receipt",
  );
  const validated = await validateOperatorInvocationReceipt(
    operatorReceipt,
    authorized,
    requestBinding,
    configuration.operatorVersionId,
    completedAtMs,
  );
  const common = await runnerReceiptBody(
    authorized,
    configuration,
    "JSON_COMPATIBILITY_RUNNER_ENABLED",
    "invokePhase",
    startedAtMs,
    completedAtMs,
  );
  const receiptBody = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
    status: "runner_phase_invocation_completed" as const,
    ...common,
    operatorReceipt: validated.receipt,
    operatorReceiptSha256: await sha256Hex(canonicalJson(validated.receipt)),
  };
  const runnerBodySha256 = await sha256Hex(canonicalJson(receiptBody));
  const receiptSubject = { ...receiptBody, runnerBodySha256 };
  const receipt = {
    ...receiptSubject,
    receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
  };
  assertBoundedJson(receipt, MAX_RUNNER_RECEIPT_BYTES, "runner_receipt_too_large");
  return receipt;
}

export async function getJsonCompatibilityRunnerPhaseStatus(
  env: JsonCompatibilityRunnerEnv,
  input: unknown,
  runtime: JsonCompatibilityRunnerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityRunnerStatusReceiptV1> {
  const configuration = requireRunnerEnvironment(env, "status");
  const startedAtMs = runtimeNow(runtime);
  assertBoundedJson(input, MAX_RUNNER_REQUEST_BYTES, "invalid_runner_request");
  let authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  try {
    authorized = parseJsonCompatibilityRunnerPhaseStatusRequestV1(input)
      .authorizedPhaseRequest;
  } catch {
    throw runnerError("invalid_runner_request");
  }
  const requestBinding = await validateRunnerRequest(
    authorized,
    configuration,
  );
  let rawOperatorReceipt: unknown;
  try {
    rawOperatorReceipt = await env.JSON_COMPATIBILITY_OPERATOR_SERVICE
      .getPhaseStatus(operatorStatusRequest(authorized));
  } catch {
    throw runnerError("operator_unavailable");
  }
  const completedAtMs = runtimeNow(runtime);
  if (completedAtMs < startedAtMs) {
    throw runnerError("runner_configuration_error");
  }
  const operatorReceipt = normalizeRpcJson(
    rawOperatorReceipt,
    "invalid_operator_receipt",
  );
  const validated = await validateOperatorStatusReceipt(
    operatorReceipt,
    authorized,
    requestBinding,
    configuration.operatorVersionId,
    completedAtMs,
  );
  const common = await runnerReceiptBody(
    authorized,
    configuration,
    "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
    "getPhaseStatus",
    startedAtMs,
    completedAtMs,
  );
  const receiptBody = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
    status: "runner_phase_status_observed" as const,
    phaseStatus: token(validated.phaseStatus, "invalid_operator_receipt"),
    ...common,
    operatorStatusReceipt: validated.receipt,
    operatorStatusReceiptSha256:
      await sha256Hex(canonicalJson(validated.receipt)),
    recovery: {
      mode: "read-only-status-recovery" as const,
      executionRetryPermitted: false as const,
      operatorInvokePhaseCalled: false as const,
      originalRunnerReceiptReconstructed: false as const,
    },
  };
  const runnerBodySha256 = await sha256Hex(canonicalJson(receiptBody));
  const receiptSubject = { ...receiptBody, runnerBodySha256 };
  const receipt = {
    ...receiptSubject,
    receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
  };
  assertBoundedJson(receipt, MAX_RUNNER_RECEIPT_BYTES, "runner_receipt_too_large");
  return receipt;
}

async function validateRunnerRequest(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  configuration: RunnerConfiguration,
): Promise<{ readonly requestSha256: string; readonly commandIdSha256: string }> {
  const request = authorized.request;
  const subject = authorized.approval.subject;
  const requestSha256 = await sha256Hex(canonicalJson(request));
  const commandIdSha256 = await deriveJsonCompatibilityOperatorCommandId(
    request,
    configuration.operatorVersionId,
  );
  if (
    subject.operator.versionId !== configuration.operatorVersionId
    || subject.caller.serviceName !== JSON_COMPATIBILITY_RUNNER_SERVICE_NAME
    || subject.caller.entrypoint !== JSON_COMPATIBILITY_RUNNER_ENTRYPOINT
    || subject.caller.versionId !== configuration.versionId
    || subject.caller.gateName !== "JSON_COMPATIBILITY_RUNNER_ENABLED"
    || subject.caller.privateRpcOnly !== true
    || subject.requestSha256 !== requestSha256
    || subject.commandIdSha256 !== commandIdSha256
    || subject.campaignIdSha256 !== request.execution.campaignIdSha256
    || subject.planDigestSha256 !== request.execution.planDigestSha256
    || subject.phaseExecutionId !== request.execution.phaseExecutionId
    || subject.phaseOrdinal !== request.execution.phase.ordinal
    || subject.phaseId !== request.execution.phase.id
    || subject.topologyReadbackSha256 !== request.topologyReadbackSha256
    || subject.beforeContextSha256 !== request.beforeContextSha256
  ) {
    throw runnerError("runner_caller_binding_mismatch");
  }
  return { requestSha256, commandIdSha256 };
}

async function validateOperatorInvocationReceipt(
  input: unknown,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: { readonly requestSha256: string; readonly commandIdSha256: string },
  operatorVersionId: string,
  completedAtMs: number,
): Promise<ValidatedOperatorReceipt> {
  assertBoundedJson(
    input,
    MAX_OPERATOR_RECEIPT_BYTES,
    "invalid_operator_receipt",
  );
  const value = exactRecord(input, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "authorization", "request",
    "requestSha256", "commandIdSha256", "privateTransport",
    "privateInvocationReceipt", "privateInvocationReceiptSha256",
    "startedAt", "completedAt", "operatorBodySha256", "receiptSha256",
  ], "invalid_operator_receipt");
  await validateOperatorReceiptEnvelope(
    value,
    authorized,
    binding,
    operatorVersionId,
    JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
    "operator_phase_invocation_completed",
    "JSON_COMPATIBILITY_OPERATOR_ENABLED",
    completedAtMs,
  );
  const privateReceipt = record(
    value.privateInvocationReceipt,
    "invalid_operator_receipt",
  );
  if (
    digest(value.privateInvocationReceiptSha256, "invalid_operator_receipt")
      !== await sha256Hex(canonicalJson(privateReceipt))
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  await validateClaimedReceiptDigest(privateReceipt);
  try {
    await validateJsonCompatibilityPrivateInvocationReceiptForRunner(
      privateReceipt,
      authorized.request,
      binding.commandIdSha256,
      authorized.request.invoker.versionId,
    );
  } catch {
    throw runnerError("invalid_operator_receipt");
  }
  return { receipt: value };
}

async function validateOperatorStatusReceipt(
  input: unknown,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: { readonly requestSha256: string; readonly commandIdSha256: string },
  operatorVersionId: string,
  completedAtMs: number,
): Promise<ValidatedOperatorReceipt> {
  assertBoundedJson(
    input,
    MAX_OPERATOR_RECEIPT_BYTES,
    "invalid_operator_receipt",
  );
  const value = exactRecord(input, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "authorization", "request",
    "requestSha256", "commandIdSha256", "statusQuery", "statusQuerySha256",
    "privateTransport", "privateInvocationStatusReceipt",
    "privateInvocationStatusReceiptSha256", "recovery", "queryStartedAt",
    "queryCompletedAt", "operatorBodySha256", "receiptSha256",
  ], "invalid_operator_receipt");
  await validateOperatorReceiptEnvelope(
    value,
    authorized,
    binding,
    operatorVersionId,
    JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_RECEIPT_CONTRACT,
    "operator_phase_status_observed",
    "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
    completedAtMs,
    "queryStartedAt",
    "queryCompletedAt",
  );
  const phaseStatus = token(value.phaseStatus, "invalid_operator_receipt");
  if (!new Set([
    "not_found", "active", "failed", "completed",
    "completed_receipt_unavailable",
  ]).has(phaseStatus)) {
    throw runnerError("invalid_operator_receipt");
  }
  const statusQuery = record(value.statusQuery, "invalid_operator_receipt");
  const target = record(statusQuery.subject, "invalid_operator_receipt");
  const targetValue = record(target.target, "invalid_operator_receipt");
  const approvalEnvelopeSha256 = await sha256Hex(
    canonicalJson(authorized.approval),
  );
  if (
    digest(value.statusQuerySha256, "invalid_operator_receipt")
      !== await sha256Hex(canonicalJson(statusQuery))
    || targetValue.operatorRequestSha256 !== binding.requestSha256
    || targetValue.approvalEnvelopeSha256 !== approvalEnvelopeSha256
    || targetValue.operatorVersionId !== operatorVersionId
    || targetValue.commandIdSha256 !== binding.commandIdSha256
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  const privateStatus = record(
    value.privateInvocationStatusReceipt,
    "invalid_operator_receipt",
  );
  if (
    digest(value.privateInvocationStatusReceiptSha256, "invalid_operator_receipt")
      !== await sha256Hex(canonicalJson(privateStatus))
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  await validateClaimedReceiptDigest(privateStatus);
  let validatedPrivateStatus;
  try {
    validatedPrivateStatus =
      await validateJsonCompatibilityPrivateInvocationStatusReceiptForRunner(
        privateStatus,
        authorized.request,
        statusQuery,
        binding.commandIdSha256,
        authorized.request.invoker.versionId,
        completedAtMs,
      );
  } catch {
    throw runnerError("invalid_operator_receipt");
  }
  if (validatedPrivateStatus.phaseStatus !== phaseStatus) {
    throw runnerError("invalid_operator_receipt");
  }
  const recovery = exactRecord(value.recovery, [
    "mode", "executionRetryPermitted", "invokePhaseCalled",
    "permitIssuerCalled", "executorCalled", "originalOperatorReceiptReconstructed",
  ], "invalid_operator_receipt");
  if (
    recovery.mode !== "read-only-status-recovery"
    || recovery.executionRetryPermitted !== false
    || recovery.invokePhaseCalled !== false
    || recovery.permitIssuerCalled !== false
    || recovery.executorCalled !== false
    || recovery.originalOperatorReceiptReconstructed !== false
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  return { receipt: value, phaseStatus };
}

async function validateOperatorReceiptEnvelope(
  value: Record<string, unknown>,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: { readonly requestSha256: string; readonly commandIdSha256: string },
  operatorVersionId: string,
  expectedContract: string,
  expectedStatus: string,
  expectedGate: string,
  completedAtMs: number,
  startedAtField = "startedAt",
  completedAtField = "completedAt",
): Promise<void> {
  const request = authorized.request;
  const operator = exactRecord(value.operator, [
    "serviceName", "versionId", "gateName",
  ], "invalid_operator_receipt");
  const authorization = record(value.authorization, "invalid_operator_receipt");
  const startedAt = timestamp(value[startedAtField]);
  const completedAt = timestamp(value[completedAtField]);
  if (
    value.schemaVersion !== 1
    || value.contract !== expectedContract
    || value.status !== expectedStatus
    || value.environment !== "staging"
    || value.campaignIdSha256 !== request.execution.campaignIdSha256
    || value.planDigestSha256 !== request.execution.planDigestSha256
    || value.phaseExecutionId !== request.execution.phaseExecutionId
    || value.phaseOrdinal !== request.execution.phase.ordinal
    || value.phaseId !== request.execution.phase.id
    || operator.serviceName !== JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME
    || operator.versionId !== operatorVersionId
    || operator.gateName !== expectedGate
    || canonicalJson(value.request) !== canonicalJson(request)
    || value.requestSha256 !== binding.requestSha256
    || value.commandIdSha256 !== binding.commandIdSha256
    || canonicalJson(authorization.approvalEnvelope)
      !== canonicalJson(authorized.approval)
    || Date.parse(completedAt) < Date.parse(startedAt)
    || Date.parse(completedAt) > completedAtMs + 5_000
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  const { operatorBodySha256, receiptSha256, ...body } = value;
  if (
    digest(operatorBodySha256, "invalid_operator_receipt")
      !== await sha256Hex(canonicalJson(body))
    || digest(receiptSha256, "invalid_operator_receipt")
      !== await sha256Hex(canonicalJson({ ...body, operatorBodySha256 }))
  ) {
    throw runnerError("invalid_operator_receipt");
  }
}

async function runnerReceiptBody<
  const Method extends RunnerTransport["rpcMethod"],
>(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  configuration: RunnerConfiguration,
  gateName: RunnerIdentity["gateName"],
  rpcMethod: Method,
  startedAtMs: number,
  completedAtMs: number,
) {
  const request = authorized.request;
  return {
    environment: "staging" as const,
    campaignIdSha256: request.execution.campaignIdSha256,
    planDigestSha256: request.execution.planDigestSha256,
    phaseExecutionId: request.execution.phaseExecutionId,
    phaseOrdinal: request.execution.phase.ordinal,
    phaseId: request.execution.phase.id,
    runner: {
      serviceName: JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
      entrypoint: JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
      versionId: configuration.versionId,
      configSha256: authorized.approval.subject.caller.configSha256,
      gateName,
      privateRpcOnly: true as const,
    },
    operator: {
      serviceName: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
      entrypoint: "JsonCompatibilityCampaignOperatorEntrypoint" as const,
      versionId: configuration.operatorVersionId,
    },
    authorizedPhaseRequest: authorized,
    authorizedPhaseRequestSha256: await sha256Hex(canonicalJson(authorized)),
    privateTransport: {
      kind: "service-binding-rpc" as const,
      publicUrlUsed: false as const,
      cloudflareRestUsed: false as const,
      operatorBinding: "JSON_COMPATIBILITY_OPERATOR_SERVICE" as const,
      rpcMethod,
    },
    startedAt: wholeSecondUtc(startedAtMs),
    completedAt: wholeSecondUtc(completedAtMs),
  };
}

function requireRunnerEnvironment(
  env: JsonCompatibilityRunnerEnv,
  purpose: "invoke" | "status",
): RunnerConfiguration {
  if (env.ENVIRONMENT !== "staging") {
    throw runnerError("runner_configuration_error");
  }
  if (
    purpose === "invoke"
      ? env.JSON_COMPATIBILITY_RUNNER_ENABLED !== "true"
      : env.JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED !== "true"
  ) {
    throw runnerError(purpose === "invoke" ? "runner_disabled" : "runner_status_disabled");
  }
  const versionId = token(
    env.CF_VERSION_METADATA?.id,
    "runner_configuration_error",
  );
  const operatorVersionId = token(
    env.JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID,
    "runner_configuration_error",
  );
  const method = purpose === "invoke" ? "invokePhase" : "getPhaseStatus";
  if (
    env.JSON_COMPATIBILITY_OPERATOR_SERVICE === null
    || typeof env.JSON_COMPATIBILITY_OPERATOR_SERVICE !== "object"
    || typeof env.JSON_COMPATIBILITY_OPERATOR_SERVICE[method] !== "function"
  ) {
    throw runnerError("runner_configuration_error");
  }
  return { versionId, operatorVersionId };
}

async function validateClaimedReceiptDigest(
  value: Record<string, unknown>,
): Promise<void> {
  const claimed = digest(value.receiptSha256, "invalid_operator_receipt");
  const { receiptSha256: _receiptSha256, ...subject } = value;
  if (claimed !== await sha256Hex(canonicalJson(subject))) {
    throw runnerError("invalid_operator_receipt");
  }
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  code: JsonCompatibilityRunnerError["code"],
): Record<string, unknown> {
  const value = record(input, code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw runnerError(code);
  }
  return value;
}

function record(
  input: unknown,
  code: JsonCompatibilityRunnerError["code"],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw runnerError(code);
  }
  return input as Record<string, unknown>;
}

function token(
  value: unknown,
  code: JsonCompatibilityRunnerError["code"],
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw runnerError(code);
  }
  return value;
}

function digest(
  value: unknown,
  code: JsonCompatibilityRunnerError["code"],
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw runnerError(code);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw runnerError("invalid_operator_receipt");
  }
  return value;
}

function runtimeNow(runtime: JsonCompatibilityRunnerRuntime): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runnerError("runner_configuration_error");
  }
  return value;
}

function wholeSecondUtc(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function assertBoundedJson(
  input: unknown,
  maximumBytes: number,
  code: JsonCompatibilityRunnerError["code"],
): void {
  const encoder = new TextEncoder();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [
    { value: input, depth: 0 },
  ];
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  const add = (count: number): void => {
    bytes += count;
    if (bytes > maximumBytes) throw runnerError(code);
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) throw runnerError(code);
    if (current.exit) {
      if (typeof current.value === "object" && current.value !== null) {
        ancestors.delete(current.value);
      }
      continue;
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw runnerError(code);
    }
    const value = current.value;
    if (value === null) add(4);
    else if (typeof value === "string") add(encoder.encode(JSON.stringify(value)).byteLength);
    else if (typeof value === "boolean") add(value ? 4 : 5);
    else if (typeof value === "number" && Number.isFinite(value)) add(String(value).length);
    else if (typeof value === "object") {
      if (ancestors.has(value)) throw runnerError(code);
      ancestors.add(value);
      stack.push({ value, depth: current.depth, exit: true });
      const entries = Array.isArray(value)
        ? value.map((child) => [null, child] as const)
        : Object.entries(value as Record<string, unknown>);
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        if (key !== null) {
          add(encoder.encode(JSON.stringify(key)).byteLength + 1);
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else throw runnerError(code);
  }
}

function normalizeRpcJson(
  input: unknown,
  code: JsonCompatibilityRunnerError["code"],
): unknown {
  const ancestors = new WeakSet<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) throw runnerError(code);
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) return value;
    if (typeof value !== "object" || ancestors.has(value)) {
      throw runnerError(code);
    }
    ancestors.add(value);
    let output: unknown;
    if (Array.isArray(value)) {
      output = value.map((child) => copy(child, depth + 1));
    } else {
      const recordOutput: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw runnerError(code);
        Object.defineProperty(recordOutput, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      output = recordOutput;
    }
    ancestors.delete(value);
    return output;
  };
  return copy(input, 0);
}

function runnerError(
  code: JsonCompatibilityRunnerError["code"],
): JsonCompatibilityRunnerError {
  return new JsonCompatibilityRunnerError(code);
}
